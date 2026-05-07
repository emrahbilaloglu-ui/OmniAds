import { getDb } from "@/lib/db";

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
  created_at: string;
  updated_at: string;
}

function mapActionLogRow(row: MetaAdsActionLogDbRow): MetaAdsActionLogRow {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function resolveMetaAdActionTarget(input: {
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
        dim_by_creative.provider_account_id,
        dim_by_warehouse_creative.provider_account_id,
        action_result.provider_account_id
      ) AS provider_account_id,
      COALESCE(
        dim_direct.ad_id,
        daily_direct.ad_id,
        dim_by_creative.ad_id,
        dim_by_warehouse_creative.ad_id,
        action_result.resolved_ad_id
      ) AS resolved_ad_id,
      COALESCE(
        dim_direct.creative_id,
        daily_direct.creative_id,
        dim_by_creative.creative_id,
        dim_by_warehouse_creative.creative_id,
        warehouse_creative.creative_id,
        action_result.creative_id
      ) AS creative_id
    FROM (
      SELECT ${input.businessId}::text AS business_id, ${input.adId}::text AS input_id
    ) target
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id AND ad_id = target.input_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_daily
      WHERE business_id = target.business_id AND ad_id = target.input_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) daily_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id AND creative_id = target.input_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_by_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT creative_id
      FROM meta_creative_daily
      WHERE business_id = target.business_id AND ad_id = target.input_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) warehouse_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id
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
        WHERE business_id = target.business_id
          AND adset_id = COALESCE(
            NULLIF(log.payload_request->>'target_adset_id', ''),
            NULLIF(log.payload_request->'body'->>'target_adset_id', ''),
            NULLIF(log.payload_request->'body'->>'adset_id', '')
          )
        ORDER BY updated_at DESC
        LIMIT 1
      ) action_adset ON TRUE
      WHERE log.business_id = target.business_id
        AND log.resulting_ad_id = target.input_id
        AND log.action IN ('launch_ad', 'duplicate')
        AND log.status IN ('success', 'silent_failure')
      ORDER BY log.verified_at DESC NULLS LAST, log.requested_at DESC
      LIMIT 1
    ) action_result ON TRUE
    WHERE COALESCE(
      dim_direct.provider_account_id,
      daily_direct.provider_account_id,
      dim_by_creative.provider_account_id,
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
  statusOption: "ACTIVE" | "PAUSED";
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
      AND COALESCE(
        payload_request->'body'->>'status_option',
        payload_request->>'status_option'
      ) = ${input.statusOption}
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
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
  recIdOrigin?: string | null;
}): Promise<MetaAdsActionLogRow> {
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_ads_action_log (
      business_id,
      ad_id,
      creative_id,
      action,
      requested_by,
      payload_request,
      rec_id_origin,
      status
    ) VALUES (
      ${input.businessId},
      ${input.adId},
      ${input.creativeId ?? null},
      ${input.action},
      ${input.requestedBy ?? null},
      ${JSON.stringify(input.payloadRequest ?? null)}::jsonb,
      ${input.recIdOrigin ?? null},
      'pending'
    )
    RETURNING *
  `) as MetaAdsActionLogDbRow[];
  const row = rows[0];
  if (!row) throw new Error("Failed to create Meta ads action log row.");
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
    RETURNING *
  `) as MetaAdsActionLogDbRow[];
  const row = rows[0];
  if (!row) throw new Error("Failed to update Meta ads action log row.");
  return mapActionLogRow(row);
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
