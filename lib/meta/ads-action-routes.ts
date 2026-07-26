import { resolveMetaAccountAuthority } from "@/lib/meta/account-context";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getIntegration } from "@/lib/integrations";
import { rejectIfMetaWritesBlocked } from "@/lib/meta/automation-write-guard";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  completeDecisionOriginMetaAdsActionLog,
  completeMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  createMetaAdsActionLog,
  decisionOriginIdempotencyReceiptFromLog,
  findRecentDuplicateActionResult,
  hasRecentPendingMetaAdsAction,
  listRecentMetaAdsActionLogs,
  resolveExactMetaAdActionTarget,
  resolveMetaAdActionTarget,
  type MetaAdsActionKind,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import { runServerDecisionOriginAdActionPreflight } from "@/lib/meta/decision-origin-action-preflight";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  validateDecisionOriginAdExecutionRequest,
  type DecisionOriginAdExecutionRequest,
  type DecisionOriginIdempotencyReceipt,
} from "@/lib/creative-decision-engine/execution-safety";
import {
  duplicateAd,
  pauseAd,
  resumeAd,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";

type RouteParams = { params: Promise<{ adId: string }> };

interface ActionBody {
  contractVersion?: string;
  businessId?: string;
  providerAccountId?: string;
  adId?: string;
  snapshotId?: string;
  evaluationId?: string;
  engineVersion?: string;
  decisionHash?: string;
  action?: string;
  idempotencyKey?: string;
  creativeId?: string | null;
  targetAdsetId?: string;
  name?: string;
  activateAfterCreate?: boolean;
  recId?: string;
  recIdOrigin?: string;
  dryRun?: unknown;
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

function recIdOriginFromBody(body: ActionBody | null) {
  return body?.recIdOrigin?.trim() || body?.recId?.trim() || null;
}

function dryRunFromBody(body: ActionBody | null) {
  return body?.dryRun === true;
}

function parseDecisionOriginRequest(input: {
  body: ActionBody | null;
  pathAdId: string;
  action: MetaAdsActionKind;
}):
  | { ok: true; request: DecisionOriginAdExecutionRequest | null }
  | { ok: false; response: NextResponse } {
  const body = input.body;
  const decisionFieldsPresent = Boolean(
    body?.contractVersion ||
      body?.providerAccountId ||
      body?.snapshotId ||
      body?.evaluationId ||
      body?.engineVersion ||
      body?.decisionHash ||
      body?.idempotencyKey,
  );
  if (!decisionFieldsPresent) return { ok: true, request: null };
  if (
    body?.contractVersion !== DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
  ) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_decision_origin_contract",
        "Decision-origin fields require the exact supported contractVersion.",
      ),
    };
  }
  const request: DecisionOriginAdExecutionRequest = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: body.businessId?.trim() ?? "",
    providerAccountId: body.providerAccountId?.trim() ?? "",
    adId: body.adId?.trim() ?? "",
    snapshotId: body.snapshotId?.trim() ?? "",
    evaluationId: body.evaluationId?.trim() ?? "",
    engineVersion: body.engineVersion?.trim() ?? "",
    decisionHash: body.decisionHash?.trim() ?? "",
    action: body.action?.trim() ?? "",
    idempotencyKey: body.idempotencyKey?.trim() ?? "",
    creativeId: body.creativeId?.trim() || null,
    ...(body.dryRun === true ? { dryRun: true } : {}),
  };
  const blockers = validateDecisionOriginAdExecutionRequest(request);
  if (
    blockers.length > 0 ||
    request.adId !== input.pathAdId ||
    request.action !== input.action
  ) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_decision_origin_lineage",
        "Decision-origin request does not match the exact route ad/action lineage.",
        {
          blockers: [
            ...blockers,
            ...(request.adId !== input.pathAdId ? ["route_ad_mismatch"] : []),
            ...(request.action !== input.action
              ? ["route_action_mismatch"]
              : []),
          ],
        },
      ),
    };
  }
  return { ok: true, request };
}

function adsManagerAdUrl(accountNumericId: string, adId: string | null | undefined) {
  const selectedAdId = adId?.trim();
  if (!selectedAdId) return null;
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${encodeURIComponent(
    accountNumericId,
  )}&selected_ad_ids=${encodeURIComponent(selectedAdId)}`;
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
  // Current selection, immediately before a provider mutation. Every campaign,
  // adset and ad action — including duplicate, resume and retry — resolves its
  // write context here, and this previously checked only the connection. A
  // deselected account still has its historical binding and its warehouse
  // dimensions, so an action targeting one would have resolved cleanly and
  // written to a live ad account the user had removed.
  //
  // Tri-state, not a boolean: an unreadable authority must refuse as uncertain
  // rather than be reported as revoked.
  const authority = await resolveMetaAccountAuthority(
    input.businessId,
    providerAccountId,
  );
  if (authority.state === "unknown_error") {
    return {
      ok: false,
      response: jsonError(
        503,
        "meta_account_authority_unknown",
        "Could not verify that this Meta ad account is currently selected. No provider write was attempted.",
      ),
    };
  }
  if (authority.state !== "authorized") {
    return {
      ok: false,
      response: jsonError(
        409,
        "meta_account_not_selected",
        "This Meta ad account is not currently selected for this business. Historical data remains readable; provider writes are refused.",
      ),
    };
  }
  // The generation this access token belongs to, captured WITH the token. The
  // pre-POST check re-reads it and refuses if the connection moved, so a
  // reconnect after this point cannot be written through with the old
  // credential even though the account is still selected.
  const { readProviderConnectionGenerationToken } = await import(
    "@/lib/provider-account-snapshots"
  );
  const connectionGeneration = await readProviderConnectionGenerationToken(
    input.businessId,
    "meta",
  ).catch(() => null);

  return {
    ok: true,
    ctx: {
      businessId: input.businessId,
      providerAccountId,
      accessToken: integration.access_token,
      connectionGeneration,
    },
  };
}

/**
 * Test seam for the write-context guard.
 *
 * resolveWriteContext is private and every action path goes through it, so this
 * is the one place the selection contract can be exercised directly without
 * standing up a full route.
 */
export const __testResolveWriteContext = resolveWriteContext;

function decisionOriginReplayResponse(input: {
  action: MetaAdsActionKind;
  adId: string;
  receipt: DecisionOriginIdempotencyReceipt;
}) {
  const succeeded = input.receipt.status === "success";
  const pending = input.receipt.status === "pending";
  return NextResponse.json(
    {
      ok: succeeded,
      action: input.action,
      adId: input.adId,
      status:
        succeeded && input.action === "pause"
          ? "PAUSED"
          : succeeded && input.action === "resume"
            ? "ACTIVE"
            : null,
      duplicate: true,
      receipt: input.receipt,
      ...(!succeeded
        ? {
            error: {
              code: pending
                ? "action_in_flight"
                : "idempotent_action_failed",
              message: `The existing idempotent action is ${input.receipt.status}; no new provider write was attempted.`,
            },
          }
        : {}),
    },
    { status: pending ? 409 : 200 },
  );
}

function decisionOriginPreflightStatus(errorCode: string | null) {
  if (
    errorCode === "kill_switch_engaged" ||
    errorCode === "kill_switch_state_unavailable" ||
    errorCode === "current_ad_state_unverified" ||
    errorCode === "current_ad_state_stale"
  ) {
    return 503;
  }
  if (errorCode === "ad_not_found") return 404;
  return 409;
}

async function prepareAction(input: {
  request: NextRequest;
  adId: string;
  body: ActionBody | null;
  action: MetaAdsActionKind;
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
  const parsedDecisionOrigin = parseDecisionOriginRequest({
    body: input.body,
    pathAdId: input.adId,
    action: input.action,
  });
  if (!parsedDecisionOrigin.ok) {
    return { ok: false as const, response: parsedDecisionOrigin.response };
  }

  const access = await requireBusinessAccess({
    request: input.request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) {
    return { ok: false as const, response: access.error };
  }
  const reviewerBlocked = rejectIfReviewerReadOnly(access, `ad_${input.action}`);
  if (reviewerBlocked) return { ok: false as const, response: reviewerBlocked };

  const blocked = await rejectIfMetaWritesBlocked({
    businessId: access.membership.businessId,
  });
  if (blocked) return { ok: false as const, response: blocked };

  const targetResult = parsedDecisionOrigin.request
    ? await resolveExactMetaAdActionTarget({
        businessId: access.membership.businessId,
        providerAccountId: parsedDecisionOrigin.request.providerAccountId,
        adId: parsedDecisionOrigin.request.adId,
      })
    : await resolveMetaAdActionTarget({
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

  const ctxResult = await resolveWriteContext({
    businessId: access.membership.businessId,
    providerAccountId: targetResult.target.providerAccountId,
  });
  if (!ctxResult.ok) return { ok: false as const, response: ctxResult.response };

  if (parsedDecisionOrigin.request) {
    let preflight;
    try {
      preflight = await runServerDecisionOriginAdActionPreflight({
        request: parsedDecisionOrigin.request,
        ctx: ctxResult.ctx,
      });
    } catch (error) {
      return {
        ok: false as const,
        response: jsonError(
          503,
          "decision_preflight_unavailable",
          sanitizeErrorMessage(error),
        ),
      };
    }
    if (preflight.disposition === "duplicate" && preflight.duplicateReceipt) {
      return {
        ok: false as const,
        response: decisionOriginReplayResponse({
          action: input.action,
          adId: targetResult.target.adId,
          receipt: preflight.duplicateReceipt,
        }),
      };
    }
    if (!preflight.shouldMutate) {
      return {
        ok: false as const,
        response: jsonError(
          decisionOriginPreflightStatus(preflight.errorCode),
          preflight.errorCode ?? "decision_preflight_blocked",
          `Decision-origin preflight blocked the provider write (${preflight.blockers.join(", ")}).`,
          { blockers: preflight.blockers },
        ),
      };
    }
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

  return {
    ok: true as const,
    businessId: access.membership.businessId,
    userId: access.session.user.id,
    target: targetResult.target,
    ctx: ctxResult.ctx,
    decisionOriginRequest: parsedDecisionOrigin.request,
  };
}

function getFailureLogStatus(result: MetaAdsWriteFailure): MetaAdsActionStatus {
  return result.error.code === "silent_failure" ? "silent_failure" : "failure";
}

async function completeFailure(input: {
  logId: string;
  startedAt: number;
  result: MetaAdsWriteFailure;
  decisionOrigin: boolean;
}) {
  const completion = {
    id: input.logId,
    status: getFailureLogStatus(input.result),
    payloadResponse: ensureRecord(input.result.responsePayload),
    errorCode: input.result.error.code,
    errorMessage: input.result.error.message,
    resultingAdId: input.result.resultingAdId ?? null,
    durationMs: Date.now() - input.startedAt,
    verificationPayload: ensureRecord(input.result.verificationPayload),
  };
  return input.decisionOrigin
    ? completeDecisionOriginMetaAdsActionLog(completion)
    : completeMetaAdsActionLog({
        ...completion,
        verifiedAt: input.result.verificationPayload
          ? new Date().toISOString()
          : null,
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
  const prepared = await prepareAction({ request, adId: inputAdId, body, action });
  if (!prepared.ok) return prepared.response;

  // Use resolved real Meta ad_id (warehouse may have synthesized an id like "creative_..."
  // that does not match the actual Meta entity).
  const resolvedAdId = prepared.target.adId;
  const status = action === "pause" ? "PAUSED" : "ACTIVE";
  const payloadRequest = {
      method: "POST",
      endpoint: `/${resolvedAdId}`,
      body: { status },
      dry_run: dryRunFromBody(body),
      input_ad_id: inputAdId,
      rec_id_origin: recIdOriginFromBody(body),
    };
  const log = prepared.decisionOriginRequest
    ? await createDecisionOriginMetaAdsActionLog({
        request: prepared.decisionOriginRequest,
        requestedBy: prepared.userId,
        payloadRequest,
      })
    : await createMetaAdsActionLog({
        businessId: prepared.businessId,
        adId: resolvedAdId,
        creativeId: prepared.target.creativeId,
        action,
        requestedBy: prepared.userId,
        recIdOrigin: recIdOriginFromBody(body),
        payloadRequest,
      });

  if (prepared.decisionOriginRequest && log.idempotentReplay) {
    return decisionOriginReplayResponse({
      action,
      adId: resolvedAdId,
      receipt: decisionOriginIdempotencyReceiptFromLog(
        log,
        prepared.decisionOriginRequest.idempotencyKey,
      ),
    });
  }

  const startedAt = Date.now();
  try {
    const result =
      action === "pause"
        ? dryRunFromBody(body)
          ? await pauseAd(prepared.ctx, resolvedAdId, { dryRun: true })
          : await pauseAd(prepared.ctx, resolvedAdId)
        : dryRunFromBody(body)
          ? await resumeAd(prepared.ctx, resolvedAdId, { dryRun: true })
          : await resumeAd(prepared.ctx, resolvedAdId);

    if (!result.ok) {
      await completeFailure({
        logId: log.id,
        startedAt,
        result,
        decisionOrigin: Boolean(prepared.decisionOriginRequest),
      });
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          metaHttpStatus: result.httpStatus,
        },
        { status: result.error.code === "kill_switch_engaged" ? 503 : 502 },
      );
    }

    const successCompletion = {
      id: log.id,
      status: "success" as const,
      payloadResponse: ensureRecord(result.responsePayload),
      durationMs: Date.now() - startedAt,
      verificationPayload: ensureRecord(result.verificationPayload),
    };
    if (prepared.decisionOriginRequest) {
      await completeDecisionOriginMetaAdsActionLog(successCompletion);
    } else {
      await completeMetaAdsActionLog({
        ...successCompletion,
        verifiedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      ok: true,
      action,
      adId: resolvedAdId,
      status: result.verifiedStatus,
      dryRun: result.dryRun === true,
      wouldHaveWritten: result.wouldHaveWritten ?? null,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const failureCompletion = {
      id: log.id,
      status: "failure" as const,
      errorCode: "internal_error",
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    };
    await (prepared.decisionOriginRequest
      ? completeDecisionOriginMetaAdsActionLog(failureCompletion)
      : completeMetaAdsActionLog(failureCompletion)
    ).catch(() => null);
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
  if (body?.activateAfterCreate === true) {
    return jsonError(
      400,
      "active_create_not_supported",
      "Duplicate ads must be created PAUSED and resumed separately.",
    );
  }

  const prepared = await prepareAction({ request, adId: inputAdId, body, action: "duplicate" });
  if (!prepared.ok) return prepared.response;

  const resolvedAdId = prepared.target.adId;
  const existingDuplicate = await findRecentDuplicateActionResult({
    businessId: prepared.businessId,
    adId: resolvedAdId,
    targetAdsetId,
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
      status_option: "PAUSED",
      name: trimmedName ?? null,
      dry_run: dryRunFromBody(body),
    },
    input_ad_id: inputAdId,
    rec_id_origin: recIdOriginFromBody(body),
  };
  const log = await createMetaAdsActionLog({
    businessId: prepared.businessId,
    adId: resolvedAdId,
    creativeId: prepared.target.creativeId,
    action: "duplicate",
    requestedBy: prepared.userId,
    recIdOrigin: recIdOriginFromBody(body),
    payloadRequest,
  });

  const startedAt = Date.now();
  try {
    const result = await duplicateAd(prepared.ctx, {
      adId: resolvedAdId,
      targetAdsetId,
      name: trimmedName,
      ...(dryRunFromBody(body) ? { dryRun: true } : {}),
    });

    if (!result.ok) {
      await completeFailure({
        logId: log.id,
        startedAt,
        result,
        decisionOrigin: false,
      });
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          metaHttpStatus: result.httpStatus,
          resultingAdId: result.resultingAdId ?? null,
        },
        { status: result.error.code === "kill_switch_engaged" ? 503 : 502 },
      );
    }

    const resultingAdId = result.dryRun === true ? null : result.newAdId;
    await completeMetaAdsActionLog({
      id: log.id,
      status: "success",
      payloadResponse: ensureRecord(result.responsePayload),
      resultingAdId,
      durationMs: Date.now() - startedAt,
      verifiedAt: new Date().toISOString(),
      verificationPayload: ensureRecord(result.verificationPayload),
    });

    return NextResponse.json({
      ok: true,
      action: "duplicate",
      adId: resolvedAdId,
      newAdId: resultingAdId,
      status: result.verifiedStatus,
      dryRun: result.dryRun === true,
      wouldHaveWritten: result.wouldHaveWritten ?? null,
      adsManagerUrl: adsManagerAdUrl(accountNumericId, resultingAdId),
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
