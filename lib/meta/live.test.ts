import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/meta", () => ({
  getAdSets: vi.fn(),
  resolveMetaCredentials: vi.fn(),
  resolveMetaCurrencyForAccount: vi.fn(),
}));

vi.mock("@/lib/meta/config-snapshots", () => ({
  readLatestMetaConfigSnapshots: vi.fn(),
  readPreviousDifferentMetaConfigDiffs: vi.fn(),
}));

const api = await import("@/lib/api/meta");
const configSnapshots = await import("@/lib/meta/config-snapshots");
const {
  getMetaCurrentDayLiveAvailability,
  getMetaLiveCampaignRows,
} = await import("@/lib/meta/live");

describe("meta live serving", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: {
        act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
      },
    });
    vi.mocked(api.resolveMetaCurrencyForAccount).mockImplementation(
      (credentials, accountId) =>
        credentials.accountProfiles[accountId]?.currency ??
        (credentials.accountIds[0] === accountId ? credentials.currency : null)
    );
    vi.mocked(configSnapshots.readLatestMetaConfigSnapshots).mockResolvedValue(new Map());
    vi.mocked(configSnapshots.readPreviousDifferentMetaConfigDiffs).mockResolvedValue(new Map());
  });

  it("keeps today/live snapshot helpers on the live path", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                spend: "10",
                ctr: "1",
                cpm: "5",
                impressions: "100",
                clicks: "1",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "cmp-1",
              name: "Campaign 1",
              objective: "OUTCOME_SALES",
              effective_status: "ACTIVE",
              status: "ACTIVE",
              daily_budget: "20",
              bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              bid_amount: "5",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await getMetaLiveCampaignRows({
      businessId: "biz-1",
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      providerAccountIds: ["act_1"],
      includePrev: true,
    });

    expect(configSnapshots.readLatestMetaConfigSnapshots).toHaveBeenCalledTimes(2);
    expect(configSnapshots.readPreviousDifferentMetaConfigDiffs).toHaveBeenCalledTimes(1);
  });

  it("keeps live campaign currency null when account currency is unavailable", async () => {
    vi.mocked(api.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1"],
      currency: null,
      accountProfiles: {
        act_1: { currency: null, timezone: "UTC", name: "Account 1" },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/insights")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  campaign_id: "cmp-1",
                  campaign_name: "Campaign 1",
                  spend: "10",
                  impressions: "100",
                  clicks: "1",
                  actions: [],
                  action_values: [],
                  purchase_roas: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );

    const rows = await getMetaLiveCampaignRows({
      businessId: "biz-1",
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      providerAccountIds: ["act_1"],
    });

    expect(rows[0]?.currency).toBeNull();
  });

  it("summarizes live campaign bid fields from ad set configs when campaign config is sparse", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                spend: "10",
                ctr: "1",
                cpm: "5",
                impressions: "100",
                clicks: "1",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                objective: "OUTCOME_SALES",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "20",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "adset-1",
              name: "Adset 1",
              campaign_id: "cmp-1",
              effective_status: "ACTIVE",
              status: "ACTIVE",
              optimization_goal: "omni_purchase",
              bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              bid_amount: "5",
              daily_budget: "10",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await getMetaLiveCampaignRows({
      businessId: "biz-1",
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      providerAccountIds: ["act_1"],
      includePrev: false,
    });

    expect(rows[0]).toMatchObject({
      objective: "OUTCOME_SALES",
      optimizationGoal: "Purchase",
      bidStrategyType: "bid_cap",
      bidStrategyLabel: "Bid Cap",
      manualBidAmount: 5,
      bidValue: 5,
      bidValueFormat: "currency",
    });
  });

  it("computes current-day live availability from actual live summary and campaign data", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                spend: "10",
                ctr: "1",
                cpm: "5",
                impressions: "100",
                clicks: "1",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "cmp-1",
              name: "Campaign 1",
              effective_status: "ACTIVE",
              status: "ACTIVE",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getMetaCurrentDayLiveAvailability({
        businessId: "biz-1",
        startDate: "2026-04-05",
        endDate: "2026-04-05",
        providerAccountIds: ["act_1"],
      })
    ).resolves.toEqual({
      summaryAvailable: true,
      campaignsAvailable: true,
    });
  });
});
