import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

describe("GET /api/launchpad/meta/adsets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
  });

  it("returns active ad sets in a campaign with ad count and 7d aggregates", async () => {
    const sql = vi.fn(async () => [
      {
        id: "adset_1",
        name: "Prospecting",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        optimization_goal: "OFFSITE_CONVERSIONS",
        billing_event: "IMPRESSIONS",
        pixel_id: "pixel_1",
        custom_event_type: "PURCHASE",
        daily_budget: 25,
        lifetime_budget: null,
        attribution_spec: [
          { event_type: "CLICK_THROUGH", window_days: 7 },
          { event_type: "VIEW_THROUGH", window_days: 1 },
        ],
        targeting: {
          geo_locations: { countries: ["US", "CA"] },
          age_min: 21,
          age_max: 55,
          targeting_automation: { advantage_audience: 1 },
        },
        current_ad_count: 8,
        last_7d_spend: 400,
        last_7d_roas: 2.5,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}&campaignId=cmp_1`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.adsets[0]).toMatchObject({
      id: "adset_1",
      pixelId: "pixel_1",
      currentAdCount: 8,
      last7dSpend: 400,
      last7dRoas: 2.5,
      dailyBudgetMinor: 2500,
      targeting: {
        geoCountries: ["US", "CA"],
        ageMin: 21,
        ageMax: 55,
        advantageAudience: true,
      },
    });
    expect(body.adsets[0].attributionSpec).toEqual([
      { event_type: "CLICK_THROUGH", window_days: 7 },
      { event_type: "VIEW_THROUGH", window_days: 1 },
    ]);
  });

  it("requires a campaign id", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}`),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("missing_campaign_id");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });
});
