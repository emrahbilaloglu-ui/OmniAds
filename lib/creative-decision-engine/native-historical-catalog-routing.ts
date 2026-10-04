import { nativeArchiveByteDigest, NATIVE_HISTORICAL_MAX_CATALOG_BYTES, NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT,
  openImmutableNativeHistoricalArchiveCatalog, resolveNativeHistoricalArchiveEntry,
  type NativeHistoricalArchiveCatalog, type NativeHistoricalEvidenceRequest } from "./native-historical-archive";
import type { NativeArchiveGeneration } from "./native-evidence-archive";

export const NATIVE_HISTORICAL_ROUTING_CONTRACT = "native-historical-generation-routing.v1" as const;
export const NATIVE_HISTORICAL_SHARD_CONTRACT = "native-historical-generation-shard.v1" as const;
export const NATIVE_HISTORICAL_ROUTING_GATE = "ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED";
export const NATIVE_HISTORICAL_ROUTING_BOUNDS = Object.freeze({
  rootBytes: 32 * 1024, legacyBytes: 16 * 1024, shardBytes: 32 * 1024, leafBytes: 944 * 1024,
  requestMetadataBytes: NATIVE_HISTORICAL_MAX_CATALOG_BYTES, buckets: 256,
  cacheSourceBytes: 2 * 1024 * 1024, cacheLeaves: 2, cacheEntries: 32,
});
export type NativeHistoricalMetadataKind = "root" | "legacy" | "shard" | "leaf";
export interface NativeHistoricalMetadataRef { sha256: string; bytes: number }
export interface NativeHistoricalGenerationRoute {
  generation: NativeArchiveGeneration;
  leaf: NativeHistoricalMetadataRef;
}
interface Root {
  contract: typeof NATIVE_HISTORICAL_ROUTING_CONTRACT;
  legacy: NativeHistoricalMetadataRef & { jobRunIds: string[] };
  shards: (NativeHistoricalMetadataRef & { bucket: string })[];
}
interface Shard {
  contract: typeof NATIVE_HISTORICAL_SHARD_CONTRACT;
  bucket: string;
  records: NativeHistoricalGenerationRoute[];
}
export interface NativeHistoricalRoutingFile extends NativeHistoricalMetadataRef {
  kind: NativeHistoricalMetadataKind;
  content: Buffer;
}
export interface NativeHistoricalRoutingPublication {
  contract: typeof NATIVE_HISTORICAL_ROUTING_CONTRACT;
  root: NativeHistoricalMetadataRef;
  files: NativeHistoricalRoutingFile[];
  providerAuthority: false;
  reclaimEligible: false;
}
export interface NativeHistoricalMetadataRead {
  kind: NativeHistoricalMetadataKind;
  sha256: string;
  bytes?: number;
  maxBytes: number;
}
type Load = (reference: NativeHistoricalMetadataRead, signal?: AbortSignal) => Promise<Buffer>;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function refuse(): never { throw new Error("native_historical_catalog_routing_refused"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) refuse();
}
function sha(value: unknown): string { if (typeof value !== "string" || !SHA.test(value)) refuse(); return value; }
function length(value: unknown, bound: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > bound) refuse();
  return value;
}
function generation(value: unknown): NativeArchiveGeneration {
  const g = object(value); keys(g, ["businessId", "jobRunId", "asOfDate", "engineVersion"]);
  if (typeof g.businessId !== "string" || !UUID.test(g.businessId) || typeof g.jobRunId !== "string" || !UUID.test(g.jobRunId) ||
      typeof g.asOfDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(g.asOfDate) ||
      new Date(`${g.asOfDate}T00:00:00Z`).toISOString().slice(0, 10) !== g.asOfDate ||
      typeof g.engineVersion !== "string" || !g.engineVersion.length || g.engineVersion.length > 256 ||
      g.engineVersion.trim() !== g.engineVersion) refuse();
  return { businessId: g.businessId, jobRunId: g.jobRunId, asOfDate: g.asOfDate, engineVersion: g.engineVersion };
}
function same(a: NativeArchiveGeneration, b: NativeArchiveGeneration) {
  return a.businessId === b.businessId && a.jobRunId === b.jobRunId && a.asOfDate === b.asOfDate && a.engineVersion === b.engineVersion;
}
export function nativeHistoricalGenerationBucket(jobRunId: string) {
  if (!UUID.test(jobRunId)) refuse();
  return nativeArchiveByteDigest(jobRunId).slice(0, 2);
}
function sortedUnique(values: string[]) {
  if (new Set(values).size !== values.length || [...values].sort().join("|") !== values.join("|")) refuse();
}
function metadata(bytes: Uint8Array, digest: string, bound: number, expectedBytes?: number) {
  length(bytes.byteLength, bound);
  if (expectedBytes !== undefined && bytes.byteLength !== length(expectedBytes, bound) || nativeArchiveByteDigest(bytes) !== sha(digest)) refuse();
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
function root(bytes: Buffer, digest: string, legacyDigest: string): Root {
  metadata(bytes, digest, NATIVE_HISTORICAL_ROUTING_BOUNDS.rootBytes);
  const r = object(JSON.parse(bytes.toString("utf8"))); keys(r, ["contract", "legacy", "shards"]);
  const l = object(r.legacy); keys(l, ["sha256", "bytes", "jobRunIds"]);
  if (r.contract !== NATIVE_HISTORICAL_ROUTING_CONTRACT || sha(l.sha256) !== sha(legacyDigest) ||
      !Array.isArray(l.jobRunIds) || l.jobRunIds.length > 128 || l.jobRunIds.some(j => typeof j !== "string" || !UUID.test(j)) ||
      !Array.isArray(r.shards) || r.shards.length > NATIVE_HISTORICAL_ROUTING_BOUNDS.buckets) refuse();
  const jobRunIds = l.jobRunIds as string[]; sortedUnique(jobRunIds);
  const shards = r.shards.map(raw => {
    const s = object(raw); keys(s, ["bucket", "sha256", "bytes"]);
    if (typeof s.bucket !== "string" || !/^[a-f0-9]{2}$/.test(s.bucket)) refuse();
    return { bucket: s.bucket, sha256: sha(s.sha256), bytes: length(s.bytes, NATIVE_HISTORICAL_ROUTING_BOUNDS.shardBytes) };
  });
  sortedUnique(shards.map(s => s.bucket));
  if (new Set(shards.map(s => s.sha256)).size !== shards.length) refuse();
  return deepFreeze({ contract: NATIVE_HISTORICAL_ROUTING_CONTRACT, legacy: {
    sha256: sha(l.sha256), bytes: length(l.bytes, NATIVE_HISTORICAL_ROUTING_BOUNDS.legacyBytes), jobRunIds }, shards });
}
function shard(bytes: Buffer, reference: Root["shards"][number], legacy: string[]): Shard {
  metadata(bytes, reference.sha256, NATIVE_HISTORICAL_ROUTING_BOUNDS.shardBytes, reference.bytes);
  const s = object(JSON.parse(bytes.toString("utf8"))); keys(s, ["contract", "bucket", "records"]);
  if (s.contract !== NATIVE_HISTORICAL_SHARD_CONTRACT || s.bucket !== reference.bucket || !Array.isArray(s.records) || !s.records.length) refuse();
  const records = s.records.map(raw => {
    const r = object(raw); keys(r, ["generation", "leaf"]);
    const g = generation(r.generation), l = object(r.leaf); keys(l, ["sha256", "bytes"]);
    if (nativeHistoricalGenerationBucket(g.jobRunId) !== s.bucket || legacy.includes(g.jobRunId)) refuse();
    return { generation: g, leaf: { sha256: sha(l.sha256), bytes: length(l.bytes, NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes) } };
  });
  // Normal 8-bit prefix sharing is required. Only duplicate full job keys refuse.
  sortedUnique(records.map(r => r.generation.jobRunId));
  return deepFreeze({ contract: NATIVE_HISTORICAL_SHARD_CONTRACT, bucket: reference.bucket, records });
}
function leaf(bytes: Buffer, digest: string, expected?: NativeArchiveGeneration, expectedBytes?: number) {
  metadata(bytes, digest, NATIVE_HISTORICAL_ROUTING_BOUNDS.leafBytes, expectedBytes);
  const catalog = openImmutableNativeHistoricalArchiveCatalog(bytes, digest);
  if (catalog.contract !== NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT || !catalog.entries.length ||
      (catalog.groups?.length ?? 0) > 1) refuse();
  const g = catalog.entries[0]!.generation;
  if (expected && !same(g, expected) || catalog.entries.some(e => !same(e.generation, g))) refuse();
  const fragments = catalog.entries.filter(e => e.segment !== undefined).length;
  if (fragments !== 0 && fragments !== catalog.entries.length) refuse();
  return catalog;
}
function legacyJobs(catalog: NativeHistoricalArchiveCatalog) {
  return [...new Set(catalog.entries.map(e => e.generation.jobRunId))].sort();
}

/** OFFLINE publisher: validates every independently pinned complete leaf, then
 * returns immutable content-addressed metadata. No capture, environment switch,
 * DB write, authority, listing or automatic source retirement. */
export function buildNativeHistoricalCatalogRouting(input: {
  legacy: { content: Buffer; sha256: string };
  leaves: { content: Buffer; sha256: string }[];
}): NativeHistoricalRoutingPublication {
  const b = NATIVE_HISTORICAL_ROUTING_BOUNDS;
  metadata(input.legacy.content, input.legacy.sha256, b.legacyBytes);
  const old = openImmutableNativeHistoricalArchiveCatalog(input.legacy.content, input.legacy.sha256);
  const oldJobs = legacyJobs(old), jobs = new Set(oldJobs), buckets = new Map<string, NativeHistoricalGenerationRoute[]>();
  const files: NativeHistoricalRoutingFile[] = [{ kind: "legacy", sha256: input.legacy.sha256,
    bytes: input.legacy.content.length, content: Buffer.from(input.legacy.content) }];
  for (const l of input.leaves) {
    const c = leaf(l.content, l.sha256), g = c.entries[0]!.generation;
    if (jobs.has(g.jobRunId)) refuse(); jobs.add(g.jobRunId);
    const bucket = nativeHistoricalGenerationBucket(g.jobRunId), records = buckets.get(bucket) ?? [];
    records.push({ generation: g, leaf: { sha256: l.sha256, bytes: l.content.length } }); buckets.set(bucket, records);
    files.push({ kind: "leaf", sha256: l.sha256, bytes: l.content.length, content: Buffer.from(l.content) });
  }
  const shards = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, records]) => {
    records.sort((a, b) => a.generation.jobRunId.localeCompare(b.generation.jobRunId));
    const content = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_SHARD_CONTRACT, bucket, records }));
    const reference = { bucket, sha256: nativeArchiveByteDigest(content), bytes: length(content.length, b.shardBytes) };
    shard(content, reference, oldJobs);
    files.push({ kind: "shard", sha256: reference.sha256, bytes: content.length, content }); return reference;
  });
  const content = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_ROUTING_CONTRACT,
    legacy: { sha256: input.legacy.sha256, bytes: input.legacy.content.length, jobRunIds: oldJobs }, shards }));
  const digest = nativeArchiveByteDigest(content); root(content, digest, input.legacy.sha256);
  files.push({ kind: "root", sha256: digest, bytes: content.length, content });
  return { contract: NATIVE_HISTORICAL_ROUTING_CONTRACT, root: { sha256: digest, bytes: content.length },
    files, providerAuthority: false, reclaimEligible: false };
}

type Cached = { value: Root | Shard | NativeHistoricalArchiveCatalog; bytes: number; kind: NativeHistoricalMetadataKind };
/** Process-local verified metadata LRU: ≤2 MiB original source bytes, ≤2 leaves,
 * ≤32 total entries. Source weight is not a peak JS heap/SLA measurement.
 * No entry can be populated by a caller-supplied verifier or mutable trust. */
export class NativeHistoricalCatalogRouter {
  private readonly entries = new Map<string, Cached>();
  private sourceBytes = 0;
  private leaves = 0;
  clearVerifiedMetadata() { this.entries.clear(); this.sourceBytes = 0; this.leaves = 0; }
  private remove(key: string) {
    const entry = this.entries.get(key); if (!entry) return;
    this.sourceBytes -= entry.bytes; if (entry.kind === "leaf") this.leaves--; this.entries.delete(key);
  }
  private async verified(reference: NativeHistoricalMetadataRead, context: string, load: Load,
    verify: (bytes: Buffer) => Cached["value"], signal?: AbortSignal) {
    if (signal?.aborted) refuse();
    const key = JSON.stringify([NATIVE_HISTORICAL_ROUTING_CONTRACT, "enabled", context, reference]);
    const hit = this.entries.get(key);
    if (hit) { this.entries.delete(key); this.entries.set(key, hit); return hit; }
    const bytes = await load(reference, signal); if (signal?.aborted) refuse();
    metadata(bytes, reference.sha256, reference.maxBytes, reference.bytes);
    const value = verify(bytes); if (signal?.aborted) refuse();
    const b = NATIVE_HISTORICAL_ROUTING_BOUNDS;
    this.remove(key); // Concurrent cold verifications cannot double-count one key.
    while (this.entries.size >= b.cacheEntries || this.sourceBytes + bytes.length > b.cacheSourceBytes ||
        reference.kind === "leaf" && this.leaves >= b.cacheLeaves) {
      const first = this.entries.keys().next().value; if (first === undefined) refuse(); this.remove(first);
    }
    const entry = { value, bytes: bytes.length, kind: reference.kind };
    this.entries.set(key, entry); this.sourceBytes += bytes.length; if (reference.kind === "leaf") this.leaves++;
    return entry;
  }
  async resolve(request: NativeHistoricalEvidenceRequest, configuration: {
    rootSha256: string; legacySha256: string; readerAssetSha256: string; directory: string;
  }, load: Load, signal?: AbortSignal) {
    try { return await this.resolveVerified(request, configuration, load, signal); }
    catch { refuse(); } // No mixed-tenant shard identities/paths in service errors.
  }
  private async resolveVerified(request: NativeHistoricalEvidenceRequest, configuration: {
    rootSha256: string; legacySha256: string; readerAssetSha256: string; directory: string;
  }, load: Load, signal?: AbortSignal) {
    const g = generation(request.generation), b = NATIVE_HISTORICAL_ROUTING_BOUNDS;
    const context = JSON.stringify([sha(configuration.rootSha256), sha(configuration.legacySha256),
      sha(configuration.readerAssetSha256), configuration.directory]);
    let budget = 0;
    const charge = (entry: Cached) => { budget += entry.bytes; if (budget > b.requestMetadataBytes) refuse(); };
    const r = await this.verified({ kind: "root", sha256: configuration.rootSha256, maxBytes: b.rootBytes }, context, load,
      bytes => root(bytes, configuration.rootSha256, configuration.legacySha256), signal);
    charge(r); const index = r.value as Root;
    if (index.legacy.jobRunIds.includes(g.jobRunId)) {
      const l = await this.verified({ kind: "legacy", sha256: index.legacy.sha256, bytes: index.legacy.bytes, maxBytes: b.legacyBytes }, context, load, bytes => {
        const catalog = openImmutableNativeHistoricalArchiveCatalog(bytes, index.legacy.sha256);
        if (legacyJobs(catalog).join("|") !== index.legacy.jobRunIds.join("|")) refuse(); return catalog;
      }, signal);
      charge(l);
      return { entry: resolveNativeHistoricalArchiveEntry(l.value as NativeHistoricalArchiveCatalog, request),
        metadataIdentity: [configuration.rootSha256, index.legacy.sha256] };
    }
    const selected = index.shards.find(s => s.bucket === nativeHistoricalGenerationBucket(g.jobRunId)); if (!selected) refuse();
    const s = await this.verified({ kind: "shard", sha256: selected.sha256, bytes: selected.bytes, maxBytes: b.shardBytes }, context, load,
      bytes => shard(bytes, selected, index.legacy.jobRunIds), signal);
    charge(s); const record = (s.value as Shard).records.find(r => r.generation.jobRunId === g.jobRunId);
    // Full requested generation and tenant checked BEFORE touching a leaf.
    if (!record || !same(record.generation, g)) refuse();
    const l = await this.verified({ kind: "leaf", ...record.leaf, maxBytes: b.leafBytes },
      JSON.stringify([context, selected.sha256, record.generation]), load,
      bytes => leaf(bytes, record.leaf.sha256, record.generation, record.leaf.bytes), signal);
    charge(l);
    return { entry: resolveNativeHistoricalArchiveEntry(l.value as NativeHistoricalArchiveCatalog, request),
      metadataIdentity: [configuration.rootSha256, selected.sha256, record.leaf.sha256] };
  }
}
