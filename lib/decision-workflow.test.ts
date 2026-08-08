import { describe, expect, it } from "vitest";
import {
  applyWorkflowTransition,
  isHiddenFromQueue,
  newWorkflowRecord,
  type WorkflowRecord,
} from "@/lib/decision-workflow";

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return { ...newWorkflowRecord({ businessId: "biz-1", decisionKey: "dec-1" }), ...overrides };
}

describe("concurrent operators cannot overwrite each other", () => {
  it("refuses a transition made against a stale version", () => {
    const result = applyWorkflowTransition({
      current: record({ stateVersion: 4 }),
      action: "acknowledge",
      actorUserId: "user-2",
      expectedVersion: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version_conflict");
      expect(result.message).toContain("Reload");
    }
  });

  it("advances the version on every accepted transition", () => {
    const result = applyWorkflowTransition({
      current: record({ stateVersion: 1 }),
      action: "acknowledge",
      actorUserId: "user-1",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.stateVersion).toBe(2);
      expect(result.event.stateVersion).toBe(2);
    }
  });
});

describe("state machine", () => {
  it("acknowledges an open decision", () => {
    const result = applyWorkflowTransition({
      current: record(),
      action: "acknowledge",
      actorUserId: "user-1",
      expectedVersion: 1,
    });
    expect(result.ok && result.next.state).toBe("acknowledged");
  });

  it("refuses to acknowledge something already resolved", () => {
    const result = applyWorkflowTransition({
      current: record({ state: "resolved" }),
      action: "acknowledge",
      actorUserId: "user-1",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_transition");
  });

  it("can always reopen a rejected or resolved decision", () => {
    for (const state of ["rejected", "resolved"] as const) {
      const result = applyWorkflowTransition({
        current: record({ state }),
        action: "reopen",
        actorUserId: "user-1",
        expectedVersion: 1,
      });
      expect(result.ok && result.next.state).toBe("open");
    }
  });

  it("requires a reason to reject the engine's call", () => {
    const missing = applyWorkflowTransition({
      current: record(),
      action: "reject",
      actorUserId: "user-1",
      expectedVersion: 1,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("reason_required");

    const given = applyWorkflowTransition({
      current: record(),
      action: "reject",
      actorUserId: "user-1",
      expectedVersion: 1,
      reasonCode: "seasonal_expected",
    });
    expect(given.ok && given.next.reasonCode).toBe("seasonal_expected");
  });

  it("requires a wake-up time to snooze", () => {
    const result = applyWorkflowTransition({
      current: record(),
      action: "snooze",
      actorUserId: "user-1",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("snooze_required");
  });

  it("records assignment without changing the decision's state", () => {
    const result = applyWorkflowTransition({
      current: record({ state: "acknowledged" }),
      action: "assign",
      actorUserId: "user-1",
      expectedVersion: 1,
      assigneeUserId: "user-9",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.assigneeUserId).toBe("user-9");
      expect(result.next.state).toBe("acknowledged");
    }
  });

  it("lets a comment be added in any state without moving it", () => {
    const result = applyWorkflowTransition({
      current: record({ state: "rejected" }),
      action: "comment",
      actorUserId: "user-1",
      expectedVersion: 1,
      comment: "Client paused spend for a rebrand.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.state).toBe("rejected");
      expect(result.event.comment).toBe("Client paused spend for a rebrand.");
    }
  });
});

describe("workflow state never touches engine truth", () => {
  it("carries no field that could alter a decision or its authority", () => {
    const result = applyWorkflowTransition({
      current: record(),
      action: "reject",
      actorUserId: "user-1",
      expectedVersion: 1,
      reasonCode: "wrong_call",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Object.keys(result.next);
      for (const forbidden of [
        "buyerAction",
        "primaryDecision",
        "authority",
        "riskTier",
        "executionAction",
        "providerEligible",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe("queue visibility", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("hides deferred, rejected and resolved decisions", () => {
    for (const state of ["deferred", "rejected", "resolved"] as const) {
      expect(isHiddenFromQueue(record({ state }), now)).toBe(true);
    }
  });

  it("keeps an open or acknowledged decision in the queue", () => {
    expect(isHiddenFromQueue(record({ state: "open" }), now)).toBe(false);
    expect(isHiddenFromQueue(record({ state: "acknowledged" }), now)).toBe(false);
  });

  it("returns a snoozed decision once its time has passed", () => {
    const stillAsleep = record({ state: "snoozed", snoozeUntil: "2026-08-09T00:00:00.000Z" });
    const awake = record({ state: "snoozed", snoozeUntil: "2026-08-08T06:00:00.000Z" });
    expect(isHiddenFromQueue(stillAsleep, now)).toBe(true);
    expect(isHiddenFromQueue(awake, now)).toBe(false);
  });

  it("does not lose a snoozed decision to a malformed wake time", () => {
    expect(isHiddenFromQueue(record({ state: "snoozed", snoozeUntil: "soon" }), now)).toBe(true);
  });
});
