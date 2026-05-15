export type MetaEmpiricalOutcomeClass = "positive" | "negative" | "neutral" | "unknown";
export type MetaEmpiricalConfidenceBand = "insufficient_sample" | "low" | "medium" | "high";

export interface MetaDecisionOutcomeSummaryInputRow {
  actionType?: string | null;
  action_type?: string | null;
  outcomeStatus?: string | null;
  outcome_status?: string | null;
}

export interface MetaEmpiricalOutcomeSummary {
  contractVersion: "meta-empirical-outcome-summary.v1";
  sampleSize: number;
  judgedSampleSize: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  unknownCount: number;
  precision: number | null;
  negativeRate: number | null;
  confidenceBand: MetaEmpiricalConfidenceBand;
  minSampleSize: number;
  autoEligible: boolean;
}

export interface MetaEmpiricalOutcomeSummaryOptions {
  minSampleSize?: number;
  highPrecisionFloor?: number;
  mediumPrecisionFloor?: number;
  maxHighNegativeRate?: number;
}

const POSITIVE_STATUSES = new Set([
  "positive",
  "success",
  "succeeded",
  "win",
  "won",
  "improved",
  "profitable",
]);

const NEGATIVE_STATUSES = new Set([
  "negative",
  "failure",
  "failed",
  "loss",
  "lost",
  "worse",
  "regressed",
  "unprofitable",
]);

const NEUTRAL_STATUSES = new Set([
  "neutral",
  "mixed",
  "inconclusive",
  "flat",
  "no_change",
]);

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function classifyMetaDecisionOutcomeStatus(
  status: string | null | undefined,
): MetaEmpiricalOutcomeClass {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (POSITIVE_STATUSES.has(normalized)) return "positive";
  if (NEGATIVE_STATUSES.has(normalized)) return "negative";
  if (NEUTRAL_STATUSES.has(normalized)) return "neutral";
  return "unknown";
}

export function summarizeMetaDecisionOutcomes(
  rows: MetaDecisionOutcomeSummaryInputRow[],
  options: MetaEmpiricalOutcomeSummaryOptions = {},
): MetaEmpiricalOutcomeSummary {
  const minSampleSize = Math.max(1, Math.floor(options.minSampleSize ?? 10));
  const highPrecisionFloor = options.highPrecisionFloor ?? 0.8;
  const mediumPrecisionFloor = options.mediumPrecisionFloor ?? 0.65;
  const maxHighNegativeRate = options.maxHighNegativeRate ?? 0.15;
  let positiveCount = 0;
  let negativeCount = 0;
  let neutralCount = 0;
  let unknownCount = 0;
  let sampleSize = 0;

  for (const row of rows) {
    const actionType = String(row.actionType ?? row.action_type ?? "").trim().toLowerCase();
    if (actionType !== "outcome") continue;
    sampleSize += 1;
    const outcome = classifyMetaDecisionOutcomeStatus(row.outcomeStatus ?? row.outcome_status);
    if (outcome === "positive") positiveCount += 1;
    else if (outcome === "negative") negativeCount += 1;
    else if (outcome === "neutral") neutralCount += 1;
    else unknownCount += 1;
  }

  const judgedSampleSize = positiveCount + negativeCount;
  const precision = ratio(positiveCount, judgedSampleSize);
  const negativeRate = ratio(negativeCount, judgedSampleSize);
  let confidenceBand: MetaEmpiricalConfidenceBand = "insufficient_sample";

  if (judgedSampleSize >= minSampleSize && precision != null && negativeRate != null) {
    if (precision >= highPrecisionFloor && negativeRate <= maxHighNegativeRate) {
      confidenceBand = "high";
    } else if (precision >= mediumPrecisionFloor) {
      confidenceBand = "medium";
    } else {
      confidenceBand = "low";
    }
  }

  return {
    contractVersion: "meta-empirical-outcome-summary.v1",
    sampleSize,
    judgedSampleSize,
    positiveCount,
    negativeCount,
    neutralCount,
    unknownCount,
    precision,
    negativeRate,
    confidenceBand,
    minSampleSize,
    autoEligible: confidenceBand === "high",
  };
}
