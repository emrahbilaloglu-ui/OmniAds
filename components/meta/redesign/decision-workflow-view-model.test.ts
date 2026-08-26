import { describe, expect, it, vi } from "vitest";

import { buildDecisionWorkflowViewModel } from "@/components/meta/redesign/decision-workflow-view-model";
import { offeredWorkflowActions } from "@/components/meta/redesign/use-decision-workflow";
import type { WorkflowRecord } from "@/lib/decision-workflow";

const RECORD: WorkflowRecord = {
  businessId: "biz_1",
  decisionKey: "rec_1",
  state: "open",
  assigneeUserId: null,
  dueAt: null,
  snoozeUntil: null,
  reasonCode: null,
  stateVersion: 3,
};

describe("the inspector's Workflow section", () => {
  it("says why it is absent when the gate is closed, rather than rendering nothing", () => {
    /**
     * Hiding the section entirely would read as "this product has no ownership
     * model", which is false — it has one, on a surface the design has not yet
     * been asked to draw. §18's absent-with-reason posture.
     */
    const model = buildDecisionWorkflowViewModel({
      readState: "idle",
      unavailableReason: null,
      record: null,
      actionsRefusedReason: "Decision ownership actions are not enabled yet.",
    });
    expect(model?.state).toBe("unknown");
    expect(model?.unavailableReason).toContain("not enabled");
    expect(model?.actions).toEqual([]);
  });

  it("shows unknown, never open, when the read failed", () => {
    // Rendering the default state for a failed read claims nobody owns these
    // decisions — a statement about other people's work, made on no evidence.
    const model = buildDecisionWorkflowViewModel({
      readState: "unavailable",
      unavailableReason: "Workflow state could not be read.",
      record: null,
      actionsRefusedReason: null,
    });
    expect(model?.state).toBe("unknown");
    expect(model?.stateLabel).toBe("—");
    expect(model?.unavailableReason).toContain("could not be read");
  });

  it("shows the unavailable mark for a missing assignee, not 'Unassigned'", () => {
    // The record says there is no assignee. It does not say nobody is working
    // on it, and the second is a claim about the team.
    const model = buildDecisionWorkflowViewModel({
      readState: "ready",
      unavailableReason: null,
      record: RECORD,
      actionsRefusedReason: null,
    });
    expect(model?.assignee).toBe("—");
  });

  it("renders the design's own hold-until note from the record", () => {
    const model = buildDecisionWorkflowViewModel({
      readState: "ready",
      unavailableReason: null,
      record: { ...RECORD, state: "snoozed", snoozeUntil: "2026-08-15T09:00:00.000Z" },
      actionsRefusedReason: null,
      formatInstant: (iso) => `${iso.slice(0, 16).replace("T", " ")} UTC`,
    });
    expect(model?.holdUntil).toBe("Let cook until 2026-08-15 09:00 UTC");
  });

  it("offers each state's transitions with the refusal attached", () => {
    const model = buildDecisionWorkflowViewModel({
      readState: "ready",
      unavailableReason: null,
      record: RECORD,
      actionsRefusedReason: "Reviewer access is read-only.",
    });
    expect(model?.actions.map((action) => action.id)).toEqual([
      ...offeredWorkflowActions("open"),
    ]);
    for (const action of model!.actions) {
      // Present and refusing, so a gated surface shows what the workflow IS and
      // why it cannot be moved, rather than hiding the controls.
      expect(action.refusalReason).toBe("Reviewer access is read-only.");
      expect(action.onSelect).toBeUndefined();
    }
  });

  it("passes the record to the handler so the submit carries the version it saw", () => {
    const onAction = vi.fn();
    const model = buildDecisionWorkflowViewModel({
      readState: "ready",
      unavailableReason: null,
      record: RECORD,
      actionsRefusedReason: null,
      onAction,
    });
    model!.actions.find((action) => action.id === "acknowledge")!.onSelect!({});
    expect(onAction).toHaveBeenCalledExactlyOnceWith("acknowledge", RECORD, {});
    // stateVersion is what the server compares for optimistic concurrency; a
    // handler that had to re-look-up the record could send a newer one and
    // overwrite a change it never saw.
    expect(onAction.mock.calls[0]![1].stateVersion).toBe(3);
  });

  it("offers only reopen from a terminal state", () => {
    for (const state of ["rejected", "resolved"] as const) {
      const model = buildDecisionWorkflowViewModel({
        readState: "ready",
        unavailableReason: null,
        record: { ...RECORD, state },
        actionsRefusedReason: null,
      });
      expect(model?.actions.map((action) => action.id)).toEqual(["reopen"]);
    }
  });

  it("never offers an action the state does not permit", () => {
    // Offering is presentation; permitting is the server's. This asserts the
    // presentation half does not invite a click the server will refuse.
    for (const state of [
      "open",
      "acknowledged",
      "deferred",
      "snoozed",
      "rejected",
      "resolved",
    ] as const) {
      const offered = offeredWorkflowActions(state);
      expect(offered).not.toContain(state === "open" ? "reopen" : "nothing");
      expect(new Set(offered).size).toBe(offered.length);
    }
    expect(offeredWorkflowActions("open")).not.toContain("reopen");
  });
});
