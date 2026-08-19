import type {
  CreativePreviewManifest,
  CreativeDeliveryType,
  CreativeFormat,
  CreativePrimaryType,
  CreativeSecondaryType,
  CreativeTaxonomySource,
  CreativeTaxonomyVersion,
  CreativeType,
  CreativeVisualFormat,
} from "@/lib/meta/creatives-types";
import { formatMoney } from "@/components/creatives/money";

export const META_METRIC_KEYS = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "cpcLink",
  "cpm",
  "ctrAll",
  "purchases",
  "thumbstop",
  "video25",
  "video50",
  "clickToPurchase",
  "atcToPurchaseRatio",
] as const;

export type MetaMetricKey = (typeof META_METRIC_KEYS)[number];

export const META_AI_TAG_KEYS = [
  "assetType",
  "visualFormat",
  "intendedAudience",
  "messagingAngle",
  "seasonality",
  "offerType",
  "hookTactic",
  "headlineTactic",
] as const;

/**
 * The metric fields whose availability travels with the row.
 *
 * `MetaCreativeRow` keeps every metric typed `number` because dozens of
 * consumers do arithmetic on them, and widening those to `number | null` would
 * change resolvers and ratio math this pass must not touch. The availability
 * fact still has to reach the UI, so it travels beside the numbers instead of
 * replacing them.
 */
export const META_OBSERVED_METRIC_KEYS = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "cpcLink",
  "cpm",
  "ctrAll",
  "purchases",
  "impressions",
  "clicks",
  "linkClicks",
  "landingPageViews",
  "addToCart",
  "initiateCheckout",
  "thumbstop",
  "clickToAddToCart",
  "atcToPurchaseRatio",
  "frequency",
  "leads",
  "messages",
  "video25",
  "video50",
  "video75",
  "video100",
] as const;

export type MetaObservedMetricKey = (typeof META_OBSERVED_METRIC_KEYS)[number];

/**
 * Per-metric availability, carried as nullable values.
 *
 * A key holding a number was served by the producer — **including 0, which is a
 * measurement**: a paused, never-delivered line really did spend nothing, and
 * hiding that behind an em dash is as dishonest as inventing a figure. A key
 * holding `null` was not served and must render as an em dash.
 *
 * This replaces the older all-or-nothing rule at the presentation boundary. One
 * absent field used to withhold every number on the row, so a real measured
 * spend disappeared because, say, `leads` was missing from the payload.
 */
export type MetaCreativeObservedMetrics = Partial<
  Record<MetaObservedMetricKey, number | null>
>;

export type MetaAiTagKey = (typeof META_AI_TAG_KEYS)[number];
export type MetaAiTags = Partial<Record<MetaAiTagKey, string[]>>;
export type PreviewState = "preview" | "catalog" | "unavailable";
export type PreviewRenderMode = "video" | "image" | "unavailable";
export type PreviewSource =
  "preview_url" | "thumbnail_url" | "image_url" | "image_hash" | null;
export type PreviewReadiness = "ready" | "pending" | "missing";
export type PreviewOrigin = "snapshot" | "cache" | "live" | "fallback" | null;

export interface MetaCreativePreview {
  render_mode: PreviewRenderMode;
  image_url: string | null;
  video_url: string | null;
  poster_url: string | null;
  source: PreviewSource;
  is_catalog: boolean;
}

export interface MetaCreativeScoreBreakdown {
  hook?: number | null;
  cta?: number | null;
  offer?: number | null;
  click?: number | null;
  watch?: number | null;
}

export interface MetaCreativeScoreGap {
  label?: string | null;
  severity?: "none" | "watch" | "action" | null;
}

export interface MetaCreativeRow {
  id: string;
  /**
   * `null` when the provider supplied no creative for this row. It used to be
   * non-nullable, so the copies mapper substituted the copy row id to satisfy
   * the type — which made every row look draftable and offered an enabled
   * control the server then refused.
   */
  creativeId: string | null;
  realAdId?: string | null;
  launchpadRecentAction?: {
    action: "launch_ad" | "duplicate";
    requestedAt: string;
    resultingAdId: string;
    sourceAdId: string | null;
    sourceName: string | null;
    targetCampaignId: string | null;
    targetCampaignName: string | null;
    targetAdsetId: string | null;
    targetAdsetName: string | null;
  } | null;
  /**
   * Provider-result rows can exist before performance facts accrue. Numeric
   * placeholders remain in the legacy row shape, but consumers must withhold
   * them when this flag is unavailable.
   */
  metricsAvailability?: "available" | "unavailable";
  /**
   * Which metrics the producer actually served, and what it served.
   *
   * Absent means the producer of this row does not publish per-metric
   * availability; readers then fall back to `metricsAvailability`, which is the
   * only fact such a row carries.
   */
  observedMetrics?: MetaCreativeObservedMetrics;
  objectStoryId?: string | null;
  effectiveObjectStoryId?: string | null;
  postId?: string | null;
  copyText?: string | null;
  copyVariants?: string[];
  headlineVariants?: string[];
  descriptionVariants?: string[];
  name: string;
  associatedAdsCount: number;
  /** False when the provider payload omitted usage-count evidence. */
  associatedAdsCountAvailable?: boolean;
  accountId: string | null;
  accountName: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  effectiveStatus?: string | null;
  objective?: string | null;
  optimizationGoal?: string | null;
  attributionSetting?: string | null;
  bidStrategy?: string | null;
  currency: string | null;
  format: CreativeFormat;
  creativeType: CreativeType;
  creativeTypeLabel: string;
  creativeDeliveryType: CreativeDeliveryType;
  creativeVisualFormat: CreativeVisualFormat;
  creativePrimaryType: CreativePrimaryType;
  creativePrimaryLabel: string | null;
  creativeSecondaryType: CreativeSecondaryType | null;
  creativeSecondaryLabel: string | null;
  taxonomyVersion?: CreativeTaxonomyVersion;
  taxonomySource?: CreativeTaxonomySource | null;
  taxonomyReconciledByVideoEvidence?: boolean;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  imageUrl: string | null;
  tableThumbnailUrl?: string | null;
  cardPreviewUrl?: string | null;
  previewManifest?: CreativePreviewManifest | null;
  cachedThumbnailUrl?: string | null;
  previewStatus?: PreviewReadiness;
  previewOrigin?: PreviewOrigin;
  isCatalog: boolean;
  previewState: PreviewState;
  preview: MetaCreativePreview;
  launchDate: string;
  tags: string[];
  aiTags: MetaAiTags;
  creativeScores?: MetaCreativeScoreBreakdown | null;
  creativeScoreGap?: MetaCreativeScoreGap | null;
  hookScore?: number | null;
  ctaScore?: number | null;
  offerScore?: number | null;
  clickScore?: number | null;
  watchScore?: number | null;
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  cpcLink: number;
  cpm: number;
  ctrAll: number;
  linkCtr: number;
  purchases: number;
  impressions: number;
  clicks: number;
  frequency?: number | null;
  linkClicks: number;
  landingPageViews: number;
  addToCart: number;
  initiateCheckout: number;
  leads: number;
  messages: number;
  thruplayActions?: number;
  thumbstop: number;
  clickToAddToCart: number;
  clickToPurchase: number;
  video25: number;
  video50: number;
  video75: number;
  video100: number;
  atcToPurchaseRatio: number;
}

type GoodDirection = "high" | "low" | "neutral";

type MetricConfigItem = {
  label: string;
  goodDirection: GoodDirection;
  format: (
    value: number,
    currency?: string | null,
  ) => string;
};

const formatCurrency = (
  value: number,
  currency?: string | null,
) => formatMoney(value, currency, null);
const formatNumber = (value: number) => value.toLocaleString();
const formatPercent = (value: number) => `${value.toFixed(2)}%`;
const formatDecimal = (value: number) => value.toFixed(2);

export const METRIC_CONFIG: Record<MetaMetricKey, MetricConfigItem> = {
  spend: {
    label: "Spend",
    goodDirection: "neutral",
    format: formatCurrency,
  },
  purchaseValue: {
    label: "Purchase value",
    goodDirection: "high",
    format: formatCurrency,
  },
  roas: {
    label: "ROAS",
    goodDirection: "high",
    format: formatDecimal,
  },
  cpa: {
    label: "CPA",
    goodDirection: "low",
    format: formatCurrency,
  },
  cpcLink: {
    label: "CPC (link)",
    goodDirection: "low",
    format: formatCurrency,
  },
  cpm: {
    label: "CPM",
    goodDirection: "low",
    format: formatCurrency,
  },
  ctrAll: {
    label: "CTR (all)",
    goodDirection: "high",
    format: formatPercent,
  },
  purchases: {
    label: "Purchases",
    goodDirection: "high",
    format: formatNumber,
  },
  thumbstop: {
    label: "Thumbstop",
    goodDirection: "high",
    format: formatPercent,
  },
  video25: {
    label: "25% video plays rate",
    goodDirection: "high",
    format: formatPercent,
  },
  video50: {
    label: "50% video plays rate",
    goodDirection: "high",
    format: formatPercent,
  },
  clickToPurchase: {
    label: "Click to purchase",
    goodDirection: "high",
    format: formatPercent,
  },
  atcToPurchaseRatio: {
    label: "ATC to purchase ratio",
    goodDirection: "high",
    format: formatPercent,
  },
};

export const METRIC_OPTIONS: MetaMetricKey[] = [...META_METRIC_KEYS];

export const DEFAULT_TABLE_METRICS: MetaMetricKey[] = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "cpcLink",
  "cpm",
  "ctrAll",
  "purchases",
];
