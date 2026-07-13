import { createHash } from "node:crypto";

export const STRUCTURE_REPLAY_CONTRACT_VERSION =
  "adsecute.meta.native-structure-paired-replay.v2" as const;

export const STRUCTURE_OUTCOME_WINDOWS = [3, 7, 14] as const;

export const STRUCTURE_REPLAY_CADENCE_ANCHOR = "2025-12-01" as const;

export const STRUCTURE_REPLAY_PHASES = [
  {
    id: "development",
    startDate: "2025-12-01",
    endDate: "2026-03-31",
    outcomeCeiling: "2026-03-31",
  },
  {
    id: "calibration",
    startDate: "2026-04-01",
    endDate: "2026-05-31",
    outcomeCeiling: "2026-05-31",
  },
  {
    id: "locked_test",
    startDate: "2026-06-01",
    endDate: "2026-07-05",
    outcomeCeiling: "2026-07-11",
  },
] as const;

export const H7_STRUCTURE_MATURITY_GRID = {
  ageDays: [7, 14, 21, 28],
  purchaseThresholds: [5, 8, 10, "half_peer_winner_p50"],
  utilization: [0.7, 0.8, 0.9, 0.95],
} as const;

export const H9_STRUCTURE_HISTORY_LOOKBACK_DAYS = 224 as const;

export const H9_ANNUAL_SEASONALITY_ELIMINATION_REASON =
  "Month-of-year and year-over-year seasonality are eliminated: the 224-day history lookback is shorter than one 365-day annual cycle, so those effects are not estimable." as const;

export const H9_ANNUAL_SEASONALITY_ELIMINATION = {
  status: "eliminated",
  modes: ["month_of_year", "year_over_year"],
  historyLookbackDays: H9_STRUCTURE_HISTORY_LOOKBACK_DAYS,
  minimumAnnualCycleDays: 365,
  reason: H9_ANNUAL_SEASONALITY_ELIMINATION_REASON,
} as const;

export const H9_STRUCTURE_HISTORY_GRID = {
  halfLifeDays: [7, 14, 28, 56],
  supportDays: [1, 2, 3],
  seasonalityModes: ["none", "day_of_week_match"],
} as const;

export type StructureGrain = "campaign" | "adset";
export type StructureOutcomeWindowDays =
  (typeof STRUCTURE_OUTCOME_WINDOWS)[number];
export type StructureReplayPhase =
  (typeof STRUCTURE_REPLAY_PHASES)[number]["id"];
export type StructureCohort =
  | "purchase"
  | "mid_funnel"
  | "lead"
  | "traffic"
  | "upper_funnel"
  | "engagement"
  | "unknown";
export type StructureBidRegime =
  "lowest_cost" | "cost_cap" | "bid_cap" | "minimum_roas" | "unknown";
export type StructurePurchaseThreshold =
  (typeof H7_STRUCTURE_MATURITY_GRID.purchaseThresholds)[number];
export type StructureHistoryHalfLifeDays =
  (typeof H9_STRUCTURE_HISTORY_GRID.halfLifeDays)[number];
export type StructureSeasonalityMode =
  (typeof H9_STRUCTURE_HISTORY_GRID.seasonalityModes)[number];
export type StructureHistorySignalKey =
  `hl${StructureHistoryHalfLifeDays}|seasonality:${StructureSeasonalityMode}`;
export type StructureOutcomeStatus =
  "supported" | "refuted" | "neutral" | "unknown" | "censored";
export type StructureBudgetOwner = StructureGrain | "unknown";
export type StructureBudgetOrigin =
  "campaign_config" | "adset_config" | "collapsed_effective_budget" | "missing";
export type StructureAuthority = "actionable" | "review_only" | "blocked";

export interface StructureVariant {
  id: string;
  ageDays: (typeof H7_STRUCTURE_MATURITY_GRID.ageDays)[number];
  purchaseThreshold: StructurePurchaseThreshold;
  utilization: (typeof H7_STRUCTURE_MATURITY_GRID.utilization)[number];
  halfLifeDays: StructureHistoryHalfLifeDays;
  supportDays: (typeof H9_STRUCTURE_HISTORY_GRID.supportDays)[number];
  seasonality: StructureSeasonalityMode;
}

export interface StructureHistorySignal {
  weightedRoas: number | null;
  weightedCostPerResult: number | null;
  peerRoasP75: number | null;
  peerCostPerResultP25: number | null;
  peerWinnerPurchaseP50: number | null;
  peerWinnerOutcomeCountP50: number | null;
  consecutiveSupportDays: number;
  peerCount: number;
}

export interface StructureWindowOutcome {
  windowDays: StructureOutcomeWindowDays;
  completeReceipt: boolean;
  status: StructureOutcomeStatus;
  criticalRefutation: boolean;
  futureSpend: number;
  futureConversions: number;
  futureRevenue: number;
  futureRoas: number | null;
  futureCostPerResult: number | null;
}

export interface StructureOpportunity {
  grain: StructureGrain;
  entityId: string;
  businessId: string;
  accountId: string;
  currency: string;
  goalKey: string;
  cohort: StructureCohort;
  bidRegime: StructureBidRegime;
  bidValue: number | null;
  bidValueFormat: string | null;
  bidContextReconstructable: boolean;
  asOfDate: string;
  ageDays: number;
  cumulativePurchases: number;
  cumulativeConversions: number;
  budgetUtilization: number | null;
  budgetOwner: StructureBudgetOwner;
  budgetOrigin: StructureBudgetOrigin;
  budgetOwnerReconstructable: boolean;
  statusReconstructable: boolean;
  configCutoffSafe: boolean;
  targetCutoffSafe: boolean;
  targetFresh: boolean;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
  completeOutcomeReceipt: boolean;
  purchaseCohort: boolean;
  history: Partial<Record<StructureHistorySignalKey, StructureHistorySignal>>;
  outcome: StructureOutcomeStatus;
  criticalRefutation: boolean;
  outcomes: Partial<Record<StructureOutcomeWindowDays, StructureWindowOutcome>>;
}

export interface StructureHistoryDailyFact {
  date: string;
  spend: number;
  revenue: number;
  conversions?: number;
}

export interface StructureCandidateEvaluation {
  candidate: boolean;
  authority: StructureAuthority;
  action: "increase_campaign_budget" | "increase_adset_budget" | "none";
  requiredPurchases: number | null;
  requiredOutcomes: number | null;
  reasonCodes: string[];
}

export interface StructureVariantScore {
  variantId: string;
  fixedCohortSize: number;
  scoreableCohortSize: number;
  candidateCount: number;
  supportedCandidates: number;
  refutedCandidates: number;
  neutralCandidates: number;
  unknownCandidates: number;
  censoredCandidates: number;
  criticalFalsePositives: number;
  supportedOpportunities: number;
  trueNegative: number;
  falseNegative: number;
  precision: number | null;
  precisionWilsonLower95: number | null;
  opportunityRecall: number | null;
  criticalFalsePositiveRate: number | null;
  candidateCoverage: number | null;
  rankScore: number | null;
}

export interface StructureOutcomeInput {
  completeReceipt: boolean;
  cohort?: StructureCohort;
  futureSpend: number;
  futurePurchases: number;
  futureConversions?: number;
  futureRoas: number | null;
  futureCostPerResult?: number | null;
  targetRoas?: number | null;
  breakEvenRoas?: number | null;
  peerCount: number;
  peerRoasP25: number | null;
  peerRoasP50: number | null;
  peerRoasP75: number | null;
  peerCostPerResultP25?: number | null;
  peerCostPerResultP50?: number | null;
  peerCostPerResultP75?: number | null;
  peerSpendP50: number | null;
}

const DAY_MS = 86_400_000;

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function round(value: number | null, digits = 4) {
  return value === null ? null : Number(value.toFixed(digits));
}

function parseCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return timestamp;
}

export function addStructureReplayDays(value: string, days: number) {
  const timestamp = parseCalendarDate(value) + days * DAY_MS;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function differenceInStructureReplayDays(
  later: string,
  earlier: string,
) {
  return Math.round(
    (parseCalendarDate(later) - parseCalendarDate(earlier)) / DAY_MS,
  );
}

export function structureHistorySignalKey(input: {
  halfLifeDays: StructureHistoryHalfLifeDays;
  seasonality: StructureSeasonalityMode;
}): StructureHistorySignalKey {
  return `hl${input.halfLifeDays}|seasonality:${input.seasonality}`;
}

export function structureHistoryFactMatchesSeasonality(input: {
  asOfDate: string;
  factDate: string;
  seasonality: StructureSeasonalityMode;
}) {
  if (input.seasonality === "none") return true;

  const asOfWeekday = new Date(parseCalendarDate(input.asOfDate)).getUTCDay();
  const factWeekday = new Date(parseCalendarDate(input.factDate)).getUTCDay();
  return factWeekday === asOfWeekday;
}

export function buildFixedStructureOpportunityDates(input: {
  startDate: string;
  endDate: string;
  cadenceDays?: number;
  anchorDate?: string;
}) {
  const cadenceDays = input.cadenceDays ?? 7;
  if (!Number.isInteger(cadenceDays) || cadenceDays <= 0) {
    throw new Error("cadenceDays must be a positive integer");
  }
  const start = parseCalendarDate(input.startDate);
  const end = parseCalendarDate(input.endDate);
  const anchor = parseCalendarDate(input.anchorDate ?? input.startDate);
  if (start > end) throw new Error("startDate must not be after endDate");
  const cadenceMs = cadenceDays * DAY_MS;
  const offsetFromAnchor =
    (((start - anchor) % cadenceMs) + cadenceMs) % cadenceMs;
  const first =
    offsetFromAnchor === 0 ? start : start + cadenceMs - offsetFromAnchor;
  const dates: string[] = [];
  for (let cursor = first; cursor <= end; cursor += cadenceMs) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

export function buildStructureReplayProtocol(input: {
  startDate?: string;
  endDate?: string;
  cadenceDays?: number;
  anchorDate?: string;
}) {
  const startDate = input.startDate ?? STRUCTURE_REPLAY_PHASES[0].startDate;
  const endDate = input.endDate ?? STRUCTURE_REPLAY_PHASES.at(-1)!.endDate;
  const cadenceDays = input.cadenceDays ?? 7;
  const anchorDate = input.anchorDate ?? STRUCTURE_REPLAY_CADENCE_ANCHOR;
  const opportunityDates = buildFixedStructureOpportunityDates({
    startDate,
    endDate,
    cadenceDays,
    anchorDate,
  });
  const phases = Object.fromEntries(
    STRUCTURE_REPLAY_PHASES.map((phase) => {
      const phaseDates = opportunityDates.filter(
        (date) => date >= phase.startDate && date <= phase.endDate,
      );
      const eligibleDatesByWindow = Object.fromEntries(
        STRUCTURE_OUTCOME_WINDOWS.map((windowDays) => [
          windowDays,
          phaseDates.filter(
            (date) =>
              addStructureReplayDays(date, windowDays) <= phase.outcomeCeiling,
          ),
        ]),
      ) as Record<StructureOutcomeWindowDays, string[]>;
      return [
        phase.id,
        {
          ...phase,
          opportunityDates: phaseDates,
          eligibleDatesByWindow,
        },
      ];
    }),
  ) as Record<
    StructureReplayPhase,
    (typeof STRUCTURE_REPLAY_PHASES)[number] & {
      opportunityDates: string[];
      eligibleDatesByWindow: Record<StructureOutcomeWindowDays, string[]>;
    }
  >;
  return {
    cadenceDays,
    anchorDate,
    opportunityDates,
    phases,
  };
}

export function resolveStructureReplayPhase(
  date: string,
): StructureReplayPhase | null {
  const phase = STRUCTURE_REPLAY_PHASES.find(
    (candidate) => date >= candidate.startDate && date <= candidate.endDate,
  );
  return phase?.id ?? null;
}

export function buildStructureVariantGrid(): StructureVariant[] {
  const variants: StructureVariant[] = [];
  for (const ageDays of H7_STRUCTURE_MATURITY_GRID.ageDays) {
    for (const purchaseThreshold of H7_STRUCTURE_MATURITY_GRID.purchaseThresholds) {
      for (const utilization of H7_STRUCTURE_MATURITY_GRID.utilization) {
        for (const halfLifeDays of H9_STRUCTURE_HISTORY_GRID.halfLifeDays) {
          for (const supportDays of H9_STRUCTURE_HISTORY_GRID.supportDays) {
            for (const seasonality of H9_STRUCTURE_HISTORY_GRID.seasonalityModes) {
              const purchase =
                purchaseThreshold === "half_peer_winner_p50"
                  ? "half_peer_p50"
                  : `p${purchaseThreshold}`;
              variants.push({
                id: `age${ageDays}-${purchase}-util${Math.round(utilization * 100)}-hl${halfLifeDays}-support${supportDays}-seasonality-${seasonality}`,
                ageDays,
                purchaseThreshold,
                utilization,
                halfLifeDays,
                supportDays,
                seasonality,
              });
            }
          }
        }
      }
    }
  }
  return variants;
}

export function normalizeMetaBudgetMinorUnits(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value / 100;
}

export function normalizeStructureGoalKey(input: {
  customEventType?: string | null;
  optimizationGoal?: string | null;
  objective?: string | null;
}) {
  const normalize = (value: string | null | undefined) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const customEvent = normalize(input.customEventType);
  if (customEvent) return `event:${customEvent}`;
  const optimizationGoal = normalize(input.optimizationGoal);
  if (optimizationGoal) return `optimization:${optimizationGoal}`;
  const objective = normalize(input.objective);
  return objective ? `objective:${objective}` : "unknown";
}

export function structurePeerCohortKey(input: {
  grain: StructureGrain;
  businessId: string;
  accountId: string;
  currency: string;
  goalKey: string;
  cohort?: StructureCohort;
  bidRegime?: StructureBidRegime;
  asOfDate: string;
}) {
  return [
    input.grain,
    input.businessId.trim(),
    input.accountId.trim(),
    input.currency.trim().toUpperCase() || "UNKNOWN",
    input.goalKey.trim() || "unknown",
    input.cohort ?? "unknown",
    input.bidRegime ?? "unknown",
    input.asOfDate,
  ].join("|");
}

export function normalizeStructureBidRegime(input: {
  strategy: string | null;
  value: number | null;
  valueFormat: string | null;
  mixed: boolean;
}): {
  regime: StructureBidRegime;
  reconstructable: boolean;
  reason: string;
} {
  if (input.mixed) {
    return {
      regime: "unknown",
      reconstructable: false,
      reason: "bid_context_mixed_at_cutoff",
    };
  }
  const strategy = String(input.strategy ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  const constrainedValueReady =
    input.value !== null && Number.isFinite(input.value) && input.value > 0;
  if (strategy.includes("COST_CAP")) {
    return {
      regime: "cost_cap",
      reconstructable: constrainedValueReady,
      reason: constrainedValueReady
        ? "cutoff_cost_cap_with_value"
        : "cost_cap_value_missing_at_cutoff",
    };
  }
  if (strategy.includes("BID_CAP")) {
    return {
      regime: "bid_cap",
      reconstructable: constrainedValueReady,
      reason: constrainedValueReady
        ? "cutoff_bid_cap_with_value"
        : "bid_cap_value_missing_at_cutoff",
    };
  }
  if (
    strategy.includes("MINIMUM_ROAS") ||
    strategy.includes("MIN_ROAS") ||
    strategy.includes("ROAS_GOAL") ||
    strategy.includes("TARGET_ROAS")
  ) {
    return {
      regime: "minimum_roas",
      reconstructable: constrainedValueReady,
      reason: constrainedValueReady
        ? "cutoff_minimum_roas_with_value"
        : "minimum_roas_value_missing_at_cutoff",
    };
  }
  if (
    strategy.includes("LOWEST_COST") ||
    strategy === "LOW_COST" ||
    strategy === "MAXIMIZE_CONVERSIONS"
  ) {
    return {
      regime: "lowest_cost",
      reconstructable: true,
      reason: "cutoff_lowest_cost_strategy",
    };
  }
  return {
    regime: "unknown",
    reconstructable: false,
    reason: strategy
      ? `unsupported_bid_strategy:${strategy.toLowerCase()}`
      : "bid_strategy_missing_at_cutoff",
  };
}

export function resolveStructureBudgetOwner(input: {
  campaignConfigAvailable: boolean;
  campaignDailyBudget: number | null;
  campaignBudgetMixed: boolean;
  adsetConfigAvailable?: boolean;
  adsetDailyBudget?: number | null;
}): {
  owner: StructureBudgetOwner;
  origin: StructureBudgetOrigin;
  reconstructable: boolean;
  reason: string;
} {
  if (!input.campaignConfigAvailable) {
    return {
      owner: "unknown",
      origin: "missing",
      reconstructable: false,
      reason: "campaign_config_missing_at_cutoff",
    };
  }
  const campaignBudget = normalizeMetaBudgetMinorUnits(
    input.campaignDailyBudget,
  );
  const adsetBudget = normalizeMetaBudgetMinorUnits(
    input.adsetDailyBudget ?? null,
  );

  if (input.campaignBudgetMixed && adsetBudget !== null) {
    return {
      owner: "adset",
      origin: "adset_config",
      reconstructable: Boolean(input.adsetConfigAvailable),
      reason: input.adsetConfigAvailable
        ? "mixed_campaign_budget_with_cutoff_adset_budget"
        : "adset_budget_without_cutoff_adset_config",
    };
  }
  if (campaignBudget === null && adsetBudget !== null) {
    return {
      owner: "adset",
      origin: "adset_config",
      reconstructable: Boolean(input.adsetConfigAvailable),
      reason: input.adsetConfigAvailable
        ? "campaign_budget_absent_with_cutoff_adset_budget"
        : "adset_budget_without_cutoff_adset_config",
    };
  }
  if (campaignBudget !== null && !input.campaignBudgetMixed) {
    return {
      owner: "campaign",
      origin: "collapsed_effective_budget",
      reconstructable: false,
      reason: "effective_budget_could_be_campaign_or_equal_adset_fallback",
    };
  }
  return {
    owner: "unknown",
    origin: "missing",
    reconstructable: false,
    reason: "budget_owner_not_reconstructable",
  };
}

export function structureRecencyWeight(ageDays: number, halfLifeDays: number) {
  if (
    !Number.isFinite(ageDays) ||
    ageDays < 0 ||
    !Number.isFinite(halfLifeDays) ||
    halfLifeDays <= 0
  ) {
    return null;
  }
  return 2 ** (-ageDays / halfLifeDays);
}

export function calculateStructureWeightedRoas(input: {
  facts: readonly StructureHistoryDailyFact[];
  startDate: string;
  asOfDate: string;
  halfLifeDays: number;
  seasonality: StructureSeasonalityMode;
}) {
  return calculateStructureWeightedMetrics(input).roas;
}

export function calculateStructureWeightedMetrics(input: {
  facts: readonly StructureHistoryDailyFact[];
  startDate: string;
  asOfDate: string;
  halfLifeDays: number;
  seasonality: StructureSeasonalityMode;
}) {
  let weightedSpend = 0;
  let weightedRevenue = 0;
  let weightedConversions = 0;
  for (const fact of input.facts) {
    if (fact.date < input.startDate || fact.date > input.asOfDate) continue;
    if (
      !structureHistoryFactMatchesSeasonality({
        asOfDate: input.asOfDate,
        factDate: fact.date,
        seasonality: input.seasonality,
      })
    ) {
      continue;
    }
    const ageDays = differenceInStructureReplayDays(input.asOfDate, fact.date);
    const weight = structureRecencyWeight(ageDays, input.halfLifeDays);
    if (weight === null) continue;
    weightedSpend += Math.max(0, fact.spend) * weight;
    weightedRevenue += Math.max(0, fact.revenue) * weight;
    weightedConversions += Math.max(0, fact.conversions ?? 0) * weight;
  }
  return {
    spend: weightedSpend,
    revenue: weightedRevenue,
    conversions: weightedConversions,
    roas: weightedSpend > 0 ? weightedRevenue / weightedSpend : null,
    costPerResult:
      weightedConversions > 0 ? weightedSpend / weightedConversions : null,
  };
}

export function structureQuantile(values: readonly number[], q: number) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((left, right) => left - right);
  if (sorted.length === 0 || !Number.isFinite(q) || q < 0 || q > 1) {
    return null;
  }
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const left = sorted[lower];
  const right = sorted[upper];
  if (left === undefined || right === undefined) return null;
  return left + (right - left) * (index - lower);
}

export function resolveStructurePurchaseRequirement(
  threshold: StructurePurchaseThreshold,
  peerWinnerPurchaseP50: number | null,
) {
  if (threshold !== "half_peer_winner_p50") return threshold;
  if (
    peerWinnerPurchaseP50 === null ||
    !Number.isFinite(peerWinnerPurchaseP50) ||
    peerWinnerPurchaseP50 <= 0
  ) {
    return null;
  }
  return Math.max(1, Math.ceil(peerWinnerPurchaseP50 / 2));
}

export function classifyStructureDurabilityOutcome(
  input: StructureOutcomeInput,
): { status: StructureOutcomeStatus; criticalRefutation: boolean } {
  if (!input.completeReceipt) {
    return { status: "unknown", criticalRefutation: false };
  }
  if (input.futureSpend <= 0) {
    return { status: "censored", criticalRefutation: false };
  }
  const cohort = input.cohort ?? "purchase";
  if (cohort === "unknown") {
    return { status: "unknown", criticalRefutation: false };
  }
  if (cohort !== "purchase") {
    const futureConversions = input.futureConversions ?? input.futurePurchases;
    const futureCostPerResult =
      input.futureCostPerResult ??
      (futureConversions > 0 ? input.futureSpend / futureConversions : null);
    const peerCostPerResultP25 = input.peerCostPerResultP25 ?? null;
    const peerCostPerResultP50 = input.peerCostPerResultP50 ?? null;
    const peerCostPerResultP75 = input.peerCostPerResultP75 ?? null;
    if (
      input.peerCount < 3 ||
      peerCostPerResultP25 === null ||
      peerCostPerResultP50 === null ||
      peerCostPerResultP75 === null
    ) {
      return { status: "unknown", criticalRefutation: false };
    }
    if (
      futureConversions > 0 &&
      futureCostPerResult !== null &&
      futureCostPerResult <= peerCostPerResultP25
    ) {
      return { status: "supported", criticalRefutation: false };
    }
    if (
      futureConversions <= 0 ||
      (futureCostPerResult !== null &&
        futureCostPerResult > peerCostPerResultP50)
    ) {
      const criticalRefutation =
        (futureCostPerResult !== null &&
          futureCostPerResult > peerCostPerResultP75) ||
        (futureConversions <= 0 &&
          input.peerSpendP50 !== null &&
          input.futureSpend >= input.peerSpendP50);
      return { status: "refuted", criticalRefutation };
    }
    return { status: "neutral", criticalRefutation: false };
  }
  const targetRoas = input.targetRoas ?? null;
  const breakEvenRoas = input.breakEvenRoas ?? null;
  if (
    input.peerCount < 3 ||
    input.futureRoas === null ||
    targetRoas === null ||
    breakEvenRoas === null ||
    input.peerRoasP25 === null ||
    input.peerRoasP50 === null ||
    input.peerRoasP75 === null
  ) {
    return { status: "unknown", criticalRefutation: false };
  }
  if (
    input.futurePurchases > 0 &&
    input.futureRoas >= input.peerRoasP75 &&
    input.futureRoas >= targetRoas
  ) {
    return { status: "supported", criticalRefutation: false };
  }
  if (
    input.futurePurchases <= 0 ||
    input.futureRoas < breakEvenRoas ||
    input.futureRoas < input.peerRoasP50
  ) {
    const criticalRefutation =
      input.futureRoas < breakEvenRoas ||
      input.futureRoas < input.peerRoasP25 ||
      (input.futurePurchases <= 0 &&
        input.peerSpendP50 !== null &&
        input.futureSpend >= input.peerSpendP50);
    return { status: "refuted", criticalRefutation };
  }
  return { status: "neutral", criticalRefutation: false };
}

export function evaluateStructureCandidate(
  opportunity: StructureOpportunity,
  variant: StructureVariant,
): StructureCandidateEvaluation {
  const reasonCodes: string[] = [];
  const action =
    opportunity.grain === "campaign"
      ? "increase_campaign_budget"
      : "increase_adset_budget";
  const history =
    opportunity.history[
      structureHistorySignalKey({
        halfLifeDays: variant.halfLifeDays,
        seasonality: variant.seasonality,
      })
    ];
  const requiredPurchases = resolveStructurePurchaseRequirement(
    variant.purchaseThreshold,
    opportunity.purchaseCohort
      ? (history?.peerWinnerPurchaseP50 ?? null)
      : (history?.peerWinnerOutcomeCountP50 ?? null),
  );
  const requiredOutcomes = requiredPurchases;
  const cumulativeOutcomes = opportunity.purchaseCohort
    ? opportunity.cumulativePurchases
    : opportunity.cumulativeConversions;

  if (opportunity.cohort === "unknown") reasonCodes.push("unknown_cohort");
  if (!opportunity.configCutoffSafe) reasonCodes.push("config_not_cutoff_safe");
  if (!opportunity.bidContextReconstructable) {
    reasonCodes.push("bid_context_not_cutoff_safe");
  }
  if (
    opportunity.purchaseCohort &&
    (!opportunity.targetCutoffSafe ||
      !opportunity.targetFresh ||
      opportunity.targetRoas === null ||
      opportunity.breakEvenRoas === null)
  ) {
    reasonCodes.push("fresh_purchase_economics_missing");
  }
  if (!opportunity.completeOutcomeReceipt) {
    reasonCodes.push("outcome_receipt_incomplete");
  }
  if (opportunity.budgetOwner !== opportunity.grain) {
    reasonCodes.push("grain_is_not_inferred_budget_owner");
  }
  if (opportunity.ageDays < variant.ageDays) {
    reasonCodes.push("age_below_threshold");
  }
  if (requiredOutcomes === null || cumulativeOutcomes < requiredOutcomes) {
    reasonCodes.push(
      opportunity.purchaseCohort
        ? "purchases_below_threshold"
        : "primary_outcomes_below_threshold",
    );
  }
  if (
    opportunity.budgetUtilization === null ||
    opportunity.budgetUtilization < variant.utilization
  ) {
    reasonCodes.push("utilization_below_threshold");
  }
  if (
    !history ||
    history.peerCount < 3 ||
    (opportunity.purchaseCohort
      ? history.weightedRoas === null || history.peerRoasP75 === null
      : history.weightedCostPerResult === null ||
        history.peerCostPerResultP25 === null)
  ) {
    reasonCodes.push("history_peer_support_missing");
  } else {
    if (opportunity.purchaseCohort) {
      if (
        history.weightedRoas! < history.peerRoasP75! ||
        history.weightedRoas! < opportunity.targetRoas!
      ) {
        reasonCodes.push("history_below_purchase_scale_floor");
      }
    } else if (history.weightedCostPerResult! > history.peerCostPerResultP25!) {
      reasonCodes.push("history_cost_per_result_above_peer_p25");
    }
    if (history.consecutiveSupportDays < variant.supportDays) {
      reasonCodes.push("history_support_days_below_threshold");
    }
  }

  const candidate = reasonCodes.length === 0;
  if (!candidate) {
    return {
      candidate: false,
      authority: "blocked",
      action: "none",
      requiredPurchases,
      requiredOutcomes,
      reasonCodes,
    };
  }

  const authority =
    opportunity.budgetOwnerReconstructable && opportunity.statusReconstructable
      ? "actionable"
      : "review_only";
  if (!opportunity.budgetOwnerReconstructable) {
    reasonCodes.push("budget_owner_execution_authority_unproven");
  }
  if (!opportunity.statusReconstructable) {
    reasonCodes.push("historical_status_execution_authority_unproven");
  }
  return {
    candidate: true,
    authority,
    action,
    requiredPurchases,
    requiredOutcomes,
    reasonCodes,
  };
}

function wilsonLower95(successes: number, total: number) {
  if (total <= 0) return null;
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = proportion + (z * z) / (2 * total);
  const margin =
    z *
    Math.sqrt(
      (proportion * (1 - proportion)) / total + (z * z) / (4 * total * total),
    );
  return (centre - margin) / denominator;
}

export function projectStructureOpportunityWindow<
  T extends StructureOpportunity,
>(opportunity: T, windowDays: StructureOutcomeWindowDays): T {
  const outcome = opportunity.outcomes[windowDays];
  if (!outcome) {
    return {
      ...opportunity,
      completeOutcomeReceipt: false,
      outcome: "unknown",
      criticalRefutation: false,
    };
  }
  return {
    ...opportunity,
    completeOutcomeReceipt: outcome.completeReceipt,
    outcome: outcome.status,
    criticalRefutation: outcome.criticalRefutation,
  };
}

export function scoreStructureVariant(
  opportunities: readonly StructureOpportunity[],
  variant: StructureVariant,
): StructureVariantScore {
  const scoreable = opportunities.filter(
    (opportunity) =>
      opportunity.cohort !== "unknown" &&
      opportunity.configCutoffSafe &&
      opportunity.bidContextReconstructable &&
      opportunity.completeOutcomeReceipt &&
      opportunity.budgetOwner === opportunity.grain &&
      (!opportunity.purchaseCohort ||
        (opportunity.targetCutoffSafe &&
          opportunity.targetFresh &&
          opportunity.targetRoas !== null &&
          opportunity.breakEvenRoas !== null)),
  );
  let candidateCount = 0;
  let supportedCandidates = 0;
  let refutedCandidates = 0;
  let neutralCandidates = 0;
  let unknownCandidates = 0;
  let censoredCandidates = 0;
  let criticalFalsePositives = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  let supportedOpportunities = 0;

  for (const opportunity of scoreable) {
    const candidate = evaluateStructureCandidate(
      opportunity,
      variant,
    ).candidate;
    if (opportunity.outcome === "supported") supportedOpportunities += 1;
    if (candidate) {
      candidateCount += 1;
      if (opportunity.outcome === "supported") supportedCandidates += 1;
      else if (opportunity.outcome === "refuted") {
        refutedCandidates += 1;
        if (opportunity.criticalRefutation) criticalFalsePositives += 1;
      } else if (opportunity.outcome === "neutral") neutralCandidates += 1;
      else if (opportunity.outcome === "unknown") unknownCandidates += 1;
      else censoredCandidates += 1;
    } else if (opportunity.outcome === "supported") {
      falseNegative += 1;
    } else if (opportunity.outcome === "refuted") {
      trueNegative += 1;
    }
  }

  const binaryCandidates = supportedCandidates + refutedCandidates;
  const precision = ratio(supportedCandidates, binaryCandidates);
  const opportunityRecall = ratio(
    supportedCandidates,
    supportedCandidates + falseNegative,
  );
  const criticalFalsePositiveRate = ratio(
    criticalFalsePositives,
    binaryCandidates,
  );
  const candidateCoverage = ratio(candidateCount, scoreable.length);
  const precisionWilsonLower95 = wilsonLower95(
    supportedCandidates,
    binaryCandidates,
  );
  const rankScore =
    precisionWilsonLower95 === null ||
    opportunityRecall === null ||
    criticalFalsePositiveRate === null ||
    candidateCoverage === null
      ? null
      : precisionWilsonLower95 * 0.65 +
        opportunityRecall * 0.25 +
        candidateCoverage * 0.1 -
        criticalFalsePositiveRate * 0.75;

  return {
    variantId: variant.id,
    fixedCohortSize: opportunities.length,
    scoreableCohortSize: scoreable.length,
    candidateCount,
    supportedCandidates,
    refutedCandidates,
    neutralCandidates,
    unknownCandidates,
    censoredCandidates,
    criticalFalsePositives,
    supportedOpportunities,
    trueNegative,
    falseNegative,
    precision: round(precision),
    precisionWilsonLower95: round(precisionWilsonLower95),
    opportunityRecall: round(opportunityRecall),
    criticalFalsePositiveRate: round(criticalFalsePositiveRate),
    candidateCoverage: round(candidateCoverage),
    rankScore: round(rankScore, 6),
  };
}

export function compareStructureVariantScores(
  left: StructureVariantScore,
  right: StructureVariantScore,
) {
  return (
    (right.rankScore ?? Number.NEGATIVE_INFINITY) -
      (left.rankScore ?? Number.NEGATIVE_INFINITY) ||
    (right.precisionWilsonLower95 ?? Number.NEGATIVE_INFINITY) -
      (left.precisionWilsonLower95 ?? Number.NEGATIVE_INFINITY) ||
    (right.opportunityRecall ?? Number.NEGATIVE_INFINITY) -
      (left.opportunityRecall ?? Number.NEGATIVE_INFINITY) ||
    right.candidateCount - left.candidateCount ||
    left.variantId.localeCompare(right.variantId)
  );
}

export function hashFixedStructureCohort(
  opportunities: readonly Pick<
    StructureOpportunity,
    "grain" | "businessId" | "accountId" | "entityId" | "asOfDate"
  >[],
) {
  const identities = opportunities
    .map(
      (opportunity) =>
        `${opportunity.grain}|${opportunity.businessId}|${opportunity.accountId}|${opportunity.entityId}|${opportunity.asOfDate}`,
    )
    .sort();
  return createHash("sha256").update(identities.join("\n")).digest("hex");
}
