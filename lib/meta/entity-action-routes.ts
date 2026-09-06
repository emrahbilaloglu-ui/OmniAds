import { resolveMetaAccountAuthority } from "@/lib/meta/account-context";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  metaWriteFailureAnswer,
  metaWriteTerminalAnswer,
} from "@/lib/meta/write-outcome";
import { getDb } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import {
  metaWriteBlockedResponse,
  metaWriteIsRehearsal,
  readMetaWritePosture,
  type MetaWritePosture,
} from "@/lib/meta/automation-write-guard";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  getMetaAccountContext,
  normalizeMetaCurrencyCode,
} from "@/lib/meta/account-context";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAdsAction,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  hasSuccessfulMetaProviderMutationAttempt,
  pauseAdset,
  pauseCampaign,
  readMetaEntityExecutionState,
  resumeAdset,
  resumeCampaign,
  updateAdsetBidAmount,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
  type MetaEntityExecutionStateRead,
} from "@/lib/meta/ads-write";
import {
  META_ACTION_ORIGIN_ALIAS_FIELDS,
  META_NATIVE_LINEAGE_FIELDS,
  hasInvalidMetaDryRunField,
  presentMetaActionContractFields,
} from "@/lib/launchpad/meta-manual-authority";

type MetaEntityScopeType = "campaign" | "adset";
type MetaEntityStatusAction = "pause" | "resume";
type RouteParams = { params: Promise<Record<string, string | undefined>> };

interface EntityActionBody {
  actionOrigin?: string;
  manualConfirmation?: string;
  businessId?: string;
  providerAccountId?: string;
  recId?: string;
  recIdOrigin?: string;
  bidValue?: unknown;
  bidValueMinor?: unknown;
  bidAmountMinor?: unknown;
  dryRun?: unknown;
}

const META_ENTITY_MANUAL_ACTION_ORIGIN = "manual_operator_v1";
const META_ENTITY_MANUAL_CONFIRMATION = "explicit_operator_confirmation";

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

function dryRunFromBody(body: EntityActionBody | null) {
  return body?.dryRun === true;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function evaluateManualMetaEntityPreflight(input: {
  action: MetaEntityStatusAction | "apply_bid";
  scopeType: MetaEntityScopeType;
  expectedEntityId: string;
  expectedProviderAccountId: string;
  state: MetaEntityExecutionStateRead;
}) {
  if (!input.state.ok) {
    return {
      ok: false as const,
      blocker: input.state.error.code || "current_entity_state_unverified",
      retryable:
        input.state.httpStatus == null ||
        input.state.httpStatus === 429 ||
        input.state.httpStatus >= 500,
    };
  }
  const normalizedAccount = (value: string | null) => {
    const numeric = value?.trim().replace(/^act_/, "") ?? "";
    return numeric ? `act_${numeric}` : null;
  };
  const upper = (value: string | null) =>
    value?.trim().toUpperCase() || null;
  if (input.state.entityId !== input.expectedEntityId) {
    return {
      ok: false as const,
      blocker: "entity_identity_mismatch",
      retryable: false,
    };
  }
  if (
    normalizedAccount(input.state.providerAccountId) !==
    normalizedAccount(input.expectedProviderAccountId)
  ) {
    return {
      ok: false as const,
      blocker: "provider_account_mismatch",
      retryable: false,
    };
  }

  const configuredStatus = upper(input.state.configuredStatus);
  const effectiveStatus = upper(input.state.effectiveStatus);
  if (!configuredStatus || !effectiveStatus) {
    return {
      ok: false as const,
      blocker: "current_entity_state_unverified",
      retryable: true,
    };
  }
  if (input.scopeType === "adset") {
    if (
      !input.state.campaignId ||
      normalizedAccount(input.state.campaignProviderAccountId) !==
        normalizedAccount(input.expectedProviderAccountId)
    ) {
      return {
        ok: false as const,
        blocker: "current_hierarchy_identity_mismatch",
        retryable: false,
      };
    }
    if (
      upper(input.state.campaignConfiguredStatus) !== "ACTIVE" ||
      upper(input.state.campaignEffectiveStatus) !== "ACTIVE"
    ) {
      return {
        ok: false as const,
        blocker: "current_hierarchy_state_incompatible",
        retryable: false,
      };
    }
  }

  if (input.action === "apply_bid") {
    if (
      configuredStatus !== effectiveStatus ||
      (configuredStatus !== "ACTIVE" && configuredStatus !== "PAUSED")
    ) {
      return {
        ok: false as const,
        blocker: "current_entity_state_incompatible",
        retryable: false,
      };
    }
  } else {
    const expected = input.action === "pause" ? "ACTIVE" : "PAUSED";
    if (
      configuredStatus !== expected ||
      effectiveStatus !== expected
    ) {
      return {
        ok: false as const,
        blocker: "current_entity_state_incompatible",
        retryable: false,
      };
    }
  }
  return { ok: true as const, blocker: null, retryable: false };
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
  // Campaign and ad-set pause, resume and bid changes reached the provider with
  // a connected token and no current-selection check at all — only the ad-level
  // routes had one. The entity target is resolved from warehouse dimensions,
  // which SURVIVE deselection by design, so a deselected account resolved
  // cleanly here and the write went out.
  //
  // Tri-state: an unreadable authority refuses as uncertain (retryable), never
  // as revoked (terminal). This is the route-admission check; ads-write re-reads
  // it again immediately before the POST, which is what closes the window
  // between the two.
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
  return {
    ok: true,
    ctx: {
      businessId: input.businessId,
      providerAccountId,
      accessToken: integration.access_token,
      // The generation this token belongs to, from the SAME row. The pre-POST
      // snapshot re-reads it, so a reconnect after this point refuses the write
      // even though the account is still selected.
      connectionGeneration: `${integration.connection_generation ?? 1}:${integration.status}`,
    },
  };
}

export const __testResolveEntityWriteContext = resolveWriteContext;

function failureLogStatus(
  result: MetaAdsWriteFailure,
): Exclude<MetaAdsActionStatus, "pending" | "success"> {
  return result.error.code === "silent_failure" ||
    hasSuccessfulMetaProviderMutationAttempt(result) ||
    result.error.code === "provider_outcome_ambiguous" ||
    result.providerOutcome === "outcome_ambiguous"
    ? "silent_failure"
    : "failure";
}

function isProviderOutcomeAmbiguous(result: MetaAdsWriteFailure) {
  return (
    result.error.code === "provider_outcome_ambiguous" ||
    result.providerOutcome === "outcome_ambiguous"
  );
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
  action: string;
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
  if (hasInvalidMetaDryRunField(input.body)) {
    return {
      ok: false as const,
      response: jsonError(
        400,
        "invalid_dry_run",
        "dryRun must be a JSON boolean when provided.",
      ),
    };
  }
  if (
    presentMetaActionContractFields(
      input.body,
      META_ACTION_ORIGIN_ALIAS_FIELDS,
    ).length > 0
  ) {
    return {
      ok: false as const,
      response: jsonError(
        400,
        "mixed_action_origin_contract",
        "The request must carry exactly one canonical, non-conflicting action origin.",
      ),
    };
  }
  if (
    stringField(input.body?.actionOrigin) !==
    META_ENTITY_MANUAL_ACTION_ORIGIN
  ) {
    return {
      ok: false as const,
      response: jsonError(
        400,
        "action_origin_required",
        "Campaign and ad set actions require the explicit manual-operator contract.",
      ),
    };
  }
  if (
    presentMetaActionContractFields(
      input.body,
      META_NATIVE_LINEAGE_FIELDS,
    ).length > 0
  ) {
    return {
      ok: false as const,
      response: jsonError(
        400,
        "mixed_action_origin_contract",
        "Manual entity actions cannot carry native decision lineage fields.",
      ),
    };
  }
  if (input.body?.manualConfirmation !== META_ENTITY_MANUAL_CONFIRMATION) {
    return {
      ok: false as const,
      response: jsonError(
        400,
        "manual_confirmation_required",
        "Manual-operator actions require explicit operator confirmation.",
      ),
    };
  }
  const requestedProviderAccountId =
    input.body?.providerAccountId?.trim() ?? "";
  if (!requestedProviderAccountId) {
    return {
      ok: false as const,
      response: jsonError(
        400,
        "provider_account_id_required",
        "Manual entity actions require the server-presented providerAccountId.",
      ),
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
  const reviewerBlocked = rejectIfReviewerReadOnly(access, `${input.scopeType}_${input.action}`);
  if (reviewerBlocked) return { ok: false as const, response: reviewerBlocked };

  /*
    The server's posture, read once and carried.

    Previously this only asked "is it blocked" and threw the answer away. The
    other half — whether the business is REHEARSING — never left this function,
    so every handler below decided `dryRun` from the request body alone and a
    request that omitted the flag reached a real provider POST while the
    business's own guardrail said rehearse.
  */
  const posture = await readMetaWritePosture({
    businessId: access.membership.businessId,
  });
  if (posture.blocked) {
    return { ok: false as const, response: metaWriteBlockedResponse(posture) };
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
  if (
    !target.providerAccountId ||
    target.providerAccountId.replace(/^act_/, "") !==
      requestedProviderAccountId.replace(/^act_/, "")
  ) {
    return {
      ok: false as const,
      response: jsonError(
        409,
        "provider_account_mismatch",
        "The requested entity does not belong to the server-presented provider account.",
      ),
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

  const currentState = await readMetaEntityExecutionState(
    ctxResult.ctx,
    input.scopeType,
    target.entityId,
  ).catch(() => null);
  const preflight = currentState
    ? evaluateManualMetaEntityPreflight({
        action:
          input.action === "apply_bid"
            ? "apply_bid"
            : (input.action as MetaEntityStatusAction),
        scopeType: input.scopeType,
        expectedEntityId: target.entityId,
        expectedProviderAccountId: requestedProviderAccountId,
        state: currentState,
      })
    : {
        ok: false as const,
        blocker: "current_entity_state_unverified",
        retryable: true,
      };
  if (!preflight.ok) {
    return {
      ok: false as const,
      response: jsonError(
        preflight.retryable ? 503 : 409,
        preflight.blocker,
        `Manual entity preflight blocked the provider write (${preflight.blocker}).`,
      ),
    };
  }

  return {
    ok: true as const,
    access,
    businessId: access.membership.businessId,
    requestedBy: requestedByFromAccess(access),
    target,
    ctx: ctxResult.ctx,
    posture,
  };
}

/**
 * Re-prove the posture immediately before the one provider POST.
 *
 * The checks above ran at the top of the request. Resolving the target,
 * building the write context and running the preflight all take time, and in
 * that time an operator can engage the STOP or an admin can turn the
 * capability off. This hook runs after every adapter-side check and
 * immediately before the request begins — the last point at which a re-read
 * can prevent a write rather than describe one.
 *
 * A throw here means no request was made at all.
 */
function beforeEntityProviderPost(input: {
  businessId: string;
  /** What the first read decided, so a change of posture is visible as one. */
  rehearsalAtEntry: boolean;
}): () => Promise<void> {
  return async () => {
    const posture = await readMetaWritePosture({ businessId: input.businessId });
    if (posture.blocked) {
      throw Object.assign(
        new Error(posture.message ?? "Meta writes were blocked before the request."),
        { code: posture.reason ?? "kill_switch_engaged" },
      );
    }
    /*
      Rehearsal turned on between the entry check and here.

      Refusing is the only honest answer: this call was composed as a live
      write, and downgrading it now would send a dry run whose receipt claims
      to be the operator's requested action.
    */
    if (posture.rehearsal && !input.rehearsalAtEntry) {
      throw Object.assign(new Error("Rehearsal was engaged before this write."), {
        code: "dry_run_guardrail",
      });
    }
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
    action: input.action,
  });
  if (!prepared.ok) return prepared.response;

  /*
    THE SERVER decides whether this reaches Meta.

    `dryRunFromBody` is what the client ASKED for; the persisted guardrail is
    what the business COMMITTED to. Or-ing them means a request may always
    rehearse and may never decline to.
  */
  const dryRun = metaWriteIsRehearsal({
    posture: prepared.posture,
    requestedDryRun: dryRunFromBody(body),
  });

  const log = await createMetaAdsActionLog({
    businessId: prepared.businessId,
    /*
      The account this write belongs to. It used to be omitted.

      `meta_ads_action_log` then took the row with `provider_account_id` NULL,
      and `history-read-model.ts` filters its action-log branch on
      `action_log.provider_account_id = $2` — deliberately, so a row with no
      account lineage fails closed rather than leaking across accounts. The
      consequence was that a successful operator pause, resume or bid write
      never appeared in Meta History's Writes journal at all: the receipt was
      durable and invisible. The throwing guard inside `createMetaAdsActionLog`
      only demands the id for AD-grain manual status claims, which is why the
      campaign and ad-set path went silently unlineaged.
    */
    providerAccountId: prepared.ctx.providerAccountId,
    adId: prepared.target.entityId,
    creativeId: null,
    action: input.action,
    source: META_ENTITY_MANUAL_ACTION_ORIGIN,
    requestedBy: prepared.requestedBy,
    recIdOrigin: recIdOriginFromBody(body),
    payloadRequest: {
      method: "POST",
      endpoint: `/${prepared.target.entityId}`,
      scope_type: input.scopeType,
      body: { status: input.action === "pause" ? "PAUSED" : "ACTIVE" },
      dry_run: dryRun,
      // What the client asked for, kept beside what the server decided, so a
      // receipt can never be read as the operator having chosen a rehearsal
      // they did not choose.
      dry_run_requested: dryRunFromBody(body),
      dry_run_source: prepared.posture.rehearsal ? "business_guardrail" : "request",
      rec_id_origin: recIdOriginFromBody(body),
      action_origin: META_ENTITY_MANUAL_ACTION_ORIGIN,
      manual_confirmation: META_ENTITY_MANUAL_CONFIRMATION,
    },
  });

  const startedAt = Date.now();
  try {
    /*
      A rehearsal never posts, so it needs no pre-POST re-check; a live write
      always does. Passing the hook unconditionally would make the dry-run
      verification path read the control plane for nothing.
    */
    const options = dryRun
      ? { dryRun: true }
      : {
        beforeMutationAttempt: beforeEntityProviderPost({
          businessId: prepared.businessId,
          rehearsalAtEntry: prepared.posture.rehearsal,
        }),
      };
    const result =
      input.scopeType === "campaign"
        ? input.action === "pause"
          ? await pauseCampaign(prepared.ctx, prepared.target.entityId, options)
          : await resumeCampaign(prepared.ctx, prepared.target.entityId, options)
        : input.action === "pause"
          ? await pauseAdset(prepared.ctx, prepared.target.entityId, options)
          : await resumeAdset(prepared.ctx, prepared.target.entityId, options);

    if (!result.ok) {
      await completeFailure({ logId: log.id, startedAt, result });
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          message: result.error?.message,
          metaHttpStatus: result.httpStatus,
          providerOutcome: result.providerOutcome ?? null,
          ...metaWriteFailureAnswer({
            providerOutcome: result.providerOutcome,
            logId: log.id,
          }),
          mutationAttempt: result.mutationAttempt ?? null,
          retryAllowed:
            isProviderOutcomeAmbiguous(result) ||
            hasSuccessfulMetaProviderMutationAttempt(result)
              ? false
              : null,
        },
        { status: result.error.code === "kill_switch_engaged" ? 503 : 502 },
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
      dryRun: result.dryRun === true,
      wouldHaveWritten: result.wouldHaveWritten ?? null,
      // The terminal answer the ceremony reads. Derived from the row just
      // written, not from the absence of an error.
      ...metaWriteTerminalAnswer({
        dryRun: result.dryRun === true,
        logStatus: "success",
        logId: log.id,
      }),
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
  const explicitMinor = Number(body?.bidAmountMinor ?? NaN);
  if (Number.isInteger(explicitMinor) && explicitMinor > 0) {
    return explicitMinor;
  }
  return null;
}

function hasLegacyBidUnitField(body: EntityActionBody | null) {
  return Boolean(
    body &&
      (Object.prototype.hasOwnProperty.call(body, "bidValue") ||
        Object.prototype.hasOwnProperty.call(body, "bidValueMinor")),
  );
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
    return jsonError(
      400,
      "invalid_bid_unit",
      hasLegacyBidUnitField(body)
        ? "bidAmountMinor is required; bidValue and bidValueMinor are not accepted for executable bid writes."
        : "bidAmountMinor must be a positive integer.",
    );
  }

  const prepared = await prepareEntityAction({
    request,
    body,
    scopeType: "adset",
    entityId: adsetId,
    action: "apply_bid",
  });
  if (!prepared.ok) return prepared.response;

  const accountContext = await getMetaAccountContext(
    prepared.businessId,
  ).catch(() => null);
  const bidCurrency = normalizeMetaCurrencyCode(
    accountContext?.accountProfiles[prepared.ctx.providerAccountId]?.currency,
  );
  if (!bidCurrency) {
    return jsonError(
      409,
      "currency_unavailable",
      "Meta account currency must be verified before applying a bid amount.",
    );
  }

  // Same rule as the status handler: the client may ask to rehearse and may
  // not decline to. A bid cap is money too.
  const dryRun = metaWriteIsRehearsal({
    posture: prepared.posture,
    requestedDryRun: dryRunFromBody(body),
  });

  const log = await createMetaAdsActionLog({
    businessId: prepared.businessId,
    // Same lineage, same reason: without it the applied bid is missing from
    // Meta History's Writes journal. See the status handler above.
    providerAccountId: prepared.ctx.providerAccountId,
    adId: prepared.target.entityId,
    creativeId: null,
    /*
      The true verb.

      This wrote `launch_adset` and carried the real operation down in
      `payload_request.operation`, so Meta History's Writes journal titled a
      verified cap change "Launch Adset | Broad prospecting" — a bid apply
      presented to the operator as a launch.

      `bid` is legal here AS OF THIS RELEASE, and only as of it. An earlier
      revision of this comment said it "has always been legal", citing
      `MetaAdsActionKind`, the `meta_ads_action_log_action_check` CHECK and the
      unattended sweep. None of the three holds against the build this release
      replaces: on `origin/main` the union in `lib/meta/ads-action-log.ts` has
      no `bid` member, the CHECK in `lib/migrations.ts` does not list it, and
      `lib/meta/scheduled-bid-runtime.ts` does not exist. All three arrive
      together in this release, which is why the CHECK widening it ships is
      load-bearing rather than tidying, and why that widening is the one
      statement in its group that must not fail silently.

      `operation: "apply_bid"` stays in the payload below, unchanged: every
      reader that disambiguated the old spelling by it keeps working, and the
      compatibility is proved in both directions rather than assumed, by two
      seam-guarded tests that both exist:
      `lib/meta/bid-history-verb-title.db.test.ts` runs the shipped title
      expression over an old-shaped row and a new-shaped row, and
      `lib/meta/bid-history-writes-journal.db.test.ts` reads both rows back
      through `readMetaHistoryJournal` against the migrated schema, which is
      what covers the join that decides whether a bid row reaches the journal
      at all.
    */
    action: "bid",
    source: META_ENTITY_MANUAL_ACTION_ORIGIN,
    requestedBy: prepared.requestedBy,
    recIdOrigin: recIdOriginFromBody(body),
    payloadRequest: {
      method: "POST",
      endpoint: `/${prepared.target.entityId}`,
      scope_type: "adset",
      operation: "apply_bid",
      body: { bid_amount: bidAmountMinor, currency: bidCurrency },
      dry_run: dryRun,
      dry_run_requested: dryRunFromBody(body),
      dry_run_source: prepared.posture.rehearsal ? "business_guardrail" : "request",
      rec_id_origin: recIdOriginFromBody(body),
      action_origin: META_ENTITY_MANUAL_ACTION_ORIGIN,
      manual_confirmation: META_ENTITY_MANUAL_CONFIRMATION,
    },
  });

  const startedAt = Date.now();
  try {
    const result = await updateAdsetBidAmount(prepared.ctx, {
      adsetId: prepared.target.entityId,
      bidAmountMinor,
      ...(dryRun
        ? { dryRun: true }
        : {
          beforeMutationAttempt: beforeEntityProviderPost({
            businessId: prepared.businessId,
            rehearsalAtEntry: prepared.posture.rehearsal,
          }),
        }),
    });
    if (!result.ok) {
      await completeFailure({ logId: log.id, startedAt, result });
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          metaHttpStatus: result.httpStatus,
          providerOutcome: result.providerOutcome ?? null,
          // The failure half of the same answer, for the same reason.
          ...metaWriteFailureAnswer({
            providerOutcome: result.providerOutcome,
            logId: log.id,
          }),
          mutationAttempt: result.mutationAttempt ?? null,
          retryAllowed:
            isProviderOutcomeAmbiguous(result) ||
            hasSuccessfulMetaProviderMutationAttempt(result)
              ? false
              : null,
        },
        { status: result.error.code === "kill_switch_engaged" ? 503 : 502 },
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
      dryRun: result.dryRun === true,
      wouldHaveWritten: result.wouldHaveWritten ?? null,
      /*
        The terminal answer, which this handler used to omit.

        The status handler returns it and the ceremony reads it
        (`mutation-ceremony-seed.ts`): an absent `outcome` is normalised to
        `provider_outcome_ambiguous`, deliberately, because inferring success
        from `ok: true` is the inference that guard exists to forbid. The
        consequence here was that a bid write which verified against its own
        read-back and settled `success` in the action log still told the
        operator "Outcome unknown · No receipt · do not retry" — a durable,
        verified write reported as unresolved. Derived from the row just
        written, exactly as the status handler derives it.
      */
      ...metaWriteTerminalAnswer({
        dryRun: result.dryRun === true,
        logStatus: "success",
        logId: log.id,
      }),
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
