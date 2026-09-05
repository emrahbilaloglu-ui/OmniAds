import { createHash } from "node:crypto";
import type { LaunchpadIssue } from "@/lib/launchpad/meta";
import type { MetaLaunchpadManualAuthority } from "@/lib/launchpad/meta-manual-authority";

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
  executionAuthority?: MetaLaunchpadManualAuthority | null;
  requestFingerprint?: string | null;
  checks?: Array<Record<string, unknown>>;
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
  executionAuthority?: MetaLaunchpadManualAuthority | null;
  requestFingerprint?: string | null;
  checks?: Array<Record<string, unknown>>;
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
  executionAuthority?: MetaLaunchpadManualAuthority | null;
  requestFingerprint?: string | null;
  checks?: Array<Record<string, unknown>>;
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
  /** Unvalidated. See `validateActivationApproval`; NULL means operator-only. */
  activationApproval: unknown;
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

const META_LAUNCH_INTENT_ATTEMPT_IDENTITY_FIELDS = new Set([
  "idempotencyKey",
  "idempotency_key",
  "launchIntentId",
  "launch_intent_id",
  "requestFingerprint",
  "request_fingerprint",
]);

const OMIT_ATTEMPT_ONLY_CONTAINER = Symbol("omit-attempt-only-container");

function canonicalizeSemanticPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const canonical = canonicalizeSemanticPayload(item);
      return canonical === OMIT_ATTEMPT_ONLY_CONTAINER ? [] : [canonical];
    });
  }
  if (!value || typeof value !== "object") return value;
  const originalEntries = Object.entries(value as Record<string, unknown>);
  const canonicalEntries = originalEntries
    .filter(([key]) => !META_LAUNCH_INTENT_ATTEMPT_IDENTITY_FIELDS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, item]) => {
      const canonical = canonicalizeSemanticPayload(item);
      return canonical === OMIT_ATTEMPT_ONLY_CONTAINER
        ? []
        : [[key, canonical] as const];
    });
  return originalEntries.length > 0 && canonicalEntries.length === 0
    ? OMIT_ATTEMPT_ONLY_CONTAINER
    : Object.fromEntries(canonicalEntries);
}

export function metaLaunchIntentRequestFingerprint(input: {
  operation: MetaLaunchIntentOperation;
  providerAccountId: string;
  requestPayload: object;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalizeSemanticPayload({
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
  executionAuthority?: MetaLaunchpadManualAuthority | null;
  requestFingerprint?: string | null;
  checks?: Array<Record<string, unknown>>;
  checkedAt?: string;
}): MetaLaunchIntentValidationReceipt {
  return {
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    ok: input.ok,
    providerAccountId: input.providerAccountId,
    blockers: input.blockers,
    warnings: input.warnings,
    executionAuthority: input.executionAuthority ?? null,
    requestFingerprint: input.requestFingerprint ?? null,
    checks: input.checks ?? [],
  };
}

export function buildMetaLaunchIntentResultReceipt(input: {
  providerAccountId: string;
  campaignId?: string | null;
  adsetIds?: string[];
  adIds?: string[];
  steps?: Array<Record<string, unknown>>;
  executionAuthority?: MetaLaunchpadManualAuthority | null;
  requestFingerprint?: string | null;
  checks?: Array<Record<string, unknown>>;
  completedAt?: string;
}): MetaLaunchIntentResultReceipt {
  return {
    completedAt: input.completedAt ?? new Date().toISOString(),
    providerAccountId: input.providerAccountId,
    campaignId: input.campaignId ?? null,
    adsetIds: input.adsetIds ?? [],
    adIds: input.adIds ?? [],
    steps: input.steps ?? [],
    executionAuthority: input.executionAuthority ?? null,
    requestFingerprint: input.requestFingerprint ?? null,
    checks: input.checks ?? [],
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
  executionAuthority?: MetaLaunchpadManualAuthority | null;
  requestFingerprint?: string | null;
  checks?: Array<Record<string, unknown>>;
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
    executionAuthority: input.executionAuthority ?? null,
    requestFingerprint: input.requestFingerprint ?? null,
    checks: input.checks ?? [],
    recovery: META_LAUNCH_INTENT_RECOVERY_CONTRACT,
  };
}
