"use client";

/**
 * The operator workflow overlay, mounted in the Decisions row and inspector.
 *
 * What this is: a way to say "I've got this", "not this week", or "this one is
 * wrong, and here's why" in a way that survives a refresh and reaches a
 * colleague.
 *
 * What this is emphatically not: a change to the decision. Every transition
 * here annotates. The served verdict and lane bytes are identical before and
 * after, the row does not move, and nothing here grants permission to act on a
 * provider.
 *
 * The two behaviours worth reading carefully:
 *
 * - **409 is shown, never resolved.** The operator sees the server's current
 *   state beside what they attempted, and re-applying is an explicit act
 *   against the refreshed version. A silent retry would overwrite whatever the
 *   other operator just did, with nobody having read it.
 * - **A mutation id is generated once per attempt**, not per request, so a
 *   double click or a retried POST is a replay rather than a second transition
 *   that bumps the version again.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import type { WorkflowRecord } from "@/lib/decision-workflow";
import type { WorkflowEvent } from "@/lib/decision-workflow-store";
import {
  WORKFLOW_ACTION_LABEL,
  WORKFLOW_STATE_LABEL,
  availableTransitions,
  describeEvent,
  eventActorLabel,
  missingFields,
  reapplyPlan,
  servedRefusal,
  type CanonicalWorkflowAction,
  type WorkflowConflict,
  type WorkflowLoadState,
  type WorkflowPosture,
} from "@/lib/zero-base/meta/workflow-view-model";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

const STATE_TONE: Record<string, string> = {
  open: "var(--ledger-ink-secondary)",
  acknowledged: "var(--ledger-accent-action)",
  deferred: "var(--ledger-ink-tertiary)",
  snoozed: "var(--ledger-ink-tertiary)",
  rejected: "var(--ledger-semantic-warn)",
  resolved: "var(--ledger-semantic-ok)",
};

/** Compact state marker for a collection row. Never a control. */
export function WorkflowChip({
  record,
  loadState,
}: {
  record: WorkflowRecord | null;
  loadState: WorkflowLoadState;
}) {
  const copy = useCopy();
  if (loadState.kind === "loading") {
    return (
      <span data-workflow-chip="loading" style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
        Loading…
      </span>
    );
  }
  if (loadState.kind === "error") {
    // Not "Open": an unread overlay is unknown, and printing the default state
    // would claim nobody owns a decision somebody may well own.
    return (
      <span data-workflow-chip="unknown" style={{ fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
        {copy.workflowUnknown}
      </span>
    );
  }
  const state = record?.state ?? "open";
  return (
    <span
      data-workflow-chip={state}
      data-el="wf-chip"
      style={{ fontSize: 12, fontWeight: 600, color: STATE_TONE[state] ?? "var(--ledger-ink-secondary)" }}
    >
      {WORKFLOW_STATE_LABEL[state]}
      {record?.assigneeUserId ? (
        <span data-workflow-assigned="" style={{ display: "block", fontWeight: 400, color: "var(--ledger-ink-tertiary)" }}>
          {copy.assigned}
        </span>
      ) : null}
    </span>
  );
}

export interface WorkflowSubmit {
  action: CanonicalWorkflowAction;
  expectedVersion: number;
  mutationId: string;
  assigneeUserId: string | null;
  dueAt: string | null;
  snoozeUntil: string | null;
  reasonCode: string | null;
}

export type WorkflowSubmitResult =
  | { ok: true; workflow: WorkflowRecord; replayed: boolean }
  | { ok: false; kind: "conflict"; current: WorkflowRecord; message: string }
  | { ok: false; kind: "error"; message: string };

/**
 * The full overlay for one decision.
 *
 * `onSubmit` owns the network call; this component owns the ceremony around it
 * so the request shape and the refusal semantics are testable without a server.
 */
export function WorkflowPanel({
  decisionKey,
  servedIds,
  record,
  events,
  loadState,
  posture,
  onSubmit,
  onRefresh,
  newMutationId,
  initialConflict,
}: {
  decisionKey: string;
  servedIds: readonly string[];
  record: WorkflowRecord | null;
  events: readonly WorkflowEvent[];
  loadState: WorkflowLoadState;
  posture: WorkflowPosture;
  onSubmit: (submit: WorkflowSubmit) => Promise<WorkflowSubmitResult>;
  onRefresh?: () => void;
  /** Injected so a test can assert one id per attempt across retries. */
  newMutationId: () => string;
  /** A conflict the caller already knows about, e.g. a resumed attempt. */
  initialConflict?: WorkflowConflict | null;
}) {
  const copy = useCopy();
  const [openAction, setOpenAction] = useState<CanonicalWorkflowAction | null>(null);
  const [assigneeUserId, setAssignee] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [snoozeUntil, setSnooze] = useState("");
  const [reasonCode, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WorkflowConflict | null>(initialConflict ?? null);
  const [announcement, setAnnouncement] = useState("");
  const menuRef = useRef<Record<string, HTMLButtonElement | null>>({});
  // One id per attempt: a retry of the same attempt must be a replay, so it is
  // NOT regenerated when the request is sent again.
  const attemptId = useRef<string | null>(null);
  const historyId = useId();

  const refusal = servedRefusal({ decisionKey, servedIds });
  const transitions = useMemo(
    () => (record ? availableTransitions({ record, posture }) : []),
    [record, posture],
  );

  const mountedKey = useRef(decisionKey);
  useEffect(() => {
    // A different decision is a different attempt.
    //
    // Guarded against the mount run: mounting is not a *change* of decision,
    // and clearing here discarded a conflict the caller had already been told
    // about — a resumed attempt opened showing no conflict at all.
    if (mountedKey.current === decisionKey) return;
    mountedKey.current = decisionKey;
    attemptId.current = null;
    setConflict(null);
    setError(null);
  }, [decisionKey]);

  const resetForm = useCallback(() => {
    setAssignee("");
    setDueAt("");
    setSnooze("");
    setReason("");
    setError(null);
  }, []);

  const send = useCallback(
    async (action: CanonicalWorkflowAction, expectedVersion: number) => {
      const missing = missingFields({
        action,
        values: { assigneeUserId, snoozeUntil, reasonCode },
      });
      if (missing.length > 0) {
        setError(`Provide ${missing.join(", ")} before applying ${WORKFLOW_ACTION_LABEL[action]}.`);
        return;
      }
      if (!attemptId.current) attemptId.current = newMutationId();

      setSubmitting(true);
      setAnnouncement(`Applying ${WORKFLOW_ACTION_LABEL[action]}…`);
      const result = await onSubmit({
        action,
        expectedVersion,
        mutationId: attemptId.current,
        assigneeUserId: assigneeUserId.trim() || null,
        dueAt: dueAt.trim() || null,
        snoozeUntil: snoozeUntil.trim() || null,
        reasonCode: reasonCode.trim() || null,
      });
      setSubmitting(false);

      if (result.ok) {
        attemptId.current = null;
        setOpenAction(null);
        setConflict(null);
        resetForm();
        setAnnouncement(
          result.replayed
            ? `${WORKFLOW_ACTION_LABEL[action]} was already recorded. Nothing changed a second time.`
            : `${WORKFLOW_ACTION_LABEL[action]} applied. Workflow is now ${
                WORKFLOW_STATE_LABEL[result.workflow.state]
              }. The decision itself is unchanged.`,
        );
        onRefresh?.();
        return;
      }

      if (result.kind === "conflict") {
        // Keep the dialog closed and surface the disagreement instead: the
        // operator must read what the server now says before choosing again.
        setOpenAction(null);
        setConflict({
          current: result.current,
          attempted: { action, fromVersion: expectedVersion },
          message: result.message,
        });
        setAnnouncement(
          `${WORKFLOW_ACTION_LABEL[action]} was refused: this decision changed while you were looking at it.`,
        );
        return;
      }

      setError(result.message);
      setAnnouncement(`${WORKFLOW_ACTION_LABEL[action]} failed. ${result.message}`);
    },
    [assigneeUserId, dueAt, newMutationId, onRefresh, onSubmit, reasonCode, resetForm, snoozeUntil],
  );

  return (
    <section
      data-workflow-panel={decisionKey}
      aria-label={copy.workflow}
      style={{ display: "grid", gap: 10, marginTop: 4 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{copy.workflow}</h3>
        <WorkflowChip record={record} loadState={loadState} />
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--ledger-ink-tertiary)" }}>
        Workflow records who is handling this decision. It does not change the
        decision, its verdict or what may be done to a provider.
      </p>

      {/* Progress, success and failure all announce here. */}
      <p
        role="status"
        aria-live="polite"
        data-workflow-live=""
        style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-secondary)", minHeight: 16 }}
      >
        {announcement}
      </p>

      {loadState.kind === "error" ? (
        <p data-workflow-error="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {loadState.reason}
        </p>
      ) : null}

      {posture.kind !== "write" ? (
        <p
          data-workflow-posture={posture.kind}
          style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-secondary)" }}
        >
          {posture.reason}
        </p>
      ) : refusal ? (
        <p data-workflow-refusal="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {refusal}
        </p>
      ) : loadState.kind === "ready" && record ? (
        <div data-workflow-menu="" data-el="blocker-chip" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {transitions.length === 0 ? (
            <span data-workflow-menu-empty="" style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
              No workflow transition applies to a decision that is{" "}
              {WORKFLOW_STATE_LABEL[record.state]}.
            </span>
          ) : (
            transitions.map((action) => (
              <Button
                key={action}
                variant="secondary"
                data-workflow-action={action}
                data-ctl="gated:META-WF-02..08 menu"
                ref={(node: HTMLButtonElement | null) => {
                  menuRef.current[action] = node;
                }}
                onClick={() => {
                  resetForm();
                  setOpenAction(action);
                }}
              >
                {WORKFLOW_ACTION_LABEL[action]}
              </Button>
            ))
          )}
        </div>
      ) : null}

      {conflict ? (
        <ConflictPanel
          conflict={conflict}
          submitting={submitting}
          onReapply={send}
          onKeep={() => setConflict(null)}
        />
      ) : null}

      <div>
        <h4 id={historyId} style={{ margin: "4px 0 4px", fontSize: 12, fontWeight: 600 }}>
          {copy.history}
        </h4>
        {loadState.kind === "loading" ? (
          <p data-workflow-history="loading" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            Loading history…
          </p>
        ) : events.length === 0 ? (
          <p data-workflow-history="empty" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {copy.nothingRecordedDecision}
          </p>
        ) : (
          <ul
            aria-labelledby={historyId}
            data-workflow-history="ready"
            style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 4 }}
          >
            {events.map((event) => (
              <li key={`${event.stateVersion}-${event.occurredAt}-${event.event}`} style={{ fontSize: 12 }}>
                <span data-workflow-event="">{describeEvent(event)}</span>{" "}
                <span data-workflow-event-actor="" style={{ color: "var(--ledger-ink-tertiary)" }}>
                  {eventActorLabel(event)} · {event.occurredAt}
                </span>
                {event.reasonCode ? (
                  <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>
                    Reason: {event.reasonCode}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ZeroBaseDialog
        open={openAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            const previous = openAction;
            setOpenAction(null);
            // Focus returns to the control that opened the dialog.
            if (previous) menuRef.current[previous]?.focus();
          }
        }}
        title={openAction ? `${WORKFLOW_ACTION_LABEL[openAction]} this decision` : "Workflow"}
        description="This records who is handling the decision. The decision, its verdict and its lane are unchanged."
        confirmLabel={openAction ? WORKFLOW_ACTION_LABEL[openAction] : "Apply"}
        error={error}
        submitting={submitting}
        onConfirm={() => {
          if (openAction && record) void send(openAction, record.stateVersion);
        }}
      >
        {openAction ? (
          <div style={{ display: "grid", gap: 10 }}>
            {openAction === "assign" ? (
              <TextInput
                label={copy.assigneeUserId}
                data-workflow-field="assigneeUserId"
                value={assigneeUserId}
                onChange={(event) => setAssignee(event.target.value)}
                hint={copy.mustBeActiveMember}
              />
            ) : null}
            {openAction === "snooze" ? (
              <TextInput
                label={copy.wakeUpAt}
                data-workflow-field="snoozeUntil"
                value={snoozeUntil}
                onChange={(event) => setSnooze(event.target.value)}
                hint={copy.snoozeReturns}
              />
            ) : null}
            {openAction === "reject" ? (
              <TextInput
                label={copy.reasonCode}
                data-workflow-field="reasonCode"
                value={reasonCode}
                onChange={(event) => setReason(event.target.value)}
                hint={copy.rejectionCarriesReason}
              />
            ) : null}
            {openAction === "assign" || openAction === "defer" ? (
              <TextInput
                label={copy.dueOptional}
                data-workflow-field="dueAt"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
              />
            ) : null}
          </div>
        ) : null}
      </ZeroBaseDialog>
    </section>
  );
}

/** The 409 surface: what the server says, what was attempted, what may follow. */
function ConflictPanel({
  conflict,
  submitting,
  onReapply,
  onKeep,
}: {
  conflict: WorkflowConflict;
  submitting: boolean;
  onReapply: (action: CanonicalWorkflowAction, expectedVersion: number) => void;
  /** Accepts the current state and abandons the attempt. */
  onKeep?: () => void;
}) {
  const copy = useCopy();
  const plan = reapplyPlan(conflict);
  return (
    <div
      data-workflow-conflict=""
      data-el="conflict-dialog"
      style={{
        display: "grid",
        gap: 6,
        padding: "10px 14px",
        borderRadius: "var(--ledger-radius-card)",
        border: "1px solid var(--ledger-semantic-warn)",
        fontSize: 12,
      }}
    >
      <strong style={{ fontWeight: 600 }}>{conflict.message}</strong>
      <span data-workflow-conflict-current="">
        Now on the server: {WORKFLOW_STATE_LABEL[conflict.current.state]} (version{" "}
        {conflict.current.stateVersion})
      </span>
      <span data-workflow-conflict-attempted="">
        You tried: {WORKFLOW_ACTION_LABEL[conflict.attempted.action]} from version{" "}
        {conflict.attempted.fromVersion}
      </span>
      {plan.allowed ? (
        <div>
          <Button
            variant="secondary"
            data-workflow-reapply=""
            data-ctl="live:META-WF-11 reapply"
            state={submitting ? { kind: "busy", label: "Applying…" } : { kind: "enabled" }}
            onClick={() => onReapply(plan.action, plan.expectedVersion)}
          >
            Re-apply {WORKFLOW_ACTION_LABEL[plan.action]} to version {plan.expectedVersion}
          </Button>
        </div>
      ) : (
        <span data-workflow-reapply-blocked="">{plan.reason}</span>
      )}
      {onKeep ? (
        <div>
          {/* The other half of the resolution. Without it the only way out of a
              conflict is to overwrite, which is not a choice. */}
          <Button variant="quiet" data-workflow-keep="" data-ctl="live:META-WF-11 keep" onClick={onKeep}>
            {copy.keepCurrentState}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
