import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import type { SearchTermPerformanceRow } from "@/lib/google-ads/intelligence-model";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";

const GOOGLE_ADS_SEARCH_INTELLIGENCE_TABLES = [
  "google_ads_query_dictionary",
  "google_ads_search_query_hot_daily",
  "google_ads_top_query_weekly",
  "google_ads_search_cluster_daily",
  "google_ads_decision_action_outcome_logs",
] as const;

async function assertGoogleAdsSearchIntelligenceTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: [...GOOGLE_ADS_SEARCH_INTELLIGENCE_TABLES],
    context,
  });
}

async function resolveGoogleAdsSearchIntelligenceReferenceContext(
  rows: Array<{
    businessId: string;
    providerAccountId?: string | null;
  }>,
) {
  const businessIds = Array.from(
    new Set(rows.map((row) => row.businessId).filter(Boolean)),
  );
  const providerAccountIds = Array.from(
    new Set(
      rows
        .map((row) => row.providerAccountId ?? null)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  return {
    businessRefIds: await resolveBusinessReferenceIds(businessIds),
    providerAccountRefIds:
      providerAccountIds.length > 0
        ? await ensureProviderAccountReferenceIds({
            provider: "google",
            accounts: providerAccountIds.map((externalAccountId) => ({
              externalAccountId,
            })),
          })
        : new Map<string, string>(),
  };
}

export interface GoogleAdsQueryDictionaryEntry {
  queryHash: string;
  normalizedQuery: string;
  displayQuery: string;
  tokenCount: number;
  firstSeenDate: string;
  lastSeenDate: string;
}

export interface GoogleAdsSearchQueryHotDailyRow {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  queryHash: string;
  campaignId: string | null;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  clusterKey: string;
  clusterLabel: string;
  themeKey: string | null;
  intentClass: string | null;
  ownershipClass: string | null;
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  sourceSnapshotId: string | null;
}

export interface GoogleAdsSearchQueryHotDailySupportReadRow
  extends GoogleAdsSearchQueryHotDailyRow {
  normalizedQuery: string | null;
  displayQuery: string | null;
}

export interface GoogleAdsTopQueryWeeklyRow {
  businessId: string;
  providerAccountId: string;
  weekStart: string;
  weekEnd: string;
  queryHash: string;
  queryCountDays: number;
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
}

export interface GoogleAdsTopQueryWeeklySupportReadRow extends GoogleAdsTopQueryWeeklyRow {
  normalizedQuery: string | null;
  displayQuery: string | null;
}

export interface GoogleAdsSearchClusterDailyRow {
  businessId: string;
  providerAccountId: string;
  date: string;
  clusterKey: string;
  clusterLabel: string;
  themeKey: string | null;
  dominantIntentClass: string | null;
  dominantOwnershipClass: string | null;
  uniqueQueryCount: number;
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
}

export interface GoogleAdsSearchClusterDailySupportReadRow extends GoogleAdsSearchClusterDailyRow {}

export interface GoogleAdsSearchIntelligenceCoverage {
  completedDays: number;
  readyThroughDate: string | null;
  latestUpdatedAt: string | null;
  totalRows: number;
}

export interface GoogleAdsDecisionActionOutcomeLogRow {
  businessId: string;
  providerAccountId: string | null;
  recommendationFingerprint: string;
  decisionFamily: string | null;
  actionType: "plan" | "execute" | "rollback" | "outcome";
  outcomeStatus: string | null;
  summary: string;
  payloadJson?: Record<string, unknown>;
  occurredAt?: string | null;
}

type GoogleAdsSearchQueryHotDailyPersistedRow = {
  business_id: string;
  provider_account_id: string;
  date: string;
  account_timezone: string;
  account_currency: string;
  query_hash: string;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_group_id: string | null;
  ad_group_name: string | null;
  cluster_key: string;
  cluster_label: string;
  theme_key: string | null;
  intent_class: string | null;
  ownership_class: string | null;
  spend: number | string;
  revenue: number | string;
  conversions: number | string;
  impressions: number | string;
  clicks: number | string;
  source_snapshot_id: string | null;
};

type GoogleAdsSearchQueryHotDailySupportPersistedRow =
  GoogleAdsSearchQueryHotDailyPersistedRow & {
    normalized_query: string | null;
    display_query: string | null;
  };

type GoogleAdsTopQueryWeeklyPersistedRow = {
  business_id: string;
  provider_account_id: string;
  week_start: string;
  week_end: string;
  query_hash: string;
  query_count_days: number | string;
  spend: number | string;
  revenue: number | string;
  conversions: number | string;
  impressions: number | string;
  clicks: number | string;
  normalized_query: string | null;
  display_query: string | null;
};

type GoogleAdsSearchClusterDailyPersistedRow = {
  business_id: string;
  provider_account_id: string;
  date: string;
  cluster_key: string;
  cluster_label: string;
  theme_key: string | null;
  dominant_intent_class: string | null;
  dominant_ownership_class: string | null;
  unique_query_count: number | string;
  spend: number | string;
  revenue: number | string;
  conversions: number | string;
  impressions: number | string;
  clicks: number | string;
};

function normalizeIsoDate(value: string | Date) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const trimmed = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  const parsed = new Date(trimmed);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return trimmed.slice(0, 10);
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoWeekStart(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  value.setUTCDate(value.getUTCDate() + diff);
  return value.toISOString().slice(0, 10);
}

function isoWeekEnd(date: string) {
  const start = new Date(`${isoWeekStart(date)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + 6);
  return start.toISOString().slice(0, 10);
}

function normalizeThemeKey(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.length > 0 ? normalized.replace(/\s+/g, "_") : null;
}

export function normalizeGoogleAdsQueryText(query: string | null | undefined) {
  return String(query ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function buildGoogleAdsQueryHash(query: string | null | undefined) {
  return createHash("sha256")
    .update(normalizeGoogleAdsQueryText(query))
    .digest("hex");
}

export function buildGoogleAdsQueryDictionaryEntries(input: {
  date: string;
  rows: Array<Pick<SearchTermPerformanceRow, "searchTerm"> | Record<string, unknown>>;
}): GoogleAdsQueryDictionaryEntry[] {
  const byHash = new Map<string, GoogleAdsQueryDictionaryEntry>();
  for (const row of input.rows) {
    const displayQuery = String(("searchTerm" in row ? row.searchTerm : row.searchTerm) ?? "").trim();
    if (!displayQuery) continue;
    const normalizedQuery = normalizeGoogleAdsQueryText(displayQuery);
    const queryHash = buildGoogleAdsQueryHash(displayQuery);
    const existing = byHash.get(queryHash);
    if (!existing) {
      byHash.set(queryHash, {
        queryHash,
        normalizedQuery,
        displayQuery,
        tokenCount: normalizedQuery.split(/\s+/).filter(Boolean).length,
        firstSeenDate: input.date,
        lastSeenDate: input.date,
      });
      continue;
    }
    existing.lastSeenDate = input.date;
    if (displayQuery.length > existing.displayQuery.length) {
      existing.displayQuery = displayQuery;
    }
  }
  return Array.from(byHash.values());
}

export function buildGoogleAdsSearchQueryHotDailyRows(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  sourceSnapshotId?: string | null;
  rows: Array<Partial<SearchTermPerformanceRow> & Record<string, unknown>>;
}): GoogleAdsSearchQueryHotDailyRow[] {
  return input.rows
    .map((row) => {
      const displayQuery = String(row.searchTerm ?? "").trim();
      if (!displayQuery) return null;
      const queryHash = buildGoogleAdsQueryHash(displayQuery);
      const clusterKey =
        String(row.clusterId ?? "").trim() || `query:${queryHash.slice(0, 16)}`;
      return {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        date: input.date,
        accountTimezone: input.accountTimezone,
        accountCurrency: input.accountCurrency,
        queryHash,
        campaignId: row.campaignId ? String(row.campaignId) : null,
        campaignName: row.campaignName ? String(row.campaignName) : null,
        adGroupId: row.adGroupId ? String(row.adGroupId) : null,
        adGroupName: row.adGroupName ? String(row.adGroupName) : null,
        clusterKey,
        clusterLabel: String(row.clusterId ?? displayQuery).trim(),
        themeKey: normalizeThemeKey(String(row.intentClass ?? row.classification ?? "")),
        intentClass: row.intentClass ? String(row.intentClass) : null,
        ownershipClass: row.ownershipClass ? String(row.ownershipClass) : null,
        spend: toNumber(row.spend),
        revenue: toNumber(row.revenue),
        conversions: toNumber(row.conversions),
        impressions: toNumber(row.impressions),
        clicks: toNumber(row.clicks),
        sourceSnapshotId: input.sourceSnapshotId ?? null,
      } satisfies GoogleAdsSearchQueryHotDailyRow;
    })
    .filter((row): row is GoogleAdsSearchQueryHotDailyRow => Boolean(row));
}

export function buildGoogleAdsSearchClusterDailyRows(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  rows: Array<Partial<SearchTermPerformanceRow> & Record<string, unknown>>;
}): GoogleAdsSearchClusterDailyRow[] {
  const grouped = new Map<string, GoogleAdsSearchClusterDailyRow & { queryHashes: Set<string> }>();
  for (const row of input.rows) {
    const displayQuery = String(row.searchTerm ?? "").trim();
    if (!displayQuery) continue;
    const queryHash = buildGoogleAdsQueryHash(displayQuery);
    const clusterKey =
      String(row.clusterId ?? "").trim() || `query:${queryHash.slice(0, 16)}`;
    const existing = grouped.get(clusterKey);
    if (!existing) {
      grouped.set(clusterKey, {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        date: input.date,
        clusterKey,
        clusterLabel: String(row.clusterId ?? displayQuery).trim(),
        themeKey: normalizeThemeKey(String(row.intentClass ?? row.classification ?? "")),
        dominantIntentClass: row.intentClass ? String(row.intentClass) : null,
        dominantOwnershipClass: row.ownershipClass ? String(row.ownershipClass) : null,
        uniqueQueryCount: 1,
        spend: toNumber(row.spend),
        revenue: toNumber(row.revenue),
        conversions: toNumber(row.conversions),
        impressions: toNumber(row.impressions),
        clicks: toNumber(row.clicks),
        queryHashes: new Set([queryHash]),
      });
      continue;
    }
    existing.queryHashes.add(queryHash);
    existing.uniqueQueryCount = existing.queryHashes.size;
    existing.spend += toNumber(row.spend);
    existing.revenue += toNumber(row.revenue);
    existing.conversions += toNumber(row.conversions);
    existing.impressions += toNumber(row.impressions);
    existing.clicks += toNumber(row.clicks);
  }

  return Array.from(grouped.values()).map(({ queryHashes: _queryHashes, ...row }) => row);
}

export function buildGoogleAdsTopQueryWeeklyRowsFromHotDaily(input: {
  hotDailyRows: GoogleAdsSearchQueryHotDailyRow[];
}): GoogleAdsTopQueryWeeklyRow[] {
  const grouped = new Map<string, GoogleAdsTopQueryWeeklyRow & { dates: Set<string> }>();
  for (const row of input.hotDailyRows) {
    const weekStart = isoWeekStart(row.date);
    const weekEnd = isoWeekEnd(row.date);
    const key = [row.businessId, row.providerAccountId, weekStart, row.queryHash].join("::");
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        weekStart,
        weekEnd,
        queryHash: row.queryHash,
        queryCountDays: 1,
        spend: row.spend,
        revenue: row.revenue,
        conversions: row.conversions,
        impressions: row.impressions,
        clicks: row.clicks,
        dates: new Set([row.date]),
      });
      continue;
    }
    existing.dates.add(row.date);
    existing.queryCountDays = existing.dates.size;
    existing.spend += row.spend;
    existing.revenue += row.revenue;
    existing.conversions += row.conversions;
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
  }
  return Array.from(grouped.values()).map(({ dates: _dates, ...row }) => row);
}

function mapPersistedHotDailyRow(
  row: GoogleAdsSearchQueryHotDailyPersistedRow
): GoogleAdsSearchQueryHotDailyRow {
  return {
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    date: normalizeIsoDate(String(row.date)),
    accountTimezone: String(row.account_timezone),
    accountCurrency: String(row.account_currency),
    queryHash: String(row.query_hash),
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    campaignName: row.campaign_name ? String(row.campaign_name) : null,
    adGroupId: row.ad_group_id ? String(row.ad_group_id) : null,
    adGroupName: row.ad_group_name ? String(row.ad_group_name) : null,
    clusterKey: String(row.cluster_key),
    clusterLabel: String(row.cluster_label),
    themeKey: row.theme_key ? String(row.theme_key) : null,
    intentClass: row.intent_class ? String(row.intent_class) : null,
    ownershipClass: row.ownership_class ? String(row.ownership_class) : null,
    spend: toNumber(row.spend),
    revenue: toNumber(row.revenue),
    conversions: toNumber(row.conversions),
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    sourceSnapshotId: row.source_snapshot_id ? String(row.source_snapshot_id) : null,
  };
}

function mapPersistedHotDailySupportRow(
  row: GoogleAdsSearchQueryHotDailySupportPersistedRow
): GoogleAdsSearchQueryHotDailySupportReadRow {
  return {
    ...mapPersistedHotDailyRow(row),
    normalizedQuery: row.normalized_query ? String(row.normalized_query) : null,
    displayQuery: row.display_query ? String(row.display_query) : null,
  };
}

function mapPersistedTopQueryWeeklyRow(
  row: GoogleAdsTopQueryWeeklyPersistedRow
): GoogleAdsTopQueryWeeklySupportReadRow {
  return {
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    weekStart: normalizeIsoDate(String(row.week_start)),
    weekEnd: normalizeIsoDate(String(row.week_end)),
    queryHash: String(row.query_hash),
    queryCountDays: toNumber(row.query_count_days),
    spend: toNumber(row.spend),
    revenue: toNumber(row.revenue),
    conversions: toNumber(row.conversions),
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    normalizedQuery: row.normalized_query ? String(row.normalized_query) : null,
    displayQuery: row.display_query ? String(row.display_query) : null,
  };
}

function mapPersistedSearchClusterDailyRow(
  row: GoogleAdsSearchClusterDailyPersistedRow
): GoogleAdsSearchClusterDailySupportReadRow {
  return {
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    date: normalizeIsoDate(String(row.date)),
    clusterKey: String(row.cluster_key),
    clusterLabel: String(row.cluster_label),
    themeKey: row.theme_key ? String(row.theme_key) : null,
    dominantIntentClass: row.dominant_intent_class ? String(row.dominant_intent_class) : null,
    dominantOwnershipClass: row.dominant_ownership_class
      ? String(row.dominant_ownership_class)
      : null,
    uniqueQueryCount: toNumber(row.unique_query_count),
    spend: toNumber(row.spend),
    revenue: toNumber(row.revenue),
    conversions: toNumber(row.conversions),
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
  };
}

export async function readGoogleAdsSearchQueryHotDailyRows(input: {
  businessId: string;
  providerAccountId: string;
  startDate: string;
  endDate: string;
}) {
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM google_ads_search_query_hot_daily
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND date >= ${input.startDate}
      AND date <= ${input.endDate}
    ORDER BY date ASC, query_hash ASC
  `) as GoogleAdsSearchQueryHotDailyPersistedRow[];
  return rows.map(mapPersistedHotDailyRow);
}

export async function readGoogleAdsSearchQueryHotDailySupportRows(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}) {
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const rows = (await sql`
    SELECT
      daily.*,
      dictionary.normalized_query,
      dictionary.display_query
    FROM google_ads_search_query_hot_daily AS daily
    LEFT JOIN google_ads_query_dictionary AS dictionary
      ON dictionary.query_hash = daily.query_hash
    WHERE daily.business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR daily.provider_account_id = ${input.providerAccountId ?? null})
      AND daily.date >= ${input.startDate}
      AND daily.date <= ${input.endDate}
    ORDER BY daily.date ASC, daily.spend DESC, daily.query_hash ASC
  `) as GoogleAdsSearchQueryHotDailySupportPersistedRow[];
  return rows.map(mapPersistedHotDailySupportRow);
}

export async function upsertGoogleAdsQueryDictionaryEntries(entries: GoogleAdsQueryDictionaryEntry[]) {
  if (entries.length === 0) return 0;
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  for (const entry of entries) {
    await sql`
      INSERT INTO google_ads_query_dictionary (
        query_hash,
        normalized_query,
        display_query,
        token_count,
        first_seen_date,
        last_seen_date,
        updated_at
      )
      VALUES (
        ${entry.queryHash},
        ${entry.normalizedQuery},
        ${entry.displayQuery},
        ${entry.tokenCount},
        ${entry.firstSeenDate},
        ${entry.lastSeenDate},
        now()
      )
      ON CONFLICT (query_hash)
      DO UPDATE SET
        normalized_query = EXCLUDED.normalized_query,
        display_query = EXCLUDED.display_query,
        token_count = EXCLUDED.token_count,
        first_seen_date = LEAST(google_ads_query_dictionary.first_seen_date, EXCLUDED.first_seen_date),
        last_seen_date = GREATEST(google_ads_query_dictionary.last_seen_date, EXCLUDED.last_seen_date),
        updated_at = now()
    `;
  }
  return entries.length;
}

export async function upsertGoogleAdsSearchQueryHotDailyRows(rows: GoogleAdsSearchQueryHotDailyRow[]) {
  if (rows.length === 0) return 0;
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const refs = await resolveGoogleAdsSearchIntelligenceReferenceContext(rows);
  for (const row of rows) {
    const businessRefId = refs.businessRefIds.get(row.businessId) ?? null;
    const providerAccountRefId =
      refs.providerAccountRefIds.get(row.providerAccountId) ?? null;
    const updatedRows = await sql`
      UPDATE google_ads_search_query_hot_daily
      SET
        business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
        provider_account_ref_id = COALESCE(provider_account_ref_id, ${providerAccountRefId}),
        account_timezone = ${row.accountTimezone},
        account_currency = ${row.accountCurrency},
        campaign_name = ${row.campaignName},
        ad_group_name = ${row.adGroupName},
        cluster_key = ${row.clusterKey},
        cluster_label = ${row.clusterLabel},
        theme_key = ${row.themeKey},
        intent_class = ${row.intentClass},
        ownership_class = ${row.ownershipClass},
        spend = ${row.spend},
        revenue = ${row.revenue},
        conversions = ${row.conversions},
        impressions = ${row.impressions},
        clicks = ${row.clicks},
        source_snapshot_id = ${row.sourceSnapshotId},
        updated_at = now()
      WHERE business_id = ${row.businessId}
        AND provider_account_id = ${row.providerAccountId}
        AND date = ${normalizeIsoDate(row.date)}
        AND query_hash = ${row.queryHash}
        AND campaign_id IS NOT DISTINCT FROM ${row.campaignId}
        AND ad_group_id IS NOT DISTINCT FROM ${row.adGroupId}
      RETURNING 1
    `;
    if (Array.isArray(updatedRows) && updatedRows.length > 0) {
      continue;
    }
    await sql`
      INSERT INTO google_ads_search_query_hot_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        account_timezone,
        account_currency,
        query_hash,
        campaign_id,
        campaign_name,
        ad_group_id,
        ad_group_name,
        cluster_key,
        cluster_label,
        theme_key,
        intent_class,
        ownership_class,
        spend,
        revenue,
        conversions,
        impressions,
        clicks,
        source_snapshot_id,
        updated_at
      )
      VALUES (
        ${row.businessId},
        ${businessRefId},
        ${row.providerAccountId},
        ${providerAccountRefId},
        ${normalizeIsoDate(row.date)},
        ${row.accountTimezone},
        ${row.accountCurrency},
        ${row.queryHash},
        ${row.campaignId},
        ${row.campaignName},
        ${row.adGroupId},
        ${row.adGroupName},
        ${row.clusterKey},
        ${row.clusterLabel},
        ${row.themeKey},
        ${row.intentClass},
        ${row.ownershipClass},
        ${row.spend},
        ${row.revenue},
        ${row.conversions},
        ${row.impressions},
        ${row.clicks},
        ${row.sourceSnapshotId},
        now()
      )
    `;
  }
  return rows.length;
}

export async function upsertGoogleAdsTopQueryWeeklyRows(rows: GoogleAdsTopQueryWeeklyRow[]) {
  if (rows.length === 0) return 0;
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const refs = await resolveGoogleAdsSearchIntelligenceReferenceContext(rows);
  for (const row of rows) {
    const businessRefId = refs.businessRefIds.get(row.businessId) ?? null;
    const providerAccountRefId =
      refs.providerAccountRefIds.get(row.providerAccountId) ?? null;
    await sql`
      INSERT INTO google_ads_top_query_weekly (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        week_start,
        week_end,
        query_hash,
        query_count_days,
        spend,
        revenue,
        conversions,
        impressions,
        clicks,
        updated_at
      )
      VALUES (
        ${row.businessId},
        ${businessRefId},
        ${row.providerAccountId},
        ${providerAccountRefId},
        ${row.weekStart},
        ${row.weekEnd},
        ${row.queryHash},
        ${row.queryCountDays},
        ${row.spend},
        ${row.revenue},
        ${row.conversions},
        ${row.impressions},
        ${row.clicks},
        now()
      )
      ON CONFLICT (business_id, provider_account_id, week_start, query_hash)
      DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_top_query_weekly.business_ref_id),
        provider_account_ref_id = COALESCE(
          EXCLUDED.provider_account_ref_id,
          google_ads_top_query_weekly.provider_account_ref_id
        ),
        week_end = EXCLUDED.week_end,
        query_count_days = EXCLUDED.query_count_days,
        spend = EXCLUDED.spend,
        revenue = EXCLUDED.revenue,
        conversions = EXCLUDED.conversions,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        updated_at = now()
    `;
  }
  return rows.length;
}

export async function upsertGoogleAdsSearchClusterDailyRows(rows: GoogleAdsSearchClusterDailyRow[]) {
  if (rows.length === 0) return 0;
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const refs = await resolveGoogleAdsSearchIntelligenceReferenceContext(rows);
  for (const row of rows) {
    const businessRefId = refs.businessRefIds.get(row.businessId) ?? null;
    const providerAccountRefId =
      refs.providerAccountRefIds.get(row.providerAccountId) ?? null;
    await sql`
      INSERT INTO google_ads_search_cluster_daily (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        date,
        cluster_key,
        cluster_label,
        theme_key,
        dominant_intent_class,
        dominant_ownership_class,
        unique_query_count,
        spend,
        revenue,
        conversions,
        impressions,
        clicks,
        updated_at
      )
      VALUES (
        ${row.businessId},
        ${businessRefId},
        ${row.providerAccountId},
        ${providerAccountRefId},
        ${row.date},
        ${row.clusterKey},
        ${row.clusterLabel},
        ${row.themeKey},
        ${row.dominantIntentClass},
        ${row.dominantOwnershipClass},
        ${row.uniqueQueryCount},
        ${row.spend},
        ${row.revenue},
        ${row.conversions},
        ${row.impressions},
        ${row.clicks},
        now()
      )
      ON CONFLICT (business_id, provider_account_id, date, cluster_key)
      DO UPDATE SET
        business_ref_id = COALESCE(
          EXCLUDED.business_ref_id,
          google_ads_search_cluster_daily.business_ref_id
        ),
        provider_account_ref_id = COALESCE(
          EXCLUDED.provider_account_ref_id,
          google_ads_search_cluster_daily.provider_account_ref_id
        ),
        cluster_label = EXCLUDED.cluster_label,
        theme_key = EXCLUDED.theme_key,
        dominant_intent_class = EXCLUDED.dominant_intent_class,
        dominant_ownership_class = EXCLUDED.dominant_ownership_class,
        unique_query_count = EXCLUDED.unique_query_count,
        spend = EXCLUDED.spend,
        revenue = EXCLUDED.revenue,
        conversions = EXCLUDED.conversions,
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        updated_at = now()
    `;
  }
  return rows.length;
}

export async function appendGoogleAdsDecisionActionOutcomeLog(input: GoogleAdsDecisionActionOutcomeLogRow) {
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const refs = await resolveGoogleAdsSearchIntelligenceReferenceContext([
    {
      businessId: input.businessId,
      providerAccountId: input.providerAccountId ?? null,
    },
  ]);
  const businessRefId = refs.businessRefIds.get(input.businessId) ?? null;
  const providerAccountRefId = input.providerAccountId
    ? (refs.providerAccountRefIds.get(input.providerAccountId) ?? null)
    : null;
  const rows = (await sql`
    INSERT INTO google_ads_decision_action_outcome_logs (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      recommendation_fingerprint,
      decision_family,
      action_type,
      outcome_status,
      summary,
      payload_json,
      occurred_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.providerAccountId ?? null},
      ${providerAccountRefId},
      ${input.recommendationFingerprint},
      ${input.decisionFamily ?? null},
      ${input.actionType},
      ${input.outcomeStatus ?? null},
      ${input.summary},
      ${JSON.stringify(input.payloadJson ?? {})}::jsonb,
      COALESCE(${input.occurredAt ?? null}, now()),
      now()
    )
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function persistGoogleAdsSearchIntelligenceFoundation(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  rows: Array<Partial<SearchTermPerformanceRow> & Record<string, unknown>>;
  sourceSnapshotId?: string | null;
}) {
  const dictionaryEntries = buildGoogleAdsQueryDictionaryEntries({
    date: input.date,
    rows: input.rows,
  });
  const hotDailyRows = buildGoogleAdsSearchQueryHotDailyRows({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    date: input.date,
    accountTimezone: input.accountTimezone,
    accountCurrency: input.accountCurrency,
    sourceSnapshotId: input.sourceSnapshotId,
    rows: input.rows,
  });
  const clusterRows = buildGoogleAdsSearchClusterDailyRows({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    date: input.date,
    rows: input.rows,
  });

  await upsertGoogleAdsQueryDictionaryEntries(dictionaryEntries);
  await upsertGoogleAdsSearchQueryHotDailyRows(hotDailyRows);
  const weeklyHotDailyRows = await readGoogleAdsSearchQueryHotDailyRows({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDate: isoWeekStart(input.date),
    endDate: isoWeekEnd(input.date),
  });
  const weeklyRows = buildGoogleAdsTopQueryWeeklyRowsFromHotDaily({ hotDailyRows: weeklyHotDailyRows });
  await upsertGoogleAdsTopQueryWeeklyRows(weeklyRows);
  await upsertGoogleAdsSearchClusterDailyRows(clusterRows);

  return {
    dictionaryEntryCount: dictionaryEntries.length,
    hotDailyRowCount: hotDailyRows.length,
    weeklyRowCount: weeklyRows.length,
    clusterRowCount: clusterRows.length,
  };
}

export async function readGoogleAdsTopQueryWeeklyRows(input: {
  businessId: string;
  providerAccountId?: string | null;
  startWeek: string;
  endWeek: string;
}) {
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const rows = (await sql`
    SELECT
      weekly.*,
      dictionary.normalized_query,
      dictionary.display_query
    FROM google_ads_top_query_weekly
    AS weekly
    LEFT JOIN google_ads_query_dictionary AS dictionary
      ON dictionary.query_hash = weekly.query_hash
    WHERE weekly.business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR weekly.provider_account_id = ${input.providerAccountId ?? null})
      AND weekly.week_start >= ${input.startWeek}
      AND weekly.week_start <= ${input.endWeek}
    ORDER BY week_start DESC, spend DESC
  `) as GoogleAdsTopQueryWeeklyPersistedRow[];
  return rows.map(mapPersistedTopQueryWeeklyRow);
}

export async function readGoogleAdsSearchClusterDailyRows(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}) {
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM google_ads_search_cluster_daily
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND date >= ${input.startDate}
      AND date <= ${input.endDate}
    ORDER BY date DESC, spend DESC
  `) as GoogleAdsSearchClusterDailyPersistedRow[];
  return rows.map(mapPersistedSearchClusterDailyRow);
}

export async function readGoogleAdsSearchIntelligenceCoverage(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
}): Promise<GoogleAdsSearchIntelligenceCoverage> {
  await assertDbSchemaReady({
    tables: [
      ...GOOGLE_ADS_SEARCH_INTELLIGENCE_TABLES,
      "google_ads_sync_partitions",
    ],
    context: "google_ads_search_intelligence_coverage",
  });
  const sql = getDb();
  const rows = (await sql`
    WITH additive_rows AS (
      SELECT date, updated_at
      FROM google_ads_search_query_hot_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date >= ${input.startDate}
        AND date <= ${input.endDate}
      UNION ALL
      SELECT date, updated_at
      FROM google_ads_search_cluster_daily
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND date >= ${input.startDate}
        AND date <= ${input.endDate}
    ),
    succeeded_partition_rows AS (
      SELECT partition_date::date AS date, updated_at
      FROM google_ads_sync_partitions
      WHERE business_id = ${input.businessId}
        AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
        AND scope = 'search_term_daily'
        AND partition_date >= ${input.startDate}
        AND partition_date <= ${input.endDate}
        AND status = 'succeeded'
    ),
    coverage_rows AS (
      SELECT date, updated_at
      FROM additive_rows
      UNION ALL
      SELECT date, updated_at
      FROM succeeded_partition_rows
    ),
    covered_days AS (
      SELECT
        date,
        MAX(updated_at) AS latest_updated_at
      FROM coverage_rows
      GROUP BY date
    )
    SELECT
      COUNT(*)::int AS completed_days,
      MAX(date)::text AS ready_through_date,
      MAX(latest_updated_at)::text AS latest_updated_at,
      (SELECT COUNT(*)::int FROM additive_rows) AS total_rows
    FROM covered_days
  `) as Array<{
    completed_days?: number | string | null;
    ready_through_date?: string | null;
    latest_updated_at?: string | null;
    total_rows?: number | string | null;
  }>;
  const row = rows[0] ?? null;
  return {
    completedDays: toNumber(row?.completed_days),
    readyThroughDate: row?.ready_through_date
      ? normalizeIsoDate(String(row.ready_through_date))
      : null,
    latestUpdatedAt: row?.latest_updated_at ? String(row.latest_updated_at) : null,
    totalRows: toNumber(row?.total_rows),
  };
}

export async function readGoogleAdsDecisionActionOutcomeLogs(input: {
  businessId: string;
  providerAccountId?: string | null;
  recommendationFingerprint?: string | null;
  limit?: number;
}) {
  await assertGoogleAdsSearchIntelligenceTablesReady("google_ads_search_intelligence_storage");
  const sql = getDb();
  return sql`
    SELECT *
    FROM google_ads_decision_action_outcome_logs
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND (${input.recommendationFingerprint ?? null}::text IS NULL OR recommendation_fingerprint = ${input.recommendationFingerprint ?? null})
    ORDER BY occurred_at DESC
    LIMIT ${Math.max(1, Math.min(input.limit ?? 100, 500))}
  `;
}
