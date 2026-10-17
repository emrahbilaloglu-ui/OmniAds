import { withPinnedDbClient } from "@/lib/db";
import { evaluateDbGrowthFence } from "@/lib/sync/db-growth-fence";
import { BUSINESS_ERASURE_LOCK_NAMESPACE } from "@/lib/business-deletion";
import { assertRawPayloadStorageReady, rawPayloadMetadataSql, RAW_PAYLOAD_STORAGE_TABLES, type RawPayloadStorageTable } from "./raw-payload-storage";
import type { PoolClient } from "pg";

export const RAW_PAYLOAD_PAGE_ROWS = 128;
export const RAW_PAYLOAD_MAX_STORED_BYTES = 256 * 1024;
const OWNER = { meta_raw_snapshots: "adsecute_meta_raw_payload", shopify_raw_snapshots: "adsecute_shopify_raw_payload" } as const;
function need(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

async function requireIndexedPlan(db: Pick<PoolClient,"query">, sql:string, args:unknown[], required:string) {
  const {rows}=await db.query("EXPLAIN(FORMAT JSON) "+sql,args);
  const indexes=new Set<string>();
  const conditions=new Map<string,string>();
  const visit=(node:Record<string,unknown>)=>{
    need(!["Seq Scan","Parallel Seq Scan"].includes(String(node["Node Type"])),"raw_payload_unbounded_plan");
    if(node["Index Name"]){const name=String(node["Index Name"]);indexes.add(name);conditions.set(name,String(node["Index Cond"]??""));}
    for(const child of (node.Plans??[]) as Record<string,unknown>[])visit(child);
  };
  visit(rows[0]["QUERY PLAN"][0].Plan);
  need(indexes.has(required),"raw_payload_required_index_absent");
  const condition=conditions.get(required)??"";
  need(condition.includes("fetched_at")&&condition.includes("<"),"raw_payload_index_time_bound_absent");
  if(required.endsWith("_owner"))need(["business_id","provider_account_id","payload_hash"].every(key=>condition.includes(key)),"raw_payload_index_scope_bound_absent");
}

/** Closed source SQL. Used by the actual caller and by owned PostgreSQL QA. */
export async function internRawPayloadPage(db: Pick<PoolClient, "query">, table: RawPayloadStorageTable) {
  need(RAW_PAYLOAD_STORAGE_TABLES.includes(table), "raw_payload_table_invalid");
  const pageSql = `SELECT s.id::text,s.fetched_at::text,business_id,provider_account_id,payload_hash,pg_column_size(payload_json)::int AS stored_bytes
    FROM public.${table} s WHERE payload_storage_state=0
      AND s.fetched_at<transaction_timestamp()-interval '92 days'
      AND (end_date IS NULL OR end_date<current_date-92)
      AND updated_at<transaction_timestamp()-interval '2 minutes'
      AND COALESCE(last_observed_at,fetched_at)<transaction_timestamp()-interval '2 minutes'
    ORDER BY s.fetched_at,s.id LIMIT ${RAW_PAYLOAD_PAGE_ROWS} FOR UPDATE SKIP LOCKED`;
  await requireIndexedPlan(db,pageSql,[],`idx_${table}_payload_queue`);
  const { rows: page } = await db.query<{ id: string; stored_bytes: number; fetched_at:string; business_id: string; provider_account_id: string; payload_hash: string }>(pageSql);
  let interned = 0, originalPayloadBytes = 0, checked = 0;
  const startedAt=Date.now();
  for (const row of page) {
    if(Date.now()-startedAt>3000)break;
    checked++;
    const {rows:[metadataBefore]}=await db.query<{metadata:string}>(`SELECT encode(digest(${rawPayloadMetadataSql(table,"s")}::text,'sha256'),'hex') metadata FROM public.${table} s WHERE id=$1::uuid`,[row.id]);
    need(metadataBefore,"raw_payload_prestate_missing");
    const markInline=async()=>{
      const {rows:[after]}=await db.query<{metadata:string}>(`UPDATE public.${table} s SET payload_storage_state=1 WHERE id=$1::uuid AND payload_storage_state=0 RETURNING encode(digest(${rawPayloadMetadataSql(table,"s")}::text,'sha256'),'hex') metadata`,[row.id]);
      need(after?.metadata===metadataBefore.metadata,"raw_payload_original_metadata_changed");
    };
    if (row.stored_bytes < 1024 || row.stored_bytes > RAW_PAYLOAD_MAX_STORED_BYTES) {
      await markInline();
      continue;
    }
    // Never redirect an inline original already owned by another observation.
    const { rows: pins } = await db.query(`SELECT 1 FROM public.${table} WHERE payload_ref_id=$1::uuid LIMIT 1`, [row.id]);
    if (pins.length) {
      await markInline();
      continue;
    }
    // Exact JSONB equality, not SHA1/payload_hash alone. A strictly decreasing (fetched_at,id)
    // and an inline target forbid a reference chain or cycle. The global
    // erasure lock serializes this caller; key-share also protects the target
    // against ordinary retention while the deferred self FK is being inserted.
    const ownerSql=`SELECT r.id::text
      FROM public.${table} r WHERE r.business_id=$1 AND r.provider_account_id=$2
        AND r.payload_hash=$3 AND (r.fetched_at,r.id)<($5::timestamptz,$4::uuid) AND r.payload_ref_id IS NULL
        ${table === "meta_raw_snapshots" ? "AND r.partition_id IS NULL" : ""}
        AND r.payload_json=(SELECT s.payload_json FROM public.${table} s WHERE s.id=$4::uuid)
        AND r.payload_json::text=(SELECT s.payload_json::text FROM public.${table} s WHERE s.id=$4::uuid)
      ORDER BY r.fetched_at,r.id LIMIT 1 FOR KEY SHARE OF r`;
    const ownerArgs=[row.business_id,row.provider_account_id,row.payload_hash,row.id,row.fetched_at];
    await requireIndexedPlan(db,ownerSql,ownerArgs,`idx_${table}_payload_owner`);
    const { rows: originals } = await db.query<{ id: string }>(ownerSql,ownerArgs);
    if (!originals.length) {
      await markInline();
      continue;
    }
    const { rows: [proof] } = await db.query<{ metadata: string; payload: string }>(`SELECT
      encode(digest(${rawPayloadMetadataSql(table,"s")}::text,'sha256'),'hex') metadata,
      encode(digest(s.payload_json::text,'sha256'),'hex') payload
      FROM public.${table} s WHERE s.id=$1::uuid`, [row.id]);
    need(proof, "raw_payload_prestate_missing");
    const changed = await db.query(`UPDATE public.${table} s SET payload_json='null'::jsonb,
        payload_ref_id=r.id,payload_ref_sha256=$3,payload_storage_state=2
      FROM public.${table} r WHERE s.id=$1::uuid AND r.id=$2::uuid
        AND s.payload_storage_state=0 AND s.payload_ref_id IS NULL AND r.payload_ref_id IS NULL
        AND s.business_id=r.business_id AND s.provider_account_id=r.provider_account_id
        AND s.payload_hash=r.payload_hash AND s.payload_json=r.payload_json
        AND NOT EXISTS(SELECT 1 FROM public.${table} child WHERE child.payload_ref_id=s.id)`,
    [row.id, originals[0]!.id, proof.payload]);
    need(changed.rowCount === 1, "raw_payload_exact_update_required");
    const { rows: [after] } = await db.query<{ metadata: string; payload: string }>(`SELECT
      encode(digest(${rawPayloadMetadataSql(table,"s")}::text,'sha256'),'hex') metadata,
      encode(digest(public.${OWNER[table]}(s)::text,'sha256'),'hex') payload
      FROM public.${table} s WHERE s.id=$1::uuid`, [row.id]);
    need(after?.metadata === proof.metadata && after.payload === proof.payload, "raw_payload_original_or_metadata_changed");
    interned++; originalPayloadBytes += row.stored_bytes;
  }
  return { table, selected:page.length, checked, interned, originalPayloadBytes, retainedByteParity: true as const };
}

/** Physical interning is independent from the filesystem archive's membership
 * proof. It never creates a session/provider job, archive copy, or new authority. */
export async function runRawPayloadCompactionTick() {
  if (process.env.RAW_PAYLOAD_INTERNING_ENABLED !== "true") return { outcome: "disabled" };
  need(process.env.BUSINESS_ARCHIVE_ERASURE_ROLE === "1", "raw_payload_dedicated_role_required");
  const capacity = await evaluateDbGrowthFence();
  need(capacity.physical?.admitted === true && !capacity.overridden &&
    (capacity.allowed || ["database_budget_exceeded", "table_budget_exceeded"].includes(capacity.reason)), "raw_payload_physical_admission_required");
  need((capacity.physical.availableBytes ?? 0) - (capacity.physical.minimumFreeBytes ?? Infinity) >= 512 * 1024 ** 2,
    "raw_payload_scratch_reserve_required");
  return withPinnedDbClient(async db => {
    await db.query("BEGIN;SET LOCAL statement_timeout='3000ms';SET LOCAL lock_timeout='1000ms';SET LOCAL jit=off;SET LOCAL enable_seqscan=off");
    try {
      const { rows: [lock] } = await db.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1::int,0) acquired", [BUSINESS_ERASURE_LOCK_NAMESPACE]);
      if (!lock?.acquired) { await db.query("ROLLBACK"); return { outcome: "busy" }; }
      if ((await db.query("SELECT 1 FROM business_deletion_jobs WHERE hidden_at IS NOT NULL LIMIT 1")).rows.length) {
        await db.query("ROLLBACK"); return { outcome: "erasure_priority" };
      }
      await assertRawPayloadStorageReady(db);
      const pages = [];
      for (const table of RAW_PAYLOAD_STORAGE_TABLES) pages.push(await internRawPayloadPage(db, table));
      await db.query("COMMIT");
      return { outcome: pages.some(p => p.interned) ? "interned" : pages.some(p => p.checked) ? "checked" : "empty", observedAt: new Date().toISOString(), pages,
        physicalBytesReclaimed: 0, logicalSavedPayloadBytesOnly: true };
    } catch (error) { await db.query("ROLLBACK"); throw error; }
  }, { timeoutMs: 20_000 });
}
