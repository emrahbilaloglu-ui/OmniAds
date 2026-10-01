import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { stableCanonicalJson } from "../canonical-evaluation";
import { buildNativeEvidenceArchive, buildNativeSupersededEvidenceArchive, NATIVE_ARCHIVE_TABLES,
  type NativeArchiveTableInput } from "../native-evidence-archive";
import { NATIVE_PIN_CLASSES } from "../native-archive-pin-census";
import { buildNativeCalibrationParentArchive, openNativeCalibrationParentArchive,
  NATIVE_CALIBRATION_PARENT_TABLES, type NativeCalibrationParentInput } from "../native-calibration-parent-archive";
import { AD_CALIBRATION_JOB_NAME, NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  computeNativeAdCalibrationCellSetHash } from "../jobs/ad-calibration-job";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const business = id(1), job = id(2), account = id(3), batch = id(4), calJob = id(5);
const generation = { businessId: business, jobRunId: job, asOfDate: "2026-09-30", engineVersion: "archive-parent-fixture" };
const clock = "2026-09-30T02:00:00.000001+00:00", capture = "2026-09-30T04:00:00.000002Z";
const hash = "a".repeat(64);
function input(superseded = false): NativeCalibrationParentInput {
  const common = { business_ref_id: business, business_id: business, as_of_date: generation.asOfDate,
    engine_version: generation.engineVersion, provider_account_ref_id: account, provider_account_id: "act_1",
    job_run_id: job, scope_type: "account", scope_id: "act_1" };
  const health = { calibration: { asOfDate: generation.asOfDate, computedAt: "2026-09-30T02:00:00.000001Z" } };
  const evaluation = { ...common, id: "eval", context_id: "context", contract_version: "fixture.v1",
    input_hash: hash, decision_hash: hash, decision_entity_type: "ad", decision_entity_id: "ad", ad_id: "ad" };
  const coreRows = [
    { ...common, id: job, job_name: "engine_v3_native_ad_decisions_shadow_job", status: "success", row_count: 1,
      dependency_run_id: calJob, finished_at: "2026-09-30T03:00:00Z" },
    { ...common, id: "context", contract_version: "fixture.v1", evaluated_at: "2026-09-30T03:00:00Z",
      context_json: { accountProfile: { businessId: business }, dataHealth: health }, data_health_json: health },
    evaluation, { contract_version: "fixture.v1", input_hash: hash, input_evidence_json: {} },
    { ...evaluation, id: "snapshot", evaluation_id: "eval", calibration_row_id: id(6), computed_at: "2026-09-30T03:00:00Z" },
  ];
  const coreInput = { generation, capturedAt: capture, sourceRevision: "a".repeat(40), sourceWorkspaceDirty: true,
    tables: NATIVE_ARCHIVE_TABLES.map((table,i) => ({table,rowJson: superseded && i===4 ? [] : [JSON.stringify(coreRows[i])]})) as NativeArchiveTableInput[],
    schema: {tables: NATIVE_ARCHIVE_TABLES.map((table,i) => ({table,columns:Object.keys(coreRows[i]!).map(name => ({name,type:"fixture",nullable:false}))})),foreignKeys:[]} };
  const core = superseded ? buildNativeSupersededEvidenceArchive({ ...coreInput, pinCensus: {
    contract: "bounded-native-pin-census.v1", coverage: "catalog_incoming_and_declared_non_fk", generation,
    observedAt: capture, jobFinishedAt: "2026-09-30T03:00:00Z", jobRowCount:"1",evaluationCount:"1",
    catalogHash:hash,reclaimEligible:false,counts:NATIVE_PIN_CLASSES.map(pinClass=>({pinClass,count:"0"})),
    foreignKeyReferences:[],unknownReferences:[] } }) : buildNativeEvidenceArchive(coreInput);
  const calibrationCommon = { ...common, provider:"meta",job_run_id:calJob,contract_version:NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    policy_version:"fixture-policy", as_of_cutoff:clock, computed_at:clock, source_manifest_hash:hash };
  const cells = [6,7].map((n,i) => ({...calibrationCommon,id:id(n),batch_id:batch,
    account_timezone:"UTC",account_currency:"USD",cell_scope:"objective_cohort_context" as const,objective:"sales",
    funnel_cohort:"purchase" as const,optimization_context:String(i),batch_input_manifest_hash:hash,input_manifest_hash:hash}));
  const cellSetHash = computeNativeAdCalibrationCellSetHash(cells.map(c=>({ key:{ businessId:business,providerAccountRefId:account,
    providerAccountId:"act_1",accountTimezone:c.account_timezone,accountCurrency:c.account_currency,cellScope:c.cell_scope,
    objective:c.objective,cohort:c.funnel_cohort,optimizationContext:c.optimization_context },inputManifestHash:hash,sourceManifestHash:hash })));
  const parentRows = [[{...calibrationCommon,id:batch,completeness_status:"complete",completed_at:clock,
    expected_cell_count:2,cell_set_hash:cellSetHash,input_manifest_hash:hash}],cells,
    [{...common,id:calJob,job_name:AD_CALIBRATION_JOB_NAME,status:"success",row_count:2,dependency_run_id:null,finished_at:clock}]];
  return { core:core.bundle,coreManifestHash:core.manifestHash,
    schema:{tables:NATIVE_CALIBRATION_PARENT_TABLES.map((table,i)=>({table,columns:Object.keys(parentRows[i]![0]!).map(name=>({name,type:"fixture",nullable:false}))})),foreignKeys:[]},
    tables:NATIVE_CALIBRATION_PARENT_TABLES.map((table,i)=>({table,rowJson:parentRows[i]!.map(row=>JSON.stringify(row))})) };
}
function mutate(data: NativeCalibrationParentInput, table: number, row: number, change: Record<string, unknown>) {
  data.tables[table]!.rowJson[row]=JSON.stringify({...JSON.parse(data.tables[table]!.rowJson[row]!),...change});
}
function trusted(built: ReturnType<typeof buildNativeCalibrationParentArchive>) {
  return {manifestHash:built.manifestHash,schemaHash:built.bundle.manifest.schemaHash,generation};
}
function softOnly(data: NativeCalibrationParentInput, knownBatch: boolean) {
  const tables=NATIVE_ARCHIVE_TABLES.map(table=>({table,rowJson:data.core.manifest.tables.find(t=>t.table===table)!.rows.map(ref=>{
    const row=JSON.parse(data.core.objects[ref.objectHash]!);
    if(table==="engine_v3_ad_decision_evaluation_contexts") {
      row.context_json.accountProfile={profileType:"native_ad_soft_only",selectedCell:null};
      if(!knownBatch) row.context_json.dataHealth.calibration.computedAt=null;
      row.data_health_json=row.context_json.dataHealth;
    }
    if(table==="engine_v3_ad_decision_snapshots_daily") row.calibration_row_id=null;
    if(!knownBatch && table==="engine_v3_job_runs") row.dependency_run_id=null;
    return JSON.stringify(row);
  })}));
  const core=buildNativeEvidenceArchive({...data.core.manifest,tables});
  data.core=core.bundle;data.coreManifestHash=core.manifestHash;
  if(!knownBatch) for(const t of data.tables) t.rowJson=[];
  return data;
}
describe("independent immutable native calibration parent transport", () => {
  it.each([false,true])("preserves complete original batch bytes and historical authority (superseded=%s)", superseded => {
    const data=input(superseded), built=buildNativeCalibrationParentArchive(data), reader=openNativeCalibrationParentArchive(built.bundle,trusted(built));
    expect(reader).toMatchObject({providerAuthority:false,reclaimEligible:false,authority:"historical_read_only",originalJobRunId:job});
    expect(reader.readParentTable(NATIVE_CALIBRATION_PARENT_TABLES[1]).sort()).toEqual(data.tables[1]!.rowJson.sort());
    expect(reader.readCoreTable("engine_v3_ad_decision_snapshots_daily")).toHaveLength(superseded?0:1);
    built.bundle.objects={}; expect(reader.readParentTable(NATIVE_CALIBRATION_PARENT_TABLES[1])).toHaveLength(2);
  });
  it.each(["batch","cell","job"])("refuses a missing %s rather than adopting live parents", missing => {
    const data=input(); data.tables[{batch:0,cell:1,job:2}[missing]!]!.rowJson.pop();
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/refused/);
  });
  it.each(["business_id","provider_account_id","job_run_id","source_manifest_hash","computed_at","contract_version"])("refuses changed cell %s", column => {
    const data=input(); mutate(data,1,0,{[column]:column==="computed_at"?"2026-09-30T02:00:00.000002Z":"foreign"});
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/refused/);
  });
  it("refuses a later calibration reminting instead of changing the historical computation clock", () => {
    const data=input(); mutate(data,0,0,{computed_at:"2026-09-30T02:00:00.000002Z",as_of_cutoff:"2026-09-30T02:00:00.000002Z"});
    for (let i=0;i<2;i++) mutate(data,1,i,{computed_at:"2026-09-30T02:00:00.000002Z",as_of_cutoff:"2026-09-30T02:00:00.000002Z"});
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/original calibration computation/);
  });
  it.each(["writing","failed","row_count"])("refuses invalid original completion receipt %s", fault => {
    const data=input(); if(fault==="writing") mutate(data,0,0,{completeness_status:"writing"});
    else mutate(data,2,0,fault==="failed"?{status:"failed"}:{row_count:0});
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/refused/);
  });
  it("preserves a distinct successful replay receipt without relabeling the original batch producer", () => {
    const data=input(), native=data.core.manifest.tables.find(t=>t.table==="engine_v3_job_runs")!, original=native.rows[0]!;
    const row={...JSON.parse(data.core.objects[original.objectHash]!),dependency_run_id:id(9)};
    const raw=JSON.stringify(row), sha=createHash("sha256").update(raw).digest("hex");
    delete data.core.objects[original.objectHash];data.core.objects[sha]=raw;original.objectHash=sha;
    data.coreManifestHash=createHash("sha256").update(stableCanonicalJson(data.core.manifest)).digest("hex");
    data.tables[2]!.rowJson.push(JSON.stringify({...JSON.parse(data.tables[2]!.rowJson[0]!),id:id(9),row_count:0}));
    const built=buildNativeCalibrationParentArchive(data), reader=openNativeCalibrationParentArchive(built.bundle,trusted(built));
    expect(reader.readParentTable("engine_v3_job_runs")).toHaveLength(2);
    expect(JSON.parse(reader.readParentTable(NATIVE_CALIBRATION_PARENT_TABLES[0])[0]!).job_run_id).toBe(calJob);
  });
  it("refuses corrupt and independently untrusted objects/manifests", () => {
    const built=buildNativeCalibrationParentArchive(input());
    expect(()=>openNativeCalibrationParentArchive(built.bundle,{...trusted(built),manifestHash:"b".repeat(64)})).toThrow(/trusted/);
    built.bundle.objects[Object.keys(built.bundle.objects)[0]!] += " ";
    expect(()=>openNativeCalibrationParentArchive(built.bundle,trusted(built))).toThrow(/corrupt/);
  });
  it("refuses provider credential fields and credential tables", () => {
    const data=input();mutate(data,2,0,{credentials:{access_token:"fixture-secret-never-export"}});
    data.schema.tables[2]!.columns.push({name:"credentials",type:"jsonb",nullable:false});
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/credential/);
    const extra=input(); extra.tables.push({table:"provider_credentials" as never,rowJson:[]});
    expect(()=>buildNativeCalibrationParentArchive(extra)).toThrow(/inventory/);
  });
  it("refuses incomplete superseded original parent references", () => {
    const data=input(true); data.tables[0]!.rowJson=[];data.tables[1]!.rowJson=[];data.tables[2]!.rowJson=[];
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/missing\/ambiguous/);
  });
  it("refuses two original batches sharing an ambiguous computation identity", () => {
    const data=input();data.tables[0]!.rowJson.push(JSON.stringify({...JSON.parse(data.tables[0]!.rowJson[0]!),id:id(11)}));
    for(const raw of [...data.tables[1]!.rowJson]) data.tables[1]!.rowJson.push(JSON.stringify({...JSON.parse(raw),id:id(Number(JSON.parse(raw).id.slice(-12))+10),batch_id:id(11)}));
    mutate(data,2,0,{row_count:4});
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/ambiguous/);
  });
  it("refuses a completed parent whose finish lies after the archive capture", () => {
    const data=input();mutate(data,0,0,{completed_at:"2026-09-30T05:00:00Z"});
    expect(()=>buildNativeCalibrationParentArchive(data)).toThrow(/incomplete\/unsupported/);
  });
  it("preserves exact large JSONB parent decimals beyond Javascript precision", () => {
    const data=input();data.schema.tables[0]!.columns.push({name:"source_provenance_json",type:"jsonb",nullable:false});
    data.tables[0]!.rowJson[0]=data.tables[0]!.rowJson[0]!.slice(0,-1)+',"source_provenance_json":{"decimal":9007199254740993.123456789}}';
    const built=buildNativeCalibrationParentArchive(data);
    expect(openNativeCalibrationParentArchive(built.bundle,trusted(built)).readParentTable(NATIVE_CALIBRATION_PARENT_TABLES[0])[0]).toContain("9007199254740993.123456789");
  });
  it("accepts original PostgreSQL UTC pin-census text without rewriting it or dropping microseconds", () => {
    const data=input(true), original="2026-09-30 04:00:00.000002+00";
    data.core.manifest.capturedAt=original;data.core.manifest.pinCensus!.observedAt=original;
    data.coreManifestHash=createHash("sha256").update(stableCanonicalJson(data.core.manifest)).digest("hex");
    const built=buildNativeCalibrationParentArchive(data);
    expect(built.bundle.manifest.capturedAt).toBe(original);
    expect(()=>openNativeCalibrationParentArchive(built.bundle,trusted(built))).not.toThrow();
  });
  it.each([false,true])("preserves explicit soft-only evidence without creating calibration authority (knownBatch=%s)", known => {
    const data=softOnly(input(),known),built=buildNativeCalibrationParentArchive(data);
    const reader=openNativeCalibrationParentArchive(built.bundle,trusted(built));
    expect(reader.providerAuthority).toBe(false);
    expect(reader.readParentTable("engine_v3_ad_account_calibration_daily")).toHaveLength(known?2:0);
    expect(JSON.parse(reader.readCoreTable("engine_v3_ad_decision_snapshots_daily")[0]!.rowJson).calibration_row_id).toBeNull();
  });
});
