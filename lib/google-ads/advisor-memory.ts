import { getDb } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";
import type {
  GoogleCompletionMode,
  GoogleExecutionStatus,
  GoogleOutcomeConfidence,
  GoogleOutcomeVerdict,
  GoogleOutcomeVerdictFailReason,
  GoogleRecommendation,
  GoogleRecommendationMemoryStatus,
} from "@/lib/google-ads/growth-advisor-types";

interface RecommendationMemoryRow {
  business_id: string;
  account_id: string;
  recommendation_fingerprint: string;
  recommendation_type: string;
  entity_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  prior_status: GoogleRecommendationMemoryStatus | null;
  current_status: GoogleRecommendationMemoryStatus;
  seen_count: number;
  last_do_bucket: GoogleRecommendation["doBucket"];
  user_action: "applied" | "dismissed" | "ignored" | null;
  dismiss_reason: string | null;
  suppress_until: string | null;
  applied_at: string | null;
  outcome_check_at: string | null;
  outcome_check_window_days: number | null;
  outcome_verdict: GoogleOutcomeVerdict | null;
  outcome_metric: string | null;
  outcome_delta: number | null;
  outcome_verdict_fail_reason: GoogleOutcomeVerdictFailReason | null;
  outcome_confidence: GoogleOutcomeConfidence | null;
  execution_status: GoogleExecutionStatus | null;
  executed_at: string | null;
  execution_error: string | null;
  rollback_available: boolean | null;
  rollback_executed_at: string | null;
  completion_mode: GoogleCompletionMode | null;
  completed_step_count: number | null;
  total_step_count: number | null;
  completed_step_ids: string[] | null;
  skipped_step_ids: string[] | null;
  core_step_ids: string[] | null;
  execution_metadata: Record<string, unknown> | null;
  applied_snapshot: Record<string, unknown> | null;
  recommendation_snapshot: Record<string, unknown> | null;
}

function mergeStoredMemoryFields(
  recommendation: GoogleRecommendation,
  row: RecommendationMemoryRow
): GoogleRecommendation {
  return {
    ...recommendation,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    priorStatus: row.prior_status,
    currentStatus: row.current_status,
    seenCount: row.seen_count,
    userAction: row.user_action,
    dismissReason: row.dismiss_reason,
    suppressUntil: row.suppress_until,
    appliedAt: row.applied_at,
    outcomeCheckAt: row.outcome_check_at,
    outcomeCheckWindowDays: row.outcome_check_window_days,
    outcomeVerdict: row.outcome_verdict,
    outcomeMetric: row.outcome_metric,
    outcomeDelta: row.outcome_delta,
    outcomeVerdictFailReason: row.outcome_verdict_fail_reason,
    outcomeConfidence: row.outcome_confidence,
    executionStatus: row.execution_status,
    executedAt: row.executed_at,
    executionError: row.execution_error,
    rollbackAvailable: row.rollback_available,
    rollbackExecutedAt: row.rollback_executed_at,
    sharedBudgetAdjustmentPreview:
      row.execution_metadata?.sharedBudgetAdjustmentPreview as GoogleRecommendation["sharedBudgetAdjustmentPreview"],
    portfolioTargetAdjustmentPreview:
      row.execution_metadata?.portfolioTargetAdjustmentPreview as GoogleRecommendation["portfolioTargetAdjustmentPreview"],
    jointExecutionSequence: mergeJointExecutionSequence(
      recommendation.jointExecutionSequence ?? null,
      row.execution_metadata?.jointExecutionSequenceState
    ),
    jointAllocatorAdjustmentPreview:
      (row.execution_metadata?.jointAllocatorAdjustmentPreview as GoogleRecommendation["jointAllocatorAdjustmentPreview"]) ??
      recommendation.jointAllocatorAdjustmentPreview ??
      null,
    jointAllocatorBlockedReason:
      String(row.execution_metadata?.jointAllocatorBlockedReason ?? "") ||
      recommendation.jointAllocatorBlockedReason ||
      null,
    jointAllocatorCautionReason:
      String(row.execution_metadata?.jointAllocatorCautionReason ?? "") ||
      recommendation.jointAllocatorCautionReason ||
      null,
    rollbackSafetyState:
      (String(row.execution_metadata?.rollbackSafetyState ?? "") || null) as GoogleRecommendation["rollbackSafetyState"],
    rollbackAvailableUntil: String(row.execution_metadata?.rollbackAvailableUntil ?? "") || null,
    completionMode: row.completion_mode,
    completedStepCount: row.completed_step_count,
    totalStepCount: row.total_step_count,
    completedStepIds: row.completed_step_ids ?? undefined,
    skippedStepIds: row.skipped_step_ids ?? undefined,
    coreStepIds: row.core_step_ids ?? recommendation.coreStepIds ?? undefined,
    transactionId: String(row.execution_metadata?.transactionId ?? "") || null,
    batchStatus: (String(row.execution_metadata?.batchStatus ?? "") || null) as GoogleRecommendation["batchStatus"],
    batchSize: Number.isFinite(Number(row.execution_metadata?.batchSize ?? NaN))
      ? Number(row.execution_metadata?.batchSize)
      : null,
    batchRollbackAvailable:
      typeof row.execution_metadata?.batchRollbackAvailable === "boolean"
        ? Boolean(row.execution_metadata?.batchRollbackAvailable)
        : null,
    clusterId: String(row.execution_metadata?.clusterId ?? "") || null,
    clusterExecutionId: String(row.execution_metadata?.clusterExecutionId ?? "") || null,
    clusterStepId: String(row.execution_metadata?.clusterStepId ?? "") || null,
    clusterMoveValidity:
      (String(row.execution_metadata?.clusterMoveValidity ?? "") || null) as GoogleRecommendation["clusterMoveValidity"],
    recoveryState:
      (String(row.execution_metadata?.recoveryState ?? "") || null) as GoogleRecommendation["recoveryState"],
    recoveryRecommendedAction: String(row.execution_metadata?.recoveryRecommendedAction ?? "") || null,
    rollbackRecoveryAvailable:
      typeof row.execution_metadata?.rollbackRecoveryAvailable === "boolean"
        ? Boolean(row.execution_metadata?.rollbackRecoveryAvailable)
        : null,
    sharedStateGovernanceType:
      (String(row.execution_metadata?.sharedStateGovernanceType ?? "") || null) as GoogleRecommendation["sharedStateGovernanceType"],
    sharedStateAwarenessStatus:
      (String(row.execution_metadata?.sharedStateAwarenessStatus ?? "") || null) as GoogleRecommendation["sharedStateAwarenessStatus"],
    allocatorCoupled:
      typeof row.execution_metadata?.allocatorCoupled === "boolean"
        ? Boolean(row.execution_metadata?.allocatorCoupled)
        : null,
    allocatorCouplingConfidence:
      (String(row.execution_metadata?.allocatorCouplingConfidence ?? "") || null) as GoogleRecommendation["allocatorCouplingConfidence"],
    governedEntityCount: Number.isFinite(Number(row.execution_metadata?.governedEntityCount ?? NaN))
      ? Number(row.execution_metadata?.governedEntityCount)
      : null,
    sharedBudgetResourceName: String(row.execution_metadata?.sharedBudgetResourceName ?? "") || null,
    portfolioBidStrategyType: String(row.execution_metadata?.portfolioBidStrategyType ?? "") || null,
    portfolioBidStrategyResourceName: String(row.execution_metadata?.portfolioBidStrategyResourceName ?? "") || null,
    portfolioBidStrategyStatus:
      (String(row.execution_metadata?.portfolioBidStrategyStatus ?? "") || null) as GoogleRecommendation["portfolioBidStrategyStatus"],
    portfolioTargetType: String(row.execution_metadata?.portfolioTargetType ?? "") || null,
    portfolioTargetValue: Number.isFinite(Number(row.execution_metadata?.portfolioTargetValue ?? NaN))
      ? Number(row.execution_metadata?.portfolioTargetValue)
      : null,
    portfolioGovernanceStatus:
      (String(row.execution_metadata?.portfolioGovernanceStatus ?? "") || null) as GoogleRecommendation["portfolioGovernanceStatus"],
    portfolioCouplingStrength:
      (String(row.execution_metadata?.portfolioCouplingStrength ?? "") || null) as GoogleRecommendation["portfolioCouplingStrength"],
    portfolioCampaignShare: Number.isFinite(Number(row.execution_metadata?.portfolioCampaignShare ?? NaN))
      ? Number(row.execution_metadata?.portfolioCampaignShare)
      : null,
    portfolioDominance:
      (String(row.execution_metadata?.portfolioDominance ?? "") || null) as GoogleRecommendation["portfolioDominance"],
    portfolioContaminationSource:
      (String(row.execution_metadata?.portfolioContaminationSource ?? "") || null) as GoogleRecommendation["portfolioContaminationSource"],
    portfolioContaminationSeverity:
      (String(row.execution_metadata?.portfolioContaminationSeverity ?? "") || null) as GoogleRecommendation["portfolioContaminationSeverity"],
    portfolioCascadeRiskBand:
      (String(row.execution_metadata?.portfolioCascadeRiskBand ?? "") || null) as GoogleRecommendation["portfolioCascadeRiskBand"],
    portfolioAttributionWindowDays: Number.isFinite(Number(row.execution_metadata?.portfolioAttributionWindowDays ?? NaN))
      ? Number(row.execution_metadata?.portfolioAttributionWindowDays)
      : null,
    portfolioBlockedReason: String(row.execution_metadata?.portfolioBlockedReason ?? "") || null,
    portfolioCautionReason: String(row.execution_metadata?.portfolioCautionReason ?? "") || null,
    portfolioUnlockGuidance: String(row.execution_metadata?.portfolioUnlockGuidance ?? "") || null,
    coupledCampaignIds: Array.isArray(row.execution_metadata?.coupledCampaignIds)
      ? row.execution_metadata?.coupledCampaignIds.filter((value): value is string => typeof value === "string")
      : undefined,
    coupledCampaignNames: Array.isArray(row.execution_metadata?.coupledCampaignNames)
      ? row.execution_metadata?.coupledCampaignNames.filter((value): value is string => typeof value === "string")
      : undefined,
    sharedStateMutateBlockedReason: String(row.execution_metadata?.sharedStateMutateBlockedReason ?? "") || null,
    sharedStateContaminationFlag:
      typeof row.execution_metadata?.sharedStateContaminationFlag === "boolean"
        ? Boolean(row.execution_metadata?.sharedStateContaminationFlag)
        : null,
    baselineSnapshot: row.applied_snapshot,
  };
}

const globalStore = globalThis as typeof globalThis & {
  __googleAdvisorMemoryFallback?: Map<string, Map<string, RecommendationMemoryRow>>;
};
const GOOGLE_ADVISOR_MEMORY_TABLES = ["google_ads_advisor_memory"] as const;
const GOOGLE_ADVISOR_EXECUTION_LOG_TABLES = [
  "google_ads_advisor_execution_logs",
] as const;

function getFallbackStore() {
  if (!globalStore.__googleAdvisorMemoryFallback) {
    globalStore.__googleAdvisorMemoryFallback = new Map();
  }
  return globalStore.__googleAdvisorMemoryFallback;
}

async function getAdvisorMemorySchemaReadiness() {
  return getDbSchemaReadiness({
    tables: [...GOOGLE_ADVISOR_MEMORY_TABLES],
  }).catch(() => null);
}

async function assertAdvisorMemoryTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: [...GOOGLE_ADVISOR_MEMORY_TABLES],
    context,
  });
}

async function assertAdvisorExecutionLogTableReady(context: string) {
  await assertDbSchemaReady({
    tables: [...GOOGLE_ADVISOR_EXECUTION_LOG_TABLES],
    context,
  });
}

async function resolveGoogleAdsAdvisorReferenceContext(input: {
  businessId: string;
  accountId?: string | null;
}) {
  const [businessRefIds, providerAccountRefIds] = await Promise.all([
    resolveBusinessReferenceIds([input.businessId]),
    input.accountId
      ? ensureProviderAccountReferenceIds({
          provider: "google",
          accounts: [
            {
              externalAccountId: input.accountId,
            },
          ],
        })
      : Promise.resolve(new Map<string, string>()),
  ]);

  return {
    businessRefId: businessRefIds.get(input.businessId) ?? null,
    providerAccountRefId: input.accountId
      ? (providerAccountRefIds.get(input.accountId) ?? null)
      : null,
  };
}

function bucketWeight(bucket: GoogleRecommendation["doBucket"]) {
  return bucket === "do_now" ? 0 : bucket === "do_next" ? 1 : 2;
}

function integrityWeight(state: GoogleRecommendation["integrityState"]) {
  return state === "ready" ? 3 : state === "downgraded" ? 2 : state === "blocked" ? 1 : 0;
}

function severityScore(snapshot: Record<string, unknown> | null | undefined) {
  if (!snapshot) return null;
  const bucket = String(snapshot.doBucket ?? "do_later") as GoogleRecommendation["doBucket"];
  const rankScore = Number(snapshot.rankScore ?? 0);
  const integrityState = String(snapshot.integrityState ?? "ready") as GoogleRecommendation["integrityState"];
  return Number((((2 - bucketWeight(bucket)) * 10) + rankScore + integrityWeight(integrityState) * 2).toFixed(2));
}

function shouldEscalate(previous: RecommendationMemoryRow | undefined, seenCount: number) {
  if (previous?.user_action) return false;
  return seenCount >= 5;
}

function deriveStatus(
  previous: RecommendationMemoryRow | undefined,
  recommendation: GoogleRecommendation,
  seenCount: number
): GoogleRecommendationMemoryStatus {
  if (!previous) return "new";
  if (previous.current_status === "resolved") return "new";
  if (shouldEscalate(previous, seenCount)) return "escalated";
  if (bucketWeight(recommendation.doBucket) < bucketWeight(previous.last_do_bucket)) return "escalated";
  if (bucketWeight(recommendation.doBucket) > bucketWeight(previous.last_do_bucket)) return "downgraded";
  return "persistent";
}

function shouldSuppress(previous: RecommendationMemoryRow | undefined, nowIso: string) {
  if (!previous) return false;
  if (previous.user_action !== "dismissed") return false;
  if (!previous.suppress_until) return true;
  return previous.suppress_until > nowIso;
}

function safeSnapshot(recommendation: GoogleRecommendation) {
  return {
    id: recommendation.id,
    title: recommendation.title,
    decisionState: recommendation.decisionState,
    doBucket: recommendation.doBucket,
    rankScore: recommendation.rankScore,
    integrityState: recommendation.integrityState,
    impactBand: recommendation.impactBand,
    overlapType: recommendation.overlapType ?? null,
    affectedCampaignIds: recommendation.affectedCampaignIds ?? [],
    commerceSignals: recommendation.commerceSignals ?? null,
    commerceConfidence: recommendation.commerceConfidence ?? null,
    coreStepIds: recommendation.coreStepIds ?? [],
    executionTrustScore: recommendation.executionTrustScore ?? null,
    executionTrustBand: recommendation.executionTrustBand ?? null,
    executionTrustSource: recommendation.executionTrustSource ?? null,
    executionPolicyReason: recommendation.executionPolicyReason ?? null,
    sharedBudgetAdjustmentPreview: recommendation.sharedBudgetAdjustmentPreview ?? null,
    portfolioTargetAdjustmentPreview: recommendation.portfolioTargetAdjustmentPreview ?? null,
    jointExecutionSequence: recommendation.jointExecutionSequence ?? null,
    jointAllocatorAdjustmentPreview: recommendation.jointAllocatorAdjustmentPreview ?? null,
    jointAllocatorBlockedReason: recommendation.jointAllocatorBlockedReason ?? null,
    jointAllocatorCautionReason: recommendation.jointAllocatorCautionReason ?? null,
    rollbackSafetyState: recommendation.rollbackSafetyState ?? null,
    rollbackAvailableUntil: recommendation.rollbackAvailableUntil ?? null,
    dependencyReadiness: recommendation.dependencyReadiness ?? null,
    stabilizationHoldUntil: recommendation.stabilizationHoldUntil ?? null,
    batchEligible: recommendation.batchEligible ?? false,
    batchGroupKey: recommendation.batchGroupKey ?? null,
    transactionId: recommendation.transactionId ?? null,
    batchStatus: recommendation.batchStatus ?? null,
    batchSize: recommendation.batchSize ?? null,
    batchRollbackAvailable: recommendation.batchRollbackAvailable ?? null,
    clusterId: recommendation.clusterId ?? null,
    clusterExecutionId: recommendation.clusterExecutionId ?? null,
    clusterStepId: recommendation.clusterStepId ?? null,
    clusterMoveValidity: recommendation.clusterMoveValidity ?? null,
    recoveryState: recommendation.recoveryState ?? null,
    recoveryRecommendedAction: recommendation.recoveryRecommendedAction ?? null,
    rollbackRecoveryAvailable: recommendation.rollbackRecoveryAvailable ?? null,
    sharedStateGovernanceType: recommendation.sharedStateGovernanceType ?? null,
    sharedStateAwarenessStatus: recommendation.sharedStateAwarenessStatus ?? null,
    allocatorCoupled: recommendation.allocatorCoupled ?? null,
    allocatorCouplingConfidence: recommendation.allocatorCouplingConfidence ?? null,
    governedEntityCount: recommendation.governedEntityCount ?? null,
    sharedBudgetResourceName: recommendation.sharedBudgetResourceName ?? null,
    portfolioBidStrategyType: recommendation.portfolioBidStrategyType ?? null,
    portfolioBidStrategyResourceName: recommendation.portfolioBidStrategyResourceName ?? null,
    portfolioBidStrategyStatus: recommendation.portfolioBidStrategyStatus ?? null,
    portfolioTargetType: recommendation.portfolioTargetType ?? null,
    portfolioTargetValue: recommendation.portfolioTargetValue ?? null,
    portfolioGovernanceStatus: recommendation.portfolioGovernanceStatus ?? null,
    portfolioCouplingStrength: recommendation.portfolioCouplingStrength ?? null,
    portfolioCampaignShare: recommendation.portfolioCampaignShare ?? null,
    portfolioDominance: recommendation.portfolioDominance ?? null,
    portfolioContaminationSource: recommendation.portfolioContaminationSource ?? null,
    portfolioContaminationSeverity: recommendation.portfolioContaminationSeverity ?? null,
    portfolioCascadeRiskBand: recommendation.portfolioCascadeRiskBand ?? null,
    portfolioAttributionWindowDays: recommendation.portfolioAttributionWindowDays ?? null,
    portfolioBlockedReason: recommendation.portfolioBlockedReason ?? null,
    portfolioCautionReason: recommendation.portfolioCautionReason ?? null,
    portfolioUnlockGuidance: recommendation.portfolioUnlockGuidance ?? null,
    coupledCampaignIds: recommendation.coupledCampaignIds ?? [],
    coupledCampaignNames: recommendation.coupledCampaignNames ?? [],
    sharedStateMutateBlockedReason: recommendation.sharedStateMutateBlockedReason ?? null,
    sharedStateContaminationFlag: recommendation.sharedStateContaminationFlag ?? null,
    reallocationPreview: recommendation.reallocationPreview ?? null,
  };
}

function mergeJointExecutionSequence(
  sequence: GoogleRecommendation["jointExecutionSequence"] | null | undefined,
  state: unknown
): GoogleRecommendation["jointExecutionSequence"] {
  if (!Array.isArray(sequence) || sequence.length === 0) return sequence ?? null;
  const stateByKey = new Map(
    (Array.isArray(state) ? state : [])
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => [String(entry.stepKey ?? ""), entry])
  );
  return sequence.map((step) => {
    const current = stateByKey.get(String(step.stepKey ?? ""));
    return current
      ? {
          ...step,
          rollbackPayloadPreview:
            (current.rollbackPayloadPreview as Record<string, unknown> | null | undefined) ?? step.rollbackPayloadPreview ?? null,
          transactionIds: Array.isArray(current.transactionIds)
            ? current.transactionIds.filter((value): value is string => typeof value === "string")
            : step.transactionIds ?? [],
          executionStatus:
            (String(current.executionStatus ?? "") || null) as NonNullable<
              NonNullable<GoogleRecommendation["jointExecutionSequence"]>[number]["executionStatus"]
            > | null,
        }
      : step;
  });
}

function outcomeWindowDaysForRecommendationType(type: GoogleRecommendation["type"]) {
  switch (type) {
    case "query_governance":
      return 3;
    case "brand_leakage":
    case "search_shopping_overlap":
    case "orphaned_non_brand_demand":
    case "keyword_buildout":
      return 10;
    case "shopping_launch_or_split":
    case "product_allocation":
    case "pmax_scaling_fit":
    case "budget_reallocation":
      return 14;
    default:
      return 7;
  }
}

function outcomeConfidenceForRecommendation(recommendation: GoogleRecommendation | null | undefined): GoogleOutcomeConfidence {
  if (!recommendation) return "medium";
  if (recommendation.dataTrust === "low") return "low";
  if (recommendation.commerceConfidence === "low") return "low";
  if (recommendation.dataTrust === "high") return "high";
  return "medium";
}

function outcomeForCurrentState(input: {
  previous: RecommendationMemoryRow;
  currentRecommendation?: GoogleRecommendation | null;
}) {
  if (!input.previous.applied_at || !input.previous.outcome_check_at) return null;
  const nowIso = new Date().toISOString();
  const outcomeDue = input.previous.outcome_check_at <= nowIso;
  if (!outcomeDue) {
    return {
      verdict: "unknown" as GoogleOutcomeVerdict,
      metric: null,
      delta: null,
      failReason: "insufficient_data_window" as GoogleOutcomeVerdictFailReason,
      confidence: "low" as GoogleOutcomeConfidence,
    };
  }
  if (input.previous.outcome_verdict && input.previous.outcome_verdict !== "unknown") return null;

  const baselineScore = severityScore(input.previous.applied_snapshot ?? input.previous.recommendation_snapshot);
  if (baselineScore === null) {
    return {
      verdict: "unknown" as GoogleOutcomeVerdict,
      metric: null,
      delta: null,
      failReason: "missing_baseline" as GoogleOutcomeVerdictFailReason,
      confidence: "low" as GoogleOutcomeConfidence,
    };
  }
  if (!input.currentRecommendation) {
    const completionConfidence =
      input.previous.completion_mode === "partial" ||
      (input.previous.skipped_step_ids ?? []).some((stepId) =>
        (input.previous.core_step_ids ?? []).includes(stepId)
      )
        ? "low"
        : "high";
    return {
      verdict: "improved" as GoogleOutcomeVerdict,
      metric: "condition_resolution",
      delta: baselineScore ? Number((-baselineScore).toFixed(2)) : -1,
      failReason: null,
      confidence: completionConfidence as GoogleOutcomeConfidence,
    };
  }

  const currentScore = severityScore(safeSnapshot(input.currentRecommendation));
  if (currentScore === null) {
    return {
      verdict: "unknown" as GoogleOutcomeVerdict,
      metric: "severity_score",
      delta: null,
      failReason: "entity_not_found" as GoogleOutcomeVerdictFailReason,
      confidence: "low" as GoogleOutcomeConfidence,
    };
  }

  const delta = Number((currentScore - baselineScore).toFixed(2));
  if (delta <= -2) {
    return {
      verdict: "improved" as GoogleOutcomeVerdict,
      metric: "severity_score",
      delta,
      failReason: null,
      confidence:
        input.previous.completion_mode === "partial" ||
        (input.previous.skipped_step_ids ?? []).some((stepId) =>
          (input.previous.core_step_ids ?? []).includes(stepId)
        )
          ? ("low" as GoogleOutcomeConfidence)
          : outcomeConfidenceForRecommendation(input.currentRecommendation),
    };
  }
  if (delta >= 2) {
    return {
      verdict: "degraded" as GoogleOutcomeVerdict,
      metric: "severity_score",
      delta,
      failReason: null,
      confidence:
        input.previous.completion_mode === "partial" ||
        (input.previous.skipped_step_ids ?? []).some((stepId) =>
          (input.previous.core_step_ids ?? []).includes(stepId)
        )
          ? ("low" as GoogleOutcomeConfidence)
          : outcomeConfidenceForRecommendation(input.currentRecommendation),
    };
  }
  return {
    verdict: "neutral" as GoogleOutcomeVerdict,
    metric: "severity_score",
    delta,
    failReason: null,
    confidence:
      input.previous.completion_mode === "partial" ||
      (input.previous.skipped_step_ids ?? []).some((stepId) =>
        (input.previous.core_step_ids ?? []).includes(stepId)
      )
        ? ("low" as GoogleOutcomeConfidence)
        : outcomeConfidenceForRecommendation(input.currentRecommendation),
  };
}

function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function annotateAdvisorMemoryFallback(input: {
  businessId: string;
  accountId: string;
  recommendations: GoogleRecommendation[];
}) {
  const root = getFallbackStore();
  const scopeKey = `${input.businessId}:${input.accountId}`;
  const scope = root.get(scopeKey) ?? new Map<string, RecommendationMemoryRow>();
  root.set(scopeKey, scope);

  const nowIso = new Date().toISOString();
  const currentFingerprints = new Set<string>();
  const persisted: GoogleRecommendation[] = [];

  for (const recommendation of input.recommendations) {
    currentFingerprints.add(recommendation.recommendationFingerprint);
    const previous = scope.get(recommendation.recommendationFingerprint);
    const seenCount = (previous?.seen_count ?? 0) + 1;
    const currentStatus = deriveStatus(previous, recommendation, seenCount);
    const suppress = shouldSuppress(previous, nowIso);
    const outcome = previous ? outcomeForCurrentState({ previous, currentRecommendation: recommendation }) : null;

    const row: RecommendationMemoryRow = {
      business_id: input.businessId,
      account_id: input.accountId,
      recommendation_fingerprint: recommendation.recommendationFingerprint,
      recommendation_type: recommendation.type,
      entity_id: recommendation.entityId ?? null,
      first_seen_at: previous?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
      prior_status: previous?.current_status ?? null,
      current_status: suppress ? "suppressed" : currentStatus,
      seen_count: seenCount,
      last_do_bucket: recommendation.doBucket,
      user_action: previous?.user_action ?? null,
      dismiss_reason: previous?.dismiss_reason ?? null,
      suppress_until: previous?.suppress_until ?? null,
      applied_at: previous?.applied_at ?? null,
      outcome_check_at: previous?.outcome_check_at ?? null,
      outcome_check_window_days: previous?.outcome_check_window_days ?? null,
      outcome_verdict: outcome?.verdict ?? previous?.outcome_verdict ?? null,
      outcome_metric: outcome?.metric ?? previous?.outcome_metric ?? null,
      outcome_delta: outcome?.delta ?? previous?.outcome_delta ?? null,
      outcome_verdict_fail_reason:
        outcome?.failReason ?? previous?.outcome_verdict_fail_reason ?? null,
      outcome_confidence: outcome?.confidence ?? previous?.outcome_confidence ?? null,
      execution_status: previous?.execution_status ?? "not_started",
      executed_at: previous?.executed_at ?? null,
      execution_error: previous?.execution_error ?? null,
      rollback_available: previous?.rollback_available ?? null,
      rollback_executed_at: previous?.rollback_executed_at ?? null,
      completion_mode: previous?.completion_mode ?? "unknown",
      completed_step_count: previous?.completed_step_count ?? null,
      total_step_count: previous?.total_step_count ?? recommendation.orderedHandoffSteps?.length ?? null,
      completed_step_ids: previous?.completed_step_ids ?? null,
      skipped_step_ids: previous?.skipped_step_ids ?? null,
      core_step_ids: previous?.core_step_ids ?? recommendation.coreStepIds ?? null,
      execution_metadata: previous?.execution_metadata ?? null,
      applied_snapshot: previous?.applied_snapshot ?? null,
      recommendation_snapshot: safeSnapshot(recommendation),
    };
    scope.set(recommendation.recommendationFingerprint, row);

    if (suppress) continue;

    persisted.push(mergeStoredMemoryFields(recommendation, row));
  }

  for (const [fingerprint, row] of scope.entries()) {
    if (currentFingerprints.has(fingerprint)) continue;
    const outcome = outcomeForCurrentState({ previous: row, currentRecommendation: null });
    scope.set(fingerprint, {
      ...row,
      prior_status: row.current_status,
      current_status:
        row.user_action === "dismissed" && row.suppress_until && row.suppress_until > nowIso
          ? "suppressed"
          : "resolved",
      outcome_verdict: outcome?.verdict ?? row.outcome_verdict,
      outcome_metric: outcome?.metric ?? row.outcome_metric,
      outcome_delta: outcome?.delta ?? row.outcome_delta,
      outcome_verdict_fail_reason: outcome?.failReason ?? row.outcome_verdict_fail_reason,
      outcome_confidence: outcome?.confidence ?? row.outcome_confidence,
    });
  }

  return persisted;
}

export async function annotateAdvisorMemory(input: {
  businessId: string;
  accountId: string;
  recommendations: GoogleRecommendation[];
}) {
  if (!isDbConfigured()) {
    return annotateAdvisorMemoryFallback(input);
  }
  const readiness = await getAdvisorMemorySchemaReadiness();
  if (!readiness?.ready) {
    return annotateAdvisorMemoryFallback(input);
  }
  const sql = getDb();
  const nowIso = new Date().toISOString();
  const fingerprints = Array.from(
    new Set(input.recommendations.map((recommendation) => recommendation.recommendationFingerprint))
  );

  const previousRows = fingerprints.length
    ? ((await sql`
        SELECT
          business_id,
          account_id,
          recommendation_fingerprint,
          recommendation_type,
          entity_id,
          first_seen_at,
          last_seen_at,
          prior_status,
          current_status,
          seen_count,
          last_do_bucket,
          user_action,
          dismiss_reason,
          suppress_until,
          applied_at,
          outcome_check_at,
          outcome_check_window_days,
          outcome_verdict,
          outcome_metric,
          outcome_delta,
          outcome_verdict_fail_reason,
          outcome_confidence,
          execution_status,
          executed_at,
          execution_error,
          rollback_available,
          rollback_executed_at,
          completion_mode,
          completed_step_count,
          total_step_count,
          completed_step_ids,
          skipped_step_ids,
          core_step_ids,
          execution_metadata,
          applied_snapshot,
          recommendation_snapshot
        FROM google_ads_advisor_memory
        WHERE business_id = ${input.businessId}
          AND account_id = ${input.accountId}
          AND recommendation_fingerprint = ANY(${fingerprints}::text[])
      `) as RecommendationMemoryRow[])
    : [];

  const previousByFingerprint = new Map(
    previousRows.map((row) => [row.recommendation_fingerprint, row])
  );

  const scopeRows = ((await sql`
    SELECT
      business_id,
      account_id,
      recommendation_fingerprint,
      recommendation_type,
      entity_id,
      first_seen_at,
      last_seen_at,
      prior_status,
      current_status,
      seen_count,
      last_do_bucket,
      user_action,
      dismiss_reason,
      suppress_until,
      applied_at,
      outcome_check_at,
      outcome_check_window_days,
      outcome_verdict,
      outcome_metric,
      outcome_delta,
      outcome_verdict_fail_reason,
      outcome_confidence,
      execution_status,
      executed_at,
      execution_error,
      rollback_available,
      rollback_executed_at,
      completion_mode,
      completed_step_count,
      total_step_count,
      completed_step_ids,
      skipped_step_ids,
      core_step_ids,
      execution_metadata,
      applied_snapshot,
      recommendation_snapshot
    FROM google_ads_advisor_memory
    WHERE business_id = ${input.businessId}
      AND account_id = ${input.accountId}
  `) as RecommendationMemoryRow[]);

  const currentFingerprints = new Set<string>();
  const persisted: GoogleRecommendation[] = [];
  const suppressedFingerprints: string[] = [];

  for (const recommendation of input.recommendations) {
    currentFingerprints.add(recommendation.recommendationFingerprint);
    const previous = previousByFingerprint.get(recommendation.recommendationFingerprint);
    const seenCount = (previous?.seen_count ?? 0) + 1;
    const currentStatus = deriveStatus(previous, recommendation, seenCount);
    const suppress = shouldSuppress(previous, nowIso);
    const outcome = previous ? outcomeForCurrentState({ previous, currentRecommendation: recommendation }) : null;

    const row: RecommendationMemoryRow = {
      business_id: input.businessId,
      account_id: input.accountId,
      recommendation_fingerprint: recommendation.recommendationFingerprint,
      recommendation_type: recommendation.type,
      entity_id: recommendation.entityId ?? null,
      first_seen_at: previous?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
      prior_status: previous?.current_status ?? null,
      current_status: suppress ? "suppressed" : currentStatus,
      seen_count: seenCount,
      last_do_bucket: recommendation.doBucket,
      user_action: previous?.user_action ?? null,
      dismiss_reason: previous?.dismiss_reason ?? null,
      suppress_until: previous?.suppress_until ?? null,
      applied_at: previous?.applied_at ?? null,
      outcome_check_at: previous?.outcome_check_at ?? null,
      outcome_check_window_days: previous?.outcome_check_window_days ?? null,
      outcome_verdict: outcome?.verdict ?? previous?.outcome_verdict ?? null,
      outcome_metric: outcome?.metric ?? previous?.outcome_metric ?? null,
      outcome_delta: outcome?.delta ?? previous?.outcome_delta ?? null,
      outcome_verdict_fail_reason:
        outcome?.failReason ?? previous?.outcome_verdict_fail_reason ?? null,
      outcome_confidence: outcome?.confidence ?? previous?.outcome_confidence ?? null,
      execution_status: previous?.execution_status ?? "not_started",
      executed_at: previous?.executed_at ?? null,
      execution_error: previous?.execution_error ?? null,
      rollback_available: previous?.rollback_available ?? null,
      rollback_executed_at: previous?.rollback_executed_at ?? null,
      completion_mode: previous?.completion_mode ?? "unknown",
      completed_step_count: previous?.completed_step_count ?? null,
      total_step_count: previous?.total_step_count ?? recommendation.orderedHandoffSteps?.length ?? null,
      completed_step_ids: previous?.completed_step_ids ?? null,
      skipped_step_ids: previous?.skipped_step_ids ?? null,
      core_step_ids: previous?.core_step_ids ?? recommendation.coreStepIds ?? null,
      execution_metadata: previous?.execution_metadata ?? null,
      applied_snapshot: previous?.applied_snapshot ?? null,
      recommendation_snapshot: safeSnapshot(recommendation),
    };

    if (suppress) {
      suppressedFingerprints.push(recommendation.recommendationFingerprint);
      continue;
    }

    persisted.push(mergeStoredMemoryFields(recommendation, row));
  }

  return persisted;
}

export async function hydrateAdvisorRecommendationsFromMemory(input: {
  businessId: string;
  accountId: string;
  recommendations: GoogleRecommendation[];
}) {
  if (input.recommendations.length === 0) return input.recommendations;
  if (!isDbConfigured()) {
    const scope = getFallbackStore().get(`${input.businessId}:${input.accountId}`);
    const rowsByFingerprint = new Map(
      Array.from(scope?.values() ?? []).map((row) => [row.recommendation_fingerprint, row] as const)
    );
    return input.recommendations.map((recommendation) => {
      const row = rowsByFingerprint.get(recommendation.recommendationFingerprint);
      return row ? mergeStoredMemoryFields(recommendation, row) : recommendation;
    });
  }
  const readiness = await getAdvisorMemorySchemaReadiness();
  if (!readiness?.ready) {
    return input.recommendations;
  }
  const sql = getDb();
  const fingerprints = Array.from(
    new Set(input.recommendations.map((recommendation) => recommendation.recommendationFingerprint))
  );
  const rows = fingerprints.length
    ? ((await sql`
        SELECT
          business_id,
          account_id,
          recommendation_fingerprint,
          recommendation_type,
          entity_id,
          first_seen_at,
          last_seen_at,
          prior_status,
          current_status,
          seen_count,
          last_do_bucket,
          user_action,
          dismiss_reason,
          suppress_until,
          applied_at,
          outcome_check_at,
          outcome_check_window_days,
          outcome_verdict,
          outcome_metric,
          outcome_delta,
          outcome_verdict_fail_reason,
          outcome_confidence,
          execution_status,
          executed_at,
          execution_error,
          rollback_available,
          rollback_executed_at,
          completion_mode,
          completed_step_count,
          total_step_count,
          completed_step_ids,
          skipped_step_ids,
          core_step_ids,
          execution_metadata,
          applied_snapshot,
          recommendation_snapshot
        FROM google_ads_advisor_memory
        WHERE business_id = ${input.businessId}
          AND account_id = ${input.accountId}
          AND recommendation_fingerprint = ANY(${fingerprints}::text[])
      `) as RecommendationMemoryRow[])
    : [];
  const rowsByFingerprint = new Map(
    rows.map((row) => [row.recommendation_fingerprint, row] as const)
  );
  return input.recommendations.map((recommendation) => {
    const row = rowsByFingerprint.get(recommendation.recommendationFingerprint);
    return row ? mergeStoredMemoryFields(recommendation, row) : recommendation;
  });
}

export async function updateAdvisorMemoryAction(input: {
  businessId: string;
  accountId: string;
  recommendationFingerprint: string;
  action: "dismissed" | "ignored" | "applied" | "unsuppress";
  dismissReason?: string | null;
  suppressUntil?: string | null;
}) {
  if (!isDbConfigured()) {
    const root = getFallbackStore();
    const scope = root.get(`${input.businessId}:${input.accountId}`);
    const row = scope?.get(input.recommendationFingerprint);
    if (row && scope) {
      const windowDays = outcomeWindowDaysForRecommendationType(
        row.recommendation_type as GoogleRecommendation["type"]
      );
      const appliedAt =
        input.action === "applied" ? new Date().toISOString() : row.applied_at;
      const outcomeCheckAt =
        input.action === "applied"
          ? new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000).toISOString()
          : row.outcome_check_at;
      const nextRow: RecommendationMemoryRow = {
        ...row,
        user_action: input.action === "unsuppress" ? null : input.action,
        dismiss_reason: input.action === "dismissed" ? (input.dismissReason ?? null) : null,
        suppress_until:
          input.action === "dismissed"
            ? (input.suppressUntil ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())
            : null,
        prior_status: row.current_status,
        current_status:
          input.action === "dismissed"
            ? "suppressed"
            : input.action === "unsuppress"
              ? "persistent"
              : row.current_status,
        applied_at: appliedAt,
        outcome_check_at: outcomeCheckAt,
        outcome_check_window_days: input.action === "applied" ? windowDays : row.outcome_check_window_days,
        outcome_verdict: input.action === "applied" ? "unknown" : row.outcome_verdict,
        outcome_metric: input.action === "applied" ? null : row.outcome_metric,
        outcome_delta: input.action === "applied" ? null : row.outcome_delta,
        outcome_verdict_fail_reason:
          input.action === "applied" ? "insufficient_data_window" : row.outcome_verdict_fail_reason,
        outcome_confidence: input.action === "applied" ? "low" : row.outcome_confidence,
        applied_snapshot:
          input.action === "applied" ? (row.recommendation_snapshot ?? null) : row.applied_snapshot,
      };
      scope.set(input.recommendationFingerprint, nextRow);
      return {
        matched: true as const,
        recommendationFingerprint: nextRow.recommendation_fingerprint,
        currentStatus: nextRow.current_status,
        userAction: nextRow.user_action,
        suppressUntil: nextRow.suppress_until,
      };
    }
    return {
      matched: false as const,
      recommendationFingerprint: null,
      currentStatus: null,
      userAction: null,
      suppressUntil: null,
    };
  }
  await assertAdvisorMemoryTablesReady("google_advisor_memory_action");
  const sql = getDb();
  const nextStatus =
    input.action === "dismissed"
      ? "suppressed"
      : input.action === "unsuppress"
        ? "persistent"
        : null;
  const appliedAt =
    input.action === "applied" ? new Date().toISOString() : null;
  const existing = (await sql`
    SELECT recommendation_type
    FROM google_ads_advisor_memory
    WHERE business_id = ${input.businessId}
      AND account_id = ${input.accountId}
      AND recommendation_fingerprint = ${input.recommendationFingerprint}
    LIMIT 1
  `) as Array<{ recommendation_type: string }>;
  if (!existing[0]) {
    return {
      matched: false as const,
      recommendationFingerprint: null,
      currentStatus: null,
      userAction: null,
      suppressUntil: null,
    };
  }
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsAdvisorReferenceContext(input);
  const windowDays = outcomeWindowDaysForRecommendationType(
    existing[0].recommendation_type as GoogleRecommendation["type"]
  );
  const outcomeCheckAt =
    input.action === "applied"
      ? new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const updated = (await sql`
    UPDATE google_ads_advisor_memory
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      provider_account_ref_id = COALESCE(provider_account_ref_id, ${providerAccountRefId}),
      user_action = ${input.action === "unsuppress" ? null : input.action},
      dismiss_reason = ${input.action === "dismissed" ? (input.dismissReason ?? null) : null},
      suppress_until = ${
        input.action === "dismissed"
          ? (input.suppressUntil ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())
          : null
      },
      applied_at = COALESCE(${appliedAt}, applied_at),
      outcome_check_at = CASE
        WHEN ${input.action} = 'applied' THEN ${outcomeCheckAt}
        ELSE outcome_check_at
      END,
      outcome_check_window_days = CASE
        WHEN ${input.action} = 'applied' THEN ${windowDays}
        ELSE outcome_check_window_days
      END,
      outcome_verdict = CASE
        WHEN ${input.action} = 'applied' THEN 'unknown'
        ELSE outcome_verdict
      END,
      outcome_metric = CASE
        WHEN ${input.action} = 'applied' THEN NULL
        ELSE outcome_metric
      END,
      outcome_delta = CASE
        WHEN ${input.action} = 'applied' THEN NULL
        ELSE outcome_delta
      END,
      outcome_verdict_fail_reason = CASE
        WHEN ${input.action} = 'applied' THEN 'insufficient_data_window'
        ELSE outcome_verdict_fail_reason
      END,
      outcome_confidence = CASE
        WHEN ${input.action} = 'applied' THEN 'low'
        ELSE outcome_confidence
      END,
      applied_snapshot = CASE
        WHEN ${input.action} = 'applied' THEN recommendation_snapshot
        ELSE applied_snapshot
      END,
      prior_status = current_status,
      current_status = COALESCE(${nextStatus}, current_status),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND account_id = ${input.accountId}
      AND recommendation_fingerprint = ${input.recommendationFingerprint}
    RETURNING
      recommendation_fingerprint,
      current_status,
      user_action,
      suppress_until
  `) as Array<{
    recommendation_fingerprint: string;
    current_status: GoogleRecommendationMemoryStatus | null;
    user_action: "dismissed" | "ignored" | "applied" | null;
    suppress_until: string | null;
  }>;
  const row = updated[0];
  return row
    ? {
        matched: true as const,
        recommendationFingerprint: row.recommendation_fingerprint,
        currentStatus: row.current_status,
        userAction: row.user_action,
        suppressUntil: row.suppress_until,
      }
    : {
        matched: false as const,
        recommendationFingerprint: null,
        currentStatus: null,
        userAction: null,
        suppressUntil: null,
      };
}

export async function updateAdvisorExecutionState(input: {
  businessId: string;
  accountId: string;
  recommendationFingerprint: string;
  executionStatus: GoogleExecutionStatus;
  executionError?: string | null;
  rollbackAvailable?: boolean | null;
  rollbackExecutedAt?: string | null;
  executionMetadata?: Record<string, unknown> | null;
}) {
  const nowIso = new Date().toISOString();
  if (!isDbConfigured()) {
    const scope = getFallbackStore().get(`${input.businessId}:${input.accountId}`);
    const row = scope?.get(input.recommendationFingerprint);
    if (row && scope) {
      const nextAppliedAt = input.executionStatus === "applied" ? nowIso : row.applied_at;
      scope.set(input.recommendationFingerprint, {
        ...row,
        execution_status: input.executionStatus,
        executed_at: input.executionStatus === "pending" ? row.executed_at : nowIso,
        execution_error: input.executionError ?? null,
        rollback_available: input.rollbackAvailable ?? row.rollback_available ?? false,
        rollback_executed_at: input.rollbackExecutedAt ?? row.rollback_executed_at,
        execution_metadata: input.executionMetadata ?? row.execution_metadata ?? null,
        user_action: input.executionStatus === "applied" ? "applied" : row.user_action,
        applied_at: nextAppliedAt,
      });
    }
    return;
  }
  await assertAdvisorMemoryTablesReady("google_advisor_execution_state");
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsAdvisorReferenceContext(input);
  const sql = getDb();
  await sql`
    UPDATE google_ads_advisor_memory
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      provider_account_ref_id = COALESCE(provider_account_ref_id, ${providerAccountRefId}),
      execution_status = ${input.executionStatus},
      executed_at = CASE
        WHEN ${input.executionStatus} = 'pending' THEN COALESCE(executed_at, now())
        ELSE now()
      END,
      execution_error = ${input.executionError ?? null},
      rollback_available = COALESCE(${input.rollbackAvailable ?? null}, rollback_available),
      rollback_executed_at = COALESCE(${input.rollbackExecutedAt ?? null}, rollback_executed_at),
      execution_metadata = COALESCE(${JSON.stringify(input.executionMetadata ?? null)}::jsonb, execution_metadata),
      user_action = CASE
        WHEN ${input.executionStatus} = 'applied' THEN 'applied'
        ELSE user_action
      END,
      applied_at = CASE
        WHEN ${input.executionStatus} = 'applied' THEN COALESCE(applied_at, now())
        ELSE applied_at
      END,
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND account_id = ${input.accountId}
      AND recommendation_fingerprint = ${input.recommendationFingerprint}
  `;
}

export async function updateAdvisorCompletionState(input: {
  businessId: string;
  accountId: string;
  recommendationFingerprint: string;
  completionMode: GoogleCompletionMode;
  completedStepCount?: number | null;
  totalStepCount?: number | null;
  completedStepIds?: string[] | null;
  skippedStepIds?: string[] | null;
  coreStepIds?: string[] | null;
}) {
  const nextStatus: GoogleExecutionStatus =
    input.completionMode === "partial" ? "partially_applied" : "applied";
  if (!isDbConfigured()) {
    const scope = getFallbackStore().get(`${input.businessId}:${input.accountId}`);
    const row = scope?.get(input.recommendationFingerprint);
    if (row && scope) {
      scope.set(input.recommendationFingerprint, {
        ...row,
        completion_mode: input.completionMode,
        completed_step_count: input.completedStepCount ?? row.completed_step_count,
        total_step_count: input.totalStepCount ?? row.total_step_count,
        completed_step_ids: input.completedStepIds ?? row.completed_step_ids ?? null,
        skipped_step_ids: input.skippedStepIds ?? row.skipped_step_ids ?? null,
        core_step_ids: input.coreStepIds ?? row.core_step_ids ?? null,
        execution_status: nextStatus,
      });
    }
    return;
  }
  await assertAdvisorMemoryTablesReady("google_advisor_completion_state");
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsAdvisorReferenceContext(input);
  const sql = getDb();
  await sql`
    UPDATE google_ads_advisor_memory
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      provider_account_ref_id = COALESCE(provider_account_ref_id, ${providerAccountRefId}),
      completion_mode = ${input.completionMode},
      completed_step_count = COALESCE(${input.completedStepCount ?? null}, completed_step_count),
      total_step_count = COALESCE(${input.totalStepCount ?? null}, total_step_count),
      completed_step_ids = COALESCE(${JSON.stringify(input.completedStepIds ?? null)}::jsonb, completed_step_ids),
      skipped_step_ids = COALESCE(${JSON.stringify(input.skippedStepIds ?? null)}::jsonb, skipped_step_ids),
      core_step_ids = COALESCE(${JSON.stringify(input.coreStepIds ?? null)}::jsonb, core_step_ids),
      execution_status = ${nextStatus},
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND account_id = ${input.accountId}
      AND recommendation_fingerprint = ${input.recommendationFingerprint}
  `;
}

export async function recordAdvisorOutcome(input: {
  businessId: string;
  accountId: string;
  recommendationFingerprint: string;
  verdict: GoogleOutcomeVerdict;
  metric?: string | null;
  delta?: number | null;
  confidence?: GoogleOutcomeConfidence | null;
  failReason?: GoogleOutcomeVerdictFailReason | null;
  outcomeCheckWindowDays?: number | null;
  occurredAt?: string | null;
}) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const nextStatus =
    input.verdict === "unknown" ? null : ("resolved" as GoogleRecommendationMemoryStatus);
  if (!isDbConfigured()) {
    const scope = getFallbackStore().get(`${input.businessId}:${input.accountId}`);
    const row = scope?.get(input.recommendationFingerprint);
    if (row && scope) {
      scope.set(input.recommendationFingerprint, {
        ...row,
        prior_status: row.current_status,
        current_status: nextStatus ?? row.current_status,
        user_action: row.user_action ?? "applied",
        applied_at: row.applied_at ?? occurredAt,
        outcome_check_at: occurredAt,
        outcome_check_window_days:
          input.outcomeCheckWindowDays ?? row.outcome_check_window_days ?? 0,
        outcome_verdict: input.verdict,
        outcome_metric: input.metric ?? row.outcome_metric ?? "manual_validation",
        outcome_delta: input.delta ?? null,
        outcome_verdict_fail_reason: input.failReason ?? null,
        outcome_confidence: input.confidence ?? row.outcome_confidence ?? "medium",
      });
    }
    return;
  }
  await assertAdvisorMemoryTablesReady("google_advisor_record_outcome");
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsAdvisorReferenceContext(input);
  const sql = getDb();
  await sql`
    UPDATE google_ads_advisor_memory
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      provider_account_ref_id = COALESCE(provider_account_ref_id, ${providerAccountRefId}),
      prior_status = current_status,
      current_status = COALESCE(${nextStatus}, current_status),
      user_action = COALESCE(user_action, 'applied'),
      applied_at = COALESCE(applied_at, ${occurredAt}),
      outcome_check_at = ${occurredAt},
      outcome_check_window_days = COALESCE(${input.outcomeCheckWindowDays ?? null}, outcome_check_window_days),
      outcome_verdict = ${input.verdict},
      outcome_metric = ${input.metric ?? "manual_validation"},
      outcome_delta = ${input.delta ?? null},
      outcome_verdict_fail_reason = ${input.failReason ?? null},
      outcome_confidence = COALESCE(${input.confidence ?? null}, outcome_confidence, 'medium'),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND account_id = ${input.accountId}
      AND recommendation_fingerprint = ${input.recommendationFingerprint}
  `;
}

export async function getAdvisorExecutionCalibration(input: {
  businessId: string;
  accountId?: string | null;
}) {
  if (!isDbConfigured()) {
    const scope = getFallbackStore().get(`${input.businessId}:${input.accountId ?? "all"}`);
    const rows = Array.from(scope?.values() ?? []);
    return buildExecutionCalibration(rows);
  }
  const readiness = await getAdvisorMemorySchemaReadiness();
  if (!readiness?.ready) {
    return buildExecutionCalibration([]);
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT recommendation_type, outcome_verdict, outcome_verdict_fail_reason, execution_status, rollback_executed_at, completion_mode, execution_metadata, execution_error
         , recommendation_snapshot, applied_snapshot
    FROM google_ads_advisor_memory
    WHERE business_id = ${input.businessId}
      AND (${input.accountId ?? null}::text IS NULL OR account_id = ${input.accountId ?? null})
  `) as Array<{
    recommendation_type: string;
    outcome_verdict: GoogleOutcomeVerdict | null;
    outcome_verdict_fail_reason: GoogleOutcomeVerdictFailReason | null;
    execution_status: GoogleExecutionStatus | null;
    rollback_executed_at: string | null;
    completion_mode: GoogleCompletionMode | null;
    execution_metadata: Record<string, unknown> | null;
    execution_error: string | null;
    recommendation_snapshot: Record<string, unknown> | null;
    applied_snapshot: Record<string, unknown> | null;
  }>;
  return buildExecutionCalibration(rows);
}

function buildExecutionCalibration(
  rows: Array<{
    recommendation_type: string;
    outcome_verdict?: GoogleOutcomeVerdict | null;
    outcome_verdict_fail_reason?: GoogleOutcomeVerdictFailReason | null;
    execution_status?: GoogleExecutionStatus | null;
    rollback_executed_at?: string | null;
    completion_mode?: GoogleCompletionMode | null;
    execution_metadata?: Record<string, unknown> | null;
    execution_error?: string | null;
    recommendation_snapshot?: Record<string, unknown> | null;
    applied_snapshot?: Record<string, unknown> | null;
  }>
) {
  const byFamily = new Map<string, { total: number; degraded: number; unknown: number }>();
  const failReasons = new Map<string, number>();
  const executionStatuses = new Map<string, number>();
  const mutateActionTypes = new Map<string, number>();
  const executionFailureReasons = new Map<string, number>();
  const byPattern = new Map<
    string,
    { success: number; rollback: number; degraded: number; failure: number; lastTrustBand: string | null }
  >();
  let rollbackCount = 0;
  let partialCount = 0;
  let fullCount = 0;
  for (const row of rows) {
    const family = byFamily.get(row.recommendation_type) ?? { total: 0, degraded: 0, unknown: 0 };
    family.total += 1;
    if (row.outcome_verdict === "degraded") family.degraded += 1;
    if (row.outcome_verdict === "unknown") family.unknown += 1;
    byFamily.set(row.recommendation_type, family);
    if (row.outcome_verdict_fail_reason) {
      failReasons.set(
        row.outcome_verdict_fail_reason,
        (failReasons.get(row.outcome_verdict_fail_reason) ?? 0) + 1
      );
    }
    if (row.execution_status) {
      executionStatuses.set(row.execution_status, (executionStatuses.get(row.execution_status) ?? 0) + 1);
    }
    const mutateActionType = String(row.execution_metadata?.mutateActionType ?? "");
    if (mutateActionType) {
      mutateActionTypes.set(mutateActionType, (mutateActionTypes.get(mutateActionType) ?? 0) + 1);
    }
    const patternKey = String(row.execution_metadata?.policyPatternKey ?? "");
    if (patternKey) {
      const snapshotMoveValidity =
        String(
          row.recommendation_snapshot?.clusterMoveValidity ??
            row.applied_snapshot?.clusterMoveValidity ??
            ""
        ) || null;
      const current = byPattern.get(patternKey) ?? {
        success: 0,
        rollback: 0,
        degraded: 0,
        failure: 0,
        lastTrustBand: null,
      };
      if (row.execution_status === "applied") current.success += 1;
      if (row.execution_status === "failed") current.failure += 1;
      if (row.rollback_executed_at) current.rollback += 1;
      if (row.outcome_verdict === "degraded") current.degraded += 1;
      if (snapshotMoveValidity === "valid") current.success += 1;
      if (snapshotMoveValidity === "partially_effective" || snapshotMoveValidity === "compromised") current.degraded += 1;
      if (snapshotMoveValidity === "failed") current.failure += 1;
      if (snapshotMoveValidity === "reverted") current.rollback += 1;
      current.lastTrustBand = String(row.execution_metadata?.executionTrustBand ?? current.lastTrustBand ?? "") || null;
      byPattern.set(patternKey, current);
    }
    if (row.execution_status === "failed") {
      const message = String(row.execution_error ?? "").toLowerCase();
      const bucket =
        message.includes("shared_budget_blocked") || message.includes("shared budget")
          ? "shared_budget_blocked"
          : message.includes("portfolio_strategy") || message.includes("portfolio")
            ? "portfolio_strategy_blocked"
          : message.includes("intent_uncertain") || message.includes("intent")
            ? "intent_uncertainty"
            : message.includes("commerce_blocked") || message.includes("stock") || message.includes("out-of-stock")
              ? "commerce_blocker"
              : "google_ads_api_rejection";
      executionFailureReasons.set(bucket, (executionFailureReasons.get(bucket) ?? 0) + 1);
    }
    if (row.rollback_executed_at) rollbackCount += 1;
    if (row.completion_mode === "partial") partialCount += 1;
    if (row.completion_mode === "full") fullCount += 1;
  }
  return {
    recommendationFamilies: Array.from(byFamily.entries()).map(([type, counts]) => ({ type, ...counts })),
    failReasons: Object.fromEntries(failReasons.entries()),
    executionStatuses: Object.fromEntries(executionStatuses.entries()),
    mutateActionTypes: Object.fromEntries(mutateActionTypes.entries()),
    executionFailureReasons: Object.fromEntries(executionFailureReasons.entries()),
    patterns: Object.fromEntries(byPattern.entries()),
    rollbackCount,
    partialCount,
    fullCount,
  };
}

export async function logAdvisorExecutionEvent(input: {
  businessId: string;
  accountId: string;
  recommendationFingerprint: string;
  mutateActionType: string;
  operation: string;
  status: string;
  payload?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  errorMessage?: string | null;
}) {
  if (!isDbConfigured()) return;
  await assertAdvisorExecutionLogTableReady("google_advisor_execution_log");
  const { businessRefId, providerAccountRefId } =
    await resolveGoogleAdsAdvisorReferenceContext(input);
  const sql = getDb();
  await sql`
    INSERT INTO google_ads_advisor_execution_logs (
      business_id,
      business_ref_id,
      account_id,
      provider_account_ref_id,
      recommendation_fingerprint,
      mutate_action_type,
      operation,
      status,
      payload_json,
      response_json,
      error_message
    ) VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.accountId},
      ${providerAccountRefId},
      ${input.recommendationFingerprint},
      ${input.mutateActionType},
      ${input.operation},
      ${input.status},
      ${JSON.stringify(input.payload ?? null)}::jsonb,
      ${JSON.stringify(input.response ?? null)}::jsonb,
      ${input.errorMessage ?? null}
    )
  `;
}

export interface GoogleAdsActivityEntry {
  id: string;
  createdAt: string;
  operation: string;
  mutateActionType: string;
  status: string;
  accountId: string;
  detail: string | null;
}

/**
 * The design's Activity feed on Plan: every guarded write that reached the
 * execution boundary, newest first, straight off the execution log. Nothing is
 * synthesised — an empty log renders an empty feed.
 */
export async function listAdvisorExecutionEvents(input: {
  businessId: string;
  accountId?: string | null;
  limit?: number;
}): Promise<GoogleAdsActivityEntry[]> {
  if (!isDbConfigured()) return [];
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const sql = getDb();
  const rows = (await sql`
    SELECT id, created_at, account_id, mutate_action_type, operation, status, error_message
    FROM google_ads_advisor_execution_logs
    WHERE business_id = ${input.businessId}
      AND (${input.accountId ?? null}::text IS NULL OR account_id = ${input.accountId ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `.catch(() => [])) as Array<{
    id: string;
    created_at: string;
    account_id: string;
    mutate_action_type: string;
    operation: string;
    status: string;
    error_message: string | null;
  }>;

  return rows.map((row) => ({
    id: String(row.id),
    createdAt: new Date(row.created_at).toISOString(),
    operation: row.operation,
    mutateActionType: row.mutate_action_type,
    status: row.status,
    accountId: row.account_id,
    detail: row.error_message,
  }));
}
