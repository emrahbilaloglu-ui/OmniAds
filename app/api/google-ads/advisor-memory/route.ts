import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  assertGoogleAdsAccountAuthority,
  isGoogleAdsAccountAuthorityError,
} from "@/lib/google-ads/account-authority";
import { isDemoBusiness } from "@/lib/business-mode.server";
import {
  executeActionCluster,
  rollbackActionCluster,
} from "@/lib/google-ads/action-clusters";
import {
  getAdvisorExecutionCalibration,
  logAdvisorExecutionEvent,
  recordAdvisorOutcome,
  updateAdvisorCompletionState,
  updateAdvisorExecutionState,
  updateAdvisorMemoryAction,
} from "@/lib/google-ads/advisor-memory";
import {
  executeAdvisorMutation,
  preflightAdvisorMutation,
  rollbackAdvisorMutation,
} from "@/lib/google-ads/advisor-mutate";
import { getGoogleAdsWritebackCapabilityGate } from "@/lib/google-ads/decision-engine-config";
import { appendGoogleAdsDecisionActionOutcomeLog } from "@/lib/google-ads/search-intelligence-storage";
import type {
  GoogleActionCluster,
  GoogleActionClusterStep,
  GoogleDependencyReadiness,
  GoogleExecutionTrustBand,
  GoogleOutcomeConfidence,
  GoogleOutcomeVerdict,
  GoogleOutcomeVerdictFailReason,
} from "@/lib/google-ads/growth-advisor-types";

type BatchActionType = "add_negative_keyword" | "pause_asset";

type RequestBody =
  | {
      businessId?: string;
      accountId?: string;
      recommendationFingerprint?: string;
      action?: "dismissed" | "ignored" | "applied" | "unsuppress";
      executionAction?:
        | "apply_mutate"
        | "rollback_mutate"
        | "rollback_batch_mutate"
        | "execute_cluster"
        | "rollback_cluster"
        | "mark_completion"
        | "record_outcome";
      batchExecutionAction?: "apply_batch_mutate";
      mutateActionType?:
        | "add_negative_keyword"
        | "pause_asset"
        | "pause_ad"
        | "adjust_campaign_budget"
        | "adjust_shared_budget"
        | "adjust_portfolio_target"
        | null;
      mutatePayloadPreview?: Record<string, unknown> | null;
      rollbackActionType?:
        | "remove_negative_keyword"
        | "enable_asset"
        | "enable_ad"
        | "restore_campaign_budget"
        | "restore_shared_budget"
        | "restore_portfolio_target"
        | null;
      rollbackPayloadPreview?: Record<string, unknown> | null;
      executionTrustBand?: GoogleExecutionTrustBand | null;
      dependencyReadiness?: GoogleDependencyReadiness | null;
      stabilizationHoldUntil?: string | null;
      completionMode?: "full" | "partial" | "unknown";
      completedStepCount?: number | null;
      totalStepCount?: number | null;
      completedStepIds?: string[] | null;
      skippedStepIds?: string[] | null;
      coreStepIds?: string[] | null;
      batchItems?: Array<{
        recommendationFingerprint: string;
        accountId: string;
        mutateActionType: BatchActionType;
        mutatePayloadPreview: Record<string, unknown>;
        rollbackActionType?: "remove_negative_keyword" | "enable_asset" | null;
        rollbackPayloadPreview?: Record<string, unknown> | null;
        executionTrustBand?: GoogleExecutionTrustBand | null;
        batchGroupKey?: string | null;
      }> | null;
      cluster?: GoogleActionCluster | null;
      transactionId?: string | null;
      dismissReason?: string | null;
      suppressUntil?: string | null;
      outcomeVerdict?: GoogleOutcomeVerdict | null;
      outcomeMetric?: string | null;
      outcomeDelta?: number | null;
      outcomeConfidence?: GoogleOutcomeConfidence | null;
      outcomeVerdictFailReason?: GoogleOutcomeVerdictFailReason | null;
      outcomeCheckWindowDays?: number | null;
      outcomeSummary?: string | null;
      outcomeOccurredAt?: string | null;
    }
  | null;

function trustBlocked(band?: GoogleExecutionTrustBand | null) {
  return band === "low" || band === "insufficient_data";
}

function dependencyBlocked(readiness?: GoogleDependencyReadiness | null) {
  return readiness === "not_ready" || readiness === "done_degraded" || readiness === "done_unverified";
}

function batchStatusFromResults(results: Array<{ ok: boolean }>) {
  if (results.every((entry) => entry.ok)) return "applied" as const;
  if (results.some((entry) => entry.ok)) return "partially_applied" as const;
  return "failed" as const;
}

function retryableRollbackError(message: string | null | undefined) {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("temporar") ||
    normalized.includes("unavailable") ||
    normalized.includes("throttle")
  );
}

function isWritebackExecutionRequested(body: RequestBody) {
  return (
    body?.executionAction === "apply_mutate" ||
    body?.executionAction === "rollback_mutate" ||
    body?.executionAction === "rollback_batch_mutate" ||
    body?.executionAction === "execute_cluster" ||
    body?.executionAction === "rollback_cluster" ||
    body?.batchExecutionAction === "apply_batch_mutate"
  );
}

async function applyBatchMutateInternal(input: {
  businessId: string;
  /**
   * The authorizing session's user id, read from `requireBusinessAccess` at the
   * boundary and never from the request body. Every execution-log row this
   * helper writes carries it, so the Plan screen's `Who` names the seat that
   * authored the write.
   */
  actorUserId: string | null;
  items: NonNullable<NonNullable<RequestBody>["batchItems"]>;
  transactionId?: string | null;
  extraMetadata?: Record<string, unknown>;
}) {
  const items = input.items;
  if (items.length === 0) {
    throw new Error("batchItems must contain at least one item");
  }
  if (items.length > 250) {
    throw new Error("batchItems exceeds the Wave 11 safety ceiling of 250 items");
  }
  const actionTypes = new Set(items.map((item) => item.mutateActionType));
  const batchGroups = new Set(items.map((item) => String(item.batchGroupKey ?? "")));
  if (actionTypes.size !== 1 || batchGroups.size !== 1) {
    throw new Error("Batch mutate only supports same action type and same batch group.");
  }
  const batchActionType = items[0]?.mutateActionType;
  if (!batchActionType || (batchActionType !== "add_negative_keyword" && batchActionType !== "pause_asset")) {
    throw new Error("Wave 11 batch mutate only supports add_negative_keyword and pause_asset.");
  }
  if (items.some((item) => trustBlocked(item.executionTrustBand))) {
    throw new Error("One or more batch items failed the execution trust gate.");
  }

  const transactionId = input.transactionId ?? randomUUID();
  const results: Array<{
    recommendationFingerprint: string;
    accountId: string;
    ok: boolean;
    error?: string | null;
    rollbackPayloadPreview?: Record<string, unknown> | null;
  }> = [];

  for (const item of items) {
    await updateAdvisorExecutionState({
      businessId: input.businessId,
      accountId: item.accountId,
      recommendationFingerprint: item.recommendationFingerprint,
      executionStatus: "pending",
      executionError: null,
      executionMetadata: {
        transactionId,
        batchStatus: "pending",
        batchGroupKey: item.batchGroupKey ?? null,
        mutateActionType: item.mutateActionType,
        ...input.extraMetadata,
      },
    });
    await logAdvisorExecutionEvent({
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      accountId: item.accountId,
      recommendationFingerprint: item.recommendationFingerprint,
      mutateActionType: item.mutateActionType,
      operation: "apply",
      status: "pending",
      payload: {
        ...item.mutatePayloadPreview,
        transactionId,
        batchGroupKey: item.batchGroupKey ?? null,
        ...input.extraMetadata,
      },
    });
    try {
      await preflightAdvisorMutation({
        businessId: input.businessId,
        accountId: item.accountId,
        action: {
          actionType: item.mutateActionType,
          payload: item.mutatePayloadPreview as never,
        },
      });
      const result = await executeAdvisorMutation({
        businessId: input.businessId,
        accountId: item.accountId,
        action: {
          actionType: item.mutateActionType,
          payload: item.mutatePayloadPreview as never,
        },
      });
      const rollbackPayloadPreview =
        item.rollbackActionType === "remove_negative_keyword"
          ? { resourceNames: result.resourceNames }
          : item.rollbackActionType === "enable_asset"
            ? { resourceNames: result.resourceNames }
            : item.rollbackPayloadPreview ?? null;
      await updateAdvisorExecutionState({
        businessId: input.businessId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        executionStatus: "applied",
        rollbackAvailable: Boolean(item.rollbackActionType),
        executionMetadata: {
          mutateActionType: item.mutateActionType,
          rollbackActionType: item.rollbackActionType ?? null,
          rollbackPayloadPreview,
          resourceNames: result.resourceNames,
          policyPatternKey: item.mutatePayloadPreview?.policyPatternKey ?? null,
          executionTrustBand: item.executionTrustBand ?? null,
          batchGroupKey: item.batchGroupKey ?? null,
          transactionId,
          batchStatus: "applied",
          batchSize: items.length,
          batchRollbackAvailable: Boolean(item.rollbackActionType),
          ...input.extraMetadata,
        },
      });
      await updateAdvisorMemoryAction({
        businessId: input.businessId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        action: "applied",
      });
      await updateAdvisorCompletionState({
        businessId: input.businessId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        completionMode: "full",
        completedStepCount: 1,
        totalStepCount: 1,
        completedStepIds: ["execute_mutate"],
        skippedStepIds: [],
        coreStepIds: ["execute_mutate"],
      });
      await logAdvisorExecutionEvent({
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        mutateActionType: item.mutateActionType,
        operation: "apply",
        status: "applied",
        payload: item.mutatePayloadPreview,
        response: {
          resourceNames: result.resourceNames,
          batchGroupKey: item.batchGroupKey ?? null,
          transactionId,
          ...input.extraMetadata,
        },
      });
      results.push({
        recommendationFingerprint: item.recommendationFingerprint,
        accountId: item.accountId,
        ok: true,
        rollbackPayloadPreview,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Batch mutate failed.";
      await updateAdvisorExecutionState({
        businessId: input.businessId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        executionStatus: "failed",
        executionError: message,
        executionMetadata: {
          transactionId,
          batchStatus: "failed",
          batchGroupKey: item.batchGroupKey ?? null,
          mutateActionType: item.mutateActionType,
          ...input.extraMetadata,
        },
      });
      await logAdvisorExecutionEvent({
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        mutateActionType: item.mutateActionType,
        operation: "apply",
        status: "failed",
        payload: item.mutatePayloadPreview,
        errorMessage: message,
      });
      results.push({
        recommendationFingerprint: item.recommendationFingerprint,
        accountId: item.accountId,
        ok: false,
        error: message,
      });
    }
  }

  const batchStatus = batchStatusFromResults(results);
  if (batchStatus === "partially_applied") {
    for (const result of results.filter((entry) => entry.ok)) {
      await updateAdvisorExecutionState({
        businessId: input.businessId,
        accountId: result.accountId,
        recommendationFingerprint: result.recommendationFingerprint,
        executionStatus: "partially_applied",
        executionMetadata: {
          transactionId,
          batchStatus,
          batchSize: items.length,
          batchRollbackAvailable: true,
          ...input.extraMetadata,
        },
      });
    }
  }

  return {
    transactionId,
    batchStatus,
    batchSize: items.length,
    batchRollbackAvailable: results.some((entry) => entry.ok),
    results,
  };
}

async function rollbackBatchMutateInternal(input: {
  businessId: string;
  /** The authorizing session's user id; see `applyBatchMutateInternal`. */
  actorUserId: string | null;
  transactionId: string;
  items: NonNullable<NonNullable<RequestBody>["batchItems"]>;
  extraMetadata?: Record<string, unknown>;
}) {
  const results: Array<{ recommendationFingerprint: string; ok: boolean; error?: string | null }> = [];
  for (const item of input.items) {
    try {
      if (!item.rollbackActionType || !item.rollbackPayloadPreview) {
        throw new Error("Rollback payload is missing for this batch item.");
      }
      const response = await rollbackAdvisorMutation({
        businessId: input.businessId,
        accountId: item.accountId,
        actionType: item.rollbackActionType,
        payload: item.rollbackPayloadPreview,
      });
      await updateAdvisorExecutionState({
        businessId: input.businessId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        executionStatus: "rolled_back",
        rollbackAvailable: false,
        rollbackExecutedAt: new Date().toISOString(),
        executionMetadata: {
          transactionId: input.transactionId,
          batchStatus: "rolled_back",
          rolledBack: true,
          ...input.extraMetadata,
        },
      });
      await logAdvisorExecutionEvent({
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        mutateActionType: item.rollbackActionType,
        operation: "rollback",
        status: "rolled_back",
        payload: item.rollbackPayloadPreview,
        response: { ...(typeof response === "object" && response ? response : {}), transactionId: input.transactionId, ...input.extraMetadata },
      });
      results.push({ recommendationFingerprint: item.recommendationFingerprint, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Batch rollback failed.";
      await updateAdvisorExecutionState({
        businessId: input.businessId,
        accountId: item.accountId,
        recommendationFingerprint: item.recommendationFingerprint,
        executionStatus: "failed",
        executionError: message,
        executionMetadata: {
          transactionId: input.transactionId,
          batchStatus: "partially_applied",
          rollbackFailed: true,
          ...input.extraMetadata,
        },
      });
      results.push({ recommendationFingerprint: item.recommendationFingerprint, ok: false, error: message });
    }
  }
  return {
    transactionId: input.transactionId,
    batchStatus: results.every((entry) => entry.ok) ? "rolled_back" : "partially_applied",
    results,
    retryable: results.some((entry) => !entry.ok && retryableRollbackError(entry.error)),
  };
}

async function applySingleMutateInternal(input: {
  businessId: string;
  /** The authorizing session's user id; see `applyBatchMutateInternal`. */
  actorUserId: string | null;
  accountId: string;
  recommendationFingerprint: string;
  mutateActionType: NonNullable<NonNullable<RequestBody>["mutateActionType"]>;
  mutatePayloadPreview: Record<string, unknown>;
  rollbackActionType?: NonNullable<NonNullable<RequestBody>["rollbackActionType"]>;
  rollbackPayloadPreview?: Record<string, unknown> | null;
  executionTrustBand?: GoogleExecutionTrustBand | null;
  dependencyReadiness?: GoogleDependencyReadiness | null;
  stabilizationHoldUntil?: string | null;
  transactionId?: string | null;
  extraMetadata?: Record<string, unknown>;
}) {
  if (trustBlocked(input.executionTrustBand)) {
    throw new Error("Execution policy trust is too low for native mutate.");
  }
  if (dependencyBlocked(input.dependencyReadiness)) {
    throw new Error("Prerequisite execution state is no longer valid for native mutate.");
  }
  if (input.stabilizationHoldUntil && new Date(input.stabilizationHoldUntil).getTime() > Date.now()) {
    throw new Error(`This mutate remains in stabilization hold until ${input.stabilizationHoldUntil}.`);
  }

  const transactionId = input.transactionId ?? randomUUID();
  await updateAdvisorExecutionState({
    businessId: input.businessId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    executionStatus: "pending",
    executionError: null,
    executionMetadata: {
      transactionId,
      batchStatus: "pending",
      ...input.extraMetadata,
    },
  });
  await logAdvisorExecutionEvent({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    mutateActionType: input.mutateActionType,
    operation: "apply",
    status: "pending",
    payload: { ...input.mutatePayloadPreview, transactionId, ...input.extraMetadata },
  });

  await preflightAdvisorMutation({
    businessId: input.businessId,
    accountId: input.accountId,
    action: {
      actionType: input.mutateActionType,
      payload: input.mutatePayloadPreview as never,
    },
  });
  const result = await executeAdvisorMutation({
    businessId: input.businessId,
    accountId: input.accountId,
    action: {
      actionType: input.mutateActionType,
      payload: input.mutatePayloadPreview as never,
    },
  });
  const budgetOperations = Array.isArray(input.mutatePayloadPreview?.operations)
    ? input.mutatePayloadPreview.operations
    : [];
  const rollbackPayloadPreview =
    input.rollbackActionType === "remove_negative_keyword"
      ? { resourceNames: result.resourceNames }
        : input.rollbackActionType === "enable_asset"
          ? { resourceNames: result.resourceNames }
          : input.rollbackActionType === "restore_campaign_budget" || input.rollbackActionType === "restore_shared_budget"
          ? budgetOperations.length > 0
            ? {
                operations: budgetOperations.map((operation) => ({
                  campaignBudgetResourceName: operation?.campaignBudgetResourceName ?? null,
                  previousAmount: operation?.previousAmount ?? null,
                })),
              }
            : {
                campaignBudgetResourceName:
                  input.rollbackPayloadPreview?.campaignBudgetResourceName ??
                  result.resourceNames[0] ??
                  null,
                previousAmount: input.rollbackPayloadPreview?.previousAmount ?? null,
              }
          : input.rollbackActionType === "restore_portfolio_target"
            ? {
                portfolioBidStrategyResourceName:
                  input.rollbackPayloadPreview?.portfolioBidStrategyResourceName ??
                  result.resourceNames[0] ??
                  null,
                portfolioTargetType: input.rollbackPayloadPreview?.portfolioTargetType ?? null,
                previousValue: input.rollbackPayloadPreview?.previousValue ?? null,
              }
          : input.rollbackPayloadPreview ?? null;
  await updateAdvisorExecutionState({
    businessId: input.businessId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    executionStatus: "applied",
    rollbackAvailable: Boolean(input.rollbackActionType),
    executionMetadata: {
      mutateActionType: input.mutateActionType,
      rollbackActionType: input.rollbackActionType ?? null,
      rollbackPayloadPreview,
      resourceNames: result.resourceNames,
      policyPatternKey: input.mutatePayloadPreview?.policyPatternKey ?? null,
      executionTrustBand: input.executionTrustBand ?? null,
      dependencyReadiness: input.dependencyReadiness ?? null,
      transactionId,
      batchStatus: "applied",
      batchSize: Array.isArray(input.mutatePayloadPreview?.operations)
        ? input.mutatePayloadPreview.operations.length
        : null,
      batchRollbackAvailable: Boolean(input.rollbackActionType),
      ...input.extraMetadata,
    },
  });
  await updateAdvisorMemoryAction({
    businessId: input.businessId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    action: "applied",
  });
  await updateAdvisorCompletionState({
    businessId: input.businessId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    completionMode: "full",
    completedStepCount: 1,
    totalStepCount: 1,
    completedStepIds: ["execute_mutate"],
    skippedStepIds: [],
    coreStepIds: ["execute_mutate"],
  });
  await logAdvisorExecutionEvent({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    mutateActionType: input.mutateActionType,
    operation: "apply",
    status: "applied",
    payload: input.mutatePayloadPreview,
    response: { resourceNames: result.resourceNames, transactionId, ...input.extraMetadata },
  });
  return { transactionId, executionStatus: "applied" as const, rollbackPayloadPreview };
}

async function rollbackSingleMutateInternal(input: {
  businessId: string;
  /** The authorizing session's user id; see `applyBatchMutateInternal`. */
  actorUserId: string | null;
  accountId: string;
  recommendationFingerprint: string;
  rollbackActionType: NonNullable<NonNullable<RequestBody>["rollbackActionType"]>;
  rollbackPayloadPreview: Record<string, unknown>;
  transactionId?: string | null;
  extraMetadata?: Record<string, unknown>;
}) {
  const response = await rollbackAdvisorMutation({
    businessId: input.businessId,
    accountId: input.accountId,
    actionType: input.rollbackActionType,
    payload: input.rollbackPayloadPreview,
  });
  await updateAdvisorExecutionState({
    businessId: input.businessId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    executionStatus: "rolled_back",
    rollbackAvailable: false,
    rollbackExecutedAt: new Date().toISOString(),
    executionMetadata: {
      rolledBack: true,
      transactionId: input.transactionId ?? null,
      batchStatus: "rolled_back",
      ...input.extraMetadata,
    },
  });
  await logAdvisorExecutionEvent({
    businessId: input.businessId,
    actorUserId: input.actorUserId,
    accountId: input.accountId,
    recommendationFingerprint: input.recommendationFingerprint,
    mutateActionType: input.rollbackActionType,
    operation: "rollback",
    status: "rolled_back",
    payload: input.rollbackPayloadPreview,
    response,
  });
  return { ok: true as const, executionStatus: "rolled_back" as const, retryable: false as const };
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as RequestBody;
  const businessId = body?.businessId ?? null;
  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;

  // The author of every guarded write below, taken from the authorized session
  // and nowhere else — the request body never names the actor.
  const actorUserId = access.session?.user?.id ?? null;

  if (await isDemoBusiness(businessId)) {
    if (body?.action) {
      return NextResponse.json(
        {
          error: "Advisor memory is read-only for demo businesses.",
          code: "demo_read_only",
        },
        { status: 403 },
      );
    }
    return NextResponse.json({ ok: true, demo: true });
  }

  if (isWritebackExecutionRequested(body)) {
    const capabilityGate = getGoogleAdsWritebackCapabilityGate();
    if (!capabilityGate.enabled) {
      return NextResponse.json(
        {
          error: capabilityGate.reason,
          capabilityGate,
        },
        { status: 403 }
      );
    }
  }

  const topLevelAccountId = body?.accountId ?? "all";

  if (body?.executionAction === "execute_cluster") {
    if (!body.cluster || !body.accountId || body.accountId === "all") {
      return NextResponse.json({ error: "accountId and cluster are required for cluster execution." }, { status: 400 });
    }
    const clusterExecutionId = `cluster-exec-${randomUUID()}`;
    const jointSequenceStateByFingerprint = new Map<string, Array<Record<string, unknown>>>();
    for (const step of body.cluster.steps) {
      if (!step.mutateItem?.sequenceKey) continue;
      const fingerprint = step.mutateItem.recommendationFingerprint;
      const current = jointSequenceStateByFingerprint.get(fingerprint) ?? [];
      current.push({
        stepKey: step.mutateItem.sequenceKey,
        title: step.title,
        mutateActionType: step.mutateItem.mutateActionType,
        rollbackActionType: step.mutateItem.rollbackActionType ?? null,
        rollbackPayloadPreview: step.mutateItem.rollbackPayloadPreview ?? null,
        transactionIds: step.transactionIds ?? [],
        executionStatus: (step.transactionIds?.length ?? 0) > 0 ? "applied" : "not_started",
      });
      jointSequenceStateByFingerprint.set(fingerprint, current);
    }
    const clusterExecution = await executeActionCluster({
      cluster: body.cluster,
      clusterExecutionId,
      applyBatchStep: async (step: GoogleActionClusterStep) => {
        const batchItems = step.batchItems ?? [];
        const result = await applyBatchMutateInternal({
          businessId,
          actorUserId,
          items: batchItems.map((item) => ({ ...item, accountId: body.accountId! })),
          extraMetadata: {
            clusterId: body.cluster?.clusterId,
            clusterExecutionId,
            clusterStepId: step.stepId,
          },
        });
        return { transactionId: result.transactionId, ok: result.batchStatus !== "failed" };
      },
      applyMutateStep: async (step: GoogleActionClusterStep) => {
        if (!step.mutateItem) {
          throw new Error("Missing mutate payload for cluster step.");
        }
        const result = await applySingleMutateInternal({
          businessId,
          actorUserId,
          accountId: body.accountId!,
          recommendationFingerprint: step.mutateItem.recommendationFingerprint,
          mutateActionType: step.mutateItem.mutateActionType,
          mutatePayloadPreview: step.mutateItem.mutatePayloadPreview,
          rollbackActionType: step.mutateItem.rollbackActionType ?? undefined,
          rollbackPayloadPreview: step.mutateItem.rollbackPayloadPreview ?? undefined,
          executionTrustBand: step.mutateItem.executionTrustBand ?? null,
          dependencyReadiness: step.mutateItem.dependencyReadiness ?? null,
          stabilizationHoldUntil: step.mutateItem.stabilizationHoldUntil ?? null,
          extraMetadata: {
            clusterId: body.cluster?.clusterId,
            clusterExecutionId,
            clusterStepId: step.stepId,
          },
        });
        if (step.mutateItem.sequenceKey) {
          const fingerprint = step.mutateItem.recommendationFingerprint;
          const current = jointSequenceStateByFingerprint.get(fingerprint) ?? [];
          const next = current.map((entry) =>
            String(entry.stepKey ?? "") === step.mutateItem?.sequenceKey
              ? {
                  ...entry,
                  rollbackPayloadPreview: result.rollbackPayloadPreview ?? entry.rollbackPayloadPreview ?? null,
                  transactionIds: [result.transactionId],
                  executionStatus: "applied",
                }
              : entry
          );
          jointSequenceStateByFingerprint.set(fingerprint, next);
          const completedStepIds = next
            .filter((entry) => String(entry.executionStatus ?? "") === "applied")
            .map((entry) => String(entry.stepKey ?? ""))
            .filter(Boolean);
          const totalStepCount = next.length;
          await updateAdvisorExecutionState({
            businessId,
            accountId: body.accountId!,
            recommendationFingerprint: fingerprint,
            executionStatus: "applied",
            rollbackAvailable: true,
            executionMetadata: {
              mutateActionType: step.mutateItem.mutateActionType,
              rollbackActionType: step.mutateItem.rollbackActionType ?? null,
              rollbackPayloadPreview: result.rollbackPayloadPreview ?? step.mutateItem.rollbackPayloadPreview ?? null,
              policyPatternKey:
                typeof step.mutateItem.mutatePayloadPreview?.policyPatternKey === "string"
                  ? `${step.mutateItem.mutatePayloadPreview.policyPatternKey}|joint_allocator`
                  : null,
              executionTrustBand: step.mutateItem.executionTrustBand ?? null,
              transactionId: result.transactionId,
              batchStatus: "applied",
              batchSize: totalStepCount,
              batchRollbackAvailable: true,
              clusterId: body.cluster?.clusterId,
              clusterExecutionId,
              clusterStepId: step.stepId,
              jointExecutionSequenceState: next,
            },
          });
          await updateAdvisorCompletionState({
            businessId,
            accountId: body.accountId!,
            recommendationFingerprint: fingerprint,
            completionMode: completedStepIds.length === totalStepCount ? "full" : "partial",
            completedStepCount: completedStepIds.length,
            totalStepCount,
            completedStepIds,
            skippedStepIds: [],
            coreStepIds: next.map((entry) => String(entry.stepKey ?? "")).filter(Boolean),
          });
        }
        return { transactionId: result.transactionId, ok: true };
      },
    });

    await logAdvisorExecutionEvent({
      businessId,
      actorUserId,
      accountId: body.accountId,
      recommendationFingerprint: `cluster:${body.cluster.clusterId}`,
      mutateActionType: "cluster_execute",
      operation: "apply",
      status: clusterExecution.clusterExecutionStatus,
      payload: {
        clusterId: body.cluster.clusterId,
        childExecutionOrder: body.cluster.executionSummary.childExecutionOrder,
      },
      response: clusterExecution,
    });

    return NextResponse.json({ ok: true, ...clusterExecution });
  }

  if (body?.executionAction === "rollback_cluster") {
    if (!body.cluster || !body.accountId || body.accountId === "all") {
      return NextResponse.json({ error: "accountId and cluster are required for cluster rollback." }, { status: 400 });
    }
    const clusterRollbackId = `cluster-rollback-${randomUUID()}`;
    const jointSequenceStateByFingerprint = new Map<string, Array<Record<string, unknown>>>();
    for (const step of body.cluster.steps) {
      if (!step.mutateItem?.sequenceKey) continue;
      const fingerprint = step.mutateItem.recommendationFingerprint;
      const current = jointSequenceStateByFingerprint.get(fingerprint) ?? [];
      current.push({
        stepKey: step.mutateItem.sequenceKey,
        title: step.title,
        mutateActionType: step.mutateItem.mutateActionType,
        rollbackActionType: step.mutateItem.rollbackActionType ?? null,
        rollbackPayloadPreview: step.mutateItem.rollbackPayloadPreview ?? null,
        transactionIds: step.transactionIds ?? [],
        executionStatus: (step.transactionIds?.length ?? 0) > 0 ? "applied" : "not_started",
      });
      jointSequenceStateByFingerprint.set(fingerprint, current);
    }
    const rollback = await rollbackActionCluster({
      cluster: body.cluster,
      rollbackBatchStep: async (step: GoogleActionClusterStep) => {
        const batchItems = (step.batchItems ?? []).map((item) => ({ ...item, accountId: body.accountId! }));
        const transactionId = step.transactionIds?.[0] ?? randomUUID();
        const result = await rollbackBatchMutateInternal({
          businessId,
          actorUserId,
          transactionId,
          items: batchItems,
          extraMetadata: {
            clusterId: body.cluster?.clusterId,
            clusterRollbackId,
            clusterStepId: step.stepId,
          },
        });
        return {
          ok: result.batchStatus === "rolled_back",
          errorMessage: result.results.find((entry) => !entry.ok)?.error ?? null,
          retryable: result.retryable,
        };
      },
      rollbackMutateStep: async (step: GoogleActionClusterStep) => {
        if (!step.mutateItem?.rollbackActionType || !step.mutateItem.rollbackPayloadPreview) {
          return { ok: false, errorMessage: "Rollback payload is missing for this cluster step.", retryable: false };
        }
        try {
          const result = await rollbackSingleMutateInternal({
            businessId,
            actorUserId,
            accountId: body.accountId!,
            recommendationFingerprint: step.mutateItem.recommendationFingerprint,
            rollbackActionType: step.mutateItem.rollbackActionType,
            rollbackPayloadPreview: step.mutateItem.rollbackPayloadPreview,
            transactionId: step.transactionIds?.[0] ?? null,
            extraMetadata: {
              clusterId: body.cluster?.clusterId,
              clusterRollbackId,
              clusterStepId: step.stepId,
            },
          });
          if (result.ok && step.mutateItem.sequenceKey) {
            const fingerprint = step.mutateItem.recommendationFingerprint;
            const current = jointSequenceStateByFingerprint.get(fingerprint) ?? [];
            const next = current.map((entry) =>
              String(entry.stepKey ?? "") === step.mutateItem?.sequenceKey
                ? {
                    ...entry,
                    executionStatus: "rolled_back",
                  }
                : entry
            );
            jointSequenceStateByFingerprint.set(fingerprint, next);
            await updateAdvisorExecutionState({
              businessId,
              accountId: body.accountId!,
              recommendationFingerprint: fingerprint,
              executionStatus: "rolled_back",
              rollbackAvailable: false,
              rollbackExecutedAt: new Date().toISOString(),
              executionMetadata: {
                rolledBack: true,
                transactionId: step.transactionIds?.[0] ?? null,
                batchStatus: "rolled_back",
                clusterId: body.cluster?.clusterId,
                clusterRollbackId,
                clusterStepId: step.stepId,
                jointExecutionSequenceState: next,
              },
            });
          }
          return { ok: result.ok, errorMessage: null, retryable: result.retryable };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Rollback failed.";
          return { ok: false, errorMessage: message, retryable: retryableRollbackError(message) };
        }
      },
    });

    await logAdvisorExecutionEvent({
      businessId,
      actorUserId,
      accountId: body.accountId,
      recommendationFingerprint: `cluster:${body.cluster.clusterId}`,
      mutateActionType: "cluster_rollback",
      operation: "rollback",
      status: rollback.clusterExecutionStatus,
      payload: {
        clusterId: body.cluster.clusterId,
        childExecutionOrder: body.cluster.executionSummary.childExecutionOrder,
      },
      response: rollback,
    });
    return NextResponse.json({ ...rollback, ok: true });
  }

  if (body?.batchExecutionAction === "apply_batch_mutate") {
    try {
      const result = await applyBatchMutateInternal({
        businessId,
        actorUserId,
        items: Array.isArray(body.batchItems) ? body.batchItems : [],
        transactionId: body.transactionId,
      });
      return NextResponse.json({ ...result, ok: true });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Batch mutate failed." }, { status: 400 });
    }
  }

  if (body?.executionAction === "rollback_batch_mutate") {
    const transactionId = body.transactionId ?? null;
    const items = Array.isArray(body.batchItems) ? body.batchItems : [];
    if (!transactionId || items.length === 0) {
      return NextResponse.json({ error: "transactionId and batchItems are required for batch rollback." }, { status: 400 });
    }
    const result = await rollbackBatchMutateInternal({
      businessId,
      actorUserId,
      transactionId,
      items,
    });
    return NextResponse.json({ ...result, ok: true });
  }

  if (body?.executionAction === "apply_mutate") {
    if (!body.mutateActionType || !body.mutatePayloadPreview || !body.accountId || body.accountId === "all") {
      return NextResponse.json({ error: "accountId, mutateActionType and mutatePayloadPreview are required" }, { status: 400 });
    }
    try {
      const result = await applySingleMutateInternal({
        businessId,
        actorUserId,
        accountId: body.accountId,
        recommendationFingerprint: body.recommendationFingerprint ?? "",
        mutateActionType: body.mutateActionType,
        mutatePayloadPreview: body.mutatePayloadPreview,
        rollbackActionType: body.rollbackActionType ?? undefined,
        rollbackPayloadPreview: body.rollbackPayloadPreview ?? undefined,
        executionTrustBand: body.executionTrustBand ?? null,
        dependencyReadiness: body.dependencyReadiness ?? null,
        stabilizationHoldUntil: body.stabilizationHoldUntil ?? null,
        transactionId: body.transactionId ?? null,
      });
      return NextResponse.json({ ...result, ok: true });
    } catch (error) {
      // A selection-authority refusal is not a bad request. 409 says the
      // account is no longer selected and retrying will not help; 503 says the
      // answer could not be read and retrying might.
      if (isGoogleAdsAccountAuthorityError(error)) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.httpStatus },
        );
      }
      return NextResponse.json({ error: error instanceof Error ? error.message : "Mutate failed." }, { status: 400 });
    }
  }

  if (body?.executionAction === "rollback_mutate") {
    if (!body.rollbackActionType || !body.rollbackPayloadPreview || !body.accountId || body.accountId === "all") {
      return NextResponse.json({ error: "accountId, rollbackActionType and rollbackPayloadPreview are required" }, { status: 400 });
    }
    try {
      const result = await rollbackSingleMutateInternal({
        businessId,
        actorUserId,
        accountId: body.accountId,
        recommendationFingerprint: body.recommendationFingerprint ?? "",
        rollbackActionType: body.rollbackActionType,
        rollbackPayloadPreview: body.rollbackPayloadPreview,
        transactionId: body.transactionId ?? null,
      });
      return NextResponse.json({ ...result, ok: true });
    } catch (error) {
      if (isGoogleAdsAccountAuthorityError(error)) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.httpStatus },
        );
      }
      return NextResponse.json({ error: error instanceof Error ? error.message : "Rollback failed." }, { status: 400 });
    }
  }

  if (body?.executionAction === "mark_completion") {
    if (!body.recommendationFingerprint) {
      return NextResponse.json({ error: "recommendationFingerprint is required" }, { status: 400 });
    }
    await updateAdvisorCompletionState({
      businessId,
      accountId: topLevelAccountId,
      recommendationFingerprint: body.recommendationFingerprint,
      completionMode: body.completionMode ?? "unknown",
      completedStepCount: body.completedStepCount ?? null,
      totalStepCount: body.totalStepCount ?? null,
      completedStepIds: body.completedStepIds ?? null,
      skippedStepIds: body.skippedStepIds ?? null,
      coreStepIds: body.coreStepIds ?? null,
    });
    if (body.completionMode === "full" || body.completionMode === "partial") {
      await updateAdvisorMemoryAction({
        businessId,
        accountId: topLevelAccountId,
        recommendationFingerprint: body.recommendationFingerprint,
        action: "applied",
      });
      await appendGoogleAdsDecisionActionOutcomeLog({
        businessId,
        providerAccountId: topLevelAccountId === "all" ? null : topLevelAccountId,
        recommendationFingerprint: body.recommendationFingerprint,
        decisionFamily: null,
        actionType: "plan",
        outcomeStatus: "manual_completion_recorded",
        summary:
          body.completionMode === "partial"
            ? "Operator recorded partial manual completion."
            : "Operator recorded full manual completion.",
        payloadJson: {
          completionMode: body.completionMode ?? "unknown",
          completedStepCount: body.completedStepCount ?? null,
          totalStepCount: body.totalStepCount ?? null,
          completedStepIds: body.completedStepIds ?? null,
          skippedStepIds: body.skippedStepIds ?? null,
          coreStepIds: body.coreStepIds ?? null,
        },
        occurredAt: new Date().toISOString(),
      }).catch(() => null);
    }
    return NextResponse.json({ ok: true });
  }

  if (body?.executionAction === "record_outcome") {
    if (!body.recommendationFingerprint || !body.outcomeVerdict) {
      return NextResponse.json(
        { error: "recommendationFingerprint and outcomeVerdict are required" },
        { status: 400 }
      );
    }
    await recordAdvisorOutcome({
      businessId,
      accountId: topLevelAccountId,
      recommendationFingerprint: body.recommendationFingerprint,
      verdict: body.outcomeVerdict,
      metric: body.outcomeMetric ?? null,
      delta:
        typeof body.outcomeDelta === "number" && Number.isFinite(body.outcomeDelta)
          ? body.outcomeDelta
          : null,
      confidence: body.outcomeConfidence ?? null,
      failReason: body.outcomeVerdictFailReason ?? null,
      outcomeCheckWindowDays: body.outcomeCheckWindowDays ?? null,
      occurredAt: body.outcomeOccurredAt ?? null,
    });
    await appendGoogleAdsDecisionActionOutcomeLog({
      businessId,
      providerAccountId: topLevelAccountId === "all" ? null : topLevelAccountId,
      recommendationFingerprint: body.recommendationFingerprint,
      decisionFamily: null,
      actionType: "outcome",
      outcomeStatus: body.outcomeVerdict,
      summary:
        body.outcomeSummary?.trim() ||
        `Operator recorded a ${body.outcomeVerdict} manual outcome assessment.`,
      payloadJson: {
        metric: body.outcomeMetric ?? "manual_validation",
        delta:
          typeof body.outcomeDelta === "number" && Number.isFinite(body.outcomeDelta)
            ? body.outcomeDelta
            : null,
        confidence: body.outcomeConfidence ?? null,
        failReason: body.outcomeVerdictFailReason ?? null,
        outcomeCheckWindowDays: body.outcomeCheckWindowDays ?? null,
      },
      occurredAt: body.outcomeOccurredAt ?? new Date().toISOString(),
    }).catch(() => null);
    return NextResponse.json({ ok: true });
  }

  if (!body?.recommendationFingerprint) {
    return NextResponse.json({ error: "recommendationFingerprint is required" }, { status: 400 });
  }
  if (!body?.action) {
    return NextResponse.json({ error: "action or executionAction is required" }, { status: 400 });
  }
  if (!["dismissed", "ignored", "applied", "unsuppress"].includes(body.action)) {
    return NextResponse.json({ error: "Unsupported advisor memory action." }, { status: 400 });
  }

  if (!body.accountId || body.accountId === "all") {
    return NextResponse.json(
      {
        error: "A selected Google Ads account is required for advisor memory actions.",
        code: "google_ads_account_scope_required",
      },
      { status: 400 },
    );
  }
  try {
    await assertGoogleAdsAccountAuthority({
      businessId,
      accountId: body.accountId,
    });
  } catch (error) {
    if (isGoogleAdsAccountAuthorityError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    throw error;
  }

  const memoryUpdate = await updateAdvisorMemoryAction({
    businessId,
    accountId: body.accountId,
    recommendationFingerprint: body.recommendationFingerprint,
    action: body.action,
    dismissReason: body.dismissReason ?? null,
    suppressUntil: body.suppressUntil ?? null,
  });
  if (
    !memoryUpdate.matched ||
    memoryUpdate.recommendationFingerprint !== body.recommendationFingerprint
  ) {
    return NextResponse.json(
      {
        error: "The recommendation is no longer present in this account.",
        code: "advisor_recommendation_not_found",
      },
      { status: 404 },
    );
  }
  if (
    body.action === "dismissed" &&
    (memoryUpdate.currentStatus !== "suppressed" ||
      memoryUpdate.userAction !== "dismissed")
  ) {
    return NextResponse.json(
      {
        error: "The dismissal could not be verified after the memory write.",
        code: "advisor_memory_write_unverified",
      },
      { status: 409 },
    );
  }
  if (body.action === "applied" || body.action === "dismissed" || body.action === "unsuppress") {
    await appendGoogleAdsDecisionActionOutcomeLog({
      businessId,
      providerAccountId: body.accountId,
      recommendationFingerprint: body.recommendationFingerprint,
      decisionFamily: null,
      actionType: "plan",
      outcomeStatus:
        body.action === "dismissed"
          ? "dismissed"
          : body.action === "unsuppress"
            ? "reopened"
            : "applied",
      summary:
        body.action === "dismissed"
          ? "Operator suppressed the recommendation from the queue."
          : body.action === "unsuppress"
            ? "Operator returned the recommendation to the active queue."
            : "Operator marked the recommendation as manually applied.",
      payloadJson: {
        dismissReason: body.dismissReason ?? null,
        suppressUntil: body.suppressUntil ?? null,
      },
      occurredAt: new Date().toISOString(),
    }).catch(() => null);
  }

  return NextResponse.json({
    ok: true,
    action: body.action,
    accountId: body.accountId,
    recommendationFingerprint: memoryUpdate.recommendationFingerprint,
    currentStatus: memoryUpdate.currentStatus,
    suppressUntil: memoryUpdate.suppressUntil,
  });
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;
  if (await isDemoBusiness(businessId)) {
    return NextResponse.json({ ok: true, demo: true, calibration: null });
  }
  const calibration = await getAdvisorExecutionCalibration({
    businessId,
    accountId,
  });
  return NextResponse.json({ ok: true, calibration });
}
