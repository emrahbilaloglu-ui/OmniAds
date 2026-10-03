import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { NATIVE_HISTORICAL_COMPRESSED_ENCODING, NATIVE_HISTORICAL_MAX_DECODED_BYTES,
  type NativeHistoricalArchiveCatalogEntry, type NativeHistoricalEvidence,
  type NativeHistoricalEvidenceRequest } from "@/lib/creative-decision-engine/native-historical-archive";

export const NATIVE_HISTORICAL_READ_BOUNDS = Object.freeze({
  maxPlaintextBytes: 2 * 1024 * 1024, maxResponseBytes: 256 * 1024,
  maxCompressedDecodedBytes: NATIVE_HISTORICAL_MAX_DECODED_BYTES,
  ciphertextCacheBytes: 8 * 1024 * 1024, evidenceCacheBytes: 4 * 1024 * 1024,
  cacheEntries: 32, cacheTtlMs: 300_000, deadlineMs: 10_000,
  activeRequests: 8, businessRequests: 2, activeValidations: 2, businessValidations: 1,
  budgetWindowMs: 900_000, budgetBusinesses: 256, windowRequests: 512,
  businessWindowRequests: 64, windowDownloadBytes: 128 * 1024 * 1024,
  businessWindowDownloadBytes: 32 * 1024 * 1024,
  windowResponseBytes: 32 * 1024 * 1024, businessWindowResponseBytes: 8 * 1024 * 1024,
});
export class NativeHistoricalReadLimit extends Error {
  constructor() { super("native_historical_reader_limit_reached"); }
}
export class NativeHistoricalObjectBound extends Error {
  constructor() { super("native_historical_object_outside_pilot_bound"); }
}
/** Preserve the v1 pilot cap. Only explicit authenticated gzip v2 may expand to
 * eight MiB; its stored/download/cached ciphertext has the same two-MiB bound. */
export function assertNativeHistoricalRuntimeObjectBound(entry: NativeHistoricalArchiveCatalogEntry) {
  const b = NATIVE_HISTORICAL_READ_BOUNDS;
  if (entry.encoding !== undefined && entry.encoding !== NATIVE_HISTORICAL_COMPRESSED_ENCODING)
    throw new NativeHistoricalObjectBound();
  const limit = entry.encoding === NATIVE_HISTORICAL_COMPRESSED_ENCODING ? b.maxCompressedDecodedBytes : b.maxPlaintextBytes;
  if (!Number.isSafeInteger(entry.plaintextBytes) || entry.plaintextBytes <= 0 || entry.plaintextBytes > limit ||
      !Number.isSafeInteger(entry.ciphertextBytes) || entry.ciphertextBytes <= 0 || entry.ciphertextBytes > b.maxPlaintextBytes + 128 ||
      entry.encoding === NATIVE_HISTORICAL_COMPRESSED_ENCODING && (!Number.isSafeInteger(entry.payloadBytes) ||
        entry.payloadBytes <= 0 || entry.payloadBytes > b.maxPlaintextBytes || !/^[a-f0-9]{64}$/.test(entry.payloadSha256)))
    throw new NativeHistoricalObjectBound();
}
type Event = "cache_hit" | "verified" | "refused";
type Budget = { requests: number; download: number; response: number };
type Work = {
  download(entry: NativeHistoricalArchiveCatalogEntry, signal: AbortSignal): Promise<Buffer>;
  validate(bytes: Buffer, entry: NativeHistoricalArchiveCatalogEntry,
    request: NativeHistoricalEvidenceRequest, signal: AbortSignal): Promise<NativeHistoricalEvidence>;
};
class BoundedCache<T> {
  private entries = new Map<string, { value: T; weight: number; expires: number }>();
  private bytes = 0;
  constructor(private readonly limit: number, private readonly now: () => number) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) { this.remove(key); return; }
    this.entries.delete(key); this.entries.set(key, entry); return entry.value;
  }
  put(key: string, value: T, weight: number) {
    if (!Number.isSafeInteger(weight) || weight <= 0 || weight > this.limit) return;
    this.remove(key);
    while (this.entries.size >= NATIVE_HISTORICAL_READ_BOUNDS.cacheEntries || this.bytes + weight > this.limit) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break; this.remove(first);
    }
    this.entries.set(key, { value, weight, expires: this.now() + NATIVE_HISTORICAL_READ_BOUNDS.cacheTtlMs });
    this.bytes += weight;
  }
  private remove(key: string) {
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.weight; this.entries.delete(key); }
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function verifyResponse(value: NativeHistoricalEvidence, request: NativeHistoricalEvidenceRequest) {
  if (value.status !== "historical_available" || value.authority !== "historical_read_only" ||
      value.providerAuthority !== false || value.currentDecisionEligible !== false || value.reclaimEligible !== false ||
      value.generation.businessId !== request.generation.businessId || value.generation.jobRunId !== request.generation.jobRunId ||
      value.generation.asOfDate !== request.generation.asOfDate || value.generation.engineVersion !== request.generation.engineVersion ||
      value.identity.providerAccountId !== request.providerAccountId || value.identity.adId !== request.adId ||
      value.identity.evaluationId !== request.evaluationId) throw new Error("historical result identity refused");
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > NATIVE_HISTORICAL_READ_BOUNDS.maxResponseBytes) throw new NativeHistoricalObjectBound();
  return bytes;
}

/** Process-local bounds, no queue. Distributed/host totals are not inferred.
 * Only independently verified ciphertext and complete original-row evidence are cached.
 * The caller must authorize business/role before entering this service. */
export class NativeHistoricalReadControls {
  private readonly cipher: BoundedCache<Buffer>;
  private readonly evidence: BoundedCache<NativeHistoricalEvidence>;
  private readonly flights = new Map<string, Promise<NativeHistoricalEvidence>>();
  private readonly requestsByBusiness = new Map<string, number>();
  private readonly validationsByBusiness = new Map<string, number>();
  private requests = 0; private validations = 0;
  private windowStart: number;
  private total: Budget = { requests: 0, download: 0, response: 0 };
  private businesses = new Map<string, Budget>();
  constructor(private readonly now = () => performance.now(),
    private readonly log: (event: Event, fields: { durationMs: number; bytes: number }) => void = () => {}) {
    this.cipher = new BoundedCache(NATIVE_HISTORICAL_READ_BOUNDS.ciphertextCacheBytes, now);
    this.evidence = new BoundedCache(NATIVE_HISTORICAL_READ_BOUNDS.evidenceCacheBytes, now);
    this.windowStart = now();
  }
  clearVerifiedCache() { this.cipher.clear(); this.evidence.clear(); }
  private budget(business: string) {
    if (this.now() - this.windowStart >= NATIVE_HISTORICAL_READ_BOUNDS.budgetWindowMs) {
      this.windowStart = this.now(); this.total = { requests: 0, download: 0, response: 0 }; this.businesses.clear();
    }
    let value = this.businesses.get(business);
    if (!value) {
      if (this.businesses.size >= NATIVE_HISTORICAL_READ_BOUNDS.budgetBusinesses) throw new NativeHistoricalReadLimit();
      value = { requests: 0, download: 0, response: 0 }; this.businesses.set(business, value);
    }
    return value;
  }
  private charge(business: string, dimension: keyof Budget, bytes: number) {
    const value = this.budget(business), b = NATIVE_HISTORICAL_READ_BOUNDS;
    const limits = dimension === "requests" ? [b.windowRequests, b.businessWindowRequests] :
      dimension === "download" ? [b.windowDownloadBytes, b.businessWindowDownloadBytes] :
        [b.windowResponseBytes, b.businessWindowResponseBytes];
    if (this.total[dimension] + bytes > limits[0]! || value[dimension] + bytes > limits[1]!) throw new NativeHistoricalReadLimit();
    this.total[dimension] += bytes; value[dimension] += bytes;
  }
  async read(request: NativeHistoricalEvidenceRequest, prepare: () => Promise<{
    configurationFingerprint: string; entry: NativeHistoricalArchiveCatalogEntry; work: Work;
  }>): Promise<NativeHistoricalEvidence> {
    const b = NATIVE_HISTORICAL_READ_BOUNDS, business = request.generation.businessId, started = this.now();
    // Admission happens before catalog/key/packaged-worker loading, not just before GET.
    this.charge(business, "requests", 1);
    if (this.requests >= b.activeRequests || (this.requestsByBusiness.get(business) ?? 0) >= b.businessRequests)
      throw new NativeHistoricalReadLimit();
    this.requests++; this.requestsByBusiness.set(business, (this.requestsByBusiness.get(business) ?? 0) + 1);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new NativeHistoricalReadLimit()); }, b.deadlineMs);
    });
    const run = async () => {
      const { configurationFingerprint, entry, work } = await prepare();
      if (controller.signal.aborted) throw new NativeHistoricalReadLimit();
      if (!/^[a-f0-9]{64}$/.test(configurationFingerprint) ||
          entry.generation.businessId !== request.generation.businessId || entry.generation.jobRunId !== request.generation.jobRunId ||
          entry.generation.asOfDate !== request.generation.asOfDate || entry.generation.engineVersion !== request.generation.engineVersion)
        throw new Error("historical trust identity refused");
      assertNativeHistoricalRuntimeObjectBound(entry);
      const objectKey = fingerprint([configurationFingerprint, entry]);
      const resultKey = fingerprint([objectKey, request]);
      const cached = this.evidence.get(resultKey);
      if (cached) {
        const bytes = verifyResponse(cached, request); this.charge(business, "response", bytes);
        this.log("cache_hit", { durationMs: this.now() - started, bytes }); return structuredClone(cached);
      }
      let flight = this.flights.get(resultKey);
      if (!flight) {
        if (this.validations >= b.activeValidations || (this.validationsByBusiness.get(business) ?? 0) >= b.businessValidations)
          throw new NativeHistoricalReadLimit();
        this.validations++; this.validationsByBusiness.set(business, (this.validationsByBusiness.get(business) ?? 0) + 1);
        const task = async () => {
          let bytes = this.cipher.get(objectKey);
          if (!bytes) {
            // Reserve before network I/O: even failed transfers consume the pilot budget.
            this.charge(business, "download", entry.ciphertextBytes);
            bytes = await work.download(entry, controller.signal);
          }
          if (controller.signal.aborted) throw new NativeHistoricalReadLimit();
          if (bytes.length !== entry.ciphertextBytes || createHash("sha256").update(bytes).digest("hex") !== entry.ciphertextSha256)
            throw new Error("historical ciphertext refused");
          const verified = await work.validate(bytes, entry, request, controller.signal);
          if (controller.signal.aborted) throw new NativeHistoricalReadLimit();
          const weight = verifyResponse(verified, request);
          this.cipher.put(objectKey, Buffer.from(bytes), bytes.length);
          this.evidence.put(resultKey, structuredClone(verified), weight);
          this.log("verified", { durationMs: this.now() - started, bytes: bytes.length }); return verified;
        };
        flight = Promise.race([task(), deadline]).finally(() => {
          controller.abort(); this.validations--;
          const count = (this.validationsByBusiness.get(business) ?? 1) - 1;
          if (count) this.validationsByBusiness.set(business, count); else this.validationsByBusiness.delete(business);
          this.flights.delete(resultKey);
        });
        this.flights.set(resultKey, flight);
      }
      const value = await flight; this.charge(business, "response", verifyResponse(value, request)); return structuredClone(value);
    };
    try { return await Promise.race([run(), deadline]); }
    catch (error) { this.log("refused", { durationMs: this.now() - started, bytes: 0 }); throw error; }
    finally {
      if (timer) clearTimeout(timer); controller.abort();
      this.requests--; const count = (this.requestsByBusiness.get(business) ?? 1) - 1;
      if (count) this.requestsByBusiness.set(business, count); else this.requestsByBusiness.delete(business);
    }
  }
}
