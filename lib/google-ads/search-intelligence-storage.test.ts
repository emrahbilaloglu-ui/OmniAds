import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchTermPerformanceRow } from "@/lib/google-ads/intelligence-model";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  /*
    ROUND 22, ITEM 1: the bindings view of the same store. `refIds` is what the
    id-only helper returns; `timezones` is what the binding actually holds
    afterwards, which writers now stamp their rows from. Mocked here as the
    identity of what was passed, because these suites are not about the binding
    rule -- lib/provider-account-timezone-authority.db.test.ts proves that
    against a real PostgreSQL.
  */
  ensureProviderAccountReferenceBindings: vi.fn(
    async ({
      accounts,
    }: {
      accounts: Array<{ externalAccountId: string; timezone?: string | null }>;
    }) => ({
      refIds: new Map(
        accounts.map(
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
      timezones: new Map(
        accounts
          .filter((account) => (account.timezone ?? "").trim().length > 0)
          .map((account) => [account.externalAccountId, String(account.timezone)] as const),
      ),
    }),
  ),
  ensureProviderAccountReferenceIds: vi.fn(async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) => {
    return new Map(
      accounts.map((account) => [account.externalAccountId, `${account.externalAccountId}-ref`] as const),
    );
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

const db = await import("@/lib/db");
const storage = await import("@/lib/google-ads/search-intelligence-storage");

function buildSearchRow(
  overrides: Partial<SearchTermPerformanceRow> & Record<string, unknown> = {}
): Partial<SearchTermPerformanceRow> & Record<string, unknown> {
  return {
    searchTerm: "Running Shoes",
    campaignId: "cmp_1",
    campaignName: "Search",
    adGroupId: "ag_1",
    adGroupName: "Ad Group",
    intentClass: "category_high_intent",
    ownershipClass: "non_brand",
    clusterId: "running_shoes_cluster",
    spend: 12,
    revenue: 48,
    conversions: 2,
    impressions: 120,
    clicks: 12,
    ...overrides,
  } satisfies Partial<SearchTermPerformanceRow> & Record<string, unknown>;
}

function buildPersistedHotDailyRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    business_id: "biz",
    provider_account_id: "acct",
    date: "2026-04-08",
    account_timezone: "UTC",
    account_currency: "USD",
    query_hash: storage.buildGoogleAdsQueryHash("Running Shoes"),
    campaign_id: "cmp_1",
    campaign_name: "Search",
    ad_group_id: "ag_1",
    ad_group_name: "Ad Group",
    cluster_key: "running_shoes_cluster",
    cluster_label: "running_shoes_cluster",
    theme_key: "category_high_intent",
    intent_class: "category_high_intent",
    ownership_class: "non_brand",
    spend: "12",
    revenue: "48",
    conversions: "2",
    impressions: "120",
    clicks: "12",
    source_snapshot_id: "snap_1",
    ...overrides,
  };
}

describe("Google Ads search intelligence storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes query text and hashes equivalent variants deterministically", () => {
    expect(storage.normalizeGoogleAdsQueryText("  Running   Shoes ")).toBe("running shoes");
    expect(storage.buildGoogleAdsQueryHash("Running Shoes")).toBe(
      storage.buildGoogleAdsQueryHash(" running   shoes ")
    );
  });

  it("builds deduplicated query dictionary entries", () => {
    const entries = storage.buildGoogleAdsQueryDictionaryEntries({
      date: "2026-04-08",
      rows: [buildSearchRow(), buildSearchRow({ searchTerm: "running shoes" })],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      normalizedQuery: "running shoes",
      firstSeenDate: "2026-04-08",
      lastSeenDate: "2026-04-08",
    });
  });

  it("builds top-query weekly and cluster aggregates from hot-daily rows", () => {
    const hotDailyRows = storage.buildGoogleAdsSearchQueryHotDailyRows({
      businessId: "biz",
      providerAccountId: "acct",
      date: "2026-04-08",
      accountTimezone: "UTC",
      accountCurrency: "USD",
      rows: [buildSearchRow(), buildSearchRow({ spend: 8, revenue: 24, conversions: 1 })],
      sourceSnapshotId: "snap_1",
    });

    const weeklyRows = storage.buildGoogleAdsTopQueryWeeklyRowsFromHotDaily({ hotDailyRows });
    const clusterRows = storage.buildGoogleAdsSearchClusterDailyRows({
      businessId: "biz",
      providerAccountId: "acct",
      date: "2026-04-08",
      rows: [buildSearchRow(), buildSearchRow({ searchTerm: "best running shoes" })],
    });

    expect(weeklyRows).toHaveLength(1);
    expect(weeklyRows[0]).toMatchObject({
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      spend: 20,
      revenue: 72,
      conversions: 3,
    });
    expect(clusterRows).toHaveLength(1);
    expect(clusterRows[0]).toMatchObject({
      clusterKey: "running_shoes_cluster",
      uniqueQueryCount: 2,
      spend: 24,
    });
  });

  it("maps persisted hot-daily rows into the weekly builder shape without losing identifiers", async () => {
    const sql = vi.fn(async () => [
      buildPersistedHotDailyRow(),
      buildPersistedHotDailyRow({
        date: "2026-04-09",
        spend: "8",
        revenue: "24",
        conversions: "1",
        impressions: "80",
        clicks: "8",
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const hotDailyRows = await storage.readGoogleAdsSearchQueryHotDailyRows({
      businessId: "biz",
      providerAccountId: "acct",
      startDate: "2026-04-07",
      endDate: "2026-04-12",
    });
    const weeklyRows = storage.buildGoogleAdsTopQueryWeeklyRowsFromHotDaily({ hotDailyRows });

    expect(hotDailyRows).toHaveLength(2);
    expect(hotDailyRows[0]).toMatchObject({
      businessId: "biz",
      providerAccountId: "acct",
      campaignId: "cmp_1",
      adGroupId: "ag_1",
      queryHash: storage.buildGoogleAdsQueryHash("Running Shoes"),
      clusterKey: "running_shoes_cluster",
      sourceSnapshotId: "snap_1",
      spend: 12,
      revenue: 48,
      conversions: 2,
    });
    expect(weeklyRows).toHaveLength(1);
    expect(weeklyRows[0]).toMatchObject({
      businessId: "biz",
      providerAccountId: "acct",
      queryHash: storage.buildGoogleAdsQueryHash("Running Shoes"),
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      queryCountDays: 2,
      spend: 20,
      revenue: 72,
      conversions: 3,
    });
  });

  it("normalizes persisted hot-daily dates when the driver returns Date objects", async () => {
    const sql = vi.fn(async () => [
      buildPersistedHotDailyRow({
        date: new Date("2026-04-08T00:00:00.000Z"),
      }),
      buildPersistedHotDailyRow({
        date: new Date("2026-04-09T00:00:00.000Z"),
        spend: "8",
        revenue: "24",
        conversions: "1",
        impressions: "80",
        clicks: "8",
      }),
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const hotDailyRows = await storage.readGoogleAdsSearchQueryHotDailyRows({
      businessId: "biz",
      providerAccountId: "acct",
      startDate: "2026-04-07",
      endDate: "2026-04-12",
    });
    const weeklyRows = storage.buildGoogleAdsTopQueryWeeklyRowsFromHotDaily({ hotDailyRows });

    expect(hotDailyRows.map((row) => row.date)).toEqual([
      "2026-04-08",
      "2026-04-09",
    ]);
    expect(weeklyRows[0]).toMatchObject({
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      queryCountDays: 2,
    });
  });

  it("persists the search intelligence foundation through additive storage helpers", async () => {
    const calls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      calls.push(query);
      if (query.includes("SELECT *") && query.includes("google_ads_search_query_hot_daily")) {
        return [buildPersistedHotDailyRow()];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await storage.persistGoogleAdsSearchIntelligenceFoundation({
      businessId: "biz",
      providerAccountId: "acct",
      date: "2026-04-08",
      accountTimezone: "UTC",
      accountCurrency: "USD",
      rows: [buildSearchRow()],
      sourceSnapshotId: "snap_1",
    });

    expect(result).toMatchObject({
      dictionaryEntryCount: 1,
      hotDailyRowCount: 1,
      weeklyRowCount: 1,
      clusterRowCount: 1,
    });
    const joined = calls.join("\n");
    expect(joined).toContain("INSERT INTO google_ads_query_dictionary");
    expect(joined).toContain("INSERT INTO google_ads_search_query_hot_daily");
    expect(joined).toContain("SELECT *");
    expect(joined).toContain("INSERT INTO google_ads_top_query_weekly");
    expect(joined).toContain("INSERT INTO google_ads_search_cluster_daily");
  });

  it("rebuilds weekly aggregates from persisted hot-daily rows across the full week", async () => {
    const calls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      calls.push(query);
      if (query.includes("SELECT *") && query.includes("google_ads_search_query_hot_daily")) {
        return [
          buildPersistedHotDailyRow({
            date: "2026-04-07",
            spend: "12",
            revenue: "48",
            conversions: "2",
            impressions: "120",
            clicks: "12",
            source_snapshot_id: "snap_prev",
          }),
          buildPersistedHotDailyRow({
            date: "2026-04-08",
            spend: "8",
            revenue: "24",
            conversions: "1",
            impressions: "80",
            clicks: "8",
            source_snapshot_id: "snap_curr",
          }),
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await storage.persistGoogleAdsSearchIntelligenceFoundation({
      businessId: "biz",
      providerAccountId: "acct",
      date: "2026-04-08",
      accountTimezone: "UTC",
      accountCurrency: "USD",
      rows: [buildSearchRow({ spend: 8, revenue: 24, conversions: 1 })],
      sourceSnapshotId: "snap_curr",
    });

    expect(result.weeklyRowCount).toBe(1);
    const weeklyInsert = calls.find((query) => query.includes("INSERT INTO google_ads_top_query_weekly"));
    expect(weeklyInsert).toBeTruthy();
    expect(calls.join("\n")).toContain("FROM google_ads_search_query_hot_daily");
  });

  it("matches nullable campaign and ad-group ids deterministically during hot-daily upserts", async () => {
    const calls: string[] = [];
    let callCount = 0;
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      calls.push(query);
      callCount += 1;
      if (query.includes("UPDATE google_ads_search_query_hot_daily")) {
        return callCount === 1 ? [{ "?column?": 1 }] : [];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await storage.upsertGoogleAdsSearchQueryHotDailyRows([
      storage.buildGoogleAdsSearchQueryHotDailyRows({
        businessId: "biz",
        providerAccountId: "acct",
        date: "2026-04-08",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        rows: [buildSearchRow({ campaignId: "cmp_1", adGroupId: undefined, adGroupName: undefined })],
        sourceSnapshotId: "snap_1",
      })[0]!,
      storage.buildGoogleAdsSearchQueryHotDailyRows({
        businessId: "biz",
        providerAccountId: "acct",
        date: "2026-04-08",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        rows: [buildSearchRow({ campaignId: "cmp_2", adGroupId: undefined, adGroupName: undefined })],
        sourceSnapshotId: "snap_1",
      })[0]!,
    ]);

    const joined = calls.join("\n");
    expect(joined).toContain("UPDATE google_ads_search_query_hot_daily");
    expect(joined).toContain("campaign_id IS NOT DISTINCT FROM");
    expect(joined).toContain("ad_group_id IS NOT DISTINCT FROM");
    expect(calls.filter((query) => query.includes("INSERT INTO google_ads_search_query_hot_daily"))).toHaveLength(1);
  });

  it("computes canonical search-intelligence coverage from additive rows and succeeded zero-row partitions", async () => {
    const calls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      calls.push(query);
      if (query.includes("WITH additive_rows AS")) {
        return [
          {
            completed_days: 5,
            ready_through_date: "2026-04-12",
            latest_updated_at: "2026-04-12T12:00:00.000Z",
            total_rows: 7,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const coverage = await storage.readGoogleAdsSearchIntelligenceCoverage({
      businessId: "biz",
      providerAccountId: "acct",
      startDate: "2026-04-08",
      endDate: "2026-04-10",
    });

    expect(coverage).toEqual({
      completedDays: 5,
      readyThroughDate: "2026-04-12",
      latestUpdatedAt: "2026-04-12T12:00:00.000Z",
      totalRows: 7,
    });
    expect(sql).toHaveBeenCalled();
    expect(calls.join("\n")).toContain("google_ads_sync_partitions");
    expect(calls.join("\n")).toContain("status = 'succeeded'");
    expect(calls.join("\n")).toContain("(SELECT COUNT(*)::int FROM additive_rows) AS total_rows");
  });

  it("writes canonical ref ids for search intelligence aggregates and outcome logs", async () => {
    const calls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      calls.push(strings.join(" "));
      if (strings.join(" ").includes("SELECT *") && strings.join(" ").includes("google_ads_search_query_hot_daily")) {
        return [buildPersistedHotDailyRow()];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await storage.persistGoogleAdsSearchIntelligenceFoundation({
      businessId: "biz",
      providerAccountId: "acct",
      date: "2026-04-08",
      accountTimezone: "UTC",
      accountCurrency: "USD",
      rows: [buildSearchRow()],
      sourceSnapshotId: "snap_1",
    });

    await storage.appendGoogleAdsDecisionActionOutcomeLog({
      businessId: "biz",
      providerAccountId: "acct",
      recommendationFingerprint: "fingerprint-1",
      decisionFamily: null,
      actionType: "outcome",
      outcomeStatus: null,
      summary: "ok",
      payloadJson: { ok: true },
    });

    const query = calls.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
    expect(query).toContain("google_ads_search_query_hot_daily");
    expect(query).toContain("google_ads_top_query_weekly");
    expect(query).toContain("google_ads_search_cluster_daily");
    expect(query).toContain("google_ads_decision_action_outcome_logs");
  });
});
