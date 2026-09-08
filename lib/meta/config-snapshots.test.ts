import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();
const query = vi.fn();
Object.assign(sql, { query });

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(),
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

const db = await import("@/lib/db");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const configSnapshots = await import("@/lib/meta/config-snapshots");

describe("meta config snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
    query.mockResolvedValue([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    const readyResult = {
      ready: true,
      missingTables: [],
      checkedAt: "2026-05-09T00:00:00.000Z",
    };
    vi.mocked(schemaReadiness.assertDbSchemaReady).mockResolvedValue(readyResult);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue(readyResult);
  });

  it("writes canonical business and provider refs", async () => {
    await configSnapshots.appendMetaConfigSnapshots([
      {
        businessId: "biz-1",
        accountId: "act_1",
        entityLevel: "campaign",
        entityId: "cmp_1",
        payload: {
          optimizationGoal: null,
          bidStrategyType: null,
          bidStrategyLabel: null,
          manualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          dailyBudget: null,
          lifetimeBudget: null,
        },
      },
    ]);

    const queryText = String(sql.mock.calls[0]?.[0]?.join(" ") ?? "");
    expect(queryText).toContain("business_ref_id");
    expect(queryText).toContain("provider_account_ref_id");
    expect(queryText).toContain("business_ref_id uuid");
    expect(queryText).toContain("provider_account_ref_id uuid");
  });

  it("reads latest snapshots with per-entity index lookups instead of a global window sort", async () => {
    let queryText = "";
    let queryParams: unknown[] = [];
    query.mockImplementation(async (text: string, params?: unknown[]) => {
      queryText = text;
      queryParams = params ?? [];
      return [
        {
          entity_id: "cmp-1",
          payload: { bidStrategyType: "lowest_cost_without_cap" },
        },
      ];
    });

    const rows = await configSnapshots.readLatestMetaConfigSnapshots({
      businessId: "biz-1",
      entityLevel: "campaign",
      entityIds: ["cmp-1", "cmp-1"],
    });

    expect(queryText).toContain("JOIN LATERAL");
    expect(queryText).toContain("LIMIT 1");
    expect(queryText).not.toContain("ROW_NUMBER()");
    expect(queryParams).toEqual(["biz-1", "campaign", ["cmp-1"]]);
    expect(rows.get("cmp-1")).toMatchObject({
      bidStrategyType: "lowest_cost_without_cap",
    });
  });

  it("reads previous informative snapshots with a bounded per-entity lookup", async () => {
    let queryText = "";
    query.mockImplementation(async (text: string) => {
      queryText = text;
      return [
        {
          entity_id: "adset-1",
          payload: { bidValue: 2.5, bidValueFormat: "roas" },
        },
      ];
    });

    const rows = await configSnapshots.readPreviousMetaConfigSnapshots({
      businessId: "biz-1",
      entityLevel: "adset",
      entityIds: ["adset-1"],
    });

    expect(queryText).toContain("JOIN LATERAL");
    expect(queryText).toContain("OFFSET 1");
    expect(queryText).toContain("LIMIT 1");
    expect(queryText).not.toContain("ROW_NUMBER()");
    expect(rows.get("adset-1")).toMatchObject({
      bidValue: 2.5,
      bidValueFormat: "roas",
    });
  });

  it("reads previous different config diffs without globally sorting snapshot history", async () => {
    let queryText = "";
    /*
      ROUND 10 ITEM 4. The reader now resolves the ACCOUNT's IANA timezone
      first, through `getDb().query(...)`, and answers with an empty map if it
      cannot — so the mock has to serve that read for this case to reach the
      history SQL at all. That fail-closed path is asserted in its own case.
    */
    (sql as unknown as { query: unknown }).query = vi.fn(async () => [
      { timezone: "America/Los_Angeles" },
    ]);
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      queryText = strings.join(" ");
      return [
        {
          entity_id: "cmp-1",
          previous_bid_captured_at: "2026-05-08T00:00:00.000Z",
          previous_bid_payload: {
            bidValue: 12,
            bidValueFormat: "currency",
            manualBidAmount: 12,
          },
          previous_budget_captured_at: "2026-05-07T00:00:00.000Z",
          previous_budget_payload: {
            dailyBudget: 100,
            lifetimeBudget: null,
          },
        },
      ];
    });

    const rows = await configSnapshots.readPreviousDifferentMetaConfigDiffs({
      businessId: "biz-1",
      entityLevel: "campaign",
      entityIds: ["cmp-1", "cmp-1"],
    });

    expect(queryText).toContain("WITH requested_entities");
    expect(queryText).toContain("LEFT JOIN LATERAL");
    expect(queryText).toContain("previous_bid");
    expect(queryText).toContain("previous_budget");
    expect(queryText).toContain("LIMIT 1");
    expect(queryText).not.toContain("ORDER BY entity_id ASC");
    expect(rows.get("cmp-1")).toMatchObject({
      previousManualBidAmount: 12,
      previousBidValue: 12,
      previousBidValueFormat: "currency",
      previousBidCapturedAt: "2026-05-08T00:00:00.000Z",
      previousDailyBudget: 100,
      previousBudgetCapturedAt: "2026-05-07T00:00:00.000Z",
    });
  });

  it("summarizes bid regime history in SQL without returning every payload row", async () => {
    let queryText = "";
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      queryText = strings.join(" ");
      return [
        {
          entity_id: "cmp-1",
          bid_strategy_type: "lowest_cost",
          bid_strategy_label: "Lowest cost",
          observation_count: 3,
        },
        {
          entity_id: "cmp-1",
          bid_strategy_type: "bid_cap",
          bid_strategy_label: "Bid cap",
          observation_count: 1,
        },
      ];
    });

    const rows = await configSnapshots.readMetaBidRegimeHistorySummaries({
      businessId: "biz-1",
      // ROUND 9 ITEM 6: account + cutoff are required; an unscoped history
      // could raise confidence from another account or a later day.
      providerAccountId: "act_1",
      capturedAtCutoff: "2026-09-05",
      entityLevel: "campaign",
      entityIds: ["cmp-1"],
    });
    // The bound is an absolute instant, never `(date + 1)` — that form is cast
    // with the DB SESSION timezone rather than the advertiser's.
    expect(queryText).toContain("::timestamptz");
    expect(queryText).not.toContain("::date + 1");

    expect(queryText).toContain("COUNT(*)::int AS observation_count");
    expect(queryText).toContain("GROUP BY entity_id, payload->>'bidStrategyType', payload->>'bidStrategyLabel'");
    expect(queryText).not.toContain("ORDER BY");
    expect(queryText).not.toContain("SELECT entity_id, payload");
    expect(rows.get("cmp-1")).toMatchObject({
      dominantBidStrategyType: "lowest_cost",
      dominantBidStrategyLabel: "Lowest cost",
      observationCount: 4,
      constrainedShare: 0.25,
      openShare: 0.75,
    });
  });
});
