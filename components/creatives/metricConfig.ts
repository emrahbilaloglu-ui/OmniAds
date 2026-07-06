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

export type MetaAiTagKey = (typeof META_AI_TAG_KEYS)[number];
export type MetaAiTags = Partial<Record<MetaAiTagKey, string[]>>;
export type PreviewState = "preview" | "catalog" | "unavailable";
export type PreviewRenderMode = "video" | "image" | "unavailable";
export type PreviewSource = "preview_url" | "thumbnail_url" | "image_url" | "image_hash" | null;
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
  creativeId: string;
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
  objectStoryId?: string | null;
  effectiveObjectStoryId?: string | null;
  postId?: string | null;
  copyText?: string | null;
  copyVariants?: string[];
  headlineVariants?: string[];
  descriptionVariants?: string[];
  name: string;
  associatedAdsCount: number;
  accountId: string | null;
  accountName: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  effectiveStatus?: string | null;
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
  format: (value: number) => string;
};

const formatCurrency = (value: number) => `$${value.toLocaleString()}`;
const formatCurrencyFixed = (value: number) => `$${value.toFixed(2)}`;
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
    format: formatCurrencyFixed,
  },
  cpcLink: {
    label: "CPC (link)",
    goodDirection: "low",
    format: formatCurrencyFixed,
  },
  cpm: {
    label: "CPM",
    goodDirection: "low",
    format: formatCurrencyFixed,
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
