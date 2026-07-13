import { getDb } from "@/lib/db";
import {
  summarizeDecisionBacktest,
  type DecisionBacktestSummary,
} from "./backtest";
import { NATIVE_AD_ENGINE_VERSION, type DecisionLabel } from "./types";
import { AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR } from "./jobs/ad-decision-outcomes-job";

export const READ_EXACT_AD_DECISION_BACKTEST_ROWS_SQL = `
SELECT
  outcome.id::text AS outcome_id,
  outcome.outcome_run_id::text AS outcome_run_id,
  outcome.decision_snapshot_id::text AS decision_snapshot_id,
  outcome.evaluation_id::text AS evaluation_id,
  outcome.source_decision_job_run_id::text AS source_decision_job_run_id,
  outcome.business_ref_id::text AS business_ref_id,
  outcome.business_id,
  outcome.provider_account_ref_id::text AS provider_account_ref_id,
  outcome.provider_account_id,
  outcome.decision_entity_type,
  outcome.decision_entity_id,
  outcome.ad_id,
  outcome.creative_id,
  outcome.decision_as_of_date::text AS decision_as_of_date,
  outcome.evaluation_date::text AS evaluation_date,
  outcome.source_cutoff_at::text AS source_cutoff_at,
  outcome.outcome_window_days,
  outcome.outcome_window_start::text AS outcome_window_start,
  outcome.outcome_window_end::text AS outcome_window_end,
  outcome.engine_version,
  outcome.scope_type,
  outcome.scope_id,
  outcome.label,
  outcome.raw_label,
  outcome.confidence,
  outcome.account_currency,
  outcome.currency_status,
  outcome.effective_cohort,
  outcome.objective,
  outcome.optimization_goal,
  outcome.custom_event_type,
  outcome.measurement_status,
  outcome.realized_outcome,
  outcome.severity,
  outcome.treatment_status,
  outcome.action_contaminated,
  outcome.controlled_evidence_validated,
  outcome.treatment_receipt_validated,
  outcome.causal_assignment_validated,
  outcome.causal_estimate_validated,
  outcome.window_complete,
  outcome.outcome_spend,
  outcome.source_input_hash::text AS source_input_hash,
  outcome.source_decision_hash::text AS source_decision_hash,
  outcome.source_manifest_hash::text AS source_manifest_hash,
  outcome.source_set_hash::text AS source_set_hash,
  outcome.computed_at::text AS outcome_computed_at,
  snapshot.computed_at::text AS snapshot_computed_at,
  evaluation.evaluated_at::text AS evaluated_at
FROM engine_v3_ad_decision_outcomes_daily outcome
INNER JOIN engine_v3_ad_decision_outcome_runs outcome_run
  ON outcome_run.id = outcome.outcome_run_id
 AND outcome_run.job_run_id = outcome.job_run_id
 AND outcome_run.business_ref_id = outcome.business_ref_id
 AND outcome_run.evaluation_date = outcome.evaluation_date
 AND outcome_run.engine_version = outcome.engine_version
 AND outcome_run.contract_version = outcome.contract_version
 AND outcome_run.classifier_version = outcome.classifier_version
 AND outcome_run.source_set_hash = outcome.source_set_hash
 AND outcome_run.status = 'complete'
 AND outcome_run.persisted_row_count = outcome_run.candidate_row_count
INNER JOIN engine_v3_ad_decision_outcome_publications publication
  ON publication.business_ref_id = outcome.business_ref_id
 AND publication.business_id = outcome.business_id
 AND publication.evaluation_date = outcome.evaluation_date
 AND publication.outcome_window_days = outcome.outcome_window_days
 AND publication.engine_version = outcome.engine_version
 AND publication.contract_version = outcome.contract_version
 AND publication.classifier_version = outcome.classifier_version
 AND publication.active_job_run_id = outcome.job_run_id
 AND publication.active_outcome_run_id = outcome.outcome_run_id
 AND publication.source_set_hash = outcome.source_set_hash
INNER JOIN business_provider_accounts account_binding
  ON account_binding.business_id = outcome.business_id
 AND account_binding.provider = 'meta'
 AND account_binding.provider_account_ref_id = outcome.provider_account_ref_id
 AND account_binding.provider_account_id = outcome.provider_account_id
INNER JOIN engine_v3_ad_decision_snapshots_daily snapshot
 ON snapshot.id = outcome.decision_snapshot_id
 AND snapshot.evaluation_id = outcome.evaluation_id
 AND snapshot.job_run_id = outcome.source_decision_job_run_id
 AND snapshot.business_ref_id = outcome.business_ref_id
 AND snapshot.business_id = outcome.business_id
 AND snapshot.provider_account_ref_id = outcome.provider_account_ref_id
 AND snapshot.provider_account_id = outcome.provider_account_id
 AND snapshot.decision_entity_type = outcome.decision_entity_type
 AND snapshot.decision_entity_id = outcome.decision_entity_id
 AND snapshot.ad_id = outcome.ad_id
 AND snapshot.as_of_date = outcome.decision_as_of_date
 AND snapshot.engine_version = outcome.engine_version
 AND snapshot.scope_type = outcome.scope_type
 AND snapshot.scope_id = outcome.scope_id
 AND snapshot.input_hash = outcome.source_input_hash
 AND snapshot.decision_hash = outcome.source_decision_hash
INNER JOIN engine_v3_ad_decision_evaluations evaluation
 ON evaluation.id = outcome.evaluation_id
 AND evaluation.job_run_id = outcome.source_decision_job_run_id
 AND evaluation.business_ref_id = outcome.business_ref_id
 AND evaluation.business_id = outcome.business_id
 AND evaluation.provider_account_ref_id = outcome.provider_account_ref_id
 AND evaluation.provider_account_id = outcome.provider_account_id
 AND evaluation.decision_entity_type = outcome.decision_entity_type
 AND evaluation.decision_entity_id = outcome.decision_entity_id
 AND evaluation.ad_id = outcome.ad_id
 AND evaluation.as_of_date = outcome.decision_as_of_date
 AND evaluation.engine_version = outcome.engine_version
 AND evaluation.scope_type = outcome.scope_type
 AND evaluation.scope_id = outcome.scope_id
 AND evaluation.input_hash = outcome.source_input_hash
 AND evaluation.decision_hash = outcome.source_decision_hash
WHERE outcome.business_ref_id = $1::uuid
  AND outcome.id = ANY($2::uuid[])
  AND outcome.engine_version = $3
ORDER BY
  outcome.decision_as_of_date,
  outcome.provider_account_id,
  outcome.ad_id,
  outcome.outcome_window_days,
  outcome.id
`;

export type AdBacktestEvidenceClass =
  | "observational_uncontaminated"
  | "observational_action_exposed"
  | "controlled_causal";

export interface AdDecisionBacktestRow {
  outcomeId: string;
  outcomeRunId: string;
  decisionSnapshotId: string;
  evaluationId: string;
  sourceDecisionJobRunId: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityType: "ad";
  decisionEntityId: string;
  adId: string;
  creativeId: string | null;
  decisionAsOfDate: string;
  evaluationDate: string;
  sourceCutoffAt: string;
  outcomeWindowDays: 3 | 7 | 14;
  outcomeWindowStart: string;
  outcomeWindowEnd: string;
  engineEpoch: string;
  scopeType: string;
  scopeId: string;
  label: DecisionLabel;
  rawLabel: DecisionLabel;
  confidence: number;
  accountCurrency: string | null;
  currencyStatus: "known" | "unknown" | "conflict";
  effectiveCohort: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  measurementStatus: "known" | "unknown" | "censored" | "explained_zero_spend";
  realizedOutcome: "positive" | "negative" | "neutral" | "unknown";
  severity: "critical" | "high" | "medium" | "low";
  treatmentStatus:
    | "observational_untreated"
    | "observational_action_exposed"
    | "controlled_treatment";
  evidenceClass: AdBacktestEvidenceClass;
  actionContaminated: boolean;
  controlledEvidenceValidated: boolean;
  treatmentReceiptValidated: boolean;
  causalAssignmentValidated: boolean;
  causalEstimateValidated: boolean;
  windowComplete: boolean;
  outcomeSpend: number;
  sourceInputHash: string;
  sourceDecisionHash: string;
  sourceManifestHash: string;
  sourceSetHash: string;
  outcomeComputedAt: string;
  snapshotComputedAt: string;
  evaluatedAt: string;
}

export interface AdDecisionBacktestStratumKey {
  businessRefId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountCurrency: string | null;
  currencyStatus: "known" | "unknown" | "conflict";
  engineEpoch: string;
  scopeType: string;
  scopeId: string;
  decisionLabel: DecisionLabel;
  effectiveCohort: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  outcomeWindowDays: 3 | 7 | 14;
  evidenceClass: AdBacktestEvidenceClass;
}

export type AdDecisionBacktestMetrics = Pick<
  DecisionBacktestSummary,
  | "hardActionPrecision"
  | "hardActionRecall"
  | "expectedCalibrationError"
  | "criticalFalsePositiveRate"
  | "highSeverityMissedOpportunityRate"
  | "sampleSize"
  | "hardActionKnownSampleSize"
  | "hardConfidenceBuckets"
>;

export interface AdDecisionBacktestStratum {
  key: AdDecisionBacktestStratumKey;
  coverageBasis: "exact_selected_episode_lineage";
  linkageCoverage: 1;
  interpretation:
    "observational_association_only" | "randomized_controlled_causal";
  causalInterpretationAllowed: boolean;
  episodeCount: number;
  outcomeIds: string[];
  decisionSnapshotIds: string[];
  evaluationIds: string[];
  adIds: string[];
  metrics: AdDecisionBacktestMetrics;
}

export interface AdDecisionBacktestReport {
  rows: AdDecisionBacktestRow[];
  strata: AdDecisionBacktestStratum[];
}

export interface ReadAdDecisionBacktestInput {
  businessId: string;
  outcomeIds: readonly string[];
}

export type AdBacktestQuery = <
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  queryText: string,
  params?: readonly unknown[],
) => Promise<Row[]>;

export async function readAdDecisionBacktest(
  input: ReadAdDecisionBacktestInput,
  query: AdBacktestQuery = defaultQuery,
): Promise<AdDecisionBacktestReport> {
  const businessId = requiredText(input.businessId, "businessId");
  const outcomeIds = input.outcomeIds.map((id, index) =>
    requiredText(id, `outcomeIds[${index}]`),
  );
  if (outcomeIds.length === 0) {
    throw new TypeError("At least one exact native outcome ID is required.");
  }
  if (outcomeIds.length > 5_000) {
    throw new TypeError("At most 5000 exact native outcome IDs may be read.");
  }
  if (new Set(outcomeIds).size !== outcomeIds.length) {
    throw new TypeError("Exact native outcome IDs must be unique.");
  }
  const rows = await query<Record<string, unknown>>(
    READ_EXACT_AD_DECISION_BACKTEST_ROWS_SQL,
    [businessId, outcomeIds, NATIVE_AD_ENGINE_VERSION],
  );
  const report = buildAdDecisionBacktestReport(rows);
  assertExactOutcomeSet(outcomeIds, report.rows);
  if (report.rows.some((row) => row.businessRefId !== businessId)) {
    throw new Error("Native backtest returned a cross-tenant outcome row.");
  }
  return report;
}

export function buildAdDecisionBacktestReport(
  sourceRows: readonly Record<string, unknown>[],
): AdDecisionBacktestReport {
  const rows = sourceRows.map(mapAdDecisionBacktestRow).sort(compareRows);
  const seenOutcomes = new Set<string>();
  const seenEpisodes = new Set<string>();
  for (const row of rows) {
    if (seenOutcomes.has(row.outcomeId)) {
      throw new Error(`Duplicate native backtest outcome: ${row.outcomeId}`);
    }
    seenOutcomes.add(row.outcomeId);
    const episodeKey = `${row.decisionSnapshotId}\u0000${row.evaluationId}\u0000${row.outcomeWindowDays}`;
    if (seenEpisodes.has(episodeKey)) {
      throw new Error(
        `Multiple immutable outcome versions selected for one native episode: ${episodeKey}`,
      );
    }
    seenEpisodes.add(episodeKey);
  }

  const groups = new Map<
    string,
    { key: AdDecisionBacktestStratumKey; rows: AdDecisionBacktestRow[] }
  >();
  for (const row of rows) {
    const key: AdDecisionBacktestStratumKey = {
      businessRefId: row.businessRefId,
      providerAccountRefId: row.providerAccountRefId,
      providerAccountId: row.providerAccountId,
      accountCurrency: row.accountCurrency,
      currencyStatus: row.currencyStatus,
      engineEpoch: row.engineEpoch,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      decisionLabel: row.label,
      effectiveCohort: row.effectiveCohort,
      objective: row.objective,
      optimizationGoal: row.optimizationGoal,
      customEventType: row.customEventType,
      outcomeWindowDays: row.outcomeWindowDays,
      evidenceClass: row.evidenceClass,
    };
    const serialized = JSON.stringify(key);
    const group = groups.get(serialized) ?? { key, rows: [] };
    group.rows.push(row);
    groups.set(serialized, group);
  }

  const strata = Array.from(groups.values())
    .map(({ key, rows: stratumRows }): AdDecisionBacktestStratum => {
      const summary = summarizeDecisionBacktest({
        rows: stratumRows.map((row) => ({
          // Existing math is identity-agnostic. The native row remains the
          // public evidence surface; adId is passed only to satisfy that API.
          creativeId: row.adId,
          asOfDate: row.decisionAsOfDate,
          label: row.label,
          confidence: row.confidence,
          realizedOutcome: row.realizedOutcome,
          severity: row.severity,
        })),
        coverage: {
          activeCreativeCount: stratumRows.length,
          snapshotRowCount: stratumRows.length,
          staleSnapshotCount: 0,
          conflictingSnapshotCount: 0,
        },
      });
      return {
        key,
        coverageBasis: "exact_selected_episode_lineage",
        linkageCoverage: 1,
        interpretation:
          key.evidenceClass === "controlled_causal"
            ? "randomized_controlled_causal"
            : "observational_association_only",
        causalInterpretationAllowed: key.evidenceClass === "controlled_causal",
        episodeCount: stratumRows.length,
        outcomeIds: stratumRows.map((row) => row.outcomeId),
        decisionSnapshotIds: stratumRows.map((row) => row.decisionSnapshotId),
        evaluationIds: stratumRows.map((row) => row.evaluationId),
        adIds: stratumRows.map((row) => row.adId),
        metrics: pickNativeMetrics(summary),
      };
    })
    .sort(compareStrata);

  return { rows, strata };
}

function mapAdDecisionBacktestRow(
  row: Record<string, unknown>,
): AdDecisionBacktestRow {
  const decisionEntityType = requiredText(
    row.decision_entity_type,
    "decision_entity_type",
  );
  const decisionEntityId = requiredText(
    row.decision_entity_id,
    "decision_entity_id",
  );
  const adId = requiredText(row.ad_id, "ad_id");
  if (decisionEntityType !== "ad" || decisionEntityId !== adId) {
    throw new Error("Native backtest row is not exact ad grain.");
  }
  const currencyStatus = toCurrencyStatus(row.currency_status);
  const rawCurrency = textOrNull(row.account_currency);
  const accountCurrency = rawCurrency?.toUpperCase() ?? null;
  if (currencyStatus === "known" && accountCurrency === null) {
    throw new Error("Known native outcome currency is missing.");
  }
  if (currencyStatus !== "known" && accountCurrency !== null) {
    throw new Error(
      "Unknown or conflicting native currency must not be pooled.",
    );
  }
  const actionContaminated = requiredBoolean(
    row.action_contaminated,
    "action_contaminated",
  );
  const controlledEvidenceValidated = requiredBoolean(
    row.controlled_evidence_validated,
    "controlled_evidence_validated",
  );
  const treatmentReceiptValidated = requiredBoolean(
    row.treatment_receipt_validated,
    "treatment_receipt_validated",
  );
  const causalAssignmentValidated = requiredBoolean(
    row.causal_assignment_validated,
    "causal_assignment_validated",
  );
  const causalEstimateValidated = requiredBoolean(
    row.causal_estimate_validated,
    "causal_estimate_validated",
  );
  const windowComplete = requiredBoolean(
    row.window_complete,
    "window_complete",
  );
  const outcomeSpend = requiredNonNegativeNumber(
    row.outcome_spend,
    "outcome_spend",
  );
  const treatmentStatus = toTreatmentStatus(row.treatment_status);
  if (
    (treatmentStatus === "observational_untreated" && actionContaminated) ||
    (treatmentStatus === "observational_action_exposed" &&
      !actionContaminated) ||
    (treatmentStatus === "controlled_treatment" &&
      (!actionContaminated ||
        !controlledEvidenceValidated ||
        !treatmentReceiptValidated ||
        !causalAssignmentValidated ||
        !causalEstimateValidated)) ||
    (treatmentStatus !== "controlled_treatment" && controlledEvidenceValidated)
  ) {
    throw new Error("Native backtest treatment lineage is inconsistent.");
  }
  const evidenceClass: AdBacktestEvidenceClass =
    treatmentStatus === "controlled_treatment" && controlledEvidenceValidated
      ? "controlled_causal"
      : actionContaminated
        ? "observational_action_exposed"
        : "observational_uncontaminated";

  const decisionAsOfDate = requiredDate(
    row.decision_as_of_date,
    "decision_as_of_date",
  );
  const evaluationDate = requiredDate(row.evaluation_date, "evaluation_date");
  const outcomeWindowDays = toWindowDays(row.outcome_window_days);
  const sourceCutoffAt = requiredTimestamp(
    row.source_cutoff_at,
    "source_cutoff_at",
  );
  const outcomeWindowStart = requiredDate(
    row.outcome_window_start,
    "outcome_window_start",
  );
  const outcomeWindowEnd = requiredDate(
    row.outcome_window_end,
    "outcome_window_end",
  );
  if (
    outcomeWindowStart !== addIsoDays(decisionAsOfDate, 1) ||
    outcomeWindowEnd !== addIsoDays(decisionAsOfDate, outcomeWindowDays) ||
    addIsoDays(outcomeWindowEnd, 1) !== evaluationDate
  ) {
    throw new Error("Native backtest outcome window is not cutoff-strict.");
  }
  if (
    sourceCutoffAt !==
    `${evaluationDate}T${String(AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR).padStart(2, "0")}:00:00.000Z`
  ) {
    throw new Error("Native backtest source cutoff policy drifted.");
  }
  const engineEpoch = requiredText(row.engine_version, "engine_version");
  if (engineEpoch !== NATIVE_AD_ENGINE_VERSION) {
    throw new Error("Native backtest row uses a non-current engine epoch.");
  }
  const businessRefId = requiredText(row.business_ref_id, "business_ref_id");
  const businessId = requiredText(row.business_id, "business_id");
  if (businessId !== businessRefId) {
    throw new Error("Native backtest business binding is inconsistent.");
  }
  const providerAccountRefId = requiredText(
    row.provider_account_ref_id,
    "provider_account_ref_id",
  );
  const providerAccountId = requiredText(
    row.provider_account_id,
    "provider_account_id",
  );
  const scopeType = requiredText(row.scope_type, "scope_type");
  const scopeId = requiredText(row.scope_id, "scope_id");
  if (scopeType !== "account" || scopeId !== providerAccountId) {
    throw new Error("Native backtest account scope binding is inconsistent.");
  }
  const measurementStatus = toMeasurementStatus(row.measurement_status);
  const realizedOutcome = toRealizedOutcome(row.realized_outcome);
  if (
    (measurementStatus === "known" &&
      (!windowComplete ||
        outcomeSpend <= 0 ||
        realizedOutcome === "unknown")) ||
    ((measurementStatus === "censored" ||
      measurementStatus === "explained_zero_spend") &&
      (!windowComplete ||
        outcomeSpend !== 0 ||
        realizedOutcome !== "unknown")) ||
    (measurementStatus === "unknown" && realizedOutcome !== "unknown")
  ) {
    throw new Error("Native backtest measurement status is inconsistent.");
  }

  return {
    outcomeId: requiredText(row.outcome_id, "outcome_id"),
    outcomeRunId: requiredText(row.outcome_run_id, "outcome_run_id"),
    decisionSnapshotId: requiredText(
      row.decision_snapshot_id,
      "decision_snapshot_id",
    ),
    evaluationId: requiredText(row.evaluation_id, "evaluation_id"),
    sourceDecisionJobRunId: requiredText(
      row.source_decision_job_run_id,
      "source_decision_job_run_id",
    ),
    businessRefId,
    businessId,
    providerAccountRefId,
    providerAccountId,
    decisionEntityType: "ad",
    decisionEntityId,
    adId,
    creativeId: textOrNull(row.creative_id),
    decisionAsOfDate,
    evaluationDate,
    sourceCutoffAt,
    outcomeWindowDays,
    outcomeWindowStart,
    outcomeWindowEnd,
    engineEpoch,
    scopeType,
    scopeId,
    label: toDecisionLabel(row.label),
    rawLabel: toDecisionLabel(row.raw_label),
    confidence: boundedInteger(row.confidence, 0, 100, "confidence"),
    accountCurrency,
    currencyStatus,
    effectiveCohort: textOrNull(row.effective_cohort),
    objective: textOrNull(row.objective),
    optimizationGoal: textOrNull(row.optimization_goal),
    customEventType: textOrNull(row.custom_event_type),
    measurementStatus,
    realizedOutcome,
    severity: toSeverity(row.severity),
    treatmentStatus,
    evidenceClass,
    actionContaminated,
    controlledEvidenceValidated,
    treatmentReceiptValidated,
    causalAssignmentValidated,
    causalEstimateValidated,
    windowComplete,
    outcomeSpend,
    sourceInputHash: requiredHash(row.source_input_hash, "source_input_hash"),
    sourceDecisionHash: requiredHash(
      row.source_decision_hash,
      "source_decision_hash",
    ),
    sourceManifestHash: requiredHash(
      row.source_manifest_hash,
      "source_manifest_hash",
    ),
    sourceSetHash: requiredHash(row.source_set_hash, "source_set_hash"),
    outcomeComputedAt: requiredTimestamp(
      row.outcome_computed_at,
      "outcome_computed_at",
    ),
    snapshotComputedAt: requiredTimestamp(
      row.snapshot_computed_at,
      "snapshot_computed_at",
    ),
    evaluatedAt: requiredTimestamp(row.evaluated_at, "evaluated_at"),
  };
}

function pickNativeMetrics(
  summary: DecisionBacktestSummary,
): AdDecisionBacktestMetrics {
  return {
    hardActionPrecision: summary.hardActionPrecision,
    hardActionRecall: summary.hardActionRecall,
    expectedCalibrationError: summary.expectedCalibrationError,
    criticalFalsePositiveRate: summary.criticalFalsePositiveRate,
    highSeverityMissedOpportunityRate:
      summary.highSeverityMissedOpportunityRate,
    sampleSize: summary.sampleSize,
    hardActionKnownSampleSize: summary.hardActionKnownSampleSize,
    hardConfidenceBuckets: summary.hardConfidenceBuckets,
  };
}

function assertExactOutcomeSet(
  expectedIds: readonly string[],
  rows: readonly AdDecisionBacktestRow[],
) {
  const actualIds = new Set(rows.map((row) => row.outcomeId));
  const missing = expectedIds.filter((id) => !actualIds.has(id));
  if (missing.length > 0 || actualIds.size !== expectedIds.length) {
    throw new Error(
      `Native backtest exact outcome linkage failed: missing ${missing.join(", ") || "none"}.`,
    );
  }
}

function compareRows(
  left: AdDecisionBacktestRow,
  right: AdDecisionBacktestRow,
) {
  return (
    left.decisionAsOfDate.localeCompare(right.decisionAsOfDate) ||
    left.providerAccountRefId.localeCompare(right.providerAccountRefId) ||
    left.providerAccountId.localeCompare(right.providerAccountId) ||
    left.adId.localeCompare(right.adId) ||
    left.outcomeWindowDays - right.outcomeWindowDays ||
    left.outcomeId.localeCompare(right.outcomeId)
  );
}

function compareStrata(
  left: AdDecisionBacktestStratum,
  right: AdDecisionBacktestStratum,
) {
  return JSON.stringify(left.key).localeCompare(JSON.stringify(right.key));
}

const defaultQuery: AdBacktestQuery = async <
  Row extends Record<string, unknown>,
>(
  queryText: string,
  params?: readonly unknown[],
) => getDb().query<Row>(queryText, params ? [...params] : undefined);

function textOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredText(value: unknown, field: string) {
  const text = textOrNull(value);
  if (!text) throw new Error(`Missing native backtest field: ${field}`);
  return text;
}

function numberOrNull(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function requiredNonNegativeNumber(value: unknown, field: string) {
  const parsed = numberOrNull(value);
  if (parsed === null || parsed < 0) {
    throw new Error(`Invalid native backtest number: ${field}`);
  }
  return parsed;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  field: string,
) {
  const parsed = numberOrNull(value);
  if (
    parsed === null ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    throw new Error(`Invalid native backtest integer: ${field}`);
  }
  return parsed;
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid native backtest boolean: ${field}`);
  }
  return value;
}

function dateOrNull(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = textOrNull(value)?.slice(0, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text
    ? text
    : null;
}

function requiredDate(value: unknown, field: string) {
  const date = dateOrNull(value);
  if (!date) throw new Error(`Invalid native backtest date: ${field}`);
  return date;
}

function addIsoDays(date: string, days: number) {
  const parsed = new Date(`${requiredDate(date, "date")}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function requiredTimestamp(value: unknown, field: string) {
  const text = textOrNull(value);
  if (!text) throw new Error(`Invalid native backtest timestamp: ${field}`);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid native backtest timestamp: ${field}`);
  }
  return parsed.toISOString();
}

function requiredHash(value: unknown, field: string) {
  const hash = requiredText(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`Invalid native backtest hash: ${field}`);
  }
  return hash;
}

function toWindowDays(value: unknown): 3 | 7 | 14 {
  const window = boundedInteger(value, 1, 14, "outcome_window_days");
  if (window === 3 || window === 7 || window === 14) return window;
  throw new Error(`Unsupported native backtest window: ${window}`);
}

function toDecisionLabel(value: unknown): DecisionLabel {
  const label = requiredText(value, "label");
  if (
    label === "scale" ||
    label === "keep" ||
    label === "refresh" ||
    label === "cut" ||
    label === "test_more" ||
    label === "diagnose" ||
    label === "out_of_scope"
  ) {
    return label;
  }
  throw new Error(`Unexpected native backtest label: ${label}`);
}

function toCurrencyStatus(value: unknown) {
  if (value === "known" || value === "unknown" || value === "conflict") {
    return value;
  }
  throw new Error(`Unexpected native currency status: ${String(value)}`);
}

function toMeasurementStatus(value: unknown) {
  if (
    value === "known" ||
    value === "unknown" ||
    value === "censored" ||
    value === "explained_zero_spend"
  ) {
    return value;
  }
  throw new Error(`Unexpected native measurement status: ${String(value)}`);
}

function toRealizedOutcome(value: unknown) {
  if (
    value === "positive" ||
    value === "negative" ||
    value === "neutral" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new Error(`Unexpected native realized outcome: ${String(value)}`);
}

function toSeverity(value: unknown) {
  if (
    value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low"
  ) {
    return value;
  }
  throw new Error(`Unexpected native outcome severity: ${String(value)}`);
}

function toTreatmentStatus(value: unknown) {
  if (
    value === "observational_untreated" ||
    value === "observational_action_exposed" ||
    value === "controlled_treatment"
  ) {
    return value;
  }
  throw new Error(`Unexpected native treatment status: ${String(value)}`);
}
