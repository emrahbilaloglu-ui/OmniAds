import { describe, expect, it } from "vitest";

import { newWorkflowRecord, type WorkflowRecord } from "@/lib/decision-workflow";
import {
  CANONICAL_WORKFLOW_ACTIONS,
  availableTransitions,
  describeEvent,
  eventActorLabel,
  indexWorkflows,
  missingFields,
  reapplyPlan,
  servedRefusal,
  workflowPosture,
} from "@/lib/zero-base/meta/workflow-view-model";

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return { ...newWorkflowRecord({ businessId: "biz-1", decisionKey: "ad:1" }), ...overrides };
}

const viewer = {
  role: "collaborator" as const,
  isReviewer: false,
  readOnly: false,
  readOnlyReason: null,
};

describe("the overlay offers no comment control at all", () => {
  it("excludes comment from the canonical action set", () => {
    // The journal carries a comment column for the legacy contract. Offering it
    // here would put free-form text on a surface that must not carry it.
    expect(CANONICAL_WORKFLOW_ACTIONS).not.toContain("comment");
  });
});

describe("role posture", () => {
  it("lets a collaborator write", () => {
    expect(workflowPosture({ viewer, demo: false }).kind).toBe("write");
  });

  it("lets an admin write", () => {
    expect(workflowPosture({ viewer: { ...viewer, role: "admin" }, demo: false }).kind).toBe("write");
  });

  it("gives a guest read without controls", () => {
    const posture = workflowPosture({ viewer: { ...viewer, role: "guest" }, demo: false });
    expect(posture.kind).toBe("read");
    expect(availableTransitions({ record: record(), posture })).toEqual([]);
  });

  it("denies a reviewer outright rather than showing controls that will 403", () => {
    expect(workflowPosture({ viewer: { ...viewer, isReviewer: true }, demo: false }).kind).toBe(
      "denied",
    );
  });

  it("denies the demo business", () => {
    expect(workflowPosture({ viewer, demo: true }).kind).toBe("denied");
  });

  it("reads-only when the role could not be determined", () => {
    expect(workflowPosture({ viewer: null, demo: false }).kind).toBe("read");
    expect(workflowPosture({ viewer: { ...viewer, role: null }, demo: false }).kind).toBe("read");
  });

  it("carries the workspace's own read-only reason through", () => {
    const posture = workflowPosture({
      viewer: { ...viewer, readOnly: true, readOnlyReason: "Billing is past due." },
      demo: false,
    });
    expect(posture.kind === "read" && posture.reason).toBe("Billing is past due.");
  });
});

describe("the menu never offers what the server would refuse", () => {
  const posture = { kind: "write" as const };

  it("offers the opening moves on an open decision", () => {
    const actions = availableTransitions({ record: record(), posture });
    expect(actions).toContain("acknowledge");
    expect(actions).toContain("defer");
    // Nothing to reopen yet.
    expect(actions).not.toContain("reopen");
  });

  it("offers only reopen on a resolved decision", () => {
    const actions = availableTransitions({ record: record({ state: "resolved" }), posture });
    expect(actions).toEqual(["reopen"]);
  });

  it("offers only reopen on a rejected decision", () => {
    expect(availableTransitions({ record: record({ state: "rejected" }), posture })).toEqual([
      "reopen",
    ]);
  });

  it("probes with required fields supplied, so a form's emptiness is not read as a refusal", () => {
    // Reject and snooze both carry mandatory fields; they must still appear in
    // the menu before the operator has typed anything.
    const actions = availableTransitions({ record: record(), posture });
    expect(actions).toContain("reject");
    expect(actions).toContain("snooze");
  });
});

describe("required fields", () => {
  it("requires a reason to reject", () => {
    expect(missingFields({ action: "reject", values: {} })).toEqual(["reasonCode"]);
    expect(missingFields({ action: "reject", values: { reasonCode: "wrong_target" } })).toEqual([]);
  });

  it("requires a wake-up time to snooze", () => {
    expect(missingFields({ action: "snooze", values: {} })).toEqual(["snoozeUntil"]);
  });

  it("requires an assignee to assign", () => {
    expect(missingFields({ action: "assign", values: {} })).toEqual(["assigneeUserId"]);
  });

  it("treats whitespace as absent", () => {
    expect(missingFields({ action: "reject", values: { reasonCode: "   " } })).toEqual(["reasonCode"]);
  });

  it("requires nothing to acknowledge", () => {
    expect(missingFields({ action: "acknowledge", values: {} })).toEqual([]);
  });
});

describe("conflict and re-apply", () => {
  it("re-applies against the refreshed version, never the stale one", () => {
    const plan = reapplyPlan({
      current: record({ state: "open", stateVersion: 7 }),
      attempted: { action: "acknowledge", fromVersion: 3 },
      message: "changed",
    });
    expect(plan.allowed).toBe(true);
    // 7, not 3: re-applying with the stale version would just conflict again.
    expect(plan.expectedVersion).toBe(7);
  });

  it("refuses to offer a re-apply the server would reject", () => {
    const plan = reapplyPlan({
      current: record({ state: "resolved", stateVersion: 4 }),
      attempted: { action: "acknowledge", fromVersion: 1 },
      message: "changed",
    });
    // Somebody resolved it while this operator was deciding to acknowledge it.
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toContain("Resolved");
  });
});

describe("served universe", () => {
  it("refuses a decision that left the served set", () => {
    expect(servedRefusal({ decisionKey: "ad:9", servedIds: ["ad:1"] })).toContain(
      "no longer in the served set",
    );
  });

  it("permits one that is still served", () => {
    expect(servedRefusal({ decisionKey: "ad:1", servedIds: ["ad:1"] })).toBeNull();
  });
});

describe("indexing", () => {
  it("fills an untouched decision as open rather than dropping it", () => {
    const index = indexWorkflows({
      businessId: "biz-1",
      decisionKeys: ["ad:1", "ad:2"],
      workflows: [record({ decisionKey: "ad:1", state: "deferred" })],
    });
    expect(index.get("ad:1")?.state).toBe("deferred");
    expect(index.get("ad:2")?.state).toBe("open");
  });
});

describe("event attribution", () => {
  const base = {
    event: "acknowledge",
    fromState: "open",
    toState: "acknowledged",
    reasonCode: null,
    stateVersion: 2,
    occurredAt: "2026-08-11T09:00:00.000Z",
  };

  it("uses a recorded name", () => {
    expect(eventActorLabel({ ...base, actorUserId: "u1", actorName: "Ada" })).toBe("Ada");
  });

  it("says the member is unknown when the id survived but the name did not", () => {
    expect(eventActorLabel({ ...base, actorUserId: "u1", actorName: null })).toBe("Unknown member");
  });

  it("says the actor was not recorded rather than attributing it to the system", () => {
    const label = eventActorLabel({ ...base, actorUserId: null, actorName: null });
    expect(label).toBe("Actor not recorded");
    expect(label).not.toMatch(/system/i);
  });

  it("describes a transition as from → to", () => {
    expect(describeEvent({ ...base, actorUserId: null, actorName: null })).toBe(
      "Acknowledge — Open → Acknowledged",
    );
  });
});
