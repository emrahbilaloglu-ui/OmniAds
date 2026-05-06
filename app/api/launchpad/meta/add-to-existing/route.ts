import { NextRequest, NextResponse } from "next/server";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAddToExistingAction,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import type { MetaAdsWriteFailure } from "@/lib/meta/ads-write";
import { createAd } from "@/lib/meta/launch-write";
import { adsManagerUrl } from "@/lib/launchpad/meta";
import {
  resolveMetaLaunchWriteContext,
  validateMetaAddToExistingRequest,
} from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

type AddToExistingBody = {
  businessId?: string;
  targetCampaignId?: string;
  targetAdsetId?: string;
  creativeIds?: string[];
  names?: Record<string, string>;
  idempotencyKey?: string;
};

export const dynamic = "force-dynamic";

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

function getFailureLogStatus(result: MetaAdsWriteFailure): Exclude<MetaAdsActionStatus, "pending" | "success"> {
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

export async function POST(request: NextRequest) {
  const body = await readJsonBody<AddToExistingBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const targetCampaignId = body?.targetCampaignId?.trim() ?? "";
  const targetAdsetId = body?.targetAdsetId?.trim() ?? "";
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";

  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }
  if (!targetAdsetId) {
    return jsonError(400, "target_adset_required", "targetAdsetId is required.");
  }

  const inFlight = await hasRecentPendingMetaAddToExistingAction({
    businessId: access.businessId,
    idempotencyKey,
    targetAdsetId,
    sinceSeconds: 30,
  });
  if (inFlight) {
    return jsonError(
      409,
      "launch_in_flight",
      "A Meta add-to-existing launch with this idempotency key is already pending for this ad set.",
    );
  }

  const validation = await validateMetaAddToExistingRequest({
    businessId: access.businessId,
    payload: {
      mode: "add_to_existing",
      targetCampaignId,
      targetAdsetId,
      creativeIds: body?.creativeIds ?? [],
      names: body?.names ?? {},
    },
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
  const creativeMeta = new Map(
    validation.creatives.map((creative) => [creative.creativeId, creative]),
  );
  const results: Array<{ creativeId: string; ok: boolean; adId?: string; error?: { code: string; message: string } }> = [];
  const steps: Array<{
    kind: "ad";
    index: number;
    name: string;
    status: "success" | "failure" | "silent_failure";
    id?: string;
    creativeId: string;
    adsManagerUrl?: string;
    error?: { code: string; message: string };
  }> = [];
  const adIds: string[] = [];

  try {
    for (let index = 0; index < validation.payload.creativeIds.length; index += 1) {
      const creativeId = validation.payload.creativeIds[index];
      if (!creativeId) continue;
      const override = body?.names?.[creativeId]?.trim();
      const creativeName = creativeMeta.get(creativeId)?.creativeName ?? null;
      const adName = override || creativeName || `Creative ${creativeId}`;
      const adInput = {
        adsetId: targetAdsetId,
        creativeId,
        name: adName,
        status: "PAUSED" as const,
      };
      const adLog = await createMetaAdsActionLog({
        businessId: access.businessId,
        adId: `launch:${idempotencyKey}:adset:${targetAdsetId}:ad:${index + 1}`,
        creativeId,
        action: "launch_ad",
        requestedBy: access.userId,
        payloadRequest: {
          idempotency_key: idempotencyKey,
          target_campaign_id: targetCampaignId,
          target_adset_id: targetAdsetId,
          method: "POST",
          endpoint: `/${targetAdsetId}/ads`,
          body: {
            ...adInput,
            status: "PAUSED",
          },
        },
      });
      const startedAt = Date.now();
      const adResult = await createAd(ctx, adInput);
      if (!adResult.ok) {
        await completeFailure({ logId: adLog.id, startedAt, result: adResult });
        const status = getFailureLogStatus(adResult);
        results.push({ creativeId, ok: false, error: adResult.error });
        steps.push({
          kind: "ad",
          index,
          name: adInput.name,
          status,
          id: adResult.resultingAdId ?? undefined,
          creativeId,
          error: adResult.error,
        });
        continue;
      }
      adIds.push(adResult.adId);
      await completeMetaAdsActionLog({
        id: adLog.id,
        status: "success",
        payloadResponse: ensureRecord(adResult.responsePayload),
        resultingAdId: adResult.adId,
        durationMs: Date.now() - startedAt,
        verifiedAt: new Date().toISOString(),
        verificationPayload: ensureRecord(adResult.verificationPayload),
      });
      results.push({ creativeId, ok: true, adId: adResult.adId });
      steps.push({
        kind: "ad",
        index,
        name: adInput.name,
        status: "success",
        id: adResult.adId,
        creativeId,
        adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "ad", adResult.adId),
      });
    }

    const failedCount = results.filter((result) => !result.ok).length;
    const successCount = results.length - failedCount;
    return NextResponse.json({
      ok: failedCount === 0,
      targetCampaignId,
      targetAdsetId,
      results,
      failedCount,
      successCount,
      adIds,
      steps,
    });
  } catch (error) {
    return jsonError(500, "add_to_existing_failed", sanitizeErrorMessage(error), {
      targetCampaignId,
      targetAdsetId,
      results,
      failedCount: results.filter((result) => !result.ok).length,
      successCount: results.filter((result) => result.ok).length,
      adIds,
      steps,
    });
  }
}
