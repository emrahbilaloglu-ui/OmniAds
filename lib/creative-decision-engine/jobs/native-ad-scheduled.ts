import { getDb, withPinnedDbClient, type DbClient } from "@/lib/db";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { projectNativeAdProposals } from "@/lib/meta/automation-proposals";
import {
  AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
} from "../data-source";
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
import { hashAdvisoryLock } from "./advisory-lock";
import { engineV3JobsDisabled } from "./job-switch";

export const NATIVE_AD_SHADOW_DAILY_UTC_START_HOUR = 3;

/**
 * The two slots the native chain produces in, and why a second one is needed.
 *
 * Native `cut` decisions are withheld when their inputs are older than 12
 * hours. Producing once at 03:00 UTC therefore meant that from 15:00 onwards
 * every native cut was refused for staleness — not because the evidence was
 * meaningfully old, but because nothing had produced since morning. The
 * freshness threshold is right; the cadence was not.
 *
 * A second slot needs no schema change and no new job name. What it needs is
 * for "has this job succeeded" to be answerable per slot rather than per day,
 * which is what the `since` window below does.
 */
export const NATIVE_AD_SHADOW_SLOT_HOURS = [3, 15] as const;

/** The start of the slot window `now` falls in, or null before the first. */
export function nativeAdShadowSlotStart(now: Date): Date | null {
  const hour = now.getUTCHours();
  let slot: number | null = null;
  for (const candidate of NATIVE_AD_SHADOW_SLOT_HOURS) {
    if (hour >= candidate) slot = candidate;
  }
  if (slot === null) return null;
  const start = new Date(now);
  start.setUTCHours(slot, 0, 0, 0);
  return start;
}
export const NATIVE_AD_OPERATOR_RESPONSE_RETRY_COOLDOWN_MS = 60 * 60 * 1_000;
/** A real terminal failure gets one bounded skipped tick, then retries. */
export const NATIVE_AD_DECISION_FAILURE_RETRY_COOLDOWN_MS = 15 * 60 * 1_000;
/**
 * Cover a source transaction that began just before the decision snapshot but
 * committed after it. The overlap may cause one conservative extra retry; it
 * must never hide newly committed evidence for the rest of the slot.
 */
export const NATIVE_AD_DECISION_EVIDENCE_COMMIT_SAFETY_MS = 60 * 1_000;

/**
 * The queue projection, recorded as a run of its own.
 *
 * It is the one step of this chain that had no record at all, and without one
 * the chain cannot tell "projected" from "threw": the three producer jobs
 * report `previous_success` for the rest of the slot, the whole chain then
 * reports `already_ran`, and a projection that failed once is never attempted
 * again for that slot. The native cuts stay durable and unqueued, and the
 * operator sees an empty queue with nothing anywhere saying why.
 *
 * The second slot needed no new job name because it reused the producers' own
 * records. This step has none to reuse.
 */
export const AD_PROPOSAL_PROJECTION_JOB_NAME =
  "engine_v3_native_ad_proposal_projection_shadow_job" as const;

const NATIVE_AD_SHADOW_JOB_NAMES = [
  AD_CALIBRATION_JOB_NAME,
  AD_DECISIONS_JOB_NAME,
  AD_OPERATOR_RESPONSE_JOB_NAME,
  AD_PROPOSAL_PROJECTION_JOB_NAME,
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
  source: "ran" | "previous_success" | "dependency_blocked" | "retry_backoff";
  result: TResult | null;
  reason: string | null;
  errorMessage: string | null;
}

/** What a completed projection has to say for itself. */
export interface ProposalProjectionResult {
  projected: number;
}

export interface NativeAdShadowBusinessResult {
  businessId: string;
  businessName: string | null;
  calibration: NativeAdScheduledStep<AdCalibrationJobResult>;
  decisions: NativeAdScheduledStep<AdDecisionsJobResult>;
  operatorResponse: NativeAdScheduledStep<AdOperatorResponseJobResult>;
  /**
   * The confirmation-queue projection of the decisions THIS chain published.
   *
   * It belongs here rather than in the structure snapshot because ordering is
   * the whole problem: the cron runs the snapshot first, so a projection there
   * could only ever read the previous slot's native decisions. Running it after
   * publication means the morning's decisions reach the queue in the morning.
   *
   * It reports like the other three steps because it now IS one. As a bare
   * `{ projected, ran } | null` there was no way to say that a projection had
   * been attempted and failed, so nothing retried it and no surface could name
   * the reason the queue was empty.
   */
  proposalProjection: NativeAdScheduledStep<ProposalProjectionResult>;
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
  /**
   * A retry-reader failure never promotes old work to reusable. The chain runs
   * the affected stage instead, and this bounded code list keeps that degraded
   * fallback visible to the cron response without exposing database text.
   */
  retryBackoffReadFailures?: Array<"decision" | "operator_response">;
  /** Businesses already owned by another scheduler tick on this host set. */
  concurrentBusinessIds?: string[];
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

interface OperatorResponseRetryBackoffRow extends Record<string, unknown> {
  business_ref_id: unknown;
  status: unknown;
  finished_at: unknown;
}

interface DecisionRetryBackoffRow extends Record<string, unknown> {
  business_ref_id: unknown;
  status: unknown;
  started_at: unknown;
  finished_at: unknown;
  error_json: unknown;
  current_accounts: unknown;
}

export const READ_NATIVE_AD_CALIBRATION_REUSE_RECEIPT_SQL = `
WITH latest_target_history AS (
  SELECT history.recorded_at, history.effective_at
  FROM business_target_pack_history history
  WHERE history.business_id = $1::uuid
    AND history.effective_at <= $3::timestamptz
    AND history.recorded_at <= $3::timestamptz
  ORDER BY history.effective_at DESC, history.recorded_at DESC, history.id DESC
  LIMIT 1
), latest_successful_calibration AS (
  SELECT run.error_json, run.started_at
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
  JOIN provider_accounts account
    ON account.id = binding.provider_account_ref_id
   AND account.provider = binding.provider
   AND account.external_account_id = binding.provider_account_id
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
    SELECT GREATEST(target.recorded_at, target.effective_at)
             <= run.started_at - INTERVAL '1 minute'
    FROM latest_target_history target
    CROSS JOIN latest_successful_calibration run
  )
END AS reusable
FROM calibration_batches
CROSS JOIN calibration_receipt
CROSS JOIN assigned_accounts
`;

export interface NativeAdShadowScheduleOptions {
  /** Fresh wall clock after a contended business-chain lock is acquired. */
  clock?: () => Date;
  /**
   * The confirmation-queue projection, injectable for the same reason every
   * other reader here is: these suites drive doubles, and a projection that
   * opened its own connection would fail them for a reason unrelated to the
   * chain. Production uses the real one.
   */
  projectProposals?: typeof projectNativeAdProposals;
  /**
   * The projection's own run record, injectable for the same reason.
   *
   * It is what makes a failed projection retryable at all, so a suite that
   * drives the chain has to be able to see what was recorded without a
   * connection.
   */
  recordProjectionRun?: (
    input: ProposalProjectionRunRecord,
  ) => Promise<void>;
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
    /** The slot window's start; the caller has always passed it. */
    since?: string | null;
  }) => Promise<Map<string, Set<NativeAdShadowJobName>>>;
  readOperatorResponseRetryBackoffs?: (input: {
    businessIds: readonly string[];
    asOf: string;
    decisionCutoff: string;
  }) => Promise<Set<string>>;
  readDecisionRetryBackoffs?: (input: {
    businessIds: readonly string[];
    asOf: string;
    decisionCutoff: string;
    since: string;
  }) => Promise<Set<string>>;
  hasSuccessfulJob?: (input: {
    businessId: string;
    asOf: string;
    jobName: NativeAdShadowJobName;
    decisionCutoff: string;
    since: string;
  }) => Promise<boolean>;
  withBusinessChainLock?: <T>(
    input: {
      businessId: string;
      asOf: string;
    },
    run: () => Promise<T>,
  ) => Promise<{ acquired: boolean; value: T | null }>;
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
    JOIN provider_accounts account
      ON account.id = binding.provider_account_ref_id
     AND account.provider = binding.provider
     AND account.external_account_id = binding.provider_account_id
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

export const READ_NATIVE_AD_OPERATOR_RESPONSE_RETRY_BACKOFFS_SQL = `
WITH latest_terminal AS (
  SELECT DISTINCT ON (run.business_ref_id)
    run.business_ref_id::text AS business_ref_id,
    run.status,
    run.finished_at
  FROM engine_v3_job_runs run
  WHERE run.business_ref_id::text = ANY($1::text[])
    AND run.as_of_date = $2::date
    AND run.engine_version = $3
    AND run.job_name = $4
    AND run.status IN ('success', 'failed')
    AND run.started_at <= $5::timestamptz
    AND run.finished_at IS NOT NULL
    AND run.finished_at <= $5::timestamptz
  ORDER BY
    run.business_ref_id,
    run.finished_at DESC,
    run.started_at DESC,
    run.id DESC
)
SELECT latest.business_ref_id, latest.status, latest.finished_at
FROM latest_terminal latest
ORDER BY latest.business_ref_id
`;

export async function readNativeAdOperatorResponseRetryBackoffs(
  input: {
    businessIds: readonly string[];
    asOf: string;
    decisionCutoff: string;
  },
  db: DbClient = getDb(),
) {
  const businessIds = Array.from(
    new Set(
      input.businessIds.map((businessId) => businessId.trim()).filter(Boolean),
    ),
  );
  if (businessIds.length === 0) return new Set<string>();
  const rows = await db.query<OperatorResponseRetryBackoffRow>(
    READ_NATIVE_AD_OPERATOR_RESPONSE_RETRY_BACKOFFS_SQL,
    [
      businessIds,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      AD_OPERATOR_RESPONSE_JOB_NAME,
      input.decisionCutoff,
    ],
  );
  const eligible = new Set(businessIds);
  const cutoffMs = timestampMs(input.decisionCutoff);
  if (cutoffMs === null) return new Set<string>();
  return new Set(
    rows.flatMap((row) => {
      const businessId = String(row.business_ref_id ?? "").trim();
      const finishedAtMs = timestampMs(row.finished_at);
      return businessId &&
        eligible.has(businessId) &&
        row.status === "failed" &&
        finishedAtMs !== null &&
        finishedAtMs > cutoffMs - NATIVE_AD_OPERATOR_RESPONSE_RETRY_COOLDOWN_MS
        ? [businessId]
        : [];
    }),
  );
}

export const READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL = `
WITH latest_terminal AS (
  SELECT DISTINCT ON (run.business_ref_id)
    run.business_ref_id,
    run.status,
    run.started_at,
    run.finished_at,
    run.error_json
  FROM engine_v3_job_runs run
  WHERE run.business_ref_id::text = ANY($1::text[])
    AND run.as_of_date = $2::date
    AND run.engine_version = $3
    AND run.job_name = $4
    AND run.status IN ('success', 'failed')
    AND run.started_at >= $6::timestamptz
    AND run.started_at <= $5::timestamptz
    AND run.finished_at IS NOT NULL
    AND run.finished_at <= $5::timestamptz
  ORDER BY run.business_ref_id, run.finished_at DESC,
           run.started_at DESC, run.id DESC
)
SELECT
  latest.business_ref_id::text AS business_ref_id,
  latest.status,
  latest.started_at,
  latest.finished_at,
  latest.error_json,
  COALESCE(
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'provider_account_ref_id', binding.provider_account_ref_id::text,
        'provider_account_id', binding.provider_account_id,
        'current_source_run_id', source.id::text,
        'current_source_run_hash', source.run_hash,
        'current_source_expected_row_count', source.row_count,
        'latest_ad_evidence_changed_at', evidence.changed_at
      )
      ORDER BY binding.provider_account_ref_id, binding.provider_account_id
    ),
    '[]'::jsonb
  ) AS current_accounts
FROM latest_terminal latest
JOIN business_provider_accounts binding
  ON binding.business_id = latest.business_ref_id::text
 AND binding.provider = 'meta'
 AND binding.is_selected
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.provider = binding.provider
 AND account.external_account_id = binding.provider_account_id
LEFT JOIN LATERAL (
  SELECT run.id, run.run_hash, run.row_count
  FROM meta_entity_observation_runs run
  WHERE run.business_ref_id = latest.business_ref_id
    AND run.business_id = latest.business_ref_id::text
    AND run.provider_account_ref_id = binding.provider_account_ref_id
    AND run.provider_account_id = binding.provider_account_id
    AND run.entity_type = 'ad'
    AND run.completeness = 'complete'
    AND COALESCE(run.last_seen_at, run.observed_at) >= $2::date
    AND COALESCE(run.last_seen_at, run.observed_at) <= $5::timestamptz
    AND COALESCE(run.last_captured_at, run.captured_at) <= $5::timestamptz
    AND (
      run.row_count = 0
      OR run.manifest_kind = 'delta'
      OR EXISTS (
        SELECT 1
        FROM meta_entity_state_history retained_state
        WHERE retained_state.run_id = run.id
          AND retained_state.business_ref_id = run.business_ref_id
          AND retained_state.business_id = run.business_id
          AND retained_state.provider_account_ref_id = run.provider_account_ref_id
          AND retained_state.provider_account_id = run.provider_account_id
          AND retained_state.entity_type = run.entity_type
      )
    )
  ORDER BY COALESCE(run.last_seen_at, run.observed_at) DESC,
           COALESCE(run.last_captured_at, run.captured_at) DESC,
           run.created_at DESC, run.id DESC
  LIMIT 1
) source ON TRUE
LEFT JOIN LATERAL (
  /*
     State rows and tombstones are committed with their owning observation run.
     Heartbeats and forced checkpoints can advance clocks while preserving the
     same truth, so a clock alone is not evidence. Compare semantic_hash only
     with the immediately preceding run in the same endpoint/completeness lane.
     Failed runs carry no state and cannot change the hydrated manifest.
  */
  SELECT MAX(GREATEST(
    candidate.captured_at,
    candidate.created_at
  )) AS changed_at
  FROM meta_entity_observation_runs candidate
  LEFT JOIN LATERAL (
    SELECT previous.semantic_hash
    FROM meta_entity_observation_runs previous
    WHERE previous.business_ref_id = candidate.business_ref_id
      AND previous.business_id = candidate.business_id
      AND previous.provider_account_ref_id = candidate.provider_account_ref_id
      AND previous.provider_account_id = candidate.provider_account_id
      AND previous.entity_type = candidate.entity_type
      AND previous.endpoint = candidate.endpoint
      AND previous.completeness = candidate.completeness
      AND ROW(
        previous.observed_at,
        previous.captured_at,
        previous.created_at,
        previous.id
      ) < ROW(
        candidate.observed_at,
        candidate.captured_at,
        candidate.created_at,
        candidate.id
      )
    ORDER BY previous.observed_at DESC, previous.captured_at DESC,
             previous.created_at DESC, previous.id DESC
    LIMIT 1
  ) previous ON TRUE
  WHERE candidate.business_ref_id = latest.business_ref_id
    AND candidate.business_id = latest.business_ref_id::text
    AND candidate.provider_account_ref_id = binding.provider_account_ref_id
    AND candidate.provider_account_id = binding.provider_account_id
    AND candidate.entity_type = 'ad'
    AND candidate.completeness <> 'failed'
    AND candidate.captured_at <= $5::timestamptz
    AND candidate.created_at <= $5::timestamptz
    AND GREATEST(candidate.captured_at, candidate.created_at)
          > latest.started_at - INTERVAL '1 minute'
    AND (
      candidate.semantic_hash IS NULL
      OR candidate.semantic_hash IS DISTINCT FROM previous.semantic_hash
    )
) evidence ON TRUE
GROUP BY latest.business_ref_id, latest.status, latest.started_at,
         latest.finished_at,
         latest.error_json
ORDER BY latest.business_ref_id
`;

function hydrationReceiptRows(errorJson: unknown): Record<string, unknown>[] {
  if (!isRecord(errorJson) || !isRecord(errorJson.metadata)) return [];
  const receipts = errorJson.metadata.hydration_receipts;
  return Array.isArray(receipts) ? receipts.filter(isRecord) : [];
}

function accountIdentity(input: Record<string, unknown>): string | null {
  const providerAccountRefId = String(
    input.provider_account_ref_id ?? "",
  ).trim();
  const providerAccountId = String(input.provider_account_id ?? "").trim();
  return providerAccountRefId && providerAccountId
    ? `${providerAccountRefId}\u0000${providerAccountId}`
    : null;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function exactBoolean(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function unchangedDecisionSourceFingerprint(input: {
  errorJson: unknown;
  currentAccounts: unknown;
  previousAttemptStartedAt: unknown;
}): boolean {
  if (!Array.isArray(input.currentAccounts)) return false;
  const current = input.currentAccounts.filter(isRecord);
  const receipts = hydrationReceiptRows(input.errorJson);
  if (current.length === 0 || receipts.length !== current.length) return false;
  const previousAttemptStartedAtMs = timestampMs(
    input.previousAttemptStartedAt,
  );
  if (previousAttemptStartedAtMs === null) return false;
  const currentByIdentity = new Map(
    current.flatMap((account) => {
      const identity = accountIdentity(account);
      return identity ? [[identity, account] as const] : [];
    }),
  );
  if (currentByIdentity.size !== current.length) return false;
  const receiptIdentities = new Set<string>();
  let nonAuthoritativeCount = 0;
  for (const receipt of receipts) {
    const identity = accountIdentity(receipt);
    const account = identity ? currentByIdentity.get(identity) : undefined;
    if (!identity || !account || receiptIdentities.has(identity)) return false;
    receiptIdentities.add(identity);
    if (
      receipt.contract_version !==
      AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION
    ) {
      return false;
    }

    // Compare every selected account, including accounts whose prior receipt
    // was authoritative. Otherwise a missing account can hold the business in
    // backoff while a healthy sibling advances from source B1 to B2.
    const previousSourceRunId = nullableText(receipt.source_run_id);
    const currentSourceRunId = nullableText(account.current_source_run_id);
    const previousSourceRunHash = nullableText(receipt.source_run_hash);
    const currentSourceRunHash = nullableText(
      account.current_source_run_hash,
    );
    if (
      previousSourceRunId !== currentSourceRunId ||
      previousSourceRunHash !== currentSourceRunHash
    ) {
      return false;
    }
    if (
      previousSourceRunHash !== null &&
      !/^[a-f0-9]{64}$/.test(previousSourceRunHash)
    ) {
      return false;
    }
    const previousSourceExpectedCount = exactNonNegativeInteger(
      receipt.source_expected_row_count,
    );
    const previousSourcePersistedCount = exactNonNegativeInteger(
      receipt.source_persisted_row_count,
    );
    const currentSourceExpectedCount = exactNonNegativeInteger(
      account.current_source_expected_row_count,
    );
    const sourceComplete = exactBoolean(receipt.source_complete);
    const hydrationComplete = exactBoolean(receipt.hydration_complete);
    if (sourceComplete === null || hydrationComplete === null) return false;
    if (currentSourceRunId === null) {
      if (
        previousSourceRunHash !== null ||
        previousSourceExpectedCount !== null ||
        previousSourcePersistedCount !== null ||
        currentSourceExpectedCount !== null ||
        sourceComplete
      ) {
        return false;
      }
    } else if (
      previousSourceExpectedCount === null ||
      currentSourceExpectedCount !== previousSourceExpectedCount ||
      previousSourcePersistedCount === null ||
      (sourceComplete &&
        previousSourcePersistedCount !== previousSourceExpectedCount)
    ) {
      return false;
    }

    const expectedCount = exactNonNegativeInteger(receipt.expected_ad_count);
    const hydratedCount = exactNonNegativeInteger(receipt.hydrated_ad_count);
    const expectedHash = nullableText(receipt.expected_manifest_hash);
    const hydratedHash = nullableText(receipt.hydrated_manifest_hash);
    if (
      expectedCount === null ||
      hydratedCount === null ||
      !expectedHash ||
      !hydratedHash ||
      !/^[a-f0-9]{64}$/.test(expectedHash) ||
      !/^[a-f0-9]{64}$/.test(hydratedHash)
    ) {
      return false;
    }

    const manifestComplete =
      sourceComplete &&
      expectedCount === hydratedCount &&
      expectedHash === hydratedHash;
    if (hydrationComplete !== manifestComplete) return false;

    const authoritative = exactBoolean(receipt.authoritative_for_prune);
    const reason = nullableText(receipt.reason);
    if (authoritative === null) return false;
    if (authoritative) {
      if (!sourceComplete || !hydrationComplete || reason !== null) return false;
    } else {
      if (reason === null) return false;
      nonAuthoritativeCount += 1;
    }

    // A semantic change in a partial/full/point observation (including a
    // tombstone observation) can alter the manifest without changing the
    // selected complete run. Compare with the attempt's snapshot boundary,
    // not its finish; the safety margin covers a transaction that committed
    // just after the snapshot with an earlier transaction clock.
    const latestEvidenceChangedAtMs = timestampMs(
      account.latest_ad_evidence_changed_at,
    );
    if (
      latestEvidenceChangedAtMs !== null &&
      latestEvidenceChangedAtMs >
        previousAttemptStartedAtMs -
          NATIVE_AD_DECISION_EVIDENCE_COMMIT_SAFETY_MS
    ) {
      return false;
    }
  }
  return (
    receiptIdentities.size === currentByIdentity.size &&
    nonAuthoritativeCount > 0
  );
}

/**
 * Back off only while every selected account still has the exact source
 * fingerprint used by the previous non-authoritative attempt. Any source run,
 * account-set, evidence-clock or fresh-calibration change makes the business
 * eligible on the next cron tick, regardless of the cooldown.
 */
export async function readNativeAdDecisionRetryBackoffs(
  input: {
    businessIds: readonly string[];
    asOf: string;
    decisionCutoff: string;
    since: string;
  },
  db: DbClient = getDb(),
) {
  const businessIds = Array.from(
    new Set(
      input.businessIds.map((businessId) => businessId.trim()).filter(Boolean),
    ),
  );
  if (businessIds.length === 0) return new Set<string>();
  const rows = await db.query<DecisionRetryBackoffRow>(
    READ_NATIVE_AD_DECISION_RETRY_BACKOFFS_SQL,
    [
      businessIds,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      AD_DECISIONS_JOB_NAME,
      input.decisionCutoff,
      input.since,
    ],
  );
  const eligible = new Set(businessIds);
  const cutoffMs = timestampMs(input.decisionCutoff);
  if (cutoffMs === null) return new Set<string>();
  return new Set(
    rows.flatMap((row) => {
      const businessId = String(row.business_ref_id ?? "").trim();
      const finishedAtMs = timestampMs(row.finished_at);
      if (
        !businessId ||
        !eligible.has(businessId) ||
        finishedAtMs === null
      ) {
        return [];
      }
      if (row.status === "failed") {
        return finishedAtMs >
          cutoffMs - NATIVE_AD_DECISION_FAILURE_RETRY_COOLDOWN_MS
          ? [businessId]
          : [];
      }
      return row.status === "success" &&
        unchangedDecisionSourceFingerprint({
          errorJson: row.error_json,
          currentAccounts: row.current_accounts,
          previousAttemptStartedAt: row.started_at,
        })
        ? [businessId]
        : [];
    }),
  );
}

export async function readSuccessfulNativeJobs(
  input: {
    businessIds: readonly string[];
    asOf: string;
    decisionCutoff: string;
    /**
     * The slot window's start. A run that finished before it does not count
     * as this slot's run.
     *
     * Without it the question is "did this job succeed today", and the answer
     * at 15:00 is always yes because 03:00 already ran — so the second slot
     * would report `already_ran` and produce nothing, every day. Omitting it
     * keeps the day-level meaning for every caller that wants it.
     */
    since?: string | null;
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
        AND ($6::timestamptz IS NULL OR started_at >= $6::timestamptz)
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
      input.since ?? null,
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

    /*
      The operator response and the queue projection are SIBLINGS of the
      decisions step, not a chain. Both read what the decisions job wrote and
      neither reads the other, so the short-circuit that used to stand here
      made a failed operator response hide a completed projection — and the
      next tick would re-project a queue that was already filled.

      `ranAfterDependency` against the decisions run is what proves either one
      belongs to THIS slot's decisions rather than an earlier day's.
    */
    const operatorResponse = businessRows.get(AD_OPERATOR_RESPONSE_JOB_NAME);
    if (
      operatorResponse?.status === "success" &&
      jobRunId(operatorResponse) !== null &&
      ranAfterDependency(operatorResponse, decisions)
    ) {
      jobs.add(AD_OPERATOR_RESPONSE_JOB_NAME);
    }

    const projection = businessRows.get(AD_PROPOSAL_PROJECTION_JOB_NAME);
    if (
      projection?.status === "success" &&
      jobRunId(projection) !== null &&
      ranAfterDependency(projection, decisions)
    ) {
      jobs.add(AD_PROPOSAL_PROJECTION_JOB_NAME);
    }
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
  since: string;
}) {
  const jobs = await readSuccessfulNativeJobs({
    businessIds: [input.businessId],
    asOf: input.asOf,
    decisionCutoff: input.decisionCutoff,
    since: input.since,
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
      // The projection reads the decisions table. Without a usable decisions
      // run for this slot there is nothing it could have projected, whatever
      // its own row says.
      jobs.delete(AD_PROPOSAL_PROJECTION_JOB_NAME);
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

function retryBackoffStep<TResult>(): NativeAdScheduledStep<TResult> {
  return {
    status: "skipped",
    source: "retry_backoff",
    result: null,
    reason: "retry_backoff",
    errorMessage: null,
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
  since: string;
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
    since: input.since,
  });
}

export function nativeAdShadowBusinessChainLockKey(input: {
  businessId: string;
  asOf: string;
}): bigint {
  return hashAdvisoryLock(
    `engine_v3_native_ad_shadow_business_chain:${input.businessId}:${input.asOf}`,
  );
}

/**
 * Hold one session-level lock across the complete per-business chain.
 *
 * Each job has its own transaction lock, but those locks end between stages.
 * A delayed overlapping cron can therefore reuse a stale slot snapshot after
 * the first tick finishes and write a second evaluation set. The chain lock
 * closes that gap while still allowing different businesses to progress.
 */
export async function withNativeAdShadowBusinessChainLock<T>(
  input: { businessId: string; asOf: string },
  run: () => Promise<T>,
): Promise<{ acquired: boolean; value: T | null }> {
  const lockKey = nativeAdShadowBusinessChainLockKey(input).toString();
  return withPinnedDbClient(async ({ query }) => {
    const acquiredRows = await query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockKey],
    );
    if (acquiredRows.rows[0]?.acquired !== true) {
      return { acquired: false, value: null };
    }
    try {
      return { acquired: true, value: await run() };
    } finally {
      const releasedRows = await query<{ released: boolean }>(
        "SELECT pg_advisory_unlock($1::bigint) AS released",
        [lockKey],
      );
      if (releasedRows.rows[0]?.released !== true) {
        throw new Error(
          "Native ad scheduler business-chain advisory lock was not released.",
        );
      }
    }
  });
}

/** What the projection's own `engine_v3_job_runs` row is built from. */
export interface ProposalProjectionRunRecord {
  businessId: string;
  asOf: string;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  rowCount: number | null;
  errorMessage: string | null;
  dependencyRunId: string | null;
}

/**
 * The projection's own run row.
 *
 * One terminal row written after the fact: the projection is a single
 * statement with no intermediate state worth a `running` row, and the only
 * question asked of it is whether this slot's queue was filled.
 *
 * A record that cannot be written is left unwritten rather than thrown. The
 * slot then stays outstanding and the next tick projects again, which the
 * insert's `ON CONFLICT ... WHERE status = 'pending'` makes safe; failing the
 * whole chain over its own bookkeeping would be the worse of the two.
 */
async function recordNativeProposalProjectionRun(
  input: ProposalProjectionRunRecord,
) {
  const startedMs = Date.parse(input.startedAt);
  const finishedMs = Date.parse(input.finishedAt);
  await getDb().query(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, dependency_run_id, started_at, finished_at, duration_ms,
      row_count, error_message
    ) VALUES (
      $1, $2::uuid, $3, $4::date, $5,
      $6, $7::uuid, $8::timestamptz, $9::timestamptz, $10,
      $11, $12
    )
    `,
    [
      AD_PROPOSAL_PROJECTION_JOB_NAME,
      input.businessId,
      input.businessId,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      input.status,
      input.dependencyRunId,
      input.startedAt,
      input.finishedAt,
      Number.isFinite(startedMs) && Number.isFinite(finishedMs)
        ? Math.max(0, finishedMs - startedMs)
        : null,
      input.rowCount,
      input.errorMessage,
    ],
  );
}

async function runProposalProjection(input: {
  business: ScheduledBusiness;
  asOf: string;
  dependencyRunId: string | null;
  options: NativeAdShadowScheduleOptions;
}): Promise<NativeAdScheduledStep<ProposalProjectionResult>> {
  const startedAt = new Date().toISOString();
  let outcome: Awaited<ReturnType<typeof projectNativeAdProposals>> | null =
    null;
  let thrown: string | null = null;
  try {
    outcome = await (
      input.options.projectProposals ?? projectNativeAdProposals
    )({
      businessId: input.business.id,
      snapshotDate: input.asOf,
    });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  /*
    Three outcomes, and the middle one is the reason this record exists.

    A completed projection is `success`. Manual standing mode is `skipped`:
    nothing was projected and nothing should have been, but a family flipped to
    semi-automatic later in the same slot must still fill the queue, so the
    name must not enter this slot's successful set. Everything else — a throw,
    an absent schema, an unreadable standing mode — is `failed`, which is what
    keeps the slot outstanding until the queue actually has the decisions.
  */
  const status: ProposalProjectionRunRecord["status"] =
    outcome === null
      ? "failed"
      : outcome.withheld === null && outcome.ran
        ? "success"
        : outcome.withheld === "standing_mode_manual"
          ? "skipped"
          : "failed";
  const errorMessage =
    status === "success"
      ? null
      : (thrown ?? outcome?.withheld ?? "projection_not_ran");
  const record: ProposalProjectionRunRecord = {
    businessId: input.business.id,
    asOf: input.asOf,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    rowCount: outcome?.projected ?? null,
    errorMessage,
    dependencyRunId: input.dependencyRunId,
  };
  try {
    await (
      input.options.recordProjectionRun ?? recordNativeProposalProjectionRun
    )(record);
  } catch (error) {
    console.warn("[native-ad-shadow] proposal_projection_run_unrecorded", {
      businessId: input.business.id,
      asOf: input.asOf,
      status,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    status,
    source: "ran",
    result:
      status === "success" && outcome
        ? { projected: outcome.projected }
        : null,
    reason: errorMessage,
    errorMessage,
  };
}

async function runBusinessChain(input: {
  business: ScheduledBusiness;
  asOf: string;
  /** Fresh boundary captured after this business's chain lock is acquired. */
  dependencyCutoff: string;
  /** Stable tick boundary used by operator-response snapshot semantics. */
  operatorResponseCutoff: string;
  slotStart: string;
  previousSuccesses: Set<NativeAdShadowJobName>;
  decisionRetryBackoff: boolean;
  operatorResponseRetryBackoff: boolean;
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
    decisionCutoff: input.dependencyCutoff,
    since: input.slotStart,
    jobName: AD_CALIBRATION_JOB_NAME,
    hasSuccessfulJob,
  });
  // The retry snapshot is read before the per-business chain starts. A fresh
  // calibration completed by this same tick is newer dependency evidence than
  // that snapshot, so it must make decisions eligible immediately. Otherwise
  // a metrics/config change that correctly invalidated calibration could still
  // be hidden for the old decision attempt's cooldown window.
  const calibrationRefreshed =
    calibration.status === "success" && calibration.source === "ran";
  const decisions = !calibrationSatisfied
    ? dependencyBlockedStep<AdDecisionsJobResult>(
        "upstream_native_calibration_not_success",
      )
    : input.previousSuccesses.has(AD_DECISIONS_JOB_NAME)
      ? previousSuccessStep<AdDecisionsJobResult>()
      : input.decisionRetryBackoff && !calibrationRefreshed
        ? retryBackoffStep<AdDecisionsJobResult>()
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
    decisionCutoff: input.dependencyCutoff,
    since: input.slotStart,
    jobName: AD_DECISIONS_JOB_NAME,
    hasSuccessfulJob,
  });
  const operatorResponse = !decisionsSatisfied
    ? dependencyBlockedStep<AdOperatorResponseJobResult>(
        "upstream_native_decisions_not_success",
      )
    : input.previousSuccesses.has(AD_OPERATOR_RESPONSE_JOB_NAME)
      ? previousSuccessStep<AdOperatorResponseJobResult>()
      : input.operatorResponseRetryBackoff
        ? retryBackoffStep<AdOperatorResponseJobResult>()
        : await (input.options.runOperatorResponse ?? runAdOperatorResponseJob)(
            {
              businessId: input.business.id,
              cutoff: input.operatorResponseCutoff,
              engineVersion: NATIVE_AD_ENGINE_VERSION,
            },
          ).then(
            ranStep<AdOperatorResponseJobResult>,
            failedStep<AdOperatorResponseJobResult>,
          );

  /*
    The queue projection, once THIS slot's decisions exist.

    The predicate was `decisions.status === "success"`, which is true only on
    the tick that RAN the decisions job. Every later tick of the same slot
    reports `previous_success`, so a projection that threw was never attempted
    again and the native cuts sat durable and unqueued until the next day.
    `previous_success` means the rows this projection reads are already there,
    which is exactly when it should run.

    A failed decisions step still blocks it: projecting then would queue the
    previous slot's rows, which is the ordering defect this call was moved
    here to fix.
  */
  const decisionsPublished =
    decisions.status === "success" || decisions.status === "previous_success";
  const proposalProjection = !decisionsPublished
    ? dependencyBlockedStep<ProposalProjectionResult>(
        "upstream_native_decisions_not_published",
      )
    : input.previousSuccesses.has(AD_PROPOSAL_PROJECTION_JOB_NAME)
      ? previousSuccessStep<ProposalProjectionResult>()
      : await runProposalProjection({
          business: input.business,
          asOf: input.asOf,
          dependencyRunId: decisions.result?.jobRunId ?? null,
          options: input.options,
        });

  return {
    businessId: input.business.id,
    businessName: input.business.name,
    calibration,
    decisions,
    operatorResponse,
    proposalProjection,
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
  const slotStart = nativeAdShadowSlotStart(now);
  if (slotStart === null) {
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

  /*
    Completion is asked about THIS slot, and the same window goes to all three
    jobs from one place so calibration, decisions and operator-response cannot
    disagree about which slot they are in. `closeNativeJobDependencies` keeps
    its own semantics: it still closes dependencies by name within the day.
  */
  const successes = closeNativeJobDependencies(
    await (options.readSuccessfulJobs ?? readSuccessfulNativeJobs)({
      businessIds: businesses.map((business) => business.id),
      asOf,
      decisionCutoff: now.toISOString(),
      since: slotStart.toISOString(),
    }),
  );
  const allComplete = businesses.every((business) => {
    const jobs = successes.get(business.id);
    return NATIVE_AD_SHADOW_JOB_NAMES.every((jobName) => jobs?.has(jobName));
  });
  if (allComplete) {
    return { ...base, skipped: true, reason: "already_ran" };
  }

  const retryBackoffReadFailures = new Set<"decision" | "operator_response">();
  const concurrentBusinessIds: string[] = [];
  const results: NativeAdShadowBusinessResult[] = [];
  for (const business of businesses) {
    let locked: {
      acquired: boolean;
      value: NativeAdShadowBusinessResult | null;
    };
    try {
      locked = await (
        options.withBusinessChainLock ?? withNativeAdShadowBusinessChainLock
      )({ businessId: business.id, asOf }, async () => {
      /* Re-read only after owning the chain. A tick may have waited while an
         earlier tick completed this business, so the batch snapshot above is
         no longer sufficient evidence that any stage is outstanding. The
         cutoff must be taken here too: a tick can wait minutes for this lock,
         and its original `now` would hide the holder's newly committed runs. */
      const chainCutoff = (options.clock?.() ?? new Date()).toISOString();
      const freshSuccesses = closeNativeJobDependencies(
        await (options.readSuccessfulJobs ?? readSuccessfulNativeJobs)({
          businessIds: [business.id],
          asOf,
          decisionCutoff: chainCutoff,
          since: slotStart.toISOString(),
        }),
      );
      const retryInput = {
        businessIds: [business.id],
        asOf,
        decisionCutoff: chainCutoff,
      };
      const [operatorResponseRetryRead, decisionRetryRead] =
        await Promise.allSettled([
          (
            options.readOperatorResponseRetryBackoffs ??
            readNativeAdOperatorResponseRetryBackoffs
          )(retryInput),
          (
            options.readDecisionRetryBackoffs ??
            readNativeAdDecisionRetryBackoffs
          )({ ...retryInput, since: slotStart.toISOString() }),
        ]);
      if (decisionRetryRead.status === "rejected") {
        retryBackoffReadFailures.add("decision");
      }
      if (operatorResponseRetryRead.status === "rejected") {
        retryBackoffReadFailures.add("operator_response");
      }
      // A retry-reader failure is an optimization failure, never authority to
      // reuse old work. The safe posture is to run and prove the stage.
      const decisionRetryBackoffs =
        decisionRetryRead.status === "fulfilled"
          ? decisionRetryRead.value
          : new Set<string>();
      const operatorResponseRetryBackoffs =
        operatorResponseRetryRead.status === "fulfilled"
          ? operatorResponseRetryRead.value
          : new Set<string>();
        return runBusinessChain({
          business,
          asOf,
          dependencyCutoff: chainCutoff,
          operatorResponseCutoff: now.toISOString(),
          slotStart: slotStart.toISOString(),
          previousSuccesses:
            freshSuccesses.get(business.id) ?? new Set<NativeAdShadowJobName>(),
          decisionRetryBackoff: decisionRetryBackoffs.has(business.id),
          operatorResponseRetryBackoff: operatorResponseRetryBackoffs.has(
            business.id,
          ),
          options,
        });
      });
    } catch (error) {
      /* One account read or one session cleanup failure must not discard the
         already-completed businesses or prevent later businesses from being
         refreshed. The failed business remains fail-closed for this sweep. */
      results.push({
        businessId: business.id,
        businessName: business.name,
        calibration: failedStep<AdCalibrationJobResult>(error),
        decisions: failedStep<AdDecisionsJobResult>(error),
        operatorResponse: failedStep<AdOperatorResponseJobResult>(error),
        proposalProjection: failedStep<ProposalProjectionResult>(error),
      });
      continue;
    }
    if (!locked.acquired || locked.value === null) {
      concurrentBusinessIds.push(business.id);
      const inProgress = "business_chain_in_progress";
      results.push({
        businessId: business.id,
        businessName: business.name,
        calibration: dependencyBlockedStep<AdCalibrationJobResult>(inProgress),
        decisions: dependencyBlockedStep<AdDecisionsJobResult>(inProgress),
        operatorResponse:
          dependencyBlockedStep<AdOperatorResponseJobResult>(inProgress),
        proposalProjection:
          dependencyBlockedStep<ProposalProjectionResult>(inProgress),
      });
      continue;
    }
    results.push(locked.value);
  }
  return {
    ...base,
    skipped: false,
    ...(retryBackoffReadFailures.size > 0
      ? { retryBackoffReadFailures: [...retryBackoffReadFailures].sort() }
      : {}),
    ...(concurrentBusinessIds.length > 0 ? { concurrentBusinessIds } : {}),
    results,
  };
}
