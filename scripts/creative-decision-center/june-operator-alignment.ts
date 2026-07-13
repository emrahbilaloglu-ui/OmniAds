#!/usr/bin/env node
// June operator alignment: replayed hard decisions vs organic operator response - READ-ONLY.
//
// Closes the truncated-window gap in OPERATOR_RESPONSE_REPORT_2026-06-01_TO_2026-07-05.md:
// persisted decision snapshots only exist from 2026-07-02, so no persisted hard
// decision had a fully observable 7d forward window. This script replays what the
// CURRENT engine would have decided on a weekly June asOf grid (2026-06-01 /
// 06-08 / 06-15 / 06-22) through the production decide+guard path, keeps the
// guarded hard decisions (cut/scale), and measures the operator's ORGANIC
// response from meta_creative_daily forward windows - all of which are fully
// closed by 2026-07-05.
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/creative-decision-center/june-operator-alignment.ts \
//     [--asOfGrid=2026-06-01,2026-06-08,2026-06-15,2026-06-22] [--evaluationCeiling=2026-07-05] \
//     [--jsonOut=...] [--mdOut=...] [--write=1] [--progress=1]
//
// Read-only stance: SELECT-only DB access, no provider writes, no cron POST,
// no rows written to engine tables. Tiles Workshop is excluded entirely
// (broken feed; user directive to exclude sync-problem businesses).
//
// Runtime pattern copied from automatic-mode-decision-diff.ts (production
// decide+guard path); historical freshness normalization and production dedupe
// copied from current-engine-historical-replay.ts; measurability/baseline/
// truncation semantics copied from operator-response-report.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  withCreativeCampaignLabelContext,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { composeDataHealth } from "@/lib/creative-decision-engine/data-health";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import { listEnabledBusinessIds } from "@/lib/creative-decision-engine/feature-flags";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import { normalizePostgresDate } from "@/lib/creative-decision-engine/simulation/calendar-date";
import {
  ENGINE_VERSION,
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

const DEFAULT_ASOF_GRID = [
  "2026-06-01",
  "2026-06-08",
  "2026-06-15",
  "2026-06-22",
] as const;
const DEFAULT_EVALUATION_CEILING = "2026-07-05";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/june-operator-alignment-2026-06.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/JUNE_OPERATOR_ALIGNMENT_2026-06.md";

/** Businesses excluded entirely (broken feed / sync problems; user directive). */
const EXCLUDED_BUSINESS_NAMES = new Set(["tiles workshop"]);

/** Response windows under evaluation (days after the replayed decision date). */
const RESPONSE_WINDOWS_DAYS = [1, 3, 7] as const;
/** Cut response: forward daily spend below this fraction of baseline daily spend. */
const CUT_SPEND_DROP_FRACTION = 0.1;
/** Scale response (crude proxy): forward mean daily spend above baseline by this factor. */
const SCALE_SPEND_RISE_FACTOR = 1.25;
/** Outcome window mirrored from DECISION_OUTCOME_WINDOWS_DAYS[0] (decision-outcomes-job). */
const OUTCOME_WINDOW_DAYS = 7;
const ACTIVE_STATUS = "ACTIVE";

const HARD_LABELS: ReadonlySet<DecisionLabel> = new Set(["cut", "scale"]);

// ---------------------------------------------------------------------------
// Small utilities (conventions shared with operator-response-report.ts)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type HardLabel = "cut" | "scale";

interface ParsedArgs {
  asOfGrid: string[];
  evaluationCeiling: string;
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
  progress: boolean;
  queryTimeoutMs: number;
  sleepMs: number;
}

function arg(argv: string[], name: string, fallback: string) {
  const prefix = `--${name}=`;
  return (
    argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const asOfGrid = arg(argv, "asOfGrid", DEFAULT_ASOF_GRID.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
  if (asOfGrid.length === 0 || asOfGrid.some((date) => !isIsoDate(date))) {
    throw new Error("--asOfGrid must be a comma-separated list of ISO dates.");
  }
  const evaluationCeiling = arg(
    argv,
    "evaluationCeiling",
    DEFAULT_EVALUATION_CEILING,
  );
  if (!isIsoDate(evaluationCeiling)) {
    throw new Error("--evaluationCeiling must be an ISO date.");
  }
  return {
    asOfGrid,
    evaluationCeiling,
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
    progress: arg(argv, "progress", "1") !== "0",
    queryTimeoutMs: Math.max(
      1_000,
      Number(arg(argv, "queryTimeoutMs", "120000")) || 120_000,
    ),
    sleepMs: Math.max(0, Number(arg(argv, "sleepMs", "75")) || 0),
  };
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

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ratioText(numerator: number, denominator: number) {
  const pct =
    denominator > 0 ? ` (${round2((numerator / denominator) * 100)}%)` : "";
  return `${numerator}/${denominator}${pct}`;
}

function writeTextFile(path: string, content: string) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// ---------------------------------------------------------------------------
// Historical replay fidelity helpers
// (copied from current-engine-historical-replay.ts, freshnessMode=historical)
// ---------------------------------------------------------------------------

/**
 * Warehouse freshness is computed against wall-clock now(), so a June asOf
 * replayed in July reads as hundreds of hours stale and the gates would
 * spuriously demote/block hard actions. Historical replay normalizes staleness
 * away, exactly like current-engine-historical-replay.ts freshnessMode
 * "historical" (the mode used for all June replay evidence).
 */
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
      input.dataFreshnessHours === null
        ? null
        : Math.min(input.dataFreshnessHours, 6),
  }));
}

// Must mirror compareDecisionComputations in jobs/decisions-job.ts exactly:
// left-minus-right, so the dedupe keeps the HIGHEST-priority computation
// (cut beats keep), as production does.
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

function compareDecisionOutputs(
  left: { input: CreativeInput; decision: DecisionOutput },
  right: { input: CreativeInput; decision: DecisionOutput },
) {
  return (
    decisionLabelPriority(left.decision.label) -
      decisionLabelPriority(right.decision.label) ||
    Math.round(left.decision.confidence) -
      Math.round(right.decision.confidence) ||
    (Number.isFinite(left.input.spend) ? left.input.spend : 0) -
      (Number.isFinite(right.input.spend) ? right.input.spend : 0) ||
    (left.input.campaignId ?? "").localeCompare(right.input.campaignId ?? "")
  );
}

function dedupeDecisionComputations(
  computations: Array<{ input: CreativeInput; decision: DecisionOutput }>,
) {
  const byCreativeId = new Map<
    string,
    { input: CreativeInput; decision: DecisionOutput }
  >();
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

// ---------------------------------------------------------------------------
// Replay: what the engine WOULD have decided on each June grid date
// ---------------------------------------------------------------------------

interface BusinessIdentity {
  id: string;
  name: string;
  isDemoBusiness: boolean;
}

interface ReplayHardDecision {
  businessId: string;
  businessName: string;
  isDemoBusiness: boolean;
  creativeId: string;
  creativeName: string | null;
  campaignId: string | null;
  label: HardLabel;
  asOf: string;
  confidence: number;
  spend28d: number;
  spend24h: number | null;
  reason: string;
}

interface DayReplaySummary {
  businessName: string;
  asOf: string;
  status: "ok" | "failed";
  inputRows: number;
  dedupedDecisions: number;
  labels: Record<string, number>;
  errorMessage?: string;
}

async function listIncludedBusinesses(): Promise<{
  included: BusinessIdentity[];
  excluded: BusinessIdentity[];
}> {
  const enabledIds = await listEnabledBusinessIds();
  if (enabledIds.length === 0) return { included: [], excluded: [] };
  const rows = await getDb().query<Row>(
    `
    SELECT id::text AS id, name, COALESCE(is_demo_business, FALSE) AS is_demo_business
    FROM businesses
    WHERE id::text = ANY($1::text[])
    ORDER BY name ASC, id ASC
    `,
    [enabledIds],
  );
  const included: BusinessIdentity[] = [];
  const excluded: BusinessIdentity[] = [];
  for (const row of rows) {
    const id = toText(row.id);
    const name = toText(row.name);
    if (!id || !name) continue;
    const identity: BusinessIdentity = {
      id,
      name,
      isDemoBusiness: row.is_demo_business === true,
    };
    if (EXCLUDED_BUSINESS_NAMES.has(name.toLowerCase())) excluded.push(identity);
    else included.push(identity);
  }
  return { included, excluded };
}

async function replayBusinessDay(input: {
  business: BusinessIdentity;
  asOf: string;
  source: WarehouseDataSource;
}): Promise<{ day: DayReplaySummary; hardDecisions: ReplayHardDecision[] }> {
  const { business, asOf, source } = input;
  try {
    const rawInputs = await source.listCreativeInputs({
      businessId: business.id,
      asOf,
    });
    const creativeInputs = normalizeCreativeInputsForHistoricalReplay(rawInputs);
    const profile = await resolveAccountDecisionProfile({
      businessId: business.id,
      asOf,
      dataSource: source,
    });
    const rawDataHealth = await source.getDataHealth({
      businessId: business.id,
      asOf,
    });
    const dataHealth = normalizeDataHealthForHistoricalReplay(
      rawDataHealth,
      asOf,
    );
    const labelMap = buildCreativeCampaignLabelMap(
      await readMetaCampaignLabels({ businessId: business.id }),
    );

    const computations = creativeInputs.map((creativeInput) => {
      const enriched = withCreativeCampaignLabelContext(creativeInput, labelMap);
      const decision = applyCreativeCampaignLabelGuard({
        decision: decideCreative(enriched, profile, dataHealth),
        input: enriched,
        campaignLabelsById: labelMap,
      });
      return { input: enriched, decision };
    });
    const deduped = dedupeDecisionComputations(computations);

    const labels: Record<string, number> = {};
    const hardDecisions: ReplayHardDecision[] = [];
    for (const { input: creativeInput, decision } of deduped) {
      labels[decision.label] = (labels[decision.label] ?? 0) + 1;
      if (!HARD_LABELS.has(decision.label)) continue;
      hardDecisions.push({
        businessId: business.id,
        businessName: business.name,
        isDemoBusiness: business.isDemoBusiness,
        creativeId: creativeInput.creativeId,
        creativeName: creativeInput.creativeName ?? null,
        campaignId: creativeInput.campaignId ?? null,
        label: decision.label as HardLabel,
        asOf,
        confidence: Math.round(decision.confidence),
        spend28d: round2(toNumber(creativeInput.spend)),
        spend24h:
          creativeInput.spend24h === null || creativeInput.spend24h === undefined
            ? null
            : round2(toNumber(creativeInput.spend24h)),
        reason: decision.reason.slice(0, 200),
      });
    }
    return {
      day: {
        businessName: business.name,
        asOf,
        status: "ok",
        inputRows: creativeInputs.length,
        dedupedDecisions: deduped.length,
        labels,
      },
      hardDecisions,
    };
  } catch (error) {
    return {
      day: {
        businessName: business.name,
        asOf,
        status: "failed",
        inputRows: 0,
        dedupedDecisions: 0,
        labels: {},
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      hardDecisions: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Forward-window measurement (semantics copied from operator-response-report.ts)
// ---------------------------------------------------------------------------

/**
 * Per-business meta_creative_daily data ceiling. Forward windows are only
 * observable up to this date; anything beyond is truncated, not zero.
 */
const BUSINESS_DATA_CEILING_QUERY = `
SELECT
  COALESCE(d.business_ref_id::text, d.business_id) AS business_key,
  MAX(d.date)::text AS max_date
FROM meta_creative_daily d
WHERE d.business_ref_id::text = ANY($1::text[]) OR d.business_id = ANY($1::text[])
GROUP BY COALESCE(d.business_ref_id::text, d.business_id)
`;

/**
 * Daily spend/status series for one creative (sum spend per date, latest
 * non-null effective_status per date), business join widened to
 * (business_ref_id OR business_id) exactly like the decision-outcomes job.
 */
const DAILY_SPEND_SERIES_QUERY = `
SELECT
  d.date::text AS date,
  SUM(d.spend)::double precision AS spend,
  (ARRAY_AGG(d.effective_status ORDER BY d.updated_at DESC NULLS LAST)
    FILTER (WHERE d.effective_status IS NOT NULL))[1] AS effective_status
FROM meta_creative_daily d
WHERE (d.business_ref_id::text = $1 OR d.business_id = $1)
  AND d.creative_id = $2
  AND d.date BETWEEN $3::date AND $4::date
GROUP BY d.date
ORDER BY d.date ASC
`;

interface DailyPoint {
  date: string;
  spend: number;
  effectiveStatus: string | null;
}

type MeasurabilityBucket =
  | "measurable"
  | "zero_spend_at_decision"
  | "unobservable_forward_window";

interface CohortDecision extends ReplayHardDecision {
  /** Number of grid asOf dates on which the replay produced this (creative, label). */
  gridAppearances: number;
  /** All grid asOf dates carrying the hard label (first one is the decision date). */
  gridDates: string[];
}

interface MeasuredDecision extends CohortDecision {
  dataCeiling: string | null;
  completeDataCeiling: string | null;
  bucket: MeasurabilityBucket;
  decisionDaySpend: number;
  trailing7dMeanDailySpend: number;
  baselineDailySpend: number | null;
  baselineSource: "decision_day_spend" | "trailing_7d_mean" | null;
  observableForwardDays: number;
  forwardDays: Array<{
    day: number;
    date: string;
    spend: number;
    effectiveStatus: string | null;
  }>;
  firstResponseDay: number | null;
  responseSignal: "spend_drop" | "status_left_active" | null;
  respondedWithinObservable: boolean;
  /** Per window: null => window truncated by the data ceiling (not evaluable). */
  respondedWithin: Record<number, boolean | null>;
  scaleRespondedWithin: Record<number, boolean | null>;
  forwardOutcomeWindowSpend: number;
  outcomeWindowTruncated: boolean;
  wouldBeUnknownViaZeroForwardSpend: boolean;
}

async function measureDecision(
  decision: CohortDecision,
  dataCeiling: string | null,
  completeDataCeiling: string | null,
): Promise<MeasuredDecision> {
  const seriesEnd =
    completeDataCeiling === null
      ? decision.asOf
      : [addDays(decision.asOf, OUTCOME_WINDOW_DAYS), completeDataCeiling].sort()[0];
  const rows = await getDb().query<Row>(DAILY_SPEND_SERIES_QUERY, [
    decision.businessId,
    decision.creativeId,
    addDays(decision.asOf, -6),
    seriesEnd,
  ]);
  const byDate = new Map<string, DailyPoint>();
  for (const row of rows) {
    const date = normalizePostgresDate(row.date);
    if (!date) continue;
    byDate.set(date, {
      date,
      spend: toNumber(row.spend),
      effectiveStatus: toText(row.effective_status),
    });
  }

  const decisionDaySpend = byDate.get(decision.asOf)?.spend ?? 0;
  let trailingTotal = 0;
  for (let offset = -6; offset <= 0; offset += 1) {
    trailingTotal += byDate.get(addDays(decision.asOf, offset))?.spend ?? 0;
  }
  const trailing7dMeanDailySpend = trailingTotal / 7;

  const baselineDailySpend =
    decisionDaySpend > 0
      ? decisionDaySpend
      : trailing7dMeanDailySpend > 0
        ? trailing7dMeanDailySpend
        : null;
  const baselineSource =
    decisionDaySpend > 0
      ? ("decision_day_spend" as const)
      : trailing7dMeanDailySpend > 0
        ? ("trailing_7d_mean" as const)
        : null;

  const observableForwardDays =
    completeDataCeiling === null
      ? 0
      : Math.max(
          0,
          Math.min(
            OUTCOME_WINDOW_DAYS,
            diffDays(completeDataCeiling, decision.asOf),
          ),
        );

  // Missing rows inside the observable window mean zero delivery (zero spend),
  // matching the decision-outcomes job COALESCE(SUM(spend), 0) semantics.
  const forwardDays = Array.from({ length: observableForwardDays }, (_, index) => {
    const day = index + 1;
    const date = addDays(decision.asOf, day);
    const point = byDate.get(date);
    return {
      day,
      date,
      spend: point?.spend ?? 0,
      effectiveStatus: point?.effectiveStatus ?? null,
    };
  });

  const bucket: MeasurabilityBucket =
    observableForwardDays === 0
      ? "unobservable_forward_window"
      : baselineDailySpend === null
        ? "zero_spend_at_decision"
        : "measurable";

  let firstResponseDay: number | null = null;
  let responseSignal: MeasuredDecision["responseSignal"] = null;
  if (bucket === "measurable" && baselineDailySpend !== null) {
    for (const forward of forwardDays) {
      const spendDrop =
        forward.spend < baselineDailySpend * CUT_SPEND_DROP_FRACTION;
      const statusLeftActive =
        forward.effectiveStatus !== null &&
        forward.effectiveStatus !== ACTIVE_STATUS;
      if (spendDrop || statusLeftActive) {
        firstResponseDay = forward.day;
        responseSignal = spendDrop ? "spend_drop" : "status_left_active";
        break;
      }
    }
  }

  const respondedWithin: Record<number, boolean | null> = {};
  const scaleRespondedWithin: Record<number, boolean | null> = {};
  for (const windowDays of RESPONSE_WINDOWS_DAYS) {
    if (bucket !== "measurable" || observableForwardDays < windowDays) {
      respondedWithin[windowDays] = null;
      scaleRespondedWithin[windowDays] = null;
      continue;
    }
    respondedWithin[windowDays] =
      firstResponseDay !== null && firstResponseDay <= windowDays;
    const windowSpend = forwardDays
      .filter((forward) => forward.day <= windowDays)
      .reduce((sum, forward) => sum + forward.spend, 0);
    scaleRespondedWithin[windowDays] =
      baselineDailySpend !== null &&
      windowSpend / windowDays > baselineDailySpend * SCALE_SPEND_RISE_FACTOR;
  }

  const forwardOutcomeWindowSpend = forwardDays.reduce(
    (sum, forward) => sum + forward.spend,
    0,
  );

  return {
    ...decision,
    dataCeiling,
    completeDataCeiling,
    bucket,
    decisionDaySpend: round2(decisionDaySpend),
    trailing7dMeanDailySpend: round2(trailing7dMeanDailySpend),
    baselineDailySpend:
      baselineDailySpend === null ? null : round2(baselineDailySpend),
    baselineSource,
    observableForwardDays,
    forwardDays: forwardDays.map((forward) => ({
      ...forward,
      spend: round2(forward.spend),
    })),
    firstResponseDay,
    responseSignal,
    respondedWithinObservable: firstResponseDay !== null,
    respondedWithin,
    scaleRespondedWithin,
    forwardOutcomeWindowSpend: round2(forwardOutcomeWindowSpend),
    outcomeWindowTruncated: observableForwardDays < OUTCOME_WINDOW_DAYS,
    wouldBeUnknownViaZeroForwardSpend:
      observableForwardDays > 0 && forwardOutcomeWindowSpend <= 0,
  };
}

// ---------------------------------------------------------------------------
// Aggregation (copied from operator-response-report.ts, "response" read as
// organic alignment because the operator never saw these replayed decisions)
// ---------------------------------------------------------------------------

interface WindowStat {
  windowDays: number;
  evaluable: number;
  responded: number;
  responseRate: number | null;
  truncated: number;
}

function windowStats(
  decisions: MeasuredDecision[],
  pick: (decision: MeasuredDecision) => Record<number, boolean | null>,
): WindowStat[] {
  return RESPONSE_WINDOWS_DAYS.map((windowDays) => {
    const evaluableRows = decisions.filter(
      (decision) => pick(decision)[windowDays] !== null,
    );
    const responded = evaluableRows.filter(
      (decision) => pick(decision)[windowDays] === true,
    ).length;
    return {
      windowDays,
      evaluable: evaluableRows.length,
      responded,
      responseRate:
        evaluableRows.length > 0
          ? round4(responded / evaluableRows.length)
          : null,
      truncated: decisions.length - evaluableRows.length,
    };
  });
}

function summarizeGroup(decisions: MeasuredDecision[]) {
  const cuts = decisions.filter((decision) => decision.label === "cut");
  const scales = decisions.filter((decision) => decision.label === "scale");
  const measurableCuts = cuts.filter(
    (decision) => decision.bucket === "measurable",
  );
  const measurableScales = scales.filter(
    (decision) => decision.bucket === "measurable",
  );
  const respondedCuts = measurableCuts.filter(
    (decision) => decision.respondedWithinObservable,
  );
  const unrespondedCuts = measurableCuts.filter(
    (decision) => !decision.respondedWithinObservable,
  );
  const unknownViaZeroSpend = respondedCuts.filter(
    (decision) => decision.wouldBeUnknownViaZeroForwardSpend,
  );

  return {
    decisions: decisions.length,
    cuts: {
      total: cuts.length,
      measurable: measurableCuts.length,
      zeroSpendAtDecision: cuts.filter(
        (decision) => decision.bucket === "zero_spend_at_decision",
      ).length,
      unobservableForwardWindow: cuts.filter(
        (decision) => decision.bucket === "unobservable_forward_window",
      ).length,
      respondedWithinObservable: respondedCuts.length,
      byWindow: windowStats(measurableCuts, (d) => d.respondedWithin),
      medianDaysToResponse: median(
        respondedCuts
          .map((decision) => decision.firstResponseDay)
          .filter((day): day is number => day !== null),
      ),
      spendAfterUnrespondedCutsFull7d: round2(
        unrespondedCuts.reduce(
          (sum, decision) => sum + decision.forwardOutcomeWindowSpend,
          0,
        ),
      ),
      unrespondedCutCount: unrespondedCuts.length,
      unknownOutcomeInteraction: {
        respondedCuts: respondedCuts.length,
        respondedCutsWithZeroForwardSpend: unknownViaZeroSpend.length,
        unknownOutcomeShareOfRespondedCuts:
          respondedCuts.length > 0
            ? round4(unknownViaZeroSpend.length / respondedCuts.length)
            : null,
      },
    },
    scales: {
      total: scales.length,
      measurable: measurableScales.length,
      zeroSpendAtDecision: scales.filter(
        (decision) => decision.bucket === "zero_spend_at_decision",
      ).length,
      unobservableForwardWindow: scales.filter(
        (decision) => decision.bucket === "unobservable_forward_window",
      ).length,
      byWindow: windowStats(measurableScales, (d) => d.scaleRespondedWithin),
    },
  };
}

type GroupSummary = ReturnType<typeof summarizeGroup>;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const args = parseArgs(process.argv.slice(2));
  process.env.DB_QUERY_TIMEOUT_MS = String(args.queryTimeoutMs);
  const generatedAt = new Date().toISOString();
  const runDate = generatedAt.slice(0, 10);
  const startedAtMs = Date.now();
  const progress = (message: string) => {
    if (args.progress) {
      console.error(
        `[june-operator-alignment +${Math.round((Date.now() - startedAtMs) / 1000)}s] ${message}`,
      );
    }
  };

  const source = new WarehouseDataSource();
  const { included, excluded } = await listIncludedBusinesses();
  progress(
    `businesses: ${included.length} included, ${excluded.length} excluded (${excluded
      .map((business) => business.name)
      .join(", ") || "none"})`,
  );

  // 1) Replay the production decide+guard path on each grid asOf.
  const dayResults: DayReplaySummary[] = [];
  const allHardDecisions: ReplayHardDecision[] = [];
  for (const asOf of args.asOfGrid) {
    for (const business of included) {
      const { day, hardDecisions } = await replayBusinessDay({
        business,
        asOf,
        source,
      });
      dayResults.push(day);
      allHardDecisions.push(...hardDecisions);
      progress(
        `asOf=${asOf} business=${business.name} status=${day.status} inputs=${day.inputRows} decisions=${day.dedupedDecisions} hard=${hardDecisions.length}${day.errorMessage ? ` error=${day.errorMessage}` : ""}`,
      );
      await sleep(args.sleepMs);
    }
  }

  // 2) Grid dedupe: a creative counts once per (business, creative, label),
  //    keeping the FIRST grid asOf where the hard label appears.
  const cohortByKey = new Map<string, CohortDecision>();
  for (const decision of allHardDecisions) {
    const key = `${decision.businessId}|${decision.creativeId}|${decision.label}`;
    const existing = cohortByKey.get(key);
    if (!existing) {
      cohortByKey.set(key, {
        ...decision,
        gridAppearances: 1,
        gridDates: [decision.asOf],
      });
      continue;
    }
    existing.gridAppearances += 1;
    existing.gridDates.push(decision.asOf);
  }
  const cohort = [...cohortByKey.values()].sort(
    (left, right) =>
      left.businessName.localeCompare(right.businessName) ||
      left.asOf.localeCompare(right.asOf) ||
      left.creativeId.localeCompare(right.creativeId),
  );
  progress(
    `cohort: ${allHardDecisions.length} hard decision rows across the grid -> ${cohort.length} deduped (business, creative, label) decisions`,
  );

  // 3) Data ceilings; a raw ceiling >= run date is an intraday partial ingest
  //    (operator-response-report lesson), so last complete day = ceiling - 1;
  //    additionally capped at the evaluation ceiling for determinism.
  const businessIds = [...new Set(cohort.map((decision) => decision.businessId))];
  const ceilingRows =
    businessIds.length === 0
      ? []
      : await getDb().query<Row>(BUSINESS_DATA_CEILING_QUERY, [businessIds]);
  const rawCeilings = new Map<string, string>();
  for (const row of ceilingRows) {
    const key = toText(row.business_key);
    const maxDate = normalizePostgresDate(row.max_date);
    if (key && maxDate) rawCeilings.set(key, maxDate);
  }
  const completeCeiling = (raw: string | null) => {
    if (raw === null) return null;
    const lastComplete = raw >= runDate ? addDays(raw, -1) : raw;
    return lastComplete < args.evaluationCeiling
      ? lastComplete
      : args.evaluationCeiling;
  };

  // 4) Measure organic operator response over the full forward windows.
  const measured: MeasuredDecision[] = [];
  for (const decision of cohort) {
    const rawCeiling = rawCeilings.get(decision.businessId) ?? null;
    measured.push(
      await measureDecision(decision, rawCeiling, completeCeiling(rawCeiling)),
    );
  }
  progress(`measured ${measured.length} decisions`);

  const businessNames = [
    ...new Set(measured.map((decision) => decision.businessName)),
  ].sort();
  const byBusiness = businessNames.map((businessName) => {
    const businessDecisions = measured.filter(
      (decision) => decision.businessName === businessName,
    );
    return {
      business: businessName,
      isDemoBusiness: businessDecisions[0]?.isDemoBusiness ?? false,
      dataCeiling: businessDecisions[0]?.dataCeiling ?? null,
      completeDataCeiling: businessDecisions[0]?.completeDataCeiling ?? null,
      summary: summarizeGroup(businessDecisions),
    };
  });
  const overall = summarizeGroup(measured);

  const gridSummaries = args.asOfGrid.map((asOf) => {
    const days = dayResults.filter((day) => day.asOf === asOf);
    const hardRows = allHardDecisions.filter(
      (decision) => decision.asOf === asOf,
    );
    return {
      asOf,
      businessesOk: days.filter((day) => day.status === "ok").length,
      businessesFailed: days.filter((day) => day.status === "failed").length,
      inputRows: days.reduce((sum, day) => sum + day.inputRows, 0),
      dedupedDecisions: days.reduce((sum, day) => sum + day.dedupedDecisions, 0),
      hardCut: hardRows.filter((decision) => decision.label === "cut").length,
      hardScale: hardRows.filter((decision) => decision.label === "scale")
        .length,
      newInCohort: cohort.filter((decision) => decision.asOf === asOf).length,
    };
  });

  const methodLimits = [
    "Read-only analysis: SELECT-only DB access through the read_only_observation lane; no engine tables written, no provider writes, no cron POST, no jobs executed.",
    `NON-CAUSAL REPLAY: decisions are recomputed with the CURRENT engine code (${ENGINE_VERSION}) and CURRENT configuration over historical June inputs. Target packs, decision calibration profile config, feature flags, and Meta campaign labels have NO historical versioning and are read as of the run date - an anachronistic-target caveat: these are the decisions today's engine WOULD have made in June, not decisions any system actually made (persisted snapshots only exist from 2026-07-02).`,
    "THE OPERATOR NEVER SAW THESE DECISIONS. 'Response' here is ORGANIC AGREEMENT with what the engine would have said, not compliance. Read it as bounds, not compliance: the organic cut-agreement rate approximates the no-tool baseline and is a plausible LOWER bound on compliance if the decisions had been surfaced; spend-after-unagreed-cuts is an UPPER bound on the spend the engine's cut advice could have avoided (it assumes every replayed cut was correct and would have been executed immediately).",
    "Historical freshness normalization (mirrored from current-engine-historical-replay.ts freshnessMode=historical): warehouse freshness is computed against wall-clock now(), so June inputs read as weeks stale; data-health stale tiers are normalized to 'none' and per-creative dataFreshnessHours capped at 6h. Without this the gates would spuriously demote/block hard actions and the replay would be meaningless.",
    "Production dedupe mirrored from jobs/decisions-job.ts compareDecisionComputations: one decision per creative per asOf, keeping the highest-priority computation (cut beats scale beats keep ...).",
    "Grid dedupe: a creative counts once per (business, creative, label), keyed to the FIRST grid asOf where the hard label appears (gridAppearances records recurrence). The weekly grid (2026-06-01/08/15/22) undersamples decision churn between grid dates; a creative that became hard-labeled only between grid dates is missed, and the 'decision date' is the grid date, not the first date the engine would have flipped.",
    "Baseline daily spend = decision-day spend when positive (spend24h semantics via the meta_creative_daily series), else the trailing 7-day mean daily spend; decisions with no baseline are bucketed zero_spend_at_decision and excluded from response-rate denominators (semantics copied from operator-response-report.ts).",
    "Cut response = forward daily spend < 10% of baseline OR effective_status leaves ACTIVE. Missing forward rows inside the observable window count as zero spend (decision-outcomes COALESCE semantics). Spend-based responses cannot distinguish operator action from Meta delivery collapse; treat as operator-or-delivery response.",
    "Scale response is a CRUDE PROXY: mean forward daily spend over the window > 125% of baseline daily spend; it does not verify budget changes or action-journal receipts.",
    `Forward windows are truncated at min(last complete meta_creative_daily day, evaluation ceiling ${args.evaluationCeiling}); a raw ceiling >= the run date is an intraday partial ingest and is excluded (operator-response-report partial-day lesson). With the June grid every 7d window closes by ${addDays(args.asOfGrid[args.asOfGrid.length - 1], OUTCOME_WINDOW_DAYS)}, so 1/3/7d windows are fully observable for every business whose feed reaches the ceiling.`,
    "Tiles Workshop is EXCLUDED entirely (broken feed / stale warehouse sync; user directive to exclude sync-problem businesses).",
    "Unknown-outcome interaction mirrors the outcome-classifier rule missing_outcome_spend_or_target: zero forward spend over the full 7d outcome window => realized_outcome 'unknown'. With fully closed windows this is now a final share, not observed-so-far.",
  ];

  const report = {
    title:
      "June Operator Alignment - replayed hard decisions (weekly June grid) vs organic operator response, full 7d windows",
    generatedAt,
    liveStatus: "live_db_read_only",
    readOnly: true,
    dbWrites: false,
    providerWrites: false,
    cronPosted: false,
    jobsExecuted: false,
    engineVersion: ENGINE_VERSION,
    asOfGrid: args.asOfGrid,
    evaluationCeiling: args.evaluationCeiling,
    responseWindowsDays: [...RESPONSE_WINDOWS_DAYS],
    outcomeWindowDays: OUTCOME_WINDOW_DAYS,
    cutSpendDropFraction: CUT_SPEND_DROP_FRACTION,
    scaleSpendRiseFactor: SCALE_SPEND_RISE_FACTOR,
    businesses: {
      included: included.map((business) => business.name),
      excluded: excluded.map((business) => ({
        name: business.name,
        reason: "broken feed / sync problem (user directive)",
      })),
    },
    gridSummaries,
    cohort: {
      hardDecisionRowsAcrossGrid: allHardDecisions.length,
      dedupedDecisions: cohort.length,
      cuts: cohort.filter((decision) => decision.label === "cut").length,
      scales: cohort.filter((decision) => decision.label === "scale").length,
      recurring: cohort.filter((decision) => decision.gridAppearances > 1)
        .length,
    },
    businessDataCeilings: Object.fromEntries(
      byBusiness.map((business) => [
        business.business,
        {
          raw: business.dataCeiling,
          lastCompleteDayUsed: business.completeDataCeiling,
        },
      ]),
    ),
    overall,
    byBusiness,
    decisions: measured,
    failedDays: dayResults.filter((day) => day.status === "failed"),
    methodLimits,
  };

  const markdown = renderMarkdown(report);
  if (args.writeFiles) {
    const jsonPath = writeTextFile(
      args.jsonOut,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    const mdPath = writeTextFile(args.mdOut, markdown);
    console.log(
      JSON.stringify(
        {
          jsonPath,
          mdPath,
          cohort: report.cohort,
          overallCuts: {
            byWindow: overall.cuts.byWindow,
            spendAfterUnrespondedCutsFull7d:
              overall.cuts.spendAfterUnrespondedCutsFull7d,
            unknownOutcomeInteraction: overall.cuts.unknownOutcomeInteraction,
          },
          overallScales: { byWindow: overall.scales.byWindow },
          failedDays: report.failedDays.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  await resetDbClientCache();
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

interface ReportShape {
  title: string;
  generatedAt: string;
  liveStatus: string;
  engineVersion: string;
  asOfGrid: string[];
  evaluationCeiling: string;
  responseWindowsDays: number[];
  outcomeWindowDays: number;
  cutSpendDropFraction: number;
  scaleSpendRiseFactor: number;
  businesses: {
    included: string[];
    excluded: Array<{ name: string; reason: string }>;
  };
  gridSummaries: Array<{
    asOf: string;
    businessesOk: number;
    businessesFailed: number;
    inputRows: number;
    dedupedDecisions: number;
    hardCut: number;
    hardScale: number;
    newInCohort: number;
  }>;
  cohort: {
    hardDecisionRowsAcrossGrid: number;
    dedupedDecisions: number;
    cuts: number;
    scales: number;
    recurring: number;
  };
  businessDataCeilings: Record<
    string,
    { raw: string | null; lastCompleteDayUsed: string | null }
  >;
  overall: GroupSummary;
  byBusiness: Array<{
    business: string;
    isDemoBusiness: boolean;
    dataCeiling: string | null;
    completeDataCeiling: string | null;
    summary: GroupSummary;
  }>;
  decisions: MeasuredDecision[];
  failedDays: DayReplaySummary[];
  methodLimits: string[];
}

function renderWindowTable(lines: string[], stats: WindowStat[]) {
  lines.push("| Window | Evaluable | Responded | Rate | Truncated |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const stat of stats) {
    lines.push(
      `| ${stat.windowDays}d | ${stat.evaluable} | ${stat.responded} | ${
        stat.responseRate === null
          ? "n/a"
          : `${round2(stat.responseRate * 100)}%`
      } | ${stat.truncated} |`,
    );
  }
}

function renderGroupSummary(lines: string[], summary: GroupSummary) {
  const cuts = summary.cuts;
  lines.push(
    `- cuts: ${cuts.total} total; ${cuts.measurable} measurable, ${cuts.zeroSpendAtDecision} zero-spend-at-decision, ${cuts.unobservableForwardWindow} unobservable (data ceiling)`,
  );
  lines.push(
    `- organic cut response (any day in 7d window): ${ratioText(cuts.respondedWithinObservable, cuts.measurable)}; median days-to-response: ${cuts.medianDaysToResponse ?? "n/a"}`,
  );
  lines.push("");
  lines.push("Organic cut response by window (all windows fully observable):");
  lines.push("");
  renderWindowTable(lines, cuts.byWindow);
  lines.push("");
  lines.push(
    `- spend after unresponded cuts (FULL 7d forward window): ${cuts.spendAfterUnrespondedCutsFull7d} across ${cuts.unrespondedCutCount} unresponded cuts`,
  );
  const unknown = cuts.unknownOutcomeInteraction;
  lines.push(
    `- unknown-outcome interaction: ${ratioText(unknown.respondedCutsWithZeroForwardSpend, unknown.respondedCuts)} of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)`,
  );
  const scales = summary.scales;
  lines.push(
    `- scales: ${scales.total} total; ${scales.measurable} measurable, ${scales.zeroSpendAtDecision} zero-spend-at-decision, ${scales.unobservableForwardWindow} unobservable`,
  );
  if (scales.total > 0) {
    lines.push("");
    lines.push("Organic scale response by window (crude spend-rise proxy):");
    lines.push("");
    renderWindowTable(lines, scales.byWindow);
  }
  lines.push("");
}

function renderMarkdown(report: ReportShape): string {
  const lines: string[] = [];
  lines.push(`# ${report.title}`);
  lines.push("");
  lines.push(
    "Read-only companion to OPERATOR_RESPONSE_REPORT_2026-06-01_TO_2026-07-05.md: that report's persisted hard decisions all fell on 2026-07-02..05, so no full 7d forward window existed. Here the CURRENT engine replays what its hard decisions WOULD have been on a weekly June asOf grid, and June forward spend is complete through the evaluation ceiling - every 1/3/7d window is fully observable. The operator never saw these decisions; rates measure ORGANIC agreement, not compliance. No DB writes, no provider writes, no cron POST.",
  );
  lines.push("");
  lines.push("## Live Status");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- liveStatus: ${report.liveStatus}; readOnly: true`);
  lines.push(`- engineVersion (replay): ${report.engineVersion}`);
  lines.push(
    `- asOf grid: ${report.asOfGrid.join(", ")}; evaluation ceiling: ${report.evaluationCeiling}`,
  );
  lines.push(
    `- response windows: ${report.responseWindowsDays.join("/")}d; outcome window: ${report.outcomeWindowDays}d; cut threshold: forward daily spend < ${report.cutSpendDropFraction * 100}% of baseline or status leaves ACTIVE; scale proxy: mean forward daily spend > ${report.scaleSpendRiseFactor * 100}% of baseline`,
  );
  lines.push(
    `- businesses: ${report.businesses.included.length} enabled included; excluded: ${
      report.businesses.excluded
        .map((business) => `${business.name} (${business.reason})`)
        .join(", ") || "none"
    }`,
  );
  lines.push(
    `- cohort: ${report.cohort.dedupedDecisions} deduped hard decisions (${report.cohort.cuts} cut, ${report.cohort.scales} scale) from ${report.cohort.hardDecisionRowsAcrossGrid} grid rows; ${report.cohort.recurring} recur on later grid dates`,
  );
  lines.push(
    `- data ceilings (raw -> last complete day used): ${Object.entries(
      report.businessDataCeilings,
    )
      .map(
        ([name, ceiling]) =>
          `${name}=${ceiling.raw ?? "none"}->${ceiling.lastCompleteDayUsed ?? "none"}`,
      )
      .join(", ")}`,
  );
  lines.push(
    "- source tables: meta_creative_daily, businesses, business_engine_v3_flags, meta campaign label + engine calibration tables (via the production decide+guard path)",
  );
  if (report.failedDays.length > 0) {
    lines.push(
      `- FAILED replay days: ${report.failedDays
        .map((day) => `${day.businessName}@${day.asOf} (${day.errorMessage})`)
        .join("; ")}`,
    );
  }
  lines.push("");

  lines.push("## Replay grid");
  lines.push("");
  lines.push(
    "| asOf | Businesses ok | Failed | Creative inputs | Deduped decisions | Hard cut | Hard scale | New in cohort |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const grid of report.gridSummaries) {
    lines.push(
      `| ${grid.asOf} | ${grid.businessesOk} | ${grid.businessesFailed} | ${grid.inputRows} | ${grid.dedupedDecisions} | ${grid.hardCut} | ${grid.hardScale} | ${grid.newInCohort} |`,
    );
  }
  lines.push("");

  lines.push("## Overall (all businesses, Tiles Workshop excluded)");
  lines.push("");
  renderGroupSummary(lines, report.overall);

  for (const business of report.byBusiness) {
    lines.push(
      `### ${business.business}${business.isDemoBusiness ? " (demo business)" : ""} (raw ceiling ${business.dataCeiling ?? "unknown"}, last complete day used ${business.completeDataCeiling ?? "unknown"})`,
    );
    lines.push("");
    renderGroupSummary(lines, business.summary);
  }

  lines.push("## Per-decision detail");
  lines.push("");
  lines.push(
    "| Business | Creative | Label | Grid asOf | Grid hits | Conf | Bucket | Baseline/day (source) | Resp day | Signal | 1d | 3d | 7d | Fwd 7d spend | Unknown via zero fwd spend |",
  );
  lines.push(
    "| --- | --- | --- | --- | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |",
  );
  const flag = (value: boolean | null) =>
    value === null ? "n/a" : value ? "yes" : "no";
  for (const decision of report.decisions) {
    const window = (days: number) =>
      decision.label === "cut"
        ? flag(decision.respondedWithin[days])
        : flag(decision.scaleRespondedWithin[days]);
    lines.push(
      `| ${decision.businessName} | ${decision.creativeId} | ${decision.label} | ${decision.asOf} | ${decision.gridAppearances} | ${decision.confidence} | ${decision.bucket} | ${decision.baselineDailySpend ?? "n/a"}${decision.baselineSource ? ` (${decision.baselineSource})` : ""} | ${decision.firstResponseDay ?? "-"} | ${decision.responseSignal ?? "-"} | ${window(1)} | ${window(3)} | ${window(7)} | ${decision.forwardOutcomeWindowSpend} | ${decision.wouldBeUnknownViaZeroForwardSpend ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Method & Evidence Limits");
  lines.push("");
  for (const limit of report.methodLimits) {
    lines.push(`- ${limit}`);
  }
  lines.push("");
  return lines.join("\n");
}

const isDirectExecution =
  process.argv[1]?.includes("june-operator-alignment") ?? false;
if (isDirectExecution) {
  withOperationalStartupLogsSilenced(main).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
