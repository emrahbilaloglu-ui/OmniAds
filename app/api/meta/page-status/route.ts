import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDemoMetaStatus } from "@/lib/demo-business";
import {
  readMetaBusinessDataPosture,
  type MetaBusinessDataPosture,
} from "@/lib/meta/business-data-posture";
import { metaPostureUnavailable } from "@/app/api/meta/read-posture";
import { getMetaAccountContext } from "@/lib/meta/account-context";
import { isMetaAuthoritativeFinalizationV2EnabledForBusiness } from "@/lib/meta/authoritative-finalization-config";
import { dayCountInclusive } from "@/lib/meta/history";
import {
  buildMetaCoreReadiness,
  buildMetaExtendedCompleteness,
  rollupMetaPageReadiness,
} from "@/lib/meta/page-readiness";
import { getMetaPartialReason, getMetaRangePreparationContext } from "@/lib/meta/readiness";
import type {
  MetaPageSelectedRangeMode,
  MetaStatusResponse,
  MetaSurfaceReadiness,
} from "@/lib/meta/status-types";
import { getMetaHistoricalVerificationReason } from "@/lib/meta/historical-verification";
import {
  getLatestMetaSyncHealth,
  getMetaAccountDailyCoverage,
  getMetaCampaignDailyCoverage,
  getMetaQueueHealth,
} from "@/lib/meta/warehouse";
import { getMetaSelectedRangeTruthReadiness } from "@/lib/sync/meta-sync";
import { readThroughCache } from "@/lib/server-cache";
import { getTodayIsoForTimeZoneServer } from "@/lib/provider-platform-date";

export const dynamic = "force-dynamic";

const META_PAGE_STATUS_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.META_PAGE_STATUS_CACHE_TTL_MS ?? 5_000) || 5_000
);

function shouldBypassMetaPageStatusCache() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function buildMetaPageStatusCacheKey(input: {
  businessId: string;
  startDate: string | null;
  endDate: string | null;
}) {
  return [
    "meta-page-status:v1",
    input.businessId,
    input.startDate ?? "recent",
    input.endDate ?? "recent",
  ].join(":");
}

function clampPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function toNumberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function buildPageSurfaceState(input: {
  connected: boolean;
  hasAssignedAccounts: boolean;
  ready: boolean;
  activeProgress: boolean;
  blockedReason?: string | null;
}): MetaSurfaceReadiness["state"] {
  if (!input.connected || !input.hasAssignedAccounts) return "not_connected";
  if (input.blockedReason) return "blocked";
  if (input.ready) return "ready";
  if (input.activeProgress) return "syncing";
  return "partial";
}

function buildMetaDomainReadiness(input: {
  summaryReady: boolean;
  campaignsReady: boolean;
}) {
  const availableSurfaces = [
    input.summaryReady ? "account_daily" : null,
    input.campaignsReady ? "campaign_daily" : null,
  ].filter((surface): surface is string => Boolean(surface));
  const blockingSurfaces = [
    input.summaryReady ? null : "account_daily",
    input.campaignsReady ? null : "campaign_daily",
  ].filter((surface): surface is string => Boolean(surface));

  return {
    coreSurfacesReady: availableSurfaces,
    deepSurfacesPending: [],
    blockingSurfaces,
    summary:
      blockingSurfaces.length > 0
        ? "Core spend and campaign summary are still syncing."
        : null,
  };
}

function getSelectedRangeMode(input: {
  isSelectedCurrentDay: boolean;
  withinAuthoritativeHistory: boolean;
}): MetaPageSelectedRangeMode {
  if (input.isSelectedCurrentDay) return "current_day_live";
  return input.withinAuthoritativeHistory
    ? "historical_warehouse"
    : "historical_live_fallback";
}

function createOptionalSurface(
  connected: boolean,
  hasAssignedAccounts: boolean,
  coreReady: boolean,
  activeProgress: boolean,
  readyReason: string,
  pendingReason: string
): MetaSurfaceReadiness {
  return {
    state: buildPageSurfaceState({
      connected,
      hasAssignedAccounts,
      ready: coreReady,
      activeProgress,
    }),
    blocking: false,
    countsForPageCompleteness: false,
    truthClass: "deterministic_decision_engine",
    reason: !connected
      ? "Meta integration is not connected."
      : !hasAssignedAccounts
        ? "No Meta ad account is assigned to this workspace."
        : coreReady
          ? readyReason
          : pendingReason,
  };
}

async function buildMetaPageStatus(input: {
  businessId: string;
  startDate: string | null;
  endDate: string | null;
  /*
   * Read once by the handler and passed down, rather than read again here.
   *
   * It is also read BEFORE the cache, which is the point: a posture check
   * inside this builder would be skipped entirely on a cache hit, and a
   * workspace whose flag stopped being readable would keep being served the
   * live payload the last readable request produced.
   */
  posture: MetaBusinessDataPosture;
}): Promise<MetaStatusResponse> {
  if (input.posture === "demo") {
    return getDemoMetaStatus() as MetaStatusResponse;
  }

  const accountContext = await getMetaAccountContext(input.businessId);
  const connected = accountContext.connected;
  const assignedAccountIds = accountContext.accountIds;
  const hasAssignedAccounts = assignedAccountIds.length > 0;
  const currentDateInTimezone =
    accountContext.primaryAccountTimezone
      ? getTodayIsoForTimeZoneServer(accountContext.primaryAccountTimezone)
      : null;
  const rangeContext =
    input.startDate && input.endDate
      ? await getMetaRangePreparationContext({
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
        })
      : null;
  const selectedRangeMode = rangeContext
    ? getSelectedRangeMode({
        isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
        withinAuthoritativeHistory: rangeContext.withinAuthoritativeHistory,
      })
    : "historical_warehouse";

  const shouldCheckHistoricalTruth =
    Boolean(
      connected &&
        hasAssignedAccounts &&
        input.startDate &&
        input.endDate &&
        rangeContext &&
        !rangeContext.isSelectedCurrentDay &&
        rangeContext.withinAuthoritativeHistory
    );
  const shouldUseHistoricalCoverage = Boolean(
    connected &&
      hasAssignedAccounts &&
      input.startDate &&
      input.endDate &&
      rangeContext &&
      !rangeContext.isSelectedCurrentDay &&
      rangeContext.withinAuthoritativeHistory
  );
  const truthValidationEnabled = shouldCheckHistoricalTruth
    ? isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId)
    : false;

  const [
    queueHealth,
    latestSync,
    selectedRangeTruth,
    accountCoverage,
    campaignCoverage,
  ] = await Promise.all([
    getMetaQueueHealth({ businessId: input.businessId }).catch(() => null),
    getLatestMetaSyncHealth({ businessId: input.businessId }).catch(() => null),
    shouldCheckHistoricalTruth
      ? getMetaSelectedRangeTruthReadiness({
          businessId: input.businessId,
          startDate: input.startDate!,
          endDate: rangeContext?.selectedRangeTruthEndDate ?? input.endDate!,
        }).catch(() => null)
      : Promise.resolve(null),
    shouldUseHistoricalCoverage
      ? getMetaAccountDailyCoverage({
          businessId: input.businessId,
          startDate: input.startDate!,
          endDate: rangeContext?.selectedRangeTruthEndDate ?? input.endDate!,
        }).catch(() => null)
      : Promise.resolve(null),
    shouldUseHistoricalCoverage
      ? getMetaCampaignDailyCoverage({
          businessId: input.businessId,
          startDate: input.startDate!,
          endDate: rangeContext?.selectedRangeTruthEndDate ?? input.endDate!,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const activeProgress =
    (queueHealth?.queueDepth ?? 0) > 0 || (queueHealth?.leasedPartitions ?? 0) > 0;
  const selectedRangeTotalDays =
    input.startDate && input.endDate
      ? dayCountInclusive(
          input.startDate,
          rangeContext?.selectedRangeTruthEndDate ?? input.endDate
        )
      : 0;
  const summaryCoverageReady =
    shouldUseHistoricalCoverage &&
    selectedRangeTotalDays > 0 &&
    (accountCoverage?.completed_days ?? 0) >= selectedRangeTotalDays;
  const campaignsCoverageReady =
    shouldUseHistoricalCoverage &&
    selectedRangeTotalDays > 0 &&
    (campaignCoverage?.completed_days ?? 0) >= selectedRangeTotalDays;
  const truthReady = truthValidationEnabled
    ? Boolean(selectedRangeTruth?.truthReady)
    : true;
  const summaryReady =
    selectedRangeMode === "historical_live_fallback"
      ? connected && hasAssignedAccounts
      : selectedRangeMode === "current_day_live"
        ? false
        : Boolean(summaryCoverageReady && truthReady);
  const campaignsReady =
    selectedRangeMode === "historical_live_fallback"
      ? connected && hasAssignedAccounts
      : selectedRangeMode === "current_day_live"
        ? false
        : Boolean(campaignsCoverageReady && truthReady);
  const verificationReason =
    truthValidationEnabled && selectedRangeTruth && !selectedRangeTruth.truthReady
      ? getMetaHistoricalVerificationReason({
          verificationState:
            selectedRangeTruth.verificationState ?? selectedRangeTruth.state ?? null,
          fallbackReason:
            rangeContext && input.startDate && input.endDate
              ? getMetaPartialReason({
                  isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
                  currentDateInTimezone: rangeContext.currentDateInTimezone,
                  primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                  defaultReason:
                    "Summary and campaign data are still being prepared for the selected range.",
                })
              : "Summary and campaign data are still being prepared for the selected range.",
        })
      : null;
  const currentDayReason =
    rangeContext && input.startDate && input.endDate
      ? getMetaPartialReason({
          isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
          currentDateInTimezone: rangeContext.currentDateInTimezone,
          primaryAccountTimezone: rangeContext.primaryAccountTimezone,
          defaultReason: "Current-day Meta data is still being prepared.",
        })
      : "Current-day Meta data is still being prepared.";
  const blockingReason =
    selectedRangeMode === "historical_warehouse" ? verificationReason : null;

  const summarySurface: MetaSurfaceReadiness = {
    state: buildPageSurfaceState({
      connected,
      hasAssignedAccounts,
      ready: summaryReady,
      activeProgress,
      blockedReason: blockingReason,
    }),
    blocking: !summaryReady,
    countsForPageCompleteness: true,
    truthClass:
      selectedRangeMode === "current_day_live"
        ? "current_day_live"
        : selectedRangeMode === "historical_live_fallback"
          ? "historical_live_fallback"
          : "historical_warehouse",
    reason: !connected
      ? "Meta integration is not connected."
      : !hasAssignedAccounts
        ? "No Meta ad account is assigned to this workspace."
        : selectedRangeMode === "current_day_live"
          ? currentDayReason
          : blockingReason ??
            (!summaryReady
              ? "Summary data is still being prepared for the selected range."
              : null),
  };

  const campaignsSurface: MetaSurfaceReadiness = {
    state: buildPageSurfaceState({
      connected,
      hasAssignedAccounts,
      ready: campaignsReady,
      activeProgress,
      blockedReason: blockingReason,
    }),
    blocking: !campaignsReady,
    countsForPageCompleteness: true,
    truthClass: summarySurface.truthClass,
    reason:
      summarySurface.reason ??
      (!campaignsReady
        ? "Campaign data is still being prepared for the selected range."
        : null),
  };

  const breakdownReason =
    selectedRangeMode === "current_day_live"
      ? "Supporting breakdowns load when the context drawer is opened."
      : "Supporting breakdowns load on demand after core surfaces are ready.";
  const breakdownSurface: MetaSurfaceReadiness = {
    state: buildPageSurfaceState({
      connected,
      hasAssignedAccounts,
      ready: summaryReady && campaignsReady,
      activeProgress,
    }),
    blocking: false,
    countsForPageCompleteness: false,
    truthClass:
      selectedRangeMode === "current_day_live"
        ? "current_day_live"
        : "historical_warehouse",
    reason: !connected
      ? "Meta integration is not connected."
      : !hasAssignedAccounts
        ? "No Meta ad account is assigned to this workspace."
        : breakdownReason,
  };

  const requiredSurfaces = {
    summary: summarySurface,
    campaigns: campaignsSurface,
    "breakdowns.age": breakdownSurface,
    "breakdowns.location": breakdownSurface,
    "breakdowns.placement": breakdownSurface,
  } as const;

  const corePercent =
    selectedRangeMode === "current_day_live"
      ? toNumberOrNull((latestSync as Record<string, unknown> | null)?.progress_percent) ??
        (activeProgress ? 25 : 0)
      : selectedRangeTotalDays
        ? (Math.min(
            accountCoverage?.completed_days ?? 0,
            campaignCoverage?.completed_days ?? 0
          ) /
            Math.max(1, selectedRangeTotalDays)) *
          100
        : summaryReady && campaignsReady
          ? 100
          : 0;

  const coreReadiness = buildMetaCoreReadiness({
    connected,
    hasAssignedAccounts,
    percent: clampPercent(summaryReady && campaignsReady ? 100 : corePercent),
    summary: null,
    surfaces: {
      summary: summarySurface,
      campaigns: campaignsSurface,
    },
  });
  coreReadiness.summary =
    coreReadiness.reason ??
    (!connected
      ? "Meta integration is not connected."
      : !hasAssignedAccounts
        ? "No Meta ad account is assigned to this workspace."
        : coreReadiness.complete
          ? selectedRangeMode === "current_day_live"
            ? "Current-day Meta core surfaces are available."
            : "Selected-range Meta core surfaces are ready."
          : selectedRangeMode === "current_day_live"
            ? currentDayReason
            : "Selected-range Meta core surfaces are still preparing.");

  const extendedCompleteness = buildMetaExtendedCompleteness({
    connected,
    hasAssignedAccounts,
    percent: summaryReady && campaignsReady ? 100 : activeProgress ? 50 : 0,
    summary: null,
    surfaces: {
      "breakdowns.age": breakdownSurface,
      "breakdowns.location": breakdownSurface,
      "breakdowns.placement": breakdownSurface,
    },
  });
  extendedCompleteness.summary =
    extendedCompleteness.reason ??
    (!connected
      ? "Meta integration is not connected."
      : !hasAssignedAccounts
        ? "No Meta ad account is assigned to this workspace."
        : "Supporting breakdowns remain lazy and load on demand.");

  const pageReadiness = rollupMetaPageReadiness({
    connected,
    hasAssignedAccounts,
    selectedRangeMode,
    requiredSurfaces,
    optionalSurfaces: {
      adsets: {
        state: connected && hasAssignedAccounts ? "ready" : "not_connected",
        blocking: false,
        countsForPageCompleteness: false,
        truthClass: "conditional_drilldown",
        reason: connected && hasAssignedAccounts
          ? "Ad set drilldown loads when a campaign is selected."
          : !connected
            ? "Meta integration is not connected."
            : "No Meta ad account is assigned to this workspace.",
      },
      recommendations: createOptionalSurface(
        connected,
        hasAssignedAccounts,
        coreReadiness.complete,
        activeProgress,
        "Recommendations are available when analysis is requested.",
        "Recommendations remain optional while core surfaces settle."
      ),
      operating_mode: createOptionalSurface(
        connected,
        hasAssignedAccounts,
        coreReadiness.complete,
        activeProgress,
        "Operating mode loads on demand with supporting context.",
        "Operating mode remains optional while core surfaces settle."
      ),
      decision_os: createOptionalSurface(
        connected,
        hasAssignedAccounts,
        coreReadiness.complete,
        activeProgress,
        "Decision OS is available when analysis is requested.",
        "Decision OS remains optional while core surfaces settle."
      ),
    },
  });

  const state: MetaStatusResponse["state"] = !connected
    ? "not_connected"
    : !hasAssignedAccounts
      ? "connected_no_assignment"
      : blockingReason
        ? "action_required"
        : coreReadiness.complete
          ? "ready"
          : activeProgress
            ? "syncing"
            : "partial";

  const latestSyncProgressPercent = latestSync
    ? toNumberOrNull((latestSync as Record<string, unknown>).progress_percent)
    : null;
  const latestSyncReadyThroughDate =
    latestSync && toStringOrNull((latestSync as Record<string, unknown>).end_date)
      ? toStringOrNull((latestSync as Record<string, unknown>).end_date)?.slice(0, 10) ?? null
      : null;
  const latestSyncResponse: MetaStatusResponse["latestSync"] = latestSync
    ? {
        id: toStringOrNull((latestSync as Record<string, unknown>).id),
        status:
          toStringOrNull((latestSync as Record<string, unknown>).status) ?? undefined,
        syncType: toStringOrNull((latestSync as Record<string, unknown>).sync_type),
        scope: toStringOrNull((latestSync as Record<string, unknown>).scope),
        startDate:
          toStringOrNull((latestSync as Record<string, unknown>).start_date)?.slice(0, 10) ??
          null,
        endDate:
          toStringOrNull((latestSync as Record<string, unknown>).end_date)?.slice(0, 10) ??
          null,
        triggerSource: toStringOrNull((latestSync as Record<string, unknown>).trigger_source),
        triggeredAt: toStringOrNull((latestSync as Record<string, unknown>).triggered_at),
        startedAt: toStringOrNull((latestSync as Record<string, unknown>).started_at),
        finishedAt: toStringOrNull((latestSync as Record<string, unknown>).finished_at),
        lastError: toStringOrNull((latestSync as Record<string, unknown>).last_error),
        progressPercent:
          latestSyncProgressPercent ??
          (state === "ready" ? 100 : clampPercent(corePercent)),
        completedDays:
          selectedRangeMode === "current_day_live"
            ? 0
            : Math.min(
                accountCoverage?.completed_days ?? 0,
                campaignCoverage?.completed_days ?? 0
              ),
        totalDays: selectedRangeTotalDays || (input.startDate === input.endDate ? 1 : 0),
        readyThroughDate: latestSyncReadyThroughDate,
      }
    : undefined;

  return {
    state,
    connected,
    assignedAccountIds,
    primaryAccountTimezone: rangeContext?.primaryAccountTimezone ?? accountContext.primaryAccountTimezone,
    currentDateInTimezone: rangeContext?.currentDateInTimezone ?? currentDateInTimezone,
    readinessLevel: coreReadiness.complete
      ? "ready"
      : coreReadiness.usable
        ? "usable"
        : "partial",
    domainReadiness: buildMetaDomainReadiness({
      summaryReady,
      campaignsReady,
    }),
    latestSync: latestSyncResponse,
    coreReadiness,
    extendedCompleteness,
    pageReadiness,
    warehouse: {
      rowCount: 0,
      firstDate: null,
      lastDate: null,
      coverage: {
        historical: null,
        selectedRange:
          input.startDate && input.endDate
            ? {
                startDate: input.startDate,
                endDate:
                  rangeContext?.selectedRangeTruthEndDate ??
                  input.endDate,
                completedDays:
                  Math.min(
                    accountCoverage?.completed_days ?? 0,
                    campaignCoverage?.completed_days ?? 0
                  ) ??
                  0,
                totalDays:
                  selectedRangeTotalDays ||
                  (input.startDate === input.endDate ? 1 : 0),
                readyThroughDate: latestSyncResponse?.readyThroughDate ?? null,
                isComplete: coreReadiness.complete,
              }
            : null,
        scopes: [],
        accountDaily:
          accountCoverage && selectedRangeTotalDays > 0
            ? {
                completedDays: accountCoverage.completed_days ?? 0,
                totalDays: selectedRangeTotalDays,
                readyThroughDate: accountCoverage.ready_through_date ?? null,
              }
            : null,
        campaignDaily:
          campaignCoverage && selectedRangeTotalDays > 0
            ? {
                completedDays: campaignCoverage.completed_days ?? 0,
                totalDays: selectedRangeTotalDays,
                readyThroughDate: campaignCoverage.ready_through_date ?? null,
              }
            : null,
        adsetDaily: null,
        breakdowns: null,
        creatives: null,
        pendingSurfaces: pageReadiness.missingRequiredSurfaces,
      },
    },
    jobHealth: {
      runningJobs: 0,
      staleRunningJobs: 0,
      queueDepth: queueHealth?.queueDepth ?? 0,
      leasedPartitions: queueHealth?.leasedPartitions ?? 0,
      retryableFailedPartitions: queueHealth?.retryableFailedPartitions ?? 0,
      deadLetterPartitions: queueHealth?.deadLetterPartitions ?? 0,
      oldestQueuedPartition: queueHealth?.oldestQueuedPartition ?? null,
      latestCoreActivityAt: queueHealth?.latestCoreActivityAt ?? null,
      latestExtendedActivityAt: queueHealth?.latestExtendedActivityAt ?? null,
      latestMaintenanceActivityAt: queueHealth?.latestMaintenanceActivityAt ?? null,
      historicalCoreQueueDepth: queueHealth?.historicalCoreQueueDepth ?? 0,
      historicalCoreLeasedPartitions: queueHealth?.historicalCoreLeasedPartitions ?? 0,
      extendedRecentQueueDepth: queueHealth?.extendedRecentQueueDepth ?? 0,
      extendedRecentLeasedPartitions: queueHealth?.extendedRecentLeasedPartitions ?? 0,
      extendedHistoricalQueueDepth: queueHealth?.extendedHistoricalQueueDepth ?? 0,
      extendedHistoricalLeasedPartitions:
        queueHealth?.extendedHistoricalLeasedPartitions ?? 0,
    },
  };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const posture = await readMetaBusinessDataPosture(businessId);
  if (posture !== "live" && posture !== "demo") {
    return metaPostureUnavailable("meta_page_status");
  }

  const load = () =>
    buildMetaPageStatus({
      businessId,
      startDate,
      endDate,
      posture,
    });
  const payload = shouldBypassMetaPageStatusCache()
    ? await load()
    : await readThroughCache({
        key: buildMetaPageStatusCacheKey({ businessId, startDate, endDate }),
        ttlMs: META_PAGE_STATUS_CACHE_TTL_MS,
        loader: load,
      });

  return NextResponse.json(payload satisfies MetaStatusResponse, {
    headers: { "Cache-Control": "no-store" },
  });
}
