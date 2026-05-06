import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getIntegration } from "@/lib/integrations";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  findRecentDuplicateActionResult,
  hasRecentPendingMetaAdsAction,
  listRecentMetaAdsActionLogs,
  resolveMetaAdActionTarget,
  type MetaAdsActionKind,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  duplicateAd,
  pauseAd,
  resumeAd,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";

type RouteParams = { params: Promise<{ adId: string }> };

interface ActionBody {
  businessId?: string;
  targetAdsetId?: string;
  name?: string;
  activateAfterCreate?: boolean;
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

async function readActionBody(request: NextRequest): Promise<ActionBody | null> {
  const body = (await request.json().catch(() => null)) as ActionBody | null;
  return body && typeof body === "object" ? body : null;
}

async function resolveWriteContext(input: {
  businessId: string;
  providerAccountId: string | null;
}): Promise<
  | { ok: true; ctx: MetaAdsWriteContext }
  | { ok: false; response: NextResponse }
> {
  const integration = await getIntegration(input.businessId, "meta").catch(
    () => null,
  );
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
        "Could not resolve the Meta ad account for this ad.",
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

async function prepareAction(input: {
  request: NextRequest;
  adId: string;
  body: ActionBody | null;
}) {
  const businessId = input.body?.businessId?.trim() ?? "";
  if (!businessId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_business_id", "businessId is required."),
    };
  }
  if (!input.adId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_ad_id", "adId is required."),
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

  const targetResult = await resolveMetaAdActionTarget({
    businessId: access.membership.businessId,
    adId: input.adId,
  });
  if (!targetResult.ok) {
    return {
      ok: false as const,
      response:
        targetResult.reason === "business_not_found"
          ? jsonError(404, "business_not_found", "Business not found.")
          : jsonError(404, "ad_not_found", "Ad not found for this business."),
    };
  }

  const pending = await hasRecentPendingMetaAdsAction({
    businessId: access.membership.businessId,
    adId: targetResult.target.adId,
    sinceSeconds: 30,
  });
  if (pending) {
    return {
      ok: false as const,
      response: jsonError(
        409,
        "action_in_flight",
        "A Meta ad action is already pending for this ad.",
      ),
    };
  }

  const ctxResult = await resolveWriteContext({
    businessId: access.membership.businessId,
    providerAccountId: targetResult.target.providerAccountId,
  });
  if (!ctxResult.ok) return { ok: false as const, response: ctxResult.response };

  return {
    ok: true as const,
    businessId: access.membership.businessId,
    userId: access.session.user.id,
    target: targetResult.target,
    ctx: ctxResult.ctx,
  };
}

function getFailureLogStatus(result: MetaAdsWriteFailure): MetaAdsActionStatus {
  return result.error.code === "silent_failure" ? "silent_failure" : "failure";
}

async function completeFailure(input: {
  logId: string;
  startedAt: number;
  result: MetaAdsWriteFailure;
}) {
  return completeMetaAdsActionLog({
    id: input.logId,
    status: getFailureLogStatus(input.result),
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

export async function handleMetaAdStatusAction(
  request: NextRequest,
  context: RouteParams,
  action: Extract<MetaAdsActionKind, "pause" | "resume">,
) {
  const { adId: rawAdId } = await context.params;
  const inputAdId = rawAdId?.trim() ?? "";
  const body = await readActionBody(request);
  const prepared = await prepareAction({ request, adId: inputAdId, body });
  if (!prepared.ok) return prepared.response;

  // Use resolved real Meta ad_id (warehouse may have synthesized an id like "creative_..."
  // that does not match the actual Meta entity).
  const resolvedAdId = prepared.target.adId;
  const status = action === "pause" ? "PAUSED" : "ACTIVE";
  const log = await createMetaAdsActionLog({
    businessId: prepared.businessId,
    adId: resolvedAdId,
    creativeId: prepared.target.creativeId,
    action,
    requestedBy: prepared.userId,
    payloadRequest: {
      method: "POST",
      endpoint: `/${resolvedAdId}`,
      body: { status },
      input_ad_id: inputAdId,
    },
  });

  const startedAt = Date.now();
  try {
    const result =
      action === "pause"
        ? await pauseAd(prepared.ctx, resolvedAdId)
        : await resumeAd(prepared.ctx, resolvedAdId);

    if (!result.ok) {
      await completeFailure({ logId: log.id, startedAt, result });
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          metaHttpStatus: result.httpStatus,
        },
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
      action,
      adId: resolvedAdId,
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

export async function handleMetaAdDuplicateAction(
  request: NextRequest,
  context: RouteParams,
) {
  const { adId: rawAdId } = await context.params;
  const inputAdId = rawAdId?.trim() ?? "";
  const body = await readActionBody(request);
  const targetAdsetId = body?.targetAdsetId?.trim() ?? "";
  if (!targetAdsetId) {
    return jsonError(
      400,
      "missing_target_adset_id",
      "targetAdsetId is required.",
    );
  }

  const prepared = await prepareAction({ request, adId: inputAdId, body });
  if (!prepared.ok) return prepared.response;

  const resolvedAdId = prepared.target.adId;
  const activateAfterCreate = body?.activateAfterCreate === true;
  const statusOption = activateAfterCreate ? "ACTIVE" : "PAUSED";
  const existingDuplicate = await findRecentDuplicateActionResult({
    businessId: prepared.businessId,
    adId: resolvedAdId,
    targetAdsetId,
    statusOption,
    sinceMinutes: 10,
  });
  if (existingDuplicate?.resultingAdId) {
    return jsonError(
      409,
      "duplicate_already_attempted",
      "A recent duplicate attempt already produced an ad for this source and target.",
      { existingAdId: existingDuplicate.resultingAdId },
    );
  }

  const trimmedName =
    typeof body?.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : undefined;
  const accountNumericId = prepared.ctx.providerAccountId.replace(/^act_/, "");
  const payloadRequest = {
    method: "POST",
    endpoint: `/act_${accountNumericId}/ads`,
    body: {
      adset_id: targetAdsetId,
      target_adset_id: targetAdsetId,
      status_option: statusOption,
      name: trimmedName ?? null,
    },
    input_ad_id: inputAdId,
  };
  const log = await createMetaAdsActionLog({
    businessId: prepared.businessId,
    adId: resolvedAdId,
    creativeId: prepared.target.creativeId,
    action: "duplicate",
    requestedBy: prepared.userId,
    payloadRequest,
  });

  const startedAt = Date.now();
  try {
    const result = await duplicateAd(prepared.ctx, {
      adId: resolvedAdId,
      targetAdsetId,
      name: trimmedName,
      activateAfterCreate,
    });

    if (!result.ok) {
      await completeFailure({ logId: log.id, startedAt, result });
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          metaHttpStatus: result.httpStatus,
          resultingAdId: result.resultingAdId ?? null,
        },
        { status: 502 },
      );
    }

    await completeMetaAdsActionLog({
      id: log.id,
      status: "success",
      payloadResponse: ensureRecord(result.responsePayload),
      resultingAdId: result.newAdId,
      durationMs: Date.now() - startedAt,
      verifiedAt: new Date().toISOString(),
      verificationPayload: ensureRecord(result.verificationPayload),
    });

    return NextResponse.json({
      ok: true,
      action: "duplicate",
      adId: resolvedAdId,
      newAdId: result.newAdId,
      status: result.verifiedStatus,
      adsManagerUrl: `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${encodeURIComponent(
        accountNumericId,
      )}&selected_ad_ids=${encodeURIComponent(result.newAdId)}`,
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

export async function handleMetaAdActionsHistory(
  request: NextRequest,
  context: RouteParams,
) {
  const { adId: rawAdId } = await context.params;
  const inputAdId = rawAdId?.trim() ?? "";
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!inputAdId) return jsonError(400, "missing_ad_id", "adId is required.");
  if (!businessId) {
    return jsonError(400, "missing_business_id", "businessId is required.");
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const targetResult = await resolveMetaAdActionTarget({
    businessId: access.membership.businessId,
    adId: inputAdId,
  });
  if (!targetResult.ok) {
    return targetResult.reason === "business_not_found"
      ? jsonError(404, "business_not_found", "Business not found.")
      : jsonError(404, "ad_not_found", "Ad not found for this business.");
  }
  const rows = await listRecentMetaAdsActionLogs({
    businessId: access.membership.businessId,
    adId: targetResult.target.adId,
    limit: 10,
  });
  return NextResponse.json({ ok: true, rows });
}
