import { NextRequest, NextResponse } from "next/server";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";
import { requireAdmin } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-logger";
import {
  cleanupGoogleAdsPartitionOrchestration,
  forceReplayGoogleAdsPoisonedPartitions,
  releaseGoogleAdsPoisonedPartitions,
  replayGoogleAdsDeadLetterPartitions,
} from "@/lib/google-ads/warehouse";
import { getAdminOperationsHealth } from "@/lib/admin-operations-health";
import { runGoogleAdsRepairCycle, runMetaRepairCycle } from "@/lib/sync/provider-repair-engine";
import {
  enqueueGoogleAdsScheduledWork,
  refreshGoogleAdsSyncStateForBusiness,
  runGoogleAdsTargetedRepair,
} from "@/lib/sync/google-ads-sync";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
  weakestGoogleAdsCompletion,
  type GoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import {
  GOOGLE_ADS_COMPLETION_LABELS,
  unknownGoogleAdsCompletion,
  type GoogleAdsCompletionVerdict,
} from "@/lib/google-ads/completion-semantics";
import { addDaysToIsoDateUtc } from "@/lib/provider-platform-date";
import {
  cleanupMetaPartitionOrchestration,
  getMetaAuthoritativeBusinessOpsSnapshot,
  replayMetaDeadLetterPartitions,
} from "@/lib/meta/warehouse";
import { enqueueMetaScheduledWork, refreshMetaSyncStateForBusiness } from "@/lib/sync/meta-sync";
import type { MetaWarehouseScope } from "@/lib/meta/warehouse-types";

const GOOGLE_ADS_RECOVERY_SCOPES: GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
  "ad_group_daily",
  "ad_daily",
  "keyword_daily",
  "search_term_daily",
  "asset_group_daily",
  "asset_daily",
  "audience_daily",
  "geo_daily",
  "device_daily",
  "product_daily",
];

const META_RECOVERY_SCOPES: MetaWarehouseScope[] = [
  "account_daily",
  "adset_daily",
  "creative_daily",
  "ad_daily",
];

/**
 * The scopes whose freshness decides whether a Google Ads business may be shown
 * as ready. These are the same four the admin row already counts "completed
 * days" for, so the operator sees a verdict about the numbers in front of them.
 */
const GOOGLE_ADS_FRESHNESS_SCOPES: GoogleAdsWarehouseScope[] = [
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_daily",
];

/** Fallback recent-frontier width when the health row does not carry one. */
const GOOGLE_ADS_DEFAULT_RECENT_RANGE_DAYS = 14;

/**
 * This endpoint iterates every business, so the freshness cost has to stay
 * O(businesses): ONE bulk read each, never one per scope or per date. A small
 * fan-out keeps the wall clock down without turning the health page into a
 * connection-pool event.
 */
const GOOGLE_ADS_FRESHNESS_CONCURRENCY = 4;
const GOOGLE_ADS_FRESHNESS_TIMEOUT_MS = 8_000;

type AdminSyncHealthPayload = Awaited<ReturnType<typeof getAdminOperationsHealth>>["syncHealth"];
type AdminGoogleAdsBusiness = NonNullable<AdminSyncHealthPayload["googleAdsBusinesses"]>[number];

/**
 * The wire shape this route publishes. Nothing is removed from the upstream
 * payload — operator-facing names and types survive verbatim — the Google Ads
 * freshness verdict is ADDED alongside them.
 */
type GoogleAdsFreshnessBusiness = AdminGoogleAdsBusiness & {
  googleAdsFreshness: GoogleAdsFreshnessSummary;
};

export type AdminSyncHealthFreshnessSummary = AdminSyncHealthPayload["summary"] & {
  googleAdsFreshnessState?: GoogleAdsFreshnessSummary["state"];
  googleAdsFreshnessLabel?: string;
  googleAdsFreshnessPercent?: number;
  googleAdsFreshnessComplete?: boolean;
  googleAdsFreshnessMayStopPolling?: boolean;
  googleAdsFreshnessDetail?: string;
  googleAdsFreshnessEvidenceAvailable?: boolean;
  googleAdsFreshnessRetryable?: boolean;
  googleAdsFreshnessBusinessesNotSettled?: number;
};

export type AdminSyncHealthFreshnessPayload = Omit<
  AdminSyncHealthPayload,
  "googleAdsBusinesses" | "summary"
> & {
  googleAdsBusinesses?: GoogleAdsFreshnessBusiness[];
  summary: AdminSyncHealthFreshnessSummary;
};

function toVerdict(summary: GoogleAdsFreshnessSummary): GoogleAdsCompletionVerdict {
  return {
    state: summary.state,
    percent: summary.percent,
    complete: summary.complete,
    mayStopPolling: summary.mayStopPolling,
    detail: summary.detail,
  };
}

function unknownFreshnessSummary(
  reason: string,
  startDate: string,
  endDate: string,
  totalDays: number,
): GoogleAdsFreshnessSummary {
  const verdict = unknownGoogleAdsCompletion(reason);
  return {
    evidenceAvailable: false,
    unavailableReason: reason,
    state: verdict.state,
    label: GOOGLE_ADS_COMPLETION_LABELS[verdict.state],
    percent: verdict.percent,
    complete: verdict.complete,
    mayStopPolling: verdict.mayStopPolling,
    detail: verdict.detail,
    startDate,
    endDate,
    totalDays,
    // Unknown clock: assume the range is still moving.
    includesOpenDay: true,
    timeZoneSource: "default",
    conversionLookbackDays: 0,
    scopes: [],
  };
}

/**
 * The last line of defence. If the augmentation itself fails, every Google Ads
 * business is published as `unknown` with both readiness flags forced false —
 * never as the upstream row-existence `true`.
 */
function failClosedGoogleAdsFreshness(
  payload: AdminSyncHealthPayload,
  reason = "Google Ads freshness evidence could not be evaluated.",
): AdminSyncHealthFreshnessPayload {
  const businesses = payload.googleAdsBusinesses ?? [];
  if (businesses.length === 0) return payload as AdminSyncHealthFreshnessPayload;
  const today = new Date().toISOString().slice(0, 10);
  const freshness = unknownFreshnessSummary(reason, today, today, 1);
  return {
    ...payload,
    googleAdsBusinesses: businesses.map((business) => ({
      ...business,
      googleAdsFreshness: freshness,
      recentExtendedReady: false,
      historicalExtendedReady: false,
    })),
    summary: {
      ...payload.summary,
      googleAdsFreshnessState: freshness.state,
      googleAdsFreshnessLabel: freshness.label,
      googleAdsFreshnessPercent: freshness.percent,
      googleAdsFreshnessComplete: false,
      googleAdsFreshnessMayStopPolling: false,
      googleAdsFreshnessDetail: freshness.detail,
      googleAdsFreshnessEvidenceAvailable: false,
      googleAdsFreshnessRetryable: true,
      googleAdsFreshnessBusinessesNotSettled: businesses.length,
    },
  };
}

/**
 * Attach the freshness verdict to the Google Ads health payload, and CORRECT
 * the readiness flags that were derived from row existence.
 *
 * `recentExtendedReady` and `historicalExtendedReady` upstream mean
 * "completed_days >= totalDays", where completed_days counts dates that have at
 * least one warehouse row. A date fetched once at 01:40 and never re-read
 * satisfies that forever, so the admin page rendered "Recent ready yes" over
 * numbers nobody had looked at since the day was still open. Both flags are now
 * conjunctive with the freshness verdict.
 *
 * The recent window is a SUBSET of the historical window, so a recent frontier
 * that has not been re-read post-close also disqualifies the historical claim —
 * gating both on the one recent read is conservative in the correct direction
 * and costs one query per business rather than two.
 *
 * Never throws, and never upgrades: any failure leaves an `unknown` verdict,
 * which is non-green, retryable, and not an error.
 */
async function withGoogleAdsFreshness(
  payload: AdminSyncHealthPayload,
  now = new Date(),
): Promise<AdminSyncHealthFreshnessPayload> {
  const businesses = payload.googleAdsBusinesses ?? [];
  // No Google Ads rows means there is nothing to make a claim about. The
  // payload passes through unchanged rather than gaining an empty array it
  // never had.
  if (businesses.length === 0) return payload as AdminSyncHealthFreshnessPayload;

  const endDate = now.toISOString().slice(0, 10);
  const summaries = new Map<string, GoogleAdsFreshnessSummary>();

  const queue = [...businesses];
  const workers = Array.from(
    { length: Math.min(GOOGLE_ADS_FRESHNESS_CONCURRENCY, queue.length) },
    async () => {
      for (let business = queue.shift(); business; business = queue.shift()) {
        const totalDays = Math.max(
          1,
          Number(business.recentRangeTotalDays ?? GOOGLE_ADS_DEFAULT_RECENT_RANGE_DAYS) ||
            GOOGLE_ADS_DEFAULT_RECENT_RANGE_DAYS,
        );
        const startDate = addDaysToIsoDateUtc(endDate, -(totalDays - 1));
        // One bulk read per business per pass. `readGoogleAdsFreshness` never
        // throws, but a throw here would still have to fail closed rather than
        // take the rest of the businesses down with it.
        let freshness: GoogleAdsFreshnessSummary;
        try {
          const snapshot = await readGoogleAdsFreshness({
            businessId: business.businessId,
            scopes: GOOGLE_ADS_FRESHNESS_SCOPES,
            startDate,
            endDate,
            now,
            timeoutMs: GOOGLE_ADS_FRESHNESS_TIMEOUT_MS,
          });
          freshness = snapshot
            ? toGoogleAdsFreshnessSummary(snapshot)
            : unknownFreshnessSummary(
                "Google Ads freshness evidence could not be read.",
                startDate,
                endDate,
                totalDays,
              );
        } catch {
          freshness = unknownFreshnessSummary(
            "Google Ads freshness evidence could not be read.",
            startDate,
            endDate,
            totalDays,
          );
        }
        summaries.set(business.businessId, freshness);
      }
    },
  );
  await Promise.all(workers);

  const nextBusinesses: GoogleAdsFreshnessBusiness[] = businesses.map((business) => {
    const freshness =
      summaries.get(business.businessId) ??
      unknownFreshnessSummary(
        "Google Ads freshness evidence was not evaluated for this business.",
        endDate,
        endDate,
        1,
      );
    return {
      ...business,
      googleAdsFreshness: freshness,
      // Corrected, never widened: an upstream `false` stays `false`.
      recentExtendedReady: business.recentExtendedReady === true && freshness.complete,
      historicalExtendedReady:
        business.historicalExtendedReady === true && freshness.complete,
    };
  });

  const verdicts = nextBusinesses.map((business) => toVerdict(business.googleAdsFreshness));
  const overall = weakestGoogleAdsCompletion(verdicts);
  const evidenceAvailable = nextBusinesses.every(
    (business) => business.googleAdsFreshness.evidenceAvailable,
  );

  return {
    ...payload,
    googleAdsBusinesses: nextBusinesses,
    summary: {
      ...payload.summary,
      googleAdsFreshnessState: overall.state,
      googleAdsFreshnessLabel: GOOGLE_ADS_COMPLETION_LABELS[overall.state],
      googleAdsFreshnessPercent: overall.percent,
      googleAdsFreshnessComplete: overall.complete,
      googleAdsFreshnessMayStopPolling: overall.mayStopPolling,
      googleAdsFreshnessDetail: overall.detail,
      googleAdsFreshnessEvidenceAvailable: evidenceAvailable,
      // `unknown` is neither healthy nor permanently failed: keep asking.
      googleAdsFreshnessRetryable: overall.state === "unknown",
      googleAdsFreshnessBusinessesNotSettled: verdicts.filter((verdict) => !verdict.complete)
        .length,
    },
  };
}

type SyncRecoveryRequestBody = {
  provider?: string;
  action?:
    | "cleanup"
    | "replay_dead_letter"
    | "reschedule"
    | "refresh_state"
    | "release_quarantine"
    | "force_manual_replay"
    | "targeted_repair"
    | "repair_cycle"
    | "repair_integrity_windows";
  businessId?: string;
  scope?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const adminSession = auth.session;

    const data = await getAdminOperationsHealth();
    // The health payload's Google Ads readiness is derived from row existence.
    // It is corrected here, at the wire boundary, so the admin page and any
    // operator script read the same verdict the scheduler reads.
    //
    // A freshness failure must degrade the CLAIM, not the endpoint: falling
    // through to a 500 would hide the queue, worker and dead-letter evidence an
    // operator needs precisely when something is wrong.
    const syncHealth = await withGoogleAdsFreshness(data.syncHealth).catch((error) => {
      console.error("[admin/sync-health GET] google_ads_freshness_failed", error);
      return failClosedGoogleAdsFreshness(data.syncHealth);
    });
    return NextResponse.json(syncHealth);
  } catch (err) {
    console.error("[admin/sync-health GET]", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let adminSession: Awaited<ReturnType<typeof requireAdmin>>["session"] | null = null;
  let body: SyncRecoveryRequestBody | null = null;
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    adminSession = auth.session;

    body = (await request.json().catch(() => null)) as SyncRecoveryRequestBody | null;

    if (!body?.provider || !body?.action || !body?.businessId) {
      return NextResponse.json(
        { error: "provider, action and businessId are required." },
        { status: 400 }
      );
    }

    async function logRecovery(outcome: "completed" | "rejected", meta?: Record<string, unknown>) {
      await logAdminAction({
        adminId: adminSession!.user.id,
        action: "sync.recovery",
        targetType: "business",
        targetId: body!.businessId,
        meta: {
          provider: body!.provider,
          requestedAction: body!.action,
          outcome,
          ...meta,
        },
      });
    }

    if (body.provider !== "google_ads" && body.provider !== "meta") {
      return NextResponse.json(
        { error: "Only google_ads and meta recovery actions are supported in this endpoint." },
        { status: 400 }
      );
    }

    // Admission BEFORE any recovery action.
    //
    // Every branch below mutates durable state: cleanup rewrites partition
    // orchestration, replay requeues dead letters, auto-repair writes incidents
    // and executions. Operator authority is not capacity authority — an admin
    // can be entirely entitled to run a recovery and the database still be over
    // budget or the lane quiesced for a cutover, and running it anyway is how a
    // maintenance window is undone by hand.
    try {
      assertSyncLaneEnabled(body.provider === "meta" ? "meta_sync" : "google_sync");
      await assertSyncGrowthBoundary("admin_sync_recovery", { fresh: true });
    } catch (error) {
      const refusal = describeSyncSafetyRefusal(error);
      await logRecovery("rejected", { refusal });
      return NextResponse.json(
        {
          error: refusal?.kind ?? "sync_recovery_refused",
          message:
            "Sync recovery is currently disabled or over capacity. No recovery action was performed.",
          refusal,
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 503 },
      );
    }

    if (body.provider === "meta") {
      if (body.action === "cleanup") {
        const result = await cleanupMetaPartitionOrchestration({
          businessId: body.businessId,
        });
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", { result });
        return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result, authoritative });
      }

      if (body.action === "replay_dead_letter") {
        const scope =
          body.scope && META_RECOVERY_SCOPES.includes(body.scope as MetaWarehouseScope)
            ? (body.scope as MetaWarehouseScope)
            : null;
        const result = await replayMetaDeadLetterPartitions({
          businessId: body.businessId,
          scope,
          recoveryKinds: ["replayable_transient"],
        });
        const scheduled = await enqueueMetaScheduledWork(body.businessId);
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", {
          scope,
          outcome: result.outcome,
          replayedCount: result.changedCount,
          matchedCount: result.matchedCount,
          skippedActiveLeaseCount: result.skippedActiveLeaseCount,
          scheduled,
        });
        return NextResponse.json({
          ok: true,
          action: body.action,
          provider: body.provider,
          replayedCount: result.changedCount,
          matchedCount: result.matchedCount,
          skippedActiveLeaseCount: result.skippedActiveLeaseCount,
          result: result.partitions,
          outcome: result.outcome,
          scheduled,
          authoritative,
        });
      }

      if (body.action === "refresh_state") {
        await refreshMetaSyncStateForBusiness({ businessId: body.businessId });
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed");
        return NextResponse.json({ ok: true, action: body.action, provider: body.provider, authoritative });
      }

      if (body.action === "reschedule") {
        const result = await enqueueMetaScheduledWork(body.businessId);
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", { result });
        return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result, authoritative });
      }

      if (body.action === "repair_cycle" || body.action === "repair_integrity_windows") {
        const result = await runMetaRepairCycle(body.businessId, {
          enqueueScheduledWork: body.action === "repair_cycle",
          queueWarehouseRepairs: true,
        });
        const authoritative = await getMetaAuthoritativeBusinessOpsSnapshot({
          businessId: body.businessId,
        }).catch(() => null);
        await logRecovery("completed", { result });
        return NextResponse.json({
          ok: true,
          action: body.action,
          provider: body.provider,
          result,
          authoritative,
        });
      }
    }

    if (body.action === "cleanup") {
      const result = await cleanupGoogleAdsPartitionOrchestration({
        businessId: body.businessId,
      });
      await logRecovery("completed", { result });
      return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result });
    }

    if (body.action === "replay_dead_letter") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      const result = await replayGoogleAdsDeadLetterPartitions({
        businessId: body.businessId,
        scope,
        recoveryKinds: ["replayable_transient", "unknown"],
      });
      const scheduled = await enqueueGoogleAdsScheduledWork(body.businessId);
      await logRecovery("completed", {
        scope,
        outcome: result.outcome,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        scheduled,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        result: result.partitions,
        outcome: result.outcome,
        scheduled,
      });
    }

    if (body.action === "refresh_state") {
      await refreshGoogleAdsSyncStateForBusiness({ businessId: body.businessId });
      await logRecovery("completed");
      return NextResponse.json({ ok: true, action: body.action, provider: body.provider });
    }

    if (body.action === "release_quarantine") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      const result = await releaseGoogleAdsPoisonedPartitions({
        businessId: body.businessId,
        scope,
      });
      await logRecovery("completed", {
        scope,
        outcome: result.outcome,
        releasedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        releasedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        result: result.partitions,
        outcome: result.outcome,
      });
    }

    if (body.action === "force_manual_replay") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      const result = await forceReplayGoogleAdsPoisonedPartitions({
        businessId: body.businessId,
        scope,
      });
      const scheduled = await enqueueGoogleAdsScheduledWork(body.businessId);
      await logRecovery("completed", {
        scope,
        outcome: result.outcome,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        scheduled,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        replayedCount: result.changedCount,
        matchedCount: result.matchedCount,
        skippedActiveLeaseCount: result.skippedActiveLeaseCount,
        result: result.partitions,
        outcome: result.outcome,
        scheduled,
      });
    }

    if (body.action === "reschedule") {
      const result = await enqueueGoogleAdsScheduledWork(body.businessId);
      await logRecovery("completed", { result });
      return NextResponse.json({ ok: true, action: body.action, provider: body.provider, result });
    }

    if (body.action === "targeted_repair") {
      const scope =
        body.scope && GOOGLE_ADS_RECOVERY_SCOPES.includes(body.scope as GoogleAdsWarehouseScope)
          ? (body.scope as GoogleAdsWarehouseScope)
          : null;
      if (!scope || !body.startDate || !body.endDate) {
        return NextResponse.json(
          { error: "scope, startDate and endDate are required for targeted_repair." },
          { status: 400 }
        );
      }

      const result = await runGoogleAdsTargetedRepair({
        businessId: body.businessId,
        scope,
        startDate: body.startDate,
        endDate: body.endDate,
      });
      await logRecovery("completed", {
        scope,
        startDate: body.startDate,
        endDate: body.endDate,
        result,
      });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        result,
      });
    }

    if (body.action === "repair_cycle" || body.action === "repair_integrity_windows") {
      const result = await runGoogleAdsRepairCycle(body.businessId, {
        enqueueScheduledWork: body.action === "repair_cycle",
        queueWarehouseRepairs: true,
      });
      await logRecovery("completed", { result });
      return NextResponse.json({
        ok: true,
        action: body.action,
        provider: body.provider,
        result,
      });
    }

    await logRecovery("rejected");
    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (err) {
    if (adminSession?.user.id && body?.provider && body?.action && body?.businessId) {
      await logAdminAction({
        adminId: adminSession.user.id,
        action: "sync.recovery",
        targetType: "business",
        targetId: body.businessId,
        meta: {
          provider: body.provider,
          requestedAction: body.action,
          outcome: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => null);
    }
    console.error("[admin/sync-health POST]", err);
    return NextResponse.json(
      { error: "internal_error", message: String(err) },
      { status: 500 }
    );
  }
}
