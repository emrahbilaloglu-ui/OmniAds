import { describe, expect, it } from "vitest";
import { decideCreative, ENGINE_VERSION, MockDataSource } from "..";
import {
  makeAccountDecisionProfile,
  makeAccountFunnelCalibration,
  makeDataHealth,
  makeDataLayerHealth,
} from "./helpers";
import { applyCreativeCampaignLabelGuard } from "../campaign-label-guard";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  AccountFunnelCalibration,
  CalibrationCampaignKind,
  CreativeInput,
  DecisionOutput,
  EngineThresholdSet,
  HardActionEligibility,
  SpendUnitProfile,
} from "../types";

describe("creative-decision-engine v3", () => {
  const mock = new MockDataSource();

  async function getMockCreativeInput(creativeId: string) {
    const input = await mock.getCreativeInput({
      creativeId,
      businessId: "biz-1",
      asOf: "2026-05-04",
    });
    if (input === null) {
      throw new Error("Expected mock creative input.");
    }
    return input;
  }

  async function getMockProfile() {
    const calibration = await mock.getAccountCalibration({
      businessId: "biz-1",
      asOf: "2026-05-04",
    });
    return makeAccountDecisionProfile({
      accountBaselines: calibration,
      spendUnit: 100,
      thresholds: {
        scaleMinPurchases: 10,
        zeroConvBurnerSpend: 200,
      },
    });
  }

  function emptyByKind<T>(): Record<CalibrationCampaignKind, T | null> {
    return {
      all: null,
      main: null,
      test: null,
      mixed: null,
    };
  }

  function kindAwareProfile(input: {
    base: AccountDecisionProfile;
    kind: Exclude<CalibrationCampaignKind, "all">;
    calibration: Partial<AccountCalibration>;
    thresholds?: Partial<EngineThresholdSet>;
    hardActionEligibility?: HardActionEligibility;
  }): AccountDecisionProfile {
    const calibration: AccountCalibration = {
      ...input.base.accountBaselines,
      campaignKind: input.kind,
      matureCreativeCount: 35,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      matureSpendP50: 300,
      winnerPurchaseP50: 4,
      roasRatioP10: 0.4,
      roasRatioP25: 0.7,
      refreshRatioP10: 0.82,
      ...input.calibration,
    };
    const accountBaselinesByKind = emptyByKind<AccountCalibration>();
    const spendUnitByKind = emptyByKind<SpendUnitProfile>();
    const thresholdsByKind = emptyByKind<EngineThresholdSet>();
    const hardActionEligibilityByKind = emptyByKind<HardActionEligibility>();
    const funnelCalibrationByKind = emptyByKind<AccountFunnelCalibration>();

    accountBaselinesByKind.all = input.base.accountBaselines;
    accountBaselinesByKind[input.kind] = calibration;
    const baseSpendUnitProfile: SpendUnitProfile = {
      spendUnit: input.base.spendUnit,
      spendUnitSource: input.base.spendUnitSource,
      spendUnitConfidence: input.base.spendUnitConfidence,
      spendUnitEvidence: input.base.spendUnitEvidence,
      hardEligibleByDefault: true,
    };
    spendUnitByKind.all = baseSpendUnitProfile;
    spendUnitByKind[input.kind] = {
      ...baseSpendUnitProfile,
      spendUnitEvidence: {
        ...input.base.spendUnitEvidence,
        accountCpaP50: calibration.accountCpaP50,
        accountCpaSampleCount: calibration.accountCpaSampleCount,
      },
    };
    thresholdsByKind.all = input.base.thresholds;
    thresholdsByKind[input.kind] = {
      ...input.base.thresholds,
      scaleMinPurchases: 4,
      bottomQuartileRatio: calibration.roasRatioP25,
      severeLoserRatio: calibration.roasRatioP10,
      ...input.thresholds,
    };
    hardActionEligibilityByKind.all = input.base.hardActionEligibility;
    hardActionEligibilityByKind[input.kind] =
      input.hardActionEligibility ?? input.base.hardActionEligibility;
    funnelCalibrationByKind.all = input.base.funnelCalibration;
    funnelCalibrationByKind[input.kind] = makeAccountFunnelCalibration({
      campaignKind: input.kind,
    });

    return {
      ...input.base,
      accountBaselinesByKind,
      spendUnitByKind,
      thresholdsByKind,
      hardActionEligibilityByKind,
      funnelCalibrationByKind,
    };
  }

  function expectMatchesCanonical(
    actual: DecisionOutput,
    canonical: DecisionOutput,
  ) {
    expect(actual.label).toBe(canonical.label);
    expect(actual.reason).toBe(canonical.reason);
    expect(actual.truthSource).toBe(canonical.truthSource);
    expect(actual.effectiveTargetRoas).toBe(canonical.effectiveTargetRoas);
    expect(actual.decisionKindSource).toBe("all_fallback");
  }

  function wouldRefreshInput(
    input: CreativeInput,
    overrides: Partial<CreativeInput> = {},
  ): CreativeInput {
    return {
      ...input,
      spend: 600,
      purchases: 6,
      roas: 1.65,
      recent7dRoas: 1,
      recent7dSpend: 80,
      fatigueStatus: "fatigued",
      linkClicks: 400,
      landingPageViews: 320,
      addToCart: 50,
      initiateCheckout: 25,
      ...overrides,
    };
  }

  it("returns a typed decision for any input", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(input, profile);
    expect(out.creativeId).toBe("c-1");
    expect(out.creativeName).toBe(input.creativeName);
    expect(out.label).toBe("keep");
    expect(out.engineVersion).toBe(ENGINE_VERSION);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(95);
  });

  it("resolves truth source via fallback chain", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(input, profile);
    expect(out.truthSource).toBe("commercial_truth");
    expect(out.effectiveTargetRoas).toBe(2.2);
  });

  it("falls back to account baseline when commercial truth missing", async () => {
    const input = await getMockCreativeInput("c-1");
    const calibration = await mock.getAccountCalibration({
      businessId: "biz-1",
      asOf: "2026-05-04",
    });
    const profile = makeAccountDecisionProfile({
      accountBaselines: calibration,
    });

    const out = decideCreative({ ...input, targetRoas: null }, profile);
    expect(out.truthSource).toBe("account_baseline");
    expect(out.effectiveTargetRoas).toBe(2.4);
  });

  it("uses quality-only funnel scoring when no target or account benchmark exists", async () => {
    const input = await getMockCreativeInput("c-1");
    const calibration = await mock.getAccountCalibration({
      businessId: "biz-1",
      asOf: "2026-05-04",
    });
    const profile = makeAccountDecisionProfile({
      accountBaselines: {
        ...calibration,
        matureCreativeCount: 0,
        roasP75: null,
        roasP60: null,
      },
    });

    const out = decideCreative({ ...input, targetRoas: null }, profile);

    expect(out.label).toBe("keep");
    expect(out.truthSource).toBe("global_default");
    expect(out.effectiveTargetRoas).toBe(0);
    expect(out.ratioToTarget).toBeNull();
    expect(out.reason).toContain("[quality-only above_average]");
    expect(out.badges.map((badge) => badge.type)).toContain(
      "quality_only_assessment",
    );
  });

  it("returns keep for mock creative in scale zone without scale purchase depth", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(input, profile);

    expect(out.label).toBe("keep");
    expect(out.reason).toBe(
      "[near scale] ROAS 3.00 (28d) above target (136%) — spend $500 / purchases 8 below scale floor (need ≥$200, ≥10); observe.",
    );
    expect(out.truthSource).toBe("commercial_truth");
    expect(out.effectiveTargetRoas).toBe(2.2);
    expect(out.ratioToTarget).toBeCloseTo(3.0 / 2.2, 5);
    expect(out.badges).toContainEqual({
      type: "opportunity_window_open",
      label: "Plateau — window still open (peak 5d ago)",
      severity: "info",
    });
    expect(out.confidence).toBe(77);
  });

  it("GC-038 keeps a Main creative below scale when Main purchase depth is stricter than canonical", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const canonicalScaleProfile: AccountDecisionProfile = {
      ...profile,
      thresholds: {
        ...profile.thresholds,
        scaleMinPurchases: 4,
      },
    };
    const profileWithMain = kindAwareProfile({
      base: canonicalScaleProfile,
      kind: "main",
      calibration: {},
      thresholds: {
        scaleMinPurchases: 10,
      },
    });

    const baseline = decideCreative(input, canonicalScaleProfile);
    const kindSegmented = decideCreative(
      { ...input, campaignKind: "main" },
      profileWithMain,
    );

    expect(baseline.label).toBe("scale");
    expect(baseline.reason).toContain("scale the ad set budget");
    expect(kindSegmented.label).toBe("keep");
    expect(kindSegmented.decisionKindSource).toBe("kind_main");
    expect(kindSegmented.reason).toContain("below scale floor");
    expect(kindSegmented.truthSource).toBe(baseline.truthSource);
    expect(kindSegmented.effectiveTargetRoas).toBe(
      baseline.effectiveTargetRoas,
    );
  });

  it("GC-039 scales a Test creative when Test thresholds are looser than canonical", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithTest = kindAwareProfile({
      base: profile,
      kind: "test",
      calibration: {},
      thresholds: {
        scaleMinPurchases: 4,
      },
    });

    const baseline = decideCreative(input, profile);
    const testDecision = decideCreative(
      { ...input, campaignKind: "test" },
      profileWithTest,
    );

    expect(baseline.label).toBe("keep");
    expect(baseline.decisionKindSource).toBe("all_fallback");
    expect(testDecision.label).toBe("scale");
    expect(testDecision.decisionKindSource).toBe("kind_test");
    expect(testDecision.reason).toContain("scale the ad set budget");
  });

  it("GC-040 falls back when the Main kind row has insufficient required fields", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithSparseMain = kindAwareProfile({
      base: profile,
      kind: "main",
      calibration: {
        matureSpendP50: null,
      },
      thresholds: {
        scaleMinPurchases: 4,
      },
    });

    const baseline = decideCreative(input, profile);
    const sparseMain = decideCreative(
      { ...input, campaignKind: "main" },
      profileWithSparseMain,
    );

    expectMatchesCanonical(sparseMain, baseline);
  });

  it("GC-041 falls back when Mixed has no kind calibration row", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithMainOnly = kindAwareProfile({
      base: profile,
      kind: "main",
      calibration: {},
      thresholds: {
        scaleMinPurchases: 4,
      },
    });

    const baseline = decideCreative(input, profile);
    const mixed = decideCreative(
      { ...input, campaignKind: "mixed" },
      profileWithMainOnly,
    );

    expectMatchesCanonical(mixed, baseline);
  });

  it("GC-042 uses canonical baselines for unlabeled creatives and lets the P0 guard block hard actions", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const scaleProfile: AccountDecisionProfile = {
      ...profile,
      thresholds: {
        ...profile.thresholds,
        scaleMinPurchases: 4,
      },
    };
    const inputWithoutKind = { ...input, campaignKind: null };

    const rawDecision = decideCreative(inputWithoutKind, scaleProfile);
    const guarded = applyCreativeCampaignLabelGuard({
      decision: rawDecision,
      input: inputWithoutKind,
      campaignLabelsById: new Map(),
    });

    expect(rawDecision.label).toBe("scale");
    expect(rawDecision.decisionKindSource).toBe("all_fallback");
    expect(guarded.label).toBe("diagnose");
    expect(guarded.campaignLabelStatus).toBe("unlabeled");
    expect(guarded.blockedActionType).toBe("scale");
    expect(guarded.decisionKindSource).toBe("all_fallback");
  });

  it("GC-043 turns a Test campaign refresh signal into cut semantics", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithTest = kindAwareProfile({
      base: profile,
      kind: "test",
      calibration: {},
    });

    const out = decideCreative(
      wouldRefreshInput(input, { campaignKind: "test" }),
      profileWithTest,
    );

    expect(out.label).toBe("cut");
    expect(out.labelTransform).toBe("test_cohort_refresh_to_cut");
    expect(out.decisionKindSource).toBe("kind_test");
    expect(out.reason).toContain("[test_cohort: refresh->cut]");
    expect(out.reason).toContain("fatigued with recent 7d ROAS");
  });

  it("GC-044a keeps the Test transform diagnostic when transformed cut is blocked", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithTest = kindAwareProfile({
      base: profile,
      kind: "test",
      calibration: {},
      hardActionEligibility: {
        scale: true,
        cut: false,
        refresh: true,
        reason: "cut disabled for test cohort",
      },
    });

    const out = decideCreative(
      wouldRefreshInput(input, { campaignKind: "test" }),
      profileWithTest,
    );

    expect(out.label).toBe("test_more");
    expect(out.labelTransform).toBe("test_cohort_refresh_to_cut");
    expect(out.decisionKindSource).toBe("kind_test");
    expect(out.reason).toContain("[soft-only - cut blocked]");
    expect(out.reason).toContain("[test_cohort: refresh->cut]");
  });

  it("GC-044b emits cut when the original refresh would be blocked but cut is allowed", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithTest = kindAwareProfile({
      base: profile,
      kind: "test",
      calibration: {},
      hardActionEligibility: {
        scale: true,
        cut: true,
        refresh: false,
        reason: "refresh disabled for low-confidence baselines",
      },
    });

    const out = decideCreative(
      wouldRefreshInput(input, { campaignKind: "test" }),
      profileWithTest,
    );

    expect(out.label).toBe("cut");
    expect(out.labelTransform).toBe("test_cohort_refresh_to_cut");
    expect(out.decisionKindSource).toBe("kind_test");
    expect(out.reason).not.toContain("[soft-only - refresh blocked]");
  });

  it("GC-045 keeps Main campaign refresh semantics unchanged", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithMain = kindAwareProfile({
      base: profile,
      kind: "main",
      calibration: {},
    });

    const out = decideCreative(
      wouldRefreshInput(input, { campaignKind: "main" }),
      profileWithMain,
    );

    expect(out.label).toBe("refresh");
    expect(out.labelTransform ?? null).toBeNull();
    expect(out.decisionKindSource).toBe("kind_main");
  });

  it("GC-046 keeps Mixed campaign refresh semantics unchanged", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const profileWithMixed = kindAwareProfile({
      base: profile,
      kind: "mixed",
      calibration: {},
    });

    const out = decideCreative(
      wouldRefreshInput(input, { campaignKind: "mixed" }),
      profileWithMixed,
    );

    expect(out.label).toBe("refresh");
    expect(out.labelTransform ?? null).toBeNull();
    expect(out.decisionKindSource).toBe("kind_mixed");
  });

  it("GC-047 keeps unlabeled refresh canonical before the campaign-label guard blocks it", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const inputWithoutKind = wouldRefreshInput(input, { campaignKind: null });

    const rawDecision = decideCreative(inputWithoutKind, profile);
    const guarded = applyCreativeCampaignLabelGuard({
      decision: rawDecision,
      input: inputWithoutKind,
      campaignLabelsById: new Map(),
    });

    expect(rawDecision.label).toBe("refresh");
    expect(rawDecision.labelTransform ?? null).toBeNull();
    expect(rawDecision.decisionKindSource).toBe("all_fallback");
    expect(guarded.label).toBe("diagnose");
    expect(guarded.blockedActionType).toBe("refresh");
    expect(guarded.labelTransform ?? null).toBeNull();
  });

  it("adds low_ctr badge from post-process when CTR is below account P10", async () => {
    const input = await getMockCreativeInput("c-1");
    const calibration = await mock.getAccountCalibration({
      businessId: "biz-1",
      asOf: "2026-05-04",
    });
    const profile = makeAccountDecisionProfile({
      accountBaselines: { ...calibration, lowCtrP10: 1.0 },
    });

    const out = decideCreative({ ...input, ctr: 0.5 }, profile);

    expect(out.label).toBe("keep");
    expect(out.badges).toContainEqual({
      type: "low_ctr",
      label: "Low CTR (0.50% vs account P10 1.00%)",
      severity: "info",
    });
    expect(out.badges.map((badge) => badge.type)).toContain(
      "opportunity_window_open",
    );
    expect(out.confidence).toBe(77);
  });

  it("adds missing_recent_data badge from post-process when recent 7d ROAS is null", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative({ ...input, recent7dRoas: null }, profile);

    expect(out.label).toBe("keep");
    expect(out.badges).toContainEqual({
      type: "missing_recent_data",
      label: "Recent 7d data missing",
      severity: "warning",
    });
    expect(out.badges.map((badge) => badge.type)).toContain(
      "opportunity_window_open",
    );
    expect(out.confidence).toBe(67);
  });

  it("applies DataHealth stale badges and confidence penalties when provided", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();
    const dataHealth = makeDataHealth({
      calibration: makeDataLayerHealth({ staleTier: "disabled" }),
      lifecycle: makeDataLayerHealth({ staleTier: "warning" }),
      decisions: makeDataLayerHealth({ staleTier: "warning" }),
    });

    const out = decideCreative(input, profile, dataHealth);

    expect(out.label).toBe("keep");
    expect(out.badges.map((badge) => badge.type)).toEqual([
      "scale_readiness_blocked",
      "stale_calibration",
      "stale_lifecycle",
      "stale_decision_context",
      "opportunity_window_open",
    ]);
    expect(out.confidence).toBe(67);
  });

  it("uses quality-only funnel diagnosis instead of global-default hard cuts", async () => {
    const input = await getMockCreativeInput("c-1");
    const calibration = await mock.getAccountCalibration({
      businessId: "biz-1",
      asOf: "2026-05-04",
    });
    const profile = makeAccountDecisionProfile({
      accountBaselines: {
        ...calibration,
        matureCreativeCount: 0,
        roasP75: null,
        roasP60: null,
        lowCtrP10: 1.0,
      },
    });

    const out = decideCreative(
      {
        ...input,
        spend: 300,
        purchases: 0,
        purchaseValue: 0,
        roas: 0,
        cpa: null,
        ctr: 0.9,
        addToCart: 0,
        initiateCheckout: 0,
        recent7dRoas: null,
        ageDays: 14,
        targetRoas: null,
      },
      profile,
    );

    expect(out.label).toBe("diagnose");
    expect(out.reason).toContain("Landing page issue:");
    expect(out.badges.map((badge) => badge.type)).toEqual([
      "truth_global_default",
      "landing_page_issue",
      "low_ctr",
    ]);
    expect(out.truthSource).toBe("global_default");
    expect(out.effectiveTargetRoas).toBe(0);
    expect(out.ratioToTarget).toBeNull();
    expect(out.confidence).toBe(45);
  });

  it("refreshes fatigued mature creatives below target with recent drop", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(
      {
        ...input,
        spend: 600,
        purchases: 6,
        roas: 1.65,
        recent7dRoas: 1.0,
        recent7dSpend: 80,
        fatigueStatus: "fatigued",
        linkClicks: 400,
        landingPageViews: 320,
        addToCart: 50,
        initiateCheckout: 25,
      },
      profile,
    );

    expect(out.label).toBe("refresh");
    expect(out.reason).toBe(
      "ROAS 1.65 (28d) = 75% of target and fatigued with recent 7d ROAS 1.00 decaying — iterate.",
    );
  });

  it("cuts sustained zero-conversion burners", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(
      {
        ...input,
        spend: 300,
        purchases: 0,
        purchaseValue: 0,
        roas: 0,
        cpa: null,
        linkClicks: 0,
        landingPageViews: 0,
        addToCart: 0,
        initiateCheckout: 0,
        ctr: 0.2,
        thumbstop: 5,
        ageDays: 14,
      },
      profile,
    );

    expect(out.label).toBe("cut");
    expect(out.reason).toBe(
      "0 purchases on $300 spend (28d cumulative, age 14d) — sustained zero-conversion burn past CPA-anchored maturity threshold $200.",
    );
  });

  it("downgrades scale decisions in soft-only mode", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = makeAccountDecisionProfile({
      hardActionEligibility: {
        scale: false,
        cut: false,
        refresh: false,
        reason: "threshold baseline meta_derived_aov has low confidence",
      },
    });

    const out = decideCreative(
      {
        ...input,
        spend: 1000,
        purchases: 15,
        roas: 3.5,
        recent7dRoas: 3.0,
      },
      profile,
    );

    expect(out.label).toBe("keep");
    expect(out.reason).toContain("[near scale, soft-only]");
    expect(out.badges.map((badge) => badge.type)).toContain(
      "scale_readiness_blocked",
    );
  });

  it("downgrades cut decisions in soft-only mode", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = makeAccountDecisionProfile({
      hardActionEligibility: {
        scale: false,
        cut: false,
        refresh: false,
        reason: "threshold baseline account_history has medium confidence",
      },
    });

    const out = decideCreative(
      {
        ...input,
        spend: 1500,
        purchases: 5,
        roas: 0.8,
        recent7dRoas: 0.7,
        ctr: 0.5,
        thumbstop: 10,
      },
      profile,
    );

    expect(out.label).toBe("test_more");
    expect(out.reason).toContain("[soft-only - cut blocked]");
    expect(out.badges.map((badge) => badge.type)).toContain("cut_candidate");
  });

  it("returns out_of_scope for non-sales objectives", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(
      {
        ...input,
        objective: "OUTCOME_ENGAGEMENT",
        lifecyclePosition: "rising",
      },
      profile,
    );

    expect(out.label).toBe("out_of_scope");
    expect(out.truthSource).toBe("global_default");
    expect(out.effectiveTargetRoas).toBe(0);
    expect(out.ratioToTarget).toBeNull();
    expect(out.reason).not.toContain("; lifecycle:");
    expect(out.reason).not.toContain("; momentum:");
  });

  it("keeps performance decision but flags active creatives with no recent spend", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(
      {
        ...input,
        effectiveStatus: "ACTIVE",
        recent7dSpend: 0,
        spend: 500,
        lifecyclePosition: "past_peak_unclear",
      },
      profile,
    );

    expect(out.label).toBe("keep");
    expect(out.badges.map((badge) => badge.type)).toContain("delivery_limited");
    expect(out.reason).not.toContain("check delivery");
  });
});
