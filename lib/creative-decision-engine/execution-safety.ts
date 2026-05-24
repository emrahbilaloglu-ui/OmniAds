import type { MetaAutomationReadiness } from "@/lib/meta/automation-readiness";
import type { DecisionLabel, DecisionOutput } from "./types";

export type CreativeExecutableAction = Extract<
  DecisionLabel,
  "scale" | "cut" | "refresh"
>;

export type CreativeExecutionSafetyBlocker =
  | "unsupported_action"
  | "creative_id_drift"
  | "label_drift"
  | "engine_version_drift"
  | "truth_source_drift"
  | "target_roas_drift"
  | "ratio_to_target_drift"
  | "recent_hold_drift"
  | "campaign_kind_drift"
  | "campaign_label_status_drift"
  | "decision_kind_source_drift"
  | "label_transform_drift"
  | "blocked_action_drift"
  | "confidence_regressed"
  | "decision_stale"
  | "missing_idempotency_key"
  | "idempotency_key_mismatch"
  | "base_readiness_not_auto_eligible"
  | "preflight_failed"
  | "rollback_unavailable"
  | "post_action_monitor_missing"
  | "missing_prior_status"
  | "missing_prior_budget"
  | "missing_created_entity_snapshot";

export interface CreativeMutationPreflightResult {
  ok: boolean;
  blockers: CreativeExecutionSafetyBlocker[];
  drift: string[];
  currentDecisionAgeHours: number | null;
  currentDecisionAgeStatus: "fresh" | "stale" | "unparseable_timestamp";
}

export interface CreativeRollbackBeforeState {
  effectiveStatus?: string | null;
  budgetAmount?: number | null;
  budgetOwnerId?: string | null;
  createdEntityIds?: readonly string[];
}

export interface CreativeRollbackPlan {
  ok: boolean;
  action: CreativeExecutableAction;
  blockers: CreativeExecutionSafetyBlocker[];
  restoreSteps: string[];
  beforeState: CreativeRollbackBeforeState;
}

export interface CreativePostActionMonitorPlan {
  action: CreativeExecutableAction;
  businessId: string;
  creativeId: string;
  actionIdempotencyKey: string;
  startDate: string;
  outcomeWindowsDays: number[];
  metricChecks: string[];
}

export interface CreativeExecutionReadinessResult {
  ok: boolean;
  blockers: CreativeExecutionSafetyBlocker[];
  readinessBlockers: MetaAutomationReadiness["blockers"];
}

const HARD_ACTIONS = new Set<DecisionLabel>(["scale", "cut", "refresh"]);

function normalizedPart(value: string | number | null | undefined): string {
  const raw = value == null || value === "" ? "unknown" : String(value);
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function unique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function ageHours(generatedAt: string, now: Date): number | null {
  const generated = new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) return null;
  return (now.getTime() - generated.getTime()) / (60 * 60 * 1000);
}

function sameNullable(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function materialNumericDrift(
  left: number | null | undefined,
  right: number | null | undefined,
  tolerance: number,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft !== normalizedRight;
  }
  if (!Number.isFinite(normalizedLeft) || !Number.isFinite(normalizedRight)) {
    return normalizedLeft !== normalizedRight;
  }
  return Math.abs(normalizedLeft - normalizedRight) > tolerance;
}

function recentHoldRatio(decision: DecisionOutput): number | null {
  const recentRoas = decision.metrics.recent7dRoas;
  const targetRoas = decision.effectiveTargetRoas;
  if (
    typeof recentRoas !== "number" ||
    !Number.isFinite(recentRoas) ||
    targetRoas <= 0 ||
    !Number.isFinite(targetRoas)
  ) {
    return null;
  }
  return recentRoas / targetRoas;
}

function metricChecksFor(action: CreativeExecutableAction): string[] {
  // P2 scaffold only. Before an executor consumes this plan, convert these
  // tokens to typed checks with metric names, predicates, and fail severities.
  if (action === "scale") {
    return [
      "spend_change_after_action",
      "roas_or_cpa_hold_after_scale",
      "purchase_volume_after_scale",
    ];
  }
  if (action === "cut") {
    return [
      "delivery_status_after_cut",
      "spend_leak_after_cut",
      "replacement_capacity_after_cut",
    ];
  }
  return [
    "new_test_delivery_after_refresh",
    "new_variant_delivery_after_refresh",
    "ctr_cvr_roas_after_refresh",
  ];
}

export function isCreativeExecutableAction(
  label: DecisionLabel,
): label is CreativeExecutableAction {
  return HARD_ACTIONS.has(label);
}

export function createCreativeActionIdempotencyKey(input: {
  businessId: string;
  creativeId: string;
  targetEntityId?: string | null;
  action: CreativeExecutableAction;
  asOfDate: string;
  engineVersion: string;
}): string {
  const mutationTargetId = input.targetEntityId ?? input.creativeId;
  return [
    "creative-action",
    normalizedPart(input.businessId),
    normalizedPart(mutationTargetId),
    normalizedPart(input.action),
    normalizedPart(input.asOfDate.slice(0, 10)),
    normalizedPart(input.engineVersion),
  ].join(":");
}

export function evaluateCreativeMutationPreflight(input: {
  scheduledDecision: DecisionOutput;
  currentDecision: DecisionOutput;
  now?: Date;
  maxDecisionAgeHours?: number;
  maxConfidenceRegressionPoints?: number;
  maxRatioToTargetDrift?: number;
  maxRecentHoldDrift?: number;
}): CreativeMutationPreflightResult {
  const blockers: CreativeExecutionSafetyBlocker[] = [];
  const drift: string[] = [];
  const maxDecisionAgeHours = input.maxDecisionAgeHours ?? 12;
  const maxConfidenceRegressionPoints =
    input.maxConfidenceRegressionPoints ?? 5;
  const maxRatioToTargetDrift = input.maxRatioToTargetDrift ?? 0.1;
  const maxRecentHoldDrift = input.maxRecentHoldDrift ?? 0.1;
  const now = input.now ?? new Date();

  if (!isCreativeExecutableAction(input.scheduledDecision.label)) {
    blockers.push("unsupported_action");
  }
  if (input.currentDecision.creativeId !== input.scheduledDecision.creativeId) {
    blockers.push("creative_id_drift");
    drift.push("creative_id");
  }
  if (input.currentDecision.label !== input.scheduledDecision.label) {
    blockers.push("label_drift");
    drift.push("label");
  }
  if (
    !sameNullable(
      input.currentDecision.engineVersion,
      input.scheduledDecision.engineVersion,
    )
  ) {
    blockers.push("engine_version_drift");
    drift.push("engine_version");
  }
  if (
    !sameNullable(
      input.currentDecision.truthSource,
      input.scheduledDecision.truthSource,
    )
  ) {
    blockers.push("truth_source_drift");
    drift.push("truth_source");
  }
  if (
    materialNumericDrift(
      input.currentDecision.effectiveTargetRoas,
      input.scheduledDecision.effectiveTargetRoas,
      0.000001,
    )
  ) {
    blockers.push("target_roas_drift");
    drift.push("effective_target_roas");
  }
  if (
    materialNumericDrift(
      input.currentDecision.ratioToTarget,
      input.scheduledDecision.ratioToTarget,
      maxRatioToTargetDrift,
    )
  ) {
    blockers.push("ratio_to_target_drift");
    drift.push("ratio_to_target");
  }
  if (
    materialNumericDrift(
      recentHoldRatio(input.currentDecision),
      recentHoldRatio(input.scheduledDecision),
      maxRecentHoldDrift,
    )
  ) {
    blockers.push("recent_hold_drift");
    drift.push("recent_hold");
  }
  if (
    !sameNullable(
      input.currentDecision.campaignKind,
      input.scheduledDecision.campaignKind,
    )
  ) {
    blockers.push("campaign_kind_drift");
    drift.push("campaign_kind");
  }
  if (
    !sameNullable(
      input.currentDecision.campaignLabelStatus,
      input.scheduledDecision.campaignLabelStatus,
    )
  ) {
    blockers.push("campaign_label_status_drift");
    drift.push("campaign_label_status");
  }
  if (
    !sameNullable(
      input.currentDecision.decisionKindSource,
      input.scheduledDecision.decisionKindSource,
    )
  ) {
    blockers.push("decision_kind_source_drift");
    drift.push("decision_kind_source");
  }
  if (
    !sameNullable(
      input.currentDecision.labelTransform,
      input.scheduledDecision.labelTransform,
    )
  ) {
    blockers.push("label_transform_drift");
    drift.push("label_transform");
  }
  if (
    !sameNullable(
      input.currentDecision.blockedActionType,
      input.scheduledDecision.blockedActionType,
    )
  ) {
    blockers.push("blocked_action_drift");
    drift.push("blocked_action_type");
  }
  if (
    input.currentDecision.confidence <
    input.scheduledDecision.confidence - maxConfidenceRegressionPoints
  ) {
    blockers.push("confidence_regressed");
    drift.push("confidence");
  }

  const currentDecisionAgeHours = ageHours(input.currentDecision.generatedAt, now);
  const currentDecisionAgeStatus =
    currentDecisionAgeHours === null
      ? "unparseable_timestamp"
      : currentDecisionAgeHours > maxDecisionAgeHours
        ? "stale"
        : "fresh";
  if (
    currentDecisionAgeHours === null ||
    currentDecisionAgeHours > maxDecisionAgeHours
  ) {
    blockers.push("decision_stale");
    drift.push("generated_at");
  }

  return {
    ok: blockers.length === 0,
    blockers: unique(blockers),
    drift: unique(drift),
    currentDecisionAgeHours,
    currentDecisionAgeStatus,
  };
}

/**
 * Builds a rollback recipe for the current P2 semantics.
 * Scale rollback assumes budget-only mutation; extend this if a later executor
 * changes bid strategy, bid caps, targeting, or other ad set/campaign fields.
 */
export function buildCreativeRollbackPlan(input: {
  action: CreativeExecutableAction;
  beforeState: CreativeRollbackBeforeState;
}): CreativeRollbackPlan {
  const blockers: CreativeExecutionSafetyBlocker[] = [];
  const restoreSteps: string[] = [];

  if (!input.beforeState.effectiveStatus) {
    blockers.push("missing_prior_status");
  } else {
    restoreSteps.push(`restore_effective_status:${input.beforeState.effectiveStatus}`);
  }

  if (input.action === "scale") {
    if (
      typeof input.beforeState.budgetAmount !== "number" ||
      !Number.isFinite(input.beforeState.budgetAmount) ||
      !input.beforeState.budgetOwnerId
    ) {
      blockers.push("missing_prior_budget");
    } else {
      restoreSteps.push(
        `restore_budget:${input.beforeState.budgetOwnerId}:${input.beforeState.budgetAmount}`,
      );
    }
  }

  if (
    input.action === "refresh" &&
    (input.beforeState.createdEntityIds ?? []).length === 0
  ) {
    blockers.push("missing_created_entity_snapshot");
  } else if (input.action === "refresh") {
    restoreSteps.push(
      `delete_created_entities:${(input.beforeState.createdEntityIds ?? []).join(",")}`,
    );
  }

  return {
    ok: blockers.length === 0,
    action: input.action,
    blockers: unique(blockers),
    restoreSteps,
    beforeState: input.beforeState,
  };
}

export function createCreativePostActionMonitorPlan(input: {
  businessId: string;
  creativeId: string;
  action: CreativeExecutableAction;
  actionIdempotencyKey: string;
  startDate: string;
  outcomeWindowsDays?: readonly number[];
}): CreativePostActionMonitorPlan {
  return {
    action: input.action,
    businessId: input.businessId,
    creativeId: input.creativeId,
    actionIdempotencyKey: input.actionIdempotencyKey,
    startDate: input.startDate,
    outcomeWindowsDays: [...(input.outcomeWindowsDays ?? [1, 3, 7, 14])],
    metricChecks: metricChecksFor(input.action),
  };
}

export function evaluateCreativeExecutionReadiness(input: {
  readiness: MetaAutomationReadiness;
  preflight: CreativeMutationPreflightResult;
  rollbackPlan: CreativeRollbackPlan;
  postActionMonitorPlan?: CreativePostActionMonitorPlan | null;
  idempotencyKey?: string | null;
  expectedIdempotencyKey?: string | null;
}): CreativeExecutionReadinessResult {
  const blockers: CreativeExecutionSafetyBlocker[] = [];

  if (!input.idempotencyKey?.trim()) blockers.push("missing_idempotency_key");
  if (
    input.idempotencyKey?.trim() &&
    input.expectedIdempotencyKey?.trim() &&
    input.idempotencyKey !== input.expectedIdempotencyKey
  ) {
    blockers.push("idempotency_key_mismatch");
  }
  if (!input.readiness.autoExecuteEligible) {
    blockers.push("base_readiness_not_auto_eligible");
  }
  if (!input.preflight.ok) blockers.push("preflight_failed");
  if (!input.rollbackPlan.ok) blockers.push("rollback_unavailable");
  if (!input.postActionMonitorPlan) {
    blockers.push("post_action_monitor_missing");
  }

  return {
    ok: blockers.length === 0 && input.readiness.blockers.length === 0,
    blockers: unique(blockers),
    readinessBlockers: input.readiness.blockers,
  };
}
