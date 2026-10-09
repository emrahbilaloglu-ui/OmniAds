import type { getDb } from "@/lib/db";
import { BUSINESS_PROVIDER_ACCOUNT_CAPTURE_CTE } from "@/lib/business-deletion-provider-accounts";

export class BusinessNativeEvaluationCleanupError extends Error {}
const PAGE = 4096;
const TABLE = "engine_v3_ad_decision_evaluations";
const CURSOR = "business_erasure_native_evaluations";
const DECLARE = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR
  SELECT ctid::text AS row_tid,tableoid::text AS row_table FROM public.${TABLE} WHERE business_ref_id=$1::uuid`;

/** Called at the evaluation table's child-first position, with all writer locks
 * held and reviewed DELETE guards suspended. One non-holdable cursor walks the
 * owned index once; FETCH cannot sort/materialize the entire history or restart
 * from its first deleted tuple. Exact TID deletes capture inputs as they disappear.
 * A failed page/bound/FK rolls the caller's whole transaction back. */
export async function deleteBusinessNativeEvaluations(sql: ReturnType<typeof getDb>, businessId: string,
  bounds = { maxRows: 4_194_304 }, captureProviderAccounts = false) {
  const [settings] = await sql.query<{ index: string; bitmap: string }>(
    "SELECT current_setting('enable_indexscan') AS index,current_setting('enable_bitmapscan') AS bitmap");
  await sql.query("SET LOCAL enable_indexscan=on");
  await sql.query("SET LOCAL enable_bitmapscan=off");
  const indexes = await sql.query<{ name: string; table_oid: string }>(`SELECT ic.relname AS name,tc.oid::text AS table_oid
    FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    JOIN pg_opclass op ON op.oid=i.indclass[0] JOIN pg_class tc ON tc.oid=i.indrelid
    WHERE i.indrelid='public.${TABLE}'::regclass AND am.amname='btree'
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
      AND op.opcdefault AND i.indcollation[0]=a.attcollation AND a.attnotnull
      AND NOT tc.relrowsecurity AND NOT tc.relforcerowsecurity AND tc.relkind='r' AND a.attname='business_ref_id'`);
  const verifyOwner = (plan: Record<string, unknown>) => {
    // No Sort/Bitmap/Materialize/Gather node may consume an unbounded prefix.
    if (!["Index Scan", "Index Only Scan"].includes(String(plan["Node Type"]))
      || plan["Relation Name"] !== TABLE
      || !indexes.some(i=>i.name===plan["Index Name"])
      || !/business_ref_id\s*=/.test(String(plan["Index Cond"])))
      throw new BusinessNativeEvaluationCleanupError("native_evaluation_page_plan");
  };
  const [plan] = await sql.query(`EXPLAIN (FORMAT JSON) ${DECLARE}`,[businessId]);
  verifyOwner(plan!["QUERY PLAN"][0].Plan);
  await sql.query(DECLARE,[businessId]);
  // The non-indexable owner residual below keeps the outer DELETE on its exact
  // TIDs. Keep index scans available to PostgreSQL's internal FK probes: turning
  // them off here also forces a child-table scan for every removed evaluation.
  const tableOid=indexes[0]!.table_oid;
  let rows = 0, pages = 0;
  for (;;) {
    const page = await sql.query<{ row_tid: string; row_table: string }>(`FETCH FORWARD ${PAGE} FROM ${CURSOR}`);
    rows += page.length;
    if (rows>bounds.maxRows) throw new BusinessNativeEvaluationCleanupError("native_evaluation_page_limit");
    if (page.some(r=>r.row_table!==tableOid)) throw new BusinessNativeEvaluationCleanupError("native_evaluation_heap_changed");
    if (!page.length) break;
    const query = `WITH removed AS (DELETE FROM public.${TABLE}
      WHERE ctid=ANY($1::tid[]) AND tableoid=$2::oid AND business_ref_id::text=($3::uuid)::text
      RETURNING contract_version,input_hash${captureProviderAccounts ? ",provider_account_ref_id AS account_id" : ""}),
      captured AS (INSERT INTO business_erasure_input_keys (contract_version,input_hash)
        SELECT contract_version,input_hash FROM removed ON CONFLICT DO NOTHING RETURNING 1)
      ${captureProviderAccounts ? BUSINESS_PROVIDER_ACCOUNT_CAPTURE_CTE : ""}
      SELECT (SELECT count(*)::int FROM removed) AS removed,(SELECT count(*)::int FROM captured) AS captured`;
    const values=[page.map(r=>r.row_tid),tableOid,businessId];
    const [deletePlan] = await sql.query(`EXPLAIN (FORMAT JSON) ${query}`,values);
    let found = false;
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === TABLE && node["Node Type"] !== "ModifyTable") {
        if (node["Node Type"]!=="Tid Scan" || !/ctid.*ANY/.test(String(node["TID Cond"])))
          throw new BusinessNativeEvaluationCleanupError("native_evaluation_delete_plan");
        found=true;
      }
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    walk(deletePlan!["QUERY PLAN"][0].Plan);
    if (!found) throw new BusinessNativeEvaluationCleanupError("native_evaluation_delete_plan");
    const [deleted] = await sql.query<{ removed: number }>(query,values);
    if (deleted?.removed!==page.length) throw new BusinessNativeEvaluationCleanupError("native_evaluation_delete_mismatch");
    pages++;
  }
  await sql.query(`CLOSE ${CURSOR}`);
  await sql.query("SELECT set_config('enable_indexscan',$1,true),set_config('enable_bitmapscan',$2,true)",[settings!.index,settings!.bitmap]);
  return { rows, pages, complete:true as const };
}
