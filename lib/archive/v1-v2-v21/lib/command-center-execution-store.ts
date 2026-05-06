import { getDb } from "@/lib/db";
import {
  assertDbSchemaReady,
  getDbSchemaReadiness,
} from "@/lib/db-schema-readiness";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import type {
  CommandCenterActionStatus,
  CommandCenterSourceSystem,
  CommandCenterSourceType,
} from "@/lib/command-center";
import type {
  CommandCenterExecutionAuditEntry,
  CommandCenterExecutionOperation,
  CommandCenterExecutionPreflightReport,
  CommandCenterExecutionProviderDiffEvidence,
  CommandCenterExecutionStateRecord,
  CommandCenterExecutionStateSummary,
  CommandCenterExecutionSupportMode,
  CommandCenterExecutionStatus,
  CommandCenterExecutionValidationReport,
  CommandCenterExecutionExternalRefs,
  MetaExecutionRollbackKind,
} from "@/lib/command-center-execution";

const COMMAND_CENTER_EXECUTION_TABLES = [
  "command_center_action_execution_state",
  "command_center_action_execution_audit",
] as const;

async function resolveCommandCenterExecutionBusinessRefId(businessId: string) {
  const businessRefIds = await resolveBusinessReferenceIds([businessId]);
  return businessRefIds.get(businessId) ?? null;
}

function isUndefinedColumnError(error: unknown, columnNames: string[]) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === "42703") return true;
  const message = candidate.message?.toLowerCase() ?? "";
  if (!message.includes("column") || !message.includes("does not exist")) {
    return false;
  }
  return columnNames.some((columnName) => message.includes(columnName.toLowerCase()));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parseJsonObject(parsed);
    } catch {
      return {};
    }
  }
  return {};
}

function parseSummary(value: unknown): CommandCenterExecutionStateSummary | null {
  const candidate = parseJsonObject(value);
  if (Object.keys(candidate).length === 0) return null;
  return {
    status:
      typeof candidate.status === "string" ? candidate.status : null,
    budgetLevel:
      candidate.budgetLevel === "campaign" || candidate.budgetLevel === "adset"
        ? candidate.budgetLevel
        : null,
    dailyBudget:
      typeof candidate.dailyBudget === "number" && Number.isFinite(candidate.dailyBudget)
        ? candidate.dailyBudget
        : null,
    lifetimeBudget:
      typeof candidate.lifetimeBudget === "number" &&
      Number.isFinite(candidate.lifetimeBudget)
        ? candidate.lifetimeBudget
        : null,
    optimizationGoal:
      typeof candidate.optimizationGoal === "string"
        ? candidate.optimizationGoal
        : null,
    bidStrategyLabel:
      typeof candidate.bidStrategyLabel === "string"
        ? candidate.bidStrategyLabel
        : null,
  };
}

function parseExternalRefs(value: unknown): CommandCenterExecutionExternalRefs | null {
  const candidate = parseJsonObject(value);
  if (Object.keys(candidate).length === 0) return null;
  return {
    provider: "meta",
    providerAccountId:
      typeof candidate.providerAccountId === "string"
        ? candidate.providerAccountId
        : null,
    campaignId:
      typeof candidate.campaignId === "string" ? candidate.campaignId : null,
    campaignName:
      typeof candidate.campaignName === "string"
        ? candidate.campaignName
        : null,
    adSetId: typeof candidate.adSetId === "string" ? candidate.adSetId : null,
    adSetName:
      typeof candidate.adSetName === "string" ? candidate.adSetName : null,
  };
}

function parsePreflight(
  value: unknown,
): CommandCenterExecutionPreflightReport | null {
  const candidate = parseJsonObject(value);
  if (Object.keys(candidate).length === 0) return null;
  const checks = Array.isArray(candidate.checks)
    ? candidate.checks
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => {
          const check = entry as Record<string, unknown>;
          return {
            key: typeof check.key === "string" ? check.key : "unknown",
            label: typeof check.label === "string" ? check.label : "Unknown check",
            required: Boolean(check.required),
            status:
              check.status === "pass" ||
              check.status === "warn" ||
              check.status === "fail"
                ? check.status
                : "fail",
            detail:
              typeof check.detail === "string"
                ? check.detail
                : "No detail available.",
          } satisfies NonNullable<
            CommandCenterExecutionPreflightReport["checks"][number]
          >;
        })
    : [];
  return {
    generatedAt:
      typeof candidate.generatedAt === "string"
        ? candidate.generatedAt
        : new Date(0).toISOString(),
    readyForApply: Boolean(candidate.readyForApply),
    blockingChecks: Array.isArray(candidate.blockingChecks)
      ? candidate.blockingChecks.filter((entry): entry is string => typeof entry === "string")
      : [],
    checks,
  };
}

function parseValidation(
  value: unknown,
): CommandCenterExecutionValidationReport | null {
  const candidate = parseJsonObject(value);
  if (Object.keys(candidate).length === 0) return null;
  return {
    operation:
      candidate.operation === "apply" || candidate.operation === "rollback"
        ? candidate.operation
        : "apply",
    status:
      candidate.status === "passed" ||
      candidate.status === "failed" ||
      candidate.status === "not_run"
        ? candidate.status
        : "not_run",
    checkedAt:
      typeof candidate.checkedAt === "string"
        ? candidate.checkedAt
        : new Date(0).toISOString(),
    matchedRequestedState: Boolean(candidate.matchedRequestedState),
    mismatchReasons: Array.isArray(candidate.mismatchReasons)
      ? candidate.mismatchReasons.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function parseDiffItem(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const changeType = candidate.changeType;
  if (
    changeType !== "status" &&
    changeType !== "increase" &&
    changeType !== "decrease" &&
    changeType !== "set" &&
    changeType !== "none"
  ) {
    return null;
  }
  return {
    key: typeof candidate.key === "string" ? candidate.key : "unknown",
    label: typeof candidate.label === "string" ? candidate.label : "Unknown diff",
    currentValue:
      typeof candidate.currentValue === "string"
        ? candidate.currentValue
        : "Unavailable",
    requestedValue:
      typeof candidate.requestedValue === "string"
        ? candidate.requestedValue
        : "Unavailable",
    changeType,
  } satisfies CommandCenterExecutionProviderDiffEvidence["providerChangeDiff"][number];
}

function parseProviderDiffEvidence(
  value: unknown,
): CommandCenterExecutionProviderDiffEvidence | null {
  const candidate = parseJsonObject(value);
  if (Object.keys(candidate).length === 0) return null;
  return {
    provider: "meta",
    targetId:
      typeof candidate.targetId === "string" ? candidate.targetId : null,
    observedAt:
      typeof candidate.observedAt === "string"
        ? candidate.observedAt
        : new Date(0).toISOString(),
    baselineState: parseSummary(candidate.baselineState),
    requestedState: parseSummary(candidate.requestedState),
    observedState: parseSummary(candidate.observedState),
    providerChangeDiff: Array.isArray(candidate.providerChangeDiff)
      ? candidate.providerChangeDiff
          .map(parseDiffItem)
          .filter((entry): entry is NonNullable<ReturnType<typeof parseDiffItem>> => Boolean(entry))
      : [],
    remainingDriftDiff: Array.isArray(candidate.remainingDriftDiff)
      ? candidate.remainingDriftDiff
          .map(parseDiffItem)
          .filter((entry): entry is NonNullable<ReturnType<typeof parseDiffItem>> => Boolean(entry))
      : [],
    matchedRequestedState: Boolean(candidate.matchedRequestedState),
    mismatchReasons: Array.isArray(candidate.mismatchReasons)
      ? candidate.mismatchReasons.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export async function getCommandCenterExecutionState(input: {
  businessId: string;
  actionFingerprint: string;
}) {
  const readiness = await getDbSchemaReadiness({
    tables: ["command_center_action_execution_state"],
  }).catch(() => null);
  if (!readiness?.ready) return null;

  const sql = getDb();
  const runSelect = async (legacyColumns = false) =>
    legacyColumns
      ? ((await sql`
          SELECT
            business_id,
            action_fingerprint,
            execution_status,
            support_mode,
            source_system,
            source_type,
            requested_action,
            preview_hash,
            NULL::text AS capability_key,
            workflow_status_snapshot,
            approval_actor_user_id,
            approval_actor_name,
            approval_actor_email,
            approved_at,
            applied_by_user_id,
            applied_by_name,
            applied_by_email,
            applied_at,
            rollback_kind,
            rollback_note,
            last_client_mutation_id,
            last_error_code,
            last_error_message,
            current_state_json,
            requested_state_json,
            captured_pre_apply_state_json,
            'null'::jsonb AS preflight_json,
            'null'::jsonb AS validation_json,
            'null'::jsonb AS provider_diff_json,
            provider_response_json,
            created_at,
            updated_at
          FROM command_center_action_execution_state
          WHERE business_id = ${input.businessId}
            AND action_fingerprint = ${input.actionFingerprint}
          LIMIT 1
        `) as Array<{
          business_id: string;
          action_fingerprint: string;
          execution_status: CommandCenterExecutionStatus;
          support_mode: CommandCenterExecutionSupportMode;
          source_system: CommandCenterSourceSystem;
          source_type: CommandCenterSourceType;
          requested_action: string;
          preview_hash: string | null;
          capability_key: string | null;
          workflow_status_snapshot: CommandCenterActionStatus;
          approval_actor_user_id: string | null;
          approval_actor_name: string | null;
          approval_actor_email: string | null;
          approved_at: string | null;
          applied_by_user_id: string | null;
          applied_by_name: string | null;
          applied_by_email: string | null;
          applied_at: string | null;
          rollback_kind: MetaExecutionRollbackKind;
          rollback_note: string | null;
          last_client_mutation_id: string | null;
          last_error_code: string | null;
          last_error_message: string | null;
          current_state_json: unknown;
          requested_state_json: unknown;
          captured_pre_apply_state_json: unknown;
          preflight_json: unknown;
          validation_json: unknown;
          provider_diff_json: unknown;
          provider_response_json: unknown;
          created_at: string;
          updated_at: string;
        }>)
      : ((await sql`
          SELECT
            business_id,
            action_fingerprint,
            execution_status,
            support_mode,
            source_system,
            source_type,
            requested_action,
            preview_hash,
            capability_key,
            workflow_status_snapshot,
            approval_actor_user_id,
            approval_actor_name,
            approval_actor_email,
            approved_at,
            applied_by_user_id,
            applied_by_name,
            applied_by_email,
            applied_at,
            rollback_kind,
            rollback_note,
            last_client_mutation_id,
            last_error_code,
            last_error_message,
            current_state_json,
            requested_state_json,
            captured_pre_apply_state_json,
            preflight_json,
            validation_json,
            provider_diff_json,
            provider_response_json,
            created_at,
            updated_at
          FROM command_center_action_execution_state
          WHERE business_id = ${input.businessId}
            AND action_fingerprint = ${input.actionFingerprint}
          LIMIT 1
        `) as Array<{
    business_id: string;
    action_fingerprint: string;
    execution_status: CommandCenterExecutionStatus;
    support_mode: CommandCenterExecutionSupportMode;
    source_system: CommandCenterSourceSystem;
    source_type: CommandCenterSourceType;
    requested_action: string;
    preview_hash: string | null;
    capability_key: string | null;
    workflow_status_snapshot: CommandCenterActionStatus;
    approval_actor_user_id: string | null;
    approval_actor_name: string | null;
    approval_actor_email: string | null;
    approved_at: string | null;
    applied_by_user_id: string | null;
    applied_by_name: string | null;
    applied_by_email: string | null;
    applied_at: string | null;
    rollback_kind: MetaExecutionRollbackKind;
    rollback_note: string | null;
    last_client_mutation_id: string | null;
    last_error_code: string | null;
    last_error_message: string | null;
    current_state_json: unknown;
    requested_state_json: unknown;
    captured_pre_apply_state_json: unknown;
    preflight_json: unknown;
    validation_json: unknown;
    provider_diff_json: unknown;
    provider_response_json: unknown;
    created_at: string;
    updated_at: string;
  }>);
  let rows: Awaited<ReturnType<typeof runSelect>>;
  try {
    rows = await runSelect(false);
  } catch (error) {
    if (
      !isUndefinedColumnError(error, [
        "capability_key",
        "preflight_json",
        "validation_json",
        "provider_diff_json",
      ])
    ) {
      throw error;
    }
    rows = await runSelect(true);
  }

  const row = rows[0];
  if (!row) return null;
  return {
    businessId: row.business_id,
    actionFingerprint: row.action_fingerprint,
    executionStatus: row.execution_status,
    supportMode: row.support_mode,
    sourceSystem: row.source_system,
    sourceType: row.source_type,
    requestedAction: row.requested_action,
    previewHash: row.preview_hash,
    capabilityKey: row.capability_key,
    workflowStatusSnapshot: row.workflow_status_snapshot,
    approvalActorUserId: row.approval_actor_user_id,
    approvalActorName: row.approval_actor_name,
    approvalActorEmail: row.approval_actor_email,
    approvedAt: row.approved_at,
    appliedByUserId: row.applied_by_user_id,
    appliedByName: row.applied_by_name,
    appliedByEmail: row.applied_by_email,
    appliedAt: row.applied_at,
    rollbackKind: row.rollback_kind,
    rollbackNote: row.rollback_note,
    lastClientMutationId: row.last_client_mutation_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    currentState: parseSummary(row.current_state_json),
    requestedState: parseSummary(row.requested_state_json),
    capturedPreApplyState: parseSummary(row.captured_pre_apply_state_json),
    preflight: parsePreflight(row.preflight_json),
    latestValidation: parseValidation(row.validation_json),
    providerDiffEvidence: parseProviderDiffEvidence(row.provider_diff_json),
    providerResponse: parseJsonObject(row.provider_response_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies CommandCenterExecutionStateRecord;
}

export async function listCommandCenterExecutionAudit(input: {
  businessId: string;
  actionFingerprint: string;
  limit?: number;
}) {
  const readiness = await getDbSchemaReadiness({
    tables: ["command_center_action_execution_audit"],
  }).catch(() => null);
  if (!readiness?.ready) return [];

  const sql = getDb();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
  const runSelect = async (legacyColumns = false) =>
    legacyColumns
      ? ((await sql`
          SELECT
            id,
            business_id,
            action_fingerprint,
            operation,
            execution_status,
            support_mode,
            actor_user_id,
            actor_name,
            actor_email,
            approval_actor_user_id,
            approval_actor_name,
            approval_actor_email,
            approved_at,
            preview_hash,
            NULL::text AS capability_key,
            rollback_kind,
            rollback_note,
            current_state_json,
            requested_state_json,
            captured_pre_apply_state_json,
            'null'::jsonb AS preflight_json,
            'null'::jsonb AS validation_json,
            'null'::jsonb AS provider_diff_json,
            provider_response_json,
            failure_reason,
            external_refs_json,
            created_at
          FROM command_center_action_execution_audit
          WHERE business_id = ${input.businessId}
            AND action_fingerprint = ${input.actionFingerprint}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `) as Array<{
          id: string;
          business_id: string;
          action_fingerprint: string;
          operation: CommandCenterExecutionOperation;
          execution_status: CommandCenterExecutionStatus;
          support_mode: CommandCenterExecutionSupportMode;
          actor_user_id: string | null;
          actor_name: string | null;
          actor_email: string | null;
          approval_actor_user_id: string | null;
          approval_actor_name: string | null;
          approval_actor_email: string | null;
          approved_at: string | null;
          preview_hash: string | null;
          capability_key: string | null;
          rollback_kind: MetaExecutionRollbackKind;
          rollback_note: string | null;
          current_state_json: unknown;
          requested_state_json: unknown;
          captured_pre_apply_state_json: unknown;
          preflight_json: unknown;
          validation_json: unknown;
          provider_diff_json: unknown;
          provider_response_json: unknown;
          failure_reason: string | null;
          external_refs_json: unknown;
          created_at: string;
        }>)
      : ((await sql`
          SELECT
            id,
            business_id,
            action_fingerprint,
            operation,
            execution_status,
            support_mode,
            actor_user_id,
            actor_name,
            actor_email,
            approval_actor_user_id,
            approval_actor_name,
            approval_actor_email,
            approved_at,
            preview_hash,
            capability_key,
            rollback_kind,
            rollback_note,
            current_state_json,
            requested_state_json,
            captured_pre_apply_state_json,
            preflight_json,
            validation_json,
            provider_diff_json,
            provider_response_json,
            failure_reason,
            external_refs_json,
            created_at
          FROM command_center_action_execution_audit
          WHERE business_id = ${input.businessId}
            AND action_fingerprint = ${input.actionFingerprint}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `) as Array<{
    id: string;
    business_id: string;
    action_fingerprint: string;
    operation: CommandCenterExecutionOperation;
    execution_status: CommandCenterExecutionStatus;
    support_mode: CommandCenterExecutionSupportMode;
    actor_user_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
    approval_actor_user_id: string | null;
    approval_actor_name: string | null;
    approval_actor_email: string | null;
    approved_at: string | null;
    preview_hash: string | null;
    capability_key: string | null;
    rollback_kind: MetaExecutionRollbackKind;
    rollback_note: string | null;
    current_state_json: unknown;
    requested_state_json: unknown;
    captured_pre_apply_state_json: unknown;
    preflight_json: unknown;
    validation_json: unknown;
    provider_diff_json: unknown;
    provider_response_json: unknown;
    failure_reason: string | null;
    external_refs_json: unknown;
    created_at: string;
  }>);
  let rows: Awaited<ReturnType<typeof runSelect>>;
  try {
    rows = await runSelect(false);
  } catch (error) {
    if (
      !isUndefinedColumnError(error, [
        "capability_key",
        "preflight_json",
        "validation_json",
        "provider_diff_json",
      ])
    ) {
      throw error;
    }
    rows = await runSelect(true);
  }

  return rows.map(
    (row) =>
      ({
        id: row.id,
        businessId: row.business_id,
        actionFingerprint: row.action_fingerprint,
        operation: row.operation,
        executionStatus: row.execution_status,
        supportMode: row.support_mode,
        actorUserId: row.actor_user_id,
        actorName: row.actor_name,
        actorEmail: row.actor_email,
        approvalActorUserId: row.approval_actor_user_id,
        approvalActorName: row.approval_actor_name,
        approvalActorEmail: row.approval_actor_email,
        approvedAt: row.approved_at,
        previewHash: row.preview_hash,
        capabilityKey: row.capability_key,
        rollbackKind: row.rollback_kind,
        rollbackNote: row.rollback_note,
        currentState: parseSummary(row.current_state_json),
        requestedState: parseSummary(row.requested_state_json),
        capturedPreApplyState: parseSummary(row.captured_pre_apply_state_json),
        preflight: parsePreflight(row.preflight_json),
        validation: parseValidation(row.validation_json),
        providerDiffEvidence: parseProviderDiffEvidence(row.provider_diff_json),
        providerResponse: parseJsonObject(row.provider_response_json),
        failureReason: row.failure_reason,
        externalRefs: parseExternalRefs(row.external_refs_json),
        createdAt: row.created_at,
      }) satisfies CommandCenterExecutionAuditEntry,
  );
}

export async function upsertCommandCenterExecutionState(input: {
  businessId: string;
  actionFingerprint: string;
  executionStatus: CommandCenterExecutionStatus;
  supportMode: CommandCenterExecutionSupportMode;
  sourceSystem: CommandCenterSourceSystem;
  sourceType: CommandCenterSourceType;
  requestedAction: string;
  previewHash: string | null;
  capabilityKey?: string | null;
  workflowStatusSnapshot: CommandCenterActionStatus;
  approvalActorUserId?: string | null;
  approvalActorName?: string | null;
  approvalActorEmail?: string | null;
  approvedAt?: string | null;
  appliedByUserId?: string | null;
  appliedByName?: string | null;
  appliedByEmail?: string | null;
  appliedAt?: string | null;
  rollbackKind?: MetaExecutionRollbackKind;
  rollbackNote?: string | null;
  lastClientMutationId?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  currentState?: CommandCenterExecutionStateSummary | null;
  requestedState?: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState?: CommandCenterExecutionStateSummary | null;
  preflight?: CommandCenterExecutionPreflightReport | null;
  latestValidation?: CommandCenterExecutionValidationReport | null;
  providerDiffEvidence?: CommandCenterExecutionProviderDiffEvidence | null;
  providerResponse?: Record<string, unknown>;
}) {
  await assertDbSchemaReady({
    tables: [...COMMAND_CENTER_EXECUTION_TABLES],
    context: "command_center_execution:upsert_state",
  });

  const sql = getDb();
  const businessRefId = await resolveCommandCenterExecutionBusinessRefId(input.businessId);
  await sql`
    INSERT INTO command_center_action_execution_state (
      business_id,
      business_ref_id,
      action_fingerprint,
      execution_status,
      support_mode,
      source_system,
      source_type,
      requested_action,
      preview_hash,
      capability_key,
      workflow_status_snapshot,
      approval_actor_user_id,
      approval_actor_name,
      approval_actor_email,
      approved_at,
      applied_by_user_id,
      applied_by_name,
      applied_by_email,
      applied_at,
      rollback_kind,
      rollback_note,
      last_client_mutation_id,
      last_error_code,
      last_error_message,
      current_state_json,
      requested_state_json,
      captured_pre_apply_state_json,
      preflight_json,
      validation_json,
      provider_diff_json,
      provider_response_json
    )
    VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.actionFingerprint},
      ${input.executionStatus},
      ${input.supportMode},
      ${input.sourceSystem},
      ${input.sourceType},
      ${input.requestedAction},
      ${input.previewHash},
      ${input.capabilityKey ?? null},
      ${input.workflowStatusSnapshot},
      ${input.approvalActorUserId ?? null},
      ${input.approvalActorName ?? null},
      ${input.approvalActorEmail ?? null},
      ${input.approvedAt ?? null},
      ${input.appliedByUserId ?? null},
      ${input.appliedByName ?? null},
      ${input.appliedByEmail ?? null},
      ${input.appliedAt ?? null},
      ${input.rollbackKind ?? "not_available"},
      ${input.rollbackNote ?? null},
      ${input.lastClientMutationId ?? null},
      ${input.lastErrorCode ?? null},
      ${input.lastErrorMessage ?? null},
      ${JSON.stringify(input.currentState ?? null)},
      ${JSON.stringify(input.requestedState ?? null)},
      ${JSON.stringify(input.capturedPreApplyState ?? null)},
      ${JSON.stringify(input.preflight ?? null)},
      ${JSON.stringify(input.latestValidation ?? null)},
      ${JSON.stringify(input.providerDiffEvidence ?? null)},
      ${JSON.stringify(input.providerResponse ?? {})}
    )
    ON CONFLICT (business_id, action_fingerprint)
    DO UPDATE SET
      business_ref_id = COALESCE(
        command_center_action_execution_state.business_ref_id,
        EXCLUDED.business_ref_id
      ),
      execution_status = EXCLUDED.execution_status,
      support_mode = EXCLUDED.support_mode,
      source_system = EXCLUDED.source_system,
      source_type = EXCLUDED.source_type,
      requested_action = EXCLUDED.requested_action,
      preview_hash = EXCLUDED.preview_hash,
      capability_key = EXCLUDED.capability_key,
      workflow_status_snapshot = EXCLUDED.workflow_status_snapshot,
      approval_actor_user_id = EXCLUDED.approval_actor_user_id,
      approval_actor_name = EXCLUDED.approval_actor_name,
      approval_actor_email = EXCLUDED.approval_actor_email,
      approved_at = EXCLUDED.approved_at,
      applied_by_user_id = EXCLUDED.applied_by_user_id,
      applied_by_name = EXCLUDED.applied_by_name,
      applied_by_email = EXCLUDED.applied_by_email,
      applied_at = EXCLUDED.applied_at,
      rollback_kind = EXCLUDED.rollback_kind,
      rollback_note = EXCLUDED.rollback_note,
      last_client_mutation_id = EXCLUDED.last_client_mutation_id,
      last_error_code = EXCLUDED.last_error_code,
      last_error_message = EXCLUDED.last_error_message,
      current_state_json = EXCLUDED.current_state_json,
      requested_state_json = EXCLUDED.requested_state_json,
      captured_pre_apply_state_json = EXCLUDED.captured_pre_apply_state_json,
      preflight_json = EXCLUDED.preflight_json,
      validation_json = EXCLUDED.validation_json,
      provider_diff_json = EXCLUDED.provider_diff_json,
      provider_response_json = EXCLUDED.provider_response_json,
      updated_at = now()
  `;

  return getCommandCenterExecutionState({
    businessId: input.businessId,
    actionFingerprint: input.actionFingerprint,
  });
}

export async function appendCommandCenterExecutionAudit(input: {
  businessId: string;
  actionFingerprint: string;
  clientMutationId: string;
  operation: CommandCenterExecutionOperation;
  executionStatus: CommandCenterExecutionStatus;
  supportMode: CommandCenterExecutionSupportMode;
  actorUserId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  approvalActorUserId?: string | null;
  approvalActorName?: string | null;
  approvalActorEmail?: string | null;
  approvedAt?: string | null;
  previewHash?: string | null;
  capabilityKey?: string | null;
  rollbackKind?: MetaExecutionRollbackKind;
  rollbackNote?: string | null;
  currentState?: CommandCenterExecutionStateSummary | null;
  requestedState?: CommandCenterExecutionStateSummary | null;
  capturedPreApplyState?: CommandCenterExecutionStateSummary | null;
  preflight?: CommandCenterExecutionPreflightReport | null;
  validation?: CommandCenterExecutionValidationReport | null;
  providerDiffEvidence?: CommandCenterExecutionProviderDiffEvidence | null;
  providerResponse?: Record<string, unknown>;
  failureReason?: string | null;
  externalRefs?: CommandCenterExecutionExternalRefs | null;
}) {
  await assertDbSchemaReady({
    tables: [...COMMAND_CENTER_EXECUTION_TABLES],
    context: "command_center_execution:append_audit",
  });

  const sql = getDb();
  const businessRefId = await resolveCommandCenterExecutionBusinessRefId(input.businessId);
  await sql`
    INSERT INTO command_center_action_execution_audit (
      business_id,
      business_ref_id,
      action_fingerprint,
      client_mutation_id,
      operation,
      execution_status,
      support_mode,
      actor_user_id,
      actor_name,
      actor_email,
      approval_actor_user_id,
      approval_actor_name,
      approval_actor_email,
      approved_at,
      preview_hash,
      capability_key,
      rollback_kind,
      rollback_note,
      current_state_json,
      requested_state_json,
      captured_pre_apply_state_json,
      preflight_json,
      validation_json,
      provider_diff_json,
      provider_response_json,
      failure_reason,
      external_refs_json
    )
    VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.actionFingerprint},
      ${input.clientMutationId},
      ${input.operation},
      ${input.executionStatus},
      ${input.supportMode},
      ${input.actorUserId ?? null},
      ${input.actorName ?? null},
      ${input.actorEmail ?? null},
      ${input.approvalActorUserId ?? null},
      ${input.approvalActorName ?? null},
      ${input.approvalActorEmail ?? null},
      ${input.approvedAt ?? null},
      ${input.previewHash ?? null},
      ${input.capabilityKey ?? null},
      ${input.rollbackKind ?? "not_available"},
      ${input.rollbackNote ?? null},
      ${JSON.stringify(input.currentState ?? null)},
      ${JSON.stringify(input.requestedState ?? null)},
      ${JSON.stringify(input.capturedPreApplyState ?? null)},
      ${JSON.stringify(input.preflight ?? null)},
      ${JSON.stringify(input.validation ?? null)},
      ${JSON.stringify(input.providerDiffEvidence ?? null)},
      ${JSON.stringify(input.providerResponse ?? {})},
      ${input.failureReason ?? null},
      ${JSON.stringify(input.externalRefs ?? null)}
    )
    ON CONFLICT (business_id, client_mutation_id) DO NOTHING
  `;

  return listCommandCenterExecutionAudit({
    businessId: input.businessId,
    actionFingerprint: input.actionFingerprint,
    limit: 1,
  }).then((entries) => entries[0] ?? null);
}
