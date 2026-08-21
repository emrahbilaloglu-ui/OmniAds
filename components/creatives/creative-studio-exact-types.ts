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
  "loading" | "error" | "account_required" | "unavailable" | "empty" | "ready";

export type CreativeStudioTone =
  "positive" | "negative" | "warning" | "info" | "automation" | "neutral";

/**
 * Every metric the Assets table is allowed to put in a column.
 *
 * THE ADMISSION RULE, and the greps behind it. A metric enters this union only
 * if some producer on the grain this table reads can serve it. The Assets table
 * pins `groupBy: "creative"`
 * (app/(dashboard)/platforms/meta/creatives/legacy-page.tsx), so the fact table
 * is `meta_creative_daily` and the presence sidecar is the one stamped by
 * `hydrateWarehouseCreativeMetrics` (lib/meta/creatives-warehouse.ts:~808-841).
 * A field that sidecar stamps `false` unconditionally is a permanent em dash on
 * the default window, and a field that never reaches
 * `META_OBSERVED_METRIC_KEYS` (components/creatives/metricConfig.ts:52) cannot
 * reach a cell at all.
 *
 * ADMITTED BECAUSE THE PRODUCER SERVES THEM. `revenue` is
 * `meta_creative_daily.revenue`, a NOT NULL column whose presence is stamped
 * `purchase_value: true` unconditionally; `linkClicks`, `landingPageViews`,
 * `addToCart` and `initiateCheckout` are presence-tracked per row and reach the
 * UI as observed keys; `cpcLink` and `atcToPurchase` are producer-computed
 * ratios with their own presence entries
 * (lib/meta/creatives-service-support.ts:154-159).
 *
 * REFUSED. `hold` is gone. It was in this union, in the Engagement preset and
 * in the default Custom set, and the mounted projector assigned it a literal
 * `null` on every row of every account, because Meta serves no Hold-15s field
 * on a creative row:
 *
 *     grep -rn 'hold' components/creatives/metricConfig.ts   -> no row field
 *     grep -rn 'thruplay' lib/meta/creatives-warehouse.ts    -> `false` stamp
 *
 * The nearest upstream fact, `thruplay_actions`, is itself stamped `false` on
 * this grain and is absent from `META_OBSERVED_METRIC_KEYS`, so it cannot stand
 * in — and video-completion rates are a different question from a 15-second
 * hold. A column that is an em dash in every row of every account teaches the
 * operator to ignore the table, so the column leaves rather than the honesty.
 *
 * ADMITTED ON A DIFFERENT KIND OF EVIDENCE — `ageDays`, and the grep that
 * fixes its clock. The creative-level call is scale / keep / cut, and its first
 * question is "can I judge this at all?". Spend alone cannot answer it: $8 at
 * ROAS 0 on day 2 is UNJUDGED and the same row on day 30 is dead. Age is the
 * other half of that evidence base.
 *
 * WHICH CLOCK, established rather than assumed. Three ages exist in this
 * codebase and they are not the same number:
 *
 *     grep -rn 'first_seen_at\|first_spend_at' lib/meta/creatives-types.ts \
 *       components/creatives/metricConfig.ts \
 *       app/(dashboard)/platforms/meta/creatives/page-support.tsx \
 *       lib/meta/creatives-service-support.ts        -> exit 1, no matches
 *
 * `meta_creative_daily` really does carry `first_seen_at` and `first_spend_at`
 * (`MetaCreativeDailyRow`, lib/meta/warehouse-types.ts), and the decision
 * engine reads both (lib/creative-decision-engine/data-source.ts:~3864). But
 * NEITHER reaches this table: `MetaCreativeApiRow` (lib/meta/creatives-types.ts)
 * carries exactly one date, `launch_date:string` at :473, and
 * `mapApiRowToUiRow` lands it on `MetaCreativeRow.launchDate` at
 * page-support.tsx:1025. So "first spend" — the clock that would best answer
 * "how long has this been able to accumulate the numbers in the row" — is not
 * available on this grain, and claiming it would be a label over a different
 * measurement.
 *
 * What `launch_date` IS, one more layer down: `mapInsightToRawRow`
 * (lib/meta/creatives-row-mappers.ts:620) sets it from `ad.created_time`, and
 * `groupRows` on `groupBy: "creative"` takes the EARLIEST such date across the
 * ads sharing the creative (creatives-row-mappers.ts:872, :1012). That is a
 * CREATED clock, so the column is named for a created clock. A column called
 * "Days live" that silently means "days since created" is the same defect as an
 * unlabelled CVR denominator.
 *
 * ITS CEILING, left visible rather than buried. The same line ends
 * `|| cleanDate(insight.date_start) || toISODate(new Date())`, so an ad whose
 * `created_time` Meta did not return takes the sync day instead. Nothing at
 * this layer can tell that substitution apart from a real creation date — it
 * happened before the row was written — so this column is only as true as
 * `ad.created_time` is present. Fixing that belongs to the producer, not to a
 * presentation pass, and the projector guards only what it can actually prove:
 * a blank date and a date later than the window's end are both withheld.
 *
 * KEPT, BUT NEVER A DEFAULT. `thumbstop` stays in the union and in the picker
 * because the LIVE creatives path parses a real rate for it
 * (lib/meta/creatives-row-mappers.ts:~548) when the window includes today. On
 * the default completed window the warehouse stamps it `false`, which the
 * repo's own chain test measures
 * (app/(dashboard)/platforms/meta/creatives/null-vs-zero-production-chain.test.tsx).
 * So it is a metric an operator may knowingly opt into, never one this table
 * hands them.
 */
export type CreativeAssetMetricId =
  | "spend"
  | "impressions"
  | "revenue"
  | "clicks"
  | "linkClicks"
  | "landingPageViews"
  | "addToCart"
  | "initiateCheckout"
  | "purchases"
  | "roas"
  | "cpa"
  | "cpm"
  | "cpcLink"
  | "aov"
  | "ctr"
  | "thumbstop"
  | "frequency"
  | "atcRate"
  | "atcToPurchase"
  | "cvr"
  | "ageDays";

export interface CreativeStudioAssetRow {
  id: string;
  name: string;
  kind: string;
  imageUrl: string | null;
  /**
   * The ENGINE's own classification of this creative, as the server published
   * it — never a delivery state, and never anything this file computed.
   *
   * It used to be `effectiveStatus`, the provider's delivery enum. Measured on
   * TheSwaf (act_822913786458311, 2026-07-21..2026-08-17, 96 rows) the column
   * read `PAUSED` 34x, `ADSET_PAUSED` 26x, `ACTIVE` 23x, `CAMPAIGN_PAUSED` 10x
   * and `WITH_ISSUES` 3x — five provider enum values, and not one word about
   * whether a creative is winning, fatigued or still learning. That is a
   * delivery fact the operator can already see in Ads Manager; it is not the
   * lifecycle classification this column is for.
   *
   * Mounted rows never leave this blank: a matched row uses the server's
   * buyer label, an unmatched successful read says `Not evaluated`, and a
   * failed read says `Decision data unavailable`. `null` remains accepted only
   * so older serialized/test models render through the same explicit fallback.
   * Two ads sharing one creative keep every distinct served answer rather than
   * letting the UI pick one. See
   * `components/creatives/creative-served-classification.ts`.
   */
  status: string | null;
  statusTone: CreativeStudioTone;
  /** Display-cased server decision state (`Act`, `Blocked`, `Monitor`, ...). */
  decisionSegment?: string | null;
  /** Exact source/action audit text; presentation only, never decision input. */
  statusDetail?: string | null;
  /** Distinct exact-Ad decisions represented by this creative-grain row. */
  decisionCount?: number;
  /**
   * The provider's delivery state, kept because moving the classification into
   * `status` must not delete a fact the surface used to show. It renders
   * beside the creative's format in the identity cell, not as the Status
   * column, because it answers "is it running", not "is it working".
   */
  deliveryStatus: string | null;
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
  /**
   * Rows currently ticked in the Assets table — the only way this toolbar
   * knows whether "Share with client" has anything to share. `undefined`
   * (no assets model wired yet) reads the same as 0: the button offers a
   * nudge instead of opening with nothing selected.
   */
  shareSelectedCount?: number;
  /** Served count of this account's live share links, or null while unread. */
  sharedLinksCount?: number | null;
  onOpenSharedLinks?: () => void;
  assets?: CreativeStudioAssetsModel;
  copies?: CreativeStudioCopiesModel;
  landingPages?: CreativeStudioLandingModel;
  inbox?: CreativeStudioInboxModel;
  audiences?: CreativeStudioAudiencesModel;
}
