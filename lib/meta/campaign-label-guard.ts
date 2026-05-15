import type { MetaCampaignKind, MetaCampaignLabel } from "@/lib/meta/campaign-label-types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export const META_CAMPAIGN_LABEL_GUARD_REASON = "unlabeled_campaign_soft_only";
export const META_CAMPAIGN_LABEL_CONFIDENCE_CAP = 0.45;

export type MetaCampaignLabelKindMap = ReadonlyMap<string, MetaCampaignKind>;

export interface MetaCampaignLabelGuardResult {
  recommendations: MetaRecommendation[];
  downgradedCount: number;
  unlabeledCampaignIds: string[];
  accountLevelDowngraded: boolean;
}

const HARD_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "adset_cut_spend",
  "budget_allocation",
  "scale_for_volume",
  "scale_for_profitability",
  "winner_promotion_flow",
  "bid_strategy_fit",
  "bid_value_guidance",
  "bid_band_from_history",
  "historical_bid_regime_fit",
  "scenario_a1_math_floor_unmet",
  "scenario_b1_capped_winner_bid_raise",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_b3_bid_cap_underperforming",
  "scenario_b4_min_roas_loosen",
  "scenario_b5_lowest_cost_volatility_switch",
  "scenario_c1_controlled_scale",
  "scenario_c3_scale_sample_gate",
  "scenario_d3_lal_compound_scale",
  "scenario_i1_abo_winner_budget_shift",
  "scenario_k2_peak_scale_ceiling",
  "scenario_k3_post_peak_taper",
]);

const ACCOUNT_LEVEL_HARD_TYPES = new Set<MetaRecommendation["type"]>([
  "budget_allocation",
  "winner_promotion_flow",
]);

export function buildMetaCampaignLabelKindMap(
  labels: Array<Pick<MetaCampaignLabel, "campaignId" | "kind">>,
): MetaCampaignLabelKindMap {
  return new Map(labels.map((label) => [label.campaignId, label.kind]));
}

export function hasMetaCampaignLabel(
  campaignId: string | null | undefined,
  labelMap: MetaCampaignLabelKindMap | null | undefined,
) {
  return Boolean(campaignId && labelMap?.has(campaignId));
}

function isAlreadyGuarded(rec: MetaRecommendation) {
  return rec.confidenceReason === META_CAMPAIGN_LABEL_GUARD_REASON;
}

function isHardAction(rec: MetaRecommendation) {
  if (rec.kind === "state" || rec.kind === "anomaly") return false;
  return HARD_ACTION_TYPES.has(rec.type);
}

function confidenceScore(rec: MetaRecommendation) {
  return typeof rec.confidenceScore === "number" && Number.isFinite(rec.confidenceScore)
    ? rec.confidenceScore
    : 0.85;
}

function campaignIdsForRec(
  rec: MetaRecommendation,
  activeCampaignIds: readonly string[],
): string[] {
  if (rec.level === "campaign" || rec.level === "adset") {
    return rec.campaignId ? [rec.campaignId] : [];
  }
  if (ACCOUNT_LEVEL_HARD_TYPES.has(rec.type)) {
    return [...activeCampaignIds];
  }
  return [];
}

function appendGuardEvidence(rec: MetaRecommendation): MetaRecommendation["evidence"] {
  const hasLabelEvidence = rec.evidence.some((item) => item.label === "Campaign label");
  const hasBlockedAction = rec.evidence.some((item) => item.label === "Blocked action");
  return [
    ...rec.evidence,
    ...(hasLabelEvidence
      ? []
      : [{ label: "Campaign label", value: "Missing", tone: "warning" as const }]),
    ...(hasBlockedAction
      ? []
      : [{ label: "Blocked action", value: rec.type, tone: "warning" as const }]),
  ];
}

function labelFirstSummary(rec: MetaRecommendation) {
  const subject = rec.campaignName ?? rec.adsetName ?? "This Meta entity";
  return `${subject} has a possible hard action, but Main/Test/Mixed campaign context is missing. Label the campaign before changing budgets, bids, or promotion flow.`;
}

function downgradeToSoftOnly(rec: MetaRecommendation): MetaRecommendation {
  const cappedScore = Math.min(confidenceScore(rec), META_CAMPAIGN_LABEL_CONFIDENCE_CAP);
  return {
    ...rec,
    kind: "state",
    decisionLabel: "diagnose",
    stateReason: "Campaign label is missing. The engine will not emit hard scale, cut, bid, or budget moves until the campaign is marked Main, Test, or Mixed.",
    decisionState: "watch",
    confidence: "low",
    confidenceScore: cappedScore,
    confidenceReason: META_CAMPAIGN_LABEL_GUARD_REASON,
    priority: rec.priority === "high" ? "medium" : rec.priority,
    decision: "Label campaign before hard action",
    title: `${rec.campaignName ?? rec.adsetName ?? "Campaign"}: label required before hard action`,
    why: `${rec.why} Campaign label is missing, so this hard action is capped to soft-only until Main/Test/Mixed context is set.`,
    summary: labelFirstSummary(rec),
    recommendedAction: "Label this campaign as Main, Test, or Mixed, then review the Meta recommendation again before changing budget, bids, or promotion flow.",
    expectedImpact: "Prevents the engine from treating Main and Test campaigns as interchangeable for hard actions.",
    evidence: appendGuardEvidence(rec),
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      quality_status: "missing_campaign_label",
      confidence_cap: META_CAMPAIGN_LABEL_GUARD_REASON,
      label_status: "unlabeled",
      blocked_action_type: rec.type,
      blocked_decision_state: rec.decisionState,
      blocked_confidence_score: rec.confidenceScore ?? null,
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      reason: META_CAMPAIGN_LABEL_GUARD_REASON,
    },
  };
}

export function applyMetaCampaignLabelGuard(input: {
  recommendations: MetaRecommendation[];
  campaignLabelsById: MetaCampaignLabelKindMap | null | undefined;
  activeCampaignIds?: readonly string[];
}): MetaCampaignLabelGuardResult {
  const labelMap = input.campaignLabelsById ?? new Map<string, MetaCampaignKind>();
  const activeCampaignIds = Array.from(new Set(input.activeCampaignIds ?? []));
  const unlabeledCampaignIds = new Set<string>();
  let downgradedCount = 0;
  let accountLevelDowngraded = false;

  const recommendations = input.recommendations.map((rec) => {
    if (isAlreadyGuarded(rec) || !isHardAction(rec)) return rec;

    const campaignIds = campaignIdsForRec(rec, activeCampaignIds);
    const isUnlabeled =
      campaignIds.length === 0 ||
      campaignIds.some((campaignId) => !hasMetaCampaignLabel(campaignId, labelMap));
    if (!isUnlabeled) return rec;

    downgradedCount += 1;
    if (rec.level === "account") accountLevelDowngraded = true;
    for (const campaignId of campaignIds) {
      if (!hasMetaCampaignLabel(campaignId, labelMap)) unlabeledCampaignIds.add(campaignId);
    }
    return downgradeToSoftOnly(rec);
  });

  return {
    recommendations,
    downgradedCount,
    unlabeledCampaignIds: Array.from(unlabeledCampaignIds).sort(),
    accountLevelDowngraded,
  };
}
