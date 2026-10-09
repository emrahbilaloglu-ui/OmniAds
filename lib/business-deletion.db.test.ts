import { hashAdvisoryLock } from "@/lib/creative-decision-engine/jobs/advisory-lock";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { randomUUID, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { addObservedProductionReferenceIndex, seedCalibration, seedGeneration, seedTenant } from "../scripts/native-storage-batch/owned-fixture";
import { getDb, runDbTransaction, runPinnedDbTransaction, withPinnedDbClient } from "@/lib/db";
import { BUSINESS_ERASURE_LOCK_NAMESPACE, BusinessDeletionError, deleteBusinessWithData } from "@/lib/business-deletion";
import { enqueueBusinessDeletion, runBusinessDeletionWorkerTick } from "@/lib/business-deletion-jobs";
import { deleteBusinessReleaseReceipts, deleteBusinessWorkerHistory } from "@/lib/business-deletion-control-receipts";
import { deleteBusinessNativeEvaluations } from "@/lib/business-deletion-native-evaluations";
import { upsertSyncGateRecord } from "@/lib/sync/release-gates";
import { heartbeatSyncWorker } from "@/lib/sync/worker-health";
import { buildRuntimeContract, upsertRuntimeContractInstance } from "@/lib/sync/runtime-contract";
import { NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION } from "@/lib/creative-decision-engine/ad-operator-response-detection";
import { BUSINESS_ERASURE_REFERENCE_INDEXES, BUSINESS_ERASURE_REFERENCE_INDEX_STATUS_SQL, ensureBusinessErasureReferenceIndexes } from "@/lib/business-deletion-reference-indexes";
import { assertBusinessErasureScalarIndexCapacity, releaseGateProviderScopeIsCurrent, runReleaseGateProviderScopeMigration } from "@/lib/migrations";
import { BUSINESS_ERASURE_STATE_RUN_BOUNDS, BUSINESS_ERASURE_STATE_RUN_INDEX, ensureBusinessErasureStateRunIndex } from "@/lib/business-deletion-state-run-index";

// Only the migrated, disposable cluster may execute these destructive fixtures.
const seam = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
if (seam) {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || ["5432", "15432", ""].includes(url.port)) throw new Error("Unsafe deletion test database");
}

async function fixture() {
  const sql = getDb();
  const [user] = await sql`INSERT INTO users (name, email, password_hash)
    VALUES ('Deletion fixture', ${`${randomUUID()}@example.invalid`}, 'fixture') RETURNING id`;
  const ids: string[] = [];
  const [account] = await sql`INSERT INTO provider_accounts (provider, external_account_id)
    VALUES ('meta', ${`act_delete_${randomUUID()}`}) RETURNING id, external_account_id`;
  for (const name of ["Remove this business", "Preserve this business"]) {
    const [business] = await sql`INSERT INTO businesses (name, owner_id) VALUES (${name}, ${user!.id}) RETURNING id`;
    const id = String(business!.id);
    ids.push(id);
    await sql`INSERT INTO memberships (user_id, business_id, role, status) VALUES (${user!.id}, ${id}, 'admin', 'active')`;
    await sql`INSERT INTO business_provider_accounts (business_id, provider, provider_account_ref_id, provider_account_id)
      VALUES (${id}, 'meta', ${account!.id}, ${account!.external_account_id})`;
    const [connection] = await sql`INSERT INTO provider_connections (business_id, provider, status)
      VALUES (${id}, 'meta', 'connected') RETURNING id`;
    await sql`INSERT INTO integration_credentials (provider_connection_id, access_token)
      VALUES (${connection!.id}, 'disposable-fixture')`;
    await sql`INSERT INTO meta_entity_observation_runs (business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, endpoint, observed_at, captured_at, completeness, run_hash)
      VALUES (${id}, ${id}, ${account!.id}, ${account!.external_account_id}, 'ad', 'ads', now(), now(), 'complete', ${randomBytes(32).toString("hex")})`;
    await sql`INSERT INTO business_cost_models (business_id) VALUES (${id})`;
  }
  await sql`INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
    VALUES (${user!.id}, ${randomUUID()}, ${ids[0]}, now() + interval '1 day')`;
  return { businessId: ids[0]!, otherId: ids[1]!, userId: String(user!.id), accountId: String(account!.id) };
}

async function remains(id: string, table = "businesses", column = "id") {
  return (await getDb().query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [id])).length === 1;
}

// This recovery table is created by an optional normalization tool, so the
// canonical migrations alone cannot reproduce its presence on older databases.
async function normalizationArchive(businessId: string) {
  await getDb()`CREATE TABLE db_normalization_orphan_core_legacy (
    id BIGSERIAL PRIMARY KEY,
    source_table TEXT NOT NULL,
    business_id TEXT,
    provider TEXT,
    payload_hash TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    reason TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_table, payload_hash)
  )`;
  await getDb()`INSERT INTO db_normalization_orphan_core_legacy
    (source_table, business_id, provider, payload_hash, payload_json, reason)
    VALUES ('provider_connections', ${businessId}, 'meta', 'fixture-hash',
      '{"fixture":"recovery-original"}'::jsonb, 'business_missing_during_normalization')`;
  return getDb()`SELECT * FROM db_normalization_orphan_core_legacy ORDER BY id`;
}

describe.skipIf(!seam)("business deletion on the full migrated PostgreSQL schema", () => {
  beforeEach(() => {
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED = "enabled";
  });

  it("indexes the actual SET NULL RI lookup and erases selected history while preserving foreign rows byte for byte", async () => {
    const sql = getDb();
    const { businessId, otherId, accountId } = await fixture();
    const [account] = await sql`SELECT external_account_id FROM provider_accounts WHERE id=${accountId}::uuid`;
    for (const id of [businessId, otherId]) {
      await sql`INSERT INTO meta_authoritative_slice_versions
        (business_id,business_ref_id,provider_account_id,provider_account_ref_id,day,surface,candidate_version)
        SELECT ${id},${id}::uuid,${account!.external_account_id},${accountId}::uuid,'2026-10-01'::date,'ad',n
        FROM generate_series(1,128) n`;
      await sql`INSERT INTO meta_authoritative_reconciliation_events
        (business_id,business_ref_id,provider_account_id,provider_account_ref_id,day,surface,event_kind,result,slice_version_id,details_json)
        SELECT ${id},${id}::uuid,${account!.external_account_id},${accountId}::uuid,'2026-10-01'::date,'ad','deletion-fixture','ok',id,
          jsonb_build_object('fixture',candidate_version)
        FROM meta_authoritative_slice_versions WHERE business_ref_id=${id}::uuid`;
    }
    await sql`INSERT INTO meta_authoritative_reconciliation_events
      (business_id,business_ref_id,provider_account_id,provider_account_ref_id,day,surface,event_kind,result,details_json)
      SELECT ${otherId},${otherId}::uuid,${account!.external_account_id},${accountId}::uuid,'2026-10-01'::date,'ad','foreign-fixture','ok',
        jsonb_build_object('untouched',n) FROM generate_series(1,5000) n`;
    const [selected] = await sql`SELECT id FROM meta_authoritative_slice_versions WHERE business_ref_id=${businessId}::uuid LIMIT 1`;
    const entry = BUSINESS_ERASURE_REFERENCE_INDEXES.find(x => x.table === "meta_authoritative_reconciliation_events" && x.column === "slice_version_id")!;
    // This DROP is only the disposable old-schema reproduction. Production
    // migrations never drop, rebuild or replace an existing FK lookup index.
    await sql.query(`DROP INDEX public.${entry.index}`);
    await sql`ANALYZE meta_authoritative_reconciliation_events`;
    const actualRi = "UPDATE ONLY public.meta_authoritative_reconciliation_events SET slice_version_id=NULL WHERE $1::uuid=slice_version_id";
    const [before] = await sql.query(`EXPLAIN (FORMAT JSON) ${actualRi}`, [selected!.id]);
    expect(JSON.stringify(before!["QUERY PLAN"])).toContain("Seq Scan");
    const built = await ensureBusinessErasureReferenceIndexes(sql, (relation, method) => assertBusinessErasureScalarIndexCapacity(sql, relation, method));
    expect(built.built).toEqual([entry.index]);
    const [after] = await sql.query(`EXPLAIN (FORMAT JSON) ${actualRi}`, [selected!.id]);
    expect(JSON.stringify(after!["QUERY PLAN"])).toContain(entry.index);
    expect(JSON.stringify(after!["QUERY PLAN"])).not.toContain("Seq Scan");
    for (const contract of BUSINESS_ERASURE_REFERENCE_INDEXES) {
      const [status] = await sql.query(BUSINESS_ERASURE_REFERENCE_INDEX_STATUS_SQL, [contract.table,contract.column,contract.index,"method" in contract ? contract.method : "btree"]);
      expect(status, `${contract.table}.${contract.column}`).toMatchObject({ reference_foreign_key:true,lookup_ready:true,named_index_conflict:false });
    }
    const foreignBefore = await sql`SELECT to_jsonb(e)::text AS bytes FROM meta_authoritative_reconciliation_events e
      WHERE business_ref_id=${otherId}::uuid ORDER BY id`;
    const parentsBefore = await sql`SELECT to_jsonb(e)::text AS bytes FROM meta_authoritative_slice_versions e
      WHERE business_ref_id=${otherId}::uuid ORDER BY id`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId)).toBe(false);
    expect(await remains(businessId,"meta_authoritative_slice_versions","business_ref_id")).toBe(false);
    expect(await remains(businessId,"meta_authoritative_reconciliation_events","business_ref_id")).toBe(false);
    expect(await sql`SELECT to_jsonb(e)::text AS bytes FROM meta_authoritative_reconciliation_events e
      WHERE business_ref_id=${otherId}::uuid ORDER BY id`).toEqual(foreignBefore);
    expect(await sql`SELECT to_jsonb(e)::text AS bytes FROM meta_authoritative_slice_versions e
      WHERE business_ref_id=${otherId}::uuid ORDER BY id`).toEqual(parentsBefore);
  });

  it("uses a leading account UUID for full generic binding RI and preserves another tenant sharing that account", async () => {
    const db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
    let addedReference = false;
    try {
      const target = await seedTenant(db,1), other = await seedTenant(db,1);
      // A shared provider identity must not turn a selective lookup into authority
      // to remove the foreign tenant: the full owner/text FK still rechecks it.
      other.accounts = target.accounts;
      await db.query("INSERT INTO business_provider_accounts (business_id,provider,provider_account_ref_id,provider_account_id) VALUES ($1,'meta',$2,$3)", [other.business,target.accounts[0]!.ref,target.accounts[0]!.id]);
      for (const [tenant,tag] of [[target,"binding-remove"],[other,"binding-preserve"]] as const) {
        const producer = await seedCalibration(db,tenant,"2026-09-23","2026-09-23T12:00:00Z");
        await seedGeneration(db,tenant,{date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[5000],tag,snapshots:true});
      }
      const account = target.accounts[0]!;
      for (const table of ["engine_v3_ad_decision_evaluations","engine_v3_ad_decision_snapshots_daily"]) {
        await db.query(`ANALYZE public.${table}`);
        await db.query("BEGIN");
        try {
          await db.query("SET LOCAL enable_seqscan=off"); await db.query("SET LOCAL enable_bitmapscan=off");
          await db.query("SET LOCAL plan_cache_mode=force_generic_plan");
          await db.query(`PREPARE binding_ri(text,uuid,text) AS SELECT 1 FROM ONLY public.${table} x
            WHERE $1=x.business_id AND $2=x.provider_account_ref_id AND $3=x.provider_account_id FOR KEY SHARE OF x`);
          const {rows:[quoted]} = await db.query("SELECT quote_literal($1::text) AS business,quote_literal($2::text) AS ref,quote_literal($3::text) AS account",[target.business,account.ref,account.id]);
          const {rows:[plan]} = await db.query(`EXPLAIN (FORMAT JSON) EXECUTE binding_ri(${quoted.business}::text,${quoted.ref}::uuid,${quoted.account}::text)`);
          const contract = BUSINESS_ERASURE_REFERENCE_INDEXES.find(e => e.table===table && e.column==="provider_account_ref_id")!;
          const nodes: Record<string,unknown>[] = [];
          const walk = (n: Record<string,unknown>) => { nodes.push(n); for(const c of (n.Plans??[]) as Record<string,unknown>[]) walk(c); }; walk(plan["QUERY PLAN"][0].Plan);
          expect(nodes.some(n => n["Index Name"]===contract.index && /provider_account_ref_id\s*=/.test(String(n["Index Cond"])))).toBe(true);
          expect(nodes.some(n => ["Seq Scan","Bitmap Heap Scan"].includes(String(n["Node Type"])))).toBe(false);
        } finally { await db.query("DEALLOCATE binding_ri"); await db.query("ROLLBACK"); }
      }
      const foreign = async () => {
        const out: unknown[] = [];
        for(const table of ["engine_v3_ad_decision_evaluations","engine_v3_ad_decision_snapshots_daily","engine_v3_ad_account_calibration_daily","business_provider_accounts"]) {
          out.push((await db.query(`SELECT count(*)::int AS count,md5(string_agg(md5(to_jsonb(t)::text),',' ORDER BY to_jsonb(t)::text)) AS bytes FROM public.${table} t WHERE business_id=$1`,[other.business])).rows);
        }
        return out;
      };
      const before = await foreign();
      const {rows:[ref]} = await db.query("SELECT to_regclass('public.idx_engine_v3_ad_evaluations_contract_input') AS present");
      if(!ref.present) { await addObservedProductionReferenceIndex(db); addedReference=true; }
      await deleteBusinessWithData(target.business);
      expect(await remains(target.business)).toBe(false);
      expect(await remains(other.business)).toBe(true);
      expect(await foreign()).toEqual(before);
      expect(await remains(account.ref,"provider_accounts","id")).toBe(true);
      expect((await db.query("SELECT count(*)::int AS rows FROM business_provider_accounts WHERE business_id=$1",[target.business])).rows[0].rows).toBe(0);
    } finally { if(addedReference) await db.query("DROP INDEX public.idx_engine_v3_ad_evaluations_contract_input"); await db.end(); }
  },120_000);

  it("recognizes a completed provider-scope migration without rebuilding its existing indexes or rewriting rows", async () => {
    const sql = getDb();
    expect(await releaseGateProviderScopeIsCurrent(sql)).toBe(true);
    const indexes = () => sql`SELECT c.relname,pg_relation_filenode(c.oid)::text AS filenode,pg_get_indexdef(c.oid) AS definition
      FROM pg_class c WHERE c.oid IN (to_regclass('public.idx_sync_release_gates_key_latest'),
        to_regclass('public.idx_sync_release_gates_retention_scan'),to_regclass('public.idx_sync_release_gates_kind_latest')) ORDER BY c.relname`;
    const before = await indexes();
    expect(before).toHaveLength(3);
    await runReleaseGateProviderScopeMigration(sql);
    expect(await indexes()).toEqual(before);
  });

  it("indexes the native campaign-object RI equality and erases referenced objects without changing foreign history", async () => {
    const db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
    const flag = "ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED";
    const previous = process.env[flag]; process.env[flag] = "true";
    try {
      const target = await seedTenant(db,1), other = await seedTenant(db,1);
      for (const [tenant,tag,count] of [[target,"campaign-erase",256],[other,"campaign-preserve",2048]] as const) {
        const producer = await seedCalibration(db,tenant,"2026-09-23","2026-09-23T12:00:00Z");
        await seedGeneration(db,tenant,{date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[count],tag,snapshots:true});
      }
      const [ref] = (await db.query("SELECT campaign_context_ref FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 AND campaign_context_ref IS NOT NULL LIMIT 1",[target.business])).rows;
      expect(ref).toBeDefined();
      await db.query("ANALYZE engine_v3_ad_decision_evaluations");
      const actualRi = "SELECT 1 FROM ONLY public.engine_v3_ad_decision_evaluations x WHERE $1::uuid=x.business_ref_id AND $2::bytea=x.campaign_context_ref FOR KEY SHARE OF x";
      const [plan] = (await db.query(`EXPLAIN (FORMAT JSON) ${actualRi}`,[target.business,ref.campaign_context_ref])).rows;
      expect(JSON.stringify(plan["QUERY PLAN"])).toContain("idx_biz_erase_campaign_reference");
      expect(JSON.stringify(plan["QUERY PLAN"])).not.toContain("Seq Scan");
      const foreign = async () => (await db.query("SELECT md5(string_agg(md5(to_jsonb(e)::text),',' ORDER BY id)) AS bytes,count(*)::int AS count FROM engine_v3_ad_decision_evaluations e WHERE business_ref_id=$1",[other.business])).rows;
      const objects = async () => (await db.query("SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1 ORDER BY payload_sha256",[other.business])).rows;
      const before = await foreign(), objectsBefore = await objects();
      expect(before[0].count).toBe(2048);
      expect(objectsBefore.length).toBeGreaterThan(0);
      await addObservedProductionReferenceIndex(db);
      try {
        await deleteBusinessWithData(target.business);
        expect(await remains(target.business)).toBe(false);
        expect(await remains(target.business,"engine_v3_ad_decision_evaluations","business_ref_id")).toBe(false);
        expect(await remains(target.business,"engine_v3_ad_campaign_context_objects","business_ref_id")).toBe(false);
        expect(await foreign()).toEqual(before);
        expect(await objects()).toEqual(objectsBefore);
      } finally { await db.query("DROP INDEX idx_engine_v3_ad_evaluations_contract_input"); }
    } finally {
      if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
      await db.end();
    }
  },60_000);

  it("reproduces the old teardown's foreign-key failure and proves its rollback", async () => {
    const { businessId } = await fixture();
    await expect(runDbTransaction(async () => {
      await getDb()`DELETE FROM memberships WHERE business_id = ${businessId}`;
      await getDb()`DELETE FROM business_provider_accounts WHERE business_id = ${businessId}`;
    })).rejects.toMatchObject({ code: "23503", constraint: "meta_entity_observation_runs_binding_fk" });
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("deletes provenance children first, credentials and facts, preserving shared accounts and the other tenant", async () => {
    const { businessId, otherId, userId, accountId } = await fixture();
    await deleteBusinessWithData(businessId);
    for (const table of ["memberships", "business_provider_accounts", "provider_connections", "meta_entity_observation_runs", "business_cost_models"]) {
      expect(await remains(businessId, table, "business_id"), table).toBe(false);
      expect(await remains(otherId, table, "business_id"), table).toBe(true);
    }
    expect(await remains(businessId)).toBe(false);
    expect(await remains(otherId)).toBe(true);
    expect(await remains(userId, "users")).toBe(true);
    expect(await remains(accountId, "provider_accounts")).toBe(true);
    const [session] = await getDb()`SELECT active_business_id FROM sessions WHERE user_id = ${userId}`;
    expect(session!.active_business_id).toBeNull();
    const credentials = await getDb()`SELECT credentials.id FROM integration_credentials credentials
      JOIN provider_connections connection ON connection.id = credentials.provider_connection_id
      WHERE connection.business_id = ${otherId}`;
    expect(credentials).toHaveLength(1);
  });

  it("erases protected target evidence and preserves the other tenant and ordinary immutability", async () => {
    const { businessId, otherId } = await fixture();
    for (const id of [businessId, otherId]) await getDb()`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id, payload_sha256, storage_encoding_version, payload_json, byte_length)
      VALUES (${id}, sha256(convert_to('{}'::jsonb::text, 'UTF8')), 'native-campaign-context-jsonb.v1', '{}'::jsonb, 2)`;
    const before = await getDb()`SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=${otherId}`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId)).toBe(false);
    expect(await remains(businessId, "engine_v3_ad_campaign_context_objects", "business_ref_id")).toBe(false);
    expect(await getDb()`SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=${otherId}`).toEqual(before);
    await expect(getDb()`DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id = ${otherId}`).rejects.toThrow();
  });

  it("rejects an unreviewed new ownership table before any destructive query", async () => {
    const { businessId } = await fixture();
    await getDb()`CREATE TABLE business_delete_unknown_fixture (business_id text)`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "schema_not_ready" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
    } finally { await getDb()`DROP TABLE business_delete_unknown_fixture`; }
  });

  it("refuses an unreviewed archive guard before changing access", async () => {
    const { businessId } = await fixture();
    const archiveBefore = await normalizationArchive(randomUUID());
    try {
      await getDb()`CREATE FUNCTION business_delete_archive_fixture_guard() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Recovery archive DELETE is forbidden'; END $$`;
      await getDb()`CREATE TRIGGER business_delete_archive_fixture_guard
        BEFORE DELETE ON db_normalization_orphan_core_legacy FOR EACH STATEMENT
        EXECUTE FUNCTION business_delete_archive_fixture_guard()`;
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "protected_history" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
      expect(await getDb()`SELECT * FROM db_normalization_orphan_core_legacy ORDER BY id`).toEqual(archiveBefore);
    } finally {
      await getDb()`DROP TABLE db_normalization_orphan_core_legacy`;
      await getDb()`DROP FUNCTION IF EXISTS business_delete_archive_fixture_guard()`;
    }
  });

  it("removes only target-owned normalization recovery history", async () => {
    const { businessId, otherId } = await fixture();
    await normalizationArchive(businessId);
    await getDb()`INSERT INTO db_normalization_orphan_core_legacy
      (source_table,business_id,payload_hash,payload_json,reason)
      VALUES ('provider_connections',${otherId},'other-fixture','{"keep":true}'::jsonb,'fixture')`;
    const before = await getDb()`SELECT * FROM db_normalization_orphan_core_legacy WHERE business_id=${otherId}`;
    try {
      await deleteBusinessWithData(businessId);
      expect(await remains(businessId)).toBe(false);
      expect(await remains(businessId, "db_normalization_orphan_core_legacy", "business_id")).toBe(false);
      expect(await getDb()`SELECT * FROM db_normalization_orphan_core_legacy WHERE business_id=${otherId}`).toEqual(before);
    } finally { await getDb()`DROP TABLE db_normalization_orphan_core_legacy`; }
  });

  it("rolls every change back when an unforeseen indirect foreign key refuses deletion", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id,payload_sha256,storage_encoding_version,payload_json,byte_length)
      VALUES (${otherId},sha256(convert_to('{}'::jsonb::text,'UTF8')),'native-campaign-context-jsonb.v1','{}'::jsonb,2)`;
    const guardsBefore = await getDb()`SELECT tgrelid,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgrelid,tgname`;
    await getDb()`CREATE TABLE business_delete_fk_fixture (member_id uuid REFERENCES memberships(id) ON DELETE RESTRICT)`;
    await getDb()`INSERT INTO business_delete_fk_fixture SELECT id FROM memberships WHERE business_id = ${businessId}`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "23503" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
      expect(await remains(businessId, "meta_entity_observation_runs", "business_id")).toBe(true);
      expect(await remains(businessId, "provider_connections", "business_id")).toBe(true);
      expect(await getDb()`SELECT tgrelid,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgrelid,tgname`).toEqual(guardsBefore);
      await expect(getDb()`DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=${otherId}`).rejects.toThrow();
    } finally { await getDb()`DROP TABLE business_delete_fk_fixture`; }
  });

  it("does not delete while a provider runner owns a live lease", async () => {
    const { businessId } = await fixture();
    await getDb()`INSERT INTO sync_runner_leases (business_id, provider_scope, lease_owner, lease_expires_at)
      VALUES (${businessId}, 'meta', 'disposable-owner', now() + interval '10 minutes')`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "business_busy" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
    } finally { await getDb()`DELETE FROM sync_runner_leases WHERE business_id=${businessId}`; }
  });

  it("refuses global writer exclusion while ANOTHER business has an active lease", async () => {
    const { businessId,otherId } = await fixture();
    await getDb()`INSERT INTO sync_runner_leases (business_id,provider_scope,lease_owner,lease_expires_at)
      VALUES (${otherId},'meta','foreign-active-worker',now()+interval '10 minutes')`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"business_busy"});
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
    } finally { await getDb()`DELETE FROM sync_runner_leases WHERE business_id=${otherId}`; }
  });

  it("refuses a foreign active native job through the global status index without changing either tenant", async () => {
    const {businessId,otherId}=await fixture();
    const [job]=await getDb()`INSERT INTO engine_v3_job_runs
      (job_name,business_ref_id,business_id,as_of_date,engine_version,status)
      VALUES ('deletion-active-fixture',${otherId},${otherId},'2026-10-08','fixture','running') RETURNING id`;
    const before=await getDb()`SELECT * FROM engine_v3_job_runs WHERE id=${job!.id}`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"business_busy",tables:["engine_v3_job_runs"]});
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
      expect(await getDb()`SELECT * FROM engine_v3_job_runs WHERE id=${job!.id}`).toEqual(before);
      await expect(getDb()`UPDATE engine_v3_job_runs SET status='claimed' WHERE id=${job!.id}`).rejects.toMatchObject({code:"23514"});
    } finally { await getDb()`UPDATE engine_v3_job_runs SET status='success' WHERE id=${job!.id}`; }
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId)).toBe(false);
    expect(await remains(otherId)).toBe(true);
  });

  it("preserves a proven stale retired foreign ledger byte for byte while holding its canonical execution locks", async () => {
    const {businessId,otherId}=await fixture();
    const [job]=await getDb()`INSERT INTO engine_v3_job_runs
      (job_name,business_ref_id,business_id,as_of_date,engine_version,status,started_at,updated_at)
      VALUES ('engine_v3_native_ad_decisions_shadow_job',${otherId},${otherId},'2026-09-27',
        'v3-ad-2026-09-24-cut-proof-floor-story-shadow','running',now()-interval '1 day',now()-interval '1 day') RETURNING id`;
    const before=await getDb()`SELECT * FROM engine_v3_job_runs WHERE id=${job!.id}`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId)).toBe(false);
    expect(await getDb()`SELECT * FROM engine_v3_job_runs WHERE id=${job!.id}`).toEqual(before);
  });

  it.each(["job","chain"])("refuses retired running metadata while its actual %s execution lock is held", async kind => {
    const {businessId,otherId}=await fixture();
    const [job]=await getDb()`INSERT INTO engine_v3_job_runs
      (job_name,business_ref_id,business_id,as_of_date,engine_version,status,started_at,updated_at)
      VALUES ('engine_v3_native_ad_decisions_shadow_job',${otherId},${otherId},'2026-09-27',
        'v3-ad-2026-09-24-cut-proof-floor-story-shadow','running',now()-interval '1 day',now()-interval '1 day') RETURNING id`;
    const lock=new Client({connectionString:process.env.DATABASE_URL});await lock.connect();
    const key=hashAdvisoryLock(`${kind==="job"?"engine_v3_native_ad_decisions_shadow_job":"engine_v3_native_ad_shadow_business_chain"}:${otherId}:2026-09-27`).toString();
    try {
      await lock.query("SELECT pg_advisory_lock($1::bigint)",[key]);
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"business_busy",tables:["engine_v3_job_runs"]});
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
    } finally { await lock.end(); await getDb()`UPDATE engine_v3_job_runs SET status='success' WHERE id=${job!.id}`; }
  });

  it("refuses a current-epoch running ledger regardless of its age and preserves its bytes", async () => {
    const {businessId,otherId}=await fixture();
    const [job]=await getDb()`INSERT INTO engine_v3_job_runs
      (job_name,business_ref_id,business_id,as_of_date,engine_version,status,started_at,updated_at)
      VALUES ('engine_v3_native_ad_decisions_shadow_job',${otherId},${otherId},'2026-09-27',${NATIVE_AD_ENGINE_VERSION},
        'running',now()-interval '1 day',now()-interval '1 day') RETURNING id`;
    const before=await getDb()`SELECT * FROM engine_v3_job_runs WHERE id=${job!.id}`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"business_busy",tables:["engine_v3_job_runs"]});
      expect(await getDb()`SELECT * FROM engine_v3_job_runs WHERE id=${job!.id}`).toEqual(before);
      expect(await remains(businessId)).toBe(true);
    } finally { await getDb()`UPDATE engine_v3_job_runs SET status='success' WHERE id=${job!.id}`; }
  });

  it("refuses an incomplete retired running-ledger census instead of accepting a partial sample", async () => {
    const {businessId,otherId}=await fixture();
    const jobs=await getDb()`INSERT INTO engine_v3_job_runs
      (job_name,business_ref_id,business_id,as_of_date,engine_version,status,started_at,updated_at)
      SELECT 'engine_v3_native_ad_decisions_shadow_job',${otherId}::uuid,${otherId},'2026-09-27'::date,
        'v3-ad-2026-09-24-cut-proof-floor-story-shadow','running',now()-interval '1 day',now()-interval '1 day'
      FROM generate_series(1,65) RETURNING id`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"business_busy",tables:["engine_v3_job_runs"]});
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
    } finally { await getDb().query("UPDATE engine_v3_job_runs SET status='success' WHERE id=ANY($1::uuid[])",[jobs.map(j=>j.id)]); }
  });

  it("durably queues once, performs erasure on the pinned worker backend and removes the job in the same commit", async () => {
    const {businessId,otherId,userId}=await fixture();
    const first=await enqueueBusinessDeletion(businessId),again=await enqueueBusinessDeletion(businessId);
    expect(first.status).toBe("queued");expect(again.attempt_id).toBe(first.attempt_id);
    expect(await remains(businessId)).toBe(true);
    const foreign=await getDb()`SELECT * FROM memberships WHERE business_id=${otherId}`;
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"completed"});
    expect(await remains(businessId)).toBe(false);
    expect(await remains(businessId,"business_deletion_jobs","business_ref_id")).toBe(false);
    expect(await remains(userId,"users")).toBe(true);
    expect(await getDb()`SELECT * FROM memberships WHERE business_id=${otherId}`).toEqual(foreign);
  });

  it("marks a rolled-back job failed and retries only after a fresh authorized enqueue", async () => {
    const {businessId}=await fixture();
    await getDb()`CREATE TABLE business_delete_job_fk_fixture(member_id uuid REFERENCES memberships(id) ON DELETE RESTRICT)`;
    await getDb()`INSERT INTO business_delete_job_fk_fixture SELECT id FROM memberships WHERE business_id=${businessId}`;
    const first=await enqueueBusinessDeletion(businessId);
    try {
      expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"failed"});
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
      const [job]=await getDb()`SELECT * FROM business_deletion_jobs WHERE business_ref_id=${businessId}`;
      expect(job!.status).toBe("failed");
      expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"idle"});
    } finally { await getDb()`DROP TABLE business_delete_job_fk_fixture`; }
    const retry=await enqueueBusinessDeletion(businessId);
    expect(retry.attempt_id).not.toBe(first.attempt_id);
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"completed"});
    expect(await remains(businessId)).toBe(false);
  });

  it("rolls owned data and the job back when a root trigger silently skips removal",async()=>{
    const {businessId}=await fixture();await enqueueBusinessDeletion(businessId);
    await getDb()`CREATE FUNCTION business_delete_root_skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`;
    await getDb()`CREATE TRIGGER business_delete_root_skip BEFORE DELETE ON businesses FOR EACH ROW EXECUTE FUNCTION business_delete_root_skip()`;
    try {
      expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"failed",code:"schema_not_ready"});
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
      expect(await remains(businessId,"provider_connections","business_id")).toBe(true);
      const [job]=await getDb()`SELECT status FROM business_deletion_jobs WHERE business_ref_id=${businessId}`;
      expect(job!.status).toBe("failed");
    } finally {
      await getDb()`DROP TRIGGER business_delete_root_skip ON businesses`;
      await getDb()`DROP FUNCTION business_delete_root_skip()`;
    }
    await enqueueBusinessDeletion(businessId);
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"completed"});
  });

  it("does not claim a queued job while a second session owns the global erasure lock", async () => {
    const {businessId}=await fixture();await enqueueBusinessDeletion(businessId);
    const blocker=new Client({connectionString:process.env.DATABASE_URL});await blocker.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock($1::int,0)",[BUSINESS_ERASURE_LOCK_NAMESPACE]);
      expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"busy"});
      const [job]=await getDb()`SELECT status,attempts FROM business_deletion_jobs WHERE business_ref_id=${businessId}`;
      expect(job).toMatchObject({status:"queued",attempts:0});
    } finally { await blocker.end(); }
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"completed"});
  });

  it("stops automatic recovery after three interrupted attempts without deleting the business",async()=>{
    const {businessId}=await fixture();await enqueueBusinessDeletion(businessId);
    await getDb()`UPDATE business_deletion_jobs SET status='running',attempts=3 WHERE business_ref_id=${businessId}`;
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"interrupted"});
    const [job]=await getDb()`SELECT status,error_code FROM business_deletion_jobs WHERE business_ref_id=${businessId}`;
    expect(job).toMatchObject({status:"failed",error_code:"interrupted"});
    expect(await remains(businessId,"memberships","business_id")).toBe(true);
    expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"idle"});
    await getDb()`DELETE FROM business_deletion_jobs WHERE business_ref_id=${businessId}`;
  });

  it("recovers a running job after its actual pinned PostgreSQL backend is terminated, without leaving partial erasure", async () => {
    const {businessId}=await fixture();await enqueueBusinessDeletion(businessId);
    const observer=new Client({connectionString:process.env.DATABASE_URL});await observer.connect();
    const work=runBusinessDeletionWorkerTick().then(v=>({value:v}),e=>({error:e}));
    let killed=false;
    try {
      for(let n=0;n<200;n++) {
        const {rows:[active]}=await observer.query(`SELECT a.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE l.locktype='advisory' AND l.classid=$1::oid AND l.objid=0 AND l.granted
            AND a.xact_start IS NOT NULL AND a.query NOT ILIKE '%UPDATE business_deletion_jobs%'
            AND a.query NOT ILIKE '%pg_try_advisory%' LIMIT 1`,[BUSINESS_ERASURE_LOCK_NAMESPACE]);
        if(active) {await observer.query("SELECT pg_terminate_backend($1)",[active.pid]);killed=true;break;}
        await new Promise(r=>setTimeout(r,2));
      }
      expect(killed).toBe(true);expect(await work).toHaveProperty("error");
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
      const [job]=await getDb()`SELECT status FROM business_deletion_jobs WHERE business_ref_id=${businessId}`;
      expect(job!.status).toBe("running");
      expect(await runBusinessDeletionWorkerTick()).toMatchObject({outcome:"completed"});
      expect(await remains(businessId)).toBe(false);
    } finally {await work;await observer.end();}
  });

  it("retains live process heartbeat writes during the bulk transaction before its final control-history fence",async()=>{
    const {businessId}=await fixture();
    let observed=false;
    await withPinnedDbClient(async client=>{
      const wrapped={query:async(text:string,params?:unknown[])=>{
        if(!observed && text.startsWith("CREATE TEMP TABLE business_erasure_input_keys")) {
          await heartbeatSyncWorker({workerId:`delete-live-${randomUUID()}`,instanceType:"fixture",providerScope:"all",status:"idle",metaJson:{fixture:true}});
          observed=true;
        }
        return client.query(text,params);
      }};
      await deleteBusinessWithData(businessId,{client:wrapped as never});
    },{timeoutMs:30_000});
    expect(observed).toBe(true);expect(await remains(businessId)).toBe(false);
  });

  it("enforces the pinned transaction statement cap and absolute deadline, rolling back before the backend is reused",async()=>{
    const {businessId}=await fixture();
    await withPinnedDbClient(async client=>{
      await expect(runPinnedDbTransaction({client,timeoutMs:80,lockTimeoutMs:80,deadlineAtMs:Date.now()+10_000,fn:async sql=>{
        await sql`UPDATE businesses SET name='pinned must roll back' WHERE id=${businessId}`;
        await sql.query("SELECT pg_sleep(5)");
      }})).rejects.toThrow();
      expect((await client.query("SELECT name FROM businesses WHERE id=$1",[businessId])).rows[0].name).toBe("Remove this business");
      await expect(runPinnedDbTransaction({client,timeoutMs:500,lockTimeoutMs:80,deadlineAtMs:Date.now()+150,fn:async sql=>{
        await sql`UPDATE businesses SET name='deadline must roll back' WHERE id=${businessId}`;
        await sql.query("SELECT pg_sleep(5)");
      }})).rejects.toThrow();
      expect((await client.query("SELECT name FROM businesses WHERE id=$1",[businessId])).rows[0].name).toBe("Remove this business");
    },{timeoutMs:30_000});
  });

  it("allows data removal under a growth refusal, without changing the growth budget", async () => {
    const { businessId } = await fixture();
    const old = process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES;
    process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES = "1";
    try {
      await deleteBusinessWithData(businessId);
      expect(await remains(businessId)).toBe(false);
      expect(process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES).toBe("1");
    } finally {
      if (old === undefined) delete process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES;
      else process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES = old;
    }
  });

  it("refuses contradictory canonical and text ownership without touching either tenant", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO provider_connections (business_id, business_ref_id, provider)
      VALUES (${businessId}, ${otherId}, 'shopify')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "scope_conflict" });
    expect(await remains(businessId)).toBe(true);
    expect(await remains(otherId)).toBe(true);
  });

  it("erases many observation parents with generic RI plans while retaining foreign history byte for byte", async () => {
    const { businessId, otherId, accountId } = await fixture();
    const sql = getDb();
    const [account] = await sql`SELECT external_account_id FROM provider_accounts WHERE id=${accountId}::uuid`;
    // Only bulk fixture population has this longer disposable-client deadline.
    // Actual erasure retains its production page deadline and all FK checks.
    const seeding = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 30_000, query_timeout: 30_000 });
    await seeding.connect();
    try {
    await seeding.query(`INSERT INTO meta_entity_observation_runs
      (business_ref_id,business_id,provider_account_ref_id,provider_account_id,entity_type,endpoint,observed_at,captured_at,completeness,run_hash)
      SELECT b::uuid,b,$3::uuid,$4,'ad','ads',now()-n*interval '1 second',now()-n*interval '1 second','complete',
        encode(sha256(convert_to(b||':'||n,'UTF8')),'hex')
      FROM unnest(ARRAY[$1::text,$2::text]) b CROSS JOIN generate_series(1,5000) n`,
    [businessId,otherId,accountId,account!.external_account_id]);
    await seeding.query(`INSERT INTO meta_entity_state_history
      (run_id,business_ref_id,business_id,provider_account_ref_id,provider_account_id,entity_type,entity_id,
       campaign_id,adset_id,ad_id,observed_at,captured_at,run_completeness,presence,state_hash,field_coverage_json)
      SELECT r.id,r.business_ref_id,r.business_id,r.provider_account_ref_id,r.provider_account_id,'ad',n::text,
        'fixture-campaign','fixture-adset',n::text,r.observed_at,r.captured_at,r.completeness,'present',
        encode(sha256(convert_to(r.id::text||':'||n,'UTF8')),'hex'),$3::jsonb
      FROM meta_entity_observation_runs r CROSS JOIN generate_series(1,2) n
      WHERE r.business_id IN ($1,$2)`,[businessId,otherId,JSON.stringify({ fixture: randomBytes(512).toString("hex") })]);
    } finally { await seeding.end(); }
    const foreign = async () => {
      const [runs] = await sql.query(`SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY id)) AS digest
        FROM meta_entity_observation_runs r WHERE business_ref_id=$1::uuid`,[otherId]);
      const [states] = await sql.query(`SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY id)) AS digest
        FROM meta_entity_state_history r WHERE business_ref_id=$1::uuid`,[otherId]);
      return [runs!.digest,states!.digest];
    };
    const before = await foreign();
    await sql`ANALYZE meta_entity_state_history`;
    const witnesses = await sql.query(`SELECT DISTINCT ON (business_ref_id) * FROM meta_entity_observation_runs
      WHERE business_ref_id IN ($1::uuid,$2::uuid) ORDER BY business_ref_id,captured_at DESC`,[businessId,otherId]);
    await withPinnedDbClient(async client => {
      await client.query("SET plan_cache_mode=force_generic_plan");
      await client.query("SET enable_seqscan=off");
      await client.query("SET enable_bitmapscan=off");
      await client.query(`PREPARE business_erasure_state_run_probe(uuid,uuid,text,uuid,text,text,timestamptz,text) AS
        SELECT 1 FROM ONLY public.meta_entity_state_history x
        WHERE $1=run_id AND $2=business_ref_id AND $3=business_id AND $4=provider_account_ref_id
          AND $5=provider_account_id AND $6=entity_type AND $7=captured_at AND $8=run_completeness FOR KEY SHARE OF x`);
      try {
        for (const r of witnesses) {
          const literal = (v: unknown) => `'${String(v).replaceAll("'", "''")}'`;
          const values = [r.id,r.business_ref_id,r.business_id,r.provider_account_ref_id,r.provider_account_id,
            r.entity_type,new Date(r.captured_at as string).toISOString(),r.completeness].map(literal).join(",");
          const {rows:[explain]} = await client.query(`EXPLAIN (FORMAT JSON) EXECUTE business_erasure_state_run_probe(${values})`);
          const nodes: Record<string,unknown>[] = [];
          const walk = (n: Record<string,unknown>) => { nodes.push(n); for (const c of (n.Plans ?? []) as Record<string,unknown>[]) walk(c); };
          walk((explain!["QUERY PLAN"] as Array<{Plan:Record<string,unknown>}>)[0]!.Plan);
          expect(nodes.some(n=>n["Index Name"]===BUSINESS_ERASURE_STATE_RUN_INDEX && String(n["Index Cond"]).includes("run_id"))).toBe(true);
        }
        await deleteBusinessWithData(businessId,{client});
      } finally {
        await client.query("DEALLOCATE business_erasure_state_run_probe");
        await client.query("RESET plan_cache_mode");
        await client.query("RESET enable_seqscan");
        await client.query("RESET enable_bitmapscan");
      }
    });
    expect(await remains(businessId)).toBe(false);
    expect(await remains(businessId,"meta_entity_state_history","business_ref_id")).toBe(false);
    expect(await remains(businessId,"meta_entity_observation_runs","business_ref_id")).toBe(false);
    expect(await foreign()).toEqual(before);
  },60_000);

  it("refuses an unbounded state-run key before index DDL and restores the disposable schema", async () => {
    const sql = getDb();
    await sql.query(`DROP INDEX public.${BUSINESS_ERASURE_STATE_RUN_INDEX}`);
    await sql`ALTER TABLE meta_entity_state_history DROP CONSTRAINT meta_entity_state_history_entity_type_check`;
    const admit = vi.fn();
    try {
      await expect(ensureBusinessErasureStateRunIndex(sql,admit)).rejects.toThrow("state_run_index_contract");
      expect(admit).not.toHaveBeenCalled();
      const [index] = await sql`SELECT to_regclass('public.idx_biz_erase_state_run_lineage') AS present`;
      expect(index!.present).toBeNull();
    } finally {
      await sql.query(`ALTER TABLE meta_entity_state_history ADD CONSTRAINT meta_entity_state_history_entity_type_check
        CHECK ${BUSINESS_ERASURE_STATE_RUN_BOUNDS[0]}`);
      await ensureBusinessErasureStateRunIndex(sql,async()=>{});
    }
  });

  it("uses the complete enforced run FK for large state history, refusing nullable or disabled inheritance before any erasure", async () => {
    const { businessId, otherId } = await fixture();
    // Keep the non-compressible payload inline so the heap exceeds the large-
    // relation threshold; an out-of-line TOAST fixture would miss that path.
    const payload = JSON.stringify({ fixture: randomBytes(512).toString("hex") });
    await getDb().query(`INSERT INTO meta_entity_state_history
      (run_id,business_ref_id,business_id,provider_account_ref_id,provider_account_id,entity_type,entity_id,
       campaign_id,adset_id,ad_id,observed_at,captured_at,run_completeness,presence,state_hash,field_coverage_json)
      SELECT r.id,r.business_ref_id,r.business_id,r.provider_account_ref_id,r.provider_account_id,'ad',n::text,
        'fixture-campaign','fixture-adset',n::text,r.observed_at,r.captured_at,r.completeness,'present',
        encode(sha256(convert_to(n::text,'UTF8')),'hex'),$3::jsonb
      FROM meta_entity_observation_runs r CROSS JOIN generate_series(1,1025) n
      WHERE r.business_id IN ($1,$2)`,[businessId,otherId,payload]);
    const [size] = await getDb()`SELECT pg_relation_size('meta_entity_state_history')::int AS bytes`;
    expect(Number(size!.bytes)).toBeGreaterThan(1024**2);
    const [trigger] = await getDb()`SELECT t.tgname FROM pg_trigger t JOIN pg_constraint f ON f.oid=t.tgconstraint
      WHERE f.conrelid='meta_entity_state_history'::regclass AND f.conname='meta_entity_state_history_run_fk'
        AND t.tgrelid='meta_entity_state_history'::regclass ORDER BY t.tgname LIMIT 1`;
    const quotedTrigger = '"'+String(trigger!.tgname).replaceAll('"','""')+'"';
    await getDb().query(`ALTER TABLE meta_entity_state_history DISABLE TRIGGER ${quotedTrigger}`);
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"schema_not_ready"});
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
    } finally { await getDb().query(`ALTER TABLE meta_entity_state_history ENABLE TRIGGER ${quotedTrigger}`); }
    await getDb()`ALTER TABLE meta_entity_state_history ALTER COLUMN run_id DROP NOT NULL`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"schema_not_ready"});
      expect(await remains(businessId,"meta_entity_state_history","business_id")).toBe(true);
    } finally { await getDb()`ALTER TABLE meta_entity_state_history ALTER COLUMN run_id SET NOT NULL`; }
    const before = await getDb()`SELECT * FROM meta_entity_state_history WHERE business_id=${otherId} ORDER BY id`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId,"meta_entity_state_history","business_id")).toBe(false);
    expect(await remains(businessId)).toBe(false);
    expect(await getDb()`SELECT * FROM meta_entity_state_history WHERE business_id=${otherId} ORDER BY id`).toEqual(before);
  });

  it("erases large original job history through its required UUID owner while retaining NULL compatibility and other-tenant bytes", async () => {
    const { businessId, otherId } = await fixture();
    await getDb().query(`INSERT INTO engine_v3_job_runs
      (job_name,business_ref_id,business_id,as_of_date,engine_version,status,error_json)
      SELECT 'erasure-fixture',b::uuid,NULL,'2026-10-01','fixture','failed',$3::jsonb
      FROM unnest(ARRAY[$1::text,$2::text]) b CROSS JOIN generate_series(1,4097) n`,
    [businessId,otherId,JSON.stringify({fixture:randomBytes(512).toString("hex")})]);
    const [size] = await getDb()`SELECT pg_relation_size('engine_v3_job_runs')::int AS bytes`;
    expect(Number(size!.bytes)).toBeGreaterThan(1024**2);
    const before = await getDb()`SELECT * FROM engine_v3_job_runs WHERE business_ref_id=${otherId} ORDER BY id`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId,"engine_v3_job_runs","business_ref_id")).toBe(false);
    expect(await getDb()`SELECT * FROM engine_v3_job_runs WHERE business_ref_id=${otherId} ORDER BY id`).toEqual(before);
  });

  it("finds a late dual-owner contradiction across cursor pages, then erases all corrected fact pages while preserving foreign bytes", async () => {
    const { businessId, otherId } = await fixture();
    await getDb().query(`INSERT INTO meta_adset_daily
      (business_id,business_ref_id,provider_account_id,date,adset_id,account_timezone,account_currency,promoted_object_json)
      SELECT b,b::uuid,'fixture-account','2026-10-01','fact-'||lpad(n::text,5,'0'),'UTC','USD',$3::jsonb
      FROM unnest(ARRAY[$1::text,$2::text]) b CROSS JOIN generate_series(1,4500) n`,
    [businessId,otherId,JSON.stringify({fixture:randomBytes(512).toString("hex")})]);
    const [size] = await getDb()`SELECT pg_relation_size('meta_adset_daily')::int AS bytes`;
    expect(Number(size!.bytes)).toBeGreaterThan(1024**2);
    await getDb()`INSERT INTO meta_adset_daily
      (business_id,business_ref_id,provider_account_id,date,adset_id,account_timezone,account_currency)
      VALUES (${businessId},${otherId},'fixture-account','2026-10-01','zz-late-conflict','UTC','USD')`;
    const before = await getDb()`SELECT * FROM meta_adset_daily WHERE business_id IN (${businessId},${otherId}) ORDER BY id`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"scope_conflict"});
    expect(await remains(businessId,"memberships","business_id")).toBe(true);
    expect(await getDb()`SELECT * FROM meta_adset_daily WHERE business_id IN (${businessId},${otherId}) ORDER BY id`).toEqual(before);
    await getDb()`UPDATE meta_adset_daily SET business_ref_id=${businessId} WHERE business_id=${businessId} AND adset_id='zz-late-conflict'`;
    const foreign = await getDb()`SELECT * FROM meta_adset_daily WHERE business_id=${otherId} ORDER BY id`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId,"meta_adset_daily","business_id")).toBe(false);
    expect(await remains(businessId)).toBe(false);
    expect(await getDb()`SELECT * FROM meta_adset_daily WHERE business_id=${otherId} ORDER BY id`).toEqual(foreign);
  });

  it("rolls an already deleted large-table page back when a later exact row has an unforeseen FK", async () => {
    const { businessId, otherId } = await fixture();
    await getDb().query(`INSERT INTO engine_v3_job_runs
      (job_name,business_ref_id,business_id,as_of_date,engine_version,status,error_json)
      SELECT 'late-page-fixture',b::uuid,NULL,'2026-10-01','fixture','failed',$3::jsonb
      FROM unnest(ARRAY[$1::text,$2::text]) b CROSS JOIN generate_series(1,4500) n`,
    [businessId,otherId,JSON.stringify({fixture:randomBytes(512).toString("hex")})]);
    // Pick an actual later tuple in the same owner cursor order. No fixture
    // write intervenes between this read and the deletion under test.
    const lateTid = await runDbTransaction(async () => {
      const sql = getDb();
      await sql.query("SET LOCAL enable_seqscan=off");
      await sql.query("SET LOCAL cursor_tuple_fraction=1");
      await sql.query(`DECLARE late_page_probe NO SCROLL CURSOR FOR SELECT ctid::text AS row_tid,tableoid::text AS row_table
        FROM public.engine_v3_job_runs WHERE business_ref_id=$1::uuid`,[businessId]);
      const page = await sql.query<{row_tid:string}>("FETCH FORWARD 4097 FROM late_page_probe");
      await sql.query("CLOSE late_page_probe");
      expect(page).toHaveLength(4097);
      return page[4096]!.row_tid;
    });
    await getDb()`CREATE TABLE business_delete_late_page_fk (job_id uuid REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT)`;
    await getDb().query("INSERT INTO business_delete_late_page_fk SELECT id FROM engine_v3_job_runs WHERE ctid=$1::tid",[lateTid]);
    const before = await getDb()`SELECT * FROM engine_v3_job_runs WHERE business_ref_id IN (${businessId},${otherId}) ORDER BY id`;
    const log = vi.spyOn(console,"error").mockImplementation(() => {});
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"23503"});
      const failure = log.mock.calls.find(([message])=>message==="[business erasure] failed");
      expect(JSON.parse(String(failure?.[1])).ownedPages).toBeGreaterThanOrEqual(1);
      expect(await remains(businessId,"memberships","business_id")).toBe(true);
      expect(await getDb()`SELECT * FROM engine_v3_job_runs WHERE business_ref_id IN (${businessId},${otherId}) ORDER BY id`).toEqual(before);
    } finally {
      log.mockRestore();
      await getDb()`DROP TABLE business_delete_late_page_fk`;
    }
  });

  it("keeps the assignment kill switch authoritative", async () => {
    const { businessId } = await fixture();
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
    await expect(deleteBusinessWithData(businessId)).rejects.toThrow("disabled");
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("returns not found without attempting a purge for an absent business", async () => {
    await expect(deleteBusinessWithData(randomUUID())).rejects.toBeInstanceOf(BusinessDeletionError);
  });

  it("removes frozen labels as whole-business teardown without reviving the label writer", async () => {
    const { businessId, otherId } = await fixture();
    for (const id of [businessId, otherId]) await getDb()`INSERT INTO meta_campaign_labels (business_id, campaign_id, campaign_kind)
      VALUES (${id}, 'frozen-history', 'main')`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId, "meta_campaign_labels", "business_id")).toBe(false);
    expect(await remains(otherId, "meta_campaign_labels", "business_id")).toBe(true);
  });

  it("blocks competing writers during the suspended-guard transaction and restores the guard on commit", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id,payload_sha256,storage_encoding_version,payload_json,byte_length)
      VALUES (${otherId},sha256(convert_to('{}'::jsonb::text,'UTF8')),'native-campaign-context-jsonb.v1','{}'::jsonb,2)`;
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const competitor = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect(); await competitor.connect();
    let deletion: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM memberships WHERE business_id=$1 FOR UPDATE", [businessId]);
      deletion = deleteBusinessWithData(businessId);
      // Consume rejection immediately; the assertions below still observe it.
      void deletion.catch(() => undefined);
      let waiting = false;
      for (let n = 0; n < 80 && !waiting; n++) {
        const r = await competitor.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE 'DELETE FROM%memberships%'");
        waiting = r.rowCount === 1;
        if (!waiting) await new Promise(r => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      const modes = await competitor.query("SELECT tgenabled FROM pg_trigger WHERE tgname='engine_v3_ad_campaign_objects_immutable'");
      expect(modes.rows).toEqual([{ tgenabled: "O" }]);
      await competitor.query("SET lock_timeout='100ms'");
      await expect(competitor.query("DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1", [otherId])).rejects.toMatchObject({ code: "55P03" });
      await blocker.query("COMMIT");
      await deletion;
      await expect(competitor.query("DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1", [otherId])).rejects.toThrow();
      expect(await remains(businessId)).toBe(false);
    } finally {
      await blocker.query("ROLLBACK");
      if (deletion) await deletion.catch(() => undefined);
      await blocker.end(); await competitor.end();
    }
  });

  it("removes indirect report/audit copies and compact run metadata, preserving other business records", async () => {
    const { businessId, otherId, userId } = await fixture();
    for (const id of [businessId, otherId]) {
      await getDb()`INSERT INTO custom_report_share_snapshots(token,report_id,payload,expires_at)
        VALUES (${randomUUID()},'removed-parent',${JSON.stringify({ businessId:id })}::jsonb,now()+interval '1 day')`;
      await getDb()`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,meta)
        VALUES (${userId},'business.plan_override','business',${id},'{}'::jsonb)`;
    }
    const before = await getDb()`SELECT * FROM custom_report_share_snapshots WHERE payload->>'businessId'=${otherId}`;
    await getDb()`CREATE SCHEMA IF NOT EXISTS adsecute_compact_20260726t0204z`;
    for (const table of ["keep_runs", "run_semantics"]) await getDb().query(`CREATE TABLE adsecute_compact_20260726t0204z.${table} AS SELECT id AS run_id FROM meta_entity_observation_runs WHERE business_id=$1 OR business_id=$2`, [businessId,otherId]);
    try {
      await deleteBusinessWithData(businessId);
      expect(await getDb()`SELECT 1 FROM custom_report_share_snapshots WHERE payload->>'businessId'=${businessId}`).toHaveLength(0);
      expect(await getDb()`SELECT 1 FROM admin_audit_logs WHERE target_id=${businessId}`).toHaveLength(0);
      expect(await getDb()`SELECT * FROM custom_report_share_snapshots WHERE payload->>'businessId'=${otherId}`).toEqual(before);
      for (const table of ["keep_runs", "run_semantics"]) expect(await getDb().query(`SELECT * FROM adsecute_compact_20260726t0204z.${table}`)).toHaveLength(1);
    } finally { await getDb()`DROP SCHEMA adsecute_compact_20260726t0204z CASCADE`; }
  });

  it("collects only globally unreferenced native inputs and deletes protected calibration/context evidence", async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    try {
      const target = await seedTenant(db,1), other = await seedTenant(db,1);
      for (const [tenant,tag] of [[target,"delete"],[other,"preserve"]] as const) {
        const producer = await seedCalibration(db,tenant,"2026-09-23","2026-09-23T12:00:00Z");
        await seedGeneration(db,tenant,{ date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[2],tag });
      }
      const keys = (await db.query("SELECT contract_version,input_hash::text FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY input_hash",[target.business])).rows;
      // Deliberate shared-key fixture proves GLOBAL reference safety; it grants no decision authority.
      await db.query("UPDATE engine_v3_ad_decision_evaluations SET input_hash=$1 WHERE id=(SELECT id FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$2 LIMIT 1)",[keys[0].input_hash,other.business]);
      await expect(deleteBusinessWithData(target.business)).rejects.toMatchObject({ code:"schema_not_ready", tables:["input_evidence_reference_index"] });
      expect(await remains(target.business)).toBe(true);
      await addObservedProductionReferenceIndex(db);
      try {
        const preserved = (await db.query("SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1 ORDER BY payload_sha256",[other.business])).rows;
        await deleteBusinessWithData(target.business);
        for (const table of ["engine_v3_ad_decision_evaluations","engine_v3_ad_campaign_context_objects","engine_v3_ad_account_calibration_batches","engine_v3_ad_account_calibration_daily"]) {
          expect(await remains(target.business,table,"business_ref_id"),table).toBe(false);
          expect(await remains(other.business,table,"business_ref_id"),table).toBe(true);
        }
        expect((await db.query("SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1 ORDER BY payload_sha256",[other.business])).rows).toEqual(preserved);
        expect((await db.query("SELECT input_hash::text FROM engine_v3_ad_decision_input_evidence WHERE input_hash=ANY($1::character(64)[])",[keys.map(k=>k.input_hash)])).rows).toEqual([{input_hash:keys[0].input_hash}]);
      } finally { await db.query("DROP INDEX idx_engine_v3_ad_evaluations_contract_input"); }
    } finally { await db.end(); }
  });

  it("walks native history across pages/contexts once, rolls back a partial page limit, and removes every owned input", async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    try {
      const target = await seedTenant(db,1);
      const producer = await seedCalibration(db,target,"2026-09-23","2026-09-23T12:00:00Z");
      for (const [tag,count] of [["large-context",4097],["second-context",3]] as const)
        await seedGeneration(db,target,{ date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[count],tag });
      const other=await seedTenant(db,1);
      const otherProducer=await seedCalibration(db,other,"2026-09-23","2026-09-23T12:00:00Z");
      await seedGeneration(db,other,{date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer:otherProducer,perAccount:[2],tag:"foreign-context"});
      const foreign=(await db.query("SELECT * FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY id",[other.business])).rows;
      const before = (await db.query("SELECT id,contract_version,input_hash::text FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY id",[target.business])).rows;
      expect(before).toHaveLength(4100);
      const evaluation=(await db.query("SELECT * FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY id LIMIT 1",[target.business])).rows[0];
      let fkProbeCount=0;
      await expect(runDbTransaction(async () => {
        const sql=getDb();
        await sql.query("SET LOCAL enable_seqscan=off");
        await sql.query("CREATE TEMP TABLE business_erasure_input_keys (contract_version text,input_hash character(64),PRIMARY KEY(contract_version,input_hash)) ON COMMIT DROP");
        // Observe the real transaction settings immediately before its actual
        // page DELETE. This is the RI lookup that timed out in canonical CI when
        // the outer TID optimization also disabled every child's index scan.
        const checkedSql=new Proxy(sql,{get(object,key){
          if(key!=="query")return Reflect.get(object,key);
          return async(text:string,values:unknown[]=[])=>{
            if(text.startsWith("WITH removed AS (DELETE FROM public.engine_v3_ad_decision_evaluations")){
              const columns=["evaluation_id","business_ref_id","provider_account_id","decision_entity_type","decision_entity_id","ad_id","as_of_date","engine_version","scope_type","scope_id","input_hash","decision_hash"];
              const [probe]=await sql.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ONLY public.engine_v3_ad_recommendation_episodes x
                WHERE ${columns.map((column,i)=>`x.${column}=$${i+1}`).join(" AND ")} FOR KEY SHARE OF x`,
              columns.map(column=>evaluation[column==="evaluation_id"?"id":column]));
              const nodes:Record<string,unknown>[]=[];
              const visit=(node:Record<string,unknown>)=>{nodes.push(node);for(const child of (node.Plans??[]) as Record<string,unknown>[])visit(child);};
              visit(probe!["QUERY PLAN"][0].Plan);
              expect(nodes.some(node=>node["Node Type"]==="Seq Scan")).toBe(false);
              expect(nodes.some(node=>node["Node Type"]==="Index Scan" && node["Relation Name"]==="engine_v3_ad_recommendation_episodes"
                && /evaluation_id|business_ref_id/.test(String(node["Index Cond"])))).toBe(true);
              fkProbeCount++;
            }
            return sql.query(text,values);
          };
        }});
        await deleteBusinessNativeEvaluations(checkedSql,target.business,{maxRows:4096});
      })).rejects.toThrow("native_evaluation_page_limit");
      expect(fkProbeCount).toBe(1);
      expect((await db.query("SELECT id,contract_version,input_hash::text FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY id",[target.business])).rows).toEqual(before);
      await addObservedProductionReferenceIndex(db);
      try {
        await deleteBusinessWithData(target.business);
        expect(await remains(target.business)).toBe(false);
        expect(await remains(target.business,"engine_v3_ad_decision_evaluations","business_ref_id")).toBe(false);
        expect((await db.query("SELECT * FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY id",[other.business])).rows).toEqual(foreign);
        const protectedHashes=new Set(foreign.map(r=>String(r.input_hash).trim()));
        const expected=[...new Set(before.filter(r=>protectedHashes.has(r.input_hash)).map(r=>r.input_hash))].sort().map(input_hash=>({input_hash}));
        expect((await db.query("SELECT input_hash::text FROM engine_v3_ad_decision_input_evidence WHERE input_hash=ANY($1::character(64)[]) ORDER BY input_hash",[before.map(r=>r.input_hash)])).rows).toEqual(expected);
      } finally { await db.query("DROP INDEX idx_engine_v3_ad_evaluations_contract_input"); }
    } finally { await db.end(); }
  },60_000);

  it("cancels a statement at its shorter cap, rolls back, and releases its row lock before the overall deadline", async () => {
    const {businessId}=await fixture();
    const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
    try {
      const original=(await db.query("SELECT name FROM businesses WHERE id=$1",[businessId])).rows[0];
      const started=Date.now();
      await expect(runDbTransaction(async()=>{
        await getDb()`UPDATE businesses SET name='must roll back' WHERE id=${businessId}`;
        await getDb().query("SELECT pg_sleep(5)");
      },{timeoutMs:80,deadlineAtMs:Date.now()+10_000})).rejects.toThrow();
      expect(Date.now()-started).toBeLessThan(3000);
      await db.query("BEGIN");
      expect((await db.query("SELECT name FROM businesses WHERE id=$1 FOR UPDATE NOWAIT",[businessId])).rows[0]).toEqual(original);
      await db.query("ROLLBACK");
    } finally { await db.end(); }
  });

  it("erases original creative-grain evidence with a NULL compatibility owner and preserves the other canonical owner", async () => {
    const { businessId, otherId } = await fixture();
    for (const id of [businessId,otherId]) await getDb()`INSERT INTO engine_v3_decision_events
      (business_ref_id,business_id,creative_id,event_date,event_type)
      VALUES (${id},NULL,'legacy-original','2026-10-01','data_disabled')`;
    const before = await getDb()`SELECT * FROM engine_v3_decision_events WHERE business_ref_id=${otherId}`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId,"engine_v3_decision_events","business_ref_id")).toBe(false);
    expect(await getDb()`SELECT * FROM engine_v3_decision_events WHERE business_ref_id=${otherId}`).toEqual(before);
  });

  it("refuses a contradictory compatibility owner in the selected canonical creative history", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO engine_v3_decision_events (business_ref_id,business_id,creative_id,event_date,event_type)
      VALUES (${businessId},${otherId},'legacy-conflict','2026-10-01','data_disabled')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"scope_conflict"});
    expect(await remains(businessId)).toBe(true);
    expect(await remains(otherId)).toBe(true);
  });

  it("removes native operator responses through their validated complete episode ownership, preserving foreign responses", async () => {
    const db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
    try {
      const target = await seedTenant(db,1), other = await seedTenant(db,1);
      for (const [tenant,tag] of [[target,"response-delete"],[other,"response-preserve"]] as const) {
        const producer = await seedCalibration(db,tenant,"2026-09-23","2026-09-23T12:00:00Z");
        const generation = await seedGeneration(db,tenant,{date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[1],tag,snapshots:true});
        const key = randomBytes(32).toString("hex");
        await db.query(`INSERT INTO engine_v3_ad_recommendation_episodes
          (contract_version,episode_key,business_ref_id,business_id,provider_account_ref_id,provider_account_id,
          decision_entity_type,decision_entity_id,ad_id,creative_id,as_of_date,engine_version,scope_type,scope_id,
          decision_snapshot_id,evaluation_id,input_hash,decision_hash,decision_label,recommended_at,captured_at,job_run_id)
          SELECT $1,$2,business_ref_id,business_id,provider_account_ref_id,provider_account_id,
          decision_entity_type,decision_entity_id,ad_id,creative_id,as_of_date,engine_version,scope_type,scope_id,
          id,evaluation_id,input_hash,decision_hash,label,computed_at,computed_at,job_run_id
          FROM engine_v3_ad_decision_snapshots_daily WHERE job_run_id=$3`,[NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,key,generation.jobRunId]);
        await db.query(`INSERT INTO engine_v3_ad_operator_responses
          (contract_version,episode_key,business_ref_id,business_id,provider_account_ref_id,provider_account_id,job_run_id,
          response_cutoff,observation_status,response_type,operator_response_detected,ad_treatment_detected,
          window_start,window_end,window_closed,source_complete,source_set_hash,action_receipt_count,state_observation_count,
          tombstone_observation_count,required_state_target_count,complete_state_target_count,evidence_count,evidence_set_hash,replacement_set_hash,response_hash)
          SELECT contract_version,episode_key,business_ref_id,business_id,provider_account_ref_id,provider_account_id,job_run_id,
          '2026-09-24','unknown_incomplete','unknown_incomplete',false,false,'2026-09-23','2026-09-24',true,false,
          $2,0,0,0,1,0,0,$2,$2,$2 FROM engine_v3_ad_recommendation_episodes WHERE episode_key=$1`,[key,randomBytes(32).toString("hex")]);
      }
      await addObservedProductionReferenceIndex(db);
      try {
        const before = await getDb()`SELECT * FROM engine_v3_ad_operator_responses WHERE business_ref_id=${other.business}`;
        expect(before).toHaveLength(1);
        await deleteBusinessWithData(target.business);
        expect(await remains(target.business,"engine_v3_ad_operator_responses","business_ref_id")).toBe(false);
        expect(await getDb()`SELECT * FROM engine_v3_ad_operator_responses WHERE business_ref_id=${other.business}`).toEqual(before);
      } finally { await db.query("DROP INDEX idx_engine_v3_ad_evaluations_contract_input"); }
    } finally { await db.end(); }
  });

  async function releaseReceipts(businessId: string, otherId: string, year: number) {
    const build = randomUUID();
    await getDb().query(`INSERT INTO sync_release_gates (build_id,environment,gate_kind,gate_scope,mode,base_result,verdict,summary,evidence_json,emitted_at)
      SELECT $1,'fixture','release_gate','release_readiness','measure_only','pass','pass','fixture',
      jsonb_build_object('canaries',jsonb_build_array(jsonb_build_object('businessId',CASE WHEN n=1 THEN $2 WHEN n=1025 THEN upper($2) ELSE $3 END))),
      make_timestamptz($4::int,1,1,0,0,0,'UTC')+n*interval '1 second' FROM generate_series(1,1025) n`,[build,businessId,otherId,year]);
    await getDb().query("UPDATE sync_release_gates SET summary=upper($2) WHERE build_id=$1 AND emitted_at=make_timestamptz($3::int,1,1,0,0,0,'UTC')+interval '512 seconds'",[build,businessId,year]);
    await getDb().query("UPDATE sync_release_gates SET override_reason=upper($2) WHERE build_id=$1 AND emitted_at=make_timestamptz($3::int,1,1,0,0,0,'UTC')+interval '513 seconds'",[build,businessId,year]);
    return build;
  }

  it("erases identifying release receipts across multiple bounded index pages and preserves other receipts byte-for-byte", async () => {
    const { businessId,otherId } = await fixture();
    const build = await releaseReceipts(businessId,otherId,2000);
    const before = await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} AND
      (evidence_json::text ILIKE ${`%${businessId}%`} OR summary ILIKE ${`%${businessId}%`} OR override_reason ILIKE ${`%${businessId}%`}) IS NOT TRUE ORDER BY id`;
    try {
      await deleteBusinessWithData(businessId);
      expect(await getDb()`SELECT 1 FROM sync_release_gates WHERE build_id=${build} AND
        (evidence_json::text ILIKE ${`%${businessId}%`} OR summary ILIKE ${`%${businessId}%`} OR override_reason ILIKE ${`%${businessId}%`}) IS TRUE`).toHaveLength(0);
      expect(await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} ORDER BY id`).toEqual(before);
    } finally { await getDb()`DELETE FROM sync_release_gates WHERE build_id=${build}`; }
  });

  it("rolls back already erased receipt pages when the complete census exceeds its bound", async () => {
    const { businessId,otherId } = await fixture();
    const build = await releaseReceipts(businessId,otherId,1900);
    const before = await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} ORDER BY id`;
    try {
      await expect(runDbTransaction(async()=>{
        await getDb().query("LOCK TABLE sync_release_gates IN SHARE ROW EXCLUSIVE MODE");
        await getDb().query("SET LOCAL enable_seqscan=off");
        await deleteBusinessReleaseReceipts(getDb(),businessId,{maxRows:1024,maxBytes:1024**3});
      })).rejects.toThrow("release_receipt_census_limit");
      expect(await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} ORDER BY id`).toEqual(before);
      expect(await remains(businessId)).toBe(true);
    } finally { await getDb()`DELETE FROM sync_release_gates WHERE build_id=${build}`; }
  });

  it("refuses to persist a stale canary collected before the business was erased", async () => {
    const { businessId } = await fixture();
    await deleteBusinessWithData(businessId);
    await expect(upsertSyncGateRecord({gateKind:"release_gate",gateScope:"release_readiness",buildId:randomUUID(),environment:"fixture",
      mode:"measure_only",baseResult:"pass",verdict:"pass",blockerClass:null,overrideReason:null,summary:"stale canary",breakGlass:false,emittedAt:new Date().toISOString(),
      evidence:{providerScope:"google_ads",canaries:[{businessId}]}})).rejects.toThrow("sync_gate_business_removed");
  });

  it("removes stale worker aliases and JSON-only/runtime copies while preserving foreign observation bytes", async()=>{
    const {businessId,otherId}=await fixture();const sql=getDb();const prefix=randomUUID();
    for (const [suffix,owner,meta] of [["owner",businessId.toUpperCase(),{}],["json",null,{lastConsumedBusinessId:businessId.toUpperCase()}],
      ["foreign",otherId,{currentBusinessId:otherId}]] as const) {
      await sql`INSERT INTO sync_worker_heartbeats(worker_id,instance_type,provider_scope,status,last_heartbeat_at,last_business_id,meta_json)
        VALUES (${prefix+suffix},'fixture','meta','idle',now()-interval '1 hour',${owner},${JSON.stringify(meta)}::jsonb)`;
    }
    const contract=buildRuntimeContract({service:"worker",instanceId:prefix+"runtime"});
    await upsertRuntimeContractInstance({contract:{...contract,config:{...contract.config,releaseCanaryBusinesses:[businessId]}}});
    await sql`UPDATE sync_runtime_instances SET last_seen_at=now()-interval '1 hour' WHERE instance_id=${contract.instanceId}`;
    const foreign=await sql`SELECT * FROM sync_worker_heartbeats WHERE worker_id=${prefix+"foreign"}`;
    await deleteBusinessWithData(businessId);
    expect(await sql`SELECT * FROM sync_worker_heartbeats WHERE worker_id=ANY(${[prefix+"owner",prefix+"json"]}::text[])`).toEqual([]);
    expect(await sql`SELECT * FROM sync_runtime_instances WHERE instance_id=${contract.instanceId}`).toEqual([]);
    expect(await sql`SELECT * FROM sync_worker_heartbeats WHERE worker_id=${prefix+"foreign"}`).toEqual(foreign);
  });

  it("refuses fresh identifying worker presence and rolls the whole business deletion back",async()=>{
    const {businessId}=await fixture();const key=randomUUID();
    await getDb()`INSERT INTO sync_worker_heartbeats(worker_id,instance_type,provider_scope,status,meta_json)
      VALUES(${key},'fixture','meta','running',${JSON.stringify({batchBusinessIds:[businessId]})}::jsonb)`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"control_reference_in_use",tables:["sync_worker_heartbeats"]});
    expect(await remains(businessId)).toBe(true);expect(await remains(businessId,"memberships","business_id")).toBe(true);
    expect(await remains(key,"sync_worker_heartbeats","worker_id")).toBe(true);
  });

  it("rolls an earlier worker-history page back when its finite census bound is exceeded",async()=>{
    const {businessId}=await fixture();const prefix="000-"+randomUUID();const sql=getDb();
    await sql`INSERT INTO sync_worker_heartbeats(worker_id,instance_type,provider_scope,status,last_heartbeat_at,last_business_id)
      SELECT ${prefix}||lpad(g::text,5,'0'),'fixture','meta','idle',now()-interval '1 hour',${businessId} FROM generate_series(1,1025) g`;
    const before=await sql`SELECT * FROM sync_worker_heartbeats WHERE last_business_id=${businessId} ORDER BY worker_id`;
    await expect(runDbTransaction(async()=>{
      await getDb().query("LOCK TABLE sync_worker_heartbeats,sync_runtime_instances IN SHARE ROW EXCLUSIVE MODE");
      await getDb().query("SET LOCAL enable_seqscan=off");
      await deleteBusinessWorkerHistory(getDb(),businessId,{maxRows:1024,maxBytes:512*1024**2});
    })).rejects.toThrow("worker_history_census_limit");
    expect(await sql`SELECT * FROM sync_worker_heartbeats WHERE last_business_id=${businessId} ORDER BY worker_id`).toEqual(before);
  });

  it("allows idle presence erasure and makes a real delayed idle heartbeat anonymous without retaining old names or metrics",async()=>{
    const {businessId,otherId}=await fixture();const workerId=randomUUID();
    const heartbeat={workerId,instanceType:"fixture",providerScope:"meta",status:"idle" as const,lastBusinessId:businessId,lastPartitionId:randomUUID(),
      metaJson:{lastConsumedBusinessId:businessId,batchBusinessIds:[otherId,businessId],oldBusinessName:"Sensitive old fixture",oldMetric:123}};
    await heartbeatSyncWorker(heartbeat);
    await deleteBusinessWithData(businessId);
    expect(await remains(workerId,"sync_worker_heartbeats","worker_id")).toBe(false);
    await heartbeatSyncWorker(heartbeat);
    const [row]=await getDb()`SELECT * FROM sync_worker_heartbeats WHERE worker_id=${workerId}`;
    expect(row).toMatchObject({last_business_id:null,last_partition_id:null,meta_json:{businessAdmitted:false,consumeReason:"business_reference_removed"}});
    expect(JSON.stringify(row)).not.toContain(businessId);
    expect(JSON.stringify(row)).not.toContain("Sensitive old fixture");
    expect(row!.meta_json).not.toHaveProperty("oldMetric");
    expect(await remains(otherId)).toBe(true);
  });

  it("refuses a real delayed running heartbeat instead of reviving removed business execution",async()=>{
    const {businessId}=await fixture();await deleteBusinessWithData(businessId);const workerId=randomUUID();
    await expect(heartbeatSyncWorker({workerId,instanceType:"fixture",providerScope:"meta",status:"running",
      metaJson:{currentBusinessId:businessId}})).rejects.toThrow("control_metadata_business_removed");
    expect(await remains(workerId,"sync_worker_heartbeats","worker_id")).toBe(false);
  });

  it("refuses a fresh runtime canary reference with the specific configuration blocker and preserves the business",async()=>{
    const {businessId}=await fixture();const contract=buildRuntimeContract({service:"worker",instanceId:randomUUID()});
    await upsertRuntimeContractInstance({contract:{...contract,config:{...contract.config,releaseCanaryBusinesses:[businessId]}}});
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"control_reference_in_use",tables:["sync_runtime_instances"]});
    expect(await remains(businessId)).toBe(true);
  });

  it("refuses the real delayed runtime writer with a removed canary business",async()=>{
    const {businessId}=await fixture();const contract=buildRuntimeContract({service:"worker",instanceId:randomUUID()});
    await deleteBusinessWithData(businessId);
    await expect(upsertRuntimeContractInstance({contract:{...contract,config:{...contract.config,releaseCanaryBusinesses:[businessId]}}}))
      .rejects.toThrow("control_metadata_business_removed");
    expect(await remains(contract.instanceId,"sync_runtime_instances","instance_id")).toBe(false);
  });
});
