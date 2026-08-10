import { NextRequest, NextResponse } from "next/server";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaLaunchAction,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import type { MetaAdsWriteFailure } from "@/lib/meta/ads-write";
import { createAd, createAdSet, createCampaign } from "@/lib/meta/launch-write";
import { rejectIfMetaWritesBlocked } from "@/lib/meta/automation-write-guard";
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
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

type LaunchBody = {
  businessId?: string;
  providerAccountId?: string;
  payload?: unknown;
  idempotencyKey?: string;
  launchIntentId?: string | null;
  sourceDecisionId?: string | null;
  sourceDecisionSnapshotId?: string | null;
  creativeBriefId?: string | null;
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
  adsManagerUrl?: string;
}

export const dynamic = "force-dynamic";

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

// Narrowed during the native integration: MetaAdsActionStatus gained "pending"
// for D065's in-flight rows, and a completed failure is never pending. The
// annotation now says what the function actually returns.
function getFailureLogStatus(
  result: MetaAdsWriteFailure,
): Exclude<MetaAdsActionStatus, "pending"> {
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
      input.result.error.code === "silent_failure"
        ? "silent_failure"
        : "failure",
    id: input.result.resultingAdId ?? undefined,
    error: input.result.error,
  };
}

function stepsAsRecords(steps: LaunchStepResult[]): Array<Record<string, unknown>> {
  return steps.map((step) => ({ ...step }));
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
}) {
  const partial = Boolean(
    input.campaignId || input.adsetIds.length || input.adIds.length,
  );
  const status =
    input.result.error.code === "silent_failure"
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
          providerAccountId: input.providerAccountId,
          campaignId: input.campaignId,
          adsetIds: input.adsetIds,
          adIds: input.adIds,
          steps: stepsAsRecords(input.steps),
        })
      : null,
    errorReceipt: buildMetaLaunchIntentErrorReceipt({
      providerAccountId: input.providerAccountId,
      code: input.result.error.code,
      message: input.result.error.message,
      failedAt: input.failedAt,
      campaignId: input.campaignId,
      adsetIds: input.adsetIds,
      adIds: input.adIds,
      steps: stepsAsRecords(input.steps),
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
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
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
  const normalizedPayload = normalizeMetaLaunchPayload(body?.payload);
  const prepared = await prepareMetaLaunchIntentForExecution({
    businessId: access.businessId,
    providerAccountId,
    operation: "new_campaign",
    idempotencyKey,
    requestPayload: normalizedPayload,
    launchIntentId: body?.launchIntentId,
    sourceDecisionId: body?.sourceDecisionId,
    sourceDecisionSnapshotId: body?.sourceDecisionSnapshotId,
    creativeBriefId: body?.creativeBriefId,
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

  const blocked = await rejectIfMetaWritesBlocked({ businessId: access.businessId });
  if (blocked) {
    const receipt = buildMetaLaunchIntentErrorReceipt({
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
  const validatedIntent = await recordMetaLaunchIntentValidation({
    businessId: access.businessId,
    id: launchIntentId,
    receipt: buildMetaLaunchIntentValidationReceipt({
      providerAccountId,
      ok: validation.ok,
      blockers: validation.blockers,
      warnings: validation.warnings,
    }),
  });
  if (!validation.ok) {
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
      requestedBy: access.userId,
      launchIntentId,
      payloadRequest: {
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
        requestedBy: access.userId,
        launchIntentId,
        payloadRequest: {
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
          requestedBy: access.userId,
          launchIntentId,
          payloadRequest: {
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
        providerAccountId,
        campaignId,
        adsetIds,
        adIds,
        steps: stepsAsRecords(steps),
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
            providerAccountId,
            campaignId,
            adsetIds,
            adIds,
            steps: stepsAsRecords(steps),
          })
        : null,
      errorReceipt: buildMetaLaunchIntentErrorReceipt({
        providerAccountId,
        code: errorCode,
        message,
        failedAt: "orchestration",
        campaignId,
        adsetIds,
        adIds,
        steps: stepsAsRecords(steps),
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
