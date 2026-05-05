import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let mockAdSetQuery: any = {
  data: undefined,
  isLoading: false,
  isError: false,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => mockAdSetQuery),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ language: "en" }),
}));

vi.mock("@/hooks/use-currency", () => ({
  useCurrencySymbol: () => "$",
}));

vi.mock("@/components/meta/meta-account-recs", () => ({
  MetaAccountRecs: () => React.createElement("div", null, "account-recommendations"),
}));

vi.mock("@/components/meta/meta-breakdown-grid", () => ({
  MetaBreakdownGrid: () => React.createElement("div", null, "performance-breakdown"),
}));

vi.mock("@/components/meta/meta-operating-mode-card", () => ({
  MetaOperatingModeCard: () => React.createElement("div", null, "operating-mode-card"),
}));

const { MetaCampaignDetail } = await import("@/components/meta/meta-campaign-detail");

function selectedCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    name: "Campaign One",
    status: "ACTIVE",
    objective: "Sales",
    spend: 120,
    revenue: 360,
    roas: 3,
    cpa: 20,
    dailyBudget: 5000,
    lifetimeBudget: null,
    previousDailyBudget: 4000,
    previousLifetimeBudget: null,
    previousBudgetCapturedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function recommendationsData(withCampaignRec = true) {
  return {
    status: "ok",
    summary: {
      title: "Summary",
      summary: "Summary",
      primaryLens: "volume",
      confidence: "medium",
      recommendationCount: withCampaignRec ? 1 : 0,
    },
    recommendations: withCampaignRec
      ? [
          {
            id: "rec_1",
            campaignId: "cmp_1",
            decisionState: "act",
            title: "Raise budget",
            recommendedAction: "Increase budget",
            why: "Winning campaign",
            evidence: [{ label: "ROAS", value: "3.2x", tone: "positive" }],
          },
        ]
      : [],
  };
}

describe("MetaCampaignDetail render contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdSetQuery = {
      data: {
        rows: [
          {
            id: "adset_1",
            name: "Adset One",
            status: "ACTIVE",
            optimizationGoal: "PURCHASE",
            bidStrategyLabel: "Cost Cap",
            bidValue: 1200,
            bidValueFormat: "currency",
            previousBidValue: null,
            previousBidValueFormat: null,
            previousBidValueCapturedAt: null,
            spend: 50,
            revenue: 130,
            roas: 2.6,
            cpa: 10,
            ctr: 1.2,
            inlineLinkClickCtr: 1.2,
          },
        ],
      },
      isLoading: false,
      isError: false,
    };
  });

  it("renders the account-overview path when no campaign is selected", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={null}
        recommendationsData={recommendationsData(false) as any}
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Account Drilldown");
    expect(html).toContain("Workflow and context");
    expect(html).not.toContain("operating-mode-card");
    expect(html).not.toContain("account-recommendations");
    expect(html).not.toContain("performance-breakdown");
  });

  it("renders the selected campaign visible details including the optional budget tile when budget exists", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={selectedCampaign() as any}
        recommendationsData={recommendationsData(true) as any}
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Campaign One");
    expect(html).toContain("Sales");
    expect(html).toContain("ACTIVE");
    expect(html).toContain("Winning campaign");
    expect(html).not.toContain("Show campaign reasoning");
    expect(html).not.toContain("Workflow context");
    expect(html).toContain("Budget");
    expect(html).toContain("Ad Sets");
    expect(html).toContain("Adset One");
  });

  it("hides the budget tile when the selected campaign has no visible budget fields", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={selectedCampaign({
          dailyBudget: null,
          lifetimeBudget: null,
          previousDailyBudget: null,
          previousLifetimeBudget: null,
          previousBudgetCapturedAt: null,
        }) as any}
        recommendationsData={recommendationsData(false) as any}
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Campaign One");
    expect(html).not.toContain("Budget");
  });

  it("keeps recommendations optional and does not break the selected campaign render when absent", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={selectedCampaign() as any}
        recommendationsData={recommendationsData(false) as any}
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Campaign One");
    expect(html).toContain("Ad Sets");
    expect(html).not.toContain("Raise budget");
  });

  it("labels snapshot fallback recommendations as context when no campaign Decision OS row exists", () => {
    const fallbackRecommendations = {
      ...recommendationsData(true),
      analysisSource: {
        system: "snapshot_fallback",
        decisionOsAvailable: false,
        fallbackReason: "decision_os_unavailable",
      },
    };

    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={selectedCampaign() as any}
        recommendationsData={fallbackRecommendations as any}
        analysisStatus={
          {
            state: "recommendation_fallback",
            recommendationSource: "snapshot_fallback",
            presentationMode: "fallback_context",
          } as any
        }
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Snapshot recommendation context");
    expect(html).toContain("Snapshot context only");
    expect(html).toContain("Winning campaign");
    expect(html).not.toContain("Increase budget");
  });

  it("keeps snapshot fallback recommendations contextual even when the decision state is not act", () => {
    const fallbackRecommendations = {
      ...recommendationsData(true),
      analysisSource: {
        system: "snapshot_fallback",
        decisionOsAvailable: false,
        fallbackReason: "decision_os_unavailable",
      },
      recommendations: [
        {
          ...recommendationsData(true).recommendations[0],
          decisionState: "test",
          recommendedAction: "Run a structural test",
          summary: "Structural test context",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={selectedCampaign() as any}
        recommendationsData={fallbackRecommendations as any}
        analysisStatus={
          {
            state: "recommendation_fallback",
            recommendationSource: "snapshot_fallback",
            presentationMode: "fallback_context",
          } as any
        }
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Snapshot recommendation context");
    expect(html).toContain("Structural test context");
    expect(html).not.toContain("Run a structural test");
  });

  it("keeps ad set drilldown optional when no rows are available", () => {
    mockAdSetQuery = {
      data: { rows: [] },
      isLoading: false,
      isError: false,
    };

    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={selectedCampaign() as any}
        recommendationsData={recommendationsData(false) as any}
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Campaign One");
    expect(html).toContain("No ad set data for this range.");
  });

  it("does not invent an Auto bid label when the warehouse has no bidding config", () => {
    mockAdSetQuery = {
      data: {
        rows: [
          {
            id: "adset_1",
            name: "Adset One",
            status: "ACTIVE",
            optimizationGoal: null,
            bidStrategyLabel: null,
            bidValue: null,
            bidValueFormat: null,
            previousBidValue: null,
            previousBidValueFormat: null,
            previousBidValueCapturedAt: null,
            spend: 50,
            revenue: 130,
            cpa: 10,
            ctr: 1.2,
            inlineLinkClickCtr: 1.2,
          },
        ],
      },
      isLoading: false,
      isError: false,
    };

    const html = renderToStaticMarkup(
      <MetaCampaignDetail
        campaign={selectedCampaign() as any}
        recommendationsData={recommendationsData(false) as any}
        isRecsLoading={false}
        lastAnalyzedAt={null}
        checkedRecIds={new Set()}
        onToggleCheck={vi.fn()}
        onAnalyze={vi.fn()}
        onClearSelection={vi.fn()}
        businessId="biz"
        since="2026-04-01"
        until="2026-04-05"
        language="en"
      />
    );

    expect(html).toContain("Adset One");
    expect(html).not.toContain("AUTO");
  });
});
