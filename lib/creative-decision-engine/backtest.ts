import type { DecisionLabel } from "./types";

export type BacktestAction = Extract<DecisionLabel, "scale" | "cut" | "refresh">;

export interface CreativeDecisionBacktestRow {
  creativeId: string;
  asOfDate: string;
  label: DecisionLabel;
  confidence: number;
  /**
   * Outcome is judged against the decision opportunity, not only the emitted label:
   * - hard labels positive = the hard action was correct in hindsight.
   * - non-hard labels positive = a hard action was missed in hindsight.
   * - non-hard labels negative/neutral do not count as missed hard-action demand.
   */
  realizedOutcome: "positive" | "negative" | "neutral" | "unknown";
  severity?: "critical" | "high" | "medium" | "low";
}

export interface DecisionCoverageInput {
  activeCreativeCount: number;
  snapshotRowCount: number;
  staleSnapshotCount: number;
  conflictingSnapshotCount: number;
}

export interface DecisionBacktestSummary {
  hardActionPrecision: number | null;
  hardActionRecall: number | null;
  expectedCalibrationError: number | null;
  criticalFalsePositiveRate: number | null;
  highSeverityMissedOpportunityRate: number | null;
  activeDecisionCoverage: number | null;
  dataFreshnessPass: boolean;
  persistedCoveragePass: boolean;
  conflictFreePass: boolean;
  sampleSize: number;
  hardActionKnownSampleSize: number;
  /**
   * Observed positive rate per confidence decade over hard rows with known
   * outcomes - the empirical answer to "how often were decisions at this
   * confidence actually right". Served to explainability so displayed
   * confidence is always accompanied by its observed track record.
   */
  hardConfidenceBuckets: Array<{
    bucket: string;
    known: number;
    positive: number;
    observedRate: number;
  }>;
}

export interface DecisionBacktestSegmentSummary
  extends DecisionBacktestSummary {
  label: DecisionLabel;
  weekStartDate: string;
  coverageScope: "global" | "week";
  minSegmentSampleSize: number;
  sampleReliable: boolean;
  confidenceLevel: "insufficient_sample" | "directional" | "defensible";
  nonComputableReason: string | null;
}

const HARD_ACTIONS = new Set<DecisionLabel>(["scale", "cut", "refresh"]);

function round(value: number | null) {
  return value === null ? null : Number(value.toFixed(4));
}

function isHardAction(label: DecisionLabel) {
  return HARD_ACTIONS.has(label);
}

function weekStartIsoDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "invalid-date";
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export function computeExpectedCalibrationError(
  rows: readonly CreativeDecisionBacktestRow[],
): number | null {
  // Hard-action rows only. For non-hard labels "positive" means a missed hard
  // action (the decision was WRONG), the opposite polarity of hard rows where
  // "positive" validates the action. Pooling both made the metric
  // unpassable-by-construction: a confident correct keep registered as
  // near-maximal calibration error. Calibration is therefore measured on the
  // rows whose confidence claims an action, i.e. hard rows.
  const known = rows.filter(
    (row) => isHardAction(row.label) && row.realizedOutcome !== "unknown",
  );
  if (known.length === 0) return null;

  const buckets = new Map<number, { total: number; positives: number }>();
  for (const row of known) {
    const bucket = Math.min(9, Math.max(0, Math.floor(row.confidence / 10)));
    const current = buckets.get(bucket) ?? { total: 0, positives: 0 };
    current.total += 1;
    if (row.realizedOutcome === "positive") current.positives += 1;
    buckets.set(bucket, current);
  }

  let weightedError = 0;
  for (const [bucket, value] of buckets) {
    const expectedConfidence = (bucket * 10 + 5) / 100;
    const observedRate = value.positives / value.total;
    weightedError += Math.abs(observedRate - expectedConfidence) * value.total;
  }

  return round(weightedError / known.length);
}

export function summarizeDecisionBacktest(input: {
  rows: readonly CreativeDecisionBacktestRow[];
  coverage: DecisionCoverageInput;
  maxStaleSnapshotCount?: number;
}): DecisionBacktestSummary {
  const hardRows = input.rows.filter((row) => isHardAction(row.label));
  const positiveRows = input.rows.filter((row) => row.realizedOutcome === "positive");
  const truePositiveHardRows = hardRows.filter(
    (row) => row.realizedOutcome === "positive",
  );
  const falsePositiveHardRows = hardRows.filter(
    (row) => row.realizedOutcome === "negative",
  );
  const criticalFalsePositiveRows = falsePositiveHardRows.filter(
    (row) => row.severity === "critical",
  );
  const missedHighSeverityRows = input.rows.filter(
    (row) =>
      !isHardAction(row.label) &&
      row.realizedOutcome === "positive" &&
      (row.severity === "critical" || row.severity === "high"),
  );
  const coverage =
    input.coverage.activeCreativeCount > 0
      ? input.coverage.snapshotRowCount / input.coverage.activeCreativeCount
      : null;

  return {
    hardActionPrecision: round(
      hardRows.length > 0 ? truePositiveHardRows.length / hardRows.length : null,
    ),
    hardActionRecall: round(
      positiveRows.length > 0
        ? truePositiveHardRows.length / positiveRows.length
        : null,
    ),
    // Hard-only by construction; see computeExpectedCalibrationError.
    expectedCalibrationError: computeExpectedCalibrationError(input.rows),
    criticalFalsePositiveRate: round(
      hardRows.length > 0 ? criticalFalsePositiveRows.length / hardRows.length : null,
    ),
    highSeverityMissedOpportunityRate: round(
      positiveRows.length > 0
        ? missedHighSeverityRows.length / positiveRows.length
        : null,
    ),
    activeDecisionCoverage: round(coverage),
    dataFreshnessPass:
      input.coverage.staleSnapshotCount <= (input.maxStaleSnapshotCount ?? 0),
    persistedCoveragePass: coverage !== null && coverage >= 0.95,
    conflictFreePass: input.coverage.conflictingSnapshotCount === 0,
    sampleSize: input.rows.length,
    // Sample basis for calibration honesty: ECE/precision are hard-row
    // metrics, so reliability copy must gate on hard rows with known
    // outcomes, not total rows.
    hardActionKnownSampleSize: hardRows.filter(
      (row) => row.realizedOutcome !== "unknown",
    ).length,
    hardConfidenceBuckets: computeHardConfidenceBuckets(hardRows),
  };
}

function computeHardConfidenceBuckets(
  hardRows: readonly CreativeDecisionBacktestRow[],
) {
  const byBucket = new Map<string, { known: number; positive: number }>();
  for (const row of hardRows) {
    if (row.realizedOutcome === "unknown") continue;
    const decade = Math.min(9, Math.floor(Math.max(0, row.confidence) / 10));
    const bucket = `${decade * 10}_${decade * 10 + 9}`;
    const cell = byBucket.get(bucket) ?? { known: 0, positive: 0 };
    cell.known += 1;
    if (row.realizedOutcome === "positive") cell.positive += 1;
    byBucket.set(bucket, cell);
  }
  return [...byBucket.entries()]
    .map(([bucket, cell]) => ({
      bucket,
      known: cell.known,
      positive: cell.positive,
      observedRate: round(cell.positive / cell.known) ?? 0,
    }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket));
}

export function summarizeDecisionBacktestByLabelAndWeek(input: {
  rows: readonly CreativeDecisionBacktestRow[];
  coverage: DecisionCoverageInput;
  coverageByWeek?: Readonly<Record<string, DecisionCoverageInput>>;
  maxStaleSnapshotCount?: number;
  minSegmentSampleSize?: number;
}): DecisionBacktestSegmentSummary[] {
  const groups = new Map<string, CreativeDecisionBacktestRow[]>();
  const minSegmentSampleSize = input.minSegmentSampleSize ?? 30;

  for (const row of input.rows) {
    const weekStartDate = weekStartIsoDate(row.asOfDate);
    const key = `${row.label}:${weekStartDate}`;
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }

  return Array.from(groups.entries())
    .map(([key, rows]) => {
      const separator = key.lastIndexOf(":");
      const label = key.slice(0, separator) as DecisionLabel;
      const weekStartDate = key.slice(separator + 1);
      const weekCoverage = input.coverageByWeek?.[weekStartDate] ?? input.coverage;
      const coverageScope: DecisionBacktestSegmentSummary["coverageScope"] =
        input.coverageByWeek?.[weekStartDate]
        ? "week"
        : "global";
      const summary = summarizeDecisionBacktest({
        rows,
        coverage: weekCoverage,
        maxStaleSnapshotCount: input.maxStaleSnapshotCount,
      });
      const confidenceLevel: DecisionBacktestSegmentSummary["confidenceLevel"] =
        summary.sampleSize >= minSegmentSampleSize
          ? "defensible"
          : summary.sampleSize >=
              Math.max(10, Math.floor(minSegmentSampleSize / 2))
            ? "directional"
            : "insufficient_sample";
      const insufficient = confidenceLevel === "insufficient_sample";
      return {
        label,
        weekStartDate,
        coverageScope,
        minSegmentSampleSize,
        ...summary,
        sampleReliable: confidenceLevel === "defensible",
        confidenceLevel,
        nonComputableReason: insufficient
          ? "insufficient_segment_sample_size"
          : null,
        hardActionPrecision: insufficient ? null : summary.hardActionPrecision,
        hardActionRecall: insufficient ? null : summary.hardActionRecall,
        expectedCalibrationError: insufficient
          ? null
          : summary.expectedCalibrationError,
      };
    })
    .sort(
      (left, right) =>
        left.weekStartDate.localeCompare(right.weekStartDate) ||
        left.label.localeCompare(right.label),
    );
}
