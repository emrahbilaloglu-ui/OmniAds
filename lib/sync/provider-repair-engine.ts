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
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
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
import { logRuntimeInfo, logRuntimeWarn } from "@/lib/runtime-logging";
import type { MetaDeadLetterRecoveryKind } from "@/lib/sync/meta-error-classification";

export interface ProviderRepairCycleOptions {
  enqueueScheduledWork?: boolean;
  metaDeadLetterSources?: string[] | null;
  metaDeadLetterRecoveryKinds?: MetaDeadLetterRecoveryKind[] | null;
  queueWarehouseRepairs?: boolean;
}

type MetaRepairStageName =
  | "runMetaRepairCycle.cleanup"
  | "runMetaRepairCycle.quarantine_terminal_action_required"
  | "runMetaRepairCycle.replay_dead_letters"
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

async function buildGoogleAdvisorRecentGapRepairs(input: {
  businessId: string;
}) {
  const advisorWindowEnd = await getProviderPlatformPreviousDate({
    provider: "google",
    businessId: input.businessId,
  }).catch(() => addUtcDays(new Date().toISOString().slice(0, 10), -1));
  const advisorWindowStart = addUtcDays(advisorWindowEnd, -89);
  const scopes = ["search_term_daily", "product_daily"] as const;

  const repairs = await Promise.all(
    scopes.map(async (scope) => {
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
  );

  return {
    advisorWindowStart,
    advisorWindowEnd,
    repairs: repairs.filter((entry) => entry.ranges.length > 0),
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
  const replayedDeadLetters = await googleAdsWarehouse
    .replayGoogleAdsDeadLetterPartitions({ businessId })
    .catch(() => null);
  const replayedPoisoned = await googleAdsWarehouse
    .forceReplayGoogleAdsPoisonedPartitions({ businessId })
    .catch(() => null);
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
    repairs: [],
  }));
  const queuedWarehouseRepairs = queueWarehouseRepairs
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
  const queuedRecentGapRepairs = queueWarehouseRepairs
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
  const blocked =
    ((queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0) > 0 &&
      (replayedDeadLetters?.changedCount ?? 0) + (replayedPoisoned?.changedCount ?? 0) <= 0) ||
    (checkpointHealth?.checkpointFailures ?? 0) > 0 ||
    advisorRecentGapRepairs.repairs.length > 0 ||
    persistentIntegrityMismatch;

  const blockingReasons = compactBlockingReasons([
    (queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0) > 0 &&
    (replayedDeadLetters?.changedCount ?? 0) + (replayedPoisoned?.changedCount ?? 0) <= 0
      ? buildBlockingReason(
          "required_dead_letter_partitions",
          `${queueHealthBeforeEnqueue?.deadLetterPartitions ?? 0} Google Ads partition(s) remain dead-lettered after repair.`,
          { repairable: true }
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
      requeued: Number((enqueueResult as { queuedCore?: number } | null)?.queuedCore ?? 0),
      blocked,
      blockingReasons,
      repairableActions,
      meta: {
        deadLetters: replayedDeadLetters,
        poisonedReplay: replayedPoisoned,
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
  const terminalActionRequiredDeadLetters =
    Math.max(
      replayedDeadLetters?.terminalActionRequiredCount ?? 0,
      quarantinedTerminal?.changedCount ?? 0,
    );
  const unknownDeadLetters = replayedDeadLetters?.unknownMatchedCount ?? 0;
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
          `${terminalActionRequiredDeadLetters} Meta partition(s) require Meta/Facebook login or reconnect before replay.`,
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
      "Replay classified transient Meta dead-letter partitions.",
      { available: replayableDeadLetters > 0 }
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
      replayed: replayedDeadLetters?.changedCount ?? 0,
      requeued: requeuedFailed.length,
      blocked,
      blockingReasons,
      repairableActions,
      meta: {
        cleanupSummary: cleanup,
        cleanupError,
        deadLetters: replayedDeadLetters,
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
