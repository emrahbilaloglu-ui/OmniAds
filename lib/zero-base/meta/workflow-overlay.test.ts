/**
 * WP-13 hardening of the existing workflow overlay.
 *
 * The overlay is an operator's private lane: who is looking at a decision and
 * what they intend to do about it. It must never move the truth lane — the
 * verdict a decision carries is the resolver's, and a workflow state cannot
 * change, reorder or re-label it.
 */
import { describe, expect, it } from "vitest";

import { workflowIdempotencyUpgradeStatements } from "@/lib/zero-base/meta/workflow-schema";
import {
  applyWorkflowTransition,
  newWorkflowRecord,
  type WorkflowRecord,
} from "@/lib/decision-workflow";

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return { ...newWorkflowRecord({ businessId: "biz_1", decisionKey: "dec_1" }), ...overrides };
}

describe("schema hardening is additive only", () => {
  const sql = workflowIdempotencyUpgradeStatements().join("\n");

  it("creates no parallel workflow table", () => {
    // The plan forbids meta_decision_workflow_state / _events outright: a
    // second pair would split the event journal in two.
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toContain("meta_decision_workflow_state");
    expect(sql).not.toContain("meta_decision_workflow_events");
  });

  it("touches only the existing overlay tables", () => {
    for (const statement of workflowIdempotencyUpgradeStatements()) {
      expect(statement).toMatch(/decision_workflow_events/);
    }
  });

  it("adds the idempotency column as nullable so existing rows stay valid", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS mutation_id UUID");
    expect(sql).not.toMatch(/mutation_id UUID NOT NULL/);
  });

  it("scopes the unique index per business and skips existing null rows", () => {
    // Global uniqueness would let one tenant's retry suppress another's event.
    expect(sql).toContain("(business_id, mutation_id)");
    expect(sql).toContain("WHERE mutation_id IS NOT NULL");
  });

  it("is idempotent, so from-zero and upgrade run identically", () => {
    for (const statement of workflowIdempotencyUpgradeStatements()) {
      expect(/IF NOT EXISTS/.test(statement), statement.slice(0, 60)).toBe(true);
    }
  });
});

describe("transition validation", () => {
  it("refuses a stale expectedVersion rather than overwriting", () => {
    const result = applyWorkflowTransition({
      current: record({ stateVersion: 3 }),
      action: "acknowledge",
      actorUserId: "user_1",
      expectedVersion: 2,
    });
    // A second operator acting on a stale view is told to reload.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("version_conflict");
  });

  it("accepts the matching version and bumps it", () => {
    const result = applyWorkflowTransition({
      current: record({ stateVersion: 1 }),
      action: "acknowledge",
      actorUserId: "user_1",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.state).toBe("acknowledged");
      expect(result.next.stateVersion).toBe(2);
    }
  });

  it("refuses a transition the state machine does not allow", () => {
    const result = applyWorkflowTransition({
      // `reopen` applies to a closed decision; an open one has nothing to reopen.
      current: record({ state: "open" }),
      action: "reopen",
      actorUserId: "user_1",
      expectedVersion: 1,
    });
    expect(result.ok === false && result.reason).toBe("invalid_transition");
  });

  it("requires a reason to reject", () => {
    const result = applyWorkflowTransition({
      current: record(),
      action: "reject",
      actorUserId: "user_1",
      expectedVersion: 1,
    });
    expect(result.ok === false && result.reason).toBe("reason_required");
  });

  it("requires a wake time to snooze", () => {
    const result = applyWorkflowTransition({
      current: record(),
      action: "snooze",
      actorUserId: "user_1",
      expectedVersion: 1,
    });
    // A snooze with no end is a silent deletion from the queue.
    expect(result.ok === false && result.reason).toBe("snooze_required");
  });

  it("records the acting user as actor, whoever the assignee is", () => {
    const result = applyWorkflowTransition({
      current: record(),
      action: "assign",
      actorUserId: "user_1",
      assigneeUserId: "user_2",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.actorUserId).toBe("user_1");
      expect(result.next.assigneeUserId).toBe("user_2");
    }
  });
});

describe("the overlay never moves the truth lane", () => {
  it("carries no verdict, label, lane or metric field", () => {
    const result = applyWorkflowTransition({
      current: record(),
      action: "acknowledge",
      actorUserId: "user_1",
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The record's whole surface: workflow facts only. A verdict or lane field
    // here would let an operator's intent rewrite the resolver's output.
    expect(Object.keys(result.next).sort()).toEqual([
      "assigneeUserId",
      "businessId",
      "decisionKey",
      "dueAt",
      "reasonCode",
      "snoozeUntil",
      "state",
      "stateVersion",
    ]);
    for (const forbidden of ["decision", "label", "lane", "verdict", "buyerAction", "confidence"]) {
      expect(Object.keys(result.next)).not.toContain(forbidden);
    }
  });

  it("keys state to a decision without redefining it", () => {
    const fresh = newWorkflowRecord({ businessId: "biz_1", decisionKey: "dec_1" });
    // A decision nobody has touched is open, not missing — the overlay adds a
    // lane of its own and does not claim the decision does not exist.
    expect(fresh.state).toBe("open");
    expect(fresh.stateVersion).toBe(1);
    expect(fresh.decisionKey).toBe("dec_1");
  });
});
