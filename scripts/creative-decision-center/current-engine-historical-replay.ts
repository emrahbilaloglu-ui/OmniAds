#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import { composeDataHealth } from "@/lib/creative-decision-engine/data-health";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import {
  resolveEngineV3Flags,
  listEnabledBusinessIds,
} from "@/lib/creative-decision-engine/feature-flags";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  classifyCreativeDecisionOutcome,
  CREATIVE_OUTCOME_CLASSIFIER_VERSION,
  type CreativeDecisionRealizedOutcome,
} from "@/lib/creative-decision-engine/outcome-classifier";
import {
  applyLabelHysteresis,
  type PreviousPublishedLabel,
} from "@/lib/creative-decision-engine/decision-stability";
import {
  ENGINE_VERSION,
  type AccountDecisionProfile,
  type CreativeInput,
  type DataHealth,
  type DecisionLabel,
  type DecisionOutput,
} from "@/lib/creative-decision-engine/types";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const DEFAULT_START_DATE = "2026-06-01";
const DEFAULT_END_DATE = "2026-07-05";
const DEFAULT_EVALUATION_CEILING = "2026-07-05";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/current-engine-historical-replay-2026-06-01-to-2026-07-05.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/CURRENT_ENGINE_HISTORICAL_REPLAY_2026-06-01_TO_2026-07-05.md";
const DEFAULT_BUSINESS_SCOPE = "enabled";
const DEFAULT_FIDELITY_DATES = ["2026-07-03", "2026-07-04"];
const OUTCOME_WINDOWS = [7, 14] as const;
const HARD_LABELS = new Set<DecisionLabel>(["cut", "scale", "refresh"]);
// Hysteresis hard boundary (decision-stability.ts). Narrower than HARD_LABELS:
// refresh does not require two-evaluation confirmation.
const HYSTERESIS_HARD_LABELS = new Set<DecisionLabel>(["cut", "scale"]);
const DEFENSIBLE_EPISODE_THRESHOLD = 30;
const DIRECTIONAL_EPISODE_THRESHOLD = 10;

type CountMap = Record<string, number>;
type FreshnessMode = "wall_clock" | "historical";
type OutcomeWindowDays = (typeof OUTCOME_WINDOWS)[number];
type ReplaySourceMode =
  | "lifecycle_same_day"
  | "lifecycle_carry_forward"
  | "runtime_sql_fallback";
type OutcomeStatus = "open_window" | "known" | "unknown";
type HardClass = "hard" | "non_hard";

type Row = Record<string, unknown>;

interface ParsedArgs {
  startDate: string;
  endDate: string;
  evaluationCeiling: string;
  businesses: string[];
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
  sampleSize: number;
  freshnessMode: FreshnessMode;
  fidelityDates: string[];
  queryTimeoutMs: number;
  sleepMs: number;
  progress: boolean;
}

interface BusinessIdentity {
  id: string;
  name: string;
  isDemoBusiness: boolean;
}

interface SourceModeSummary {
  mode: ReplaySourceMode;
  lifecycleRows: number;
  sameDayLifecycleRows: number;
  latestLifecycleAsOfDate: string | null;
  calibrationRows: number;
  sameDayCalibrationRows: number;
  latestCalibrationAsOfDate: string | null;
}

interface ReplayDecisionRow {
  business: BusinessIdentity;
  asOfDate: string;
  sourceMode: ReplaySourceMode;
  creativeId: string;
  creativeName: string | null;
  campaignId: string | null;
  campaignKind: DecisionOutput["campaignKind"] | null;
  campaignLabelStatus: DecisionOutput["campaignLabelStatus"] | null;
  decisionKindSource: DecisionOutput["decisionKindSource"] | null;
  label: DecisionLabel;
  blockedActionType: DecisionOutput["blockedActionType"] | null;
  confidence: number;
  truthSource: DecisionOutput["truthSource"];
  effectiveTargetRoas: number;
  ratioToTarget: number | null;
  spend: number;
  purchases: number;
  roas: number | null;
  recent7dRoas: number | null;
  asOfDateSpend: number | null;
  dataFreshnessHours: number | null;
  badges: string[];
  labelTransform: DecisionOutput["labelTransform"] | null;
  reason: string;
}

interface OutcomeCandidate {
  business: BusinessIdentity;
  asOfDate: string;
  sourceMode: ReplaySourceMode;
  creativeId: string;
  label: DecisionLabel;
  hardClass: HardClass;
  confidence: number;
  windowDays: OutcomeWindowDays;
  status: OutcomeStatus;
  realizedOutcome: CreativeDecisionRealizedOutcome | "open_window";
  severity: string | null;
  rule: string | null;
  effectiveTargetRoas: number;
  baselineSpend: number | null;
  baselinePurchases: number | null;
  baselineRoas: number | null;
  outcomeSpend: number | null;
  outcomePurchases: number | null;
  outcomeRevenue: number | null;
  outcomeRoas: number | null;
  asOfDateSpend: number | null;
}

interface OutcomeEpisode extends OutcomeCandidate {
  episodeKey: string;
}

interface StabilityRow {
  business: BusinessIdentity;
  asOfDate: string;
  creativeId: string;
  creativeName: string | null;
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  suppressed: boolean;
  asOfDateSpend: number | null;
}

type SuppressionResolution =
  | "confirmed"
  | "reverted"
  | "changed_again"
  | "gap_return"
  | "replay_end"
  | "exited_universe";

interface SuppressionRecord {
  business: { id: string; name: string };
  asOfDate: string;
  creativeId: string;
  creativeName: string | null;
  heldLabel: DecisionLabel;
  rawLabel: DecisionLabel;
  resolution: SuppressionResolution;
  asOfDateSpend: number | null;
}

interface StabilityBusinessSummary {
  business: { id: string; name: string };
  observations: number;
  rawHardTransitions: number;
  publishedHardTransitions: number;
  rawHardRoundTrips: number;
  rawHardReversalsWithin3: number;
  publishedHardReversalsWithin3: number;
  suppressedDays: number;
  suppressionResolutions: CountMap;
  cutDelaySuppressedDays: number;
  cutDelayForwardSpend: number;
  scaleDelaySuppressedDays: number;
  scaleDelayForwardSpend: number;
}

interface MatchedSuppressionCell {
  windowDays: OutcomeWindowDays;
  suppressedDays: number;
  scoredDays: number;
  holdRight: number;
  flipRight: number;
  neutralOrUnknown: number;
  openWindow: number;
  pairOutcomes: CountMap;
}

interface StabilitySummary {
  hysteresisEpoch: "clean_epoch_per_business_at_start_date";
  perBusiness: StabilityBusinessSummary[];
  global: Omit<StabilityBusinessSummary, "business">;
  matchedSuppression: MatchedSuppressionCell[];
  suppressionSamples: SuppressionRecord[];
  rawOutcomeCells: OutcomeCell[];
  publishedOutcomeCells: OutcomeCell[];
  rawCalibrationCells: CalibrationCell[];
  publishedCalibrationCells: CalibrationCell[];
}

interface DayReplayResult {
  status: "ok" | "failed";
  business: BusinessIdentity;
  asOfDate: string;
  sourceMode: SourceModeSummary | null;
  profile: ProfileSummary | null;
  dataHealth: DataHealth | null;
  rawDataHealth: DataHealth | null;
  decisionCount: number;
  inputCount: number;
  labels: CountMap;
  errorMessage?: string;
}

interface ProfileSummary {
  preset: AccountDecisionProfile["preset"];
  presetSource: AccountDecisionProfile["presetSource"];
  spendUnit: number | null;
  spendUnitSource: AccountDecisionProfile["spendUnitSource"];
  spendUnitConfidence: AccountDecisionProfile["spendUnitConfidence"];
  commercialMaturitySpend: number | null;
  hardCutSpend: number | null;
  bottomQuartileRatio: number | null;
  severeLoserRatio: number | null;
  scaleMinPurchases: number | null;
  winnerPurchaseP50: number | null;
  matureCreativeCount: number | null;
  hardActionEligibility: AccountDecisionProfile["hardActionEligibility"];
}

interface FidelitySummary {
  business: BusinessIdentity;
  asOfDate: string;
  sourceMode: ReplaySourceMode | null;
  replayRows: number;
  snapshotRows: number;
  commonRows: number;
  labelMatches: number;
  labelConfidenceMatches: number;
  labelMatchRate: number | null;
  labelConfidenceMatchRate: number | null;
  replayOnlyRows: number;
  snapshotOnlyRows: number;
  samples: Array<{
    creativeId: string;
    replayLabel: string | null;
    snapshotLabel: string | null;
    replayConfidence: number | null;
    snapshotConfidence: number | null;
    replayReason: string | null;
    snapshotReason: string | null;
  }>;
}

interface BusinessReplaySummary {
  business: BusinessIdentity;
  datesProcessed: number;
  failedDays: number;
  decisionRows: number;
  uniqueCreatives: number;
  labels: CountMap;
  hardRows: number;
  blockedRows: number;
  sourceModeDays: CountMap;
  profileRanges: Record<string, { min: number | null; max: number | null }>;
  outcomeCells: OutcomeCell[];
  calibration: CalibrationCell[];
  detailedCalibration: DetailedCalibrationCell[];
  fidelity: FidelitySummary[];
  riskHints: string[];
  samples: {
    hardRows: ReplayDecisionRow[];
    outcomeEpisodes: OutcomeEpisode[];
    fidelityMismatches: FidelitySummary["samples"];
  };
}

interface OutcomeCell {
  windowDays: OutcomeWindowDays;
  label: DecisionLabel;
  hardClass: HardClass;
  openWindowRows: number;
  closedDailyRows: number;
  episodes: number;
  knownEpisodes: number;
  unknownEpisodes: number;
  positive: number;
  negative: number;
  neutral: number;
  zeroForwardSpendUnknownEpisodes: number;
  positiveRateKnown: number | null;
  reliability: "defensible" | "directional" | "insufficient";
}

interface CalibrationCell {
  windowDays: OutcomeWindowDays;
  hardClass: HardClass;
  bucket: string;
  episodes: number;
  knownEpisodes: number;
  positive: number;
  observedPositiveRate: number | null;
  averageConfidence: number | null;
  absoluteGap: number | null;
}

interface DetailedCalibrationCell {
  windowDays: OutcomeWindowDays;
  sourceMode: ReplaySourceMode;
  label: DecisionLabel;
  hardClass: HardClass;
  bucket: string;
  episodes: number;
  knownEpisodes: number;
  unknownEpisodes: number;
  positive: number;
  negative: number;
  neutral: number;
  observedPositiveRate: number | null;
  averageConfidence: number | null;
  absoluteGap: number | null;
  reliability: "defensible" | "directional" | "insufficient";
  positiveMeaning: "hard_action_supported" | "non_hard_missed_hard_action_proxy";
}

interface ReplayReport {
  contractVersion: "adsecute.current-engine-historical-replay.v2";
  generatedAt: string;
  currentDate: string;
  readOnly: true;
  mutatesData: false;
  manualCronPosted: false;
  providerWrites: false;
  engineVersion: string;
  classifierVersion: string;
  startDate: string;
  endDate: string;
  evaluationCeiling: string;
  freshnessMode: FreshnessMode;
  businessesRequested: string[];
  businessesFound: number;
  dateCount: number;
  fidelityDates: string[];
  liveStatus: {
    attempted: true;
    source: "live_db_tunnel";
    tunnelHost: "127.0.0.1";
    tunnelPort: 15432;
    readOnly: true;
    tables: string[];
  };
  methodLimits: string[];
  dayResults: DayReplayResult[];
  dateSummaries: Array<{
    asOfDate: string;
    successfulBusinesses: number;
    failedBusinesses: number;
    decisionRows: number;
    labels: CountMap;
    sourceModes: CountMap;
  }>;
  businessSummaries: BusinessReplaySummary[];
  stabilitySummary: StabilitySummary;
  globalSummary: {
    decisionRows: number;
    uniqueCreatives: number;
    labels: CountMap;
    sourceModeDays: CountMap;
    openWindowRows: number;
    closedDailyRows: number;
    episodes: number;
    knownEpisodes: number;
    unknownEpisodes: number;
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    startDate: arg(argv, "startDate", DEFAULT_START_DATE),
    endDate: arg(argv, "endDate", DEFAULT_END_DATE),
    evaluationCeiling: arg(argv, "evaluationCeiling", DEFAULT_EVALUATION_CEILING),
    businesses: csvArg(argv, "businesses") ?? [DEFAULT_BUSINESS_SCOPE],
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
    sampleSize: Math.max(1, Number(arg(argv, "sampleSize", "12")) || 12),
    freshnessMode:
      arg(argv, "freshnessMode", "historical") === "wall_clock"
        ? "wall_clock"
        : "historical",
    fidelityDates: csvArg(argv, "fidelityDates") ?? DEFAULT_FIDELITY_DATES,
    queryTimeoutMs: Math.max(1_000, Number(arg(argv, "queryTimeoutMs", "45000")) || 45_000),
    sleepMs: Math.max(0, Number(arg(argv, "sleepMs", "75")) || 0),
    progress: arg(argv, "progress", "1") !== "0",
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
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "t", "1"].includes(value.toLowerCase());
  return false;
}

function toDateOnly(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return toText(value)?.slice(0, 10) ?? null;
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateToMs(date: string) {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function addDays(date: string, days: number) {
  const parsed = new Date(dateToMs(date));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function diffDays(left: string, right: string) {
  return Math.round((dateToMs(left) - dateToMs(right)) / 86_400_000);
}

function dateRange(startDate: string, endDate: string) {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    throw new Error("startDate and endDate must be ISO dates.");
  }
  if (startDate > endDate) {
    throw new Error("startDate must be <= endDate.");
  }
  const dates: string[] = [];
  for (let current = startDate; current <= endDate; current = addDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

function rounded(value: number | null | undefined, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return rounded(numerator / denominator, 4);
}

function increment(map: CountMap, key: string | null | undefined, by = 1) {
  const normalized = key?.trim() || "null";
  map[normalized] = (map[normalized] ?? 0) + by;
}

function mergeCountMap(target: CountMap, source: CountMap) {
  for (const [key, count] of Object.entries(source)) {
    increment(target, key, count);
  }
}

function confidenceBucket(confidence: number) {
  if (confidence < 50) return "00_49";
  if (confidence < 60) return "50_59";
  if (confidence < 70) return "60_69";
  if (confidence < 80) return "70_79";
  if (confidence < 90) return "80_89";
  return "90_100";
}

function hardClass(label: DecisionLabel): HardClass {
  return HARD_LABELS.has(label) ? "hard" : "non_hard";
}

function isClosedWindow(asOfDate: string, windowDays: OutcomeWindowDays, evaluationCeiling: string) {
  return addDays(asOfDate, windowDays) <= evaluationCeiling;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findBusinessesByIdentifiers(identifiers: readonly string[]) {
  const normalized = identifiers.map((item) => item.toLowerCase());
  const rows = await getDb().query<Row>(
    `
    SELECT id::text AS id, name, COALESCE(is_demo_business, FALSE) AS is_demo_business
    FROM businesses
    WHERE lower(name) = ANY($1::text[])
       OR id::text = ANY($2::text[])
    ORDER BY name ASC, id ASC
    `,
    [normalized, identifiers],
  );
  return rows.flatMap(toBusinessIdentity);
}

async function findBusinessesByIds(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await getDb().query<Row>(
    `
    SELECT id::text AS id, name, COALESCE(is_demo_business, FALSE) AS is_demo_business
    FROM businesses
    WHERE id::text = ANY($1::text[])
    ORDER BY name ASC, id ASC
    `,
    [ids],
  );
  return rows.flatMap(toBusinessIdentity);
}

function toBusinessIdentity(row: Row): BusinessIdentity[] {
  const id = toText(row.id);
  const name = toText(row.name);
  if (!id || !name) return [];
  return [
    {
      id,
      name,
      isDemoBusiness: toBoolean(row.is_demo_business),
    },
  ];
}

async function resolveBusinesses(requested: readonly string[]) {
  const normalized = requested.map((item) => item.toLowerCase());
  if (
    normalized.length === 0 ||
    normalized.includes("enabled") ||
    normalized.includes("all")
  ) {
    return findBusinessesByIds(await listEnabledBusinessIds());
  }
  return findBusinessesByIdentifiers(requested);
}

async function readSourceMode(input: {
  businessId: string;
  asOfDate: string;
}): Promise<SourceModeSummary> {
  const [row] = await getDb().query<Row>(
    `
    SELECT
      (
        SELECT COUNT(*)
        FROM engine_v3_creative_lifecycle_daily
        WHERE business_ref_id = $1::uuid
          AND engine_version = $3
          AND as_of_date <= $2::date
      ) AS lifecycle_rows,
      (
        SELECT COUNT(*)
        FROM engine_v3_creative_lifecycle_daily
        WHERE business_ref_id = $1::uuid
          AND engine_version = $3
          AND as_of_date = $2::date
      ) AS same_day_lifecycle_rows,
      (
        SELECT MAX(as_of_date)::text
        FROM engine_v3_creative_lifecycle_daily
        WHERE business_ref_id = $1::uuid
          AND engine_version = $3
          AND as_of_date <= $2::date
      ) AS latest_lifecycle_as_of_date,
      (
        SELECT COUNT(*)
        FROM engine_v3_account_calibration_daily
        WHERE business_ref_id = $1::uuid
          AND engine_version = $3
          AND as_of_date <= $2::date
      ) AS calibration_rows,
      (
        SELECT COUNT(*)
        FROM engine_v3_account_calibration_daily
        WHERE business_ref_id = $1::uuid
          AND engine_version = $3
          AND as_of_date = $2::date
      ) AS same_day_calibration_rows,
      (
        SELECT MAX(as_of_date)::text
        FROM engine_v3_account_calibration_daily
        WHERE business_ref_id = $1::uuid
          AND engine_version = $3
          AND as_of_date <= $2::date
      ) AS latest_calibration_as_of_date
    `,
    [input.businessId, input.asOfDate, ENGINE_VERSION],
  );
  const lifecycleRows = toNumber(row?.lifecycle_rows);
  const sameDayLifecycleRows = toNumber(row?.same_day_lifecycle_rows);
  return {
    mode:
      lifecycleRows === 0
        ? "runtime_sql_fallback"
        : sameDayLifecycleRows > 0
          ? "lifecycle_same_day"
          : "lifecycle_carry_forward",
    lifecycleRows,
    sameDayLifecycleRows,
    latestLifecycleAsOfDate: toDateOnly(row?.latest_lifecycle_as_of_date),
    calibrationRows: toNumber(row?.calibration_rows),
    sameDayCalibrationRows: toNumber(row?.same_day_calibration_rows),
    latestCalibrationAsOfDate: toDateOnly(row?.latest_calibration_as_of_date),
  };
}

function normalizeDataHealthForHistoricalReplay(
  dataHealth: DataHealth,
  asOf: string,
): DataHealth {
  const normalizeLayer = (layer: DataHealth["calibration"]) => ({
    ...layer,
    asOfDate: layer.asOfDate ?? asOf,
    sourceFreshnessHours: layer.sourceFreshnessHours === null ? null : 0,
    staleTier: "none" as const,
    note: layer.note
      ? `${layer.note}; historical replay freshness normalized`
      : "historical replay freshness normalized",
  });

  return composeDataHealth({
    calibration: normalizeLayer(dataHealth.calibration),
    lifecycle: normalizeLayer(dataHealth.lifecycle),
    decisions: normalizeLayer(dataHealth.decisions),
  });
}

function normalizeCreativeInputsForHistoricalReplay(inputs: CreativeInput[]) {
  return inputs.map((input) => ({
    ...input,
    dataFreshnessHours:
      input.dataFreshnessHours === null ? null : Math.min(input.dataFreshnessHours, 6),
  }));
}

async function readCampaignLabelsById(input: {
  businessId: string;
  creativeInputs: CreativeInput[];
}) {
  const campaignIds = Array.from(
    new Set(
      input.creativeInputs
        .map((creativeInput) => creativeInput.campaignId?.trim() ?? "")
        .filter(Boolean),
    ),
  );
  if (campaignIds.length === 0) {
    return {
      campaignIds,
      labelsFound: 0,
      map: buildCreativeCampaignLabelMap([]),
    };
  }
  const labels = await readMetaCampaignLabels({
    businessId: input.businessId,
    campaignIds,
  });
  return {
    campaignIds,
    labelsFound: labels.length,
    map: buildCreativeCampaignLabelMap(labels),
  };
}

function profileSummary(profile: AccountDecisionProfile): ProfileSummary {
  return {
    preset: profile.preset,
    presetSource: profile.presetSource,
    spendUnit: profile.spendUnit,
    spendUnitSource: profile.spendUnitSource,
    spendUnitConfidence: profile.spendUnitConfidence,
    commercialMaturitySpend: profile.thresholds.commercialMaturitySpend,
    hardCutSpend: profile.thresholds.hardCutSpend,
    bottomQuartileRatio: profile.thresholds.bottomQuartileRatio,
    severeLoserRatio: profile.thresholds.severeLoserRatio,
    scaleMinPurchases: profile.thresholds.scaleMinPurchases,
    winnerPurchaseP50: profile.accountBaselines.winnerPurchaseP50,
    matureCreativeCount: profile.accountBaselines.matureCreativeCount,
    hardActionEligibility: profile.hardActionEligibility,
  };
}

// Must mirror compareDecisionComputations in jobs/decisions-job.ts exactly:
// left-minus-right, so the dedupe keeps the HIGHEST-priority computation
// (cut beats keep), as production does. A prior version of this comparator
// was inverted (kept the lowest priority) - v1 replay artifacts were
// generated with that inverted dedupe.
function compareDecisionOutputs(
  left: { input: CreativeInput; decision: DecisionOutput },
  right: { input: CreativeInput; decision: DecisionOutput },
) {
  return (
    decisionLabelPriority(left.decision.label) -
      decisionLabelPriority(right.decision.label) ||
    Math.round(left.decision.confidence) - Math.round(right.decision.confidence) ||
    (Number.isFinite(left.input.spend) ? left.input.spend : 0) -
      (Number.isFinite(right.input.spend) ? right.input.spend : 0) ||
    (left.input.campaignId ?? "").localeCompare(right.input.campaignId ?? "")
  );
}

function decisionLabelPriority(label: DecisionLabel) {
  const priorities: Record<DecisionLabel, number> = {
    cut: 70,
    scale: 60,
    refresh: 50,
    diagnose: 40,
    test_more: 30,
    keep: 20,
    out_of_scope: 10,
  };
  return priorities[label] ?? 0;
}

function dedupeDecisionComputations(
  computations: Array<{ input: CreativeInput; decision: DecisionOutput }>,
) {
  const byCreativeId = new Map<string, { input: CreativeInput; decision: DecisionOutput }>();
  for (const computation of computations) {
    const current = byCreativeId.get(computation.input.creativeId);
    if (!current || compareDecisionOutputs(computation, current) > 0) {
      byCreativeId.set(computation.input.creativeId, computation);
    }
  }
  return Array.from(byCreativeId.values()).sort((left, right) =>
    left.input.creativeId.localeCompare(right.input.creativeId),
  );
}

function toReplayDecisionRow(input: {
  business: BusinessIdentity;
  asOfDate: string;
  sourceMode: ReplaySourceMode;
  creativeInput: CreativeInput;
  decision: DecisionOutput;
}): ReplayDecisionRow {
  return {
    business: input.business,
    asOfDate: input.asOfDate,
    sourceMode: input.sourceMode,
    creativeId: input.creativeInput.creativeId,
    creativeName: input.creativeInput.creativeName,
    campaignId: input.creativeInput.campaignId,
    campaignKind: input.decision.campaignKind ?? null,
    campaignLabelStatus: input.decision.campaignLabelStatus ?? null,
    decisionKindSource: input.decision.decisionKindSource ?? null,
    label: input.decision.label,
    blockedActionType: input.decision.blockedActionType ?? null,
    confidence: input.decision.confidence,
    truthSource: input.decision.truthSource,
    effectiveTargetRoas: input.decision.effectiveTargetRoas,
    ratioToTarget: input.decision.ratioToTarget,
    spend: input.creativeInput.spend,
    purchases: input.creativeInput.purchases,
    roas: input.creativeInput.roas,
    recent7dRoas: input.creativeInput.recent7dRoas,
    asOfDateSpend: input.creativeInput.spend24h ?? null,
    dataFreshnessHours: input.creativeInput.dataFreshnessHours,
    badges: input.decision.badges.map((badge) => badge.type),
    labelTransform: input.decision.labelTransform ?? null,
    reason: input.decision.reason,
  };
}

async function replayBusinessDay(input: {
  business: BusinessIdentity;
  asOfDate: string;
  freshnessMode: FreshnessMode;
}): Promise<{
  day: DayReplayResult;
  decisions: ReplayDecisionRow[];
}> {
  const sourceMode = await readSourceMode({
    businessId: input.business.id,
    asOfDate: input.asOfDate,
  });

  try {
    const dataSource = new WarehouseDataSource();
    const flags = await resolveEngineV3Flags(input.business.id);
    const profile = await resolveAccountDecisionProfile({
      businessId: input.business.id,
      asOf: input.asOfDate,
      dataSource,
      flags,
    });
    const rawDataHealth = await dataSource.getDataHealth({
      businessId: input.business.id,
      asOf: input.asOfDate,
    });
    const rawCreativeInputs = await dataSource.listCreativeInputs({
      businessId: input.business.id,
      asOf: input.asOfDate,
    });
    const dataHealth =
      input.freshnessMode === "historical"
        ? normalizeDataHealthForHistoricalReplay(rawDataHealth, input.asOfDate)
        : rawDataHealth;
    const creativeInputs =
      input.freshnessMode === "historical"
        ? normalizeCreativeInputsForHistoricalReplay(rawCreativeInputs)
        : rawCreativeInputs;
    const campaignLabels = await readCampaignLabelsById({
      businessId: input.business.id,
      creativeInputs,
    });

    const rawComputations = creativeInputs.map((creativeInput) => {
      const withCampaignKind = withCreativeCampaignLabelContext(
        creativeInput,
        campaignLabels.map,
      );
      const decision = applyCreativeCampaignLabelGuard({
        decision: decideCreative(withCampaignKind, profile, dataHealth),
        input: withCampaignKind,
        campaignLabelsById: campaignLabels.map,
      });
      return { input: withCampaignKind, decision };
    });
    const decisions = dedupeDecisionComputations(rawComputations).map(
      ({ input: creativeInput, decision }) =>
        toReplayDecisionRow({
          business: input.business,
          asOfDate: input.asOfDate,
          sourceMode: sourceMode.mode,
          creativeInput,
          decision,
        }),
    );
    const labels: CountMap = {};
    for (const decision of decisions) increment(labels, decision.label);

    return {
      day: {
        status: "ok",
        business: input.business,
        asOfDate: input.asOfDate,
        sourceMode,
        profile: profileSummary(profile),
        dataHealth,
        rawDataHealth,
        decisionCount: decisions.length,
        inputCount: creativeInputs.length,
        labels,
      },
      decisions,
    };
  } catch (error) {
    return {
      day: {
        status: "failed",
        business: input.business,
        asOfDate: input.asOfDate,
        sourceMode,
        profile: null,
        dataHealth: null,
        rawDataHealth: null,
        decisionCount: 0,
        inputCount: 0,
        labels: {},
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      decisions: [],
    };
  }
}

async function readOutcomeAggregates(input: {
  businessId: string;
  asOfDate: string;
  creativeIds: string[];
  windows: OutcomeWindowDays[];
}) {
  if (input.creativeIds.length === 0 || input.windows.length === 0) {
    return new Map<string, OutcomeAggregate>();
  }
  const rows = await getDb().query<Row>(
    `
    WITH ids AS (
      SELECT unnest($3::text[]) AS creative_id
    ),
    windows AS (
      SELECT unnest($4::integer[]) AS outcome_window_days
    ),
    day_spend AS (
      SELECT
        d.creative_id,
        COALESCE(SUM(d.spend), 0)::double precision AS as_of_date_spend
      FROM meta_creative_daily d
      WHERE d.business_ref_id = $1::uuid
        AND d.creative_id = ANY($3::text[])
        AND d.date = $2::date
      GROUP BY d.creative_id
    )
    SELECT
      ids.creative_id,
      windows.outcome_window_days,
      COALESCE(SUM(d.spend), 0)::double precision AS outcome_spend,
      COALESCE(SUM(d.conversions), 0)::double precision AS outcome_purchases,
      COALESCE(SUM(d.revenue), 0)::double precision AS outcome_revenue,
      CASE
        WHEN COALESCE(SUM(d.spend), 0) > 0
        THEN COALESCE(SUM(d.revenue), 0) / NULLIF(SUM(d.spend), 0)
      END AS outcome_roas,
      COALESCE(MAX(day_spend.as_of_date_spend), 0)::double precision AS as_of_date_spend
    FROM ids
    CROSS JOIN windows
    LEFT JOIN meta_creative_daily d
      ON d.business_ref_id = $1::uuid
     AND d.creative_id = ids.creative_id
     AND d.date > $2::date
     AND d.date <= ($2::date + (windows.outcome_window_days * INTERVAL '1 day'))::date
    LEFT JOIN day_spend
      ON day_spend.creative_id = ids.creative_id
    GROUP BY ids.creative_id, windows.outcome_window_days
    ORDER BY ids.creative_id ASC, windows.outcome_window_days ASC
    `,
    [input.businessId, input.asOfDate, input.creativeIds, input.windows],
  );
  const aggregates = new Map<string, OutcomeAggregate>();
  for (const row of rows) {
    const creativeId = toText(row.creative_id);
    const windowDays = toNumber(row.outcome_window_days) as OutcomeWindowDays;
    if (!creativeId || !OUTCOME_WINDOWS.includes(windowDays)) continue;
    aggregates.set(outcomeAggregateKey(creativeId, windowDays), {
      creativeId,
      windowDays,
      outcomeSpend: toNumber(row.outcome_spend),
      outcomePurchases: toNumber(row.outcome_purchases),
      outcomeRevenue: toNumber(row.outcome_revenue),
      outcomeRoas: toNullableNumber(row.outcome_roas),
      asOfDateSpend: toNullableNumber(row.as_of_date_spend) ?? 0,
    });
  }
  return aggregates;
}

interface OutcomeAggregate {
  creativeId: string;
  windowDays: OutcomeWindowDays;
  outcomeSpend: number;
  outcomePurchases: number;
  outcomeRevenue: number;
  outcomeRoas: number | null;
  asOfDateSpend: number;
}

function outcomeAggregateKey(creativeId: string, windowDays: OutcomeWindowDays) {
  return `${creativeId}::${windowDays}`;
}

async function classifyOutcomesForDay(input: {
  decisions: ReplayDecisionRow[];
  businessId: string;
  asOfDate: string;
  evaluationCeiling: string;
}) {
  const closedWindows = OUTCOME_WINDOWS.filter((windowDays) =>
    isClosedWindow(input.asOfDate, windowDays, input.evaluationCeiling),
  );
  const aggregates = await readOutcomeAggregates({
    businessId: input.businessId,
    asOfDate: input.asOfDate,
    creativeIds: input.decisions.map((decision) => decision.creativeId),
    windows: closedWindows,
  });
  const candidates: OutcomeCandidate[] = [];

  for (const decision of input.decisions) {
    for (const windowDays of OUTCOME_WINDOWS) {
      if (!isClosedWindow(input.asOfDate, windowDays, input.evaluationCeiling)) {
        candidates.push({
          business: decision.business,
          asOfDate: decision.asOfDate,
          sourceMode: decision.sourceMode,
          creativeId: decision.creativeId,
          label: decision.label,
          hardClass: hardClass(decision.label),
          confidence: decision.confidence,
          windowDays,
          status: "open_window",
          realizedOutcome: "open_window",
          severity: null,
          rule: null,
          effectiveTargetRoas: decision.effectiveTargetRoas,
          baselineSpend: decision.spend,
          baselinePurchases: decision.purchases,
          baselineRoas: decision.roas,
          outcomeSpend: null,
          outcomePurchases: null,
          outcomeRevenue: null,
          outcomeRoas: null,
          asOfDateSpend: decision.asOfDateSpend,
        });
        continue;
      }

      const aggregate = aggregates.get(outcomeAggregateKey(decision.creativeId, windowDays));
      const outcomeSpend = aggregate?.outcomeSpend ?? 0;
      const outcomePurchases = aggregate?.outcomePurchases ?? 0;
      const outcomeRevenue = aggregate?.outcomeRevenue ?? 0;
      const outcomeRoas = aggregate?.outcomeRoas ?? null;
      const classification = classifyCreativeDecisionOutcome({
        label: decision.label,
        confidence: Math.round(decision.confidence),
        effectiveTargetRoas: decision.effectiveTargetRoas,
        baselineSpend: decision.spend,
        baselinePurchases: decision.purchases,
        baselineRoas: decision.roas,
        outcomeSpend,
        outcomePurchases,
        outcomeRevenue,
        outcomeRoas,
        outcomeWindowDays: windowDays,
      });
      const rule = toText(classification.evidence.rule);
      candidates.push({
        business: decision.business,
        asOfDate: decision.asOfDate,
        sourceMode: decision.sourceMode,
        creativeId: decision.creativeId,
        label: decision.label,
        hardClass: hardClass(decision.label),
        confidence: decision.confidence,
        windowDays,
        status:
          classification.realizedOutcome === "unknown" ? "unknown" : "known",
        realizedOutcome: classification.realizedOutcome,
        severity: classification.severity,
        rule,
        effectiveTargetRoas: decision.effectiveTargetRoas,
        baselineSpend: decision.spend,
        baselinePurchases: decision.purchases,
        baselineRoas: decision.roas,
        outcomeSpend,
        outcomePurchases,
        outcomeRevenue,
        outcomeRoas,
        asOfDateSpend:
          aggregate?.asOfDateSpend ?? decision.asOfDateSpend ?? null,
      });
    }
  }

  return candidates;
}

function collectOutcomeEpisodes(candidates: OutcomeCandidate[]) {
  const closed = candidates
    .filter((candidate) => candidate.status !== "open_window")
    .sort((left, right) => {
      const businessCmp = left.business.id.localeCompare(right.business.id);
      if (businessCmp) return businessCmp;
      const creativeCmp = left.creativeId.localeCompare(right.creativeId);
      if (creativeCmp) return creativeCmp;
      const windowCmp = left.windowDays - right.windowDays;
      if (windowCmp) return windowCmp;
      return left.asOfDate.localeCompare(right.asOfDate);
    });
  const stateByCreativeWindow = new Map<
    string,
    {
      date: string | null;
      label: DecisionLabel | null;
      lastEpisodeDate: string | null;
      hasSpendAfterLastEpisode: boolean;
    }
  >();
  const episodes: OutcomeEpisode[] = [];

  for (const candidate of closed) {
    const stateKey = `${candidate.business.id}::${candidate.creativeId}::${candidate.windowDays}`;
    const state =
      stateByCreativeWindow.get(stateKey) ?? {
        date: null,
        label: null,
        lastEpisodeDate: null,
        hasSpendAfterLastEpisode: false,
      };
    if (
      state.lastEpisodeDate !== null &&
      candidate.asOfDate > state.lastEpisodeDate &&
      (candidate.asOfDateSpend ?? 0) > 0
    ) {
      state.hasSpendAfterLastEpisode = true;
    }
    const previousDayDiff =
      state.date === null ? null : diffDays(candidate.asOfDate, state.date);
    const startsRun =
      state.label !== candidate.label ||
      previousDayDiff === null ||
      previousDayDiff > 1;
    const hasFreshSpendSinceLastEpisode =
      state.lastEpisodeDate === null || state.hasSpendAfterLastEpisode;

    if (startsRun && hasFreshSpendSinceLastEpisode) {
      const episodeKey = [
        candidate.business.id,
        candidate.creativeId,
        candidate.windowDays,
        candidate.asOfDate,
        candidate.label,
      ].join("::");
      episodes.push({ ...candidate, episodeKey });
      state.lastEpisodeDate = candidate.asOfDate;
      state.hasSpendAfterLastEpisode = false;
    }

    state.date = candidate.asOfDate;
    state.label = candidate.label;
    stateByCreativeWindow.set(stateKey, state);
  }

  return episodes;
}

async function readPersistedSnapshots(input: {
  businessId: string;
  asOfDate: string;
}) {
  const rows = await getDb().query<Row>(
    `
    SELECT
      creative_id,
      label,
      confidence,
      reason,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      spend,
      purchases,
      roas
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
      AND scope_type = 'account'
      AND scope_id = '*'
    ORDER BY creative_id ASC
    `,
    [input.businessId, input.asOfDate, ENGINE_VERSION],
  );
  return rows.flatMap((row) => {
    const creativeId = toText(row.creative_id);
    const label = toText(row.label);
    if (!creativeId || !label) return [];
    return [
      {
        creativeId,
        label,
        confidence: Math.round(toNumber(row.confidence)),
        reason: toText(row.reason),
      },
    ];
  });
}

async function buildFidelitySummary(input: {
  business: BusinessIdentity;
  asOfDate: string;
  replayRows: ReplayDecisionRow[];
  sourceMode: ReplaySourceMode | null;
  sampleSize: number;
}): Promise<FidelitySummary> {
  const snapshots = await readPersistedSnapshots({
    businessId: input.business.id,
    asOfDate: input.asOfDate,
  });
  const replayByCreative = new Map(
    input.replayRows.map((row) => [row.creativeId, row]),
  );
  const snapshotByCreative = new Map(
    snapshots.map((row) => [row.creativeId, row]),
  );
  const allCreativeIds = Array.from(
    new Set([...replayByCreative.keys(), ...snapshotByCreative.keys()]),
  ).sort();
  let commonRows = 0;
  let labelMatches = 0;
  let labelConfidenceMatches = 0;
  const samples: FidelitySummary["samples"] = [];

  for (const creativeId of allCreativeIds) {
    const replay = replayByCreative.get(creativeId);
    const snapshot = snapshotByCreative.get(creativeId);
    if (replay && snapshot) {
      commonRows += 1;
      if (replay.label === snapshot.label) labelMatches += 1;
      if (
        replay.label === snapshot.label &&
        Math.round(replay.confidence) === snapshot.confidence
      ) {
        labelConfidenceMatches += 1;
      }
    }
    const mismatch =
      !replay ||
      !snapshot ||
      replay.label !== snapshot.label ||
      Math.round(replay.confidence) !== snapshot.confidence;
    if (mismatch && samples.length < input.sampleSize) {
      samples.push({
        creativeId,
        replayLabel: replay?.label ?? null,
        snapshotLabel: snapshot?.label ?? null,
        replayConfidence: replay ? Math.round(replay.confidence) : null,
        snapshotConfidence: snapshot?.confidence ?? null,
        replayReason: replay?.reason ?? null,
        snapshotReason: snapshot?.reason ?? null,
      });
    }
  }

  return {
    business: input.business,
    asOfDate: input.asOfDate,
    sourceMode: input.sourceMode,
    replayRows: input.replayRows.length,
    snapshotRows: snapshots.length,
    commonRows,
    labelMatches,
    labelConfidenceMatches,
    labelMatchRate: ratio(labelMatches, commonRows),
    labelConfidenceMatchRate: ratio(labelConfidenceMatches, commonRows),
    replayOnlyRows: input.replayRows.filter(
      (row) => !snapshotByCreative.has(row.creativeId),
    ).length,
    snapshotOnlyRows: snapshots.filter(
      (row) => !replayByCreative.has(row.creativeId),
    ).length,
    samples,
  };
}

function summarizeDateResults(dayResults: DayReplayResult[]) {
  const byDate = new Map<
    string,
    {
      asOfDate: string;
      successfulBusinesses: number;
      failedBusinesses: number;
      decisionRows: number;
      labels: CountMap;
      sourceModes: CountMap;
    }
  >();
  for (const day of dayResults) {
    const summary =
      byDate.get(day.asOfDate) ??
      {
        asOfDate: day.asOfDate,
        successfulBusinesses: 0,
        failedBusinesses: 0,
        decisionRows: 0,
        labels: {},
        sourceModes: {},
      };
    if (day.status === "ok") {
      summary.successfulBusinesses += 1;
      summary.decisionRows += day.decisionCount;
      mergeCountMap(summary.labels, day.labels);
      increment(summary.sourceModes, day.sourceMode?.mode ?? "unknown");
    } else {
      summary.failedBusinesses += 1;
    }
    byDate.set(day.asOfDate, summary);
  }
  return Array.from(byDate.values()).sort((left, right) =>
    left.asOfDate.localeCompare(right.asOfDate),
  );
}

function createOutcomeCell(windowDays: OutcomeWindowDays, label: DecisionLabel): OutcomeCell {
  return {
    windowDays,
    label,
    hardClass: hardClass(label),
    openWindowRows: 0,
    closedDailyRows: 0,
    episodes: 0,
    knownEpisodes: 0,
    unknownEpisodes: 0,
    positive: 0,
    negative: 0,
    neutral: 0,
    zeroForwardSpendUnknownEpisodes: 0,
    positiveRateKnown: null,
    reliability: "insufficient",
  };
}

function outcomeCellKey(input: { windowDays: OutcomeWindowDays; label: DecisionLabel }) {
  return `${input.windowDays}::${input.label}`;
}

function finalizeOutcomeCell(cell: OutcomeCell): OutcomeCell {
  return {
    ...cell,
    positiveRateKnown: ratio(cell.positive, cell.knownEpisodes),
    reliability:
      cell.knownEpisodes >= DEFENSIBLE_EPISODE_THRESHOLD
        ? "defensible"
        : cell.knownEpisodes >= DIRECTIONAL_EPISODE_THRESHOLD
          ? "directional"
          : "insufficient",
  };
}

function buildOutcomeCells(input: {
  candidates: OutcomeCandidate[];
  episodes: OutcomeEpisode[];
}) {
  const cells = new Map<string, OutcomeCell>();
  const ensure = (windowDays: OutcomeWindowDays, label: DecisionLabel) => {
    const key = outcomeCellKey({ windowDays, label });
    const existing = cells.get(key);
    if (existing) return existing;
    const created = createOutcomeCell(windowDays, label);
    cells.set(key, created);
    return created;
  };

  for (const candidate of input.candidates) {
    const cell = ensure(candidate.windowDays, candidate.label);
    if (candidate.status === "open_window") cell.openWindowRows += 1;
    else cell.closedDailyRows += 1;
  }

  for (const episode of input.episodes) {
    const cell = ensure(episode.windowDays, episode.label);
    cell.episodes += 1;
    if (episode.status === "unknown") {
      cell.unknownEpisodes += 1;
      if ((episode.outcomeSpend ?? 0) <= 0) {
        cell.zeroForwardSpendUnknownEpisodes += 1;
      }
    } else if (episode.realizedOutcome === "positive") {
      cell.knownEpisodes += 1;
      cell.positive += 1;
    } else if (episode.realizedOutcome === "negative") {
      cell.knownEpisodes += 1;
      cell.negative += 1;
    } else if (episode.realizedOutcome === "neutral") {
      cell.knownEpisodes += 1;
      cell.neutral += 1;
    }
  }

  return Array.from(cells.values())
    .map(finalizeOutcomeCell)
    .sort(
      (left, right) =>
        left.windowDays - right.windowDays ||
        left.hardClass.localeCompare(right.hardClass) ||
        left.label.localeCompare(right.label),
    );
}

function buildCalibrationCells(episodes: OutcomeEpisode[]) {
  const cells = new Map<
    string,
    {
      windowDays: OutcomeWindowDays;
      hardClass: HardClass;
      bucket: string;
      episodes: number;
      knownEpisodes: number;
      positive: number;
      confidenceSum: number;
    }
  >();

  for (const episode of episodes) {
    const bucket = confidenceBucket(episode.confidence);
    const key = `${episode.windowDays}::${episode.hardClass}::${bucket}`;
    const cell =
      cells.get(key) ??
      {
        windowDays: episode.windowDays,
        hardClass: episode.hardClass,
        bucket,
        episodes: 0,
        knownEpisodes: 0,
        positive: 0,
        confidenceSum: 0,
      };
    cell.episodes += 1;
    if (episode.status === "known") {
      cell.knownEpisodes += 1;
      cell.confidenceSum += episode.confidence / 100;
      if (episode.realizedOutcome === "positive") cell.positive += 1;
    }
    cells.set(key, cell);
  }

  return Array.from(cells.values())
    .map((cell): CalibrationCell => {
      const observedPositiveRate = ratio(cell.positive, cell.knownEpisodes);
      const averageConfidence = ratio(cell.confidenceSum, cell.knownEpisodes);
      return {
        windowDays: cell.windowDays,
        hardClass: cell.hardClass,
        bucket: cell.bucket,
        episodes: cell.episodes,
        knownEpisodes: cell.knownEpisodes,
        positive: cell.positive,
        observedPositiveRate,
        averageConfidence,
        absoluteGap:
          observedPositiveRate === null || averageConfidence === null
            ? null
            : rounded(Math.abs(observedPositiveRate - averageConfidence), 4),
      };
    })
    .sort(
      (left, right) =>
        left.windowDays - right.windowDays ||
        left.hardClass.localeCompare(right.hardClass) ||
      left.bucket.localeCompare(right.bucket),
    );
}

function buildDetailedCalibrationCells(episodes: OutcomeEpisode[]) {
  const cells = new Map<
    string,
    {
      windowDays: OutcomeWindowDays;
      sourceMode: ReplaySourceMode;
      label: DecisionLabel;
      hardClass: HardClass;
      bucket: string;
      episodes: number;
      knownEpisodes: number;
      unknownEpisodes: number;
      positive: number;
      negative: number;
      neutral: number;
      confidenceSum: number;
    }
  >();

  for (const episode of episodes) {
    const bucket = confidenceBucket(episode.confidence);
    const key = [
      episode.windowDays,
      episode.sourceMode,
      episode.label,
      bucket,
    ].join("::");
    const cell =
      cells.get(key) ??
      {
        windowDays: episode.windowDays,
        sourceMode: episode.sourceMode,
        label: episode.label,
        hardClass: episode.hardClass,
        bucket,
        episodes: 0,
        knownEpisodes: 0,
        unknownEpisodes: 0,
        positive: 0,
        negative: 0,
        neutral: 0,
        confidenceSum: 0,
      };
    cell.episodes += 1;
    if (episode.status === "known") {
      cell.knownEpisodes += 1;
      cell.confidenceSum += episode.confidence / 100;
      if (episode.realizedOutcome === "positive") cell.positive += 1;
      if (episode.realizedOutcome === "negative") cell.negative += 1;
      if (episode.realizedOutcome === "neutral") cell.neutral += 1;
    } else if (episode.status === "unknown") {
      cell.unknownEpisodes += 1;
    }
    cells.set(key, cell);
  }

  return Array.from(cells.values())
    .map((cell): DetailedCalibrationCell => {
      const observedPositiveRate = ratio(cell.positive, cell.knownEpisodes);
      const averageConfidence = ratio(cell.confidenceSum, cell.knownEpisodes);
      return {
        windowDays: cell.windowDays,
        sourceMode: cell.sourceMode,
        label: cell.label,
        hardClass: cell.hardClass,
        bucket: cell.bucket,
        episodes: cell.episodes,
        knownEpisodes: cell.knownEpisodes,
        unknownEpisodes: cell.unknownEpisodes,
        positive: cell.positive,
        negative: cell.negative,
        neutral: cell.neutral,
        observedPositiveRate,
        averageConfidence,
        absoluteGap:
          observedPositiveRate === null || averageConfidence === null
            ? null
            : rounded(Math.abs(observedPositiveRate - averageConfidence), 4),
        reliability:
          cell.knownEpisodes >= DEFENSIBLE_EPISODE_THRESHOLD
            ? "defensible"
            : cell.knownEpisodes >= DIRECTIONAL_EPISODE_THRESHOLD
              ? "directional"
              : "insufficient",
        positiveMeaning:
          cell.hardClass === "hard"
            ? "hard_action_supported"
            : "non_hard_missed_hard_action_proxy",
      };
    })
    .sort(
      (left, right) =>
        left.windowDays - right.windowDays ||
        left.sourceMode.localeCompare(right.sourceMode) ||
        decisionLabelPriority(right.label) - decisionLabelPriority(left.label) ||
        left.bucket.localeCompare(right.bucket),
    );
}

function updateRange(
  ranges: Record<string, { min: number | null; max: number | null }>,
  key: string,
  value: number | null | undefined,
) {
  if (value === null || value === undefined || !Number.isFinite(value)) return;
  const range = ranges[key] ?? { min: null, max: null };
  range.min = range.min === null ? value : Math.min(range.min, value);
  range.max = range.max === null ? value : Math.max(range.max, value);
  ranges[key] = range;
}

function buildBusinessSummaries(input: {
  businesses: BusinessIdentity[];
  dayResults: DayReplayResult[];
  decisions: ReplayDecisionRow[];
  candidates: OutcomeCandidate[];
  episodes: OutcomeEpisode[];
  fidelity: FidelitySummary[];
  sampleSize: number;
}): BusinessReplaySummary[] {
  return input.businesses.map((business) => {
    const days = input.dayResults.filter((day) => day.business.id === business.id);
    const decisions = input.decisions.filter((row) => row.business.id === business.id);
    const candidates = input.candidates.filter(
      (candidate) => candidate.business.id === business.id,
    );
    const episodes = input.episodes.filter((episode) => episode.business.id === business.id);
    const labels: CountMap = {};
    const sourceModeDays: CountMap = {};
    const uniqueCreatives = new Set<string>();
    let hardRows = 0;
    let blockedRows = 0;
    for (const row of decisions) {
      increment(labels, row.label);
      uniqueCreatives.add(row.creativeId);
      if (HARD_LABELS.has(row.label)) hardRows += 1;
      if (row.blockedActionType !== null) blockedRows += 1;
    }
    const profileRanges: Record<string, { min: number | null; max: number | null }> = {};
    const riskHints = new Set<string>();
    for (const day of days) {
      if (day.sourceMode) increment(sourceModeDays, day.sourceMode.mode);
      if (day.sourceMode?.mode === "runtime_sql_fallback") {
        riskHints.add("runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production");
      }
      if (day.rawDataHealth?.worstTier !== "none") {
        riskHints.add("raw_wall_clock_freshness_was_stale_or_degraded");
      }
      if (day.dataHealth?.worstTier !== "none") {
        riskHints.add("replay_data_health_degraded");
      }
      updateRange(profileRanges, "spendUnit", day.profile?.spendUnit);
      updateRange(
        profileRanges,
        "commercialMaturitySpend",
        day.profile?.commercialMaturitySpend,
      );
      updateRange(profileRanges, "hardCutSpend", day.profile?.hardCutSpend);
      updateRange(
        profileRanges,
        "bottomQuartileRatio",
        day.profile?.bottomQuartileRatio,
      );
      updateRange(profileRanges, "severeLoserRatio", day.profile?.severeLoserRatio);
      updateRange(profileRanges, "scaleMinPurchases", day.profile?.scaleMinPurchases);
      updateRange(profileRanges, "winnerPurchaseP50", day.profile?.winnerPurchaseP50);
      updateRange(profileRanges, "matureCreativeCount", day.profile?.matureCreativeCount);
    }
    if (business.isDemoBusiness) riskHints.add("demo_business_in_enabled_scope");
    if (blockedRows > 0) riskHints.add("campaign_label_guard_blocked_hard_actions");
    if (hardRows === 0) riskHints.add("no_hard_actions_in_replay_window");

    const businessFidelity = input.fidelity.filter(
      (entry) => entry.business.id === business.id,
    );
    const mismatchSamples = businessFidelity.flatMap((entry) => entry.samples);

    return {
      business,
      datesProcessed: days.filter((day) => day.status === "ok").length,
      failedDays: days.filter((day) => day.status === "failed").length,
      decisionRows: decisions.length,
      uniqueCreatives: uniqueCreatives.size,
      labels,
      hardRows,
      blockedRows,
      sourceModeDays,
      profileRanges,
      outcomeCells: buildOutcomeCells({ candidates, episodes }),
      calibration: buildCalibrationCells(episodes),
      detailedCalibration: buildDetailedCalibrationCells(episodes),
      fidelity: businessFidelity,
      riskHints: Array.from(riskHints).sort(),
      samples: {
        hardRows: decisions
          .filter((row) => HARD_LABELS.has(row.label) || row.blockedActionType !== null)
          .sort(
            (left, right) =>
              decisionLabelPriority(right.label) - decisionLabelPriority(left.label) ||
              right.confidence - left.confidence ||
              right.spend - left.spend,
          )
          .slice(0, input.sampleSize),
        outcomeEpisodes: episodes
          .filter(
            (episode) =>
              episode.realizedOutcome === "negative" ||
              episode.realizedOutcome === "positive",
          )
          .sort(
            (left, right) =>
              (right.outcomeSpend ?? 0) - (left.outcomeSpend ?? 0) ||
              right.confidence - left.confidence,
          )
          .slice(0, input.sampleSize),
        fidelityMismatches: mismatchSamples.slice(0, input.sampleSize),
      },
    };
  });
}

function buildGlobalSummary(input: {
  decisions: ReplayDecisionRow[];
  dayResults: DayReplayResult[];
  candidates: OutcomeCandidate[];
  episodes: OutcomeEpisode[];
}) {
  const labels: CountMap = {};
  const sourceModeDays: CountMap = {};
  const uniqueCreatives = new Set<string>();
  for (const decision of input.decisions) {
    increment(labels, decision.label);
    uniqueCreatives.add(`${decision.business.id}::${decision.creativeId}`);
  }
  for (const day of input.dayResults) {
    if (day.sourceMode) increment(sourceModeDays, day.sourceMode.mode);
  }
  return {
    decisionRows: input.decisions.length,
    uniqueCreatives: uniqueCreatives.size,
    labels,
    sourceModeDays,
    openWindowRows: input.candidates.filter((candidate) => candidate.status === "open_window").length,
    closedDailyRows: input.candidates.filter((candidate) => candidate.status !== "open_window").length,
    episodes: input.episodes.length,
    knownEpisodes: input.episodes.filter((episode) => episode.status === "known").length,
    unknownEpisodes: input.episodes.filter((episode) => episode.status === "unknown").length,
  };
}

function formatCountMap(map: CountMap | null | undefined) {
  if (!map || Object.keys(map).length === 0) return "-";
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatPct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function escapeCell(value: unknown) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function rangesText(ranges: Record<string, { min: number | null; max: number | null }>) {
  const parts = Object.entries(ranges).map(([key, value]) => {
    const min = formatNumber(value.min, 2);
    const max = formatNumber(value.max, 2);
    return `${key} ${min}-${max}`;
  });
  return parts.length > 0 ? parts.join(", ") : "-";
}

function renderMarkdown(report: ReplayReport) {
  const lines: string[] = [];
  lines.push(`# Current Engine Historical Replay - ${report.startDate} to ${report.endDate}`);
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Current date assumed by run: ${report.currentDate}`);
  lines.push(`Engine version: \`${report.engineVersion}\``);
  lines.push(`Outcome classifier: \`${report.classifierVersion}\``);
  lines.push(`Replay window: ${report.startDate} -> ${report.endDate}`);
  lines.push(`Outcome evaluation ceiling: ${report.evaluationCeiling}`);
  lines.push(`Freshness mode: ${report.freshnessMode}`);
  lines.push("");
  lines.push("## Verdict Boundary");
  lines.push("");
  lines.push(
    "This is a read-only historical replay/backtest of the current decision engine over existing warehouse data. It is not evidence that the production scheduler actually ran for 35 inclusive asOf dates / 34 elapsed historical days, and it is not causal proof that an operator would have achieved these outcomes.",
  );
  lines.push("");
  lines.push(
    "The useful question answered here is narrower: if today's current engine had evaluated each historical asOf date, what labels would it have emitted, and what non-causal forward outcome proxy is visible for windows that are already closed by 2026-07-05?",
  );
  lines.push("");
  lines.push("## Live/Write Safety");
  lines.push("");
  lines.push("- DB writes: no.");
  lines.push("- Provider/API writes: no.");
  lines.push("- Manual `/api/sync/cron` POST: no.");
  lines.push("- Migrations: no.");
  lines.push(
    `- Live read source: ${report.liveStatus.source} via ${report.liveStatus.tunnelHost}:${report.liveStatus.tunnelPort}.`,
  );
  lines.push("");
  lines.push("## Method Limits");
  lines.push("");
  for (const limit of report.methodLimits) lines.push(`- ${limit}`);
  lines.push("");
  lines.push("## Label Flow And Guard Boundary");
  lines.push("");
  lines.push(
    "Outcome and confidence cells are computed from the guard-applied surfaced `decision.label`. `blockedActionType` is reported separately as guard context; this replay does not silently convert a blocked raw hard verdict into a hard outcome episode.",
  );
  lines.push("");
  lines.push(
    "Interpretation consequence: a hard episode is a surfaced historical-replay label for that business/day/source-mode, not a claim that the same business is currently surfacing hard production labels. Fallback-mode hard labels must not be read as lifecycle-informed July production behavior.",
  );
  lines.push("");
  lines.push("## Global Summary");
  lines.push("");
  lines.push(`- Businesses found: ${report.businessesFound}`);
  lines.push(`- Dates replayed: ${report.dateCount}`);
  lines.push(`- Decision rows: ${report.globalSummary.decisionRows}`);
  lines.push(`- Unique business+creative pairs: ${report.globalSummary.uniqueCreatives}`);
  lines.push(`- Label mix: ${formatCountMap(report.globalSummary.labels)}`);
  lines.push(`- Source mode days: ${formatCountMap(report.globalSummary.sourceModeDays)}`);
  lines.push(`- Open outcome windows: ${report.globalSummary.openWindowRows}`);
  lines.push(`- Closed daily outcome rows: ${report.globalSummary.closedDailyRows}`);
  lines.push(`- Episode-deduped outcome rows: ${report.globalSummary.episodes}`);
  lines.push(`- Known episodes: ${report.globalSummary.knownEpisodes}`);
  lines.push(`- Unknown episodes: ${report.globalSummary.unknownEpisodes}`);
  lines.push("");
  lines.push("## Business Summary");
  lines.push("");
  lines.push(
    "| Business | Demo | Days | Failed | Decisions | Unique creatives | Labels | Hard rows | Blocked rows | Source modes | Profile ranges | Risk hints |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|---|");
  for (const summary of report.businessSummaries) {
    lines.push(
      [
        summary.business.name,
        summary.business.isDemoBusiness ? "yes" : "no",
        summary.datesProcessed,
        summary.failedDays,
        summary.decisionRows,
        summary.uniqueCreatives,
        formatCountMap(summary.labels),
        summary.hardRows,
        summary.blockedRows,
        formatCountMap(summary.sourceModeDays),
        rangesText(summary.profileRanges),
        summary.riskHints.join(", ") || "-",
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push("## Fidelity Check vs Persisted Snapshots");
  lines.push("");
  lines.push(
    "This is the replay-faithfulness anchor requested by Claude: 2026-07-03 and 2026-07-04 replay rows are compared with actual persisted current-version snapshots. Low fidelity does not automatically mean the formula is wrong; it means replay mode/provenance differs and the historical result must be discounted accordingly.",
  );
  lines.push("");
  lines.push(
    "| Business | Date | Source mode | Replay rows | Snapshot rows | Common | Label match | Label+confidence match | Replay-only | Snapshot-only |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const summary of report.businessSummaries) {
    for (const fidelity of summary.fidelity) {
      lines.push(
        `| ${escapeCell(summary.business.name)} | ${fidelity.asOfDate} | ${fidelity.sourceMode ?? "-"} | ${fidelity.replayRows} | ${fidelity.snapshotRows} | ${fidelity.commonRows} | ${formatPct(fidelity.labelMatchRate)} | ${formatPct(fidelity.labelConfidenceMatchRate)} | ${fidelity.replayOnlyRows} | ${fidelity.snapshotOnlyRows} |`,
      );
    }
  }
  lines.push("");
  const fidelityMismatchNotes = report.businessSummaries.flatMap((summary) =>
    summary.fidelity.flatMap((fidelity) =>
      fidelity.samples.map((sample) => ({
        businessName: summary.business.name,
        asOfDate: fidelity.asOfDate,
        sample,
      })),
    ),
  );
  if (fidelityMismatchNotes.length > 0) {
    lines.push("## Fidelity Mismatch Notes");
    lines.push("");
    lines.push(
      "Sampled replay-vs-snapshot mismatches are listed explicitly so the fidelity rate cannot hide boundary-class differences.",
    );
    lines.push("");
    for (const note of fidelityMismatchNotes) {
      lines.push(
        `- ${note.businessName} ${note.asOfDate} creative ${note.sample.creativeId}: replay ${note.sample.replayLabel ?? "null"}/${note.sample.replayConfidence ?? "null"} vs snapshot ${note.sample.snapshotLabel ?? "null"}/${note.sample.snapshotConfidence ?? "null"}; replay reason "${escapeCell(note.sample.replayReason ?? "null")}", snapshot reason "${escapeCell(note.sample.snapshotReason ?? "null")}".`,
      );
    }
    lines.push("");
  }
  lines.push("## Decision Stability (Hysteresis Simulation)");
  lines.push("");
  const stability = report.stabilitySummary;
  lines.push(
    `Epoch: ${stability.hysteresisEpoch}. Raw = engine output before stabilization; published = label after hard-boundary two-evaluation confirmation.`,
  );
  lines.push("");
  lines.push("| Metric | Raw | Published | Change |");
  lines.push("|---|---:|---:|---:|");
  const transitionChange =
    stability.global.rawHardTransitions > 0
      ? `${formatPct(
          (stability.global.publishedHardTransitions -
            stability.global.rawHardTransitions) /
            stability.global.rawHardTransitions,
        )}`
      : "n/a";
  const reversalChange =
    stability.global.rawHardReversalsWithin3 > 0
      ? `${formatPct(
          (stability.global.publishedHardReversalsWithin3 -
            stability.global.rawHardReversalsWithin3) /
            stability.global.rawHardReversalsWithin3,
        )}`
      : "n/a";
  lines.push(
    `| Hard-boundary transitions | ${stability.global.rawHardTransitions} | ${stability.global.publishedHardTransitions} | ${transitionChange} |`,
  );
  lines.push(
    `| Hard reversals within 3 obs | ${stability.global.rawHardReversalsWithin3} | ${stability.global.publishedHardReversalsWithin3} | ${reversalChange} |`,
  );
  lines.push("");
  lines.push(
    `Raw period-2 round-trips (A->B->A): ${stability.global.rawHardRoundTrips}. Published period-2 round-trips are structurally zero by hysteresis construction and are NOT reported as evidence; the reversal metric above is period-agnostic and fair to both streams.`,
  );
  lines.push("");
  lines.push(
    `Suppressed days: ${stability.global.suppressedDays} (resolutions: ${formatCountMap(stability.global.suppressionResolutions)}). confirmed/reverted are next-calendar-day evidence only; gap_return/exited_universe/replay_end are broken out and carry no next-day claim.`,
  );
  lines.push(
    `Cut delays: ${stability.global.cutDelaySuppressedDays} suppressed days, next-day exposure ${formatNumber(stability.global.cutDelayForwardSpend, 2)}. Scale delays: ${stability.global.scaleDelaySuppressedDays} suppressed days, next-day exposure ${formatNumber(stability.global.scaleDelayForwardSpend, 2)}. Exposure = next adjacent day's spend under historical operator policy; non-causal.`,
  );
  lines.push("");
  lines.push("Matched suppressed-day scoring (identical forward windows, only the label differs - primary hold-vs-flip evidence):");
  lines.push("| Window | Suppressed | Scored | Hold right | Flip right | Neutral/unknown | Open window |");
  lines.push("|---:|---:|---:|---:|---:|---:|---:|");
  for (const cell of stability.matchedSuppression) {
    lines.push(
      `| ${cell.windowDays}d | ${cell.suppressedDays} | ${cell.scoredDays} | ${cell.holdRight} | ${cell.flipRight} | ${cell.neutralOrUnknown} | ${cell.openWindow} |`,
    );
  }
  lines.push("");
  lines.push("Per business:");
  lines.push(
    "| Business | Obs | Raw hard transitions | Published hard transitions | Raw reversals<=3 | Published reversals<=3 | Suppressed days | Resolutions | Cut-delay next-day spend |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---|---:|");
  for (const row of stability.perBusiness) {
    lines.push(
      [
        row.business.name,
        row.observations,
        row.rawHardTransitions,
        row.publishedHardTransitions,
        row.rawHardReversalsWithin3,
        row.publishedHardReversalsWithin3,
        row.suppressedDays,
        formatCountMap(row.suppressionResolutions),
        formatNumber(row.cutDelayForwardSpend, 2),
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push(
    "Raw vs published outcome cells (SECONDARY context only: episode re-segmentation anchors confirmed transitions one day later and censors unknowns differently per stream, so these cells are not a like-for-like comparison - use the matched table above for hold-vs-flip claims):",
  );
  lines.push(
    "| Window | Label | Class | Raw episodes | Raw known | Raw unknown (zero-spend) | Raw positive rate | Published episodes | Published known | Published unknown (zero-spend) | Published positive rate |",
  );
  lines.push("|---:|---|---|---:|---:|---|---:|---:|---:|---|---:|");
  const publishedCellByKey = new Map(
    stability.publishedOutcomeCells.map((cell) => [
      `${cell.windowDays}::${cell.label}`,
      cell,
    ]),
  );
  for (const rawCell of stability.rawOutcomeCells) {
    const published = publishedCellByKey.get(
      `${rawCell.windowDays}::${rawCell.label}`,
    );
    lines.push(
      [
        rawCell.windowDays,
        rawCell.label,
        rawCell.hardClass,
        rawCell.episodes,
        rawCell.knownEpisodes,
        `${rawCell.unknownEpisodes} (${rawCell.zeroForwardSpendUnknownEpisodes})`,
        formatPct(rawCell.positiveRateKnown),
        published?.episodes ?? 0,
        published?.knownEpisodes ?? 0,
        `${published?.unknownEpisodes ?? 0} (${published?.zeroForwardSpendUnknownEpisodes ?? 0})`,
        formatPct(published?.positiveRateKnown ?? null),
      ]
        .map(escapeCell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    );
  }
  lines.push("");
  if (stability.suppressionSamples.length > 0) {
    lines.push("Suppression samples (first 40):");
    lines.push(
      "| Business | Date | Creative | Held | Raw | Resolution | As-of spend |",
    );
    lines.push("|---|---|---|---|---|---|---:|");
    for (const sample of stability.suppressionSamples) {
      lines.push(
        [
          sample.business.name,
          sample.asOfDate,
          sample.creativeId,
          sample.heldLabel,
          sample.rawLabel,
          sample.resolution,
          formatNumber(sample.asOfDateSpend, 2),
        ]
          .map(escapeCell)
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
    lines.push("");
  }

  lines.push("## Outcome Episode Summary");
  lines.push("");
  lines.push(
    "`open_window` is not `unknown`: open means the 7d/14d forward window has not closed by 2026-07-05. `unknown` means the window is closed but the classifier cannot infer outcome, most commonly zero forward spend or missing target. Precision/missed-opportunity proxy below is episode-deduped, not daily-row counted.",
  );
  lines.push("");
  lines.push(
    "| Business | Window | Label | Class | Open rows | Closed daily rows | Episodes | Known | Unknown | Positive | Negative | Neutral | Zero-forward unknown | Positive rate known | Reliability |",
  );
  lines.push("|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const summary of report.businessSummaries) {
    for (const cell of summary.outcomeCells) {
      lines.push(
        `| ${escapeCell(summary.business.name)} | ${cell.windowDays} | ${cell.label} | ${cell.hardClass} | ${cell.openWindowRows} | ${cell.closedDailyRows} | ${cell.episodes} | ${cell.knownEpisodes} | ${cell.unknownEpisodes} | ${cell.positive} | ${cell.negative} | ${cell.neutral} | ${cell.zeroForwardSpendUnknownEpisodes} | ${formatPct(cell.positiveRateKnown)} | ${cell.reliability} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Confidence Alignment Smoke");
  lines.push("");
  lines.push(
    "Hard and non-hard rows are deliberately separated. For hard actions, positive means the hard action proxy was supported. For non-hard rows, positive means a missed hard-action opportunity proxy; it is not the same polarity and must not be pooled with hard precision.",
  );
  lines.push("");
  lines.push(
    "| Business | Window | Class | Bucket | Episodes | Known | Positive | Observed positive | Avg confidence | Abs gap |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const summary of report.businessSummaries) {
    for (const cell of summary.calibration) {
      lines.push(
        `| ${escapeCell(summary.business.name)} | ${cell.windowDays} | ${cell.hardClass} | ${cell.bucket} | ${cell.episodes} | ${cell.knownEpisodes} | ${cell.positive} | ${formatPct(cell.observedPositiveRate)} | ${formatPct(cell.averageConfidence)} | ${formatPct(cell.absoluteGap)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Confidence By Label And Source Mode");
  lines.push("");
  lines.push(
    "This is the deeper calibration table requested after the multi-window review. It keeps business, surfaced action label, outcome window, confidence bucket, and replay source-mode separate. Positive polarity is listed explicitly because hard labels and non-hard labels do not mean the same thing.",
  );
  lines.push("");
  lines.push(
    "| Business | Window | Source mode | Label | Class | Bucket | Episodes | Known | Unknown | Positive | Negative | Neutral | Observed positive | Avg confidence | Abs gap | Reliability | Positive meaning |",
  );
  lines.push(
    "|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  );
  for (const summary of report.businessSummaries) {
    for (const cell of summary.detailedCalibration) {
      lines.push(
        [
          summary.business.name,
          cell.windowDays,
          cell.sourceMode,
          cell.label,
          cell.hardClass,
          cell.bucket,
          cell.episodes,
          cell.knownEpisodes,
          cell.unknownEpisodes,
          cell.positive,
          cell.negative,
          cell.neutral,
          formatPct(cell.observedPositiveRate),
          formatPct(cell.averageConfidence),
          formatPct(cell.absoluteGap),
          cell.reliability,
          cell.positiveMeaning,
        ]
          .map(escapeCell)
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
  }
  lines.push("");
  lines.push("## Replay Date Summary");
  lines.push("");
  lines.push("| Date | Success businesses | Failed businesses | Decisions | Labels | Source modes |");
  lines.push("|---|---:|---:|---:|---|---|");
  for (const day of report.dateSummaries) {
    lines.push(
      `| ${day.asOfDate} | ${day.successfulBusinesses} | ${day.failedBusinesses} | ${day.decisionRows} | ${escapeCell(formatCountMap(day.labels))} | ${escapeCell(formatCountMap(day.sourceModes))} |`,
    );
  }
  lines.push("");
  lines.push("## Business Samples");
  for (const summary of report.businessSummaries) {
    lines.push("");
    lines.push(`### ${summary.business.name}`);
    lines.push("");
    if (summary.samples.fidelityMismatches.length > 0) {
      lines.push("Fidelity mismatch samples:");
      lines.push("| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |");
      lines.push("|---|---|---|---:|---:|---|---|");
      for (const sample of summary.samples.fidelityMismatches) {
        lines.push(
          [
            sample.creativeId,
            sample.replayLabel ?? "null",
            sample.snapshotLabel ?? "null",
            sample.replayConfidence ?? "null",
            sample.snapshotConfidence ?? "null",
            sample.replayReason ?? "null",
            sample.snapshotReason ?? "null",
          ]
            .map(escapeCell)
            .join(" | ")
            .replace(/^/, "| ")
            .replace(/$/, " |"),
        );
      }
      lines.push("");
    }
    if (summary.samples.hardRows.length > 0) {
      lines.push("Hard/blocker replay samples:");
      lines.push("| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |");
      lines.push("|---|---|---|---|---:|---:|---:|---:|---|---|");
      for (const row of summary.samples.hardRows) {
        lines.push(
          [
            row.asOfDate,
            row.creativeId,
            row.label,
            row.blockedActionType ?? "null",
            formatNumber(row.confidence, 0),
            formatNumber(row.spend, 2),
            formatNumber(row.purchases, 0),
            formatNumber(row.roas, 2),
            row.badges.join(", "),
            row.reason,
          ]
            .map(escapeCell)
            .join(" | ")
            .replace(/^/, "| ")
            .replace(/$/, " |"),
        );
      }
      lines.push("");
    }
    if (summary.samples.outcomeEpisodes.length > 0) {
      lines.push("Outcome episode samples:");
      lines.push("| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |");
      lines.push("|---|---:|---|---|---|---|---:|---:|---:|");
      for (const episode of summary.samples.outcomeEpisodes) {
        lines.push(
          [
            episode.asOfDate,
            episode.windowDays,
            episode.creativeId,
            episode.label,
            episode.realizedOutcome,
            episode.rule ?? "null",
            formatNumber(episode.baselineSpend, 2),
            formatNumber(episode.outcomeSpend, 2),
            formatNumber(episode.outcomeRoas, 2),
          ]
            .map(escapeCell)
            .join(" | ")
            .replace(/^/, "| ")
            .replace(/$/, " |"),
        );
      }
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function jsonForReport(report: ReplayReport) {
  return JSON.stringify(
    {
      ...report,
      dayResults: report.dayResults.map((day) => ({
        status: day.status,
        business: day.business,
        asOfDate: day.asOfDate,
        sourceMode: day.sourceMode,
        profile: day.profile,
        dataHealth: day.dataHealth
          ? {
              worstTier: day.dataHealth.worstTier,
              degraded: day.dataHealth.degraded,
            }
          : null,
        rawDataHealth: day.rawDataHealth
          ? {
              worstTier: day.rawDataHealth.worstTier,
              degraded: day.rawDataHealth.degraded,
            }
          : null,
        decisionCount: day.decisionCount,
        inputCount: day.inputCount,
        labels: day.labels,
        errorMessage: day.errorMessage,
      })),
    },
    null,
    2,
  );
}

function writeTextFile(path: string, content: string) {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return absolutePath;
}

function isHysteresisHard(label: DecisionLabel) {
  return HYSTERESIS_HARD_LABELS.has(label);
}

function crossesHysteresisHardBoundary(left: DecisionLabel, right: DecisionLabel) {
  return left !== right && (isHysteresisHard(left) || isHysteresisHard(right));
}

function countHardTransitions(labels: DecisionLabel[]) {
  let count = 0;
  for (let index = 1; index < labels.length; index += 1) {
    if (crossesHysteresisHardBoundary(labels[index - 1], labels[index])) count += 1;
  }
  return count;
}

function countHardRoundTrips(labels: DecisionLabel[]) {
  let count = 0;
  for (let index = 2; index < labels.length; index += 1) {
    if (
      labels[index] === labels[index - 2] &&
      crossesHysteresisHardBoundary(labels[index - 2], labels[index - 1])
    ) {
      count += 1;
    }
  }
  return count;
}

// Period-agnostic oscillation metric that is fair to both streams: a
// hard-boundary transition counts as a reversal when the label returns to the
// pre-transition value within the next 3 observations. Period-2 round-trips
// (A->B->A) are structurally impossible in published sequences (hysteresis
// forbids them by construction), so raw-vs-published round-trip counts alone
// would be a tautology, not evidence; this metric also catches the delayed
// oscillation (A,A,B,B,A) hysteresis can still produce.
function countHardReversalsWithin3(labels: DecisionLabel[]) {
  let count = 0;
  for (let index = 1; index < labels.length; index += 1) {
    if (!crossesHysteresisHardBoundary(labels[index - 1], labels[index])) continue;
    const previous = labels[index - 1];
    const horizon = Math.min(labels.length - 1, index + 3);
    for (let lookahead = index + 1; lookahead <= horizon; lookahead += 1) {
      if (labels[lookahead] === previous) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

// Matched suppressed-day judgment on IDENTICAL forward windows: was holding
// yesterday's label right, or was the raw flip right?
function judgeSuppressedDay(input: {
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  rawOutcome: string;
  publishedOutcome: string;
}): "hold_right" | "flip_right" | "neutral_or_unknown" {
  if (isHysteresisHard(input.rawLabel)) {
    // Raw wanted to enter a hard action; positive = the hard action was
    // supported by the forward window, so the flip was right.
    if (input.rawOutcome === "positive") return "flip_right";
    if (input.rawOutcome === "negative") return "hold_right";
    return "neutral_or_unknown";
  }
  // Raw wanted to leave a hard action that stayed published; positive = the
  // held hard action was still supported, so the hold was right.
  if (input.publishedOutcome === "positive") return "hold_right";
  if (input.publishedOutcome === "negative") return "flip_right";
  return "neutral_or_unknown";
}

function buildStabilitySummary(input: {
  businesses: BusinessIdentity[];
  stabilityRows: StabilityRow[];
  replayEndDate: string;
  rawCandidates: OutcomeCandidate[];
  rawEpisodes: OutcomeEpisode[];
  publishedCandidates: OutcomeCandidate[];
  publishedEpisodes: OutcomeEpisode[];
}): StabilitySummary {
  const rowsByBusiness = new Map<string, StabilityRow[]>();
  for (const row of input.stabilityRows) {
    const list = rowsByBusiness.get(row.business.id) ?? [];
    list.push(row);
    rowsByBusiness.set(row.business.id, list);
  }

  const perBusiness: StabilityBusinessSummary[] = [];
  const suppressionSamples: SuppressionRecord[] = [];
  for (const business of input.businesses) {
    const rows = rowsByBusiness.get(business.id) ?? [];
    const byCreative = new Map<string, StabilityRow[]>();
    for (const row of rows) {
      const list = byCreative.get(row.creativeId) ?? [];
      list.push(row);
      byCreative.set(row.creativeId, list);
    }
    const summary: StabilityBusinessSummary = {
      business: { id: business.id, name: business.name },
      observations: rows.length,
      rawHardTransitions: 0,
      publishedHardTransitions: 0,
      rawHardRoundTrips: 0,
      rawHardReversalsWithin3: 0,
      publishedHardReversalsWithin3: 0,
      suppressedDays: 0,
      suppressionResolutions: {},
      cutDelaySuppressedDays: 0,
      cutDelayForwardSpend: 0,
      scaleDelaySuppressedDays: 0,
      scaleDelayForwardSpend: 0,
    };
    for (const sequence of byCreative.values()) {
      sequence.sort((left, right) => left.asOfDate.localeCompare(right.asOfDate));
      summary.rawHardTransitions += countHardTransitions(
        sequence.map((row) => row.rawLabel),
      );
      summary.publishedHardTransitions += countHardTransitions(
        sequence.map((row) => row.publishedLabel),
      );
      summary.rawHardRoundTrips += countHardRoundTrips(
        sequence.map((row) => row.rawLabel),
      );
      summary.rawHardReversalsWithin3 += countHardReversalsWithin3(
        sequence.map((row) => row.rawLabel),
      );
      summary.publishedHardReversalsWithin3 += countHardReversalsWithin3(
        sequence.map((row) => row.publishedLabel),
      );
      sequence.forEach((row, index) => {
        if (!row.suppressed) return;
        summary.suppressedDays += 1;
        const next = sequence[index + 1] ?? null;
        const nextIsAdjacent =
          next !== null && diffDays(next.asOfDate, row.asOfDate) === 1;
        // confirmed/reverted claims are next-calendar-day evidence only;
        // gap returns and universe exits are broken out so survivors do not
        // masquerade as next-day confirmations.
        const resolution: SuppressionResolution =
          next === null
            ? row.asOfDate >= input.replayEndDate
              ? "replay_end"
              : "exited_universe"
            : !nextIsAdjacent
              ? "gap_return"
              : next.rawLabel === row.rawLabel
                ? "confirmed"
                : next.rawLabel === row.publishedLabel
                  ? "reverted"
                  : "changed_again";
        increment(summary.suppressionResolutions, resolution);
        // Delay exposure = the NEXT adjacent day's spend (the day that runs
        // under the held label before the transition can confirm). Day-of
        // spend is already sunk when the decision publishes and is not a
        // delay cost.
        const forwardSpend = nextIsAdjacent ? (next?.asOfDateSpend ?? 0) : 0;
        if (row.rawLabel === "cut") {
          summary.cutDelaySuppressedDays += 1;
          summary.cutDelayForwardSpend += forwardSpend;
        } else if (row.rawLabel === "scale") {
          summary.scaleDelaySuppressedDays += 1;
          summary.scaleDelayForwardSpend += forwardSpend;
        }
        if (suppressionSamples.length < 40) {
          suppressionSamples.push({
            business: { id: business.id, name: business.name },
            asOfDate: row.asOfDate,
            creativeId: row.creativeId,
            creativeName: row.creativeName,
            heldLabel: row.publishedLabel,
            rawLabel: row.rawLabel,
            resolution,
            asOfDateSpend: row.asOfDateSpend,
          });
        }
      });
    }
    summary.cutDelayForwardSpend = Math.round(summary.cutDelayForwardSpend * 100) / 100;
    summary.scaleDelayForwardSpend =
      Math.round(summary.scaleDelayForwardSpend * 100) / 100;
    perBusiness.push(summary);
  }

  const global: Omit<StabilityBusinessSummary, "business"> = {
    observations: 0,
    rawHardTransitions: 0,
    publishedHardTransitions: 0,
    rawHardRoundTrips: 0,
    rawHardReversalsWithin3: 0,
    publishedHardReversalsWithin3: 0,
    suppressedDays: 0,
    suppressionResolutions: {},
    cutDelaySuppressedDays: 0,
    cutDelayForwardSpend: 0,
    scaleDelaySuppressedDays: 0,
    scaleDelayForwardSpend: 0,
  };
  for (const summary of perBusiness) {
    global.observations += summary.observations;
    global.rawHardTransitions += summary.rawHardTransitions;
    global.publishedHardTransitions += summary.publishedHardTransitions;
    global.rawHardRoundTrips += summary.rawHardRoundTrips;
    global.rawHardReversalsWithin3 += summary.rawHardReversalsWithin3;
    global.publishedHardReversalsWithin3 += summary.publishedHardReversalsWithin3;
    global.suppressedDays += summary.suppressedDays;
    mergeCountMap(global.suppressionResolutions, summary.suppressionResolutions);
    global.cutDelaySuppressedDays += summary.cutDelaySuppressedDays;
    global.cutDelayForwardSpend += summary.cutDelayForwardSpend;
    global.scaleDelaySuppressedDays += summary.scaleDelaySuppressedDays;
    global.scaleDelayForwardSpend += summary.scaleDelayForwardSpend;
  }
  global.cutDelayForwardSpend = Math.round(global.cutDelayForwardSpend * 100) / 100;
  global.scaleDelayForwardSpend =
    Math.round(global.scaleDelayForwardSpend * 100) / 100;

  // Matched suppressed-day scoring: identical creative, asOf and forward
  // window; only the label differs. This is the primary hold-vs-flip
  // evidence - episode-level raw/published cells re-segment runs and anchor
  // confirmed transitions one day later, so they are NOT a like-for-like
  // comparison and are reported as secondary context only.
  const candidateKey = (candidate: OutcomeCandidate) =>
    [
      candidate.business.id,
      candidate.creativeId,
      candidate.asOfDate,
      candidate.windowDays,
    ].join("::");
  const rawByKey = new Map(input.rawCandidates.map((c) => [candidateKey(c), c]));
  const publishedByKey = new Map(
    input.publishedCandidates.map((c) => [candidateKey(c), c]),
  );
  const matchedByWindow = new Map<OutcomeWindowDays, MatchedSuppressionCell>();
  for (const windowDays of OUTCOME_WINDOWS) {
    matchedByWindow.set(windowDays, {
      windowDays,
      suppressedDays: 0,
      scoredDays: 0,
      holdRight: 0,
      flipRight: 0,
      neutralOrUnknown: 0,
      openWindow: 0,
      pairOutcomes: {},
    });
  }
  for (const row of input.stabilityRows) {
    if (!row.suppressed) continue;
    for (const windowDays of OUTCOME_WINDOWS) {
      const cell = matchedByWindow.get(windowDays);
      if (!cell) continue;
      cell.suppressedDays += 1;
      const key = [row.business.id, row.creativeId, row.asOfDate, windowDays].join(
        "::",
      );
      const raw = rawByKey.get(key);
      const published = publishedByKey.get(key);
      if (!raw || !published) continue;
      if (raw.status === "open_window" || published.status === "open_window") {
        cell.openWindow += 1;
        continue;
      }
      cell.scoredDays += 1;
      const judgment = judgeSuppressedDay({
        rawLabel: row.rawLabel,
        publishedLabel: row.publishedLabel,
        rawOutcome: String(raw.realizedOutcome),
        publishedOutcome: String(published.realizedOutcome),
      });
      if (judgment === "hold_right") cell.holdRight += 1;
      else if (judgment === "flip_right") cell.flipRight += 1;
      else cell.neutralOrUnknown += 1;
      increment(
        cell.pairOutcomes,
        `${row.rawLabel}->${row.publishedLabel}::raw=${raw.realizedOutcome}::pub=${published.realizedOutcome}`,
      );
    }
  }

  return {
    hysteresisEpoch: "clean_epoch_per_business_at_start_date",
    perBusiness,
    global,
    matchedSuppression: Array.from(matchedByWindow.values()),
    suppressionSamples,
    rawOutcomeCells: buildOutcomeCells({
      candidates: input.rawCandidates,
      episodes: input.rawEpisodes,
    }),
    publishedOutcomeCells: buildOutcomeCells({
      candidates: input.publishedCandidates,
      episodes: input.publishedEpisodes,
    }),
    rawCalibrationCells: buildCalibrationCells(input.rawEpisodes),
    publishedCalibrationCells: buildCalibrationCells(input.publishedEpisodes),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  if (!process.env.DB_QUERY_TIMEOUT_MS?.trim()) {
    process.env.DB_QUERY_TIMEOUT_MS = String(args.queryTimeoutMs);
  }

  const dates = dateRange(args.startDate, args.endDate);
  const businesses = await resolveBusinesses(args.businesses);
  const dayResults: DayReplayResult[] = [];
  const decisions: ReplayDecisionRow[] = [];
  const outcomeCandidates: OutcomeCandidate[] = [];
  const publishedOutcomeCandidates: OutcomeCandidate[] = [];
  const stabilityRows: StabilityRow[] = [];
  const fidelity: FidelitySummary[] = [];
  const decisionsByBusinessDate = new Map<string, ReplayDecisionRow[]>();
  const sourceModeByBusinessDate = new Map<string, ReplaySourceMode>();

  for (const business of businesses) {
    if (args.progress) {
      console.error(
        `[historical-replay] business_start name="${business.name}" id=${business.id}`,
      );
    }
    // Clean hysteresis epoch per business at startDate, matching production
    // where the ENGINE_VERSION bump starts with no prior same-version
    // snapshots. State carries across day gaps the same way production
    // readPreviousPublishedLabels reads the latest snapshot before asOf.
    const hysteresisState = new Map<string, PreviousPublishedLabel>();
    for (const asOfDate of dates) {
      const dayStartedAt = Date.now();
      const result = await replayBusinessDay({
        business,
        asOfDate,
        freshnessMode: args.freshnessMode,
      });
      dayResults.push(result.day);
      decisions.push(...result.decisions);
      decisionsByBusinessDate.set(
        businessDateKey(business.id, asOfDate),
        result.decisions,
      );
      if (result.day.sourceMode) {
        sourceModeByBusinessDate.set(
          businessDateKey(business.id, asOfDate),
          result.day.sourceMode.mode,
        );
      }
      outcomeCandidates.push(
        ...(await classifyOutcomesForDay({
          decisions: result.decisions,
          businessId: business.id,
          asOfDate,
          evaluationCeiling: args.evaluationCeiling,
        })),
      );
      // Hysteresis simulation: published label per decision-stability rules.
      // Confidence/metrics stay the raw decision's values, matching
      // production stabilizeDecisionLabel which only swaps the label.
      const stabilizedDecisions = result.decisions.map((row) => {
        const hysteresis = applyLabelHysteresis(
          row.label,
          hysteresisState.get(row.creativeId) ?? null,
        );
        hysteresisState.set(row.creativeId, {
          publishedLabel: hysteresis.publishedLabel,
          rawLabel: hysteresis.rawLabel,
        });
        stabilityRows.push({
          business,
          asOfDate,
          creativeId: row.creativeId,
          creativeName: row.creativeName,
          rawLabel: row.label,
          publishedLabel: hysteresis.publishedLabel,
          suppressed: hysteresis.suppressed,
          asOfDateSpend: row.asOfDateSpend,
        });
        return hysteresis.suppressed
          ? { ...row, label: hysteresis.publishedLabel }
          : row;
      });
      publishedOutcomeCandidates.push(
        ...(await classifyOutcomesForDay({
          decisions: stabilizedDecisions,
          businessId: business.id,
          asOfDate,
          evaluationCeiling: args.evaluationCeiling,
        })),
      );
      if (args.progress) {
        console.error(
          [
            "[historical-replay] day_done",
            `business="${business.name}"`,
            `asOf=${asOfDate}`,
            `status=${result.day.status}`,
            `decisions=${result.day.decisionCount}`,
            `sourceMode=${result.day.sourceMode?.mode ?? "unknown"}`,
            `durationMs=${Date.now() - dayStartedAt}`,
          ].join(" "),
        );
      }
      await sleep(args.sleepMs);
    }
  }

  for (const business of businesses) {
    for (const asOfDate of args.fidelityDates) {
      fidelity.push(
        await buildFidelitySummary({
          business,
          asOfDate,
          replayRows:
            decisionsByBusinessDate.get(businessDateKey(business.id, asOfDate)) ?? [],
          sourceMode:
            sourceModeByBusinessDate.get(businessDateKey(business.id, asOfDate)) ?? null,
          sampleSize: args.sampleSize,
        }),
      );
    }
  }

  const episodes = collectOutcomeEpisodes(outcomeCandidates);
  const publishedEpisodes = collectOutcomeEpisodes(publishedOutcomeCandidates);
  const businessSummaries = buildBusinessSummaries({
    businesses,
    dayResults,
    decisions,
    candidates: outcomeCandidates,
    episodes,
    fidelity,
    sampleSize: args.sampleSize,
  });
  const report: ReplayReport = {
    contractVersion: "adsecute.current-engine-historical-replay.v2",
    generatedAt: new Date().toISOString(),
    currentDate: new Date().toISOString().slice(0, 10),
    readOnly: true,
    mutatesData: false,
    manualCronPosted: false,
    providerWrites: false,
    engineVersion: ENGINE_VERSION,
    classifierVersion: CREATIVE_OUTCOME_CLASSIFIER_VERSION,
    startDate: args.startDate,
    endDate: args.endDate,
    evaluationCeiling: args.evaluationCeiling,
    freshnessMode: args.freshnessMode,
    businessesRequested: args.businesses,
    businessesFound: businesses.length,
    dateCount: dates.length,
    fidelityDates: args.fidelityDates,
    liveStatus: {
      attempted: true,
      source: "live_db_tunnel",
      tunnelHost: "127.0.0.1",
      tunnelPort: 15432,
      readOnly: true,
      tables: [
        "businesses",
        "business_engine_v3_flags",
        "business_target_packs",
        "business_decision_calibration_profiles",
        "engine_v3_account_calibration_daily",
        "engine_v3_creative_lifecycle_daily",
        "engine_v3_decision_snapshots_daily",
        "meta_campaign_labels",
        "meta_creative_daily",
      ],
    },
    methodLimits: [
      "This replay uses the current engine path and does not create a standalone decision core.",
      "Historical freshness mode normalizes freshness to isolate formula behavior; it is analysis-only and not exact production runtime behavior.",
      "June dates can be runtime SQL fallback if no current-version lifecycle rows existed yet; they must not be compared as equal to lifecycle-informed July production rows.",
      "Outcome windows after 2026-06-28 for 7d and after 2026-06-21 for 14d are marked open_window under the 2026-07-05 ceiling.",
      "Closed-window unknown is distinct from open_window and commonly means zero forward spend; it is not counted as a failed hard decision.",
      "Outcome precision/missed-opportunity values are non-causal proxies because historical forward spend was affected by real operator/platform decisions.",
      "Targets are read from current business target packs; target history is not versioned in this replay.",
      "Outcome/calibration cells use the guard-applied surfaced decision.label; blockedActionType is reported separately and is not reclassified as a surfaced hard outcome.",
      "Hard and non-hard positive polarity is never pooled.",
      "Hysteresis is simulated with a clean per-business epoch at startDate and in-memory day-over-day chaining; production chains through persisted raw_label snapshots but applies identical rules.",
      "Suppressed-day published decisions keep the raw decision's confidence and metrics, matching production stabilizeDecisionLabel.",
      "Matched suppressed-day scoring is the primary hold-vs-flip evidence: identical creative/asOf/window on both sides, so censoring and anchoring are symmetric by construction.",
      "Episode-level raw-vs-published cells are secondary context: published sequences re-segment runs, anchor confirmed hard transitions one day later (their windows exclude the trigger day and can cross the evaluation ceiling), and zero-forward-spend unknown-censoring selects different known sets per stream under the historically executed operator actions (off-policy).",
      "Delay exposure sums the NEXT adjacent day's spend on suppressed days (cut and scale separately); it is exposure under historical operator policy, not realized savings or a bound.",
      "Suppression resolutions: confirmed/reverted require a next-calendar-day observation; gap_return, exited_universe and replay_end carry no next-day claim. Universe exit after a suppressed raw cut often means the creative genuinely died - exits are therefore reported, not folded into reverted.",
      "Published period-2 round-trips are structurally zero under hysteresis and are not evidence; the reversal-within-3-observations metric is the fair oscillation comparison.",
      "Replay hard-transition counts are not directly comparable to production decision_changed telemetry (different dedupe surface and universe scoping); use them for raw-vs-published deltas within this replay only.",
      "Raw hard transitions on a creative's final observed day cannot be suppressed-and-confirmed inside the window (right-edge censoring modestly favors the published stream; replay_end counts quantify it).",
      "Fidelity vs persisted snapshots is vacuous for the current ENGINE_VERSION (no persisted rows exist yet); fidelity rows validate the replay pipeline against prior-version dates only.",
      "The published stream re-executes the same outcome-aggregate queries as the raw stream; results are expected identical but mid-run warehouse drift is theoretically possible.",
      "The dedupe comparator was corrected in v2 to match production (highest-priority computation wins); v1 replay artifacts used an inverted comparator and are not comparable.",
    ],
    dayResults,
    dateSummaries: summarizeDateResults(dayResults),
    businessSummaries,
    stabilitySummary: buildStabilitySummary({
      businesses,
      stabilityRows,
      replayEndDate: args.endDate,
      rawCandidates: outcomeCandidates,
      rawEpisodes: episodes,
      publishedCandidates: publishedOutcomeCandidates,
      publishedEpisodes,
    }),
    globalSummary: buildGlobalSummary({
      decisions,
      dayResults,
      candidates: outcomeCandidates,
      episodes,
    }),
  };

  const markdown = renderMarkdown(report);
  const json = jsonForReport(report);

  if (args.writeFiles) {
    const jsonPath = writeTextFile(args.jsonOut, json);
    const mdPath = writeTextFile(args.mdOut, markdown);
    console.log(JSON.stringify({ jsonPath, mdPath }, null, 2));
  } else {
    console.log(json);
  }
}

function businessDateKey(businessId: string, asOfDate: string) {
  return `${businessId}::${asOfDate}`;
}

withOperationalStartupLogsSilenced(main)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    resetDbClientCache();
  });
