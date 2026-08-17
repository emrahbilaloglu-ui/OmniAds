"use client";

import styles from "@/components/seo/InsightsSeoExact.module.css";
import type {
  InsightsSeoExactModel,
  SeoTabId,
} from "@/components/seo/insights-seo-exact-model";

export type { InsightsSeoExactModel } from "@/components/seo/insights-seo-exact-model";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/**
 * The Insights → SEO Intelligence tab, rendered exactly as the design draws it.
 *
 * Presentational only. The design gives this tab no page head of its own, no
 * wrapping card and no per-tab section headers — headings live inside each
 * card's header band. The KPI band and the sub-tab strip are always on screen;
 * one sub-tab body follows.
 */
export function InsightsSeoExact({
  model,
  onSelectTab,
  onGenerateMonthly,
  isGeneratingMonthly = false,
}: {
  model: InsightsSeoExactModel;
  onSelectTab: (tab: SeoTabId) => void;
  /**
   * Runs the monthly analysis. Only ever reachable from the state the design
   * does not draw — see `SeoMonthlyGenerateModel`.
   */
  onGenerateMonthly?: () => void;
  isGeneratingMonthly?: boolean;
}) {
  return (
    <div className={styles.root}>
      <div className={styles.kpiGrid}>
        {model.kpis.map((kpi) => (
          <article key={kpi.key} className={styles.kpiCard}>
            <p className={styles.kpiLabel}>{kpi.label}</p>
            <div className={styles.kpiValueRow}>
              <p className={styles.kpiValue}>{kpi.value}</p>
              <span className={styles.kpiDelta} data-tone={kpi.deltaTone}>
                {kpi.delta}
              </span>
            </div>
            <p className={styles.kpiPrev}>{kpi.previous}</p>
          </article>
        ))}
      </div>

      <div className={styles.tabStrip} role="tablist" aria-label="SEO Intelligence">
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

      {model.activeTab === "ai" ? (
        <MonthlyBody
          model={model}
          onGenerate={onGenerateMonthly}
          isGenerating={isGeneratingMonthly}
        />
      ) : null}
      {model.activeTab === "traffic" ? <TrafficBody model={model} /> : null}
      {model.activeTab === "queries" ? <QueriesBody model={model} /> : null}
      {model.activeTab === "pages" ? <PagesBody model={model} /> : null}
      {model.activeTab === "actions" ? <ActionsBody model={model} /> : null}
      {model.activeTab === "technical" ? <TechnicalBody model={model} /> : null}
    </div>
  );
}

/* ── Monthly AI (L1969-2009) ──────────────────────────────────────── */

function MonthlyBody({
  model,
  onGenerate,
  isGenerating,
}: {
  model: InsightsSeoExactModel;
  onGenerate?: () => void;
  isGenerating?: boolean;
}) {
  const { monthly } = model;
  const generate = monthly.head.generate;
  return (
    <article className={styles.monthlyCard}>
      <div className={styles.monthlyHead}>
        <div>
          <div className={styles.monthlyTitleRow}>
            <h2 className={styles.monthlyTitle}>{monthly.head.title}</h2>
            <span className={styles.monthlyStatus} data-tone={monthly.head.statusTone}>
              {monthly.head.statusLabel}
            </span>
          </div>
          <p className={styles.monthlyMeta}>{monthly.head.meta}</p>
        </div>
        {generate && onGenerate ? (
          <button
            type="button"
            className={classNames(styles.monthlyCadence, styles.monthlyGenerate)}
            disabled={isGenerating}
            onClick={onGenerate}
          >
            {isGenerating ? "Generating…" : generate.label}
          </button>
        ) : (
          <span className={styles.monthlyCadence}>{monthly.head.cadence}</span>
        )}
      </div>

      <div className={styles.readsRow}>
        <span className={styles.readsLabel}>reads</span>
        {monthly.reads.map((read) => (
          <span key={read} className={styles.readChip}>
            {read}
          </span>
        ))}
      </div>

      <p className={styles.monthlySummary}>{monthly.summary}</p>

      <div className={styles.monthlyGrid}>
        <div>
          <p className={styles.columnLabel}>What changed</p>
          <div className={styles.columnStack}>
            {monthly.whatChanged.map((line, index) => (
              <p key={`${index}-${line}`} className={styles.bullet}>
                {line}
              </p>
            ))}
          </div>
        </div>
        <div>
          <p className={styles.columnLabel}>Likely causes</p>
          <div className={styles.columnStack}>
            {monthly.likelyCauses.map((line, index) => (
              <p
                key={`${index}-${line}`}
                className={classNames(styles.bullet, styles.bulletCause)}
              >
                {line}
              </p>
            ))}
          </div>
        </div>
        <div>
          <p className={styles.columnLabel}>30-day plan</p>
          <div className={styles.columnStack}>
            {monthly.plan.map((step) => (
              <div key={step.id} className={styles.planRow}>
                <span className={styles.planOrdinal}>{step.ordinal}</span>
                <p className={styles.planText}>{step.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

/* ── Traffic changes (L2010-2026) ─────────────────────────────────── */

function TrafficBody({ model }: { model: InsightsSeoExactModel }) {
  return (
    <>
      <div className={styles.moverGrid}>
        {model.movers.map((card) => (
          <article key={card.id} className={styles.card}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>{card.title}</h2>
              <span className={styles.cardHint}>clicks · 28d vs prev</span>
            </div>
            {card.rows.map((row) => (
              <div key={row.id} className={styles.moverRow}>
                <span className={styles.moverLabel}>{row.label}</span>
                <span className={styles.moverValue}>{row.current}</span>
                <span className={styles.moverDelta} data-tone={row.deltaTone}>
                  {row.delta}
                </span>
              </div>
            ))}
          </article>
        ))}
      </div>
      <p className={styles.trailingNote}>
        Focus first on the biggest losing queries and pages, then protect the strongest
        improving clusters.
      </p>
    </>
  );
}

/* ── Query leaders (L2027-2046) ───────────────────────────────────── */

function QueriesBody({ model }: { model: InsightsSeoExactModel }) {
  return (
    <article className={styles.tableCard}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Query leaders</h2>
        <span className={styles.cardHint}>
          Search Console · 28d · these anchor organic visibility — watch them first
        </span>
      </div>
      <table className={classNames(styles.table, styles.minQueries)}>
        <thead>
          <tr>
            <th className={classNames(styles.th, styles.thLead)}>Query</th>
            <th className={styles.th}>Clicks</th>
            <th className={styles.th}>Impressions</th>
            <th className={styles.th}>CTR</th>
            <th className={styles.th}>Position</th>
            <th className={classNames(styles.th, styles.thTail)}>Δ pos</th>
          </tr>
        </thead>
        <tbody>
          {model.queries.map((row) => (
            <tr key={row.id} className={styles.row}>
              <td className={styles.tdLead}>{row.query}</td>
              <td className={classNames(styles.td, styles.tdStrong)}>{row.clicks}</td>
              <td className={styles.td}>{row.impressions}</td>
              <td className={styles.td}>{row.ctr}</td>
              <td className={styles.tdPosition}>{row.position}</td>
              <td className={styles.tdDelta}>
                <span className={styles.deltaChip} data-tone={row.positionDeltaTone}>
                  {row.positionDelta}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

/* ── Page leaders (L2047-2065) ────────────────────────────────────── */

function PagesBody({ model }: { model: InsightsSeoExactModel }) {
  return (
    <article className={styles.tableCard}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Page leaders</h2>
        <span className={styles.cardHint}>
          landing pages carrying the most organic value — start technical or snippet work
          here
        </span>
      </div>
      <table className={classNames(styles.table, styles.minPages)}>
        <thead>
          <tr>
            <th className={classNames(styles.th, styles.thLead)}>Page</th>
            <th className={styles.th}>Clicks</th>
            <th className={styles.th}>Impressions</th>
            <th className={styles.th}>CTR</th>
            <th className={classNames(styles.th, styles.thTail)}>Position</th>
          </tr>
        </thead>
        <tbody>
          {model.pages.map((row) => (
            <tr key={row.id} className={styles.row}>
              <td className={styles.tdMono}>{row.page}</td>
              <td className={classNames(styles.td, styles.tdStrong)}>{row.clicks}</td>
              <td className={styles.td}>{row.impressions}</td>
              <td className={styles.td}>{row.ctr}</td>
              <td className={classNames(styles.tdPosition, styles.tdPositionTail)}>
                {row.position}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

/* ── Actions (L2066-2084) ─────────────────────────────────────────── */

function ActionsBody({ model }: { model: InsightsSeoExactModel }) {
  return (
    <div className={styles.actionStack}>
      {model.actionGroups.map((group) => (
        <article key={group.id} className={styles.actionCard}>
          <div className={styles.actionToneRow}>
            <span className={styles.actionTone} data-tone={group.tone}>
              {group.toneLabel}
            </span>
          </div>
          <div className={styles.actionGrid}>
            {group.items.map((item) => (
              <div key={item.id} className={styles.actionItem}>
                <p className={styles.actionTitle}>{item.title}</p>
                <p className={styles.actionWhy}>{item.why}</p>
                <p className={styles.actionMeta}>
                  <span className={styles.actionImpact}>{item.impact}</span>{" "}
                  <span className={styles.actionEffort}>· {item.effort}</span>
                </p>
              </div>
            ))}
          </div>
        </article>
      ))}
      <p className={styles.trailingNote}>
        Sequenced from the monthly model output — what to fix first, what to schedule, what
        to defer.
      </p>
    </div>
  );
}

/* ── Technical findings (L2085-2118) ──────────────────────────────── */

function TechnicalBody({ model }: { model: InsightsSeoExactModel }) {
  const { technical } = model;
  return (
    <>
      <div className={styles.techNotice}>
        Pages can appear here even with 0 current impressions — that usually means the URL
        was previously visible, is losing discovery, or was confirmed excluded via URL
        Inspection. Querystring and feed/service paths are excluded from this view.
      </div>

      <div className={styles.techCardGrid}>
        {technical.cards.map((card) => (
          <article key={card.key} className={styles.techCard}>
            <p className={styles.kpiLabel}>{card.label}</p>
            <p className={styles.techValue} data-tone={card.tone}>
              {card.value}
            </p>
          </article>
        ))}
      </div>

      <div className={styles.techSplit}>
        <article className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Confirmed excluded pages</h2>
            <span className={styles.cardHint}>{technical.inspectionHint}</span>
          </div>
          {technical.excluded.map((page) => (
            <div key={page.id} className={styles.excludedRow}>
              <span className={styles.excludedUrl}>{page.url}</span>
              <span className={styles.excludedReason} data-tone={page.tone}>
                {page.reason}
              </span>
            </div>
          ))}
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Technical findings</h2>
            <span className={styles.cardHint}>
              crawl · indexation · metadata · canonical · structured data
            </span>
          </div>
          {technical.findings.map((finding) => (
            <div key={finding.id} className={styles.findingRow}>
              <span className={styles.findingSeverity} data-tone={finding.tone}>
                {finding.severity}
              </span>
              <div className={styles.findingBody}>
                <p className={styles.findingTitle}>{finding.title}</p>
                <p className={styles.findingDetail}>{finding.detail}</p>
              </div>
            </div>
          ))}
        </article>
      </div>
    </>
  );
}
