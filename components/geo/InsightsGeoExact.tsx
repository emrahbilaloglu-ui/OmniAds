"use client";

import { useState } from "react";

import styles from "@/components/geo/InsightsGeoExact.module.css";
import type {
  GeoTabId,
  InsightsGeoExactModel,
} from "@/components/geo/insights-geo-exact-model";
import type { GeoQueryFilterId } from "@/components/geo/insights-geo-exact-adapter";

export type { InsightsGeoExactModel } from "@/components/geo/insights-geo-exact-model";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/**
 * The Insights → AI Visibility (GEO) tab, rendered exactly as the design draws
 * it: the explainer band, the sub-tab strip, one sub-tab body, and the
 * methodology accordion that the design keeps below every GEO tab.
 *
 * Presentational only. The design gives this tab no page head of its own, no
 * second pair of connection chips and no wrapping card.
 */
export function InsightsGeoExact({
  model,
  onSelectTab,
  onSelectFilter,
}: {
  model: InsightsGeoExactModel;
  onSelectTab: (tab: GeoTabId) => void;
  onSelectFilter: (filter: GeoQueryFilterId) => void;
}) {
  return (
    <div className={styles.root}>
      <div className={styles.explainer}>
        <b className={styles.explainerLead}>What is AI Visibility?</b>{" "}
        <span className={styles.explainerBody}>
          How AI surfaces like ChatGPT, Perplexity, Gemini and Copilot expose your brand and
          content — measured from your own traffic and search data — and what to improve to
          win more AI-sourced discovery.
        </span>
      </div>

      <div className={styles.tabStrip} role="tablist" aria-label="AI Visibility">
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
      {model.activeTab === "sources" ? <SourcesBody model={model} /> : null}
      {model.activeTab === "pages" ? <PagesBody model={model} /> : null}
      {model.activeTab === "queries" ? (
        <QueriesBody model={model} onSelectFilter={onSelectFilter} />
      ) : null}
      {model.activeTab === "topics" ? <TopicsBody model={model} /> : null}
      {model.activeTab === "plays" ? <PlaysBody model={model} /> : null}

      <Methodology model={model} />
    </div>
  );
}

/* ── Overview (L2128-2173) ────────────────────────────────────────── */

function OverviewBody({ model }: { model: InsightsGeoExactModel }) {
  return (
    <>
      <div className={styles.kpiGrid}>
        {model.kpis.map((kpi) => (
          <article
            key={kpi.key}
            className={styles.kpiCard}
            data-highlighted={kpi.highlighted ? "true" : "false"}
          >
            <p className={styles.statLabel}>{kpi.label}</p>
            <p className={styles.kpiValue}>{kpi.value}</p>
            <p className={styles.kpiSub} data-tone={kpi.subTone}>
              {kpi.sub}
            </p>
          </article>
        ))}
      </div>

      <div className={styles.intentBand}>
        <span className={styles.intentLabel}>Search intelligence</span>
        <span className={styles.intentText}>
          <b className={styles.intentStrong}>{model.intentBand.aiQueries}</b> of{" "}
          <b className={styles.intentStrong}>{model.intentBand.totalQueries}</b> ranking
          queries have AI / answer intent
        </span>
        <div className={styles.intentTrack}>
          <div
            className={styles.intentFill}
            style={{ width: model.intentBand.barWidth }}
          />
        </div>
      </div>

      <div className={styles.priorityGrid}>
        {model.priorities.map((priority) => (
          <article
            key={priority.id}
            className={styles.priorityCard}
            data-tone={priority.tone}
          >
            <div className={styles.priorityHead}>
              <span className={styles.priorityDot} data-tone={priority.tone} />
              <span className={styles.priorityPill} data-tone={priority.tone}>
                {priority.priorityLabel}
              </span>
            </div>
            <p className={styles.priorityTitle}>{priority.title}</p>
            <p className={styles.priorityDetail}>{priority.detail}</p>
            <p className={styles.priorityMeta}>
              <span className={styles.metaImpact}>{priority.impact}</span>{" "}
              <span className={styles.metaEffort}>· {priority.effort}</span>
            </p>
          </article>
        ))}
      </div>

      <div className={styles.highlightGrid}>
        {model.highlights.map((highlight) => (
          <article
            key={highlight.id}
            className={styles.highlightCard}
            data-tone={highlight.tone}
          >
            <p className={styles.highlightLabel} data-tone={highlight.tone}>
              {highlight.label}
            </p>
            <div className={styles.highlightRow}>
              <p className={styles.highlightMain}>{highlight.main}</p>
              <span className={styles.highlightPill} data-tone={highlight.tone}>
                {highlight.pill}
              </span>
            </div>
            <p className={styles.highlightSub}>{highlight.sub}</p>
          </article>
        ))}
      </div>

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

/* ── AI Sources (L2174-2196) ──────────────────────────────────────── */

function SourcesBody({ model }: { model: InsightsGeoExactModel }) {
  return (
    <article className={styles.tableCard}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>AI traffic sources</h2>
        <span className={styles.cardHint}>
          sessions from known AI engines · value vs site average · momentum vs previous
          period
        </span>
      </div>
      <table className={classNames(styles.table, styles.minSources)}>
        <thead>
          <tr>
            <th className={classNames(styles.th, styles.thLead)}>AI engine</th>
            <th className={classNames(styles.th, styles.thLeft)}>AI value</th>
            <th className={classNames(styles.th, styles.thLeft)}>Momentum</th>
            <th className={styles.th}>Sessions</th>
            <th className={styles.th}>Engagement</th>
            <th className={styles.th}>Purchases</th>
            <th className={styles.th}>CVR</th>
            <th className={styles.th}>Revenue</th>
            <th className={classNames(styles.th, styles.thLeft)}>Recommendation</th>
          </tr>
        </thead>
        <tbody>
          {model.sources.map((row) => (
            <tr key={row.id} className={styles.row}>
              <td className={styles.tdEngine}>
                <span className={styles.enginePill} data-tone={row.engineTone}>
                  {row.engine}
                </span>
              </td>
              <td className={styles.tdChip}>
                <span className={styles.valueChip} data-tone={row.valueTone}>
                  {row.value}
                </span>
              </td>
              <td className={styles.tdChip}>
                <span className={styles.momentumChip} data-tone={row.momentumTone}>
                  {row.momentum}
                </span>
              </td>
              <td className={classNames(styles.td, styles.tdStrong)}>{row.sessions}</td>
              <td
                className={styles.tdHeat}
                style={row.engagementHeat ? { background: row.engagementHeat } : undefined}
              >
                {row.engagement}
              </td>
              <td className={styles.td}>{row.purchases}</td>
              <td
                className={styles.tdHeat}
                style={row.cvrHeat ? { background: row.cvrHeat } : undefined}
              >
                {row.cvr}
              </td>
              <td className={classNames(styles.td, styles.tdStrong)}>{row.revenue}</td>
              <td className={styles.tdRecommendation}>{row.recommendation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

/* ── Pages (L2197-2216) ───────────────────────────────────────────── */

function PagesBody({ model }: { model: InsightsGeoExactModel }) {
  return (
    <article className={styles.tableCard}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>AI content winners</h2>
        <span className={styles.cardHint}>
          pages receiving AI-sourced traffic, ranked by AI Visibility Score — your strongest
          AI-discovery assets
        </span>
      </div>
      <table className={classNames(styles.table, styles.tablePages, styles.minPages)}>
        <thead>
          <tr>
            <th className={classNames(styles.th, styles.thLead)}>Page</th>
            <th className={styles.th}>AI sessions</th>
            <th className={styles.th}>Engagement</th>
            <th className={styles.th}>Purchase CVR</th>
            <th className={styles.th}>AIV score</th>
            <th className={classNames(styles.th, styles.thLeft)}>Sourced by</th>
          </tr>
        </thead>
        <tbody>
          {model.pages.map((row) => (
            <tr key={row.id} className={styles.row}>
              <td className={styles.tdPage}>{row.page}</td>
              <td className={classNames(styles.tdPageCell, styles.tdStrong)}>
                {row.aiSessions}
              </td>
              <td className={styles.tdPageCell}>{row.engagement}</td>
              <td className={styles.tdPageCell}>{row.cvr}</td>
              <td className={styles.tdScore}>
                <span className={styles.scorePill} data-tone={row.scoreTone}>
                  {row.score}
                </span>
              </td>
              <td className={styles.tdSourcedBy}>{row.sourcedBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

/* ── Query Intelligence (L2217-2250) ──────────────────────────────── */

function QueriesBody({
  model,
  onSelectFilter,
}: {
  model: InsightsGeoExactModel;
  onSelectFilter: (filter: GeoQueryFilterId) => void;
}) {
  const [openQuery, setOpenQuery] = useState<string | null>(null);
  return (
    <>
      <div className={styles.filterRow}>
        {model.filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={styles.filterChip}
            data-active={filter.active ? "true" : "false"}
            onClick={() => {
              setOpenQuery(null);
              onSelectFilter(filter.id as GeoQueryFilterId);
            }}
          >
            {filter.label} <span className={styles.filterCount}>{filter.count}</span>
          </button>
        ))}
      </div>

      <article className={styles.tableCard}>
        <table className={classNames(styles.table, styles.minQueries)}>
          <thead>
            <tr>
              <th className={classNames(styles.th, styles.thLead)}>Query</th>
              <th className={classNames(styles.th, styles.thLeft)}>Intent / format</th>
              <th className={classNames(styles.th, styles.thLeft)}>Momentum</th>
              <th className={styles.th}>GEO score</th>
              <th className={styles.th}>Impressions</th>
              <th className={styles.th}>CTR</th>
              <th className={styles.th}>Position</th>
              <th className={classNames(styles.th, styles.thLeft)}>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {model.queries.map((row) => {
              const open = openQuery === row.id;
              return (
                <tr key={row.id} className={classNames(styles.row, styles.rowTop)}>
                  <td className={styles.tdQuery}>
                    <div className={styles.queryCell}>
                      <span className={styles.queryDot} data-tone={row.priorityTone} />
                      <span className={styles.queryText}>{row.query}</span>
                    </div>
                  </td>
                  <td className={styles.tdChip}>
                    <span className={styles.intentChip} data-tone={row.intentTone}>
                      {row.star}
                      {row.intent}
                    </span>
                  </td>
                  <td className={styles.tdChip}>
                    <span className={styles.momentumChip} data-tone={row.momentumTone}>
                      {row.momentum}
                    </span>
                  </td>
                  <td className={styles.tdQueryScore}>
                    <button
                      type="button"
                      className={styles.scoreToggle}
                      data-tone={row.scoreTone}
                      aria-expanded={open}
                      onClick={() => setOpenQuery(open ? null : row.id)}
                    >
                      {row.score}
                    </button>
                    {open ? (
                      <div className={styles.breakdown}>
                        {row.bars.map((bar) => (
                          <div key={bar.key} className={styles.breakdownRow}>
                            <span className={styles.breakdownLabel}>{bar.label}</span>
                            <div className={styles.breakdownTrack}>
                              <div
                                className={styles.breakdownFill}
                                style={{ width: bar.width }}
                              />
                            </div>
                            <span className={styles.breakdownValue}>{bar.value}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className={styles.td}>{row.impressions}</td>
                  <td className={styles.td}>{row.ctr}</td>
                  <td className={styles.tdPosition} data-tone={row.positionTone}>
                    {row.position}
                  </td>
                  <td className={styles.tdQueryRecommendation}>{row.recommendation}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className={styles.tableNote}>
          ✦ marks high answer-engine potential · click a GEO score for its component
          breakdown · counts reflect the full {model.queryDatasetSize}-query dataset, table
          shows the top rows by GEO score.
        </p>
      </article>
    </>
  );
}

/* ── Topic Authority (L2251-2286) ─────────────────────────────────── */

function TopicsBody({ model }: { model: InsightsGeoExactModel }) {
  return (
    <div className={styles.topicStack}>
      {model.topics.map((topic) => (
        <article key={topic.id} className={styles.topicCard}>
          <div className={styles.topicBody}>
            <div className={styles.topicHead}>
              <span className={styles.topicName}>{topic.topic}</span>
              <span className={styles.coveragePill} data-tone={topic.coverageTone}>
                {topic.coverage}
              </span>
              <span className={styles.momentumChip} data-tone={topic.momentumTone}>
                {topic.momentum}
              </span>
              {topic.priority ? (
                <span className={styles.topicPriority} data-tone={topic.priorityTone}>
                  {topic.priority}
                </span>
              ) : null}
              {topic.gap ? (
                <span className={styles.topicGap} data-tone={topic.gapTone}>
                  {topic.gap}
                </span>
              ) : null}
              <span className={styles.topicQueryCount}>{topic.queryCount}</span>
            </div>
            <div className={styles.topicTrack}>
              <div
                className={styles.topicFill}
                data-tone={topic.coverageTone}
                style={{ width: topic.barWidth }}
              />
            </div>
            <div className={styles.topicChips}>
              {topic.chips.map((chip) => (
                <span key={chip} className={styles.topicChip}>
                  {chip}
                </span>
              ))}
            </div>
            <div className={styles.topicRec}>
              <p className={styles.topicRecTitle}>{topic.recommendationTitle}</p>
              <p className={styles.topicRecMeta}>
                <span className={styles.topicRecImpact}>{topic.recommendationImpact}</span>{" "}
                <span className={styles.metaEffort}>· {topic.recommendationEffort}</span>
              </p>
            </div>
          </div>
          <div className={styles.topicAside}>
            <span className={styles.topicScore} data-tone={topic.scoreTone}>
              {topic.score}
            </span>
            <p className={styles.topicImpressions}>{topic.impressions}</p>
            <p className={styles.topicAsideCaption}>impressions</p>
            <p className={styles.topicClicks}>{topic.clicks}</p>
            <p className={styles.topicAsideCaption}>clicks</p>
            <p className={styles.topicPosition}>avg pos {topic.position}</p>
            <p className={styles.topicAuthority}>{topic.authority}</p>
          </div>
        </article>
      ))}
      <p className={styles.trailingNote}>
        Clusters built from your ranking queries — strong coverage means many queries rank
        for the topic; gaps are where demand exists without owned answers.
      </p>
    </div>
  );
}

/* ── Playbook (L2287-2305) ────────────────────────────────────────── */

function PlaysBody({ model }: { model: InsightsGeoExactModel }) {
  return (
    <div className={styles.playGrid}>
      {model.plays.map((play) => (
        <article key={play.id} className={styles.playCard}>
          <div className={styles.playRow}>
            <span className={styles.playOrdinal}>{play.ordinal}</span>
            <div className={styles.playBody}>
              <p className={styles.playTitle}>{play.title}</p>
              <p className={styles.playWhy}>{play.why}</p>
              <p className={styles.playOutcome}>{play.outcome}</p>
              <div className={styles.playChips}>
                {play.chips.map((chip, index) => (
                  <span
                    key={`${play.id}-chip-${index}`}
                    className={styles.playChip}
                    data-tone={chip.tone}
                  >
                    {chip.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ── Methodology accordion (L2306-2318) ───────────────────────────── */

function Methodology({ model }: { model: InsightsGeoExactModel }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={styles.methodCard}>
      <button
        type="button"
        className={styles.methodToggle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.methodArrow}>{open ? "▾" : "▸"}</span>
        <span className={styles.methodLabel}>Methodology &amp; data assumptions</span>
      </button>
      {open ? (
        <div className={styles.methodBody}>
          {model.methodology.map((paragraph) => (
            <p key={paragraph.id} className={styles.methodParagraph}>
              <b className={styles.methodLead}>{paragraph.lead}</b>
              {paragraph.rest}
            </p>
          ))}
        </div>
      ) : null}
    </article>
  );
}
