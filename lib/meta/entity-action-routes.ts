import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAdsAction,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  pauseAdset,
  pauseCampaign,
  resumeAdset,
  resumeCampaign,
  updateAdsetBidAmount,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";

type MetaEntityScopeType = "campaign" | "adset";
type MetaEntityStatusAction = "pause" | "resume";
type RouteParams = { params: Promise<Record<string, string | undefined>> };

interface EntityActionBody {
  businessId?: string;
  recId?: string;
  recIdOrigin?: string;
  bidValue?: unknown;
  bidValueMinor?: unknown;
}

interface EntityActionTarget {
  businessId: string;
  scopeType: MetaEntityScopeType;
  entityId: string;
  providerAccountId: string | null;
  label: string | null;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(extra ?? {}) } },
    { status },
  );
}

function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

function recIdOriginFromBody(body: EntityActionBody | null) {
  return body?.recIdOrigin?.trim() || body?.recId?.trim() || null;
}

function requestedByFromAccess(access: Awaited<ReturnType<typeof requireBusinessAccess>>) {
  if ("error" in access) return null;
  const session = access.session as { user?: { id?: string | null } };
  return session.user?.id ?? null;
}

async function readActionBody(request: NextRequest): Promise<EntityActionBody | null> {
  const body = (await request.json().catch(() => null)) as EntityActionBody | null;
  return body && typeof body === "object" ? body : null;
}

async function resolveMetaEntityActionTarget(input: {
  businessId: string;
  scopeType: MetaEntityScopeType;
  entityId: string;
}): Promise<EntityActionTarget | null> {
  const sql = getDb();
  if (input.scopeType === "campaign") {
    const rows = (await sql`
      WITH candidates AS (
        SELECT
          provider_account_id,
          COALESCE(campaign_name_current, campaign_name_historical, campaign_id) AS label,
          updated_at AS seen_at
        FROM meta_campaign_dimensions
        WHERE business_id = ${input.businessId}
          AND campaign_id = ${input.entityId}
        UNION ALL
        SELECT
          provider_account_id,
          COALESCE(campaign_name_current, campaign_name_historical, campaign_id) AS label,
          date::timestamptz AS seen_at
        FROM meta_campaign_daily
        WHERE business_id = ${input.businessId}
          AND campaign_id = ${input.entityId}
        UNION ALL
        SELECT
          provider_account_id,
          campaign_id AS label,
          captured_at AS seen_at
        FROM meta_campaign_config_history
        WHERE business_id = ${input.businessId}
          AND campaign_id = ${input.entityId}
      )
      SELECT provider_account_id, label
      FROM candidates
      WHERE provider_account_id IS NOT NULL
      ORDER BY seen_at DESC NULLS LAST
      LIMIT 1
    `) as Array<{ provider_account_id: string | null; label: string | null }>;
    const row = rows[0];
    return row
      ? {
          businessId: input.businessId,
          scopeType: input.scopeType,
          entityId: input.entityId,
          providerAccountId: row.provider_account_id,
          label: row.label,
        }
      : null;
  }

  const rows = (await sql`
    WITH candidates AS (
      SELECT
        provider_account_id,
        COALESCE(adset_name_current, adset_name_historical, adset_id) AS label,
        updated_at AS seen_at
      FROM meta_adset_dimensions
      WHERE business_id = ${input.businessId}
        AND adset_id = ${input.entityId}
      UNION ALL
      SELECT
        provider_account_id,
        COALESCE(adset_name_current, adset_name_historical, adset_id) AS label,
        date::timestamptz AS seen_at
      FROM meta_adset_daily
      WHERE business_id = ${input.businessId}
        AND adset_id = ${input.entityId}
      UNION ALL
      SELECT
        provider_account_id,
        adset_id AS label,
        captured_at AS seen_at
      FROM meta_adset_config_history
      WHERE business_id = ${input.businessId}
        AND adset_id = ${input.entityId}
    )
    SELECT provider_account_id, label
    FROM candidates
    WHERE provider_account_id IS NOT NULL
    ORDER BY seen_at DESC NULLS LAST
    LIMIT 1
  `) as Array<{ provider_account_id: string | null; label: string | null }>;
  const row = rows[0];
  return row
    ? {
        businessId: input.businessId,
        scopeType: input.scopeType,
        entityId: input.entityId,
        providerAccountId: row.provider_account_id,
        label: row.label,
      }
    : null;
}

async function resolveWriteContext(input: {
  businessId: string;
  providerAccountId: string | null;
}): Promise<
  | { ok: true; ctx: MetaAdsWriteContext }
  | { ok: false; response: NextResponse }
> {
  const integration = await getIntegration(input.businessId, "meta").catch(() => null);
  if (integration?.status !== "connected" || !integration.access_token) {
    return {
      ok: false,
      response: jsonError(
        502,
        "meta_not_connected",
        "Meta integration is not connected or has no usable access token.",
      ),
    };
  }
  const providerAccountId =
    input.providerAccountId ?? integration.provider_account_id ?? null;
  if (!providerAccountId) {
    return {
      ok: false,
      response: jsonError(
        502,
        "meta_account_unresolved",
        "Could not resolve the Meta ad account for this entity.",
      ),
    };
  }
  return {
    ok: true,
    ctx: {
      businessId: input.businessId,
      providerAccountId,
      accessToken: integration.access_token,
    },
  };
}

function failureLogStatus(result: MetaAdsWriteFailure): MetaAdsActionStatus {
  return result.error.code === "silent_failure" ? "silent_failure" : "failure";
}

async function completeFailure(input: {
  logId: string;
  startedAt: number;
  result: MetaAdsWriteFailure;
}) {
  return completeMetaAdsActionLog({
    id: input.logId,
    status: failureLogStatus(input.result),
    payloadResponse: ensureRecord(input.result.responsePayload),
    errorCode: input.result.error.code,
    errorMessage: input.result.error.message,
    resultingAdId: input.result.resultingAdId ?? null,
    durationMs: Date.now() - input.startedAt,
    verifiedAt: input.result.verificationPayload
      ? new Date().toISOString()
      : null,
    verificationPayload: ensureRecord(input.result.verificationPayload),
  });
}

async function prepareEntityAction(input: {
  request: NextRequest;
  body: EntityActionBody | null;
  scopeType: MetaEntityScopeType;
  entityId: string;
}) {
  const businessId = input.body?.businessId?.trim() ?? "";
  if (!businessId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_business_id", "businessId is required."),
    };
  }
  if (!input.entityId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_entity_id", "Entity id is required."),
    };
  }

  const access = await requireBusinessAccess({
    request: input.request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) {
    return { ok: false as const, response: access.error };
  }

  const target = await resolveMetaEntityActionTarget({
    businessId: access.membership.businessId,
    scopeType: input.scopeType,
    entityId: input.entityId,
  });
  if (!target) {
    return {
      ok: false as const,
      response: jsonError(404, "entity_not_found", "Meta entity not found for this business."),
    };
  }

  const pending = await hasRecentPendingMetaAdsAction({
    businessId: access.membership.businessId,
    adId: target.entityId,
    sinceSeconds: 30,
  });
  if (pending) {
    return {
      ok: false as const,
      response: jsonError(
        409,
        "action_in_flight",
        "A Meta action is already pending for this entity.",
      ),
    };
  }

  const ctxResult = await resolveWriteContext({
    businessId: access.membership.businessId,
    providerAccountId: target.providerAccountId,
  });
  if (!ctxResult.ok) return { ok: false as const, response: ctxResult.response };

  return {
    ok: true as const,
    access,
    businessId: access.membership.businessId,
    requestedBy: requestedByFromAccess(access),
    target,
    ctx: ctxResult.ctx,
  };
}

export async function handleMetaEntityPauseAction(
  request: NextRequest,
  context: RouteParams,
  input: { scopeType: MetaEntityScopeType; paramName: string },
) {
  return handleMetaEntityStatusAction(request, context, {
    ...input,
    action: "pause",
  });
}

export async function handleMetaEntityResumeAction(
  request: NextRequest,
  context: RouteParams,
  input: { scopeType: MetaEntityScopeType; paramName: string },
) {
  return handleMetaEntityStatusAction(request, context, {
    ...input,
    action: "resume",
  });
}

async function handleMetaEntityStatusAction(
  request: NextRequest,
  context: RouteParams,
  input: { scopeType: MetaEntityScopeType; paramName: string; action: MetaEntityStatusAction },
) {
  const params = await context.params;
  const entityId = params[input.paramName]?.trim() ?? "";
  const body = await readActionBody(request);
  const prepared = await prepareEntityAction({
    request,
    body,
    scopeType: input.scopeType,
    entityId,
  });
  if (!prepared.ok) return prepared.response;

  const log = await createMetaAdsActionLog({
    businessId: prepared.businessId,
    adId: prepared.target.entityId,
    creativeId: null,
    action: input.action,
    requestedBy: prepared.requestedBy,
    recIdOrigin: recIdOriginFromBody(body),
    payloadRequest: {
      method: "POST",
      endpoint: `/${prepared.target.entityId}`,
      scope_type: input.scopeType,
      body: { status: input.action === "pause" ? "PAUSED" : "ACTIVE" },
      rec_id_origin: recIdOriginFromBody(body),
    },
  });

  const startedAt = Date.now();
  try {
    const result =
      input.scopeType === "campaign"
        ? input.action === "pause"
          ? await pauseCampaign(prepared.ctx, prepared.target.entityId)
          : await resumeCampaign(prepared.ctx, prepared.target.entityId)
        : input.action === "pause"
          ? await pauseAdset(prepared.ctx, prepared.target.entityId)
          : await resumeAdset(prepared.ctx, prepared.target.entityId);

    if (!result.ok) {
      await completeFailure({ logId: log.id, startedAt, result });
      return NextResponse.json(
        { ok: false, error: result.error, metaHttpStatus: result.httpStatus },
        { status: 502 },
      );
    }

    await completeMetaAdsActionLog({
      id: log.id,
      status: "success",
      payloadResponse: ensureRecord(result.responsePayload),
      durationMs: Date.now() - startedAt,
      verifiedAt: new Date().toISOString(),
      verificationPayload: ensureRecord(result.verificationPayload),
    });

    return NextResponse.json({
      ok: true,
      action: input.action,
      scopeType: input.scopeType,
      entityId: prepared.target.entityId,
      status: result.verifiedStatus,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    await completeMetaAdsActionLog({
      id: log.id,
      status: "failure",
      errorCode: "internal_error",
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    }).catch(() => null);
    return jsonError(500, "internal_error", message);
  }
}

function bidAmountMinorFromBody(body: EntityActionBody | null) {
  const explicitMinor = Number(body?.bidValueMinor ?? NaN);
  if (Number.isFinite(explicitMinor) && explicitMinor > 0) {
    return Math.round(explicitMinor);
  }
  const bidValue = Number(body?.bidValue ?? NaN);
  if (!Number.isFinite(bidValue) || bidValue <= 0) return null;
  return Math.round(bidValue * 100);
}

export async function handleMetaAdsetBidAction(
  request: NextRequest,
  context: RouteParams,
) {
  const params = await context.params;
  const adsetId = params.adsetId?.trim() ?? "";
  const body = await readActionBody(request);
  const bidAmountMinor = bidAmountMinorFromBody(body);
  if (!bidAmountMinor) {
    return jsonError(400, "invalid_bid_value", "bidValue must be a positive number.");
  }

  const prepared = await prepareEntityAction({
    request,
    body,
    scopeType: "adset",
    entityId: adsetId,
  });
  if (!prepared.ok) return prepared.response;

  const log = await createMetaAdsActionLog({
    businessId: prepared.businessId,
    adId: prepared.target.entityId,
    creativeId: null,
    action: "launch_adset",
    requestedBy: prepared.requestedBy,
    recIdOrigin: recIdOriginFromBody(body),
    payloadRequest: {
      method: "POST",
      endpoint: `/${prepared.target.entityId}`,
      scope_type: "adset",
      operation: "apply_bid",
      body: { bid_amount: bidAmountMinor },
      rec_id_origin: recIdOriginFromBody(body),
    },
  });

  const startedAt = Date.now();
  try {
    const result = await updateAdsetBidAmount(prepared.ctx, {
      adsetId: prepared.target.entityId,
      bidAmountMinor,
    });
    if (!result.ok) {
      await completeFailure({ logId: log.id, startedAt, result });
      return NextResponse.json(
        { ok: false, error: result.error, metaHttpStatus: result.httpStatus },
        { status: 502 },
      );
    }

    await completeMetaAdsActionLog({
      id: log.id,
      status: "success",
      payloadResponse: ensureRecord(result.responsePayload),
      durationMs: Date.now() - startedAt,
      verifiedAt: new Date().toISOString(),
      verificationPayload: ensureRecord(result.verificationPayload),
    });

    return NextResponse.json({
      ok: true,
      action: "apply_bid",
      scopeType: "adset",
      adsetId: prepared.target.entityId,
      bidAmountMinor: result.verifiedBidAmount,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    await completeMetaAdsActionLog({
      id: log.id,
      status: "failure",
      errorCode: "internal_error",
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    }).catch(() => null);
    return jsonError(500, "internal_error", message);
  }
}
