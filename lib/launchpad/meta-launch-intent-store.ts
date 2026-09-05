import { getDb, runDbTransaction } from "@/lib/db";
import {
  metaLaunchIntentRequestFingerprint,
  type MetaLaunchIntent,
  type MetaLaunchIntentErrorReceipt,
  type MetaLaunchIntentOperation,
  type MetaLaunchIntentResultReceipt,
  type MetaLaunchIntentStatus,
  type MetaLaunchIntentValidationReceipt,
} from "@/lib/launchpad/meta-launch-intent";
import { verifyMetaLaunchIntentLineage } from "@/lib/launchpad/meta-launch-intent-lineage";

type MetaLaunchIntentDbRow = {
  id: string;
  business_id: string;
  provider_account_id: string;
  operation: MetaLaunchIntentOperation;
  idempotency_key: string;
  requested_status: "PAUSED";
  source_decision_id: string | null;
  source_decision_snapshot_id: string | null;
  creative_brief_id: string | null;
  source_draft_id: string | null;
  request_payload_json: Record<string, unknown>;
  request_fingerprint: string;
  status: MetaLaunchIntentStatus;
  validation_receipt_json: MetaLaunchIntentValidationReceipt | null;
  result_receipt_json: MetaLaunchIntentResultReceipt | null;
  error_receipt_json: MetaLaunchIntentErrorReceipt | null;
  /**
   * The separate authorization to turn on what this intent created.
   *
   * `unknown` rather than a shape: it is validated against the live intent in
   * one module, and a type here would invite reading it as trustworthy simply
   * because it parsed. NULL — the state every existing row is in — means an
   * operator may activate and nothing else may.
   */
  activation_approval_json: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export class MetaLaunchIntentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaLaunchIntentTransitionError";
  }
}

export class MetaLaunchIntentSemanticGuardError extends Error {
  readonly code:
    | "launch_intent_provider_outcome_ambiguous"
    | "launch_intent_semantic_execution_in_flight";
  readonly intent: MetaLaunchIntent;

  constructor(input: {
    code:
      | "launch_intent_provider_outcome_ambiguous"
      | "launch_intent_semantic_execution_in_flight";
    message: string;
    intent: MetaLaunchIntent;
  }) {
    super(input.message);
    this.name = "MetaLaunchIntentSemanticGuardError";
    this.code = input.code;
    this.intent = input.intent;
  }
}

function mapMetaLaunchIntent(row: MetaLaunchIntentDbRow): MetaLaunchIntent {
  return {
    id: row.id,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestedStatus: row.requested_status,
    lineage: {
      sourceDecisionId: row.source_decision_id,
      sourceDecisionSnapshotId: row.source_decision_snapshot_id,
      creativeBriefId: row.creative_brief_id,
      sourceDraftId: row.source_draft_id,
    },
    requestPayload: row.request_payload_json,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    validationReceipt: row.validation_receipt_json,
    resultReceipt: row.result_receipt_json,
    errorReceipt: row.error_receipt_json,
    activationApproval: row.activation_approval_json ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function createMetaLaunchIntent(input: {
  businessId: string;
  providerAccountId: string;
  operation: MetaLaunchIntentOperation;
  idempotencyKey: string;
  requestPayload: object;
  sourceDecisionId?: string | null;
  sourceDecisionSnapshotId?: string | null;
  creativeBriefId?: string | null;
  sourceDraftId?: string | null;
  createdBy?: string | null;
}): Promise<{ created: boolean; intent: MetaLaunchIntent }> {
  const lineage = await verifyMetaLaunchIntentLineage(input);
  const requestFingerprint = metaLaunchIntentRequestFingerprint(input);
  const semanticLockKey = [
    "meta-launch-intent-semantic",
    input.businessId,
    input.providerAccountId,
    input.operation,
    requestFingerprint,
  ].join(":");

  return runDbTransaction(async () => {
    const sql = getDb();
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${semanticLockKey}, 0)
      )
    `;
    const semanticBlockers = (await sql`
      SELECT *
      FROM meta_launch_intents
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND operation = ${input.operation}
        AND request_fingerprint = ${requestFingerprint}
        AND (
          (
            status = 'silent_failure'
            AND error_receipt_json->>'code' = 'provider_outcome_ambiguous'
          )
          OR (
            idempotency_key <> ${input.idempotencyKey}
            AND status IN ('prepared', 'ready', 'executing')
          )
        )
      ORDER BY
        CASE
          WHEN error_receipt_json->>'code' = 'provider_outcome_ambiguous'
          THEN 0
          ELSE 1
        END,
        created_at DESC,
        id DESC
      LIMIT 1
    `) as MetaLaunchIntentDbRow[];
    const semanticBlocker = semanticBlockers[0];
    if (semanticBlocker) {
      const intent = mapMetaLaunchIntent(semanticBlocker);
      const ambiguous =
        semanticBlocker.status === "silent_failure" &&
        semanticBlocker.error_receipt_json?.code ===
          "provider_outcome_ambiguous";
      throw new MetaLaunchIntentSemanticGuardError({
        code: ambiguous
          ? "launch_intent_provider_outcome_ambiguous"
          : "launch_intent_semantic_execution_in_flight",
        message: ambiguous
          ? "An unresolved provider-write outcome already exists for this exact account, operation, and semantic request. Reconcile the exact Meta state and Audit Trail first; changing the idempotency key cannot authorize another intent or provider mutation."
          : "An equivalent semantic LaunchIntent is already prepared or executing for this account. Reuse that exact intent; changing the idempotency key cannot create a parallel provider mutation.",
        intent,
      });
    }

    const rows = (await sql`
      INSERT INTO meta_launch_intents (
        business_id,
        provider_account_id,
        operation,
        idempotency_key,
        requested_status,
        source_decision_id,
        source_decision_snapshot_id,
        creative_brief_id,
        source_draft_id,
        request_payload_json,
        request_fingerprint,
        status,
        created_by
      ) VALUES (
        ${input.businessId},
        ${input.providerAccountId},
        ${input.operation},
        ${input.idempotencyKey},
        'PAUSED',
        ${lineage.sourceDecisionId},
        ${lineage.sourceDecisionSnapshotId},
        ${lineage.creativeBriefId},
        ${lineage.sourceDraftId},
        ${JSON.stringify(input.requestPayload)}::jsonb,
        ${requestFingerprint},
        'prepared',
        ${input.createdBy ?? null}
      )
      ON CONFLICT (business_id, provider_account_id, operation, idempotency_key)
      DO NOTHING
      RETURNING *
    `) as MetaLaunchIntentDbRow[];
    const created = rows[0];
    if (created) return { created: true, intent: mapMetaLaunchIntent(created) };

    const existing = await getMetaLaunchIntentByIdempotencyKey({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
    });
    if (!existing) {
      throw new Error("Failed to persist or recover the Meta launch intent.");
    }
    return { created: false, intent: existing };
  });
}

export async function getMetaLaunchIntent(input: {
  businessId: string;
  id: string;
}): Promise<MetaLaunchIntent | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_launch_intents
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
    LIMIT 1
  `) as MetaLaunchIntentDbRow[];
  return rows[0] ? mapMetaLaunchIntent(rows[0]) : null;
}

export async function getMetaLaunchIntentByIdempotencyKey(input: {
  businessId: string;
  providerAccountId: string;
  operation: MetaLaunchIntentOperation;
  idempotencyKey: string;
}): Promise<MetaLaunchIntent | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_launch_intents
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND operation = ${input.operation}
      AND idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `) as MetaLaunchIntentDbRow[];
  return rows[0] ? mapMetaLaunchIntent(rows[0]) : null;
}

export async function listMetaLaunchIntents(input: {
  businessId: string;
  providerAccountId: string;
  limit?: number;
}): Promise<MetaLaunchIntent[]> {
  const sql = getDb();
  const requestedLimit = Number(input.limit ?? 25);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
    : 25;
  const rows = (await sql`
    SELECT *
    FROM meta_launch_intents
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `) as MetaLaunchIntentDbRow[];
  return rows.map(mapMetaLaunchIntent);
}

async function requireUpdatedIntent(rows: MetaLaunchIntentDbRow[], message: string) {
  const row = rows[0];
  if (!row) throw new MetaLaunchIntentTransitionError(message);
  return mapMetaLaunchIntent(row);
}

export async function recordMetaLaunchIntentValidation(input: {
  businessId: string;
  id: string;
  receipt: MetaLaunchIntentValidationReceipt;
  errorReceipt?: MetaLaunchIntentErrorReceipt | null;
}): Promise<MetaLaunchIntent> {
  const sql = getDb();
  const nextStatus: MetaLaunchIntentStatus = input.receipt.ok
    ? "ready"
    : "validation_blocked";
  const rows = (await sql`
    UPDATE meta_launch_intents
    SET
      status = ${nextStatus},
      validation_receipt_json = ${JSON.stringify(input.receipt)}::jsonb,
      error_receipt_json = ${
        input.errorReceipt ? JSON.stringify(input.errorReceipt) : null
      }::jsonb,
      completed_at = CASE WHEN ${input.receipt.ok} THEN NULL ELSE NOW() END,
      updated_at = NOW()
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
      AND status = 'prepared'
    RETURNING *
  `) as MetaLaunchIntentDbRow[];
  return requireUpdatedIntent(rows, "Launch intent is not in prepared state.");
}

export async function markMetaLaunchIntentExecuting(input: {
  businessId: string;
  id: string;
}): Promise<MetaLaunchIntent> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE meta_launch_intents
    SET status = 'executing', started_at = NOW(), updated_at = NOW()
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
      AND status = 'ready'
    RETURNING *
  `) as MetaLaunchIntentDbRow[];
  return requireUpdatedIntent(rows, "Launch intent is not ready for execution.");
}

export async function recordMetaLaunchIntentWriteBlocked(input: {
  businessId: string;
  id: string;
  receipt: MetaLaunchIntentErrorReceipt;
}): Promise<MetaLaunchIntent> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE meta_launch_intents
    SET
      status = 'write_blocked',
      error_receipt_json = ${JSON.stringify(input.receipt)}::jsonb,
      completed_at = NOW(),
      updated_at = NOW()
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
      AND status IN ('prepared', 'ready')
    RETURNING *
  `) as MetaLaunchIntentDbRow[];
  return requireUpdatedIntent(rows, "Launch intent cannot be marked write-blocked.");
}

export async function recordMetaLaunchIntentPreExecutionFailure(input: {
  businessId: string;
  id: string;
  receipt: MetaLaunchIntentErrorReceipt;
}): Promise<MetaLaunchIntent> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE meta_launch_intents
    SET
      status = 'failed',
      error_receipt_json = ${JSON.stringify(input.receipt)}::jsonb,
      completed_at = NOW(),
      updated_at = NOW()
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
      AND status IN ('prepared', 'ready')
    RETURNING *
  `) as MetaLaunchIntentDbRow[];
  return requireUpdatedIntent(
    rows,
    "Launch intent cannot record a pre-execution failure.",
  );
}

export async function recordMetaLaunchIntentOutcome(input: {
  businessId: string;
  id: string;
  status: Extract<
    MetaLaunchIntentStatus,
    "succeeded" | "partially_succeeded" | "failed" | "silent_failure"
  >;
  resultReceipt?: MetaLaunchIntentResultReceipt | null;
  errorReceipt?: MetaLaunchIntentErrorReceipt | null;
}): Promise<MetaLaunchIntent> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE meta_launch_intents
    SET
      status = ${input.status},
      result_receipt_json = ${
        input.resultReceipt ? JSON.stringify(input.resultReceipt) : null
      }::jsonb,
      error_receipt_json = ${
        input.errorReceipt ? JSON.stringify(input.errorReceipt) : null
      }::jsonb,
      completed_at = NOW(),
      updated_at = NOW()
    WHERE business_id = ${input.businessId}
      AND id = ${input.id}
      AND status = 'executing'
    RETURNING *
  `) as MetaLaunchIntentDbRow[];
  return requireUpdatedIntent(rows, "Launch intent is not executing.");
}
