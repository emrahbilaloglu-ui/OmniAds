/**
 * The three keyword diagnostics the Search screen's keyword tallies read.
 *
 * One definition, shared by the live report path (`lib/google-ads/reporting`)
 * and the warehouse serving path (`lib/google-ads/serving`), so the number the
 * screen prints cannot depend on which reader served the window.
 *
 * Units, as both readers already emit them:
 *  - `ctr` is a percentage — `5.8` means 5.8%.
 *  - `impressionShare` is a fraction — `0.41` means 41%.
 */

export interface GoogleAdsKeywordInsightRow {
  ctr?: number | null;
  clicks?: number | null;
  conversions?: number | null;
  spend?: number | null;
  impressionShare?: number | null;
}

export interface GoogleAdsKeywordInsightCounts {
  /** High click-through, no conversion: the click is bought, the sale is not. */
  highCtrLowConvCount: number;
  /** Converting, but Google is withholding most of its available impressions. */
  highConvLowBudgetCount: number;
  /** Enough proven volume and spend to justify its own ad group. */
  deserveOwnAdGroupCount: number;
}

const HIGH_CTR_PERCENT = 5;
const MIN_CLICKS_FOR_CTR_READ = 20;
const CONVERTING_MIN_CONVERSIONS = 3;
const LOW_IMPRESSION_SHARE_FRACTION = 0.4;
const OWN_AD_GROUP_MIN_CONVERSIONS = 5;
const OWN_AD_GROUP_MIN_SPEND = 100;

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isHighCtrZeroConversionKeyword(row: GoogleAdsKeywordInsightRow) {
  return (
    numeric(row.ctr) > HIGH_CTR_PERCENT &&
    numeric(row.conversions) === 0 &&
    numeric(row.clicks) >= MIN_CLICKS_FOR_CTR_READ
  );
}

export function isConvertingLowImpressionShareKeyword(
  row: GoogleAdsKeywordInsightRow,
) {
  return (
    numeric(row.conversions) >= CONVERTING_MIN_CONVERSIONS &&
    typeof row.impressionShare === "number" &&
    Number.isFinite(row.impressionShare) &&
    row.impressionShare < LOW_IMPRESSION_SHARE_FRACTION
  );
}

export function deservesOwnAdGroup(row: GoogleAdsKeywordInsightRow) {
  return (
    numeric(row.conversions) >= OWN_AD_GROUP_MIN_CONVERSIONS &&
    numeric(row.spend) > OWN_AD_GROUP_MIN_SPEND
  );
}

export function countGoogleAdsKeywordInsights(
  rows: readonly GoogleAdsKeywordInsightRow[],
): GoogleAdsKeywordInsightCounts {
  return {
    highCtrLowConvCount: rows.filter(isHighCtrZeroConversionKeyword).length,
    highConvLowBudgetCount: rows.filter(isConvertingLowImpressionShareKeyword)
      .length,
    deserveOwnAdGroupCount: rows.filter(deservesOwnAdGroup).length,
  };
}
