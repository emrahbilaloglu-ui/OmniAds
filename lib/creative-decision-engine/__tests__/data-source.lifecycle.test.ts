import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    query,
  }),
}));

const { ENGINE_VERSION, WarehouseDataSource } = await import("..");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const AS_OF = "2026-05-04";

function freshTimestamp() {
  return new Date().toISOString();
}

function lifecycleRow(creativeId: string, spend = 123) {
  return {
    creative_id: creativeId,
    creative_name: `Lifecycle ${creativeId}`,
    campaign_id: "campaign_1",
    objective: "OUTCOME_SALES",
    spend,
    purchases: 3,
    purchase_value: 300,
    impressions: 1000,
    link_clicks: 50,
    roas: 3,
    cpa: 25,
    ctr: 1.5,
    frequency: 1.2,
    recent_spend: 30,
    recent_purchases: 1,
    recent_roas: 2.5,
    recent_impressions: 250,
    effective_status: "ACTIVE",
    age_days: 20,
    last_active_date: AS_OF,
    source_max_updated_at: freshTimestamp(),
    data_freshness_hours: 0,
    fatigue_status: "none",
    lifecycle_position: "plateau",
    days_since_peak: 2,
    peak_roas_30d: 3.5,
    peak_confidence: 0.7,
    spend_trajectory_30d: "flat",
    spend_slope_7d: 0.2,
    spend_slope_30d: 0.4,
    roas_slope_7d: -0.01,
    roas_slope_30d: 0.02,
    cpm: 10,
    outbound_clicks: 45,
    landing_page_views: 40,
    add_to_cart: 8,
    initiate_checkout: 4,
    thumbstop: 20,
    video25_rate: null,
    video50_rate: null,
    video75_rate: null,
    video100_rate: null,
    quality_ranking: "average",
    engagement_rate_ranking: "average",
    conversion_rate_ranking: "average",
    creative_format: "image",
    target_roas: 2,
    break_even_roas: 1.5,
  };
}

function runtimeRow(creativeId: string, spend = 45) {
  return {
    creative_id: creativeId,
    creative_name: `Runtime ${creativeId}`,
    campaign_id: "campaign_2",
    objective: "OUTCOME_SALES",
    spend,
    purchases: 1,
    purchase_value: 90,
    impressions: 500,
    link_clicks: 20,
    roas: 2,
    cpa: 45,
    ctr: 1.1,
    frequency: 1,
    recent_spend: 15,
    recent_purchases: 1,
    recent_roas: 2,
    recent_impressions: 150,
    effective_status: "ACTIVE",
    age_days: 12,
    last_spend_date: AS_OF,
    policy_reason: null,
    data_freshness_hours: 0,
    target_roas: 2,
    break_even_roas: 1.5,
    cpm: 9,
    outbound_clicks: 20,
    landing_page_views: 18,
    add_to_cart: 3,
    initiate_checkout: 1,
    thumbstop: 12,
    creative_format: "image",
  };
}

describe("WarehouseDataSource lifecycle hydration", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("hydrates lifecycle rows only for the current engine version", async () => {
    query.mockResolvedValueOnce([lifecycleRow("creative-a")]);

    const warehouse = new WarehouseDataSource();
    const inputs = await warehouse.listCreativeInputs({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      creativeIds: ["creative-a"],
    });

    expect(inputs.map((input) => input.creativeId)).toEqual(["creative-a"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("l.engine_version = $5");
    expect(query.mock.calls[0]?.[1]).toEqual([
      BUSINESS_ID,
      AS_OF,
      ["creative-a"],
      true,
      ENGINE_VERSION,
    ]);
  });

  it("fills missing requested creatives from runtime SQL when lifecycle is partial", async () => {
    query.mockImplementation(async (queryText: string, params: unknown[]) => {
      if (queryText.includes("FROM engine_v3_creative_lifecycle_daily l")) {
        return [lifecycleRow("creative-a", 123)];
      }
      if (queryText.includes("FROM meta_creative_daily")) {
        expect(params[2]).toEqual(["creative-b"]);
        return [runtimeRow("creative-b", 45)];
      }
      return [];
    });

    const warehouse = new WarehouseDataSource();
    const inputs = await warehouse.listCreativeInputs({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      creativeIds: ["creative-a", "creative-b"],
    });

    expect(inputs.map((input) => input.creativeId)).toEqual([
      "creative-a",
      "creative-b",
    ]);
    expect(inputs[0]?.lifecyclePosition).toBe("plateau");
    expect(inputs[1]?.lifecyclePosition).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
