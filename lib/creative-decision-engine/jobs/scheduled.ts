import { getDb, runDbTransaction } from "@/lib/db";
import { readCompletedCreativeProducerScopes } from "./creative-producer-completion";
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
  asOf: string;
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
    | "no_verified_closed_day"
    | "already_ran"
    | "no_enabled_businesses";
  asOf: string;
  results?: EngineV3ProducerBusinessResult[];
}

function previousClosedProviderDay(now: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    const localDay = `${part("year")}-${part("month")}-${part("day")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDay)) return null;
    return new Date(Date.parse(`${localDay}T00:00:00.000Z`) - 86_400_000)
      .toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

async function providerClosedDaysForBusinesses(
  now: Date,
  businesses: readonly EnabledBusiness[],
): Promise<Array<EnabledBusiness & { asOf: string }>> {
  if (businesses.length === 0) return [];
  const rows = await getDb().query<{
    business_id: unknown; provider_account_id: unknown; timezone: unknown;
    latest_published_day: unknown;
  }>(`
    SELECT bpa.business_id, bpa.provider_account_id, pa.timezone,
      published.day::text AS latest_published_day
    FROM business_provider_accounts bpa
    LEFT JOIN provider_accounts pa ON pa.id = bpa.provider_account_ref_id
    LEFT JOIN LATERAL (
      SELECT pointer.day
      FROM meta_authoritative_publication_pointers pointer
      JOIN meta_authoritative_slice_versions slice ON slice.id = pointer.active_slice_version_id
      JOIN meta_authoritative_source_manifests manifest ON manifest.id = slice.manifest_id
      WHERE pointer.business_id = bpa.business_id
        AND pointer.provider_account_id = bpa.provider_account_id
        AND pointer.surface = 'ad_daily'
        AND pointer.day >= ($2::date - INTERVAL '90 days')
        AND slice.business_id = pointer.business_id
        AND slice.provider_account_id = pointer.provider_account_id
        AND slice.day = pointer.day AND slice.surface = pointer.surface
        AND slice.source_run_id = pointer.published_by_run_id
        AND slice.state = 'finalized_verified' AND slice.truth_state = 'finalized'
        AND slice.validation_status = 'passed' AND slice.status = 'published'
        AND manifest.business_id = pointer.business_id
        AND manifest.provider_account_id = pointer.provider_account_id
        AND manifest.day = pointer.day AND manifest.run_id = slice.source_run_id
        AND manifest.fetch_status = 'completed'
        AND manifest.account_timezone = pa.timezone
        AND EXISTS (SELECT 1 FROM pg_timezone_names tz WHERE tz.name = pa.timezone)
        AND manifest.completed_at >= ((pointer.day + 1)::timestamp AT TIME ZONE pa.timezone)
        AND manifest.created_at <= $3::timestamptz
        AND manifest.updated_at <= $3::timestamptz
        AND manifest.completed_at <= $3::timestamptz
        AND slice.created_at <= $3::timestamptz
        AND slice.updated_at <= $3::timestamptz
        AND slice.published_at IS NOT NULL AND slice.published_at <= $3::timestamptz
        AND pointer.created_at <= $3::timestamptz
        AND pointer.updated_at <= $3::timestamptz
        AND pointer.published_at <= $3::timestamptz
        AND manifest.completed_at <= slice.published_at
        AND slice.published_at <= pointer.published_at
        AND slice.staged_row_count IS NOT NULL
        AND slice.staged_row_count = (
          SELECT COUNT(*) FROM meta_ad_daily source_ad
          WHERE source_ad.business_id = pointer.business_id
            AND source_ad.provider_account_id = pointer.provider_account_id
            AND source_ad.date = pointer.day
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta_ad_daily invalid_ad
          WHERE invalid_ad.business_id = pointer.business_id
            AND invalid_ad.provider_account_id = pointer.provider_account_id
            AND invalid_ad.date = pointer.day
            AND NOT (invalid_ad.source_run_id = pointer.published_by_run_id
              AND invalid_ad.truth_state = 'finalized'
              AND invalid_ad.validation_status = 'passed'
              AND invalid_ad.finalized_at IS NOT NULL
              AND invalid_ad.finalized_at <= $3::timestamptz
              AND invalid_ad.created_at <= $3::timestamptz
              AND invalid_ad.updated_at <= $3::timestamptz)
        )
      ORDER BY pointer.day DESC LIMIT 1
    ) published ON TRUE
    WHERE bpa.business_id = ANY($1::text[])
      AND bpa.provider = 'meta' AND bpa.is_selected
    ORDER BY bpa.business_id, bpa.provider_account_id
  `, [businesses.map((business) => business.id), now.toISOString().slice(0, 10), now.toISOString()]);
  const byBusiness = new Map<string, Array<string | null>>();
  for (const row of rows) {
    if (typeof row.business_id !== "string") continue;
    const timezone = typeof row.timezone === "string" ? row.timezone.trim() : "";
    const latestPublishedDay = typeof row.latest_published_day === "string"
      ? row.latest_published_day : null;
    const previousClosedDay = typeof row.provider_account_id === "string" && row.provider_account_id.trim()
      ? previousClosedProviderDay(now, timezone) : null;
    const day = latestPublishedDay && previousClosedDay
      ? [latestPublishedDay, previousClosedDay].sort()[0]! : null;
    const dates = byBusiness.get(row.business_id) ?? [];
    dates.push(day);
    byBusiness.set(row.business_id, dates);
  }
  return businesses.flatMap((business) => {
    const dates = byBusiness.get(business.id);
    if (!dates?.length || dates.some((date) => date === null)) return [];
    return [{ ...business, asOf: (dates as string[]).sort()[0]! }];
  });
}

function isProducerCatchUpSlot(now: Date) {
  return now.getUTCHours() >= ENGINE_V3_PRODUCER_DAILY_UTC_START_HOUR;
}

async function listEnabledBusinesses(): Promise<EnabledBusiness[]> {
  return (await listEnabledBusinessIds()).map((id) => ({ id, name: null }));
}

async function findBusinessesPendingDecisions(input: {
  businesses: ReadonlyArray<EnabledBusiness & { asOf: string }>;
}) {
  if (input.businesses.length === 0) return [];

  // All per-business proofs share the original statement's MVCC view. A late
  // certificate/publication visible after this snapshot is retried next tick.
  const rows = await runDbTransaction(async () => {
    await getDb().query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return readCompletedCreativeProducerScopes(getDb(), input.businesses, ENGINE_VERSION);
  });
  const completed = new Set(
    rows
      .map((row) =>
        typeof row.business_ref_id === "string" && typeof row.as_of_date === "string"
          ? `${row.business_ref_id}:${row.as_of_date}` : null,
      )
      .filter((value): value is string => value !== null),
  );
  return input.businesses.filter((business) => !completed.has(`${business.id}:${business.asOf}`));
}

async function hasSuccessfulProducerJobRun(input: {
  businessId: string;
  asOf: string;
  jobName: string;
  evaluationCutoffAt: string;
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
        AND error_json#>>'{metadata,evaluation_cutoff_at}' = $5::text
    ) AS exists
    `,
    [input.businessId, input.asOf, ENGINE_VERSION, input.jobName,
      input.evaluationCutoffAt],
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
  evaluationCutoffAt: string;
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
    evaluationCutoffAt: input.evaluationCutoffAt,
  }).catch(failedCalibrationResult);

  const calibrationSatisfied =
    calibration.status === "success" ||
    (await hasSuccessfulProducerJobRun({
      businessId: input.business.id,
      asOf: input.asOf,
      jobName: CALIBRATION_JOB_NAME,
      evaluationCutoffAt: input.evaluationCutoffAt,
    }));

  if (!calibrationSatisfied) {
    return {
      businessId: input.business.id,
      asOf: input.asOf,
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
    evaluationCutoffAt: input.evaluationCutoffAt,
  }).catch(failedLifecycleResult);

  const lifecycleSatisfied =
    lifecycle.status === "success" ||
    (await hasSuccessfulProducerJobRun({
      businessId: input.business.id,
      asOf: input.asOf,
      jobName: LIFECYCLE_JOB_NAME,
      evaluationCutoffAt: input.evaluationCutoffAt,
    }));

  if (!lifecycleSatisfied) {
    return {
      businessId: input.business.id,
      asOf: input.asOf,
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
    evaluationCutoffAt: input.evaluationCutoffAt,
  }).catch(failedDecisionsResult);

  return {
    businessId: input.business.id,
    asOf: input.asOf,
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
  const asOf = now.toISOString().slice(0, 10);
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

  const closedDayBusinesses = await providerClosedDaysForBusinesses(now, enabledBusinesses);
  const servedAsOf = closedDayBusinesses.map((business) => business.asOf).sort()[0] ?? asOf;
  if (closedDayBusinesses.length === 0) {
    return { skipped: true, reason: "no_verified_closed_day", asOf: servedAsOf };
  }
  const pendingBusinesses = await findBusinessesPendingDecisions({ businesses: closedDayBusinesses });
  if (pendingBusinesses.length === 0) {
    return { skipped: true, reason: "already_ran", asOf: servedAsOf };
  }

  const results: EngineV3ProducerBusinessResult[] = [];
  // Operator-response scheduling is deferred until measurement repair gives it a consumer.
  // Keeping producer concurrency at one avoids adding pool pressure to provider sync ticks.
  for (const business of pendingBusinesses) {
    results.push(await runProducerChainForBusiness({
      business, asOf: business.asOf, evaluationCutoffAt: now.toISOString(),
    }));
  }

  return { skipped: false, asOf: servedAsOf, results };
}
