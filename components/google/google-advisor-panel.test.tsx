import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GoogleAdvisorPanel } from "@/components/google/google-advisor-panel";
import { buildGoogleAdsOperatorActionCard } from "@/lib/google-ads/advisor-action-contract";
import type {
  GoogleAdvisorResponse,
  GoogleRecommendation,
} from "@/lib/google-ads/growth-advisor-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => undefined,
    push: () => undefined,
    replace: () => undefined,
    prefetch: () => undefined,
  }),
}));

function buildRecommendation(
  id: string,
  lane: GoogleRecommendation["decision"]["lane"],
  overrides: Partial<GoogleRecommendation> = {}
): GoogleRecommendation {
  const integrityState =
    lane === "suppressed" ? "suppressed" : lane === "watch" ? "downgraded" : "ready";
  return {
    id,
    level: "account",
    type: lane === "suppressed" ? "query_governance" : "brand_leakage",
    strategyLayer: "Search Governance",
    decisionState: lane === "test" ? "test" : lane === "watch" ? "watch" : "act",
    decisionFamily: lane === "suppressed" ? "waste_control" : "brand_governance",
    doBucket: lane === "test" ? "do_next" : lane === "watch" || lane === "suppressed" ? "do_later" : "do_now",
    priority: "high",
    confidence: lane === "watch" ? "medium" : "high",
    dataTrust: "high",
    integrityState,
    supportStrength: "strong",
    actionability: lane === "suppressed" ? "not_ready" : "ready_now",
    reversibility: "high",
    title: `${lane} recommendation`,
    summary: `${lane} summary`,
    why: `${lane} why`,
    decision: {
      decisionFamily: lane === "suppressed" ? "waste_control" : "brand_governance",
      lane,
      riskLevel: lane === "suppressed" ? "high" : "medium",
      blastRadius: lane === "suppressed" ? "account" : "campaign",
      confidence: lane === "watch" ? 0.62 : 0.88,
      windowsUsed: {
        healthWindow: "alarm_7d",
        primaryWindow: "operational_28d",
        queryWindow: "query_governance_56d",
        baselineWindow: "baseline_84d",
        maturityCutoffDays: 84,
      },
      whyNow: `${lane} why now`,
      whyNot: lane === "suppressed" ? ["Unsafe query cleanup is suppressed in V1."] : [],
      blockers: lane === "suppressed" ? ["Unsafe query cleanup is suppressed in V1."] : [],
      validationPlan: ["Check the next review window."],
      rollbackPlan: ["Reverse manually in Google Ads if the plan is executed."],
      evidenceSummary: `${lane} evidence summary`,
      evidencePoints: [{ label: "Evidence", value: `${lane} evidence` }],
    },
    decisionNarrative: {
      whatHappened: `${lane} what happened`,
      whyItHappened: `${lane} why it happened`,
      whatToDo: `${lane} what to do`,
      risk: `${lane} risk`,
      howToValidate: ["Check the next review window."],
      howToRollBack: "Reverse manually in Google Ads if the plan is executed.",
    },
    whyNow: `${lane} why now`,
    reasonCodes: ["reason_code"],
    confidenceExplanation: "Confidence is based on multi-window support.",
    confidenceDegradationReasons: [],
    recommendedAction: `${lane} action`,
    potentialContribution: {
      label: "Control gain",
      impact: "medium",
      summary: `${lane} contribution`,
    },
    impactBand: "medium",
    effortScore: "low",
    rollbackGuidance: "Reverse manually in Google Ads if needed.",
    validationChecklist: ["Check the next review window."],
    blockers: lane === "suppressed" ? ["Unsafe query cleanup is suppressed in V1."] : [],
    rankScore: 10,
    rankExplanation: "Rank rationale",
    impactScore: 5,
    recommendationFingerprint: `fp_${id}`,
    evidence: [{ label: "Evidence", value: `${lane} evidence` }],
    timeframeContext: {
      coreVerdict: "core",
      selectedRangeNote: "selected range note",
      historicalSupport: "history",
    },
    suppressionReasons: lane === "suppressed" ? ["branded_query", "ambiguous_intent"] : [],
    suppressedQueries: lane === "suppressed" ? ["grandmix chairs"] : [],
    negativeQueries: lane === "suppressed" ? [] : undefined,
    negativeKeywordPolicy:
      lane === "suppressed"
        ? {
            requiredMatchType: "exact",
            exactOnlyEnforced: true,
            eligibleQueryCount: 0,
            suppressedQueryCount: 1,
            suppressionReasons: ["branded_query", "ambiguous_intent"],
          }
        : null,
    ...overrides,
  };
}

function buildAdvisor(recommendations: GoogleRecommendation[] = []): GoogleAdvisorResponse {
  return {
    summary: {
      headline: "Stabilize paid search waste first",
      operatorNote: "Multi-window analysis is active.",
      demandMap: "Brand Search 40% spend",
      topPriority: "Review waste-control plan",
      totalRecommendations: recommendations.length,
      actRecommendationCount: recommendations.filter((entry) => entry.decisionState === "act").length,
      accountState: "scaling_ready",
      accountOperatingMode: "Operator-first",
      topConstraint: "Waste in non-brand search",
      topGrowthLever: "Demand capture",
      recommendedFocusToday: "Review search governance",
      watchouts: [],
      dataTrustSummary: "Signal quality is stable.",
      campaignRoles: [],
    },
    recommendations,
    sections: [],
    clusters: [],
    metadata: {
      analysisMode: "snapshot",
      asOfDate: "2026-04-08",
      decisionEngineVersion: "v2",
      snapshotModel: "decision_snapshot_v2",
      selectedWindowKey: "operational_28d",
      primaryWindowKey: "operational_28d",
      queryWindowKey: "query_governance_56d",
      baselineWindowKey: "baseline_84d",
      maturityCutoffDays: 84,
      lagAdjustedEndDate: {
        available: false,
        value: null,
        note: "Lag-adjusted end date is not yet computed in the current Google Ads serving architecture.",
      },
      selectedRangeRole: "contextual_only",
      analysisWindows: {
        healthAlarmWindows: [
          {
            key: "alarm_7d",
            label: "health 7d",
            startDate: "2026-04-02",
            endDate: "2026-04-08",
            days: 7,
            role: "health_alarm",
          },
        ],
        operationalWindow: {
          key: "operational_28d",
          label: "operational 28d",
          startDate: "2026-03-12",
          endDate: "2026-04-08",
          days: 28,
          role: "operational_decision",
        },
        queryGovernanceWindow: {
          key: "query_governance_56d",
          label: "query governance 56d",
          startDate: "2026-02-12",
          endDate: "2026-04-08",
          days: 56,
          role: "query_governance",
        },
        baselineWindow: {
          key: "baseline_84d",
          label: "baseline 84d",
          startDate: "2026-01-15",
          endDate: "2026-04-08",
          days: 84,
          role: "baseline",
        },
      },
      executionSurface: {
        mode: "operator_first_manual_plan",
        decisionEngineV2Enabled: true,
        writebackEnabled: false,
        mutateVerified: false,
        rollbackVerified: false,
        capabilityGateReason: "Write-back is disabled.",
        summary: "Operator-first manual plan surface.",
      },
      historicalSupportAvailable: false,
      historicalSupport: null,
      decisionSummaryTotals: {
        windowKey: "operational_28d",
        windowLabel: "operational 28d",
        spend: 100,
        revenue: 300,
        conversions: 10,
        roas: 3,
      },
      canonicalWindowTotals: {
        spend: 100,
        revenue: 300,
        conversions: 10,
        roas: 3,
      },
      selectedRangeContext: {
        eligible: true,
        state: "aligned",
        label: "Selected range aligned",
        summary: "Selected 7-day view is broadly aligned with the multi-window decision snapshot.",
        selectedRangeStart: "2026-04-02",
        selectedRangeEnd: "2026-04-08",
        deltaPercent: 0,
        metricKey: "roas",
      },
      aggregateIntelligence: {
        topQueryWeeklyAvailable: true,
        clusterDailyAvailable: true,
        queryWeeklyRows: 12,
        clusterDailyRows: 48,
        supportWindowStart: "2026-01-15",
        supportWindowEnd: "2026-04-08",
        note: "Persisted weekly top-query and daily cluster aggregates are loaded as supplemental support.",
      },
      actionContract: {
        version: "google_ads_advisor_action_v2",
        source: "native",
        note: "Structured operator cards are the source of truth for this snapshot.",
      },
    },
  };
}

describe("GoogleAdvisorPanel", () => {
  it("renders the operator queue grouped by review, test, watch, and suppressed lanes", () => {
    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([
          buildRecommendation("r1", "review"),
          buildRecommendation("r2", "test"),
          buildRecommendation("r3", "watch"),
          buildRecommendation("r4", "suppressed"),
        ]),
      })
    );

    expect(html).toContain("Account decisions");
    expect(html).toContain("Decision Snapshot");
    expect(html).toContain("Manual Action Packs");
    expect(html).toContain("Opportunity Queue");
    expect(html).toContain("Review");
    expect(html).toContain("Test");
    expect(html).toContain("Watch");
    expect(html).toContain("Suppressed");
  });

  it("renders operationally complete recommendation fields and manual-plan semantics", () => {
    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([buildRecommendation("r1", "review")]),
      })
    );

    expect(html).toContain("Primary action");
    expect(html).toContain("Scope");
    expect(html).toContain("Exact changes");
    expect(html).toContain("Expected effect");
    expect(html).toContain("Why this now");
    expect(html).toContain("Evidence");
    expect(html).toContain("Validation");
    expect(html).toContain("Rollback");
    expect(html).toContain("Manual plan only");
    expect(html).toContain("Write-back disabled");
    expect(html).toContain("Aggregate support");
    expect(html.indexOf("Primary action")).toBeLessThan(html.indexOf("Recommendation label: review recommendation"));
    expect(html.indexOf("Exact changes")).toBeLessThan(html.indexOf("Narrative context and legacy details"));
  });

  it("renders bundled action packs as manual approval-only clusters", () => {
    const advisor = buildAdvisor([buildRecommendation("r1", "review")]);
    advisor.clusters = [
      {
        clusterId: "cluster_1",
        clusterType: "cleanup_then_scale",
        clusterObjective: "Clear waste before scaling non-brand demand",
        clusterBucket: "next",
        memberRecommendationIds: ["r1"],
        memberRecommendationFingerprints: ["fp_r1"],
        clusterReadiness: "staging",
        clusterTrustBand: "medium",
        clusterRankScore: 72,
        clusterRankReason: "Waste cleanup unlocks a later growth move.",
        clusterStatus: "ready",
        clusterMoveValidity: "valid",
        clusterMoveValidityReason: "No conflicting steps are attached.",
        clusterMoveConfidence: "medium",
        dependsOnClusterIds: [],
        unlocksClusterIds: [],
        conflictsWithClusterIds: [],
        executionSummary: {
          clusterExecutionId: null,
          clusterExecutionStatus: "not_started",
          childExecutionOrder: ["step_1", "step_2"],
          childTransactionIds: [],
          completedChildStepIds: [],
          failedChildStepIds: [],
          currentStepId: null,
          stopReason: null,
        },
        validationPlan: ["Check waste leakage after 7 days."],
        outcomeState: {
          verdict: "unvalidated",
          confidence: null,
          failReason: null,
          lastValidationCheckAt: null,
          reason: null,
        },
        steps: [
          {
            stepId: "step_1",
            title: "Add exact negatives",
            stepType: "handoff",
            required: true,
            stepCriticality: "critical",
            stepFailureBoundary: "invalidate_move",
            stepValidationRole: "unlock_gate",
            executionMode: "handoff",
            recommendationIds: ["r1"],
            recommendationFingerprints: ["fp_r1"],
            stabilizationHoldUntil: "2026-04-15T00:00:00.000Z",
          },
          {
            stepId: "step_2",
            title: "Promote exact buildout terms",
            stepType: "handoff",
            required: true,
            stepCriticality: "supporting",
            stepFailureBoundary: "degrade_move",
            stepValidationRole: "supporting_signal",
            executionMode: "handoff",
            recommendationIds: ["r1"],
            recommendationFingerprints: ["fp_r1"],
          },
        ],
      } as unknown as GoogleAdvisorResponse["clusters"][number],
    ];

    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor,
      })
    );

    expect(html).toContain("Bundled operator moves");
    expect(html).toContain("Clear waste before scaling non-brand demand");
    expect(html).toContain("Approval: required");
    expect(html).toContain("Cooldown:");
    expect(html).toContain("Add exact negatives");
    expect(html).toContain("Promote exact buildout terms");
    expect(html).toContain("Exact member changes");
    expect(html).toContain("Cluster outcome");
  });

  it("shows manual lifecycle controls when persistence context is available", () => {
    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([buildRecommendation("r1", "review")]),
        businessId: "biz_1",
        accountId: "all",
      })
    );

    expect(html).toContain("Operator actions");
    expect(html).toContain("Mark applied");
    expect(html).toContain("Suppress 7d");
    expect(html).toContain("Mark complete");
    expect(html).toContain("Log outcome");
  });

  it("surfaces validation-due and recent outcome workflow queues without implying automation", () => {
    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([
          buildRecommendation("r-due", "review", {
            currentStatus: "persistent",
            userAction: "applied",
            executionStatus: "applied",
            appliedAt: "2026-04-01T00:00:00.000Z",
            outcomeCheckAt: "2026-04-05T00:00:00.000Z",
            outcomeCheckWindowDays: 7,
            outcomeVerdict: "unknown",
          }),
          buildRecommendation("r-outcome", "review", {
            currentStatus: "resolved",
            userAction: "applied",
            executionStatus: "applied",
            appliedAt: "2026-04-01T00:00:00.000Z",
            outcomeCheckAt: "2026-04-06T00:00:00.000Z",
            outcomeCheckWindowDays: 7,
            outcomeVerdict: "improved",
            outcomeMetric: "manual_validation",
            outcomeDelta: 12,
          }),
        ]),
      })
    );

    expect(html).toContain("Lifecycle, validation, and outcomes");
    expect(html).toContain("Recommendations waiting for operator outcome checks");
    expect(html).toContain("Most recent logged operator validations");
    expect(html).toContain("Due 2026-04-05T00:00:00Z");
    expect(html).toContain("Improved");
    expect(html).toContain("Logged outcomes are operator-entered validations");
  });

  it("shows AI structured assist provenance without displacing the action-first contract", () => {
    const assistedRecommendation = buildRecommendation("r-ai", "review", {
      operatorActionCard: {
        ...buildGoogleAdsOperatorActionCard(buildRecommendation("r-ai-card", "review"), "native"),
        assistMode: "ai_structured_assist",
        primaryAction: "Tighten brand routing before scaling discovery again.",
      },
      structuredAssist: {
        state: "applied",
        mode: "snapshot_time",
        model: "gpt-5-nano",
        reason: "Structured AI assist applied to deterministic fallback recommendation fields.",
        filledFields: ["primaryAction", "exactChanges"],
        promptVersion: "google_ads_ai_structured_assist_v1",
        attemptedAt: "2026-04-10T00:00:00.000Z",
        validationFailureCategory: null,
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([assistedRecommendation]),
      })
    );

    expect(html).toContain("AI-structured assist");
    expect(html).toContain("This structured card was synthesized from existing recommendation evidence at snapshot time.");
    expect(html.indexOf("Primary action")).toBeLessThan(
      html.indexOf("This structured card was synthesized from existing recommendation evidence at snapshot time.")
    );
  });

  it("renders suppressed recommendations with explicit suppression reasons and contextual selected-range language", () => {
    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([buildRecommendation("r4", "suppressed")]),
      })
    );

    expect(html).toContain("Suppression reasons");
    expect(html).toContain("Blocked because");
    expect(html).toContain("Branded query");
    expect(html).toContain("grandmix chairs");
    expect(html).toContain("selected range is context only");
    expect(html).not.toContain("canonical 90-day");
    expect(html).not.toContain("90-day snapshot");
  });

  it("shows honest empty lane states when no recommendations are present", () => {
    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([]),
      })
    );

    expect(html).toContain("No decisions in this lane right now.");
  });

  it("does not crash when a recommendation payload is missing decision and narrative fields", () => {
    const partialRecommendation = {
      ...buildRecommendation("legacy-demo", "review"),
      decision: undefined,
      decisionNarrative: undefined,
      rollbackGuidance: "Reverse manually if needed.",
      validationChecklist: ["Review next sync window."],
    } as unknown as GoogleRecommendation;

    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: buildAdvisor([partialRecommendation]),
      })
    );

    expect(html).toContain("review recommendation");
    expect(html).toContain("review summary");
    expect(html).toContain("review why");
    expect(html).toContain("review action");
    expect(html).toContain("Review next sync window.");
    expect(html).toContain("Reverse manually if needed.");
  });

  it("shows a compatibility notice when the snapshot predates the native action contract", () => {
    const legacyAdvisor = buildAdvisor([buildRecommendation("legacy", "review")]);
    if (legacyAdvisor.metadata) {
      delete legacyAdvisor.metadata.actionContract;
    }

    const html = renderToStaticMarkup(
      React.createElement(GoogleAdvisorPanel, {
        advisor: legacyAdvisor,
      })
    );

    expect(html).toContain("legacy snapshot compatibility mode");
    expect(html).toContain("derived from older recommendation fields");
  });
});
