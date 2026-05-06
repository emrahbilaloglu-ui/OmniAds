import { describe, expect, it } from "vitest";
import {
  applyCommandCenterQueueSelection,
  aggregateCommandCenterActions,
  buildCommandCenterOpportunities,
  buildCommandCenterDefaultQueueSummary,
  buildCommandCenterOwnerWorkload,
  buildCommandCenterShiftDigest,
  buildCommandCenterViewStacks,
  canTransitionCommandCenterStatus,
  decorateCommandCenterActionsWithThroughput,
  filterCommandCenterActionsByView,
  getBuiltInCommandCenterSavedViews,
  resolveNextCommandCenterStatus,
  sanitizeCommandCenterSavedViewDefinition,
  summarizeCommandCenterFeedback,
} from "@/lib/command-center";
import type {
  CommandCenterAction,
  CommandCenterActionStateRecord,
  CommandCenterFeedbackEntry,
  CommandCenterSavedView,
} from "@/lib/command-center";
import type { CreativeDecisionOsV1Response } from "@/lib/creative-decision-os";
import type { CreativeOperatorPolicyAssessment } from "@/lib/creative-operator-policy";
import type { MetaDecisionOsV1Response } from "@/lib/meta/decision-os";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { buildOperatorDecisionProvenance } from "@/lib/operator-decision-provenance";
import type { DecisionPolicyExplanation } from "@/src/types/decision-trust";
import type { OperatorPolicyAssessment } from "@/src/types/operator-decision";

function decisionMetadata() {
  return buildOperatorDecisionMetadata({
    analyticsStartDate: "2026-04-01",
    analyticsEndDate: "2026-04-10",
    decisionAsOf: "2026-04-10",
  });
}

function sourceHealthFixture() {
  return [
    {
      source: "Commercial truth",
      status: "healthy" as const,
      detail: "Commercial truth is configured for this surface.",
      fallbackLabel: null,
    },
  ];
}

function readReliabilityFixture() {
  return {
    status: "stable" as const,
    determinism: "stable" as const,
    detail: "Repeated reads should stay stable for this surface.",
  };
}

function benchmarkScopeFixture() {
  return {
    benchmarkScope: "account" as const,
    benchmarkScopeLabel: "Account-wide",
    benchmarkSource: "account_default" as const,
    benchmarkScopeId: null,
    benchmarkReliability: "medium" as const,
  };
}

function relativeBaselineFixture() {
  return {
    scope: "account" as const,
    benchmarkKey: "account:all",
    scopeId: null,
    scopeLabel: "Account-wide",
    source: "account_default" as const,
    reliability: "medium" as const,
    sampleSize: 8,
    creativeCount: 8,
    eligibleCreativeCount: 8,
    spendBasis: 1200,
    purchaseBasis: 40,
    weightedRoas: 2.1,
    weightedCpa: 30,
    medianRoas: 2,
    medianCpa: 30,
    medianSpend: 150,
    missingContext: [],
  };
}

function queueEligibilityFixture(input?: {
  eligible?: boolean;
  blockedReasons?: string[];
  watchReasons?: string[];
  verdict?: "queue_ready" | "board_only" | "protected" | "blocked";
}) {
  const blockedReasons = input?.blockedReasons ?? [];
  const watchReasons = input?.watchReasons ?? [];
  return {
    eligible:
      input?.eligible ?? (blockedReasons.length === 0 && watchReasons.length === 0),
    blockedReasons,
    watchReasons,
    eligibilityTrace: {
      verdict:
        input?.verdict ??
        (blockedReasons.length === 0 && watchReasons.length === 0
          ? "queue_ready"
          : blockedReasons.some((reason) => reason.toLowerCase().includes("protect"))
            ? "protected"
            : watchReasons.length > 0
              ? "board_only"
              : "blocked"),
      evidenceFloors: {
        met: [],
        watch: [],
        blocked: blockedReasons,
      },
      sharedTruthBlockers: [],
      queueCompilerDecision: "Fixture queue compiler decision.",
      protectedReasons: blockedReasons.filter((reason) =>
        reason.toLowerCase().includes("protect"),
      ),
      blockedReasons,
      watchReasons,
    },
  };
}

function rowProvenanceFixture(input: {
  system: "meta" | "creative";
  entityType: "campaign" | "adset" | "geo" | "creative" | "budget_shift" | "placement";
  entityId: string;
  sourceDecisionId: string;
  recommendedAction: string;
}) {
  const metadata = decisionMetadata();
  const provenance = buildOperatorDecisionProvenance({
    businessId: "biz",
    decisionAsOf: metadata.decisionAsOf,
    analyticsWindow: metadata.analyticsWindow,
    sourceWindow: metadata.decisionWindows.primary30d,
    sourceRowScope: {
      system: input.system,
      entityType: input.entityType,
      entityId: input.entityId,
    },
    sourceDecisionId: input.sourceDecisionId,
    recommendedAction: input.recommendedAction,
    evidence: [`${input.entityId}:${input.recommendedAction}`],
  });
  return {
    provenance,
    evidenceHash: provenance.evidenceHash,
    actionFingerprint: provenance.actionFingerprint,
  };
}

function blockedOperatorPolicy(
  overrides: Partial<OperatorPolicyAssessment> = {},
): OperatorPolicyAssessment {
  return {
    contractVersion: "operator-policy.v1",
    state: "blocked",
    actionClass: "scale",
    pushReadiness: "blocked_from_push",
    queueEligible: false,
    canApply: false,
    reasons: ["Policy blocks this action."],
    blockers: ["Budget is not the binding constraint."],
    missingEvidence: ["budget_binding_evidence"],
    requiredEvidence: ["budget_binding_evidence"],
    explanation: "Budget is not the binding constraint.",
    ...overrides,
  };
}

function creativeOperatorPolicy(
  overrides: Partial<CreativeOperatorPolicyAssessment> = {},
): CreativeOperatorPolicyAssessment {
  return {
    contractVersion: "operator-policy.v1",
    policyVersion: "creative-operator-policy.v1",
    state: "do_now",
    segment: "scale_ready",
    actionClass: "scale",
    evidenceSource: "live",
    pushReadiness: "safe_to_queue",
    queueEligible: true,
    canApply: false,
    reasons: ["Creative policy allows manual queue work."],
    blockers: [],
    missingEvidence: [],
    requiredEvidence: ["row_provenance", "commercial_truth"],
    explanation:
      "Deterministic Creative policy allows this as operator work, but provider push remains disabled.",
    ...overrides,
  };
}

function metaFixture(): MetaDecisionOsV1Response {
  const metadata = decisionMetadata();
  const metaPolicyExplanation: DecisionPolicyExplanation = {
    summary: "Shared policy ladder kept scale budget active for this Meta lane.",
    evidenceHits: [
      {
        key: "objective_family",
        label: "Objective family",
        status: "met",
        current: "sales",
        required: "policy-compatible objective",
        reason: null,
      },
    ],
    missingEvidence: [],
    blockers: [],
    degradedReasons: ["target_pack"],
    actionCeiling: "No scale promotion until degraded commercial truth is restored.",
    protectedWinnerHandling: null,
    fatigueOrComeback: null,
    supplyPlanning: null,
    compare: {
      compareMode: true,
      baselineAction: "scale_budget",
      candidateAction: "scale_budget",
      selectedAction: "scale_budget",
      cutoverState: "matched",
      reason:
        "Candidate ladder matched the baseline action, so no cutover guard was needed.",
    },
  };
  return {
    contractVersion: "meta-decision-os.v1",
    generatedAt: "2026-04-10T00:00:00.000Z",
    businessId: "biz",
    startDate: "2026-04-01",
    endDate: "2026-04-10",
    analyticsWindow: metadata.analyticsWindow,
    decisionWindows: metadata.decisionWindows,
    historicalMemory: metadata.historicalMemory,
    decisionAsOf: metadata.decisionAsOf,
    summary: {
      todayPlanHeadline: "Today plan",
      todayPlan: ["Shift budget", "Review geo"],
      budgetShiftSummary: "1 shift",
      noTouchSummary: "1 no touch",
      winnerScaleSummary: {
        candidateCount: 1,
        protectedCount: 1,
        headline: "1 active winner scale candidate is ready for controlled growth.",
      },
      operatingMode: {
        currentMode: "Stabilize",
        recommendedMode: "Exploit",
        confidence: 0.84,
      },
      confidence: 0.82,
      sourceHealth: sourceHealthFixture(),
      readReliability: readReliabilityFixture(),
      surfaceSummary: {
        actionCoreCount: 3,
        watchlistCount: 2,
        archiveCount: 0,
        degradedCount: 1,
      },
      opportunitySummary: {
        totalCount: 3,
        queueEligibleCount: 2,
        geoCount: 1,
        winnerScaleCount: 1,
        protectedCount: 1,
        headline: "2 opportunity-board items are ready before it needs queue promotion.",
      },
      geoSummary: {
        actionCoreCount: 1,
        watchlistCount: 0,
        queuedCount: 1,
        pooledClusterCount: 0,
        sourceFreshness: {
          dataState: "ready",
          lastSyncedAt: "2026-04-10T06:30:00.000Z",
          isPartial: false,
          verificationState: "finalized_verified",
          reason: null,
        },
        countryEconomics: {
          configured: true,
          updatedAt: "2026-04-09T09:00:00.000Z",
          sourceLabel: "manual",
        },
      },
    },
    campaigns: [],
    adSets: [
      {
        decisionId: "adset:1",
        adSetId: "adset_1",
        adSetName: "Prospecting A",
        campaignId: "cmp_1",
        campaignName: "Promo Spring",
        actionType: "scale_budget",
        actionSize: "medium",
        priority: "high",
        confidence: 0.9,
        reasons: ["ROAS is beating target."],
        guardrails: ["Scale in controlled steps."],
        relatedCreativeNeeds: [],
        relatedGeoContext: [],
        supportingMetrics: {
          spend: 500,
          revenue: 1800,
          roas: 3.6,
          cpa: 20,
          ctr: 1.8,
          purchases: 25,
          impressions: 10000,
          clicks: 180,
          bidStrategyLabel: null,
          optimizationGoal: "PURCHASE",
          dailyBudget: 200,
          lifetimeBudget: null,
        },
        whatWouldChangeThisDecision: [],
        noTouch: false,
        policy: {
          strategyClass: "scale_budget",
          objectiveFamily: "sales",
          bidRegime: "open",
          primaryDriver: "roas_outperforming",
          secondaryDrivers: ["signal_density"],
          winnerState: "scale_candidate",
          explanation: metaPolicyExplanation,
        },
        trust: {
          surfaceLane: "action_core",
          truthState: "degraded_missing_truth",
          operatorDisposition: "degraded_no_scale",
          reasons: ["Commercial truth is incomplete."],
        },
        ...rowProvenanceFixture({
          system: "meta",
          entityType: "adset",
          entityId: "adset_1",
          sourceDecisionId: "adset:1",
          recommendedAction: "scale_budget",
        }),
      },
    ],
    budgetShifts: [
      {
        fromCampaignId: "cmp_2",
        fromCampaignName: "Validation",
        toCampaignId: "cmp_1",
        toCampaignName: "Promo Spring",
        from: "Validation",
        to: "Promo Spring",
        whyNow: "Scale demand is clean.",
        riskLevel: "medium",
        expectedBenefit: "Move budget to stronger lane.",
        suggestedMoveBand: "$250-$400",
        confidence: 0.77,
        guardrails: ["Keep donor alive."],
        ...rowProvenanceFixture({
          system: "meta",
          entityType: "budget_shift",
          entityId: "cmp_2:cmp_1",
          sourceDecisionId: "cmp_2:cmp_1:budget_shift",
          recommendedAction: "budget_shift",
        }),
      },
    ],
    geoDecisions: [
      {
        geoKey: "geo:us",
        countryCode: "US",
        label: "United States",
        action: "scale",
        queueEligible: true,
        confidence: 0.76,
        why: "US is outperforming.",
        evidence: [{ label: "ROAS", value: "3.2x", impact: "positive" }],
        guardrails: ["Do not cut CA yet."],
        whatWouldChangeThisDecision: [],
        clusterKey: null,
        clusterLabel: null,
        grouped: false,
        groupMemberCount: 1,
        groupMemberLabels: ["United States"],
        materiality: {
          thinSignal: false,
          material: true,
          archiveContext: false,
        },
        supportingMetrics: {
          spend: 420,
          revenue: 1344,
          roas: 3.2,
          purchases: 18,
          clicks: 210,
          impressions: 6800,
          spendShare: 0.52,
        },
        freshness: {
          dataState: "ready",
          lastSyncedAt: "2026-04-10T06:30:00.000Z",
          isPartial: false,
          verificationState: "finalized_verified",
          reason: null,
        },
        commercialContext: {
          serviceability: "full",
          priorityTier: "tier_1",
          scaleOverride: "prefer_scale",
          economicsMultiplier: null,
          marginModifier: null,
          countryEconomicsConfigured: true,
          countryEconomicsUpdatedAt: "2026-04-09T09:00:00.000Z",
          countryEconomicsSourceLabel: "manual",
        },
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["US is outperforming."],
        },
        ...rowProvenanceFixture({
          system: "meta",
          entityType: "geo",
          entityId: "geo:us",
          sourceDecisionId: "geo:us",
          recommendedAction: "scale",
        }),
      },
    ],
    placementAnomalies: [],
    noTouchList: [
      {
        entityType: "campaign",
        entityId: "cmp_3",
        label: "Retargeting",
        reason: "Do not disturb until checkout issue is resolved.",
        confidence: 0.71,
        guardrails: ["Keep budgets stable."],
      },
    ],
    winnerScaleCandidates: [
      {
        candidateId: "cmp_1:adset_1",
        campaignId: "cmp_1",
        campaignName: "Promo Spring",
        adSetId: "adset_1",
        adSetName: "Prospecting A",
        confidence: 0.9,
        why: "ROAS is beating target.",
        suggestedMoveBand: "10-15% of current budget load",
        evidence: [],
        guardrails: ["Scale in controlled steps."],
        supportingMetrics: {
          spend: 500,
          revenue: 1800,
          roas: 3.6,
          cpa: 20,
          ctr: 1.8,
          purchases: 25,
          dailyBudget: 200,
          bidStrategyLabel: null,
          optimizationGoal: "PURCHASE",
        },
        policy: {
          strategyClass: "scale_budget",
          objectiveFamily: "sales",
          bidRegime: "open",
          primaryDriver: "roas_outperforming",
          secondaryDrivers: ["signal_density"],
          winnerState: "scale_candidate",
          explanation: metaPolicyExplanation,
        },
      },
    ],
    opportunityBoard: [
      {
        opportunityId: "meta-campaign-winner:cmp_1",
        kind: "campaign_winner_scale",
        title: "Promo Spring",
        summary: "1 ad sets are carrying scalable winner signal in this campaign.",
        recommendedAction: "scale_budget",
        confidence: 0.86,
        queue: queueEligibilityFixture(),
        eligibilityTrace: queueEligibilityFixture().eligibilityTrace,
        evidenceFloors: [
          {
            key: "winner_count",
            label: "Winner count",
            status: "met",
            current: "1 ad set",
            required: "1+ authoritative winner",
            reason: null,
          },
        ],
        tags: ["scale_promotions"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["ROAS is beating target."],
        },
        source: {
          entityType: "campaign",
          entityId: "cmp_1",
          groupKey: "cmp_1",
        },
        relatedEntities: [
          { type: "campaign", id: "cmp_1", label: "Promo Spring" },
          { type: "adset", id: "adset_1", label: "Prospecting A" },
        ],
      },
      {
        opportunityId: "meta-geo:geo:us",
        kind: "geo",
        title: "United States",
        summary: "US is outperforming.",
        recommendedAction: "scale",
        confidence: 0.76,
        queue: queueEligibilityFixture(),
        eligibilityTrace: queueEligibilityFixture().eligibilityTrace,
        evidenceFloors: [
          {
            key: "freshness",
            label: "Freshness",
            status: "met",
            current: "ready / fresh",
            required: "ready and not stale",
            reason: null,
          },
        ],
        tags: ["geo_issues"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["US is outperforming."],
        },
        source: {
          entityType: "geo",
          entityId: "geo:us",
          groupKey: null,
        },
        relatedEntities: [{ type: "geo", id: "geo:us", label: "United States" }],
      },
      {
        opportunityId: "meta-protected:campaign:cmp_3",
        kind: "protected_winner",
        title: "Retargeting",
        summary: "Do not disturb until checkout issue is resolved.",
        recommendedAction: "hold_no_touch",
        confidence: 0.71,
        queue: queueEligibilityFixture({
          eligible: false,
          blockedReasons: [
            "Protected winners stay visible as guardrail context, not as queue work.",
          ],
          verdict: "protected",
        }),
        eligibilityTrace: queueEligibilityFixture({
          eligible: false,
          blockedReasons: [
            "Protected winners stay visible as guardrail context, not as queue work.",
          ],
          verdict: "protected",
        }).eligibilityTrace,
        evidenceFloors: [
          {
            key: "winner_protection",
            label: "Winner protection",
            status: "met",
            current: "protected",
            required: "stable winner context",
            reason: null,
          },
        ],
        tags: ["promo_mode_watchlist"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "live_confident",
          operatorDisposition: "protected_watchlist",
          reasons: ["Do not disturb until checkout issue is resolved."],
        },
        source: {
          entityType: "campaign",
          entityId: "cmp_3",
          groupKey: null,
        },
        relatedEntities: [{ type: "campaign", id: "cmp_3", label: "Retargeting" }],
      },
    ],
    commercialTruthCoverage: {
      mode: "configured_targets",
      targetPackConfigured: true,
      countryEconomicsConfigured: true,
      promoCalendarConfigured: false,
      operatingConstraintsConfigured: true,
      missingInputs: [],
      notes: [],
    },
  };
}

function creativeFixture(): CreativeDecisionOsV1Response {
  const metadata = decisionMetadata();
  const creativePromotionPolicyExplanation: DecisionPolicyExplanation = {
    summary: "Shared policy ladder kept promote to scaling active for this creative.",
    evidenceHits: [
      {
        key: "campaign_family",
        label: "Campaign family",
        status: "met",
        current: "purchase/value",
        required: "purchase, mid-funnel, or lead family",
        reason: null,
      },
    ],
    missingEvidence: [
      {
        key: "deployment_compatibility",
        label: "Deployment compatibility",
        status: "watch",
        current: "limited",
        required: "compatible live lane",
        reason: "No active scaling lane matched the current family.",
      },
    ],
    blockers: [],
    degradedReasons: [],
    actionCeiling: "Test-only until deployment, family, and bid alignment all move out of watch state.",
    protectedWinnerHandling: null,
    fatigueOrComeback: null,
    supplyPlanning: "Supply planning should expand adjacent angles before saturation shows up.",
    compare: {
      compareMode: true,
      baselineAction: "promote_to_scaling",
      candidateAction: "promote_to_scaling",
      selectedAction: "promote_to_scaling",
      cutoverState: "matched",
      reason:
        "Candidate ladder matched the baseline action, so no cutover guard was needed.",
    },
  };
  const creativeProtectedPolicyExplanation: DecisionPolicyExplanation = {
    summary: "Shared policy ladder preserved the protected winner path for this creative.",
    evidenceHits: [
      {
        key: "campaign_family",
        label: "Campaign family",
        status: "met",
        current: "purchase/value",
        required: "purchase, mid-funnel, or lead family",
        reason: null,
      },
    ],
    missingEvidence: [],
    blockers: [],
    degradedReasons: [],
    actionCeiling: "Protected winner only while performance remains stable.",
    protectedWinnerHandling:
      "Protected winners stay out of the promotion queue and remain visible as guardrail context.",
    fatigueOrComeback: null,
    supplyPlanning: null,
    compare: {
      compareMode: true,
      baselineAction: "hold_no_touch",
      candidateAction: "hold_no_touch",
      selectedAction: "hold_no_touch",
      cutoverState: "matched",
      reason:
        "Candidate ladder matched the baseline action, so no cutover guard was needed.",
    },
  };
  return {
    contractVersion: "creative-decision-os.v1",
    engineVersion: "2026-04-11-phase-05-v2",
    generatedAt: "2026-04-10T00:00:00.000Z",
    businessId: "biz",
    startDate: "2026-04-01",
    endDate: "2026-04-10",
    analyticsWindow: metadata.analyticsWindow,
    decisionWindows: metadata.decisionWindows,
    historicalMemory: metadata.historicalMemory,
    decisionAsOf: metadata.decisionAsOf,
    summary: {
      totalCreatives: 2,
      scaleReadyCount: 1,
      keepTestingCount: 0,
      fatiguedCount: 0,
      blockedCount: 0,
      comebackCount: 0,
      protectedWinnerCount: 1,
      supplyPlanCount: 1,
      message:
        "Decision OS highlights which creatives to scale, keep in test, refresh, block, or retest.",
      operatingMode: "Exploit",
      sourceHealth: sourceHealthFixture(),
      readReliability: readReliabilityFixture(),
      surfaceSummary: {
        actionCoreCount: 1,
        watchlistCount: 1,
        archiveCount: 0,
        degradedCount: 1,
      },
      opportunitySummary: {
        totalCount: 2,
        queueEligibleCount: 1,
        protectedCount: 1,
        familyScaleCount: 1,
        headline: "1 opportunity-board item is ready before it needs queue promotion.",
      },
      benchmarkScope: benchmarkScopeFixture(),
    },
    creatives: [
      {
        creativeId: "creative_1",
        provenance: {
          contractVersion: "operator-decision-provenance.v1",
          businessId: "biz",
          decisionAsOf: "2026-04-10",
          analyticsWindow: metadata.analyticsWindow,
          reportingRange: {
            startDate: metadata.analyticsWindow.startDate,
            endDate: metadata.analyticsWindow.endDate,
            role: "reporting_context",
          },
          sourceWindow: metadata.decisionWindows.primary30d,
          sourceRowScope: {
            system: "creative",
            entityType: "creative",
            entityId: "creative_1",
          },
          sourceDecisionId: "creative:creative_1",
          evidenceHash: "ev_creative_1",
          actionFingerprint: "od_creative_1",
        },
        evidenceHash: "ev_creative_1",
        actionFingerprint: "od_creative_1",
        evidenceSource: "live",
        operatorPolicy: creativeOperatorPolicy({
          state: "blocked",
          segment: "blocked",
          pushReadiness: "blocked_from_push",
          queueEligible: false,
          blockers: ["Commercial truth is incomplete."],
          missingEvidence: ["commercial_truth"],
          explanation:
            "Commercial truth is incomplete, so this creative stays out of the queue.",
        }),
        familyId: "family_1",
        familyLabel: "Promo UGC",
        familySource: "copy_signature",
        name: "Promo Hook A",
        creativeFormat: "video",
        creativeAgeDays: 14,
        spend: 300,
        purchaseValue: 960,
        roas: 3.2,
        cpa: 24,
        ctr: 1.9,
        purchases: 12,
        impressions: 9000,
        linkClicks: 140,
        score: 88,
        confidence: 0.83,
        lifecycleState: "scale_ready",
        primaryAction: "promote_to_scaling",
        legacyAction: "scale",
        legacyLifecycleState: "emerging_winner",
        decisionSignals: ["Benchmark beat on ROAS."],
        summary: "Promote this concept into scaling.",
        relativeBaseline: relativeBaselineFixture(),
        benchmarkScope: "account",
        benchmarkScopeLabel: "Account-wide",
        benchmarkSource: "account_default",
        benchmarkReliability: "medium",
        benchmark: {
          selectedCohort: "family",
          selectedCohortLabel: "Family",
          sampleSize: 8,
          fallbackChain: ["family"],
          missingContext: [],
          metrics: {
            roas: { current: 3.2, benchmark: 2.2, deltaPct: 0.45, status: "better" },
            cpa: { current: 24, benchmark: 30, deltaPct: -0.2, status: "better" },
            ctr: { current: 1.9, benchmark: 1.2, deltaPct: 0.58, status: "better" },
            clickToPurchase: { current: 0.08, benchmark: 0.05, deltaPct: 0.6, status: "better" },
            attention: {
              label: "Hook rate",
              current: 0.31,
              benchmark: 0.24,
              deltaPct: 0.29,
              status: "better",
            },
          },
        },
        fatigue: {
          status: "none",
          confidence: 0.74,
          ctrDecay: 0.02,
          clickToPurchaseDecay: 0.01,
          roasDecay: 0.03,
          spendConcentration: 0.2,
          frequencyPressure: 1.3,
          winnerMemory: false,
          evidence: [],
          missingContext: [],
        },
        economics: {
          status: "eligible",
          absoluteSpendFloor: 200,
          absolutePurchaseFloor: 4,
          roasFloor: 2.5,
          cpaCeiling: 28,
          targetRoas: 2.5,
          breakEvenRoas: 1.8,
          targetCpa: 28,
          breakEvenCpa: 34,
          reasons: [],
        },
        policy: {
          primaryDriver: "deployment_match",
          objectiveFamily: "OUTCOME_SALES",
          bidRegime: "lowest_cost",
          metaFamily: "purchase_value",
          deploymentCompatibility: "compatible",
          explanation: creativePromotionPolicyExplanation,
        },
        familyProvenance: {
          confidence: "medium",
          overGroupingRisk: "medium",
          evidence: ["Heuristic family matched same format, primary taxonomy, and normalized headline."],
        },
        deployment: {
          metaFamily: "purchase_value",
          metaFamilyLabel: "purchase/value",
          targetLane: "Scaling",
          targetAdSetRole: "scaling_hero",
          preferredCampaignIds: ["cmp_1"],
          preferredCampaignNames: ["Promo Spring"],
          preferredAdSetIds: ["adset_1"],
          preferredAdSetNames: ["Prospecting A"],
          geoContext: "scale",
          constraints: ["Keep promo spend monitored."],
          whatWouldChangeThisDecision: [],
          compatibility: {
            status: "compatible",
            objectiveFamily: "OUTCOME_SALES",
            optimizationGoal: "PURCHASE",
            bidRegime: "lowest_cost",
            matchedCampaignIds: ["cmp_1"],
            matchedAdSetIds: ["adset_1"],
            reasons: [],
          },
        },
        pattern: {
          hook: "Promo hook",
          angle: "offer",
          format: "video",
        },
        report: {
          creativeId: "creative_1",
          creativeName: "Promo Hook A",
          action: "scale",
          score: 88,
          confidence: 0.83,
          summary: "Promote this concept into scaling.",
          accountContext: {
            roasAvg: 2,
            cpaAvg: 30,
            ctrAvg: 1.2,
            spendMedian: 100,
            spendP20: 40,
            spendP80: 220,
          },
          factors: [],
          deterministicDecision: {
            lifecycleState: "scale_ready",
            primaryAction: "promote_to_scaling",
            legacyAction: "scale",
          },
        },
        trust: {
          surfaceLane: "watchlist",
          truthState: "degraded_missing_truth",
          operatorDisposition: "degraded_no_scale",
          reasons: ["Commercial truth is incomplete."],
        },
      },
      {
        creativeId: "creative_2",
        provenance: {
          contractVersion: "operator-decision-provenance.v1",
          businessId: "biz",
          decisionAsOf: "2026-04-10",
          analyticsWindow: metadata.analyticsWindow,
          reportingRange: {
            startDate: metadata.analyticsWindow.startDate,
            endDate: metadata.analyticsWindow.endDate,
            role: "reporting_context",
          },
          sourceWindow: metadata.decisionWindows.primary30d,
          sourceRowScope: {
            system: "creative",
            entityType: "creative",
            entityId: "creative_2",
          },
          sourceDecisionId: "creative:creative_2",
          evidenceHash: "ev_creative_2",
          actionFingerprint: "od_creative_2",
        },
        evidenceHash: "ev_creative_2",
        actionFingerprint: "od_creative_2",
        evidenceSource: "live",
        operatorPolicy: creativeOperatorPolicy({
          state: "do_not_touch",
          segment: "protected_winner",
          actionClass: "protect",
          pushReadiness: "blocked_from_push",
          queueEligible: false,
          blockers: ["Protected winner stays out of queue work."],
          explanation:
            "Deterministic Creative policy marks this creative as protected.",
        }),
        familyId: "family_2",
        familyLabel: "Holdout",
        familySource: "singleton",
        name: "Holdout Creative",
        creativeFormat: "image",
        creativeAgeDays: 4,
        spend: 60,
        purchaseValue: 90,
        roas: 1.5,
        cpa: 35,
        ctr: 1.1,
        purchases: 2,
        impressions: 2000,
        linkClicks: 24,
        score: 55,
        confidence: 0.65,
        lifecycleState: "validating",
        primaryAction: "hold_no_touch",
        legacyAction: "watch",
        legacyLifecycleState: "volatile",
        decisionSignals: ["Needs more clean learning."],
        summary: "Keep this out of the primary queue.",
        relativeBaseline: relativeBaselineFixture(),
        benchmarkScope: "account",
        benchmarkScopeLabel: "Account-wide",
        benchmarkSource: "account_default",
        benchmarkReliability: "medium",
        benchmark: {
          selectedCohort: "account",
          selectedCohortLabel: "Account",
          sampleSize: 12,
          fallbackChain: ["account"],
          missingContext: [],
          metrics: {
            roas: { current: 1.5, benchmark: 2.1, deltaPct: -0.28, status: "worse" },
            cpa: { current: 35, benchmark: 30, deltaPct: 0.17, status: "worse" },
            ctr: { current: 1.1, benchmark: 1.2, deltaPct: -0.08, status: "near" },
            clickToPurchase: { current: 0.03, benchmark: 0.04, deltaPct: -0.25, status: "worse" },
            attention: {
              label: "Hook rate",
              current: 0.22,
              benchmark: 0.24,
              deltaPct: -0.08,
              status: "near",
            },
          },
        },
        fatigue: {
          status: "unknown",
          confidence: 0.4,
          ctrDecay: null,
          clickToPurchaseDecay: null,
          roasDecay: null,
          spendConcentration: null,
          frequencyPressure: null,
          winnerMemory: false,
          evidence: [],
          missingContext: [],
        },
        economics: {
          status: "guarded",
          absoluteSpendFloor: 200,
          absolutePurchaseFloor: 4,
          roasFloor: 2.5,
          cpaCeiling: 28,
          targetRoas: 2.5,
          breakEvenRoas: 1.8,
          targetCpa: 28,
          breakEvenCpa: 34,
          reasons: ["Promotion floor requires at least $200 spend."],
        },
        policy: {
          primaryDriver: "protected_winner",
          objectiveFamily: "OUTCOME_SALES",
          bidRegime: "lowest_cost",
          metaFamily: "purchase_value",
          deploymentCompatibility: "limited",
          explanation: creativeProtectedPolicyExplanation,
        },
        familyProvenance: {
          confidence: "high",
          overGroupingRisk: "low",
          evidence: ["Creative remains a singleton family by design."],
        },
        deployment: {
          metaFamily: "purchase_value",
          metaFamilyLabel: "purchase/value",
          targetLane: null,
          targetAdSetRole: null,
          preferredCampaignIds: [],
          preferredCampaignNames: [],
          preferredAdSetIds: [],
          preferredAdSetNames: [],
          geoContext: "none",
          constraints: [],
          whatWouldChangeThisDecision: [],
          compatibility: {
            status: "limited",
            objectiveFamily: "OUTCOME_SALES",
            optimizationGoal: "PURCHASE",
            bidRegime: "lowest_cost",
            matchedCampaignIds: [],
            matchedAdSetIds: [],
            reasons: ["No active scaling lane matched the current family."],
          },
        },
        pattern: {
          hook: "Hold",
          angle: "neutral",
          format: "image",
        },
        report: {
          creativeId: "creative_2",
          creativeName: "Holdout Creative",
          action: "watch",
          score: 55,
          confidence: 0.65,
          summary: "Keep this out of the primary queue.",
          accountContext: {
            roasAvg: 2,
            cpaAvg: 30,
            ctrAvg: 1.2,
            spendMedian: 100,
            spendP20: 40,
            spendP80: 220,
          },
          factors: [],
          deterministicDecision: {
            lifecycleState: "validating",
            primaryAction: "hold_no_touch",
            legacyAction: "watch",
          },
        },
        trust: {
          surfaceLane: "watchlist",
          truthState: "live_confident",
          operatorDisposition: "protected_watchlist",
          reasons: ["Needs more clean learning."],
        },
      },
    ],
    families: [],
    patterns: [],
    protectedWinners: [
      {
        creativeId: "creative_2",
        familyId: "family_2",
        creativeName: "Holdout Creative",
        familyLabel: "Holdout",
        spend: 60,
        roas: 1.5,
        reasons: ["Keep this out of the primary queue."],
      },
    ],
    supplyPlan: [
      {
        kind: "new_test_concepts",
        priority: "medium",
        familyId: "family_1",
        familyLabel: "Promo UGC",
        creativeIds: ["creative_1"],
        summary: "Generate fresh test concepts to widen hook and angle coverage for this family.",
        reasons: ["Family has meaningful spend but no protected winner yet."],
      },
    ],
    opportunityBoard: [
      {
        opportunityId: "creative-family-scale:family_1",
        kind: "creative_family_winner_scale",
        title: "Promo UGC",
        summary: "Promote this concept into scaling.",
        recommendedAction: "promote_to_scaling",
        confidence: 0.83,
        queue: queueEligibilityFixture(),
        eligibilityTrace: queueEligibilityFixture().eligibilityTrace,
        evidenceFloors: [
          {
            key: "scale_readiness",
            label: "Scale readiness",
            status: "met",
            current: "1 promotable creative",
            required: "1+ promotable creative",
            reason: null,
          },
        ],
        tags: ["scale_promotions"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "degraded_missing_truth",
          operatorDisposition: "degraded_no_scale",
          reasons: ["Promote this concept into scaling."],
        },
        familyId: "family_1",
        creativeIds: ["creative_1"],
      },
      {
        opportunityId: "creative-protected:creative_2",
        kind: "protected_winner",
        title: "Holdout Creative",
        summary: "Keep this out of the primary queue.",
        recommendedAction: "hold_no_touch",
        confidence: 0.65,
        queue: queueEligibilityFixture({
          eligible: false,
          blockedReasons: [
            "Protected winners stay visible for operator context, not as queue work.",
          ],
          verdict: "protected",
        }),
        eligibilityTrace: queueEligibilityFixture({
          eligible: false,
          blockedReasons: [
            "Protected winners stay visible for operator context, not as queue work.",
          ],
          verdict: "protected",
        }).eligibilityTrace,
        evidenceFloors: [
          {
            key: "winner_protection",
            label: "Winner protection",
            status: "met",
            current: "protected",
            required: "stable winner context",
            reason: null,
          },
        ],
        tags: ["promo_mode_watchlist"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "live_confident",
          operatorDisposition: "protected_watchlist",
          reasons: ["Keep this out of the primary queue."],
        },
        familyId: "family_2",
        creativeIds: ["creative_2"],
      },
    ],
    lifecycleBoard: [],
    operatorQueues: [],
    commercialTruthCoverage: {
      operatingMode: "Exploit",
      confidence: 0.82,
      missingInputs: [],
      activeInputs: [],
      guardrails: [],
      configuredSections: {
        targetPack: true,
        countryEconomics: false,
        promoCalendar: false,
        operatingConstraints: true,
      },
    },
    historicalAnalysis: {
      summary:
        "Video leads the selected-period format mix while Travel Pack and Utility describe the strongest visible pattern. This block is analysis-only and does not change deterministic Decision Signals.",
      selectedWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        rowCount: 2,
        materialRowCount: 2,
        note: "Analysis only. Live decisions continue to use the primary decision window.",
      },
      winningFormats: [],
      hookTrends: [],
      angleTrends: [],
      familyPerformance: [],
    },
  };
}

function buildActionFixture(
  overrides: Partial<CommandCenterAction> = {},
): CommandCenterAction {
  const fingerprint = overrides.actionFingerprint ?? `cc_${Math.random().toString(36).slice(2, 10)}`;
  const metadata = buildOperatorDecisionMetadata({
    analyticsStartDate: "2026-04-01",
    analyticsEndDate: "2026-04-10",
    decisionAsOf: "2026-04-10",
  });
  return {
    actionFingerprint: fingerprint,
    provenance: {
      ...buildOperatorDecisionProvenance({
        businessId: "biz",
        decisionAsOf: "2026-04-10",
        analyticsWindow: metadata.analyticsWindow,
        sourceWindow: metadata.decisionWindows.primary30d,
        sourceRowScope: {
          system: "meta",
          entityType: "adset",
          entityId: "adset_fixture",
        },
        sourceDecisionId: fingerprint,
        recommendedAction: "scale_budget",
        evidence: ["Stable queue fixture."],
      }),
      actionFingerprint: fingerprint,
    },
    sourceSystem: "meta",
    sourceType: "meta_adset_decision",
    surfaceLane: "action_core",
    queueSection: "history_context",
    workloadClass: "scale_promotion",
    truthState: "live_confident",
    operatorDisposition: "standard",
    trustReasons: ["Stable queue fixture."],
    title: overrides.title ?? fingerprint,
    recommendedAction: "scale_budget",
    confidence: 0.82,
    priority: "medium",
    summary: "Fixture action",
    decisionSignals: ["Stable queue fixture."],
    evidence: [],
    guardrails: [],
    relatedEntities: [
      {
        type: "campaign",
        id: "cmp_fixture",
        label: "Fixture Campaign",
      },
    ],
    tags: [],
    watchlistOnly: false,
    batchReviewClass: null,
    batchReviewEligible: false,
    calibrationHint: null,
    status: "pending",
    assigneeUserId: null,
    assigneeName: null,
    snoozeUntil: null,
    latestNoteExcerpt: null,
    noteCount: 0,
    lastMutatedAt: null,
    lastMutationId: null,
    createdAt: "2026-04-09T00:00:00.000Z",
    sourceContext: {
      sourceLabel: "Meta Decision OS",
      operatingMode: "Exploit",
      sourceDeepLink: "/platforms/meta?businessId=biz",
      sourceDecisionId: fingerprint,
    },
    throughput: {
      priorityScore: 0,
      actionable: false,
      defaultQueueEligible: false,
      selectedInDefaultQueue: false,
      ageHours: 0,
      ageLabel: "fresh now",
      ageAnchorAt: "2026-04-09T00:00:00.000Z",
      slaTargetHours: null,
      slaStatus: "n_a",
    },
    ...overrides,
  };
}

function buildFeedbackEntry(
  overrides: Partial<CommandCenterFeedbackEntry> = {},
): CommandCenterFeedbackEntry {
  const scope = overrides.scope ?? "action";
  return {
    id: overrides.id ?? `feedback_${Math.random().toString(36).slice(2, 8)}`,
    businessId: "biz",
    clientMutationId:
      overrides.clientMutationId ?? `mutation_${Math.random().toString(36).slice(2, 8)}`,
    feedbackType: "false_positive",
    outcome:
      overrides.outcome ??
      (scope === "queue_gap" ? "workflow_gap" : "operator_note"),
    scope,
    actionFingerprint: "cc_feedback",
    actionTitle: "Feedback action",
    sourceSystem: "meta",
    sourceType: "meta_adset_decision",
    workloadClass: scope === "action" ? "policy_guardrail" : null,
    calibrationHint: null,
    viewKey: null,
    actorUserId: "user_1",
    actorName: "Operator",
    actorEmail: "operator@adsecute.com",
    note: "Feedback note",
    createdAt: "2026-04-10T08:00:00.000Z",
    ...overrides,
  };
}

describe("command center domain", () => {
  it("keeps action fingerprints stable across date ranges", () => {
    const rangeA = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });
    const rangeB = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });

    expect(rangeA[0]?.actionFingerprint).toBe(rangeB[0]?.actionFingerprint);
  });

  it("preserves legacy Command Center fingerprints while retaining upstream provenance", () => {
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });
    const metaAction = actions.find(
      (action) => action.sourceType === "meta_adset_decision",
    );

    expect(metaAction?.provenance?.actionFingerprint).toMatch(/^od_/);
    expect(metaAction?.actionFingerprint).toMatch(/^cc_/);
    expect(metaAction?.actionFingerprint).not.toBe(
      metaAction?.provenance?.actionFingerprint,
    );

    const stateByFingerprint = new Map<string, CommandCenterActionStateRecord>([
      [
        metaAction!.actionFingerprint,
        {
          businessId: "biz",
          actionFingerprint: metaAction!.actionFingerprint,
          sourceSystem: "meta",
          sourceType: "meta_adset_decision",
          actionTitle: metaAction!.title,
          recommendedAction: metaAction!.recommendedAction,
          workflowStatus: "approved",
          assigneeUserId: "user_1",
          assigneeName: "Operator",
          snoozeUntil: null,
          latestNoteExcerpt: "Legacy state still joins.",
          noteCount: 1,
          lastMutationId: "mutation_1",
          lastMutatedAt: "2026-04-10T09:00:00.000Z",
          createdAt: "2026-04-10T08:00:00.000Z",
          updatedAt: "2026-04-10T09:00:00.000Z",
        },
      ],
    ]);

    const merged = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
      stateByFingerprint,
    }).find((action) => action.actionFingerprint === metaAction?.actionFingerprint);

    expect(merged?.status).toBe("approved");
    expect(merged?.assigneeUserId).toBe("user_1");
  });

  it("keeps source decisions stable across analytics ranges", () => {
    const april = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });
    const marchMeta = metaFixture();
    marchMeta.startDate = "2026-03-01";
    marchMeta.endDate = "2026-03-31";
    marchMeta.analyticsWindow = {
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      role: "analysis_only",
    };
    const marchCreative = creativeFixture();
    marchCreative.startDate = "2026-03-01";
    marchCreative.endDate = "2026-03-31";
    marchCreative.analyticsWindow = {
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      role: "analysis_only",
    };
    const march = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      metaDecisionOs: marchMeta,
      creativeDecisionOs: marchCreative,
    });

    expect(
      april.map((action) => ({
        fingerprint: action.actionFingerprint,
        title: action.title,
        recommendedAction: action.recommendedAction,
      })),
    ).toEqual(
      march.map((action) => ({
        fingerprint: action.actionFingerprint,
        title: action.title,
        recommendedAction: action.recommendedAction,
      })),
    );
  });

  it("changes primary action fingerprints when decisionAsOf changes even if the analytics window stays fixed", () => {
    const april = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });

    const shiftedMeta = metaFixture();
    shiftedMeta.decisionAsOf = "2026-04-11";
    shiftedMeta.generatedAt = "2026-04-11T00:00:00.000Z";
    const shiftedCreative = creativeFixture();
    shiftedCreative.decisionAsOf = "2026-04-11";
    shiftedCreative.generatedAt = "2026-04-11T00:00:00.000Z";
    const shifted = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: shiftedMeta,
      creativeDecisionOs: shiftedCreative,
    });

    expect(
      shifted.map((action) => ({
        fingerprint: action.actionFingerprint,
        title: action.title,
        recommendedAction: action.recommendedAction,
      })),
    ).not.toEqual(
      april.map((action) => ({
        fingerprint: action.actionFingerprint,
        title: action.title,
        recommendedAction: action.recommendedAction,
      })),
    );
  });

  it("blocks queue eligibility when upstream provenance is missing from Meta action rows", () => {
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });
    const decorated = decorateCommandCenterActionsWithThroughput({
      actions: actions.map((action) =>
        action.sourceType === "meta_adset_decision"
          ? { ...action, provenance: null }
          : action,
      ),
      decisionAsOf: "2026-04-10",
    });
    const throughput = buildCommandCenterDefaultQueueSummary(decorated);
    const selected = applyCommandCenterQueueSelection({
      actions: decorated,
      throughput,
    });
    const metaAction = selected.find(
      (action) => action.sourceType === "meta_adset_decision",
    ) as any;

    expect(metaAction?.provenance).toBeNull();
    expect(metaAction?.throughput.defaultQueueEligible).toBe(false);
    expect(metaAction?.throughput.selectedInDefaultQueue).toBe(false);
    expect(metaAction?.operatorInstruction?.invalidActions.join(" ")).toContain(
      "Missing complete decision provenance.",
    );
  });

  it("keeps policy-blocked Meta actions out of default queue and overflow backlog", () => {
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });
    const decorated = decorateCommandCenterActionsWithThroughput({
      actions: actions.map((action) =>
        action.sourceType === "meta_adset_decision"
          ? { ...action, operatorPolicy: blockedOperatorPolicy() }
          : action,
      ),
      decisionAsOf: "2026-04-10",
    });
    const throughput = buildCommandCenterDefaultQueueSummary(decorated);
    const selected = applyCommandCenterQueueSelection({
      actions: decorated,
      throughput,
    });
    const metaAction = selected.find(
      (action) => action.sourceType === "meta_adset_decision",
    );

    expect(metaAction?.operatorPolicy?.pushReadiness).toBe("blocked_from_push");
    expect(metaAction?.throughput.actionable).toBe(false);
    expect(metaAction?.throughput.defaultQueueEligible).toBe(false);
    expect(metaAction?.queueSection).toBe("history_context");
    expect(metaAction?.operatorInstruction?.pushReadiness).toBe("blocked_from_push");
    expect(metaAction?.operatorInstruction?.canApply).toBe(false);
    expect(metaAction?.operatorInstruction?.invalidActions.join(" ")).toContain(
      "Do not queue, apply, or push",
    );
  });

  it("keeps Creative rows without operator policy out of queue and push surfaces", () => {
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });
    const decorated = decorateCommandCenterActionsWithThroughput({
      actions: actions.map((action) =>
        action.sourceType === "creative_primary_decision"
          ? { ...action, operatorPolicy: null }
          : action,
      ),
      decisionAsOf: "2026-04-10",
    });
    const creativeAction = decorated.find(
      (action) => action.sourceType === "creative_primary_decision",
    );

    expect(creativeAction?.operatorPolicy).toBeNull();
    expect(creativeAction?.operatorInstruction?.operatorVerb).toBe("Use as context");
    expect(creativeAction?.operatorInstruction?.invalidActions.join(" ")).toContain(
      "Creative operator policy is missing",
    );
    expect(creativeAction?.throughput.actionable).toBe(false);
    expect(creativeAction?.throughput.defaultQueueEligible).toBe(false);
  });

  it("keeps snapshot Creative policy context out of the default queue", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy({
      state: "contextual_only",
      segment: "contextual_only",
      evidenceSource: "snapshot",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      blockers: ["snapshot evidence is contextual and cannot authorize primary Creative action."],
      explanation:
        "snapshot evidence is contextual and cannot authorize primary Creative action.",
    });
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: payload,
    });
    const decorated = decorateCommandCenterActionsWithThroughput({
      actions,
      decisionAsOf: "2026-04-10",
    });
    const creativeAction = decorated.find(
      (action) =>
        action.sourceType === "creative_primary_decision" &&
        action.title === "Promo Hook A",
    );

    expect(creativeAction?.operatorPolicy?.pushReadiness).toBe("blocked_from_push");
    expect(creativeAction?.operatorInstruction?.primaryMove).toContain("context only");
    expect(creativeAction?.operatorInstruction?.pushReadiness).toBe("blocked_from_push");
    expect(creativeAction?.operatorInstruction?.invalidActions.join(" ")).toContain(
      "snapshot evidence is contextual",
    );
    expect(creativeAction?.throughput.defaultQueueEligible).toBe(false);
  });

  it("marks no-touch surfaces as watchlist-only and keeps them out of primary views", () => {
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });

    const watchlist = filterCommandCenterActionsByView(actions, {
      watchlistOnly: true,
    });

    expect(
      watchlist.some((action) => action.sourceType === "meta_no_touch_item"),
    ).toBe(true);
    expect(
      watchlist.some(
        (action) =>
          action.sourceType === "creative_primary_decision" &&
          action.recommendedAction === "hold_no_touch",
      ),
    ).toBe(true);
  });

  it("keeps the default action-core view free of watchlist lanes", () => {
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });

    const actionCore = filterCommandCenterActionsByView(actions, {
      surfaceLanes: ["action_core"],
    });

    expect(actionCore.every((action) => action.surfaceLane === "action_core")).toBe(true);
  });

  it("carries upstream policy explanations into aggregated actions", () => {
    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });

    expect(
      actions.find((action) => action.sourceType === "meta_adset_decision")?.policyExplanation?.compare.cutoverState,
    ).toBe("matched");
    expect(
      actions.find((action) => action.sourceType === "creative_primary_decision")?.policyExplanation?.compare.reason,
    ).toContain("Candidate ladder matched the baseline action");
  });

  it("drops non-queue-eligible GEO watchlist rows from the default GEO intake", () => {
    const payload = metaFixture();
    payload.geoDecisions.push({
      geoKey: "geo:de",
      countryCode: "DE",
      label: "Germany",
      action: "pool",
      queueEligible: false,
      confidence: 0.68,
      why: "Signal is still thin, so keep this in pooled validation.",
      evidence: [{ label: "ROAS", value: "1.8x", impact: "mixed" }],
      guardrails: ["Do not isolate this GEO yet."],
      whatWouldChangeThisDecision: [],
      clusterKey: "pool:tier_3:full:live_confident",
      clusterLabel: "pool • tier 3 • full",
      grouped: true,
      groupMemberCount: 2,
      groupMemberLabels: ["Germany", "France"],
      materiality: {
        thinSignal: true,
        material: true,
        archiveContext: false,
      },
      supportingMetrics: {
        spend: 180,
        revenue: 324,
        roas: 1.8,
        purchases: 3,
        clicks: 74,
        impressions: 4300,
        spendShare: 0.22,
      },
      freshness: {
        dataState: "ready",
        lastSyncedAt: "2026-04-10T06:30:00.000Z",
        isPartial: false,
        verificationState: "finalized_verified",
        reason: null,
      },
      commercialContext: {
        serviceability: "full",
        priorityTier: "tier_3",
        scaleOverride: "default",
        economicsMultiplier: null,
        marginModifier: null,
        countryEconomicsConfigured: true,
        countryEconomicsUpdatedAt: "2026-04-09T09:00:00.000Z",
        countryEconomicsSourceLabel: "manual",
      },
      trust: {
        surfaceLane: "watchlist",
        truthState: "live_confident",
        operatorDisposition: "monitor_low_truth",
        reasons: ["Signal is still thin, so keep this in pooled validation."],
      },
      ...rowProvenanceFixture({
        system: "meta",
        entityType: "geo",
        entityId: "geo:de",
        sourceDecisionId: "geo:de",
        recommendedAction: "pool",
      }),
    });

    const actions = aggregateCommandCenterActions({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: payload,
      creativeDecisionOs: creativeFixture(),
    });

    const geoActions = actions.filter((action) => action.sourceType === "meta_geo_decision");

    expect(geoActions).toHaveLength(1);
    expect(geoActions[0]?.title).toBe("United States");
    expect(geoActions[0]?.sourceContext.sourceDecisionId).toBe("geo:us");
  });

  it("builds an additive opportunity board from Meta and Creative sources", () => {
    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: metaFixture(),
      creativeDecisionOs: creativeFixture(),
    });

    expect(opportunities.some((item) => item.sourceSystem === "meta")).toBe(true);
    expect(opportunities.some((item) => item.sourceSystem === "creative")).toBe(true);
    expect(opportunities.some((item) => item.queueEligible)).toBe(true);
    expect(
      opportunities.find(
        (item) =>
          item.sourceSystem === "creative" &&
          item.kind === "creative_family_winner_scale",
      )?.queueEligible,
    ).toBe(false);
    expect(
      opportunities.find(
        (item) =>
          item.sourceSystem === "creative" &&
          item.kind === "creative_family_winner_scale",
      )?.eligibilityTrace.verdict,
    ).toBe("blocked");
    expect(
      opportunities.some(
        (item) => item.kind.includes("protected") && !item.queueEligible,
      ),
    ).toBe(true);
  });

  it("fails closed instead of throwing when Creative opportunity policy is missing", () => {
    const payload = creativeFixture();
    delete (
      payload.creatives[0] as Partial<CreativeDecisionOsV1Response["creatives"][number]>
    ).operatorPolicy;

    expect(() =>
      buildCommandCenterOpportunities({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        metaDecisionOs: null,
        creativeDecisionOs: payload,
      }),
    ).not.toThrow();

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(false);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    expect(creativeOpportunity?.eligibilityTrace.blockedReasons).toContain(
      "Creative opportunity is not queue eligible because a referenced creative row is missing operator policy.",
    );
    expect(
      creativeOpportunity?.evidenceFloors.find(
        (floor) => floor.key === "creative_operator_policy",
      )?.status,
    ).toBe("blocked");
  });

  it("fails closed when one Creative family opportunity row is safe but another referenced row is missing", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    payload.opportunityBoard[0]!.creativeIds = ["creative_1", "creative_missing"];
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture({ verdict: "queue_ready" }).eligibilityTrace;

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(false);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    expect(creativeOpportunity?.eligibilityTrace.blockedReasons).toContain(
      "Creative opportunity is not queue eligible because a referenced creative row is missing.",
    );
    expect(
      creativeOpportunity?.evidenceFloors.find(
        (floor) => floor.key === "creative_operator_policy",
      )?.status,
    ).toBe("blocked");
  });

  it("fails closed when one Creative family opportunity row is safe but another policy is missing", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    payload.creatives[1]!.operatorPolicy = creativeOperatorPolicy();
    delete (
      payload.creatives[1] as Partial<CreativeDecisionOsV1Response["creatives"][number]>
    ).operatorPolicy;
    payload.opportunityBoard[0]!.creativeIds = ["creative_1", "creative_2"];
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture({ verdict: "queue_ready" }).eligibilityTrace;

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(false);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    expect(creativeOpportunity?.eligibilityTrace.blockedReasons).toContain(
      "Creative opportunity is not queue eligible because a referenced creative row is missing operator policy.",
    );
  });

  it("fails closed when one Creative family opportunity row has unsafe policy", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    payload.creatives[1]!.operatorPolicy = creativeOperatorPolicy({
      state: "blocked",
      segment: "blocked",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      blockers: ["Creative row policy blocks queue work."],
      explanation: "Creative row policy blocks queue work.",
    });
    payload.opportunityBoard[0]!.creativeIds = ["creative_1", "creative_2"];
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture({ verdict: "queue_ready" }).eligibilityTrace;

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(false);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    expect(creativeOpportunity?.eligibilityTrace.blockedReasons).toContain(
      "Creative opportunity is not queue eligible without a matching safe-to-queue row policy.",
    );
  });

  it("fails closed when a Creative opportunity row is missing required provenance", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    delete (
      payload.creatives[0] as Partial<CreativeDecisionOsV1Response["creatives"][number]>
    ).provenance;
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture({ verdict: "queue_ready" }).eligibilityTrace;

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(false);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    expect(creativeOpportunity?.eligibilityTrace.blockedReasons).toContain(
      "Creative opportunity is not queue eligible because a referenced creative row is missing required provenance.",
    );
  });

  it("fails closed instead of throwing when Creative provenance is partially populated", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    payload.creatives[0]!.provenance = {
      ...payload.creatives[0]!.provenance,
      sourceRowScope: undefined as never,
    };
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture({ verdict: "queue_ready" }).eligibilityTrace;

    expect(() =>
      buildCommandCenterOpportunities({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        metaDecisionOs: null,
        creativeDecisionOs: payload,
      }),
    ).not.toThrow();

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(false);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    expect(creativeOpportunity?.eligibilityTrace.blockedReasons).toContain(
      "Creative opportunity is not queue eligible because a referenced creative row is missing required provenance.",
    );
  });

  it("overrides stale queue-ready Creative opportunity traces when policy blocks eligibility", () => {
    const payload = creativeFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture({ verdict: "queue_ready" }).eligibilityTrace;
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy({
      state: "contextual_only",
      segment: "contextual_only",
      evidenceSource: "snapshot",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      blockers: ["Snapshot evidence is contextual."],
      explanation: "Snapshot evidence is contextual.",
    });

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(false);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    expect(creativeOpportunity?.eligibilityTrace.blockedReasons).toContain(
      "Creative opportunity is not queue eligible because referenced creative evidence is not live.",
    );
  });

  it.each(["demo", "snapshot", "fallback", "unknown"] as const)(
    "keeps %s Creative opportunities out of queue and push surfaces",
    (evidenceSource) => {
      const payload = creativeFixture();
      payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy({
        state: "contextual_only",
        segment: "contextual_only",
        evidenceSource,
        pushReadiness: "blocked_from_push",
        queueEligible: false,
        blockers: [`${evidenceSource} evidence is contextual.`],
        explanation: `${evidenceSource} evidence is contextual.`,
      });

      const opportunities = buildCommandCenterOpportunities({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        metaDecisionOs: null,
        creativeDecisionOs: payload,
      });
      const creativeOpportunity = opportunities.find(
        (item) => item.kind === "creative_family_winner_scale",
      );

      expect(creativeOpportunity?.queueEligible).toBe(false);
      expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("blocked");
    },
  );

  it("keeps a valid Creative safe-to-queue opportunity eligible", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture().eligibilityTrace;

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(true);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("queue_ready");
    expect(
      creativeOpportunity?.evidenceFloors.find(
        (floor) => floor.key === "creative_operator_policy",
      )?.status,
    ).toBe("met");
  });

  it("keeps a valid multi-creative live safe-to-queue opportunity eligible", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    payload.creatives[1]!.operatorPolicy = creativeOperatorPolicy();
    payload.opportunityBoard[0]!.creativeIds = ["creative_1", "creative_2"];
    payload.opportunityBoard[0]!.queue = queueEligibilityFixture();
    payload.opportunityBoard[0]!.eligibilityTrace =
      queueEligibilityFixture().eligibilityTrace;

    const opportunities = buildCommandCenterOpportunities({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      metaDecisionOs: null,
      creativeDecisionOs: payload,
    });
    const creativeOpportunity = opportunities.find(
      (item) => item.kind === "creative_family_winner_scale",
    );

    expect(creativeOpportunity?.queueEligible).toBe(true);
    expect(creativeOpportunity?.eligibilityTrace.verdict).toBe("queue_ready");
    expect(
      creativeOpportunity?.evidenceFloors.find(
        (floor) => floor.key === "creative_operator_policy",
      )?.status,
    ).toBe("met");
  });

  it("enforces workflow transition guards", () => {
    expect(canTransitionCommandCenterStatus("pending", "approved")).toBe(true);
    expect(canTransitionCommandCenterStatus("approved", "completed_manual")).toBe(true);
    expect(canTransitionCommandCenterStatus("approved", "rejected")).toBe(false);
    expect(
      resolveNextCommandCenterStatus({
        currentStatus: "pending",
        mutation: "approve",
      }),
    ).toBe("approved");
    expect(
      resolveNextCommandCenterStatus({
        currentStatus: "rejected",
        mutation: "reopen",
      }),
    ).toBe("pending");
  });

  it("sanitizes saved-view definitions to typed allowlists", () => {
    expect(
      sanitizeCommandCenterSavedViewDefinition({
        sourceTypes: ["meta_budget_shift", "invalid"],
        statuses: ["pending", "wat"],
        tags: ["budget_shifts"],
        watchlistOnly: true,
        surfaceLanes: ["watchlist", "wat"],
      }),
    ).toEqual({
      sourceTypes: ["meta_budget_shift"],
      statuses: ["pending"],
      tags: ["budget_shifts"],
      watchlistOnly: true,
      surfaceLanes: ["watchlist"],
    });
  });

  it("decorates actions with throughput metadata and keeps Meta source deep links entity-aware", () => {
    const decorated = decorateCommandCenterActionsWithThroughput({
      actions: aggregateCommandCenterActions({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        metaDecisionOs: metaFixture(),
        creativeDecisionOs: creativeFixture(),
      }).map((action) =>
        action.sourceType === "meta_adset_decision"
          ? {
              ...action,
              createdAt: "2026-04-08T00:00:00.000Z",
            }
          : action,
      ),
      decisionAsOf: "2026-04-10",
    });

    const adsetAction = decorated.find(
      (action) => action.sourceType === "meta_adset_decision",
    );
    const budgetShiftAction = decorated.find(
      (action) => action.sourceType === "meta_budget_shift",
    );

    expect(adsetAction?.throughput.priorityScore).toBeGreaterThan(80);
    expect(adsetAction?.throughput.slaStatus).toBe("overdue");
    expect(adsetAction?.sourceContext.sourceDeepLink).toContain("campaignId=cmp_1");
    expect(budgetShiftAction?.sourceContext.sourceDeepLink).toContain(
      "campaignId=cmp_1",
    );
    expect(budgetShiftAction?.provenance?.sourceRowScope.entityType).toBe(
      "budget_shift",
    );
    expect(budgetShiftAction?.throughput.defaultQueueEligible).toBe(true);
    expect(budgetShiftAction?.operatorPolicy).toBeNull();
    expect(budgetShiftAction?.operatorInstruction?.queueEligible).toBe(true);
    expect(budgetShiftAction?.operatorInstruction?.pushReadiness).toBe("safe_to_queue");
    expect(budgetShiftAction?.operatorInstruction?.canApply).toBe(false);
    expect(budgetShiftAction?.operatorInstruction?.amountGuidance.status).toBe(
      "bounded_estimate",
    );
    expect(budgetShiftAction?.operatorInstruction?.amountGuidance.label).toContain(
      "Move band:",
    );
    expect(budgetShiftAction?.operatorInstruction?.telemetry).toMatchObject({
      contractVersion: "operator-decision-telemetry.v1",
      sourceSystem: "meta",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      amountGuidanceStatus: "bounded_estimate",
    });
    expect(JSON.stringify(budgetShiftAction?.operatorInstruction?.telemetry)).not.toContain(
      "biz",
    );
    expect(budgetShiftAction?.operatorInstruction?.invalidActions.join(" ")).not.toContain(
      "Do not promote this Command Center card into queue work",
    );
  });

  it("does not show false queue warnings for final-eligible Meta cards without policy objects", () => {
    const decorated = decorateCommandCenterActionsWithThroughput({
      actions: aggregateCommandCenterActions({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        metaDecisionOs: metaFixture(),
        creativeDecisionOs: creativeFixture(),
      }),
      decisionAsOf: "2026-04-10",
    });
    const metaBudgetShift = decorated.find(
      (action) => action.sourceType === "meta_budget_shift",
    );

    expect(metaBudgetShift?.operatorPolicy).toBeNull();
    expect(metaBudgetShift?.throughput.defaultQueueEligible).toBe(true);
    expect(metaBudgetShift?.operatorInstruction?.queueEligible).toBe(true);
    expect(metaBudgetShift?.operatorInstruction?.canApply).toBe(false);
    expect(metaBudgetShift?.operatorInstruction?.invalidActions.join(" ")).not.toContain(
      "Do not promote this Command Center card into queue work",
    );
  });

  it("keeps explicitly blocked policy push readiness more restrictive than queue-ineligible provenance state", () => {
    const [decorated] = decorateCommandCenterActionsWithThroughput({
      actions: [
        buildActionFixture({
          operatorPolicy: blockedOperatorPolicy(),
        }),
      ],
      decisionAsOf: "2026-04-10",
    });

    expect(decorated?.provenance).toBeTruthy();
    expect(decorated?.operatorPolicy?.pushReadiness).toBe("blocked_from_push");
    expect(decorated?.throughput.defaultQueueEligible).toBe(false);
    expect(decorated?.operatorInstruction?.pushReadiness).toBe("blocked_from_push");
    expect(decorated?.operatorInstruction?.invalidActions.join(" ")).toContain(
      "Do not queue, apply, or push",
    );
  });

  it("marks supported Meta ad set actions apply-capable only when policy and provenance allow it", () => {
    const [decorated] = decorateCommandCenterActionsWithThroughput({
      actions: [
        buildActionFixture({
          sourceType: "meta_adset_decision",
          recommendedAction: "scale_budget",
          operatorPolicy: blockedOperatorPolicy({
            state: "do_now",
            actionClass: "scale",
            pushReadiness: "eligible_for_push_when_enabled",
            queueEligible: true,
            canApply: true,
            reasons: ["Supported ad set apply path is policy approved."],
            blockers: [],
            missingEvidence: [],
            requiredEvidence: ["row_provenance", "commercial_truth"],
            explanation: "Supported ad set apply path is policy approved.",
          }),
        }),
      ],
      decisionAsOf: "2026-04-10",
    });

    expect(decorated?.throughput.defaultQueueEligible).toBe(true);
    expect(decorated?.operatorInstruction?.pushReadiness).toBe(
      "eligible_for_push_when_enabled",
    );
    expect(decorated?.operatorInstruction?.canApply).toBe(true);
  });

  it("keeps unsupported Meta action families manual-only even when they are queue eligible", () => {
    const [geoAction] = decorateCommandCenterActionsWithThroughput({
      actions: [
        buildActionFixture({
          actionFingerprint: "cc_geo",
          sourceType: "meta_geo_decision",
          recommendedAction: "cut",
          title: "United States",
          provenance: rowProvenanceFixture({
            system: "meta",
            entityType: "geo",
            entityId: "geo_us",
            sourceDecisionId: "cc_geo",
            recommendedAction: "cut",
          }).provenance,
        }),
      ],
      decisionAsOf: "2026-04-10",
    });
    const [placementAction] = decorateCommandCenterActionsWithThroughput({
      actions: [
        buildActionFixture({
          actionFingerprint: "cc_placement",
          sourceType: "meta_placement_anomaly",
          recommendedAction: "exception_review",
          title: "Feed",
          provenance: rowProvenanceFixture({
            system: "meta",
            entityType: "placement",
            entityId: "placement_feed",
            sourceDecisionId: "cc_placement",
            recommendedAction: "exception_review",
          }).provenance,
        }),
      ],
      decisionAsOf: "2026-04-10",
    });

    for (const action of [geoAction, placementAction]) {
      expect(action?.throughput.defaultQueueEligible).toBe(true);
      expect(action?.operatorInstruction?.queueEligible).toBe(true);
      expect(action?.operatorInstruction?.pushReadiness).toBe("safe_to_queue");
      expect(action?.operatorInstruction?.canApply).toBe(false);
    }
  });

  it("keeps missing-provenance rows non-applyable even when action type is supported", () => {
    const [decorated] = decorateCommandCenterActionsWithThroughput({
      actions: [
        buildActionFixture({
          sourceType: "meta_adset_decision",
          recommendedAction: "scale_budget",
          provenance: null,
          operatorPolicy: blockedOperatorPolicy({
            state: "do_now",
            actionClass: "scale",
            pushReadiness: "eligible_for_push_when_enabled",
            queueEligible: true,
            canApply: true,
            blockers: [],
            missingEvidence: [],
            explanation: "Supported ad set apply path is policy approved.",
          }),
        }),
      ],
      decisionAsOf: "2026-04-10",
    });

    expect(decorated?.throughput.defaultQueueEligible).toBe(false);
    expect(decorated?.operatorInstruction?.pushReadiness).toBe("blocked_from_push");
    expect(decorated?.operatorInstruction?.canApply).toBe(false);
  });

  it("keeps malformed provenance rows non-applyable even with copied fingerprints", () => {
    const action = buildActionFixture({
      sourceType: "meta_adset_decision",
      recommendedAction: "scale_budget",
      operatorPolicy: blockedOperatorPolicy({
        state: "do_now",
        actionClass: "scale",
        pushReadiness: "eligible_for_push_when_enabled",
        queueEligible: true,
        canApply: true,
        blockers: [],
        missingEvidence: [],
        explanation: "Supported ad set apply path is policy approved.",
      }),
    });
    const [decorated] = decorateCommandCenterActionsWithThroughput({
      actions: [
        {
          ...action,
          provenance: action.provenance
            ? {
                ...action.provenance,
                evidenceHash: "",
                actionFingerprint: action.actionFingerprint,
              }
            : null,
        },
      ],
      decisionAsOf: "2026-04-10",
    });

    expect(decorated?.throughput.defaultQueueEligible).toBe(false);
    expect(decorated?.operatorInstruction?.pushReadiness).toBe("blocked_from_push");
    expect(decorated?.operatorInstruction?.canApply).toBe(false);
    expect(decorated?.operatorInstruction?.invalidActions.join(" ")).toContain(
      "Missing complete decision provenance.",
    );
  });

  it("keeps valid safe-to-queue Creative instruction free of false queue warnings", () => {
    const payload = creativeFixture();
    payload.creatives[0]!.operatorPolicy = creativeOperatorPolicy();
    payload.creatives[0]!.trust = {
      surfaceLane: "action_core",
      truthState: "live_confident",
      operatorDisposition: "standard",
      reasons: ["Creative policy allows manual queue work."],
    };
    const decorated = decorateCommandCenterActionsWithThroughput({
      actions: aggregateCommandCenterActions({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        metaDecisionOs: null,
        creativeDecisionOs: payload,
      }),
      decisionAsOf: "2026-04-10",
    });
    const creativeAction = decorated.find(
      (action) =>
        action.sourceType === "creative_primary_decision" &&
        action.title === "Promo Hook A",
    );

    expect(creativeAction?.operatorPolicy?.queueEligible).toBe(true);
    expect(creativeAction?.operatorInstruction?.queueEligible).toBe(true);
    expect(creativeAction?.operatorInstruction?.canApply).toBe(false);
    expect(creativeAction?.operatorInstruction?.invalidActions.join(" ")).not.toContain(
      "Do not promote this Command Center card into queue work",
    );
  });

  it("keeps placement anomaly actions queue-eligible when upstream provenance is present", () => {
    const meta = metaFixture();
    meta.placementAnomalies = [
      {
        placementKey: "feed",
        label: "Feed",
        action: "exception_review",
        confidence: 0.8,
        note: "Spend concentration is underperforming.",
        evidence: [{ label: "Placement ROAS", value: "0.8x", impact: "negative" }],
        whatWouldChangeThisDecision: ["Recovery toward account average."],
        ...rowProvenanceFixture({
          system: "meta",
          entityType: "placement",
          entityId: "feed",
          sourceDecisionId: "feed:exception_review",
          recommendedAction: "exception_review",
        }),
      },
    ];

    const decorated = decorateCommandCenterActionsWithThroughput({
      decisionAsOf: "2026-04-10",
      actions: aggregateCommandCenterActions({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        metaDecisionOs: meta,
        creativeDecisionOs: creativeFixture(),
      }),
    });
    const placementAction = decorated.find(
      (action) => action.sourceType === "meta_placement_anomaly",
    );

    expect(placementAction?.provenance?.sourceRowScope.entityType).toBe("placement");
    expect(placementAction?.sourceContext.sourceDecisionId).toBe(
      "feed:exception_review",
    );
    expect(placementAction?.throughput.defaultQueueEligible).toBe(true);
    expect(placementAction?.operatorInstruction?.canApply).toBe(false);
  });

  it("builds a bounded default queue, owner workload, and shift digest from throughput metadata", () => {
    const decorated = decorateCommandCenterActionsWithThroughput({
      decisionAsOf: "2026-04-10",
      actions: [
        buildActionFixture({
          actionFingerprint: "critical_a",
          title: "Critical A",
          priority: "critical",
          createdAt: "2026-04-09T18:00:00.000Z",
          assigneeUserId: "owner_1",
          assigneeName: "Alice",
        }),
        buildActionFixture({
          actionFingerprint: "critical_b",
          title: "Critical B",
          priority: "critical",
          createdAt: "2026-04-09T16:00:00.000Z",
        }),
        ...Array.from({ length: 4 }, (_, index) =>
          buildActionFixture({
            actionFingerprint: `high_${index}`,
            title: `High ${index}`,
            priority: "high",
            createdAt: `2026-04-08T0${index}:00:00.000Z`,
            assigneeUserId: "owner_1",
            assigneeName: "Alice",
          }),
        ),
        ...Array.from({ length: 5 }, (_, index) =>
          buildActionFixture({
            actionFingerprint: `medium_${index}`,
            title: `Medium ${index}`,
            priority: "medium",
            createdAt: "2026-04-06T00:00:00.000Z",
            assigneeUserId: index < 2 ? "owner_2" : null,
            assigneeName: index < 2 ? "Blair" : null,
          }),
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          buildActionFixture({
            actionFingerprint: `low_${index}`,
            title: `Low ${index}`,
            priority: "low",
            createdAt: "2026-04-09T20:00:00.000Z",
          }),
        ),
      ],
    });

    const throughput = buildCommandCenterDefaultQueueSummary(decorated);
    const selected = applyCommandCenterQueueSelection({
      actions: decorated,
      throughput,
    });
    const ownerWorkload = buildCommandCenterOwnerWorkload({
      actions: selected,
      throughput,
    });
    const feedbackSummary = summarizeCommandCenterFeedback([
      buildFeedbackEntry({
        feedbackType: "false_negative",
        scope: "queue_gap",
        actionFingerprint: null,
        actionTitle: null,
        sourceSystem: "meta",
      }),
    ]);
    const shiftDigest = buildCommandCenterShiftDigest({
      throughput,
      actions: selected,
      ownerWorkload,
      feedbackSummary,
    });

    expect(throughput.selectedCount).toBe(12);
    expect(throughput.overflowCount).toBe(2);
    expect(
      selected.filter((action) => action.throughput.selectedInDefaultQueue),
    ).toHaveLength(12);
    expect(ownerWorkload[0]).toMatchObject({
      ownerName: "Unassigned",
      openCount: 7,
      overdueCount: 4,
    });
    expect(shiftDigest.headline).toContain("12 actions fit the current shift budget");
    expect(shiftDigest.watchouts.some((entry) => entry.includes("queue-gap"))).toBe(true);
  });

  it("groups saved views into fixed stacks and summarizes feedback rollups", () => {
    const builtIns = getBuiltInCommandCenterSavedViews("biz");
    const customView: CommandCenterSavedView = {
      id: "custom:1",
      businessId: "biz",
      viewKey: "custom_operator_focus",
      name: "Operator focus",
      definition: {
        statuses: ["pending"],
      },
      isBuiltIn: false,
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
    };
    const stacks = buildCommandCenterViewStacks([...builtIns, customView]);
    const feedbackSummary = summarizeCommandCenterFeedback([
      buildFeedbackEntry({
        id: "fp_1",
        feedbackType: "false_positive",
        createdAt: "2026-04-10T08:00:00.000Z",
      }),
      buildFeedbackEntry({
        id: "br_1",
        feedbackType: "bad_recommendation",
        createdAt: "2026-04-10T09:00:00.000Z",
      }),
      buildFeedbackEntry({
        id: "fn_1",
        feedbackType: "false_negative",
        scope: "queue_gap",
        actionFingerprint: null,
        actionTitle: null,
        createdAt: "2026-04-10T10:00:00.000Z",
      }),
    ]);

    expect(stacks.map((stack) => stack.label)).toEqual([
      "Run now",
      "Optimize",
      "Watch",
      "History",
      "Custom",
    ]);
    expect(stacks.at(-1)?.views[0]?.viewKey).toBe("custom_operator_focus");
    expect(feedbackSummary).toMatchObject({
      totalCount: 3,
      falsePositiveCount: 1,
      badRecommendationCount: 1,
      falseNegativeCount: 1,
      queueGapCount: 1,
    });
    expect(feedbackSummary.recentEntries[0]?.id).toBe("fn_1");
  });
});
