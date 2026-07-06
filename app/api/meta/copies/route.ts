import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import { getDemoMetaCopies } from "@/lib/demo-business";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { hasCopyContent } from "@/lib/meta/creatives-copy";

type CopyGroupBy = "copy" | "adName" | "campaign" | "adSet";
type CopySortKey = "roas" | "spend" | "ctrAll" | "purchaseValue";

export interface MetaCopyApiRow {
  id: string;
  ad_id: string;
  creative_id: string | null;
  post_id: string | null;
  name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  account_id: string | null;
  account_name: string | null;
  currency: string | null;
  launch_date: string | null;
  primary_text: string | null;
  headline: string | null;
  description: string | null;
  copy_text: string | null;
  copy_variants: string[];
  headline_variants: string[];
  description_variants: string[];
  normalized_copy_key: string | null;
  copy_source: string | null;
  copy_asset_type: "primary_text" | "headline" | "description" | "bundle" | null;
  copy_debug_sources?: string[];
  unresolved_reason?: string | null;
  preview_url: string | null;
  thumbnail_url: string | null;
  image_url: string | null;
  table_thumbnail_url: string | null;
  card_preview_url: string | null;
  is_catalog: boolean;
  preview_state: MetaCreativeApiRow["preview_state"];
  preview: MetaCreativeApiRow["preview"];
  spend: number;
  purchase_value: number;
  roas: number;
  cpa: number;
  cpc_link: number;
  cpm: number;
  ctr_all: number;
  purchases: number;
  impressions: number;
  link_clicks: number;
  add_to_cart: number;
  landing_page_views: number;
  initiate_checkout: number;
  leads: number;
  messages: number;
  video25: number;
  video50: number;
  video75: number;
  video100: number;
  click_to_purchase: number;
  thumbstop: number | null;
  first_frame_retention: number | null;
  aov: number | null;
  click_to_atc_ratio: number | null;
  atc_to_purchase_ratio: number | null;
}

interface MetaCopiesApiResponse {
  status: "ok";
  rows: MetaCopyApiRow[];
  meta: {
    group_by: CopyGroupBy;
    sort: CopySortKey;
    unresolved_filtered_count: number;
    source_rows_count: number;
    returned_rows_count: number;
    /** As-of stamp for this payload; the page renders it so cached
     * route-report data carries a visible age. */
    generatedAt: string;
    recoveryAttempted?: boolean;
    recoveryRecovered?: boolean;
    recoveryReason?: "copy_empty_source_rows" | "persisted_snapshot_empty" | null;
    unresolved_debug?: Array<{
      id: string;
      ad_id: string;
      name: string | null;
      creative_id: string | null;
      object_story_id: string | null;
      effective_object_story_id: string | null;
      copy_source: string | null;
      unresolved_reason: string | null;
      attempted_sources: string[];
      story_lookup_attempted: boolean;
      story_lookup_succeeded: boolean;
      preview_html_attempted: boolean;
      preview_html_succeeded: boolean;
    }>;
  };
}

type CreativePayload = {
  status?: string;
  rows?: MetaCreativeApiRow[];
  message?: string;
  snapshot_source?: string;
};

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return null;
  return normalized;
}

function normalizeKey(value: string | null): string | null {
  if (!value) return null;
  return value
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function uniqueText(values: Array<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function mapCreativeRowToCopyRow(row: MetaCreativeApiRow): MetaCopyApiRow {
  const copyVariants = uniqueText(row.copy_variants ?? []);
  const headlineVariants = uniqueText(row.headline_variants ?? []);
  const descriptionVariants = uniqueText(row.description_variants ?? []);

  const primaryText = copyVariants[0] ?? null;
  const headline = headlineVariants[0] ?? null;
  const description = descriptionVariants[0] ?? null;
  const copyText = normalizeText(row.copy_text) ?? primaryText ?? headline ?? description ?? null;
  const normalizedCopyKey = normalizeKey(copyText);
  const purchases = Number(row.purchases ?? 0);
  const spend = Number(row.spend ?? 0);
  const purchaseValue = Number(row.purchase_value ?? 0);
  const linkClicks = Number(row.link_clicks ?? 0);
  const addToCart = Number(row.add_to_cart ?? 0);
  const impressions = Number(row.impressions ?? 0);

  const copyAssetType: MetaCopyApiRow["copy_asset_type"] =
    copyVariants.length > 0 && (headlineVariants.length > 0 || descriptionVariants.length > 0)
      ? "bundle"
      : copyVariants.length > 0
      ? "primary_text"
      : headlineVariants.length > 0
      ? "headline"
      : descriptionVariants.length > 0
      ? "description"
      : null;

  return {
    id: row.id,
    ad_id: row.id,
    creative_id: row.creative_id ?? null,
    post_id: row.post_id ?? null,
    name: row.name ?? null,
    campaign_id: row.campaign_id ?? null,
    campaign_name: row.campaign_name ?? null,
    adset_id: row.adset_id ?? null,
    adset_name: row.adset_name ?? null,
    account_id: row.account_id ?? null,
    account_name: row.account_name ?? null,
    currency: row.currency ?? null,
    launch_date: row.launch_date ?? null,
    primary_text: primaryText,
    headline,
    description,
    copy_text: copyText,
    copy_variants: copyVariants,
    headline_variants: headlineVariants,
    description_variants: descriptionVariants,
    normalized_copy_key: normalizedCopyKey,
    copy_source: row.copy_source ?? null,
    copy_asset_type: copyAssetType,
    copy_debug_sources: row.copy_debug_sources ?? (row.copy_source ? [row.copy_source] : []),
    unresolved_reason: row.unresolved_reason ?? null,
    preview_url: row.preview_url ?? null,
    thumbnail_url: row.thumbnail_url ?? null,
    image_url: row.image_url ?? null,
    table_thumbnail_url: row.table_thumbnail_url ?? null,
    card_preview_url: row.card_preview_url ?? null,
    is_catalog: Boolean(row.is_catalog),
    preview_state: row.preview_state,
    preview: row.preview,
    spend,
    purchase_value: purchaseValue,
    roas: Number(row.roas ?? 0),
    cpa: Number(row.cpa ?? 0),
    cpc_link: Number(row.cpc_link ?? 0),
    cpm: Number(row.cpm ?? 0),
    ctr_all: Number(row.ctr_all ?? 0),
    purchases,
    impressions,
    link_clicks: linkClicks,
    add_to_cart: addToCart,
    landing_page_views: Number(row.landing_page_views ?? 0),
    initiate_checkout: Number(row.initiate_checkout ?? 0),
    leads: Number(row.leads ?? 0),
    messages: Number(row.messages ?? 0),
    video25: Number(row.video25 ?? 0),
    video50: Number(row.video50 ?? 0),
    video75: Number(row.video75 ?? 0),
    video100: Number(row.video100 ?? 0),
    click_to_purchase: linkClicks > 0 ? (purchases / linkClicks) * 100 : 0,
    thumbstop: Number(row.thumbstop ?? 0),
    first_frame_retention: Number(row.thumbstop ?? 0),
    aov: purchases > 0 ? purchaseValue / purchases : null,
    click_to_atc_ratio: linkClicks > 0 ? (addToCart / linkClicks) * 100 : null,
    atc_to_purchase_ratio: addToCart > 0 ? (purchases / addToCart) * 100 : null,
  };
}

function isCopyEligible(row: MetaCopyApiRow): boolean {
  return hasCopyContent(row);
}

function aggregateRows(rows: MetaCopyApiRow[], groupBy: CopyGroupBy): MetaCopyApiRow[] {
  if (groupBy === "adName") return rows;

  const groups = new Map<string, MetaCopyApiRow[]>();
  for (const row of rows) {
    const key =
      groupBy === "copy"
        ? row.normalized_copy_key ?? `unresolved:${row.id}`
        : groupBy === "campaign"
        ? row.campaign_id ?? row.campaign_name ?? `campaign:${row.id}`
        : row.adset_id ?? row.adset_name ?? `adset:${row.id}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const aggregated: MetaCopyApiRow[] = [];
  for (const [key, bucket] of groups.entries()) {
    const sample = bucket[0];
    const spend = bucket.reduce((sum, row) => sum + row.spend, 0);
    const purchaseValue = bucket.reduce((sum, row) => sum + row.purchase_value, 0);
    const purchases = bucket.reduce((sum, row) => sum + row.purchases, 0);
    const impressions = bucket.reduce((sum, row) => sum + row.impressions, 0);
    const linkClicks = bucket.reduce((sum, row) => sum + row.link_clicks, 0);
    const addToCart = bucket.reduce((sum, row) => sum + row.add_to_cart, 0);
    const landingPageViews = bucket.reduce((sum, row) => sum + row.landing_page_views, 0);
    const initiateCheckout = bucket.reduce((sum, row) => sum + row.initiate_checkout, 0);
    const leads = bucket.reduce((sum, row) => sum + row.leads, 0);
    const messages = bucket.reduce((sum, row) => sum + row.messages, 0);
    const video25 = bucket.reduce((sum, row) => sum + row.video25, 0);
    const video50 = bucket.reduce((sum, row) => sum + row.video50, 0);
    const video75 = bucket.reduce((sum, row) => sum + row.video75, 0);
    const video100 = bucket.reduce((sum, row) => sum + row.video100, 0);

    const copyVariants = uniqueText(bucket.flatMap((row) => row.copy_variants));
    const headlineVariants = uniqueText(bucket.flatMap((row) => row.headline_variants));
    const descriptionVariants = uniqueText(bucket.flatMap((row) => row.description_variants));
    const primaryText = copyVariants[0] ?? null;
    const headline = headlineVariants[0] ?? null;
    const description = descriptionVariants[0] ?? null;
    const copyText = primaryText ?? headline ?? description ?? null;
    const normalizedCopyKey = normalizeKey(copyText);
    const source = bucket.find((row) => row.copy_source)?.copy_source ?? null;

    aggregated.push({
      ...sample,
      id: `${groupBy}_${key}`,
      ad_id: sample.ad_id,
      primary_text: primaryText,
      headline,
      description,
      copy_text: copyText,
      copy_variants: copyVariants,
      headline_variants: headlineVariants,
      description_variants: descriptionVariants,
      normalized_copy_key: normalizedCopyKey,
      copy_source: source,
      spend,
      purchase_value: purchaseValue,
      purchases,
      impressions,
      link_clicks: linkClicks,
      add_to_cart: addToCart,
      landing_page_views: landingPageViews,
      initiate_checkout: initiateCheckout,
      leads,
      messages,
      video25,
      video50,
      video75,
      video100,
      roas: spend > 0 ? purchaseValue / spend : 0,
      cpa: purchases > 0 ? spend / purchases : 0,
      cpc_link: linkClicks > 0 ? spend / linkClicks : 0,
      cpm: impressions > 0 ? (spend * 1000) / impressions : 0,
      ctr_all: impressions > 0 ? (linkClicks / impressions) * 100 : 0,
      click_to_purchase: linkClicks > 0 ? (purchases / linkClicks) * 100 : 0,
      // Rate metrics reconstruct as impression-weighted means: thumbstop is
      // plays/impressions per row, so the bucket rate is the delivery-weighted
      // average, not a plain mean over rows. Undefined without delivery.
      thumbstop: impressions > 0
        ? bucket.reduce(
            (sum, row) => sum + (row.thumbstop ?? 0) * row.impressions,
            0,
          ) / impressions
        : null,
      first_frame_retention: impressions > 0
        ? bucket.reduce(
            (sum, row) => sum + (row.first_frame_retention ?? 0) * row.impressions,
            0,
          ) / impressions
        : null,
      aov: purchases > 0 ? purchaseValue / purchases : null,
      click_to_atc_ratio: linkClicks > 0 ? (addToCart / linkClicks) * 100 : null,
      atc_to_purchase_ratio: addToCart > 0 ? (purchases / addToCart) * 100 : null,
    });
  }

  return aggregated;
}

function sortRows(rows: MetaCopyApiRow[], sort: CopySortKey): MetaCopyApiRow[] {
  const valueOf = (row: MetaCopyApiRow) => {
    if (sort === "roas") return row.roas;
    if (sort === "ctrAll") return row.ctr_all;
    if (sort === "purchaseValue") return row.purchase_value;
    return row.spend;
  };
  return [...rows].sort((a, b) => valueOf(b) - valueOf(a));
}

async function fetchCopiesCreativePayload(input: {
  request: NextRequest;
  businessId: string;
  start: string;
  end: string;
  format: "all" | "image" | "video";
  snapshotBypass: boolean;
  enableCreativeDetails: boolean;
  enableCreativeBasicsFallback: boolean;
}): Promise<CreativePayload | null> {
  return (await getMetaCreativesApiPayload({
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    mediaMode: "metadata",
    groupBy: "adName",
    format: input.format,
    sort: "spend",
    start: input.start,
    end: input.end,
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: input.snapshotBypass,
    snapshotWarm: false,
    enableCopyRecovery: true,
    enableCreativeBasicsFallback: input.enableCreativeBasicsFallback,
    enableCreativeDetails: input.enableCreativeDetails,
    enableThumbnailBackfill: false,
    enableCardThumbnailBackfill: false,
    enableImageHashLookup: false,
    enableMediaRecovery: false,
    enableMediaCache: false,
    enableDeepAudit: false,
    perAccountSampleLimit: 5,
  })) as CreativePayload | null;
}

function shouldAttemptCopiesRecovery(input: {
  payload: CreativePayload | null;
  sourceRows: MetaCreativeApiRow[];
  eligibleRows: MetaCopyApiRow[];
}) {
  if (input.payload?.status !== "ok") return null;
  if (input.sourceRows.length > 0 && input.eligibleRows.length === 0) {
    return "copy_empty_source_rows" as const;
  }
  if ((input.payload?.snapshot_source ?? null) === "persisted" && input.sourceRows.length === 0) {
    return "persisted_snapshot_empty" as const;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId")?.trim() ?? "";
  const start = params.get("start")?.trim() ?? "";
  const end = params.get("end")?.trim() ?? "";
  const groupByParam = (params.get("groupBy")?.trim() ?? "copy") as CopyGroupBy;
  const sortParam = (params.get("sort")?.trim() ?? "spend") as CopySortKey;
  const format = params.get("format")?.trim() ?? "all";
  const groupBy: CopyGroupBy = ["copy", "adName", "campaign", "adSet"].includes(groupByParam)
    ? groupByParam
    : "copy";
  const sort: CopySortKey = ["roas", "spend", "ctrAll", "purchaseValue"].includes(sortParam)
    ? sortParam
    : "spend";
  const debug = params.get("debug") === "1";

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 }
    );
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;
  if (await isDemoBusiness(businessId)) {
    return NextResponse.json(getDemoMetaCopies());
  }

  const formatFilter = (format as "all" | "image" | "video") || "all";
  const initialCreativePayload = await fetchCopiesCreativePayload({
    request,
    businessId,
    start,
    end,
    format: formatFilter,
    snapshotBypass: false,
    enableCreativeDetails: false,
    enableCreativeBasicsFallback: false,
  });

  const initialSourceRows = Array.isArray(initialCreativePayload?.rows) ? initialCreativePayload.rows : [];
  const initialMapped = initialSourceRows.map(mapCreativeRowToCopyRow);
  const initialEligible = initialMapped.filter(isCopyEligible);
  const recoveryReason = shouldAttemptCopiesRecovery({
    payload: initialCreativePayload,
    sourceRows: initialSourceRows,
    eligibleRows: initialEligible,
  });

  let recoveryAttempted = false;
  let recoveryRecovered = false;
  let creativePayload = initialCreativePayload;
  if (recoveryReason) {
    recoveryAttempted = true;
    const recoveredPayload = await fetchCopiesCreativePayload({
      request,
      businessId,
      start,
      end,
      format: formatFilter,
      snapshotBypass: true,
      enableCreativeDetails: true,
      enableCreativeBasicsFallback: true,
    });
    if (recoveredPayload?.status === "ok") {
      creativePayload = recoveredPayload;
      const recoveredRows = Array.isArray(recoveredPayload.rows) ? recoveredPayload.rows : [];
      const recoveredEligible = recoveredRows
        .map(mapCreativeRowToCopyRow)
        .filter(isCopyEligible);
      recoveryRecovered = recoveredEligible.length > 0;
    }
  }

  const sourceRows = Array.isArray(creativePayload?.rows) ? creativePayload.rows : [];
  const mapped = sourceRows.map(mapCreativeRowToCopyRow);
  const sourceRowById = new Map(sourceRows.map((row) => [row.id, row]));
  const eligible = mapped.filter(isCopyEligible);
  const unresolvedFilteredCount = mapped.length - eligible.length;
  const grouped = aggregateRows(eligible, groupBy).filter(isCopyEligible);
  const sorted = sortRows(grouped, sort);
  const unresolvedDebug = debug
    ? mapped
        .filter((row) => !isCopyEligible(row))
        .slice(0, 50)
        .map((row) => {
          const sources = row.copy_debug_sources ?? [];
          const sourceRow = sourceRowById.get(row.id);
          const attemptedSources = Array.from(
            new Set([
              "direct_creative_extraction",
              ...sources,
              sourceRow?.object_story_id || sourceRow?.effective_object_story_id || row.post_id ? "story_lookup" : "",
              "preview_html_fallback",
            ].filter(Boolean))
          );
          return {
            id: row.id,
            ad_id: row.ad_id,
            name: row.name,
            creative_id: row.creative_id,
            object_story_id: sourceRow?.object_story_id ?? null,
            effective_object_story_id: sourceRow?.effective_object_story_id ?? null,
            copy_source: row.copy_source,
            unresolved_reason: row.unresolved_reason ?? "no_recoverable_copy_after_all_stages",
            attempted_sources: attemptedSources,
            story_lookup_attempted: Boolean(
              sourceRow?.object_story_id ||
                sourceRow?.effective_object_story_id ||
                sourceRow?.post_id
            ),
            story_lookup_succeeded: row.copy_source === "story_lookup",
            preview_html_attempted: true,
            preview_html_succeeded: row.copy_source === "preview_html",
          };
        })
    : undefined;

  const response: MetaCopiesApiResponse = {
    status: "ok",
    rows: sorted,
    meta: {
      group_by: groupBy,
      sort,
      unresolved_filtered_count: unresolvedFilteredCount,
      source_rows_count: sourceRows.length,
      returned_rows_count: sorted.length,
      generatedAt: new Date().toISOString(),
      recoveryAttempted,
      recoveryRecovered,
      recoveryReason,
      unresolved_debug: unresolvedDebug,
    },
  };

  return NextResponse.json(response);
}
