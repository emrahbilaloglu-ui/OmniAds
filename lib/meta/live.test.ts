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
  getMetaLiveCampaignRowsWithReceipt,
  getMetaLiveSummaryWithReceipt,
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

  it("uses only source-backed previous comparisons on the current live path", async () => {
    const accountToday = new Date().toISOString().slice(0, 10);
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
      startDate: accountToday,
      endDate: accountToday,
      providerAccountIds: ["act_1"],
      includePrev: true,
    });

    expect(configSnapshots.readLatestMetaConfigSnapshots).not.toHaveBeenCalled();
    expect(configSnapshots.readPreviousDifferentMetaConfigDiffs).toHaveBeenCalledTimes(1);
  });

  it("keeps current provider fields when optional previous comparisons cannot be read", async () => {
    const accountToday = new Date().toISOString().slice(0, 10);
    vi.mocked(configSnapshots.readPreviousDifferentMetaConfigDiffs)
      .mockRejectedValueOnce(new Error("comparison unavailable"));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({
      data: url.includes("/insights")
        ? [{ campaign_id: "cmp-1", spend: "10", impressions: "100" }]
        : url.includes("/campaigns")
          ? [{ id: "cmp-1", objective: "OUTCOME_SALES", status: "ACTIVE" }]
          : [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rows = await getMetaLiveCampaignRows({
      businessId: "biz-1",
      startDate: accountToday,
      endDate: accountToday,
      providerAccountIds: ["act_1"],
      includePrev: true,
    });

    expect(rows[0]).toMatchObject({
      objective: "OUTCOME_SALES",
      previousDailyBudget: null,
      previousBudgetCapturedAt: null,
    });
    expect(warning).toHaveBeenCalledWith("[meta-live] previous_config_read_failed", {
      message: "comparison unavailable",
    });
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

  it("keeps current Insights but marks config unavailable when account timezone is unknown", async () => {
    vi.mocked(api.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: { act_1: { currency: "USD", timezone: null, name: "Account 1" } },
    } as never);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ campaign_id: "cmp-1", spend: "10", impressions: "100" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const read = await getMetaLiveCampaignRowsWithReceipt({
      businessId: "biz-1",
      startDate: new Date().toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
      providerAccountIds: ["act_1"],
      expectedCurrentDay: true,
    });
    expect(read.rows[0]).toMatchObject({ spend: 10, objective: null });
    expect(read.configPartial).toBe(true);
    expect(read.configNotReadyReason).toContain("act_1:timezone");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("summarizes live campaign bid fields from ad set configs when campaign config is sparse", async () => {
    const accountToday = new Date().toISOString().slice(0, 10);
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
      startDate: accountToday,
      endDate: accountToday,
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

    const callsBeforeHistorical = fetchMock.mock.calls.length;
    const historicalRows = await getMetaLiveCampaignRows({
      businessId: "biz-1",
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      providerAccountIds: ["act_1"],
      includePrev: true,
    });
    expect(historicalRows[0]).toMatchObject({
      objective: null,
      optimizationGoal: null,
      bidStrategyType: null,
      dailyBudget: null,
    });
    expect(fetchMock.mock.calls.slice(callsBeforeHistorical).every(([url]) =>
      url.includes("/insights"),
    )).toBe(true);
  });

  it.each(["campaigns", "adsets", "insights"])(
    "does not treat an incomplete %s page as complete",
    async (endpoint) => {
      const accountToday = new Date().toISOString().slice(0, 10);
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes(`/${endpoint}`) && url.includes("page=2")) {
          return new Response("{}", { status: 503 });
        }
        const data = url.includes("/insights")
          ? [{ campaign_id: "cmp-1", spend: "10", impressions: "100" }]
          : url.includes("/campaigns")
            ? [{ id: "cmp-1", objective: "OUTCOME_SALES" }]
            : [{ id: "as-1", campaign_id: "cmp-1", optimization_goal: "OFFSITE_CONVERSIONS" }];
        return new Response(JSON.stringify({
          data,
          ...(url.includes(`/${endpoint}`)
            ? { paging: { next: `https://graph.facebook.com/v25.0/act_1/${endpoint}?page=2` } }
            : {}),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }));

      const input = {
        businessId: "biz-1",
        startDate: accountToday,
        endDate: accountToday,
        providerAccountIds: ["act_1"],
      };
      if (endpoint === "insights") {
        await expect(getMetaLiveCampaignRowsWithReceipt(input))
          .rejects.toThrow("Meta campaign insights page 2 failed with HTTP 503");
        return;
      }
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const read = await getMetaLiveCampaignRowsWithReceipt(input);
      expect(read.rows).toHaveLength(1);
      expect(read.rows[0]?.spend).toBe(10);
      expect(read.configPartial).toBe(true);
      expect(read.configNotReadyReason).toContain(`act_1:${endpoint}`);
      expect(read.rows[0]?.objective).toBe(endpoint === "campaigns" ? null : "OUTCOME_SALES");
      expect(warning).toHaveBeenCalledWith(
        endpoint === "campaigns"
          ? "[meta-live] campaign_config_unavailable"
          : "[meta-live] adset_config_unavailable",
        expect.objectContaining({ accountId: "act_1" }),
      );
      const summary = await getMetaLiveSummaryWithReceipt(input);
      expect(summary.totals).toMatchObject({ spend: 10, impressions: 100 });
      expect(summary.configPartial).toBe(true);
    },
  );

  it("paginates insight metrics and tolerates absent optional config fields", async () => {
    const accountToday = new Date().toISOString().slice(0, 10);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(JSON.stringify(url.includes("page=2")
          ? { data: [{ campaign_id: "cmp-2", spend: "20", impressions: "200" }] }
          : {
              data: [{ campaign_id: "cmp-1", spend: "10", impressions: "100" }],
              paging: { next: "https://graph.facebook.com/v25.0/act_1/insights?page=2" },
            }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/campaigns")) {
        return new Response(JSON.stringify({ data: [
          { id: "cmp-1", objective: "OUTCOME_SALES", status: "ACTIVE" },
          { id: "cmp-2", objective: "OUTCOME_LEADS", status: "ACTIVE" },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const read = await getMetaLiveCampaignRowsWithReceipt({
      businessId: "biz-1",
      startDate: accountToday,
      endDate: accountToday,
      providerAccountIds: ["act_1"],
    });
    expect(read.rows.map((row) => [row.id, row.spend, row.objective, row.dailyBudget])).toEqual([
      ["cmp-2", 20, "OUTCOME_LEADS", null],
      ["cmp-1", 10, "OUTCOME_SALES", null],
    ]);
    expect(read.configPartial).toBe(false);
    expect(read.configNotReadyReason).toBeNull();
  });

  it("treats absent credentials as an unavailable live read", async () => {
    vi.mocked(api.resolveMetaCredentials).mockResolvedValue(null);
    await expect(getMetaLiveCampaignRows({
      businessId: "biz-1",
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      providerAccountIds: ["act_1"],
    })).rejects.toThrow("Meta live campaign credentials are unavailable");
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
