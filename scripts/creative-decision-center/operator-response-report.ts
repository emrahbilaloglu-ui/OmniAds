#!/usr/bin/env node
// Operator response report for hard decisions (cut/scale) - READ-ONLY.
//
// Named gap from the 2026-07-02 math review: operator compliance with a cut
// mechanically lowers measured precision (zero forward spend -> 'unknown'
// outcome in the classifier), so precision/unknown rates need companion
// evidence about whether the operator actually responded to hard decisions.
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/creative-decision-center/operator-response-report.ts \
//     [--startDate=2026-06-01] [--endDate=2026-07-05] [--jsonOut=...] [--mdOut=...] [--write=1]
//
// Read-only stance: SELECT-only DB access, no provider writes, no job runs,
// no rows written to engine tables. The dormant production job
// lib/creative-decision-engine/jobs/operator-response-job.ts is NOT executed;
// this script reuses its read-side semantics (daily spend aggregation shape,
// latest effective_status per day, RESPONSE_WINDOW_DAYS context) and the
// decision-outcomes job's forward-window semantics
// (d.date > decision AND d.date <= decision + N days; zero forward spend ->
// realized_outcome 'unknown' via the missing_outcome_spend_or_target rule in
// lib/creative-decision-engine/outcome-classifier.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import { RESPONSE_WINDOW_DAYS } from "@/lib/creative-decision-engine/config-values";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

const DEFAULT_START_DATE = "2026-06-01";
const DEFAULT_END_DATE = "2026-07-05";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/operator-response-report-2026-06-01-to-2026-07-05.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/OPERATOR_RESPONSE_REPORT_2026-06-01_TO_2026-07-05.md";

/** Response windows under evaluation (days after the decision date). */
const RESPONSE_WINDOWS_DAYS = [1, 3, 7] as const;
/** Cut response: forward daily spend below this fraction of baseline daily spend. */
const CUT_SPEND_DROP_FRACTION = 0.1;
/** Scale response (crude proxy): forward mean daily spend above baseline by this factor. */
const SCALE_SPEND_RISE_FACTOR = 1.25;
/** Outcome window mirrored from DECISION_OUTCOME_WINDOWS_DAYS[0] (decision-outcomes-job). */
const OUTCOME_WINDOW_DAYS = 7;
const ACTIVE_STATUS = "ACTIVE";

// ---------------------------------------------------------------------------
// Small utilities (conventions shared with automatic-campaign-context-shadow)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface ParsedArgs {
  startDate: string;
  endDate: string;
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
  queryTimeoutMs: number;
}

function arg(argv: string[], name: string, fallback: string) {
  const prefix = `--${name}=`;
  return (
    argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    startDate: arg(argv, "startDate", DEFAULT_START_DATE),
    endDate: arg(argv, "endDate", DEFAULT_END_DATE),
    jsonOut: arg(argv, "jsonOut", DEFAULT_JSON_OUT),
    mdOut: arg(argv, "mdOut", DEFAULT_MD_OUT),
    writeFiles: arg(argv, "write", "1") !== "0",
    queryTimeoutMs: Math.max(
      1_000,
      Number(arg(argv, "queryTimeoutMs", "120000")) || 120_000,
    ),
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

function toDateOnly(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return toText(value)?.slice(0, 10) ?? null;
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

// ---------------------------------------------------------------------------
// Read-only queries
// ---------------------------------------------------------------------------

/**
 * Cohort source 1: explicit decision_changed events flipping to cut/scale.
 * engine_version is only available via the linked decision snapshot.
 */
const DECISION_CHANGED_EVENTS_QUERY = `
SELECT
  e.business_ref_id::text AS business_ref_id,
  b.name AS business_name,
  e.creative_id,
  e.current_label AS label,
  e.event_date::text AS decision_date,
  COALESCE(s.engine_version, 'unknown') AS engine_version
FROM engine_v3_decision_events e
JOIN businesses b ON b.id::text = e.business_ref_id::text
LEFT JOIN engine_v3_decision_snapshots_daily s ON s.id = e.decision_snapshot_id
WHERE e.event_type = 'decision_changed'
  AND e.current_label IN ('cut', 'scale')
  AND e.event_date BETWEEN $1::date AND $2::date
ORDER BY b.name, e.event_date, e.creative_id
`;

/**
 * Cohort source 2: first-seen cut/scale decision snapshots in the window.
 * decision_changed events alone undercount (events are only emitted on label
 * flips observed by the events writer), so the snapshot universe is included
 * with first-seen-in-window semantics per (business, engine_version,
 * creative, label).
 */
const FIRST_SEEN_SNAPSHOTS_QUERY = `
SELECT
  s.business_ref_id::text AS business_ref_id,
  b.name AS business_name,
  s.creative_id,
  s.label,
  MIN(s.as_of_date)::text AS decision_date,
  s.engine_version,
  COUNT(*)::int AS snapshot_days_with_label
FROM engine_v3_decision_snapshots_daily s
JOIN businesses b ON b.id::text = s.business_ref_id::text
WHERE s.label IN ('cut', 'scale')
  AND s.as_of_date BETWEEN $1::date AND $2::date
GROUP BY s.business_ref_id, b.name, s.creative_id, s.label, s.engine_version
ORDER BY b.name, MIN(s.as_of_date), s.creative_id
`;

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
 * Daily spend/status series for one creative. Aggregation shape reused
 * read-only from FIND_DAILY_SPEND_QUERY in
 * lib/creative-decision-engine/jobs/operator-response-job.ts (sum spend per
 * date, latest non-null effective_status per date), with the business join
 * widened to (business_ref_id OR business_id) exactly like the
 * decision-outcomes job's forward join.
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

// ---------------------------------------------------------------------------
// Decision cohort assembly
// ---------------------------------------------------------------------------

type DecisionLabel = "cut" | "scale";
type DecisionSource = "event" | "snapshot_first_seen" | "both";

interface DecisionRecord {
  businessRefId: string;
  businessName: string;
  engineVersion: string;
  creativeId: string;
  label: DecisionLabel;
  decisionDate: string;
  source: DecisionSource;
}

function toLabel(value: unknown): DecisionLabel | null {
  const text = toText(value);
  return text === "cut" || text === "scale" ? text : null;
}

async function readDecisionCohort(startDate: string, endDate: string) {
  const db = getDb();
  const [eventRows, snapshotRows] = [
    await db.query<Row>(DECISION_CHANGED_EVENTS_QUERY, [startDate, endDate]),
    await db.query<Row>(FIRST_SEEN_SNAPSHOTS_QUERY, [startDate, endDate]),
  ];

  const byKey = new Map<string, DecisionRecord>();
  const record = (row: Row, source: "event" | "snapshot_first_seen") => {
    const label = toLabel(row.label);
    const businessRefId = toText(row.business_ref_id);
    const creativeId = toText(row.creative_id);
    const decisionDate = toDateOnly(row.decision_date);
    if (!label || !businessRefId || !creativeId || !decisionDate) return;
    const key = `${businessRefId}|${creativeId}|${label}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        businessRefId,
        businessName: toText(row.business_name) ?? businessRefId,
        engineVersion: toText(row.engine_version) ?? "unknown",
        creativeId,
        label,
        decisionDate,
        source,
      });
      return;
    }
    // Dedupe: earliest decision date wins; remember both sources saw it.
    if (decisionDate < existing.decisionDate) {
      existing.decisionDate = decisionDate;
    }
    if (existing.source !== source) existing.source = "both";
    if (existing.engineVersion === "unknown") {
      existing.engineVersion = toText(row.engine_version) ?? "unknown";
    }
  };

  for (const row of eventRows) record(row, "event");
  for (const row of snapshotRows) record(row, "snapshot_first_seen");

  return {
    decisions: [...byKey.values()].sort(
      (left, right) =>
        left.businessName.localeCompare(right.businessName) ||
        left.decisionDate.localeCompare(right.decisionDate) ||
        left.creativeId.localeCompare(right.creativeId),
    ),
    eventRowCount: eventRows.length,
    snapshotFirstSeenCount: snapshotRows.length,
  };
}

async function readBusinessCeilings(businessRefIds: string[]) {
  if (businessRefIds.length === 0) return new Map<string, string>();
  const rows = await getDb().query<Row>(BUSINESS_DATA_CEILING_QUERY, [
    businessRefIds,
  ]);
  const ceilings = new Map<string, string>();
  for (const row of rows) {
    const key = toText(row.business_key);
    const maxDate = toDateOnly(row.max_date);
    if (key && maxDate) ceilings.set(key, maxDate);
  }
  return ceilings;
}

// ---------------------------------------------------------------------------
// Per-decision measurement
// ---------------------------------------------------------------------------

interface DailyPoint {
  date: string;
  spend: number;
  effectiveStatus: string | null;
}

type MeasurabilityBucket =
  | "measurable"
  | "zero_spend_at_decision"
  | "unobservable_forward_window";

interface MeasuredDecision extends DecisionRecord {
  /** Raw meta_creative_daily max date for the business. */
  dataCeiling: string | null;
  /**
   * Last complete ingest day actually used for forward windows. When the raw
   * ceiling equals the run date it is an intraday partial (observed at ~10-25%
   * of typical daily spend) and would fake spend-drop responses, so it is
   * excluded.
   */
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
  /** Cut: first forward day satisfying a response condition. */
  firstResponseDay: number | null;
  responseSignal: "spend_drop" | "status_left_active" | null;
  respondedWithinObservable: boolean;
  /** Per window: null => window truncated by the data ceiling (not evaluable). */
  respondedWithin: Record<number, boolean | null>;
  /** Scale proxy per window (mean forward daily spend > 1.25x baseline). */
  scaleRespondedWithin: Record<number, boolean | null>;
  /** Observed forward spend over the outcome window (truncated at ceiling). */
  forwardOutcomeWindowSpend: number;
  outcomeWindowTruncated: boolean;
  /** classifier rule missing_outcome_spend_or_target fires on zero forward spend. */
  wouldBeUnknownViaZeroForwardSpend: boolean;
}

async function measureDecision(
  decision: DecisionRecord,
  dataCeiling: string | null,
  completeDataCeiling: string | null,
): Promise<MeasuredDecision> {
  const seriesEnd =
    completeDataCeiling === null
      ? decision.decisionDate
      : [
          addDays(decision.decisionDate, OUTCOME_WINDOW_DAYS),
          completeDataCeiling,
        ].sort()[0];
  const rows = await getDb().query<Row>(DAILY_SPEND_SERIES_QUERY, [
    decision.businessRefId,
    decision.creativeId,
    addDays(decision.decisionDate, -6),
    seriesEnd,
  ]);
  const byDate = new Map<string, DailyPoint>();
  for (const row of rows) {
    const date = toDateOnly(row.date);
    if (!date) continue;
    byDate.set(date, {
      date,
      spend: toNumber(row.spend),
      effectiveStatus: toText(row.effective_status),
    });
  }

  const decisionDaySpend = byDate.get(decision.decisionDate)?.spend ?? 0;
  let trailingTotal = 0;
  for (let offset = -6; offset <= 0; offset += 1) {
    trailingTotal +=
      byDate.get(addDays(decision.decisionDate, offset))?.spend ?? 0;
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
            diffDays(completeDataCeiling, decision.decisionDate),
          ),
        );

  // Missing rows inside the observable window mean zero delivery (zero spend),
  // matching the decision-outcomes job COALESCE(SUM(spend), 0) semantics.
  const forwardDays = Array.from(
    { length: observableForwardDays },
    (_, index) => {
      const day = index + 1;
      const date = addDays(decision.decisionDate, day);
      const point = byDate.get(date);
      return {
        day,
        date,
        spend: point?.spend ?? 0,
        effectiveStatus: point?.effectiveStatus ?? null,
      };
    },
  );

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
// Aggregation
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
      lowerBoundResponseRate:
        measurableCuts.length > 0
          ? round4(respondedCuts.length / measurableCuts.length)
          : null,
      byWindow: windowStats(measurableCuts, (d) => d.respondedWithin),
      medianDaysToResponse: median(
        respondedCuts
          .map((decision) => decision.firstResponseDay)
          .filter((day): day is number => day !== null),
      ),
      spendAfterUnrespondedCuts: round2(
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const args = parseArgs(process.argv.slice(2));
  process.env.DB_QUERY_TIMEOUT_MS = String(args.queryTimeoutMs);
  const generatedAt = new Date().toISOString();

  const runDate = generatedAt.slice(0, 10);

  const cohort = await readDecisionCohort(args.startDate, args.endDate);
  const businessRefIds = [
    ...new Set(cohort.decisions.map((decision) => decision.businessRefId)),
  ];
  const ceilings = await readBusinessCeilings(businessRefIds);
  // A ceiling equal to the run date is an intraday partial ingest (verified:
  // ceiling-day business spend runs at ~10-25% of typical complete days) and
  // would fake spend-drop responses, so the last COMPLETE day is ceiling - 1.
  const completeCeiling = (raw: string | null) =>
    raw === null ? null : raw >= runDate ? addDays(raw, -1) : raw;

  const measured: MeasuredDecision[] = [];
  for (const decision of cohort.decisions) {
    const rawCeiling = ceilings.get(decision.businessRefId) ?? null;
    measured.push(
      await measureDecision(decision, rawCeiling, completeCeiling(rawCeiling)),
    );
  }

  const engineVersions = [
    ...new Set(measured.map((decision) => decision.engineVersion)),
  ].sort();
  const perEngineVersion = engineVersions.map((engineVersion) => {
    const versionDecisions = measured.filter(
      (decision) => decision.engineVersion === engineVersion,
    );
    const businessNames = [
      ...new Set(versionDecisions.map((decision) => decision.businessName)),
    ].sort();
    return {
      engineVersion,
      overall: summarizeGroup(versionDecisions),
      byBusiness: businessNames.map((businessName) => {
        const businessDecisions = versionDecisions.filter(
          (decision) => decision.businessName === businessName,
        );
        return {
          business: businessName,
          dataCeiling: businessDecisions[0]?.dataCeiling ?? null,
          completeDataCeiling:
            businessDecisions[0]?.completeDataCeiling ?? null,
          summary: summarizeGroup(businessDecisions),
        };
      }),
    };
  });

  const report = {
    title:
      "Operator Response Report (hard decisions: cut/scale) - " +
      `${args.startDate} to ${args.endDate}`,
    generatedAt,
    liveStatus: "live_db_read_only",
    readOnly: true,
    dbWrites: false,
    providerWrites: false,
    jobsExecuted: false,
    startDate: args.startDate,
    endDate: args.endDate,
    responseWindowsDays: [...RESPONSE_WINDOWS_DAYS],
    outcomeWindowDays: OUTCOME_WINDOW_DAYS,
    cutSpendDropFraction: CUT_SPEND_DROP_FRACTION,
    scaleSpendRiseFactor: SCALE_SPEND_RISE_FACTOR,
    dormantJobResponseWindowDays: RESPONSE_WINDOW_DAYS,
    cohortSources: {
      decisionChangedEventRows: cohort.eventRowCount,
      firstSeenSnapshotRows: cohort.snapshotFirstSeenCount,
      dedupedDecisions: cohort.decisions.length,
      bySource: {
        event: measured.filter((decision) => decision.source === "event")
          .length,
        snapshot_first_seen: measured.filter(
          (decision) => decision.source === "snapshot_first_seen",
        ).length,
        both: measured.filter((decision) => decision.source === "both").length,
      },
    },
    businessDataCeilings: Object.fromEntries(
      [...ceilings.entries()].map(([businessRefId, maxDate]) => {
        const name =
          measured.find((decision) => decision.businessRefId === businessRefId)
            ?.businessName ?? businessRefId;
        return [
          name,
          { raw: maxDate, lastCompleteDay: completeCeiling(maxDate) },
        ];
      }),
    ),
    perEngineVersion,
    decisions: measured,
    evidenceLimits: [
      "Read-only analysis: SELECT-only DB access; the dormant engine_v3_operator_response_job was NOT executed and no engine_v3 rows were written.",
      "Cohort = decision_changed events flipping to cut/scale UNION first-seen cut/scale decision snapshots in the window, deduped per (business, creative, label) keeping the earliest date. Events alone severely undercount (5 event rows vs the snapshot universe), so first-seen snapshots are included as stated in the task; 'first-seen' means the first as_of_date in the analysis window carrying the label, which overcounts genuinely new decisions if a label was already active before the window (snapshots only exist from 2026-07-02, so within this window every first-seen date is also the first snapshot ever).",
      "engine_v3_decision_events has no engine_version column; event engine_version is resolved via the linked decision snapshot and falls back to 'unknown'.",
      "Baseline daily spend = decision-day spend when positive, else the trailing 7-day mean daily spend (fallback needed because several decisions have zero decision-day spend); decisions with no baseline are bucketed as zero_spend_at_decision and excluded from response-rate denominators.",
      "Cut response = forward daily spend < 10% of baseline OR effective_status leaves ACTIVE (PAUSED / CAMPAIGN_PAUSED / DELETED / missing-ACTIVE). Missing forward rows inside the observable window count as zero spend, mirroring the decision-outcomes job COALESCE semantics. Spend-based responses cannot distinguish operator action from Meta delivery collapse; treat as operator-or-delivery response.",
      "Scale response is a CRUDE PROXY: mean forward daily spend over the window > 125% of baseline daily spend. It does not verify budget changes or action-journal receipts (the dormant job's richer detector needs scale/refresh recommendations plus budget history; not re-run here).",
      "Forward windows are truncated at each business's LAST COMPLETE meta_creative_daily day. A raw ceiling equal to the run date is an intraday partial ingest (verified: ceiling-day business spend runs at ~10-25% of typical complete days) and is excluded, because partial-day spend mechanically fakes cut 'responses'; before this exclusion, five TheSwaf 2026-07-02 cuts all 'responded' on the partial day. All qualifying decisions fall on 2026-07-02..05 with 2026-07-05 as the last complete day, so NO 7d window is fully observable, 3d windows are only fully observable for 2026-07-02 decisions, and 2026-07-05 decisions have zero observable forward days (bucketed unobservable). Per-window rates use only fully observable windows; the lower-bound rate uses any observable forward day.",
      "Tiles Workshop's meta_creative_daily ceiling is 2026-06-19 while its decisions are dated 2026-07-03..05: its entire cohort is unobservable_forward_window (the engine decided on stale warehouse data); its cuts appear in counts but in no response-rate denominator.",
      "Unknown-outcome interaction mirrors the outcome-classifier rule missing_outcome_spend_or_target: zero forward spend over the (truncated) 7d outcome window => realized_outcome 'unknown'. With truncated windows this is the observed-so-far share; a creative could still spend after the ceiling.",
      `The dormant job's RESPONSE_WINDOW_DAYS=${RESPONSE_WINDOW_DAYS} is a lookback for scale/refresh recommendation detection and is reported for context only; this report's response windows are ${RESPONSE_WINDOWS_DAYS.join("/")} days per the task spec.`,
    ],
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
          decisions: measured.length,
          engineVersions,
          headline: perEngineVersion.map((version) => ({
            engineVersion: version.engineVersion,
            cuts: version.overall.cuts,
          })),
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

type GroupSummary = ReturnType<typeof summarizeGroup>;

interface ReportShape {
  title: string;
  generatedAt: string;
  liveStatus: string;
  startDate: string;
  endDate: string;
  responseWindowsDays: number[];
  outcomeWindowDays: number;
  cutSpendDropFraction: number;
  scaleSpendRiseFactor: number;
  dormantJobResponseWindowDays: number;
  cohortSources: {
    decisionChangedEventRows: number;
    firstSeenSnapshotRows: number;
    dedupedDecisions: number;
    bySource: Record<string, number>;
  };
  businessDataCeilings: Record<
    string,
    { raw: string; lastCompleteDay: string | null }
  >;
  perEngineVersion: Array<{
    engineVersion: string;
    overall: GroupSummary;
    byBusiness: Array<{
      business: string;
      dataCeiling: string | null;
      completeDataCeiling: string | null;
      summary: GroupSummary;
    }>;
  }>;
  decisions: MeasuredDecision[];
  evidenceLimits: string[];
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
    `- cut response (lower bound, any observable day): ${ratioText(cuts.respondedWithinObservable, cuts.measurable)}; median days-to-response: ${cuts.medianDaysToResponse ?? "n/a"}`,
  );
  lines.push("");
  lines.push("Cut response by window (fully observable windows only):");
  lines.push("");
  renderWindowTable(lines, cuts.byWindow);
  lines.push("");
  lines.push(
    `- spend after unresponded cuts (observed forward <=7d, truncated): ${cuts.spendAfterUnrespondedCuts} across ${cuts.unrespondedCutCount} unresponded cuts`,
  );
  const unknown = cuts.unknownOutcomeInteraction;
  lines.push(
    `- unknown-outcome interaction: ${ratioText(unknown.respondedCutsWithZeroForwardSpend, unknown.respondedCuts)} of responded cuts have zero observed forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)`,
  );
  const scales = summary.scales;
  lines.push(
    `- scales: ${scales.total} total; ${scales.measurable} measurable, ${scales.zeroSpendAtDecision} zero-spend-at-decision, ${scales.unobservableForwardWindow} unobservable`,
  );
  if (scales.total > 0) {
    lines.push("");
    lines.push("Scale response by window (crude spend-rise proxy):");
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
    "Read-only companion evidence for the 2026-07-02 math review gap: operator compliance with a cut mechanically lowers measured precision (zero forward spend => 'unknown' outcome), so this report measures whether hard decisions were actually followed and quantifies the precision-denominator interaction. No DB writes, no provider writes, no jobs executed.",
  );
  lines.push("");
  lines.push("## Live Status");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- liveStatus: ${report.liveStatus}; readOnly: true`);
  lines.push(`- window: ${report.startDate} .. ${report.endDate}`);
  lines.push(
    `- response windows: ${report.responseWindowsDays.join("/")}d; outcome window: ${report.outcomeWindowDays}d; cut threshold: forward daily spend < ${report.cutSpendDropFraction * 100}% of baseline or status leaves ACTIVE; scale proxy: mean forward daily spend > ${report.scaleSpendRiseFactor * 100}% of baseline`,
  );
  lines.push(
    `- cohort: ${report.cohortSources.dedupedDecisions} deduped decisions (${report.cohortSources.decisionChangedEventRows} decision_changed event rows, ${report.cohortSources.firstSeenSnapshotRows} first-seen snapshot rows; sources: ${JSON.stringify(report.cohortSources.bySource)})`,
  );
  lines.push(
    `- data ceilings (meta_creative_daily max date raw -> last complete day used): ${Object.entries(
      report.businessDataCeilings,
    )
      .map(
        ([name, ceiling]) =>
          `${name}=${ceiling.raw}->${ceiling.lastCompleteDay ?? "none"}`,
      )
      .join(", ")}`,
  );
  lines.push(
    "- source tables: engine_v3_decision_events, engine_v3_decision_snapshots_daily, meta_creative_daily, businesses",
  );
  lines.push("");

  for (const version of report.perEngineVersion) {
    lines.push(`## Engine version: ${version.engineVersion}`);
    lines.push("");
    lines.push("### Overall");
    lines.push("");
    renderGroupSummary(lines, version.overall);
    for (const business of version.byBusiness) {
      lines.push(
        `### ${business.business} (raw ceiling ${business.dataCeiling ?? "unknown"}, last complete day ${business.completeDataCeiling ?? "unknown"})`,
      );
      lines.push("");
      renderGroupSummary(lines, business.summary);
    }
  }

  lines.push("## Per-decision detail");
  lines.push("");
  lines.push(
    "| Business | Creative | Label | Decision date | Source | Bucket | Baseline/day | Fwd days | Response day | Signal | Fwd 7d spend | Unknown via zero fwd spend |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |",
  );
  for (const decision of report.decisions) {
    lines.push(
      `| ${decision.businessName} | ${decision.creativeId} | ${decision.label} | ${decision.decisionDate} | ${decision.source} | ${decision.bucket} | ${decision.baselineDailySpend ?? "n/a"} | ${decision.observableForwardDays} | ${decision.firstResponseDay ?? "-"} | ${decision.responseSignal ?? "-"} | ${decision.forwardOutcomeWindowSpend} | ${decision.wouldBeUnknownViaZeroForwardSpend ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Method & Evidence Limits");
  lines.push("");
  for (const limit of report.evidenceLimits) {
    lines.push(`- ${limit}`);
  }
  lines.push("");
  return lines.join("\n");
}

const isDirectExecution =
  process.argv[1]?.includes("operator-response-report") ?? false;
if (isDirectExecution) {
  withOperationalStartupLogsSilenced(main).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
