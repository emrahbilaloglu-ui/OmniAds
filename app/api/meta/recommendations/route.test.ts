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
