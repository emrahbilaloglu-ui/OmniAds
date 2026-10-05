import { describe, expect, it } from "vitest";
import { FENCED_TABLES, type DbGrowthFenceDecision } from "../../../lib/sync/db-growth-fence";
import { assessNativeStorageMaintenanceAdmission, type NativeStorageMaintenanceEvidence } from "../../../lib/sync/native-storage-maintenance-admission";
import { settleAppSampleClock } from "../production-transport";

// Exact relative clock lead and app free bytes from the 2026-10-05 READ ONLY
// production refusal. Test clocks advance through waiting, never by rewriting
// any business/sample/decision timestamp.
const NOW = Date.parse("2026-10-05T14:52:31.638Z"), GiB = 1024 ** 3;
function fixture(lead: number | string = 19) {
  const at = new Date(NOW - 5000).toISOString();
  const business: DbGrowthFenceDecision = { allowed: false, reason: "database_budget_exceeded", warning: false,
    databaseBytes: 175034121239, databaseBudgetBytes: 175019917312,
    tableBytes: Object.fromEntries(FENCED_TABLES.map(n => [n, 0])),
    tableBudgetBytes: Object.fromEntries(FENCED_TABLES.map(n => [n, 32 * GiB])),
    offender: { table: "database", bytes: 175034121239, budget: 175019917312 },
    evaluatedAt: at, errorMessage: null, overridden: false,
    physical: { admitted: true, reason: "ok", snapshotId: "12226", sampledAt: at, ageSeconds: 5,
      maxAgeSeconds: 2100, dataPath: "/var/lib/postgresql", totalBytes: 221348159488,
      usedBytes: 169261273088, availableBytes: 50974896128, minimumFreeBytes: 40 * GiB,
      projectedFreeBytes: 50974896128, detail: "read-only production witness" } };
  const evidence: NativeStorageMaintenanceEvidence = { operation: "read-original", observedAt: at,
    sourceManifestSha256: "a".repeat(64), actualSourceReviewSha256: "b".repeat(64), sourceMatches: true,
    exactRolesAndReaderRootMatch: true, unknownDatabaseConsumers: 0, nativeProducerIdle: true,
    originalRows: 702, originalContexts: 2, serializedArchiveBytes: 0,
    appVolume: { observedAt: typeof lead === "string" ? lead : new Date(NOW + lead).toISOString(),
      availableBytes: 94327660544, minimumFreeBytes: 2 * GiB },
    walVolume: { observedAt: at, availableBytes: 50974896128, minimumFreeBytes: 2 * GiB },
    independentOriginalRestoreMatches: false, completeOriginalCopiesMatch: false,
    freshHistoricalHttpMatches: false, selectedPinClosureMatches: false, alreadyAbsentWithEnforcedLineage: false };
  let now = NOW;
  const before = JSON.stringify({ business, evidence });
  const assess = () => assessNativeStorageMaintenanceAdmission({ business, evidence,
    expectedDatabaseBudgetBytes: 175019917312, nowMs: now });
  const settle = () => settleAppSampleClock(evidence.appVolume.observedAt, {
    now: () => now, sleep: async ms => { now += ms; },
  });
  return { business, evidence, before, assess, settle, now: () => now };
}

describe("bounded app capacity sample clock settlement", () => {
  it("waits out the real 19ms lead while preserving the complete measured input and business refusal", async () => {
    const f = fixture();
    expect(f.assess().issues).toEqual(["app_physical_reserve"]);
    await f.settle();
    expect(f.assess().admitted).toBe(true);
    expect(f.assess().businessAllowed).toBe(false); expect(f.assess().overridden).toBe(false);
    expect(JSON.stringify({ business: f.business, evidence: f.evidence })).toBe(f.before);
    expect(f.now() - NOW).toBeLessThanOrEqual(1000);
  });
  it.each([1, 999, 1000])("handles a bounded %dms lead without broadening the assessor", async lead => {
    const f = fixture(lead); expect(f.assess().admitted).toBe(false);
    await f.settle(); expect(f.assess().admitted).toBe(true);
    expect(f.now() - NOW).toBeLessThanOrEqual(1000);
    expect(JSON.stringify({ business: f.business, evidence: f.evidence })).toBe(f.before);
  });
  it.each([1001, 60001, "invalid", -60001])("keeps unbounded/invalid/stale sample %s refused", async lead => {
    const f = fixture(lead); await f.settle(); expect(f.now()).toBe(NOW);
    expect(f.assess().admitted).toBe(false);
  });
  it.each([0, -5000])("does not wait for an already non-future sample %d", async lead => {
    const f = fixture(lead); await f.settle(); expect(f.now()).toBe(NOW);
    expect(f.assess().admitted).toBe(true);
  });
  it("does not fabricate a clock advance when the wait completes without the clock catching up", async () => {
    const f = fixture();
    await settleAppSampleClock(f.evidence.appVolume.observedAt, { now: () => NOW, sleep: async () => {} });
    expect(f.assess().admitted).toBe(false);
    expect(JSON.stringify({ business: f.business, evidence: f.evidence })).toBe(f.before);
  });
  it("still refuses a genuinely low physical reserve", async () => {
    const f = fixture(); f.evidence.appVolume.availableBytes = 2 * GiB;
    await f.settle(); expect(f.assess().issues).toContain("app_physical_reserve");
  });
  it("does not admit a provider operation after settlement", async () => {
    const f = fixture(); Object.assign(f.evidence, { operation: "provider-sync" });
    await f.settle(); expect(f.assess().admitted).toBe(false);
  });
});
