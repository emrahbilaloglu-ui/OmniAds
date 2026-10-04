import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { readNativeHistoricalAdEvidence, NATIVE_HISTORICAL_READER_GATE } from "../native-historical-archive-reader";
import { createHash } from "node:crypto";
import { stableCanonicalJson } from "../canonical-evaluation";
import { buildNativeEvidenceArchive, buildNativeSupersededEvidenceArchive, NATIVE_ARCHIVE_TABLES,
  buildNativeReferenceEvidenceArchive, buildNativeSupersededReferenceEvidenceArchive,
  type NativeArchiveTableInput } from "../native-evidence-archive";
import { NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION } from "../native-campaign-context-storage";
import { NATIVE_PIN_CLASSES } from "../native-archive-pin-census";
import { buildNativeCalibrationParentArchive, openNativeCalibrationParentArchive,
  NATIVE_CALIBRATION_PARENT_TABLES, NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT,
  type NativeCalibrationParentInput } from "../native-calibration-parent-archive";
import { AD_CALIBRATION_JOB_NAME, NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  computeNativeAdCalibrationCellSetHash } from "../jobs/ad-calibration-job";
import { NATIVE_HISTORICAL_CATALOG_CONTRACT, nativeArchiveByteDigest, sealNativeHistoricalArchive,
  openNativeHistoricalArchiveCatalog, openNativeHistoricalArchiveEvidence, openNativeHistoricalArchiveEnvelope,
  resolveNativeHistoricalArchiveEntry, sealCompressedNativeHistoricalArchive,
  NATIVE_REFERENCE_HISTORICAL_EVIDENCE_CONTRACT } from "../native-historical-archive";
import { verifyNativeHistoricalEvidenceInWorker } from "../native-historical-archive-worker-client";

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
function referencedInput(superseded = false) {
  const data = input(superseded);
  const payload = '{"decimal": 9007199254740993.123456789, "nested": {"values": [1, 2]}}';
  const digest = createHash("sha256").update(payload).digest("hex");
  const object = JSON.stringify({ business_ref_id: business, payload_sha256: "\\x" + digest,
    payload_json: "__ORIGINAL__", storage_encoding_version: NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION,
    byte_length: Buffer.byteLength(payload), created_at: clock }).replace('"__ORIGINAL__"', payload);
  const tables: NativeArchiveTableInput[] = data.core.manifest.tables.map(table => ({ table: table.table,
    rowJson: table.rows.map(ref => {
      const raw = data.core.objects[ref.objectHash]!;
      return table.table === "engine_v3_ad_decision_evaluations" ? JSON.stringify({ ...JSON.parse(raw),
        campaign_context_json: null, campaign_context_ref: "\\x" + digest }) : raw;
    }) }));
  tables.push({ table: NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE, rowJson: [object] });
  const schema = structuredClone(data.core.manifest.schema);
  schema.tables.find(table => table.table === "engine_v3_ad_decision_evaluations")!.columns.push(
    { name: "campaign_context_json", type: "jsonb", nullable: true }, { name: "campaign_context_ref", type: "bytea", nullable: true });
  schema.tables.push({ table: NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE,
    columns: Object.keys(JSON.parse(object)).map(name => ({ name, type: "fixture", nullable: false })) });
  const coreInput = { ...data.core.manifest, schema, tables, sourceWorkspaceDirty: false };
  const core = superseded ? buildNativeSupersededReferenceEvidenceArchive({ ...coreInput,
    pinCensus: data.core.manifest.pinCensus! }) : buildNativeReferenceEvidenceArchive(coreInput);
  data.core = core.bundle; data.coreManifestHash = core.manifestHash;
  return { data, payload, object };
}
describe("independent immutable native calibration parent transport", () => {
  it.each([false, true])("keeps reference objects and original parents in a separate trusted eight-table transport (%s)", superseded => {
    const source = referencedInput(superseded), built = buildNativeCalibrationParentArchive(source.data);
    const reader = openNativeCalibrationParentArchive(built.bundle, trusted(built));
    expect(built.bundle.manifest.contract).toBe(NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT);
    expect(new Set([...built.bundle.core.manifest.tables, ...built.bundle.manifest.tables].map(table => table.table)).size).toBe(8);
    expect(reader.readCampaignContext("eval")).toEqual({ payloadJson: source.payload, objectRowJson: source.object });
    expect(reader.readParentTable(NATIVE_CALIBRATION_PARENT_TABLES[1])).toEqual(source.data.tables[1]!.rowJson);
    expect(reader.readCoreTable("engine_v3_ad_decision_snapshots_daily")).toHaveLength(superseded ? 0 : 1);
    expect(reader).toMatchObject({ providerAuthority: false, reclaimEligible: false });
  });
  it("refuses a reference core declared as the legacy parent transport", () => {
    const built = buildNativeCalibrationParentArchive(referencedInput().data);
    built.bundle.manifest.contract = "native-calibration-parent-archive.v1";
    const changedTrust = { ...trusted(built), manifestHash: nativeArchiveByteDigest(stableCanonicalJson(built.bundle.manifest)) };
    expect(() => openNativeCalibrationParentArchive(built.bundle, changedTrust)).toThrow(/scope\/source\/schema differs/);
  });
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


describe("encrypted historical evidence integrity and authority", () => {
  const key=Buffer.alloc(32,0x41);
  const request={generation,providerAccountId:"act_1",adId:"ad",evaluationId:"eval"};
  function sealed(superseded=false,dirty=false) {
    const data=input(superseded);
    data.core.manifest.sourceWorkspaceDirty=dirty;
    data.coreManifestHash=nativeArchiveByteDigest(stableCanonicalJson(data.core.manifest));
    const built=buildNativeCalibrationParentArchive(data);
    return sealNativeHistoricalArchive(built.bundle,trusted(built),"fixture-key",key);
  }
  function catalog(pack:ReturnType<typeof sealed>) {
    const entry={...pack.trust,object:{bucket:"archive-fixture",key:`native/v1/${pack.trust.ciphertextSha256}.bin`,versionId:"immutable-v1"}};
    const bytes=Buffer.from(JSON.stringify({contract:NATIVE_HISTORICAL_CATALOG_CONTRACT,entries:[entry]}));
    return {entry,bytes,sha256:nativeArchiveByteDigest(bytes)};
  }
  it.each([false, true])("returns original shared row bytes through the actual compressed worker (%s)", async superseded => {
    const source = referencedInput(superseded), built = buildNativeCalibrationParentArchive(source.data);
    const pack = sealCompressedNativeHistoricalArchive(built.bundle, trusted(built), "fixture-key", key);
    const entry = { ...pack.trust, object: { bucket: "archive-fixture",
      key: `native/v2/${pack.trust.ciphertextSha256}.bin`, versionId: pack.trust.ciphertextSha256 } };
    const direct = openNativeHistoricalArchiveEvidence(pack.bytes, entry, key, request);
    const actualWorker = await verifyNativeHistoricalEvidenceInWorker(pack.bytes, key, entry, request, new AbortController().signal);
    expect(actualWorker).toEqual(direct);
    expect(direct).toMatchObject({ contractVersion: NATIVE_REFERENCE_HISTORICAL_EVIDENCE_CONTRACT,
      providerAuthority: false, currentDecisionEligible: false, reclaimEligible: false });
    expect(direct.rowJson.campaignContextObject).toBe(source.object);
    expect(direct.rowJson.campaignContextObject).toContain("9007199254740993.123456789");
    expect(direct.rowJson.evaluation).toContain('"campaign_context_json":null');
    expect(direct.rowJson.snapshot === null).toBe(superseded);
    expect(sealed().trust).not.toHaveProperty("encoding");
    const legacy = sealed(), original = openNativeHistoricalArchiveEvidence(legacy.bytes, legacy.trust, key, request);
    expect(original.contractVersion).toBe("decision-engine-v3-native-ad-historical-evidence.v1");
    expect(Object.keys(original.rowJson)).toEqual(["evaluation", "context", "inputEvidence", "snapshot"]);
  });
  it.each([false,true])("opens exact current/superseded original rows as historical only (%s)", superseded=>{
    const pack=sealed(superseded),index=catalog(pack);
    const pointer=resolveNativeHistoricalArchiveEntry(openNativeHistoricalArchiveCatalog(index.bytes,index.sha256),request);
    const result=openNativeHistoricalArchiveEvidence(pack.bytes,pointer,key,request);
    expect(result).toMatchObject({status:"historical_available",providerAuthority:false,currentDecisionEligible:false,reclaimEligible:false,generation});
    expect(JSON.parse(result.rowJson.evaluation).id).toBe("eval");
    expect(JSON.parse(result.rowJson.context).evaluated_at).toBe("2026-09-30T03:00:00Z");
    expect(result.rowJson.snapshot===null).toBe(superseded);
  });
  it("preserves large exact JSONB decimal text and microsecond clocks through encrypted packaging",()=>{
    const data=input();data.core.manifest.sourceWorkspaceDirty=false;
    data.tables[0]!.rowJson[0]=data.tables[0]!.rowJson[0]!.slice(0,-1)+',"source_provenance_json":{"decimal":9007199254740993.123456789}}';
    data.schema.tables[0]!.columns.push({name:"source_provenance_json",type:"jsonb",nullable:false});
    data.coreManifestHash=nativeArchiveByteDigest(stableCanonicalJson(data.core.manifest));
    const built=buildNativeCalibrationParentArchive(data),pack=sealNativeHistoricalArchive(built.bundle,trusted(built),"fixture-key",key);
    const {view}=openNativeHistoricalArchiveEnvelope(pack.bytes,pack.trust,key,generation);
    expect(view.readParentTable("engine_v3_ad_account_calibration_batches")[0]).toContain("9007199254740993.123456789");
    expect(view.readParentTable("engine_v3_ad_account_calibration_batches")[0]).toContain(clock);
  });
  it("retains dirty local fixture metadata but refuses runtime publication",()=>{
    const pack=sealed(false,true);
    expect(openNativeHistoricalArchiveEnvelope(pack.bytes,pack.trust,key,generation).bundle.manifest.sourceWorkspaceDirty).toBe(true);
    expect(()=>openNativeHistoricalArchiveEvidence(pack.bytes,pack.trust,key,request)).toThrow(/dirty published archive/);
  });
  it("uses a fresh random nonce for identical plaintext",()=>{
    const a=sealed(),b=sealed();expect(a.trust.plaintextSha256).toBe(b.trust.plaintextSha256);
    expect(a.trust.ciphertextSha256).not.toBe(b.trust.ciphertextSha256);
  });
  it.each(["key","nonce","tag","ciphertext","catalog-manifest","plaintext-hash"])("refuses encrypted integrity fault %s",fault=>{
    const pack=sealed(),body=Buffer.from(pack.bytes),trust={...pack.trust};let wrongKey=key;
    if(fault==="key") wrongKey=Buffer.alloc(32,0x42);
    // MAGIC is21 bytes, followed by12 nonce bytes and16 authentication-tag bytes.
    if(fault==="nonce" || fault==="tag" || fault==="ciphertext") {body[fault==="nonce"?32:fault==="tag"?33:body.length-1]^=1;trust.ciphertextSha256=nativeArchiveByteDigest(body);}
    if(fault==="catalog-manifest") trust.parentManifestHash="c".repeat(64);
    if(fault==="plaintext-hash") trust.plaintextSha256="d".repeat(64);
    expect(()=>openNativeHistoricalArchiveEvidence(body,trust,wrongKey,request)).toThrow();
  });
  it.each(["business","job","date","epoch","account","ad","evaluation"])("refuses foreign %s without current fallback",fault=>{
    const pack=sealed(),r={...request,generation:{...generation}};
    if(fault==="business") r.generation.businessId=id(99);
    if(fault==="job") r.generation.jobRunId=id(99);
    if(fault==="date") r.generation.asOfDate="2026-09-29";
    if(fault==="epoch") r.generation.engineVersion="foreign";
    if(fault==="account") r.providerAccountId="act_foreign";
    if(fault==="ad") r.adId="foreign";
    if(fault==="evaluation") r.evaluationId="foreign";
    expect(()=>openNativeHistoricalArchiveEvidence(pack.bytes,pack.trust,key,r)).toThrow(/refused/);
  });
  it("does not trust a downloaded catalog's own digest",()=>{
    const pack=sealed(),index=catalog(pack);
    expect(()=>openNativeHistoricalArchiveCatalog(index.bytes,"b".repeat(64))).toThrow(/catalog trust/);
  });
  it.each(["duplicate","null-version","key","size","encoding"])("refuses malformed trusted catalog %s",fault=>{
    const index=catalog(sealed()),raw=JSON.parse(index.bytes.toString());
    if(fault==="duplicate") raw.entries.push(raw.entries[0]);
    if(fault==="null-version") raw.entries[0].object.versionId="null";
    if(fault==="key") raw.entries[0].object.key="../../foreign";
    if(fault==="size") raw.entries[0].plaintextBytes=65*1024*1024;
    if(fault==="encoding") raw.contract="unknown";
    const bytes=Buffer.from(JSON.stringify(raw));
    expect(()=>openNativeHistoricalArchiveCatalog(bytes,nativeArchiveByteDigest(bytes))).toThrow(/refused/);
  });
  it.each([false,true])("runs the configured actual adapter through catalog, exact GET and decrypt (%s)",superseded=>{
    return runConfigured(superseded,false);
  });
  it("rejects a changed local trust file before any S3 GET",()=>runConfigured(false,true));
  async function runConfigured(superseded:boolean,corruptCatalog:boolean) {
    const pack=sealed(superseded),index=catalog(pack),temp=mkdtempSync(join(tmpdir(),"historical-reader-fixture-"));
    const file=join(temp,"trusted-index.json");writeFileSync(file,index.bytes,{mode:0o600});
    vi.stubEnv(NATIVE_HISTORICAL_READER_GATE,"true");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH",file);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256",corruptCatalog?"f".repeat(64):index.sha256);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID","fixture-key");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX",key.toString("hex"));
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_S3_ACCESS_KEY_ID","isolated-fixture-only");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_S3_SECRET_ACCESS_KEY","isolated-fixture-only");
    const send=vi.spyOn(S3Client.prototype,"send").mockResolvedValue({Body:Readable.from([pack.bytes]),ContentLength:pack.bytes.length,VersionId:index.entry.object.versionId} as never);
    try {
      const result=await readNativeHistoricalAdEvidence(request);
      if(corruptCatalog) {expect(result.status).toBe("unavailable");expect(send).not.toHaveBeenCalled();}
      else {expect(result.status).toBe("historical_available");expect(result).toMatchObject({providerAuthority:false,currentDecisionEligible:false,reclaimEligible:false});
        expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0]![0].input).toEqual({Bucket:index.entry.object.bucket,Key:index.entry.object.key,VersionId:index.entry.object.versionId});}
    } finally {send.mockRestore();vi.unstubAllEnvs();rmSync(temp,{recursive:true,force:true});}
  }
});
