import type {
  MetaAdSetDecision,
  MetaCampaignDecision,
  MetaDecisionOsV1Response,
} from "@/lib/meta/decision-os";
import { buildOperatorInstruction } from "@/lib/operator-prescription";
import {
  buildOperatorBuckets,
  operatorConfidenceBand,
  titleFromEnum,
  type OperatorAuthorityState,
  type OperatorSurfaceItem,
  type OperatorSurfaceMetric,
  type OperatorSurfaceModel,
} from "@/lib/operator-surface";
import type {
  OperatorInstructionAmountGuidance,
  OperatorDecisionProvenance,
  OperatorPolicyAssessment,
  OperatorPolicyState,
} from "@/src/types/operator-decision";

type MetaOperatorItem = OperatorSurfaceItem & {
  campaignId: string;
};

export interface MetaCampaignOperatorSummary {
  campaignId: string;
  ownerType: "campaign" | "ad_set";
  ownerLabel: string;
  item: OperatorSurfaceItem;
}

const META_OPERATOR_STATE_ORDER: Record<OperatorAuthorityState, number> = {
  act_now: 0,
  needs_truth: 1,
  blocked: 2,
  watch: 3,
  no_action: 4,
};

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  })}`;
}

function formatMoneyCanonical(value: number) {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

function formatRatio(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)}x`;
}

function formatInteger(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString();
}

function metaRegimeLabel(value: string | null | undefined) {
  if (!value) return null;
  if (value === "open") return "Lowest Cost";
  if (value === "cost_cap") return "Cost Cap";
  if (value === "bid_cap") return "Bid Cap";
  if (value === "roas_floor") return "Target ROAS";
  return titleFromEnum(value);
}

function isMetaMuted(decision: { trust: MetaAdSetDecision["trust"] | MetaCampaignDecision["trust"] }) {
  const materiality = decision.trust.evidence?.materiality;
  return materiality === "thin_signal" || materiality === "immaterial" || decision.trust.operatorDisposition === "archive_only";
}

function metaAuthorityState(
  decision: Pick<MetaAdSetDecision, "actionType" | "noTouch" | "trust"> | Pick<MetaCampaignDecision, "primaryAction" | "noTouch" | "trust">,
) {
  if (decision.trust.operatorDisposition === "profitable_truth_capped") {
    return "needs_truth" satisfies OperatorAuthorityState;
  }
  if (decision.noTouch || decision.trust.operatorDisposition === "protected_watchlist") {
    return "no_action" satisfies OperatorAuthorityState;
  }

  const action = "actionType" in decision ? decision.actionType : decision.primaryAction;
  if (action === "monitor_only" || action === "hold") {
    return "watch" satisfies OperatorAuthorityState;
  }
  if (decision.trust.surfaceLane === "action_core") {
    return "act_now" satisfies OperatorAuthorityState;
  }
  return "watch" satisfies OperatorAuthorityState;
}

function metaReasonOverride(
  reason: string,
  state: OperatorAuthorityState,
  muted: boolean,
  blocker: string | null,
) {
  if (state === "needs_truth" && blocker) {
    return `Profitable, but ${blocker.charAt(0).toLowerCase()}${blocker.slice(1)}`;
  }
  if (muted) {
    return "Signal is still too thin for a headline move, so the right call is to wait.";
  }
  return reason;
}

function metaActionLabel(
  input: {
    state: OperatorAuthorityState;
    action: string;
    bidRegime: string | null | undefined;
    noTouch: boolean;
    missingCreativeAsk?: string[] | null;
    primaryDriver?: string | null;
  },
) {
  if (input.state === "needs_truth") return "Needs truth";
  if (input.noTouch) return "Do not touch";
  if (
    input.primaryDriver === "creative_fatigue" ||
    (input.missingCreativeAsk?.length &&
      input.action !== "scale_budget" &&
      input.action !== "reduce_budget")
  ) {
    return "Refresh creative";
  }
  if (input.action === "pause") return "Pause";
  if (input.action === "scale_budget" || input.action === "recover") return "Increase budget";
  if (input.action === "reduce_budget") return "Reduce budget";
  if (input.action === "tighten_bid") {
    if (input.bidRegime === "cost_cap") return "Review cost cap";
    if (input.bidRegime === "bid_cap") return "Review bid cap";
    if (input.bidRegime === "roas_floor") return "Review target ROAS";
    return "Review bid control";
  }
  if (input.action === "monitor_only" || input.action === "hold") return "Wait";
  if (
    input.action === "rebuild" ||
    input.action === "duplicate_to_new_geo_cluster" ||
    input.action === "merge_into_pooled_geo" ||
    input.action === "switch_optimization" ||
    input.action === "broaden"
  ) {
    return "Change structure";
  }
  return titleFromEnum(input.action);
}

function metaBlockerFromTrust(
  trust: MetaAdSetDecision["trust"] | MetaCampaignDecision["trust"],
  fallback: string | null | undefined,
  state: OperatorAuthorityState,
) {
  if (state === "needs_truth") {
    return (
      trust.evidence?.aggressiveActionBlockReasons?.[0] ??
      trust.reasons.find((reason) => reason.toLowerCase().includes("truth")) ??
      trust.reasons.find((reason) => reason.toLowerCase().includes("commercial")) ??
      fallback ??
      "Missing commercial truth is capping a stronger move."
    );
  }
  if (trust.evidence?.materiality === "thin_signal") {
    return "Wait for more spend and conversion signal before changing the lever.";
  }
  return fallback ?? null;
}

function compactMetrics(metrics: OperatorSurfaceMetric[]) {
  return metrics.filter((metric) => Boolean(metric.value) && metric.value !== "n/a").slice(0, 5);
}

function uniqueText(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function metaBudgetAmountGuidance(input: {
  decision: MetaAdSetDecision;
  policy: OperatorPolicyAssessment | null;
  authorityState: OperatorAuthorityState;
}): OperatorInstructionAmountGuidance | null {
  if (input.authorityState !== "act_now" || input.policy?.state !== "do_now") {
    return null;
  }
  const action = input.decision.actionType;
  if (action !== "scale_budget" && action !== "recover" && action !== "reduce_budget") {
    return null;
  }
  const dailyBudgetCents = input.decision.supportingMetrics.dailyBudget;
  if (!dailyBudgetCents || !Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) {
    return {
      status: "unavailable",
      label: "Budget amount unavailable",
      reason:
        "Current daily budget is not available, so the system cannot calculate a bounded budget band.",
    };
  }

  const currentDailyBudget = dailyBudgetCents / 100;
  const increase = action === "scale_budget" || action === "recover";
  const lower = increase ? currentDailyBudget * 1.1 : currentDailyBudget * 0.8;
  const upper = increase ? currentDailyBudget * 1.2 : currentDailyBudget * 0.9;
  const label = increase
    ? `Review +10-20% budget band: ${formatMoneyCanonical(lower)}-${formatMoneyCanonical(upper)}/day`
    : `Review -10-20% budget band: ${formatMoneyCanonical(lower)}-${formatMoneyCanonical(upper)}/day`;

  return {
    status: "bounded_estimate",
    label,
    reason:
      "Bounded from the current daily budget only; execution preview or operator review must confirm the final account change.",
    assumptions: [
      "Current daily budget is present on the source row.",
      "No budget utilization or pacing ratio is available in this contract.",
      "The band does not override policy, queue, or apply gates.",
    ],
  };
}

function instructionPolicyForMetaAuthority(input: {
  policy: OperatorPolicyAssessment | null | undefined;
  authorityState: OperatorAuthorityState;
  blocker: string | null;
}) {
  const policy = input.policy ?? null;
  if (!policy || input.authorityState === "act_now") return policy;

  const state: OperatorPolicyState =
    input.authorityState === "no_action"
      ? "do_not_touch"
      : input.authorityState === "watch"
        ? "watch"
        : input.authorityState === "needs_truth" || input.authorityState === "blocked"
          ? "blocked"
          : "contextual_only";

  return {
    ...policy,
    state,
    pushReadiness:
      state === "watch"
        ? "operator_review_required"
        : "blocked_from_push",
    queueEligible: false,
    canApply: false,
    blockers: uniqueText([input.blocker, ...policy.blockers]),
  } satisfies OperatorPolicyAssessment;
}

export function buildMetaOperatorItemFromAdSet(decision: MetaAdSetDecision): OperatorSurfaceItem {
  const authorityState = metaAuthorityState(decision);
  const muted = isMetaMuted(decision);
  const blocker = metaBlockerFromTrust(decision.trust, decision.guardrails[0], authorityState);
  const reason = metaReasonOverride(decision.reasons[0] ?? "Operator review required.", authorityState, muted, blocker);
  const actionLabel = metaActionLabel({
    state: authorityState,
    action: decision.actionType,
    bidRegime: decision.policy.bidRegime,
    noTouch: decision.noTouch,
    missingCreativeAsk: decision.missingCreativeAsk,
    primaryDriver: decision.policy.primaryDriver,
  });
  const provenance =
    (decision as { provenance?: OperatorDecisionProvenance | null }).provenance ?? null;
  const instructionPolicy = instructionPolicyForMetaAuthority({
    policy: decision.operatorPolicy ?? null,
    authorityState,
    blocker,
  });

  return {
    id: `adset:${decision.decisionId}`,
    title: decision.adSetName,
    subtitle: decision.campaignName,
    primaryAction: actionLabel,
    authorityState,
    reason,
    blocker,
    confidence: operatorConfidenceBand(decision.confidence),
    secondaryLabels: [metaRegimeLabel(decision.policy.bidRegime), decision.policy.objectiveFamily ? titleFromEnum(decision.policy.objectiveFamily) : null].filter(Boolean) as string[],
    metrics: compactMetrics([
      { label: "Spend", value: formatMoney(decision.supportingMetrics.spend) },
      { label: "ROAS", value: formatRatio(decision.supportingMetrics.roas) },
      { label: "Purchases", value: formatInteger(decision.supportingMetrics.purchases) },
      { label: "CPA", value: formatMoney(decision.supportingMetrics.cpa) },
      decision.supportingMetrics.dailyBudget
        ? { label: "Budget", value: formatMoney(decision.supportingMetrics.dailyBudget / 100) }
        : { label: "Budget", value: "n/a" },
    ]),
    muted,
    mutedReason: muted ? "Thin-signal or inactive ad sets stay out of the headline action stack." : null,
    instruction: buildOperatorInstruction({
      sourceSystem: "meta",
      sourceLabel: "Meta Decision OS",
      policy: instructionPolicy,
      targetScope: "adset",
      targetEntity: decision.adSetName,
      parentEntity: decision.campaignName,
      actionLabel,
      reason,
      blocker,
      confidenceScore: decision.confidence,
      trustState: decision.trust.truthState,
      operatorDisposition: decision.trust.operatorDisposition,
      provenance,
      amountGuidance: metaBudgetAmountGuidance({
        decision,
        policy: instructionPolicy,
        authorityState,
      }),
      nextObservation: [
        ...(decision.whatWouldChangeThisDecision ?? []),
        ...decision.guardrails,
        ...(decision.missingCreativeAsk ?? []),
      ],
      invalidActions:
        decision.policy.primaryDriver === "creative_fatigue"
          ? ["Do not increase budget before the creative bottleneck is reviewed."]
          : [],
    }),
  };
}

export function buildMetaOperatorItemFromCampaign(decision: MetaCampaignDecision): OperatorSurfaceItem {
  const authorityState = metaAuthorityState(decision);
  const muted = isMetaMuted(decision);
  const blocker = metaBlockerFromTrust(
    decision.trust,
    decision.guardrails[0] ?? decision.whatWouldChangeThisDecision[0],
    authorityState,
  );
  const reason = metaReasonOverride(decision.why, authorityState, muted, blocker);
  const actionLabel = metaActionLabel({
    state: authorityState,
    action: decision.primaryAction,
    bidRegime: decision.policy.bidRegime,
    noTouch: decision.noTouch,
    missingCreativeAsk: decision.missingCreativeAsk,
    primaryDriver: decision.policy.primaryDriver,
  });
  const provenance =
    (decision as { provenance?: OperatorDecisionProvenance | null }).provenance ?? null;

  return {
    id: `campaign:${decision.campaignId}`,
    title: decision.campaignName,
    subtitle: decision.role,
    primaryAction: actionLabel,
    authorityState,
    reason,
    blocker,
    confidence: operatorConfidenceBand(decision.confidence),
    secondaryLabels: [metaRegimeLabel(decision.policy.bidRegime), decision.laneLabel].filter(Boolean) as string[],
    metrics: compactMetrics(
      decision.evidence
        .filter((item) => item.label === "ROAS" || item.label === "Spend" || item.label === "Role confidence")
        .map((item) => ({ label: item.label, value: item.value })),
    ),
    muted,
    mutedReason: muted ? "Thin-signal or inactive campaigns stay out of the headline action stack." : null,
    instruction: buildOperatorInstruction({
      sourceSystem: "meta",
      sourceLabel: "Meta Decision OS",
      policy: instructionPolicyForMetaAuthority({
        policy: decision.operatorPolicy ?? null,
        authorityState,
        blocker,
      }),
      targetScope: "campaign",
      targetEntity: decision.campaignName,
      parentEntity: decision.role,
      actionLabel,
      reason,
      blocker,
      confidenceScore: decision.confidence,
      trustState: decision.trust.truthState,
      operatorDisposition: decision.trust.operatorDisposition,
      provenance,
      nextObservation: [
        ...(decision.whatWouldChangeThisDecision ?? []),
        ...decision.guardrails,
        ...(decision.missingCreativeAsk ?? []),
      ],
      invalidActions:
        decision.policy.primaryDriver === "creative_fatigue"
          ? ["Do not treat this as a budget problem until creative fatigue is reviewed."]
          : [],
    }),
  };
}

function compareMetaOperatorItems(left: MetaOperatorItem, right: MetaOperatorItem) {
  return META_OPERATOR_STATE_ORDER[left.authorityState] - META_OPERATOR_STATE_ORDER[right.authorityState];
}

export function buildMetaCampaignOperatorLookup(
  decisionOs: MetaDecisionOsV1Response | null | undefined,
) {
  const lookup = new Map<string, MetaCampaignOperatorSummary>();
  if (!decisionOs) return lookup;

  const adSetItems = decisionOs.adSets.map((decision) => ({
    campaignId: decision.campaignId,
    ownerType: "ad_set" as const,
    ownerLabel: decision.adSetName,
    item: buildMetaOperatorItemFromAdSet(decision),
  }));
  const campaignItems = decisionOs.campaigns.map((decision) => ({
    campaignId: decision.campaignId,
    ownerType: "campaign" as const,
    ownerLabel: decision.role,
    item: buildMetaOperatorItemFromCampaign(decision),
  }));
  const campaignIds = new Set<string>([
    ...adSetItems.map((entry) => entry.campaignId),
    ...campaignItems.map((entry) => entry.campaignId),
  ]);

  for (const campaignId of campaignIds) {
    const visibleAdSet = adSetItems
      .filter((entry) => entry.campaignId === campaignId && !entry.item.muted)
      .sort((left, right) =>
        compareMetaOperatorItems(
          { campaignId: left.campaignId, ...left.item },
          { campaignId: right.campaignId, ...right.item },
        ),
      )[0];
    const campaignItem = campaignItems.find((entry) => entry.campaignId === campaignId);
    const mutedAdSet = adSetItems.find((entry) => entry.campaignId === campaignId);
    const selected = visibleAdSet ?? campaignItem ?? mutedAdSet;
    if (!selected) continue;
    lookup.set(campaignId, {
      campaignId,
      ownerType: selected.ownerType,
      ownerLabel: selected.ownerLabel,
      item: selected.item,
    });
  }

  return lookup;
}

export function buildMetaOperatorSurfaceModel(
  decisionOs: MetaDecisionOsV1Response | null | undefined,
): OperatorSurfaceModel | null {
  if (!decisionOs) return null;

  const adSetItems = decisionOs.adSets.map((decision) => ({
    campaignId: decision.campaignId,
    ...buildMetaOperatorItemFromAdSet(decision),
  })) satisfies MetaOperatorItem[];
  const campaignIdsWithVisibleAdSets = new Set(
    adSetItems.filter((item) => !item.muted).map((item) => item.campaignId),
  );
  const campaignItems = decisionOs.campaigns
    .filter((decision) => !campaignIdsWithVisibleAdSets.has(decision.campaignId))
    .map((decision) => ({
      campaignId: decision.campaignId,
      ...buildMetaOperatorItemFromCampaign(decision),
    })) satisfies MetaOperatorItem[];

  const items = [...adSetItems, ...campaignItems]
    .sort(compareMetaOperatorItems)
    .map(({ campaignId: _campaignId, ...item }) => item);

  const buckets = buildOperatorBuckets(items, {
    labels: {
      act_now: "Act now",
      needs_truth: "Profitable but capped",
      watch: "Watch / wait",
      no_action: "Do not touch",
    },
    summaries: {
      act_now: "The first lever is explicit enough to move on today.",
      needs_truth: "Profitable rows that still need truth or regime clearance before a stronger move.",
      watch: "Visible rows where the right action is restraint until signal, cooldown, or readiness changes.",
      no_action: "Stable or protected rows where touching them would create unnecessary risk.",
    },
    order: ["act_now", "needs_truth", "watch", "no_action"],
  });

  const visibleCounts = {
    actNow: buckets.find((bucket) => bucket.key === "act_now")?.rows.length ?? 0,
    needsTruth: buckets.find((bucket) => bucket.key === "needs_truth")?.rows.length ?? 0,
    watch: buckets.find((bucket) => bucket.key === "watch")?.rows.length ?? 0,
    protected: buckets.find((bucket) => bucket.key === "no_action")?.rows.length ?? 0,
  };
  const mutedCount = buckets.reduce((sum, bucket) => sum + bucket.mutedCount, 0);
  const firstMissingInput = decisionOs.authority?.missingInputs[0] ?? decisionOs.commercialTruthCoverage.missingInputs[0] ?? null;

  let emphasis: OperatorAuthorityState = "no_action";
  let headline = "No material Meta change is recommended right now.";
  if (visibleCounts.actNow > 0) {
    emphasis = "act_now";
    headline = `${visibleCounts.actNow} material Meta ${visibleCounts.actNow === 1 ? "move needs" : "moves need"} action now.`;
  } else if (visibleCounts.needsTruth > 0) {
    emphasis = "needs_truth";
    headline = `${visibleCounts.needsTruth} profitable Meta ${visibleCounts.needsTruth === 1 ? "lane is" : "lanes are"} capped by missing truth or regime clearance.`;
  } else if (visibleCounts.watch > 0) {
    emphasis = "watch";
    headline = `${visibleCounts.watch} Meta ${visibleCounts.watch === 1 ? "lane stays" : "lanes stay"} visible, but the next move is still signal-capped.`;
  } else if (visibleCounts.protected > 0) {
    headline = `${visibleCounts.protected} Meta ${visibleCounts.protected === 1 ? "winner stays" : "winners stay"} protected with no change recommended.`;
  }

  return {
    surfaceLabel: "Meta",
    heading: "Daily Operator Surface",
    headline,
    note:
      decisionOs.authority?.note ??
      decisionOs.summary.todayPlanHeadline ??
      "Meta decisions use live windows. Selected range remains analysis-only context.",
    emphasis,
    blocker:
      emphasis === "needs_truth" && firstMissingInput
        ? `Missing input: ${titleFromEnum(firstMissingInput)}`
        : null,
    buckets,
    hiddenSummary:
      mutedCount > 0
        ? `${mutedCount} thin-signal or inactive ${mutedCount === 1 ? "row stays" : "rows stay"} off the headline action surface.`
        : null,
  };
}
