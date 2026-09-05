import { NextRequest, NextResponse } from "next/server";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaLaunchAction,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  type MetaAdsWriteFailure,
  type MetaProviderMutationAttemptReceipt,
} from "@/lib/meta/ads-write";
import {
  createAd,
  createAdSet,
  createCampaign,
  preflightMetaLaunchCreatives,
  type MetaLaunchCreativePreflightCheck,
} from "@/lib/meta/launch-write";
import {
  metaWriteBlockedResponse,
  readMetaWritePosture,
} from "@/lib/meta/automation-write-guard";
import {
  adsManagerUrl,
  normalizeMetaLaunchPayload,
  toAdInput,
  toAdSetInput,
  toCampaignInput,
} from "@/lib/launchpad/meta";
import {
  buildMetaLaunchIntentErrorReceipt,
  buildMetaLaunchIntentResultReceipt,
  buildMetaLaunchIntentValidationReceipt,
} from "@/lib/launchpad/meta-launch-intent";
import { MetaLaunchIntentLineageError } from "@/lib/launchpad/meta-launch-intent-lineage";
import { prepareMetaLaunchIntentForExecution } from "@/lib/launchpad/meta-launch-intent-service";
import { getMetaLaunchIntentCapability } from "@/lib/launchpad/meta-launch-intent-capability";
import {
  markMetaLaunchIntentExecuting,
  recordMetaLaunchIntentOutcome,
  recordMetaLaunchIntentPreExecutionFailure,
  recordMetaLaunchIntentValidation,
  recordMetaLaunchIntentWriteBlocked,
} from "@/lib/launchpad/meta-launch-intent-store";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
  resolveMetaLaunchWriteContext,
  validateMetaLaunchRequest,
} from "@/lib/launchpad/meta-validation";
import {
  bindMetaLaunchpadManualAuthorityToPayload,
  evaluateMetaLaunchpadManualAuthority,
  metaLaunchpadActionLogAuthority,
  type MetaLaunchpadManualAuthority,
} from "@/lib/launchpad/meta-manual-authority";
import { evaluateMetaLaunchpadExecutionBounds } from "@/lib/launchpad/meta-execution-bounds";
import { preflightAgeSeconds } from "@/lib/launchpad/validation-preflight-disclosure";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadExecutionGated,
  rejectIfLaunchpadMetaWritesBlocked,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../demo-write-authority";

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

type LaunchStepKind = "campaign" | "adset" | "ad";

interface LaunchStepResult {
  kind: LaunchStepKind;
  index: number;
  name: string;
  status: "pending" | "success" | "failure" | "silent_failure";
  id?: string;
  creativeId?: string;
  error?: {
    code: string;
    message: string;
  };
  providerOutcome?: "definite_failure" | "outcome_ambiguous";
  mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
  retryAllowed?: false;
  adsManagerUrl?: string;
}

export const dynamic = "force-dynamic";

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

// Narrowed during the native integration: MetaAdsActionStatus gained "pending"
// for D065's in-flight rows, and a completed failure is never pending. The
// annotation now says what the function actually returns.
//
// D067 requires `silent_failure` for an ambiguous provider outcome as well as
// the explicit silent-failure code, so the ambiguity predicate below stays the
// single source of that classification and of D069 retry gating.
function getFailureLogStatus(
  result: MetaAdsWriteFailure,
): Exclude<MetaAdsActionStatus, "pending"> {
  return isProviderOutcomeAmbiguous(result) ||
    result.error.code === "silent_failure"
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

function failureStep(input: {
  kind: LaunchStepKind;
  index: number;
  name: string;
  result: MetaAdsWriteFailure;
}): LaunchStepResult {
  return {
    kind: input.kind,
    index: input.index,
    name: input.name,
    status:
      getFailureLogStatus(input.result),
    id: input.result.resultingAdId ?? undefined,
    error: input.result.error,
    ...(input.result.providerOutcome
      ? { providerOutcome: input.result.providerOutcome }
      : {}),
    ...(input.result.mutationAttempt
      ? { mutationAttempt: input.result.mutationAttempt }
      : {}),
    ...(isProviderOutcomeAmbiguous(input.result)
      ? { retryAllowed: false as const }
      : {}),
  };
}

function stepsAsRecords(steps: LaunchStepResult[]): Array<Record<string, unknown>> {
  return steps.map((step) => ({ ...step }));
}

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

async function persistExecutionFailure(input: {
  businessId: string;
  launchIntentId: string;
  providerAccountId: string;
  result: MetaAdsWriteFailure;
  failedAt: string;
  campaignId?: string | null;
  adsetIds: string[];
  adIds: string[];
  steps: LaunchStepResult[];
  executionAuthority: MetaLaunchpadManualAuthority;
  requestFingerprint: string;
  checks: Array<Record<string, unknown>>;
}) {
  const partial = Boolean(
    input.campaignId || input.adsetIds.length || input.adIds.length,
  );
  const status =
    getFailureLogStatus(input.result) === "silent_failure"
      ? "silent_failure"
      : partial
        ? "partially_succeeded"
        : "failed";
  return recordMetaLaunchIntentOutcome({
    businessId: input.businessId,
    id: input.launchIntentId,
    status,
    resultReceipt: partial
      ? buildMetaLaunchIntentResultReceipt({
          executionAuthority: input.executionAuthority,
          requestFingerprint: input.requestFingerprint,
          providerAccountId: input.providerAccountId,
          campaignId: input.campaignId,
          adsetIds: input.adsetIds,
          adIds: input.adIds,
          steps: stepsAsRecords(input.steps),
          checks: input.checks,
        })
      : null,
    errorReceipt: buildMetaLaunchIntentErrorReceipt({
      executionAuthority: input.executionAuthority,
      requestFingerprint: input.requestFingerprint,
      providerAccountId: input.providerAccountId,
      code: input.result.error.code,
      message: input.result.error.message,
      failedAt: input.failedAt,
      campaignId: input.campaignId,
      adsetIds: input.adsetIds,
      adIds: input.adIds,
      steps: stepsAsRecords(input.steps),
      checks: input.checks,
    }),
  });
}

export async function POST(request: NextRequest) {
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
  const steps: LaunchStepResult[] = [];
  const adsetIds: string[] = [];
  const adIds: string[] = [];
  let campaignId: string | undefined;
  let providerExecutionCompleted = false;

  await markMetaLaunchIntentExecuting({
    businessId: access.businessId,
    id: launchIntentId,
  });

  try {
    const campaignInput = toCampaignInput(payload);
    const campaignLog = await createMetaAdsActionLog({
      businessId: access.businessId,
      adId: `launch:${idempotencyKey}:campaign`,
      action: "launch_campaign",
      source: "launchpad_manual",
      requestedBy: access.userId,
      launchIntentId,
      payloadRequest: {
        ...actionLogAuthority,
        ...actionLogPreflightProof,
        launch_intent_id: launchIntentId,
        idempotency_key: idempotencyKey,
        method: "POST",
        endpoint: `/act_${ctx.providerAccountId.replace(/^act_/, "")}/campaigns`,
        body: {
          ...campaignInput,
          status: "PAUSED",
          objective: "OUTCOME_SALES",
        },
      },
    });
    const campaignStartedAt = Date.now();
    const campaignResult = await createCampaign(ctx, campaignInput);
    if (!campaignResult.ok) {
      await completeFailure({
        logId: campaignLog.id,
        startedAt: campaignStartedAt,
        result: campaignResult,
      });
      const step = failureStep({
        kind: "campaign",
        index: 0,
        name: campaignInput.name,
        result: campaignResult,
      });
      steps.push(step);
      const failedIntent = await persistExecutionFailure({
        businessId: access.businessId,
        launchIntentId,
        providerAccountId,
        result: campaignResult,
        executionAuthority: authority,
        requestFingerprint,
        checks: preflightChecks,
        failedAt: "campaign",
        campaignId: null,
        adsetIds,
        adIds,
        steps,
      });
      return NextResponse.json(
        {
          ok: false,
          campaignId: null,
          adsetIds,
          adIds,
          steps,
          failedAt: "campaign",
          error: step.error,
          providerOutcome: campaignResult.providerOutcome ?? null,
          mutationAttempt: campaignResult.mutationAttempt ?? null,
          retryAllowed: isProviderOutcomeAmbiguous(campaignResult)
            ? false
            : null,
          launchIntentId,
          launchIntentStatus: failedIntent.status,
        },
        { status: 502 },
      );
    }
    campaignId = campaignResult.campaignId;
    await completeMetaAdsActionLog({
      id: campaignLog.id,
      status: "success",
      payloadResponse: ensureRecord(campaignResult.responsePayload),
      resultingAdId: campaignResult.campaignId,
      durationMs: Date.now() - campaignStartedAt,
      verifiedAt: new Date().toISOString(),
      verificationPayload: ensureRecord(campaignResult.verificationPayload),
    });
    steps.push({
      kind: "campaign",
      index: 0,
      name: campaignInput.name,
      status: "success",
      id: campaignId,
      adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "campaign", campaignId),
    });

    for (let adsetIndex = 0; adsetIndex < payload.adSets.length; adsetIndex += 1) {
      const adSetPayload = payload.adSets[adsetIndex];
      if (!adSetPayload) continue;
      const adSetInput = toAdSetInput(campaignId, adSetPayload, payload.budget);
      const adSetLog = await createMetaAdsActionLog({
        businessId: access.businessId,
        adId: `launch:${idempotencyKey}:adset:${adsetIndex + 1}`,
        action: "launch_adset",
        source: "launchpad_manual",
        requestedBy: access.userId,
        launchIntentId,
        payloadRequest: {
          ...actionLogAuthority,
          ...actionLogPreflightProof,
          launch_intent_id: launchIntentId,
          idempotency_key: idempotencyKey,
          method: "POST",
          endpoint: `/${campaignId}/adsets`,
          body: {
            ...adSetInput,
            status: "PAUSED",
          },
        },
      });
      const adSetStartedAt = Date.now();
      const adSetResult = await createAdSet(ctx, adSetInput);
      if (!adSetResult.ok) {
        await completeFailure({
          logId: adSetLog.id,
          startedAt: adSetStartedAt,
          result: adSetResult,
        });
        const step = failureStep({
          kind: "adset",
          index: adsetIndex,
          name: adSetInput.name,
          result: adSetResult,
        });
        steps.push(step);
        const failedIntent = await persistExecutionFailure({
          businessId: access.businessId,
          launchIntentId,
          providerAccountId,
          result: adSetResult,
          executionAuthority: authority,
          requestFingerprint,
          checks: preflightChecks,
          failedAt: `adset:${adsetIndex + 1}`,
          campaignId,
          adsetIds,
          adIds,
          steps,
        });
        return NextResponse.json(
          {
            ok: false,
            campaignId,
            adsetIds,
            adIds,
            steps,
            failedAt: `adset:${adsetIndex + 1}`,
            error: step.error,
            providerOutcome: adSetResult.providerOutcome ?? null,
            mutationAttempt: adSetResult.mutationAttempt ?? null,
            retryAllowed: isProviderOutcomeAmbiguous(adSetResult)
              ? false
              : null,
            launchIntentId,
            launchIntentStatus: failedIntent.status,
          },
          { status: 502 },
        );
      }
      adsetIds.push(adSetResult.adsetId);
      await completeMetaAdsActionLog({
        id: adSetLog.id,
        status: "success",
        payloadResponse: ensureRecord(adSetResult.responsePayload),
        resultingAdId: adSetResult.adsetId,
        durationMs: Date.now() - adSetStartedAt,
        verifiedAt: new Date().toISOString(),
        verificationPayload: ensureRecord(adSetResult.verificationPayload),
      });
      steps.push({
        kind: "adset",
        index: adsetIndex,
        name: adSetInput.name,
        status: "success",
        id: adSetResult.adsetId,
        adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "adset", adSetResult.adsetId),
      });

      for (let creativeIndex = 0; creativeIndex < payload.creatives.length; creativeIndex += 1) {
        const creative = payload.creatives[creativeIndex];
        if (!creative) continue;
        const adInput = toAdInput(adSetResult.adsetId, creative);
        const adLog = await createMetaAdsActionLog({
          businessId: access.businessId,
          adId: `launch:${idempotencyKey}:ad:${adsetIndex + 1}:${creativeIndex + 1}`,
          creativeId: creative.creativeId,
          action: "launch_ad",
          source: "launchpad_manual",
          requestedBy: access.userId,
          launchIntentId,
          payloadRequest: {
            ...actionLogAuthority,
            ...actionLogPreflightProof,
            launch_intent_id: launchIntentId,
            idempotency_key: idempotencyKey,
            method: "POST",
            endpoint: `/${adSetResult.adsetId}/ads`,
            body: {
              ...adInput,
              status: "PAUSED",
            },
          },
        });
        const adStartedAt = Date.now();
        const adResult = await createAd(ctx, adInput);
        if (!adResult.ok) {
          await completeFailure({
            logId: adLog.id,
            startedAt: adStartedAt,
            result: adResult,
          });
          const step = failureStep({
            kind: "ad",
            index: adIds.length,
            name: adInput.name,
            result: adResult,
          });
          step.creativeId = creative.creativeId;
          steps.push(step);
          const failedIntent = await persistExecutionFailure({
            businessId: access.businessId,
            launchIntentId,
            providerAccountId,
            result: adResult,
            executionAuthority: authority,
            requestFingerprint,
            checks: preflightChecks,
            failedAt: `ad:${adsetIndex + 1}:${creativeIndex + 1}`,
            campaignId,
            adsetIds,
            adIds,
            steps,
          });
          return NextResponse.json(
            {
              ok: false,
              campaignId,
              adsetIds,
              adIds,
              steps,
              failedAt: `ad:${adsetIndex + 1}:${creativeIndex + 1}`,
              error: step.error,
              providerOutcome: adResult.providerOutcome ?? null,
              mutationAttempt: adResult.mutationAttempt ?? null,
              retryAllowed: isProviderOutcomeAmbiguous(adResult)
                ? false
                : null,
              launchIntentId,
              launchIntentStatus: failedIntent.status,
            },
            { status: 502 },
          );
        }
        adIds.push(adResult.adId);
        await completeMetaAdsActionLog({
          id: adLog.id,
          status: "success",
          payloadResponse: ensureRecord(adResult.responsePayload),
          resultingAdId: adResult.adId,
          durationMs: Date.now() - adStartedAt,
          verifiedAt: new Date().toISOString(),
          verificationPayload: ensureRecord(adResult.verificationPayload),
        });
        steps.push({
          kind: "ad",
          index: adIds.length - 1,
          name: adInput.name,
          status: "success",
          id: adResult.adId,
          creativeId: creative.creativeId,
          adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "ad", adResult.adId),
        });
      }
    }

    providerExecutionCompleted = true;
    const completedIntent = await recordMetaLaunchIntentOutcome({
      businessId: access.businessId,
      id: launchIntentId,
      status: "succeeded",
      resultReceipt: buildMetaLaunchIntentResultReceipt({
        ...receiptBinding,
        providerAccountId,
        campaignId,
        adsetIds,
        adIds,
        steps: stepsAsRecords(steps),
        checks: preflightChecks,
      }),
    });
    return NextResponse.json({
      ok: true,
      campaignId,
      adsetIds,
      adIds,
      steps,
      launchIntentId,
      launchIntentStatus: completedIntent.status,
      // The fresh creative-identity proof this create rested on, and how old it
      // was when the first POST went out (§10 step 10).
      preflight: preflightDisclosure,
    });
  } catch (error) {
    const rawMessage = sanitizeErrorMessage(error);
    const errorCode = providerExecutionCompleted
      ? "launch_receipt_persist_failed"
      : "launch_failed";
    const message = providerExecutionCompleted
      ? `Meta launch completed, but its LaunchIntent receipt could not be persisted: ${rawMessage}`
      : rawMessage;
    const partial = Boolean(campaignId || adsetIds.length || adIds.length);
    const intent = await recordMetaLaunchIntentOutcome({
      businessId: access.businessId,
      id: launchIntentId,
      status: providerExecutionCompleted
        ? "succeeded"
        : partial
          ? "partially_succeeded"
          : "failed",
      resultReceipt: providerExecutionCompleted || partial
        ? buildMetaLaunchIntentResultReceipt({
            ...receiptBinding,
            providerAccountId,
            campaignId,
            adsetIds,
            adIds,
            steps: stepsAsRecords(steps),
            checks: preflightChecks,
          })
        : null,
      errorReceipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: errorCode,
        message,
        failedAt: "orchestration",
        campaignId,
        adsetIds,
        adIds,
        steps: stepsAsRecords(steps),
        checks: preflightChecks,
      }),
    }).catch(() => null);
    return NextResponse.json(
      {
        ok: false,
        error: { code: errorCode, message },
        campaignId: campaignId ?? null,
        adsetIds,
        adIds,
        steps,
        launchIntentId,
        launchIntentStatus: intent?.status ?? "receipt_write_failed",
      },
      { status: 500 },
    );
  }
}
