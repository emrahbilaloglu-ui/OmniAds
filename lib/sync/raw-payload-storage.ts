/** D178: physical interning only. Observation IDs/clocks/receipts and provider
 * authority never come from the payload owner. Inline legacy rows stay readable.
 * These literals are a closed schema, not an input-driven SQL generator. */
export const RAW_PAYLOAD_STORAGE_TABLES = ["meta_raw_snapshots", "shopify_raw_snapshots"] as const;
export type RawPayloadStorageTable = (typeof RAW_PAYLOAD_STORAGE_TABLES)[number];
export const RAW_PAYLOAD_STORAGE_CONTRACT = "raw-payload-storage.v1";
export const RAW_PAYLOAD_METADATA_COLUMNS = {
  "meta_raw_snapshots": [
    "id",
    "business_id",
    "provider_account_id",
    "partition_id",
    "checkpoint_id",
    "endpoint_name",
    "entity_scope",
    "page_index",
    "provider_cursor",
    "start_date",
    "end_date",
    "account_timezone",
    "account_currency",
    "payload_hash",
    "request_context",
    "response_headers",
    "provider_http_status",
    "status",
    "fetched_at",
    "created_at",
    "updated_at",
    "run_id",
    "business_ref_id",
    "provider_account_ref_id",
    "first_observed_at",
    "last_observed_at",
    "observation_count",
    "content_key"
  ],
  "shopify_raw_snapshots": [
    "id",
    "business_id",
    "provider_account_id",
    "endpoint_name",
    "entity_scope",
    "start_date",
    "end_date",
    "payload_hash",
    "request_context",
    "response_headers",
    "provider_http_status",
    "status",
    "fetched_at",
    "created_at",
    "updated_at",
    "business_ref_id",
    "provider_account_ref_id",
    "content_key",
    "first_observed_at",
    "last_observed_at",
    "observation_count"
  ]
} as const;

/** Never form to_jsonb(whole_row): that would detoast the discarded payload. */
export function rawPayloadMetadataSql(table:RawPayloadStorageTable,alias:"s"|"r") {
  return `jsonb_build_array(${RAW_PAYLOAD_METADATA_COLUMNS[table].map(c=>`${alias}."${c}"`).join(",")})`;
}


export function rawPayloadSchemaStatements(table: RawPayloadStorageTable): string[] {
  if (!RAW_PAYLOAD_STORAGE_TABLES.includes(table)) throw new Error("raw_payload_table_invalid");
  const fn = table === "meta_raw_snapshots" ? "adsecute_meta_raw_payload" : "adsecute_shopify_raw_payload";
  const durableOwner = table === "meta_raw_snapshots" ? "AND r.partition_id IS NULL" : "";
  return [
    `ALTER TABLE public.${table}
       ADD COLUMN IF NOT EXISTS payload_ref_id uuid,
       ADD COLUMN IF NOT EXISTS payload_ref_sha256 text,
       ADD COLUMN IF NOT EXISTS payload_storage_state smallint NOT NULL DEFAULT 0`,
    `DO $schema$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${table}_payload_ref_fk') THEN
         ALTER TABLE public.${table} ADD CONSTRAINT ${table}_payload_ref_fk
           FOREIGN KEY(payload_ref_id) REFERENCES public.${table}(id)
           ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${table}_payload_storage_check') THEN
         ALTER TABLE public.${table} ADD CONSTRAINT ${table}_payload_storage_check CHECK (
           (payload_storage_state IN (0,1) AND payload_ref_id IS NULL AND payload_ref_sha256 IS NULL) OR
           (payload_storage_state=2 AND payload_ref_id IS NOT NULL AND payload_ref_id<>id
             AND payload_ref_sha256 IS NOT NULL AND payload_ref_sha256 ~ '^[a-f0-9]{64}$' AND payload_json='null'::jsonb)
         ) NOT VALID;
       END IF;
     END $schema$`,
    `CREATE OR REPLACE FUNCTION public.${fn}(s public.${table}) RETURNS jsonb
     LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $reader$
     DECLARE original jsonb;
     BEGIN
       IF s.payload_storage_state IN (0,1) AND s.payload_ref_id IS NULL AND s.payload_ref_sha256 IS NULL THEN
         RETURN s.payload_json;
       END IF;
       IF s.payload_storage_state IS DISTINCT FROM 2 OR s.payload_ref_id IS NULL OR s.payload_ref_id=s.id
         OR s.payload_ref_sha256 IS NULL OR s.payload_ref_sha256 !~ '^[a-f0-9]{64}$'
         OR s.payload_json IS DISTINCT FROM 'null'::jsonb THEN
         RAISE EXCEPTION USING ERRCODE='22000',MESSAGE='raw_payload_storage_invalid';
       END IF;
       SELECT r.payload_json INTO original FROM public.${table} r
       WHERE r.id=s.payload_ref_id AND r.payload_ref_id IS NULL AND r.payload_storage_state IN (0,1)
         AND r.business_id=s.business_id AND r.provider_account_id=s.provider_account_id
         AND r.payload_hash=s.payload_hash AND (r.fetched_at,r.id)<(s.fetched_at,s.id) ${durableOwner};
       IF NOT FOUND OR encode(public.digest(original::text,'sha256'),'hex') IS DISTINCT FROM s.payload_ref_sha256 THEN
         RAISE EXCEPTION USING ERRCODE='22000',MESSAGE='raw_payload_original_unavailable';
       END IF;
       RETURN original;
     END $reader$`,
  ];
}

/** Exact additive schema/reader/index closure before the writer takes a page.
 * A future metadata column or a user UPDATE trigger needs an explicit review;
 * neither may silently change an original observation during physical work. */
export async function assertRawPayloadStorageReady(db: {query(text:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>}) {
  const normalized=(s:string)=>s.toLowerCase().replace(/\bif not exists\b/g,"").replace(/[\s()\"]/g,"");
  for(const table of RAW_PAYLOAD_STORAGE_TABLES) {
    const fn=table==="meta_raw_snapshots"?"adsecute_meta_raw_payload":"adsecute_shopify_raw_payload";
    const {rows:columns}=await db.query(`SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname`,[`public.${table}`]);
    const expected=[...RAW_PAYLOAD_METADATA_COLUMNS[table],"payload_json","payload_ref_id","payload_ref_sha256","payload_storage_state"].sort();
    if(JSON.stringify(columns.map(c=>c.attname))!==JSON.stringify(expected))throw Error("raw_payload_column_closure_changed");
    const {rows:[reader]}=await db.query(`SELECT p.prosrc,p.provolatile,p.prosecdef,p.prorettype='jsonb'::regtype AS jsonb,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=$2::regclass AND NOT tgisinternal) user_triggers
      FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,[`public.${fn}(public.${table})`,`public.${table}`]);
    const body=rawPayloadSchemaStatements(table)[2]!.split("$reader$")[1]!.trim();
    if(!reader||String(reader.prosrc).trim()!==body||reader.provolatile!=="s"||reader.prosecdef!==false||reader.jsonb!==true||reader.user_triggers!==0)
      throw Error("raw_payload_reader_or_trigger_drift");
    const {rows:[fk]}=await db.query(`SELECT c.condeferrable,c.condeferred,c.confdeltype,
        c.confrelid=c.conrelid AS self,a.attname child,b.attname parent,
        (SELECT count(*)::int FROM pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgisinternal AND t.tgenabled IN ('O','A')) enabled_triggers
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
      JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=c.confkey[1]
      WHERE c.conrelid=$1::regclass AND c.conname=$2 AND c.contype='f' AND cardinality(c.conkey)=1 AND cardinality(c.confkey)=1`,
    [`public.${table}`,`${table}_payload_ref_fk`]);
    if(!fk||fk.condeferrable!==true||fk.condeferred!==true||fk.confdeltype!=="a"||fk.self!==true||fk.child!=="payload_ref_id"||fk.parent!=="id"||fk.enabled_triggers!==4)
      throw Error("raw_payload_reference_guard_drift");
    for(const statement of rawPayloadIndexStatements(table)) {
      const name=statement.match(/IF NOT EXISTS (\w+)/)![1]!;
      const {rows:[index]}=await db.query(`SELECT pg_get_indexdef(i.indexrelid) definition,i.indisvalid,i.indisready,i.indislive
        FROM pg_index i WHERE i.indrelid=$1::regclass AND i.indexrelid=to_regclass($2)`,[`public.${table}`,`public.${name}`]);
      if(!index||index.indisvalid!==true||index.indisready!==true||index.indislive!==true||normalized(String(index.definition))!==normalized(statement))
        throw Error("raw_payload_bounded_index_drift");
    }
  }
}

/** Installed concurrently by the bounded owner migration on a populated DB.
 * The first is lookup-only, the second bounds the queue, the third makes FK
 * deletion/retention probes indexed. No payload lives in these indexes. */
export function rawPayloadIndexStatements(table: RawPayloadStorageTable, concurrently = false): string[] {
  if (!RAW_PAYLOAD_STORAGE_TABLES.includes(table)) throw new Error("raw_payload_table_invalid");
  const mode = concurrently ? "CONCURRENTLY " : "";
  const durableOwner = table === "meta_raw_snapshots" ? " AND partition_id IS NULL" : "";
  return [
    `CREATE INDEX ${mode}IF NOT EXISTS idx_${table}_payload_owner ON public.${table} USING btree(business_id,provider_account_id,payload_hash,fetched_at,id) WHERE payload_ref_id IS NULL${durableOwner}`,
    `CREATE INDEX ${mode}IF NOT EXISTS idx_${table}_payload_queue ON public.${table} USING btree(fetched_at,id) WHERE payload_storage_state=0`,
    `CREATE INDEX ${mode}IF NOT EXISTS idx_${table}_payload_ref ON public.${table} USING btree(payload_ref_id) WHERE payload_ref_id IS NOT NULL`,
  ];
}
