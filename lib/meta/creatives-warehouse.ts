import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import {
  coerceCreativeTaxonomyFromLegacy,
  deriveLegacyCreativeClassification,
  reconcileCreativeTaxonomyWithVideoEvidence,
} from "@/lib/meta/creative-taxonomy";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { buildCreativesResponse } from "@/lib/meta/creatives-service";
import type {
  CreativeMetricPresence,
  CreativeMetricPresenceKey,
  FormatFilter,
  GroupBy,
  MetaCreativeApiRow,
  NormalizedRenderPreviewPayload,
  RawCreativeRow,
  SortKey,
} from "@/lib/meta/creatives-types";
import {
  CREATIVE_METRIC_PRESENCE_KEYS,
  isCreativeMetricDeclaredAvailable,
} from "@/lib/meta/creatives-types";
import { buildMetaCreativeApiRow } from "@/lib/meta/creatives-service-support";
import { buildMetaCreativeApiRowLightweight } from "@/lib/meta/creatives-service-support";
import {
  groupRows,
  sortRows,
} from "@/lib/meta/creatives-row-mappers";
import { resolveMetaStoryIdLandingUrl } from "@/lib/meta/landing-url-story-fallback";
import {
  META_CANONICAL_METRIC_SCHEMA_VERSION,
  assertMetaCanonicalClicksSource,
} from "@/lib/meta/canonical-metrics";
import {
  getMetaAdDailyRange,
  getMetaCreativeDailyCoverage,
  getMetaCreativeDailyRange,
  getMetaCreativeMediaPreviewCoverage,
  getMetaCreativeMediaRange,
  upsertMetaCreativeDailyRows,
  upsertMetaCreativeMediaRows,
} from "@/lib/meta/warehouse";
import {
  readMetaAdDimensions,
  readMetaCreativeDimensions,
  type MetaAdDimensionRecord,
} from "@/lib/meta/request-model-store";
import type { MetaAdDailyRow, MetaCreativeDailyRow, MetaCreativeMediaRow } from "@/lib/meta/warehouse-types";
import { getCreativeMediaRetentionStart } from "@/lib/meta/history";
import { pruneMetaCreativeMediaOutsideRetention } from "@/lib/meta/cleanup";
import { normalizeMetaCurrencyCode } from "@/lib/meta/account-context";

export type MetaCreativesAccountScopeResolution =
  | {
      ok: true;
      providerAccountId: string;
      assignedAccountIds: string[];
      assignedAccountCount: number;
      resolution: "explicit" | "single_assigned_account";
    }
  | {
      ok: false;
      status:
        | "no_accounts_assigned"
        | "provider_account_required"
        | "account_not_assigned";
      requestedProviderAccountId: string | null;
      assignedAccountCount: number;
    };

export function resolveMetaCreativesAccountScope(input: {
  assignedAccountIds: string[];
  requestedProviderAccountId?: string | null;
}): MetaCreativesAccountScopeResolution {
  const assignedAccountIds = Array.from(
    new Set(input.assignedAccountIds.map((value) => value.trim()).filter(Boolean)),
  );
  const requestedProviderAccountId = input.requestedProviderAccountId?.trim() || null;

  if (assignedAccountIds.length === 0) {
    return {
      ok: false,
      status: "no_accounts_assigned",
      requestedProviderAccountId,
      assignedAccountCount: 0,
    };
  }
  if (
    requestedProviderAccountId &&
    !assignedAccountIds.includes(requestedProviderAccountId)
  ) {
    return {
      ok: false,
      status: "account_not_assigned",
      requestedProviderAccountId,
      assignedAccountCount: assignedAccountIds.length,
    };
  }
  if (requestedProviderAccountId) {
    return {
      ok: true,
      providerAccountId: requestedProviderAccountId,
      assignedAccountIds: [requestedProviderAccountId],
      assignedAccountCount: assignedAccountIds.length,
      resolution: "explicit",
    };
  }
  if (assignedAccountIds.length === 1) {
    return {
      ok: true,
      providerAccountId: assignedAccountIds[0]!,
      assignedAccountIds: [assignedAccountIds[0]!],
      assignedAccountCount: 1,
      resolution: "single_assigned_account",
    };
  }
  return {
    ok: false,
    status: "provider_account_required",
    requestedProviderAccountId: null,
    assignedAccountCount: assignedAccountIds.length,
  };
}

export function buildMetaCreativesAccountScopeMetadata(
  scope: MetaCreativesAccountScopeResolution,
) {
  return {
    providerAccountId: scope.ok
      ? scope.providerAccountId
      : scope.requestedProviderAccountId,
    account_scope: {
      status: scope.ok ? ("resolved" as const) : ("blocked" as const),
      resolution: scope.ok ? scope.resolution : scope.status,
      assigned_account_count: scope.assignedAccountCount,
    },
  };
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function enumerateDays(startDate: string, endDate: string, recentFirst = true) {
  const rows: string[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    rows.push(toIsoDate(cursor));
    cursor = addDays(cursor, 1);
  }
  return recentFirst ? rows.reverse() : rows;
}

function normalizeCreativeRows(rows: RawCreativeRow[], format: FormatFilter) {
  if (format === "all") return rows;
  return rows.filter((row) => row.format === format);
}

export function buildCreativeUsageMap(rows: RawCreativeRow[]) {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = map.get(row.creative_id) ?? new Set<string>();
    bucket.add(row.id);
    map.set(row.creative_id, bucket);
  }
  return map;
}

async function hydrateCreativeLandingUrls(rows: RawCreativeRow[], accessToken: string) {
  await Promise.all(
    rows.map(async (row) => {
      if (row.destination_url) return;
      const storyId = row.effective_object_story_id ?? row.object_story_id ?? null;
      if (!storyId) return;
      const resolved = await resolveMetaStoryIdLandingUrl({
        storyId,
        accessToken,
      });
      if (!resolved.rawUrl) return;
      row.destination_url = resolved.canonicalUrl;
      row.destination_url_raw = resolved.rawUrl;
      row.destination_url_source = resolved.source;
      row.destination_url_confidence = resolved.confidence;
      row.cta_type = resolved.ctaType ?? null;
    }),
  );
}

function buildUnavailablePreview(isCatalog: boolean): NormalizedRenderPreviewPayload {
  return {
    render_mode: "unavailable",
    image_url: null,
    video_url: null,
    poster_url: null,
    source: null,
    is_catalog: isCatalog,
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function requireCreativeWarehouseCurrency(
  rows: RawCreativeRow[],
  accountId: string
): string {
  const currencies = Array.from(
    new Set(
      rows
        .map((row) => normalizeMetaCurrencyCode(row.currency))
        .filter((currency): currency is string => currency != null)
    )
  );
  if (currencies.length === 1) return currencies[0];
  if (currencies.length > 1) {
    throw new Error(`meta_currency_conflict:creative_warehouse:${accountId}`);
  }
  throw new Error(`meta_currency_unavailable:creative_warehouse:${accountId}`);
}

function readProjectionString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Per-field availability of a STORED projection payload.
 *
 * ABSENCE IS EVIDENCE. PRESENCE IS NOT. That asymmetry is the correction, and
 * it is what makes this reader usable on the DEFAULT production grain.
 *
 * `meta_creative_dimensions.projection_json` is not raw provider data: it is the
 * output of `buildMetaCreativeApiRow`, which ends every economic field with
 * `?? 0` / `: 0`. So the projection carries EVERY metric key as a finite number
 * whether or not anything was ever measured. Reading "the key is a finite
 * number" as availability therefore certifies the coalescing instead of
 * detecting it: on production, all 5,678 rows of `meta_creative_dimensions`
 * carry `add_to_cart` and `thumbstop`, and 0 of them carry `metric_presence` —
 * so the old rule returned `true` for every field of every row, and the sidecar
 * could not fire on the one grain the Assets table actually reads
 * (`groupBy: "creative"`).
 *
 * The three answers this function can honestly give:
 *
 *   - the payload DECLARES `metric_presence` for the key -> that boolean. A
 *     projection written after this contract landed says what it knows, and
 *     re-deriving over the top would upgrade a declared `false` back to `true`.
 *   - the key is ABSENT from the payload -> `false`. Absence is provable: the
 *     payload never carried the field, and `coerceRawCreativeRow` spreads that
 *     absence into a row where `buildMetaCreativeApiRow` publishes it as `0`.
 *   - the key is present as a number, undeclared -> NO OPINION (key omitted).
 *     The number proves nothing about its own provenance. Callers that need a
 *     positive statement use `isCreativeMetricDeclaredAvailable`; callers that
 *     only ask "may this be shown" keep getting the permissive default from
 *     `isCreativeMetricAvailable`, so nothing is withheld by silence alone.
 */
export function readProjectionMetricPresence(value: unknown): CreativeMetricPresence {
  const payload =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const declared = payload.metric_presence;
  const declaredMap =
    declared && typeof declared === "object" && !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : null;
  const presence: CreativeMetricPresence = {};
  for (const key of CREATIVE_METRIC_PRESENCE_KEYS) {
    if (declaredMap && typeof declaredMap[key] === "boolean") {
      presence[key] = declaredMap[key] as boolean;
      continue;
    }
    if (!(key in payload)) {
      presence[key] = false;
      continue;
    }
    const raw = payload[key];
    // Present but not a number is still an absence of a usable figure. Present
    // AND numeric is the coalesced case: state nothing.
    if (typeof raw !== "number" || !Number.isFinite(raw)) presence[key] = false;
  }
  return presence;
}

/**
 * Per-field availability of a warehouse FACT row.
 *
 * `spend`, `revenue`, `roas`, `conversions`, `impressions` and `clicks` are NOT
 * NULL columns on `meta_ad_daily` / `meta_creative_daily`: a row that exists
 * carries them, so a zero there is a measured zero and stays 0. Everything else
 * in this map is genuinely nullable at the source — `link_clicks` as a nullable
 * column, and the funnel counters as `payload_json` keys that
 * `payloadMetricNumber` resolves to `null` when the sync never wrote them — and
 * a null there is an absence that the readers below would otherwise turn into
 * a zero the account never measured.
 *
 * `link_clicks` only started TELLING THE TRUTH here on 2026-08-19. The line
 * below has read `factRow.linkClicks != null` since the sidecar was written,
 * but `meta_ad_daily.link_clicks` was `BIGINT NOT NULL DEFAULT 0` and
 * `upsertMetaAdDailyRows` bound `row.linkClicks ?? 0`, so the column could not
 * hold an absence and this line could only ever evaluate to `true` — an
 * availability claim with nothing behind it. The widening in `lib/migrations.ts`
 * and the `?? null` bind in `lib/meta/warehouse.ts` are what make it a real
 * question. Nothing here back-infers from the NUMBER: a link-click count of 0
 * is still `true`, because a measured zero is a measurement.
 */
function readWarehouseFactMetricPresence(
  factRow: MetaAdDailyRow | MetaCreativeDailyRow,
): CreativeMetricPresence {
  return {
    spend: true,
    purchase_value: true,
    roas: true,
    purchases: true,
    impressions: true,
    clicks: true,
    link_clicks: factRow.linkClicks != null,
    landing_page_views: factRow.landingPageViews != null,
    add_to_cart: factRow.addToCart != null,
    initiate_checkout: factRow.initiateCheckout != null,
    frequency: factRow.frequency != null,
  };
}

function overlayMetricPresence(
  base: CreativeMetricPresence | undefined,
  overrides: CreativeMetricPresence,
): CreativeMetricPresence {
  const merged: CreativeMetricPresence = { ...(base ?? {}) };
  for (const key of Object.keys(overrides) as CreativeMetricPresenceKey[]) {
    const value = overrides[key];
    if (typeof value === "boolean") merged[key] = value;
  }
  return merged;
}

export function buildFallbackAdRawRow(input: {
  factRow: MetaAdDailyRow;
  projectionJson: unknown;
  creativeId: string | null | undefined;
}): RawCreativeRow {
  const { factRow, projectionJson } = input;
  const preview = buildUnavailablePreview(false);
  // `?? factRow.clicks` substitutes ALL clicks for LINK clicks. It is a
  // presentation fallback that predates the sidecar and it is deliberately left
  // in place: the numeric fields on this row keep their existing values so
  // nothing downstream changes shape. What stops it being read as a
  // measurement is `readWarehouseFactMetricPresence` below, which reports
  // `link_clicks: false` for exactly this case — so the substituted number, and
  // every ratio derived from it, is withheld at the cell rather than printed.
  const linkClicks = factRow.linkClicks ?? factRow.clicks;
  const purchaseValue = factRow.revenue;
  const spend = factRow.spend;
  const impressions = factRow.impressions;
  const cpa = factRow.cpa ?? (factRow.conversions > 0 ? spend / factRow.conversions : 0);
  const cpcLink = factRow.cpc ?? (linkClicks > 0 ? spend / linkClicks : 0);
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const ctr = factRow.ctr ?? (impressions > 0 ? (linkClicks / impressions) * 100 : 0);
  const outboundClicks = factRow.outboundClicks ?? 0;
  const landingPageViews = factRow.landingPageViews ?? 0;
  const addToCart = factRow.addToCart ?? 0;
  const initiateCheckout = factRow.initiateCheckout ?? 0;

  return {
    id: factRow.adId,
    creative_id: input.creativeId ?? factRow.adId,
    real_ad_id: factRow.adId,
    object_story_id: factRow.objectStoryId ?? null,
    effective_object_story_id: factRow.effectiveObjectStoryId ?? null,
    post_id: null,
    associated_ads_count: 1,
    account_id: factRow.providerAccountId,
    account_name: null,
    campaign_id: factRow.campaignId,
    campaign_name: readProjectionString(projectionJson, "campaign_name"),
    adset_id: factRow.adsetId,
    adset_name: readProjectionString(projectionJson, "adset_name"),
    currency: factRow.accountCurrency,
    name: factRow.adNameCurrent ?? factRow.adNameHistorical ?? "Unnamed ad",
    launch_date: factRow.date,
    copy_text: null,
    copy_variants: [],
    headline_variants: [],
    description_variants: [],
    copy_source: null,
    copy_debug_sources: [],
    unresolved_reason: "warehouse_projection_minimal",
    preview_url: null,
    preview_source: null,
    thumbnail_url: null,
    image_url: null,
    table_thumbnail_url: null,
    card_preview_url: null,
    is_catalog: false,
    preview_state: "unavailable",
    preview,
    tags: [],
    ai_tags: {},
    format: "image",
    creative_type: "feed",
    creative_type_label: "Feed",
    creative_delivery_type: "standard",
    creative_visual_format: "image",
    creative_primary_type: "standard",
    creative_primary_label: "Standard",
    creative_secondary_type: null,
    creative_secondary_label: null,
    classification_signals: null,
    spend: round2(spend),
    purchase_value: round2(purchaseValue),
    roas: round2(spend > 0 ? purchaseValue / spend : 0),
    cpa: round2(cpa),
    clicks: Math.round(factRow.clicks),
    cpc_link: round2(cpcLink),
    cpm: round2(cpm),
    ctr_all: round2(ctr),
    purchases: Math.round(factRow.conversions),
    impressions: Math.round(impressions),
    reach: Math.round(factRow.reach),
    frequency: factRow.frequency ?? null,
    link_clicks: Math.round(linkClicks),
    outbound_clicks: Math.round(outboundClicks),
    effective_status: factRow.adStatus,
    destination_url: factRow.destinationUrl ?? null,
    destination_url_raw: factRow.destinationUrlRaw ?? null,
    destination_url_source: factRow.destinationUrlSource ?? null,
    destination_url_confidence: factRow.destinationUrlConfidence ?? null,
    cta_type: factRow.ctaType ?? null,
    landing_page_views: Math.round(landingPageViews),
    add_to_cart: Math.round(addToCart),
    initiate_checkout: Math.round(initiateCheckout),
    leads: 0,
    messages: 0,
    thumbstop: 0,
    click_to_atc: linkClicks > 0 ? round2((addToCart / linkClicks) * 100) : 0,
    atc_to_purchase: addToCart > 0 ? round2((factRow.conversions / addToCart) * 100) : 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    // This row exists because no stored projection was found for the ad, so
    // there is no source at all behind the six zeros above: `leads`,
    // `messages`, `thumbstop` and the video quartiles are literals typed into
    // this function, not measurements. `link_clicks`/`landing_page_views`/
    // `add_to_cart`/`initiate_checkout` are only as real as the fact row's
    // nullable columns. The numbers stay (nothing downstream changes shape);
    // the map is what stops the surface printing them as facts.
    metric_presence: overlayMetricPresence(readWarehouseFactMetricPresence(factRow), {
      leads: false,
      messages: false,
      thumbstop: false,
      view_content: false,
      post_engagement: false,
      thruplay_actions: false,
      video25: false,
      video50: false,
      video75: false,
      video100: false,
    }),
  };
}

function firstNonEmptyString(...values: Array<string | null | undefined>) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
}

function normalizeStoredPreview(
  value: unknown,
  isCatalog: boolean,
  fallback?: {
    previewUrl?: string | null;
    thumbnailUrl?: string | null;
    imageUrl?: string | null;
    videoUrl?: string | null;
    posterUrl?: string | null;
  },
): NormalizedRenderPreviewPayload {
  const preview =
    value && typeof value === "object"
      ? (value as Partial<NormalizedRenderPreviewPayload>)
      : null;
  const videoUrl = firstNonEmptyString(preview?.video_url, fallback?.videoUrl);
  const imageUrl = firstNonEmptyString(
    preview?.image_url,
    fallback?.imageUrl,
    fallback?.previewUrl,
  );
  const posterUrl = firstNonEmptyString(
    preview?.poster_url,
    fallback?.posterUrl,
    fallback?.thumbnailUrl,
  );
  if (!preview && !videoUrl && !imageUrl && !posterUrl) {
    return buildUnavailablePreview(isCatalog);
  }
  const storedRenderMode = preview?.render_mode;
  const renderMode =
    storedRenderMode === "video" || storedRenderMode === "image"
      ? storedRenderMode
      : videoUrl
        ? "video"
        : imageUrl || posterUrl
          ? "image"
          : "unavailable";
  return {
    render_mode: renderMode,
    image_url: imageUrl,
    video_url: videoUrl,
    poster_url: posterUrl,
    source:
      preview?.source ??
      (imageUrl
        ? "image_url"
        : posterUrl
          ? "thumbnail_url"
          : null),
    is_catalog: Boolean(preview?.is_catalog ?? isCatalog),
  };
}

export function coerceRawCreativeRow(value: unknown): RawCreativeRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<RawCreativeRow>;
  if (typeof row.id === "string" && typeof row.creative_id === "string" && "copy_text" in row) {
    const preview = normalizeStoredPreview(row.preview, Boolean(row.is_catalog), {
      previewUrl: row.preview_url,
      thumbnailUrl: row.thumbnail_url,
      imageUrl: row.image_url,
    });
    const creativeTaxonomy =
      row.creative_primary_type
        ? {
            creative_delivery_type: row.creative_delivery_type ?? "standard",
            creative_visual_format: row.creative_visual_format ?? "image",
            creative_primary_type: row.creative_primary_type,
            creative_primary_label: row.creative_primary_label ?? null,
            creative_secondary_type: row.creative_secondary_type ?? null,
            creative_secondary_label: row.creative_secondary_label ?? null,
            classification_signals: row.classification_signals ?? null,
          }
        : coerceCreativeTaxonomyFromLegacy({
            format: row.format ?? "image",
            creative_type: row.creative_type ?? "feed",
            is_catalog: row.is_catalog ?? false,
          });
    const reconciledCreativeTaxonomy = reconcileCreativeTaxonomyWithVideoEvidence(creativeTaxonomy, {
      preview,
      thumbstop: row.thumbstop,
      video25: row.video25,
      video50: row.video50,
      video75: row.video75,
      video100: row.video100,
    });
    const legacyCreativeClassification = deriveLegacyCreativeClassification(reconciledCreativeTaxonomy);

    return {
      ...(row as RawCreativeRow),
      // The spread above copies whatever metric keys the stored payload had —
      // and copies the ABSENCE of the ones it did not, which downstream becomes
      // `Number(undefined ?? 0)`. Read the availability off the payload here,
      // while the missing keys are still missing.
      metric_presence: readProjectionMetricPresence(value),
      preview,
      format: legacyCreativeClassification.format,
      creative_type: legacyCreativeClassification.creative_type,
      creative_type_label: legacyCreativeClassification.creative_type_label,
      creative_delivery_type: reconciledCreativeTaxonomy.creative_delivery_type,
      creative_visual_format: reconciledCreativeTaxonomy.creative_visual_format,
      creative_primary_type: reconciledCreativeTaxonomy.creative_primary_type,
      creative_primary_label: reconciledCreativeTaxonomy.creative_primary_label,
      creative_secondary_type: reconciledCreativeTaxonomy.creative_secondary_type,
      creative_secondary_label: reconciledCreativeTaxonomy.creative_secondary_label,
      classification_signals: reconciledCreativeTaxonomy.classification_signals,
    };
  }
  const apiRow = value as Partial<MetaCreativeApiRow>;
  if (typeof apiRow.id !== "string" || typeof apiRow.creative_id !== "string") return null;
  const apiPreview = normalizeStoredPreview(apiRow.preview, Boolean(apiRow.is_catalog), {
    previewUrl: apiRow.preview_url,
    thumbnailUrl: apiRow.thumbnail_url,
    imageUrl: apiRow.image_url,
  });
  const creativeTaxonomy =
    apiRow.creative_primary_type
      ? {
          creative_delivery_type: apiRow.creative_delivery_type ?? "standard",
          creative_visual_format: apiRow.creative_visual_format ?? "image",
          creative_primary_type: apiRow.creative_primary_type,
          creative_primary_label: apiRow.creative_primary_label ?? null,
          creative_secondary_type: apiRow.creative_secondary_type ?? null,
          creative_secondary_label: apiRow.creative_secondary_label ?? null,
          classification_signals: apiRow.classification_signals ?? null,
        }
      : coerceCreativeTaxonomyFromLegacy({
          format: apiRow.format ?? "image",
          creative_type: apiRow.creative_type ?? "feed",
          is_catalog: apiRow.is_catalog ?? false,
        });
  const reconciledCreativeTaxonomy = reconcileCreativeTaxonomyWithVideoEvidence(creativeTaxonomy, {
    preview: apiPreview,
    thumbstop: Number(apiRow.thumbstop ?? 0),
    video25: Number(apiRow.video25 ?? 0),
    video50: Number(apiRow.video50 ?? 0),
    video75: Number(apiRow.video75 ?? 0),
    video100: Number(apiRow.video100 ?? 0),
  });
  const legacyCreativeClassification = deriveLegacyCreativeClassification(reconciledCreativeTaxonomy);
  return {
    id: apiRow.id,
    creative_id: apiRow.creative_id,
    real_ad_id: apiRow.real_ad_id ?? null,
    object_story_id: apiRow.object_story_id ?? null,
    effective_object_story_id: apiRow.effective_object_story_id ?? null,
    post_id: apiRow.post_id ?? null,
    associated_ads_count: apiRow.associated_ads_count ?? 1,
    account_id: apiRow.account_id ?? "",
    account_name: apiRow.account_name ?? null,
    campaign_id: apiRow.campaign_id ?? null,
    campaign_name: apiRow.campaign_name ?? null,
    adset_id: apiRow.adset_id ?? null,
    adset_name: apiRow.adset_name ?? null,
    currency: apiRow.currency ?? null,
    name: apiRow.name ?? "Unnamed ad",
    launch_date: apiRow.launch_date ?? "",
    copy_text: apiRow.copy_text ?? null,
    copy_variants: apiRow.copy_variants ?? [],
    headline_variants: apiRow.headline_variants ?? [],
    description_variants: apiRow.description_variants ?? [],
    copy_source: apiRow.copy_source ?? null,
    copy_debug_sources: apiRow.copy_debug_sources ?? [],
    unresolved_reason: apiRow.unresolved_reason ?? null,
    preview_url: apiRow.preview_url ?? null,
    preview_source: apiRow.preview_source ?? null,
    thumbnail_url: apiRow.thumbnail_url ?? null,
    image_url: apiRow.image_url ?? null,
    table_thumbnail_url: apiRow.table_thumbnail_url ?? null,
    card_preview_url: apiRow.card_preview_url ?? null,
    is_catalog: Boolean(apiRow.is_catalog),
    preview_state: apiRow.preview_state ?? "unavailable",
    preview: apiPreview,
    tags: apiRow.tags ?? [],
    ai_tags: apiRow.ai_tags ?? {},
    format: legacyCreativeClassification.format,
    creative_type: legacyCreativeClassification.creative_type,
    creative_type_label: legacyCreativeClassification.creative_type_label,
    creative_delivery_type: reconciledCreativeTaxonomy.creative_delivery_type,
    creative_visual_format: reconciledCreativeTaxonomy.creative_visual_format,
    creative_primary_type: reconciledCreativeTaxonomy.creative_primary_type,
    creative_primary_label: reconciledCreativeTaxonomy.creative_primary_label,
    creative_secondary_type: reconciledCreativeTaxonomy.creative_secondary_type,
    creative_secondary_label: reconciledCreativeTaxonomy.creative_secondary_label,
    classification_signals: reconciledCreativeTaxonomy.classification_signals,
    // Same reason as the raw-row branch: every `Number(x ?? 0)` below erases
    // whether `x` was ever there. Taken from the payload before the coalescing
    // starts.
    metric_presence: readProjectionMetricPresence(value),
    spend: Number(apiRow.spend ?? 0),
    purchase_value: Number(apiRow.purchase_value ?? 0),
    roas: Number(apiRow.roas ?? 0),
    cpa: Number(apiRow.cpa ?? 0),
    clicks: Number(apiRow.clicks ?? 0),
    cpc_link: Number(apiRow.cpc_link ?? 0),
    cpm: Number(apiRow.cpm ?? 0),
    ctr_all: Number(apiRow.ctr_all ?? 0),
    purchases: Number(apiRow.purchases ?? 0),
    impressions: Number(apiRow.impressions ?? 0),
    link_clicks: Number(apiRow.link_clicks ?? 0),
    destination_url: apiRow.destination_url ?? null,
    destination_url_raw: apiRow.destination_url_raw ?? null,
    destination_url_source: apiRow.destination_url_source ?? null,
    destination_url_confidence: apiRow.destination_url_confidence ?? null,
    cta_type: apiRow.cta_type ?? null,
    landing_page_views: Number(apiRow.landing_page_views ?? 0),
    add_to_cart: Number(apiRow.add_to_cart ?? 0),
    initiate_checkout: Number(apiRow.initiate_checkout ?? 0),
    thumbstop: Number(apiRow.thumbstop ?? 0),
    click_to_atc: Number(apiRow.click_to_atc ?? 0),
    atc_to_purchase: Number(apiRow.atc_to_purchase ?? 0),
    leads: Number(apiRow.leads ?? 0),
    messages: Number(apiRow.messages ?? 0),
    video25: Number(apiRow.video25 ?? 0),
    video50: Number(apiRow.video50 ?? 0),
    video75: Number(apiRow.video75 ?? 0),
    video100: Number(apiRow.video100 ?? 0),
    debug: apiRow.debug,
  } satisfies RawCreativeRow;
}

export function hydrateWarehouseCreativeMetrics<T extends RawCreativeRow>(input: {
  row: T;
  factRow: MetaAdDailyRow | MetaCreativeDailyRow;
}) {
  // THE PRE-COALESCE, and why the absence still survives it.
  //
  // `??` (not `||`) is load-bearing on the left: a MEASURED zero is a value and
  // must win, and `0 ?? x` is 0. Only a genuine null falls through to the
  // projection's number.
  //
  // When it does fall through, the absence is NOT lost — it is carried by the
  // presence sidecar below rather than by this number, because
  // `RawCreativeRow.link_clicks` is typed `number` and dozens of consumers do
  // arithmetic on it. That is the additive contract this whole sidecar exists
  // to honour: the numbers are left exactly as they were, and availability
  // travels beside them. The presence entry for `link_clicks` is
  // `factRow.linkClicks != null || isCreativeMetricDeclaredAvailable(...)`, so
  // the substituted projection number is published as available ONLY when the
  // projection positively declared it. A projection that merely stayed silent
  // cannot vouch for it, and the cell renders an em dash instead of the
  // fabricated zero sitting in this variable.
  const resolvedLinkClicks = input.factRow.linkClicks ?? input.row.link_clicks;
  const resolvedAddToCart = input.factRow.addToCart ?? input.row.add_to_cart;

  return {
    ...input.row,
    account_id: input.factRow.providerAccountId ?? input.row.account_id,
    campaign_id: input.factRow.campaignId ?? input.row.campaign_id,
    adset_id: input.factRow.adsetId ?? input.row.adset_id,
    id: "adId" in input.factRow ? (input.factRow.adId ?? input.row.id) : input.row.id,
    real_ad_id:
      "adId" in input.factRow
        ? (input.factRow.adId ?? input.row.real_ad_id ?? null)
        : (input.row.real_ad_id ?? null),
    creative_id:
      "creativeId" in input.factRow
        ? (input.factRow.creativeId ?? input.row.creative_id)
        : input.row.creative_id,
    name:
      input.row.name ??
      ("creativeName" in input.factRow ? input.factRow.creativeName : null) ??
      ("adNameCurrent" in input.factRow ? input.factRow.adNameCurrent : null) ??
      "Unnamed ad",
    currency: input.factRow.accountCurrency ?? input.row.currency,
    spend: input.factRow.spend,
    purchase_value: input.factRow.revenue,
    roas: input.factRow.roas,
    cpa: input.factRow.cpa ?? input.row.cpa,
    clicks: input.factRow.clicks,
    cpc_link: input.factRow.cpc ?? input.row.cpc_link,
    ctr_all: input.factRow.ctr ?? input.row.ctr_all,
    purchases: input.factRow.conversions,
    impressions: input.factRow.impressions,
    reach: input.factRow.reach,
    frequency: input.factRow.frequency ?? input.row.frequency ?? null,
    link_clicks: resolvedLinkClicks,
    destination_url: input.factRow.destinationUrl ?? input.row.destination_url ?? null,
    destination_url_raw: input.factRow.destinationUrlRaw ?? input.row.destination_url_raw ?? null,
    destination_url_source: input.factRow.destinationUrlSource ?? input.row.destination_url_source ?? null,
    destination_url_confidence:
      input.factRow.destinationUrlConfidence ?? input.row.destination_url_confidence ?? null,
    cta_type: input.factRow.ctaType ?? input.row.cta_type ?? null,
    outbound_clicks: input.factRow.outboundClicks ?? input.row.outbound_clicks,
    landing_page_views: input.factRow.landingPageViews ?? input.row.landing_page_views,
    add_to_cart: resolvedAddToCart,
    initiate_checkout: input.factRow.initiateCheckout ?? input.row.initiate_checkout,
    click_to_atc:
      resolvedLinkClicks > 0
        ? round2((resolvedAddToCart / resolvedLinkClicks) * 100)
        : input.row.click_to_atc,
    atc_to_purchase:
      resolvedAddToCart > 0
        ? round2((input.factRow.conversions / resolvedAddToCart) * 100)
        : input.row.atc_to_purchase,
    // Field-by-field, matching the merge above, and derived from the FACT ROW —
    // the only source in this function that describes the window being read.
    //
    // THE RULE. `meta_creative_daily` / `meta_ad_daily` hold one row per entity
    // per DAY; `meta_creative_dimensions` / `meta_ad_dimensions` hold ONE row
    // per entity, keyed `(business_id, provider_account_id, creative_id)` with
    // `projection_json = EXCLUDED.projection_json`, so the projection is
    // whichever single day synced last. A field is available on this row only
    // if the day's fact row supplied it, or the projection explicitly DECLARED
    // it. A projection's silence is not a second opinion.
    //
    // Two failures this closes, both on `groupBy: "creative"` — the grain the
    // Assets table reads:
    //
    //   1. `|| isCreativeMetricAvailable(projection, key)` read the permissive
    //      default, and the old `readProjectionMetricPresence` back-inferred
    //      `true` from the projection's already-coalesced numbers. Together
    //      they made every fact-row null read as available, so a funnel counter
    //      the sync never captured printed as a measured 0.
    //   2. The block below stamps `false` on the ten fields NEITHER fact table
    //      carries a column or payload key for. Their numbers ride in from the
    //      per-creative projection unchanged, and `groupRows` then SUMS them
    //      across the window's day-rows — every day contributing the same
    //      single projection value, so a 28-day window multiplies one day's
    //      `leads` / `messages` / `view_content` / `post_engagement` /
    //      `thruplay_actions` by 28, and reports one day's `thumbstop` and
    //      video quartiles as the window's. On production, 1,998 of 5,678
    //      projections carry a positive `post_engagement` and 3,706 a positive
    //      `thumbstop`, so this is not a theoretical shape. The numbers are
    //      left exactly as they are — this is an additive sidecar — and the map
    //      is what stops the surface presenting them as this window's
    //      measurements. `buildFallbackAdRawRow` has always stamped these same
    //      ten `false` for the same reason; the only change is that a stored
    //      projection no longer exempts them.
    metric_presence: overlayMetricPresence(
      input.row.metric_presence,
      {
        spend: true,
        purchase_value: true,
        roas: true,
        purchases: true,
        impressions: true,
        clicks: true,
        link_clicks:
          input.factRow.linkClicks != null ||
          isCreativeMetricDeclaredAvailable(input.row.metric_presence, "link_clicks"),
        landing_page_views:
          input.factRow.landingPageViews != null ||
          isCreativeMetricDeclaredAvailable(input.row.metric_presence, "landing_page_views"),
        add_to_cart:
          input.factRow.addToCart != null ||
          isCreativeMetricDeclaredAvailable(input.row.metric_presence, "add_to_cart"),
        initiate_checkout:
          input.factRow.initiateCheckout != null ||
          isCreativeMetricDeclaredAvailable(input.row.metric_presence, "initiate_checkout"),
        frequency:
          input.factRow.frequency != null ||
          (input.row.frequency != null &&
            isCreativeMetricDeclaredAvailable(input.row.metric_presence, "frequency")),
        leads: false,
        messages: false,
        thumbstop: false,
        view_content: false,
        post_engagement: false,
        thruplay_actions: false,
        video25: false,
        video50: false,
        video75: false,
        video100: false,
      },
    ),
  } satisfies RawCreativeRow;
}

function adFactKey(row: Pick<MetaAdDailyRow, "providerAccountId" | "date" | "adId">) {
  return `${row.providerAccountId}|${row.date}|${row.adId}`;
}

function creativeFactKey(row: Pick<MetaCreativeDailyRow, "providerAccountId" | "date" | "creativeId">) {
  return `${row.providerAccountId}|${row.date}|${row.creativeId}`;
}

function resolveAdCreativeId(row: MetaAdDailyRow, dimension: MetaAdDimensionRecord | undefined) {
  return (
    dimension?.creativeId ??
    coerceRawCreativeRow(dimension?.projectionJson)?.creative_id ??
    null
  );
}

function overlayAdFunnelFallback(
  row: MetaAdDailyRow,
  fallback: MetaCreativeDailyRow | undefined,
): MetaAdDailyRow {
  if (!fallback) return row;
  const linkClicks =
    (row.linkClicks ?? 0) > 0 ? row.linkClicks : fallback.linkClicks;
  return {
    ...row,
    linkClicks,
    outboundClicks:
      (row.outboundClicks ?? 0) > 0 ? row.outboundClicks : fallback.outboundClicks,
    landingPageViews:
      (row.landingPageViews ?? 0) > 0 ? row.landingPageViews : fallback.landingPageViews,
    addToCart:
      (row.addToCart ?? 0) > 0 ? row.addToCart : fallback.addToCart,
    initiateCheckout:
      (row.initiateCheckout ?? 0) > 0 ? row.initiateCheckout : fallback.initiateCheckout,
    ctr:
      (row.ctr ?? 0) > 0 || !linkClicks || row.impressions <= 0
        ? row.ctr
        : (linkClicks / row.impressions) * 100,
    cpc:
      (row.cpc ?? 0) > 0 || !linkClicks
        ? row.cpc
        : row.spend / linkClicks,
  };
}

async function readUniqueAdFunnelFallbacks(input: {
  businessId: string;
  start: string;
  end: string;
  providerAccountIds: string[];
  adRows: MetaAdDailyRow[];
  adDimensions: Map<string, MetaAdDimensionRecord>;
}) {
  const sparseRows = input.adRows.filter(
    (row) =>
      (row.linkClicks ?? 0) <= 0 ||
      (row.landingPageViews ?? 0) <= 0 ||
      (row.addToCart ?? 0) <= 0 ||
      (row.initiateCheckout ?? 0) <= 0,
  );
  if (sparseRows.length === 0) return new Map<string, MetaCreativeDailyRow>();

  const sparseAdKeys = new Set(sparseRows.map((row) => adFactKey(row)));
  const creativeKeyByAdKey = new Map<string, string>();
  const creativeKeyCounts = new Map<string, number>();
  for (const adRow of input.adRows) {
    const creativeId = resolveAdCreativeId(adRow, input.adDimensions.get(adRow.adId));
    if (!creativeId) continue;
    const creativeKey = `${adRow.providerAccountId}|${adRow.date}|${creativeId}`;
    const adKey = adFactKey(adRow);
    if (sparseAdKeys.has(adKey)) creativeKeyByAdKey.set(adKey, creativeKey);
    creativeKeyCounts.set(creativeKey, (creativeKeyCounts.get(creativeKey) ?? 0) + 1);
  }
  if (creativeKeyByAdKey.size === 0) return new Map<string, MetaCreativeDailyRow>();

  const creativeRows = await getMetaCreativeDailyRange({
    businessId: input.businessId,
    startDate: input.start,
    endDate: input.end,
    providerAccountIds: input.providerAccountIds,
  }).catch(() => [] as MetaCreativeDailyRow[]);
  const creativeRowsByKey = new Map(
    creativeRows.map((row) => [creativeFactKey(row), row]),
  );
  const fallbackByAdKey = new Map<string, MetaCreativeDailyRow>();
  for (const [adKey, creativeKey] of creativeKeyByAdKey.entries()) {
    if ((creativeKeyCounts.get(creativeKey) ?? 0) !== 1) continue;
    const fallback = creativeRowsByKey.get(creativeKey);
    if (fallback) fallbackByAdKey.set(adKey, fallback);
  }
  return fallbackByAdKey;
}

function buildPreviewCoverage(rows: MetaCreativeApiRow[]) {
  const totalCreatives = rows.length;
  const previewReadyCount = rows.filter((row) => row.preview_status === "ready").length;
  const previewMissingCount = totalCreatives - previewReadyCount;
  return {
    totalCreatives,
    previewReadyCount,
    previewMissingCount,
    previewCoverage:
      totalCreatives > 0 ? Math.round((previewReadyCount / totalCreatives) * 100) : 0,
  };
}

function pickMediaPayloadValue(row: MetaCreativeApiRow, media: MetaCreativeMediaRow | null) {
  const preview = media?.payloadJson && typeof media.payloadJson === "object"
    ? (media.payloadJson as Partial<MetaCreativeApiRow>)
    : {};
  return {
    ...preview,
    preview_url: media?.previewUrl ?? preview.preview_url ?? row.preview_url ?? null,
    thumbnail_url: media?.thumbnailUrl ?? preview.thumbnail_url ?? row.thumbnail_url ?? null,
    image_url: media?.imageUrl ?? preview.image_url ?? row.image_url ?? null,
    table_thumbnail_url:
      media?.tableThumbnailUrl ?? preview.table_thumbnail_url ?? row.table_thumbnail_url ?? null,
    card_preview_url:
      media?.cardPreviewUrl ?? preview.card_preview_url ?? row.card_preview_url ?? null,
    preview:
      preview.preview && typeof preview.preview === "object"
        ? preview.preview
        : row.preview,
    image_hash: media?.imageHash ?? preview.image_hash ?? row.image_hash ?? null,
  } satisfies Partial<MetaCreativeApiRow>;
}

function hasMediaValue(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function mediaReadinessScore(row: MetaCreativeMediaRow) {
  const payload =
    row.payloadJson && typeof row.payloadJson === "object"
      ? (row.payloadJson as Partial<MetaCreativeApiRow>)
      : {};
  const preview =
    payload.preview && typeof payload.preview === "object"
      ? (payload.preview as unknown as Record<string, unknown>)
      : {};
  return [
    row.previewUrl,
    row.thumbnailUrl,
    row.imageUrl,
    row.tableThumbnailUrl,
    row.cardPreviewUrl,
    row.videoUrl,
    row.posterUrl,
    row.previewHtml,
    payload.preview_url,
    payload.thumbnail_url,
    payload.image_url,
    preview.image_url,
    preview.poster_url,
    preview.video_url,
  ].filter(hasMediaValue).length;
}

function chooseRicherMediaRow(
  existing: MetaCreativeMediaRow | undefined,
  candidate: MetaCreativeMediaRow,
) {
  if (!existing) return candidate;
  return mediaReadinessScore(candidate) > mediaReadinessScore(existing) ? candidate : existing;
}

function overlayCreativeMedia(row: RawCreativeRow, media: MetaCreativeMediaRow | null): RawCreativeRow {
  if (!media) return row;
  const payload = pickMediaPayloadValue(row as unknown as MetaCreativeApiRow, media);
  const previewPayload =
    payload.preview && typeof payload.preview === "object"
      ? (payload.preview as RawCreativeRow["preview"])
      : row.preview;
  return {
    ...row,
    preview_url: payload.preview_url ?? row.preview_url,
    thumbnail_url: payload.thumbnail_url ?? row.thumbnail_url,
    image_url: payload.image_url ?? row.image_url,
    table_thumbnail_url: payload.table_thumbnail_url ?? row.table_thumbnail_url,
    card_preview_url: payload.card_preview_url ?? row.card_preview_url,
    preview: {
      ...previewPayload,
      video_url: media.videoUrl ?? previewPayload.video_url ?? null,
      poster_url: media.posterUrl ?? previewPayload.poster_url ?? null,
    },
    image_hash: payload.image_hash ?? row.image_hash ?? null,
    image_hashes: Array.from(
      new Set([payload.image_hash, row.image_hash, ...(row.image_hashes ?? [])].filter(Boolean) as string[]),
    ),
  };
}

function extractCreativeMediaRow(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  row: RawCreativeRow;
  payloadRow: MetaCreativeApiRow;
  sourceRunId?: string | null;
}): MetaCreativeMediaRow {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    date: input.date,
    campaignId: input.row.campaign_id,
    adsetId: input.row.adset_id,
    adId: input.row.id,
    creativeId: input.row.creative_id,
    previewUrl: input.payloadRow.preview_url ?? input.row.preview_url ?? null,
    thumbnailUrl: input.payloadRow.thumbnail_url ?? input.row.thumbnail_url ?? null,
    imageUrl: input.payloadRow.image_url ?? input.row.image_url ?? null,
    tableThumbnailUrl: input.payloadRow.table_thumbnail_url ?? input.row.table_thumbnail_url ?? null,
    cardPreviewUrl: input.payloadRow.card_preview_url ?? input.row.card_preview_url ?? null,
    videoUrl: input.payloadRow.preview?.video_url ?? input.row.preview?.video_url ?? null,
    posterUrl: input.payloadRow.preview?.poster_url ?? input.row.preview?.poster_url ?? null,
    previewHtml: null,
    mediaCacheKey: input.payloadRow.cached_thumbnail_url ?? null,
    imageHash: input.payloadRow.image_hash ?? input.row.image_hash ?? input.row.image_hashes?.[0] ?? null,
    payloadJson: input.payloadRow,
    sourceRunId: input.sourceRunId ?? null,
  };
}

async function syncMetaCreativesAccountDay(input: {
  businessId: string;
  accountId: string;
  accessToken: string;
  day: string;
  mediaMode?: "metadata" | "full";
  sourceRunId?: string | null;
}) {
  const mediaMode = input.mediaMode ?? "full";
  const enableFullMediaHydration = mediaMode === "full";
  const response = await buildCreativesResponse(
    {
      businessId: input.businessId,
      assignedAccountIds: [input.accountId],
      accessToken: input.accessToken,
      mediaMode,
      enableFullMediaHydration,
      groupBy: "adName",
      format: "all",
      sort: "spend",
      start: input.day,
      end: input.day,
      debugPreview: false,
      debugThumbnail: false,
      debugPerf: false,
      snapshotBypass: true,
      snapshotWarm: false,
      enableCopyRecovery: true,
      enableCreativeBasicsFallback: true,
      enableCreativeDetails: true,
      enableThumbnailBackfill: true,
      enableCardThumbnailBackfill: true,
      enableImageHashLookup: true,
      enableMediaRecovery: true,
      enableMediaCache: true,
      enableDeepAudit: false,
      perAccountSampleLimit: 10,
      requestStartedAt: Date.now(),
      allowSnapshotPersistence: false,
      allowSnapshotRefreshTrigger: false,
    },
    new NextRequest(`http://localhost/api/meta/creatives?businessId=${input.businessId}`)
  );

  const apiRows = (response.rows ?? []) as MetaCreativeApiRow[];
  const rawRows = apiRows
    .map((row) => coerceRawCreativeRow(row))
    .filter((row): row is RawCreativeRow => Boolean(row));
  if (rawRows.length === 0) return;
  const accountCurrency = requireCreativeWarehouseCurrency(
    rawRows,
    input.accountId
  );
  await hydrateCreativeLandingUrls(rawRows, input.accessToken);
  const creativeUsageMap = buildCreativeUsageMap(rawRows);
  const creativeRows = groupRows(rawRows, "creative", creativeUsageMap);
  assertMetaCanonicalClicksSource({ targetField: "clicks", sourceField: "clicks" });

  const creativeDailyRows: MetaCreativeDailyRow[] = creativeRows.map((row) => {
    const payloadRow = buildMetaCreativeApiRow({
      row,
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    });
    return {
      businessId: input.businessId,
      providerAccountId: input.accountId,
      date: input.day,
      campaignId: row.campaign_id,
      adsetId: row.adset_id,
      adId: row.id,
      creativeId: row.creative_id,
      creativeName: row.name,
      headline: row.headline_variants?.[0] ?? null,
      primaryText: row.copy_text ?? row.copy_variants?.[0] ?? null,
      descriptionText: row.description_variants?.[0] ?? null,
      destinationUrl: row.destination_url ?? null,
      destinationUrlRaw: row.destination_url_raw ?? null,
      destinationUrlSource: row.destination_url_source ?? null,
      destinationUrlConfidence: row.destination_url_confidence ?? null,
      ctaType: row.cta_type ?? null,
      objectStoryId: row.object_story_id ?? null,
      effectiveObjectStoryId: row.effective_object_story_id ?? null,
      thumbnailUrl: row.thumbnail_url ?? row.preview_url ?? null,
      assetType: row.creative_type ?? row.format ?? null,
      launchDate: row.launch_date,
      firstSeenAt: row.launch_date ? `${row.launch_date}T00:00:00.000Z` : null,
      firstSpendAt: row.spend > 0 ? `${input.day}T00:00:00.000Z` : null,
      outboundClicks: row.outbound_clicks ?? null,
      landingPageViews: row.landing_page_views,
      addToCart: row.add_to_cart,
      initiateCheckout: row.initiate_checkout,
      effectiveStatus: row.effective_status ?? null,
      objective: row.objective ?? null,
      attributionSetting: row.attribution_setting ?? null,
      qualityRanking: row.quality_ranking ?? null,
      engagementRateRanking: row.engagement_rate_ranking ?? null,
      conversionRateRanking: row.conversion_rate_ranking ?? null,
      bidStrategy: row.bid_strategy ?? null,
      optimizationGoal: row.optimization_goal ?? null,
      campaignDailyBudget: row.campaign_daily_budget ?? null,
      adsetDailyBudget: row.adset_daily_budget ?? null,
      campaignLifetimeBudget: row.campaign_lifetime_budget ?? null,
      adsetLifetimeBudget: row.adset_lifetime_budget ?? null,
      creativeDeliveryType: row.creative_delivery_type ?? null,
      creativeVisualFormat: row.creative_visual_format ?? null,
      creativePrimaryType: row.creative_primary_type ?? null,
      creativeSecondaryType: row.creative_secondary_type ?? null,
      imageHash: row.image_hash ?? row.image_hashes?.[0] ?? null,
      accountTimezone: "UTC",
      accountCurrency,
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      reach: row.reach ?? row.impressions,
      frequency: row.frequency ?? null,
      conversions: row.purchases,
      revenue: row.purchase_value,
      roas: row.roas,
      cpa: row.cpa,
      ctr: row.ctr_all,
      cpc: row.cpc_link,
      linkClicks: row.link_clicks,
      sourceSnapshotId: null,
      sourceRunId: input.sourceRunId ?? null,
      metricSchemaVersion: META_CANONICAL_METRIC_SCHEMA_VERSION,
      payloadJson: payloadRow,
    };
  });
  const creativeMediaRows: MetaCreativeMediaRow[] =
    mediaMode === "full"
      ? rawRows.map((row) =>
          extractCreativeMediaRow({
            businessId: input.businessId,
            providerAccountId: input.accountId,
            date: input.day,
            row,
            payloadRow: buildMetaCreativeApiRow({
              row,
              cachedThumbnailUrl: null,
              cardFallbackThumbnailUrl: null,
              includeDebugFields: false,
            }),
            sourceRunId: input.sourceRunId ?? null,
          }),
        )
      : [];

  // D066: creatives metadata sync performs ZERO meta_ad_daily writes.
  //
  // meta_ad_daily is decision-fact storage owned only by authoritative insights
  // sync. This path used to write it too, which made creative enrichment a
  // second decision-fact writer: even a presentation-looking Ad-name change
  // alters the canonical input hash while leaving an old row cutoff-visible.
  //
  // Nothing is lost. The economic metrics here are the same day's figures the
  // authoritative sync writes from the insights endpoint, and every field this
  // path uniquely owns is persisted by the three dedicated writers below:
  // creative daily facts, creative dimensions, and media presentation storage.
  await Promise.all([
    upsertMetaCreativeDailyRows(creativeDailyRows),
    upsertMetaCreativeMediaRows(creativeMediaRows),
  ]);
}

export async function syncMetaCreativesWarehouseDay(input: {
  businessId: string;
  day: string;
  accessToken: string;
  assignedAccountIds: string[];
  mediaMode?: "metadata" | "full";
  sourceRunId?: string | null;
}) {
  const retentionReferenceDay = toIsoDate(new Date());
  await pruneMetaCreativeMediaOutsideRetention({
    businessId: input.businessId,
    keepFromDate: getCreativeMediaRetentionStart(retentionReferenceDay),
  }).catch(() => null);
  for (const accountId of input.assignedAccountIds) {
    await syncMetaCreativesAccountDay({
      businessId: input.businessId,
      accountId,
      accessToken: input.accessToken,
      day: input.day,
      mediaMode: input.mediaMode,
      sourceRunId: input.sourceRunId ?? null,
    });
  }
}

export async function ensureMetaCreativesWarehouseRangeFilled(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  mediaMode?: "metadata" | "full";
}) {
  const retentionStart = getCreativeMediaRetentionStart(input.endDate);
  await pruneMetaCreativeMediaOutsideRetention({
    businessId: input.businessId,
    keepFromDate: retentionStart,
  }).catch(() => null);
  const [integration, assignedAccountIds, coverage, previewCoverage] = await Promise.all([
    getIntegration(input.businessId, "meta").catch(() => null),
    fetchAssignedAccountIds(input.businessId),
    getMetaCreativeDailyCoverage({
      businessId: input.businessId,
      providerAccountId: null,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => null),
    getMetaCreativeMediaPreviewCoverage({
      businessId: input.businessId,
      providerAccountId: null,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => ({ total_rows: 0, preview_ready_rows: 0 })),
  ]);
  if (!integration || integration.status !== "connected" || !integration.access_token) return null;
  if (assignedAccountIds.length === 0) return null;
  const totalDays =
    Math.max(
      1,
      Math.floor(
        (new Date(`${input.endDate}T00:00:00Z`).getTime() -
          new Date(`${input.startDate}T00:00:00Z`).getTime()) /
          86_400_000
      ) + 1
    );
  if (
    (coverage?.completed_days ?? 0) >= totalDays &&
    (input.mediaMode !== "full" ||
      previewCoverage.total_rows === 0 ||
      previewCoverage.preview_ready_rows >= previewCoverage.total_rows)
  ) {
    return null;
  }

  const days = enumerateDays(input.startDate, input.endDate, true);
  for (const day of days) {
    const shouldRetainMedia = day >= retentionStart;
    const dayCoverage = await getMetaCreativeDailyCoverage({
      businessId: input.businessId,
      providerAccountId: null,
      startDate: day,
      endDate: day,
    }).catch(() => null);
    if ((dayCoverage?.completed_days ?? 0) >= 1) {
      if (input.mediaMode !== "full") continue;
      const dayPreviewCoverage = await getMetaCreativeMediaPreviewCoverage({
        businessId: input.businessId,
        providerAccountId: null,
        startDate: day,
        endDate: day,
      }).catch(() => ({ total_rows: 0, preview_ready_rows: 0 }));
      const dayNeedsMediaHydration =
        dayPreviewCoverage.total_rows > 0 &&
        dayPreviewCoverage.preview_ready_rows < dayPreviewCoverage.total_rows;
      if (!dayNeedsMediaHydration) continue;
      if (!shouldRetainMedia && input.startDate !== input.endDate) continue;
    }
    await syncMetaCreativesWarehouseDay({
      businessId: input.businessId,
      day,
      accessToken: integration.access_token,
      assignedAccountIds,
      mediaMode:
        input.mediaMode === "full" && shouldRetainMedia ? "full" : "metadata",
    });
  }

  return { status: "ok" as const };
}

/**
 * When the warehouse rows behind a creatives response were last written.
 *
 * This is the *metric observation* instant: the moment a sync last wrote the
 * daily facts this payload is built from. It is deliberately not the moment the
 * route ran, not the moment a decision snapshot was computed, and not the
 * `end` date of the requested window — a date is not an instant, and a request
 * time is fresh by construction, which is exactly what `lib/tier-zero-as-of.ts`
 * exists to keep off a freshness bar.
 *
 * The table follows the same split the payload itself uses: creative/adSet
 * groupings are built from `meta_creative_daily`, ad/adName groupings from
 * `meta_ad_daily`. Reading the other table would date the rows from a sync that
 * did not produce them.
 *
 * Returns null rather than a guess when nothing matched or the read failed, so
 * the surface says the age is unknown instead of implying a currency it cannot
 * support. Mirrors `readCopiesWarehouseObservedAt` in
 * `app/api/meta/copies/route.ts`, which is the tested precedent for this shape.
 */
export async function readMetaCreativesWarehouseObservedAt(input: {
  businessId: string;
  providerAccountId: string;
  start: string;
  end: string;
  groupBy: GroupBy;
}): Promise<string | null> {
  const table =
    input.groupBy === "creative" || input.groupBy === "adSet"
      ? "meta_creative_daily"
      : "meta_ad_daily";
  try {
    const sql = getDb();
    const rows = await sql.query<{ observed_at: Date | string | null }>(
      `SELECT MAX(updated_at) AS observed_at
         FROM ${table}
        WHERE business_id = $1
          AND provider_account_id = $2
          AND date BETWEEN $3::date AND $4::date`,
      [input.businessId, input.providerAccountId, input.start, input.end],
    );
    const observedAt = rows[0]?.observed_at ?? null;
    if (!observedAt) return null;
    const parsed =
      observedAt instanceof Date ? observedAt : new Date(observedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  } catch {
    // An unreadable timestamp is an unknown age, never a fresh one.
    return null;
  }
}

export async function getMetaCreativesWarehousePayload(input: {
  businessId: string;
  providerAccountId?: string | null;
  creativeId?: string | null;
  start: string;
  end: string;
  groupBy: GroupBy;
  format: FormatFilter;
  sort: SortKey;
  mediaMode: "metadata" | "full";
}) {
  const assignedAccountIds = await fetchAssignedAccountIds(input.businessId);
  const accountScope = resolveMetaCreativesAccountScope({
    assignedAccountIds,
    requestedProviderAccountId: input.providerAccountId,
  });
  if (!accountScope.ok) {
    return {
      status: accountScope.status,
      rows: [] as MetaCreativeApiRow[],
      ...buildMetaCreativesAccountScopeMetadata(accountScope),
    };
  }
  const scopedAccountIds = accountScope.assignedAccountIds;
  const creativeId = input.creativeId?.trim() || null;

  const useCreativeWarehouse = input.groupBy === "creative" || input.groupBy === "adSet";
  const queriedSourceRows = useCreativeWarehouse
    ? await getMetaCreativeDailyRange({
        businessId: input.businessId,
        startDate: input.start,
        endDate: input.end,
        providerAccountIds: scopedAccountIds,
      })
    : await getMetaAdDailyRange({
        businessId: input.businessId,
        startDate: input.start,
        endDate: input.end,
        providerAccountIds: scopedAccountIds,
      });
  const accountScopedSourceRows = queriedSourceRows.filter(
    (row) => row.providerAccountId === accountScope.providerAccountId,
  );
  const sourceRowsBeforeAdCreativeFilter =
    useCreativeWarehouse && creativeId
      ? (accountScopedSourceRows as MetaCreativeDailyRow[]).filter(
          (row) => row.creativeId === creativeId,
        )
      : accountScopedSourceRows;
  const creativeSourceRowsForDimensions = useCreativeWarehouse
    ? (sourceRowsBeforeAdCreativeFilter as MetaCreativeDailyRow[])
    : null;
  const adSourceRowsForDimensions = useCreativeWarehouse
    ? null
    : (sourceRowsBeforeAdCreativeFilter as MetaAdDailyRow[]);
  const dimensionRows = useCreativeWarehouse
    ? await readMetaCreativeDimensions({
        businessId: input.businessId,
        creativeIds: creativeSourceRowsForDimensions
          ?.map((row) => row.creativeId)
          .filter((value): value is string => Boolean(value)) ?? [],
      })
    : await readMetaAdDimensions({
        businessId: input.businessId,
        adIds: adSourceRowsForDimensions
          ?.map((row) => row.adId)
          .filter((value): value is string => Boolean(value)) ?? [],
      });
  const sourceRows =
    !useCreativeWarehouse && creativeId
      ? (sourceRowsBeforeAdCreativeFilter as MetaAdDailyRow[]).filter(
          (row) =>
            resolveAdCreativeId(
              row,
              (dimensionRows as Map<string, MetaAdDimensionRecord>).get(row.adId),
            ) === creativeId,
        )
      : sourceRowsBeforeAdCreativeFilter;
  const creativeSourceRows = useCreativeWarehouse
    ? (sourceRows as MetaCreativeDailyRow[])
    : null;
  const adSourceRows = useCreativeWarehouse ? null : (sourceRows as MetaAdDailyRow[]);
  const adFunnelFallbacks =
    !useCreativeWarehouse && adSourceRows?.length
      ? await readUniqueAdFunnelFallbacks({
          businessId: input.businessId,
          start: input.start,
          end: input.end,
          providerAccountIds: scopedAccountIds,
          adRows: adSourceRows,
          adDimensions: dimensionRows as Map<string, MetaAdDimensionRecord>,
        })
      : new Map<string, MetaCreativeDailyRow>();
  const mediaByCreativeKey = new Map<string, MetaCreativeMediaRow>();
  const mediaByAdKey = new Map<string, MetaCreativeMediaRow>();
  if (input.mediaMode === "full" && sourceRows.length) {
    const creativeIds = useCreativeWarehouse
      ? creativeSourceRows
          ?.map((row) => row.creativeId)
          .filter((value): value is string => Boolean(value)) ?? []
      : [];
    const adIds = !useCreativeWarehouse
      ? adSourceRows
          ?.map((row) => row.adId)
          .filter((value): value is string => Boolean(value)) ?? []
      : [];
    const mediaRows = await getMetaCreativeMediaRange({
      businessId: input.businessId,
      startDate: input.start,
      endDate: input.end,
      providerAccountIds: scopedAccountIds,
      creativeIds: useCreativeWarehouse ? creativeIds : null,
      adIds: useCreativeWarehouse ? null : adIds,
    }).catch(() => []);
    for (const row of mediaRows) {
      const creativeKey = `${row.providerAccountId}|${row.date}|${row.creativeId}`;
      mediaByCreativeKey.set(creativeKey, chooseRicherMediaRow(mediaByCreativeKey.get(creativeKey), row));
      if (row.adId) {
        const adKey = `${row.providerAccountId}|${row.date}|${row.adId}`;
        mediaByAdKey.set(adKey, chooseRicherMediaRow(mediaByAdKey.get(adKey), row));
      }
    }
  }
  const rawRows: RawCreativeRow[] = sourceRows.reduce<RawCreativeRow[]>((acc, row) => {
      const factRow =
        !useCreativeWarehouse
          ? overlayAdFunnelFallback(
              row as MetaAdDailyRow,
              adFunnelFallbacks.get(adFactKey(row as MetaAdDailyRow)),
            )
          : row;
      const dimensionRow = useCreativeWarehouse
        ? dimensionRows.get((factRow as MetaCreativeDailyRow).creativeId)
        : dimensionRows.get((factRow as MetaAdDailyRow).adId);
      const projectionRow =
        coerceRawCreativeRow(dimensionRow?.projectionJson) ??
        (!useCreativeWarehouse
          ? buildFallbackAdRawRow({
              factRow: row as MetaAdDailyRow,
              projectionJson: dimensionRow?.projectionJson,
              creativeId: dimensionRow?.creativeId ?? null,
            })
          : null);
      if (!projectionRow) return acc;
      const mediaRow = useCreativeWarehouse
        ? mediaByCreativeKey.get(
            `${(row as MetaCreativeDailyRow).providerAccountId}|${(row as MetaCreativeDailyRow).date}|${(row as MetaCreativeDailyRow).creativeId}`,
          ) ?? null
        : mediaByAdKey.get(
            `${(row as MetaAdDailyRow).providerAccountId}|${(row as MetaAdDailyRow).date}|${(row as MetaAdDailyRow).adId}`,
          ) ?? null;
      const hydratedRow = hydrateWarehouseCreativeMetrics({
          row: overlayCreativeMedia(projectionRow, mediaRow),
          factRow,
        });
      acc.push(
        input.groupBy === "ad" && !useCreativeWarehouse
          ? {
              ...hydratedRow,
              name:
                (factRow as MetaAdDailyRow).adNameCurrent ??
                (factRow as MetaAdDailyRow).adNameHistorical ??
                hydratedRow.name,
            }
          : hydratedRow,
      );
      return acc;
    }, []);

  const exactCreativeRows = creativeId
    ? rawRows.filter((row) => row.creative_id === creativeId)
    : rawRows;
  const filteredRows = normalizeCreativeRows(exactCreativeRows, input.format);
  const creativeUsageMap = buildCreativeUsageMap(filteredRows);
  const groupedRows =
    input.groupBy === "adName"
      ? filteredRows
      : groupRows(filteredRows, input.groupBy, creativeUsageMap);
  const sortedRows = sortRows(groupedRows, input.sort);
  const useLightweightRowMap = input.mediaMode === "metadata";
  const responseRows = sortedRows.map((row) =>
    useLightweightRowMap
      ? buildMetaCreativeApiRowLightweight({
          row,
          includeDebugFields: false,
        })
      : buildMetaCreativeApiRow({
          row,
          cachedThumbnailUrl: null,
          cardFallbackThumbnailUrl: null,
          includeDebugFields: false,
        })
  );
  const previewCoverage = buildPreviewCoverage(responseRows);
  const previewMissingCount = previewCoverage.previewMissingCount;
  const previewHydrating = input.mediaMode === "full" && previewMissingCount > 0;

  return {
    status: "ok",
    rows: responseRows,
    ...buildMetaCreativesAccountScopeMetadata(accountScope),
    media_mode: input.mediaMode,
    media_hydrated: input.mediaMode === "full" && previewMissingCount === 0,
    snapshot_source: "persisted" as const,
    snapshot_level: input.mediaMode,
    freshness_state: previewHydrating ? ("stale" as const) : ("fresh" as const),
    is_refreshing: previewHydrating,
    preview_coverage: previewCoverage,
    // The age of these rows, taken from the table that produced them. Surfaces
    // read this and nothing else as their as-of; see
    // `readMetaCreativesWarehouseObservedAt` for why the alternatives are not
    // observation instants.
    warehouse_observed_at: await readMetaCreativesWarehouseObservedAt({
      businessId: input.businessId,
      providerAccountId: accountScope.providerAccountId,
      start: input.start,
      end: input.end,
      groupBy: input.groupBy,
    }),
  };
}

export async function getMetaCreativeHistoryWarehouseRows(input: {
  businessId: string;
  start: string;
  end: string;
  providerAccountIds?: string[] | null;
}) {
  return getMetaCreativeDailyRange({
    businessId: input.businessId,
    startDate: input.start,
    endDate: input.end,
    providerAccountIds: input.providerAccountIds,
  });
}
