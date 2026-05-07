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

describe("GET /api/launchpad/meta/recent-ad-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
  });

  it("returns recent duplicated ad markers with target names from the action log fallback", async () => {
    const sql = vi.fn(async () => [
      {
        action: "launch_ad",
        requested_at: "2026-05-06T12:00:00.000Z",
        ad_id: "source_ad_1",
        creative_id: null,
        resulting_ad_id: "new_ad_1",
        payload_request: {
          target_campaign_id: "cmp_1",
          target_campaign_name: "Main Campaign",
          target_adset_id: "adset_1",
          target_adset_name: "Main Ad Set",
          body: {
            name: "Creative added",
            source_creative_id: "creative_1",
            status_option: "PAUSED",
          },
        },
        ad_name_current: null,
        ad_name_historical: null,
        ad_status: null,
        dim_creative_id: null,
        source_ad_name_current: "Creative Original",
        source_ad_name_historical: null,
        source_dim_creative_id: "creative_1",
        provider_account_id: "act_123",
        campaign_id: null,
        campaign_name_current: null,
        campaign_name_historical: null,
        adset_id: null,
        adset_name_current: null,
        adset_name_historical: null,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/recent-ad-actions?businessId=${BUSINESS_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.actions).toEqual([
      {
        action: "launch_ad",
        requestedAt: "2026-05-06T12:00:00.000Z",
        sourceAdId: "source_ad_1",
        sourceName: "Creative Original",
        resultingAdId: "new_ad_1",
        creativeId: "creative_1",
        adName: "Creative added",
        status: "PAUSED",
        accountId: "act_123",
        targetCampaignId: "cmp_1",
        targetCampaignName: "Main Campaign",
        targetAdsetId: "adset_1",
        targetAdsetName: "Main Ad Set",
      },
    ]);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: BUSINESS_ID,
      minRole: "collaborator",
    });
  });
});
