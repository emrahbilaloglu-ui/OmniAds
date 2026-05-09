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
});
