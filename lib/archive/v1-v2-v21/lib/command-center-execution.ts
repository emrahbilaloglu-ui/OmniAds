import { createHash } from "crypto";
import type {
  CommandCenterActionStatus,
  CommandCenterSourceSystem,
  CommandCenterSourceType,
} from "@/lib/command-center";
import type { MetaExecutionSupportedAction } from "@/lib/command-center-execution-allowlist";
export {
  META_EXECUTION_SUPPORTED_ACTIONS,
  type MetaExecutionSupportedAction,
} from "@/lib/command-center-execution-allowlist";

export const COMMAND_CENTER_EXECUTION_CONTRACT_VERSION =
  "command-center-execution.v1" as const;

export const COMMAND_CENTER_EXECUTION_SUPPORT_MODES = [
  "supported",
  "manual_only",
  "unsupported",
] as const;

export type CommandCenterExecutionSupportMode =
  (typeof COMMAND_CENTER_EXECUTION_SUPPORT_MODES)[number];

export const COMMAND_CENTER_EXECUTION_STATUSES = [
  "draft",
  "ready_for_apply",
  "applying",
  "executed",
  "failed",
  "rolled_back",
  "manual_only",
  "unsupported",
] as const;

export type CommandCenterExecutionStatus =
  (typeof COMMAND_CENTER_EXECUTION_STATUSES)[number];

export const COMMAND_CENTER_EXECUTION_APPLY_GATE_POSTURES = [
  "enabled",
  "allowlist_only",
  "disabled",
  "not_applicable",
] as const;

export type CommandCenterExecutionApplyGatePosture =
  (typeof COMMAND_CENTER_EXECUTION_APPLY_GATE_POSTURES)[number];

export const META_EXECUTION_ROLLBACK_KINDS = [
  "provider_rollback",
  "recovery_note_only",
  "not_available",
] as const;

export type MetaExecutionRollbackKind =
  (typeof META_EXECUTION_ROLLBACK_KINDS)[number];

export const COMMAND_CENTER_EXECUTION_OPERATIONS = [
  "apply",
  "rollback",
] as const;

export type CommandCenterExecutionOperation =
  (typeof COMMAND_CENTER_EXECUTION_OPERATIONS)[number];

export const COMMAND_CENTER_EXECUTION_PROOF_LEVELS = [
  "unsupported",
  "code_supported",
  "provider_validated",
  "live_canary_proven",
] as const;

export type CommandCenterExecutionProofLevel =
  (typeof COMMAND_CENTER_EXECUTION_PROOF_LEVELS)[number];

export interface CommandCenterExecutionStateSummary {
  status: string | null;
  budgetLevel: "campaign" | "adset" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  optimizationGoal: string | null;
  bidStrategyLabel: string | null;
}

export interface CommandCenterExecutionDiffItem {
  key: string;
  label: string;
  currentValue: string;
  requestedValue: string;
  changeType: "status" | "increase" | "decrease" | "set" | "none";
}

export interface CommandCenterExecutionApprovalSnapshot {
  workflowStatus: CommandCenterActionStatus;
  approvedAt: string | null;
  approvedByUserId: string | null;
  approvedByName: string | null;
  approvedByEmail: string | null;
}

export interface CommandCenterExecutionExternalRefs {
  provider: "meta";
  providerAccountId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
}

export interface MetaExecutionMutationPlan {
  provider: "meta";
  targetType: "adset";
  targetId: string;
  actionType: MetaExecutionSupportedAction;
  requestedStatus: string | null;
  requestedDailyBudget: number | null;
  rollbackKind: MetaExecutionRollbackKind;
  rollbackNote: string | null;
  providerPayload: Record<string, string | number>;
  externalRefs: CommandCenterExecutionExternalRefs;
}

export interface CommandCenterExecutionPermission {
  canApply: boolean;
  reason: string | null;
  canRollback: boolean;
  rollbackReason: string | null;
}

export const COMMAND_CENTER_EXECUTION_CHECK_STATUSES = [
  "pass",
  "warn",
  "fail",
] as const;

export type CommandCenterExecutionCheckStatus =
  (typeof COMMAND_CENTER_EXECUTION_CHECK_STATUSES)[number];

export const COMMAND_CENTER_EXECUTION_VALIDATION_STATUSES = [
  "passed",
  "failed",
  "not_run",
] as const;

export type CommandCenterExecutionValidationStatus =
  (typeof COMMAND_CENTER_EXECUTION_VALIDATION_STATUSES)[number];

export interface CommandCenterExecutionCapability {
  registryVersion: "command-center-execution-capabilities.v1";
  capabilityKey: string;
  provider: "meta" | "none";
  targetType: "adset" | "campaign" | "creative" | "geo" | "placement" | "unknown";
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  recommendedAction: string | null;
  supportMode: CommandCenterExecutionSupportMode;
  applyGate: {
    posture: CommandCenterExecutionApplyGatePosture;
    note: string;
    requiresApproval: boolean;
    requiresCanary: boolean;
    killSwitchAware: boolean;
  };
  rollback: {
    kind: MetaExecutionRollbackKind;
    note: string | null;
  };
  applyProofLevel: CommandCenterExecutionProofLevel;
  rollbackProofLevel: CommandCenterExecutionProofLevel;
  supportReason: string;
  operatorGuidance: string[];
  validationPlan: string[];
}

export interface CommandCenterExecutionPreflightCheck {
  key: string;
  label: string;
  required: boolean;
  status: CommandCenterExecutionCheckStatus;
  detail: string;
}

export interface CommandCenterExecutionPreflightReport {
  generatedAt: string;
  readyForApply: boolean;
  blockingChecks: string[];
  checks: CommandCenterExecutionPreflightCheck[];
}

export interface CommandCenterExecutionValidationReport {
  operation: CommandCenterExecutionOperation;
  status: CommandCenterExecutionValidationStatus;
  checkedAt: string;
  matchedRequestedState: boolean;
  mismatchReasons: string[];
}

export interface CommandCenterExecutionProviderDiffEvidence {
  provider: "meta";
  targetId: string | null;
  observedAt: string;
  baselineState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  observedState: CommandCenterExecutionStateSummary | null;
  providerChangeDiff: CommandCenterExecutionDiffItem[];
  remainingDriftDiff: CommandCenterExecutionDiffItem[];
  matchedRequestedState: boolean;
  mismatchReasons: string[];
}

export interface CommandCenterExecutionSupportMatrixEntry {
  familyKey: string;
  label: string;
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  recommendedAction: string | null;
  supportMode: CommandCenterExecutionSupportMode;
  applyGate: {
    posture: CommandCenterExecutionApplyGatePosture;
    note: string;
  };
  rollback: {
    kind: MetaExecutionRollbackKind;
    note: string | null;
  };
  applyProofLevel: CommandCenterExecutionProofLevel;
  rollbackProofLevel: CommandCenterExecutionProofLevel;
  supportReason: string;
  operatorGuidance: string[];
}

export interface CommandCenterExecutionCanaryPreflightCheck {
  key:
    | "command_center_execution_v1"
    | "meta_execution_apply_enabled"
    | "meta_execution_kill_switch"
    | "meta_execution_canary_businesses"
    | "commercial_smoke_operator_execution_business_id"
    | "candidate_supported_action";
  label: string;
  status: "pass" | "blocked";
  detail: string;
}

export interface CommandCenterExecutionCanaryPreflight {
  ready: boolean;
  candidateAction: MetaExecutionSupportedAction | null;
  blockers: string[];
  checks: CommandCenterExecutionCanaryPreflightCheck[];
}

export interface CommandCenterExecutionSupportMatrix {
  selectedEntry: CommandCenterExecutionSupportMatrixEntry;
  entries: CommandCenterExecutionSupportMatrixEntry[];
}

export interface CommandCenterExecutionAuditEntry {
  id: string;
  businessId: string;
  actionFingerprint: string;
  operation: CommandCenterExecutionOperation;
  executionStatus: CommandCenterExecutionStatus;
  supportMode: CommandCenterExecutionSupportMode;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  approvalActorUserId: string | null;
  approvalActorName: string | null;
  approvalActorEmail: string | null;
  approvedAt: string | null;
  previewHash: string | null;
  capabilityKey: string | null;
  rollbackKind: MetaExecutionRollbackKind;
  rollbackNote: string | null;
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState: CommandCenterExecutionStateSummary | null;
  preflight: CommandCenterExecutionPreflightReport | null;
  validation: CommandCenterExecutionValidationReport | null;
  providerDiffEvidence: CommandCenterExecutionProviderDiffEvidence | null;
  providerResponse: Record<string, unknown>;
  failureReason: string | null;
  externalRefs: CommandCenterExecutionExternalRefs | null;
  createdAt: string;
}

export interface CommandCenterExecutionSafeAuditEntry {
  id: string;
  actionFingerprint: string;
  operation: CommandCenterExecutionOperation;
  executionStatus: CommandCenterExecutionStatus;
  supportMode: CommandCenterExecutionSupportMode;
  approvalStatus: "approved" | "missing";
  previewHash: string | null;
  capabilityKey: string | null;
  rollbackKind: MetaExecutionRollbackKind;
  rollbackNote: string | null;
  preflightReadyForApply: boolean | null;
  preflightBlockingChecks: string[];
  validationStatus: CommandCenterExecutionValidationStatus | null;
  matchedRequestedState: boolean | null;
  blockedReason: string | null;
  createdAt: string;
}

export interface CommandCenterExecutionStateRecord {
  businessId: string;
  actionFingerprint: string;
  executionStatus: CommandCenterExecutionStatus;
  supportMode: CommandCenterExecutionSupportMode;
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  requestedAction: string;
  previewHash: string | null;
  capabilityKey: string | null;
  workflowStatusSnapshot: CommandCenterActionStatus;
  approvalActorUserId: string | null;
  approvalActorName: string | null;
  approvalActorEmail: string | null;
  approvedAt: string | null;
  appliedByUserId: string | null;
  appliedByName: string | null;
  appliedByEmail: string | null;
  appliedAt: string | null;
  rollbackKind: MetaExecutionRollbackKind;
  rollbackNote: string | null;
  lastClientMutationId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState: CommandCenterExecutionStateSummary | null;
  preflight: CommandCenterExecutionPreflightReport | null;
  latestValidation: CommandCenterExecutionValidationReport | null;
  providerDiffEvidence: CommandCenterExecutionProviderDiffEvidence | null;
  providerResponse: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommandCenterExecutionPreview {
  contractVersion: typeof COMMAND_CENTER_EXECUTION_CONTRACT_VERSION;
  generatedAt: string;
  businessId: string;
  startDate: string;
  endDate: string;
  actionFingerprint: string;
  sourceType: CommandCenterSourceType;
  requestedAction: string;
  supportMode: CommandCenterExecutionSupportMode;
  status: CommandCenterExecutionStatus;
  previewHash: string;
  capability: CommandCenterExecutionCapability;
  supportMatrix: CommandCenterExecutionSupportMatrix;
  approval: CommandCenterExecutionApprovalSnapshot;
  permission: CommandCenterExecutionPermission;
  target: {
    entityType: "adset" | "campaign" | "creative" | "geo" | "placement" | "unknown";
    entityId: string | null;
    entityLabel: string | null;
    campaignId: string | null;
    campaignName: string | null;
  };
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  diff: CommandCenterExecutionDiffItem[];
  preflight: CommandCenterExecutionPreflightReport;
  canaryPreflight: CommandCenterExecutionCanaryPreflight;
  prerequisites: string[];
  risks: string[];
  manualInstructions: string[];
  latestValidation: CommandCenterExecutionValidationReport | null;
  providerDiffEvidence: CommandCenterExecutionProviderDiffEvidence | null;
  auditTrail: CommandCenterExecutionSafeAuditEntry[];
  latestState: CommandCenterExecutionStateRecord | null;
  plan: MetaExecutionMutationPlan | null;
  rollback: {
    kind: MetaExecutionRollbackKind;
    note: string | null;
  };
}

export function buildCommandCenterExecutionPreviewHash(input: {
  businessId: string;
  actionFingerprint: string;
  requestedAction: string;
  supportMode: CommandCenterExecutionSupportMode;
  approvalWorkflowStatus: CommandCenterActionStatus;
  currentState: CommandCenterExecutionStateSummary | null;
  requestedState: CommandCenterExecutionStateSummary | null;
  plan: MetaExecutionMutationPlan | null;
  diff: CommandCenterExecutionDiffItem[];
  preflight?: CommandCenterExecutionPreflightReport | null;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: COMMAND_CENTER_EXECUTION_CONTRACT_VERSION,
        businessId: input.businessId,
        actionFingerprint: input.actionFingerprint,
        requestedAction: input.requestedAction,
        supportMode: input.supportMode,
        approvalWorkflowStatus: input.approvalWorkflowStatus,
        currentState: input.currentState,
        requestedState: input.requestedState,
        plan: input.plan,
        diff: input.diff,
        preflight:
          input.preflight == null
            ? null
            : {
                readyForApply: input.preflight.readyForApply,
                blockingChecks: input.preflight.blockingChecks,
                checks: input.preflight.checks.map((check) => ({
                  key: check.key,
                  required: check.required,
                  status: check.status,
                })),
              },
      }),
    )
    .digest("hex");
}

export function normalizeMetaExecutionStatus(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function summarizeExecutionStateValue(value: string | number | null | undefined) {
  if (value == null) return "Unavailable";
  if (typeof value === "number") {
    return Number.isFinite(value) ? `${Math.round(value)}` : "Unavailable";
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : "Unavailable";
}
