import type {
  MetaDecisionCenterExactWorkflow,
  MetaDecisionCenterExactWorkflowAction,
} from "@/components/meta/decision-center/MetaDecisionCenterExact";
import type { WorkflowRecord, WorkflowState } from "@/lib/decision-workflow";
import type { CanonicalWorkflowAction } from "@/lib/meta/decision-workflow-client";
import {
  WORKFLOW_ACTION_LABELS,
  offeredWorkflowActions,
  type DecisionWorkflowReadState,
} from "@/components/meta/redesign/use-decision-workflow";

const EM_DASH = "—";

const STATE_LABELS: Readonly<Record<WorkflowState, string>> = {
  open: "Open",
  acknowledged: "Acknowledged",
  deferred: "Deferred",
  snoozed: "Snoozed",
  rejected: "Rejected",
  resolved: "Resolved",
};

/**
 * Fields the server refuses a transition without.
 *
 * Mirrors `REQUIRED_FIELDS` in `lib/zero-base/meta/workflow-view-model.ts`, and
 * for the same reason the offered-actions table is mirrored: this decides which
 * INPUTS a control collects, while the server decides what it accepts. `assign`
 * with no assignee is the one that is not a validation error — it is a no-op
 * that still increments `stateVersion`, so every other open tab conflicts over
 * a change that changed nothing.
 */
const REQUIRED_FIELDS: Readonly<
  Record<CanonicalWorkflowAction, readonly ("assignee" | "snoozeUntil" | "reasonCode")[]>
> = {
  assign: ["assignee"],
  acknowledge: [],
  defer: [],
  snooze: ["snoozeUntil"],
  reject: ["reasonCode"],
  resolve: [],
  reopen: [],
};

/**
 * Build the inspector's Workflow section for one selected decision.
 *
 * Three rules this encodes, each of which the surface got wrong before it
 * existed:
 *
 * 1. **An unread overlay is `unknown`, never `open`.** Rendering the default
 *    state for a failed read claims nobody owns these decisions — a statement
 *    about other people's work, made on no evidence.
 * 2. **A missing assignee is the unavailable mark, not "Unassigned".** We know
 *    the record has no assignee; we do not know that nobody is working on it.
 * 3. **Every action is offered with its refusal attached**, so a gated surface
 *    shows what the workflow *is* and why it cannot be moved, rather than
 *    hiding the controls and reading as a product that has no workflow.
 */
export function buildDecisionWorkflowViewModel(input: {
  readState: DecisionWorkflowReadState;
  unavailableReason: string | null;
  record: WorkflowRecord | null;
  /** Non-null when no action may run: the gate, a reviewer, a demo workspace. */
  actionsRefusedReason: string | null;
  onAction?: (
    action: CanonicalWorkflowAction,
    record: WorkflowRecord,
    values: {
      assigneeUserId?: string;
      snoozeUntil?: string;
      reasonCode?: string;
    },
  ) => void;
  /** True while a transition for this decision is in flight. */
  pending?: boolean;
  /** The unresolved 409, already shaped for the dialog. */
  conflict?: MetaDecisionCenterExactWorkflow["conflict"];
  /** Formats an ISO instant for display. Injected so this stays pure. */
  formatInstant?: (iso: string) => string;
}): MetaDecisionCenterExactWorkflow | null {
  /**
   * `idle` renders the section as absent-with-reason rather than as nothing.
   *
   * The gate is closed, so no read ran. Hiding the section entirely would read
   * as "this product has no ownership model", which is false — it has one, on
   * a surface the design has not yet been asked to draw. Saying so is the §18
   * "absent-with-reason" posture.
   */
  if (input.readState === "idle") {
    return input.actionsRefusedReason
      ? {
          state: "unknown",
          stateLabel: EM_DASH,
          assignee: EM_DASH,
          holdUntil: EM_DASH,
          unavailableReason: input.actionsRefusedReason,
          actions: [],
        }
      : null;
  }

  if (input.readState === "loading") {
    return {
      state: "unknown",
      stateLabel: "Reading…",
      assignee: EM_DASH,
      holdUntil: EM_DASH,
      actions: [],
    };
  }

  if (input.readState === "unavailable" || !input.record) {
    return {
      state: "unknown",
      stateLabel: EM_DASH,
      assignee: EM_DASH,
      holdUntil: EM_DASH,
      unavailableReason:
        input.unavailableReason ??
        "Workflow state could not be read, so ownership is shown as unknown rather than open.",
      actions: [],
    };
  }

  const record = input.record;
  const format = input.formatInstant ?? ((iso: string) => iso);

  const actions: MetaDecisionCenterExactWorkflowAction[] = offeredWorkflowActions(
    record.state,
  ).map((action) => ({
    id: action,
    label: WORKFLOW_ACTION_LABELS[action],
    refusalReason: input.actionsRefusedReason,
    requires: REQUIRED_FIELDS[action],
    onSelect: input.actionsRefusedReason
      ? undefined
      : (values) => input.onAction?.(action, record, values),
  }));

  return {
    state: record.state,
    stateLabel: STATE_LABELS[record.state],
    // The record says there is no assignee. It does not say nobody is working
    // on it, so the unavailable mark is the honest value rather than a word
    // that reads as a fact about the team.
    assignee: record.assigneeUserId ? `Owner ${record.assigneeUserId}` : EM_DASH,
    // The design's own row note — "Let cook until Aug 15, 09:00" — rendered
    // from the record instead of from a fixture.
    holdUntil: record.snoozeUntil
      ? `Let cook until ${format(record.snoozeUntil)}`
      : record.dueAt
        ? `Due ${format(record.dueAt)}`
        : EM_DASH,
    actions,
    actionsRefusedReason: input.actionsRefusedReason,
    menuRefusedReason: input.actionsRefusedReason,
    pending: input.pending ?? false,
    conflict: input.conflict ?? null,
  };
}

/** Re-exported so callers do not need two imports for one concept. */
export type { CanonicalWorkflowAction };
