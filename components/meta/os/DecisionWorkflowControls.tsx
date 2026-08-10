"use client";

import { useEffect, useState } from "react";
import type { WorkflowAction, WorkflowRecord } from "@/lib/decision-workflow";

/**
 * Who owns this decision, and what they have said about it.
 *
 * Workflow state is deliberately separate from the decision: nothing here
 * changes a label, an authority, or whether a provider action is permitted. It
 * records that a person has taken responsibility, deferred, or disagreed.
 */
const ACTIONS: Array<{ action: WorkflowAction; label: string; needsReason?: boolean }> = [
  { action: "acknowledge", label: "I've got this" },
  { action: "defer", label: "Not this week" },
  { action: "reject", label: "Disagree", needsReason: true },
];

export function DecisionWorkflowControls({
  businessId,
  decisionKey,
  entityType,
  entityId,
  providerAccountId,
  onOwnershipRecorded,
}: {
  businessId: string;
  decisionKey: string;
  entityType: string;
  entityId: string;
  providerAccountId: string | null;
  /**
   * Called with whether ownership was actually recorded.
   *
   * The mobile Tier-0 completion hangs off this rather than off a click,
   * because a click is not a finished task: a mis-tap on the container, or a
   * write that came back a conflict, both used to count as completions.
   */
  onOwnershipRecorded?: (recorded: boolean) => void;
}) {
  const [record, setRecord] = useState<WorkflowRecord | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(
          `/api/meta/decision-workflow?businessId=${encodeURIComponent(businessId)}&decisionKey=${encodeURIComponent(decisionKey)}`,
          { headers: { Accept: "application/json" }, cache: "no-store" },
        );
        const payload = await response.json().catch(() => null);
        if (cancelled || !response.ok) return;
        setRecord((payload as { workflow: WorkflowRecord }).workflow);
        setAvailable((payload as { available: boolean }).available !== false);
      } catch {
        // Leaving state null renders the unavailable notice rather than
        // implying nobody has claimed this decision.
        if (!cancelled) setAvailable(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [businessId, decisionKey]);

  async function apply(action: WorkflowAction) {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/meta/decision-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          decisionKey,
          action,
          expectedVersion: record.stateVersion,
          entityType,
          entityId,
          providerAccountId,
          reasonCode: action === "reject" ? reason.trim() || null : null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        // A conflict is reported as one: the operator reloads rather than
        // discovering later that their change never landed.
        setError(
          (payload as { message?: string } | null)?.message ?? "That change was not recorded.",
        );
        if ((payload as { current?: WorkflowRecord } | null)?.current) {
          setRecord((payload as { current: WorkflowRecord }).current);
        }
        onOwnershipRecorded?.(false);
        return;
      }
      setRecord((payload as { workflow: WorkflowRecord }).workflow);
      setReason("");
      onOwnershipRecorded?.(true);
    } catch {
      setError("That change was not recorded.");
      onOwnershipRecorded?.(false);
    } finally {
      setBusy(false);
    }
  }

  if (!available) {
    return (
      <div data-workflow-state="unavailable">
        <span>Ownership tracking is unavailable, so this decision shows no owner.</span>
      </div>
    );
  }

  if (!record) return null;

  return (
    <div data-workflow-state={record.state}>
      <span>
        <strong>
          {record.state === "open" ? "Unclaimed" : record.state.replace(/_/g, " ")}
        </strong>
        {record.reasonCode ? ` — ${record.reasonCode}` : null}
      </span>

      <div>
        {ACTIONS.map(({ action, label, needsReason }) => (
          <button
            key={action}
            type="button"
            disabled={busy || (needsReason ? reason.trim().length === 0 : false)}
            title={
              needsReason && reason.trim().length === 0
                ? "Disagreeing requires a reason"
                : undefined
            }
            onClick={() => void apply(action)}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (required to disagree)"
        aria-label="Reason for disagreeing with this decision"
      />

      {error ? <span data-workflow-error="true">{error}</span> : null}
    </div>
  );
}
