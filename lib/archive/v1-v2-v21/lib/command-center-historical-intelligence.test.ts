import { describe, expect, it } from "vitest";
import type {
  CommandCenterAction,
  CommandCenterFeedbackEntry,
  CommandCenterFeedbackSummary,
  CommandCenterQueueBudgetSummary,
} from "@/lib/command-center";
import { buildCommandCenterHistoricalIntelligence } from "@/lib/command-center-historical-intelligence";

function buildAction(
  overrides: Partial<CommandCenterAction> = {},
): CommandCenterAction {
  return {
    actionFingerprint: overrides.actionFingerprint ?? "action_1",
    sourceSystem: overrides.sourceSystem ?? "meta",
    sourceType: overrides.sourceType ?? "meta_adset_decision",
    surfaceLane: overrides.surfaceLane ?? "action_core",
    queueSection: overrides.queueSection ?? "default_queue",
    workloadClass: overrides.workloadClass ?? "scale_promotion",
    truthState: overrides.truthState ?? "live_confident",
    operatorDisposition: overrides.operatorDisposition ?? "standard",
    trustReasons: overrides.trustReasons ?? ["Strong live signal."],
    title: overrides.title ?? "Scale ad set",
    recommendedAction: overrides.recommendedAction ?? "scale_budget",
    confidence: overrides.confidence ?? 0.82,
    priority: overrides.priority ?? "high",
    summary: overrides.summary ?? "Scale this ad set.",
    decisionSignals: overrides.decisionSignals ?? [],
    evidence: overrides.evidence ?? [],
    guardrails: overrides.guardrails ?? [],
    relatedEntities: overrides.relatedEntities ?? [],
    tags: overrides.tags ?? [],
    watchlistOnly: overrides.watchlistOnly ?? false,
    batchReviewClass: overrides.batchReviewClass ?? null,
    batchReviewEligible: overrides.batchReviewEligible ?? false,
    calibrationHint: overrides.calibrationHint ?? null,
    status: overrides.status ?? "pending",
    assigneeUserId: overrides.assigneeUserId ?? null,
    assigneeName: overrides.assigneeName ?? null,
    snoozeUntil: overrides.snoozeUntil ?? null,
    latestNoteExcerpt: overrides.latestNoteExcerpt ?? null,
    noteCount: overrides.noteCount ?? 0,
    lastMutatedAt: overrides.lastMutatedAt ?? null,
    lastMutationId: overrides.lastMutationId ?? null,
    createdAt: overrides.createdAt ?? "2026-04-10T00:00:00.000Z",
    sourceContext: overrides.sourceContext ?? {
      sourceLabel: "Meta Decision OS",
      operatingMode: "Exploit",
      sourceDeepLink: "/platforms/meta",
      sourceDecisionId: "decision_1",
    },
    throughput: overrides.throughput ?? {
      priorityScore: 90,
      actionable: true,
      defaultQueueEligible: true,
      selectedInDefaultQueue: true,
      ageHours: 4,
      ageLabel: "4h",
      ageAnchorAt: "2026-04-10T00:00:00.000Z",
      slaTargetHours: 8,
      slaStatus: "on_track",
    },
  };
}

function buildFeedbackSummary(
  overrides: Partial<CommandCenterFeedbackSummary> = {},
): CommandCenterFeedbackSummary {
  return {
    totalCount: overrides.totalCount ?? 4,
    falsePositiveCount: overrides.falsePositiveCount ?? 2,
    badRecommendationCount: overrides.badRecommendationCount ?? 1,
    falseNegativeCount: overrides.falseNegativeCount ?? 2,
    queueGapCount: overrides.queueGapCount ?? 2,
    calibrationCandidateCount: overrides.calibrationCandidateCount ?? 1,
    workflowGapCount: overrides.workflowGapCount ?? 2,
    recentEntries: overrides.recentEntries ?? [],
  };
}

function buildFeedback(
  overrides: Partial<CommandCenterFeedbackEntry> = {},
): CommandCenterFeedbackEntry {
  const scope = overrides.scope ?? "action";
  return {
    id: overrides.id ?? "feedback_1",
    businessId: overrides.businessId ?? "biz",
    clientMutationId: overrides.clientMutationId ?? "mutation_1",
    feedbackType: overrides.feedbackType ?? "false_positive",
    outcome:
      overrides.outcome ??
      (scope === "queue_gap" ? "workflow_gap" : "operator_note"),
    scope,
    actionFingerprint: overrides.actionFingerprint ?? "action_1",
    actionTitle: overrides.actionTitle ?? "Scale ad set",
    sourceSystem: overrides.sourceSystem ?? "meta",
    sourceType: overrides.sourceType ?? "meta_adset_decision",
    workloadClass: overrides.workloadClass ?? (scope === "action" ? "scale_promotion" : null),
    calibrationHint: overrides.calibrationHint ?? null,
    viewKey: overrides.viewKey ?? null,
    actorUserId: overrides.actorUserId ?? "user_1",
    actorName: overrides.actorName ?? "Operator",
    actorEmail: overrides.actorEmail ?? "operator@adsecute.com",
    note: overrides.note ?? "Feedback",
    createdAt: overrides.createdAt ?? "2026-04-10T00:00:00.000Z",
  };
}

const throughput: CommandCenterQueueBudgetSummary = {
  totalBudget: 12,
  quotas: { critical: 4, high: 4, medium: 3, low: 1 },
  selectedActionFingerprints: ["action_1"],
  overflowCount: 2,
  actionableCount: 3,
  selectedCount: 1,
};

describe("buildCommandCenterHistoricalIntelligence", () => {
  it("builds campaign-family summaries, hotspots, degraded guidance, and calibration suggestions", () => {
    const intelligence = buildCommandCenterHistoricalIntelligence({
      startDate: "2026-02-01",
      endDate: "2026-02-10",
      selectedPeriodCampaigns: [
        {
          id: "cmp_1",
          accountId: "act_1",
          name: "Scale Purchases",
          status: "ACTIVE",
          objective: "OUTCOME_SALES",
          budgetLevel: "adset",
          spend: 600,
          purchases: 20,
          revenue: 1_920,
          roas: 3.2,
          cpa: 30,
          ctr: 1.5,
          cpm: 12,
          cpc: 2,
          cpp: 0,
          impressions: 10_000,
          reach: 8_000,
          frequency: 1.2,
          clicks: 320,
          uniqueClicks: 290,
          uniqueCtr: 1.2,
          inlineLinkClickCtr: 1.1,
          outboundClicks: 200,
          outboundCtr: 0.8,
          uniqueOutboundClicks: 180,
          uniqueOutboundCtr: 0.7,
          landingPageViews: 160,
          costPerLandingPageView: 3,
          addToCart: 25,
          addToCartValue: 0,
          costPerAddToCart: 0,
          initiateCheckout: 18,
          initiateCheckoutValue: 0,
          costPerCheckoutInitiated: 0,
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
          bidStrategyType: null,
          bidStrategyLabel: null,
          manualBidAmount: null,
          previousManualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          previousBidValue: null,
          previousBidValueFormat: null,
          previousBidValueCapturedAt: null,
          dailyBudget: null,
          lifetimeBudget: null,
          previousDailyBudget: null,
          previousLifetimeBudget: null,
          previousBudgetCapturedAt: null,
          isBudgetMixed: false,
          isConfigMixed: false,
          isOptimizationGoalMixed: false,
          isBidStrategyMixed: false,
          isBidValueMixed: false,
        },
      ],
      actions: [
        buildAction({
          actionFingerprint: "action_1",
          truthState: "degraded_missing_truth",
          trustReasons: ["Target pack missing", "Country economics missing"],
        }),
        buildAction({
          actionFingerprint: "action_2",
          surfaceLane: "watchlist",
          sourceSystem: "creative",
          sourceType: "creative_primary_decision",
          sourceContext: {
            sourceLabel: "Creative Decision OS",
            operatingMode: "Exploit",
            sourceDeepLink: "/creatives",
            sourceDecisionId: "creative_1",
          },
        }),
        buildAction({
          actionFingerprint: "action_3",
          surfaceLane: "archive_context",
          recommendedAction: "hold",
        }),
      ],
      throughput,
      feedbackSummary: buildFeedbackSummary(),
      feedback: [
        buildFeedback({
          id: "fp_1",
          feedbackType: "false_positive",
          scope: "action",
          sourceType: "meta_adset_decision",
        }),
        buildFeedback({
          id: "fp_2",
          feedbackType: "false_positive",
          scope: "action",
          sourceType: "meta_adset_decision",
        }),
        buildFeedback({
          id: "fn_1",
          feedbackType: "false_negative",
          scope: "queue_gap",
          sourceSystem: "creative",
          sourceType: null,
          actionFingerprint: null,
          actionTitle: null,
          viewKey: "today_priorities",
        }),
        buildFeedback({
          id: "fn_2",
          feedbackType: "false_negative",
          scope: "queue_gap",
          sourceSystem: "creative",
          sourceType: null,
          actionFingerprint: null,
          actionTitle: null,
          viewKey: "today_priorities",
        }),
      ],
      metaDecisionOs: {
        commercialTruthCoverage: {
          mode: "fallback",
          targetPackConfigured: false,
          countryEconomicsConfigured: false,
          promoCalendarConfigured: false,
          operatingConstraintsConfigured: true,
          missingInputs: ["target pack", "country economics"],
          notes: [],
        },
      } as never,
      creativeDecisionOs: {
        commercialTruthCoverage: {
          operatingMode: "Exploit",
          confidence: 0.82,
          missingInputs: ["target pack"],
          activeInputs: [],
          guardrails: [],
          configuredSections: {
            targetPack: false,
            countryEconomics: false,
            promoCalendar: false,
            operatingConstraints: true,
          },
        },
      } as never,
    });

    expect(intelligence.selectedWindow.startDate).toBe("2026-02-01");
    expect(intelligence.campaignFamilies[0]?.familyLabel).toBe("purchase/value");
    expect(intelligence.decisionQuality.falsePositiveHotspots[0]).toMatchObject({
      label: "Meta ad set decisions",
      count: 2,
    });
    expect(intelligence.decisionQuality.falseNegativeHotspots[0]?.label).toContain(
      "Creative",
    );
    expect(intelligence.degradedGuidance.missingInputs).toContain("target pack");
    expect(intelligence.calibrationSuggestions.map((item) => item.key)).toEqual([
      "missing_truth_inputs",
      "high_degraded_share",
      "false_positive_hotspot",
      "queue_gap_hotspot",
    ]);
  });
});
