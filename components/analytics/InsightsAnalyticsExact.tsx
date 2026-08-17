"use client";

import styles from "@/components/analytics/InsightsAnalyticsExact.module.css";
import type {
  AnalyticsDemoChipModel,
  AnalyticsTabId,
  InsightsAnalyticsExactModel,
} from "@/components/analytics/insights-analytics-exact-model";

export type { InsightsAnalyticsExactModel } from "@/components/analytics/insights-analytics-exact-model";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/**
 * The Insights → Analytics tab, rendered exactly as the design draws it.
 *
 * Presentational only. It receives a view model and two callbacks and owns no
 * data, no fetching and no derivations. The design gives this tab no page head
 * of its own, no wrapping card and no per-tab section headers — headings live
 * inside each table card's header band.
 */
export function InsightsAnalyticsExact({
  model,
  onSelectTab,
  onSelectDemoDimension,
}: {
  model: InsightsAnalyticsExactModel;
  onSelectTab: (tab: AnalyticsTabId) => void;
  onSelectDemoDimension: (dimension: AnalyticsDemoChipModel["id"]) => void;
}) {
  return (
    <div className={styles.root}>
      <div className={styles.tabStrip} role="tablist" aria-label="Analytics">
        {model.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.active}
            data-active={tab.active ? "true" : "false"}
            className={styles.tab}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {model.activeTab === "overview" ? <OverviewBody model={model} /> : null}
      {model.activeTab === "products" ? <ProductsBody model={model} /> : null}
      {model.activeTab === "landing" ? <LandingBody model={model} /> : null}
      {model.activeTab === "audience" ? <AudienceBody model={model} /> : null}
      {model.activeTab === "demo" ? (
        <DemographicsBody model={model} onSelectDemoDimension={onSelectDemoDimension} />
      ) : null}
      {model.activeTab === "cohorts" ? <CohortsBody model={model} /> : null}
      {model.activeTab === "opps" ? <OpportunitiesBody model={model} /> : null}
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────── */

function OverviewBody({ model }: { model: InsightsAnalyticsExactModel }) {
  return (
    <>
      <div className={styles.kpiGrid}>
        {model.kpis.map((kpi) => (
          <article key={kpi.key} className={styles.kpiCard}>
            <p className={styles.kpiLabel}>{kpi.label}</p>
            <p className={styles.kpiValue}>{kpi.value}</p>
            <p className={styles.kpiDelta} data-tone={kpi.deltaTone}>
              {kpi.delta}
            </p>
          </article>
        ))}
      </div>

      <SegmentCards model={model} />

      <div className={styles.calloutGrid}>
        {model.callouts.map((callout) => (
          <div key={callout.id} className={styles.callout} data-tone={callout.tone}>
            <span className={styles.kindChip} data-tone={callout.tone}>
              {callout.kind}
            </span>
            <span className={styles.calloutText}>{callout.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function SegmentCards({ model }: { model: InsightsAnalyticsExactModel }) {
  return (
    <div className={styles.segmentGrid}>
      {model.segments.map((segment) => (
        <article key={segment.id} className={styles.segmentCard}>
          <div className={styles.segmentHead}>
            <p className={styles.segmentLabel}>{segment.label}</p>
            {segment.badge ? (
              <span className={styles.segmentBadge}>{segment.badge}</span>
            ) : null}
          </div>
          <div className={styles.segmentMetrics}>
            <div>
              <p className={styles.segmentMetricLabel}>Sessions</p>
              <p className={styles.segmentMetricValue}>{segment.sessions}</p>
            </div>
            <div>
              <p className={styles.segmentMetricLabel}>Engagement</p>
              <p className={styles.segmentMetricValue}>{segment.engagement}</p>
            </div>
            <div>
              <p className={styles.segmentMetricLabel}>Purchase CVR</p>
              <p
                className={styles.segmentMetricValue}
                data-highlight={segment.cvrHighlighted ? "true" : "false"}
              >
                {segment.cvr}
              </p>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ── Products ─────────────────────────────────────────────────────── */

function ProductsBody({ model }: { model: InsightsAnalyticsExactModel }) {
  return (
    <article className={styles.tableCard}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Product funnel</h2>
        <span className={styles.cardHint}>
          view → cart → checkout → purchase · shaded cells run hot
        </span>
      </div>
      <table className={classNames(styles.table, styles.minProducts)}>
        <thead>
          <tr>
            <th className={classNames(styles.th, styles.thLead)}>Product</th>
            <th className={styles.th}>Views</th>
            <th className={styles.th}>Add to cart</th>
            <th className={styles.th}>Checkout</th>
            <th className={styles.th}>Purchases</th>
            <th className={styles.th}>ATC rate</th>
            <th className={styles.th}>Checkout rate</th>
            <th className={styles.th}>Purchase rate</th>
            <th className={classNames(styles.th, styles.thTail)}>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {model.products.map((row) => (
            <tr key={row.id} className={styles.row}>
              <td className={styles.tdLead}>{row.name}</td>
              <td className={styles.td}>{row.views}</td>
              <td className={styles.td}>{row.addToCart}</td>
              <td className={styles.td}>{row.checkout}</td>
              <td className={styles.td}>{row.purchases}</td>
              <td
                className={classNames(styles.td, styles.tdStrong)}
                style={row.atcHeat ? { background: row.atcHeat } : undefined}
              >
                {row.atcRate}
              </td>
              <td
                className={classNames(styles.td, styles.tdStrong)}
                style={row.checkoutHeat ? { background: row.checkoutHeat } : undefined}
              >
                {row.checkoutRate}
              </td>
              <td
                className={classNames(styles.td, styles.tdStrong)}
                style={row.purchaseHeat ? { background: row.purchaseHeat } : undefined}
              >
                {row.purchaseRate}
              </td>
              <td className={classNames(styles.td, styles.tdStrong, styles.tdTail)}>
                {row.revenue}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.tableNote}>{model.productsNote}</p>
    </article>
  );
}

/* ── Landing pages ────────────────────────────────────────────────── */

function LandingBody({ model }: { model: InsightsAnalyticsExactModel }) {
  return (
    <article className={styles.tableCard}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Landing page performance</h2>
        <span className={styles.cardHint}>
          pages that attract traffic but fail to engage or convert
        </span>
      </div>
      <table className={classNames(styles.table, styles.minLanding)}>
        <thead>
          <tr>
            <th className={classNames(styles.th, styles.thLead)}>Page</th>
            <th className={styles.th}>Sessions</th>
            <th className={styles.th}>Engagement</th>
            <th className={styles.th}>Purchases</th>
            <th className={styles.th}>Purchase CVR</th>
            <th className={classNames(styles.th, styles.thLeftAligned)}>Signal</th>
          </tr>
        </thead>
        <tbody>
          {model.landing.map((row) => (
            <tr key={row.id} className={styles.row}>
              <td className={styles.tdMono}>{row.page}</td>
              <td className={styles.td}>{row.sessions}</td>
              <td className={styles.td}>{row.engagement}</td>
              <td className={styles.td}>{row.purchases}</td>
              <td className={classNames(styles.td, styles.tdStrong)}>{row.cvr}</td>
              <td className={styles.tdSignal}>
                {row.signal ? (
                  <span className={styles.signalChip} data-tone={row.signal.tone}>
                    {row.signal.label}
                  </span>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.tableNote}>{model.landingNote}</p>
    </article>
  );
}

/* ── Audience ─────────────────────────────────────────────────────── */

function AudienceBody({ model }: { model: InsightsAnalyticsExactModel }) {
  return (
    <>
      <SegmentCards model={model} />
      <article className={styles.tableCard}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Traffic source quality</h2>
          <span className={styles.cardHint}>
            which sources bring high-quality, converting visitors
          </span>
        </div>
        <table className={classNames(styles.table, styles.minWide)}>
          <thead>
            <tr>
              <th className={classNames(styles.th, styles.thLead)}>Source / medium</th>
              <th className={styles.th}>Sessions</th>
              <th className={styles.th}>Engagement rate</th>
              <th className={styles.th}>Purchases</th>
              <th className={styles.th}>Purchase CVR</th>
              <th className={classNames(styles.th, styles.thTail)}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {model.channels.map((row) => (
              <tr key={row.id} className={styles.row}>
                <td className={styles.tdMono}>{row.sourceMedium}</td>
                <td className={styles.td}>{row.sessions}</td>
                <td
                  className={classNames(styles.td, styles.tdStrong)}
                  style={row.engagementHeat ? { background: row.engagementHeat } : undefined}
                >
                  {row.engagementRate}
                </td>
                <td className={styles.td}>{row.purchases}</td>
                <td
                  className={classNames(styles.td, styles.tdStrong)}
                  style={row.cvrHeat ? { background: row.cvrHeat } : undefined}
                >
                  {row.cvr}
                </td>
                <td className={classNames(styles.td, styles.tdStrong, styles.tdTail)}>
                  {row.revenue}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </>
  );
}

/* ── Demographics ─────────────────────────────────────────────────── */

function DemographicsBody({
  model,
  onSelectDemoDimension,
}: {
  model: InsightsAnalyticsExactModel;
  onSelectDemoDimension: (dimension: AnalyticsDemoChipModel["id"]) => void;
}) {
  return (
    <>
      <div className={styles.demoChips}>
        {model.demoChips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={styles.demoChip}
            data-active={chip.active ? "true" : "false"}
            aria-pressed={chip.active}
            onClick={() => onSelectDemoDimension(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {model.demoSummary ? (
        <div className={styles.demoSummary}>{model.demoSummary}</div>
      ) : null}
      <article className={styles.tableCard}>
        <table className={classNames(styles.table, styles.minWide)}>
          <thead>
            <tr>
              <th className={classNames(styles.th, styles.thLead)}>{model.demoColumn}</th>
              <th className={styles.th}>Sessions</th>
              <th className={styles.th}>Engagement rate</th>
              <th className={styles.th}>Purchases</th>
              <th className={styles.th}>Purchase CVR</th>
              <th className={classNames(styles.th, styles.thTail)}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {model.demoRows.map((row) => (
              <tr key={row.id} className={styles.row}>
                <td className={styles.tdLead}>{row.value}</td>
                <td className={styles.td}>{row.sessions}</td>
                <td
                  className={classNames(styles.td, styles.tdStrong)}
                  style={row.engagementHeat ? { background: row.engagementHeat } : undefined}
                >
                  {row.engagementRate}
                </td>
                <td className={styles.td}>{row.purchases}</td>
                <td
                  className={classNames(styles.td, styles.tdStrong)}
                  style={row.cvrHeat ? { background: row.cvrHeat } : undefined}
                >
                  {row.cvr}
                </td>
                <td className={classNames(styles.td, styles.tdStrong, styles.tdTail)}>
                  {row.revenue}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </>
  );
}

/* ── Cohorts ──────────────────────────────────────────────────────── */

function CohortsBody({ model }: { model: InsightsAnalyticsExactModel }) {
  return (
    <div className={styles.cohortGrid}>
      <article className={styles.tableCard}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Weekly new vs returning</h2>
          <span className={styles.cardHint}>
            retention pill = returning share of sessions
          </span>
        </div>
        <table
          className={classNames(styles.table, styles.tableSmall, styles.minCohortWeeks)}
        >
          <thead>
            <tr>
              <th className={classNames(styles.th, styles.thLead)}>Week</th>
              <th className={styles.th}>New</th>
              <th className={styles.th}>Returning</th>
              <th className={styles.th}>Retention</th>
              <th className={styles.th}>New purch.</th>
              <th className={classNames(styles.th, styles.thTail)}>Return purch.</th>
            </tr>
          </thead>
          <tbody>
            {model.cohortWeeks.map((row) => (
              <tr key={row.id} className={styles.row}>
                <td className={styles.tdCohortMono}>{row.week}</td>
                <td className={styles.tdCohort}>{row.newSessions}</td>
                <td className={styles.tdCohort}>{row.returningSessions}</td>
                <td className={styles.tdCohort}>
                  <span
                    className={styles.retentionChip}
                    style={{ background: row.retentionBg, color: row.retentionFg }}
                  >
                    {row.retention}
                  </span>
                </td>
                <td className={styles.tdCohort}>{row.newPurchases}</td>
                <td className={classNames(styles.tdCohort, styles.tdCohortTail)}>
                  {row.returningPurchases}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <article className={styles.tableCard}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Monthly acquisition summary</h2>
          <span className={styles.cardHint}>do acquired users return and repurchase</span>
        </div>
        <table
          className={classNames(styles.table, styles.tableSmall, styles.minCohortMonths)}
        >
          <thead>
            <tr>
              <th className={classNames(styles.th, styles.thLead)}>Month</th>
              <th className={styles.th}>New users</th>
              <th className={styles.th}>Active users</th>
              <th className={styles.th}>Sessions</th>
              <th className={styles.th}>Purchases</th>
              <th className={styles.th}>CVR</th>
              <th className={classNames(styles.th, styles.thTail)}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {model.cohortMonths.map((row) => (
              <tr key={row.id} className={styles.row}>
                <td className={styles.tdCohortMono}>{row.month}</td>
                <td className={styles.tdCohort}>{row.newUsers}</td>
                <td className={styles.tdCohort}>{row.activeUsers}</td>
                <td className={styles.tdCohort}>{row.sessions}</td>
                <td className={styles.tdCohort}>{row.purchases}</td>
                <td className={classNames(styles.tdCohort, styles.tdStrong)}>{row.cvr}</td>
                <td
                  className={classNames(
                    styles.tdCohort,
                    styles.tdStrong,
                    styles.tdCohortTail,
                  )}
                >
                  {row.revenue}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    </div>
  );
}

/* ── Opportunities ────────────────────────────────────────────────── */

function OpportunitiesBody({ model }: { model: InsightsAnalyticsExactModel }) {
  return (
    <>
      <div className={styles.opportunityGrid}>
        {model.opportunities.map((opportunity) => (
          <div
            key={opportunity.id}
            className={styles.opportunityCard}
            data-tone={opportunity.tone}
          >
            <div className={styles.opportunityHead}>
              <span
                className={classNames(styles.kindChip, styles.kindChipFlat)}
                data-tone={opportunity.tone}
              >
                {opportunity.kind}
              </span>
              <span className={styles.opportunityTitle}>{opportunity.title}</span>
            </div>
            <p className={styles.opportunityText}>{opportunity.description}</p>
          </div>
        ))}
      </div>
      <p className={styles.trailingNote}>
        Derived from this window&rsquo;s funnel, landing-page, audience and channel
        reads — thresholds, not opinions. Not enough data → no flag.
      </p>
    </>
  );
}
