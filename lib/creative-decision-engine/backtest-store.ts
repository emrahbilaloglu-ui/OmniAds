import { getDb } from "@/lib/db";
import {
  summarizeDecisionBacktest,
  type CreativeDecisionBacktestRow,
  type DecisionBacktestSummary,
} from "./backtest";
import {
  DECISION_AUTHORITY_BLOCKERS,
  type DecisionAuthorityBlocker,
} from "./evaluation-store";
import { ENGINE_VERSION, type DecisionLabel } from "./types";

export interface ReadCreativeDecisionBacktestSummaryInput {
  businessId: string;
  asOf: string;
  activeCreativeCount: number;
  engineVersion?: string | null;
  outcomeWindowDays?: number;
  lookbackDays?: number;
}

type OutcomeRow = Record<string, unknown> & {
  creative_id: unknown;
  decision_as_of_date: unknown;
  label: unknown;
  pre_authority_label: unknown;
  authority_blocker: unknown;
  confidence: unknown;
  realized_outcome: unknown;
  severity: unknown;
};

export type CreativeDecisionBacktestRowWithProvenance =
  CreativeDecisionBacktestRow & {
    preAuthorityLabel: DecisionLabel | null;
    authorityBlocker: DecisionAuthorityBlocker | null;
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
  const engineVersion = input.engineVersion ?? ENGINE_VERSION;
  const [outcomeRows, coverageRows] = await Promise.all([
    getDb().query<OutcomeRow>(
      `
      SELECT
        creative_id,
        decision_as_of_date,
        label,
        pre_authority_label,
        authority_blocker,
        confidence,
        realized_outcome,
        severity
      FROM engine_v3_decision_outcomes_daily
      WHERE (business_ref_id::text = $1 OR business_id = $1)
        AND outcome_window_days = $2::integer
        AND decision_as_of_date BETWEEN ($3::date - (($4::integer - 1) * INTERVAL '1 day')) AND $3::date
        AND ($5::text IS NULL OR engine_version = $5)
      ORDER BY decision_as_of_date ASC, creative_id ASC
      `,
      [
        input.businessId,
        outcomeWindowDays,
        input.asOf,
        lookbackDays,
        engineVersion,
      ],
    ),
    getDb().query<CoverageRow>(
      `
      WITH latest_day AS (
        SELECT MAX(as_of_date) AS as_of_date
        FROM engine_v3_decision_snapshots_daily
        WHERE (business_ref_id::text = $1 OR business_id = $1)
          AND as_of_date <= $2::date
          AND ($4::text IS NULL OR engine_version = $4)
      ),
      latest_snapshots AS (
        SELECT *
        FROM engine_v3_decision_snapshots_daily
        WHERE (business_ref_id::text = $1 OR business_id = $1)
          AND as_of_date = (SELECT as_of_date FROM latest_day)
          AND ($4::text IS NULL OR engine_version = $4)
      ),
      conflicts AS (
        SELECT creative_id, as_of_date, engine_version, scope_type, scope_id
        FROM engine_v3_decision_snapshots_daily
        WHERE (business_ref_id::text = $1 OR business_id = $1)
          AND as_of_date BETWEEN ($2::date - (($3::integer - 1) * INTERVAL '1 day')) AND $2::date
          AND ($4::text IS NULL OR engine_version = $4)
        GROUP BY creative_id, as_of_date, engine_version, scope_type, scope_id
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
      [input.businessId, input.asOf, lookbackDays, engineVersion],
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

function toBacktestRow(row: OutcomeRow): CreativeDecisionBacktestRowWithProvenance {
  return {
    creativeId: toString(row.creative_id),
    asOfDate: toDateOnly(row.decision_as_of_date),
    label: toDecisionLabel(row.label),
    preAuthorityLabel: toOptionalDecisionLabel(row.pre_authority_label),
    authorityBlocker: toAuthorityBlocker(row.authority_blocker),
    confidence: toInteger(row.confidence),
    realizedOutcome: toRealizedOutcome(row.realized_outcome),
    severity: toSeverity(row.severity),
  };
}

function toOptionalDecisionLabel(value: unknown): DecisionLabel | null {
  if (value === null || value === undefined) return null;
  const label = toString(value);
  if (
    label === "scale" || label === "keep" || label === "refresh" ||
    label === "cut" || label === "test_more" || label === "diagnose" ||
    label === "out_of_scope"
  ) return label;
  throw new Error(`Unexpected decision authority label: ${label}`);
}

function toAuthorityBlocker(value: unknown): DecisionAuthorityBlocker | null {
  if (value === null || value === undefined) return null;
  const blocker = toString(value) as DecisionAuthorityBlocker;
  if (DECISION_AUTHORITY_BLOCKERS.includes(blocker)) return blocker;
  throw new Error(`Unexpected decision authority blocker: ${blocker}`);
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
