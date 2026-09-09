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
 * and each route file is now an import, the `dynamic` export and a POST that
 * forwards the request.
 *
 * Which is why the pre-POST boundary is composed HERE rather than left to the
 * caller: a route that forwards a request and nothing else can pass no options,
 * and until `mandatoryProviderMutationBoundary` below existed that meant the
 * operator's own create had no approval-standing check between one provider
 * POST and the next.
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
  type MetaWritePosture,
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
import type { MetaLaunchIntentLineage } from "@/lib/launchpad/meta-launch-intent";
import {
  MetaLaunchIntentLineageError,
  readMetaLaunchIntentApprovalStanding,
} from "@/lib/launchpad/meta-launch-intent-lineage";
import { prepareMetaLaunchIntentForExecution } from "@/lib/launchpad/meta-launch-intent-service";
import { getMetaLaunchIntentCapability } from "@/lib/launchpad/meta-launch-intent-capability";
import {
  getMetaLaunchIntent,
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
  bindMetaLaunchExecutionAuthorityToPayload,
  evaluateMetaLaunchpadManualAuthority,
  metaLaunchpadActionLogAuthority,
  readMetaLaunchExecutionAuthority,
  type MetaLaunchExecutionAuthority,
  type MetaLaunchpadOperatorAuthority,
} from "@/lib/launchpad/meta-manual-authority";
import { evaluateMetaLaunchpadExecutionBounds } from "@/lib/launchpad/meta-execution-bounds";
import { preflightAgeSeconds } from "@/lib/launchpad/validation-preflight-disclosure";
import {
  META_LAUNCHPAD_MANUAL_ACTION_LOG_ORIGIN,
  runMetaAddToExistingCreate,
  runMetaLaunchIntentCreate,
  type MetaLaunchExecutionOrigin,
  type MetaLaunchProviderMutationVerdict,
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
 *
 * `beforeProviderMutation` is an ADDITIONAL requirement, never the boundary
 * itself: `mandatoryProviderMutationBoundary` below composes it behind the
 * approval-standing read that every create gets, whether or not its caller
 * brought a hook. A caller that omits it (both route files do) still gets the
 * standing check.
 */
export type MetaLaunchHandlerOptions = Partial<
  Pick<MetaLaunchExecutionOrigin, "actionLogOrigin" | "requestedBy" | "beforeProviderMutation">
>;

/**
 * The pre-POST boundary every create through this handler gets.
 *
 * ## The defect
 *
 * `beforeProviderMutation` used to be forwarded exactly as the caller supplied
 * it, and `askProviderMutationBoundary` answers `allowed` for an absent hook.
 * The two route files call these handlers with no options at all, so on the
 * OPERATOR's own path — the one a person uses from Launchpad — the campaign
 * POST, the ad set POST and every ad POST below ran under an approval read once
 * in `prepareMetaLaunchIntentForExecution`, before the write context, the
 * validation and a live provider preflight. Reproduced at the real endpoint: a
 * brief withdrawn the instant the campaign create was answered still produced
 * `<campaign>/adsets` and `<adset>/ads`. The scheduled runtime and the queue arm
 * had each been given this check; the direct routes never had one.
 *
 * ## What is composed, and in which order
 *
 * The standing read runs FIRST and the caller's own hook second. That ordering
 * is not arbitrary: the queue's hook is a write-ahead dispatch MARKER, and a
 * withdrawn approval must not leave durable dispatch intent for a call that
 * will not be made. `automation-proposal-execution.ts` orders its own pair the
 * same way for the same reason.
 *
 * The queue arm therefore asks standing twice per POST — once in its own hook,
 * once here. That is deliberate, and it is the cheaper mistake of the two: for
 * a brief-bound intent each ask is one `SELECT … WHERE id = $3 LIMIT 1` against
 * `meta_creative_briefs`, and for an intent with no staged lineage it is no
 * query at all. Asking zero times is the defect this closes, and the queue's
 * own read must not become dependent on this handler continuing to compose one.
 * Both asks read the same current rows, so neither can answer `stands` for a
 * withdrawal the other would catch.
 *
 * ## The intents this is a no-op for
 *
 * An intent binding neither a brief nor a decision snapshot was composed and
 * confirmed on the Launchpad screen. There is no staged approval for a later
 * edit to withdraw, so `readMetaLaunchIntentApprovalStanding` answers `stands`
 * for it without a read — see its own docstring, which establishes why. This
 * wrapper adds no rule of its own: refusing those launches for want of an
 * approval that was never staged would blank every healthy operator create.
 */
function mandatoryProviderMutationBoundary(input: {
  businessId: string;
  providerAccountId: string;
  lineage: MetaLaunchIntentLineage;
  callerBoundary: (() => Promise<MetaLaunchProviderMutationVerdict>) | undefined;
}): () => Promise<MetaLaunchProviderMutationVerdict> {
  return async () => {
    const standing = await readMetaLaunchIntentApprovalStanding({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      lineage: input.lineage,
    });
    // The code, not the message: it is what the durable receipt quotes as
    // `withheldReason`, and what an operator reading a half-built launch needs
    // in order to tell a withdrawn approval from a gate somebody closed.
    if (!standing.stands) return { allowed: false, reason: standing.code };
    if (!input.callerBoundary) return true;
    return input.callerBoundary();
  };
}

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

/**
 * The authority the request fingerprint must be taken over.
 *
 * The operator's own confirmation is still required and still checked: this
 * runs AFTER `evaluateMetaLaunchpadManualAuthority` has refused any body that
 * is not exactly `{launchpad_manual_v1, explicit_operator_confirmation}`. What
 * it answers is a different question — which authority the payload was STAGED
 * under, because that is the value inside the stored fingerprint.
 *
 * This used to bind the operator's authority unconditionally, which was
 * correct while the Launchpad wizard was the only thing that ever wrote an
 * intent. It is not correct for a producer-staged one: the decision producer
 * stages under `launchpad_decision_staged_v1`, so re-binding the operator pair
 * recomputes a DIFFERENT fingerprint and
 * `prepareMetaLaunchIntentForExecution` refuses the whole approval as
 * `launch_intent_contract_mismatch`. (Verified: the two payloads hash to
 * 6ebfceeb… and 47d7b3c0…) Reading the stored value and replaying it is the
 * only way an operator can approve a launch they did not compose themselves.
 *
 * It cannot be used to smuggle an authority in. The value is read from the
 * PERSISTED intent, never from the request, and only the two exact pairs are
 * recognised — anything else falls back to the operator's own authority and
 * the existing mismatch refusal does its job.
 */
async function bindingLaunchExecutionAuthority(input: {
  businessId: string;
  launchIntentId: string | null | undefined;
  operatorAuthority: MetaLaunchpadOperatorAuthority;
}): Promise<MetaLaunchExecutionAuthority> {
  const id = input.launchIntentId?.trim() ?? "";
  if (!id) return input.operatorAuthority;
  const intent = await getMetaLaunchIntent({
    businessId: input.businessId,
    id,
  }).catch(() => null);
  if (!intent) return input.operatorAuthority;
  const stored =
    intent.requestPayload
    && typeof intent.requestPayload === "object"
    && !Array.isArray(intent.requestPayload)
      ? (intent.requestPayload as Record<string, unknown>).executionAuthority
      : null;
  return readMetaLaunchExecutionAuthority(stored) ?? input.operatorAuthority;
}

/**
 * The refusal a rehearsing business gets from a create, named once.
 *
 * A create cannot rehearse — `launch-write.ts` has no dry-run path — so a
 * rehearsing posture is refused rather than pretended. Both handlers return
 * this AND file it on the intent, and those two had drifted apart, so the
 * strings live in one place now.
 */
const META_LAUNCH_REHEARSAL_REFUSAL = {
  code: "dry_run_guardrail",
  message: "This business is in rehearsal, so nothing was created on Meta.",
} as const;

/**
 * What the write-guard refusal above actually said, for the durable receipt.
 *
 * Both create handlers recorded the literal `kill_switch_engaged` here no
 * matter which posture refused, and then transitioned the intent to
 * `write_blocked` permanently. A business in rehearsal was answered
 * `dry_run_guardrail` on the wire and filed as a kill switch nobody had
 * engaged; so was a closed release capability, a demo business and a read-only
 * readiness tier, now that `metaWriteBlockedResponse` names the posture that
 * refused. The receipt is the only record a later receipt/history reader has
 * of why the launch stopped, so it may not name a different posture than the
 * response did.
 *
 * It reads the envelope that is about to be returned rather than re-deriving a
 * code from `posture.reason`: the posture -> code mapping lives in
 * `lib/meta/automation-write-guard.ts` (where `business_kill_switch` keeps the
 * historical `kill_switch_engaged`, because four callers halt a sequence on
 * that string), and a second copy of that mapping here is exactly how the
 * receipt and the response would drift apart again. The fallback is for an
 * unreadable envelope only, and still names the posture that was read instead
 * of inventing a kill switch.
 */
function metaLaunchWriteRefusalReason(input: {
  posture: MetaWritePosture;
  payload: Record<string, unknown>;
}): { code: string; message: string } {
  const fallback = input.posture.blocked
    ? {
      code: input.posture.reason ?? "kill_switch_engaged",
      message:
        input.posture.message ?? "Meta writes are blocked for this business.",
    }
    : META_LAUNCH_REHEARSAL_REFUSAL;
  const error = (input.payload as {
    error?: { code?: unknown; message?: unknown };
  }).error;
  return {
    code:
      typeof error?.code === "string" && error.code.length > 0
        ? error.code
        : fallback.code,
    message:
      typeof error?.message === "string" && error.message.length > 0
        ? error.message
        : fallback.message,
  };
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
  const boundAuthority = await bindingLaunchExecutionAuthority({
    businessId: access.businessId,
    launchIntentId: body?.launchIntentId,
    operatorAuthority: authority,
  });
  const intentRequestPayload = bindMetaLaunchExecutionAuthorityToPayload(
    normalizedPayload,
    boundAuthority,
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
    /*
      The payload's OWN authority, so the durable receipt says what was
      approved rather than who pressed the button — the action log below says
      that, and says it separately.
    */
    executionAuthority: boundAuthority,
    requestFingerprint,
  } as const;
  const actionLogAuthority = metaLaunchpadActionLogAuthority({
    // This attempt's authority: a person confirmed it, and that is true even
    // when the payload they confirmed was staged for them by a decision.
    authority,
    requestFingerprint,
    stagedAuthority: boundAuthority,
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
        META_LAUNCH_REHEARSAL_REFUSAL.code,
        META_LAUNCH_REHEARSAL_REFUSAL.message,
      )
      : null;
  if (blocked) {
    // Read the refusal BEFORE the receipt is built: the two have to name the
    // same posture, and this one is the durable half.
    const payload = (await blocked.clone().json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const refusal = metaLaunchWriteRefusalReason({ posture, payload });
    const receipt = buildMetaLaunchIntentErrorReceipt({
      ...receiptBinding,
      providerAccountId,
      code: refusal.code,
      message: refusal.message,
      failedAt: "write_guard",
    });
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt,
    });
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
    // The payload's own authority, matching every receipt written above it.
    executionAuthority: boundAuthority,
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
    // Mandatory, and the caller's own hook is composed behind it.
    beforeProviderMutation: mandatoryProviderMutationBoundary({
      businessId: access.businessId,
      providerAccountId,
      lineage: prepared.intent.lineage,
      callerBoundary: options.beforeProviderMutation,
    }),
  });
  return NextResponse.json(
    {
      ...outcome.body,
      providerMutationAttempted: outcome.providerMutationAttempted,
    },
    { status: outcome.status },
  );
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
  const boundAuthority = await bindingLaunchExecutionAuthority({
    businessId: access.businessId,
    launchIntentId: body?.launchIntentId,
    operatorAuthority: authority,
  });
  const intentRequestPayload = bindMetaLaunchExecutionAuthorityToPayload(
    normalizedPayload,
    boundAuthority,
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
    /*
      The payload's OWN authority, so the durable receipt says what was
      approved rather than who pressed the button — the action log below says
      that, and says it separately.
    */
    executionAuthority: boundAuthority,
    requestFingerprint,
  } as const;
  const actionLogAuthority = metaLaunchpadActionLogAuthority({
    // This attempt's authority: a person confirmed it, and that is true even
    // when the payload they confirmed was staged for them by a decision.
    authority,
    requestFingerprint,
    stagedAuthority: boundAuthority,
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
        META_LAUNCH_REHEARSAL_REFUSAL.code,
        META_LAUNCH_REHEARSAL_REFUSAL.message,
      )
      : null;
  if (blocked) {
    // Read the refusal BEFORE the receipt is built: the two have to name the
    // same posture, and this one is the durable half.
    const payload = (await blocked.clone().json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const refusal = metaLaunchWriteRefusalReason({ posture, payload });
    const intent = await recordMetaLaunchIntentWriteBlocked({
      businessId: access.businessId,
      id: launchIntentId,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: refusal.code,
        message: refusal.message,
        failedAt: "write_guard",
      }),
    });
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
    // The payload's own authority, matching every receipt written above it.
    executionAuthority: boundAuthority,
    requestFingerprint,
    actionLogAuthority,
    sanitizeError: sanitizeErrorMessage,
    actionLogOrigin:
      options.actionLogOrigin ?? META_LAUNCHPAD_MANUAL_ACTION_LOG_ORIGIN,
    requestedBy:
      options.requestedBy === undefined ? access.userId : options.requestedBy,
    // Mandatory, and the caller's own hook is composed behind it.
    beforeProviderMutation: mandatoryProviderMutationBoundary({
      businessId: access.businessId,
      providerAccountId,
      lineage: prepared.intent.lineage,
      callerBoundary: options.beforeProviderMutation,
    }),
  });
  return NextResponse.json(
    {
      ...outcome.body,
      providerMutationAttempted: outcome.providerMutationAttempted,
    },
    { status: outcome.status },
  );
}
