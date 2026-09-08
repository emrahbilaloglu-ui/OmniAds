import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaCampaignKind } from "@/lib/meta/campaign-label-types";
import { formatMoney } from "@/components/creatives/money";
import type { MetaAdSetData } from "@/lib/api/meta";
import {
  calculateMetaStatisticalConfidence,
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaCalibrationContext,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import {
  applyPercentToMinorUnits,
  resolveMinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import type { MetaBidRegime, MetaCampaignRole } from "@/lib/meta/types";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import { metaRecentEditAuthorityReady } from "@/lib/meta/recent-edit-authority";
import type { MetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import {
  metaCutRoasReviewCeiling,
  metaLossBudgetMaturity,
  metaScaleRoasFloor,
  normalizeMetaCommercialTargets,
  resolveMetaPurchaseValueAuthority,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";
import { enforceMetaCommercialActionAuthority } from "@/lib/meta/commercial-action-authority";
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
  if (scope === "traffic_only") return cohort === "traffic";
  if (scope === "engagement_only") return cohort === "engagement";
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
  commercialTargets?: MetaCommercialTargets | null;
  /**
   * The canonical campaign kind, and whether it is trusted for ACTION.
   *
   * `campaignRole` above is a legacy taxonomy that is partly name-derived
   * (`inferCampaignRole` regexes campaign names), so it cannot authorize an
   * actionable structural rebuild. This pair can: `kind` is the resolver's own
   * answer and `trustedForAction` is the four-fact predicate
   * `isContextTrustedForAction` applies.
   */
  campaignKind?: MetaCampaignKind | null;
  campaignKindTrustedForAction?: boolean;
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

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

function commercialTargetEvidence(
  targets: MetaCommercialTargets | null | undefined,
  currency: string | null | undefined,
): MetaRecommendation["evidence"] {
  const evidence: MetaRecommendation["evidence"] = [];
  if (targets?.targetRoas) evidence.push({ label: "Target ROAS", value: fmtRoas(targets.targetRoas), tone: "neutral" });
  if (targets?.breakEvenRoas) evidence.push({ label: "Break-even ROAS", value: fmtRoas(targets.breakEvenRoas), tone: "neutral" });
  if (targets?.breakEvenCpa) evidence.push({ label: "Break-even CPA", value: formatMoney(targets.breakEvenCpa, currency, null), tone: "neutral" });
  else if (targets?.targetCpa) evidence.push({ label: "Target CPA", value: formatMoney(targets.targetCpa, currency, null), tone: "neutral" });
  return evidence;
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
  return rows.reduce((deepestEvidence, row) => {
    const explicitAge = Number(row.ageDays);
    const activeDayCount = Number(row.activeDayCount);
    if (
      !Number.isInteger(explicitAge) ||
      explicitAge <= 0 ||
      !Number.isInteger(activeDayCount) ||
      activeDayCount <= 0 ||
      typeof row.firstDeliveryDate !== "string" ||
      typeof row.asOfDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.firstDeliveryDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.asOfDate)
    ) {
      return deepestEvidence;
    }

    const firstDeliveryTimestamp = Date.parse(`${row.firstDeliveryDate}T00:00:00Z`);
    const asOfTimestamp = Date.parse(`${row.asOfDate}T00:00:00Z`);
    if (
      !Number.isFinite(firstDeliveryTimestamp) ||
      !Number.isFinite(asOfTimestamp) ||
      new Date(firstDeliveryTimestamp).toISOString().slice(0, 10) !== row.firstDeliveryDate ||
      new Date(asOfTimestamp).toISOString().slice(0, 10) !== row.asOfDate ||
      firstDeliveryTimestamp > asOfTimestamp
    ) {
      return deepestEvidence;
    }

    const calendarAge =
      Math.floor((asOfTimestamp - firstDeliveryTimestamp) / 86_400_000) + 1;
    return Math.max(
      deepestEvidence,
      Math.min(explicitAge, activeDayCount, calendarAge),
    );
  }, 0);
}

/**
 * ── ROUND 19, ITEM B3: BUDGETS ARE MINOR UNITS, AND /100 IS NOT A CONVERSION ─
 *
 * This divided EVERY provider budget by 100. `spend` arrives in major units, so
 * `budgetUtilization` compared major-unit spend against a budget that was only
 * correct for two-decimal currencies:
 *
 *   JPY (exponent 0): a 50,000-yen daily budget read as 500, so utilization came
 *   out 100x too HIGH — B1's `< 0.95` gate refused every Japanese account.
 *   KWD (exponent 3): a 50.000-dinar budget read as 500 instead of 50, so
 *   utilization came out 10x too LOW and A1's weekly-conversion floor was
 *   overstated by the same factor.
 *
 * The exponent is resolved from the ISO 4217 registry, which refuses an unknown
 * or retired code rather than assuming two decimals — so an unresolvable
 * currency yields `null` and every caller already treats that as "no budget".
 */
function budgetAmount(row: MetaCampaignRow) {
  const providerMinorAmount =
    row.dailyBudget ?? (row.lifetimeBudget ? row.lifetimeBudget / 30 : null);
  if (providerMinorAmount == null) return null;
  const exponent = resolveMinorUnitExponent(row.currency);
  if (exponent.status !== "resolved") return null;
  return providerMinorAmount / 10 ** exponent.exponent;
}

function budgetUtilization(row: MetaCampaignRow | undefined, windowDays: number) {
  if (!row || !Number.isInteger(windowDays) || windowDays <= 0) return null;
  const budget = budgetAmount(row);
  if (!budget || budget <= 0) return null;
  return row.spend / windowDays / budget;
}

function isConstrainedBidStrategy(row: MetaCampaignRow) {
  return row.bidStrategyType === "bid_cap" ||
    row.bidStrategyType === "cost_cap" ||
    row.bidStrategyType === "manual_bid";
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
  const monthlyPacing = sourceRecord(signals, "monthly_pacing");
  const placementMix = sourceRecord(signals, "placement_mix");
  return {
    quality_status: signals.qualityStatus,
    confidence_cap: confidenceLabel,
    signal_source: "meta_entity_decision_signals_daily",
    learning_state: signals.learningState,
    days_since_significant_edit: signals.daysSinceSignificantEdit,
    tracking_quality_status: signals.trackingQualityStatus ?? null,
    monthly_pacing_status: textFromRecord(monthlyPacing, "status"),
    placement_mix_status: textFromRecord(placementMix, "status"),
  };
}

function recentEditCooldownActive(signals: MetaEntityDecisionSignal | null | undefined) {
  return signals?.daysSinceSignificantEdit != null && signals.daysSinceSignificantEdit < 7;
}

/**
 * ── ROUND 12 ────────────────────────────────────────────────────────────────
 * Is this entity's edit age unknowable, as opposed to simply old?
 *
 * DELIBERATELY SEPARATE FROM `recentEditCooldownActive`, and the separation is
 * the point. That predicate answers "is a cooldown running", and folding an
 * unknown age into it would make `maybeC2RecentEditCooldown` announce a
 * cooldown for an entity whose edits were never read — inventing a fact rather
 * than withholding one, and turning a missing timezone into a false statement
 * on the operator's screen.
 *
 * This one answers whether a decision may rely on the edit age at all. It is
 * applied at the `act`-emitting call sites and at J1, whose stable-winner
 * protection also declares `last_significant_edit_at` as a required signal.
 * Other watch and test emitters keep firing when their own required evidence
 * remains available.
 */
function recentEditAuthorityUnavailable(
  signals: MetaEntityDecisionSignal | null | undefined,
) {
  return !metaRecentEditAuthorityReady(signals);
}

function sourceRecord(
  signals: MetaEntityDecisionSignal | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = signals?.sourceJson?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textFromRecord(record: Record<string, unknown> | null, key: string) {
  const text = String(record?.[key] ?? "").trim();
  return text.length > 0 ? text : null;
}

function numberFromRecord(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberFromSource(signals: MetaEntityDecisionSignal | null | undefined, key: string) {
  const value = signals?.sourceJson?.[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function trackingQualityIssue(signals: MetaEntityDecisionSignal | null | undefined) {
  return signals?.trackingQualityStatus === "lpv_drop_suspected";
}

function monthlyPacingStatus(signals: MetaEntityDecisionSignal | null | undefined) {
  return textFromRecord(sourceRecord(signals, "monthly_pacing"), "status");
}

function learningExitEvidence(signals: MetaEntityDecisionSignal | null | undefined) {
  const sourceExitAt = String(signals?.sourceJson?.learning_exit_at ?? "").trim();
  const learningExitAt = sourceExitAt.length > 0 ? sourceExitAt : null;
  const daysAtLearningState =
    signals?.daysAtLearningState != null && Number.isFinite(Number(signals.daysAtLearningState))
      ? Number(signals.daysAtLearningState)
      : null;
  if (!learningExitAt && daysAtLearningState == null) return null;
  return { learningExitAt, daysAtLearningState };
}

function normalizedMetaText(...values: Array<string | null | undefined>) {
  return values.join(" ").trim().replace(/[\s-]+/g, "_").toUpperCase();
}

function sourceAgeDays(input: CampaignScenarioInput) {
  const sourceAge = numberFromSource(input.signals, "age_days");
  return sourceAge;
}

function purchases7d(input: CampaignScenarioInput) {
  return numberFromSource(input.signals, "purchases_7d") ?? input.window.last7?.purchases ?? input.window.selected.purchases;
}

function isPurchaseOptimizedCampaign(input: CampaignScenarioInput) {
  const customEventType = normalizedMetaText(input.window.selected.customEventType);
  if (customEventType) return /^(PURCHASE|VALUE)$/.test(customEventType);
  const optimizationGoal = normalizedMetaText(input.window.selected.optimizationGoal);
  if (optimizationGoal) {
    return /^(PURCHASE|VALUE|PRODUCT_CATALOG_SALES)$/.test(optimizationGoal);
  }
  return false;
}

type PrePurchaseOptimizationEvent =
  | "INITIATE_CHECKOUT"
  | "ADD_TO_CART"
  | "VIEW_CONTENT"
  | "LANDING_PAGE_VIEWS";

const PURCHASE_DOWNSHIFT_SOURCE_EVENTS: ReadonlyMap<PrePurchaseOptimizationEvent, string> = new Map([
  ["INITIATE_CHECKOUT", "Initiate checkout"],
  ["ADD_TO_CART", "Add to cart"],
  ["VIEW_CONTENT", "View content"],
  ["LANDING_PAGE_VIEWS", "Landing page views"],
] as const);

function explicitPrePurchaseOptimizationEvent(input: CampaignScenarioInput) {
  const customEventType = normalizedMetaText(input.window.selected.customEventType);
  const optimizationGoal = normalizedMetaText(input.window.selected.optimizationGoal);
  const event = customEventType || optimizationGoal;
  const label = PURCHASE_DOWNSHIFT_SOURCE_EVENTS.get(event as PrePurchaseOptimizationEvent);
  return label ? { event, label } : null;
}

function explicitPurchases7d(input: CampaignScenarioInput) {
  return numberFromSource(input.signals, "purchases_7d");
}

function minRecentPurchaseSample(context: MetaCalibrationContext | null) {
  return Math.max(5, minRequiredSample(context));
}

function bestUpperFunnelEvent(row: MetaCampaignRow, purchaseSignal: number) {
  const candidates = [
    {
      event: "INITIATE_CHECKOUT",
      label: "Initiate checkout",
      count: row.initiateCheckout,
      cost: row.costPerCheckoutInitiated,
      relativeFloor: Math.max(3, purchaseSignal * 2),
    },
    {
      event: "ADD_TO_CART",
      label: "Add to cart",
      count: row.addToCart,
      cost: row.costPerAddToCart,
      relativeFloor: Math.max(5, purchaseSignal * 3),
    },
    {
      event: "VIEW_CONTENT",
      label: "View content",
      count: row.contentViews,
      cost: row.costPerContentView,
      relativeFloor: Math.max(10, purchaseSignal * 5),
    },
    {
      event: "LANDING_PAGE_VIEWS",
      label: "Landing page view",
      count: row.landingPageViews,
      cost: row.costPerLandingPageView,
      relativeFloor: Math.max(25, purchaseSignal * 10),
    },
  ];
  return candidates.find((candidate) =>
    candidate.count >= candidate.relativeFloor && (candidate.cost == null || candidate.cost >= 0),
  ) ?? null;
}

function isCatalogCampaign(input: CampaignScenarioInput) {
  if (input.campaignRole === "catalog_dpa") return true;
  const text = normalizedMetaText(
    input.window.selected.name,
    input.window.selected.objective,
    input.window.selected.optimizationGoal,
  );
  return /CATALOG|DPA|PRODUCT_CATALOG_SALES/.test(text);
}

function feedDiagnostic(input: CampaignScenarioInput) {
  const source = sourceRecord(input.signals, "feed_status");
  const status = String(input.signals?.feedStatus ?? textFromRecord(source, "status") ?? "").trim();
  const normalizedStatus = status.toLowerCase().replace(/[\s-]+/g, "_");
  const disapprovalCount = input.signals?.feedDisapprovalCount ?? numberFromRecord(source, "disapproval_count") ?? 0;
  const healthyStatus =
    normalizedStatus.startsWith("no_") ||
    normalizedStatus.startsWith("not_") ||
    ["approved", "active", "ok", "healthy"].includes(normalizedStatus);
  const problematicStatus =
    !healthyStatus &&
    /(^|_)(disapproved|rejected|error|issue|issues|limited|failed|with_issues|needs_review)($|_)/.test(normalizedStatus);
  if (disapprovalCount <= 0 && !problematicStatus) return null;
  return { status: status || "issues_detected", disapprovalCount, source };
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
  decisionLabel?: MetaRecommendation["decisionLabel"];
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
    decisionLabel: input.decisionLabel,
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
  const scaleFloor = metaScaleRoasFloor(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  if (!scaleFloor) return null;
  /*
    ROUND 12. maybeC1ControlledScale emits decisionState "act", so it is a
    purchase-budget hard action and may not be decided on an edit age nobody
    measured. An entity with no resolvable provider account, no trusted IANA
    timezone, or a failed config-history read carries a null day count that the
    cooldown test above passes; this holds it instead. A trusted zone whose
    history simply contains no significant edit is READY and still emits.
  */
  if (recentEditAuthorityUnavailable(input.signals)) return null;
  if (recentEditCooldownActive(input.signals)) return null;
  const scaleThreshold = Math.max(roas.p75, scaleFloor);
  if (historyAgeDays(input.window) < 28 || row.roas < scaleThreshold || row.purchases < 8) return null;
  const budget = budgetAmount(row);
  if (!budget) return null;
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: scaleThreshold });
  /*
    THE ROAS THRESHOLD IDENTIFIES THE CANDIDATE; IT DOES NOT AUTHORIZE THE
    BUDGET.

    This returned `baseCampaignRec` directly, so a campaign clearing the
    calibrated p75 and the configured profit floor was minted at
    `decisionState: "act"` with a concrete budget band — on an account whose
    Meta-attributed purchase sample might be absent or too thin to divide.
    That is a purchase-VALUE budget increase authorized on the ratio alone,
    which is the substitution the canonical rule forbids: with a positive
    Target ROAS the unit is READY Meta AOV over that ratio, and its absence is
    an absence.

    Routed through the shared authority, exactly as the A2 and A5 emitters
    below already are, so the emitter cannot mint an authority the boundary
    would strip and the operator sees the named hold rather than a silent one.
  */
  return enforceMetaCommercialActionAuthority(baseCampaignRec({
    row,
    type: "scenario_c1_controlled_scale",
    lens: "volume",
    priority: "high",
    confidenceScore: conf,
    decisionState: conf.score >= 0.7 ? "act" : "test",
    title: `${row.name}: controlled scale candidate`,
    why: `28d ROAS ${fmtRoas(row.roas)} is above calibrated p75 ${fmtRoas(roas.p75)} and the configured profit floor ${fmtRoas(scaleFloor)} with mature purchase depth.`,
    summary: "The campaign is a mature winner; scale only in a bounded 10-25% step.",
    recommendedAction: "Increase campaign budget by 10-25% and watch CPA/ROAS for 48-72 hours.",
    expectedImpact: "More volume while avoiding a learning reset from an oversized edit.",
    evidence: [
      { label: "ROAS", value: fmtRoas(row.roas), tone: "positive" },
      { label: "ROAS p75", value: fmtRoas(roas.p75), tone: "neutral" },
      { label: "Purchases", value: String(row.purchases), tone: "positive" },
      ...commercialTargetEvidence(input.commercialTargets, row.currency),
    ],
    targetValue: { budget: { current: budget, proposed: r2(budget * 1.15), range: { low: r2(budget * 1.1), high: r2(budget * 1.25) } } },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  }), input.commercialTargets);
}


/**
 * ── ROUND 19, ITEM B4: A HOLD THE OPERATOR CAN SEE ──────────────────────────
 *
 * B1 and A1 returned `null` when the purchase-value unit was unavailable, which
 * removes the entity from the queue entirely: the operator learns nothing, and
 * an account whose Meta AOV went thin looks identical to one with no finding at
 * all. A refusal is a decision and must be visible as one.
 *
 * Emitted at `decisionState: "watch"` with NO `targetValue` and no proposed
 * action, so nothing downstream can execute it, and the blocker is named.
 */
function purchaseValueHold(input: {
  row: MetaCampaignRow;
  type: MetaRecommendation["type"];
  lens: MetaRecommendation["lens"];
  blocker: string;
  title: string;
  why: string;
  scenarioInput: CampaignScenarioInput;
}): MetaRecommendation {
  const rec = baseCampaignRec({
    row: input.row,
    type: input.type,
    lens: input.lens,
    priority: "medium",
    /*
      Confidence is computed from the same helper every other emitter uses, so
      a hold carries a real statistical result rather than a synthetic zero the
      downstream confidence bands would have to special-case.
    */
    confidenceScore: confidence({
      level: "campaign",
      context: input.scenarioInput.context,
      metricValue: input.row.roas,
      threshold: input.row.roas,
    }),
    decisionState: "watch",
    title: input.title,
    why: input.why,
    summary:
      "The account's purchase value cannot be established, so no spend change is proposed.",
    recommendedAction:
      "Review the Meta-attributed purchase sample and the ROAS target. No spend change is proposed from this recommendation.",
    expectedImpact: "None until the purchase value unit is available.",
    evidence: [
      { label: "Purchase value unit", value: "unavailable", tone: "warning" },
      { label: "Blocker", value: input.blocker, tone: "warning" },
      ...commercialTargetEvidence(input.scenarioInput.commercialTargets, input.row.currency),
    ],
    campaignRole: input.scenarioInput.campaignRole,
    bidRegime: input.scenarioInput.bidRegime,
    cohort: input.scenarioInput.cohort,
    signals: input.scenarioInput.signals,
  });
  // NO proposal survives a missing unit, whatever the base builder attached.
  const { proposedAction: _proposedAction, targetValue: _targetValue, ...held } = rec;
  return {
    ...held,
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      hard_action_authority: "blocked",
      hard_action_blocker: input.blocker,
    },
  } as MetaRecommendation;
}

export function maybeB1CappedBidRaise(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const deliveryWindow = input.window.last30;
  const roas = metric(input.context, "roas_28d");
  const scaleFloor = metaScaleRoasFloor(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  if (!scaleFloor) return null;
  /*
    ── ROUND 18, ITEM B6: ONLY REAL CURRENCY BID STRATEGIES ─────────────────

    `target_roas` and `minimum_roas` carry a RATIO in `bidValue`, not money.
    Accepting them here meant a ratio like 2.5 was read as a minor-unit amount,
    scaled by 10%, and published as a bid cap of 2.75 units — a nonsense
    instruction the operator could execute. Only the cap families whose value is
    an amount are eligible, and the format must say so.
  */
  if (!["cost_cap", "bid_cap", "manual_bid"].includes(String(row.bidStrategyType))) {
    return null;
  }
  if (row.bidValueFormat !== "currency") return null;
  /*
    ── ROUND 13, DEFECT 4 ────────────────────────────────────────────────────
    B1 raises a BID CAP -- a provider mutation on a purchase campaign, emitted
    at decisionState "act" -- and it carried NO recent-edit check of any kind.
    Not a weakened one: none. A campaign whose bid cap was changed yesterday
    could be told to change it again today, and a campaign whose edit history
    was never observed at all could be told to change it on no evidence.

    Both halves are required, in this order: the authority says whether the
    edit age is KNOWABLE, and the cooldown says whether a known age is too
    recent to act on. Neither implies the other.
  */
  if (recentEditAuthorityUnavailable(input.signals)) return null;
  if (recentEditCooldownActive(input.signals)) return null;
  /*
    ── ROUND 20, ITEM 2: ELIGIBILITY FIRST, AUTHORITY SECOND ────────────────

    The purchase-value authority used to be consulted BEFORE the budget, bid,
    ROAS-threshold, delivery and utilization gates below. On an account whose
    Meta-attributed AOV is missing or thin, that meant every campaign this
    emitter merely LOOKED at produced a B1 "bid headroom cannot be sized"
    hold -- including campaigns with no bid, no budget, ROAS under the
    threshold, no delivery window, or a cap already fully utilised.

    None of those are B1 candidates, so the hold was false. Worse, it was not
    merely noise: it occupied the slot the precedence chain would otherwise
    have given to C1, A1 or J1, so the operator saw a bid-cap complaint in
    place of the controlled-scale or math-floor finding that actually applied.

    Every AOV-INDEPENDENT gate therefore runs first, and only a campaign that
    would otherwise have produced a real B1 recommendation can reach the
    authority check and become a visible watch.
  */
  const budget = budgetAmount(row);
  const bid = row.bidValue ?? row.manualBidAmount;
  const threshold = Math.max(roas.p50, scaleFloor);
  if (!budget || !bid || row.roas < threshold || !deliveryWindow) return null;
  const utilization = budgetUtilization(deliveryWindow, 30);
  if (utilization == null || utilization >= 0.95) return null;
  /*
    ── ROUND 18, ITEM B5: NO /100 OR *100 ANYWHERE ──────────────────────────

    The bid arrived in minor units and was divided by 100 for display and the
    canonical unit was multiplied by 100 to compare — both hard-coded to a
    two-decimal currency. JPY has no minor unit at all (a 1000-yen cap became
    "10.00") and KWD has three (a 1.500-dinar cap became "150.00"), so the
    comparison against the purchase-value unit was wrong by a factor of 10 or
    100 on those accounts.

    The exponent is resolved from the ISO 4217 registry, which REFUSES an
    unknown or retired code rather than assuming two decimals.
  */
  const exponent = resolveMinorUnitExponent(row.currency);
  if (exponent.status !== "resolved") return null;
  const scale = 10 ** exponent.exponent;
  if (!Number.isSafeInteger(bid) || bid <= 0) return null;
  /*
    NOW the commercial authority, on an otherwise-valid B1 candidate: a real
    currency cap strategy, a budget, a positive integer bid, ROAS above the
    calibrated line, delivery evidence and utilization headroom. What such a
    campaign may still lack is a purchase VALUE to size the raise against, and
    that IS this emitter's finding -- a visible hold, not a silent drop.
  */
  /*
    ── ROUND 17: B1 IS A COMMERCIAL PURCHASE ACTION ─────────────────────────

    Raising a bid cap raises what the account is willing to PAY for a purchase,
    so it is a purchase-budget action in every sense that matters — and it was
    authorised by a ratio alone: ROAS above the calibrated p50 and the scale
    floor. Neither of those is a value. An account whose Meta-attributed AOV is
    missing, thin, or from a different account/cutoff could raise its cap on a
    percentile comparison with nothing underneath it.

    The shared authority is the same one the ad-set path uses: with a positive
    Target ROAS the only admissible unit is READY same-account, same-cutoff
    Meta-attributed AOV over that ratio. A refusal is a HOLD here, not a
    downgrade to a weaker anchor — Target CPA, operator AOV and Shopify AOV stay
    inert exactly as the commercial rule requires.
  */
  const purchaseValue = resolveMetaPurchaseValueAuthority(input.commercialTargets);
  if (!purchaseValue.authorized) {
    // ROUND 19, ITEM B4: visible, not silent.
    return purchaseValueHold({
      row,
      type: "scenario_b1_capped_winner_bid_raise",
      lens: "volume",
      blocker: purchaseValue.blocker,
      title: `${row.name}: bid headroom cannot be sized`,
      why: "A capped winner needs bid room, but the account's purchase value unit (Meta-attributed AOV over Target ROAS) is missing or too thin to divide, so no cap can be proposed.",
      scenarioInput: input,
    });
  }
  /*
    THE PROPOSAL IS CONSTRAINED BY THE CANONICAL UNIT, not merely permitted by
    a ratio. The unit is what one purchase may cost at the configured Target
    ROAS; a bid cap above it is an instruction to overpay, so the band is
    clipped to it rather than applied blind.
  */
  const raised = applyPercentToMinorUnits(bid, 10, "increase");
  if (raised.status !== "ok") return null;
  const unitMinor = Math.round(purchaseValue.unit * scale);
  if (!Number.isSafeInteger(unitMinor) || unitMinor <= 0) return null;
  const proposedMinor = Math.min(raised.minorUnits, unitMinor);
  // A cap already at or above the canonical unit has no headroom to buy: the
  // action would be a no-op or an overpay, so there is nothing to propose.
  if (proposedMinor <= bid) return null;
  const constrainedBid = {
    current: bid,
    proposed: proposedMinor,
    range: { low: proposedMinor, high: proposedMinor },
    currency: exponent.currency,
    minorUnitExponent: exponent.exponent,
  };
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold });
  return baseCampaignRec({
    row,
    type: "scenario_b1_capped_winner_bid_raise",
    lens: "volume",
    priority: "high",
    confidenceScore: conf,
    decisionState: "act",
    title: `${row.name}: capped winner needs bid room`,
    why: `Capped bidding is under-delivering while ROAS ${fmtRoas(row.roas)} is above calibrated p50 ${fmtRoas(roas.p50)} and the configured profit floor ${fmtRoas(scaleFloor)}.`,
    summary: "Raise the bid cap before raising budget; budget utilization is below 95%.",
    recommendedAction: "Increase the bid cap 10% and re-check delivery before any budget increase.",
    expectedImpact: "Unlock delivery without forcing budget into an auction cap.",
    evidence: [
      { label: "Budget utilization", value: `${r2(utilization * 100)}%`, tone: "warning" },
      { label: "ROAS p50", value: fmtRoas(roas.p50), tone: "neutral" },
      {
        label: "Current bid",
        /*
          ROUND 18: scaled by the RESOLVED exponent, never by a hard-coded 100.
          `formatMoney` still supplies the currency symbol the operator reads;
          what changed is that the major-unit amount handed to it is correct for
          JPY (exponent 0) and KWD (exponent 3), not only for two-decimal
          currencies.
        */
        value: formatMoney(bid / scale, exponent.currency, null),
        tone: "neutral",
      },
      ...commercialTargetEvidence(input.commercialTargets, row.currency),
    ],
    targetValue: { bid: constrainedBid },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeB4MinRoasLoosen(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (row.bidStrategyType !== "target_roas" && row.bidStrategyType !== "minimum_roas") return null;
  if (recentEditCooldownActive(input.signals) || trackingQualityIssue(input.signals)) return null;
  const roas = metric(input.context, "roas_28d");
  const scaleFloor = metaScaleRoasFloor(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d") || !scaleFloor) return null;
  const utilization = budgetUtilization(input.window.last30, 30);
  if (utilization == null || utilization >= 0.8) return null;
  const configuredTarget = row.bidValueFormat === "roas" && row.bidValue ? row.bidValue : null;
  if (!configuredTarget) return null;
  const effectiveTarget = Math.max(scaleFloor, configuredTarget, roas.p50);
  if (row.purchases < 8 || row.roas < effectiveTarget * 1.15) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: effectiveTarget,
  });
  return baseCampaignRec({
    row,
    type: "scenario_b4_min_roas_loosen",
    lens: "volume",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "test",
    decisionLabel: "tune",
    title: `${row.name}: loosen minimum ROAS carefully`,
    why: `Actual ROAS ${fmtRoas(row.roas)} is comfortably above the configured/profit target while budget utilization is only ${r2(utilization * 100)}%.`,
    summary: "The ROAS guardrail is likely restricting delivery more than needed.",
    recommendedAction: "Lower the ROAS target by 10-15% and re-check delivery before increasing budget.",
    expectedImpact: "Unlocks more delivery while keeping a profit guardrail in place.",
    evidence: [
      { label: "Budget utilization", value: `${r2(utilization * 100)}%`, tone: "warning" },
      { label: "ROAS", value: fmtRoas(row.roas), tone: "positive" },
      ...(configuredTarget ? [{ label: "Current ROAS target", value: fmtRoas(configuredTarget), tone: "neutral" as const }] : []),
      ...commercialTargetEvidence(input.commercialTargets, row.currency),
    ],
    targetValue: {
      utilization: r2(utilization),
      current_target_roas: configuredTarget,
      proposed_target_roas: r2(configuredTarget * 0.9),
    },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeB6ProfitFirstBidCapKeep(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (!isConstrainedBidStrategy(row)) return null;
  if (input.commercialTargets?.riskPosture !== "conservative") return null;
  if (recentEditCooldownActive(input.signals) || trackingQualityIssue(input.signals)) return null;
  const roas = metric(input.context, "roas_28d");
  const scaleFloor = metaScaleRoasFloor(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d") || !scaleFloor) return null;
  const utilization = budgetUtilization(input.window.last30, 30);
  if (utilization == null || utilization >= 0.95) return null;
  if (row.purchases < 8 || row.roas < Math.max(roas.p75, scaleFloor)) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: Math.max(roas.p75, scaleFloor),
  });
  return baseCampaignRec({
    row,
    type: "scenario_b6_profit_first_bid_cap_keep",
    lens: "profitability",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "watch",
    decisionLabel: "keep",
    title: `${row.name}: keep profit-first bid cap`,
    why: "Conservative commercial posture is active and the constrained bid setup is already holding profitable ROAS.",
    summary: "Do not loosen the bid cap just to chase more volume.",
    recommendedAction: "Keep the bid cap and scale only through a separate controlled-scale decision if profit remains stable.",
    expectedImpact: "Protects margin while preserving the option to scale later.",
    evidence: [
      { label: "Risk posture", value: "conservative", tone: "neutral" },
      { label: "Bid method", value: row.bidStrategyLabel ?? row.bidStrategyType ?? "constrained", tone: "neutral" },
      { label: "ROAS", value: fmtRoas(row.roas), tone: "positive" },
      ...(utilization != null ? [{ label: "Budget utilization", value: `${r2(utilization * 100)}%`, tone: "neutral" as const }] : []),
      ...commercialTargetEvidence(input.commercialTargets, row.currency),
    ],
    targetValue: {
      risk_posture: input.commercialTargets?.riskPosture ?? null,
      utilization: utilization == null ? null : r2(utilization),
    },
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
  if (recentEditAuthorityUnavailable(input.signals)) return null;
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

export function maybeC2RecentEditCooldown(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (!recentEditCooldownActive(input.signals)) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: metric(input.context, "roas_28d")?.p50 ?? (row.roas || 1),
  });
  return baseCampaignRec({
    row,
    type: "scenario_c2_recent_edit_cooldown",
    lens: "structure",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "watch",
    decisionLabel: "keep",
    title: `${row.name}: recent edit cooldown`,
    why: "Signal table shows a significant edit inside the 7-day cooldown window.",
    summary: "Hold hard budget and rebuild actions until the edit has enough post-change data.",
    recommendedAction: "Wait for the cooldown window to clear before judging scale, cut, or rebuild actions.",
    expectedImpact: "Reduces false decisions from Meta learning reset and post-edit volatility.",
    evidence: [
      { label: "Days since edit", value: String(input.signals?.daysSinceSignificantEdit ?? 0), tone: "warning" },
      { label: "Cooldown", value: "7 days", tone: "neutral" },
    ],
    targetValue: {
      days_since_significant_edit: input.signals?.daysSinceSignificantEdit ?? null,
      cooldown_until: input.signals?.recentChangeCooldownUntil ?? null,
    },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeH1TrackingQualityDiagnostic(input: CampaignScenarioInput): MetaRecommendation | null {
  if (!trackingQualityIssue(input.signals)) return null;
  const row = input.window.selected;
  const tracking = sourceRecord(input.signals, "tracking_quality");
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: metric(input.context, "roas_28d")?.p50 ?? (row.roas || 1),
  });
  return baseCampaignRec({
    row,
    type: "scenario_h1_dedup_tracking",
    lens: "structure",
    priority: "high",
    confidenceScore: { ...conf, label: "medium", score: Math.min(conf.score, 0.69) },
    decisionState: "test",
    decisionLabel: "diagnose",
    title: `${row.name}: diagnose click-to-LPV tracking`,
    why: "Ad-level signal shows a dense click sample with unusually low landing page view capture.",
    summary: "Do not cut or scale from purchase output until the click-to-LPV drop is explained.",
    recommendedAction: "Check landing page load, redirect, Pixel/CAPI event capture, and broken URL paths before performance action.",
    expectedImpact: "Separates a real sales problem from a measurement or landing-page quality problem.",
    evidence: [
      { label: "Link clicks", value: String(numberFromRecord(tracking, "link_clicks") ?? 0), tone: "neutral" },
      { label: "Landing page views", value: String(numberFromRecord(tracking, "landing_page_views") ?? 0), tone: "warning" },
      { label: "LPV / click", value: `${r2((numberFromRecord(tracking, "landing_page_view_rate") ?? 0) * 100)}%`, tone: "warning" },
    ],
    targetValue: tracking ?? { tracking_quality_status: input.signals?.trackingQualityStatus ?? null },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeF3BudgetPacingCooldown(input: CampaignScenarioInput): MetaRecommendation | null {
  if (monthlyPacingStatus(input.signals) !== "overpaced") return null;
  const row = input.window.selected;
  const pacing = sourceRecord(input.signals, "monthly_pacing");
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: metric(input.context, "roas_28d")?.p50 ?? (row.roas || 1),
  });
  return baseCampaignRec({
    row,
    type: "scenario_f3_budget_change_cooldown",
    lens: "volume",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "watch",
    decisionLabel: "diagnose",
    title: `${row.name}: monthly pacing cooldown`,
    why: "MTD spend is materially ahead of the elapsed monthly budget pace.",
    summary: "Avoid budget increases until pacing normalizes or the monthly target is intentionally raised.",
    recommendedAction: "Hold scale actions and review monthly budget intent before changing bids or budgets.",
    expectedImpact: "Prevents compounding an already overpaced spend curve.",
    evidence: [
      { label: "Pace ratio", value: `${r2(numberFromRecord(pacing, "pace_ratio") ?? 0)}x`, tone: "warning" },
      { label: "MTD spend", value: formatMoney(numberFromRecord(pacing, "mtd_spend") ?? 0, row.currency, null), tone: "warning" },
      { label: "Expected MTD spend", value: formatMoney(numberFromRecord(pacing, "expected_mtd_spend") ?? 0, row.currency, null), tone: "neutral" },
    ],
    targetValue: pacing ?? { monthly_pacing_status: "overpaced" },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeA2StructuralRebuild(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const roas = metric(input.context, "roas_28d");
  const cpa = metric(input.context, "cpa_28d");
  const cutCeiling = metaCutRoasReviewCeiling(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  if (!cutCeiling) return null;
  /*
    ROUND 12. maybeA2StructuralRebuild emits decisionState "act", so it is a
    purchase-budget hard action and may not be decided on an edit age nobody
    measured. An entity with no resolvable provider account, no trusted IANA
    timezone, or a failed config-history read carries a null day count that the
    cooldown test above passes; this holds it instead. A trusted zone whose
    history simply contains no significant edit is READY and still emits.
  */
  if (recentEditAuthorityUnavailable(input.signals)) return null;
  if (recentEditCooldownActive(input.signals) || trackingQualityIssue(input.signals)) return null;
  const maturity = metaLossBudgetMaturity({
    targets: input.commercialTargets,
    accountCpaBaseline: cpa?.p50 ?? null,
    calibratedHardCutSpend:
      input.context?.thresholds.hardCutSpend ??
      LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend,
  });
  if (!maturity || row.spend < maturity.spendThreshold) return null;
  if (!input.signals?.learningState || input.signals.learningState === "LEARNING") return null;
  if (historyAgeDays(input.window) < 7 || row.roas >= roas.p25 || row.roas >= cutCeiling) return null;
  const conf = confidence({ level: "campaign", context: input.context, metricValue: row.roas, threshold: Math.min(roas.p25, cutCeiling), severeLoser: row.roas <= Math.min(roas.p10, cutCeiling) });
  return enforceMetaCommercialActionAuthority(baseCampaignRec({
    row,
    type: "scenario_a2_learning_weak_structural",
    lens: "structure",
    priority: "high",
    confidenceScore: conf,
    decisionState: "act",
    title: `${row.name}: rebuild weak structure`,
    why: `ROAS ${fmtRoas(row.roas)} is below calibrated p25 ${fmtRoas(roas.p25)} and the configured loss floor ${fmtRoas(cutCeiling)} after mature loss-budget spend.`,
    summary: "Do not wait for learning to rescue a severe underperformer.",
    recommendedAction: "Rebuild with cleaner audience, creative, and optimization separation before adding budget.",
    expectedImpact: "Stops budget from compounding through a structurally weak setup.",
    evidence: [
      { label: "Spend", value: formatMoney(row.spend, row.currency, null), tone: "warning" },
      { label: "ROAS", value: fmtRoas(row.roas), tone: "warning" },
      { label: "ROAS p25", value: fmtRoas(roas.p25), tone: "neutral" },
      { label: "Loss maturity spend", value: formatMoney(maturity.spendThreshold, row.currency, null), tone: "neutral" },
      ...commercialTargetEvidence(input.commercialTargets, row.currency),
    ],
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  }), input.commercialTargets);
}

export function maybeA3LearningOnPaceWait(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (input.signals?.learningState !== "LEARNING") return null;
  const roas = metric(input.context, "roas_28d");
  const cpa = metric(input.context, "cpa_28d");
  if (!roas || !sampleReady(input.context, "roas_28d")) return null;
  const purchases7d = numberFromSource(input.signals, "purchases_7d") ?? input.window.last7?.purchases ?? row.purchases;
  const onPaceByRoas = row.roas >= roas.p25;
  const onPaceByCpa = Boolean(cpa && row.cpa > 0 && row.cpa <= cpa.p75);
  if (purchases7d < 2 || (!onPaceByRoas && !onPaceByCpa)) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: roas.p25,
  });
  return baseCampaignRec({
    row,
    type: "scenario_a3_learning_on_pace_wait",
    lens: "structure",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "watch",
    decisionLabel: "keep",
    title: `${row.name}: learning is on pace`,
    why: "Campaign is still in learning, but recent purchase pace and efficiency are not weak enough to justify intervention.",
    summary: "Hold hard changes while Meta exits learning unless another blocker appears.",
    recommendedAction: "Do not scale, cut, or rebuild yet; wait for the learning window to mature.",
    expectedImpact: "Avoids resetting a campaign that still has a viable learning signal.",
    evidence: [
      { label: "Learning state", value: "LEARNING", tone: "neutral" },
      { label: "7d purchases", value: String(r2(purchases7d)), tone: "positive" },
      { label: "ROAS p25", value: fmtRoas(roas.p25), tone: "neutral" },
    ],
    targetValue: {
      purchases_7d: purchases7d,
      roas_p25: roas.p25,
      cpa_p75: cpa?.p75 ?? null,
    },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeG1UpperFunnelEvent(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (!isPurchaseOptimizedCampaign(input)) return null;
  if (recentEditCooldownActive(input.signals) || trackingQualityIssue(input.signals)) return null;
  const ageDays = sourceAgeDays(input);
  const purchaseSignal = purchases7d(input);
  if (ageDays == null || ageDays < 7 || purchaseSignal >= 50) return null;
  const candidate = bestUpperFunnelEvent(row, purchaseSignal);
  if (!candidate) return null;
  const roas = metric(input.context, "roas_28d");
  const purchaseSignalWeak =
    row.purchases < 8 ||
    input.signals?.learningState === "LEARNING_LIMITED" ||
    Boolean(roas && sampleReady(input.context, "roas_28d") && row.roas < roas.p50);
  if (!purchaseSignalWeak) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: roas?.p50 ?? (row.roas || 1),
  });
  return baseCampaignRec({
    row,
    type: "scenario_g1_upper_funnel_event",
    lens: "structure",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "test",
    decisionLabel: "switch",
    title: `${row.name}: test upper-funnel optimization event`,
    why: `Purchase optimization has only ${r2(purchaseSignal)} purchases in the recent window, while ${candidate.label.toLowerCase()} has a stronger same-campaign signal.`,
    summary: "Treat this as a signal-density problem before cutting the campaign.",
    recommendedAction: `Test a separate ${candidate.event} optimization lane instead of forcing more spend into a thin purchase event.`,
    expectedImpact: "Builds enough conversion signal to evaluate the funnel without mistaking sparse purchase data for final failure.",
    evidence: [
      { label: "7d purchases", value: String(r2(purchaseSignal)), tone: "warning" },
      { label: candidate.label, value: String(r2(candidate.count)), tone: "positive" },
      { label: "Age", value: `${r2(ageDays)}d`, tone: "neutral" },
    ],
    targetValue: {
      current_event: row.customEventType ?? row.optimizationGoal ?? "PURCHASE",
      proposed_event: candidate.event,
      purchase_signal_7d: r2(purchaseSignal),
      candidate_event_count_28d: r2(candidate.count),
      candidate_event_cost: candidate.cost == null ? null : r2(candidate.cost),
    },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeG2DownshiftToPurchase(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (isPurchaseOptimizedCampaign(input)) return null;
  if (recentEditCooldownActive(input.signals) || trackingQualityIssue(input.signals)) return null;
  const currentEvent = explicitPrePurchaseOptimizationEvent(input);
  if (!currentEvent) return null;
  const recentPurchases = explicitPurchases7d(input);
  if (recentPurchases == null) return null;
  const roas = metric(input.context, "roas_28d");
  const scaleFloor = metaScaleRoasFloor(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d") || !scaleFloor) return null;
  const purchaseFloor = minRecentPurchaseSample(input.context);
  if (recentPurchases < purchaseFloor || row.purchases < purchaseFloor) return null;
  const threshold = Math.max(roas.p50, scaleFloor);
  if (row.roas < threshold) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold,
  });
  return baseCampaignRec({
    row,
    type: "scenario_g2_downshift_to_purchase",
    lens: "structure",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "test",
    decisionLabel: "switch",
    title: `${row.name}: test purchase optimization lane`,
    why: `${currentEvent.label} optimization is producing enough recent purchase signal and ROAS is above both account median and configured profit floor.`,
    summary: "The campaign no longer needs a shallower event to collect signal.",
    recommendedAction: "Test a separate PURCHASE optimization lane with bounded budget instead of continuing to scale the pre-purchase event.",
    expectedImpact: "Moves optimization closer to the business outcome while keeping the event switch isolated from the incumbent lane.",
    evidence: [
      { label: "Current event", value: currentEvent.label, tone: "neutral" },
      { label: "7d purchases", value: String(r2(recentPurchases)), tone: "positive" },
      { label: "ROAS", value: fmtRoas(row.roas), tone: "positive" },
      { label: "ROAS p50", value: fmtRoas(roas.p50), tone: "neutral" },
      ...commercialTargetEvidence(input.commercialTargets, row.currency),
    ],
    targetValue: {
      current_event: currentEvent.event,
      proposed_event: "PURCHASE",
      purchase_signal_7d: r2(recentPurchases),
      purchase_floor: purchaseFloor,
      roas_threshold: threshold,
    },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeA5PostLearningUnderperformer(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (input.signals?.learningState !== "OPTIMAL_LEARNING_DONE") return null;
  const learningExit = learningExitEvidence(input.signals);
  if (!learningExit) return null;
  /*
    ROUND 12. maybeA5PostLearningUnderperformer emits decisionState "act at confidence >= 0.7", so it is a
    purchase-budget hard action and may not be decided on an edit age nobody
    measured. An entity with no resolvable provider account, no trusted IANA
    timezone, or a failed config-history read carries a null day count that the
    cooldown test above passes; this holds it instead. A trusted zone whose
    history simply contains no significant edit is READY and still emits.
  */
  if (recentEditAuthorityUnavailable(input.signals)) return null;
  if (recentEditCooldownActive(input.signals) || trackingQualityIssue(input.signals)) return null;
  const roas = metric(input.context, "roas_28d");
  const cpa = metric(input.context, "cpa_28d");
  const cutCeiling = metaCutRoasReviewCeiling(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d") || !cutCeiling) return null;
  if (historyAgeDays(input.window) < 14 || row.roas >= roas.p50 || row.roas >= cutCeiling) return null;
  const maturity = metaLossBudgetMaturity({
    targets: input.commercialTargets,
    accountCpaBaseline: cpa?.p50 ?? null,
    calibratedHardCutSpend:
      input.context?.thresholds.hardCutSpend ??
      LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend,
  });
  if (!maturity || row.spend < maturity.spendThreshold) return null;
  const threshold = Math.min(roas.p50, cutCeiling);
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold,
    severeLoser: row.roas <= Math.min(roas.p25, cutCeiling),
  });
  return enforceMetaCommercialActionAuthority(baseCampaignRec({
    row,
    type: "scenario_a5_post_learning_underperformer",
    lens: "profitability",
    priority: row.roas <= Math.min(roas.p25, cutCeiling) ? "high" : "medium",
    confidenceScore: conf,
    decisionState: conf.score >= 0.7 ? "act" : "test",
    decisionLabel: "cut",
    title: `${row.name}: post-learning underperformer`,
    why: `Learning is complete, but ROAS ${fmtRoas(row.roas)} is below calibrated p50 ${fmtRoas(roas.p50)} and the configured loss floor ${fmtRoas(cutCeiling)} after mature loss-budget spend.`,
    summary: "This is no longer an early-learning patience problem.",
    recommendedAction: "Reduce budget pressure or rebuild the campaign before giving it more spend.",
    expectedImpact: "Stops mature underperformance from absorbing additional budget.",
    evidence: [
      { label: "Learning state", value: "complete", tone: "neutral" },
      {
        label: "Post-learning age",
        value: learningExit.daysAtLearningState != null ? `${learningExit.daysAtLearningState}d` : "exit recorded",
        tone: "neutral",
      },
      { label: "ROAS", value: fmtRoas(row.roas), tone: "warning" },
      { label: "ROAS p50", value: fmtRoas(roas.p50), tone: "neutral" },
      { label: "Loss maturity spend", value: formatMoney(maturity.spendThreshold, row.currency, null), tone: "neutral" },
      ...commercialTargetEvidence(input.commercialTargets, row.currency),
    ],
    targetValue: {
      roas_p50: roas.p50,
      cut_ceiling: cutCeiling,
      maturity_spend: maturity.spendThreshold,
      learning_exit_at: learningExit.learningExitAt,
      days_at_learning_state: learningExit.daysAtLearningState,
    },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  }), input.commercialTargets);
}

export function maybeK4CatalogFeedFirst(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  if (!isCatalogCampaign(input)) return null;
  const feed = feedDiagnostic(input);
  if (!feed) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: metric(input.context, "roas_28d")?.p50 ?? (row.roas || 1),
  });
  return baseCampaignRec({
    row,
    type: "scenario_k4_catalog_feed_first",
    lens: "structure",
    priority: "high",
    confidenceScore: { ...conf, label: "medium", score: Math.min(conf.score, 0.69) },
    decisionState: "test",
    decisionLabel: "diagnose",
    title: `${row.name}: fix catalog feed before judging performance`,
    why: "Catalog/DPA campaign has explicit feed issue evidence, so delivery quality may be constrained before media buying logic is judged.",
    summary: "Resolve catalog/feed health before scale, cut, or rebuild decisions.",
    recommendedAction: "Audit feed approval, item disapprovals, product availability, and catalog match quality before budget action.",
    expectedImpact: "Prevents cutting or restructuring a campaign whose delivery is limited by catalog health.",
    evidence: [
      { label: "Feed status", value: feed.status, tone: "warning" },
      { label: "Disapproved items", value: String(r2(feed.disapprovalCount)), tone: feed.disapprovalCount > 0 ? "warning" : "neutral" },
    ],
    targetValue: feed.source ?? {
      feed_status: feed.status,
      feed_disapproval_count: feed.disapprovalCount,
    },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

export function maybeC3ScaleSampleGate(input: CampaignScenarioInput): MetaRecommendation | null {
  const row = input.window.selected;
  const roas = metric(input.context, "roas_28d");
  const scaleFloor = metaScaleRoasFloor(input.commercialTargets);
  if (!roas || !sampleReady(input.context, "roas_28d") || !scaleFloor) return null;
  if (recentEditCooldownActive(input.signals) || trackingQualityIssue(input.signals)) return null;
  const scaleThreshold = Math.max(roas.p75, scaleFloor);
  if (row.roas < scaleThreshold) return null;
  const ageDays = historyAgeDays(input.window);
  const purchaseSampleThin = row.purchases > 0 && row.purchases < 8;
  const historyTooYoung = ageDays < 28;
  if (!purchaseSampleThin && !historyTooYoung) return null;
  const conf = confidence({
    level: "campaign",
    context: input.context,
    metricValue: row.roas,
    threshold: scaleThreshold,
  });
  return baseCampaignRec({
    row,
    type: "scenario_c3_scale_sample_gate",
    lens: "volume",
    priority: "medium",
    confidenceScore: { ...conf, label: conf.label === "high" ? "medium" : conf.label },
    decisionState: "watch",
    decisionLabel: "test_more",
    title: `${row.name}: scale sample gate`,
    why: `ROAS is above the scale line, but the campaign has only ${row.purchases} purchases or less than 28 days of history.`,
    summary: "Treat this as a promising candidate, not a scale action yet.",
    recommendedAction: "Keep testing until purchase depth and history clear the scale sample gate.",
    expectedImpact: "Prevents false winner promotion from a thin positive sample.",
    evidence: [
      { label: "ROAS", value: fmtRoas(row.roas), tone: "positive" },
      { label: "Scale threshold", value: fmtRoas(scaleThreshold), tone: "neutral" },
      { label: "Purchases", value: String(row.purchases), tone: purchaseSampleThin ? "warning" : "positive" },
      { label: "History age", value: `${ageDays}d`, tone: historyTooYoung ? "warning" : "positive" },
    ],
    targetValue: {
      purchase_floor: 8,
      history_floor_days: 28,
      scale_threshold: scaleThreshold,
    },
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
      { label: "7d spend", value: formatMoney(last7.spend, row.currency, null), tone: "warning" },
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
  /*
    ONLY A TRUSTED CANONICAL `test` KIND MAY EMIT THIS (Codex C19).

    This read `${input.campaignRole ?? ""} ${row.name}`.toLowerCase() and fired
    on the substring "test". Two ways that is wrong, and both produce an
    ACTIONABLE `decisionState: "act"` telling an operator to rebuild a
    campaign:

      - CAMPAIGN NAME TEXT. "Latest Winners", "Contest — March", "Protest
        Creative" all contain "test". None of them is a test campaign, and the
        operator is told to tear down a live one.
      - LEGACY / UNTRUSTED ROLE. `campaignRole` is partly name-derived
        (`inferCampaignRole` regexes names), so it carries the same defect one
        layer up, and it says nothing about whether the role was TRUSTED.

    The canonical kind is the resolver's own answer, and
    `campaignKindTrustedForAction` is the four-fact predicate that decides
    whether it may bear authority. An unresolved or medium-trust `test` holds:
    the structural verdict is not published as an action on a role nobody has
    proven.
  */
  if (input.campaignKind !== "test") return null;
  if (input.campaignKindTrustedForAction !== true) return null;
  if (row.budgetLevel !== "campaign") return null;
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
  const budget = budgetAmount(row);
  /*
    ── ROUND 18, ITEM B7: CPA IS NOT A PRECONDITION UNDER A TARGET ROAS ─────
    The `cpa_28d` lookup used to gate the whole scenario, so an account governed
    by a Target ROAS with a perfectly READY Meta AOV was silently skipped
    whenever its CPA percentile happened to be absent — a value it is not
    allowed to use. The lookup now lives in the legacy branch that actually
    consumes it.
  */
  if (!budget || historyAgeDays(input.window) < 7) return null;
  if (!input.signals?.learningState || input.signals.learningState === "OPTIMAL_LEARNING_DONE") return null;
  /*
    ── ROUND 13, DEFECT 4 ────────────────────────────────────────────────────
    A1 proposes changing the OPTIMIZATION EVENT, which resets learning outright
    -- the most disruptive change in this file -- at decisionState "act", and it
    too carried no recent-edit check. Proposing an event change on a campaign
    that was reconfigured two days ago compounds the very learning reset it is
    trying to escape, and proposing one where the edit history was never
    observed does it blind.
  */
  if (recentEditAuthorityUnavailable(input.signals)) return null;
  if (recentEditCooldownActive(input.signals)) return null;
  /*
    ── ROUND 17: THE LEARNING FLOOR IS SIZED FROM THE CANONICAL UNIT ────────

    A1 asks "can this budget fund 50 conversions a week?" — a question about
    what a conversion COSTS. It answered with `cpa_28d.p50`, the account's
    observed cost percentile, even on accounts governed by a positive Target
    ROAS. That is the substitution the commercial rule forbids: under a Target
    ROAS the only admissible unit is READY same-account, same-cutoff
    Meta-attributed AOV over that ratio, and an account CPA is descriptive, not
    authoritative. Two accounts with identical targets and AOV could get
    different verdicts because their observed CPA percentiles differed.

    So: with a positive Target ROAS the divisor is the canonical unit and a
    missing or thin sample is a HOLD. Without one, the legacy CPA percentile is
    preserved exactly — it remains the compatibility path, not a fallback the
    Target ROAS case may drop into.
  */
  const targetRoas = normalizeMetaCommercialTargets(input.commercialTargets).targetRoas;
  const governedByTargetRoas =
    typeof targetRoas === "number" && Number.isFinite(targetRoas) && targetRoas > 0;
  let conversionCost: number;
  if (governedByTargetRoas) {
    const purchaseValue = resolveMetaPurchaseValueAuthority(input.commercialTargets);
    // HOLD rather than fall back: the account has told us how it measures
    // value, and we cannot measure it. CPA is never consulted on this branch.
    // ROUND 19, ITEM B4: the hold is VISIBLE rather than a silent null.
    if (!purchaseValue.authorized) {
      return purchaseValueHold({
        row,
        type: "scenario_a1_math_floor_unmet",
        lens: "structure",
        blocker: purchaseValue.blocker,
        title: `${row.name}: learning floor cannot be sized`,
        why: "Whether this budget can fund the learning floor depends on what a purchase is worth, and the account's purchase value unit (Meta-attributed AOV over Target ROAS) is missing or too thin to divide.",
        scenarioInput: input,
      });
    }
    conversionCost = purchaseValue.unit;
  } else {
    // LEGACY COMPATIBILITY ONLY. Without a Target ROAS the account has not told
    // us how it measures value, and the observed CPA percentile is the anchor
    // exactly as it always was — including being REQUIRED here.
    const cpa = metric(input.context, "cpa_28d");
    if (!cpa) return null;
    conversionCost = cpa.p50;
  }
  if (!Number.isFinite(conversionCost) || conversionCost <= 0) return null;
  const possibleWeeklyConversions = (budget * 7) / conversionCost;
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
    why: `Weekly budget can fund about ${r2(possibleWeeklyConversions)} conversions at ${
      governedByTargetRoas
        ? "the account's purchase value unit"
        : "calibrated CPA p50"
    }, below the 50-conversion learning target.`,
    summary: "Waiting will not solve a budget-to-signal math problem.",
    recommendedAction: "Switch to an upper-funnel optimization event or rebuild with warmer/lower-cost signal before waiting.",
    expectedImpact: "Moves the campaign toward enough signal density to learn.",
    evidence: [
      { label: "Possible weekly conversions", value: String(r2(possibleWeeklyConversions)), tone: "warning" },
      {
        // Named for what it IS, and explained truthfully: printing "CPA p50"
        // while dividing by the canonical unit would attribute the verdict to a
        // number that did not produce it.
        label: governedByTargetRoas
          ? "Purchase value unit (Meta AOV / Target ROAS)"
          : "CPA p50 (no Target ROAS configured)",
        value: formatMoney(conversionCost, row.currency, null),
        tone: "neutral",
      },
      { label: "Daily budget", value: formatMoney(budget, row.currency, null), tone: "neutral" },
    ],
    targetValue: { current_event: row.optimizationGoal, proposed_event: "ADD_TO_CART_OR_INITIATE_CHECKOUT" },
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
    cohort: input.cohort,
    signals: input.signals,
  });
}

const CAMPAIGN_PRECEDENCE = [
  maybeC2RecentEditCooldown,
  maybeH1TrackingQualityDiagnostic,
  maybeF3BudgetPacingCooldown,
  maybeK4CatalogFeedFirst,
  maybeA3LearningOnPaceWait,
  maybeG1UpperFunnelEvent,
  maybeG2DownshiftToPurchase,
  maybeA2StructuralRebuild,
  maybeA5PostLearningUnderperformer,
  maybeK1MixedConfig,
  maybeI4TestShouldUseAbo,
  maybeF1SuddenRoasDrop,
  maybeF4StableWinnerFade,
  maybeE2CtrDecay,
  maybeE4CreativeAge,
  maybeC3ScaleSampleGate,
  maybeB4MinRoasLoosen,
  maybeB6ProfitFirstBidCapKeep,
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
