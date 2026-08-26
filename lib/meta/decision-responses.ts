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

/**
 * Authorize and record in ONE statement.
 *
 * The route used to ask `readServedMetaRecommendation` and then INSERT. Between
 * those two the snapshot can rotate — `upsertSnapshotRows` DELETEs the day's
 * recommendation rows and re-inserts them — and a competing response can land,
 * so a permissive read could authorize a write the check would refuse a
 * millisecond later. Here the predicate IS the INSERT's `WHERE`, so the row
 * either satisfies it at write time or does not exist.
 *
 * Zero rows returned means "not authorized". A thrown error means the source
 * could not be read, and the caller must refuse rather than treat it as
 * absence — the two are different sentences to an operator.
 */
export async function recordMetaDecisionResponseIfAuthorized(input: {
  recId: string;
  businessId: string;
  providerAccountId: string | null;
  action: MetaDecisionResponseAction;
  actionSubtype?: string | null;
  reappearAt?: string | null;
}): Promise<MetaDecisionResponseRow | null> {
  const sql = getDb();
  const account = input.providerAccountId?.trim() || null;
  const isUndefer = input.action === "undeferred";
  const rows = (await sql`
    INSERT INTO meta_decision_responses (
      rec_id,
      business_id,
      provider_account_id,
      action,
      action_subtype,
      reappear_at
    )
    SELECT
      ${input.recId},
      ${input.businessId},
      ${account},
      ${input.action},
      ${input.actionSubtype ?? null},
      ${normalizeTimestamp(input.reappearAt)}::timestamptz
    WHERE
      -- All four Intelligence actions are account-scoped. A response with no
      -- physical account cannot be authorised: "the current snapshot" and "a
      -- prior deferral" are both per-account facts, and a null here would make
      -- one account's history answer for another.
      ${account}::text IS NOT NULL
      -- ...and the workspace must STILL have that account selected, proven in
      -- the same statement as the insert. An old snapshot row is not authority:
      -- a selection revoked after the snapshot was built leaves rows behind,
      -- and answering them would record an operator decision about an account
      -- this workspace no longer holds.
      AND EXISTS (
        SELECT 1
        FROM business_provider_accounts bpa
        INNER JOIN provider_accounts pa
          ON pa.id = bpa.provider_account_ref_id
        WHERE bpa.business_id = ${input.businessId}
          AND bpa.provider = 'meta'
          AND bpa.is_selected
          AND pa.external_account_id = ${account}
      )
      AND CASE WHEN ${isUndefer}::boolean THEN
        -- undeferred: the latest response for this rec IN THIS ACCOUNT must
        -- itself be an unexpired deferral. Expiry has already lifted anything
        -- older, so there would be nothing to undefer — and without the account
        -- predicate a deferral taken under account A would authorise an
        -- undefer from account B.
        EXISTS (
          SELECT 1
          FROM (
            SELECT action, reappear_at
            FROM meta_decision_responses
            WHERE business_id = ${input.businessId}
              AND provider_account_id = ${account}
              AND rec_id = ${input.recId}
            ORDER BY timestamp DESC
            LIMIT 1
          ) latest
          WHERE latest.action = 'deferred'
            AND (latest.reappear_at IS NULL OR latest.reappear_at > NOW())
        )
      ELSE
        -- acted / deferred / ignored: the rec must be in the CURRENT served
        -- snapshot for THIS physical account.
        EXISTS (
          SELECT 1
          FROM meta_decision_snapshots_daily snapshot
          WHERE snapshot.business_id = ${input.businessId}
            AND snapshot.provider_account_id = ${account}
            AND snapshot.rec_id = ${input.recId}
            AND COALESCE(snapshot.kind, 'recommendation') = 'recommendation'
            AND snapshot.snapshot_date = (
              SELECT MAX(snapshot_date)
              FROM meta_decision_snapshots_daily
              WHERE business_id = ${input.businessId}
                AND provider_account_id = ${account}
                AND COALESCE(kind, 'recommendation') = 'recommendation'
            )
        )
      END
    RETURNING
      rec_id,
      business_id,
      action,
      action_subtype,
      timestamp::text AS timestamp,
      reappear_at::text AS reappear_at
  `) as MetaDecisionResponseDbRow[];
  const row = rows[0];
  return row ? mapResponseRow(row) : null;
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
      provider_account_id,
      action,
      action_subtype,
      timestamp
    )
    SELECT
      snapshot.rec_id,
      snapshot.business_id,
      -- D-M012: carried from the row being stamped, so an automatic ignore is
      -- attributable to the same account that produced the recommendation.
      -- Legitimately NULL for rows written before D-M011 gave snapshots a
      -- lineage; those keep the pre-change business-wide meaning rather than
      -- being assigned an account this marker cannot prove.
      snapshot.provider_account_id,
      'ignored',
      'auto_7d_no_response',
      ${now.toISOString()}::timestamptz
    FROM meta_decision_snapshots_daily snapshot
    WHERE COALESCE(snapshot.kind, 'recommendation') = 'recommendation'
      AND snapshot.created_at < (${now.toISOString()}::timestamptz - interval '7 days')
      -- Demo workspaces are excluded here rather than at a route, because this
      -- writer HAS no route: it runs from the sync cron across every business
      -- in the database. A demo workspace has zero Meta write authority, and an
      -- automatic ignored stamp is a durable operator-decision row that
      -- lib/meta/outcome-accrual.ts later reads back.
      --
      -- IS NOT TRUE rather than = false, and EXISTS rather than a LEFT JOIN:
      -- a snapshot row whose business has since disappeared must not be
      -- stamped either. The column is NOT NULL DEFAULT FALSE today, so this is
      -- belt and braces on a value that cannot currently be null.
      AND EXISTS (
        SELECT 1
        FROM businesses business
        WHERE business.id = snapshot.business_id
          AND business.is_demo_business IS NOT TRUE
      )
      -- Already answered? Per ACCOUNT, because two accounts may legitimately
      -- carry the same rec id and a response to one is not a response to the
      -- other. IS NOT DISTINCT FROM so a legacy NULL-lineage response still
      -- suppresses the legacy NULL-lineage row it answered.
      AND NOT EXISTS (
        SELECT 1
        FROM meta_decision_responses response
        WHERE response.business_id = snapshot.business_id
          AND response.provider_account_id IS NOT DISTINCT FROM snapshot.provider_account_id
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
