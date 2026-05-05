import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AccountDecisionProfile,
  CreativeInput,
  DataHealth,
  DecisionEvidenceResponse,
  DecisionOutput,
  EngineV3Flags,
  FunnelDiagnosis,
  OperatorResponseResult,
} from "@/lib/creative-decision-engine";

let queryState: Record<string, unknown>;
let invokeQueryFn = false;
let observedQuery: { queryKey?: unknown[]; enabled?: boolean } = {};

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((input: {
    queryKey: unknown[];
    enabled?: boolean;
    queryFn: () => Promise<unknown>;
  }) => {
    observedQuery = {
      queryKey: input.queryKey,
      enabled: input.enabled,
    };
    if (invokeQueryFn && input.enabled) {
      void input.queryFn();
    }
    return queryState;
  }),
}));

const { CreativeEngineV3EvidenceSection } = await import(
  "@/components/creatives/CreativeEngineV3EvidenceSection"
);

function makeFlags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz-1",
    enabled: true,
    surfaceVisible: true,
    shadowOnly: true,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
    ...overrides,
  };
}

function makeLayer(): DataHealth["calibration"] {
  return {
    asOfDate: "2026-05-04",
    computedAt: "2026-05-04T12:00:00.000Z",
    sourceFreshnessHours: 0,
    staleTier: "none",
    fallbackMode: "runtime_sql",
    note: null,
  };
}

function makeDataHealth(): DataHealth {
  return {
    calibration: makeLayer(),
    lifecycle: makeLayer(),
    decisions: makeLayer(),
    worstTier: "none",
    degraded: false,
  };
}

function makeAccountProfile(): AccountDecisionProfile {
  return {
    businessId: "biz-1",
    asOfDate: "2026-05-04",
    channel: "meta",
    objectiveFamily: "sales",
    preset: "balanced",
    presetSource: "default",
    spendUnit: 50,
    spendUnitSource: "meta_derived_aov",
    spendUnitConfidence: "high",
    spendUnitEvidence: {
      targetCpa: null,
      operatorAovAssumption: 55,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      targetRoas: 2.2,
      breakEvenRoas: 1.71,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      warnings: [],
    },
    multipliers: {
      zeroConvBurner: 1.5,
      cutCandidate: 2,
      sustainedLoser: 3,
      hardCut: 4,
      scaleEvidence: 1.2,
      scalePurchase: 1,
      winnerMemory: 0.8,
      recentSample: 0.5,
      weakFunnelRate: 0.8,
    },
    thresholds: {
      zeroConvBurnerSpend: 75,
      cutCandidateSpend: 100,
      sustainedLoserSpend: 150,
      hardCutSpend: 200,
      recentSampleMinSpend: 50,
      scaleMinEvidenceSpend: 100,
      winnerMemoryMinSpend: 80,
      scaleMinPurchases: 3,
      winnerMemoryMinPurchases: 2,
      bottomQuartileRatio: 0.6,
      severeLoserRatio: 0.4,
    },
    accountBaselines: {
      businessId: "biz-1",
      computedAt: "2026-05-04T12:00:00.000Z",
      matureCreativeCount: 35,
      roasP75: 2.4,
      roasP60: 1.9,
      refreshRatioP10: 0.82,
      lowCtrP10: 0.7,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      matureSpendP50: 300,
      matureSpendP75: 450,
      winnerSpendP25: 250,
      winnerSpendP50: 500,
      winnerPurchaseP50: 5,
      roasRatioP10: 0.4,
      roasRatioP25: 0.6,
      roasRatioP50: 1,
      roasRatioP75: 1.35,
      metaAovQuality: "ready",
    },
    funnelCalibration: { byFormat: {} },
    hardActionEligibility: {
      scale: true,
      cut: true,
      refresh: true,
      reason: null,
    },
    quality: {
      commercialTruthReady: true,
      calibrationReady: true,
      metaAovQuality: "ready",
      thresholdQuality: "ready",
    },
  };
}

function makeInput(): CreativeInput {
  return {
    creativeId: "creative-1",
    creativeName: "Creative One",
    businessId: "biz-1",
    campaignId: "campaign-1",
    objective: "OUTCOME_SALES",
    spend: 500,
    purchases: 8,
    purchaseValue: 1500,
    impressions: 50000,
    linkClicks: 600,
    roas: 3,
    cpa: 62.5,
    ctr: 1.2,
    frequency: 1.4,
    recent7dSpend: 120,
    recent7dPurchases: 2,
    recent7dRoas: 2.8,
    recent7dImpressions: 12000,
    effectiveStatus: "ACTIVE",
    ageDays: 21,
    lastSpendAt: "2026-05-04",
    policyReason: null,
    dataFreshnessHours: 6,
    fatigueStatus: "none",
    targetRoas: 2.2,
    breakevenRoas: 1.71,
    lifecyclePosition: "plateau",
    daysSincePeak: 5,
    peakRoas30d: 3.4,
    peakConfidence: 0.7,
    spendTrajectory30d: "flat",
    spendSlope7d: 0.5,
    spendSlope30d: 0.2,
    roasSlope7d: -0.05,
    roasSlope30d: 0,
    cpm: 10,
    outboundClicks: 520,
    landingPageViews: 480,
    addToCart: 80,
    initiateCheckout: 40,
    thumbstop: 25,
    video25Rate: 18,
    video50Rate: 10,
    video75Rate: 6,
    video100Rate: 3,
    qualityRanking: "average",
    engagementRateRanking: "average",
    conversionRateRanking: "average",
    creativeFormat: "video",
  };
}

function makeDecision(): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Creative One",
    label: "scale",
    reason: "Strong winner against target.",
    confidence: 82,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 1.36,
    badges: [
      {
        type: "opportunity_window_open",
        label: "Opportunity window open",
        severity: "info",
      },
    ],
    metrics: {
      spend: 500,
      purchases: 8,
      roas: 3,
      recent7dRoas: 2.8,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-04T12:00:00.000Z",
  };
}

function makeFunnelDiagnosis(): FunnelDiagnosis {
  return {
    primaryWeakStage: "none",
    creativeResponsible: false,
    confidence: 1,
    evidence: ["funnel rates are not below account weak thresholds"],
    rates: {
      ctr: 1.2,
      outboundClickRate: 1.04,
      linkToLpvRate: 80,
      linkToAtcRate: 13.33,
      lpvToAtcRate: 16.67,
      atcToIcRate: 50,
      icToPurchaseRate: 20,
      atcToPurchaseRate: 10,
      clickToPurchaseRate: 1.33,
    },
  };
}

function makeOperatorResponse(): OperatorResponseResult {
  return {
    responseType: "ignored",
    decisionRecommendedAt: "2026-05-01",
    operatorResponseDetectedAt: "2026-05-04T00:00:00.000Z",
    confidence: 0.72,
    evidence: ["recommendation was not acted on"],
    signals: {
      spendSlope7d: 0,
      budgetChangeAmount: null,
      actionJournalReceiptCount: 0,
      statusChanged: false,
      roasDecayPct: null,
      frequencyRosePct: null,
    },
  };
}

function makePayload(
  overrides: Partial<DecisionEvidenceResponse> = {},
): DecisionEvidenceResponse {
  return {
    businessId: "biz-1",
    creativeId: "creative-1",
    asOf: "2026-05-04",
    engineVersion: "v3-test",
    flags: makeFlags(),
    dataHealth: makeDataHealth(),
    accountProfile: makeAccountProfile(),
    decision: makeDecision(),
    input: makeInput(),
    funnelDiagnosis: makeFunnelDiagnosis(),
    operatorResponse: makeOperatorResponse(),
    ...overrides,
  };
}

function renderEvidence(open = true) {
  return renderToStaticMarkup(
    <CreativeEngineV3EvidenceSection
      businessId="biz-1"
      creativeId="creative-1"
      open={open}
    />,
  );
}

beforeEach(() => {
  queryState = {
    data: null,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  };
  invokeQueryFn = false;
  observedQuery = {};
  vi.unstubAllGlobals();
});

describe("CreativeEngineV3EvidenceSection", () => {
  it("does not fetch when open is false", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    invokeQueryFn = true;

    const html = renderEvidence(false);

    expect(html).toBe("");
    expect(observedQuery.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches once when open is true", () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makePayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { origin: "https://app.example" },
    });
    invokeQueryFn = true;

    renderEvidence(true);

    expect(observedQuery).toMatchObject({
      enabled: true,
      queryKey: ["engine-v3-evidence", "biz-1", "creative-1"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/creatives/decision-engine-v3/evidence");
    expect(url.searchParams.get("businessId")).toBe("biz-1");
    expect(url.searchParams.get("creativeId")).toBe("creative-1");
  });

  it("shows disabled copy when status is disabled", () => {
    queryState = {
      ...queryState,
      data: {
        status: "disabled",
        reason: "engine_v3_disabled_for_business",
        flags: makeFlags({ enabled: false }),
      },
    };

    const html = renderEvidence();

    expect(html).toContain("Engine v3 not enabled for this business");
    expect(html).not.toContain("Decision</summary>");
  });

  it("renders all six subsections with a full evidence payload", () => {
    queryState = { ...queryState, data: makePayload() };

    const html = renderEvidence();

    expect(html).toContain("Decision</summary>");
    expect(html).toContain("Inputs</summary>");
    expect(html).toContain("Funnel</summary>");
    expect(html).toContain("Engine trail</summary>");
    expect(html).toContain("Operator response</summary>");
    expect(html).toContain("Provenance</summary>");
    expect(html).toContain("Strong winner against target.");
    expect(html).toContain("creativeId");
    expect(html).toContain("primaryWeakStage");
    expect(html).toContain("opportunity_window_open");
    expect(html).toContain("ignored");
    expect(html).toContain("decision.generatedAt");
  });

  it("renders fallback text when funnelDiagnosis or operatorResponse is null", () => {
    queryState = {
      ...queryState,
      data: makePayload({
        funnelDiagnosis: null,
        operatorResponse: null,
      }),
    };

    const html = renderEvidence();

    expect(html).toContain(
      "Funnel diagnosis not available for this creative.",
    );
    expect(html).toContain(
      "No operator response detected in the recent window.",
    );
  });
});
