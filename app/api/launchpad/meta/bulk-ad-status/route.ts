import { NextRequest, NextResponse } from "next/server";
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAdsAction,
  readLaunchpadCreatedAdIds,
  resolveMetaAdActionTarget,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  pauseAd,
  resumeAd,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";
import { rejectIfMetaWritesBlocked } from "@/lib/meta/automation-write-guard";
import { adsManagerUrl } from "@/lib/launchpad/meta";
import {
  metaLaunchAccountBlockerHttpStatus,
  normalizeMetaLaunchProviderAccountId,
  resolveAssignedMetaLaunchAccount,
  resolveMetaLaunchWriteContext,
  validateMetaBulkResumePreflight,
} from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

type BulkAdStatusAction = "pause" | "resume";

type BulkAdStatusBody = {
  businessId?: string;
  providerAccountId?: string;
  action?: BulkAdStatusAction;
  ads?: Array<{
    adId?: string | null;
    candidateAdIds?: Array<string | null | undefined> | null;
    creativeId?: string | null;
    name?: string | null;
  }>;
  idempotencyKey?: string;
};

export const dynamic = "force-dynamic";
const MAX_BULK_ADS = 20;

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

function uniqueIds(ids: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    const normalized = id?.trim();
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
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
  const byAdId = new Map<
    string,
    {
      adId: string;
      candidateAdIds: string[];
      creativeId: string | null;
      name: string | null;
    }
  >();
  (body?.ads ?? []).forEach((ad) => {
    const candidateAdIds = uniqueIds([
      ad.adId,
      ...(Array.isArray(ad.candidateAdIds) ? ad.candidateAdIds : []),
    ]);
    const adId = candidateAdIds[0] ?? "";
    if (!adId) return;
    byAdId.set(adId, {
      adId,
      candidateAdIds,
      creativeId: ad.creativeId?.trim() || null,
      name: ad.name?.trim() || null,
    });
  });
  return Array.from(byAdId.values());
}

async function resolveBulkAdActionTarget(input: {
  businessId: string;
  candidateAdIds: string[];
}) {
  const attemptedIds: string[] = [];
  for (const adId of input.candidateAdIds) {
    attemptedIds.push(adId);
    const targetResult = await resolveMetaAdActionTarget({
      businessId: input.businessId,
      adId,
    });
    if (targetResult.ok) {
      return {
        ok: true as const,
        inputAdId: adId,
        attemptedIds,
        target: targetResult.target,
      };
    }
  }
  return { ok: false as const, attemptedIds };
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody<BulkAdStatusBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const action = body?.action;
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";
  const ads = normalizeAds(body);

  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_bulk_ad_status");
  if (reviewerBlocked) return reviewerBlocked;
  const blocked = await rejectIfMetaWritesBlocked({ businessId: access.businessId });
  if (blocked) return blocked;
  if (action !== "pause" && action !== "resume") {
    return jsonError(400, "invalid_action", "action must be pause or resume.");
  }
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }
  if (ads.length === 0) {
    return jsonError(400, "ads_required", "At least one ad is required.");
  }
  if (ads.length > MAX_BULK_ADS) {
    return jsonError(
      400,
      "bulk_limit_exceeded",
      `At most ${MAX_BULK_ADS} ads can be changed in one request.`,
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
  const ctxResult = await resolveMetaLaunchWriteContext(
    access.businessId,
    providerAccountId,
  );
  if (!ctxResult.ok) {
    return NextResponse.json(
      { ok: false, error: ctxResult.blocker },
      { status: 502 },
    );
  }

  const statusOption = action === "pause" ? "PAUSED" : "ACTIVE";
  const resumeTargets = new Map<
    string,
    Extract<
      Awaited<ReturnType<typeof resolveBulkAdActionTarget>>,
      { ok: true }
    >
  >();
  if (action === "resume") {
    const resolved = await Promise.all(
      ads.map(async (ad) => ({
        ad,
        result: await resolveBulkAdActionTarget({
          businessId: access.businessId,
          candidateAdIds: ad.candidateAdIds,
        }),
      })),
    );
    const unresolved = resolved.filter((item) => !item.result.ok);
    if (unresolved.length > 0) {
      return jsonError(
        400,
        "resume_target_unresolved",
        "Every ad must resolve to a live business-owned target before bulk resume.",
        {
          blockers: unresolved.map(({ ad, result }) => ({
            adId: ad.adId,
            code: "ad_not_found",
            attemptedIds: result.attemptedIds,
          })),
        },
      );
    }
    resolved.forEach(({ ad, result }) => {
      if (result.ok) resumeTargets.set(ad.adId, result);
    });
    const createdAdIds = await readLaunchpadCreatedAdIds({
      businessId: access.businessId,
      adIds: Array.from(resumeTargets.values()).map(
        (target) => target.target.adId,
      ),
    });
    const outOfScope = Array.from(resumeTargets.values()).filter(
      (target) => !createdAdIds.has(target.target.adId),
    );
    if (outOfScope.length > 0) {
      return jsonError(
        403,
        "resume_scope_blocked",
        "Bulk resume is limited to ads created and verified by Launchpad.",
        {
          blockers: outOfScope.map((target) => ({
            adId: target.target.adId,
            code: "not_launchpad_created",
          })),
        },
      );
    }
    const preflight = await validateMetaBulkResumePreflight({
      ctx: ctxResult.ctx,
      targets: Array.from(resumeTargets.values()).map((target) => ({
        adId: target.target.adId,
        creativeId: target.target.creativeId,
        providerAccountId: target.target.providerAccountId,
      })),
    });
    if (!preflight.ok) {
      return jsonError(
        400,
        "resume_preflight_blocked",
        "Bulk resume preflight failed. No ads were changed.",
        { blockers: preflight.blockers },
      );
    }
  }
  const results: Array<{
    inputAdId: string;
    adId?: string;
    creativeId?: string | null;
    ok: boolean;
    status?: string;
    attemptedIds?: string[];
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
  let haltedReason: { code: string; message: string } | null = null;

  try {
    for (let index = 0; index < ads.length; index += 1) {
      const ad = ads[index];
      if (!ad) continue;
      const stepName = ad.name || ad.adId;
      const targetResult =
        action === "resume"
          ? resumeTargets.get(ad.adId)!
          : await resolveBulkAdActionTarget({
              businessId: access.businessId,
              candidateAdIds: ad.candidateAdIds,
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
          attemptedIds: targetResult.attemptedIds,
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
      if (
        normalizeMetaLaunchProviderAccountId(
          targetResult.target.providerAccountId,
        ) !== providerAccountId
      ) {
        const error = {
          code: "provider_account_mismatch",
          message: "Ad does not belong to the selected Meta ad account.",
        };
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
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
          attemptedIds: targetResult.attemptedIds,
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

      const ctx = ctxResult.ctx;
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
          resolved_from_input_id: targetResult.inputAdId,
          candidate_ad_ids: ad.candidateAdIds,
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
          attemptedIds: targetResult.attemptedIds,
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
        if (result.error.code === "kill_switch_engaged") {
          haltedReason = result.error;
          break;
        }
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
        attemptedIds: targetResult.attemptedIds,
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
    return NextResponse.json(
      {
        ok: failedCount === 0 && !haltedReason,
        action,
        status: statusOption,
        results,
        steps,
        successCount,
        failedCount,
        halted: Boolean(haltedReason),
        haltedReason,
        omittedCount: ads.length - results.length,
        adIds: results.flatMap((result) => result.adId ?? []),
      },
      { status: haltedReason ? 503 : 200 },
    );
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
