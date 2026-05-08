import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

const db = await import("@/lib/db");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const requestModelStore = await import("@/lib/meta/request-model-store");

describe("meta request model store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-17T00:00:00.000Z",
    });
  });

  it("reads campaign config history objective from campaign history rows", async () => {
    let queryText = "";
    const query = vi.fn(async (text: string) => {
      queryText = text;
      return [
        {
          entity_id: "cmp-1",
          objective: "OUTCOME_SALES",
          optimization_goal: "OFFSITE_CONVERSIONS",
          bid_strategy_type: "cost_cap",
          bid_strategy_label: "Cost Cap",
          manual_bid_amount: 12,
          bid_value: 12,
          bid_value_format: "currency",
          daily_budget: 150,
          lifetime_budget: null,
          is_budget_mixed: false,
          is_config_mixed: false,
          is_optimization_goal_mixed: false,
          is_bid_strategy_mixed: false,
          is_bid_value_mixed: false,
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const rows = await requestModelStore.readLatestMetaCampaignConfigHistory({
      businessId: "biz-1",
      campaignIds: ["cmp-1"],
    });

    expect(queryText).toContain("objective,");
    expect(queryText).toContain("JOIN LATERAL");
    expect(queryText).not.toContain("ROW_NUMBER()");
    expect(rows.get("cmp-1")).toMatchObject({
      objective: "OUTCOME_SALES",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      bidStrategyType: "cost_cap",
    });
  });

  it("uses a null objective projection for adset config history rows", async () => {
    let queryText = "";
    const query = vi.fn(async (text: string) => {
      queryText = text;
      return [
        {
          entity_id: "adset-1",
          objective: null,
          optimization_goal: "OFFSITE_CONVERSIONS",
          bid_strategy_type: "lowest_cost_without_cap",
          bid_strategy_label: "Lowest Cost",
          manual_bid_amount: null,
          bid_value: 2.5,
          bid_value_format: "roas",
          daily_budget: 120,
          lifetime_budget: null,
          is_budget_mixed: false,
          is_config_mixed: false,
          is_optimization_goal_mixed: false,
          is_bid_strategy_mixed: false,
          is_bid_value_mixed: false,
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const rows = await requestModelStore.readLatestMetaAdSetConfigHistory({
      businessId: "biz-1",
      adsetIds: ["adset-1"],
    });

    expect(queryText).toContain("NULL::text AS objective");
    expect(queryText).toContain("JOIN LATERAL");
    expect(queryText).not.toContain("ROW_NUMBER()");
    expect(rows.get("adset-1")).toMatchObject({
      objective: null,
      optimizationGoal: "OFFSITE_CONVERSIONS",
      bidValue: 2.5,
      bidValueFormat: "roas",
    });
  });

  it("reads previous campaign config diffs with lateral lookups", async () => {
    let queryText = "";
    const query = vi.fn(async (text: string) => {
      queryText = text;
      return [
        {
          entity_id: "cmp-1",
          previous_bid_captured_at: "2026-04-01T00:00:00.000Z",
          previous_bid_manual_bid_amount: 10,
          previous_bid_value: 10,
          previous_bid_value_format: "currency",
          previous_budget_captured_at: "2026-04-02T00:00:00.000Z",
          previous_daily_budget: 100,
          previous_lifetime_budget: null,
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const rows = await requestModelStore.readPreviousDifferentMetaCampaignConfigHistoryDiffs({
      businessId: "biz-1",
      campaignIds: ["cmp-1"],
    });

    expect(queryText).toContain("LEFT JOIN LATERAL");
    expect(queryText).not.toContain("ORDER BY campaign_id ASC");
    expect(rows.get("cmp-1")).toMatchObject({
      previousManualBidAmount: 10,
      previousBidValue: 10,
      previousBidValueFormat: "currency",
      previousBidCapturedAt: "2026-04-01T00:00:00.000Z",
      previousDailyBudget: 100,
      previousBudgetCapturedAt: "2026-04-02T00:00:00.000Z",
    });
  });
});
