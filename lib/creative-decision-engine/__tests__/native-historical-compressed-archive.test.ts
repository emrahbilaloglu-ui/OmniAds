import { createCipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, expect, it, vi } from "vitest";
import { stableCanonicalJson } from "../canonical-evaluation";
import { buildNativeCalibrationParentArchive } from "../native-calibration-parent-archive";
import { nativeArchiveByteDigest, NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT,
  NATIVE_HISTORICAL_COMPRESSED_ENCODING, NATIVE_HISTORICAL_CATALOG_CONTRACT,
  NATIVE_HISTORICAL_MAX_DECODED_BYTES, openNativeHistoricalArchiveCatalog,
  openNativeHistoricalArchiveEnvelope, openNativeHistoricalArchiveEvidence,
  sealCompressedNativeHistoricalArchive, sealNativeHistoricalArchive,
  type NativeHistoricalArchiveCatalogEntry, type NativeHistoricalArchiveContentTrust } from "../native-historical-archive";
import { persistLocalNativeArchive, readLocalNativeArchiveVersion } from "../native-historical-local-store";
import { readNativeHistoricalAdEvidence, NATIVE_HISTORICAL_READER_GATE } from "../native-historical-archive-reader";
import { verifyNativeHistoricalEvidenceInWorker } from "../native-historical-archive-worker-client";
import { NativeHistoricalReadControls, NativeHistoricalObjectBound } from "../native-historical-read-controls";

const fixture = JSON.parse(await readFile(join(process.cwd(), "scripts/fixtures/native-historical-worker.json"), "utf8"));
const key = Buffer.from(fixture.fixtureEncryptionKeyHex, "hex");
const original = openNativeHistoricalArchiveEnvelope(Buffer.from(fixture.ciphertextBase64, "base64"),
  fixture.entry, key, fixture.request.generation).bundle;
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function build(padding = "") {
  const schema = structuredClone(original.manifest.schema), tables = original.manifest.tables.map(table => ({
    table: table.table, rowJson: table.rows.map(row => original.objects[row.objectHash]!),
  }));
  schema.tables[0]!.columns.push({ name: "source_provenance_json", type: "jsonb", nullable: false });
  const batch = JSON.parse(tables[0]!.rowJson[0]!); batch.source_provenance_json = { fixturePadding: padding };
  tables[0]!.rowJson[0] = JSON.stringify(batch);
  return buildNativeCalibrationParentArchive({ ...original.manifest, schema, tables, core: original.core,
    coreManifestHash: original.manifest.coreManifestHash });
}
function expected(built: ReturnType<typeof build>) {
  return { manifestHash: built.manifestHash, schemaHash: built.bundle.manifest.schemaHash, generation: built.bundle.manifest.generation };
}
function seal(built = build()) { return sealCompressedNativeHistoricalArchive(built.bundle, expected(built), fixture.entry.encryptionKeyId, key); }
function entry(sealed: ReturnType<typeof seal>): NativeHistoricalArchiveCatalogEntry {
  return { ...sealed.trust, object: { bucket: "adsecute-native-local", key: `native/v2/${sealed.trust.ciphertextSha256}.bin`, versionId: sealed.trust.ciphertextSha256 } };
}
function catalog(e: NativeHistoricalArchiveCatalogEntry, contract = NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT as string) {
  const bytes = Buffer.from(JSON.stringify({ contract, entries: [e] }));
  return () => openNativeHistoricalArchiveCatalog(bytes, nativeArchiveByteDigest(bytes));
}
/** Independently authenticated adversarial payload; transport/GCM success must
 * not bypass the decoded-size, compression checksum or original digest gates. */
function forged(payload: Buffer, plaintextBytes: number, plaintextSha256 = "a".repeat(64)) {
  const base = { generation: fixture.entry.generation, parentManifestHash: fixture.entry.parentManifestHash,
    parentSchemaHash: fixture.entry.parentSchemaHash, encryptionKeyId: fixture.entry.encryptionKeyId,
    encoding: NATIVE_HISTORICAL_COMPRESSED_ENCODING, plaintextBytes, plaintextSha256,
    payloadBytes: payload.length, payloadSha256: nativeArchiveByteDigest(payload) };
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  cipher.setAAD(Buffer.from(stableCanonicalJson({ contract: base.encoding, generation: base.generation,
    parentManifestHash: base.parentManifestHash, parentSchemaHash: base.parentSchemaHash, encryptionKeyId: base.encryptionKeyId,
    plaintextSha256: base.plaintextSha256, plaintextBytes: base.plaintextBytes,
    payloadBytes: base.payloadBytes, payloadSha256: base.payloadSha256 })));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const bytes = Buffer.concat([Buffer.from("ADSECUTE_NATIVE_GZ2\0"), Buffer.alloc(12), cipher.getAuthTag(), ciphertext]);
  return { bytes, trust: { ...base, ciphertextBytes: bytes.length, ciphertextSha256: nativeArchiveByteDigest(bytes) } };
}
it("retains legacy ciphertext, exact row bytes, clocks and historical authority", () => {
  const built = build(), compressed = seal(built), legacy = sealNativeHistoricalArchive(built.bundle, expected(built), fixture.entry.encryptionKeyId, key);
  const opened = openNativeHistoricalArchiveEnvelope(compressed.bytes, compressed.trust, key, fixture.request.generation).bundle;
  expect(opened).toEqual(built.bundle);
  expect(compressed.trust.plaintextSha256).toBe(legacy.trust.plaintextSha256);
  expect(compressed.trust.plaintextBytes).toBe(legacy.trust.plaintextBytes);
  expect(openNativeHistoricalArchiveEvidence(compressed.bytes, compressed.trust, key, fixture.request)).toEqual(fixture.expectedEvidence);
  expect(openNativeHistoricalArchiveEvidence(Buffer.from(fixture.ciphertextBase64, "base64"), fixture.entry, key, fixture.request)).toEqual(fixture.expectedEvidence);
});
it("keeps v1 catalog/object pointers and requires explicit v2 for compressed entries", () => {
  expect(catalog(fixture.entry, NATIVE_HISTORICAL_CATALOG_CONTRACT)().entries).toEqual([fixture.entry]);
  expect(catalog(fixture.entry)().entries).toEqual([fixture.entry]);
  const e = entry(seal()); expect(catalog(e)().entries).toEqual([e]);
  expect(catalog(e, NATIVE_HISTORICAL_CATALOG_CONTRACT)).toThrow(/requires v2/);
  expect(catalog({ ...e, object: { ...e.object, key: e.object.key.replace("v2", "v1") } })).toThrow(/pointer/);
});
it.each(["encoding", "payloadBytes", "payloadSha256", "plaintextBytes", "plaintextSha256", "parentManifestHash", "magic", "tag"])("refuses authenticated encoding/trust fault %s", fault => {
  const sealed = seal(), trust = { ...sealed.trust } as Record<string, unknown>, bytes = Buffer.from(sealed.bytes);
  if (fault === "encoding") trust.encoding = "gzip.v3";
  else if (fault === "magic" || fault === "tag") { bytes[fault === "magic" ? 0 : 32] ^= 1; trust.ciphertextSha256 = nativeArchiveByteDigest(bytes); }
  else if (fault.endsWith("Bytes")) trust[fault] = Number(trust[fault]) + 1;
  else trust[fault] = "b".repeat(64);
  expect(() => openNativeHistoricalArchiveEnvelope(bytes, trust as unknown as NativeHistoricalArchiveContentTrust, key, fixture.request.generation)).toThrow();
});
it.each(["foreign-ad", "foreign-evaluation", "foreign-business", "wrong-key"])("actual compressed worker refuses %s", async fault => {
  const sealed = seal(), selected = structuredClone(fixture.request), secret = Buffer.from(key);
  if (fault === "foreign-ad") selected.adId = "foreign";
  if (fault === "foreign-evaluation") selected.evaluationId = "00000000-0000-4000-8000-000000000999";
  if (fault === "foreign-business") selected.generation.businessId = "00000000-0000-4000-8000-000000000999";
  if (fault === "wrong-key") secret[0] ^= 1;
  await expect(verifyNativeHistoricalEvidenceInWorker(sealed.bytes, secret, entry(sealed), selected, new AbortController().signal)).rejects.toThrow();
});
it("rejects a real authenticated gzip expansion beyond its claimed length and the eight-MiB maximum", async () => {
  const bomb = forged(gzipSync(Buffer.alloc(NATIVE_HISTORICAL_MAX_DECODED_BYTES + 1, 0x78)), NATIVE_HISTORICAL_MAX_DECODED_BYTES);
  expect(() => openNativeHistoricalArchiveEnvelope(bomb.bytes, bomb.trust, key, fixture.request.generation)).toThrow();
  await expect(verifyNativeHistoricalEvidenceInWorker(bomb.bytes, key, entry(bomb), fixture.request, new AbortController().signal)).rejects.toThrow();
});
it.each(["not-gzip", "original-digest"])("rejects a fully authenticated payload with %s", fault => {
  const payload = fault === "not-gzip" ? Buffer.from("not gzip") : gzipSync(Buffer.from("{}"));
  const sealed = forged(payload, 2);
  expect(() => openNativeHistoricalArchiveEnvelope(sealed.bytes, sealed.trust, key, fixture.request.generation)).toThrow();
});
it.each(["decoded", "stored", "payload", "unknown-codec"])("refuses compressed %s bound before transport or worker allocation", async fault => {
  const sealed = seal(), e = entry(sealed), controls = new NativeHistoricalReadControls();
  const bad = { ...e } as unknown as Record<string, unknown>;
  if (fault === "decoded") bad.plaintextBytes = NATIVE_HISTORICAL_MAX_DECODED_BYTES + 1;
  if (fault === "stored") bad.ciphertextBytes = 2 * 1024 * 1024 + 129;
  if (fault === "payload") bad.payloadBytes = 2 * 1024 * 1024 + 1;
  if (fault === "unknown-codec") bad.encoding = "native-historical-aes-256-gcm-gzip.v3";
  const download = vi.fn(), validate = vi.fn();
  await expect(controls.read(fixture.request, async () => ({ configurationFingerprint: "f".repeat(64),
    entry: bad as unknown as NativeHistoricalArchiveCatalogEntry, work: { download, validate } }))).rejects.toThrow(NativeHistoricalObjectBound);
  expect(download).not.toHaveBeenCalled(); expect(validate).not.toHaveBeenCalled();
});
it("refuses an incompressible package beyond the stored cap and decoded oversize before publication", () => {
  expect(() => seal(build(randomBytes(3 * 1024 * 1024).toString("base64")))).toThrow();
  expect(() => seal(build("x".repeat(NATIVE_HISTORICAL_MAX_DECODED_BYTES)))).toThrow(/bound/);
});
it("admits the exact eight-MiB v2 in the actual worker, coalesces duplicate reads and still refuses oversized v1", async () => {
  const zero = build(), base = seal(zero), built = build("x".repeat(NATIVE_HISTORICAL_MAX_DECODED_BYTES - base.trust.plaintextBytes));
  const sealed = seal(built), e = entry(sealed), controls = new NativeHistoricalReadControls();
  expect(e.plaintextBytes).toBe(NATIVE_HISTORICAL_MAX_DECODED_BYTES); expect(e.ciphertextBytes).toBeLessThan(2 * 1024 * 1024);
  let gets = 0, validations = 0;
  const prepare = async () => ({ configurationFingerprint: "f".repeat(64), entry: e,
    work: { download: async () => { gets++; return sealed.bytes; },
      validate: async (bytes: Buffer, selected: NativeHistoricalArchiveCatalogEntry, request: typeof fixture.request, signal: AbortSignal) => {
        validations++; return verifyNativeHistoricalEvidenceInWorker(bytes, key, selected, request, signal);
      } } });
  const [first, duplicate] = await Promise.all([controls.read(fixture.request, prepare), controls.read(fixture.request, prepare)]);
  expect(first).toEqual(fixture.expectedEvidence); expect(duplicate).toEqual(first);
  expect(await controls.read(fixture.request, prepare)).toEqual(first); expect(gets).toBe(1); expect(validations).toBe(1);
  const old = sealNativeHistoricalArchive(built.bundle, expected(built), fixture.entry.encryptionKeyId, key);
  await expect(controls.read(fixture.request, async () => ({ ...await prepare(), entry: { ...old.trust, object: fixture.entry.object } }))).rejects.toThrow(NativeHistoricalObjectBound);
  expect(gets).toBe(1);
}, 15000);
it("runs a larger-than-v1 original through the actual filesystem runtime/compiled worker with no S3 call", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adsecute-compressed-public-"))); roots.push(root); await chmod(root, 0o700);
  const sealed = seal(build("x".repeat(3 * 1024 * 1024))), e = await persistLocalNativeArchive(root, sealed.bytes, sealed.trust);
  expect(e.plaintextBytes).toBeGreaterThan(2 * 1024 * 1024); expect(e.object.key).toMatch(/^native\/v2\//);
  expect(await persistLocalNativeArchive(root, sealed.bytes, sealed.trust)).toEqual(e);
  expect(await readLocalNativeArchiveVersion(root, e)).toEqual(sealed.bytes);
  const bytes = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_COMPRESSED_CATALOG_CONTRACT, entries: [e] })), filename = join(root, "catalog.json");
  await writeFile(filename, bytes, { mode: 0o600 });
  vi.stubEnv(NATIVE_HISTORICAL_READER_GATE, "true"); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT", "filesystem");
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT", root); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH", filename);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256", nativeArchiveByteDigest(bytes));
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID", e.encryptionKeyId); vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX", fixture.fixtureEncryptionKeyHex);
  const send = vi.spyOn(S3Client.prototype, "send");
  expect(await readNativeHistoricalAdEvidence(fixture.request)).toEqual(fixture.expectedEvidence); expect(send).not.toHaveBeenCalled();
});
