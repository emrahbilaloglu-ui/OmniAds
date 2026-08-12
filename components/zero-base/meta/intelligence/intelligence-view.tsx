"use client";

/**
 * Meta Account Intelligence (H17/H18).
 *
 * Composes provider-specific source states. A partial or degraded source is
 * named with its reason rather than folded into a single "some data missing"
 * line, because the remedies differ: a token to reconnect, a window to wait
 * for, an account to reassign.
 */
import { ZeroBaseTabs } from "@/components/zero-base/primitives/tabs";
import { Button } from "@/components/zero-base/primitives/button";
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
  snapshot,
  onRunSnapshot,
  onRespond,
}: {
  sources: readonly IntelligenceSource[];
  unavailableReason?: string | null;
  /** The one window every windowed source was scoped to. */
  window?: { startDate: string; endDate: string };
  /** Absent when the actor cannot queue a run; the control states why. */
  snapshot?: { canRun: boolean; reason: string | null; queued: boolean };
  onRunSnapshot?: () => void;
  onRespond?: (sourceKey: string, response: string) => void;
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

  const summaryFacts = sources.flatMap((source) =>
    (source.facts ?? []).map((fact) => ({ ...fact, source: source.label })),
  ).slice(0, 4);

  return (
    <div data-intelligence-surface="">
      <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{copy.accountIntelligence}</h1>
      {window ? (
        <p data-intelligence-window="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          Every windowed source below covers {window.startDate} to {window.endDate}.
        </p>
      ) : null}
        </div>
      {snapshot ? (
        <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
          <Button
            variant="secondary"
            data-ctl="gated:META-INTEL-09 run-snapshot"
            state={
              snapshot.queued
                ? { kind: "busy", label: copy.queued }
                : snapshot.canRun
                  ? { kind: "enabled" }
                  : { kind: "disabled", reason: snapshot.reason ?? "" }
            }
            onClick={onRunSnapshot}
          >
            {copy.runSnapshot}
          </Button>
          {/* Queued is not done: the run's own progress shows up as a fact in
              the recent-facts list, not as a claim here. */}
          {snapshot.queued ? (
            <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
              {copy.snapshotQueuedNote}
            </p>
          ) : null}
        </div>
      ) : null}
      </div>

      <ZeroBaseTabs
        label={copy.accountIntelligence}
        value="sources"
        onValueChange={() => {}}
        tabs={[
          { id: "sources", label: copy.intelligenceSources, content: null },
          { id: "window", label: copy.evidenceWindow, content: null },
        ]}
      />
      {summaryFacts.length > 0 ? (
        <section aria-label={copy.accountPulse} data-intelligence-pulse="" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10, marginTop: 12 }}>
          {summaryFacts.map((fact, index) => (
            <article key={`${fact.source}-${fact.label}-${index}`} style={{ minHeight: 80, padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
              <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{fact.label}</span>
              <strong style={{ display: "block", marginTop: 5, font: "700 18px/1.25 var(--font-mono, monospace)" }}>{fact.value}</strong>
              <span style={{ display: "block", marginTop: 4, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{fact.source}</span>
            </article>
          ))}
        </section>
      ) : null}
      <div data-intelligence-detail="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(250px, 2fr)", gap: 12, marginTop: 12, alignItems: "start" }}>
        <section data-el="intel-recs" style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Recommendations &amp; source intelligence</h2>
            <span style={{ font: "12px/1.3 var(--font-mono, monospace)", color: "var(--ledger-ink-tertiary)" }}>{sources.length} sources served</span>
          </div>
          <div data-collection="recs" style={{ display: "grid", gap: 0 }}>
            {sources.map((row) => (
              <article key={row.key} style={{ display: "grid", gridTemplateColumns: "minmax(140px,1fr) minmax(0,2fr) auto", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid var(--ledger-bg-inset)", fontSize: 12 }}>
                <strong style={{ fontWeight: 650 }}>{row.label}</strong>
                <span data-source-state={row.key}>
                  <strong style={{ color: row.state === "serving" ? "var(--ledger-semantic-ok)" : row.state === "partial" || row.state === "degraded" ? "var(--ledger-semantic-warn)" : "var(--ledger-ink-secondary)" }}>{STATE_WORD[row.state]}</strong>
                  {row.reason ? <span style={{ display: "block", marginTop: 2, color: "var(--ledger-ink-tertiary)" }}>{row.reason}</span> : null}
                  <span style={{ display: "block", marginTop: 2, color: "var(--ledger-ink-tertiary)" }}>{row.observedAt ?? copy.notRecorded}</span>
                  {(row.facts ?? []).length > 0 ? (
                    <span style={{ display: "block", marginTop: 5, color: "var(--ledger-ink-secondary)" }}>
                      {(row.facts ?? []).map((fact) => `${fact.label}: ${fact.value}`).join(" · ")}
                    </span>
                  ) : (
                    <span data-source-facts-none={row.key} style={{ display: "block", marginTop: 5, color: "var(--ledger-ink-tertiary)" }}>
                      {copy.nothingServed}
                    </span>
                  )}
                </span>
                {onRespond ? (
                  <label style={{ display: "grid", gap: 3, color: "var(--ledger-ink-tertiary)" }}>
                    <span>{copy.recordResponse}</span>
                    <select data-ctl="live:META-INTEL-07 respond" aria-label={`${copy.recordResponse} — ${row.label}`} defaultValue="" onChange={(event) => onRespond(row.key, event.target.value)} style={{ minHeight: 32, padding: "3px 7px" }}>
                      <option value="">—</option>
                      {["acknowledged", "acted", "dismissed"].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                ) : null}
              </article>
            ))}
          </div>
        </section>
        <aside style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{copy.campaignLabels}</h2>
          <div data-el="label-chips" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {summaryFacts.length > 0 ? summaryFacts.map((fact, index) => (
              <span key={`${fact.label}-${index}`} style={{ padding: "4px 8px", borderRadius: 999, background: "var(--ledger-accent-tint)", color: "var(--ledger-accent-action)", fontSize: 12 }}>{fact.label} · {fact.value}</span>
            )) : <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.nothingServed}</span>}
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-tertiary)" }}>{copy.campaignLabelsSemanticOnly}</p>
        </aside>
      </div>
      <style>{`@media(max-width:860px){[data-intelligence-pulse]{grid-template-columns:repeat(2,minmax(130px,1fr))!important}[data-intelligence-detail]{grid-template-columns:1fr!important}}@media(max-width:480px){[data-intelligence-pulse]{grid-template-columns:1fr!important}}`}</style>
    </div>
  );
}
