export const CREATIVE_STUDIO_TABS = [
  "assets",
  "copies",
  "landing-pages",
  "inbox",
  "audiences",
] as const;

export type CreativeStudioTabId = (typeof CREATIVE_STUDIO_TABS)[number];

export type CreativeStudioDataState =
  | "loading"
  | "error"
  | "account_required"
  | "empty"
  | "ready";

export type CreativeStudioTone =
  | "positive"
  | "negative"
  | "warning"
  | "info"
  | "automation"
  | "neutral";

export type CreativeAssetMetricId =
  | "spend"
  | "impressions"
  | "clicks"
  | "purchases"
  | "roas"
  | "cpa"
  | "cpm"
  | "aov"
  | "ctr"
  | "thumbstop"
  | "hold"
  | "frequency"
  | "atcRate"
  | "cvr";

export interface CreativeStudioAssetRow {
  id: string;
  name: string;
  kind: string;
  imageUrl: string | null;
  status: string | null;
  statusTone: CreativeStudioTone;
  marketingAngle: string | null;
  currency: string | null;
  metrics: Partial<Record<CreativeAssetMetricId, number | null>>;
}

export interface CreativeStudioAssetsModel {
  state: CreativeStudioDataState;
  message: string | null;
  syncedCount: number | null;
  rows: CreativeStudioAssetRow[];
  persistenceKey?: string;
  onPinnedIdsChange?: (ids: string[]) => void;
  onOpenRow?: (rowId: string) => void;
}

export interface CreativeStudioCopyAngle {
  id: string;
  name: string;
  tone: CreativeStudioTone;
  lines: number | null;
  spendShare: number | null;
  roas: number | null;
  ctr: number | null;
  bestLine: string | null;
  usage: string | null;
}

export interface CreativeStudioCopyRow {
  id: string;
  text: string;
  kind: string | null;
  chars: number;
  angle: string | null;
  tone: CreativeStudioTone;
  ads: number | null;
  currency: string | null;
  spend: number | null;
  seeMore: number | null;
  ctr: number | null;
  engagement: number | null;
  cvr: number | null;
  roas: number | null;
}

export interface CreativeStudioCopiesModel {
  state: CreativeStudioDataState;
  message: string | null;
  angles: CreativeStudioCopyAngle[];
  angleCoverage: string | null;
  angleGaps: string[];
  insight: string | null;
  rows: CreativeStudioCopyRow[];
  onOpenRow?: (rowId: string) => void;
}

export interface CreativeStudioLandingRow {
  id: string;
  destination: string;
  ads: number | null;
  currency: string | null;
  spend: number | null;
  linkClicks: number | null;
  landingPageViewRate: number | null;
  cvr: number | null;
  cpa: number | null;
  roas: number | null;
  signal: string | null;
  signalTone: CreativeStudioTone;
}

export interface CreativeStudioReadItem {
  id: string;
  kind: string | null;
  tone: CreativeStudioTone;
  text: string | null;
  estimate?: string | null;
}

export interface CreativeStudioHistoryItem {
  id: string;
  date: string | null;
  text: string | null;
  result: string | null;
  tone: CreativeStudioTone;
}

export interface CreativeStudioLandingModel {
  state: CreativeStudioDataState;
  message: string | null;
  rows: CreativeStudioLandingRow[];
  gaps: CreativeStudioReadItem[];
  tests: CreativeStudioReadItem[];
  history: CreativeStudioHistoryItem[];
}

export type CreativeInboxColumnId =
  | "requested"
  | "in-production"
  | "delivered"
  | "live";

export interface CreativeStudioInboxCard {
  id: string;
  source: string | null;
  sourceTone: CreativeStudioTone;
  name: string;
  note: string | null;
  ownerInitials: string | null;
  ownerTone: CreativeStudioTone;
  due: string | null;
  actionLabel: string | null;
  onAction?: () => void;
}

export interface CreativeStudioInboxColumn {
  id: CreativeInboxColumnId;
  name: string;
  tone: CreativeStudioTone;
  cards: CreativeStudioInboxCard[];
}

export interface CreativeStudioInboxModel {
  state: CreativeStudioDataState;
  message: string | null;
  columns: CreativeStudioInboxColumn[];
  onBrowseFiles?: () => void;
}

export interface CreativeStudioAudienceSummary {
  id: string;
  name: string;
  status: string | null;
  tone: CreativeStudioTone;
  currency: string | null;
  spend: number | null;
  roas: number | null;
  frequency: number | null;
  note: string | null;
}

export interface CreativeStudioBreakdownRow {
  id: string;
  label: string;
  spendShare: number | null;
  roas: number | null;
  tone: CreativeStudioTone;
}

export interface CreativeStudioBreakdown {
  id: string;
  title: string;
  subtitle: string;
  note: string | null;
  rows: CreativeStudioBreakdownRow[];
}

export interface CreativeStudioAudienceMatrixRow {
  id: string;
  name: string;
  imageUrl: string | null;
  values: Array<number | null>;
}

export interface CreativeStudioAudiencesModel {
  state: CreativeStudioDataState;
  message: string | null;
  summaries: CreativeStudioAudienceSummary[];
  breakdowns: CreativeStudioBreakdown[];
  matrixColumns: string[];
  matrixRows: CreativeStudioAudienceMatrixRow[];
}

export interface CreativeStudioExactProps {
  activeTab: CreativeStudioTabId;
  tabHrefs: Record<CreativeStudioTabId, string>;
  counts: Partial<Record<CreativeStudioTabId, number | null>>;
  onExport?: () => void;
  onShare?: () => void;
  assets?: CreativeStudioAssetsModel;
  copies?: CreativeStudioCopiesModel;
  landingPages?: CreativeStudioLandingModel;
  inbox?: CreativeStudioInboxModel;
  audiences?: CreativeStudioAudiencesModel;
}
