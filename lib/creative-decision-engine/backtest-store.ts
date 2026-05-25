import { getDb } from "@/lib/db";
import {
  summarizeDecisionBacktest,
  type CreativeDecisionBacktestRow,
  type DecisionBacktestSummary,
} from "./backtest";
import type { DecisionLabel } from "./types";

export interface ReadCreativeDecisionBacktestSummaryInput {
  businessId: string;
  asOf: string;
  activeCreativeCount: number;
  outcomeWindowDays?: number;
  lookbackDays?: number;
}

type OutcomeRow = Record<string, unknown> & {
  creative_id: unknown;
  decision_as_of_date: unknown;
  label: unknown;
  confidence: unknown;
  realized_outcome: unknown;
  severity: unknown;
};

type CoverageRow = Record<string, unknown> & {
  snapshot_row_count: unknown;
  stale_snapshot_count: unknown;
  conflicting_snapshot_count: unknown;
};

export async function readCreativeDecisionBacktestSummary(
  input: ReadCreativeDecisionBacktestSummaryInput,
): Promise<DecisionBacktestSummary | null> {
  const outcomeWindowDays = input.outcomeWindowDays ?? 14;
  const lookbackDays = input.lookbackDays ?? 90;
  const [outcomeRows, coverageRows] = await Promise.all([
    getDb().query<OutcomeRow>(
      `
      SELECT
        creative_id,
        decision_as_of_date,
        label,
        confidence,
        realized_outcome,
        severity
      FROM engine_v3_decision_outcomes_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND outcome_window_days = $2::integer
        AND decision_as_of_date BETWEEN ($3::date - (($4::integer - 1) * INTERVAL '1 day')) AND $3::date
      ORDER BY decision_as_of_date ASC, creative_id ASC
      `,
      [input.businessId, outcomeWindowDays, input.asOf, lookbackDays],
    ),
    getDb().query<CoverageRow>(
      `
      WITH latest_day AS (
        SELECT MAX(as_of_date) AS as_of_date
        FROM engine_v3_decision_snapshots_daily
        WHERE (business_ref_id::text = $1 OR business_id = $1)
          AND as_of_date <= $2::date
      ),
      latest_snapshots AS (
        SELECT *
        FROM engine_v3_decision_snapshots_daily
        WHERE (business_ref_id::text = $1 OR business_id = $1)
          AND as_of_date = (SELECT as_of_date FROM latest_day)
      ),
      conflicts AS (
        SELECT creative_id, as_of_date
        FROM engine_v3_decision_snapshots_daily
        WHERE (business_ref_id::text = $1 OR business_id = $1)
          AND as_of_date BETWEEN ($2::date - (($3::integer - 1) * INTERVAL '1 day')) AND $2::date
        GROUP BY creative_id, as_of_date
        HAVING COUNT(DISTINCT label) > 1
      )
      SELECT
        COUNT(DISTINCT latest_snapshots.creative_id) AS snapshot_row_count,
        COUNT(*) FILTER (
          WHERE latest_snapshots.computed_at < (now() - INTERVAL '24 hours')
             OR latest_snapshots.as_of_date < ($2::date - INTERVAL '1 day')
        ) AS stale_snapshot_count,
        (SELECT COUNT(*) FROM conflicts) AS conflicting_snapshot_count
      FROM latest_snapshots
      `,
      [input.businessId, input.asOf, lookbackDays],
    ),
  ]);

  if (outcomeRows.length === 0) return null;
  const coverageRow = coverageRows[0];
  return summarizeDecisionBacktest({
    rows: outcomeRows.map(toBacktestRow),
    coverage: {
      activeCreativeCount: input.activeCreativeCount,
      snapshotRowCount: toInteger(coverageRow?.snapshot_row_count),
      staleSnapshotCount: toInteger(coverageRow?.stale_snapshot_count),
      conflictingSnapshotCount: toInteger(
        coverageRow?.conflicting_snapshot_count,
      ),
    },
  });
}

function toBacktestRow(row: OutcomeRow): CreativeDecisionBacktestRow {
  return {
    creativeId: toString(row.creative_id),
    asOfDate: toDateOnly(row.decision_as_of_date),
    label: toDecisionLabel(row.label),
    confidence: toInteger(row.confidence),
    realizedOutcome: toRealizedOutcome(row.realized_outcome),
    severity: toSeverity(row.severity),
  };
}

function toString(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function toDateOnly(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return toString(value).slice(0, 10);
}

function toInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function toDecisionLabel(value: unknown): DecisionLabel {
  const text = toString(value);
  if (
    text === "scale" ||
    text === "keep" ||
    text === "refresh" ||
    text === "cut" ||
    text === "test_more" ||
    text === "diagnose" ||
    text === "out_of_scope"
  ) {
    return text;
  }
  return "diagnose";
}

function toRealizedOutcome(
  value: unknown,
): CreativeDecisionBacktestRow["realizedOutcome"] {
  const text = toString(value);
  if (
    text === "positive" ||
    text === "negative" ||
    text === "neutral" ||
    text === "unknown"
  ) {
    return text;
  }
  return "unknown";
}

function toSeverity(value: unknown): CreativeDecisionBacktestRow["severity"] {
  const text = toString(value);
  if (
    text === "critical" ||
    text === "high" ||
    text === "medium" ||
    text === "low"
  ) {
    return text;
  }
  return undefined;
}
