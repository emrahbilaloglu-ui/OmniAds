import { describe, expect, it } from "vitest";
import { FENCED_TABLES, type DbGrowthFenceDecision } from "../db-growth-fence";
import { assessNativeStorageMaintenanceAdmission, type NativeStorageMaintenanceEvidence } from "../native-storage-maintenance-admission";
import { deriveNativeReusableHeapAccounting } from "../native-reusable-heap";

const now = Date.parse("2026-10-05T04:05:22Z"), at = new Date(now - 5000).toISOString(), GiB = 1024 ** 3;
function fixture() {
  const business: DbGrowthFenceDecision = { allowed: false, reason: "database_budget_exceeded", warning: false,
    databaseBytes: 163 * GiB + 1145879, databaseBudgetBytes: 163 * GiB,
    tableBytes: { ...Object.fromEntries(FENCED_TABLES.map(name => [name, 0])), meta_raw_snapshots: 20 * GiB },
    tableBudgetBytes: Object.fromEntries(FENCED_TABLES.map(name => [name, 32 * GiB])),
    offender: { table: "database", bytes: 163 * GiB + 1145879, budget: 163 * GiB },
    evaluatedAt: at, errorMessage: null, overridden: false, physical: { admitted: true, reason: "ok",
      snapshotId: "actual", sampledAt: at, ageSeconds: 5, maxAgeSeconds: 300, dataPath: "/var/lib/postgresql/data",
      totalBytes: 250 * GiB, usedBytes: 200 * GiB, availableBytes: 50 * GiB, minimumFreeBytes: 40 * GiB,
      projectedFreeBytes: 50 * GiB, detail: "actual readback" } };
  const evidence: NativeStorageMaintenanceEvidence = { operation: "retire-original", observedAt: at,
    sourceManifestSha256: "a".repeat(64), actualSourceReviewSha256: "b".repeat(64), sourceMatches: true,
    exactRolesAndReaderRootMatch: true, unknownDatabaseConsumers: 0, nativeProducerIdle: true,
    originalRows: 1134, originalContexts: 4, serializedArchiveBytes: 1059313,
    appVolume: { observedAt: at, availableBytes: 10 * GiB, minimumFreeBytes: 2 * GiB },
    walVolume: { observedAt: at, availableBytes: 50 * GiB, minimumFreeBytes: 40 * GiB },
    independentOriginalRestoreMatches: true, completeOriginalCopiesMatch: true, freshHistoricalHttpMatches: true,
    selectedPinClosureMatches: true, alreadyAbsentWithEnforcedLineage: true };
  return { business, evidence, expectedDatabaseBudgetBytes: 163 * GiB, nowMs: now };
}
describe("separate native maintenance admission", () => {
  function reusableFixture() {
    const f = fixture();
    f.business.databaseAccounting = deriveNativeReusableHeapAccounting(f.business.databaseBytes!, {
      total_bytes: 67 * GiB, heap_bytes: 17 * GiB, table_len: 17 * GiB, approx_free_space: 3 * GiB,
    });
    Object.assign(f.business, { allowed: true, reason: "ready", offender: null });
    f.business.physical!.projectedFreeBytes = 50 * GiB -
      (f.business.databaseBudgetBytes - f.business.databaseAccounting.accountedDatabaseBytes);
    return f;
  }
  it("accepts the actual D170 ready shape above the raw budget without changing business admission", () => {
    const f = reusableFixture(), before = JSON.stringify(f.business);
    expect(f.business.databaseBytes).toBeGreaterThan(f.business.databaseBudgetBytes);
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(true);
    expect(JSON.stringify(f.business)).toBe(before);
  });
  it.each(["raw", "accounted", "free", "relation", "metric", "negative", "fractional"])("refuses inconsistent D170 accounting: %s", field => {
    const f = reusableFixture(), a = f.business.databaseAccounting!;
    if (field === "raw") a.rawDatabaseBytes++;
    if (field === "accounted") a.accountedDatabaseBytes--;
    if (field === "free") a.reusableHeapBytes++;
    if (field === "relation") Object.assign(a, { relation: "meta_raw_snapshots" });
    if (field === "metric") Object.assign(a, { metric: "caller_claimed_free" });
    if (field === "negative") { a.accountedDatabaseBytes = -1; a.reusableHeapBytes = a.rawDatabaseBytes + 1; }
    if (field === "fractional") { a.accountedDatabaseBytes -= 0.5; a.reusableHeapBytes += 0.5; }
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it("does not promote raw-over-budget ready without a proven accounting object", () => {
    const f = reusableFixture(); delete f.business.databaseAccounting;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it("accepts a D170 aggregate-only refusal at its accounted offender, without granting business work", () => {
    const f = reusableFixture();
    f.business.databaseBytes = 167 * GiB;
    f.business.databaseAccounting = deriveNativeReusableHeapAccounting(f.business.databaseBytes, {
      total_bytes: 67 * GiB, heap_bytes: 17 * GiB, table_len: 17 * GiB, approx_free_space: 3 * GiB,
    });
    Object.assign(f.business, { allowed: false, reason: "database_budget_exceeded",
      offender: { table: "database", bytes: 164 * GiB, budget: 163 * GiB } });
    const before = JSON.stringify(f.business), result = assessNativeStorageMaintenanceAdmission(f);
    expect(result.admitted).toBe(true); expect(result.businessAllowed).toBe(false);
    expect(JSON.stringify(f.business)).toBe(before);
    f.business.offender!.bytes = f.business.databaseBytes;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it("keeps the extra maintenance physical reserve after D170 accounting", () => {
    const f = reusableFixture(); f.business.physical!.projectedFreeBytes = 40 * GiB;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it("admits a bounded cleanup while keeping the actual over-budget business refusal byte-for-byte", () => {
    const f = fixture(), before = JSON.stringify(f.business), r = assessNativeStorageMaintenanceAdmission(f);
    expect(r.admitted).toBe(true); expect(r.businessAllowed).toBe(false);
    expect(r.businessReason).toBe("database_budget_exceeded"); expect(JSON.stringify(f.business)).toBe(before);
    expect(r.overridden).toBe(false); expect(r.sustainableStorageClosed).toBe(false);
  });
  for (const flag of ["sourceMatches", "exactRolesAndReaderRootMatch", "nativeProducerIdle",
    "independentOriginalRestoreMatches", "completeOriginalCopiesMatch", "freshHistoricalHttpMatches", "selectedPinClosureMatches"] as const) {
    it(`refuses missing ${flag}`, () => { const f = fixture(); f.evidence[flag] = false;
      expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false); });
  }
  it("does not admit business work via a caller-declared zero growth amount", () => {
    const f = fixture(); Object.assign(f.evidence, { operation: "provider-sync", growthBytes: 0 });
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it.each(["fence_read_failed", "table_budget_exceeded", "physical_free_space_low"])("keeps %s a refusal", reason => {
    const f = fixture(); f.business.reason = reason as DbGrowthFenceDecision["reason"];
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it.each([true, null])("refuses override or missing override truth (%s)", overridden => {
    const f = fixture(); f.business.overridden = overridden as boolean;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it("refuses an exceeded table even when the aggregate DB is the reported offender", () => {
    const f = fixture(); f.business.tableBytes.meta_raw_snapshots = 33 * GiB;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it.each(["database", "app", "wal"])("reserves %s space for real WAL/publication overhead", which => {
    const f = fixture(); if (which === "database") f.business.physical!.availableBytes = 40 * GiB;
    else if (which === "app") f.evidence.appVolume.availableBytes = 2 * GiB;
    else f.evidence.walVolume.availableBytes = 40 * GiB;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it.each(["business", "physical", "app", "wal"])("refuses stale %s evidence", which => {
    const f = fixture(), stale = new Date(now - 60001).toISOString();
    if (which === "business") f.business.evaluatedAt = stale;
    else if (which === "physical") f.business.physical!.sampledAt = stale;
    else if (which === "app") f.evidence.appVolume.observedAt = stale;
    else f.evidence.walVolume.observedAt = stale;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it("does not accept unexplained absence before ordinary vacuum", () => {
    const f = fixture(); f.evidence.operation = "vacuum-toast"; f.evidence.alreadyAbsentWithEnforcedLineage = false;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false);
  });
  it("read-only original capture does not claim a yet-unperformed restore", () => {
    const f = fixture(); Object.assign(f.evidence, { operation: "read-original", nativeProducerIdle: false,
      independentOriginalRestoreMatches: false, completeOriginalCopiesMatch: false, freshHistoricalHttpMatches: false });
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(true);
  });
  it("refuses budget changes even for maintenance", () => { const f = fixture(); f.expectedDatabaseBudgetBytes = 164 * GiB;
    expect(assessNativeStorageMaintenanceAdmission(f).admitted).toBe(false); });
});
