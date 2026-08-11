"use client";

/**
 * Meta Automation and the Meta stop (H20, Flow I).
 *
 * The stop is Meta-only and business-scoped, and the surface is built so that
 * cannot be misread: Google is drawn as its own row, always, saying it is
 * unaffected. Its absence when Meta is degraded is precisely what would teach
 * an operator that one switch covers both providers.
 *
 * No status banner appears before the read-back. A 200 response is not an
 * observation of state, and an operator told "stopped" who has not been is
 * worse off than one told nothing.
 */
import { useState } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import { DataTable } from "@/components/zero-base/collections/data-table";
import {
  GOOGLE_UNAFFECTED_ROW,
  META_STOP_LABEL,
  META_STOP_SCOPE_NOTE,
  buildGuardrailRows,
  resolveStopCeremony,
  type GuardrailRow,
  type ProviderPosture,
  type StopCeremonyInput,
} from "@/lib/zero-base/meta/automation-posture";

const STATE_WORD: Record<ProviderPosture["state"], string> = {
  serving: "Serving",
  partial: "Partial",
  degraded: "Degraded",
  unavailable: "Unavailable",
};

export function AutomationView({
  postures,
  guardrails,
  ceremony,
  onEngage,
}: {
  postures: readonly ProviderPosture[];
  guardrails: Parameters<typeof buildGuardrailRows>[0];
  ceremony: StopCeremonyInput;
  onEngage?: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const state = resolveStopCeremony(ceremony);
  const rows: GuardrailRow[] = buildGuardrailRows(guardrails);

  return (
    <div data-automation-surface="">
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
        Automation &amp; Meta Stop
      </h1>

      <section aria-label="Provider posture" style={{ marginTop: 16 }}>
        <DataTable
          caption="Provider posture"
          rows={[...postures]}
          rowKey={(row) => row.provider}
          columns={[
            { id: "provider", header: "Provider", render: (row) => row.label },
            {
              id: "state",
              header: "State",
              render: (row) => (
                <span data-provider-state={row.provider}>
                  {STATE_WORD[row.state]}
                  {row.reason ? (
                    <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                      {row.reason}
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              id: "control",
              header: "Automation control",
              render: (row) =>
                row.stoppable ? (
                  <span data-stoppable={row.provider}>Controlled here</span>
                ) : (
                  // No Google stop exists, and inventing one for an authority
                  // we do not own would be worse than having none.
                  <span data-not-stoppable={row.provider} style={{ color: "var(--ledger-ink-tertiary)" }}>
                    Not controlled here
                  </span>
                ),
            },
          ]}
        />
        <p data-google-unaffected="" style={{ fontSize: 12, marginTop: 8, color: "var(--ledger-ink-tertiary)" }}>
          {GOOGLE_UNAFFECTED_ROW}
        </p>
      </section>

      <section aria-label="Meta stop" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: "22px" }}>
          {META_STOP_LABEL}
        </h2>
        <p data-stop-scope="" style={{ fontSize: 12.5, lineHeight: "18px", color: "var(--ledger-ink-secondary)", marginTop: 4 }}>
          {META_STOP_SCOPE_NOTE}
        </p>

        {state.blocker ? (
          <p
            data-stop-blocked={state.blocker.code}
            style={{
              marginTop: 8,
              padding: "10px 14px",
              borderRadius: "var(--ledger-radius-card)",
              border: "1px dashed var(--ledger-border-control)",
              fontSize: 13,
              color: "var(--ledger-ink-secondary)",
            }}
          >
            {state.blocker.message}
          </p>
        ) : (
          <Button
            variant="danger"
            primaryTarget
            data-stop-trigger=""
            onClick={() => setConfirmOpen(true)}
            style={{ marginTop: 8 }}
          >
            {ceremony.intent === "engage" ? "Stop Meta automation" : "Resume Meta automation"}
          </Button>
        )}

        {/* Only ever rendered after a read-back agreed. */}
        {state.showStatusBanner ? (
          <p
            role="status"
            data-stop-status=""
            style={{
              marginTop: 8,
              padding: "10px 14px",
              borderRadius: "var(--ledger-radius-card)",
              border: "1px solid var(--ledger-semantic-ok)",
              fontSize: 13,
              color: "var(--ledger-semantic-ok)",
            }}
          >
            {state.statusMessage}
          </p>
        ) : state.statusMessage ? (
          <p
            role="status"
            data-stop-unconfirmed=""
            style={{
              marginTop: 8,
              padding: "10px 14px",
              borderRadius: "var(--ledger-radius-card)",
              border: "1px solid var(--ledger-semantic-warn)",
              fontSize: 13,
              color: "var(--ledger-semantic-warn)",
            }}
          >
            {state.statusMessage}
          </p>
        ) : null}
      </section>

      <section aria-label="Guardrails" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: "22px" }}>
          Guardrails
        </h2>
        <p style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)", margin: "4px 0 8px" }}>
          Enforced by the engine. Shown here for reference; they are not editable from this surface.
        </p>
        <DataTable
          caption="Automation guardrails"
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            { id: "id", header: "Rule", render: (row) => row.id },
            { id: "label", header: "Guardrail", render: (row) => row.label },
            {
              id: "value",
              header: "Value",
              numeric: true,
              render: (row) => <span data-guardrail-value={row.id}>{row.value}</span>,
            },
          ]}
        />
      </section>

      <ZeroBaseDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={ceremony.intent === "engage" ? "Stop Meta automation?" : "Resume Meta automation?"}
        description={META_STOP_SCOPE_NOTE}
        confirmLabel={ceremony.intent === "engage" ? "Stop Meta automation" : "Resume"}
        destructive={ceremony.intent === "engage"}
        confirmPhrase={ceremony.intent === "engage" ? "STOP META" : "RESUME META"}
        onConfirm={() => {
          setConfirmOpen(false);
          onEngage?.();
        }}
      />
    </div>
  );
}
