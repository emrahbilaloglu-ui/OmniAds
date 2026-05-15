import { describe, expect, it } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import {
  emitHighPriorityAdsetScenario,
  emitHighPriorityCampaignScenario,
  maybeA1MathFloor,
  maybeA2StructuralRebuild,
  maybeA3LearningOnPaceWait,
  maybeA5PostLearningUnderperformer,
  maybeB1CappedBidRaise,
  maybeC1ControlledScale,
  maybeC2RecentEditCooldown,
  maybeC3ScaleSampleGate,
  maybeE1FatigueAdset,
  maybeE2CtrDecay,
  maybeE4CreativeAge,
  maybeF1SuddenRoasDrop,
  maybeF3BudgetPacingCooldown,
  maybeF4StableWinnerFade,
  maybeH1TrackingQualityDiagnostic,
  maybeI4TestShouldUseAbo,
  maybeJ1StableWinnerProtected,
  maybeK1MixedConfig,
  scenarioScopeAllowsCohort,
} from "@/lib/meta/scenario-emitters/high-priority";

const context: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 3,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      roas_28d: { p10: 0.5, p25: 1, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
      cpa_28d: { p10: 20, p25: 30, p50: 50, p75: 80, p90: 120, sampleSize: 20 },
      freq_14d: { p10: 1, p25: 1.3, p50: 1.8, p75: 2.5, p90: 3.5, sampleSize: 20 },
      cpm_14d: { p10: 5, p25: 8, p50: 12, p75: 18, p90: 25, sampleSize: 20 },
      ctr_28d: { p10: 0.5, p25: 1, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
      win_rate_28d: { p10: 0.1, p25: 0.2, p50: 0.4, p75: 0.6, p90: 0.8, sampleSize: 20 },
    },
  },
  scope: { type: "account", id: "biz_1", snapshotDate: "2026-05-08" },
  reason: undefined,
};

const purchaseCohort = "purchase" as const;
const commercialTargets = {
  source: "configured_targets" as const,
  targetRoas: 2.2,
  breakEvenRoas: 1.4,
  targetCpa: 100,
  breakEvenCpa: 140,
  riskPosture: "balanced" as const,
};

function campaign(overrides: Partial<MetaCampaignRow> = {}): MetaCampaignRow {
  return {
    id: "cmp_1",
    accountId: "act_1",
    name: "Campaign 1",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    budgetLevel: "campaign",
    spend: 2800,
    purchases: 20,
    revenue: 8400,
    roas: 3,
    cpa: 60,
    ctr: 2,
    cpm: 10,
    cpc: 1,
    cpp: 0.01,
    impressions: 10000,
    reach: 9000,
    frequency: 1.4,
    clicks: 200,
    uniqueClicks: 0,
    uniqueCtr: 0,
    inlineLinkClickCtr: 0,
    outboundClicks: 0,
    outboundCtr: 0,
    uniqueOutboundClicks: 0,
    uniqueOutboundCtr: 0,
    landingPageViews: 0,
    costPerLandingPageView: 0,
    addToCart: 0,
    addToCartValue: 0,
    costPerAddToCart: 0,
    initiateCheckout: 0,
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
    customEventType: null,
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    previousBidValue: null,
    previousBidValueFormat: null,
    previousBidValueCapturedAt: null,
    dailyBudget: 100,
    lifetimeBudget: null,
    previousDailyBudget: null,
    previousLifetimeBudget: null,
    previousBudgetCapturedAt: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isCustomEventTypeMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    ...overrides,
  };
}

function windowFor(selected: MetaCampaignRow, overrides: Partial<{ last7: MetaCampaignRow; last14: MetaCampaignRow; last30: MetaCampaignRow; last90: MetaCampaignRow }> = {}) {
  return {
    selected,
    last7: overrides.last7 ?? campaign({ id: selected.id, spend: selected.spend / 4, roas: selected.roas, ctr: selected.ctr }),
    last14: overrides.last14 ?? campaign({ id: selected.id, spend: selected.spend / 2, roas: selected.roas, ctr: selected.ctr }),
    last30: overrides.last30 ?? selected,
    last90: overrides.last90 ?? campaign({ id: selected.id, spend: selected.spend * 2, roas: selected.roas, ctr: selected.ctr }),
  };
}

function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
  return {
    id: "adset_1",
    accountId: "act_1",
    campaignId: "cmp_1",
    name: "Adset 1",
    status: "ACTIVE",
    spend: 400,
    purchases: 8,
    revenue: 800,
    roas: 2,
    cpa: 50,
    ctr: 1,
    cpm: 15,
    cpc: 1,
    impressions: 10000,
    clicks: 100,
    frequency: 3,
    currency: "USD",
    dailyBudget: 50,
    lifetimeBudget: null,
    optimizationGoal: "Purchase",
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    ...overrides,
  } as MetaAdSetData;
}

function signal(overrides: Partial<MetaEntityDecisionSignal> = {}): MetaEntityDecisionSignal {
  return {
    businessId: "biz_1",
    providerAccountId: "act_1",
    scopeType: "campaign",
    scopeId: "cmp_1",
    asOfDate: "2026-05-08",
    learningState: "LEARNING_LIMITED",
    daysAtLearningState: null,
    lastSignificantEditAt: null,
    daysSinceSignificantEdit: null,
    recentChangeCooldownUntil: null,
    creativeAgeDays: 28,
    creativeAgeDaysMax: 28,
    frequencyP80: 3,
    ctrDecayPct: -20,
    sourceJson: {},
    qualityStatus: "ready",
    ...overrides,
  };
}

describe("high priority Meta scenario emitters", () => {
  it.each([
    ["C1", () => maybeC1ControlledScale({ window: windowFor(campaign({ roas: 3.4, purchases: 20 })), context, cohort: purchaseCohort, commercialTargets })],
    ["B1", () => maybeB1CappedBidRaise({ window: windowFor(campaign({ bidStrategyType: "cost_cap", bidValue: 5000, roas: 2.4, dailyBudget: 500, spend: 1000 })), context, cohort: purchaseCohort, commercialTargets })],
    ["J1", () => maybeJ1StableWinnerProtected({ window: windowFor(campaign({ roas: 3.4, purchases: 20 })), context, cohort: purchaseCohort })],
    ["A2", () => maybeA2StructuralRebuild({ window: windowFor(campaign({ roas: 0.7, spend: 500, purchases: 2 })), context, cohort: purchaseCohort, signals: signal(), commercialTargets })],
    ["F1", () => maybeF1SuddenRoasDrop({ window: windowFor(campaign({ roas: 2.4 }), { last7: campaign({ roas: 1, spend: 500 }) }), context, cohort: purchaseCohort })],
    ["F4", () => maybeF4StableWinnerFade({ window: windowFor(campaign({ roas: 2, ctr: 1 }), { last30: campaign({ roas: 2 }), last90: campaign({ roas: 3, ctr: 2 }) }), context, cohort: purchaseCohort })],
    ["E2", () => maybeE2CtrDecay({ window: windowFor(campaign({ ctr: 1 }), { last7: campaign({ ctr: 1, spend: 800 }), last14: campaign({ ctr: 1.4 }) }), context, cohort: purchaseCohort, signals: signal({ ctrDecayPct: -22 }) })],
    ["E4", () => maybeE4CreativeAge({ window: windowFor(campaign({ ctr: 1 }), { last7: campaign({ ctr: 1, spend: 800 }), last14: campaign({ ctr: 1.4 }) }), context, cohort: purchaseCohort, signals: signal({ ctrDecayPct: -22, creativeAgeDaysMax: 30 }) })],
    ["K1", () => maybeK1MixedConfig({ window: windowFor(campaign({ isBudgetMixed: true })), context, cohort: purchaseCohort })],
    ["I4", () => maybeI4TestShouldUseAbo({ window: windowFor(campaign({ name: "Creative Test Campaign", budgetLevel: "campaign" })), context, cohort: purchaseCohort, campaignRole: "prospecting_test" })],
    ["A1", () => maybeA1MathFloor({ window: windowFor(campaign({ dailyBudget: 100, roas: 1.5 })), context, cohort: purchaseCohort, signals: signal({ learningState: "LEARNING" }) })],
    ["A3", () => maybeA3LearningOnPaceWait({ window: windowFor(campaign({ roas: 1.4, purchases: 4, cpa: 70 })), context, cohort: purchaseCohort, signals: signal({ learningState: "LEARNING", sourceJson: { purchases_7d: 4 } }) })],
    ["A5", () => maybeA5PostLearningUnderperformer({ window: windowFor(campaign({ roas: 0.9, spend: 800, purchases: 4 })), context, cohort: purchaseCohort, signals: signal({ learningState: "OPTIMAL_LEARNING_DONE" }), commercialTargets })],
    ["C2", () => maybeC2RecentEditCooldown({ window: windowFor(campaign()), context, cohort: purchaseCohort, signals: signal({ daysSinceSignificantEdit: 2, lastSignificantEditAt: "2026-05-06T00:00:00.000Z" }) })],
    ["C3", () => maybeC3ScaleSampleGate({ window: windowFor(campaign({ roas: 3.4, purchases: 4 })), context, cohort: purchaseCohort, signals: signal({ learningState: "OPTIMAL_LEARNING_DONE" }), commercialTargets })],
    ["H1", () => maybeH1TrackingQualityDiagnostic({ window: windowFor(campaign()), context, cohort: purchaseCohort, signals: signal({ trackingQualityStatus: "lpv_drop_suspected", sourceJson: { tracking_quality: { link_clicks: 500, landing_page_views: 100, landing_page_view_rate: 0.2 } } }) })],
    ["F3", () => maybeF3BudgetPacingCooldown({ window: windowFor(campaign()), context, cohort: purchaseCohort, signals: signal({ sourceJson: { monthly_pacing: { status: "overpaced", pace_ratio: 1.5, mtd_spend: 3000, expected_mtd_spend: 2000 } } }) })],
  ])("fires %s on a positive account-history fixture", (_id, build) => {
    const rec = build();
    expect(rec).toBeTruthy();
    expect(rec?.kind).toBe("recommendation");
    expect(rec?.cohort).toBe(purchaseCohort);
    expect(rec?.targetValue === undefined || JSON.parse(JSON.stringify(rec.targetValue))).toBeTruthy();
  });

  it("fires E1 fatigue on an adset account-history fixture", () => {
    const rec = maybeE1FatigueAdset({
      adset: adset(),
      campaign: campaign(),
      context,
      cohort: purchaseCohort,
      signals: signal({ scopeType: "adset", scopeId: "adset_1", frequencyP80: 3 }),
    });
    expect(rec?.type).toBe("scenario_e1_frequency_fatigue");
    expect(rec?.cohort).toBe(purchaseCohort);
    expect(rec?.targetValue === undefined || JSON.parse(JSON.stringify(rec.targetValue))).toBeTruthy();
  });

  it("does not fire signal-aware refresh when CTR decay signal is missing", () => {
    const rec = maybeE2CtrDecay({
      window: windowFor(campaign({ ctr: 1 }), {
        last7: campaign({ ctr: 1, spend: 800 }),
        last14: campaign({ ctr: 1.4 }),
      }),
      context,
      cohort: purchaseCohort,
      signals: signal({ ctrDecayPct: null }),
    });
    expect(rec).toBeNull();
  });

  it("suppresses scale during recent significant edit cooldown", () => {
    const rec = maybeC1ControlledScale({
      window: windowFor(campaign({ roas: 3.4, purchases: 20 })),
      context,
      cohort: purchaseCohort,
      commercialTargets,
      signals: signal({ daysSinceSignificantEdit: 2, lastSignificantEditAt: "2026-05-06T00:00:00.000Z" }),
    });
    expect(rec).toBeNull();
  });

  it("prioritizes recent edit cooldown over campaign hard actions", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 0.7, spend: 800, purchases: 2 })),
      context,
      cohort: purchaseCohort,
      commercialTargets,
      signals: signal({ daysSinceSignificantEdit: 2, lastSignificantEditAt: "2026-05-06T00:00:00.000Z" }),
    });

    expect(rec?.type).toBe("scenario_c2_recent_edit_cooldown");
    expect(rec?.decisionState).toBe("watch");
  });

  it("prioritizes click-to-LPV tracking diagnosis over structural cut logic", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 0.7, spend: 800, purchases: 2 })),
      context,
      cohort: purchaseCohort,
      commercialTargets,
      signals: signal({
        learningState: "LEARNING_LIMITED",
        trackingQualityStatus: "lpv_drop_suspected",
        sourceJson: {
          tracking_quality: {
            link_clicks: 500,
            landing_page_views: 100,
            landing_page_view_rate: 0.2,
          },
        },
      }),
    });

    expect(rec?.type).toBe("scenario_h1_dedup_tracking");
    expect(rec?.decisionLabel).toBe("diagnose");
    expect(rec?.decisionState).toBe("test");
  });

  it("does not emit controlled scale without a commercial target anchor", () => {
    const rec = maybeC1ControlledScale({
      window: windowFor(campaign({ roas: 3.4, purchases: 20 })),
      context,
      cohort: purchaseCohort,
    });
    expect(rec).toBeNull();
  });

  it("does not fire math floor when learning state signal is missing", () => {
    const rec = maybeA1MathFloor({
      window: windowFor(campaign({ dailyBudget: 100, roas: 1.5 })),
      context,
      cohort: purchaseCohort,
      signals: signal({ learningState: null }),
    });
    expect(rec).toBeNull();
  });

  it("keeps on-pace learning campaigns out of hard action paths", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 1.4, purchases: 4, cpa: 70 })),
      context,
      cohort: purchaseCohort,
      signals: signal({ learningState: "LEARNING", sourceJson: { purchases_7d: 4 } }),
      commercialTargets,
    });

    expect(rec?.type).toBe("scenario_a3_learning_on_pace_wait");
    expect(rec?.decisionState).toBe("watch");
    expect(rec?.decisionLabel).toBe("keep");
  });

  it("emits post-learning underperformer only after target-backed loss maturity", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 0.9, spend: 800, purchases: 4 })),
      context,
      cohort: purchaseCohort,
      signals: signal({ learningState: "OPTIMAL_LEARNING_DONE" }),
      commercialTargets,
    });

    expect(rec?.type).toBe("scenario_a2_learning_weak_structural");

    const direct = maybeA5PostLearningUnderperformer({
      window: windowFor(campaign({ roas: 0.9, spend: 800, purchases: 4 })),
      context,
      cohort: purchaseCohort,
      signals: signal({ learningState: "OPTIMAL_LEARNING_DONE" }),
      commercialTargets,
    });
    expect(direct?.decisionLabel).toBe("cut");
  });

  it("uses scale sample gate before budget or scale actions", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 3.4, purchases: 4 })),
      context,
      cohort: purchaseCohort,
      signals: signal({ learningState: "OPTIMAL_LEARNING_DONE", ctrDecayPct: null }),
      commercialTargets,
    });

    expect(rec?.type).toBe("scenario_c3_scale_sample_gate");
    expect(rec?.decisionLabel).toBe("test_more");
    expect(rec?.decisionState).toBe("watch");
  });

  it("does not fire controlled scale below account p75", () => {
    const rec = maybeC1ControlledScale({
      window: windowFor(campaign({ roas: 2.5, purchases: 20 })),
      context,
      cohort: purchaseCohort,
      commercialTargets,
    });
    expect(rec).toBeNull();
  });

  it("does not fire scale when calibration sample is too thin", () => {
    const thinContext: MetaCalibrationContext = {
      ...context,
      thresholds: {
        ...context.thresholds,
        metrics: {
          ...context.thresholds.metrics,
          roas_28d: { ...context.thresholds.metrics.roas_28d, sampleSize: 1 },
        },
      },
    };
    const rec = maybeC1ControlledScale({
      window: windowFor(campaign({ roas: 3.4, purchases: 20 })),
      context: thinContext,
      cohort: purchaseCohort,
      commercialTargets,
    });
    expect(rec).toBeNull();
  });

  it("gates campaign controlled scale outside purchase cohort", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 3.4, purchases: 20 })),
      context,
      cohort: "upper_funnel",
      commercialTargets,
    });
    expect(rec).toBeNull();
  });

  it("honors mid_funnel_only scenario scope", () => {
    expect(scenarioScopeAllowsCohort("mid_funnel_only", "mid_funnel")).toBe(true);
    expect(scenarioScopeAllowsCohort("mid_funnel_only", "purchase")).toBe(false);
    expect(scenarioScopeAllowsCohort("mid_funnel_only", "upper_funnel")).toBe(false);
  });

  it("honors lead_only scenario scope", () => {
    expect(scenarioScopeAllowsCohort("lead_only", "lead")).toBe(true);
    expect(scenarioScopeAllowsCohort("lead_only", "purchase")).toBe(false);
    expect(scenarioScopeAllowsCohort("lead_only", "mid_funnel")).toBe(false);
  });

  it("honors traffic_only scenario scope", () => {
    expect(scenarioScopeAllowsCohort("traffic_only", "traffic")).toBe(true);
    expect(scenarioScopeAllowsCohort("traffic_only", "purchase")).toBe(false);
    expect(scenarioScopeAllowsCohort("traffic_only", "lead")).toBe(false);
  });

  it("honors engagement_only scenario scope", () => {
    expect(scenarioScopeAllowsCohort("engagement_only", "engagement")).toBe(true);
    expect(scenarioScopeAllowsCohort("engagement_only", "purchase")).toBe(false);
    expect(scenarioScopeAllowsCohort("engagement_only", "traffic")).toBe(false);
  });

  it("keeps purchase_only scenario scope unchanged", () => {
    expect(scenarioScopeAllowsCohort("purchase_only", "purchase")).toBe(true);
    expect(scenarioScopeAllowsCohort("purchase_only", "mid_funnel")).toBe(false);
  });

  it("gates campaign sudden ROAS drop outside purchase cohort", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 2.4 }), {
        last7: campaign({ roas: 1, spend: 500 }),
      }),
      context,
      cohort: "mid_funnel",
    });
    expect(rec).toBeNull();
  });

  it("allows campaign CTR decay refresh outside purchase cohort", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ ctr: 1 }), {
        last7: campaign({ ctr: 1, spend: 800 }),
        last14: campaign({ ctr: 1.4 }),
      }),
      context,
      cohort: "upper_funnel",
      signals: signal({ ctrDecayPct: -22 }),
    });
    expect(rec?.type).toBe("scenario_e2_ctr_decay_refresh");
    expect(rec?.cohort).toBe("upper_funnel");
  });

  it("allows campaign controlled scale in purchase cohort", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 3.4, purchases: 20 })),
      context,
      cohort: purchaseCohort,
      commercialTargets,
    });
    expect(rec?.type).toBe("scenario_c1_controlled_scale");
  });

  it("allows adset fatigue in mid-funnel cohort", () => {
    const rec = emitHighPriorityAdsetScenario({
      adset: adset(),
      campaign: campaign(),
      context,
      cohort: "mid_funnel",
      signals: signal({ scopeType: "adset", scopeId: "adset_1", frequencyP80: 3 }),
    });
    expect(rec?.type).toBe("scenario_e1_frequency_fatigue");
    expect(rec?.cohort).toBe("mid_funnel");
  });

  it("allows adset fatigue in upper-funnel cohort", () => {
    const rec = emitHighPriorityAdsetScenario({
      adset: adset(),
      campaign: campaign(),
      context,
      cohort: "upper_funnel",
      signals: signal({ scopeType: "adset", scopeId: "adset_1", frequencyP80: 3 }),
    });
    expect(rec?.type).toBe("scenario_e1_frequency_fatigue");
    expect(rec?.cohort).toBe("upper_funnel");
  });

  it("applies precedence with rebuild before controlled scale", () => {
    const rec = emitHighPriorityCampaignScenario({
      window: windowFor(campaign({ roas: 3.4, purchases: 20, isBudgetMixed: true })),
      context,
      cohort: purchaseCohort,
    });
    expect(rec?.type).toBe("scenario_k1_mixed_config_rebuild");
  });
});
