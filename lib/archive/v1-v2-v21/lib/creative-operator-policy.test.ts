import { describe, expect, it } from "vitest";
import { assessCreativeOperatorPolicy } from "@/lib/creative-operator-policy";
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
    sampleSize: 6,
    creativeCount: 6,
    eligibleCreativeCount: 6,
    spendBasis: 960,
    purchaseBasis: 30,
    weightedRoas: 1.75,
    weightedCpa: 32,
    medianRoas: 1.7,
    medianCpa: 24,
    medianSpend: 160,
    missingContext: [],
  };
}

function mediumBaseline(scope: "account" | "campaign" = "account") {
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
    reliability: "medium" as const,
    sampleSize: 6,
    creativeCount: 6,
    eligibleCreativeCount: 6,
    spendBasis: 960,
    purchaseBasis: 30,
    weightedRoas: 1.75,
    weightedCpa: 32,
    medianRoas: 1.7,
    medianCpa: 24,
    medianSpend: 160,
    missingContext: [],
  };
}

function baseInput() {
  return {
    lifecycleState: "scale_ready" as const,
    primaryAction: "promote_to_scaling" as const,
    trust: trust(),
    provenance: provenance(),
    evidenceSource: "live" as const,
    commercialTruthConfigured: true,
    commercialMissingInputs: [],
    relativeBaseline: strongBaseline(),
    benchmark: {
      sampleSize: 4,
      missingContext: [],
    },
    fatigue: {
      status: "none" as const,
      confidence: 0.72,
      evidence: [],
    },
    economics: {
      status: "eligible" as const,
      reasons: [],
    },
    deployment: {
      targetLane: "Scaling",
      queueVerdict: "queue_ready" as const,
      constraints: [],
      compatibility: {
        status: "compatible" as const,
        reasons: [],
      },
    },
    previewStatus: {
      liveDecisionWindow: "ready" as const,
      selectedWindow: "ready" as const,
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

describe("assessCreativeOperatorPolicy", () => {
  it("allows only high-evidence live scale candidates into safe queue", () => {
    const policy = assessCreativeOperatorPolicy(baseInput());

    expect(policy).toMatchObject({
      segment: "scale_ready",
      state: "do_now",
      actionClass: "scale",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
    });
  });

  it("downgrades tiny-spend ROAS spikes instead of marking them scale-ready", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      supportingMetrics: {
        spend: 2,
        purchases: 1,
        impressions: 300,
        roas: 24,
        cpa: 2,
        creativeAgeDays: 2,
      },
    });

    expect(policy.segment).toBe("false_winner_low_evidence");
    expect(policy.state).toBe("watch");
    expect(policy.pushReadiness).not.toBe("safe_to_queue");
    expect(policy.missingEvidence).toContain("evidence_floor");
  });

  it("requires sufficient evidence and commercial truth before kill candidates become primary work", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      economics: {
        status: "blocked",
        reasons: ["CPA is above ceiling."],
      },
      supportingMetrics: {
        spend: 520,
        purchases: 5,
        impressions: 34_000,
        roas: 0.6,
        cpa: 104,
        creativeAgeDays: 31,
      },
    });

    expect(policy.segment).toBe("kill_candidate");
    expect(policy.state).toBe("do_now");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.canApply).toBe(false);
  });

  it("keeps low-spend no-conversion losers in learning instead of kill", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      supportingMetrics: {
        spend: 42,
        purchases: 0,
        impressions: 2_400,
        roas: 0,
        cpa: 0,
        creativeAgeDays: 4,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.state).toBe("watch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
  });

  it("keeps one-purchase positives in Not Enough Data instead of Test More", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...mediumBaseline(),
        spendBasis: 720,
        purchaseBasis: 18,
        weightedRoas: 1.7,
        weightedCpa: 28,
        medianRoas: 1.7,
        medianCpa: 28,
        medianSpend: 120,
      },
      supportingMetrics: {
        spend: 78,
        purchases: 1,
        impressions: 4_200,
        roas: 1.9,
        cpa: 41,
        frequency: 1.2,
        creativeAgeDays: 8,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.state).toBe("watch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("evidence_floor");
  });

  it("keeps under-sampled two-purchase positives in Test More", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...mediumBaseline("campaign"),
        sampleSize: 5,
        creativeCount: 5,
        eligibleCreativeCount: 5,
        spendBasis: 600,
        purchaseBasis: 15,
        weightedRoas: 1.5,
        weightedCpa: 30,
        medianRoas: 1.45,
        medianCpa: 31,
        medianSpend: 120,
      },
      supportingMetrics: {
        spend: 96,
        purchases: 2,
        impressions: 4_800,
        roas: 1.8,
        cpa: 36,
        frequency: 1.3,
        creativeAgeDays: 12,
      },
    });

    expect(policy.segment).toBe("promising_under_sampled");
    expect(policy.state).toBe("watch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("evidence_floor");
  });

  it("keeps thin-spend below-baseline two-purchase rows in Not Enough Data", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...mediumBaseline(),
        medianRoas: 1.7,
        medianCpa: 28,
        medianSpend: 120,
      },
      supportingMetrics: {
        spend: 44,
        purchases: 2,
        impressions: 4_200,
        roas: 0.7,
        cpa: 22,
        frequency: 1.1,
        creativeAgeDays: 8,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("promising_under_sampled");
  });

  it("keeps thin-spend weak-ratio positives out of Test More", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...mediumBaseline(),
        medianRoas: 1.7,
        medianCpa: 28,
        medianSpend: 120,
      },
      supportingMetrics: {
        spend: 59,
        purchases: 2,
        impressions: 4_800,
        roas: 0.76,
        cpa: 29.5,
        frequency: 1.2,
        creativeAgeDays: 11,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("promising_under_sampled");
  });

  it("allows thin-spend strong-relative positives to remain Test More", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...mediumBaseline(),
        medianRoas: 0.8,
        medianCpa: 40,
        medianSpend: 120,
      },
      supportingMetrics: {
        spend: 92,
        purchases: 2,
        impressions: 4_900,
        roas: 2.2,
        cpa: 46,
        frequency: 1.2,
        creativeAgeDays: 12,
      },
    });

    expect(policy.segment).toBe("promising_under_sampled");
  });

  it("allows under-sampled baseline-level positives to remain Test More", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...mediumBaseline(),
        medianRoas: 1.5,
        medianCpa: 34,
        medianSpend: 160,
      },
      supportingMetrics: {
        spend: 100,
        purchases: 3,
        impressions: 4_900,
        roas: 1.52,
        cpa: 33.33,
        frequency: 1.3,
        creativeAgeDays: 12,
      },
    });

    expect(policy.segment).toBe("promising_under_sampled");
  });

  it("routes borderline mature zero-purchase weak cases into Watch instead of Not Enough Data", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 320,
        purchases: 0,
        impressions: 6_500,
        roas: 0,
        cpa: 0,
        frequency: 1.5,
        creativeAgeDays: 18,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.state).toBe("watch");
    expect(policy.missingEvidence).not.toContain("evidence_floor");
  });

  it("routes high-exposure zero-purchase test losers into Cut review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 320,
        purchases: 0,
        impressions: 14_000,
        roas: 0,
        cpa: 0,
        frequency: 1.5,
        creativeAgeDays: 18,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).not.toContain("evidence_floor");
  });

  it("keeps high-exposure zero-purchase rows in Campaign Check when campaign context is blocked", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      deployment: {
        targetLane: "Testing",
        queueVerdict: "board_only" as const,
        constraints: ["Campaign budget learning is still unstable."],
        compatibility: {
          status: "blocked" as const,
          reasons: ["Campaign or ad set context limits this creative interpretation."],
        },
      },
      supportingMetrics: {
        spend: 320,
        purchases: 0,
        impressions: 14_000,
        roas: 0,
        cpa: 0,
        frequency: 1.5,
        creativeAgeDays: 18,
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("routes mature below-baseline purchase losers into Cut review instead of generic Watch", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.82,
        medianSpend: 377.85,
        spendBasis: 18_000,
        purchaseBasis: 160,
        weightedRoas: 1.74,
        weightedCpa: 78,
      },
      supportingMetrics: {
        spend: 6_930.14,
        purchases: 48,
        impressions: 640_000,
        roas: 1.28,
        cpa: 144,
        frequency: 1.9,
        creativeAgeDays: 31,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).not.toContain("commercial_truth");
    expect(policy.requiredEvidence).toContain("sufficient_negative_evidence");
  });

  it("does not route thin below-baseline purchase rows into Cut review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.82,
        medianSpend: 377.85,
      },
      supportingMetrics: {
        spend: 220,
        purchases: 1,
        impressions: 3_200,
        roas: 1.1,
        cpa: 130,
        frequency: 1.4,
        creativeAgeDays: 8,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.state).toBe("watch");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("does not route mature below-baseline purchase rows into Cut review with weak baselines", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "weak",
        sampleSize: 2,
        creativeCount: 2,
        eligibleCreativeCount: 2,
        spendBasis: 900,
        purchaseBasis: 2,
        weightedRoas: 1.82,
        weightedCpa: 120,
        medianRoas: 1.82,
        medianCpa: 118,
        medianSpend: 300,
        missingContext: ["Fewer than 3 eligible peer creatives with spend/revenue signal."],
      },
      supportingMetrics: {
        spend: 2_400,
        purchases: 12,
        impressions: 180_000,
        roas: 1.12,
        cpa: 200,
        frequency: 1.8,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("keeps mature below-baseline purchase losers in Campaign Check when campaign context is blocked", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      deployment: {
        targetLane: "Testing",
        queueVerdict: "board_only" as const,
        constraints: ["Campaign budget learning is still unstable."],
        compatibility: {
          status: "blocked" as const,
          reasons: ["Campaign or ad set context limits this creative interpretation."],
        },
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.82,
        medianSpend: 377.85,
      },
      supportingMetrics: {
        spend: 2_400,
        purchases: 12,
        impressions: 180_000,
        roas: 1.12,
        cpa: 200,
        frequency: 1.8,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("keeps healthy validating rows above baseline out of Cut review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.82,
        medianSpend: 377.85,
      },
      supportingMetrics: {
        spend: 1_600,
        purchases: 12,
        impressions: 120_000,
        roas: 2.05,
        cpa: 133,
        frequency: 1.7,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("protects winners instead of turning short-term volatility into kill work", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
      }),
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.state).toBe("do_not_touch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
  });

  it("routes below-baseline high-CPA stable winners to Watch instead of passive Protect", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.98,
        medianCpa: 2_725.61,
        medianSpend: 8_749.75,
      },
      supportingMetrics: {
        spend: 13_373,
        purchases: 45,
        impressions: 1_892_051,
        roas: 2.62,
        cpa: 4_470,
        frequency: 1.8,
        creativeAgeDays: 38,
        recentRoas: 2.62,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.state).toBe("watch");
    expect(policy.pushReadiness).toBe("read_only_insight");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
  });

  it("keeps below-baseline explicit protected watchlist rows in Protect", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
      }),
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.98,
        medianCpa: 2_725.61,
        medianSpend: 8_749.75,
      },
      supportingMetrics: {
        spend: 13_373,
        purchases: 45,
        impressions: 1_892_051,
        roas: 2.62,
        cpa: 4_470,
        frequency: 1.8,
        creativeAgeDays: 38,
        recentRoas: 2.62,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.state).toBe("do_not_touch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
  });

  it("keeps above-baseline stable no-touch winners in Protect", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.98,
        medianCpa: 2_725.61,
        medianSpend: 8_749.75,
      },
      supportingMetrics: {
        spend: 13_373,
        purchases: 45,
        impressions: 1_892_051,
        roas: 3.12,
        cpa: 2_680,
        frequency: 1.8,
        creativeAgeDays: 38,
        recentRoas: 3.12,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.state).toBe("do_not_touch");
  });

  it("keeps protected winners protected even when commercial truth is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
        truthState: "degraded_missing_truth",
      }),
      supportingMetrics: {
        spend: 190,
        purchases: 3,
        impressions: 12_000,
        roas: 2.1,
        cpa: 38,
        frequency: 1.5,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.state).toBe("do_not_touch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
  });

  it("surfaces expansion-worthy protected winners as review-only Scale Review when business validation is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
        truthState: "degraded_missing_truth",
      }),
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).toContain("commercial_truth");
  });

  it("does not turn expansion-worthy protected winners into Scale when business validation is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
        truthState: "degraded_missing_truth",
      }),
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.segment).not.toBe("scale_ready");
    expect(policy.pushReadiness).not.toBe("safe_to_queue");
  });

  it("keeps partial-commercial-truth rows in Watch when relative strength exists but review floors are not met", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack", "site_health"],
      relativeBaseline: {
        ...mediumBaseline(),
        sampleSize: 8,
        creativeCount: 8,
        eligibleCreativeCount: 8,
        spendBasis: 1_440,
        purchaseBasis: 48,
        weightedRoas: 1.85,
        weightedCpa: 30,
        medianRoas: 1.8,
        medianCpa: 30,
        medianSpend: 180,
      },
      supportingMetrics: {
        spend: 180,
        purchases: 3,
        impressions: 14_000,
        roas: 1.95,
        cpa: 31,
        frequency: 1.6,
        creativeAgeDays: 20,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.state).toBe("watch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).toContain("commercial_truth");
    expect(policy.segment).not.toBe("blocked");
  });

  it("keeps fatigued winners in Refresh review even when commercial truth is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      fatigue: {
        status: "fatigued",
        confidence: 0.84,
        evidence: ["Frequency pressure is high."],
      },
      supportingMetrics: {
        spend: 360,
        purchases: 7,
        impressions: 20_000,
        roas: 1.8,
        cpa: 34,
        frequency: 3.4,
        creativeAgeDays: 28,
      },
    });

    expect(policy.segment).toBe("fatigued_winner");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
  });

  it("keeps strong relative winners review-only when commercial truth is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.missingEvidence).toContain("commercial_truth");
  });

  it("surfaces relative scale review when explicit baseline exists but commercial truth is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...mediumBaseline(),
        sampleSize: 8,
        creativeCount: 8,
        eligibleCreativeCount: 8,
        spendBasis: 1_440,
        purchaseBasis: 48,
        weightedRoas: 1.85,
        weightedCpa: 30,
        medianRoas: 1.8,
        medianCpa: 30,
        medianSpend: 180,
      },
      supportingMetrics: {
        spend: 260,
        purchases: 4,
        impressions: 18_000,
        roas: 3.1,
        cpa: 28,
        frequency: 1.6,
        creativeAgeDays: 22,
      },
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).toContain("commercial_truth");
    expect(policy.reasons.join(" ")).toContain("Missing commercial input");
  });

  it("does not invent scale review when commercial truth and baseline are both missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: null,
    });

    expect(policy.segment).toBe("blocked");
    expect(policy.state).toBe("blocked");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.queueEligible).toBe(false);
    expect(policy.missingEvidence).toContain("relative_baseline");
  });

  it("does not use a weak relative baseline for Scale Review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "weak",
        sampleSize: 2,
        creativeCount: 2,
        eligibleCreativeCount: 2,
        spendBasis: 90,
        purchaseBasis: 2,
        weightedRoas: 1.5,
        weightedCpa: 45,
        medianRoas: 1.5,
        medianCpa: 45,
        medianSpend: 45,
        missingContext: ["Fewer than 3 eligible peer creatives with spend/revenue signal."],
      },
    });

    expect(policy.segment).not.toBe("scale_review");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("relative_baseline");
  });

  it("does not use medium baselines that fail peer-spend or purchase floors for Scale Review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "medium",
        sampleSize: 4,
        creativeCount: 4,
        eligibleCreativeCount: 2,
        spendBasis: 120,
        purchaseBasis: 2,
        weightedRoas: 1.9,
        weightedCpa: 27,
        medianRoas: 1.8,
        medianCpa: 28,
        medianSpend: 60,
        missingContext: [],
      },
      supportingMetrics: {
        spend: 220,
        purchases: 4,
        impressions: 16_000,
        roas: 3.1,
        cpa: 26,
        frequency: 1.5,
        creativeAgeDays: 21,
      },
    });

    expect(policy.segment).not.toBe("scale_review");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("relative_baseline");
  });

  it("keeps full Scale stricter than Scale Review", () => {
    const scale = assessCreativeOperatorPolicy(baseInput());
    const scaleReview = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        ...strongBaseline("campaign"),
        medianCpa: 23,
      },
      supportingMetrics: {
        spend: 300,
        purchases: 5,
        impressions: 22_000,
        roas: 3.2,
        cpa: 27,
        frequency: 1.8,
        creativeAgeDays: 24,
      },
    });

    expect(scale.segment).toBe("scale_ready");
    expect(scale.pushReadiness).toBe("safe_to_queue");
    expect(scale.queueEligible).toBe(true);
    expect(scaleReview.segment).toBe("scale_review");
    expect(scaleReview.pushReadiness).toBe("operator_review_required");
    expect(scaleReview.queueEligible).toBe(false);
  });

  it("keeps strong relative winners in Scale Review until business validation is available", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: strongBaseline(),
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).toContain("commercial_truth");
  });

  it("promotes keep-in-test rows with true-scale evidence and missing business validation into Scale Review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      fatigue: {
        status: "watch",
        confidence: 0.64,
        evidence: ["Frequency pressure is rising."],
      },
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).toContain("commercial_truth");
  });

  it("does not promote keep-in-test rows with weak baselines into Scale Review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "weak",
        sampleSize: 2,
        creativeCount: 2,
        eligibleCreativeCount: 2,
        spendBasis: 90,
        purchaseBasis: 2,
        weightedRoas: 1.5,
        weightedCpa: 45,
        medianRoas: 1.5,
        medianCpa: 45,
        medianSpend: 45,
        missingContext: ["Fewer than 3 eligible peer creatives with spend/revenue signal."],
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.state).toBe("watch");
    expect(policy.segment).not.toBe("scale_review");
  });

  it("keeps keep-in-test relative winners in Campaign Check when campaign context is blocked", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      fatigue: {
        status: "watch",
        confidence: 0.64,
        evidence: ["Frequency pressure is rising."],
      },
      deployment: {
        targetLane: "Scaling",
        queueVerdict: "queue_ready" as const,
        constraints: ["Target ad set is still limited."],
        compatibility: {
          status: "blocked",
          reasons: ["Campaign or ad set context limits this creative interpretation."],
        },
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
    expect(policy.missingEvidence).toContain("commercial_truth");
  });

  it("keeps keep-in-test review-only scale candidates blocked when provenance is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      provenance: null,
      fatigue: {
        status: "watch",
        confidence: 0.64,
        evidence: ["Frequency pressure is rising."],
      },
    });

    expect(policy.segment).toBe("blocked");
    expect(policy.state).toBe("blocked");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("row_provenance");
  });

  it("routes mature trend-collapse creatives to Cut instead of generic Watch", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 420,
        purchases: 7,
        impressions: 29_000,
        roas: 1.25,
        cpa: 60,
        creativeAgeDays: 28,
        recentRoas: 0.42,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
  });

  it("routes trend collapse with fatigue pressure to Refresh instead of Cut", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      fatigue: {
        status: "watch",
        confidence: 0.72,
        evidence: ["Frequency pressure is rising."],
      },
      supportingMetrics: {
        spend: 430,
        purchases: 7,
        impressions: 31_000,
        roas: 1.2,
        cpa: 61,
        creativeAgeDays: 30,
        recentRoas: 0.36,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("routes stable protected winners with recent collapse below baseline to Refresh", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      supportingMetrics: {
        spend: 312,
        purchases: 13,
        impressions: 25_000,
        roas: 1.45,
        cpa: 24,
        creativeAgeDays: 45,
        recentRoas: 0.43,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("routes above-baseline stable winners to Refresh when the recent read collapses below baseline", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.54,
      },
      supportingMetrics: {
        spend: 312,
        purchases: 13,
        impressions: 25_000,
        roas: 7.63,
        cpa: 24,
        recentRoas: 2.27,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.state).toBe("investigate");
  });

  it("routes mild above-baseline stable winners to Refresh at the wider collapse threshold", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2,
      },
      supportingMetrics: {
        spend: 360,
        purchases: 8,
        impressions: 18_000,
        roas: 2.3,
        cpa: 45,
        creativeAgeDays: 32,
        recentRoas: 1.03,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
  });

  it("keeps stronger stable winners protected when the dip only meets the mild threshold", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2,
      },
      supportingMetrics: {
        spend: 360,
        purchases: 8,
        impressions: 18_000,
        roas: 3.6,
        cpa: 45,
        creativeAgeDays: 32,
        recentRoas: 1.62,
      },
    });

    expect(policy.segment).toBe("protected_winner");
  });

  it("keeps mild above-baseline stable winners protected when trend remains above the floor", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2,
      },
      supportingMetrics: {
        spend: 360,
        purchases: 8,
        impressions: 18_000,
        roas: 2.3,
        cpa: 45,
        creativeAgeDays: 32,
        recentRoas: 1.27,
      },
    });

    expect(policy.segment).toBe("protected_winner");
  });

  it("routes fatigued protected winners with recent collapse below baseline to Refresh", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "hold_no_touch",
      supportingMetrics: {
        spend: 445,
        purchases: 5,
        impressions: 34_000,
        roas: 1.4,
        cpa: 89,
        creativeAgeDays: 48,
        recentRoas: 0.12,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("does not cut trend-collapse rows when evidence is still thin", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 80,
        purchases: 1,
        impressions: 2_200,
        roas: 1.2,
        cpa: 80,
        creativeAgeDays: 6,
        recentRoas: 0.25,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.pushReadiness).not.toBe("operator_review_required");
  });

  it("keeps a stable protected winner protected through a short-term dip", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      supportingMetrics: {
        spend: 520,
        purchases: 8,
        impressions: 34_000,
        roas: 1.45,
        cpa: 65,
        creativeAgeDays: 45,
        recentRoas: 0.82,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.state).toBe("do_not_touch");
  });

  it("keeps protected winners with thin trend evidence out of Refresh and Cut", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      supportingMetrics: {
        spend: 180,
        purchases: 3,
        impressions: 4_400,
        roas: 1.2,
        cpa: 60,
        creativeAgeDays: 8,
        recentRoas: 0.12,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.segment).not.toBe("needs_new_variant");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("routes mature CPA blowouts below baseline to Cut", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 590,
        purchases: 1,
        impressions: 17_500,
        roas: 0.65,
        cpa: 590,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.state).toBe("investigate");
  });

  it("routes blocked lifecycle CPA blowouts below baseline to Cut", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      supportingMetrics: {
        spend: 590,
        purchases: 1,
        impressions: 17_500,
        roas: 0.65,
        cpa: 590,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("routes mature one-purchase catastrophic CPA rows to Cut instead of Not Enough Data", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.6,
        medianCpa: 100,
        medianSpend: 150,
      },
      supportingMetrics: {
        spend: 400,
        purchases: 1,
        impressions: 12_000,
        roas: 0.4,
        cpa: 400,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("keeps low-spend one-purchase catastrophic CPA rows conservative", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.6,
        medianCpa: 100,
        medianSpend: 150,
      },
      supportingMetrics: {
        spend: 200,
        purchases: 1,
        impressions: 12_000,
        roas: 0.3,
        cpa: 200,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("keeps one-purchase rows out of Cut when CPA is below the catastrophic threshold", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.6,
        medianCpa: 100,
        medianSpend: 150,
      },
      supportingMetrics: {
        spend: 400,
        purchases: 1,
        impressions: 12_000,
        roas: 0.4,
        cpa: 150,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("does not invent one-purchase catastrophic CPA failures when CPA is unavailable", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.6,
        medianCpa: 100,
        medianSpend: 150,
      },
      supportingMetrics: {
        spend: 400,
        purchases: 1,
        impressions: 12_000,
        roas: 0.4,
        cpa: null,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).not.toBe("spend_waste");
  });

  it("routes fatigued winner CPA blowouts below baseline to Cut instead of soft Refresh", () => {
    const policy = assessCreativeOperatorPolicy({
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

    expect(policy.segment).toBe("spend_waste");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("routes high-spend fatigued CPA blowouts with zero recent read to Cut", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 3.82,
        medianCpa: 74.63,
        medianSpend: 164.53,
      },
      supportingMetrics: {
        spend: 2_397.06,
        purchases: 11,
        impressions: 1_187_216,
        roas: 2.86,
        cpa: 217.91,
        creativeAgeDays: 46,
        recentRoas: 0,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("routes high-spend below-baseline fatigued winners to Cut even without catastrophic CPA", () => {
    const cases = [
      {
        row: "row-041",
        spend: 4_800,
        purchases: 18,
        roas: 1.14,
        cpa: 47,
        medianRoas: 2,
        medianCpa: 42,
        medianSpend: 900,
      },
      {
        row: "row-043",
        spend: 3_900,
        purchases: 14,
        roas: 1.28,
        cpa: 52,
        medianRoas: 2,
        medianCpa: 43,
        medianSpend: 740,
      },
      {
        row: "row-046",
        spend: 5_200,
        purchases: 10,
        roas: 1.36,
        cpa: 128,
        medianRoas: 2,
        medianCpa: 62,
        medianSpend: 900,
      },
      {
        row: "row-078",
        spend: 6_400,
        purchases: 21,
        roas: 1.52,
        cpa: 64,
        medianRoas: 2,
        medianCpa: 58,
        medianSpend: 1_050,
      },
    ];

    for (const target of cases) {
      const policy = assessCreativeOperatorPolicy({
        ...baseInput(),
        lifecycleState: "fatigued_winner",
        primaryAction: "refresh_replace",
        relativeBaseline: {
          ...strongBaseline(),
          medianRoas: target.medianRoas,
          medianCpa: target.medianCpa,
          medianSpend: target.medianSpend,
        },
        supportingMetrics: {
          spend: target.spend,
          purchases: target.purchases,
          impressions: 120_000,
          roas: target.roas,
          cpa: target.cpa,
          creativeAgeDays: 38,
          recentRoas: null,
        },
      });

      expect(policy.segment, target.row).toBe("spend_waste");
      expect(policy.mediaBuyerScorecard?.recommendedSegment, target.row).toBe("Cut");
      expect(policy.mediaBuyerScorecard?.operatorSegment, target.row).toBe("spend_waste");
      expect(policy.mediaBuyerScorecard?.loserSignal, target.row).toBe("cut");
      expect(policy.state, target.row).toBe("investigate");
      expect(policy.pushReadiness, target.row).toBe("operator_review_required");
      expect(policy.queueEligible, target.row).toBe(false);
      expect(policy.canApply, target.row).toBe(false);
    }
  });

  it("keeps fatigued winners in Refresh when CPA and ROAS are near benchmark", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.4,
        medianCpa: 80,
        medianSpend: 300,
      },
      supportingMetrics: {
        spend: 620,
        purchases: 7,
        impressions: 52_000,
        roas: 2.1,
        cpa: 84,
        creativeAgeDays: 35,
        recentRoas: 0.8,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("keeps low-spend fatigued winners in Refresh when the high-spend Cut floor is not met", () => {
    const policy = assessCreativeOperatorPolicy({
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
        spend: 1_200,
        purchases: 6,
        impressions: 45_000,
        roas: 1.2,
        cpa: 58,
        creativeAgeDays: 34,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("fatigued_winner");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("keeps fatigued CPA blowouts in Campaign Check when campaign context is blocked", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      deployment: {
        targetLane: "Testing",
        queueVerdict: "board_only" as const,
        constraints: ["Campaign context limits this creative interpretation."],
        compatibility: {
          status: "blocked" as const,
          reasons: ["Campaign context limits this creative interpretation."],
        },
      },
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

    expect(policy.segment).toBe("investigate");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("keeps high-spend fatigued below-baseline rows in Campaign Check when campaign context is blocked", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      deployment: {
        targetLane: "Testing",
        queueVerdict: "board_only" as const,
        constraints: ["Campaign context limits this creative interpretation."],
        compatibility: {
          status: "blocked" as const,
          reasons: ["Campaign context limits this creative interpretation."],
        },
      },
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

    expect(policy.segment).toBe("investigate");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("does not force fatigued CPA rows to Cut when evidence is thin", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      supportingMetrics: {
        spend: 260,
        purchases: 1,
        impressions: 3_200,
        roas: 0.35,
        cpa: 260,
        creativeAgeDays: 18,
        recentRoas: 0,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("does not invent high-spend fatigued Cut work when benchmark reliability is weak", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "weak",
        sampleSize: 2,
        creativeCount: 2,
        eligibleCreativeCount: 2,
        spendBasis: 1_200,
        purchaseBasis: 2,
        weightedRoas: 2,
        weightedCpa: 42,
        medianRoas: 2,
        medianCpa: 42,
        medianSpend: 900,
        missingContext: ["Fewer than 3 eligible peer creatives."],
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

    expect(policy.segment).toBe("fatigued_winner");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("keeps protected no-touch winners protected unless the fatigued failure gate applies safely", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "hold_no_touch",
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
      }),
      fatigue: {
        status: "fatigued",
        confidence: 0.8,
        evidence: ["Frequency pressure is high."],
      },
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

    expect(policy.segment).toBe("protected_winner");
    expect(policy.segment).not.toBe("spend_waste");
    expect(policy.pushReadiness).toBe("blocked_from_push");
  });

  it("keeps protected refresh-path winners out of the high-spend below-baseline Cut gate", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
      }),
      fatigue: {
        status: "fatigued",
        confidence: 0.8,
        evidence: ["Frequency pressure is high."],
      },
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

    expect(policy.segment).toBe("protected_winner");
    expect(policy.segment).not.toBe("spend_waste");
    expect(policy.pushReadiness).toBe("blocked_from_push");
  });

  it("keeps blocked lifecycle CPA failures conservative when evidence is thin", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      supportingMetrics: {
        spend: 260,
        purchases: 1,
        impressions: 3_200,
        roas: 0.65,
        cpa: 260,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("routes validating rows with baseline-level mid performance and recent collapse to Refresh", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.59,
        medianCpa: 72.2,
        medianSpend: 779.9,
      },
      supportingMetrics: {
        spend: 788.32,
        purchases: 8,
        impressions: 33_939,
        roas: 2.69,
        cpa: 98.54,
        creativeAgeDays: 32,
        recentRoas: 0,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("routes mature validating rows with quarter-trend collapse to Refresh", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2,
        medianCpa: 72,
        medianSpend: 160,
      },
      supportingMetrics: {
        spend: 360,
        purchases: 3,
        impressions: 9_500,
        roas: 2.2,
        cpa: 120,
        creativeAgeDays: 24,
        recentRoas: 0.55,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
  });

  it("routes below-baseline validating rows with zero recent ROAS to Refresh instead of Watch", () => {
    const policy = assessCreativeOperatorPolicy({
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

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.segment).not.toBe("hold_monitor");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
  });

  it("does not refresh below-baseline validating collapse rows when creative age is missing", () => {
    const policy = assessCreativeOperatorPolicy({
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
        creativeAgeDays: undefined,
        recentRoas: 0,
      },
    });

    expect(policy.segment).not.toBe("needs_new_variant");
    expect(policy.segment).toBe("hold_monitor");
  });

  it("keeps stronger below-baseline validating failures in Cut when existing Cut gates apply", () => {
    const policy = assessCreativeOperatorPolicy({
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
        spend: 900,
        purchases: 2,
        impressions: 18_000,
        roas: 0.5,
        cpa: 450,
        creativeAgeDays: 24,
        recentRoas: 0,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.segment).not.toBe("needs_new_variant");
  });

  it("does not refresh below-baseline validating collapse rows with too little evidence", () => {
    const policy = assessCreativeOperatorPolicy({
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
        spend: 220,
        purchases: 1,
        impressions: 11_524,
        roas: 0.64,
        cpa: 220,
        creativeAgeDays: 8,
        recentRoas: 0,
      },
    });

    expect(policy.segment).not.toBe("needs_new_variant");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("keeps campaign context as the blocker for below-baseline validating collapse rows", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      deployment: {
        targetLane: "Validation",
        queueVerdict: "board_only" as const,
        constraints: ["Campaign context limits this creative interpretation."],
        compatibility: {
          status: "blocked" as const,
          reasons: ["Campaign context limits this creative interpretation."],
        },
      },
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

    expect(policy.segment).toBe("investigate");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("keeps very new validating creatives with 7d dips out of Refresh", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.59,
        medianCpa: 72.2,
        medianSpend: 250,
      },
      supportingMetrics: {
        spend: 320,
        purchases: 3,
        impressions: 9_400,
        roas: 2.7,
        cpa: 106.67,
        creativeAgeDays: 4,
        recentRoas: 0,
      },
    });

    expect(policy.segment).toBe("promising_under_sampled");
    expect(policy.segment).not.toBe("needs_new_variant");
  });

  it("keeps under-sampled validating dip rows in learning instead of Refresh", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.59,
        medianCpa: 72.2,
        medianSpend: 250,
      },
      supportingMetrics: {
        spend: 275,
        purchases: 1,
        impressions: 4_800,
        roas: 2.8,
        cpa: 275,
        creativeAgeDays: 18,
        recentRoas: 0,
      },
    });

    expect(policy.segment).toBe("false_winner_low_evidence");
    expect(policy.segment).not.toBe("needs_new_variant");
  });

  it("keeps severe validating trend-collapse failures in Cut when existing loser gates apply", () => {
    const policy = assessCreativeOperatorPolicy({
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

    expect(policy.segment).toBe("spend_waste");
  });

  it("keeps validating rows without recent collapse in Watch or Test More", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.59,
        medianCpa: 72.2,
        medianSpend: 779.9,
      },
      supportingMetrics: {
        spend: 788.32,
        purchases: 8,
        impressions: 33_939,
        roas: 2.69,
        cpa: 98.54,
        creativeAgeDays: 32,
        recentRoas: 2.1,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("needs_new_variant");
  });

  it("does not infer validating trend collapse when 7d ROAS is unavailable", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.59,
        medianCpa: 72.2,
        medianSpend: 779.9,
      },
      supportingMetrics: {
        spend: 788.32,
        purchases: 8,
        impressions: 33_939,
        roas: 2.69,
        cpa: 98.54,
        creativeAgeDays: 32,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("needs_new_variant");
  });

  it("does not treat missing fatigue or frequency evidence as validating trend collapse", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      fatigue: {
        status: "none",
        confidence: 0.4,
        evidence: ["Frequency unavailable"],
      },
      supportingMetrics: {
        spend: 420,
        purchases: 4,
        impressions: 12_000,
        roas: 1.7,
        cpa: 105,
        frequency: null,
        creativeAgeDays: 18,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("needs_new_variant");
  });

  it("does not invent CPA failure when CPA evidence is unavailable", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      supportingMetrics: {
        spend: 590,
        purchases: 3,
        impressions: 17_500,
        roas: 0.65,
        cpa: null,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
  });

  it("does not invent blocked lifecycle CPA failure when CPA evidence is unavailable", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      supportingMetrics: {
        spend: 590,
        purchases: 1,
        impressions: 17_500,
        roas: 0.65,
        cpa: null,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("does not penalize healthy CPA relative to the peer baseline", () => {
    const policy = assessCreativeOperatorPolicy({
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

    expect(policy.segment).toBe("hold_monitor");
  });

  it("does not penalize blocked lifecycle rows with healthy CPA relative to peers", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      supportingMetrics: {
        spend: 590,
        purchases: 1,
        impressions: 17_500,
        roas: 0.65,
        cpa: 22,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("creative_learning_incomplete");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("routes high-spend below-baseline validating rows without 7d data to Cut", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.7,
        medianSpend: 1_000,
      },
      supportingMetrics: {
        spend: 5_500,
        purchases: 10,
        impressions: 280_000,
        roas: 2.0,
        cpa: 550,
        creativeAgeDays: 36,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("spend_waste");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("keeps high-spend below-baseline rows in Campaign Check when campaign context is blocked", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      deployment: {
        targetLane: "Testing",
        queueVerdict: "board_only" as const,
        constraints: ["Campaign context limits this creative interpretation."],
        compatibility: {
          status: "blocked" as const,
          reasons: ["Campaign context limits this creative interpretation."],
        },
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.7,
        medianSpend: 1_000,
      },
      supportingMetrics: {
        spend: 5_500,
        purchases: 10,
        impressions: 280_000,
        roas: 2.0,
        cpa: 550,
        creativeAgeDays: 36,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("does not cut high-spend rows that are above baseline", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.7,
        medianSpend: 1_000,
      },
      supportingMetrics: {
        spend: 5_500,
        purchases: 10,
        impressions: 280_000,
        roas: 3.1,
        cpa: 550,
        creativeAgeDays: 36,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("does not cut protected high-spend winners without collapse evidence", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.7,
        medianSpend: 1_000,
      },
      supportingMetrics: {
        spend: 5_500,
        purchases: 10,
        impressions: 280_000,
        roas: 3.1,
        cpa: 550,
        creativeAgeDays: 36,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("does not use the high-spend Cut path below its spend floor", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.7,
        medianSpend: 1_000,
      },
      supportingMetrics: {
        spend: 900,
        purchases: 10,
        impressions: 80_000,
        roas: 2.0,
        cpa: 90,
        creativeAgeDays: 36,
        recentRoas: null,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("spend_waste");
  });

  it("routes mature high-relative non-test Watch false negatives to review-only Scale Review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
      }),
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized non-test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.8,
        medianCpa: 2_837.63,
        medianSpend: 10_022.46,
      },
      supportingMetrics: {
        spend: 8_749.08,
        purchases: 6,
        impressions: 61_038,
        roas: 7.91,
        cpa: 1_458.18,
        creativeAgeDays: 36,
        recentRoas: 7.91,
      },
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).toContain("business_validation");
    expect(policy.missingEvidence).not.toContain("commercial_truth");
  });

  it("keeps high-relative non-test review candidates out of the true Scale path", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: true,
      commercialMissingInputs: [],
      trust: trust({
        truthState: "live_confident",
        operatorDisposition: "standard",
      }),
      economics: {
        status: "eligible",
        reasons: [],
      },
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized non-test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.8,
        medianCpa: 2_837.63,
        medianSpend: 1_000,
      },
      supportingMetrics: {
        spend: 8_749.08,
        purchases: 8,
        impressions: 61_038,
        roas: 7.91,
        cpa: 1_458.18,
        creativeAgeDays: 36,
        recentRoas: 7.91,
      },
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.segment).not.toBe("scale_ready");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
  });

  it("keeps genuinely ambiguous high-relative non-test rows in Watch", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
      }),
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized non-test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.8,
        medianCpa: 2_837.63,
        medianSpend: 10_022.46,
      },
      supportingMetrics: {
        spend: 8_749.08,
        purchases: 6,
        impressions: 61_038,
        roas: 5.6,
        cpa: 1_458.18,
        creativeAgeDays: 36,
        recentRoas: 5.6,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("scale_review");
  });

  it("does not broadly loosen Scale Review for thin high-relative non-test rows", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
      }),
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized non-test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.8,
        medianCpa: 2_837.63,
        medianSpend: 10_022.46,
      },
      supportingMetrics: {
        spend: 4_500,
        purchases: 5,
        impressions: 61_038,
        roas: 7.91,
        cpa: 900,
        creativeAgeDays: 36,
        recentRoas: 7.91,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("scale_review");
  });

  it("keeps non-test no-touch winners protected instead of using the Watch floor rule", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
      }),
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized non-test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.8,
        medianCpa: 2_837.63,
        medianSpend: 10_022.46,
      },
      supportingMetrics: {
        spend: 8_749.08,
        purchases: 6,
        impressions: 61_038,
        roas: 7.91,
        cpa: 1_458.18,
        creativeAgeDays: 36,
        recentRoas: 7.91,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.segment).not.toBe("scale_review");
  });

  it("keeps campaign context as the primary blocker for high-relative non-test rows", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
      }),
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized non-test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      deployment: {
        targetLane: "Testing",
        queueVerdict: "board_only" as const,
        constraints: ["Campaign context limits this creative interpretation."],
        compatibility: {
          status: "blocked" as const,
          reasons: ["Campaign context limits this creative interpretation."],
        },
      },
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 2.8,
        medianCpa: 2_837.63,
        medianSpend: 10_022.46,
      },
      supportingMetrics: {
        spend: 8_749.08,
        purchases: 6,
        impressions: 61_038,
        roas: 7.91,
        cpa: 1_458.18,
        creativeAgeDays: 36,
        recentRoas: 7.91,
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("routes active test-campaign strong relative winners to Scale Review, not passive Protect", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized creative test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: true,
        activeDelivery: true,
        pausedDelivery: false,
      },
      supportingMetrics: {
        spend: 610,
        purchases: 5,
        impressions: 24_000,
        roas: 2.7,
        cpa: 22,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.missingEvidence).toContain("commercial_truth");
  });

  it("routes active test-campaign moderate relative winners to Test More instead of Protect", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      relativeBaseline: {
        ...strongBaseline(),
        medianRoas: 1.8,
        medianCpa: 110,
        medianSpend: 360,
      },
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: true,
        activeDelivery: true,
        pausedDelivery: false,
      },
      supportingMetrics: {
        spend: 430,
        purchases: 4,
        impressions: 21_000,
        roas: 2.25,
        cpa: 106,
        creativeAgeDays: 21,
      },
    });

    expect(policy.segment).toBe("promising_under_sampled");
    expect(policy.state).toBe("watch");
  });

  it("keeps true no-touch winners protected outside active test campaigns", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      supportingMetrics: {
        spend: 610,
        purchases: 5,
        impressions: 24_000,
        roas: 2.7,
        cpa: 22,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("protected_winner");
  });

  it("does not let active delivery alone trigger active-test campaign overrides", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized evergreen campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      supportingMetrics: {
        spend: 610,
        purchases: 5,
        impressions: 24_000,
        roas: 2.7,
        cpa: 22,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.segment).not.toBe("scale_review");
  });

  it("requires campaignIsTestLike before active relative winners can use test-campaign overrides", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized scaling campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: true,
        pausedDelivery: false,
      },
      supportingMetrics: {
        spend: 430,
        purchases: 4,
        impressions: 21_000,
        roas: 2.25,
        cpa: 20,
        creativeAgeDays: 21,
      },
    });

    expect(policy.segment).toBe("protected_winner");
    expect(policy.segment).not.toBe("promising_under_sampled");
  });

  it("does not trigger active-test overrides for paused test-campaign delivery", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "validating",
      primaryAction: "keep_in_test",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized creative test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: true,
        activeDelivery: false,
        pausedDelivery: true,
      },
      supportingMetrics: {
        spend: 610,
        purchases: 5,
        impressions: 24_000,
        roas: 2.7,
        cpa: 22,
        creativeAgeDays: 24,
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.segment).not.toBe("scale_review");
    expect(policy.segment).not.toBe("promising_under_sampled");
  });

  it("routes active test strong-relative rows with a primary campaign blocker to Campaign Check", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        campaignName: "Sanitized creative test campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: true,
        activeDelivery: true,
        pausedDelivery: false,
      },
      deployment: {
        targetLane: "Scaling",
        queueVerdict: "board_only",
        constraints: ["Campaign context is bid-limited."],
        compatibility: {
          status: "blocked",
          reasons: ["Campaign context is bid-limited."],
        },
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("routes paused historical winners to Retest while staying review-only", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized historical campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      supportingMetrics: {
        spend: 470,
        purchases: 7,
        impressions: 22_000,
        roas: 2.3,
        cpa: 21,
        creativeAgeDays: 60,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
  });

  it("routes paused historical winners with non-hold primary action to Retest", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "keep_in_test",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized historical campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      supportingMetrics: {
        spend: 470,
        purchases: 7,
        impressions: 22_000,
        roas: 2.3,
        cpa: 21,
        creativeAgeDays: 60,
      },
    });

    expect(policy.segment).toBe("needs_new_variant");
    expect(policy.pushReadiness).toBe("operator_review_required");
  });

  it("keeps true refresh cases as Refresh instead of paused Retest", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized historical campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      supportingMetrics: {
        spend: 470,
        purchases: 7,
        impressions: 22_000,
        roas: 2.3,
        cpa: 21,
        creativeAgeDays: 60,
      },
    });

    expect(policy.segment).toBe("fatigued_winner");
    expect(policy.actionClass).toBe("refresh");
  });

  it("does not retest paused weak creatives", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized historical campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      supportingMetrics: {
        spend: 470,
        purchases: 3,
        impressions: 22_000,
        roas: 1.2,
        cpa: 80,
        creativeAgeDays: 60,
      },
    });

    expect(policy.segment).not.toBe("needs_new_variant");
    expect(policy.segment).toBe("protected_winner");
  });

  it("keeps medium-baseline winners in Scale Review instead of promoting them straight to Scale", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      relativeBaseline: mediumBaseline(),
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.state).toBe("investigate");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
  });

  it("does not allow weak business validation to promote a relative winner into Scale", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      economics: {
        status: "guarded",
        reasons: ["Business targets are not cleared yet."],
      },
    });

    expect(policy.segment).toBe("hold_monitor");
    expect(policy.state).toBe("watch");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("business_validation");
  });

  it("keeps cut recognition available without commercial truth while preserving manual safety", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "blocked",
      primaryAction: "block_deploy",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      economics: {
        status: "blocked",
        reasons: ["ROAS is materially weak versus peers."],
      },
      supportingMetrics: {
        spend: 520,
        purchases: 5,
        impressions: 34_000,
        roas: 0.6,
        cpa: 104,
        creativeAgeDays: 31,
      },
    });

    expect(policy.segment).toBe("kill_candidate");
    expect(policy.state).toBe("do_now");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.canApply).toBe(false);
    expect(policy.missingEvidence).not.toContain("commercial_truth");
  });

  it("blocks scale review push readiness when trust metadata is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      trust: null,
      commercialTruthConfigured: false,
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "strong",
        sampleSize: 8,
        creativeCount: 8,
        eligibleCreativeCount: 8,
        spendBasis: 1800,
        purchaseBasis: 60,
        weightedRoas: 1.8,
        weightedCpa: 30,
        medianRoas: 1.8,
        medianCpa: 30,
        medianSpend: 180,
        missingContext: [],
      },
    });

    expect(policy.segment).toBe("blocked");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.blockers).toContain("Decision trust metadata is missing.");
  });

  it("blocks scale review push readiness when provenance is missing", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      provenance: null,
      commercialTruthConfigured: false,
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "strong",
        sampleSize: 8,
        creativeCount: 8,
        eligibleCreativeCount: 8,
        spendBasis: 1800,
        purchaseBasis: 60,
        weightedRoas: 1.8,
        weightedCpa: 30,
        medianRoas: 1.8,
        medianCpa: 30,
        medianSpend: 180,
        missingContext: [],
      },
    });

    expect(policy.segment).toBe("blocked");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.blockers).toContain("Missing decision provenance.");
  });

  it("blocks scale review push readiness on non-live evidence", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      evidenceSource: "snapshot",
      commercialTruthConfigured: false,
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "strong",
        sampleSize: 8,
        creativeCount: 8,
        eligibleCreativeCount: 8,
        spendBasis: 1800,
        purchaseBasis: 60,
        weightedRoas: 1.8,
        weightedCpa: 30,
        medianRoas: 1.8,
        medianCpa: 30,
        medianSpend: 180,
        missingContext: [],
      },
    });

    expect(policy.segment).toBe("contextual_only");
    expect(policy.state).toBe("contextual_only");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.blockers.join(" ")).toContain("snapshot evidence");
  });

  it("routes scale review with blocked campaign or ad set context to Campaign Check instead of review-ready", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      relativeBaseline: {
        scope: "campaign",
        benchmarkKey: "campaign:cmp-1",
        scopeId: "cmp-1",
        source: "explicit_campaign_scope",
        reliability: "medium",
        sampleSize: 6,
        creativeCount: 6,
        eligibleCreativeCount: 6,
        spendBasis: 900,
        purchaseBasis: 30,
        weightedRoas: 1.7,
        weightedCpa: 30,
        medianRoas: 1.7,
        medianCpa: 30,
        medianSpend: 150,
        missingContext: [],
      },
      deployment: {
        ...baseInput().deployment,
        compatibility: {
          status: "blocked",
          reasons: ["No active scaling ad set matched this creative."],
        },
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });

  it("does not let limited deployment target precision hide review-only Scale Review", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      commercialTruthConfigured: false,
      commercialMissingInputs: ["target_pack"],
      trust: trust({
        surfaceLane: "watchlist",
        operatorDisposition: "protected_watchlist",
        truthState: "degraded_missing_truth",
      }),
      deployment: {
        targetLane: "Scaling",
        queueVerdict: "board_only" as const,
        constraints: ["Target precision needs operator review."],
        compatibility: {
          status: "limited",
          reasons: ["No active scaling ad set matched this creative."],
        },
      },
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
    expect(policy.missingEvidence).toContain("commercial_truth");
    expect(policy.missingEvidence).not.toContain("campaign_or_adset_context");
  });

  it("does not treat low-spend creatives with meaningful purchase evidence as ROAS-only noise", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      commercialTruthConfigured: false,
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        source: "account_default",
        reliability: "medium",
        sampleSize: 6,
        creativeCount: 6,
        eligibleCreativeCount: 6,
        spendBasis: 480,
        purchaseBasis: 18,
        weightedRoas: 1.6,
        weightedCpa: 26.67,
        medianRoas: 1.5,
        medianCpa: 28,
        medianSpend: 85,
        missingContext: [],
      },
      supportingMetrics: {
        spend: 95,
        purchases: 3,
        impressions: 6_500,
        roas: 2.8,
        cpa: 31,
        frequency: 1.4,
        creativeAgeDays: 18,
      },
    });

    expect(policy.segment).toBe("scale_review");
    expect(policy.missingEvidence).not.toContain("non_roas_evidence");
    expect(policy.pushReadiness).toBe("operator_review_required");
    expect(policy.queueEligible).toBe(false);
  });

  it("treats demo and snapshot evidence as contextual only", () => {
    for (const evidenceSource of ["demo", "snapshot", "fallback"] as const) {
      const policy = assessCreativeOperatorPolicy({
        ...baseInput(),
        evidenceSource,
      });

      expect(policy.evidenceSource).toBe(evidenceSource);
      expect(policy.state).toBe("contextual_only");
      expect(policy.segment).toBe("contextual_only");
      expect(policy.pushReadiness).toBe("blocked_from_push");
      expect(policy.queueEligible).toBe(false);
    }
  });

  it("fails closed when provenance or evidence source is missing", () => {
    const missingProvenance = assessCreativeOperatorPolicy({
      ...baseInput(),
      provenance: null,
    });
    const missingSource = assessCreativeOperatorPolicy({
      ...baseInput(),
      evidenceSource: "unknown",
    });

    expect(missingProvenance.state).toBe("blocked");
    expect(missingProvenance.pushReadiness).toBe("blocked_from_push");
    expect(missingSource.state).toBe("contextual_only");
    expect(missingSource.pushReadiness).toBe("blocked_from_push");
  });

  it("does not blame strong creative when campaign or ad set context is weak", () => {
    const policy = assessCreativeOperatorPolicy({
      ...baseInput(),
      deployment: {
        targetLane: "Scaling",
        queueVerdict: "board_only",
        constraints: ["Campaign context is bid-limited."],
        compatibility: {
          status: "blocked",
          reasons: ["Campaign context is bid-limited."],
        },
      },
    });

    expect(policy.segment).toBe("investigate");
    expect(policy.state).toBe("blocked");
    expect(policy.pushReadiness).toBe("blocked_from_push");
    expect(policy.missingEvidence).toContain("campaign_or_adset_context");
  });
});
