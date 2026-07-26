import { describe, expect, it } from "vitest";

import { DbGrowthFenceRefusal } from "@/lib/sync/db-growth-fence";
import { SyncLaneDisabledError } from "@/lib/sync/global-kill-switch";
import {
  describeLaneOutcome,
  describeSyncSafetyRefusal,
} from "@/lib/sync/safety-refusal";

const DECISION = {
  allowed: false as const,
  reason: "database_budget_exceeded" as const,
  warning: false,
  databaseBytes: 2,
  databaseBudgetBytes: 1,
  tableBytes: {},
  offender: { table: "database" as const, bytes: 2, budget: 1 },
  evaluatedAt: "2026-07-26T00:00:00.000Z",
  errorMessage: null,
  overridden: false,
  physical: null,
};

describe("describeSyncSafetyRefusal", () => {
  it("recognises a capacity refusal", () => {
    const refusal = describeSyncSafetyRefusal(
      new DbGrowthFenceRefusal(DECISION, "meta_process_partition"),
    );
    expect(refusal?.kind).toBe("capacity_refused");
    expect(refusal?.scope).toBe("meta_process_partition");
  });

  it("recognises a disabled lane", () => {
    const refusal = describeSyncSafetyRefusal(
      new SyncLaneDisabledError({
        lane: "shopify_sync",
        enabled: false,
        reason: "global_switch_off",
      }),
    );
    expect(refusal?.kind).toBe("lane_disabled");
    expect(refusal?.scope).toBe("shopify_sync");
  });

  it("recognises authority uncertainty reported as a result", () => {
    // Unknown authority is a returned stop reason, not a throw, so it would
    // never be seen by an error-only classifier.
    expect(
      describeSyncSafetyRefusal({ failureClass: "meta_account_authority_unknown" })
        ?.kind,
    ).toBe("authority_unknown");
    expect(
      describeSyncSafetyRefusal({ stopReason: "meta_account_authority_unknown" })
        ?.kind,
    ).toBe("authority_unknown");
  });

  it("does not classify an ordinary provider failure as a safety refusal", () => {
    expect(describeSyncSafetyRefusal(new Error("Graph API 500"))).toBeNull();
    expect(describeSyncSafetyRefusal({ error: "some string" })).toBeNull();
  });

  it("survives the stringification that used to lose it", () => {
    // The route rendered `{ error: String(reason) }` and the detector then
    // looked at that string. Classification has to happen while the rejection
    // is still an object.
    const rejection = new DbGrowthFenceRefusal(DECISION, "meta_consume_queued_work");
    expect(describeSyncSafetyRefusal(String(rejection))).toBeNull();
    expect(describeSyncSafetyRefusal(rejection)).not.toBeNull();
  });
});

describe("describeLaneOutcome", () => {
  it("keeps the structured refusal on a rejected lane", () => {
    const outcome = describeLaneOutcome({
      status: "rejected",
      reason: new DbGrowthFenceRefusal(DECISION, "google_sync_dates"),
    });
    expect(outcome.refusal?.kind).toBe("capacity_refused");
    expect(
      (outcome.value as { safetyRefusal?: { kind?: string } }).safetyRefusal?.kind,
    ).toBe("capacity_refused");
    // The human-readable message is still there; nothing was traded away.
    expect((outcome.value as { error?: string }).error).toContain("Sync refused");
  });

  it("classifies a fulfilled lane that reports a stop reason", () => {
    const outcome = describeLaneOutcome({
      status: "fulfilled",
      value: { stopReason: "meta_account_authority_unknown" },
    });
    expect(outcome.refusal?.kind).toBe("authority_unknown");
  });

  it("passes an ordinary fulfilled lane through unchanged", () => {
    const value = { attempted: 3, succeeded: 3 };
    const outcome = describeLaneOutcome({ status: "fulfilled", value });
    expect(outcome.refusal).toBeNull();
    expect(outcome.value).toBe(value);
  });
});
