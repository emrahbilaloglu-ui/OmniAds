import { describe, expect, it } from "vitest";
import type { DbGrowthFenceDecision } from "./db-growth-fence";
import { describeDbGrowthFenceCapacity } from "./db-growth-capacity-report";

const sample: DbGrowthFenceDecision = {
  allowed: true, reason: "ready", warning: true,
  databaseBytes: 165_186_116_631, databaseBudgetBytes: 171_798_691_840,
  tableBytes: { meta_raw_snapshots: 80 },
  tableBudgetBytes: { meta_raw_snapshots: 100 },
  offender: null, evaluatedAt: "2026-09-26T21:13:02Z",
  errorMessage: null, overridden: false, physical: null,
};

describe("effective sync-capacity reporting", () => {
  it("uses evaluation budgets and reports signed headroom without forecasting", () => {
    const result = describeDbGrowthFenceCapacity(sample);
    expect(result.database.remainingBytes).toBe(6_612_575_209);
    expect(result.tables.find((row) => row.table === "meta_raw_snapshots"))
      .toMatchObject({ remainingBytes: 20, utilization: 0.8, budgetBytes: 100 });
    expect(result).not.toHaveProperty("exhaustionAt");
    expect(describeDbGrowthFenceCapacity({ ...sample, databaseBudgetBytes: 100 })
      .database.remainingBytes).toBe(100 - sample.databaseBytes!);
  });

  it("does not turn a failed measurement or absent effective budget into zero or a default", () => {
    const result = describeDbGrowthFenceCapacity({
      ...sample, allowed: false, reason: "fence_read_failed",
      databaseBytes: null, tableBytes: {}, tableBudgetBytes: undefined,
    });
    expect(result.database.remainingBytes).toBeNull();
    expect(result.tables.every((row) => row.remainingBytes === null)).toBe(true);
    expect(result.allowed).toBe(false);
    expect(describeDbGrowthFenceCapacity({
      ...sample, reason: "measurement_invalid",
    }).database.budgetBytes).toBeNull();
  });

  it("reports an applied override without exposing the operator's reason or implying free space", () => {
    const result = describeDbGrowthFenceCapacity({
      ...sample, overridden: true, reason: "database_budget_exceeded",
      databaseBytes: sample.databaseBudgetBytes + 1,
    });
    expect(result.overrideApplied).toBe(true);
    expect(result.database.remainingBytes).toBe(-1);
    expect(result.physical).toBeNull();
  });
});
