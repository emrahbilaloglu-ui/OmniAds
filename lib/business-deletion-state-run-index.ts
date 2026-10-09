type CatalogSql = { query(text: string, params?: unknown[]): Promise<unknown> };

export const BUSINESS_ERASURE_STATE_RUN_INDEX = "idx_biz_erase_state_run_lineage";
export const BUSINESS_ERASURE_STATE_RUN_KEYS = [
  "run_id", "business_ref_id", "provider_account_ref_id", "entity_type", "captured_at", "run_completeness",
] as const;
export const BUSINESS_ERASURE_STATE_RUN_BOUNDS = [
  "(entity_type = ANY (ARRAY['campaign'::text, 'adset'::text, 'ad'::text, 'creative'::text]))",
  "(run_completeness = ANY (ARRAY['complete'::text, 'partial'::text, 'point_lookup'::text]))",
] as const;

/** Only fixed UUID/time keys and two exact validated enum checks enter the index.
 * The remaining text identity predicates are still rechecked by the full FK. */
export const BUSINESS_ERASURE_STATE_RUN_STATUS_SQL = `
 WITH target AS (SELECT c.oid,c.relkind,c.relispartition
   FROM pg_class c WHERE c.oid=to_regclass('public.meta_entity_state_history')),
 keys AS (SELECT k.name,k.ord,a.attnum,a.atttypid,a.attnotnull,a.attcollation
   FROM target c CROSS JOIN unnest($1::text[]) WITH ORDINALITY k(name,ord)
   LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=k.name AND a.attnum>0 AND NOT a.attisdropped),
 usable AS (SELECT i.indexrelid,i.indnkeyatts,i.indnatts,ix.reloptions
   FROM target c JOIN pg_index i ON i.indrelid=c.oid
   JOIN pg_class ix ON ix.oid=i.indexrelid JOIN pg_am am ON am.oid=ix.relam
   WHERE am.amname='btree' AND i.indisvalid AND i.indisready AND i.indislive
     AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts>=6
     AND NOT EXISTS(SELECT 1 FROM keys k
       LEFT JOIN pg_opclass op ON op.oid=i.indclass[(k.ord-1)::int]
       WHERE i.indkey[(k.ord-1)::int] IS DISTINCT FROM k.attnum
         OR op.opcdefault IS DISTINCT FROM true
         OR i.indcollation[(k.ord-1)::int] IS DISTINCT FROM k.attcollation))
 SELECT c.relkind='r' AND NOT c.relispartition AND current_setting('block_size')='8192'
   AND NOT EXISTS(SELECT 1 FROM keys k LEFT JOIN pg_collation co ON co.oid=k.attcollation
     WHERE k.atttypid=25 AND co.collisdeterministic IS DISTINCT FROM true)
   AND (SELECT count(*)=6 AND bool_and(attnotnull) AND
     array_agg(atttypid::int ORDER BY ord)=ARRAY[2950,2950,2950,25,1184,25] FROM keys) AS shape_valid,
   (SELECT count(DISTINCT pg_get_expr(f.conbin,f.conrelid))=2 FROM pg_constraint f
     WHERE f.conrelid=c.oid AND f.contype='c' AND f.convalidated AND NOT f.connoinherit
       AND pg_get_expr(f.conbin,f.conrelid)=ANY($2::text[])) AS bounds_valid,
   EXISTS(SELECT 1 FROM pg_constraint f WHERE f.conrelid=c.oid AND f.contype='f'
     AND f.conname='meta_entity_state_history_run_fk' AND f.convalidated
     AND f.confrelid='public.meta_entity_observation_runs'::regclass AND f.confdeltype='r'
     AND NOT f.condeferrable
     AND ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY x(n,o)
       JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=x.n ORDER BY x.o)
       =ARRAY['run_id','business_ref_id','business_id','provider_account_ref_id','provider_account_id','entity_type','captured_at','run_completeness']
     AND ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY x(n,o)
       JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=x.n ORDER BY x.o)
       =ARRAY['id','business_ref_id','business_id','provider_account_ref_id','provider_account_id','entity_type','captured_at','completeness']
     AND (SELECT count(*)=4 AND bool_and(t.tgisinternal AND t.tgenabled IN ('O','A'))
       FROM pg_trigger t WHERE t.tgconstraint=f.oid)) AS lineage_valid,
   EXISTS(SELECT 1 FROM usable) AS lookup_ready,
   EXISTS(SELECT 1 FROM pg_class named WHERE named.oid=to_regclass('public.idx_biz_erase_state_run_lineage')
     AND NOT EXISTS(SELECT 1 FROM usable u WHERE u.indexrelid=named.oid AND u.indnkeyatts=6 AND u.indnatts=6
       AND (u.reloptions IS NULL OR u.reloptions=ARRAY['fillfactor=90']))) AS named_index_conflict
 FROM target c`;

type StateRunCatalog = {
  shape_valid: boolean; bounds_valid: boolean; lineage_valid: boolean;
  lookup_ready: boolean; named_index_conflict: boolean;
};
export async function readBusinessErasureStateRunContract(sql: CatalogSql) {
  const rows = await sql.query(BUSINESS_ERASURE_STATE_RUN_STATUS_SQL,
    [[...BUSINESS_ERASURE_STATE_RUN_KEYS], [...BUSINESS_ERASURE_STATE_RUN_BOUNDS]]) as StateRunCatalog[];
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || row.shape_valid !== true || row.bounds_valid !== true || row.lineage_valid !== true
    || typeof row.lookup_ready !== "boolean" || row.named_index_conflict !== false) {
    throw new Error("business_erasure_state_run_index_contract");
  }
  return row;
}

/** No drop/rebuild and no data scan; only this reviewed missing index is added. */
export async function ensureBusinessErasureStateRunIndex(
  sql: CatalogSql, admit: () => Promise<unknown>,
) {
  if ((await readBusinessErasureStateRunContract(sql)).lookup_ready) return { built: false, index: BUSINESS_ERASURE_STATE_RUN_INDEX };
  await admit();
  await sql.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${BUSINESS_ERASURE_STATE_RUN_INDEX}
    ON public.meta_entity_state_history (${BUSINESS_ERASURE_STATE_RUN_KEYS.join(", ")}) WITH (fillfactor=90)`);
  if (!(await readBusinessErasureStateRunContract(sql)).lookup_ready) throw new Error("business_erasure_state_run_index_not_ready");
  return { built: true, index: BUSINESS_ERASURE_STATE_RUN_INDEX };
}
