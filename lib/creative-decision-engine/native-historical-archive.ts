import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { stableCanonicalJson } from "./canonical-evaluation";
import { openNativeCalibrationParentArchive, type NativeCalibrationParentBundle } from "./native-calibration-parent-archive";
import type { NativeArchiveGeneration } from "./native-evidence-archive";

export const NATIVE_HISTORICAL_CATALOG_CONTRACT = "native-historical-archive-catalog.v1" as const;
export const NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT = "native-historical-archive-catalog.v2" as const;
export const NATIVE_HISTORICAL_COMPRESSED_ENCODING = "native-historical-aes-256-gcm-gzip.v2" as const;
export const NATIVE_HISTORICAL_EVIDENCE_CONTRACT = "decision-engine-v3-native-ad-historical-evidence.v1" as const;
export const NATIVE_REFERENCE_HISTORICAL_EVIDENCE_CONTRACT = "decision-engine-v3-native-ad-historical-evidence.v2" as const;
export const NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
export const NATIVE_HISTORICAL_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const NATIVE_HISTORICAL_MAX_DECODED_BYTES = 8 * 1024 * 1024;
export const NATIVE_HISTORICAL_MAX_CATALOG_BYTES = 1024 * 1024;
const MAGIC = Buffer.from("ADSECUTE_NATIVE_GCM1\0", "ascii");
const COMPRESSED_MAGIC = Buffer.from("ADSECUTE_NATIVE_GZ2\0", "ascii");
const OVERHEAD = MAGIC.length + 12 + 16;
const COMPRESSED_OVERHEAD = COMPRESSED_MAGIC.length + 12 + 16;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface NativeHistoricalArchivePlaintextTrust {
  generation: NativeArchiveGeneration;
  parentManifestHash: string;
  parentSchemaHash: string;
  encryptionKeyId: string;
  plaintextSha256: string;
  plaintextBytes: number;
}
type NativeHistoricalArchiveEncoding = { encoding?: undefined; payloadBytes?: never; payloadSha256?: never } |
  { encoding: typeof NATIVE_HISTORICAL_COMPRESSED_ENCODING; payloadBytes: number; payloadSha256: string };
export type NativeHistoricalArchiveContentTrust = NativeHistoricalArchivePlaintextTrust & NativeHistoricalArchiveEncoding & {
  ciphertextSha256: string;
  ciphertextBytes: number;
};
export type NativeHistoricalArchiveCatalogEntry = NativeHistoricalArchiveContentTrust & {
  object: { bucket: string; key: string; versionId: string };
}
export interface NativeHistoricalArchiveCatalog {
  contract: typeof NATIVE_HISTORICAL_CATALOG_CONTRACT | typeof NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT;
  entries: NativeHistoricalArchiveCatalogEntry[];
}
export interface NativeHistoricalEvidenceRequest {
  generation: NativeArchiveGeneration;
  providerAccountId: string;
  adId: string;
  evaluationId: string;
}
export interface NativeHistoricalEvidence {
  status: "historical_available";
  contractVersion: typeof NATIVE_HISTORICAL_EVIDENCE_CONTRACT | typeof NATIVE_REFERENCE_HISTORICAL_EVIDENCE_CONTRACT;
  authority: "historical_read_only";
  providerAuthority: false;
  currentDecisionEligible: false;
  reclaimEligible: false;
  generation: NativeArchiveGeneration;
  sourceRevision: string;
  capturedAt: string;
  identity: { providerAccountId: string; providerAccountRefId: string; adId: string;
    evaluationId: string; contextId: string; inputHash: string; decisionHash: string };
  /** Exact PostgreSQL JSONB text. Parsing these for display must not rewrite storage hashes. */
  rowJson: { evaluation: string; context: string; inputEvidence: string; snapshot: string | null;
    /** Present only for reference v2; preserves the original full shared row. */
    campaignContextObject?: string };
}

function refuse(reason: string): never { throw new Error(`Native historical archive refused: ${reason}`); }
export function nativeArchiveByteDigest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid object");
  return value as Record<string, unknown>;
}
function exactString(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value.length || value.trim() !== value || value.length > max) refuse("invalid identity");
  return value;
}
function digest(value: unknown): string {
  const text = exactString(value, 64);
  if (!SHA.test(text)) refuse("invalid digest");
  return text;
}
function generation(value: unknown): NativeArchiveGeneration {
  const g = record(value), businessId = exactString(g.businessId), jobRunId = exactString(g.jobRunId);
  const asOfDate = exactString(g.asOfDate), engineVersion = exactString(g.engineVersion, 256);
  if (!UUID.test(businessId) || !UUID.test(jobRunId) || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) ||
    new Date(`${asOfDate}T00:00:00Z`).toISOString().slice(0, 10) !== asOfDate) refuse("invalid generation");
  return { businessId, jobRunId, asOfDate, engineVersion };
}
function byteCount(value: unknown, limit: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > limit) refuse("payload size outside bound");
  return value;
}
function contentTrust(value: unknown): NativeHistoricalArchiveContentTrust {
  const v = record(value);
  const encryptionKeyId = exactString(v.encryptionKeyId, 80);
  if (!/^[a-zA-Z0-9._-]+$/.test(encryptionKeyId)) refuse("invalid encryption key ID");
  const compressed = v.encoding === NATIVE_HISTORICAL_COMPRESSED_ENCODING;
  if (v.encoding !== undefined && !compressed) refuse("unsupported encrypted encoding");
  const plaintextBytes = byteCount(v.plaintextBytes, compressed ? NATIVE_HISTORICAL_MAX_DECODED_BYTES : NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES);
  const ciphertextBytes = byteCount(v.ciphertextBytes, compressed ? NATIVE_HISTORICAL_MAX_COMPRESSED_BYTES + COMPRESSED_OVERHEAD : NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES + OVERHEAD);
  const base = { generation: generation(v.generation), parentManifestHash: digest(v.parentManifestHash),
    parentSchemaHash: digest(v.parentSchemaHash), encryptionKeyId, plaintextSha256: digest(v.plaintextSha256),
    plaintextBytes, ciphertextSha256: digest(v.ciphertextSha256), ciphertextBytes };
  if (compressed) {
    const payloadBytes = byteCount(v.payloadBytes, NATIVE_HISTORICAL_MAX_COMPRESSED_BYTES);
    if (ciphertextBytes !== payloadBytes + COMPRESSED_OVERHEAD) refuse("compressed encrypted length mismatch");
    return { ...base, encoding: NATIVE_HISTORICAL_COMPRESSED_ENCODING, payloadBytes, payloadSha256: digest(v.payloadSha256) };
  }
  if (v.payloadBytes !== undefined || v.payloadSha256 !== undefined || ciphertextBytes !== plaintextBytes + OVERHEAD)
    refuse("encrypted length or legacy metadata mismatch");
  return base;
}
function aad(v: NativeHistoricalArchivePlaintextTrust & NativeHistoricalArchiveEncoding): Buffer {
  const common = { generation: v.generation,
    parentManifestHash: v.parentManifestHash, parentSchemaHash: v.parentSchemaHash,
    encryptionKeyId: v.encryptionKeyId, plaintextSha256: v.plaintextSha256, plaintextBytes: v.plaintextBytes };
  return Buffer.from(stableCanonicalJson(v.encoding === NATIVE_HISTORICAL_COMPRESSED_ENCODING ?
    { contract: v.encoding, ...common, payloadBytes: v.payloadBytes, payloadSha256: v.payloadSha256 } :
    { contract: "native-historical-aes-256-gcm.v1", ...common }), "utf8");
}
function key(bytes: Uint8Array): Buffer {
  if (bytes.byteLength !== 32) refuse("AES-256 key required");
  return Buffer.from(bytes);
}

/** LOCAL packaging only. Does not upload, publish a trusted catalog or clear inline rows. */
export function sealNativeHistoricalArchive(bundle: NativeCalibrationParentBundle, expected: {
  manifestHash: string; schemaHash: string; generation: NativeArchiveGeneration;
}, encryptionKeyId: string, encryptionKey: Uint8Array) {
  openNativeCalibrationParentArchive(bundle, expected);
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(encryptionKeyId)) refuse("invalid encryption key ID");
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  byteCount(plaintext.length, NATIVE_HISTORICAL_MAX_PLAINTEXT_BYTES);
  const base = { generation: { ...expected.generation }, parentManifestHash: digest(expected.manifestHash),
    parentSchemaHash: digest(expected.schemaHash), encryptionKeyId, plaintextSha256: nativeArchiveByteDigest(plaintext), plaintextBytes: plaintext.length };
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(encryptionKey), nonce, { authTagLength: 16 });
  cipher.setAAD(aad(base));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const bytes = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  return { bytes, trust: { ...base, ciphertextSha256: nativeArchiveByteDigest(bytes), ciphertextBytes: bytes.length } };
}

/** Explicit v2, not a raised v1 cap. Compress the exact original JSON bytes;
 * bind both compressed and original sizes/digests to GCM and independent trust.
 * Runtime decompression is permitted only in the existing bounded worker. */
export function sealCompressedNativeHistoricalArchive(bundle: NativeCalibrationParentBundle, expected: {
  manifestHash: string; schemaHash: string; generation: NativeArchiveGeneration;
}, encryptionKeyId: string, encryptionKey: Uint8Array) {
  openNativeCalibrationParentArchive(bundle, expected);
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(encryptionKeyId)) refuse("invalid encryption key ID");
  const plaintext = Buffer.from(JSON.stringify(bundle), "utf8");
  byteCount(plaintext.length, NATIVE_HISTORICAL_MAX_DECODED_BYTES);
  const payload = gzipSync(plaintext, { level: 6, maxOutputLength: NATIVE_HISTORICAL_MAX_COMPRESSED_BYTES });
  byteCount(payload.length, NATIVE_HISTORICAL_MAX_COMPRESSED_BYTES);
  const base = { generation: { ...expected.generation }, parentManifestHash: digest(expected.manifestHash),
    parentSchemaHash: digest(expected.schemaHash), encryptionKeyId, plaintextSha256: nativeArchiveByteDigest(plaintext),
    plaintextBytes: plaintext.length, encoding: NATIVE_HISTORICAL_COMPRESSED_ENCODING,
    payloadBytes: payload.length, payloadSha256: nativeArchiveByteDigest(payload) };
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(encryptionKey), nonce, { authTagLength: 16 });
  cipher.setAAD(aad(base));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const bytes = Buffer.concat([COMPRESSED_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  return { bytes, trust: { ...base, ciphertextSha256: nativeArchiveByteDigest(bytes), ciphertextBytes: bytes.length } };
}

export function nativeHistoricalArchiveStorageVersion(trust: NativeHistoricalArchiveContentTrust): "v1" | "v2" {
  return contentTrust(trust).encoding === NATIVE_HISTORICAL_COMPRESSED_ENCODING ? "v2" : "v1";
}

/** The digest is independently supplied by deployment/trust publication, never fetched from S3. */
export function openNativeHistoricalArchiveCatalog(bytes: Uint8Array, expectedDigest: string): NativeHistoricalArchiveCatalog {
  byteCount(bytes.byteLength, NATIVE_HISTORICAL_MAX_CATALOG_BYTES);
  if (nativeArchiveByteDigest(bytes) !== digest(expectedDigest)) refuse("catalog trust mismatch");
  const catalog = record(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if ((catalog.contract !== NATIVE_HISTORICAL_CATALOG_CONTRACT && catalog.contract !== NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT) || !Array.isArray(catalog.entries) ||
    catalog.entries.length > 128) refuse("unsupported catalog contract/count");
  const seen = new Set<string>();
  const entries = catalog.entries.map(raw => {
    const r = record(raw), trust = contentTrust(r), object = record(r.object);
    const bucket = exactString(object.bucket, 63), objectKey = exactString(object.key), versionId = exactString(object.versionId);
    if (catalog.contract === NATIVE_HISTORICAL_CATALOG_CONTRACT && trust.encoding !== undefined) refuse("compressed entry requires v2 catalog");
    const version = nativeHistoricalArchiveStorageVersion(trust);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      objectKey !== `native/${version}/${trust.ciphertextSha256}.bin` || versionId === "null") refuse("invalid immutable object pointer");
    if (seen.has(trust.generation.jobRunId)) refuse("ambiguous generation index");
    seen.add(trust.generation.jobRunId);
    return { ...trust, object: { bucket, key: objectKey, versionId } };
  });
  return { contract: catalog.contract, entries };
}

export function resolveNativeHistoricalArchiveEntry(catalog: NativeHistoricalArchiveCatalog, request: NativeHistoricalEvidenceRequest) {
  const g = generation(request.generation);
  exactString(request.providerAccountId); exactString(request.adId); exactString(request.evaluationId);
  const matches = catalog.entries.filter(e => stableCanonicalJson(e.generation) === stableCanonicalJson(g));
  if (matches.length !== 1) refuse("exact historical generation absent");
  return matches[0]!;
}

/** Local restore verification retains dirty-source metadata. Runtime publication
 * is a separate gate below, and cannot silently claim an exact clean build. */
export function openNativeHistoricalArchiveEnvelope(bytes: Uint8Array, trustInput: NativeHistoricalArchiveContentTrust,
  encryptionKey: Uint8Array, expectedGeneration: NativeArchiveGeneration) {
  const trust = contentTrust(trustInput);
  if (stableCanonicalJson(trust.generation) !== stableCanonicalJson(generation(expectedGeneration))) refuse("foreign generation request");
  if (bytes.byteLength !== trust.ciphertextBytes || nativeArchiveByteDigest(bytes) !== trust.ciphertextSha256) refuse("ciphertext digest/length mismatch");
  const body = Buffer.from(bytes);
  const compressed = trust.encoding === NATIVE_HISTORICAL_COMPRESSED_ENCODING;
  const magic = compressed ? COMPRESSED_MAGIC : MAGIC, overhead = magic.length + 12 + 16;
  if (!body.subarray(0, magic.length).equals(magic)) refuse("unsupported encrypted encoding");
  const decipher = createDecipheriv("aes-256-gcm", key(encryptionKey), body.subarray(magic.length, magic.length + 12), { authTagLength: 16 });
  decipher.setAAD(aad(trust));
  decipher.setAuthTag(body.subarray(magic.length + 12, overhead));
  const payload = Buffer.concat([decipher.update(body.subarray(overhead)), decipher.final()]);
  if (compressed && (payload.length !== trust.payloadBytes || nativeArchiveByteDigest(payload) !== trust.payloadSha256))
    refuse("compressed digest/length mismatch");
  // maxOutputLength rejects overexpansion before constructing/JSON-parsing it.
  const plaintext = compressed ? gunzipSync(payload, { maxOutputLength: trust.plaintextBytes }) : payload;
  if (plaintext.length !== trust.plaintextBytes || nativeArchiveByteDigest(plaintext) !== trust.plaintextSha256) refuse("plaintext digest/length mismatch");
  const bundle = JSON.parse(plaintext.toString("utf8")) as NativeCalibrationParentBundle;
  const view = openNativeCalibrationParentArchive(bundle, { manifestHash: trust.parentManifestHash,
    schemaHash: trust.parentSchemaHash, generation: trust.generation });
  return { bundle, view };
}

export function openNativeHistoricalArchiveEvidence(bytes: Uint8Array, trustInput: NativeHistoricalArchiveContentTrust,
  encryptionKey: Uint8Array, request: NativeHistoricalEvidenceRequest): NativeHistoricalEvidence {
  exactString(request.providerAccountId); exactString(request.adId); exactString(request.evaluationId);
  const { bundle, view } = openNativeHistoricalArchiveEnvelope(bytes, trustInput, encryptionKey, request.generation);
  if (bundle.manifest.sourceWorkspaceDirty || bundle.core.manifest.sourceWorkspaceDirty) refuse("dirty published archive source");
  const trust = contentTrust(trustInput);
  const find = (table: Parameters<typeof view.readCoreTable>[0], predicate: (row: Record<string, unknown>) => boolean) =>
    view.readCoreTable(table).filter(item => predicate(record(JSON.parse(item.rowJson))));
  const evaluations = find("engine_v3_ad_decision_evaluations", row => row.id === request.evaluationId &&
    row.provider_account_id === request.providerAccountId && row.ad_id === request.adId &&
    row.decision_entity_type === "ad" && row.decision_entity_id === request.adId &&
    row.scope_type === "account" && row.scope_id === request.providerAccountId);
  if (evaluations.length !== 1) refuse("exact historical ad/evaluation absent");
  const evaluation = record(JSON.parse(evaluations[0]!.rowJson));
  const contexts = find("engine_v3_ad_decision_evaluation_contexts", row => row.id === evaluation.context_id);
  const inputs = find("engine_v3_ad_decision_input_evidence", row => row.contract_version === evaluation.contract_version && row.input_hash === evaluation.input_hash);
  const snapshots = find("engine_v3_ad_decision_snapshots_daily", row => row.evaluation_id === evaluation.id);
  if (contexts.length !== 1 || inputs.length !== 1 || snapshots.length > 1) refuse("historical row lineage differs");
  const campaign = view.readCampaignContext(request.evaluationId);
  const sharedRow = campaign?.objectRowJson;
  if (evaluation.campaign_context_ref !== null && evaluation.campaign_context_ref !== undefined && !sharedRow)
    refuse("historical shared campaign root absent");
  return { status: "historical_available", contractVersion: sharedRow ?
    NATIVE_REFERENCE_HISTORICAL_EVIDENCE_CONTRACT : NATIVE_HISTORICAL_EVIDENCE_CONTRACT,
    authority: "historical_read_only", providerAuthority: false, currentDecisionEligible: false, reclaimEligible: false,
    generation: { ...trust.generation }, sourceRevision: bundle.manifest.sourceRevision, capturedAt: bundle.manifest.capturedAt,
    identity: { providerAccountId: request.providerAccountId, providerAccountRefId: exactString(evaluation.provider_account_ref_id),
      adId: request.adId, evaluationId: request.evaluationId, contextId: exactString(evaluation.context_id),
      inputHash: digest(evaluation.input_hash), decisionHash: digest(evaluation.decision_hash) },
    rowJson: { evaluation: evaluations[0]!.rowJson, context: contexts[0]!.rowJson, inputEvidence: inputs[0]!.rowJson,
      snapshot: snapshots[0]?.rowJson ?? null, ...(sharedRow ? { campaignContextObject: sharedRow } : {}) } };
}
