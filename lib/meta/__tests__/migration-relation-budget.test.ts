import { describe, expect, it } from "vitest";
import { assertMetaHistoryIndexBudgetMeasurement, META_HISTORY_SCHEMA_MAINTENANCE_CONTRACT } from "@/lib/migrations";
import { DEFAULT_TABLE_BUDGET_BYTES } from "@/lib/sync/db-growth-fence";

describe("migration preserves the measured state-history relation budget", () => {
  const budget = DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history;
  it("accepts headroom before and after the new index is included", () => {
    expect(() => assertMetaHistoryIndexBudgetMeasurement(String(budget - 8192), "before_build")).not.toThrow();
    expect(() => assertMetaHistoryIndexBudgetMeasurement(budget - 1, "after_build")).not.toThrow();
    for (const value of [0, "0", 1, "1", "0001"]) {
      expect(assertMetaHistoryIndexBudgetMeasurement(value, "before_build")).toBe(false);
    }
  });
  it("refuses the actual over-budget live baseline before attempting growth", () => {
    expect(() => assertMetaHistoryIndexBudgetMeasurement("6443089920", "before_build"))
      .toThrow("migration_relation_budget_refused:before_build");
  });
  it("allows a validated existing index to be rechecked above budget without a maintenance flag", () => {
    expect(assertMetaHistoryIndexBudgetMeasurement("7043089920", "before_build", undefined, false)).toBe(false);
    expect(assertMetaHistoryIndexBudgetMeasurement("7043089920", "after_build", undefined, false)).toBe(false);
    expect(() => assertMetaHistoryIndexBudgetMeasurement(undefined, "before_build", undefined, false)).toThrow();
  });
  it("refuses when the completed index consumes the remaining margin", () => {
    expect(() => assertMetaHistoryIndexBudgetMeasurement(budget, "after_build"))
      .toThrow("INCLUDING idx_meta_entity_state_history_manifest_delta");
  });
  it("admits the actual baseline only for explicit maintenance while SOURCE is still fenced", () => {
    const maintenance = {
      requestedContract: META_HISTORY_SCHEMA_MAINTENANCE_CONTRACT,
      sourceFenceClosed: true, freshPhysicalCapacity: true, admittedBeforeBuild: false,
    };
    expect(assertMetaHistoryIndexBudgetMeasurement("6443089920", "before_build", maintenance)).toBe(true);
    expect(assertMetaHistoryIndexBudgetMeasurement("7043089920", "after_build", { ...maintenance, admittedBeforeBuild: true })).toBe(true);
    for (const refused of [
      { ...maintenance, requestedContract: "enabled" },
      { ...maintenance, sourceFenceClosed: false },
      { ...maintenance, freshPhysicalCapacity: false },
    ]) expect(() => assertMetaHistoryIndexBudgetMeasurement("6443089920", "before_build", refused)).toThrow();
    expect(() => assertMetaHistoryIndexBudgetMeasurement("6443089920", "after_build", maintenance)).toThrow();
    expect(DEFAULT_TABLE_BUDGET_BYTES.meta_entity_state_history).toBe(6 * 1024 ** 3);
  });
  it.each([
    { name: "undefined", value: undefined },
    { name: "null", value: null },
    { name: "empty string", value: "" },
    { name: "unavailable string", value: "unavailable" },
    { name: "negative number", value: -1 },
    { name: "NaN", value: Number.NaN },
    { name: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
    { name: "false", value: false },
    { name: "true", value: true },
    { name: "empty array", value: [] },
    { name: "singleton array", value: [1] },
    { name: "object", value: {} },
    { name: "coercible object", value: { valueOf: () => 1 } },
    { name: "boxed number", value: Object(0) },
    { name: "bigint value", value: BigInt(0) },
    { name: "leading whitespace", value: " 1" },
    { name: "trailing whitespace", value: "1 " },
    { name: "positive sign", value: "+1" },
    { name: "negative string", value: "-1" },
    { name: "decimal string", value: "1.0" },
    { name: "exponent string", value: "1e3" },
    { name: "hexadecimal string", value: "0x10" },
    { name: "unsafe bigint string", value: "9007199254740992" },
    { name: "fractional number", value: 0.5 },
    { name: "infinity", value: Number.POSITIVE_INFINITY },
  ])("refuses $name even for maintenance or a no-growth rerun", ({ value }) => {
    expect(() => assertMetaHistoryIndexBudgetMeasurement(value, "before_build")).toThrow("migration_relation_budget_refused");
    expect(() => assertMetaHistoryIndexBudgetMeasurement(value, "after_build", undefined, false)).toThrow("migration_relation_budget_refused");
    expect(() => assertMetaHistoryIndexBudgetMeasurement(value, "after_build", {
      requestedContract: META_HISTORY_SCHEMA_MAINTENANCE_CONTRACT,
      sourceFenceClosed: true, freshPhysicalCapacity: true, admittedBeforeBuild: true,
    })).toThrow("migration_relation_budget_refused");
  });
});
