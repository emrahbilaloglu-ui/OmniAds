"use client";

/**
 * The Ops repair panel.
 *
 * It shows progress while the action runs, reports exactly what the action
 * returned, and never prints a receipt — because the admin endpoint performs no
 * read-back and this work package does not change that. The gap is stated on
 * the surface rather than hidden behind a green tick.
 */
import { useCallback, useState } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import {
  CRITICAL_INCIDENT_PATH,
  READ_BACK_GAP_NOTE,
  interpretRepairResponse,
  repairReceiptAvailable,
  type RepairOutcome,
  type RepairPhase,
} from "@/lib/zero-base/ops/repair-ceremony";

export function OpsRepairPanel({
  action,
  onRun,
  onRecheck,
}: {
  action: string;
  /** Performs the real PATCH and returns its raw result. */
  onRun: () => Promise<{ httpOk: boolean; status: number | null; body: unknown; transportFailed: boolean }>;
  onRecheck?: () => void;
}) {
  const [phase, setPhase] = useState<RepairPhase>("idle");
  const [outcome, setOutcome] = useState<RepairOutcome | null>(null);

  const run = useCallback(async () => {
    setPhase("running");
    setOutcome(null);
    const raw = await onRun();
    setOutcome(interpretRepairResponse(raw));
    setPhase("settled");
  }, [onRun]);

  const tone =
    outcome?.kind === "refused"
      ? "var(--ledger-semantic-danger)"
      : outcome?.kind === "ambiguous"
        ? "var(--ledger-semantic-warn)"
        : "var(--ledger-ink-secondary)";

  return (
    <section data-ops-repair={action} aria-label="Repair" style={{ display: "grid", gap: 8 }}>
      <Button
        variant="secondary"
        data-repair-run={action}
        state={phase === "running" ? { kind: "busy", label: "Running…" } : { kind: "enabled" }}
        onClick={() => void run()}
      >
        Run {action}
      </Button>

      <p role="status" aria-live="polite" data-repair-progress={phase} style={{ margin: 0, fontSize: 12.5, minHeight: 16 }}>
        {phase === "running" ? "The repair is running…" : ""}
      </p>

      {outcome ? (
        <p data-repair-outcome={outcome.kind} style={{ margin: 0, fontSize: 12.5, color: tone }}>
          {outcome.detail}
        </p>
      ) : null}

      {/* No receipt, ever: nothing here observed the resulting state. */}
      {repairReceiptAvailable() ? null : (
        <p data-repair-no-receipt="" style={{ margin: 0, fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
          {READ_BACK_GAP_NOTE}
        </p>
      )}

      {outcome ? (
        <div>
          <Button variant="secondary" data-repair-recheck={action} onClick={onRecheck}>
            Re-run the health check
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function CriticalIncidentPath() {
  return (
    <section data-incident-path="" aria-label="Critical incident path">
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>If something is failing</h2>
      <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
        {CRITICAL_INCIDENT_PATH.map((step) => (
          <li key={step.id} data-incident-step={step.id} style={{ fontSize: 12.5, lineHeight: "18px" }}>
            <strong style={{ fontWeight: 600 }}>{step.label}</strong>
            <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>{step.evidence}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
