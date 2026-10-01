import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeHistoricalArchiveCatalogEntry, NativeHistoricalEvidenceRequest } from "../native-historical-archive";
import { openNativeHistoricalArchiveEnvelope, sealNativeHistoricalArchive } from "../native-historical-archive";
import { buildNativeCalibrationParentArchive } from "../native-calibration-parent-archive";
import { NativeHistoricalReadControls, NATIVE_HISTORICAL_READ_BOUNDS } from "../native-historical-read-controls";
import { verifyNativeHistoricalEvidenceInWorker } from "../native-historical-archive-worker-client";

const root = process.cwd();
const fixture = JSON.parse(readFileSync(join(root, "scripts/fixtures/native-historical-worker.json"), "utf8"));
const bytes = Buffer.from(fixture.ciphertextBase64, "base64"), key = Buffer.from(fixture.fixtureEncryptionKeyHex, "hex");
const entry: NativeHistoricalArchiveCatalogEntry = fixture.entry, request: NativeHistoricalEvidenceRequest = fixture.request;
const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });

it("executes the actual bundled separate worker and preserves original JSONB bytes and authority", async () => {
  expect(fixture.syntheticFixtureOnly).toBe(true);
  const actual = await verifyNativeHistoricalEvidenceInWorker(bytes, key, entry, request, new AbortController().signal);
  expect(actual).toEqual(fixture.expectedEvidence);
  expect(actual.providerAuthority).toBe(false); expect(actual.currentDecisionEligible).toBe(false); expect(actual.reclaimEligible).toBe(false);
});
it.each(["wrong-key", "tag", "foreign-ad", "foreign-evaluation"])("actual compiled validation refuses %s", async fault => {
  const damaged = Buffer.from(bytes), secret = Buffer.from(key), selected = structuredClone(request), trust = structuredClone(entry);
  if (fault === "wrong-key") secret[0] ^= 1;
  if (fault === "tag") {
    damaged[33] ^= 1; // Authentication tag, not just a transport digest fault.
    trust.ciphertextSha256 = createHash("sha256").update(damaged).digest("hex");
  }
  if (fault === "foreign-ad") selected.adId = "foreign";
  if (fault === "foreign-evaluation") selected.evaluationId = "00000000-0000-4000-8000-000000000999";
  await expect(verifyNativeHistoricalEvidenceInWorker(damaged, secret, trust, selected, new AbortController().signal)).rejects.toThrow();
});
it("refuses an aborted request and an oversized object before starting validation", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(verifyNativeHistoricalEvidenceInWorker(bytes, key, entry, request, controller.signal)).rejects.toThrow("aborted");
  await expect(verifyNativeHistoricalEvidenceInWorker(bytes, key, { ...entry, plaintextBytes: 2 * 1024 * 1024 + 1 }, request,
    new AbortController().signal)).rejects.toThrow("input bound");
});
it("validates the maximum two-MiB plaintext in the actual separate worker once for duplicate reads", async () => {
  const original = openNativeHistoricalArchiveEnvelope(bytes, entry, key, request.generation).bundle;
  const make = (padding: number) => {
    const schema = structuredClone(original.manifest.schema), tables = original.manifest.tables.map(table => ({
      table: table.table, rowJson: table.rows.map(row => original.objects[row.objectHash]!),
    }));
    schema.tables[0]!.columns.push({ name: "source_provenance_json", type: "jsonb", nullable: false });
    const batch = JSON.parse(tables[0]!.rowJson[0]!); batch.source_provenance_json = { fixturePadding: "x".repeat(padding) };
    tables[0]!.rowJson[0] = JSON.stringify(batch);
    const built = buildNativeCalibrationParentArchive({ ...original.manifest, schema, tables,
      core: original.core, coreManifestHash: original.manifest.coreManifestHash });
    return sealNativeHistoricalArchive(built.bundle, { manifestHash: built.manifestHash,
      schemaHash: built.bundle.manifest.schemaHash, generation: built.bundle.manifest.generation }, entry.encryptionKeyId, key);
  };
  const base = make(0), maximum = make(NATIVE_HISTORICAL_READ_BOUNDS.maxPlaintextBytes - base.trust.plaintextBytes);
  expect(maximum.trust.plaintextBytes).toBe(2 * 1024 * 1024);
  const selected = { ...maximum.trust, object: { ...entry.object, key: "native/v1/" + maximum.trust.ciphertextSha256 + ".bin" } };
  let gets = 0, validations = 0;
  const controls = new NativeHistoricalReadControls(), prepare = async () => ({ configurationFingerprint: "f".repeat(64), entry: selected,
    work: { download: async () => { gets++; return maximum.bytes; },
      validate: async (object: Buffer, catalog: NativeHistoricalArchiveCatalogEntry, identity: NativeHistoricalEvidenceRequest, signal: AbortSignal) => {
        validations++; return verifyNativeHistoricalEvidenceInWorker(object, key, catalog, identity, signal);
      } } });
  const [first, duplicate] = await Promise.all([controls.read(request, prepare), controls.read(request, prepare)]);
  expect(first).toEqual(fixture.expectedEvidence); expect(duplicate).toEqual(first);
  expect(await controls.read(request, prepare)).toEqual(first); expect(gets).toBe(1); expect(validations).toBe(1);
});

function privateArtifact(source = "require('node:worker_threads').parentPort.postMessage({ok:false})") {
  const folder = mkdtempSync(join(tmpdir(), "adsecute-worker-artifact-")); temporary.push(folder);
  const directory = join(folder, ".native-historical-worker"); mkdirSync(directory);
  writeFileSync(join(directory, "archive-worker.cjs"), source, { mode: 0o600 });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ contract: "native-historical-worker-artifact.v1",
    sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source) }), { mode: 0o600 });
  vi.spyOn(process, "cwd").mockReturnValue(folder); return directory;
}
it.each(["missing", "digest", "symlink", "writable", "manifest"])("artifact loader fails closed for %s", async fault => {
  const directory = privateArtifact(), file = join(directory, "archive-worker.cjs");
  if (fault === "missing") rmSync(file);
  if (fault === "digest") writeFileSync(file, "changed source");
  if (fault === "symlink") { rmSync(file); symlinkSync(join(root, ".native-historical-worker/archive-worker.cjs"), file); }
  if (fault === "writable") chmodSync(file, 0o666);
  if (fault === "manifest") writeFileSync(join(directory, "manifest.json"), "{}");
  vi.resetModules(); const { readPackagedNativeHistoricalWorker } = await import("../native-historical-archive-worker-client");
  await expect(readPackagedNativeHistoricalWorker()).rejects.toThrow();
});
it("terminates an existing worker on abort instead of leaving a background validation", async () => {
  privateArtifact("setInterval(()=>{},1000)"); vi.resetModules();
  const client = await import("../native-historical-archive-worker-client"), controller = new AbortController();
  const pending = client.verifyNativeHistoricalEvidenceInWorker(bytes, key, entry, request, controller.signal);
  const rejected = expect(pending).rejects.toThrow("aborted");
  setTimeout(() => controller.abort(), 30); await rejected;
});
it("terminates a stalled worker at the unchanged five-second validation deadline", async () => {
  privateArtifact("setInterval(()=>{},1000)"); vi.resetModules();
  const client = await import("../native-historical-archive-worker-client");
  await expect(client.verifyNativeHistoricalEvidenceInWorker(bytes, key, entry, request,
    new AbortController().signal)).rejects.toThrow("deadline");
});
