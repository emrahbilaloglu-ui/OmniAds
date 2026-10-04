import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const root = process.cwd();
const filename = join(root, ".next/standalone/.native-historical-worker/archive-worker.cjs");
const info = await stat(filename);
assert(info.isFile() && info.size > 0 && info.size <= 16 * 1024 * 1024, "standalone worker absent/outside bound");
const source = await readFile(filename), manifest = JSON.parse(await readFile(
  join(root, ".next/standalone/.native-historical-worker/manifest.json"), "utf8"));
const original = JSON.parse(await readFile(join(root, ".native-historical-worker/manifest.json"), "utf8"));
assert.equal(createHash("sha256").update(source).digest("hex"), manifest.sha256);
assert.equal(source.length, manifest.bytes); assert.deepEqual(manifest, original);
for (const fixtureName of ["native-historical-worker.json", "native-historical-worker-compressed.json", "native-historical-worker-reference.json", "native-historical-worker-segmented-reference.json"]) {
const fixture = JSON.parse(await readFile(join(root, "scripts/fixtures", fixtureName), "utf8"));
assert.equal(fixture.syntheticFixtureOnly, true);
if (fixtureName.endsWith("-compressed.json")) {
  assert.equal(fixture.entry.encoding, "native-historical-aes-256-gcm-gzip.v2");
  assert(fixture.entry.plaintextBytes > 2 * 1024 * 1024 && fixture.entry.plaintextBytes <= 8 * 1024 * 1024);
  assert(fixture.entry.ciphertextBytes <= 2 * 1024 * 1024 + 128);
}
if (fixtureName.endsWith("-reference.json")) {
  assert.equal(fixture.canonicalProducerProof, false);
  assert.equal(fixture.entry.encoding, "native-historical-aes-256-gcm-gzip.v2");
  assert.equal(fixture.expectedEvidence.contractVersion, "decision-engine-v3-native-ad-historical-evidence.v2");
  assert(fixture.expectedEvidence.rowJson.campaignContextObject.includes("9007199254740993.123456789"));
  assert(fixture.expectedEvidence.rowJson.campaignContextObject.includes("İstanbul şğı 🚀"));
}
if (fixtureName.endsWith("-segmented-reference.json")) {
  assert.equal(fixture.wholeGenerationRestoreProof,false);
  assert.equal(fixture.entry.segment.evaluationIds.length,1);
  assert.equal(fixture.entry.segment.coverageRoot.core.tables.find(t=>t.table==="engine_v3_ad_decision_evaluations").rowCount,2);
  assert.equal(fixture.expectedEvidence.identity.evaluationId,fixture.entry.segment.evaluationIds[0]);
  assert(fixture.entry.plaintextBytes<=8*1024*1024 && fixture.entry.payloadBytes<=2*1024*1024);
}
const payload = Uint8Array.from(Buffer.from(fixture.ciphertextBase64, "base64"));
const key = Uint8Array.from(Buffer.from(fixture.fixtureEncryptionKeyHex, "hex"));
const worker = new Worker(source.toString("utf8"), { eval: true,
  env: { NODE_ENV: "production" }, stdout: true, stderr: true,
  resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  workerData: { bytes: payload.buffer, key: key.buffer, entry: fixture.entry, request: fixture.request },
  transferList: [payload.buffer, key.buffer] });
worker.stdout.on("data", () => {}); worker.stderr.on("data", () => {});
try {
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("standalone worker exceeded five seconds")), 5000);
    worker.once("message", value => { clearTimeout(timer); resolve(value); });
    worker.once("error", () => { clearTimeout(timer); reject(new Error("standalone worker failed")); });
    worker.once("exit", code => { if (code !== 0) { clearTimeout(timer); reject(new Error("standalone worker exited")); } });
  });
  assert.equal(response.ok, true); assert.deepEqual(response.value, fixture.expectedEvidence);
  assert.equal(response.value.providerAuthority, false); assert.equal(response.value.currentDecisionEligible, false);
  assert.equal(response.value.reclaimEligible, false);
  console.log("[native-historical-worker-package] PASS exact standalone asset/digest, secret-free separate worker, original bytes and authority separation");
  console.log(JSON.stringify({ contract: "native-historical-worker-package-proof.v1", nodeVersion: process.version,
    platform: process.platform, architecture: process.arch, artifactSha256: manifest.sha256, fixtureName,
    originalPlaintextBytes: fixture.entry.plaintextBytes, ciphertextBytes: fixture.entry.ciphertextBytes,
    artifactBytes: source.length, originalEvidenceMatched: true, providerAuthority: false,
    currentDecisionEligible: false, reclaimEligible: false }));
} finally { await worker.terminate(); }
}
