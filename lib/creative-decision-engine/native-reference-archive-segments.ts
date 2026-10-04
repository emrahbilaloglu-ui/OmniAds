import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { stableCanonicalJson } from "./canonical-evaluation";
import { buildNativeReferenceArchiveSegment, isNativeArchiveSegmentContract, NATIVE_REFERENCE_ARCHIVE_CONTRACT,
  NATIVE_SUPERSEDED_REFERENCE_ARCHIVE_CONTRACT, NATIVE_REFERENCE_SEGMENT_CONTRACT,
  NATIVE_SUPERSEDED_REFERENCE_SEGMENT_CONTRACT, NATIVE_REFERENCE_ARCHIVE_TABLES,
  type NativeArchiveBundle, type NativeArchiveGeneration } from "./native-evidence-archive";
import { openNativeCalibrationParentArchive, projectNativeCalibrationParentsToSegment,
  NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT, NATIVE_CALIBRATION_PARENT_TABLES,
  type NativeCalibrationParentBundle } from "./native-calibration-parent-archive";

/** Explicit fragments of one complete original generation. This module has no
 * production DB/client, uploader, catalog switch, removal or provider authority. */
export interface NativeReferenceArchiveCoverageRoot {
  core: NativeArchiveBundle["manifest"];
  parent: NativeCalibrationParentBundle["manifest"];
}
export interface NativeReferenceArchiveSegment {
  bundle: NativeCalibrationParentBundle;
  manifestHash: string;
}
const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024; // existing offline whole-envelope ceiling; NOT runtime decompression
export const NATIVE_REFERENCE_ARCHIVE_MAX_SEGMENTS = 128; // shares catalog's total128-entry cap, never per group
const SHA = /^[0-9a-f]{64}$/;
function refuse(reason: string): never { throw new Error(`Native segmented archive refused: ${reason}`); }
function order(a: string,b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function digest(v: unknown) { return createHash("sha256").update(stableCanonicalJson(v),"utf8").digest("hex"); }
function row(raw: string): Record<string,unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("row object missing");
  return value as Record<string,unknown>;
}
function table(m: NativeArchiveBundle["manifest"], name: typeof NATIVE_REFERENCE_ARCHIVE_TABLES[number]) {
  return m.tables.find(t => t.table === name) ?? refuse("original table absent");
}
function same(a: unknown,b: unknown) {
  return a===undefined || b===undefined ? a===b : stableCanonicalJson(a) === stableCanonicalJson(b);
}
function evalIds(m: NativeArchiveBundle["manifest"]) {
  return table(m,"engine_v3_ad_decision_evaluations").rows.map(ref => {
    const parts: unknown = JSON.parse(ref.key);
    if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0] !== "string" || !parts[0].length || parts[0].length > 128)
      refuse("original evaluation identity invalid");
    return parts[0];
  }).sort(order);
}

export function nativeReferenceArchiveCoverageDigest(root: NativeReferenceArchiveCoverageRoot) { return digest(root); }

/** Metadata only. Full original bytes are verified before capture and again on
 * whole reassembly. This check NEVER claims live pin closure or source removal. */
export function verifyNativeReferenceArchiveCoverageRoot(root: NativeReferenceArchiveCoverageRoot, expectedDigest: string) {
  const c=root.core,p=root.parent;
  if (!SHA.test(expectedDigest) || digest(root)!==expectedDigest ||
    (c.contract!==NATIVE_REFERENCE_ARCHIVE_CONTRACT && c.contract!==NATIVE_SUPERSEDED_REFERENCE_ARCHIVE_CONTRACT) || c.segment!==undefined ||
    p.contract!==NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT ||
    p.coreManifestHash!==digest(c) || p.coreSchemaHash!==c.schemaHash || digest(c.schema)!==c.schemaHash || digest(p.schema)!==p.schemaHash ||
    !same(c.generation,p.generation) || c.sourceRevision!==p.sourceRevision || c.sourceWorkspaceDirty!==p.sourceWorkspaceDirty ||
    c.capturedAt!==p.capturedAt || c.providerAuthority!==false || c.reclaimEligible!==false ||
    p.providerAuthority!==false || p.reclaimEligible!==false ||
    p.coverage!=="core_referenced_complete_calibration_batches" ||
    c.coverage!==(c.contract===NATIVE_REFERENCE_ARCHIVE_CONTRACT ? "sampled_native_reference_generation_core" : "superseded_native_reference_generation_core"))
    refuse("original coverage root differs");
  if (c.tables.length!==NATIVE_REFERENCE_ARCHIVE_TABLES.length || new Set(c.tables.map(t=>t.table)).size!==c.tables.length ||
    NATIVE_REFERENCE_ARCHIVE_TABLES.some(name=>!c.tables.some(t=>t.table===name)) ||
    c.schema.tables.length!==c.tables.length || new Set(c.schema.tables.map(t=>t.table)).size!==c.tables.length ||
    NATIVE_REFERENCE_ARCHIVE_TABLES.some(name=>!c.schema.tables.some(t=>t.table===name)) ||
    p.tables.length!==NATIVE_CALIBRATION_PARENT_TABLES.length || new Set(p.tables.map(t=>t.table)).size!==p.tables.length ||
    NATIVE_CALIBRATION_PARENT_TABLES.some(name=>!p.tables.some(t=>t.table===name)) ||
    p.schema.tables.length!==p.tables.length || new Set(p.schema.tables.map(t=>t.table)).size!==p.tables.length ||
    NATIVE_CALIBRATION_PARENT_TABLES.some(name=>!p.schema.tables.some(t=>t.table===name))) refuse("original table inventory differs");
  for (const t of [...c.tables,...p.tables]) {
    if (!Number.isSafeInteger(t.rowCount) || t.rowCount<0 || t.rows.length!==t.rowCount ||
      t.rows.some(r=>!SHA.test(r.objectHash)) || new Set(t.rows.map(r=>"key" in r ? r.key : r.id)).size!==t.rows.length)
      refuse("original metadata count/identity differs");
  }
  const ids=evalIds(c);
  if (!ids.length || new Set(ids).size!==ids.length || table(c,"engine_v3_job_runs").rowCount!==1 ||
    table(c,"engine_v3_ad_decision_snapshots_daily").rowCount!==(c.contract===NATIVE_REFERENCE_ARCHIVE_CONTRACT ? ids.length : 0))
    refuse("original complete cardinality differs");
  return ids;
}

export function assertNativeReferenceSegmentMatchesRoot(part: NativeCalibrationParentBundle, root: NativeReferenceArchiveCoverageRoot,
  expectedRootDigest: string) {
  const ids=verifyNativeReferenceArchiveCoverageRoot(root,expectedRootDigest), c=part.core.manifest,s=c.segment;
  const expectedContract=root.core.contract===NATIVE_REFERENCE_ARCHIVE_CONTRACT ? NATIVE_REFERENCE_SEGMENT_CONTRACT : NATIVE_SUPERSEDED_REFERENCE_SEGMENT_CONTRACT;
  if (c.contract!==expectedContract || !s || s.originalCoreManifestHash!==digest(root.core) ||
    s.originalParentManifestHash!==digest(root.parent) || s.originalEvaluationCount!==ids.length ||
    s.evaluationIds.some(id=>!ids.includes(id))) refuse("fragment original identity differs");
  for (const [original,selected] of [[root.core,c],[root.parent,part.manifest]] as const) {
    if (original.schemaHash!==selected.schemaHash || !same(original.schema,selected.schema) ||
      original.sourceRevision!==selected.sourceRevision || original.sourceWorkspaceDirty!==selected.sourceWorkspaceDirty ||
      original.capturedAt!==selected.capturedAt || !same(original.generation,selected.generation)) refuse("fragment source/schema/clock differs");
  }
  if (!same(root.core.pinCensus,c.pinCensus)) refuse("fragment census differs");
  for (const [original,selected] of [[root.core.tables,c.tables],[root.parent.tables,part.manifest.tables]] as const) {
    for (const t of selected) {
      const full=original.find(f=>f.table===t.table) ?? refuse("foreign fragment table");
      const refs=new Set(full.rows.map(r=>stableCanonicalJson(r)));
      if (t.rows.some(r=>!refs.has(stableCanonicalJson(r)))) refuse("fragment changed original row metadata");
    }
  }
  const roots=new Set(root.parent.externalIdentityRoots.map(r=>stableCanonicalJson(r)));
  if (part.manifest.externalIdentityRoots.some(r=>!roots.has(stableCanonicalJson(r)))) refuse("foreign fragment account root");
  openNativeCalibrationParentArchive(part,{manifestHash:digest(part.manifest),schemaHash:part.manifest.schemaHash,generation:part.manifest.generation});
}

export function projectNativeReferenceArchiveSegment(original: NativeCalibrationParentBundle, expected: {
  manifestHash: string; schemaHash: string; generation: NativeArchiveGeneration;
}, selectedIds: string[]): NativeReferenceArchiveSegment {
  if (isNativeArchiveSegmentContract(original.core.manifest.contract)) refuse("complete original required");
  const view=openNativeCalibrationParentArchive(original,expected);
  const root={core:original.core.manifest,parent:original.manifest};
  const originalIds=verifyNativeReferenceArchiveCoverageRoot(root,digest(root));
  const ids=[...selectedIds].sort(order), selected=new Set(ids);
  if (!ids.length || selected.size!==ids.length || ids.some(id=>!originalIds.includes(id))) refuse("selected evaluation absent/duplicate");
  const evaluations=view.readCoreTable("engine_v3_ad_decision_evaluations").filter(copy=>selected.has(String(row(copy.rowJson).id)));
  const contexts=new Set(evaluations.map(copy=>row(copy.rowJson).context_id));
  const evidence=new Set(evaluations.map(copy=>{ const r=row(copy.rowJson);return stableCanonicalJson([r.contract_version,r.input_hash]); }));
  const shared=new Set<unknown>(evaluations.map(copy=>row(copy.rowJson).campaign_context_ref).filter(ref=>ref!==null && ref!==undefined));
  const tables=NATIVE_REFERENCE_ARCHIVE_TABLES.map(name=>({table:name,rowJson:view.readCoreTable(name).filter(copy=>{
    const r=row(copy.rowJson);
    if(name==="engine_v3_job_runs") return true;
    if(name==="engine_v3_ad_decision_evaluations") return selected.has(String(r.id));
    if(name==="engine_v3_ad_decision_evaluation_contexts") return contexts.has(r.id);
    if(name==="engine_v3_ad_decision_input_evidence") return evidence.has(stableCanonicalJson([r.contract_version,r.input_hash]));
    if(name==="engine_v3_ad_decision_snapshots_daily") return selected.has(String(r.evaluation_id));
    return shared.has(r.payload_sha256);
  }).map(copy=>copy.rowJson)}));
  const c=original.core.manifest;
  const core=buildNativeReferenceArchiveSegment({generation:c.generation,capturedAt:c.capturedAt,sourceRevision:c.sourceRevision,
    sourceWorkspaceDirty:c.sourceWorkspaceDirty,schema:c.schema,tables,...(c.pinCensus?{pinCensus:c.pinCensus}:{}),
    segment:{originalCoreManifestHash:digest(c),originalParentManifestHash:expected.manifestHash,
      originalEvaluationCount:originalIds.length,evaluationIds:ids}});
  const projected=projectNativeCalibrationParentsToSegment(original,expected,core.bundle);
  assertNativeReferenceSegmentMatchesRoot(projected.bundle,root,digest(root));
  return projected;
}

/** Actual byte measurements, not a fixed row-count heuristic. Bisection is
 * bounded by128 parts; an oversized single dependency closure refuses whole
 * capture. Smaller bounds are permitted for fault fixtures, never larger ones. */
export function splitNativeReferenceArchive(original: NativeCalibrationParentBundle, expected: {
  manifestHash:string;schemaHash:string;generation:NativeArchiveGeneration;
}, limits={decodedBytes:8*1024*1024,compressedBytes:2*1024*1024}) {
  if (!Number.isSafeInteger(limits.decodedBytes)||limits.decodedBytes<=0||limits.decodedBytes>8*1024*1024||
    !Number.isSafeInteger(limits.compressedBytes)||limits.compressedBytes<=0||limits.compressedBytes>2*1024*1024 ||
    Buffer.byteLength(JSON.stringify(original),"utf8")>MAX_ORIGINAL_BYTES) refuse("offline/transport size bound");
  openNativeCalibrationParentArchive(original,expected);
  const root={core:original.core.manifest,parent:original.manifest}, rootDigest=digest(root);
  const ids=verifyNativeReferenceArchiveCoverageRoot(root,rootDigest);
  const parts:NativeReferenceArchiveSegment[]=[],pending=[ids];
  while(pending.length) {
    const selection=pending.shift()!, part=projectNativeReferenceArchiveSegment(original,expected,selection);
    const bytes=Buffer.from(JSON.stringify(part.bundle),"utf8");
    const fits=bytes.length<=limits.decodedBytes && gzipSync(bytes,{level:6}).length<=limits.compressedBytes;
    if(fits) parts.push(part);
    else {
      if(selection.length===1) refuse("single original evidence/parent closure exceeds transport bound");
      const mid=Math.floor(selection.length/2);pending.unshift(selection.slice(0,mid),selection.slice(mid));
    }
    if(parts.length+pending.length>NATIVE_REFERENCE_ARCHIVE_MAX_SEGMENTS) refuse("total fragment count bound");
  }
  return {root,rootDigest,parts};
}

/** Completeness proof is ALL fragments and exact original inventories. A sample
 * or single requested evaluation cannot be mislabeled a whole restored unit. */
export function reassembleNativeReferenceArchive(parts: NativeCalibrationParentBundle[], root:NativeReferenceArchiveCoverageRoot,
  expectedRootDigest:string) {
  const ids=verifyNativeReferenceArchiveCoverageRoot(root,expectedRootDigest);
  if(!parts.length||parts.length>NATIVE_REFERENCE_ARCHIVE_MAX_SEGMENTS) refuse("fragment count bound");
  const selected=new Set<string>(),coreObjects:Record<string,string>={},parentObjects:Record<string,string>={};
  const merge=(into:Record<string,string>,from:Record<string,string>)=>{
    for(const [hash,bytes] of Object.entries(from)) {
      if(into[hash]!==undefined && into[hash]!==bytes) refuse("repeated original object differs");
      into[hash]=bytes;
    }
  };
  for(const part of parts) {
    assertNativeReferenceSegmentMatchesRoot(part,root,expectedRootDigest);
    for(const id of part.core.manifest.segment!.evaluationIds) {
      if(selected.has(id)) refuse("overlapping fragment evaluation");selected.add(id);
    }
    merge(coreObjects,part.core.objects);merge(parentObjects,part.objects);
  }
  if(!same([...selected].sort(order),ids)) refuse("whole original coverage incomplete");
  const bundle:NativeCalibrationParentBundle={core:{manifest:root.core,objects:coreObjects},manifest:root.parent,objects:parentObjects};
  if(Buffer.byteLength(JSON.stringify(bundle),"utf8")>MAX_ORIGINAL_BYTES) refuse("offline reconstructed size bound");
  const view=openNativeCalibrationParentArchive(bundle,{manifestHash:digest(root.parent),schemaHash:root.parent.schemaHash,generation:root.parent.generation});
  return {bundle,view,manifestHash:digest(root.parent),authority:"historical_read_only" as const,providerAuthority:false as const,reclaimEligible:false as const};
}
