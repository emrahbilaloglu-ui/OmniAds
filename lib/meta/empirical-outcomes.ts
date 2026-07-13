export type MetaEmpiricalOutcomeClass =
  "positive" | "negative" | "neutral" | "unknown";
export type MetaEmpiricalConfidenceBand =
  "insufficient_sample" | "low" | "medium" | "high";

export const META_OBSERVATIONAL_EVIDENCE_CLASS = "observational_pre_post";
export const META_CONTROLLED_CAUSAL_EVIDENCE_CLASS = "controlled_causal";
export const META_CONTROLLED_CAUSAL_DESIGN_VERSION =
  "meta-controlled-causal-design.v1";
export const META_TREATMENT_RECEIPT_VERSION = "meta-treatment-receipt.v1";

export interface MetaControlledCausalEvidencePayload {
  evidenceClass: typeof META_CONTROLLED_CAUSAL_EVIDENCE_CLASS;
  causalDesign: {
    contractVersion: typeof META_CONTROLLED_CAUSAL_DESIGN_VERSION;
    method: "randomized_controlled_trial";
    experimentId: string;
    assignmentId: string;
    estimateId: string;
  };
  treatmentReceipt: {
    contractVersion: typeof META_TREATMENT_RECEIPT_VERSION;
    actionLogId: string;
    recommendationFingerprint: string;
    recId: string;
    experimentId: string;
    assignmentId: string;
    status: "success";
    verificationStatus: "verified";
    executedAt: string;
    verifiedAt: string;
  };
}

export interface MetaDecisionOutcomeSummaryInputRow {
  recommendationFingerprint?: string | null;
  recommendation_fingerprint?: string | null;
  recId?: string | null;
  rec_id?: string | null;
  treatmentReceiptValidated?: boolean | null;
  treatment_receipt_validated?: boolean | null;
  causalAssignmentValidated?: boolean | null;
  causal_assignment_validated?: boolean | null;
  causalEstimateValidated?: boolean | null;
  causal_estimate_validated?: boolean | null;
  actionType?: string | null;
  action_type?: string | null;
  outcomeStatus?: string | null;
  outcome_status?: string | null;
  recType?: string | null;
  rec_type?: string | null;
  decisionLabel?: string | null;
  decision_label?: string | null;
  payloadJson?: unknown;
  payload_json?: unknown;
}

export interface MetaControlledCausalOutcomeSummary {
  contractVersion: "meta-controlled-causal-outcome-summary.v1";
  claimedSampleSize: number;
  sampleSize: number;
  judgedSampleSize: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  unknownCount: number;
  precision: number | null;
  negativeRate: number | null;
  confidenceBand: MetaEmpiricalConfidenceBand;
  validTreatmentReceiptCount: number;
  invalidTreatmentReceiptCount: number;
  validatedAssignmentCount: number;
  invalidAssignmentCount: number;
  validatedEstimateCount: number;
  invalidEstimateCount: number;
  duplicateAssignmentCount: number;
  reusedTreatmentReceiptCount: number;
  reusedEstimateCount: number;
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
  controlledCausal: MetaControlledCausalOutcomeSummary;
  autoEligible: boolean;
}

export interface MetaEmpiricalOutcomeSummaryOptions {
  minSampleSize?: number;
  highPrecisionFloor?: number;
  mediumPrecisionFloor?: number;
  maxHighNegativeRate?: number;
}

export function metaEmpiricalOutcomeSummaryKey(input: {
  recType?: string | null;
  decisionLabel?: string | null;
}) {
  const recType = String(input.recType ?? "").trim();
  if (!recType) return null;
  const decisionLabel = String(input.decisionLabel ?? "").trim();
  return `${recType}::${decisionLabel || "*"}`;
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

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function validTimestamp(value: unknown): string | null {
  const normalized = nonEmptyString(value);
  if (!normalized) return null;
  return Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function payloadForRow(row: MetaDecisionOutcomeSummaryInputRow) {
  return record(row.payloadJson ?? row.payload_json);
}

function controlledCausalEvidenceClaimed(
  row: MetaDecisionOutcomeSummaryInputRow,
) {
  return (
    payloadForRow(row)?.evidenceClass === META_CONTROLLED_CAUSAL_EVIDENCE_CLASS
  );
}

interface ValidatedControlledCausalEvidence {
  assignmentKey: string;
  treatmentReceiptKey: string;
  estimateKey: string;
}

export function hasValidMetaControlledCausalEvidence(
  row: MetaDecisionOutcomeSummaryInputRow,
): boolean {
  return validatedMetaControlledCausalEvidence(row) !== null;
}

function validatedMetaControlledCausalEvidence(
  row: MetaDecisionOutcomeSummaryInputRow,
): ValidatedControlledCausalEvidence | null {
  if (
    (row.treatmentReceiptValidated ?? row.treatment_receipt_validated) !== true ||
    (row.causalAssignmentValidated ?? row.causal_assignment_validated) !== true ||
    (row.causalEstimateValidated ?? row.causal_estimate_validated) !== true
  ) {
    return null;
  }
  const payload = payloadForRow(row);
  if (payload?.evidenceClass !== META_CONTROLLED_CAUSAL_EVIDENCE_CLASS)
    return null;

  const design = record(payload.causalDesign);
  const receipt = record(payload.treatmentReceipt);
  if (!design || !receipt) return null;
  if (design.contractVersion !== META_CONTROLLED_CAUSAL_DESIGN_VERSION)
    return null;
  if (design.method !== "randomized_controlled_trial") return null;

  const experimentId = nonEmptyString(design.experimentId);
  const assignmentId = nonEmptyString(design.assignmentId);
  const estimateId = nonEmptyString(design.estimateId);
  const rowFingerprint = nonEmptyString(
    row.recommendationFingerprint ?? row.recommendation_fingerprint,
  );
  const rowRecId = nonEmptyString(row.recId ?? row.rec_id);
  if (
    !experimentId ||
    !assignmentId ||
    !estimateId ||
    !rowFingerprint ||
    !rowRecId
  )
    return null;

  const actionLogId = nonEmptyString(receipt.actionLogId);
  const executedAt = validTimestamp(receipt.executedAt);
  const verifiedAt = validTimestamp(receipt.verifiedAt);
  if (!actionLogId || !isUuid(actionLogId) || !executedAt || !verifiedAt)
    return null;
  if (Date.parse(verifiedAt) < Date.parse(executedAt)) return null;

  const valid =
    receipt.contractVersion === META_TREATMENT_RECEIPT_VERSION &&
    receipt.status === "success" &&
    receipt.verificationStatus === "verified" &&
    receipt.recommendationFingerprint === rowFingerprint &&
    receipt.recId === rowRecId &&
    receipt.experimentId === experimentId &&
    receipt.assignmentId === assignmentId;
  return valid
    ? {
        assignmentKey: `${experimentId}:${assignmentId}`,
        treatmentReceiptKey: actionLogId,
        estimateKey: `${experimentId}:${estimateId}`,
      }
    : null;
}

function confidenceBandFor(input: {
  judgedSampleSize: number;
  precision: number | null;
  negativeRate: number | null;
  minSampleSize: number;
  highPrecisionFloor: number;
  mediumPrecisionFloor: number;
  maxHighNegativeRate: number;
}): MetaEmpiricalConfidenceBand {
  if (
    input.judgedSampleSize < input.minSampleSize ||
    input.precision == null ||
    input.negativeRate == null
  ) {
    return "insufficient_sample";
  }
  if (
    input.precision >= input.highPrecisionFloor &&
    input.negativeRate <= input.maxHighNegativeRate
  ) {
    return "high";
  }
  return input.precision >= input.mediumPrecisionFloor ? "medium" : "low";
}

export function classifyMetaDecisionOutcomeStatus(
  status: string | null | undefined,
): MetaEmpiricalOutcomeClass {
  const normalized = String(status ?? "")
    .trim()
    .toLowerCase();
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
  let controlledClaimedSampleSize = 0;
  let controlledSampleSize = 0;
  let controlledPositiveCount = 0;
  let controlledNegativeCount = 0;
  let controlledNeutralCount = 0;
  let controlledUnknownCount = 0;
  let invalidTreatmentReceiptCount = 0;
  let invalidAssignmentCount = 0;
  let invalidEstimateCount = 0;
  let duplicateAssignmentCount = 0;
  let reusedTreatmentReceiptCount = 0;
  let reusedEstimateCount = 0;
  const seenAssignments = new Set<string>();
  const seenTreatmentReceipts = new Set<string>();
  const seenEstimates = new Set<string>();

  for (const row of rows) {
    const actionType = String(row.actionType ?? row.action_type ?? "")
      .trim()
      .toLowerCase();
    if (actionType !== "outcome") continue;
    sampleSize += 1;
    const outcome = classifyMetaDecisionOutcomeStatus(
      row.outcomeStatus ?? row.outcome_status,
    );
    if (outcome === "positive") positiveCount += 1;
    else if (outcome === "negative") negativeCount += 1;
    else if (outcome === "neutral") neutralCount += 1;
    else unknownCount += 1;

    const controlledClaimed = controlledCausalEvidenceClaimed(row);
    if (controlledClaimed) controlledClaimedSampleSize += 1;
    if (!controlledClaimed) continue;
    const receiptValidated =
      (row.treatmentReceiptValidated ?? row.treatment_receipt_validated) === true;
    const assignmentValidated =
      (row.causalAssignmentValidated ?? row.causal_assignment_validated) === true;
    const estimateValidated =
      (row.causalEstimateValidated ?? row.causal_estimate_validated) === true;
    if (!receiptValidated) invalidTreatmentReceiptCount += 1;
    if (!assignmentValidated) invalidAssignmentCount += 1;
    if (!estimateValidated) invalidEstimateCount += 1;
    const validated = validatedMetaControlledCausalEvidence(row);
    if (!validated) {
      continue;
    }
    if (seenAssignments.has(validated.assignmentKey)) {
      duplicateAssignmentCount += 1;
      continue;
    }
    if (seenTreatmentReceipts.has(validated.treatmentReceiptKey)) {
      reusedTreatmentReceiptCount += 1;
      continue;
    }
    if (seenEstimates.has(validated.estimateKey)) {
      reusedEstimateCount += 1;
      continue;
    }
    seenAssignments.add(validated.assignmentKey);
    seenTreatmentReceipts.add(validated.treatmentReceiptKey);
    seenEstimates.add(validated.estimateKey);
    controlledSampleSize += 1;
    if (outcome === "positive") controlledPositiveCount += 1;
    else if (outcome === "negative") controlledNegativeCount += 1;
    else if (outcome === "neutral") controlledNeutralCount += 1;
    else controlledUnknownCount += 1;
  }

  const judgedSampleSize = positiveCount + negativeCount;
  const precision = ratio(positiveCount, judgedSampleSize);
  const negativeRate = ratio(negativeCount, judgedSampleSize);
  const confidenceBand = confidenceBandFor({
    judgedSampleSize,
    precision,
    negativeRate,
    minSampleSize,
    highPrecisionFloor,
    mediumPrecisionFloor,
    maxHighNegativeRate,
  });
  const controlledJudgedSampleSize =
    controlledPositiveCount + controlledNegativeCount;
  const controlledPrecision = ratio(
    controlledPositiveCount,
    controlledJudgedSampleSize,
  );
  const controlledNegativeRate = ratio(
    controlledNegativeCount,
    controlledJudgedSampleSize,
  );
  const controlledConfidenceBand = confidenceBandFor({
    judgedSampleSize: controlledJudgedSampleSize,
    precision: controlledPrecision,
    negativeRate: controlledNegativeRate,
    minSampleSize,
    highPrecisionFloor,
    mediumPrecisionFloor,
    maxHighNegativeRate,
  });
  const controlledCausal: MetaControlledCausalOutcomeSummary = {
    contractVersion: "meta-controlled-causal-outcome-summary.v1",
    claimedSampleSize: controlledClaimedSampleSize,
    sampleSize: controlledSampleSize,
    judgedSampleSize: controlledJudgedSampleSize,
    positiveCount: controlledPositiveCount,
    negativeCount: controlledNegativeCount,
    neutralCount: controlledNeutralCount,
    unknownCount: controlledUnknownCount,
    precision: controlledPrecision,
    negativeRate: controlledNegativeRate,
    confidenceBand: controlledConfidenceBand,
    validTreatmentReceiptCount: controlledSampleSize,
    invalidTreatmentReceiptCount,
    validatedAssignmentCount: controlledSampleSize,
    invalidAssignmentCount,
    validatedEstimateCount: controlledSampleSize,
    invalidEstimateCount,
    duplicateAssignmentCount,
    reusedTreatmentReceiptCount,
    reusedEstimateCount,
  };
  const controlledIntegrityComplete =
    controlledClaimedSampleSize === controlledSampleSize &&
    invalidTreatmentReceiptCount === 0 &&
    invalidAssignmentCount === 0 &&
    invalidEstimateCount === 0 &&
    duplicateAssignmentCount === 0 &&
    reusedTreatmentReceiptCount === 0 &&
    reusedEstimateCount === 0;

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
    controlledCausal,
    autoEligible:
      controlledConfidenceBand === "high" && controlledIntegrityComplete,
  };
}

export function isMetaOutcomeSummaryAutoEligible(
  summary: MetaEmpiricalOutcomeSummary | null | undefined,
): boolean {
  if (!summary?.autoEligible) return false;
  if (summary.contractVersion !== "meta-empirical-outcome-summary.v1") return false;
  const controlled = summary.controlledCausal;
  if (!controlled) return false;
  return (
    controlled.contractVersion === "meta-controlled-causal-outcome-summary.v1" &&
    controlled.confidenceBand === "high" &&
    controlled.judgedSampleSize >= summary.minSampleSize &&
    controlled.validTreatmentReceiptCount === controlled.sampleSize &&
    controlled.validatedAssignmentCount === controlled.sampleSize &&
    controlled.validatedEstimateCount === controlled.sampleSize &&
    controlled.invalidTreatmentReceiptCount === 0 &&
    controlled.invalidAssignmentCount === 0 &&
    controlled.invalidEstimateCount === 0 &&
    controlled.duplicateAssignmentCount === 0 &&
    controlled.reusedTreatmentReceiptCount === 0 &&
    controlled.reusedEstimateCount === 0 &&
    controlled.sampleSize >= controlled.judgedSampleSize &&
    controlled.claimedSampleSize === controlled.sampleSize &&
    controlled.precision != null &&
    controlled.negativeRate != null
  );
}

export function summarizeMetaDecisionOutcomesByKey(
  rows: MetaDecisionOutcomeSummaryInputRow[],
  options: MetaEmpiricalOutcomeSummaryOptions = {},
) {
  const rowsByKey = new Map<string, MetaDecisionOutcomeSummaryInputRow[]>();

  for (const row of rows) {
    const key = metaEmpiricalOutcomeSummaryKey({
      recType: row.recType ?? row.rec_type,
      decisionLabel: row.decisionLabel ?? row.decision_label,
    });
    if (!key) continue;
    const bucket = rowsByKey.get(key) ?? [];
    bucket.push(row);
    rowsByKey.set(key, bucket);
  }

  return Object.fromEntries(
    Array.from(rowsByKey.entries()).map(([key, groupedRows]) => [
      key,
      summarizeMetaDecisionOutcomes(groupedRows, options),
    ]),
  );
}
