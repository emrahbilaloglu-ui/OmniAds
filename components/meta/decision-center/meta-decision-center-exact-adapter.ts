import type {
  MetaDecisionCenterExactActionRowViewModel,
  MetaDecisionCenterExactArchiveRowViewModel,
  MetaDecisionCenterExactCreativeDecisionViewModel,
  MetaDecisionCenterExactHealthyGroupViewModel,
  MetaDecisionCenterExactInspectorViewModel,
  MetaDecisionCenterExactNonSalesViewModel,
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
  MetaWatchingSegment,
} from "@/components/meta/redesign/types";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

const EM_DASH = "—";

const CREATIVE_POSTURE_SLOTS = [
  { id: "fatigued-spend-share", label: "Fatigued spend share", tone: "negative" },
  { id: "winner-concentration", label: "Winner concentration", tone: "warning" },
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

export interface MetaDecisionCenterExactAdapterOverrides {
  actionNow?: readonly MetaRecommendation[];
  watching?: readonly MetaRecommendation[];
  watchSegments?: readonly MetaWatchingSegment[];
  healthy?: readonly MetaHealthyEntity[];
  nonSales?: readonly MetaRecommendation[];
  archive?: readonly MetaArchivedEntity[];
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
  const symbol = code === "USD" ? "$" : code === "EUR" ? "€" : code === "TRY" ? "₺" : null;
  return symbol ? `${symbol}${formatNumber(amount)}` : `${code} ${formatNumber(amount)}`;
}

function formatRoas(value: number | null | undefined): string {
  const normalized = finite(value);
  return normalized === null ? EM_DASH : normalized.toFixed(2);
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

function targetRoasDisplay(
  value: number | null | undefined,
  freshness: MetaDecisionsWorkspacePayload["pulse"]["roas"]["targetFreshness"],
  source: MetaDecisionsWorkspacePayload["pulse"]["roas"]["target_source"],
): string {
  const formatted = formatRoas(value);
  if (formatted === EM_DASH || freshness === "fresh") return formatted;
  if (freshness === "stale") return `${formatted} · stale`;
  if (source === "account_median" || source === "none") return formatted;
  return `${formatted} · freshness unknown`;
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

function sparkPath(values: readonly number[] | null | undefined): string | null {
  if (!values || values.length < 2 || values.some((value) => finite(value) === null)) {
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

function timestamp(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
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

function decisionTone(value: string | null | undefined): MetaDecisionCenterExactTone {
  switch (value?.trim().toLowerCase()) {
    case "scale":
    case "protect":
      return "positive";
    case "cut":
    case "below_breakeven":
      return "negative";
    case "refresh":
    case "fatigue":
      return "automation";
    case "diagnose":
      return "warning";
    default:
      return "neutral";
  }
}

function actionTone(action: MetaOsDecisionAction | null): MetaDecisionCenterExactTone {
  if (!action) return "neutral";
  if (action.providerMutation === "pause") return "negative";
  if (action.providerMutation === "resume") return "positive";
  if (action.intent === "launchpad" || action.intent === "brief") return "automation";
  if (action.intent === "manual" || action.intent === "review") return "warning";
  return "neutral";
}

function confidenceTone(
  value: "high" | "medium" | "low" | "unknown" | null | undefined,
): MetaDecisionCenterExactTone {
  if (value === "high") return "positive";
  if (value === "medium") return "warning";
  return "neutral";
}

function segmentTone(value: string | null | undefined): MetaDecisionCenterExactTone {
  if (value === "learning") return "info";
  if (value === "mid_confidence" || value === "missing_target" || value === "issues") {
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
      ? titleToken(recommendation.campaignContext.kind)
      : null,
    nonBlank(recommendation.entityConfiguration?.status),
    nonBlank(recommendation.entityConfiguration?.optimizationGoal),
    nonBlank(recommendation.rowPresentation?.blockerLabel),
    nonBlank(recommendation.rowPresentation?.shieldLabel),
  ];
  return candidates.filter((value): value is string => Boolean(value)).slice(0, 3);
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

function defaultCanonicalDecisions(
  workspace: MetaDecisionsWorkspacePayload,
): MetaCanonicalDecision[] {
  const candidates = workspace.decisionReadModel?.queue?.adCandidates?.items;
  if (candidates) return [...candidates];
  const seen = new Set<string>();
  const decisions: MetaCanonicalDecision[] = [];
  for (const section of Object.values(
    workspace.decisionReadModel?.queue?.sections ?? {},
  )) {
    for (const decision of section.items) {
      const key = `${decision.decisionId}\u0000${decision.sourceSnapshotId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      decisions.push(decision);
    }
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
  const impact = nonBlank(node?.expectedImpact) ?? nonBlank(recommendation.expectedImpact);
  const parts = [target === null ? null : `vs ${target.toFixed(2)} target`, impact].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(" · ") : EM_DASH;
}

function actionRows(input: {
  recommendations: readonly MetaRecommendation[];
  nodes: ReadonlyMap<string, MetaOsStructureNode>;
  fallbackCurrency: string | null;
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactActionRowViewModel[] {
  return input.recommendations.map((recommendation) => {
    const node = input.nodes.get(recommendation.id) ?? null;
    const action = node?.action ?? null;
    const tone = decisionTone(recommendation.decisionLabel);
    return {
      id: recommendation.id,
      name: entityName(recommendation),
      level: structureLevel(recommendation.level),
      chips: structureChips(recommendation),
      decisionLabel:
        recommendation.decisionLabel != null
          ? titleToken(recommendation.decisionLabel)
          : nonBlank(node?.assessment) ?? nonBlank(recommendation.decision) ?? EM_DASH,
      decisionTone: tone,
      edgeTone: tone,
      money: recommendationMoney(recommendation, node, input.fallbackCurrency),
      moneySub: recommendationMoneySub(recommendation, node),
      confidence: titleToken(node?.confidence ?? recommendation.confidence),
      confidenceTone: confidenceTone(node?.confidence ?? recommendation.confidence),
      actionLabel: nonBlank(action?.label) ?? EM_DASH,
      actionTone: actionTone(action),
      ...(node && input.callbacks.onStructurePrimary
        ? {
            onPrimary: () =>
              input.callbacks.onStructurePrimary?.(recommendation, node.action),
          }
        : {}),
      ...(input.callbacks.onStructureMenu
        ? {
            onMenu: () => input.callbacks.onStructureMenu?.(recommendation),
          }
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
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactWatchingRowViewModel[] {
  return input.recommendations.map((recommendation) => {
    const node = input.nodes.get(recommendation.id) ?? null;
    return {
      id: recommendation.id,
      segment: recommendation.watchSegment
        ? titleToken(recommendation.watchSegment)
        : EM_DASH,
      segmentTone: segmentTone(recommendation.watchSegment),
      name: entityName(recommendation),
      level: structureLevel(recommendation.level),
      note:
        nonBlank(node?.whyNow) ??
        nonBlank(recommendation.why) ??
        nonBlank(recommendation.summary) ??
        EM_DASH,
      money: recommendationMoney(recommendation, node, input.fallbackCurrency),
      ...(input.callbacks.onWatchingReview
        ? {
            onReview: () => input.callbacks.onWatchingReview?.(recommendation),
          }
        : {}),
    };
  });
}

function healthyStrategy(entity: MetaHealthyEntity | null | undefined): string {
  return (
    nonBlank(entity?.bidStrategyLabel) ??
    (entity?.bidStrategyType ? titleToken(entity.bidStrategyType) : null) ??
    EM_DASH
  );
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
    const id = row.level === "campaign" ? row.campaignId ?? row.id : row.campaignId ?? `adset:${row.id}`;
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
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
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

function archiveRows(
  rows: readonly MetaArchivedEntity[],
  fallbackCurrency: string | null,
): MetaDecisionCenterExactArchiveRowViewModel[] {
  return rows.map((row) => {
    const paused = row.status.trim().toUpperCase() === "PAUSED";
    return {
      id: row.id,
      name: nonBlank(row.name) ?? EM_DASH,
      status: nonBlank(row.statusLabel) ?? nonBlank(row.status) ?? EM_DASH,
      statusTone: paused ? "warning" : "neutral",
      spend: formatMoney(row.spend, fallbackCurrency),
      note:
        nonBlank(row.diagnosticNote) ?? nonBlank(row.advisory?.why) ?? EM_DASH,
      // No Resume affordance. The archive lane is evidence: `MetaArchivedEntity`
      // carries no action tuple and the canonical inactive asset pins
      // `providerWriteAuthority: "none"`, so there is no callback to give the
      // button. Drawing it anyway produced a permanently dimmed control on every
      // paused row — a promise the screen could never keep. The component still
      // renders it the moment a server action tuple supplies one.
    };
  });
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
    const review = input.callbacks.onCreativeReview
      ? () => input.callbacks.onCreativeReview?.(decision, canonicalDecision)
      : null;
    const tone = decisionTone(decision.publishedLabel);
    return {
      id: decision.id,
      name: nonBlank(decision.adName) ?? EM_DASH,
      kindShort: creativeKindShort(decision.creativeFormat),
      // The reference's thumb is a neutral striped placeholder. Colouring it by
      // verdict would let the strip read as a second opinion beside the label
      // that already carries the tone, so it keeps the design's default pair.
      stripeA: null,
      stripeB: null,
      edgeTone: tone,
      decisionLabel: nonBlank(decision.action.label) ?? EM_DASH,
      decisionTone: tone,
      chips: creativeChips(decision),
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

function metricEvidence(input: {
  spend: number | null | undefined;
  purchases: number | null | undefined;
  snapshot: string | null | undefined;
  lifecycle: string | null | undefined;
  currency: string | null;
}): NonNullable<MetaDecisionCenterExactInspectorViewModel["evidence"]> {
  return [
    { id: "spend", label: "Spend · 28d", value: formatMoney(input.spend, input.currency) },
    {
      id: "purchases",
      label: "Purchases · 28d",
      value: finite(input.purchases) ?? EM_DASH,
    },
    { id: "snapshot", label: "Snapshot", value: nonBlank(input.snapshot) ?? EM_DASH },
    { id: "lifecycle", label: "Lifecycle", value: titleToken(input.lifecycle) },
  ];
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
  const readinessParts = [
    nonBlank(readiness?.tier),
    nonBlank(readiness?.reason),
  ].filter((value): value is string => Boolean(value));
  const blockerParts = [
    ...(readiness?.blockers ?? []),
    ...(readiness?.missingEvidence ?? []),
  ]
    .map(nonBlank)
    .filter((value): value is string => Boolean(value));
  return {
    entityName: entityName(recommendation),
    entityMeta: `${structureLevel(recommendation.level).toLowerCase()} · ${
      nonBlank(recommendation.campaignName) ?? EM_DASH
    }`,
    decisionLabel:
      nonBlank(action?.label) ??
      (recommendation.decisionLabel ? titleToken(recommendation.decisionLabel) : EM_DASH),
    tone: decisionTone(recommendation.decisionLabel),
    serverVerdict: nonBlank(action?.label) ?? nonBlank(recommendation.decision) ?? EM_DASH,
    contractDetail: nonBlank(action?.scopeNote) ?? EM_DASH,
    reasons: [
      nonBlank(node?.whyNow) ?? nonBlank(recommendation.why) ?? EM_DASH,
    ],
    moneyValue: recommendationMoney(recommendation, node, input.fallbackCurrency),
    targetComparison:
      targetRoas === null ? EM_DASH : `vs ${targetRoas.toFixed(2)} target`,
    // This entity's own ROAS trail, which the server has been attaching to every
    // recommendation all along. The chart was pinned to null, so the panel drew
    // its dashed target baseline and nothing against it. Deliberately not the
    // account's `pulse.roasHistory`: that is a different entity's line and would
    // read as this one's.
    moneySparkPath: sparkPath(recommendation.evidenceTrail?.roas_history),
    moneyDetail:
      nonBlank(node?.expectedImpact) ?? nonBlank(recommendation.expectedImpact) ?? EM_DASH,
    confidence: titleToken(node?.confidence ?? recommendation.confidence),
    readiness: readinessParts.length > 0 ? readinessParts.join(" · ") : EM_DASH,
    blockers: blockerParts.length > 0 ? blockerParts.join(" · ") : EM_DASH,
    blockerTone: blockerParts.length > 0 ? "warning" : "neutral",
    evidence: (node?.evidence ?? []).map((item, index) => ({
      id: `structure-evidence-${index}`,
      label: nonBlank(item.label) ?? EM_DASH,
      value: nonBlank(item.value) ?? EM_DASH,
    })),
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
  const blockers = decision.blockers.map((blocker) => blocker.label).filter(Boolean);
  const targetRoas = finite(decision.metrics.effectiveTargetRoas);
  return {
    entityName: nonBlank(decision.adName) ?? EM_DASH,
    entityMeta: [decision.campaignName, decision.adsetName]
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

function inspector(input: {
  selection: MetaDecisionCenterExactAdapterSelection | undefined;
  actionRecommendations: readonly MetaRecommendation[];
  /**
   * Every structure row the inspector may be pointed at.
   *
   * Selection used to resolve against Action Now alone, so a Watching row's
   * "Review" produced a selection the inspector could not find and returned
   * null. The default selection still comes from Action Now — the reference's
   * resting state — but an explicit one resolves across the lanes.
   */
  selectableRecommendations: readonly MetaRecommendation[];
  creativeDecisions: readonly MetaOsAdDecision[];
  nodes: ReadonlyMap<string, MetaOsStructureNode>;
  canonical: ReadonlyMap<string, MetaCanonicalDecision>;
  fallbackCurrency: string | null;
  callbacks: MetaDecisionCenterExactAdapterCallbacks;
}): MetaDecisionCenterExactInspectorViewModel | null {
  const selection =
    input.selection === undefined
      ? input.actionRecommendations[0]
        ? {
            kind: "structure" as const,
            recommendationId: input.actionRecommendations[0].id,
          }
        : null
      : input.selection;
  if (!selection) return null;

  if (selection.kind === "structure") {
    const recommendation = input.selectableRecommendations.find(
      (item) => item.id === selection.recommendationId,
    );
    if (!recommendation) return null;
    return structureInspector({
      recommendation,
      node: input.nodes.get(recommendation.id) ?? null,
      fallbackCurrency: input.fallbackCurrency,
      callback: input.callbacks.onStructurePrimary,
    });
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
  return creativeInspector({
    decision,
    canonicalDecision,
    fallbackCurrency: input.fallbackCurrency,
    callback: input.callbacks.onCreativeReview,
  });
}

/**
 * Why the Creatives scope is empty, in the server's own words.
 *
 * An empty queue and a refused decision source render identically — nothing —
 * and only one of them is something the operator can act on. When the native ad
 * source is not the authority, the payload already carries both the machine
 * reason and a written limitation; this joins them rather than composing a new
 * sentence, so the screen cannot claim a cause the server did not give.
 *
 * Returns null when the source is healthy: an account that genuinely has no
 * actionable creative decision today needs no explanation beyond the empty
 * queue itself.
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
    input.account && (!providerAccountId || input.account.id === providerAccountId)
      ? input.account
      : null;
  const fallbackCurrency =
    currencyCode(scopedAccount?.currency) ?? currencyCode(workspace.system.currency);
  const actionRecommendations = overrides.actionNow ?? workspace.lanes.actionNow;
  const watchingRecommendations = overrides.watching ?? workspace.lanes.watching;
  const healthy = overrides.healthy ?? workspace.lanes.healthy;
  const nonSales = overrides.nonSales ?? workspace.lanes.nonSales;
  const archived = overrides.archive ?? workspace.lanes.archive;
  const creativeDecisions = overrides.creatives ?? workspace.os?.ads?.items ?? [];
  const canonicalDecisions =
    overrides.canonicalDecisions ?? defaultCanonicalDecisions(workspace);
  const nodes = structureNodesByRecommendationId(workspace);
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
  const labelCoverage = workspace.pulse.labelCoverage;
  const pacing = workspace.pulse.pacing;
  const syncAge = relativeAge(workspace.pulse.lastSyncAt, input.now);

  return {
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
      engineLabel: engineVersion ? `engine ${engineVersion}` : `engine ${EM_DASH}`,
      timeLabel: utcTime(workspace.decisionReadModel.source.computedAt),
    },
    activeWindow: activeWindow(workspace.window),
    counts: {
      structure: workspace.lanes.counts.actionNow,
      creatives: finite(workspace.os?.ads?.actCount) ?? EM_DASH,
      action: workspace.lanes.counts.actionNow,
      watching: workspace.lanes.counts.watching,
      healthy: workspace.lanes.counts.healthy,
      nonsales: workspace.lanes.counts.nonSales,
      archive: workspace.lanes.counts.archive,
      deferred:
        finite(overrides.deferredCount) ?? workspace.lanes.deferredIds.length,
    },
    kpis: {
      spend: {
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
        detail: [
          engineVersion ? `engine ${engineVersion}` : null,
          syncAge ? `synced ${syncAge}` : null,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" · ") || EM_DASH,
      },
      labels: {
        coverage: labelCoverage
          ? `${labelCoverage.labeledCampaigns}/${labelCoverage.activeCampaigns}`
          : EM_DASH,
        percentage:
          labelCoverage && labelCoverage.activeCampaigns > 0
            ? `${Math.round(
                (labelCoverage.labeledCampaigns / labelCoverage.activeCampaigns) * 100,
              )}%`
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
      callbacks,
    }),
    watchSegments: watchSegments(
      overrides.watchSegments ?? workspace.lanes.watchingSegments ?? [],
    ),
    watchingRows: watchingRows({
      recommendations: watchingRecommendations,
      nodes,
      fallbackCurrency,
      callbacks,
    }),
    healthyGroups: healthyGroups(healthy, fallbackCurrency),
    nonSales:
      nonSales.length > 0
        ? nonSales.map((recommendation) =>
            nonSalesCard(recommendation, fallbackCurrency),
          )
        : [nonSalesCard(null, fallbackCurrency)],
    archiveRows: archiveRows(archived, fallbackCurrency),
    creativesNotice: creativesNotice(workspace),
    creativePosture: creativePosture(workspace.os?.ads?.items ?? []),
    creativeDecisions: creativeRows({
      decisions: creativeDecisions,
      canonical,
      fallbackCurrency,
      ctrSeriesByAdId: overrides.creativeCtrSeriesByAdId ?? new Map(),
      callbacks,
    }),
    inspector: inspector({
      selection: input.selection,
      actionRecommendations,
      selectableRecommendations: [
        ...actionRecommendations,
        ...watchingRecommendations,
        ...nonSales,
      ],
      creativeDecisions,
      nodes,
      canonical,
      fallbackCurrency,
      callbacks,
    }),
  };
}
