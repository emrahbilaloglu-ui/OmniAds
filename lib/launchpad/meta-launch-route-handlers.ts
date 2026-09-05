/**
 * The Launchpad create routes' bodies, moved out of `app/` so a second
 * authority can enter them.
 *
 * `app/api/launchpad/meta/launch/route.ts` and its add-to-existing sibling used
 * to hold every gate and every step inline. Nothing but a browser POST could
 * reach them, so the Automation queue — which raises a `launch` row and asks an
 * operator to approve it — had nowhere to send that approval and answered
 * `unsupported_action`. The move mirrors `lib/meta/entity-action-routes.ts`,
 * which is the same fix for the pause family: one guarded handler, called by
 * the thin route and by the queue's executor, so a change to a gate changes
 * both callers at once.
 *
 * This is a move, not a rewrite. Every gate keeps its position and its reason,
 * and the two route files are now six lines each.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  hasRecentPendingMetaAddToExistingAction,
  hasRecentPendingMetaLaunchAction,
} from "@/lib/meta/ads-action-log";
import { preflightMetaLaunchCreatives } from "@/lib/meta/launch-write";
import type { MetaLaunchCreativePreflightCheck } from "@/lib/meta/launch-write";
import {
  metaWriteBlockedResponse,
  readMetaWritePosture,
} from "@/lib/meta/automation-write-guard";
import {
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
} from "@/lib/launchpad/meta";
import type { MetaAddToExistingCopyMode } from "@/lib/launchpad/meta";
import {
  buildMetaLaunchIntentErrorReceipt,
  buildMetaLaunchIntentValidationReceipt,
} from "@/lib/launchpad/meta-launch-intent";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";
import { prepareMetaLaunchIntentForExecution } from "@/lib/launchpad/meta-launch-intent-service";
import { getMetaLaunchIntentCapability } from "@/lib/launchpad/meta-launch-intent-capability";
import {
  recordMetaLaunchIntentPreExecutionFailure,
  recordMetaLaunchIntentValidation,
  recordMetaLaunchIntentWriteBlocked,
} from "@/lib/launchpad/meta-launch-intent-store";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
  resolveMetaLaunchWriteContext,
  validateMetaAddToExistingLiveProviderPreflight,
  validateMetaAddToExistingRequest,
  validateMetaLaunchRequest,
} from "@/lib/launchpad/meta-validation";
import {
  bindMetaLaunchpadManualAuthorityToPayload,
  evaluateMetaLaunchpadManualAuthority,
  metaLaunchpadActionLogAuthority,
} from "@/lib/launchpad/meta-manual-authority";
import { evaluateMetaLaunchpadExecutionBounds } from "@/lib/launchpad/meta-execution-bounds";
import { preflightAgeSeconds } from "@/lib/launchpad/validation-preflight-disclosure";
import {
  META_LAUNCHPAD_MANUAL_ACTION_LOG_ORIGIN,
  runMetaAddToExistingCreate,
  runMetaLaunchIntentCreate,
  type MetaLaunchExecutionOrigin,
} from "@/lib/launchpad/meta-launch-execution";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadExecutionGated,
  rejectIfLaunchpadMetaWritesBlocked,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "@/app/api/launchpad/meta/route-utils";
import { rejectIfLaunchpadDemoWrite } from "@/app/api/launchpad/meta/demo-write-authority";

/**
 * What a caller other than the browser may say about itself.
 *
 * Only the action log hears it. The intent's stored payload is the operator's
 * and is replayed untouched — see `meta-launch-execution.ts`.
 */
export type MetaLaunchHandlerOptions = Partial<
  Pick<MetaLaunchExecutionOrigin, "actionLogOrigin" | "requestedBy" | "beforeProviderMutation">
>;

type LaunchBody = {
  businessId?: string;
  providerAccountId?: string;
  payload?: unknown;
  actionOrigin?: string;
  manualConfirmation?: string;
  idempotencyKey?: string;
  launchIntentId?: string | null;
  sourceDraftId?: string | null;
};

type AddToExistingBody = {
  businessId?: string;
  providerAccountId?: string;
  targetCampaignId?: string;
  targetAdsetId?: string;
  targets?: Array<{
    targetCampaignId?: string;
    campaignId?: string;
    targetAdsetId?: string;
    adsetId?: string;
    targetCampaignName?: string | null;
    campaignName?: string | null;
    targetAdsetName?: string | null;
    adsetName?: string | null;
  }>;
  creativeIds?: string[];
  creatives?: Array<{
    creativeId?: string;
    id?: string;
    sourceAdId?: string | null;
    source_ad_id?: string | null;
    adId?: string | null;
    realAdId?: string | null;
    name?: string | null;
    nameOverride?: string | null;
  }>;
  names?: Record<string, string>;
  sourceAdIds?: Record<string, string>;
  copyMode?: MetaAddToExistingCopyMode;
  actionOrigin?: string;
  manualConfirmation?: string;
  idempotencyKey?: string;
  launchIntentId?: string | null;
  sourceDraftId?: string | null;
};

type NormalizedBodyTarget = {
  targetCampaignId: string;
  targetAdsetId: string;
  targetCampaignName: string | null;
  targetAdsetName: string | null;
};

function preflightChecksAsRecords(
  checks: MetaLaunchCreativePreflightCheck[],
): Array<Record<string, unknown>> {
  return checks.map((check) => ({
    ...check,
    error: check.error ? { ...check.error } : null,
  }));
}

function intentErrorResponse(input: {
  status: number;
  error: { code: string; message: string };
  intent?: { id: string; status: string };
}) {
  return NextResponse.json(
    {
      ok: false,
      error: input.error,
      launchIntentId: input.intent?.id ?? null,
      launchIntentStatus: input.intent?.status ?? null,
    },
    { status: input.status },
  );
}

function normalizeBodyTargets(body: AddToExistingBody | null) {
  const fromTargets = Array.isArray(body?.targets)
    ? body.targets
        .map((target) => ({
          targetCampaignId: (target.targetCampaignId ?? target.campaignId ?? "").trim(),
          targetAdsetId: (target.targetAdsetId ?? target.adsetId ?? "").trim(),
          targetCampaignName:
            (target.targetCampaignName ?? target.campaignName ?? "")?.trim() || null,
          targetAdsetName:
            (target.targetAdsetName ?? target.adsetName ?? "")?.trim() || null,
        }))
        .filter((target) => target.targetCampaignId || target.targetAdsetId)
    : [];
  const fallbackTarget: NormalizedBodyTarget = {
    targetCampaignId: body?.targetCampaignId?.trim() ?? "",
    targetAdsetId: body?.targetAdsetId?.trim() ?? "",
    targetCampaignName: null,
    targetAdsetName: null,
  };
  const targets = fromTargets.length > 0 ? fromTargets : [fallbackTarget];
  const byPair = new Map<string, NormalizedBodyTarget>();
  targets.forEach((target) => {
    if (!target.targetCampaignId && !target.targetAdsetId) return;
    byPair.set(`${target.targetCampaignId}:${target.targetAdsetId}`, target);
  });
  return Array.from(byPair.values());
}

export async function handleMetaLaunchAction(
  request: NextRequest,
  options: MetaLaunchHandlerOptions = {},
) {
  const body = await readJsonBody<LaunchBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_launch");
  if (reviewerBlocked) return reviewerBlocked;
  // Canonical invariant: "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." The reviewer gate above does
  // not cover this — `/api/auth/demo-login` opens a session as an ADMIN of the
  // demo business under a non-reviewer email, so it passes both the role check
  // and the reviewer check. The refusal has to live on the server or it does
  // not exist.
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_launch",
  );
  if (demoBlocked) return demoBlocked;
  /**
   * The execution gate, enforced on the server rather than trusted from the
   * screen. `docs/adr-003-launchpad-execution-posture.md` puts the shipped
   * state at disabled-with-reason; the review screen renders that refusal, but
   * a stale tab, a replayed request or a script never sees the screen. It sits
   * after the viewer checks so the most specific true reason is returned first,
   * and before every provider-facing step below — no account resolution, no
   * credential read, no Meta call happens while the gate is closed.
   */
  const executionGated = rejectIfLaunchpadExecutionGated("launchpad_launch");
  if (executionGated) return executionGated;
  /**
   * The Meta Stop, which this route did not consult.
   *
   * Decisions and Automation both gate on `getMetaWriteBlockState`; Launchpad
   * did not, so an engaged business kill switch — or an incident responder
   * setting META_ADS_WRITE_KILL_SWITCH — stopped every Meta write except a
   * Launchpad create. A stop that is global in the operator's mind and partial
   * in fact is the worst thing a safety control can be. §10 step 8.
   *
   * After the execution gate, which is the cheaper refusal and costs no
   * database read.
   */
  const metaWritesBlocked = await rejectIfLaunchpadMetaWritesBlocked(
    access.businessId,
    "launchpad_launch",
  );
  if (metaWritesBlocked) return metaWritesBlocked;
  const manualAuthority = evaluateMetaLaunchpadManualAuthority(body);
  if (!manualAuthority.ok) {
    return jsonError(
      manualAuthority.status,
      manualAuthority.error.code,
      manualAuthority.error.message,
    );
  }
  const authority = manualAuthority.authority;
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }

  const normalizedPayload = normalizeMetaLaunchPayload(body?.payload);
  const executionBounds = evaluateMetaLaunchpadExecutionBounds({
    operation: "new_campaign",
    creativeCount: normalizedPayload.creativeIds.length,
    adSetOrTargetCount: normalizedPayload.adSets.length,
  });
  if (!executionBounds.ok) {
    const firstBlocker = executionBounds.blockers[0]!;
    return NextResponse.json(
      {
        ok: false,
        error: firstBlocker,
        blockers: executionBounds.blockers,
        counts: executionBounds.counts,
      },
      { status: 413 },
    );
  }

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: body?.providerAccountId,
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }
  const providerAccountId = account.providerAccountId;
  const intentCapability = await getMetaLaunchIntentCapability();
  if (!intentCapability.canWrite) {
    return intentErrorResponse({
      status: 503,
      error: {
        code: "launch_intent_migration_required",
        message:
          "LaunchIntent storage is unavailable until the pending database migration is applied.",
      },
    });
  }
  const intentRequestPayload = bindMetaLaunchpadManualAuthorityToPayload(
    normalizedPayload,
    authority,
  );
  const prepared = await prepareMetaLaunchIntentForExecution({
    businessId: access.businessId,
    providerAccountId,
    operation: "new_campaign",
    idempotencyKey,
    requestPayload: intentRequestPayload,
    launchIntentId: body?.launchIntentId,
    sourceDraftId: body?.sourceDraftId,
    createdBy: access.userId,
  }).catch((error) => ({
    ok: false as const,
    status: error instanceof MetaLaunchIntentLineageError ? 422 : 500,
    intent: undefined,
    error: {
      code:
        error instanceof MetaLaunchIntentLineageError
          ? error.code
          : "launch_intent_prepare_failed",
      message:
        error instanceof MetaLaunchIntentLineageError
          ? error.message
          : sanitizeErrorMessage(error),
    },
  }));
  if (!prepared.ok) {
    return intentErrorResponse({
      status: prepared.status,
      error: prepared.error,
      intent: prepared.intent,
    });
  }
  const launchIntentId = prepared.intent.id;
  const requestFingerprint = prepared.intent.requestFingerprint;
  const receiptBinding = {
    executionAuthority: authority,
    requestFingerprint,
  } as const;
  const actionLogAuthority = metaLaunchpadActionLogAuthority({
    authority,
    requestFingerprint,
  });

  /*
    Rehearsal REFUSES a create, rather than pretending to do one.

    Every other write family can rehearse: the primitive verifies the entity
    and reports what it would have written. There is no such thing for a
    create — `launch-write.ts` has no dry-run path, because a campaign that was
    not created has no id to read back. So a business in rehearsal is refused
    here, through the SAME receipt path a block already takes, instead of being
    handed a receipt for entities that do not exist.
  */
  const posture = await readMetaWritePosture({ businessId: access.businessId });
  const blocked = posture.blocked
    ? metaWriteBlockedResponse(posture)
    : posture.rehearsal
      ? jsonError(
        409,
        "dry_run_guardrail",
        "This business is in rehearsal, so nothing was created on Meta.",
      )
      : null;
  if (blocked) {
    const receipt = buildMetaLaunchIntentErrorReceipt({
      ...receiptBinding,
      providerAccountId,
      code: "kill_switch_engaged",
      message: "Meta writes are disabled by kill switch.",
      failedAt: "write_guard",
    });
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt,
    });
    const payload = (await blocked.clone().json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return NextResponse.json(
      {
        ...payload,
        launchIntentId,
        launchIntentStatus: intent.status,
      },
      { status: blocked.status },
    );
  }

  const inFlight = await hasRecentPendingMetaLaunchAction({
    businessId: access.businessId,
    idempotencyKey,
    sinceSeconds: 30,
  });
  if (inFlight) {
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "launch_in_flight",
        message: "A Meta launch with this idempotency key is already pending.",
        failedAt: "idempotency_guard",
      }),
    });
    return intentErrorResponse({
      status: 409,
      error: {
        code: "launch_in_flight",
        message: "A Meta launch with this idempotency key is already pending.",
      },
      intent,
    });
  }

  let validation: Awaited<ReturnType<typeof validateMetaLaunchRequest>>;
  try {
    validation = await validateMetaLaunchRequest({
      businessId: access.businessId,
      providerAccountId,
      payload: normalizedPayload,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const intent = await recordMetaLaunchIntentPreExecutionFailure({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "launch_validation_failed",
        message,
        failedAt: "validation",
      }),
    });
    return intentErrorResponse({
      status: 500,
      error: { code: "launch_validation_failed", message },
      intent,
    });
  }
  if (!validation.ok) {
    const validatedIntent = await recordMetaLaunchIntentValidation({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentValidationReceipt({
        ...receiptBinding,
        providerAccountId,
        ok: false,
        blockers: validation.blockers,
        warnings: validation.warnings,
      }),
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "validation_blocked",
          message: "Launch validation failed.",
        },
        blockers: validation.blockers,
        warnings: validation.warnings,
        launchIntentId,
        launchIntentStatus: validatedIntent.status,
      },
      { status: 400 },
    );
  }

  const ctxResult = await resolveMetaLaunchWriteContext(
    access.businessId,
    providerAccountId,
  );
  if (!ctxResult.ok) {
    await recordMetaLaunchIntentValidation({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentValidationReceipt({
        ...receiptBinding,
        providerAccountId,
        ok: true,
        blockers: [],
        warnings: validation.warnings,
      }),
    });
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: ctxResult.blocker.code,
        message: ctxResult.blocker.message,
        failedAt: "write_context",
      }),
    });
    return NextResponse.json(
      {
        ok: false,
        error: ctxResult.blocker,
        launchIntentId,
        launchIntentStatus: intent.status,
      },
      { status: 502 },
    );
  }

  const ctx = ctxResult.ctx;
  const payload = validation.payload;
  let creativePreflight: Awaited<
    ReturnType<typeof preflightMetaLaunchCreatives>
  >;
  try {
    creativePreflight = await preflightMetaLaunchCreatives(
      ctx,
      payload.creativeIds,
    );
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const checks: Array<Record<string, unknown>> = [
      {
        kind: "creative_identity_batch",
        requestedProviderAccountId: providerAccountId,
        requestedCreativeIds: payload.creativeIds,
        ok: false,
        checkedAt: new Date().toISOString(),
        error: {
          code: "creative_preflight_failed",
          message,
        },
      },
    ];
    const blockers = [
      {
        code: "creative_preflight_failed",
        message:
          "Fresh Meta creative identity validation failed before any provider create request.",
      },
    ];
    const errorReceipt = buildMetaLaunchIntentErrorReceipt({
      ...receiptBinding,
      providerAccountId,
      code: "creative_preflight_failed",
      message,
      failedAt: "creative_preflight",
      checks,
    });
    const intent = await recordMetaLaunchIntentValidation({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentValidationReceipt({
        ...receiptBinding,
        providerAccountId,
        ok: false,
        blockers,
        warnings: validation.warnings,
        checks,
      }),
      errorReceipt,
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "creative_preflight_failed",
          message:
            "Fresh Meta creative identity validation failed before any provider create request.",
        },
        blockers,
        warnings: validation.warnings,
        checks,
        launchIntentId,
        launchIntentStatus: intent.status,
      },
      { status: 502 },
    );
  }
  const preflightChecks = preflightChecksAsRecords(creativePreflight.checks);
  const preflightBlockers = creativePreflight.checks
    .filter((check) => !check.ok)
    .map((check) => ({
      code: check.error?.code ?? "creative_preflight_failed",
      message: `${check.requestedCreativeId}: ${
        check.error?.message ??
        "The selected Meta creative identity could not be proven."
      }`,
    }));
  const preflightErrorReceipt = creativePreflight.ok
    ? null
    : buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "creative_preflight_blocked",
        message:
          "Fresh Meta creative identity validation blocked the launch before any provider create request.",
        failedAt: "creative_preflight",
        checks: preflightChecks,
      });
  const validatedIntent = await recordMetaLaunchIntentValidation({
    businessId: access.businessId,
    id: launchIntentId,
    receipt: buildMetaLaunchIntentValidationReceipt({
      ...receiptBinding,
      providerAccountId,
      ok: creativePreflight.ok,
      blockers: preflightBlockers,
      warnings: validation.warnings,
      checks: preflightChecks,
      checkedAt: creativePreflight.checkedAt,
    }),
    errorReceipt: preflightErrorReceipt,
  });
  if (!creativePreflight.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "creative_preflight_blocked",
          message:
            "Fresh Meta creative identity validation blocked the launch before any provider create request.",
        },
        blockers: preflightBlockers,
        warnings: validation.warnings,
        checks: preflightChecks,
        launchIntentId,
        launchIntentStatus: validatedIntent.status,
      },
      { status: 400 },
    );
  }

  const actionLogPreflightProof = {
    creative_preflight_provider_account_id: creativePreflight.providerAccountId,
    creative_preflight_checked_at: creativePreflight.checkedAt,
    creative_preflight_checks: preflightChecks,
  } as const;
  /**
   * The preflight's own age, disclosed rather than assumed (§10 step 10).
   *
   * It is near zero here by construction — this route re-runs the fresh
   * creative read itself rather than trusting a validation the operator ran
   * earlier — and that is exactly the fact worth stating. Without it the
   * receipt records a `checkedAt` nobody reads, and a reader cannot tell a
   * proof taken seconds before the create from one carried over from an
   * arbitrarily old validation.
   *
   * `null` when the timestamp is unreadable, never 0: zero means "checked this
   * instant", which is the most misleading value to invent for something we
   * could not read.
   */
  const preflightDisclosure = {
    checkedAt: creativePreflight.checkedAt,
    ageSeconds: preflightAgeSeconds(creativePreflight.checkedAt),
    creativeIdentityVerified: true,
    providerAccountId: creativePreflight.providerAccountId,
  } as const;

  const outcome = await runMetaLaunchIntentCreate({
    businessId: access.businessId,
    launchIntentId,
    providerAccountId,
    idempotencyKey,
    ctx,
    payload,
    executionAuthority: authority,
    requestFingerprint,
    actionLogAuthority,
    actionLogPreflightProof,
    preflightChecks,
    preflightDisclosure,
    sanitizeError: sanitizeErrorMessage,
    actionLogOrigin:
      options.actionLogOrigin ?? META_LAUNCHPAD_MANUAL_ACTION_LOG_ORIGIN,
    requestedBy:
      options.requestedBy === undefined ? access.userId : options.requestedBy,
    beforeProviderMutation: options.beforeProviderMutation,
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}

export async function handleMetaAddToExistingAction(
  request: NextRequest,
  options: MetaLaunchHandlerOptions = {},
) {
  const body = await readJsonBody<AddToExistingBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const requestedTargets = normalizeBodyTargets(body);
  const firstRequestedTarget = requestedTargets[0] ?? null;
  const targetCampaignId = firstRequestedTarget?.targetCampaignId ?? "";
  const targetAdsetId = firstRequestedTarget?.targetAdsetId ?? "";
  const copyMode: MetaAddToExistingCopyMode =
    body?.copyMode === "reuse_creative" ? "reuse_creative" : "rebuild_creative";
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";

  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_add_to_existing");
  if (reviewerBlocked) return reviewerBlocked;
  // Canonical invariant: "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." The reviewer gate above does
  // not cover this — `/api/auth/demo-login` opens a session as an ADMIN of the
  // demo business under a non-reviewer email, so it passes both the role check
  // and the reviewer check. The refusal has to live on the server or it does
  // not exist.
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_add_to_existing",
  );
  if (demoBlocked) return demoBlocked;
  /**
   * The execution gate, enforced on the server rather than trusted from the
   * screen. `docs/adr-003-launchpad-execution-posture.md` puts the shipped
   * state at disabled-with-reason; the review screen renders that refusal, but
   * a stale tab, a replayed request or a script never sees the screen. It sits
   * after the viewer checks so the most specific true reason is returned first,
   * and before every provider-facing step below — no account resolution, no
   * credential read, no Meta call happens while the gate is closed.
   */
  const executionGated = rejectIfLaunchpadExecutionGated("launchpad_add_to_existing");
  if (executionGated) return executionGated;
  /**
   * The Meta Stop, which this route did not consult.
   *
   * Decisions and Automation both gate on `getMetaWriteBlockState`; Launchpad
   * did not, so an engaged business kill switch — or an incident responder
   * setting META_ADS_WRITE_KILL_SWITCH — stopped every Meta write except a
   * Launchpad create. A stop that is global in the operator's mind and partial
   * in fact is the worst thing a safety control can be. §10 step 8.
   *
   * After the execution gate, which is the cheaper refusal and costs no
   * database read.
   */
  const metaWritesBlocked = await rejectIfLaunchpadMetaWritesBlocked(
    access.businessId,
    "launchpad_add_to_existing",
  );
  if (metaWritesBlocked) return metaWritesBlocked;
  const manualAuthority = evaluateMetaLaunchpadManualAuthority(body);
  if (!manualAuthority.ok) {
    return jsonError(
      manualAuthority.status,
      manualAuthority.error.code,
      manualAuthority.error.message,
    );
  }
  const authority = manualAuthority.authority;
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }
  if (requestedTargets.length === 0 || requestedTargets.some((target) => !target.targetAdsetId)) {
    return jsonError(400, "target_adset_required", "At least one target ad set is required.");
  }
  if (copyMode !== "reuse_creative") {
    return jsonError(
      409,
      "rebuild_creative_receipt_contract_required",
      "Recreate exact ad is review-only until every provider image, creative, and ad write has a durable step receipt.",
    );
  }

  const normalizedPayload = normalizeMetaAddToExistingPayload({
    mode: "add_to_existing",
    targetCampaignId,
    targetAdsetId,
    copyMode,
    targets: requestedTargets,
    creativeIds: body?.creativeIds ?? [],
    creatives: body?.creatives ?? [],
    names: body?.names ?? {},
    sourceAdIds: body?.sourceAdIds ?? {},
  });
  const executionBounds = evaluateMetaLaunchpadExecutionBounds({
    operation: "add_to_existing",
    creativeCount: normalizedPayload.creativeIds.length,
    adSetOrTargetCount: normalizedPayload.targets.length,
    copyMode: normalizedPayload.copyMode,
  });
  if (!executionBounds.ok) {
    const blocker = executionBounds.blockers[0]!;
    return NextResponse.json(
      {
        ok: false,
        error: blocker,
        blockers: executionBounds.blockers,
        counts: executionBounds.counts,
      },
      { status: 413 },
    );
  }

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: body?.providerAccountId,
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }
  const providerAccountId = account.providerAccountId;
  const intentCapability = await getMetaLaunchIntentCapability();
  if (!intentCapability.canWrite) {
    return intentErrorResponse({
      status: 503,
      error: {
        code: "launch_intent_migration_required",
        message:
          "LaunchIntent storage is unavailable until the pending database migration is applied.",
      },
    });
  }
  const intentRequestPayload = bindMetaLaunchpadManualAuthorityToPayload(
    normalizedPayload,
    authority,
  );
  const prepared = await prepareMetaLaunchIntentForExecution({
    businessId: access.businessId,
    providerAccountId,
    operation: "add_to_existing",
    idempotencyKey,
    requestPayload: intentRequestPayload,
    launchIntentId: body?.launchIntentId,
    sourceDraftId: body?.sourceDraftId,
    createdBy: access.userId,
  }).catch((error) => ({
    ok: false as const,
    status: error instanceof MetaLaunchIntentLineageError ? 422 : 500,
    intent: undefined,
    error: {
      code:
        error instanceof MetaLaunchIntentLineageError
          ? error.code
          : "launch_intent_prepare_failed",
      message:
        error instanceof MetaLaunchIntentLineageError
          ? error.message
          : sanitizeErrorMessage(error),
    },
  }));
  if (!prepared.ok) {
    return intentErrorResponse({
      status: prepared.status,
      error: prepared.error,
      intent: prepared.intent,
    });
  }
  const launchIntentId = prepared.intent.id;
  const requestFingerprint = prepared.intent.requestFingerprint;
  const receiptBinding = {
    executionAuthority: authority,
    requestFingerprint,
  } as const;
  const actionLogAuthority = metaLaunchpadActionLogAuthority({
    authority,
    requestFingerprint,
  });

  /*
    Rehearsal REFUSES a create, rather than pretending to do one.

    Every other write family can rehearse: the primitive verifies the entity
    and reports what it would have written. There is no such thing for a
    create — `launch-write.ts` has no dry-run path, because a campaign that was
    not created has no id to read back. So a business in rehearsal is refused
    here, through the SAME receipt path a block already takes, instead of being
    handed a receipt for entities that do not exist.
  */
  const posture = await readMetaWritePosture({ businessId: access.businessId });
  const blocked = posture.blocked
    ? metaWriteBlockedResponse(posture)
    : posture.rehearsal
      ? jsonError(
        409,
        "dry_run_guardrail",
        "This business is in rehearsal, so nothing was created on Meta.",
      )
      : null;
  if (blocked) {
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "kill_switch_engaged",
        message: "Meta writes are disabled by kill switch.",
        failedAt: "write_guard",
      }),
    });
    const payload = (await blocked.clone().json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return NextResponse.json(
      { ...payload, launchIntentId, launchIntentStatus: intent.status },
      { status: blocked.status },
    );
  }

  const inFlightChecks = await Promise.all(
    requestedTargets.map((target) =>
      hasRecentPendingMetaAddToExistingAction({
        businessId: access.businessId,
        idempotencyKey,
        targetAdsetId: target.targetAdsetId,
        sinceSeconds: 30,
      }),
    ),
  );
  if (inFlightChecks.some(Boolean)) {
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "launch_in_flight",
        message:
          "A Meta add-to-existing launch with this idempotency key is already pending for one of these ad sets.",
        failedAt: "idempotency_guard",
      }),
    });
    return intentErrorResponse({
      status: 409,
      error: {
        code: "launch_in_flight",
        message:
          "A Meta add-to-existing launch with this idempotency key is already pending for one of these ad sets.",
      },
      intent,
    });
  }

  let validation: Awaited<ReturnType<typeof validateMetaAddToExistingRequest>>;
  try {
    validation = await validateMetaAddToExistingRequest({
      businessId: access.businessId,
      providerAccountId,
      payload: normalizedPayload,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const intent = await recordMetaLaunchIntentPreExecutionFailure({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "launch_validation_failed",
        message,
        failedAt: "validation",
      }),
    });
    return intentErrorResponse({
      status: 500,
      error: { code: "launch_validation_failed", message },
      intent,
    });
  }
  if (!validation.ok) {
    const validatedIntent = await recordMetaLaunchIntentValidation({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentValidationReceipt({
        ...receiptBinding,
        providerAccountId,
        ok: false,
        blockers: validation.blockers,
        warnings: validation.warnings,
      }),
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "validation_blocked",
          message: "Launch validation failed.",
        },
        blockers: validation.blockers,
        warnings: validation.warnings,
        launchIntentId,
        launchIntentStatus: validatedIntent.status,
      },
      { status: 400 },
    );
  }

  const ctxResult = await resolveMetaLaunchWriteContext(
    access.businessId,
    providerAccountId,
  );
  if (!ctxResult.ok) {
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: ctxResult.blocker.code,
        message: ctxResult.blocker.message,
        failedAt: "write_context",
      }),
    });
    return NextResponse.json(
      {
        ok: false,
        error: ctxResult.blocker,
        launchIntentId,
        launchIntentStatus: intent.status,
      },
      { status: 502 },
    );
  }

  let livePreflight: Awaited<
    ReturnType<typeof validateMetaAddToExistingLiveProviderPreflight>
  >;
  try {
    livePreflight = await validateMetaAddToExistingLiveProviderPreflight({
      ctx: ctxResult.ctx,
      payload: validation.payload,
    });
  } catch (error) {
    livePreflight = {
      ok: false,
      blockers: [
        {
          code: "provider_preflight_unavailable",
          message: sanitizeErrorMessage(error),
        },
      ],
      checks: [],
    };
  }
  const validatedIntent = await recordMetaLaunchIntentValidation({
    businessId: access.businessId,
    id: launchIntentId,
    receipt: buildMetaLaunchIntentValidationReceipt({
      ...receiptBinding,
      providerAccountId,
      ok: livePreflight.ok,
      blockers: livePreflight.blockers,
      warnings: validation.warnings,
      checks: livePreflight.checks,
    }),
  });
  if (!livePreflight.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "provider_preflight_blocked",
          message:
            "Fresh Meta source and target hierarchy verification blocked this launch.",
        },
        blockers: livePreflight.blockers,
        warnings: validation.warnings,
        launchIntentId,
        launchIntentStatus: validatedIntent.status,
      },
      { status: 409 },
    );
  }

  const outcome = await runMetaAddToExistingCreate({
    businessId: access.businessId,
    launchIntentId,
    providerAccountId,
    idempotencyKey,
    ctx: ctxResult.ctx,
    payload: validation.payload,
    validationTargets: validation.targets,
    validationCreatives: validation.creatives,
    nameOverrides: body?.names ?? {},
    copyMode,
    livePreflightChecks: livePreflight.checks,
    targetCampaignId,
    targetAdsetId,
    executionAuthority: authority,
    requestFingerprint,
    actionLogAuthority,
    sanitizeError: sanitizeErrorMessage,
    actionLogOrigin:
      options.actionLogOrigin ?? META_LAUNCHPAD_MANUAL_ACTION_LOG_ORIGIN,
    requestedBy:
      options.requestedBy === undefined ? access.userId : options.requestedBy,
    beforeProviderMutation: options.beforeProviderMutation,
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
