import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import {
  calculateMetaStatisticalConfidence,
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaCalibrationContext,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaBidRegime, MetaCampaignRole } from "@/lib/meta/types";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import type { MetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import {
  META_ENGINE_V1_SCENARIOS,
  type MetaEngineScenarioCohortScope,
} from "@/lib/meta/engine-v1/scenarios";

const SCENARIO_SCOPE_BY_REC_TYPE = new Map(
  META_ENGINE_V1_SCENARIOS.map((scenario) => [scenario.recType, scenario.cohortScope] as const),
);

function scenarioScopeByRecType(recType: MetaRecommendation["type"]): MetaEngineScenarioCohortScope {
  return SCENARIO_SCOPE_BY_REC_TYPE.get(recType) ?? "any";
}

export function scenarioScopeAllowsCohort(
  scope: MetaEngineScenarioCohortScope,
  cohort: MetaFunnelCohort,
) {
  if (scope === "purchase_only") return cohort === "purchase";
  if (scope === "mid_funnel_only") return cohort === "mid_funnel";
  if (scope === "lead_only") return cohort === "lead";
  return true;
}

export interface CampaignScenarioWindow {
  selected: MetaCampaignRow;
  last7?: MetaCampaignRow;
  last14?: MetaCampaignRow;
  last30?: MetaCampaignRow;
  last90?: MetaCampaignRow;
  allHistory?: MetaCampaignRow;
}

export interface CampaignScenarioInput {
  window: CampaignScenarioWindow;
  context: MetaCalibrationContext | null;
  cohort: MetaFunnelCohort;
  campaignRole?: MetaCampaignRole;
  bidRegime?: MetaBidRegime;
  signals?: MetaEntityDecisionSignal | null;
}

export interface AdsetScenarioInput {
  adset: MetaAdSetData;
  campaign?: MetaCampaignRow | null;
  context: MetaCalibrationContext | null;
  cohort: MetaFunnelCohort;
  campaignRole?: MetaCampaignRole;
  bidRegime?: MetaBidRegime;
  signals?: MetaEntityDecisionSignal | null;
}

function metric(context: MetaCalibrationContext | null, name: keyof typeof LEGACY_META_CALIBRATION_THRESHOLDS.metrics) {
  return context?.thresholds.metrics[name] ?? null;
}

function hardCutSpend(context: MetaCalibrationContext | null) {
  return context?.thresholds.hardCutSpend ?? LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend;
}

function minRequiredSample(context: MetaCalibrationContext | null) {
  return context?.thresholds.minRequiredSample ?? LEGACY_META_CALIBRATION_THRESHOLDS.minRequiredSample;
}

function sampleReady(context: MetaCalibrationContext | null, name: keyof typeof LEGACY_META_CALIBRATION_THRESHOLDS.metrics) {
  const thresholds = metric(context, name);
  return Boolean(thresholds && thresholds.sampleSize >= minRequiredSample(context));
}

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function currencySymbol(currency: string | null | undefined) {
  if (currency === "TRY") return "₺";
  if (currency === "EUR") return "€";
  return "$";
}

function fmtCurrency(value: number, currency: string | null | undefined) {
  return `${currencySymbol(currency)}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

function confidence(input: {
  level: "campaign" | "adset";
  context: MetaCalibrationContext | null;
  metricValue: number;
  threshold: number;
  severeLoser?: boolean;
}) {
  const roas = metric(input.context, "roas_28d");
  return calculateMetaStatisticalConfidence({
    level: input.level,
    metricValue: input.metricValue,
    threshold: input.threshold,
    sampleSize: roas?.sampleSize ?? 0,
    minRequiredSample: minRequiredSample(input.context),
    severeLoser: input.severeLoser,
  });
}

function historyAgeDays(window: CampaignScenarioWindow) {
  const rows = [window.allHistory, window.last90, window.last30, window.last14, window.last7, window.selected]
    .filter((row): row is MetaCampaignRow => Boolean(row));
  const activeDays = rows.filter((row) => row.spend > 0 || row.impressions > 0 || row.purchases > 0).length;
  if (window.last90 && (window.last90.spend > 0 || window.last90.impressions > 0)) return 90;
  if (window.last30 && (window.last30.spend > 0 || window.last30.impressions > 0)) return 30;
  if (window.last14 && (window.last14.spend > 0 || window.last14.impressions > 0)) return 14;
  if (window.last7 && (window.last7.spend > 0 || window.last7.impressions > 0)) return 7;
  return activeDays > 0 ? 7 : 0;
}

function budgetAmount(row: MetaCampaignRow) {
  return row.dailyBudget ?? (row.lifetimeBudget ? row.lifetimeBudget / 30 : null);
}

function targetBand(current: number, pct: number) {
  return {
    current,
    proposed: r2(current * (1 + pct)),
    range: {
      low: r2(current * 1.1),
      high: r2(current * 1.15),
    },
  };
}

function signalQuality(signals: MetaEntityDecisionSignal | null | undefined, confidenceLabel: string) {
  if (!signals) {
    return { quality_status: "missing", confidence_cap: "low_without_signal_table" };
  }
  return {
    quality_status: signals.qualityStatus,
    confidence_cap: confidenceLabel,
    signal_source: "meta_entity_decision_signals_daily",
    learning_state: signals.learningState,
    days_since_significant_edit: signals.daysSinceSignificantEdit,
  };
}

function recentEditCooldownActive(signals: MetaEntityDecisionSignal | null | undefined) {
  return signals?.daysSinceSignificantEdit != null && signals.daysSinceSignificantEdit < 7;
}

function baseCampaignRec(input: {
  row: MetaCampaignRow;
  type: MetaRecommendation["type"];
  lens: MetaRecommendation["lens"];
  priority: MetaRecommendation["priority"];
  confidenceScore: ReturnType<typeof confidence>;
  decisionState: MetaRecommendation["decisionState"];
  title: string;
  why: string;
  summary: string;
  recommendedAction: string;
  expectedImpact: string;
  evidence: MetaRecommendation["evidence"];
  targetValue?: unknown;
  campaignRole?: MetaCampaignRole;
  bidRegime?: MetaBidRegime;
  cohort: MetaFunnelCohort;
  signals?: MetaEntityDecisionSignal | null;
}): MetaRecommendation {
  return {
    id: `${input.type}-${input.row.id}`,
    level: "campaign",
    campaignId: input.row.id,
    campaignName: input.row.name,
    type: input.type,
    kind: "recommendation",
    lens: input.lens,
    priority: input.priority,
    confidence: input.confidenceScore.label,
    confidenceScore: input.confidenceScore.score,
    confidenceReason: input.confidenceScore.reason ?? null,
    decisionState: input.decisionState,
    decision: input.title,
    title: input.title,
    why: input.why,
    summary: input.summary,
    recommendedAction: input.recommendedAction,
    expectedImpact: input.expectedImpact,
    evidence: input.evidence,
    timeframeContext: {
      coreVerdict: input.why,
      selectedRangeOverlay: "Scenario trigger is grounded in account-history calibration bands.",
      historicalSupport: "Uses calibrated account percentiles from Meta Engine v1 context.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: input.targetValue,
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    calibrationScope: input.confidenceScore.reason ? { reason: input.confidenceScore.reason } : {},
    signalQuality: signalQuality(input.signals, input.confidenceScore.label),
  };
}

function baseAdsetRec(input: {
  adset: MetaAdSetData;
  campaign?: MetaCampaignRow | null;
  type: MetaRecommendation["type"];
  lens: MetaRecommendation["lens"];
  priority: MetaRecommendation["priority"];
  confidenceScore: ReturnType<typeof confidence>;
  decisionState: MetaRecommendation["decisionState"];
  title: string;
  why: string;
  summary: string;
  recommendedAction: string;
  expectedImpact: string;
  evidence: MetaRecommendation["evidence"];
  targetValue?: unknown;
  campaignRole?: MetaCampaignRole;
  bidRegime?: MetaBidRegime;
  cohort: MetaFunnelCohort;
  signals?: MetaEntityDecisionSignal | null;
}): MetaRecommendation {
  return {
    id: `${input.type}-${input.adset.id}`,
    level: "adset",
    campaignId: input.adset.campaignId,
    campaignName: input.campaign?.name,
    adsetId: input.adset.id,
    adsetName: input.adset.name,
    type: input.type,
    kind: "recommendation",
    lens: input.lens,
    priority: input.priority,
    confidence: input.confidenceScore.label,
    confidenceScore: input.confidenceScore.score,
    confidenceReason: input.confidenceScore.reason ?? null,
    decisionState: input.decisionState,
    decision: input.title,
    title: input.title,
    why: input.why,
    summary: input.summary,
    recommendedAction: input.recommendedAction,
    expectedImpact: input.expectedImpact,
    evidence: input.evidence,
    timeframeContext: {
      coreVerdict: input.why,
      selectedRangeOverlay: "Scenario trigger is grounded in account-history calibration bands.",
      historicalSupport: "Uses calibrated account or campaign percentiles from Meta Engine v1 context.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: input.targetValue,
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    calibrationScope: input.confidenceScore.reason ? { reason: input.confidenceScore.reason } : {},
    signalQuality: signalQuality(input.signals, input.confidenceScore.label),
  };
}

export function maybeC1ControlledScale(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const roas = metric(input.context, "roas_28d");
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  if (recentEditCooldownActive(input.signals)) return null;
  if (historyAgeDays(input.window) < 28 || row.roas < roas.p75 || row.purchases < 8) return null;
  const budget = budgetAmount(row);
  if (!budget) return null;
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: roas.p75 });
  return baseCampaignRec({
    row,
    type: "scenario_c1_controlled_scale",
    lens: "volume",
    priority: "high",
    confidenceScore: conf,
    decisionState: conf.score >= 0.7 ? "act" : "test",
    title: `${row.name}: controlled scale candidate`,
    why: `28d ROAS ${fmtRoas(row.roas)} is above calibrated p75 ${fmtRoas(roas.p75)} with mature purchase depth.`,
    summary: "The campaign is a mature winner; scale only in a bounded 10-25% step.",
    recommendedAction: "Increase campaign budget by 10-25% and watch CPA/ROAS for 48-72 hours.",
    expectedImpact: "More volume while avoiding a learning reset from an oversized edit.",
    evidence: [
      { label: "ROAS", value: fmtRoas(row.roas), tone: "positive" },
      { label: "ROAS p75", value: fmtRoas(roas.p75), tone: "neutral" },
      { label: "Purchases", value: String(row.purchases), tone: "positive" },
    ],
    targetValue: { budget: { current: budget, proposed: r2(budget * 1.15), range: { low: r2(budget * 1.1), high: r2(budget * 1.25) } } },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeB1CappedBidRaise(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const roas = metric(input.context, "roas_28d");
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  if (!["cost_cap", "bid_cap", "target_roas", "minimum_roas", "manual_bid"].includes(String(row.bidStrategyType))) return null;
  const budget = budgetAmount(row);
  const bid = row.bidValue ?? row.manualBidAmount;
  if (!budget || !bid || row.roas < roas.p50) return null;
  const dailySpend = row.spend / 28;
  if (dailySpend / budget >= 0.95) return null;
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: roas.p50 });
  return baseCampaignRec({
    row,
    type: "scenario_b1_capped_winner_bid_raise",
    lens: "volume",
    priority: "high",
    confidenceScore: conf,
    decisionState: "act",
    title: `${row.name}: capped winner needs bid room`,
    why: `Capped bidding is under-delivering while ROAS ${fmtRoas(row.roas)} is above calibrated p50 ${fmtRoas(roas.p50)}.`,
    summary: "Raise the bid cap before raising budget; budget utilization is below 95%.",
    recommendedAction: "Increase the bid cap 10% and re-check delivery before any budget increase.",
    expectedImpact: "Unlock delivery without forcing budget into an auction cap.",
    evidence: [
      { label: "Budget utilization", value: `${r2((dailySpend / budget) * 100)}%`, tone: "warning" },
      { label: "ROAS p50", value: fmtRoas(roas.p50), tone: "neutral" },
      { label: "Current bid", value: fmtCurrency(bid, row.currency), tone: "neutral" },
    ],
    targetValue: { bid: targetBand(bid, 0.1) },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeJ1StableWinnerProtected(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const roas = metric(input.context, "roas_28d");
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  if (recentEditCooldownActive(input.signals)) return null;
  if (historyAgeDays(input.window) < 28 || row.purchases < 8 || row.roas < roas.p75) return null;
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: roas.p75 });
  return baseCampaignRec({
    row,
    type: "scenario_j1_stable_winner_protected",
    lens: "profitability",
    priority: "medium",
    confidenceScore: conf,
    decisionState: "watch",
    title: `${row.name}: stable winner protected`,
    why: "Mature winner is above the calibrated upper ROAS band; avoid unnecessary structural edits.",
    summary: "Protect this winner unless a stronger C1/B1 action is available.",
    recommendedAction: "Keep the campaign protected; use controlled scale only if budget changes are needed.",
    expectedImpact: "Preserves a proven learning state and avoids avoidable reset risk.",
    evidence: [
      { label: "Winner state", value: "stable_winner_protected", tone: "positive" },
      { label: "ROAS", value: fmtRoas(row.roas), tone: "positive" },
      { label: "ROAS p75", value: fmtRoas(roas.p75), tone: "neutral" },
    ],
    targetValue: { state: "stable_winner_protected" },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeA2StructuralRebuild(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const roas = metric(input.context, "roas_28d");
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  if (!input.signals?.learningState || input.signals.learningState === "LEARNING") return null;
  if (historyAgeDays(input.window) < 7 || row.roas >= roas.p25 || row.spend < hardCutSpend(input.context)) return null;
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: roas.p25, severeLoser: row.roas <= roas.p10 });
  return baseCampaignRec({
    row,
    type: "scenario_a2_learning_weak_structural",
    lens: "structure",
    priority: "high",
    confidenceScore: conf,
    decisionState: "act",
    title: `${row.name}: rebuild weak structure`,
    why: `ROAS ${fmtRoas(row.roas)} is below calibrated p25 ${fmtRoas(roas.p25)} after meaningful spend.`,
    summary: "Do not wait for learning to rescue a severe underperformer.",
    recommendedAction: "Rebuild with cleaner audience, creative, and optimization separation before adding budget.",
    expectedImpact: "Stops budget from compounding through a structurally weak setup.",
    evidence: [
      { label: "Spend", value: fmtCurrency(row.spend, row.currency), tone: "warning" },
      { label: "ROAS", value: fmtRoas(row.roas), tone: "warning" },
      { label: "ROAS p25", value: fmtRoas(roas.p25), tone: "neutral" },
    ],
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeF1SuddenRoasDrop(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const last7 = input.window.last7;
  if (recentEditCooldownActive(input.signals)) return null;
  if (!last7 || row.roas <= 0 || last7.spend <= 200 || last7.roas >= row.roas * 0.5) return null;
  const roas = metric(input.context, "roas_28d");
  const conf = confidence({ level: "campaign", context: input.context, metricValue: last7.roas, threshold: roas?.p50 ?? row.roas });
  return baseCampaignRec({
    row,
    type: "scenario_f1_roas_drop_diagnostic",
    lens: "profitability",
    priority: "high",
    confidenceScore: conf,
    decisionState: "test",
    title: `${row.name}: diagnose sudden ROAS drop`,
    why: `7d ROAS ${fmtRoas(last7.roas)} is less than half of 28d ROAS ${fmtRoas(row.roas)} on meaningful spend.`,
    summary: "Investigate tracking, fatigue, recent edits, auction pressure, and seasonality before cutting budget.",
    recommendedAction: "Run diagnostic ladder: tracking → fatigue → recent edits → auction → seasonality.",
    expectedImpact: "Avoids cutting a recoverable winner for the wrong root cause.",
    evidence: [
      { label: "7d ROAS", value: fmtRoas(last7.roas), tone: "warning" },
      { label: "28d ROAS", value: fmtRoas(row.roas), tone: "neutral" },
      { label: "7d spend", value: fmtCurrency(last7.spend, row.currency), tone: "warning" },
    ],
    targetValue: { diagnostics: ["tracking", "fatigue", "recent_edits", "auction", "seasonality"] },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeF4StableWinnerFade(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const last30 = input.window.last30;
  const last90 = input.window.last90;
  if (recentEditCooldownActive(input.signals)) return null;
  if (!last30 || !last90 || last90.roas <= 0 || last30.roas / last90.roas >= 0.85) return null;
  if (row.ctr > 0 && last90.ctr > 0 && row.ctr / last90.ctr >= 0.9) return null;
  const roas = metric(input.context, "roas_28d");
  const conf = confidence({ level: "campaign", context: input.context, metricValue: last30.roas, threshold: roas?.p50 ?? last90.roas });
  return baseCampaignRec({
    row,
    type: "scenario_f4_stable_winner_drop_context",
    lens: "profitability",
    priority: "medium",
    confidenceScore: conf,
    decisionState: "test",
    title: `${row.name}: diagnose winner fade`,
    why: "Recent ROAS has faded versus the longer baseline while CTR is also weaker.",
    summary: "Treat this as a context diagnosis before changing budget.",
    recommendedAction: "Check auction pressure and seasonality, then refresh only if creative decay is confirmed.",
    expectedImpact: "Protects previously strong campaigns from overreactive cuts.",
    evidence: [
      { label: "30d ROAS", value: fmtRoas(last30.roas), tone: "warning" },
      { label: "90d ROAS", value: fmtRoas(last90.roas), tone: "neutral" },
      { label: "CTR", value: `${r2(row.ctr)}%`, tone: "warning" },
    ],
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeE1FatigueAdset(input: AdsetScenarioInput): MetaRecommendation | null {
  const frequency = metric(input.context, "freq_14d");
  const ctr = metric(input.context, "ctr_28d");
  const hasCalibratedFrequency = Boolean(frequency && sampleReady(input.context, "freq_14d"));
  const frequencyThreshold = hasCalibratedFrequency && frequency ? frequency.p75 : 2.5;
  const freqValue = Number(input.signals?.frequencyP80 ?? (input.adset as MetaAdSetData & { frequency?: number | null }).frequency ?? 0);
  if (!ctr || freqValue <= frequencyThreshold || input.adset.ctr > ctr.p50) return null;
  const conf = confidence({ level: "adset", context: input.context, metricValue: freqValue, threshold: frequencyThreshold });
  return baseAdsetRec({
    adset: input.adset,
    campaign: input.campaign,
    type: "scenario_e1_frequency_fatigue",
    lens: "structure",
    priority: "medium",
    confidenceScore: conf,
    decisionState: "test",
    title: `${input.adset.name}: refresh fatigued delivery`,
    why: `Frequency ${r2(freqValue)} is above ${hasCalibratedFrequency && frequency ? `calibrated p75 ${r2(frequency.p75)}` : "the documented ecommerce fatigue fallback"} while CTR is not above median.`,
    summary: "Creative or audience pressure is likely stale.",
    recommendedAction: "Refresh creative and reduce repeated delivery pressure before scaling.",
    expectedImpact: "Improves click freshness and reduces spend into stale impressions.",
    evidence: [
      { label: "Frequency", value: String(r2(freqValue)), tone: "warning" },
      { label: "Frequency threshold", value: String(r2(frequencyThreshold)), tone: "neutral" },
      { label: "CTR", value: `${r2(input.adset.ctr)}%`, tone: "warning" },
    ],
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeE2CtrDecay(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const last7 = input.window.last7;
  const last14 = input.window.last14;
  const signalDecayPct = input.signals?.ctrDecayPct;
  if (signalDecayPct == null) return null;
  if (!last7 || !last14 || signalDecayPct > -15 || last7.spend < row.spend * 0.15) return null;
  const ctr = metric(input.context, "ctr_28d");
  const conf = confidence({ level: "campaign", context: input.context, metricValue: last7.ctr, threshold: ctr?.p25 ?? last14.ctr });
  return baseCampaignRec({
    row,
    type: "scenario_e2_ctr_decay_refresh",
    lens: "structure",
    priority: "medium",
    confidenceScore: conf,
    decisionState: "test",
    title: `${row.name}: CTR decay needs refresh`,
    why: `Signal table shows CTR decay of ${r2(signalDecayPct)}% versus the 14d baseline while spend remains active.`,
    summary: "Refresh creative before making a bid or budget call.",
    recommendedAction: "Rotate new hooks/angles and hold budget until CTR stabilizes.",
    expectedImpact: "Separates creative decay from auction or bid issues.",
    evidence: [
      { label: "7d CTR", value: `${r2(last7.ctr)}%`, tone: "warning" },
      { label: "14d CTR", value: `${r2(last14.ctr)}%`, tone: "neutral" },
    ],
    targetValue: { ctr_decay_pct: r2(signalDecayPct) },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeE4CreativeAge(input: CampaignScenarioInput): MetaRecommendation | null {
  if ((input.signals?.creativeAgeDaysMax ?? 0) < 21) return null;
  const e2 = maybeE2CtrDecay(input);
  return e2
    ? {
        ...e2,
        id: `scenario_e4_creative_age_refresh-${input.window.selected.id}`,
        type: "scenario_e4_creative_age_refresh",
        title: `${input.window.selected.name}: aged creative needs refresh`,
      }
    : null;
}

export function maybeK1MixedConfig(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (!row.isConfigMixed && !row.isBudgetMixed && !row.isOptimizationGoalMixed && !row.isBidStrategyMixed) return null;
  const roas = metric(input.context, "roas_28d");
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: roas?.p50 ?? (row.roas || 1) });
  return baseCampaignRec({
    row,
    type: "scenario_k1_mixed_config_rebuild",
    lens: "structure",
    priority: "high",
    confidenceScore: conf,
    decisionState: "act",
    title: `${row.name}: rebuild mixed configuration`,
    why: "Campaign has mixed budget, optimization, bid, or structural settings that muddy learning.",
    summary: "Uniform structure should come before bid or budget tuning.",
    recommendedAction: "Rebuild with one optimization event, one bid regime, and clean ABO/CBO intent.",
    expectedImpact: "Cleaner learning and less ambiguous performance attribution.",
    evidence: [
      { label: "Mixed config", value: row.isConfigMixed ? "yes" : "no", tone: row.isConfigMixed ? "warning" : "neutral" },
      { label: "Mixed budget", value: row.isBudgetMixed ? "yes" : "no", tone: row.isBudgetMixed ? "warning" : "neutral" },
      { label: "Mixed bid", value: row.isBidStrategyMixed ? "yes" : "no", tone: row.isBidStrategyMixed ? "warning" : "neutral" },
    ],
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeI4TestShouldUseAbo(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const roleText = `${input.campaignRole ?? ""} ${row.name}`.toLowerCase();
  if (!roleText.includes("test") || row.budgetLevel !== "campaign") return null;
  const roas = metric(input.context, "roas_28d");
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: roas?.p50 ?? (row.roas || 1) });
  return baseCampaignRec({
    row,
    type: "scenario_i4_test_should_use_abo",
    lens: "structure",
    priority: "high",
    confidenceScore: conf,
    decisionState: "act",
    title: `${row.name}: test campaign should use ABO`,
    why: "Test campaigns need isolated budget cells; CBO can hide which adset actually won.",
    summary: "Move test budget from CBO to ABO before judging winners.",
    recommendedAction: "Rebuild this test as ABO with separate adset budgets and keep winners out of the test pool.",
    expectedImpact: "Cleaner test reads and fewer false negatives from CBO allocation.",
    evidence: [
      { label: "Campaign role", value: input.campaignRole ?? "test-like", tone: "warning" },
      { label: "Budget mode", value: "CBO", tone: "warning" },
    ],
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeA1MathFloor(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const cpa = metric(input.context, "cpa_28d");
  const budget = budgetAmount(row);
  if (!cpa || !budget || historyAgeDays(input.window) < 7) return null;
  if (!input.signals?.learningState || input.signals.learningState === "OPTIMAL_LEARNING_DONE") return null;
  const possibleWeeklyConversions = budget * 7 / Math.max(cpa.p50, 1);
  if (possibleWeeklyConversions >= 50) return null;
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: metric(input.context, "roas_28d")?.p50 ?? (row.roas || 1) });
  return baseCampaignRec({
    row,
    type: "scenario_a1_math_floor_unmet",
    lens: "structure",
    priority: "high",
    confidenceScore: conf,
    decisionState: "act",
    title: `${row.name}: learning math floor is unreachable`,
    why: `Weekly budget can fund about ${r2(possibleWeeklyConversions)} conversions at calibrated CPA p50, below the 50-conversion learning target.`,
    summary: "Waiting will not solve a budget-to-signal math problem.",
    recommendedAction: "Switch to an upper-funnel optimization event or rebuild with warmer/lower-cost signal before waiting.",
    expectedImpact: "Moves the campaign toward enough signal density to learn.",
    evidence: [
      { label: "Possible weekly conversions", value: String(r2(possibleWeeklyConversions)), tone: "warning" },
      { label: "CPA p50", value: fmtCurrency(cpa.p50, row.currency), tone: "neutral" },
      { label: "Daily budget", value: fmtCurrency(budget, row.currency), tone: "neutral" },
    ],
    targetValue: { current_event: row.optimizationGoal, proposed_event: "ADD_TO_CART_OR_INITIATE_CHECKOUT" },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

const CAMPAIGN_PRECEDENCE = [
  maybeA2StructuralRebuild,
  maybeK1MixedConfig,
  maybeI4TestShouldUseAbo,
  maybeF1SuddenRoasDrop,
  maybeF4StableWinnerFade,
  maybeE2CtrDecay,
  maybeE4CreativeAge,
  maybeB1CappedBidRaise,
  maybeC1ControlledScale,
  maybeA1MathFloor,
  maybeJ1StableWinnerProtected,
];

export function emitHighPriorityCampaignScenario(input: CampaignScenarioInput): MetaRecommendation | null {
  for (const emitter of CAMPAIGN_PRECEDENCE) {
    const rec = emitter(input);
    if (!rec) continue;
    if (!scenarioScopeAllowsCohort(scenarioScopeByRecType(rec.type), input.cohort)) {
      continue;
    }
    return rec;
  }
  return null;
}

const ADSET_PRECEDENCE = [
  maybeE1FatigueAdset,
];

export function emitHighPriorityAdsetScenario(input: AdsetScenarioInput): MetaRecommendation | null {
  for (const emitter of ADSET_PRECEDENCE) {
    const rec = emitter(input);
    if (!rec) continue;
    if (!scenarioScopeAllowsCohort(scenarioScopeByRecType(rec.type), input.cohort)) {
      continue;
    }
    return rec;
  }
  return null;
}
