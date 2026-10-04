import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeArchiveByteDigest, nativeHistoricalImmutableEntryFingerprint, openImmutableNativeHistoricalArchiveCatalog,
  NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT, type NativeHistoricalEvidenceRequest } from "../native-historical-archive";
import { buildNativeHistoricalCatalogRouting, NativeHistoricalCatalogRouter, nativeHistoricalGenerationBucket,
  NATIVE_HISTORICAL_ROUTING_BOUNDS as bounds, NATIVE_HISTORICAL_ROUTING_CONTRACT, NATIVE_HISTORICAL_SHARD_CONTRACT,
  type NativeHistoricalRoutingPublication, type NativeHistoricalMetadataRead } from "../native-historical-catalog-routing";

// Metadata-only copies of a public synthetic entry. Altered generations are NOT
// decrypted producer or authority proofs. Real producer/compiled proofs are separate.
const fixture = JSON.parse(readFileSync(resolve("scripts/fixtures/native-historical-worker.json"), "utf8"));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const buffer = (value: unknown) => Buffer.from(JSON.stringify(value));
const pinned = (content: Buffer) => ({ content, sha256: nativeArchiveByteDigest(content) });
function entry(n: number) { return { ...structuredClone(fixture.entry), generation: { ...fixture.entry.generation, jobRunId: uuid(n) } }; }
function leaf(n: number, padding = 0) {
  return pinned(buffer({ contract: NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT, groups: [], entries: [entry(n)],
    ...(padding ? { ignoredMetadataPadding: "x".repeat(padding) } : {}) }));
}
const legacy = pinned(buffer({ contract: "native-historical-archive-catalog.v1", entries: [entry(1)] }));
const request = (n: number): NativeHistoricalEvidenceRequest => ({ ...fixture.request, generation: entry(n).generation });
function context(publication: NativeHistoricalRoutingPublication, readerAssetSha256 = "a".repeat(64)) {
  return { rootSha256: publication.root.sha256, legacySha256: legacy.sha256, readerAssetSha256, directory: "/owned/metadata" };
}
function loader(publication: NativeHistoricalRoutingPublication) {
  const load = vi.fn(async (r: NativeHistoricalMetadataRead) => {
    const f = publication.files.find(f => f.kind === r.kind && f.sha256 === r.sha256);
    if (!f) throw new Error("owned fixture missing"); return Buffer.from(f.content);
  });
  return load;
}
function changeFile(publication: NativeHistoricalRoutingPublication, kind: "root" | "shard", mutate: (v: Record<string, unknown>) => void) {
  const p = structuredClone(publication);
  for (const f of p.files) f.content = Buffer.from(f.content);
  const f = p.files.find(f => f.kind === kind)!;
  const old = f.sha256, value = JSON.parse(f.content.toString()); mutate(value);
  f.content = buffer(value); f.bytes = f.content.length; f.sha256 = nativeArchiveByteDigest(f.content);
  const root = p.files.find(f => f.kind === "root")!;
  if (kind === "shard") {
    const r = JSON.parse(root.content.toString());
    const selected = r.shards.find((s: { sha256: string }) => s.sha256 === old); selected.sha256 = f.sha256; selected.bytes = f.bytes;
    root.content = buffer(r); root.bytes = root.content.length; root.sha256 = nativeArchiveByteDigest(root.content);
  }
  p.root = { sha256: root.sha256, bytes: root.bytes }; return p;
}

describe("finite digest-pinned generation routing", () => {
  it("routes two catalogs whose combined bytes exceed 1MiB without reading legacy or the other leaf", async () => {
    const a = leaf(2, 600000), b = leaf(3, 600000);
    expect(a.content.length + b.content.length).toBeGreaterThan(bounds.requestMetadataBytes);
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [a, b] }), router = new NativeHistoricalCatalogRouter(), load = loader(p);
    for (const n of [2, 3]) {
      load.mockClear(); const selected = await router.resolve(request(n), context(p), load);
      expect(selected.entry.generation).toEqual(request(n).generation);
      expect(load.mock.calls.filter(([r]) => r.kind === "leaf")).toHaveLength(1);
      expect(load.mock.calls.some(([r]) => r.kind === "legacy")).toBe(false);
      expect(load.mock.calls.reduce((sum, [r]) => sum + p.files.find(f => f.sha256 === r.sha256)!.bytes, 0)).toBeLessThan(bounds.requestMetadataBytes);
    }
    expect(p).toMatchObject({ providerAuthority: false, reclaimEligible: false });
  });
  it("takes the legacy XOR path with byte-identical old entry and never falls through on a wrong generation", async () => {
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] }), load = loader(p), router = new NativeHistoricalCatalogRouter();
    expect((await router.resolve(request(1), context(p), load)).entry).toEqual(entry(1));
    expect(load.mock.calls.map(([r]) => r.kind)).toEqual(["root", "legacy"]);
    load.mockClear(); await expect(router.resolve({ ...request(1), generation: { ...request(1).generation, asOfDate: "2026-10-01" } }, context(p), load)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
  it.each(["businessId", "asOfDate", "engineVersion"])("refuses request %s mismatch BEFORE reading a leaf", async field => {
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] }), load = loader(p);
    const changed = { ...request(2), generation: { ...request(2).generation,
      [field]: field === "businessId" ? uuid(999) : field === "asOfDate" ? "2026-10-01" : "foreign-epoch" } };
    await expect(new NativeHistoricalCatalogRouter().resolve(changed, context(p), load)).rejects.toThrow();
    expect(load.mock.calls.map(([r]) => r.kind)).toEqual(["root", "shard"]);
  });
  it("allows normal prefix collisions while refusing duplicate full jobs and legacy overlap at publication", async () => {
    const jobs: number[] = [], bucket = nativeHistoricalGenerationBucket(uuid(2));
    for (let i = 2; jobs.length < 2; i++) if (nativeHistoricalGenerationBucket(uuid(i)) === bucket) jobs.push(i);
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: jobs.map(n => leaf(n)) });
    expect(p.files.filter(f => f.kind === "shard")).toHaveLength(1);
    for (const n of jobs) expect((await new NativeHistoricalCatalogRouter().resolve(request(n), context(p), loader(p))).entry.generation.jobRunId).toBe(uuid(n));
    expect(() => buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2), leaf(2)] })).toThrow();
    expect(() => buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(1)] })).toThrow();
  });
  it("refuses the complete selected shard if a legacy job is smuggled into it", async () => {
    const bucket = nativeHistoricalGenerationBucket(uuid(1)); let n = 2;
    while (nativeHistoricalGenerationBucket(uuid(n)) !== bucket) n++;
    const p = changeFile(buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(n)] }), "shard", s => {
      const records = s.records as { generation: { jobRunId: string }; leaf: unknown }[];
      records.push({ ...records[0]!, generation: entry(1).generation }); records.sort((a, b) => a.generation.jobRunId.localeCompare(b.generation.jobRunId));
    });
    const load = loader(p); await expect(new NativeHistoricalCatalogRouter().resolve(request(n), context(p), load)).rejects.toThrow();
    expect(load.mock.calls.some(([r]) => r.kind === "leaf")).toBe(false);
  });
  it("refuses legacy digest mismatch, a dishonest frozen legacy set and unknown fields", async () => {
    const original = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] });
    await expect(new NativeHistoricalCatalogRouter().resolve(request(2), { ...context(original), legacySha256: "f".repeat(64) }, loader(original))).rejects.toThrow();
    const changed = changeFile(original, "root", r => { (r.legacy as { jobRunIds: string[] }).jobRunIds.push(uuid(999)); });
    await expect(new NativeHistoricalCatalogRouter().resolve(request(1), context(changed), loader(changed))).rejects.toThrow();
    const unknown = changeFile(original, "root", r => { r.latest = "forbidden"; });
    await expect(new NativeHistoricalCatalogRouter().resolve(request(2), context(unknown), loader(unknown))).rejects.toThrow();
  });
  it("refuses a foreign/mixed leaf, a wrong digest and an unavailable bucket with no fallback", async () => {
    const mixed = pinned(buffer({ contract: NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT, groups: [], entries: [entry(2), entry(3)] }));
    expect(() => buildNativeHistoricalCatalogRouting({ legacy, leaves: [mixed] })).toThrow();
    expect(() => buildNativeHistoricalCatalogRouting({ legacy, leaves: [{ ...leaf(2), sha256: "f".repeat(64) }] })).toThrow();
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [] }), load = loader(p);
    await expect(new NativeHistoricalCatalogRouter().resolve(request(2), context(p), load)).rejects.toThrow();
    expect(load.mock.calls.map(([r]) => r.kind)).toEqual(["root"]);
  });
  it("enforces fixed component caps without a dynamic remainder or cap increase", async () => {
    expect(bounds.rootBytes + Math.max(bounds.legacyBytes, bounds.shardBytes + bounds.leafBytes)).toBe(1032192);
    expect(() => buildNativeHistoricalCatalogRouting({ legacy: pinned(Buffer.alloc(bounds.legacyBytes + 1)), leaves: [] })).toThrow();
    expect(() => buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2, bounds.leafBytes)] })).toThrow();
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] });
    await expect(new NativeHistoricalCatalogRouter().resolve(request(2), context(p), async r =>
      r.kind === "root" ? Buffer.alloc(bounds.rootBytes + 1) : loader(p)(r))).rejects.toThrow();
    const cap = changeFile(p, "shard", s => { ((s.records as { leaf: { bytes: number } }[])[0]!).leaf.bytes = bounds.leafBytes + 1; });
    await expect(new NativeHistoricalCatalogRouter().resolve(request(2), context(cap), loader(cap))).rejects.toThrow();
  });
  it("refuses a measured overflowing shard and never dynamically re-buckets", () => {
    const bucket = nativeHistoricalGenerationBucket(uuid(2)), jobs: number[] = [];
    for (let i = 2; jobs.length < 140; i++) if (nativeHistoricalGenerationBucket(uuid(i)) === bucket) jobs.push(i);
    expect(() => buildNativeHistoricalCatalogRouting({ legacy, leaves: jobs.map(n => leaf(n)) })).toThrow();
    expect(bounds.buckets).toBe(256);
  });
  it("rejects duplicate keys, unknown shard fields and a selected shard from a different bucket", async () => {
    const original = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] });
    for (const mutate of [
      (s: Record<string, unknown>) => { (s.records as unknown[]).push((s.records as unknown[])[0]); },
      (s: Record<string, unknown>) => { s.bucket = s.bucket === "ff" ? "00" : "ff"; },
      (s: Record<string, unknown>) => { s.next = "forbidden"; },
    ]) {
      const p = changeFile(original, "shard", mutate);
      await expect(new NativeHistoricalCatalogRouter().resolve(request(2), context(p), loader(p))).rejects.toThrow();
    }
  });
});

describe("verified immutable metadata cache", () => {
  it("skips reads/verification on a hot identity, then misses on asset, directory, root or gate reset", async () => {
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] }), load = loader(p), router = new NativeHistoricalCatalogRouter();
    const first = await router.resolve(request(2), context(p), load); expect(load).toHaveBeenCalledTimes(3);
    load.mockClear(); const hot = await router.resolve(request(2), context(p), load); expect(load).not.toHaveBeenCalled(); expect(hot.entry).toBe(first.entry);
    expect(Object.isFrozen(hot.entry)).toBe(true); expect(Object.isFrozen(hot.entry.generation)).toBe(true);
    expect(() => { hot.entry.object.versionId = "mutated"; }).toThrow();
    expect(nativeHistoricalImmutableEntryFingerprint(hot.entry)).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeHistoricalImmutableEntryFingerprint(structuredClone(hot.entry))).toBeUndefined();
    await router.resolve(request(2), context(p, "b".repeat(64)), load); expect(load).toHaveBeenCalledTimes(3);
    load.mockClear(); await router.resolve(request(2), { ...context(p), directory: "/another-owned/root" }, load); expect(load).toHaveBeenCalledTimes(3);
    const next = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2), leaf(3)] }), nextLoad = loader(next);
    await router.resolve(request(2), context(next), nextLoad); expect(nextLoad).toHaveBeenCalledTimes(3);
    router.clearVerifiedMetadata(); nextLoad.mockClear(); await router.resolve(request(2), context(next), nextLoad); expect(nextLoad).toHaveBeenCalledTimes(3);
  });
  it("misses on changed shard/leaf digest and refuses a modified file rather than returning old trust", async () => {
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] }), router = new NativeHistoricalCatalogRouter();
    await router.resolve(request(2), context(p), loader(p));
    const changed = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2, 1)] }), load = loader(changed);
    await router.resolve(request(2), context(changed), load); expect(load).toHaveBeenCalledTimes(3);
    router.clearVerifiedMetadata();
    await expect(router.resolve(request(2), context(changed), async r => {
      const bytes = await load(r); if (r.kind === "leaf") bytes[20] ^= 1; return bytes;
    })).rejects.toThrow();
  });
  it("evicts the third leaf by both finite entry/byte weight and returns no caller-mutable trust", async () => {
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2, 700000), leaf(3, 700000), leaf(4, 700000)] });
    const load = loader(p), router = new NativeHistoricalCatalogRouter();
    for (const n of [2, 3, 4]) await router.resolve(request(n), context(p), load);
    load.mockClear(); await router.resolve(request(2), context(p), load);
    expect(load.mock.calls.filter(([r]) => r.kind === "leaf")).toHaveLength(1);
    const direct = openImmutableNativeHistoricalArchiveCatalog(leaf(2).content, leaf(2).sha256);
    const shallow = Object.freeze(structuredClone(direct.entries[0]!));
    expect(nativeHistoricalImmutableEntryFingerprint(shallow)).toBeUndefined();
  });
  it("never populates trust from a late metadata read after the outer abort", async () => {
    const p = buildNativeHistoricalCatalogRouting({ legacy, leaves: [leaf(2)] }), router = new NativeHistoricalCatalogRouter(), load = loader(p);
    const abort = new AbortController();
    await expect(router.resolve(request(2), context(p), async r => { const bytes = await load(r); abort.abort(); return bytes; }, abort.signal)).rejects.toThrow();
    load.mockClear(); await router.resolve(request(2), context(p), load); expect(load).toHaveBeenCalledTimes(3);
  });
  it("keeps root/shard contract values fixed rather than inferring a newer format", () => {
    expect(NATIVE_HISTORICAL_ROUTING_CONTRACT).toBe("native-historical-generation-routing.v1");
    expect(NATIVE_HISTORICAL_SHARD_CONTRACT).toBe("native-historical-generation-shard.v1");
  });
});
