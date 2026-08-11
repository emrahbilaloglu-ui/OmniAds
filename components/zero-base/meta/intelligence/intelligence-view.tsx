"use client";

/**
 * Meta Account Intelligence (H17/H18).
 *
 * Composes provider-specific source states. A partial or degraded source is
 * named with its reason rather than folded into a single "some data missing"
 * line, because the remedies differ: a token to reconnect, a window to wait
 * for, an account to reassign.
 */
import { DataTable } from "@/components/zero-base/collections/data-table";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import type { ProviderSourceState } from "@/lib/zero-base/meta/automation-posture";

export interface IntelligenceSource {
  key: string;
  label: string;
  state: ProviderSourceState;
  reason: string | null;
  observedAt: string | null;
}

const STATE_WORD: Record<ProviderSourceState, string> = {
  serving: "Serving",
  partial: "Partial",
  degraded: "Degraded",
  unavailable: "Unavailable",
};

export function IntelligenceView({
  sources,
  unavailableReason,
}: {
  sources: readonly IntelligenceSource[];
  unavailableReason?: string | null;
}) {
  if (unavailableReason) {
    return (
      <div data-intelligence-surface="">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
          Account Intelligence
        </h1>
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      </div>
    );
  }

  return (
    <div data-intelligence-surface="">
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
        Account Intelligence
      </h1>
      <div style={{ marginTop: 16 }}>
        <DataTable
          caption="Intelligence sources"
          rows={[...sources]}
          rowKey={(row) => row.key}
          columns={[
            { id: "label", header: "Source", render: (row) => row.label },
            {
              id: "state",
              header: "State",
              render: (row) => (
                <span data-source-state={row.key}>
                  {/* Word first: the colour is reinforcement, not the message. */}
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
              id: "observedAt",
              header: "Observed",
              render: (row) =>
                row.observedAt ?? (
                  <span style={{ color: "var(--ledger-ink-tertiary)" }}>Not recorded</span>
                ),
            },
          ]}
        />
      </div>
    </div>
  );
}
