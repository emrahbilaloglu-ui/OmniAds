import { readFileSync,writeFileSync } from "node:fs";
import { originalJsonbMemberText } from "@/lib/creative-decision-engine/native-campaign-context-archive";
import { buildNativeReferenceEvidenceArchive,NATIVE_REFERENCE_ARCHIVE_TABLES } from "@/lib/creative-decision-engine/native-evidence-archive";
import { buildNativeCalibrationParentArchive,NATIVE_CALIBRATION_PARENT_TABLES } from "@/lib/creative-decision-engine/native-calibration-parent-archive";
import { openNativeHistoricalArchiveEnvelope,sealCompressedNativeHistoricalArchive } from "@/lib/creative-decision-engine/native-historical-archive";
import { projectNativeReferenceArchiveSegment,nativeReferenceArchiveCoverageDigest } from "@/lib/creative-decision-engine/native-reference-archive-segments";

// Public synthetic original built BEFORE archival. No production rows/key,
// actual-producer, natural reuse, whole restore or storage-relief claim.
const fixture=JSON.parse(readFileSync("scripts/fixtures/native-historical-worker-reference.json","utf8"));
const key=Buffer.from(fixture.fixtureEncryptionKeyHex,"hex");
const source=openNativeHistoricalArchiveEnvelope(Buffer.from(fixture.ciphertextBase64,"base64"),fixture.entry,key,fixture.request.generation);
const ids=["00000000-0000-4000-8000-000000000101","00000000-0000-4000-8000-000000000102"];
const rewrite=(raw:string,changes:Record<string,unknown>)=>'{'+Object.keys(JSON.parse(raw)).map(k=>
  JSON.stringify(k)+': '+(k in changes?JSON.stringify(changes[k]):originalJsonbMemberText(raw,k))).join(', ')+'}';
const tables=NATIVE_REFERENCE_ARCHIVE_TABLES.map(table=>{
  const raw=source.view.readCoreTable(table).map(r=>r.rowJson);
  if(table==="engine_v3_job_runs")return {table,rowJson:raw.map(r=>rewrite(r,{row_count:2}))};
  if(table==="engine_v3_ad_decision_evaluations")return {table,rowJson:ids.map(id=>rewrite(raw[0]!,{id}))};
  if(table==="engine_v3_ad_decision_snapshots_daily")return {table,rowJson:ids.map((id,index)=>rewrite(raw[0]!,{
    id:`00000000-0000-4000-8000-00000000020${index+1}`,evaluation_id:id,
  }))};
  return {table,rowJson:raw};
});
const cm=source.bundle.core.manifest;
const core=buildNativeReferenceEvidenceArchive({generation:cm.generation,capturedAt:cm.capturedAt,sourceRevision:cm.sourceRevision,
  sourceWorkspaceDirty:cm.sourceWorkspaceDirty,schema:cm.schema,tables});
const original=buildNativeCalibrationParentArchive({core:core.bundle,coreManifestHash:core.manifestHash,schema:source.bundle.manifest.schema,
  tables:NATIVE_CALIBRATION_PARENT_TABLES.map(table=>({table,rowJson:source.view.readParentTable(table)}))});
const root={core:original.bundle.core.manifest,parent:original.bundle.manifest};
const part=projectNativeReferenceArchiveSegment(original.bundle,{manifestHash:original.manifestHash,
  schemaHash:original.bundle.manifest.schemaHash,generation:cm.generation},[ids[0]!]);
const sealed=sealCompressedNativeHistoricalArchive(part.bundle,{manifestHash:part.manifestHash,schemaHash:part.bundle.manifest.schemaHash,
  generation:cm.generation},fixture.entry.encryptionKeyId,key,{coverageRoot:root,coverageRootSha256:nativeReferenceArchiveCoverageDigest(root),evaluationIds:[ids[0]!]});
const entry={...sealed.trust,object:{bucket:"archive-fixture",key:`native/v2/${sealed.trust.ciphertextSha256}.bin`,versionId:sealed.trust.ciphertextSha256}};
// Independent original-row oracle. Do NOT compute expectedEvidence by calling
// the fragment historical-response implementation being packaged.
const expectedEvidence=structuredClone(fixture.expectedEvidence);
expectedEvidence.identity.evaluationId=ids[0]!;
expectedEvidence.rowJson.evaluation=tables.find(t=>t.table==="engine_v3_ad_decision_evaluations")!.rowJson[0];
expectedEvidence.rowJson.snapshot=tables.find(t=>t.table==="engine_v3_ad_decision_snapshots_daily")!.rowJson[0];
const value={syntheticFixtureOnly:true,canonicalProducerProof:false,wholeGenerationRestoreProof:false,
  fixtureEncryptionKeyHex:fixture.fixtureEncryptionKeyHex,ciphertextBase64:sealed.bytes.toString("base64"),entry,
  request:{...fixture.request,evaluationId:ids[0]},expectedEvidence};
writeFileSync("scripts/fixtures/native-historical-worker-segmented-reference.json",JSON.stringify(value,null,2)+"\n");
console.log(JSON.stringify({syntheticFixtureOnly:true,originalEvaluationCount:2,selectedEvaluationCount:1,
  originalReceiptRewritten:false,decodedBytes:entry.plaintextBytes,ciphertextBytes:entry.ciphertextBytes,providerAuthority:false}));
