import type { MetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-contract";
import type { MetaNativeCanonicalDecisionInventory } from "@/lib/meta/decisions-workspace-read-model";
import { evaluateDecisionOriginAdDecisionFreshness } from "@/lib/creative-decision-engine/execution-safety";
import { getDbWithTimeout } from "@/lib/db";
import {
  addDaysToIsoDateUtc,
  getTodayIsoForTimeZoneServer,
} from "@/lib/provider-platform-date";
import {
  evaluateDbGrowthFence,
  type DbGrowthFenceDecision,
} from "@/lib/sync/db-growth-fence";

export const META_DECISION_PIPELINE_HEALTH_CONTRACT_VERSION =
  "meta-decision-pipeline-health.v1" as const;

/**
 * A ten-minute cron is allowed five missed ticks before its absence becomes a
 * decision-execution blocker. The worker may still be alive during that time;
 * liveness is deliberately not accepted as evidence that new work was
 * admitted or completed.
 */
export const META_DECISION_SYNC_ACTIVITY_MAX_AGE_MINUTES = 60;

export type MetaDecisionPipelineDimensionStatus =
  | "fresh"
  | "warning"
  | "stale"
  | "blocked"
  | "invalid"
  | "missing"
  | "unavailable";

export type MetaDecisionPipelineBlocker =
  | "provider_account_required"
  | "pipeline_read_failed"
  | "sync_activity_missing"
  | "sync_activity_stale"
  | "sync_admission_blocked"
  | "warehouse_cutoff_missing"
  | "warehouse_cutoff_stale"
  | "account_timezone_unavailable"
  | "decision_generation_missing"
  | "decision_generation_stale"
  | "decision_manifest_invalid";

export interface MetaDecisionPipelineOperationalHealth {
  contractVersion: typeof META_DECISION_PIPELINE_HEALTH_CONTRACT_VERSION;
  evaluatedAt: string;
  overall: "healthy" | "degraded" | "blocked" | "unavailable";
  executionReady: boolean;
  blockers: MetaDecisionPipelineBlocker[];
  syncActivity: {
    status: MetaDecisionPipelineDimensionStatus;
    latestAt: string | null;
    ageMinutes: number | null;
    maxAgeMinutes: number;
    latestJobStatus: string | null;
    latestRunStatus: string | null;
    reason: string | null;
  };
  warehouse: {
    status: MetaDecisionPipelineDimensionStatus;
    latestFinalizedDate: string | null;
    expectedFinalizedDate: string | null;
    lagDays: number | null;
    accountTimeZone: string | null;
    reason: string | null;
  };
  admission: {
    status: MetaDecisionPipelineDimensionStatus;
    allowed: boolean;
    reason: string;
    offender: {
      table: string;
      bytes: number;
      budget: number;
      overByBytes: number;
    } | null;
    evaluatedAt: string;
  };
}

export interface MetaDecisionPipelineHealth
  extends MetaDecisionPipelineOperationalHealth {
  decisionGeneration: {
    status: MetaDecisionPipelineDimensionStatus;
    computedAt: string | null;
    ageHours: number | null;
    maxAgeHours: number;
    engineVersion: string | null;
    reason: string | null;
  };
  manifest: {
    status: MetaDecisionPipelineDimensionStatus;
    authority: string | null;
    jobRunId: string | null;
    manifestHash: string | null;
    expectedAdCount: number | null;
    reason: string | null;
  };
}

interface PipelineFactsRow {
  latest_job_status: string | null;
  latest_job_at: string | Date | null;
  latest_run_status: string | null;
  latest_run_at: string | Date | null;
  latest_success_at: string | Date | null;
  latest_finalized_date: string | Date | null;
  account_timezone: string | null;
}

function isoTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function isoDate(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const normalized = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function ageMinutes(value: string | null, now: Date): number | null {
  if (!value || !Number.isFinite(now.getTime())) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  return (now.getTime() - then) / 60_000;
}

function laterTimestamp(...values: Array<string | null>): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    if (!latest) return value;
    return new Date(value).getTime() > new Date(latest).getTime()
      ? value
      : latest;
  }, null);
}

function daysBetween(earlier: string, later: string): number | null {
  const start = new Date(`${earlier}T00:00:00Z`).getTime();
  const end = new Date(`${later}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

function uniqueBlockers(
  blockers: readonly MetaDecisionPipelineBlocker[],
): MetaDecisionPipelineBlocker[] {
  return [...new Set(blockers)];
}

function admissionDimension(
  decision: DbGrowthFenceDecision,
): MetaDecisionPipelineOperationalHealth["admission"] {
  const offender = decision.offender;
  return {
    status: !decision.allowed
      ? "blocked"
      : decision.warning
        ? "warning"
        : "fresh",
    allowed: decision.allowed,
    reason: decision.reason,
    offender: offender
      ? {
          table: offender.table,
          bytes: offender.bytes,
          budget: offender.budget,
          overByBytes: Math.max(0, offender.bytes - offender.budget),
        }
      : null,
    evaluatedAt: decision.evaluatedAt,
  };
}

function unavailableOperationalHealth(input: {
  now: Date;
  blocker: MetaDecisionPipelineBlocker;
  reason: string;
}): MetaDecisionPipelineOperationalHealth {
  const evaluatedAt = input.now.toISOString();
  return {
    contractVersion: META_DECISION_PIPELINE_HEALTH_CONTRACT_VERSION,
    evaluatedAt,
    overall: "unavailable",
    executionReady: false,
    blockers: [input.blocker],
    syncActivity: {
      status: "unavailable",
      latestAt: null,
      ageMinutes: null,
      maxAgeMinutes: META_DECISION_SYNC_ACTIVITY_MAX_AGE_MINUTES,
      latestJobStatus: null,
      latestRunStatus: null,
      reason: input.reason,
    },
    warehouse: {
      status: "unavailable",
      latestFinalizedDate: null,
      expectedFinalizedDate: null,
      lagDays: null,
      accountTimeZone: null,
      reason: input.reason,
    },
    admission: {
      status: "unavailable",
      allowed: false,
      reason: input.reason,
      offender: null,
      evaluatedAt,
    },
  };
}

/**
 * Read only the operational facts needed by a decision surface. This does not
 * call Meta and does not infer that a host cron fired: it reports the newest
 * durable work, finalized warehouse cutoff and the live admission decision as
 * three different facts.
 */
export async function readMetaDecisionPipelineOperationalHealth(input: {
  businessId: string;
  providerAccountId: string | null;
  now?: Date;
  queryTimeoutMs?: number;
}): Promise<MetaDecisionPipelineOperationalHealth> {
  const now = input.now ?? new Date();
  const businessId = input.businessId.trim();
  const providerAccountId = input.providerAccountId?.trim() || null;
  if (!businessId || !providerAccountId) {
    return unavailableOperationalHealth({
      now,
      blocker: "provider_account_required",
      reason: "A provider account is required to verify the Meta decision pipeline.",
    });
  }

  try {
    const sql = getDbWithTimeout(input.queryTimeoutMs ?? 5_000);
    const [rows, fence] = await Promise.all([
      sql.query<PipelineFactsRow>(
        `
          WITH latest_job AS (
            SELECT status,
                   COALESCE(finished_at, started_at, triggered_at, updated_at) AS at
            FROM meta_sync_jobs
            WHERE business_id = $1 AND provider_account_id = $2
            ORDER BY triggered_at DESC, id DESC
            LIMIT 1
          ),
          latest_run AS (
            SELECT status,
                   COALESCE(finished_at, started_at, created_at, updated_at) AS at
            FROM meta_sync_runs
            WHERE business_id = $1 AND provider_account_id = $2
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          ),
          latest_success AS (
            SELECT MAX(at) AS at
            FROM (
              SELECT COALESCE(finished_at, started_at, triggered_at, updated_at) AS at
              FROM meta_sync_jobs
              WHERE business_id = $1 AND provider_account_id = $2
                AND status = 'succeeded'
              UNION ALL
              SELECT COALESCE(finished_at, started_at, created_at, updated_at) AS at
              FROM meta_sync_runs
              WHERE business_id = $1 AND provider_account_id = $2
                AND status = 'succeeded'
            ) successful
          ),
          warehouse AS (
            SELECT MAX(date) AS latest_finalized_date
            FROM meta_ad_daily
            WHERE business_id = $1 AND provider_account_id = $2
              AND truth_state = 'finalized'
              AND finalized_at IS NOT NULL
              AND validation_status = 'passed'
          ),
          account AS (
            SELECT account_timezone
            FROM meta_account_daily
            WHERE business_id = $1 AND provider_account_id = $2
              AND NULLIF(btrim(account_timezone), '') IS NOT NULL
            ORDER BY date DESC, updated_at DESC, id DESC
            LIMIT 1
          )
          SELECT
            latest_job.status AS latest_job_status,
            latest_job.at AS latest_job_at,
            latest_run.status AS latest_run_status,
            latest_run.at AS latest_run_at,
            latest_success.at AS latest_success_at,
            warehouse.latest_finalized_date,
            account.account_timezone
          FROM (SELECT 1) seed
          LEFT JOIN latest_job ON TRUE
          LEFT JOIN latest_run ON TRUE
          LEFT JOIN latest_success ON TRUE
          LEFT JOIN warehouse ON TRUE
          LEFT JOIN account ON TRUE
        `,
        [businessId, providerAccountId],
      ),
      evaluateDbGrowthFence({
        nowMs: now.getTime(),
        queryTimeoutMs: input.queryTimeoutMs ?? 5_000,
      }),
    ]);
    const row = rows[0] ?? ({} as PipelineFactsRow);
    const latestSuccessfulAt = isoTimestamp(row.latest_success_at);
    const latestObservedAt = laterTimestamp(
      latestSuccessfulAt,
      isoTimestamp(row.latest_job_at),
      isoTimestamp(row.latest_run_at),
    );
    const activityAgeMinutes = ageMinutes(latestSuccessfulAt, now);
    const admission = admissionDimension(fence);
    const blockers: MetaDecisionPipelineBlocker[] = [];

    let syncStatus: MetaDecisionPipelineDimensionStatus;
    let syncReason: string | null = null;
    if (!admission.allowed) {
      syncStatus = "blocked";
      syncReason = `New sync work is refused by the growth fence (${admission.reason}).`;
      blockers.push("sync_admission_blocked");
    } else if (!latestSuccessfulAt) {
      syncStatus = "missing";
      syncReason = "No successful scoped Meta sync activity is available.";
      blockers.push("sync_activity_missing");
    } else if (
      activityAgeMinutes === null ||
      activityAgeMinutes < -1 ||
      activityAgeMinutes > META_DECISION_SYNC_ACTIVITY_MAX_AGE_MINUTES
    ) {
      syncStatus = "stale";
      syncReason = `The newest successful scoped Meta sync activity is older than ${META_DECISION_SYNC_ACTIVITY_MAX_AGE_MINUTES} minutes.`;
      blockers.push("sync_activity_stale");
    } else {
      syncStatus = "fresh";
    }

    const accountTimeZone = row.account_timezone?.trim() || null;
    const latestFinalizedDate = isoDate(row.latest_finalized_date);
    let expectedFinalizedDate: string | null = null;
    let warehouseStatus: MetaDecisionPipelineDimensionStatus;
    let warehouseReason: string | null = null;
    let warehouseLagDays: number | null = null;
    if (!accountTimeZone) {
      warehouseStatus = "unavailable";
      warehouseReason = "The provider account timezone is unavailable.";
      blockers.push("account_timezone_unavailable");
    } else {
      try {
        expectedFinalizedDate = addDaysToIsoDateUtc(
          getTodayIsoForTimeZoneServer(accountTimeZone, now),
          -1,
        );
      } catch {
        warehouseReason = "The provider account timezone is invalid.";
      }
      if (!expectedFinalizedDate) {
        warehouseStatus = "unavailable";
        blockers.push("account_timezone_unavailable");
      } else if (!latestFinalizedDate) {
        warehouseStatus = "missing";
        warehouseReason = "No finalized and validated Meta Ad day is available.";
        blockers.push("warehouse_cutoff_missing");
      } else {
        warehouseLagDays = daysBetween(
          latestFinalizedDate,
          expectedFinalizedDate,
        );
        if (warehouseLagDays === null || warehouseLagDays > 0) {
          warehouseStatus = "stale";
          warehouseReason = `Finalized Meta Ad truth ends before ${expectedFinalizedDate}.`;
          blockers.push("warehouse_cutoff_stale");
        } else {
          warehouseStatus = "fresh";
        }
      }
    }

    const unique = uniqueBlockers(blockers);
    const overall = !admission.allowed
      ? "blocked"
      : unique.length > 0
        ? "degraded"
        : "healthy";
    return {
      contractVersion: META_DECISION_PIPELINE_HEALTH_CONTRACT_VERSION,
      evaluatedAt: now.toISOString(),
      overall,
      executionReady: overall === "healthy",
      blockers: unique,
      syncActivity: {
        status: syncStatus,
        latestAt: latestSuccessfulAt ?? latestObservedAt,
        ageMinutes: activityAgeMinutes,
        maxAgeMinutes: META_DECISION_SYNC_ACTIVITY_MAX_AGE_MINUTES,
        latestJobStatus: row.latest_job_status ?? null,
        latestRunStatus: row.latest_run_status ?? null,
        reason: syncReason,
      },
      warehouse: {
        status: warehouseStatus,
        latestFinalizedDate,
        expectedFinalizedDate,
        lagDays: warehouseLagDays,
        accountTimeZone,
        reason: warehouseReason,
      },
      admission,
    };
  } catch (error) {
    return unavailableOperationalHealth({
      now,
      blocker: "pipeline_read_failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

interface MetaDecisionGenerationHealthEvidence {
  available: boolean;
  authority: string | null;
  computedAt: string | null;
  engineVersion: string | null;
  generation: {
    jobRunId: string;
    manifestHash: string;
    expectedAdCount: number;
  } | null;
  unavailableReason: string | null;
}

function buildMetaDecisionPipelineHealthFromEvidence(input: {
  operational: MetaDecisionPipelineOperationalHealth;
  decision: MetaDecisionGenerationHealthEvidence;
  now?: Date;
}): MetaDecisionPipelineHealth {
  const now = input.now ?? new Date(input.operational.evaluatedAt);
  const freshness = evaluateDecisionOriginAdDecisionFreshness({
    computedAt: input.decision.computedAt,
    now,
  });
  const blockers = [...input.operational.blockers];
  let decisionStatus: MetaDecisionPipelineDimensionStatus;
  let decisionReason: string | null = null;
  if (
    !input.decision.available ||
    !input.decision.computedAt
  ) {
    decisionStatus = "missing";
    decisionReason =
      input.decision.unavailableReason ??
      "Exact decision generation is unavailable.";
    blockers.push("decision_generation_missing");
  } else if (freshness.status !== "fresh") {
    decisionStatus = "stale";
    decisionReason = `Exact decision generation is ${freshness.status}.`;
    blockers.push("decision_generation_stale");
  } else {
    decisionStatus = "fresh";
  }

  const generation = input.decision.generation;
  const manifestValid =
    input.decision.available &&
    input.decision.authority === "native_ad" &&
    generation !== null &&
    generation.jobRunId.trim().length > 0 &&
    generation.manifestHash.trim().length > 0 &&
    Number.isInteger(generation.expectedAdCount) &&
    generation.expectedAdCount >= 0;
  if (!manifestValid) blockers.push("decision_manifest_invalid");

  const unique = uniqueBlockers(blockers);
  const overall =
    input.operational.overall === "blocked"
      ? "blocked"
      : input.operational.overall === "unavailable"
        ? "unavailable"
        : unique.length > 0
          ? "degraded"
          : "healthy";
  return {
    ...input.operational,
    overall,
    executionReady: overall === "healthy",
    blockers: unique,
    decisionGeneration: {
      status: decisionStatus,
      computedAt: freshness.computedAt,
      ageHours: freshness.ageHours,
      maxAgeHours: freshness.maxAgeHours,
      engineVersion: input.decision.engineVersion,
      reason: decisionReason,
    },
    manifest: {
      status: manifestValid ? "fresh" : "invalid",
      authority: input.decision.authority,
      jobRunId: generation?.jobRunId ?? null,
      manifestHash: generation?.manifestHash ?? null,
      expectedAdCount: generation?.expectedAdCount ?? null,
      reason: manifestValid
        ? null
        : input.decision.unavailableReason ??
          "A complete native exact-Ad generation manifest is unavailable.",
    },
  };
}

/** Join operational health to the exact generation/manifest the page serves. */
export function buildMetaDecisionPipelineHealth(input: {
  operational: MetaDecisionPipelineOperationalHealth;
  decisionReadModel: MetaDecisionsWorkspaceReadModel;
  now?: Date;
}): MetaDecisionPipelineHealth {
  const source = input.decisionReadModel.source;
  return buildMetaDecisionPipelineHealthFromEvidence({
    operational: input.operational,
    now: input.now,
    decision: {
      available:
        input.decisionReadModel.status === "available" &&
        source?.status === "available",
      authority: source?.authority ?? null,
      computedAt: source?.computedAt ?? null,
      engineVersion: source?.engineVersion ?? null,
      generation: source?.generation
        ? {
            jobRunId: source.generation.jobRunId,
            manifestHash: source.generation.manifestHash,
            expectedAdCount: source.generation.expectedAdCount,
          }
        : null,
      unavailableReason:
        input.decisionReadModel.unavailable?.code ??
        source?.fallbackReason ??
        null,
    },
  });
}

/**
 * Creative Briefing serves the validated canonical inventory directly rather
 * than the workspace envelope. Join the same operational contract to that
 * exact inventory so its action controls cannot use a weaker health test.
 */
export function buildMetaDecisionPipelineHealthFromCanonicalInventory(input: {
  operational: MetaDecisionPipelineOperationalHealth;
  inventory: MetaNativeCanonicalDecisionInventory;
  now?: Date;
}): MetaDecisionPipelineHealth {
  const item = input.inventory.items
    .filter((decision) => decision.sourceDecision.computedAt)
    .sort((left, right) =>
      (left.sourceDecision.computedAt ?? "").localeCompare(
        right.sourceDecision.computedAt ?? "",
      ),
    )
    .at(-1);
  return buildMetaDecisionPipelineHealthFromEvidence({
    operational: input.operational,
    now: input.now,
    decision: {
      available: input.inventory.status === "available",
      authority: input.inventory.status === "available" ? "native_ad" : null,
      computedAt: item?.sourceDecision.computedAt ?? null,
      engineVersion: item?.sourceDecision.engineVersion ?? null,
      generation:
        input.inventory.status === "available"
          ? {
              jobRunId: input.inventory.generation.jobRunId,
              manifestHash: input.inventory.generation.manifestHash,
              expectedAdCount: input.inventory.generation.expectedAdCount,
            }
          : null,
      unavailableReason:
        input.inventory.status === "unavailable"
          ? input.inventory.unavailableReason
          : null,
    },
  });
}
