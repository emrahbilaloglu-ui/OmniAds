"use client";

import styles from "@/components/google-ads/GoogleSearchProductsExact.module.css";
import {
  chipToneClass,
  type GoogleSearchExactSyncTone,
} from "@/components/google-ads/GoogleSearchExact";
import type { GoogleProductsExactViewModel } from "@/components/google-ads/google-products-exact-adapter";

export interface GoogleProductsExactProps {
  model: GoogleProductsExactViewModel;
  syncTone?: GoogleSearchExactSyncTone;
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

function tileValueClass(
  tone: GoogleProductsExactViewModel["tiles"][number]["valueTone"],
) {
  switch (tone) {
    case "warning":
      return styles.tileValueWarning;
    case "danger":
      return styles.tileValueDanger;
    default:
      return "";
  }
}

/**
 * The canonical `Google Ads · Products` screen.
 *
 * Presentation only. The Allocation read card is an unconditional second child
 * of the two-column grid: when the advisor has scoped no Shopping & Products
 * finding, the card keeps its head and closing copy rather than collapsing and
 * leaving the design's right-hand track empty.
 */
export function GoogleProductsExact({
  model,
  syncTone = "neutral",
}: GoogleProductsExactProps) {
  return (
    <section className={styles.screen} data-screen-label="Google Ads · Products">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{model.eyebrow}</p>
          <h1 className={styles.title}>Products &amp; feed</h1>
        </div>
        <div className={styles.headerStatus}>
          <span className={styles.guardCopy}>
            writes guarded · receipt on every change
          </span>
          <span
            className={`${styles.syncPill} ${syncToneClass(syncTone)}`}
            data-testid="google-products-sync"
          >
            <span className={styles.syncDot} aria-hidden="true" />
            {model.syncLabel}
          </span>
        </div>
      </div>

      <div className={styles.tileGrid} data-google-feed-tiles="true">
        {model.tiles.map((tile) => (
          <article className={styles.tile} data-google-feed-tile={tile.key} key={tile.key}>
            <p className={styles.tileLabel}>{tile.label}</p>
            <p className={`${styles.tileValue} ${tileValueClass(tile.valueTone)}`}>
              {tile.value}
            </p>
            <p className={styles.tileSub}>{tile.sub}</p>
          </article>
        ))}
      </div>

      <div className={styles.productsGrid}>
        <article className={styles.tableCard}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Products</h2>
            <span className={styles.cardSubtitle}>
              Shopping + PMax · feed from Shopify
            </span>
          </div>
          <table className={`${styles.table} ${styles.productTable}`}>
            <thead>
              <tr>
                <th className={`${styles.headEdge} ${styles.left}`}>Product</th>
                <th className={`${styles.headInner} ${styles.right}`}>Clicks</th>
                <th className={`${styles.headInner} ${styles.right}`}>Cost</th>
                <th className={`${styles.headInner} ${styles.right}`}>Conv value</th>
                <th className={`${styles.headInner} ${styles.right}`}>ROAS</th>
                <th className={`${styles.headEdge} ${styles.left}`}>Feed status</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr className={styles.row} data-google-product-row={row.key} key={row.key}>
                  <td className={styles.productCellEdge}>
                    <span className={styles.primaryText}>{row.name}</span>
                    <span className={styles.productSku}>{row.sku}</span>
                  </td>
                  <td
                    className={`${styles.productCellInner} ${styles.right} ${styles.mutedCell}`}
                  >
                    {row.clicks}
                  </td>
                  <td
                    className={`${styles.productCellInner} ${styles.right} ${styles.mutedCell}`}
                  >
                    {row.cost}
                  </td>
                  <td
                    className={`${styles.productCellInner} ${styles.right} ${styles.strongCell}`}
                  >
                    {row.value}
                  </td>
                  <td className={`${styles.productCellInner} ${styles.right}`}>
                    <span className={`${styles.roasChip} ${chipToneClass(row.roasTone)}`}>
                      {row.roas}
                    </span>
                  </td>
                  <td className={styles.productCellEdge}>
                    <span className={`${styles.statusChip} ${chipToneClass(row.issueTone)}`}>
                      {row.issue}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className={styles.allocationCard} data-google-allocation-read="true">
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Allocation read</h2>
            <span className={styles.cardSubtitle}>advisor · product allocation</span>
          </div>
          <div className={styles.allocationBody}>
            {model.allocation.map((block) => (
              <div key={block.key}>
                <p className={styles.allocationLabel}>{block.label}</p>
                <div className={styles.allocationItems}>
                  {block.items.map((item, index) => (
                    <span className={styles.allocationChip} key={`${block.key}-${index}`}>
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            <p className={styles.allocationNote}>
              Cluster reads are directional — restructures apply from Advisor →
              Plan as guarded writes.
            </p>
          </div>
        </article>
      </div>

      <p className={styles.footnote}>
        A disapproval blocks the whole listing group — the fix lives in Merchant
        Center, never edited here.
      </p>
    </section>
  );
}
