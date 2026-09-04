import type {
  MetaDecisionCenterExactActionRowViewModel,
  MetaDecisionCenterExactArchiveRowViewModel,
  MetaDecisionCenterExactCapabilityGapViewModel,
  MetaDecisionCenterExactCreativeDecisionViewModel,
  MetaDecisionCenterExactCreativeGroupViewModel,
  MetaDecisionCenterExactHealthyGroupViewModel,
  MetaDecisionCenterExactInspectorViewModel,
  MetaDecisionCenterExactNeedsResolutionRowViewModel,
  MetaDecisionCenterExactNonSalesViewModel,
  MetaDecisionCenterExactSourceFactViewModel,
  MetaDecisionCenterExactSourceProvenanceViewModel,
  MetaDecisionCenterExactTone,
  MetaDecisionCenterExactViewModel,
  MetaDecisionCenterExactWatchingRowViewModel,
  MetaDecisionCenterExactWatchSegmentViewModel,
  MetaDecisionCenterExactWindow,
} from "@/components/meta/decision-center/MetaDecisionCenterExact";
import type {
  MetaArchivedEntity,
  MetaDecisionsWorkspacePayload,
  MetaHealthyEntity,
  MetaStructureInventoryEntity,
  MetaWatchingSegment,
} from "@/components/meta/redesign/types";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaCanonicalDecision,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
  MetaOsDecisionLane,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";
import { canCreateBrief } from "@/lib/zero-base/creative/studio-adapters";

const EM_DASH = "—";

const CREATIVE_POSTURE_SLOTS = [
  {
    id: "fatigued-spend-share",
    label: "Fatigued spend share",
    tone: "negative",
  },
  {
    id: "winner-concentration",
    label: "Winner concentration",
    tone: "warning",
  },
  { id: "average-frequency", label: "Avg frequency · 28d", tone: "warning" },
  { id: "refresh-pipeline", label: "Refresh pipeline", tone: "automation" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  tone: MetaDecisionCenterExactTone;
}>;

const UPPER_FUNNEL_SLOTS = [
  { id: "thruplay", label: "Thruplay" },
  { id: "cpm", label: "CPM" },
  { id: "cpm-account-p50", label: "CPM · acct p50" },
  { id: "reach-28d", label: "Reach · 28d" },
] as const;

const WATCH_SEGMENT_SLOTS = [
  { key: "learning", label: "Learning" },
  { key: "recently_changed", label: "Recently changed" },
  { key: "mid_confidence", label: "Mid confidence" },
  { key: "deferred", label: "Deferred" },
  { key: "insufficient_signal", label: "Insufficient signal" },
] as const satisfies ReadonlyArray<{
  key: MetaWatchingSegment["key"];
  label: string;
}>;

/**
 * One row of the Archive lane, tagged with the grain the server served it at.
 *
 * The lane holds two different kinds of thing. `lanes.archive` carries
 * campaign and ad-set rows. `decisionReadModel.queue.inactiveAssets` carries
 * Ad-grain decisions the read model withheld from every live queue because the
 * current hierarchy is not exactly ACTIVE. An ad is not a smaller ad set, and
 * the two cannot be told apart from a name and a spend figure alone, so the
 * grain travels with the row instead of being guessed at the far end.
 */
export type MetaDecisionCenterExactArchiveItem =
  | { kind: "structure"; row: MetaArchivedEntity }
  | { kind: "ad"; decision: MetaCanonicalDecision };

export interface MetaDecisionCenterExactAdapterOverrides {
  actionNow?: readonly MetaRecommendation[];
  watching?: readonly MetaRecommendation[];
  watchSegments?: readonly MetaWatchingSegment[];
  healthy?: readonly MetaHealthyEntity[];
  nonSales?: readonly MetaRecommendation[];
  archive?: readonly MetaDecisionCenterExactArchiveItem[];
  creatives?: readonly MetaOsAdDecision[];
  canonicalDecisions?: readonly MetaCanonicalDecision[];
  /** Caller-owned, server-backed deferred count after local filtering. */
  deferredCount?: number;
  /**
   * Daily CTR per ad id, for the creative rows' sparklines.
   *
   * Supplied by the caller because it is a second read the adapter must not
   * make. An ad with no entry keeps the honest empty path.
   */
  creativeCtrSeriesByAdId?: ReadonlyMap<string, readonly number[]>;
}

export interface MetaDecisionCenterExactAdapterCallbacks {
  /** Existing guarded/review routing owned by the caller. */
  onStructurePrimary?: (
    recommendation: MetaRecommendation,
    action: MetaOsDecisionAction,
  ) => void;
  onStructureMenu?: (recommendation: MetaRecommendation) => void;
  onWatchingReview?: (recommendation: MetaRecommendation) => void;
  /** Drawer/review only. The adapter exposes no creative provider-write callback. */
  onCreativeReview?: (
    decision: MetaOsAdDecision,
    canonicalDecision: MetaCanonicalDecision | null,
  ) => void;
  /**
   * Where a brief is created from this decision (`live:CREATIVE-07 brief`).
   *
   * The adapter resolves the LINEAGE — creative id, decision snapshot, trigger
   * — and the caller turns it into an href, because only the caller knows which
   * route family it is rendering in. Absent means the surface offers no brief
   * control at all, which is different from offering one that refuses.
   */
  briefHref?: (lineage: {
    creativeId: string;
    snapshotId: string;
    trigger: string;
  }) => string | null;
}

export type MetaDecisionCenterExactAdapterSelection =
  | { kind: "structure"; recommendationId: string }
  | { kind: "creative"; decisionId: string; sourceSnapshotId?: string | null }
  | null;

export interface MetaDecisionCenterExactAdapterInput {
  workspace: MetaDecisionsWorkspacePayload;
  account?: MetaHistoryAccount | null;
  overrides?: MetaDecisionCenterExactAdapterOverrides;
  callbacks?: MetaDecisionCenterExactAdapterCallbacks;
  /** Explicit clock input keeps relative sync copy deterministic. */
  now?: Date | string | number;
  /** Undefined selects the first server Action Now row; null suppresses the inspector. */
  selection?: MetaDecisionCenterExactAdapterSelection;
  /** Structure lane whose first served row owns the resting evidence inspector. */
  defaultSelectionLane?: "action" | "needsres" | "watching";
}

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function titleToken(value: string | null | undefined): string {
  const normalized = nonBlank(value);
  if (!normalized) return EM_DASH;
  return normalized
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Keep the header on the compact V2 provenance line while retaining the exact
 * build id in the evidence panel. Short semantic/test versions remain
 * untouched; only long release identifiers are reduced to their leading
 * version token.
 */
function compactEngineVersion(value: string): string {
  if (value.length <= 20) return value;
  return value.match(/^v?\d+(?:\.\d+){0,2}/)?.[0] ?? `${value.slice(0, 17)}…`;
}

function currencyCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  const amount = finite(value);
  const code = currencyCode(currency);
  if (amount === null || code === null) return EM_DASH;
  const symbol =
    code === "USD" ? "$" : code === "EUR" ? "€" : code === "TRY" ? "₺" : null;
  return symbol
    ? `${symbol}${formatNumber(amount)}`
    : `${code} ${formatNumber(amount)}`;
}

function formatRoas(value: number | null | undefined): string {
  const normalized = finite(value);
  return normalized === null ? EM_DASH : normalized.toFixed(2);
}

/**
 * A rate the server has ALREADY expressed in percent.
 *
 * The one thing this must not do is multiply. `ctr` reaches the client as
 * `(clicks / impressions) * 100` from the warehouse (lib/meta/serving.ts:1090)
 * and as Meta's own percent-valued `insight.ctr` from the live path
 * (lib/meta/live.ts:332); scaling it here would print 240% for a 2.4% rate,
 * the same class of unit error the inventory's budget column refuses to make
 * in the other direction. A measured 0 stays "0.00%" — an ad with
 * impressions and no clicks has a real, zero click-through rate.
 */
function formatPercent(value: number | null | undefined): string {
  const normalized = finite(value);
  return normalized === null ? EM_DASH : `${normalized.toFixed(2)}%`;
}

/**
 * ROAS, or a dash when there was no spend to divide by.
 *
 * Return on ad spend is undefined at zero spend, not zero — and the rollup
 * reports a literal `0` for both "spent nothing" and "summed no rows at all".
 * Printing `0.00` turned the second into a confident claim that the account
 * earned nothing, which is how a Decision Center kept saying ROAS 0.00 for an
 * account spending over a thousand dollars a day.
 */
function formatRoasAgainstSpend(
  roas: number | null | undefined,
  spend: number | null | undefined,
): string {
  const spent = finite(spend);
  if (spent === null || spent <= 0) return EM_DASH;
  return formatRoas(roas);
}

function roasLabel(window: MetaDecisionsWorkspacePayload["window"]): string {
  return window === "custom" ? "ROAS · selected range" : `ROAS · ${window}`;
}

/**
 * The ROAS reference line, carrying the noun for the source the server named.
 *
 * `/api/meta/account-pulse` resolves the reference in FOUR arms and says which
 * one is in force in `target_source`: a fresh commercial-truth target, a stale
 * one, the account median it measured itself when there is no commercial truth
 * (`target: null`, `median: <the number>`,
 * `target_source: "account_median"` — app/api/meta/account-pulse/route.ts:200-208),
 * and nothing at all. Formatting only `target` printed an em dash over that
 * measured median, so every business unit without a fresh target was told the
 * reference was unavailable while the server held it one field away.
 *
 * THE MEDIAN IS NOT A TARGET and is never printed as one. Moving it into the
 * target's place would invent a target nobody set — and would contradict the
 * mobile decision line, which draws "vs N x target" from the same null
 * `pulse.roas.target` and correctly draws nothing in this arm. So the median
 * arrives under its own noun, "account median", which is why the noun lives
 * here and not in the tile's markup: a caller cannot prefix "target" onto a
 * string that already says what it is.
 *
 * Distinct per arm, so no two can be mistaken for each other:
 *   commercial_truth        -> `target 2.50`
 *   commercial_truth_stale  -> `target 2.50 · stale` / `· freshness unknown`
 *   account_median          -> `account median 2.10`
 *   none                    -> `target —`  (a genuine absence, and it stays one)
 *
 * Freshness qualifies the commercial-truth pack, so it is not repeated on the
 * median line: it would be describing a target that is not what is shown. And
 * "no target set" is deliberately NOT claimed here — the server reaches this
 * arm both when no pack exists and when the pack READ FAILED (route.ts:180-184
 * catches into `target: null`), and a read failure must never be printed as a
 * measured absence.
 */
function targetRoasDisplay(
  value: number | null | undefined,
  freshness: MetaDecisionsWorkspacePayload["pulse"]["roas"]["targetFreshness"],
  source: MetaDecisionsWorkspacePayload["pulse"]["roas"]["target_source"],
  median: number | null | undefined,
): string {
  if (source === "account_median") {
    return `account median ${formatRoas(median)}`;
  }
  const formatted = formatRoas(value);
  if (formatted === EM_DASH || freshness === "fresh")
    return `target ${formatted}`;
  if (freshness === "stale") return `target ${formatted} · stale`;
  if (source === "none") return `target ${formatted}`;
  return `target ${formatted} · freshness unknown`;
}

function moneyAndRoas(input: {
  spend: number | null | undefined;
  roas: number | null | undefined;
  currency: string | null | undefined;
}): string {
  const spend = formatMoney(input.spend, input.currency);
  const roas = formatRoas(input.roas);
  return spend === EM_DASH && roas === EM_DASH
    ? EM_DASH
    : `${spend} · ROAS ${roas}`;
}

function percentageDelta(
  current: number | null | undefined,
  baseline: number | null | undefined,
): string {
  const currentValue = finite(current);
  const baselineValue = finite(baseline);
  if (currentValue === null || baselineValue === null || baselineValue === 0) {
    return EM_DASH;
  }
  const delta = ((currentValue - baselineValue) / baselineValue) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs 7d avg`;
}

function sparkPath(
  values: readonly number[] | null | undefined,
): string | null {
  if (
    !values ||
    values.length < 2 ||
    values.some((value) => finite(value) === null)
  ) {
    return null;
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum || 1;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 18 - ((value - minimum) / span) * 16;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function utcTime(value: string | null | undefined): string {
  const timestamp = nonBlank(value);
  if (!timestamp) return EM_DASH;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return EM_DASH;
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(
    date.getUTCMinutes(),
  ).padStart(2, "0")} UTC`;
}

function timestamp(
  value: Date | string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const parsed =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function relativeAge(
  value: string | null | undefined,
  now: Date | string | number | null | undefined,
): string | null {
  const thenMs = timestamp(value);
  const nowMs = timestamp(now);
  if (thenMs === null || nowMs === null) return null;
  const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function activeWindow(
  value: MetaDecisionsWorkspacePayload["window"],
): MetaDecisionCenterExactWindow | null {
  return value === "7d" || value === "14d" || value === "28d" || value === "90d"
    ? value
    : null;
}

/**
 * The tone the card, its label pill and its action button all wear.
 *
 * PRESENTATION ONLY. This colours a decision the server already made; it
 * never changes which decision is served, and an unmapped label stays
 * neutral rather than being guessed into a colour.
 *
 * The mapping used to cover seven labels, four of which the engine does not
 * actually emit (`protect`, `below_breakeven`, `fatigue` never appear in
 * meta_decision_snapshots_daily). Meanwhile the labels it DOES emit most were
 * all falling through to neutral, which is why the queue rendered flat while
 * the stylesheet already carried the full palette and the card already drew a
 * 4px tone bar. Counted in production rather than assumed:
 *   keep 397,933 · out_of_scope 115,917 · diagnose 19,414 · rebuild 3,802 ·
 *   tune 1,959 · refresh 1,746 · cut 1,297 · scale 844 · swap 90 · test_more 83
 *
 * `rebuild` and `swap` are purple on the reference's own evidence — the
 * canonical card renders "Rebuild in Launchpad" in purple, and both route the
 * same way `refresh` does. `keep`, `tune` and `test_more` are the operator's
 * call, recorded here so the reasoning is not lost: green, amber, blue.
 * `out_of_scope` stays neutral — a row outside the sales objective is not a
 * verdict about its performance.
 */
export function decisionTone(
  value: string | null | undefined,
): MetaDecisionCenterExactTone {
  switch (value?.trim().toLowerCase()) {
    case "scale":
    case "protect":
    case "keep":
      return "positive";
    case "cut":
    case "below_breakeven":
      return "negative";
    case "refresh":
    case "fatigue":
    case "rebuild":
    case "swap":
      return "automation";
    case "diagnose":
    case "tune":
      return "warning";
    case "test_more":
      return "info";
    default:
      return "neutral";
  }
}

function actionTone(
  action: MetaOsDecisionAction | null,
): MetaDecisionCenterExactTone {
  if (!action) return "neutral";
  if (action.providerMutation === "pause") return "negative";
  if (action.providerMutation === "resume") return "positive";
  if (action.intent === "launchpad" || action.intent === "brief")
    return "automation";
  if (action.intent === "manual" || action.intent === "review")
    return "warning";
  return "neutral";
}

function confidenceTone(
  value: "high" | "medium" | "low" | "unknown" | null | undefined,
): MetaDecisionCenterExactTone {
  if (value === "high") return "positive";
  if (value === "medium") return "warning";
  return "neutral";
}

function segmentTone(
  value: string | null | undefined,
): MetaDecisionCenterExactTone {
  if (value === "learning") return "info";
  if (
    value === "mid_confidence" ||
    value === "missing_target" ||
    value === "issues"
  ) {
    return "warning";
  }
  return "neutral";
}

function structureLevel(value: MetaRecommendation["level"]): string {
  if (value === "adset") return "Ad set";
  if (value === "campaign") return "Campaign";
  return "Account";
}

function entityName(recommendation: MetaRecommendation): string {
  return (
    nonBlank(recommendation.adsetName) ??
    nonBlank(recommendation.campaignName) ??
    nonBlank(recommendation.title) ??
    EM_DASH
  );
}

function structureChips(recommendation: MetaRecommendation): string[] {
  const candidates = [
    recommendation.campaignContext?.kind
      ? `Auto · ${titleToken(recommendation.campaignContext.kind)}`
      : null,
    nonBlank(recommendation.entityConfiguration?.status),
    nonBlank(recommendation.entityConfiguration?.optimizationGoal),
    nonBlank(recommendation.rowPresentation?.blockerLabel),
    nonBlank(recommendation.rowPresentation?.shieldLabel),
  ];
  return candidates
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);
}

function automaticRoleChip(recommendation: MetaRecommendation): string | null {
  const context = recommendation.campaignContext;
  if (!context) return null;
  return context.source === "system_inferred" && context.kind
    ? `Auto · ${titleToken(context.kind)}`
    : "Auto · Unresolved";
}

/**
 * One row's place in the campaign -> ad set structure, said with the fields the
 * row already carries.
 *
 * The queue lists campaign rows and ad-set rows as flat siblings, so an ad set
 * called "Bathroom-DPA" sitting under a campaign called "Claude-DPA-USA" reads
 * as a peer of it rather than as part of it, and the operator cannot tell which
 * ad set belongs to which campaign. Every recommendation already states its own
 * `level` and its parent `campaignId`/`campaignName`, so the relation is read
 * off those and nothing else: no parent is inferred, none is fetched, and no row
 * is moved, regrouped or re-sorted -- lane membership and order stay exactly as
 * the server sent them.
 */
interface LaneLineage {
  readonly label: string;
  readonly role: "parent" | "child";
}

/**
 * The lineage of every row in ONE lane.
 *
 * The scope is the lane rather than the account on purpose: "in this lane" is a
 * claim about the rows actually on screen, which is the question the operator is
 * asking. An ad set whose campaign row is not in the lane still says which
 * campaign it belongs to -- a parent row that is not in this lane is not an
 * absent parent, and the label must not imply that it is.
 */
function laneLineage(
  recommendations: readonly MetaRecommendation[],
): Map<string, LaneLineage> {
  const adsetsByCampaignId = new Map<string, number>();
  const campaignRowIds = new Set<string>();
  for (const recommendation of recommendations) {
    const campaignId = nonBlank(recommendation.campaignId);
    if (!campaignId) continue;
    if (recommendation.level === "adset") {
      adsetsByCampaignId.set(
        campaignId,
        (adsetsByCampaignId.get(campaignId) ?? 0) + 1,
      );
    } else if (recommendation.level === "campaign") {
      campaignRowIds.add(campaignId);
    }
  }

  const lineage = new Map<string, LaneLineage>();
  for (const recommendation of recommendations) {
    const campaignId = nonBlank(recommendation.campaignId);
    if (recommendation.level === "adset") {
      // The served campaign name, or the em dash when the payload did not name
      // one. An ad set always belongs to a campaign; a blank name is a missing
      // value, not a missing parent.
      const parent = nonBlank(recommendation.campaignName) ?? EM_DASH;
      const parentInLane = campaignId ? campaignRowIds.has(campaignId) : false;
      lineage.set(recommendation.id, {
        role: "child",
        label: parentInLane
          ? `In ${parent} \u00b7 campaign also in this lane`
          : `In ${parent}`,
      });
      continue;
    }
    if (recommendation.level !== "campaign" || !campaignId) continue;
    const children = adsetsByCampaignId.get(campaignId) ?? 0;
    // Silence rather than "0 ad sets": the lane holding no ad-set row for this
    // campaign says nothing about whether the campaign has any.
    if (children === 0) continue;
    lineage.set(recommendation.id, {
      role: "parent",
      label: `${children} ad set${children === 1 ? "" : "s"} in this lane`,
    });
  }
  return lineage;
}

function structureNodesByRecommendationId(
  workspace: MetaDecisionsWorkspacePayload,
): Map<string, MetaOsStructureNode> {
  const nodes = new Map<string, MetaOsStructureNode>();
  for (const group of workspace.os?.structure?.groups ?? []) {
    for (const node of [group.campaign, ...group.adsets]) {
      const recommendationId = nonBlank(node.sourceRecommendationId);
      if (recommendationId && !nodes.has(recommendationId)) {
        nodes.set(recommendationId, node);
      }
    }
  }
  return nodes;
}

function structureEntityKeyForRecommendation(
  recommendation: MetaRecommendation,
): string | null {
  if (recommendation.level === "campaign") {
    return `campaign:${nonBlank(recommendation.campaignId) ?? recommendation.id}`;
  }
  if (recommendation.level === "adset") {
    return `adset:${nonBlank(recommendation.adsetId) ?? recommendation.id}`;
  }
  return null;
}

function structureNodesByEntityKey(
  workspace: MetaDecisionsWorkspacePayload,
): Map<string, MetaOsStructureNode> {
  const nodes = new Map<string, MetaOsStructureNode>();
  for (const group of workspace.os?.structure?.groups ?? []) {
    for (const node of [group.campaign, ...group.adsets]) {
      const providerEntityId =
        nonBlank(node.providerEntityId) ??
        (node.level === "campaign" ? nonBlank(node.campaignId) : null);
      if (!providerEntityId) continue;
      nodes.set(`${node.level}:${providerEntityId}`, node);
    }
  }
  return nodes;
}

/**
 * Every canonical envelope the payload carries, as a LOOKUP TABLE.
 *
 * This is not a queue and it selects nothing: rows come from `os.ads.items`,
 * and this only answers "does an envelope exist for this row, and which one".
 *
 * It used to return `adCandidates.items` and stop there whenever the envelope
 * key existed. `adCandidates` is present-but-empty on any account whose Ads are
 * all omitted as not-applicable -- Grandmix serves `adCandidates.items: []`
 * beside a `creative_rotation` section holding 5 decisions -- so the early
 * return threw away the only envelopes the payload had. Candidates still come
 * first, because they are the exact-identity selection; the sections are
 * appended for whatever the candidate cap or the applicability filter left out.
 * A union of two served lists is not a reclassification.
 */
function defaultCanonicalDecisions(
  workspace: MetaDecisionsWorkspacePayload,
): MetaCanonicalDecision[] {
  const seen = new Set<string>();
  const decisions: MetaCanonicalDecision[] = [];
  for (const decision of [
    ...(workspace.decisionReadModel?.queue?.adCandidates?.items ?? []),
    // `?? []` on the section's own items, not only on the sections map: a
    // section serialized without its list is a payload defect, and letting it
    // throw here takes the WHOLE Decision page down rather than losing one
    // envelope. An absent list is read as "this section contributed nothing",
    // which is what the rest of the surface already renders as unavailable.
    ...Object.values(
      workspace.decisionReadModel?.queue?.sections ?? {},
    ).flatMap((section) => section?.items ?? []),
  ]) {
    const key = `${decision.decisionId}\u0000${decision.sourceSnapshotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    decisions.push(decision);
  }
  return decisions;
}

function canonicalKey(decisionId: string, sourceSnapshotId: string): string {
  return `${decisionId}\u0000${sourceSnapshotId}`;
}

function canonicalDecisionsByKey(
  decisions: readonly MetaCanonicalDecision[],
): Map<string, MetaCanonicalDecision> {
  return new Map(
    decisions.map((decision) => [
      canonicalKey(decision.decisionId, decision.sourceSnapshotId),
      decision,
    ]),
  );
}

function recommendationMoney(
  recommendation: MetaRecommendation,
  node: MetaOsStructureNode | null,
  fallbackCurrency: string | null,
): string {
  return moneyAndRoas({
    spend: node?.metrics.spend ?? recommendation.metrics?.spend,
    roas: node?.metrics.roas ?? recommendation.metrics?.roas,
    currency: node?.metrics.currency ?? fallbackCurrency,
  });
}

function recommendationMoneySub(
  recommendation: MetaRecommendation,
  node: MetaOsStructureNode | null,
): string {
  const target = finite(node?.metrics.effectiveTargetRoas);
  const impact =
    nonBlank(node?.expectedImpact) ?? nonBlank(recommendation.expectedImpact);
  const parts = [
    target === null ? null : `vs ${target.toFixed(2)} target`,
    impact,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : EM_DASH;
}

function actionRows(input: {
  recommendations: readonly MetaRecommendation[];
  nodes: ReadonlyMap<string, MetaOsStructureNode>;
  fallbackCurrency: string | null;
  /** The row the evidence inspector is describing, including the default. */
  selectedRecommendationId: string | null;
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactActionRowViewModel[] {
  const lineage = laneLineage(input.recommendations);
  return input.recommendations.map((recommendation) => {
    const node = input.nodes.get(recommendation.id) ?? null;
    const action = node?.action ?? null;
    const tone = decisionTone(recommendation.decisionLabel);
    const relation = lineage.get(recommendation.id) ?? null;
    return {
      id: recommendation.id,
      name: entityName(recommendation),
      level: structureLevel(recommendation.level),
      chips: structureChips(recommendation),
      selected: recommendation.id === input.selectedRecommendationId,
      ...(relation
        ? { lineage: relation.label, lineageRole: relation.role }
        : {}),
      decisionLabel:
        recommendation.decisionLabel != null
          ? titleToken(recommendation.decisionLabel)
          : (nonBlank(node?.assessment) ??
            nonBlank(recommendation.decision) ??
            EM_DASH),
      decisionTone: tone,
      edgeTone: tone,
      money: recommendationMoney(recommendation, node, input.fallbackCurrency),
      moneySub: recommendationMoneySub(recommendation, node),
      confidence: titleToken(node?.confidence ?? recommendation.confidence),
      confidenceTone: confidenceTone(
        node?.confidence ?? recommendation.confidence,
      ),
      actionLabel: nonBlank(action?.label) ?? EM_DASH,
      actionTone: actionTone(action),
      /*
       * The server's confidence cap, stated on the row.
       *
       * `low` here is the engine's own published confidence — stale source
       * evidence caps it, and INVARIANTS requires the capped verdict to stay
       * visible rather than be hidden. The reason is the server's
       * `confidenceReason` when it wrote one; nothing is derived from label
       * text.
       */
      staleDemoted: (node?.confidence ?? recommendation.confidence) === "low",
      staleDemotedReason: nonBlank(recommendation.confidenceReason)
        ? operatorFactLabel(recommendation.confidenceReason!)
        : null,
      ...(node && input.callbacks.onStructurePrimary
        ? {
            onPrimary: () =>
              input.callbacks.onStructurePrimary?.(recommendation, node.action),
          }
        : {}),
      ...(input.callbacks.onStructureMenu
        ? {
            // The card and the row's overflow control open the same evidence.
            // They are separate fields so that giving the overflow control a
            // real menu later cannot silently take the card's meaning with it.
            onOpen: () => input.callbacks.onStructureMenu?.(recommendation),
            onMenu: () => input.callbacks.onStructureMenu?.(recommendation),
          }
        : {}),
    };
  });
}

/**
 * Whether the SERVER classified this row `blocked`.
 *
 * One field, read once. `MetaOsDecisionLane` is `act | blocked | monitor` and
 * `lib/meta/decisions-os-presentation.ts` sets `blocked` for a `diagnose` label
 * or a target-authority blocker. Nothing is inferred here: INVARIANTS forbids
 * recovering a blocked resolution from label text, badges or metrics, and a
 * row whose OS node was not served is NOT blocked — it is a row with no
 * projection, which the notice states rather than this function guessing.
 */
interface ProjectedStructureRecommendations {
  action: MetaRecommendation[];
  blocked: MetaRecommendation[];
  watching: MetaRecommendation[];
  nonSales: MetaRecommendation[];
  /** Legacy rows the OS did not project, grouped by their served fallback. */
  unprojected: {
    action: number;
    watching: number;
    nonSales: number;
  };
}

/**
 * Route every structure recommendation by the server-owned OS lane.
 *
 * The legacy payload has three source arrays, but the OS is the authoritative
 * classifier and can legitimately move any campaign/ad-set recommendation to
 * Act, Blocked or Monitor. In particular, an active recommendation sourced
 * from `nonSales` is an Act node. Keeping it on an informational card hid a
 * real action from both the headline and its destination lane.
 *
 * The OS also chooses one recommendation per physical entity. Alternatives
 * explicitly counted as suppressed by that node are omitted from the queue;
 * drawing them beside the chosen node produced contradictory duplicate cards
 * for the same campaign in the real Grandmix payload. Account-level legacy
 * advice and other rows the OS genuinely did not project keep their original
 * lane and remain visible.
 */
function projectStructureRecommendations(input: {
  action: readonly MetaRecommendation[];
  watching: readonly MetaRecommendation[];
  nonSales: readonly MetaRecommendation[];
  nodesByRecommendationId: ReadonlyMap<string, MetaOsStructureNode>;
  nodesByEntityKey: ReadonlyMap<string, MetaOsStructureNode>;
}): ProjectedStructureRecommendations {
  const result: ProjectedStructureRecommendations = {
    action: [],
    blocked: [],
    watching: [],
    nonSales: [],
    unprojected: { action: 0, watching: 0, nonSales: 0 },
  };
  const seen = new Set<string>();

  const append = (
    recommendation: MetaRecommendation,
    fallback: "action" | "watching" | "nonSales",
  ) => {
    if (seen.has(recommendation.id)) return;
    seen.add(recommendation.id);

    const node = input.nodesByRecommendationId.get(recommendation.id);
    if (node) {
      if (node.lane === "act") result.action.push(recommendation);
      else if (node.lane === "blocked") result.blocked.push(recommendation);
      else result.watching.push(recommendation);
      return;
    }

    const entityKey = structureEntityKeyForRecommendation(recommendation);
    const selectedNode = entityKey
      ? input.nodesByEntityKey.get(entityKey)
      : undefined;
    if (
      selectedNode &&
      selectedNode.suppressedAlternativeCount > 0 &&
      nonBlank(selectedNode.sourceRecommendationId) !== recommendation.id
    ) {
      return;
    }

    result[fallback].push(recommendation);
    result.unprojected[fallback] += 1;
  };

  for (const recommendation of input.action) append(recommendation, "action");
  for (const recommendation of input.watching)
    append(recommendation, "watching");
  for (const recommendation of input.nonSales)
    append(recommendation, "nonSales");
  return result;
}

/**
 * Why the Needs Resolution lane is empty, when the emptiness is not a fact.
 *
 * An account whose payload carries no OS projection has no `lane` on any row,
 * so every row falls to `open` and this lane renders zero — which is not the
 * same statement as "the engine blocked nothing". Zero-with-no-projection is an
 * unread lane and says so; zero-with-a-projection is a measured zero and says
 * nothing, because the lane's own empty state already covers it.
 */
function needsResolutionNotice(
  workspace: MetaDecisionsWorkspacePayload,
): string | null {
  const groups = workspace.os?.structure?.groups;
  if (groups && groups.length > 0) return null;
  const readModelStatus = workspace.decisionReadModel?.status;
  const reason =
    readModelStatus && readModelStatus !== "available"
      ? nonBlank(workspace.decisionReadModel?.source?.fallbackReason)
      : null;
  return (
    "No decision projection was served for this account and snapshot, so this " +
    "lane cannot say whether any decision is blocked." +
    (reason ? ` ${reason}` : "")
  );
}

/**
 * The blocked lane's rows.
 *
 * Every string is the server's: the blocker is the readiness vocabulary the
 * inspector already prints, the resolution is the node's own scope note, and
 * the verdict is copied through unchanged. There is deliberately no action
 * callback — `authority_blocker IS NOT NULL` implies `authorized_action IS
 * NULL`, so a control here would be offering something that does not exist.
 */
function needsResolutionRows(input: {
  recommendations: readonly MetaRecommendation[];
  nodes: ReadonlyMap<string, MetaOsStructureNode>;
  fallbackCurrency: string | null;
  selectedRecommendationId: string | null;
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactNeedsResolutionRowViewModel[] {
  const lineage = laneLineage(input.recommendations);
  return input.recommendations.map((recommendation) => {
    const node = input.nodes.get(recommendation.id) ?? null;
    const readiness = recommendation.automationReadiness;
    const blockerParts = dedupeReadinessBlockers(
      readiness?.blockers,
      readiness?.missingEvidence,
    );
    const relation = lineage.get(recommendation.id) ?? null;
    const confidence = node?.confidence ?? recommendation.confidence;
    return {
      id: recommendation.id,
      name: entityName(recommendation),
      level: structureLevel(recommendation.level),
      chips: [automaticRoleChip(recommendation)].filter(
        (value): value is string => Boolean(value),
      ),
      selected: recommendation.id === input.selectedRecommendationId,
      ...(relation
        ? { lineage: relation.label, lineageRole: relation.role }
        : {}),
      decisionLabel:
        recommendation.decisionLabel != null
          ? titleToken(recommendation.decisionLabel)
          : (nonBlank(node?.assessment) ??
            nonBlank(recommendation.decision) ??
            EM_DASH),
      decisionTone: decisionTone(recommendation.decisionLabel),
      blocker:
        nonBlank(readiness?.reason) ??
        // The node's own assessment is the server's short form of the same
        // fact ("Decision Blocked"); `whyNow` carries the long one.
        nonBlank(node?.assessment) ??
        "Authority withheld",
      blockerCount: blockerParts.length,
      blockerTone: "warning",
      resolution:
        nonBlank(node?.action?.scopeNote) ??
        nonBlank(node?.whyNow) ??
        nonBlank(recommendation.why) ??
        null,
      money: recommendationMoney(recommendation, node, input.fallbackCurrency),
      confidence: titleToken(confidence),
      confidenceTone: confidenceTone(confidence),
      staleDemoted: confidence === "low",
      staleDemotedReason: nonBlank(recommendation.confidenceReason)
        ? operatorFactLabel(recommendation.confidenceReason!)
        : null,
      ...(input.callbacks.onStructureMenu
        ? { onOpen: () => input.callbacks.onStructureMenu?.(recommendation) }
        : {}),
    };
  });
}

function watchSegments(
  segments: readonly MetaWatchingSegment[],
): MetaDecisionCenterExactWatchSegmentViewModel[] {
  const byKey = new Map(segments.map((segment) => [segment.key, segment]));
  return WATCH_SEGMENT_SLOTS.map((slot) => ({
    id: slot.key,
    label: slot.label,
    count: finite(byKey.get(slot.key)?.count) ?? EM_DASH,
  }));
}

function watchingRows(input: {
  recommendations: readonly MetaRecommendation[];
  nodes: ReadonlyMap<string, MetaOsStructureNode>;
  fallbackCurrency: string | null;
  /** The row the evidence inspector is describing, including the default. */
  selectedRecommendationId: string | null;
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactWatchingRowViewModel[] {
  const lineage = laneLineage(input.recommendations);
  return input.recommendations.map((recommendation) => {
    const node = input.nodes.get(recommendation.id) ?? null;
    const relation = lineage.get(recommendation.id) ?? null;
    return {
      id: recommendation.id,
      segment: recommendation.watchSegment
        ? titleToken(recommendation.watchSegment)
        : EM_DASH,
      segmentTone: segmentTone(recommendation.watchSegment),
      name: entityName(recommendation),
      level: structureLevel(recommendation.level),
      selected: recommendation.id === input.selectedRecommendationId,
      ...(relation
        ? { lineage: relation.label, lineageRole: relation.role }
        : {}),
      note:
        nonBlank(node?.whyNow) ??
        nonBlank(recommendation.why) ??
        nonBlank(recommendation.summary) ??
        EM_DASH,
      money: recommendationMoney(recommendation, node, input.fallbackCurrency),
      ...(input.callbacks.onWatchingReview
        ? {
            // Same callback, two affordances: the whole card and the named
            // Review control. Kept as separate fields for the same reason the
            // Action row keeps onOpen apart from onMenu.
            onOpen: () => input.callbacks.onWatchingReview?.(recommendation),
            onReview: () => input.callbacks.onWatchingReview?.(recommendation),
          }
        : {}),
    };
  });
}

/**
 * The group's bid strategy, and whether its members actually agree on one.
 *
 * The group line prints ONE strategy for a whole campaign, taken from the
 * campaign row or, failing that, the first ad set. The server already says when
 * that single answer is a summary of disagreeing children: `isBidStrategyMixed`
 * is set on the campaign row when its ad sets do not share a bid strategy
 * (lane-classify carries the flag straight through). Dropping it meant a
 * campaign whose ad sets run Lowest Cost and Cost Cap side by side printed
 * "Lowest Cost" flatly, which is a claim about the whole group that is false
 * for part of it.
 *
 * A `mixed` flag is rendered exactly where the value it qualifies is rendered.
 * The Healthy lane prints no optimization goal, custom event or bid amount, so
 * `isOptimizationGoalMixed`, `isCustomEventTypeMixed` and `isBidValueMixed` stay
 * unrendered here: a qualifier with nothing on screen to qualify is not
 * readable. @see components/meta/decision-center/decision-payload-coverage.test.ts
 */
function healthyStrategy(entity: MetaHealthyEntity | null | undefined): string {
  const label =
    nonBlank(entity?.bidStrategyLabel) ??
    (entity?.bidStrategyType ? titleToken(entity.bidStrategyType) : null);
  if (!label) return EM_DASH;
  return entity?.isBidStrategyMixed ? `${label} · mixed` : label;
}

function healthyGroups(
  rows: readonly MetaHealthyEntity[],
  fallbackCurrency: string | null,
): MetaDecisionCenterExactHealthyGroupViewModel[] {
  const groups = new Map<
    string,
    {
      id: string;
      campaignName: string | null;
      campaign: MetaHealthyEntity | null;
      adsets: MetaHealthyEntity[];
    }
  >();

  for (const row of rows) {
    const id =
      row.level === "campaign"
        ? (row.campaignId ?? row.id)
        : (row.campaignId ?? `adset:${row.id}`);
    const existing = groups.get(id) ?? {
      id,
      campaignName: nonBlank(row.campaignName),
      campaign: null,
      adsets: [],
    };
    if (row.level === "campaign") {
      existing.campaign = row;
      existing.campaignName = nonBlank(row.name) ?? existing.campaignName;
    } else {
      existing.adsets.push(row);
    }
    groups.set(id, existing);
  }

  return [...groups.values()].map((group) => {
    const strategySource = group.campaign ?? group.adsets[0] ?? null;
    return {
      id: group.id,
      name: group.campaignName ?? EM_DASH,
      strategy: healthyStrategy(strategySource),
      rollup: group.campaign
        ? moneyAndRoas({
            spend: group.campaign.spend,
            roas: group.campaign.roas,
            currency: fallbackCurrency,
          })
        : EM_DASH,
      adsets: group.adsets.map((adset) => ({
        id: adset.id,
        name: nonBlank(adset.name) ?? EM_DASH,
        stats: moneyAndRoas({
          spend: adset.spend,
          roas: adset.roas,
          currency: fallbackCurrency,
        }),
      })),
    };
  });
}

function targetValueNumber(
  recommendation: MetaRecommendation | null,
  key: string,
): number | null {
  const target = recommendation?.targetValue;
  if (!target || typeof target !== "object" || Array.isArray(target))
    return null;
  return finite((target as Record<string, unknown>)[key] as number | null);
}

/**
 * The four informational tiles, filled from what the server already enriches.
 *
 * Every value was a hardcoded `—`, so the card was four empty boxes on every
 * account — while `lane-classify` had been attaching `cpm`, `thruplayActions`
 * and the account calibration percentiles to each upper-funnel row all along.
 *
 * `Reach · 28d` stays a dash on purpose. The stored `reach` is a sum over daily
 * rows, which counts a person seen on three days three times; 28-day unique
 * reach is a separate provider figure this warehouse does not hold, and a
 * summed one printed under that caption would be a wrong number wearing a right
 * label.
 */
function nonSalesMetrics(
  recommendation: MetaRecommendation | null,
  currency: string | null,
): NonNullable<MetaDecisionCenterExactNonSalesViewModel["metrics"]> {
  const thruplay = targetValueNumber(recommendation, "thruplayActions");
  const cpm = targetValueNumber(recommendation, "cpm");
  const cpmP50 = targetValueNumber(recommendation, "cpmAccountP50");
  const values: Record<string, string> = {
    thruplay: thruplay === null ? EM_DASH : formatNumber(thruplay),
    cpm: formatMoney(cpm, currency),
    "cpm-account-p50": formatMoney(cpmP50, currency),
    "reach-28d": EM_DASH,
  };
  return UPPER_FUNNEL_SLOTS.map((slot) => ({
    id: slot.id,
    label: slot.label,
    value: values[slot.id] ?? EM_DASH,
  }));
}

function nonSalesCard(
  recommendation: MetaRecommendation | null,
  currency: string | null,
): MetaDecisionCenterExactNonSalesViewModel {
  return {
    ...(recommendation ? { id: recommendation.id } : {}),
    name: recommendation ? entityName(recommendation) : EM_DASH,
    level: recommendation ? structureLevel(recommendation.level) : EM_DASH,
    contextLabel:
      recommendation?.cohort === "upper_funnel"
        ? "Upper funnel · informational"
        : recommendation?.cohort
          ? `${titleToken(recommendation.cohort)} · informational`
          : EM_DASH,
    metrics: nonSalesMetrics(recommendation, currency),
    note:
      nonBlank(recommendation?.why) ??
      nonBlank(recommendation?.summary) ??
      EM_DASH,
  };
}

const ARCHIVE_GRAIN_LABEL: Record<MetaArchivedEntity["level"], string> = {
  campaign: "Campaign",
  adset: "Ad set",
};

/** Every Ad-grain decision the read model withheld from the live queues. */
function inactiveAdDecisions(
  workspace: MetaDecisionsWorkspacePayload,
): readonly MetaCanonicalDecision[] {
  return workspace.decisionReadModel?.queue?.inactiveAssets?.items ?? [];
}

function defaultArchiveItems(
  workspace: MetaDecisionsWorkspacePayload,
): MetaDecisionCenterExactArchiveItem[] {
  return [
    ...(workspace.lanes.archive ?? []).map(
      (row) => ({ kind: "structure", row }) as const,
    ),
    ...inactiveAdDecisions(workspace).map(
      (decision) => ({ kind: "ad", decision }) as const,
    ),
  ];
}

function inactiveAdName(decision: MetaCanonicalDecision): string {
  return (
    nonBlank(decision.parentChain.ad?.name) ??
    nonBlank(decision.parentChain.creative?.name) ??
    nonBlank(decision.parentChain.ad?.id) ??
    nonBlank(decision.parentChain.creative?.id) ??
    EM_DASH
  );
}

/**
 * The Ad's own delivery status, as served.
 *
 * `deliveryScope.adStatus` is the provider's current status for the ad itself.
 * When it is absent the scope state is the only thing known, and "unknown" is
 * said as unknown rather than being rounded down to "paused".
 */
function inactiveAdStatus(decision: MetaCanonicalDecision): string {
  const adStatus = nonBlank(decision.deliveryScope?.adStatus);
  if (adStatus) return `Ad · ${titleToken(adStatus.toLowerCase())}`;
  const state = decision.deliveryScope?.state;
  if (state === "inactive") return "Ad · Not delivering";
  if (state === "unknown") return "Ad · Status unknown";
  return `Ad · ${EM_DASH}`;
}

/**
 * Why an Ad-grain row is in the archive, said without borrowing a verdict.
 *
 * The envelope still carries `classification.buyerLabel` and
 * `sourceDecision.label`, and neither may be printed here. These rows are
 * review-only by construction — the read model rewrites them with
 * `actionEligible: false` and `authorizedAction: null` before it files them
 * under `inactiveAssets` — and a withheld decision that reads like an ordinary
 * recommendation is precisely the invariant this lane must not break. So the
 * note states the withholding reason and the served hierarchy statuses, and
 * stops there.
 */
function inactiveAdNote(decision: MetaCanonicalDecision): string {
  const reason = nonBlank(decision.sourceAuthority?.reviewOnlyReason);
  const headline =
    reason === "current_hierarchy_is_not_active"
      ? "Withheld from the live queue: the current campaign / ad set / ad hierarchy is not active."
      : reason === "current_hierarchy_status_is_unknown"
        ? "Withheld from the live queue: current hierarchy status is unknown."
        : null;
  const scope = decision.deliveryScope;
  const statuses = [
    nonBlank(scope?.campaignStatus)
      ? `campaign ${nonBlank(scope?.campaignStatus)}`
      : null,
    nonBlank(scope?.adsetStatus)
      ? `ad set ${nonBlank(scope?.adsetStatus)}`
      : null,
    nonBlank(scope?.adStatus) ? `ad ${nonBlank(scope?.adStatus)}` : null,
  ].filter((value): value is string => value !== null);
  const detail =
    statuses.length > 0 ? `Current status — ${statuses.join(", ")}.` : null;
  return (
    [headline, detail].filter((value) => value !== null).join(" ") || EM_DASH
  );
}

/**
 * The Archive lane, at two grains, each one named.
 *
 * The page used to hand this builder `inactiveViewItems.flatMap(item =>
 * item.kind === "structure" ? [item.row] : [])`, which computed every inactive
 * Ad and then threw all of them away: 83 served Ad decisions on Grandmix
 * (act_805150454596350) and 319 on TheSwaf (act_822913786458311) reached the
 * client and rendered as zero rows. They are carried now.
 *
 * The two grains are NOT interleaved on spend. A campaign's spend already
 * contains its ad sets' and its ads', so ranking the three against each other
 * on one money axis would assert a comparison no server made. Each grain keeps
 * the order it arrived in, and the row says which grain it is.
 *
 * Neither grain gets an action. `MetaArchivedEntity` carries no action tuple,
 * and an inactive Ad decision pins `authorizedAction: null` — so there is no
 * callback to give a Resume button. Drawing it anyway produced a permanently
 * dimmed control on every paused row, a promise the screen could never keep.
 * The component still renders it the moment a server action tuple supplies one.
 */
function archiveRows(
  items: readonly MetaDecisionCenterExactArchiveItem[],
  fallbackCurrency: string | null,
): MetaDecisionCenterExactArchiveRowViewModel[] {
  return items.map((item) => {
    if (item.kind === "ad") {
      const { decision } = item;
      const adStatus = nonBlank(decision.deliveryScope?.adStatus);
      return {
        // Prefixed so an Ad row can never collide with the provider entity id
        // of a campaign or ad-set row sharing this table.
        id: `inactive-ad:${decision.decisionId}`,
        name: inactiveAdName(decision),
        status: inactiveAdStatus(decision),
        statusTone:
          adStatus?.toUpperCase() === "PAUSED" ? "warning" : "neutral",
        // A measured zero stays a zero; an unserved spend stays an em dash.
        spend: formatMoney(decision.metrics.spend, fallbackCurrency),
        note: inactiveAdNote(decision),
      };
    }
    const { row } = item;
    const paused = row.status.trim().toUpperCase() === "PAUSED";
    const statusLabel =
      nonBlank(row.statusLabel) ?? nonBlank(row.status) ?? EM_DASH;
    return {
      id: row.id,
      name: nonBlank(row.name) ?? EM_DASH,
      // The grain leads the status because the served label alone is ambiguous
      // about it: an ad set reads "Campaign paused 1050d", which describes its
      // PARENT, and sat one row below a campaign reading "Paused 1045d".
      status: `${ARCHIVE_GRAIN_LABEL[row.level]} · ${statusLabel}`,
      statusTone: paused ? "warning" : "neutral",
      spend: formatMoney(row.spend, fallbackCurrency),
      note:
        nonBlank(row.diagnosticNote) ?? nonBlank(row.advisory?.why) ?? EM_DASH,
    };
  });
}

const INVENTORY_GRAIN_LABEL: Record<
  MetaStructureInventoryEntity["level"],
  string
> = {
  campaign: "Campaign",
  adset: "Ad set",
};

/** One served inventory entity, said with the fields the server served it at. */
export interface MetaStructureInventoryRowViewModel {
  id: string;
  name: string;
  /** "Campaign" or "Ad set" — the grain the server filed the row at. */
  grain: string;
  /** Served lineage: the campaign an ad set belongs to, or a campaign's kind. */
  lineage: string;
  /** The server's own status label. Never re-derived from `status`. */
  status: string;
  spend: string;
  roas: string;
  purchases: string;
  /**
   * Cost per purchase, in the account currency.
   *
   * Served on every inventory entity as `metrics.cpa` and rendered nowhere
   * until now, so a census row could say what it spent and what it earned but
   * not what a purchase cost — the one figure a buyer compares against a
   * target CPA. Safe to print through the money formatter because the server
   * derives it as `spend / conversions` from the same summed spend this row
   * already renders (lib/meta/serving.ts:1089), so it carries the same unit.
   */
  cpa: string;
  /**
   * Click-through rate, as a percentage.
   *
   * `metrics.ctr` is served ALREADY IN PERCENT — the warehouse computes
   * `(clicks / impressions) * 100` (lib/meta/serving.ts:1090) and the live path
   * parses Meta's own percent-valued `insight.ctr` (lib/meta/live.ts:332). It
   * is therefore formatted with a `%` suffix and never multiplied again; the
   * unit is stated here because the sibling budget fields are the opposite case
   * and are refused for exactly that reason. @see inventoryConfiguration
   */
  ctr: string;
  /** Served setup: optimization goal, bid strategy, budget owner. */
  configuration: string;
}

export interface MetaStructureInventoryViewModel {
  /** How many entities the payload served, or null when it served no census. */
  servedCount: number | null;
  campaignCount: number | null;
  adsetCount: number | null;
  /** How many of those the operator's own search term leaves visible. */
  shownCount: number;
  searchApplied: boolean;
  rows: readonly MetaStructureInventoryRowViewModel[];
  /** Why there is no inventory to browse, when that is knowable. */
  unavailableReason: string | null;
}

/**
 * The served setup, from `entityConfiguration`, without a unit this file cannot
 * verify.
 *
 * `dailyBudget` / `lifetimeBudget` / `bidValue` arrive in the provider's minor
 * units (Grandmix's Claude-DPA-USA serves `dailyBudget: 1000000` for a $10,000
 * daily budget), and nothing in this contract states the scale. Printing them
 * through `formatMoney` would have rendered "$1,000,000" — a hundredfold lie
 * about a number the operator can act on. The non-numeric labels are served
 * ready to read, so those are what this column carries.
 */
function inventoryConfiguration(entity: MetaStructureInventoryEntity): string {
  const configuration = entity.entityConfiguration;
  const parts = [
    nonBlank(configuration?.optimizationGoal),
    nonBlank(configuration?.bidStrategyLabel),
    configuration?.budgetOwner && configuration.budgetOwner !== "unknown"
      ? `${titleToken(configuration.budgetOwner)} budget`
      : null,
  ].filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join(" · ") : EM_DASH;
}

function inventoryLineage(entity: MetaStructureInventoryEntity): string {
  if (entity.level === "adset") {
    return (
      nonBlank(entity.campaignName) ?? nonBlank(entity.campaignId) ?? EM_DASH
    );
  }
  const kind = nonBlank(entity.campaignKind);
  return kind ? titleToken(kind) : EM_DASH;
}

function inventoryMatchesSearch(
  entity: MetaStructureInventoryEntity,
  query: string,
): boolean {
  if (!query) return true;
  return [entity.name, entity.campaignName ?? "", entity.statusLabel].some(
    (value) => value.toLowerCase().includes(query),
  );
}

/**
 * The served account inventory, presented as an inventory.
 *
 * `lanes.structureInventory` is the server's COMPLETE campaign and ad-set
 * census for the account. On Grandmix (5dbc7147-f051-4681-a4d6-20617170074f /
 * act_805150454596350) it serves 1,230 entities — 476 campaigns and 754 ad
 * sets — against 3 rows in Action Now and 19 in Watching. Until this builder
 * existed the only consumer of that census was
 * `structureNodesByRecommendationId`, which reads `os.structure.groups` purely
 * to enrich rows that ALREADY had a lane. So 1,211 of the 1,230 served
 * entities reached the browser and were reachable only by opening a lane
 * named Archive, and "shown" was standing in for "presented as an inventory".
 *
 * INVENTORY VISIBILITY IS NOT RECOMMENDATION OR EXECUTION ELIGIBILITY
 * (INVARIANTS.md). `MetaStructureInventoryEntity` is the right source for
 * exactly that reason: it carries no action tuple, no lane and no decision
 * label, so there is nothing here for a row to inherit that the server did not
 * serve it. This builder deliberately never touches `os.structure`, whose
 * nodes DO carry `lane`, `action` and `priority` — reading it would be how an
 * inventory row silently acquired a verdict.
 *
 * The served order travels untouched: campaigns in the order served, then ad
 * sets in the order served. No regrouping, no re-ranking, and no interleaving
 * of the two grains — a campaign's spend already contains its ad sets', so one
 * money order across both would assert a comparison no server made. The grain
 * is named on every row instead.
 *
 * The only filter is the operator's own search term, which is the same term
 * the queue toolbar shows and can clear, and the counts report the served
 * total beside the shown total so a typed term narrows a table without
 * appearing to shrink the account.
 */
export function buildMetaStructureInventoryViewModel(input: {
  workspace: MetaDecisionsWorkspacePayload | null | undefined;
  fallbackCurrency?: string | null;
  search?: string;
}): MetaStructureInventoryViewModel {
  const served = input.workspace?.lanes?.structureInventory;
  if (!served) {
    return {
      servedCount: null,
      campaignCount: null,
      adsetCount: null,
      shownCount: 0,
      searchApplied: false,
      rows: [],
      unavailableReason: input.workspace
        ? "This payload carried no structure inventory, so the account census cannot be listed."
        : "The decision workspace has not loaded, so the account census cannot be listed.",
    };
  }
  const currency = currencyCode(input.fallbackCurrency);
  const query = (input.search ?? "").trim().toLowerCase();
  const rows = served
    .filter((entity) => inventoryMatchesSearch(entity, query))
    .map((entity) => ({
      id: `${entity.level}:${entity.id}`,
      name: nonBlank(entity.name) ?? EM_DASH,
      grain: INVENTORY_GRAIN_LABEL[entity.level],
      lineage: inventoryLineage(entity),
      status: nonBlank(entity.statusLabel) ?? titleToken(entity.status),
      // A measured zero stays a zero; an unserved metric stays an em dash.
      spend: formatMoney(entity.metrics.spend, currency),
      // ROAS is undefined at zero spend rather than 0.00, and 1,218 of
      // Grandmix's 1,230 inventory rows spent nothing in the window.
      roas: formatRoasAgainstSpend(entity.metrics.roas, entity.metrics.spend),
      purchases:
        finite(entity.metrics.purchases) === null
          ? EM_DASH
          : formatNumber(entity.metrics.purchases!),
      // A measured CPA of 0 is impossible in practice but stays a 0 if the
      // server ever measures one; an unserved CPA stays an em dash. The
      // server already withholds it as null when there were no purchases to
      // divide by, so no zero-divisor guard is re-derived here.
      cpa: formatMoney(entity.metrics.cpa, currency),
      ctr: formatPercent(entity.metrics.ctr),
      configuration: inventoryConfiguration(entity),
    }));
  return {
    servedCount: served.length,
    campaignCount: served.filter((entity) => entity.level === "campaign")
      .length,
    adsetCount: served.filter((entity) => entity.level === "adset").length,
    shownCount: rows.length,
    searchApplied: query.length > 0,
    rows,
    unavailableReason:
      served.length === 0
        ? "The server served an empty structure inventory for this account and window."
        : null,
  };
}

/**
 * The posture band, over the whole served creative scope.
 *
 * All four tiles were pinned to `—`, so the band was decorative on every
 * account. Two of them are plain descriptions of rows the workspace already
 * serves and are computed here:
 *
 * - **Avg frequency · 28d** — the spend-weighted mean of the served
 *   `metrics.frequency`. Spend-weighted, not a flat mean, because a £4 test ad
 *   at frequency 9 should not drag the account's number around.
 * - **Refresh pipeline** — how many served decisions carry the engine's
 *   `refresh` verdict. A count of a server label, not a client verdict.
 * - **Fatigued spend share** — the share of served spend sitting on creatives
 *   the engine marked `fatigued` or `watch` on the lifecycle row it decided
 *   from. A share over a server label, in the same class as the count above.
 *   Rows whose fatigue status is `unknown` are excluded from the denominator
 *   rather than counted as healthy, so a half-covered account reports the share
 *   of what was actually assessed instead of a diluted number.
 *
 * "Winner concentration" stays `—`. There is no served notion of a winner:
 * deciding that `keep` means winner, or that the top decile does, would mint a
 * decision rule inside a presentation adapter.
 *
 * Deliberately computed over the full served set rather than the filtered rows,
 * so typing in the search box narrows the queue without appearing to move the
 * account's posture.
 */
function creativePosture(
  decisions: readonly MetaOsAdDecision[],
): MetaDecisionCenterExactViewModel["creativePosture"] {
  let weightedFrequency = 0;
  let frequencyWeight = 0;
  let frequencyRows = 0;
  let refreshCount = 0;
  let assessedSpend = 0;
  let fatiguedSpend = 0;
  let assessedRows = 0;

  for (const decision of decisions) {
    const frequency = finite(decision.metrics.frequency);
    const spend = finite(decision.metrics.spend);
    if (frequency !== null && spend !== null && spend > 0) {
      weightedFrequency += frequency * spend;
      frequencyWeight += spend;
      frequencyRows += 1;
    }
    if (decision.publishedLabel.trim().toLowerCase() === "refresh") {
      refreshCount += 1;
    }
    const fatigue = decision.fatigueStatus?.trim().toLowerCase();
    if (
      spend !== null &&
      spend > 0 &&
      (fatigue === "none" || fatigue === "watch" || fatigue === "fatigued")
    ) {
      assessedSpend += spend;
      assessedRows += 1;
      if (fatigue !== "none") fatiguedSpend += spend;
    }
  }

  const averageFrequency =
    frequencyWeight > 0 ? weightedFrequency / frequencyWeight : null;
  const fatiguedShare =
    assessedSpend > 0 ? (fatiguedSpend / assessedSpend) * 100 : null;
  const values: Record<string, { value: string; detail: string }> = {
    "fatigued-spend-share": {
      value: fatiguedShare === null ? EM_DASH : `${Math.round(fatiguedShare)}%`,
      detail:
        fatiguedShare === null
          ? EM_DASH
          : `of ${formatNumber(assessedRows)} assessed creatives`,
    },
    "winner-concentration": { value: EM_DASH, detail: EM_DASH },
    "average-frequency": {
      value: averageFrequency === null ? EM_DASH : averageFrequency.toFixed(1),
      detail:
        averageFrequency === null
          ? EM_DASH
          : `${frequencyRows} of ${decisions.length} creatives`,
    },
    "refresh-pipeline": {
      value: decisions.length === 0 ? EM_DASH : formatNumber(refreshCount),
      detail:
        decisions.length === 0
          ? EM_DASH
          : `of ${formatNumber(decisions.length)} served decisions`,
    },
  };

  return CREATIVE_POSTURE_SLOTS.map((slot) => ({
    ...slot,
    ...(values[slot.id] ?? { value: EM_DASH, detail: EM_DASH }),
  }));
}

/**
 * The three-letter media kind the reference prints inside the thumb.
 *
 * The engine records one of `image`, `video`, `catalog` on the lifecycle row it
 * decided from. Anything else stays a dash rather than being abbreviated into a
 * kind nobody defined.
 */
function creativeKindShort(format: string | null | undefined): string {
  switch (nonBlank(format)?.toLowerCase()) {
    case "image":
      return "IMG";
    case "video":
      return "VID";
    case "catalog":
      return "CAT";
    default:
      return EM_DASH;
  }
}

function creativeChips(decision: MetaOsAdDecision): string[] {
  const roas = finite(decision.metrics.roas);
  const chips = [
    titleToken(decision.lifecycleRole),
    roas === null ? null : `ROAS ${roas.toFixed(2)}`,
    decision.decisionAvailability === "pending_native_evidence"
      ? "Pending native evidence"
      : null,
  ];
  return chips.filter((value): value is string => Boolean(value));
}

function creativeMoneySub(decision: MetaOsAdDecision): string {
  const target = finite(decision.metrics.effectiveTargetRoas);
  const parts = [
    target === null ? null : `vs ${target.toFixed(2)} target`,
    nonBlank(decision.action.scopeNote),
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : EM_DASH;
}

/**
 * The served decision state, kept apart from the served verdict.
 *
 * `lane` is the server's own state field (`act` | `blocked` | `monitor`) and it
 * is NOT derivable from the label: a held `cut` and an authorized `cut` publish
 * the same word. Mapping it to a tone here is presentation only -- `blocked`
 * warns because authority was withheld, not because the engine said anything
 * new.
 */
const CREATIVE_STATE_SLOTS = [
  { id: "act", label: "Act", tone: "info" },
  { id: "blocked", label: "Blocked", tone: "warning" },
  { id: "monitor", label: "Monitor", tone: "neutral" },
] as const satisfies ReadonlyArray<{
  id: MetaOsDecisionLane;
  label: string;
  tone: MetaDecisionCenterExactTone;
}>;

function creativeStateSlot(lane: MetaOsDecisionLane | null | undefined) {
  return CREATIVE_STATE_SLOTS.find((slot) => slot.id === lane) ?? null;
}

/**
 * Why this row cannot move, in the server's own words.
 *
 * `blockers` and `resolution` are already written by the server for exactly
 * this question and were being dropped on the floor -- every Ad the engine had
 * not decided yet rendered with a bare "Evidence pending" button and no
 * statement of what was missing or who resolves it. Nothing is composed here
 * beyond the join.
 */
/**
 * What the server states but does not gate on, in the server's own words.
 *
 * These are deliberately NOT folded into the blocked note or the Blockers line.
 * `risk_tier_unclassified` used to ride both, on every single row, because the
 * read model appended it to `classification.blockers` unconditionally — so the
 * one line that answers "why can this row not move" said "Risk is unclassified"
 * about rows that were fully authorized to move. The statement is kept; the
 * claim that it stops anything is not.
 *
 * The reason is printed beside the label because a bare "Risk is unclassified"
 * reads as a finding about the ad. It is not: the producer that would classify
 * risk is not persisted yet, which is a gap in this pipeline.
 */
function canonicalAdvisoryNotes(
  canonical: MetaCanonicalDecision | null,
): string[] {
  return (canonical?.classification?.advisories ?? []).flatMap((advisory) => {
    const label = nonBlank(advisory.label);
    if (!label) return [];
    const reason = nonBlank(advisory.reason);
    return [reason ? `${label} (${reason.replaceAll("_", " ")})` : label];
  });
}

function creativeBlockedNote(decision: MetaOsAdDecision): string | null {
  const blockers = decision.blockers
    .map((blocker) => nonBlank(blocker.label))
    .filter((label): label is string => Boolean(label));
  const nextStep = nonBlank(decision.resolution?.nextStep);
  const parts = [
    blockers.length > 0 ? blockers.join(" · ") : null,
    nextStep ? `Next: ${nextStep}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" — ") : null;
}

function creativeRows(input: {
  decisions: readonly MetaOsAdDecision[];
  canonical: ReadonlyMap<string, MetaCanonicalDecision>;
  fallbackCurrency: string | null;
  ctrSeriesByAdId: ReadonlyMap<string, readonly number[]>;
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactCreativeDecisionViewModel[] {
  return input.decisions.map((decision) => {
    const canonicalDecision =
      input.canonical.get(
        canonicalKey(decision.decisionId, decision.sourceSnapshotId),
      ) ?? null;
    const rowCurrency =
      currencyCode(decision.metrics.currency) ??
      currencyCode(canonicalDecision?.metrics.currency) ??
      input.fallbackCurrency;
    /*
     * LAW: every SERVED row can open its own evidence. The canonical envelope
     * is not the gate, because it is not the only evidence.
     *
     * This used to require an envelope, and on a real account that meant no row
     * could open anything at all: Grandmix serves 60 ads, every one of them
     * lane `blocked` / `pending_native_evidence`, and none of them joins a
     * decision snapshot — so the queue rendered 60 rows whose evidence was
     * unreachable by any click, and the affordance's absence was itself
     * unexplained. What those rows carry is real served evidence — `whyNow`,
     * `blockers`, `resolution`, `assessment`, `metrics`, `lane`,
     * `decisionAvailability` — it simply lives on the SERVED decision instead
     * of in a snapshot.
     *
     * So the affordance opens on what was served and the envelope's ABSENCE
     * travels with it, as `null`, never fabricated and never inferred. The
     * window is then responsible for the other half of this law: it states
     * which half of the evidence it holds, prints every canonical-only field as
     * unavailable-with-a-reason rather than as a blank or a guess, and offers
     * no provider-write control on a row that carries no authority. The
     * callback signature has always admitted `null` for exactly this case.
     *
     * INTENTIONALLY NOT RENDERED, and this is where it would have gone:
     * `canonicalDecision.classification.resolution` — the canonical
     * `MetaDecisionResolution` (decisions-workspace-contract.ts:57, :318). It
     * rides this callback and reaches no pixel on this surface, ON PURPOSE, and
     * the reason is checkable in one line of the producer.
     *
     * THE OS RESOLUTION *IS* THIS RESOLUTION. `lib/meta/decisions-os-presentation.ts:1126`
     * is `resolution: decision.classification.resolution` — a verbatim forward,
     * not a re-derivation — and that forwarded object is what the evidence
     * window prints on its "Served resolution" line. A second block labelled
     * "Canonical resolution" would print the same five strings under a second
     * heading, and two headings for one fact invite a reader to hunt for a
     * difference that the assignment forbids.
     *
     * THE ONE PLACE THEY DIVERGE ARGUES THE SAME WAY. The pending-inventory
     * placeholder at `decisions-os-presentation.ts:1216` synthesises a
     * resolution (`produce_native_ad_decision`) for an ACTIVE ad that has NO
     * canonical decision at all. A "Canonical resolution" block on those rows
     * would print em dashes beside a populated "Served resolution", which reads
     * as two producers disagreeing when the truth is that only one produced
     * anything — a fabricated disagreement, which is the same class of defect
     * as a fabricated measurement.
     *
     * WHAT WOULD REOPEN THIS: a second writer of `MetaOsAdDecision.resolution`
     * that does not forward the canonical object verbatim. That is pinned by
     * test, not by this comment. @see meta-decision-center-exact-adapter.test.ts
     * — "the canonical resolution is the served resolution".
     */
    const review = input.callbacks.onCreativeReview
      ? () => input.callbacks.onCreativeReview?.(decision, canonicalDecision)
      : null;
    const tone = decisionTone(decision.publishedLabel);
    const state = creativeStateSlot(decision.lane);
    return {
      id: decision.id,
      name: nonBlank(decision.adName) ?? EM_DASH,
      kindShort: creativeKindShort(decision.creativeFormat),
      // The reference's thumb is a neutral striped placeholder. Colouring it by
      // verdict would let the strip read as a second opinion beside the label
      // that already carries the tone, so it keeps the design's default pair.
      stripeA: null,
      stripeB: null,
      edgeTone: state?.id === "blocked" ? "warning" : tone,
      decisionLabel: nonBlank(decision.action.label) ?? EM_DASH,
      decisionTone: tone,
      ...(state ? { stateLabel: state.label, stateTone: state.tone } : {}),
      chips: creativeChips(decision),
      note: nonBlank(decision.whyNow) ?? EM_DASH,
      ...(creativeBlockedNote(decision)
        ? { blockedNote: creativeBlockedNote(decision)! }
        : {}),
      sparkPath: sparkPath(input.ctrSeriesByAdId.get(decision.adId) ?? null),
      money: moneyAndRoas({
        spend: decision.metrics.spend,
        roas: decision.metrics.roas,
        currency: rowCurrency,
      }),
      moneySub: creativeMoneySub(decision),
      actionLabel: nonBlank(decision.action.label) ?? EM_DASH,
      actionTone: actionTone(decision.action),
      ...(review ? { onPrimary: review, onOpen: review } : {}),
    };
  });
}

/**
 * The creative queue, split by the state the server served.
 *
 * The rows are already ordered by the server (`act` before `blocked` before
 * `monitor`, then priority) and this preserves that order inside each group. It
 * moves no row between states and invents no state: a group only exists when
 * the server put rows in it.
 *
 * The header counts are two different facts kept apart. `shown` is what this
 * screen is rendering after the operator's search; `eligible pre-cap` is the
 * server's own population for that state before selection. Calling the second
 * number "served" was false: only the selected rows were actually served.
 */
function creativeGroups(input: {
  decisions: readonly MetaOsAdDecision[];
  rows: readonly MetaDecisionCenterExactCreativeDecisionViewModel[];
  statePreCapCounts: Partial<Record<MetaOsDecisionLane, number>> | undefined;
}): MetaDecisionCenterExactCreativeGroupViewModel[] {
  const rowsById = new Map(input.rows.map((row) => [row.id, row]));
  return CREATIVE_STATE_SLOTS.flatMap((slot) => {
    const decisions = input.decisions.filter(
      (decision) => decision.lane === slot.id,
    );
    const rows = decisions
      .map((decision) => rowsById.get(decision.id))
      .filter((row): row is MetaDecisionCenterExactCreativeDecisionViewModel =>
        Boolean(row),
      );
    if (rows.length === 0) return [];
    const eligiblePreCap = finite(input.statePreCapCounts?.[slot.id]);
    const vocabulary = [
      ...new Set(
        decisions
          .map((decision) => nonBlank(decision.action.label))
          .filter((label): label is string => Boolean(label)),
      ),
    ];
    return [
      {
        id: slot.id,
        label: slot.label,
        tone: slot.tone,
        count:
          eligiblePreCap === null || eligiblePreCap === rows.length
            ? `${formatNumber(rows.length)} shown`
            : `${formatNumber(rows.length)} shown · ${formatNumber(
                eligiblePreCap,
              )} eligible pre-cap`,
        note: vocabulary.length > 0 ? vocabulary.join(" · ") : EM_DASH,
        rows,
      },
    ];
  });
}

/**
 * The closing sentence, written from what the server served.
 *
 * It used to read "The engine makes only three ad-level calls -- refresh,
 * retire, scale winner", which is a second decision vocabulary maintained in
 * the UI. The served vocabulary is neither three nor fixed: TheSwaf's account
 * serves `Watch` and `Evidence pending`, Grandmix serves `Evidence pending`
 * alone, and neither list contains "retire". So the sentence names the labels
 * this account was actually served and says nothing else about the engine.
 *
 * Derived from the full served set rather than the filtered rows, for the same
 * reason the posture band is: typing in the search box narrows the queue, it
 * does not change what the engine can say.
 */
function creativeFootnote(decisions: readonly MetaOsAdDecision[]): string {
  const closing =
    "Click a row for the evidence window; metric deep-dives and side-by-side comparison live in Creative Studio.";
  const vocabulary = [
    ...new Set(
      decisions
        .map((decision) => nonBlank(decision.action.label))
        .filter((label): label is string => Boolean(label)),
    ),
  ];
  if (vocabulary.length === 0) {
    return `No ad-level call was served for this account. ${closing}`;
  }
  return `Ad-level calls served for this account: ${vocabulary.join(
    " · ",
  )}. ${closing}`;
}

function metricEvidence(input: {
  spend: number | null | undefined;
  purchases: number | null | undefined;
  snapshot: string | null | undefined;
  lifecycle: string | null | undefined;
  currency: string | null;
}): NonNullable<MetaDecisionCenterExactInspectorViewModel["evidence"]> {
  return [
    {
      id: "spend",
      label: "Spend · 28d",
      value: formatMoney(input.spend, input.currency),
    },
    {
      id: "purchases",
      label: "Purchases · 28d",
      value: finite(input.purchases) ?? EM_DASH,
    },
    {
      id: "snapshot",
      label: "Snapshot",
      value: nonBlank(input.snapshot) ?? EM_DASH,
    },
    { id: "lifecycle", label: "Lifecycle", value: titleToken(input.lifecycle) },
  ];
}

/**
 * The two readiness vocabularies, printed once each.
 *
 * The server keeps `blockers` and `missingEvidence` as PARALLEL lists and
 * dedupes each one only within itself (`decisions-os-presentation.ts` wraps
 * both in `new Set`). They name the same facts from opposite ends — a blocker
 * is the polarity-prefixed form of a requirement, which is why
 * `operator-prescription.ts` derives `blockedReason` as
 * `missing_${missingEvidence[0]}`. Concatenating them printed every paired
 * requirement TWICE, and the inspector's Blockers line became a wall of
 * nineteen tokens where nine of them were the other ten restated:
 * `missing_rollback_plan · … · rollback_plan`.
 *
 * Only an EXACT match after stripping the polarity prefix is treated as the
 * same fact. Near-misses are left alone on purpose — `no_empirical_outcome_model`
 * and `empirical_outcome_backtest` look like a pair and are not one, and
 * deciding they were would be an inference about engine semantics rather than
 * a presentation fix. Nothing is dropped that the server did not say twice.
 *
 * The blocker keeps its prefixed spelling because it carries the polarity the
 * operator needs; the bare requirement is the one withheld when both are present.
 */
const READINESS_POLARITY_PREFIX =
  /^(?:missing_|no_|insufficient_|unsupported_)/;

export function dedupeReadinessBlockers(
  blockers: readonly string[] | null | undefined,
  missingEvidence: readonly string[] | null | undefined,
): string[] {
  const clean = (list: readonly string[] | null | undefined) =>
    (list ?? [])
      .map(nonBlank)
      .filter((value): value is string => Boolean(value));

  // Deduped WITHIN the list first, not only across the two.
  //
  // The first version of this only compared `missingEvidence` against
  // `blockers`, on the assumption that each vocabulary stayed in its own
  // list. It does not: the server merges both spellings into `blockers`
  // itself, so the pass never fired. Measured against the live Grandmix
  // inspector — seventeen tokens on screen, which is exactly what the
  // across-lists pass returns when everything already sits in one list;
  // had they truly arrived split, it would have returned eleven.
  const stated = new Set<string>();
  const statedBlockers: string[] = [];
  for (const value of clean(blockers)) {
    const fact = value.replace(READINESS_POLARITY_PREFIX, "");
    const existing = statedBlockers.findIndex(
      (kept) => kept.replace(READINESS_POLARITY_PREFIX, "") === fact,
    );
    if (existing === -1) {
      stated.add(fact);
      statedBlockers.push(value);
      continue;
    }
    // Both spellings of one fact are present. Keep the prefixed one: it
    // carries the polarity the operator needs, and a bare requirement alone
    // reads as "this is required" rather than "this is missing".
    if (
      READINESS_POLARITY_PREFIX.test(value) &&
      !READINESS_POLARITY_PREFIX.test(statedBlockers[existing])
    ) {
      statedBlockers[existing] = value;
    }
  }

  const out = [...statedBlockers];
  const seen = new Set(statedBlockers);
  for (const requirement of clean(missingEvidence)) {
    if (stated.has(requirement.replace(READINESS_POLARITY_PREFIX, "")))
      continue;
    if (seen.has(requirement)) continue;
    seen.add(requirement);
    out.push(requirement);
  }
  return out;
}

const READINESS_TIER_LABELS: Readonly<Record<string, string>> = {
  read_only: "Read only",
  manual_review: "Manual review required",
  backtest_candidate: "Ready for backtesting",
  auto_execute: "Ready for guarded automation",
};

const READINESS_FACT_LABELS: Readonly<Record<string, string>> = {
  no_empirical_outcome_model: "No empirical outcome model is available",
  unsupported_action_class: "This action type has no safe Meta executor",
  not_action_state: "This is not an act-now decision",
  diagnostic_or_watch_state: "This is a diagnostic or watch-only decision",
  low_confidence: "Confidence is below the automation threshold",
  // Pre-D074b alias key: only older persisted payloads carry it.
  missing_campaign_label: "The automatic campaign role is unresolved",
  automatic_campaign_context_authority:
    "Automatic campaign-role authority is required",
  campaign_context_unresolved: "The campaign context is unresolved",
  campaign_context_resolver_unvalidated:
    "The automatic campaign-role resolver is awaiting independent validation",
  missing_commercial_anchor:
    "Commercial target or break-even evidence is missing",
  missing_controlled_causal_evidence: "Controlled causal evidence is missing",
  missing_valid_treatment_receipt: "A valid treatment receipt is missing",
  missing_valid_random_assignment: "A valid randomized assignment is missing",
  missing_valid_control_estimate: "A valid control estimate is missing",
  insufficient_empirical_sample: "The empirical outcome sample is too small",
  empirical_precision_below_floor:
    "Empirical precision is below the automation threshold",
  missing_executor: "No executor is enabled for this action type",
  missing_live_preflight: "Live Meta preflight evidence is missing",
  missing_rollback_plan: "A rollback plan is missing",
  missing_post_action_monitor: "A post-action monitoring plan is missing",
  missing_holdout_plan: "A holdout or incrementality plan is missing",
  missing_operator_enablement: "Operator execution is not enabled",
  empirical_outcome_backtest: "An empirical outcome backtest is required",
  controlled_causal_outcomes: "Controlled causal outcomes are required",
  valid_treatment_receipt: "A valid treatment receipt is required",
  valid_random_assignment: "A valid randomized assignment is required",
  valid_control_estimate: "A valid control estimate is required",
  empirical_outcome_sample: "An empirical outcome sample is required",
  live_preflight: "Live Meta preflight evidence is required",
  rollback_plan: "A rollback plan is required",
  // Pre-D074b alias key retained for older persisted payloads; the copy
  // never asks for a label — roles are inferred automatically.
  campaign_label: "Automatic campaign-role authority is required",
  operator_enablement: "Operator enablement is required",
};

function operatorFactLabel(value: string): string {
  const normalized = nonBlank(value);
  if (!normalized) return EM_DASH;
  const known = READINESS_FACT_LABELS[normalized];
  if (known) return known;
  return normalized
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

function operatorReadinessLabel(
  tier: string | null | undefined,
  reason: string | null | undefined,
): string {
  const normalizedTier = nonBlank(tier);
  const tierLabel = normalizedTier
    ? (READINESS_TIER_LABELS[normalizedTier] ??
      operatorFactLabel(normalizedTier))
    : null;
  const normalizedReason = nonBlank(reason);
  const reasonLabel = normalizedReason
    ? /^[a-z0-9_]+$/i.test(normalizedReason)
      ? operatorFactLabel(normalizedReason)
      : normalizedReason
    : null;
  return (
    [tierLabel, reasonLabel]
      .filter((value): value is string => Boolean(value))
      .join(" · ") || EM_DASH
  );
}

function servedEvidenceRows(
  evidence: MetaOsStructureNode["evidence"] | null | undefined,
): NonNullable<MetaDecisionCenterExactInspectorViewModel["evidence"]> {
  return (evidence ?? []).flatMap((item, index) => {
    const label = nonBlank(item.label);
    const value = nonBlank(item.value);
    if (!label || !value || label === EM_DASH || value === EM_DASH) return [];
    return [{ id: `structure-evidence-${index}`, label, value }];
  });
}

/**
 * The provenance every inspector states: when, and over what.
 *
 * Read off the payload rather than composed: `snapshotCreatedAt` is the
 * engine's write time and `startDate`/`endDate` are the window the figures
 * cover. They are separate fields because they are separate facts — a snapshot
 * written this morning can describe a window that ended three days ago, and a
 * panel that printed one as the other would make a stale read look current.
 */
function inspectorProvenance(workspace: MetaDecisionsWorkspacePayload): {
  asOf: string;
  evidenceWindow: string;
} {
  const asOf =
    nonBlank(workspace.lanes.snapshotCreatedAt) ??
    nonBlank(workspace.os?.generatedAt) ??
    nonBlank(workspace.lanes.snapshotDate) ??
    EM_DASH;
  const start = nonBlank(workspace.lanes.startDate);
  const end = nonBlank(workspace.lanes.endDate);
  return {
    asOf,
    evidenceWindow: start && end ? `${start} to ${end}` : EM_DASH,
  };
}

/**
 * Metrics the server did not serve at this row's grain.
 *
 * A null metric is not a zero — "Optional Meta event metrics remain null when
 * no source payload key was observed. Source absence must not be converted to a
 * measured zero." — so the ones the panel would otherwise print as an em dash
 * are named instead, with the grain the payload said it was serving.
 */
const GRAIN_GAP_METRICS = [
  { key: "cpa", label: "CPA" },
  { key: "ctr", label: "CTR" },
  { key: "frequency", label: "Frequency" },
] as const;

function provenanceGaps(
  metrics:
    | {
        cpa: number | null;
        ctr: number | null;
        frequency: number | null;
        grain: string;
      }
    | null
    | undefined,
): string[] {
  if (!metrics) return [];
  // A payload that did not state its own grain cannot name one in the gap
  // sentence either; the metric is still reported as unserved.
  const grain = nonBlank(metrics.grain)?.replaceAll("_", " ") ?? null;
  return GRAIN_GAP_METRICS.filter(
    (metric) => finite(metrics[metric.key]) === null,
  ).map((metric) =>
    grain
      ? `${metric.label} — not served at the ${grain} grain`
      : `${metric.label} — not served at this row's grain`,
  );
}

function structureInspector(input: {
  recommendation: MetaRecommendation;
  node: MetaOsStructureNode | null;
  fallbackCurrency: string | null;
  callback?: MetaDecisionCenterExactAdapterCallbacks["onStructurePrimary"];
}): MetaDecisionCenterExactInspectorViewModel {
  const { recommendation, node } = input;
  const action = node?.action ?? null;
  const targetRoas = finite(node?.metrics.effectiveTargetRoas);
  const readiness = recommendation.automationReadiness;
  const blockerParts = dedupeReadinessBlockers(
    readiness?.blockers,
    readiness?.missingEvidence,
  );
  return {
    entityName: entityName(recommendation),
    entityMeta: `${structureLevel(recommendation.level).toLowerCase()} · ${
      nonBlank(recommendation.campaignName) ?? EM_DASH
    }`,
    decisionLabel:
      nonBlank(action?.label) ??
      (recommendation.decisionLabel
        ? titleToken(recommendation.decisionLabel)
        : EM_DASH),
    tone: decisionTone(recommendation.decisionLabel),
    serverVerdict:
      nonBlank(action?.label) ?? nonBlank(recommendation.decision) ?? EM_DASH,
    contractDetail: nonBlank(action?.scopeNote) ?? EM_DASH,
    reasons: [
      nonBlank(node?.whyNow) ?? nonBlank(recommendation.why) ?? EM_DASH,
    ],
    moneyValue: recommendationMoney(
      recommendation,
      node,
      input.fallbackCurrency,
    ),
    targetComparison:
      targetRoas === null ? EM_DASH : `vs ${targetRoas.toFixed(2)} target`,
    // This entity's own ROAS trail, which the server has been attaching to every
    // recommendation all along. The chart was pinned to null, so the panel drew
    // its dashed target baseline and nothing against it. Deliberately not the
    // account's `pulse.roasHistory`: that is a different entity's line and would
    // read as this one's.
    moneySparkPath: sparkPath(recommendation.evidenceTrail?.roas_history),
    moneyDetail:
      nonBlank(node?.expectedImpact) ??
      nonBlank(recommendation.expectedImpact) ??
      EM_DASH,
    confidence: titleToken(node?.confidence ?? recommendation.confidence),
    readiness: operatorReadinessLabel(readiness?.tier, readiness?.reason),
    blockers:
      blockerParts.length > 0
        ? blockerParts.map(operatorFactLabel).join(" · ")
        : EM_DASH,
    blockerTone: blockerParts.length > 0 ? "warning" : "neutral",
    evidence: servedEvidenceRows(node?.evidence),
    actionLabel: nonBlank(action?.label) ?? EM_DASH,
    actionTone: actionTone(action),
    provenance: node?.sourceRecommendationId
      ? `recommendation ${node.sourceRecommendationId} · ${node.priority.version}`
      : EM_DASH,
    ...(node && input.callback
      ? { onPrimary: () => input.callback?.(recommendation, node.action) }
      : {}),
  };
}

function creativeInspector(input: {
  decision: MetaOsAdDecision;
  canonicalDecision: MetaCanonicalDecision | null;
  fallbackCurrency: string | null;
  callback?: MetaDecisionCenterExactAdapterCallbacks["onCreativeReview"];
}): MetaDecisionCenterExactInspectorViewModel {
  const { decision, canonicalDecision } = input;
  const rowCurrency =
    currencyCode(decision.metrics.currency) ??
    currencyCode(canonicalDecision?.metrics.currency) ??
    input.fallbackCurrency;
  const blockers = decision.blockers
    .map((blocker) => blocker.label)
    .filter(Boolean);
  const advisories = canonicalAdvisoryNotes(canonicalDecision);
  const targetRoas = finite(decision.metrics.effectiveTargetRoas);
  return {
    entityName: nonBlank(decision.adName) ?? EM_DASH,
    entityMeta:
      [decision.campaignName, decision.adsetName]
        .map(nonBlank)
        .filter((value): value is string => Boolean(value))
        .join(" · ") || EM_DASH,
    decisionLabel: nonBlank(decision.action.label) ?? EM_DASH,
    tone: decisionTone(decision.publishedLabel),
    serverVerdict: nonBlank(decision.action.label) ?? EM_DASH,
    contractDetail:
      nonBlank(decision.resolution?.nextStep) ??
      nonBlank(decision.action.scopeNote) ??
      EM_DASH,
    reasons: [nonBlank(decision.whyNow) ?? EM_DASH],
    moneyValue: moneyAndRoas({
      spend: decision.metrics.spend,
      roas: decision.metrics.roas,
      currency: rowCurrency,
    }),
    targetComparison:
      targetRoas === null ? EM_DASH : `vs ${targetRoas.toFixed(2)} target`,
    moneySparkPath: null,
    moneyDetail: nonBlank(decision.action.scopeNote) ?? EM_DASH,
    confidence: titleToken(decision.confidence),
    readiness: titleToken(decision.confirmationCeremony),
    blockers: blockers.length > 0 ? blockers.join(" · ") : EM_DASH,
    blockerTone: blockers.length > 0 ? "warning" : "neutral",
    advisories: advisories.length > 0 ? advisories.join(" · ") : EM_DASH,
    evidence: metricEvidence({
      spend: decision.metrics.spend,
      purchases: decision.metrics.purchases,
      snapshot: decision.snapshotAsOf,
      lifecycle: decision.lifecycleRole,
      currency: rowCurrency,
    }),
    actionLabel: nonBlank(decision.action.label) ?? EM_DASH,
    actionTone: actionTone(decision.action),
    provenance: `decision ${decision.decisionId} · snapshot ${decision.sourceSnapshotId}`,
    ...(input.callback
      ? {
          onPrimary: () => input.callback?.(decision, canonicalDecision),
        }
      : {}),
  };
}

/**
 * The selection the evidence inspector is actually describing.
 *
 * `undefined` means nobody has clicked yet, and the resting state the reference
 * draws is the first Action Now row -- which is what the inspector has always
 * defaulted to. The queue never knew that, so on first paint no row looked
 * selected and the operator's first click appeared to change nothing. Both
 * sides now read the answer from this one function, which is what keeps the
 * highlighted row and the panel from disagreeing.
 */
function resolveSelection(input: {
  selection: MetaDecisionCenterExactAdapterSelection | undefined;
  actionRecommendations: readonly MetaRecommendation[];
  blockedRecommendations: readonly MetaRecommendation[];
  watchingRecommendations: readonly MetaRecommendation[];
  defaultSelectionLane?: "action" | "needsres" | "watching";
}): MetaDecisionCenterExactAdapterSelection {
  if (input.selection !== undefined) return input.selection;
  const first =
    input.defaultSelectionLane === "needsres"
      ? input.blockedRecommendations[0]
      : input.defaultSelectionLane === "watching"
        ? input.watchingRecommendations[0]
        : input.actionRecommendations[0];
  return first ? { kind: "structure", recommendationId: first.id } : null;
}

function inspector(input: {
  selection: MetaDecisionCenterExactAdapterSelection;
  /**
   * Every structure row the inspector may be pointed at.
   *
   * Selection used to resolve against Action Now alone, so a Watching row's
   * "Review" produced a selection the inspector could not find and returned
   * null. The default still comes from Action Now — the reference's resting
   * state, resolved in `resolveSelection` — but an explicit one resolves across
   * the lanes.
   */
  selectableRecommendations: readonly MetaRecommendation[];
  creativeDecisions: readonly MetaOsAdDecision[];
  nodes: ReadonlyMap<string, MetaOsStructureNode>;
  canonical: ReadonlyMap<string, MetaCanonicalDecision>;
  fallbackCurrency: string | null;
  provenance: { asOf: string; evidenceWindow: string };
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactInspectorViewModel | null {
  const selection = input.selection;
  if (!selection) return null;

  if (selection.kind === "structure") {
    const recommendation = input.selectableRecommendations.find(
      (item) => item.id === selection.recommendationId,
    );
    if (!recommendation) return null;
    const node = input.nodes.get(recommendation.id) ?? null;
    return {
      ...structureInspector({
        recommendation,
        node,
        fallbackCurrency: input.fallbackCurrency,
        callback: input.callbacks.onStructurePrimary,
      }),
      ...input.provenance,
      provenanceGaps: provenanceGaps(node?.metrics),
      /*
       * A structure row cannot mint a brief, and says so in the brief
       * contract's own words.
       *
       * `createMetaCreativeBrief` is keyed to a creative decision snapshot —
       * `source_creative_id` and `source_snapshot_id` are NOT NULL — and a
       * campaign or ad set has neither. Offering a link that would be refused
       * after the navigation is worse than refusing here.
       */
      brief: input.callbacks.briefHref
        ? {
            refusalReason:
              "A brief is created from a creative decision. This row is a " +
              `${structureLevel(recommendation.level).toLowerCase()}, so it carries no creative snapshot to derive one from.`,
          }
        : null,
    };
  }

  const decision = input.creativeDecisions.find(
    (item) =>
      item.decisionId === selection.decisionId &&
      (!selection.sourceSnapshotId ||
        item.sourceSnapshotId === selection.sourceSnapshotId),
  );
  if (!decision) return null;
  const canonicalDecision =
    input.canonical.get(
      canonicalKey(decision.decisionId, decision.sourceSnapshotId),
    ) ?? null;
  /*
   * The brief lineage, when the row carries one.
   *
   * `canCreateBrief` is the brief contract's own gate — the same function the
   * Briefs surface runs before it will POST — so the control here refuses for
   * exactly the reasons the route would, in exactly its words. Nothing else in
   * the product mints a link carrying this lineage, so until now the brief
   * flow was reachable only by hand-writing a URL.
   */
  const briefLineage = {
    creativeId: decision.creativeId,
    accountId: decision.providerAccountId,
    snapshotId: decision.sourceSnapshotId,
    trigger: nonBlank(decision.publishedLabel) ?? nonBlank(decision.rawLabel),
  };
  const briefGate = canCreateBrief(briefLineage);
  const briefHref = briefGate.ok
    ? (input.callbacks.briefHref?.({
        creativeId: decision.creativeId!.trim(),
        snapshotId: decision.sourceSnapshotId.trim(),
        trigger: briefLineage.trigger!.trim(),
      }) ?? null)
    : null;
  return {
    ...creativeInspector({
      decision,
      canonicalDecision,
      fallbackCurrency: input.fallbackCurrency,
      callback: input.callbacks.onCreativeReview,
    }),
    ...input.provenance,
    provenanceGaps: provenanceGaps(decision.metrics),
    brief: !input.callbacks.briefHref
      ? null
      : briefHref
        ? { href: briefHref, label: "Create a brief from this decision" }
        : {
            refusalReason: briefGate.ok
              ? "This route family has no brief workspace to open."
              : briefGate.reason,
          },
  };
}

/**
 * Why ad-level decisions are withheld, in the server's own words.
 *
 * When the native ad source is not the authority, the payload already carries
 * both the machine reason and a written limitation; this joins them rather than
 * composing a new sentence, so the screen cannot claim a cause the server did
 * not give.
 *
 * Returns null when the source IS the authority: an account whose native source
 * is healthy has no refusal to report here, and the source panel still states
 * the authority, the health and every capability gap.
 *
 * NOTE ON PLACEMENT: this used to render only when the creative queue was
 * empty, which is why Grandmix could serve sixty rows and say nothing about a
 * degraded source. It is now rendered inside the source panel, which is not
 * gated on the row count. @see MetaDecisionCenterExactSourceProvenanceViewModel
 */
function creativesNotice(
  workspace: MetaDecisionsWorkspacePayload,
): string | null {
  const source = workspace.os?.source;
  if (!source || source.adsSource === "native_ad_decision") return null;
  const served = (workspace.os?.limitations ?? []).find(
    (limitation) =>
      limitation.code === "legacy_creative_review_only" ||
      limitation.code === "active_ad_inventory_pending_native_decision",
  );
  const reason = nonBlank(source.fallbackReason);
  const message =
    nonBlank(served?.message) ??
    "Ad-level decisions are withheld because the native decision source is not the authority for this account.";
  return reason ? `${message} Source: ${reason}.` : message;
}

/** The eight named capability states, in the order the contract declares them. */
const DECISION_CAPABILITY_SLOTS = [
  { key: "providerAccountScope", label: "Provider account scope" },
  { key: "stableDecisionIdentity", label: "Stable decision identity" },
  { key: "stableEpisodeIdentity", label: "Stable episode identity" },
  { key: "classificationOverlay", label: "Classification overlay" },
  { key: "riskTierProducer", label: "Risk tier producer" },
  { key: "promotionBasisProducer", label: "Promotion basis producer" },
  { key: "responseAttribution", label: "Response attribution" },
  { key: "providerWriteLinkage", label: "Provider write linkage" },
] as const satisfies ReadonlyArray<{
  key: keyof MetaDecisionsWorkspaceReadModel["capabilities"];
  label: string;
}>;

/** A served count, or an em dash when the field was not served. Zero stays 0. */
function servedCount(value: number | null | undefined): string {
  const count = finite(value);
  return count === null ? EM_DASH : formatNumber(count);
}

function fact(
  id: string,
  label: string,
  value: string | null | undefined,
  tone?: MetaDecisionCenterExactTone,
): MetaDecisionCenterExactSourceFactViewModel {
  return {
    id,
    label,
    value: nonBlank(value) ?? EM_DASH,
    ...(tone ? { tone } : {}),
  };
}

function decisionPipelineTone(
  workspace: MetaDecisionsWorkspacePayload,
): MetaDecisionCenterExactTone {
  const health = workspace.system?.pipelineHealth;
  if (
    !health ||
    health.overall === "unavailable" ||
    health.overall === "blocked"
  ) {
    return "negative";
  }
  return health.overall === "healthy" && health.executionReady
    ? "positive"
    : "warning";
}

/**
 * The operational clocks are deliberately printed separately. A current
 * decision snapshot cannot stand in for current sync admission or finalized
 * warehouse truth, and a healthy worker heartbeat cannot stand in for either.
 */
function decisionPipelineFacts(
  workspace: MetaDecisionsWorkspacePayload,
): MetaDecisionCenterExactSourceFactViewModel[] {
  const health = workspace.system?.pipelineHealth;
  const tone = decisionPipelineTone(workspace);
  if (!health) {
    return [
      fact(
        "pipeline-health",
        "Decision pipeline",
        "unavailable (legacy payload)",
        tone,
      ),
      fact("pipeline-execution-ready", "Pipeline execution ready", "no", tone),
    ];
  }
  const offender = health.admission.offender;
  const age = (value: number | null, unit: string) =>
    value === null ? null : `${value.toFixed(1)} ${unit}`;
  const bytes = (value: number) =>
    `${Math.trunc(value).toLocaleString("en-US")} bytes`;
  return [
    fact("pipeline-contract", "Pipeline contract", health.contractVersion),
    fact("pipeline-evaluated", "Pipeline evaluated at", health.evaluatedAt),
    fact("pipeline-health", "Decision pipeline", health.overall, tone),
    fact(
      "pipeline-execution-ready",
      "Pipeline execution ready",
      health.executionReady ? "yes" : "no",
      tone,
    ),
    fact(
      "pipeline-blockers",
      "Pipeline blockers",
      health.blockers.length > 0 ? health.blockers.join(", ") : "none",
      tone,
    ),
    fact("pipeline-sync-status", "Sync activity", health.syncActivity.status),
    fact(
      "pipeline-sync-latest",
      "Latest successful sync",
      health.syncActivity.latestAt,
    ),
    fact(
      "pipeline-sync-age",
      "Successful sync age",
      age(health.syncActivity.ageMinutes, "minutes"),
    ),
    fact(
      "pipeline-sync-limit",
      "Maximum sync age",
      `${health.syncActivity.maxAgeMinutes} minutes`,
    ),
    fact(
      "pipeline-sync-job-status",
      "Latest sync job status",
      health.syncActivity.latestJobStatus,
    ),
    fact(
      "pipeline-sync-run-status",
      "Latest sync run status",
      health.syncActivity.latestRunStatus,
    ),
    fact(
      "pipeline-sync-reason",
      "Sync status reason",
      health.syncActivity.reason,
    ),
    fact(
      "pipeline-warehouse-status",
      "Warehouse cutoff",
      health.warehouse.status,
    ),
    fact(
      "pipeline-warehouse-latest",
      "Latest finalized Ad day",
      health.warehouse.latestFinalizedDate,
    ),
    fact(
      "pipeline-warehouse-expected",
      "Expected finalized Ad day",
      health.warehouse.expectedFinalizedDate,
    ),
    fact(
      "pipeline-warehouse-lag",
      "Warehouse lag",
      health.warehouse.lagDays === null
        ? null
        : `${health.warehouse.lagDays} days`,
    ),
    fact(
      "pipeline-account-timezone",
      "Provider account timezone",
      health.warehouse.accountTimeZone,
    ),
    fact(
      "pipeline-warehouse-reason",
      "Warehouse status reason",
      health.warehouse.reason,
    ),
    fact(
      "pipeline-admission-status",
      "Sync admission",
      health.admission.status,
    ),
    fact(
      "pipeline-admission-allowed",
      "Sync admission allowed",
      health.admission.allowed ? "yes" : "no",
    ),
    fact(
      "pipeline-admission-reason",
      "Admission reason",
      health.admission.reason,
    ),
    fact(
      "pipeline-admission-evaluated",
      "Admission evaluated at",
      health.admission.evaluatedAt,
    ),
    fact("pipeline-admission-table", "Admission offender", offender?.table),
    fact(
      "pipeline-admission-bytes",
      "Offender physical size",
      offender ? bytes(offender.bytes) : null,
    ),
    fact(
      "pipeline-admission-budget",
      "Offender budget",
      offender ? bytes(offender.budget) : null,
    ),
    fact(
      "pipeline-admission-over",
      "Over budget by",
      offender ? bytes(offender.overByBytes) : null,
    ),
    fact(
      "pipeline-generation-status",
      "Decision generation",
      health.decisionGeneration.status,
    ),
    fact(
      "pipeline-generation-computed",
      "Decision computed at",
      health.decisionGeneration.computedAt,
    ),
    fact(
      "pipeline-generation-age",
      "Decision generation age",
      age(health.decisionGeneration.ageHours, "hours"),
    ),
    fact(
      "pipeline-generation-limit",
      "Maximum decision age",
      `${health.decisionGeneration.maxAgeHours} hours`,
    ),
    fact(
      "pipeline-generation-engine",
      "Decision engine",
      health.decisionGeneration.engineVersion,
    ),
    fact(
      "pipeline-generation-reason",
      "Decision generation reason",
      health.decisionGeneration.reason,
    ),
    fact(
      "pipeline-manifest-status",
      "Generation manifest",
      health.manifest.status,
    ),
    fact(
      "pipeline-manifest-authority",
      "Manifest authority",
      health.manifest.authority,
    ),
    fact("pipeline-manifest-job", "Manifest job run", health.manifest.jobRunId),
    fact(
      "pipeline-manifest-hash",
      "Manifest hash",
      health.manifest.manifestHash,
    ),
    fact(
      "pipeline-manifest-expected",
      "Manifest expected Ads",
      health.manifest.expectedAdCount === null
        ? null
        : formatNumber(health.manifest.expectedAdCount),
    ),
    fact(
      "pipeline-manifest-reason",
      "Manifest status reason",
      health.manifest.reason,
    ),
  ];
}

/**
 * The eight named capability states, and how many are not available.
 *
 * SHARED BY BOTH SCOPES ON PURPOSE. The capability envelope is a property of
 * the decision read model, not of a grain. `providerWriteLinkage` and
 * `responseAttribution` govern what a campaign or ad-set row's action may
 * claim exactly as they govern an ad's, so the structure scope states the same
 * eight states with the same server reasons rather than a second, softer
 * version of them.
 */
function capabilityEnvelope(
  capabilities: MetaDecisionsWorkspaceReadModel["capabilities"] | undefined,
): {
  gaps: MetaDecisionCenterExactCapabilityGapViewModel[];
  summary: string;
} {
  if (!capabilities) {
    // An unserved envelope is not "no gaps". It is "we could not read it".
    return { gaps: [], summary: `capabilities ${EM_DASH}` };
  }
  const gaps = DECISION_CAPABILITY_SLOTS.flatMap((slot) => {
    const state = capabilities[slot.key];
    // A capability the server did not serve at all is a gap too, and an
    // unserved state must not read as "available".
    if (state?.status === "available") return [];
    return [
      {
        id: slot.key,
        label: slot.label,
        status: titleToken(state?.status),
        reason: nonBlank(state?.reason) ?? EM_DASH,
        tone:
          state?.status === "proposed"
            ? ("warning" as const)
            : ("negative" as const),
      },
    ];
  });
  return {
    gaps,
    summary: `${formatNumber(gaps.length)} of ${formatNumber(
      DECISION_CAPABILITY_SLOTS.length,
    )} not available`,
  };
}

/**
 * The two capability states that decide what any row's action may claim.
 *
 * Named here because the structure scope has no `health` token of its own to
 * colour its headline with: an account can serve a perfectly available
 * recommendation source while the envelope that would let a write be linked
 * back and attributed is unavailable. Colouring that green because the SOURCE
 * is fine is the failure this list exists to prevent.
 */
const WRITE_BEARING_CAPABILITY_KEYS = [
  "providerWriteLinkage",
  "responseAttribution",
] as const satisfies ReadonlyArray<
  keyof MetaDecisionsWorkspaceReadModel["capabilities"]
>;

/**
 * The limitation codes the OS presentation emits about the AD grain only.
 *
 * @see lib/meta/decisions-os-presentation.ts — every code it emits today is on
 * this list, all three of them consequences of the ad decision source falling
 * back to creative grain or of ACTIVE ad inventory awaiting a native decision.
 * None of them constrains a campaign or ad-set row, so repeating them under a
 * structure heading would attach an ads refusal to rows it does not govern.
 *
 * The default for an UNKNOWN code is to show it. Withholding a served
 * limitation from the operator is the worse failure of the two, so only codes
 * named here are held back, and the structure panel still reports how many it
 * held back and where they are stated instead.
 */
const AD_GRAIN_LIMITATION_CODES: ReadonlySet<string> = new Set([
  "legacy_creative_review_only",
  "ad_metrics_are_creative_context",
  "active_ad_inventory_pending_native_decision",
]);

/** Snapshot identity of the read model, which both scopes were computed from. */
function snapshotFacts(
  readSource: MetaDecisionsWorkspaceReadModel["source"] | undefined,
): MetaDecisionCenterExactSourceFactViewModel[] {
  return [
    fact("snapshot-as-of", "Snapshot as of", readSource?.snapshotAsOf),
    fact("computed-at", "Computed at", readSource?.computedAt),
    fact("engine-version", "Engine", readSource?.engineVersion),
  ];
}

/**
 * The READ MODEL's own status, and the reason it gave for it.
 *
 * WHY THIS EXISTS — a label that named a different field. The structure panel
 * printed `source.status` (decisions-workspace-contract.ts:413) under the label
 * "Read model status", directly above the `unavailable` code and message. Those
 * two rows are the explanation of `MetaDecisionsWorkspaceReadModel.status`
 * (decisions-workspace-contract.ts:401, `unavailable: {code, message} | null`
 * beside it), which reached no surface at all — so the panel attached one
 * field's reason to another field's value and called the pair one fact. On a
 * source panel, whose entire job is to say what the source said, a label naming
 * the wrong field is the worst available defect.
 *
 * THEY ARE TWO FACTS, NOT ONE SPELT TWICE. The contract models them
 * independently: the read model can SUCCEED while the snapshot source behind it
 * could not be read and it fell back. Today both producers happen to set them
 * together — `buildUnavailableMetaDecisionsWorkspaceReadModel` writes
 * "unavailable" to both (decisions-workspace-read-model.ts:719, :729) and the
 * available builder writes "available" to both (:1785, :1795) — but that
 * agreement is a property of today's two writers, not of the contract, and it
 * is exactly the agreement an operator needs to be able to SEE break. This is
 * the opposite case to `sourcePreCapCount`, where one field is literally
 * assigned from the other and printing it twice would invent a difference.
 *
 * ABSENT VS ZERO, in its status form: a payload that served no status at all is
 * an em dash — "we could not tell" — and never the word "available".
 *
 * `unavailable: null` is NOT printed. It is a served statement that there is no
 * unavailability, already carried by the status above; rendering it as an em
 * dash would say "we could not tell whether it failed", which is the opposite
 * fact.
 */
function readModelStatusFacts(
  readModel: MetaDecisionsWorkspaceReadModel | undefined,
): MetaDecisionCenterExactSourceFactViewModel[] {
  const status = nonBlank(readModel?.status);
  const unavailable = readModel?.unavailable;
  return [
    fact(
      "read-model-status",
      "Read model status",
      status,
      status !== null && status !== "available" ? "negative" : undefined,
    ),
    ...(unavailable
      ? [
          fact(
            "unavailable-code",
            "Unavailable",
            nonBlank(unavailable.code),
            "negative",
          ),
          fact(
            "unavailable-message",
            "Unavailable detail",
            nonBlank(unavailable.message),
            "negative",
          ),
        ]
      : []),
  ];
}

/**
 * The SECOND withholding, which is not the first one.
 *
 * TWO CUTS, COUNTED SEPARATELY. `queue.omittedFromQueue` counts decisions that
 * never entered a section at all. Each section then applies its own top-N cap,
 * and `sections[key].suppressionReceipt` is the receipt for THAT cut
 * (decisions-workspace-read-model.ts:1594) — a different population, taken
 * after the first, over rows the first one kept. They are printed as two rows
 * and never summed: adding them would double nothing but would claim a single
 * withholding where the server recorded two.
 *
 * WHY IT BELONGS ON THIS SCREEN, WHICH DOES NOT DRAW THE SECTION QUEUE. The
 * Creatives lane draws `os.ads.items`, not `sections[key].items`, so a section
 * cap removes no ROW from this screen. What it removes is an ENVELOPE:
 * `defaultCanonicalDecisions` builds its canonical lookup table by unioning
 * `adCandidates.items` with the sections' items, so a decision the cap held
 * back and the candidate selection did not recover has NO canonical envelope
 * for its row to open evidence with — which is what makes that row's
 * canonical-only fields read "unavailable" instead of answering. This count is
 * the served number that explains those dashes, so it is stated beside the
 * other withholdings rather than filed away as an audit key.
 *
 * IT CLAIMS NOTHING ABOUT THE LIST. The label says "Section cap", not "hidden
 * rows": an operator reading it must not conclude that decisions are missing
 * from the queue above, because they are not.
 *
 * ABSENT VS ZERO. No `sections` object, or sections that carried no finite
 * count, is an em dash — "we could not tell". Sections that capped nothing
 * print 0, because "nothing was held back" is a fact.
 */
function sectionCapFacts(
  queue: MetaDecisionsWorkspaceReadModel["queue"] | undefined,
): MetaDecisionCenterExactSourceFactViewModel[] {
  const receipts = Object.values(queue?.sections ?? {})
    .map((section) => section?.suppressionReceipt)
    .filter((receipt): receipt is NonNullable<typeof receipt> =>
      Boolean(receipt),
    );

  const counts = receipts
    .map((receipt) => finite(receipt.suppressedCount))
    .filter((count): count is number => count !== null);
  const total =
    counts.length === 0 ? null : counts.reduce((sum, n) => sum + n, 0);

  // The reason codes are the server's own (`section_top_n_ranked`,
  // `section_top_n_unrankable`), aggregated across sections because the panel
  // states the account, not one section. A code the server did not name is
  // dropped rather than printed under an invented one.
  const byCode = new Map<string, number>();
  for (const receipt of receipts) {
    for (const reason of receipt.reasons ?? []) {
      const code = nonBlank(reason.code);
      const count = finite(reason.count);
      if (code === null || count === null) continue;
      byCode.set(code, (byCode.get(code) ?? 0) + count);
    }
  }

  return [
    fact(
      "section-cap-held-back",
      "Section cap · envelopes held back",
      total === null ? null : formatNumber(total),
    ),
    ...[...byCode.entries()].map(([code, count]) =>
      fact(`section-cap-${code}`, `Section cap · ${code}`, formatNumber(count)),
    ),
  ];
}

/**
 * What the decision source is, what it covered, and what it could not do.
 *
 * WHY THIS EXISTS. Source degradation used to reach the desktop through one
 * path only — `creativesNotice`, rendered when the creative queue was EMPTY. On
 * a real account the queue is not empty, so the degradation was never said:
 * Grandmix (biz 5dbc7147…, act_805150454596350, snapshot 2026-08-19) renders 60
 * rows against a served `sourcePreCapCount` of 80, with `responseAttribution`
 * and `providerWriteLinkage` both `unavailable` and two producers still
 * `proposed`, and the screen reported none of it. A capped list that does not
 * say it is capped reads as the whole account.
 *
 * WHAT IT IS ALLOWED TO DO. Copy. Every value below is a served token, a served
 * string or a served count; the only text this function authors is the field
 * LABEL. It reads no decision, ranks nothing, and produces no callback — the
 * panel has no controls at all, so it cannot become a write path.
 *
 * ABSENT VS ZERO. A field the payload did not serve renders as an em dash. A
 * count the server measured as zero renders as 0, including
 * `omittedFromQueue.count`, because "nothing was withheld" is a fact and
 * "we could not tell" is a different one.
 */
/**
 * The canonical commercial-anchor explanation, rendered verbatim.
 *
 * Every value is copied from `system.commercialAnchor`, which the server
 * projected from `AccountDecisionProfile.hardActionEligibility` — the same
 * object the engine decided with. The client derives NOTHING: not eligibility,
 * not a threshold, not a spend unit, not a campaign role. An absent or
 * unavailable panel says so rather than implying an anchor exists.
 */
const ANCHOR_ACTION_FACT_IDS = {
  scale: "anchor-action-scale",
  cut: "anchor-action-cut",
  refresh: "anchor-action-refresh",
} as const;
const ANCHOR_ACTION_COPY_IDS = {
  scale: "anchor-action-scale-copy",
  cut: "anchor-action-cut-copy",
  refresh: "anchor-action-refresh-copy",
} as const;

function commercialAnchorFacts(
  workspace: MetaDecisionsWorkspacePayload,
): MetaDecisionCenterExactSourceFactViewModel[] {
  const panel = workspace.system.commercialAnchor;
  if (!panel) return [];
  const currency = panel.currency;

  const withheldFacts = [
    fact(
      "anchor-withheld-profile-evidence",
      "Withheld · profile hard-action evidence",
      formatNumber(panel.withheld.profileHardActionEvidence),
      panel.withheld.profileHardActionEvidence > 0 ? "warning" : undefined,
    ),
    fact(
      "anchor-withheld-campaign-context",
      "Withheld · campaign role unresolved",
      formatNumber(panel.withheld.campaignContext),
    ),
    fact(
      "anchor-withheld-recovery",
      "Withheld · recovery unverifiable",
      formatNumber(panel.withheld.recentRecoveryUnverifiable),
    ),
  ];

  // A supplied reason is always shown, independently of `status`: the server
  // never sends one on a healthy panel, and hiding it behind the status would
  // let a real explanation of an outage go unrendered.
  const unavailableReasonFact = panel.unavailableReason
    ? [
        fact(
          "anchor-unavailable-reason",
          "Unavailable because",
          panel.unavailableReason,
          "warning",
        ),
      ]
    : [];

  if (panel.status !== "resolved" || !panel.explanation) {
    // Honest unknown. Never a spend unit, never an eligibility claim.
    return [
      fact("anchor-status", "Commercial anchor", "unavailable", "warning"),
      ...unavailableReasonFact,
      ...withheldFacts,
    ];
  }

  const explanation = panel.explanation;
  const lineage = explanation.lineage;
  const facts: MetaDecisionCenterExactSourceFactViewModel[] = [
    fact(
      "anchor-status",
      "Commercial anchor",
      explanation.status,
      explanation.thresholdEligible ? undefined : "warning",
    ),
    ...unavailableReasonFact,
    fact("anchor-currency", "Currency", currency ?? "account currency"),
    fact(
      "anchor-spend-unit",
      "Hard-action spend unit",
      explanation.spendUnit === null
        ? null
        : formatMoney(explanation.spendUnit, currency),
    ),
    fact("anchor-source", "Spend unit source", explanation.spendUnitSource),
    fact(
      "anchor-confidence",
      "Spend unit confidence",
      explanation.spendUnitConfidence,
      explanation.spendUnitConfidence === "high" ||
        explanation.spendUnitConfidence === "medium"
        ? undefined
        : "warning",
    ),
    fact(
      "anchor-freshness",
      "Target provenance",
      `${explanation.targetPackFreshness ?? "unknown"}${
        explanation.targetPackUpdatedAt
          ? ` · ${explanation.targetPackUpdatedAt}`
          : ""
      }`,
      (explanation.targetPackFreshness ?? "unknown") === "unknown"
        ? "warning"
        : undefined,
    ),
    fact(
      "anchor-target-cpa",
      "Target CPA",
      lineage.targetCpa === null
        ? null
        : formatMoney(lineage.targetCpa, currency),
    ),
    fact(
      "anchor-aov",
      "AOV assumption",
      lineage.operatorAovAssumption === null
        ? null
        : formatMoney(lineage.operatorAovAssumption, currency),
    ),
    fact(
      "anchor-target-roas",
      "Target ROAS",
      lineage.targetRoas === null ? null : formatNumber(lineage.targetRoas),
    ),
    fact(
      "anchor-break-even-roas",
      "Break-even ROAS",
      lineage.breakEvenRoas === null
        ? null
        : formatNumber(lineage.breakEvenRoas),
    ),
    fact(
      "anchor-meta-aov",
      "Sampled Meta AOV",
      lineage.metaAttributedAovMean90d === null
        ? null
        : `${formatMoney(lineage.metaAttributedAovMean90d, currency)} · ${formatNumber(
            lineage.metaAttributedAovPurchaseCount90d,
          )} purchases (90d) · ${explanation.metaAovQuality}`,
    ),
    fact(
      "anchor-account-cpa-p50",
      "Account CPA p50 (history, not a target)",
      lineage.accountCpaP50 === null || lineage.accountCpaP50 === undefined
        ? null
        : `${formatMoney(lineage.accountCpaP50, currency)} · ${formatNumber(
            lineage.accountCpaSampleCount ?? 0,
          )} sample`,
    ),
    fact(
      "anchor-attribution-adjustment",
      "Attribution AOV adjustment",
      lineage.attributionAovAdjustmentMultiplier === null
        ? null
        : formatNumber(lineage.attributionAovAdjustmentMultiplier),
    ),
    ...withheldFacts,
  ];

  // Scale, Cut and Refresh each get their own row: the engine's effective
  // decision, its stable code, and the server's own sentence.
  for (const row of panel.actions) {
    const name = `${row.action[0].toUpperCase()}${row.action.slice(1)}`;
    facts.push(
      fact(
        ANCHOR_ACTION_FACT_IDS[row.action],
        name,
        `${row.eligible ? "eligible" : "withheld"}${
          row.blockerCode ? ` · ${row.blockerCode}` : ""
        }`,
        row.eligible ? undefined : "warning",
      ),
    );
    if (row.operatorCopy) {
      facts.push(
        fact(
          ANCHOR_ACTION_COPY_IDS[row.action],
          `${name} · next step`,
          row.operatorCopy,
          "warning",
        ),
      );
    }
  }

  if (explanation.missingInputs.length > 0) {
    facts.push(
      fact(
        "anchor-missing-inputs",
        "Missing inputs",
        explanation.missingInputs.join(", "),
        "warning",
      ),
    );
  }
  return facts;
}

function sourceProvenance(input: {
  workspace: MetaDecisionsWorkspacePayload;
  shownCount: number;
}): MetaDecisionCenterExactSourceProvenanceViewModel {
  const { workspace } = input;
  const readModel = workspace.decisionReadModel as
    MetaDecisionsWorkspaceReadModel | undefined;
  const readSource = readModel?.source;
  const osSource = workspace.os?.source;
  const ads = workspace.os?.ads;
  const queue = readModel?.queue;

  // The served authority comes from the read model, which is the envelope that
  // names it; `os.source.adsSource` is the same fact under the OS presentation's
  // own vocabulary and is shown beside it rather than collapsed into it.
  const authority = nonBlank(readSource?.authority);
  const health = nonBlank(osSource?.health);
  const fallbackReason =
    nonBlank(readSource?.fallbackReason) ?? nonBlank(osSource?.fallbackReason);
  const pipelineTone = decisionPipelineTone(workspace);
  const tone: MetaDecisionCenterExactTone =
    pipelineTone === "negative"
      ? "negative"
      : health === "degraded" ||
          pipelineTone === "warning" ||
          (authority !== null && authority !== "native_ad")
        ? "warning"
        : health === "healthy"
          ? "positive"
          : "neutral";

  /*
   * Paired against the DERIVED eligible pre-cap, NOT `sourcePreCapCount`, and
   * the pairing says which of the two "eligible" numbers it used.
   *
   * WHY NOT `sourcePreCapCount`. They are different populations and pairing the
   * wrong one prints a lie. The derived eligible count is the pre-cap size of
   * the population that produced `ads.items`, so "shown vs eligible" is the
   * cap. `sourcePreCapCount` is the read model's own queue source, and on a
   * legacy-fallback account it is SMALLER than the rendered list: IwaStore
   * serves 36 items against sourcePreCapCount 19, which as a pair would read as
   * "36 shown of 19" — a sentence no operator can act on. It keeps its own
   * labelled row below.
   *
   * WHY "(derived)". `os.ads.eligiblePreCapCount` is NOT the read model's
   * served count forwarded. The presentation computes
   * `Math.max(queue.adCandidates.eligiblePreCapCount ?? canonicalAds.length,
   * canonicalAds.length + pendingInventoryPreCapCount)`
   * (lib/meta/decisions-os-presentation.ts:1679-1682), so it can EXCEED the
   * served `queue.adCandidates.eligiblePreCapCount`. This summary keeps reading
   * the derived maximum, because that is the number that is never smaller than
   * the list it is paired with — but it no longer claims to be the served one.
   * Both numbers are printed as their own facts below.
   */
  const eligiblePreCap = finite(ads?.eligiblePreCapCount);
  const coverageSummary =
    eligiblePreCap === null
      ? `${formatNumber(input.shownCount)} shown · ${EM_DASH} eligible pre-cap (derived)`
      : `${formatNumber(input.shownCount)} shown · ${formatNumber(
          eligiblePreCap,
        )} eligible pre-cap (derived)`;

  const { gaps: capabilityGaps, summary: capabilitySummary } =
    capabilityEnvelope(readModel?.capabilities);

  const generation = readSource?.generation;
  const suppression = queue?.omittedFromQueue;

  return {
    headline: [authority ?? EM_DASH, health ?? EM_DASH].join(" · "),
    tone,
    coverageSummary,
    capabilitySummary,
    source: [
      fact("authority", "Authority", authority, tone),
      // Two statuses, two labels. @see readModelStatusFacts — the read model's
      // own status is not its source's status, and neither may be printed under
      // the other's name.
      ...readModelStatusFacts(readModel),
      fact("status", "Source status", readSource?.status),
      fact("health", "Health", health, tone),
      ...decisionPipelineFacts(workspace),
      fact("ads-source", "Ads source", osSource?.adsSource),
      fact("fallback-reason", "Fallback reason", fallbackReason),
      fact("table", "Table", readSource?.table),
      ...snapshotFacts(readSource),
      fact("generation-job-run", "Generation job run", generation?.jobRunId),
      fact(
        "generation-account-ref",
        "Provider account ref",
        generation?.providerAccountRefId,
      ),
      fact("generation-manifest", "Manifest hash", generation?.manifestHash),
      fact(
        "generation-expected-ads",
        "Expected ads",
        generation ? servedCount(generation.expectedAdCount) : null,
      ),
    ],
    coverage: [
      fact("shown", "Shown here", formatNumber(input.shownCount)),
      /*
       * BOTH eligible pre-cap counts, each under a label naming which it is.
       *
       * `queue.adCandidates.eligiblePreCapCount` is what the read model
       * measured (decisions-workspace-contract.ts:456). `os.ads.eligiblePreCapCount`
       * is a MAXIMUM the presentation derives from it and from the rows it
       * actually built — `Math.max(served ?? canonicalAds.length,
       * canonicalAds.length + pendingInventoryPreCapCount)`
       * (lib/meta/decisions-os-presentation.ts:1679-1682) — so it can be
       * strictly larger, and it was the one printed under the bare label
       * `Eligible (pre-cap)` while the served count reached no surface at all.
       *
       * THIS IS NOT THE `sourcePreCapCount` CASE. That one is forwarded
       * verbatim, so it is read once and printed once (see below); printing it
       * twice would invite a reader to look for a difference that cannot exist.
       * Here a difference CAN exist and is the whole point: an operator must be
       * able to tell the served count from the derived one, and see the gap
       * when the presentation had to raise the ceiling to cover rows the read
       * model did not count as eligible.
       *
       * When they agree — the healthy case — the panel says the same number
       * twice, which is a true statement about two fields and not a repetition
       * of one.
       */
      fact(
        "queue-eligible-pre-cap",
        "Eligible (pre-cap) · read model",
        servedCount(queue?.adCandidates?.eligiblePreCapCount),
      ),
      fact(
        "ads-eligible-pre-cap",
        "Eligible (pre-cap) · derived maximum",
        servedCount(ads?.eligiblePreCapCount),
      ),
      // `os.ads.sourcePreCapCount` is `queue.sourcePreCapCount` forwarded, so
      // it is read here once rather than printed twice under two labels.
      fact(
        "queue-source-pre-cap",
        "Decision source (pre-cap)",
        servedCount(queue?.sourcePreCapCount ?? ads?.sourcePreCapCount),
      ),
      fact(
        "queue-queued-pre-cap",
        "Queued (pre-cap)",
        servedCount(queue?.queuedPreCapCount),
      ),
      fact(
        "omitted-unverified-ad-id",
        "Omitted · unverified ad id",
        servedCount(ads?.omittedWithoutVerifiedAdId),
      ),
      fact(
        "omitted-ambiguous-identity",
        "Omitted · ambiguous identity",
        servedCount(ads?.omittedAmbiguousIdentity),
      ),
      fact(
        "omitted-not-applicable",
        "Omitted · not applicable",
        servedCount(ads?.omittedNotApplicable),
      ),
    ],
    suppression: [
      fact("suppressed-count", "Withheld", servedCount(suppression?.count)),
      ...(suppression?.reasons ?? []).map((reason, index) =>
        fact(
          `suppression-${nonBlank(reason.code) ?? index}`,
          nonBlank(reason.code) ?? EM_DASH,
          servedCount(reason.count),
        ),
      ),
      ...sectionCapFacts(queue),
    ],
    limitations: [
      fact(
        "limitation-count",
        "Served limitations",
        workspace.os ? servedCount(workspace.os.limitations?.length) : null,
      ),
      ...(workspace.os?.limitations ?? []).map((limitation, index) =>
        fact(
          `limitation-${nonBlank(limitation.code) ?? index}`,
          nonBlank(limitation.code) ?? EM_DASH,
          limitation.message,
          "warning",
        ),
      ),
    ],
    commercialAnchor: commercialAnchorFacts(workspace),
    capabilityGaps,
  };
}

/**
 * What the STRUCTURE scope's rows came from, and what their actions cannot claim.
 *
 * WHY THIS EXISTS. The source panel rendered in the Creatives scope only, so
 * the campaign and ad-set lanes stated no authority at all — while being backed
 * by the same read model and, decisively, the same capabilities envelope. On
 * Grandmix (biz 5dbc7147…, act_805150454596350) `providerWriteLinkage` is
 * `unavailable` with reason `native_action_receipt_not_observed` and
 * `responseAttribution` is `unavailable` with reason
 * `native_response_source_unavailable`. Both bear directly on what a structure
 * row's action button can honestly claim, and neither was said anywhere on the
 * scope that draws those buttons.
 *
 * SAME MODEL, NOT A SECOND EXPLANATION. This returns the SAME
 * `MetaDecisionCenterExactSourceProvenanceViewModel` the Creatives scope
 * returns, rendered by the SAME component with the same headings and the same
 * tones. What differs is only which served fields apply:
 *
 *   WITHHELD, because they describe the ad grain and nothing else —
 *     `source.authority` / `source.table` (which decision snapshot table the
 *     AD-grain queue read), `os.source.adsSource`, `os.source.health` and
 *     `source.fallbackReason` (all three derived from that same ad authority),
 *     the whole `source.generation` manifest including `expectedAdCount`,
 *     every `os.ads.*` pre-cap and omission count, `queue.omittedFromQueue`
 *     (counted over decision-snapshot rows at `queue.deduplicationGrain`, which
 *     is "ad" or "creative", never a campaign or an ad set), and the three
 *     ad-grain limitation codes. @see AD_GRAIN_LIMITATION_CODES
 *
 *   SHOWN, because they are this scope's own equivalents —
 *     `os.source.structureSource` in place of `adsSource`, the `os.structure`
 *     lane census in place of the ads pre-cap counts, `scope.providerAccountId`
 *     in place of the generation manifest's account ref, and the snapshot
 *     identity plus the eight capability states, which are shared outright.
 *
 * READING `os.structure` IS SAFE HERE. The law that
 * `buildMetaStructureInventoryViewModel` must never touch `os.structure` is
 * about ROWS: its nodes carry `lane`, `action` and `priority`, and an inventory
 * row that read them would silently acquire a verdict it was not served. This
 * function reads three AGGREGATE COUNTS and hands them to no row. Nothing here
 * gains a lane, an action or an eligibility, and the panel has no control of
 * any kind, so it cannot become a write path.
 *
 * ABSENT VS ZERO, as everywhere: an unserved field is an em dash, a measured
 * zero stays 0.
 */
function structureProvenance(
  workspace: MetaDecisionsWorkspacePayload,
): MetaDecisionCenterExactSourceProvenanceViewModel {
  const readModel = workspace.decisionReadModel as
    MetaDecisionsWorkspaceReadModel | undefined;
  const readSource = readModel?.source;
  const osSource = workspace.os?.source;
  const structure = workspace.os?.structure;

  const structureSource = nonBlank(osSource?.structureSource);
  const sourceStatus = nonBlank(readSource?.status);
  const { gaps: capabilityGaps, summary: capabilitySummary } =
    capabilityEnvelope(readModel?.capabilities);

  /*
   * The headline is coloured by BOTH halves of what it is standing for.
   *
   * The structure source has no `health` token of its own — `os.source.health`
   * is computed from the AD authority — so a headline coloured by the source
   * status alone would print green on Grandmix, directly above a capability
   * list saying provider write linkage is unavailable. A row whose action
   * cannot be linked back to a provider write is not "healthy" from the seat
   * of the operator about to press it, so a write-bearing gap carries the
   * headline to warning. This colours; it classifies nothing and withholds
   * nothing — every gap is listed underneath either way.
   */
  const writeBearingGap = readModel?.capabilities
    ? WRITE_BEARING_CAPABILITY_KEYS.some(
        (key) => readModel.capabilities[key]?.status !== "available",
      )
    : null;
  const pipelineTone = decisionPipelineTone(workspace);
  const tone: MetaDecisionCenterExactTone =
    pipelineTone === "negative"
      ? "negative"
      : sourceStatus !== null && sourceStatus !== "available"
        ? "negative"
        : pipelineTone === "warning"
          ? "warning"
          : writeBearingGap === true
            ? "warning"
            : sourceStatus === "available" && writeBearingGap === false
              ? "positive"
              : "neutral";

  /*
   * Pair the number of recommendation-backed structure decisions against the
   * served inventory census. The presentation hierarchy also contains plain
   * inventory and, when only an ad-set recommendation exists, a synthetic
   * campaign parent. Those nodes make the tree navigable but do not represent
   * additional decisions, so `structureDecisionNodeCount` excludes them by
   * source recommendation identity. If the identity or any fallback aggregate
   * was not served, the count remains unavailable instead of guessing.
   */
  const decisionNodeCount = structureDecisionNodeCount(structure);
  const censusCount = finite(workspace.lanes?.structureInventory?.length);
  const coverageSummary = `${
    decisionNodeCount === null ? EM_DASH : formatNumber(decisionNodeCount)
  } carry a decision · ${
    censusCount === null ? EM_DASH : formatNumber(censusCount)
  } in census`;

  const servedLimitations = workspace.os?.limitations ?? [];
  const applicable = servedLimitations.filter(
    (limitation) =>
      !AD_GRAIN_LIMITATION_CODES.has(nonBlank(limitation.code) ?? ""),
  );
  const adGrainCount = servedLimitations.length - applicable.length;

  return {
    headline: [structureSource ?? EM_DASH, sourceStatus ?? EM_DASH].join(" · "),
    tone,
    coverageSummary,
    capabilitySummary,
    source: [
      fact("structure-source", "Structure source", structureSource, tone),
      /*
       * The read model's OWN status, and — when it declared one — the code and
       * message that explain THAT status rather than the one below it.
       *
       * This row used to be `source.status` under the label "Read model
       * status", with the `unavailable` pair printed underneath it: one field's
       * value wearing another field's name, with the second field's reason
       * attached. @see readModelStatusFacts
       */
      ...readModelStatusFacts(readModel),
      /*
       * And the snapshot source's own status, which is what the headline and
       * the tone above are standing for — unchanged, because what colours this
       * panel is a claim about whether the SOURCE could be read.
       */
      fact("status", "Source status", sourceStatus, tone),
      ...decisionPipelineFacts(workspace),
      ...snapshotFacts(readSource),
      fact(
        "scope-provider-account",
        "Provider account",
        readModel?.scope?.providerAccountId,
      ),
      fact("scope-business", "Business", readModel?.scope?.businessId),
    ],
    coverage: [
      fact(
        "structure-census",
        "Campaigns & ad sets served",
        servedCount(censusCount),
      ),
      fact(
        "structure-decisions",
        "Carrying a decision",
        decisionNodeCount === null ? null : formatNumber(decisionNodeCount),
      ),
      fact(
        "structure-act",
        "Structure nodes · act",
        servedCount(structure?.actCount),
      ),
      fact(
        "structure-blocked",
        "Structure nodes · blocked",
        servedCount(structure?.blockedCount),
      ),
      fact(
        "structure-monitor",
        "Structure nodes · monitor",
        servedCount(structure?.monitorCount),
      ),
      fact(
        "structure-suppressed-alternatives",
        "Suppressed alternatives",
        servedCount(structure?.suppressedAlternativeCount),
      ),
    ],
    limitations: [
      fact(
        "limitation-count",
        "Limitations applying here",
        workspace.os ? servedCount(applicable.length) : null,
      ),
      ...applicable.map((limitation, index) =>
        fact(
          `limitation-${nonBlank(limitation.code) ?? index}`,
          nonBlank(limitation.code) ?? EM_DASH,
          limitation.message,
          "warning",
        ),
      ),
      /*
       * Named rather than silently dropped. The operator is told the count and
       * where the text is, so a withheld limitation cannot look like an absent
       * one. Zero of them is not printed at all: there is nothing elsewhere to
       * point at.
       */
      ...(adGrainCount > 0
        ? [
            fact(
              "limitation-ad-grain-elsewhere",
              "Ad-grain limitations",
              `${formatNumber(adGrainCount)} stated in the Creatives scope`,
            ),
          ]
        : []),
    ],
    capabilityGaps,
  };
}

/**
 * How many campaign and ad-set nodes the server attached a decision lane to.
 *
 * Null, never a partial sum, when any of the three lane counts was not served:
 * "we could not tell" and a smaller number are different claims.
 */
function structureDecisionNodeCount(
  structure: MetaDecisionsWorkspacePayload["os"]["structure"] | undefined,
): number | null {
  const { act, blocked, monitor } = structureDecisionLaneCounts(structure);
  if (act === null || blocked === null || monitor === null) return null;
  return act + blocked + monitor;
}

/**
 * Decision totals exclude inventory-only and synthetic grouping nodes.
 *
 * Current payloads explicitly carry `sourceRecommendationId` on every node.
 * A synthetic campaign can inherit an ad set's lane so the hierarchy remains
 * readable, but it is not a second recommendation. Older serialized payloads
 * that predate the identity field fall back to their served aggregate counts
 * instead of being silently rewritten as zero.
 */
function structureDecisionLaneCounts(
  structure: MetaDecisionsWorkspacePayload["os"]["structure"] | undefined,
): { act: number | null; blocked: number | null; monitor: number | null } {
  if (!structure) return { act: null, blocked: null, monitor: null };

  const nodes = structure.groups.flatMap((group) => [
    group.campaign,
    ...group.adsets,
  ]);
  const carriesSourceIdentity =
    nodes.length > 0 &&
    nodes.every((node) =>
      Object.prototype.hasOwnProperty.call(node, "sourceRecommendationId"),
    );
  if (!carriesSourceIdentity) {
    return {
      act: finite(structure.actCount),
      blocked: finite(structure.blockedCount),
      monitor: finite(structure.monitorCount),
    };
  }

  const decisions = new Map<string, MetaOsStructureNode>();
  for (const node of nodes) {
    const recommendationId = nonBlank(node.sourceRecommendationId);
    if (recommendationId && !decisions.has(recommendationId)) {
      decisions.set(recommendationId, node);
    }
  }
  const decisionNodes = [...decisions.values()];
  return {
    act: decisionNodes.filter((node) => node.lane === "act").length,
    blocked: decisionNodes.filter((node) => node.lane === "blocked").length,
    monitor: decisionNodes.filter((node) => node.lane === "monitor").length,
  };
}

/**
 * Lossless presentation adapter for the exact reference component.
 *
 * It formats server fields and joins already-produced server presentations. It
 * never classifies a decision, parses reason copy, or exposes a provider write.
 */
export function buildMetaDecisionCenterExactViewModel(
  input: MetaDecisionCenterExactAdapterInput,
): MetaDecisionCenterExactViewModel {
  const { workspace } = input;
  const overrides = input.overrides ?? {};
  const callbacks = input.callbacks ?? {};
  const providerAccountId = workspace.decisionReadModel.scope.providerAccountId;
  const scopedAccount =
    input.account &&
    (!providerAccountId || input.account.id === providerAccountId)
      ? input.account
      : null;
  const fallbackCurrency =
    currencyCode(scopedAccount?.currency) ??
    currencyCode(workspace.system.currency);
  const servedActionRecommendations =
    overrides.actionNow ?? workspace.lanes.actionNow;
  const servedWatchingRecommendations =
    overrides.watching ?? workspace.lanes.watching;
  const healthy = overrides.healthy ?? workspace.lanes.healthy;
  const servedNonSalesRecommendations =
    overrides.nonSales ?? workspace.lanes.nonSales;
  const archived = overrides.archive ?? defaultArchiveItems(workspace);
  const creativeDecisions =
    overrides.creatives ?? workspace.os?.ads?.items ?? [];
  const canonicalDecisions =
    overrides.canonicalDecisions ?? defaultCanonicalDecisions(workspace);
  const nodes = structureNodesByRecommendationId(workspace);
  const nodesByEntityKey = structureNodesByEntityKey(workspace);
  /*
   * The three server lanes, applied across every legacy source array.
   *
   * `nonSales` is a source cohort, not final authority: the server can promote
   * an active row from it into Act or Monitor. `healthy` carries no decision
   * and Archive is inactive inventory, so neither participates.
   */
  const projected = projectStructureRecommendations({
    action: servedActionRecommendations,
    watching: servedWatchingRecommendations,
    nonSales: servedNonSalesRecommendations,
    nodesByRecommendationId: nodes,
    nodesByEntityKey,
  });
  const actionRecommendations = projected.action;
  const watchingRecommendations = projected.watching;
  const blockedRecommendations = projected.blocked;
  const nonSalesRecommendations = projected.nonSales;
  /*
   * The same projection over the UNFILTERED served arrays, for counters only.
   *
   * The rows above may be a filtered override — the page narrows them by search
   * and level — and a lane counter that moved with a search term would report
   * that the account shrank. `counts.actionNow` is `actionNow.length` at the
   * producer (`lib/meta/decisions-os-presentation.ts:266`), so splitting the
   * served array is the same arithmetic the server would do, on the same
   * population, with nothing filtered out of it.
   */
  const servedProjection = projectStructureRecommendations({
    action: workspace.lanes.actionNow,
    watching: workspace.lanes.watching,
    nonSales: workspace.lanes.nonSales,
    nodesByRecommendationId: nodes,
    nodesByEntityKey,
  });
  const sourceCountRemainder = (
    count: number,
    rows: readonly MetaRecommendation[],
  ) => Math.max(0, count - rows.length);
  const unseenActionCount = sourceCountRemainder(
    workspace.lanes.counts.actionNow,
    workspace.lanes.actionNow,
  );
  const unseenWatchingCount = sourceCountRemainder(
    workspace.lanes.counts.watching,
    workspace.lanes.watching,
  );
  const unseenNonSalesCount = sourceCountRemainder(
    workspace.lanes.counts.nonSales,
    workspace.lanes.nonSales,
  );
  const osStructureDecisionCounts = structureDecisionLaneCounts(
    workspace.os?.structure,
  );
  const osStructureActionCount = osStructureDecisionCounts.act;
  const osStructureBlockedCount = osStructureDecisionCounts.blocked;
  const hasAuthoritativeOsActionAndBlockedCounts =
    osStructureActionCount !== null && osStructureBlockedCount !== null;
  const structureActionCount = hasAuthoritativeOsActionAndBlockedCounts
    ? osStructureActionCount! +
      servedProjection.unprojected.action +
      unseenActionCount
    : servedProjection.action.length + unseenActionCount;
  const structureNeedsResolutionCount = hasAuthoritativeOsActionAndBlockedCounts
    ? osStructureBlockedCount!
    : servedProjection.blocked.length;
  /*
   * `os.structure.monitorCount` is an inventory count, not a decision count:
   * the OS deliberately places structure entities with no recommendation in
   * Monitor so the full account remains inspectable. The buyer-facing summary
   * must count only recommendation-backed rows or it can announce hundreds of
   * "watched decisions" above an empty Watching queue. `servedProjection` is
   * the same unfiltered recommendation population used to build that queue;
   * the source remainder preserves a server-reported pre-page total without
   * promoting plain inventory into a decision.
   */
  const structureWatchingCount =
    servedProjection.watching.length + unseenWatchingCount;
  const structureNonSalesCount =
    servedProjection.nonSales.length + unseenNonSalesCount;
  const creativeActionCount = finite(workspace.os?.ads?.actCount);
  const creativeNeedsResolutionCount = finite(workspace.os?.ads?.blockedCount);
  const creativeWatchingCount = finite(workspace.os?.ads?.monitorCount);
  const combinedLaneCount = (
    structureCount: number,
    creativeCount: number | null,
  ): number | typeof EM_DASH =>
    creativeCount === null ? EM_DASH : structureCount + creativeCount;
  const canonical = canonicalDecisionsByKey(canonicalDecisions);
  const snapshotAsOf =
    nonBlank(workspace.decisionReadModel.source.snapshotAsOf) ??
    nonBlank(workspace.lanes.snapshotDate) ??
    nonBlank(workspace.os?.source?.snapshotAsOf);
  const engineVersion =
    nonBlank(workspace.decisionReadModel.source.engineVersion) ??
    nonBlank(workspace.os?.source?.engineVersion) ??
    nonBlank(workspace.system.engineVersion);
  const snapshotHealth = workspace.system.snapshotHealth;
  const snapshotEngineVersion = nonBlank(snapshotHealth?.engineVersion);
  const campaignRoleCoverage = workspace.pulse.campaignRoleCoverage;
  const pacing = workspace.pulse.pacing;
  const syncAge = relativeAge(workspace.pulse.lastSyncAt, input.now);
  const selection = resolveSelection({
    selection: input.selection,
    actionRecommendations,
    blockedRecommendations,
    watchingRecommendations,
    defaultSelectionLane: input.defaultSelectionLane,
  });
  const selectedRecommendationId =
    selection?.kind === "structure" ? selection.recommendationId : null;
  const creativeDecisionRows = creativeRows({
    decisions: creativeDecisions,
    canonical,
    fallbackCurrency,
    ctrSeriesByAdId: overrides.creativeCtrSeriesByAdId ?? new Map(),
    callbacks,
  });

  return {
    // D078 R4/C3.1: forwarded verbatim — all four states survive the
    // adapter. `undefined` (absent legacy payload) must NOT collapse into
    // `null` (read failed), or the UI would warn "unavailable" on payloads
    // that never carried the field.
    assignedAccountStates: workspace.assignedAccountStates,
    identity: {
      accountLabel:
        nonBlank(scopedAccount?.name) ??
        nonBlank(scopedAccount?.id) ??
        nonBlank(providerAccountId) ??
        EM_DASH,
      currency: fallbackCurrency ?? EM_DASH,
      syncedLabel: syncAge ? `synced ${syncAge}` : `synced ${EM_DASH}`,
      snapshotLabel: snapshotAsOf
        ? `snapshot ${snapshotAsOf}`
        : `snapshot ${EM_DASH}`,
      engineLabel: engineVersion
        ? `engine ${compactEngineVersion(engineVersion)}`
        : `engine ${EM_DASH}`,
      timeLabel: utcTime(workspace.decisionReadModel.source.computedAt),
    },
    activeWindow: activeWindow(workspace.window),
    operatorSummary: {
      action: combinedLaneCount(structureActionCount, creativeActionCount),
      needsResolution: combinedLaneCount(
        structureNeedsResolutionCount,
        creativeNeedsResolutionCount,
      ),
      watching: combinedLaneCount(
        structureWatchingCount,
        creativeWatchingCount,
      ),
      creatives: finite(workspace.os?.ads?.items?.length) ?? EM_DASH,
      actionScope:
        structureActionCount > 0 || creativeActionCount === null
          ? "structure"
          : "creatives",
      needsResolutionScope:
        structureNeedsResolutionCount > 0 ||
        creativeNeedsResolutionCount === null
          ? "structure"
          : "creatives",
      watchingScope:
        structureWatchingCount > 0 || creativeWatchingCount === null
          ? "structure"
          : "creatives",
      scopeCounts: {
        structure: {
          action: structureActionCount,
          needsResolution: structureNeedsResolutionCount,
          watching: structureWatchingCount,
        },
        creatives: {
          action: creativeActionCount ?? EM_DASH,
          needsResolution: creativeNeedsResolutionCount ?? EM_DASH,
          watching: creativeWatchingCount ?? EM_DASH,
        },
      },
    },
    counts: {
      /*
       * The scope counter counts the SCOPE, not the first lane inside it.
       *
       * This read `workspace.lanes.counts.actionNow`, so the pill labelled
       * "Campaigns & Ad sets" printed the same number as the "Action Now"
       * pill sitting directly under it: 3 on Grandmix
       * (act_805150454596350), for a scope whose served census is 1,230
       * entities. An operator reading the two pills together was told the
       * account holds three campaigns and ad sets, and the other 1,227 were
       * discoverable only by opening a lane named Archive.
       *
       * `lanes.structureInventory` is the served census, so that is what the
       * scope pill counts. It is NOT a lane, an eligibility set, or a queue —
       * it changes no row's classification and gives no row an action. An
       * absent census stays an em dash rather than falling back to a lane
       * total that would silently misname itself as the scope again.
       */
      structure: finite(workspace.lanes.structureInventory?.length) ?? EM_DASH,
      /*
       * Same law, same reason. This read `os.ads.actCount` — the ads whose
       * lane is `act` — so the pill labelled "Creatives" printed 0 on
       * Grandmix while 60 rows rendered directly beneath it, every one of
       * them served and every one of them lane `blocked`. A scope counter
       * that counts one lane inside the scope tells the operator the scope
       * is empty when it is not.
       *
       * It counts the served population, which is exactly what the scope
       * renders. It is not an eligibility set: none of these rows gains an
       * action, a lane or a classification by being counted.
       */
      creatives: finite(workspace.os?.ads?.items?.length) ?? EM_DASH,
      /*
       * The three counters the server's own lane split moves rows between.
       *
       * Still the SERVER's totals: each starts from `workspace.lanes.counts.*`
       * and only the rows this queue actually moved are subtracted from it. Two
       * properties follow, and both matter.
       *
       * The sum is unchanged, so no row is counted twice or lost. And the
       * numbers stay filter-independent — the split is taken over the served
       * arrays on the payload, never over the filtered overrides the page
       * passes, so a search term narrows the table without appearing to shrink
       * the account. That was the existing law here and it still holds; what
       * changed is only WHERE a blocked row is counted, because a pill reading
       * 12 above a lane drawing 9 is the mismatch this closes.
       *
       * If a payload ever caps a lane array below its own count, a blocked row
       * past the cap is neither moved nor drawn — which is correct: it was not
       * visible in either lane to begin with.
       */
      action: structureActionCount,
      needsres: structureNeedsResolutionCount,
      watching: structureWatchingCount,
      healthy: workspace.lanes.counts.healthy,
      nonsales: structureNonSalesCount,
      // The lane total, over BOTH grains the lane now holds. Deliberately read
      // off the workspace rather than the rendered rows, so a search term
      // narrows the table without appearing to shrink the account — the same
      // rule every other lane counter here follows. `lanes.counts.archive`
      // counts campaigns and ad sets only, because it was written before the
      // withheld Ad decisions were shown anywhere; counting the lane's rows
      // while ignoring 83 of them (Grandmix) is the mismatch this closes.
      archive:
        workspace.lanes.counts.archive + inactiveAdDecisions(workspace).length,
      deferred:
        finite(overrides.deferredCount) ?? workspace.lanes.deferredIds.length,
    },
    kpis: {
      spend: {
        date: workspace.endDate,
        value: formatMoney(pacing.spendToday, fallbackCurrency),
        delta: percentageDelta(pacing.spendToday, pacing.avg7dSpend),
        detail:
          finite(pacing.conversionsToday) === null
            ? EM_DASH
            : `${formatNumber(pacing.conversionsToday!)} conversions${
                finite(pacing.avg7dConversions) === null
                  ? ""
                  : ` · 7d avg ${formatNumber(pacing.avg7dConversions!)}`
              }`,
      },
      roas: {
        label: roasLabel(workspace.window),
        value: formatRoasAgainstSpend(
          workspace.pulse.roas.selected,
          pacing.windowSpend,
        ),
        target: targetRoasDisplay(
          workspace.pulse.roas.target,
          workspace.pulse.roas.targetFreshness,
          workspace.pulse.roas.target_source,
          workspace.pulse.roas.median,
        ),
        sparkPath: sparkPath(workspace.pulse.roasHistory),
      },
      snapshot: {
        freshness: snapshotHealth
          ? `${titleToken(snapshotHealth.status)} · ${
              finite(snapshotHealth.ageHours) === null
                ? EM_DASH
                : `${formatNumber(snapshotHealth.ageHours!)}h old`
            }`
          : EM_DASH,
        detail:
          [
            snapshotEngineVersion
              ? `recommendation engine ${compactEngineVersion(snapshotEngineVersion)}`
              : null,
            syncAge ? `synced ${syncAge}` : null,
          ]
            .filter((value): value is string => Boolean(value))
            .join(" · ") || EM_DASH,
      },
      campaignRoles: {
        coverage: campaignRoleCoverage
          ? `${campaignRoleCoverage.classifiedCampaigns}/${campaignRoleCoverage.activeCampaigns}`
          : EM_DASH,
        percentage:
          campaignRoleCoverage && campaignRoleCoverage.activeCampaigns > 0
            ? `${Math.round(
                (campaignRoleCoverage.classifiedCampaigns /
                  campaignRoleCoverage.activeCampaigns) *
                  100,
              )}%`
            : EM_DASH,
        status: campaignRoleCoverage
          ? campaignRoleCoverage.activeCampaigns === 0
            ? "no_active"
            : campaignRoleCoverage.unresolvedCampaigns > 0
              ? "unresolved"
              : "resolved"
          : "unavailable",
        activeCount: campaignRoleCoverage
          ? formatNumber(campaignRoleCoverage.activeCampaigns)
          : EM_DASH,
        unresolvedCount: campaignRoleCoverage
          ? formatNumber(campaignRoleCoverage.unresolvedCampaigns)
          : EM_DASH,
        actionAuthoritativeCount: campaignRoleCoverage
          ? finite(campaignRoleCoverage.actionAuthoritativeCampaigns) === null
            ? EM_DASH
            : formatNumber(campaignRoleCoverage.actionAuthoritativeCampaigns!)
          : EM_DASH,
      },
      mode: {
        value: nonBlank(workspace.pulse.operatingMode) ?? EM_DASH,
        chips: [
          {
            label: nonBlank(workspace.pulse.seasonalRegime) ?? EM_DASH,
            tone: "neutral",
          },
          {
            label: workspace.pulse.trackingHealth?.status
              ? workspace.pulse.trackingHealth.status === "healthy"
                ? "Tracking OK"
                : `Tracking ${titleToken(workspace.pulse.trackingHealth.status)}`
              : EM_DASH,
            tone:
              workspace.pulse.trackingHealth?.status === "healthy"
                ? "positive"
                : "warning",
          },
        ],
      },
    },
    actionRows: actionRows({
      recommendations: actionRecommendations,
      nodes,
      fallbackCurrency,
      selectedRecommendationId,
      callbacks,
    }),
    needsResolutionRows: needsResolutionRows({
      recommendations: blockedRecommendations,
      nodes,
      fallbackCurrency,
      selectedRecommendationId,
      callbacks,
    }),
    needsResolutionNotice: needsResolutionNotice(workspace),
    watchSegments: watchSegments(
      overrides.watchSegments ?? workspace.lanes.watchingSegments ?? [],
    ),
    watchingRows: watchingRows({
      recommendations: watchingRecommendations,
      nodes,
      fallbackCurrency,
      selectedRecommendationId,
      callbacks,
    }),
    healthyGroups: healthyGroups(healthy, fallbackCurrency),
    nonSales:
      nonSalesRecommendations.length > 0
        ? nonSalesRecommendations.map((recommendation) =>
            nonSalesCard(recommendation, fallbackCurrency),
          )
        : [nonSalesCard(null, fallbackCurrency)],
    archiveRows: archiveRows(archived, fallbackCurrency),
    creativesNotice: creativesNotice(workspace),
    // Not gated on the row count, by law. @see sourceProvenance
    sourceProvenance: sourceProvenance({
      workspace,
      shownCount: creativeDecisionRows.length,
    }),
    // The same envelope, said in the scope that draws the action buttons.
    // @see structureProvenance
    structureProvenance: structureProvenance(workspace),
    // Forwarded verbatim, never flattened into the fact list: each blocker code
    // must stay paired with its own sentence, which a fact list would separate.
    // Absent means the server sent no panel — never "nothing is blocking".
    budgetEvidence: workspace.system.budgetEvidence ?? null,
    // D085 — carried verbatim; the adapter derives nothing from it.
    budgetDryRun: workspace.system.budgetDryRun ?? null,
    creativePosture: creativePosture(workspace.os?.ads?.items ?? []),
    creativeDecisions: creativeDecisionRows,
    creativeGroups: creativeGroups({
      decisions: creativeDecisions,
      rows: creativeDecisionRows,
      statePreCapCounts: workspace.os?.ads?.statePreCapCounts,
    }),
    creativeFootnote: creativeFootnote(workspace.os?.ads?.items ?? []),
    inspector: inspector({
      provenance: inspectorProvenance(workspace),
      selection,
      selectableRecommendations: [
        ...actionRecommendations,
        // A blocked row is the one an operator most needs the evidence for.
        // Omitting it here would open its card onto an inspector that could not
        // find it and drew em dashes.
        ...blockedRecommendations,
        ...watchingRecommendations,
        ...nonSalesRecommendations,
      ],
      creativeDecisions,
      nodes,
      canonical,
      fallbackCurrency,
      callbacks,
    }),
  };
}
