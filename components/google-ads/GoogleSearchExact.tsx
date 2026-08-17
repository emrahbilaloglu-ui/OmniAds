"use client";

import styles from "@/components/google-ads/GoogleSearchProductsExact.module.css";
import type {
  GoogleSearchExactChipTone,
  GoogleSearchExactTab,
  GoogleSearchExactViewModel,
  GoogleSearchTermFilterKey,
} from "@/components/google-ads/google-search-exact-adapter";

export type GoogleSearchExactSyncTone =
  | "positive"
  | "warning"
  | "negative"
  | "neutral";

export interface GoogleSearchExactProps {
  model: GoogleSearchExactViewModel;
  syncTone?: GoogleSearchExactSyncTone;
  onTabChange: (tab: GoogleSearchExactTab) => void;
  onFilterChange: (filter: GoogleSearchTermFilterKey) => void;
}

export function chipToneClass(tone: GoogleSearchExactChipTone) {
  switch (tone) {
    case "positive":
      return styles.tonePositive;
    case "info":
      return styles.toneInfo;
    case "auto":
      return styles.toneAuto;
    case "warning":
      return styles.toneWarning;
    case "negative":
      return styles.toneNegative;
    default:
      return styles.toneNeutral;
  }
}

function syncToneClass(tone: GoogleSearchExactSyncTone) {
  switch (tone) {
    case "positive":
      return styles.syncPositive;
    case "warning":
      return styles.syncWarning;
    case "negative":
      return styles.syncNegative;
    default:
      return styles.syncNeutral;
  }
}

function statDotClass(key: GoogleSearchExactViewModel["stats"][number]["key"]) {
  switch (key) {
    case "waste":
      return styles.statDotWaste;
    case "opportunity":
      return styles.statDotOpportunity;
    default:
      return styles.statDotHigh;
  }
}

function keywordStatClass(
  key: GoogleSearchExactViewModel["keywordStats"][number]["key"],
) {
  switch (key) {
    case "warning":
      return styles.keywordStatWarning;
    case "info":
      return styles.keywordStatInfo;
    default:
      return styles.keywordStatAuto;
  }
}

function qualityClass(
  tone: GoogleSearchExactViewModel["keywordRows"][number]["qualityTone"],
) {
  switch (tone) {
    case "positive":
      return styles.qualityPositive;
    case "negative":
      return styles.qualityNegative;
    default:
      return "";
  }
}

/**
 * The canonical `Google Ads · Search` screen.
 *
 * Presentation only: it renders the view model the adapter produced and owns no
 * fetch, no store read and no classification. The two bodies are mutually
 * exclusive exactly as the reference defines them — the terms block and the
 * keywords block never render together.
 */
export function GoogleSearchExact({
  model,
  syncTone = "neutral",
  onTabChange,
  onFilterChange,
}: GoogleSearchExactProps) {
  const activeTab = model.tabs.find((tab) => tab.active)?.key ?? "terms";

  return (
    <section className={styles.screen} data-screen-label="Google Ads · Search">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{model.eyebrow}</p>
          <h1 className={styles.title}>Search intelligence</h1>
        </div>
        <div className={styles.headerStatus}>
          <span className={styles.guardCopy}>
            writes guarded · receipt on every change
          </span>
          <span
            className={`${styles.syncPill} ${syncToneClass(syncTone)}`}
            data-testid="google-search-sync"
          >
            <span className={styles.syncDot} aria-hidden="true" />
            {model.syncLabel}
          </span>
        </div>
      </div>

      <div className={styles.tabRow} data-google-search-tabs="true">
        {model.tabs.map((tab) => (
          <button
            aria-pressed={tab.active}
            className={`${styles.tabPill} ${tab.active ? styles.tabPillActive : ""}`}
            data-google-search-tab={tab.key}
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "terms" ? (
        <>
          <div className={styles.statGrid} data-google-search-stats="true">
            {model.stats.map((stat) => (
              <article className={styles.statCard} data-google-search-stat={stat.key} key={stat.key}>
                <span
                  aria-hidden="true"
                  className={`${styles.statDot} ${statDotClass(stat.key)}`}
                />
                <div>
                  <p className={styles.statValue}>{stat.value}</p>
                  <p className={styles.statLabel}>{stat.label}</p>
                </div>
              </article>
            ))}
          </div>

          <div className={styles.filterRow} data-google-search-filters="true">
            {model.filters.map((filter) => (
              <button
                aria-pressed={filter.active}
                className={`${styles.filterPill} ${
                  filter.active ? styles.filterPillActive : ""
                }`}
                data-google-term-filter={filter.key}
                key={filter.key}
                onClick={() => onFilterChange(filter.key)}
                type="button"
              >
                {filter.label}
                <span className={styles.filterCount}>{filter.count}</span>
              </button>
            ))}
          </div>

          <article className={styles.tableCard}>
            <table className={`${styles.table} ${styles.termTable}`}>
              <thead>
                <tr>
                  <th className={`${styles.headEdge} ${styles.left}`}>Search term</th>
                  <th className={`${styles.headInner} ${styles.left}`}>Campaign</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Clicks</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Conv</th>
                  <th className={`${styles.headInner} ${styles.right}`}>CPA</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Conv value</th>
                  <th className={`${styles.headInner} ${styles.right}`}>ROAS</th>
                  <th className={`${styles.headInner} ${styles.right}`}>CTR</th>
                  <th className={`${styles.headEdge} ${styles.right}`}>Spend</th>
                </tr>
              </thead>
              <tbody>
                {model.termRows.map((row) => (
                  <tr className={styles.row} data-google-term-row={row.key} key={row.key}>
                    <td className={styles.cellEdge}>
                      <span className={styles.primaryText}>{row.term}</span>
                      <span className={styles.chipRow}>
                        <span className={`${styles.chip} ${chipToneClass(row.intentTone)}`}>
                          {row.intent}
                        </span>
                        {row.keywordOpportunity ? (
                          <span className={`${styles.chip} ${styles.opportunityChip}`}>
                            + KW opp
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className={styles.campaignCell}>{row.campaign}</td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.clicks}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.strongCell}`}>
                      {row.conversions}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.cpa}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.value}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right}`}>
                      <span className={`${styles.roasChip} ${chipToneClass(row.roasTone)}`}>
                        {row.roas}
                      </span>
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.ctr}
                    </td>
                    <td
                      className={`${styles.cellEdge} ${styles.right} ${
                        row.spendWasteful ? styles.spendWasteful : styles.spendCell
                      }`}
                    >
                      {row.spend}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

          <p className={styles.footnote}>
            Wasteful = 30+ clicks, zero conversions, meaningful spend. The drafted
            negative pack applies from Advisor → Plan as one guarded write with a
            single receipt.
          </p>
        </>
      ) : (
        <>
          <div className={styles.keywordStatRow} data-google-keyword-stats="true">
            {model.keywordStats.map((stat) => (
              <span className={styles.keywordStat} key={stat.key}>
                <span
                  className={`${styles.keywordStatCount} ${keywordStatClass(stat.key)}`}
                >
                  {stat.count}
                </span>
                {stat.label}
              </span>
            ))}
          </div>

          <article className={styles.tableCard}>
            <table className={`${styles.table} ${styles.keywordTable}`}>
              <thead>
                <tr>
                  <th className={`${styles.headEdge} ${styles.left}`}>Keyword</th>
                  <th className={`${styles.headInner} ${styles.left}`}>Campaign</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Spend</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Conv</th>
                  <th className={`${styles.headInner} ${styles.right}`}>CPA</th>
                  <th className={`${styles.headInner} ${styles.right}`}>ROAS</th>
                  <th className={`${styles.headInner} ${styles.right}`}>QS</th>
                  <th className={`${styles.headInner} ${styles.right}`}>IS</th>
                  <th className={`${styles.headEdge} ${styles.right}`}>CTR</th>
                </tr>
              </thead>
              <tbody>
                {model.keywordRows.map((row) => (
                  <tr className={styles.row} data-google-keyword-row={row.key} key={row.key}>
                    <td className={styles.cellEdge}>
                      <span className={styles.keywordLine}>
                        <span className={styles.keywordText}>{row.keyword}</span>
                        <span
                          className={`${styles.matchChip} ${chipToneClass(row.matchTone)}`}
                        >
                          {row.matchType}
                        </span>
                      </span>
                      <span className={styles.keywordComponents}>{row.components}</span>
                    </td>
                    <td className={styles.campaignCell}>{row.campaign}</td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.spend}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.strongCell}`}>
                      {row.conversions}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.cpa}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right}`}>
                      <span className={`${styles.roasChip} ${chipToneClass(row.roasTone)}`}>
                        {row.roas}
                      </span>
                    </td>
                    <td
                      className={`${styles.cellInner} ${styles.right} ${styles.qualityCell} ${qualityClass(
                        row.qualityTone,
                      )}`}
                    >
                      {row.qualityScore}
                    </td>
                    <td
                      className={`${styles.cellInner} ${styles.right} ${styles.impressionShareCell}`}
                    >
                      {row.impressionShare}
                    </td>
                    <td className={`${styles.cellEdge} ${styles.right} ${styles.mutedCell}`}>
                      {row.ctr}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>

          <p className={styles.footnote}>
            Quality Score and its components (expected CTR · ad relevance ·
            landing page) are Google-served, refreshed each sync.
          </p>
        </>
      )}
    </section>
  );
}
