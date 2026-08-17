import styles from "@/components/klaviyo/KlaviyoExact.module.css";
import type { KlaviyoExactModel } from "@/components/klaviyo/klaviyo-exact-adapter";

export type { KlaviyoExactModel } from "@/components/klaviyo/klaviyo-exact-adapter";

/** design 1697-1700 — the header's fixed lines. */
const EYEBROW = "Klaviyo · Email & SMS";
const TITLE = "Lifecycle";
const BETA_BADGE = "BETA — read-only analysis";
/** design 1732 — the footer sentence, in IBM Plex Mono. */
const FOOT_NOTE =
  'The Overview opportunity "win-back flow for 60-day lapsed buyers" starts here — the draft is pre-scoped to that segment.';

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

/**
 * The Klaviyo lifecycle screen exactly as the design draws it.
 *
 * One screen, four decorative tab pills, one flow table, one footer sentence.
 * Presentational only — it takes a view model and reads nothing else.
 */
export function KlaviyoExact({ model }: { model: KlaviyoExactModel }) {
  return (
    <section className={styles.root}>
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{EYEBROW}</p>
          <h1 className={styles.title}>{TITLE}</h1>
        </div>
        <span className={styles.betaBadge}>{BETA_BADGE}</span>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Klaviyo surfaces">
        {model.tabs.map((tab, index) => (
          <span
            key={tab}
            role="tab"
            aria-selected={index === model.activeTabIndex}
            className={classNames(
              styles.tab,
              index === model.activeTabIndex && styles.tabActive,
            )}
          >
            {tab}
          </span>
        ))}
      </div>

      <article className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={classNames(styles.th, styles.thEdge)}>Flow</th>
              <th className={styles.th}>Status</th>
              <th className={classNames(styles.th, styles.thRight)}>
                Revenue · 28d
              </th>
              <th className={classNames(styles.th, styles.thRight)}>Open rate</th>
              <th
                className={classNames(styles.th, styles.thEdge, styles.thRight)}
              >
                Recipients
              </th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.key} className={styles.row}>
                <td className={styles.cellName}>{row.name}</td>
                <td className={styles.cellStatus}>
                  <span
                    className={classNames(
                      styles.statusChip,
                      row.statusTone === "live" && styles.statusChipLive,
                    )}
                  >
                    {row.status}
                  </span>
                </td>
                <td className={styles.cellRevenue}>{row.revenue}</td>
                <td className={styles.cellMetric}>{row.openRate}</td>
                <td className={styles.cellMetricEdge}>{row.recipients}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      <p className={styles.footNote}>{FOOT_NOTE}</p>
    </section>
  );
}
