import { NextRequest, NextResponse } from "next/server";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAdsAction,
  resolveMetaAdActionTarget,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  pauseAd,
  resumeAd,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";
import { adsManagerUrl } from "@/lib/launchpad/meta";
import { resolveMetaLaunchWriteContext } from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

type BulkAdStatusAction = "pause" | "resume";

type BulkAdStatusBody = {
  businessId?: string;
  action?: BulkAdStatusAction;
  ads?: Array<{
    adId?: string | null;
    creativeId?: string | null;
    name?: string | null;
  }>;
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

function normalizeAds(body: BulkAdStatusBody | null) {
  const byAdId = new Map<string, { adId: string; creativeId: string | null; name: string | null }>();
  (body?.ads ?? []).forEach((ad) => {
    const adId = ad.adId?.trim() ?? "";
    if (!adId) return;
    byAdId.set(adId, {
      adId,
      creativeId: ad.creativeId?.trim() || null,
      name: ad.name?.trim() || null,
    });
  });
  return Array.from(byAdId.values());
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody<BulkAdStatusBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const action = body?.action;
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";
  const ads = normalizeAds(body);

  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  if (action !== "pause" && action !== "resume") {
    return jsonError(400, "invalid_action", "action must be pause or resume.");
  }
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }
  if (ads.length === 0) {
    return jsonError(400, "ads_required", "At least one ad is required.");
  }

  const ctxResult = await resolveMetaLaunchWriteContext(access.businessId);
  if (!ctxResult.ok) {
    return NextResponse.json(
      { ok: false, error: ctxResult.blocker },
      { status: 502 },
    );
  }

  const statusOption = action === "pause" ? "PAUSED" : "ACTIVE";
  const results: Array<{
    inputAdId: string;
    adId?: string;
    creativeId?: string | null;
    ok: boolean;
    status?: string;
    error?: { code: string; message: string };
  }> = [];
  const steps: Array<{
    kind: "ad";
    index: number;
    name: string;
    status: "success" | "failure" | "silent_failure";
    id?: string;
    creativeId?: string;
    adsManagerUrl?: string;
    error?: { code: string; message: string };
  }> = [];

  try {
    for (let index = 0; index < ads.length; index += 1) {
      const ad = ads[index];
      if (!ad) continue;
      const stepName = ad.name || ad.adId;
      const targetResult = await resolveMetaAdActionTarget({
        businessId: access.businessId,
        adId: ad.adId,
      });
      if (!targetResult.ok) {
        const error = {
          code: "ad_not_found",
          message: "Ad was not found for this business.",
        };
        results.push({
          inputAdId: ad.adId,
          creativeId: ad.creativeId,
          ok: false,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "failure",
          creativeId: ad.creativeId ?? undefined,
          error,
        });
        continue;
      }

      const resolvedAdId = targetResult.target.adId;
      const pending = await hasRecentPendingMetaAdsAction({
        businessId: access.businessId,
        adId: resolvedAdId,
        sinceSeconds: 30,
      });
      if (pending) {
        const error = {
          code: "action_in_flight",
          message: "A Meta ad action is already pending for this ad.",
        };
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "failure",
          id: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId ?? undefined,
          error,
        });
        continue;
      }

      const ctx = targetResult.target.providerAccountId
        ? { ...ctxResult.ctx, providerAccountId: targetResult.target.providerAccountId }
        : ctxResult.ctx;
      const log = await createMetaAdsActionLog({
        businessId: access.businessId,
        adId: resolvedAdId,
        creativeId: targetResult.target.creativeId ?? ad.creativeId,
        action,
        requestedBy: access.userId,
        payloadRequest: {
          idempotency_key: idempotencyKey,
          method: "POST",
          endpoint: `/${resolvedAdId}`,
          body: { status: statusOption },
          input_ad_id: ad.adId,
        },
      });

      const startedAt = Date.now();
      const result =
        action === "pause"
          ? await pauseAd(ctx, resolvedAdId)
          : await resumeAd(ctx, resolvedAdId);

      if (!result.ok) {
        await completeFailure({ logId: log.id, startedAt, result });
        const status = getFailureLogStatus(result);
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          error: result.error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status,
          id: result.resultingAdId ?? resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId ?? undefined,
          error: result.error,
        });
        continue;
      }

      await completeMetaAdsActionLog({
        id: log.id,
        status: "success",
        payloadResponse: ensureRecord(result.responsePayload),
        durationMs: Date.now() - startedAt,
        verifiedAt: new Date().toISOString(),
        verificationPayload: ensureRecord(result.verificationPayload),
      });
      results.push({
        inputAdId: ad.adId,
        adId: resolvedAdId,
        creativeId: targetResult.target.creativeId ?? ad.creativeId,
        ok: true,
        status: result.verifiedStatus,
      });
      steps.push({
        kind: "ad",
        index,
        name: stepName,
        status: "success",
        id: resolvedAdId,
        creativeId: targetResult.target.creativeId ?? ad.creativeId ?? undefined,
        adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "ad", resolvedAdId),
      });
    }

    const failedCount = results.filter((result) => !result.ok).length;
    const successCount = results.length - failedCount;
    return NextResponse.json({
      ok: failedCount === 0,
      action,
      status: statusOption,
      results,
      steps,
      successCount,
      failedCount,
      adIds: results.flatMap((result) => result.adId ?? []),
    });
  } catch (error) {
    return jsonError(500, "bulk_ad_status_failed", sanitizeErrorMessage(error), {
      action,
      results,
      steps,
      successCount: results.filter((result) => result.ok).length,
      failedCount: results.filter((result) => !result.ok).length,
      adIds: results.flatMap((result) => result.adId ?? []),
    });
  }
}
