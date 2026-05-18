
import { formatMoney } from "@/components/creatives/money";
import {
  calculateCreativeAverageOrderValue,
  calculateCreativeClickToAddToCartRate,
  calculateCreativeClickToPurchaseRate,
  calculateCreativeCpcAll,
  calculateCreativeLinkCtr,
  calculateCreativePurchaseValueShare,
  calculateCreativePurchasesPer1000Impressions,
  calculateCreativeRevenuePer1000Impressions,
  calculateCreativeSpendShare,
  hasCreativeVideoEvidence,
} from "@/components/creatives/creative-truth";
import type { SharedCreative } from "@/components/creatives/shareCreativeTypes";

export type ShareTableColumnAlign = "left" | "right" | "center";

export const SHARE_TABLE_COLUMN_KEYS = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "cpcLink",
  "cpm",
  "cpcAll",
  "averageOrderValue",
  "clickToAtcRatio",
  "atcToPurchaseRatio",
  "purchases",
  "firstFrameRetention",
  "thumbstopRatio",
  "ctrOutbound",
  "clickToPurchaseRatio",
  "ctrAll",
  "video25Rate",
  "video50Rate",
  "video75Rate",
  "video100Rate",
  "holdRate",
  "hookScore",
  "ctaScore",
  "offerScore",
  "purchaseValueShare",
  "watchScore",
  "clickScore",
  "convertScore",
  "averageOrderValueWebsite",
  "averageOrderValueShop",
  "impressions",
  "spendShare",
  "linkCtr",
  "websitePurchaseRoas",
  "clickToWebsitePurchaseRatio",
  "purchasesPer1000Imp",
  "revenuePer1000Imp",
  "clicksAll",
  "linkClicks",
] as const;

export type ShareTableColumnKey = (typeof SHARE_TABLE_COLUMN_KEYS)[number];

type MetricDirectionMode = "higher_better" | "lower_better" | "neutral";
type MetricColorMode = "semantic" | "quantile" | "none";
type HeatTone = "strong_negative" | "negative" | "neutral" | "positive" | "strong_positive";
type HeatStrength = "strong" | "medium" | "soft";

interface MetricConfidenceThreshold {
  minSpend?: number;
  minImpressions?: number;
  minEstimatedViews?: number;
}

interface ShareTableMetricConfig {
  direction: MetricDirectionMode;
  colorMode: MetricColorMode;
  spendSensitive: boolean;
  heatStrength: HeatStrength;
  applicableFormats: SharedCreative["format"][];
  minConfidenceThreshold?: MetricConfidenceThreshold;
}

export interface ShareTableCalcContext {
  totalSpend: number;
  totalPurchaseValue: number;
}

export interface ShareTableColumnDefinition {
  key: ShareTableColumnKey;
  label: string;
  minWidth: number;
  align: ShareTableColumnAlign;
  format: (n: number, row: SharedCreative) => string;
  getValue: (row: SharedCreative, ctx: ShareTableCalcContext) => number;
}

interface MetricDistribution {
  min: number;
  max: number;
  avg: number;
  median: number;
  q1: number;
  q3: number;
  p20: number;
  p40: number;
  p60: number;
  p80: number;
  sorted: number[];
}

export interface ShareHeatEvaluation {
  tone: HeatTone;
  intensity: number;
  reason: string;
  applicable: boolean;
}

const DEFAULT_METRIC_CONFIG: ShareTableMetricConfig = {
  direction: "neutral",
  colorMode: "none",
  spendSensitive: false,
  heatStrength: "soft",
  applicableFormats: ["image", "video"],
};

const VIDEO_CONFIDENCE_THRESHOLD: MetricConfidenceThreshold = {
  minSpend: 50,
  minImpressions: 1000,
  minEstimatedViews: 200,
};

const VIDEO_ONLY_FORMATS: SharedCreative["format"][] = ["video"];
const STANDARD_FORMATS: SharedCreative["format"][] = ["image", "video"];

const METRIC_CONFIG: Partial<Record<ShareTableColumnKey, ShareTableMetricConfig>> = {
  spend: { direction: "neutral", colorMode: "none", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  purchaseValue: { direction: "higher_better", colorMode: "quantile", spendSensitive: true, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  roas: { direction: "higher_better", colorMode: "semantic", spendSensitive: true, heatStrength: "strong", applicableFormats: STANDARD_FORMATS },
  cpa: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, heatStrength: "strong", applicableFormats: STANDARD_FORMATS },
  cpcLink: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, heatStrength: "medium", applicableFormats: STANDARD_FORMATS },
  cpm: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, heatStrength: "medium", applicableFormats: STANDARD_FORMATS },
  cpcAll: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, heatStrength: "medium", applicableFormats: STANDARD_FORMATS },
  averageOrderValue: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  clickToAtcRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  atcToPurchaseRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  purchases: { direction: "higher_better", colorMode: "quantile", spendSensitive: true, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  firstFrameRetention: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: VIDEO_ONLY_FORMATS, minConfidenceThreshold: VIDEO_CONFIDENCE_THRESHOLD },
  thumbstopRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: VIDEO_ONLY_FORMATS, minConfidenceThreshold: VIDEO_CONFIDENCE_THRESHOLD },
  ctrOutbound: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  clickToPurchaseRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  ctrAll: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  video25Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: VIDEO_ONLY_FORMATS, minConfidenceThreshold: VIDEO_CONFIDENCE_THRESHOLD },
  video50Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: VIDEO_ONLY_FORMATS, minConfidenceThreshold: VIDEO_CONFIDENCE_THRESHOLD },
  video75Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: VIDEO_ONLY_FORMATS, minConfidenceThreshold: VIDEO_CONFIDENCE_THRESHOLD },
  video100Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: VIDEO_ONLY_FORMATS, minConfidenceThreshold: VIDEO_CONFIDENCE_THRESHOLD },
  holdRate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: VIDEO_ONLY_FORMATS, minConfidenceThreshold: VIDEO_CONFIDENCE_THRESHOLD },
  hookScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  ctaScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  offerScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  purchaseValueShare: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  watchScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  clickScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  convertScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  averageOrderValueWebsite: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  averageOrderValueShop: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  impressions: { direction: "neutral", colorMode: "none", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  spendShare: { direction: "neutral", colorMode: "none", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  linkCtr: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  websitePurchaseRoas: { direction: "higher_better", colorMode: "semantic", spendSensitive: true, heatStrength: "strong", applicableFormats: STANDARD_FORMATS },
  clickToWebsitePurchaseRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  purchasesPer1000Imp: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  revenuePer1000Imp: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  clicksAll: { direction: "neutral", colorMode: "none", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
  linkClicks: { direction: "neutral", colorMode: "none", spendSensitive: false, heatStrength: "soft", applicableFormats: STANDARD_FORMATS },
};

const HEAT_STRENGTH_MULTIPLIER: Record<HeatStrength, number> = {
  strong: 1,
  medium: 0.82,
  soft: 0.62,
};

const HEAT_PALETTE: Record<HeatTone, [number, number, number]> = {
  strong_negative: [244, 63, 94],
  negative: [251, 113, 133],
  neutral: [148, 163, 184],
  positive: [52, 211, 153],
  strong_positive: [16, 185, 129],
};

const fmtCurrency = (n: number, row: SharedCreative) =>
  formatMoney(n, row.currency ?? null, row.currency ?? null);
const fmtPercent = (n: number) => `${n.toFixed(2)}%`;
const fmtInteger = (n: number) => Math.round(n).toLocaleString();
const fmtDecimal = (n: number) => n.toFixed(2);
const fmtScore = (n: number) => Number.isFinite(n) ? Math.round(n).toLocaleString() : "—";

const safeDivide = (numerator: number, denominator: number): number =>
  denominator > 0 ? numerator / denominator : 0;

const SCORE_COLUMNS = new Set<ShareTableColumnKey>([
  "hookScore",
  "ctaScore",
  "offerScore",
  "clickScore",
  "watchScore",
]);

function scoreValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : Number.NaN;
}

function hasScoreValue(row: SharedCreative, key: ShareTableColumnKey): boolean {
  if (key === "hookScore") return Number.isFinite(scoreValue(row.hookScore));
  if (key === "ctaScore") return Number.isFinite(scoreValue(row.ctaScore));
  if (key === "offerScore") return Number.isFinite(scoreValue(row.offerScore));
  if (key === "clickScore") return Number.isFinite(scoreValue(row.clickScore));
  if (key === "watchScore") return Number.isFinite(scoreValue(row.watchScore));
  return false;
}

export const SHARE_TABLE_COLUMNS: ShareTableColumnDefinition[] = [
  { key: "spend", label: "Spend", minWidth: 130, align: "right", format: fmtCurrency, getValue: (r) => r.spend },
  { key: "purchaseValue", label: "Purchase value", minWidth: 140, align: "right", format: fmtCurrency, getValue: (r) => r.purchaseValue },
  { key: "roas", label: "ROAS (return on ad spend)", minWidth: 92, align: "right", format: fmtDecimal, getValue: (r) => r.roas },
  { key: "cpa", label: "Cost per purchase", minWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => r.cpa },
  { key: "cpcLink", label: "Cost per link click", minWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => r.cpcLink ?? 0 },
  { key: "cpm", label: "Cost per mille", minWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => r.cpm ?? 0 },
  { key: "cpcAll", label: "Cost per click (all)", minWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeCpcAll(r) },
  { key: "averageOrderValue", label: "Average order value", minWidth: 132, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeAverageOrderValue(r) },
  { key: "clickToAtcRatio", label: "Click to add-to-cart ratio", minWidth: 170, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeClickToAddToCartRate(r) },
  { key: "atcToPurchaseRatio", label: "Add-to-cart to purchase ratio", minWidth: 180, align: "right", format: fmtPercent, getValue: (r) => r.atcToPurchaseRatio ?? 0 },
  { key: "purchases", label: "Purchases", minWidth: 84, align: "right", format: fmtInteger, getValue: (r) => r.purchases },
  { key: "firstFrameRetention", label: "First-impression proxy (thumbstop)", minWidth: 205, align: "right", format: fmtPercent, getValue: (r) => r.thumbstop ?? 0 },
  { key: "thumbstopRatio", label: "Thumbstop ratio", minWidth: 140, align: "right", format: fmtPercent, getValue: (r) => r.thumbstop ?? 0 },
  { key: "ctrOutbound", label: "Link CTR (compat)", minWidth: 140, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeLinkCtr(r) },
  { key: "clickToPurchaseRatio", label: "Click to purchase ratio", minWidth: 165, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeClickToPurchaseRate(r) },
  { key: "ctrAll", label: "Click through rate (all)", minWidth: 150, align: "right", format: fmtPercent, getValue: (r) => r.ctrAll },
  { key: "video25Rate", label: "25% video plays (rate)", minWidth: 165, align: "right", format: fmtPercent, getValue: (r) => r.video25 ?? 0 },
  { key: "video50Rate", label: "50% video plays (rate)", minWidth: 165, align: "right", format: fmtPercent, getValue: (r) => r.video50 ?? 0 },
  { key: "video75Rate", label: "75% video plays (rate)", minWidth: 165, align: "right", format: fmtPercent, getValue: (r) => r.video75 ?? 0 },
  { key: "video100Rate", label: "100% video plays (rate)", minWidth: 170, align: "right", format: fmtPercent, getValue: (r) => r.video100 ?? 0 },
  { key: "holdRate", label: "Completion proxy (100% plays)", minWidth: 190, align: "right", format: fmtPercent, getValue: (r) => r.video100 ?? 0 },
  { key: "hookScore", label: "Hook", minWidth: 110, align: "right", format: fmtScore, getValue: (r) => scoreValue(r.hookScore) },
  { key: "ctaScore", label: "CTA", minWidth: 100, align: "right", format: fmtScore, getValue: (r) => scoreValue(r.ctaScore) },
  { key: "offerScore", label: "Offer", minWidth: 110, align: "right", format: fmtScore, getValue: (r) => scoreValue(r.offerScore) },
  { key: "purchaseValueShare", label: "% purchase value", minWidth: 145, align: "right", format: fmtPercent, getValue: (r, c) => calculateCreativePurchaseValueShare(r, c.totalPurchaseValue) },
  { key: "watchScore", label: "Watch", minWidth: 110, align: "right", format: fmtScore, getValue: (r) => scoreValue(r.watchScore) },
  { key: "clickScore", label: "Click", minWidth: 110, align: "right", format: fmtScore, getValue: (r) => scoreValue(r.clickScore) },
  { key: "convertScore", label: "Conversion proxy (ROAS x10)", minWidth: 185, align: "right", format: fmtDecimal, getValue: (r) => r.roas * 10 },
  { key: "averageOrderValueWebsite", label: "Average order value (website)", minWidth: 195, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeAverageOrderValue(r) },
  { key: "averageOrderValueShop", label: "Average order value (Shop)", minWidth: 185, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeAverageOrderValue(r) },
  { key: "impressions", label: "Impressions", minWidth: 140, align: "right", format: fmtInteger, getValue: (r) => r.impressions ?? 0 },
  { key: "spendShare", label: "% spend", minWidth: 120, align: "right", format: fmtPercent, getValue: (r, c) => calculateCreativeSpendShare(r, c.totalSpend) },
  { key: "linkCtr", label: "Link CTR", minWidth: 110, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeLinkCtr(r) },
  { key: "websitePurchaseRoas", label: "Website purchase ROAS", minWidth: 165, align: "right", format: fmtDecimal, getValue: (r) => r.roas },
  { key: "clickToWebsitePurchaseRatio", label: "Click to website purchase ratio", minWidth: 210, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeClickToPurchaseRate(r) },
  { key: "purchasesPer1000Imp", label: "Purchases per 1,000 impressions", minWidth: 230, align: "right", format: fmtDecimal, getValue: (r) => calculateCreativePurchasesPer1000Impressions(r) },
  { key: "revenuePer1000Imp", label: "Revenue per 1,000 impressions", minWidth: 220, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeRevenuePer1000Impressions(r) },
  { key: "clicksAll", label: "Clicks (all)", minWidth: 130, align: "right", format: fmtInteger, getValue: (r) => r.clicks ?? 0 },
  { key: "linkClicks", label: "Link clicks", minWidth: 130, align: "right", format: fmtInteger, getValue: (r) => r.linkClicks ?? 0 },
];

export const SHARE_TABLE_COLUMN_MAP: Record<ShareTableColumnKey, ShareTableColumnDefinition> =
  SHARE_TABLE_COLUMNS.reduce((acc, column) => {
    acc[column.key] = column;
    return acc;
  }, {} as Record<ShareTableColumnKey, ShareTableColumnDefinition>);

function metricConfig(key: ShareTableColumnKey): ShareTableMetricConfig {
  return METRIC_CONFIG[key] ?? DEFAULT_METRIC_CONFIG;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;

  const idx = (sorted.length - 1) * ratio;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);

  if (lo === hi) return sorted[lo];

  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function hasVideoEvidence(row: SharedCreative): boolean {
  return hasCreativeVideoEvidence({
    format: row.format,
    thumbstop: row.thumbstop ?? 0,
    video25: row.video25 ?? 0,
    video50: row.video50 ?? 0,
    video75: row.video75 ?? 0,
    video100: row.video100 ?? 0,
  });
}

export function isShareMetricApplicable(key: ShareTableColumnKey, row: SharedCreative): boolean {
  const cfg = metricConfig(key);

  if (SCORE_COLUMNS.has(key)) {
    return hasScoreValue(row, key);
  }

  if (cfg.applicableFormats.includes("video") && cfg.applicableFormats.length === 1) {
    return hasVideoEvidence(row);
  }

  return cfg.applicableFormats.includes(row.format);
}

function buildDistribution(values: number[]): MetricDistribution {
  const sorted = [...values].sort((a, b) => a - b);

  if (sorted.length === 0) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      median: 0,
      q1: 0,
      q3: 0,
      p20: 0,
      p40: 0,
      p60: 0,
      p80: 0,
      sorted: [],
    };
  }

  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    median: percentile(sorted, 0.5),
    q1: percentile(sorted, 0.25),
    q3: percentile(sorted, 0.75),
    p20: percentile(sorted, 0.2),
    p40: percentile(sorted, 0.4),
    p60: percentile(sorted, 0.6),
    p80: percentile(sorted, 0.8),
    sorted,
  };
}

function quantilePosition(value: number, distribution: MetricDistribution): number {
  const values = distribution.sorted;
  if (values.length === 0) return 0.5;

  let count = 0;
  for (const entry of values) {
    if (entry <= value) count += 1;
  }
  return count / values.length;
}

function downgradeTone(tone: HeatTone): HeatTone {
  if (tone === "strong_positive") return "positive";
  if (tone === "positive") return "neutral";
  if (tone === "neutral") return "negative";
  if (tone === "negative") return "strong_negative";
  return "strong_negative";
}

export function buildShareTableCalcContext(rows: SharedCreative[]): ShareTableCalcContext {
  return {
    totalSpend: rows.reduce((sum, row) => sum + row.spend, 0),
    totalPurchaseValue: rows.reduce((sum, row) => sum + row.purchaseValue, 0),
  };
}

export function buildShareDistributions(input: {
  benchmarkRows: SharedCreative[];
  benchmarkCtx: ShareTableCalcContext;
}): {
  value: Partial<Record<ShareTableColumnKey, MetricDistribution>>;
  spend: Partial<Record<ShareTableColumnKey, MetricDistribution>>;
} {
  const { benchmarkRows, benchmarkCtx } = input;

  const value = SHARE_TABLE_COLUMNS.reduce<Partial<Record<ShareTableColumnKey, MetricDistribution>>>(
    (acc, column) => {
      const values = benchmarkRows
        .filter((row) => isShareMetricApplicable(column.key, row))
        .map((row) => column.getValue(row, benchmarkCtx))
        .filter((n) => Number.isFinite(n));
      acc[column.key] = buildDistribution(values);
      return acc;
    },
    {}
  );

  const spend = SHARE_TABLE_COLUMNS.reduce<Partial<Record<ShareTableColumnKey, MetricDistribution>>>(
    (acc, column) => {
      const values = benchmarkRows
        .filter((row) => isShareMetricApplicable(column.key, row))
        .map((row) => row.spend)
        .filter((n) => Number.isFinite(n));
      acc[column.key] = buildDistribution(values);
      return acc;
    },
    {}
  );

  return { value, spend };
}

export function evaluateShareMetricCell(input: {
  key: ShareTableColumnKey;
  row: SharedCreative;
  value: number;
  distribution: MetricDistribution;
  roasDistribution: MetricDistribution;
  spendDistribution: MetricDistribution;
}): ShareHeatEvaluation {
  const { key, row, value, distribution, roasDistribution, spendDistribution } = input;
  const cfg = metricConfig(key);

  if (!isShareMetricApplicable(key, row)) {
    return {
      tone: "neutral",
      intensity: 0,
      reason: "Metric is not applicable for this creative format.",
      applicable: false,
    };
  }

  if (cfg.colorMode === "none") {
    return {
      tone: "neutral",
      intensity: 0.07,
      reason: "Neutral metric: no strong heatmap is applied.",
      applicable: true,
    };
  }

  let evaluation: ShareHeatEvaluation;

  if (cfg.colorMode === "semantic" && (key === "roas" || key === "websitePurchaseRoas")) {
    if (value < 1) {
      evaluation = { tone: "strong_negative", intensity: 0.95, reason: "ROAS below 1.0 (unprofitable).", applicable: true };
    } else if (value < 2) {
      evaluation = { tone: "negative", intensity: 0.72, reason: "ROAS between 1.0 and 2.0 (weak).", applicable: true };
    } else if (value < 3) {
      evaluation = { tone: "negative", intensity: 0.42, reason: "ROAS between 2.0 and 3.0 (below target).", applicable: true };
    } else if (value < 4) {
      evaluation = { tone: "neutral", intensity: 0.24, reason: "ROAS between 3.0 and 4.0 (neutral).", applicable: true };
    } else if (value <= 6) {
      evaluation = { tone: "positive", intensity: 0.64, reason: "ROAS between 4.0 and 6.0 (good).", applicable: true };
    } else {
      evaluation = { tone: "strong_positive", intensity: 0.9, reason: "ROAS above 6.0 (very good).", applicable: true };
    }
  } else if (cfg.colorMode === "semantic" && cfg.direction === "lower_better") {
    const median = Math.max(distribution.median, 0.000001);
    const nearBand = Math.max(median * 0.1, 0.05);

    if (value <= distribution.q1 * 0.95) {
      evaluation = { tone: "strong_positive", intensity: 0.78, reason: "Meaningfully below account distribution.", applicable: true };
    } else if (value < median - nearBand) {
      evaluation = { tone: "positive", intensity: 0.55, reason: "Below account median cost.", applicable: true };
    } else if (Math.abs(value - median) <= nearBand) {
      evaluation = { tone: "neutral", intensity: 0.2, reason: "Close to account median cost.", applicable: true };
    } else if (value <= distribution.q3 * 1.05) {
      evaluation = { tone: "negative", intensity: 0.45, reason: "Above account median cost.", applicable: true };
    } else {
      evaluation = { tone: "strong_negative", intensity: 0.72, reason: "Meaningfully above account distribution.", applicable: true };
    }
  } else {
    const raw = quantilePosition(value, distribution);
    const q = cfg.direction === "lower_better" ? 1 - raw : raw;

    if (q < 0.15) {
      evaluation = { tone: "strong_negative", intensity: 0.58, reason: "Bottom quantile band.", applicable: true };
    } else if (q < 0.35) {
      evaluation = { tone: "negative", intensity: 0.38, reason: "Below median band.", applicable: true };
    } else if (q <= 0.65) {
      evaluation = { tone: "neutral", intensity: 0.2, reason: "Middle quantile band.", applicable: true };
    } else if (q <= 0.85) {
      evaluation = { tone: "positive", intensity: 0.4, reason: "Upper quantile band.", applicable: true };
    } else {
      evaluation = { tone: "strong_positive", intensity: 0.6, reason: "Top quantile band.", applicable: true };
    }
  }

  if ((key === "purchaseValue" || key === "purchases") && row.roas < roasDistribution.avg * 0.9) {
    if (evaluation.tone === "positive" || evaluation.tone === "strong_positive") {
      evaluation = {
        ...evaluation,
        tone: downgradeTone(evaluation.tone),
        intensity: evaluation.intensity * 0.72,
        reason: `${evaluation.reason} Efficiency-adjusted due to below-average ROAS.`,
      };
    }
  }

  if (cfg.spendSensitive) {
    const spendRef = Math.max(spendDistribution.q3, spendDistribution.median, 1);
    const spendRatio = clamp(row.spend / spendRef, 0, 1.4);
    const confidence = clamp(0.3 + spendRatio * 0.6, 0.22, 1);
    evaluation = {
      ...evaluation,
      intensity: evaluation.intensity * confidence,
      reason: `${evaluation.reason} Spend confidence ${(confidence * 100).toFixed(0)}%.`,
    };
  }

  if (cfg.minConfidenceThreshold) {
    const estimatedViews =
      (row.impressions ?? 0) > 0 ? ((row.thumbstop ?? 0) / 100) * (row.impressions ?? 0) : 0;
    const spendConfidence = cfg.minConfidenceThreshold.minSpend
      ? clamp(row.spend / cfg.minConfidenceThreshold.minSpend, 0, 1)
      : 1;
    const impressionsConfidence = cfg.minConfidenceThreshold.minImpressions
      ? clamp((row.impressions ?? 0) / cfg.minConfidenceThreshold.minImpressions, 0, 1)
      : 1;
    const viewsConfidence = cfg.minConfidenceThreshold.minEstimatedViews
      ? clamp(estimatedViews / cfg.minConfidenceThreshold.minEstimatedViews, 0, 1)
      : 1;
    const confidence = Math.min(spendConfidence, impressionsConfidence, viewsConfidence);

    if (confidence < 0.35) {
      return {
        tone: "neutral",
        intensity: 0.08,
        reason: `${evaluation.reason} Low-confidence sample for this video metric.`,
        applicable: true,
      };
    }

    evaluation = {
      ...evaluation,
      intensity: evaluation.intensity * clamp(0.4 + confidence * 0.6, 0.3, 1),
      reason: `${evaluation.reason} Data confidence ${(confidence * 100).toFixed(0)}%.`,
    };
  }

  return {
    ...evaluation,
    intensity: clamp(evaluation.intensity * HEAT_STRENGTH_MULTIPLIER[cfg.heatStrength], 0.06, 0.95),
    applicable: true,
  };
}

export function toShareHeatColor(tone: ShareHeatEvaluation["tone"], intensity: number): string {
  if (intensity <= 0) return "transparent";

  const alpha = clamp(intensity * 0.24, 0.035, 0.28);
  const [r, g, b] = HEAT_PALETTE[tone];
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
