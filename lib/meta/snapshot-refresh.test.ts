import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbGrowthFenceDecision } from "@/lib/sync/db-growth-fence";

const mocks = vi.hoisted(() => ({ run: vi.fn(), admission: vi.fn(), assignments: vi.fn() }));
vi.mock("@/lib/meta/snapshot", () => ({ runMetaSnapshotForBusiness: mocks.run }));
vi.mock("@/lib/provider-account-assignments", () => ({ getProviderAccountAssignments: mocks.assignments }));
vi.mock("@/lib/sync/db-growth-fence", async (original) => ({
  ...await original<typeof import("@/lib/sync/db-growth-fence")>(), assertDbGrowthFenceAdmits: mocks.admission,
}));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.run.mockResolvedValue({ recommendationsWritten: 1 });
  mocks.assignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
  mocks.admission.mockResolvedValue({ allowed: true });
});
const input = { businessId: "biz_1", providerAccountId: "act_1", snapshotDate: "2026-10-08", reason: "manual" as const };

describe("manual decision refresh admission before side effects", () => {
  it("refuses capacity even with force; refusal creates no cooldown", async () => {
    const { DbGrowthFenceRefusal } = await import("@/lib/sync/db-growth-fence");
    const { requestMetaSnapshotRefreshForBusiness: refresh } = await import("./snapshot-refresh");
    mocks.admission.mockRejectedValueOnce(new DbGrowthFenceRefusal({ allowed: false,
      reason: "database_budget_exceeded", evaluatedAt: "2026-10-08T06:00:00Z", offender: null } as DbGrowthFenceDecision));
    expect(await refresh({ ...input, force: true })).toMatchObject({ ok: false, status: "blocked",
      blockedReason: "database_budget_exceeded", cooldownUntil: null, admission: { allowed: false } });
    expect(mocks.run).not.toHaveBeenCalled();
    // An admitted retry runs immediately: the denial did not stamp cooldown.
    expect(await refresh(input)).toMatchObject({ ok: true, status: "ran" });
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledWith("biz_1", "2026-10-08", "act_1");
  });
  it("unreadable admission is a typed refusal without exposing internal errors", async () => {
    const { requestMetaSnapshotRefreshForBusiness: refresh } = await import("./snapshot-refresh");
    mocks.admission.mockRejectedValue(new Error("internal connection detail"));
    const result = await refresh(input);
    expect(result).toMatchObject({ ok: false, status: "blocked", blockedReason: "fence_read_failed", cooldownUntil: null });
    expect(result.message).not.toContain("internal connection");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("refuses stale/foreign selected scope before calibration or cooldown", async () => {
    const { requestMetaSnapshotRefreshForBusiness: refresh } = await import("./snapshot-refresh");
    expect(await refresh({ ...input, providerAccountId: "act_foreign" })).toMatchObject({ status: "blocked", blockedReason: "provider_account_not_assigned" });
    expect(mocks.admission).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.assignments.mockRejectedValueOnce(new Error("unavailable"));
    expect(await refresh(input)).toMatchObject({ status: "blocked", blockedReason: "account_scope_unavailable" });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("rechecks admission before returning cooldown and keeps accounts independent", async () => {
    const { requestMetaSnapshotRefreshForBusiness: refresh } = await import("./snapshot-refresh");
    expect(await refresh(input)).toMatchObject({ status: "ran" });
    expect(await refresh(input)).toMatchObject({ status: "cooldown" });
    mocks.admission.mockRejectedValueOnce(new Error("unknown"));
    expect(await refresh(input)).toMatchObject({ status: "blocked", ok: false });
    expect(await refresh({ ...input, providerAccountId: "act_2" })).toMatchObject({ status: "ran" });
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
});
