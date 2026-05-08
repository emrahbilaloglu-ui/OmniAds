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

vi.mock("@/lib/meta/snapshot", () => ({
  readMetaDecisionSnapshotForRange: vi.fn(),
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
          evidenceTrail: {
            roas_history: [2.8, 3.2],
            peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
            regime_stability: 1,
            age_days: 28,
            recent_changes: [],
          },
          campaignRole: "prospecting_scale",
          bidRegime: "lowest_cost",
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
const breakdownsSource = await import("@/lib/meta/breakdowns-source");
const metaRecommendations = await import("@/lib/meta/recommendations");
const snapshot = await import("@/lib/meta/snapshot");
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
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      summary: {
        title: "Snapshot summary",
        summary: "Snapshot summary",
        primaryLens: "volume",
        confidence: "medium",
        recommendationCount: 1,
      },
      recommendations: [
        {
          id: "snapshot_rec_1",
          level: "campaign",
          campaignId: "cmp_1",
          type: "budget_allocation",
          lens: "volume",
          priority: "high",
          confidence: "medium",
          confidenceScore: 0.63,
          decisionState: "act",
          decision: "increase budget",
          title: "Persisted budget move",
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
          evidenceTrail: {
            roas_history: [2.8, 3.2],
            peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
            regime_stability: 1,
            age_days: 28,
            recent_changes: [],
          },
          campaignRole: "prospecting_scale",
          bidRegime: "lowest_cost",
        },
      ],
      sourceModel: "snapshot_persistent",
      analysisSource: {
        system: "snapshot_persistent",
        decisionOsAvailable: false,
        fallbackReason: "meta_engine_v1_snapshot",
      },
    });
  });

  it("reads persisted snapshot recommendations by default", async () => {
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
      system: "snapshot_persistent",
      decisionOsAvailable: false,
      fallbackReason: "meta_engine_v1_snapshot",
    });
    expect(payload.sourceModel).toBe("snapshot_persistent");
    expect(payload.businessId).toBe("biz");
    expect(payload.startDate).toBe("2026-03-01");
    expect(payload.endDate).toBe("2026-03-31");
    expect(payload.recommendations[0].evidenceTrail).toEqual({
      roas_history: [2.8, 3.2],
      peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
      regime_stability: 1,
      age_days: 28,
      recent_changes: [],
    });
    expect(payload.recommendations[0].campaignRole).toBe("prospecting_scale");
    expect(payload.recommendations[0].bidRegime).toBe("lowest_cost");
    expect(snapshot.readMetaDecisionSnapshotForRange).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(breakdownsSource.getMetaBreakdownsForRange).not.toHaveBeenCalled();
    expect(metaRecommendations.buildMetaRecommendations).not.toHaveBeenCalled();
  });

  it("keeps the intentional live debug path", async () => {
    await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&live=1",
      ),
    );

    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalled();
    expect(campaignsSource.getMetaCampaignsForRange).toHaveBeenCalled();
    expect(breakdownsSource.getMetaBreakdownsForRange).toHaveBeenCalled();
    expect(metaRecommendations.buildMetaRecommendations).toHaveBeenCalled();
    expect(configSnapshots.readMetaBidRegimeHistorySummaries).toHaveBeenCalledTimes(1);
    expect(configSnapshots.readMetaBidRegimeHistorySummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        entityLevel: "campaign",
      }),
    );
  });

  it("marks live debug responses as snapshot_live and uses the v1 live debug reason", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&live=1",
      ),
    );
    const payload = await response.json();

    expect(payload.sourceModel).toBe("snapshot_live");
    expect(payload.analysisSource).toEqual({
      system: "snapshot_live",
      decisionOsAvailable: false,
      fallbackReason: "meta_engine_v1_live_debug",
    });
  });

  it("rejects missing required params before building recommendations", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/recommendations?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("missing_params");
    expect(metaRecommendations.buildMetaRecommendations).not.toHaveBeenCalled();
    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalled();
  });
});
