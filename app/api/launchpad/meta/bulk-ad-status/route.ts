import { NextRequest, NextResponse } from "next/server";
import {
  completeDecisionOriginMetaAdsActionLog,
  completeMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  createMetaAdsActionLog,
  hasRecentPendingMetaAdsAction,
  readLaunchpadCreatedAdIds,
  resolveExactMetaAdActionTarget,
  resolveMetaAdActionTarget,
  type MetaAdsActionStatus,
} from "@/lib/meta/ads-action-log";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  validateDecisionOriginAdExecutionRequest,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";
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
  contractVersion?: string;
  businessId?: string;
  providerAccountId?: string;
  action?: BulkAdStatusAction;
  ads?: Array<{
    contractVersion?: string;
    adId?: string | null;
    providerAccountId?: string | null;
    snapshotId?: string | null;
    evaluationId?: string | null;
    engineVersion?: string | null;
    decisionHash?: string | null;
    action?: string | null;
    idempotencyKey?: string | null;
    dryRun?: boolean;
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
  decisionOrigin: boolean;
}) {
  const completion = {
    id: input.logId,
    status: getFailureLogStatus(input.result),
    payloadResponse: ensureRecord(input.result.responsePayload),
    errorCode: input.result.error.code,
    errorMessage: input.result.error.message,
    resultingAdId: input.result.resultingAdId ?? null,
    durationMs: Date.now() - input.startedAt,
    verificationPayload: ensureRecord(input.result.verificationPayload),
  };
  return input.decisionOrigin
    ? completeDecisionOriginMetaAdsActionLog(completion)
    : completeMetaAdsActionLog({
        ...completion,
        verifiedAt: input.result.verificationPayload
          ? new Date().toISOString()
          : null,
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
      decisionOriginRequest: DecisionOriginAdExecutionRequest | null;
      decisionOriginPayload: NonNullable<BulkAdStatusBody["ads"]>[number];
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
      decisionOriginRequest: null,
      decisionOriginPayload: ad,
    });
  });
  return Array.from(byAdId.values());
}

function bindDecisionOriginRequests(input: {
  body: BulkAdStatusBody | null;
  businessId: string;
  action: BulkAdStatusAction;
  ads: ReturnType<typeof normalizeAds>;
}):
  | { ok: true; decisionOrigin: boolean }
  | { ok: false; blockers: Array<Record<string, unknown>> } {
  const decisionOrigin = Boolean(
    input.body?.contractVersion ||
      input.ads.some((ad) => {
        const payload = ad.decisionOriginPayload;
        return Boolean(
          payload.contractVersion ||
            payload.snapshotId ||
            payload.evaluationId ||
            payload.engineVersion ||
            payload.decisionHash ||
            payload.idempotencyKey,
        );
      }),
  );
  if (!decisionOrigin) return { ok: true, decisionOrigin: false };
  const blockers: Array<Record<string, unknown>> = [];
  if (
    input.body?.contractVersion !==
    DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
  ) {
    blockers.push({ code: "invalid_bulk_contract_version" });
  }
  const seen = new Map<string, string>();
  input.ads.forEach((ad) => {
    const payload = ad.decisionOriginPayload;
    const request: DecisionOriginAdExecutionRequest = {
      contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
      businessId: input.businessId,
      providerAccountId:
        payload.providerAccountId?.trim() ||
        input.body?.providerAccountId?.trim() ||
        "",
      adId: payload.adId?.trim() || "",
      snapshotId: payload.snapshotId?.trim() || "",
      evaluationId: payload.evaluationId?.trim() || "",
      engineVersion: payload.engineVersion?.trim() || "",
      decisionHash: payload.decisionHash?.trim() || "",
      action: payload.action?.trim() || "",
      idempotencyKey: payload.idempotencyKey?.trim() || "",
      creativeId: payload.creativeId?.trim() || null,
      ...(payload.dryRun === true ? { dryRun: true } : {}),
    };
    const requestBlockers = validateDecisionOriginAdExecutionRequest(request);
    if (
      payload.contractVersion !==
      DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
    ) {
      requestBlockers.push("unsupported_action");
    }
    if (request.action !== input.action) {
      requestBlockers.push("unsupported_action");
    }
    if (
      ad.candidateAdIds.length !== 1 ||
      ad.candidateAdIds[0] !== request.adId
    ) {
      blockers.push({
        adId: ad.adId,
        code: "decision_origin_candidate_fallback_forbidden",
      });
    }
    const priorKey = seen.get(request.adId);
    if (priorKey && priorKey !== request.idempotencyKey) {
      blockers.push({
        adId: request.adId,
        code: "conflicting_decision_lineage",
      });
    }
    seen.set(request.adId, request.idempotencyKey);
    if (requestBlockers.length > 0) {
      blockers.push({
        adId: ad.adId,
        code: "invalid_decision_origin_lineage",
        blockers: Array.from(new Set(requestBlockers)),
      });
      return;
    }
    ad.decisionOriginRequest = request;
  });
  return blockers.length > 0
    ? { ok: false, blockers }
    : { ok: true, decisionOrigin: true };
}

async function resolveBulkAdActionTarget(input: {
  businessId: string;
  candidateAdIds: string[];
  decisionOriginRequest?: DecisionOriginAdExecutionRequest | null;
}) {
  if (input.decisionOriginRequest) {
    const targetResult = await resolveExactMetaAdActionTarget({
      businessId: input.businessId,
      providerAccountId: input.decisionOriginRequest.providerAccountId,
      adId: input.decisionOriginRequest.adId,
    });
    return targetResult.ok
      ? {
          ok: true as const,
          inputAdId: input.decisionOriginRequest.adId,
          attemptedIds: [input.decisionOriginRequest.adId],
          target: targetResult.target,
        }
      : {
          ok: false as const,
          attemptedIds: [input.decisionOriginRequest.adId],
        };
  }
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
  const decisionOriginBinding = bindDecisionOriginRequests({
    body,
    businessId: access.businessId,
    action,
    ads,
  });
  if (!decisionOriginBinding.ok) {
    return jsonError(
      400,
      "invalid_decision_origin_batch",
      "Every decision-origin ad must carry one exact native lineage.",
      { blockers: decisionOriginBinding.blockers },
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
  if (
    decisionOriginBinding.decisionOrigin &&
    ads.some(
      (ad) =>
        ad.decisionOriginRequest?.providerAccountId !== providerAccountId,
    )
  ) {
    return jsonError(
      400,
      "provider_account_mismatch",
      "Decision-origin batch lineage does not match the selected Meta account.",
    );
  }
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
          decisionOriginRequest: ad.decisionOriginRequest,
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
              decisionOriginRequest: ad.decisionOriginRequest,
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
      const payloadRequest = {
          idempotency_key: idempotencyKey,
          method: "POST",
          endpoint: `/${resolvedAdId}`,
          body: { status: statusOption },
          input_ad_id: ad.adId,
          resolved_from_input_id: targetResult.inputAdId,
          candidate_ad_ids: ad.candidateAdIds,
        };
      const log = ad.decisionOriginRequest
        ? await createDecisionOriginMetaAdsActionLog({
            request: ad.decisionOriginRequest,
            requestedBy: access.userId,
            payloadRequest,
          })
        : await createMetaAdsActionLog({
            businessId: access.businessId,
            adId: resolvedAdId,
            creativeId: targetResult.target.creativeId ?? ad.creativeId,
            action,
            requestedBy: access.userId,
            payloadRequest,
          });

      const startedAt = Date.now();
      const result =
        action === "pause"
          ? ad.decisionOriginRequest?.dryRun === true
            ? await pauseAd(ctx, resolvedAdId, { dryRun: true })
            : await pauseAd(ctx, resolvedAdId)
          : ad.decisionOriginRequest?.dryRun === true
            ? await resumeAd(ctx, resolvedAdId, { dryRun: true })
            : await resumeAd(ctx, resolvedAdId);

      if (!result.ok) {
        await completeFailure({
          logId: log.id,
          startedAt,
          result,
          decisionOrigin: Boolean(ad.decisionOriginRequest),
        });
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

      const successCompletion = {
        id: log.id,
        status: "success" as const,
        payloadResponse: ensureRecord(result.responsePayload),
        durationMs: Date.now() - startedAt,
        verificationPayload: ensureRecord(result.verificationPayload),
      };
      if (ad.decisionOriginRequest) {
        await completeDecisionOriginMetaAdsActionLog(successCompletion);
      } else {
        await completeMetaAdsActionLog({
          ...successCompletion,
          verifiedAt: new Date().toISOString(),
        });
      }
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
