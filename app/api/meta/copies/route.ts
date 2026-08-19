import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import { getDemoMetaCopies, getDemoProviderAccounts } from "@/lib/demo-business";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import type { MetaAiTags } from "@/lib/meta/creatives-types";
import { hasCopyContent } from "@/lib/meta/creatives-copy";
import {
  buildMetaCreativesAccountScopeMetadata,
  resolveMetaCreativesAccountScope,
} from "@/lib/meta/creatives-warehouse";

type CopyGroupBy = "copy" | "adName" | "campaign" | "adSet";
type CopySortKey = "roas" | "spend" | "ctrAll" | "purchaseValue";

export interface MetaCopyApiRow {
  id: string;
  ad_id: string;
  /**
   * How many DISTINCT ads this served line was aggregated from.
   *
   * `groupBy=copy` merges every ad carrying one copy into a single row, and the
   * merged row keeps only the sample ad's `id`, `ad_id` and `name` — the other
   * nine ads' identities are gone by the time the response leaves. The page used
   * to re-derive the count client-side from the rows it received, which after
   * that merge is exactly one row per copy, so a copy running on ten ads
   * rendered "Ads = 1". The count therefore has to be taken where the bucket
   * still exists: here.
   *
   * Counted by distinct `ad_id`, never by ad name. Two different ads may carry
   * the same name, and counting names would silently merge them into one.
   *
   * `null` when no row in the bucket carried an ad id at all — an uncountable
   * set is unknown, not 1, and the surface renders an em dash for it.
   *
   * This is NOT `MetaCreativeApiRow.associated_ads_count`, which counts the ads
   * sharing a CREATIVE. One copy can span many creatives and one creative can
   * carry many copies, so passing that field through would answer a different
   * question.
   */
  associated_ads_count: number | null;
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
  /**
   * The engine's own tags for the creative behind this line.
   *
   * `resolveAiTagsForRow` (lib/meta/creatives-copy.ts) already computes
   * `messagingAngle` and the Assets tab renders it; this route used to build its
   * row literal without it, so the Copies tab's Angle column and angle roll-up
   * showed an em dash for data that existed. Passed through, never inferred
   * here.
   */
  ai_tags: MetaAiTags;
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

/**
 * A copies read that did not succeed.
 *
 * `MetaCopiesApiResponse` used to be the only shape this route could emit, with
 * `status` pinned to the literal `"ok"`, so an unreadable Meta integration was
 * erased into `rows: []` and HTTP 200. The surface then printed "No copy
 * performance is available for this account and date range." — a definite claim
 * about the account, manufactured from a read that failed. A failure now leaves
 * with its own status, its own message and a non-2xx code, which is what the
 * page's existing error arm reads.
 */
interface MetaCopiesFailureResponse {
  status: string;
  message: string;
  rows: never[];
}

interface MetaCopiesApiResponse {
  /**
   * `"partial"` when the upstream creatives read completed only in part — the
   * rows below are real but incomplete, and must not be read as the whole
   * window.
   */
  status: "ok" | "partial";
  rows: MetaCopyApiRow[];
  meta: {
    group_by: CopyGroupBy;
    sort: CopySortKey;
    unresolved_filtered_count: number;
    source_rows_count: number;
    returned_rows_count: number;
    provider_account_id: string;
    /** As-of stamp for this payload; the page renders it so cached
     * route-report data carries a visible age. */
    generatedAt: string;
    /**
     * When the warehouse rows behind this response were last written. Null when
     * it could not be read — an unknown age, never a fresh one. The page reads
     * exactly this field for its as-of, so omitting it (as the real-business
     * branch did while only the demo branch set it) makes every real account
     * report "age unknown".
     *
     * NOT automatically the age of the rows below. See `rowsObservedAt`.
     */
    warehouseObservedAt: string | null;
    /**
     * Which read produced the rows, in the upstream's own words:
     * `warehouse`, `live_fallback` or `current_day_live`.
     *
     * Published because the two clocks below only make sense against it, and
     * because a surface that cannot tell a warehouse read from a live one
     * cannot tell a stale table from a fresh one.
     */
    readSource: string | null;
    /**
     * The instant that actually describes the rows on screen, and nothing else.
     *
     * THIS IS THE FIX. `warehouseObservedAt` is `MAX(updated_at)` over
     * `meta_ad_daily` for the window — a fact about what a sync last WROTE. When
     * `/api/meta/creatives` serves current-day or fallback LIVE rows it does not
     * read that table at all, so the two describe different data: the operator
     * saw a warehouse write time stamped over rows fetched live from Meta
     * seconds earlier, and a table that had in fact just been refreshed could
     * read "synced 1d ago" (or the reverse, which is worse).
     *
     * For a warehouse read this is the warehouse clock. For a live read it is
     * `null`: a live read has no write behind it, and the only other candidate
     * is the request time, which is fresh by construction and is exactly what
     * `lib/tier-zero-as-of.ts` exists to keep off a freshness bar. Age unknown
     * is the honest answer.
     */
    rowsObservedAt: string | null;
    /**
     * Which clock `rowsObservedAt` came from: `warehouse`, `live` (no write
     * instant exists) or `unknown` (the upstream did not say what it read).
     * Carried so the surface states which clock it is showing instead of
     * leaving the reader to assume.
     */
    rowsObservedAtSource: "warehouse" | "live" | "unknown";
    /** True when the upstream read was incomplete for this window. */
    isPartial?: boolean;
    /** Why the read is incomplete, in the upstream's own words. */
    notReadyReason?: string | null;
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
  /**
   * The upstream read completed only in part (currently: the current-day live
   * read). Without these two fields on the local view of the payload, a partial
   * upstream was indistinguishable from a complete one and this route relabelled
   * it "ok".
   */
  isPartial?: boolean;
  notReadyReason?: string | null;
  /**
   * Which read `/api/meta/creatives` performed: `warehouse`, `live_fallback` or
   * `current_day_live`. Without it on the local view of the payload the two
   * were indistinguishable here, and this route stamped a warehouse write time
   * over live rows.
   */
  readSource?: string | null;
  /**
   * The upstream's own warehouse instant. `null` on every live path, by that
   * route's own contract ("a live read has no warehouse write behind it").
   */
  warehouse_observed_at?: string | null;
};

/**
 * Which clock describes the rows the upstream actually served.
 *
 * Pure and exported so the mapping can be asserted directly rather than
 * inferred from a rendered string. The `warehouse` arm is the ONLY one allowed
 * to hand back the `meta_ad_daily` instant; every live arm returns null,
 * because there is no write behind a live read and the request time is not an
 * observation.
 */
export function resolveCopiesRowsObservedAt(input: {
  readSource: string | null | undefined;
  warehouseObservedAt: string | null;
}): { rowsObservedAt: string | null; rowsObservedAtSource: "warehouse" | "live" | "unknown" } {
  if (input.readSource === "warehouse") {
    return { rowsObservedAt: input.warehouseObservedAt, rowsObservedAtSource: "warehouse" };
  }
  if (input.readSource === "live_fallback" || input.readSource === "current_day_live") {
    return { rowsObservedAt: null, rowsObservedAtSource: "live" };
  }
  return { rowsObservedAt: null, rowsObservedAtSource: "unknown" };
}

/**
 * Upstream statuses that mean the read actually happened.
 *
 * `no_data` is a completed read that found nothing — `buildCreativesResponse`
 * emits it when the live path returns zero rows — and it is the one case where
 * "No copy performance is available for this account and date range." is a true
 * statement about the account. Every other non-ok status is a gate
 * (`no_connection`, `no_access_token`, `no_accounts_assigned`) or a failure, and
 * none of them establish anything about the account's copy.
 */
const SUCCESSFUL_UPSTREAM_STATUSES = new Set(["ok", "no_data"]);

/**
 * Messages for upstream statuses that carry no message of their own.
 *
 * Each says what did not happen, so the surface never converts a gate or a
 * failure into a statement about the account's copy.
 */
const UPSTREAM_FAILURE_MESSAGES: Record<string, string> = {
  no_connection:
    "Meta is not connected for this business, so copy performance could not be read.",
  no_access_token:
    "The stored Meta connection has no usable access token, so copy performance could not be read.",
  no_accounts_assigned:
    "No Meta ad account is assigned to this business, so copy performance could not be read.",
  provider_account_required:
    "A Meta ad account must be selected before copy performance can be read.",
  account_not_assigned: "That Meta ad account is not assigned to this business.",
};

function upstreamFailureMessage(payload: CreativePayload | null): string {
  const status = payload?.status ?? "";
  return (
    payload?.message?.trim() ||
    UPSTREAM_FAILURE_MESSAGES[status] ||
    "Copy performance could not be read from Meta."
  );
}

function upstreamFailureHttpStatus(status: string): number {
  if (status === "account_not_assigned") return 403;
  if (status === "provider_account_required") return 400;
  // The business is not in a state where this can be read (not connected, no
  // token, no assigned account): a conflict with the requested read, not a
  // successful empty one.
  if (
    status === "no_connection" ||
    status === "no_access_token" ||
    status === "no_accounts_assigned"
  ) {
    return 409;
  }
  return 502;
}

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

/**
 * A number the source actually supplied, or null.
 *
 * `Number(x ?? 0)` turns an unsupplied rate into a measured 0.00%, which no
 * surface can tell apart from a real zero — the fabricated zero the honesty law
 * forbids. Absence and NaN both travel as null.
 */
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * The first non-empty messaging angle the engine tagged, or null.
 *
 * Reading order only — nothing is inferred here.
 */
function primaryMessagingAngle(tags: MetaAiTags | null | undefined): string | null {
  const angles = tags?.messagingAngle;
  if (!Array.isArray(angles)) return null;
  for (const candidate of angles) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
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
    // Null, not 1. A row that has not been through `aggregateRows` has not been
    // counted against its bucket yet, and the literal 1 written here is exactly
    // what the surface used to print for a copy running on ten ads. Only the
    // step that can see the whole bucket may publish this number.
    associated_ads_count: null,
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
    // Straight pass-through of the engine's tags. The angle the Assets tab
    // already shows for this same creative is carried here rather than
    // recomputed, so the two tabs cannot disagree, and an untagged row keeps an
    // empty map so the surface renders an em dash instead of a guess.
    ai_tags: row.ai_tags ?? {},
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
    // An unmeasured thumbstop is unknown, not 0.00%. The field is already
    // `number | null` on the wire; the mapper was the last place still
    // substituting a zero for it.
    thumbstop: nullableNumber(row.thumbstop),
    first_frame_retention: nullableNumber(row.thumbstop),
    aov: purchases > 0 ? purchaseValue / purchases : null,
    click_to_atc_ratio: linkClicks > 0 ? (addToCart / linkClicks) * 100 : null,
    atc_to_purchase_ratio: addToCart > 0 ? (purchases / addToCart) * 100 : null,
  };
}

function isCopyEligible(row: MetaCopyApiRow): boolean {
  return hasCopyContent(row);
}

/**
 * Delivery-weighted mean of a per-row rate across a merged bucket.
 *
 * Rows whose rate was never measured are excluded from both the numerator and
 * the denominator instead of being counted as zero: a substituted zero drags
 * the bucket's rate toward a number no ad produced. Null when no row in the
 * bucket carries both a measurement and delivery — an unknown rate, not 0.
 */
function impressionWeightedRate(
  bucket: MetaCopyApiRow[],
  read: (row: MetaCopyApiRow) => number | null,
): number | null {
  let weighted = 0;
  let weight = 0;
  for (const row of bucket) {
    const rate = read(row);
    if (rate === null || !(row.impressions > 0)) continue;
    weighted += rate * row.impressions;
    weight += row.impressions;
  }
  return weight > 0 ? weighted / weight : null;
}

/**
 * Tags an aggregate row may honestly claim.
 *
 * A single-row bucket is that row, so it keeps its tags whole. A merged bucket
 * may span creatives the engine tagged differently, and asserting one member's
 * tags for the group would attribute an angle to lines that were never tagged
 * with it — so only an angle every member agrees on survives, and a bucket that
 * disagrees (or contains an untagged member) reports no angle at all.
 */
function aggregateAiTags(bucket: MetaCopyApiRow[], sample: MetaCopyApiRow): MetaAiTags {
  if (bucket.length === 1) return sample.ai_tags ?? {};
  const angles = new Set(bucket.map((row) => primaryMessagingAngle(row.ai_tags)));
  const agreed = angles.size === 1 ? [...angles][0] : null;
  return agreed ? { messagingAngle: [agreed] } : {};
}

/**
 * The identity rows are merged under.
 *
 * Named and exported to the demo branch below so the un-merged demo payload
 * counts its ads under exactly the identity the real branch merges under —
 * two spellings of "same copy" would put two different numbers in the same
 * column.
 */
type CopyGroupKeyFields = Pick<
  MetaCopyApiRow,
  | "id"
  | "account_id"
  | "currency"
  | "normalized_copy_key"
  | "campaign_id"
  | "campaign_name"
  | "adset_id"
  | "adset_name"
>;

function copyGroupKey(row: CopyGroupKeyFields, groupBy: CopyGroupBy): string {
  const groupIdentity =
    groupBy === "copy"
      ? row.normalized_copy_key ?? `unresolved:${row.id}`
      : groupBy === "campaign"
      ? row.campaign_id ?? row.campaign_name ?? `campaign:${row.id}`
      : groupBy === "adSet"
      ? row.adset_id ?? row.adset_name ?? `adset:${row.id}`
      : // `adName` merges nothing: every ad is its own bucket, keyed by the ad
        // itself and never by its name, because distinct ads share names.
        `ad:${row.id}`;
  return `${row.account_id ?? "account-missing"}:${row.currency ?? "currency-missing"}:${groupIdentity}`;
}

/**
 * The ads behind a bucket, counted by identity.
 *
 * `Set` over `ad_id` is the whole point: ad NAMES repeat across accounts,
 * campaigns and duplicated ads, so counting names would merge two real ads into
 * one and under-report the copy's reach. A bucket in which no row carries an ad
 * id returns null — that set could not be counted, and 1 would be a guess.
 */
function countDistinctAdIds(bucket: readonly { ad_id?: unknown }[]): number | null {
  const adIds = new Set<string>();
  for (const row of bucket) {
    const adId = typeof row.ad_id === "string" ? row.ad_id.trim() : "";
    if (adId) adIds.add(adId);
  }
  return adIds.size > 0 ? adIds.size : null;
}

/**
 * Stamps the count onto rows that were NOT merged.
 *
 * The demo branch serves one row per ad and ignores `groupBy`, so several of
 * its rows can carry one copy. The column has to mean the same thing on both
 * branches — how many distinct ads carry this line — so the count is taken over
 * the same `copyGroupKey` bucket and written onto every member of it, rather
 * than each demo row reporting the single ad it happens to be.
 */
function withAssociatedAdCounts<Row extends CopyGroupKeyFields & { ad_id: string }>(
  rows: readonly Row[],
  groupBy: CopyGroupBy,
): Array<Row & { associated_ads_count: number | null }> {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const key = copyGroupKey(row, groupBy);
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  return rows.map((row) => ({
    ...row,
    associated_ads_count: countDistinctAdIds(buckets.get(copyGroupKey(row, groupBy)) ?? []),
  }));
}

function aggregateRows(rows: MetaCopyApiRow[], groupBy: CopyGroupBy): MetaCopyApiRow[] {
  if (groupBy === "adName") {
    // One ad per row, so the count is that one ad — established the same way,
    // from its own id, so a row with no ad id still reports "unknown".
    return rows.map((row) => ({
      ...row,
      associated_ads_count: countDistinctAdIds([row]),
    }));
  }

  const groups = new Map<string, MetaCopyApiRow[]>();
  for (const row of rows) {
    const key = copyGroupKey(row, groupBy);
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
      // The one field that survives the merge with the whole bucket's answer in
      // it. `sample.ad_id` above is a single ad; this says how many there were.
      associated_ads_count: countDistinctAdIds(bucket),
      primary_text: primaryText,
      headline,
      description,
      copy_text: copyText,
      copy_variants: copyVariants,
      headline_variants: headlineVariants,
      description_variants: descriptionVariants,
      normalized_copy_key: normalizedCopyKey,
      copy_source: source,
      ai_tags: aggregateAiTags(bucket, sample),
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
      // average, not a plain mean over rows. Undefined without delivery, and a
      // row whose thumbstop was never measured is left out of the average
      // rather than counted as a 0% row.
      thumbstop: impressionWeightedRate(bucket, (row) => row.thumbstop),
      first_frame_retention: impressionWeightedRate(
        bucket,
        (row) => row.first_frame_retention,
      ),
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
  providerAccountId: string;
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
    providerAccountId: input.providerAccountId,
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


/**
 * When the warehouse rows behind this response were last written.
 *
 * The copies surface reads decision facts that a sync writes; how old they are
 * is a property of that write, not of this request. `meta.generatedAt` records
 * when the route ran, which is fresh by construction and would report the age
 * of the request as the age of the data -- the substitution the freshness
 * contract exists to remove.
 *
 * Returns null rather than a guess when nothing matched, so the surface says
 * the age is unknown instead of implying currency it cannot support.
 */
async function readCopiesWarehouseObservedAt(input: {
  businessId: string;
  providerAccountId: string;
  start: string;
  end: string;
}): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = await sql.query<{ observed_at: Date | string | null }>(
      `SELECT MAX(updated_at) AS observed_at
         FROM meta_ad_daily
        WHERE business_id = $1
          AND provider_account_id = $2
          AND date BETWEEN $3::date AND $4::date`,
      [input.businessId, input.providerAccountId, input.start, input.end],
    );
    const observedAt = rows[0]?.observed_at ?? null;
    if (!observedAt) return null;
    return observedAt instanceof Date
      ? observedAt.toISOString()
      : new Date(observedAt).toISOString();
  } catch {
    // An unreadable timestamp is an unknown age, never a fresh one.
    return null;
  }
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId")?.trim() ?? "";
  const providerAccountId = params.get("providerAccountId")?.trim() ?? "";
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
  if (!providerAccountId) {
    return NextResponse.json(
      {
        error: "missing_provider_account_id",
        message: "providerAccountId is required for Meta copy analysis.",
      },
      { status: 400 },
    );
  }
  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;
  if (await isDemoBusiness(businessId)) {
    const accountScope = resolveMetaCreativesAccountScope({
      assignedAccountIds: getDemoProviderAccounts("meta").map((account) => account.id),
      requestedProviderAccountId: providerAccountId,
    });
    if (!accountScope.ok) {
      return NextResponse.json(
        {
          status: accountScope.status,
          rows: [],
          ...buildMetaCreativesAccountScopeMetadata(accountScope),
        },
        { status: accountScope.status === "account_not_assigned" ? 403 : 400 },
      );
    }
    const demoPayload = getDemoMetaCopies();
    return NextResponse.json({
      ...demoPayload,
      rows: withAssociatedAdCounts(
        demoPayload.rows.filter(
          (row) => row.account_id === accountScope.providerAccountId,
        ),
        groupBy,
      ),
      meta: {
        ...demoPayload.meta,
        provider_account_id: accountScope.providerAccountId,
        // When the route ran. Kept for debugging; it is not the data's age.
        generatedAt: new Date().toISOString(),
        // When the rows themselves were last written by a sync. This is what
        // the surface reports as its as-of.
        warehouseObservedAt: await readCopiesWarehouseObservedAt({
          businessId,
          providerAccountId,
          start,
          end,
        }),
        // Demo rows are fixtures. The warehouse instant above is a real fact
        // about the table and a false statement about THESE rows, so the field
        // that names the rows' own age resolves to unknown rather than
        // borrowing it.
        readSource: "demo",
        ...resolveCopiesRowsObservedAt({
          readSource: "demo",
          warehouseObservedAt: null,
        }),
      },
      ...buildMetaCreativesAccountScopeMetadata(accountScope),
    });
  }

  const formatFilter = (format as "all" | "image" | "video") || "all";
  let initialCreativePayload: CreativePayload | null;
  try {
    initialCreativePayload = await fetchCopiesCreativePayload({
      request,
      businessId,
      providerAccountId,
      start,
      end,
      format: formatFilter,
      snapshotBypass: false,
      enableCreativeDetails: false,
      enableCreativeBasicsFallback: false,
    });
  } catch (error) {
    // A thrown upstream read is a failure, never an empty account. Letting it
    // escape as a 500 would be honest too, but the surface's error arm reads
    // `message`, so it is worth naming what did not happen.
    const failure: MetaCopiesFailureResponse = {
      status: "upstream_read_failed",
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : "Copy performance could not be read from Meta.",
      rows: [],
    };
    return NextResponse.json(failure, { status: 502 });
  }

  if (initialCreativePayload?.status === "account_not_assigned") {
    return NextResponse.json(initialCreativePayload, { status: 403 });
  }
  const initialSourceRows = Array.isArray(initialCreativePayload?.rows)
    ? initialCreativePayload.rows.filter((row) => row.account_id === providerAccountId)
    : [];
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
    // Recovery is best effort on top of a payload we already hold; a throw here
    // must not discard that payload, and must not be reported as a recovery
    // that found nothing.
    const recoveredPayload = await fetchCopiesCreativePayload({
      request,
      businessId,
      providerAccountId,
      start,
      end,
      format: formatFilter,
      snapshotBypass: true,
      enableCreativeDetails: true,
      enableCreativeBasicsFallback: true,
    }).catch((error: unknown) => {
      console.warn("[meta-copies] recovery_read_failed", {
        businessId,
        providerAccountId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (recoveredPayload?.status === "ok") {
      creativePayload = recoveredPayload;
      const recoveredRows = Array.isArray(recoveredPayload.rows)
        ? recoveredPayload.rows.filter((row) => row.account_id === providerAccountId)
        : [];
      const recoveredEligible = recoveredRows
        .map(mapCreativeRowToCopyRow)
        .filter(isCopyEligible);
      recoveryRecovered = recoveredEligible.length > 0;
    }
  }

  // The upstream verdict decides this response. Every status other than "ok"
  // used to fall through the `Array.isArray(...) ? ... : []` guards below and
  // be re-emitted as `status: "ok", rows: []` with HTTP 200, so `no_connection`,
  // `no_access_token` and `no_accounts_assigned` all reached the operator as
  // "No copy performance is available for this account and date range." That
  // sentence is a fact about the account; only a completed read establishes it.
  if (!SUCCESSFUL_UPSTREAM_STATUSES.has(creativePayload?.status ?? "")) {
    const failure: MetaCopiesFailureResponse = {
      status: creativePayload?.status ?? "upstream_unavailable",
      message: upstreamFailureMessage(creativePayload),
      rows: [],
    };
    return NextResponse.json(failure, {
      status: upstreamFailureHttpStatus(failure.status),
    });
  }

  const sourceRows = Array.isArray(creativePayload?.rows)
    ? creativePayload.rows.filter((row) => row.account_id === providerAccountId)
    : [];
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

  // An incomplete upstream read stays visible in the status and in `meta`. The
  // rows below are real, but they are not the whole window, and a surface that
  // reads only `rows.length` would otherwise call a partial read an empty one.
  const isPartial = creativePayload?.isPartial === true;

  // When a sync last WROTE the warehouse rows for this window. Read
  // unconditionally, because it is a genuine fact about the table and useful
  // even when the rows on screen came from somewhere else — but it is NOT
  // handed to the surface as the rows' age unless the rows actually came from
  // there. `resolveCopiesRowsObservedAt` is what enforces that.
  const warehouseObservedAt = await readCopiesWarehouseObservedAt({
    businessId,
    providerAccountId,
    start,
    end,
  });
  const readSource = creativePayload?.readSource ?? null;
  const { rowsObservedAt, rowsObservedAtSource } = resolveCopiesRowsObservedAt({
    readSource,
    warehouseObservedAt,
  });

  const response: MetaCopiesApiResponse = {
    status: isPartial ? "partial" : "ok",
    rows: sorted,
    meta: {
      group_by: groupBy,
      sort,
      unresolved_filtered_count: unresolvedFilteredCount,
      source_rows_count: sourceRows.length,
      returned_rows_count: sorted.length,
      provider_account_id: providerAccountId,
      generatedAt: new Date().toISOString(),
      // When the rows themselves were last written by a sync. Only the demo
      // branch used to publish this, so every real business reported an unknown
      // age. Null stays null: an unreadable timestamp is an unknown age.
      warehouseObservedAt,
      readSource,
      rowsObservedAt,
      rowsObservedAtSource,
      isPartial,
      notReadyReason: isPartial ? creativePayload?.notReadyReason ?? null : null,
      recoveryAttempted,
      recoveryRecovered,
      recoveryReason,
      unresolved_debug: unresolvedDebug,
    },
  };

  return NextResponse.json(response);
}
