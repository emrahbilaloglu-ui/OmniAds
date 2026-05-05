import { describe, expect, it } from "vitest";
import {
  buildCreativeMediaBuyerScorecard,
  isCreativeBenchmarkReliableForMediaBuyerScorecard,
} from "@/lib/creative-media-buyer-scoring";
import { assessCreativeOperatorPolicy } from "@/lib/creative-operator-policy";
import type { CreativeOperatorPolicyInput } from "@/lib/creative-operator-policy";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { buildOperatorDecisionProvenance } from "@/lib/operator-decision-provenance";
import type { DecisionTrustMetadata } from "@/src/types/decision-trust";

function provenance() {
  const metadata = buildOperatorDecisionMetadata({
    analyticsStartDate: "2026-04-01",
    analyticsEndDate: "2026-04-10",
    decisionAsOf: "2026-04-10",
  });
  return buildOperatorDecisionProvenance({
    businessId: "biz",
    decisionAsOf: metadata.decisionAsOf,
    analyticsWindow: metadata.analyticsWindow,
    reportingRange: {
      startDate: "2026-04-01",
      endDate: "2026-04-10",
    },
    sourceWindow: metadata.decisionWindows.primary30d,
    sourceRowScope: {
      system: "creative",
      entityType: "creative",
      entityId: "creative-1",
    },
    sourceDecisionId: "creative:creative-1",
    recommendedAction: "promote_to_scaling",
    evidence: {
      lifecycleState: "scale_ready",
      primaryAction: "promote_to_scaling",
      spend: 500,
      purchases: 12,
    },
  });
}

function trust(overrides: Partial<DecisionTrustMetadata> = {}): DecisionTrustMetadata {
  return {
    surfaceLane: "action_core",
    truthState: "live_confident",
    operatorDisposition: "standard",
    reasons: ["Creative evidence is material."],
    evidence: {
      materiality: "material",
      entityState: "active",
      completeness: "complete",
      freshness: {
        status: "fresh",
        updatedAt: "2026-04-10T00:00:00.000Z",
        reason: null,
      },
      suppressed: false,
      suppressionReasons: [],
      aggressiveActionBlocked: false,
      aggressiveActionBlockReasons: [],
    },
    ...overrides,
  };
}

function strongBaseline(scope: "account" | "campaign" = "account") {
  return {
    scope,
    benchmarkKey: scope === "campaign" ? "campaign:cmp-1" : "account:all",
    ...(scope === "campaign"
      ? {
          scopeId: "cmp-1",
          scopeLabel: "Campaign",
          source: "explicit_campaign_scope" as const,
        }
      : {
          source: "account_default" as const,
        }),
    reliability: "strong" as const,
    sampleSize: 8,
    creativeCount: 8,
    eligibleCreativeCount: 8,
    spendBasis: 1_600,
    purchaseBasis: 40,
    weightedRoas: 1.75,
    weightedCpa: 32,
    medianRoas: 1.7,
    medianCpa: 24,
    medianSpend: 160,
    missingContext: [],
  };
}

function baseInput(): CreativeOperatorPolicyInput {
  return {
    lifecycleState: "scale_ready",
    primaryAction: "promote_to_scaling",
    trust: trust(),
    provenance: provenance(),
    evidenceSource: "live",
    commercialTruthConfigured: true,
    commercialMissingInputs: [],
    relativeBaseline: strongBaseline(),
    benchmark: {
      sampleSize: 4,
      missingContext: [],
    },
    fatigue: {
      status: "none",
      confidence: 0.72,
      evidence: [],
    },
    economics: {
      status: "eligible",
      reasons: [],
    },
    deployment: {
      targetLane: "Scaling",
      queueVerdict: "queue_ready",
      constraints: [],
      compatibility: {
        status: "compatible",
        reasons: [],
      },
    },
    deliveryContext: {
      campaignStatus: "ACTIVE",
      adSetStatus: "ACTIVE",
      campaignName: "Account campaign",
      campaignIsTestLike: false,
      activeDelivery: true,
      pausedDelivery: false,
    },
    previewStatus: {
      liveDecisionWindow: "ready",
      selectedWindow: "ready",
      reason: null,
    },
    supportingMetrics: {
      spend: 500,
      purchases: 12,
      impressions: 22_000,
      roas: 3.4,
      cpa: 22,
      frequency: 1.8,
      creativeAgeDays: 24,
    },
  };
}

describe("buildCreativeMediaBuyerScorecard", () => {
  it("routes scale-ready rows to Scale while keeping apply blocked downstream", () => {
    const scorecard = buildCreativeMediaBuyerScorecard(baseInput());
    const policy = assessCreativeOperatorPolicy(baseInput());

    expect(scorecard.recommendedSegment).toBe("Scale");
    expect(scorecard.operatorSegment).toBe("scale_ready");
    expect(scorecard.winnerSignal).toBe("scale");
    expect(scorecard.blockedActions).toContain("apply");
    expect(policy.queueEligible).toBe(true);
    expect(policy.canApply).toBe(false);
  });

  it("routes Scale Review rows to review-only Scale Review when business validation is missing", () => {
    const input = {
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
    };
    const scorecard = buildCreativeMediaBuyerScorecard(input);
    const policy = assessCreativeOperatorPolicy(input);

    expect(scorecard.recommendedSegment).toBe("Scale Review");
    expect(scorecard.operatorSegment).toBe("scale_review");
    expect(scorecard.reviewOnly).toBe(true);
    expect(scorecard.reasons).toContain("business_validation_missing");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
  });

  it("keeps under-sampled positives in Test More rather than Watch", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      supportingMetrics: {
        spend: 96,
        purchases: 2,
        impressions: 4_800,
        roas: 1.8,
        cpa: 36,
        creativeAgeDays: 12,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Test More");
    expect(scorecard.operatorSegment).toBe("promising_under_sampled");
    expect(scorecard.reasons).toContain("low_evidence");
  });

  it("keeps true no-touch winners in Protect", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
      }),
    });

    expect(scorecard.recommendedSegment).toBe("Protect");
    expect(scorecard.operatorSegment).toBe("protected_winner");
  });

  it("routes validating trend-collapse rows to Refresh instead of residual Watch", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.75,
        medianCpa: 122.75,
        medianSpend: 414.33,
      },
      supportingMetrics: {
        spend: 377.85,
        purchases: 2,
        impressions: 11_524,
        roas: 0.64,
        cpa: 188.93,
        creativeAgeDays: 8,
        recentRoas: 0,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Refresh");
    expect(scorecard.operatorSegment).toBe("needs_new_variant");
    expect(scorecard.trendState).toBe("collapsed");
    expect(scorecard.reasons).toContain("trend_collapse");
  });

  it("routes severe validating failures to Cut before Refresh", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 590,
        purchases: 3,
        impressions: 17_500,
        roas: 0.65,
        cpa: 590,
        creativeAgeDays: 24,
        recentRoas: 0,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Cut");
    expect(scorecard.operatorSegment).toBe("spend_waste");
    expect(scorecard.efficiencyRisk).toBe("catastrophic");
  });

  it("routes fatigued catastrophic CPA rows to Cut rather than soft Refresh", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 6.94,
        medianCpa: 19.68,
        medianSpend: 91.29,
      },
      supportingMetrics: {
        spend: 748.67,
        purchases: 3,
        impressions: 1_477_489,
        roas: 0.77,
        cpa: 249.56,
        creativeAgeDays: 42,
        recentRoas: 0,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Cut");
    expect(scorecard.operatorSegment).toBe("spend_waste");
    expect(scorecard.reasons).toContain("catastrophic_cpa");
  });

  it("routes high-spend fatigued below-baseline rows to Cut even without catastrophic CPA", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2,
        medianCpa: 42,
        medianSpend: 900,
      },
      supportingMetrics: {
        spend: 4_800,
        purchases: 18,
        impressions: 120_000,
        roas: 1.14,
        cpa: 47,
        creativeAgeDays: 38,
        recentRoas: null,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Cut");
    expect(scorecard.operatorSegment).toBe("spend_waste");
    expect(scorecard.loserSignal).toBe("cut");
    expect(scorecard.reasons).toContain("below_baseline_waste");
    expect(scorecard.reviewOnly).toBe(true);
    expect(scorecard.blockedActions).toContain("push");
    expect(scorecard.blockedActions).toContain("apply");
  });

  it("routes paused historical winners to Retest with comeback reasons", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "PAUSED",
        campaignName: "Historical campaign",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      supportingMetrics: {
        spend: 600,
        purchases: 8,
        impressions: 25_000,
        roas: 2.2,
        cpa: 22,
        creativeAgeDays: 35,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Retest");
    expect(scorecard.operatorSegment).toBe("needs_new_variant");
    expect(scorecard.reasons).toContain("paused_winner");
  });

  it("routes campaign context blockers to Campaign Check with a diagnostic reason", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      deployment: {
        targetLane: "Scaling",
        queueVerdict: "board_only",
        constraints: ["Campaign context limits this creative interpretation."],
        compatibility: {
          status: "blocked",
          reasons: ["Campaign context limits this creative interpretation."],
        },
      },
    });

    expect(scorecard.recommendedSegment).toBe("Campaign Check");
    expect(scorecard.operatorSegment).toBe("investigate");
    expect(scorecard.reasons).toContain("campaign_context_blocker");
  });

  it("keeps genuinely thin rows in Not Enough Data", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "incubating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 44,
        purchases: 1,
        impressions: 1_500,
        roas: 1.1,
        cpa: 44,
        creativeAgeDays: 3,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Not Enough Data");
    expect(scorecard.operatorSegment).toBe("creative_learning_incomplete");
    expect(scorecard.reasons).toContain("low_evidence");
  });

  it("keeps meaningful but ambiguous rows in the narrow Watch residual bucket", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 590,
        purchases: 10,
        impressions: 17_500,
        roas: 1.9,
        cpa: 22,
        creativeAgeDays: 24,
      },
    });

    expect(scorecard.recommendedSegment).toBe("Watch");
    expect(scorecard.operatorSegment).toBe("hold_monitor");
  });

  it("does not let non-live evidence become push or apply eligible", () => {
    const scorecard = buildCreativeMediaBuyerScorecard({
      ...baseInput(),
      evidenceSource: "snapshot",
    });
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      evidenceSource: "snapshot",
    });

    expect(scorecard.operatorSegment).toBe("contextual_only");
    expect(scorecard.blockedActions).toEqual(["queue", "push", "apply"]);
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
  });

  it("exposes benchmark reliability without treating weak baselines as reliable", () => {
    expect(isCreativeBenchmarkReliableForMediaBuyerScorecard("strong")).toBe(true);
    expect(isCreativeBenchmarkReliableForMediaBuyerScorecard("medium")).toBe(true);
    expect(isCreativeBenchmarkReliableForMediaBuyerScorecard("weak")).toBe(false);
    expect(isCreativeBenchmarkReliableForMediaBuyerScorecard("unavailable")).toBe(false);
  });
});
