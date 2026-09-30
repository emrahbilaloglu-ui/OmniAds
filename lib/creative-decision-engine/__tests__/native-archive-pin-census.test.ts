import { describe, expect, it } from "vitest";
import { assessNativeArchivePins, NATIVE_PIN_CLASSES, readNativeArchivePinCensus,
  type NativeArchivePinCensus } from "../native-archive-pin-census";

const generation = { businessId: "00000000-0000-4000-8000-000000000001",
  jobRunId: "00000000-0000-4000-8000-000000000002", asOfDate: "2026-09-30", engineVersion: "native-fixture" };
function fixture(): NativeArchivePinCensus {
  return { contract: "bounded-native-pin-census.v1", coverage: "catalog_incoming_and_declared_non_fk",
    generation, observedAt: "2026-09-30T04:00:00Z", jobFinishedAt: "2026-09-30T03:00:00Z",
    jobRowCount: "501", evaluationCount: "501", catalogHash: "a".repeat(64), reclaimEligible: false,
    counts: NATIVE_PIN_CLASSES.map(pinClass => ({ pinClass, count: "0" })), foreignKeyReferences: [], unknownReferences: [] };
}
describe("bounded archive pin census", () => {
  it("reports age and pin-free supported scope without granting reclaim", () => {
    expect(assessNativeArchivePins(fixture(), generation)).toMatchObject({ candidateWithinSupportedScope: true,
      reason: "pin_free_supported_scope", ageSeconds: 3600, reclaimEligible: false });
  });
  it.each(NATIVE_PIN_CLASSES)("vetoes %s independently, including non-FK reverse pins", pinClass => {
    const c = fixture(); c.counts.find(p => p.pinClass === pinClass)!.count = "9007199254740993";
    expect(assessNativeArchivePins(c, generation)).toMatchObject({ candidateWithinSupportedScope: false, reason: "live_pins", pinClasses: [pinClass] });
  });
  it("unknown, missing and duplicated classes fail closed; unknown is not zero", () => {
    const c = fixture(); c.unknownReferences = ["unknown_fk:future_reader"];
    expect(assessNativeArchivePins(c, generation)).toMatchObject({ candidateWithinSupportedScope: false, reason: "unsupported_reference_inventory" });
    c.counts.pop(); expect(() => assessNativeArchivePins(c, generation)).toThrow(/incomplete pin classes/);
    const d = fixture(); d.counts[1] = d.counts[0]!;
    expect(() => assessNativeArchivePins(d, generation)).toThrow(/incomplete pin classes/);
  });
  it("measured unclassified ZERO FK permits the bounded scope, but a live edge vetoes even if its note is missing", () => {
    const c = fixture(); c.foreignKeyReferences = [{ childSchema: "public", childTable: "calibration_daily",
      constraint: "calibration_job_fk", parentSchema: "public", parentTable: "engine_v3_job_runs", pinClass: null, count: "0" }];
    expect(assessNativeArchivePins(c, generation).candidateWithinSupportedScope).toBe(true);
    c.foreignKeyReferences[0]!.count = "1";
    expect(assessNativeArchivePins(c, generation)).toMatchObject({ candidateWithinSupportedScope: false,
      reason: "unsupported_reference_inventory", reclaimEligible: false });
  });
  it("rejects a missing, duplicate or under-counted catalog edge inventory", () => {
    const c = fixture(); c.foreignKeyReferences = [{ childSchema: "public", childTable: "daily",
      constraint: "daily_fk", parentSchema: "public", parentTable: "engine_v3_job_runs", pinClass: "snapshots", count: "1" }];
    expect(() => assessNativeArchivePins(c, generation)).toThrow(/FK\/class count mismatch/);
    c.counts[0]!.count = "1"; c.foreignKeyReferences.push(c.foreignKeyReferences[0]!);
    expect(() => assessNativeArchivePins(c, generation)).toThrow(/duplicate FK/);
    c.foreignKeyReferences = undefined as never;
    expect(() => assessNativeArchivePins(c, generation)).toThrow(/inventory absent/);
  });
  it("rejects foreign identity, future clock, negative counts or lost evaluation rows", () => {
    for (const change of ["foreign", "clock", "negative", "count"]) {
      const c = fixture();
      if (change === "foreign") c.generation = { ...generation, businessId: generation.jobRunId };
      else if (change === "clock") c.jobFinishedAt = "2026-09-30T05:00:00Z";
      else if (change === "negative") c.counts[0]!.count = "-1";
      else c.evaluationCount = "500";
      expect(() => assessNativeArchivePins(c, generation)).toThrow(/refused/);
    }
  });
  it.each([0, 8000, 9000])("rejects timeout %d instead of issuing unbounded data reads", async timeout_ms => {
    const calls: string[] = [];
    const db = { query: async (sql: string) => { calls.push(sql); return { rows: [{ readonly: "on", isolation: "repeatable read", timeout_ms }] }; } };
    await expect(readNativeArchivePinCensus(db, { schema: "public", generation, unmodeledReferences: [] })).rejects.toThrow(/timeout required/);
    expect(calls).toHaveLength(1);
  });
  it("refuses a writeable snapshot and an injected identifier before any generation read", async () => {
    const db = { query: async () => ({ rows: [{ readonly: "off", isolation: "repeatable read", timeout_ms: 7500 }] }) };
    await expect(readNativeArchivePinCensus(db, { schema: "public", generation, unmodeledReferences: [] })).rejects.toThrow(/read-only/);
    await expect(readNativeArchivePinCensus(db, { schema: 'public;DROP TABLE jobs', generation, unmodeledReferences: [] })).rejects.toThrow(/identifier/);
  });
});
