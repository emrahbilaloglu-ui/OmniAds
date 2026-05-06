import type { NextRequest } from "next/server";
import type {
  CommandCenterAction,
  CommandCenterJournalEntry,
  CommandCenterPermissions,
} from "@/lib/command-center";
import { buildOperatorDecisionPushEligibility } from "@/lib/operator-decision-provenance";
import {
  getCommandCenterMutationReceipt,
  listCommandCenterJournal,
  syncCommandCenterActionWorkflowStatus,
  writeCommandCenterMutationReceipt,
} from "@/lib/command-center-store";
import {
  buildCommandCenterExecutionPreviewHash,
  COMMAND_CENTER_EXECUTION_CONTRACT_VERSION,
  type CommandCenterExecutionApprovalSnapshot,
  type CommandCenterExecutionAuditEntry,
  type CommandCenterExecutionCapability,
  type CommandCenterExecutionCanaryPreflight,
  type CommandCenterExecutionDiffItem,
  type CommandCenterExecutionOperation,
  type CommandCenterExecutionPreflightCheck,
  type CommandCenterExecutionPreflightReport,
  type CommandCenterExecutionPreview,
  type CommandCenterExecutionProviderDiffEvidence,
  type CommandCenterExecutionSafeAuditEntry,
  type CommandCenterExecutionStateSummary,
  type CommandCenterExecutionSupportMatrix,
  type CommandCenterExecutionSupportMode,
  type CommandCenterExecutionValidationReport,
  type MetaExecutionMutationPlan,
  META_EXECUTION_SUPPORTED_ACTIONS,
  normalizeMetaExecutionStatus,
  summarizeExecutionStateValue,
} from "@/lib/command-center-execution";
import { resolveCommandCenterExecutionCapability } from "@/lib/command-center-execution-capabilities";
import {
  buildCommandCenterExecutionSupportMatrix,
} from "@/lib/command-center-execution-support";
import {
  appendCommandCenterExecutionAudit,
  getCommandCenterExecutionState,
  listCommandCenterExecutionAudit,
  upsertCommandCenterExecutionState,
} from "@/lib/command-center-execution-store";
import {
  getMetaExecutionApplyBoundaryState,
  isCommandCenterExecutionV1Enabled,
} from "@/lib/command-center-execution-config";
import { hasValidCommandCenterExecutionProvenance } from "@/lib/command-center";
import { getMetaDecisionOsForRange } from "@/lib/meta/decision-os-source";
import type { MetaAdSetDecision } from "@/lib/meta/decision-os";
import {
  getMetaAdSetExecutionState,
  mutateMetaAdSetExecution,
  type MetaExecutionAdSetState,
  type MetaExecutionMutationResult,
} from "@/lib/meta/execution";

class CommandCenterExecutionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    status: number;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "CommandCenterExecutionError";
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
  }
}

function buildExecutionMutationReceipt(input: {
  operation: "apply" | "rollback";
  preview: CommandCenterExecutionPreview | null;
  success: boolean;
  error?: CommandCenterExecutionMutationReceipt["error"];
}) {
  return {
    kind: "command_center_execution",
    operation: input.operation,
    success: input.success,
    preview: input.preview,
    error: input.error ?? null,
  } satisfies CommandCenterExecutionMutationReceipt;
}

async function readExecutionMutationReceipt(input: {
  businessId: string;
  clientMutationId: string;
  operation: "apply" | "rollback";
}) {
  const receipt =
    await getCommandCenterMutationReceipt<CommandCenterExecutionMutationReceipt>({
      businessId: input.businessId,
      clientMutationId: input.clientMutationId,
    });
  if (
    !receipt ||
    receipt.kind !== "command_center_execution" ||
    receipt.operation !== input.operation
  ) {
    return null;
  }
  return receipt;
}

async function writeExecutionMutationReceipt(input: {
  businessId: string;
  clientMutationId: string;
  operation: "apply" | "rollback";
  preview: CommandCenterExecutionPreview | null;
  success: boolean;
  error?: CommandCenterExecutionMutationReceipt["error"];
}) {
  await writeCommandCenterMutationReceipt({
    businessId: input.businessId,
    clientMutationId: input.clientMutationId,
    mutationScope: `command_center_execution:${input.operation}`,
    payload: buildExecutionMutationReceipt({
      operation: input.operation,
      preview: input.preview,
      success: input.success,
      error: input.error,
    }),
  });
}

function replayExecutionMutationReceipt(
  receipt: CommandCenterExecutionMutationReceipt,
) {
  if (receipt.success && receipt.preview) {
    return receipt.preview;
  }

  throw new CommandCenterExecutionError({
    code: receipt.error?.code ?? "execution_receipt_replay_failed",
    status: receipt.error?.status ?? 409,
    message:
      receipt.error?.message ??
      "The original execution attempt already completed without a replayable preview payload.",
    details: receipt.preview ? { preview: receipt.preview } : undefined,
  });
}

function buildObservedProviderResult(reason: string) {
  return {
    statusCode: 202,
    ok: true,
    traceId: null,
    body: {
      source: "live_state_reconciliation",
      reason,
    },
  } satisfies MetaExecutionMutationResult;
}

interface CommandCenterExecutionMutationReceipt {
  kind: "command_center_execution";
  operation: "apply" | "rollback";
  success: boolean;
  preview: CommandCenterExecutionPreview | null;
  error: {
    code: string;
    status: number;
    message: string;
  } | null;
}

function isSupportedMetaExecutionAction(
  value: string,
): value is (typeof META_EXECUTION_SUPPORTED_ACTIONS)[number] {
  return META_EXECUTION_SUPPORTED_ACTIONS.includes(
    value as (typeof META_EXECUTION_SUPPORTED_ACTIONS)[number],
  );
}

function formatCurrencyValue(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `$${Math.round(value)}`;
}

function toExecutionStateSummary(
  state: Pick<
    MetaExecutionAdSetState,
    | "status"
    | "budgetLevel"
    | "dailyBudget"
    | "lifetimeBudget"
    | "optimizationGoal"
    | "bidStrategyLabel"
  > | null,
): CommandCenterExecutionStateSummary | null {
  if (!state) return null;
  return {
    status: normalizeMetaExecutionStatus(state.status),
    budgetLevel: state.budgetLevel,
    dailyBudget: state.dailyBudget,
    lifetimeBudget: state.lifetimeBudget,
    optimizationGoal: state.optimizationGoal,
    bidStrategyLabel: state.bidStrategyLabel,
  };
}

function buildDiff(input: {
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
}) {
  const diff: CommandCenterExecutionDiffItem[] = [];
  if (input.currentState?.status !== input.requestedState?.status) {
    diff.push({
      key: "status",
      label: "Status",
      currentValue: summarizeExecutionStateValue(input.currentState?.status),
      requestedValue: summarizeExecutionStateValue(input.requestedState?.status),
      changeType: "status",
    });
  }

  if (input.currentState?.dailyBudget !== input.requestedState?.dailyBudget) {
    const currentValue = input.currentState?.dailyBudget ?? null;
    const requestedValue = input.requestedState?.dailyBudget ?? null;
    diff.push({
      key: "daily_budget",
      label: "Daily budget",
      currentValue: formatCurrencyValue(currentValue),
      requestedValue: formatCurrencyValue(requestedValue),
      changeType:
        currentValue == null || requestedValue == null
          ? "set"
          : requestedValue > currentValue
            ? "increase"
            : "decrease",
    });
  }

  if (diff.length === 0) {
    diff.push({
      key: "no_change",
      label: "Requested change",
      currentValue: "No live mutation available",
      requestedValue: "Manual-only review",
      changeType: "none",
    });
  }

  return diff;
}

function buildExecutionMismatchReasons(input: {
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
}) {
  const reasons: string[] = [];
  if (!input.currentState) {
    reasons.push("Observed live state could not be resolved after provider execution.");
    return reasons;
  }
  if (!input.requestedState) {
    reasons.push("Requested execution state is unavailable.");
    return reasons;
  }
  if (
    normalizeMetaExecutionStatus(input.currentState.status) !==
    normalizeMetaExecutionStatus(input.requestedState.status)
  ) {
    reasons.push(
      `Observed status ${summarizeExecutionStateValue(input.currentState.status)} did not match requested status ${summarizeExecutionStateValue(input.requestedState.status)}.`,
    );
  }
  if (
    (input.currentState.dailyBudget ?? null) !==
    (input.requestedState.dailyBudget ?? null)
  ) {
    reasons.push(
      `Observed daily budget ${formatCurrencyValue(input.currentState.dailyBudget ?? null)} did not match requested daily budget ${formatCurrencyValue(input.requestedState.dailyBudget ?? null)}.`,
    );
  }
  return reasons;
}

function buildProviderDiffEvidence(input: {
  targetId: string | null;
  baselineState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  observedState: CommandCenterExecutionStateSummary | null;
}) {
  const mismatchReasons = buildExecutionMismatchReasons({
    currentState: input.observedState,
    requestedState: input.requestedState,
  });
  return {
    provider: "meta",
    targetId: input.targetId,
    observedAt: new Date().toISOString(),
    baselineState: input.baselineState,
    requestedState: input.requestedState,
    observedState: input.observedState,
    providerChangeDiff: buildDiff({
      currentState: input.baselineState,
      requestedState: input.observedState,
    }),
    remainingDriftDiff: buildDiff({
      currentState: input.observedState,
      requestedState: input.requestedState,
    }),
    matchedRequestedState: mismatchReasons.length === 0,
    mismatchReasons,
  } satisfies CommandCenterExecutionProviderDiffEvidence;
}

function buildValidationReport(input: {
  operation: CommandCenterExecutionOperation;
  providerDiffEvidence: CommandCenterExecutionProviderDiffEvidence | null;
}) {
  return {
    operation: input.operation,
    status:
      !input.providerDiffEvidence
        ? "not_run"
        : input.providerDiffEvidence.matchedRequestedState
          ? "passed"
          : "failed",
    checkedAt: new Date().toISOString(),
    matchedRequestedState:
      input.providerDiffEvidence?.matchedRequestedState ?? false,
    mismatchReasons: input.providerDiffEvidence?.mismatchReasons ?? [],
  } satisfies CommandCenterExecutionValidationReport;
}

function summarizeSafeAuditBlockedReason(
  entry: CommandCenterExecutionAuditEntry,
) {
  if (entry.failureReason) {
    return "Execution failed; inspect privileged provider logs if deeper detail is required.";
  }
  if (entry.validation?.status === "failed") {
    return "Post-execution validation did not observe the requested provider state.";
  }
  const blockingCheck =
    entry.preflight?.checks.find(
      (check) => check.required && check.status !== "pass",
    ) ?? null;
  return blockingCheck?.label ?? null;
}

function sanitizeCommandCenterExecutionAuditEntry(
  entry: CommandCenterExecutionAuditEntry,
): CommandCenterExecutionSafeAuditEntry {
  return {
    id: entry.id,
    actionFingerprint: entry.actionFingerprint,
    operation: entry.operation,
    executionStatus: entry.executionStatus,
    supportMode: entry.supportMode,
    approvalStatus: entry.approvedAt ? "approved" : "missing",
    previewHash: entry.previewHash,
    capabilityKey: entry.capabilityKey,
    rollbackKind: entry.rollbackKind,
    rollbackNote: entry.rollbackNote,
    preflightReadyForApply: entry.preflight?.readyForApply ?? null,
    preflightBlockingChecks: entry.preflight?.blockingChecks ?? [],
    validationStatus: entry.validation?.status ?? null,
    matchedRequestedState: entry.validation?.matchedRequestedState ?? null,
    blockedReason: summarizeSafeAuditBlockedReason(entry),
    createdAt: entry.createdAt,
  };
}

function sanitizeCommandCenterExecutionAuditTrail(
  entries: CommandCenterExecutionAuditEntry[],
) {
  return entries.map(sanitizeCommandCenterExecutionAuditEntry);
}

function buildPreflightCheck(input: {
  key: string;
  label: string;
  required: boolean;
  passing: boolean;
  detail: string;
  warning?: boolean;
}) {
  return {
    key: input.key,
    label: input.label,
    required: input.required,
    status: input.passing ? "pass" : input.warning ? "warn" : "fail",
    detail: input.detail,
  } satisfies CommandCenterExecutionPreflightCheck;
}

function buildPreflightReport(input: {
  capability: CommandCenterExecutionCapability;
  permissions: CommandCenterPermissions;
  approval: CommandCenterExecutionApprovalSnapshot;
  boundaryState: ReturnType<typeof getMetaExecutionApplyBoundaryState>;
  decisionResolved: boolean;
  liveStateResolved: boolean;
  providerAccessible: boolean;
  safeSubset: boolean;
  alreadyAtTarget: boolean;
}) {
  const approvalEvidencePresent = hasApprovalEvidence(input.approval);
  const checks = [
    buildPreflightCheck({
      key: "capability_supported",
      label: "Capability registry subset",
      required: true,
      passing: input.capability.supportMode === "supported",
      detail:
        input.capability.supportMode === "supported"
          ? "The selected action is inside the provider-backed capability registry."
          : input.capability.supportReason,
    }),
    buildPreflightCheck({
      key: "operator_permissions",
      label: "Operator edit access",
      required: true,
      passing: input.permissions.canEdit,
      detail: input.permissions.canEdit
        ? "Current operator has edit permission for this workspace."
        : input.permissions.reason ?? "This workspace is read-only.",
    }),
    buildPreflightCheck({
      key: "workflow_approved",
      label: "Workflow approval",
      required: true,
      passing:
        input.approval.workflowStatus === "approved" && approvalEvidencePresent,
      detail:
        input.approval.workflowStatus === "approved" && approvalEvidencePresent
          ? "Workflow approval is present with a recorded approval event."
          : input.approval.workflowStatus === "approved"
            ? "Workflow status is approved, but no approval event is recorded."
          : "Approve the workflow action before apply.",
    }),
    buildPreflightCheck({
      key: "decision_resolved",
      label: "Decision linkage",
      required: true,
      passing: input.decisionResolved,
      detail: input.decisionResolved
        ? "Source decision is still linked to a live command-center action."
        : "The source decision drifted and could not be matched safely.",
    }),
    buildPreflightCheck({
      key: "provider_state_resolved",
      label: "Live provider state",
      required: true,
      passing: input.liveStateResolved,
      detail: input.liveStateResolved
        ? "Live provider state resolved successfully."
        : "Live provider state could not be resolved.",
    }),
    buildPreflightCheck({
      key: "provider_scope_accessible",
      label: "Provider scope access",
      required: true,
      passing: input.providerAccessible,
      detail: input.providerAccessible
        ? "The provider target is inside an accessible assigned scope."
        : "Demo or inaccessible provider scopes remain manual-only.",
    }),
    buildPreflightCheck({
      key: "safe_subset",
      label: "Safe mutation subset",
      required: true,
      passing: input.safeSubset,
      detail: input.safeSubset
        ? "The target stays inside the supported ad-set-only safe mutation subset."
        : "The target does not satisfy the supported safe subset requirements.",
    }),
    buildPreflightCheck({
      key: "already_at_target",
      label: "Material live change",
      required: true,
      passing: !input.alreadyAtTarget,
      detail: input.alreadyAtTarget
        ? "The live state already matches the requested target."
        : "A material provider-side delta remains.",
    }),
    buildPreflightCheck({
      key: "apply_gate_enabled",
      label: "Apply gate",
      required: true,
      passing: input.boundaryState.applyEnabled,
      detail: input.boundaryState.applyEnabled
        ? "Meta execution apply gate is enabled."
        : "Meta execution apply is disabled.",
    }),
    buildPreflightCheck({
      key: "kill_switch",
      label: "Kill switch",
      required: true,
      passing: !input.boundaryState.killSwitchActive,
      detail: input.boundaryState.killSwitchActive
        ? "Meta execution kill switch is active."
        : "Meta execution kill switch is inactive.",
    }),
    buildPreflightCheck({
      key: "canary_allowlist",
      label: "Canary allowlist",
      required: true,
      passing: input.boundaryState.businessAllowlisted,
      detail: input.boundaryState.businessAllowlisted
        ? "Business is in the Meta execution canary allowlist."
        : input.boundaryState.canaryScoped
          ? "Business is not in the Meta execution canary allowlist."
          : "No Meta execution canary allowlist is configured.",
    }),
  ];

  const blockingChecks = checks
    .filter((check) => check.required && check.status !== "pass")
    .map((check) => check.label);

  return {
    generatedAt: new Date().toISOString(),
    readyForApply: blockingChecks.length === 0,
    blockingChecks,
    checks,
  } satisfies CommandCenterExecutionPreflightReport;
}

function getFirstBlockingPreflightDetail(
  preflight: CommandCenterExecutionPreflightReport,
) {
  return (
    preflight.checks.find(
      (check) => check.required && check.status !== "pass",
    )?.detail ??
    preflight.blockingChecks[0] ??
    null
  );
}

function buildCanaryPreflight(input: {
  action: CommandCenterAction;
  capability: CommandCenterExecutionCapability;
  boundaryState: ReturnType<typeof getMetaExecutionApplyBoundaryState>;
}): CommandCenterExecutionCanaryPreflight {
  const configuredSmokeBusiness = Boolean(
    process.env.COMMERCIAL_SMOKE_OPERATOR_EXECUTION_BUSINESS_ID?.trim() ||
      process.env.PLAYWRIGHT_EXECUTION_CANARY_BUSINESS_ID?.trim(),
  );
  const candidateAction =
    input.action.sourceType === "meta_adset_decision" &&
    isSupportedMetaExecutionAction(input.action.recommendedAction)
      ? input.action.recommendedAction
      : null;
  const checks = [
    {
      key: "command_center_execution_v1",
      label: "COMMAND_CENTER_EXECUTION_V1",
      status: input.boundaryState.executionPreviewEnabled ? "pass" : "blocked",
      detail: input.boundaryState.executionPreviewEnabled
        ? "Execution preview runtime is enabled."
        : "Execution preview runtime is disabled.",
    },
    {
      key: "meta_execution_apply_enabled",
      label: "META_EXECUTION_APPLY_ENABLED",
      status: input.boundaryState.applyEnabled ? "pass" : "blocked",
      detail: input.boundaryState.applyEnabled
        ? "Meta execution apply is enabled."
        : "Meta execution apply is disabled.",
    },
    {
      key: "meta_execution_kill_switch",
      label: "META_EXECUTION_KILL_SWITCH",
      status: input.boundaryState.killSwitchActive ? "blocked" : "pass",
      detail: input.boundaryState.killSwitchActive
        ? "Kill switch is active."
        : "Kill switch is inactive.",
    },
    {
      key: "meta_execution_canary_businesses",
      label: "META_EXECUTION_CANARY_BUSINESSES",
      status: input.boundaryState.canaryScoped ? "pass" : "blocked",
      detail: input.boundaryState.canaryScoped
        ? "Canary allowlist is configured."
        : "No Meta execution canary allowlist is configured.",
    },
    {
      key: "commercial_smoke_operator_execution_business_id",
      label: "COMMERCIAL_SMOKE_OPERATOR_EXECUTION_BUSINESS_ID",
      status: configuredSmokeBusiness ? "pass" : "blocked",
      detail: configuredSmokeBusiness
        ? "Commercial smoke business is configured."
        : "Execution canary smoke business is not configured in this runtime.",
    },
    {
      key: "candidate_supported_action",
      label: "candidate supported action availability",
      status:
        input.capability.supportMode === "supported" && candidateAction
          ? "pass"
          : "blocked",
      detail:
        input.capability.supportMode === "supported" && candidateAction
          ? `Candidate supported action is ${candidateAction}.`
          : "Current action is outside the supported canary apply subset.",
    },
  ] satisfies CommandCenterExecutionCanaryPreflight["checks"];

  return {
    ready: checks.every((check) => check.status === "pass"),
    candidateAction,
    blockers: checks
      .filter((check) => check.status !== "pass")
      .map((check) => check.label),
    checks,
  };
}

function buildApprovalSnapshot(
  action: CommandCenterAction,
  journal: CommandCenterJournalEntry[],
): CommandCenterExecutionApprovalSnapshot {
  const approvedEntry =
    journal.find(
      (entry) =>
        entry.eventType === "status_changed" &&
        entry.metadata.mutation === "approve",
    ) ?? null;

  return {
    workflowStatus: action.status,
    approvedAt: approvedEntry?.createdAt ?? null,
    approvedByUserId: approvedEntry?.actorUserId ?? null,
    approvedByName: approvedEntry?.actorName ?? null,
    approvedByEmail: approvedEntry?.actorEmail ?? null,
  };
}

function hasApprovalEvidence(approval: CommandCenterExecutionApprovalSnapshot) {
  return Boolean(
    approval.approvedAt &&
      (approval.approvedByUserId || approval.approvedByEmail || approval.approvedByName),
  );
}

function getBudgetMultiplier(decision: MetaAdSetDecision) {
  if (decision.actionType === "scale_budget") {
    if (decision.actionSize === "medium") return 1.15;
    if (decision.actionSize === "large") return 1.25;
    return null;
  }
  if (decision.actionType === "reduce_budget") {
    return decision.actionSize === "medium" ? 0.85 : null;
  }
  return null;
}

function cloneExecutionStateSummary(
  state: CommandCenterExecutionStateSummary,
): CommandCenterExecutionStateSummary {
  return {
    status: state.status,
    budgetLevel: state.budgetLevel,
    dailyBudget: state.dailyBudget,
    lifetimeBudget: state.lifetimeBudget,
    optimizationGoal: state.optimizationGoal,
    bidStrategyLabel: state.bidStrategyLabel,
  };
}

function buildManualOnlyPreview(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  action: CommandCenterAction;
  approval: CommandCenterExecutionApprovalSnapshot;
  latestState: Awaited<ReturnType<typeof getCommandCenterExecutionState>>;
  auditTrail: Awaited<ReturnType<typeof listCommandCenterExecutionAudit>>;
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  capability: CommandCenterExecutionCapability;
  preflight: CommandCenterExecutionPreflightReport;
  canaryPreflight: CommandCenterExecutionCanaryPreflight;
  supportMatrix: CommandCenterExecutionSupportMatrix;
  manualInstructions: string[];
  prerequisites: string[];
  risks: string[];
  supportMode: CommandCenterExecutionSupportMode;
  applyReason?: string | null;
  rollbackReason?: string | null;
}) {
  const diff = buildDiff({
    currentState: input.currentState,
    requestedState: input.requestedState,
  });
  const previewHash = buildCommandCenterExecutionPreviewHash({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    requestedAction: input.action.recommendedAction,
    supportMode: input.supportMode,
    approvalWorkflowStatus: input.approval.workflowStatus,
    currentState: input.currentState,
    requestedState: input.requestedState,
    plan: null,
    diff,
    preflight: input.preflight,
  });

  return {
    contractVersion: COMMAND_CENTER_EXECUTION_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    actionFingerprint: input.action.actionFingerprint,
    sourceType: input.action.sourceType,
    requestedAction: input.action.recommendedAction,
    supportMode: input.supportMode,
    status: input.supportMode === "unsupported" ? "unsupported" : "manual_only",
    previewHash,
    capability: input.capability,
    supportMatrix: input.supportMatrix,
    approval: input.approval,
    permission: {
      canApply: false,
      reason:
        input.applyReason ??
        (input.supportMode === "unsupported"
          ? "This action is outside the V3-06 execution subset."
          : "This action requires manual execution."),
      canRollback: false,
      rollbackReason:
        input.rollbackReason ?? "No provider rollback is available for this preview.",
    },
    target: {
      entityType:
        input.action.relatedEntities[0]?.type === "family"
          ? "unknown"
          : input.action.relatedEntities[0]?.type ?? "unknown",
      entityId: input.action.relatedEntities[0]?.id ?? null,
      entityLabel: input.action.relatedEntities[0]?.label ?? input.action.title,
      campaignId:
        input.action.relatedEntities.find((entity) => entity.type === "campaign")?.id ??
        null,
      campaignName:
        input.action.relatedEntities.find((entity) => entity.type === "campaign")?.label ??
        null,
    },
    currentState: input.currentState,
    requestedState: input.requestedState,
    diff,
    preflight: input.preflight,
    canaryPreflight: input.canaryPreflight,
    prerequisites: input.prerequisites,
    risks: input.risks,
    manualInstructions: input.manualInstructions,
    latestValidation: input.latestState?.latestValidation ?? null,
    providerDiffEvidence: input.latestState?.providerDiffEvidence ?? null,
    auditTrail: sanitizeCommandCenterExecutionAuditTrail(input.auditTrail),
    latestState: input.latestState,
    plan: null,
    rollback: {
      kind: "not_available",
      note:
        input.rollbackReason ??
        "Rollback is unavailable because no provider-side apply path exists.",
    },
  } satisfies CommandCenterExecutionPreview;
}

function getExecutionStatusFromState(input: {
  supportMode: CommandCenterExecutionSupportMode;
  approval: CommandCenterExecutionApprovalSnapshot;
  latestState: Awaited<ReturnType<typeof getCommandCenterExecutionState>>;
}) {
  if (input.supportMode === "manual_only") return "manual_only" as const;
  if (input.supportMode === "unsupported") return "unsupported" as const;
  if (
    input.latestState &&
    ["applying", "executed", "failed", "rolled_back"].includes(
      input.latestState.executionStatus,
    )
  ) {
    return input.latestState.executionStatus;
  }
  return input.approval.workflowStatus === "approved" &&
    hasApprovalEvidence(input.approval)
    ? ("ready_for_apply" as const)
    : ("draft" as const);
}

function doesRequestedStateMatch(input: {
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
}) {
  if (!input.currentState || !input.requestedState) return false;
  return (
    normalizeMetaExecutionStatus(input.currentState.status) ===
      normalizeMetaExecutionStatus(input.requestedState.status) &&
    (input.currentState.dailyBudget ?? null) ===
      (input.requestedState.dailyBudget ?? null)
  );
}

async function replayStoredExecutionReceiptIfPresent(input: {
  businessId: string;
  clientMutationId: string;
  operation: "apply" | "rollback";
}) {
  const receipt = await readExecutionMutationReceipt(input);
  if (!receipt) return null;
  return replayExecutionMutationReceipt(receipt);
}

async function finalizeObservedExecutionCommit(input: {
  businessId: string;
  action: CommandCenterAction;
  startDate: string;
  endDate: string;
  permissions: CommandCenterPermissions;
  request: NextRequest;
  preview: CommandCenterExecutionPreview;
  clientMutationId: string;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  operation: "apply" | "rollback";
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState: CommandCenterExecutionStateSummary | null;
  workflowStatus: "executed" | "approved";
  reconciliationReason: string;
}) {
  const providerDiffEvidence = buildProviderDiffEvidence({
    targetId: input.preview.plan?.targetId ?? null,
    baselineState: input.capturedPreApplyState,
    requestedState: input.requestedState,
    observedState: input.currentState,
  });
  const validation = buildValidationReport({
    operation: input.operation,
    providerDiffEvidence,
  });
  await finalizeExecutionSuccess({
    businessId: input.businessId,
    action: input.action,
    preview: input.preview,
    clientMutationId: input.clientMutationId,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    actorEmail: input.actorEmail,
    operation: input.operation,
    providerResult: buildObservedProviderResult(input.reconciliationReason),
    currentState: input.currentState,
    requestedState: input.requestedState,
    capturedPreApplyState: input.capturedPreApplyState,
    validation,
    providerDiffEvidence,
    workflowStatus: input.workflowStatus,
  });

  const resolvedPreview = await getCommandCenterExecutionPreview({
    request: input.request,
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    action: input.action,
    permissions: input.permissions,
  });

  await writeExecutionMutationReceipt({
    businessId: input.businessId,
    clientMutationId: input.clientMutationId,
    operation: input.operation,
    preview: resolvedPreview,
    success: true,
  });

  return resolvedPreview;
}

async function resolveDuplicateInFlightExecution(input: {
  businessId: string;
  action: CommandCenterAction;
  startDate: string;
  endDate: string;
  permissions: CommandCenterPermissions;
  request: NextRequest;
  preview: CommandCenterExecutionPreview;
  clientMutationId: string;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  operation: "apply" | "rollback";
  targetState: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState: CommandCenterExecutionStateSummary | null;
  workflowStatus: "executed" | "approved";
}) {
  const targetId = input.preview.plan?.targetId ?? null;
  const liveState =
    targetId == null
      ? null
      : await getMetaAdSetExecutionState({
          businessId: input.businessId,
          adSetId: targetId,
        }).then(toExecutionStateSummary);

  if (
    doesRequestedStateMatch({
      currentState: liveState,
      requestedState: input.targetState,
    })
  ) {
    return finalizeObservedExecutionCommit({
      businessId: input.businessId,
      action: input.action,
      startDate: input.startDate,
      endDate: input.endDate,
      permissions: input.permissions,
      request: input.request,
      preview: input.preview,
      clientMutationId: input.clientMutationId,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      operation: input.operation,
      currentState: liveState,
      requestedState: input.targetState,
      capturedPreApplyState: input.capturedPreApplyState,
      workflowStatus: input.workflowStatus,
      reconciliationReason: `${input.operation}_duplicate_live_state_match`,
    });
  }

  throw new CommandCenterExecutionError({
    code:
      input.operation === "apply"
        ? "execution_apply_in_progress"
        : "execution_rollback_in_progress",
    status: 409,
    message:
      input.operation === "apply"
        ? "Apply is already in progress or could not be safely replayed. Wait for the original attempt to settle and do not retry automatically."
        : "Rollback is already in progress or could not be safely replayed. Wait for the original attempt to settle and do not retry automatically.",
    details: {
      preview: input.preview,
      observedLiveState: liveState,
    },
  });
}

async function getActionJournal(input: {
  businessId: string;
  actionFingerprint: string;
}) {
  return listCommandCenterJournal({
    businessId: input.businessId,
    actionFingerprint: input.actionFingerprint,
    limit: 60,
  });
}

async function resolveMetaExecutionPreview(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  action: CommandCenterAction;
  permissions: CommandCenterPermissions;
}) {
  const [journal, latestState, auditTrail] = await Promise.all([
    getActionJournal({
      businessId: input.businessId,
      actionFingerprint: input.action.actionFingerprint,
    }),
    getCommandCenterExecutionState({
      businessId: input.businessId,
      actionFingerprint: input.action.actionFingerprint,
    }),
    listCommandCenterExecutionAudit({
      businessId: input.businessId,
      actionFingerprint: input.action.actionFingerprint,
      limit: 12,
    }),
  ]);
  const approval = buildApprovalSnapshot(input.action, journal);
  const supportMatrix = buildCommandCenterExecutionSupportMatrix(input.action);
  const selectedSupportEntry = supportMatrix.selectedEntry;
  const capability = resolveCommandCenterExecutionCapability(input.action);
  const boundaryState = getMetaExecutionApplyBoundaryState(input.businessId);
  const canaryPreflight = buildCanaryPreflight({
    action: input.action,
    capability,
    boundaryState,
  });
  const buildPreviewPreflight = (options: {
    decisionResolved: boolean;
    liveStateResolved: boolean;
    providerAccessible: boolean;
    safeSubset: boolean;
    alreadyAtTarget: boolean;
  }) =>
    buildPreflightReport({
      capability,
      permissions: input.permissions,
      approval,
      boundaryState,
      decisionResolved: options.decisionResolved,
      liveStateResolved: options.liveStateResolved,
      providerAccessible: options.providerAccessible,
      safeSubset: options.safeSubset,
      alreadyAtTarget: options.alreadyAtTarget,
    });

  const provenanceIsValid = hasValidCommandCenterExecutionProvenance(input.action);
  const provenanceEligibility = buildOperatorDecisionPushEligibility({
    provenance: provenanceIsValid ? input.action.provenance : null,
    queueEligible:
      provenanceIsValid &&
      input.action.surfaceLane === "action_core" &&
      !input.action.watchlistOnly,
    canApply: false,
    canRollback: false,
  });

  if (provenanceEligibility.level === "blocked_from_push") {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: false,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: [
        "Missing upstream decision provenance keeps this row out of the push path.",
      ],
      manualInstructions: [
        "Refresh the source Decision OS surface before applying any change.",
      ],
      supportMode: "manual_only",
      applyReason:
        provenanceEligibility.blockedReason ??
        "Missing upstream decision provenance keeps this row out of the push path.",
      rollbackReason: "Missing upstream decision provenance keeps this row out of the push path.",
    });
  }

  if (
    input.action.operatorPolicy &&
    input.action.operatorPolicy.pushReadiness !== "eligible_for_push_when_enabled"
  ) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: false,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: [
        input.action.operatorPolicy.explanation,
        ...input.action.operatorPolicy.blockers,
      ],
      manualInstructions: [
        "Resolve the deterministic operator policy blockers before using provider-backed apply.",
      ],
      supportMode: "manual_only",
      applyReason:
        input.action.operatorPolicy.blockers[0] ??
        input.action.operatorPolicy.explanation,
      rollbackReason:
        input.action.operatorPolicy.blockers[0] ??
        input.action.operatorPolicy.explanation,
    });
  }

  if (input.action.sourceSystem !== "meta") {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: false,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["Execution is intentionally limited to the supported Meta ad set subset in V3-06."],
      manualInstructions: selectedSupportEntry.operatorGuidance,
      supportMode: selectedSupportEntry.supportMode,
      applyReason: selectedSupportEntry.supportReason,
      rollbackReason: selectedSupportEntry.rollback.note,
    });
  }

  if (input.action.sourceType !== "meta_adset_decision") {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: false,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: [selectedSupportEntry.supportReason],
      manualInstructions: selectedSupportEntry.operatorGuidance,
      supportMode: selectedSupportEntry.supportMode,
      applyReason: selectedSupportEntry.supportReason,
      rollbackReason: selectedSupportEntry.rollback.note,
    });
  }

  const metaDecisionOs = await getMetaDecisionOsForRange({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const decision =
    metaDecisionOs.adSets.find(
      (entry) =>
        entry.decisionId === input.action.sourceContext.sourceDecisionId &&
        entry.adSetId ===
          input.action.relatedEntities.find((entity) => entity.type === "adset")?.id,
    ) ?? null;

  if (!decision) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: false,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["The decision source drifted and could not be matched to a live Meta ad set decision."],
      manualInstructions: [
        "Refresh the source Decision OS surface before applying any change.",
      ],
      supportMode: "manual_only",
      applyReason:
        "The source decision could not be matched to a live Meta ad set decision. Refresh before attempting apply.",
    });
  }

  if (decision.operatorPolicy?.pushReadiness !== "eligible_for_push_when_enabled") {
    const policyReason =
      decision.operatorPolicy?.blockers[0] ??
      decision.operatorPolicy?.explanation ??
      "A deterministic Meta operator policy assessment is required before provider-backed apply.";
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: [policyReason],
      manualInstructions: [
        "Refresh the source Decision OS surface and resolve the operator policy blockers before provider-backed apply.",
      ],
      supportMode: "manual_only",
      applyReason: policyReason,
      rollbackReason: policyReason,
    });
  }

  const liveState = await getMetaAdSetExecutionState({
    businessId: input.businessId,
    adSetId: decision.adSetId,
  });
  const currentState = toExecutionStateSummary(liveState);

  if (!isSupportedMetaExecutionAction(decision.actionType)) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: Boolean(currentState),
        providerAccessible: Boolean(liveState?.providerAccessible),
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: [selectedSupportEntry.supportReason],
      manualInstructions: selectedSupportEntry.operatorGuidance,
      supportMode: selectedSupportEntry.supportMode,
      applyReason: selectedSupportEntry.supportReason,
      rollbackReason: selectedSupportEntry.rollback.note,
    });
  }

  if (!liveState) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["The current live ad set configuration could not be resolved."],
      manualInstructions: [
        "Validate the ad set directly in Meta Ads Manager before making changes.",
      ],
      supportMode: "manual_only",
      applyReason:
        "The current live ad set configuration could not be resolved safely for provider-backed execution.",
    });
  }

  if (!currentState) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState: null,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: false,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["The current execution state could not be summarized safely."],
      manualInstructions: [
        "Refresh the source decision before attempting any live mutation.",
      ],
      supportMode: "manual_only",
      applyReason:
        "The current execution state could not be summarized safely enough for provider-backed execution.",
    });
  }

  if (liveState.isDemo || !liveState.providerAccessible) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: true,
        providerAccessible: false,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["Demo and unassigned provider scopes remain manual-only in V3-06."],
      manualInstructions: [
        "Execution preview is informational only on demo or non-assigned scopes.",
      ],
      supportMode: "manual_only",
      applyReason:
        "Demo and non-provider-assigned scopes remain manual-only for execution.",
    });
  }

  if (liveState.budgetLevel === "campaign") {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: true,
        providerAccessible: true,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["Campaign-owned ad set budgets are not executed automatically in V3-06."],
      manualInstructions: [
        "Update the campaign budget manually if you want to follow this recommendation.",
      ],
      supportMode: "manual_only",
      applyReason:
        "Campaign-owned ad set budgets are outside the safe provider-backed execution subset.",
    });
  }

  if (liveState.lifetimeBudget != null || liveState.isBudgetMixed || liveState.isConfigMixed) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState,
      requestedState: null,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: true,
        providerAccessible: true,
        safeSubset: false,
        alreadyAtTarget: false,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["Lifetime or mixed-budget ad sets are outside the safe V3-06 execution subset."],
      manualInstructions: [
        "Review this ad set manually before changing budget configuration.",
      ],
      supportMode: "manual_only",
      applyReason:
        "Lifetime or mixed-budget ad set configurations remain manual-only.",
    });
  }

  const requestedState = cloneExecutionStateSummary(currentState);

  if (decision.actionType === "pause") {
    requestedState.status = "PAUSED";
  } else if (decision.actionType === "recover") {
    requestedState.status = "ACTIVE";
  } else {
    if (currentState?.dailyBudget == null) {
      return buildManualOnlyPreview({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        action: input.action,
        approval,
        latestState,
        auditTrail,
        currentState,
        requestedState: null,
        capability,
        preflight: buildPreviewPreflight({
          decisionResolved: true,
          liveStateResolved: true,
          providerAccessible: true,
          safeSubset: true,
          alreadyAtTarget: false,
        }),
        canaryPreflight,
        supportMatrix,
        prerequisites: [],
        risks: ["A live ad set daily budget was not available for this mutation."],
        manualInstructions: [
          "Inspect the budget configuration manually before applying any change.",
        ],
        supportMode: "manual_only",
        applyReason:
          "A live daily budget was not available, so the exact requested mutation cannot be issued safely.",
      });
    }
    const multiplier = getBudgetMultiplier(decision);
    const requestedBudget =
      multiplier == null ? null : Math.round(currentState.dailyBudget * multiplier);
    if (
      requestedBudget == null ||
      !Number.isFinite(requestedBudget) ||
      requestedBudget <= 0 ||
      requestedBudget === currentState.dailyBudget
    ) {
      return buildManualOnlyPreview({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        action: input.action,
        approval,
        latestState,
        auditTrail,
        currentState,
        requestedState: null,
        capability,
        preflight: buildPreviewPreflight({
          decisionResolved: true,
          liveStateResolved: true,
          providerAccessible: true,
          safeSubset: true,
          alreadyAtTarget: true,
        }),
        canaryPreflight,
        supportMatrix,
        prerequisites: [],
        risks: ["The exact requested daily budget is either invalid or already live."],
        manualInstructions: [
          "No provider write will be issued for a no-op or invalid budget target.",
        ],
        supportMode: "manual_only",
        applyReason:
          "The exact requested daily budget is invalid, non-material, or already live.",
      });
    }
    requestedState.dailyBudget = requestedBudget;
  }

  if (doesRequestedStateMatch({ currentState, requestedState })) {
    return buildManualOnlyPreview({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      approval,
      latestState,
      auditTrail,
      currentState,
      requestedState,
      capability,
      preflight: buildPreviewPreflight({
        decisionResolved: true,
        liveStateResolved: true,
        providerAccessible: true,
        safeSubset: true,
        alreadyAtTarget: true,
      }),
      canaryPreflight,
      supportMatrix,
      prerequisites: [],
      risks: ["The live state already matches the requested target."],
      manualInstructions: [
        "No automatic apply is available because this recommendation is already satisfied.",
      ],
      supportMode: "manual_only",
      applyReason:
        "The live state already matches the requested target, so no provider write is issued.",
    });
  }

  const plan: MetaExecutionMutationPlan = {
    provider: "meta",
    targetType: "adset",
    targetId: decision.adSetId,
    actionType: decision.actionType,
    requestedStatus:
      decision.actionType === "pause"
        ? "PAUSED"
        : decision.actionType === "recover"
          ? "ACTIVE"
          : null,
    requestedDailyBudget:
      decision.actionType === "scale_budget" || decision.actionType === "reduce_budget"
        ? requestedState.dailyBudget
        : null,
    rollbackKind: "provider_rollback",
    rollbackNote:
      "Rollback restores the exact pre-apply ad set status and daily budget snapshot captured at apply time.",
    providerPayload: {
      ...(decision.actionType === "pause" || decision.actionType === "recover"
        ? { status: requestedState.status ?? "ACTIVE" }
        : {}),
      ...(decision.actionType === "scale_budget" ||
      decision.actionType === "reduce_budget"
        ? { daily_budget: requestedState.dailyBudget ?? 0 }
        : {}),
    },
    externalRefs: {
      provider: "meta",
      providerAccountId: liveState.providerAccountId,
      campaignId: decision.campaignId,
      campaignName: decision.campaignName,
      adSetId: decision.adSetId,
      adSetName: decision.adSetName,
    },
  };

  const diff = buildDiff({ currentState, requestedState });
  const preflight = buildPreviewPreflight({
    decisionResolved: true,
    liveStateResolved: true,
    providerAccessible: true,
    safeSubset: true,
    alreadyAtTarget: false,
  });
  const previewHash = buildCommandCenterExecutionPreviewHash({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    requestedAction: input.action.recommendedAction,
    supportMode: "supported",
    approvalWorkflowStatus: approval.workflowStatus,
    currentState,
    requestedState,
    plan,
    diff,
    preflight,
  });

  const status = getExecutionStatusFromState({
    supportMode: "supported",
    approval,
    latestState,
  });
  const canApply = preflight.readyForApply;
  const canRollback =
    input.permissions.canEdit &&
    latestState?.executionStatus === "executed" &&
    latestState.rollbackKind === "provider_rollback" &&
    latestState.capturedPreApplyState != null &&
    latestState.latestValidation?.status === "passed";

  return {
    contractVersion: COMMAND_CENTER_EXECUTION_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    actionFingerprint: input.action.actionFingerprint,
    sourceType: input.action.sourceType,
    requestedAction: input.action.recommendedAction,
    supportMode: "supported",
    status,
    previewHash,
    capability,
    supportMatrix,
    approval,
    permission: {
      canApply,
      reason:
        canApply
          ? null
          : getFirstBlockingPreflightDetail(preflight) ??
            "Apply is not available for this action.",
      canRollback,
      rollbackReason: canRollback
        ? null
        : latestState?.executionStatus !== "executed"
          ? "Rollback is only available after a successful apply."
          : latestState.rollbackKind !== "provider_rollback"
            ? latestState.rollbackNote ?? "Only recovery notes are available."
            : latestState.latestValidation?.status !== "passed"
              ? "Rollback requires a validated provider-backed apply artifact."
              : "A captured pre-apply snapshot is required for rollback.",
    },
    target: {
      entityType: "adset",
      entityId: decision.adSetId,
      entityLabel: decision.adSetName,
      campaignId: decision.campaignId,
      campaignName: decision.campaignName,
    },
    currentState,
    requestedState,
    diff,
    preflight,
    canaryPreflight,
    prerequisites: [
      "Preview hash must still match live state at apply time.",
      "Explicit human approval is required before apply.",
      "Post-apply validation must observe the requested live status or budget before execution is marked successful.",
    ],
    risks: decision.guardrails,
    manualInstructions: [],
    latestValidation: latestState?.latestValidation ?? null,
    providerDiffEvidence: latestState?.providerDiffEvidence ?? null,
    auditTrail: sanitizeCommandCenterExecutionAuditTrail(auditTrail),
    latestState,
    plan,
    rollback: {
      kind: "provider_rollback",
      note: plan.rollbackNote,
    },
  } satisfies CommandCenterExecutionPreview;
}

export async function getCommandCenterExecutionPreview(input: {
  request: NextRequest;
  businessId: string;
  startDate: string;
  endDate: string;
  action: CommandCenterAction;
  permissions: CommandCenterPermissions;
}) {
  if (!isCommandCenterExecutionV1Enabled()) {
    throw new CommandCenterExecutionError({
      code: "command_center_execution_disabled",
      status: 404,
      message: "Command Center execution is feature-gated.",
    });
  }

  return resolveMetaExecutionPreview({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    action: input.action,
    permissions: input.permissions,
  });
}

async function finalizeExecutionSuccess(input: {
  businessId: string;
  action: CommandCenterAction;
  preview: CommandCenterExecutionPreview;
  clientMutationId: string;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  operation: "apply" | "rollback";
  providerResult: MetaExecutionMutationResult;
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState: CommandCenterExecutionStateSummary | null;
  validation: CommandCenterExecutionValidationReport;
  providerDiffEvidence: CommandCenterExecutionProviderDiffEvidence | null;
  workflowStatus: "executed" | "approved";
}) {
  await appendCommandCenterExecutionAudit({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    clientMutationId: input.clientMutationId,
    operation: input.operation,
    executionStatus: input.operation === "apply" ? "executed" : "rolled_back",
    supportMode: input.preview.supportMode,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    actorEmail: input.actorEmail,
    approvalActorUserId: input.preview.approval.approvedByUserId,
    approvalActorName: input.preview.approval.approvedByName,
    approvalActorEmail: input.preview.approval.approvedByEmail,
    approvedAt: input.preview.approval.approvedAt,
    previewHash: input.preview.previewHash,
    capabilityKey: input.preview.capability.capabilityKey,
    rollbackKind: input.preview.rollback.kind,
    rollbackNote: input.preview.rollback.note,
    currentState: input.currentState,
    requestedState: input.requestedState,
    capturedPreApplyState: input.capturedPreApplyState,
    preflight: input.preview.preflight,
    validation: input.validation,
    providerDiffEvidence: input.providerDiffEvidence,
    providerResponse: {
      statusCode: input.providerResult.statusCode,
      ok: input.providerResult.ok,
      traceId: input.providerResult.traceId,
      body: input.providerResult.body,
    },
    externalRefs: input.preview.plan?.externalRefs ?? null,
  });

  await upsertCommandCenterExecutionState({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    executionStatus: input.operation === "apply" ? "executed" : "rolled_back",
    supportMode: input.preview.supportMode,
    sourceSystem: input.action.sourceSystem,
    sourceType: input.action.sourceType,
    requestedAction: input.action.recommendedAction,
    previewHash: input.preview.previewHash,
    capabilityKey: input.preview.capability.capabilityKey,
    workflowStatusSnapshot:
      input.operation === "apply" ? "executed" : "approved",
    approvalActorUserId: input.preview.approval.approvedByUserId,
    approvalActorName: input.preview.approval.approvedByName,
    approvalActorEmail: input.preview.approval.approvedByEmail,
    approvedAt: input.preview.approval.approvedAt,
    appliedByUserId: input.actorUserId,
    appliedByName: input.actorName,
    appliedByEmail: input.actorEmail,
    appliedAt: new Date().toISOString(),
    rollbackKind: input.preview.rollback.kind,
    rollbackNote: input.preview.rollback.note,
    lastClientMutationId: input.clientMutationId,
    currentState: input.currentState,
    requestedState: input.requestedState,
    capturedPreApplyState: input.capturedPreApplyState,
    preflight: input.preview.preflight,
    latestValidation: input.validation,
    providerDiffEvidence: input.providerDiffEvidence,
    providerResponse: {
      statusCode: input.providerResult.statusCode,
      ok: input.providerResult.ok,
      traceId: input.providerResult.traceId,
    },
  });

  await syncCommandCenterActionWorkflowStatus({
    businessId: input.businessId,
    action: input.action,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    actorEmail: input.actorEmail,
    clientMutationId: `${input.clientMutationId}:${input.operation}:workflow`,
    nextStatus: input.workflowStatus,
    message:
      input.operation === "apply"
        ? `Executed ${input.action.title} through the Safe Execution Layer.`
        : `Rolled back ${input.action.title} through the Safe Execution Layer.`,
    metadata: {
      executionOperation: input.operation,
      previewHash: input.preview.previewHash,
      capabilityKey: input.preview.capability.capabilityKey,
      validationStatus: input.validation.status,
    },
  });
}

async function finalizeExecutionFailure(input: {
  businessId: string;
  action: CommandCenterAction;
  preview: CommandCenterExecutionPreview;
  clientMutationId: string;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  operation: "apply" | "rollback";
  failureReason: string;
  currentState?: CommandCenterExecutionStateSummary | null;
  requestedState?: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState?: CommandCenterExecutionStateSummary | null;
  providerResult?: MetaExecutionMutationResult | null;
  validation?: CommandCenterExecutionValidationReport | null;
  providerDiffEvidence?: CommandCenterExecutionProviderDiffEvidence | null;
}) {
  await appendCommandCenterExecutionAudit({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    clientMutationId: input.clientMutationId,
    operation: input.operation,
    executionStatus: "failed",
    supportMode: input.preview.supportMode,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    actorEmail: input.actorEmail,
    approvalActorUserId: input.preview.approval.approvedByUserId,
    approvalActorName: input.preview.approval.approvedByName,
    approvalActorEmail: input.preview.approval.approvedByEmail,
    approvedAt: input.preview.approval.approvedAt,
    previewHash: input.preview.previewHash,
    capabilityKey: input.preview.capability.capabilityKey,
    rollbackKind: input.preview.rollback.kind,
    rollbackNote: input.preview.rollback.note,
    currentState: input.currentState ?? input.preview.currentState,
    requestedState: input.requestedState ?? input.preview.requestedState,
    capturedPreApplyState:
      input.capturedPreApplyState ?? input.preview.currentState,
    preflight: input.preview.preflight,
    validation: input.validation ?? null,
    providerDiffEvidence: input.providerDiffEvidence ?? null,
    providerResponse: input.providerResult
      ? {
          statusCode: input.providerResult.statusCode,
          ok: input.providerResult.ok,
          traceId: input.providerResult.traceId,
          body: input.providerResult.body,
        }
      : {},
    failureReason: input.failureReason,
    externalRefs: input.preview.plan?.externalRefs ?? null,
  });

  await upsertCommandCenterExecutionState({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    executionStatus: "failed",
    supportMode: input.preview.supportMode,
    sourceSystem: input.action.sourceSystem,
    sourceType: input.action.sourceType,
    requestedAction: input.action.recommendedAction,
    previewHash: input.preview.previewHash,
    capabilityKey: input.preview.capability.capabilityKey,
    workflowStatusSnapshot: "failed",
    approvalActorUserId: input.preview.approval.approvedByUserId,
    approvalActorName: input.preview.approval.approvedByName,
    approvalActorEmail: input.preview.approval.approvedByEmail,
    approvedAt: input.preview.approval.approvedAt,
    appliedByUserId: input.actorUserId,
    appliedByName: input.actorName,
    appliedByEmail: input.actorEmail,
    appliedAt: new Date().toISOString(),
    rollbackKind: input.preview.rollback.kind,
    rollbackNote: input.preview.rollback.note,
    lastClientMutationId: input.clientMutationId,
    lastErrorCode:
      input.validation?.status === "failed"
        ? input.operation === "apply"
          ? "post_apply_validation_failed"
          : "post_rollback_validation_failed"
        : input.operation === "apply"
          ? "provider_apply_failed"
          : "provider_rollback_failed",
    lastErrorMessage: input.failureReason,
    currentState: input.currentState ?? input.preview.currentState,
    requestedState: input.requestedState ?? input.preview.requestedState,
    capturedPreApplyState:
      input.capturedPreApplyState ?? input.preview.currentState,
    preflight: input.preview.preflight,
    latestValidation: input.validation ?? null,
    providerDiffEvidence: input.providerDiffEvidence ?? null,
    providerResponse: input.providerResult
      ? {
          statusCode: input.providerResult.statusCode,
          ok: input.providerResult.ok,
          traceId: input.providerResult.traceId,
        }
      : {},
  });

  await syncCommandCenterActionWorkflowStatus({
    businessId: input.businessId,
    action: input.action,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    actorEmail: input.actorEmail,
    clientMutationId: `${input.clientMutationId}:${input.operation}:workflow`,
    nextStatus: "failed",
    message:
      input.operation === "apply"
        ? `Execution failed for ${input.action.title}.`
        : `Rollback failed for ${input.action.title}.`,
    metadata: {
      executionOperation: input.operation,
      previewHash: input.preview.previewHash,
      failureReason: input.failureReason,
      capabilityKey: input.preview.capability.capabilityKey,
      validationStatus: input.validation?.status ?? "not_run",
    },
  });
}

export async function applyCommandCenterExecution(input: {
  businessId: string;
  action: CommandCenterAction;
  startDate: string;
  endDate: string;
  permissions: CommandCenterPermissions;
  request: NextRequest;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  clientMutationId: string;
  previewHash: string;
}) {
  const preview = await getCommandCenterExecutionPreview({
    request: input.request,
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    action: input.action,
    permissions: input.permissions,
  });

  if (preview.previewHash !== input.previewHash) {
    throw new CommandCenterExecutionError({
      code: "stale_preview_hash",
      status: 409,
      message: "Execution preview is stale. Refresh before apply.",
      details: { preview },
    });
  }

  if (preview.supportMode !== "supported" || !preview.plan) {
    throw new CommandCenterExecutionError({
      code: "execution_not_supported",
      status: 400,
      message: preview.permission.reason ?? "This action cannot be applied automatically.",
      details: { preview },
    });
  }

  if (!preview.permission.canApply) {
    throw new CommandCenterExecutionError({
      code: "execution_apply_forbidden",
      status: 403,
      message: preview.permission.reason ?? "Apply is not available for this action.",
      details: { preview },
    });
  }

  if (!preview.preflight.readyForApply) {
    throw new CommandCenterExecutionError({
      code: "execution_preflight_failed",
      status: 409,
      message:
        getFirstBlockingPreflightDetail(preview.preflight) ??
        "Execution preflight checks failed. Refresh before apply.",
      details: { preview },
    });
  }

  const receiptReplay = await replayStoredExecutionReceiptIfPresent({
    businessId: input.businessId,
    clientMutationId: input.clientMutationId,
    operation: "apply",
  });
  if (receiptReplay) return receiptReplay;

  const existingState = await getCommandCenterExecutionState({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
  });
  if (existingState?.lastClientMutationId === input.clientMutationId) {
    if (existingState.executionStatus === "executed") {
      const resolvedPreview = await getCommandCenterExecutionPreview({
        request: input.request,
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        action: input.action,
        permissions: input.permissions,
      });
      await writeExecutionMutationReceipt({
        businessId: input.businessId,
        clientMutationId: input.clientMutationId,
        operation: "apply",
        preview: resolvedPreview,
        success: true,
      });
      return resolvedPreview;
    }
    if (existingState.executionStatus === "failed") {
      const failedPreview = await getCommandCenterExecutionPreview({
        request: input.request,
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        action: input.action,
        permissions: input.permissions,
      });
      const error = {
        code: "execution_apply_failed",
        status: 502,
        message:
          existingState.lastErrorMessage ??
          "Execution apply failed on the original attempt.",
      } as const;
      await writeExecutionMutationReceipt({
        businessId: input.businessId,
        clientMutationId: input.clientMutationId,
        operation: "apply",
        preview: failedPreview,
        success: false,
        error,
      });
      throw new CommandCenterExecutionError({
        ...error,
        details: { preview: failedPreview },
      });
    }
    if (existingState.executionStatus === "applying") {
      return resolveDuplicateInFlightExecution({
        businessId: input.businessId,
        action: input.action,
        startDate: input.startDate,
        endDate: input.endDate,
        permissions: input.permissions,
        request: input.request,
        preview,
        clientMutationId: input.clientMutationId,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        actorEmail: input.actorEmail,
        operation: "apply",
        targetState: preview.requestedState,
        capturedPreApplyState: preview.currentState,
        workflowStatus: "executed",
      });
    }
  }

  await upsertCommandCenterExecutionState({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    executionStatus: "applying",
    supportMode: preview.supportMode,
    sourceSystem: input.action.sourceSystem,
    sourceType: input.action.sourceType,
    requestedAction: input.action.recommendedAction,
    previewHash: preview.previewHash,
    capabilityKey: preview.capability.capabilityKey,
    workflowStatusSnapshot: input.action.status,
    approvalActorUserId: preview.approval.approvedByUserId,
    approvalActorName: preview.approval.approvedByName,
    approvalActorEmail: preview.approval.approvedByEmail,
    approvedAt: preview.approval.approvedAt,
    appliedByUserId: input.actorUserId,
    appliedByName: input.actorName,
    appliedByEmail: input.actorEmail,
    appliedAt: new Date().toISOString(),
    rollbackKind: preview.rollback.kind,
    rollbackNote: preview.rollback.note,
    lastClientMutationId: input.clientMutationId,
    currentState: preview.currentState,
    requestedState: preview.requestedState,
    capturedPreApplyState: preview.currentState,
    preflight: preview.preflight,
    latestValidation: {
      operation: "apply",
      status: "not_run",
      checkedAt: new Date().toISOString(),
      matchedRequestedState: false,
      mismatchReasons: [],
    },
    providerDiffEvidence: null,
  });

  try {
    const providerResult = await mutateMetaAdSetExecution({
      businessId: input.businessId,
      adSetId: preview.plan.targetId,
      requestedStatus: preview.plan.requestedStatus,
      requestedDailyBudget: preview.plan.requestedDailyBudget,
    });
    const currentState = await getMetaAdSetExecutionState({
      businessId: input.businessId,
      adSetId: preview.plan.targetId,
    }).then(toExecutionStateSummary);
    const providerDiffEvidence = buildProviderDiffEvidence({
      targetId: preview.plan.targetId,
      baselineState: preview.currentState,
      requestedState: preview.requestedState,
      observedState: currentState,
    });
    const validation = buildValidationReport({
      operation: "apply",
      providerDiffEvidence,
    });

    if (validation.status !== "passed") {
      const error = new Error(
        validation.mismatchReasons[0] ??
          "Post-apply validation did not observe the requested live state.",
      ) as Error & {
        code?: string;
        status?: number;
        providerResult?: MetaExecutionMutationResult;
        validation?: CommandCenterExecutionValidationReport;
        providerDiffEvidence?: CommandCenterExecutionProviderDiffEvidence;
        currentState?: CommandCenterExecutionStateSummary | null;
      };
      error.code = "execution_apply_validation_failed";
      error.status = 502;
      error.providerResult = providerResult;
      error.validation = validation;
      error.providerDiffEvidence = providerDiffEvidence;
      error.currentState = currentState;
      throw error;
    }

    await finalizeExecutionSuccess({
      businessId: input.businessId,
      action: input.action,
      preview,
      clientMutationId: input.clientMutationId,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      operation: "apply",
      providerResult,
      currentState,
      requestedState: preview.requestedState,
      capturedPreApplyState: preview.currentState,
      validation,
      providerDiffEvidence,
      workflowStatus: "executed",
    });

    const resolvedPreview = await getCommandCenterExecutionPreview({
      request: input.request,
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      permissions: input.permissions,
    });
    await writeExecutionMutationReceipt({
      businessId: input.businessId,
      clientMutationId: input.clientMutationId,
      operation: "apply",
      preview: resolvedPreview,
      success: true,
    });
    return resolvedPreview;
  } catch (error) {
    const providerResult =
      error &&
      typeof error === "object" &&
      "providerResult" in error &&
      (error as { providerResult?: MetaExecutionMutationResult }).providerResult
        ? (error as { providerResult: MetaExecutionMutationResult }).providerResult
        : null;
    const validation =
      error &&
      typeof error === "object" &&
      "validation" in error &&
      (error as { validation?: CommandCenterExecutionValidationReport }).validation
        ? (error as { validation: CommandCenterExecutionValidationReport }).validation
        : null;
    const providerDiffEvidence =
      error &&
      typeof error === "object" &&
      "providerDiffEvidence" in error &&
      (error as {
        providerDiffEvidence?: CommandCenterExecutionProviderDiffEvidence;
      }).providerDiffEvidence
        ? (error as {
            providerDiffEvidence: CommandCenterExecutionProviderDiffEvidence;
          }).providerDiffEvidence
        : null;
    const currentState =
      error &&
      typeof error === "object" &&
      "currentState" in error &&
      (error as { currentState?: CommandCenterExecutionStateSummary | null })
        .currentState !== undefined
        ? (error as { currentState?: CommandCenterExecutionStateSummary | null })
            .currentState
        : undefined;
    const message =
      error instanceof Error ? error.message : "Execution apply failed.";
    await finalizeExecutionFailure({
      businessId: input.businessId,
      action: input.action,
      preview,
      clientMutationId: input.clientMutationId,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      operation: "apply",
      failureReason: message,
      currentState,
      requestedState: preview.requestedState,
      capturedPreApplyState: preview.currentState,
      providerResult,
      validation,
      providerDiffEvidence,
    });
    const failedPreview = await getCommandCenterExecutionPreview({
      request: input.request,
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      permissions: input.permissions,
    });
    const receiptError = {
      code:
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "execution_apply_failed",
      status:
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 502,
      message,
    } as const;
    await writeExecutionMutationReceipt({
      businessId: input.businessId,
      clientMutationId: input.clientMutationId,
      operation: "apply",
      preview: failedPreview,
      success: false,
      error: receiptError,
    });
    throw new CommandCenterExecutionError({
      ...receiptError,
      details: { preview: failedPreview },
    });
  }
}

export async function rollbackCommandCenterExecution(input: {
  businessId: string;
  action: CommandCenterAction;
  startDate: string;
  endDate: string;
  permissions: CommandCenterPermissions;
  request: NextRequest;
  actorUserId: string;
  actorName: string | null;
  actorEmail: string | null;
  clientMutationId: string;
}) {
  const preview = await getCommandCenterExecutionPreview({
    request: input.request,
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    action: input.action,
    permissions: input.permissions,
  });

  const latestState = preview.latestState;
  const rollbackState = latestState?.capturedPreApplyState ?? null;
  if (!preview.permission.canRollback || !rollbackState || !preview.plan) {
    throw new CommandCenterExecutionError({
      code: "rollback_not_available",
      status: 400,
      message:
        preview.permission.rollbackReason ??
        "Rollback is not available for this action.",
      details: { preview },
    });
  }

  const receiptReplay = await replayStoredExecutionReceiptIfPresent({
    businessId: input.businessId,
    clientMutationId: input.clientMutationId,
    operation: "rollback",
  });
  if (receiptReplay) return receiptReplay;

  if (latestState?.lastClientMutationId === input.clientMutationId) {
    if (latestState.executionStatus === "rolled_back") {
      const resolvedPreview = await getCommandCenterExecutionPreview({
        request: input.request,
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        action: input.action,
        permissions: input.permissions,
      });
      await writeExecutionMutationReceipt({
        businessId: input.businessId,
        clientMutationId: input.clientMutationId,
        operation: "rollback",
        preview: resolvedPreview,
        success: true,
      });
      return resolvedPreview;
    }
    if (latestState.executionStatus === "failed") {
      const failedPreview = await getCommandCenterExecutionPreview({
        request: input.request,
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        action: input.action,
        permissions: input.permissions,
      });
      const error = {
        code: "rollback_failed",
        status: 502,
        message:
          latestState.lastErrorMessage ??
          "Rollback failed on the original attempt.",
      } as const;
      await writeExecutionMutationReceipt({
        businessId: input.businessId,
        clientMutationId: input.clientMutationId,
        operation: "rollback",
        preview: failedPreview,
        success: false,
        error,
      });
      throw new CommandCenterExecutionError({
        ...error,
        details: { preview: failedPreview },
      });
    }
    if (latestState.executionStatus === "applying") {
      return resolveDuplicateInFlightExecution({
        businessId: input.businessId,
        action: input.action,
        startDate: input.startDate,
        endDate: input.endDate,
        permissions: input.permissions,
        request: input.request,
        preview,
        clientMutationId: input.clientMutationId,
        actorUserId: input.actorUserId,
        actorName: input.actorName,
        actorEmail: input.actorEmail,
        operation: "rollback",
        targetState: rollbackState,
        capturedPreApplyState: rollbackState,
        workflowStatus: "approved",
      });
    }
  }

  await upsertCommandCenterExecutionState({
    businessId: input.businessId,
    actionFingerprint: input.action.actionFingerprint,
    executionStatus: "applying",
    supportMode: preview.supportMode,
    sourceSystem: input.action.sourceSystem,
    sourceType: input.action.sourceType,
    requestedAction: input.action.recommendedAction,
    previewHash: preview.previewHash,
    capabilityKey: preview.capability.capabilityKey,
    workflowStatusSnapshot: input.action.status,
    approvalActorUserId: preview.approval.approvedByUserId,
    approvalActorName: preview.approval.approvedByName,
    approvalActorEmail: preview.approval.approvedByEmail,
    approvedAt: preview.approval.approvedAt,
    appliedByUserId: input.actorUserId,
    appliedByName: input.actorName,
    appliedByEmail: input.actorEmail,
    appliedAt: new Date().toISOString(),
    rollbackKind: preview.rollback.kind,
    rollbackNote: preview.rollback.note,
    lastClientMutationId: input.clientMutationId,
    currentState: preview.currentState,
    requestedState: rollbackState,
    capturedPreApplyState: latestState?.capturedPreApplyState ?? rollbackState,
    preflight: preview.preflight,
    latestValidation: {
      operation: "rollback",
      status: "not_run",
      checkedAt: new Date().toISOString(),
      matchedRequestedState: false,
      mismatchReasons: [],
    },
    providerDiffEvidence: null,
  });

  try {
    const providerResult = await mutateMetaAdSetExecution({
      businessId: input.businessId,
      adSetId: preview.plan.targetId,
      requestedStatus: rollbackState.status,
      requestedDailyBudget: rollbackState.dailyBudget,
    });

    const currentState = await getMetaAdSetExecutionState({
      businessId: input.businessId,
      adSetId: preview.plan.targetId,
    }).then(toExecutionStateSummary);
    const providerDiffEvidence = buildProviderDiffEvidence({
      targetId: preview.plan.targetId,
      baselineState: preview.currentState,
      requestedState: rollbackState,
      observedState: currentState,
    });
    const validation = buildValidationReport({
      operation: "rollback",
      providerDiffEvidence,
    });

    if (validation.status !== "passed") {
      const error = new Error(
        validation.mismatchReasons[0] ??
          "Post-rollback validation did not observe the captured pre-apply live state.",
      ) as Error & {
        code?: string;
        status?: number;
        providerResult?: MetaExecutionMutationResult;
        validation?: CommandCenterExecutionValidationReport;
        providerDiffEvidence?: CommandCenterExecutionProviderDiffEvidence;
        currentState?: CommandCenterExecutionStateSummary | null;
      };
      error.code = "execution_rollback_validation_failed";
      error.status = 502;
      error.providerResult = providerResult;
      error.validation = validation;
      error.providerDiffEvidence = providerDiffEvidence;
      error.currentState = currentState;
      throw error;
    }

    await finalizeExecutionSuccess({
      businessId: input.businessId,
      action: input.action,
      preview,
      clientMutationId: input.clientMutationId,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      operation: "rollback",
      providerResult,
      currentState,
      requestedState: rollbackState,
      capturedPreApplyState: latestState?.capturedPreApplyState ?? rollbackState,
      validation,
      providerDiffEvidence,
      workflowStatus: "approved",
    });

    const resolvedPreview = await getCommandCenterExecutionPreview({
      request: input.request,
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      permissions: input.permissions,
    });
    await writeExecutionMutationReceipt({
      businessId: input.businessId,
      clientMutationId: input.clientMutationId,
      operation: "rollback",
      preview: resolvedPreview,
      success: true,
    });
    return resolvedPreview;
  } catch (error) {
    const providerResult =
      error &&
      typeof error === "object" &&
      "providerResult" in error &&
      (error as { providerResult?: MetaExecutionMutationResult }).providerResult
        ? (error as { providerResult: MetaExecutionMutationResult }).providerResult
        : null;
    const validation =
      error &&
      typeof error === "object" &&
      "validation" in error &&
      (error as { validation?: CommandCenterExecutionValidationReport }).validation
        ? (error as { validation: CommandCenterExecutionValidationReport }).validation
        : null;
    const providerDiffEvidence =
      error &&
      typeof error === "object" &&
      "providerDiffEvidence" in error &&
      (error as {
        providerDiffEvidence?: CommandCenterExecutionProviderDiffEvidence;
      }).providerDiffEvidence
        ? (error as {
            providerDiffEvidence: CommandCenterExecutionProviderDiffEvidence;
          }).providerDiffEvidence
        : null;
    const currentState =
      error &&
      typeof error === "object" &&
      "currentState" in error &&
      (error as { currentState?: CommandCenterExecutionStateSummary | null })
        .currentState !== undefined
        ? (error as { currentState?: CommandCenterExecutionStateSummary | null })
            .currentState
        : preview.currentState;
    const message = error instanceof Error ? error.message : "Rollback failed.";
    await finalizeExecutionFailure({
      businessId: input.businessId,
      action: input.action,
      preview,
      clientMutationId: input.clientMutationId,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      operation: "rollback",
      failureReason: message,
      currentState,
      requestedState: rollbackState,
      capturedPreApplyState: latestState?.capturedPreApplyState ?? rollbackState,
      providerResult,
      validation,
      providerDiffEvidence,
    });
    const failedPreview = await getCommandCenterExecutionPreview({
      request: input.request,
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      action: input.action,
      permissions: input.permissions,
    });
    const receiptError = {
      code:
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "rollback_failed",
      status:
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 502,
      message,
    } as const;
    await writeExecutionMutationReceipt({
      businessId: input.businessId,
      clientMutationId: input.clientMutationId,
      operation: "rollback",
      preview: failedPreview,
      success: false,
      error: receiptError,
    });
    throw new CommandCenterExecutionError({
      ...receiptError,
      details: { preview: failedPreview },
    });
  }
}

export function isCommandCenterExecutionError(error: unknown): error is CommandCenterExecutionError {
  return error instanceof CommandCenterExecutionError;
}
