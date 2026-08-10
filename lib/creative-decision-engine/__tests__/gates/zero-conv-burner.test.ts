import { describe, expect, it } from "vitest";
import { zeroConvBurnerGate } from "../../gates/zero-conv-burner";
import { retainCommercialStopLossRepairOnlyForFinalCut } from "../../gates/cut-policy";
import { decideCreative } from "../../engine";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

function coherentZeroConversionInput(
  overrides: Parameters<typeof makeCreativeInput>[0] = {},
) {
  return makeCreativeInput({
    purchases: 0,
    purchaseValue: 0,
    roas: 0,
    cpa: null,
    recent7dPurchases: 0,
    recent7dRoas: 0,
    ctr: null,
    impressions: null,
    linkClicks: null,
    outboundClicks: null,
    landingPageViews: null,
    addToCart: null,
    initiateCheckout: null,
    thumbstop: null,
    ...overrides,
  });
}

function terminalOutput(result: ReturnType<typeof zeroConvBurnerGate>) {
  if (result.kind !== "terminal") {
    throw new Error("Expected terminal zero-conv burner result.");
  }
  return result.output;
}

describe("zeroConvBurnerGate", () => {
  it("cuts zero-purchase creatives with sustained burn", () => {
    const output = terminalOutput(
      zeroConvBurnerGate(
        makeGateContext({
          input: coherentZeroConversionInput({
            spend: 300,
            ageDays: 14,
          }),
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toBe(
      "0 purchases on 300 spend (28d cumulative, age 14d) — sustained zero-conversion burn past CPA-anchored maturity threshold 200.",
    );
    expect(output.confidence).toBe(80);
  });

  it("does not grant cut authority when delivery status is unknown", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: coherentZeroConversionInput({
          effectiveStatus: null,
          spend: 300,
          ageDays: 14,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances zero-purchase creatives below minimum spend", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: coherentZeroConversionInput({
          spend: 150,
          ageDays: 14,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances zero-purchase creatives below minimum age", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: coherentZeroConversionInput({
          spend: 300,
          ageDays: 5,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances creatives with at least one purchase", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: makeCreativeInput({
          purchases: 1,
          spend: 300,
          ageDays: 14,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("does not cut zero-purchase creatives when delivery is not active", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: coherentZeroConversionInput({
          effectiveStatus: "PAUSED",
          spend: 300,
          ageDays: 14,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("fails closed when zero purchases contradict above-break-even purchase truth", () => {
    const baseProfile = makeAccountDecisionProfile();
    const profile = makeAccountDecisionProfile({
      spendUnitEvidence: {
        ...baseProfile.spendUnitEvidence,
        targetRoas: 2.2,
        breakEvenRoas: 1.71,
      },
      thresholds: {
        zeroConvBurnerSpend: 100,
        commercialMaturitySpend: 100,
        hardCutSpend: 100,
      },
    });

    const output = decideCreative(
      makeCreativeInput({
        effectiveStatus: "ACTIVE",
        targetRoas: 2.2,
        breakevenRoas: 1.71,
        spend: 300,
        purchases: 0,
        purchaseValue: 600,
        roas: 2,
        ageDays: 14,
        recent7dSpend: 80,
        recent7dRoas: 2,
      }),
      profile,
    );

    expect(output.label).toBe("diagnose");
    expect(output.preAuthorityLabel).toBe("diagnose");
    expect(output.blockedActionType).toBeNull();
    expect(output.reason).toContain("contradictory purchase truth");
    expect(output.badges).toContainEqual(
      expect.objectContaining({ type: "tracking_anomaly" }),
    );
  });

  it("fails closed when positive purchases contradict zero value and ROAS", () => {
    const profile = makeAccountDecisionProfile({
      thresholds: {
        zeroConvBurnerSpend: 100,
        commercialMaturitySpend: 100,
        hardCutSpend: 100,
      },
    });

    const output = decideCreative(
      makeCreativeInput({
        effectiveCohort: "purchase",
        effectiveStatus: "ACTIVE",
        spend: 500,
        purchases: 4,
        purchaseValue: 0,
        roas: 0,
        ageDays: 21,
        recent7dSpend: 100,
        recent7dPurchases: 1,
        recent7dRoas: 0,
      }),
      profile,
    );

    expect(output.label).toBe("diagnose");
    expect(output.preAuthorityLabel).toBe("diagnose");
    expect(output.blockedActionType).toBeNull();
    expect(output.badges).toContainEqual(
      expect.objectContaining({ type: "tracking_anomaly" }),
    );
  });

  it("preserves zero-conversion stop-loss when explicit break-even is absent", () => {
    const baseProfile = makeAccountDecisionProfile();
    const profile = makeAccountDecisionProfile({
      spendUnitEvidence: {
        ...baseProfile.spendUnitEvidence,
        breakEvenRoas: null,
      },
      thresholds: {
        zeroConvBurnerSpend: 100,
        commercialMaturitySpend: 100,
      },
    });
    const output = decideCreative(
      coherentZeroConversionInput({
        effectiveStatus: "ACTIVE",
        targetRoas: 2.2,
        breakevenRoas: null,
        spend: 300,
        ageDays: 14,
      }),
      profile,
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toContain("sustained zero-conversion burn");
  });

  it("preserves a coherent positive-purchase loser Cut", () => {
    const profile = makeAccountDecisionProfile({
      thresholds: {
        bottomQuartileRatio: 0.7,
        severeLoserRatio: 0.4,
        cutCandidateSpend: 100,
        sustainedLoserSpend: 100,
        commercialMaturitySpend: 100,
        hardCutSpend: 100,
        recentSampleMinSpend: 50,
      },
    });

    const output = decideCreative(
      makeCreativeInput({
        effectiveCohort: "purchase",
        effectiveStatus: "ACTIVE",
        targetRoas: 2.2,
        breakevenRoas: 1.71,
        spend: 500,
        purchases: 4,
        purchaseValue: 250,
        roas: 0.5,
        ageDays: 21,
        recent7dSpend: 100,
        recent7dPurchases: 1,
        recent7dRoas: 0.5,
        linkClicks: 100,
        landingPageViews: 80,
        addToCart: 20,
        initiateCheckout: 10,
      }),
      profile,
    );

    expect(output.label).toBe("cut");
    expect(output.preAuthorityLabel).toBe("cut");
    expect(output.blockedActionType).toBeNull();
  });

  it("uses account-AOV loss thresholds only for a proven final-Cut row", () => {
    const baseProfile = makeAccountDecisionProfile();
    const profile = makeAccountDecisionProfile({
      spendUnitEvidence: {
        ...baseProfile.spendUnitEvidence,
        breakEvenRoas: 1.71,
      },
      thresholds: {
        bottomQuartileRatio: null,
        zeroConvBurnerSpend: 1_000,
        commercialMaturitySpend: 1_000,
      },
    });
    profile.commercialStopLossThresholds = {
      ...profile.thresholds,
      zeroConvBurnerSpend: 100,
      commercialMaturitySpend: 100,
    };
    profile.commercialStopLossSpendUnit = {
      spendUnit: 50,
      spendUnitSource: "meta_derived_aov",
      spendUnitConfidence: "medium",
      spendUnitEvidence: profile.spendUnitEvidence,
      hardEligibleByDefault: true,
    };
    profile.commercialStopLossCanonicalHardActionEligibility = {
      ...profile.hardActionEligibility,
      cut: false,
      reason: "canonical exact-cell AOV is thin",
      reasons: {
        ...profile.hardActionEligibility.reasons,
        cut: "canonical exact-cell AOV is thin",
      },
    };

    const aboveBreakEven = zeroConvBurnerGate(
      retainCommercialStopLossRepairOnlyForFinalCut(
        makeGateContext({
          profile,
          input: makeCreativeInput({
            purchases: 0,
            spend: 250,
            roas: 2,
            ageDays: 14,
          }),
          gate: {
            effectiveTargetRoas: 2.2,
            truthSource: "commercial_truth",
            ratioToTarget: 2 / 2.2,
          },
        }),
      ),
    );
    const belowBreakEven = terminalOutput(
      zeroConvBurnerGate(
        retainCommercialStopLossRepairOnlyForFinalCut(
          makeGateContext({
            profile,
            input: coherentZeroConversionInput({
              spend: 250,
              ageDays: 14,
            }),
            gate: {
              effectiveTargetRoas: 2.2,
              truthSource: "commercial_truth",
              ratioToTarget: 0,
            },
          }),
        ),
      ),
    );

    expect(aboveBreakEven.kind).toBe("advance");
    expect(belowBreakEven.label).toBe("cut");
  });
});
