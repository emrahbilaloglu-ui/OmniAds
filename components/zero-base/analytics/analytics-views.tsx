"use client";

/**
 * The four analytics leaves (H34–H36 plus the landing-page leaf).
 *
 * Every surface states its sources, and a source that did not answer is named
 * rather than folded into an empty table. At 320 the tables become stacked
 * cards so no column is dropped — a metric missing on mobile is a different
 * surface pretending to be the same one.
 */
import { Button } from "@/components/zero-base/primitives/button";
import { DataTable } from "@/components/zero-base/collections/data-table";
import { UnavailableState } from "@/components/zero-base/states/surface-state";
import {
  GEO_PROXY_DISCLOSURE,
  GEO_TOP_THREE_DISCLOSURE,
  dualSourceState,
  type AdaptedAnalyticsOverview,
  type AdaptedGeo,
  type AdaptedInsight,
  type AdaptedSeo,
  type AnalyticsValue,
  type SeoRoleState,
  type SourcePanel,
} from "@/lib/zero-base/analytics/analytics-contract";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import { useState } from "react";
import Link from "next/link";

export function SourcePanels({ panels, compact = false }: { panels: readonly SourcePanel[]; compact?: boolean }) {
  const copy = useCopy();
  const state = dualSourceState(panels);
  return (
    <section aria-label={copy.sources} style={{ marginTop: compact ? 0 : 8 }}>
      <ul data-source-panels={state.kind} style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: compact ? 8 : 4 }}>
        {panels.map((panel) => (
          <li
            key={panel.kind}
            data-source-panel={panel.kind}
            // A disconnected source is the surface's missing-source state; it
            // is named so the gate can tell it apart from a healthy panel.
            data-el={panel.connected ? undefined : compact ? "source-status-missing" : "source-missing-state"}
            style={{ fontSize: 12, padding: compact ? "2px 8px" : 0, border: compact ? "1px solid var(--ledger-border-subtle)" : 0, borderRadius: compact ? 999 : 0, background: compact ? "var(--ledger-bg-surface)" : "transparent" }}
          >
            <strong style={{ fontWeight: 600 }}>{panel.label}:</strong>{" "}
            {panel.connected ? (
              <span data-source-connected={panel.kind}>{copy.connected}</span>
            ) : (
              <span data-source-down={panel.kind} style={{ color: "var(--ledger-semantic-warn)" }}>
                {panel.error}
              </span>
            )}
          </li>
        ))}
      </ul>
      {state.reason ? (
        <p data-source-degraded="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
          {state.reason}
        </p>
      ) : null}
      {panels.some((panel) => !panel.connected) ? (
        <Link
          href="/app/manage/integrations"
          style={{ display: "inline-flex", alignItems: "center", minHeight: 36, marginTop: 8, color: "var(--ledger-accent-action)", fontSize: 12, fontWeight: 600 }}
        >
          Connect or configure data sources
        </Link>
      ) : null}
    </section>
  );
}

export function Value({ value, name }: { value: AnalyticsValue; name: string }) {
  const copy = useCopy();
  if (!value.available) {
    return (
      <span data-value-unavailable={name} style={{ color: "var(--ledger-ink-tertiary)" }}>
        {copy.notServed}
        <span style={{ display: "block", fontSize: 12 }}>{value.reason}</span>
      </span>
    );
  }
  return (
    <span data-value={name} data-measured-zero={value.measuredZero ? "true" : "false"}>
      {value.display}
    </span>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div data-analytics-surface={title.toLowerCase().replace(/\s+/g, "-")}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: "26px" }}>{title}</h1>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------ GA4/Shopify */

export function SourceOverviewView({
  panels,
  overview,
  insight,
  unavailableReason,
  trend,
}: {
  panels: readonly SourcePanel[];
  /** The adapted `AnalyticsOverviewResponse`. Null when the shape was wrong. */
  overview: AdaptedAnalyticsOverview | null;
  insight: AdaptedInsight;
  unavailableReason?: string | null;
  /** The trend drawn for the chosen source, between the choice and the panels. */
  trend?: React.ReactNode;
}) {
  const copy = useCopy();
  const [cohortView, setCohortView] = useState<"chart" | "table">("chart");
  const preferredKpis = overview
    ? ["sessions", "purchases", "averageOrderValue", "revenue"]
        .map((key) => overview.kpis.find((row) => row.key === key))
        .filter((row): row is AdaptedAnalyticsOverview["kpis"][number] => Boolean(row))
        .concat(overview.kpis.filter((row) => !["sessions", "purchases", "averageOrderValue", "revenue"].includes(row.key)))
        .slice(0, 4)
    : [];
  const trafficSources = overview?.trafficSources ?? [];
  return (
    <div data-analytics-surface="ga4-and-shopify">
      <h1 style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>GA4 and Shopify</h1>
      {trend ? <div style={{ marginTop: 12 }}>{trend}</div> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <p data-ga4-property="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {overview?.propertyName ? `GA4 property: ${overview.propertyName}` : "GA4 property name not served."}
        </p>
        <SourcePanels panels={panels} compact />
      </div>
      {unavailableReason || !overview ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason ?? "The analytics overview could not be read."} />
        </div>
      ) : (
        <>
          <section data-analytics-kpis="" aria-label={copy.ga4Kpis} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
            {preferredKpis.map((row) => (
              <article key={row.key} style={{ minHeight: 86, padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)", textTransform: "capitalize" }}>{row.key.replaceAll(/([A-Z])/g, " $1")}</p>
                <strong style={{ display: "block", marginTop: 5, fontFamily: "var(--font-adc-mono), monospace", fontSize: 18 }}><Value value={row.value} name={row.key} /></strong>
                <span style={{ display: "block", marginTop: 3, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>GA4 · served for this window</span>
              </article>
            ))}
          </section>

          <div data-analytics-overview-grid="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(260px, 1fr)", gap: 12, marginTop: 12, alignItems: "start" }}>
            <section aria-label={trafficSources.length > 0 ? copy.trafficSources : copy.newVsReturning} style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{trafficSources.length > 0 ? copy.trafficSources : copy.newVsReturning}</h2>
                {!trend ? (
                  <Button
                    variant="quiet"
                    data-ctl="live:chart-table-toggle"
                    aria-label={cohortView === "chart" ? "View audience cohorts as table" : "View audience cohorts as chart"}
                    onClick={() => setCohortView((current) => current === "chart" ? "table" : "chart")}
                  >
                    {cohortView === "chart" ? "Table" : "Chart"}
                  </Button>
                ) : null}
              </div>
              {trafficSources.length > 0 && cohortView === "chart" ? (
                <div role="img" aria-label={copy.trafficSources} style={{ display: "grid", gap: 10, marginTop: 12 }}>
                  {trafficSources.slice(0, 8).map((row) => {
                    const max = Math.max(...trafficSources.map((item) => item.sessions.available ? item.sessions.raw : 0), 1);
                    return (
                      <div key={row.name} style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) 72px", alignItems: "center", gap: 10, fontSize: 12 }}>
                        <span>{row.name}</span>
                        <span aria-hidden="true" style={{ display: "block", height: 14, borderRadius: 4, background: "var(--ledger-bg-inset)", overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", width: `${row.sessions.available ? Math.max(4, row.sessions.raw / max * 100) : 0}%`, background: "var(--ledger-accent-action)" }} />
                        </span>
                        <span style={{ textAlign: "right", fontFamily: "var(--font-adc-mono), monospace" }}><Value value={row.sessions} name={`${row.name}-sessions`} /></span>
                      </div>
                    );
                  })}
                  <span data-collection="traffic" data-cst="complete" style={{ paddingTop: 4, fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
                    Showing {trafficSources.length} of {trafficSources.length} served sources · complete
                  </span>
                </div>
              ) : !trend && cohortView === "chart" ? (
                <div role="img" aria-label={copy.audienceSessionComparison} style={{ display: "grid", gap: 12, marginTop: 14 }}>
                  {overview.cohorts.map((row) => {
                    const max = Math.max(...overview.cohorts.map((item) => item.sessions.available ? item.sessions.raw : 0), 1);
                    return (
                      <div key={row.key} style={{ display: "grid", gridTemplateColumns: "88px minmax(0,1fr) 72px", alignItems: "center", gap: 10, fontSize: 12 }}>
                        <span style={{ textTransform: "capitalize" }}>{row.key}</span>
                        <span aria-hidden="true" style={{ display: "block", height: 14, borderRadius: 4, background: "var(--ledger-bg-inset)", overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", width: `${row.sessions.available ? Math.max(4, row.sessions.raw / max * 100) : 0}%`, background: "var(--ledger-accent-action)" }} />
                        </span>
                        <span style={{ textAlign: "right", fontFamily: "var(--font-adc-mono), monospace" }}><Value value={row.sessions} name={`${row.key}-sessions`} /></span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                trafficSources.length > 0 ? (
                  <DataTable
                    collection="traffic"
                    caption={copy.trafficSources}
                    rows={[...trafficSources]}
                    rowKey={(row) => row.name}
                    columns={[
                      { id: "name", header: "Source", render: (row) => row.name },
                      { id: "sessions", header: "Sessions", numeric: true, render: (row) => <Value value={row.sessions} name={`${row.name}-sessions-table`} /> },
                    ]}
                  />
                ) : (
                  <DataTable
                    collection="traffic"
                    caption={copy.audienceCohorts}
                    rows={[...overview.cohorts]}
                    rowKey={(row) => row.key}
                    columns={[
                      { id: "key", header: "Cohort", render: (row) => row.key },
                      { id: "sessions", header: "Sessions", numeric: true, render: (row) => <Value value={row.sessions} name={`${row.key}-sessions`} /> },
                      { id: "purchases", header: "Purchases", numeric: true, render: (row) => <Value value={row.purchases} name={`${row.key}-purchases`} /> },
                      { id: "purchaseCvr", header: "Purchase CVR", numeric: true, render: (row) => <Value value={row.purchaseCvr} name={`${row.key}-cvr`} /> },
                    ]}
                  />
                )
              )}
            </section>
            <section aria-label={copy.latestAiInsight} style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{copy.aiInsights} <span style={{ display: "inline-flex", marginLeft: 5, padding: "2px 7px", border: "1px solid var(--ledger-accent-action)", borderRadius: 999, background: "var(--ledger-accent-tint)", fontFamily: "var(--font-adc-mono), monospace", fontSize: 12, color: "var(--ledger-accent-action)" }}>{copy.readLatestOnly}</span></h2>
              {insight.absentReason ? (
                <p data-insight="absent" data-el="lp-ai-commentary" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{insight.absentReason}</p>
              ) : (
                <p data-insight="present" data-el="lp-ai-commentary" style={{ margin: "8px 0 0", fontSize: 13 }}>{insight.text}</p>
              )}
              {overview.insights.length > 0 ? <ul data-ga4-insights="" style={{ margin: "10px 0 0", paddingLeft: 18 }}>{overview.insights.map((text) => <li key={text} style={{ fontSize: 12 }}>{text}</li>)}</ul> : null}
              <p data-insight-read-only="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.readsLatestInsight}</p>
              <div data-el="source-missing-state" style={{ marginTop: 8, padding: "8px 10px", border: "1px dashed var(--ledger-border-control)", borderRadius: 8, fontSize: 12, lineHeight: "18px", color: "var(--ledger-ink-tertiary)" }}>
                {copy.aiGenerationUnavailable}
              </div>
            </section>
          </div>
        </>
      )}
      <style>{`@media(max-width:900px){[data-analytics-kpis]{grid-template-columns:repeat(2,minmax(140px,1fr))!important}[data-analytics-overview-grid]{grid-template-columns:1fr!important}} @media(max-width:520px){[data-analytics-kpis]{grid-template-columns:1fr!important}}`}</style>
    </div>
  );
}

/* --------------------------------------------------- landing pages/products */

export function AnalyticsTableView({
  title,
  panels,
  rows,
  columns,
  capText,
  insight,
  unavailableReason,
}: {
  title: string;
  panels: readonly SourcePanel[];
  rows: readonly { id: string; cells: Record<string, AnalyticsValue | string> }[];
  columns: readonly { id: string; header: string; numeric?: boolean }[];
  capText: string;
  /** Served commentary. Absent means none was generated; never invented here. */
  insight?: { text: string | null; absentReason: string | null } | null;
  unavailableReason?: string | null;
}) {
  return (
    <Shell title={title}>
      <SourcePanels panels={panels} />
      {unavailableReason ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason} />
        </div>
      ) : (
        <>
          <p data-cap-text="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {capText}
          </p>
          {insight ? (
            <p
              data-el="lp-ai-commentary"
              style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}
            >
              {/* Read-only: this surface shows commentary, it never writes it. */}
              {insight.text ?? insight.absentReason}
            </p>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <DataTable
              collection="landing-pages"
              caption={title}
              rows={[...rows]}
              rowKey={(row) => row.id}
              columns={columns.map((column) => ({
                id: column.id,
                header: column.header,
                numeric: column.numeric,
                render: (row: { cells: Record<string, AnalyticsValue | string> }) => {
                  const cell = row.cells[column.id];
                  if (typeof cell === "string") return cell;
                  return cell ? <Value value={cell} name={column.id} /> : "—";
                },
              }))}
            />
          </div>
        </>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------- SEO */

function SeoList({ id, title, items }: { id: string; title: string; items: readonly { id: string; label: string }[] }) {
  if (items.length === 0) {
    return (
      <p data-seo-empty={id} style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
        {title}: nothing was served for this window.
      </p>
    );
  }
  return (
    <section aria-label={title} style={{ marginTop: 12 }}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
      <ul data-seo-list={id} style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {items.map((item) => (
          <li key={item.id} data-seo-item={id} style={{ fontSize: 12 }}>
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SeoView({
  panels,
  role,
  seo,
  onRunAnalysis,
  onLoadMore,
  unavailableReason,
}: {
  panels: readonly SourcePanel[];
  role: SeoRoleState;
  /** The adapted `SeoOverviewPayload`. Null when the shape was wrong. */
  seo: AdaptedSeo | null;
  /** Absent where the actor cannot run one; the gate states why. */
  onRunAnalysis?: () => void;
  onLoadMore?: () => void;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  return (
    <Shell title="SEO">
      <SourcePanels panels={panels} />
      {role.allowed ? null : (
        <p data-seo-role-blocked="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-secondary)" }}>
          {role.reason}
        </p>
      )}
      {unavailableReason || !seo ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason ?? "The SEO overview could not be read."} />
        </div>
      ) : (
        <>
          <p data-seo-meta="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {seo.siteUrl ?? "Site not served"}
            {seo.rowCount === null ? "" : ` · ${seo.rowCount} rows in window`}
          </p>

          <div data-seo-layout="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(280px, 2fr)", gap: 12, marginTop: 12, alignItems: "start" }}>
          <div style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{copy.seoFindings}</h2>
          <div data-collection="seo" style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {[
              ...seo.recommendations.map((item) => ({ ...item, severity: "HIGH" })),
              ...seo.causes.map((item) => ({ ...item, severity: "MED" })),
              ...seo.decliningQueries.map((item) => ({ ...item, severity: "LOW" })),
            ].slice(0, 3).map((item) => (
              <article key={`${item.severity}-${item.id}`} style={{ display: "grid", gridTemplateColumns: "48px minmax(0,1fr)", gap: 10, alignItems: "start", padding: 10, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-app)", fontSize: 12 }}>
                <strong style={{ color: item.severity === "HIGH" ? "var(--ledger-semantic-danger)" : item.severity === "MED" ? "var(--ledger-semantic-warn)" : "var(--ledger-accent-action)" }}>{item.severity}</strong>
                <span>{item.label}</span>
              </article>
            ))}
          {onLoadMore ? (
            <Button variant="quiet" data-ctl="live:SEO-01 load-more" onClick={onLoadMore}>
              {copy.loadMore}
            </Button>
          ) : null}
          <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--ledger-accent-action)" }}>{copy.searchPerformance}</summary>
          <DataTable
            caption={copy.searchPerformance}
            rows={[...seo.summary]}
            rowKey={(row) => row.key}
            columns={[
              { id: "key", header: "Metric", render: (row) => row.key },
              { id: "current", header: "Current", numeric: true, render: (row) => <Value value={row.current} name={row.key} /> },
              {
                id: "delta",
                header: "Change",
                numeric: true,
                // deltaPercent is nullable in the contract; null renders
                // unavailable rather than a 0% "no change" claim.
                render: (row) => <Value value={row.deltaPercent} name={`${row.key}-delta`} />,
              },
            ]}
          />
          </details>
          </div>
          </div>

          <aside style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
          <div data-el="seo-gen-states" style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", margin: "0 0 12px" }}>
            <strong style={{ fontSize: 13 }}>AI analysis · server-gated</strong>
            <Button
              variant="secondary"
              data-ctl="gated:SEO-04 run"
              state={role.allowed ? { kind: "enabled" } : { kind: "disabled", reason: role.reason }}
              onClick={onRunAnalysis}
            >
              {copy.runAnalysis}
            </Button>
          </div>
          <SeoList id="leaders" title={copy.leadingQueries} items={seo.leaderQueries} />
          <SeoList id="declining" title={copy.decliningQueries} items={seo.decliningQueries} />
          <SeoList id="causes" title={copy.likelyCauses} items={seo.causes} />
          <SeoList id="recommendations" title={copy.recommendations} items={seo.recommendations} />

          {seo.aiBriefHeadline ? (
            <p data-seo-ai-brief="" data-el="seo-gen-states" style={{ margin: "12px 0 0", padding: 10, borderRadius: 7, background: "var(--ledger-accent-tint)", fontSize: 12 }}>
              {seo.aiBriefHeadline}
              <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                {copy.servedBriefReadOnly}
              </span>
            </p>
          ) : null}
          </aside>
          </div>
          <style>{`@media(max-width:860px){[data-seo-layout]{grid-template-columns:1fr!important}}`}</style>
        </>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------- GEO */

export function GeoView({ geo, unavailableReason }: { geo: AdaptedGeo | null; unavailableReason?: string | null }) {
  const copy = useCopy();
  if (!geo || unavailableReason) {
    return (
      <Shell title="GEO">
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason ?? "GEO could not be composed."} />
        </div>
      </Shell>
    );
  }
  return (
    <Shell title="GEO">
      <SourcePanels panels={geo.sources} />

      <section data-geo-kpis="" aria-label={copy.geoSummary} style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
        <article style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
          <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.aiCitedPages}</span>
          <strong style={{ display: "block", marginTop: 4, font: "700 18px/1.25 var(--font-mono, monospace)" }}><Value value={geo.aiPageCount} name="aiPageCountSummary" /></strong>
        </article>
        <article style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
          <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.sourcesServing}</span>
          <strong style={{ display: "block", marginTop: 4, font: "700 18px/1.25 var(--font-mono, monospace)" }}>{geo.sources.filter((source) => source.connected).length} / {geo.sources.length}</strong>
        </article>
        <article style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
          <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>{copy.prioritiesServed}</span>
          <strong style={{ display: "block", marginTop: 4, font: "700 18px/1.25 var(--font-mono, monospace)" }}>{geo.priorities.length}</strong>
        </article>
      </section>

      <div data-geo-layout="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(280px, 2fr)", gap: 12, marginTop: 12, alignItems: "start" }}>
      <section aria-label={copy.aiPageReach} data-el="geo-gated" style={{ padding: 12, border: "1px solid var(--ledger-border-subtle)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.aiVisitedPages}</h2>
        <p style={{ margin: "4px 0 0", fontSize: 13 }}>
          <Value value={geo.aiPageCount} name="aiPageCount" />
        </p>
        {/* Always shown: the number is a capped proxy whether or not it is at
            the ceiling, and printing it bare reports a ceiling as a count. */}
        <p data-geo-proxy-disclosure="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {GEO_PROXY_DISCLOSURE}
        </p>
        {geo.atProxyCap ? (
          <p data-geo-at-cap="" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ledger-semantic-warn)" }}>
            {copy.valueAtCap}
          </p>
        ) : null}
      </section>

      <section aria-label={copy.priorities} style={{ padding: 12, border: "1px solid var(--ledger-semantic-warn)", borderRadius: "var(--ledger-radius-card)", background: "var(--ledger-bg-surface)" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.topPriorities}</h2>
        <ol data-geo-priorities="" data-collection="geo" style={{ margin: "8px 0 0", paddingLeft: 18, minHeight: 24 }}>
          {geo.priorities.length === 0 ? (
            <li style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)", listStyle: "none" }}>
              {copy.noPrioritiesServed}
            </li>
          ) : null}
          {geo.priorities.map((item) => (
            <li key={item.title} data-geo-priority={item.priority} style={{ fontSize: 12 }}>
              {item.title}
              {item.detail ? (
                <span style={{ display: "block", color: "var(--ledger-ink-tertiary)" }}>{item.detail}</span>
              ) : null}
            </li>
          ))}
        </ol>
        <p data-geo-top-three-disclosure="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {GEO_TOP_THREE_DISCLOSURE}
        </p>
      </section>
      </div>
      <style>{`@media(max-width:860px){[data-geo-kpis]{grid-template-columns:1fr!important}[data-geo-layout]{grid-template-columns:1fr!important}}`}</style>
    </Shell>
  );
}
