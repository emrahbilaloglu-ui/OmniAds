import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { buildOperatorInstruction } from "@/lib/operator-prescription";
import { emitOperatorDecisionTelemetryEvent } from "@/lib/operator-decision-telemetry";

/*
 * Re-exported, not redeclared. The vocabulary lives in a module with no
 * imports so a client component can read it without dragging `lib/db` — and
 * therefore `pg` — into the browser bundle.
 */
import {
  META_DECISION_RESPONSE_ACTIONS,
  type MetaDecisionResponseAction,
} from "@/lib/meta/decision-response-actions";

export { META_DECISION_RESPONSE_ACTIONS };
export type { MetaDecisionResponseAction };

export interface MetaDecisionResponseRow {
  recId: string;
  businessId: string;
  action: MetaDecisionResponseAction;
  actionSubtype: string | null;
  timestamp: string;
  reappearAt: string | null;
}

type MetaDecisionResponseDbRow = {
  rec_id: string;
  business_id: string;
  action: MetaDecisionResponseAction;
  action_subtype: string | null;
  timestamp: string;
  reappear_at: string | null;
};

function normalizeTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapResponseRow(row: MetaDecisionResponseDbRow): MetaDecisionResponseRow {
  return {
    recId: row.rec_id,
    businessId: row.business_id,
    action: row.action,
    actionSubtype: row.action_subtype,
    timestamp: row.timestamp,
    reappearAt: row.reappear_at,
  };
}

function actionState(action: MetaDecisionResponseAction) {
  if (action === "acted") return "do_now";
  if (action === "ignored") return "do_not_touch";
  return "watch";
}

export function buildMetaDecisionResponseTelemetryInstruction(input: {
  recId: string;
  businessId: string;
  action: MetaDecisionResponseAction;
  actionSubtype?: string | null;
}) {
  const actionLabel = input.actionSubtype || input.action;
  const state = actionState(input.action);
  return buildOperatorInstruction({
    sourceSystem: "meta",
    sourceLabel: "meta_decision_os",
    policy: {
      contractVersion: "operator-policy.v1",
      state,
      actionClass: input.action,
      pushReadiness: "read_only_insight",
      queueEligible: false,
      canApply: input.action === "acted",
      reasons: [`Operator response recorded: ${input.action}.`],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: [],
      explanation: `Meta recommendation ${input.recId} received operator response ${input.action}.`,
    },
    policyVersion: "meta-decision-response.v1",
    targetScope: "recommendation",
    targetEntity: input.recId,
    parentEntity: input.businessId,
    actionLabel,
    reason: `Operator response ${input.action} was persisted for Meta recommendation ${input.recId}.`,
    confidenceScore: input.action === "acted" ? 0.8 : 0.5,
    evidenceSource: "snapshot",
    trustState: "operator_response",
    operatorDisposition: input.action,
    requiresPolicyForQueue: false,
    pushReadinessOverride: "read_only_insight",
    queueEligibleOverride: false,
    canApplyOverride: input.action === "acted",
    actionFingerprint: `${input.businessId}:${input.recId}:${input.action}:${actionLabel}`,
    evidenceHash: `${input.businessId}:${input.recId}`,
  });
}

export function emitMetaDecisionResponseTelemetry(input: {
  recId: string;
  businessId: string;
  action: MetaDecisionResponseAction;
  actionSubtype?: string | null;
}) {
  return emitOperatorDecisionTelemetryEvent({
    instruction: buildMetaDecisionResponseTelemetryInstruction(input),
    eventName: "instruction_rendered",
    emittedAt: new Date().toISOString(),
  });
}

export async function recordMetaDecisionResponse(input: {
  recId: string;
  businessId: string;
  action: MetaDecisionResponseAction;
  actionSubtype?: string | null;
  reappearAt?: string | null;
}): Promise<MetaDecisionResponseRow> {
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_decision_responses (
      rec_id,
      business_id,
      action,
      action_subtype,
      reappear_at
    ) VALUES (
      ${input.recId},
      ${input.businessId},
      ${input.action},
      ${input.actionSubtype ?? null},
      ${normalizeTimestamp(input.reappearAt)}::timestamptz
    )
    RETURNING
      rec_id,
      business_id,
      action,
      action_subtype,
      timestamp::text AS timestamp,
      reappear_at::text AS reappear_at
  `) as MetaDecisionResponseDbRow[];
  const row = rows[0];
  if (!row) throw new Error("Failed to persist Meta decision response.");
  return mapResponseRow(row);
}

export async function runMetaDecisionIgnoredMarker(input?: {
  now?: Date;
}) {
  const now = input?.now ?? new Date();
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_decision_responses (
      rec_id,
      business_id,
      action,
      action_subtype,
      timestamp
    )
    SELECT
      snapshot.rec_id,
      snapshot.business_id,
      'ignored',
      'auto_7d_no_response',
      ${now.toISOString()}::timestamptz
    FROM meta_decision_snapshots_daily snapshot
    WHERE COALESCE(snapshot.kind, 'recommendation') = 'recommendation'
      AND snapshot.created_at < (${now.toISOString()}::timestamptz - interval '7 days')
      AND NOT EXISTS (
        SELECT 1
        FROM meta_decision_responses response
        WHERE response.business_id = snapshot.business_id
          AND response.rec_id = snapshot.rec_id
      )
    RETURNING rec_id
  `) as Array<{ rec_id: string }>;
  return {
    ok: true,
    markedIgnored: rows.length,
    ranAt: now.toISOString(),
  };
}

export async function runMetaDecisionIgnoredMarkerIfDue(now = new Date()) {
  const snapshotDate = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== 4) {
    return {
      skipped: true,
      reason: "not_due" as const,
      snapshotDate,
    };
  }

  const readiness = await getDbSchemaReadiness({
    tables: ["meta_decision_snapshots_daily", "meta_decision_responses"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return {
      skipped: true,
      reason: "schema_not_ready" as const,
      snapshotDate,
    };
  }

  const result = await runMetaDecisionIgnoredMarker({ now });
  return {
    skipped: false as const,
    snapshotDate,
    ...result,
  };
}
