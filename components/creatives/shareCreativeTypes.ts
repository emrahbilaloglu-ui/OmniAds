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

export const SHARE_AUDIENCES = ["buyer", "creative_team", "external"] as const;

export type ShareAudience = (typeof SHARE_AUDIENCES)[number];

export interface CreativeShareLedgerEntry {
  token: string;
  title: string;
  audience: ShareAudience;
  status: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  openCount: number;
  creativeCount: number;
  firstCreativeName: string | null;
  providerAccountId: string;
}

export interface CreativeShareLedgerCapability {
  status: "ready" | "migration_required";
  canReadLedger: boolean;
  canWrite: boolean;
  missingColumns: string[];
}

/**
 * Closed metric set that may cross the creative-team/external serialization boundary.
 */
export const CREATOR_TIER_0_SHARE_METRIC_KEYS = [
  "thumbstop",
  "ctrAll",
  "linkCtr",
  "video25",
  "video50",
  "video75",
  "video100",
] as const satisfies readonly ShareMetricKey[];

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

export interface SharedClientAction {
  id?: string | null;
  what: string;
  why: string;
  date: string;
  outcome?: string | null;
  outcomeTone?: "positive" | "neutral" | null;
}

/**
 * A note posted on the public share page, after the link was created.
 *
 * Separate from `SharePayload.note` (the sender's one-way note, fixed at
 * creation) and from the frozen `creatives` array: this is a live, append-only
 * thread. Nothing here is derived — `text` is exactly what was typed.
 */
export interface SharedMessage {
  id: string;
  who: "viewer" | "sender";
  name: string;
  text: string;
  postedAt: string;
}

/**
 * The account's own typical creative, at the metric the story cards compare
 * against — computed from the SAME rows the operator was looking at when they
 * shared, never a fabricated constant. A metric absent here means there were
 * too few comparable creatives to call anything "typical"; the public page
 * must show the raw number with no Strong/Typical/Weak verdict in that case,
 * rather than inventing a comparison point.
 */
export interface CreativeShareBenchmarks {
  thumbstop?: number | null;
  videoCompletion50?: number | null;
  ctrAll?: number | null;
  linkCtr?: number | null;
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

type RedactableSharedCreativeMetric =
  | "spend"
  | "purchaseValue"
  | "roas"
  | "cpa"
  | "purchases";

/**
 * Stored/public payloads may be projected to a creator-safe metric subset.
 */
export type SharePayloadCreative = Omit<SharedCreative, RedactableSharedCreativeMetric> &
  Partial<Pick<SharedCreative, RedactableSharedCreativeMetric>>;

/**
 * Configuration used when generating public share links
 */
export interface ShareLinkConfig {
  title: string;
  expiration: "3" | "7" | "14";
  metrics: ShareMetricKey[];
  includeNotes: boolean;
  audience?: ShareAudience;
  presetId?: string;
  presetLabel?: string;
  includeCampaignNames?: boolean;
  includeDecisionLanguage?: boolean;
  allowCsv?: boolean;
  snapshotOnly?: boolean;
  /** Explicit buyer-only acknowledgement required by the share API. */
  buyerAcknowledged?: boolean;
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
  providerAccountId?: string;
  businessName?: string | null;
  clientEmail?: string | null;
  currency?: string | null;
  trackingState?: "normal" | "no_actions" | "tracking_degraded" | null;
  clientActions?: SharedClientAction[];
  groupBy?: string;

  filters?: string[];
  selectedRowIds?: string[];
  totalRows?: number;

  metrics: ShareMetricKey[];
  includeNotes: boolean;
  audience?: ShareAudience;
  presetId?: string;
  presetLabel?: string;
  includeCampaignNames?: boolean;
  includeDecisionLanguage?: boolean;
  allowCsv?: boolean;
  snapshotOnly?: boolean;

  creatives: SharePayloadCreative[];
  benchmarkCreatives?: SharePayloadCreative[];
  /** The account's typical-creative comparison points; see `CreativeShareBenchmarks`. */
  benchmarks?: CreativeShareBenchmarks;

  note?: string;

  /**
   * The live public thread. NOT part of the frozen snapshot — stored in its
   * own column (`creative_share_snapshots.messages`) and merged onto this
   * object by the store at read time, never written back through
   * `sanitizeCreativeSharePayloadForStorage`.
   */
  messages?: SharedMessage[];
}
