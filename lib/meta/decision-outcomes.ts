import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";

const META_DECISION_OUTCOME_TABLES = [
  "meta_decision_action_outcome_logs",
] as const;

export type MetaDecisionActionOutcomeType =
  | "operator_response"
  | "preflight"
  | "execute"
  | "rollback"
  | "outcome";

export interface MetaDecisionActionOutcomeLogRow {
  businessId: string;
  providerAccountId?: string | null;
  recommendationFingerprint: string;
  recId?: string | null;
  recType?: string | null;
  decisionLabel?: string | null;
  decisionFamily?: string | null;
  actionType: MetaDecisionActionOutcomeType;
  outcomeStatus?: string | null;
  summary: string;
  payloadJson?: Record<string, unknown>;
  occurredAt?: string | null;
}

async function assertMetaDecisionOutcomeTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: [...META_DECISION_OUTCOME_TABLES],
    context,
  });
}

async function resolveMetaDecisionOutcomeReferenceContext(input: {
  businessId: string;
  providerAccountId?: string | null;
}) {
  const [businessRefIds, providerAccountRefIds] = await Promise.all([
    resolveBusinessReferenceIds([input.businessId]),
    input.providerAccountId
      ? ensureProviderAccountReferenceIds({
          provider: "meta",
          accounts: [{ externalAccountId: input.providerAccountId }],
        })
      : Promise.resolve(new Map<string, string>()),
  ]);
  return {
    businessRefId: businessRefIds.get(input.businessId) ?? null,
    providerAccountRefId: input.providerAccountId
      ? (providerAccountRefIds.get(input.providerAccountId) ?? null)
      : null,
  };
}

export async function appendMetaDecisionActionOutcomeLog(
  input: MetaDecisionActionOutcomeLogRow,
) {
  await assertMetaDecisionOutcomeTablesReady("meta_decision_outcome_storage");
  const sql = getDb();
  const refs = await resolveMetaDecisionOutcomeReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId ?? null,
  });

  const rows = (await sql`
    INSERT INTO meta_decision_action_outcome_logs (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      recommendation_fingerprint,
      rec_id,
      rec_type,
      decision_label,
      decision_family,
      action_type,
      outcome_status,
      summary,
      payload_json,
      occurred_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId ?? null},
      ${refs.providerAccountRefId},
      ${input.recommendationFingerprint},
      ${input.recId ?? null},
      ${input.recType ?? null},
      ${input.decisionLabel ?? null},
      ${input.decisionFamily ?? null},
      ${input.actionType},
      ${input.outcomeStatus ?? null},
      ${input.summary},
      ${JSON.stringify(input.payloadJson ?? {})}::jsonb,
      COALESCE(${input.occurredAt ?? null}, now()),
      now()
    )
    RETURNING id
  `) as Array<{ id: string }>;

  return rows[0]?.id ?? null;
}

export async function readMetaDecisionActionOutcomeLogs(input: {
  businessId: string;
  providerAccountId?: string | null;
  recommendationFingerprint?: string | null;
  recId?: string | null;
  limit?: number;
}) {
  await assertMetaDecisionOutcomeTablesReady("meta_decision_outcome_storage");
  const sql = getDb();
  return sql`
    SELECT *
    FROM meta_decision_action_outcome_logs
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND (${input.recommendationFingerprint ?? null}::text IS NULL OR recommendation_fingerprint = ${input.recommendationFingerprint ?? null})
      AND (${input.recId ?? null}::text IS NULL OR rec_id = ${input.recId ?? null})
    ORDER BY occurred_at DESC
    LIMIT ${Math.max(1, Math.min(input.limit ?? 100, 500))}
  `;
}

/**
 * Historical outcome evidence for one account, up to one deterministic cutoff.
 *
 * ── ROUND 9 ITEM 6 ─────────────────────────────────────────────────────────
 * `providerAccountId` was OPTIONAL and the filter was written as "null matches
 * everything", so a caller that forgot it pooled every account's outcome
 * history into one summary — and those summaries raise confidence on the
 * recommendations an operator acts on. There was no temporal filter at all, so
 * a request for a window ending in March was answered with outcomes recorded in
 * September: the served evidence for a historical range described the future.
 *
 * Both are now REQUIRED. `occurredAtCutoff` is compared against `occurred_at`,
 * which is the outcome's own EFFECTIVE time (the writer sets it explicitly and
 * falls back to `now()`); `created_at` — when the row was inserted — is
 * deliberately not used, because when we learned something is not when it
 * happened.
 */
export async function readMetaDecisionActionOutcomeLogsForRecommendationTypes(input: {
  businessId: string;
  providerAccountId: string;
  /**
   * The absolute instant the served provider-local day ENDS, exclusive.
   *
   * ROUND 10 ITEM 4. This was a `YYYY-MM-DD` compared as `< (date + 1)`, and
   * PostgreSQL casts that date to `timestamptz` with the SESSION timezone — so
   * the window boundary was the connection's zone, not the advertiser's. A
   * `timestamptz` bound compared to a `timestamptz` column has no session
   * dependency. @see lib/meta/provider-local-day.ts
   */
  occurredBefore: Date;
  recTypes: string[];
  limit?: number;
}) {
  const recTypes = Array.from(
    new Set(input.recTypes.map((value) => value.trim()).filter(Boolean)),
  );
  if (recTypes.length === 0) return [];
  /*
    FAIL CLOSED ON AN UNUSABLE SCOPE. An empty account or a malformed cutoff
    used to widen the query; here they answer "no history", which is the honest
    reading of a scope this call cannot establish.
  */
  const providerAccountId = input.providerAccountId?.trim() ?? "";
  if (!providerAccountId) return [];
  const occurredBefore = input.occurredBefore;
  if (!(occurredBefore instanceof Date) || !Number.isFinite(occurredBefore.getTime())) {
    return [];
  }

  await assertMetaDecisionOutcomeTablesReady("meta_decision_outcome_storage");
  const sql = getDb();
  return sql`
    SELECT
      outcome_log.recommendation_fingerprint,
      outcome_log.rec_id,
      outcome_log.rec_type,
      outcome_log.decision_label,
      outcome_log.decision_family,
      outcome_log.action_type,
      outcome_log.outcome_status,
      outcome_log.payload_json,
      EXISTS (
        SELECT 1
        FROM meta_ads_action_log action_log
        WHERE action_log.id::text = NULLIF(
            outcome_log.payload_json->'treatmentReceipt'->>'actionLogId',
            ''
          )
          AND action_log.business_id::text = outcome_log.business_id
          AND action_log.rec_id_origin = outcome_log.rec_id
          AND action_log.status = 'success'
          AND action_log.verified_at IS NOT NULL
          AND COALESCE(action_log.payload_request->>'dry_run', 'false') = 'false'
          AND action_log.requested_at <= outcome_log.occurred_at
      ) AS treatment_receipt_validated,
      -- Fail closed until a durable random-assignment registry and a finalized
      -- control-estimate registry can be joined here. Payload identifiers are
      -- descriptive evidence only and must never grant causal authority.
      FALSE AS causal_assignment_validated,
      FALSE AS causal_estimate_validated,
      outcome_log.occurred_at::text AS occurred_at
    FROM meta_decision_action_outcome_logs outcome_log
    WHERE outcome_log.business_id = ${input.businessId}
      AND outcome_log.provider_account_id = ${providerAccountId}
      -- The outcome own effective time, strictly before the absolute instant
      -- the served PROVIDER-LOCAL day ends. A timestamptz bound, so the
      -- boundary cannot move with the database session timezone. Never
      -- created_at: insertion time is when we learned it, not when it happened.
      AND outcome_log.occurred_at < ${occurredBefore.toISOString()}::timestamptz
      AND outcome_log.action_type = 'outcome'
      AND outcome_log.rec_type = ANY(${recTypes}::text[])
    ORDER BY outcome_log.occurred_at DESC
    LIMIT ${Math.max(1, Math.min(input.limit ?? recTypes.length * 100, 5000))}
  `;
}
