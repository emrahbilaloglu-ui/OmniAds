import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getDb, type DbClient } from "@/lib/db";
import {
  resolveAccountDecisionProfile,
} from "@/lib/creative-decision-engine/account-decision-profile";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import { JOB_NAME as CALIBRATION_JOB_NAME } from "@/lib/creative-decision-engine/jobs/calibration-job";
import { JOB_NAME as DECISIONS_JOB_NAME } from "@/lib/creative-decision-engine/jobs/decisions-job";
import { JOB_NAME as LIFECYCLE_JOB_NAME } from "@/lib/creative-decision-engine/jobs/lifecycle-job";
import { JOB_NAME as OPERATOR_RESPONSE_JOB_NAME } from "@/lib/creative-decision-engine/jobs/operator-response-job";
import type { AccountDecisionProfile } from "@/lib/creative-decision-engine/types";

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
}

interface JobsSnapshot {
  calibration: JobStatus;
  lifecycle: JobStatus;
  decisions: JobStatus;
  operatorResponse: JobStatus;
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
          AND status IN ('failed', 'failure')
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1
      ) AS last_error
    FROM engine_v3_job_runs
    WHERE job_name = $1
      AND (business_ref_id::text = $2 OR business_id = $2)
    `,
    [jobName, businessId],
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
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id::text = $1 OR business_id = $1
    `,
    [businessId],
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

    const dataSource = new WarehouseDataSource();
    const profileInput = {
      businessId: business.id,
      asOf: asOfDate,
      dataSource,
      flags: resolverFlags,
    };
    const [dataHealth, jobs, profile, matureCount, decisionsSummary] =
      await Promise.all([
        readDataHealth(db, business.id, nowMs),
        readJobs(db, business.id, nowMs),
        resolveAccountDecisionProfile(profileInput),
        readMatureCount(db, business.id),
        readDecisionsSummary(db, business.id),
      ]);

    const accountProfile = mapAccountProfile(profile, matureCount);
    const flags = toReadinessFlags(resolverFlags);
    const gating = buildGating({
      flags,
      dataHealth,
      accountProfile,
      jobs,
    });

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
    });
  } catch (error) {
    console.error("[admin/engine-v3/readiness GET]", error);
    return noStoreJson(
      { error: "internal_error", message: String(error) },
      { status: 500 },
    );
  }
}
