import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Client } from "pg";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { buildNativeEvidenceArchive, buildNativeSupersededEvidenceArchive, NATIVE_ARCHIVE_TABLES,
  type NativeArchiveSchema, type NativeArchiveTableInput } from "@/lib/creative-decision-engine/native-evidence-archive";
import { buildNativeCalibrationParentArchive, NATIVE_CALIBRATION_PARENT_TABLES,
  type NativeCalibrationParentBundle, type NativeCalibrationParentSchema } from "@/lib/creative-decision-engine/native-calibration-parent-archive";
import { readNativeArchivePinCensus } from "@/lib/creative-decision-engine/native-archive-pin-census";
import { sealNativeHistoricalArchive, openNativeHistoricalArchiveEnvelope, openNativeHistoricalArchiveEvidence } from "@/lib/creative-decision-engine/native-historical-archive";
import { downloadNativeArchiveVersion } from "@/lib/creative-decision-engine/native-historical-archive-reader";
import { AD_CALIBRATION_JOB_NAME, NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  computeNativeAdCalibrationCellSetHash } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`independent calibration parent seam FAILED: ${message}`);
}
function q(name: string) {
  assert(/^[a-z_][a-z0-9_]*$/.test(name), "unsafe fixture identifier"); return `"${name}"`;
}
type Row = Record<string, unknown>;
async function insert(db: Client, table: string, row: Row) {
  const columns=Object.keys(row);
  await db.query(`INSERT INTO public.${q(table)} (${columns.map(q).join(",")}) VALUES (${columns.map((_,i)=>`$${i+1}`).join(",")})`,Object.values(row));
}
async function expectSqlState(db: Client, sql: string, values: unknown[], expected: string) {
  await db.query("SAVEPOINT parent_negative_guard");
  let code: string | undefined;
  try { await db.query(sql,values); } catch(e) { code=(e as {code?:string}).code; }
  finally { await db.query("ROLLBACK TO SAVEPOINT parent_negative_guard");await db.query("RELEASE SAVEPOINT parent_negative_guard"); }
  assert(code===expected,`negative SQL expected${expected},actual${code}`);
}
/** Called only by the existing NEW-production-DDL database stage. Each restore
 * creates a different owned database and runs actual migrations. Parent-table
 * copies from the source database are never used as restore prerequisites. */
export async function verifyIndependentNativeCalibrationParents(source: Client, cluster: Client) {
  const cp=(cluster as Client&{connectionParameters:{database:string;host:string;port:number}}).connectionParameters;
  const sp=(source as Client&{connectionParameters:{database:string;host:string;port:number}}).connectionParameters;
  assert(cp.database==="native_ad_seam" && cp.host==="127.0.0.1" && ![5432,15432].includes(cp.port) &&
    sp.database==="native_archive_schema_seam" && sp.host===cp.host && sp.port===cp.port,"not the owned isolated real-DDL server");
  const business=randomUUID(), account=randomUUID(), producer=randomUUID(), replay=randomUUID(), native=randomUUID(), batch=randomUUID();
  const cellIds=[randomUUID(),randomUUID()], context=randomUUID(), evaluation=randomUUID(), snapshot=randomUUID();
  const accountId="act_independent_parent_fixture", date="2026-09-24", epoch="native-parent-fixture", clock="2026-09-24T07:00:00.000001Z";
  const h="a".repeat(64), inputHash=createHash("sha256").update(native).digest("hex"), contract="native-parent-schema-fixture.v1";
  const roots=async(db:Client) => {
    const user=randomUUID();
    await insert(db,"users",{id:user,name:"Independent fixture identity",email:`${user}@example.invalid`,password_hash:"isolated-fixture-only"});
    await insert(db,"businesses",{id:business,name:"Independent identity root",owner_id:user});
    await insert(db,"provider_accounts",{id:account,provider:"meta",external_account_id:accountId});
    await insert(db,"business_provider_accounts",{business_id:business,provider:"meta",provider_account_ref_id:account,provider_account_id:accountId,is_selected:true});
    return user;
  };
  const sourceOwner=await roots(source);
  const jobBase={business_ref_id:business,business_id:business,as_of_date:date,engine_version:epoch,status:"success",started_at:clock,finished_at:clock,created_at:clock};
  await insert(source,"engine_v3_job_runs",{...jobBase,id:producer,job_name:AD_CALIBRATION_JOB_NAME,row_count:2});
  await insert(source,"engine_v3_job_runs",{...jobBase,id:replay,job_name:AD_CALIBRATION_JOB_NAME,row_count:0});
  await insert(source,"engine_v3_job_runs",{...jobBase,id:native,job_name:"engine_v3_native_ad_decisions_shadow_job",row_count:1,
    dependency_run_id:replay,started_at:"2026-09-24T07:01:00Z",finished_at:"2026-09-24T07:02:00Z"});
  const parentCommon={business_ref_id:business,business_id:business,provider:"meta",provider_account_ref_id:account,
    provider_account_id:accountId,as_of_date:date,as_of_cutoff:clock,computed_at:clock,engine_version:epoch,
    policy_version:"native-parent-fixture-policy",contract_version:NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    source_manifest_hash:h,job_run_id:producer,created_at:clock};
  const cells=cellIds.map((id,i)=>({...parentCommon,id,batch_id:batch,account_timezone:"UTC",account_currency:"USD",
    cell_scope:"objective_cohort_context" as const,objective:"sales",funnel_cohort:"purchase" as const,optimization_context:String(i),
    sample_window_start:"2026-06-26",sample_window_end:"2026-09-23",sample_window_days:90,
    source_ad_count:1,source_day_count:1,eligible_ad_count:1,mature_ad_count:1,zero_conversion_ad_count:0,
    account_cpa_sample_count:1,meta_attributed_aov_purchase_count_90d:1,meta_attributed_revenue_90d:100,
    meta_aov_quality:"low_sample",funnel_calibration_json:{},metric_sample_counts_json:{},action_readiness_json:{},quality_counts_json:{},
    config_authority_counts_json:{},quality_status:"low_sample",target_authority_status:"missing",target_authority_hash:h,
    batch_input_manifest_hash:h,input_manifest_hash:h}));
  const cellSetHash=computeNativeAdCalibrationCellSetHash(cells.map(c=>({key:{businessId:business,providerAccountRefId:account,
    providerAccountId:accountId,accountTimezone:c.account_timezone,accountCurrency:c.account_currency,cellScope:c.cell_scope,
    objective:c.objective,cohort:c.funnel_cohort,optimizationContext:c.optimization_context},inputManifestHash:h,sourceManifestHash:h})));
  await source.query("BEGIN");
  const provenanceBytes=JSON.stringify({mode:"current_transaction_snapshot",providerAccountRefId:account,
    providerAccountId:accountId,transactionCutoff:clock,transactionIsolation:"repeatable read"}).slice(0,-1)+
    ',"precisionWitness":9007199254740993.123456789}';
  await insert(source,"engine_v3_ad_account_calibration_batches",{...parentCommon,id:batch,transaction_isolation:"repeatable read",
    source_mode:"current_transaction_snapshot",source_provenance_json:provenanceBytes,expected_cell_count:2,
    generation_content_hash:h,input_manifest_hash:h,cell_set_hash:cellSetHash,completeness_status:"writing"});
  for(const cell of cells) await insert(source,"engine_v3_ad_account_calibration_daily",cell);
  await source.query("UPDATE engine_v3_ad_account_calibration_batches SET completeness_status='complete',completed_at=$2 WHERE id=$1",[batch,clock]);
  await source.query("COMMIT");
  const common={business_ref_id:business,business_id:business,provider_account_ref_id:account,provider_account_id:accountId,
    as_of_date:date,engine_version:epoch,scope_type:"account",scope_id:accountId,job_run_id:native};
  const health={calibration:{asOfDate:date,computedAt:clock}};
  await insert(source,"engine_v3_ad_decision_evaluation_contexts",{...common,id:context,contract_version:contract,
    context_json:{accountProfile:{businessId:business},dataHealth:health},account_profile_json:{businessId:business},data_health_json:health,
    flags_json:{},context_hash:h,evaluated_at:"2026-09-24T07:02:00Z",created_at:clock});
  await insert(source,"engine_v3_ad_decision_evaluations",{...common,id:evaluation,context_id:context,contract_version:contract,
    decision_entity_type:"ad",decision_entity_id:"fixture_ad",ad_id:"fixture_ad",creative_input_json:{},campaign_context_json:{},
    prior_hysteresis_json:{},decision_output_json:{},raw_label:"diagnose",input_hash:inputHash,decision_hash:h,evaluated_at:"2026-09-24T07:02:00Z",created_at:clock});
  await insert(source,"engine_v3_ad_decision_input_evidence",{contract_version:contract,input_hash:inputHash,input_evidence_json:{},created_at:clock});
  await insert(source,"engine_v3_ad_decision_snapshots_daily",{...common,id:snapshot,evaluation_id:evaluation,calibration_row_id:cellIds[0],
    decision_entity_type:"ad",decision_entity_id:"fixture_ad",ad_id:"fixture_ad",label:"diagnose",raw_label:"diagnose",confidence:0,
    truth_source:"global_default",effective_target_roas:1,badges:"[]",reason:"Independent parent schema fixture only",
    input_hash:inputHash,decision_hash:h,computed_at:"2026-09-24T07:02:00Z"});
  const exports: {bundle:NativeCalibrationParentBundle;manifestHash:string}[]=[];
  const capture=async(superseded:boolean) => {
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");await source.query("SET LOCAL statement_timeout='7500ms'");
    await source.query("SET LOCAL timezone='UTC'");
    try {
      const capturedAt=JSON.parse((await source.query("SELECT to_jsonb(clock_timestamp())::text AS bytes")).rows[0].bytes) as string;
      const generation={businessId:business,jobRunId:native,asOfDate:date,engineVersion:epoch};
      const names=[...new Set([...NATIVE_ARCHIVE_TABLES,...NATIVE_CALIBRATION_PARENT_TABLES])];
      const columns=(await source.query(`SELECT c.relname AS table,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
        NOT a.attnotnull AS nullable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[names])).rows;
      const foreignKeys=(await source.query(`SELECT child.relname AS "childTable",parent.relname AS "parentTable",pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid
        JOIN pg_namespace n ON n.oid=child.relnamespace WHERE con.contype='f' AND n.nspname='public' AND child.relname=ANY($1::text[])
        ORDER BY child.relname,con.conname`,[names])).rows;
      const schemaTables=<T extends string>(tables:readonly T[])=>tables.map(table=>({table,columns:columns.filter(c=>c.table===table).map(c=>({name:c.name,type:c.type,nullable:c.nullable}))}));
      const schema:NativeArchiveSchema={tables:schemaTables(NATIVE_ARCHIVE_TABLES),foreignKeys};
      const tables:NativeArchiveTableInput[]=[];
      for(const table of NATIVE_ARCHIVE_TABLES) {
        const predicate=table==="engine_v3_job_runs"?"t.id=$1::uuid":table==="engine_v3_ad_decision_input_evidence"?"t.input_hash=$1":"t.job_run_id=$1::uuid";
        const key=table==="engine_v3_ad_decision_input_evidence"?inputHash:native;
        tables.push({table,rowJson:(await source.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${q(table)} t WHERE ${predicate}`,[key])).rows.map(r=>r.bytes)});
      }
      const coreInput={generation,capturedAt,sourceRevision:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
        sourceWorkspaceDirty:execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim().length>0,schema,tables};
      const census=superseded?await readNativeArchivePinCensus(source,{schema:"public",generation,unmodeledReferences:[]}):undefined;
      const core=census?buildNativeSupersededEvidenceArchive({...coreInput,capturedAt:census.observedAt,pinCensus:census}):buildNativeEvidenceArchive(coreInput);
      const parentSchema:NativeCalibrationParentSchema={tables:schemaTables(NATIVE_CALIBRATION_PARENT_TABLES),foreignKeys};
      const parentTables=[];
      for(const table of NATIVE_CALIBRATION_PARENT_TABLES) {
        const predicate=table==="engine_v3_job_runs"?"t.id=ANY($1::uuid[])":"t.business_ref_id=$1::uuid";
        parentTables.push({table,rowJson:(await source.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${q(table)} t WHERE ${predicate}`,
          [table==="engine_v3_job_runs"?[producer,replay]:business])).rows.map(r=>r.bytes as string)});
      }
      exports.push(buildNativeCalibrationParentArchive({core:core.bundle,coreManifestHash:core.manifestHash,schema:parentSchema,tables:parentTables}));
    } finally {await source.query("ROLLBACK");}
  };
  await capture(false);
  // Source mutations here belong only to NEW owned schema fixtures. No real
  // snapshot/parent/evidence or retention operation is performed.
  await source.query("DELETE FROM engine_v3_ad_decision_snapshots_daily WHERE id=$1",[snapshot]);
  await insert(source,"engine_v3_job_runs",{...jobBase,id:randomUUID(),job_name:"engine_v3_native_ad_decisions_shadow_job",row_count:0,
    started_at:"2026-09-24T08:00:00Z",finished_at:"2026-09-24T08:00:00Z"});
  await capture(true);
  const temp=mkdtempSync(join(tmpdir(),"native-parent-transport-"));
  try {
    for(let i=0;i<exports.length;i++) {
      const name=i===0?"native_parent_restore_current":"native_parent_restore_superseded";
      assert((await cluster.query("SELECT 1 FROM pg_database WHERE datname=$1",[name])).rowCount===0,"restore DB already exists; refuse adoption");
      await cluster.query(`CREATE DATABASE ${q(name)}`);
      const url=`postgresql://postgres@127.0.0.1:${cp.port}/${name}`, target=new Client({connectionString:url});let connected=false;
      try {
        const child=spawn(process.execPath,["--import","tsx","scripts/run-migrations.ts"],{cwd:process.cwd(),stdio:"inherit",env:{...process.env,
          DATABASE_URL:url,DATABASE_URL_UNPOOLED:url,DB_SSL_MODE:"disable",ENABLE_RUNTIME_MIGRATIONS:"1",ADSECUTE_EPHEMERAL_DB_SEAM:"1"}});
        const exit=await new Promise<number>((resolve,reject)=>{child.once("error",reject);child.once("exit",n=>resolve(n??1));});
        assert(exit===0,`restore real migrations EXIT${exit}`);await target.connect();connected=true;
        const filename=join(temp,`${name}.json`);writeFileSync(filename,JSON.stringify(exports[i]!.bundle),{mode:0o600});
        const serialized=JSON.parse(readFileSync(filename,"utf8")) as NativeCalibrationParentBundle;
        const trust={manifestHash:exports[i]!.manifestHash,schemaHash:serialized.manifest.schemaHash,generation:serialized.manifest.generation};
        const fixtureKey=Buffer.alloc(32,0x73), sealed=sealNativeHistoricalArchive(serialized,trust,"isolated-fixture",fixtureKey);
        let getCount=0;
        const objectKey=`native/v1/${sealed.trust.ciphertextSha256}.bin`, versionId="isolated-original-version";
        const server=createServer((req,res)=>{
          const url=new URL(req.url!,"http://127.0.0.1");
          assert(req.method==="GET" && url.pathname===`/isolated-parent-fixture/${objectKey}` &&
            url.searchParams.get("versionId")===versionId && req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 "),"not an exact signed fixture GET");
          getCount++;res.writeHead(200,{"Content-Length":sealed.bytes.length,"x-amz-version-id":versionId});res.end(sealed.bytes);
        });
        await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
        const address=server.address();assert(address && typeof address!=="string","loopback object fixture absent");
        const objectClient=new S3Client({region:"fsn1",endpoint:`http://127.0.0.1:${address.port}`,forcePathStyle:true,maxAttempts:1,
          credentials:{accessKeyId:"isolated-fixture-only",secretAccessKey:"isolated-fixture-only"}});
        let downloaded:Buffer;
        try {downloaded=await downloadNativeArchiveVersion(objectClient,{...sealed.trust,object:{bucket:"isolated-parent-fixture",key:objectKey,versionId}});}
        finally {objectClient.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
        assert(getCount===1,"archive transport did not use one exact GET");
        const {bundle,view:reader}=openNativeHistoricalArchiveEnvelope(downloaded,sealed.trust,fixtureKey,trust.generation);
        assert(JSON.stringify(bundle)===JSON.stringify(serialized),"encrypted complete original package bytes changed");
        assert(bundle.manifest.sourceWorkspaceDirty===serialized.manifest.sourceWorkspaceDirty,"encryption hid dirty source metadata");
        const corrupt=Buffer.from(sealed.bytes);corrupt[corrupt.length-1]^=1;
        let corruptRefused=false;try {openNativeHistoricalArchiveEnvelope(corrupt,sealed.trust,fixtureKey,trust.generation);}catch {corruptRefused=true;}
        assert(corruptRefused,"corrupt encrypted archive accepted");
        if(serialized.manifest.sourceWorkspaceDirty) {
          let dirtyRefused=false;try {openNativeHistoricalArchiveEvidence(sealed.bytes,sealed.trust,fixtureKey,
            {generation:trust.generation,providerAccountId:accountId,adId:"fixture_ad",evaluationId:evaluation});}catch(e) {dirtyRefused=(e as Error).message.includes("dirty published archive source");}
          assert(dirtyRefused,"dirty local package entered runtime historical publication");
        }
        const targetOwner=await roots(target);assert(targetOwner!==sourceOwner,"root owner borrowed from source credential table");
        await target.query("BEGIN");
        const priorTimezone=(await target.query("SELECT current_setting('TimeZone') AS timezone")).rows[0].timezone;
        console.log(`[native-calibration-parent-archive] ${name} default target timezone=${priorTimezone}; serializing exact comparisons in UTC, without modifying stored instants`);
        await target.query("SET LOCAL timezone='UTC'");
        const restore=async(table:string,bytes:string)=>target.query(`INSERT INTO public.${q(table)} SELECT * FROM jsonb_populate_record(NULL::public.${q(table)},$1::jsonb)`,[bytes]);
        for(const raw of reader.readParentTable("engine_v3_job_runs")) await restore("engine_v3_job_runs",raw);
        const batchBytes=reader.readParentTable("engine_v3_ad_account_calibration_batches")[0]!, original=JSON.parse(batchBytes) as Row;
        // Preserve production immutability triggers. Only a new target writing
        // batch receives cells, then the allowed exact completion transition.
        assert(batchBytes.includes("9007199254740993.123456789"),"large JSONB decimal witness absent");
        await target.query(`INSERT INTO public.engine_v3_ad_account_calibration_batches
          SELECT * FROM jsonb_populate_record(NULL::public.engine_v3_ad_account_calibration_batches,
            jsonb_set(jsonb_set($1::jsonb,'{completeness_status}','"writing"'::jsonb),'{completed_at}','null'::jsonb))`,[batchBytes]);
        for(const raw of reader.readParentTable("engine_v3_ad_account_calibration_daily")) await restore("engine_v3_ad_account_calibration_daily",raw);
        await target.query("UPDATE engine_v3_ad_account_calibration_batches SET completeness_status='complete',completed_at=$2 WHERE id=$1",[batch,original.completed_at]);
        for(const table of NATIVE_ARCHIVE_TABLES) for(const r of reader.readCoreTable(table)) await restore(table,r.rowJson);
        for(const table of [...new Set([...NATIVE_ARCHIVE_TABLES,...NATIVE_CALIBRATION_PARENT_TABLES])]) {
          const expected=table==="engine_v3_job_runs"?[...reader.readParentTable(table),...reader.readCoreTable(table).map(r=>r.rowJson)]:
            NATIVE_ARCHIVE_TABLES.includes(table as never)?reader.readCoreTable(table as typeof NATIVE_ARCHIVE_TABLES[number]).map(r=>r.rowJson):
            reader.readParentTable(table as typeof NATIVE_CALIBRATION_PARENT_TABLES[number]);
          const actual=(await target.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${q(table)} t`)).rows.map(r=>r.bytes as string).sort();
          if(JSON.stringify(actual)!==JSON.stringify([...expected].sort())) {
            const sourceByKey=new Map(expected.map(raw=>{const row=JSON.parse(raw) as Row;return [String(row.id??row.input_hash),row] as const;}));
            const mismatches=actual.map(raw=>{const row=JSON.parse(raw) as Row,key=String(row.id??row.input_hash),prior=sourceByKey.get(key);
              return {key,extraRow:!prior,fields:prior?Object.keys(row).filter(k=>JSON.stringify(row[k])!==JSON.stringify(prior[k])):[]};}).filter(r=>r.extraRow||r.fields.length);
            console.error(`[native-calibration-parent-archive] parity diagnosis ${table}: ${JSON.stringify({expected:expected.length,actual:actual.length,mismatches})}`);
          }
          assert(JSON.stringify(actual)===JSON.stringify(expected.sort()),`${name} ${table} complete transported byte/clock/ID/hash parity`);
        }
        await expectSqlState(target,"UPDATE engine_v3_ad_account_calibration_daily SET computed_at=computed_at+interval '1 microsecond' WHERE id=$1",[cellIds[0]],"P0001");
        await expectSqlState(target,"UPDATE engine_v3_ad_account_calibration_batches SET cell_set_hash=$2 WHERE id=$1",[batch,"b".repeat(64)],"P0001");
        if(i===0) await expectSqlState(target,"UPDATE engine_v3_ad_decision_snapshots_daily SET calibration_row_id=$2 WHERE id=$1",[snapshot,randomUUID()],"23503");
        assert(reader.providerAuthority===false && reader.reclaimEligible===false,"historical transport granted authority");
        await target.query("COMMIT");
        console.log(`[native-historical-archive] PASS ${name}: AES-256-GCM local package, ONE signed exact-VersionId loopback GET, independent manifest trust, complete byte/decimal/microsecond restore, corruption refused, source dirty metadata retained. Loopback is not external durable S3 or published-catalog/live-reader acceptance.`);
        console.log(`[native-calibration-parent-archive] PASS ${name}: separate NEW DB/actual migrations; independently provisioned credential-free identity roots; transported original complete2-cell batch + original2-row producer and distinct0-row replay receipts; seven-table full JSONB byte/microsecond/ID/hash parity; production immutable cell/batch triggers P0001${i===0?"; served calibration FK23503":"; original serving snapshot count ZERO"}. No source parent-table copies or credentials, source clocks or runtime authority changed. This is declared calibration-parent restore, not all transitive parents/readers/full DR or production archive/reclaim.`);
      } finally {if(connected) await target.end();await cluster.query(`DROP DATABASE ${q(name)}`);}
    }
  } finally {rmSync(temp,{recursive:true,force:true});}
}
