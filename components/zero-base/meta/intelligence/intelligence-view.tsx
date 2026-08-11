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
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface IntelligenceSource {
  key: string;
  label: string;
  state: ProviderSourceState;
  reason: string | null;
  observedAt: string | null;
  /** Served facts only. A source with none renders none — never a zero. */
  facts?: Array<{ label: string; value: string }>;
}

const STATE_WORD: Record<ProviderSourceState, string> = {
  serving: "Serving",
  partial: "Partial",
  degraded: "Degraded",
  unavailable: "Unavailable",
  // A source that could not be read is not the same as one with nothing to
  // give, and neither is the same as a healthy one.
  unknown: "Unknown",
};

export function IntelligenceView({
  sources,
  unavailableReason,
  window,
}: {
  sources: readonly IntelligenceSource[];
  unavailableReason?: string | null;
  /** The one window every windowed source was scoped to. */
  window?: { startDate: string; endDate: string };
}) {
  const copy = useCopy();
  if (unavailableReason) {
    return (
      <div data-intelligence-surface="">
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>
          {copy.accountIntelligence}
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
        {copy.accountIntelligence}
      </h1>
      {window ? (
        <p data-intelligence-window="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          Every windowed source below covers {window.startDate} to {window.endDate}.
        </p>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <DataTable
          collection="recs"
          caption={copy.intelligenceSources}
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
              id: "facts",
              header: "Evidence",
              render: (row) =>
                row.facts && row.facts.length > 0 ? (
                  <span data-source-facts={row.key}>
                    {row.facts.map((fact) => (
                      <span
                        key={fact.label}
                        data-el="label-chips"
                        style={{ display: "block", fontSize: 12 }}
                      >
                        {fact.label}: {fact.value}
                      </span>
                    ))}
                  </span>
                ) : (
                  // No served facts is stated as such. A zero here would be a
                  // measurement nobody took.
                  <span data-source-facts-none={row.key} style={{ color: "var(--ledger-ink-tertiary)" }}>
                    {copy.nothingServed}
                  </span>
                ),
            },
            {
              id: "observedAt",
              header: "Observed",
              render: (row) =>
                row.observedAt ?? (
                  <span style={{ color: "var(--ledger-ink-tertiary)" }}>{copy.notRecorded}</span>
                ),
            },
          ]}
        />
      </div>
    </div>
  );
}
