import type { getDb } from "@/lib/db";

export class BusinessControlReceiptCleanupError extends Error {}
const PAGE = 1024;

/** Active worker/configuration observations refuse erasure; stale/idle observations are
 * invalidated in finite ordered PK pages under the caller's writer exclusion. */
export async function deleteBusinessWorkerHistory(sql: ReturnType<typeof getDb>, businessId: string,
  bounds = { maxRows: 100_000, maxBytes: 512 * 1024 ** 2 }) {
  const [settings] = await sql.query<{ bitmap: string }>("SELECT current_setting('enable_bitmapscan') AS bitmap");
  await sql.query("SET LOCAL enable_bitmapscan=off");
  const stores = [
    { table: "sync_worker_heartbeats", key: "worker_id", json: "meta_json", clock: "last_heartbeat_at", owner: "last_business_id" },
    { table: "sync_runtime_instances", key: "instance_id", json: "contract_json", clock: "last_seen_at", owner: null },
  ] as const;
  const receipts = [];
  for (const store of stores) {
    const indexes = await sql.query<{ name: string }>(`SELECT ic.relname name FROM pg_index i
      JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
      JOIN pg_class t ON t.oid=i.indrelid
      WHERE i.indrelid=$1::regclass AND am.amname='btree' AND a.attname=$2 AND i.indoption[0]=0
        AND i.indisprimary AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
        AND NOT t.relrowsecurity AND NOT t.relforcerowsecurity`, [`public.${store.table}`, store.key]);
    if (!indexes.length) throw new BusinessControlReceiptCleanupError("worker_history_index_missing");
    let cursor: string | undefined, rows = 0, bytes = 0, removed = 0;
    for (;;) {
      const where = cursor ? `WHERE ${store.key}>$2::text` : "";
      const owner = store.owner ? ` OR lower(${store.owner})=lower($1::text)` : "";
      const ownerBytes = store.owner ? `+octet_length(coalesce(${store.owner},''))` : "";
      const active = store.owner ? " AND status IN ('starting','running')" : "";
      const query = `WITH page AS MATERIALIZED (SELECT * FROM public.${store.table} ${where} ORDER BY ${store.key} LIMIT ${PAGE})
        SELECT ${store.key} key, octet_length(${store.json}::text)${ownerBytes} bytes,
          (${store.json}::text ILIKE ('%'||$1::text||'%')${owner}) IS TRUE owned,
          (${store.clock}>=now()-interval '5 minutes'${active}) fresh FROM page ORDER BY ${store.key}`;
      const values = cursor ? [businessId, cursor] : [businessId];
      const plan = await sql.query(`EXPLAIN (FORMAT JSON) ${query}`, values);
      let indexed = false;
      const walk = (node: Record<string, unknown>) => {
        if (node["Relation Name"] === store.table) {
          if (node["Node Type"] !== "Index Scan" || !indexes.some(i=>i.name===node["Index Name"])
            || cursor && !String(node["Index Cond"]).includes(store.key))
            throw new BusinessControlReceiptCleanupError("worker_history_plan_not_bounded");
          indexed = true;
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
      };
      walk(plan[0]!["QUERY PLAN"][0].Plan);
      if (!indexed) throw new BusinessControlReceiptCleanupError("worker_history_plan_missing");
      const page = await sql.query<{ key: string; bytes: number; owned: boolean; fresh: boolean }>(query, values);
      rows += page.length; bytes += page.reduce((n,r)=>n+Number(r.bytes),0);
      if (rows>bounds.maxRows || bytes>bounds.maxBytes) throw new BusinessControlReceiptCleanupError("worker_history_census_limit");
      if (page.some(r=>r.owned&&r.fresh)) throw new BusinessControlReceiptCleanupError("control_history_active:"+store.table);
      const keys = page.filter(r=>r.owned).map(r=>r.key);
      if (keys.length) {
        const deleted = await sql.query(`DELETE FROM public.${store.table} WHERE ${store.key}=ANY($1::text[]) RETURNING ${store.key}`, [keys]);
        if (deleted.length!==keys.length) throw new BusinessControlReceiptCleanupError("worker_history_delete_mismatch");
        removed += deleted.length;
      }
      if (page.length<PAGE) { receipts.push({ table:store.table, rows, bytes, removed, complete:true }); break; }
      cursor = page[page.length-1]!.key;
    }
  }
  await sql.query("SELECT set_config('enable_bitmapscan',$1,true)",[settings!.bitmap]);
  return receipts;
}

/** Global release receipts have no business ownership column. Inspect finite,
 * ordered cursor pages under the caller's writer-exclusion transaction. Never
 * issue a global JSON DELETE/Seq Scan, or report completion after a partial census.
 * Only identifying derived receipts are invalidated; other receipts stay intact.
 */
export async function deleteBusinessReleaseReceipts(sql: ReturnType<typeof getDb>, businessId: string,
  bounds = { maxRows: 1_048_576, maxBytes: 4 * 1024 ** 3 }) {
  const indexes = await sql.query<{ name: string }>(`SELECT ic.relname AS name FROM pg_index i
    JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    JOIN pg_attribute b ON b.attrelid=i.indrelid AND b.attnum=i.indkey[1]
    WHERE i.indrelid='public.sync_release_gates'::regclass AND am.amname='btree'
      AND a.attname='emitted_at' AND b.attname='id' AND i.indoption[0]=0 AND i.indoption[1]=0
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
      AND NOT EXISTS (SELECT 1 FROM pg_class t WHERE t.oid=i.indrelid AND (t.relrowsecurity OR t.relforcerowsecurity))`);
  if (!indexes.length) throw new BusinessControlReceiptCleanupError("release_receipt_index_missing");
  const [settings] = await sql.query<{ bitmap: string }>("SELECT current_setting('enable_bitmapscan') AS bitmap");
  // Pin one ordered walk. Re-planning a keyset page and serializing evidence
  // twice for each of hundreds of pages exhausted the live HTTP deadline.
  await sql.query("SET LOCAL enable_bitmapscan=off");
  const cursor = "business_erasure_release_receipts";
  // OFFSET 0 keeps the lateral projection from being flattened: the JSON
  // text is made once per row and reused by both length and ownership checks.
  // It introduces no sort/materialization of the global receipt history.
  const declare = `DECLARE ${cursor} NO SCROLL CURSOR FOR
    SELECT r.id::text,r.emitted_at::text AS at,
      octet_length(e.evidence_text)+octet_length(coalesce(r.summary,''))+octet_length(coalesce(r.override_reason,'')) AS bytes,
      (e.evidence_text ILIKE ('%'||$1::text||'%') OR r.summary ILIKE ('%'||$1::text||'%')
        OR r.override_reason ILIKE ('%'||$1::text||'%')) IS TRUE AS owned
    FROM public.sync_release_gates r
    CROSS JOIN LATERAL (SELECT r.evidence_json::text AS evidence_text OFFSET 0) e ORDER BY r.emitted_at,r.id`;
  const plan = await sql.query(`EXPLAIN (FORMAT JSON) ${declare}`, [businessId]);
  let indexed = false;
  const walk = (node: Record<string, unknown>) => {
    if (["Sort", "Incremental Sort", "Materialize", "CTE Scan", "Gather", "Gather Merge"].includes(String(node["Node Type"])))
      throw new BusinessControlReceiptCleanupError("release_receipt_plan_not_bounded");
    if (node["Relation Name"] === "sync_release_gates") {
      if (node["Node Type"] !== "Index Scan" || !indexes.some(i => i.name===node["Index Name"]))
        throw new BusinessControlReceiptCleanupError("release_receipt_plan_not_bounded");
      indexed = true;
    }
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
  };
  walk(plan[0]!["QUERY PLAN"][0].Plan);
  if (!indexed) throw new BusinessControlReceiptCleanupError("release_receipt_plan_missing");
  await sql.query(declare, [businessId]);
  let rows = 0, bytes = 0, removed = 0;
  for (;;) {
    const page = await sql.query<{ id: string; at: string; bytes: number; owned: boolean }>(`FETCH FORWARD ${PAGE} FROM ${cursor}`);
    rows += page.length; bytes += page.reduce((n,r)=>n+Number(r.bytes),0);
    if (rows>bounds.maxRows || bytes>bounds.maxBytes) throw new BusinessControlReceiptCleanupError("release_receipt_census_limit");
    const ids = page.filter(r=>r.owned).map(r=>r.id);
    if (ids.length) {
      const deleted = await sql.query<{ id: string }>("DELETE FROM public.sync_release_gates WHERE id=ANY($1::uuid[]) RETURNING id",[ids]);
      if (deleted.length!==ids.length) throw new BusinessControlReceiptCleanupError("release_receipt_delete_mismatch");
      removed += deleted.length;
    }
    if (page.length<PAGE) {
      await sql.query(`CLOSE ${cursor}`);
      await sql.query("SELECT set_config('enable_bitmapscan',$1,true)",[settings!.bitmap]);
      return { rows, bytes, removed, complete: true as const };
    }
  }
}
