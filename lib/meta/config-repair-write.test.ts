import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const query = vi.fn();
vi.mock("@/lib/db", () => ({
  getDb: () => ({ query }),
  runDbTransaction: (fn: () => Promise<unknown>) => fn(),
}));

import {
  applyMetaConfigRepairChanges,
  verifyPreviouslyAppliedMetaConfigRepair,
} from "@/lib/meta/config-repair-write";

const objectiveChange = {
  scope: "campaign_daily" as const,
  businessId: "biz-1", providerAccountId: "act_1", date: "2026-07-25",
  accountTimezone: "Europe/Istanbul",
  entityId: "cmp-1", field: "objective", oldValue: null,
  newValue: "OUTCOME_SALES",
  source: {
    kind: "meta_raw_snapshots" as const,
    id: "raw-1",
    sourceSnapshotId: "raw-1",
    corroboratingSourceSnapshotId: "raw-2",
    corroboratingObservedAt: "2026-07-26T10:00:00Z",
  },
};

function auditFor(changes: unknown[]) {
  return {
    manifestHash: createHash("sha256")
      .update(JSON.stringify(changes)).digest("hex"),
    businessId: "biz-1",
    startDate: "2026-07-25",
    endDate: "2026-07-25",
  };
}

beforeEach(() => query.mockReset());

describe("config repair write", () => {
  it("updates only allowlisted config columns with exact preimage", async () => {
    query.mockResolvedValue([{ id: "row-1" }]);
    const changes = [objectiveChange];
    expect(await applyMetaConfigRepairChanges(changes, auditFor(changes)))
      .toEqual({ rowsUpdated: 1 });
    const [statement, values] = query.mock.calls[0]!;
    expect(statement).toContain("UPDATE meta_campaign_daily SET objective = $6");
    expect(statement).toContain("objective IS NOT DISTINCT FROM $7");
    expect(statement).toContain("account_timezone = $5");
    expect(statement).not.toContain("updated_at = now()");
    expect(statement).not.toMatch(/\bspend\s*=|\bconversions\s*=|\brevenue\s*=/);
    expect(statement).not.toContain("DELETE");
    expect(values).toEqual(["biz-1", "act_1", "2026-07-25", "cmp-1",
      "Europe/Istanbul",
      "OUTCOME_SALES", null]);
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO meta_config_repair_audits");
  });

  it("refuses a derived label that has no independent stored column", async () => {
    const changes = [{
      ...objectiveChange, field: "bidStrategyLabel", newValue: "Lowest Cost",
    }];
    await expect(applyMetaConfigRepairChanges(changes, auditFor(changes)))
      .rejects.toThrow("meta_config_repair_field_not_allowlisted:bidStrategyLabel");
  });

  it("refuses a changed row instead of overwriting concurrent work", async () => {
    query.mockResolvedValue([]);
    await expect(applyMetaConfigRepairChanges(
      [objectiveChange], auditFor([objectiveChange])))
      .rejects.toThrow("meta_config_repair_preimage_changed");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps JSONB preimage checks on adset promoted objects", async () => {
    query.mockResolvedValue([{ id: "row-1" }]);
    const changes = [{
      ...objectiveChange, scope: "adset_daily" as const, entityId: "adset-1",
      field: "promotedObjectJson", oldValue: null,
      newValue: { pixel_id: "p1", custom_event_type: "PURCHASE" },
    }];
    await applyMetaConfigRepairChanges(changes, auditFor(changes));
    const [statement, values] = query.mock.calls[0]!;
    expect(statement).toContain("promoted_object_json = $6::jsonb");
    expect(statement).toContain("promoted_object_json IS NOT DISTINCT FROM $7::jsonb");
    expect(values[5]).toBe('{"pixel_id":"p1","custom_event_type":"PURCHASE"}');
  });

  it("accepts a repeated reviewed manifest only when its postimage is intact", async () => {
    query.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ changes_json: [objectiveChange] }])
      .mockResolvedValueOnce([{ id: "row-1" }]);
    expect(await verifyPreviouslyAppliedMetaConfigRepair(auditFor([objectiveChange])))
      .toEqual({ rowsUpdated: 0, alreadyApplied: true });
    expect(String(query.mock.calls[2]?.[0])).toContain("objective IS NOT DISTINCT FROM $6");
    expect(String(query.mock.calls[2]?.[0])).not.toContain("UPDATE");
  });

  it("rejects a replay when the previously repaired value has changed", async () => {
    query.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ changes_json: [objectiveChange] }])
      .mockResolvedValueOnce([]);
    await expect(verifyPreviouslyAppliedMetaConfigRepair(auditFor([objectiveChange])))
      .rejects.toThrow("meta_config_repair_applied_state_changed");
  });
});
