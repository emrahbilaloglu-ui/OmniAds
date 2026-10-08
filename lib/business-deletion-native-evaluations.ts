import type { getDb } from "@/lib/db";

export class BusinessNativeEvaluationCleanupError extends Error {}
const PAGE = 1024;
const TABLE = "engine_v3_ad_decision_evaluations";
const CURSOR = "business_erasure_native_evaluations";
const DECLARE = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR SELECT id FROM public.${TABLE}
  WHERE business_ref_id=$1::uuid ORDER BY provider_account_ref_id,provider_account_id,
  decision_entity_type,decision_entity_id,as_of_date DESC,evaluated_at DESC`;

/** Called at the evaluation table's child-first position, with all writer locks
 * held and reviewed DELETE guards suspended. One non-holdable cursor walks the
 * owned index once; FETCH cannot sort/materialize the entire history or restart
 * from its first deleted tuple. Exact PK deletes capture inputs as they disappear.
 * A failed page/bound/FK rolls the caller's whole transaction back. */
export async function deleteBusinessNativeEvaluations(sql: ReturnType<typeof getDb>, businessId: string,
  bounds = { maxRows: 4_194_304 }) {
  const [settings] = await sql.query<{ bitmap: string }>("SELECT current_setting('enable_bitmapscan') AS bitmap");
  await sql.query("SET LOCAL enable_bitmapscan=off");
  const indexes = await sql.query<{ name: string; leading: string }>(`SELECT ic.relname AS name,a.attname AS leading
    FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    JOIN pg_opclass op ON op.oid=i.indclass[0] JOIN pg_class tc ON tc.oid=i.indrelid
    WHERE i.indrelid='public.${TABLE}'::regclass AND am.amname='btree'
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
      AND op.opcdefault AND i.indcollation[0]=a.attcollation AND a.attnotnull
      AND NOT tc.relrowsecurity AND NOT tc.relforcerowsecurity AND a.attname IN ('business_ref_id','id')`);
  const verify = (plan: Record<string, unknown>, leading: string) => {
    // No Sort/Bitmap/Materialize/Gather node may consume an unbounded prefix.
    if (!["Index Scan", "Index Only Scan"].includes(String(plan["Node Type"]))
      || plan["Relation Name"] !== TABLE
      || !indexes.some(i=>i.name===plan["Index Name"] && i.leading===leading)
      || !String(plan["Index Cond"]).includes(leading))
      throw new BusinessNativeEvaluationCleanupError("native_evaluation_page_plan");
  };
  const [plan] = await sql.query(`EXPLAIN (FORMAT JSON) ${DECLARE}`,[businessId]);
  verify(plan!["QUERY PLAN"][0].Plan,"business_ref_id");
  await sql.query(DECLARE,[businessId]);
  let rows = 0, pages = 0;
  for (;;) {
    const page = await sql.query<{ id: string }>(`FETCH FORWARD ${PAGE} FROM ${CURSOR}`);
    rows += page.length;
    if (rows>bounds.maxRows) throw new BusinessNativeEvaluationCleanupError("native_evaluation_page_limit");
    if (!page.length) break;
    const ids = page.map(r=>r.id);
    const query = `WITH removed AS (DELETE FROM public.${TABLE}
      -- Ownership is a residual check over the exact PK page, so the planner
      -- cannot replace the bounded id probes with another whole-owner scan.
      WHERE id=ANY($1::uuid[]) AND business_ref_id::text=($2::uuid)::text RETURNING contract_version,input_hash),
      captured AS (INSERT INTO business_erasure_input_keys (contract_version,input_hash)
        SELECT contract_version,input_hash FROM removed ON CONFLICT DO NOTHING RETURNING 1)
      SELECT (SELECT count(*)::int FROM removed) AS removed,(SELECT count(*)::int FROM captured) AS captured`;
    const [deletePlan] = await sql.query(`EXPLAIN (FORMAT JSON) ${query}`,[ids,businessId]);
    let found = false;
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === TABLE && node["Node Type"] !== "ModifyTable") { verify(node,"id"); found=true; }
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    walk(deletePlan!["QUERY PLAN"][0].Plan);
    if (!found) throw new BusinessNativeEvaluationCleanupError("native_evaluation_delete_plan");
    const [deleted] = await sql.query<{ removed: number }>(query,[ids,businessId]);
    if (deleted?.removed!==page.length) throw new BusinessNativeEvaluationCleanupError("native_evaluation_delete_mismatch");
    pages++;
  }
  await sql.query(`CLOSE ${CURSOR}`);
  await sql.query("SELECT set_config('enable_bitmapscan',$1,true)",[settings!.bitmap]);
  return { rows, pages, complete:true as const };
}
