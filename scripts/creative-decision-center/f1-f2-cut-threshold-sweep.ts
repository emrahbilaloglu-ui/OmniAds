#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, type QueryResultRow } from "pg";
import {
  ENGINE_PRESET_MULTIPLIERS,
  ZERO_CONV_MIN_AGE_DAYS,
} from "@/lib/creative-decision-engine/config-values";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import type { EngineRiskPreset } from "@/lib/creative-decision-engine/types";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const DEFAULT_ACCOUNT_SCOPES = [
  { businessIdentifier: "IwaStore", providerAccountId: "act_1087566732415606" },
  { businessIdentifier: "EMOLOS", providerAccountId: "act_1054905059780305" },
  { businessIdentifier: "Grandmix", providerAccountId: "act_805150454596350" },
  { businessIdentifier: "TheSwaf", providerAccountId: "act_822913786458311" },
] as const;
const DEFAULT_BUSINESS_IDENTIFIERS = DEFAULT_ACCOUNT_SCOPES.map(
  (scope) => scope.businessIdentifier,
);
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/f1-f2-cut-threshold-sweep.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/F1_F2_CUT_THRESHOLD_SWEEP_2026-07-02.md";
const LOCKED_WINDOW_SUITE = [
  {
    id: "2025-12_to_2026-01",
    label: "December 2025 - January 2026",
    startDate: "2025-12-01",
    endDate: "2026-01-31",
  },
  {
    id: "2026-02_to_2026-03",
    label: "February - March 2026",
    startDate: "2026-02-01",
    endDate: "2026-03-31",
  },
  {
    id: "2026-04_to_2026-05",
    label: "April - May 2026",
    startDate: "2026-04-01",
    endDate: "2026-05-31",
  },
  {
    id: "2026-06",
    label: "June 2026",
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  },
] as const;
const FOCUSED_VARIANT_IDS = [
  "V0_current",
  "V2b_p25_breakeven_floor",
  "V2c_breakeven_recent_hold",
  "V2d_breakeven_recent_hold_temporal_confirmation",
] as const;
const MIN_DEFENSIBLE_EPISODES = 30;
const STATEMENT_TIMEOUT_MS = 30_000;
export const F1_F2_SWEEP_CONTRACT_VERSION =
  "adsecute.f1-f2-cut-threshold-sweep.v1" as const;
export const F1_F2_SWEEP_CONTRACT_REVISION = 5 as const;

type Row = Record<string, unknown>;
type CountMap = Record<string, number>;
export type CutSource =
  | "zero_conv_burner"
  | "maturity_severe_loser"
  | "ratio_hard_cut"
  | "ratio_sustained_loser"
  | "ratio_loss_budget";
type BoundaryMode = "current" | "upper_1" | "breakeven_floor";
type PurchaseFloorMode = null | "fixed_2" | "fixed_3" | "fixed_5" | "half_winner";
type RecentRecoveryMode = "target" | "breakeven";
type ConfirmationMode = "none" | "later_calendar_date_consecutive";

interface ParsedArgs {
  asOf: string;
  startDate: string | null;
  endDate: string | null;
  lookbackDays: number;
  primaryForwardWindowDays: 14 | 28;
  businessIdentifiers: string[];
  jsonOut: string;
  mdOut: string;
  reportTitle: string;
  writeFiles: boolean;
  sampleSize: number;
  windowSuite: boolean;
  focusCreativeIds: string[];
}

interface BusinessIdentity {
  id: string;
  name: string;
  providerAccountId: string | null;
}

interface BusinessSourceStats {
  latestDataDate: string | null;
  earliestDataDate: string | null;
  sourceRows: number;
  creativeCount: number;
  campaignCount: number;
  totalSpend: number;
}

interface TargetConfig {
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  defaultRiskPosture: EngineRiskPreset | null;
  enginePresetLabel: EngineRiskPreset | null;
  attributionAovAdjustmentMultiplier: number;
  presetOverride: EngineRiskPreset | null;
  resolvedPreset: EngineRiskPreset;
}

export interface DailyCandidateRow {
  business: BusinessIdentity;
  asOfDate: string;
  creativeId: string;
  creativeName: string | null;
  campaignId: string | null;
  effectiveStatus: string | null;
  ageDays: number | null;
  asOfDateSpend: number;
  spend28: number;
  purchases28: number;
  revenue28: number;
  roas28: number | null;
  recent7Spend: number;
  recent7Roas: number | null;
  forward14Spend: number;
  forward14Revenue: number;
  forward14Roas: number | null;
  forward28Spend: number;
  forward28Revenue: number;
  forward28Roas: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
  metaAovMean90d: number | null;
  metaAovPurchaseCount90d: number;
  metaRevenue90d: number;
  matureCreativeCount: number;
  matureSpendP50: number | null;
  winnerPurchaseP50: number | null;
  roasRatioP10: number | null;
  roasRatioP25: number | null;
  preset: EngineRiskPreset;
  attributionAovAdjustmentMultiplier: number;
}

interface ThresholdContext {
  spendUnit: number | null;
  spendUnitSource: string;
  spendUnitConfidence: string;
  lossBudgetMultiplier: number;
  hardCutMultiplier: number;
  lossBudgetGeHardCut: boolean;
  recentSampleMinSpend: number | null;
  zeroConvBurnerSpend: number | null;
  commercialMaturitySpend: number;
  sustainedLoserSpend: number | null;
  hardCutSpend: number | null;
  severeLoserRatio: number | null;
  boundary: number;
  purchaseFloor: number | null;
  purchaseFloorUsedFallback: boolean;
  breakevenRatio: number | null;
  boundaryFallbackReason: string | null;
}

export interface VariantSpec {
  id: string;
  label: string;
  purchaseFloor: PurchaseFloorMode;
  boundaryMode: BoundaryMode;
  lossBudgetMultiplierOverride: number | null;
  recentRecoveryMode?: RecentRecoveryMode;
  confirmationMode?: ConfirmationMode;
  isBaseline: boolean;
}

interface CutEvaluation {
  cuts: boolean;
  source: CutSource | null;
  threshold: ThresholdContext | null;
  blockedReason: string | null;
}

export interface Episode {
  variantId: string;
  business: BusinessIdentity;
  asOfDate: string;
  creativeId: string;
  creativeName: string | null;
  campaignId: string | null;
  source: CutSource;
  spend28: number;
  purchases28: number;
  roas28: number | null;
  recent7Spend: number;
  recent7Roas: number | null;
  targetRoas: number;
  breakEvenRoas: number | null;
  forward14Spend: number;
  forward14Roas: number | null;
  forward28Spend: number;
  forward28Roas: number | null;
  spendUnit: number | null;
  lossBudgetMultiplier: number;
  hardCutMultiplier: number;
  boundary: number;
  purchaseFloor: number | null;
  purchaseFloorUsedFallback: boolean;
  lossBudgetGeHardCut: boolean;
  boundaryFallbackReason: string | null;
}

interface VariantBusinessSummary {
  variantId: string;
  business: BusinessIdentity;
  episodes: number;
  defensible: boolean;
  dailyCutRows: number;
  affectedDailyRowsVsBaseline: number;
  flipRateVsBaseline: number | null;
  baselineEpisodesMatched: number;
  baselineEpisodesSuppressed: number;
  additionalEpisodesVsBaseline: number;
  medianDelayDaysVsBaseline: number | null;
  sourceCounts: CountMap;
  purchaseFloorFallbackEpisodes: number;
  lossBudgetGeHardCutEpisodes: number;
  boundaryFallbackEpisodes: number;
  temporalPendingDailyRows: number;
  rawDailySourceCounts: CountMap;
  window14: WindowSummary;
  window28: WindowSummary;
}

export interface WindowSummary {
  knownEpisodes: number;
  unknownEpisodes: number;
  recoveredAboveTarget: number;
  earlyCutRate: number | null;
  trueLoserEpisodes: number;
  savedSpend: number | null;
  savedSpendUnits: number | null;
}

interface BusinessReview {
  business: BusinessIdentity;
  status: "ok" | "skipped" | "failed";
  sourceStats: BusinessSourceStats | null;
  targetConfig: TargetConfig | null;
  evaluatedWindow: {
    startDate: string | null;
    endDate: string | null;
    lookbackDays: number;
    forwardWindowDays: 14 | 28;
  };
  rowsEvaluated: number;
  candidateRowsWithTarget: number;
  variants: VariantBusinessSummary[];
  samples: Episode[];
  focusedCreatives: FocusedCreativeReview[];
  errorMessage?: string;
}

interface FocusedCreativeReview {
  creativeId: string;
  creativeName: string | null;
  variantId: string;
  dailyRows: number;
  rawCutDays: number;
  publishedCutDays: number;
  pendingConfirmationDays: number;
  recentRecoveryHoldDays: number;
  notInCutZoneDays: number;
  belowCommercialMaturityDays: number;
  firstPublishedCutDate: string | null;
  lastPublishedCutDate: string | null;
  episodes: number;
  window14: WindowSummary;
  window28: WindowSummary;
}

interface PooledSummary {
  variantId: string;
  episodes: number;
  defensible: boolean;
  affectedDailyRowsVsBaseline: number;
  flipRateVsBaseline: number | null;
  medianDelayDaysVsBaseline: number | null;
  window14: WindowSummary;
  window28: WindowSummary;
}

interface SweepReport {
  contractVersion: typeof F1_F2_SWEEP_CONTRACT_VERSION;
  revision: typeof F1_F2_SWEEP_CONTRACT_REVISION;
  revisionNotes: string[];
  lineage: {
    gitSha: string;
    scriptContractRevision: typeof F1_F2_SWEEP_CONTRACT_REVISION;
  };
  generatedAt: string;
  readOnly: true;
  mutatesData: false;
  asOf: string;
  title: string;
  engineVersion: string;
  methodology: {
    unitOfAnalysis: string;
    lookaheadBiasStatus: string;
    targetHistoryAssumption: string;
    guardrailScope: string;
    nonMutationStatement: string;
    queryCostBound: string;
    primaryForwardWindowDays: 14 | 28;
    defensibleEpisodeThreshold: number;
  };
  variants: VariantSpec[];
  businessesRequested: string[];
  businessesFound: number;
  reviews: BusinessReview[];
  pooled: PooledSummary[];
  recommendation: {
    status:
      | "candidate_available"
      | "insufficient_evidence"
      | "no_uniform_change_supported";
    text: string;
    accountLevelSignals: string[];
  };
  evidenceLimits: string[];
}

interface FocusedAggregateSummary {
  variantId: string;
  episodes: number;
  temporalPendingDailyRows: number;
  rawDailySourceCounts: CountMap;
  window14: WindowSummary;
  window28: WindowSummary;
}

interface WindowSuiteReport {
  contractVersion: typeof F1_F2_SWEEP_CONTRACT_VERSION;
  revision: typeof F1_F2_SWEEP_CONTRACT_REVISION;
  generatedAt: string;
  readOnly: true;
  mutatesData: false;
  lineage: SweepReport["lineage"];
  transaction: {
    isolation: "repeatable read";
    readOnly: true;
    statementTimeoutMs: typeof STATEMENT_TIMEOUT_MS;
    applicationName: string;
  };
  accountScopes: Array<{
    businessName: string;
    providerAccountId: string | null;
  }>;
  windows: Array<{
    id: (typeof LOCKED_WINDOW_SUITE)[number]["id"];
    label: string;
    startDate: string;
    endDate: string;
    report: SweepReport;
  }>;
  aggregate: {
    pooled: FocusedAggregateSummary[];
    byBusiness: Array<{
      business: BusinessIdentity;
      variants: FocusedAggregateSummary[];
    }>;
  };
  verdict: {
    status: "review_only_reject_production_promotion";
    text: string;
  };
  evidenceLimits: string[];
}

export const VARIANTS: VariantSpec[] = [
  {
    id: "V0_current",
    label: "Current formula baseline; recovery guard already live",
    purchaseFloor: null,
    boundaryMode: "current",
    lossBudgetMultiplierOverride: null,
    isBaseline: true,
  },
  {
    id: "V1a_purchase_floor_2",
    label: "F1 sensitivity: purchase floor 2 or sustained-loser spend",
    purchaseFloor: "fixed_2",
    boundaryMode: "current",
    lossBudgetMultiplierOverride: null,
    isBaseline: false,
  },
  {
    id: "V1b_purchase_floor_3",
    label: "F1 sensitivity: purchase floor 3 or sustained-loser spend",
    purchaseFloor: "fixed_3",
    boundaryMode: "current",
    lossBudgetMultiplierOverride: null,
    isBaseline: false,
  },
  {
    id: "V1c_purchase_floor_5",
    label: "F1 sensitivity: fixed purchase floor 5 or sustained-loser spend",
    purchaseFloor: "fixed_5",
    boundaryMode: "current",
    lossBudgetMultiplierOverride: null,
    isBaseline: false,
  },
  {
    id: "V1d_purchase_floor_half_winner",
    label: "F1 account-relative: max(2, ceil(0.5 * winnerPurchaseP50)) or sustained-loser spend",
    purchaseFloor: "half_winner",
    boundaryMode: "current",
    lossBudgetMultiplierOverride: null,
    isBaseline: false,
  },
  {
    id: "V2a_p25_upper_clamp_1",
    label: "F2 sensitivity: cut boundary min(P25, 1.0)",
    purchaseFloor: null,
    boundaryMode: "upper_1",
    lossBudgetMultiplierOverride: null,
    isBaseline: false,
  },
  {
    id: "V2b_p25_breakeven_floor",
    label: "F2 sensitivity: cut boundary clamped to [breakevenRatio, 1.0]",
    purchaseFloor: null,
    boundaryMode: "breakeven_floor",
    lossBudgetMultiplierOverride: null,
    isBaseline: false,
  },
  {
    id: "V2c_breakeven_recent_hold",
    label:
      "Mature below-break-even: breakeven boundary, but hold when a sufficient recent 7d sample is at or above explicit break-even",
    purchaseFloor: null,
    boundaryMode: "breakeven_floor",
    lossBudgetMultiplierOverride: null,
    recentRecoveryMode: "breakeven",
    confirmationMode: "none",
    isBaseline: false,
  },
  {
    id: "V2d_breakeven_recent_hold_temporal_confirmation",
    label:
      "V2c plus next-calendar-date consecutive confirmation for ratio cuts; zero-conversion and maturity-severe safety cuts remain immediate",
    purchaseFloor: null,
    boundaryMode: "breakeven_floor",
    lossBudgetMultiplierOverride: null,
    recentRecoveryMode: "breakeven",
    confirmationMode: "later_calendar_date_consecutive",
    isBaseline: false,
  },
  {
    id: "V3_recommended_combo",
    label: "F1+F2 combined: account-relative purchase floor and [breakevenRatio, 1.0] boundary",
    purchaseFloor: "half_winner",
    boundaryMode: "breakeven_floor",
    lossBudgetMultiplierOverride: null,
    isBaseline: false,
  },
  {
    id: "LB1_0_loss_budget",
    label: "3.1 sensitivity: lossBudgetMultiplier absolute override 1.0",
    purchaseFloor: null,
    boundaryMode: "current",
    lossBudgetMultiplierOverride: 1.0,
    isBaseline: false,
  },
  {
    id: "LB1_5_loss_budget",
    label: "3.1 sensitivity: lossBudgetMultiplier absolute override 1.5",
    purchaseFloor: null,
    boundaryMode: "current",
    lossBudgetMultiplierOverride: 1.5,
    isBaseline: false,
  },
  {
    id: "LB2_0_loss_budget",
    label: "3.1 sensitivity: lossBudgetMultiplier absolute override 2.0",
    purchaseFloor: null,
    boundaryMode: "current",
    lossBudgetMultiplierOverride: 2.0,
    isBaseline: false,
  },
  {
    id: "LB2_5_loss_budget",
    label: "3.1 sensitivity: lossBudgetMultiplier absolute override 2.5",
    purchaseFloor: null,
    boundaryMode: "current",
    lossBudgetMultiplierOverride: 2.5,
    isBaseline: false,
  },
  {
    id: "LB3_0_loss_budget",
    label: "3.1 sensitivity: lossBudgetMultiplier absolute override 3.0",
    purchaseFloor: null,
    boundaryMode: "current",
    lossBudgetMultiplierOverride: 3.0,
    isBaseline: false,
  },
  {
    id: "LB4_0_loss_budget",
    label: "3.1 sensitivity: lossBudgetMultiplier absolute override 4.0",
    purchaseFloor: null,
    boundaryMode: "current",
    lossBudgetMultiplierOverride: 4.0,
    isBaseline: false,
  },
];

const LOSS_BUDGET_VARIANT_IDS = VARIANTS.filter(
  (variant) => variant.lossBudgetMultiplierOverride !== null,
).map((variant) => variant.id);

let activeReplayClient: Client | null = null;

async function queryRows<TRow extends QueryResultRow = Row>(
  queryText: string,
  params?: unknown[],
) {
  if (!activeReplayClient) {
    throw new Error("Read-only replay query attempted outside its bound transaction.");
  }
  const result = await activeReplayClient.query<TRow>(queryText, params);
  return result.rows;
}

function assertTunnelReadOnlyRuntime(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.port !== "15432"
  ) {
    throw new Error(
      "F1/F2 replay requires the existing read-only tunnel at 127.0.0.1:15432.",
    );
  }
  const applicationName = process.env.PGAPPNAME?.trim();
  if (!applicationName) throw new Error("PGAPPNAME is required.");
  const pgOptions = process.env.PGOPTIONS ?? "";
  if (!pgOptions.includes("default_transaction_read_only=on")) {
    throw new Error("PGOPTIONS must include default_transaction_read_only=on.");
  }
  return applicationName;
}

async function withReadOnlyReplayTransaction<T>(run: () => Promise<T>) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const applicationName = assertTunnelReadOnlyRuntime(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: applicationName,
  });
  await client.connect();
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    activeReplayClient = client;
    const result = await run();
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    activeReplayClient = null;
    await client.end();
  }
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): ParsedArgs {
  const primaryForwardWindowDays =
    arg(argv, "primaryForwardWindowDays", "28") === "14" ? 14 : 28;
  return {
    asOf: arg(argv, "asOf", todayIsoDate()),
    startDate: arg(argv, "startDate", "") || null,
    endDate: arg(argv, "endDate", "") || null,
    lookbackDays: Math.max(30, Number(arg(argv, "lookbackDays", "180")) || 180),
    primaryForwardWindowDays,
    businessIdentifiers:
      csvArg(argv, "businesses") ?? [...DEFAULT_BUSINESS_IDENTIFIERS],
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    reportTitle: arg(
      argv,
      "reportTitle",
      "F1/F2 Cut Threshold Sweep - 2026-07-02",
    ),
    writeFiles: arg(argv, "write", "1") !== "0",
    sampleSize: Math.max(1, Number(arg(argv, "sampleSize", "12")) || 12),
    windowSuite: arg(argv, "windowSuite", "0") === "1",
    focusCreativeIds: csvArg(argv, "focusCreatives") ?? [],
  };
}

function arg(argv: string[], name: string, fallback: string) {
  const prefix = `--${name}=`;
  return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function csvArg(argv: string[], name: string) {
  const raw = arg(argv, name, "");
  if (!raw) return null;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? rounded(numerator / denominator) : null;
}

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function diffDays(left: string, right: string) {
  const leftMs = Date.parse(`${left}T00:00:00.000Z`);
  const rightMs = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return null;
  return Math.round((leftMs - rightMs) / 86_400_000);
}

function minDate(left: string, right: string) {
  return left <= right ? left : right;
}

function maxDate(left: string, right: string) {
  return left >= right ? left : right;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function increment(map: CountMap, key: string | null | undefined) {
  const normalized = key?.trim() || "null";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function resolvePreset(input: {
  presetOverride: EngineRiskPreset | null;
  profilePreset: EngineRiskPreset | null;
  targetPreset: EngineRiskPreset | null;
}) {
  return input.presetOverride ?? input.profilePreset ?? input.targetPreset ?? "balanced";
}

async function findBusinesses(identifiers: readonly string[]) {
  const normalized = identifiers.map((item) => item.toLowerCase());
  const rows = await queryRows<Row & { id: unknown; name: unknown }>(
    `
    SELECT id::text AS id, name
    FROM businesses
    WHERE lower(name) = ANY($1::text[])
       OR id::text = ANY($2::text[])
    ORDER BY name ASC, id ASC
    `,
    [normalized, identifiers],
  );

  return rows.flatMap((row) => {
    const id = toText(row.id);
    const name = toText(row.name);
    if (!id || !name) return [];
    const providerAccountId =
      DEFAULT_ACCOUNT_SCOPES.find(
        (scope) => scope.businessIdentifier.toLowerCase() === name.toLowerCase(),
      )?.providerAccountId ?? null;
    return [{ id, name, providerAccountId }];
  });
}

async function readSourceStats(
  business: BusinessIdentity,
): Promise<BusinessSourceStats> {
  const [row] = await queryRows<Row>(
    `
    SELECT
      MIN(date) AS earliest_data_date,
      MAX(date) AS latest_data_date,
      COUNT(*)::integer AS source_rows,
      COUNT(DISTINCT creative_id)::integer AS creative_count,
      COUNT(DISTINCT campaign_id)::integer AS campaign_count,
      COALESCE(SUM(spend), 0) AS total_spend
    FROM meta_creative_daily
    WHERE business_id = $1::text
      AND ($2::text IS NULL OR provider_account_id = $2::text)
    `,
    [business.id, business.providerAccountId],
  );

  return {
    latestDataDate: normalizePostgresDate(row?.latest_data_date),
    earliestDataDate: normalizePostgresDate(row?.earliest_data_date),
    sourceRows: toNumber(row?.source_rows),
    creativeCount: toNumber(row?.creative_count),
    campaignCount: toNumber(row?.campaign_count),
    totalSpend: toNumber(row?.total_spend),
  };
}

async function readTargetConfig(businessId: string): Promise<TargetConfig> {
  const [row] = await queryRows<Row>(
    `
    WITH target_pack AS (
      SELECT
        target_cpa,
        target_roas,
        break_even_cpa,
        break_even_roas,
        aov_assumption,
        default_risk_posture
      FROM business_target_packs
      WHERE business_id = $1::uuid
      ORDER BY updated_at DESC
      LIMIT 1
    ),
    profile AS (
      SELECT engine_preset_label, attribution_aov_adjustment_multiplier
      FROM business_decision_calibration_profiles
      WHERE business_id = $1::uuid
        AND channel = 'meta'
        AND objective_family = 'sales'
      ORDER BY updated_at DESC
      LIMIT 1
    ),
    flags AS (
      SELECT preset_override
      FROM business_engine_v3_flags
      WHERE business_id = $1::uuid
      LIMIT 1
    )
    SELECT
      target_pack.target_cpa,
      target_pack.target_roas,
      target_pack.break_even_cpa,
      target_pack.break_even_roas,
      target_pack.aov_assumption,
      target_pack.default_risk_posture,
      profile.engine_preset_label,
      profile.attribution_aov_adjustment_multiplier,
      flags.preset_override
    FROM (SELECT 1) seed
    LEFT JOIN target_pack ON true
    LEFT JOIN profile ON true
    LEFT JOIN flags ON true
    `,
    [businessId],
  );
  const targetPreset = parsePreset(row?.default_risk_posture);
  const profilePreset = parsePreset(row?.engine_preset_label);
  const presetOverride = parsePreset(row?.preset_override);

  return {
    targetCpa: toNullableNumber(row?.target_cpa),
    targetRoas: toNullableNumber(row?.target_roas),
    breakEvenCpa: toNullableNumber(row?.break_even_cpa),
    breakEvenRoas: toNullableNumber(row?.break_even_roas),
    operatorAovAssumption: toNullableNumber(row?.aov_assumption),
    defaultRiskPosture: targetPreset,
    enginePresetLabel: profilePreset,
    attributionAovAdjustmentMultiplier:
      toNullableNumber(row?.attribution_aov_adjustment_multiplier) ?? 1,
    presetOverride,
    resolvedPreset: resolvePreset({
      presetOverride,
      profilePreset,
      targetPreset,
    }),
  };
}

function parsePreset(value: unknown): EngineRiskPreset | null {
  return value === "aggressive" ||
    value === "balanced" ||
    value === "conservative"
    ? value
    : null;
}

async function readDailyCandidateRows(input: {
  business: BusinessIdentity;
  targetConfig: TargetConfig;
  startDate: string;
  endDate: string;
}): Promise<DailyCandidateRow[]> {
  const rows = await queryRows<Row>(
    `
    WITH days AS (
      SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date AS as_of_date
    ),
    selected AS (
      SELECT days.as_of_date, d.creative_id
      FROM days
      JOIN meta_creative_daily d
        ON d.business_id = $1::text
       AND ($5::text IS NULL OR d.provider_account_id = $5::text)
       AND d.date BETWEEN (days.as_of_date - INTERVAL '27 days') AND days.as_of_date
      WHERE d.spend > 0
      GROUP BY days.as_of_date, d.creative_id
    ),
    daily_metrics AS (
      SELECT
        s.as_of_date,
        s.creative_id,
        (ARRAY_AGG(d.creative_name ORDER BY d.date DESC, d.updated_at DESC)
          FILTER (WHERE d.date <= s.as_of_date))[1] AS creative_name,
        (ARRAY_AGG(d.campaign_id ORDER BY d.date DESC, d.updated_at DESC)
          FILTER (WHERE d.date <= s.as_of_date))[1] AS campaign_id,
        (ARRAY_AGG(d.effective_status ORDER BY d.date DESC, d.updated_at DESC)
          FILTER (WHERE d.date <= s.as_of_date))[1] AS effective_status,
        CASE
          WHEN MIN(d.first_spend_at) FILTER (WHERE d.date <= s.as_of_date) IS NOT NULL
          THEN s.as_of_date - (MIN(d.first_spend_at) FILTER (WHERE d.date <= s.as_of_date))::date
        END AS age_days,
        COALESCE(SUM(d.spend) FILTER (WHERE d.date = s.as_of_date), 0) AS as_of_date_spend,
        COALESCE(SUM(d.spend) FILTER (
          WHERE d.date BETWEEN (s.as_of_date - INTERVAL '27 days') AND s.as_of_date
        ), 0) AS spend_28d,
        COALESCE(SUM(d.conversions) FILTER (
          WHERE d.date BETWEEN (s.as_of_date - INTERVAL '27 days') AND s.as_of_date
        ), 0) AS purchases_28d,
        COALESCE(SUM(d.revenue) FILTER (
          WHERE d.date BETWEEN (s.as_of_date - INTERVAL '27 days') AND s.as_of_date
        ), 0) AS revenue_28d,
        COALESCE(SUM(d.spend) FILTER (
          WHERE d.date BETWEEN (s.as_of_date - INTERVAL '6 days') AND s.as_of_date
        ), 0) AS recent_7d_spend,
        COALESCE(SUM(d.revenue) FILTER (
          WHERE d.date BETWEEN (s.as_of_date - INTERVAL '6 days') AND s.as_of_date
        ), 0) AS recent_7d_revenue,
        COALESCE(SUM(d.spend) FILTER (
          WHERE d.date > s.as_of_date AND d.date <= (s.as_of_date + INTERVAL '14 days')
        ), 0) AS forward_14d_spend,
        COALESCE(SUM(d.revenue) FILTER (
          WHERE d.date > s.as_of_date AND d.date <= (s.as_of_date + INTERVAL '14 days')
        ), 0) AS forward_14d_revenue,
        COALESCE(SUM(d.spend) FILTER (
          WHERE d.date > s.as_of_date AND d.date <= (s.as_of_date + INTERVAL '28 days')
        ), 0) AS forward_28d_spend,
        COALESCE(SUM(d.revenue) FILTER (
          WHERE d.date > s.as_of_date AND d.date <= (s.as_of_date + INTERVAL '28 days')
        ), 0) AS forward_28d_revenue
      FROM selected s
      JOIN meta_creative_daily d
        ON d.business_id = $1::text
       AND ($5::text IS NULL OR d.provider_account_id = $5::text)
       AND d.creative_id = s.creative_id
       AND d.date BETWEEN (s.as_of_date - INTERVAL '27 days') AND (s.as_of_date + INTERVAL '28 days')
      GROUP BY s.as_of_date, s.creative_id
    ),
    calibration_raw AS (
      SELECT
        days.as_of_date,
        d.creative_id,
        SUM(d.spend) AS total_spend,
        SUM(d.conversions) AS total_purchases,
        SUM(d.revenue) AS total_revenue
      FROM days
      JOIN meta_creative_daily d
        ON d.business_id = $1::text
       AND ($5::text IS NULL OR d.provider_account_id = $5::text)
       AND d.date BETWEEN (days.as_of_date - INTERVAL '89 days') AND days.as_of_date
      GROUP BY days.as_of_date, d.creative_id
    ),
    calibration_values AS (
      SELECT
        as_of_date,
        creative_id,
        total_spend,
        total_purchases,
        total_revenue,
        CASE WHEN total_spend > 0 THEN total_revenue / NULLIF(total_spend, 0) END AS aggregate_roas
      FROM calibration_raw
    ),
    calibration AS (
      SELECT
        cv.as_of_date,
        COUNT(*) FILTER (
          WHERE cv.total_purchases >= 1
            AND cv.total_revenue > 0
            AND cv.total_spend > 0
        ) AS mature_creative_count,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY cv.total_spend)
          FILTER (WHERE cv.total_spend > 0) AS mature_spend_p50,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY cv.total_spend / NULLIF(cv.total_purchases, 0))
          FILTER (WHERE cv.total_purchases > 0) AS account_cpa_p50,
        COUNT(*) FILTER (WHERE cv.total_purchases > 0) AS account_cpa_sample_count,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY cv.total_purchases)
          FILTER (
            WHERE cv.total_purchases >= 1
              AND cv.total_revenue > 0
              AND cv.total_spend > 0
              AND $4::double precision IS NOT NULL
              AND cv.aggregate_roas >= $4::double precision
          ) AS winner_purchase_p50,
        percentile_cont(0.10) WITHIN GROUP (ORDER BY cv.aggregate_roas / NULLIF($4::double precision, 0))
          FILTER (
            WHERE cv.total_purchases >= 1
              AND cv.total_revenue > 0
              AND cv.total_spend > 0
              AND $4::double precision IS NOT NULL
          ) AS roas_ratio_p10,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY cv.aggregate_roas / NULLIF($4::double precision, 0))
          FILTER (
            WHERE cv.total_purchases >= 1
              AND cv.total_revenue > 0
              AND cv.total_spend > 0
              AND $4::double precision IS NOT NULL
          ) AS roas_ratio_p25
      FROM calibration_values cv
      GROUP BY cv.as_of_date
    ),
    meta_aov AS (
      SELECT
        days.as_of_date,
        CASE WHEN SUM(d.conversions) > 0 THEN SUM(d.revenue) / NULLIF(SUM(d.conversions), 0) END AS meta_aov_mean_90d,
        COALESCE(SUM(d.conversions), 0) AS meta_aov_purchase_count_90d,
        COALESCE(SUM(d.revenue), 0) AS meta_revenue_90d
      FROM days
      LEFT JOIN meta_creative_daily d
        ON d.business_id = $1::text
       AND ($5::text IS NULL OR d.provider_account_id = $5::text)
       AND d.date BETWEEN (days.as_of_date - INTERVAL '89 days') AND days.as_of_date
       AND d.objective = 'OUTCOME_SALES'
      GROUP BY days.as_of_date
    )
    SELECT
      m.as_of_date,
      m.creative_id,
      m.creative_name,
      m.campaign_id,
      m.effective_status,
      m.age_days,
      m.as_of_date_spend,
      m.spend_28d,
      m.purchases_28d,
      m.revenue_28d,
      CASE WHEN m.spend_28d > 0 THEN m.revenue_28d / NULLIF(m.spend_28d, 0) END AS roas_28d,
      m.recent_7d_spend,
      CASE WHEN m.recent_7d_spend > 0 THEN m.recent_7d_revenue / NULLIF(m.recent_7d_spend, 0) END AS recent_7d_roas,
      m.forward_14d_spend,
      m.forward_14d_revenue,
      CASE WHEN m.forward_14d_spend > 0 THEN m.forward_14d_revenue / NULLIF(m.forward_14d_spend, 0) END AS forward_14d_roas,
      m.forward_28d_spend,
      m.forward_28d_revenue,
      CASE WHEN m.forward_28d_spend > 0 THEN m.forward_28d_revenue / NULLIF(m.forward_28d_spend, 0) END AS forward_28d_roas,
      c.mature_creative_count,
      c.mature_spend_p50,
      c.account_cpa_p50,
      c.account_cpa_sample_count,
      c.winner_purchase_p50,
      c.roas_ratio_p10,
      c.roas_ratio_p25,
      a.meta_aov_mean_90d,
      a.meta_aov_purchase_count_90d,
      a.meta_revenue_90d
    FROM daily_metrics m
    LEFT JOIN calibration c ON c.as_of_date = m.as_of_date
    LEFT JOIN meta_aov a ON a.as_of_date = m.as_of_date
    WHERE m.spend_28d > 0
    ORDER BY m.as_of_date ASC, m.creative_id ASC
    `,
    [
      input.business.id,
      input.startDate,
      input.endDate,
      input.targetConfig.targetRoas,
      input.business.providerAccountId,
    ],
  );

  return rows.map((row): DailyCandidateRow => {
    const spend28 = toNumber(row.spend_28d);
    const recent7Spend = toNumber(row.recent_7d_spend);
    const forward14Spend = toNumber(row.forward_14d_spend);
    const forward28Spend = toNumber(row.forward_28d_spend);
    return {
      business: input.business,
      asOfDate: normalizePostgresDate(row.as_of_date) ?? input.startDate,
      creativeId: toText(row.creative_id) ?? "",
      creativeName: toText(row.creative_name),
      campaignId: toText(row.campaign_id),
      effectiveStatus: toText(row.effective_status),
      ageDays: toNullableNumber(row.age_days),
      asOfDateSpend: toNumber(row.as_of_date_spend),
      spend28,
      purchases28: toNumber(row.purchases_28d),
      revenue28: toNumber(row.revenue_28d),
      roas28: toNullableNumber(row.roas_28d),
      recent7Spend,
      recent7Roas: recent7Spend > 0 ? toNullableNumber(row.recent_7d_roas) : null,
      forward14Spend,
      forward14Revenue: toNumber(row.forward_14d_revenue),
      forward14Roas:
        forward14Spend > 0 ? toNullableNumber(row.forward_14d_roas) : null,
      forward28Spend,
      forward28Revenue: toNumber(row.forward_28d_revenue),
      forward28Roas:
        forward28Spend > 0 ? toNullableNumber(row.forward_28d_roas) : null,
      targetRoas: input.targetConfig.targetRoas,
      breakEvenRoas: input.targetConfig.breakEvenRoas,
      targetCpa: input.targetConfig.targetCpa,
      operatorAovAssumption: input.targetConfig.operatorAovAssumption,
      accountCpaP50: toNullableNumber(row.account_cpa_p50),
      accountCpaSampleCount: toNumber(row.account_cpa_sample_count),
      metaAovMean90d: toNullableNumber(row.meta_aov_mean_90d),
      metaAovPurchaseCount90d: toNumber(row.meta_aov_purchase_count_90d),
      metaRevenue90d: toNumber(row.meta_revenue_90d),
      matureCreativeCount: toNumber(row.mature_creative_count),
      matureSpendP50: toNullableNumber(row.mature_spend_p50),
      winnerPurchaseP50: toNullableNumber(row.winner_purchase_p50),
      roasRatioP10: toNullableNumber(row.roas_ratio_p10),
      roasRatioP25: toNullableNumber(row.roas_ratio_p25),
      preset: input.targetConfig.resolvedPreset,
      attributionAovAdjustmentMultiplier:
        input.targetConfig.attributionAovAdjustmentMultiplier,
    };
  });
}

function spendThreshold(spendUnit: number | null, multiplier: number) {
  return positiveFinite(spendUnit) ? spendUnit * multiplier : null;
}

function resolvePurchaseFloor(row: DailyCandidateRow, mode: PurchaseFloorMode) {
  if (mode === null) {
    return { floor: null, usedFallback: false };
  }
  if (mode === "fixed_2") return { floor: 2, usedFallback: false };
  if (mode === "fixed_3") return { floor: 3, usedFallback: false };
  if (mode === "fixed_5") return { floor: 5, usedFallback: false };
  if (positiveFinite(row.winnerPurchaseP50)) {
    return {
      floor: Math.max(2, Math.ceil(row.winnerPurchaseP50 * 0.5)),
      usedFallback: false,
    };
  }
  return { floor: 2, usedFallback: true };
}

function resolveBoundary(row: DailyCandidateRow, mode: BoundaryMode) {
  const current = positiveFinite(row.roasRatioP25) ? row.roasRatioP25 : 0.7;
  const upperClamped = Math.min(current, 1.0);
  const breakevenRatio =
    positiveFinite(row.breakEvenRoas) && positiveFinite(row.targetRoas)
      ? row.breakEvenRoas / row.targetRoas
      : null;
  if (mode === "current") {
    return { boundary: current, breakevenRatio, fallbackReason: null };
  }
  if (mode === "upper_1") {
    return { boundary: upperClamped, breakevenRatio, fallbackReason: null };
  }
  if (!positiveFinite(breakevenRatio)) {
    return {
      boundary: current,
      breakevenRatio,
      fallbackReason: "breakeven_or_target_missing_current_p25",
    };
  }
  return {
    boundary: Math.min(1.0, Math.max(upperClamped, breakevenRatio)),
    breakevenRatio,
    fallbackReason: null,
  };
}

function resolveThresholds(row: DailyCandidateRow, variant: VariantSpec): ThresholdContext {
  const multipliers = ENGINE_PRESET_MULTIPLIERS[row.preset];
  const lossBudgetMultiplier =
    variant.lossBudgetMultiplierOverride ?? multipliers.lossBudget;
  const spendUnit = resolveSpendUnit({
    targetCpa: row.targetCpa,
    operatorAovAssumption: row.operatorAovAssumption,
    metaAttributedAovMean90d: row.metaAovMean90d,
    metaAttributedAovPurchaseCount90d: Math.round(row.metaAovPurchaseCount90d),
    metaAttributedRevenue90d: row.metaRevenue90d,
    targetRoas: row.targetRoas,
    breakEvenRoas: row.breakEvenRoas,
    accountCpaP50: row.accountCpaP50,
    accountCpaSampleCount: Math.round(row.accountCpaSampleCount),
    attributionAovAdjustmentMultiplier: row.attributionAovAdjustmentMultiplier,
  });
  const recentSampleMinSpend = spendThreshold(
    spendUnit.spendUnit,
    multipliers.recentSample,
  );
  const configuredCommercial = spendThreshold(
    spendUnit.spendUnit,
    lossBudgetMultiplier,
  );
  const sustainedLoserSpend = spendThreshold(
    spendUnit.spendUnit,
    multipliers.sustainedLoser,
  );
  const commercialMaturitySpend = commercialMaturitySpendThreshold({
    recentSampleMinSpend,
    configuredCommercial,
    accountCpaP50: row.accountCpaP50,
    lossBudgetMultiplier,
    sustainedLoserSpend,
    matureSpendP50: row.matureSpendP50,
  });
  const { floor, usedFallback } = resolvePurchaseFloor(row, variant.purchaseFloor);
  const { boundary, breakevenRatio, fallbackReason } = resolveBoundary(
    row,
    variant.boundaryMode,
  );

  return {
    spendUnit: spendUnit.spendUnit,
    spendUnitSource: spendUnit.source,
    spendUnitConfidence: spendUnit.confidence,
    lossBudgetMultiplier,
    hardCutMultiplier: multipliers.hardCut,
    lossBudgetGeHardCut: lossBudgetMultiplier >= multipliers.hardCut,
    recentSampleMinSpend,
    zeroConvBurnerSpend: spendThreshold(
      spendUnit.spendUnit,
      multipliers.zeroConvBurner,
    ),
    commercialMaturitySpend,
    sustainedLoserSpend,
    hardCutSpend: spendThreshold(spendUnit.spendUnit, multipliers.hardCut),
    severeLoserRatio: row.roasRatioP10,
    boundary,
    purchaseFloor: floor,
    purchaseFloorUsedFallback: usedFallback,
    breakevenRatio,
    boundaryFallbackReason: fallbackReason,
  };
}

function commercialMaturitySpendThreshold(input: {
  recentSampleMinSpend: number | null;
  configuredCommercial: number | null;
  accountCpaP50: number | null;
  lossBudgetMultiplier: number;
  sustainedLoserSpend: number | null;
  matureSpendP50: number | null;
}) {
  const minSpendFloor = input.recentSampleMinSpend ?? 50;
  if (positiveFinite(input.configuredCommercial)) {
    return Math.max(minSpendFloor, input.configuredCommercial);
  }
  if (positiveFinite(input.accountCpaP50)) {
    return Math.max(minSpendFloor, input.accountCpaP50 * input.lossBudgetMultiplier);
  }
  if (positiveFinite(input.sustainedLoserSpend)) {
    return Math.max(minSpendFloor, input.sustainedLoserSpend);
  }
  return input.matureSpendP50 ?? input.recentSampleMinSpend ?? 300;
}

export function shouldHoldForRecentRecovery(input: {
  mode: RecentRecoveryMode;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  recent7Spend: number;
  recentSampleMinSpend: number | null;
  recent7Roas: number | null;
}) {
  if (
    !positiveFinite(input.recentSampleMinSpend) ||
    input.recent7Spend < input.recentSampleMinSpend ||
    !nonNegativeFinite(input.recent7Roas)
  ) {
    return false;
  }
  if (input.mode === "breakeven") {
    return (
      positiveFinite(input.breakEvenRoas) &&
      input.recent7Roas >= input.breakEvenRoas
    );
  }
  return (
    positiveFinite(input.targetRoas) && input.recent7Roas > input.targetRoas
  );
}

function hasRecentRecovery(
  row: DailyCandidateRow,
  thresholds: ThresholdContext,
  mode: RecentRecoveryMode,
) {
  return shouldHoldForRecentRecovery({
    mode,
    targetRoas: row.targetRoas,
    breakEvenRoas: row.breakEvenRoas,
    recent7Spend: row.recent7Spend,
    recentSampleMinSpend: thresholds.recentSampleMinSpend,
    recent7Roas: row.recent7Roas,
  });
}

function purchaseFloorAllowsCut(row: DailyCandidateRow, thresholds: ThresholdContext) {
  if (thresholds.purchaseFloor === null) return true;
  return (
    row.purchases28 >= thresholds.purchaseFloor ||
    (positiveFinite(thresholds.sustainedLoserSpend) &&
      row.spend28 >= thresholds.sustainedLoserSpend)
  );
}

export function evaluateCut(row: DailyCandidateRow, variant: VariantSpec): CutEvaluation {
  if (!positiveFinite(row.targetRoas) || !nonNegativeFinite(row.roas28)) {
    return {
      cuts: false,
      source: null,
      threshold: null,
      blockedReason: "target_or_roas_missing",
    };
  }
  const thresholds = resolveThresholds(row, variant);
  const ratio = row.roas28 / row.targetRoas;
  const confirmedInactive =
    row.effectiveStatus !== null && row.effectiveStatus !== "ACTIVE";
  const zeroConvThreshold =
    thresholds.zeroConvBurnerSpend === null
      ? thresholds.commercialMaturitySpend
      : Math.max(thresholds.zeroConvBurnerSpend, thresholds.commercialMaturitySpend);

  if (
    !confirmedInactive &&
    row.purchases28 === 0 &&
    row.spend28 >= zeroConvThreshold &&
    (row.ageDays ?? 0) >= ZERO_CONV_MIN_AGE_DAYS
  ) {
    return {
      cuts: true,
      source: "zero_conv_burner",
      threshold: thresholds,
      blockedReason: null,
    };
  }

  if (row.spend28 < thresholds.commercialMaturitySpend) {
    if (
      positiveFinite(thresholds.hardCutSpend) &&
      positiveFinite(thresholds.severeLoserRatio) &&
      row.spend28 >= thresholds.hardCutSpend &&
      ratio < thresholds.severeLoserRatio
    ) {
      return {
        cuts: true,
        source: "maturity_severe_loser",
        threshold: thresholds,
        blockedReason: null,
      };
    }

    return {
      cuts: false,
      source: null,
      threshold: thresholds,
      blockedReason: "below_commercial_maturity",
    };
  }

  const recoveryMode = variant.recentRecoveryMode ?? "target";
  if (recoveryMode === "breakeven" && !positiveFinite(row.breakEvenRoas)) {
    return {
      cuts: false,
      source: null,
      threshold: thresholds,
      blockedReason: "explicit_breakeven_missing",
    };
  }

  if (ratio >= thresholds.boundary) {
    return {
      cuts: false,
      source: null,
      threshold: thresholds,
      blockedReason: "not_in_cut_zone",
    };
  }

  if (hasRecentRecovery(row, thresholds, recoveryMode)) {
    return {
      cuts: false,
      source: null,
      threshold: thresholds,
      blockedReason: "recent_recovery_hold",
    };
  }

  let source: CutSource | null = null;
  if (positiveFinite(thresholds.hardCutSpend) && row.spend28 >= thresholds.hardCutSpend) {
    source = "ratio_hard_cut";
  } else if (
    positiveFinite(thresholds.sustainedLoserSpend) &&
    positiveFinite(thresholds.severeLoserRatio) &&
    row.spend28 >= thresholds.sustainedLoserSpend &&
    ratio < thresholds.severeLoserRatio
  ) {
    source = "ratio_sustained_loser";
  } else if (row.spend28 >= thresholds.commercialMaturitySpend) {
    source = "ratio_loss_budget";
  }

  if (source === null) {
    return {
      cuts: false,
      source: null,
      threshold: thresholds,
      blockedReason: "cut_ladder_not_reached",
    };
  }

  if (!purchaseFloorAllowsCut(row, thresholds)) {
    return {
      cuts: false,
      source: null,
      threshold: thresholds,
      blockedReason: "purchase_floor_not_met",
    };
  }

  return {
    cuts: true,
    source,
    threshold: thresholds,
    blockedReason: null,
  };
}

function isImmediateSafetyCut(source: CutSource | null) {
  return source === "zero_conv_burner" || source === "maturity_severe_loser";
}

export function resolvePublishedCutState(input: {
  confirmationMode: ConfirmationMode;
  currentDate: string;
  currentRawCuts: boolean;
  currentSource: CutSource | null;
  previousDate: string | null;
  previousRawCuts: boolean;
  previousPublishedCuts: boolean;
}) {
  if (!input.currentRawCuts) return { cuts: false, pending: false };
  if (
    input.confirmationMode === "none" ||
    isImmediateSafetyCut(input.currentSource)
  ) {
    return { cuts: true, pending: false };
  }
  const isNextCalendarDate =
    input.previousDate !== null &&
    diffDays(input.currentDate, input.previousDate) === 1;
  const confirmed =
    isNextCalendarDate &&
    (input.previousRawCuts || input.previousPublishedCuts);
  return { cuts: confirmed, pending: !confirmed };
}

function collectEpisodes(input: {
  rows: DailyCandidateRow[];
  variant: VariantSpec;
  reportStartDate?: string;
}) {
  const episodes: Episode[] = [];
  const dailyCutRows = new Map<string, CutEvaluation>();
  const rawDailySourceCounts: CountMap = {};
  let temporalPendingDailyRows = 0;
  const sortedRows = [...input.rows].sort((left, right) => {
    const dateCmp = left.asOfDate.localeCompare(right.asOfDate);
    return dateCmp || left.creativeId.localeCompare(right.creativeId);
  });
  const previousByCreative = new Map<
    string,
    {
      date: string | null;
      rawCuts: boolean;
      publishedCuts: boolean;
      lastEpisodeDate: string | null;
      hasSpendAfterLastEpisode: boolean;
    }
  >();

  for (const row of sortedRows) {
    const evaluation = evaluateCut(row, input.variant);
    const key = dailyKey(row);
    const previous =
      previousByCreative.get(row.creativeId) ?? {
        date: null,
        rawCuts: false,
        publishedCuts: false,
        lastEpisodeDate: null,
        hasSpendAfterLastEpisode: false,
      };
    if (
      previous.lastEpisodeDate !== null &&
      row.asOfDate > previous.lastEpisodeDate &&
      row.asOfDateSpend > 0
    ) {
      previous.hasSpendAfterLastEpisode = true;
    }
    const previousDayDiff =
      previous.date === null ? null : diffDays(row.asOfDate, previous.date);
    const published = resolvePublishedCutState({
      confirmationMode: input.variant.confirmationMode ?? "none",
      currentDate: row.asOfDate,
      currentRawCuts: evaluation.cuts,
      currentSource: evaluation.source,
      previousDate: previous.date,
      previousRawCuts: previous.rawCuts,
      previousPublishedCuts: previous.publishedCuts,
    });
    const inReportWindow =
      input.reportStartDate === undefined || row.asOfDate >= input.reportStartDate;
    if (inReportWindow) {
      if (evaluation.cuts) increment(rawDailySourceCounts, evaluation.source);
      if (published.pending) temporalPendingDailyRows += 1;
      dailyCutRows.set(key, {
        ...evaluation,
        cuts: published.cuts,
        blockedReason: published.pending
          ? "later_calendar_date_confirmation_pending"
          : evaluation.blockedReason,
      });
    }
    const startsCutRun =
      published.cuts &&
      (!previous.publishedCuts || previousDayDiff === null || previousDayDiff > 1);
    const hasFreshSpendSinceLastEpisode =
      previous.lastEpisodeDate === null || previous.hasSpendAfterLastEpisode;
    const startsEpisode =
      inReportWindow && startsCutRun && hasFreshSpendSinceLastEpisode;

    if (startsEpisode && evaluation.source && evaluation.threshold && row.targetRoas) {
      episodes.push({
        variantId: input.variant.id,
        business: row.business,
        asOfDate: row.asOfDate,
        creativeId: row.creativeId,
        creativeName: row.creativeName,
        campaignId: row.campaignId,
        source: evaluation.source,
        spend28: row.spend28,
        purchases28: row.purchases28,
        roas28: row.roas28,
        recent7Spend: row.recent7Spend,
        recent7Roas: row.recent7Roas,
        targetRoas: row.targetRoas,
        breakEvenRoas: row.breakEvenRoas,
        forward14Spend: row.forward14Spend,
        forward14Roas: row.forward14Roas,
        forward28Spend: row.forward28Spend,
        forward28Roas: row.forward28Roas,
        spendUnit: evaluation.threshold.spendUnit,
        lossBudgetMultiplier: evaluation.threshold.lossBudgetMultiplier,
        hardCutMultiplier: evaluation.threshold.hardCutMultiplier,
        boundary: evaluation.threshold.boundary,
        purchaseFloor: evaluation.threshold.purchaseFloor,
        purchaseFloorUsedFallback: evaluation.threshold.purchaseFloorUsedFallback,
        lossBudgetGeHardCut: evaluation.threshold.lossBudgetGeHardCut,
        boundaryFallbackReason: evaluation.threshold.boundaryFallbackReason,
      });
      previous.lastEpisodeDate = row.asOfDate;
      previous.hasSpendAfterLastEpisode = false;
    }

    previous.date = row.asOfDate;
    previous.rawCuts = evaluation.cuts;
    previous.publishedCuts = published.cuts;
    previousByCreative.set(row.creativeId, previous);
  }

  return {
    episodes,
    dailyCutRows,
    rawDailySourceCounts,
    temporalPendingDailyRows,
  };
}

function dailyKey(row: DailyCandidateRow) {
  return `${row.asOfDate}::${row.creativeId}`;
}

export function summarizeWindow(episodes: Episode[], windowDays: 14 | 28): WindowSummary {
  let knownEpisodes = 0;
  let unknownEpisodes = 0;
  let recoveredAboveTarget = 0;
  let trueLoserEpisodes = 0;
  let savedSpend = 0;
  let savedSpendUnits = 0;
  let savedSpendUnitsDenominator = 0;

  for (const episode of episodes) {
    const forwardSpend =
      windowDays === 14 ? episode.forward14Spend : episode.forward28Spend;
    const forwardRoas =
      windowDays === 14 ? episode.forward14Roas : episode.forward28Roas;
    if (!positiveFinite(forwardSpend) || forwardRoas === null || !Number.isFinite(forwardRoas)) {
      unknownEpisodes += 1;
      continue;
    }
    knownEpisodes += 1;
    if (forwardRoas >= episode.targetRoas) {
      recoveredAboveTarget += 1;
    }

    const loserFloor = positiveFinite(episode.breakEvenRoas)
      ? episode.breakEvenRoas
      : episode.targetRoas;
    if (forwardRoas < loserFloor) {
      trueLoserEpisodes += 1;
      savedSpend += forwardSpend;
      if (positiveFinite(episode.spendUnit)) {
        savedSpendUnits += forwardSpend / episode.spendUnit;
        savedSpendUnitsDenominator += 1;
      }
    }
  }

  return {
    knownEpisodes,
    unknownEpisodes,
    recoveredAboveTarget,
    earlyCutRate:
      knownEpisodes > 0 ? rounded(recoveredAboveTarget / knownEpisodes) : null,
    trueLoserEpisodes,
    savedSpend: rounded(savedSpend, 2) ?? 0,
    savedSpendUnits:
      savedSpendUnitsDenominator > 0 ? rounded(savedSpendUnits, 2) : null,
  };
}

function summarizeVariant(input: {
  business: BusinessIdentity;
  variant: VariantSpec;
  episodes: Episode[];
  baselineEpisodes: Episode[];
  dailyCutRows: Map<string, CutEvaluation>;
  baselineDailyCutRows: Map<string, CutEvaluation>;
  rawDailySourceCounts: CountMap;
  temporalPendingDailyRows: number;
}) {
  const sourceCounts: CountMap = {};
  let purchaseFloorFallbackEpisodes = 0;
  let lossBudgetGeHardCutEpisodes = 0;
  let boundaryFallbackEpisodes = 0;
  for (const episode of input.episodes) {
    increment(sourceCounts, episode.source);
    if (episode.purchaseFloorUsedFallback) purchaseFloorFallbackEpisodes += 1;
    if (episode.lossBudgetGeHardCut) lossBudgetGeHardCutEpisodes += 1;
    if (episode.boundaryFallbackReason) boundaryFallbackEpisodes += 1;
  }

  const affectedDailyRowsVsBaseline = countAffectedDailyRows(
    input.dailyCutRows,
    input.baselineDailyCutRows,
  );
  const flipRateVsBaseline = ratio(
    affectedDailyRowsVsBaseline,
    input.baselineDailyCutRows.size,
  );
  const baselineMatch = summarizeBaselineMatch({
    variantEpisodes: input.episodes,
    baselineEpisodes: input.baselineEpisodes,
  });

  return {
    variantId: input.variant.id,
    business: input.business,
    episodes: input.episodes.length,
    defensible: input.episodes.length >= MIN_DEFENSIBLE_EPISODES,
    dailyCutRows: Array.from(input.dailyCutRows.values()).filter(
      (evaluation) => evaluation.cuts,
    ).length,
    affectedDailyRowsVsBaseline,
    flipRateVsBaseline,
    baselineEpisodesMatched: baselineMatch.matched,
    baselineEpisodesSuppressed: baselineMatch.suppressed,
    additionalEpisodesVsBaseline: baselineMatch.additional,
    medianDelayDaysVsBaseline: median(baselineMatch.delays),
    sourceCounts,
    purchaseFloorFallbackEpisodes,
    lossBudgetGeHardCutEpisodes,
    boundaryFallbackEpisodes,
    temporalPendingDailyRows: input.temporalPendingDailyRows,
    rawDailySourceCounts: input.rawDailySourceCounts,
    window14: summarizeWindow(input.episodes, 14),
    window28: summarizeWindow(input.episodes, 28),
  } satisfies VariantBusinessSummary;
}

function countAffectedDailyRows(
  variantRows: Map<string, CutEvaluation>,
  baselineRows: Map<string, CutEvaluation>,
) {
  let affected = 0;
  for (const [key, evaluation] of variantRows) {
    const baseline = baselineRows.get(key);
    if ((baseline?.cuts ?? false) !== evaluation.cuts) {
      affected += 1;
    }
  }
  return affected;
}

function summarizeBaselineMatch(input: {
  variantEpisodes: Episode[];
  baselineEpisodes: Episode[];
}) {
  const variantByCreative = new Map<string, Episode[]>();
  for (const episode of input.variantEpisodes) {
    const existing = variantByCreative.get(episode.creativeId) ?? [];
    existing.push(episode);
    variantByCreative.set(episode.creativeId, existing);
  }
  for (const episodes of variantByCreative.values()) {
    episodes.sort((left, right) => left.asOfDate.localeCompare(right.asOfDate));
  }

  const usedVariantKeys = new Set<string>();
  const delays: number[] = [];
  let matched = 0;
  for (const baseline of input.baselineEpisodes) {
    const candidates = variantByCreative.get(baseline.creativeId) ?? [];
    const match = candidates.find((episode) => {
      const key = episodeKey(episode);
      return !usedVariantKeys.has(key) && episode.asOfDate >= baseline.asOfDate;
    });
    if (!match) continue;
    const delay = diffDays(match.asOfDate, baseline.asOfDate);
    if (delay !== null) delays.push(delay);
    usedVariantKeys.add(episodeKey(match));
    matched += 1;
  }

  return {
    matched,
    suppressed: input.baselineEpisodes.length - matched,
    additional: input.variantEpisodes.length - usedVariantKeys.size,
    delays,
  };
}

function episodeKey(episode: Episode) {
  return `${episode.variantId}::${episode.business.id}::${episode.creativeId}::${episode.asOfDate}`;
}

function summarizePooled(reviews: BusinessReview[]): PooledSummary[] {
  return VARIANTS.map((variant) => {
    const summaries = reviews.flatMap((review) =>
      review.variants.filter((summary) => summary.variantId === variant.id),
    );
    const denominatorRows = reviews
      .filter((review) =>
        review.variants.some((summary) => summary.variantId === variant.id),
      )
      .reduce((sum, review) => sum + review.rowsEvaluated, 0);
    const episodes = summaries.reduce((sum, summary) => sum + summary.episodes, 0);
    const affectedDailyRowsVsBaseline = summaries.reduce(
      (sum, summary) => sum + summary.affectedDailyRowsVsBaseline,
      0,
    );
    const delayValues = summaries.flatMap((summary) =>
      summary.medianDelayDaysVsBaseline === null
        ? []
        : [summary.medianDelayDaysVsBaseline],
    );

    return {
      variantId: variant.id,
      episodes,
      defensible: episodes >= MIN_DEFENSIBLE_EPISODES,
      affectedDailyRowsVsBaseline,
      flipRateVsBaseline: ratio(affectedDailyRowsVsBaseline, denominatorRows),
      medianDelayDaysVsBaseline: median(delayValues),
      window14: poolWindows(summaries.map((summary) => summary.window14)),
      window28: poolWindows(summaries.map((summary) => summary.window28)),
    };
  });
}

function poolWindows(windows: WindowSummary[]): WindowSummary {
  const knownEpisodes = windows.reduce((sum, item) => sum + item.knownEpisodes, 0);
  const unknownEpisodes = windows.reduce((sum, item) => sum + item.unknownEpisodes, 0);
  const recoveredAboveTarget = windows.reduce(
    (sum, item) => sum + item.recoveredAboveTarget,
    0,
  );
  const trueLoserEpisodes = windows.reduce(
    (sum, item) => sum + item.trueLoserEpisodes,
    0,
  );
  const savedSpendUnitsValues = windows.flatMap((item) =>
    item.savedSpendUnits === null ? [] : [item.savedSpendUnits],
  );

  return {
    knownEpisodes,
    unknownEpisodes,
    recoveredAboveTarget,
    earlyCutRate:
      knownEpisodes > 0 ? rounded(recoveredAboveTarget / knownEpisodes) : null,
    trueLoserEpisodes,
    savedSpend: null,
    savedSpendUnits:
      savedSpendUnitsValues.length > 0
        ? rounded(savedSpendUnitsValues.reduce((sum, value) => sum + value, 0), 2)
        : null,
  };
}

async function reviewBusiness(input: {
  business: BusinessIdentity;
  args: ParsedArgs;
}): Promise<BusinessReview> {
  const sourceStats = await readSourceStats(input.business);
  const targetConfig = await readTargetConfig(input.business.id);
  if (!sourceStats.latestDataDate || !sourceStats.earliestDataDate) {
    return {
      business: input.business,
      status: "skipped",
      sourceStats,
      targetConfig,
      evaluatedWindow: {
        startDate: null,
        endDate: null,
        lookbackDays: input.args.lookbackDays,
        forwardWindowDays: input.args.primaryForwardWindowDays,
      },
      rowsEvaluated: 0,
      candidateRowsWithTarget: 0,
      variants: [],
      samples: [],
      focusedCreatives: [],
      errorMessage: "no_meta_creative_daily_rows",
    };
  }
  if (!positiveFinite(targetConfig.targetRoas)) {
    return {
      business: input.business,
      status: "skipped",
      sourceStats,
      targetConfig,
      evaluatedWindow: {
        startDate: null,
        endDate: null,
        lookbackDays: input.args.lookbackDays,
        forwardWindowDays: input.args.primaryForwardWindowDays,
      },
      rowsEvaluated: 0,
      candidateRowsWithTarget: 0,
      variants: [],
      samples: [],
      focusedCreatives: [],
      errorMessage: "target_roas_missing",
    };
  }

  const latestEligibleDate = addDays(
    minDate(input.args.asOf, sourceStats.latestDataDate),
    -input.args.primaryForwardWindowDays,
  );
  const earliestPossibleStart = addDays(sourceStats.earliestDataDate, 117);
  const requestedStart = addDays(latestEligibleDate, -(input.args.lookbackDays - 1));
  const requestedOrExplicitStart = input.args.startDate ?? requestedStart;
  const requestedOrExplicitEnd = input.args.endDate ?? latestEligibleDate;
  const startDate = maxDate(earliestPossibleStart, requestedOrExplicitStart);
  const endDate = minDate(requestedOrExplicitEnd, latestEligibleDate);
  if (startDate > endDate) {
    return {
      business: input.business,
      status: "skipped",
      sourceStats,
      targetConfig,
      evaluatedWindow: {
        startDate,
        endDate,
        lookbackDays: input.args.lookbackDays,
        forwardWindowDays: input.args.primaryForwardWindowDays,
      },
      rowsEvaluated: 0,
      candidateRowsWithTarget: 0,
      variants: [],
      samples: [],
      focusedCreatives: [],
      errorMessage: "insufficient_history_for_90d_calibration_and_28d_forward_window",
    };
  }

  const rows = await readDailyCandidateRows({
    business: input.business,
    targetConfig,
    // Two warm-up dates reconstruct both pending and already-confirmed V2d
    // state at the report boundary without counting a pre-window episode.
    startDate: addDays(startDate, -2),
    endDate,
  });
  const reportRows = rows.filter((row) => row.asOfDate >= startDate);
  const candidateRowsWithTarget = reportRows.filter((row) =>
    positiveFinite(row.targetRoas),
  ).length;
  const collections = new Map<
    string,
    {
      episodes: Episode[];
      dailyCutRows: Map<string, CutEvaluation>;
      rawDailySourceCounts: CountMap;
      temporalPendingDailyRows: number;
    }
  >();

  for (const variant of VARIANTS) {
    collections.set(
      variant.id,
      collectEpisodes({
        rows,
        variant,
        reportStartDate: startDate,
      }),
    );
  }

  const baseline = collections.get("V0_current");
  if (!baseline) {
    throw new Error("baseline variant missing");
  }

  const summaries = VARIANTS.map((variant) => {
    const collection = collections.get(variant.id);
    if (!collection) throw new Error(`variant collection missing: ${variant.id}`);
    return summarizeVariant({
      business: input.business,
      variant,
      episodes: collection.episodes,
      baselineEpisodes: baseline.episodes,
      dailyCutRows: collection.dailyCutRows,
      baselineDailyCutRows: baseline.dailyCutRows,
      rawDailySourceCounts: collection.rawDailySourceCounts,
      temporalPendingDailyRows: collection.temporalPendingDailyRows,
    });
  });

  const samples = [...baseline.episodes]
    .sort((left, right) => right.spend28 - left.spend28)
    .slice(0, input.args.sampleSize);
  const focusedCreatives = input.args.focusCreativeIds.flatMap((creativeId) => {
    const creativeName = [...reportRows]
      .reverse()
      .find((row) => row.creativeId === creativeId)?.creativeName ?? null;
    return FOCUSED_VARIANT_IDS.flatMap((variantId) => {
      const collection = collections.get(variantId);
      if (!collection) return [];
      const evaluations = [...collection.dailyCutRows.entries()]
        .filter(([key]) => key.endsWith(`::${creativeId}`))
        .sort(([left], [right]) => left.localeCompare(right));
      if (evaluations.length === 0) return [];
      const publishedDates = evaluations.flatMap(([key, evaluation]) =>
        evaluation.cuts ? [key.slice(0, 10)] : [],
      );
      const episodes = collection.episodes.filter(
        (episode) => episode.creativeId === creativeId,
      );
      const countReason = (reason: string) =>
        evaluations.filter(([, evaluation]) => evaluation.blockedReason === reason)
          .length;
      const pendingConfirmationDays = countReason(
        "later_calendar_date_confirmation_pending",
      );
      return [
        {
          creativeId,
          creativeName,
          variantId,
          dailyRows: evaluations.length,
          rawCutDays:
            evaluations.filter(([, evaluation]) => evaluation.cuts).length +
            pendingConfirmationDays,
          publishedCutDays: publishedDates.length,
          pendingConfirmationDays,
          recentRecoveryHoldDays: countReason("recent_recovery_hold"),
          notInCutZoneDays: countReason("not_in_cut_zone"),
          belowCommercialMaturityDays: countReason("below_commercial_maturity"),
          firstPublishedCutDate: publishedDates[0] ?? null,
          lastPublishedCutDate: publishedDates.at(-1) ?? null,
          episodes: episodes.length,
          window14: summarizeWindow(episodes, 14),
          window28: summarizeWindow(episodes, 28),
        } satisfies FocusedCreativeReview,
      ];
    });
  });

  return {
    business: input.business,
    status: "ok",
    sourceStats,
    targetConfig,
    evaluatedWindow: {
      startDate,
      endDate,
      lookbackDays: input.args.lookbackDays,
      forwardWindowDays: input.args.primaryForwardWindowDays,
    },
    rowsEvaluated: reportRows.length,
    candidateRowsWithTarget,
    variants: summaries,
    samples,
    focusedCreatives,
  };
}

function primaryWindow(
  summary: Pick<VariantBusinessSummary | PooledSummary, "window14" | "window28">,
  windowDays: 14 | 28,
) {
  return windowDays === 14 ? summary.window14 : summary.window28;
}

function buildRecommendation(report: Omit<SweepReport, "recommendation">): SweepReport["recommendation"] {
  const accountLevelSignals = buildAccountLevelSignals(report);
  const baseline = report.pooled.find((summary) => summary.variantId === "V0_current");
  const combo = report.pooled.find(
    (summary) => summary.variantId === "V3_recommended_combo",
  );
  if (!baseline || !combo || !baseline.defensible || !combo.defensible) {
    return {
      status: "insufficient_evidence",
      text:
        "No parameter change should be proposed yet: baseline or combined-variant episode count is below the defensible threshold.",
      accountLevelSignals,
    };
  }
  const baselineEarly = primaryWindow(
    baseline,
    report.methodology.primaryForwardWindowDays,
  ).earlyCutRate;
  const comboEarly = primaryWindow(
    combo,
    report.methodology.primaryForwardWindowDays,
  ).earlyCutRate;
  if (baselineEarly === null || comboEarly === null) {
    return {
      status: "insufficient_evidence",
      text:
        `No parameter change should be proposed yet: forward ${report.methodology.primaryForwardWindowDays}d outcome coverage is insufficient.`,
      accountLevelSignals,
    };
  }
  if (comboEarly + 0.05 < baselineEarly) {
    return {
      status: "candidate_available",
      text:
        "The combined F1/F2 variant is a candidate for a separate formula phase, subject to user approval, new golden cases, and an ENGINE_VERSION bump.",
      accountLevelSignals,
    };
  }
  return {
    status: "no_uniform_change_supported",
    text:
      "A uniform/global threshold change is not supported yet. The useful signal is account-level heterogeneity; re-test after current-version accrual before proposing per-account parameters.",
    accountLevelSignals,
  };
}

function buildAccountLevelSignals(report: Omit<SweepReport, "recommendation">) {
  const signals: string[] = [];
  const windowDays = report.methodology.primaryForwardWindowDays;
  const iwaBaseline = findBusinessVariant(report, "IwaStore", "V0_current");
  const iwaWindow = iwaBaseline ? primaryWindow(iwaBaseline, windowDays) : null;
  if (iwaWindow?.earlyCutRate !== null && iwaWindow !== null) {
    signals.push(
      `IwaStore V0 ${windowDays}d early-cut rate is ${formatPercent(
        iwaWindow.earlyCutRate,
      )}; this is an account-level alarm, not a global-rule proof.`,
    );
  }

  const grandmixBaseline = findBusinessVariant(report, "Grandmix", "V0_current");
  const grandmixHalfWinner = findBusinessVariant(
    report,
    "Grandmix",
    "V1d_purchase_floor_half_winner",
  );
  const grandmixBaselineWindow = grandmixBaseline
    ? primaryWindow(grandmixBaseline, windowDays)
    : null;
  const grandmixHalfWinnerWindow = grandmixHalfWinner
    ? primaryWindow(grandmixHalfWinner, windowDays)
    : null;
  if (
    grandmixBaselineWindow?.earlyCutRate !== null &&
    grandmixHalfWinnerWindow?.earlyCutRate !== null &&
    grandmixBaselineWindow !== null &&
    grandmixHalfWinnerWindow !== null
  ) {
    signals.push(
      `Grandmix V1d moves ${windowDays}d early-cut rate ${formatPercent(
        grandmixBaselineWindow.earlyCutRate,
      )} -> ${formatPercent(grandmixHalfWinnerWindow.earlyCutRate)} (${formatPointDelta(
        grandmixHalfWinnerWindow.earlyCutRate -
          grandmixBaselineWindow.earlyCutRate,
      )}).`,
    );
  }

  const swafBaseline = findBusinessVariant(report, "TheSwaf", "V0_current");
  const swafBreakeven = findBusinessVariant(report, "TheSwaf", "V2b_p25_breakeven_floor");
  const swafBaselineWindow = swafBaseline
    ? primaryWindow(swafBaseline, windowDays)
    : null;
  const swafBreakevenWindow = swafBreakeven
    ? primaryWindow(swafBreakeven, windowDays)
    : null;
  if (
    swafBaselineWindow?.savedSpendUnits !== null &&
    swafBreakevenWindow?.savedSpendUnits !== null &&
    swafBaselineWindow !== null &&
    swafBreakevenWindow !== null
  ) {
    const ratio =
      positiveFinite(swafBaselineWindow.savedSpendUnits) &&
      positiveFinite(swafBreakevenWindow.savedSpendUnits)
        ? swafBreakevenWindow.savedSpendUnits /
          swafBaselineWindow.savedSpendUnits
        : null;
    signals.push(
      `TheSwaf V2b saved spend units ${formatNumber(
        swafBaselineWindow.savedSpendUnits,
      )} -> ${formatNumber(swafBreakevenWindow.savedSpendUnits)}${
        ratio === null ? "" : ` (${ratio.toFixed(1)}x)`
      } while ${windowDays}d early-cut rate remains ${formatPercent(
        swafBreakevenWindow.earlyCutRate,
      )}.`,
    );
  }

  const upperClamp = report.pooled.find(
    (summary) => summary.variantId === "V2a_p25_upper_clamp_1",
  );
  if (upperClamp) {
    signals.push(
      `V2a upper-clamp-only effect is scarce in this replay: ${upperClamp.affectedDailyRowsVsBaseline} affected daily rows vs V0.`,
    );
  }
  signals.push(...buildLossBudgetAccountSignals(report));

  return signals;
}

function buildLossBudgetAccountSignals(report: Omit<SweepReport, "recommendation">) {
  const signals: string[] = [];
  const windowDays = report.methodology.primaryForwardWindowDays;
  for (const review of report.reviews) {
    if (review.status !== "ok") continue;
    const baseline = review.variants.find(
      (summary) => summary.variantId === "V0_current",
    );
    if (!baseline) continue;
    const baselineWindow = primaryWindow(baseline, windowDays);
    const candidates = review.variants
      .filter((summary) => LOSS_BUDGET_VARIANT_IDS.includes(summary.variantId))
      .filter((summary) => primaryWindow(summary, windowDays).savedSpendUnits !== null);
    if (candidates.length === 0) continue;
    const bestSavedSpend = [...candidates].sort((left, right) => {
      const leftWindow = primaryWindow(left, windowDays);
      const rightWindow = primaryWindow(right, windowDays);
      const savedDelta =
        (rightWindow.savedSpendUnits ?? -Infinity) -
        (leftWindow.savedSpendUnits ?? -Infinity);
      if (savedDelta !== 0) return savedDelta;
      return (
        (leftWindow.earlyCutRate ?? Infinity) -
        (rightWindow.earlyCutRate ?? Infinity)
      );
    })[0];
    const bestWindow = primaryWindow(bestSavedSpend, windowDays);
    const variant = VARIANTS.find((item) => item.id === bestSavedSpend.variantId);
    const savedDelta =
      bestWindow.savedSpendUnits !== null && baselineWindow.savedSpendUnits !== null
        ? rounded(bestWindow.savedSpendUnits - baselineWindow.savedSpendUnits, 2)
        : null;
    const earlyDelta =
      bestWindow.earlyCutRate !== null && baselineWindow.earlyCutRate !== null
        ? rounded(bestWindow.earlyCutRate - baselineWindow.earlyCutRate, 4)
        : null;
    signals.push(
      `${review.business.name} lossBudget sweep best saved-spend variant is ${
        bestSavedSpend.variantId
      } (lossBudget=${formatNumber(variant?.lossBudgetMultiplierOverride ?? null)}): saved units ${formatNumber(
        baselineWindow.savedSpendUnits,
      )} -> ${formatNumber(bestWindow.savedSpendUnits)}${
        savedDelta === null ? "" : ` (${savedDelta >= 0 ? "+" : ""}${savedDelta})`
      }, ${windowDays}d early-cut ${formatPercent(
        baselineWindow.earlyCutRate,
      )} -> ${formatPercent(bestWindow.earlyCutRate)}${
        earlyDelta === null ? "" : ` (${formatPointDelta(earlyDelta)})`
      }, defensible=${bestSavedSpend.defensible ? "yes" : "no"}, flip=${formatPercent(
        bestSavedSpend.flipRateVsBaseline,
      )}.`,
    );
  }
  return signals;
}

function findBusinessVariant(
  report: Omit<SweepReport, "recommendation">,
  businessName: string,
  variantId: string,
) {
  const review = report.reviews.find((item) => item.business.name === businessName);
  return review?.variants.find((summary) => summary.variantId === variantId);
}

function formatPointDelta(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

function buildReport(input: {
  args: ParsedArgs;
  businessesFound: number;
  reviews: BusinessReview[];
}): SweepReport {
  const base = {
    contractVersion: F1_F2_SWEEP_CONTRACT_VERSION,
    revision: F1_F2_SWEEP_CONTRACT_REVISION,
    revisionNotes: [
      "Finite zero-ROAS outcomes with positive forward spend are known loser outcomes, not unknown censoring.",
      "Finite zero current ROAS is also known evidence, so the zero-conversion and severe-loss branches are no longer accidentally skipped by a positive-only preflight.",
      "Default business scope is pinned to the four requested physical Meta accounts; TheSwaf Main no longer co-mingles another TheSwaf account.",
      "Adds V2c break-even recovery hold and V2d later-calendar-date ratio-cut confirmation while preserving immediate zero-conversion and maturity-severe safety semantics.",
      "The complete four-window suite runs inside one repeatable-read read-only transaction with a 30-second statement timeout and always rolls back.",
      "Episode dedup now requires at least one post-trigger daily spend > 0 before the same creative can open a new cut episode.",
      "Evidence limits now describe attribution lag in both directions.",
      "Recommendation is reframed from no-change-supported to no-uniform-change-supported with account-level signals.",
      "Adds 3.1 lossBudgetMultiplier absolute-override variants from 1.0 to 4.0; these are univariate shadow-only sensitivity rows and do not imply production adoption.",
    ],
    lineage: {
      gitSha: currentGitSha(),
      scriptContractRevision: F1_F2_SWEEP_CONTRACT_REVISION,
    },
    generatedAt: new Date().toISOString(),
    readOnly: true as const,
    mutatesData: false as const,
    asOf: input.args.asOf,
    title: input.args.reportTitle,
    engineVersion: ENGINE_VERSION,
    methodology: {
      unitOfAnalysis:
        "cut episode, not daily row; after one creative opens an episode, another episode requires a new cut run plus at least one post-trigger daily spend > 0",
      lookaheadBiasStatus:
        "trailing 90d calibration percentiles are recomputed for each replay day from data available on or before that day",
      targetHistoryAssumption:
        "this legacy sweep reads the latest business_target_packs row and does not consume point-in-time target history; historical target ROAS and breakeven ROAS are therefore assumed fixed",
      guardrailScope:
        "formula-level threshold sweep; campaign-label guard, provider writes, DB writes, migrations, and resolver threshold changes are not applied",
      nonMutationStatement:
        "This report only reads meta_creative_daily, businesses, target/config/flag tables inside a repeatable-read read-only transaction that terminates with ROLLBACK, then writes local JSON/MD artifacts.",
      queryCostBound: `per-business generated daily replay bounded to ${
        input.args.startDate && input.args.endDate
          ? `${input.args.startDate}..${input.args.endDate}`
          : `${input.args.lookbackDays} lookback days`
      }, 90d trailing calibration, and ${input.args.primaryForwardWindowDays}d primary forward windows`,
      primaryForwardWindowDays: input.args.primaryForwardWindowDays,
      defensibleEpisodeThreshold: MIN_DEFENSIBLE_EPISODES,
    },
    variants: VARIANTS,
    businessesRequested: input.args.businessIdentifiers,
    businessesFound: input.businessesFound,
    reviews: input.reviews,
    pooled: summarizePooled(input.reviews),
    evidenceLimits: [
      "Survivorship: history contains creatives operators did not already kill, so observed early-cut rate is a lower bound.",
      "Attribution lag can move in both directions: delayed conversions may make forward ROAS look too low, while conversions caused by pre-cut spend may make post-cut recovery look too high.",
      "This legacy sweep does not consume point-in-time target history; the latest target and break-even values are held constant across the replay.",
      "Default comparisons are bound to one exact provider account per business; custom non-default businesses without an exact binding are not promotion evidence.",
      "Historical rows are creative-grain rather than immutable exact-Ad decision inputs; multi-Ad creative reuse can blur identity.",
      "The sweep uses raw forward ROAS and does not depend on v1/v2 outcome classifiers.",
      "Pooled saved-spend uses spendUnit-normalized units; raw currency is not pooled across businesses.",
      "LossBudgetMultiplier rows are univariate shadow sensitivity tests: purchase floor and boundary mode stay at current behavior unless the variant label says otherwise.",
      "This report does not change thresholds; any parameter adoption requires user approval, new golden cases, and an ENGINE_VERSION bump.",
    ],
  };
  return {
    ...base,
    recommendation: buildRecommendation(base),
  };
}

function currentGitSha() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Unable to derive a valid current git SHA for artifact lineage.");
  }
  return sha;
}

function tradeoffText(
  summary: Pick<VariantBusinessSummary | PooledSummary, "window14" | "window28">,
  baseline: Pick<VariantBusinessSummary | PooledSummary, "window14" | "window28"> | null,
  windowDays: 14 | 28,
) {
  if (!baseline) return "n/a";
  const summaryWindow = primaryWindow(summary, windowDays);
  const baselineWindow = primaryWindow(baseline, windowDays);
  const savedDelta =
    summaryWindow.savedSpendUnits !== null && baselineWindow.savedSpendUnits !== null
      ? rounded(summaryWindow.savedSpendUnits - baselineWindow.savedSpendUnits, 2)
      : null;
  const earlyDelta =
    summaryWindow.earlyCutRate !== null && baselineWindow.earlyCutRate !== null
      ? rounded(summaryWindow.earlyCutRate - baselineWindow.earlyCutRate, 4)
      : null;
  if (savedDelta === null && earlyDelta === null) return "n/a";
  const savedText =
    savedDelta === null ? "saved n/a" : `${savedDelta >= 0 ? "+" : ""}${savedDelta} units`;
  const earlyText =
    earlyDelta === null
      ? "early n/a"
      : `${earlyDelta >= 0 ? "+" : ""}${(earlyDelta * 100).toFixed(1)} pp early`;
  return `${savedText}; ${earlyText}`;
}

function renderMarkdown(report: SweepReport) {
  const lines: string[] = [];
  const windowDays = report.methodology.primaryForwardWindowDays;
  lines.push(`# ${report.title}`);
  lines.push("");
  lines.push(
    "This is a read-only parameter-evaluation report. It does not change resolver thresholds, formulas, database state, provider state, migrations, or operator behavior.",
  );
  lines.push("");
  lines.push("## Live Status");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- asOf: ${report.asOf}`);
  lines.push(`- engineVersion: ${report.engineVersion}`);
  lines.push(`- revision: ${report.revision}`);
  lines.push(`- gitSha: ${report.lineage.gitSha}`);
  lines.push(`- scriptContractRevision: ${report.lineage.scriptContractRevision}`);
  lines.push("- source: live_db_read_only");
  lines.push(
    "- tables: meta_creative_daily, businesses, business_target_packs, business_decision_calibration_profiles, business_engine_v3_flags",
  );
  lines.push("");
  lines.push("## Revision Notes");
  lines.push("");
  for (const note of report.revisionNotes) {
    lines.push(`- ${note}`);
  }
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(`- Unit: ${report.methodology.unitOfAnalysis}`);
  lines.push(`- Lookahead bias: ${report.methodology.lookaheadBiasStatus}`);
  lines.push(`- Target history: ${report.methodology.targetHistoryAssumption}`);
  lines.push(`- Scope: ${report.methodology.guardrailScope}`);
  lines.push(`- Query bound: ${report.methodology.queryCostBound}`);
  lines.push(`- Primary forward window: ${windowDays}d`);
  lines.push(`- Defensible threshold: n >= ${report.methodology.defensibleEpisodeThreshold} episodes`);
  lines.push("");
  lines.push("## Variants");
  lines.push("");
  lines.push("| Variant | Meaning |");
  lines.push("| --- | --- |");
  for (const variant of report.variants) {
    lines.push(`| ${variant.id} | ${variant.label} |`);
  }
  lines.push("");
  lines.push("## Pooled View");
  lines.push("");
  lines.push(
    `| Variant | Episodes | Defensible | Affected rows vs V0 | Flip rate vs V0 | ${windowDays}d early-cut rate | ${windowDays}d true-loser episodes | Saved spend units | Trade-off vs V0 | Median delay vs V0 |`,
  );
  lines.push("| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
  const pooledBaseline =
    report.pooled.find((summary) => summary.variantId === "V0_current") ?? null;
  for (const summary of report.pooled) {
    const window = primaryWindow(summary, windowDays);
    lines.push(
      [
        `| ${summary.variantId}`,
        summary.episodes,
        summary.defensible ? "yes" : "no",
        summary.affectedDailyRowsVsBaseline,
        formatPercent(summary.flipRateVsBaseline),
        formatPercent(window.earlyCutRate),
        window.trueLoserEpisodes,
        formatNumber(window.savedSpendUnits),
        tradeoffText(summary, pooledBaseline, windowDays),
        formatNumber(summary.medianDelayDaysVsBaseline),
      ].join(" | ") + " |",
    );
  }
  lines.push("");
  lines.push("## Business Detail");
  for (const review of report.reviews) {
    lines.push("");
    lines.push(`### ${review.business.name}`);
    lines.push("");
    if (review.status !== "ok") {
      lines.push(`Status: ${review.status}; reason: ${review.errorMessage ?? "unknown"}`);
      continue;
    }
    lines.push(
      `Window: ${review.evaluatedWindow.startDate} to ${review.evaluatedWindow.endDate}; rows evaluated: ${review.rowsEvaluated}; target ROAS: ${formatNumber(review.targetConfig?.targetRoas)}`,
    );
    lines.push(
      `Preset: ${review.targetConfig?.resolvedPreset ?? "unknown"}; break-even ROAS: ${formatNumber(review.targetConfig?.breakEvenRoas)}; source rows: ${review.sourceStats?.sourceRows ?? 0}`,
    );
    lines.push("");
    lines.push(
      `| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | ${windowDays}d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |`,
    );
    lines.push("| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |");
    const baseline =
      review.variants.find((summary) => summary.variantId === "V0_current") ??
      null;
    for (const summary of review.variants) {
      const window = primaryWindow(summary, windowDays);
      const safetyFlags = [
        summary.lossBudgetGeHardCutEpisodes > 0
          ? `lossBudget>=hardCut:${summary.lossBudgetGeHardCutEpisodes}`
          : null,
        summary.boundaryFallbackEpisodes > 0
          ? `boundaryFallback:${summary.boundaryFallbackEpisodes}`
          : null,
        summary.purchaseFloorFallbackEpisodes > 0
          ? `purchaseFloorFallback:${summary.purchaseFloorFallbackEpisodes}`
          : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        [
          `| ${summary.variantId}`,
          summary.episodes,
          summary.defensible ? "yes" : "no",
          summary.dailyCutRows,
          summary.affectedDailyRowsVsBaseline,
          formatPercent(summary.flipRateVsBaseline),
          formatPercent(window.earlyCutRate),
          formatNumber(window.savedSpend),
          formatNumber(window.savedSpendUnits),
          tradeoffText(summary, baseline, windowDays),
          formatNumber(summary.medianDelayDaysVsBaseline),
          formatCounts(summary.sourceCounts),
          safetyFlags || "none",
        ].join(" | ") + " |",
      );
    }
    if (review.samples.length > 0) {
      lines.push("");
      lines.push("Top V0 cut episode samples:");
      lines.push("");
      lines.push("| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |");
      lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
      for (const episode of review.samples) {
        lines.push(
          [
            `| ${episode.asOfDate}`,
            sanitizeCell(episode.creativeName ?? episode.creativeId),
            episode.source,
            formatNumber(episode.spend28),
            formatNumber(episode.purchases28),
            formatNumber(episode.roas28),
            formatNumber(episode.forward28Roas),
          ].join(" | ") + " |",
        );
      }
    }
  }
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(`Status: ${report.recommendation.status}`);
  lines.push("");
  lines.push(report.recommendation.text);
  lines.push("");
  if (report.recommendation.accountLevelSignals.length > 0) {
    lines.push("Account-level signals:");
    lines.push("");
    for (const signal of report.recommendation.accountLevelSignals) {
      lines.push(`- ${signal}`);
    }
    lines.push("");
  }
  lines.push(
    "Parameter recommendation means a future formula phase only: user approval, golden cases, and an ENGINE_VERSION bump are required before implementation.",
  );
  lines.push("");
  lines.push("## Evidence Limits");
  lines.push("");
  for (const limit of report.evidenceLimits) {
    lines.push(`- ${limit}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatCounts(map: CountMap) {
  const entries = Object.entries(map).sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}:${value}`).join(", ");
}

function sanitizeCell(value: string) {
  return value.replace(/\|/g, "/").replace(/\n/g, " ").trim();
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function writeText(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function mergeCounts(target: CountMap, source: CountMap) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
  return target;
}

function aggregateFocusedSummaries(
  summaries: VariantBusinessSummary[],
): FocusedAggregateSummary[] {
  return FOCUSED_VARIANT_IDS.map((variantId) => {
    const matching = summaries.filter((summary) => summary.variantId === variantId);
    const rawDailySourceCounts: CountMap = {};
    for (const summary of matching) {
      mergeCounts(rawDailySourceCounts, summary.rawDailySourceCounts);
    }
    return {
      variantId,
      episodes: matching.reduce((sum, summary) => sum + summary.episodes, 0),
      temporalPendingDailyRows: matching.reduce(
        (sum, summary) => sum + summary.temporalPendingDailyRows,
        0,
      ),
      rawDailySourceCounts,
      window14: poolWindows(matching.map((summary) => summary.window14)),
      window28: poolWindows(matching.map((summary) => summary.window28)),
    };
  });
}

function buildWindowSuiteReport(input: {
  windows: WindowSuiteReport["windows"];
  applicationName: string;
}): WindowSuiteReport {
  const allBusinessSummaries = input.windows.flatMap((window) =>
    window.report.reviews.flatMap((review) => review.variants),
  );
  const businessMap = new Map<
    string,
    { business: BusinessIdentity; summaries: VariantBusinessSummary[] }
  >();
  for (const window of input.windows) {
    for (const review of window.report.reviews) {
      const key = `${review.business.id}::${review.business.providerAccountId ?? "all"}`;
      const current = businessMap.get(key) ?? {
        business: review.business,
        summaries: [],
      };
      current.summaries.push(...review.variants);
      businessMap.set(key, current);
    }
  }
  const firstReport = input.windows[0]?.report;
  if (!firstReport) throw new Error("Window suite requires at least one report.");
  return {
    contractVersion: F1_F2_SWEEP_CONTRACT_VERSION,
    revision: F1_F2_SWEEP_CONTRACT_REVISION,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutatesData: false,
    lineage: firstReport.lineage,
    transaction: {
      isolation: "repeatable read",
      readOnly: true,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      applicationName: input.applicationName,
    },
    accountScopes: firstReport.reviews.map((review) => ({
      businessName: review.business.name,
      providerAccountId: review.business.providerAccountId,
    })),
    windows: input.windows,
    aggregate: {
      pooled: aggregateFocusedSummaries(allBusinessSummaries),
      byBusiness: [...businessMap.values()]
        .sort((left, right) => left.business.name.localeCompare(right.business.name))
        .map((item) => ({
          business: item.business,
          variants: aggregateFocusedSummaries(item.summaries),
        })),
    },
    verdict: {
      status: "review_only_reject_production_promotion",
      text:
        "Reject production promotion from this lane alone. It can compare relative formula behavior, but current target packs are applied anachronistically, historical rows are creative-grain survivor data, and observational forward spend/ROAS is not a controlled pause counterfactual.",
    },
    evidenceLimits: [
      "Current target and break-even packs are held fixed across every historical date because exact point-in-time commercial target history is not consumed by this legacy sweep.",
      "The raw source is creative-grain, not the immutable exact-Ad decision input chain; one creative may represent more than one Ad over time.",
      "Survivorship bias remains: creatives already paused by operators disappear from later observed spend, so early-cut error can be understated.",
      "Attribution lag moves both directions: delayed conversions can make forward ROAS look too low, while conversions caused by pre-trigger spend can make apparent recovery look too high.",
      "Saved-spend units are observational spend after a trigger divided by the trigger spend unit; they are not causal savings and raw currencies are never pooled.",
      "The June 2026 requested window is automatically truncated per account to the last date with a closed 28-day forward outcome.",
      "Zero-conversion and maturity-severe raw safety branches are intentionally unchanged by V2b/V2c/V2d; V2d temporal confirmation applies only to ratio cuts.",
    ],
  };
}

function signedNumber(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${formatNumber(value)}`;
}

function signedPoints(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;
}

function trueLoserPrecision(window: WindowSummary) {
  return window.knownEpisodes > 0
    ? window.trueLoserEpisodes / window.knownEpisodes
    : null;
}

function wilsonLower95(successes: number, total: number) {
  if (total <= 0) return null;
  const z = 1.96;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin =
    z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return rounded((center - margin) / denominator);
}

function renderDirectionDiagnostics(report: WindowSuiteReport) {
  const lines = [
    "| Window | Business/account | V0 to V2c episodes | V2b to V2c episodes | V0 to V2c 14d early | V2b to V2c 14d early | V0 to V2c 14d units | V2b to V2c 14d units | V0 to V2c 28d early | V2b to V2c 28d early | V0 to V2c 28d units | V2b to V2c 28d units |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const window of report.windows) {
    for (const review of window.report.reviews) {
      const v0 = review.variants.find((item) => item.variantId === "V0_current");
      const v2b = review.variants.find(
        (item) => item.variantId === "V2b_p25_breakeven_floor",
      );
      const v2c = review.variants.find(
        (item) => item.variantId === "V2c_breakeven_recent_hold",
      );
      if (!v0 || !v2b || !v2c) continue;
      const delta = (value: number | null, baseline: number | null) =>
        value === null || baseline === null ? null : rounded(value - baseline);
      lines.push(
        [
          `| ${window.id}`,
          `${review.business.name} / ${review.business.providerAccountId ?? "all"}`,
          signedNumber(v2c.episodes - v0.episodes),
          signedNumber(v2c.episodes - v2b.episodes),
          signedPoints(delta(v2c.window14.earlyCutRate, v0.window14.earlyCutRate)),
          signedPoints(
            delta(v2c.window14.earlyCutRate, v2b.window14.earlyCutRate),
          ),
          signedNumber(
            delta(v2c.window14.savedSpendUnits, v0.window14.savedSpendUnits),
          ),
          signedNumber(
            delta(v2c.window14.savedSpendUnits, v2b.window14.savedSpendUnits),
          ),
          signedPoints(delta(v2c.window28.earlyCutRate, v0.window28.earlyCutRate)),
          signedPoints(
            delta(v2c.window28.earlyCutRate, v2b.window28.earlyCutRate),
          ),
          signedNumber(
            delta(v2c.window28.savedSpendUnits, v0.window28.savedSpendUnits),
          ),
          signedNumber(
            delta(v2c.window28.savedSpendUnits, v2b.window28.savedSpendUnits),
          ),
        ].join(" | ") + " |",
      );
    }
  }
  return lines;
}

function directionCounts(input: {
  report: WindowSuiteReport;
  baselineId: string;
  window: "window14" | "window28";
  metric: "earlyCutRate" | "savedSpendUnits";
}) {
  let improved = 0;
  let worse = 0;
  let tied = 0;
  let unavailable = 0;
  for (const replayWindow of input.report.windows) {
    for (const review of replayWindow.report.reviews) {
      const baseline = review.variants.find(
        (variant) => variant.variantId === input.baselineId,
      );
      const challenger = review.variants.find(
        (variant) => variant.variantId === "V2c_breakeven_recent_hold",
      );
      const left = baseline?.[input.window][input.metric] ?? null;
      const right = challenger?.[input.window][input.metric] ?? null;
      if (left === null || right === null) {
        unavailable += 1;
        continue;
      }
      const delta = right - left;
      if (Math.abs(delta) < 1e-9) tied += 1;
      else if (
        (input.metric === "earlyCutRate" && delta < 0) ||
        (input.metric === "savedSpendUnits" && delta > 0)
      ) {
        improved += 1;
      } else {
        worse += 1;
      }
    }
  }
  return { improved, worse, tied, unavailable };
}

function renderFocusedComparisonTable(
  scopes: Array<{ label: string; variants: FocusedAggregateSummary[] }>,
) {
  const lines = [
    "| Scope | Variant | Episodes | Delta episodes vs V2b | 14d known/unknown | 14d early-cut | Delta early vs V2b | 14d true losers | Delta losers | 14d saved units | Delta units | 28d known/unknown | 28d early-cut | Delta early vs V2b | 28d true losers | Delta losers | 28d saved units | Delta units |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scope of scopes) {
    const v2b = scope.variants.find(
      (variant) => variant.variantId === "V2b_p25_breakeven_floor",
    );
    for (const variant of scope.variants) {
      const delta = (
        value: number | null,
        baseline: number | null,
      ): number | null =>
        value === null || baseline === null ? null : rounded(value - baseline);
      lines.push(
        [
          `| ${scope.label}`,
          variant.variantId,
          variant.episodes,
          signedNumber(v2b ? variant.episodes - v2b.episodes : null),
          `${variant.window14.knownEpisodes}/${variant.window14.unknownEpisodes}`,
          formatPercent(variant.window14.earlyCutRate),
          signedPoints(
            delta(variant.window14.earlyCutRate, v2b?.window14.earlyCutRate ?? null),
          ),
          variant.window14.trueLoserEpisodes,
          signedNumber(
            v2b
              ? variant.window14.trueLoserEpisodes -
                  v2b.window14.trueLoserEpisodes
              : null,
          ),
          formatNumber(variant.window14.savedSpendUnits),
          signedNumber(
            delta(
              variant.window14.savedSpendUnits,
              v2b?.window14.savedSpendUnits ?? null,
            ),
          ),
          `${variant.window28.knownEpisodes}/${variant.window28.unknownEpisodes}`,
          formatPercent(variant.window28.earlyCutRate),
          signedPoints(
            delta(variant.window28.earlyCutRate, v2b?.window28.earlyCutRate ?? null),
          ),
          variant.window28.trueLoserEpisodes,
          signedNumber(
            v2b
              ? variant.window28.trueLoserEpisodes -
                  v2b.window28.trueLoserEpisodes
              : null,
          ),
          formatNumber(variant.window28.savedSpendUnits),
          signedNumber(
            delta(
              variant.window28.savedSpendUnits,
              v2b?.window28.savedSpendUnits ?? null,
            ),
          ),
        ].join(" | ") + " |",
      );
    }
  }
  return lines;
}

function renderWindowSuiteMarkdown(report: WindowSuiteReport) {
  const lines: string[] = [
    "# Mature Below-Breakeven Temporal Replay - 2026-07-16",
    "",
    "This is a SELECT-only historical formula simulation. It does not change the production resolver, provider state, live database state, thresholds, or operator behavior.",
    "",
    "## Verdict",
    "",
    `Status: ${report.verdict.status}`,
    "",
    report.verdict.text,
    "",
    "The useful conclusion is comparative, not causal: V2c tests a break-even recovery hold on top of V2b, while V2d tests one later-calendar-date confirmation for ratio cuts. Neither may be promoted from this legacy lane without exact point-in-time commercial and decision-input evidence.",
    "",
    "## Read-Only Contract",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- gitSha: ${report.lineage.gitSha}`,
    `- isolation: ${report.transaction.isolation}`,
    `- transaction readOnly: ${report.transaction.readOnly}`,
    `- statement timeout: ${report.transaction.statementTimeoutMs} ms`,
    `- application name: ${report.transaction.applicationName}`,
    "- terminal action: one ROLLBACK for the complete four-window suite; no COMMIT path",
    "",
    "## Exact Account Scope",
    "",
  ];
  for (const scope of report.accountScopes) {
    lines.push(`- ${scope.businessName}: ${scope.providerAccountId ?? "all accounts (unsafe fallback)"}`);
  }
  lines.push("");
  lines.push("## Aggregate Across Four Requested Windows");
  lines.push("");
  lines.push(
    ...renderFocusedComparisonTable([
      ...report.aggregate.byBusiness.map((item) => ({
        label: `${item.business.name} / ${item.business.providerAccountId ?? "all"}`,
        variants: item.variants,
      })),
      { label: "POOLED", variants: report.aggregate.pooled },
    ]),
  );
  lines.push("");
  lines.push("### True-Loser Precision And Wilson Lower Bound");
  lines.push("");
  lines.push(
    "True-loser precision is the share of known forward outcomes below explicit break-even. It is observational precision, not causal pause precision.",
  );
  lines.push("");
  lines.push("| Scope | Variant | 14d precision | 14d Wilson 95% lower | 28d precision | 28d Wilson 95% lower |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const scope of [
    ...report.aggregate.byBusiness.map((item) => ({
      label: `${item.business.name} / ${item.business.providerAccountId ?? "all"}`,
      variants: item.variants,
    })),
    { label: "POOLED", variants: report.aggregate.pooled },
  ]) {
    for (const variant of scope.variants) {
      lines.push(
        `| ${scope.label} | ${variant.variantId} | ${formatPercent(trueLoserPrecision(variant.window14))} | ${formatPercent(wilsonLower95(variant.window14.trueLoserEpisodes, variant.window14.knownEpisodes))} | ${formatPercent(trueLoserPrecision(variant.window28))} | ${formatPercent(wilsonLower95(variant.window28.trueLoserEpisodes, variant.window28.knownEpisodes))} |`,
      );
    }
  }
  lines.push("");
  lines.push("### V2c Direction Consistency By Account And Window");
  lines.push("");
  for (const baseline of [
    { id: "V0_current", label: "V0" },
    { id: "V2b_p25_breakeven_floor", label: "V2b" },
  ]) {
    for (const window of ["window14", "window28"] as const) {
      const early = directionCounts({
        report,
        baselineId: baseline.id,
        window,
        metric: "earlyCutRate",
      });
      const saved = directionCounts({
        report,
        baselineId: baseline.id,
        window,
        metric: "savedSpendUnits",
      });
      lines.push(
        `- ${baseline.label} to V2c ${window === "window14" ? "14d" : "28d"}: early-cut improved/worse/tied/unavailable = ${early.improved}/${early.worse}/${early.tied}/${early.unavailable}; saved units improved/worse/tied/unavailable = ${saved.improved}/${saved.worse}/${saved.tied}/${saved.unavailable}.`,
      );
    }
  }
  lines.push("");
  lines.push(...renderDirectionDiagnostics(report));
  lines.push("");
  lines.push("### V2d Is Not Production D036");
  lines.push("");
  lines.push(
    "V2d is a standalone historical sensitivity: it confirms only ratio-based Cuts and intentionally leaves zero-conversion/maturity-severe safety branches immediate. Production D036 governs entry into every hard action using persisted prior-epoch evaluation state. Composing V2d with D036 would double-count confirmation and could add an unintended extra delay; V2d must never be layered on top of D036 as a second calculator.",
  );
  lines.push(
    "V2d also changes episode boundaries: a pending day followed by a confirmed day, recovery interruption, or window edge can create more counted episodes while reducing known-outcome coverage. Its episode and unknown counts are therefore part of the rejection evidence, not a lift claim.",
  );
  const focusedRows = report.windows.flatMap((window) =>
    window.report.reviews.flatMap((review) =>
      review.focusedCreatives.map((focused) => ({
        window: window.id,
        business: review.business,
        focused,
      })),
    ),
  );
  if (focusedRows.length > 0) {
    lines.push("");
    lines.push("## Focus Creative Identity History");
    lines.push("");
    lines.push(
      "These rows bind the requested current exact-Ad identities only to their persisted creative IDs. They do not pretend that a creative-grain historical row is an immutable exact-Ad input.",
    );
    lines.push("");
    lines.push(
      "| Window | Business/account | Creative | Variant | Daily rows | Raw Cut days | Published Cut days | Pending days | Recovery-hold days | First published | Last published | Episodes | 14d early | 14d saved units | 28d early | 28d saved units |",
    );
    lines.push(
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const row of focusedRows) {
      lines.push(
        [
          `| ${row.window}`,
          `${row.business.name} / ${row.business.providerAccountId ?? "all"}`,
          `${sanitizeCell(row.focused.creativeName ?? "unknown")} (${row.focused.creativeId})`,
          row.focused.variantId,
          row.focused.dailyRows,
          row.focused.rawCutDays,
          row.focused.publishedCutDays,
          row.focused.pendingConfirmationDays,
          row.focused.recentRecoveryHoldDays,
          row.focused.firstPublishedCutDate ?? "n/a",
          row.focused.lastPublishedCutDate ?? "n/a",
          row.focused.episodes,
          formatPercent(row.focused.window14.earlyCutRate),
          formatNumber(row.focused.window14.savedSpendUnits),
          formatPercent(row.focused.window28.earlyCutRate),
          formatNumber(row.focused.window28.savedSpendUnits),
        ].join(" | ") + " |",
      );
    }
  }
  for (const window of report.windows) {
    lines.push("");
    lines.push(`## ${window.label}`);
    lines.push("");
    lines.push(`Requested window: ${window.startDate} to ${window.endDate}.`);
    lines.push("");
    const scopes = window.report.reviews.map((review) => ({
      label: `${review.business.name} / ${review.business.providerAccountId ?? "all"} (${review.evaluatedWindow.startDate ?? "n/a"}..${review.evaluatedWindow.endDate ?? "n/a"})`,
      variants: aggregateFocusedSummaries(review.variants),
    }));
    scopes.push({
      label: "POOLED",
      variants: aggregateFocusedSummaries(
        window.report.reviews.flatMap((review) => review.variants),
      ),
    });
    lines.push(...renderFocusedComparisonTable(scopes));
  }
  lines.push("");
  lines.push("## Zero-Conversion And Severe-Loss Safety Isolation");
  lines.push("");
  lines.push(
    "Raw daily safety eligibility is shown separately from episode outcomes. V2d deliberately leaves these two branches immediate; only ratio cuts receive temporal confirmation.",
  );
  lines.push("");
  lines.push("| Scope | Variant | Zero-conversion raw days | Maturity-severe raw days | Temporal-pending ratio days |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const scope of [
    ...report.aggregate.byBusiness.map((item) => ({
      label: `${item.business.name} / ${item.business.providerAccountId ?? "all"}`,
      variants: item.variants,
    })),
    { label: "POOLED", variants: report.aggregate.pooled },
  ]) {
    for (const variant of scope.variants) {
      lines.push(
        `| ${scope.label} | ${variant.variantId} | ${variant.rawDailySourceCounts.zero_conv_burner ?? 0} | ${variant.rawDailySourceCounts.maturity_severe_loser ?? 0} | ${variant.temporalPendingDailyRows} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Evidence Limits");
  lines.push("");
  for (const limit of report.evidenceLimits) lines.push(`- ${limit}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function runSingleReport(args: ParsedArgs) {
  const businesses = await findBusinesses(args.businessIdentifiers);
  if (
    args.windowSuite &&
    (businesses.length !== args.businessIdentifiers.length ||
      businesses.some((business) => business.providerAccountId === null))
  ) {
    throw new Error(
      "Locked window suite requires every requested business to resolve to one exact provider account.",
    );
  }
  const reviews: BusinessReview[] = [];

  for (const business of businesses) {
    try {
      reviews.push(await reviewBusiness({ business, args }));
    } catch (error) {
      reviews.push({
        business,
        status: "failed",
        sourceStats: null,
        targetConfig: null,
        evaluatedWindow: {
          startDate: null,
          endDate: null,
          lookbackDays: args.lookbackDays,
          forwardWindowDays: args.primaryForwardWindowDays,
        },
        rowsEvaluated: 0,
        candidateRowsWithTarget: 0,
        variants: [],
        samples: [],
        focusedCreatives: [],
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = buildReport({
    args,
    businessesFound: businesses.length,
    reviews,
  });
  return report;
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const applicationName = assertTunnelReadOnlyRuntime(databaseUrl);

  if (args.windowSuite) {
    const windows = await withReadOnlyReplayTransaction(async () => {
      const results: WindowSuiteReport["windows"] = [];
      for (const window of LOCKED_WINDOW_SUITE) {
        const windowArgs: ParsedArgs = {
          ...args,
          startDate: window.startDate,
          endDate: window.endDate,
          reportTitle: `${args.reportTitle} - ${window.label}`,
        };
        const report = await runSingleReport(windowArgs);
        results.push({ ...window, report });
      }
      return results;
    });
    const suite = buildWindowSuiteReport({ windows, applicationName });
    if (args.writeFiles) {
      writeJson(args.jsonOut, suite);
      writeText(args.mdOut, renderWindowSuiteMarkdown(suite));
    }
    console.log(
      JSON.stringify(
        {
          jsonOut: args.writeFiles ? args.jsonOut : null,
          mdOut: args.writeFiles ? args.mdOut : null,
          verdict: suite.verdict,
          windows: suite.windows.map((window) => ({
            id: window.id,
            businesses: window.report.reviews.map((review) => ({
              business: review.business.name,
              providerAccountId: review.business.providerAccountId,
              status: review.status,
              evaluatedWindow: review.evaluatedWindow,
              rowsEvaluated: review.rowsEvaluated,
            })),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const report = await withReadOnlyReplayTransaction(() => runSingleReport(args));
  if (args.writeFiles) {
    writeJson(args.jsonOut, report);
    writeText(args.mdOut, renderMarkdown(report));
  }
  console.log(
    JSON.stringify(
      {
        jsonOut: args.writeFiles ? args.jsonOut : null,
        mdOut: args.writeFiles ? args.mdOut : null,
        businesses: report.reviews.map((review) => ({
          business: review.business.name,
          status: review.status,
          rowsEvaluated: review.rowsEvaluated,
          baselineEpisodes:
            review.variants.find((variant) => variant.variantId === "V0_current")
              ?.episodes ?? 0,
        })),
        recommendation: report.recommendation,
      },
      null,
      2,
    ),
  );
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1] as string)).href === import.meta.url;

if (isMain) {
  void withOperationalStartupLogsSilenced(main)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
