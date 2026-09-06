import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getDb, type DbClient } from "@/lib/db";
import {
  resolveAccountDecisionProfile,
} from "@/lib/creative-decision-engine/account-decision-profile";
import {
  CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
  campaignContextAuthorityResolverVersion,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import type { CommercialAnchorExplanation } from "@/lib/creative-decision-engine/commercial-anchor";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import { JOB_NAME as CALIBRATION_JOB_NAME } from "@/lib/creative-decision-engine/jobs/calibration-job";
import { JOB_NAME as DECISIONS_JOB_NAME } from "@/lib/creative-decision-engine/jobs/decisions-job";
import { JOB_NAME as LIFECYCLE_JOB_NAME } from "@/lib/creative-decision-engine/jobs/lifecycle-job";
import { JOB_NAME as OPERATOR_RESPONSE_JOB_NAME } from "@/lib/creative-decision-engine/jobs/operator-response-job";
import {
  AD_CALIBRATION_JOB_NAME as NATIVE_AD_CALIBRATION_JOB_NAME,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  AD_DECISION_OUTCOMES_JOB_NAME as NATIVE_AD_OUTCOMES_JOB_NAME,
  inspectAdDecisionOutcomeSchemaCapability,
} from "@/lib/creative-decision-engine/jobs/ad-decision-outcomes-job";
import {
  AD_DECISIONS_JOB_NAME as NATIVE_AD_DECISIONS_JOB_NAME,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import {
  AD_OPERATOR_RESPONSE_JOB_NAME as NATIVE_AD_OPERATOR_RESPONSE_JOB_NAME,
} from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import { engineV3JobsDisabled } from "@/lib/creative-decision-engine/jobs/job-switch";
import { inspectNativeAdShadowSchemaReadiness } from "@/lib/creative-decision-engine/jobs/native-ad-scheduled";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AccountDecisionProfile,
} from "@/lib/creative-decision-engine/types";
import { inspectControlledRegistryCapabilities } from "@/lib/meta/controlled-experiment-registry";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

type FlagSource = "env" | "business_override";
type DataHealthTier = "fresh" | "warning" | "stale" | "missing";
type OutputMetaAovQuality = "high" | "medium" | "low" | "missing";
type OutputThresholdQuality = "high" | "medium" | "low";

interface JobStatus {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  ageHours: number | null;
  isStale: boolean;
  lastError: string | null;
}

interface ReadinessFlags {
  enabled: boolean;
  surfaceVisible: boolean;
  shadowOnly: boolean;
  source: {
    enabled: FlagSource;
    surfaceVisible: FlagSource;
    shadowOnly: FlagSource;
    presetOverride: FlagSource | null;
  };
}

interface DataHealth {
  tier: DataHealthTier;
  metaSyncAgeHours: number | null;
  decisionsAgeHours: number | null;
}

interface ReadinessAccountProfile {
  spendUnit: number | null;
  spendUnitSource: string;
  presetLabel: "balanced" | "conservative" | "aggressive";
  targetRoas: number | null;
  breakEvenRoas: number | null;
  aov: number | null;
  aovSource: "operator_assumption" | "meta_attributed_90d" | null;
  matureCount: number;
  quality: {
    commercialTruthReady: boolean;
    calibrationReady: boolean;
    metaAovQuality: OutputMetaAovQuality;
    thresholdQuality: OutputThresholdQuality;
  };
  /**
   * The canonical commercial-anchor explanation from
   * `AccountDecisionProfile.hardActionEligibility.anchor`, verbatim: resolved
   * spend unit, source, confidence, target provenance, full input lineage, the
   * missing inputs, and the per-action blocker codes. Null when the profile
   * predates the contract; absence is never read as eligible.
   */
  commercialAnchor: CommercialAnchorExplanation | null;
  /** The profile's effective per-action decision and its stable codes. */
  hardActionEligibility: {
    scale: boolean;
    cut: boolean;
    refresh: boolean;
    codes: {
      scale: string | null;
      cut: string | null;
      refresh: string | null;
    };
  };
}

interface JobsSnapshot {
  calibration: JobStatus;
  lifecycle: JobStatus;
  decisions: JobStatus;
  operatorResponse: JobStatus;
}

interface NativeAdJobsSnapshot {
  calibration: JobStatus;
  decisions: JobStatus;
  operatorResponse: JobStatus;
  outcomes: JobStatus;
}

interface NativeAdReadiness {
  engineVersion: typeof NATIVE_AD_ENGINE_VERSION;
  shadowOnly: true;
  jobsDisabled: boolean;
  schema: {
    producer: Awaited<ReturnType<typeof inspectNativeAdShadowSchemaReadiness>>;
    outcomes: { ready: boolean; issues: string[] };
    controlledRegistry: { ready: boolean; issues: string[] };
    allReady: boolean;
  };
  jobs: NativeAdJobsSnapshot;
  evidence: {
    latestSnapshotAt: string | null;
    ageHours: number | null;
    isStale: boolean;
  };
  gating: {
    canRunShadow: boolean;
    hasCurrentEvidence: boolean;
    canMeasureOutcomes: boolean;
    canUseControlledEvidence: boolean;
    reasons: string[];
  };
}

interface BusinessRow {
  id: unknown;
  name: unknown;
}

interface FreshnessRow {
  latest_at: unknown;
}

interface JobStatusRow {
  last_run_at: unknown;
  last_success_at: unknown;
  last_failure_at: unknown;
  last_error: unknown;
}

interface MatureCountRow {
  mature_count: unknown;
}

interface DecisionsSummaryRow {
  last_24h: unknown;
  last_7d: unknown;
  soft_only_count: unknown;
  hard_action_count: unknown;
}

function noStoreJson(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, {
    status: init?.status,
    headers: NO_STORE_HEADERS,
  });
}

function parseBusinessId(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (UUID_PATTERN.test(trimmed) || POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoTimestampOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function ageHoursSince(isoTimestamp: string | null, nowMs: number) {
  if (isoTimestamp === null) return null;
  const timestampMs = new Date(isoTimestamp).getTime();
  if (Number.isNaN(timestampMs)) return null;
  return Math.max(0, (nowMs - timestampMs) / (60 * 60 * 1000));
}

function truncateText(value: unknown, maxLength: number) {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function toReadinessFlags(flags: EngineV3Flags): ReadinessFlags {
  return {
    enabled: flags.enabled,
    surfaceVisible: flags.surfaceVisible,
    shadowOnly: flags.shadowOnly,
    source: flags.source,
  };
}

async function readBusiness(db: DbClient, businessId: string) {
  const [row] = await db.query<BusinessRow>(
    `
    SELECT id::text AS id, name
    FROM businesses
    WHERE id::text = $1
    LIMIT 1
    `,
    [businessId],
  );

  if (!row) return null;
  return {
    id: toStringOrNull(row.id) ?? businessId,
    name: toStringOrNull(row.name) ?? "",
  };
}

function computeDataHealthTier(input: {
  metaSyncAgeHours: number | null;
  decisionsAgeHours: number | null;
}): DataHealthTier {
  if (input.metaSyncAgeHours === null || input.decisionsAgeHours === null) {
    return "missing";
  }
  if (input.metaSyncAgeHours > 72 || input.decisionsAgeHours > 72) {
    return "stale";
  }
  if (input.metaSyncAgeHours > 36 || input.decisionsAgeHours > 36) {
    return "warning";
  }
  return "fresh";
}

async function readDataHealth(
  db: DbClient,
  businessId: string,
  nowMs: number,
): Promise<DataHealth> {
  const [metaRows, decisionRows] = await Promise.all([
    db.query<FreshnessRow>(
      `
      SELECT MAX(updated_at) AS latest_at
      FROM meta_creative_daily
      WHERE business_ref_id::text = $1 OR business_id = $1
      `,
      [businessId],
    ),
    db.query<FreshnessRow>(
      `
      SELECT MAX(computed_at) AS latest_at
      FROM engine_v3_decision_snapshots_daily
      WHERE business_ref_id::text = $1 OR business_id = $1
      `,
      [businessId],
    ),
  ]);

  const metaSyncAgeHours = ageHoursSince(
    toIsoTimestampOrNull(metaRows[0]?.latest_at),
    nowMs,
  );
  const decisionsAgeHours = ageHoursSince(
    toIsoTimestampOrNull(decisionRows[0]?.latest_at),
    nowMs,
  );

  return {
    tier: computeDataHealthTier({ metaSyncAgeHours, decisionsAgeHours }),
    metaSyncAgeHours,
    decisionsAgeHours,
  };
}

async function readJobStatus(
  db: DbClient,
  businessId: string,
  jobName: string,
  nowMs: number,
  engineVersion?: string,
): Promise<JobStatus> {
  const [row] = await db.query<JobStatusRow>(
    `
    SELECT
      MAX(started_at) AS last_run_at,
      MAX(CASE WHEN status = 'success' THEN finished_at END) AS last_success_at,
      MAX(CASE WHEN status IN ('failed', 'failure') THEN finished_at END) AS last_failure_at,
      (
        SELECT COALESCE(error_json::text, error_message)
        FROM engine_v3_job_runs
        WHERE job_name = $1
          AND (business_ref_id::text = $2 OR business_id = $2)
          AND ($3::text IS NULL OR engine_version = $3)
          AND status IN ('failed', 'failure')
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1
      ) AS last_error
    FROM engine_v3_job_runs
    WHERE job_name = $1
      AND (business_ref_id::text = $2 OR business_id = $2)
      AND ($3::text IS NULL OR engine_version = $3)
    `,
    [jobName, businessId, engineVersion ?? null],
  );

  const lastSuccessAt = toIsoTimestampOrNull(row?.last_success_at);
  const ageHours = ageHoursSince(lastSuccessAt, nowMs);

  return {
    lastRunAt: toIsoTimestampOrNull(row?.last_run_at),
    lastSuccessAt,
    lastFailureAt: toIsoTimestampOrNull(row?.last_failure_at),
    ageHours,
    isStale: ageHours !== null && ageHours > 24,
    lastError: truncateText(row?.last_error, 500),
  };
}

async function readNativeAdReadiness(
  db: DbClient,
  businessId: string,
  nowMs: number,
): Promise<NativeAdReadiness> {
  const [producer, outcomesCapability, controlledCapability, jobs, snapshotRows] =
    await Promise.all([
      inspectNativeAdShadowSchemaReadiness(),
      inspectAdDecisionOutcomeSchemaCapability(db).catch((error) => ({
        ready: false,
        missing: [
          `inspection_failed:${error instanceof Error ? error.message : String(error)}`,
        ],
      })),
      inspectControlledRegistryCapabilities().catch((error) => ({
        ready: false,
        issues: [
          `inspection_failed:${error instanceof Error ? error.message : String(error)}`,
        ],
      })),
      Promise.all([
        readJobStatus(
          db,
          businessId,
          NATIVE_AD_CALIBRATION_JOB_NAME,
          nowMs,
          NATIVE_AD_ENGINE_VERSION,
        ),
        readJobStatus(
          db,
          businessId,
          NATIVE_AD_DECISIONS_JOB_NAME,
          nowMs,
          NATIVE_AD_ENGINE_VERSION,
        ),
        readJobStatus(
          db,
          businessId,
          NATIVE_AD_OPERATOR_RESPONSE_JOB_NAME,
          nowMs,
          NATIVE_AD_ENGINE_VERSION,
        ),
        readJobStatus(
          db,
          businessId,
          NATIVE_AD_OUTCOMES_JOB_NAME,
          nowMs,
          NATIVE_AD_ENGINE_VERSION,
        ),
      ]),
      db.query<FreshnessRow>(
        `
        SELECT MAX(computed_at) AS latest_at
        FROM engine_v3_ad_decision_snapshots_daily
        WHERE business_ref_id::text = $1
          AND engine_version = $2
        `,
        [businessId, NATIVE_AD_ENGINE_VERSION],
      ).catch(() => []),
    ]);

  const nativeJobs: NativeAdJobsSnapshot = {
    calibration: jobs[0],
    decisions: jobs[1],
    operatorResponse: jobs[2],
    outcomes: jobs[3],
  };
  const latestSnapshotAt = toIsoTimestampOrNull(snapshotRows[0]?.latest_at);
  const snapshotAgeHours = ageHoursSince(latestSnapshotAt, nowMs);
  const snapshotStale = snapshotAgeHours !== null && snapshotAgeHours > 24;
  const jobsDisabled = engineV3JobsDisabled();
  const outcomes = {
    ready: outcomesCapability.ready,
    issues: [...outcomesCapability.missing],
  };
  const controlledRegistry = {
    ready: controlledCapability.ready,
    issues: [...controlledCapability.issues],
  };
  const reasons: string[] = [];
  if (jobsDisabled) reasons.push("native_jobs_disabled");
  if (!producer.ready) reasons.push("native_producer_schema_not_ready");
  if (!outcomes.ready) reasons.push("native_outcome_schema_not_ready");
  if (!controlledRegistry.ready) {
    reasons.push("controlled_registry_schema_not_ready");
  }
  addJobGateReasons(reasons, "native_calibration", nativeJobs.calibration);
  addJobGateReasons(reasons, "native_decisions", nativeJobs.decisions);
  addJobGateReasons(
    reasons,
    "native_operator_response",
    nativeJobs.operatorResponse,
  );
  if (latestSnapshotAt === null) reasons.push("native_snapshot_missing");
  if (snapshotStale) reasons.push("native_snapshot_stale");

  const canRunShadow = !jobsDisabled && producer.ready;
  const hasCurrentEvidence =
    canRunShadow &&
    latestSnapshotAt !== null &&
    !snapshotStale &&
    nativeJobs.calibration.lastSuccessAt !== null &&
    !nativeJobs.calibration.isStale &&
    nativeJobs.decisions.lastSuccessAt !== null &&
    !nativeJobs.decisions.isStale &&
    nativeJobs.operatorResponse.lastSuccessAt !== null &&
    !nativeJobs.operatorResponse.isStale;

  return {
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    shadowOnly: true,
    jobsDisabled,
    schema: {
      producer,
      outcomes,
      controlledRegistry,
      allReady: producer.ready && outcomes.ready && controlledRegistry.ready,
    },
    jobs: nativeJobs,
    evidence: {
      latestSnapshotAt,
      ageHours: snapshotAgeHours,
      isStale: snapshotStale,
    },
    gating: {
      canRunShadow,
      hasCurrentEvidence,
      canMeasureOutcomes: hasCurrentEvidence && outcomes.ready,
      canUseControlledEvidence: hasCurrentEvidence && controlledRegistry.ready,
      reasons,
    },
  };
}

async function readJobs(
  db: DbClient,
  businessId: string,
  nowMs: number,
): Promise<JobsSnapshot> {
  const [calibration, lifecycle, decisions, operatorResponse] =
    await Promise.all([
      readJobStatus(db, businessId, CALIBRATION_JOB_NAME, nowMs),
      readJobStatus(db, businessId, LIFECYCLE_JOB_NAME, nowMs),
      readJobStatus(db, businessId, DECISIONS_JOB_NAME, nowMs),
      readJobStatus(db, businessId, OPERATOR_RESPONSE_JOB_NAME, nowMs),
    ]);

  return { calibration, lifecycle, decisions, operatorResponse };
}

async function readMatureCount(db: DbClient, businessId: string) {
  const [row] = await db.query<MatureCountRow>(
    `
    SELECT mature_creative_count AS mature_count
    FROM engine_v3_account_calibration_daily
    WHERE (business_ref_id::text = $1 OR business_id = $1)
      AND scope_type = 'account'
      AND scope_id = '*'
      AND campaign_kind = 'all'
      AND creative_format = 'overall'
    ORDER BY as_of_date DESC, computed_at DESC
    LIMIT 1
    `,
    [businessId],
  );

  return toNumberOrNull(row?.mature_count);
}

async function readDecisionsSummary(db: DbClient, businessId: string) {
  const [row] = await db.query<DecisionsSummaryRow>(
    `
    WITH snapshots AS (
      SELECT *
      FROM engine_v3_decision_snapshots_daily
      WHERE business_ref_id::text = $1 OR business_id = $1
    ),
    guarded AS (
      SELECT
        snapshots.computed_at,
        CASE
          WHEN snapshots.label IN ('scale', 'refresh', 'cut')
            AND lifecycle.campaign_id IS NOT NULL
            AND campaign_context.trusted IS DISTINCT FROM true
          THEN 'diagnose'
          ELSE snapshots.label
        END AS label
      FROM snapshots
      LEFT JOIN LATERAL (
        SELECT lifecycle.campaign_id, lifecycle.provider_account_id
        FROM engine_v3_creative_lifecycle_daily lifecycle
        WHERE lifecycle.business_ref_id = snapshots.business_ref_id
          AND lifecycle.creative_id = snapshots.creative_id
          AND lifecycle.engine_version = snapshots.engine_version
          AND lifecycle.as_of_date <= snapshots.as_of_date
        ORDER BY lifecycle.as_of_date DESC, lifecycle.computed_at DESC
        LIMIT 1
      ) lifecycle ON true
      LEFT JOIN LATERAL (
        SELECT true AS trusted
        FROM engine_v3_campaign_context_daily context
        WHERE context.business_id = COALESCE(
            snapshots.business_id,
            snapshots.business_ref_id::text
          )
          AND context.provider_account_id = lifecycle.provider_account_id
          AND context.campaign_id = lifecycle.campaign_id
          AND context.as_of_date <= snapshots.as_of_date
          AND context.as_of_date >= (
            snapshots.as_of_date - (${CAMPAIGN_CONTEXT_MAX_AGE_DAYS} * INTERVAL '1 day')
          )
          AND context.inferred_kind IS NOT NULL
          AND context.confidence_class = 'high'
          AND context.resolver_version = $2::text
        ORDER BY context.as_of_date DESC, context.updated_at DESC, context.id DESC
        LIMIT 1
      ) campaign_context ON true
    )
    SELECT
      COUNT(*) FILTER (WHERE computed_at > NOW() - INTERVAL '24 hours') AS last_24h,
      COUNT(*) FILTER (WHERE computed_at > NOW() - INTERVAL '7 days') AS last_7d,
      COUNT(*) FILTER (
        WHERE computed_at > NOW() - INTERVAL '24 hours'
          AND label IN ('keep', 'test_more', 'diagnose', 'out_of_scope')
      ) AS soft_only_count,
      COUNT(*) FILTER (
        WHERE computed_at > NOW() - INTERVAL '24 hours'
          AND label IN ('scale', 'refresh', 'cut')
      ) AS hard_action_count
    FROM guarded
    `,
    [businessId, campaignContextAuthorityResolverVersion()],
  );

  return {
    last24h: toNumberOrNull(row?.last_24h) ?? 0,
    last7d: toNumberOrNull(row?.last_7d) ?? 0,
    softOnlyCount: toNumberOrNull(row?.soft_only_count) ?? 0,
    hardActionCount: toNumberOrNull(row?.hard_action_count) ?? 0,
  };
}

function mapMetaAovQuality(
  value: AccountDecisionProfile["quality"]["metaAovQuality"],
): OutputMetaAovQuality {
  if (value === "ready") return "high";
  if (value === "low_sample") return "medium";
  if (value === "unstable") return "low";
  return "missing";
}

function mapThresholdQuality(
  value: AccountDecisionProfile["quality"]["thresholdQuality"],
): OutputThresholdQuality {
  if (value === "ready") return "high";
  if (value === "degraded") return "medium";
  return "low";
}

function resolveAov(input: AccountDecisionProfile): {
  aov: number | null;
  aovSource: ReadinessAccountProfile["aovSource"];
} {
  const operatorAov = input.spendUnitEvidence.operatorAovAssumption;
  if (operatorAov !== null && Number.isFinite(operatorAov) && operatorAov > 0) {
    return { aov: operatorAov, aovSource: "operator_assumption" };
  }

  const metaAov = input.spendUnitEvidence.metaAttributedAovMean90d;
  if (metaAov !== null && Number.isFinite(metaAov) && metaAov > 0) {
    return { aov: metaAov, aovSource: "meta_attributed_90d" };
  }

  return { aov: null, aovSource: null };
}

function mapAccountProfile(
  profile: AccountDecisionProfile,
  matureCount: number | null,
): ReadinessAccountProfile {
  const aov = resolveAov(profile);
  const eligibility = profile.hardActionEligibility as
    | AccountDecisionProfile["hardActionEligibility"]
    | undefined;

  return {
    spendUnit: profile.spendUnit,
    spendUnitSource: profile.spendUnitSource,
    presetLabel: profile.preset,
    targetRoas: profile.spendUnitEvidence.targetRoas,
    breakEvenRoas: profile.spendUnitEvidence.breakEvenRoas,
    aov: aov.aov,
    aovSource: aov.aovSource,
    matureCount: matureCount ?? profile.accountBaselines.matureCreativeCount,
    quality: {
      commercialTruthReady: profile.quality.commercialTruthReady,
      calibrationReady: profile.quality.calibrationReady,
      metaAovQuality: mapMetaAovQuality(profile.quality.metaAovQuality),
      thresholdQuality: mapThresholdQuality(profile.quality.thresholdQuality),
    },
    // Defensive: a readiness read must degrade to "unknown", never 500, if a
    // profile arrives without its eligibility block. Absence is reported as
    // ineligible with no code — it is never read as eligible.
    commercialAnchor: eligibility?.anchor ?? null,
    hardActionEligibility: {
      scale: eligibility?.scale ?? false,
      cut: eligibility?.cut ?? false,
      refresh: eligibility?.refresh ?? false,
      codes: {
        scale: eligibility?.codes?.scale ?? null,
        cut: eligibility?.codes?.cut ?? null,
        refresh: eligibility?.codes?.refresh ?? null,
      },
    },
  };
}

function addJobGateReasons(
  reasons: string[],
  reasonPrefix: string,
  job: JobStatus,
) {
  if (job.lastSuccessAt === null) {
    reasons.push(`${reasonPrefix}_missing`);
    return;
  }
  if (job.isStale) reasons.push(`${reasonPrefix}_stale`);
}

function buildGating(input: {
  flags: ReadinessFlags;
  dataHealth: DataHealth;
  accountProfile: ReadinessAccountProfile;
  jobs: JobsSnapshot;
}) {
  const reasons: string[] = [];

  if (!input.flags.enabled) reasons.push("engine_v3_disabled");
  if (input.dataHealth.tier === "missing") reasons.push("data_health_missing");
  if (input.dataHealth.tier === "stale") reasons.push("data_health_stale");
  if (input.accountProfile.spendUnit === null) {
    reasons.push("spend_unit_missing");
  }
  if (!input.accountProfile.quality.calibrationReady) {
    reasons.push("calibration_not_ready");
  }

  addJobGateReasons(reasons, "calibration", input.jobs.calibration);
  addJobGateReasons(reasons, "lifecycle", input.jobs.lifecycle);
  addJobGateReasons(reasons, "decisions", input.jobs.decisions);
  addJobGateReasons(
    reasons,
    "operator_response",
    input.jobs.operatorResponse,
  );

  return {
    canEvaluate: reasons.length === 0,
    reasons,
  };
}

/**
 * D077 read-only readiness contract for the state-history growth-fence
 * recovery — served from the shared server-owned read model
 * (lib/meta/state-history-compaction-readiness.ts). Display-only: the UI
 * renders these fields and must not execute compaction or compute safety
 * itself. Approval status can only progress through the operator CLI; this
 * route never returns a token or anything executable. Journal state is
 * business-scoped, and D075 writer evidence is MEASURED (manifest_kind
 * presence), never asserted from an assumption.
 */
async function readCompactionReadinessSection(
  db: DbClient,
  businessId: string,
) {
  const { readStateHistoryCompactionReadiness } = await import(
    "@/lib/meta/state-history-compaction-readiness"
  );
  return readStateHistoryCompactionReadiness(db, { businessId });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const businessId = parseBusinessId(url.searchParams.get("businessId"));

  if (businessId === null) {
    return noStoreJson(
      { error: "invalid_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  try {
    const auth = await requireAdmin(request);
    if (auth.error) {
      auth.error.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
      auth.error.headers.set("Pragma", NO_STORE_HEADERS.Pragma);
      return auth.error;
    }

    const db = getDb();
    const asOfTimestamp = new Date().toISOString();
    const asOfDate = asOfTimestamp.slice(0, 10);
    const nowMs = new Date(asOfTimestamp).getTime();

    const [business, resolverFlags] = await Promise.all([
      readBusiness(db, businessId),
      resolveEngineV3Flags(businessId),
    ]);

    if (business === null) {
      return noStoreJson(
        {
          error: "business_not_found",
          message: "Business not found.",
        },
        { status: 404 },
      );
    }

    /*
      DELIBERATELY BUSINESS-WIDE, and not scoped to a physical ad account.

      `lib/creative-decision-engine/jobs/decisions-job.ts` and
      `lib/creative-decision-engine/jobs/lifecycle-job.ts` wrap this same
      resolver in `AccountScopedDataSource`, because each of their outputs is
      keyed on one `provider_account_id` and a pooled profile therefore lets one
      account's samples set another's thresholds. This route is the other case,
      and scoping it would be the opposite mistake.

      It takes ONE parameter, `businessId` (the sole `searchParams` read in this
      file), and there is no account to scope to. Every other section it returns
      is business-grained by construction — `readDataHealth`, `readJobs`,
      `readMatureCount`, `readDecisionsSummary`, `readNativeAdReadiness` and
      `readCompactionReadinessSection` are each given `business.id` as their
      only subject, and `gating` is computed from the business's job runs and
      this profile. Pinning an arbitrary account onto the profile alone would
      make one block of this payload speak for a different subject than the
      rest, and would report one account's calibration readiness as the gate on
      business-wide jobs.

      It is also the reading the accepted serve path already gives a request
      that names no account: `app/api/meta/decisions-workspace/route.ts` scopes
      only when a `providerAccountId` is present, on the grounds that with none
      "there is nothing to scope to and nothing to contradict". No retained
      per-account verdict speaks for the business, and this route never claims
      one does.
    */
    const dataSource = new WarehouseDataSource();
    const profileInput = {
      businessId: business.id,
      asOf: asOfDate,
      dataSource,
      flags: resolverFlags,
    };
    const [
      dataHealth,
      jobs,
      profile,
      matureCount,
      decisionsSummary,
      nativeAd,
    ] =
      await Promise.all([
        readDataHealth(db, business.id, nowMs),
        readJobs(db, business.id, nowMs),
        resolveAccountDecisionProfile(profileInput),
        readMatureCount(db, business.id),
        readDecisionsSummary(db, business.id),
        readNativeAdReadiness(db, business.id, nowMs),
      ]);

    const accountProfile = mapAccountProfile(profile, matureCount);
    const flags = toReadinessFlags(resolverFlags);
    const gating = buildGating({
      flags,
      dataHealth,
      accountProfile,
      jobs,
    });
    const stateHistoryCompaction = await readCompactionReadinessSection(
      db,
      business.id,
    );

    return noStoreJson({
      businessId: business.id,
      businessName: business.name,
      asOfTimestamp,
      flags,
      dataHealth,
      jobs,
      accountProfile,
      decisionsSummary,
      gating,
      nativeAd,
      stateHistoryCompaction,
    });
  } catch (error) {
    console.error("[admin/engine-v3/readiness GET]", error);
    return noStoreJson(
      { error: "internal_error", message: String(error) },
      { status: 500 },
    );
  }
}
