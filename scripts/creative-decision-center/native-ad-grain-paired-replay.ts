#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import { ENGINE_PRESET_MULTIPLIERS } from "@/lib/creative-decision-engine/config-values";
import {
  buildAdChallengerGrid,
  buildAdSmokeGrid,
  type AdChallengerSpec as VariantSpec,
} from "@/lib/creative-decision-engine/simulation/ad-challenger-grid";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import { clusteredMovingBlockBootstrap } from "@/lib/creative-decision-engine/simulation/clustered-moving-block-bootstrap";
import { buildSimulationInputManifest } from "@/lib/creative-decision-engine/simulation/input-manifest";
import { summarizeLeaveOneBusinessOutMetric } from "@/lib/creative-decision-engine/simulation/leave-one-business-out";
import { assignRollingOriginFold } from "@/lib/creative-decision-engine/simulation/evaluation-folds";
import {
  effectiveSampleSize,
  recencyWeight,
  shrinkPositiveRatioLogSpace,
  weightedQuantile,
} from "@/lib/creative-decision-engine/simulation/hierarchical-calibration";
import {
  pairedMcNemarFromCounts,
  wilsonScoreInterval,
} from "@/lib/creative-decision-engine/simulation/paired-binary-inference";
import { pairedActionStratifiedPermutationTest } from "@/lib/creative-decision-engine/simulation/stratified-permutation";
import {
  buildH10ProbabilityCalibrationConfigs,
  fitBayesianWalkForwardSensitivity,
  fitAndEvaluateProbabilityCalibration,
  type DatedProbabilityCalibrationObservation,
} from "@/lib/creative-decision-engine/simulation/probability-calibration";
import {
  computeFatigue,
  deriveDisjointWindows,
  type FatigueStatus,
  type HistoricalWindow,
} from "@/lib/creative-decision-engine/fatigue";
import { computeFunnelDiagnosis } from "@/lib/creative-decision-engine/funnel";
import {
  classifyMetaAovQuality,
  resolveSpendUnit,
} from "@/lib/creative-decision-engine/spend-unit-resolver";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  CampaignObjective,
  CreativeFormat,
  CreativeInput,
  DecisionLabel,
  DecisionOutput,
  EngineMultiplierSet,
  EngineRiskPreset,
  EngineThresholdSet,
  FormatFunnelBaseline,
  LifecyclePosition,
  MetaRanking,
  SpendTrajectory,
} from "@/lib/creative-decision-engine/types";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";

const CONTRACT_VERSION = "adsecute.meta.native-ad-paired-replay.v2" as const;
const DEFAULT_START_DATE = "2025-12-01";
const DEFAULT_DECISION_END_DATE = "2026-06-27";
const DEFAULT_OUTCOME_CEILING = "2026-07-11";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/native-ad-grain-paired-replay-2025-12-01-to-2026-06-27.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/NATIVE_AD_GRAIN_PAIRED_REPLAY_2025-12-01_TO_2026-06-27.md";
const TARGET_FRESHNESS_DAYS = 30;
const DECISION_COOLDOWN_DAYS = 7;
export const OUTCOME_WINDOWS = [3, 7, 14] as const;
export type OutcomeWindowDays = (typeof OUTCOME_WINDOWS)[number];
const PRIMARY_OUTCOME_WINDOW_DAYS: OutcomeWindowDays = 14;
const SIMULATION_SOURCE_FILES = [
  "ad-challenger-grid.ts",
  "calendar-date.ts",
  "clustered-moving-block-bootstrap.ts",
  "evaluation-folds.ts",
  "hierarchical-calibration.ts",
  "input-manifest.ts",
  "leave-one-business-out.ts",
  "paired-binary-inference.ts",
  "probability-calibration.ts",
  "stratified-permutation.ts",
] as const;

type Row = Record<string, unknown>;
type OutcomeStatus =
  "supported" | "refuted" | "neutral" | "unknown" | "censored";
type SourceMode = "restated_ad_daily";
type AuthorityState =
  | "actionable"
  | "review_only"
  | "blocked_data"
  | "blocked_commercial"
  | "blocked_policy"
  | "blocked_delivery";
type ExecutionAction =
  | "promote_to_main"
  | "keep_running"
  | "cut_ad"
  | "refresh_creative"
  | "continue_test"
  | "watch_launch"
  | "resolve_delivery"
  | "resolve_policy"
  | "none";
type PortfolioRole =
  | "current_winner"
  | "historical_winner"
  | "challenger"
  | "learning"
  | "declining"
  | "exhausted"
  | "unknown";

interface ParsedArgs {
  startDate: string;
  decisionEndDate: string;
  outcomeCeiling: string;
  businesses: string[];
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
  grid: "smoke" | "full";
  compareCohortJson: string | null;
}

export interface NativeReplayCohortComparable {
  coverage: {
    businesses: number;
    sourceRows: number;
    cohortRows: number;
    targetExactRows: number;
    completeOutcomeRows: number;
    creativeIdRows: number;
    duplicateCohortKeys: number;
    uniqueDecisionInputHashes: number;
  };
  lineage: {
    engineVersion: string;
    scriptContentHash: string;
    simulationSourceHash: string;
    productionEngineSourceHash: string;
    manifestSetHash: string;
    outcomeWindowSetHash: string;
  };
}

interface BusinessRow {
  id: string;
  legacyId: string;
  name: string;
}

interface TargetPack {
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  riskPosture: EngineRiskPreset;
  updatedAt: string | null;
  effectiveAt: string | null;
  recordedAt: string | null;
  source: "business_target_pack_history" | "business_target_packs";
}

interface ProfileConfig {
  updatedAt: string | null;
  enginePresetLabel: EngineRiskPreset | null;
  zeroConvBurnerMultiplier: number | null;
  cutCandidateMultiplier: number | null;
  sustainedLoserMultiplier: number | null;
  hardCutMultiplier: number | null;
  scalePurchaseMultiplier: number | null;
  winnerMemoryMultiplier: number | null;
  recentSampleMultiplier: number | null;
  weakFunnelRateMultiplier: number | null;
  attributionAovAdjustmentMultiplier: number | null;
}

interface AdDailyFact {
  businessId: string;
  legacyBusinessId: string;
  businessName: string;
  providerAccountId: string;
  date: string;
  campaignId: string;
  adsetId: string;
  adId: string;
  creativeId: string | null;
  adName: string | null;
  currency: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  outboundClicks: number | null;
  landingPageViews: number | null;
  addToCart: number | null;
  initiateCheckout: number | null;
  leads: number | null;
  messages: number | null;
  thumbstop: number | null;
  video25Rate: number | null;
  video50Rate: number | null;
  video75Rate: number | null;
  video100Rate: number | null;
  conversions: number;
  revenue: number;
  frequency: number | null;
  effectiveStatus: string | null;
  creativeFormat: string | null;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
  creativeContextCreatedAt: string | null;
  creativeContextUpdatedAt: string | null;
  adsetBidStrategy: string | null;
  adsetBidValue: number | null;
  adsetBidValueFormat: string | null;
  adsetBidStrategyMixed: boolean;
  adsetConfigCreatedAt: string | null;
  adsetConfigUpdatedAt: string | null;
  campaignBidStrategy: string | null;
  campaignBidValue: number | null;
  campaignBidValueFormat: string | null;
  campaignBidStrategyMixed: boolean;
  campaignConfigCreatedAt: string | null;
  campaignConfigUpdatedAt: string | null;
  sourceSnapshotId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LifecycleObservation {
  businessId: string;
  providerAccountId: string;
  adId: string;
  asOfDate: string;
  engineVersion: string;
  computedAt: string;
  sourceMaxDate: string | null;
  sourceMaxUpdatedAt: string | null;
  effectiveStatus: string | null;
  lifecyclePosition: string | null;
  fatigueStatus: string | null;
  fatigueConfidence: number | null;
  daysSincePeak: number | null;
  peakRoas30d: number | null;
  peakConfidence: number | null;
  spendTrajectory30d: string | null;
  spendSlope7d: number | null;
  spendSlope30d: number | null;
  roasSlope7d: number | null;
  roasSlope30d: number | null;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
  creativeFormat: string | null;
}

export type ActionExposureStratum =
  "untreated" | "acted_success" | "failed" | "dry_run";

export interface ActionReceipt {
  id: string;
  businessId: string;
  adId: string;
  action: string;
  status: string;
  requestedAt: string;
  verifiedAt: string | null;
  dryRun: boolean;
}

export interface ActionExposureSummary {
  stratum: ActionExposureStratum;
  receiptIds: string[];
  latestRequestedAt: string | null;
  successfulVerifiedReceiptCount: number;
  failedReceiptCount: number;
  dryRunReceiptCount: number;
  observationalOnly: true;
  causalEffectClaimed: false;
}

interface RetainedContext {
  effectiveStatus: CreativeInput["effectiveStatus"];
  creativeFormat: CreativeFormat | null;
  qualityRanking: MetaRanking | null;
  engagementRateRanking: MetaRanking | null;
  conversionRateRanking: MetaRanking | null;
  lifecyclePosition: LifecyclePosition | null;
  retainedFatigueStatus: CreativeInput["fatigueStatus"];
  fatigueConfidence: number | null;
  daysSincePeak: number | null;
  peakRoas30d: number | null;
  peakConfidence: number | null;
  spendTrajectory30d: SpendTrajectory | null;
  spendSlope7d: number | null;
  spendSlope30d: number | null;
  roasSlope7d: number | null;
  roasSlope30d: number | null;
  lifecycleEngineVersion: string | null;
  lifecycleComputedAt: string | null;
  bidStrategy: string | null;
  bidValue: number | null;
  bidValueFormat: string | null;
  bidRegime:
    | "lowest_cost"
    | "cost_cap"
    | "bid_cap"
    | "target_roas"
    | "mixed"
    | "other"
    | "unknown";
  contextObservedAt: string | null;
}

interface AccountCompletenessRow {
  businessId: string;
  providerAccountId: string;
  date: string;
  complete: boolean;
}

interface AggregateMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  outboundClicks: number | null;
  landingPageViews: number | null;
  addToCart: number | null;
  initiateCheckout: number | null;
  leads: number | null;
  messages: number | null;
  thumbstop: number | null;
  video25Rate: number | null;
  video50Rate: number | null;
  video75Rate: number | null;
  video100Rate: number | null;
  funnelObservedDays: number;
  purchases: number;
  revenue: number;
  roas: number | null;
  cpa: number | null;
  ctr: number | null;
  frequency: number | null;
  activeDays: number;
  firstDate: string | null;
  lastSpendDate: string | null;
}

interface AdContext {
  business: BusinessRow;
  providerAccountId: string;
  campaignId: string;
  adsetId: string;
  adId: string;
  creativeId: string | null;
  adName: string | null;
  currency: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  cohort: MetaFunnelCohort;
  asOfDate: string;
  currentDay: AggregateMetrics;
  window7: AggregateMetrics;
  window14: AggregateMetrics;
  prior14: AggregateMetrics;
  window28: AggregateMetrics;
  window30: AggregateMetrics;
  window90: AggregateMetrics;
  allObserved: AggregateMetrics;
  accountCompleteAtCutoff: boolean;
  sourceIds: string[];
  sourceUpdatedAfterCutoff: boolean;
  retained: RetainedContext;
  actionExposureAtCutoff: ActionExposureSummary;
}

interface DecisionAxes {
  economicVerdict:
    | "above_target"
    | "between_target_and_breakeven"
    | "below_breakeven"
    | "uncertain"
    | "not_applicable";
  portfolioRole: PortfolioRole;
  authorityState: AuthorityState;
  executionAction: ExecutionAction;
  operationalState: "observed_delivery" | "no_delivery_observed" | "unknown";
}

interface VariantDecision {
  variantId: string;
  applicable: boolean;
  label: DecisionLabel;
  confidence: number;
  blockedActionType: DecisionLabel | null;
  reason: string;
  axes: DecisionAxes;
  cutPurchaseFloor: number | null;
  cutPurchaseFloorBlocked: boolean;
  funnelStage: string | null;
  funnelConfidence: number | null;
  funnelWeakMultiplier: number;
  funnelSampleFloor: 8 | 20 | 30;
  fatigueStatus: FatigueStatus;
  budgetScaleEligible: boolean;
}

interface ForwardOutcome {
  windowDays: OutcomeWindowDays;
  complete: boolean;
  spend: number;
  purchases: number;
  revenue: number;
  roas: number | null;
  accountDaysExpected: number;
  accountDaysPresent: number;
  forwardActionContaminated: boolean;
  forwardActionReceiptIds: string[];
  evidenceClass:
    "observational_uncontaminated" | "observational_action_exposed";
  statusByAction: Record<
    "cut" | "winner" | "portfolioWinner" | "refresh" | "fatigue",
    OutcomeStatus
  >;
  cutOpportunity: boolean | null;
  winnerOpportunity: boolean | null;
  portfolioWinnerOpportunity: boolean | null;
  fatigueOpportunity: boolean | null;
  resultSignals: {
    conversions: number;
    leads: number | null;
    messages: number | null;
    landingPageViews: number | null;
    addToCart: number | null;
    initiateCheckout: number | null;
  };
  nonPurchaseStatus: Partial<
    Record<NonNullable<VariantSpec["nonPurchaseWeightMode"]>, OutcomeStatus>
  >;
  nonPurchaseOpportunity: Partial<
    Record<NonNullable<VariantSpec["nonPurchaseWeightMode"]>, boolean | null>
  >;
  funnelOutcomes: Record<
    string,
    { stage: string | null; confidence: number; known: boolean }
  >;
}

interface CohortRow {
  key: string;
  manifestHash: string;
  decisionInputHash: string;
  sourceMode: SourceMode;
  context: AdContext;
  target: TargetPack | null;
  targetExact: boolean;
  targetFresh: boolean;
  calibration: AccountCalibration;
  decisions: VariantDecision[];
  formulaCalibrationDecision: VariantDecision;
  formulaCalibrationStatusSource:
    "cutoff_safe_effective_status" | "observed_delivery_counterfactual";
  outcomes: Record<OutcomeWindowDays, ForwardOutcome>;
  outcome: ForwardOutcome;
}

interface VariantSummary {
  variantId: string;
  rows: number;
  applicableRows: number;
  labels: Record<string, number>;
  changedVsBaseline: number;
  changedRateVsBaseline: number | null;
  hardRows: number;
  cut: ActionScore;
  cutTargetExact: ActionScore;
  winner: ActionScore;
  winnerTargetExact: ActionScore;
  portfolioWinner: ActionScore;
  refresh: ActionScore;
  fatigue: ActionScore;
  diagnose: ActionScore;
  safetyViolations: number;
  incrementalSafetyViolations: number;
}

interface ActionScore {
  emitted: number;
  known: number;
  supported: number;
  refuted: number;
  neutral: number;
  unknown: number;
  censored: number;
  opportunityKnown: number;
  opportunityPositive: number;
  opportunityCaptured: number;
  precision: number | null;
  opportunityRecall: number | null;
  unknownRate: number | null;
  censoredRate: number | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const value = (name: string) => {
    const prefix = `--${name}=`;
    return (
      argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
    );
  };
  const flag = (name: string) => argv.includes(`--${name}`);
  const businesses = (value("businesses") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    startDate: value("start") ?? DEFAULT_START_DATE,
    decisionEndDate: value("end") ?? DEFAULT_DECISION_END_DATE,
    outcomeCeiling: value("outcomeCeiling") ?? DEFAULT_OUTCOME_CEILING,
    businesses,
    jsonOut: value("jsonOut") ?? DEFAULT_JSON_OUT,
    mdOut: value("mdOut") ?? DEFAULT_MD_OUT,
    writeFiles: !flag("no-write"),
    grid: value("grid") === "smoke" ? "smoke" : "full",
    compareCohortJson: value("compareCohortJson"),
  };
}

export function assertNativeReplayCohortMatch(
  reference: NativeReplayCohortComparable,
  candidate: NativeReplayCohortComparable,
) {
  const coverageKeys = [
    "businesses",
    "sourceRows",
    "cohortRows",
    "targetExactRows",
    "completeOutcomeRows",
    "creativeIdRows",
    "duplicateCohortKeys",
    "uniqueDecisionInputHashes",
  ] as const;
  const mismatches = coverageKeys.flatMap((key) =>
    reference.coverage[key] === candidate.coverage[key]
      ? []
      : [`coverage.${key}`],
  );
  const lineageKeys = [
    "engineVersion",
    "scriptContentHash",
    "simulationSourceHash",
    "productionEngineSourceHash",
    "manifestSetHash",
    "outcomeWindowSetHash",
  ] as const;
  for (const key of lineageKeys) {
    if (reference.lineage[key] !== candidate.lineage[key]) {
      mismatches.push(`lineage.${key}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Native replay cohort mismatch: ${mismatches.join(", ")}`);
  }
  return {
    status: "pass" as const,
    identityHash: candidate.lineage.manifestSetHash,
    comparedFields: coverageKeys.length + lineageKeys.length,
  };
}

function isoDate(value: unknown): string | null {
  return normalizePostgresDate(value);
}

function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString();
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function booleanOrFalse(value: unknown): boolean {
  return value === true || value === "true";
}

function normalizeEffectiveStatus(
  value: string | null,
): CreativeInput["effectiveStatus"] {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (normalized.includes("DELETED")) return "DELETED";
  if (normalized.includes("REJECTED") || normalized.includes("DISAPPROVED")) {
    return "REJECTED";
  }
  if (normalized.includes("PAUSED")) {
    return "PAUSED";
  }
  if (normalized.includes("ACTIVE")) return "ACTIVE";
  return null;
}

function normalizeCreativeFormat(value: string | null): CreativeFormat | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.includes("carousel")) return "carousel";
  if (normalized.includes("catalog") || normalized.includes("dynamic")) {
    return "catalog";
  }
  if (normalized.includes("video")) return "video";
  if (normalized.includes("image") || normalized.includes("photo")) {
    return "image";
  }
  if (normalized === "other") return "other";
  return null;
}

function normalizeMetaRanking(value: string | null): MetaRanking | null {
  const normalized = value?.trim().toLowerCase().replaceAll(" ", "_") ?? "";
  if (normalized.includes("below_average")) return "below_average";
  if (normalized.includes("above_average")) return "above_average";
  if (normalized === "average") return "average";
  if (normalized === "unknown") return "unknown";
  return null;
}

function normalizeLifecyclePosition(
  value: string | null,
): LifecyclePosition | null {
  const allowed: LifecyclePosition[] = [
    "insufficient_history",
    "rising",
    "plateau",
    "closing",
    "past_peak_natural",
    "past_peak_inaction",
    "past_peak_unclear",
    "volatile",
  ];
  return allowed.includes(value as LifecyclePosition)
    ? (value as LifecyclePosition)
    : null;
}

function normalizeSpendTrajectory(
  value: string | null,
): SpendTrajectory | null {
  return value === "rising" ||
    value === "flat" ||
    value === "falling" ||
    value === "volatile" ||
    value === "unknown"
    ? value
    : null;
}

function normalizeFatigueStatus(
  value: string | null,
): CreativeInput["fatigueStatus"] {
  return value === "none" ||
    value === "watch" ||
    value === "fatigued" ||
    value === "unknown"
    ? value
    : null;
}

function classifyBidRegime(input: {
  strategy: string | null;
  mixed: boolean;
}): RetainedContext["bidRegime"] {
  if (input.mixed) return "mixed";
  const value = input.strategy?.trim().toUpperCase() ?? "";
  if (!value) return "unknown";
  if (value.includes("COST_CAP")) return "cost_cap";
  if (value.includes("BID_CAP")) return "bid_cap";
  if (value.includes("ROAS")) return "target_roas";
  if (value.includes("LOWEST_COST") || value.includes("LOWEST COST")) {
    return "lowest_cost";
  }
  return "other";
}

export function isObservationCutoffSafe(input: {
  createdAt: string | null;
  updatedAt: string | null;
  cutoff: string;
}): boolean {
  return (
    input.createdAt !== null &&
    input.updatedAt !== null &&
    input.createdAt <= input.cutoff &&
    input.updatedAt <= input.cutoff
  );
}

export function summarizeActionExposure(
  receipts: readonly ActionReceipt[],
  cutoff: string,
): ActionExposureSummary {
  const eligible = receipts
    .filter((receipt) => receipt.requestedAt <= cutoff)
    .sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.id.localeCompare(right.id),
    );
  const dryRunReceiptCount = eligible.filter(
    (receipt) => receipt.dryRun,
  ).length;
  const successfulVerifiedReceiptCount = eligible.filter(
    (receipt) =>
      !receipt.dryRun &&
      receipt.status === "success" &&
      receipt.verifiedAt !== null &&
      receipt.verifiedAt <= cutoff,
  ).length;
  const failedReceiptCount = eligible.filter(
    (receipt) =>
      !receipt.dryRun &&
      !(
        receipt.status === "success" &&
        receipt.verifiedAt !== null &&
        receipt.verifiedAt <= cutoff
      ),
  ).length;
  const stratum: ActionExposureStratum =
    successfulVerifiedReceiptCount > 0
      ? "acted_success"
      : failedReceiptCount > 0
        ? "failed"
        : dryRunReceiptCount > 0
          ? "dry_run"
          : "untreated";
  return {
    stratum,
    receiptIds: eligible.map((receipt) => receipt.id),
    latestRequestedAt: eligible.at(-1)?.requestedAt ?? null,
    successfulVerifiedReceiptCount,
    failedReceiptCount,
    dryRunReceiptCount,
    observationalOnly: true,
    causalEffectClaimed: false,
  };
}

export function selectForwardActionReceipts(
  receipts: readonly ActionReceipt[],
  decisionDate: string,
  windowDays: OutcomeWindowDays,
): ActionReceipt[] {
  const decisionCutoff = `${decisionDate}T03:00:00.000Z`;
  const outcomeCutoff = `${addDays(decisionDate, windowDays)}T23:59:59.999Z`;
  return receipts
    .filter(
      (receipt) =>
        !receipt.dryRun &&
        receipt.requestedAt > decisionCutoff &&
        receipt.requestedAt <= outcomeCutoff,
    )
    .sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.id.localeCompare(right.id),
    );
}

export function outcomeWindowDates(
  decisionDate: string,
  windowDays: OutcomeWindowDays,
) {
  return {
    start: addDays(decisionDate, 1),
    end: addDays(decisionDate, windowDays),
  };
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function diffDays(later: string, earlier: string): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00.000Z`) -
      Date.parse(`${earlier}T00:00:00.000Z`)) /
      86_400_000,
  );
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1))
    dates.push(cursor);
  return dates;
}

function isoWeekStart(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const day = parsed.getUTCDay();
  return addDays(date, -(day === 0 ? 6 : day - 1));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function quantile(values: number[], q: number): number | null {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const fraction = index - lower;
  return (
    (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction
  );
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function normalizeObjective(value: string | null): CampaignObjective | null {
  const normalized = value?.trim().toUpperCase();
  if (
    normalized === "OUTCOME_SALES" ||
    normalized === "OUTCOME_ENGAGEMENT" ||
    normalized === "OUTCOME_TRAFFIC" ||
    normalized === "OUTCOME_LEADS" ||
    normalized === "OUTCOME_AWARENESS" ||
    normalized === "OUTCOME_APP_PROMOTION"
  ) {
    return normalized;
  }
  if (normalized === "SALES") return "OUTCOME_SALES";
  if (normalized === "LEADS" || normalized === "LEAD_GENERATION")
    return "OUTCOME_LEADS";
  if (normalized === "TRAFFIC") return "OUTCOME_TRAFFIC";
  if (normalized === "ENGAGEMENT") return "OUTCOME_ENGAGEMENT";
  if (normalized === "AWARENESS" || normalized === "REACH")
    return "OUTCOME_AWARENESS";
  return null;
}

function aggregateFacts(rows: readonly AdDailyFact[]): AggregateMetrics {
  let spend = 0;
  let impressions = 0;
  let clicks = 0;
  let linkClicks = 0;
  let outboundClicks = 0;
  let landingPageViews = 0;
  let addToCart = 0;
  let initiateCheckout = 0;
  let leads = 0;
  let messages = 0;
  let funnelCountObserved = false;
  let weightedThumbstop = 0;
  let weightedVideo25 = 0;
  let weightedVideo50 = 0;
  let weightedVideo75 = 0;
  let weightedVideo100 = 0;
  let thumbstopWeight = 0;
  let video25Weight = 0;
  let video50Weight = 0;
  let video75Weight = 0;
  let video100Weight = 0;
  let purchases = 0;
  let revenue = 0;
  let weightedFrequency = 0;
  let frequencyWeight = 0;
  const activeDates = new Set<string>();
  const funnelDates = new Set<string>();
  let firstDate: string | null = null;
  let lastSpendDate: string | null = null;
  for (const row of rows) {
    spend += row.spend;
    impressions += row.impressions;
    clicks += row.clicks;
    linkClicks += row.linkClicks;
    for (const value of [
      row.outboundClicks,
      row.landingPageViews,
      row.addToCart,
      row.initiateCheckout,
      row.leads,
      row.messages,
    ]) {
      if (value !== null) funnelCountObserved = true;
    }
    outboundClicks += row.outboundClicks ?? 0;
    landingPageViews += row.landingPageViews ?? 0;
    addToCart += row.addToCart ?? 0;
    initiateCheckout += row.initiateCheckout ?? 0;
    leads += row.leads ?? 0;
    messages += row.messages ?? 0;
    if (
      row.outboundClicks !== null ||
      row.landingPageViews !== null ||
      row.addToCart !== null ||
      row.initiateCheckout !== null ||
      row.leads !== null ||
      row.messages !== null ||
      row.thumbstop !== null ||
      row.video25Rate !== null
    ) {
      funnelDates.add(row.date);
    }
    if (row.thumbstop !== null && row.impressions > 0) {
      weightedThumbstop += row.thumbstop * row.impressions;
      thumbstopWeight += row.impressions;
    }
    if (row.video25Rate !== null && row.impressions > 0) {
      weightedVideo25 += row.video25Rate * row.impressions;
      video25Weight += row.impressions;
    }
    if (row.video50Rate !== null && row.impressions > 0) {
      weightedVideo50 += row.video50Rate * row.impressions;
      video50Weight += row.impressions;
    }
    if (row.video75Rate !== null && row.impressions > 0) {
      weightedVideo75 += row.video75Rate * row.impressions;
      video75Weight += row.impressions;
    }
    if (row.video100Rate !== null && row.impressions > 0) {
      weightedVideo100 += row.video100Rate * row.impressions;
      video100Weight += row.impressions;
    }
    purchases += row.conversions;
    revenue += row.revenue;
    if (row.frequency !== null && row.impressions > 0) {
      weightedFrequency += row.frequency * row.impressions;
      frequencyWeight += row.impressions;
    }
    if (row.spend > 0 || row.impressions > 0) activeDates.add(row.date);
    if (firstDate === null || row.date < firstDate) firstDate = row.date;
    if (row.spend > 0 && (lastSpendDate === null || row.date > lastSpendDate)) {
      lastSpendDate = row.date;
    }
  }
  return {
    spend,
    impressions,
    clicks,
    linkClicks,
    outboundClicks: funnelCountObserved ? outboundClicks : null,
    landingPageViews: funnelCountObserved ? landingPageViews : null,
    addToCart: funnelCountObserved ? addToCart : null,
    initiateCheckout: funnelCountObserved ? initiateCheckout : null,
    leads: funnelCountObserved ? leads : null,
    messages: funnelCountObserved ? messages : null,
    thumbstop: ratio(weightedThumbstop, thumbstopWeight),
    video25Rate: ratio(weightedVideo25, video25Weight),
    video50Rate: ratio(weightedVideo50, video50Weight),
    video75Rate: ratio(weightedVideo75, video75Weight),
    video100Rate: ratio(weightedVideo100, video100Weight),
    funnelObservedDays: funnelDates.size,
    purchases,
    revenue,
    roas: ratio(revenue, spend),
    cpa: purchases > 0 ? spend / purchases : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    frequency: frequencyWeight > 0 ? weightedFrequency / frequencyWeight : null,
    activeDays: activeDates.size,
    firstDate,
    lastSpendDate,
  };
}

function historicalWindow(metrics: AggregateMetrics): HistoricalWindow | null {
  if (metrics.spend <= 0) return null;
  return {
    spend: metrics.spend,
    purchases: metrics.purchases,
    roas: metrics.roas ?? 0,
    ctr: metrics.ctr ?? 0,
    clickToPurchaseRate:
      metrics.clicks > 0 ? metrics.purchases / metrics.clicks : 0,
  };
}

async function loadSimulationData(args: ParsedArgs) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "adsecute-native-ad-paired-replay-readonly",
  });
  await client.connect();
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    const businessParams = args.businesses.length > 0 ? args.businesses : null;
    const businessResult = await client.query<Row>(
      `
      SELECT id::text AS id, name
      FROM businesses
      WHERE COALESCE(is_demo_business, FALSE) = FALSE
        AND ($1::text[] IS NULL OR name = ANY($1::text[]) OR id::text = ANY($1::text[]))
        AND EXISTS (
          SELECT 1 FROM meta_ad_daily d
          WHERE d.business_ref_id = businesses.id
            AND d.date BETWEEN $2::date AND $3::date
        )
      ORDER BY name
      `,
      [businessParams, args.startDate, args.outcomeCeiling],
    );
    const businesses: BusinessRow[] = businessResult.rows.map((row) => ({
      id: String(row.id),
      legacyId: String(row.id),
      name: String(row.name),
    }));
    const businessIds = businesses.map((business) => business.id);
    if (businessIds.length === 0)
      throw new Error("No businesses matched replay scope");

    const targetResult = await client.query<Row>(
      `
      SELECT
        h.business_id::text AS business_id,
        h.target_cpa,
        h.target_roas,
        h.break_even_cpa,
        h.break_even_roas,
        h.aov_assumption,
        h.default_risk_posture,
        h.effective_at,
        h.recorded_at,
        'business_target_pack_history'::text AS source
      FROM business_target_pack_history h
      WHERE h.business_id = ANY($1::uuid[])
      UNION ALL
      SELECT
        p.business_id::text AS business_id,
        p.target_cpa,
        p.target_roas,
        p.break_even_cpa,
        p.break_even_roas,
        p.aov_assumption,
        p.default_risk_posture,
        p.updated_at AS effective_at,
        p.updated_at AS recorded_at,
        'business_target_packs'::text AS source
      FROM business_target_packs p
      WHERE p.business_id = ANY($1::uuid[])
      ORDER BY business_id, effective_at, recorded_at, source
      `,
      [businessIds],
    );
    const targets = new Map<string, TargetPack[]>();
    for (const row of targetResult.rows) {
      const risk = stringOrNull(row.default_risk_posture);
      const businessId = String(row.business_id);
      const source = stringOrNull(row.source);
      const list = targets.get(businessId) ?? [];
      list.push({
        targetCpa: numberOrNull(row.target_cpa),
        targetRoas: numberOrNull(row.target_roas),
        breakEvenCpa: numberOrNull(row.break_even_cpa),
        breakEvenRoas: numberOrNull(row.break_even_roas),
        operatorAovAssumption: numberOrNull(row.aov_assumption),
        riskPosture:
          risk === "aggressive" || risk === "conservative" ? risk : "balanced",
        updatedAt: isoTimestamp(row.recorded_at),
        effectiveAt: isoTimestamp(row.effective_at),
        recordedAt: isoTimestamp(row.recorded_at),
        source:
          source === "business_target_pack_history"
            ? "business_target_pack_history"
            : "business_target_packs",
      });
      targets.set(businessId, list);
    }

    const profileResult = await client.query<Row>(
      `
      SELECT DISTINCT ON (business_id)
        business_id::text AS business_id,
        engine_preset_label,
        zero_conv_burner_multiplier,
        cut_candidate_multiplier,
        sustained_loser_multiplier,
        hard_cut_multiplier,
        scale_purchase_multiplier,
        winner_memory_multiplier,
        recent_sample_multiplier,
        weak_funnel_rate_multiplier,
        attribution_aov_adjustment_multiplier,
        updated_at
      FROM business_decision_calibration_profiles
      WHERE business_id = ANY($1::uuid[])
        AND channel = 'meta'
        AND objective_family = 'sales'
      ORDER BY business_id, updated_at DESC, id DESC
      `,
      [businessIds],
    );
    const profiles = new Map<string, ProfileConfig>();
    for (const row of profileResult.rows) {
      const preset = stringOrNull(row.engine_preset_label);
      profiles.set(String(row.business_id), {
        updatedAt: isoTimestamp(row.updated_at),
        enginePresetLabel:
          preset === "aggressive" ||
          preset === "balanced" ||
          preset === "conservative"
            ? preset
            : null,
        zeroConvBurnerMultiplier: numberOrNull(row.zero_conv_burner_multiplier),
        cutCandidateMultiplier: numberOrNull(row.cut_candidate_multiplier),
        sustainedLoserMultiplier: numberOrNull(row.sustained_loser_multiplier),
        hardCutMultiplier: numberOrNull(row.hard_cut_multiplier),
        scalePurchaseMultiplier: numberOrNull(row.scale_purchase_multiplier),
        winnerMemoryMultiplier: numberOrNull(row.winner_memory_multiplier),
        recentSampleMultiplier: numberOrNull(row.recent_sample_multiplier),
        weakFunnelRateMultiplier: numberOrNull(row.weak_funnel_rate_multiplier),
        attributionAovAdjustmentMultiplier: numberOrNull(
          row.attribution_aov_adjustment_multiplier,
        ),
      });
    }

    const historyStart = addDays(args.startDate, -89);
    const factsResult = await client.query<Row>(
      `
      SELECT
        b.id::text AS business_ref_id,
        b.name AS business_name,
        d.business_id AS legacy_business_id,
        d.provider_account_id,
        d.date,
        d.campaign_id,
        d.adset_id,
        d.ad_id,
        dim.creative_id,
        COALESCE(d.ad_name_historical, d.ad_name_current) AS ad_name,
        d.account_currency,
        campaign.objective,
        adset.optimization_goal,
        adset.custom_event_type,
        d.spend,
        d.impressions,
        d.clicks,
        d.link_clicks,
        d.payload_json->>'outbound_clicks' AS outbound_clicks,
        d.payload_json->>'landing_page_views' AS landing_page_views,
        d.payload_json->>'add_to_cart' AS add_to_cart,
        d.payload_json->>'initiate_checkout' AS initiate_checkout,
        d.payload_json->>'leads' AS leads,
        d.payload_json->>'messages' AS messages,
        d.payload_json->>'thumbstop' AS thumbstop,
        d.payload_json->>'video25' AS video25_rate,
        d.payload_json->>'video50' AS video50_rate,
        d.payload_json->>'video75' AS video75_rate,
        d.payload_json->>'video100' AS video100_rate,
        d.conversions,
        d.revenue,
        d.frequency,
        COALESCE(creative_ctx.effective_status, d.ad_status) AS effective_status,
        COALESCE(
          creative_ctx.creative_visual_format,
          creative_ctx.asset_type,
          creative_ctx.payload_json->>'creative_format'
        ) AS creative_format,
        creative_ctx.quality_ranking,
        creative_ctx.engagement_rate_ranking,
        creative_ctx.conversion_rate_ranking,
        creative_ctx.created_at AS creative_context_created_at,
        creative_ctx.updated_at AS creative_context_updated_at,
        adset.bid_strategy_type AS adset_bid_strategy,
        adset.bid_value AS adset_bid_value,
        adset.bid_value_format AS adset_bid_value_format,
        COALESCE(adset.is_bid_strategy_mixed, FALSE) AS adset_bid_strategy_mixed,
        adset.created_at AS adset_config_created_at,
        adset.updated_at AS adset_config_updated_at,
        campaign.bid_strategy_type AS campaign_bid_strategy,
        campaign.bid_value AS campaign_bid_value,
        campaign.bid_value_format AS campaign_bid_value_format,
        COALESCE(campaign.is_bid_strategy_mixed, FALSE) AS campaign_bid_strategy_mixed,
        campaign.created_at AS campaign_config_created_at,
        campaign.updated_at AS campaign_config_updated_at,
        d.source_snapshot_id::text AS source_snapshot_id,
        d.created_at,
        d.updated_at
      FROM meta_ad_daily d
      JOIN businesses b ON b.id = d.business_ref_id
      LEFT JOIN LATERAL (
        SELECT md.creative_id
        FROM meta_ad_dimensions md
        WHERE md.business_ref_id = d.business_ref_id
          AND md.provider_account_id = d.provider_account_id
          AND md.ad_id = d.ad_id
        ORDER BY md.updated_at DESC, md.id DESC
        LIMIT 1
      ) dim ON TRUE
      LEFT JOIN LATERAL (
        SELECT mc.*
        FROM meta_creative_daily mc
        WHERE mc.business_ref_id = d.business_ref_id
          AND mc.provider_account_id = d.provider_account_id
          AND mc.ad_id = d.ad_id
          AND mc.date = d.date
        ORDER BY mc.updated_at DESC, mc.id DESC
        LIMIT 1
      ) creative_ctx ON TRUE
      LEFT JOIN meta_adset_daily adset
        ON adset.business_ref_id = d.business_ref_id
       AND adset.provider_account_id = d.provider_account_id
       AND adset.adset_id = d.adset_id
       AND adset.date = d.date
      LEFT JOIN meta_campaign_daily campaign
        ON campaign.business_ref_id = d.business_ref_id
       AND campaign.provider_account_id = d.provider_account_id
       AND campaign.campaign_id = d.campaign_id
       AND campaign.date = d.date
      WHERE d.business_ref_id = ANY($1::uuid[])
        AND d.date BETWEEN $2::date AND $3::date
        AND d.truth_state = 'finalized'
        AND d.validation_status = 'passed'
      ORDER BY b.id, d.provider_account_id, d.ad_id, d.date
      `,
      [businessIds, historyStart, args.outcomeCeiling],
    );
    const facts: AdDailyFact[] = factsResult.rows.flatMap((row) => {
      const date = isoDate(row.date);
      const campaignId = stringOrNull(row.campaign_id);
      const adsetId = stringOrNull(row.adset_id);
      const adId = stringOrNull(row.ad_id);
      const providerAccountId = stringOrNull(row.provider_account_id);
      if (!date || !campaignId || !adsetId || !adId || !providerAccountId)
        return [];
      return [
        {
          businessId: String(row.business_ref_id),
          legacyBusinessId: String(row.legacy_business_id),
          businessName: String(row.business_name),
          providerAccountId,
          date,
          campaignId,
          adsetId,
          adId,
          creativeId: stringOrNull(row.creative_id),
          adName: stringOrNull(row.ad_name),
          currency: stringOrNull(row.account_currency),
          objective: stringOrNull(row.objective),
          optimizationGoal: stringOrNull(row.optimization_goal),
          customEventType: stringOrNull(row.custom_event_type),
          spend: numberOrZero(row.spend),
          impressions: numberOrZero(row.impressions),
          clicks: numberOrZero(row.clicks),
          linkClicks: numberOrZero(row.link_clicks),
          outboundClicks: numberOrNull(row.outbound_clicks),
          landingPageViews: numberOrNull(row.landing_page_views),
          addToCart: numberOrNull(row.add_to_cart),
          initiateCheckout: numberOrNull(row.initiate_checkout),
          leads: numberOrNull(row.leads),
          messages: numberOrNull(row.messages),
          thumbstop: numberOrNull(row.thumbstop),
          video25Rate: numberOrNull(row.video25_rate),
          video50Rate: numberOrNull(row.video50_rate),
          video75Rate: numberOrNull(row.video75_rate),
          video100Rate: numberOrNull(row.video100_rate),
          conversions: numberOrZero(row.conversions),
          revenue: numberOrZero(row.revenue),
          frequency: numberOrNull(row.frequency),
          effectiveStatus: stringOrNull(row.effective_status),
          creativeFormat: stringOrNull(row.creative_format),
          qualityRanking: stringOrNull(row.quality_ranking),
          engagementRateRanking: stringOrNull(row.engagement_rate_ranking),
          conversionRateRanking: stringOrNull(row.conversion_rate_ranking),
          creativeContextCreatedAt: isoTimestamp(
            row.creative_context_created_at,
          ),
          creativeContextUpdatedAt: isoTimestamp(
            row.creative_context_updated_at,
          ),
          adsetBidStrategy: stringOrNull(row.adset_bid_strategy),
          adsetBidValue: numberOrNull(row.adset_bid_value),
          adsetBidValueFormat: stringOrNull(row.adset_bid_value_format),
          adsetBidStrategyMixed: booleanOrFalse(row.adset_bid_strategy_mixed),
          adsetConfigCreatedAt: isoTimestamp(row.adset_config_created_at),
          adsetConfigUpdatedAt: isoTimestamp(row.adset_config_updated_at),
          campaignBidStrategy: stringOrNull(row.campaign_bid_strategy),
          campaignBidValue: numberOrNull(row.campaign_bid_value),
          campaignBidValueFormat: stringOrNull(row.campaign_bid_value_format),
          campaignBidStrategyMixed: booleanOrFalse(
            row.campaign_bid_strategy_mixed,
          ),
          campaignConfigCreatedAt: isoTimestamp(row.campaign_config_created_at),
          campaignConfigUpdatedAt: isoTimestamp(row.campaign_config_updated_at),
          sourceSnapshotId: stringOrNull(row.source_snapshot_id),
          createdAt: isoTimestamp(row.created_at),
          updatedAt: isoTimestamp(row.updated_at),
        },
      ];
    });
    for (const business of businesses) {
      const sample = facts.find((fact) => fact.businessId === business.id);
      if (sample) business.legacyId = sample.legacyBusinessId;
    }

    const completenessResult = await client.query<Row>(
      `
      SELECT
        business_ref_id::text AS business_id,
        provider_account_id,
        date,
        BOOL_AND(truth_state = 'finalized' AND validation_status = 'passed') AS complete
      FROM meta_account_daily
      WHERE business_ref_id = ANY($1::uuid[])
        AND date BETWEEN $2::date AND $3::date
      GROUP BY business_ref_id, provider_account_id, date
      `,
      [businessIds, historyStart, args.outcomeCeiling],
    );
    const completeness: AccountCompletenessRow[] =
      completenessResult.rows.flatMap((row) => {
        const date = isoDate(row.date);
        const providerAccountId = stringOrNull(row.provider_account_id);
        if (!date || !providerAccountId) return [];
        return [
          {
            businessId: String(row.business_id),
            providerAccountId,
            date,
            complete: row.complete === true,
          },
        ];
      });

    const lifecycleResult = await client.query<Row>(
      `
      SELECT
        business_ref_id::text AS business_id,
        provider_account_id,
        ad_id,
        as_of_date,
        engine_version,
        computed_at,
        source_max_date,
        source_max_updated_at,
        effective_status,
        lifecycle_position,
        fatigue_status,
        fatigue_confidence,
        days_since_peak,
        peak_roas_30d,
        peak_confidence,
        spend_trajectory_30d,
        spend_slope_7d,
        spend_slope_30d,
        roas_slope_7d,
        roas_slope_30d,
        quality_ranking,
        engagement_rate_ranking,
        conversion_rate_ranking,
        creative_format
      FROM engine_v3_creative_lifecycle_daily
      WHERE business_ref_id = ANY($1::uuid[])
        AND ad_id IS NOT NULL
        AND as_of_date BETWEEN $2::date AND $3::date
        AND computed_at <= ($3::date + INTERVAL '1 day')
      ORDER BY business_ref_id, provider_account_id, ad_id, as_of_date, computed_at
      `,
      [businessIds, args.startDate, args.decisionEndDate],
    );
    const lifecycle: LifecycleObservation[] = lifecycleResult.rows.flatMap(
      (row) => {
        const asOfDate = isoDate(row.as_of_date);
        const computedAt = isoTimestamp(row.computed_at);
        const providerAccountId = stringOrNull(row.provider_account_id);
        const adId = stringOrNull(row.ad_id);
        if (!asOfDate || !computedAt || !providerAccountId || !adId) return [];
        return [
          {
            businessId: String(row.business_id),
            providerAccountId,
            adId,
            asOfDate,
            engineVersion: String(row.engine_version),
            computedAt,
            sourceMaxDate: isoDate(row.source_max_date),
            sourceMaxUpdatedAt: isoTimestamp(row.source_max_updated_at),
            effectiveStatus: stringOrNull(row.effective_status),
            lifecyclePosition: stringOrNull(row.lifecycle_position),
            fatigueStatus: stringOrNull(row.fatigue_status),
            fatigueConfidence: numberOrNull(row.fatigue_confidence),
            daysSincePeak: numberOrNull(row.days_since_peak),
            peakRoas30d: numberOrNull(row.peak_roas_30d),
            peakConfidence: numberOrNull(row.peak_confidence),
            spendTrajectory30d: stringOrNull(row.spend_trajectory_30d),
            spendSlope7d: numberOrNull(row.spend_slope_7d),
            spendSlope30d: numberOrNull(row.spend_slope_30d),
            roasSlope7d: numberOrNull(row.roas_slope_7d),
            roasSlope30d: numberOrNull(row.roas_slope_30d),
            qualityRanking: stringOrNull(row.quality_ranking),
            engagementRateRanking: stringOrNull(row.engagement_rate_ranking),
            conversionRateRanking: stringOrNull(row.conversion_rate_ranking),
            creativeFormat: stringOrNull(row.creative_format),
          },
        ];
      },
    );

    const actionResult = await client.query<Row>(
      `
      SELECT
        id::text,
        business_id::text,
        ad_id,
        action,
        status,
        requested_at,
        verified_at,
        payload_request
      FROM meta_ads_action_log
      WHERE business_id = ANY($1::uuid[])
        AND ad_id IS NOT NULL
        AND requested_at <= ($2::date + INTERVAL '1 day')
      ORDER BY business_id, ad_id, requested_at, id
      `,
      [businessIds, args.outcomeCeiling],
    );
    const actionReceipts: ActionReceipt[] = actionResult.rows.flatMap((row) => {
      const adId = stringOrNull(row.ad_id);
      const requestedAt = isoTimestamp(row.requested_at);
      const payload =
        row.payload_request !== null &&
        typeof row.payload_request === "object" &&
        !Array.isArray(row.payload_request)
          ? (row.payload_request as Record<string, unknown>)
          : {};
      if (!adId || !requestedAt) return [];
      return [
        {
          id: String(row.id),
          businessId: String(row.business_id),
          adId,
          action: String(row.action),
          status: String(row.status),
          requestedAt,
          verifiedAt: isoTimestamp(row.verified_at),
          dryRun: booleanOrFalse(payload.dry_run),
        },
      ];
    });

    await client.query("ROLLBACK");
    return {
      businesses,
      targets,
      profiles,
      facts,
      completeness,
      lifecycle,
      actionReceipts,
      historyStart,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function indexFacts(facts: readonly AdDailyFact[]) {
  const byAd = new Map<string, AdDailyFact[]>();
  for (const fact of facts) {
    const key = `${fact.businessId}::${fact.providerAccountId}::${fact.adId}`;
    const rows = byAd.get(key) ?? [];
    rows.push(fact);
    byAd.set(key, rows);
  }
  for (const rows of byAd.values())
    rows.sort((left, right) => left.date.localeCompare(right.date));
  return byAd;
}

function indexLifecycle(rows: readonly LifecycleObservation[]) {
  const byAd = new Map<string, LifecycleObservation[]>();
  for (const row of rows) {
    const key = `${row.businessId}::${row.providerAccountId}::${row.adId}`;
    const list = byAd.get(key) ?? [];
    list.push(row);
    byAd.set(key, list);
  }
  for (const list of byAd.values()) {
    list.sort(
      (left, right) =>
        left.asOfDate.localeCompare(right.asOfDate) ||
        left.computedAt.localeCompare(right.computedAt),
    );
  }
  return byAd;
}

function indexActionReceipts(rows: readonly ActionReceipt[]) {
  const byAd = new Map<string, ActionReceipt[]>();
  for (const row of rows) {
    const key = `${row.businessId}::${row.adId}`;
    const list = byAd.get(key) ?? [];
    list.push(row);
    byAd.set(key, list);
  }
  for (const list of byAd.values()) {
    list.sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.id.localeCompare(right.id),
    );
  }
  return byAd;
}

export function selectCutoffSafeLifecycleObservation(
  rows: readonly LifecycleObservation[],
  asOfDate: string,
  cutoff = `${asOfDate}T03:00:00.000Z`,
): LifecycleObservation | null {
  return (
    [...rows]
      .filter(
        (row) =>
          row.asOfDate <= asOfDate &&
          row.computedAt <= cutoff &&
          (row.sourceMaxDate === null || row.sourceMaxDate <= asOfDate) &&
          (row.sourceMaxUpdatedAt === null || row.sourceMaxUpdatedAt <= cutoff),
      )
      .sort(
        (left, right) =>
          right.asOfDate.localeCompare(left.asOfDate) ||
          right.computedAt.localeCompare(left.computedAt),
      )[0] ?? null
  );
}

function resolveRetainedContext(input: {
  rows: readonly AdDailyFact[];
  lifecycleRows: readonly LifecycleObservation[];
  asOfDate: string;
}): RetainedContext {
  const cutoff = `${input.asOfDate}T03:00:00.000Z`;
  const eligibleFacts = [...input.rows].filter(
    (row) => row.date <= input.asOfDate,
  );
  const latestSafe = (
    createdAt: (row: AdDailyFact) => string | null,
    updatedAt: (row: AdDailyFact) => string | null,
  ) =>
    eligibleFacts
      .filter((row) =>
        isObservationCutoffSafe({
          createdAt: createdAt(row),
          updatedAt: updatedAt(row),
          cutoff,
        }),
      )
      .sort(
        (left, right) =>
          (updatedAt(right) ?? "").localeCompare(updatedAt(left) ?? "") ||
          right.date.localeCompare(left.date),
      )[0];
  const creative = latestSafe(
    (row) => row.creativeContextCreatedAt,
    (row) => row.creativeContextUpdatedAt,
  );
  const adsetBid = latestSafe(
    (row) => row.adsetConfigCreatedAt,
    (row) => row.adsetConfigUpdatedAt,
  );
  const campaignBid = latestSafe(
    (row) => row.campaignConfigCreatedAt,
    (row) => row.campaignConfigUpdatedAt,
  );
  const lifecycle = selectCutoffSafeLifecycleObservation(
    input.lifecycleRows,
    input.asOfDate,
    cutoff,
  );
  const bidSource = adsetBid?.adsetBidStrategy
    ? {
        strategy: adsetBid.adsetBidStrategy,
        value: adsetBid.adsetBidValue,
        valueFormat: adsetBid.adsetBidValueFormat,
        mixed: adsetBid.adsetBidStrategyMixed,
        observedAt: adsetBid.adsetConfigUpdatedAt,
      }
    : campaignBid?.campaignBidStrategy
      ? {
          strategy: campaignBid.campaignBidStrategy,
          value: campaignBid.campaignBidValue,
          valueFormat: campaignBid.campaignBidValueFormat,
          mixed: campaignBid.campaignBidStrategyMixed,
          observedAt: campaignBid.campaignConfigUpdatedAt,
        }
      : null;
  const observedTimes = [
    lifecycle?.computedAt ?? null,
    creative?.creativeContextUpdatedAt ?? null,
    bidSource?.observedAt ?? null,
  ].flatMap((value) => (value === null ? [] : [value]));
  return {
    effectiveStatus: normalizeEffectiveStatus(
      lifecycle?.effectiveStatus ?? creative?.effectiveStatus ?? null,
    ),
    creativeFormat: normalizeCreativeFormat(
      lifecycle?.creativeFormat ?? creative?.creativeFormat ?? null,
    ),
    qualityRanking: normalizeMetaRanking(
      lifecycle?.qualityRanking ?? creative?.qualityRanking ?? null,
    ),
    engagementRateRanking: normalizeMetaRanking(
      lifecycle?.engagementRateRanking ??
        creative?.engagementRateRanking ??
        null,
    ),
    conversionRateRanking: normalizeMetaRanking(
      lifecycle?.conversionRateRanking ??
        creative?.conversionRateRanking ??
        null,
    ),
    lifecyclePosition: normalizeLifecyclePosition(
      lifecycle?.lifecyclePosition ?? null,
    ),
    retainedFatigueStatus: normalizeFatigueStatus(
      lifecycle?.fatigueStatus ?? null,
    ),
    fatigueConfidence: lifecycle?.fatigueConfidence ?? null,
    daysSincePeak: lifecycle?.daysSincePeak ?? null,
    peakRoas30d: lifecycle?.peakRoas30d ?? null,
    peakConfidence: lifecycle?.peakConfidence ?? null,
    spendTrajectory30d: normalizeSpendTrajectory(
      lifecycle?.spendTrajectory30d ?? null,
    ),
    spendSlope7d: lifecycle?.spendSlope7d ?? null,
    spendSlope30d: lifecycle?.spendSlope30d ?? null,
    roasSlope7d: lifecycle?.roasSlope7d ?? null,
    roasSlope30d: lifecycle?.roasSlope30d ?? null,
    lifecycleEngineVersion: lifecycle?.engineVersion ?? null,
    lifecycleComputedAt: lifecycle?.computedAt ?? null,
    bidStrategy: bidSource?.strategy ?? null,
    bidValue: bidSource?.value ?? null,
    bidValueFormat: bidSource?.valueFormat ?? null,
    bidRegime: classifyBidRegime({
      strategy: bidSource?.strategy ?? null,
      mixed: bidSource?.mixed ?? false,
    }),
    contextObservedAt:
      observedTimes.sort((left, right) => right.localeCompare(left))[0] ?? null,
  };
}

function formulaCalibrationContext(context: AdContext): {
  context: AdContext;
  source: "cutoff_safe_effective_status" | "observed_delivery_counterfactual";
} {
  if (context.retained.effectiveStatus !== null) {
    return { context, source: "cutoff_safe_effective_status" };
  }
  return {
    context: {
      ...context,
      retained: {
        ...context.retained,
        effectiveStatus: "ACTIVE",
      },
    },
    source: "observed_delivery_counterfactual",
  };
}

function indexCompleteness(rows: readonly AccountCompletenessRow[]) {
  return new Map(
    rows.map((row) => [
      `${row.businessId}::${row.providerAccountId}::${row.date}`,
      row.complete,
    ]),
  );
}

function factsBetween(
  rows: readonly AdDailyFact[],
  start: string,
  end: string,
) {
  return rows.filter((row) => row.date >= start && row.date <= end);
}

function latestContextRow(rows: readonly AdDailyFact[], asOfDate: string) {
  return (
    [...rows]
      .filter((row) => row.date <= asOfDate)
      .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null
  );
}

function buildAdContext(input: {
  business: BusinessRow;
  rows: readonly AdDailyFact[];
  lifecycleRows: readonly LifecycleObservation[];
  actionReceipts: readonly ActionReceipt[];
  asOfDate: string;
  completeness: ReadonlyMap<string, boolean>;
}): AdContext | null {
  const latest = latestContextRow(input.rows, input.asOfDate);
  if (!latest) return null;
  const currentDay = aggregateFacts(
    factsBetween(input.rows, input.asOfDate, input.asOfDate),
  );
  if (currentDay.spend <= 0 && currentDay.impressions <= 0) return null;
  const window7 = aggregateFacts(
    factsBetween(input.rows, addDays(input.asOfDate, -6), input.asOfDate),
  );
  const window14 = aggregateFacts(
    factsBetween(input.rows, addDays(input.asOfDate, -13), input.asOfDate),
  );
  const prior14 = aggregateFacts(
    factsBetween(
      input.rows,
      addDays(input.asOfDate, -27),
      addDays(input.asOfDate, -14),
    ),
  );
  const window28 = aggregateFacts(
    factsBetween(input.rows, addDays(input.asOfDate, -27), input.asOfDate),
  );
  const window30 = aggregateFacts(
    factsBetween(input.rows, addDays(input.asOfDate, -29), input.asOfDate),
  );
  const window90 = aggregateFacts(
    factsBetween(input.rows, addDays(input.asOfDate, -89), input.asOfDate),
  );
  const allObserved = aggregateFacts(
    input.rows.filter((row) => row.date <= input.asOfDate),
  );
  const cohort = resolveMetaFunnelCohort({
    optimizationGoal: latest.optimizationGoal,
    customEventType: latest.customEventType,
    objective: latest.objective,
    purchases: window28.purchases,
    revenue: window28.revenue,
  });
  const cutoff = `${input.asOfDate}T03:00:00.000Z`;
  const sourceRows = factsBetween(
    input.rows,
    addDays(input.asOfDate, -89),
    input.asOfDate,
  );
  const retained = resolveRetainedContext({
    rows: input.rows,
    lifecycleRows: input.lifecycleRows,
    asOfDate: input.asOfDate,
  });
  return {
    business: input.business,
    providerAccountId: latest.providerAccountId,
    campaignId: latest.campaignId,
    adsetId: latest.adsetId,
    adId: latest.adId,
    creativeId: latest.creativeId,
    adName: latest.adName,
    currency: latest.currency,
    objective: latest.objective,
    optimizationGoal: latest.optimizationGoal,
    customEventType: latest.customEventType,
    cohort,
    asOfDate: input.asOfDate,
    currentDay,
    window7,
    window14,
    prior14,
    window28,
    window30,
    window90,
    allObserved,
    accountCompleteAtCutoff:
      input.completeness.get(
        `${input.business.id}::${latest.providerAccountId}::${input.asOfDate}`,
      ) === true,
    sourceIds: Array.from(
      new Set(
        sourceRows.flatMap((row) =>
          row.sourceSnapshotId ? [row.sourceSnapshotId] : [],
        ),
      ),
    ).sort(),
    sourceUpdatedAfterCutoff: sourceRows.some(
      (row) => row.updatedAt !== null && row.updatedAt > cutoff,
    ),
    retained,
    actionExposureAtCutoff: summarizeActionExposure(
      input.actionReceipts,
      cutoff,
    ),
  };
}

function buildCalibration(input: {
  business: BusinessRow;
  adRows: readonly AdDailyFact[][];
  asOfDate: string;
  target: TargetPack | null;
}): AccountCalibration {
  const perAd = input.adRows.flatMap((rows) => {
    const trailing90 = aggregateFacts(
      factsBetween(rows, addDays(input.asOfDate, -89), input.asOfDate),
    );
    if (trailing90.spend <= 0) return [];
    const trailing28 = aggregateFacts(
      factsBetween(rows, addDays(input.asOfDate, -27), input.asOfDate),
    );
    const trailing7 = aggregateFacts(
      factsBetween(rows, addDays(input.asOfDate, -6), input.asOfDate),
    );
    return [{ trailing90, trailing28, trailing7 }];
  });
  const converters = perAd.filter(
    (row) => row.trailing90.purchases >= 1 && row.trailing90.revenue > 0,
  );
  const winners = converters.filter(
    (row) =>
      input.target?.targetRoas !== null &&
      input.target?.targetRoas !== undefined &&
      row.trailing90.roas !== null &&
      row.trailing90.roas >= input.target.targetRoas,
  );
  const roas = converters.flatMap((row) =>
    row.trailing90.roas === null ? [] : [row.trailing90.roas],
  );
  const cpas = perAd.flatMap((row) =>
    row.trailing90.cpa === null ? [] : [row.trailing90.cpa],
  );
  const recentRatios = perAd.flatMap((row) => {
    const recent = row.trailing7.roas;
    const total = row.trailing28.roas;
    return recent !== null && recent > 0 && total !== null && total > 0
      ? [recent / total]
      : [];
  });
  const lowCtrValues = perAd.flatMap((row) =>
    row.trailing28.ctr === null ? [] : [row.trailing28.ctr],
  );
  const roasRatios =
    input.target?.targetRoas && input.target.targetRoas > 0
      ? roas.map((value) => value / input.target!.targetRoas!)
      : [];
  const totalPurchases = perAd.reduce(
    (sum, row) => sum + row.trailing90.purchases,
    0,
  );
  const totalRevenue = perAd.reduce(
    (sum, row) => sum + row.trailing90.revenue,
    0,
  );
  const matureCount = converters.length;
  return {
    businessId: input.business.id,
    computedAt: `${input.asOfDate}T03:00:00.000Z`,
    campaignKind: "all",
    matureCreativeCount: matureCount,
    roasP75: matureCount >= 30 ? quantile(roas, 0.75) : null,
    roasP60: matureCount >= 10 ? quantile(roas, 0.6) : null,
    refreshRatioP10:
      recentRatios.length >= 20 ? quantile(recentRatios, 0.1) : null,
    lowCtrP10: lowCtrValues.length >= 20 ? quantile(lowCtrValues, 0.1) : null,
    accountCpaP50: cpas.length >= 20 ? quantile(cpas, 0.5) : null,
    accountCpaSampleCount: cpas.length,
    metaAttributedAovMean90d:
      totalPurchases > 0 ? totalRevenue / totalPurchases : null,
    metaAttributedAovPurchaseCount90d: Math.round(totalPurchases),
    metaAttributedRevenue90d: totalRevenue,
    matureSpendP50: quantile(
      converters.map((row) => row.trailing90.spend),
      0.5,
    ),
    matureSpendP75: quantile(
      converters.map((row) => row.trailing90.spend),
      0.75,
    ),
    winnerSpendP25: quantile(
      winners.map((row) => row.trailing90.spend),
      0.25,
    ),
    winnerSpendP50: quantile(
      winners.map((row) => row.trailing90.spend),
      0.5,
    ),
    winnerPurchaseP50: quantile(
      winners.map((row) => row.trailing90.purchases),
      0.5,
    ),
    roasRatioP10: quantile(roasRatios, 0.1),
    roasRatioP25: quantile(roasRatios, 0.25),
    roasRatioP50: quantile(roasRatios, 0.5),
    roasRatioP75: quantile(roasRatios, 0.75),
    metaAovQuality: classifyMetaAovQuality(Math.round(totalPurchases)),
  };
}

function positiveOverride(fallback: number, value: number | null | undefined) {
  return value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : fallback;
}

function effectiveProfileConfig(
  profile: ProfileConfig | null,
  asOfDate: string,
): ProfileConfig | null {
  if (!profile?.updatedAt) return null;
  return profile.updatedAt <= `${asOfDate}T03:00:00.000Z` ? profile : null;
}

function targetAtCutoff(
  observations: readonly TargetPack[],
  asOfDate: string,
): TargetPack | null {
  const cutoff = `${asOfDate}T03:00:00.000Z`;
  return (
    [...observations]
      .filter(
        (target) =>
          target.effectiveAt !== null &&
          target.recordedAt !== null &&
          target.effectiveAt <= cutoff &&
          target.recordedAt <= cutoff,
      )
      .sort(
        (left, right) =>
          (right.effectiveAt ?? "").localeCompare(left.effectiveAt ?? "") ||
          (right.recordedAt ?? "").localeCompare(left.recordedAt ?? "") ||
          left.source.localeCompare(right.source),
      )[0] ?? null
  );
}

function targetState(target: TargetPack | null, asOfDate: string) {
  if (!target?.effectiveAt || !target.recordedAt) {
    return { exact: false, fresh: false };
  }
  const cutoff = `${asOfDate}T03:00:00.000Z`;
  const exact = target.effectiveAt <= cutoff && target.recordedAt <= cutoff;
  const ageDays = exact
    ? diffDays(asOfDate, target.effectiveAt.slice(0, 10))
    : Number.POSITIVE_INFINITY;
  return { exact, fresh: exact && ageDays <= TARGET_FRESHNESS_DAYS };
}

function buildProfile(input: {
  business: BusinessRow;
  asOfDate: string;
  target: TargetPack | null;
  calibration: AccountCalibration;
  profileConfig: ProfileConfig | null;
  forceRawAuthority: boolean;
}): AccountDecisionProfile {
  const config = effectiveProfileConfig(input.profileConfig, input.asOfDate);
  const preset =
    config?.enginePresetLabel ?? input.target?.riskPosture ?? "balanced";
  const defaults = ENGINE_PRESET_MULTIPLIERS[preset];
  const multipliers: EngineMultiplierSet = {
    zeroConvBurner: positiveOverride(
      defaults.zeroConvBurner,
      config?.zeroConvBurnerMultiplier,
    ),
    cutCandidate: positiveOverride(
      defaults.cutCandidate,
      config?.cutCandidateMultiplier,
    ),
    sustainedLoser: positiveOverride(
      defaults.sustainedLoser,
      config?.sustainedLoserMultiplier,
    ),
    lossBudget: defaults.lossBudget,
    hardCut: positiveOverride(defaults.hardCut, config?.hardCutMultiplier),
    scalePurchase: positiveOverride(
      defaults.scalePurchase,
      config?.scalePurchaseMultiplier,
    ),
    winnerMemory: positiveOverride(
      defaults.winnerMemory,
      config?.winnerMemoryMultiplier,
    ),
    recentSample: positiveOverride(
      defaults.recentSample,
      config?.recentSampleMultiplier,
    ),
    weakFunnelRate: positiveOverride(
      defaults.weakFunnelRate,
      config?.weakFunnelRateMultiplier,
    ),
  };
  const targetStatus = targetState(input.target, input.asOfDate);
  const resolution = resolveSpendUnit({
    targetCpa: targetStatus.exact ? (input.target?.targetCpa ?? null) : null,
    operatorAovAssumption: targetStatus.exact
      ? (input.target?.operatorAovAssumption ?? null)
      : null,
    metaAttributedAovMean90d: input.calibration.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d:
      input.calibration.metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d: input.calibration.metaAttributedRevenue90d,
    targetRoas: targetStatus.exact ? (input.target?.targetRoas ?? null) : null,
    breakEvenRoas: targetStatus.exact
      ? (input.target?.breakEvenRoas ?? null)
      : null,
    accountCpaP50: input.calibration.accountCpaP50,
    accountCpaSampleCount: input.calibration.accountCpaSampleCount,
    attributionAovAdjustmentMultiplier: positiveOverride(
      1,
      config?.attributionAovAdjustmentMultiplier,
    ),
  });
  const spendThreshold = (multiplier: number) =>
    resolution.spendUnit !== null && resolution.spendUnit > 0
      ? resolution.spendUnit * multiplier
      : null;
  const purchaseThreshold = (baseline: number | null, multiplier: number) =>
    Math.max(
      1,
      Math.ceil((baseline && baseline > 0 ? baseline : 1) * multiplier),
    );
  const thresholds: EngineThresholdSet = {
    zeroConvBurnerSpend: spendThreshold(multipliers.zeroConvBurner),
    cutCandidateSpend: spendThreshold(multipliers.cutCandidate),
    sustainedLoserSpend: spendThreshold(multipliers.sustainedLoser),
    commercialMaturitySpend: spendThreshold(multipliers.lossBudget),
    hardCutSpend: spendThreshold(multipliers.hardCut),
    recentSampleMinSpend: spendThreshold(multipliers.recentSample),
    winnerMemoryMinSpend: spendThreshold(multipliers.winnerMemory),
    scaleMinPurchases: purchaseThreshold(
      input.calibration.winnerPurchaseP50,
      multipliers.scalePurchase,
    ),
    winnerMemoryMinPurchases: purchaseThreshold(
      input.calibration.winnerPurchaseP50,
      multipliers.winnerMemory,
    ),
    bottomQuartileRatio: input.calibration.roasRatioP25,
    severeLoserRatio: input.calibration.roasRatioP10,
  };
  const commercialThresholdEligible = resolution.hardEligibleByDefault;
  const scaleEligible =
    commercialThresholdEligible &&
    targetStatus.fresh &&
    (input.target?.targetRoas ?? 0) > 0 &&
    input.calibration.matureCreativeCount >= 30 &&
    (input.calibration.winnerPurchaseP50 ?? 0) > 0;
  const cutEligible =
    commercialThresholdEligible &&
    targetStatus.fresh &&
    (input.target?.breakEvenRoas ?? 0) > 0;
  const refreshEligible = commercialThresholdEligible;
  const hardActionEligibility = input.forceRawAuthority
    ? { scale: true, cut: true, refresh: true, reason: null, reasons: {} }
    : {
        scale: scaleEligible,
        cut: cutEligible,
        refresh: refreshEligible,
        reason:
          scaleEligible && cutEligible && refreshEligible
            ? null
            : "simulation authority gate",
        reasons: {
          scale: scaleEligible
            ? null
            : "fresh target and ready winner calibration required",
          cut: cutEligible
            ? null
            : "fresh explicit break-even and commercial threshold required",
          refresh: refreshEligible
            ? null
            : "commercial threshold evidence required",
        },
      };
  return {
    businessId: input.business.id,
    asOfDate: input.asOfDate,
    channel: "meta",
    objectiveFamily: "sales",
    preset,
    presetSource: config?.enginePresetLabel
      ? "business_decision_calibration_profile"
      : input.target?.riskPosture
        ? "target_pack_risk_posture"
        : "default",
    spendUnit: resolution.spendUnit,
    spendUnitSource: resolution.source,
    spendUnitConfidence: resolution.confidence,
    spendUnitEvidence: resolution.evidence,
    multipliers,
    thresholds,
    accountBaselines: input.calibration,
    funnelCalibration: { campaignKind: "all", byFormat: {} },
    scope: { type: "account", id: "*" },
    hardActionEligibility,
    quality: {
      commercialTruthReady:
        targetStatus.fresh &&
        (input.target?.targetRoas ?? 0) > 0 &&
        (input.target?.breakEvenRoas ?? 0) > 0,
      commercialTruthFreshness: targetStatus.fresh
        ? "fresh"
        : targetStatus.exact
          ? "stale"
          : "unknown",
      calibrationReady: input.calibration.matureCreativeCount >= 30,
      metaAovQuality: input.calibration.metaAovQuality,
      thresholdQuality:
        resolution.spendUnit === null
          ? "insufficient"
          : resolution.confidence === "high" ||
              resolution.confidence === "medium"
            ? "ready"
            : "degraded",
    },
  };
}

function cloneProfile(profile: AccountDecisionProfile): AccountDecisionProfile {
  return {
    ...profile,
    multipliers: { ...profile.multipliers },
    thresholds: { ...profile.thresholds },
    accountBaselines: { ...profile.accountBaselines },
    spendUnitEvidence: {
      ...profile.spendUnitEvidence,
      warnings: [...profile.spendUnitEvidence.warnings],
    },
    hardActionEligibility: {
      ...profile.hardActionEligibility,
      reasons: { ...profile.hardActionEligibility.reasons },
    },
    quality: { ...profile.quality },
    scope: { ...profile.scope },
  };
}

interface ReplayEnvironment {
  frequencyThresholds: Record<"0.7" | "0.75" | "0.8" | "0.85", number | null>;
  campaignSpend28: Map<string, number>;
  peerRoasThresholds: Record<"0.7" | "0.75" | "0.8", number | null>;
  funnelBaselines: Record<
    "8" | "20" | "30",
    Record<string, FormatFunnelBaseline>
  >;
  ratioObservations: {
    all: Array<{ value: number; ageDays: number }>;
    byGoal: Map<string, Array<{ value: number; ageDays: number }>>;
  };
  hierarchicalThresholdCache: Map<string, number | null>;
  nonPurchaseCprThresholds: Map<
    string,
    { p25: number | null; p50: number | null; sampleSize: number }
  >;
}

const NON_PURCHASE_WEIGHT_MODES = [
  "goal_result",
  "lead_message_total",
  "site_conversion_total",
  "balanced_depth",
] as const;

function effectiveNonPurchaseResults(
  metrics: Pick<
    AggregateMetrics,
    | "purchases"
    | "leads"
    | "messages"
    | "landingPageViews"
    | "addToCart"
    | "initiateCheckout"
  >,
  cohort: MetaFunnelCohort,
  mode: NonNullable<VariantSpec["nonPurchaseWeightMode"]>,
): number | null {
  const leadsAndMessages =
    metrics.leads === null && metrics.messages === null
      ? null
      : (metrics.leads ?? 0) + (metrics.messages ?? 0);
  if (mode === "lead_message_total") {
    return cohort === "lead" || cohort === "unknown" ? leadsAndMessages : null;
  }
  if (mode === "site_conversion_total") {
    return cohort === "lead" || cohort === "mid_funnel"
      ? Math.max(metrics.purchases, metrics.leads ?? 0)
      : null;
  }
  if (mode === "balanced_depth") {
    const hasDepth =
      leadsAndMessages !== null ||
      metrics.initiateCheckout !== null ||
      metrics.addToCart !== null ||
      metrics.landingPageViews !== null;
    return hasDepth
      ? (leadsAndMessages ?? 0) +
          (metrics.initiateCheckout ?? 0) * 0.5 +
          (metrics.addToCart ?? 0) * 0.2 +
          (metrics.landingPageViews ?? 0) * 0.02
      : null;
  }
  if (cohort === "lead") {
    return Math.max(metrics.purchases, leadsAndMessages ?? 0);
  }
  if (cohort === "traffic") {
    return Math.max(metrics.purchases, metrics.landingPageViews ?? 0);
  }
  if (cohort === "mid_funnel") {
    return Math.max(
      metrics.purchases,
      metrics.initiateCheckout ?? 0,
      metrics.addToCart ?? 0,
    );
  }
  if (cohort === "upper_funnel" || cohort === "engagement") {
    return metrics.purchases;
  }
  return null;
}

function percentRate(numerator: number | null, denominator: number) {
  return numerator !== null && denominator > 0
    ? (numerator / denominator) * 100
    : null;
}

export function buildFunnelBaseline(
  contexts: readonly AdContext[],
  sampleFloor: 8 | 20 | 30,
  creativeFormat: CreativeFormat | "overall",
): FormatFunnelBaseline | null {
  const samples = contexts
    .filter(
      (context) =>
        creativeFormat === "overall" ||
        context.retained.creativeFormat === creativeFormat,
    )
    .map((context) => context.window28)
    .filter((metrics) => metrics.funnelObservedDays > 0)
    .map((metrics) => ({
      ctr: metrics.ctr,
      cpm:
        metrics.impressions > 0
          ? (metrics.spend / metrics.impressions) * 1000
          : null,
      thumbstop: metrics.thumbstop,
      linkToLpv: percentRate(metrics.landingPageViews, metrics.linkClicks),
      linkToAtc: percentRate(metrics.addToCart, metrics.linkClicks),
      lpvToAtc: percentRate(metrics.addToCart, metrics.landingPageViews ?? 0),
      atcToIc: percentRate(metrics.initiateCheckout, metrics.addToCart ?? 0),
      icToPurchase: percentRate(
        metrics.purchases,
        metrics.initiateCheckout ?? 0,
      ),
      clickToPurchase: percentRate(metrics.purchases, metrics.linkClicks),
    }));
  const percentile = (
    field: keyof (typeof samples)[number],
    percentileValue: number,
  ) => {
    const values = samples.flatMap((sample) =>
      sample[field] === null ? [] : [sample[field]],
    );
    return values.length >= sampleFloor
      ? quantile(values as number[], percentileValue)
      : null;
  };
  const baseline: FormatFunnelBaseline = {
    creativeFormat,
    ctrP25: percentile("ctr", 0.25),
    ctrP50: percentile("ctr", 0.5),
    cpmP50: percentile("cpm", 0.5),
    cpmP75: percentile("cpm", 0.75),
    thumbstopP25: percentile("thumbstop", 0.25),
    thumbstopP50: percentile("thumbstop", 0.5),
    linkToLpvP25: percentile("linkToLpv", 0.25),
    linkToLpvP50: percentile("linkToLpv", 0.5),
    linkToAtcP25: percentile("linkToAtc", 0.25),
    linkToAtcP50: percentile("linkToAtc", 0.5),
    lpvToAtcP25: percentile("lpvToAtc", 0.25),
    lpvToAtcP50: percentile("lpvToAtc", 0.5),
    atcToIcP25: percentile("atcToIc", 0.25),
    atcToIcP50: percentile("atcToIc", 0.5),
    icToPurchaseP25: percentile("icToPurchase", 0.25),
    icToPurchaseP50: percentile("icToPurchase", 0.5),
    clickToPurchaseP25: percentile("clickToPurchase", 0.25),
    clickToPurchaseP50: percentile("clickToPurchase", 0.5),
    sampleSize: samples.length,
    qualityStatus: "ready",
  };
  const hasMetric = Object.entries(baseline).some(([key, value]) =>
    key.endsWith("P25") || key.endsWith("P50") || key.endsWith("P75")
      ? value !== null
      : false,
  );
  return hasMetric ? baseline : null;
}

export function buildFunnelBaselines(
  contexts: readonly AdContext[],
  sampleFloor: 8 | 20 | 30,
): Record<string, FormatFunnelBaseline> {
  const formats = Array.from(
    new Set(
      contexts.flatMap((context) =>
        context.retained.creativeFormat
          ? [context.retained.creativeFormat]
          : [],
      ),
    ),
  ).sort();
  const result: Record<string, FormatFunnelBaseline> = {};
  for (const format of ["overall", ...formats] as const) {
    const baseline = buildFunnelBaseline(contexts, sampleFloor, format);
    if (baseline) result[format] = baseline;
  }
  return result;
}

function buildReplayEnvironment(
  contexts: readonly AdContext[],
  target: TargetPack | null,
): ReplayEnvironment {
  const frequencies = contexts.flatMap((context) =>
    context.window28.frequency === null ? [] : [context.window28.frequency],
  );
  const peerRoas = contexts.flatMap((context) =>
    context.window28.purchases > 0 && context.window28.roas !== null
      ? [context.window28.roas]
      : [],
  );
  const campaignSpend28 = new Map<string, number>();
  const ratioAll: Array<{ value: number; ageDays: number }> = [];
  const ratioByGoal = new Map<
    string,
    Array<{ value: number; ageDays: number }>
  >();
  for (const context of contexts) {
    campaignSpend28.set(
      context.campaignId,
      (campaignSpend28.get(context.campaignId) ?? 0) + context.window28.spend,
    );
    const targetRoas = target?.targetRoas ?? null;
    const roas = context.window90.roas;
    const lastSpendDate = context.window90.lastSpendDate;
    if (
      targetRoas !== null &&
      targetRoas > 0 &&
      roas !== null &&
      roas > 0 &&
      lastSpendDate !== null
    ) {
      const observation = {
        value: roas / targetRoas,
        ageDays: Math.max(0, diffDays(context.asOfDate, lastSpendDate)),
      };
      ratioAll.push(observation);
      const goal = context.optimizationGoal ?? "unknown";
      const list = ratioByGoal.get(goal) ?? [];
      list.push(observation);
      ratioByGoal.set(goal, list);
    }
  }
  const nonPurchaseCprThresholds = new Map<
    string,
    { p25: number | null; p50: number | null; sampleSize: number }
  >();
  for (const mode of NON_PURCHASE_WEIGHT_MODES) {
    const groups = new Map<string, AdContext[]>();
    for (const context of contexts) {
      if (context.cohort === "purchase") continue;
      const key = `${context.cohort}::${context.optimizationGoal ?? "unknown"}`;
      const list = groups.get(key) ?? [];
      list.push(context);
      groups.set(key, list);
    }
    for (const [groupKey, group] of groups) {
      const costs = group.flatMap((context) => {
        if (context.window28.spend <= 0) return [];
        const results = effectiveNonPurchaseResults(
          context.window28,
          context.cohort,
          mode,
        );
        return results !== null && results > 0
          ? [context.window28.spend / results]
          : [];
      });
      nonPurchaseCprThresholds.set(`${mode}::${groupKey}`, {
        p25: costs.length >= 8 ? quantile(costs, 0.25) : null,
        p50: costs.length >= 8 ? quantile(costs, 0.5) : null,
        sampleSize: costs.length,
      });
    }
  }
  return {
    frequencyThresholds: {
      "0.7": frequencies.length >= 8 ? quantile(frequencies, 0.7) : null,
      "0.75": frequencies.length >= 8 ? quantile(frequencies, 0.75) : null,
      "0.8": frequencies.length >= 8 ? quantile(frequencies, 0.8) : null,
      "0.85": frequencies.length >= 8 ? quantile(frequencies, 0.85) : null,
    },
    campaignSpend28,
    peerRoasThresholds: {
      "0.7": peerRoas.length >= 20 ? quantile(peerRoas, 0.7) : null,
      "0.75": peerRoas.length >= 20 ? quantile(peerRoas, 0.75) : null,
      "0.8": peerRoas.length >= 20 ? quantile(peerRoas, 0.8) : null,
    },
    funnelBaselines: {
      "8": buildFunnelBaselines(contexts, 8),
      "20": buildFunnelBaselines(contexts, 20),
      "30": buildFunnelBaselines(contexts, 30),
    },
    ratioObservations: { all: ratioAll, byGoal: ratioByGoal },
    hierarchicalThresholdCache: new Map(),
    nonPurchaseCprThresholds,
  };
}

function resolveHierarchicalRatioThreshold(input: {
  environment: ReplayEnvironment;
  context: AdContext;
  variant: VariantSpec;
}) {
  const halfLife = input.variant.calibrationHalfLifeDays;
  const kappa = input.variant.calibrationShrinkageKappa;
  const targetQuantile = input.variant.calibrationQuantile;
  if (halfLife === null || kappa === null || targetQuantile === null) {
    return null;
  }
  const goal = input.context.optimizationGoal ?? "unknown";
  const cacheKey = `${halfLife}:${kappa}:${targetQuantile}:${goal}`;
  if (input.environment.hierarchicalThresholdCache.has(cacheKey)) {
    return input.environment.hierarchicalThresholdCache.get(cacheKey) ?? null;
  }
  const toWeighted = (
    observations: ReadonlyArray<{ value: number; ageDays: number }>,
  ) =>
    observations.flatMap((observation) => {
      const weight = recencyWeight(observation.ageDays, halfLife);
      return weight === null ? [] : [{ value: observation.value, weight }];
    });
  const parentWeighted = toWeighted(input.environment.ratioObservations.all);
  const localWeighted = toWeighted(
    input.environment.ratioObservations.byGoal.get(goal) ?? [],
  );
  const parent = weightedQuantile(parentWeighted, targetQuantile);
  const local = weightedQuantile(localWeighted, targetQuantile);
  const localEffective = effectiveSampleSize(
    localWeighted.map((observation) => observation.weight),
  );
  const resolved =
    local !== null && parent !== null && localEffective !== null
      ? (shrinkPositiveRatioLogSpace({
          local,
          parent,
          localEffectiveSampleSize: localEffective,
          kappa,
        })?.value ?? parent)
      : (local ?? parent);
  input.environment.hierarchicalThresholdCache.set(cacheKey, resolved);
  return resolved;
}

function computeFatigueForVariant(input: {
  context: AdContext;
  profile: AccountDecisionProfile;
  environment: ReplayEnvironment;
  variant: VariantSpec;
}): FatigueStatus {
  const frequencyThreshold =
    input.environment.frequencyThresholds[
      String(
        input.variant.fatigueFrequencyQuantile,
      ) as keyof ReplayEnvironment["frequencyThresholds"]
    ];
  const windows = {
    last14: historicalWindow(input.context.window14),
    prior14: historicalWindow(input.context.prior14),
    last30: historicalWindow(input.context.window30),
    last90: historicalWindow(input.context.window90),
    allHistory: historicalWindow(input.context.allObserved),
  };
  if (input.variant.family !== "H5" && input.variant.family !== "HC") {
    return computeFatigue({
      ctr: input.context.window28.ctr,
      roas: input.context.window28.roas,
      clickToPurchaseRate:
        input.context.window28.clicks > 0
          ? input.context.window28.purchases / input.context.window28.clicks
          : null,
      effectiveTargetRoas: input.profile.spendUnitEvidence.targetRoas,
      breakevenRoas: input.profile.spendUnitEvidence.breakEvenRoas,
      winnerMemoryMinSpend: input.profile.thresholds.winnerMemoryMinSpend,
      winnerMemoryMinPurchases:
        input.profile.thresholds.winnerMemoryMinPurchases,
      historicalWindows: windows,
      spendConcentration: null,
      frequency: input.context.window28.frequency,
      frequencyPressureThreshold: frequencyThreshold,
      benchmarkRoasStatus: null,
      benchmarkClickToPurchaseStatus: null,
    }).status;
  }

  const minSpend = input.profile.thresholds.winnerMemoryMinSpend ?? 0;
  const minPurchases = input.profile.thresholds.winnerMemoryMinPurchases;
  const eligible = (window: HistoricalWindow | null) =>
    window !== null &&
    window.spend >= minSpend &&
    window.purchases >= minPurchases;
  const recent = eligible(windows.last14) ? windows.last14 : null;
  const prior = eligible(windows.prior14) ? windows.prior14 : null;
  const decay = (before: number, after: number) =>
    before > 0 && Number.isFinite(after) ? (before - after) / before : null;
  const decays =
    recent && prior
      ? [
          decay(prior.ctr, recent.ctr),
          decay(prior.clickToPurchaseRate, recent.clickToPurchaseRate),
          decay(prior.roas, recent.roas),
        ].flatMap((value) =>
          value === null || !Number.isFinite(value) ? [] : [value],
        )
      : [];
  const significant = decays.filter(
    (value) => value >= input.variant.fatigueDecayThreshold,
  ).length;
  const disjointStrongWindows = deriveDisjointWindows(windows).filter(
    (window) => {
      if (window.spend < minSpend || window.purchases < minPurchases)
        return false;
      const thresholds = [
        (input.profile.spendUnitEvidence.targetRoas ?? 0) * 0.85,
        (input.profile.spendUnitEvidence.breakEvenRoas ?? 0) * 1.1,
      ].filter((value) => value > 0);
      return thresholds.length > 0 && window.roas >= Math.max(...thresholds);
    },
  ).length;
  const winnerMemory = disjointStrongWindows >= 2;
  const campaignSpend =
    input.environment.campaignSpend28.get(input.context.campaignId) ?? 0;
  const concentration = ratio(input.context.window28.spend, campaignSpend);
  const pressure =
    (frequencyThreshold !== null &&
      input.context.window28.frequency !== null &&
      input.context.window28.frequency >= frequencyThreshold) ||
    (concentration !== null &&
      concentration >= input.variant.fatigueConcentrationThreshold);
  if (!pressure) return winnerMemory || windows.last14 ? "none" : "unknown";
  if (winnerMemory && significant >= input.variant.fatigueRequiredDecayCount)
    return "fatigued";
  if (winnerMemory && significant >= 1) return "watch";
  if (!winnerMemory && significant >= input.variant.fatigueRequiredDecayCount)
    return "watch";
  return "none";
}

function applyVariantProfile(input: {
  profile: AccountDecisionProfile;
  target: TargetPack | null;
  variant: VariantSpec;
  hierarchicalRatioThreshold: number | null;
}) {
  const profile = cloneProfile(input.profile);
  if (input.variant.zeroConvBurnerMultiplier !== null) {
    profile.multipliers.zeroConvBurner = input.variant.zeroConvBurnerMultiplier;
    profile.thresholds.zeroConvBurnerSpend =
      profile.spendUnit === null
        ? null
        : profile.spendUnit * input.variant.zeroConvBurnerMultiplier;
  }
  if (input.variant.lossBudgetMultiplier !== null) {
    profile.multipliers.lossBudget = input.variant.lossBudgetMultiplier;
    profile.thresholds.commercialMaturitySpend =
      profile.spendUnit !== null
        ? profile.spendUnit * input.variant.lossBudgetMultiplier
        : profile.thresholds.commercialMaturitySpend;
  }
  if (input.variant.hardCutMultiplier !== null) {
    profile.multipliers.hardCut = input.variant.hardCutMultiplier;
    profile.thresholds.hardCutSpend =
      profile.spendUnit === null
        ? null
        : profile.spendUnit * input.variant.hardCutMultiplier;
  }
  if (input.variant.scalePurchaseMultiplier !== null) {
    profile.multipliers.scalePurchase = input.variant.scalePurchaseMultiplier;
    profile.thresholds.scaleMinPurchases = Math.max(
      1,
      Math.ceil(
        (profile.accountBaselines.winnerPurchaseP50 ?? 1) *
          input.variant.scalePurchaseMultiplier,
      ),
    );
  }
  if (input.variant.funnelWeakMultiplier !== null) {
    profile.multipliers.weakFunnelRate = input.variant.funnelWeakMultiplier;
  }
  if (input.hierarchicalRatioThreshold !== null) {
    profile.thresholds.bottomQuartileRatio = input.hierarchicalRatioThreshold;
  }
  if (input.variant.cutBoundaryMode !== "account_p25") {
    const current = profile.thresholds.bottomQuartileRatio;
    const target = input.target?.targetRoas ?? null;
    const breakeven = input.target?.breakEvenRoas ?? null;
    const breakevenRatio =
      target && target > 0 && breakeven && breakeven > 0
        ? breakeven / target
        : null;
    if (input.variant.cutBoundaryMode === "account_p10") {
      profile.thresholds.bottomQuartileRatio =
        profile.thresholds.severeLoserRatio ?? current;
    } else if (current !== null && breakevenRatio !== null) {
      profile.thresholds.bottomQuartileRatio =
        input.variant.cutBoundaryMode === "below_both"
          ? Math.min(current, breakevenRatio)
          : Math.min((current + breakevenRatio) / 2, breakevenRatio);
    }
  }
  return profile;
}

function buildCreativeInput(input: {
  context: AdContext;
  target: TargetPack | null;
  targetExact: boolean;
  targetFresh: boolean;
  profile: AccountDecisionProfile;
  environment: ReplayEnvironment;
  variant: VariantSpec;
}): CreativeInput {
  const simulatedFatigueStatus = computeFatigueForVariant({
    context: input.context,
    profile: input.profile,
    environment: input.environment,
    variant: input.variant,
  });
  const fatigueStatus =
    input.variant.family === "H5"
      ? simulatedFatigueStatus
      : (input.context.retained.retainedFatigueStatus ??
        simulatedFatigueStatus);
  const identityUnknown =
    !input.context.providerAccountId ||
    !input.context.campaignId ||
    !input.context.adsetId ||
    !input.context.adId ||
    !input.context.optimizationGoal ||
    !input.context.objective;
  const firstDate = input.context.allObserved.firstDate;
  return {
    creativeId: input.context.adId,
    creativeName: input.context.adName,
    businessId: input.context.business.id,
    campaignId: input.context.campaignId,
    objective: normalizeObjective(input.context.objective),
    contextGrain: {
      providerAccountCount: input.context.providerAccountId ? 1 : 0,
      campaignCount: input.context.campaignId ? 1 : 0,
      adsetCount: input.context.adsetId ? 1 : 0,
      optimizationContextCount:
        input.context.optimizationGoal || input.context.customEventType ? 1 : 0,
      objectiveCount: input.context.objective ? 1 : 0,
      contextIdentityUnknown: identityUnknown,
    },
    effectiveCohort: input.context.cohort,
    spend: input.context.window28.spend,
    purchases: input.context.window28.purchases,
    purchaseValue: input.context.window28.revenue,
    impressions: input.context.window28.impressions,
    linkClicks: input.context.window28.linkClicks,
    roas: input.context.window28.roas,
    cpa: input.context.window28.cpa,
    ctr: input.context.window28.ctr,
    frequency: input.context.window28.frequency,
    recent7dSpend: input.context.window7.spend,
    recent7dPurchases: input.context.window7.purchases,
    recent7dRoas: input.context.window7.roas,
    recent7dImpressions: input.context.window7.impressions,
    effectiveStatus: input.context.retained.effectiveStatus,
    ageDays: firstDate ? diffDays(input.context.asOfDate, firstDate) + 1 : null,
    firstSeenAt: firstDate,
    firstSpendAt: firstDate,
    lastSpendAt: input.context.window28.lastSpendDate,
    spend24h: input.context.currentDay.spend,
    impressions24h: input.context.currentDay.impressions,
    reviewStatus: null,
    policyReason: null,
    disapprovalReason: null,
    limitedReason: null,
    dataFreshnessHours: input.context.accountCompleteAtCutoff ? 0 : null,
    fatigueStatus,
    targetRoas: input.targetExact ? (input.target?.targetRoas ?? null) : null,
    breakevenRoas: input.targetExact
      ? (input.target?.breakEvenRoas ?? null)
      : null,
    commercialTargetFreshness: input.targetFresh
      ? "fresh"
      : input.targetExact
        ? "stale"
        : "unknown",
    lifecyclePosition: input.context.retained.lifecyclePosition,
    daysSincePeak: input.context.retained.daysSincePeak,
    peakRoas30d: input.context.retained.peakRoas30d,
    peakConfidence: input.context.retained.peakConfidence,
    spendTrajectory30d: input.context.retained.spendTrajectory30d,
    spendSlope7d: input.context.retained.spendSlope7d,
    spendSlope30d: input.context.retained.spendSlope30d,
    roasSlope7d: input.context.retained.roasSlope7d,
    roasSlope30d: input.context.retained.roasSlope30d,
    cpm:
      input.context.window28.impressions > 0
        ? (input.context.window28.spend / input.context.window28.impressions) *
          1000
        : null,
    outboundClicks: input.context.window28.outboundClicks,
    landingPageViews: input.context.window28.landingPageViews,
    addToCart: input.context.window28.addToCart,
    initiateCheckout: input.context.window28.initiateCheckout,
    thumbstop: input.context.window28.thumbstop,
    video25Rate: input.context.window28.video25Rate,
    video50Rate: input.context.window28.video50Rate,
    video75Rate: input.context.window28.video75Rate,
    video100Rate: input.context.window28.video100Rate,
    qualityRanking: input.context.retained.qualityRanking,
    engagementRateRanking: input.context.retained.engagementRateRanking,
    conversionRateRanking: input.context.retained.conversionRateRanking,
    creativeFormat: input.context.retained.creativeFormat,
  };
}

function purchaseFloor(input: {
  variant: VariantSpec;
  calibration: AccountCalibration;
}) {
  if (input.variant.cutPurchaseFloorMode === "none") return null;
  if (input.variant.cutPurchaseFloorMode === "fixed_2") return 2;
  if (input.variant.cutPurchaseFloorMode === "fixed_3") return 3;
  return Math.max(
    2,
    Math.ceil((input.calibration.winnerPurchaseP50 ?? 1) * 0.5),
  );
}

function decisionAxes(input: {
  decision: DecisionOutput;
  creative: CreativeInput;
  target: TargetPack | null;
  targetExact: boolean;
  relativeWinner: boolean;
  budgetScaleEligible: boolean;
}): DecisionAxes {
  const roas = input.creative.roas;
  const target = input.targetExact ? (input.target?.targetRoas ?? null) : null;
  const breakeven = input.targetExact
    ? (input.target?.breakEvenRoas ?? null)
    : null;
  const economicVerdict =
    roas === null || target === null || breakeven === null
      ? "uncertain"
      : roas >= target
        ? "above_target"
        : roas < breakeven
          ? "below_breakeven"
          : "between_target_and_breakeven";
  const portfolioRole: PortfolioRole =
    input.relativeWinner || input.decision.label === "scale"
      ? "current_winner"
      : input.creative.ageDays !== null && input.creative.ageDays <= 7
        ? "learning"
        : input.decision.label === "cut"
          ? "exhausted"
          : input.decision.label === "refresh"
            ? "declining"
            : input.decision.label === "test_more"
              ? "challenger"
              : "unknown";
  const hard =
    input.decision.label === "scale" ||
    input.decision.label === "cut" ||
    input.decision.label === "refresh";
  const authorityState: AuthorityState =
    !input.targetExact &&
    (input.decision.label === "scale" || input.decision.label === "cut")
      ? "blocked_commercial"
      : hard
        ? "review_only"
        : "review_only";
  const executionAction: ExecutionAction =
    input.decision.label === "cut"
      ? "cut_ad"
      : input.decision.label === "refresh"
        ? "refresh_creative"
        : input.decision.label === "scale" || input.budgetScaleEligible
          ? "keep_running"
          : input.relativeWinner
            ? "promote_to_main"
            : input.decision.label === "test_more"
              ? input.creative.ageDays !== null && input.creative.ageDays <= 3
                ? "watch_launch"
                : "continue_test"
              : "none";
  return {
    economicVerdict,
    portfolioRole,
    authorityState,
    executionAction,
    operationalState:
      (input.creative.spend24h ?? 0) > 0 ||
      (input.creative.impressions24h ?? 0) > 0
        ? "observed_delivery"
        : "no_delivery_observed",
  };
}

function evaluateVariant(input: {
  context: AdContext;
  target: TargetPack | null;
  targetExact: boolean;
  targetFresh: boolean;
  baseRawProfile: AccountDecisionProfile;
  calibration: AccountCalibration;
  environment: ReplayEnvironment;
  variant: VariantSpec;
}): VariantDecision {
  const profile = applyVariantProfile({
    profile: input.baseRawProfile,
    target: input.targetExact ? input.target : null,
    variant: input.variant,
    hierarchicalRatioThreshold: resolveHierarchicalRatioThreshold({
      environment: input.environment,
      context: input.context,
      variant: input.variant,
    }),
  });
  const funnelSampleFloor = input.variant.funnelEffectiveSampleFloor ?? 20;
  const funnelBaselines =
    input.environment.funnelBaselines[
      String(funnelSampleFloor) as "8" | "20" | "30"
    ];
  profile.funnelCalibration = {
    campaignKind: "all",
    byFormat: { ...funnelBaselines },
  };
  const creative = buildCreativeInput({
    context: input.context,
    target: input.target,
    targetExact: input.targetExact,
    targetFresh: input.targetFresh,
    profile,
    environment: input.environment,
    variant: input.variant,
  });
  let decision = decideCreative(creative, profile);
  const diagnosis = computeFunnelDiagnosis({
    creative,
    funnelCalibration: profile.funnelCalibration,
    profile,
  });
  if (
    (input.variant.family === "H6" || input.variant.family === "HC") &&
    input.variant.funnelConfidenceFloor !== null &&
    decision.label === "diagnose" &&
    diagnosis.confidence < (input.variant.funnelConfidenceFloor ?? 0)
  ) {
    decision = {
      ...decision,
      label: "keep",
      blockedActionType: "diagnose",
      reason: `[simulation funnel confidence floor] ${decision.reason}`,
    };
  }
  const floor = purchaseFloor({
    variant: input.variant,
    calibration: input.calibration,
  });
  const bypass =
    decision.reason.toLowerCase().includes("sustained loser") ||
    decision.reason.toLowerCase().includes("severe loser") ||
    decision.reason.toLowerCase().includes("clear loser at scale") ||
    (creative.purchases === 0 &&
      decision.reason.toLowerCase().includes("zero"));
  const floorBlocked =
    decision.label === "cut" &&
    floor !== null &&
    creative.purchases < floor &&
    !bypass;
  if (floorBlocked) {
    decision = {
      ...decision,
      label: "test_more",
      blockedActionType: "cut",
      reason: `[simulation purchase floor] ${decision.reason} Need ${floor}+ purchases or sustained-loss bypass.`,
    };
  }
  const relativeThreshold =
    input.variant.relativeWinnerQuantile === null
      ? null
      : input.environment.peerRoasThresholds[
          String(
            input.variant.relativeWinnerQuantile,
          ) as keyof ReplayEnvironment["peerRoasThresholds"]
        ];
  let relativeWinner =
    relativeThreshold !== null &&
    creative.roas !== null &&
    creative.roas >= relativeThreshold &&
    creative.spend >=
      (profile.thresholds.commercialMaturitySpend ??
        Number.POSITIVE_INFINITY) &&
    creative.purchases >= profile.thresholds.scaleMinPurchases;
  let budgetScaleEligible =
    input.variant.budgetScaleTargetRatio !== null &&
    input.targetExact &&
    (input.target?.targetRoas ?? 0) > 0 &&
    creative.roas !== null &&
    creative.roas >=
      (input.target?.targetRoas ?? Number.POSITIVE_INFINITY) *
        input.variant.budgetScaleTargetRatio &&
    creative.purchases >= profile.thresholds.scaleMinPurchases;
  let nonPurchaseThresholdKnown = false;
  if (
    input.variant.family === "H8" &&
    input.variant.nonPurchaseWeightMode !== null &&
    input.variant.nonPurchaseDepthGate !== null
  ) {
    const results = effectiveNonPurchaseResults(
      input.context.window28,
      input.context.cohort,
      input.variant.nonPurchaseWeightMode,
    );
    const threshold = input.environment.nonPurchaseCprThresholds.get(
      `${input.variant.nonPurchaseWeightMode}::${input.context.cohort}::${input.context.optimizationGoal ?? "unknown"}`,
    ) ?? { p25: null, p50: null, sampleSize: 0 };
    nonPurchaseThresholdKnown = threshold.p25 !== null;
    relativeWinner =
      results !== null &&
      results >= input.variant.nonPurchaseDepthGate &&
      input.context.window28.spend > 0 &&
      threshold.p25 !== null &&
      input.context.window28.spend / results <= threshold.p25;
    budgetScaleEligible = false;
    decision = {
      ...decision,
      label: relativeWinner ? "keep" : "test_more",
      blockedActionType: null,
      reason: relativeWinner
        ? `[simulation non-purchase winner] ${input.variant.nonPurchaseWeightMode} cost per result is in the account-goal top quartile at depth ${results?.toFixed(2)}.`
        : `[simulation non-purchase review] ${input.variant.nonPurchaseWeightMode} needs a cutoff-safe peer threshold and depth ${input.variant.nonPurchaseDepthGate}.`,
    };
  }
  let axes = decisionAxes({
    decision,
    creative,
    target: input.target,
    targetExact: input.targetExact,
    relativeWinner,
    budgetScaleEligible,
  });
  if (input.variant.family === "H8") {
    axes = {
      economicVerdict: "not_applicable",
      portfolioRole: relativeWinner
        ? "current_winner"
        : creative.ageDays !== null && creative.ageDays <= 7
          ? "learning"
          : "challenger",
      authorityState: nonPurchaseThresholdKnown
        ? "review_only"
        : "blocked_data",
      executionAction: relativeWinner
        ? "promote_to_main"
        : creative.ageDays !== null && creative.ageDays <= 3
          ? "watch_launch"
          : "continue_test",
      operationalState:
        (creative.spend24h ?? 0) > 0 || (creative.impressions24h ?? 0) > 0
          ? "observed_delivery"
          : "no_delivery_observed",
    };
  }
  return {
    variantId: input.variant.id,
    applicable: true,
    label: decision.label,
    confidence: decision.confidence,
    blockedActionType: decision.blockedActionType ?? null,
    reason: decision.reason,
    axes,
    cutPurchaseFloor: floor,
    cutPurchaseFloorBlocked: floorBlocked,
    funnelStage:
      diagnosis.primaryWeakStage === "none" ||
      diagnosis.primaryWeakStage === "insufficient_signal"
        ? null
        : diagnosis.primaryWeakStage,
    funnelConfidence: diagnosis.confidence,
    funnelWeakMultiplier: profile.multipliers.weakFunnelRate,
    funnelSampleFloor,
    fatigueStatus: creative.fatigueStatus ?? "unknown",
    budgetScaleEligible,
  };
}

function variantApplicable(input: {
  variant: VariantSpec;
  context: AdContext;
  targetExact: boolean;
}) {
  if (input.variant.family === "V0") return true;
  if (
    input.variant.family === "H1" ||
    input.variant.family === "H2" ||
    input.variant.family === "H3"
  ) {
    return input.context.cohort === "purchase" && input.targetExact;
  }
  if (input.variant.family === "H4" || input.variant.family === "H5") {
    return input.context.cohort === "purchase";
  }
  if (input.variant.family === "H6") {
    return input.context.window28.funnelObservedDays > 0;
  }
  if (input.variant.family === "H8") {
    return input.context.cohort !== "purchase";
  }
  if (input.variant.family === "HC") {
    return input.context.cohort === "purchase" && input.targetExact;
  }
  return false;
}

function buildForwardOutcome(input: {
  context: AdContext;
  rows: readonly AdDailyFact[];
  actionReceipts: readonly ActionReceipt[];
  completeness: ReadonlyMap<string, boolean>;
  outcomeCeiling: string;
  windowDays: OutcomeWindowDays;
  target: TargetPack | null;
  targetExact: boolean;
  targetFresh: boolean;
  baseProfile: AccountDecisionProfile;
  environment: ReplayEnvironment;
  baselineVariant: VariantSpec;
}): ForwardOutcome {
  const { start, end } = outcomeWindowDates(
    input.context.asOfDate,
    input.windowDays,
  );
  const expectedDates = dateRange(start, end);
  const present = expectedDates.filter(
    (date) =>
      input.completeness.get(
        `${input.context.business.id}::${input.context.providerAccountId}::${date}`,
      ) === true,
  ).length;
  const complete =
    end <= input.outcomeCeiling && present === expectedDates.length;
  const forwardActionReceipts = selectForwardActionReceipts(
    input.actionReceipts,
    input.context.asOfDate,
    input.windowDays,
  );
  const metrics = aggregateFacts(factsBetween(input.rows, start, end));
  const targetRoas = input.targetExact
    ? (input.target?.targetRoas ?? null)
    : null;
  const breakEvenRoas = input.targetExact
    ? (input.target?.breakEvenRoas ?? null)
    : null;
  const baseUnknown =
    !complete || targetRoas === null || breakEvenRoas === null;
  const noForwardDelivery = complete && metrics.spend <= 0;
  const cut: OutcomeStatus = baseUnknown
    ? "unknown"
    : noForwardDelivery
      ? "censored"
      : (metrics.roas ?? 0) < breakEvenRoas
        ? "supported"
        : "refuted";
  const winner: OutcomeStatus = baseUnknown
    ? "unknown"
    : noForwardDelivery
      ? "censored"
      : (metrics.roas ?? 0) >= targetRoas
        ? "supported"
        : (metrics.roas ?? 0) < breakEvenRoas
          ? "refuted"
          : "neutral";
  const refresh: OutcomeStatus = baseUnknown
    ? "unknown"
    : noForwardDelivery
      ? "censored"
      : metrics.roas !== null &&
          input.context.window28.roas !== null &&
          metrics.roas < input.context.window28.roas * 0.85 &&
          metrics.roas < targetRoas
        ? "supported"
        : (metrics.roas ?? 0) >= targetRoas
          ? "refuted"
          : "neutral";
  const fatigue: OutcomeStatus =
    !complete ||
    noForwardDelivery ||
    metrics.roas === null ||
    input.context.prior14.roas === null ||
    input.context.prior14.roas <= 0
      ? !complete
        ? "unknown"
        : noForwardDelivery
          ? "censored"
          : "unknown"
      : metrics.roas < input.context.prior14.roas * 0.85
        ? "supported"
        : metrics.roas >= input.context.prior14.roas * 0.95
          ? "refuted"
          : "neutral";
  const maturity = input.baseProfile.thresholds.commercialMaturitySpend;
  const mature = maturity !== null && input.context.window28.spend >= maturity;
  const funnelOutcomes: ForwardOutcome["funnelOutcomes"] = {};
  for (const sampleFloor of [8, 20, 30] as const) {
    const baselines =
      input.environment.funnelBaselines[
        String(sampleFloor) as "8" | "20" | "30"
      ];
    for (const weakMultiplier of [0.35, 0.5, 0.65, 0.8] as const) {
      const key = `${weakMultiplier}:${sampleFloor}`;
      if (
        !complete ||
        metrics.spend <= 0 ||
        metrics.funnelObservedDays <= 0 ||
        Object.keys(baselines).length === 0
      ) {
        funnelOutcomes[key] = { stage: null, confidence: 0, known: false };
        continue;
      }
      const profile = cloneProfile(input.baseProfile);
      profile.multipliers.weakFunnelRate = weakMultiplier;
      profile.funnelCalibration = {
        campaignKind: "all",
        byFormat: { ...baselines },
      };
      const futureContext: AdContext = {
        ...input.context,
        asOfDate: end,
        currentDay: metrics,
        window7: metrics,
        window14: metrics,
        prior14: input.context.window14,
        window28: metrics,
        window30: metrics,
        window90: metrics,
        allObserved: metrics,
      };
      const creative = buildCreativeInput({
        context: futureContext,
        target: input.target,
        targetExact: input.targetExact,
        targetFresh: input.targetFresh,
        profile,
        environment: input.environment,
        variant: input.baselineVariant,
      });
      const diagnosis = computeFunnelDiagnosis({
        creative,
        funnelCalibration: profile.funnelCalibration,
        profile,
      });
      funnelOutcomes[key] = {
        stage:
          diagnosis.primaryWeakStage === "none" ||
          diagnosis.primaryWeakStage === "insufficient_signal"
            ? null
            : diagnosis.primaryWeakStage,
        confidence: diagnosis.confidence,
        known: true,
      };
    }
  }
  return {
    windowDays: input.windowDays,
    complete,
    spend: metrics.spend,
    purchases: metrics.purchases,
    revenue: metrics.revenue,
    roas: metrics.roas,
    accountDaysExpected: expectedDates.length,
    accountDaysPresent: present,
    forwardActionContaminated: forwardActionReceipts.length > 0,
    forwardActionReceiptIds: forwardActionReceipts.map((receipt) => receipt.id),
    evidenceClass:
      input.context.actionExposureAtCutoff.stratum === "untreated" &&
      forwardActionReceipts.length === 0
        ? "observational_uncontaminated"
        : "observational_action_exposed",
    statusByAction: {
      cut,
      winner,
      portfolioWinner: "unknown",
      refresh,
      fatigue,
    },
    cutOpportunity:
      baseUnknown || noForwardDelivery ? null : mature && cut === "supported",
    winnerOpportunity:
      baseUnknown || noForwardDelivery
        ? null
        : mature && winner === "supported",
    portfolioWinnerOpportunity: null,
    fatigueOpportunity:
      fatigue === "unknown" || fatigue === "censored"
        ? null
        : fatigue === "supported",
    resultSignals: {
      conversions: metrics.purchases,
      leads: metrics.leads,
      messages: metrics.messages,
      landingPageViews: metrics.landingPageViews,
      addToCart: metrics.addToCart,
      initiateCheckout: metrics.initiateCheckout,
    },
    nonPurchaseStatus: {},
    nonPurchaseOpportunity: {},
    funnelOutcomes,
  };
}

function applyPortfolioWinnerOutcomes(rows: readonly CohortRow[]) {
  const groups = new Map<string, CohortRow[]>();
  for (const row of rows) {
    const key = [
      row.context.business.id,
      row.context.providerAccountId,
      isoWeekStart(row.context.asOfDate),
      row.context.optimizationGoal ?? "unknown",
      row.context.currency ?? "unknown",
    ].join("::");
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    const eligible = group.filter(
      (row) =>
        row.outcome.complete &&
        row.outcome.spend > 0 &&
        row.outcome.purchases > 0 &&
        row.outcome.roas !== null,
    );
    if (eligible.length < 8) continue;
    const values = eligible.map((row) => row.outcome.roas ?? 0);
    const p50 = quantile(values, 0.5);
    const p75 = quantile(values, 0.75);
    if (p50 === null || p75 === null) continue;
    for (const row of group) {
      if (!row.outcome.complete) continue;
      if (row.outcome.spend <= 0) {
        row.outcome.statusByAction.portfolioWinner = "censored";
        continue;
      }
      if (row.outcome.roas === null) continue;
      row.outcome.statusByAction.portfolioWinner =
        row.outcome.roas >= p75
          ? "supported"
          : row.outcome.roas < p50
            ? "refuted"
            : "neutral";
      row.outcome.portfolioWinnerOpportunity = row.outcome.roas >= p75;
    }
  }
}

function applyNonPurchaseWinnerOutcomes(rows: readonly CohortRow[]) {
  const groups = new Map<string, CohortRow[]>();
  for (const row of rows) {
    if (row.context.cohort === "purchase") continue;
    const key = [
      row.context.business.id,
      row.context.providerAccountId,
      isoWeekStart(row.context.asOfDate),
      row.context.cohort,
      row.context.optimizationGoal ?? "unknown",
      row.context.currency ?? "unknown",
    ].join("::");
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const group of groups.values()) {
    for (const mode of NON_PURCHASE_WEIGHT_MODES) {
      const withResults = group.flatMap((row) => {
        const results = effectiveNonPurchaseResults(
          {
            purchases: row.outcome.resultSignals.conversions,
            leads: row.outcome.resultSignals.leads,
            messages: row.outcome.resultSignals.messages,
            landingPageViews: row.outcome.resultSignals.landingPageViews,
            addToCart: row.outcome.resultSignals.addToCart,
            initiateCheckout: row.outcome.resultSignals.initiateCheckout,
          },
          row.context.cohort,
          mode,
        );
        return row.outcome.complete && row.outcome.spend > 0 && results !== null
          ? [{ row, results }]
          : [];
      });
      const costs = withResults.flatMap(({ row, results }) =>
        results > 0 ? [row.outcome.spend / results] : [],
      );
      if (costs.length < 8) continue;
      const p25 = quantile(costs, 0.25);
      const p50 = quantile(costs, 0.5);
      if (p25 === null || p50 === null) continue;
      for (const row of group) {
        if (!row.outcome.complete) continue;
        if (row.outcome.spend <= 0) {
          row.outcome.nonPurchaseStatus[mode] = "censored";
          row.outcome.nonPurchaseOpportunity[mode] = null;
          continue;
        }
        const results = effectiveNonPurchaseResults(
          {
            purchases: row.outcome.resultSignals.conversions,
            leads: row.outcome.resultSignals.leads,
            messages: row.outcome.resultSignals.messages,
            landingPageViews: row.outcome.resultSignals.landingPageViews,
            addToCart: row.outcome.resultSignals.addToCart,
            initiateCheckout: row.outcome.resultSignals.initiateCheckout,
          },
          row.context.cohort,
          mode,
        );
        if (results === null) continue;
        const status: OutcomeStatus =
          results <= 0
            ? "refuted"
            : row.outcome.spend / results <= p25
              ? "supported"
              : row.outcome.spend / results > p50
                ? "refuted"
                : "neutral";
        row.outcome.nonPurchaseStatus[mode] = status;
        row.outcome.nonPurchaseOpportunity[mode] = status === "supported";
      }
    }
  }
}

function createManifestHash(input: {
  context: AdContext;
  target: TargetPack | null;
  targetExact: boolean;
  targetFresh: boolean;
  outcomes: Record<OutcomeWindowDays, ForwardOutcome>;
  profileConfig: ProfileConfig | null;
}) {
  const cutoff = `${input.context.asOfDate}T03:00:00.000Z`;
  const restatedIdentity = (
    value: string | null,
    required: boolean,
    source: string,
  ) => ({
    value,
    required,
    source,
    evidenceClass: "restated_fact" as const,
    sourceId: input.context.sourceIds[0] ?? null,
    observedAt: cutoff,
  });
  const completeWindows = OUTCOME_WINDOWS.filter(
    (windowDays) => input.outcomes[windowDays].complete,
  );
  const allOutcomesComplete = completeWindows.length === OUTCOME_WINDOWS.length;
  return buildSimulationInputManifest({
    sourceMode: "restated_ad_daily",
    cutoff,
    identity: {
      account: restatedIdentity(
        input.context.providerAccountId,
        true,
        "meta_ad_daily.provider_account_id",
      ),
      campaign: restatedIdentity(
        input.context.campaignId,
        true,
        "meta_ad_daily.campaign_id",
      ),
      adset: restatedIdentity(
        input.context.adsetId,
        true,
        "meta_ad_daily.adset_id",
      ),
      ad: restatedIdentity(input.context.adId, true, "meta_ad_daily.ad_id"),
      creative: {
        ...restatedIdentity(
          input.context.creativeId,
          false,
          "meta_ad_dimensions.current",
        ),
        evidenceClass: "current_dimension",
      },
      goal: restatedIdentity(
        input.context.optimizationGoal,
        true,
        "meta_adset_daily.optimization_goal",
      ),
      country: restatedIdentity(null, false, "not_requested"),
      currency: restatedIdentity(
        input.context.currency,
        true,
        "meta_ad_daily.account_currency",
      ),
    },
    targetProvenance:
      input.target?.effectiveAt && input.target.recordedAt
        ? {
            required: input.targetExact,
            source: input.target.source,
            evidenceClass: input.targetExact
              ? "bitemporal_observation"
              : "current_dimension",
            sourceId: `${input.context.business.id}:${input.target.effectiveAt}:${input.target.recordedAt}`,
            effectiveAt: input.target.effectiveAt,
            recordedAt: input.target.recordedAt,
          }
        : null,
    configProvenance: input.profileConfig?.updatedAt
      ? [
          {
            required: input.profileConfig.updatedAt <= cutoff,
            source: "business_decision_calibration_profiles",
            evidenceClass:
              input.profileConfig.updatedAt <= cutoff
                ? ("bitemporal_observation" as const)
                : ("current_dimension" as const),
            sourceId: `${input.context.business.id}:${input.profileConfig.updatedAt}`,
            observedAt: input.profileConfig.updatedAt,
            effectiveFrom: input.profileConfig.updatedAt,
          },
        ]
      : [],
    generation: null,
    sourceIds: input.context.sourceIds,
    missingFields: [
      ...(input.context.retained.effectiveStatus
        ? []
        : ["cutoff_safe_effective_status"]),
      ...(input.context.retained.creativeFormat
        ? []
        : ["cutoff_safe_creative_format"]),
      ...(input.context.retained.lifecyclePosition
        ? []
        : ["cutoff_safe_lifecycle_position"]),
      ...(input.context.retained.bidRegime !== "unknown"
        ? []
        : ["cutoff_safe_bid_regime"]),
      ...(input.context.sourceUpdatedAfterCutoff
        ? ["source_observed_after_cutoff"]
        : []),
      ...(input.targetExact ? [] : ["target_at_cutoff"]),
      ...(input.targetFresh ? [] : ["fresh_target_at_cutoff"]),
    ],
    conflictFields: [],
    outcomeCompleteness: {
      status: allOutcomesComplete ? "complete" : "partial",
      checkedAt: `${addDays(input.context.asOfDate, PRIMARY_OUTCOME_WINDOW_DAYS)}T23:59:59.999Z`,
      windowDays: [...OUTCOME_WINDOWS],
      completeThrough:
        completeWindows.length > 0
          ? addDays(input.context.asOfDate, Math.max(...completeWindows))
          : null,
      sourceIds: input.context.sourceIds,
      missingFields: OUTCOME_WINDOWS.flatMap((windowDays) => {
        const outcome = input.outcomes[windowDays];
        return outcome.complete
          ? []
          : [
              `${windowDays}d_account_days:${outcome.accountDaysPresent}/${outcome.accountDaysExpected}`,
            ];
      }),
    },
  }).sha256;
}

function createDecisionInputHash(input: {
  context: AdContext;
  target: TargetPack | null;
  targetExact: boolean;
  targetFresh: boolean;
  profileConfig: ProfileConfig | null;
}) {
  return hash({
    contractVersion: "adsecute.meta.decision-input.v1",
    engineVersion: ENGINE_VERSION,
    cutoff: `${input.context.asOfDate}T03:00:00.000Z`,
    sourceMode: "restated_ad_daily",
    identity: {
      businessId: input.context.business.id,
      providerAccountId: input.context.providerAccountId,
      campaignId: input.context.campaignId,
      adsetId: input.context.adsetId,
      adId: input.context.adId,
      optimizationGoal: input.context.optimizationGoal,
      customEventType: input.context.customEventType,
      objective: input.context.objective,
      currency: input.context.currency,
    },
    metrics: {
      currentDay: input.context.currentDay,
      window7: input.context.window7,
      window14: input.context.window14,
      prior14: input.context.prior14,
      window28: input.context.window28,
      window30: input.context.window30,
      window90: input.context.window90,
      allObserved: input.context.allObserved,
    },
    retainedContext: input.context.retained,
    actionExposureAtCutoff: input.context.actionExposureAtCutoff,
    sourceIds: input.context.sourceIds,
    target: input.targetExact ? input.target : null,
    targetExact: input.targetExact,
    targetFresh: input.targetFresh,
    profileConfig: effectiveProfileConfig(
      input.profileConfig,
      input.context.asOfDate,
    ),
  });
}

function emptyActionScore(): ActionScore {
  return {
    emitted: 0,
    known: 0,
    supported: 0,
    refuted: 0,
    neutral: 0,
    unknown: 0,
    censored: 0,
    opportunityKnown: 0,
    opportunityPositive: 0,
    opportunityCaptured: 0,
    precision: null,
    opportunityRecall: null,
    unknownRate: null,
    censoredRate: null,
  };
}

function finalizeActionScore(score: ActionScore) {
  score.known = score.supported + score.refuted;
  score.precision = score.known > 0 ? score.supported / score.known : null;
  score.opportunityRecall =
    score.opportunityPositive > 0
      ? score.opportunityCaptured / score.opportunityPositive
      : null;
  score.unknownRate = score.emitted > 0 ? score.unknown / score.emitted : null;
  score.censoredRate =
    score.emitted > 0 ? score.censored / score.emitted : null;
  return score;
}

function accrueAction(input: {
  score: ActionScore;
  emitted: boolean;
  status: OutcomeStatus;
  opportunity: boolean | null;
}) {
  if (input.opportunity !== null) {
    input.score.opportunityKnown += 1;
    if (input.opportunity) {
      input.score.opportunityPositive += 1;
      if (input.emitted) input.score.opportunityCaptured += 1;
    }
  }
  if (!input.emitted) return;
  input.score.emitted += 1;
  input.score[input.status] += 1;
}

function summarizeVariants(
  rows: readonly CohortRow[],
  variants: readonly VariantSpec[],
): VariantSummary[] {
  const baseline = variants[0]?.id ?? "V0_current";
  return variants.map((variant) => {
    const cut = emptyActionScore();
    const cutTargetExact = emptyActionScore();
    const winner = emptyActionScore();
    const winnerTargetExact = emptyActionScore();
    const portfolioWinner = emptyActionScore();
    const refresh = emptyActionScore();
    const fatigue = emptyActionScore();
    const diagnose = emptyActionScore();
    const labels: Record<string, number> = {};
    let changedVsBaseline = 0;
    let applicableRows = 0;
    let hardRows = 0;
    let safetyViolations = 0;
    let incrementalSafetyViolations = 0;
    for (const row of rows) {
      const decision = row.decisions.find(
        (item) => item.variantId === variant.id,
      );
      const base = row.decisions.find((item) => item.variantId === baseline);
      if (!decision || !base) continue;
      if (decision.applicable) applicableRows += 1;
      labels[decision.label] = (labels[decision.label] ?? 0) + 1;
      const changed =
        decision.label !== base.label ||
        decision.axes.portfolioRole !== base.axes.portfolioRole ||
        decision.axes.executionAction !== base.axes.executionAction;
      if (changed) changedVsBaseline += 1;
      if (!decision.applicable && variant.family !== "V0") continue;
      const emitsCut = decision.axes.executionAction === "cut_ad";
      const emitsWinner = decision.axes.portfolioRole === "current_winner";
      const emitsRefresh = decision.axes.executionAction === "refresh_creative";
      const emitsFatigue = decision.fatigueStatus === "fatigued";
      const emitsDiagnose = decision.label === "diagnose";
      if (emitsCut || emitsWinner || emitsRefresh) hardRows += 1;
      accrueAction({
        score: cut,
        emitted: emitsCut,
        status: row.outcome.statusByAction.cut,
        opportunity: row.outcome.cutOpportunity,
      });
      if (row.targetExact) {
        accrueAction({
          score: cutTargetExact,
          emitted: emitsCut,
          status: row.outcome.statusByAction.cut,
          opportunity: row.outcome.cutOpportunity,
        });
      }
      accrueAction({
        score: winner,
        emitted: emitsWinner,
        status: row.outcome.statusByAction.winner,
        opportunity: row.outcome.winnerOpportunity,
      });
      if (row.targetExact) {
        accrueAction({
          score: winnerTargetExact,
          emitted: emitsWinner,
          status: row.outcome.statusByAction.winner,
          opportunity: row.outcome.winnerOpportunity,
        });
      }
      accrueAction({
        score: portfolioWinner,
        emitted: emitsWinner,
        status:
          variant.family === "H8" && variant.nonPurchaseWeightMode !== null
            ? (row.outcome.nonPurchaseStatus[variant.nonPurchaseWeightMode] ??
              "unknown")
            : row.outcome.statusByAction.portfolioWinner,
        opportunity:
          variant.family === "H8" && variant.nonPurchaseWeightMode !== null
            ? (row.outcome.nonPurchaseOpportunity[
                variant.nonPurchaseWeightMode
              ] ?? null)
            : row.outcome.portfolioWinnerOpportunity,
      });
      accrueAction({
        score: refresh,
        emitted: emitsRefresh,
        status: row.outcome.statusByAction.refresh,
        opportunity: null,
      });
      accrueAction({
        score: fatigue,
        emitted: emitsFatigue,
        status: row.outcome.statusByAction.fatigue,
        opportunity: row.outcome.fatigueOpportunity,
      });
      const fixedFunnelOutcome = row.outcome.funnelOutcomes["0.5:20"];
      accrueAction({
        score: diagnose,
        emitted: emitsDiagnose,
        status: !fixedFunnelOutcome?.known
          ? "unknown"
          : decision.funnelStage !== null &&
              decision.funnelStage === fixedFunnelOutcome.stage
            ? "supported"
            : "refuted",
        opportunity: fixedFunnelOutcome?.known
          ? fixedFunnelOutcome.stage !== null
          : null,
      });
      const preRoas = row.context.window28.roas;
      const breakeven = row.targetExact
        ? (row.target?.breakEvenRoas ?? null)
        : null;
      if (
        emitsCut &&
        breakeven !== null &&
        preRoas !== null &&
        preRoas >= breakeven
      ) {
        safetyViolations += 1;
        if (changed) incrementalSafetyViolations += 1;
      }
      if (
        (emitsCut || emitsWinner) &&
        decision.axes.authorityState === "actionable" &&
        !row.targetExact
      ) {
        safetyViolations += 1;
        if (changed) incrementalSafetyViolations += 1;
      }
    }
    return {
      variantId: variant.id,
      rows: rows.length,
      applicableRows,
      labels,
      changedVsBaseline,
      changedRateVsBaseline:
        rows.length > 0 ? changedVsBaseline / rows.length : null,
      hardRows,
      cut: finalizeActionScore(cut),
      cutTargetExact: finalizeActionScore(cutTargetExact),
      winner: finalizeActionScore(winner),
      winnerTargetExact: finalizeActionScore(winnerTargetExact),
      portfolioWinner: finalizeActionScore(portfolioWinner),
      refresh: finalizeActionScore(refresh),
      fatigue: finalizeActionScore(fatigue),
      diagnose: finalizeActionScore(diagnose),
      safetyViolations,
      incrementalSafetyViolations,
    };
  });
}

function scoreForFamily(
  summary: VariantSummary,
  family: VariantSpec["family"],
) {
  if (family === "H1" || family === "H2" || family === "H3") {
    return summary.cutTargetExact;
  }
  if (family === "H4" || family === "H8") {
    return summary.portfolioWinner;
  }
  if (family === "H5") return summary.fatigue;
  if (family === "H6") return summary.diagnose;
  return summary.cutTargetExact;
}

function harmonicMean(left: number | null, right: number | null) {
  return left !== null && right !== null && left + right > 0
    ? (2 * left * right) / (left + right)
    : null;
}

function selectionSafety(
  summary: VariantSummary,
  family: VariantSpec["family"],
) {
  return family === "H1" ||
    family === "H2" ||
    family === "H3" ||
    family === "HC"
    ? summary.safetyViolations
    : summary.incrementalSafetyViolations;
}

function summarizeFoldRows(input: {
  rows: readonly CohortRow[];
  variants: readonly VariantSpec[];
  outcomeCeiling: string;
  outcomeWindowDays: OutcomeWindowDays;
}) {
  const byFold = new Map<string, CohortRow[]>();
  for (const row of input.rows) {
    const assignment = assignRollingOriginFold({
      decisionDate: row.context.asOfDate,
      outcomeWindowDays: input.outcomeWindowDays,
      outcomesObservedThrough: input.outcomeCeiling,
    });
    if (!assignment.eligible || assignment.foldId === null) continue;
    const list = byFold.get(assignment.foldId) ?? [];
    list.push(row);
    byFold.set(assignment.foldId, list);
  }
  return Object.fromEntries(
    ["development", "calibration", "locked_test"].map((foldId) => [
      foldId,
      {
        rows: byFold.get(foldId)?.length ?? 0,
        variantSummaries: summarizeVariants(
          byFold.get(foldId) ?? [],
          input.variants,
        ),
      },
    ]),
  ) as Record<
    "development" | "calibration" | "locked_test",
    { rows: number; variantSummaries: VariantSummary[] }
  >;
}

function familyEmission(
  decision: VariantDecision,
  family: VariantSpec["family"],
) {
  if (
    family === "H1" ||
    family === "H2" ||
    family === "H3" ||
    family === "HC"
  ) {
    return decision.axes.executionAction === "cut_ad";
  }
  if (family === "H4" || family === "H8") {
    return decision.axes.portfolioRole === "current_winner";
  }
  if (family === "H5") return decision.fatigueStatus === "fatigued";
  if (family === "H6") return decision.label === "diagnose";
  return false;
}

function familyOpportunity(input: {
  row: CohortRow;
  family: VariantSpec["family"];
  variant: VariantSpec;
}) {
  if (
    input.family === "H1" ||
    input.family === "H2" ||
    input.family === "H3" ||
    input.family === "HC"
  ) {
    return input.row.outcome.cutOpportunity;
  }
  if (input.family === "H4") {
    return input.row.outcome.portfolioWinnerOpportunity;
  }
  if (input.family === "H8" && input.variant.nonPurchaseWeightMode !== null) {
    return (
      input.row.outcome.nonPurchaseOpportunity[
        input.variant.nonPurchaseWeightMode
      ] ?? null
    );
  }
  if (input.family === "H5") return input.row.outcome.fatigueOpportunity;
  if (input.family === "H6") {
    const outcome = input.row.outcome.funnelOutcomes["0.5:20"];
    return outcome?.known ? outcome.stage !== null : null;
  }
  return null;
}

function pairedOpportunityCaptureForFamily(input: {
  rows: readonly CohortRow[];
  family: VariantSpec["family"];
  variant: VariantSpec;
}) {
  let bothCorrect = 0;
  let baselineOnlyCorrect = 0;
  let candidateOnlyCorrect = 0;
  let bothWrong = 0;
  const bootstrapRows: Array<{
    businessId: string;
    entityId: string;
    date: string;
    delta: number;
  }> = [];
  const baselineActionScore = emptyActionScore();
  const candidateActionScore = emptyActionScore();
  const discordantActionOutcomes = {
    baselineOnly: {
      supported: 0,
      refuted: 0,
      neutral: 0,
      unknown: 0,
      censored: 0,
    },
    candidateOnly: {
      supported: 0,
      refuted: 0,
      neutral: 0,
      unknown: 0,
      censored: 0,
    },
  };
  const permutationRows: Array<{
    id: string;
    stratumId: string;
    baselineEmitted: boolean;
    candidateEmitted: boolean;
    outcomeSupported: boolean;
  }> = [];
  for (const row of input.rows) {
    const opportunity = familyOpportunity({
      row,
      family: input.family,
      variant: input.variant,
    });
    const baseline = row.decisions[0];
    const candidate = row.decisions.find(
      (decision) => decision.variantId === input.variant.id,
    );
    if (!baseline || !candidate || !candidate.applicable) continue;
    const baselineCaptured = familyEmission(baseline, input.family);
    const candidateCaptured = familyEmission(candidate, input.family);
    const outcomeStatus = (decision: VariantDecision): OutcomeStatus => {
      if (
        input.family === "H1" ||
        input.family === "H2" ||
        input.family === "H3" ||
        input.family === "HC"
      ) {
        return row.outcome.statusByAction.cut;
      }
      if (input.family === "H4") {
        return row.outcome.statusByAction.portfolioWinner;
      }
      if (
        input.family === "H8" &&
        input.variant.nonPurchaseWeightMode !== null
      ) {
        return (
          row.outcome.nonPurchaseStatus[input.variant.nonPurchaseWeightMode] ??
          "unknown"
        );
      }
      if (input.family === "H5") return row.outcome.statusByAction.fatigue;
      if (input.family === "H6") {
        const funnelOutcome = row.outcome.funnelOutcomes["0.5:20"];
        if (!funnelOutcome?.known) return "unknown";
        return decision.funnelStage !== null &&
          decision.funnelStage === funnelOutcome.stage
          ? "supported"
          : "refuted";
      }
      return "unknown";
    };
    const candidateOutcomeStatus = outcomeStatus(candidate);
    accrueAction({
      score: baselineActionScore,
      emitted: baselineCaptured,
      status: outcomeStatus(baseline),
      opportunity,
    });
    accrueAction({
      score: candidateActionScore,
      emitted: candidateCaptured,
      status: candidateOutcomeStatus,
      opportunity,
    });
    if (
      input.family === "H3" &&
      (candidateOutcomeStatus === "supported" ||
        candidateOutcomeStatus === "refuted")
    ) {
      permutationRows.push({
        id: row.key,
        stratumId: `${row.context.business.id}:${row.context.providerAccountId}:${isoWeekStart(row.context.asOfDate)}`,
        baselineEmitted: baselineCaptured,
        candidateEmitted: candidateCaptured,
        outcomeSupported: candidateOutcomeStatus === "supported",
      });
    }
    if (baselineCaptured !== candidateCaptured) {
      const side = baselineCaptured ? "baselineOnly" : "candidateOnly";
      discordantActionOutcomes[side][candidateOutcomeStatus] += 1;
    }
    if (opportunity !== true) continue;
    bootstrapRows.push({
      businessId: row.context.business.id,
      entityId: `${row.context.providerAccountId}:${row.context.adId}`,
      date: row.context.asOfDate,
      delta: Number(candidateCaptured) - Number(baselineCaptured),
    });
    if (baselineCaptured && candidateCaptured) bothCorrect += 1;
    else if (baselineCaptured) baselineOnlyCorrect += 1;
    else if (candidateCaptured) candidateOnlyCorrect += 1;
    else bothWrong += 1;
  }
  const mcnemar = pairedMcNemarFromCounts({
    bothCorrect,
    baselineOnlyCorrect,
    candidateOnlyCorrect,
    bothWrong,
  });
  const rawBootstrapRecallDelta =
    bootstrapRows.length === 0
      ? null
      : clusteredMovingBlockBootstrap(bootstrapRows, {
          getBusinessId: (row) => row.businessId,
          getEntityId: (row) => row.entityId,
          getDate: (row) => row.date,
          statistic: (sample) =>
            sample.length === 0
              ? null
              : sample.reduce((sum, row) => sum + row.observation.delta, 0) /
                sample.length,
          seed: `${input.family}:${input.variant.id}:locked-test`,
          iterations: 10_000,
          blockLengthDays: 7,
          confidenceLevel: 0.95,
        });
  const bootstrapRecallDelta = rawBootstrapRecallDelta
    ? (({ estimates: _estimates, ...summary }) => summary)(
        rawBootstrapRecallDelta,
      )
    : null;
  const leaveOneBusinessOutRecallDelta =
    bootstrapRows.length === 0
      ? null
      : summarizeLeaveOneBusinessOutMetric(bootstrapRows, {
          getBusinessId: (row) => row.businessId,
          getValue: (row) => row.delta,
        });
  return {
    ...mcnemar,
    baselineActionScore: finalizeActionScore(baselineActionScore),
    candidateActionScore: finalizeActionScore(candidateActionScore),
    discordantActionOutcomes,
    bootstrapRecallDelta,
    leaveOneBusinessOutRecallDelta,
    accountWeekOutcomePermutation:
      input.family === "H3"
        ? pairedActionStratifiedPermutationTest(permutationRows, {
            seed: `${input.family}:${input.variant.id}:account-week-outcome-placebo`,
            iterations: 10_000,
          })
        : null,
  };
}

function sourceFilesRecursively(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(root, entry.name);
      return entry.isDirectory()
        ? sourceFilesRecursively(absolute)
        : [absolute];
    })
    .sort();
}

function hashFiles(root: string, files: readonly string[]) {
  return files
    .reduce((digest, absolute) => {
      digest.update(relative(root, absolute));
      digest.update(readFileSync(absolute));
      return digest;
    }, createHash("sha256"))
    .digest("hex");
}

function selectFamilyCandidates(input: {
  variants: readonly VariantSpec[];
  folds: ReturnType<typeof summarizeFoldRows>;
  rows: readonly CohortRow[];
}) {
  const calibrationById = new Map(
    input.folds.calibration.variantSummaries.map((summary) => [
      summary.variantId,
      summary,
    ]),
  );
  const testById = new Map(
    input.folds.locked_test.variantSummaries.map((summary) => [
      summary.variantId,
      summary,
    ]),
  );
  return (["H1", "H2", "H3", "H4", "H5", "H6", "H8", "HC"] as const).map(
    (family) => {
      const ranked = input.variants
        .filter((variant) => variant.family === family)
        .flatMap((variant) => {
          const summary = calibrationById.get(variant.id);
          if (!summary || summary.applicableRows === 0) return [];
          const score = scoreForFamily(summary, family);
          const selectionScore = harmonicMean(
            score.precision,
            score.opportunityRecall,
          );
          return [{ variant, summary, score, selectionScore }];
        })
        .sort(
          (left, right) =>
            selectionSafety(left.summary, family) -
              selectionSafety(right.summary, family) ||
            (right.selectionScore ?? -1) - (left.selectionScore ?? -1) ||
            right.score.known - left.score.known ||
            left.variant.id.localeCompare(right.variant.id),
        );
      const selected = ranked[0] ?? null;
      const testSummary = selected
        ? (testById.get(selected.variant.id) ?? null)
        : null;
      const testScore = testSummary
        ? scoreForFamily(testSummary, family)
        : null;
      const precisionInterval = testScore
        ? wilsonScoreInterval(testScore.supported, testScore.known)
        : null;
      const recallInterval =
        testScore && testScore.opportunityPositive > 0
          ? wilsonScoreInterval(
              testScore.opportunityCaptured,
              testScore.opportunityPositive,
            )
          : null;
      const pairedOpportunityCapture = selected
        ? pairedOpportunityCaptureForFamily({
            rows: input.rows.filter(
              (row) =>
                row.context.asOfDate >= "2026-06-01" &&
                row.context.asOfDate <= "2026-06-27" &&
                row.outcome.complete,
            ),
            family,
            variant: selected.variant,
          })
        : null;
      const gateStatus =
        selected === null || testSummary === null || testScore === null
          ? "not_evaluable"
          : selectionSafety(testSummary, family) > 0
            ? "reject_safety"
            : testScore.known < 100
              ? "insufficient_evidence"
              : (testScore.precision ?? 0) < 0.92 ||
                  (precisionInterval?.lower ?? 0) < 0.85
                ? "reject_precision"
                : (testScore.opportunityRecall ?? 0) < 0.92
                  ? "reject_recall"
                  : "accept";
      return {
        family,
        candidateCount: input.variants.filter(
          (variant) => variant.family === family,
        ).length,
        selectedOnCalibration: selected?.variant ?? null,
        calibration: selected
          ? {
              applicableRows: selected.summary.applicableRows,
              actionScore: selected.score,
              selectionScore: selected.selectionScore,
              safetyViolations: selectionSafety(selected.summary, family),
            }
          : null,
        lockedTest: testSummary
          ? {
              applicableRows: testSummary.applicableRows,
              actionScore: testScore,
              precisionInterval,
              recallInterval,
              pairedOpportunityCapture,
              safetyViolations: selectionSafety(testSummary, family),
            }
          : null,
        gateStatus,
      };
    },
  );
}

function h10Observations(
  rows: readonly CohortRow[],
  outcomeWindowDays: OutcomeWindowDays,
) {
  const observations: DatedProbabilityCalibrationObservation[] = [];
  for (const row of rows) {
    const decision = row.formulaCalibrationDecision;
    let action: "cut_ad" | "refresh_creative" | "promote_to_main" | null = null;
    let status: OutcomeStatus = "unknown";
    if (decision.axes.executionAction === "cut_ad") {
      action = "cut_ad";
      status = row.outcome.statusByAction.cut;
    } else if (decision.axes.executionAction === "refresh_creative") {
      action = "refresh_creative";
      status = row.outcome.statusByAction.refresh;
    } else if (decision.axes.portfolioRole === "current_winner") {
      action = "promote_to_main";
      status = row.outcome.statusByAction.winner;
    }
    if (action === null) continue;
    const outcome =
      status === "supported" ? 1 : status === "refuted" ? 0 : null;
    observations.push({
      id: `${row.key}:${action}`,
      action,
      accountId: row.context.providerAccountId,
      decisionDate: row.context.asOfDate,
      probability: Math.max(0, Math.min(1, decision.confidence / 100)),
      outcome,
      outcomeObservedDate:
        outcome === null
          ? null
          : addDays(row.context.asOfDate, outcomeWindowDays),
    });
  }
  return observations;
}

function runH10ProbabilityCalibration(
  rows: readonly CohortRow[],
  outcomeWindowDays: OutcomeWindowDays,
) {
  const observations = h10Observations(rows, outcomeWindowDays);
  const calibrationObservations = observations.filter(
    (row) =>
      row.decisionDate >= "2026-04-01" && row.decisionDate <= "2026-05-17",
  );
  const lockedTestObservations = observations.filter(
    (row) =>
      row.decisionDate >= "2026-06-01" && row.decisionDate <= "2026-06-27",
  );
  const configs = buildH10ProbabilityCalibrationConfigs({
    support: {
      global: { minimumKnown: 20, minimumPositive: 5, minimumNegative: 5 },
      action: { minimumKnown: 10, minimumPositive: 5, minimumNegative: 5 },
      actionAccount: {
        minimumKnown: 10,
        minimumPositive: 5,
        minimumNegative: 5,
      },
      actionPriorStrength: 20,
      actionAccountPriorStrength: 10,
    },
    histogram: { requestedBinCount: 5, minimumBinSize: 10, minimumBins: 2 },
    platt: {
      probabilityEpsilon: 0.001,
      l2Regularization: 0.01,
      maximumIterations: 200,
      convergenceTolerance: 1e-8,
      minimumLineSearchStep: 1e-6,
      enforceNonDecreasing: true,
    },
    evaluation: {
      requestedBinCount: 5,
      minimumBinSize: 50,
      minimumBins: 5,
    },
  });
  const protocol = {
    calibrationStartDate: "2026-04-01",
    calibrationEndDate: "2026-05-17",
    calibrationOutcomeCutoffDate: "2026-05-31",
    lockedTestStartDate: "2026-06-01",
    lockedTestEndDate: "2026-06-27",
    lockedTestOutcomeCutoffDate: addDays("2026-06-27", outcomeWindowDays),
  } as const;
  return configs.map((config) => {
    const run = fitAndEvaluateProbabilityCalibration({
      config,
      protocol,
      calibrationObservations,
      lockedTestObservations,
    });
    const evaluatedActions = run.evaluation.calibrated;
    const evidenceSufficient =
      evaluatedActions.length > 0 &&
      evaluatedActions.every((summary) => summary.evidenceSufficient);
    const passesEce =
      evidenceSufficient &&
      evaluatedActions.every(
        (summary) =>
          summary.expectedCalibrationError !== null &&
          summary.expectedCalibrationError <= 0.05,
      );
    const rawByAction = new Map(
      run.evaluation.raw.map((summary) => [summary.action, summary]),
    );
    const passesBrier =
      evidenceSufficient &&
      evaluatedActions.every((summary) => {
        const raw = rawByAction.get(summary.action);
        return (
          raw?.brierScore !== null &&
          raw?.brierScore !== undefined &&
          summary.brierScore !== null &&
          summary.brierScore <= raw.brierScore * 0.9
        );
      });
    return {
      variantId: run.provenance.variantId,
      config: run.config,
      provenance: run.provenance,
      counts: run.counts,
      evaluation: run.evaluation,
      gateStatus: !evidenceSufficient
        ? "insufficient_evidence"
        : passesEce && passesBrier
          ? "accept"
          : "reject_calibration",
    };
  });
}

function runH10BayesianSensitivity(
  rows: readonly CohortRow[],
  outcomeWindowDays: OutcomeWindowDays,
) {
  const observations = h10Observations(rows, outcomeWindowDays);
  const calibrationObservations = observations.filter(
    (row) =>
      row.decisionDate >= "2026-04-01" && row.decisionDate <= "2026-05-17",
  );
  const lockedTestObservations = observations.filter(
    (row) =>
      row.decisionDate >= "2026-06-01" && row.decisionDate <= "2026-06-27",
  );
  const protocol = {
    calibrationStartDate: "2026-04-01",
    calibrationEndDate: "2026-05-17",
    calibrationOutcomeCutoffDate: "2026-05-31",
    lockedTestStartDate: "2026-06-01",
    lockedTestEndDate: "2026-06-27",
    lockedTestOutcomeCutoffDate: addDays("2026-06-27", outcomeWindowDays),
  } as const;
  return [2, 5, 10].flatMap((priorStrength) =>
    ([0.2, 0.5, 1] as const).map((probabilityBandwidth) =>
      fitBayesianWalkForwardSensitivity({
        config: {
          priorStrength,
          probabilityBandwidth,
          foldCount: 3,
          minimumEffectiveWeight: 0.1,
          evaluation: {
            requestedBinCount: 3,
            minimumBinSize: 2,
            minimumBins: 2,
          },
        },
        protocol,
        calibrationObservations,
        lockedTestObservations,
      }),
    ),
  );
}

function rowsForOutcomeWindow(
  rows: readonly CohortRow[],
  windowDays: OutcomeWindowDays,
): CohortRow[] {
  return rows.map((row) => ({
    ...row,
    outcome: row.outcomes[windowDays],
  }));
}

function uncontaminatedObservationalRows(rows: readonly CohortRow[]) {
  return rows.filter(
    (row) =>
      row.context.actionExposureAtCutoff.stratum === "untreated" &&
      !row.outcome.forwardActionContaminated,
  );
}

function summarizeActionStrata(
  rows: readonly CohortRow[],
  baselineVariant: VariantSpec,
) {
  return Object.fromEntries(
    (["untreated", "acted_success", "failed", "dry_run"] as const).map(
      (stratum) => {
        const stratumRows = rows.filter(
          (row) => row.context.actionExposureAtCutoff.stratum === stratum,
        );
        const baseline = summarizeVariants(stratumRows, [baselineVariant])[0];
        return [
          stratum,
          {
            rows: stratumRows.length,
            completeRows: stratumRows.filter((row) => row.outcome.complete)
              .length,
            forwardActionContaminatedRows: stratumRows.filter(
              (row) => row.outcome.forwardActionContaminated,
            ).length,
            baseline: baseline ?? null,
            evidenceClass: "observational_only" as const,
            causalEffectClaimed: false as const,
            savedSpendClaimed: false as const,
          },
        ];
      },
    ),
  ) as Record<
    ActionExposureStratum,
    {
      rows: number;
      completeRows: number;
      forwardActionContaminatedRows: number;
      baseline: VariantSummary | null;
      evidenceClass: "observational_only";
      causalEffectClaimed: false;
      savedSpendClaimed: false;
    }
  >;
}

function percent(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(report: Awaited<ReturnType<typeof runReplay>>) {
  const lines: string[] = [];
  lines.push("# Native Ad-Grain Paired Historical Replay");
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Git SHA: \`${report.lineage.gitSha}\``);
  lines.push("");
  lines.push("## Evidence Boundary");
  lines.push("");
  lines.push(
    "This replay is read-only and uses finalized `meta_ad_daily` facts at native ad grain. These rows are restated warehouse facts, not exact decision-time PIT observations. Every hard action remains review-only in this artifact. Zero forward spend is censored, not counted as saved spend.",
  );
  lines.push("");
  lines.push("## Baseline Epoch");
  lines.push("");
  lines.push(`- Engine version: \`${report.lineage.engineVersion}\`.`);
  lines.push(
    "- This is the formula engine epoch replayed at ad grain, not the separate native producer/schema epoch.",
  );
  lines.push(
    "- `V0_current` includes D049's fresh breakeven cut ceiling. It may narrow account P25 but never widen the cut zone.",
  );
  lines.push(
    "- The immutable pre-D049 comparison is stored in `NATIVE_AD_GRAIN_PAIRED_REPLAY_2025-12-01_TO_2026-06-27_PRE_D049.md` and its matching generated JSON.",
  );
  lines.push("");
  lines.push("## Bounded Eliminations");
  lines.push("");
  for (const item of report.methodology.boundedEliminations) {
    lines.push(`- **${item.family} / ${item.axis}:** ${item.reason}`);
  }
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push(`- Businesses: ${report.coverage.businesses}`);
  lines.push(`- Source rows: ${report.coverage.sourceRows}`);
  lines.push(`- Fixed matched cohort rows: ${report.coverage.cohortRows}`);
  lines.push(
    `- Target-exact rows: ${report.coverage.targetExactRows} (${percent(report.coverage.targetExactRate)})`,
  );
  lines.push(
    `- Complete 14d outcomes: ${report.coverage.completeOutcomeRows} (${percent(report.coverage.completeOutcomeRate)})`,
  );
  for (const windowDays of OUTCOME_WINDOWS) {
    const coverage = report.coverage.outcomeCompletenessByWindow[windowDays];
    lines.push(
      `- Complete ${windowDays}d outcomes: ${coverage.completeRows} (${percent(coverage.completeRate)}); ingestion days ${coverage.accountDaysPresent}/${coverage.accountDaysExpected}.`,
    );
  }
  lines.push(
    `- Cutoff-safe context rows: status ${report.coverage.cutoffSafeContext.effectiveStatusRows}, format ${report.coverage.cutoffSafeContext.creativeFormatRows}, lifecycle ${report.coverage.cutoffSafeContext.lifecycleRows}, rankings ${report.coverage.cutoffSafeContext.rankingRows}, bid regime ${report.coverage.cutoffSafeContext.bidRegimeRows}.`,
  );
  lines.push(
    `- Pre-cutoff action strata: untreated ${report.coverage.actionExposureAtCutoff.untreated}, success ${report.coverage.actionExposureAtCutoff.acted_success}, failed ${report.coverage.actionExposureAtCutoff.failed}, dry-run ${report.coverage.actionExposureAtCutoff.dry_run}.`,
  );
  lines.push(
    `- Current-dimension creative IDs: ${report.coverage.creativeIdRows} (${percent(report.coverage.creativeIdRate)}); grouping only, never execution authority.`,
  );
  lines.push("");
  lines.push("## Paired Variant Results");
  lines.push("");
  lines.push(
    "| Variant | Applicable | Labels | Changed | Cut P (target-exact) | Cut R (target-exact) | Target winner P (target-exact) | Target winner R (target-exact) | Portfolio winner P | Portfolio winner R | Refresh P | Diagnose P | Unknown cut (all) | Censored cut (all) | Safety | ",
  );
  lines.push(
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  const selectedIds = new Set(
    report.familySelections.flatMap((selection) =>
      selection.selectedOnCalibration
        ? [selection.selectedOnCalibration.id]
        : [],
    ),
  );
  for (const summary of report.variantSummaries.filter(
    (candidate) =>
      candidate.variantId === "V0_current" ||
      selectedIds.has(candidate.variantId),
  )) {
    lines.push(
      `| ${summary.variantId} | ${summary.applicableRows} | ${Object.entries(
        summary.labels,
      )
        .map(([key, value]) => `${key}:${value}`)
        .join(
          ", ",
        )} | ${summary.changedVsBaseline} (${percent(summary.changedRateVsBaseline)}) | ${percent(summary.cutTargetExact.precision)} | ${percent(summary.cutTargetExact.opportunityRecall)} | ${percent(summary.winnerTargetExact.precision)} | ${percent(summary.winnerTargetExact.opportunityRecall)} | ${percent(summary.portfolioWinner.precision)} | ${percent(summary.portfolioWinner.opportunityRecall)} | ${percent(summary.refresh.precision)} | ${percent(summary.diagnose.precision)} | ${percent(summary.cut.unknownRate)} | ${percent(summary.cut.censoredRate)} | ${summary.safetyViolations} |`,
    );
  }
  lines.push("");
  lines.push("## Family Closure Gates");
  lines.push("");
  lines.push(
    "| Family | Candidates | Calibration selection | Locked-test known | Locked-test precision | Wilson lower | Locked-test recall | Paired baseline P/R | Paired candidate P/R | Paired net wins | McNemar p | Safety | Gate |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const selection of report.familySelections) {
    const paired = selection.lockedTest?.pairedOpportunityCapture;
    lines.push(
      `| ${selection.family} | ${selection.candidateCount} | ${selection.selectedOnCalibration?.id ?? "none"} | ${selection.lockedTest?.actionScore?.known ?? 0} | ${percent(selection.lockedTest?.actionScore?.precision ?? null)} | ${percent(selection.lockedTest?.precisionInterval?.lower ?? null)} | ${percent(selection.lockedTest?.actionScore?.opportunityRecall ?? null)} | ${percent(paired?.baselineActionScore.precision ?? null)} / ${percent(paired?.baselineActionScore.opportunityRecall ?? null)} | ${percent(paired?.candidateActionScore.precision ?? null)} / ${percent(paired?.candidateActionScore.opportunityRecall ?? null)} | ${paired?.candidateNetWins ?? 0} | ${paired?.pValue?.toFixed(4) ?? "n/a"} | ${selection.lockedTest?.safetyViolations ?? 0} | ${selection.gateStatus} |`,
    );
  }
  lines.push("");
  const h3Placebo = report.familySelections.find(
    (selection) => selection.family === "H3",
  )?.lockedTest?.pairedOpportunityCapture;
  lines.push("## H3 Account-Week Outcome Falsification");
  lines.push("");
  if (h3Placebo) {
    lines.push(
      `- Candidate-only known actions: ${h3Placebo.discordantActionOutcomes.candidateOnly.supported} supported / ${h3Placebo.discordantActionOutcomes.candidateOnly.refuted} refuted.`,
    );
    lines.push(
      `- Baseline-only known actions: ${h3Placebo.discordantActionOutcomes.baselineOnly.supported} supported / ${h3Placebo.discordantActionOutcomes.baselineOnly.refuted} refuted.`,
    );
    const permutation = h3Placebo.accountWeekOutcomePermutation;
    lines.push(
      permutation?.oneSidedPValue === null || permutation === null
        ? "- Account-week outcome permutation was not evaluable."
        : `- Account-week outcome permutation: observed net-correct delta ${permutation.observedNetCorrectDelta} across ${permutation.discordantActionCount} discordant actions; null 95% interval ${permutation.nullLower?.toFixed(3) ?? "n/a"}..${permutation.nullUpper?.toFixed(3) ?? "n/a"}; one-sided p=${permutation.oneSidedPValue.toFixed(4)}.`,
    );
  } else {
    lines.push("- H3 was not evaluable.");
  }
  lines.push("");
  lines.push("## H10 Probability Calibration");
  lines.push("");
  lines.push(
    "| Variant | Calibration known | Test known | Transformed | Unsupported | Calibrated action ECE | Calibrated action Brier | Gate |",
  );
  lines.push("|---|---:|---:|---:|---:|---|---|---|");
  for (const result of report.h10ProbabilityCalibration) {
    lines.push(
      `| ${result.variantId} | ${result.counts.calibration.knownOutcomeCount} | ${result.counts.lockedTest.knownOutcomeCount} | ${result.counts.transformedObservationCount} | ${result.counts.unsupportedObservationCount} | ${result.evaluation.calibrated.map((item) => `${item.action}:${percent(item.expectedCalibrationError)}`).join(", ") || "n/a"} | ${result.evaluation.calibrated.map((item) => `${item.action}:${item.brierScore?.toFixed(3) ?? "n/a"}`).join(", ") || "n/a"} | ${result.gateStatus} |`,
    );
  }
  lines.push("");
  lines.push(
    `- Strict automation gate: ${report.outcomeWindowEvaluations[PRIMARY_OUTCOME_WINDOW_DAYS].automationGate.status}.`,
  );
  lines.push(
    `- Bayesian walk-forward sensitivity variants: ${report.h10BayesianSensitivity.length}; descriptive only, automation eligibility is always false.`,
  );
  lines.push("");
  lines.push("## Interpretation Rules");
  lines.push("");
  lines.push(
    "- Cut support means the ad kept delivering and remained below explicit breakeven over the complete forward window.",
  );
  lines.push(
    "- Target-winner support is durability at or above the target that was provably known at the cutoff; it is not budget-scale lift.",
  );
  lines.push(
    "- Portfolio-winner support means complete forward ROAS remained in the same account-day-goal-currency cohort's top quartile; it measures promotion-to-main ranking, not economic target attainment.",
  );
  lines.push(
    "- Refresh is a decay-persistence proxy without successor lineage, not replacement lift.",
  );
  lines.push(
    "- Opportunity recall uses the same dated cohort for every variant.",
  );
  lines.push("- No result in this artifact is causal provider-write evidence.");
  lines.push("");
  lines.push("## Closure Actions");
  lines.push("");
  for (const item of report.nextActions) lines.push(`- ${item}`);
  lines.push("");
  return lines.join("\n");
}

export async function runReplay(args: ParsedArgs) {
  const variants =
    args.grid === "smoke" ? buildAdSmokeGrid() : buildAdChallengerGrid();
  const data = await loadSimulationData(args);
  const byAd = indexFacts(data.facts);
  const lifecycleByAd = indexLifecycle(data.lifecycle);
  const actionReceiptsByAd = indexActionReceipts(data.actionReceipts);
  const completeness = indexCompleteness(data.completeness);
  const rowsByBusiness = new Map<string, AdDailyFact[][]>();
  for (const rows of byAd.values()) {
    const businessId = rows[0]?.businessId;
    if (!businessId) continue;
    const list = rowsByBusiness.get(businessId) ?? [];
    list.push(rows);
    rowsByBusiness.set(businessId, list);
  }
  const cohortRows: CohortRow[] = [];
  const lastSelected = new Map<string, string>();
  for (const asOfDate of dateRange(args.startDate, args.decisionEndDate)) {
    for (const business of data.businesses) {
      const businessAds = rowsByBusiness.get(business.id) ?? [];
      const contexts = businessAds.flatMap((rows) => {
        const sample = rows[0];
        if (!sample) return [];
        const entityKey = `${sample.businessId}::${sample.providerAccountId}::${sample.adId}`;
        const actionKey = `${sample.businessId}::${sample.adId}`;
        const context = buildAdContext({
          business,
          rows,
          lifecycleRows: lifecycleByAd.get(entityKey) ?? [],
          actionReceipts: actionReceiptsByAd.get(actionKey) ?? [],
          asOfDate,
          completeness,
        });
        return context ? [context] : [];
      });
      if (contexts.length === 0) continue;
      const target = targetAtCutoff(
        data.targets.get(business.id) ?? [],
        asOfDate,
      );
      const targetStatus = targetState(target, asOfDate);
      const contextsByAccountCurrency = new Map<string, AdContext[]>();
      for (const context of contexts) {
        if (!context.currency) continue;
        const scopeKey = `${context.providerAccountId}::${context.currency}`;
        const list = contextsByAccountCurrency.get(scopeKey) ?? [];
        list.push(context);
        contextsByAccountCurrency.set(scopeKey, list);
      }
      for (const scopedContexts of contextsByAccountCurrency.values()) {
        const environment = buildReplayEnvironment(
          scopedContexts,
          targetStatus.exact ? target : null,
        );
        const scopedAdRows = scopedContexts.flatMap((context) => {
          const key = `${business.id}::${context.providerAccountId}::${context.adId}`;
          const rows = byAd.get(key);
          return rows ? [rows] : [];
        });
        const calibration = buildCalibration({
          business,
          adRows: scopedAdRows,
          asOfDate,
          target: targetStatus.exact ? target : null,
        });
        const profileConfig = data.profiles.get(business.id) ?? null;
        const baseRawProfile = buildProfile({
          business,
          asOfDate,
          target: targetStatus.exact ? target : null,
          calibration,
          profileConfig,
          forceRawAuthority: true,
        });
        for (const context of scopedContexts) {
          const eligibilityKey = `${business.id}::${context.providerAccountId}::${context.adId}`;
          const previous = lastSelected.get(eligibilityKey);
          if (previous && diffDays(asOfDate, previous) < DECISION_COOLDOWN_DAYS)
            continue;
          if (!context.optimizationGoal || !context.objective) continue;
          lastSelected.set(eligibilityKey, asOfDate);
          const adRows = byAd.get(eligibilityKey) ?? [];
          const actionReceipts =
            actionReceiptsByAd.get(`${business.id}::${context.adId}`) ?? [];
          const outcomes = Object.fromEntries(
            OUTCOME_WINDOWS.map((windowDays) => [
              windowDays,
              buildForwardOutcome({
                context,
                rows: adRows,
                actionReceipts,
                completeness,
                outcomeCeiling: args.outcomeCeiling,
                windowDays,
                target,
                targetExact: targetStatus.exact,
                targetFresh: targetStatus.fresh,
                baseProfile: baseRawProfile,
                environment,
                baselineVariant: variants[0]!,
              }),
            ]),
          ) as Record<OutcomeWindowDays, ForwardOutcome>;
          const outcome = outcomes[PRIMARY_OUTCOME_WINDOW_DAYS];
          const baselineVariant = variants[0]!;
          const baselineDecision = evaluateVariant({
            context,
            target,
            targetExact: targetStatus.exact,
            targetFresh: targetStatus.fresh,
            baseRawProfile,
            calibration,
            environment,
            variant: baselineVariant,
          });
          const formulaContext = formulaCalibrationContext(context);
          const formulaCalibrationDecision = evaluateVariant({
            context: formulaContext.context,
            target,
            targetExact: targetStatus.exact,
            targetFresh: targetStatus.fresh,
            baseRawProfile,
            calibration,
            environment,
            variant: baselineVariant,
          });
          const decisions = [
            baselineDecision,
            ...variants.slice(1).map((variant) =>
              variantApplicable({
                variant,
                context,
                targetExact: targetStatus.exact,
              })
                ? evaluateVariant({
                    context,
                    target,
                    targetExact: targetStatus.exact,
                    targetFresh: targetStatus.fresh,
                    baseRawProfile,
                    calibration,
                    environment,
                    variant,
                  })
                : {
                    ...baselineDecision,
                    variantId: variant.id,
                    applicable: false,
                  },
            ),
          ];
          cohortRows.push({
            key: `${business.id}::${context.providerAccountId}::${context.adId}::${asOfDate}`,
            manifestHash: createManifestHash({
              context,
              target,
              targetExact: targetStatus.exact,
              targetFresh: targetStatus.fresh,
              outcomes,
              profileConfig,
            }),
            decisionInputHash: createDecisionInputHash({
              context,
              target,
              targetExact: targetStatus.exact,
              targetFresh: targetStatus.fresh,
              profileConfig,
            }),
            sourceMode: "restated_ad_daily",
            context,
            target,
            targetExact: targetStatus.exact,
            targetFresh: targetStatus.fresh,
            calibration,
            decisions,
            formulaCalibrationDecision,
            formulaCalibrationStatusSource: formulaContext.source,
            outcomes,
            outcome,
          });
        }
      }
    }
  }
  const outcomeWindowEvaluations = Object.fromEntries(
    OUTCOME_WINDOWS.map((windowDays) => {
      const allRows = rowsForOutcomeWindow(cohortRows, windowDays);
      applyPortfolioWinnerOutcomes(allRows);
      applyNonPurchaseWinnerOutcomes(allRows);
      const primaryRows = uncontaminatedObservationalRows(allRows);
      const foldSummaries = summarizeFoldRows({
        rows: primaryRows,
        variants,
        outcomeCeiling: args.outcomeCeiling,
        outcomeWindowDays: windowDays,
      });
      const allObservationalFoldSummaries = summarizeFoldRows({
        rows: allRows,
        variants,
        outcomeCeiling: args.outcomeCeiling,
        outcomeWindowDays: windowDays,
      });
      const familySelections = selectFamilyCandidates({
        variants,
        folds: foldSummaries,
        rows: primaryRows,
      });
      const h10ProbabilityCalibration = runH10ProbabilityCalibration(
        primaryRows,
        windowDays,
      );
      const acceptedStrictVariants = h10ProbabilityCalibration
        .filter((entry) => entry.gateStatus === "accept")
        .map((entry) => entry.variantId);
      const formulaCounterfactualRows = primaryRows.filter(
        (row) =>
          row.formulaCalibrationStatusSource ===
            "observed_delivery_counterfactual" &&
          (row.formulaCalibrationDecision.axes.executionAction === "cut_ad" ||
            row.formulaCalibrationDecision.axes.executionAction ===
              "refresh_creative" ||
            row.formulaCalibrationDecision.axes.portfolioRole ===
              "current_winner"),
      ).length;
      return [
        windowDays,
        {
          windowDays,
          coverage: {
            cohortRows: allRows.length,
            completeRows: allRows.filter((row) => row.outcome.complete).length,
            primaryUncontaminatedRows: primaryRows.length,
            primaryCompleteRows: primaryRows.filter(
              (row) => row.outcome.complete,
            ).length,
            accountDaysExpected: allRows.reduce(
              (sum, row) => sum + row.outcome.accountDaysExpected,
              0,
            ),
            accountDaysPresent: allRows.reduce(
              (sum, row) => sum + row.outcome.accountDaysPresent,
              0,
            ),
          },
          actionStrata: summarizeActionStrata(allRows, variants[0]!),
          variantSummariesAllObservational: summarizeVariants(
            allRows,
            variants,
          ),
          variantSummaries: summarizeVariants(primaryRows, variants),
          allObservationalFoldSummaries,
          foldSummaries,
          familySelections,
          h10ProbabilityCalibration,
          h10BayesianSensitivity: runH10BayesianSensitivity(
            primaryRows,
            windowDays,
          ),
          automationGate: {
            requiredContract:
              "strict action-specific 5 equal-mass bins x 50 known outcomes, ECE <= 0.05, and >=10% Brier improvement",
            acceptedStrictVariants,
            status:
              acceptedStrictVariants.length > 0 &&
              formulaCounterfactualRows === 0
                ? ("statistical_gate_passed_operator_authority_still_required" as const)
                : acceptedStrictVariants.length > 0
                  ? ("closed_non_authoritative_status_counterfactual" as const)
                  : ("closed_insufficient_or_failed_strict_evidence" as const),
            bayesianSensitivityCanOpenGate: false as const,
            formulaCounterfactualRows,
          },
        },
      ];
    }),
  ) as Record<
    OutcomeWindowDays,
    {
      windowDays: OutcomeWindowDays;
      coverage: {
        cohortRows: number;
        completeRows: number;
        primaryUncontaminatedRows: number;
        primaryCompleteRows: number;
        accountDaysExpected: number;
        accountDaysPresent: number;
      };
      actionStrata: ReturnType<typeof summarizeActionStrata>;
      variantSummariesAllObservational: VariantSummary[];
      variantSummaries: VariantSummary[];
      allObservationalFoldSummaries: ReturnType<typeof summarizeFoldRows>;
      foldSummaries: ReturnType<typeof summarizeFoldRows>;
      familySelections: ReturnType<typeof selectFamilyCandidates>;
      h10ProbabilityCalibration: ReturnType<
        typeof runH10ProbabilityCalibration
      >;
      h10BayesianSensitivity: ReturnType<typeof runH10BayesianSensitivity>;
      automationGate: {
        requiredContract: string;
        acceptedStrictVariants: string[];
        status:
          | "statistical_gate_passed_operator_authority_still_required"
          | "closed_non_authoritative_status_counterfactual"
          | "closed_insufficient_or_failed_strict_evidence";
        bayesianSensitivityCanOpenGate: false;
        formulaCounterfactualRows: number;
      };
    }
  >;
  const primaryEvaluation =
    outcomeWindowEvaluations[PRIMARY_OUTCOME_WINDOW_DAYS];
  const variantSummaries = primaryEvaluation.variantSummaries;
  const foldSummaries = primaryEvaluation.foldSummaries;
  const familySelections = primaryEvaluation.familySelections;
  const h10ProbabilityCalibration = primaryEvaluation.h10ProbabilityCalibration;
  const targetExactRows = cohortRows.filter((row) => row.targetExact).length;
  const completeOutcomeRows = cohortRows.filter(
    (row) => row.outcome.complete,
  ).length;
  const creativeIdRows = cohortRows.filter(
    (row) => row.context.creativeId !== null,
  ).length;
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptContentHash = createHash("sha256")
    .update(readFileSync(scriptPath))
    .digest("hex");
  const simulationSourceDir = `${process.cwd()}/lib/creative-decision-engine/simulation`;
  const simulationSourcePaths = SIMULATION_SOURCE_FILES.map((name) =>
    join(simulationSourceDir, name),
  );
  const simulationSourceHash = hashFiles(
    simulationSourceDir,
    simulationSourcePaths,
  );
  const engineSourceDir = `${process.cwd()}/lib/creative-decision-engine`;
  const productionEngineSourcePaths = sourceFilesRecursively(
    engineSourceDir,
  ).filter(
    (absolute) =>
      absolute.endsWith(".ts") &&
      !absolute.includes("/__tests__/") &&
      !absolute.includes("/simulation/") &&
      !absolute.endsWith(".test.ts"),
  );
  const productionEngineSourceHash = hashFiles(
    engineSourceDir,
    productionEngineSourcePaths,
  );
  const worktreeDiff = execFileSync(
    "git",
    [
      "diff",
      "--binary",
      "--",
      "scripts/creative-decision-center/native-ad-grain-paired-replay.ts",
      "lib/creative-decision-engine",
    ],
    { encoding: "utf8" },
  );
  const worktreeStatus = execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      "scripts/creative-decision-center/native-ad-grain-paired-replay.ts",
      "lib/creative-decision-engine",
    ],
    { encoding: "utf8" },
  );
  const sortedCohort = [...cohortRows].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const fixedCohortInputHash = hash(
    sortedCohort.map((row) => ({
      key: row.key,
      decisionInputHash: row.decisionInputHash,
    })),
  );
  const manifestSetHash = hash(
    sortedCohort.map((row) => ({
      key: row.key,
      manifestHash: row.manifestHash,
    })),
  );
  const outcomeWindowSetHash = hash(
    sortedCohort.map((row) => ({
      key: row.key,
      outcomes: Object.fromEntries(
        OUTCOME_WINDOWS.map((windowDays) => {
          const outcome = row.outcomes[windowDays];
          return [
            windowDays,
            {
              complete: outcome.complete,
              spend: outcome.spend,
              purchases: outcome.purchases,
              revenue: outcome.revenue,
              accountDaysExpected: outcome.accountDaysExpected,
              accountDaysPresent: outcome.accountDaysPresent,
              forwardActionReceiptIds: outcome.forwardActionReceiptIds,
            },
          ];
        }),
      ),
    })),
  );
  const report = {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    readOnly: true as const,
    mutatesData: false as const,
    providerCalls: false as const,
    jobsRun: false as const,
    input: args,
    lineage: {
      gitSha,
      engineVersion: ENGINE_VERSION,
      scriptContentHash,
      simulationSourceHash,
      productionEngineSourceHash,
      worktreeStateHash: hash({
        diff: worktreeDiff,
        status: worktreeStatus,
        scriptContentHash,
        simulationSourceHash,
        productionEngineSourceHash,
      }),
      configHash: hash({
        contractVersion: CONTRACT_VERSION,
        variants,
      }),
      fixedCohortInputHash,
      manifestSetHash,
      outcomeWindowSetHash,
    },
    methodology: {
      sourceMode: "restated_ad_daily",
      decisionGrain: "ad_id",
      cohort: `fixed opportunity rows with ${DECISION_COOLDOWN_DAYS}d cooldown, independent of variant`,
      outcomeWindowDays: [...OUTCOME_WINDOWS],
      primarySelectionEvidence:
        "Each window selects on its own earlier calibration fold and is scored on its own locked fold; windows are never pooled. Primary rows have no pre-cutoff receipt and no forward-window action-log contamination.",
      h10FormulaSensitivity:
        "Canonical decisions retain missing effective status. H10 alone also evaluates a shadow formula candidate under observed same-day delivery; this is an explicit non-authoritative counterfactual and can never open automation.",
      zeroRoasRule: "positive spend plus zero revenue is known zero ROAS",
      zeroSpendRule:
        "zero forward spend is always censored; action receipts are observational strata and never converted to saved-spend or causal treatment claims",
      authorityRule: "restated source mode is review-only",
      boundedEliminations: [
        {
          family: "H1",
          axis: "campaign_kind_parent",
          status: "eliminated_by_upstream_authority_gate",
          reason:
            "H11's four cutoff-safe automatic-context policies failed the locked segmentation gate, while legacy labels are current-only; a rejected shadow kind cannot define calibration cells.",
          evidenceArtifact:
            "H11_CAMPAIGN_CONTEXT_CHALLENGER_2025-12-01_TO_2026-07-05.md",
        },
        {
          family: "H3",
          axis: "convex_p25_to_breakeven_continuum",
          status: "finite_endpoints_and_invariant",
          reason:
            "lambda=0 is account P25, lambda=0.5 is the tested midpoint, and lambda=1 is the breakeven endpoint. When breakeven exceeds P25, every lambda>0 expands the cut zone and violates the no-widen invariant; when breakeven is lower, the cap collapses positive lambda endpoints to the tested breakeven ceiling.",
          evidenceArtifact: "DECISION_LOG.md#d049",
        },
        {
          family: "H8",
          axis: "continuous_non_purchase_weight_simplex",
          status: "eliminated_by_identifiability_gate",
          reason:
            "The three operational vertices plus balanced-depth interior preset were evaluated. Locked evidence contains only 11 known actions from one business, so fitting arbitrary continuous weights would be account-specific overfit rather than an identifiable portable challenger.",
          evidenceArtifact:
            "NATIVE_AD_GRAIN_PAIRED_REPLAY_2025-12-01_TO_2026-06-27.md",
        },
      ],
    },
    coverage: {
      businesses: data.businesses.length,
      sourceRows: data.facts.length,
      cohortRows: cohortRows.length,
      targetExactRows,
      targetExactRate: ratio(targetExactRows, cohortRows.length),
      completeOutcomeRows,
      completeOutcomeRate: ratio(completeOutcomeRows, cohortRows.length),
      outcomeCompletenessByWindow: Object.fromEntries(
        OUTCOME_WINDOWS.map((windowDays) => [
          windowDays,
          {
            completeRows:
              outcomeWindowEvaluations[windowDays].coverage.completeRows,
            completeRate: ratio(
              outcomeWindowEvaluations[windowDays].coverage.completeRows,
              cohortRows.length,
            ),
            accountDaysPresent:
              outcomeWindowEvaluations[windowDays].coverage.accountDaysPresent,
            accountDaysExpected:
              outcomeWindowEvaluations[windowDays].coverage.accountDaysExpected,
          },
        ]),
      ),
      creativeIdRows,
      creativeIdRate: ratio(creativeIdRows, cohortRows.length),
      sourceRowsUpdatedAfterCutoff: cohortRows.filter(
        (row) => row.context.sourceUpdatedAfterCutoff,
      ).length,
      duplicateCohortKeys:
        cohortRows.length - new Set(cohortRows.map((row) => row.key)).size,
      uniqueDecisionInputHashes: new Set(
        cohortRows.map((row) => row.decisionInputHash),
      ).size,
      cutoffSafeContext: {
        effectiveStatusRows: cohortRows.filter(
          (row) => row.context.retained.effectiveStatus !== null,
        ).length,
        creativeFormatRows: cohortRows.filter(
          (row) => row.context.retained.creativeFormat !== null,
        ).length,
        lifecycleRows: cohortRows.filter(
          (row) => row.context.retained.lifecycleComputedAt !== null,
        ).length,
        rankingRows: cohortRows.filter(
          (row) =>
            row.context.retained.qualityRanking !== null ||
            row.context.retained.engagementRateRanking !== null ||
            row.context.retained.conversionRateRanking !== null,
        ).length,
        bidRegimeRows: cohortRows.filter(
          (row) => row.context.retained.bidRegime !== "unknown",
        ).length,
        freshTargetRows: cohortRows.filter((row) => row.targetFresh).length,
      },
      actionExposureAtCutoff: Object.fromEntries(
        (["untreated", "acted_success", "failed", "dry_run"] as const).map(
          (stratum) => [
            stratum,
            cohortRows.filter(
              (row) => row.context.actionExposureAtCutoff.stratum === stratum,
            ).length,
          ],
        ),
      ),
    },
    variants,
    variantSummaries,
    foldSummaries,
    familySelections,
    h10ProbabilityCalibration,
    h10BayesianSensitivity: primaryEvaluation.h10BayesianSensitivity,
    outcomeWindowEvaluations,
    changedExamples: cohortRows
      .filter((row) => {
        const baseline = row.decisions[0];
        return row.decisions.some(
          (decision) =>
            decision.label !== baseline?.label ||
            decision.axes.portfolioRole !== baseline.axes.portfolioRole,
        );
      })
      .slice(0, 100)
      .map((row) => ({
        key: row.key,
        business: row.context.business.name,
        adId: row.context.adId,
        asOfDate: row.context.asOfDate,
        currency: row.context.currency,
        targetExact: row.targetExact,
        pre: {
          spend: row.context.window28.spend,
          purchases: row.context.window28.purchases,
          roas: row.context.window28.roas,
        },
        outcome: row.outcome,
        decisions: row.decisions,
      })),
    nextActions: [
      "Keep D049 review-only as a monotonic no-widen safety invariant; the superseded pre-D049 artifact is not comparable to this strict-input run and no historical lift is claimed.",
      "H11 is closed: retain the production campaign-context default and do not enable automatic context consumption.",
      "H12 produced no strict historical hard entries: make no policy change and retain the shipped guard only as an unpromoted safety mechanism pending native evidence.",
      "Keep H10 automation closed unless the strict action-specific 5x50/ECE contract passes; Bayesian walk-forward outputs are bounded descriptive sensitivity only and cannot grant authority.",
    ],
  };
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runReplay(args);
  const cohortComparison = args.compareCohortJson
    ? assertNativeReplayCohortMatch(
        JSON.parse(
          readFileSync(args.compareCohortJson, "utf8"),
        ) as NativeReplayCohortComparable,
        report,
      )
    : null;
  const markdown = renderMarkdown(report);
  if (args.writeFiles) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    mkdirSync(dirname(args.mdOut), { recursive: true });
    writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(args.mdOut, `${markdown}\n`, "utf8");
  }
  console.log(
    JSON.stringify(
      {
        contractVersion: report.contractVersion,
        coverage: report.coverage,
        outcomeWindows: Object.fromEntries(
          OUTCOME_WINDOWS.map((windowDays) => {
            const evaluation = report.outcomeWindowEvaluations[windowDays];
            return [
              windowDays,
              {
                coverage: evaluation.coverage,
                automationGate: evaluation.automationGate,
                bayesianSensitivity: evaluation.h10BayesianSensitivity.map(
                  (run) => ({
                    variantId: run.provenance.variantId,
                    crossFittedEmpirical: run.counts.crossFittedEmpirical,
                    lockedTestEmpirical: run.counts.lockedTestEmpirical,
                    automationEligible: run.automationEligible,
                  }),
                ),
              },
            ];
          }),
        ),
        familySelections: report.familySelections,
        cohortComparison,
        outputs: args.writeFiles
          ? { json: args.jsonOut, markdown: args.mdOut }
          : null,
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
