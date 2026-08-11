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

export function SourcePanels({ panels }: { panels: readonly SourcePanel[] }) {
  const copy = useCopy();
  const state = dualSourceState(panels);
  return (
    <section aria-label={copy.sources} style={{ marginTop: 8 }}>
      <ul data-source-panels={state.kind} style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
        {panels.map((panel) => (
          <li
            key={panel.kind}
            data-source-panel={panel.kind}
            // A disconnected source is the surface's missing-source state; it
            // is named so the gate can tell it apart from a healthy panel.
            data-el={panel.connected ? undefined : "source-missing-state"}
            style={{ fontSize: 12.5 }}
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
}: {
  panels: readonly SourcePanel[];
  /** The adapted `AnalyticsOverviewResponse`. Null when the shape was wrong. */
  overview: AdaptedAnalyticsOverview | null;
  insight: AdaptedInsight;
  unavailableReason?: string | null;
}) {
  const copy = useCopy();
  return (
    <Shell title="GA4 and Shopify">
      <SourcePanels panels={panels} />
      {unavailableReason || !overview ? (
        <div style={{ marginTop: 12 }}>
          <UnavailableState reason={unavailableReason ?? "The analytics overview could not be read."} />
        </div>
      ) : (
        <>
          <p data-ga4-property="" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            {overview.propertyName ? `GA4 property: ${overview.propertyName}` : "GA4 property name not served."}
          </p>

          <div style={{ marginTop: 12 }}>
            <DataTable
              collection="traffic"
              caption={copy.ga4Kpis}
              rows={[...overview.kpis]}
              rowKey={(row) => row.key}
              columns={[
                { id: "key", header: "Metric", render: (row) => row.key },
                { id: "value", header: "Value", numeric: true, render: (row) => <Value value={row.value} name={row.key} /> },
              ]}
            />
          </div>

          <section aria-label={copy.newVsReturning} style={{ marginTop: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.newVsReturning}</h2>
            {/* Two cohorts, never added: GA4 serves no combined figure and
                summing them would invent one. */}
            <DataTable
              caption={copy.newVsReturning}
              rows={[...overview.cohorts]}
              rowKey={(row) => row.key}
              columns={[
                { id: "key", header: "Cohort", render: (row) => row.key },
                { id: "sessions", header: "Sessions", numeric: true, render: (row) => <Value value={row.sessions} name={`${row.key}-sessions`} /> },
                { id: "purchases", header: "Purchases", numeric: true, render: (row) => <Value value={row.purchases} name={`${row.key}-purchases`} /> },
                { id: "purchaseCvr", header: "Purchase CVR", numeric: true, render: (row) => <Value value={row.purchaseCvr} name={`${row.key}-cvr`} /> },
              ]}
            />
          </section>

          {overview.insights.length > 0 ? (
            <ul data-ga4-insights="" style={{ margin: "12px 0 0", paddingLeft: 18 }}>
              {overview.insights.map((text) => (
                <li key={text} style={{ fontSize: 12.5 }}>
                  {text}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      <section aria-label={copy.latestAiInsight} style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.latestAiInsight}</h2>
        {insight.absentReason ? (
          <p data-insight="absent" data-el="lp-ai-commentary" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
            {insight.absentReason}
          </p>
        ) : (
          <p data-insight="present" data-el="lp-ai-commentary" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {insight.text}
            {insight.generatedAt ? (
              <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                Generated {insight.generatedAt}
              </span>
            ) : null}
          </p>
        )}
        {/* Read only. There is no generate control here, and no code path to one. */}
        <p data-insight-read-only="" style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {copy.readsLatestInsight}
        </p>
      </section>
    </Shell>
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
              style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}
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
      <p data-seo-empty={id} style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--ledger-ink-tertiary)" }}>
        {title}: nothing was served for this window.
      </p>
    );
  }
  return (
    <section aria-label={title} style={{ marginTop: 12 }}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
      <ul data-seo-list={id} style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {items.map((item) => (
          <li key={item.id} data-seo-item={id} style={{ fontSize: 12.5 }}>
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
        <p data-seo-role-blocked="" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
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

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 12px" }}>
            <Button
              variant="secondary"
              data-ctl="gated:SEO-04 run"
              state={
                role.allowed
                  ? { kind: "enabled" }
                  : { kind: "disabled", reason: role.reason }
              }
              onClick={onRunAnalysis}
            >
              {copy.runAnalysis}
            </Button>
            {onLoadMore ? (
              <Button variant="secondary" data-ctl="live:SEO-01 load-more" onClick={onLoadMore}>
                {copy.loadMore}
              </Button>
            ) : null}
          </div>
          <DataTable
            collection="seo"
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

          <SeoList id="leaders" title={copy.leadingQueries} items={seo.leaderQueries} />
          <SeoList id="declining" title={copy.decliningQueries} items={seo.decliningQueries} />
          <SeoList id="causes" title={copy.likelyCauses} items={seo.causes} />
          <SeoList id="recommendations" title={copy.recommendations} items={seo.recommendations} />

          {seo.aiBriefHeadline ? (
            <p data-seo-ai-brief="" data-el="seo-gen-states" style={{ margin: "12px 0 0", fontSize: 12.5 }}>
              {seo.aiBriefHeadline}
              <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                {copy.servedBriefReadOnly}
              </span>
            </p>
          ) : null}
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

      <section aria-label={copy.aiPageReach} data-el="geo-gated" style={{ marginTop: 16 }}>
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

      <section aria-label={copy.priorities} style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{copy.topPriorities}</h2>
        <ol data-geo-priorities="" data-collection="geo" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {geo.priorities.map((item) => (
            <li key={item.title} data-geo-priority={item.priority} style={{ fontSize: 12.5 }}>
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
    </Shell>
  );
}
