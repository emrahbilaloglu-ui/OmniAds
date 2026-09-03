import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { listEnabledBusinessIds } from "../feature-flags";
import { ENGINE_VERSION } from "../types";
import {
  JOB_NAME as CALIBRATION_JOB_NAME,
  runCalibrationJob,
  type CalibrationJobResult,
} from "./calibration-job";
import {
  runCampaignContextJob,
  type CampaignContextJobResult,
} from "./campaign-context-job";
import {
  JOB_NAME as DECISIONS_JOB_NAME,
  runDecisionsJob,
  type DecisionsJobResult,
} from "./decisions-job";
import { engineV3JobsDisabled } from "./job-switch";
import {
  JOB_NAME as LIFECYCLE_JOB_NAME,
  runLifecycleJob,
  type LifecycleJobResult,
} from "./lifecycle-job";

export const ENGINE_V3_PRODUCER_DAILY_UTC_START_HOUR = 3;

interface EnabledBusiness {
  id: string;
  name: string | null;
}

export interface EngineV3ProducerBusinessResult {
  businessId: string;
  campaignContext?: CampaignContextJobResult;
  businessName: string | null;
  calibration: CalibrationJobResult;
  lifecycle: LifecycleJobResult;
  decisions: DecisionsJobResult;
}

export interface EngineV3ProducerChainDueResult {
  skipped: boolean;
  reason?:
    | "jobs_disabled"
    | "outside_slot"
    | "schema_not_ready"
    | "already_ran"
    | "no_enabled_businesses";
  asOf: string;
  results?: EngineV3ProducerBusinessResult[];
}

function producerAsOfFor(now: Date) {
  return now.toISOString().slice(0, 10);
}

function isProducerCatchUpSlot(now: Date) {
  return now.getUTCHours() >= ENGINE_V3_PRODUCER_DAILY_UTC_START_HOUR;
}

async function listEnabledBusinesses(): Promise<EnabledBusiness[]> {
  return (await listEnabledBusinessIds()).map((id) => ({ id, name: null }));
}

async function findBusinessesPendingDecisions(input: {
  asOf: string;
  businesses: readonly EnabledBusiness[];
}) {
  if (input.businesses.length === 0) return [];

  const rows = await getDb().query<{ business_ref_id: unknown }>(
    `
    WITH completed AS (
      SELECT
        business_ref_id,
        bool_or(job_name = 'engine_v3_calibration_job' AND status = 'success') AS calibration_success,
        bool_or(job_name = 'engine_v3_lifecycle_job' AND status = 'success') AS lifecycle_success,
        bool_or(job_name = $1 AND status = 'success') AS decisions_success
      FROM engine_v3_job_runs
      WHERE job_name IN (
          'engine_v3_calibration_job',
          'engine_v3_lifecycle_job',
          $1
        )
        AND as_of_date = $2::date
        AND engine_version = $3
      GROUP BY business_ref_id
    )
    SELECT business_ref_id
    FROM completed
    WHERE calibration_success = TRUE
      AND lifecycle_success = TRUE
      AND decisions_success = TRUE
    `,
    [DECISIONS_JOB_NAME, input.asOf, ENGINE_VERSION],
  );
  const completed = new Set(
    rows
      .map((row) =>
        typeof row.business_ref_id === "string" ? row.business_ref_id : null,
      )
      .filter((value): value is string => value !== null),
  );
  return input.businesses.filter((business) => !completed.has(business.id));
}

async function hasSuccessfulProducerJobRun(input: {
  businessId: string;
  asOf: string;
  jobName: string;
}) {
  const rows = await getDb().query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM engine_v3_job_runs
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND job_name = $4
        AND status = 'success'
    ) AS exists
    `,
    [input.businessId, input.asOf, ENGINE_VERSION, input.jobName],
  );
  return rows[0]?.exists === true;
}

function skippedLifecycleResult(input: {
  dependencyRunId: string | null;
  errorMessage: string;
}): LifecycleJobResult {
  return {
    jobRunId: "",
    dependencyRunId: input.dependencyRunId,
    status: "skipped",
    rowsWritten: 0,
    durationMs: 0,
    errorMessage: input.errorMessage,
  };
}

function skippedDecisionsResult(errorMessage: string): DecisionsJobResult {
  return {
    jobRunId: "",
    status: "skipped",
    snapshotsWritten: 0,
    changeEventsWritten: 0,
    durationMs: 0,
    errorMessage,
  };
}

async function runProducerChainForBusiness(input: {
  business: EnabledBusiness;
  asOf: string;
}): Promise<EngineV3ProducerBusinessResult> {
  // Campaign context (D033) runs first and is deliberately non-gating: a
  // context failure must not block calibration/lifecycle/decisions, because
  // consumption falls back to unresolved/conservative when context is
  // missing or stale.
  const campaignContext = await runCampaignContextJob({
    businessId: input.business.id,
    asOf: input.asOf,
  }).catch(
    (error): CampaignContextJobResult => ({
      jobRunId: "",
      status: "failed",
      rowsWritten: 0,
      durationMs: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
    }),
  );

  const calibration = await runCalibrationJob({
    businessId: input.business.id,
    asOf: input.asOf,
  }).catch(failedCalibrationResult);

  const calibrationSatisfied =
    calibration.status === "success" ||
    (await hasSuccessfulProducerJobRun({
      businessId: input.business.id,
      asOf: input.asOf,
      jobName: CALIBRATION_JOB_NAME,
    }));

  if (!calibrationSatisfied) {
    return {
      businessId: input.business.id,
      businessName: input.business.name,
      campaignContext,
      calibration,
      lifecycle: skippedLifecycleResult({
        dependencyRunId: calibration.jobRunId || null,
        errorMessage: "upstream_calibration_not_success",
      }),
      decisions: skippedDecisionsResult("upstream_calibration_not_success"),
    };
  }

  const lifecycle = await runLifecycleJob({
    businessId: input.business.id,
    asOf: input.asOf,
  }).catch(failedLifecycleResult);

  const lifecycleSatisfied =
    lifecycle.status === "success" ||
    (await hasSuccessfulProducerJobRun({
      businessId: input.business.id,
      asOf: input.asOf,
      jobName: LIFECYCLE_JOB_NAME,
    }));

  if (!lifecycleSatisfied) {
    return {
      businessId: input.business.id,
      businessName: input.business.name,
      campaignContext,
      calibration,
      lifecycle,
      decisions: skippedDecisionsResult("upstream_lifecycle_not_success"),
    };
  }

  const decisions = await runDecisionsJob({
    businessId: input.business.id,
    asOf: input.asOf,
  }).catch(failedDecisionsResult);

  return {
    businessId: input.business.id,
    businessName: input.business.name,
    campaignContext,
    calibration,
    lifecycle,
    decisions,
  };
}

function failedCalibrationResult(error: unknown): CalibrationJobResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    jobRunId: "",
    status: "failed",
    rowsWritten: 0,
    durationMs: 0,
    calibration: null,
    errorMessage: message,
  };
}

function failedLifecycleResult(error: unknown): LifecycleJobResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    jobRunId: "",
    dependencyRunId: null,
    status: "failed",
    rowsWritten: 0,
    durationMs: 0,
    errorMessage: message,
  };
}

function failedDecisionsResult(error: unknown): DecisionsJobResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    jobRunId: "",
    status: "failed",
    snapshotsWritten: 0,
    changeEventsWritten: 0,
    durationMs: 0,
    errorMessage: message,
  };
}

export async function runEngineV3ProducerChainForActiveBusinessesIfDue(
  now = new Date(),
  businesses?: readonly EnabledBusiness[],
): Promise<EngineV3ProducerChainDueResult> {
  const asOf = producerAsOfFor(now);
  if (engineV3JobsDisabled()) {
    return { skipped: true, reason: "jobs_disabled", asOf };
  }
  if (!isProducerCatchUpSlot(now)) {
    return { skipped: true, reason: "outside_slot", asOf };
  }

  const readiness = await getDbSchemaReadiness({
    tables: [
      "businesses",
      "business_engine_v3_flags",
      "business_target_packs",
      "engine_v3_account_calibration_daily",
      "engine_v3_creative_lifecycle_daily",
      "engine_v3_decision_snapshots_daily",
      "engine_v3_decision_events",
      "engine_v3_job_runs",
      "engine_v3_campaign_context_daily",
      "meta_creative_daily",
    ],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { skipped: true, reason: "schema_not_ready", asOf };
  }

  const enabledBusinesses = businesses ?? (await listEnabledBusinesses());
  if (enabledBusinesses.length === 0) {
    return { skipped: true, reason: "no_enabled_businesses", asOf };
  }

  const pendingBusinesses = await findBusinessesPendingDecisions({
    asOf,
    businesses: enabledBusinesses,
  });
  if (pendingBusinesses.length === 0) {
    return { skipped: true, reason: "already_ran", asOf };
  }

  const results: EngineV3ProducerBusinessResult[] = [];
  // Operator-response scheduling is deferred until measurement repair gives it a consumer.
  // Keeping producer concurrency at one avoids adding pool pressure to provider sync ticks.
  for (const business of pendingBusinesses) {
    results.push(await runProducerChainForBusiness({ business, asOf }));
  }

  return { skipped: false, asOf, results };
}
