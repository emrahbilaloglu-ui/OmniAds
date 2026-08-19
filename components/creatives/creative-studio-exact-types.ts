export const CREATIVE_STUDIO_TABS = [
  "assets",
  "copies",
  "landing-pages",
  "inbox",
  "audiences",
] as const;

export type CreativeStudioTabId = (typeof CREATIVE_STUDIO_TABS)[number];

/**
 * What a Creative Studio section knows about itself.
 *
 * The six outcomes an honest surface has to keep apart, minus `partial`, which
 * is a *served* surface with a stated gap and therefore rides on `ready` plus
 * the shared Tier-0 freshness bar rather than replacing the table's state.
 *
 * - `loading` — no answer yet. Never a number.
 * - `error` — the read failed, and the reader knows it failed.
 * - `account_required` — the provider scope is not explicit; nothing was asked.
 * - `unavailable` — the endpoint answered, and its answer was "no read
 *   happened": no Meta connection, no access token, an unassigned account. It
 *   arrives as HTTP 200 with `rows: []`, which is exactly why it needs its own
 *   state. Reporting it as `empty` turned a non-read into a definite claim
 *   about the operator's account.
 * - `empty` — the read happened and the account genuinely served nothing.
 * - `ready` — rows are on screen.
 */
export type CreativeStudioDataState =
  | "loading"
  | "error"
  | "account_required"
  | "unavailable"
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

/**
 * `onOpenRow` is deliberately absent here, unlike on the Copies model — and the
 * CANONICAL REFERENCE is why, not convenience.
 *
 * `docs/dashboard-v2-parity-defects.md:1286` quotes the design HTML for this
 * screen: "The Assets row's sole handler is `r.toggle` at line 758; the
 * dedicated checkbox and full row both represent the pin state. The only Studio
 * drawer trigger is the Copies row handler at line 813." The verdict row at
 * :1023 states the same conclusion: "An Assets row performs only the canonical
 * pin toggle; the old asset usage/evidence drawer path is not mounted from this
 * screen." A separate defect, CREATIVE-42, was filed precisely BECAUSE an
 * Assets row used to open a usage/evidence surface the reference does not draw.
 *
 * So this is not a gap awaiting a drawer. Building one would be adding a screen
 * the design does not define, and re-opening a closed parity defect. The field
 * was removed because nothing supplied it and `AssetsView` never read it: dead
 * plumbing on a data model is worse than no plumbing, because it reads as a
 * shipped capability and the next reader wires a caller to it.
 *
 * `CreativeStudioExact.test.tsx` — "keeps an Assets row bound to the pin alone,
 * honouring no detail opener" — passes a stray handler in anyway and asserts the
 * surface ignores it, so re-adding the field cannot quietly re-add the screen.
 */
export interface CreativeStudioAssetsModel {
  state: CreativeStudioDataState;
  message: string | null;
  syncedCount: number | null;
  rows: CreativeStudioAssetRow[];
  persistenceKey?: string;
  onPinnedIdsChange?: (ids: string[]) => void;
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
  /**
   * The window these copy rows were measured over. The subtitle used to be the
   * literal "28d", so a 14-day or custom selection was labelled 28 days on
   * screen. `null` withholds it rather than asserting a default.
   */
  windowLabel?: string | null;
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
  /**
   * The window these destination reads cover. The subtitle used to be the
   * literal "28d", so a 7-day or custom selection was labelled 28 days.
   * `null` withholds it rather than asserting a default.
   */
  windowLabel?: string | null;
  rows: CreativeStudioLandingRow[];
  gaps: CreativeStudioReadItem[];
  tests: CreativeStudioReadItem[];
  history: CreativeStudioHistoryItem[];
}

/**
 * The Inbox's segments — the creative-briefing authority's OWN served sections.
 *
 * These used to be `requested | in-production | delivered | live`: a
 * Requested -> In production -> Delivered -> Live production pipeline. Nothing
 * in this product produces any of it. There is no workflow status, owner, due
 * date, version or approval recorded anywhere (re-provable:
 *
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'workflowStatus|workflow_status|columnId|column_id|stage' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E '\bassignee\b|assigned_to|assignedTo' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'dueAt|due_at|dueDate' app lib components
 *   grep -rn --include='*.ts' --include='*.tsx' \
 *     -E 'versionNumber|approvalState|approvedBy|approved_by' app lib components
 *
 * — every live hit belongs to `lib/decision-workflow*`, which is the DECISION
 * ownership overlay, or to `lib/archive/v1-v2-v21/`), and `lib/migrations.ts`
 * declares no workflow table. Four columns named after that pipeline were the
 * surface asserting a capability the product does not have, and no amount of
 * caption could undo the assertion the column headings themselves made.
 *
 * The surface DOES have real content: `/api/creatives/briefing` serves
 * `actionNow`, `watching` and `healthy`. Those three are the engine's own
 * grouping of its own output, so presenting them under their own names shows
 * what is there without reclassifying anything: no card is moved between
 * sections, no decision or buyerAction is inferred to fill a segment, and a
 * segment the authority served nothing for reads as the real zero it is.
 */
export type CreativeInboxColumnId = "action-now" | "watching" | "healthy";

/**
 * One measured number from the served card. `value: null` is what an
 * unmeasured field looks like and renders as an em dash; a measured zero is
 * the string "0" and stays a zero.
 */
export interface CreativeStudioInboxCardFact {
  label: string;
  value: string | null;
}

export interface CreativeStudioInboxCard {
  id: string;
  /** The engine's served decision label, verbatim. Null when it served none. */
  source: string | null;
  sourceTone: CreativeStudioTone;
  name: string;
  /** The engine's served one-line summary, verbatim. Never composed here. */
  note: string | null;
  facts: CreativeStudioInboxCardFact[];
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
  /**
   * The window these breakdowns were actually measured over, as the caption
   * should name it. The caption used to be the literal "28d" regardless of
   * what the operator selected, so a 7-day or custom range was labelled as a
   * 28-day one on screen. `null` means the window is unknown and the caption
   * withholds it rather than asserting a default.
   */
  windowLabel?: string | null;
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
