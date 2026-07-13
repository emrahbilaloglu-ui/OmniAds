import { NextRequest, NextResponse } from "next/server";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { evaluateAndPersistGoogleAdsControlPlane } from "@/lib/google-ads/control-plane-runtime";
import { enqueueMetaScheduledWork } from "@/lib/sync/meta-sync";
import { enqueueGoogleAdsScheduledWork } from "@/lib/sync/google-ads-sync";
import { runMetaSnapshotJobIfDue } from "@/lib/meta/scheduled";
import { runMetaDecisionIgnoredMarkerIfDue } from "@/lib/meta/decision-responses";
import { runMetaOutcomeAccrualIfDue } from "@/lib/meta/outcome-accrual";
import { syncGA4Reports } from "@/lib/sync/ga4-sync";
import { syncSearchConsoleReports } from "@/lib/sync/search-console-sync";
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

  const businesses = await getActiveBusinesses().catch((err) => {
    console.error("[sync-cron] fetch_businesses_failed", err);
    return [] as Awaited<ReturnType<typeof getActiveBusinesses>>;
  });

  if (businesses.length === 0) {
    return NextResponse.json({ ok: true, synced: 0, message: "No active businesses." });
  }

  const results = await Promise.allSettled(
    businesses.map(async (business) => {
      const [gads, ga4, sc, metaScheduled, shopify] = await Promise.allSettled([
        enqueueGoogleAdsScheduledWork(business.id),
        syncGA4Reports(business.id),
        syncSearchConsoleReports(business.id),
        enqueueMetaScheduledWork(business.id),
        shopifySyncEnabled()
          ? syncShopifyCommerceReports(business.id)
          : Promise.resolve({ skipped: true, reason: "disabled" }),
      ]);

      return {
        businessId: business.id,
        businessName: business.name,
        googleAds: gads.status === "fulfilled" ? gads.value : { error: String((gads as PromiseRejectedResult).reason) },
        ga4: ga4.status === "fulfilled" ? ga4.value : { error: String((ga4 as PromiseRejectedResult).reason) },
        searchConsole: sc.status === "fulfilled" ? sc.value : { error: String((sc as PromiseRejectedResult).reason) },
        meta: metaScheduled.status === "fulfilled"
          ? metaScheduled.value
          : { error: String((metaScheduled as PromiseRejectedResult).reason) },
        shopify: shopify.status === "fulfilled"
          ? shopify.value
          : { error: String((shopify as PromiseRejectedResult).reason) },
      };
    }),
  );

  const summary = results.map((r) =>
    r.status === "fulfilled" ? r.value : { error: String(r.reason) }
  );
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
      return NextResponse.json(
        {
          ok: false,
          synced: businesses.length,
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

  logRuntimeInfo("sync-cron", "completed", {
    businessCount: businesses.length,
    succeeded: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
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
  });
  return NextResponse.json(
    {
      ok: true,
      synced: businesses.length,
      results: summary,
      ...(soakGate ? { soakGate } : {}),
      ...(gateVerdicts ? { gateVerdicts } : {}),
      ...(repairPlan ? { repairPlan } : {}),
      ...(googleGateVerdicts ? { googleGateVerdicts } : {}),
      ...(googleRepairPlan ? { googleRepairPlan } : {}),
      ...(metaAutoRepair ? { metaAutoRepairResults: metaAutoRepair.results } : {}),
      ...(googleAutoRepair ? { googleAutoRepairResults: googleAutoRepair.results } : {}),
      metaSnapshotJob,
      metaIgnoredMarkerJob,
      metaOutcomeAccrualJob,
      decisionProducerJob,
      nativeAdShadowJob,
      decisionOutcomesJob,
      nativeAdOutcomesJob,
    },
    { status: soakGate?.outcome === "fail" ? 503 : 200 }
  );
}
