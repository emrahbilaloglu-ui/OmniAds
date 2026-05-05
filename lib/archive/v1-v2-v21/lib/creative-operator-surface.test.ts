import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildCreativeOperatorItem,
  buildCreativeOperatorSurfaceModel,
  buildCreativePreviewTruthSummary,
  buildCreativeQuickFilters,
  buildCreativeTaxonomyCounts,
  creativeAuthorityStateLabel,
  creativeBenchmarkReliabilityLabel,
  creativeBusinessValidationNote,
  creativeOperatorSegmentLabel,
  creativeQuickFilterShortLabel,
  resolveCreativeOperatorDecision,
  resolveCreativeQuickFilterKey,
} from "@/lib/creative-operator-surface";

function creativeDecisionOsFixture() {
  return {
    summary: {
      message: "Creative summary message.",
    },
    creatives: [
      {
        creativeId: "promote",
        name: "Promote Winner",
        familyLabel: "Winner Family",
        confidence: 0.88,
        lifecycleState: "scale_ready",
        primaryAction: "promote_to_scaling",
        summary: "Ready for controlled promotion.",
        spend: 520,
        roas: 3.4,
        purchases: 18,
        ctr: 2.4,
        previewStatus: {
          liveDecisionWindow: "ready",
          reason: null,
        },
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          evidence: { materiality: "material" },
        },
        deployment: {
          targetLane: "Scaling",
          constraints: [],
          compatibility: { reasons: [] },
        },
        economics: {
          reasons: [],
        },
      },
      {
        creativeId: "truth",
        name: "Truth Capped",
        familyLabel: "Truth Family",
        confidence: 0.8,
        lifecycleState: "scale_ready",
        primaryAction: "promote_to_scaling",
        summary: "Looks promotable.",
        spend: 410,
        roas: 3.1,
        purchases: 12,
        ctr: 2.1,
        previewStatus: {
          liveDecisionWindow: "ready",
          reason: null,
        },
        trust: {
          surfaceLane: "watchlist",
          truthState: "degraded_missing_truth",
          operatorDisposition: "profitable_truth_capped",
          reasons: ["Commercial truth is incomplete."],
          evidence: {
            materiality: "material",
            aggressiveActionBlockReasons: ["Commercial truth is incomplete."],
          },
        },
        deployment: {
          targetLane: "Scaling",
          constraints: [],
          compatibility: { reasons: [] },
        },
        economics: {
          reasons: [],
        },
      },
      {
        creativeId: "preview",
        name: "Preview Missing",
        familyLabel: "Preview Family",
        confidence: 0.73,
        lifecycleState: "blocked",
        primaryAction: "block_deploy",
        summary: "Cannot review safely.",
        spend: 260,
        roas: 2.2,
        purchases: 6,
        ctr: 1.8,
        previewStatus: {
          liveDecisionWindow: "missing",
          reason: "No trustworthy preview media is available.",
        },
        trust: {
          surfaceLane: "watchlist",
          truthState: "live_confident",
          operatorDisposition: "review_hold",
          evidence: { materiality: "material" },
        },
        deployment: {
          targetLane: null,
          constraints: ["Preview missing."],
          compatibility: { reasons: ["Preview missing."] },
        },
        economics: {
          reasons: [],
        },
      },
      {
        creativeId: "thin",
        name: "Thin Signal",
        familyLabel: "Thin Family",
        confidence: 0.55,
        lifecycleState: "validating",
        primaryAction: "keep_in_test",
        summary: "Still validating.",
        spend: 42,
        roas: 1.5,
        purchases: 1,
        ctr: 0.9,
        previewStatus: {
          liveDecisionWindow: "ready",
          reason: null,
        },
        trust: {
          surfaceLane: "watchlist",
          truthState: "live_confident",
          operatorDisposition: "review_hold",
          evidence: { materiality: "thin_signal" },
        },
        deployment: {
          targetLane: "Testing",
          constraints: [],
          compatibility: { reasons: [] },
        },
        economics: {
          reasons: [],
        },
      },
    ],
  } as any;
}

const diagnosticReasonTags = new Set([
  "campaign_context_blocker",
  "low_evidence",
  "preview_missing",
  "creative_learning_incomplete",
]);

function policyForSegment(segment: string, overrides: Record<string, unknown> = {}) {
  const state =
    segment === "scale_ready"
      ? "do_now"
      : segment === "protected_winner" || segment === "no_touch"
        ? "do_not_touch"
        : segment === "blocked"
          ? "blocked"
          : segment === "contextual_only"
            ? "contextual_only"
            : segment === "hold_monitor" ||
                segment === "promising_under_sampled" ||
                segment === "false_winner_low_evidence" ||
                segment === "creative_learning_incomplete"
              ? "watch"
              : "investigate";
  const actionClass =
    segment === "scale_ready" || segment === "scale_review"
      ? "scale"
      : segment === "protected_winner" || segment === "no_touch"
        ? "protect"
        : segment === "fatigued_winner" || segment === "needs_new_variant"
          ? "refresh"
          : segment === "kill_candidate" || segment === "spend_waste"
            ? "kill"
            : segment === "promising_under_sampled" ||
                segment === "false_winner_low_evidence" ||
                segment === "creative_learning_incomplete"
              ? "test"
              : segment === "investigate" || segment === "blocked" || segment === "contextual_only"
                ? "contextual"
                : "monitor";

  return {
    contractVersion: "operator-policy.v1",
    policyVersion: "creative-operator-policy.v1",
    state,
    segment,
    actionClass,
    evidenceSource: "live",
    pushReadiness:
      segment === "scale_ready"
        ? "safe_to_queue"
        : state === "watch"
          ? "read_only_insight"
          : "operator_review_required",
    queueEligible: segment === "scale_ready",
    canApply: false,
    reasons: ["Resolver test policy."],
    blockers: [],
    missingEvidence: [],
    requiredEvidence: ["row_provenance"],
    explanation: "Resolver test policy.",
    ...overrides,
  };
}

function resolverCreative(overrides: Record<string, unknown> = {}) {
  const fixture = creativeDecisionOsFixture();
  return {
    ...fixture.creatives[0],
    evidenceSource: "live",
    creativeAgeDays: 24,
    impressions: 18_000,
    cpa: 28,
    benchmarkScope: "account",
    benchmarkScopeLabel: "Account-wide",
    benchmarkReliability: "strong",
    relativeBaseline: {
      scope: "account",
      benchmarkKey: "account:all",
      scopeId: null,
      scopeLabel: "Account-wide",
      source: "account_default",
      reliability: "strong",
      sampleSize: 8,
      creativeCount: 8,
      eligibleCreativeCount: 8,
      spendBasis: 2_400,
      purchaseBasis: 40,
      weightedRoas: 2.1,
      weightedCpa: 32,
      medianRoas: 2,
      medianCpa: 34,
      medianSpend: 240,
      missingContext: [],
    },
    benchmark: {
      missingContext: [],
    },
    fatigue: {
      status: "none",
      confidence: 0.2,
      evidence: [],
      missingContext: [],
      frequencyPressure: null,
    },
    deployment: {
      targetLane: "Testing",
      constraints: [],
      compatibility: { status: "compatible", reasons: [] },
    },
    deliveryContext: {
      campaignStatus: "ACTIVE",
      adSetStatus: "ACTIVE",
      campaignIsTestLike: false,
      activeDelivery: true,
      pausedDelivery: false,
    },
    ...overrides,
  } as any;
}

describe("creative operator surface", () => {
  it("maps preview-blocked and truth-capped creatives into explicit operator states", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "do_now",
      segment: "scale_ready",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      reasons: ["Creative evidence is material."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance", "commercial_truth"],
      explanation: "Deterministic Creative policy allows this as operator work.",
    };
    const model = buildCreativeOperatorSurfaceModel(fixture);
    expect(model).not.toBeNull();

    const truth = buildCreativeOperatorItem(fixture.creatives[1]);
    const preview = buildCreativeOperatorItem(fixture.creatives[2]);

    expect(buildCreativeOperatorItem(fixture.creatives[0])).toMatchObject({
      primaryAction: "Scale",
      authorityState: "act_now",
      authorityLabel: "Queue ready",
    });
    expect(truth).toMatchObject({
      id: "truth",
      primaryAction: "Scale",
      authorityState: "watch",
      authorityLabel: "Review only",
    });
    expect(truth.secondaryLabels).toContain("Business target missing");
    expect(preview).toMatchObject({
      id: "preview",
      primaryAction: "Diagnose",
      authorityState: "needs_truth",
      authorityLabel: "Manual review",
    });
    expect(preview.secondaryLabels).toContain("Preview missing");
    expect(model?.hiddenSummary).toContain("thin-signal");
  });

  it("builds quick filters from the unified Creative authority model", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives.push({
      creativeId: "pause",
      name: "Fatigued Winner",
      familyLabel: "Refresh Family",
      confidence: 0.79,
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      summary: "Fatigue is visible and replacement is safer.",
      spend: 360,
      roas: 1.8,
      purchases: 7,
      ctr: 1.4,
      previewStatus: {
        liveDecisionWindow: "ready",
        reason: null,
      },
      trust: {
        surfaceLane: "action_core",
        truthState: "live_confident",
        operatorDisposition: "standard",
        evidence: { materiality: "material" },
      },
      deployment: {
        targetLane: "Testing",
        constraints: [],
        compatibility: { reasons: [] },
      },
      economics: {
        reasons: [],
      },
    });
    fixture.creatives.push({
      creativeId: "protected",
      name: "Protected Winner",
      familyLabel: "Protected Family",
      confidence: 0.84,
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      summary: "Keep this winner protected.",
      spend: 600,
      roas: 3.9,
      purchases: 22,
      ctr: 2.7,
      previewStatus: {
        liveDecisionWindow: "ready",
        reason: null,
      },
      trust: {
        surfaceLane: "watchlist",
        truthState: "live_confident",
        operatorDisposition: "protected_watchlist",
        evidence: { materiality: "material" },
      },
      deployment: {
        targetLane: "Scaling",
        constraints: [],
        compatibility: { reasons: [] },
      },
      economics: {
        reasons: [],
      },
    });

    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "do_now",
      segment: "scale_ready",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      reasons: [],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: [],
      explanation: "Scale.",
    };
    fixture.creatives[1].operatorPolicy = {
      ...fixture.creatives[0].operatorPolicy,
      state: "investigate",
      segment: "scale_review",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      explanation: "Review.",
    };
    fixture.creatives[2].operatorPolicy = {
      ...fixture.creatives[0].operatorPolicy,
      state: "blocked",
      segment: "blocked",
      actionClass: "contextual",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      explanation: "Not eligible.",
    };
    fixture.creatives[3].operatorPolicy = {
      ...fixture.creatives[0].operatorPolicy,
      state: "watch",
      segment: "creative_learning_incomplete",
      actionClass: "test",
      pushReadiness: "read_only_insight",
      queueEligible: false,
      explanation: "Thin.",
    };
    fixture.creatives[4].operatorPolicy = {
      ...fixture.creatives[0].operatorPolicy,
      state: "investigate",
      segment: "fatigued_winner",
      actionClass: "refresh",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      explanation: "Refresh.",
    };
    fixture.creatives[5].operatorPolicy = {
      ...fixture.creatives[0].operatorPolicy,
      state: "do_not_touch",
      segment: "protected_winner",
      actionClass: "protect",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      explanation: "Protect.",
    };

    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("scale");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[1])).toBe("scale");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[2])).toBe("diagnose");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[3])).toBe("diagnose");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[4])).toBe("refresh");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[5])).toBe("protect");

    const filters = buildCreativeQuickFilters(fixture);

    expect(filters.map((filter) => [filter.key, filter.count])).toEqual([
      ["scale", 2],
      ["protect", 1],
      ["refresh", 1],
      ["diagnose", 2],
    ]);
    expect(filters.find((filter) => filter.key === "refresh")?.summary).toContain("new angle");

    const visibleFilters = buildCreativeQuickFilters(fixture, {
      visibleIds: new Set(["promote", "thin"]),
      includeZeroCounts: true,
    });
    const visibleCounts = Object.fromEntries(
      visibleFilters.map((filter) => [filter.key, filter.count]),
    );

    expect(visibleCounts).toMatchObject({
      scale: 1,
      test_more: 0,
      protect: 0,
      refresh: 0,
      cut: 0,
      diagnose: 1,
    });
    expect(visibleFilters.find((filter) => filter.key === "scale")?.creativeIds).toEqual(["promote"]);
    expect(visibleFilters.find((filter) => filter.key === "diagnose")?.creativeIds).toEqual(["thin"]);
    expect(creativeOperatorSegmentLabel(fixture.creatives[1])).toBe("Scale");

    fixture.summary.keepTestingCount = 99;
    fixture.summary.blockedCount = 88;
    const taxonomyCounts = buildCreativeTaxonomyCounts(fixture, {
      quickFilters: visibleFilters,
    });

    expect(taxonomyCounts.map((filter) => [filter.key, filter.count])).toEqual([
      ["scale", 1],
      ["test_more", 0],
      ["protect", 0],
      ["refresh", 0],
      ["cut", 0],
      ["diagnose", 1],
    ]);
  });

  it("adds operator instructions that distinguish watch from scale commands", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].evidenceSource = "live";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "do_now",
      segment: "scale_ready",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      reasons: ["Creative evidence is material."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance", "commercial_truth"],
      explanation: "Deterministic Creative policy allows this as operator work.",
    };
    fixture.creatives[0].deployment.preferredAdSetNames = ["Scale Ad Set"];
    fixture.creatives[0].deployment.preferredCampaignNames = ["Prospecting Scale"];
    fixture.creatives[3].evidenceSource = "live";
    fixture.creatives[3].operatorPolicy = {
      ...fixture.creatives[0].operatorPolicy,
      state: "watch",
      segment: "promising_under_sampled",
      actionClass: "test",
      pushReadiness: "read_only_insight",
      queueEligible: false,
      missingEvidence: ["evidence_floor"],
      requiredEvidence: ["conversion_volume"],
      explanation: "Creative is promising but under-sampled.",
    };

    const scale = buildCreativeOperatorItem(fixture.creatives[0]);
    const watch = buildCreativeOperatorItem(fixture.creatives[3]);

    expect(scale.instruction?.headline).toContain("Scale");
    expect(scale.reason).toContain("Business validation supports a controlled scale move.");
    expect(scale.instruction?.primaryMove).toContain("Scale Ad Set");
    expect(scale.instruction?.amountGuidance.status).toBe("unavailable");
    expect(scale.instruction?.targetContext.status).toBe("available");
    expect(scale.instruction?.targetContext.label).toContain("Scale Ad Set");
    expect(watch.instruction?.instructionKind).toBe("watch");
    expect(watch.instruction?.primaryMove).toContain("Keep testing");
    expect(watch.instruction?.urgency).toBe("watch");
    expect(watch.instruction?.invalidActions.join(" ")).toContain("Do not convert this review-only read");
  });

  it("marks Creative scale targets unavailable when deployment lacks a preferred ad set", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].evidenceSource = "live";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "do_now",
      segment: "scale_ready",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      reasons: ["Creative evidence is material."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance", "commercial_truth"],
      explanation: "Deterministic Creative policy allows this as operator work.",
    };
    fixture.creatives[0].deployment.preferredAdSetNames = [];
    fixture.creatives[0].deployment.preferredCampaignNames = [];

    const scale = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(scale.instruction?.targetContext.status).toBe("unavailable");
    expect(scale.instruction?.targetContext.label).toBe("Target ad set unavailable");
    expect(scale.instruction?.targetContext.reason).toContain("review deployment context");
    expect(scale.instruction?.primaryMove).toContain("target ad set unavailable");
  });

  it("routes weak hold-monitor rows to Diagnose instead of a vague watch bucket", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].evidenceSource = "live";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "watch",
      segment: "hold_monitor",
      actionClass: "monitor",
      evidenceSource: "live",
      pushReadiness: "read_only_insight",
      queueEligible: false,
      canApply: false,
      reasons: ["Continue monitoring without creating a new command."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["stable_next_window"],
      explanation: "This is a monitor hold, not a stop or truth block.",
    };

    const hold = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(hold.primaryAction).toBe("Diagnose");
    expect(hold.instruction?.primaryMove).toContain("Diagnose");
    expect(hold.instruction?.nextObservation.join(" ")).toContain("stable next window");
  });

  it("keeps relative winners visible when business validation does not support direct scale", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].evidenceSource = "live";
    fixture.creatives[0].relativeBaseline = {
      scope: "account",
      benchmarkKey: "account:all",
      scopeId: null,
      scopeLabel: "Account-wide",
      source: "account_default",
      reliability: "strong",
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
    fixture.creatives[0].benchmarkScope = "account";
    fixture.creatives[0].benchmarkScopeLabel = "Account-wide";
    fixture.creatives[0].benchmarkReliability = "strong";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "watch",
      segment: "hold_monitor",
      actionClass: "monitor",
      evidenceSource: "live",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      canApply: false,
      reasons: ["Business targets are not cleared yet."],
      blockers: ["Business validation does not yet support a direct scale move."],
      missingEvidence: ["business_validation"],
      requiredEvidence: ["business_validation", "relative_baseline"],
      explanation: "Business validation does not yet support direct scale.",
    };

    const item = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(item.primaryAction).not.toBe("Watch");
    expect(["Test More", "Diagnose"]).toContain(item.primaryAction);
    expect(item.reason).toContain("Promising relative performer against the Account-wide benchmark.");
    expect(item.reason).toContain("Business validation does not support a direct scale move yet.");
    expect(item.reason).toContain("Business validation does not support");
  });

  it("maps internal creative segments to media-buyer labels", () => {
    const fixture = creativeDecisionOsFixture();
    const basePolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "investigate",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      canApply: false,
      reasons: ["Review manually."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["relative_baseline"],
      explanation: "Review manually.",
    };

    fixture.creatives[0].primaryAction = "promote_to_scaling";
    fixture.creatives[0].operatorPolicy = {
      ...basePolicy,
      segment: "scale_review",
    };
    fixture.creatives[1].primaryAction = "block_deploy";
    fixture.creatives[1].operatorPolicy = {
      ...basePolicy,
      state: "do_now",
      actionClass: "kill",
      pushReadiness: "operator_review_required",
      segment: "kill_candidate",
    };
    fixture.creatives[2].operatorPolicy = {
      ...basePolicy,
      state: "watch",
      actionClass: "test",
      pushReadiness: "read_only_insight",
      segment: "creative_learning_incomplete",
    };

    const scaleReviewItem = buildCreativeOperatorItem(fixture.creatives[0]);
    expect(creativeOperatorSegmentLabel(fixture.creatives[0])).toBe("Scale");
    expect(scaleReviewItem.primaryAction).toBe("Scale");
    expect(scaleReviewItem.authorityLabel).toBe("Review only");
    expect(creativeOperatorSegmentLabel(fixture.creatives[1])).toBe("Cut");
    expect(buildCreativeOperatorItem(fixture.creatives[1]).primaryAction).toBe("Cut");
    expect(creativeOperatorSegmentLabel(fixture.creatives[2])).toBe("Diagnose");
    expect(buildCreativeOperatorItem(fixture.creatives[2]).primaryAction).toBe("Diagnose");
  });

  it("keeps Scale Review rows review-only until business evidence clears", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "investigate",
      segment: "scale_review",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      canApply: false,
      reasons: ["Missing commercial input: target_pack"],
      blockers: [],
      missingEvidence: ["commercial_truth"],
      requiredEvidence: ["commercial_truth", "relative_baseline"],
      explanation: "Review manually before any scale move.",
    };
    fixture.creatives[0].benchmarkScope = "account";
    fixture.creatives[0].benchmarkScopeLabel = "Account-wide";
    fixture.creatives[0].benchmarkReliability = "strong";
    fixture.creatives[0].trust.truthState = "degraded_missing_truth";
    fixture.creatives[0].trust.operatorDisposition = "profitable_truth_capped";

    const review = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(review.primaryAction).toBe("Scale");
    expect(review.authorityState).toBe("watch");
    expect(review.authorityLabel).toBe("Review only");
    expect(review.secondaryLabels).toContain("Business target missing");
    expect(review.reason).toContain("Strong relative performer against the Account-wide benchmark.");
    expect(review.reason).toContain("Business validation is still missing");
    expect(review.instruction?.queueEligible).toBe(false);
    expect(review.instruction?.canApply).toBe(false);
    expect(review.instruction?.headline).toBe("Scale Review: Promote Winner");
    expect(review.instruction?.primaryMove).toContain("relative winner before any scale move");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("scale");
  });

  it("does not promote review-only Scale rows into actionable surface emphasis", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0].evidenceSource = "live";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "investigate",
      segment: "scale_review",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      canApply: false,
      reasons: ["Missing commercial input: target_pack"],
      blockers: [],
      missingEvidence: ["commercial_truth"],
      requiredEvidence: ["commercial_truth", "relative_baseline"],
      explanation: "Review manually before any scale move.",
    };
    fixture.creatives[0].trust.truthState = "degraded_missing_truth";
    fixture.creatives[0].trust.operatorDisposition = "profitable_truth_capped";

    const filters = buildCreativeQuickFilters(fixture, { includeZeroCounts: true });
    const scaleFilter = filters.find((filter) => filter.key === "scale");
    const model = buildCreativeOperatorSurfaceModel(fixture);
    const item = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(scaleFilter).toMatchObject({
      count: 1,
      actionableCount: 0,
      reviewOnlyCount: 1,
      mutedCount: 0,
      tone: "watch",
    });
    expect(scaleFilter?.summary).toContain("require operator review before action");
    expect(item).toMatchObject({
      primaryAction: "Scale",
      authorityState: "watch",
      authorityLabel: "Review only",
    });
    expect(model?.emphasis).not.toBe("act_now");
    expect(model?.headline).toBe("1 Scale candidate needs operator review before action.");
    expect(model?.headline.toLowerCase()).not.toContain("ready");
    expect(model?.note).toContain("No creatives are ready for direct Scale");
  });

  it("separates direct-action Scale rows from review-only Scale rows in surface emphasis", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 2);
    fixture.creatives[0].evidenceSource = "live";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "do_now",
      segment: "scale_ready",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      reasons: ["Creative evidence is material."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance", "commercial_truth"],
      explanation: "Deterministic Creative policy allows this as operator work.",
    };
    fixture.creatives[1].evidenceSource = "live";
    fixture.creatives[1].operatorPolicy = {
      ...fixture.creatives[0].operatorPolicy,
      state: "investigate",
      segment: "scale_review",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      missingEvidence: ["commercial_truth"],
      explanation: "Review manually before any scale move.",
    };

    const filters = buildCreativeQuickFilters(fixture, { includeZeroCounts: true });
    const scaleFilter = filters.find((filter) => filter.key === "scale");
    const model = buildCreativeOperatorSurfaceModel(fixture);

    expect(scaleFilter).toMatchObject({
      count: 2,
      actionableCount: 1,
      reviewOnlyCount: 1,
      mutedCount: 0,
      tone: "act_now",
    });
    expect(model?.emphasis).toBe("act_now");
    expect(model?.headline).toBe("1 creative is ready for direct Scale.");
    expect(model?.note).toContain("1 Scale row is direct-action ready; 1 Scale row needs operator review first.");
    expect(buildCreativeOperatorItem(fixture.creatives[1])).toMatchObject({
      primaryAction: "Scale",
      authorityState: "watch",
      authorityLabel: "Review only",
    });
  });

  it("keeps non-live Scale rows out of actionable Scale emphasis", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0].evidenceSource = "snapshot";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "do_now",
      segment: "scale_ready",
      actionClass: "scale",
      evidenceSource: "snapshot",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      reasons: ["Snapshot evidence cannot authorize action."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance", "commercial_truth"],
      explanation: "Snapshot evidence remains review-only.",
    };

    const filters = buildCreativeQuickFilters(fixture, { includeZeroCounts: true });
    const scaleFilter = filters.find((filter) => filter.key === "scale");
    const model = buildCreativeOperatorSurfaceModel(fixture);
    const item = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(scaleFilter).toMatchObject({
      count: 1,
      actionableCount: 0,
      reviewOnlyCount: 0,
      mutedCount: 1,
      tone: "watch",
    });
    expect(item).toMatchObject({
      primaryAction: "Scale",
      authorityState: "watch",
    });
    expect(model?.emphasis).not.toBe("act_now");
    expect(model?.headline).toBe("1 Scale candidate needs operator review before action.");
  });

  it("keeps protected expansion candidates visible as Scale Review instead of passive Protect", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].primaryAction = "hold_no_touch";
    fixture.creatives[0].lifecycleState = "stable_winner";
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "investigate",
      segment: "scale_review",
      actionClass: "protect",
      evidenceSource: "live",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      canApply: false,
      reasons: ["Missing commercial input: target_pack"],
      blockers: [],
      missingEvidence: ["commercial_truth"],
      requiredEvidence: ["commercial_truth", "relative_baseline"],
      explanation: "Review protected winner before any scale move.",
    };
    fixture.creatives[0].benchmarkScope = "account";
    fixture.creatives[0].benchmarkScopeLabel = "Account-wide";
    fixture.creatives[0].benchmarkReliability = "strong";
    fixture.creatives[0].trust.truthState = "degraded_missing_truth";
    fixture.creatives[0].trust.operatorDisposition = "protected_watchlist";

    const review = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(review.primaryAction).toBe("Scale");
    expect(review.authorityState).toBe("watch");
    expect(review.authorityLabel).toBe("Review only");
    expect(review.reason).toContain("Strong relative performer against the Account-wide benchmark.");
    expect(review.instruction?.primaryMove).toContain("relative winner before any scale move");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("scale");
  });

  it("formats benchmark reliability and business-validation messaging without hiding relative strength", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "investigate",
      segment: "scale_review",
      actionClass: "scale",
      evidenceSource: "live",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      canApply: false,
      reasons: ["Missing commercial input: target_pack"],
      blockers: [],
      missingEvidence: ["commercial_truth"],
      requiredEvidence: ["commercial_truth", "relative_baseline"],
      explanation: "Review manually before any scale move.",
    };
    fixture.creatives[0].benchmarkScope = "campaign";
    fixture.creatives[0].benchmarkScopeLabel = "Spring Prospecting";
    fixture.creatives[0].benchmarkReliability = "medium";
    fixture.creatives[0].trust.truthState = "degraded_missing_truth";
    fixture.creatives[0].trust.operatorDisposition = "profitable_truth_capped";

    expect(creativeBenchmarkReliabilityLabel("strong")).toBe("Strong");
    expect(creativeBenchmarkReliabilityLabel("medium")).toBe("Medium");
    expect(creativeBenchmarkReliabilityLabel("weak")).toBe("Thin");
    expect(creativeBusinessValidationNote(fixture.creatives[0])).toBe(
      "Business validation is still missing, so this stays review-only.",
    );
    expect(buildCreativeOperatorItem(fixture.creatives[0]).reason).toContain(
      "Spring Prospecting benchmark",
    );
  });

  it("maps diagnostic and protected rows into primary decisions", () => {
    const fixture = creativeDecisionOsFixture();
    const basePolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      actionClass: "monitor",
      evidenceSource: "live",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      canApply: false,
      reasons: ["Review before action."],
      blockers: ["Campaign or ad set context limits this creative interpretation."],
      missingEvidence: ["campaign_or_adset_context"],
      requiredEvidence: ["campaign_or_adset_context"],
      explanation: "Campaign or ad set context limits this creative interpretation.",
    };

    fixture.creatives[0].operatorPolicy = {
      ...basePolicy,
      state: "blocked",
      segment: "investigate",
    };
    fixture.creatives[1].operatorPolicy = {
      ...basePolicy,
      state: "watch",
      segment: "creative_learning_incomplete",
      blockers: [],
      missingEvidence: ["evidence_floor"],
      requiredEvidence: ["evidence_floor"],
    };
    fixture.creatives[2].operatorPolicy = {
      ...basePolicy,
      state: "do_not_touch",
      segment: "protected_winner",
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["stable_winner"],
    };

    const campaignCheck = buildCreativeOperatorItem(fixture.creatives[0]);
    const notEnoughData = buildCreativeOperatorItem(fixture.creatives[1]);
    const protect = buildCreativeOperatorItem(fixture.creatives[2]);

    expect(campaignCheck).toMatchObject({
      primaryAction: "Diagnose",
      authorityState: "needs_truth",
      authorityLabel: "Manual review",
    });
    expect(notEnoughData).toMatchObject({
      primaryAction: "Diagnose",
      authorityState: "needs_truth",
    });
    expect(protect).toMatchObject({
      primaryAction: "Protect",
      authorityState: "no_action",
      authorityLabel: "Protect",
    });
    expect(campaignCheck.secondaryLabels).toContain("Campaign context");
    expect(notEnoughData.secondaryLabels).toContain("Learning incomplete");
    expect(protect.authorityState).not.toBe("needs_truth");
  });

  it("aligns row labels with explicit operator segment buckets", () => {
    const fixture = creativeDecisionOsFixture();
    const basePolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      evidenceSource: "live",
      queueEligible: false,
      canApply: false,
      reasons: ["Review before action."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance"],
      explanation: "Review before action.",
    };

    fixture.creatives[0].operatorPolicy = {
      ...basePolicy,
      state: "blocked",
      segment: "investigate",
      actionClass: "monitor",
      pushReadiness: "blocked_from_push",
      blockers: ["Campaign or ad set context limits this creative interpretation."],
      missingEvidence: ["campaign_or_adset_context"],
      requiredEvidence: ["campaign_or_adset_context"],
    };
    fixture.creatives[1].operatorPolicy = {
      ...basePolicy,
      state: "watch",
      segment: "promising_under_sampled",
      actionClass: "test",
      pushReadiness: "blocked_from_push",
      missingEvidence: ["evidence_floor"],
      requiredEvidence: ["evidence_floor"],
      explanation: "Promising but still under-sampled.",
    };
    fixture.creatives[2].operatorPolicy = {
      ...basePolicy,
      state: "watch",
      segment: "creative_learning_incomplete",
      actionClass: "test",
      pushReadiness: "blocked_from_push",
      missingEvidence: ["evidence_floor"],
      requiredEvidence: ["evidence_floor"],
      explanation: "Signal is still too thin.",
    };
    fixture.creatives[3].operatorPolicy = {
      ...basePolicy,
      state: "watch",
      segment: "hold_monitor",
      actionClass: "monitor",
      pushReadiness: "blocked_from_push",
      missingEvidence: ["commercial_truth"],
      requiredEvidence: ["commercial_truth"],
      explanation: "Relative strength exists, but absolute proof is incomplete.",
    };
    fixture.creatives.push({
      ...fixture.creatives[0],
      creativeId: "refresh",
      name: "Fatigued Winner",
      lifecycleState: "fatigued_winner",
      primaryAction: "refresh_replace",
      operatorPolicy: {
        ...basePolicy,
        state: "investigate",
        segment: "fatigued_winner",
        actionClass: "refresh",
        pushReadiness: "operator_review_required",
        explanation: "Refresh the fatigued winner.",
      },
    });
    fixture.creatives.push({
      ...fixture.creatives[0],
      creativeId: "protect",
      name: "Stable Winner",
      lifecycleState: "stable_winner",
      primaryAction: "hold_no_touch",
      operatorPolicy: {
        ...basePolicy,
        state: "do_not_touch",
        segment: "protected_winner",
        actionClass: "protect",
        pushReadiness: "blocked_from_push",
        explanation: "Keep the winner protected.",
      },
    });
    fixture.creatives.push({
      ...fixture.creatives[0],
      creativeId: "retest",
      name: "Comeback Candidate",
      lifecycleState: "comeback_candidate",
      primaryAction: "retest_comeback",
      operatorPolicy: {
        ...basePolicy,
        state: "investigate",
        segment: "needs_new_variant",
        actionClass: "refresh",
        pushReadiness: "operator_review_required",
        explanation: "Retest the comeback candidate.",
      },
    });
    fixture.creatives.push({
      ...fixture.creatives[0],
      creativeId: "ineligible",
      name: "Policy Blocked",
      operatorPolicy: {
        ...basePolicy,
        state: "blocked",
        segment: "blocked",
        actionClass: "contextual",
        pushReadiness: "blocked_from_push",
        blockers: ["Missing decision provenance."],
        missingEvidence: ["row_provenance"],
        requiredEvidence: ["row_provenance"],
        explanation: "Missing decision provenance.",
      },
    });

    const campaignCheck = buildCreativeOperatorItem(fixture.creatives[0]);
    const testMore = buildCreativeOperatorItem(fixture.creatives[1]);
    const notEnoughData = buildCreativeOperatorItem(fixture.creatives[2]);
    const watch = buildCreativeOperatorItem(fixture.creatives[3]);
    const refresh = buildCreativeOperatorItem(fixture.creatives[4]);
    const protect = buildCreativeOperatorItem(fixture.creatives[5]);
    const retest = buildCreativeOperatorItem(fixture.creatives[6]);
    const blocked = buildCreativeOperatorItem(fixture.creatives[7]);
    const model = buildCreativeOperatorSurfaceModel(fixture);

    expect(campaignCheck).toMatchObject({
      primaryAction: "Diagnose",
      authorityState: "needs_truth",
      authorityLabel: "Manual review",
    });
    expect(testMore).toMatchObject({
      primaryAction: "Test More",
      authorityState: "watch",
      authorityLabel: "Test More",
    });
    expect(notEnoughData).toMatchObject({
      primaryAction: "Diagnose",
      authorityState: "needs_truth",
      authorityLabel: "Manual review",
    });
    expect(watch).toMatchObject({
      primaryAction: "Diagnose",
      authorityState: "needs_truth",
      authorityLabel: "Manual review",
    });
    expect(refresh).toMatchObject({
      primaryAction: "Refresh",
      authorityState: "blocked",
      authorityLabel: "Refresh",
    });
    expect(protect).toMatchObject({
      primaryAction: "Protect",
      authorityState: "no_action",
      authorityLabel: "Protect",
    });
    expect(retest).toMatchObject({
      primaryAction: "Refresh",
      authorityState: "blocked",
      authorityLabel: "Revive",
    });
    expect(blocked).toMatchObject({
      primaryAction: "Diagnose",
      authorityState: "needs_truth",
      authorityLabel: "Manual review",
    });
    expect(model?.buckets.map((bucket) => bucket.label)).toEqual([
      "Scale review-only / Test More",
      "Refresh / Cut",
      "Diagnose",
      "Protect",
    ]);
  });

  it("surfaces paused historical winners as Refresh with revive tone when policy asks for a new variant review", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "hold_no_touch",
      lifecycleState: "stable_winner",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized historical campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "investigate",
        segment: "needs_new_variant",
        actionClass: "variant",
        evidenceSource: "live",
        pushReadiness: "operator_review_required",
        queueEligible: false,
        canApply: false,
        reasons: ["Paused historical winner should be revived."],
        blockers: [],
        missingEvidence: [],
        requiredEvidence: ["row_provenance"],
        explanation: "Revive paused winner.",
      },
    };

    const item = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(item.primaryAction).toBe("Refresh");
    expect(item.authorityLabel).toBe("Revive");
    expect(item.secondaryLabels).toContain("Paused winner");
    expect(item.reason).toContain("controlled comeback refresh");
    expect(item.instruction?.nextObservation.join(" ")).toContain("controlled test");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("refresh");
  });

  it("surfaces paused historical winners as Refresh even when primary action is not hold", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "keep_in_test",
      lifecycleState: "stable_winner",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized historical campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "investigate",
        segment: "needs_new_variant",
        actionClass: "variant",
        evidenceSource: "live",
        pushReadiness: "operator_review_required",
        queueEligible: false,
        canApply: false,
        reasons: ["Paused historical winner should be revived."],
        blockers: [],
        missingEvidence: [],
        requiredEvidence: ["row_provenance"],
        explanation: "Revive paused winner.",
      },
    };

    const item = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(item.primaryAction).toBe("Refresh");
    expect(item.authorityLabel).toBe("Revive");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("refresh");
  });

  it("keeps true paused refresh cases labeled as Refresh", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "refresh_replace",
      lifecycleState: "fatigued_winner",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignName: "Sanitized historical campaign",
        adSetName: "Sanitized ad set",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "investigate",
        segment: "needs_new_variant",
        actionClass: "refresh",
        evidenceSource: "live",
        pushReadiness: "operator_review_required",
        queueEligible: false,
        canApply: false,
        reasons: ["Fatigue still needs a refresh."],
        blockers: [],
        missingEvidence: [],
        requiredEvidence: ["row_provenance"],
        explanation: "Refresh paused creative.",
      },
    };

    const item = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(item.primaryAction).toBe("Refresh");
    expect(item.authorityLabel).toBe("Refresh");
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("refresh");
  });

  it("explains mature zero-purchase weak rows as Diagnose instead of early learning", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      spend: 360,
      roas: 0,
      purchases: 0,
      impressions: 18_000,
      creativeAgeDays: 18,
      summary: "Still under observation.",
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "watch",
        segment: "hold_monitor",
        actionClass: "monitor",
        evidenceSource: "live",
        pushReadiness: "read_only_insight",
        queueEligible: false,
        canApply: false,
        reasons: ["Conversion proof is still missing."],
        blockers: [],
        missingEvidence: [],
        requiredEvidence: ["row_provenance"],
        explanation: "Watch this mature weak case.",
      },
    };

    const item = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(item.primaryAction).toBe("Diagnose");
    expect(item.authorityState).toBe("needs_truth");
    expect(item.reason).toContain("move past early learning");
    expect(item.reason).toContain("no purchase proof");
    expect(item.instruction?.primaryMove).toContain("Diagnose");
    expect(item.instruction?.nextObservation.join(" ")).toContain("Confirm purchase evidence");
  });

  it("labels high-exposure zero-purchase test losers as Cut review work", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      spend: 360,
      roas: 0,
      purchases: 0,
      impressions: 18_000,
      creativeAgeDays: 18,
      summary: "Spend is mature without conversion proof.",
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "investigate",
        segment: "spend_waste",
        actionClass: "test",
        evidenceSource: "live",
        pushReadiness: "operator_review_required",
        queueEligible: false,
        canApply: false,
        reasons: ["Conversion proof is still missing."],
        blockers: [],
        missingEvidence: [],
        requiredEvidence: ["sufficient_negative_evidence"],
        explanation: "Review this mature weak case as spend waste.",
      },
    };

    const cut = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(cut.primaryAction).toBe("Cut");
    expect(cut.authorityState).toBe("blocked");
    expect(cut.authorityLabel).toBe("Manual review");
    expect(cut.reason).toContain("Cut candidate for operator review");
    expect(cut.instruction?.primaryMove).toContain("before cut");
    expect(cut.instruction?.nextObservation.join(" ")).toContain(
      "Confirm there is no purchase evidence",
    );
    expect(cut.instruction?.queueEligible).toBe(false);
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("cut");
  });

  it("labels mature below-baseline purchase losers as Cut review work", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      spend: 6_930.14,
      roas: 1.28,
      purchases: 48,
      impressions: 640_000,
      creativeAgeDays: 31,
      benchmarkScope: "account",
      benchmarkScopeLabel: "Account-wide",
      benchmarkReliability: "strong",
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        scopeId: null,
        scopeLabel: "Account-wide",
        source: "account_default",
        reliability: "strong",
        sampleSize: 10,
        creativeCount: 10,
        eligibleCreativeCount: 10,
        spendBasis: 18_000,
        purchaseBasis: 160,
        weightedRoas: 1.74,
        weightedCpa: 78,
        medianRoas: 1.82,
        medianCpa: 80,
        medianSpend: 377.85,
        missingContext: [],
      },
      summary: "Meaningful purchase volume but materially below benchmark.",
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "investigate",
        segment: "spend_waste",
        actionClass: "test",
        evidenceSource: "live",
        pushReadiness: "operator_review_required",
        queueEligible: false,
        canApply: false,
        reasons: ["Below account benchmark after meaningful spend."],
        blockers: [],
        missingEvidence: [],
        requiredEvidence: ["sufficient_negative_evidence", "relative_baseline"],
        explanation: "Review this mature below-baseline case as spend waste.",
      },
    };

    const cut = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(cut.primaryAction).toBe("Cut");
    expect(cut.authorityState).toBe("blocked");
    expect(cut.authorityLabel).toBe("Manual review");
    expect(cut.reason).toContain("ROAS is materially below the Account-wide benchmark");
    expect(cut.instruction?.primaryMove).toContain("before cut");
    expect(cut.instruction?.nextObservation.join(" ")).toContain("below-benchmark read");
    expect(cut.instruction?.queueEligible).toBe(false);
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("cut");
  });

  it("explains below-baseline validating collapse rows as Refresh review work", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      spend: 377.85,
      roas: 0.64,
      purchases: 2,
      impressions: 11_524,
      creativeAgeDays: 8,
      benchmarkScope: "account",
      benchmarkScopeLabel: "Account-wide",
      benchmarkReliability: "strong",
      relativeBaseline: {
        scope: "account",
        benchmarkKey: "account:all",
        scopeId: null,
        scopeLabel: "Account-wide",
        source: "account_default",
        reliability: "strong",
        sampleSize: 26,
        creativeCount: 39,
        eligibleCreativeCount: 26,
        spendBasis: 27_053.93,
        purchaseBasis: 220,
        weightedRoas: 1.65,
        weightedCpa: 122.97,
        medianRoas: 1.74,
        medianCpa: 124.84,
        medianSpend: 414.33,
        missingContext: [],
      },
      summary: "Deterministic engine keeps this in test against the format benchmark.",
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "investigate",
        segment: "needs_new_variant",
        actionClass: "test",
        evidenceSource: "live",
        pushReadiness: "operator_review_required",
        queueEligible: false,
        canApply: false,
        reasons: ["Below account benchmark with recent collapse."],
        blockers: [],
        missingEvidence: [],
        requiredEvidence: ["sufficient_negative_evidence", "relative_baseline"],
        explanation: "Review this below-baseline collapse as refresh work.",
      },
    };

    const refresh = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(refresh.primaryAction).toBe("Refresh");
    expect(refresh.authorityState).toBe("blocked");
    expect(refresh.authorityLabel).toBe("Refresh");
    expect(refresh.reason).toContain("materially below the Account-wide benchmark");
    expect(refresh.reason).toContain("Refresh candidate");
    expect(refresh.instruction?.primaryMove).toContain("before refresh");
    expect(refresh.instruction?.nextObservation.join(" ")).toContain(
      "below-benchmark collapse",
    );
    expect(refresh.instruction?.queueEligible).toBe(false);
    expect(resolveCreativeQuickFilterKey(fixture.creatives[0])).toBe("refresh");
  });

  it("adds a fatigue caveat to Test More without changing the main outcome", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      spend: 110,
      roas: 2.4,
      purchases: 2,
      impressions: 5_800,
      creativeAgeDays: 12,
      summary: "Promising but still light.",
      fatigue: {
        status: "watch",
        confidence: 0.64,
        ctrDecay: null,
        clickToPurchaseDecay: null,
        roasDecay: null,
        spendConcentration: null,
        frequencyPressure: 2.4,
        winnerMemory: false,
        evidence: ["Frequency pressure is rising."],
        missingContext: [],
      },
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "watch",
        segment: "promising_under_sampled",
        actionClass: "test",
        evidenceSource: "live",
        pushReadiness: "read_only_insight",
        queueEligible: false,
        canApply: false,
        reasons: ["Promising but still under-sampled."],
        blockers: [],
        missingEvidence: ["evidence_floor"],
        requiredEvidence: ["evidence_floor"],
        explanation: "Keep testing while evidence matures.",
      },
    };

    const testMore = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(testMore.primaryAction).toBe("Test More");
    expect(testMore.authorityState).toBe("watch");
    expect(testMore.reason).toContain("monitoring fatigue pressure");
    expect(testMore.instruction?.primaryMove).toContain("monitor fatigue pressure");
    expect(testMore.instruction?.queueEligible).toBe(false);
  });

  it("does not attach a fatigue caveat to Test More when frequency is only unavailable", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0] = {
      ...fixture.creatives[0],
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      spend: 110,
      roas: 2.4,
      purchases: 2,
      impressions: 5_800,
      creativeAgeDays: 12,
      summary: "Promising but still light.",
      fatigue: {
        status: "none",
        confidence: 0.18,
        ctrDecay: null,
        clickToPurchaseDecay: null,
        roasDecay: null,
        spendConcentration: null,
        frequencyPressure: null,
        winnerMemory: false,
        evidence: [],
        missingContext: ["Frequency unavailable"],
      },
      operatorPolicy: {
        contractVersion: "operator-policy.v1",
        policyVersion: "creative-operator-policy.v1",
        state: "watch",
        segment: "promising_under_sampled",
        actionClass: "test",
        evidenceSource: "live",
        pushReadiness: "read_only_insight",
        queueEligible: false,
        canApply: false,
        reasons: ["Promising but still under-sampled."],
        blockers: [],
        missingEvidence: ["evidence_floor"],
        requiredEvidence: ["evidence_floor"],
        explanation: "Keep testing while evidence matures.",
      },
    };

    const testMore = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(testMore.primaryAction).toBe("Test More");
    expect(testMore.authorityState).toBe("watch");
    expect(testMore.reason).not.toContain("monitoring fatigue pressure");
    expect(testMore.instruction?.primaryMove).not.toContain("monitor fatigue pressure");
    expect(testMore.instruction?.nextObservation.join(" ")).toContain("Frequency unavailable");
  });

  it("routes policy and contextual ineligible rows to Diagnose", () => {
    const fixture = creativeDecisionOsFixture();
    const basePolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      actionClass: "contextual",
      evidenceSource: "live",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      canApply: false,
      reasons: ["Missing decision provenance."],
      blockers: ["Missing decision provenance."],
      missingEvidence: ["row_provenance"],
      requiredEvidence: ["row_provenance"],
      explanation: "Missing decision provenance.",
    };

    fixture.creatives[0].operatorPolicy = {
      ...basePolicy,
      state: "blocked",
      segment: "blocked",
    };
    fixture.creatives[1].operatorPolicy = {
      ...basePolicy,
      state: "contextual_only",
      segment: "contextual_only",
      evidenceSource: "snapshot",
      blockers: ["snapshot evidence is contextual and cannot authorize primary Creative action."],
    };
    fixture.creatives[2].operatorPolicy = {
      ...basePolicy,
      state: "watch",
      segment: "creative_learning_incomplete",
      actionClass: "test",
      evidenceSource: "live",
      blockers: [],
      missingEvidence: ["evidence_floor"],
      requiredEvidence: ["evidence_floor"],
      explanation: "Creative evidence is thin.",
    };

    const blocked = buildCreativeOperatorItem(fixture.creatives[0]);
    const contextual = buildCreativeOperatorItem(fixture.creatives[1]);
    const thin = buildCreativeOperatorItem(fixture.creatives[2]);

    expect(blocked.primaryAction).toBe("Diagnose");
    expect(contextual.primaryAction).toBe("Diagnose");
    expect(thin.primaryAction).toBe("Diagnose");
    expect(blocked.secondaryLabels).toContain("Low evidence");
    expect(contextual.secondaryLabels).toContain("Low evidence");
    expect(thin.secondaryLabels).toContain("Learning incomplete");
  });

  it("uses explicit operator language when blocked rows are context checks or refresh reviews", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives = fixture.creatives.slice(0, 1);
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "blocked",
      segment: "investigate",
      actionClass: "monitor",
      evidenceSource: "live",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      canApply: false,
      reasons: ["Campaign context is missing."],
      blockers: ["Campaign or ad set context limits this creative interpretation."],
      missingEvidence: ["campaign_or_adset_context"],
      requiredEvidence: ["campaign_or_adset_context"],
      explanation: "Campaign context is missing.",
    };

    const model = buildCreativeOperatorSurfaceModel(fixture);

    expect(model?.headline).toBe("1 creative needs diagnosis before a clean action.");
    expect(model?.buckets[0]).toMatchObject({
      key: "needs_truth",
      label: "Diagnose",
    });
  });

  it("uses frequency pressure to raise fatigued winner urgency without changing safety gates", () => {
    const fixture = creativeDecisionOsFixture();
    fixture.creatives[0].primaryAction = "refresh_replace";
    fixture.creatives[0].lifecycleState = "fatigued_winner";
    fixture.creatives[0].fatigue = {
      status: "fatigued",
      confidence: 0.84,
      ctrDecay: null,
      clickToPurchaseDecay: null,
      roasDecay: null,
      spendConcentration: null,
      frequencyPressure: 3.4,
      winnerMemory: true,
      evidence: ["Frequency pressure is high."],
      missingContext: [],
    };
    fixture.creatives[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      policyVersion: "creative-operator-policy.v1",
      state: "do_now",
      segment: "fatigued_winner",
      actionClass: "refresh",
      evidenceSource: "live",
      pushReadiness: "operator_review_required",
      queueEligible: false,
      canApply: false,
      reasons: ["Frequency pressure is high."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance"],
      explanation: "Request a creative refresh review.",
    };

    const refresh = buildCreativeOperatorItem(fixture.creatives[0]);

    expect(refresh.instruction?.urgency).toBe("high");
    expect(refresh.instruction?.urgencyReason).toContain("Frequency pressure");
    expect(refresh.instruction?.queueEligible).toBe(false);
  });

  it("builds explicit preview truth summaries for the current review scope", () => {
    const fixture = creativeDecisionOsFixture();

    const overall = buildCreativePreviewTruthSummary(fixture);
    const scoped = buildCreativePreviewTruthSummary(fixture, {
      creativeIds: ["preview"],
    });

    expect(overall).toMatchObject({
      state: "degraded",
      readyCount: 3,
      missingCount: 1,
    });
    expect(scoped).toMatchObject({
      state: "missing",
      headline: "Preview truth is missing across this review scope.",
    });
    expect(creativeAuthorityStateLabel("watch")).toBe("Scale review-only / Test More");
    expect(creativeAuthorityStateLabel("no_action")).toBe("Protect");
    expect(creativeAuthorityStateLabel("needs_truth")).toBe("Diagnose");
    expect(creativeAuthorityStateLabel("blocked")).toBe("Refresh / Cut");
  });

  it("exposes agreed operator taxonomy labels for performance quick filters", () => {
    const labels = [
      "scale",
      "test_more",
      "protect",
      "refresh",
      "cut",
      "diagnose",
    ].map((key) => creativeQuickFilterShortLabel(key as any));

    expect(labels).toEqual([
      "Scale",
      "Test More",
      "Protect",
      "Refresh",
      "Cut",
      "Diagnose",
    ]);
    expect(labels).not.toEqual(
      expect.arrayContaining([
        "Scale Review",
        "Watch",
        "Retest",
        "Campaign Check",
        "Not Enough Data",
        "Review",
        "Check",
        "Hold",
        "Evergreen",
      ]),
    );
  });

  it("resolves current Creative segments into six primary operator decisions with reason tags", () => {
    const scaleReady = resolverCreative({
      operatorPolicy: policyForSegment("scale_ready"),
    });
    const scaleReview = resolverCreative({
      trust: {
        surfaceLane: "watchlist",
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
        evidence: { materiality: "material" },
      },
      operatorPolicy: policyForSegment("scale_review", {
        pushReadiness: "operator_review_required",
        queueEligible: false,
        missingEvidence: ["commercial_truth", "business_validation"],
      }),
    });
    const testMore = resolverCreative({
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      operatorPolicy: policyForSegment("promising_under_sampled", {
        missingEvidence: ["evidence_floor"],
      }),
    });
    const protect = resolverCreative({
      primaryAction: "hold_no_touch",
      lifecycleState: "stable_winner",
      operatorPolicy: policyForSegment("protected_winner"),
    });
    const promisingWatch = resolverCreative({
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      operatorPolicy: policyForSegment("hold_monitor", {
        missingEvidence: ["evidence_floor"],
      }),
    });
    const collapsedWatch = resolverCreative({
      primaryAction: "keep_in_test",
      lifecycleState: "validating",
      recentRoas: 0,
      roas: 2.2,
      operatorPolicy: policyForSegment("hold_monitor", {
        reasons: ["Trend collapse is visible in the recent window."],
      }),
    });
    const contextWatch = resolverCreative({
      operatorPolicy: policyForSegment("hold_monitor", {
        blockers: ["Campaign or ad set context limits this creative interpretation."],
        missingEvidence: ["campaign_or_adset_context"],
      }),
      deployment: {
        targetLane: "Testing",
        constraints: [],
        compatibility: {
          status: "blocked",
          reasons: ["Campaign or ad set context limits this creative interpretation."],
        },
      },
    });
    const refresh = resolverCreative({
      primaryAction: "refresh_replace",
      lifecycleState: "fatigued_winner",
      fatigue: {
        status: "fatigued",
        confidence: 0.8,
        evidence: ["Frequency pressure is high."],
        missingContext: [],
        frequencyPressure: 3.4,
      },
      operatorPolicy: policyForSegment("fatigued_winner"),
    });
    const retest = resolverCreative({
      primaryAction: "hold_no_touch",
      lifecycleState: "stable_winner",
      deliveryContext: {
        campaignStatus: "PAUSED",
        adSetStatus: "CAMPAIGN_PAUSED",
        campaignIsTestLike: false,
        activeDelivery: false,
        pausedDelivery: true,
      },
      operatorPolicy: policyForSegment("needs_new_variant"),
    });
    const cut = resolverCreative({
      primaryAction: "block_deploy",
      lifecycleState: "retired",
      cpa: 90,
      roas: 0.5,
      operatorPolicy: policyForSegment("spend_waste"),
    });
    const campaignCheck = resolverCreative({
      operatorPolicy: policyForSegment("investigate", {
        blockers: ["Campaign or ad set context limits this creative interpretation."],
        missingEvidence: ["campaign_or_adset_context"],
      }),
    });
    const notEnoughData = resolverCreative({
      spend: 44,
      purchases: 0,
      impressions: 2_000,
      creativeAgeDays: 4,
      operatorPolicy: policyForSegment("creative_learning_incomplete", {
        missingEvidence: ["evidence_floor"],
      }),
    });

    expect(resolveCreativeOperatorDecision(scaleReady)).toMatchObject({
      primary: "scale",
      subTone: "queue_ready",
      reasons: expect.arrayContaining(["strong_relative_winner"]),
    });
    expect(resolveCreativeOperatorDecision(scaleReview)).toMatchObject({
      primary: "scale",
      subTone: "review_only",
      reasons: expect.arrayContaining([
        "strong_relative_winner",
        "business_validation_missing",
      ]),
    });
    expect(resolveCreativeOperatorDecision(testMore).primary).toBe("test_more");
    expect(resolveCreativeOperatorDecision(protect).primary).toBe("protect");

    const promisingWatchDecision = resolveCreativeOperatorDecision(promisingWatch);
    expect(["test_more", "diagnose"]).toContain(promisingWatchDecision.primary);
    expect(promisingWatchDecision.primary).not.toBe("watch");

    expect(resolveCreativeOperatorDecision(collapsedWatch)).toMatchObject({
      primary: "refresh",
      reasons: expect.arrayContaining(["trend_collapse"]),
    });
    expect(resolveCreativeOperatorDecision(contextWatch)).toMatchObject({
      primary: "diagnose",
      reasons: expect.arrayContaining(["campaign_context_blocker"]),
    });
    expect(resolveCreativeOperatorDecision(refresh)).toMatchObject({
      primary: "refresh",
      reasons: expect.arrayContaining(["fatigue_pressure"]),
    });
    expect(resolveCreativeOperatorDecision(retest)).toMatchObject({
      primary: "refresh",
      subTone: "revive",
      reasons: expect.arrayContaining(["paused_winner"]),
    });
    expect(resolveCreativeOperatorDecision(cut)).toMatchObject({
      primary: "cut",
      reasons: expect.arrayContaining(["catastrophic_cpa"]),
    });
    expect(resolveCreativeOperatorDecision(campaignCheck)).toMatchObject({
      primary: "diagnose",
      reasons: expect.arrayContaining(["campaign_context_blocker"]),
    });

    const notEnoughDataDecision = resolveCreativeOperatorDecision(notEnoughData);
    expect(["diagnose", "test_more"]).toContain(notEnoughDataDecision.primary);
    expect(notEnoughDataDecision.reasons).toEqual(
      expect.arrayContaining(["creative_learning_incomplete"]),
    );
    if (notEnoughDataDecision.primary === "diagnose") {
      expect(notEnoughDataDecision.reasons.some((reason) => diagnosticReasonTags.has(reason))).toBe(true);
    }
  });

  it("keeps resolver output parallel to queue and push safety", () => {
    const reviewOnly = resolverCreative({
      trust: {
        surfaceLane: "watchlist",
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
        evidence: { materiality: "material" },
      },
      operatorPolicy: policyForSegment("scale_review", {
        pushReadiness: "operator_review_required",
        queueEligible: false,
        canApply: false,
        missingEvidence: ["commercial_truth", "business_validation"],
      }),
    });
    const fallback = resolverCreative({
      evidenceSource: "fallback",
      operatorPolicy: policyForSegment("contextual_only", {
        evidenceSource: "fallback",
        state: "contextual_only",
        pushReadiness: "blocked_from_push",
        queueEligible: false,
        canApply: false,
      }),
    });
    const missingReasonDiagnose = resolverCreative({
      operatorPolicy: policyForSegment("investigate", {
        blockers: [],
        missingEvidence: [],
        requiredEvidence: [],
      }),
    });

    const reviewOnlyDecision = resolveCreativeOperatorDecision(reviewOnly);
    const fallbackDecision = resolveCreativeOperatorDecision(fallback);
    const diagnoseDecision = resolveCreativeOperatorDecision(missingReasonDiagnose);

    expect(reviewOnlyDecision).toMatchObject({
      primary: "scale",
      subTone: "review_only",
    });
    expect(reviewOnly.operatorPolicy.pushReadiness).toBe("operator_review_required");
    expect(reviewOnly.operatorPolicy.queueEligible).toBe(false);
    expect(reviewOnly.operatorPolicy.canApply).toBe(false);

    expect(fallbackDecision.primary).toBe("diagnose");
    expect(fallback.operatorPolicy.pushReadiness).toBe("blocked_from_push");
    expect(fallback.operatorPolicy.queueEligible).toBe(false);
    expect(fallback.operatorPolicy.canApply).toBe(false);

    expect(diagnoseDecision.primary).toBe("diagnose");
    expect(diagnoseDecision.reasons.some((reason) => diagnosticReasonTags.has(reason))).toBe(true);
  });

  it("resolves the sanitized live-firm audit fixture without reintroducing Watch as a primary", () => {
    const fixturePath = path.join(
      process.cwd(),
      "docs/operator-policy/creative-segmentation-recovery/reports/live-firm-audit/artifacts/sanitized-live-firm-audit.json",
    );
    const artifact = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      rows: Array<Record<string, any>>;
    };

    expect(artifact.rows.length).toBeGreaterThan(0);

    for (const row of artifact.rows) {
      const internalSegment = row.currentDecisionOsInternalSegment;
      const baseline = row.accountBaseline ?? row.campaignBaseline ?? null;
      const auditCreative = resolverCreative({
        creativeId: row.creativeAlias,
        name: row.creativeAlias,
        creativeAgeDays: 30,
        spend: row.spend30d ?? row.mid30d?.spend ?? 0,
        purchaseValue: row.mid30d?.purchaseValue ?? 0,
        roas: row.mid30d?.roas ?? 0,
        cpa: row.mid30d?.cpa ?? 0,
        purchases: row.mid30d?.purchases ?? 0,
        impressions: row.mid30d?.impressions ?? 0,
        evidenceSource: row.evidenceSource ?? "live",
        lifecycleState: row.lifecycleState ?? "validating",
        primaryAction: row.primaryAction ?? "keep_in_test",
        summary: row.reasonSummary ?? "",
        relativeBaseline: baseline,
        benchmarkScope: row.benchmarkScope,
        benchmarkScopeLabel: row.benchmarkScopeLabel,
        benchmarkReliability: row.baselineReliability,
        benchmark: {
          missingContext: baseline?.missingContext ?? [],
        },
        previewStatus: {
          liveDecisionWindow: row.previewWindow ?? "ready",
          reason: null,
        },
        trust: {
          surfaceLane: row.activeStatus ? "action_core" : "watchlist",
          truthState: row.trustState ?? "live_confident",
          operatorDisposition:
            row.businessValidationStatus === "missing"
              ? "profitable_truth_capped"
              : "standard",
          evidence: { materiality: "material" },
        },
        deployment: {
          targetLane: row.deploymentTargetLane ?? null,
          constraints: [],
          compatibility: {
            status: row.deploymentCompatibility ?? "compatible",
            reasons: row.campaignContextLimited
              ? ["Campaign or ad set context limits this creative interpretation."]
              : [],
          },
        },
        deliveryContext: {
          campaignStatus: row.campaignStatus ?? null,
          adSetStatus: row.adSetStatus ?? null,
          campaignIsTestLike: false,
          activeDelivery: Boolean(row.activeStatus),
          pausedDelivery:
            row.campaignStatus === "PAUSED" || row.adSetStatus === "CAMPAIGN_PAUSED",
        },
        operatorPolicy: policyForSegment(internalSegment, {
          evidenceSource: row.evidenceSource ?? "live",
          pushReadiness: row.pushReadiness ?? "blocked_from_push",
          queueEligible: Boolean(row.queueEligible),
          canApply: Boolean(row.canApply),
          reasons: [row.reasonSummary].filter(Boolean),
          blockers: row.campaignContextLimited
            ? ["Campaign or ad set context limits this creative interpretation."]
            : [],
          missingEvidence:
            row.currentUserFacingSegment === "Not Enough Data"
              ? ["evidence_floor"]
              : row.currentUserFacingSegment === "Scale Review"
                ? ["business_validation"]
                : [],
          explanation: row.reasonSummary ?? "Sanitized live audit row.",
        }),
      });

      const decision = resolveCreativeOperatorDecision(auditCreative);
      expect([
        "scale",
        "test_more",
        "protect",
        "refresh",
        "cut",
        "diagnose",
      ]).toContain(decision.primary);

      if (internalSegment === "scale_ready" || internalSegment === "scale_review") {
        expect(decision.primary).toBe("scale");
      }
      if (internalSegment === "spend_waste" || internalSegment === "kill_candidate") {
        expect(decision.primary).toBe("cut");
      }
      if (internalSegment === "protected_winner" || internalSegment === "no_touch") {
        expect(decision.primary).toBe("protect");
      }
      if (internalSegment === "fatigued_winner" || internalSegment === "needs_new_variant") {
        expect(decision.primary).toBe("refresh");
      }
      if (internalSegment === "promising_under_sampled") {
        expect(decision.primary).toBe("test_more");
      }
      if (internalSegment === "hold_monitor") {
        expect(["test_more", "refresh", "cut", "diagnose"]).toContain(decision.primary);
      }
      if (decision.primary === "diagnose") {
        expect(decision.reasons.some((reason) => diagnosticReasonTags.has(reason))).toBe(true);
      }
      if (internalSegment === "scale_review") {
        expect(decision.subTone).toBe("review_only");
        expect(auditCreative.operatorPolicy.queueEligible).toBe(false);
        expect(auditCreative.operatorPolicy.canApply).toBe(false);
      }
    }
  });
});
