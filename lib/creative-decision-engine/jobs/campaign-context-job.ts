// Automatic Campaign Context producer job (D033).
//
// Computes the daily inferred campaign role (main/test/mixed) per campaign and
// persists it into engine_v3_campaign_context_daily. Decisions consume this
// table as the sole runtime campaign-role source. CAMPAIGN_CONTEXT_MODE=unknown
// is the only emergency fallback and makes every role review-only.
import { getDb, runDbTransaction } from "@/lib/db";
import { ENGINE_VERSION } from "../types";
import { resolveEngineV3Flags } from "../feature-flags";
import { getBusinessGuardFailure } from "./business-guard";
import { hashAdvisoryLock } from "./calibration-job";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";
import {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  campaignFamilyKey,
  classifyCampaignContext,
  computeFamilyInheritance,
  DEFAULT_CONTEXT_CONFIG,
  type CampaignKind,
  type ContextConfidenceClass,
  type ContextResolution,
} from "../campaign-context/resolver";
import {
  addDaysUtc,
  buildCampaignContextFeatures,
  computeCampaignLineage,
  readCampaignContextCampaignMeta,
  readCampaignContextCreativeDays,
} from "../campaign-context/data";

export const JOB_NAME = "engine_v3_campaign_context_job";

// Lineage/feature source window: two feature windows of history bound the
// query cost while covering new-creative detection and visible reuse.
const SOURCE_WINDOW_DAYS = 56;
const HYSTERESIS_CONFIRM_DAYS = 2;
// Evidence-dip grace: a campaign whose kind was stable but whose resolution
// drops to null via insufficient evidence (floors dip - weekends, spend
// pauses, family evidence-floor oscillation) keeps its stable kind for up to
// this many consecutive days, published at reduced confidence. Conflicts
// never get grace; after grace exhausts, stable state clears so a stale kind
// cannot resume weeks later without re-confirmation.
const EVIDENCE_DIP_GRACE_DAYS = 3;

export interface CampaignContextJobInput {
  businessId: string;
  asOf: string;
}

export interface CampaignContextJobResult {
  jobRunId: string;
  status: "success" | "failed" | "skipped";
  rowsWritten: number;
  durationMs: number;
  reason?: "engine_v3_disabled" | "business_not_found" | "invalid_business_id";
  errorMessage?: string;
}

export interface HysteresisState {
  stableKind: CampaignKind | null;
  stableClass?: ContextConfidenceClass | null;
  pendingKind: CampaignKind | null;
  pendingCount: number;
  graceDaysUsed?: number;
  pendingConflictCount?: number;
}

export interface DailyHysteresisOutcome {
  publishedKind: CampaignKind | null;
  publishedClass: ContextConfidenceClass;
  state: HysteresisState;
  suppressedFlip: boolean;
}

/**
 * Daily hysteresis: a kind change publishes only after
 * HYSTERESIS_CONFIRM_DAYS consecutive evaluations agree. Until confirmed, the
 * previous stable kind is published with confidence capped at medium.
 * Null resolutions (unknown/conflict) publish as-is without advancing the
 * pending counter.
 */
export function applyDailyHysteresis(
  previous: HysteresisState | null,
  resolvedKind: CampaignKind | null,
  resolvedClass: ContextConfidenceClass,
): DailyHysteresisOutcome {
  const state: HysteresisState = {
    stableKind: previous?.stableKind ?? null,
    stableClass: previous?.stableClass ?? null,
    pendingKind: previous?.pendingKind ?? null,
    pendingCount: previous?.pendingCount ?? 0,
    graceDaysUsed: previous?.graceDaysUsed ?? 0,
    pendingConflictCount: previous?.pendingConflictCount ?? 0,
  };

  if (resolvedKind === null) {
    if (resolvedClass === "conflict") {
      // Conflicts obey the same two-evaluation rule as kind changes: a
      // single-day naming-vs-behavior blip is absorbed (stable kind held at
      // reduced class); a conflict that persists a second evaluation
      // surfaces and clears stable state - persistent conflicts remain
      // operator-resolution material from day 2 onward.
      const pendingConflictCount = (state.pendingConflictCount ?? 0) + 1;
      if (
        state.stableKind !== null &&
        pendingConflictCount < HYSTERESIS_CONFIRM_DAYS
      ) {
        state.pendingConflictCount = pendingConflictCount;
        const heldClass: ContextConfidenceClass =
          state.stableClass === "high"
            ? "medium"
            : (state.stableClass ?? "low");
        return {
          publishedKind: state.stableKind,
          publishedClass: heldClass,
          state,
          suppressedFlip: true,
        };
      }
      state.stableKind = null;
      state.stableClass = null;
      state.pendingKind = null;
      state.pendingCount = 0;
      state.pendingConflictCount = 0;
      return {
        publishedKind: null,
        publishedClass: resolvedClass,
        state,
        suppressedFlip: false,
      };
    }
    state.pendingConflictCount = 0;
    if (
      state.stableKind !== null &&
      (state.graceDaysUsed ?? 0) < EVIDENCE_DIP_GRACE_DAYS
    ) {
      state.graceDaysUsed = (state.graceDaysUsed ?? 0) + 1;
      const heldClass: ContextConfidenceClass =
        state.stableClass === "high"
          ? "medium"
          : (state.stableClass ?? "low");
      return {
        publishedKind: state.stableKind,
        publishedClass: heldClass,
        state,
        suppressedFlip: true,
      };
    }
    // Grace exhausted or never-classified: publish null and clear stable
    // state so a stale kind cannot silently resume later.
    state.stableKind = null;
    state.stableClass = null;
    state.pendingKind = null;
    state.pendingCount = 0;
    return {
      publishedKind: null,
      publishedClass: resolvedClass,
      state,
      suppressedFlip: false,
    };
  }

  state.graceDaysUsed = 0;
  state.pendingConflictCount = 0;

  if (state.stableKind === null || state.stableKind === resolvedKind) {
    state.stableKind = resolvedKind;
    state.stableClass = resolvedClass;
    state.pendingKind = null;
    state.pendingCount = 0;
    return {
      publishedKind: resolvedKind,
      publishedClass: resolvedClass,
      state,
      suppressedFlip: false,
    };
  }

  const pendingCount =
    state.pendingKind === resolvedKind ? state.pendingCount + 1 : 1;
  if (pendingCount >= HYSTERESIS_CONFIRM_DAYS) {
    state.stableKind = resolvedKind;
    state.stableClass = resolvedClass;
    state.pendingKind = null;
    state.pendingCount = 0;
    return {
      publishedKind: resolvedKind,
      publishedClass: resolvedClass,
      state,
      suppressedFlip: false,
    };
  }

  state.pendingKind = resolvedKind;
  state.pendingCount = pendingCount;
  const cappedClass: ContextConfidenceClass =
    resolvedClass === "high" ? "medium" : resolvedClass;
  return {
    publishedKind: state.stableKind,
    publishedClass: cappedClass,
    state,
    suppressedFlip: true,
  };
}

type Row = Record<string, unknown>;

interface AdvisoryLockRow extends Row {
  acquired: unknown;
}

interface JobRunIdRow extends Row {
  id: unknown;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  return null;
}

async function insertJobRun(input: {
  businessId: string;
  asOf: string;
  status: CampaignContextJobResult["status"] | "running";
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
  errorJson?: unknown;
}) {
  const [row] = await getDb().query<JobRunIdRow>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, finished_at, duration_ms, row_count, error_message, error_json
    )
    VALUES (
      $1, $2::uuid, $3, $4::date, $5,
      $6, CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $7::integer, $8::integer, $9, $10::jsonb
    )
    RETURNING id
    `,
    [
      JOB_NAME,
      input.businessId,
      input.businessId,
      input.asOf,
      ENGINE_VERSION,
      input.status,
      input.durationMs ?? null,
      input.rowCount ?? null,
      input.errorMessage ?? null,
      input.errorJson === undefined ? null : JSON.stringify(input.errorJson),
    ],
  );

  const id = toStringOrNull(row?.id);
  if (id === null) {
    throw new Error("Campaign context job run insert did not return an id.");
  }
  return id;
}

async function readPreviousHysteresis(
  businessId: string,
  asOf: string,
): Promise<Map<string, HysteresisState>> {
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT ON (provider_account_id, campaign_id)
      provider_account_id,
      campaign_id,
      hysteresis_state_json
    FROM engine_v3_campaign_context_daily
    WHERE business_id = $1 AND as_of_date < $2::date
      AND provider_account_id IS NOT NULL
      AND as_of_date >= ($2::date - INTERVAL '7 days')
    ORDER BY provider_account_id, campaign_id, as_of_date DESC
    `,
    [businessId, asOf],
  );
  const map = new Map<string, HysteresisState>();
  for (const row of rows) {
    const providerAccountId = toStringOrNull(row.provider_account_id);
    const campaignId = toStringOrNull(row.campaign_id);
    if (!providerAccountId || !campaignId) continue;
    map.set(
      contextScopeKey(providerAccountId, campaignId),
      parseHysteresisState(row.hysteresis_state_json),
    );
  }
  return map;
}

function contextScopeKey(providerAccountId: string, campaignId: string) {
  return `${providerAccountId}\u0000${campaignId}`;
}

/**
 * Full round-trip of the persisted hysteresis state. Every field of
 * HysteresisState MUST be parsed here: dropping a field silently resets its
 * counter each day (the evidence-dip grace and conflict-confirmation rules
 * were dead in production until this seam was covered by the round-trip
 * test). Old rows without the newer fields default safely.
 */
export function parseHysteresisState(raw: unknown): HysteresisState {
  const parsed =
    raw && typeof raw === "object" ? (raw as Partial<HysteresisState>) : {};
  return {
    stableKind: (parsed.stableKind as CampaignKind | null) ?? null,
    stableClass:
      (parsed.stableClass as HysteresisState["stableClass"]) ?? null,
    pendingKind: (parsed.pendingKind as CampaignKind | null) ?? null,
    pendingCount:
      typeof parsed.pendingCount === "number" ? parsed.pendingCount : 0,
    graceDaysUsed:
      typeof parsed.graceDaysUsed === "number" ? parsed.graceDaysUsed : 0,
    pendingConflictCount:
      typeof parsed.pendingConflictCount === "number"
        ? parsed.pendingConflictCount
        : 0,
  };
}

// Exported for the ephemeral-postgres seam check (see decisions-job's
// UPSERT export note): the hysteresis_state_json write->read round trip is
// exactly the seam that silently broke once.
export const UPSERT_CONTEXT_QUERY = `
INSERT INTO engine_v3_campaign_context_daily (
  business_id, provider_account_id, campaign_id, campaign_name, as_of_date,
  inferred_kind, confidence_score, confidence_class, kind_source, kind_basis,
  resolver_version, signal_scores_json, evidence_json, conflict_reasons_json,
  hysteresis_state_json, input_freshness_json, job_run_id, updated_at
)
VALUES (
  $1, $2, $3, $4, $5::date,
  $6, $7, $8, 'system_inferred', $9,
  $10, $11::jsonb, $12::jsonb, $13::jsonb,
  $14::jsonb, $15::jsonb, $16::uuid, now()
)
/*
  PRE-DEPLOY AUDIT: the conflict target is the LEGACY three-column key, which
  the migration now keeps rather than drops.

  A partial index cannot be inferred from a bare conflict target, so targeting
  the account-scoped partial index made this statement the only one that could
  run — the previous production image, upserting on the three-column key,
  failed with 42P10 after the migration. Both images now infer the same
  constraint. provider_account_id is written on the UPDATE path as well, so a
  legacy row for the same day is completed rather than left account-less.
*/
ON CONFLICT (business_id, campaign_id, as_of_date)
DO UPDATE SET
  provider_account_id = EXCLUDED.provider_account_id,
  campaign_name = EXCLUDED.campaign_name,
  inferred_kind = EXCLUDED.inferred_kind,
  confidence_score = EXCLUDED.confidence_score,
  confidence_class = EXCLUDED.confidence_class,
  kind_source = EXCLUDED.kind_source,
  kind_basis = EXCLUDED.kind_basis,
  resolver_version = EXCLUDED.resolver_version,
  signal_scores_json = EXCLUDED.signal_scores_json,
  evidence_json = EXCLUDED.evidence_json,
  conflict_reasons_json = EXCLUDED.conflict_reasons_json,
  hysteresis_state_json = EXCLUDED.hysteresis_state_json,
  input_freshness_json = EXCLUDED.input_freshness_json,
  job_run_id = EXCLUDED.job_run_id,
  updated_at = now()
`;

export async function runCampaignContextJob(
  input: CampaignContextJobInput,
): Promise<CampaignContextJobResult> {
  const startedAt = Date.now();
  const businessGuardFailure = await getBusinessGuardFailure(input.businessId);
  if (businessGuardFailure?.reason === "invalid_business_id") {
    return {
      jobRunId: "",
      status: "failed",
      rowsWritten: 0,
      durationMs: Date.now() - startedAt,
      reason: "invalid_business_id",
      errorMessage: businessGuardFailure.message,
    };
  }
  if (businessGuardFailure) {
    const durationMs = Date.now() - startedAt;
    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "failed",
      durationMs,
      rowCount: 0,
      errorMessage: businessGuardFailure.message,
      errorJson: businessGuardFailure.errorJson,
    });
    return {
      jobRunId,
      status: "failed",
      rowsWritten: 0,
      durationMs,
      reason: "business_not_found",
      errorMessage: businessGuardFailure.message,
    };
  }

  const flags = await resolveEngineV3Flags(input.businessId);
  if (!flags.enabled) {
    const durationMs = Date.now() - startedAt;
    const jobRunId = await insertJobRun({
      businessId: input.businessId,
      asOf: input.asOf,
      status: "skipped",
      durationMs,
      rowCount: 0,
      errorMessage: "engine_v3_disabled",
      errorJson: { name: "engine_v3_disabled", businessId: input.businessId },
    });
    return {
      jobRunId,
      status: "skipped",
      rowsWritten: 0,
      durationMs,
      reason: "engine_v3_disabled",
    };
  }

  const lockKey = hashAdvisoryLock(
    `${JOB_NAME}:${input.businessId}:${input.asOf}`,
  );

  return runDbTransaction(
    async () => {
      const db = getDb();
      const [lockRow] = await db.query<AdvisoryLockRow>(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
        [lockKey.toString()],
      );
      if (lockRow?.acquired !== true) {
        const durationMs = Date.now() - startedAt;
        const jobRunId = await insertJobRun({
          businessId: input.businessId,
          asOf: input.asOf,
          status: "skipped",
          durationMs,
          rowCount: 0,
          errorMessage:
            "Advisory lock not acquired (job may already be running)",
        });
        return {
          jobRunId,
          status: "skipped" as const,
          rowsWritten: 0,
          durationMs,
          errorMessage:
            "Advisory lock not acquired (job may already be running)",
        };
      }

      const jobRunId = await insertJobRun({
        businessId: input.businessId,
        asOf: input.asOf,
        status: "running",
      });

      await db.query("SAVEPOINT engine_v3_campaign_context_job_work");
      try {
        const rangeStart = addDaysUtc(input.asOf, -(SOURCE_WINDOW_DAYS - 1));
        const [creativeDays, previousStates] = await Promise.all([
          readCampaignContextCreativeDays(
            input.businessId,
            rangeStart,
            input.asOf,
          ),
          readPreviousHysteresis(input.businessId, input.asOf),
        ]);
        const providerAccountIds = [
          ...new Set(
            creativeDays
              .map((row) => row.providerAccountId?.trim() ?? "")
              .filter(Boolean),
          ),
        ].sort();

        let rowsWritten = 0;
        for (const providerAccountId of providerAccountIds) {
          const accountCreativeDays = creativeDays.filter(
            (row) => row.providerAccountId === providerAccountId,
          );
          const meta = await readCampaignContextCampaignMeta(
            input.businessId,
            input.asOf,
            providerAccountId,
          );
          const lineage = computeCampaignLineage(accountCreativeDays);
          const features = buildCampaignContextFeatures({
            rows: accountCreativeDays,
            meta,
            lineage,
            asOf: input.asOf,
          });

          const resolutions = new Map<string, ContextResolution>();
          for (const feature of features) {
            resolutions.set(
              feature.campaignId,
              classifyCampaignContext(feature, DEFAULT_CONTEXT_CONFIG),
            );
          }
          const inheritance = computeFamilyInheritance(
            [...resolutions.values()].map((resolution) => ({
              campaignId: resolution.campaignId,
              familyKey: campaignFamilyKey(resolution.campaignName),
              kind: resolution.kind,
              confidenceClass: resolution.confidenceClass,
            })),
          );
          const inheritedById = new Map(
            inheritance.map((outcome) => [outcome.campaignId, outcome]),
          );

          for (const feature of features) {
            const resolution = resolutions.get(feature.campaignId)!;
            const inherited = inheritedById.get(feature.campaignId) ?? null;
            const effectiveKind = inherited
              ? inherited.inheritedKind
              : resolution.kind;
            const effectiveClass: ContextConfidenceClass = inherited
              ? "medium"
              : resolution.confidenceClass;
            const kindBasis = inherited ? "family_inheritance" : "behavioral";
            const evidence = inherited
              ? [
                  ...resolution.evidence,
                  `family_prefix_inheritance basis=${inherited.basisMembers} members`,
                ]
              : resolution.evidence;

            const hysteresis = applyDailyHysteresis(
              previousStates.get(
                contextScopeKey(providerAccountId, feature.campaignId),
              ) ?? null,
              effectiveKind,
              effectiveClass,
            );

            await db.query(UPSERT_CONTEXT_QUERY, [
              input.businessId,
              providerAccountId,
              feature.campaignId,
              feature.campaignName,
              input.asOf,
              hysteresis.publishedKind,
              resolution.confidenceScore,
              hysteresis.publishedClass,
              kindBasis,
              CAMPAIGN_CONTEXT_RESOLVER_VERSION,
              JSON.stringify({
                testScore: resolution.testScore,
                mainScore: resolution.mainScore,
                mixedScore: resolution.mixedScore,
                agreeingFamilies: resolution.agreeingFamilies,
              }),
              JSON.stringify(evidence),
              JSON.stringify(resolution.conflictReasons),
              JSON.stringify(hysteresis.state),
              JSON.stringify({
                sourceWindowStart: rangeStart,
                sourceWindowEnd: input.asOf,
                providerAccountId,
                creativeDayRows: accountCreativeDays.length,
                suppressedFlip: hysteresis.suppressedFlip,
              }),
              jobRunId,
            ]);
            rowsWritten += 1;
          }
        }

        const durationMs = Date.now() - startedAt;
        await db.query(
          `
          UPDATE engine_v3_job_runs
          SET status = 'success', finished_at = now(), duration_ms = $1::integer,
              row_count = $2::integer, updated_at = now()
          WHERE id = $3::uuid
          `,
          [durationMs, rowsWritten, jobRunId],
        );
        return {
          jobRunId,
          status: "success" as const,
          rowsWritten,
          durationMs,
        };
      } catch (error) {
        await db
          .query("ROLLBACK TO SAVEPOINT engine_v3_campaign_context_job_work")
          .catch(() => {});
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        await db.query(
          `
          UPDATE engine_v3_job_runs
          SET status = 'failed', finished_at = now(), duration_ms = $1::integer,
              row_count = 0, error_message = $2, error_json = $3::jsonb,
              updated_at = now()
          WHERE id = $4::uuid
          `,
          [
            durationMs,
            message,
            JSON.stringify({
              name: error instanceof Error ? error.name : "Error",
              message,
            }),
            jobRunId,
          ],
        );
        return {
          jobRunId,
          status: "failed" as const,
          rowsWritten: 0,
          durationMs,
          errorMessage: message,
        };
      }
    },
    { timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS },
  );
}
