import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { buildOperatorDecisionProvenance } from "@/lib/operator-decision-provenance";
import { createEmptyBusinessCommercialCoverageSummary } from "@/src/types/business-commercial";
import {
  MetaCampaignDecisionPanel,
  MetaDecisionOsOverview,
} from "@/components/meta/meta-decision-os";

function payload() {
  const metadata = buildOperatorDecisionMetadata({
    analyticsStartDate: "2026-04-01",
    analyticsEndDate: "2026-04-05",
    decisionAsOf: "2026-04-10",
  });
  const commercialSummary = createEmptyBusinessCommercialCoverageSummary();
  const policyExplanation = {
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
    missingEvidence: [
      {
        key: "bid_regime",
        label: "Bid regime",
        status: "watch",
        current: "cost_cap",
        required: "open or clearly outperforming capped delivery",
        reason: "Cost-cap delivery can scale, but only while the cap still leaves clean headroom.",
      },
    ],
    blockers: [],
    degradedReasons: [],
    actionCeiling: "Bid review first, then reopen the scale ladder only if headroom remains clean.",
    protectedWinnerHandling: null,
    fatigueOrComeback: null,
    supplyPlanning: null,
    compare: {
      compareMode: true,
      baselineAction: "scale_budget",
      candidateAction: "review_cost_cap",
      selectedAction: "scale_budget",
      cutoverState: "baseline_locked",
      reason:
        "Shared policy ladder stayed in compare mode because the candidate branch would have been more aggressive than the current baseline.",
    },
  } as const;
  const budgetShiftProvenance = buildOperatorDecisionProvenance({
    businessId: "biz",
    decisionAsOf: metadata.decisionAsOf,
    analyticsWindow: metadata.analyticsWindow,
    sourceWindow: metadata.decisionWindows.primary30d,
    sourceRowScope: {
      system: "meta",
      entityType: "budget_shift",
      entityId: "cmp_2:cmp_1",
    },
    sourceDecisionId: "cmp_2:cmp_1:budget_shift",
    recommendedAction: "budget_shift",
    evidence: ["10-15% of current budget load"],
  });
  const placementProvenance = buildOperatorDecisionProvenance({
    businessId: "biz",
    decisionAsOf: metadata.decisionAsOf,
    analyticsWindow: metadata.analyticsWindow,
    sourceWindow: metadata.decisionWindows.primary30d,
    sourceRowScope: {
      system: "meta",
      entityType: "placement",
      entityId: "feed",
    },
    sourceDecisionId: "feed:exception_review",
    recommendedAction: "exception_review",
    evidence: ["Spend is too concentrated."],
  });
  return {
    contractVersion: "meta-decision-os.v1",
    generatedAt: "2026-04-10T00:00:00.000Z",
    businessId: "biz",
    startDate: "2026-04-01",
    endDate: "2026-04-05",
    analyticsWindow: metadata.analyticsWindow,
    decisionWindows: metadata.decisionWindows,
    historicalMemory: metadata.historicalMemory,
    decisionAsOf: metadata.decisionAsOf,
    summary: {
      todayPlanHeadline: "Today plan",
      todayPlan: ["Protect winners", "Cut weak GEOs"],
      budgetShiftSummary: "One shift",
      noTouchSummary: "One no-touch",
      winnerScaleSummary: {
        candidateCount: 1,
        protectedCount: 1,
        headline: "1 active winner scale candidate is ready for controlled growth.",
      },
      operatingMode: { currentMode: "Exploit", recommendedMode: "Exploit", confidence: 0.82 },
      confidence: 0.82,
      surfaceSummary: {
        actionCoreCount: 3,
        watchlistCount: 1,
        archiveCount: 0,
        degradedCount: 1,
      },
      opportunitySummary: {
        totalCount: 4,
        queueEligibleCount: 2,
        geoCount: 2,
        winnerScaleCount: 1,
        protectedCount: 1,
        headline: "2 opportunity-board items are queue-ready with evidence floors met.",
      },
      geoSummary: {
        actionCoreCount: 1,
        watchlistCount: 1,
        queuedCount: 1,
        pooledClusterCount: 1,
        sourceFreshness: {
          dataState: "ready",
          lastSyncedAt: "2026-04-10T06:30:00.000Z",
          isPartial: false,
          verificationState: "finalized_verified",
          reason: "Country-only warehouse rows are serving the GEO board.",
        },
        countryEconomics: {
          configured: true,
          updatedAt: "2026-04-09T09:00:00.000Z",
          sourceLabel: "manual",
        },
      },
    },
    campaigns: [
      {
        campaignId: "cmp_1",
        campaignName: "Campaign One",
        status: "ACTIVE",
        role: "Prospecting Scale",
        primaryAction: "scale_budget",
        confidence: 0.84,
        why: "Winning lane",
        evidence: [{ label: "ROAS", value: "3.4x", impact: "positive" }],
        guardrails: ["Scale in steps."],
        noTouch: false,
        whatWouldChangeThisDecision: [],
        adSetDecisionIds: ["decision_1"],
        laneLabel: "Scaling",
        policy: {
          strategyClass: "scale_budget",
          objectiveFamily: "sales",
          bidRegime: "cost_cap",
          primaryDriver: "roas_outperforming",
          secondaryDrivers: ["signal_density"],
          winnerState: "scale_candidate",
          explanation: policyExplanation,
        },
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["Winning lane"],
        },
        operatorPolicy: {
          contractVersion: "operator-policy.v1",
          state: "do_now",
          actionClass: "scale",
          pushReadiness: "eligible_for_push_when_enabled",
          queueEligible: true,
          canApply: true,
          reasons: ["Fixture policy allows this action."],
          blockers: [],
          missingEvidence: [],
          requiredEvidence: ["row_provenance"],
          explanation: "Fixture policy allows this action.",
        },
      },
    ],
    adSets: [
      {
        decisionId: "decision_1",
        adSetId: "adset_1",
        adSetName: "Scale Winner",
        campaignId: "cmp_1",
        campaignName: "Campaign One",
        actionType: "scale_budget",
        actionSize: "medium",
        priority: "high",
        confidence: 0.82,
        reasons: ["Winning ad set"],
        guardrails: ["Scale in steps."],
        relatedCreativeNeeds: [],
        relatedGeoContext: [],
        supportingMetrics: {
          spend: 900,
          revenue: 3600,
          roas: 4,
          cpa: 30,
          ctr: 1.4,
          purchases: 30,
          impressions: 60000,
          clicks: 950,
          bidStrategyLabel: "Cost Cap",
          optimizationGoal: "PURCHASE",
          dailyBudget: 600,
          lifetimeBudget: null,
        },
        whatWouldChangeThisDecision: [],
        noTouch: false,
        policy: {
          strategyClass: "scale_budget",
          objectiveFamily: "sales",
          bidRegime: "cost_cap",
          primaryDriver: "roas_outperforming",
          secondaryDrivers: ["signal_density"],
          winnerState: "scale_candidate",
          explanation: policyExplanation,
        },
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["Winning ad set"],
        },
        operatorPolicy: {
          contractVersion: "operator-policy.v1",
          state: "do_now",
          actionClass: "scale",
          pushReadiness: "eligible_for_push_when_enabled",
          queueEligible: true,
          canApply: true,
          reasons: ["Fixture policy allows this action."],
          blockers: [],
          missingEvidence: [],
          requiredEvidence: ["row_provenance"],
          explanation: "Fixture policy allows this action.",
        },
      },
    ],
    budgetShifts: [
      {
        fromCampaignId: "cmp_2",
        fromCampaignName: "Campaign Two",
        toCampaignId: "cmp_1",
        toCampaignName: "Campaign One",
        from: "Campaign Two",
        to: "Campaign One",
        whyNow: "Move spend now.",
        riskLevel: "low",
        expectedBenefit: "Higher ROAS",
        suggestedMoveBand: "10-15% of current budget load",
        confidence: 0.78,
        guardrails: [],
        provenance: budgetShiftProvenance,
        evidenceHash: budgetShiftProvenance.evidenceHash,
        actionFingerprint: budgetShiftProvenance.actionFingerprint,
      },
    ],
    geoDecisions: [
      {
        geoKey: "US:scale",
        countryCode: "US",
        label: "US",
        action: "scale",
        queueEligible: true,
        confidence: 0.84,
        why: "Winner geo",
        evidence: [],
        guardrails: [],
        whatWouldChangeThisDecision: [],
        clusterKey: null,
        clusterLabel: null,
        grouped: false,
        groupMemberCount: 1,
        groupMemberLabels: ["US"],
        materiality: {
          thinSignal: false,
          material: true,
          archiveContext: false,
        },
        supportingMetrics: {
          spend: 620,
          revenue: 2108,
          roas: 3.4,
          purchases: 16,
          clicks: 240,
          impressions: 9200,
          spendShare: 0.58,
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
          reasons: ["Winner geo"],
        },
      },
      {
        geoKey: "DE:pool",
        countryCode: "DE",
        label: "Germany",
        action: "pool",
        queueEligible: false,
        confidence: 0.68,
        why: "Thin-signal GEOs should validate in a pooled cluster.",
        evidence: [],
        guardrails: [],
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
          spendShare: 0.21,
        },
        freshness: {
          dataState: "ready",
          lastSyncedAt: "2026-04-10T06:30:00.000Z",
          isPartial: false,
          verificationState: "finalized_verified",
          reason: "Country-only warehouse rows are serving the GEO board.",
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
          reasons: ["Thin-signal GEOs should validate in a pooled cluster."],
        },
      },
    ],
    placementAnomalies: [
      {
        placementKey: "feed",
        label: "Feed",
        action: "exception_review",
        confidence: 0.7,
        note: "Spend is too concentrated.",
        evidence: [],
        whatWouldChangeThisDecision: [],
        provenance: placementProvenance,
        evidenceHash: placementProvenance.evidenceHash,
        actionFingerprint: placementProvenance.actionFingerprint,
      },
    ],
    noTouchList: [
      {
        entityType: "campaign",
        entityId: "cmp_1",
        label: "Campaign One",
        reason: "Protect winner",
        confidence: 0.83,
        guardrails: [],
      },
    ],
    winnerScaleCandidates: [
      {
        candidateId: "cmp_1:adset_1",
        campaignId: "cmp_1",
        campaignName: "Campaign One",
        adSetId: "adset_1",
        adSetName: "Scale Winner",
        confidence: 0.87,
        why: "This ad set is beating target with strong clean signal and still has room for controlled scale.",
        suggestedMoveBand: "10-15% of current budget load",
        evidence: [],
        guardrails: ["Scale in steps."],
        supportingMetrics: {
          spend: 900,
          revenue: 3600,
          roas: 4,
          cpa: 30,
          ctr: 1.4,
          purchases: 30,
          dailyBudget: 600,
          bidStrategyLabel: "Cost Cap",
          optimizationGoal: "PURCHASE",
        },
        policy: {
          strategyClass: "scale_budget",
          objectiveFamily: "sales",
          bidRegime: "cost_cap",
          primaryDriver: "roas_outperforming",
          secondaryDrivers: ["signal_density"],
          winnerState: "scale_candidate",
          explanation: policyExplanation,
        },
      },
    ],
    opportunityBoard: [
      {
        opportunityId: "meta-adset-winner:cmp_1:adset_1",
        kind: "adset_winner_scale",
        title: "Scale Winner",
        summary: "This ad set is beating target with strong clean signal and still has room for controlled scale.",
        recommendedAction: "scale_budget",
        confidence: 0.87,
        queue: {
          eligible: true,
          blockedReasons: [],
          watchReasons: [],
        },
        evidenceFloors: [
          {
            key: "signal_depth",
            label: "Signal depth",
            status: "met",
            current: "$900 / 30 purchases",
            required: "$250 spend and 6 purchases",
            reason: null,
          },
        ],
        tags: ["scale_promotions"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["Winning ad set"],
        },
        source: {
          entityType: "adset",
          entityId: "adset_1",
          groupKey: "cmp_1",
        },
        relatedEntities: [
          { type: "campaign", id: "cmp_1", label: "Campaign One" },
          { type: "adset", id: "adset_1", label: "Scale Winner" },
        ],
      },
      {
        opportunityId: "meta-geo:US:scale",
        kind: "geo",
        title: "US",
        summary: "Winner geo",
        recommendedAction: "scale",
        confidence: 0.84,
        queue: {
          eligible: true,
          blockedReasons: [],
          watchReasons: [],
        },
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
          reasons: ["Winner geo"],
        },
        source: {
          entityType: "geo",
          entityId: "US:scale",
          groupKey: null,
        },
        relatedEntities: [{ type: "geo", id: "US:scale", label: "US" }],
      },
      {
        opportunityId: "meta-geo:DE:pool",
        kind: "geo",
        title: "Germany",
        summary: "Thin-signal GEOs should validate in a pooled cluster.",
        recommendedAction: "pool",
        confidence: 0.68,
        queue: {
          eligible: false,
          blockedReasons: [],
          watchReasons: ["Thin-signal GEOs should validate in a pooled cluster."],
        },
        evidenceFloors: [
          {
            key: "signal_depth",
            label: "Signal depth",
            status: "watch",
            current: "$180 / 3 purchases",
            required: "$250 spend and 6 purchases",
            reason: "Thin-signal GEOs stay on the opportunity board until deeper conversion proof exists.",
          },
        ],
        tags: ["geo_issues"],
        trust: {
          surfaceLane: "opportunity_board",
          truthState: "live_confident",
          operatorDisposition: "monitor_low_truth",
          reasons: ["Thin-signal GEOs should validate in a pooled cluster."],
        },
        source: {
          entityType: "geo",
          entityId: "DE:pool",
          groupKey: "pool:tier_3:full:live_confident",
        },
        relatedEntities: [{ type: "geo", id: "DE:pool", label: "Germany" }],
      },
      {
        opportunityId: "meta-protected:campaign:cmp_1",
        kind: "protected_winner",
        title: "Campaign One",
        summary: "Protect winner",
        recommendedAction: "hold_no_touch",
        confidence: 0.83,
        queue: {
          eligible: false,
          blockedReasons: ["Protected winners stay visible as guardrail context, not as queue work."],
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
          reasons: ["Protect winner"],
        },
        source: {
          entityType: "campaign",
          entityId: "cmp_1",
          groupKey: null,
        },
        relatedEntities: [{ type: "campaign", id: "cmp_1", label: "Campaign One" }],
      },
    ],
    commercialTruthCoverage: {
      mode: "configured_targets",
      targetPackConfigured: true,
      countryEconomicsConfigured: true,
      promoCalendarConfigured: false,
      operatingConstraintsConfigured: true,
      missingInputs: [],
      summary: commercialSummary,
      notes: [],
    },
    authority: {
      scope: "Meta Decision OS",
      truthState: "degraded_missing_truth",
      completeness: "missing",
      freshness: {
        status: "stale",
        updatedAt: null,
        reason: "Country breakdown warehouse data is still being prepared for the requested range.",
      },
      missingInputs: ["target_pack", "country_economics"],
      reasons: ["Commercial truth is incomplete."],
      actionCoreCount: 3,
      watchlistCount: 1,
      archiveCount: 0,
      suppressedCount: 1,
      note: "Meta Decision OS remains available but trust-capped by missing commercial truth.",
    },
  } as any;
}

describe("MetaDecisionOsOverview", () => {
  it("renders an explicit loading state", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={null} isLoading />,
    );

    expect(html).toContain("Loading Decision OS surface");
    expect(html).toContain("meta-decision-os-loading");
  });

  it("renders an explicit no-data state", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={null} isLoading={false} />,
    );

    expect(html).toContain("No Decision OS surface loaded.");
    expect(html).toContain("Run analysis to generate account-level authority");
  });

  it("renders ready authority with command-ready action core", () => {
    const data = payload();
    data.authority = {
      ...data.authority,
      truthState: "live_confident",
      completeness: "complete",
      freshness: {
        status: "fresh",
        updatedAt: "2026-04-10T06:30:00.000Z",
        reason: null,
      },
      missingInputs: [],
      reasons: [],
      note: "Meta Decision OS has complete authority for this range.",
      readReliability: {
        status: "stable",
        detail: "Warehouse reads are stable.",
        determinism: "stable",
      },
      readiness: {
        daysReady: 5,
        daysExpected: 5,
        missingInputs: [],
        suppressedActionClasses: [],
        previewCoverage: {
          readyCount: 2,
          degradedCount: 0,
          missingCount: 0,
        },
      },
    };

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("Authority &amp; readiness");
    expect(html).toContain("Operator Plan Summary");
    expect(html).toContain("Highlighted Action Core");
    expect(html).toContain("Increase budget");
    expect(html).toContain("Winning lane");
    expect(html).toContain("Action core");
    expect(html).toContain("Do now");
    expect(html).toContain("eligible for push when enabled");
    expect(html).not.toContain("No command-ready Decision OS action core item is available.");
  });

  it("does not treat missing authority as command-ready", () => {
    const data = payload();
    data.authority = undefined;

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("Highlighted Action Core");
    expect(html).toContain("No command-ready Decision OS action core item is available.");
    expect(html).toContain("Watchlist / Degraded Reads");
    expect(html).toContain("context");
    expect(html).not.toContain("Increase budget");
  });

  it("does not treat missing row trust as command-ready", () => {
    const data = payload();
    data.authority = {
      ...data.authority,
      truthState: "live_confident",
      completeness: "complete",
      freshness: {
        status: "fresh",
        updatedAt: "2026-04-10T06:30:00.000Z",
        reason: null,
      },
      missingInputs: [],
      reasons: [],
      note: "Meta Decision OS has complete authority for this range.",
      readReliability: {
        status: "stable",
        detail: "Warehouse reads are stable.",
        determinism: "stable",
      },
    };
    data.campaigns = [];
    data.geoDecisions = [];
    (data.adSets[0] as any).trust = undefined;

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("No command-ready Decision OS action core item is available.");
    expect(html).toContain("trust unavailable");
    expect(html).toContain("Decision OS trust metadata is not available for this row.");
    expect(html).not.toContain("Increase budget");
  });

  it("does not treat inactive or immaterial trust as command-ready", () => {
    const data = payload();
    data.authority = {
      ...data.authority,
      truthState: "live_confident",
      completeness: "complete",
      freshness: {
        status: "fresh",
        updatedAt: "2026-04-10T06:30:00.000Z",
        reason: null,
      },
      missingInputs: [],
      reasons: [],
      note: "Meta Decision OS has complete authority for this range.",
      readReliability: {
        status: "stable",
        detail: "Warehouse reads are stable.",
        determinism: "stable",
      },
    };
    data.campaigns = [];
    data.geoDecisions = [];
    data.adSets = [
      {
        ...data.adSets[0],
        trust: {
          ...data.adSets[0].trust,
          truthState: "inactive_or_immaterial",
        },
      },
    ];

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("No command-ready Decision OS action core item is available.");
    expect(html).toContain("inactive or immaterial");
    expect(html).toContain("context");
    expect(html).not.toContain("Increase budget");
  });

  it("keeps degraded or missing-truth action core out of primary command display", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={payload()} isLoading={false} />,
    );

    expect(html).toContain("degraded missing truth");
    expect(html).toContain("Missing truth: target_pack, country_economics");
    expect(html).toContain("No command-ready Decision OS action core item is available.");
    expect(html).toContain("Watchlist / Degraded Reads");
    expect(html).toContain("context");
    expect(html).toContain("trust-capped by missing commercial truth");
  });

  it("renders watchlist rows when no action core is command-ready", () => {
    const data = payload();
    data.campaigns = [];
    data.adSets = [];
    data.geoDecisions = [
      {
        ...data.geoDecisions[1],
        trust: {
          ...data.geoDecisions[1].trust,
          surfaceLane: "watchlist",
          operatorDisposition: "monitor_low_truth",
        },
      },
    ];
    data.summary.surfaceSummary = {
      ...data.summary.surfaceSummary,
      actionCoreCount: 0,
      watchlistCount: 1,
    };

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("Highlighted Action Core");
    expect(html).toContain("No command-ready Decision OS action core item is available.");
    expect(html).toContain("Watchlist / Degraded Reads");
    expect(html).toContain("Thin-signal GEOs should validate in a pooled cluster.");
  });

  it("renders protected no-touch items with their reason", () => {
    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={payload()} isLoading={false} />,
    );

    expect(html).toContain("Protected / No-Touch");
    expect(html).toContain("Campaign One");
    expect(html).toContain("Protect winner");
    expect(html).toContain("no-touch");
  });

  it("renders opportunity board empty state", () => {
    const data = payload();
    data.opportunityBoard = [];
    data.summary.opportunitySummary = {
      totalCount: 0,
      queueEligibleCount: 0,
      geoCount: 0,
      winnerScaleCount: 0,
      protectedCount: 0,
      headline: "Opportunity board is empty.",
    };

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("Opportunity Board");
    expect(html).toContain("Queue eligible 0");
    expect(html).toContain("Opportunity board is empty.");
  });

  it("uses only queue metadata when opportunity eligibilityTrace is missing", () => {
    const data = payload();
    data.opportunityBoard = [
      {
        ...data.opportunityBoard[0],
        queue: {
          eligible: false,
          blockedReasons: ["Queue blocker from response"],
          watchReasons: ["Queue watch from response"],
        },
        eligibilityTrace: undefined,
      } as any,
    ];
    data.summary.opportunitySummary = {
      totalCount: 1,
      queueEligibleCount: 0,
      geoCount: 0,
      winnerScaleCount: 1,
      protectedCount: 0,
      headline: "One opportunity-board item is blocked by queue metadata.",
    };

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("Main blockers: Queue blocker from response · Queue watch from response");
    expect(html).toContain("Queue blocker from response");
    expect(html).not.toContain("Protected winners stay visible as guardrail context");
  });

  it("keeps policy details collapsible while showing the main reason outside details", () => {
    const data = payload();
    data.authority = {
      ...data.authority,
      truthState: "live_confident",
      completeness: "complete",
      freshness: {
        status: "fresh",
        updatedAt: "2026-04-10T06:30:00.000Z",
        reason: null,
      },
      missingInputs: [],
      reasons: [],
      note: "Meta Decision OS has complete authority for this range.",
      readReliability: {
        status: "stable",
        detail: "Warehouse reads are stable.",
        determinism: "stable",
      },
    };

    const html = renderToStaticMarkup(
      <MetaDecisionOsOverview decisionOs={data} isLoading={false} />,
    );

    expect(html).toContain("Winning ad set");
    expect(html).toContain("Policy and evidence details");
    expect(html).toContain("Shared policy ladder kept scale budget active");
    expect(html).not.toContain("Show why");
  });

  it("renders the selected campaign decision panel", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignDecisionPanel
        campaignDecision={payload().campaigns[0]}
        adSetDecisions={payload().adSets}
      />,
    );

    expect(html).toContain("Campaign Role");
    expect(html).toContain("Prospecting Scale");
    expect(html).toContain("Scale Winner");
    expect(html).toContain("strategy scale budget");
    expect(html).toContain("Campaign Policy Review");
  });
});
