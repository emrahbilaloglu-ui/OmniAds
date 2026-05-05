import { describe, expect, it } from "vitest";
import { buildMetaDecisionOs as buildMetaDecisionOsBase } from "@/lib/meta/decision-os";
import {
  createEmptyBusinessCommercialTruthSnapshot,
  createEmptyOperatingConstraints,
} from "@/src/types/business-commercial";

function buildMetaDecisionOs(
  input: Parameters<typeof buildMetaDecisionOsBase>[0],
) {
  return buildMetaDecisionOsBase({
    evidenceSource: "live",
    ...input,
  });
}

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    accountId: "act_1",
    name: "Prospecting Scale Campaign",
    status: "ACTIVE",
    objective: "Sales",
    spend: 1200,
    purchases: 42,
    revenue: 4200,
    roas: 3.5,
    cpa: 28.57,
    ctr: 1.8,
    cpm: 12,
    cpc: 1,
    cpp: 0,
    impressions: 100000,
    reach: 80000,
    frequency: 1.2,
    clicks: 1800,
    uniqueClicks: 1700,
    uniqueCtr: 1.7,
    inlineLinkClickCtr: 1.6,
    outboundClicks: 1400,
    outboundCtr: 1.4,
    uniqueOutboundClicks: 1300,
    uniqueOutboundCtr: 1.3,
    landingPageViews: 1100,
    costPerLandingPageView: 1,
    addToCart: 120,
    addToCartValue: 1500,
    costPerAddToCart: 10,
    initiateCheckout: 80,
    initiateCheckoutValue: 1000,
    costPerCheckoutInitiated: 15,
    leads: 0,
    leadsValue: 0,
    costPerLead: 0,
    registrationsCompleted: 0,
    registrationsCompletedValue: 0,
    costPerRegistrationCompleted: 0,
    searches: 0,
    searchesValue: 0,
    costPerSearch: 0,
    addPaymentInfo: 0,
    addPaymentInfoValue: 0,
    costPerAddPaymentInfo: 0,
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
    optimizationGoal: "Purchase",
    bidStrategyType: "cost_cap",
    bidStrategyLabel: "Cost Cap",
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: 2400,
    bidValueFormat: "currency",
    previousBidValue: 2200,
    previousBidValueFormat: "currency",
    previousBidValueCapturedAt: "2026-03-20T00:00:00.000Z",
    dailyBudget: 1200,
    lifetimeBudget: null,
    previousDailyBudget: 900,
    previousLifetimeBudget: null,
    previousBudgetCapturedAt: "2026-03-20T00:00:00.000Z",
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    ...overrides,
  } as any;
}

function adSet(overrides: Record<string, unknown> = {}) {
  return {
    id: "adset_1",
    accountId: "act_1",
    name: "Scale Winner",
    campaignId: "cmp_1",
    status: "ACTIVE",
    dailyBudget: 600,
    lifetimeBudget: null,
    optimizationGoal: "PURCHASE",
    bidStrategyType: "cost_cap",
    bidStrategyLabel: "Cost Cap",
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: 2200,
    bidValueFormat: "currency",
    previousBidValue: 2000,
    previousBidValueFormat: "currency",
    previousBidValueCapturedAt: "2026-03-20T00:00:00.000Z",
    previousDailyBudget: 500,
    previousLifetimeBudget: null,
    previousBudgetCapturedAt: "2026-03-20T00:00:00.000Z",
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    spend: 900,
    purchases: 30,
    revenue: 3600,
    roas: 4,
    cpa: 30,
    ctr: 1.6,
    cpm: 11,
    impressions: 60000,
    clicks: 960,
    inlineLinkClickCtr: 1.45,
    ...overrides,
  } as any;
}

function configuredTruthSnapshot() {
  const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");
  snapshot.targetPack = {
    targetCpa: 40,
    targetRoas: 2.5,
    breakEvenCpa: 55,
    breakEvenRoas: 1.7,
    contributionMarginAssumption: null,
    aovAssumption: null,
    newCustomerWeight: null,
    defaultRiskPosture: "balanced",
    sourceLabel: "manual",
    updatedAt: "2026-04-09T09:00:00.000Z",
    updatedByUserId: null,
  };
  snapshot.sectionMeta.targetPack = {
    configured: true,
    itemCount: 1,
    sourceLabel: "manual",
    updatedAt: "2026-04-09T09:00:00.000Z",
    updatedByUserId: null,
  };
  return snapshot;
}

function countryEconomics(
  countryCode: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    countryCode,
    economicsMultiplier: null,
    marginModifier: null,
    serviceability: "full",
    priorityTier: "tier_2",
    scaleOverride: "default",
    notes: null,
    sourceLabel: "manual",
    updatedAt: "2026-04-09T09:00:00.000Z",
    updatedByUserId: null,
    ...overrides,
  } as any;
}

describe("buildMetaDecisionOs", () => {
  it("keeps promo role precedence above retargeting-style naming", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");
    snapshot.targetPack = {
      targetCpa: 40,
      targetRoas: 2.5,
      breakEvenCpa: 55,
      breakEvenRoas: 1.7,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      sourceLabel: "manual",
      updatedAt: null,
      updatedByUserId: null,
    };
    snapshot.promoCalendar = [
      {
        eventId: "promo_1",
        title: "Promo",
        promoType: "sale",
        severity: "high",
        startDate: "2026-04-01",
        endDate: "2026-04-05",
        affectedScope: null,
        notes: null,
        sourceLabel: "manual",
        updatedAt: null,
        updatedByUserId: null,
      },
    ];

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign({ name: "Promo Retargeting Push" })],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.campaigns[0]?.role).toBe("Promo / Clearance");
  });

  it("downgrades aggressive actions to hold when commercial targets are missing", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.commercialTruthCoverage.mode).toBe("conservative_fallback");
    expect(result.adSets[0]?.actionType).toBe("hold");
    expect(result.adSets[0]?.policy.strategyClass).toBe("review_hold");
    expect(result.adSets[0]?.trust.truthState).toBe("degraded_missing_truth");
    expect(result.adSets[0]?.policy.explanation?.compare.cutoverState).toBe("matched");
    expect(result.adSets[0]?.policy.explanation?.degradedReasons.length).toBeGreaterThan(0);
    expect(result.adSets[0]?.trust.evidence).toMatchObject({
      completeness: "missing",
      suppressed: true,
      aggressiveActionBlocked: true,
    });
    expect(result.summary.surfaceSummary.degradedCount).toBeGreaterThan(0);
    expect(result.authority).toMatchObject({
      scope: "Meta Decision OS",
      truthState: "degraded_missing_truth",
      completeness: "missing",
    });
  });

  it("does not treat empty country economics as a missing Meta commercial blocker", () => {
    const snapshot = configuredTruthSnapshot();
    snapshot.operatingConstraints = createEmptyOperatingConstraints();
    snapshot.countryEconomics = [];

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.commercialTruthCoverage.countryEconomicsConfigured).toBe(false);
    expect(result.commercialTruthCoverage.missingInputs).not.toContain(
      "country_economics",
    );
    expect(result.commercialTruthCoverage.notes.join(" ")).toContain(
      "global cost structure",
    );
  });

  it("downgrades hard pauses to review-safe actions when commercial truth is missing", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          spend: 420,
          purchases: 6,
          revenue: 180,
          roas: 0.43,
          cpa: 70,
          ctr: 0.6,
          impressions: 28000,
          clicks: 180,
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.adSets[0]?.actionType).not.toBe("pause");
    expect(result.adSets[0]?.policy.primaryDriver).toBe("degraded_truth_cap");
    expect(result.adSets[0]?.policy.explanation?.actionCeiling).toContain(
      "Hold and review only until missing truth inputs are restored.",
    );
    expect(result.adSets[0]?.trust.truthState).toBe("degraded_missing_truth");
    expect(result.adSets[0]?.trust.operatorDisposition).not.toBe("standard");
  });

  it("marks stable winners as no-touch when commercial targets are configured", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");
    snapshot.targetPack = {
      targetCpa: 40,
      targetRoas: 2.5,
      breakEvenCpa: 55,
      breakEvenRoas: 1.7,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      sourceLabel: "manual",
      updatedAt: null,
      updatedByUserId: null,
    };
    snapshot.operatingConstraints = {
      siteIssueStatus: "none",
      checkoutIssueStatus: "none",
      conversionTrackingIssueStatus: "none",
      feedIssueStatus: "none",
      stockPressureStatus: "healthy",
      landingPageConcern: null,
      merchandisingConcern: null,
      manualDoNotScaleReason: null,
      sourceLabel: "manual",
      updatedAt: null,
      updatedByUserId: null,
    };

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign({ name: "Retargeting Winner" })],
      adSets: [adSet({ status: "ACTIVE" })],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.campaigns[0]?.primaryAction).toBe("hold");
    expect(result.campaigns[0]?.noTouch).toBe(true);
    expect(result.adSets[0]?.policy.strategyClass).toBe("stable_no_touch");
    expect(result.adSets[0]?.policy.explanation?.protectedWinnerHandling).toContain(
      "Stable winners stay visible as protected context",
    );
    expect(result.noTouchList[0]?.entityType).toBe("campaign");
  });

  it("maps constrained bid pressure to review_cost_cap without turning the lane into no-touch", () => {
    const snapshot = configuredTruthSnapshot();

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          spend: 420,
          purchases: 11,
          revenue: 882,
          roas: 2.1,
          cpa: 45,
          ctr: 1.25,
          impressions: 28000,
          clicks: 340,
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.adSets[0]).toMatchObject({
      actionType: "tighten_bid",
      noTouch: false,
      policy: {
        strategyClass: "review_cost_cap",
        objectiveFamily: "sales",
        bidRegime: "cost_cap",
        primaryDriver: "bid_regime_pressure",
      },
    });
  });

  it("maps creative refresh required to hold and keeps it off the no-touch list", () => {
    const snapshot = configuredTruthSnapshot();

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          spend: 410,
          purchases: 10,
          revenue: 902,
          roas: 2.2,
          cpa: 41,
          ctr: 0.92,
          inlineLinkClickCtr: 0.92,
          impressions: 26000,
          clicks: 240,
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.adSets[0]).toMatchObject({
      actionType: "hold",
      noTouch: false,
      policy: {
        strategyClass: "creative_refresh_required",
        primaryDriver: "creative_fatigue",
        winnerState: "creative_refresh_required",
      },
    });
    expect(result.adSets[0]?.policy.explanation?.fatigueOrComeback).toContain(
      "Creative fatigue stays ahead of spend escalation",
    );
    expect(result.adSets[0]?.relatedCreativeNeeds[0]).toContain("Creative supply");
    expect(result.noTouchList).toHaveLength(0);
  });

  it("only emits pause for clear high-signal losers without recent ambiguity", () => {
    const snapshot = configuredTruthSnapshot();

    const cleanPause = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          spend: 680,
          purchases: 14,
          revenue: 306,
          roas: 0.45,
          cpa: 72,
          ctr: 0.74,
          impressions: 52000,
          clicks: 380,
          previousBudgetCapturedAt: "2026-04-01T00:00:00.000Z",
          previousBidValueCapturedAt: "2026-04-01T00:00:00.000Z",
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    const recentLoser = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          spend: 680,
          purchases: 14,
          revenue: 306,
          roas: 0.45,
          cpa: 72,
          ctr: 0.74,
          impressions: 52000,
          clicks: 380,
          previousBudgetCapturedAt: "2026-04-09T00:00:00.000Z",
          previousBidValueCapturedAt: "2026-04-09T00:00:00.000Z",
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(cleanPause.adSets[0]?.actionType).toBe("pause");
    expect(cleanPause.adSets[0]?.policy.strategyClass).toBe("pause");
    expect(recentLoser.adSets[0]?.actionType).not.toBe("pause");
    expect(recentLoser.adSets[0]?.policy.primaryDriver).toBe("recent_change_cooldown");
  });

  it("builds winner scale candidates and routes budget shifts from active losers into those winners only", () => {
    const snapshot = configuredTruthSnapshot();

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [
        campaign({
          id: "cmp_winner",
          name: "Prospecting Scale Winner",
          spend: 1400,
          revenue: 4900,
          purchases: 44,
          roas: 3.5,
          cpa: 31.8,
        }),
        campaign({
          id: "cmp_loser",
          name: "Prospecting Validation Loser",
          spend: 1250,
          revenue: 520,
          purchases: 16,
          roas: 0.42,
          cpa: 78,
        }),
      ],
      adSets: [
        adSet({
          id: "adset_winner",
          campaignId: "cmp_winner",
          name: "Winner Lane",
          spend: 920,
          purchases: 30,
          revenue: 3864,
          roas: 4.2,
          cpa: 30.67,
          ctr: 1.46,
          impressions: 64000,
          clicks: 980,
        }),
        adSet({
          id: "adset_loser",
          campaignId: "cmp_loser",
          name: "Loser Lane",
          spend: 690,
          purchases: 14,
          revenue: 310,
          roas: 0.45,
          cpa: 73,
          ctr: 0.78,
          impressions: 54000,
          clicks: 390,
          previousBudgetCapturedAt: "2026-04-01T00:00:00.000Z",
          previousBidValueCapturedAt: "2026-04-01T00:00:00.000Z",
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.winnerScaleCandidates).toHaveLength(1);
    expect(result.winnerScaleCandidates[0]).toMatchObject({
      campaignId: "cmp_winner",
      adSetId: "adset_winner",
      policy: {
        strategyClass: "scale_budget",
        winnerState: "scale_candidate",
      },
    });
    expect(result.summary.winnerScaleSummary).toMatchObject({
      candidateCount: 1,
      headline: expect.stringContaining("winner scale candidate"),
    });
    expect(result.summary.opportunitySummary).toMatchObject({
      winnerScaleCount: 2,
      queueEligibleCount: 2,
    });
    expect(
      result.opportunityBoard.some(
        (item) =>
          item.kind === "adset_winner_scale" &&
          item.source.entityId === "adset_winner" &&
          item.queue.eligible,
      ),
    ).toBe(true);
    expect(
      result.opportunityBoard.some(
        (item) =>
          item.kind === "campaign_winner_scale" &&
          item.source.entityId === "cmp_winner" &&
          item.queue.eligible,
      ),
    ).toBe(true);
    expect(result.budgetShifts[0]).toMatchObject({
      fromCampaignId: "cmp_loser",
      toCampaignId: "cmp_winner",
    });
    expect(result.budgetShifts[0]?.provenance).toMatchObject({
      businessId: "biz",
      decisionAsOf: "2026-04-10",
      sourceRowScope: {
        system: "meta",
        entityType: "budget_shift",
        entityId: "cmp_loser:cmp_winner",
      },
      sourceDecisionId: "cmp_loser:cmp_winner:budget_shift",
    });
    expect(result.budgetShifts[0]?.actionFingerprint).toBe(
      result.budgetShifts[0]?.provenance.actionFingerprint,
    );
  });

  it("turns blocked geos into cut decisions and flags placement anomalies", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");
    snapshot.targetPack = {
      targetCpa: 40,
      targetRoas: 2.5,
      breakEvenCpa: 55,
      breakEvenRoas: 1.7,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      sourceLabel: "manual",
      updatedAt: null,
      updatedByUserId: null,
    };
    snapshot.countryEconomics = [
      {
        countryCode: "DE",
        economicsMultiplier: null,
        marginModifier: null,
        serviceability: "blocked",
        priorityTier: "tier_3",
        scaleOverride: "deprioritize",
        notes: null,
        sourceLabel: "manual",
        updatedAt: null,
        updatedByUserId: null,
      },
    ];

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: {
        location: [
          { key: "DE", label: "DE", spend: 320, revenue: 220, purchases: 4, clicks: 80, impressions: 9000 } as any,
        ],
        placement: [
          { key: "feed", label: "Feed", spend: 700, revenue: 900 } as any,
          { key: "reels", label: "Reels", spend: 180, revenue: 900 } as any,
        ],
      },
      commercialTruth: snapshot,
    });

    expect(result.geoDecisions[0]?.action).toBe("cut");
    expect(result.placementAnomalies[0]?.action).toBe("exception_review");
    expect(result.placementAnomalies[0]?.provenance).toMatchObject({
      businessId: "biz",
      decisionAsOf: "2026-04-10",
      sourceRowScope: {
        system: "meta",
        entityType: "placement",
        entityId: "feed",
      },
      sourceDecisionId: "feed:exception_review",
    });
    expect(result.placementAnomalies[0]?.actionFingerprint).toBe(
      result.placementAnomalies[0]?.provenance.actionFingerprint,
    );
  });

  it("builds pooled GEO watchlist clusters from the dedicated country source", () => {
    const snapshot = configuredTruthSnapshot();
    snapshot.countryEconomics = [
      countryEconomics("DE", { priorityTier: "tier_3" }),
      countryEconomics("FR", { priorityTier: "tier_3" }),
    ];
    snapshot.sectionMeta.countryEconomics = {
      configured: true,
      itemCount: 2,
      sourceLabel: "manual",
      updatedAt: "2026-04-09T09:00:00.000Z",
      updatedByUserId: null,
    };

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      geoSource: {
        rows: [
          {
            key: "DE",
            label: "Germany",
            spend: 180,
            revenue: 320,
            purchases: 3,
            clicks: 72,
            impressions: 4200,
          },
          {
            key: "FR",
            label: "France",
            spend: 190,
            revenue: 300,
            purchases: 4,
            clicks: 74,
            impressions: 4300,
          },
        ],
        freshness: {
          dataState: "ready",
          lastSyncedAt: "2026-04-10T06:30:00.000Z",
          isPartial: false,
          verificationState: "finalized_verified",
          reason: "Country-only warehouse rows are serving the GEO board.",
        },
      },
      commercialTruth: snapshot,
    });

    expect(result.geoDecisions).toHaveLength(2);
    expect(result.geoDecisions.every((decision) => decision.action === "pool")).toBe(true);
    expect(result.geoDecisions.every((decision) => decision.grouped)).toBe(true);
    expect(result.geoDecisions[0]?.clusterKey).toBe(result.geoDecisions[1]?.clusterKey);
    expect(result.geoDecisions[0]?.groupMemberCount).toBe(2);
    expect(result.geoDecisions[0]?.groupMemberLabels).toEqual(
      expect.arrayContaining(["France", "Germany"]),
    );
    expect(result.geoDecisions[0]?.materiality).toEqual({
      thinSignal: true,
      material: true,
      archiveContext: false,
    });
    expect(result.summary.geoSummary).toMatchObject({
      actionCoreCount: 0,
      watchlistCount: 2,
      queuedCount: 0,
      pooledClusterCount: 1,
      sourceFreshness: {
        dataState: "ready",
        reason: "Country-only warehouse rows are serving the GEO board.",
      },
      countryEconomics: {
        configured: true,
        updatedAt: "2026-04-09T09:00:00.000Z",
        sourceLabel: "manual",
      },
    });
    expect(
      result.opportunityBoard.find((item) => item.kind === "geo")?.queue.watchReasons[0],
    ).toContain("Thin-signal GEOs");
  });

  it("keeps strong GEOs action-core when country economics are empty and global economics apply", () => {
    const snapshot = configuredTruthSnapshot();

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      geoSource: {
        rows: [
          {
            key: "US",
            label: "United States",
            spend: 720,
            revenue: 2160,
            purchases: 12,
            clicks: 320,
            impressions: 12000,
          },
        ],
        freshness: {
          dataState: "ready",
          lastSyncedAt: "2026-04-10T06:30:00.000Z",
          isPartial: false,
          verificationState: "finalized_verified",
          reason: null,
        },
      },
      commercialTruth: snapshot,
    });

    expect(result.geoDecisions[0]).toMatchObject({
      action: "scale",
      queueEligible: true,
      materiality: {
        thinSignal: false,
        material: true,
        archiveContext: false,
      },
      trust: {
        surfaceLane: "action_core",
        truthState: "live_confident",
        operatorDisposition: "standard",
      },
    });
    expect(result.summary.geoSummary).toMatchObject({
      actionCoreCount: 1,
      watchlistCount: 0,
      queuedCount: 1,
      pooledClusterCount: 0,
    });
  });

  it("keeps decision fingerprints stable when only the analytics window changes", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");
    snapshot.targetPack = {
      targetCpa: 40,
      targetRoas: 2.5,
      breakEvenCpa: 55,
      breakEvenRoas: 1.7,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      sourceLabel: "manual",
      updatedAt: null,
      updatedByUserId: null,
    };

    const april = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      analyticsStartDate: "2026-04-01",
      analyticsEndDate: "2026-04-30",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });
    const march = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      analyticsStartDate: "2026-03-01",
      analyticsEndDate: "2026-03-31",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(april.adSets[0]?.actionType).toBe(march.adSets[0]?.actionType);
    expect(april.adSets[0]?.actionFingerprint).toBe(march.adSets[0]?.actionFingerprint);
    expect(april.adSets[0]?.evidenceHash).toBe(march.adSets[0]?.evidenceHash);
    expect(april.campaigns[0]?.role).toBe(march.campaigns[0]?.role);
    expect(april.decisionWindows.primary30d).toEqual(
      march.decisionWindows.primary30d,
    );
    expect(april.analyticsWindow).toEqual({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      role: "analysis_only",
    });
    expect(march.analyticsWindow).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      role: "analysis_only",
    });
  });

  it("attaches provenance to Meta action rows so downstream queue links can bind to it", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");
    snapshot.targetPack = {
      targetCpa: 40,
      targetRoas: 2.5,
      breakEvenCpa: 55,
      breakEvenRoas: 1.7,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      sourceLabel: "manual",
      updatedAt: null,
      updatedByUserId: null,
    };

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [adSet()],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect((result.adSets[0] as any)?.provenance).toMatchObject({
      businessId: "biz",
      decisionAsOf: "2026-04-10",
      analyticsWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        role: "analysis_only",
      },
      reportingRange: {
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        role: "reporting_context",
      },
      sourceWindow: {
        key: "primary30d",
        startDate: "2026-03-12",
        endDate: "2026-04-10",
        role: "decision_authority",
      },
      sourceRowScope: {
        system: "meta",
        entityType: "adset",
        entityId: "adset_1",
      },
    });
    expect(result.adSets[0]?.actionFingerprint).toBe(
      (result.adSets[0] as any)?.provenance.actionFingerprint,
    );
    expect(result.adSets[0]?.evidenceHash).toBe(
      (result.adSets[0] as any)?.provenance.evidenceHash,
    );
  });

  it("attaches deterministic operator policy to Meta campaign and ad set rows", () => {
    const snapshot = configuredTruthSnapshot();

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          budgetLevel: "adset",
          dailyBudget: 30,
          spend: 900,
          purchases: 30,
          revenue: 3600,
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.adSets[0]?.operatorPolicy).toMatchObject({
      contractVersion: "operator-policy.v1",
      state: "do_now",
      actionClass: "scale",
      pushReadiness: "eligible_for_push_when_enabled",
      queueEligible: true,
    });
    expect(result.campaigns[0]?.operatorPolicy).toMatchObject({
      contractVersion: "operator-policy.v1",
    });
  });

  it("blocks primary ad set scale when the source says campaign budget owns allocation", () => {
    const snapshot = configuredTruthSnapshot();

    const result = buildMetaDecisionOs({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          budgetLevel: "campaign",
          dailyBudget: 30,
          spend: 900,
          purchases: 30,
          revenue: 3600,
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.adSets[0]?.actionType).toBe("scale_budget");
    expect(result.adSets[0]?.operatorPolicy?.state).toBe("blocked");
    expect(result.adSets[0]?.operatorPolicy?.pushReadiness).toBe("blocked_from_push");
    expect(result.adSets[0]?.operatorPolicy?.blockers.join(" ")).toContain(
      "campaign-owned",
    );
  });

  it("keeps Meta operator policy contextual when evidence source is missing", () => {
    const snapshot = configuredTruthSnapshot();

    const result = buildMetaDecisionOsBase({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      decisionAsOf: "2026-04-10",
      campaigns: [campaign()],
      adSets: [
        adSet({
          budgetLevel: "adset",
          dailyBudget: 30,
          spend: 900,
          purchases: 30,
          revenue: 3600,
        }),
      ],
      breakdowns: { location: [], placement: [] },
      commercialTruth: snapshot,
    });

    expect(result.adSets[0]?.operatorPolicy).toMatchObject({
      state: "contextual_only",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
    });
    expect(result.adSets[0]?.operatorPolicy?.missingEvidence).toContain(
      "evidence_source",
    );
    expect(result.adSets[0]?.operatorPolicy?.blockers.join(" ")).toContain(
      "Evidence source is missing",
    );
  });

  it("keeps provenance hashes stable when display evidence formatting changes by locale", () => {
    const snapshot = createEmptyBusinessCommercialTruthSnapshot("biz");
    snapshot.targetPack = {
      targetCpa: 40,
      targetRoas: 2.5,
      breakEvenCpa: 55,
      breakEvenRoas: 1.7,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      sourceLabel: "manual",
      updatedAt: null,
      updatedByUserId: null,
    };
    const originalToLocaleString = Number.prototype.toLocaleString;

    try {
      Number.prototype.toLocaleString = function fakeLocaleA() {
        return `locale-a:${Number(this).toFixed(2)}`;
      };
      const localeA = buildMetaDecisionOs({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        decisionAsOf: "2026-04-10",
        campaigns: [campaign()],
        adSets: [adSet()],
        breakdowns: { location: [], placement: [] },
        commercialTruth: snapshot,
      });

      Number.prototype.toLocaleString = function fakeLocaleB() {
        return `locale-b:${Number(this).toFixed(2)}`;
      };
      const localeB = buildMetaDecisionOs({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        decisionAsOf: "2026-04-10",
        campaigns: [campaign()],
        adSets: [adSet()],
        breakdowns: { location: [], placement: [] },
        commercialTruth: snapshot,
      });

      expect(localeA.campaigns[0]?.evidence).not.toEqual(localeB.campaigns[0]?.evidence);
      expect(localeA.adSets[0]?.evidenceHash).toBe(localeB.adSets[0]?.evidenceHash);
      expect(localeA.adSets[0]?.actionFingerprint).toBe(
        localeB.adSets[0]?.actionFingerprint,
      );
      expect(localeA.campaigns[0]?.evidenceHash).toBe(
        localeB.campaigns[0]?.evidenceHash,
      );
      expect(localeA.campaigns[0]?.actionFingerprint).toBe(
        localeB.campaigns[0]?.actionFingerprint,
      );
    } finally {
      Number.prototype.toLocaleString = originalToLocaleString;
    }
  });
});
