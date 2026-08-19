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
  buildMetaCreativesAccountScopeMetadata,
  getMetaCreativesWarehousePayload,
  resolveMetaCreativesAccountScope,
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
  providerAccountId?: string | null;
  creativeId?: string | null;
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
  providerAccountId?: string | null;
  creativeId?: string | null;
  mediaMode: "metadata" | "full";
  groupBy: GroupBy;
  format: FormatFilter;
  sort: SortKey;
  start: string;
  end: string;
}

/**
 * The Meta connection row could not be read.
 *
 * Deliberately distinct from "this business has no Meta connection".
 * `getIntegration` resolves to `null` for the second case and rejects for the
 * first (DB error, decrypt failure), and the two must never be reported the
 * same way: a caller that receives `no_connection` states a fact about the
 * account, while this error states that no fact was obtained.
 */
export class MetaCreativesIntegrationReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaCreativesIntegrationReadError";
  }
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
  providerAccountId: string,
  creativeId: string | null,
) {
  return JSON.stringify({
    businessId: input.businessId,
    providerAccountId,
    creativeId,
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

function scopeCreativePayloadRows<T extends WarehouseCreativePayload>(
  payload: T,
  providerAccountId: string,
  creativeId: string | null = null,
): T {
  return {
    ...payload,
    rows: payload.rows.filter(
      (row) =>
        row.account_id === providerAccountId &&
        (!creativeId || row.creative_id === creativeId),
    ),
  };
}

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
    providerAccountId: requestedProviderAccountId,
    creativeId: requestedCreativeId,
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
  const creativeId = requestedCreativeId?.trim() || null;
  const enableFullMediaHydration = mediaMode === "full";

  const assignedAccountIds = await fetchAssignedAccountIds(businessId);
  const accountScope = resolveMetaCreativesAccountScope({
    assignedAccountIds,
    requestedProviderAccountId,
  });
  if (!accountScope.ok) {
    return {
      status: accountScope.status,
      rows: [],
      ...buildMetaCreativesAccountScopeMetadata(accountScope),
    };
  }
  const providerAccountId = accountScope.providerAccountId;
  const scopedAccountIds = accountScope.assignedAccountIds;
  const accountScopeMetadata = buildMetaCreativesAccountScopeMetadata(accountScope);

  // A read that failed is not a known disconnection. `.catch(() => null)`
  // collapsed a rejected integration read into the same value as "no row
  // exists", so a DB or decrypt failure was reported as
  // `{ status: "no_connection", rows: [] }` — which ships as HTTP 200 and makes
  // the Creative Studio assets table draw its ordinary "no creative assets were
  // served for this window" empty state. The operator then reads a definite
  // statement about their account produced by a read that never happened, and
  // may cut or scale on it. Surfacing the failure keeps the honesty law: a read
  // failure is never an empty success.
  let integration: Awaited<ReturnType<typeof getIntegration>>;
  try {
    integration = await getIntegration(businessId, "meta");
  } catch (error) {
    console.warn("[meta-creatives] integration_read_failed", {
      businessId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new MetaCreativesIntegrationReadError(
      "The Meta connection for this business could not be read, so no creative data was loaded.",
    );
  }
  // A source-health verdict, not an empty result set. `rows: []` here states
  // that no read was attempted, so the envelope carries the status and an
  // explicitly unknown observation instant; a surface that treated this as an
  // ordinary empty window would tell the operator their account served nothing
  // when in fact nothing was asked.
  if (!integration || integration.status !== "connected") {
    return {
      status: "no_connection",
      rows: [],
      warehouse_observed_at: null,
      ...accountScopeMetadata,
    };
  }
  if (!integration.access_token) {
    return {
      status: "no_access_token",
      rows: [],
      warehouse_observed_at: null,
      ...accountScopeMetadata,
    };
  }
  const accessToken = integration.access_token;

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
      assignedAccountIds: scopedAccountIds,
      groupBy,
      start,
      end: effectiveEnd,
    }))
  ) {
    const warehousePayload = await getMetaCreativesWarehousePayload({
      businessId,
      providerAccountId,
      creativeId,
      start,
      end: effectiveEnd,
      groupBy,
      format,
      sort,
      mediaMode,
    });
    if (warehousePayload.status !== "ok") {
      return {
        ...warehousePayload,
        readSource: "warehouse",
      };
    }
    const scopedWarehousePayload = scopeCreativePayloadRows(
      warehousePayload,
      providerAccountId,
      creativeId,
    );
    const mediaHydratedPayload =
      mediaMode === "full"
        ? await hydrateWarehouseMediaWithFreshThumbnails(
            scopedWarehousePayload,
            mediaMode,
            accessToken,
            debugPreview || debugThumbnail,
          )
        : scopedWarehousePayload;
    return {
      ...mediaHydratedPayload,
      readSource: "warehouse",
      ...accountScopeMetadata,
    };
  }

  const fallbackCache = getRequestScopedLiveFallbackCache(request);
  const fallbackKey = getLiveFallbackCacheKey(
    input,
    liveReadSource,
    providerAccountId,
    creativeId,
  );
  let fallbackPromise = fallbackCache.get(fallbackKey);
  if (!fallbackPromise) {
    fallbackPromise = buildCreativesResponse(
      {
        businessId,
        assignedAccountIds: scopedAccountIds,
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
        const accountScopedPayload = scopeCreativePayloadRows(
          payload,
          providerAccountId,
        );
        const scopedPayload = scopeCreativePayloadRows(
          accountScopedPayload,
          providerAccountId,
          creativeId,
        );
        const rows = scopedPayload.rows;
        const isCurrentDayPartial =
          selectedRangeNeedsCurrentDayLive && accountScopedPayload.rows.length === 0;
        return {
          ...scopedPayload,
          snapshot_source: "live",
          readSource: liveReadSource,
          // A live read has no warehouse write behind it. `buildLiveApiResponse`
          // stamps `last_synced_at: new Date().toISOString()`
          // (lib/meta/creatives-snapshot-helpers.ts), which is the age of this
          // request rather than of the data, so the observation instant is
          // published as unknown instead of borrowing that number.
          warehouse_observed_at: null,
          ...accountScopeMetadata,
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
          warehouse_observed_at: null,
          ...accountScopeMetadata,
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
    providerAccountId: requestedProviderAccountId,
    creativeId: requestedCreativeId,
    mediaMode,
    groupBy,
    format,
    sort,
    start,
    end,
  } = input;
  const creativeId = requestedCreativeId?.trim() || null;

  const assignedAccountIds = await fetchAssignedAccountIds(businessId);
  const accountScope = resolveMetaCreativesAccountScope({
    assignedAccountIds,
    requestedProviderAccountId,
  });
  if (!accountScope.ok) {
    return {
      status: accountScope.status,
      rows: [],
      ...buildMetaCreativesAccountScopeMetadata(accountScope),
    };
  }
  const accountScopeMetadata = buildMetaCreativesAccountScopeMetadata(accountScope);

  const integration = await getIntegration(businessId, "meta").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return { status: "no_connection", rows: [], ...accountScopeMetadata };
  }
  if (!integration.access_token) {
    return { status: "no_access_token", rows: [], ...accountScopeMetadata };
  }

  const payload = await getMetaCreativesWarehousePayload({
    businessId,
    providerAccountId: accountScope.providerAccountId,
    creativeId,
    start,
    end,
    groupBy,
    format,
    sort,
    mediaMode,
  });
  if (payload.status !== "ok") {
    return {
      ...payload,
      readSource: "warehouse",
    };
  }
  return {
    ...scopeCreativePayloadRows(
      payload,
      accountScope.providerAccountId,
      creativeId,
    ),
    readSource: "warehouse",
    ...accountScopeMetadata,
  };
}
