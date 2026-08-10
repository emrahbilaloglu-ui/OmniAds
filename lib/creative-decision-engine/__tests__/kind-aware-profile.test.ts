import { describe, expect, it } from "vitest";
import { selectKindAwareDecisionProfile } from "../kind-aware-profile";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  AccountFunnelCalibration,
  CalibrationCampaignKind,
  EngineThresholdSet,
  HardActionEligibility,
  SpendUnitProfile,
} from "../types";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeAccountFunnelCalibration,
  makeCreativeInput,
} from "./helpers";

function byKind<T>(
  overrides: Partial<Record<CalibrationCampaignKind, T | null>>,
): Record<CalibrationCampaignKind, T | null> {
  return {
    all: null,
    main: null,
    test: null,
    mixed: null,
    ...overrides,
  };
}

function spendUnitProfile(
  overrides: Partial<SpendUnitProfile> = {},
): SpendUnitProfile {
  return {
    spendUnit: 120,
    spendUnitSource: "account_history",
    spendUnitConfidence: "high",
    spendUnitEvidence: {
      targetCpa: null,
      operatorAovAssumption: null,
      metaAttributedAovMean90d: 70,
      metaAttributedAovPurchaseCount90d: 30,
      metaAttributedRevenue90d: 2100,
      targetRoas: 2,
      breakEvenRoas: 1.4,
      accountCpaP50: 60,
      accountCpaSampleCount: 30,
      warnings: [],
    },
    hardEligibleByDefault: true,
    ...overrides,
  };
}

function hardActionEligibility(
  overrides: Partial<HardActionEligibility> = {},
): HardActionEligibility {
  return {
    scale: true,
    cut: true,
    refresh: true,
    reason: null,
    ...overrides,
  };
}

function readyKindFunnel(
  kind: Exclude<CalibrationCampaignKind, "all">,
): AccountFunnelCalibration {
  const base = makeAccountFunnelCalibration();
  return {
    campaignKind: kind,
    byFormat: {
      ...base.byFormat,
      video: {
        ...base.byFormat.overall!,
        creativeFormat: "video",
        ctrP50: 2.5,
      },
    },
  };
}

function insufficientKindFunnel(
  kind: Exclude<CalibrationCampaignKind, "all">,
): AccountFunnelCalibration {
  const base = makeAccountFunnelCalibration();
  return {
    campaignKind: kind,
    byFormat: {
      overall: {
        ...base.byFormat.overall!,
        qualityStatus: "insufficient",
      },
    },
  };
}

function makeProfileWithKind(
  input: {
    kind?: Exclude<CalibrationCampaignKind, "all">;
    calibration?: Partial<AccountCalibration>;
    thresholds?: Partial<EngineThresholdSet>;
    spendUnit?: SpendUnitProfile | null;
    funnel?: AccountFunnelCalibration | null;
    hardActions?: HardActionEligibility | null;
  } = {},
): AccountDecisionProfile {
  const kind = input.kind ?? "main";
  const base = makeAccountDecisionProfile();
  const calibration = makeAccountCalibration({
    campaignKind: kind,
    matureCreativeCount: 20,
    accountCpaP50: 60,
    accountCpaSampleCount: 30,
    metaAttributedAovMean90d: 70,
    metaAttributedAovPurchaseCount90d: 30,
    matureSpendP50: 220,
    winnerPurchaseP50: 4,
    roasRatioP10: 0.45,
    roasRatioP25: 0.75,
    refreshRatioP10: 0.55,
    ...input.calibration,
  });
  const thresholds = {
    ...base.thresholds,
    commercialMaturitySpend: 123,
    scaleMinPurchases: 2,
    bottomQuartileRatio: 0.55,
    ...input.thresholds,
  };
  const resolvedSpendUnit =
    input.spendUnit === undefined ? spendUnitProfile() : input.spendUnit;
  const funnel =
    input.funnel === undefined ? readyKindFunnel(kind) : input.funnel;
  const hardActions =
    input.hardActions === undefined
      ? hardActionEligibility()
      : input.hardActions;

  return {
    ...base,
    accountBaselinesByKind: byKind({ [kind]: calibration }),
    spendUnitByKind: byKind({ [kind]: resolvedSpendUnit }),
    thresholdsByKind: byKind({ [kind]: thresholds }),
    hardActionEligibilityByKind: byKind({ [kind]: hardActions }),
    funnelCalibrationByKind: byKind({ [kind]: funnel }),
  };
}

describe("selectKindAwareDecisionProfile", () => {
  it("selects a kind-resolved profile when all required data is usable", () => {
    const profile = makeProfileWithKind({
      kind: "mixed",
      thresholds: { commercialMaturitySpend: 180 },
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "mixed", creativeFormat: "video" }),
      profile,
    );

    expect(selection.profile).not.toBe(profile);
    expect(selection.decisionKindSource).toBe("kind_mixed");
    expect(selection.profile.thresholds.commercialMaturitySpend).toBe(180);
    expect(selection.profile.funnelCalibration.campaignKind).toBe("mixed");
  });

  it("preserves account-wide commercial stop-loss Cut authority in a kind profile", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      hardActions: hardActionEligibility({
        scale: false,
        cut: false,
        refresh: true,
        reason: "kind scale and cut blocked",
        reasons: {
          scale: "kind scale blocked",
          cut: "kind cut blocked",
          refresh: null,
        },
      }),
    });
    profile.commercialStopLossSpendUnit = spendUnitProfile({
      spendUnit: 47.5,
      spendUnitSource: "meta_derived_aov",
    });
    profile.commercialStopLossThresholds = {
      ...profile.thresholds,
      commercialMaturitySpend: 38,
    };
    profile.commercialStopLossCanonicalHardActionEligibility =
      hardActionEligibility({
        scale: false,
        cut: false,
        refresh: false,
        reason: "account cut blocked",
        reasons: {
          scale: "account scale blocked",
          cut: "account cut blocked",
          refresh: "account refresh blocked",
        },
      });
    profile.hardActionEligibility = hardActionEligibility({
      scale: false,
      cut: true,
      refresh: false,
      reason: "account scale and refresh blocked",
      reasons: {
        scale: "account scale blocked",
        cut: null,
        refresh: "account refresh blocked",
      },
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main" }),
      profile,
    );

    expect(selection.decisionKindSource).toBe("kind_main");
    expect(selection.profile.hardActionEligibility).toEqual({
      scale: false,
      cut: true,
      refresh: true,
      reason: "kind scale blocked",
      reasons: {
        scale: "kind scale blocked",
        cut: null,
        refresh: null,
      },
    });
    expect(selection.profile.commercialStopLossThresholds).toBe(
      profile.commercialStopLossThresholds,
    );
    expect(
      selection.profile.commercialStopLossCanonicalHardActionEligibility,
    ).toBe(profile.hardActionEligibilityByKind?.main);
  });

  it("falls back without inspecting byKind data when campaignKind is null", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      thresholds: { commercialMaturitySpend: 1 },
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: null }),
      profile,
    );

    expect(selection.profile).toBe(profile);
    expect(selection.decisionKindSource).toBe("all_fallback");
  });

  it("falls back when spend-unit data for the kind is missing", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      spendUnit: null,
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main" }),
      profile,
    );

    expect(selection.profile).toBe(profile);
    expect(selection.decisionKindSource).toBe("all_fallback");
  });

  it("falls back when required ratio percentiles are missing", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      calibration: { roasRatioP10: null },
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main" }),
      profile,
    );

    expect(selection.profile).toBe(profile);
    expect(selection.decisionKindSource).toBe("all_fallback");
  });

  it("falls back when CPA sample count is below the kind-selection floor", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      calibration: { accountCpaSampleCount: 19 },
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main" }),
      profile,
    );

    expect(selection.profile).toBe(profile);
    expect(selection.decisionKindSource).toBe("all_fallback");
  });

  it("falls back when account CPA is not positive", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      calibration: { accountCpaP50: 0 },
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main" }),
      profile,
    );

    expect(selection.profile).toBe(profile);
    expect(selection.decisionKindSource).toBe("all_fallback");
  });

  it("falls back when AOV purchase evidence is absent", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      calibration: { metaAttributedAovPurchaseCount90d: 0 },
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main" }),
      profile,
    );

    expect(selection.profile).toBe(profile);
    expect(selection.decisionKindSource).toBe("all_fallback");
  });

  it("falls back when both format and overall kind funnel baselines are insufficient", () => {
    const profile = makeProfileWithKind({
      kind: "main",
      funnel: insufficientKindFunnel("main"),
    });

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main", creativeFormat: "video" }),
      profile,
    );

    expect(selection.profile).toBe(profile);
    expect(selection.decisionKindSource).toBe("all_fallback");
  });

  it("does not mix a canonical format baseline into a selected kind profile", () => {
    const baseFunnel = makeAccountFunnelCalibration();
    const profile = makeProfileWithKind({
      kind: "main",
      funnel: {
        campaignKind: "main",
        byFormat: {
          overall: {
            ...baseFunnel.byFormat.overall!,
            ctrP50: 4,
          },
        },
      },
    });
    profile.funnelCalibration = {
      ...profile.funnelCalibration,
      byFormat: {
        ...profile.funnelCalibration.byFormat,
        video: {
          ...baseFunnel.byFormat.overall!,
          creativeFormat: "video",
          ctrP50: 0.5,
        },
      },
    };

    const selection = selectKindAwareDecisionProfile(
      makeCreativeInput({ campaignKind: "main", creativeFormat: "video" }),
      profile,
    );

    expect(selection.decisionKindSource).toBe("kind_main");
    expect(selection.profile.funnelCalibration.byFormat.video).toBeUndefined();
    expect(selection.profile.funnelCalibration.byFormat.overall?.ctrP50).toBe(
      4,
    );
  });
});
