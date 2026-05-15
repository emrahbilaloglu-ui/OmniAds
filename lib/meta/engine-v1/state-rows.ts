import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import {
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaCalibrationContext,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";
import {
  hasMetaCampaignLabel,
  META_CAMPAIGN_LABEL_GUARD_REASON,
  type MetaCampaignLabelKindMap,
} from "@/lib/meta/campaign-label-guard";
import {
  isPurchaseCohort,
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";

export type MetaEntityStateLabel =
  | "keep"
  | "watch"
  | "out_of_scope"
  | "non_sales_eligible"
  | "unlabeled_campaign_context"
  | "archived"
  | "no_action"
  | "stable_winner_protected";

export interface BuildMetaEntityStateRowsInput {
  campaigns: MetaCampaignRow[];
  adsets: MetaAdSetData[];
  calibrationContext?: MetaCalibrationContext | null;
  calibrationContextByCampaignId?: Record<string, MetaCalibrationContext | null | undefined>;
  campaignLabelsById?: MetaCampaignLabelKindMap | null;
}

function isSalesObjective(value: string | null | undefined) {
  const text = String(value ?? "").toLowerCase();
  return text.includes("sales") || text.includes("conversion") || text.includes("purchase");
}

function isPaused(status: string | null | undefined) {
  return String(status ?? "").toUpperCase() !== "ACTIVE";
}

function goalOrFallback(goal: string | null | undefined, fallback: string | null | undefined) {
  return String(goal ?? "").trim() ? goal : fallback;
}

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

interface MetaEntityStateResolution {
  state: MetaEntityStateLabel;
  cohort: MetaFunnelCohort;
}

function stateForCampaign(
  campaign: MetaCampaignRow,
  context: MetaCalibrationContext | null,
  labelMap: MetaCampaignLabelKindMap | null | undefined,
): MetaEntityStateResolution {
  const cohort = resolveMetaFunnelCohort({
    optimizationGoal: goalOrFallback(campaign.optimizationGoal, campaign.objective),
    customEventType: campaign.customEventType,
  });
  if (
    labelMap &&
    String(campaign.status ?? "").toUpperCase() === "ACTIVE" &&
    isPurchaseCohort(cohort) &&
    !hasMetaCampaignLabel(campaign.id, labelMap)
  ) {
    return { state: "unlabeled_campaign_context", cohort };
  }
  if (!isPurchaseCohort(cohort)) {
    if (
      cohort === "unknown" &&
      !isSalesObjective(campaign.objective) &&
      !isSalesObjective(campaign.optimizationGoal)
    ) {
      return { state: "out_of_scope", cohort };
    }
    if (cohort === "unknown") {
      if (isPaused(campaign.status) && campaign.spend <= 0) return { state: "archived", cohort };
      return { state: "watch", cohort };
    }
    return { state: "non_sales_eligible", cohort };
  }
  if (isPaused(campaign.status) && campaign.spend <= 0) return { state: "archived", cohort };
  const roas = context?.thresholds.metrics.roas_28d;
  if (roas && campaign.purchases >= 8 && campaign.roas >= roas.p75) {
    return { state: "stable_winner_protected", cohort };
  }
  if (campaign.spend <= 0 || campaign.purchases < 3) return { state: "watch", cohort };
  return { state: "no_action", cohort };
}

function stateForAdset(
  adset: MetaAdSetData,
  campaign: MetaCampaignRow | null,
  context: MetaCalibrationContext | null,
  labelMap: MetaCampaignLabelKindMap | null | undefined,
): MetaEntityStateResolution {
  const cohort = resolveMetaFunnelCohort({
    optimizationGoal: adset.optimizationGoal,
    customEventType: adset.customEventType,
  });
  if (
    labelMap &&
    String(adset.status ?? "").toUpperCase() === "ACTIVE" &&
    isPurchaseCohort(cohort) &&
    !hasMetaCampaignLabel(adset.campaignId, labelMap)
  ) {
    return { state: "unlabeled_campaign_context", cohort };
  }
  if (!isPurchaseCohort(cohort)) {
    if (
      cohort === "unknown" &&
      !isSalesObjective(campaign?.objective) &&
      !isSalesObjective(adset.optimizationGoal)
    ) {
      return { state: "out_of_scope", cohort };
    }
    if (cohort === "unknown") {
      if (isPaused(adset.status) && adset.spend <= 0) return { state: "archived", cohort };
      return { state: "watch", cohort };
    }
    return { state: "non_sales_eligible", cohort };
  }
  if (isPaused(adset.status) && adset.spend <= 0) return { state: "archived", cohort };
  const roas = context?.thresholds.metrics.roas_28d;
  if (roas && adset.purchases >= 8 && adset.roas >= roas.p75) {
    return { state: "stable_winner_protected", cohort };
  }
  if (adset.spend <= 0 || adset.purchases < 3) return { state: "watch", cohort };
  return { state: "no_action", cohort };
}

function decisionLabelForState(state: MetaEntityStateLabel): MetaRecommendation["decisionLabel"] {
  if (state === "out_of_scope" || state === "non_sales_eligible") return "out_of_scope";
  if (state === "watch" || state === "unlabeled_campaign_context") return "diagnose";
  return "keep";
}

function formatCohort(cohort: MetaFunnelCohort | null | undefined) {
  return String(cohort ?? "unknown").replace(/_/g, " ");
}

function stateReason(
  state: MetaEntityStateLabel,
  cohort?: MetaFunnelCohort,
  level?: "campaign" | "adset",
) {
  const subject = level === "campaign" ? "Campaign" : "Adset";
  switch (state) {
    case "stable_winner_protected":
      return "Mature entity is above the calibrated upper ROAS band; protect it from unnecessary changes.";
    case "out_of_scope":
      return "Entity is not a sales-action candidate; keep state coverage but exclude it from sales action density.";
    case "non_sales_eligible":
      return `${subject} is configured for ${formatCohort(cohort)} delivery; not evaluated in the purchase decision engine.`;
    case "unlabeled_campaign_context":
      return "Campaign is not labeled. Main/Test/Mixed context is required before the engine emits hard scale, cut, bid, or budget moves.";
    case "archived":
      return "Paused or inactive entity has no current spend pressure; archive coverage only.";
    case "watch":
      return "Signal is thin or delivery is not mature enough for a high-confidence action.";
    case "no_action":
      return "Entity is mature enough for coverage but does not meet a scenario action threshold.";
    default:
      return "Entity state row.";
  }
}

function stateRecommendation(input: {
  level: "campaign" | "adset";
  id: string;
  name: string;
  campaignId?: string;
  campaignName?: string;
  state: MetaEntityStateLabel;
  roas: number;
  purchases: number;
  context: MetaCalibrationContext | null;
  cohort: MetaFunnelCohort;
}): MetaRecommendation {
  const label = decisionLabelForState(input.state);
  const reason = stateReason(input.state, input.cohort, input.level);
  return {
    id: `entity_state-${input.level}-${input.id}`,
    level: input.level,
    campaignId: input.level === "campaign" ? input.id : input.campaignId,
    campaignName: input.level === "campaign" ? input.name : input.campaignName,
    adsetId: input.level === "adset" ? input.id : undefined,
    adsetName: input.level === "adset" ? input.name : undefined,
    type: input.level === "campaign" ? "campaign_state" : "adset_state",
    kind: "state",
    decisionLabel: label,
    stateReason: reason,
    lens: "structure",
    priority: input.state === "unlabeled_campaign_context" ? "medium" : "low",
    confidence: input.state === "stable_winner_protected" ? "medium" : "low",
    confidenceScore:
      input.state === "stable_winner_protected"
        ? 0.6
        : input.state === "unlabeled_campaign_context"
          ? 0.4
          : 0.35,
    confidenceReason:
      input.state === "watch"
        ? "thin_data_watching"
        : input.state === "unlabeled_campaign_context"
          ? META_CAMPAIGN_LABEL_GUARD_REASON
          : null,
    decisionState: "watch",
    decision: input.state,
    title: `${input.name}: ${input.state.replace(/_/g, " ")}`,
    why: reason,
    summary: `${input.name} is covered by Meta Engine v1 state evaluation at ${fmtRoas(input.roas)} ROAS on ${input.purchases} purchases.`,
    recommendedAction:
      input.state === "unlabeled_campaign_context"
        ? "Label this campaign as Main, Test, or Mixed before taking hard action."
        : label === "out_of_scope"
          ? "Keep out of sales action queue."
          : "No immediate operator action.",
    expectedImpact: "Maintains daily entity coverage without inflating action density.",
    evidence: [
      { label: "Entity state", value: input.state, tone: "neutral" },
      { label: "Cohort", value: input.cohort, tone: "neutral" },
      { label: "ROAS", value: fmtRoas(input.roas), tone: "neutral" },
      { label: "Purchases", value: String(input.purchases), tone: "neutral" },
      ...(input.state === "unlabeled_campaign_context"
        ? [{ label: "Campaign label", value: "Missing", tone: "warning" as const }]
        : []),
    ],
    timeframeContext: {
      coreVerdict: reason,
      selectedRangeOverlay: "State rows are coverage rows and are excluded from action-density wins.",
      historicalSupport: input.context?.scope
        ? `Calibration scope: ${input.context.scope.type}:${input.context.scope.id}.`
        : "Calibration scope unavailable; confidence is capped.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: {
      entityState: input.state,
      actionDensityEligible: !["out_of_scope", "non_sales_eligible", "archived"].includes(input.state),
    },
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    calibrationScope: input.context?.scope ? { ...input.context.scope } : {},
    signalQuality:
      input.state === "unlabeled_campaign_context"
        ? {
            quality_status: "missing_campaign_label",
            confidence_cap: META_CAMPAIGN_LABEL_GUARD_REASON,
            label_status: "unlabeled",
          }
        : { quality_status: "missing", confidence_cap: "low_without_signal_table" },
    cohort: input.cohort,
  };
}

export function buildMetaEntityStateRows(input: BuildMetaEntityStateRowsInput): MetaRecommendation[] {
  const campaignsById = new Map(input.campaigns.map((campaign) => [campaign.id, campaign]));
  const rows: MetaRecommendation[] = [];

  for (const campaign of input.campaigns) {
    const context = input.calibrationContextByCampaignId?.[campaign.id] ?? input.calibrationContext ?? null;
    const state = stateForCampaign(campaign, context, input.campaignLabelsById);
    rows.push(stateRecommendation({
      level: "campaign",
      id: campaign.id,
      name: campaign.name,
      state: state.state,
      roas: campaign.roas,
      purchases: campaign.purchases,
      context,
      cohort: state.cohort,
    }));
  }

  for (const adset of input.adsets) {
    const campaign = campaignsById.get(adset.campaignId) ?? null;
    const context = input.calibrationContextByCampaignId?.[adset.campaignId] ?? input.calibrationContext ?? null;
    const state = stateForAdset(adset, campaign, context, input.campaignLabelsById);
    rows.push(stateRecommendation({
      level: "adset",
      id: adset.id,
      name: adset.name,
      campaignId: adset.campaignId,
      campaignName: campaign?.name,
      state: state.state,
      roas: adset.roas,
      purchases: adset.purchases,
      context,
      cohort: state.cohort,
    }));
  }

  return rows;
}
