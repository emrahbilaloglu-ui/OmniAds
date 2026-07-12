import { createHash } from "node:crypto";
import type { LaunchpadIssue } from "@/lib/launchpad/meta";

export type MetaLaunchIntentOperation = "new_campaign" | "add_to_existing";

export type MetaLaunchIntentStatus =
  | "prepared"
  | "validation_blocked"
  | "write_blocked"
  | "ready"
  | "executing"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "silent_failure";

export interface MetaLaunchIntentCapability {
  status: "ready" | "migration_required";
  canRead: boolean;
  canWrite: boolean;
  missingTables: string[];
  checkedAt: string;
}

export interface MetaLaunchIntentLineage {
  sourceDecisionId: string | null;
  sourceDecisionSnapshotId: string | null;
  creativeBriefId: string | null;
  sourceDraftId: string | null;
}

export interface MetaLaunchIntentValidationReceipt {
  checkedAt: string;
  ok: boolean;
  providerAccountId: string;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
}

export interface MetaLaunchIntentRecoveryContract {
  rollbackSupported: false;
  retrySupported: false;
}

export interface MetaLaunchIntentResultReceipt {
  completedAt: string;
  providerAccountId: string;
  campaignId: string | null;
  adsetIds: string[];
  adIds: string[];
  steps: Array<Record<string, unknown>>;
  recovery: MetaLaunchIntentRecoveryContract;
}

export interface MetaLaunchIntentErrorReceipt {
  recordedAt: string;
  code: string;
  message: string;
  failedAt: string | null;
  providerAccountId: string;
  partialResult: {
    campaignId: string | null;
    adsetIds: string[];
    adIds: string[];
    steps: Array<Record<string, unknown>>;
  };
  recovery: MetaLaunchIntentRecoveryContract;
}

export interface MetaLaunchIntent {
  id: string;
  businessId: string;
  providerAccountId: string;
  operation: MetaLaunchIntentOperation;
  idempotencyKey: string;
  requestedStatus: "PAUSED";
  lineage: MetaLaunchIntentLineage;
  requestPayload: Record<string, unknown>;
  requestFingerprint: string;
  status: MetaLaunchIntentStatus;
  validationReceipt: MetaLaunchIntentValidationReceipt | null;
  resultReceipt: MetaLaunchIntentResultReceipt | null;
  errorReceipt: MetaLaunchIntentErrorReceipt | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export const META_LAUNCH_INTENT_RECOVERY_CONTRACT = {
  rollbackSupported: false,
  retrySupported: false,
} as const satisfies MetaLaunchIntentRecoveryContract;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function metaLaunchIntentRequestFingerprint(input: {
  operation: MetaLaunchIntentOperation;
  providerAccountId: string;
  requestPayload: object;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          operation: input.operation,
          providerAccountId: input.providerAccountId,
          requestedStatus: "PAUSED",
          requestPayload: input.requestPayload,
        }),
      ),
    )
    .digest("hex");
}

export function normalizeMetaLaunchIntentLineage(input: {
  sourceDecisionId?: string | null;
  sourceDecisionSnapshotId?: string | null;
  creativeBriefId?: string | null;
  sourceDraftId?: string | null;
}): MetaLaunchIntentLineage {
  const normalize = (value: string | null | undefined) => value?.trim() || null;
  return {
    sourceDecisionId: normalize(input.sourceDecisionId),
    sourceDecisionSnapshotId: normalize(input.sourceDecisionSnapshotId),
    creativeBriefId: normalize(input.creativeBriefId),
    sourceDraftId: normalize(input.sourceDraftId),
  };
}

export function buildMetaLaunchIntentValidationReceipt(input: {
  providerAccountId: string;
  ok: boolean;
  blockers: LaunchpadIssue[];
  warnings: LaunchpadIssue[];
  checkedAt?: string;
}): MetaLaunchIntentValidationReceipt {
  return {
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    ok: input.ok,
    providerAccountId: input.providerAccountId,
    blockers: input.blockers,
    warnings: input.warnings,
  };
}

export function buildMetaLaunchIntentResultReceipt(input: {
  providerAccountId: string;
  campaignId?: string | null;
  adsetIds?: string[];
  adIds?: string[];
  steps?: Array<Record<string, unknown>>;
  completedAt?: string;
}): MetaLaunchIntentResultReceipt {
  return {
    completedAt: input.completedAt ?? new Date().toISOString(),
    providerAccountId: input.providerAccountId,
    campaignId: input.campaignId ?? null,
    adsetIds: input.adsetIds ?? [],
    adIds: input.adIds ?? [],
    steps: input.steps ?? [],
    recovery: META_LAUNCH_INTENT_RECOVERY_CONTRACT,
  };
}

export function buildMetaLaunchIntentErrorReceipt(input: {
  providerAccountId: string;
  code: string;
  message: string;
  failedAt?: string | null;
  campaignId?: string | null;
  adsetIds?: string[];
  adIds?: string[];
  steps?: Array<Record<string, unknown>>;
  recordedAt?: string;
}): MetaLaunchIntentErrorReceipt {
  return {
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    code: input.code,
    message: input.message,
    failedAt: input.failedAt ?? null,
    providerAccountId: input.providerAccountId,
    partialResult: {
      campaignId: input.campaignId ?? null,
      adsetIds: input.adsetIds ?? [],
      adIds: input.adIds ?? [],
      steps: input.steps ?? [],
    },
    recovery: META_LAUNCH_INTENT_RECOVERY_CONTRACT,
  };
}
