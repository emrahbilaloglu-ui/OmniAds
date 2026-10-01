import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NativeHistoricalReadControls, NativeHistoricalReadLimit, NativeHistoricalObjectBound,
  NATIVE_HISTORICAL_READ_BOUNDS as bounds } from "../native-historical-read-controls";
import type { NativeHistoricalEvidence, NativeHistoricalArchiveCatalogEntry, NativeHistoricalEvidenceRequest } from "@/lib/creative-decision-engine/native-historical-archive";

const bytes = Buffer.from("controller fixture bytes");
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const generation = { businessId: "business", jobRunId: "original", asOfDate: "2026-09-30", engineVersion: "fixture" };
const entry = { generation, parentManifestHash: "a".repeat(64), parentSchemaHash: "b".repeat(64),
  encryptionKeyId: "fixture", plaintextSha256: "c".repeat(64), plaintextBytes: 1,
  ciphertextSha256: sha(bytes), ciphertextBytes: bytes.length,
  object: { bucket: "fixture", key: "native/v1/" + sha(bytes) + ".bin", versionId: "original-version" } };
const request = { generation, providerAccountId: "act_1", adId: "ad", evaluationId: "evaluation" };
const config = "f".repeat(64);
function evidence(r = request): NativeHistoricalEvidence {
  return { status: "historical_available", contractVersion: "decision-engine-v3-native-ad-historical-evidence.v1",
    authority: "historical_read_only", providerAuthority: false, currentDecisionEligible: false, reclaimEligible: false,
    generation: { ...r.generation }, sourceRevision: "a".repeat(40), capturedAt: "2026-10-01T00:00:00Z",
    identity: { providerAccountId: r.providerAccountId, adId: r.adId, evaluationId: r.evaluationId,
      providerAccountRefId: "account-ref", contextId: "context", inputHash: "a".repeat(64), decisionHash: "a".repeat(64) },
    rowJson: { evaluation: '{"original":9007199254740993.123456789}', context: "{}", inputEvidence: "{}", snapshot: null } };
}
type Work = Awaited<ReturnType<Parameters<NativeHistoricalReadControls["read"]>[1]>>["work"];
function read(controller: NativeHistoricalReadControls, configurationFingerprint: string, entry: NativeHistoricalArchiveCatalogEntry, request: NativeHistoricalEvidenceRequest, work: Work) {
 return controller.read(request, async () => ({ configurationFingerprint, entry, work }));
}
afterEach(() => { vi.useRealTimers(); });
function fixture() {
  let clock = 0, downloads = 0, validations = 0;
  const events: unknown[] = [];
  const controller = new NativeHistoricalReadControls(() => clock, (event, data) => events.push({ event, ...data }));
  const work = { download: async () => { downloads++; return bytes; },
    validate: async (_bytes: Buffer, _entry: unknown, r: typeof request) => { validations++; return evidence(r); } };
  return { controller, work, events, advance: (n: number) => { clock += n; }, counts: () => ({ downloads, validations }) };
}
it("same immutable request shares one GET/validation and later verified cache", async () => {
  const f = fixture(); let release!: () => void;
  f.work.download = async () => { await new Promise<void>(resolve => { release = resolve; }); return bytes; };
  const a = read(f.controller, config, entry, request, f.work), b = read(f.controller, config, entry, request, f.work);
  await Promise.resolve(); release(); const [first, second] = await Promise.all([a, b]); assert.deepEqual(first, second);
  assert.equal(f.counts().validations, 1);
  first.rowJson.evaluation = "caller mutation";
  const third = await read(f.controller, config, entry, request, f.work); assert.notEqual(third.rowJson.evaluation, "caller mutation");
  assert.equal(f.counts().validations, 1);
});
it("different original evaluation reuses verified transport but validates identity again", async () => {
  const f = fixture(); await read(f.controller, config, entry, request, f.work);
  const other = { ...request, evaluationId: "another" };
  const result = await read(f.controller, config, entry, other, f.work);
  assert.equal(result.identity.evaluationId, "another"); assert.deepEqual(f.counts(), { downloads: 1, validations: 2 });
});
for (const dimension of ["configuration", "version", "parent-schema", "encryption-key"]) {
  it(dimension + " change cannot reuse a previous trust/cache", async () => {
    const f = fixture(); await read(f.controller, config, entry, request, f.work);
    const other = structuredClone(entry); let fingerprint = config;
    if (dimension === "configuration") fingerprint = "e".repeat(64);
    else if (dimension === "version") other.object.versionId = "later-version";
    else if (dimension === "parent-schema") other.parentSchemaHash = "e".repeat(64);
    else other.encryptionKeyId = "other-key";
    await read(f.controller, fingerprint, other, request, f.work);
    assert.deepEqual(f.counts(), { downloads: 2, validations: 2 });
  });
}
it("TTL expiration re-verifies immutable source", async () => {
  const f = fixture(); await read(f.controller, config, entry, request, f.work); f.advance(bounds.cacheTtlMs + 1);
  await read(f.controller, config, entry, request, f.work); assert.deepEqual(f.counts(), { downloads: 2, validations: 2 });
});
it("foreign generation refuses before I/O", async () => {
  const f = fixture(); await assert.rejects(() => read(f.controller, config, entry,
    { ...request, generation: { ...generation, businessId: "foreign" } }, f.work)); assert.equal(f.counts().downloads, 0);
});
it("2MiB pilot object bound rejects larger packages before I/O", async () => {
  const f = fixture(); await assert.rejects(() => read(f.controller, config,
    { ...entry, plaintextBytes: bounds.maxPlaintextBytes + 1 }, request, f.work), NativeHistoricalObjectBound);
  assert.equal(f.counts().downloads, 0);
});
it("256KiB returned-row bound rejects before caching", async () => {
  const f = fixture(); f.work.validate = async () => { const value = evidence(); value.rowJson.context = "x".repeat(bounds.maxResponseBytes); return value; };
  await assert.rejects(() => read(f.controller, config, entry, request, f.work), NativeHistoricalObjectBound);
  f.work.validate = async () => evidence(); await read(f.controller, config, entry, request, f.work);
  assert.equal(f.counts().downloads, 2);
});
it("failed integrity releases admission and never caches the failure", async () => {
  const f = fixture(); f.work.validate = async () => { throw new Error("simulated integrity refusal"); };
  await assert.rejects(() => read(f.controller, config, entry, request, f.work));
  f.work.validate = async () => evidence(); await read(f.controller, config, entry, request, f.work);
  assert.equal(f.counts().downloads, 2);
});
it("foreign/authoritative result refuses even if a validation callback misbehaves", async () => {
  const f = fixture(); f.work.validate = async () => ({ ...evidence(), providerAuthority: true as never });
  await assert.rejects(() => read(f.controller, config, entry, request, f.work));
  f.work.validate = async () => evidence({ ...request, evaluationId: "foreign" });
  await assert.rejects(() => read(f.controller, config, entry, request, f.work));
});
it("business/global validation saturation has no hidden queue", async () => {
  const f = fixture(), releases: (() => void)[] = [];
  f.work.download = async () => { await new Promise<void>(resolve => { releases.push(resolve); }); return bytes; };
  const first = read(f.controller, config, entry, request, f.work);
  await assert.rejects(() => read(f.controller, config, entry, { ...request, evaluationId: "different" }, f.work), NativeHistoricalReadLimit);
  const other = { ...request, generation: { ...generation, businessId: "other" } };
  const second = read(f.controller, config, { ...entry, generation: other.generation }, other, f.work);
  const third = { ...request, generation: { ...generation, businessId: "third" } };
  await assert.rejects(() => read(f.controller, config, { ...entry, generation: third.generation }, third, f.work), NativeHistoricalReadLimit);
  assert.equal(releases.length, 2); releases.forEach(release => release()); await Promise.all([first, second]);
});
it("duplicate waiters are bounded per business", async () => {
  const f = fixture(); let release!: () => void;
  f.work.download = async () => { await new Promise<void>(resolve => { release = resolve; }); return bytes; };
  const first = read(f.controller, config, entry, request, f.work), second = read(f.controller, config, entry, request, f.work);
  await assert.rejects(() => read(f.controller, config, entry, request, f.work), NativeHistoricalReadLimit);
  await Promise.resolve(); release(); await Promise.all([first, second]);
});
it("request-rate budget applies to cached responses and resets only at its window", async () => {
  const f = fixture(); for (let i = 0; i < bounds.businessWindowRequests; i++) await read(f.controller, config, entry, request, f.work);
  await assert.rejects(() => read(f.controller, config, entry, request, f.work), NativeHistoricalReadLimit);
  f.advance(bounds.budgetWindowMs); await read(f.controller, config, entry, request, f.work);
});
it("download budget reserves exact bounded bytes before network work", async () => {
  const f = fixture(), large = Buffer.alloc(bounds.maxPlaintextBytes);
  let downloadCalls = 0; f.work.download = async () => { downloadCalls++; return large; };
  const largeEntry = { ...entry, plaintextBytes: large.length, ciphertextBytes: large.length, ciphertextSha256: sha(large) };
  for (let i = 0; i < 16; i++) await read(f.controller, config,
    { ...largeEntry, object: { ...entry.object, versionId: String(i) } }, request, f.work);
  await assert.rejects(() => read(f.controller, config,
    { ...largeEntry, object: { ...entry.object, versionId: "over-budget" } }, request, f.work), NativeHistoricalReadLimit);
});
it("logs expose fixed events and numeric cost only", async () => {
  const f = fixture(); await read(f.controller, config, entry, request, f.work);
  for (const event of f.events) assert.deepEqual(Object.keys(event as object).sort(), ["bytes", "durationMs", "event"]);
  assert(!JSON.stringify(f.events).includes(entry.encryptionKeyId));
});

it("admission precedes catalog loading and caps eight total active requests", async () => {
  let prepares = 0; const releases: (() => void)[] = [];
  const controller = new NativeHistoricalReadControls();
  const pending = Array.from({ length: bounds.activeRequests }, (_, i) => {
    const scoped = { ...request, generation: { ...generation, businessId: "active-" + i } };
    return controller.read(scoped, async () => {
      prepares++; await new Promise<void>(resolve => releases.push(resolve));
      return { configurationFingerprint: config, entry: { ...entry, generation: scoped.generation },
        work: { download: async () => bytes, validate: async () => evidence(scoped) } };
    });
  });
  const extra = { ...request, generation: { ...generation, businessId: "over-active" } };
  await assert.rejects(() => controller.read(extra, async () => { prepares++; throw new Error("must not load"); }), NativeHistoricalReadLimit);
  assert.equal(prepares, bounds.activeRequests);
  // Resolve catalog preparation sequentially so the separate two-validation limit is not the tested boundary.
  for (let i = 0; i < pending.length; i++) { releases[i]!(); await pending[i]; }
});
it("a total deadline includes slow preparation; a late catalog does no GET", async () => {
  vi.useFakeTimers(); const f = fixture(); let ready!: () => void;
  const readPromise = f.controller.read(request, async () => {
    await new Promise<void>(resolve => { ready = resolve; });
    return { configurationFingerprint: config, entry, work: f.work };
  });
  const rejected = assert.rejects(() => readPromise, NativeHistoricalReadLimit);
  await vi.advanceTimersByTimeAsync(bounds.deadlineMs); await rejected;
  ready(); await Promise.resolve(); assert.deepEqual(f.counts(), { downloads: 0, validations: 0 });
  await read(f.controller, config, entry, request, f.work); assert.equal(f.counts().validations, 1);
});
it("late verification after a deadline cannot populate either verified cache", async () => {
  vi.useFakeTimers(); const f = fixture(); let verified!: () => void, aborted = false;
  f.work.validate = async () => { await new Promise<void>(resolve => { verified = resolve; }); return evidence(); };
  const pending = f.controller.read(request, async () => ({ configurationFingerprint: config, entry,
    work: { ...f.work, download: async (_entry, signal) => { signal.addEventListener("abort", () => { aborted = true; }); return bytes; } } }));
  const rejected = assert.rejects(() => pending, NativeHistoricalReadLimit);
  await vi.advanceTimersByTimeAsync(bounds.deadlineMs); await rejected; assert(aborted);
  verified(); await Promise.resolve(); await Promise.resolve();
  f.work.validate = async () => evidence(); await read(f.controller, config, entry, request, f.work);
  assert.equal(f.counts().downloads, 1, "new read must download instead of inheriting late ciphertext");
});
it("verified byte-cache evicts entries by bytes rather than retaining every large object", async () => {
  const f = fixture(), large = Buffer.alloc(bounds.maxPlaintextBytes);
  let downloadCalls = 0; f.work.download = async () => { downloadCalls++; return large; };
  const largeEntry = { ...entry, plaintextBytes: large.length, ciphertextBytes: large.length, ciphertextSha256: sha(large) };
  for (let i = 0; i < 5; i++) await read(f.controller, config,
    { ...largeEntry, object: { ...entry.object, versionId: String(i) } }, request, f.work);
  // A different evaluation misses evidence-cache and the first object's cipher was evicted.
  await read(f.controller, config, { ...largeEntry, object: { ...entry.object, versionId: "0" } },
    { ...request, evaluationId: "different" }, f.work);
  assert.equal(downloadCalls, 6);
});
it("per-business response-byte budget also applies to verified cache hits", async () => {
  const f = fixture(); let verificationCalls = 0; f.work.validate = async () => {
    verificationCalls++; const value = evidence(); value.rowJson.context = "x".repeat(250_000); return value;
  };
  const weight = Buffer.byteLength(JSON.stringify(await read(f.controller, config, entry, request, f.work)));
  const maximum = Math.floor(bounds.businessWindowResponseBytes / weight);
  for (let i = 1; i < maximum; i++) await read(f.controller, config, entry, request, f.work);
  await assert.rejects(() => read(f.controller, config, entry, request, f.work), NativeHistoricalReadLimit);
  assert.equal(verificationCalls, 1);
});
