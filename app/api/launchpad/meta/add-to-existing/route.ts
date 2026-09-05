import { NextRequest, NextResponse } from "next/server";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAddToExistingAction,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  duplicateAd,
  type MetaAdDuplicateSourceIdentity,
  type MetaAdsWriteFailure,
  type MetaProviderMutationAttemptReceipt,
} from "@/lib/meta/ads-write";
import {
  metaWriteBlockedResponse,
  readMetaWritePosture,
} from "@/lib/meta/automation-write-guard";
import {
  adsManagerUrl,
  normalizeMetaAddToExistingPayload,
} from "@/lib/launchpad/meta";
import type { MetaAddToExistingCopyMode } from "@/lib/launchpad/meta";
import {
  buildMetaLaunchIntentErrorReceipt,
  buildMetaLaunchIntentResultReceipt,
  buildMetaLaunchIntentValidationReceipt,
} from "@/lib/launchpad/meta-launch-intent";
import { evaluateMetaLaunchpadExecutionBounds } from "@/lib/launchpad/meta-execution-bounds";
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
  validateMetaAddToExistingLiveProviderPreflight,
  validateMetaAddToExistingRequest,
} from "@/lib/launchpad/meta-validation";
import {
  bindMetaLaunchpadManualAuthorityToPayload,
  evaluateMetaLaunchpadManualAuthority,
  metaLaunchpadActionLogAuthority,
} from "@/lib/launchpad/meta-manual-authority";
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

export const dynamic = "force-dynamic";

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

function getFailureLogStatus(result: MetaAdsWriteFailure): Exclude<MetaAdsActionStatus, "pending" | "success"> {
  return result.error.code === "silent_failure" ||
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

function shouldHaltProviderMutationChain(result: MetaAdsWriteFailure) {
  return (
    result.error.code === "kill_switch_engaged" ||
    result.error.code === "silent_failure" ||
    result.mutationAttempt != null ||
    isProviderOutcomeAmbiguous(result)
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

function targetKey(target: { campaignId?: string | null; targetCampaignId?: string | null; adsetId?: string | null; targetAdsetId?: string | null }) {
  const campaignId = target.campaignId ?? target.targetCampaignId ?? "";
  const adsetId = target.adsetId ?? target.targetAdsetId ?? "";
  return `${campaignId}:${adsetId}`;
}

type AddToExistingStep = {
  kind: "ad";
  index: number;
  name: string;
  status: "success" | "failure" | "silent_failure";
  id?: string;
  creativeId: string;
  sourceIdentity?: MetaAdDuplicateSourceIdentity | null;
  providerOutcome?: "definite_failure" | "outcome_ambiguous";
  mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
  retryAllowed?: false;
  adsManagerUrl?: string;
  error?: { code: string; message: string };
};

function stepsAsRecords(steps: AddToExistingStep[]): Array<Record<string, unknown>> {
  return steps.map((step) => ({ ...step }));
}

function providerEvidenceWithSourceIdentity(
  payload: Record<string, unknown> | null | undefined,
  sourceIdentity: MetaAdDuplicateSourceIdentity | null | undefined,
) {
  return {
    provider_payload: ensureRecord(payload),
    source_identity: sourceIdentity ?? null,
  };
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

async function completeFailure(input: {
  logId: string;
  startedAt: number;
  result: MetaAdsWriteFailure;
}) {
  return completeMetaAdsActionLog({
    id: input.logId,
    status: getFailureLogStatus(input.result),
    payloadResponse: providerEvidenceWithSourceIdentity(
      input.result.responsePayload,
      input.result.sourceIdentity,
    ),
    errorCode: input.result.error.code,
    errorMessage: input.result.error.message,
    resultingAdId: input.result.resultingAdId ?? null,
    durationMs: Date.now() - input.startedAt,
    verifiedAt: input.result.verificationPayload
      ? new Date().toISOString()
      : null,
    verificationPayload: providerEvidenceWithSourceIdentity(
      input.result.verificationPayload,
      input.result.sourceIdentity,
    ),
  });
}

export async function POST(request: NextRequest) {
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

  const targetMeta = new Map(
    validation.targets.map((target) => [targetKey(target), target]),
  );
  const creativeMeta = new Map(
    validation.creatives.map((creative) => [creative.creativeId, creative]),
  );
  const submittedCreativeMeta = new Map(
    validation.payload.creatives.map((creative) => [creative.creativeId, creative]),
  );
  const results: Array<{
    creativeId: string;
    targetCampaignId: string;
    targetAdsetId: string;
    ok: boolean;
    adId?: string;
    sourceIdentity?: MetaAdDuplicateSourceIdentity | null;
    providerOutcome?: "definite_failure" | "outcome_ambiguous";
    mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
    retryAllowed?: false;
    error?: { code: string; message: string };
  }> = [];
  const steps: AddToExistingStep[] = [];
  const adIds: string[] = [];
  let haltedReason: { code: string; message: string } | null = null;
  let providerOutcomeStatus:
    | "succeeded"
    | "partially_succeeded"
    | "failed"
    | "silent_failure"
    | null = null;

  await markMetaLaunchIntentExecuting({
    businessId: access.businessId,
    id: launchIntentId,
  });

  try {
    targetLoop: for (let targetIndex = 0; targetIndex < validation.payload.targets.length; targetIndex += 1) {
      const target = validation.payload.targets[targetIndex];
      if (!target) continue;
      const resolvedTarget = targetMeta.get(targetKey(target));
      const ctx = ctxResult.ctx;
      const accountNumericId = ctx.providerAccountId.replace(/^act_/, "");
      const targetAdsetName =
        target.targetAdsetName || resolvedTarget?.adsetName || target.targetAdsetId;

      for (let creativeIndex = 0; creativeIndex < validation.payload.creativeIds.length; creativeIndex += 1) {
        const creativeId = validation.payload.creativeIds[creativeIndex];
        if (!creativeId) continue;
        const stepIndex = steps.length;
        const override = body?.names?.[creativeId]?.trim();
        const creative = creativeMeta.get(creativeId);
        const submittedCreative = submittedCreativeMeta.get(creativeId);
        const creativeName =
          creative?.creativeName ??
          submittedCreative?.name?.trim() ??
          null;
        const adName = override || creativeName || `Creative ${creativeId}`;
        const sourceAdId =
          submittedCreative?.sourceAdId?.trim() ||
          creative?.sourceAdId?.trim() ||
          "";
        if (!sourceAdId) {
          const error = {
            code: "source_ad_required",
            message: `Creative ${creativeId} is missing a source Meta ad id.`,
          };
          results.push({
            creativeId,
            targetCampaignId: target.targetCampaignId,
            targetAdsetId: target.targetAdsetId,
            ok: false,
            error,
          });
          steps.push({
            kind: "ad",
            index: stepIndex,
            name: `${adName} -> ${targetAdsetName}`,
            status: "failure",
            creativeId,
            error,
          });
          continue;
        }
        const adLog = await createMetaAdsActionLog({
          businessId: access.businessId,
          adId: sourceAdId,
          creativeId,
          action: "launch_ad",
          source: "launchpad_manual",
          requestedBy: access.userId,
          launchIntentId,
          payloadRequest: {
            ...actionLogAuthority,
            launch_intent_id: launchIntentId,
            idempotency_key: idempotencyKey,
            provider_preflight: livePreflight.checks,
            target_campaign_id: target.targetCampaignId,
            target_adset_id: target.targetAdsetId,
            target_campaign_name: target.targetCampaignName ?? resolvedTarget?.campaignName ?? null,
            target_adset_name: targetAdsetName,
            source_name: creativeName,
            method: "POST",
            endpoint: `/act_${accountNumericId}/ads`,
            body: {
              adset_id: target.targetAdsetId,
              target_adset_id: target.targetAdsetId,
              source_ad_id: sourceAdId,
              source_creative_id: creativeId,
              source_name: creativeName,
              copy_mode: copyMode,
              status_option: "PAUSED",
              name: adName,
            },
          },
        });
        const startedAt = Date.now();
        const adResult = await duplicateAd(ctx, {
          adId: sourceAdId,
          targetAdsetId: target.targetAdsetId,
          expectedSourceCreativeId: creativeId,
          name: adName,
          copyMode,
        });
        if (!adResult.ok) {
          await completeFailure({ logId: adLog.id, startedAt, result: adResult });
          const status = getFailureLogStatus(adResult);
          results.push({
            creativeId,
            targetCampaignId: target.targetCampaignId,
            targetAdsetId: target.targetAdsetId,
            ok: false,
            ...(adResult.sourceIdentity
              ? { sourceIdentity: adResult.sourceIdentity }
              : {}),
            ...(adResult.providerOutcome
              ? { providerOutcome: adResult.providerOutcome }
              : {}),
            ...(adResult.mutationAttempt
              ? { mutationAttempt: adResult.mutationAttempt }
              : {}),
            ...(isProviderOutcomeAmbiguous(adResult)
              ? { retryAllowed: false as const }
              : {}),
            error: adResult.error,
          });
          steps.push({
            kind: "ad",
            index: stepIndex,
            name: `${adName} -> ${targetAdsetName}`,
            status,
            id: adResult.resultingAdId ?? undefined,
            creativeId,
            ...(adResult.sourceIdentity
              ? { sourceIdentity: adResult.sourceIdentity }
              : {}),
            ...(adResult.providerOutcome
              ? { providerOutcome: adResult.providerOutcome }
              : {}),
            ...(adResult.mutationAttempt
              ? { mutationAttempt: adResult.mutationAttempt }
              : {}),
            ...(isProviderOutcomeAmbiguous(adResult)
              ? { retryAllowed: false as const }
              : {}),
            adsManagerUrl: adResult.resultingAdId
              ? adsManagerUrl(ctx.providerAccountId, "ad", adResult.resultingAdId)
              : undefined,
            error: adResult.error,
          });
          // D065: once a provider mutation has been attempted, any failure is
          // terminal for this request chain. Read-only identity drift may still
          // leave independent later targets safe to inspect.
          if (shouldHaltProviderMutationChain(adResult)) {
            haltedReason = adResult.error;
            break targetLoop;
          }
          continue;
        }
        adIds.push(adResult.newAdId);
        await completeMetaAdsActionLog({
          id: adLog.id,
          status: "success",
          payloadResponse: providerEvidenceWithSourceIdentity(
            adResult.responsePayload,
            adResult.sourceIdentity,
          ),
          resultingAdId: adResult.newAdId,
          durationMs: Date.now() - startedAt,
          verifiedAt: new Date().toISOString(),
          verificationPayload: providerEvidenceWithSourceIdentity(
            adResult.verificationPayload,
            adResult.sourceIdentity,
          ),
        });
        results.push({
          creativeId,
          targetCampaignId: target.targetCampaignId,
          targetAdsetId: target.targetAdsetId,
          ok: true,
          adId: adResult.newAdId,
          sourceIdentity: adResult.sourceIdentity,
        });
        steps.push({
          kind: "ad",
          index: stepIndex,
          name: `${adName} -> ${targetAdsetName}`,
          status: "success",
          id: adResult.newAdId,
          creativeId,
          sourceIdentity: adResult.sourceIdentity,
          adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "ad", adResult.newAdId),
        });
      }
    }

    const failedCount = results.filter((result) => !result.ok).length;
    const successCount = results.length - failedCount;
    const firstFailure = results.find((result) => !result.ok)?.error ?? null;
    const hasSilentFailure = steps.some(
      (step) => step.status === "silent_failure",
    );
    const hasAmbiguousOutcome = steps.some(
      (step) => step.providerOutcome === "outcome_ambiguous",
    );
    providerOutcomeStatus =
      failedCount === 0
        ? "succeeded"
        : hasSilentFailure
          ? "silent_failure"
          : successCount > 0
            ? "partially_succeeded"
            : "failed";
    const completedIntent = await recordMetaLaunchIntentOutcome({
      businessId: access.businessId,
      id: launchIntentId,
      status: providerOutcomeStatus,
      resultReceipt: buildMetaLaunchIntentResultReceipt({
        ...receiptBinding,
        providerAccountId,
        adIds,
        steps: stepsAsRecords(steps),
      }),
      errorReceipt:
        failedCount > 0
          ? buildMetaLaunchIntentErrorReceipt({
              ...receiptBinding,
              providerAccountId,
              code:
                haltedReason?.code ??
                firstFailure?.code ??
                "add_to_existing_partial_failure",
              message:
                haltedReason?.message ??
                firstFailure?.message ??
                `${failedCount} add-to-existing operation(s) failed.`,
              failedAt: "ad",
              adIds,
              steps: stepsAsRecords(steps),
            })
          : null,
    });
    return NextResponse.json(
      {
        ok: failedCount === 0 && !haltedReason,
        targetCampaignId,
        targetAdsetId,
        targets: validation.payload.targets,
        results,
        failedCount,
        successCount,
        adIds,
        steps,
        halted: Boolean(haltedReason),
        haltedReason,
        omittedCount:
          validation.payload.targets.length *
            validation.payload.creativeIds.length -
          results.length,
        launchIntentId,
        launchIntentStatus: completedIntent.status,
      },
      {
        status:
          haltedReason?.code === "kill_switch_engaged"
            ? 503
            : haltedReason || hasAmbiguousOutcome
              ? 502
              : 200,
      },
    );
  } catch (error) {
    const rawMessage = sanitizeErrorMessage(error);
    const errorCode = providerOutcomeStatus
      ? "add_to_existing_receipt_persist_failed"
      : "add_to_existing_failed";
    const message = providerOutcomeStatus
      ? `Meta add-to-existing completed, but its LaunchIntent receipt could not be persisted: ${rawMessage}`
      : rawMessage;
    const intent = await recordMetaLaunchIntentOutcome({
      businessId: access.businessId,
      id: launchIntentId,
      status:
        providerOutcomeStatus ??
        (adIds.length > 0 ? "partially_succeeded" : "failed"),
      resultReceipt: providerOutcomeStatus || adIds.length > 0
        ? buildMetaLaunchIntentResultReceipt({
            ...receiptBinding,
            providerAccountId,
            adIds,
            steps: stepsAsRecords(steps),
          })
        : null,
      errorReceipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: errorCode,
        message,
        failedAt: "orchestration",
        adIds,
        steps: stepsAsRecords(steps),
      }),
    }).catch(() => null);
    return NextResponse.json(
      {
        ok: false,
        error: { code: errorCode, message },
        targetCampaignId,
        targetAdsetId,
        targets: validation.payload.targets,
        results,
        failedCount: results.filter((result) => !result.ok).length,
        successCount: results.filter((result) => result.ok).length,
        adIds,
        steps,
        launchIntentId,
        launchIntentStatus: intent?.status ?? "receipt_write_failed",
      },
      { status: 500 },
    );
  }
}
