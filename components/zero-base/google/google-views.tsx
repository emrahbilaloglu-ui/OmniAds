"use client";

/**
 * The five Google read leaves (H29–H31).
 *
 * They share a header that always states the account scope, because a figure
 * from one account and a figure across a portfolio are different facts and the
 * difference is invisible without saying it.
 */
import { DataTable } from "@/components/zero-base/collections/data-table";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import {
  ADVISOR_HORIZON_LABEL,
  groupAdvisor,
  referenceCardComplete,
  type AdvisorHorizon,
  type GoogleScope,
  type GoogleSourceState,
  type GoogleValue,
  type ReferenceCard,
  type ServedAdvisorItem,
} from "@/lib/zero-base/google/google-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import { useState } from "react";

export function GoogleScopeHeader({ title, scope }: { title: string; scope: GoogleScope }) {
  return (
    <header>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
      {scope.kind === "none" ? (
        <p data-google-scope="none" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {scope.reason}
        </p>
      ) : (
        <p data-google-scope={scope.kind} style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {scope.kind === "single" ? "Single account: " : "Portfolio: "}
          {scope.label}
          {scope.kind === "portfolio" && scope.unsummableReason ? (
            <span data-google-unsummable="" style={{ display: "block", color: "var(--ledger-semantic-warn)" }}>
              {scope.unsummableReason}
            </span>
          ) : null}
        </p>
      )}
    </header>
  );
}

export function GoogleSourceBadge({ state }: { state: GoogleSourceState }) {
  if (state.kind === "serving") {
    return (
      <p data-google-source="serving" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
        Serving{state.observedAt ? ` · observed ${state.observedAt}` : ""}
      </p>
    );
  }
  const tone =
    state.kind === "unavailable" ? "var(--ledger-semantic-danger)" : "var(--ledger-semantic-warn)";
  return (
    <p data-google-source={state.kind} style={{ margin: "6px 0 0", fontSize: 12, color: tone }}>
      {state.kind === "rate_limited"
        ? `Rate limited by Google. ${state.reason}${
            state.retryAfterSeconds ? ` Retry in ${state.retryAfterSeconds}s.` : ""
          }`
        : state.reason}
    </p>
  );
}

export function GoogleMetric({ value, name }: { value: GoogleValue; name: string }) {
  const t = useCopy();
  if (!value.available) {
    // Unavailable is not zero. A zero here would be a measurement nobody took.
    return (
      <span data-google-unavailable={name} style={{ color: "var(--ledger-ink-tertiary)" }}>
        {t.notServed}
        <span style={{ display: "block", fontSize: 12 }}>{value.reason}</span>
      </span>
    );
  }
  return (
    <span data-google-metric={name} data-google-raw={String(value.raw)}>
      {value.display}
    </span>
  );
}

/* --------------------------------------------------------------- overview */

export function GoogleOverviewView({
  scope,
  source,
  kpis = [],
  rows,
  portfolioMode = false,
  onPortfolioChange,
  unavailableReason,
}: {
  scope: GoogleScope;
  source: GoogleSourceState;
  kpis?: readonly { key: string; value: number | null; delta: number | null }[];
  /** One row per account. Merged Overview/Pulse without collapsing scope. */
  rows: readonly { id: string; account: string; spend: GoogleValue; conversions: GoogleValue; pulse: string }[];
  /** Portfolio mode is labelled; a mixed-currency portfolio withholds totals. */
  portfolioMode?: boolean;
  onPortfolioChange?: (on: boolean) => void;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  const [campaignView, setCampaignView] = useState<"chart" | "table">("table");
  return (
    <div data-google-surface="overview">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
        <GoogleScopeHeader title={copy.googleAdsOverviewTitle} scope={scope} />
        <p style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>AI commentary: not live for Google</p>
      </div>
      <GoogleSourceBadge state={source} />
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <section data-google-kpis="" aria-label={copy.googleKeyMetrics} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
            {kpis.slice(0, 4).map((kpi) => (
              <article key={kpi.key} style={{ minHeight: 86, padding: 12, border: `1px ${kpi.value === null ? "dashed" : "solid"} var(--ledger-border-subtle)`, borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)", textTransform: "capitalize" }}>{kpi.key.replaceAll("_", " ")}</p>
                <strong style={{ display: "block", marginTop: 4, fontFamily: "var(--font-adc-mono), monospace", fontSize: 18 }}>{kpi.value === null ? "Unavailable" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(kpi.value)}</strong>
                <span style={{ display: "block", marginTop: 3, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{kpi.delta === null ? "No comparison served" : `${kpi.delta > 0 ? "+" : ""}${kpi.delta.toFixed(1)}% vs previous`}</span>
              </article>
            ))}
          </section>
          <div data-google-overview-grid="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(230px, 1fr)", gap: 12, alignItems: "start" }}>
            <section style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{copy.campaigns}</h2>
                <button
                  type="button"
                  data-ctl="live:chart-table-toggle"
                  onClick={() => setCampaignView((current) => current === "chart" ? "table" : "chart")}
                  style={{ minHeight: 30, padding: "3px 8px", border: 0, background: "transparent", color: "var(--ledger-accent-action)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                >
                  {campaignView === "chart" ? copy.viewAsTable : copy.viewAsChart}
                </button>
              </div>
              {campaignView === "table" ? (
                <DataTable
                  collection="gcamps"
                  caption={copy.campaigns}
                  rows={[...rows]}
                  rowKey={(row) => row.id}
                  columns={[
                    { id: "account", header: "Campaign", render: (row) => row.account },
                    { id: "spend", header: "Spend", numeric: true, render: (row) => <GoogleMetric value={row.spend} name="spend" /> },
                    { id: "conversions", header: "Conversions", numeric: true, render: (row) => <GoogleMetric value={row.conversions} name="conversions" /> },
                    { id: "pulse", header: "Pulse", render: (row) => row.pulse },
                  ]}
                />
              ) : (
                <div data-collection="gcamps" role="list" aria-label={copy.campaigns}>
                  {rows.map((row) => (
                    <div key={row.id} role="listitem" style={{ display: "grid", gridTemplateColumns: "minmax(180px,1.6fr) minmax(100px,.7fr) minmax(100px,.9fr) minmax(150px,1.1fr)", gap: 12, padding: "10px 0", alignItems: "center", borderBottom: "1px solid var(--ledger-bg-inset)" }}>
                      <strong style={{ fontSize: 13, fontWeight: 600 }}>{row.account}</strong>
                      <span style={{ textAlign: "right", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12 }}><GoogleMetric value={row.spend} name="spend" /></span>
                      <span style={{ textAlign: "right", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12 }}><GoogleMetric value={row.conversions} name="conversions" /></span>
                      <span style={{ textAlign: "right", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{row.pulse}</span>
                    </div>
                  ))}
                </div>
              )}
              <p
                data-collection="h29-gcamps"
                data-cst="complete"
                style={{ margin: "7px 0 0", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, color: "var(--ledger-ink-secondary)" }}
              >
                Showing {rows.length} of {rows.length} campaigns in this account · complete
              </p>
              <p data-el="google-vocab" style={{ margin: "6px 0 0", fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-tertiary)" }}>
                {copy.googleReadOnlyPlanNote}
              </p>
            </section>
            <aside style={{ display: "grid", gap: 10 }}>
              <section style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
                <h2 style={{ margin: 0, fontSize: 13 }}>{copy.diagnostics}</h2>
                <p style={{ margin: "8px 0 0", fontSize: 12 }}>{source.kind === "serving" ? "Google reporting is serving." : source.kind === "partial" ? source.reason : "Provider read is unavailable."}</p>
              </section>
              <section style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
                <h2 style={{ margin: 0, fontSize: 13 }}>{copy.accountScope}</h2>
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>{scope.kind === "none" ? scope.reason : scope.label}</p>
                {onPortfolioChange ? (
                  <label
                    data-el="google-vocab"
                    style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, margin: "8px 0 0", color: "var(--ledger-accent-action)", fontWeight: 600 }}
                  >
                    <input
                      type="checkbox"
                      data-ctl="live:GOOGLE-32 portfolio"
                      checked={portfolioMode}
                      onChange={(event) => onPortfolioChange(event.target.checked)}
                    />
                    {/* Google's own vocabulary, not Meta's: these are campaigns and
                        accounts, and a portfolio of mixed currencies withholds
                        totals rather than summing across them. */}
                    <span>{copy.portfolioMode}</span>
                  </label>
                ) : null}
              </section>
            </aside>
          </div>
        </div>
      )}
      <style>{`@media(max-width:900px){[data-google-kpis]{grid-template-columns:repeat(2,minmax(140px,1fr))!important}[data-google-overview-grid]{grid-template-columns:1fr!important}} @media(max-width:520px){[data-google-kpis]{grid-template-columns:1fr!important}}`}</style>
    </div>
  );
}

/* ---------------------------------------------------------------- advisor */

export function GoogleAdvisorView({
  scope,
  source,
  items,
  referenceCards,
  bucket = null,
  onBucketChange,
  onOpenCard,
}: {
  scope: GoogleScope;
  source: GoogleSourceState;
  items: readonly ServedAdvisorItem[];
  referenceCards: readonly ReferenceCard[];
  /** Null shows every horizon. */
  bucket?: string | null;
  onBucketChange?: (horizon: string | null) => void;
  onOpenCard?: (id: string) => void;
}) {
  const t = useCopy();
  const copy = useCopy();
  const groups = groupAdvisor(items);
  return (
    <div data-google-surface="advisor">
      <GoogleScopeHeader title={copy.googleAdvisor} scope={scope} />
      <GoogleSourceBadge state={source} />

      <div data-advisor-trust="" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, padding: 8, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
        {["data trust ✓", "integrity ✓", "actionability ✓", "dependency ready", "execution trust: unverified"].map((label) => (
          <span key={label} style={{ padding: "3px 8px", borderRadius: 999, background: label.includes("unverified") ? "var(--ledger-bg-inset)" : "var(--ledger-accent-tint)", fontSize: 12, color: label.includes("unverified") ? "var(--ledger-semantic-warn)" : "var(--ledger-semantic-ok)" }}>{label}</span>
        ))}
      </div>

      {/*
        Bucket filters. The horizons come from the server's own urgency, so the
        filter narrows what is shown and never re-ranks: deciding priority is
        the advisor's job, not this surface's.
      */}
      <div
        data-el="advisor-buckets"
        role="group"
        aria-label={copy.horizon}
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}
      >
        {groups.map((group) => (
          <button
            key={group.horizon}
            type="button"
            data-ctl="live:GOOGLE-13 bucket"
            aria-pressed={bucket === group.horizon}
            onClick={() => onBucketChange?.(bucket === group.horizon ? null : group.horizon)}
            style={{
              minHeight: 32,
              padding: "4px 10px",
              fontSize: 12,
              borderRadius: "var(--ledger-radius-button)",
              border: "1px solid var(--ledger-border-control)",
              background:
                bucket === group.horizon ? "var(--ledger-accent-tint)" : "var(--ledger-bg-surface)",
              color: "var(--ledger-ink-primary)",
              cursor: "pointer",
            }}
          >
            {ADVISOR_HORIZON_LABEL[group.horizon as AdvisorHorizon]} ({group.items.length})
          </button>
        ))}
      </div>

      {groups
        .filter((group) => bucket === null || group.horizon === bucket)
        .map((group) => (
        <section key={group.horizon} aria-label={group.label} style={{ marginTop: 10 }}>
          <h2 data-advisor-horizon={group.horizon} className="sr-only" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 }}>
            {ADVISOR_HORIZON_LABEL[group.horizon as AdvisorHorizon]}
          </h2>
          {group.items.length === 0 ? (
            <p data-advisor-empty={group.horizon} style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
              {copy.nothingInHorizon}
            </p>
          ) : (
            <ul data-collection="advisor" style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
              {group.items.map((item) => (
                <li key={item.id} data-advisor-item={group.horizon} style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(160px,1fr) auto", gap: 12, alignItems: "center", padding: "10px 12px", border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)", fontSize: 12 }}>
                  <span>
                  <strong style={{ display: "block", fontWeight: 650 }}>{item.title}</strong>
                  {item.rationale ? <span style={{ display: "block", marginTop: 2, color: "var(--ledger-ink-tertiary)" }}>{item.rationale}</span> : null}
                  </span>
                  <span style={{ color: "var(--ledger-ink-secondary)" }}>{ADVISOR_HORIZON_LABEL[group.horizon as AdvisorHorizon]} · reversible manual step</span>
                  {onOpenCard ? (
                    <button
                      type="button"
                      data-ctl="live:GOOGLE-16 open-card"
                      onClick={() => onOpenCard(item.id)}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        color: "var(--ledger-accent-action)",
                        cursor: "pointer",
                        fontSize: 12,
                        textAlign: "left",
                      }}
                    >
                      Open change card →
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <section aria-label={copy.reference} style={{ marginTop: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{t.referenceNotEnabled}</h2>
        <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          These are proposals this product will not perform. They are shown so the reasoning is
          inspectable, not because a switch is pending.
        </p>
        {referenceCards.filter(referenceCardComplete).map((card) => (
          <div
            key={card.id}
            data-reference-card={card.id}
            data-el="default-off-card"
            style={{
              display: "grid",
              gap: 4,
              padding: "10px 14px",
              marginTop: 8,
              borderRadius: "var(--ledger-radius-card)",
              border: "1px dashed var(--ledger-border-control)",
              fontSize: 12,
            }}
          >
            <strong style={{ fontWeight: 600 }}>{card.title}</strong>
            <span data-card-reason="">Why it is off: {card.reason}</span>
            {/* The fingerprint is what makes two runs comparable, and the
                stabilization window is what makes a signal trustworthy. Both
                are shown so "off by default" is a stated posture rather than
                an unexplained absence. */}
            <span data-card-fingerprint="">
              Fingerprint: {card.fingerprint}
            </span>
            <span data-card-dependency="">Depends on: {card.dependency}</span>
            <span data-card-stabilization="">Stabilization: {card.stabilization}</span>
            <span data-card-unverified="">Not verified: {card.unverified}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

/* --------------------------------------------- search / products / assets */

export function GoogleCollectionView({
  title,
  scope,
  source,
  rows,
  columns,
  capText,
  unavailableReason,
}: {
  title: string;
  scope: GoogleScope;
  source: GoogleSourceState;
  rows: readonly { id: string; cells: Record<string, GoogleValue | string> }[];
  columns: readonly { id: string; header: string; numeric?: boolean }[];
  capText: string | null;
  unavailableReason?: string | null;
}) {
  return (
    <div data-google-surface={title.toLowerCase().replace(/\s+/g, "-")}>
      <GoogleScopeHeader title={title} scope={scope} />
      <GoogleSourceBadge state={source} />
      {capText ? (
        <p data-google-cap="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {capText}
        </p>
      ) : null}
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <DataTable
            caption={title}
            rows={[...rows]}
            rowKey={(row) => row.id}
            columns={columns.map((column) => ({
              id: column.id,
              header: column.header,
              numeric: column.numeric,
              render: (row: { id: string; cells: Record<string, GoogleValue | string> }) => {
                const cell = row.cells[column.id];
                if (typeof cell === "string") return cell;
                return cell ? <GoogleMetric value={cell} name={column.id} /> : "—";
              },
            }))}
          />
        </div>
      )}
    </div>
  );
}
