/**
 * Operator workflow overlay.
 *
 * A decision today is a thing the engine says; it is not a thing anyone owns.
 * There is no way to say "I've got this", "not this week", or "this one is
 * wrong, and here's why" in a way that survives a refresh or reaches a
 * colleague.
 *
 * This models that ownership layer and nothing more. It is strictly separate
 * from engine truth: no transition here can change a decision's label, its
 * authority, or whether a provider action is permitted. Deferring a decision
 * hides it from a queue; it never makes the underlying recommendation less
 * true, and it never grants permission to act.
 */

export type WorkflowState =
  | "open"
  | "acknowledged"
  | "deferred"
  | "snoozed"
  | "rejected"
  | "resolved";

export type WorkflowAction =
  | "assign"
  | "acknowledge"
  | "defer"
  | "snooze"
  | "reject"
  | "resolve"
  | "reopen"
  | "comment";

export interface WorkflowRecord {
  businessId: string;
  decisionKey: string;
  state: WorkflowState;
  assigneeUserId: string | null;
  dueAt: string | null;
  snoozeUntil: string | null;
  reasonCode: string | null;
  stateVersion: number;
}

export interface WorkflowTransitionInput {
  current: WorkflowRecord;
  action: WorkflowAction;
  actorUserId: string;
  /** The version the actor was looking at when they decided. */
  expectedVersion: number;
  assigneeUserId?: string | null;
  dueAt?: string | null;
  snoozeUntil?: string | null;
  reasonCode?: string | null;
  comment?: string | null;
}

export type WorkflowTransitionResult =
  | {
      ok: true;
      next: WorkflowRecord;
      event: {
        event: WorkflowAction;
        fromState: WorkflowState;
        toState: WorkflowState;
        actorUserId: string;
        reasonCode: string | null;
        comment: string | null;
        stateVersion: number;
      };
    }
  | {
      ok: false;
      reason: "version_conflict" | "invalid_transition" | "reason_required" | "snooze_required";
      message: string;
    };

/** Terminal-ish states can still be reopened; nothing here is unrecoverable. */
const ALLOWED_TRANSITIONS: Record<WorkflowAction, WorkflowState[]> = {
  assign: ["open", "acknowledged", "deferred", "snoozed"],
  acknowledge: ["open", "deferred", "snoozed"],
  defer: ["open", "acknowledged", "snoozed"],
  snooze: ["open", "acknowledged", "deferred"],
  reject: ["open", "acknowledged", "deferred", "snoozed"],
  resolve: ["open", "acknowledged", "deferred", "snoozed"],
  reopen: ["rejected", "resolved", "deferred", "snoozed"],
  comment: ["open", "acknowledged", "deferred", "snoozed", "rejected", "resolved"],
};

const RESULTING_STATE: Partial<Record<WorkflowAction, WorkflowState>> = {
  acknowledge: "acknowledged",
  defer: "deferred",
  snooze: "snoozed",
  reject: "rejected",
  resolve: "resolved",
  reopen: "open",
};

export function applyWorkflowTransition(
  input: WorkflowTransitionInput,
): WorkflowTransitionResult {
  const { current, action } = input;

  // Optimistic concurrency: a second operator acting on a stale view is told to
  // reload rather than silently overwriting the first operator's decision.
  if (input.expectedVersion !== current.stateVersion) {
    return {
      ok: false,
      reason: "version_conflict",
      message:
        "This decision changed while you were looking at it. Reload to see the current state.",
    };
  }

  if (!ALLOWED_TRANSITIONS[action].includes(current.state)) {
    return {
      ok: false,
      reason: "invalid_transition",
      message: `Cannot ${action} a decision that is ${current.state}.`,
    };
  }

  // Rejecting the engine's call is the one action that must always carry a
  // reason: it is the record of why a human disagreed.
  if (action === "reject" && !input.reasonCode?.trim()) {
    return {
      ok: false,
      reason: "reason_required",
      message: "Rejecting a decision requires a reason code.",
    };
  }

  if (action === "snooze" && !input.snoozeUntil?.trim()) {
    return {
      ok: false,
      reason: "snooze_required",
      message: "Snoozing a decision requires a wake-up time.",
    };
  }

  const toState = RESULTING_STATE[action] ?? current.state;
  const next: WorkflowRecord = {
    ...current,
    state: toState,
    stateVersion: current.stateVersion + 1,
    assigneeUserId:
      action === "assign"
        ? (input.assigneeUserId ?? null)
        : current.assigneeUserId,
    dueAt: input.dueAt !== undefined ? input.dueAt : current.dueAt,
    snoozeUntil:
      action === "snooze"
        ? (input.snoozeUntil ?? null)
        : action === "reopen"
          ? null
          : current.snoozeUntil,
    reasonCode:
      action === "reject" ? (input.reasonCode ?? null) : current.reasonCode,
  };

  return {
    ok: true,
    next,
    event: {
      event: action,
      fromState: current.state,
      toState,
      actorUserId: input.actorUserId,
      reasonCode: input.reasonCode?.trim() || null,
      comment: input.comment?.trim() || null,
      stateVersion: next.stateVersion,
    },
  };
}

/**
 * Whether a decision should currently be hidden from the active queue.
 *
 * A snooze that has elapsed is over: the decision returns rather than staying
 * hidden because nobody re-opened it by hand.
 */
export function isHiddenFromQueue(record: WorkflowRecord, now: Date): boolean {
  if (record.state === "rejected" || record.state === "resolved") return true;
  if (record.state === "deferred") return true;
  if (record.state === "snoozed") {
    if (!record.snoozeUntil) return true;
    const wake = new Date(record.snoozeUntil);
    if (Number.isNaN(wake.getTime())) return true;
    return wake.getTime() > now.getTime();
  }
  return false;
}

export function newWorkflowRecord(input: {
  businessId: string;
  decisionKey: string;
}): WorkflowRecord {
  return {
    businessId: input.businessId,
    decisionKey: input.decisionKey,
    state: "open",
    assigneeUserId: null,
    dueAt: null,
    snoozeUntil: null,
    reasonCode: null,
    stateVersion: 1,
  };
}
