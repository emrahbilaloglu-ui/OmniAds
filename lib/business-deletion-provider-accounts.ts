import type { getDb } from "@/lib/db";

export class BusinessProviderAccountCleanupError extends Error {}
type Sql = ReturnType<typeof getDb>;
type Reference = {
  child: string; table_name: string; account_key: string; key_type: number;
  relation_kind: string; partition: boolean; row_security: boolean;
  heap_bytes: string; enabled_triggers: number; definition: string;
  constraint_name: string; leading_indexes: string[]; uuid_equality: boolean;
  validated: boolean; deferrable: boolean; initially_deferred: boolean;
};
const MAX_ROOTS = 256, MAX_CANDIDATES = 128, MAX_REFERENCES = 256;
const SMALL_HEAP = 1024 * 1024;
const candidates = "business_erasure_provider_candidates";
function quoted(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new BusinessProviderAccountCleanupError("provider_identifier");
  return `"${name}"`;
}
function qualified(name: string) { return name.split(".").map(quoted).join("."); }
const CATALOG = `SELECT n.nspname||'.'||c.relname AS child,c.relname AS table_name,
  a.attname AS account_key,a.atttypid::int AS key_type,c.relkind AS relation_kind,
  c.relispartition AS partition,c.relrowsecurity OR c.relforcerowsecurity AS row_security,
  pg_relation_size(c.oid)::text AS heap_bytes,f.conname AS constraint_name,
  pg_get_constraintdef(f.oid) AS definition,f.convalidated AS validated,
  f.condeferrable AS deferrable,f.condeferred AS initially_deferred,
  EXISTS(SELECT 1 FROM pg_operator o WHERE o.oid=f.conpfeqop[array_position(f.confkey,
    (SELECT attnum FROM pg_attribute WHERE attrelid=f.confrelid AND attname='id'))]
    AND o.oprnamespace='pg_catalog'::regnamespace AND o.oprname='='
    AND o.oprleft=2950 AND o.oprright=2950) AS uuid_equality,
  (SELECT count(*)::int FROM pg_trigger t WHERE t.tgconstraint=f.oid
    AND t.tgisinternal AND t.tgenabled IN ('O','A')) AS enabled_triggers,
  ARRAY(SELECT ix.relname FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    JOIN pg_am am ON am.oid=ix.relam JOIN pg_opclass op ON op.oid=i.indclass[0]
    WHERE i.indrelid=c.oid AND am.amname='btree' AND i.indisvalid AND i.indisready
      AND i.indislive AND i.indexprs IS NULL AND i.indnkeyatts>=1
      AND i.indkey[0]=a.attnum AND op.opcdefault AND i.indcollation[0]=a.attcollation
      AND (i.indpred IS NULL OR pg_get_expr(i.indpred,i.indrelid)='('||a.attname||' IS NOT NULL)')
    ORDER BY ix.relname) AS leading_indexes
  FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=f.conkey[array_position(f.confkey,
    (SELECT attnum FROM pg_attribute WHERE attrelid=f.confrelid AND attname='id'))]
  WHERE f.contype='f' AND f.confrelid='public.provider_accounts'::regclass
  ORDER BY n.nspname,c.relname,f.conname LIMIT 257`;

function verifyProbe(reference: Reference, plan: Record<string, unknown>) {
  if (Number(reference.heap_bytes) <= SMALL_HEAP) return;
  let found = false;
  const walk = (node: Record<string, unknown>) => {
    if (node["Relation Name"] === reference.table_name && node["Node Type"] !== "ModifyTable") {
      if (!["Index Scan","Index Only Scan"].includes(String(node["Node Type"]))
        || !reference.leading_indexes.includes(String(node["Index Name"]))
        || !new RegExp(`(?:^|[^a-z0-9_])${reference.account_key}\\s*=`).test(String(node["Index Cond"]))) {
        throw new BusinessProviderAccountCleanupError(`provider_reference_plan:${reference.child}`);
      }
      found = true;
    }
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
  };
  walk(plan);
  if (!found) throw new BusinessProviderAccountCleanupError(`provider_reference_plan:${reference.child}`);
}

export const BUSINESS_PROVIDER_ACCOUNT_CAPTURE_CTE = `, captured_provider AS
  (INSERT INTO business_erasure_provider_candidates (id)
    SELECT DISTINCT account_id FROM removed WHERE account_id IS NOT NULL
    ON CONFLICT DO NOTHING RETURNING id)`;

export function businessProviderAccountDeleteSql(query: string, accountKey?: string) {
  if (!accountKey) return query;
  return `WITH removed AS (${query} RETURNING ${quoted(accountKey)} AS account_id)
    ${BUSINESS_PROVIDER_ACCOUNT_CAPTURE_CTE} SELECT count(*)::int AS removed FROM removed`;
}

/** Capture only the selected parent's inherited rows before its CASCADE.
 * Parent IDs come from the caller's checked owner lookup. UUIDs are read in
 * finite cursor pages; a large child must use its actual leading parent index. */
async function captureInherited(sql: Sql, reference: Reference, parentKey: string, parentIds: string[]) {
  const [key] = await sql.query<{ indexes:string[]; valid_parent:boolean }>(`SELECT
    ARRAY(SELECT ix.relname FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
      JOIN pg_am am ON am.oid=ix.relam JOIN pg_opclass op ON op.oid=i.indclass[0]
      WHERE i.indrelid=a.attrelid AND am.amname='btree' AND i.indisvalid AND i.indisready
        AND i.indislive AND i.indexprs IS NULL AND i.indpred IS NULL
        AND i.indnkeyatts>=1 AND i.indkey[0]=a.attnum AND op.opcdefault
        AND i.indcollation[0]=a.attcollation ORDER BY ix.relname) AS indexes,
    EXISTS(SELECT 1 FROM pg_constraint f WHERE f.conrelid=a.attrelid AND f.contype='f'
      AND f.conkey=ARRAY[a.attnum] AND f.confdeltype='c' AND f.convalidated
      AND NOT f.condeferrable AND NOT f.condeferred) AS valid_parent
    FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attname=$2
      AND a.atttypid=2950 AND a.attnotnull`,[reference.child,parentKey]);
  if (!key?.valid_parent || Number(reference.heap_bytes)>SMALL_HEAP && !key.indexes.length)
    throw new BusinessProviderAccountCleanupError(`provider_inherited_contract:${reference.child}`);
  let rows=0;
  for (const parentId of parentIds) {
    const declare=`DECLARE business_erasure_inherited_accounts NO SCROLL CURSOR FOR
      SELECT ${quoted(reference.account_key)}::text AS id FROM ONLY ${qualified(reference.child)}
      WHERE ${quoted(parentKey)}=$1::uuid`;
    const [plan]=await sql.query(`EXPLAIN (FORMAT JSON) ${declare}`,[parentId]);
    verifyProbe({...reference,account_key:parentKey,leading_indexes:key.indexes},plan!["QUERY PLAN"][0].Plan);
    await sql.query(declare,[parentId]);
    for (;;) {
      const page=await sql.query<{id:string|null}>("FETCH FORWARD 4096 FROM business_erasure_inherited_accounts");
      rows+=page.length;
      if(rows>4_194_304) throw new BusinessProviderAccountCleanupError("provider_inherited_bound");
      if(!page.length) break;
      await sql.query(`INSERT INTO ${candidates} (id) SELECT DISTINCT id FROM unnest($1::uuid[]) x(id)
        WHERE id IS NOT NULL ON CONFLICT DO NOTHING`,[page.map(r=>r.id)]);
      if((await sql.query(`SELECT id FROM ${candidates} LIMIT ${MAX_CANDIDATES+1}`)).length>MAX_CANDIDATES)
        throw new BusinessProviderAccountCleanupError("provider_candidate_bound");
    }
    await sql.query("CLOSE business_erasure_inherited_accounts");
  }
}

/** Caller holds writer/DDL exclusion on provider_accounts, every scoped child
 * and the two inherited stores. Candidate UUIDs are captured by existing owned
 * DELETE pages; no additional whole-history or other-account scan is allowed.
 * GLOBAL zero-reference proof protects every foreign/shared row from CASCADE
 * or SET NULL before an unshared registry record is removed. */
export async function prepareBusinessProviderAccountErasure(
  sql: Sql, allowedChildren: ReadonlySet<string>,
) {
  const references = await sql.query<Reference>(CATALOG);
  if (!references.length || references.length > MAX_REFERENCES) throw new BusinessProviderAccountCleanupError("provider_reference_census");
  for (const r of references) {
    // This existing legacy FK is intentionally NOT VALID. Its four active RI
    // triggers and global zero-reference proof remain mandatory; do not validate,
    // weaken or ignore it as part of offboarding.
    const legacyUnvalidated=r.child==="public.meta_campaign_label_history"
      && r.constraint_name==="meta_campaign_label_history_account_fk"
      && r.definition==="FOREIGN KEY (provider_account_ref_id, provider_account_id) REFERENCES provider_accounts(id, external_account_id) ON DELETE RESTRICT NOT VALID";
    if (!allowedChildren.has(r.child) || r.key_type !== 2950 || r.relation_kind !== "r" || r.partition
      || r.row_security || !r.uuid_equality || !r.validated && !legacyUnvalidated || r.deferrable || r.initially_deferred
      || r.enabled_triggers !== 4 || !/^\d+$/.test(r.heap_bytes)
      || !Number.isSafeInteger(Number(r.heap_bytes))
      || Number(r.heap_bytes) > SMALL_HEAP && !r.leading_indexes.length) {
      throw new BusinessProviderAccountCleanupError(`provider_reference_contract:${r.child}`);
    }
  }
  const [parent] = await sql.query<{ bytes:string; row_security:boolean; relation_kind:string; partition:boolean; indexes:string[] }>(`SELECT pg_relation_size(c.oid)::text AS bytes,
    ARRAY(SELECT ix.relname FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
      JOIN pg_am am ON am.oid=ix.relam JOIN pg_opclass op ON op.oid=i.indclass[0]
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=i.indkey[0]
      WHERE i.indrelid=c.oid AND am.amname='btree' AND i.indisvalid AND i.indisready
        AND i.indislive AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnkeyatts>=1
        AND a.attname='id' AND a.atttypid=2950 AND a.attnotnull AND op.opcdefault
        AND i.indcollation[0]=a.attcollation ORDER BY ix.relname) AS indexes,
    c.relrowsecurity OR c.relforcerowsecurity AS row_security,c.relkind AS relation_kind,c.relispartition AS partition
    FROM pg_class c WHERE c.oid='public.provider_accounts'::regclass`);
  if (!parent || parent.row_security || parent.relation_kind!=="r" || parent.partition
    || !/^\d+$/.test(parent.bytes) || !parent.indexes.length) {
    throw new BusinessProviderAccountCleanupError("provider_parent_bound");
  }
  const directoryQuery=`SELECT id::text FROM public.provider_accounts ORDER BY provider_accounts.id LIMIT ${MAX_ROOTS+1}`;
  const [directoryExplain]=await sql.query(`EXPLAIN (FORMAT JSON) ${directoryQuery}`);
  const directoryPlan=directoryExplain!["QUERY PLAN"][0].Plan;
  const directoryAccess=directoryPlan.Plans?.[0];
  if(directoryPlan["Node Type"]!=="Limit" || !directoryAccess
    || !["Index Scan","Index Only Scan"].includes(directoryAccess["Node Type"])
    || directoryAccess["Relation Name"]!=="provider_accounts"
    || !parent.indexes.includes(directoryAccess["Index Name"]))
    throw new BusinessProviderAccountCleanupError("provider_parent_plan");
  const directory = await sql.query<{id:string}>(directoryQuery);
  if (directory.length > MAX_ROOTS) throw new BusinessProviderAccountCleanupError("provider_parent_bound");
  await sql.query(`CREATE TEMP TABLE ${candidates} (id UUID PRIMARY KEY) ON COMMIT DROP`);
  const [settings] = await sql.query<{seq:string;bitmap:string;index:string}>(`SELECT current_setting('enable_seqscan') AS seq,
    current_setting('enable_bitmapscan') AS bitmap,current_setting('enable_indexscan') AS index`);
  const restore = () => sql.query("SELECT set_config('enable_seqscan',$1,true),set_config('enable_bitmapscan',$2,true),set_config('enable_indexscan',$3,true)",
    [settings!.seq,settings!.bitmap,settings!.index]);
  const children = [...new Map(references.map(r=>[r.child,r])).values()];
  const columns = new Map(children.map(r=>[r.child,r.account_key]));
  const fingerprint = (rows:Reference[]) => JSON.stringify(rows.map(({heap_bytes: _size,...r})=>r));
  return { columns, captureInherited: async (child:string,parentKey:string,parentIds:string[]) => {
    const reference=children.find(r=>r.child===child);
    if(!reference || parentIds.length>1024) throw new BusinessProviderAccountCleanupError("provider_inherited_contract");
    await captureInherited(sql,reference,parentKey,parentIds);
  }, finish: async () => {
    const selected = await sql.query<{id:string}>(`SELECT id::text FROM ${candidates} ORDER BY id LIMIT ${MAX_CANDIDATES+1}`);
    if (selected.length>MAX_CANDIDATES) throw new BusinessProviderAccountCleanupError("provider_candidate_bound");
    if (fingerprint(await sql.query<Reference>(CATALOG))!==fingerprint(references)) throw new BusinessProviderAccountCleanupError("provider_reference_catalog_changed");
    await sql.query("SET LOCAL enable_seqscan=off");
    await sql.query("SET LOCAL enable_bitmapscan=off");
    await sql.query("SET LOCAL enable_indexscan=on");
    let removed = 0;
    for (const account of selected) {
      if (!(await sql.query("SELECT id FROM public.provider_accounts WHERE id=$1::uuid FOR UPDATE",[account.id])).length) continue;
      let referenced = false;
      for (const r of children) {
        const query = `SELECT 1 FROM ONLY ${qualified(r.child)} x WHERE x.${quoted(r.account_key)}=$1::uuid LIMIT 1`;
        const [plan] = await sql.query(`EXPLAIN (FORMAT JSON) ${query}`,[account.id]);
        verifyProbe(r,plan!["QUERY PLAN"][0].Plan);
        if ((await sql.query(query,[account.id])).length) { referenced=true;break; }
      }
      if (referenced) continue; // Foreign/shared references retain original bytes.
      const deleted = await sql.query("DELETE FROM public.provider_accounts WHERE id=$1::uuid RETURNING id",[account.id]);
      if (deleted.length!==1) throw new BusinessProviderAccountCleanupError("provider_delete_mismatch");
      if ((await sql.query("SELECT 1 FROM public.provider_accounts WHERE id=$1::uuid",[account.id])).length) throw new BusinessProviderAccountCleanupError("provider_delete_unconfirmed");
      removed++;
    }
    await restore();
    return {removed,candidates:selected.length,referenceChildren:children.length};
  }};
}
