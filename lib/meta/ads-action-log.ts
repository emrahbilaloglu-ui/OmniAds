import { randomUUID } from "node:crypto";
import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import {
  assertExactMetaAdsActionReceiptForEpisode,
  buildAdRecommendationEpisode,
  buildExactMetaAdsActionReceiptHash,
  type ExactMetaAdsActionLineage,
} from "@/lib/creative-decision-engine/ad-operator-response-detection";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  validateDecisionOriginAdExecutionRequest,
  validateDecisionOriginProviderVerification,
  type DecisionOriginAdAction,
  type DecisionOriginAdExecutionRequest,
  type DecisionOriginIdempotencyReceipt,
  type DecisionOriginSourceDecisionEvidence,
} from "@/lib/creative-decision-engine/execution-safety";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

export type MetaAdsActionKind =
  | "pause"
  | "resume"
  | "duplicate"
  | "launch_campaign"
  | "launch_adset"
  | "launch_ad";
export type MetaAdsActionStatus =
  | "pending"
  | "success"
  | "failure"
  | "silent_failure";

export interface MetaAdsActionLogRow {
  id: string;
  businessId: string;
  adId: string;
  creativeId: string | null;
  action: MetaAdsActionKind;
  source: string;
  requestedBy: string | null;
  requestedAt: string;
  payloadRequest: Record<string, unknown> | null;
  payloadResponse: Record<string, unknown> | null;
  status: MetaAdsActionStatus;
  errorCode: string | null;
  errorMessage: string | null;
  resultingAdId: string | null;
  durationMs: number | null;
  verifiedAt: string | null;
  verificationPayload: Record<string, unknown> | null;
  recIdOrigin: string | null;
  launchIntentId: string | null;
  providerAccountRefId: string | null;
  providerAccountId: string | null;
  decisionEpisodeKey: string | null;
  decisionSnapshotId: string | null;
  decisionEvaluationId: string | null;
  decisionEngineVersion: string | null;
  decisionHash: string | null;
  idempotencyKey: string | null;
  decisionOrigin: DecisionOriginAdExecutionRequest | null;
  dryRun: boolean;
  providerVerified: boolean;
  verificationEntityId: string | null;
  verificationStatus: string | null;
  terminalFinalizedAt: string | null;
  treatmentEligible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetaAdActionTarget {
  businessId: string;
  adId: string;
  creativeId: string | null;
  providerAccountId: string | null;
}

interface MetaAdsActionLogDbRow {
  id: string;
  business_id: string;
  ad_id: string;
  creative_id: string | null;
  action: MetaAdsActionKind;
  source: string;
  requested_by: string | null;
  requested_at: string;
  payload_request: Record<string, unknown> | null;
  payload_response: Record<string, unknown> | null;
  status: MetaAdsActionStatus;
  error_code: string | null;
  error_message: string | null;
  resulting_ad_id: string | null;
  duration_ms: number | null;
  verified_at: string | null;
  verification_payload: Record<string, unknown> | null;
  rec_id_origin: string | null;
  launch_intent_id: string | null;
  decision_contract_version: string | null;
  provider_account_ref_id: string | null;
  provider_account_id: string | null;
  decision_episode_key: string | null;
  decision_snapshot_id: string | null;
  decision_evaluation_id: string | null;
  decision_engine_version: string | null;
  decision_hash: string | null;
  idempotency_key: string | null;
  dry_run: boolean | null;
  provider_verified: boolean | null;
  verification_entity_id: string | null;
  verification_status: string | null;
  terminal_finalized_at: string | null;
  created_at: string;
  updated_at: string;
}

function decisionOriginFromRow(
  row: MetaAdsActionLogDbRow,
): DecisionOriginAdExecutionRequest | null {
  if (
    row.source !== "decision_origin" ||
    row.decision_contract_version !==
      DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
  ) {
    return null;
  }
  const request: DecisionOriginAdExecutionRequest = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id ?? "",
    adId: row.ad_id,
    snapshotId: row.decision_snapshot_id ?? "",
    evaluationId: row.decision_evaluation_id ?? "",
    engineVersion: row.decision_engine_version ?? "",
    decisionHash: row.decision_hash ?? "",
    action: row.action,
    idempotencyKey: row.idempotency_key ?? "",
    creativeId: row.creative_id,
    ...(row.dry_run === true ? { dryRun: true } : {}),
  };
  return validateDecisionOriginAdExecutionRequest(request).length === 0
    ? request
    : null;
}

function mapActionLogRow(row: MetaAdsActionLogDbRow): MetaAdsActionLogRow {
  const decisionOrigin = decisionOriginFromRow(row);
  const verification = decisionOrigin
    ? validateDecisionOriginProviderVerification({
        request: decisionOrigin,
        verifiedAt: row.verified_at,
        verificationPayload: row.verification_payload,
      })
    : null;
  return {
    id: row.id,
    businessId: row.business_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    action: row.action,
    source: row.source,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    payloadRequest: row.payload_request,
    payloadResponse: row.payload_response,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultingAdId: row.resulting_ad_id,
    durationMs: row.duration_ms,
    verifiedAt: row.verified_at,
    verificationPayload: row.verification_payload,
    recIdOrigin: row.rec_id_origin,
    launchIntentId: row.launch_intent_id ?? null,
    providerAccountRefId: row.provider_account_ref_id ?? null,
    providerAccountId: row.provider_account_id ?? null,
    decisionEpisodeKey: row.decision_episode_key ?? null,
    decisionSnapshotId: row.decision_snapshot_id ?? null,
    decisionEvaluationId: row.decision_evaluation_id ?? null,
    decisionEngineVersion: row.decision_engine_version ?? null,
    decisionHash: row.decision_hash ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    decisionOrigin,
    dryRun: row.dry_run === true,
    providerVerified: row.provider_verified === true,
    verificationEntityId: row.verification_entity_id ?? null,
    verificationStatus: row.verification_status ?? null,
    terminalFinalizedAt: row.terminal_finalized_at ?? null,
    treatmentEligible:
      row.status === "success" &&
      row.provider_verified === true &&
      row.dry_run !== true &&
      verification?.treatmentEligible === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function resolveExactMetaAdActionTarget(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}): Promise<
  | { ok: true; target: MetaAdActionTarget }
  | { ok: false; reason: "business_not_found" | "ad_not_found" }
> {
  const sql = getDb();
  const businessRows = (await sql`
    SELECT id
    FROM businesses
    WHERE id = ${input.businessId}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (!businessRows[0]) return { ok: false, reason: "business_not_found" };

  const adRows = (await sql`
    SELECT provider_account_id, ad_id, creative_id
    FROM (
      SELECT provider_account_id, ad_id, creative_id, 1 AS source_priority, updated_at
      FROM meta_ad_dimensions
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND ad_id = ${input.adId}
      UNION ALL
      SELECT provider_account_id, ad_id, NULL::text AS creative_id, 2 AS source_priority, updated_at
      FROM meta_ad_daily
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND ad_id = ${input.adId}
      UNION ALL
      SELECT provider_account_id, ad_id, creative_id, 3 AS source_priority, updated_at
      FROM meta_creative_daily
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND ad_id = ${input.adId}
    ) exact_ad
    ORDER BY source_priority, updated_at DESC
    LIMIT 1
  `) as Array<{
    provider_account_id: string | null;
    ad_id: string | null;
    creative_id: string | null;
  }>;
  const adRow = adRows[0];
  if (
    !adRow?.provider_account_id ||
    adRow.provider_account_id !== input.providerAccountId ||
    !adRow.ad_id ||
    adRow.ad_id !== input.adId
  ) {
    return { ok: false, reason: "ad_not_found" };
  }
  return {
    ok: true,
    target: {
      businessId: input.businessId,
      providerAccountId: adRow.provider_account_id,
      adId: adRow.ad_id,
      creativeId: adRow.creative_id ?? null,
    },
  };
}

/** Legacy operator resolver. It may use creative/synthetic fallbacks. */
export async function resolveManualMetaAdActionTarget(input: {
  businessId: string;
  adId: string;
}): Promise<
  | { ok: true; target: MetaAdActionTarget }
  | { ok: false; reason: "business_not_found" | "ad_not_found" }
> {
  const sql = getDb();
  const businessRows = (await sql`
    SELECT id
    FROM businesses
    WHERE id = ${input.businessId}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (!businessRows[0]) return { ok: false, reason: "business_not_found" };

  // The client may send either a real Meta ad_id or a value that the warehouse uses as
  // a synthesized identifier (e.g. meta_creative_daily.ad_id "creative_..." when the
  // upstream sync only had creative-level facts). Resolve via several paths:
  //   1) direct ad_id match in dimensions / daily (real Meta ad_id)
  //   2) treat the input as a creative_id and resolve real ad_id from dimensions
  //   3) fall back to meta_creative_daily lookup, then creative_id → dimensions
  //   4) use recent successful launch/duplicate action logs before warehouse sync catches up
  const adRows = (await sql`
    SELECT
      COALESCE(
        dim_direct.provider_account_id,
        daily_direct.provider_account_id,
        creative_daily_direct.provider_account_id,
        dim_by_creative.provider_account_id,
        creative_daily_by_creative.provider_account_id,
        dim_by_warehouse_creative.provider_account_id,
        action_result.provider_account_id
      ) AS provider_account_id,
      COALESCE(
        dim_direct.ad_id,
        daily_direct.ad_id,
        creative_daily_direct.ad_id,
        dim_by_creative.ad_id,
        creative_daily_by_creative.ad_id,
        dim_by_warehouse_creative.ad_id,
        action_result.resolved_ad_id
      ) AS resolved_ad_id,
      COALESCE(
        dim_direct.creative_id,
        daily_direct.creative_id,
        creative_daily_direct.creative_id,
        dim_by_creative.creative_id,
        creative_daily_by_creative.creative_id,
        dim_by_warehouse_creative.creative_id,
        warehouse_creative.creative_id,
        action_result.creative_id
      ) AS creative_id
    FROM (
      SELECT
        ${input.businessId}::text AS business_id_text,
        ${input.businessId}::uuid AS business_id_uuid,
        ${input.adId}::text AS input_id
    ) target
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id_text AND ad_id = target.input_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, NULL::text AS creative_id
      FROM meta_ad_daily
      WHERE business_id = target.business_id_text AND ad_id = target.input_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) daily_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_creative_daily
      WHERE business_id = target.business_id_text
        AND ad_id = target.input_id
        AND ad_id ~ '^[0-9]+$'
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) creative_daily_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id_text AND creative_id = target.input_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_by_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_creative_daily
      WHERE business_id = target.business_id_text
        AND creative_id = target.input_id
        AND ad_id ~ '^[0-9]+$'
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) creative_daily_by_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT creative_id
      FROM meta_creative_daily
      WHERE business_id = target.business_id_text AND ad_id = target.input_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) warehouse_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id_text
        AND creative_id = warehouse_creative.creative_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_by_warehouse_creative ON TRUE
    LEFT JOIN LATERAL (
      -- Newly written ads can be actionable before the next warehouse sync materializes dimensions.
      SELECT
        COALESCE(
          CASE
            WHEN substring(COALESCE(log.payload_request->>'endpoint', '') FROM '^/act_([^/]+)/ads$') IS NOT NULL
            THEN 'act_' || substring(COALESCE(log.payload_request->>'endpoint', '') FROM '^/act_([^/]+)/ads$')
            ELSE NULL
          END,
          action_adset.provider_account_id
        ) AS provider_account_id,
        log.resulting_ad_id AS resolved_ad_id,
        COALESCE(
          log.creative_id,
          NULLIF(log.payload_request->'body'->>'source_creative_id', '')
        ) AS creative_id
      FROM meta_ads_action_log log
      LEFT JOIN LATERAL (
        SELECT provider_account_id
        FROM meta_adset_dimensions
        WHERE business_id = target.business_id_text
          AND adset_id = COALESCE(
            NULLIF(log.payload_request->>'target_adset_id', ''),
            NULLIF(log.payload_request->'body'->>'target_adset_id', ''),
            NULLIF(log.payload_request->'body'->>'adset_id', '')
          )
        ORDER BY updated_at DESC
        LIMIT 1
      ) action_adset ON TRUE
      WHERE log.business_id = target.business_id_uuid
        AND log.resulting_ad_id = target.input_id
        AND log.action IN ('launch_ad', 'duplicate')
        AND log.status IN ('success', 'silent_failure')
      ORDER BY log.verified_at DESC NULLS LAST, log.requested_at DESC
      LIMIT 1
    ) action_result ON TRUE
    WHERE COALESCE(
      dim_direct.provider_account_id,
      daily_direct.provider_account_id,
      creative_daily_direct.provider_account_id,
      dim_by_creative.provider_account_id,
      creative_daily_by_creative.provider_account_id,
      dim_by_warehouse_creative.provider_account_id,
      action_result.provider_account_id
    ) IS NOT NULL
    LIMIT 1
  `) as Array<{
    provider_account_id: string | null;
    resolved_ad_id: string | null;
    creative_id: string | null;
  }>;
  const adRow = adRows[0];
  if (!adRow?.provider_account_id || !adRow?.resolved_ad_id) {
    return { ok: false, reason: "ad_not_found" };
  }

  return {
    ok: true,
    target: {
      businessId: input.businessId,
      adId: adRow.resolved_ad_id,
      creativeId: adRow.creative_id ?? null,
      providerAccountId: adRow.provider_account_id,
    },
  };
}

/** @deprecated Use resolveManualMetaAdActionTarget only from explicit legacy flows. */
export const resolveMetaAdActionTarget = resolveManualMetaAdActionTarget;

export async function readDecisionOriginSourceDecision(input: {
  snapshotId: string;
  evaluationId: string;
}): Promise<DecisionOriginSourceDecisionEvidence> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      snapshot.business_ref_id::text AS business_id,
      snapshot.provider_account_id,
      snapshot.decision_entity_type,
      snapshot.decision_entity_id,
      snapshot.ad_id,
      snapshot.creative_id,
      snapshot.id::text AS snapshot_id,
      evaluation.id::text AS evaluation_id,
      snapshot.engine_version,
      snapshot.decision_hash::text AS decision_hash,
      snapshot.label AS decision_label,
      snapshot.blocked_action_type,
      COALESCE(
        NULLIF(evaluation.decision_output_json->>'authorizedAdAction', ''),
        NULLIF(evaluation.decision_output_json->>'authorized_ad_action', '')
      ) AS explicit_authorized_action,
      snapshot.computed_at::text AS computed_at
    FROM engine_v3_ad_decision_snapshots_daily snapshot
    INNER JOIN engine_v3_ad_decision_evaluations evaluation
      ON evaluation.id = snapshot.evaluation_id
     AND evaluation.business_ref_id = snapshot.business_ref_id
     AND evaluation.provider_account_id = snapshot.provider_account_id
     AND evaluation.decision_entity_type = snapshot.decision_entity_type
     AND evaluation.decision_entity_id = snapshot.decision_entity_id
     AND evaluation.ad_id = snapshot.ad_id
     AND evaluation.engine_version = snapshot.engine_version
     AND evaluation.scope_type = snapshot.scope_type
     AND evaluation.scope_id = snapshot.scope_id
     AND evaluation.input_hash = snapshot.input_hash
     AND evaluation.decision_hash = snapshot.decision_hash
    WHERE snapshot.id = ${input.snapshotId}
      AND evaluation.id = ${input.evaluationId}
    LIMIT 1
  `) as Array<{
    business_id: string | null;
    provider_account_id: string | null;
    decision_entity_type: string | null;
    decision_entity_id: string | null;
    ad_id: string | null;
    creative_id: string | null;
    snapshot_id: string | null;
    evaluation_id: string | null;
    engine_version: string | null;
    decision_hash: string | null;
    decision_label: string | null;
    blocked_action_type: string | null;
    explicit_authorized_action: string | null;
    computed_at: string | null;
  }>;
  const row = rows[0];
  if (!row) {
    return {
      found: false,
      businessId: null,
      providerAccountId: null,
      decisionEntityType: null,
      decisionEntityId: null,
      adId: null,
      creativeId: null,
      snapshotId: null,
      evaluationId: null,
      engineVersion: null,
      decisionHash: null,
      decisionLabel: null,
      blockedActionType: null,
      explicitAuthorizedAction: null,
      computedAt: null,
    };
  }
  const explicitAuthorizedAction =
    row.explicit_authorized_action === "pause" ||
    row.explicit_authorized_action === "resume"
      ? row.explicit_authorized_action
      : null;
  return {
    found: true,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    decisionEntityType: row.decision_entity_type,
    decisionEntityId: row.decision_entity_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    snapshotId: row.snapshot_id,
    evaluationId: row.evaluation_id,
    engineVersion: row.engine_version,
    decisionHash: row.decision_hash,
    decisionLabel: row.decision_label,
    blockedActionType: row.blocked_action_type,
    explicitAuthorizedAction,
    computedAt: row.computed_at,
  };
}

export function decisionOriginIdempotencyReceiptFromLog(
  row: MetaAdsActionLogRow,
  fallbackIdempotencyKey = "",
): DecisionOriginIdempotencyReceipt {
  const origin = row.decisionOrigin;
  return {
    actionLogId: row.id,
    businessId: row.businessId,
    providerAccountId: origin?.providerAccountId ?? row.providerAccountId,
    adId: row.adId,
    snapshotId: origin?.snapshotId ?? null,
    evaluationId: origin?.evaluationId ?? null,
    engineVersion: origin?.engineVersion ?? null,
    decisionHash: origin?.decisionHash ?? null,
    action: row.action,
    idempotencyKey:
      origin?.idempotencyKey ?? row.idempotencyKey ?? fallbackIdempotencyKey,
    status: row.status,
    dryRun: row.dryRun,
    providerVerified: row.providerVerified,
    treatmentEligible: row.treatmentEligible,
  };
}

export async function findDecisionOriginActionByIdempotency(input: {
  businessId: string;
  idempotencyKey: string;
}): Promise<DecisionOriginIdempotencyReceipt | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND source = 'decision_origin'
      AND idempotency_key = ${input.idempotencyKey}
    ORDER BY requested_at DESC
    LIMIT 1
  `) as MetaAdsActionLogDbRow[];
  return rows[0]
    ? decisionOriginIdempotencyReceiptFromLog(
        mapActionLogRow(rows[0]),
        input.idempotencyKey,
      )
    : null;
}

export async function hasRecentPendingMetaAdsAction(input: {
  businessId: string;
  adId: string;
  sinceSeconds?: number;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND ad_id = ${input.adId}
      AND status = 'pending'
      AND requested_at > NOW() - (${input.sinceSeconds ?? 30}::int * interval '1 second')
    LIMIT 1
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function hasRecentPendingMetaLaunchAction(input: {
  businessId: string;
  idempotencyKey: string;
  sinceSeconds?: number;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND action IN ('launch_campaign', 'launch_adset', 'launch_ad')
      AND status = 'pending'
      AND COALESCE(payload_request->>'idempotency_key', payload_request->>'idempotencyKey') = ${input.idempotencyKey}
      AND requested_at > NOW() - (${input.sinceSeconds ?? 30}::int * interval '1 second')
    LIMIT 1
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function hasRecentPendingMetaAddToExistingAction(input: {
  businessId: string;
  idempotencyKey: string;
  targetAdsetId: string;
  sinceSeconds?: number;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND action = 'launch_ad'
      AND status = 'pending'
      AND COALESCE(payload_request->>'idempotency_key', payload_request->>'idempotencyKey') = ${input.idempotencyKey}
      AND COALESCE(
        payload_request->>'target_adset_id',
        payload_request->'body'->>'target_adset_id',
        payload_request->'body'->>'adset_id'
      ) = ${input.targetAdsetId}
      AND requested_at > NOW() - (${input.sinceSeconds ?? 30}::int * interval '1 second')
    LIMIT 1
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function findRecentDuplicateActionResult(input: {
  businessId: string;
  adId: string;
  targetAdsetId: string;
  sinceMinutes?: number;
}): Promise<MetaAdsActionLogRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND ad_id = ${input.adId}
      AND action = 'duplicate'
      AND status IN ('success', 'silent_failure')
      AND resulting_ad_id IS NOT NULL
      AND COALESCE(
        payload_request->'body'->>'target_adset_id',
        payload_request->>'target_adset_id'
      ) = ${input.targetAdsetId}
      AND requested_at > NOW() - (${input.sinceMinutes ?? 10}::int * interval '1 minute')
    ORDER BY requested_at DESC
    LIMIT 1
  `) as MetaAdsActionLogDbRow[];
  return rows[0] ? mapActionLogRow(rows[0]) : null;
}

export async function createMetaAdsActionLog(input: {
  businessId: string;
  adId: string;
  creativeId?: string | null;
  action: MetaAdsActionKind;
  source?: string;
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
  recIdOrigin?: string | null;
  launchIntentId?: string | null;
}): Promise<MetaAdsActionLogRow> {
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_ads_action_log (
      business_id,
      ad_id,
      creative_id,
      action,
      source,
      requested_by,
      payload_request,
      rec_id_origin,
      launch_intent_id,
      status
    ) VALUES (
      ${input.businessId},
      ${input.adId},
      ${input.creativeId ?? null},
      ${input.action},
      ${input.source ?? "ui_manual"},
      ${input.requestedBy ?? null},
      ${JSON.stringify(input.payloadRequest ?? null)}::jsonb,
      ${input.recIdOrigin ?? null},
      ${input.launchIntentId ?? null},
      'pending'
    )
    RETURNING *
  `) as MetaAdsActionLogDbRow[];
  const row = rows[0];
  if (!row) throw new Error("Failed to create Meta ads action log row.");
  return mapActionLogRow(row);
}

export const CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY = `
WITH source_lineage AS (
  SELECT
    episode.episode_key,
    episode.business_ref_id,
    episode.provider_account_ref_id,
    episode.provider_account_id,
    episode.ad_id,
    episode.creative_id,
    episode.decision_snapshot_id,
    episode.evaluation_id,
    episode.engine_version,
    episode.decision_hash
  FROM engine_v3_ad_recommendation_episodes episode
  INNER JOIN engine_v3_ad_decision_snapshots_daily snapshot
    ON snapshot.id = episode.decision_snapshot_id
   AND snapshot.business_ref_id = episode.business_ref_id
   AND snapshot.business_id = episode.business_id
   AND snapshot.provider_account_id = episode.provider_account_id
   AND snapshot.decision_entity_type = 'ad'
   AND snapshot.decision_entity_id = episode.ad_id
   AND snapshot.ad_id = episode.ad_id
   AND snapshot.as_of_date = episode.as_of_date
   AND snapshot.engine_version = episode.engine_version
   AND snapshot.scope_type = episode.scope_type
   AND snapshot.scope_id = episode.scope_id
   AND snapshot.evaluation_id = episode.evaluation_id
   AND snapshot.input_hash = episode.input_hash
   AND snapshot.decision_hash = episode.decision_hash
  INNER JOIN engine_v3_ad_decision_evaluations evaluation
    ON evaluation.id = episode.evaluation_id
   AND evaluation.business_ref_id = episode.business_ref_id
   AND evaluation.provider_account_id = episode.provider_account_id
   AND evaluation.decision_entity_type = 'ad'
   AND evaluation.decision_entity_id = episode.ad_id
   AND evaluation.ad_id = episode.ad_id
   AND evaluation.as_of_date = episode.as_of_date
   AND evaluation.engine_version = episode.engine_version
   AND evaluation.scope_type = episode.scope_type
   AND evaluation.scope_id = episode.scope_id
   AND evaluation.input_hash = episode.input_hash
   AND evaluation.decision_hash = episode.decision_hash
  WHERE episode.business_ref_id = $1::uuid
    AND episode.business_id = $1::uuid::text
    AND episode.provider_account_id = $2
    AND episode.ad_id = $3
    AND episode.decision_snapshot_id = $4::uuid
    AND episode.evaluation_id = $5::uuid
    AND episode.engine_version = $6
    AND episode.engine_version = '${NATIVE_AD_ENGINE_VERSION}'
    AND episode.decision_hash = $7
    AND snapshot.blocked_action_type IS NULL
    AND COALESCE(
      NULLIF(evaluation.decision_output_json->>'authorizedAdAction', ''),
      NULLIF(evaluation.decision_output_json->>'authorized_ad_action', '')
    ) = $8
)
INSERT INTO meta_ads_action_log (
  business_id, ad_id, creative_id, action, source, requested_by,
  payload_request, status, decision_contract_version,
  provider_account_ref_id, provider_account_id, decision_episode_key,
  decision_snapshot_id, decision_evaluation_id, decision_engine_version,
  decision_hash, idempotency_key, dry_run, provider_verified
)
SELECT
  source_lineage.business_ref_id, source_lineage.ad_id,
  source_lineage.creative_id, $8, 'decision_origin', $9::uuid,
  $10::jsonb, 'pending', '${DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION}',
  source_lineage.provider_account_ref_id,
  source_lineage.provider_account_id, source_lineage.episode_key,
  source_lineage.decision_snapshot_id, source_lineage.evaluation_id,
  source_lineage.engine_version, source_lineage.decision_hash,
  $11, $12::boolean, false
FROM source_lineage
RETURNING *
`;

export async function createDecisionOriginMetaAdsActionLog(input: {
  request: DecisionOriginAdExecutionRequest;
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
}): Promise<MetaAdsActionLogRow> {
  const blockers = validateDecisionOriginAdExecutionRequest(input.request);
  if (blockers.length > 0) {
    throw new TypeError(
      `Invalid decision-origin action log contract: ${blockers.join(", ")}`,
    );
  }
  if (input.request.action !== "pause" && input.request.action !== "resume") {
    throw new TypeError("Decision-origin ad logs support pause or resume only.");
  }
  const payloadRequest = {
    ...(input.payloadRequest ?? {}),
    contract_version: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    execution_origin: "decision_origin",
    provider_account_id: input.request.providerAccountId,
    source_snapshot_id: input.request.snapshotId,
    source_evaluation_id: input.request.evaluationId,
    engine_version: input.request.engineVersion,
    decision_hash: input.request.decisionHash,
    idempotency_key: input.request.idempotencyKey,
    dry_run: input.request.dryRun === true,
  };
  const sql = getDb();
  const rows = await sql.query<MetaAdsActionLogDbRow>(
    CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY,
    [
      input.request.businessId,
      input.request.providerAccountId,
      input.request.adId,
      input.request.snapshotId,
      input.request.evaluationId,
      input.request.engineVersion,
      input.request.decisionHash,
      input.request.action,
      input.requestedBy ?? null,
      JSON.stringify(payloadRequest),
      input.request.idempotencyKey,
      input.request.dryRun === true,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      "Decision-origin log creation found no exact authorized native ad episode.",
    );
  }
  return mapActionLogRow(row);
}

export async function completeMetaAdsActionLog(input: {
  id: string;
  status: MetaAdsActionStatus;
  payloadResponse?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  resultingAdId?: string | null;
  durationMs?: number | null;
  verifiedAt?: string | null;
  verificationPayload?: Record<string, unknown> | null;
}): Promise<MetaAdsActionLogRow> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE meta_ads_action_log
    SET
      status = ${input.status},
      payload_response = ${JSON.stringify(input.payloadResponse ?? null)}::jsonb,
      error_code = ${input.errorCode ?? null},
      error_message = ${input.errorMessage ?? null},
      resulting_ad_id = ${input.resultingAdId ?? null},
      duration_ms = ${input.durationMs ?? null},
      verified_at = ${input.verifiedAt ?? null},
      verification_payload = ${JSON.stringify(input.verificationPayload ?? null)}::jsonb,
      updated_at = NOW()
    WHERE id = ${input.id}
      AND source <> 'decision_origin'
    RETURNING *
  `) as MetaAdsActionLogDbRow[];
  const row = rows[0];
  if (!row) {
    throw new Error(
      "Failed to update Meta ads action log row; decision-origin rows require atomic receipt finalization.",
    );
  }
  return mapActionLogRow(row);
}

interface LockedDecisionOriginActionRow extends MetaAdsActionLogDbRow {
  db_now: string;
  episode_business_id: string;
  episode_creative_id: string | null;
  episode_as_of_date: string;
  episode_scope_type: string;
  episode_scope_id: string;
  episode_input_hash: string;
  episode_decision_label: string;
  episode_source_campaign_id: string | null;
  episode_source_adset_id: string | null;
  episode_recommended_at: string;
  existing_receipt_id: string | null;
  existing_receipt_hash: string | null;
  existing_receipt_captured_at: string | null;
}

interface StoredNativeReceiptRow {
  receipt_id: string;
  action_log_id: string;
  receipt_hash: string;
}

export const LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY = `
SELECT
  action_log.*,
  clock_timestamp()::text AS db_now,
  episode.business_id AS episode_business_id,
  episode.creative_id AS episode_creative_id,
  episode.as_of_date::text AS episode_as_of_date,
  episode.scope_type AS episode_scope_type,
  episode.scope_id AS episode_scope_id,
  episode.input_hash AS episode_input_hash,
  episode.decision_label AS episode_decision_label,
  episode.source_campaign_id AS episode_source_campaign_id,
  episode.source_adset_id AS episode_source_adset_id,
  episode.recommended_at::text AS episode_recommended_at,
  receipt.id::text AS existing_receipt_id,
  receipt.receipt_hash AS existing_receipt_hash,
  receipt.captured_at::text AS existing_receipt_captured_at
FROM meta_ads_action_log action_log
INNER JOIN engine_v3_ad_recommendation_episodes episode
  ON episode.episode_key = action_log.decision_episode_key
 AND episode.business_ref_id = action_log.business_id
 AND episode.business_id = action_log.business_id::text
 AND episode.provider_account_ref_id = action_log.provider_account_ref_id
 AND episode.provider_account_id = action_log.provider_account_id
 AND episode.ad_id = action_log.ad_id
 AND episode.decision_snapshot_id = action_log.decision_snapshot_id
 AND episode.evaluation_id = action_log.decision_evaluation_id
 AND episode.engine_version = action_log.decision_engine_version
 AND episode.decision_hash = action_log.decision_hash
INNER JOIN engine_v3_ad_decision_snapshots_daily snapshot
  ON snapshot.id = episode.decision_snapshot_id
 AND snapshot.business_ref_id = episode.business_ref_id
 AND snapshot.business_id = episode.business_id
 AND snapshot.provider_account_id = episode.provider_account_id
 AND snapshot.decision_entity_type = 'ad'
 AND snapshot.decision_entity_id = episode.ad_id
 AND snapshot.ad_id = episode.ad_id
 AND snapshot.as_of_date = episode.as_of_date
 AND snapshot.engine_version = episode.engine_version
 AND snapshot.scope_type = episode.scope_type
 AND snapshot.scope_id = episode.scope_id
 AND snapshot.evaluation_id = episode.evaluation_id
 AND snapshot.input_hash = episode.input_hash
 AND snapshot.decision_hash = episode.decision_hash
INNER JOIN engine_v3_ad_decision_evaluations evaluation
  ON evaluation.id = episode.evaluation_id
 AND evaluation.business_ref_id = episode.business_ref_id
 AND evaluation.provider_account_id = episode.provider_account_id
 AND evaluation.decision_entity_type = 'ad'
 AND evaluation.decision_entity_id = episode.ad_id
 AND evaluation.ad_id = episode.ad_id
 AND evaluation.as_of_date = episode.as_of_date
 AND evaluation.engine_version = episode.engine_version
 AND evaluation.scope_type = episode.scope_type
 AND evaluation.scope_id = episode.scope_id
 AND evaluation.input_hash = episode.input_hash
 AND evaluation.decision_hash = episode.decision_hash
LEFT JOIN engine_v3_ad_operator_action_receipts receipt
  ON receipt.source_action_log_id = action_log.id
 AND receipt.episode_key = action_log.decision_episode_key
 AND receipt.business_ref_id = action_log.business_id
 AND receipt.provider_account_ref_id = action_log.provider_account_ref_id
 AND receipt.provider_account_id = action_log.provider_account_id
 AND receipt.source_ad_id = action_log.ad_id
 AND receipt.operator_action = action_log.action
 AND receipt.source_snapshot_id = action_log.decision_snapshot_id
 AND receipt.source_evaluation_id = action_log.decision_evaluation_id
 AND receipt.source_engine_version = action_log.decision_engine_version
 AND receipt.source_decision_hash = action_log.decision_hash
 AND receipt.idempotency_key = action_log.idempotency_key
 AND receipt.dry_run = action_log.dry_run
WHERE action_log.id = $1::uuid
  AND action_log.source = 'decision_origin'
  AND action_log.decision_contract_version =
    '${DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION}'
  AND action_log.decision_engine_version = '${NATIVE_AD_ENGINE_VERSION}'
FOR UPDATE OF action_log
`;

export const UPDATE_DECISION_ORIGIN_ACTION_TERMINAL_QUERY = `
UPDATE meta_ads_action_log
SET
  status = $2,
  payload_response = $3::jsonb,
  error_code = $4,
  error_message = $5,
  resulting_ad_id = NULL,
  duration_ms = $6::integer,
  verified_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE NULL END,
  verification_payload = $9::jsonb,
  provider_verified = $7::boolean,
  verification_entity_id = $10,
  verification_status = $11,
  terminal_finalized_at = $8::timestamptz,
  updated_at = $8::timestamptz
WHERE id = $1::uuid
  AND source = 'decision_origin'
  AND status = 'pending'
RETURNING *
`;

export const INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_record($1::jsonb) AS row(
    id uuid,
    receipt_hash text,
    source_action_log_id uuid,
    contract_version text,
    episode_key text,
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    source_ad_id text,
    source_snapshot_id uuid,
    source_evaluation_id uuid,
    source_engine_version text,
    source_decision_hash text,
    target_entity_type text,
    target_entity_id text,
    operator_action text,
    successor_kind text,
    resulting_ad_id text,
    idempotency_key text,
    action_status text,
    dry_run boolean,
    provider_verified boolean,
    requested_at timestamptz,
    verified_at timestamptz,
    finalized_at timestamptz,
    captured_at timestamptz,
    verification_entity_id text,
    verification_status text
  )
), inserted AS (
  INSERT INTO engine_v3_ad_operator_action_receipts (
    id, receipt_hash, source_action_log_id, contract_version, episode_key,
    business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, source_ad_id, source_snapshot_id,
    source_evaluation_id, source_engine_version, source_decision_hash,
    target_entity_type, target_entity_id, operator_action, successor_kind,
    resulting_ad_id, idempotency_key, action_status, dry_run,
    provider_verified, requested_at, verified_at, finalized_at, captured_at,
    verification_entity_id, verification_status
  )
  SELECT
    id, receipt_hash, source_action_log_id, contract_version, episode_key,
    business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, source_ad_id, source_snapshot_id,
    source_evaluation_id, source_engine_version, source_decision_hash,
    target_entity_type, target_entity_id, operator_action, successor_kind,
    resulting_ad_id, idempotency_key, action_status, dry_run,
    provider_verified, requested_at, verified_at, finalized_at, captured_at,
    verification_entity_id, verification_status
  FROM payload
  ON CONFLICT (source_action_log_id) DO NOTHING
  RETURNING id::text AS receipt_id,
    source_action_log_id::text AS action_log_id, receipt_hash
)
SELECT receipt_id, action_log_id, receipt_hash
FROM inserted
UNION ALL
SELECT existing.id::text, existing.source_action_log_id::text,
  existing.receipt_hash
FROM engine_v3_ad_operator_action_receipts existing
INNER JOIN payload
  ON payload.source_action_log_id = existing.source_action_log_id
WHERE NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1
`;

function requiredText(value: unknown, field: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} must be a non-empty string.`);
  return normalized;
}

function lockedDecisionOriginRequest(
  row: LockedDecisionOriginActionRow,
): DecisionOriginAdExecutionRequest {
  const request: DecisionOriginAdExecutionRequest = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: requiredText(row.business_id, "business_id"),
    providerAccountId: requiredText(
      row.provider_account_id,
      "provider_account_id",
    ),
    adId: requiredText(row.ad_id, "ad_id"),
    snapshotId: requiredText(row.decision_snapshot_id, "decision_snapshot_id"),
    evaluationId: requiredText(
      row.decision_evaluation_id,
      "decision_evaluation_id",
    ),
    engineVersion: requiredText(
      row.decision_engine_version,
      "decision_engine_version",
    ),
    decisionHash: requiredText(row.decision_hash, "decision_hash"),
    action: requiredText(row.action, "action"),
    idempotencyKey: requiredText(row.idempotency_key, "idempotency_key"),
    creativeId: row.creative_id,
    ...(row.dry_run === true ? { dryRun: true } : {}),
  };
  const blockers = validateDecisionOriginAdExecutionRequest(request);
  if (blockers.length > 0 || request.engineVersion !== NATIVE_AD_ENGINE_VERSION) {
    throw new Error(
      `Locked decision-origin lineage is invalid (${blockers.join(", ") || "native_engine_version_mismatch"}).`,
    );
  }
  return request;
}

function episodeFromLockedAction(row: LockedDecisionOriginActionRow) {
  return buildAdRecommendationEpisode({
    businessId: requiredText(row.business_id, "business_id"),
    businessDisplayId: requiredText(
      row.episode_business_id,
      "episode_business_id",
    ),
    providerAccountRefId: requiredText(
      row.provider_account_ref_id,
      "provider_account_ref_id",
    ),
    providerAccountId: requiredText(
      row.provider_account_id,
      "provider_account_id",
    ),
    adId: requiredText(row.ad_id, "ad_id"),
    creativeId: row.episode_creative_id,
    asOfDate: requiredText(row.episode_as_of_date, "episode_as_of_date"),
    engineVersion: requiredText(
      row.decision_engine_version,
      "decision_engine_version",
    ),
    scopeType: requiredText(row.episode_scope_type, "episode_scope_type"),
    scopeId: requiredText(row.episode_scope_id, "episode_scope_id"),
    snapshotId: requiredText(row.decision_snapshot_id, "decision_snapshot_id"),
    evaluationId: requiredText(
      row.decision_evaluation_id,
      "decision_evaluation_id",
    ),
    inputHash: requiredText(row.episode_input_hash, "episode_input_hash"),
    decisionHash: requiredText(row.decision_hash, "decision_hash"),
    decisionLabel: requiredText(
      row.episode_decision_label,
      "episode_decision_label",
    ),
    sourceCampaignId: row.episode_source_campaign_id,
    sourceAdsetId: row.episode_source_adset_id,
    recommendedAt: requiredText(
      row.episode_recommended_at,
      "episode_recommended_at",
    ),
  });
}

async function lockDecisionOriginAction(
  actionLogId: string,
  db: DbClient,
) {
  const rows = await db.query<LockedDecisionOriginActionRow>(
    LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY,
    [actionLogId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      "Decision-origin action log did not resolve through exact native episode/evaluation/snapshot lineage.",
    );
  }
  if (rows.length !== 1) {
    throw new Error("Decision-origin action lock returned non-unique lineage.");
  }
  return row;
}

async function persistImmutableReceiptFromLockedDbRow(
  row: LockedDecisionOriginActionRow,
  db: DbClient,
) {
  if (row.status === "pending" || !row.terminal_finalized_at) {
    throw new Error("A pending decision-origin action cannot emit a receipt.");
  }
  const request = lockedDecisionOriginRequest(row);
  const episode = episodeFromLockedAction(row);
  if (episode.episodeKey !== row.decision_episode_key) {
    throw new Error("Locked decision-origin episode key failed reconciliation.");
  }
  const receiptId = row.existing_receipt_id ?? randomUUID();
  const capturedAt =
    row.existing_receipt_captured_at ?? row.terminal_finalized_at;
  const actionWithoutHash: Omit<ExactMetaAdsActionLineage, "receiptHash"> = {
    receiptId,
    actionLogId: requiredText(row.id, "action_log_id"),
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: episode.businessId,
    providerAccountRefId: episode.providerAccountRefId,
    providerAccountId: episode.providerAccountId,
    sourceAdId: episode.adId,
    sourceSnapshotId: episode.snapshotId,
    sourceEvaluationId: episode.evaluationId,
    sourceEngineVersion: episode.engineVersion,
    sourceDecisionHash: episode.decisionHash,
    targetEntityType: "ad",
    targetEntityId: episode.adId,
    action: request.action as DecisionOriginAdAction,
    successorKind: null,
    resultingAdId: null,
    idempotencyKey: request.idempotencyKey,
    status: row.status as Exclude<MetaAdsActionStatus, "pending">,
    dryRun: row.dry_run === true,
    providerVerified: row.provider_verified === true,
    requestedAt: requiredText(row.requested_at, "requested_at"),
    verifiedAt: row.verified_at,
    finalizedAt: row.terminal_finalized_at,
    capturedAt,
    verificationEntityId: row.verification_entity_id,
    verificationStatus: row.verification_status,
  };
  const action: ExactMetaAdsActionLineage = {
    ...actionWithoutHash,
    receiptHash: buildExactMetaAdsActionReceiptHash(actionWithoutHash),
  };
  assertExactMetaAdsActionReceiptForEpisode({ episode, action });
  if (
    row.existing_receipt_hash &&
    row.existing_receipt_hash !== action.receiptHash
  ) {
    throw new Error("Stored immutable receipt conflicts with DB-derived lineage.");
  }
  const rows = await db.query<StoredNativeReceiptRow>(
    INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY,
    [
      JSON.stringify({
        id: action.receiptId,
        receipt_hash: action.receiptHash,
        source_action_log_id: action.actionLogId,
        contract_version: action.contractVersion,
        episode_key: episode.episodeKey,
        business_ref_id: episode.businessId,
        business_id: episode.businessDisplayId,
        provider_account_ref_id: episode.providerAccountRefId,
        provider_account_id: episode.providerAccountId,
        source_ad_id: action.sourceAdId,
        source_snapshot_id: action.sourceSnapshotId,
        source_evaluation_id: action.sourceEvaluationId,
        source_engine_version: action.sourceEngineVersion,
        source_decision_hash: action.sourceDecisionHash,
        target_entity_type: action.targetEntityType,
        target_entity_id: action.targetEntityId,
        operator_action: action.action,
        successor_kind: null,
        resulting_ad_id: null,
        idempotency_key: action.idempotencyKey,
        action_status: action.status,
        dry_run: action.dryRun,
        provider_verified: action.providerVerified,
        requested_at: action.requestedAt,
        verified_at: action.verifiedAt,
        finalized_at: action.finalizedAt,
        captured_at: action.capturedAt,
        verification_entity_id: action.verificationEntityId,
        verification_status: action.verificationStatus,
      }),
    ],
  );
  const persisted = rows[0];
  if (
    rows.length !== 1 ||
    persisted?.receipt_id !== action.receiptId ||
    persisted.action_log_id !== action.actionLogId ||
    persisted.receipt_hash !== action.receiptHash
  ) {
    throw new Error(
      "Immutable native receipt did not reconcile exactly with its locked action row.",
    );
  }
  return {
    receiptId: persisted.receipt_id,
    actionLogId: persisted.action_log_id,
    receiptHash: persisted.receipt_hash,
  };
}

export async function persistImmutableAdOperatorActionReceipt(input: {
  actionLogId: string;
  db?: DbClient;
}) {
  if (input.db) {
    const row = await lockDecisionOriginAction(input.actionLogId, input.db);
    return persistImmutableReceiptFromLockedDbRow(row, input.db);
  }
  return runDbTransaction(async () => {
    const db = getDb();
    const row = await lockDecisionOriginAction(input.actionLogId, db);
    return persistImmutableReceiptFromLockedDbRow(row, db);
  });
}

export async function completeDecisionOriginMetaAdsActionLog(input: {
  id: string;
  status: MetaAdsActionStatus;
  payloadResponse?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  verificationPayload?: Record<string, unknown> | null;
}): Promise<MetaAdsActionLogRow> {
  if (input.status === "pending") {
    throw new TypeError("Decision-origin completion requires a terminal status.");
  }
  return runDbTransaction(async () => {
    const db = getDb();
    const locked = await lockDecisionOriginAction(input.id, db);
    if (locked.status !== "pending") {
      if (!locked.existing_receipt_id) {
        throw new Error(
          "Decision-origin action is terminal without its mandatory immutable receipt.",
        );
      }
      await persistImmutableReceiptFromLockedDbRow(locked, db);
      return mapActionLogRow(locked);
    }

    const request = lockedDecisionOriginRequest(locked);
    const dbNow = requiredText(locked.db_now, "db_now");
    const verification = validateDecisionOriginProviderVerification({
      request,
      verifiedAt: dbNow,
      verificationPayload: input.verificationPayload,
    });
    const verificationMismatch =
      input.status === "success" &&
      request.dryRun !== true &&
      !verification.providerVerified;
    const terminalStatus = verificationMismatch
      ? "silent_failure"
      : input.status;
    const payloadResponse = {
      ...(input.payloadResponse ?? {}),
      decision_origin_verification: {
        provider_verified: verification.providerVerified,
        treatment_eligible: verification.treatmentEligible,
        blockers: verification.blockers,
      },
    };
    const updatedRows = await db.query<MetaAdsActionLogDbRow>(
      UPDATE_DECISION_ORIGIN_ACTION_TERMINAL_QUERY,
      [
        input.id,
        terminalStatus,
        JSON.stringify(payloadResponse),
        verificationMismatch ? "silent_failure" : input.errorCode ?? null,
        verificationMismatch
          ? `Provider verification did not match the exact DB-bound ad/action (${verification.blockers.join(", ")}).`
          : input.errorMessage ?? null,
        input.durationMs ?? null,
        verification.providerVerified,
        dbNow,
        JSON.stringify(input.verificationPayload ?? null),
        verification.verificationAdId,
        verification.verificationStatus,
      ],
    );
    if (updatedRows.length !== 1) {
      throw new Error(
        "Decision-origin terminal update did not affect exactly one locked pending row.",
      );
    }
    const finalized = await lockDecisionOriginAction(input.id, db);
    const receipt = await persistImmutableReceiptFromLockedDbRow(finalized, db);
    if (receipt.actionLogId !== input.id) {
      throw new Error("Decision-origin terminal update returned no exact receipt.");
    }
    const reconciled = await lockDecisionOriginAction(input.id, db);
    if (reconciled.existing_receipt_id !== receipt.receiptId) {
      throw new Error(
        "Decision-origin terminal row and immutable receipt did not reconcile.",
      );
    }
    return mapActionLogRow(reconciled);
  });
}

export async function listRecentMetaAdsActionLogs(input: {
  businessId: string;
  adId: string;
  limit?: number;
}): Promise<MetaAdsActionLogRow[]> {
  const sql = getDb();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const rows = (await sql`
    SELECT *
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND ad_id = ${input.adId}
    ORDER BY requested_at DESC
    LIMIT ${limit}
  `) as MetaAdsActionLogDbRow[];
  return rows.map(mapActionLogRow);
}

export async function readLaunchpadCreatedAdIds(input: {
  businessId: string;
  adIds: string[];
}): Promise<Set<string>> {
  const adIds = Array.from(
    new Set(input.adIds.map((adId) => adId.trim()).filter(Boolean)),
  );
  if (adIds.length === 0) return new Set();
  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT resulting_ad_id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND action IN ('launch_ad', 'duplicate')
      AND status = 'success'
      AND resulting_ad_id = ANY(${adIds}::text[])
  `) as Array<{ resulting_ad_id: string | null }>;
  return new Set(
    rows.flatMap((row) => row.resulting_ad_id?.trim() || []),
  );
}
