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
  CreativeSourceIdentityFields,
  FormatFilter,
  GroupBy,
  MetaCreativeApiRow,
  NormalizedRenderPreviewPayload,
  RawCreativeRow,
  SortKey,
} from "@/lib/meta/creatives-types";
import {
  CREATIVE_METRIC_PRESENCE_KEYS,
  META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION,
  META_UNRESOLVED_CREATIVE_ID_PREFIX,
  isCreativeMetricDeclaredAvailable,
  isMetaUnresolvedCreativeId,
  readCreativeSourceIdentity,
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
} from "@/lib/meta/request-model-store";
import type { MetaAdDailyRow, MetaCreativeDailyRow, MetaCreativeMediaRow } from "@/lib/meta/warehouse-types";
import { getCreativeMediaRetentionStart } from "@/lib/meta/history";
import { pruneMetaCreativeMediaOutsideRetention } from "@/lib/meta/cleanup";
import { normalizeMetaCurrencyCode } from "@/lib/meta/account-context";
import { META_OBSERVATION_RECEIPT_AUTHORITY_SQL } from "@/lib/meta/observation-receipt-schema";
import { certifyCreativeDayConfigFromReceipts } from "@/lib/meta/creative-day-config-proof";
import {
  buildMetaCreativeDayMetricEvidence,
  META_CREATIVE_DAY_METRIC_EVIDENCE_KEY,
  mergeMetaCreativeDayMetricEvidence,
  readMetaCreativeDayStageValue,
} from "@/lib/meta/creative-day-metric-evidence";

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
  // The legacy wire still requires a number, but ALL clicks are not LINK
  // clicks. Keep a neutral numeric placeholder when the ad-day did not measure
  // link clicks and let `metric_presence.link_clicks = false` carry the missing
  // fact. The hydrator repeats this rule so a future direct caller of this
  // fallback cannot revive the old all-click -> link-click substitution.
  const linkClicks = factRow.linkClicks ?? 0;
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

/**
 * The members one persisted creative day stood for, read from that day's own
 * payload.
 *
 * A `meta_creative_daily` row is itself a group: its `ad_id` is the group's
 * synthesised handle (`creative_1w1r1ne` on Grandmix), and its `creative_id` is
 * the one member the sync met first that day. A payload written since the
 * source lists existed carries every member. An older one names only that
 * first member's Ad (`real_ad_id`) — an exact member, and ALL of them only when
 * the day counted one Ad: `associated_ads_count` has been the day's distinct
 * member-Ad count since `real_ad_id` was first written (0bd944db9), so `1`
 * beside a `real_ad_id` means that Ad was the whole group. Measured on Grandmix
 * (act_805150454596350, 2026-08-24..09-22): 964 of 1,287 creative days counted
 * one Ad. Otherwise the list is marked incomplete. The group's own handle is
 * never a member Ad.
 */
function readCreativeDaySourceIdentity(
  factRow: MetaCreativeDailyRow,
): CreativeSourceIdentityFields {
  const payload =
    factRow.payloadJson && typeof factRow.payloadJson === "object"
      ? (factRow.payloadJson as Record<string, unknown>)
      : null;
  const carried = readCreativeSourceIdentity(payload);
  const groupHandle = factRow.adId?.trim() || null;
  const legacyAdId =
    typeof payload?.real_ad_id === "string" ? payload.real_ad_id.trim() : "";
  const statedAdIds = carried
    ? carried.source_ad_ids
    : legacyAdId
      ? [legacyAdId]
      : [];
  // Earlier creative-day writers folded several Ads into one row while keeping
  // the first member's `real_ad_id` and even `associated_ads_count: 1`. Those
  // fields identify a possible member, not the whole group. Only the versioned
  // writer validates the complete list against every grouped Ad before persist.
  const versionedMembership =
    payload?.source_identity_version === META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION;
  const statedComplete =
    versionedMembership && carried?.source_ad_ids_complete === true;
  const adIds = statedAdIds.filter((id) => id && id !== groupHandle);
  const creativeIds = [...(carried?.source_creative_ids ?? [])];
  const dayCreativeId = factRow.creativeId?.trim();
  if (dayCreativeId && !creativeIds.includes(dayCreativeId)) {
    creativeIds.push(dayCreativeId);
  }
  return {
    source_ad_ids: adIds,
    source_ad_ids_complete:
      statedComplete && adIds.length > 0 && adIds.length === statedAdIds.length,
    source_creative_ids: creativeIds,
  };
}

function readCreativeDayReachAggregation(
  factRow: MetaCreativeDailyRow,
): RawCreativeRow["reach_aggregation"] {
  const payload =
    factRow.payloadJson && typeof factRow.payloadJson === "object" &&
    !Array.isArray(factRow.payloadJson)
      ? factRow.payloadJson as Record<string, unknown>
      : null;
  const identity = readCreativeDaySourceIdentity(factRow);
  if (
    payload?.reach_aggregation === "single_ad_provider_reach" &&
    identity.source_ad_ids_complete &&
    identity.source_ad_ids.length === 1
  ) return "single_ad_provider_reach";
  if (payload?.reach_aggregation === "sum_of_ad_reach_not_deduplicated") {
    return "sum_of_ad_reach_not_deduplicated";
  }
  return "unknown";
}

function hasVerifiedCreativeDayIdentity(row: MetaCreativeDailyRow) {
  const payload = row.payloadJson;
  if (!payload || typeof payload !== "object") return false;
  const stored = payload as Record<string, unknown>;
  const membership = readCreativeDaySourceIdentity(row);
  return stored.source_identity_version ===
      META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION &&
    membership.source_ad_ids_complete &&
    membership.source_creative_ids.length === 1 &&
    membership.source_creative_ids[0] === row.creativeId &&
    stored.associated_ads_count === membership.source_ad_ids.length;
}

export function hydrateWarehouseCreativeMetrics<T extends RawCreativeRow>(input: {
  row: T;
  factRow: MetaAdDailyRow | MetaCreativeDailyRow;
}) {
  // Keep the legacy numeric shape, with absence carried in metric_presence.
  // An ad-day owns its funnel measurements. Neither a creative-day nor a
  // latest dimension projection can establish a missing ad-day counter.
  // Creative-grain reads retain their existing explicitly-declared fallback.
  // In both cases a measured zero wins through ??, never truthiness.
  const isAdFact = "adId" in input.factRow && !("creativeId" in input.factRow);
  const reachAggregation = isAdFact
    ? "single_ad_provider_reach"
    : readCreativeDayReachAggregation(input.factRow as MetaCreativeDailyRow);
  const frequencyObserved =
    (isAdFact || (
      reachAggregation === "single_ad_provider_reach" &&
      typeof input.factRow.reach === "number" &&
      Number.isFinite(input.factRow.reach) &&
      input.factRow.reach >= 0 &&
      (input.factRow.impressions <= 0 || input.factRow.reach > 0)
    )) &&
    input.factRow.frequency != null && Number.isFinite(input.factRow.frequency) &&
    (isAdFact || input.factRow.impressions <= 0 || input.factRow.frequency > 0);
  const resolvedLinkClicks = input.factRow.linkClicks ?? (isAdFact ? 0 : input.row.link_clicks);
  const resolvedAddToCart = input.factRow.addToCart ?? (isAdFact ? 0 : input.row.add_to_cart);
  const projectionDeclares = (key: CreativeMetricPresenceKey) =>
    !isAdFact && isCreativeMetricDeclaredAvailable(input.row.metric_presence, key);

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
    // A creative day's members come from the day's own payload — `real_ad_id`
    // above is the group's handle there, and the projection spread above is
    // whichever day synced last. An ad day adds nothing: it is one Ad.
    ...("creativeId" in input.factRow
      ? readCreativeDaySourceIdentity(input.factRow)
      : {}),
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
    reach_observation_day: input.factRow.date,
    reach_aggregation: reachAggregation,
    frequency: frequencyObserved ? input.factRow.frequency : null,
    link_clicks: resolvedLinkClicks,
    destination_url: input.factRow.destinationUrl ?? input.row.destination_url ?? null,
    destination_url_raw: input.factRow.destinationUrlRaw ?? input.row.destination_url_raw ?? null,
    destination_url_source: input.factRow.destinationUrlSource ?? input.row.destination_url_source ?? null,
    destination_url_confidence:
      input.factRow.destinationUrlConfidence ?? input.row.destination_url_confidence ?? null,
    cta_type: input.factRow.ctaType ?? input.row.cta_type ?? null,
    outbound_clicks: input.factRow.outboundClicks ?? (isAdFact ? 0 : input.row.outbound_clicks),
    landing_page_views: input.factRow.landingPageViews ?? (isAdFact ? 0 : input.row.landing_page_views),
    add_to_cart: resolvedAddToCart,
    initiate_checkout: input.factRow.initiateCheckout ?? (isAdFact ? 0 : input.row.initiate_checkout),
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
    // if the day's fact row supplied it. At creative grain only, a projection
    // may explicitly DECLARE it. A projection's silence is not evidence.
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
          projectionDeclares("link_clicks"),
        landing_page_views:
          input.factRow.landingPageViews != null ||
          projectionDeclares("landing_page_views"),
        add_to_cart:
          input.factRow.addToCart != null ||
          projectionDeclares("add_to_cart"),
        initiate_checkout:
          input.factRow.initiateCheckout != null ||
          projectionDeclares("initiate_checkout"),
        // A current dimension's frequency cannot repair an unverified day,
        // and a sum of Ad reach cannot establish unique creative frequency.
        frequency: frequencyObserved,
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

function adDayIdentityKey(row: {
  providerAccountId: string;
  date: string;
}, adId: string) {
  return JSON.stringify([row.providerAccountId, row.date, adId]);
}

function adDayKnownAtCutoff(row: MetaAdDailyRow, cutoffAt: string) {
  const cutoffMs = Date.parse(cutoffAt);
  const createdMs = Date.parse(row.createdAt ?? "");
  const updatedMs = Date.parse(row.updatedAt ?? "");
  return Number.isFinite(cutoffMs) && Number.isFinite(createdMs) &&
    Number.isFinite(updatedMs) && createdMs < cutoffMs && updatedMs < cutoffMs;
}

function isCurrentProviderLocalDay(day: string, timeZone: string | null | undefined) {
  if (!timeZone?.trim()) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    return day === `${value("year")}-${value("month")}-${value("day")}`;
  } catch {
    return false;
  }
}

function isPresentableProvisionalCreativeDay(row: MetaCreativeDailyRow) {
  const payload = row.payloadJson;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const identity = readCreativeSourceIdentity(record);
  return isCurrentProviderLocalDay(row.date, row.accountTimezone) &&
    record.source_economics_provenance === "provisional_meta_ad_daily" &&
    record.source_membership_scope === "current_provider_ad_days_provisional" &&
    record.source_scope_status !== "empty_provider_and_ad_daily" &&
    record.source_identity_version == null &&
    identity?.source_ad_ids_complete === false &&
    identity.source_ad_ids.length > 0 &&
    identity.source_creative_ids.length === 1 &&
    identity.source_creative_ids[0] === row.creativeId;
}

/**
 * A creative-filtered Ad read must use point-in-time provider Ad identity,
 * never a mutable current dimension or a collapsed creative-day aggregate.
 * A provider observation before the local reporting day, no conflicting
 * identity observed during it, and a complete account capture soon after it
 * bracket the Ad-day. Both provider and capture clocks obey the caller's
 * knowledge cutoff; re-used runs enter through their immutable receipt clocks.
 * Ad-day facts alone supply all metrics after this relation is established.
 */
export async function readProvableAdCreativeIdentityForDays(input: {
  businessId: string;
  providerAccountId: string;
  requestedCreativeId?: string | null;
  start: string;
  end: string;
  knowledgeCutoffAt: string;
}) {
  const recovered = new Map<string, string>();
  const cutoffMs = Date.parse(input.knowledgeCutoffAt);
  if (!Number.isFinite(cutoffMs)) return recovered;
  const sql = getDb();
  const rows = await sql.query<{ date: string; ad_id: string; creative_id: string }>(
    `WITH ad_days AS MATERIALIZED (
       SELECT d.date, d.ad_id, d.campaign_id, d.adset_id,
              (d.date::timestamp AT TIME ZONE d.account_timezone) AS day_start,
              ((d.date + 1)::timestamp AT TIME ZONE d.account_timezone) AS day_end
         FROM meta_ad_daily d
        WHERE d.business_id = $1 AND d.provider_account_id = $2
          AND d.date BETWEEN $4::date AND $5::date
          AND d.campaign_id IS NOT NULL AND d.adset_id IS NOT NULL
          AND d.account_timezone IS NOT NULL
          AND d.created_at < $6::timestamptz
          AND d.updated_at < $6::timestamptz
     ), day_brackets AS MATERIALIZED (
       SELECT bounds.date, bounds.day_end,
              receipt.bracket_observed_at
         FROM (SELECT DISTINCT date, day_end FROM ad_days) bounds
         JOIN LATERAL (
           SELECT authoritative.observed_at AS bracket_observed_at
             FROM (${META_OBSERVATION_RECEIPT_AUTHORITY_SQL}) authoritative
             JOIN meta_entity_observation_runs run ON run.id = authoritative.run_id
            WHERE authoritative.business_id = $1
              AND authoritative.provider_account_id = $2
              AND authoritative.entity_type = 'ad'
              AND authoritative.endpoint = 'ad_configs'
              AND authoritative.capture_status = 'complete'
              AND run.completeness = 'complete'
              AND run.delta_stats_json ->> 'manifestContract' = 'd075.complete-scope-manifest.v1'
              AND authoritative.observed_at >= bounds.day_end
              AND authoritative.observed_at < bounds.day_end + INTERVAL '36 hours'
              AND authoritative.observed_at < $6::timestamptz
              AND authoritative.captured_at < $6::timestamptz
              AND authoritative.created_at < $6::timestamptz
            ORDER BY authoritative.observed_at ASC,
                     authoritative.captured_at ASC, authoritative.id ASC
            LIMIT 1
         ) receipt ON true
     )
     SELECT d.date::text AS date, d.ad_id, before_day.creative_id
       FROM ad_days d
       JOIN day_brackets bracket ON bracket.date = d.date AND bracket.day_end = d.day_end
       JOIN LATERAL (
         SELECT h.creative_id, h.campaign_id, h.adset_id,
                h.presence, h.observed_at
           FROM meta_entity_state_history h
          WHERE h.business_id = $1 AND h.provider_account_id = $2
            AND h.entity_type = 'ad' AND h.entity_id = d.ad_id
            AND h.observed_at <= d.day_start
            AND h.observed_at < $6::timestamptz
            AND h.captured_at < $6::timestamptz
            AND h.created_at < $6::timestamptz
          ORDER BY h.observed_at DESC, h.captured_at DESC,
                   h.created_at DESC, h.id DESC LIMIT 1
       ) before_day ON true
      WHERE before_day.presence = 'present'
        AND before_day.creative_id IS NOT NULL
        AND ($3::text IS NULL OR before_day.creative_id = $3)
        AND before_day.campaign_id = d.campaign_id
        AND before_day.adset_id = d.adset_id
        AND NOT EXISTS (
          SELECT 1 FROM meta_entity_state_history change
           WHERE change.business_id = $1 AND change.provider_account_id = $2
             AND change.entity_type = 'ad' AND change.entity_id = d.ad_id
             AND change.observed_at >= before_day.observed_at
             AND change.observed_at <= bracket.bracket_observed_at
             AND change.observed_at < $6::timestamptz
             AND change.captured_at < $6::timestamptz
             AND change.created_at < $6::timestamptz
             AND (change.creative_id IS DISTINCT FROM before_day.creative_id
               OR change.campaign_id IS DISTINCT FROM d.campaign_id
               OR change.adset_id IS DISTINCT FROM d.adset_id
               OR change.presence IS DISTINCT FROM 'present')
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta_entity_tombstones gone
           WHERE gone.business_id = $1 AND gone.provider_account_id = $2
             AND gone.entity_type = 'ad' AND gone.entity_id = d.ad_id
             AND gone.observed_at >= before_day.observed_at
             AND gone.observed_at <= bracket.bracket_observed_at
             AND gone.observed_at < $6::timestamptz
             AND gone.captured_at < $6::timestamptz
             AND gone.created_at < $6::timestamptz
        )`,
    [input.businessId, input.providerAccountId, input.requestedCreativeId ?? null,
      input.start, input.end, input.knowledgeCutoffAt],
  );
  for (const row of rows) {
    if (typeof row.date === "string" && typeof row.ad_id === "string" &&
      typeof row.creative_id === "string" && row.creative_id.trim()) {
      recovered.set(adDayIdentityKey({
        providerAccountId: input.providerAccountId,
        date: row.date,
      }, row.ad_id), row.creative_id);
    }
  }
  return recovered;
}

export async function readAdCreativeIdsForDays(input: {
  businessId: string;
  providerAccountId: string;
  requestedCreativeId?: string | null;
  start: string;
  end: string;
  knowledgeCutoffAt: string;
}) {
  return readProvableAdCreativeIdentityForDays(input);
}

/**
 * A current Ad detail response is not evidence of the Ad's creative on an
 * earlier reporting day. Finalized creative-day facts require every provider
 * Ad row to agree with an Ad-day fact and strict day-bracket identity proof.
 * The separate provisional mode permits current-day presentation only; its
 * caller withholds the v2 admission marker and config certification.
 */
export function assessCreativeDayWriterIdentityProof(input: {
  providerAccountId: string;
  day: string;
  rows: RawCreativeRow[];
  adFacts: MetaAdDailyRow[];
  provenCreativeByAdDay: Map<string, string>;
  mode?: "finalized" | "provisional_presentation";
}): { canWrite: true; accountTimezone: string; accountCurrency: string } |
  { canWrite: false; reason: string; adId: string | null } {
  const facts = new Map(input.adFacts.map((row) => [row.adId, row]));
  const providerAdIds = new Set<string>();
  let accountTimezone: string | null = null;
  let accountCurrency: string | null = null;
  for (const row of input.rows) {
    const adId = row.real_ad_id ?? row.id;
    if (!adId || !row.creative_id || isMetaUnresolvedCreativeId(row.creative_id)) {
      return { canWrite: false, reason: "provider_ad_or_creative_identity_missing", adId: adId || null };
    }
    if (providerAdIds.has(adId)) {
      return { canWrite: false, reason: "provider_ad_identity_duplicate", adId };
    }
    providerAdIds.add(adId);
    const fact = facts.get(adId);
    const provisional = input.mode === "provisional_presentation";
    if (!fact || fact.providerAccountId !== input.providerAccountId ||
        fact.date !== input.day || !fact.sourceSnapshotId || !fact.sourceRunId ||
        (provisional
          ? fact.truthState !== "provisional" || fact.validationStatus !== "pending"
          : fact.truthState !== "finalized" || fact.validationStatus !== "passed" ||
            !fact.finalizedAt)) {
      return { canWrite: false, reason: provisional
        ? "provisional_ad_day_fact_missing" : "finalized_ad_day_fact_missing", adId };
    }
    if (!fact.accountTimezone?.trim() || !fact.accountCurrency?.trim() ||
        fact.accountCurrency !== row.currency ||
        (accountTimezone !== null && accountTimezone !== fact.accountTimezone) ||
        (accountCurrency !== null && accountCurrency !== fact.accountCurrency)) {
      return { canWrite: false, reason: "account_context_missing_or_mixed", adId };
    }
    accountTimezone = fact.accountTimezone;
    accountCurrency = fact.accountCurrency;
    if (!row.campaign_id || !row.adset_id ||
        fact.campaignId !== row.campaign_id || fact.adsetId !== row.adset_id) {
      return { canWrite: false, reason: "ad_day_parent_identity_mismatch", adId };
    }
    if (!provisional) {
      const provenCreativeId = input.provenCreativeByAdDay.get(JSON.stringify([
        input.providerAccountId, input.day, adId,
      ]));
      if (!provenCreativeId) {
        return { canWrite: false, reason: "historical_creative_identity_unprovable", adId };
      }
      if (provenCreativeId !== row.creative_id) {
        return { canWrite: false, reason: "current_ad_detail_conflicts_with_historical_creative_identity", adId };
      }
    }
  }
  for (const fact of input.adFacts) {
    if (fact.providerAccountId !== input.providerAccountId || fact.date !== input.day ||
        ![fact.spend, fact.impressions, fact.clicks, fact.conversions, fact.revenue]
          .some((value) => value > 0)) continue;
    if (!providerAdIds.has(fact.adId)) {
      return { canWrite: false, reason: "finalized_ad_day_missing_from_provider_scope",
        adId: fact.adId };
    }
  }
  if (!accountTimezone || !accountCurrency) {
    return { canWrite: false, reason: "account_context_missing_or_mixed", adId: null };
  }
  return { canWrite: true, accountTimezone, accountCurrency };
}

/** The authoritative economics and funnel evidence for one proved creative-day. */
export function buildCanonicalCreativeDayMetrics(
  row: RawCreativeRow,
  factsByAd: Map<string, MetaAdDailyRow>,
) {
  const source = readCreativeSourceIdentity(row);
  if (!source?.source_ad_ids_complete || source.source_ad_ids.length === 0 ||
      source.source_creative_ids.length !== 1 || source.source_creative_ids[0] !== row.creative_id) {
    throw new Error("meta_creative_day_source_membership_incomplete");
  }
  const members = source.source_ad_ids.map((id) => factsByAd.get(id));
  if (members.some((fact) => !fact)) {
    throw new Error("meta_creative_day_source_ad_fact_missing");
  }
  const facts = members as MetaAdDailyRow[];
  const sum = (get: (fact: MetaAdDailyRow) => number) =>
    facts.reduce((total, fact) => total + get(fact), 0);
  const spend = sum((fact) => fact.spend);
  const impressions = sum((fact) => fact.impressions);
  const clicks = sum((fact) => fact.clicks);
  const reach = sum((fact) => fact.reach);
  const conversions = sum((fact) => fact.conversions);
  const revenue = sum((fact) => fact.revenue);
  // A NOT NULL zero in meta_ad_daily does not establish an observed purchase
  // event when the provider never supplied actions for that Ad-day (D099).
  const purchasesObserved = facts.every((fact) => {
    const payload = fact.payloadJson;
    return payload !== null && typeof payload === "object" &&
      !Array.isArray(payload) &&
      Array.isArray((payload as Record<string, unknown>).actions);
  });
  const linkClicks = facts.every((fact) => fact.linkClicks != null)
    ? sum((fact) => fact.linkClicks!) : null;
  const outboundClicks = facts.every((fact) => fact.outboundClicks != null)
    ? sum((fact) => fact.outboundClicks!) : null;
  const evidenceParts = facts.map((fact) => buildMetaCreativeDayMetricEvidence(
    fact.payloadJson && typeof fact.payloadJson === "object" && !Array.isArray(fact.payloadJson)
      ? fact.payloadJson as Record<string, unknown> : {},
  ));
  const evidence = evidenceParts.slice(1).reduce(
    (merged, part) => mergeMetaCreativeDayMetricEvidence(merged, part), evidenceParts[0]!,
  );
  const stage = (key: "link_click" | "landing_page_view" | "add_to_cart" |
    "initiate_checkout" | "outbound_click") =>
    readMetaCreativeDayStageValue({ [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: evidence }, key);
  const landingPageViews = stage("landing_page_view");
  const addToCart = stage("add_to_cart");
  const initiateCheckout = stage("initiate_checkout");
  return {
    spend, impressions, clicks, reach, conversions, revenue,
    frequency: facts.length === 1 ? facts[0]!.frequency : null,
    roas: spend > 0 ? revenue / spend : 0,
    cpa: conversions > 0 ? spend / conversions : null,
    ctr: impressions > 0 ? clicks / impressions * 100 : null,
    cpc: linkClicks != null && linkClicks > 0 ? spend / linkClicks : null,
    linkClicks, outboundClicks, landingPageViews, addToCart,
    initiateCheckout, evidence,
    sourceSnapshotIds: [...new Set(facts.map((fact) => fact.sourceSnapshotId).filter(Boolean))],
    sourceRunIds: [...new Set(facts.map((fact) => fact.sourceRunId).filter(Boolean))],
    metricPresence: {
      spend: true, impressions: true, clicks: true,
      purchases: purchasesObserved, purchase_value: purchasesObserved,
      roas: purchasesObserved && spend > 0,
      cpa: purchasesObserved && conversions > 0,
      ctr_all: impressions > 0, cpc_link: linkClicks != null && linkClicks > 0,
      link_clicks: linkClicks != null,
      landing_page_views: landingPageViews != null,
      add_to_cart: addToCart != null, initiate_checkout: initiateCheckout != null,
      frequency: facts.length === 1 && facts[0]!.frequency != null,
    },
  };
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
      strictSourceCompleteness: true,
    },
    new NextRequest(`http://localhost/api/meta/creatives?businessId=${input.businessId}`)
  );

  const apiRows = (response.rows ?? []) as MetaCreativeApiRow[];
  if (apiRows.some((row) => {
    const creativeId = typeof row.creative_id === "string"
      ? row.creative_id.trim()
      : "";
    return (!creativeId || isMetaUnresolvedCreativeId(creativeId)) && [
      row.spend,
      row.impressions,
      row.clicks,
      row.link_clicks,
      row.purchases,
      row.purchase_value,
      row.landing_page_views,
      row.add_to_cart,
      row.initiate_checkout,
    ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  })) {
    throw new Error("meta_creative_day_provider_identity_incomplete");
  }
  const rawRows = apiRows
    .map((row) => coerceRawCreativeRow(row))
    .filter((row): row is RawCreativeRow => Boolean(row));
  if (rawRows.length === 0) {
    const adFacts = await getMetaAdDailyRange({
      businessId: input.businessId, providerAccountIds: [input.accountId],
      startDate: input.day, endDate: input.day,
    });
    const positiveFacts = adFacts.filter((fact) =>
      ((fact.truthState === "finalized" && fact.validationStatus === "passed") ||
        (fact.truthState === "provisional" && fact.validationStatus === "pending")) &&
      [fact.spend, fact.impressions, fact.clicks, fact.conversions, fact.revenue]
        .some((value) => value > 0));
    if (positiveFacts.length > 0) {
      // A current Meta re-read can restate history. The existing finalized
      // Ad-day version still owns economics; an empty later report does not
      // erase that prior observation or any matching certified creative row.
      console.warn("[meta-creatives] empty provider scope conflicts with Ad-day facts", {
        businessId: input.businessId, accountId: input.accountId,
        day: input.day, positiveAds: positiveFacts.length,
      });
      return;
    }
    // A complete empty provider read plus no finalized positive Ad-day facts
    // cannot support an old positive creative-day decision. Invalidate only
    // its authority marker; keep the row as audit history and leave media.
    await getDb().query(
      `UPDATE meta_creative_daily
          SET payload_json = ((COALESCE(payload_json, '{}'::jsonb)
            - 'source_identity_version' - 'historical_config_proof') ||
            jsonb_build_object('source_scope_status', 'empty_provider_and_ad_daily',
              'historical_config_provenance', 'unverified')) ||
            CASE WHEN payload_json->>'historical_config_provenance' IN
                ('provider_receipt_day_bracketed', 'provider_receipt_legacy_bracketed')
              AND jsonb_typeof(payload_json->'historical_config_proof') = 'object'
              THEN jsonb_build_object('historical_config_authority_changed_at',
                to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
              ELSE '{}'::jsonb END,
              updated_at = now()
        WHERE business_id = $1 AND provider_account_id = $2 AND date = $3::date
          AND (payload_json->>'source_identity_version' = $4
            OR payload_json->>'source_economics_provenance' = 'provisional_meta_ad_daily')`,
      [input.businessId, input.accountId, input.day,
        META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION],
    );
    return;
  }
  const knowledgeCutoffAt = new Date().toISOString();
  const adFacts = await getMetaAdDailyRange({
    businessId: input.businessId, providerAccountIds: [input.accountId],
    startDate: input.day, endDate: input.day,
  });
  const factsByAd = new Map(adFacts.map((row) => [row.adId, row]));
  const allFactsFinalized = rawRows.every((row) => {
    const fact = factsByAd.get(row.real_ad_id ?? row.id);
    return fact?.truthState === "finalized" && fact.validationStatus === "passed";
  });
  const provisionalPresentation = !allFactsFinalized && adFacts.length > 0 &&
    adFacts.every((fact) => fact.providerAccountId === input.accountId &&
      fact.date === input.day && fact.truthState === "provisional" &&
      fact.validationStatus === "pending" &&
      isCurrentProviderLocalDay(input.day, fact.accountTimezone));
  const provenCreativeByAdDay = allFactsFinalized
    ? await readProvableAdCreativeIdentityForDays({ businessId: input.businessId,
      providerAccountId: input.accountId, start: input.day, end: input.day,
      knowledgeCutoffAt })
    : new Map<string, string>();
  const identityProof = assessCreativeDayWriterIdentityProof({
    providerAccountId: input.accountId, day: input.day, rows: rawRows,
    adFacts, provenCreativeByAdDay,
    mode: provisionalPresentation ? "provisional_presentation" : "finalized",
  });
  if (!identityProof.canWrite) {
    console.warn("[meta-creatives] creative-day fact write deferred", {
      businessId: input.businessId,
      accountId: input.accountId,
      day: input.day,
      reason: identityProof.reason,
      adId: identityProof.adId,
    });
  }
  requireCreativeWarehouseCurrency(
    rawRows,
    input.accountId
  );
  if (!identityProof.canWrite) return;
  await hydrateCreativeLandingUrls(rawRows, input.accessToken);
  const creativeUsageMap = buildCreativeUsageMap(rawRows);
  const creativeRows = groupRows(rawRows, "creative", creativeUsageMap, {
    keyByProviderCreativeId: true,
  });
  assertMetaCanonicalClicksSource({ targetField: "clicks", sourceField: "clicks" });

  const creativeDailyRows: MetaCreativeDailyRow[] = creativeRows.map((row) => {
    const payloadRow = buildMetaCreativeApiRow({
      row,
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    });
    const canonical = buildCanonicalCreativeDayMetrics(row, factsByAd);
    const payloadJson = {
      ...payloadRow,
      spend: canonical.spend,
      impressions: canonical.impressions,
      clicks: canonical.clicks,
      reach: canonical.reach,
      purchases: canonical.conversions,
      purchase_value: canonical.revenue,
      roas: canonical.roas,
      cpa: canonical.cpa,
      ctr_all: canonical.ctr,
      cpc_link: canonical.cpc,
      cpm: canonical.impressions > 0
        ? canonical.spend / canonical.impressions * 1_000 : null,
      link_clicks: canonical.linkClicks,
      outbound_clicks: canonical.outboundClicks,
      landing_page_views: canonical.landingPageViews,
      add_to_cart: canonical.addToCart,
      initiate_checkout: canonical.initiateCheckout,
      frequency: canonical.frequency,
      metric_presence: { ...payloadRow.metric_presence, ...canonical.metricPresence },
      [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: canonical.evidence,
      source_membership_scope: provisionalPresentation
        ? "current_provider_ad_days_provisional" : "all_provider_ad_days",
      source_economics_provenance: provisionalPresentation
        ? "provisional_meta_ad_daily" : "finalized_meta_ad_daily",
      // Current Ad detail has no historical membership proof. Keep its source
      // list for display without minting the v2 decision-admission marker.
      ...(provisionalPresentation ? {
        source_identity_version: undefined,
        source_ad_ids_complete: false,
        source_parent_grain_complete: false,
      } : {}),
      source_snapshot_ids: canonical.sourceSnapshotIds,
      source_run_ids: canonical.sourceRunIds,
      // Mutable current Ad detail is useful for media, not a historical
      // objective/bid/budget observation on the report day.
      effective_status: null,
      objective: null,
      attribution_setting: null,
      bid_strategy: null,
      optimization_goal: null,
      campaign_daily_budget: null,
      adset_daily_budget: null,
      campaign_lifetime_budget: null,
      adset_lifetime_budget: null,
      custom_event_type: null,
      custom_conversion_id: null,
    };
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
      firstSpendAt: canonical.spend > 0 ? `${input.day}T00:00:00.000Z` : null,
      outboundClicks: canonical.outboundClicks,
      landingPageViews: canonical.landingPageViews,
      addToCart: canonical.addToCart,
      initiateCheckout: canonical.initiateCheckout,
      effectiveStatus: null,
      objective: null,
      attributionSetting: null,
      qualityRanking: row.quality_ranking ?? null,
      engagementRateRanking: row.engagement_rate_ranking ?? null,
      conversionRateRanking: row.conversion_rate_ranking ?? null,
      bidStrategy: null,
      optimizationGoal: null,
      campaignDailyBudget: null,
      adsetDailyBudget: null,
      campaignLifetimeBudget: null,
      adsetLifetimeBudget: null,
      creativeDeliveryType: row.creative_delivery_type ?? null,
      creativeVisualFormat: row.creative_visual_format ?? null,
      creativePrimaryType: row.creative_primary_type ?? null,
      creativeSecondaryType: row.creative_secondary_type ?? null,
      imageHash: row.image_hash ?? row.image_hashes?.[0] ?? null,
      accountTimezone: identityProof.accountTimezone,
      accountCurrency: identityProof.accountCurrency,
      spend: canonical.spend,
      impressions: canonical.impressions,
      clicks: canonical.clicks,
      reach: canonical.reach,
      frequency: canonical.frequency,
      conversions: canonical.conversions,
      revenue: canonical.revenue,
      roas: canonical.roas,
      cpa: canonical.cpa,
      ctr: canonical.ctr,
      cpc: canonical.cpc,
      linkClicks: canonical.linkClicks,
      sourceSnapshotId: null,
      sourceRunId: input.sourceRunId ?? null,
      metricSchemaVersion: META_CANONICAL_METRIC_SCHEMA_VERSION,
      payloadJson,
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
  // Media carries the same provider creative ID under the report date. When
  // historical identity is unproved, even a preview would assert the wrong
  // Ad↔creative relationship for that day. Preserve previous certified rows.
  await Promise.all([
    upsertMetaCreativeDailyRows(creativeDailyRows),
    upsertMetaCreativeMediaRows(creativeMediaRows),
  ]);
  // Membership and configuration are independent proofs. The writer above
  // leaves config unverified; this separate D098 receipt path may certify it
  // only after the v2 row exists and its stored fields agree with the receipt.
  if (!provisionalPresentation) await certifyCreativeDayConfigFromReceipts({
    businessId: input.businessId,
    providerAccountId: input.accountId,
    day: input.day,
    knowledgeCutoffAt: new Date().toISOString(),
  }).catch((error: unknown) => {
    console.warn("[meta-creatives] creative-day config proof failed", {
      businessId: input.businessId,
      accountId: input.accountId,
      day: input.day,
      reason: error instanceof Error ? error.message : String(error),
    });
    // A failed receipt read is not an ordinary missing receipt. Let the
    // partition retry instead of completing with a permanently unverified day.
    throw error;
  });
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

export function findCreativeDayMembershipGapDays(input: {
  adFacts: MetaAdDailyRow[];
  creativeFacts: MetaCreativeDailyRow[];
}): Set<string> {
  const memberships = new Map<string, number>();
  for (const row of input.creativeFacts) {
    const payload = row.payloadJson;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        (payload as Record<string, unknown>).source_identity_version !==
          META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION) continue;
    const identity = readCreativeSourceIdentity(payload);
    if (!identity?.source_ad_ids_complete) continue;
    for (const adId of identity.source_ad_ids) {
      const key = JSON.stringify([row.providerAccountId, row.date, adId]);
      memberships.set(key, (memberships.get(key) ?? 0) + 1);
    }
  }
  const gaps = new Set<string>();
  for (const fact of input.adFacts) {
    if (fact.truthState !== "finalized" || fact.validationStatus !== "passed" ||
        ![fact.spend, fact.impressions, fact.clicks, fact.conversions, fact.revenue]
          .some((value) => value > 0)) continue;
    const key = JSON.stringify([fact.providerAccountId, fact.date, fact.adId]);
    if (memberships.get(key) !== 1) gaps.add(fact.date);
  }
  return gaps;
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
  // Legacy completed_days says only that some creative row exists. For the
  // recent finalized window, require every spending Ad-day to be represented
  // exactly once by a v2 creative membership before honoring that shortcut.
  // Older history is repaired through the explicit source-backed manifest;
  // this utility never starts an unbounded historical refetch.
  const today = toIsoDate(new Date());
  const recentStart = toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -2));
  const recentEnd = toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -1));
  const boundedStart = input.startDate > recentStart ? input.startDate : recentStart;
  const boundedEnd = input.endDate < recentEnd ? input.endDate : recentEnd;
  const recentFinalizedDays = boundedStart <= boundedEnd
    ? enumerateDays(boundedStart, boundedEnd, true) : [];
  let recentMembershipGapDays = new Set<string>();
  if (recentFinalizedDays.length > 0) {
    const [adFacts, creativeFacts] = await Promise.all([
      getMetaAdDailyRange({ businessId: input.businessId,
        providerAccountIds: assignedAccountIds,
        startDate: boundedStart, endDate: boundedEnd }),
      getMetaCreativeDailyRange({ businessId: input.businessId,
        providerAccountIds: assignedAccountIds,
        startDate: boundedStart, endDate: boundedEnd }),
    ]);
    recentMembershipGapDays = findCreativeDayMembershipGapDays({ adFacts, creativeFacts });
  }
  if (
    (coverage?.completed_days ?? 0) >= totalDays &&
    recentMembershipGapDays.size === 0 &&
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
    if ((dayCoverage?.completed_days ?? 0) >= 1 &&
        !recentMembershipGapDays.has(day)) {
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
  /** Optional exact read cutoff for historical consumers of recovered identity. */
  knowledgeCutoffAt?: string;
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
  const knowledgeCutoffAt = input.knowledgeCutoffAt ?? new Date().toISOString();

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
  // Intraday Ad facts have not passed finalization or historical identity
  // proof. Their current provider creative mapping is presentation-only and
  // expires with the account-local day; explicit historical reads never use it.
  const presentableProvisional = (row: MetaCreativeDailyRow) =>
    !input.knowledgeCutoffAt && isPresentableProvisionalCreativeDay(row);
  const provisionalCreativeDays = useCreativeWarehouse
    ? (sourceRowsBeforeAdCreativeFilter as MetaCreativeDailyRow[]).filter(
        presentableProvisional,
      )
    : [];
  // Legacy creative-day writer rows can contain several provider creatives
  // under the first ID. Their spend and funnel are real measurements but not
  // proven measurements OF that ID, so they cannot be served as verified Studio
  // metrics. The repair can restore these rows with versioned source identity.
  const unverifiedCreativeDays = useCreativeWarehouse
    ? (sourceRowsBeforeAdCreativeFilter as MetaCreativeDailyRow[]).filter(
        (row) => !hasVerifiedCreativeDayIdentity(row) && !presentableProvisional(row),
      )
    : [];
  const provenAdCreativeIds =
    !useCreativeWarehouse && (creativeId ||
      (input.groupBy === "ad" && input.mediaMode === "full"))
      ? await readAdCreativeIdsForDays({
          businessId: input.businessId,
          providerAccountId: accountScope.providerAccountId,
          start: input.start,
          end: input.end,
          knowledgeCutoffAt,
        })
      : new Map<string, string>();
  // A filter for one creative cannot identify an unproved Ad-day by querying
  // only that creative: a proved member of another creative and an unproved Ad
  // would both disappear. Read all provable identities, then distinguish them.
  const unverifiedAdDays = !useCreativeWarehouse && creativeId
    ? (sourceRowsBeforeAdCreativeFilter as MetaAdDailyRow[]).filter((row) =>
        adDayKnownAtCutoff(row, knowledgeCutoffAt) &&
        [row.spend, row.impressions, row.clicks, row.conversions,
          row.revenue, row.linkClicks ?? 0].some((value) => value > 0) &&
        !provenAdCreativeIds.has(adDayIdentityKey(row, row.adId)),
      )
    : [];
  const sourceRows =
    !useCreativeWarehouse && creativeId
      ? (sourceRowsBeforeAdCreativeFilter as MetaAdDailyRow[]).filter(
          (row) =>
            adDayKnownAtCutoff(row, knowledgeCutoffAt) &&
            provenAdCreativeIds.get(adDayIdentityKey(row, row.adId)) === creativeId,
        )
      : useCreativeWarehouse
        ? (sourceRowsBeforeAdCreativeFilter as MetaCreativeDailyRow[]).filter(
            (row) => hasVerifiedCreativeDayIdentity(row) || presentableProvisional(row),
          )
        : sourceRowsBeforeAdCreativeFilter;
  const creativeSourceRowsForDimensions = useCreativeWarehouse
    ? (sourceRows as MetaCreativeDailyRow[])
    : null;
  const adSourceRowsForDimensions = useCreativeWarehouse
    ? null
    : (sourceRows as MetaAdDailyRow[]);
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
  const creativeSourceRows = useCreativeWarehouse
    ? (sourceRows as MetaCreativeDailyRow[])
    : null;
  const adSourceRows = useCreativeWarehouse ? null : (sourceRows as MetaAdDailyRow[]);
  const mediaByCreativeKey = new Map<string, MetaCreativeMediaRow>();
  const mediaByAdKey = new Map<string, MetaCreativeMediaRow>();
  const mediaByAdCreativeKey = new Map<string, MetaCreativeMediaRow>();
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
        const adCreativeKey = `${adKey}|${row.creativeId}`;
        mediaByAdCreativeKey.set(adCreativeKey,
          chooseRicherMediaRow(mediaByAdCreativeKey.get(adCreativeKey), row));
      }
    }
  }
  const rawRows: RawCreativeRow[] = sourceRows.reduce<RawCreativeRow[]>((acc, row) => {
      const factRow = row;
      const dimensionRow = useCreativeWarehouse
        ? dimensionRows.get((factRow as MetaCreativeDailyRow).creativeId)
        : dimensionRows.get((factRow as MetaAdDailyRow).adId);
      const strictAdPresentationIdentity = !useCreativeWarehouse &&
        input.groupBy === "ad" && input.mediaMode === "full";
      const provenCreativeId = !useCreativeWarehouse
        ? provenAdCreativeIds.get(adDayIdentityKey(
            factRow as MetaAdDailyRow, (factRow as MetaAdDailyRow).adId,
          )) ?? null
        : null;
      const dimensionProjection =
        input.knowledgeCutoffAt && !useCreativeWarehouse
          ? null : coerceRawCreativeRow(dimensionRow?.projectionJson);
      const projectionRow =
        (strictAdPresentationIdentity &&
          (!provenCreativeId || dimensionProjection?.creative_id !== provenCreativeId)
          ? null : dimensionProjection) ??
        (!useCreativeWarehouse
          ? buildFallbackAdRawRow({
              factRow: row as MetaAdDailyRow,
              projectionJson: strictAdPresentationIdentity || input.knowledgeCutoffAt
                ? null : dimensionRow?.projectionJson,
              creativeId:
                provenCreativeId ?? (strictAdPresentationIdentity
                  ? `${META_UNRESOLVED_CREATIVE_ID_PREFIX}${(row as MetaAdDailyRow).adId}`
                  : dimensionRow?.creativeId ?? null),
            })
          : null);
      if (!projectionRow) return acc;
      if (!useCreativeWarehouse && creativeId) {
        // Projection is a presentation snapshot. Its current creative_id may
        // disagree with a report day, so the point-in-time relation always wins.
        projectionRow.creative_id = creativeId;
      }
      const mediaRow = useCreativeWarehouse
        ? mediaByCreativeKey.get(
            `${(row as MetaCreativeDailyRow).providerAccountId}|${(row as MetaCreativeDailyRow).date}|${(row as MetaCreativeDailyRow).creativeId}`,
          ) ?? null
        : strictAdPresentationIdentity
          ? (provenCreativeId ? mediaByAdCreativeKey.get(
              `${(row as MetaAdDailyRow).providerAccountId}|${(row as MetaAdDailyRow).date}|${(row as MetaAdDailyRow).adId}|${provenCreativeId}`,
            ) ?? null : null)
          : mediaByAdKey.get(
              `${(row as MetaAdDailyRow).providerAccountId}|${(row as MetaAdDailyRow).date}|${(row as MetaAdDailyRow).adId}`,
            ) ?? null;
      const hydratedRow = hydrateWarehouseCreativeMetrics({
          row: overlayCreativeMedia(projectionRow, mediaRow),
          factRow,
        });
      const presentationRow = strictAdPresentationIdentity
        ? {
            ...hydratedRow,
            source_ad_ids: [(factRow as MetaAdDailyRow).adId],
            source_ad_ids_complete: Boolean(provenCreativeId),
            source_creative_ids: provenCreativeId ? [provenCreativeId] : [],
          }
        : hydratedRow;
      acc.push(
        input.groupBy === "ad" && !useCreativeWarehouse
          ? {
              ...presentationRow,
              name:
                (factRow as MetaAdDailyRow).adNameCurrent ??
                (factRow as MetaAdDailyRow).adNameHistorical ??
                presentationRow.name,
            }
          : presentationRow,
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
  const presentationRows = input.groupBy === "ad" && input.mediaMode === "full"
    ? groupedRows.map((row) => {
        const creativeIds = row.source_creative_ids ?? [row.creative_id];
        if (creativeIds.length === 1 &&
            !isMetaUnresolvedCreativeId(creativeIds[0])) return row;
        // Ad economics may span several verified creative identities (or an
        // unresolved day). A single thumbnail/copy would mislabel that window.
        return {
          ...row,
          creative_id: `${META_UNRESOLVED_CREATIVE_ID_PREFIX}${row.real_ad_id ?? row.id}`,
          unresolved_reason: "mixed_or_unverified_historical_creative_identity",
          copy_text: null,
          copy_variants: [],
          headline_variants: [],
          description_variants: [],
          object_story_id: null,
          effective_object_story_id: null,
          post_id: null,
          preview_url: null,
          preview_source: null,
          thumbnail_url: null,
          image_url: null,
          table_thumbnail_url: null,
          card_preview_url: null,
          preview_state: "unavailable" as const,
          preview: buildUnavailablePreview(Boolean(row.is_catalog)),
          image_hash: null,
          image_hashes: [],
        };
      })
    : groupedRows;
  const sortedRows = sortRows(presentationRows, input.sort);
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
    isPartial: unverifiedCreativeDays.length > 0 || unverifiedAdDays.length > 0 ||
      provisionalCreativeDays.length > 0,
    notReadyReason: unverifiedCreativeDays.length > 0
      ? `${unverifiedCreativeDays.length} historical creative-day rows have unverified provider membership; their metrics are withheld until source-backed repair.`
      : unverifiedAdDays.length > 0
        ? `${unverifiedAdDays.length} active Ad-day rows have unverified historical creative identity; their metrics cannot be attributed to the requested creative.`
      : provisionalCreativeDays.length > 0
        ? `${provisionalCreativeDays.length} current-day creative rows are provisional; their metrics are for presentation until the Ad day is finalized and its identity is proved.`
      : null,
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
