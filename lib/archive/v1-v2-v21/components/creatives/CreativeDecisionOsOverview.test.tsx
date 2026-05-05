import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { buildCreativeQuickFilters } from "@/lib/creative-operator-surface";
import { CreativeDecisionOsOverview } from "@/components/creatives/CreativeDecisionOsOverview";
import { createEmptyBusinessCommercialCoverageSummary } from "@/src/types/business-commercial";

function payload() {
  const metadata = buildOperatorDecisionMetadata({
    analyticsStartDate: "2026-04-01",
    analyticsEndDate: "2026-04-10",
    decisionAsOf: "2026-04-10",
  });
  const commercialSummary = createEmptyBusinessCommercialCoverageSummary();
  const policyExplanation = {
    summary: "Shared policy ladder kept keep in test active for this creative.",
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
        reason: "No compatible live lane is ready for this creative yet.",
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
      candidateAction: "keep_in_test",
      selectedAction: "keep_in_test",
      cutoverState: "candidate_active",
      reason:
        "Shared policy ladder keeps this in test because one or more scale floors are still on watch.",
    },
  } as const;
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
      totalCreatives: 8,
      scaleReadyCount: 2,
      keepTestingCount: 2,
      fatiguedCount: 1,
      blockedCount: 2,
      comebackCount: 1,
      protectedWinnerCount: 1,
      supplyPlanCount: 2,
      opportunitySummary: {
        totalCount: 3,
        queueEligibleCount: 1,
        protectedCount: 1,
        familyScaleCount: 2,
        headline: "1 creative opportunity item is ready once evidence floors stay intact.",
      },
      message: "Decision OS highlights Scale, Test More, Protect, Refresh, Cut, and Diagnose primary decisions with review-only and reason-tag context.",
      operatingMode: "Exploit",
      surfaceSummary: {
        actionCoreCount: 4,
        watchlistCount: 2,
        archiveCount: 2,
        degradedCount: 1,
      },
      benchmarkScope: {
        benchmarkScope: "account",
        benchmarkScopeLabel: "Account-wide",
        benchmarkSource: "account_default",
        benchmarkScopeId: null,
        benchmarkReliability: "strong",
      },
    },
    creatives: [
      {
        creativeId: "c1",
        name: "Travel Pack Winner",
        familyLabel: "Travel Hook Family",
        confidence: 0.84,
        lifecycleState: "scale_ready",
        primaryAction: "promote_to_scaling",
        summary: "Promote this concept into scaling.",
        spend: 420,
        roas: 3.95,
        purchases: 18,
        ctr: 2.1,
        evidenceSource: "live",
        operatorPolicy: {
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
          explanation:
            "Deterministic Creative policy allows this as operator work, but provider push remains disabled.",
        },
        previewStatus: {
          liveDecisionWindow: "ready",
          reason: null,
        },
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["Promote this concept into scaling."],
        },
        deployment: {
          targetLane: "Scaling",
          constraints: [],
          compatibility: { reasons: [] },
        },
        economics: {
          reasons: [],
        },
        policy: {
          primaryDriver: "deployment_match",
          objectiveFamily: "Sales",
          bidRegime: "cost_cap",
          metaFamily: "purchase_value",
          deploymentCompatibility: "limited",
          explanation: policyExplanation,
        },
      },
    ],
    lifecycleBoard: [
      { state: "incubating", label: "incubating", count: 1, creativeIds: ["c1"] },
      { state: "validating", label: "validating", count: 1, creativeIds: ["c2"] },
      { state: "scale_ready", label: "scale_ready", count: 1, creativeIds: ["c3"] },
      { state: "stable_winner", label: "stable_winner", count: 1, creativeIds: ["c4"] },
      { state: "fatigued_winner", label: "fatigued_winner", count: 1, creativeIds: ["c5"] },
      { state: "blocked", label: "blocked", count: 1, creativeIds: ["c6"] },
      { state: "retired", label: "retired", count: 1, creativeIds: ["c7"] },
      { state: "comeback_candidate", label: "comeback_candidate", count: 1, creativeIds: ["c8"] },
    ],
    operatorQueues: [
      { key: "promotion", label: "Promotion queue", summary: "Scale creatives", count: 2, creativeIds: ["c3", "c4"] },
      { key: "keep_testing", label: "Board-only / Test More", summary: "Still in Test More", count: 2, creativeIds: ["c1", "c2"] },
      { key: "fatigued_blocked", label: "Fatigued / blocked", summary: "Refresh or block", count: 3, creativeIds: ["c5", "c6", "c7"] },
      { key: "comeback", label: "Comeback", summary: "Retest", count: 1, creativeIds: ["c8"] },
    ],
    families: [
      {
        familyId: "family:1",
        familyLabel: "Travel Hook Family",
        familySource: "copy_signature",
        creativeIds: ["c1", "c2"],
        dominantFormat: "video",
        lifecycleState: "scale_ready",
        primaryAction: "promote_to_scaling",
        totalSpend: 420,
        totalPurchaseValue: 1660,
        totalPurchases: 18,
        topAngles: ["utility"],
        topHooks: ["travel hook"],
        metaFamily: "purchase_value",
        metaFamilyLabel: "purchase/value",
        provenance: {
          confidence: "medium",
          overGroupingRisk: "medium",
          evidence: ["Heuristic family matched same format, primary taxonomy, and normalized headline."],
        },
      },
    ],
    patterns: [
      {
        patternKey: "travel",
        hook: "Travel hook",
        angle: "utility",
        format: "video",
        creativeIds: ["c1", "c2"],
        spend: 420,
        purchaseValue: 1660,
        roas: 3.95,
        lifecycleState: "scale_ready",
        confidence: 0.78,
      },
    ],
    protectedWinners: [
      {
        creativeId: "c4",
        familyId: "family:1",
        creativeName: "Winner creative",
        familyLabel: "Travel Hook Family",
        spend: 240,
        roas: 3.8,
        reasons: ["Deterministic engine marks this as a shipped winner that should stay protected."],
      },
    ],
    supplyPlan: [
      {
        kind: "expand_angle_family",
        priority: "medium",
        familyId: "family:1",
        familyLabel: "Travel Hook Family",
        creativeIds: ["c1", "c2"],
        summary: "Expand this winner family with adjacent angle variants before saturation shows up.",
        reasons: ["Family is scale-capable but creative depth is still shallow."],
      },
      {
        kind: "new_test_concepts",
        priority: "high",
        familyId: "family:2",
        familyLabel: "Backup Family",
        creativeIds: ["c5"],
        summary: "Generate fresh test concepts to widen hook and angle coverage for this family.",
        reasons: ["Family has meaningful spend but no protected winner yet."],
      },
    ],
    opportunityBoard: [
      {
        opportunityId: "creative-family-scale:family:1",
        kind: "creative_family_winner_scale",
        title: "Travel Hook Family",
        summary: "Promote this concept into scaling.",
        recommendedAction: "promote_to_scaling",
        confidence: 0.83,
        queue: {
          eligible: true,
          blockedReasons: [],
          watchReasons: [],
        },
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
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["Promote this concept into scaling."],
        },
        familyId: "family:1",
        creativeIds: ["c1", "c2"],
      },
      {
        opportunityId: "creative-family-scale:family:2",
        kind: "creative_family_winner_scale",
        title: "Backup Family",
        summary: "Generate fresh test concepts to widen hook and angle coverage for this family.",
        recommendedAction: "promote_to_scaling",
        confidence: 0.66,
        queue: {
          eligible: false,
          blockedReasons: ["Shared authority still caps this family out of the default queue."],
          watchReasons: [],
        },
        evidenceFloors: [
          {
            key: "commercial_truth",
            label: "Commercial truth",
            status: "blocked",
            current: "degraded missing truth",
            required: "live confident",
            reason: "Shared authority still caps this family out of the default queue.",
          },
        ],
        tags: ["scale_promotions"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "degraded_missing_truth",
          operatorDisposition: "degraded_no_scale",
          reasons: ["Commercial truth is incomplete."],
        },
        familyId: "family:2",
        creativeIds: ["c5"],
      },
      {
        opportunityId: "creative-protected:c4",
        kind: "protected_winner",
        title: "Winner creative",
        summary: "Deterministic engine marks this as a shipped winner that should stay protected.",
        recommendedAction: "hold_no_touch",
        confidence: 0.8,
        queue: {
          eligible: false,
          blockedReasons: ["Protected winners stay visible for operator context, not as queue work."],
          watchReasons: [],
        },
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
          reasons: ["Deterministic engine marks this as a shipped winner that should stay protected."],
        },
        familyId: "family:1",
        creativeIds: ["c4"],
      },
    ],
    commercialTruthCoverage: {
      operatingMode: "Exploit",
      confidence: 0.82,
      missingInputs: [],
      activeInputs: [],
      guardrails: ["Scale in controlled steps."],
      configuredSections: {
        targetPack: true,
        countryEconomics: true,
        promoCalendar: false,
        operatingConstraints: true,
      },
      summary: commercialSummary,
    },
    authority: {
      scope: "Creative Decision OS",
      truthState: "degraded_missing_truth",
      completeness: "missing",
      freshness: {
        status: "fresh",
        updatedAt: null,
        reason: null,
      },
      missingInputs: ["target_pack"],
      reasons: ["Commercial truth is incomplete."],
      actionCoreCount: 4,
      watchlistCount: 2,
      archiveCount: 2,
      suppressedCount: 4,
      note: "Creative Decision OS remains visible but caps aggressive actions until truth coverage improves.",
    },
    historicalAnalysis: {
      summary:
        "Video leads the selected-period format mix while Travel Pack and Utility describe the strongest visible pattern. This block is analysis-only and does not change deterministic Decision Signals.",
      selectedWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        rowCount: 8,
        materialRowCount: 6,
        note: "Analysis only. Live decisions continue to use the primary decision window.",
      },
      winningFormats: [
        {
          label: "Video",
          creativeCount: 5,
          spend: 640,
          purchaseValue: 2_240,
          purchases: 20,
          roas: 3.5,
          shareOfSpend: 0.64,
          summary: "Format Video covers 5 creative(s), 640 spend, 3.50x ROAS, and 20 purchase(s) in the selected period.",
        },
      ],
      hookTrends: [
        {
          label: "Travel Pack",
          creativeCount: 3,
          spend: 420,
          purchaseValue: 1_660,
          purchases: 18,
          roas: 3.95,
          shareOfSpend: 0.42,
          summary: "Hook Travel Pack covers 3 creative(s), 420 spend, 3.95x ROAS, and 18 purchase(s) in the selected period.",
        },
      ],
      angleTrends: [
        {
          label: "Utility",
          creativeCount: 4,
          spend: 480,
          purchaseValue: 1_780,
          purchases: 19,
          roas: 3.71,
          shareOfSpend: 0.48,
          summary: "Angle Utility covers 4 creative(s), 480 spend, 3.71x ROAS, and 19 purchase(s) in the selected period.",
        },
      ],
      familyPerformance: [
        {
          familyId: "family:1",
          familyLabel: "Travel Hook Family",
          familySource: "copy_signature",
          creativeCount: 2,
          dominantFormat: "Video",
          spend: 420,
          purchaseValue: 1_660,
          purchases: 18,
          roas: 3.95,
          topHook: "Travel Pack",
          topAngle: "Utility",
          summary:
            "Travel Hook Family covers 2 creative(s) with 420 spend and 3.95x ROAS in the selected period.",
        },
      ],
    },
  } as any;
}

describe("CreativeDecisionOsOverview", () => {
  it("renders operator-grade recommendation sections", () => {
    const html = renderToStaticMarkup(
      <CreativeDecisionOsOverview
        decisionOs={payload()}
        quickFilters={buildCreativeQuickFilters(payload())}
        isLoading={false}
        activeFamilyId={null}
        activeQuickFilterKey={null}
        onSelectFamily={vi.fn()}
        onSelectQuickFilter={vi.fn()}
      />,
    );

    expect(html).toContain("Operator Console");
    expect(html).toContain("Creative Operator Console");
    expect(html).toContain("Benchmark: Account-wide");
    expect(html).toContain("Baseline: Strong");
    expect(html).toContain("Business validation missing");
    expect(html).toContain(
      "Relative winners stay visible in this scope, but missing business validation keeps scale-style moves in review only.",
    );
    expect(html).toContain("Decisions use live windows. Selected period affects analysis only.");
    expect(html).toContain("Preview Truth");
    expect(html).toContain("Preview truth is ready across this review scope.");
    expect(html).toContain("1 ready · 0 degraded · 0 missing.");
    expect(html).toContain("Creative Authority");
    expect(html).toContain("Operator Instructions");
    expect(html).toContain("do not invent a budget or bid amount");
    expect(html).toContain("safe to queue");
    expect(html).toContain("No safe amount calculated");
    expect(html).toContain("live evidence");
    expect(html).toContain("Policy Review");
    expect(html).toContain("candidate active");
    expect(html).toContain("Target ROAS 2.5x");
    expect(html).toContain("Decisions use live windows");
    expect(html).toContain("Scale");
    expect(html).toContain("Test More");
    expect(html).toContain("Diagnose");
    expect(html).toContain("Primary Decision Counts");
    expect(html).toContain("Same resolver primary-decision mapping as the Creative filters.");
    expect(html).toMatch(/data-testid="creative-taxonomy-count-scale"[\s\S]*>Scale<[\s\S]*>1</);
    expect(html).toContain("1 direct");
    expect(html).toContain("0 review first");
    expect(html).toMatch(/data-testid="creative-taxonomy-count-test_more"[\s\S]*>Test More<[\s\S]*>0</);
    expect(html).toMatch(/data-testid="creative-taxonomy-count-refresh"[\s\S]*>Refresh<[\s\S]*>0</);
    expect(html).toMatch(/data-testid="creative-taxonomy-count-cut"[\s\S]*>Cut<[\s\S]*>0</);
    expect(html).toMatch(/data-testid="creative-taxonomy-count-diagnose"[\s\S]*>Diagnose<[\s\S]*>0</);
    expect(html).toContain("Aggregate Health Counts");
    expect(html).toContain("Action core aggregate");
    expect(html).toContain("Cross-segment aggregates, not primary segment labels.");
    expect(html).toContain("Opportunity Board");
    expect(html).toContain("queue-ready");
    expect(html).toContain("Lifecycle Board");
    expect(html).toContain("Concept Families");
    expect(html).toContain("Pattern Board");
    expect(html).toContain("Protect");
    expect(html).toContain("Supply Planning");
    expect(html).toContain("Degraded commercial truth");
    expect(html).toContain("Historical Analysis");
    expect(html).toContain("Selected-period format and family patterns");
    expect(html).toContain("Travel Hook Family");
    expect(html).not.toContain("Blocked review");
    expect(html).not.toContain("Evergreen Winners");
    expect(html).not.toContain("Cut / Campaign Check");
  });
});
