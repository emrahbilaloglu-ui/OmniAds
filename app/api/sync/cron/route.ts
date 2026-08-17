import { runProductInstrumentationRetentionIfDue } from "@/lib/product-instrumentation";
import { runNotificationProducerIfDue } from "@/lib/notification-producer";
import { NextRequest, NextResponse } from "next/server";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { readActiveBusinesses } from "@/lib/sync/active-businesses";
import { evaluateAndPersistGoogleAdsControlPlane } from "@/lib/google-ads/control-plane-runtime";
import { enqueueMetaScheduledWork } from "@/lib/sync/meta-sync";
import { enqueueGoogleAdsScheduledWork } from "@/lib/sync/google-ads-sync";
import {
  describeLaneOutcome,
  describeSyncSafetyRefusal,
} from "@/lib/sync/safety-refusal";
import { runMetaSnapshotJobIfDue } from "@/lib/meta/scheduled";
import { runMetaDecisionIgnoredMarkerIfDue } from "@/lib/meta/decision-responses";
import { runMetaOutcomeAccrualIfDue } from "@/lib/meta/outcome-accrual";
import { syncGA4Reports } from "@/lib/sync/ga4-sync";
import { syncSearchConsoleReports } from "@/lib/sync/search-console-sync";
import { syncKlaviyoFlowMetrics } from "@/lib/klaviyo/sync";
import { syncShopifyCommerceReports } from "@/lib/sync/shopify-sync";
import { runSyncSoakGate } from "@/lib/sync/soak-gate";
import {
  runAdDecisionOutcomesJobForActiveBusinessesIfDue,
  runDecisionOutcomesJobForActiveBusinessesIfDue,
  runEngineV3ProducerChainForActiveBusinessesIfDue,
  runNativeAdShadowChainForActiveBusinessesIfDue,
} from "@/lib/creative-decision-engine";
import {
  evaluateAndPersistSyncGates,
  shouldEnforceSyncGateFailure,
} from "@/lib/sync/release-gates";
import { evaluateAndPersistSyncRepairPlan } from "@/lib/sync/repair-planner";
import { executeAutoSyncRepairPlan } from "@/lib/sync/repair-executor";
import { logRuntimeInfo } from "@/lib/runtime-logging";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
  weakestGoogleAdsCompletion,
  type GoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import {
  GOOGLE_ADS_COMPLETION_LABELS,
  unknownGoogleAdsCompletion,
} from "@/lib/google-ads/completion-semantics";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import { addDaysToIsoDateUtc } from "@/lib/provider-platform-date";
import { runMetaAdDuplicateReconciliationSweep } from "@/lib/meta/duplicate-ad-reconciliation";

/**
 * POST /api/sync/cron
 *
 * Proactively syncs Google Ads, GA4, Search Console, and Meta data for all
 * active (non-demo) businesses. Should be called every 10 minutes via
 * Any external scheduler or system cron.
 *
 * Protected by CRON_SECRET bearer token.
 */

function shopifySyncEnabled() {
  const raw = process.env.SHOPIFY_SYNC_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * The Google Ads scopes the scheduler is answerable for on every tick, and the
 * window it must keep re-reading.
 *
 * The cron used to publish a receipt built entirely from enqueue outcomes:
 * `ok: true, synced: 13` said the calls returned, never whether any day in the
 * recent window had been looked at since it closed. An operator reading a green
 * cron receipt and a green admin page was reading two different questions, and
 * neither of them was "is this data still being refreshed?".
 *
 * The verdict below is the SAME one `/api/admin/sync-health` renders and the
 * same one the status route serves, read through the one shared bulk read.
 */
const GOOGLE_ADS_CRON_FRESHNESS_SCOPES: GoogleAdsWarehouseScope[] = [
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_daily",
];
const GOOGLE_ADS_CRON_FRESHNESS_WINDOW_DAYS = 14;
const GOOGLE_ADS_CRON_FRESHNESS_TIMEOUT_MS = 8_000;

function unknownGoogleAdsCronFreshness(
  reason: string,
  startDate: string,
  endDate: string,
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
    totalDays: GOOGLE_ADS_CRON_FRESHNESS_WINDOW_DAYS,
    includesOpenDay: true,
    timeZoneSource: "default",
    conversionLookbackDays: 0,
    scopes: [],
  };
}

/**
 * ONE bulk freshness read for one business. Never throws and never returns a
 * green default: a business that was deleted, disconnected, or whose connection
 * generation moved under us reads `unknown`, which keeps the day due rather
 * than quietly retiring it.
 */
async function readGoogleAdsCronFreshness(
  businessId: string,
  now: Date,
): Promise<GoogleAdsFreshnessSummary> {
  const endDate = now.toISOString().slice(0, 10);
  const startDate = addDaysToIsoDateUtc(
    endDate,
    -(GOOGLE_ADS_CRON_FRESHNESS_WINDOW_DAYS - 1),
  );
  // try/catch, not `.catch`: a per-business lane must not be able to reject
  // just because the evidence read misbehaved. A rejected lane loses the OTHER
  // providers' outcomes from the receipt too.
  try {
    const snapshot = await readGoogleAdsFreshness({
      businessId,
      scopes: GOOGLE_ADS_CRON_FRESHNESS_SCOPES,
      startDate,
      endDate,
      now,
      timeoutMs: GOOGLE_ADS_CRON_FRESHNESS_TIMEOUT_MS,
    });
    if (!snapshot) {
      return unknownGoogleAdsCronFreshness(
        "Google Ads freshness evidence could not be read.",
        startDate,
        endDate,
      );
    }
    return toGoogleAdsFreshnessSummary(snapshot);
  } catch {
    return unknownGoogleAdsCronFreshness(
      "Google Ads freshness evidence could not be read.",
      startDate,
      endDate,
    );
  }
}

/** Outstanding re-reads for a business, from the verdict rather than from rows. */
function googleAdsFreshnessDueNowDays(freshness: GoogleAdsFreshnessSummary) {
  if (freshness.scopes.length === 0) return freshness.totalDays;
  return Math.max(...freshness.scopes.map((scope) => scope.dueNowDays));
}

function isTruthyQueryParam(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function normalizeProviderScope(value: string | null) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "meta";
}

function isSupportedControlPlaneProviderScope(
  value: string,
): value is "meta" | "google_ads" {
  return value === "meta" || value === "google_ads";
}

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const url = new URL(request.url);
  const controlPlaneOnly = isTruthyQueryParam(url.searchParams.get("controlPlaneOnly"));
  const requestedBuildId = url.searchParams.get("buildId")?.trim() || undefined;
  const providerScope = normalizeProviderScope(url.searchParams.get("providerScope"));
  const breakGlass = isTruthyQueryParam(url.searchParams.get("breakGlass"));
  const enforceDeployGate = isTruthyQueryParam(url.searchParams.get("enforceDeployGate"));
  const overrideReason = url.searchParams.get("overrideReason")?.trim() || null;

  if (controlPlaneOnly) {
    if (!isSupportedControlPlaneProviderScope(providerScope)) {
      return NextResponse.json(
        {
          ok: false,
          controlPlaneOnly: true,
          providerScope,
          error: "unsupported_provider_scope",
        },
        { status: 400 },
      );
    }

    const gateVerdicts = await (
      providerScope === "google_ads"
        ? evaluateAndPersistGoogleAdsControlPlane({
            buildId: requestedBuildId,
            breakGlass,
            overrideReason,
          })
        : evaluateAndPersistSyncGates({
            buildId: requestedBuildId,
            breakGlass,
            overrideReason,
          })
    ).catch((error) => {
      console.error("[sync-cron] control_plane_gate_evaluation_failed", error);
      return null;
    });

    if (!gateVerdicts) {
      return NextResponse.json(
        {
          ok: false,
          controlPlaneOnly: true,
          providerScope,
          error: "gate_evaluation_failed",
        },
        { status: 500 },
      );
    }

    let repairPlan = await evaluateAndPersistSyncRepairPlan({
      buildId: requestedBuildId,
      providerScope,
      releaseGate: gateVerdicts.releaseGate,
      planMode: "auto_execute",
    }).catch((error) => {
      console.error("[sync-cron] control_plane_repair_plan_failed", error);
      return null;
    });

    if (!repairPlan) {
      return NextResponse.json(
        {
          ok: false,
          controlPlaneOnly: true,
          providerScope,
          gateVerdicts,
          error: "repair_plan_failed",
        },
        { status: 500 },
      );
    }

    const autoRepair =
      repairPlan.recommendations.length > 0
        ? await executeAutoSyncRepairPlan({
            buildId: requestedBuildId,
            providerScope,
            source: "cron",
            consumeQueuedMetaWork: providerScope === "meta",
            releaseGate: gateVerdicts.releaseGate,
            repairPlan,
          }).catch((error) => {
            console.error("[sync-cron] control_plane_auto_repair_failed", error);
            return null;
          })
        : null;

    const responseGateVerdicts =
      autoRepair?.releaseGate != null
        ? {
            ...gateVerdicts,
            releaseGate: autoRepair.releaseGate,
          }
        : gateVerdicts;
    if (autoRepair?.repairPlan) {
      repairPlan = autoRepair.repairPlan;
    }

    const blocked =
      enforceDeployGate && shouldEnforceSyncGateFailure([responseGateVerdicts.deployGate]);
    return NextResponse.json(
      {
        ok: !blocked,
        controlPlaneOnly: true,
        providerScope,
        gateVerdicts: responseGateVerdicts,
        repairPlan,
        autoRepairResults: autoRepair?.results ?? [],
      },
      { status: blocked ? 503 : 200 },
    );
  }

  // Global admission BEFORE any work, not after it.
  //
  // Every job below writes: the duplicate-ad reconciliation sweep, the snapshot
  // jobs, the repair planner and its auto-execute, the outcome accrual chains.
  // They ran first and the refusal was reported at the END, so a cron firing
  // during a cutover quiesce or over a full disk performed a complete pass and
  // then announced that it should not have. Refusing here means a due cron
  // under global-off does zero snapshot, repair and reconciliation writes.
  try {
    assertSyncLaneEnabled("cron_enqueue");
    await assertSyncGrowthBoundary("sync_cron_tick", { fresh: true });
  } catch (error) {
    const refusal = describeSyncSafetyRefusal(error);
    return NextResponse.json(
      {
        ok: false,
        error: refusal?.kind ?? "sync_cron_refused",
        message:
          "The sync cron is currently disabled or over capacity. No work was performed.",
        refusal,
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }

  // Safety-branch (e41691f33) bounded GET-only duplicate-ad sweep. It starts
  // only after the global admission gate above, because it writes.
  const duplicateAdReconciliationPromise = runMetaAdDuplicateReconciliationSweep({
    limit: 3,
  }).catch((error) => {
    console.error("[sync-cron] duplicate_ad_reconciliation_failed", error);
    return {
      scanned: 0,
      reconciled: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  });

  // "Could not read the business list" is NOT "there are no businesses".
  // Coercing a failed read to [] made a total sync outage answer ok:true with
  // HTTP 200 — a truthful-looking receipt for a cycle that did nothing — and it
  // also skipped the gate/repair block below, so the very mechanism that would
  // later reveal the outage stopped running at the same moment.
  const businessRead = await readActiveBusinesses();

  if (!businessRead.ok) {
    console.error("[sync-cron] fetch_businesses_failed", {
      reason: businessRead.reason,
      message: businessRead.message,
    });
    // Settle the in-flight sweep before responding: no background work may
    // escape the request lifecycle (safety branch e41691f33).
    const duplicateAdReconciliation = await duplicateAdReconciliationPromise;
    return NextResponse.json(
      {
        ok: false,
        error: "business_list_unreadable",
        reason: businessRead.reason,
        message:
          "The active-business list could not be read. No sync work was attempted.",
        detail: businessRead.message,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        synced: 0,
        duplicateAdReconciliation,
      },
      { status: 503 },
    );
  }

  const businesses = businessRead.businesses;

  if (businesses.length === 0) {
    // A genuine zero stays a success — unchanged.
    const duplicateAdReconciliation = await duplicateAdReconciliationPromise;
    return NextResponse.json({
      ok: true,
      synced: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      message: "No active businesses.",
      duplicateAdReconciliation,
    });
  }

  const cronStartedAt = new Date();
  const results = await Promise.allSettled(
    businesses.map(async (business) => {
      const [gads, ga4, sc, metaScheduled, shopify, klaviyo] =
        await Promise.allSettled([
          enqueueGoogleAdsScheduledWork(business.id),
          syncGA4Reports(business.id),
          syncSearchConsoleReports(business.id),
          enqueueMetaScheduledWork(business.id),
          shopifySyncEnabled()
            ? syncShopifyCommerceReports(business.id)
            : Promise.resolve({ skipped: true, reason: "disabled" }),
          // Klaviyo rides the same `source_ingest` lane as GA4 and Search
          // Console, refuses itself when that lane is off, and skips silently
          // for every business that has not connected Klaviyo.
          syncKlaviyoFlowMetrics(business.id),
        ]);

      // Read AFTER the enqueue so the receipt describes the state the tick
      // leaves behind. One bulk read per business per pass — never one per
      // scope and never one per date.
      const googleAdsFreshness = await readGoogleAdsCronFreshness(
        business.id,
        cronStartedAt,
      );

      // Classify each lane while the rejection is still an OBJECT. Stringifying
      // first is lossy in exactly the wrong direction: a capacity refusal, a
      // disabled lane and an unreadable authority all become an ordinary
      // message and the route answers 200.
      const lanes = {
        googleAds: describeLaneOutcome(gads),
        ga4: describeLaneOutcome(ga4),
        searchConsole: describeLaneOutcome(sc),
        meta: describeLaneOutcome(metaScheduled),
        shopify: describeLaneOutcome(shopify),
        klaviyo: describeLaneOutcome(klaviyo),
      };
      return {
        businessId: business.id,
        businessName: business.name,
        googleAds: lanes.googleAds.value,
        ga4: lanes.ga4.value,
        searchConsole: lanes.searchConsole.value,
        meta: lanes.meta.value,
        shopify: lanes.shopify.value,
        klaviyo: lanes.klaviyo.value,
        // The scheduler publishes the same verdict the UI shows, so a worker
        // can never stop for one reason while the admin page claims another.
        googleAdsFreshness,
        googleAdsDueNowDays: googleAdsFreshnessDueNowDays(googleAdsFreshness),
        safetyRefusals: Object.entries(lanes).flatMap(([lane, outcome]) =>
          outcome.refusal ? [{ lane, businessId: business.id, ...outcome.refusal }] : [],
        ),
        // Ordinary lane errors are deliberately not safety refusals, but they
        // are still failures. Without this the receipt reported `synced: 13`
        // when every lane of every business had thrown.
        laneFailures: Object.entries(lanes).flatMap(([lane, outcome]) => {
          const value = outcome.value as
            | { error?: unknown; failed?: unknown; attempted?: unknown }
            | null;
          if (!value || typeof value !== "object") return [];
          if ("error" in value && value.error) {
            return [{ lane, message: String(value.error) }];
          }
          // A lane that RESOLVED while failing every window is still a failure.
          // GA4 and Search Console catch their per-window errors internally and
          // return `{ attempted, succeeded, failed }` with no `error` key, so
          // keying only off `error` reported ok:true and full success while both
          // lanes had failed every window for every business.
          if (typeof value.failed === "number" && value.failed > 0) {
            const attempted =
              typeof value.attempted === "number" ? value.attempted : null;
            return [
              {
                lane,
                message: `${value.failed}${attempted === null ? "" : ` of ${attempted}`} window(s) failed`,
              },
            ];
          }
          return [];
        }),
      };
    }),
  );

  const summary = results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          ...(describeSyncSafetyRefusal(r.reason)
            ? { safetyRefusal: describeSyncSafetyRefusal(r.reason) }
            : {}),
        },
  );

  // `synced` used to be `businesses.length` — the size of the INPUT list, which
  // nothing ever decremented, so thirteen businesses whose every lane threw
  // still reported `synced: 13`. It now counts businesses that came back clean;
  // `attempted` carries the old meaning. Computed here so every exit below
  // reports the same numbers.
  const businessFailures = results.flatMap((result, index) => {
    if (result.status === "rejected") {
      return [
        {
          businessId: businesses[index]?.id ?? null,
          lanes: [{ lane: "business", message: String(result.reason) }],
        },
      ];
    }
    const entry = result.value as {
      businessId?: string;
      laneFailures?: Array<{ lane: string; message: string }>;
    };
    return entry.laneFailures?.length
      ? [{ businessId: entry.businessId ?? null, lanes: entry.laneFailures }]
      : [];
  });
  const attempted = businesses.length;
  const failed = businessFailures.length;
  const succeeded = attempted - failed;
  // A cron tick that enqueued cleanly still has outstanding work whenever any
  // day in the window has not been re-read since it closed. Rolling the weakest
  // verdict up keeps `ok: true` from reading as "Google Ads is caught up": the
  // receipt now carries `mayStopPolling: false` alongside it.
  const googleAdsFreshnessByBusiness = results.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    const entry = result.value as { googleAdsFreshness?: GoogleAdsFreshnessSummary };
    return entry.googleAdsFreshness ? [entry.googleAdsFreshness] : [];
  });
  const googleAdsOverallVerdict =
    googleAdsFreshnessByBusiness.length > 0
      ? weakestGoogleAdsCompletion(
          googleAdsFreshnessByBusiness.map((freshness) => ({
            state: freshness.state,
            percent: freshness.percent,
            complete: freshness.complete,
            mayStopPolling: freshness.mayStopPolling,
            detail: freshness.detail,
          })),
        )
      : unknownGoogleAdsCompletion(
          "No Google Ads freshness evidence was produced by this cron pass.",
        );
  const googleAdsFreshnessReceipt = {
    state: googleAdsOverallVerdict.state,
    label: GOOGLE_ADS_COMPLETION_LABELS[googleAdsOverallVerdict.state],
    percent: googleAdsOverallVerdict.percent,
    complete: googleAdsOverallVerdict.complete,
    mayStopPolling: googleAdsOverallVerdict.mayStopPolling,
    detail: googleAdsOverallVerdict.detail,
    // `unknown` is neither healthy nor terminal: the next tick must look again.
    retryable: googleAdsOverallVerdict.state === "unknown",
    evidenceAvailable:
      googleAdsFreshnessByBusiness.length > 0 &&
      googleAdsFreshnessByBusiness.every((freshness) => freshness.evidenceAvailable),
    businessesNotSettled: googleAdsFreshnessByBusiness.filter(
      (freshness) => !freshness.complete,
    ).length,
    dueNowDays: googleAdsFreshnessByBusiness.reduce(
      (total, freshness) => total + googleAdsFreshnessDueNowDays(freshness),
      0,
    ),
  };
  // Refusals are collected from the STRUCTURED classification carried on each
  // per-business result, plus any whole-business rejection. Nothing is
  // recovered by re-parsing a string.
  const safetyRefusals = [
    ...results.flatMap((result) => {
      if (result.status === "rejected") {
        const refusal = describeSyncSafetyRefusal(result.reason);
        return refusal ? [{ lane: "business", ...refusal }] : [];
      }
      const entry = result.value as { safetyRefusals?: unknown };
      return Array.isArray(entry?.safetyRefusals) ? entry.safetyRefusals : [];
    }),
  ] as Array<Record<string, unknown>>;
  // Notification production, scheduled with the other maintenance jobs.
  //
  // The producer and the whole delivery lifecycle existed but nothing invoked
  // them, which made the ledger's two statements about notifications both
  // half-true: the transitions shipped, and no notification was ever produced.
  // A bell backed by a producer that never runs is the reassuring-zero problem
  // in a different costume -- it would read "0 unread" and mean "nothing can
  // generate these", not "nothing is wrong".
  //
  // Hourly, gated inside the producer by a per-day dedupe key, so a re-run
  // cannot re-alert. Failures are caught and reported in the receipt rather
  // than taking the sync cycle down with them.
  const notificationProducerJob = await runNotificationProducerIfDue(
    businesses.map((business) => business.id),
  ).catch(() => ({ skipped: false as const, businesses: 0, created: 0, failed: true as const }));

  // Product instrumentation retention: idempotent, and scheduled here with the
  // other maintenance jobs so a retention column is backed by an actual purge.
  const instrumentationRetentionJob =
    await runProductInstrumentationRetentionIfDue().catch(() => ({
      skipped: false as const,
      day: new Date().toISOString().slice(0, 10),
      purged: 0,
      failed: true as const,
    }));

  const metaSnapshotJob = await runMetaSnapshotJobIfDue().catch((error) => {
    console.error("[sync-cron] meta_snapshot_job_failed", error);
    return {
      skipped: true,
      reason: "failed" as const,
      snapshotDate: new Date().toISOString().slice(0, 10),
      error: error instanceof Error ? error.message : String(error),
    };
  });
  const metaIgnoredMarkerJob = await runMetaDecisionIgnoredMarkerIfDue().catch((error) => {
    console.error("[sync-cron] meta_decision_ignored_marker_failed", error);
    return {
      skipped: true,
      reason: "failed" as const,
      snapshotDate: new Date().toISOString().slice(0, 10),
      error: error instanceof Error ? error.message : String(error),
    };
  });
  const metaOutcomeAccrualJob = await runMetaOutcomeAccrualIfDue().catch((error) => {
    console.error("[sync-cron] meta_outcome_accrual_failed", error);
    return {
      skipped: true,
      reason: "failed" as const,
      runDate: new Date().toISOString().slice(0, 10),
      error: error instanceof Error ? error.message : String(error),
    };
  });
  const decisionProducerJob = await runEngineV3ProducerChainForActiveBusinessesIfDue(
    new Date(),
  ).catch((error) => {
    console.error("[sync-cron] decision_producer_job_failed", error);
    return {
      skipped: true,
      reason: "failed" as const,
      asOf: new Date().toISOString().slice(0, 10),
      error: error instanceof Error ? error.message : String(error),
    };
  });
  if (!decisionProducerJob.skipped && "results" in decisionProducerJob) {
    for (const result of decisionProducerJob.results ?? []) {
      for (const [job, jobResult] of [
        ["calibration", result.calibration],
        ["lifecycle", result.lifecycle],
        ["decisions", result.decisions],
      ] as const) {
        if (jobResult.status === "failed") {
          console.error("[sync-cron] decision_producer_business_job_failed", {
            businessId: result.businessId,
            businessName: result.businessName,
            job,
            jobRunId: jobResult.jobRunId,
            errorMessage: jobResult.errorMessage ?? null,
          });
        }
      }
    }
  }
  const nativeAdShadowJob = await runNativeAdShadowChainForActiveBusinessesIfDue(
    new Date(),
    businesses,
  ).catch((error) => {
    console.error("[sync-cron] native_ad_shadow_job_failed", error);
    return {
      skipped: true,
      reason: "failed" as const,
      asOf: new Date().toISOString().slice(0, 10),
      error: error instanceof Error ? error.message : String(error),
    };
  });
  if (!nativeAdShadowJob.skipped && "results" in nativeAdShadowJob) {
    for (const result of nativeAdShadowJob.results ?? []) {
      for (const [job, step] of [
        ["calibration", result.calibration],
        ["decisions", result.decisions],
        ["operator_response", result.operatorResponse],
      ] as const) {
        if (step.status === "failed") {
          console.error("[sync-cron] native_ad_shadow_business_job_failed", {
            businessId: result.businessId,
            businessName: result.businessName,
            job,
            jobRunId: step.result?.jobRunId ?? null,
            errorMessage: step.errorMessage,
          });
        }
      }
    }
  }
  const decisionOutcomesJob = await runDecisionOutcomesJobForActiveBusinessesIfDue(
    new Date(),
    businesses,
  ).catch((error) => {
    console.error("[sync-cron] decision_outcomes_job_failed", error);
    return {
      skipped: true,
      reason: "failed" as const,
      asOf: new Date().toISOString().slice(0, 10),
      error: error instanceof Error ? error.message : String(error),
    };
  });
  const nativeAdOutcomesJob = await runAdDecisionOutcomesJobForActiveBusinessesIfDue(
    new Date(),
    businesses,
  ).catch((error) => {
    console.error("[sync-cron] native_ad_outcomes_job_failed", error);
    return {
      skipped: true,
      reason: "failed" as const,
      asOf: new Date().toISOString().slice(0, 10),
      error: error instanceof Error ? error.message : String(error),
    };
  });

  const shouldEnforceSoakGate =
    process.env.SYNC_CRON_ENFORCE_SOAK_GATE?.trim() === "true";
  let soakGate: Awaited<ReturnType<typeof runSyncSoakGate>>["result"] | null = null;

  if (shouldEnforceSoakGate) {
    try {
      const soakRun = await runSyncSoakGate();
      soakGate = soakRun.result;
      if (soakGate.outcome !== "pass") {
        console.error("[sync-cron] soak_gate_failed", {
          releaseReadiness: soakGate.releaseReadiness,
          blockingChecks: soakGate.blockingChecks.map((check) => check.key),
          topIssue: soakGate.topIssue,
        });
      }
    } catch (error) {
      console.error("[sync-cron] soak_gate_error", error);
      await duplicateAdReconciliationPromise;
      return NextResponse.json(
        {
          ok: false,
          synced: succeeded,
          attempted,
          succeeded,
          failed,
          ...(failed > 0 ? { businessFailures } : {}),
          results: summary,
          soakGate: {
            outcome: "fail",
            releaseReadiness: "blocked",
            summary: "Sync soak gate execution failed.",
            error: String(error),
          },
        },
        { status: 500 }
      );
    }
  }

  let gateVerdicts = await evaluateAndPersistSyncGates().catch((error) => {
    console.error("[sync-cron] sync_gate_evaluation_failed", error);
    return null;
  });
  let repairPlan = await evaluateAndPersistSyncRepairPlan({
    providerScope: "meta",
    releaseGate: gateVerdicts?.releaseGate ?? null,
    planMode: "auto_execute",
  }).catch((error) => {
    console.error("[sync-cron] sync_repair_plan_failed", error);
    return null;
  });
  const metaAutoRepair =
    gateVerdicts && repairPlan && repairPlan.recommendations.length > 0
      ? await executeAutoSyncRepairPlan({
          providerScope: "meta",
          source: "cron",
          consumeQueuedMetaWork: true,
          releaseGate: gateVerdicts.releaseGate,
          repairPlan,
        }).catch((error) => {
          console.error("[sync-cron] meta_auto_repair_failed", error);
          return null;
        })
      : null;
  if (metaAutoRepair?.releaseGate) {
    gateVerdicts = {
      ...gateVerdicts!,
      releaseGate: metaAutoRepair.releaseGate,
    };
  }
  if (metaAutoRepair?.repairPlan) {
    repairPlan = metaAutoRepair.repairPlan;
  }

  let googleGateVerdicts = await evaluateAndPersistGoogleAdsControlPlane().catch((error) => {
    console.error("[sync-cron] google_control_plane_evaluation_failed", error);
    return null;
  });
  let googleRepairPlan = await evaluateAndPersistSyncRepairPlan({
    providerScope: "google_ads",
    releaseGate: googleGateVerdicts?.releaseGate ?? null,
    planMode: "auto_execute",
  }).catch((error) => {
    console.error("[sync-cron] google_sync_repair_plan_failed", error);
    return null;
  });
  const googleAutoRepair =
    googleGateVerdicts && googleRepairPlan && googleRepairPlan.recommendations.length > 0
      ? await executeAutoSyncRepairPlan({
          providerScope: "google_ads",
          source: "cron",
          releaseGate: googleGateVerdicts.releaseGate,
          repairPlan: googleRepairPlan,
        }).catch((error) => {
          console.error("[sync-cron] google_auto_repair_failed", error);
          return null;
        })
      : null;
  if (googleAutoRepair?.releaseGate) {
    googleGateVerdicts = {
      ...googleGateVerdicts!,
      releaseGate:
        googleAutoRepair.releaseGate as NonNullable<
          typeof googleGateVerdicts
        >["releaseGate"],
    };
  }
  if (googleAutoRepair?.repairPlan) {
    googleRepairPlan = googleAutoRepair.repairPlan;
  }

  const duplicateAdReconciliation =
    await duplicateAdReconciliationPromise;
  logRuntimeInfo("sync-cron", "completed", {
    businessCount: businesses.length,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
    googleAdsFreshnessState: googleAdsFreshnessReceipt.state,
    googleAdsFreshnessComplete: googleAdsFreshnessReceipt.complete,
    googleAdsFreshnessMayStopPolling: googleAdsFreshnessReceipt.mayStopPolling,
    googleAdsFreshnessDueNowDays: googleAdsFreshnessReceipt.dueNowDays,
    googleAdsBusinessesNotSettled: googleAdsFreshnessReceipt.businessesNotSettled,
    soakGateOutcome: soakGate?.outcome ?? null,
    deployGateVerdict: gateVerdicts?.deployGate?.verdict ?? null,
    releaseGateVerdict: gateVerdicts?.releaseGate?.verdict ?? null,
    repairPlanEligible: repairPlan?.eligible ?? null,
    repairRecommendationCount: repairPlan?.recommendations.length ?? null,
    googleReleaseGateVerdict: googleGateVerdicts?.releaseGate?.verdict ?? null,
    googleRepairRecommendationCount: googleRepairPlan?.recommendations.length ?? null,
    metaSnapshotJobSkipped: metaSnapshotJob.skipped,
    metaSnapshotJobReason: "reason" in metaSnapshotJob ? metaSnapshotJob.reason : null,
    metaIgnoredMarkerJobSkipped: metaIgnoredMarkerJob.skipped,
    metaIgnoredMarkerJobReason:
      "reason" in metaIgnoredMarkerJob ? metaIgnoredMarkerJob.reason : null,
    metaOutcomeAccrualJobSkipped: metaOutcomeAccrualJob.skipped,
    metaOutcomeAccrualJobReason:
      "reason" in metaOutcomeAccrualJob ? metaOutcomeAccrualJob.reason : null,
    decisionProducerJobSkipped: decisionProducerJob.skipped,
    decisionProducerJobReason:
      "reason" in decisionProducerJob ? decisionProducerJob.reason : null,
    nativeAdShadowJobSkipped: nativeAdShadowJob.skipped,
    nativeAdShadowJobReason:
      "reason" in nativeAdShadowJob ? nativeAdShadowJob.reason : null,
    decisionOutcomesJobSkipped: decisionOutcomesJob.skipped,
    decisionOutcomesJobReason:
      "reason" in decisionOutcomesJob ? decisionOutcomesJob.reason : null,
    nativeAdOutcomesJobSkipped: nativeAdOutcomesJob.skipped,
    nativeAdOutcomesJobReason:
      "reason" in nativeAdOutcomesJob ? nativeAdOutcomesJob.reason : null,
    duplicateAdReconciliationScanned: duplicateAdReconciliation.scanned,
    duplicateAdReconciliationReconciled:
      duplicateAdReconciliation.reconciled,
  });
  const safetyRefused = safetyRefusals.length > 0;

  return NextResponse.json(
    {
      ok: !safetyRefused,
      ...(safetyRefused
        ? {
            error: "sync_safety_refused",
            safetyRefusals,
          }
        : {}),
      synced: succeeded,
      attempted,
      succeeded,
      failed,
      ...(failed > 0 ? { businessFailures } : {}),
      googleAdsFreshness: googleAdsFreshnessReceipt,
      results: summary,
      ...(soakGate ? { soakGate } : {}),
      ...(gateVerdicts ? { gateVerdicts } : {}),
      ...(repairPlan ? { repairPlan } : {}),
      ...(googleGateVerdicts ? { googleGateVerdicts } : {}),
      ...(googleRepairPlan ? { googleRepairPlan } : {}),
      ...(metaAutoRepair ? { metaAutoRepairResults: metaAutoRepair.results } : {}),
      ...(googleAutoRepair ? { googleAutoRepairResults: googleAutoRepair.results } : {}),
      instrumentationRetentionJob,
      notificationProducerJob,
      metaSnapshotJob,
      metaIgnoredMarkerJob,
      metaOutcomeAccrualJob,
      decisionProducerJob,
      nativeAdShadowJob,
      decisionOutcomesJob,
      nativeAdOutcomesJob,
      duplicateAdReconciliation,
    },
    {
      status:
        soakGate?.outcome === "fail" || safetyRefused
          ? 503
          : 200,
    }
  );
}
