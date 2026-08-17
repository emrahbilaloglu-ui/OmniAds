import { describe, expect, it } from "vitest";
import type {
  BudgetCampaign,
} from "@/components/google-ads/BudgetScalingTab";
import type { Campaign } from "@/components/google-ads/google-ads-dashboard-support";
import {
  buildGoogleOverviewExactModel,
  type GoogleOverviewExactAdapterInput,
} from "@/components/google-ads/google-overview-exact-adapter";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "pmax",
    name: "PMax — Evergreen",
    status: "ENABLED",
    channel: "Performance Max",
    impressions: 100_000,
    clicks: 4_000,
    ctr: 4,
    cpc: 2,
    conversionRate: 5,
    spend: 18_940,
    revenue: 71_180,
    conversions: 902,
    roas: 3.76,
    cpa: 21,
    impressionShare: null,
    lostIsBudget: null,
    spendShare: 46,
    revenueShare: 45,
    actionState: "scale",
    roasChange: null,
    spendChange: null,
    ...overrides,
  };
}

function budgetCampaign(overrides: Partial<BudgetCampaign> = {}): BudgetCampaign {
  return {
    id: "pmax",
    name: "PMax — Evergreen",
    dailyBudget: 700,
    spend: 18_940,
    conversions: 902,
    revenue: 71_180,
    roas: 3.76,
    cpa: 21,
    impressions: 100_000,
    clicks: 4_000,
    impressionShare: null,
    lostIsBudget: null,
    ...overrides,
  };
}

function nativeBudgetRecommendation(
  contractSource: "native" | "compatibility_derived" = "native",
  netDelta = 0,
): GoogleRecommendation {
  return {
    id: "budget-native",
    title: "Reallocate budget to proven demand",
    summary: "Move daily budget without adding net spend.",
    type: "budget_reallocation",
    strategyLayer: "Budget Moves",
    decisionFamily: "growth_unlock",
    priority: "high",
    blockers: [],
    integrityState: "ready",
    rankExplanation: "$200/day can move to stronger demand.",
    whyNow: "The bounded preview is ready.",
    confidenceExplanation: "Native account evidence.",
    operatorActionCard: {
      contractVersion: "google_ads_advisor_action_v2",
      contractSource,
      assistMode: "deterministic",
      recommendationType: "budget_reallocation",
      primaryAction: "Review the bounded reallocation",
      scope: { level: "account", label: "Account" },
      exactChanges: [],
      exactChangePayload: {
        kind: "budget_reallocation",
        sourceCampaigns: [
          {
            id: "shopping",
            name: "Shopping — Core feed",
            previousAmount: 380,
            proposedAmount: 180,
            deltaAmount: -200,
            deltaPercent: -52.6,
          },
        ],
        destinationCampaigns: [
          {
            id: "brand",
            name: "Search — Brand",
            previousAmount: 50,
            proposedAmount: 170,
            deltaAmount: 120,
            deltaPercent: 240,
          },
          {
            id: "non-brand",
            name: "Search — Non-brand",
            previousAmount: 370,
            proposedAmount: 450,
            deltaAmount: 80,
            deltaPercent: 21.6,
          },
        ],
        budgetBand: "$200/day",
        estimateMode: "bounded_preview",
        netDelta,
      },
      expectedEffect: {
        summary: "Budget-neutral reallocation.",
        estimationMode: "bounded_range",
        note: "No net budget added.",
      },
      whyThisNow: "Bounded provider budgets support this preview.",
      evidence: [],
      validation: [],
      rollback: [],
      blockedBecause: [],
    },
  } as unknown as GoogleRecommendation;
}

function input(
  overrides: Partial<GoogleOverviewExactAdapterInput> = {},
): GoogleOverviewExactAdapterInput {
  return {
    identity: { businessId: "business-1", providerAccountId: "493-118-2201" },
    currencyCode: "USD",
    window: { label: "28d", days: 28 },
    freshness: { label: "Synced 26m ago", state: "fresh" },
    summary: {
      kpis: {
        spend: 41_220,
        revenue: 156_480,
        conversions: 1_982,
        roas: 3.8,
        cpa: 20.8,
        cpc: 1.42,
        ctr: 4.6,
        impressions: 632_000,
        clicks: 29_100,
        convRate: 6.8,
      },
      kpiDeltas: { spend: 6.4, revenue: 9.8, roas: 0, conversions: 7.9 },
      summary: {
        totalAccounts: 1,
        readSource: "warehouse_account_aggregate",
      },
      meta: {
        dataState: "ready",
        isPartial: false,
        partial: false,
        row_counts: { account_daily: 28 },
        readSource: "warehouse_account_aggregate",
      },
    },
    currentTrends: {
      points: [
        {
          date: "2026-07-18",
          spend: 100,
          revenue: 380,
          conversions: 5,
          roas: 3.8,
          cpa: 20,
          ctr: 4,
          cpc: 1.25,
          impressions: 2_500,
          clicks: 100,
        },
        {
          date: "2026-07-19",
          spend: 200,
          revenue: 800,
          conversions: 10,
          roas: 4,
          cpa: 20,
          ctr: 5,
          cpc: 2,
          impressions: 4_000,
          clicks: 200,
        },
      ],
    },
    previousTrends: {
      points: [
        {
          date: "2026-06-20",
          spend: 80,
          revenue: 300,
          conversions: 4,
          roas: 3.75,
          cpa: 20,
          ctr: 4,
          cpc: 1,
          impressions: 2_000,
          clicks: 80,
        },
        {
          date: "2026-06-21",
          spend: 150,
          revenue: 600,
          conversions: 8,
          roas: 4,
          cpa: 18.75,
          ctr: 4,
          cpc: 1.875,
          impressions: 4_000,
          clicks: 160,
        },
      ],
    },
    campaigns: [
      campaign(),
      campaign({
        id: "shopping",
        name: "Shopping — Core feed",
        channel: "Shopping",
        spend: 5_000,
        revenue: 14_100,
        roas: 2.82,
        conversions: 207,
        spendShare: 12,
        impressionShare: 0.38,
      }),
      campaign({
        id: "brand",
        name: "Search — Brand",
        channel: "Search",
        spend: 4_870,
        revenue: 28_660,
        roas: 5.88,
        conversions: 312,
        spendShare: 12,
        impressionShare: 0.71,
        lostIsBudget: 0.22,
      }),
    ],
    advisorRecommendations: [nativeBudgetRecommendation()],
    budgetCampaigns: [
      budgetCampaign(),
      budgetCampaign({
        id: "shopping",
        name: "Shopping — Core feed",
        dailyBudget: 180,
        spend: 5_000,
        lostIsBudget: null,
      }),
      budgetCampaign({
        id: "brand",
        name: "Search — Brand",
        dailyBudget: 170,
        spend: 4_870,
        lostIsBudget: 0.22,
      }),
    ],
    targets: { roas: 3.8, breakevenRoas: 2.5 },
    ...overrides,
  };
}

describe("buildGoogleOverviewExactModel", () => {
  it("keeps the canonical order and fixed presentation shells", () => {
    const model = buildGoogleOverviewExactModel(input());

    expect(model.hero.map((item) => item.label)).toEqual([
      "Spend · 28d",
      "Conv value",
      "ROAS",
      "Conversions",
    ]);
    expect(model.secondary.map((item) => item.label)).toEqual([
      "CPA",
      "CPC",
      "CTR",
      "Conv rate",
      "Impressions",
      "Clicks",
    ]);
    expect(model.lookCards).toHaveLength(4);
    expect(model.lookCards[0]).toMatchObject({ severity: "—", tone: "neutral" });
    expect(model.budgetKpis.map((item) => item.label)).toEqual([
      "Ready to scale",
      "Budget-limited",
      "Low-efficiency spend",
      "Suggested net shift",
    ]);
    expect(model.budgetRecommendations).toHaveLength(3);
    expect(model.budgetNote).toBe("—");
  });

  it("uses actual served spend share for the bar and channel-specific type tones", () => {
    const model = buildGoogleOverviewExactModel(input());

    expect(model.campaigns[0]).toMatchObject({
      dailyBudget: "$700/day",
      spendShare: "46%",
      spendShareWidth: 46,
      typeTone: "info",
      roasTone: "neutral",
      pulse: "—",
    });
    expect(model.campaigns[1]?.typeTone).toBe("auto");
    expect(model.campaigns[1]?.roasTone).toBe("warning");
    expect(model.campaigns[2]?.typeTone).toBe("neutral");
    expect(model.campaigns[2]?.roasTone).toBe("positive");
  });

  it("preserves sub-one served spend shares as percentage points", () => {
    const source = input();
    source.campaigns = [campaign({ spendShare: 0.46 })];

    const model = buildGoogleOverviewExactModel(source);

    expect(model.campaigns[0]).toMatchObject({
      spendShare: "0%",
      spendShareWidth: 0.46,
    });
  });

  it("renders only native bounded budget action-contract values", () => {
    const model = buildGoogleOverviewExactModel(input());

    expect(model.budgetKpis.map((item) => item.value)).toEqual([
      "2",
      "1",
      "$5,000",
      "$200/day",
    ]);
    expect(model.budgetRecommendations.map((item) => item.amount)).toEqual([
      "+$120/day",
      "+$80/day",
      "−$200/day",
    ]);
    expect(model.budgetRecommendations[0]?.reason).toBe(
      "Bounded provider budgets support this preview.",
    );
  });

  it("fails closed for compatibility-derived budget recommendations and partial source spend", () => {
    const compatibilityModel = buildGoogleOverviewExactModel(
      input({ advisorRecommendations: [nativeBudgetRecommendation("compatibility_derived")] }),
    );
    expect(compatibilityModel.budgetRecommendations.every((item) => item.amount === "—")).toBe(true);
    expect(compatibilityModel.budgetKpis[0]?.value).toBe("—");
    expect(compatibilityModel.budgetKpis[3]?.value).toBe("—");

    const staleContract = nativeBudgetRecommendation();
    if (staleContract.operatorActionCard) {
      (staleContract.operatorActionCard as { contractVersion: string }).contractVersion =
        "google_ads_advisor_action_v1";
    }
    const staleContractModel = buildGoogleOverviewExactModel(
      input({ advisorRecommendations: [staleContract] }),
    );
    expect(staleContractModel.budgetRecommendations.every((item) => item.amount === "—")).toBe(
      true,
    );

    const partialModel = buildGoogleOverviewExactModel(
      input({
        budgetCampaigns: [
          budgetCampaign({
            id: "shopping",
            name: "Shopping — Core feed",
            spend: Number.NaN,
          }),
        ],
      }),
    );
    expect(partialModel.budgetKpis[2]?.value).toBe("—");
  });

  it("fails closed for any nonzero net budget delta, including near-zero values", () => {
    const model = buildGoogleOverviewExactModel(
      input({ advisorRecommendations: [nativeBudgetRecommendation("native", 0.001)] }),
    );

    expect(model.budgetRecommendations.every((item) => item.amount === "—")).toBe(true);
    expect(model.budgetKpis[0]?.value).toBe("—");
    expect(model.budgetKpis[3]?.value).toBe("—");
    expect(model.budgetNote).toBe("—");
  });

  it("withholds empty and partial summary payloads but preserves a proven measured zero", () => {
    const zeroKpis = {
      spend: 0,
      revenue: 0,
      conversions: 0,
      roas: 0,
      cpa: 0,
      cpc: 0,
      ctr: 0,
      impressions: 0,
      clicks: 0,
      convRate: 0,
    };
    const completeZero = buildGoogleOverviewExactModel(
      input({
        summary: {
          kpis: zeroKpis,
          kpiDeltas: undefined,
          summary: {
            totalAccounts: 1,
            readSource: "warehouse_account_aggregate",
          },
          meta: {
            dataState: "ready",
            isPartial: false,
            partial: false,
            row_counts: { account_daily: 1 },
          },
        },
      }),
    );
    expect(completeZero.hero.map((item) => item.value)).toEqual(["$0", "$0", "0.00", "0"]);
    expect(completeZero.secondary.map((item) => item.value)).toEqual([
      "$0.00",
      "$0.00",
      "0.0%",
      "0.0%",
      "0",
      "0",
    ]);

    for (const summary of [
      {
        kpis: zeroKpis,
        kpiDeltas: undefined,
        summary: {
          totalAccounts: 0,
          readSource: "warehouse_account_aggregate" as const,
        },
        meta: {
          dataState: "ready" as const,
          isPartial: false,
          partial: false,
          row_counts: { account_daily: 0 },
        },
      },
      {
        kpis: zeroKpis,
        kpiDeltas: undefined,
        summary: {
          totalAccounts: 1,
          readSource: "warehouse_account_aggregate" as const,
        },
        meta: {
          dataState: "partial" as const,
          isPartial: true,
          partial: true,
          row_counts: { account_daily: 1 },
        },
      },
    ]) {
      const withheld = buildGoogleOverviewExactModel(input({ summary }));
      expect(withheld.hero.every((item) => item.value === "—")).toBe(true);
      expect(withheld.secondary.every((item) => item.value === "—")).toBe(true);
    }
  });

  it("counts active campaigns from the full response while keeping four visible rows", () => {
    const rows = [
      campaign({ id: "1" }),
      campaign({ id: "2" }),
      campaign({ id: "3" }),
      campaign({ id: "4" }),
      campaign({ id: "5" }),
    ];
    const model = buildGoogleOverviewExactModel(input({ campaigns: rows }));

    expect(model.campaigns).toHaveLength(4);
    expect(model.campaignSummary).toMatch(/^5 active ·/);
  });

  it("preserves explicit null authority and uses dashes instead of prototype values", () => {
    const model = buildGoogleOverviewExactModel(
      input({
        identity: { businessId: "business-1", providerAccountId: null },
        currencyCode: null,
        summary: null,
        currentTrends: null,
        previousTrends: null,
        campaigns: null,
        advisorRecommendations: null,
        budgetCampaigns: null,
        targets: undefined,
      }),
    );

    expect(model.identity.providerAccountId).toBe("—");
    expect(model.identity.currencyCode).toBe("—");
    expect(model.hero.every((item) => item.value === "—")).toBe(true);
    expect(model.secondary.every((item) => item.value === "—")).toBe(true);
    expect(model.lookCards.every((item) => item.severity === "—")).toBe(true);
    expect(model.campaigns).toEqual([]);
    expect(model.budgetRecommendations.every((item) => item.amount === "—")).toBe(true);
    expect(JSON.stringify(model)).not.toContain("Evergreen");
  });
});
