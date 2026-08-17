"use client";

import styles from "@/components/google-ads/GoogleAssetsPlanExact.module.css";
import type { GoogleSearchExactChipTone } from "@/components/google-ads/google-search-exact-adapter";
import type { GoogleSearchExactSyncTone } from "@/components/google-ads/GoogleSearchExact";
import type {
  GoogleAssetsExactTab,
  GoogleAssetsExactViewModel,
} from "@/components/google-ads/google-assets-exact-adapter";

export function assetsChipToneClass(tone: GoogleSearchExactChipTone) {
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
    case "unserved":
      return styles.toneUnserved;
    default:
      return styles.toneNeutral;
  }
}

export function assetsSyncToneClass(tone: GoogleSearchExactSyncTone) {
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

const SWATCH_CLASS = [
  styles.swatch0,
  styles.swatch1,
  styles.swatch2,
  styles.swatch3,
];

/**
 * The canonical `Google Ads · Assets & Audiences` screen.
 *
 * Presentation only. The section is the page head, the three-way pill row and
 * exactly one of the three surfaces the reference defines — nothing renders
 * below the selected surface.
 */
export function GoogleAssetsExact({
  model,
  syncTone = "neutral",
  onTabChange,
}: {
  model: GoogleAssetsExactViewModel;
  syncTone?: GoogleSearchExactSyncTone;
  onTabChange?: (tab: GoogleAssetsExactTab) => void;
}) {
  return (
    <section
      className={styles.screen}
      data-screen-label="Google Ads · Assets & Audiences"
    >
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{model.eyebrow}</p>
          <h1 className={styles.title}>Assets &amp; Audiences</h1>
        </div>
        <div className={styles.headerStatus}>
          <span className={styles.guardCopy}>
            writes guarded · receipt on every change
          </span>
          <span
            className={`${styles.syncPill} ${assetsSyncToneClass(syncTone)}`}
            data-testid="google-assets-sync"
          >
            <span className={styles.syncDot} aria-hidden="true" />
            {model.syncLabel}
          </span>
        </div>
      </div>

      <div className={styles.tabRow}>
        {model.tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            data-google-asset-tab={tab.key}
            aria-pressed={tab.active}
            onClick={() => onTabChange?.(tab.key)}
            className={`${styles.tabPill} ${tab.active ? styles.tabPillActive : ""}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {model.tab === "groups" ? (
        <>
          <article className={styles.tableCard} data-google-asset-groups="true">
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Asset groups</h2>
              <span className={styles.cardSubtitle}>
                Performance Max · ad strength is Google-served
              </span>
            </div>
            <table className={`${styles.table} ${styles.groupTable}`}>
              <thead>
                <tr>
                  <th className={`${styles.headEdge} ${styles.left}`}>Asset group</th>
                  <th className={`${styles.headInner} ${styles.left}`}>Campaign</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Spend</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Conv value</th>
                  <th className={`${styles.headInner} ${styles.right}`}>ROAS</th>
                  <th className={`${styles.headEdge} ${styles.left}`}>Ad strength</th>
                </tr>
              </thead>
              <tbody>
                {model.groupRows.map((row) => (
                  <tr
                    className={styles.row}
                    data-google-asset-group-row={row.key}
                    key={row.key}
                  >
                    <td className={`${styles.cellEdge} ${styles.primaryCell}`}>
                      {row.name}
                    </td>
                    <td className={styles.campaignCell}>{row.campaign}</td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.spend}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.strongCell}`}>
                      {row.value}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right}`}>
                      <span
                        className={`${styles.roasChip} ${assetsChipToneClass(row.roasTone)}`}
                      >
                        {row.roas}
                      </span>
                    </td>
                    <td className={styles.cellEdge}>
                      <span
                        className={`${styles.strengthChip} ${assetsChipToneClass(row.strengthTone)}`}
                      >
                        {row.strength}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
          <p className={styles.footnote}>{model.groupNote}</p>
        </>
      ) : null}

      {model.tab === "assets" ? (
        <div className={styles.assetGrid}>
          <article className={styles.card} data-google-text-assets="true">
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Text assets</h2>
              <span className={styles.cardSubtitle}>
                ratings are Google-served · refreshed each sync
              </span>
            </div>
            {model.textRows.map((row) => (
              <div className={styles.assetRow} key={row.key} data-google-text-asset={row.key}>
                <span className={styles.assetText}>“{row.text}”</span>
                <span className={styles.assetKind}>{row.kind}</span>
                <span className={styles.assetImpressions}>{row.impressions}</span>
                <span
                  className={`${styles.performanceChip} ${assetsChipToneClass(row.performanceTone)}`}
                >
                  {row.performance}
                </span>
              </div>
            ))}
          </article>

          <article className={styles.imageCard} data-google-image-assets="true">
            <div className={styles.imageCardHead}>
              <h2 className={styles.cardTitle}>Image assets</h2>
              <span className={styles.cardSubtitle}>impression share</span>
            </div>
            <div className={styles.imageGrid}>
              {model.imageRows.map((row) => (
                <div className={styles.imageTile} key={row.key} data-google-image-asset={row.key}>
                  {row.imageUrl ? (
                    <img
                      src={row.imageUrl}
                      alt={row.label}
                      className={styles.imageSwatch}
                    />
                  ) : (
                    <div
                      className={`${styles.imageSwatch} ${SWATCH_CLASS[row.swatch]}`}
                    />
                  )}
                  <p className={styles.imageShare}>{row.share} of impressions</p>
                </div>
              ))}
            </div>
            <p className={styles.imageNote}>
              Thumbnails render from synced assets — drop real exports to replace
              the placeholders.
            </p>
          </article>
        </div>
      ) : null}

      {model.tab === "audiences" ? (
        <>
          <article className={styles.tableCard} data-google-audiences="true">
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Audiences</h2>
              <span className={styles.cardSubtitle}>
                observation + targeting · lists sync from Shopify segments
              </span>
            </div>
            <table className={`${styles.table} ${styles.audienceTable}`}>
              <thead>
                <tr>
                  <th className={`${styles.headEdge} ${styles.left}`}>Audience</th>
                  <th className={`${styles.headInner} ${styles.left}`}>Type</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Size</th>
                  <th className={`${styles.headInner} ${styles.right}`}>Conv</th>
                  <th className={`${styles.headInner} ${styles.right}`}>CPA</th>
                  <th className={`${styles.headEdge} ${styles.right}`}>ROAS</th>
                </tr>
              </thead>
              <tbody>
                {model.audienceRows.map((row) => (
                  <tr
                    className={styles.row}
                    data-google-audience-row={row.key}
                    key={row.key}
                  >
                    <td className={`${styles.cellEdge} ${styles.primaryCell}`}>
                      {row.name}
                    </td>
                    <td className={styles.cellInner}>
                      <span className={styles.typeChip}>{row.type}</span>
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.size}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.strongCell}`}>
                      {row.conversions}
                    </td>
                    <td className={`${styles.cellInner} ${styles.right} ${styles.mutedCell}`}>
                      {row.cpa}
                    </td>
                    <td className={`${styles.cellEdge} ${styles.right}`}>
                      <span
                        className={`${styles.roasChip} ${assetsChipToneClass(row.roasTone)}`}
                      >
                        {row.roas}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
          <p className={styles.footnote}>
            Attach or detach applies from the Plan page as a guarded write — this
            view stays analysis.
          </p>
        </>
      ) : null}
    </section>
  );
}
