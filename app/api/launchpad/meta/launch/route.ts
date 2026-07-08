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
  toAdInput,
  toAdSetInput,
  toCampaignInput,
} from "@/lib/launchpad/meta";
import {
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
  payload?: unknown;
  idempotencyKey?: string;
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

export async function POST(request: NextRequest) {
  const body = await readJsonBody<LaunchBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_launch");
  if (reviewerBlocked) return reviewerBlocked;
  const blocked = await rejectIfMetaWritesBlocked({ businessId: access.businessId });
  if (blocked) return blocked;
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }

  const inFlight = await hasRecentPendingMetaLaunchAction({
    businessId: access.businessId,
    idempotencyKey,
    sinceSeconds: 30,
  });
  if (inFlight) {
    return jsonError(
      409,
      "launch_in_flight",
      "A Meta launch with this idempotency key is already pending.",
    );
  }

  const validation = await validateMetaLaunchRequest({
    businessId: access.businessId,
    payload: body?.payload,
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
      },
      { status: 400 },
    );
  }

  const ctxResult = await resolveMetaLaunchWriteContext(access.businessId);
  if (!ctxResult.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: ctxResult.blocker,
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

  try {
    const campaignInput = toCampaignInput(payload);
    const campaignLog = await createMetaAdsActionLog({
      businessId: access.businessId,
      adId: `launch:${idempotencyKey}:campaign`,
      action: "launch_campaign",
      requestedBy: access.userId,
      payloadRequest: {
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
      return NextResponse.json(
        {
          ok: false,
          campaignId: null,
          adsetIds,
          adIds,
          steps,
          failedAt: "campaign",
          error: step.error,
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
        payloadRequest: {
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
        return NextResponse.json(
          {
            ok: false,
            campaignId,
            adsetIds,
            adIds,
            steps,
            failedAt: `adset:${adsetIndex + 1}`,
            error: step.error,
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
          payloadRequest: {
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
          return NextResponse.json(
            {
              ok: false,
              campaignId,
              adsetIds,
              adIds,
              steps,
              failedAt: `ad:${adsetIndex + 1}:${creativeIndex + 1}`,
              error: step.error,
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

    return NextResponse.json({
      ok: true,
      campaignId,
      adsetIds,
      adIds,
      steps,
    });
  } catch (error) {
    return jsonError(500, "launch_failed", sanitizeErrorMessage(error), {
      campaignId: campaignId ?? null,
      adsetIds,
      adIds,
      steps,
    });
  }
}
