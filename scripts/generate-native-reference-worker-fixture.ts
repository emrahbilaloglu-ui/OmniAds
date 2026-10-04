import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { buildNativeReferenceEvidenceArchive } from "@/lib/creative-decision-engine/native-evidence-archive";
import { buildNativeCalibrationParentArchive } from "@/lib/creative-decision-engine/native-calibration-parent-archive";
import { NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION } from "@/lib/creative-decision-engine/native-campaign-context-storage";
import { openNativeHistoricalArchiveEnvelope, openNativeHistoricalArchiveEvidence,
  sealCompressedNativeHistoricalArchive } from "@/lib/creative-decision-engine/native-historical-archive";

// Public fixture only. This serializer/packaged-worker witness does not claim
// an actual canonical producer, production capture, natural reuse or storage relief.
const original = JSON.parse(readFileSync("scripts/fixtures/native-historical-worker.json", "utf8"));
const key = Buffer.from(original.fixtureEncryptionKeyHex, "hex");
const parent = openNativeHistoricalArchiveEnvelope(Buffer.from(original.ciphertextBase64, "base64"), original.entry,
  key, original.request.generation).bundle;
const payload = '{"decimal": 9007199254740993.123456789, "nested": {"text": "İstanbul şğı 🚀 public reference fixture"}}';
const digest = createHash("sha256").update(payload).digest("hex");
const object = JSON.stringify({ business_ref_id: original.request.generation.businessId, payload_sha256: "\\x" + digest,
  payload_json: "__ORIGINAL__", storage_encoding_version: NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION,
  byte_length: Buffer.byteLength(payload), created_at: "2026-09-30T02:00:00.000001+00:00" }).replace('"__ORIGINAL__"', payload);
const tables = parent.core.manifest.tables.map(table => ({ table: table.table, rowJson: table.rows.map(ref => {
  const raw = parent.core.objects[ref.objectHash]!;
  return table.table === "engine_v3_ad_decision_evaluations" ? JSON.stringify({ ...JSON.parse(raw),
    campaign_context_json: null, campaign_context_ref: "\\x" + digest }) : raw;
}) }));
tables.push({ table: NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE, rowJson: [object] });
const schema = structuredClone(parent.core.manifest.schema);
schema.tables.find(table => table.table === "engine_v3_ad_decision_evaluations")!.columns.push(
  { name: "campaign_context_json", type: "jsonb", nullable: true }, { name: "campaign_context_ref", type: "bytea", nullable: true });
schema.tables.push({ table: NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE,
  columns: Object.keys(JSON.parse(object)).map(name => ({ name, type: "fixture", nullable: false })) });
const core = buildNativeReferenceEvidenceArchive({ ...parent.core.manifest, schema, tables });
const built = buildNativeCalibrationParentArchive({ core: core.bundle, coreManifestHash: core.manifestHash,
  schema: parent.manifest.schema, tables: parent.manifest.tables.map(table => ({ table: table.table,
    rowJson: table.rows.map(ref => parent.objects[ref.objectHash]!) })) });
const trust = { generation: built.bundle.manifest.generation, manifestHash: built.manifestHash,
  schemaHash: built.bundle.manifest.schemaHash };
const sealed = sealCompressedNativeHistoricalArchive(built.bundle, trust, original.entry.encryptionKeyId, key);
const entry = { ...sealed.trust, object: { bucket: "archive-fixture", key: `native/v2/${sealed.trust.ciphertextSha256}.bin`,
  versionId: sealed.trust.ciphertextSha256 } };
const value = { syntheticFixtureOnly: true, canonicalProducerProof: false,
  fixtureEncryptionKeyHex: original.fixtureEncryptionKeyHex, ciphertextBase64: sealed.bytes.toString("base64"), entry,
  request: original.request, expectedEvidence: openNativeHistoricalArchiveEvidence(sealed.bytes, entry, key, original.request) };
writeFileSync("scripts/fixtures/native-historical-worker-reference.json", JSON.stringify(value, null, 2) + "\n");
console.log(JSON.stringify({ syntheticFixtureOnly: true, parentContract: built.bundle.manifest.contract,
  historicalContract: value.expectedEvidence.contractVersion, plaintextBytes: entry.plaintextBytes,
  ciphertextBytes: entry.ciphertextBytes, providerAuthority: false }));
