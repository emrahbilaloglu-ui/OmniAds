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
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function OpsRepairPanel({
  action,
  onRun,
  onRecheck,
  /** Withholds the action entirely, with the reason stated. */
  blockedReason,
  /**
   * Named before the action runs. This is a consequential provider call, so the
   * operator confirms a specific workspace, provider and action rather than a
   * bare "Run".
   */
  confirmation,
}: {
  action: string;
  /** Performs the real PATCH and returns its raw result. */
  onRun: () => Promise<{ httpOk: boolean; status: number | null; body: unknown; transportFailed: boolean }>;
  onRecheck?: () => void;
  blockedReason?: string | null;
  confirmation?: { workspace: string; provider: string };
}) {
  const copy = useCopy();
  const [confirming, setConfirming] = useState(false);
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

  if (blockedReason) {
    return (
      <section data-ops-repair={action} data-el="admin-incident" aria-label={copy.repair} style={{ display: "grid", gap: 8 }}>
        <Button
          variant="secondary"
          data-repair-run={action}
          data-ctl="gated:ADMIN-12 repair"
          state={{ kind: "disabled", reason: blockedReason }}
        >
          Run {action}
        </Button>
        <p data-repair-blocked={action} data-el="admin-receipt-gap" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {blockedReason}
        </p>
      </section>
    );
  }

  return (
    <section data-ops-repair={action} data-el="admin-incident" aria-label={copy.repair} style={{ display: "grid", gap: 8 }}>
      <Button
        variant="secondary"
        data-repair-run={action}
        data-ctl="gated:ADMIN-12 repair"
        state={phase === "running" ? { kind: "busy", label: "Running…" } : { kind: "enabled" }}
        onClick={() => (confirmation ? setConfirming(true) : void run())}
      >
        Run {action}
      </Button>

      {confirming && confirmation ? (
        <div data-repair-confirm={action} role="group" aria-label={copy.confirmRepair} style={{ display: "grid", gap: 6 }}>
          {/* The scope is spelled out: an operator confirming this must be able
              to see which workspace they are about to act on. */}
          <p data-repair-confirm-scope="" style={{ margin: 0, fontSize: 12 }}>
            {copy.run} <strong>{action}</strong> against <strong>{confirmation.provider}</strong> for{" "}
            <strong>{confirmation.workspace}</strong>? This calls the provider.
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              variant="secondary"
              data-repair-confirm-yes={action}
              onClick={() => {
                setConfirming(false);
                void run();
              }}
            >
              {copy.runIt}
            </Button>
            <Button variant="quiet" data-repair-confirm-cancel={action} onClick={() => setConfirming(false)}>
              {copy.cancel}
            </Button>
          </div>
        </div>
      ) : null}

      <p
        role="status"
        aria-live="polite"
        data-repair-progress={phase}
        // Until a receipt comes back there is a gap between "we asked" and "it
        // happened", and the surface says so rather than implying completion.
        // Stated until a receipt actually arrives, not only while running:
        // "we asked" and "it happened" are different facts throughout.
        data-el={outcome ? undefined : "admin-receipt-gap"}
        style={{ margin: 0, fontSize: 12, minHeight: 16 }}
      >
        {phase === "running" ? "The repair is running…" : ""}
      </p>

      {outcome ? (
        <p data-repair-outcome={outcome.kind} style={{ margin: 0, fontSize: 12, color: tone }}>
          {outcome.detail}
        </p>
      ) : null}

      {/* No receipt, ever: nothing here observed the resulting state. */}
      {repairReceiptAvailable() ? null : (
        <p data-repair-no-receipt="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {READ_BACK_GAP_NOTE}
        </p>
      )}

      {outcome ? (
        <div>
          <Button variant="secondary" data-repair-recheck={action} onClick={onRecheck}>
            {copy.reRunHealthCheck}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function CriticalIncidentPath() {
  const copy = useCopy();
  return (
    <section data-incident-path="" aria-label={copy.criticalIncidentPath}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.ifSomethingIsFailing}</h2>
      <ol data-collection="sync" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
        {CRITICAL_INCIDENT_PATH.map((step) => (
          <li key={step.id} data-incident-step={step.id} style={{ fontSize: 12, lineHeight: "18px" }}>
            <strong style={{ fontWeight: 600 }}>{step.label}</strong>
            <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>{step.evidence}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
