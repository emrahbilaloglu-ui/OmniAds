import { getDb, type DbClient } from "@/lib/db";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY } from "../data-source";
import { inspectEvaluationStoreSchemaCapability } from "../evaluation-store";
import { listEnabledBusinessIds } from "../feature-flags";
import { NATIVE_AD_ENGINE_VERSION } from "../types";
import {
  AD_CALIBRATION_JOB_NAME,
  inspectNativeAdCalibrationSchemaCapability,
  runAdCalibrationJob,
  type AdCalibrationJobInput,
  type AdCalibrationJobResult,
} from "./ad-calibration-job";
import {
  AD_DECISIONS_JOB_NAME,
  runAdDecisionsJob,
  type AdDecisionsJobInput,
  type AdDecisionsJobResult,
} from "./ad-decisions-job";
import {
  AD_OPERATOR_RESPONSE_JOB_NAME,
  inspectAdOperatorResponseSchemaCapability,
  runAdOperatorResponseJob,
  type AdOperatorResponseJobInput,
  type AdOperatorResponseJobResult,
} from "./ad-operator-response-job";
import { engineV3JobsDisabled } from "./job-switch";

export const NATIVE_AD_SHADOW_DAILY_UTC_START_HOUR = 3;

const NATIVE_AD_SHADOW_JOB_NAMES = [
  AD_CALIBRATION_JOB_NAME,
  AD_DECISIONS_JOB_NAME,
  AD_OPERATOR_RESPONSE_JOB_NAME,
] as const;

type NativeAdShadowJobName = (typeof NATIVE_AD_SHADOW_JOB_NAMES)[number];

export interface NativeAdShadowSchemaReadiness {
  ready: boolean;
  components: {
    calibration: { ready: boolean; issues: string[] };
    decisions: { ready: boolean; issues: string[] };
    operatorResponse: { ready: boolean; issues: string[] };
  };
  issues: string[];
}

export interface NativeAdScheduledStep<TResult> {
  status:
    | "success"
    | "failed"
    | "skipped"
    | "previous_success"
    | "dependency_blocked";
  source: "ran" | "previous_success" | "dependency_blocked";
  result: TResult | null;
  reason: string | null;
  errorMessage: string | null;
}

export interface NativeAdShadowBusinessResult {
  businessId: string;
  businessName: string | null;
  calibration: NativeAdScheduledStep<AdCalibrationJobResult>;
  decisions: NativeAdScheduledStep<AdDecisionsJobResult>;
  operatorResponse: NativeAdScheduledStep<AdOperatorResponseJobResult>;
}

export interface NativeAdShadowChainDueResult {
  skipped: boolean;
  asOf: string;
  engineVersion: typeof NATIVE_AD_ENGINE_VERSION;
  reason?:
    | "jobs_disabled"
    | "outside_slot"
    | "schema_not_ready"
    | "already_ran"
    | "no_enabled_businesses"
    | "no_meta_businesses";
  missingSchema?: string[];
  results?: NativeAdShadowBusinessResult[];
}

interface ScheduledBusiness {
  id: string;
  name: string | null;
}

interface SuccessfulJobRow extends Record<string, unknown> {
  id: unknown;
  business_ref_id: unknown;
  job_name: unknown;
  status: unknown;
  dependency_run_id: unknown;
  started_at: unknown;
  finished_at: unknown;
  row_count: unknown;
  error_json: unknown;
}

interface CurrentHydrationReceiptRow extends Record<string, unknown> {
  expected_ad_ids: unknown;
}

interface CalibrationReuseReceiptRow extends Record<string, unknown> {
  reusable: unknown;
}

interface MetaEligibleBusinessRow extends Record<string, unknown> {
  business_id: unknown;
}

export const READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL = `
WITH latest_target_history AS (
  SELECT history.recorded_at
  FROM business_target_pack_history history
  WHERE history.business_id = $1::uuid
    AND history.effective_at <= $3::timestamptz
    AND history.recorded_at <= $3::timestamptz
  ORDER BY history.effective_at DESC, history.recorded_at DESC, history.id DESC
  LIMIT 1
), latest_successful_calibration AS (
  SELECT run.error_json
  FROM engine_v3_job_runs run
  WHERE run.business_ref_id = $1::uuid
    AND run.business_id = $1::text
    AND run.as_of_date = $2::date
    AND run.engine_version = $4
    AND run.job_name = $5
    AND run.status = 'success'
    AND run.finished_at <= $3::timestamptz
  ORDER BY run.finished_at DESC NULLS LAST, run.started_at DESC, run.id DESC
  LIMIT 1
), receipt_batches AS (
  SELECT
    receipt.value->>'batch_id' AS batch_id,
    receipt.value->>'provider_account_ref_id' AS provider_account_ref_id,
    receipt.value->>'provider_account_id' AS provider_account_id
  FROM latest_successful_calibration run
  CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(
    CASE
      WHEN JSONB_TYPEOF(run.error_json #> '{metadata,batches}') = 'array'
        THEN run.error_json #> '{metadata,batches}'
      ELSE '[]'::jsonb
    END
  ) receipt(value)
), calibration_receipt AS (
  SELECT COUNT(*)::integer AS batch_count
  FROM receipt_batches
), calibration_batches AS (
  SELECT
    MIN(batch.as_of_cutoff) AS earliest_batch_cutoff,
    COUNT(*)::integer AS batch_count,
    COALESCE(
      JSONB_AGG(
        DISTINCT JSONB_BUILD_ARRAY(
          batch.provider_account_ref_id::text,
          batch.provider_account_id
        )
        ORDER BY JSONB_BUILD_ARRAY(
          batch.provider_account_ref_id::text,
          batch.provider_account_id
        )
      ),
      '[]'::jsonb
    ) AS account_identities
  FROM engine_v3_ad_account_calibration_batches batch
  JOIN receipt_batches receipt
    ON receipt.batch_id = batch.id::text
   AND receipt.provider_account_ref_id = batch.provider_account_ref_id::text
   AND receipt.provider_account_id = batch.provider_account_id
  WHERE batch.business_ref_id = $1::uuid
    AND batch.business_id = $1::text
    AND batch.as_of_date = $2::date
    AND batch.engine_version = $4
    AND batch.completeness_status = 'complete'
), assigned_accounts AS (
  SELECT COALESCE(
    JSONB_AGG(
      DISTINCT JSONB_BUILD_ARRAY(
        binding.provider_account_ref_id::text,
        binding.provider_account_id
      )
      ORDER BY JSONB_BUILD_ARRAY(
        binding.provider_account_ref_id::text,
        binding.provider_account_id
      )
    ),
    '[]'::jsonb
  ) AS account_identities
  FROM business_provider_accounts binding
  WHERE binding.business_id = $1::text
    AND binding.provider = 'meta'
    -- Current selection: the scheduled job compares against the accounts it is
    -- supposed to be calibrating NOW, not every account ever bound.
    AND binding.is_selected
)
SELECT CASE
  WHEN calibration_receipt.batch_count <> calibration_batches.batch_count THEN FALSE
  WHEN calibration_batches.account_identities IS DISTINCT FROM assigned_accounts.account_identities THEN FALSE
  WHEN calibration_batches.earliest_batch_cutoff IS NULL THEN FALSE
  WHEN NOT EXISTS (SELECT 1 FROM latest_target_history) THEN TRUE
  ELSE (
    SELECT recorded_at <= calibration_batches.earliest_batch_cutoff
    FROM latest_target_history
  )
END AS reusable
FROM calibration_batches
CROSS JOIN calibration_receipt
CROSS JOIN assigned_accounts
`;

export interface NativeAdShadowScheduleOptions {
  jobsDisabled?: () => boolean;
  inspectSchema?: () => Promise<NativeAdShadowSchemaReadiness>;
  listEnabledIds?: () => Promise<readonly string[]>;
  listActiveBusinesses?: () => Promise<readonly ScheduledBusiness[]>;
  listMetaEligibleIds?: (
    businessIds: readonly string[],
  ) => Promise<readonly string[]>;
  readSuccessfulJobs?: (input: {
    businessIds: readonly string[];
    asOf: string;
    decisionCutoff: string;
  }) => Promise<Map<string, Set<NativeAdShadowJobName>>>;
  hasSuccessfulJob?: (input: {
    businessId: string;
    asOf: string;
    jobName: NativeAdShadowJobName;
    decisionCutoff: string;
  }) => Promise<boolean>;
  runCalibration?: (
    input: AdCalibrationJobInput,
  ) => Promise<AdCalibrationJobResult>;
  runDecisions?: (input: AdDecisionsJobInput) => Promise<AdDecisionsJobResult>;
  runOperatorResponse?: (
    input: AdOperatorResponseJobInput,
  ) => Promise<AdOperatorResponseJobResult>;
}

function capabilityIssues(capability: {
  missing?: readonly string[];
  mismatched?: readonly string[];
}) {
  return [...(capability.missing ?? []), ...(capability.mismatched ?? [])];
}

export async function inspectNativeAdShadowSchemaReadiness(): Promise<NativeAdShadowSchemaReadiness> {
  const calibration = await inspectNativeAdCalibrationSchemaCapability().catch(
    (error) => ({
      ready: false,
      missing: [
        `inspection_failed:${error instanceof Error ? error.message : String(error)}`,
      ],
      mismatched: [],
    }),
  );
  const decisions = await inspectEvaluationStoreSchemaCapability().catch(
    (error) => ({
      ready: false,
      missing: [
        `inspection_failed:${error instanceof Error ? error.message : String(error)}`,
      ],
    }),
  );
  const operatorResponse =
    await inspectAdOperatorResponseSchemaCapability().catch((error) => ({
      ready: false,
      missing: [
        `inspection_failed:${error instanceof Error ? error.message : String(error)}`,
      ],
    }));
  const components = {
    calibration: {
      ready: calibration.ready,
      issues: capabilityIssues(calibration),
    },
    decisions: {
      ready: decisions.ready,
      issues: capabilityIssues(decisions),
    },
    operatorResponse: {
      ready: operatorResponse.ready,
      issues: capabilityIssues(operatorResponse),
    },
  };
  const issues = Object.entries(components).flatMap(([component, value]) =>
    value.issues.map((issue) => `${component}:${issue}`),
  );
  return {
    ready: Object.values(components).every((component) => component.ready),
    components,
    issues,
  };
}

async function defaultListActiveBusinesses(): Promise<ScheduledBusiness[]> {
  return (await getActiveBusinesses()).map((business) => ({
    id: business.id,
    name: business.name,
  }));
}

export async function listNativeAdMetaEligibleBusinessIds(
  businessIds: readonly string[],
  db: DbClient = getDb(),
): Promise<string[]> {
  const normalized = Array.from(
    new Set(businessIds.map((businessId) => businessId.trim()).filter(Boolean)),
  );
  if (normalized.length === 0) return [];
  const rows = await db.query<MetaEligibleBusinessRow>(
    `
    SELECT DISTINCT binding.business_id
    FROM business_provider_accounts binding
    WHERE binding.provider = 'meta'
      AND binding.business_id = ANY($1::text[])
      -- A business whose every Meta account is deselected is not eligible.
      AND binding.is_selected
    ORDER BY binding.business_id
    `,
    [normalized],
  );
  return rows.flatMap((row) => {
    const businessId = String(row.business_id ?? "").trim();
    return businessId ? [businessId] : [];
  });
}

export async function readSuccessfulNativeJobs(
  input: {
    businessIds: readonly string[];
    asOf: string;
    decisionCutoff: string;
  },
  db: DbClient = getDb(),
) {
  if (input.businessIds.length === 0) {
    return new Map<string, Set<NativeAdShadowJobName>>();
  }
  const rows = await db.query<SuccessfulJobRow>(
    `
    WITH candidate_runs AS (
      SELECT *
      FROM engine_v3_job_runs
      WHERE business_ref_id::text = ANY($1::text[])
        AND as_of_date = $2::date
        AND engine_version = $3
        AND job_name = ANY($4::text[])
        AND started_at <= $5::timestamptz
    ), effective_runs AS (
      SELECT
        run.*,
        CASE
          WHEN run.status <> 'running'
            AND (run.finished_at IS NULL OR run.finished_at > $5::timestamptz)
          THEN 'running'
          ELSE run.status
        END AS effective_status
      FROM candidate_runs run
      WHERE NOT (
        run.status = 'skipped'
        AND COALESCE(run.error_message, '') ILIKE 'Advisory lock not acquired%'
        AND EXISTS (
          SELECT 1
          FROM candidate_runs holder
          WHERE holder.business_ref_id = run.business_ref_id
            AND holder.job_name = run.job_name
            AND holder.id <> run.id
            AND holder.status IN ('success', 'failed')
            AND holder.started_at <= COALESCE(run.finished_at, run.started_at)
            AND holder.finished_at >= run.started_at
            AND holder.finished_at <= $5::timestamptz
        )
      )
    )
    SELECT DISTINCT ON (business_ref_id, job_name)
      id::text AS id,
      business_ref_id::text AS business_ref_id,
      job_name,
      effective_status AS status,
      dependency_run_id::text AS dependency_run_id,
      started_at,
      finished_at,
      row_count,
      error_json
    FROM effective_runs
    ORDER BY business_ref_id, job_name, started_at DESC, id DESC
    `,
    [
      input.businessIds,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      NATIVE_AD_SHADOW_JOB_NAMES,
      input.decisionCutoff,
    ],
  );
  const result = new Map<string, Set<NativeAdShadowJobName>>();
  const rowsByBusiness = new Map<
    string,
    Map<NativeAdShadowJobName, SuccessfulJobRow>
  >();
  for (const row of rows) {
    const businessId = String(row.business_ref_id ?? "");
    const jobName = String(row.job_name ?? "") as NativeAdShadowJobName;
    if (!businessId || !NATIVE_AD_SHADOW_JOB_NAMES.includes(jobName)) continue;
    const businessRows = rowsByBusiness.get(businessId) ?? new Map();
    businessRows.set(jobName, row);
    rowsByBusiness.set(businessId, businessRows);
  }

  for (const [businessId, businessRows] of rowsByBusiness) {
    const jobs = new Set<NativeAdShadowJobName>();
    const calibration = businessRows.get(AD_CALIBRATION_JOB_NAME);
    const calibrationId = jobRunId(calibration);
    if (
      calibration?.status !== "success" ||
      calibrationId === null ||
      !(await hasReusableNativeCalibration(
        {
          businessId,
          asOf: input.asOf,
          decisionCutoff: input.decisionCutoff,
        },
        db,
      ))
    ) {
      result.set(businessId, jobs);
      continue;
    }
    jobs.add(AD_CALIBRATION_JOB_NAME);

    const decisions = businessRows.get(AD_DECISIONS_JOB_NAME);
    if (
      decisions?.status !== "success" ||
      jobRunId(decisions) === null ||
      String(decisions.dependency_run_id ?? "") !== calibrationId ||
      !hasAuthoritativeDecisionHydrationReceipts(decisions.error_json)
    ) {
      result.set(businessId, jobs);
      continue;
    }
    if (
      isZeroRowNativeDecisionSuccess(decisions.row_count) &&
      (await hasCurrentNonEmptyAdManifest(
        {
          businessId,
          asOf: input.asOf,
          decisionCutoff: input.decisionCutoff,
        },
        db,
      ))
    ) {
      result.set(businessId, jobs);
      continue;
    }
    jobs.add(AD_DECISIONS_JOB_NAME);

    const operatorResponse = businessRows.get(AD_OPERATOR_RESPONSE_JOB_NAME);
    if (
      operatorResponse?.status !== "success" ||
      jobRunId(operatorResponse) === null ||
      !ranAfterDependency(operatorResponse, decisions)
    ) {
      result.set(businessId, jobs);
      continue;
    }
    jobs.add(AD_OPERATOR_RESPONSE_JOB_NAME);
    result.set(businessId, jobs);
  }
  return closeNativeJobDependencies(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * A successful process exit is not a reusable native decision generation.
 * Every selected Meta account must also carry a complete, authoritative
 * hydration receipt. Otherwise a pre-sync 03:00 run can permanently suppress
 * the later same-day rerun that finally has the complete Ad manifest.
 */
export function hasAuthoritativeDecisionHydrationReceipts(
  errorJson: unknown,
): boolean {
  if (!isRecord(errorJson) || !isRecord(errorJson.metadata)) return false;
  const receipts = errorJson.metadata.hydration_receipts;
  if (!Array.isArray(receipts) || receipts.length === 0) return false;
  return receipts.every((receipt) => {
    if (!isRecord(receipt)) return false;
    const expected = exactNonNegativeInteger(receipt.expected_ad_count);
    const hydrated = exactNonNegativeInteger(receipt.hydrated_ad_count);
    const expectedHash = String(receipt.expected_manifest_hash ?? "");
    const hydratedHash = String(receipt.hydrated_manifest_hash ?? "");
    return Boolean(
      String(receipt.provider_account_ref_id ?? "").trim() &&
        String(receipt.provider_account_id ?? "").trim() &&
        expected !== null &&
        hydrated === expected &&
        /^[a-f0-9]{64}$/.test(expectedHash) &&
        hydratedHash === expectedHash &&
        (receipt.source_complete === true || receipt.source_complete === "true") &&
        (receipt.hydration_complete === true || receipt.hydration_complete === "true") &&
        (receipt.authoritative_for_prune === true ||
          receipt.authoritative_for_prune === "true") &&
        (receipt.reason === null || receipt.reason === undefined)
    );
  });
}

export async function hasReusableNativeCalibration(
  input: { businessId: string; asOf: string; decisionCutoff: string },
  db = getDb(),
) {
  const [row] = await db.query<CalibrationReuseReceiptRow>(
    READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL,
    [
      input.businessId,
      input.asOf,
      input.decisionCutoff,
      NATIVE_AD_ENGINE_VERSION,
      AD_CALIBRATION_JOB_NAME,
    ],
  );
  return row?.reusable === true;
}

async function hasSuccessfulNativeJob(input: {
  businessId: string;
  asOf: string;
  jobName: NativeAdShadowJobName;
  decisionCutoff: string;
}) {
  const jobs = await readSuccessfulNativeJobs({
    businessIds: [input.businessId],
    asOf: input.asOf,
    decisionCutoff: input.decisionCutoff,
  });
  return jobs.get(input.businessId)?.has(input.jobName) === true;
}

function exactNonNegativeInteger(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isZeroRowNativeDecisionSuccess(rowCount: unknown) {
  return exactNonNegativeInteger(rowCount) === 0;
}

async function hasCurrentNonEmptyAdManifest(
  input: {
    businessId: string;
    asOf: string;
    decisionCutoff: string;
  },
  db: DbClient = getDb(),
) {
  const rows = await db.query<CurrentHydrationReceiptRow>(
    READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
    [input.businessId, input.asOf, input.decisionCutoff, [], false],
  );
  return rows.some(
    (row) =>
      Array.isArray(row.expected_ad_ids) && row.expected_ad_ids.length > 0,
  );
}

function jobRunId(row: SuccessfulJobRow | undefined) {
  const value = String(row?.id ?? "").trim();
  return value || null;
}

function timestampMs(value: unknown) {
  const parsed =
    value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function ranAfterDependency(
  downstream: SuccessfulJobRow,
  upstream: SuccessfulJobRow,
) {
  const downstreamStartedAt = timestampMs(downstream.started_at);
  const upstreamFinishedAt = timestampMs(upstream.finished_at);
  return (
    downstreamStartedAt !== null &&
    upstreamFinishedAt !== null &&
    downstreamStartedAt >= upstreamFinishedAt
  );
}

function closeNativeJobDependencies(
  source: Map<string, Set<NativeAdShadowJobName>>,
) {
  const result = new Map<string, Set<NativeAdShadowJobName>>();
  for (const [businessId, sourceJobs] of source) {
    const jobs = new Set(sourceJobs);
    if (!jobs.has(AD_CALIBRATION_JOB_NAME)) {
      jobs.delete(AD_DECISIONS_JOB_NAME);
      jobs.delete(AD_OPERATOR_RESPONSE_JOB_NAME);
    }
    if (!jobs.has(AD_DECISIONS_JOB_NAME)) {
      jobs.delete(AD_OPERATOR_RESPONSE_JOB_NAME);
    }
    result.set(businessId, jobs);
  }
  return result;
}

function previousSuccessStep<TResult>(): NativeAdScheduledStep<TResult> {
  return {
    status: "previous_success",
    source: "previous_success",
    result: null,
    reason: null,
    errorMessage: null,
  };
}

function dependencyBlockedStep<TResult>(
  reason: string,
): NativeAdScheduledStep<TResult> {
  return {
    status: "dependency_blocked",
    source: "dependency_blocked",
    result: null,
    reason,
    errorMessage: reason,
  };
}

function ranStep<
  TResult extends {
    status: "success" | "failed" | "skipped";
    reason?: string;
    errorMessage?: string;
  },
>(result: TResult): NativeAdScheduledStep<TResult> {
  return {
    status: result.status,
    source: "ran",
    result,
    reason: result.reason ?? null,
    errorMessage: result.errorMessage ?? null,
  };
}

function failedStep<TResult>(error: unknown): NativeAdScheduledStep<TResult> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "failed",
    source: "ran",
    result: null,
    reason: "uncaught_error",
    errorMessage: message,
  };
}

async function dependencySatisfied(input: {
  step: NativeAdScheduledStep<unknown>;
  businessId: string;
  asOf: string;
  decisionCutoff: string;
  jobName: NativeAdShadowJobName;
  hasSuccessfulJob: NonNullable<
    NativeAdShadowScheduleOptions["hasSuccessfulJob"]
  >;
}) {
  if (
    input.step.status === "success" ||
    input.step.status === "previous_success"
  ) {
    return true;
  }
  return input.hasSuccessfulJob({
    businessId: input.businessId,
    asOf: input.asOf,
    jobName: input.jobName,
    decisionCutoff: input.decisionCutoff,
  });
}

async function runBusinessChain(input: {
  business: ScheduledBusiness;
  asOf: string;
  cutoff: string;
  previousSuccesses: Set<NativeAdShadowJobName>;
  options: NativeAdShadowScheduleOptions;
}): Promise<NativeAdShadowBusinessResult> {
  const hasSuccessfulJob =
    input.options.hasSuccessfulJob ?? hasSuccessfulNativeJob;
  const calibration = input.previousSuccesses.has(AD_CALIBRATION_JOB_NAME)
    ? previousSuccessStep<AdCalibrationJobResult>()
    : await (input.options.runCalibration ?? runAdCalibrationJob)({
        businessId: input.business.id,
        asOf: input.asOf,
      }).then(
        ranStep<AdCalibrationJobResult>,
        failedStep<AdCalibrationJobResult>,
      );

  const calibrationSatisfied = await dependencySatisfied({
    step: calibration,
    businessId: input.business.id,
    asOf: input.asOf,
    decisionCutoff: input.cutoff,
    jobName: AD_CALIBRATION_JOB_NAME,
    hasSuccessfulJob,
  });
  const decisions = !calibrationSatisfied
    ? dependencyBlockedStep<AdDecisionsJobResult>(
        "upstream_native_calibration_not_success",
      )
    : input.previousSuccesses.has(AD_DECISIONS_JOB_NAME)
      ? previousSuccessStep<AdDecisionsJobResult>()
      : await (input.options.runDecisions ?? runAdDecisionsJob)({
          businessId: input.business.id,
          asOf: input.asOf,
        }).then(
          ranStep<AdDecisionsJobResult>,
          failedStep<AdDecisionsJobResult>,
        );

  const decisionsSatisfied = await dependencySatisfied({
    step: decisions,
    businessId: input.business.id,
    asOf: input.asOf,
    decisionCutoff: input.cutoff,
    jobName: AD_DECISIONS_JOB_NAME,
    hasSuccessfulJob,
  });
  const operatorResponse = !decisionsSatisfied
    ? dependencyBlockedStep<AdOperatorResponseJobResult>(
        "upstream_native_decisions_not_success",
      )
    : input.previousSuccesses.has(AD_OPERATOR_RESPONSE_JOB_NAME)
      ? previousSuccessStep<AdOperatorResponseJobResult>()
      : await (input.options.runOperatorResponse ?? runAdOperatorResponseJob)({
          businessId: input.business.id,
          cutoff: input.cutoff,
          engineVersion: NATIVE_AD_ENGINE_VERSION,
        }).then(
          ranStep<AdOperatorResponseJobResult>,
          failedStep<AdOperatorResponseJobResult>,
        );

  return {
    businessId: input.business.id,
    businessName: input.business.name,
    calibration,
    decisions,
    operatorResponse,
  };
}

export async function runNativeAdShadowChainForActiveBusinessesIfDue(
  now = new Date(),
  activeBusinesses?: readonly ScheduledBusiness[],
  options: NativeAdShadowScheduleOptions = {},
): Promise<NativeAdShadowChainDueResult> {
  const asOf = now.toISOString().slice(0, 10);
  const base = { asOf, engineVersion: NATIVE_AD_ENGINE_VERSION } as const;
  if ((options.jobsDisabled ?? engineV3JobsDisabled)()) {
    return { ...base, skipped: true, reason: "jobs_disabled" };
  }
  if (now.getUTCHours() < NATIVE_AD_SHADOW_DAILY_UTC_START_HOUR) {
    return { ...base, skipped: true, reason: "outside_slot" };
  }

  const schema = await (
    options.inspectSchema ?? inspectNativeAdShadowSchemaReadiness
  )();
  if (!schema.ready) {
    return {
      ...base,
      skipped: true,
      reason: "schema_not_ready",
      missingSchema: schema.issues,
    };
  }

  const [active, enabledIds] = await Promise.all([
    activeBusinesses ??
      (options.listActiveBusinesses ?? defaultListActiveBusinesses)(),
    (options.listEnabledIds ?? listEnabledBusinessIds)(),
  ]);
  const enabled = new Set(enabledIds);
  const enabledBusinesses = active.filter((business) =>
    enabled.has(business.id),
  );
  if (enabledBusinesses.length === 0) {
    return { ...base, skipped: true, reason: "no_enabled_businesses" };
  }
  const metaEligible = new Set(
    await (options.listMetaEligibleIds ?? listNativeAdMetaEligibleBusinessIds)(
      enabledBusinesses.map((business) => business.id),
    ),
  );
  const businesses = enabledBusinesses.filter((business) =>
    metaEligible.has(business.id),
  );
  if (businesses.length === 0) {
    return { ...base, skipped: true, reason: "no_meta_businesses" };
  }

  const successes = closeNativeJobDependencies(
    await (options.readSuccessfulJobs ?? readSuccessfulNativeJobs)({
      businessIds: businesses.map((business) => business.id),
      asOf,
      decisionCutoff: now.toISOString(),
    }),
  );
  const allComplete = businesses.every((business) => {
    const jobs = successes.get(business.id);
    return NATIVE_AD_SHADOW_JOB_NAMES.every((jobName) => jobs?.has(jobName));
  });
  if (allComplete) {
    return { ...base, skipped: true, reason: "already_ran" };
  }

  const results: NativeAdShadowBusinessResult[] = [];
  for (const business of businesses) {
    results.push(
      await runBusinessChain({
        business,
        asOf,
        cutoff: now.toISOString(),
        previousSuccesses:
          successes.get(business.id) ?? new Set<NativeAdShadowJobName>(),
        options,
      }),
    );
  }
  return { ...base, skipped: false, results };
}
