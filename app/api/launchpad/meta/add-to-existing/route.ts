import { NextRequest, NextResponse } from "next/server";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAddToExistingAction,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  duplicateAd,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";
import { adsManagerUrl } from "@/lib/launchpad/meta";
import type { MetaAddToExistingCopyMode } from "@/lib/launchpad/meta";
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
  idempotencyKey?: string;
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
  return result.error.code === "silent_failure" ? "silent_failure" : "failure";
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
  const requestedTargets = normalizeBodyTargets(body);
  const firstRequestedTarget = requestedTargets[0] ?? null;
  const targetCampaignId = firstRequestedTarget?.targetCampaignId ?? "";
  const targetAdsetId = firstRequestedTarget?.targetAdsetId ?? "";
  const copyMode: MetaAddToExistingCopyMode =
    body?.copyMode === "reuse_creative" ? "reuse_creative" : "rebuild_creative";
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";

  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }
  if (requestedTargets.length === 0 || requestedTargets.some((target) => !target.targetAdsetId)) {
    return jsonError(400, "target_adset_required", "At least one target ad set is required.");
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
    return jsonError(
      409,
      "launch_in_flight",
      "A Meta add-to-existing launch with this idempotency key is already pending for one of these ad sets.",
    );
  }

  const validation = await validateMetaAddToExistingRequest({
    businessId: access.businessId,
    payload: {
      mode: "add_to_existing",
      targetCampaignId,
      targetAdsetId,
      copyMode,
      targets: requestedTargets,
      creativeIds: body?.creativeIds ?? [],
      creatives: body?.creatives ?? [],
      names: body?.names ?? {},
      sourceAdIds: body?.sourceAdIds ?? {},
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
    error?: { code: string; message: string };
  }> = [];
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
    for (let targetIndex = 0; targetIndex < validation.payload.targets.length; targetIndex += 1) {
      const target = validation.payload.targets[targetIndex];
      if (!target) continue;
      const resolvedTarget = targetMeta.get(targetKey(target));
      const targetProviderAccountId = resolvedTarget?.providerAccountId?.trim() ?? "";
      const ctx = targetProviderAccountId
        ? { ...ctxResult.ctx, providerAccountId: targetProviderAccountId }
        : ctxResult.ctx;
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
          requestedBy: access.userId,
          payloadRequest: {
            idempotency_key: idempotencyKey,
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
          name: adName,
          activateAfterCreate: false,
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
            error: adResult.error,
          });
          steps.push({
            kind: "ad",
            index: stepIndex,
            name: `${adName} -> ${targetAdsetName}`,
            status,
            id: adResult.resultingAdId ?? undefined,
            creativeId,
            adsManagerUrl: adResult.resultingAdId
              ? adsManagerUrl(ctx.providerAccountId, "ad", adResult.resultingAdId)
              : undefined,
            error: adResult.error,
          });
          continue;
        }
        adIds.push(adResult.newAdId);
        await completeMetaAdsActionLog({
          id: adLog.id,
          status: "success",
          payloadResponse: ensureRecord(adResult.responsePayload),
          resultingAdId: adResult.newAdId,
          durationMs: Date.now() - startedAt,
          verifiedAt: new Date().toISOString(),
          verificationPayload: ensureRecord(adResult.verificationPayload),
        });
        results.push({
          creativeId,
          targetCampaignId: target.targetCampaignId,
          targetAdsetId: target.targetAdsetId,
          ok: true,
          adId: adResult.newAdId,
        });
        steps.push({
          kind: "ad",
          index: stepIndex,
          name: `${adName} -> ${targetAdsetName}`,
          status: "success",
          id: adResult.newAdId,
          creativeId,
          adsManagerUrl: adsManagerUrl(ctx.providerAccountId, "ad", adResult.newAdId),
        });
      }
    }

    const failedCount = results.filter((result) => !result.ok).length;
    const successCount = results.length - failedCount;
    return NextResponse.json({
      ok: failedCount === 0,
      targetCampaignId,
      targetAdsetId,
      targets: validation.payload.targets,
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
      targets: validation.payload.targets,
      results,
      failedCount: results.filter((result) => !result.ok).length,
      successCount: results.filter((result) => result.ok).length,
      adIds,
      steps,
    });
  }
}
