"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type {
  CreativeAssetMetricId,
  CreativeStudioAssetRow,
  CreativeStudioAssetsModel,
  CreativeStudioAudienceMatrixRow,
  CreativeStudioBreakdown,
  CreativeStudioCopiesModel,
  CreativeStudioDataState,
  CreativeStudioExactProps,
  CreativeStudioInboxCard,
  CreativeStudioInboxColumn,
  CreativeStudioLandingModel,
  CreativeStudioReadItem,
  CreativeStudioTabId,
  CreativeStudioTone,
} from "./creative-studio-exact-types";
import styles from "./CreativeStudioExact.module.css";

const EM_DASH = "—";
/**
 * Bumped from 1 when `hold` left the catalogue and seven measurable metrics
 * entered it. See `readPersistedCustomMetrics` for what a version-1 record
 * becomes; the bump is what lets that function tell an operator's deliberate
 * choice apart from a set this change emptied.
 *
 * IT DOES NOT MOVE FOR `ageDays`, and the asymmetry is the point. A version bump
 * exists to rescue records the catalogue INVALIDATED: `readPersistedCustomMetrics`
 * treats a record at the current version as literal and sends anything else to
 * the defaults, so bumping to 3 would discard every operator's saved column set
 * to announce a metric that orphans none of them. Age was added, nothing was
 * removed, and a stored version-2 set still means exactly what its operator
 * chose — it simply does not include a column that did not exist when they
 * chose. The picker is where they opt in.
 */
const PERSISTENCE_VERSION = 2;

type MetricSetId = "performance" | "engagement" | "funnel" | "custom";
type MetricCategory =
  "Evidence" | "Volume" | "Efficiency" | "Engagement" | "Funnel";
type MetricDirection = -1 | 0 | 1;

interface MetricDefinition {
  id: CreativeAssetMetricId;
  label: string;
  category: MetricCategory;
  direction: MetricDirection;
}

const TABS: ReadonlyArray<{ id: CreativeStudioTabId; label: string }> = [
  { id: "assets", label: "Assets" },
  { id: "copies", label: "Copies" },
  { id: "landing-pages", label: "Landing Pages" },
  { id: "inbox", label: "Inbox" },
  { id: "audiences", label: "Audiences" },
];

/**
 * The metric catalogue, and the two rules that decide what a label may say.
 *
 * RULE 1 — A RATIO NAMES ITS DENOMINATOR WHEREVER TWO ARE PLAUSIBLE. This table
 * can show an all-clicks counter and a link-clicks counter in the same row, so
 * a bare "CVR" is a lie by omission: CVR over link clicks and CVR over all
 * clicks are different numbers and rank creatives differently. The house style
 * already exists upstream — `components/creatives/metricConfig.ts` ships
 * "CPC (link)" and "CTR (all)" — and these labels follow it.
 *
 *   - "CTR (link)" — the rendered value is link clicks / impressions
 *     (`calculateCreativeLinkCtr`, components/creatives/creative-truth.ts). The
 *     wire field behind it is misleadingly named `ctr_all` while being computed
 *     from link clicks (lib/meta/creatives-service-support.ts:~463); the column
 *     is named for what it measures, not for what the wire calls it.
 *   - "Clicks (all)" — `meta_creative_daily.clicks`, every click type Meta
 *     counts, including reactions, profile taps and "see more".
 *   - "CVR (link clicks)" and "ATC rate (link clicks)" — both divide by link
 *     clicks, and both sit in a preset that also shows "Clicks (all)".
 *   - "Frequency (daily avg)" — see the ruling below.
 *
 * RULE 2 — DIRECTION IS A CLAIM ABOUT THE METRIC, SO IT MUST BE TRUE. A volume
 * metric takes `direction: 0` and is never coloured, because "spent the most"
 * and "earned the most revenue" are not "best" — they track budget, and a heat
 * ramp over them would tell a buyer that the biggest spender is the winner.
 * Every count here is 0 for that reason: spend, impressions, revenue, clicks,
 * link clicks, landing page views, adds to cart, checkouts, purchases.
 *
 * `ageDays` takes `direction: 0` for a different reason, and it is the one to
 * get right: AGE RANKS NOBODY. A 40-day creative is not better or worse than a
 * 2-day one — age is the context the other columns are read against — and a
 * sign either way would paint a fatigued creative green for surviving or an
 * unjudged newcomer green for being new. Neither is a verdict this column may
 * hand a buyer, so it is never coloured at all.
 *
 * THE FREQUENCY RULING, made explicitly rather than left to ride. The Decision
 * Center refuses to render frequency at all, in writing
 * (components/meta/redesign/MetaPlatformPage.tsx), because `groupRows`
 * discards the stored per-day figure and recomputes
 * `impressions / SUM(daily reach)` (lib/meta/creatives-row-mappers.ts:~868) —
 * reach summed across days counts one person once PER DAY, so the ratio is
 * below the window's true frequency. That objection is to the LABEL, not to the
 * number: sum(daily impressions) / sum(daily reach) is exactly the
 * impression-weighted average DAILY frequency, which is a real measurement and
 * the only fatigue signal this grain carries. So it stays, under a name that
 * says which period it is a frequency over. Both surfaces are now right: the
 * Decision Center declines to publish a window frequency, and this column never
 * claims to be one.
 */
const METRICS: readonly MetricDefinition[] = [
  /*
   * THE LABEL NAMES THE CLOCK, because three clocks exist and they disagree.
   *
   * `CreativeAssetMetricId` in creative-studio-exact-types.ts carries the greps:
   * `first_seen_at` and `first_spend_at` live on `meta_creative_daily` and are
   * read by the decision engine, but neither reaches `MetaCreativeApiRow`, so
   * the only date on this grain is `launch_date` — `ad.created_time`, earliest
   * across the ads sharing the creative. "Days live" over a created clock would
   * be the same lie as a CVR that does not say which clicks it divides by, so
   * the header says "since created" and means it.
   *
   * THE END IT COUNTS TO is the WINDOW'S END, not today. Every other number in
   * this row was measured over a window that ends yesterday by default
   * (lib/dashboard/date-window-presets.ts: "a rolling preset ends YESTERDAY"),
   * and an age counted to `Date.now()` beside them would put two clocks in one
   * row. `toCreativeStudioAssetRows` is handed the window's end and subtracts
   * against that, so the whole row answers as of one instant.
   */
  {
    id: "ageDays",
    label: "Age (days since created)",
    category: "Evidence",
    direction: 0,
  },
  { id: "spend", label: "Spend", category: "Volume", direction: 0 },
  { id: "impressions", label: "Impressions", category: "Volume", direction: 0 },
  { id: "revenue", label: "Revenue", category: "Volume", direction: 0 },
  { id: "purchases", label: "Purchases", category: "Volume", direction: 0 },
  { id: "roas", label: "ROAS", category: "Efficiency", direction: 1 },
  { id: "cpa", label: "CPA", category: "Efficiency", direction: -1 },
  { id: "aov", label: "AOV", category: "Efficiency", direction: 1 },
  { id: "cpm", label: "CPM", category: "Efficiency", direction: -1 },
  { id: "cpcLink", label: "CPC (link)", category: "Efficiency", direction: -1 },
  { id: "ctr", label: "CTR (link)", category: "Engagement", direction: 1 },
  { id: "clicks", label: "Clicks (all)", category: "Volume", direction: 0 },
  {
    id: "frequency",
    label: "Frequency (daily avg)",
    category: "Engagement",
    direction: -1,
  },
  { id: "thumbstop", label: "Thumbstop", category: "Engagement", direction: 1 },
  { id: "linkClicks", label: "Link clicks", category: "Funnel", direction: 0 },
  {
    id: "landingPageViews",
    label: "Landing page views",
    category: "Funnel",
    direction: 0,
  },
  { id: "addToCart", label: "Adds to cart", category: "Funnel", direction: 0 },
  {
    id: "atcRate",
    label: "ATC rate (link clicks)",
    category: "Funnel",
    direction: 1,
  },
  {
    id: "initiateCheckout",
    label: "Checkouts",
    category: "Funnel",
    direction: 0,
  },
  {
    id: "atcToPurchase",
    label: "ATC to purchase",
    category: "Funnel",
    direction: 1,
  },
  { id: "cvr", label: "CVR (link clicks)", category: "Funnel", direction: 1 },
];

/**
 * Each preset answers ONE question completely, in its own reading order.
 *
 * The columns render in the order written here, not in catalogue order, so a
 * preset is an argument the operator reads left to right rather than an
 * alphabet.
 *
 * PERFORMANCE — the whole scale / keep / cut call, in four movements. Budget
 * lives at ad set and campaign; the creative-level decision is scale, keep or
 * cut, and this set carries everything that decision needs.
 *
 *   1. CAN I JUDGE IT?      Age, Spend, Impressions. $8 across 300 impressions
 *                           at ROAS 0 is UNJUDGED, not losing, and without the
 *                           evidence base every ratio to its right is noise.
 *                           Age leads because it is the half spend cannot
 *                           supply: the same $8 at ROAS 0 is a creative that
 *                           has not been given a chance on day 2 and a creative
 *                           that failed on day 30, and only the age column
 *                           separates them. It is in THIS set and no other —
 *                           Engagement asks what attention costs and Funnel
 *                           asks where people drop out, and neither question
 *                           changes with the creative's age.
 *   2. DID IT MAKE MONEY?   Revenue, ROAS, Purchases, CPA. Revenue is the
 *                           column this table never had: ROAS 4.0 on $30 and
 *                           ROAS 2.1 on $4,000 are not the same decision, and
 *                           ROAS alone hides which one is on screen.
 *   3. WHY?                 CPM, CTR (link), CVR (link clicks), AOV — the ROAS
 *                           identity `ROAS = AOV x CVR x CTR x (1000/CPM)`,
 *                           laid out in delivery order. Each factor has a
 *                           different owner: CPM the auction and the audience,
 *                           CTR the creative itself, CVR the landing page and
 *                           the offer, AOV the merchandising. Together they are
 *                           what lets a buyer say whether the CREATIVE is at
 *                           fault or something downstream of it is.
 *   4. IS IT DYING?         Frequency (daily avg).
 *
 * ENGAGEMENT — does it earn attention, hold it, and what does that attention
 * cost. Impressions is the attention bought, CPM its price, CTR (link) whether
 * it converts into a visit, CPC (link) the price of that visit, Clicks (all)
 * the wider engagement including reactions and expands, and the daily frequency
 * how hard the same people are being re-served.
 *
 * `hold` and `thumbstop` both left this preset. `hold` was hardcoded `null` in
 * the projector and is gone from the catalogue entirely; `thumbstop` is stamped
 * unavailable by the warehouse producer on this grain and so may not be a
 * DEFAULT column, though it remains in the picker. Between them they were two
 * of the five Engagement columns, and both were an em dash in every row.
 *
 * FUNNEL — where people fall out of the ladder, with each drop-off ratio
 * standing immediately after the step it measures:
 *
 *   Impressions -> CTR (link) -> Link clicks -> Landing page views
 *     -> Adds to cart -> ATC rate (link clicks) -> Checkouts
 *     -> Purchases -> ATC to purchase -> CVR (link clicks)
 *
 * The old Funnel set was four columns, two of which ("ATC rate", "CVR") named
 * no denominator while sitting beside an all-clicks column called "Clicks", and
 * it skipped landing page views and checkouts entirely although the producer
 * serves both.
 */
const METRIC_PRESETS: Record<
  Exclude<MetricSetId, "custom">,
  readonly CreativeAssetMetricId[]
> = {
  performance: [
    "ageDays",
    "spend",
    "impressions",
    "revenue",
    "roas",
    "purchases",
    "cpa",
    "cpm",
    "ctr",
    "cvr",
    "aov",
    "frequency",
  ],
  engagement: ["impressions", "cpm", "ctr", "cpcLink", "clicks", "frequency"],
  funnel: [
    "impressions",
    "ctr",
    "linkClicks",
    "landingPageViews",
    "addToCart",
    "atcRate",
    "initiateCheckout",
    "purchases",
    "atcToPurchase",
    "cvr",
  ],
};

/**
 * The Custom set's starting point, before the operator edits it.
 *
 * `thumbstop` used to be here, and on the default completed window the
 * warehouse producer stamps it unavailable, so a first-time operator opening
 * the Custom set was handed a blank column. Every id below is measurable on the
 * grain this table reads.
 */
const DEFAULT_CUSTOM_METRICS: readonly CreativeAssetMetricId[] = [
  "spend",
  "revenue",
  "roas",
  "cpa",
  "ctr",
];

const METRIC_CATEGORIES: readonly MetricCategory[] = [
  "Evidence",
  "Volume",
  "Efficiency",
  "Engagement",
  "Funnel",
];

const TONE_CLASSES: Record<CreativeStudioTone, string> = {
  positive: styles.tonePositive,
  negative: styles.toneNegative,
  warning: styles.toneWarning,
  info: styles.toneInfo,
  automation: styles.toneAutomation,
  neutral: styles.toneNeutral,
};

/**
 * The Inbox's three segments.
 *
 * They are the creative-briefing authority's own served sections — `actionNow`,
 * `watching`, `healthy` — under their own names, so the board shows what the
 * engine actually grouped rather than a Requested/In production/Delivered/Live
 * production pipeline that nothing in this product produces. See
 * `CreativeInboxColumnId` in creative-studio-exact-types.ts for the greps that
 * establish the absence.
 *
 * The heading number is a MEASUREMENT of the served items in that segment, and
 * is therefore allowed to be zero.
 */
const INBOX_COLUMNS: ReadonlyArray<{
  id: CreativeStudioInboxColumn["id"];
  name: string;
  tone: CreativeStudioTone;
}> = [
  { id: "action-now", name: "Action now", tone: "warning" },
  { id: "watching", name: "Watching", tone: "info" },
  { id: "healthy", name: "Healthy", tone: "positive" },
];

const AUDIENCE_BREAKDOWN_SLOTS: ReadonlyArray<{
  title: string;
  subtitle: string;
}> = [
  { title: "Frequency", subtitle: "exposures / user" },
  { title: "Age", subtitle: "spend share · ROAS" },
  { title: "Gender", subtitle: "spend share · ROAS" },
  { title: "Placement", subtitle: "spend share · ROAS" },
  { title: "Platform", subtitle: "spend share · ROAS" },
];

const AUDIENCE_MATRIX_COLUMN_SLOTS = 4;

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function displayText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return EM_DASH;
  return String(value);
}

/**
 * The visible Status text is a direct composition of two server-owned fields:
 * the canonical queue state and its buyer label. Older/serialized rows that
 * predate the explicit fallback still receive a truthful non-blank state.
 */
function creativeDecisionStatusText(row: CreativeStudioAssetRow): string {
  const label = row.status?.trim() || "Not evaluated";
  const segment = row.decisionSegment?.trim();
  return segment ? `${segment} · ${label}` : label;
}

function formatNumber(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("en-US");
}

function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
  compact = false,
  fractionDigits?: number,
): string {
  if (!isFiniteNumber(value) || !currency) return EM_DASH;
  try {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits:
        compact && Math.abs(value) >= 1_000 ? 1 : (fractionDigits ?? 2),
      minimumFractionDigits:
        compact && Math.abs(value) >= 1_000 ? 1 : (fractionDigits ?? 0),
      notation: compact && Math.abs(value) >= 1_000 ? "compact" : "standard",
    }).format(value);
    return formatted.replace(/K\b/, "k");
  } catch {
    return EM_DASH;
  }
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return `${value.toFixed(digits)}%`;
}

function formatRatio(value: number | null | undefined): string {
  return isFiniteNumber(value) ? value.toFixed(1) : EM_DASH;
}

function formatMetric(
  row: CreativeStudioAssetRow,
  metricId: CreativeAssetMetricId,
): string {
  const value = row.metrics[metricId];
  switch (metricId) {
    case "spend":
      return formatMoney(value, row.currency, true);
    case "cpa":
    case "cpm":
      return formatMoney(value, row.currency, false, 1);
    case "aov":
      return formatMoney(value, row.currency, false, 0);
    // A link click can cost well under one unit of currency, so this is the one
    // money column that keeps two decimals: at one decimal a $0.42 and a $0.44
    // click print the same figure, and CPC (link) is a ranked column.
    case "cpcLink":
      return formatMoney(value, row.currency, false, 2);
    // Revenue follows spend: same currency, same compaction, so the pair reads
    // as the two halves of one trade.
    case "revenue":
      return formatMoney(value, row.currency, true);
    case "impressions":
    case "clicks":
    case "linkClicks":
    case "landingPageViews":
    case "addToCart":
    case "initiateCheckout":
      return formatNumber(value);
    case "purchases":
      return isFiniteNumber(value) ? value.toLocaleString("en-US") : EM_DASH;
    // Whole days, never compacted. `formatNumber` would print a 1,200-day
    // creative as "1.2k", and an age is read as a number of days rather than as
    // a magnitude. A MEASURED 0 — created on the last day the window covers —
    // prints "0"; only an absent or self-contradicting date reaches the em
    // dash, and the projector is what decides which.
    case "ageDays":
      return isFiniteNumber(value) ? value.toLocaleString("en-US") : EM_DASH;
    case "roas":
      return formatRatio(value);
    case "ctr":
      return formatPercent(value, 2);
    case "frequency":
      return isFiniteNumber(value) ? value.toFixed(1) : EM_DASH;
    case "thumbstop":
    case "atcRate":
    case "atcToPurchase":
    case "cvr":
      return formatPercent(value, 1);
  }
}

function modelMessage(
  model: { state: CreativeStudioDataState; message: string | null } | undefined,
) {
  return displayText(model?.message);
}

function metricDirectionLabel(direction: MetricDirection): string {
  if (direction > 0) return "↑";
  if (direction < 0) return "↓";
  return "";
}

function metricHeader(metric: MetricDefinition): string {
  const direction = metricDirectionLabel(metric.direction);
  return direction ? `${metric.label} ${direction}` : metric.label;
}

/**
 * One metric column's own distribution, as value -> rank in [0, 1].
 *
 * WHY RANK AND NOT MIN-MAX. The legend under this table says, and has always
 * said, "cell color = rank across these creatives on that metric". The code
 * did something else: it placed each value on the column's min-max line,
 * `(value - min) / (max - min)`. That is a position on a scale, not a rank,
 * and a single outlier owns the whole scale.
 *
 * MEASURED on the live surface (TheSwaf act_822913786458311,
 * 2026-07-21..2026-08-17, 96 rows):
 *
 *   - AOV: 42 measured cells, min 89, median 160, max 1309. One creative at
 *     1309 stretched the line so far that the median cell scored
 *     (160-89)/(1309-89) = 0.058 and painted as the WORST bucket. 41 of the 42
 *     cells came out red and exactly 1 came out green. The column said nothing.
 *   - ROAS: 93 measured cells, median 0, max 4.8. 62 cells landed in the worst
 *     bucket and 1 in the best; a ROAS of 1.9 scored 0.40 and painted amber,
 *     level with the account's dead weight.
 *
 * A rank cannot do that: it asks how many of the other creatives this cell
 * beats, so the answer is bounded by the population and no single row can move
 * anyone else's colour by more than one place.
 *
 * TIES TAKE THE BOTTOM OF THEIR BAND, deliberately. With the 62 ROAS zeros a
 * mid-rank would score them 0.33 and paint the account's worst creatives amber.
 * "How many do I strictly beat" scores them 0 — the worst value always paints
 * as the worst, the best value always paints as the best, and that is what
 * makes the legend true rather than approximately true.
 *
 * DIRECTION IS THE METRIC'S OWN. `direction: 1` counts values below as beaten
 * (high ROAS is good); `direction: -1` counts values above as beaten (low CPA
 * is good); `direction: 0` columns are volume and never coloured at all.
 */
type MetricRankScale = ReadonlyMap<number, number>;

function buildRankLookup(
  values: readonly number[],
  direction: MetricDirection,
): MetricRankScale {
  const lookup = new Map<number, number>();
  if (values.length === 0) return lookup;
  if (values.length === 1) {
    lookup.set(values[0]!, 0.5);
    return lookup;
  }
  const ascending = [...values].sort((left, right) => left - right);
  /*
   * EVERY ROW EQUAL IS NOT EVERY ROW WORST.
   *
   * The ramp below scores a value by how many rows it strictly beats. When the
   * whole column shares one value that count is 0 for the single tie group, so
   * rank was 0 and every cell painted `heatLag` — the worst bucket. Five
   * creatives all at CPM $10.00 read as an account-wide failure, when what the
   * data says is that nobody is worse than anybody.
   *
   * 0.5 is the same answer the single-row case above already gives, and for
   * the same reason: a ranking needs someone to rank against.
   */
  if (ascending[0] === ascending[ascending.length - 1]) {
    lookup.set(ascending[0]!, 0.5);
    return lookup;
  }
  const denominator = ascending.length - 1;
  let index = 0;
  while (index < ascending.length) {
    const value = ascending[index]!;
    let last = index;
    while (last + 1 < ascending.length && ascending[last + 1] === value)
      last += 1;
    const strictlyBelow = index;
    const strictlyAbove = ascending.length - 1 - last;
    lookup.set(
      value,
      (direction < 0 ? strictlyAbove : strictlyBelow) / denominator,
    );
    index = last + 1;
  }
  return lookup;
}

/**
 * Built from the rows CURRENTLY IN THE TABLE, not from the model's full row
 * list. The legend promises "across these creatives"; when the operator
 * searches, "these creatives" is what is left on screen, and ranking against
 * rows they cannot see would make the sentence false.
 */
function buildMetricRankScales(
  rows: readonly CreativeStudioAssetRow[],
  metrics: readonly MetricDefinition[],
): Map<CreativeAssetMetricId, MetricRankScale> {
  const scales = new Map<CreativeAssetMetricId, MetricRankScale>();
  for (const metric of metrics) {
    if (metric.direction === 0) continue;
    const values: number[] = [];
    for (const row of rows) {
      const value = row.metrics[metric.id];
      if (isFiniteNumber(value)) values.push(value);
    }
    scales.set(metric.id, buildRankLookup(values, metric.direction));
  }
  return scales;
}

function rankHeatClass(rank: number): string {
  if (rank <= 0.2) return styles.heatLag;
  if (rank <= 0.4) return styles.heatLow;
  if (rank <= 0.6) return styles.heatMiddle;
  if (rank <= 0.8) return styles.heatGood;
  return styles.heatLead;
}

function metricHeatClass(
  row: CreativeStudioAssetRow,
  metric: MetricDefinition,
  scales: ReadonlyMap<CreativeAssetMetricId, MetricRankScale>,
): string {
  const value = row.metrics[metric.id];
  // An unmeasured cell is not a bad cell. It carries no colour at all, so the
  // ramp never makes a claim about a number nobody read.
  if (!isFiniteNumber(value)) return styles.heatMissing;
  if (metric.direction === 0) return styles.heatNeutral;
  const rank = scales.get(metric.id)?.get(value);
  if (rank === undefined) return styles.heatMissing;
  return rankHeatClass(rank);
}

/**
 * The sort the operator asked for, on one column, in one direction.
 *
 * THE EM DASH SORTS LAST BOTH WAYS. An unavailable metric is not a small
 * number — it is the absence of a number — so it leaves the ranked block
 * entirely rather than piling up at whichever end "smallest" happens to be.
 * The previous implementation coerced it to `Number.NEGATIVE_INFINITY`, which
 * is correct only while the table can be sorted one way; the moment ascending
 * exists, every unread creative would head the table.
 *
 * A MEASURED ZERO IS A ZERO and sorts among the numbers, because somebody read
 * it.
 */
type AssetSortDirection = "asc" | "desc";

interface AssetSortState {
  key: CreativeAssetMetricId;
  direction: AssetSortDirection;
}

function compareByMetric(
  left: CreativeStudioAssetRow,
  right: CreativeStudioAssetRow,
  sort: AssetSortState,
): number {
  const leftValue = left.metrics[sort.key];
  const rightValue = right.metrics[sort.key];
  const leftMeasured = isFiniteNumber(leftValue);
  const rightMeasured = isFiniteNumber(rightValue);
  if (!leftMeasured && !rightMeasured) return 0;
  if (!leftMeasured) return 1;
  if (!rightMeasured) return -1;
  if (leftValue === rightValue) return 0;
  return sort.direction === "asc"
    ? leftValue - rightValue
    : rightValue - leftValue;
}

function sortDirectionLabel(direction: AssetSortDirection): string {
  return direction === "asc" ? "low to high" : "high to low";
}

function roasTone(value: number | null | undefined): CreativeStudioTone {
  if (!isFiniteNumber(value)) return "neutral";
  if (value >= 3.8) return "positive";
  if (value < 2.5) return "negative";
  if (value < 3) return "warning";
  return "neutral";
}

function safeCustomMetrics(value: unknown): CreativeAssetMetricId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CUSTOM_METRICS];
  const selected = new Set(
    value.filter(
      (candidate): candidate is CreativeAssetMetricId =>
        typeof candidate === "string" &&
        METRICS.some((metric) => metric.id === candidate),
    ),
  );
  return METRICS.map((metric) => metric.id).filter((id) => selected.has(id));
}

/**
 * An operator's stored column set, carried across the catalogue change.
 *
 * WHY THIS IS NOT JUST `safeCustomMetrics`. That function drops ids the
 * catalogue no longer knows, which is right, but it cannot tell WHY a set came
 * back empty. Two records reduce to `[]` and they mean opposite things:
 *
 *   { version: 2, customMetrics: [] }        the operator un-ticked every
 *                                            metric in the picker. Their
 *                                            choice, honoured.
 *   { version: 1, customMetrics: ["hold"] }  a set this change emptied. The
 *                                            operator chose a column that no
 *                                            longer exists, and handing them a
 *                                            table with no metric columns would
 *                                            be this change breaking their
 *                                            saved view.
 *
 * So a version-1 record whose ids ALL disappeared falls back to the defaults,
 * and a version-1 record that keeps at least one id keeps exactly those. A
 * version-2 record is taken literally, empty or not. Anything else — no record,
 * a future version, unparseable JSON — starts from the defaults.
 *
 * Pins are deliberately NOT reset by the version bump: a pinned id is a
 * creative id, which this change did not touch, and discarding the operator's
 * working set to migrate a column list would lose a fact to fix a presentation.
 */
function readPersistedCustomMetrics(
  version: unknown,
  stored: unknown,
): CreativeAssetMetricId[] {
  if (version === PERSISTENCE_VERSION) return safeCustomMetrics(stored);
  if (version !== 1 || !Array.isArray(stored))
    return [...DEFAULT_CUSTOM_METRICS];
  const kept = safeCustomMetrics(stored);
  if (stored.length > 0 && kept.length === 0)
    return [...DEFAULT_CUSTOM_METRICS];
  return kept;
}

/** A stored record this reader is willing to migrate from. */
function isReadablePersistenceVersion(version: unknown): boolean {
  return version === PERSISTENCE_VERSION || version === 1;
}

function safePinnedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (candidate): candidate is string => typeof candidate === "string",
      ),
    ),
  );
}

function handleKeyboardActivation(
  event: KeyboardEvent<HTMLElement>,
  callback: () => void,
) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  callback();
}

function AssetVisual({
  row,
  compact = false,
}: {
  row: CreativeStudioAssetRow;
  compact?: boolean;
}) {
  const className = compact ? styles.assetThumb : styles.boardPreview;
  if (row.imageUrl) {
    return (
      <img alt="" className={className} draggable={false} src={row.imageUrl} />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} ${styles.assetPlaceholder}`}
    />
  );
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td className={styles.emptyTableCell} colSpan={colSpan}>
        {message}
      </td>
    </tr>
  );
}

function TabCount({
  active,
  count,
}: {
  active: boolean;
  count: number | null | undefined;
}) {
  if (count === 0 || count === undefined) return null;
  return (
    <span
      // A number is part of what the tab says and is announced with it. The em
      // dash is not: it means "this screen was not served the count", and
      // "Inbox, dash" is noise rather than information.
      aria-hidden={count === null ? "true" : undefined}
      className={active ? styles.tabCountActive : styles.tabCount}
    >
      {count === null ? EM_DASH : count}
    </span>
  );
}

function CreativeStudioTabs({
  activeTab,
  counts,
  tabHrefs,
}: Pick<CreativeStudioExactProps, "activeTab" | "counts" | "tabHrefs">) {
  return (
    <nav aria-label="Creative Studio views" className={styles.tabs}>
      {TABS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <a
            aria-current={active ? "page" : undefined}
            className={active ? styles.tabActive : styles.tab}
            data-creative-studio-tab={tab.id}
            href={tabHrefs[tab.id]}
            key={tab.id}
          >
            {tab.label}
            <TabCount active={active} count={counts[tab.id]} />
          </a>
        );
      })}
    </nav>
  );
}

function AssetsView({
  model,
}: {
  model: CreativeStudioAssetsModel | undefined;
}) {
  const rows = model?.rows ?? [];
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [metricSet, setMetricSet] = useState<MetricSetId>("performance");
  const [customMetrics, setCustomMetrics] = useState<CreativeAssetMetricId[]>([
    ...DEFAULT_CUSTOM_METRICS,
  ]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Held here, in a component mounted at module top level, so a parent re-render
  // — a refetch landing, the freshness bar ticking, the operator pinning a row —
  // cannot reset the operator's sort. Deliberately NOT reset by the persistence
  // effect below, which owns pins and the Custom metric set only.
  const [sort, setSort] = useState<AssetSortState>({
    key: "spend",
    direction: "desc",
  });
  const [query, setQuery] = useState("");
  const [hydratedPersistenceKey, setHydratedPersistenceKey] = useState<
    string | null
  >(null);
  const persistenceKey = model?.persistenceKey?.trim() || null;

  useEffect(() => {
    if (!persistenceKey || typeof window === "undefined") {
      setPinnedIds([]);
      setCustomMetrics([...DEFAULT_CUSTOM_METRICS]);
      setHydratedPersistenceKey(null);
      return;
    }

    let nextPinnedIds: string[] = [];
    let nextCustomMetrics = [...DEFAULT_CUSTOM_METRICS];
    try {
      const raw = window.localStorage.getItem(persistenceKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          version?: unknown;
          pinnedIds?: unknown;
          customMetrics?: unknown;
        };
        if (isReadablePersistenceVersion(parsed.version)) {
          nextPinnedIds = safePinnedIds(parsed.pinnedIds);
          nextCustomMetrics = readPersistedCustomMetrics(
            parsed.version,
            parsed.customMetrics,
          );
        }
      }
    } catch {
      nextPinnedIds = [];
      nextCustomMetrics = [...DEFAULT_CUSTOM_METRICS];
    }
    setPinnedIds(nextPinnedIds);
    setCustomMetrics(nextCustomMetrics);
    setHydratedPersistenceKey(persistenceKey);
  }, [persistenceKey]);

  useEffect(() => {
    model?.onPinnedIdsChange?.([...pinnedIds]);
  }, [model?.onPinnedIdsChange, pinnedIds]);

  useEffect(() => {
    if (
      !persistenceKey ||
      hydratedPersistenceKey !== persistenceKey ||
      typeof window === "undefined"
    ) {
      return;
    }
    try {
      window.localStorage.setItem(
        persistenceKey,
        JSON.stringify({
          version: PERSISTENCE_VERSION,
          pinnedIds,
          customMetrics,
        }),
      );
    } catch {
      // Storage can be unavailable in hardened/private browser contexts. The
      // Studio remains usable for the current session and never fabricates a save.
    }
  }, [customMetrics, hydratedPersistenceKey, persistenceKey, pinnedIds]);

  const selectedMetricIds =
    metricSet === "custom" ? customMetrics : METRIC_PRESETS[metricSet];
  const selectedMetricSet = new Set<CreativeAssetMetricId>(selectedMetricIds);
  /*
   * COLUMN ORDER IS THE PRESET'S OWN, not the catalogue's.
   *
   * A preset is an argument — evidence, then outcome, then the ROAS
   * decomposition, then decay for Performance; the six ladder steps in order
   * for Funnel — and reordering it into catalogue order would scramble the
   * argument into an alphabet. The Custom set has no authored order (the picker
   * is a grid of categories, and toggling rebuilds the list), so it keeps the
   * catalogue's, which is stable no matter which order the operator ticked
   * boxes in.
   */
  const visibleMetrics = useMemo(() => {
    if (metricSet === "custom") {
      const chosen = new Set<CreativeAssetMetricId>(customMetrics);
      return METRICS.filter((metric) => chosen.has(metric.id));
    }
    return METRIC_PRESETS[metricSet].flatMap((id) => {
      const metric = METRICS.find((candidate) => candidate.id === id);
      return metric ? [metric] : [];
    });
  }, [customMetrics, metricSet]);

  const tableRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows
      .filter(
        (row) =>
          !normalizedQuery || row.name.toLowerCase().includes(normalizedQuery),
      )
      .slice()
      .sort(
        (left, right) =>
          // Name and id break every remaining tie so the order is a function of
          // the data alone. Without them two creatives with the same value —
          // and 62 of the live account's 93 measured ROAS cells are the same
          // value — could swap places on an unrelated re-render.
          compareByMetric(left, right, sort) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      );
  }, [query, rows, sort]);

  // The colour population is the table as it stands, so the legend's "across
  // these creatives" stays literally true while the operator searches.
  const rankScales = useMemo(
    () => buildMetricRankScales(tableRows, METRICS),
    [tableRows],
  );

  const sortedMetric = METRICS.find((metric) => metric.id === sort.key) ?? null;
  const toggleSort = (metricId: CreativeAssetMetricId) => {
    setSort((current) =>
      current.key === metricId
        ? {
            key: metricId,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key: metricId, direction: "desc" },
    );
  };

  const rowById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  );
  const pinnedRows = pinnedIds
    .map((id) => rowById.get(id))
    .filter((row): row is CreativeStudioAssetRow => Boolean(row));

  const togglePin = (rowId: string) => {
    setPinnedIds((current) =>
      current.includes(rowId)
        ? current.filter((candidate) => candidate !== rowId)
        : [...current, rowId],
    );
  };

  const toggleMetric = (metricId: CreativeAssetMetricId) => {
    const nextSet = new Set(selectedMetricIds);
    if (nextSet.has(metricId)) nextSet.delete(metricId);
    else nextSet.add(metricId);
    setCustomMetrics(
      METRICS.map((metric) => metric.id).filter((id) => nextSet.has(id)),
    );
    setMetricSet("custom");
  };

  return (
    <>
      <div
        className={styles.assetsToolbar}
        data-creative-studio-exact-section="assets"
      >
        <span className={styles.mutedMono}>
          visual assets · heat table + comparison board
        </span>
        <span className={styles.flexSpacer} />
        <select
          aria-label="Sort creatives"
          className={styles.compactSelect}
          // Every metric, not the three this control used to offer. The column
          // headers set the same state, so the two controls can never disagree
          // about what the table is sorted by.
          onChange={(event) =>
            setSort((current) => ({
              key: event.target.value as CreativeAssetMetricId,
              direction: current.direction,
            }))
          }
          value={sort.key}
        >
          {METRICS.map((metric) => (
            <option key={metric.id} value={metric.id}>
              {`Sort: ${metric.label}`}
            </option>
          ))}
        </select>
        <button
          aria-label={`Sort direction: ${sortDirectionLabel(sort.direction)}`}
          className={styles.sortDirectionButton}
          data-assets-sort-direction={sort.direction}
          onClick={() =>
            setSort((current) => ({
              key: current.key,
              direction: current.direction === "desc" ? "asc" : "desc",
            }))
          }
          type="button"
        >
          {sort.direction === "desc" ? "↓ High to low" : "↑ Low to high"}
        </button>
        <input
          aria-label="Search creatives"
          className={styles.searchInput}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search creatives…"
          type="search"
          value={query}
        />
      </div>

      <section className={styles.comparisonBoard}>
        <div className={styles.sectionHeadingRow}>
          <h2>Comparison board</h2>
          <span className={styles.mutedMono}>
            {pinnedRows.length} pinned · your working set, never auto-fills
          </span>
          <span className={styles.flexSpacer} />
          {pinnedRows.length > 0 ? (
            <button
              className={styles.clearButton}
              onClick={() => setPinnedIds([])}
              type="button"
            >
              Clear board
            </button>
          ) : null}
        </div>

        {pinnedRows.length === 0 ? (
          <div className={styles.boardEmpty}>
            <div>
              <p className={styles.boardEmptyTitle}>Board is empty</p>
              <p className={styles.boardEmptyCopy}>
                Tick creatives in the table below to pin them here as cards for
                side-by-side review.
              </p>
            </div>
          </div>
        ) : (
          <div className={styles.boardGrid}>
            {pinnedRows.map((row) => (
              <article
                className={styles.boardCard}
                data-pinned-asset={row.id}
                key={row.id}
              >
                <button
                  aria-label={`Unpin ${row.name}`}
                  className={styles.unpinButton}
                  onClick={() => togglePin(row.id)}
                  type="button"
                >
                  ✕
                </button>
                <div className={styles.boardVisual}>
                  <AssetVisual row={row} />
                  <span className={styles.kindBadge}>
                    {displayText(row.kind)}
                  </span>
                  <span
                    className={`${styles.statusBadge} ${TONE_CLASSES[row.statusTone]}`}
                    title={row.statusDetail ?? undefined}
                  >
                    {creativeDecisionStatusText(row)}
                  </span>
                </div>
                <div className={styles.boardCardBody}>
                  <p className={styles.boardCardName}>
                    {displayText(row.name)}
                  </p>
                  <div className={styles.boardMetrics}>
                    {/*
                      The pinned card carries the scale / keep / cut summary:
                      what it cost, what it returned, the ratio between them and
                      what a purchase cost.

                      It used to carry Thumbstop and Hold. Hold was hardcoded
                      `null` in the projector, and Thumbstop is stamped
                      unavailable by the warehouse producer on the window this
                      surface defaults to, so half of every pinned card was two
                      em dashes stacked under a real spend and ROAS.
                    */}
                    <BoardMetric
                      label="Spend"
                      value={formatMetric(row, "spend")}
                    />
                    <BoardMetric
                      label="Revenue"
                      value={formatMetric(row, "revenue")}
                    />
                    <BoardMetric
                      label="ROAS"
                      tone={roasTone(row.metrics.roas)}
                      value={formatMetric(row, "roas")}
                    />
                    <BoardMetric label="CPA" value={formatMetric(row, "cpa")} />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <article className={styles.creativesTableArticle}>
        <div className={styles.tableControlRow}>
          <h2>All creatives</h2>
          <span className={styles.mutedMono}>
            {model?.syncedCount === null || model?.syncedCount === undefined
              ? EM_DASH
              : model.syncedCount}{" "}
            synced · Meta
          </span>
          <span className={styles.flexSpacer} />
          <span className={styles.columnsLabel}>Columns</span>
          {(
            [
              ["performance", "Performance"],
              ["engagement", "Engagement"],
              ["funnel", "Funnel"],
              [
                "custom",
                metricSet === "custom"
                  ? `Custom · ${customMetrics.length}`
                  : "Custom",
              ],
            ] as const
          ).map(([id, label]) => (
            <button
              aria-pressed={metricSet === id}
              className={
                metricSet === id ? styles.metricSetActive : styles.metricSet
              }
              key={id}
              onClick={() => setMetricSet(id)}
              type="button"
            >
              {label}
            </button>
          ))}
          <button
            aria-expanded={pickerOpen}
            className={
              pickerOpen
                ? styles.metricPickerButtonOpen
                : styles.metricPickerButton
            }
            onClick={() => setPickerOpen((open) => !open)}
            type="button"
          >
            + Edit metrics
          </button>

          {pickerOpen ? (
            <div
              className={styles.metricPicker}
              data-creative-studio-metric-picker
            >
              <div className={styles.metricPickerHeader}>
                <p>Table metrics</p>
                <span>edits save as the Custom set</span>
                <button
                  aria-label="Close metric picker"
                  className={styles.metricPickerClose}
                  onClick={() => setPickerOpen(false)}
                  type="button"
                >
                  ✕
                </button>
              </div>
              <div className={styles.metricPickerGrid}>
                {METRIC_CATEGORIES.map((category) => (
                  <div key={category}>
                    <p className={styles.metricCategory}>{category}</p>
                    {METRICS.filter(
                      (metric) => metric.category === category,
                    ).map((metric) => {
                      const selected = selectedMetricSet.has(metric.id);
                      return (
                        <button
                          aria-pressed={selected}
                          className={styles.metricPickerOption}
                          key={metric.id}
                          onClick={() => toggleMetric(metric.id)}
                          type="button"
                        >
                          <span
                            aria-hidden="true"
                            className={
                              selected
                                ? styles.metricCheckboxSelected
                                : styles.metricCheckbox
                            }
                          >
                            ✓
                          </span>
                          <span>{metric.label}</span>
                          <span className={styles.metricDirection}>
                            {metricDirectionLabel(metric.direction)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className={styles.heatLegend}>
          <span>cell color = rank across these creatives on that metric</span>
          <span aria-hidden="true" className={styles.heatRamp} />
          <span>
            lags → leads · ↓ = lower is better · volume columns stay neutral
          </span>
          <span className={styles.flexSpacer} />
          {/*
            The active sort, said out loud. `role="status"` so a screen-reader
            operator hears the column and direction change when they activate a
            header, not just sighted operators who can see the glyph move.
          */}
          <span className={styles.sortState} role="status">
            {sortedMetric
              ? `sorted by ${sortedMetric.label} · ${sortDirectionLabel(sort.direction)} · ${EM_DASH} last`
              : `sorted by ${EM_DASH}`}
          </span>
        </div>

        <div
            className={styles.tableScroller}
            /* A region that scrolls but cannot be focused is unreachable by
               keyboard whenever its content has no focusable element of its own —
               and every one of these tables is read-only. Zero is the documented
               remedy for axe's scrollable-region-focusable; the name is what
               tells a screen-reader user what they just landed in. */
            tabIndex={0}
            role="region"
            aria-label="Assets table, scrolls sideways"
          >
          <table
            className={styles.assetTable}
            data-assets-sort={sort.key}
            data-assets-sort-direction={sort.direction}
          >
            <thead>
              <tr>
                <th className={styles.selectionColumn} />
                <th scope="col">Creative</th>
                <th scope="col">Status</th>
                <th scope="col">Marketing angle</th>
                {visibleMetrics.map((metric) => {
                  const active = sort.key === metric.id;
                  return (
                    <th
                      // `aria-sort` is the accessible half of the indicator the
                      // glyph provides visually. Both name one column and one
                      // direction, so neither can be the only thing that knows.
                      aria-sort={
                        active
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                      className={styles.numericHeader}
                      key={metric.id}
                      scope="col"
                    >
                      {/*
                        A real button: focusable in tab order, activated by
                        Enter and Space by the platform, and announced as a
                        button — none of which a `<th onClick>` gives.
                      */}
                      <button
                        className={
                          active ? styles.sortHeaderActive : styles.sortHeader
                        }
                        data-metric-sort={metric.id}
                        onClick={() => toggleSort(metric.id)}
                        title={`Sort by ${metric.label}`}
                        type="button"
                      >
                        <span>{metricHeader(metric)}</span>
                        <span aria-hidden="true" className={styles.sortGlyph}>
                          {active ? (sort.direction === "asc" ? "▲" : "▼") : ""}
                        </span>
                      </button>
                    </th>
                  );
                })}
                <th className={styles.tableTail} />
              </tr>
            </thead>
            <tbody>
              {tableRows.length === 0 ? (
                <EmptyRow
                  colSpan={visibleMetrics.length + 5}
                  message={modelMessage(model)}
                />
              ) : (
                tableRows.map((row) => {
                  const pinned = pinnedIds.includes(row.id);
                  return (
                    <tr
                      aria-checked={pinned}
                      className={
                        pinned ? styles.assetRowPinned : styles.assetRow
                      }
                      data-creative-studio-asset-row={row.id}
                      key={row.id}
                      onClick={() => togglePin(row.id)}
                      onKeyDown={(event) =>
                        handleKeyboardActivation(event, () => togglePin(row.id))
                      }
                      role="checkbox"
                      tabIndex={0}
                    >
                      <td className={styles.selectionCell}>
                        <span
                          aria-hidden="true"
                          className={
                            pinned
                              ? styles.rowCheckboxSelected
                              : styles.rowCheckbox
                          }
                        >
                          ✓
                        </span>
                      </td>
                      <td>
                        <div className={styles.creativeIdentity}>
                          <AssetVisual compact row={row} />
                          <span className={styles.creativeIdentityText}>
                            <span>{displayText(row.name)}</span>
                            <span>
                              {displayText(row.kind)}
                              {/*
                                The provider's delivery state, which used to be
                                the whole Status column. It is still on screen —
                                it just no longer occupies the column the
                                engine's classification belongs in.
                              */}
                              {row.deliveryStatus ? (
                                <span
                                  className={styles.deliveryStatus}
                                  data-creative-delivery-status={
                                    row.deliveryStatus
                                  }
                                >
                                  {row.deliveryStatus}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`${styles.tableStatus} ${TONE_CLASSES[row.statusTone]}`}
                          data-creative-classification={
                            row.status?.trim() || "Not evaluated"
                          }
                          data-creative-decision-segment={
                            row.decisionSegment?.trim() || "none"
                          }
                          title={row.statusDetail ?? undefined}
                        >
                          {creativeDecisionStatusText(row)}
                        </span>
                      </td>
                      {/*
                        `title` because the cell now truncates: the metric block
                        to its right grew from four or five columns to as many
                        as eleven, and an uncapped angle list ("Comfort, Value,
                        Seasonal, Gifting") would push the creative's own name
                        off screen before the first number.
                      */}
                      <td
                        className={styles.angleCell}
                        title={row.marketingAngle ?? undefined}
                      >
                        {displayText(row.marketingAngle)}
                      </td>
                      {visibleMetrics.map((metric) => (
                        <td className={styles.metricCell} key={metric.id}>
                          <span
                            className={metricHeatClass(row, metric, rankScales)}
                          >
                            {formatMetric(row, metric.id)}
                          </span>
                        </td>
                      ))}
                      <td className={styles.tableTail} />
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </article>

      <p className={styles.closingNote}>
        Thumbnails render from synced ad assets — drop real creative exports to
        replace placeholders. Board picks and the Custom column set persist per
        operator.
      </p>
    </>
  );
}

function BoardMetric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: CreativeStudioTone;
  value: string;
}) {
  return (
    <span className={styles.boardMetric}>
      <span>{label}</span>
      <span className={TONE_CLASSES[tone]}>{value}</span>
    </span>
  );
}

function CopiesView({
  model,
}: {
  model: CreativeStudioCopiesModel | undefined;
}) {
  const angles = model?.angles ?? [];
  const rows = model?.rows ?? [];
  const angleSlots = Array.from(
    { length: 4 },
    (_, index) => angles[index] ?? null,
  );
  return (
    <>
      <div
        className={styles.angleGrid}
        data-creative-studio-exact-section="copies"
      >
        {angleSlots.map((angle, index) =>
          angle ? (
            <article
              className={`${styles.angleCard} ${TONE_CLASSES[angle.tone]}`}
              data-copy-angle={angle.id}
              key={angle.id}
            >
              <div className={styles.angleCardHeader}>
                <p>{displayText(angle.name)}</p>
                <span>
                  {isFiniteNumber(angle.lines) ? angle.lines : EM_DASH} lines
                </span>
              </div>
              <div className={styles.angleMetrics}>
                <SummaryMetric
                  label="Spend share"
                  value={formatPercent(angle.spendShare, 0)}
                />
                <SummaryMetric
                  label="ROAS"
                  tone={roasTone(angle.roas)}
                  value={formatRatio(angle.roas)}
                />
                <SummaryMetric
                  label="CTR"
                  value={formatPercent(angle.ctr, 2)}
                />
              </div>
              <p className={styles.angleBestLine}>
                Best line: <strong>“{displayText(angle.bestLine)}”</strong>
              </p>
              <p className={styles.angleUsage}>{displayText(angle.usage)}</p>
            </article>
          ) : (
            <article
              className={`${styles.angleCard} ${TONE_CLASSES.neutral}`}
              data-copy-angle={`empty-${index + 1}`}
              key={`empty-${index + 1}`}
            >
              <div className={styles.angleCardHeader}>
                <p>{EM_DASH}</p>
                <span>{EM_DASH} lines</span>
              </div>
              <div className={styles.angleMetrics}>
                <SummaryMetric label="Spend share" value={EM_DASH} />
                <SummaryMetric label="ROAS" value={EM_DASH} />
                <SummaryMetric label="CTR" value={EM_DASH} />
              </div>
              <p className={styles.angleBestLine}>
                Best line: <strong>“{EM_DASH}”</strong>
              </p>
              <p className={styles.angleUsage}>{EM_DASH}</p>
            </article>
          ),
        )}
      </div>

      <div className={styles.angleCoverage}>
        <span>Angle coverage</span>
        <p>{displayText(model?.angleCoverage)}</p>
        {(model?.angleGaps ?? []).map((gap) => (
          <span className={styles.angleGap} key={gap}>
            {gap}
          </span>
        ))}
      </div>

      <article className={styles.borderedTableArticle}>
        <div className={styles.articleHeader}>
          <h2>Copy performance</h2>
          {/* The window is named from what was measured, never from a
              literal: a hardcoded "28d" labelled a 14-day or custom selection
              as 28 days. Unknown withholds instead of guessing. */}
          <span>
            {`aggregated per exact string · ${model?.windowLabel ?? EM_DASH} · click a line for alternates`}
          </span>
          <span className={styles.insightPill}>
            {displayText(model?.insight)}
          </span>
        </div>
        <div
            className={styles.tableScroller}
            /* A region that scrolls but cannot be focused is unreachable by
               keyboard whenever its content has no focusable element of its own —
               and every one of these tables is read-only. Zero is the documented
               remedy for axe's scrollable-region-focusable; the name is what
               tells a screen-reader user what they just landed in. */
            tabIndex={0}
            role="region"
            aria-label="Copy table, scrolls sideways"
          >
          <table className={styles.copyTable}>
            <thead>
              <tr>
                <th>Copy</th>
                <th>Angle</th>
                <th className={styles.numericHeader}>Ads</th>
                <th className={styles.numericHeader}>Spend</th>
                <th className={styles.numericHeader}>See more</th>
                <th className={styles.numericHeader}>CTR</th>
                <th className={styles.numericHeader}>Engage</th>
                <th className={styles.numericHeader}>CVR</th>
                <th className={styles.numericHeader}>ROAS</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={9} message={modelMessage(model)} />
              ) : (
                rows.map((row) => {
                  const open = model?.onOpenRow
                    ? () => model.onOpenRow?.(row.id)
                    : undefined;
                  return (
                    <tr
                      className={open ? styles.clickableTableRow : undefined}
                      data-copy-row={row.id}
                      key={row.id}
                      onClick={open}
                      onKeyDown={
                        open
                          ? (event) => handleKeyboardActivation(event, open)
                          : undefined
                      }
                      tabIndex={open ? 0 : undefined}
                    >
                      <td className={styles.copyCell}>
                        <span>“{displayText(row.text)}”</span>
                        <span>
                          {displayText(row.kind)} · {displayText(row.chars)}{" "}
                          chars
                        </span>
                      </td>
                      <td>
                        <span
                          className={`${styles.anglePill} ${TONE_CLASSES[row.tone]}`}
                        >
                          {displayText(row.angle)}
                        </span>
                      </td>
                      <td className={styles.numericCell}>
                        {displayText(row.ads)}
                      </td>
                      <td className={styles.numericCell}>
                        {formatMoney(row.spend, row.currency, true)}
                      </td>
                      <td className={styles.numericStrong}>
                        {formatPercent(row.seeMore, 1)}
                      </td>
                      <td className={styles.numericCell}>
                        {formatPercent(row.ctr, 2)}
                      </td>
                      <td className={styles.numericCell}>
                        {formatPercent(row.engagement, 1)}
                      </td>
                      <td className={styles.numericCell}>
                        {formatPercent(row.cvr, 1)}
                      </td>
                      <td className={styles.numericCell}>
                        <span
                          className={`${styles.roasPill} ${TONE_CLASSES[roasTone(row.roas)]}`}
                        >
                          {formatRatio(row.roas)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </article>

      <p className={styles.closingNote}>
        See more = expansions of truncated primaries · Engage = reactions +
        comments + shares per impression. Angles are auto-tagged and editable
        per line; click any line for angle-shifted alternates.
      </p>
    </>
  );
}

function SummaryMetric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: CreativeStudioTone;
  value: string;
}) {
  return (
    <span className={styles.summaryMetric}>
      <span>{label}</span>
      <span className={TONE_CLASSES[tone]}>{value}</span>
    </span>
  );
}

function ReadItems({
  items,
  message,
  showEstimate,
}: {
  items: readonly CreativeStudioReadItem[];
  message: string;
  showEstimate?: boolean;
}) {
  if (items.length === 0)
    return <div className={styles.readEmpty}>{message}</div>;
  return (
    <div className={styles.readItems}>
      {items.map((item) => (
        <div className={styles.readItem} key={item.id}>
          {showEstimate ? null : (
            <span className={`${styles.readKind} ${TONE_CLASSES[item.tone]}`}>
              {displayText(item.kind)}
            </span>
          )}
          <p>{displayText(item.text)}</p>
          {showEstimate ? (
            <span className={styles.testEstimate}>
              {displayText(item.estimate)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function LandingPagesView({
  model,
}: {
  model: CreativeStudioLandingModel | undefined;
}) {
  const rows = model?.rows ?? [];
  const message = modelMessage(model);
  return (
    <>
      <div
        className={styles.landingGrid}
        data-creative-studio-exact-section="landing-pages"
      >
        <article className={styles.borderedTableArticle}>
          <div className={styles.articleHeader}>
            <h2>Destinations behind ads</h2>
            <span>
              {`Meta-reported only — link clicks + pixel LP views · no analytics join · ${model?.windowLabel ?? EM_DASH}`}
            </span>
          </div>
          <div
            className={styles.tableScroller}
            /* A region that scrolls but cannot be focused is unreachable by
               keyboard whenever its content has no focusable element of its own —
               and every one of these tables is read-only. Zero is the documented
               remedy for axe's scrollable-region-focusable; the name is what
               tells a screen-reader user what they just landed in. */
            tabIndex={0}
            role="region"
            aria-label="Landing page table, scrolls sideways"
          >
            <table className={styles.landingTable}>
              <thead>
                <tr>
                  <th>Destination</th>
                  <th className={styles.numericHeader}>Ads</th>
                  <th className={styles.numericHeader}>Spend</th>
                  <th className={styles.numericHeader}>Link clicks</th>
                  <th className={styles.numericHeader}>LP view rate</th>
                  <th className={styles.numericHeader}>CVR</th>
                  <th className={styles.numericHeader}>CPA</th>
                  <th className={styles.numericHeader}>ROAS</th>
                  <th>Signal</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <EmptyRow colSpan={9} message={message} />
                ) : (
                  rows.map((row) => (
                    <tr data-landing-row={row.id} key={row.id}>
                      <td className={styles.destinationCell}>
                        {displayText(row.destination)}
                      </td>
                      <td className={styles.numericCell}>
                        {displayText(row.ads)}
                      </td>
                      <td className={styles.numericCell}>
                        {formatMoney(row.spend, row.currency, true)}
                      </td>
                      <td className={styles.numericCell}>
                        {formatNumber(row.linkClicks)}
                      </td>
                      <td className={styles.numericStrong}>
                        {formatPercent(row.landingPageViewRate, 0)}
                      </td>
                      <td className={styles.numericStrong}>
                        {formatPercent(row.cvr, 1)}
                      </td>
                      <td className={styles.numericCell}>
                        {formatMoney(row.cpa, row.currency, false, 2)}
                      </td>
                      <td className={styles.numericCell}>
                        <span
                          className={`${styles.roasPill} ${TONE_CLASSES[roasTone(row.roas)]}`}
                        >
                          {formatRatio(row.roas)}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`${styles.signalPill} ${TONE_CLASSES[row.signalTone]}`}
                        >
                          {displayText(row.signal)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>

        <div className={styles.landingReads}>
          <article className={styles.readCard}>
            <h2>What’s missing</h2>
            <p className={styles.readSubtitle}>
              Gaps the engine sees in the current link map.
            </p>
            <ReadItems items={model?.gaps ?? []} message={message} />
          </article>
          <article className={styles.readCard}>
            <h2>What to try</h2>
            {/* The items below carry no href and no callback, and no server
                intent is minted for them — nothing here starts a draft. The
                sentence claimed a flow that has no producer, so it states what
                the reads are instead of what they would do. */}
            <p className={styles.readSubtitle}>
              Test ideas from the reads below. Drafting them in Launchpad is not
              built.
            </p>
            <ReadItems
              items={model?.tests ?? []}
              message={message}
              showEstimate
            />
          </article>
        </div>
      </div>

      <article className={styles.historyCard}>
        <div className={styles.historyHeader}>
          <h2>Destination history</h2>
          <span>
            what changed, what it did — these reads feed the test ideas
          </span>
        </div>
        <div className={styles.historyRows}>
          {(model?.history ?? []).length === 0 ? (
            <div className={styles.historyEmpty}>{message}</div>
          ) : (
            model?.history.map((item) => (
              <div className={styles.historyRow} key={item.id}>
                <span>{displayText(item.date)}</span>
                <span>{displayText(item.text)}</span>
                <span className={TONE_CLASSES[item.tone]}>
                  {displayText(item.result)}
                </span>
              </div>
            ))
          )}
        </div>
      </article>
    </>
  );
}

/**
 * One served briefing item.
 *
 * The owner avatar and the due date this card used to draw are gone rather than
 * dashed out. An em dash means "this was not served"; drawing one in an owner
 * slot and a due-date slot would still be telling the reader that this product
 * assigns owners and tracks due dates and merely has none for this card. It
 * does neither. What is drawn instead is the engine's own served label, its own
 * one-line summary, and the card's measured numbers — where a null value is an
 * em dash and a measured zero prints as zero.
 *
 * No action button: there is no request, version, approval or handoff action on
 * this surface to attach one to.
 */
function InboxCard({ card }: { card: CreativeStudioInboxCard }) {
  return (
    <article className={styles.inboxCard} data-inbox-card={card.id}>
      <span
        className={`${styles.inboxSource} ${TONE_CLASSES[card.sourceTone]}`}
      >
        {displayText(card.source)}
      </span>
      <p className={styles.inboxCardName}>{displayText(card.name)}</p>
      <p className={styles.inboxCardNote}>{displayText(card.note)}</p>
      <div className={styles.inboxCardFooter}>
        {card.facts.map((fact) => (
          <span
            className={styles.inboxDue}
            data-inbox-fact={fact.label}
            key={fact.label}
          >
            {fact.label} {displayText(fact.value)}
          </span>
        ))}
      </div>
    </article>
  );
}

function InboxView({ model }: { model: CreativeStudioExactProps["inbox"] }) {
  const sourceColumns = new Map(
    (model?.columns ?? []).map((column) => [column.id, column]),
  );
  const columns = INBOX_COLUMNS.map((definition) => ({
    ...definition,
    cards: sourceColumns.get(definition.id)?.cards ?? [],
  }));
  const allEmpty = columns.every((column) => column.cards.length === 0);

  return (
    <>
      <div
        className={styles.routingStrip}
        data-creative-studio-exact-section="inbox"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
        {/* What this board is, and what it is not. The three segments below
            are the creative-briefing authority's own served sections; the
            request -> version -> approval -> handoff workflow the design
            imagined here has no producer anywhere in this product, so it is
            named as unbuilt rather than drawn as four empty columns that read
            like a workflow with no traffic. */}
        <p>
          These are the creative decision items the briefing authority serves
          for this account, in the segments it serves them. Requesting a
          creative, versioning a delivered file, approving it and handing it to{" "}
          <b>Launchpad</b> are not built: no request, owner, due date, version
          or approval is recorded anywhere in this product.
        </p>
      </div>

      <div
        className={styles.inboxBoard}
        tabIndex={0}
        role="region"
        aria-label="Creative inbox columns, scroll sideways"
      >
        {columns.map((column, index) => (
          <div
            className={styles.inboxColumn}
            data-inbox-column={column.id}
            key={column.id}
          >
            <div className={styles.inboxColumnHeader}>
              <span
                className={`${styles.columnDot} ${TONE_CLASSES[column.tone]}`}
              />
              <span>{column.name}</span>
              <span>{column.cards.length}</span>
            </div>
            {column.cards.map((card) => (
              <InboxCard card={card} key={card.id} />
            ))}
            {allEmpty && index === 0 ? (
              <p className={styles.inboxEmpty}>{modelMessage(model)}</p>
            ) : null}
          </div>
        ))}
      </div>

      {/* The drop zone that used to sit here is gone. It offered "Drop new
          exports here" over a permanently disabled Browse files button: there
          is no multipart handler and no storage dependency in this tree, so
          nothing could ever be dropped. A dead affordance for an unbuilt
          workflow is the same claim the four pipeline columns were making, and
          it is removed for the same reason. */}
    </>
  );
}

function BreakdownCard({ breakdown }: { breakdown: CreativeStudioBreakdown }) {
  return (
    <article
      className={styles.breakdownCard}
      data-audience-breakdown={breakdown.id}
    >
      <div className={styles.breakdownHeader}>
        <p>{displayText(breakdown.title)}</p>
        <span>{displayText(breakdown.subtitle)}</span>
      </div>
      <div className={styles.breakdownRows}>
        {breakdown.rows.length === 0 ? (
          <div className={styles.breakdownEmpty}>{EM_DASH}</div>
        ) : (
          breakdown.rows.map((row) => (
            <div className={styles.breakdownRow} key={row.id}>
              <span>{displayText(row.label)}</span>
              <span className={styles.breakdownTrack}>
                <span
                  className={`${styles.breakdownFill} ${TONE_CLASSES[row.tone]}`}
                  style={
                    {
                      "--share": isFiniteNumber(row.spendShare)
                        ? `${Math.max(0, Math.min(100, row.spendShare))}%`
                        : "0%",
                    } as CSSProperties
                  }
                />
              </span>
              <span>{formatPercent(row.spendShare, 0)}</span>
              <span className={TONE_CLASSES[row.tone]}>
                {formatRatio(row.roas)}
              </span>
            </div>
          ))
        )}
      </div>
      <p className={styles.breakdownNote}>{displayText(breakdown.note)}</p>
    </article>
  );
}

/**
 * The creative x audience matrix, coloured the same way the Assets table is.
 *
 * It used to compare each cell against four hardcoded ROAS constants — 4.5,
 * 3.8, 3.0, 2.5 — which is a colour scale that knows nothing about the account
 * it is drawn for. On a business running at ROAS 1.8 every cell painted red and
 * on one running at 6 every cell painted green, and in neither case did the
 * colour distinguish the matrix's best cell from its worst. The scale is now
 * the matrix's own measured distribution, and ROAS is higher-is-better, so the
 * same `buildRankLookup` serves both surfaces.
 */
function buildMatrixRankScale(
  rows: readonly CreativeStudioAudienceMatrixRow[],
): MetricRankScale {
  const values: number[] = [];
  for (const row of rows) {
    for (const value of row.values) {
      if (isFiniteNumber(value)) values.push(value);
    }
  }
  return buildRankLookup(values, 1);
}

function matrixHeatClass(value: number | null, scale: MetricRankScale): string {
  if (!isFiniteNumber(value)) return styles.heatMissing;
  const rank = scale.get(value);
  if (rank === undefined) return styles.heatMissing;
  return rankHeatClass(rank);
}

function AudiencesView({
  model,
}: {
  model: CreativeStudioExactProps["audiences"];
}) {
  const summaries = model?.summaries ?? [];
  const breakdowns = model?.breakdowns ?? [];
  const matrixRows = model?.matrixRows ?? [];
  const matrixScale = buildMatrixRankScale(matrixRows);
  const servedMatrixColumns = model?.matrixColumns ?? [];
  const matrixColumns =
    servedMatrixColumns.length > 0
      ? servedMatrixColumns
      : Array.from({ length: AUDIENCE_MATRIX_COLUMN_SLOTS }, () => EM_DASH);
  const message = modelMessage(model);
  const summarySlots = Array.from(
    { length: 4 },
    (_, index) => summaries[index] ?? null,
  );
  const breakdownSlots = AUDIENCE_BREAKDOWN_SLOTS.map((slot, index) => {
    const served = breakdowns[index];
    return {
      id: served?.id ?? `empty-${slot.title.toLowerCase()}`,
      title: slot.title,
      subtitle: served?.subtitle || slot.subtitle,
      note: served?.note ?? null,
      rows: served?.rows ?? [],
    } satisfies CreativeStudioBreakdown;
  });

  return (
    <>
      <div
        className={styles.audienceSummaryGrid}
        data-creative-studio-exact-section="audiences"
      >
        {summarySlots.map((summary, index) =>
          summary ? (
            <article
              className={styles.audienceSummary}
              data-audience-summary={summary.id}
              key={summary.id}
            >
              <div className={styles.audienceSummaryHeader}>
                <p>{displayText(summary.name)}</p>
                <span
                  className={`${styles.tableStatus} ${TONE_CLASSES[summary.tone]}`}
                >
                  {displayText(summary.status)}
                </span>
              </div>
              <div className={styles.audienceMetrics}>
                <SummaryMetric
                  // The window is selectable, so a fixed "28d" here is a claim
                  // about a measurement. Named from what was measured; an
                  // unknown window says so rather than asserting a default.
                  label={`Spend · ${model?.windowLabel ?? EM_DASH}`}
                  value={formatMoney(summary.spend, summary.currency, true)}
                />
                <SummaryMetric
                  label="ROAS"
                  tone={roasTone(summary.roas)}
                  value={formatRatio(summary.roas)}
                />
                <SummaryMetric
                  label="Freq"
                  value={formatRatio(summary.frequency)}
                />
              </div>
              <p className={styles.audienceNote}>{displayText(summary.note)}</p>
            </article>
          ) : (
            <article
              className={styles.audienceSummary}
              data-audience-summary={`empty-${index + 1}`}
              key={`empty-${index + 1}`}
            >
              <div className={styles.audienceSummaryHeader}>
                <p>{EM_DASH}</p>
                <span
                  className={`${styles.tableStatus} ${TONE_CLASSES.neutral}`}
                >
                  {EM_DASH}
                </span>
              </div>
              <div className={styles.audienceMetrics}>
                <SummaryMetric
                  label={`Spend · ${model?.windowLabel ?? EM_DASH}`}
                  value={EM_DASH}
                />
                <SummaryMetric label="ROAS" value={EM_DASH} />
                <SummaryMetric label="Freq" value={EM_DASH} />
              </div>
              <p className={styles.audienceNote}>{EM_DASH}</p>
            </article>
          ),
        )}
      </div>

      <div className={styles.audienceSectionHeading}>
        <h2>Breakdowns &amp; frequency</h2>
        {/* The window is named from what was measured, never from a literal.
            A hardcoded "28d" here labelled a 7-day or custom selection as a
            28-day one, which is a caption asserting a measurement nobody
            performed. Unknown withholds instead of guessing. */}
        <span>
          {`account-wide · ${model?.windowLabel ?? EM_DASH} · bar = spend share · right value = ROAS`}
        </span>
      </div>
      <div className={styles.breakdownGrid}>
        {breakdownSlots.map((breakdown) => (
          <BreakdownCard breakdown={breakdown} key={breakdown.id} />
        ))}
      </div>

      <article className={styles.borderedTableArticle}>
        <div className={styles.articleHeader}>
          <h2>Creative × audience matrix</h2>
          <span>cell = ROAS in that pairing · 28d · blank = not running</span>
          <span
            aria-hidden="true"
            className={`${styles.heatRamp} ${styles.matrixRamp}`}
          />
        </div>
        <div
            className={styles.tableScroller}
            /* A region that scrolls but cannot be focused is unreachable by
               keyboard whenever its content has no focusable element of its own —
               and every one of these tables is read-only. Zero is the documented
               remedy for axe's scrollable-region-focusable; the name is what
               tells a screen-reader user what they just landed in. */
            tabIndex={0}
            role="region"
            aria-label="Creative by audience matrix, scrolls sideways"
          >
          <table className={styles.matrixTable}>
            <thead>
              <tr>
                <th>Creative</th>
                {matrixColumns.map((column) => (
                  <th className={styles.numericHeader} key={column}>
                    {displayText(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrixRows.length === 0 ? (
                <EmptyRow
                  colSpan={Math.max(1, matrixColumns.length + 1)}
                  message={message}
                />
              ) : (
                matrixRows.map((row) => (
                  <tr data-audience-matrix-row={row.id} key={row.id}>
                    <td>
                      <div className={styles.matrixIdentity}>
                        {row.imageUrl ? (
                          <img alt="" draggable={false} src={row.imageUrl} />
                        ) : (
                          <span
                            aria-hidden="true"
                            className={styles.matrixPlaceholder}
                          />
                        )}
                        <span>{displayText(row.name)}</span>
                      </div>
                    </td>
                    {matrixColumns.map((column, index) => {
                      const value = row.values[index] ?? null;
                      return (
                        <td
                          className={styles.metricCell}
                          key={`${row.id}:${column}`}
                        >
                          <span className={matrixHeatClass(value, matrixScale)}>
                            {formatRatio(value)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>
      <p className={styles.closingNote}>{message}</p>
    </>
  );
}

export function CreativeStudioExact({
  activeTab,
  tabHrefs,
  counts,
  onExport,
  onShare,
  /**
   * Why minting is refused, when it is. Non-null exactly when the server would
   * refuse: the control stays on screen, disabled, carrying the reason — a
   * control that vanishes reads as "this product cannot share", which is false.
   */
  shareRefusalReason,
  shareSelectedCount,
  sharedLinksCount,
  onOpenSharedLinks,
  assets,
  copies,
  landingPages,
  inbox,
  audiences,
}: CreativeStudioExactProps) {
  const selectedCount = shareSelectedCount ?? 0;
  const [shareNudgeVisible, setShareNudgeVisible] = useState(false);
  const nudgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (nudgeTimeoutRef.current) clearTimeout(nudgeTimeoutRef.current);
    },
    [],
  );

  const handleShareClick = () => {
    if (!onShare) return;
    if (selectedCount === 0) {
      if (nudgeTimeoutRef.current) clearTimeout(nudgeTimeoutRef.current);
      setShareNudgeVisible(true);
      nudgeTimeoutRef.current = setTimeout(() => setShareNudgeVisible(false), 5200);
      return;
    }
    setShareNudgeVisible(false);
    onShare();
  };

  const shareLabel =
    selectedCount > 0 ? `Share with client · ${selectedCount}` : "Share with client";

  return (
    <section
      className={styles.root}
      data-creative-studio-exact="true"
      data-screen-label="Creative Studio"
    >
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.pageEyebrow}>
            Meta · Analysis-first — writes stay in Launchpad
          </p>
          <h1>Creative Studio</h1>
        </div>
        <div className={styles.headerActions}>
          <button disabled={!onExport} onClick={onExport} type="button">
            Export CSV
          </button>
          <button
            className={styles.sharedLinksButton}
            data-creative-studio-shared-links-button="true"
            disabled={!onOpenSharedLinks}
            onClick={onOpenSharedLinks}
            type="button"
          >
            Shared links
            <span className={styles.sharedLinksCount}>
              {sharedLinksCount == null ? "—" : sharedLinksCount}
            </span>
          </button>
          <span className={styles.shareEntryWrap}>
            <button
              aria-label="Share selected creatives with client"
              className={
                selectedCount > 0
                  ? styles.shareButtonActive
                  : styles.shareButtonIdle
              }
              data-creative-studio-share-button="true"
              data-share-refused={shareRefusalReason ? "" : undefined}
              disabled={!onShare || Boolean(shareRefusalReason)}
              onClick={handleShareClick}
              title={shareRefusalReason ?? undefined}
              type="button"
            >
              {shareLabel}
            </button>
            {/*
              Stated, not implied by a greyed control. An operator who cannot
              mint needs the reason where the refusal is, and a `title` alone
              reaches neither a keyboard user nor a screen reader on a disabled
              button.
            */}
            {shareRefusalReason ? (
              <span
                className={styles.shareNudge}
                data-share-refusal-reason=""
                role="note"
              >
                <span className={styles.shareNudgeTitle}>{shareRefusalReason}</span>
              </span>
            ) : null}
            {shareNudgeVisible ? (
              <span
                className={styles.shareNudge}
                data-screen-label="Share entry — no selection"
                role="status"
              >
                <span className={styles.shareNudgeTitle}>
                  Select at least one creative to create a frozen snapshot.
                </span>
                <span className={styles.shareNudgeBody}>
                  Tick rows in the All creatives table below — nothing is
                  auto-selected for you.
                </span>
                <button
                  aria-label="Dismiss"
                  className={styles.shareNudgeDismiss}
                  onClick={() => {
                    if (nudgeTimeoutRef.current) clearTimeout(nudgeTimeoutRef.current);
                    setShareNudgeVisible(false);
                  }}
                  type="button"
                >
                  ✕
                </button>
              </span>
            ) : null}
          </span>
        </div>
      </header>

      <CreativeStudioTabs
        activeTab={activeTab}
        counts={counts}
        tabHrefs={tabHrefs}
      />

      {activeTab === "assets" ? <AssetsView model={assets} /> : null}
      {activeTab === "copies" ? <CopiesView model={copies} /> : null}
      {activeTab === "landing-pages" ? (
        <LandingPagesView model={landingPages} />
      ) : null}
      {activeTab === "inbox" ? <InboxView model={inbox} /> : null}
      {activeTab === "audiences" ? <AudiencesView model={audiences} /> : null}
    </section>
  );
}

export default CreativeStudioExact;
