import { NextRequest } from "next/server";
import { getIntegration } from "@/lib/integrations";
import {
  fetchAssignedAccountIds,
  fetchCreativeDetailPreviewHtml,
} from "@/lib/meta/creatives-fetchers";
import { buildCreativesResponse, type CreativesApiResponse } from "@/lib/meta/creatives-service";
import type { FormatFilter, GroupBy, SortKey } from "@/lib/meta/creatives-types";
import {
  getMetaCreativesWarehousePayload,
} from "@/lib/meta/creatives-warehouse";
import { dayCountInclusive } from "@/lib/meta/history";
import {
  getMetaPartialReason,
  getMetaRangePreparationContext,
} from "@/lib/meta/readiness";
import {
  getMetaAdDailyCoverage,
  getMetaCreativeDailyCoverage,
} from "@/lib/meta/warehouse";

export interface MetaCreativesLivePayloadInput {
  request: NextRequest;
  requestStartedAt: number;
  businessId: string;
  mediaMode: "metadata" | "full";
  groupBy: GroupBy;
  format: FormatFilter;
  sort: SortKey;
  start: string;
  end: string;
  debugPreview: boolean;
  debugThumbnail: boolean;
  debugPerf: boolean;
  snapshotBypass: boolean;
  snapshotWarm: boolean;
  enableCopyRecovery: boolean;
  enableCreativeBasicsFallback: boolean;
  enableCreativeDetails: boolean;
  enableThumbnailBackfill: boolean;
  enableCardThumbnailBackfill: boolean;
  enableImageHashLookup: boolean;
  enableMediaRecovery: boolean;
  enableMediaCache: boolean;
  enableDeepAudit: boolean;
  perAccountSampleLimit: number;
}

export interface MetaCreativeDetailPayloadInput {
  businessId: string;
  creativeId: string;
}

export interface MetaCreativesWarehousePayloadInput {
  businessId: string;
  mediaMode: "metadata" | "full";
  groupBy: GroupBy;
  format: FormatFilter;
  sort: SortKey;
  start: string;
  end: string;
}

const requestScopedLiveFallbackCache = new WeakMap<
  NextRequest,
  Map<string, Promise<CreativesApiResponse>>
>();

function getRequestScopedLiveFallbackCache(request: NextRequest) {
  let cache = requestScopedLiveFallbackCache.get(request);
  if (!cache) {
    cache = new Map();
    requestScopedLiveFallbackCache.set(request, cache);
  }
  return cache;
}

function getLiveFallbackCacheKey(
  input: MetaCreativesLivePayloadInput,
  readSource: "live_fallback" | "current_day_live",
) {
  return JSON.stringify({
    businessId: input.businessId,
    readSource,
    mediaMode: input.mediaMode,
    groupBy: input.groupBy,
    format: input.format,
    sort: input.sort,
    start: input.start,
    end: input.end,
    debugPreview: input.debugPreview,
    debugThumbnail: input.debugThumbnail,
    debugPerf: input.debugPerf,
    enableCopyRecovery: input.enableCopyRecovery,
    enableCreativeBasicsFallback: input.enableCreativeBasicsFallback,
    enableCreativeDetails: input.enableCreativeDetails,
    enableThumbnailBackfill: input.enableThumbnailBackfill,
    enableCardThumbnailBackfill: input.enableCardThumbnailBackfill,
    enableImageHashLookup: input.enableImageHashLookup,
    enableMediaRecovery: input.enableMediaRecovery,
    enableDeepAudit: input.enableDeepAudit,
    perAccountSampleLimit: input.perAccountSampleLimit,
  });
}

async function hasCreativeWarehouseCoverage(input: {
  businessId: string;
  assignedAccountIds: string[];
  groupBy: GroupBy;
  start: string;
  end: string;
}) {
  const totalDays = dayCountInclusive(input.start, input.end);
  if (!Number.isFinite(totalDays) || totalDays <= 0) return false;
  const coverageReader =
    input.groupBy === "adName" ? getMetaAdDailyCoverage : getMetaCreativeDailyCoverage;
  const coverages = await Promise.all(
    input.assignedAccountIds.map((providerAccountId) =>
      coverageReader({
        businessId: input.businessId,
        providerAccountId,
        startDate: input.start,
        endDate: input.end,
        timeoutMs: 2_500,
      }).catch(() => null),
    ),
  );
  return coverages.every((coverage) => (coverage?.completed_days ?? 0) >= totalDays);
}

function shouldBypassCreativeWarehouse(input: MetaCreativesLivePayloadInput) {
  return (
    input.snapshotBypass ||
    input.snapshotWarm ||
    input.debugPreview ||
    input.debugThumbnail ||
    input.debugPerf
  );
}

function buildCurrentDayCreativeNotReadyReason(input: {
  currentDateInTimezone: string | null;
  primaryAccountTimezone: string | null;
}) {
  return getMetaPartialReason({
    isSelectedCurrentDay: true,
    currentDateInTimezone: input.currentDateInTimezone,
    primaryAccountTimezone: input.primaryAccountTimezone,
    defaultReason: "Current-day live Meta creative data is still being prepared.",
  });
}

export async function getMetaCreativesApiPayload(input: MetaCreativesLivePayloadInput) {
  const {
    request,
    requestStartedAt,
    businessId,
    mediaMode,
    groupBy,
    format,
    sort,
    start,
    end,
    debugPreview,
    debugThumbnail,
    debugPerf,
    snapshotBypass,
    snapshotWarm,
    enableCopyRecovery,
    enableCreativeBasicsFallback,
    enableCreativeDetails,
    enableThumbnailBackfill,
    enableCardThumbnailBackfill,
    enableImageHashLookup,
    enableMediaRecovery,
    enableMediaCache,
    enableDeepAudit,
    perAccountSampleLimit,
  } = input;
  const enableFullMediaHydration = mediaMode === "full";

  const integration = await getIntegration(businessId, "meta").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return { status: "no_connection", rows: [] };
  }
  if (!integration.access_token) {
    return { status: "no_access_token", rows: [] };
  }
  const accessToken = integration.access_token;

  const assignedAccountIds = await fetchAssignedAccountIds(businessId);
  if (assignedAccountIds.length === 0) {
    return { status: "no_accounts_assigned", rows: [] };
  }

  const rangeContext = await getMetaRangePreparationContext({
    businessId,
    startDate: start,
    endDate: end,
  });
  const effectiveEnd =
    !rangeContext.isSelectedCurrentDay &&
    rangeContext.selectedRangeTruthEndDate &&
    start <= rangeContext.selectedRangeTruthEndDate
      ? rangeContext.selectedRangeTruthEndDate
      : end;
  const liveReadSource = rangeContext.isSelectedCurrentDay
    ? "current_day_live"
    : "live_fallback";

  if (
    !rangeContext.isSelectedCurrentDay &&
    !shouldBypassCreativeWarehouse(input) &&
    (await hasCreativeWarehouseCoverage({
      businessId,
      assignedAccountIds,
      groupBy,
      start,
      end: effectiveEnd,
    }))
  ) {
    const warehousePayload = await getMetaCreativesWarehousePayload({
      businessId,
      start,
      end: effectiveEnd,
      groupBy,
      format,
      sort,
      mediaMode,
    });
    return {
      ...warehousePayload,
      readSource: "warehouse",
    };
  }

  const fallbackCache = getRequestScopedLiveFallbackCache(request);
  const fallbackKey = getLiveFallbackCacheKey(input, liveReadSource);
  let fallbackPromise = fallbackCache.get(fallbackKey);
  if (!fallbackPromise) {
    fallbackPromise = buildCreativesResponse(
      {
        businessId,
        assignedAccountIds,
        accessToken,
        mediaMode,
        enableFullMediaHydration,
        groupBy,
        format,
        sort,
        start,
        end,
        debugPreview,
        debugThumbnail,
        debugPerf,
        snapshotBypass: true,
        snapshotWarm: true,
        enableCopyRecovery,
        enableCreativeBasicsFallback,
        enableCreativeDetails,
        enableThumbnailBackfill,
        enableCardThumbnailBackfill,
        enableImageHashLookup,
        enableMediaRecovery,
        enableMediaCache: false,
        enableDeepAudit,
        perAccountSampleLimit,
        requestStartedAt,
        allowSnapshotPersistence: false,
        allowSnapshotRefreshTrigger: false,
      },
      request,
    )
      .then((payload) => {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const isCurrentDayPartial =
          rangeContext.isSelectedCurrentDay && rows.length === 0;
        return {
          ...payload,
          snapshot_source: "live",
          readSource: liveReadSource,
          ...(rangeContext.isSelectedCurrentDay
            ? {
                isPartial: isCurrentDayPartial,
                notReadyReason: isCurrentDayPartial
                  ? buildCurrentDayCreativeNotReadyReason({
                      currentDateInTimezone: rangeContext.currentDateInTimezone,
                      primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                    })
                  : null,
              }
            : {}),
        };
      })
      .catch((error: unknown) => {
        if (!rangeContext.isSelectedCurrentDay) throw error;
        console.warn("[meta-creatives] current_day_live_failed", {
          businessId,
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          status: "ok",
          rows: [],
          media_mode: mediaMode,
          media_hydrated: false,
          snapshot_source: "live",
          readSource: "current_day_live",
          isPartial: true,
          notReadyReason: buildCurrentDayCreativeNotReadyReason({
            currentDateInTimezone: rangeContext.currentDateInTimezone,
            primaryAccountTimezone: rangeContext.primaryAccountTimezone,
          }),
        };
      });
    fallbackCache.set(fallbackKey, fallbackPromise);
  }
  return fallbackPromise;
}

export async function getMetaCreativeDetailPayload(input: MetaCreativeDetailPayloadInput) {
  const integration = await getIntegration(input.businessId, "meta").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return {
      status: "no_connection",
      detail_preview: {
        creative_id: input.creativeId,
        mode: "unavailable",
        source: null,
        ad_format: null,
        html: null,
      },
    };
  }
  if (!integration.access_token) {
    return {
      status: "no_access_token",
      detail_preview: {
        creative_id: input.creativeId,
        mode: "unavailable",
        source: null,
        ad_format: null,
        html: null,
      },
    };
  }

  const preview = await fetchCreativeDetailPreviewHtml(input.creativeId, integration.access_token);
  return {
    status: "ok",
    detail_preview: {
      creative_id: input.creativeId,
      mode: preview ? "html" : "unavailable",
      source: preview?.source ?? null,
      ad_format: preview?.adFormat ?? null,
      html: preview?.html ?? null,
    },
  };
}

export async function getMetaCreativesDbPayload(input: MetaCreativesWarehousePayloadInput) {
  const {
    businessId,
    mediaMode,
    groupBy,
    format,
    sort,
    start,
    end,
  } = input;

  const integration = await getIntegration(businessId, "meta").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return { status: "no_connection", rows: [] };
  }
  if (!integration.access_token) {
    return { status: "no_access_token", rows: [] };
  }

  const assignedAccountIds = await fetchAssignedAccountIds(businessId);
  if (assignedAccountIds.length === 0) {
    return { status: "no_accounts_assigned", rows: [] };
  }

  const payload = await getMetaCreativesWarehousePayload({
    businessId,
    start,
    end,
    groupBy,
    format,
    sort,
    mediaMode,
  });
  return {
    ...payload,
    readSource: "warehouse",
  };
}
