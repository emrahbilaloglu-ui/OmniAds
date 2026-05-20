import {
  type SyncRepairPlanRecord,
  type SyncRepairRecommendation,
  evaluateAndPersistSyncRepairPlan,
} from "@/lib/sync/repair-planner";
import {
  createSyncRepairExecution,
  finalizeStaleRunningSyncRepairExecutions,
  getLatestSyncRepairExecution,
  listRecentSyncRepairExecutions,
  type SyncRepairExecutionOutcome,
  type SyncRepairExecutionRecord,
} from "@/lib/sync/remediation-executions";
import {
  buildSyncRepairExecutionSignature,
  transitionSyncIncident,
} from "@/lib/sync/incidents";
import {
  acquireProviderJobLock,
  releaseExpiredProviderJobLock,
  releaseProviderJobLock,
} from "@/lib/sync/provider-job-lock";
import {
  evaluateAndPersistSyncGates,
  type SyncGateRecord,
} from "@/lib/sync/release-gates";
import { evaluateAndPersistGoogleAdsControlPlane } from "@/lib/google-ads/control-plane-runtime";
import {
  enqueueMetaScheduledWork,
  refreshMetaSyncStateForBusiness,
  consumeMetaQueuedWork,
} from "@/lib/sync/meta-sync";
import {
  cleanupMetaPartitionOrchestration,
  getMetaQueueHealth,
  replayMetaDeadLetterPartitions,
} from "@/lib/meta/warehouse";
import { runMetaRepairCycle, runGoogleAdsRepairCycle } from "@/lib/sync/provider-repair-engine";
import { validateMetaLiveAccountAccess } from "@/lib/sync/meta-live-auth";
import {
  enqueueGoogleAdsScheduledWork,
  refreshGoogleAdsSyncStateForBusiness,
} from "@/lib/sync/google-ads-sync";
import {
  cleanupGoogleAdsPartitionOrchestration,
  getGoogleAdsQueueHealth,
  replayGoogleAdsDeadLetterPartitions,
} from "@/lib/google-ads/warehouse";
import {
  acquireSyncRunnerLease,
  releaseSyncRunnerLease,
  renewSyncRunnerLease,
} from "@/lib/sync/worker-health";
import type { ProviderAutoHealResult } from "@/lib/sync/provider-status-truth";

const AUTO_REPAIR_LOCK_BY_PROVIDER = {
  meta: {
    provider: "meta",
    reportType: "auto_remediation",
    dateRangeKey: "control_plane",
  },
  google_ads: {
    provider: "google_ads",
    reportType: "auto_remediation",
    dateRangeKey: "control_plane",
  },
} as const;

const AUTO_REPAIR_COOLDOWN_MS = 60_000;
const AUTO_REPAIR_ATTEMPT_WINDOW_MINUTES = 15;
const AUTO_REPAIR_ATTEMPT_LIMIT = 3;
const AUTO_REPAIR_EXHAUSTION_COOLDOWN_MS = 60 * 60_000;
const AUTO_REPAIR_QUARANTINE_WINDOW_MINUTES = 60 * 24;
const AUTO_REPAIR_QUARANTINE_STRIKE_LIMIT = 3;
const AUTO_REPAIR_QUARANTINE_COOLDOWN_MS = 24 * 60 * 60_000;
const AUTO_REPAIR_STALE_EXECUTION_TIMEOUT_MINUTES = 15;
const META_AUTO_REPAIR_CONSUME_LEASE_MINUTES = 10;
const META_AUTO_REPAIR_CONSUME_MAX_PASSES = 12;
const META_AUTO_REPAIR_CONSUME_MAX_DELAY_MS = 2_000;
const META_AUTO_REPAIR_CONSUME_DURATION_MS = 90_000;

type SupportedProviderScope = "meta" | "google_ads";
type MetaExecutedRepairAction =
  | Exclude<SyncRepairRecommendation["recommendedAction"], "integrity_repair_enqueue">
  | "repair_cycle";
type GoogleExecutedRepairAction = SyncRepairRecommendation["recommendedAction"];

type ReevaluatedControlPlane = {
  releaseGate: SyncGateRecord | null;
  repairPlan: SyncRepairPlanRecord;
};

type ExecuteSyncRepairActionOptions = {
  providerScope: SupportedProviderScope;
  businessId: string;
  recommendation: SyncRepairRecommendation;
  consumeQueuedMetaWork?: boolean;
  workflowRunId?: string | null;
};

type AutoRepairSource = "worker" | "cron" | "manual";

export interface SyncRepairExecutionBudgetState {
  executionSignature: string;
  recentAttemptCount: number;
  cooldownRemainingMs: number;
  exhaustionRemainingMs: number;
  exhausted: boolean;
}

export interface SyncRepairExecutionWindowState {
  recentAttempts: SyncRepairExecutionRecord[];
  recentExhausted: SyncRepairExecutionRecord | undefined;
  cooldownRemainingMs: number;
  exhaustionRemainingMs: number;
  halfOpenProbe: boolean;
  quarantineStrikeCount: number;
  quarantineEligible: boolean;
}

export interface SyncRepairActionExecutionResult {
  executedAction: SyncRepairRecommendation["recommendedAction"] | "repair_cycle";
  result: Record<string, unknown>;
}

export interface AutoSyncRepairExecutionResult {
  execution: SyncRepairExecutionRecord | null;
  releaseGate: SyncGateRecord | null;
  repairPlan: SyncRepairPlanRecord | null;
  recommendation: SyncRepairRecommendation | null;
  skippedReason: string | null;
  budgetState: SyncRepairExecutionBudgetState | null;
}

function nowIso() {
  return new Date().toISOString();
}

function toSafeRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function mapRecommendationToExecutedAction(
  providerScope: "meta",
  recommendation: SyncRepairRecommendation,
): MetaExecutedRepairAction;
function mapRecommendationToExecutedAction(
  providerScope: "google_ads",
  recommendation: SyncRepairRecommendation,
): GoogleExecutedRepairAction;
function mapRecommendationToExecutedAction(
  providerScope: SupportedProviderScope,
  recommendation: SyncRepairRecommendation,
): SyncRepairRecommendation["recommendedAction"] | "repair_cycle";
function mapRecommendationToExecutedAction(
  providerScope: SupportedProviderScope,
  recommendation: SyncRepairRecommendation,
): SyncRepairRecommendation["recommendedAction"] | "repair_cycle" {
  if (
    providerScope === "meta" &&
    recommendation.recommendedAction === "integrity_repair_enqueue"
  ) {
    return "repair_cycle";
  }
  return recommendation.recommendedAction;
}

function buildExecutionSignature(
  providerScope: SupportedProviderScope,
  recommendation: SyncRepairRecommendation,
) {
  return buildSyncRepairExecutionSignature({
    providerScope,
    recommendation,
  });
}

function getLockConfig(providerScope: SupportedProviderScope) {
  return AUTO_REPAIR_LOCK_BY_PROVIDER[providerScope];
}

function extractCanaryRow(
  releaseGate: SyncGateRecord | null,
  businessId: string,
) {
  const rows = Array.isArray(releaseGate?.evidence?.canaries)
    ? (releaseGate?.evidence?.canaries as Array<Record<string, unknown>>)
    : [];
  return (
    rows.find((row) => String(row.businessId ?? "").trim() === businessId) ?? null
  );
}

function classifyExecutionOutcome(input: {
  releaseGate: SyncGateRecord | null;
  repairPlan: SyncRepairPlanRecord;
  recommendation: SyncRepairRecommendation;
}) {
  const afterRecommendation = input.repairPlan.recommendations.find(
    (row) => row.businessId === input.recommendation.businessId,
  );
  const afterCanary = extractCanaryRow(
    input.releaseGate,
    input.recommendation.businessId,
  );
  const afterPass = Boolean(afterCanary?.pass);
  const queueBefore = Number(input.recommendation.beforeEvidence.queueDepth ?? 0);
  const queueAfter = Number((afterCanary?.evidence as Record<string, unknown> | undefined)?.queueDepth ?? 0);
  const deadBefore = Number(input.recommendation.beforeEvidence.deadLetterPartitions ?? 0);
  const deadAfter = Number((afterCanary?.evidence as Record<string, unknown> | undefined)?.deadLetterPartitions ?? 0);

  if (!afterRecommendation && afterPass && input.releaseGate?.verdict === "pass") {
    return {
      outcome: "cleared" as SyncRepairExecutionOutcome,
      expectedOutcomeMet: true,
      afterEvidence: toSafeRecord(afterCanary?.evidence),
    };
  }

  if (
    !afterRecommendation ||
    afterPass ||
    queueAfter < queueBefore ||
    deadAfter < deadBefore
  ) {
    return {
      outcome: "improving_not_cleared" as SyncRepairExecutionOutcome,
      expectedOutcomeMet: true,
      afterEvidence: toSafeRecord(afterCanary?.evidence),
    };
  }

  return {
    outcome: "no_change" as SyncRepairExecutionOutcome,
    expectedOutcomeMet: false,
    afterEvidence: toSafeRecord(afterCanary?.evidence),
  };
}

export function resolveSyncRepairExecutionWindowState(input: {
  executionSignature: string;
  latestExecution: SyncRepairExecutionRecord | null;
  recentExecutions: SyncRepairExecutionRecord[];
  nowMs?: number;
}): SyncRepairExecutionWindowState {
  const nowMs = input.nowMs ?? Date.now();
  const latestStartedAtMs = input.latestExecution?.startedAt
    ? Date.parse(input.latestExecution.startedAt)
    : NaN;
  const cooldownRemainingMs =
    input.latestExecution?.executionSignature === input.executionSignature &&
    Number.isFinite(latestStartedAtMs) &&
    nowMs - latestStartedAtMs < AUTO_REPAIR_COOLDOWN_MS
      ? AUTO_REPAIR_COOLDOWN_MS - (nowMs - latestStartedAtMs)
      : 0;
  const recentAttempts = input.recentExecutions.filter((execution) => {
    const startedAtMs = Date.parse(execution.startedAt);
    return (
      Number.isFinite(startedAtMs) &&
      nowMs - startedAtMs <= AUTO_REPAIR_ATTEMPT_WINDOW_MINUTES * 60_000 &&
      execution.status !== "locked"
    );
  });
  const recentExhausted = input.recentExecutions.find((execution) => {
    if (execution.status !== "exhausted" || !execution.finishedAt) return false;
    const finishedAtMs = Date.parse(execution.finishedAt);
    return (
      Number.isFinite(finishedAtMs) &&
      nowMs - finishedAtMs < AUTO_REPAIR_EXHAUSTION_COOLDOWN_MS
    );
  });
  const exhaustionRemainingMs = recentExhausted?.finishedAt
    ? Math.max(
        0,
        AUTO_REPAIR_EXHAUSTION_COOLDOWN_MS -
          (nowMs - Date.parse(recentExhausted.finishedAt)),
      )
    : 0;
  const quarantineStrikeCount = input.recentExecutions.filter((execution) => {
    const startedAtMs = Date.parse(execution.startedAt);
    if (
      !Number.isFinite(startedAtMs) ||
      nowMs - startedAtMs > AUTO_REPAIR_QUARANTINE_WINDOW_MINUTES * 60_000
    ) {
      return false;
    }
    return (
      execution.status === "failed" ||
      execution.status === "exhausted" ||
      execution.outcomeClassification === "manual_follow_up_required"
    );
  }).length;
  return {
    recentAttempts,
    recentExhausted,
    cooldownRemainingMs,
    exhaustionRemainingMs,
    halfOpenProbe:
      Boolean(input.recentExecutions.some((execution) => execution.status === "exhausted")) &&
      exhaustionRemainingMs === 0,
    quarantineStrikeCount,
    quarantineEligible: quarantineStrikeCount >= AUTO_REPAIR_QUARANTINE_STRIKE_LIMIT,
  };
}

async function reevaluateControlPlane(input: {
  providerScope: SupportedProviderScope;
  buildId?: string;
  environment?: string;
  planMode?: SyncRepairPlanRecord["planMode"];
}) : Promise<ReevaluatedControlPlane> {
  if (input.providerScope === "google_ads") {
    const gates = await evaluateAndPersistGoogleAdsControlPlane({
      buildId: input.buildId,
      environment: input.environment,
    });
    const repairPlan = await evaluateAndPersistSyncRepairPlan({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: "google_ads",
      releaseGate: gates.releaseGate,
      planMode: input.planMode ?? "auto_execute",
    });
    return {
      releaseGate: gates.releaseGate,
      repairPlan,
    };
  }

  const gates = await evaluateAndPersistSyncGates({
    buildId: input.buildId,
    environment: input.environment,
  });
  const repairPlan = await evaluateAndPersistSyncRepairPlan({
    buildId: input.buildId,
    environment: input.environment,
    providerScope: "meta",
    releaseGate: gates.releaseGate,
    planMode: input.planMode ?? "auto_execute",
  });
  return {
    releaseGate: gates.releaseGate,
    repairPlan,
  };
}

async function consumeMetaQueuedWorkForRepair(input: {
  businessId: string;
  workflowRunId?: string | null;
}) {
  const workerId = `${input.workflowRunId ?? "auto"}:meta-repair:${input.businessId}`;
  const leaseAcquired = await acquireSyncRunnerLease({
    businessId: input.businessId,
    providerScope: "meta",
    leaseOwner: workerId,
    leaseMinutes: META_AUTO_REPAIR_CONSUME_LEASE_MINUTES,
  }).catch(() => false);
  if (!leaseAcquired) {
    return {
      leaseAcquired: false,
      workerId,
      reason: "runner_lease_unavailable",
    } as const;
  }

  let renewalStopped = false;
  let renewalInFlight: Promise<void> | null = null;
  const renewalIntervalMs = Math.max(
    10_000,
    Math.floor((META_AUTO_REPAIR_CONSUME_LEASE_MINUTES * 60_000) / 2),
  );
  const renewalTimer = setInterval(() => {
    if (renewalStopped) return;
    renewalInFlight = renewSyncRunnerLease({
      businessId: input.businessId,
      providerScope: "meta",
      leaseOwner: workerId,
      leaseMinutes: META_AUTO_REPAIR_CONSUME_LEASE_MINUTES,
    }).then(() => undefined, () => undefined);
  }, renewalIntervalMs);

  try {
    const passResults: unknown[] = [];
    const consumeStartedAt = Date.now();
    let consumeResult = await consumeMetaQueuedWork(input.businessId, {
      runtimeWorkerId: workerId,
    });
    passResults.push({ pass: 1, result: consumeResult });

    for (
      let pass = 2;
      pass <= META_AUTO_REPAIR_CONSUME_MAX_PASSES &&
      consumeResult.hasPendingWork &&
      consumeResult.hasForwardProgress &&
      Date.now() - consumeStartedAt < META_AUTO_REPAIR_CONSUME_DURATION_MS;
      pass += 1
    ) {
      const delayMs = Math.max(
        0,
        Math.min(
          consumeResult.nextDelayMs ?? 0,
          META_AUTO_REPAIR_CONSUME_MAX_DELAY_MS,
        ),
      );
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      consumeResult = await consumeMetaQueuedWork(input.businessId, {
        runtimeWorkerId: workerId,
      });
      passResults.push({ pass, result: consumeResult });
    }

    return {
      leaseAcquired: true,
      workerId,
      durationMs: Date.now() - consumeStartedAt,
      passCount: passResults.length,
      passResults,
      consumeResult,
    } as const;
  } finally {
    renewalStopped = true;
    clearInterval(renewalTimer);
    if (renewalInFlight) {
      await renewalInFlight;
    }
    await releaseSyncRunnerLease({
      businessId: input.businessId,
      providerScope: "meta",
      leaseOwner: workerId,
    }).catch(() => null);
  }
}

export async function executeSyncRepairAction(
  input: ExecuteSyncRepairActionOptions & {
    providerScope: "meta";
  },
): Promise<{
  executedAction: MetaExecutedRepairAction;
  result: Record<string, unknown>;
}>;
export async function executeSyncRepairAction(
  input: ExecuteSyncRepairActionOptions & {
    providerScope: "google_ads";
  },
): Promise<{
  executedAction: GoogleExecutedRepairAction;
  result: Record<string, unknown>;
}>;
export async function executeSyncRepairAction(
  input: ExecuteSyncRepairActionOptions,
): Promise<SyncRepairActionExecutionResult>;
export async function executeSyncRepairAction(
  input: ExecuteSyncRepairActionOptions,
): Promise<SyncRepairActionExecutionResult> {
  const executedAction = mapRecommendationToExecutedAction(
    input.providerScope,
    input.recommendation,
  );

  if (input.providerScope === "meta") {
    switch (input.recommendation.recommendedAction) {
      case "integrity_repair_enqueue": {
        const repair = await runMetaRepairCycle(input.businessId, {
          enqueueScheduledWork: true,
          queueWarehouseRepairs: true,
        });
        return {
          executedAction,
          result: { repair, queueOnly: true },
        };
      }
      case "reschedule": {
        const scheduled = await enqueueMetaScheduledWork(input.businessId);
        const consume = input.consumeQueuedMetaWork
          ? await consumeMetaQueuedWorkForRepair({
              businessId: input.businessId,
              workflowRunId: input.workflowRunId,
            })
          : null;
        return {
          executedAction,
          result: { scheduled, consume },
        };
      }
      case "refresh_state":
        await refreshMetaSyncStateForBusiness({ businessId: input.businessId });
        return {
          executedAction,
          result: { ok: true },
        };
      case "replay_dead_letter": {
        const replayed = await replayMetaDeadLetterPartitions({
          businessId: input.businessId,
          sources: null,
          recoveryKinds: ["replayable_transient"],
        });
        const liveAuth =
          replayed.terminalActionRequiredCount > 0
            ? await validateMetaLiveAccountAccess({ businessId: input.businessId })
            : null;
        const staleActionRequiredReplay =
          liveAuth?.status === "valid"
            ? await replayMetaDeadLetterPartitions({
                businessId: input.businessId,
                sources: null,
                recoveryKinds: ["terminal_action_required"],
              })
            : null;
        const replayedCount =
          (replayed.changedCount ?? 0) +
          (staleActionRequiredReplay?.changedCount ?? 0);
        const scheduled =
          replayedCount > 0
            ? await enqueueMetaScheduledWork(input.businessId)
            : null;
        const consume = input.consumeQueuedMetaWork
          ? replayedCount > 0
            ? await consumeMetaQueuedWorkForRepair({
                businessId: input.businessId,
                workflowRunId: input.workflowRunId,
              })
            : null
          : null;
        return {
          executedAction,
          result: {
            replayed,
            liveAuth,
            staleActionRequiredReplay,
            scheduled,
            consume,
          },
        };
      }
      case "stale_lease_reclaim": {
        const cleanup = await cleanupMetaPartitionOrchestration({
          businessId: input.businessId,
        });
        const queueHealth = await getMetaQueueHealth({
          businessId: input.businessId,
        }).catch(() => null);
        const scheduled =
          (queueHealth?.queueDepth ?? 0) > 0
            ? await enqueueMetaScheduledWork(input.businessId)
            : null;
        const consume =
          input.consumeQueuedMetaWork && (queueHealth?.queueDepth ?? 0) > 0
            ? await consumeMetaQueuedWorkForRepair({
                businessId: input.businessId,
                workflowRunId: input.workflowRunId,
              })
            : null;
        return {
          executedAction,
          result: {
            cleanup,
            queueHealth,
            scheduled,
            consume,
          },
        };
      }
    }
  }

  switch (input.recommendation.recommendedAction) {
    case "integrity_repair_enqueue": {
      const repair = await runGoogleAdsRepairCycle(input.businessId, {
        enqueueScheduledWork: true,
        queueWarehouseRepairs: true,
      });
      return {
        executedAction,
        result: { repair, queueOnly: true },
      };
    }
    case "reschedule": {
      const scheduled = await enqueueGoogleAdsScheduledWork(input.businessId);
      return {
        executedAction,
        result: { scheduled },
      };
    }
    case "refresh_state":
      await refreshGoogleAdsSyncStateForBusiness({ businessId: input.businessId });
      return {
        executedAction,
        result: { ok: true },
      };
    case "replay_dead_letter": {
      const replayed = await replayGoogleAdsDeadLetterPartitions({
        businessId: input.businessId,
        scope: null,
        recoveryKinds: ["replayable_transient"],
      });
      const scheduled = await enqueueGoogleAdsScheduledWork(input.businessId);
      return {
        executedAction,
        result: { replayed, scheduled },
      };
    }
    case "stale_lease_reclaim": {
      const cleanup = await cleanupGoogleAdsPartitionOrchestration({
        businessId: input.businessId,
      });
      const queueHealth = await getGoogleAdsQueueHealth({
        businessId: input.businessId,
      }).catch(() => null);
      const scheduled =
        (queueHealth?.queueDepth ?? 0) > 0
          ? await enqueueGoogleAdsScheduledWork(input.businessId)
          : null;
      return {
        executedAction,
        result: {
          cleanup,
          queueHealth,
          scheduled,
        },
      };
    }
  }
}

export async function executeAutoSyncRepairRecommendation(input: {
  buildId?: string;
  environment?: string;
  providerScope: SupportedProviderScope;
  recommendation: SyncRepairRecommendation;
  sourceReleaseGateId?: string | null;
  sourceRepairPlanId?: string | null;
  source: AutoRepairSource;
  consumeQueuedMetaWork?: boolean;
}) : Promise<AutoSyncRepairExecutionResult> {
  const executionSignature = buildExecutionSignature(
    input.providerScope,
    input.recommendation,
  );
  const finalizedStaleExecutions = await finalizeStaleRunningSyncRepairExecutions({
    buildId: input.buildId,
    environment: input.environment,
    providerScope: input.providerScope,
    businessId: input.recommendation.businessId,
    executionSignature,
    staleAfterMinutes: AUTO_REPAIR_STALE_EXECUTION_TIMEOUT_MINUTES,
  }).catch(() => []);
  if (finalizedStaleExecutions.length > 0) {
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "cooldown",
      cooldownUntil: new Date(Date.now() + AUTO_REPAIR_COOLDOWN_MS).toISOString(),
      lastError: "stale_running_execution_finalized",
      metadata: {
        source: input.source,
        executionSignature,
        finalizedExecutionIds: finalizedStaleExecutions.map((execution) => execution.id),
      },
    }).catch(() => null);
  }
  const latestExecution = await getLatestSyncRepairExecution({
    buildId: input.buildId,
    environment: input.environment,
    providerScope: input.providerScope,
    businessId: input.recommendation.businessId,
  }).catch(() => null);
  const nowMs = Date.now();
  const latestStartedAtMs = latestExecution?.startedAt
    ? Date.parse(latestExecution.startedAt)
    : NaN;
  const cooldownRemainingMs =
    latestExecution?.executionSignature === executionSignature &&
    Number.isFinite(latestStartedAtMs) &&
    nowMs - latestStartedAtMs < AUTO_REPAIR_COOLDOWN_MS
      ? AUTO_REPAIR_COOLDOWN_MS - (nowMs - latestStartedAtMs)
      : 0;
  const recentExecutions = await listRecentSyncRepairExecutions({
    buildId: input.buildId,
    environment: input.environment,
    providerScope: input.providerScope,
    businessId: input.recommendation.businessId,
    executionSignature,
    sinceMinutes: Math.max(
      Math.ceil(AUTO_REPAIR_EXHAUSTION_COOLDOWN_MS / 60_000),
      AUTO_REPAIR_QUARANTINE_WINDOW_MINUTES,
    ),
  }).catch(() => []);
  const executionWindow = resolveSyncRepairExecutionWindowState({
    executionSignature,
    latestExecution,
    recentExecutions,
    nowMs,
  });
  const budgetState: SyncRepairExecutionBudgetState = {
    executionSignature,
    recentAttemptCount: executionWindow.recentAttempts.length,
    cooldownRemainingMs: executionWindow.cooldownRemainingMs,
    exhaustionRemainingMs: executionWindow.exhaustionRemainingMs,
    exhausted: executionWindow.exhaustionRemainingMs > 0,
  };

  if (input.recommendation.safetyClassification === "blocked") {
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "manual_required",
      metadata: {
        source: input.source,
        skippedReason: "blocked_recommendation",
        executionSignature,
      },
    }).catch(() => null);
    return {
      execution: null,
      releaseGate: null,
      repairPlan: null,
      recommendation: input.recommendation,
      skippedReason: "blocked_recommendation",
      budgetState,
    };
  }

  if (executionWindow.quarantineEligible) {
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "quarantined",
      cooldownUntil: new Date(nowMs + AUTO_REPAIR_QUARANTINE_COOLDOWN_MS).toISOString(),
      lastError: "repeated_terminal_failures_quarantined",
      metadata: {
        source: input.source,
        skippedReason: "quarantined",
        executionSignature,
        quarantineStrikeCount: executionWindow.quarantineStrikeCount,
      },
    }).catch(() => null);
    return {
      execution: null,
      releaseGate: null,
      repairPlan: null,
      recommendation: input.recommendation,
      skippedReason: "quarantined",
      budgetState: {
        ...budgetState,
        exhausted: true,
      },
    };
  }

  if (executionWindow.cooldownRemainingMs > 0) {
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "cooldown",
      cooldownUntil: new Date(nowMs + executionWindow.cooldownRemainingMs).toISOString(),
      metadata: {
        source: input.source,
        skippedReason: "cooldown_active",
        executionSignature,
      },
    }).catch(() => null);
    return {
      execution: null,
      releaseGate: null,
      repairPlan: null,
      recommendation: input.recommendation,
      skippedReason: "cooldown_active",
      budgetState,
    };
  }

  if (executionWindow.exhaustionRemainingMs > 0) {
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "exhausted",
      cooldownUntil: new Date(nowMs + executionWindow.exhaustionRemainingMs).toISOString(),
      metadata: {
        source: input.source,
        skippedReason: "exhaustion_cooldown_active",
        executionSignature,
      },
    }).catch(() => null);
    return {
      execution: null,
      releaseGate: null,
      repairPlan: null,
      recommendation: input.recommendation,
      skippedReason: "exhaustion_cooldown_active",
      budgetState,
    };
  }

  if (executionWindow.recentAttempts.length >= AUTO_REPAIR_ATTEMPT_LIMIT) {
    const exhausted = await createSyncRepairExecution({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      businessId: input.recommendation.businessId,
      businessName: input.recommendation.businessName,
      executionSignature,
      sourceReleaseGateId: input.sourceReleaseGateId ?? null,
      sourceRepairPlanId: input.sourceRepairPlanId ?? null,
      recommendedAction: input.recommendation.recommendedAction,
      executedAction: null,
      workflowActor: input.source,
      status: "exhausted",
      outcomeClassification: "manual_follow_up_required",
      expectedOutcomeMet: false,
      beforeEvidence: input.recommendation.beforeEvidence,
      actionResult: {
        reason: "retry_budget_exhausted",
        retryBudgetState: {
          ...budgetState,
          exhausted: true,
        },
      },
      afterEvidence: input.recommendation.beforeEvidence,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "exhausted",
      cooldownUntil: new Date(nowMs + AUTO_REPAIR_EXHAUSTION_COOLDOWN_MS).toISOString(),
      metadata: {
        source: input.source,
        executionId: exhausted.id,
        executionSignature,
        reason: "retry_budget_exhausted",
      },
    }).catch(() => null);
    return {
      execution: exhausted,
      releaseGate: null,
      repairPlan: null,
      recommendation: input.recommendation,
      skippedReason: "retry_budget_exhausted",
      budgetState: {
        ...budgetState,
        exhausted: true,
        exhaustionRemainingMs: AUTO_REPAIR_EXHAUSTION_COOLDOWN_MS,
      },
    };
  }

  if (executionWindow.halfOpenProbe) {
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "half_open",
      metadata: {
        source: input.source,
        executionSignature,
        probe: "post_exhaustion",
      },
    }).catch(() => null);
  }

  const lockOwner = `${input.source}:${input.recommendation.businessId}:${Math.random().toString(36).slice(2, 10)}`;
  await releaseExpiredProviderJobLock({
    businessId: input.recommendation.businessId,
    errorMessage: "stale auto-remediation lock expired before reacquire",
    ...getLockConfig(input.providerScope),
  }).catch(() => ({ released: false, state: null }));
  const lock = await acquireProviderJobLock({
    businessId: input.recommendation.businessId,
    ownerToken: lockOwner,
    lockMinutes: 10,
    ...getLockConfig(input.providerScope),
  });
  if (!lock.acquired) {
    const locked = await createSyncRepairExecution({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      businessId: input.recommendation.businessId,
      businessName: input.recommendation.businessName,
      executionSignature,
      sourceReleaseGateId: input.sourceReleaseGateId ?? null,
      sourceRepairPlanId: input.sourceRepairPlanId ?? null,
      recommendedAction: input.recommendation.recommendedAction,
      executedAction: null,
      workflowActor: input.source,
      lockOwner,
      status: "locked",
      outcomeClassification: "locked",
      expectedOutcomeMet: false,
      beforeEvidence: input.recommendation.beforeEvidence,
      actionResult: {
        reason: lock.alreadyRunning ? "lock_unavailable" : "lock_error",
        retryBudgetState: budgetState,
      },
      afterEvidence: input.recommendation.beforeEvidence,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "repairing",
      metadata: {
        source: input.source,
        executionId: locked.id,
        executionSignature,
        skippedReason: "lock_unavailable",
      },
    }).catch(() => null);
    return {
      execution: locked,
      releaseGate: null,
      repairPlan: null,
      recommendation: input.recommendation,
      skippedReason: "lock_unavailable",
      budgetState,
    };
  }

  const execution = await createSyncRepairExecution({
    buildId: input.buildId,
    environment: input.environment,
    providerScope: input.providerScope,
    businessId: input.recommendation.businessId,
    businessName: input.recommendation.businessName,
    executionSignature,
    sourceReleaseGateId: input.sourceReleaseGateId ?? null,
    sourceRepairPlanId: input.sourceRepairPlanId ?? null,
    recommendedAction: input.recommendation.recommendedAction,
    workflowActor: input.source,
    lockOwner,
    status: "running",
    beforeEvidence: input.recommendation.beforeEvidence,
    actionResult: {
      retryBudgetState: budgetState,
    },
  });
  await transitionSyncIncident({
    buildId: input.buildId,
    environment: input.environment,
    providerScope: input.providerScope,
    recommendation: input.recommendation,
    nextStatus: "repairing",
    metadata: {
      source: input.source,
      executionId: execution.id,
      executionSignature,
    },
  }).catch(() => null);

  let completedExecution: SyncRepairExecutionRecord | null = execution;
  let releaseGate: SyncGateRecord | null = null;
  let repairPlan: SyncRepairPlanRecord | null = null;
  let releaseLockStatus: "done" | "failed" = "failed";
  let releaseLockError: string | null = null;

  try {
    const action = await executeSyncRepairAction({
      providerScope: input.providerScope,
      businessId: input.recommendation.businessId,
      recommendation: input.recommendation,
      consumeQueuedMetaWork: input.consumeQueuedMetaWork,
    });
    const reevaluated = await reevaluateControlPlane({
      providerScope: input.providerScope,
      buildId: input.buildId,
      environment: input.environment,
      planMode: "auto_execute",
    });
    releaseGate = reevaluated.releaseGate;
    repairPlan = reevaluated.repairPlan;
    const classified = classifyExecutionOutcome({
      releaseGate,
      repairPlan,
      recommendation: input.recommendation,
    });
    completedExecution = await createOrUpdateSucceededExecution({
      executionId: execution.id,
      businessName: input.recommendation.businessName,
      executionSignature,
      executedAction: action.executedAction,
      postRunReleaseGateId: releaseGate?.id ?? null,
      postRunRepairPlanId: repairPlan.id ?? null,
      outcome: classified.outcome,
      expectedOutcomeMet: classified.expectedOutcomeMet,
      beforeEvidence: input.recommendation.beforeEvidence,
      actionResult: {
        ...action.result,
        retryBudgetState: budgetState,
      },
      afterEvidence: classified.afterEvidence,
    });
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus:
        classified.outcome === "cleared"
          ? "cleared"
          : classified.outcome === "manual_follow_up_required"
            ? "manual_required"
            : "cooldown",
      cooldownUntil:
        classified.outcome === "cleared"
          ? null
          : new Date(Date.now() + AUTO_REPAIR_COOLDOWN_MS).toISOString(),
      metadata: {
        source: input.source,
        executionId: completedExecution?.id ?? execution.id,
        executionSignature,
        outcomeClassification: classified.outcome,
      },
    }).catch(() => null);
    releaseLockStatus = "done";
  } catch (error) {
    releaseLockError = error instanceof Error ? error.message : String(error);
    completedExecution = await createOrUpdateFailedExecution({
      executionId: execution.id,
      executionSignature,
      businessName: input.recommendation.businessName,
      beforeEvidence: input.recommendation.beforeEvidence,
      error,
      budgetState,
    });
    await transitionSyncIncident({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      recommendation: input.recommendation,
      nextStatus: "cooldown",
      cooldownUntil: new Date(Date.now() + AUTO_REPAIR_COOLDOWN_MS).toISOString(),
      lastError: releaseLockError,
      metadata: {
        source: input.source,
        executionId: completedExecution?.id ?? execution.id,
        executionSignature,
      },
    }).catch(() => null);
  } finally {
    await releaseProviderJobLock({
      businessId: input.recommendation.businessId,
      ownerToken: lockOwner,
      status: releaseLockStatus,
      errorMessage: releaseLockError,
      ...getLockConfig(input.providerScope),
    }).catch(() => null);
  }

  return {
    execution: completedExecution,
    releaseGate,
    repairPlan,
    recommendation: input.recommendation,
    skippedReason: null,
    budgetState,
  };
}

export interface AutoSyncRepairPassResult {
  releaseGate: SyncGateRecord | null;
  repairPlan: SyncRepairPlanRecord | null;
  recommendation: SyncRepairRecommendation | null;
  execution: SyncRepairExecutionRecord | null;
  skippedReason: string | null;
  budgetState: SyncRepairExecutionBudgetState | null;
}

export async function runAutoSyncRepairPass(input: {
  buildId?: string;
  environment?: string;
  providerScope: SupportedProviderScope;
  source: AutoRepairSource;
  businessId?: string;
  consumeQueuedMetaWork?: boolean;
  releaseGate?: SyncGateRecord | null;
  repairPlan?: SyncRepairPlanRecord | null;
}): Promise<AutoSyncRepairPassResult> {
  let releaseGate = input.releaseGate ?? null;
  let repairPlan = input.repairPlan ?? null;

  if (!releaseGate || !repairPlan) {
    const reevaluated = await reevaluateControlPlane({
      providerScope: input.providerScope,
      buildId: input.buildId,
      environment: input.environment,
      planMode: "auto_execute",
    });
    releaseGate = reevaluated.releaseGate;
    repairPlan = reevaluated.repairPlan;
  }

  const recommendation =
    repairPlan.recommendations.find((row) =>
      input.businessId ? row.businessId === input.businessId : true,
    ) ?? null;
  if (!recommendation) {
    return {
      releaseGate,
      repairPlan,
      recommendation: null,
      execution: null,
      skippedReason: "no_recommendation",
      budgetState: null,
    };
  }

  const executed = await executeAutoSyncRepairRecommendation({
    buildId: input.buildId,
    environment: input.environment,
    providerScope: input.providerScope,
    recommendation,
    sourceReleaseGateId: releaseGate?.id ?? null,
    sourceRepairPlanId: repairPlan.id,
    source: input.source,
    consumeQueuedMetaWork: input.consumeQueuedMetaWork,
  });

  return {
    releaseGate: executed.releaseGate ?? releaseGate,
    repairPlan: executed.repairPlan ?? repairPlan,
    recommendation,
    execution: executed.execution,
    skippedReason: executed.skippedReason,
    budgetState: executed.budgetState,
  };
}

export async function executeAutoSyncRepairPlan(input: {
  buildId?: string;
  environment?: string;
  providerScope: SupportedProviderScope;
  source: AutoRepairSource;
  consumeQueuedMetaWork?: boolean;
  releaseGate?: SyncGateRecord | null;
  repairPlan: SyncRepairPlanRecord;
}): Promise<{
  releaseGate: SyncGateRecord | null;
  repairPlan: SyncRepairPlanRecord;
  results: AutoSyncRepairPassResult[];
}> {
  const businessIds = Array.from(
    new Set(input.repairPlan.recommendations.map((row) => row.businessId)),
  );
  const results: AutoSyncRepairPassResult[] = [];
  let releaseGate = input.releaseGate ?? null;
  let repairPlan = input.repairPlan;

  for (const businessId of businessIds) {
    const result = await runAutoSyncRepairPass({
      buildId: input.buildId,
      environment: input.environment,
      providerScope: input.providerScope,
      source: input.source,
      businessId,
      consumeQueuedMetaWork: input.consumeQueuedMetaWork,
      releaseGate,
      repairPlan,
    });
    results.push(result);
    if (result.releaseGate) {
      releaseGate = result.releaseGate;
    }
    if (result.repairPlan) {
      repairPlan = result.repairPlan;
    }
  }

  return {
    releaseGate,
    repairPlan,
    results,
  };
}

export function mergeAutoRepairResult(
  base: ProviderAutoHealResult | null | undefined,
  passResults: AutoSyncRepairPassResult[],
): ProviderAutoHealResult {
  return {
    reclaimed: base?.reclaimed ?? 0,
    replayed: base?.replayed ?? 0,
    requeued: base?.requeued ?? 0,
    blocked: base?.blocked ?? false,
    blockingReasons: base?.blockingReasons ?? [],
    repairableActions: base?.repairableActions ?? [],
    meta: {
      ...(base?.meta ?? {}),
      autoExecutions: passResults.map((result) => ({
        businessId: result.recommendation?.businessId ?? null,
        recommendedAction: result.recommendation?.recommendedAction ?? null,
        safetyClassification: result.recommendation?.safetyClassification ?? null,
        executionId: result.execution?.id ?? null,
        executionStatus: result.execution?.status ?? null,
        outcomeClassification: result.execution?.outcomeClassification ?? null,
        skippedReason: result.skippedReason,
        budgetState: result.budgetState,
      })),
    },
  };
}

async function createOrUpdateSucceededExecution(input: {
  executionId: string;
  businessName: string | null;
  executionSignature: string;
  executedAction: string;
  postRunReleaseGateId: string | null;
  postRunRepairPlanId: string | null;
  outcome: SyncRepairExecutionOutcome;
  expectedOutcomeMet: boolean;
  beforeEvidence: Record<string, unknown>;
  actionResult: Record<string, unknown>;
  afterEvidence: Record<string, unknown>;
}) {
  const { updateSyncRepairExecution } = await import("@/lib/sync/remediation-executions");
  return updateSyncRepairExecution(input.executionId, {
    businessName: input.businessName,
    executionSignature: input.executionSignature,
    executedAction: input.executedAction,
    postRunReleaseGateId: input.postRunReleaseGateId,
    postRunRepairPlanId: input.postRunRepairPlanId,
    status: "succeeded",
    outcomeClassification: input.outcome,
    expectedOutcomeMet: input.expectedOutcomeMet,
    beforeEvidence: input.beforeEvidence,
    actionResult: input.actionResult,
    afterEvidence: input.afterEvidence,
    finishedAt: nowIso(),
  });
}

async function createOrUpdateFailedExecution(input: {
  executionId: string;
  executionSignature: string;
  businessName: string | null;
  beforeEvidence: Record<string, unknown>;
  error: unknown;
  budgetState: SyncRepairExecutionBudgetState;
}) {
  const { updateSyncRepairExecution } = await import("@/lib/sync/remediation-executions");
  return updateSyncRepairExecution(input.executionId, {
    businessName: input.businessName,
    executionSignature: input.executionSignature,
    status: "failed",
    outcomeClassification: "manual_follow_up_required",
    expectedOutcomeMet: false,
    beforeEvidence: input.beforeEvidence,
    actionResult: {
      error: input.error instanceof Error ? input.error.message : String(input.error),
      retryBudgetState: input.budgetState,
    },
    afterEvidence: input.beforeEvidence,
    finishedAt: nowIso(),
  });
}
