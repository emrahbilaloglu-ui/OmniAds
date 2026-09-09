import { beforeEach, describe, expect, it, vi } from "vitest";

const dbQuery = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({
    query: dbQuery,
  })),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
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
      accounts.map((account) => [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const),
    );
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const),
    );
  }),
}));

const schemaReadiness = await import("@/lib/db-schema-readiness");
const {
  materializeOverviewSummaryRangeFromMeta,
  refreshOverviewSummaryMaterializationFromGoogleAccountRows,
} = await import("@/lib/overview-summary-materializer");

describe("overview summary materializer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbQuery.mockResolvedValue([]);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
  });

  it("materializes only overview projection tables", async () => {
    const rows = await materializeOverviewSummaryRangeFromMeta({
      businessId: "biz_1",
      providerAccountIds: ["act_1"],
      startDate: "2026-03-01",
      endDate: "2026-03-03",
      rows: [
        {
          businessId: "biz_1",
          providerAccountId: "act_1",
          date: new Date("2026-03-01T00:00:00.000Z"),
          accountName: "Main",
          accountTimezone: "UTC",
          accountCurrency: "USD",
          spend: 100,
          impressions: 1000,
          clicks: 25,
          reach: 900,
          frequency: 1.1,
          conversions: 3,
          revenue: 220,
          roas: 2.2,
          cpa: 33.3,
          ctr: 2.5,
          cpc: 4,
          sourceSnapshotId: "snap_1",
          finalizedAt: "2026-04-07T08:51:32.721Z",
          createdAt: "2026-04-07T08:51:38.063Z",
          updatedAt: "2026-04-07T08:51:38.063Z",
        },
      ] as never,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-03-01",
        spend: 100,
        purchases: 3,
      }),
    ]);
    expect(dbQuery).toHaveBeenCalledTimes(2);
    expect(String(dbQuery.mock.calls[0]?.[0] ?? "")).toContain(
      "INSERT INTO platform_overview_daily_summary",
    );
    expect(String(dbQuery.mock.calls[1]?.[0] ?? "")).toContain(
      "INSERT INTO platform_overview_summary_ranges",
    );
  });

  it("refreshes daily rows and invalidates only range manifests", async () => {
    await refreshOverviewSummaryMaterializationFromGoogleAccountRows([
      {
        businessId: "biz_1",
        providerAccountId: "acc_1",
        date: "2026-03-01",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        entityKey: null,
        entityLabel: null,
        campaignId: null,
        campaignName: null,
        adGroupId: null,
        adGroupName: null,
        status: null,
        channel: null,
        classification: null,
        spend: 40,
        revenue: 100,
        conversions: 2,
        impressions: 300,
        clicks: 12,
        ctr: 4,
        cpc: 3.33,
        cpa: 20,
        roas: 2.5,
        conversionRate: 16.67,
        interactionRate: null,
        sourceSnapshotId: "snap_1",
        updatedAt: "2026-04-07T00:00:00.000Z",
      } as never,
    ]);

    expect(dbQuery).toHaveBeenCalledTimes(2);
    expect(String(dbQuery.mock.calls[0]?.[0] ?? "")).toContain(
      "INSERT INTO platform_overview_daily_summary",
    );
    expect(String(dbQuery.mock.calls[1]?.[0] ?? "")).toContain(
      "DELETE FROM platform_overview_summary_ranges",
    );
  });
});
