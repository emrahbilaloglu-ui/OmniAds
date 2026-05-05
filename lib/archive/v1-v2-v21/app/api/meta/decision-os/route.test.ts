import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { assertMetaDecisionOsPageContract } from "@/lib/meta/page-route-contract.test-helpers";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
}));

vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/breakdowns-source", () => ({
  getMetaBreakdownsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/operator-decision-source", () => ({
  getMetaDecisionWindowContext: vi.fn(),
  getMetaDecisionSourceSnapshot: vi.fn(),
}));

vi.mock("@/lib/meta/decision-os-config", () => ({
  isMetaDecisionOsV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/creative-decision-os-config", () => ({
  isCreativeDecisionOsV1EnabledForBusiness: vi.fn(() => false),
}));

vi.mock("@/lib/creative-decision-os-source", () => ({
  getCreativeDecisionOsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/decision-os-linkage", () => ({
  attachCreativeLinkage: vi.fn((payload) => payload),
}));

vi.mock("@/lib/meta/decision-os", () => ({
  buildMetaDecisionOs: vi.fn(),
  META_DECISION_OS_V1_CONTRACT: "meta-decision-os.v1",
}));

const access = await import("@/lib/access");
const businessCommercial = await import("@/lib/business-commercial");
const decisionWindowSource = await import("@/lib/meta/operator-decision-source");
const decisionOsConfig = await import("@/lib/meta/decision-os-config");
const creativeDecisionOsConfig = await import("@/lib/creative-decision-os-config");
const creativeDecisionOsSource = await import("@/lib/creative-decision-os-source");
const decisionOsLinkage = await import("@/lib/meta/decision-os-linkage");
const decisionOs = await import("@/lib/meta/decision-os");
const { GET } = await import("@/app/api/meta/decision-os/route");

describe("GET /api/meta/decision-os", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(decisionOsConfig.isMetaDecisionOsV1EnabledForBusiness).mockReturnValue(true);
    vi.mocked(creativeDecisionOsConfig.isCreativeDecisionOsV1EnabledForBusiness).mockReturnValue(false);
    vi.mocked(decisionWindowSource.getMetaDecisionWindowContext).mockResolvedValue({
      analyticsWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-05",
        role: "analysis_only",
      },
      decisionWindows: {
        recent7d: {
          key: "recent7d",
          label: "recent 7d",
          startDate: "2026-04-04",
          endDate: "2026-04-10",
          days: 7,
          role: "recent_watch",
        },
        primary30d: {
          key: "primary30d",
          label: "primary 30d",
          startDate: "2026-03-12",
          endDate: "2026-04-10",
          days: 30,
          role: "decision_authority",
        },
        baseline90d: {
          key: "baseline90d",
          label: "baseline 90d",
          startDate: "2026-01-11",
          endDate: "2026-04-10",
          days: 90,
          role: "historical_memory",
        },
      },
      historicalMemory: {
        available: true,
        source: "rolling_baseline",
        baselineWindowKey: "baseline90d",
        startDate: "2026-01-11",
        endDate: "2026-04-10",
        lookbackDays: 90,
        note: "Decisions use live rolling windows with baseline memory instead of the selected period.",
      },
      decisionAsOf: "2026-04-10",
    } as never);
    vi.mocked(businessCommercial.getBusinessCommercialTruthSnapshot).mockResolvedValue({
      businessId: "biz",
      targetPack: null,
      countryEconomics: [],
      promoCalendar: [],
      operatingConstraints: null,
      costModelContext: null,
      sectionMeta: {
        targetPack: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
        countryEconomics: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
        promoCalendar: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
        operatingConstraints: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
      },
    } as never);
    vi.mocked(decisionWindowSource.getMetaDecisionSourceSnapshot).mockResolvedValue({
      campaigns: {
        status: "ok",
        rows: [{ id: "cmp-1", name: "Campaign One", status: "ACTIVE", spend: 500, revenue: 1500, purchases: 20, roas: 3, cpa: 25 } as never],
        isPartial: false,
        notReadyReason: null,
      },
      adSets: {
        status: "ok",
        rows: [{ id: "adset-1", name: "Adset One", campaignId: "cmp-1", status: "ACTIVE", spend: 250, revenue: 800, purchases: 10, cpa: 25, ctr: 1.4, impressions: 10000, clicks: 140, dailyBudget: 500, lifetimeBudget: null, optimizationGoal: "PURCHASE", bidStrategyType: null, bidStrategyLabel: null, manualBidAmount: null, bidValue: null, bidValueFormat: null, isBudgetMixed: false, isConfigMixed: false } as never],
        isPartial: false,
        notReadyReason: null,
      },
      breakdowns: {
        status: "ok",
        age: [],
        location: [{ key: "US", label: "US", spend: 500, revenue: 1500, purchases: 20, clicks: 100, impressions: 10000 }],
        placement: [{ key: "feed", label: "Feed", spend: 300, revenue: 600, purchases: 0, clicks: 0, impressions: 0 }],
        budget: { campaign: [], adset: [] },
        audience: { available: false },
        products: { available: false },
        isPartial: false,
        notReadyReason: null,
      },
    } as never);
    vi.mocked(decisionOs.buildMetaDecisionOs).mockReturnValue({
      contractVersion: "meta-decision-os.v1",
      generatedAt: "2026-04-10T00:00:00.000Z",
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      analyticsWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-05",
        role: "analysis_only",
      },
      decisionWindows: {
        recent7d: {
          key: "recent7d",
          label: "recent 7d",
          startDate: "2026-04-04",
          endDate: "2026-04-10",
          days: 7,
          role: "recent_watch",
        },
        primary30d: {
          key: "primary30d",
          label: "primary 30d",
          startDate: "2026-03-12",
          endDate: "2026-04-10",
          days: 30,
          role: "decision_authority",
        },
        baseline90d: {
          key: "baseline90d",
          label: "baseline 90d",
          startDate: "2026-01-11",
          endDate: "2026-04-10",
          days: 90,
          role: "historical_memory",
        },
      },
      historicalMemory: {
        available: true,
        source: "rolling_baseline",
        baselineWindowKey: "baseline90d",
        startDate: "2026-01-11",
        endDate: "2026-04-10",
        lookbackDays: 90,
        note: "Decisions use live rolling windows with baseline memory instead of the selected period.",
      },
      decisionAsOf: "2026-04-10",
      summary: {
        todayPlanHeadline: "Today plan",
        todayPlan: ["Do the next thing"],
        budgetShiftSummary: "1 shift",
        noTouchSummary: "1 no-touch",
        winnerScaleSummary: {
          candidateCount: 0,
          protectedCount: 0,
          headline: "No clean winner scale candidate is ready yet.",
        },
        operatingMode: null,
        confidence: 0.8,
      },
      campaigns: [],
      adSets: [],
      budgetShifts: [],
      geoDecisions: [],
      placementAnomalies: [],
      noTouchList: [],
      winnerScaleCandidates: [],
      commercialTruthCoverage: {
        mode: "conservative_fallback",
        targetPackConfigured: false,
        countryEconomicsConfigured: false,
        promoCalendarConfigured: false,
        operatingConstraintsConfigured: false,
        missingInputs: ["target_pack"],
        notes: [],
      },
    } as never);
    vi.mocked(creativeDecisionOsSource.getCreativeDecisionOsForRange).mockResolvedValue({
      contractVersion: "creative-decision-os.v1",
      creatives: [],
    } as never);

  });

  it("builds the decision payload from campaigns, ad sets, breakdowns, and commercial truth", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-05&analyticsStartDate=2026-03-01&analyticsEndDate=2026-03-31&decisionAsOf=2026-04-10",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    assertMetaDecisionOsPageContract(payload);
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      decisionAsOf: "2026-04-10",
    });
    expect(decisionOs.buildMetaDecisionOs).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-05",
        analyticsStartDate: "2026-03-01",
        analyticsEndDate: "2026-03-31",
        decisionAsOf: "2026-04-10",
        campaigns: expect.arrayContaining([
          expect.objectContaining({ id: "cmp-1", name: "Campaign One" }),
        ]),
        adSets: expect.arrayContaining([
          expect.objectContaining({ id: "adset-1", name: "Adset One" }),
        ]),
        breakdowns: expect.objectContaining({
          location: expect.arrayContaining([
            expect.objectContaining({ label: "US" }),
          ]),
        }),
      }),
    );
  });

  it("falls back to provider decision timing when decisionAsOf is blank", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-05&analyticsStartDate=2026-03-01&analyticsEndDate=2026-03-31&decisionAsOf=",
      ),
    );

    expect(response.status).toBe(200);
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      decisionAsOf: null,
    });
  });

  it("falls back to reporting dates when analytics dates are blank", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-05&analyticsStartDate=&analyticsEndDate=",
      ),
    );

    expect(response.status).toBe(200);
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: null,
    });
    expect(decisionOs.buildMetaDecisionOs).toHaveBeenCalledWith(
      expect.objectContaining({
        analyticsStartDate: "2026-04-01",
        analyticsEndDate: "2026-04-05",
      }),
    );
  });

  it("passes explicit benchmark scope into additive Creative linkage when enabled", async () => {
    vi.mocked(creativeDecisionOsConfig.isCreativeDecisionOsV1EnabledForBusiness).mockReturnValue(true);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-05&analyticsStartDate=2026-03-01&analyticsEndDate=2026-03-31&decisionAsOf=2026-04-10&benchmarkScope=campaign&benchmarkScopeId=cmp_1&benchmarkScopeLabel=Campaign%201",
      ),
    );

    expect(response.status).toBe(200);
    expect(creativeDecisionOsSource.getCreativeDecisionOsForRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-05",
        analyticsStartDate: "2026-03-01",
        analyticsEndDate: "2026-03-31",
        decisionAsOf: "2026-04-10",
        benchmarkScope: {
          scope: "campaign",
          scopeId: "cmp_1",
          scopeLabel: "Campaign 1",
        },
      }),
    );
    expect(decisionOsLinkage.attachCreativeLinkage).toHaveBeenCalled();
  });

  it("returns 404 when the feature gate is disabled for the workspace", async () => {
    vi.mocked(decisionOsConfig.isMetaDecisionOsV1EnabledForBusiness).mockReturnValue(false);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/decision-os?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toBe("meta_decision_os_disabled");
  });
});
