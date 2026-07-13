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

export async function readMetaDecisionActionOutcomeLogsForRecommendationTypes(input: {
  businessId: string;
  providerAccountId?: string | null;
  recTypes: string[];
  limit?: number;
}) {
  const recTypes = Array.from(
    new Set(input.recTypes.map((value) => value.trim()).filter(Boolean)),
  );
  if (recTypes.length === 0) return [];

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
      AND (${input.providerAccountId ?? null}::text IS NULL OR outcome_log.provider_account_id = ${input.providerAccountId ?? null})
      AND outcome_log.action_type = 'outcome'
      AND outcome_log.rec_type = ANY(${recTypes}::text[])
    ORDER BY outcome_log.occurred_at DESC
    LIMIT ${Math.max(1, Math.min(input.limit ?? recTypes.length * 100, 5000))}
  `;
}
