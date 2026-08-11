/**
 * Presentation model for the operator workflow overlay (WP-13, Flow C).
 *
 * The overlay records who owns a decision and what they have said about it. It
 * is strictly an annotation: nothing here reaches a label, an authority, or
 * provider eligibility, and the served verdict/lane bytes are the same before
 * and after every transition. Deferring a decision hides it from a queue; it
 * never makes the recommendation less true and never grants permission to act.
 *
 * Three rules shape this module:
 *
 * 1. **Available transitions come from the same table the server enforces.**
 *    Offering a control the server will refuse teaches an operator that the
 *    surface and the authority disagree, so the menu is derived from
 *    `ALLOWED_TRANSITIONS` rather than restated here.
 * 2. **A conflict is shown, never resolved silently.** On 409 the operator sees
 *    the server's current state beside what they tried, and re-applying is an
 *    explicit act against the refreshed version.
 * 3. **No comments.** The journal carries a comment column for the legacy
 *    contract; the canonical surface has no comment control and no comment
 *    read.
 */
import {
  applyWorkflowTransition,
  newWorkflowRecord,
  type WorkflowAction,
  type WorkflowRecord,
  type WorkflowState,
} from "@/lib/decision-workflow";
import type { WorkflowEvent } from "@/lib/decision-workflow-store";
import type { MetaDecisionsWorkspaceViewer } from "@/components/meta/redesign/types";

/** Actions the canonical surface offers. `comment` is deliberately absent. */
export const CANONICAL_WORKFLOW_ACTIONS = [
  "assign",
  "acknowledge",
  "defer",
  "snooze",
  "reject",
  "resolve",
  "reopen",
] as const satisfies readonly WorkflowAction[];

export type CanonicalWorkflowAction = (typeof CANONICAL_WORKFLOW_ACTIONS)[number];

export const WORKFLOW_STATE_LABEL: Record<WorkflowState, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  deferred: "Deferred",
  snoozed: "Snoozed",
  rejected: "Rejected",
  resolved: "Resolved",
};

export const WORKFLOW_ACTION_LABEL: Record<CanonicalWorkflowAction, string> = {
  assign: "Assign",
  acknowledge: "Acknowledge",
  defer: "Defer",
  snooze: "Snooze",
  reject: "Reject",
  resolve: "Resolve",
  reopen: "Reopen",
};

/** Fields a transition cannot be submitted without. */
export const REQUIRED_FIELDS: Record<CanonicalWorkflowAction, ReadonlyArray<
  "assigneeUserId" | "snoozeUntil" | "reasonCode"
>> = {
  assign: ["assigneeUserId"],
  acknowledge: [],
  defer: [],
  snooze: ["snoozeUntil"],
  reject: ["reasonCode"],
  resolve: [],
  reopen: [],
};

export type WorkflowPosture =
  | { kind: "write" }
  | { kind: "read"; reason: string }
  | { kind: "denied"; reason: string };

/**
 * What this viewer may do to the overlay.
 *
 * A guest reads and cannot write; a reviewer is denied outright rather than
 * shown controls that will 403. Demo carries no write authority anywhere in the
 * product and the overlay is no exception.
 */
export function workflowPosture(input: {
  viewer: MetaDecisionsWorkspaceViewer | null;
  demo: boolean;
}): WorkflowPosture {
  if (input.viewer?.isReviewer) {
    return { kind: "denied", reason: "Reviewer sessions cannot change workflow state." };
  }
  if (input.demo) {
    return { kind: "denied", reason: "The demo business has no workflow authority." };
  }
  if (!input.viewer || input.viewer.role === null) {
    return { kind: "read", reason: "Your role on this business could not be read." };
  }
  if (input.viewer.role === "guest") {
    return { kind: "read", reason: "Guests can see workflow state but not change it." };
  }
  if (input.viewer.readOnly) {
    return {
      kind: "read",
      reason: input.viewer.readOnlyReason ?? "This workspace is read-only right now.",
    };
  }
  return { kind: "write" };
}

/**
 * Transitions offered for a record.
 *
 * Probed through the real state machine with the record's own version, so the
 * menu can never offer something the server would refuse as an invalid
 * transition. An empty list is a legitimate answer.
 */
export function availableTransitions(input: {
  record: WorkflowRecord;
  posture: WorkflowPosture;
}): CanonicalWorkflowAction[] {
  if (input.posture.kind !== "write") return [];
  return CANONICAL_WORKFLOW_ACTIONS.filter((action) => {
    const probe = applyWorkflowTransition({
      current: input.record,
      action,
      actorUserId: "probe",
      expectedVersion: input.record.stateVersion,
      // Required fields are supplied so the probe tests the transition itself
      // rather than the emptiness of a form the operator has not filled in yet.
      assigneeUserId: action === "assign" ? "probe" : undefined,
      snoozeUntil: action === "snooze" ? "2026-01-01T00:00:00.000Z" : undefined,
      reasonCode: action === "reject" ? "probe" : undefined,
    });
    return probe.ok;
  });
}

/** Fields the operator still has to supply before a transition can be sent. */
export function missingFields(input: {
  action: CanonicalWorkflowAction;
  values: { assigneeUserId?: string | null; snoozeUntil?: string | null; reasonCode?: string | null };
}): string[] {
  return REQUIRED_FIELDS[input.action].filter(
    (field) => !(input.values[field] ?? "").trim(),
  );
}

export type WorkflowLoadState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ready" };

export interface WorkflowConflict {
  /** Server state at the moment of refusal. */
  current: WorkflowRecord;
  /** What the operator was trying to do. */
  attempted: { action: CanonicalWorkflowAction; fromVersion: number };
  message: string;
}

/**
 * Whether a refused transition can be re-applied against the refreshed version.
 *
 * Re-applying is never automatic. The operator sees what the server now says,
 * and chooses; a silent retry against the new version would overwrite whatever
 * the other operator just did without anyone reading it.
 */
export function reapplyPlan(conflict: WorkflowConflict): {
  allowed: boolean;
  action: CanonicalWorkflowAction;
  expectedVersion: number;
  reason: string | null;
} {
  const probe = applyWorkflowTransition({
    current: conflict.current,
    action: conflict.attempted.action,
    actorUserId: "probe",
    expectedVersion: conflict.current.stateVersion,
    assigneeUserId: conflict.attempted.action === "assign" ? "probe" : undefined,
    snoozeUntil: conflict.attempted.action === "snooze" ? "2026-01-01T00:00:00.000Z" : undefined,
    reasonCode: conflict.attempted.action === "reject" ? "probe" : undefined,
  });
  return {
    allowed: probe.ok,
    action: conflict.attempted.action,
    expectedVersion: conflict.current.stateVersion,
    reason: probe.ok
      ? null
      : `${WORKFLOW_ACTION_LABEL[conflict.attempted.action]} no longer applies to a decision that is ${
          WORKFLOW_STATE_LABEL[conflict.current.state]
        }.`,
  };
}

/** Attribution for a journal row, without inventing an actor. */
export function eventActorLabel(event: WorkflowEvent): string {
  const name = (event.actorName ?? "").trim();
  if (name) return name;
  // Neither "System" nor a blank: one is a claim, the other reads as an
  // oversight in the rendering.
  return event.actorUserId ? "Unknown member" : "Actor not recorded";
}

export function describeEvent(event: WorkflowEvent): string {
  const label =
    (WORKFLOW_ACTION_LABEL as Record<string, string>)[event.event] ?? event.event;
  if (event.fromState && event.toState && event.fromState !== event.toState) {
    return `${label} — ${WORKFLOW_STATE_LABEL[event.fromState as WorkflowState] ?? event.fromState} → ${
      WORKFLOW_STATE_LABEL[event.toState as WorkflowState] ?? event.toState
    }`;
  }
  return label;
}

/** Records keyed by decision, with the implicit open state filled in. */
export function indexWorkflows(input: {
  businessId: string;
  decisionKeys: readonly string[];
  workflows: readonly WorkflowRecord[];
}): Map<string, WorkflowRecord> {
  const byKey = new Map(input.workflows.map((record) => [record.decisionKey, record]));
  const result = new Map<string, WorkflowRecord>();
  for (const key of input.decisionKeys) {
    result.set(
      key,
      byKey.get(key) ??
        newWorkflowRecord({ businessId: input.businessId, decisionKey: key }),
    );
  }
  return result;
}

/**
 * A decision that left the served universe cannot be worked on.
 *
 * The overlay is keyed by decision, so a stale tab could otherwise assign a
 * decision the current read no longer serves — recording ownership of something
 * nobody can open.
 */
export function servedRefusal(input: {
  decisionKey: string;
  servedIds: readonly string[];
}): string | null {
  return input.servedIds.includes(input.decisionKey)
    ? null
    : "This decision is no longer in the served set, so its workflow cannot be changed. Reload to see the current decisions.";
}
