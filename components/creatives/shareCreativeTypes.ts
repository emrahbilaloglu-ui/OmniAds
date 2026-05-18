/**
 * Metric keys supported in shared creative reports
 */
export const SHARE_METRIC_KEYS = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "cpcLink",
  "cpm",
  "ctrAll",
  "linkCtr",
  "purchases",
  "impressions",
  "clicks",
  "linkClicks",
  "addToCart",
  "thumbstop",
  "clickToAddToCart",
  "clickToPurchase",
  "video25",
  "video50",
  "video75",
  "video100",
  "atcToPurchaseRatio",
  "leads",
  "messages",
  "hookScore",
  "ctaScore",
  "offerScore",
  "clickScore",
  "watchScore",
] as const;

export type ShareMetricKey = (typeof SHARE_METRIC_KEYS)[number];

/**
 * Render preview returned from backend
 */
export interface ShareCreativePreview {
  render_mode: "video" | "image" | "unavailable";
  image_url: string | null;
  video_url: string | null;
  poster_url: string | null;
  source: "preview_url" | "thumbnail_url" | "image_url" | "image_hash" | null;
  is_catalog: boolean;
}

export interface SharedCreativeAnalysisFactor {
  label: string;
  value: string;
  reason: string;
  impact: "positive" | "negative" | "neutral";
}

export interface SharedCreativeAnalysis {
  creativeId: string;
  actionLabel: string;
  authorityLabel: string | null;
  confidenceLabel: "High" | "Medium" | "Limited";
  headline: string;
  summary: string;
  whatToDo: string;
  why: string;
  evidenceStrength: string | null;
  urgency: string | null;
  amountGuidance: string | null;
  benchmarkLabel: string | null;
  benchmarkReliability: string | null;
  previewState: string | null;
  businessValidationNote: string | null;
  nextObservation: string[];
  invalidActions: string[];
  factors: SharedCreativeAnalysisFactor[];
}

export interface SharedCreativeScoreGap {
  label: string;
  severity?: "none" | "watch" | "action" | "missing" | null;
}

/**
 * Creative object used in public share pages
 */
export interface SharedCreative {
  id: string;
  name: string;

  currency?: string | null;

  format: "image" | "video" | "catalog";
  previewState: "preview" | "catalog" | "unavailable";
  isCatalog: boolean;

  /** base image sources */
  previewUrl: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;

  /** optional optimized sources used by UI renderers */
  mediaPreviewUrl?: string | null;
  cardPreviewUrl?: string | null;
  tableThumbnailUrl?: string | null;
  cachedThumbnailUrl?: string | null;

  preview: ShareCreativePreview;

  launchDate: string;
  tags: string[];

  /** core metrics */
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctrAll: number;
  linkCtr?: number;
  purchases: number;

  /** optional metrics */
  cpcLink?: number;
  cpm?: number;
  impressions?: number;
  clicks?: number;
  linkClicks?: number;
  addToCart?: number;
  initiateCheckout?: number;
  leads?: number;
  messages?: number;
  thumbstop?: number;
  clickToAddToCart?: number;
  clickToPurchase?: number;
  video25?: number;
  video50?: number;
  video75?: number;
  video100?: number;
  atcToPurchaseRatio?: number;
  hookScore?: number | null;
  ctaScore?: number | null;
  offerScore?: number | null;
  clickScore?: number | null;
  watchScore?: number | null;
  creativeScoreGap?: SharedCreativeScoreGap | null;

  analysis?: SharedCreativeAnalysis | null;
}

/**
 * Configuration used when generating public share links
 */
export interface ShareLinkConfig {
  title: string;
  expiration: "3" | "7" | "14";
  metrics: ShareMetricKey[];
  includeNotes: boolean;
  passwordProtection: boolean;
  audience?: "buyer" | "creative_team" | "external";
  presetId?: string;
  presetLabel?: string;
  includeCampaignNames?: boolean;
  includeDecisionLanguage?: boolean;
  allowCsv?: boolean;
  snapshotOnly?: boolean;
}

/**
 * Configuration used when exporting PDF reports
 */
export interface ExportPdfConfig {
  title: string;
  includeSummary: boolean;
  includeNotes: boolean;
}

/**
 * Payload returned from backend for public share page
 */
export interface SharePayload {
  token: string;
  title: string;

  dateRange: string;
  createdAt: string;
  frozenAt?: string;
  expiresAt: string;
  openCount?: number;

  businessId?: string;
  groupBy?: string;

  filters?: string[];
  selectedRowIds?: string[];
  totalRows?: number;

  metrics: ShareMetricKey[];
  includeNotes: boolean;
  audience?: "buyer" | "creative_team" | "external";
  presetId?: string;
  presetLabel?: string;
  includeCampaignNames?: boolean;
  includeDecisionLanguage?: boolean;
  allowCsv?: boolean;
  snapshotOnly?: boolean;

  creatives: SharedCreative[];
  benchmarkCreatives?: SharedCreative[];

  note?: string;
}
