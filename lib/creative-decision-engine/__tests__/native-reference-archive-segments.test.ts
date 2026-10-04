import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stableCanonicalJson } from "../canonical-evaluation";
import { originalJsonbMemberText } from "../native-campaign-context-archive";
import { buildNativeReferenceEvidenceArchive, openNativeArchiveByContract, NATIVE_REFERENCE_ARCHIVE_TABLES,
  NATIVE_REFERENCE_ARCHIVE_CONTRACT, type NativeArchiveBundle } from "../native-evidence-archive";
import { buildNativeCalibrationParentArchive, NATIVE_CALIBRATION_PARENT_TABLES } from "../native-calibration-parent-archive";
import { nativeArchiveByteDigest, openNativeHistoricalArchiveEnvelope, openNativeHistoricalArchiveEvidence,
  sealCompressedNativeHistoricalArchive, openNativeHistoricalArchiveCatalog, resolveNativeHistoricalArchiveEntry,
  NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT, type NativeHistoricalArchiveCatalogEntry } from "../native-historical-archive";
import { projectNativeReferenceArchiveSegment, splitNativeReferenceArchive, reassembleNativeReferenceArchive,
  nativeReferenceArchiveCoverageDigest, assertNativeReferenceSegmentMatchesRoot } from "../native-reference-archive-segments";

// Public synthetic fixture; no production key/rows or canonical-producer claim.
const fixture=JSON.parse(readFileSync(resolve("scripts/fixtures/native-historical-worker-reference.json"),"utf8"));
const key=Buffer.from(fixture.fixtureEncryptionKeyHex,"hex");
const uuid=(n:number)=>`00000000-0000-4000-9000-${String(n).padStart(12,"0")}`;
const sha=(v:unknown)=>nativeArchiveByteDigest(stableCanonicalJson(v));
/** Construct the synthetic original BEFORE capture. Preserve every untouched
 * raw member (including arbitrary-precision numbers) without JS numeric output. */
function originalFixture(count=4,sourceWorkspaceDirty=false) {
  const opened=openNativeHistoricalArchiveEnvelope(Buffer.from(fixture.ciphertextBase64,"base64"),fixture.entry,key,fixture.request.generation);
  const rewrite=(raw:string,changes:Record<string,unknown>)=>'{'+Object.keys(JSON.parse(raw)).map(k=>
    JSON.stringify(k)+': '+(k in changes?JSON.stringify(changes[k]):originalJsonbMemberText(raw,k))).join(', ')+'}';
  const tables=NATIVE_REFERENCE_ARCHIVE_TABLES.map(table=>{
    const copies=opened.view.readCoreTable(table).map(r=>r.rowJson);
    let rowJson=copies;
    if(table==="engine_v3_job_runs")rowJson=copies.map(raw=>rewrite(raw,{row_count:count}));
    if(table==="engine_v3_ad_decision_evaluations")rowJson=Array.from({length:count},(_,i)=>rewrite(copies[0]!,{
      id:uuid(i+100),ad_id:`fixture-ad-${i}`,decision_entity_id:`fixture-ad-${i}`,
    }));
    if(table==="engine_v3_ad_decision_snapshots_daily")rowJson=Array.from({length:count},(_,i)=>rewrite(copies[0]!,{
      id:uuid(i+1000),evaluation_id:uuid(i+100),ad_id:`fixture-ad-${i}`,decision_entity_id:`fixture-ad-${i}`,
    }));
    return {table,rowJson};
  });
  const cm=opened.bundle.core.manifest;
  const core=buildNativeReferenceEvidenceArchive({generation:cm.generation,capturedAt:cm.capturedAt,sourceRevision:cm.sourceRevision,
    sourceWorkspaceDirty,schema:cm.schema,tables});
  const full=buildNativeCalibrationParentArchive({core:core.bundle,coreManifestHash:core.manifestHash,schema:opened.bundle.manifest.schema,
    tables:NATIVE_CALIBRATION_PARENT_TABLES.map(table=>({table,rowJson:opened.view.readParentTable(table)}))});
  const expected={manifestHash:full.manifestHash,schemaHash:full.bundle.manifest.schemaHash,generation:cm.generation};
  const root={core:full.bundle.core.manifest,parent:full.bundle.manifest},rootDigest=nativeReferenceArchiveCoverageDigest(root);
  const ids=Array.from({length:count},(_,i)=>uuid(i+100));
  return {full,expected,root,rootDigest,ids};
}
function parts(source:ReturnType<typeof originalFixture>) {
  const midpoint=Math.floor(source.ids.length/2);
  return [source.ids.slice(0,midpoint),source.ids.slice(midpoint)].map(ids=>projectNativeReferenceArchiveSegment(source.full.bundle,source.expected,ids));
}
function catalog(source:ReturnType<typeof originalFixture>) {
  const fragments=parts(source);
  const sealed=fragments.map(part=>sealCompressedNativeHistoricalArchive(part.bundle,{manifestHash:part.manifestHash,
    schemaHash:part.bundle.manifest.schemaHash,generation:source.expected.generation},"public-fixture",key,{
    coverageRoot:source.root,coverageRootSha256:source.rootDigest,evaluationIds:part.bundle.core.manifest.segment!.evaluationIds,
  }));
  const entries=sealed.map((blob,i)=>({ ...blob.trust,
    segment:{coverageRootSha256:source.rootDigest,evaluationIds:blob.trust.segment!.evaluationIds},
    object:{bucket:"native-offline.test",key:`native/v2/${blob.trust.ciphertextSha256}.bin`,versionId:`fixture-${i}`},
  }));
  const raw={contract:NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT,entries,groups:[{
    coverageRoot:source.root,coverageRootSha256:source.rootDigest,
  }]};
  const bytes=Buffer.from(JSON.stringify(raw)),opened=openNativeHistoricalArchiveCatalog(bytes,nativeArchiveByteDigest(bytes));
  return {fragments,sealed,raw,opened};
}

describe("bounded original-reference fragments",()=>{
  it("preserves original row_count and labels the selected subset explicitly",()=>{
    const s=originalFixture(),p=parts(s)[0]!,m=p.bundle.core.manifest;
    expect(m.contract).toBe("native-generation-reference-segment.v1");
    expect(m.coverage).toBe("selected_native_reference_segment");
    expect(m.segment).toMatchObject({originalEvaluationCount:4,evaluationIds:s.ids.slice(0,2)});
    const v=openNativeArchiveByContract(p.bundle.core,{manifestHash:sha(m),schemaHash:m.schemaHash,generation:m.generation});
    expect(JSON.parse(v.readTable("engine_v3_job_runs")[0]!.rowJson).row_count).toBe(4);
    expect(v.readTable("engine_v3_ad_decision_evaluations")).toHaveLength(2);
    expect(v).toMatchObject({providerAuthority:false,reclaimEligible:false,authority:"historical_read_only"});
  });
  it("does not weaken the original complete-generation cardinality check",()=>{
    const s=originalFixture(),partial=structuredClone(parts(s)[0]!.bundle.core);
    partial.manifest.contract=NATIVE_REFERENCE_ARCHIVE_CONTRACT;
    partial.manifest.coverage="sampled_native_reference_generation_core";
    delete partial.manifest.segment;
    expect(()=>openNativeArchiveByContract(partial,{manifestHash:sha(partial.manifest),schemaHash:partial.manifest.schemaHash,
      generation:partial.manifest.generation})).toThrow(/incomplete original generation/);
  });
  it("reassembles ALL original six/eight-table inventories and clocks byte-for-byte",()=>{
    const s=originalFixture(),p=parts(s),r=reassembleNativeReferenceArchive(p.map(x=>x.bundle),s.root,s.rootDigest);
    expect(r.bundle).toEqual(s.full.bundle);
    expect(r.manifestHash).toBe(s.full.manifestHash);
    expect(r.view.originalJobRunId).toBe(s.expected.generation.jobRunId);
    expect(r.view).toMatchObject({providerAuthority:false,reclaimEligible:false});
    const raw=r.view.readCampaignContext(s.ids[3]!)!.objectRowJson!;
    expect(raw).toContain("9007199254740993.123456789");
    expect(raw).toContain("İstanbul");expect(raw).toContain("🚀");
  });
  it("keeps complete original calibration batches even when a fragment selects one evaluation",()=>{
    const s=originalFixture(),p=projectNativeReferenceArchiveSegment(s.full.bundle,s.expected,[s.ids[0]!]);
    for(const name of NATIVE_CALIBRATION_PARENT_TABLES) {
      const original=s.full.bundle.manifest.tables.find(t=>t.table===name)!;
      expect(p.bundle.manifest.tables.find(t=>t.table===name)!.rows).toEqual(original.rows);
    }
    expect(p.bundle.manifest.contract).toBe("native-calibration-reference-segment-parent-archive.v1");
  });
  it.each(["missing","overlap"])("refuses %s whole-generation coverage",kind=>{
    const s=originalFixture(),p=parts(s).map(x=>x.bundle);
    expect(()=>reassembleNativeReferenceArchive(kind==="missing"?[p[0]!]:[p[0]!,p[0]!,p[1]!],s.root,s.rootDigest))
      .toThrow(/incomplete|overlapping/);
  });
  it("refuses absent/duplicate selection and a fragment passed as a whole capture",()=>{
    const s=originalFixture();
    expect(()=>projectNativeReferenceArchiveSegment(s.full.bundle,s.expected,[uuid(99999)])).toThrow(/absent/);
    expect(()=>projectNativeReferenceArchiveSegment(s.full.bundle,s.expected,[s.ids[0]!,s.ids[0]!])).toThrow(/duplicate/);
    const p=parts(s)[0]!;
    expect(()=>projectNativeReferenceArchiveSegment(p.bundle,{...s.expected,manifestHash:p.manifestHash},[s.ids[0]!])).toThrow(/complete original/);
  });
  it("refuses changed original count/root/schema/clock and raw corruption",()=>{
    const s=originalFixture(),p=parts(s)[0]!;
    for(const mutate of [
      (c:NativeArchiveBundle)=>{c.manifest.segment!.originalEvaluationCount=5;},
      (c:NativeArchiveBundle)=>{c.manifest.segment!.originalCoreManifestHash="f".repeat(64);},
      (c:NativeArchiveBundle)=>{c.manifest.capturedAt="2026-10-04T00:00:00Z";},
      (c:NativeArchiveBundle)=>{const h=Object.keys(c.objects)[0]!;c.objects[h]+=" ";},
    ]) {
      const damaged=structuredClone(p.bundle);mutate(damaged.core);
      expect(()=>assertNativeReferenceSegmentMatchesRoot(damaged,s.root,s.rootDigest)).toThrow(/differs|corrupt/);
    }
  });
  it("partitions by actual decoded/compressed bytes and retains exact whole reassembly",()=>{
    const s=originalFixture(16),single=projectNativeReferenceArchiveSegment(s.full.bundle,s.expected,[s.ids[0]!]);
    const bound=Buffer.byteLength(JSON.stringify(single.bundle))+400;
    const result=splitNativeReferenceArchive(s.full.bundle,s.expected,{decodedBytes:bound,compressedBytes:2*1024*1024});
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.parts.every(p=>Buffer.byteLength(JSON.stringify(p.bundle))<=bound)).toBe(true);
    expect(reassembleNativeReferenceArchive(result.parts.map(p=>p.bundle),result.root,result.rootDigest).bundle).toEqual(s.full.bundle);
  });
  it("refuses a single oversized dependency closure and any requested cap increase",()=>{
    const s=originalFixture();
    expect(()=>splitNativeReferenceArchive(s.full.bundle,s.expected,{decodedBytes:1,compressedBytes:2*1024*1024}))
      .toThrow(/single original evidence\/parent closure/);
    expect(()=>splitNativeReferenceArchive(s.full.bundle,s.expected,{decodedBytes:8*1024*1024+1,compressedBytes:2*1024*1024}))
      .toThrow(/bound/);
    expect(()=>splitNativeReferenceArchive(s.full.bundle,s.expected,{decodedBytes:8*1024*1024,compressedBytes:1}))
      .toThrow(/single original evidence\/parent closure/);
  });
});

describe("explicit v3 catalog and bounded single-object evidence",()=>{
  it("resolves exact evaluation membership to one object and preserves original historical response",()=>{
    const s=originalFixture(),c=catalog(s),request={...fixture.request,evaluationId:s.ids[3],adId:"fixture-ad-3"};
    const entry=resolveNativeHistoricalArchiveEntry(c.opened,request);
    expect(entry.ciphertextSha256).toBe(c.sealed[1]!.trust.ciphertextSha256);
    const evidence=openNativeHistoricalArchiveEvidence(c.sealed[1]!.bytes,entry,key,request);
    expect(evidence).toMatchObject({status:"historical_available",contractVersion:"decision-engine-v3-native-ad-historical-evidence.v2",
      authority:"historical_read_only",providerAuthority:false,currentDecisionEligible:false,reclaimEligible:false});
    const original=s.full.bundle.core.manifest.tables.find(t=>t.table==="engine_v3_ad_decision_evaluations")!.rows[3]!;
    expect(evidence.rowJson.evaluation).toBe(s.full.bundle.core.objects[original.objectHash]);
    expect(evidence.rowJson.campaignContextObject).toContain("9007199254740993.123456789");
    expect(()=>resolveNativeHistoricalArchiveEntry(c.opened,{...request,evaluationId:uuid(99999)})).toThrow(/absent/);
    expect(()=>openNativeHistoricalArchiveEvidence(c.sealed[1]!.bytes,entry,key,{...request,providerAccountId:"foreign-account"})).toThrow(/absent/);
  });
  it("requires independently bound fragment trust, with selection and coverage in GCM AAD",()=>{
    const s=originalFixture(),c=catalog(s),p=c.fragments[0]!;
    expect(()=>sealCompressedNativeHistoricalArchive(p.bundle,{manifestHash:p.manifestHash,schemaHash:p.bundle.manifest.schemaHash,
      generation:s.expected.generation},"public-fixture",key)).toThrow(/explicit fragment trust/);
    const damaged=structuredClone(c.sealed[0]!.trust);damaged.segment!.evaluationIds=s.ids.slice(2);
    expect(()=>openNativeHistoricalArchiveEnvelope(c.sealed[0]!.bytes,damaged,key,s.expected.generation)).toThrow();
  });
  it.each(["missing","overlap","legacy","whole-mix","wrong-root","repeat-root"])("refuses %s catalog publication",kind=>{
    const s=originalFixture(),c=catalog(s),bad=structuredClone(c.raw);
    if(kind==="missing")bad.entries.pop();
    if(kind==="overlap")bad.entries[1]!.segment.evaluationIds=bad.entries[0]!.segment.evaluationIds;
    if(kind==="legacy")bad.contract="native-historical-archive-catalog.v2" as typeof bad.contract;
    if(kind==="whole-mix")bad.entries[1]={...fixture.entry,segment:undefined} as typeof bad.entries[number];
    if(kind==="wrong-root")bad.entries[1]!.segment.coverageRootSha256="f".repeat(64);
    if(kind==="repeat-root")bad.groups.push(bad.groups[0]!);
    const bytes=Buffer.from(JSON.stringify(bad));expect(()=>openNativeHistoricalArchiveCatalog(bytes,nativeArchiveByteDigest(bytes))).toThrow(/refused/);
  });
  it("keeps the original duplicate-generation and foreign fragment selection refusal",()=>{
    const raw={contract:"native-historical-archive-catalog.v2",entries:[fixture.entry,fixture.entry]};
    const bytes=Buffer.from(JSON.stringify(raw));
    expect(()=>openNativeHistoricalArchiveCatalog(bytes,nativeArchiveByteDigest(bytes))).toThrow(/ambiguous generation/);
    const s=originalFixture(),c=catalog(s);
    const entry=resolveNativeHistoricalArchiveEntry(c.opened,{...fixture.request,evaluationId:s.ids[0]!,adId:"fixture-ad-0"});
    const foreign={...entry,segment:{...entry.segment!,evaluationIds:[s.ids[3]!]}} as NativeHistoricalArchiveCatalogEntry;
    expect(()=>openNativeHistoricalArchiveEnvelope(c.sealed[0]!.bytes,foreign,key,s.expected.generation)).toThrow();
  });
  it("permits offline dirty-source restore but refuses it as a published historical response",()=>{
    const s=originalFixture(4,true),c=catalog(s),request={...fixture.request,evaluationId:s.ids[0],adId:"fixture-ad-0"};
    const entry=resolveNativeHistoricalArchiveEntry(c.opened,request);
    expect(openNativeHistoricalArchiveEnvelope(c.sealed[0]!.bytes,entry,key,s.expected.generation).bundle.manifest.sourceWorkspaceDirty).toBe(true);
    expect(()=>openNativeHistoricalArchiveEvidence(c.sealed[0]!.bytes,entry,key,request)).toThrow(/dirty published/);
  });
  it("does not lift the total128-entry or1MiB catalog bound",()=>{
    const s=originalFixture(),c=catalog(s);
    const cases=[{...c.raw,entries:Array.from({length:129},()=>c.raw.entries[0])},
      {...c.raw,ignoredPadding:"x".repeat(1024*1024)}];
    for(const raw of cases) {
      const bytes=Buffer.from(JSON.stringify(raw));
      expect(()=>openNativeHistoricalArchiveCatalog(bytes,nativeArchiveByteDigest(bytes))).toThrow(/bound|count/);
    }
  });
});
