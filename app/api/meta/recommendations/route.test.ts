import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/recommendations/route";
import { assertMetaRecommendationsPageContract } from "@/lib/meta/page-route-contract.test-helpers";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: vi.fn(),
}));

vi.mock("@/lib/meta/breakdowns-source", () => ({
  getMetaBreakdownsForRange: vi.fn(async () => ({
    status: "ok",
    age: [],
    location: [],
    placement: [],
    budget: { campaign: [], adset: [] },
    audience: { available: false, reason: "n/a" },
    products: { available: false, reason: "n/a" },
    isPartial: false,
    notReadyReason: null,
  })),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(async () => ({
    status: "ok",
    rows: [],
    isPartial: false,
    notReadyReason: null,
  })),
}));

vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(async () => ({
    status: "ok",
    rows: [],
    isPartial: false,
    notReadyReason: null,
    evidenceSource: "live",
  })),
}));

vi.mock("@/lib/meta/adset-decisions", () => ({
  buildMetaAdsetRecommendations: vi.fn(() => []),
}));

vi.mock("@/lib/meta/config-snapshots", () => ({
  readMetaBidRegimeHistorySummaries: vi.fn(),
}));

vi.mock("@/lib/meta/recommendations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/recommendations")>();
  return {
    ...actual,
    buildMetaRecommendations: vi.fn(() => ({
      status: "ok",
      summary: {
        title: "Summary",
        summary: "Summary",
        primaryLens: "volume",
        confidence: "medium",
        recommendationCount: 1,
      },
      recommendations: [
        {
          id: "rec_1",
          level: "campaign",
          campaignId: "cmp_1",
          type: "budget_allocation",
          lens: "volume",
          priority: "high",
          confidence: "medium",
          decisionState: "act",
          decision: "increase budget",
          title: "Raise budget",
          recommendedAction: "Increase the budget on the best campaign.",
          why: "The selected campaign is outperforming peers.",
          summary: "Strong profitability signal.",
          expectedImpact: "More profitable volume.",
          evidence: [{ label: "ROAS", value: "3.20x", tone: "positive" }],
          timeframeContext: {
            coreVerdict: "Strong selected range",
            selectedRangeOverlay: "Selected range is healthy",
            historicalSupport: "History supports the move",
            seasonalityFlag: "none",
            note: null,
          },
        },
      ],
    })),
  };
});

vi.mock("@/lib/meta/creative-intelligence", () => ({
  buildMetaCreativeIntelligence: vi.fn(() => ({ rows: [] })),
}));

vi.mock("@/lib/meta/creative-score-service", () => ({
  getCreativeScoreSnapshot: vi.fn(async () => ({
    selectedRows: [],
    historyById: new Map(),
    decisionsById: new Map(),
    computedAt: new Date().toISOString(),
    freshnessState: "fresh",
    ruleVersion: "meta-creative-score-v1",
  })),
}));

const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const campaignsSource = await import("@/lib/meta/campaigns-source");
const adsetsSource = await import("@/lib/meta/adsets-source");
const adsetDecisions = await import("@/lib/meta/adset-decisions");
const breakdownsSource = await import("@/lib/meta/breakdowns-source");
const metaRecommendations = await import("@/lib/meta/recommendations");
const requestLanguage = await import("@/lib/request-language");
const configSnapshots = await import("@/lib/meta/config-snapshots");

describe("GET /api/meta/recommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(requestLanguage.resolveRequestLanguage).mockResolvedValue("en");
    vi.mocked(configSnapshots.readMetaBidRegimeHistorySummaries).mockResolvedValue(new Map());
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [],
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });
    vi.mocked(adsetDecisions.buildMetaAdsetRecommendations).mockReturnValue([]);
  });

  it("returns snapshot-backed recommendations and archival source metadata", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    assertMetaRecommendationsPageContract(payload);
    expect(payload.analysisSource).toEqual({
      system: "snapshot_fallback",
      decisionOsAvailable: false,
      fallbackReason: "legacy_decision_os_archived_phase_4_1",
    });
    expect(payload.sourceModel).toBe("snapshot_heuristics");
    expect(payload.businessId).toBe("biz");
    expect(payload.startDate).toBe("2026-03-01");
    expect(payload.endDate).toBe("2026-03-31");
    expect(campaignsSource.getMetaCampaignsForRange).toHaveBeenCalled();
    expect(breakdownsSource.getMetaBreakdownsForRange).toHaveBeenCalled();
    expect(metaRecommendations.buildMetaRecommendations).toHaveBeenCalled();
  });

  it("appends adset-scoped recommendations after existing recommendations", async () => {
    vi.mocked(campaignsSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "cmp_1",
          accountId: "act_1",
          name: "Campaign 1",
          status: "ACTIVE",
          budgetLevel: "adset",
          spend: 1000,
          purchases: 20,
          revenue: 3000,
          roas: 3,
          cpa: 50,
          ctr: 2,
          cpm: 10,
          cpc: 1,
          cpp: 1,
          impressions: 10000,
          reach: 8000,
          frequency: 1.2,
          clicks: 1000,
          uniqueClicks: 800,
          uniqueCtr: 1.8,
          inlineLinkClickCtr: 1.5,
          outboundClicks: 700,
          outboundCtr: 1.2,
          uniqueOutboundClicks: 600,
          uniqueOutboundCtr: 1.1,
          landingPageViews: 500,
          costPerLandingPageView: 2,
          addToCart: 100,
          addToCartValue: 4000,
          costPerAddToCart: 10,
          initiateCheckout: 60,
          initiateCheckoutValue: 2200,
          costPerCheckoutInitiated: 17,
          leads: 10,
          leadsValue: 0,
          costPerLead: 100,
          registrationsCompleted: 0,
          registrationsCompletedValue: 0,
          costPerRegistrationCompleted: 0,
          searches: 0,
          searchesValue: 0,
          costPerSearch: 0,
          addPaymentInfo: 30,
          addPaymentInfoValue: 1200,
          costPerAddPaymentInfo: 33,
          pageLikes: 0,
          costPerPageLike: 0,
          postEngagement: 0,
          costPerEngagement: 0,
          postReactions: 0,
          costPerReaction: 0,
          postComments: 0,
          costPerPostComment: 0,
          postShares: 0,
          costPerPostShare: 0,
          messagingConversationsStarted: 0,
          costPerMessagingConversationStarted: 0,
          appInstalls: 0,
          costPerAppInstall: 0,
          contentViews: 0,
          contentViewsValue: 0,
          costPerContentView: 0,
          videoViews3s: 0,
          videoViews15s: 0,
          videoViews25: 0,
          videoViews50: 0,
          videoViews75: 0,
          videoViews95: 0,
          videoViews100: 0,
          costPerVideoView: 0,
          currency: "USD",
          objective: "OUTCOME_SALES",
          optimizationGoal: "Purchase",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
          manualBidAmount: null,
          previousManualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          previousBidValue: null,
          previousBidValueFormat: null,
          previousBidValueCapturedAt: null,
          dailyBudget: 10000,
          lifetimeBudget: null,
          previousDailyBudget: null,
          previousLifetimeBudget: null,
          previousBudgetCapturedAt: null,
          isBudgetMixed: false,
          isConfigMixed: false,
          isOptimizationGoalMixed: false,
          isBidStrategyMixed: false,
          isBidValueMixed: false,
        },
      ],
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });
    vi.mocked(adsetDecisions.buildMetaAdsetRecommendations).mockReturnValue([
      {
        id: "adset:as_1:pause_underperformer",
        level: "adset",
        campaignId: "cmp_1",
        campaignName: "Campaign 1",
        parentCampaignId: "cmp_1",
        parentCampaignName: "Campaign 1",
        adsetId: "as_1",
        adsetName: "Adset 1",
        type: "adset_pause_underperformer",
        lens: "profitability",
        priority: "high",
        confidence: "medium",
        decisionState: "test",
        decision: "Pause this underperforming adset",
        title: "Adset 1: below account floor",
        recommendedAction: "Pause or reduce this adset.",
        why: "It is below the account floor.",
        summary: "Underperforming adset.",
        expectedImpact: "Less wasted spend.",
        evidence: [{ label: "ROAS", value: "0.60x", tone: "warning" }],
        timeframeContext: {
          coreVerdict: "Adset gate passed",
          selectedRangeOverlay: "Selected range is weak",
          historicalSupport: "No historical reorder needed",
          seasonalityFlag: "none",
          note: null,
        },
      },
    ]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31",
      ),
    );
    const payload = await response.json();

    expect(payload.recommendations.map((rec: { id: string }) => rec.id)).toEqual([
      "rec_1",
      "adset:as_1:pause_underperformer",
    ]);
    expect(payload.summary.recommendationCount).toBe(2);
    expect(adsetsSource.getMetaAdSetsForRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        campaignIds: ["cmp_1"],
        startDate: "2026-03-01",
        endDate: "2026-03-31",
      }),
    );
    expect(adsetDecisions.buildMetaAdsetRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedRangeDays: 31,
      }),
    );
  });

  it("keeps the intentional snapshot-backed bid regime analysis path", async () => {
    await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31",
      ),
    );

    expect(configSnapshots.readMetaBidRegimeHistorySummaries).toHaveBeenCalledTimes(1);
    expect(configSnapshots.readMetaBidRegimeHistorySummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        entityLevel: "campaign",
      }),
    );
  });

  it("rejects missing required params before building recommendations", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/recommendations?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("missing_params");
    expect(metaRecommendations.buildMetaRecommendations).not.toHaveBeenCalled();
  });
});
