import type { getDb } from "@/lib/db";

export class BusinessControlReceiptCleanupError extends Error {}
const PAGE = 1024;

/** Global release receipts have no business ownership column. Inspect finite,
 * ordered index pages under the caller's writer-exclusion transaction. Never
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
  // A Bitmap Heap Scan followed by Sort could consume the entire remaining
  // range before LIMIT. Require the ordered index walk on every page instead.
  await sql.query("SET LOCAL enable_bitmapscan=off");
  let cursor: { at: string; id: string } | undefined, rows = 0, bytes = 0, removed = 0;
  for (;;) {
    const where = cursor ? "WHERE (emitted_at,id)>($2::timestamptz,$3::uuid)" : "";
    const query = `WITH page AS MATERIALIZED (SELECT id,emitted_at,evidence_json,summary,override_reason
      FROM public.sync_release_gates ${where} ORDER BY emitted_at,id LIMIT ${PAGE})
      SELECT id::text, emitted_at::text AS at,
        octet_length(evidence_json::text)+octet_length(coalesce(summary,''))+octet_length(coalesce(override_reason,'')) AS bytes,
        (evidence_json::text LIKE ('%'||$1::text||'%') OR summary LIKE ('%'||$1::text||'%')
          OR override_reason LIKE ('%'||$1::text||'%')) IS TRUE AS owned FROM page ORDER BY emitted_at,id`;
    const values = cursor ? [businessId,cursor.at,cursor.id] : [businessId];
    const plan = await sql.query(`EXPLAIN (FORMAT JSON) ${query}`, values);
    let indexed = false;
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === "sync_release_gates") {
        if (node["Node Type"] !== "Index Scan" || !indexes.some(i => i.name===node["Index Name"])
          || cursor && !String(node["Index Cond"]).includes("ROW(emitted_at, id)"))
          throw new BusinessControlReceiptCleanupError("release_receipt_plan_not_bounded");
        indexed = true;
      }
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    walk(plan[0]!["QUERY PLAN"][0].Plan);
    if (!indexed) throw new BusinessControlReceiptCleanupError("release_receipt_plan_missing");
    const page = await sql.query<{ id: string; at: string; bytes: number; owned: boolean }>(query, values);
    rows += page.length; bytes += page.reduce((n,r)=>n+Number(r.bytes),0);
    if (rows>bounds.maxRows || bytes>bounds.maxBytes) throw new BusinessControlReceiptCleanupError("release_receipt_census_limit");
    const ids = page.filter(r=>r.owned).map(r=>r.id);
    if (ids.length) {
      const deleted = await sql.query<{ id: string }>("DELETE FROM public.sync_release_gates WHERE id=ANY($1::uuid[]) RETURNING id",[ids]);
      if (deleted.length!==ids.length) throw new BusinessControlReceiptCleanupError("release_receipt_delete_mismatch");
      removed += deleted.length;
    }
    if (page.length<PAGE) {
      await sql.query("SELECT set_config('enable_bitmapscan',$1,true)",[settings!.bitmap]);
      return { rows, bytes, removed, complete: true as const };
    }
    const last = page[page.length-1]!; cursor = { at:last.at,id:last.id };
  }
}
