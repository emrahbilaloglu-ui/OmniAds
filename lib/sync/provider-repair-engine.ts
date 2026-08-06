import {
  enqueueGoogleAdsScheduledWork,
  refreshGoogleAdsSyncStateForBusiness,
  syncGoogleAdsRange,
} from "@/lib/sync/google-ads-sync";
import {
  enqueueMetaScheduledWork,
  recoverMetaD1FinalizePartitions,
  refreshMetaSyncStateForBusiness,
  syncMetaRepairRange,
} from "@/lib/sync/meta-sync";
import * as metaWarehouse from "@/lib/meta/warehouse";
import * as googleAdsWarehouse from "@/lib/google-ads/warehouse";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
  type GoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { getProviderQuotaBudgetState } from "@/lib/provider-request-governance";
import {
  getProviderPlatformDateBoundaries,
  getProviderPlatformPreviousDate,
} from "@/lib/provider-platform-date";
import {
  buildBlockingReason,
  buildRepairableAction,
  compactBlockingReasons,
  compactRepairableActions,
  type ProviderAutoHealResult,
} from "@/lib/sync/provider-status-truth";
import { validateMetaLiveAccountAccess } from "@/lib/sync/meta-live-auth";
import { logRuntimeInfo, logRuntimeWarn } from "@/lib/runtime-logging";
import type { MetaDeadLetterRecoveryKind } from "@/lib/sync/meta-error-classification";
import type { GoogleAdsDeadLetterRecoveryKind } from "@/lib/sync/google-ads-error-classification";

export interface ProviderRepairCycleOptions {
  enqueueScheduledWork?: boolean;
  metaDeadLetterSources?: string[] | null;
  metaDeadLetterRecoveryKinds?: MetaDeadLetterRecoveryKind[] | null;
  googleDeadLetterRecoveryKinds?: GoogleAdsDeadLetterRecoveryKind[] | null;
  queueWarehouseRepairs?: boolean;
}

type MetaRepairStageName =
  | "runMetaRepairCycle.cleanup"
  | "runMetaRepairCycle.quarantine_terminal_action_required"
  | "runMetaRepairCycle.replay_dead_letters"
  | "runMetaRepairCycle.replay_stale_action_required_dead_letters"
  | "runMetaRepairCycle.replay_superseded_dead_letters"
  | "runMetaRepairCycle.requeue_retryable_failed"
  | "runMetaRepairCycle.recover_d1_finalize"
  | "runMetaRepairCycle.integrity_incidents"
  | "runMetaRepairCycle.queue_integrity_repairs"
  | "runMetaRepairCycle.refresh_state"
  | "runMetaRepairCycle.reconcile_recent_authoritative_window";

type MetaRepairStageRecord = {
  stage: MetaRepairStageName;
  durationMs: number;
  ok: boolean;
  errorMessage: string | null;
};

type MetaRepairStageTaggedError = Error & {
  metaRepairStage?: MetaRepairStageName;
};

function tagMetaRepairStageError(
  error: unknown,
  stage: MetaRepairStageName,
) {
  if (error instanceof Error && !(error as MetaRepairStageTaggedError).metaRepairStage) {
    (error as MetaRepairStageTaggedError).metaRepairStage = stage;
  }
  return error;
}

function buildMetaRepairStagePayload(input: {
  businessId: string;
  stage: MetaRepairStageName;
  durationMs: number;
  ok: boolean;
  errorMessage?: string | null;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: null,
    partitionId: null,
    scope: null,
    lane: null,
    source: null,
    day: null,
    durationMs: input.durationMs,
    stage: input.stage,
    ok: input.ok,
    errorMessage: input.errorMessage ?? null,
  };
}

async function captureMetaRepairStage<T>(input: {
  businessId: string;
  stage: MetaRepairStageName;
  stageRecords: MetaRepairStageRecord[];
  run: () => Promise<T>;
  onError?: (error: unknown) => Promise<T> | T;
}) {
  const startedAt = Date.now();
  try {
    const result = await input.run();
    const durationMs = Date.now() - startedAt;
    input.stageRecords.push({
      stage: input.stage,
      durationMs,
      ok: true,
      errorMessage: null,
    });
    logRuntimeInfo("meta-repair", "stage", buildMetaRepairStagePayload({
      businessId: input.businessId,
      stage: input.stage,
      durationMs,
      ok: true,
    }));
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const taggedError = tagMetaRepairStageError(error, input.stage);
    const errorMessage = taggedError instanceof Error ? taggedError.message : String(taggedError);
    input.stageRecords.push({
      stage: input.stage,
      durationMs,
      ok: false,
      errorMessage,
    });
    logRuntimeWarn("meta-repair", "stage_failed", buildMetaRepairStagePayload({
      businessId: input.businessId,
      stage: input.stage,
      durationMs,
      ok: false,
      errorMessage,
    }));
    if (input.onError) {
      return input.onError(taggedError);
    }
    throw taggedError;
  }
}

function buildContiguousDateRanges(dates: string[]) {
  const normalized = Array.from(new Set(dates)).sort();
  if (normalized.length === 0) return [] as Array<{ startDate: string; endDate: string }>;
  const ranges: Array<{ startDate: string; endDate: string }> = [];
  let startDate = normalized[0]!;
  let previousDate = normalized[0]!;
  for (const currentDate of normalized.slice(1)) {
    const previous = new Date(`${previousDate}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() + 1);
    const nextExpected = previous.toISOString().slice(0, 10);
    if (currentDate === nextExpected) {
      previousDate = currentDate;
      continue;
    }
    ranges.push({ startDate, endDate: previousDate });
    startDate = currentDate;
    previousDate = currentDate;
  }
  ranges.push({ startDate, endDate: previousDate });
  return ranges;
}

function addUtcDays(date: string, delta: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + delta);
  return next.toISOString().slice(0, 10);
}

function getTodayIsoForTimeZoneServer(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function enumerateUtcDays(startDate: string, endDate: string) {
  const dates: string[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function buildIntegritySignature(
  incidents: Array<{ providerAccountId: string; date: string }>,
) {
  const normalized = Array.from(
    new Set(
      incidents.map(
        (incident) => `${incident.providerAccountId}:${incident.date}`,
      ),
    ),
  ).sort();
  return normalized.length > 0 ? normalized.join("|") : null;
}

async function reconcileMetaAuthoritativeRecentWindow(input: {
  businessId: string;
  recentWindowDays: number;
}) {
  const [assignments, snapshot] = await Promise.all([
    getProviderAccountAssignments(input.businessId, "meta").catch(() => null),
    readProviderAccountSnapshot({
      businessId: input.businessId,
      provider: "meta",
    }).catch(() => null),
  ]);
  const providerAccountIds = assignments?.account_ids ?? [];
  const timezoneById = new Map(
    (snapshot?.accounts ?? []).map((account) => [
      account.id,
      account.timezone || "UTC",
    ]),
  );
  const repairDates = new Set<string>();
  let daysScanned = 0;
  let pendingDays = 0;
  let blockedDays = 0;
  let failedDays = 0;
  let repairRequiredDays = 0;
  let retryableQueuedDays = 0;
  let retryableRunningDays = 0;
  let staleLeaseProofDays = 0;
  let idlePendingDays = 0;

  for (const providerAccountId of providerAccountIds) {
    const timezone = timezoneById.get(providerAccountId) ?? "UTC";
    const today = getTodayIsoForTimeZoneServer(timezone);
    const yesterday = addUtcDays(today, -1);
    const startDate = addUtcDays(yesterday, -(Math.max(1, input.recentWindowDays) - 1));
    for (const day of enumerateUtcDays(startDate, yesterday)) {
      daysScanned += 1;
      const verification = await metaWarehouse
        .getMetaAuthoritativeDayVerification({
          businessId: input.businessId,
          providerAccountId,
          day,
        })
        .catch(() => null);
      if (!verification) continue;

      const reconciledRows = await metaWarehouse
        .reconcileMetaAuthoritativeDayStateFromVerification({
          verification,
          accountTimezone: timezone,
        })
        .catch(() => []);
      if (reconciledRows.length > 0) {
        const autoHealedAt = new Date().toISOString();
        await Promise.all(
          reconciledRows.map((row) =>
            metaWarehouse.upsertMetaAuthoritativeDayState({
              ...row,
              lastAutohealAt: autoHealedAt,
              autohealCount: (row.autohealCount ?? 0) + 1,
            }),
          ),
        ).catch(() => null);
      }

      if (verification.verificationState === "finalized_verified") {
        continue;
      }
      const activeDetectorStates = new Set(
        verification.surfaces.map((surface) => surface.detectorState),
      );

      if (verification.verificationState === "blocked") {
        blockedDays += 1;
        continue;
      }
      if (verification.verificationState === "repair_required") {
        repairRequiredDays += 1;
      } else if (verification.verificationState === "failed") {
        failedDays += 1;
      } else {
        pendingDays += 1;
      }

      if (verification.staleLeases > 0) {
        staleLeaseProofDays += 1;
        continue;
      }
      if (
        verification.leasedPartitions > 0 ||
        activeDetectorStates.has("running")
      ) {
        retryableRunningDays += 1;
        continue;
      }
      if (
        verification.queuedPartitions > 0 ||
        verification.repairBacklog > 0 ||
        activeDetectorStates.has("queued")
      ) {
        retryableQueuedDays += 1;
        repairDates.add(day);
        continue;
      }
      if (
        verification.verificationState !== "repair_required" &&
        verification.verificationState !== "failed"
      ) {
        idlePendingDays += 1;
        repairDates.add(day);
        continue;
      }
      repairDates.add(day);
    }
  }

  return {
    providerAccountCount: providerAccountIds.length,
    daysScanned,
    pendingDays,
    blockedDays,
    failedDays,
    repairRequiredDays,
    retryableQueuedDays,
    retryableRunningDays,
    staleLeaseProofDays,
    idlePendingDays,
    repairDates: Array.from(repairDates).sort(),
  };
}

async function countRecentRepairAttempts(input: {
  businessId: string;
  provider: "meta" | "google_ads";
  integritySignature: string | null;
}) {
  if (!input.integritySignature) return 0;
  const readiness = await getDbSchemaReadiness({
    tables: ["admin_audit_logs"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return 0;
  }
  const sql = getDb();
  const rows = await sql`
    SELECT COUNT(*)::int AS count
    FROM admin_audit_logs
    WHERE action = 'sync.recovery'
      AND target_type = 'business'
      AND target_id = ${input.businessId}
      AND created_at >= now() - interval '24 hours'
      AND COALESCE(meta ->> 'provider', '') = ${input.provider}
      AND COALESCE(meta ->> 'requestedAction', '') = ANY(${[
        "repair_cycle",
        "repair_integrity_windows",
      ]}::text[])
      AND COALESCE(meta ->> 'outcome', '') = 'completed'
      AND COALESCE(
        meta -> 'result' -> 'repair' -> 'meta' ->> 'integritySignature',
        ''
      ) = ${input.integritySignature}
  ` as Array<{ count: number | string }>;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Days in the advisor window with rows that were never re-read after closing.
 *
 * Reported, never enqueued. The bounded rolling refresh already schedules these
 * from `getGoogleAdsDatesDueForRefresh`; re-queueing them here would mean the
 * ~1/min repair cycle enqueued the whole 90-day window on every pass. What the
 * cycle owes the operator is the honest state, not more work.
 */
function summarizeGoogleAdvisorUnreobservedScopes(
  freshness: GoogleAdsFreshnessSummary | null,
) {
  if (!freshness || !freshness.evidenceAvailable) return [];
  return freshness.scopes
    .filter(
      (scope) =>
        scope.coveredDays > 0 && scope.postCloseObservedDays < freshness.totalDays,
    )
    .map((scope) => ({
      scope: scope.scope,
      state: scope.state,
      coveredDays: scope.coveredDays,
      postCloseObservedDays: scope.postCloseObservedDays,
      unreobservedDays: Math.max(0, freshness.totalDays - scope.postCloseObservedDays),
      dueNowDays: scope.dueNowDays,
    }));
}

async function buildGoogleAdvisorRecentGapRepairs(input: {
  businessId: string;
}) {
  const advisorWindowEnd = await getProviderPlatformPreviousDate({
    provider: "google",
    businessId: input.businessId,
  }).catch(() => addUtcDays(new Date().toISOString().slice(0, 10), -1));
  const advisorWindowStart = addUtcDays(advisorWindowEnd, -89);
  const scopes = ["search_term_daily", "product_daily"] as const;

  const [repairs, freshness] = await Promise.all([
    Promise.all(
      scopes.map(async (scope) => {
        // DATA AVAILABILITY. A date with zero rows needs a first fetch whatever
        // its freshness, so this planner legitimately reads row existence and
        // is deliberately unchanged. It is the CONCLUSION drawn when it finds
        // nothing — "the window is fine" — that moved to the evidence below.
        const coveredDates = new Set(
          await googleAdsWarehouse
            .getGoogleAdsCoveredDates({
              scope,
              businessId: input.businessId,
              providerAccountId: null,
              startDate: advisorWindowStart,
              endDate: advisorWindowEnd,
            })
            .catch(() => []),
        );
        const missingDates = enumerateUtcDays(
          advisorWindowStart,
          advisorWindowEnd,
        ).filter((date) => !coveredDates.has(date));
        return {
          scope,
          missingDates,
          ranges: buildContiguousDateRanges(missingDates),
        };
      }),
    ),
    // One bulk read covering both scopes, not one per scope or per date.
    readGoogleAdsFreshness({
      businessId: input.businessId,
      scopes,
      startDate: advisorWindowStart,
      endDate: advisorWindowEnd,
    })
      .then(toGoogleAdsFreshnessSummary)
      .catch(() => null),
  ]);

  return {
    advisorWindowStart,
    advisorWindowEnd,
    repairs: repairs.filter((entry) => entry.ranges.length > 0),
    freshness,
    /**
     * We could not read the evidence at all. Fail closed: a repair cycle that
     * cannot verify recency has not established that there is nothing to do.
     */
    freshnessUnverified: !freshness?.evidenceAvailable,
    unreobservedScopes: summarizeGoogleAdvisorUnreobservedScopes(freshness),
  };
}

async function resolveMetaIntegrityRepairEndDate(businessId: string) {
  const boundaries = await getProviderPlatformDateBoundaries({
    provider: "meta",
    businessId,
  }).catch(() => []);
  const previousDates = boundaries
    .map((boundary) => boundary.previousDate)
    .filter((date): date is string => Boolean(date))
    .sort();
  return (
    previousDates[0] ??
    addUtcDays(new Date().toISOString().slice(0, 10), -1)
  );
}

export async function runGoogleAdsRepairCycle(
  businessId: string,
  options?: ProviderRepairCycleOptions
) {
  const enqueueScheduledWork = options?.enqueueScheduledWork ?? true;
  const queueWarehouseRepairs = options?.queueWarehouseRepairs ?? true;
  const cleanup = await googleAdsWarehouse
    .cleanupGoogleAdsPartitionOrchestration({ businessId })
    .catch(() => null);
  const quarantinedTerminal = await googleAdsWarehouse
    .quarantineGoogleAdsTerminalActionRequiredPartitions({ businessId })
    .catch(() => null);
  const replayedDeadLetters = await googleAdsWarehouse
    .replayGoogleAdsDeadLetterPartitions({
      businessId,
      recoveryKinds: options?.googleDeadLetterRecoveryKinds ?? [
        "replayable_transient",
      ],
    })
    .catch(() => null);
  const replayedPoisoned = await googleAdsWarehouse
    .forceReplayGoogleAdsPoisonedPartitions({
      businessId,
      recoveryKinds: ["replayable_transient"],
    })
    .catch(() => null);
  // Restoration comes FIRST, so the two passes can never fight.
  //
  // Parking work when a surface cannot be read is only half a repair; without
  // the way back the loop is one-way, and the days parked while access was
  // missing would stay missing forever even after it returned. Running revival
  // before cancellation means a surface that reads again is recovered in the
  // same cycle rather than being re-parked for another minute first.
  const restoredScopeRevival = await googleAdsWarehouse
    .reviveGoogleAdsRestoredScopeBacklog({ businessId })
    .catch(() => null);
  if ((restoredScopeRevival?.revivedTotal ?? 0) > 0) {
    logRuntimeInfo("google-ads-repair", "restored_scope_backlog_revived", {
      businessId,
      revivedTotal: restoredScopeRevival?.revivedTotal ?? 0,
      scopes: restoredScopeRevival?.scopes ?? [],
    });
  }
  // Work for surfaces this account has provably never been able to read.
  //
  // One connected account held four scopes with 793 partitions each and zero
  // successes ever, after refusing them with PERMISSION_DENIED — and the
  // scheduler kept adding more every month. ~2,700 partitions that can never
  // complete, keeping the queue permanently unhealthy and burying the single
  // fact worth acting on. Cancelling them is not hiding the problem: the rows
  // keep the reason, and the account-action blocking reason below still says
  // the surfaces need access.
  const unreadableScopeCancellation = await googleAdsWarehouse
    .cancelGoogleAdsUnreadableScopeBacklog({ businessId })
    .catch(() => null);
  if ((unreadableScopeCancellation?.cancelledTotal ?? 0) > 0) {
    logRuntimeWarn("google-ads-repair", "unreadable_scope_backlog_cancelled", {
      businessId,
      cancelledTotal: unreadableScopeCancellation?.cancelledTotal ?? 0,
      scopes: unreadableScopeCancellation?.scopes ?? [],
    });
  }
  const requeuedFailed = await googleAdsWarehouse
    .requeueGoogleAdsRetryableFailedPartitions({ businessId })
    .catch(() => []);
  const integrityEndDate = new Date().toISOString().slice(0, 10);
  const integrityStartDate = addUtcDays(integrityEndDate, -45);
  const integrityIncidentsBefore = await googleAdsWarehouse
    .getGoogleAdsWarehouseIntegrityIncidents({
      businessId,
      startDate: integrityStartDate,
      endDate: integrityEndDate,
    })
    .catch(() => []);
  const integrityRepairRanges = buildContiguousDateRanges(
    integrityIncidentsBefore
      .filter((incident) => incident.repairRecommended)
      .map((incident) => incident.date),
  );
  const advisorRecentGapRepairs = await buildGoogleAdvisorRecentGapRepairs({
    businessId,
  }).catch(() => ({
    advisorWindowStart: integrityStartDate,
    advisorWindowEnd: integrityEndDate,
    repairs: [] as Array<{
      scope: GoogleAdsWarehouseScope;
      missingDates: string[];
      ranges: Array<{ startDate: string; endDate: string }>;
    }>,
    freshness: null as GoogleAdsFreshnessSummary | null,
    // The planner itself failed, so nothing about recency was established.
    freshnessUnverified: true,
    unreobservedScopes: [] as ReturnType<
      typeof summarizeGoogleAdvisorUnreobservedScopes
    >,
  }));
  // ── Daily-budget admission, before ANY repair work is issued ──────────────
  //
  // THE INCIDENT THIS PREVENTS (observed 2026-08-04, one business, 21,282
  // failures in 24h; 159,418 over 7 days against 14 successes).
  //
  // This cycle runs about once a minute per business and, until now, re-issued
  // every repair range unconditionally. `syncGoogleAdsRange` does the work
  // inline, so once a business exhausted its daily Google Ads request budget
  // each range failed immediately on `ProviderRequestCooldownError`. The
  // integrity incidents that produced those ranges therefore never cleared,
  // so the next pass rebuilt exactly the same ranges — roughly 900 doomed API
  // attempts per hour, around the clock, until UTC midnight reset the budget.
  //
  // `classifyGoogleAdsSyncFailure` already returns the correct backoff for this
  // ("retry after the daily reset"), and `buildGoogleAdsLaneAdmissionPolicy`
  // already gates the normal lane on budget pressure — but this engine calls
  // `syncGoogleAdsRange` directly and so bypassed both. The fix is to consult
  // the same authoritative budget state the lane uses, rather than to invent a
  // second notion of "exhausted" from error strings.
  //
  // Fail OPEN on an unreadable budget: a governance read that fails must not
  // silently stop repair work, which is the one job this engine has.
  const repairBudgetState = await getProviderQuotaBudgetState({
    provider: "google",
    businessId,
  }).catch(() => null);
  const dailyBudgetExhausted = repairBudgetState
    ? !repairBudgetState.withinDailyBudget
    : false;
  const budgetResetAt = (() => {
    const reset = new Date();
    reset.setUTCHours(24, 0, 0, 0);
    return reset.toISOString();
  })();
  const repairAdmissionAllowed = queueWarehouseRepairs && !dailyBudgetExhausted;
  if (dailyBudgetExhausted) {
    logRuntimeInfo("google-ads-repair", "budget_hold", {
      businessId,
      quotaDate: repairBudgetState?.quotaDate ?? null,
      callCount: repairBudgetState?.callCount ?? null,
      suppressedIntegrityRanges: integrityRepairRanges.length,
      suppressedRecentGapRanges: advisorRecentGapRepairs.repairs.reduce(
        (total, repair) => total + repair.ranges.length,
        0,
      ),
      retryAfterUtc: budgetResetAt,
    });
  }
  const queuedWarehouseRepairs = repairAdmissionAllowed
    ? await Promise.all(
        integrityRepairRanges.map((range) =>
          syncGoogleAdsRange({
            businessId,
            startDate: range.startDate,
            endDate: range.endDate,
            syncType: "repair_window",
            triggerSource:
              range.startDate === range.endDate
                ? "repair_recent_day"
                : "priority_window",
            scopes: ["account_daily", "campaign_daily"],
          }).catch(() => null),
        ),
      )
    : [];
  const queuedRecentGapRepairs = repairAdmissionAllowed
    ? await Promise.all(
        advisorRecentGapRepairs.repairs.flatMap((repair) =>
          repair.ranges.map((range) =>
            syncGoogleAdsRange({
              businessId,
              startDate: range.startDate,
              endDate: range.endDate,
              syncType: "repair_window",
              triggerSource:
                range.startDate === range.endDate
                  ? `repair_recent_day:${repair.scope}`
                  : `repair_recent_window:${repair.scope}`,
              scopes: [repair.scope],
            }).catch(() => null),
          ),
        ),
      )
    : [];
  await refreshGoogleAdsSyncStateForBusiness({
    businessId,
    scopes: ["account_daily", "campaign_daily", "search_term_daily", "product_daily"],
  }).catch(() => null);
  const integrityIncidentsAfter = await googleAdsWarehouse
    .getGoogleAdsWarehouseIntegrityIncidents({
      businessId,
      startDate: integrityStartDate,
      endDate: integrityEndDate,
    })
    .catch(() => []);
  const integritySignature = buildIntegritySignature(
    integrityIncidentsAfter
      .filter((incident) => incident.repairRecommended)
      .map((incident) => ({
      providerAccountId: incident.providerAccountId,
      date: incident.date,
    })),
  );
  const previousIntegrityAttempts = await countRecentRepairAttempts({
    businessId,
    provider: "google_ads",
    integritySignature,
  }).catch(() => 0);
  const integrityAttemptCount =
    integrityIncidentsAfter.length > 0 ? previousIntegrityAttempts + 1 : 0;
  const persistentIntegrityMismatch =
    integrityIncidentsAfter.length > 0 && previousIntegrityAttempts >= 1;
  const [queueHealthBeforeEnqueue, checkpointHealth] = await Promise.all([
    googleAdsWarehouse.getGoogleAdsQueueHealth({ businessId }).catch(() => null),
    googleAdsWarehouse
      .getGoogleAdsCheckpointHealth({ businessId, providerAccountId: null })
      .catch(() => null),
  ]);
  const enqueueResult = enqueueScheduledWork
    ? await enqueueGoogleAdsScheduledWork(businessId)
    : null;
  const deadLetterPartitionsBefore =
    queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0;
  const deadLetterReplayChanged =
    (replayedDeadLetters?.changedCount ?? 0) +
    (replayedPoisoned?.changedCount ?? 0);
  const terminalActionRequiredDeadLetters = Math.max(
    replayedDeadLetters?.terminalActionRequiredCount ?? 0,
    quarantinedTerminal?.changedCount ?? 0,
  );
  const blocked =
    dailyBudgetExhausted ||
    terminalActionRequiredDeadLetters > 0 ||
    (deadLetterPartitionsBefore > 0 && deadLetterReplayChanged <= 0) ||
    ((queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0) > 0 &&
      requeuedFailed.length <= 0) ||
    (checkpointHealth?.checkpointFailures ?? 0) > 0 ||
    advisorRecentGapRepairs.repairs.length > 0 ||
    // A cycle may only report "clean" once it can show the recent window was
    // re-read after those days closed. Coverage alone never establishes that,
    // and unreadable evidence establishes nothing at all.
    advisorRecentGapRepairs.freshnessUnverified ||
    advisorRecentGapRepairs.unreobservedScopes.length > 0 ||
    persistentIntegrityMismatch;

  const blockingReasons = compactBlockingReasons([
    dailyBudgetExhausted
      ? buildBlockingReason(
          "daily_request_budget_exhausted",
          `Google Ads daily request budget is spent for this business (quotaDate=${
            repairBudgetState?.quotaDate ?? "unknown"
          }, calls=${
            repairBudgetState?.callCount ?? "unknown"
          }). ${integrityRepairRanges.length} integrity range(s) and ${advisorRecentGapRepairs.repairs.reduce(
            (total, repair) => total + repair.ranges.length,
            0,
          )} recent-gap range(s) were NOT issued; retrying before the budget resets at ${budgetResetAt} would fail on arrival and starve every other business.`,
          // Not repairable by this engine: only the UTC daily reset clears it.
          { repairable: false },
        )
      : null,
    terminalActionRequiredDeadLetters > 0
      ? buildBlockingReason(
          "account_action_required",
          `${terminalActionRequiredDeadLetters} Google Ads partition(s) require Google account, OAuth, or customer-access action. Auto replay is intentionally disabled for these rows.`,
          { repairable: false },
        )
      : null,
    (unreadableScopeCancellation?.cancelledTotal ?? 0) > 0
      ? buildBlockingReason(
          "scope_unreadable_for_account",
          `This Google Ads account has never returned data for ${(
            unreadableScopeCancellation?.scopes ?? []
          )
            .map((entry) => entry.scope)
            .join(", ")} and refused those surfaces with a terminal access error. ${
            unreadableScopeCancellation?.cancelledTotal ?? 0
          } queued partition(s) that could never complete were cancelled. Grant the account access to these surfaces to resume them.`,
          // Not repairable here: only granting access in Google restores it.
          { repairable: false },
        )
      : null,
    deadLetterPartitionsBefore > 0 &&
    deadLetterReplayChanged <= 0 &&
    terminalActionRequiredDeadLetters === 0
      ? buildBlockingReason(
          "required_dead_letter_partitions",
          `${deadLetterPartitionsBefore} Google Ads partition(s) remain dead-lettered after repair. replayable=${replayedDeadLetters?.replayableMatchedCount ?? 0}, unknown=${replayedDeadLetters?.unknownMatchedCount ?? 0}.`,
          { repairable: true }
        )
      : null,
    (queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0) > 0 &&
    requeuedFailed.length <= 0
      ? buildBlockingReason(
          "retryable_failed_partitions",
          `${queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0} Google Ads failed partition(s) still need retry.`,
          { repairable: true },
        )
      : null,
    (checkpointHealth?.checkpointFailures ?? 0) > 0
      ? buildBlockingReason(
          "checkpoint_failures",
          `${checkpointHealth?.checkpointFailures ?? 0} Google Ads checkpoint failure(s) need replay or retry.`,
          { repairable: true }
        )
      : null,
    persistentIntegrityMismatch
      ? buildBlockingReason(
          "integrity_mismatch_persistent",
          `${integrityIncidentsAfter.length} Google Ads integrity incident(s) remained unchanged after ${integrityAttemptCount} repair attempts.`,
          { repairable: false }
        )
      : null,
    advisorRecentGapRepairs.repairs.length > 0
      ? buildBlockingReason(
          "missing_recent_required_surfaces",
          `Google Ads advisor is still missing recent 90-day coverage for ${advisorRecentGapRepairs.repairs
            .map((entry) => entry.scope)
            .join(", ")}.`,
          { repairable: true }
        )
      : null,
    advisorRecentGapRepairs.freshnessUnverified
      ? buildBlockingReason(
          "recent_surface_freshness_unverified",
          `Google Ads advisor recency could not be verified for ${advisorRecentGapRepairs.advisorWindowStart}..${advisorRecentGapRepairs.advisorWindowEnd}: ${
            advisorRecentGapRepairs.freshness?.unavailableReason ??
            "freshness evidence could not be read"
          }. Coverage alone does not establish that these days were re-read after they closed.`,
          { repairable: true },
        )
      : null,
    advisorRecentGapRepairs.unreobservedScopes.length > 0
      ? buildBlockingReason(
          "recent_surface_never_reobserved",
          `${advisorRecentGapRepairs.unreobservedScopes
            .map(
              (entry) =>
                `${entry.scope} has ${entry.unreobservedDays} day(s) with rows that were never re-read after the day closed`,
            )
            .join("; ")}. The bounded rolling refresh owns these days; this cycle deliberately did not enqueue them.`,
          { repairable: true },
        )
      : null,
  ]);
  const repairableActions = compactRepairableActions([
    buildRepairableAction(
      "replay_dead_letters",
      "Replay dead-lettered Google Ads partitions.",
      { available: (queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0) > 0 }
    ),
    buildRepairableAction(
      "replay_poisoned_checkpoints",
      "Replay poisoned Google Ads checkpoints.",
      { available: (checkpointHealth?.checkpointFailures ?? 0) > 0 }
    ),
    buildRepairableAction(
      "retry_failed_partitions",
      "Requeue retryable Google Ads failed partitions.",
      { available: (queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0) > 0 }
    ),
    buildRepairableAction(
      "repair_integrity_windows",
      "Repair Google Ads account/campaign integrity windows.",
      { available: integrityRepairRanges.length > 0 }
    ),
    buildRepairableAction(
      "repair_recent_required_surfaces",
      "Repair recent 90-day Google Ads advisor surfaces.",
      { available: advisorRecentGapRepairs.repairs.length > 0 }
    ),
  ]);

  return {
    enqueueResult,
    repair: {
      reclaimed: cleanup?.stalePartitionCount ?? 0,
      replayed: (replayedDeadLetters?.changedCount ?? 0) + (replayedPoisoned?.changedCount ?? 0),
      requeued:
        requeuedFailed.length +
        Number((enqueueResult as { queuedCore?: number } | null)?.queuedCore ?? 0),
      blocked,
      blockingReasons,
      repairableActions,
      meta: {
        deadLetters: replayedDeadLetters,
        quarantinedTerminalActionRequired: quarantinedTerminal,
        poisonedReplay: replayedPoisoned,
        retryableFailed: requeuedFailed.length,
        integrityIncidentCount: integrityIncidentsBefore.length,
        integrityRepairRanges,
        queuedWarehouseRepairs: queuedWarehouseRepairs.filter(Boolean).length,
        advisorWindowStart: advisorRecentGapRepairs.advisorWindowStart,
        advisorWindowEnd: advisorRecentGapRepairs.advisorWindowEnd,
        recentGapRepairScopes: advisorRecentGapRepairs.repairs.map((entry) => ({
          scope: entry.scope,
          missingDates: entry.missingDates,
          ranges: entry.ranges,
        })),
        queuedRecentGapRepairs: queuedRecentGapRepairs.filter(Boolean).length,
        /**
         * The freshness verdict behind this cycle's recency claim. An empty
         * `recentGapRepairScopes` means "no zero-row day", nothing more — read
         * these fields for whether the window is actually settled.
         */
        recentSurfaceFreshness: advisorRecentGapRepairs.freshness,
        recentSurfaceFreshnessUnverified: advisorRecentGapRepairs.freshnessUnverified,
        recentSurfaceUnreobservedScopes: advisorRecentGapRepairs.unreobservedScopes,
        recentSurfaceComplete: advisorRecentGapRepairs.freshness?.complete ?? false,
        recentSurfaceState: advisorRecentGapRepairs.freshness?.state ?? "unknown",
        remainingIntegrityIncidentCount: integrityIncidentsAfter.length,
        integritySignature,
        integrityAttemptCount,
        staleCheckpointCount: cleanup?.staleRunCount ?? 0,
        poisonCandidateCount: cleanup?.poisonCandidateCount ?? 0,
        checkpointRecoveryQueuedCount:
          (cleanup?.stalePartitionCount ?? 0) +
          (replayedPoisoned?.changedCount ?? 0),
        checkpointBlockedCount:
          (cleanup?.poisonCandidateCount ?? 0) > 0 ||
          (checkpointHealth?.checkpointFailures ?? 0) > 0
            ? 1
            : 0,
        remainingMismatchDates: Array.from(
          new Set(integrityIncidentsAfter.map((incident) => incident.date)),
        ).sort(),
        enqueueScheduledWork,
      },
    } satisfies ProviderAutoHealResult,
  };
}

export async function runMetaRepairCycle(
  businessId: string,
  options?: ProviderRepairCycleOptions
) {
  const enqueueScheduledWork = options?.enqueueScheduledWork ?? true;
  const queueWarehouseRepairs = options?.queueWarehouseRepairs ?? true;
  const stageTimings: MetaRepairStageRecord[] = [];
  let cleanup: Awaited<ReturnType<typeof metaWarehouse.cleanupMetaPartitionOrchestration>> | null = null;
  let cleanupError: string | null = null;
  cleanup = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.cleanup",
    stageRecords: stageTimings,
    run: () => metaWarehouse.cleanupMetaPartitionOrchestration({ businessId }),
    onError: (error) => {
      cleanupError = error instanceof Error ? error.message : String(error);
      return null;
    },
  });
  const quarantinedTerminal = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.quarantine_terminal_action_required",
    stageRecords: stageTimings,
    run: () =>
      metaWarehouse.quarantineMetaTerminalActionRequiredPartitions({
        businessId,
        sources: options?.metaDeadLetterSources ?? null,
      }),
    onError: () => null,
  });
  const replayedDeadLetters = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.replay_dead_letters",
    stageRecords: stageTimings,
    run: () =>
      metaWarehouse.replayMetaDeadLetterPartitions({
        businessId,
        sources: options?.metaDeadLetterSources ?? null,
        recoveryKinds: options?.metaDeadLetterRecoveryKinds ?? [
          "replayable_transient",
        ],
      }),
    onError: () => null,
  });
  const terminalActionRequiredMatchedBeforeStaleReplay = Math.max(
    replayedDeadLetters?.terminalActionRequiredCount ?? 0,
    quarantinedTerminal?.changedCount ?? 0,
  );
  let staleActionRequiredLiveAuth: Awaited<
    ReturnType<typeof validateMetaLiveAccountAccess>
  > | null = null;
  const shouldAttemptStaleActionRequiredReplay =
    terminalActionRequiredMatchedBeforeStaleReplay > 0 &&
    !options?.metaDeadLetterRecoveryKinds?.includes("terminal_action_required");
  const staleActionRequiredDeadLetterReplay = shouldAttemptStaleActionRequiredReplay
    ? await captureMetaRepairStage({
        businessId,
        stage: "runMetaRepairCycle.replay_stale_action_required_dead_letters",
        stageRecords: stageTimings,
        run: async () => {
          staleActionRequiredLiveAuth = await validateMetaLiveAccountAccess({
            businessId,
          });
          if (staleActionRequiredLiveAuth.status !== "valid") {
            return null;
          }
          return metaWarehouse.replayMetaDeadLetterPartitions({
            businessId,
            sources: options?.metaDeadLetterSources ?? null,
            recoveryKinds: ["terminal_action_required"],
          });
        },
        onError: () => null,
      })
    : null;
  // Dead letters the account's OWN later success has already contradicted.
  //
  // The two replay passes above are driven with `replayable_transient` and
  // `terminal_action_required`. A partition classified `unknown` is picked up
  // by neither and stays dead forever — 22 of them across 11 businesses on
  // 2026-08-05, all `account_daily` carrying Meta's generic "Invalid parameter"
  // (errorClass=payload, recoveryKind=unknown). They died in June/July after
  // 151-298 attempts each and were still counted as an unhealthy queue in
  // August, while the same scope had 11,098 successful partitions.
  //
  // Only scopes the account has since proven working are revisited, so this
  // cannot thrash against a genuinely broken surface — and it goes through the
  // ordinary replay path, keeping its lane, growth-boundary and selection
  // checks rather than mutating partitions directly.
  const supersededScopes = await metaWarehouse
    .getMetaSupersededDeadLetterScopes({ businessId })
    .catch(() => [] as string[]);
  const supersededDeadLetterReplays = supersededScopes.length
    ? await captureMetaRepairStage({
        businessId,
        stage: "runMetaRepairCycle.replay_superseded_dead_letters",
        stageRecords: stageTimings,
        run: async () => {
          const results = [];
          for (const scope of supersededScopes) {
            results.push(
              await metaWarehouse.replayMetaDeadLetterPartitions({
                businessId,
                scope: scope as Parameters<
                  typeof metaWarehouse.replayMetaDeadLetterPartitions
                >[0]["scope"],
                sources: options?.metaDeadLetterSources ?? null,
                recoveryKinds: ["unknown"],
              }),
            );
          }
          return results;
        },
        onError: () => null,
      })
    : null;
  const supersededDeadLetterReplayChanged = (
    supersededDeadLetterReplays ?? []
  ).reduce((total, result) => total + (result?.changedCount ?? 0), 0);
  const requeuedFailed = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.requeue_retryable_failed",
    stageRecords: stageTimings,
    run: () => metaWarehouse.requeueMetaRetryableFailedPartitions({ businessId }),
    onError: () => [],
  });
  const d1Recovery = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.recover_d1_finalize",
    stageRecords: stageTimings,
    run: () =>
      recoverMetaD1FinalizePartitions({
        businessId,
      }),
    onError: () => null,
  });
  const queueHealthBeforeEnqueue = await metaWarehouse.getMetaQueueHealth({ businessId }).catch(() => null);
  const integrityEndDate = await resolveMetaIntegrityRepairEndDate(businessId);
  const integrityStartDate = addUtcDays(integrityEndDate, -45);
  const integrityIncidents = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.integrity_incidents",
    stageRecords: stageTimings,
    run: () =>
      metaWarehouse.getMetaWarehouseIntegrityIncidents({
        businessId,
        startDate: integrityStartDate,
        endDate: integrityEndDate,
        persistReconciliationEvents: true,
      }),
    onError: () => [],
  });
  const repairDates = integrityIncidents
    .filter((incident) => incident.repairRecommended)
    .map((incident) => incident.date);
  const repairRanges = buildContiguousDateRanges(repairDates);
  const queuedWarehouseRepairs = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.queue_integrity_repairs",
    stageRecords: stageTimings,
    run: async () =>
      queueWarehouseRepairs
        ? Promise.all(
            repairRanges.map((range) =>
              syncMetaRepairRange({
                businessId,
                startDate: range.startDate,
                endDate: range.endDate,
                triggerSource:
                  range.startDate === range.endDate ? "repair_recent_day" : "priority_window",
              }).catch(() => null),
            ),
          )
        : [],
  });
  await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.refresh_state",
    stageRecords: stageTimings,
    run: () => refreshMetaSyncStateForBusiness({ businessId }),
    onError: () => undefined,
  });
  const canonicalDriftIncidents = await metaWarehouse
    .getMetaCanonicalDriftIncidents({
      businessId,
      sinceHours: 24,
    })
    .catch(() => []);
  const recentAuthoritativeWindow = await captureMetaRepairStage({
    businessId,
    stage: "runMetaRepairCycle.reconcile_recent_authoritative_window",
    stageRecords: stageTimings,
    run: async () => {
      const recentWindow = await reconcileMetaAuthoritativeRecentWindow({
        businessId,
        recentWindowDays: 30,
      });
      const authoritativeRepairRanges = buildContiguousDateRanges(
        recentWindow.repairDates,
      );
      const queuedAuthoritativeRepairs = queueWarehouseRepairs
        ? await Promise.all(
            authoritativeRepairRanges.map((range) =>
              syncMetaRepairRange({
                businessId,
                startDate: range.startDate,
                endDate: range.endDate,
                triggerSource:
                  range.startDate === range.endDate ? "repair_recent_day" : "priority_window",
              }).catch(() => null),
            ),
          )
        : [];
      return {
        recentWindow,
        authoritativeRepairRanges,
        queuedAuthoritativeRepairs,
      };
    },
    onError: () => ({
      recentWindow: {
        providerAccountCount: 0,
        daysScanned: 0,
        pendingDays: 0,
        blockedDays: 0,
        failedDays: 0,
        repairRequiredDays: 0,
        retryableQueuedDays: 0,
        retryableRunningDays: 0,
        staleLeaseProofDays: 0,
        idlePendingDays: 0,
        repairDates: [] as string[],
      },
      authoritativeRepairRanges: [] as Array<{ startDate: string; endDate: string }>,
      queuedAuthoritativeRepairs: [] as Array<unknown>,
    }),
  });
  const repeatedCanonicalDriftIncidents = canonicalDriftIncidents.filter(
    (incident) => incident.occurrenceCount >= 2,
  );
  const authoritativeRepairRanges = recentAuthoritativeWindow.authoritativeRepairRanges;
  const queuedAuthoritativeRepairs = recentAuthoritativeWindow.queuedAuthoritativeRepairs;
  const recentAuthoritativeWindowSummary = recentAuthoritativeWindow.recentWindow;
  const integritySignature = buildIntegritySignature(
    integrityIncidents
      .filter((incident) => incident.repairRecommended)
      .map((incident) => ({
      providerAccountId: incident.providerAccountId,
      date: incident.date,
    })),
  );
  const previousIntegrityAttempts = await countRecentRepairAttempts({
    businessId,
    provider: "meta",
    integritySignature,
  }).catch(() => 0);
  const persistentIntegrityMismatch =
    integrityIncidents.length > 0 && previousIntegrityAttempts >= 1;
  const integrityAttemptCount =
    repeatedCanonicalDriftIncidents.length > 0
      ? Math.max(
          ...repeatedCanonicalDriftIncidents.map(
            (incident) => incident.occurrenceCount,
          ),
        )
      : integrityIncidents.length > 0
        ? previousIntegrityAttempts + 1
        : 0;
  const enqueueResult = enqueueScheduledWork
    ? await enqueueMetaScheduledWork(businessId)
    : null;
  const staleActionRequiredReplayed =
    staleActionRequiredDeadLetterReplay?.changedCount ?? 0;
  const terminalActionRequiredDeadLetters = Math.max(
    0,
    terminalActionRequiredMatchedBeforeStaleReplay - staleActionRequiredReplayed,
  );
  const staleActionRequiredLiveAuthStatus =
    (
      staleActionRequiredLiveAuth as Awaited<
        ReturnType<typeof validateMetaLiveAccountAccess>
      > | null
    )?.status ?? null;
  // The unknown-kind count is taken from the first replay pass, which ran
  // before the superseded-scope pass below revived any of them. Subtracting
  // what was actually revived keeps this cycle's verdict truthful instead of
  // reporting a backlog that no longer exists until the next tick.
  const unknownDeadLetters = Math.max(
    0,
    (replayedDeadLetters?.unknownMatchedCount ?? 0) -
      supersededDeadLetterReplayChanged,
  );
  const replayableDeadLetters =
    replayedDeadLetters?.replayableMatchedCount ??
    ((queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0) > 0
      ? replayedDeadLetters?.matchedCount ?? 0
      : 0);
  const replayableDeadLettersRemain =
    replayableDeadLetters > 0 && (replayedDeadLetters?.changedCount ?? 0) <= 0;
  const blocked =
    cleanupError != null ||
    (replayedDeadLetters?.manualTruthDefectCount ?? 0) > 0 ||
    terminalActionRequiredDeadLetters > 0 ||
    unknownDeadLetters > 0 ||
    repeatedCanonicalDriftIncidents.length > 0 ||
    recentAuthoritativeWindowSummary.blockedDays > 0 ||
    persistentIntegrityMismatch ||
    ((queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0) > 0 &&
      replayedDeadLetters == null) ||
    replayableDeadLettersRemain ||
    ((queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0) > 0 && requeuedFailed.length <= 0);

  const blockingReasons = compactBlockingReasons([
    cleanupError
      ? buildBlockingReason(
          "cleanup_error",
          `Meta stale cleanup failed before repair could reclaim stale work: ${cleanupError}`,
          { repairable: true }
        )
      : null,
    (replayedDeadLetters?.manualTruthDefectCount ?? 0) > 0
      ? buildBlockingReason(
          "manual_truth_defect",
          `${replayedDeadLetters?.manualTruthDefectCount ?? 0} Meta partition(s) require manual truth repair after finalized validation failures.`,
          { repairable: false }
        )
      : null,
    terminalActionRequiredDeadLetters > 0
      ? buildBlockingReason(
          "account_action_required",
          staleActionRequiredLiveAuthStatus
            ? `${terminalActionRequiredDeadLetters} Meta partition(s) require Meta/Facebook login or reconnect before replay. liveAuthStatus=${staleActionRequiredLiveAuthStatus}.`
            : `${terminalActionRequiredDeadLetters} Meta partition(s) require Meta/Facebook login or reconnect before replay.`,
          { repairable: false }
        )
      : null,
    unknownDeadLetters > 0
      ? buildBlockingReason(
          "unknown_dead_letter_partitions",
          `${unknownDeadLetters} Meta dead-letter partition(s) have unclassified failures and need operator review.`,
          { repairable: false }
        )
      : null,
    repeatedCanonicalDriftIncidents.length > 0
      ? buildBlockingReason(
          "manual_truth_defect",
          `${repeatedCanonicalDriftIncidents.length} Meta canonical drift incident(s) repeated with the same finalized totals within 24 hours.`,
          { repairable: false }
        )
      : null,
    recentAuthoritativeWindowSummary.blockedDays > 0
      ? buildBlockingReason(
          "blocked_authoritative_publication_mismatch",
          `${recentAuthoritativeWindowSummary.blockedDays} Meta authoritative day(s) are blocked by publication or planner contract mismatch in the recent 30-day window.`,
          { repairable: false }
        )
      : null,
    persistentIntegrityMismatch
      ? buildBlockingReason(
          "integrity_mismatch_persistent",
          `${integrityIncidents.length} Meta integrity incident(s) remained unchanged after ${integrityAttemptCount} repair attempts.`,
          { repairable: false }
        )
      : null,
    (queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0) > 0 &&
    replayedDeadLetters == null
      ? buildBlockingReason(
          "required_dead_letter_partitions",
          `${queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0} Meta partition(s) remain dead-lettered because replay status could not be determined.`,
          { repairable: true }
        )
      : null,
    replayableDeadLettersRemain
      ? buildBlockingReason(
          "required_dead_letter_partitions",
          `${replayableDeadLetters} replayable Meta partition(s) remain dead-lettered after repair.`,
          { repairable: true }
        )
      : null,
    (queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0) > 0 && requeuedFailed.length <= 0
      ? buildBlockingReason(
          "retryable_failed_partitions",
          `${queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0} Meta failed partition(s) still need retry.`,
          { repairable: true }
        )
      : null,
  ]);
  const repairableActions = compactRepairableActions([
    buildRepairableAction(
      "replay_dead_letters",
      "Replay classified transient or live-auth-proven stale Meta dead-letter partitions.",
      {
        available:
          replayableDeadLetters > 0 ||
          staleActionRequiredReplayed > 0,
      }
    ),
    buildRepairableAction(
      "retry_failed_partitions",
      "Requeue retryable failed Meta partitions.",
      { available: (queueHealthBeforeEnqueue?.retryableFailedPartitions ?? 0) > 0 }
    ),
    buildRepairableAction(
      "repair_integrity_windows",
      "Queue authoritative repair windows for integrity incidents.",
      { available: repairRanges.length > 0 }
    ),
    buildRepairableAction(
      "repair_recent_authoritative_days",
      "Queue a fresh authoritative retry for recent Meta days marked repair_required or failed.",
      {
        available:
          authoritativeRepairRanges.length > 0 ||
          recentAuthoritativeWindowSummary.repairRequiredDays > 0 ||
          recentAuthoritativeWindowSummary.failedDays > 0,
      }
    ),
    buildRepairableAction(
      "inspect_blocked_authoritative_days",
      "Inspect blocked Meta publication mismatches before retrying authoritative work.",
      { available: recentAuthoritativeWindowSummary.blockedDays > 0 }
    ),
    buildRepairableAction(
      "prove_stale_leases_before_cleanup",
      "Confirm no authoritative progress exists before treating stale Meta leases as reclaimable.",
      { available: recentAuthoritativeWindowSummary.staleLeaseProofDays > 0 }
    ),
    buildRepairableAction(
      "monitor_retryable_authoritative_work",
      "Leave queued or running Meta authoritative work non-terminal until publish evidence or failure proof appears.",
      {
        available:
          recentAuthoritativeWindowSummary.retryableQueuedDays > 0 ||
          recentAuthoritativeWindowSummary.retryableRunningDays > 0 ||
          recentAuthoritativeWindowSummary.idlePendingDays > 0,
      }
    ),
  ]);

  return {
    enqueueResult,
    repair: {
      reclaimed: cleanup?.stalePartitionCount ?? 0,
      replayed: (replayedDeadLetters?.changedCount ?? 0) + staleActionRequiredReplayed,
      requeued: requeuedFailed.length,
      blocked,
      blockingReasons,
      repairableActions,
      meta: {
        cleanupSummary: cleanup,
        cleanupError,
        deadLetters: replayedDeadLetters,
        staleActionRequiredDeadLetters: staleActionRequiredDeadLetterReplay,
        staleActionRequiredLiveAuth,
        quarantinedTerminalActionRequired: quarantinedTerminal,
        retryableFailed: requeuedFailed.length,
        integrityIncidentCount: integrityIncidents.length,
        integritySignature,
        integrityAttemptCount,
        integrityRepairRanges: repairRanges,
        queuedWarehouseRepairs: queuedWarehouseRepairs.filter(Boolean).length,
        recentAuthoritativeWindow: recentAuthoritativeWindowSummary,
        recentAuthoritativeRepairRanges: authoritativeRepairRanges,
        queuedRecentAuthoritativeRepairs:
          queuedAuthoritativeRepairs.filter(Boolean).length,
        manualTruthDefectCount: replayedDeadLetters?.manualTruthDefectCount ?? 0,
        manualTruthDefectPartitions:
          replayedDeadLetters?.manualTruthDefectPartitions ?? [],
        canonicalDriftIncidents,
        canonicalDriftIncidentCount: canonicalDriftIncidents.length,
        canonicalDriftBlockedCount: 0,
        d1FinalizeRecoveryQueued: Boolean(
          d1Recovery?.d1FinalizeRecoveryQueued,
        ),
        d1FinalizeRecovery: d1Recovery,
        d1FinalizeRecoveredCount:
          d1Recovery?.reclaimedPartitionIds?.length ?? 0,
        d1FinalizeForceReclaimedCount:
          d1Recovery?.reclaimedPartitionIds?.length ?? 0,
        enqueueScheduledWork,
        stageTimings,
      },
    } satisfies ProviderAutoHealResult,
  };
}
