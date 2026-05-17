import { NextRequest } from "next/server";
import { getIntegration } from "@/lib/integrations";
import {
  fetchAssignedAccountIds,
  fetchCreativeDetailPreviewHtml,
  fetchCreativeThumbnailMap,
} from "@/lib/meta/creatives-fetchers";
import { buildCreativesResponse, type CreativesApiResponse } from "@/lib/meta/creatives-service";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
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
  adId?: string | null;
  adFormat?: string | null;
  adFormats?: string[] | null;
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
    input.groupBy === "adName" || input.groupBy === "ad"
      ? getMetaAdDailyCoverage
      : getMetaCreativeDailyCoverage;
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

type WarehouseCreativePayload = {
  status: string;
  rows: MetaCreativeApiRow[];
  media_mode?: "metadata" | "full";
  media_hydrated?: boolean;
  [key: string]: unknown;
};

async function hydrateWarehouseMediaWithFreshThumbnails<T extends WarehouseCreativePayload>(
  payload: T,
  mediaMode: "metadata" | "full",
  accessToken: string,
  debug: boolean,
): Promise<T> {
  if (mediaMode !== "full" || payload.rows.length === 0) {
    return payload;
  }

  const creativeIds = Array.from(
    new Set(payload.rows.map((row) => row.creative_id).filter(Boolean)),
  );
  if (creativeIds.length === 0) return payload;

  const [tableThumbs, cardThumbs] = await Promise.all([
    fetchCreativeThumbnailMap(creativeIds, accessToken, 150, 120, debug).catch(
      () => new Map<string, string>(),
    ),
    fetchCreativeThumbnailMap(creativeIds, accessToken, 640, 640, debug).catch(
      () => new Map<string, string>(),
    ),
  ]);

  if (tableThumbs.size === 0 && cardThumbs.size === 0) {
    return payload;
  }

  const rows = payload.rows.map((row) =>
    hydrateWarehouseRowMedia(row, tableThumbs, cardThumbs),
  );

  return {
    ...payload,
    rows,
    media_hydrated: true,
  } as T;
}

function hydrateWarehouseRowMedia(
  row: MetaCreativeApiRow,
  tableThumbs: Map<string, string>,
  cardThumbs: Map<string, string>,
): MetaCreativeApiRow {
  const freshTable = tableThumbs.get(row.creative_id) ?? null;
  const freshCard = cardThumbs.get(row.creative_id) ?? null;
  if (!freshTable && !freshCard) return row;

  const tableSrc =
    freshTable ??
    row.table_thumbnail_url ??
    row.cached_thumbnail_url ??
    row.thumbnail_url ??
    row.preview?.poster_url ??
    null;
  const cardSrc =
    freshCard ??
    row.card_preview_url ??
    row.image_url ??
    row.preview?.image_url ??
    row.preview_url ??
    tableSrc;
  const hasMedia = Boolean(tableSrc || cardSrc);
  const preview =
    row.preview.render_mode === "video"
      ? {
          ...row.preview,
          poster_url: tableSrc ?? row.preview.poster_url ?? null,
          image_url: row.preview.image_url ?? cardSrc ?? tableSrc ?? null,
        }
      : {
          ...row.preview,
          render_mode: hasMedia ? ("image" as const) : row.preview.render_mode,
          image_url: cardSrc ?? tableSrc ?? row.preview.image_url ?? null,
          poster_url: tableSrc ?? row.preview.poster_url ?? null,
        };

  return {
    ...row,
    thumbnail_url: tableSrc ?? row.thumbnail_url,
    table_thumbnail_url: tableSrc ?? row.table_thumbnail_url,
    card_preview_url: cardSrc ?? row.card_preview_url,
    preview_url: tableSrc ?? row.preview_url,
    image_url: cardSrc ?? row.image_url,
    preview,
    preview_state: hasMedia ? "preview" : row.preview_state,
    preview_origin: hasMedia ? "live" : row.preview_origin,
  };
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
  const selectedRangeNeedsCurrentDayLive = rangeContext.isSelectedCurrentDay;
  const liveReadSource = selectedRangeNeedsCurrentDayLive
    ? "current_day_live"
    : "live_fallback";
  const fallbackEnd = selectedRangeNeedsCurrentDayLive ? end : effectiveEnd;

  if (
    !selectedRangeNeedsCurrentDayLive &&
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
    const mediaHydratedPayload =
      mediaMode === "full"
        ? await hydrateWarehouseMediaWithFreshThumbnails(
            warehousePayload,
            mediaMode,
            accessToken,
            debugPreview || debugThumbnail,
          )
        : warehousePayload;
    return {
      ...mediaHydratedPayload,
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
        end: fallbackEnd,
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
          selectedRangeNeedsCurrentDayLive && rows.length === 0;
        return {
          ...payload,
          snapshot_source: "live",
          readSource: liveReadSource,
          ...(selectedRangeNeedsCurrentDayLive
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
        if (!selectedRangeNeedsCurrentDayLive) throw error;
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

  const requestedFormats = Array.from(
    new Set(
      (input.adFormats && input.adFormats.length > 0
        ? input.adFormats
        : input.adFormat?.trim()
          ? [input.adFormat.trim()]
          : []
      )
        .map((format) => format.trim())
        .filter(Boolean),
    ),
  );
  const adFormats = requestedFormats.length > 0 ? requestedFormats : undefined;
  const adPreview = input.adId?.trim()
    ? await fetchCreativeDetailPreviewHtml(input.adId.trim(), integration.access_token, {
        adFormats,
      })
    : null;
  const preview =
    adPreview ??
    (await fetchCreativeDetailPreviewHtml(input.creativeId, integration.access_token, {
      adFormats,
    }));
  return {
    status: "ok",
    detail_preview: {
      creative_id: input.creativeId,
      target_id: adPreview ? input.adId?.trim() ?? input.creativeId : input.creativeId,
      target_type: adPreview ? "ad" : "creative",
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
