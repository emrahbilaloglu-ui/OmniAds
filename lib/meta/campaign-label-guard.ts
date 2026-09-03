import type { MetaCampaignKind, MetaCampaignLabel } from "@/lib/meta/campaign-label-types";
import type {
  MetaDecisionLabel,
  MetaRecommendation,
  MetaRecommendationType,
} from "@/lib/meta/recommendations";
import { withMetaAutomationReadiness } from "@/lib/meta/automation-readiness";

/** @deprecated pre-D074b reason; recognition-only for persisted payloads. */
export const META_CAMPAIGN_LABEL_GUARD_REASON = "unlabeled_campaign_soft_only";
export const META_CAMPAIGN_LABEL_CONFIDENCE_CAP = 0.45;
export const META_TEST_REFRESH_TO_CUT_REASON = "test_refresh_to_cut";
export const META_TEST_SCALE_TO_PROMOTE_REASON = "test_scale_to_promote_main";
export const META_AUTOMATIC_CONTEXT_REVIEW_REASON =
  "automatic_campaign_context_review_only";
export const META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON =
  "automatic_campaign_context_resolver_unvalidated";

export interface MetaCampaignContextGuardEntry {
  kind: MetaCampaignKind | null;
  contextTrust: "override" | "high" | "medium" | "low" | "unknown" | "conflict";
  source: "legacy_label" | "user_override" | "system_inferred" | "unknown";
  inferenceConfidenceClass?:
    | "high"
    | "medium"
    | "low"
    | "unknown"
    | "conflict";
  resolverAuthorityValidated?: boolean;
}

export type MetaCampaignContextGuardMap = ReadonlyMap<
  string,
  MetaCampaignContextGuardEntry
>;

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
  "scenario_g1_upper_funnel_event",
  "scenario_g2_downshift_to_purchase",
  "scenario_i1_abo_winner_budget_shift",
  "scenario_k2_peak_scale_ceiling",
  "scenario_k3_post_peak_taper",
]);

const ACCOUNT_LEVEL_HARD_TYPES = new Set<MetaRecommendation["type"]>([
  "budget_allocation",
  "winner_promotion_flow",
]);

const REFRESH_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "scenario_e1_frequency_fatigue",
  "scenario_e2_ctr_decay_refresh",
  "scenario_e3_frequency_p80_fatigue",
  "scenario_e4_creative_age_refresh",
  "scenario_m4_mid_funnel_refresh",
  "scenario_l4_lead_refresh",
  "scenario_t4_traffic_refresh",
  "scenario_eg4_engagement_refresh",
]);

const SCALE_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "scale_for_volume",
  "scale_for_profitability",
  "winner_promotion_flow",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_c1_controlled_scale",
  "scenario_d3_lal_compound_scale",
  "scenario_k2_peak_scale_ceiling",
  "scenario_m1_mid_funnel_efficient_scale",
  "scenario_l1_lead_efficient_scale",
  "scenario_t1_traffic_efficient_scale",
  "scenario_eg1_engagement_efficient_scale",
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

function isAlreadyLabelTransformed(rec: MetaRecommendation) {
  return Boolean(rec.labelTransform);
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

function campaignKindForRec(
  rec: MetaRecommendation,
  labelMap: MetaCampaignLabelKindMap,
  activeCampaignIds: readonly string[],
): MetaCampaignKind | null {
  const campaignIds = campaignIdsForRec(rec, activeCampaignIds);
  if (campaignIds.length === 0) return null;
  const kinds = new Set<MetaCampaignKind>();
  let missingLabel = false;
  for (const campaignId of campaignIds) {
    const kind = labelMap.get(campaignId);
    if (kind) {
      kinds.add(kind);
    } else {
      missingLabel = true;
    }
  }
  if (missingLabel) return null;
  if (kinds.size > 1) return "mixed";
  return kinds.values().next().value ?? null;
}

function attachCampaignKind(
  rec: MetaRecommendation,
  labelMap: MetaCampaignLabelKindMap,
  activeCampaignIds: readonly string[],
): MetaRecommendation {
  const campaignKind = campaignKindForRec(rec, labelMap, activeCampaignIds);
  return campaignKind ? { ...rec, campaignKind } : rec;
}

function appendGuardEvidence(rec: MetaRecommendation): MetaRecommendation["evidence"] {
  const hasLabelEvidence = rec.evidence.some((item) => item.label === "Campaign role");
  const hasBlockedAction = rec.evidence.some((item) => item.label === "Blocked action");
  return [
    ...rec.evidence,
    ...(hasLabelEvidence
      ? []
      : [
          {
            label: "Campaign role",
            value: "Automatic inference unresolved",
            tone: "warning" as const,
          },
        ]),
    ...(hasBlockedAction
      ? []
      : [{ label: "Blocked action", value: rec.type, tone: "warning" as const }]),
  ];
}

function automaticContextEvidence(
  rec: MetaRecommendation,
  entry: MetaCampaignContextGuardEntry | null,
): MetaRecommendation["evidence"] {
  if (rec.evidence.some((item) => item.label === "Campaign context")) {
    return rec.evidence;
  }
  const kind = entry?.kind ? ` · ${entry.kind}` : "";
  const resolverPending =
    entry?.inferenceConfidenceClass === "high" &&
    entry.resolverAuthorityValidated === false;
  return [
    ...rec.evidence,
    {
      label: "Campaign context",
      value: resolverPending
        ? `Automatic high${kind} · resolver validation pending · review-only`
        : `Automatic ${entry?.inferenceConfidenceClass ?? entry?.contextTrust ?? "unknown"}${kind} · review-only`,
      tone: "warning" as const,
    },
  ];
}

function appendTransformEvidence(
  rec: MetaRecommendation,
  value: string,
): MetaRecommendation["evidence"] {
  const hasLabelEvidence = rec.evidence.some((item) => item.label === "Campaign role");
  const hasTransformEvidence = rec.evidence.some((item) => item.label === "Role transform");
  return [
    ...rec.evidence,
    ...(hasLabelEvidence
      ? []
      : [{ label: "Campaign role", value: "Test", tone: "neutral" as const }]),
    ...(hasTransformEvidence
      ? []
      : [{ label: "Role transform", value, tone: "warning" as const }]),
  ];
}

function explicitOrInferredDecisionLabel(rec: MetaRecommendation): MetaDecisionLabel | null {
  if (rec.decisionLabel) return rec.decisionLabel;
  if (REFRESH_ACTION_TYPES.has(rec.type)) return "refresh";
  if (SCALE_ACTION_TYPES.has(rec.type)) return "scale";
  return null;
}

function labelFirstSummary(rec: MetaRecommendation) {
  const subject = rec.campaignName ?? rec.adsetName ?? "This Meta entity";
  return `${subject} has a possible hard action, but automatic Main/Test/Mixed campaign context is unresolved. Refresh source evidence and rerun role inference before changing budgets, bids, or promotion flow.`;
}

function labelTransformPayload(input: {
  reason: typeof META_TEST_REFRESH_TO_CUT_REASON | typeof META_TEST_SCALE_TO_PROMOTE_REASON;
  rec: MetaRecommendation;
  toType: MetaRecommendationType;
  toDecisionLabel: MetaDecisionLabel;
}) {
  return {
    reason: input.reason,
    campaignKind: "test" as const,
    fromType: input.rec.type,
    toType: input.toType,
    fromDecisionLabel: explicitOrInferredDecisionLabel(input.rec),
    toDecisionLabel: input.toDecisionLabel,
  };
}

function transformTestRefreshToCut(rec: MetaRecommendation): MetaRecommendation {
  const transform = labelTransformPayload({
    reason: META_TEST_REFRESH_TO_CUT_REASON,
    rec,
    toType: rec.type,
    toDecisionLabel: "cut",
  });
  const subject = rec.campaignName ?? rec.adsetName ?? "Test campaign";
  return {
    ...rec,
    decisionLabel: "cut",
    labelTransform: transform,
    decision: "Cut failed test instead of refreshing it",
    title: `${subject}: cut test instead of refreshing`,
    why: `${rec.why} Because this campaign is automatically classified as Test with high confidence, a refresh signal means the test did not earn another iteration in the same container.`,
    summary: "A Test campaign with a refresh signal should be stopped or replaced, not refreshed in place like a Main campaign.",
    recommendedAction: "Cut or stop this Test lane and launch the next hypothesis separately; do not keep refreshing the same failed test container.",
    expectedImpact: "Prevents test budget from being trapped in repeated refresh cycles.",
    evidence: appendTransformEvidence(rec, "Refresh -> Cut"),
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      labelTransform: transform,
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      labelTransform: transform,
    },
  };
}

function transformTestScaleToPromotion(rec: MetaRecommendation): MetaRecommendation {
  const transform = labelTransformPayload({
    reason: META_TEST_SCALE_TO_PROMOTE_REASON,
    rec,
    toType: "promote_test_to_main",
    toDecisionLabel: "scale",
  });
  const subject = rec.campaignName ?? rec.adsetName ?? "Test campaign";
  return {
    ...rec,
    id: rec.id.startsWith("promote-test-to-main-")
      ? rec.id
      : `promote-test-to-main-${rec.id}`,
    type: "promote_test_to_main",
    decisionLabel: "scale",
    labelTransform: transform,
    decision: "Promote winning test to Main",
    title: `${subject}: promote winning test to Main`,
    why: `${rec.why} Because this campaign is automatically classified as Test with high confidence, the scale verdict becomes a promotion decision instead of simply increasing Test spend.`,
    summary: "The test appears validated; move the winning setup into a Main lane before scaling.",
    recommendedAction: "Promote the validated Test setup into a Main campaign or Main ad set lane, then scale from the Main structure under normal guardrails.",
    expectedImpact: "Separates validation budget from scale budget and keeps Test campaigns from becoming accidental Main campaigns.",
    evidence: appendTransformEvidence(rec, "Scale -> Promote to Main"),
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      labelTransform: transform,
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      labelTransform: transform,
    },
  };
}

function applyTestCampaignSemantics(
  rec: MetaRecommendation,
  labelMap: MetaCampaignLabelKindMap,
) {
  if (rec.kind === "state" || rec.kind === "anomaly") return rec;
  if (isAlreadyLabelTransformed(rec)) return rec;
  if (!rec.campaignId || labelMap.get(rec.campaignId) !== "test") return rec;
  const label = explicitOrInferredDecisionLabel(rec);
  if (label === "refresh") return transformTestRefreshToCut(rec);
  if (label === "scale") return transformTestScaleToPromotion(rec);
  return rec;
}

function downgradeToSoftOnly(rec: MetaRecommendation): MetaRecommendation {
  const cappedScore = Math.min(confidenceScore(rec), META_CAMPAIGN_LABEL_CONFIDENCE_CAP);
  return {
    ...rec,
    kind: "state",
    decisionLabel: "diagnose",
    stateReason: "The automatic campaign role is unresolved. The engine will not emit hard scale, cut, bid, or budget moves until fresh evidence resolves Main, Test, or Mixed.",
    decisionState: "watch",
    confidence: "low",
    confidenceScore: cappedScore,
    confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    priority: rec.priority === "high" ? "medium" : rec.priority,
    decision: "Resolve campaign role before hard action",
    title: `${rec.campaignName ?? rec.adsetName ?? "Campaign"}: automatic role unresolved`,
    why: `${rec.why} Automatic campaign-role inference is unresolved, so this hard action is capped to soft-only until fresh Main/Test/Mixed context is available.`,
    summary: labelFirstSummary(rec),
    recommendedAction: "Refresh the account evidence and rerun automatic campaign-role inference, then review the Meta recommendation again before changing budget, bids, or promotion flow.",
    expectedImpact: "Prevents the engine from treating Main and Test campaigns as interchangeable for hard actions.",
    evidence: appendGuardEvidence(rec),
    // D074b: even the no-context fallback speaks the automatic-role
    // vocabulary; the legacy keys survive as recognition-only aliases.
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      quality_status: "campaign_context_unresolved",
      confidence_cap: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      campaign_context_status: "unavailable",
      campaign_context_action_authority: "review_only",
      blocked_action_type: rec.type,
      blocked_decision_state: rec.decisionState,
      blocked_confidence_score: rec.confidenceScore ?? null,
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    },
  };
}

function restrictAutomaticContextToReview(
  rec: MetaRecommendation,
  entry: MetaCampaignContextGuardEntry | null,
): MetaRecommendation {
  const cappedScore = Math.min(
    confidenceScore(rec),
    META_CAMPAIGN_LABEL_CONFIDENCE_CAP,
  );
  const resolverPending =
    entry?.inferenceConfidenceClass === "high" &&
    entry.resolverAuthorityValidated === false;
  return {
    ...rec,
    decisionLabel: explicitOrInferredDecisionLabel(rec) ?? rec.decisionLabel,
    decisionState: "watch",
    confidence: "low",
    confidenceScore: cappedScore,
    confidenceReason: resolverPending
      ? META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON
      : META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    priority: rec.priority === "high" ? "medium" : rec.priority,
    why: resolverPending
      ? `${rec.why} Automatic Main/Test/Mixed inference is high confidence, but this resolver version has not passed the independent authority gate; the decision remains explicit and provider execution is review-only.`
      : `${rec.why} Automatic Main/Test/Mixed context is ${entry?.contextTrust ?? "unknown"}; the decision remains explicit but provider execution is review-only.`,
    evidence: automaticContextEvidence(rec, entry),
    campaignContext: {
      kind: entry?.kind ?? null,
      source: entry?.source ?? "unknown",
      confidence:
        entry?.inferenceConfidenceClass ?? entry?.contextTrust ?? "unknown",
      trustedForAction: false,
    },
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      campaign_context_status: entry?.contextTrust ?? "unknown",
      campaign_context_source: entry?.source ?? "unknown",
      campaign_context_kind: entry?.kind ?? null,
      campaign_context_action_authority: resolverPending
        ? "resolver_unvalidated"
        : "review_only",
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      campaign_context_reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    },
  };
}

function campaignContextEntryForRec(
  rec: MetaRecommendation,
  activeCampaignIds: readonly string[],
  contextById: MetaCampaignContextGuardMap,
) {
  const campaignIds = campaignIdsForRec(rec, activeCampaignIds);
  if (campaignIds.length !== 1) return null;
  return contextById.get(campaignIds[0]!) ?? null;
}

export function applyMetaCampaignLabelGuard(input: {
  recommendations: MetaRecommendation[];
  campaignLabelsById: MetaCampaignLabelKindMap | null | undefined;
  campaignContextById?: MetaCampaignContextGuardMap | null;
  automaticContextEnabled?: boolean;
  activeCampaignIds?: readonly string[];
}): MetaCampaignLabelGuardResult {
  // The old campaignLabelsById argument is retained only to keep frozen
  // snapshot callers source-compatible. Runtime authority is rebuilt solely
  // from fresh high-confidence automatic context below; a manual-role map can
  // no longer unlock kind semantics or a provider action.
  const labelMap = new Map<string, MetaCampaignKind>();
  const contextById =
    input.campaignContextById ?? new Map<string, MetaCampaignContextGuardEntry>();
  for (const [campaignId, entry] of contextById) {
    if (
      entry.kind &&
      entry.contextTrust === "high" &&
      entry.source === "system_inferred"
    ) {
      labelMap.set(campaignId, entry.kind);
    }
  }
  const activeCampaignIds = Array.from(new Set(input.activeCampaignIds ?? []));
  const unlabeledCampaignIds = new Set<string>();
  let downgradedCount = 0;
  let accountLevelDowngraded = false;

  const recommendations = input.recommendations.map((candidate) => {
    const contextEntry = campaignContextEntryForRec(
      candidate,
      activeCampaignIds,
      contextById,
    );
    const rec = applyTestCampaignSemantics(
      attachCampaignKind(candidate, labelMap, activeCampaignIds),
      labelMap,
    );
    const contextAnnotatedRec = contextEntry
      ? {
          ...rec,
          campaignContext: {
            kind: contextEntry.kind,
            source: contextEntry.source,
            confidence:
              contextEntry.inferenceConfidenceClass ??
              contextEntry.contextTrust,
            trustedForAction:
              contextEntry.contextTrust === "high" &&
              contextEntry.source === "system_inferred",
          },
        }
      : rec;
    if (isAlreadyGuarded(rec) || !isHardAction(rec)) {
      return contextAnnotatedRec;
    }

    const campaignIds = campaignIdsForRec(rec, activeCampaignIds);
    const isUnlabeled =
      campaignIds.length === 0 ||
      campaignIds.some((campaignId) => !hasMetaCampaignLabel(campaignId, labelMap));
    if (!isUnlabeled) {
      return contextAnnotatedRec;
    }

    downgradedCount += 1;
    if (rec.level === "account") accountLevelDowngraded = true;
    for (const campaignId of campaignIds) {
      if (!hasMetaCampaignLabel(campaignId, labelMap)) unlabeledCampaignIds.add(campaignId);
    }
    return input.automaticContextEnabled
      ? restrictAutomaticContextToReview(rec, contextEntry)
      : downgradeToSoftOnly(rec);
  }).map(withMetaAutomationReadiness);

  return {
    recommendations,
    downgradedCount,
    unlabeledCampaignIds: Array.from(unlabeledCampaignIds).sort(),
    accountLevelDowngraded,
  };
}
