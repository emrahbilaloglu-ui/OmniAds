import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import {
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaCalibrationContext,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";

export type MetaEntityStateLabel =
  | "keep"
  | "watch"
  | "out_of_scope"
  | "archived"
  | "no_action"
  | "stable_winner_protected";

export interface BuildMetaEntityStateRowsInput {
  campaigns: MetaCampaignRow[];
  adsets: MetaAdSetData[];
  calibrationContext?: MetaCalibrationContext | null;
  calibrationContextByCampaignId?: Record<string, MetaCalibrationContext | null | undefined>;
}

function isSalesObjective(value: string | null | undefined) {
  const text = String(value ?? "").toLowerCase();
  return text.includes("sales") || text.includes("conversion") || text.includes("purchase");
}

function isPaused(status: string | null | undefined) {
  return String(status ?? "").toUpperCase() !== "ACTIVE";
}

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

function stateForCampaign(campaign: MetaCampaignRow, context: MetaCalibrationContext | null): MetaEntityStateLabel {
  if (!isSalesObjective(campaign.objective) && !isSalesObjective(campaign.optimizationGoal)) return "out_of_scope";
  if (isPaused(campaign.status) && campaign.spend <= 0) return "archived";
  const roas = context?.thresholds.metrics.roas_28d;
  if (roas && campaign.purchases >= 8 && campaign.roas >= roas.p75) return "stable_winner_protected";
  if (campaign.spend <= 0 || campaign.purchases < 3) return "watch";
  return "no_action";
}

function stateForAdset(adset: MetaAdSetData, campaign: MetaCampaignRow | null, context: MetaCalibrationContext | null): MetaEntityStateLabel {
  if (!isSalesObjective(campaign?.objective) && !isSalesObjective(adset.optimizationGoal)) return "out_of_scope";
  if (isPaused(adset.status) && adset.spend <= 0) return "archived";
  const roas = context?.thresholds.metrics.roas_28d;
  if (roas && adset.purchases >= 8 && adset.roas >= roas.p75) return "stable_winner_protected";
  if (adset.spend <= 0 || adset.purchases < 3) return "watch";
  return "no_action";
}

function decisionLabelForState(state: MetaEntityStateLabel): MetaRecommendation["decisionLabel"] {
  if (state === "out_of_scope") return "out_of_scope";
  if (state === "watch") return "diagnose";
  return "keep";
}

function stateReason(state: MetaEntityStateLabel) {
  switch (state) {
    case "stable_winner_protected":
      return "Mature entity is above the calibrated upper ROAS band; protect it from unnecessary changes.";
    case "out_of_scope":
      return "Entity is not a sales-action candidate; keep state coverage but exclude it from sales action density.";
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
}): MetaRecommendation {
  const label = decisionLabelForState(input.state);
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
    stateReason: stateReason(input.state),
    lens: "structure",
    priority: "low",
    confidence: input.state === "stable_winner_protected" ? "medium" : "low",
    confidenceScore: input.state === "stable_winner_protected" ? 0.6 : 0.35,
    confidenceReason: input.state === "watch" ? "thin_data_watching" : null,
    decisionState: "watch",
    decision: input.state,
    title: `${input.name}: ${input.state.replace(/_/g, " ")}`,
    why: stateReason(input.state),
    summary: `${input.name} is covered by Meta Engine v1 state evaluation at ${fmtRoas(input.roas)} ROAS on ${input.purchases} purchases.`,
    recommendedAction: label === "out_of_scope" ? "Keep out of sales action queue." : "No immediate operator action.",
    expectedImpact: "Maintains daily entity coverage without inflating action density.",
    evidence: [
      { label: "Entity state", value: input.state, tone: "neutral" },
      { label: "ROAS", value: fmtRoas(input.roas), tone: "neutral" },
      { label: "Purchases", value: String(input.purchases), tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict: stateReason(input.state),
      selectedRangeOverlay: "State rows are coverage rows and are excluded from action-density wins.",
      historicalSupport: input.context?.scope
        ? `Calibration scope: ${input.context.scope.type}:${input.context.scope.id}.`
        : "Calibration scope unavailable; confidence is capped.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: {
      entityState: input.state,
      actionDensityEligible: !["out_of_scope", "archived"].includes(input.state),
    },
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    calibrationScope: input.context?.scope ? { ...input.context.scope } : {},
    signalQuality: { quality_status: "missing", confidence_cap: "low_without_signal_table" },
  };
}

export function buildMetaEntityStateRows(input: BuildMetaEntityStateRowsInput): MetaRecommendation[] {
  const campaignsById = new Map(input.campaigns.map((campaign) => [campaign.id, campaign]));
  const rows: MetaRecommendation[] = [];

  for (const campaign of input.campaigns) {
    const context = input.calibrationContextByCampaignId?.[campaign.id] ?? input.calibrationContext ?? null;
    rows.push(stateRecommendation({
      level: "campaign",
      id: campaign.id,
      name: campaign.name,
      state: stateForCampaign(campaign, context),
      roas: campaign.roas,
      purchases: campaign.purchases,
      context,
    }));
  }

  for (const adset of input.adsets) {
    const campaign = campaignsById.get(adset.campaignId) ?? null;
    const context = input.calibrationContextByCampaignId?.[adset.campaignId] ?? input.calibrationContext ?? null;
    rows.push(stateRecommendation({
      level: "adset",
      id: adset.id,
      name: adset.name,
      campaignId: adset.campaignId,
      campaignName: campaign?.name,
      state: stateForAdset(adset, campaign, context),
      roas: adset.roas,
      purchases: adset.purchases,
      context,
    }));
  }

  return rows;
}
