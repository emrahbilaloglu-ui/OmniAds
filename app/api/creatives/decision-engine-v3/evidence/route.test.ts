import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  decideCreative,
  resolveAccountDecisionProfile,
  type AccountDecisionProfile,
  type CreativeInput,
  type DataHealth,
  type DecisionOutput,
  type EngineV3Flags,
  type FunnelDiagnosis,
  type OperatorResponseResult,
} from "@/lib/creative-decision-engine";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { resolveDataSource } from "../data-source";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/creative-decision-engine")>();
  return {
    ...actual,
    decideCreative: vi.fn(),
    resolveAccountDecisionProfile: vi.fn(),
  };
});

vi.mock("../data-source", () => ({
  resolveDataSource: vi.fn(),
}));

const dataSource = {
  listCreativeInputs: vi.fn(),
  getDataHealth: vi.fn(),
  getLatestFunnelDiagnosis: vi.fn(),
  getLatestOperatorResponse: vi.fn(),
};

const input: CreativeInput = {
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

const dataHealth: DataHealth = {
  calibration: makeLayer(),
  lifecycle: makeLayer(),
  decisions: makeLayer(),
  worstTier: "none",
  degraded: false,
};

const decision: DecisionOutput = {
  creativeId: "creative-1",
  creativeName: "Creative One",
  label: "scale",
  reason: "Strong winner against target.",
  confidence: 82,
  truthSource: "commercial_truth",
  effectiveTargetRoas: 2.2,
  ratioToTarget: 1.36,
  badges: [],
  metrics: {
    spend: 500,
    purchases: 8,
    roas: 3,
    recent7dRoas: 2.8,
  },
  engineVersion: "v3-test",
  generatedAt: "2026-05-04T12:00:00.000Z",
};

const funnelDiagnosis: FunnelDiagnosis = {
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

const operatorResponse: OperatorResponseResult = {
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

function mockBusinessAccess(businessId = "biz-1") {
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: {
      user: { id: "user-1", email: "operator@adsecute.com" },
    } as never,
    membership: {
      id: "membership-1",
      userId: "user-1",
      businessId,
      role: "guest",
      status: "active",
      joinedAt: "2026-05-04T00:00:00.000Z",
    },
  });
}

function mockAccessError(status: 401 | 403) {
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    error: NextResponse.json({ error: "auth_error" }, { status }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBusinessAccess();
  vi.mocked(resolveEngineV3Flags).mockResolvedValue(makeFlags());
  vi.mocked(resolveDataSource).mockReturnValue({
    instance: dataSource as never,
    label: "warehouse",
  });
  dataSource.listCreativeInputs.mockResolvedValue([input]);
  dataSource.getDataHealth.mockResolvedValue(dataHealth);
  dataSource.getLatestFunnelDiagnosis.mockResolvedValue(funnelDiagnosis);
  dataSource.getLatestOperatorResponse.mockResolvedValue(operatorResponse);
  vi.mocked(resolveAccountDecisionProfile).mockResolvedValue(makeAccountProfile());
  vi.mocked(decideCreative).mockReturnValue(decision);
});

describe("GET /api/creatives/decision-engine-v3/evidence", () => {
  it("returns 401 when auth fails", async () => {
    mockAccessError(401);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?businessId=biz-1&creativeId=creative-1",
      ),
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 when businessId is missing", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?creativeId=creative-1",
      ),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("businessId required");
    expect(requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("returns 400 when creativeId is missing", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?businessId=biz-1",
      ),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("creativeId required");
  });

  it("returns 404 when no CreativeInput is found", async () => {
    dataSource.listCreativeInputs.mockResolvedValue([]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?businessId=biz-1&creativeId=creative-1",
      ),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(404);
    expect(payload.error).toBe("creative input not found");
  });

  it("returns a disabled response when flags.enabled is false", async () => {
    vi.mocked(resolveEngineV3Flags).mockResolvedValue(
      makeFlags({ enabled: false }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?businessId=biz-1&creativeId=creative-1",
      ),
    );
    const payload = (await response.json()) as { status?: string; reason?: string };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "disabled",
      reason: "engine_v3_disabled_for_business",
    });
    expect(resolveDataSource).not.toHaveBeenCalled();
  });

  it("returns the full evidence shape for an enabled business", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?businessId=biz-1&creativeId=creative-1&asOf=2026-05-04",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      businessId: "biz-1",
      creativeId: "creative-1",
      asOf: "2026-05-04",
      engineVersion: "v3-test",
      dataHealth,
      accountProfile: { businessId: "biz-1", preset: "balanced" },
      decision: { creativeId: "creative-1", label: "scale" },
      input: { creativeId: "creative-1" },
      funnelDiagnosis: { primaryWeakStage: "none" },
      operatorResponse: { responseType: "ignored" },
    });
    expect(dataSource.listCreativeInputs).toHaveBeenCalledWith({
      businessId: "biz-1",
      asOf: "2026-05-04",
      creativeIds: ["creative-1"],
    });
  });

  it("handles missing funnel and operator response evidence", async () => {
    dataSource.getLatestFunnelDiagnosis.mockResolvedValue(null);
    dataSource.getLatestOperatorResponse.mockResolvedValue(null);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3/evidence?businessId=biz-1&creativeId=creative-1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.funnelDiagnosis).toBeNull();
    expect(payload.operatorResponse).toBeNull();
  });
});
