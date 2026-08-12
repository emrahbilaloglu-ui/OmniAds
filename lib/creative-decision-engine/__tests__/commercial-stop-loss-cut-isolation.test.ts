import { describe, expect, it } from "vitest";
import { decideCreative } from "../engine";
import type { AccountDecisionProfile, HardActionEligibility } from "../types";
import { makeAccountDecisionProfile, makeCreativeInput } from "./helpers";

const CUT_BLOCK_REASON = "canonical exact-cell AOV is thin";

function canonicalEligibility(cut: boolean): HardActionEligibility {
  return {
    scale: true,
    cut,
    refresh: true,
    reason: cut ? null : CUT_BLOCK_REASON,
    reasons: {
      scale: null,
      cut: cut ? null : CUT_BLOCK_REASON,
      refresh: null,
    },
  };
}

function canonicalProfile(input: {
  cut: boolean;
  maturity: number;
  hardCut?: number;
  recentSample?: number;
  bottomQuartileRatio?: number | null;
  severeLoserRatio?: number;
  breakEvenRoas?: number | null;
}): AccountDecisionProfile {
  const base = makeAccountDecisionProfile();
  return makeAccountDecisionProfile({
    spendUnitEvidence: {
      ...base.spendUnitEvidence,
      targetRoas: 2.2,
      breakEvenRoas:
        input.breakEvenRoas === undefined ? 1.71 : input.breakEvenRoas,
    },
    thresholds: {
      bottomQuartileRatio:
        input.bottomQuartileRatio === undefined
          ? 0.7
          : input.bottomQuartileRatio,
      severeLoserRatio: input.severeLoserRatio ?? 0.4,
      commercialMaturitySpend: input.maturity,
      hardCutSpend: input.hardCut ?? input.maturity,
      sustainedLoserSpend: input.maturity,
      recentSampleMinSpend: input.recentSample ?? 50,
    },
    hardActionEligibility: canonicalEligibility(input.cut),
  });
}

function withAccountAovRepair(
  canonical: AccountDecisionProfile,
  overlaySpendFloor: number,
): AccountDecisionProfile {
  const repairedEligibility = canonicalEligibility(true);
  return {
    ...canonical,
    hardActionEligibility: repairedEligibility,
    commercialStopLossCanonicalHardActionEligibility:
      canonical.hardActionEligibility,
    commercialStopLossSpendUnit: {
      spendUnit: overlaySpendFloor,
      spendUnitSource: "meta_derived_aov",
      spendUnitConfidence: "medium",
      spendUnitEvidence: canonical.spendUnitEvidence,
      hardEligibleByDefault: true,
    },
    commercialStopLossThresholds: {
      ...canonical.thresholds,
      zeroConvBurnerSpend: overlaySpendFloor,
      cutCandidateSpend: overlaySpendFloor,
      sustainedLoserSpend: overlaySpendFloor,
      commercialMaturitySpend: overlaySpendFloor,
      hardCutSpend: overlaySpendFloor,
      recentSampleMinSpend: overlaySpendFloor / 2,
    },
  };
}

function creative(input: {
  ratio: number;
  spend: number;
  recent7dRoas?: number | null;
  recent7dSpend?: number | null;
  recent7dPurchases?: number | null;
  purchases?: number;
  fatigueStatus?: "none" | "watch" | "fatigued";
}) {
  const roas = 2.2 * input.ratio;
  const purchases = input.purchases ?? 15;
  return makeCreativeInput({
    campaignKind: null,
    targetRoas: 2.2,
    breakevenRoas: 1.71,
    commercialTargetFreshness: "fresh",
    spend: input.spend,
    roas,
    purchases,
    purchaseValue: roas * input.spend,
    cpa: purchases > 0 ? input.spend / purchases : null,
    recent7dRoas: input.recent7dRoas === undefined ? 1 : input.recent7dRoas,
    recent7dSpend:
      input.recent7dSpend === undefined ? 100 : input.recent7dSpend,
    recent7dPurchases:
      input.recent7dPurchases === undefined ? 2 : input.recent7dPurchases,
    fatigueStatus: input.fatigueStatus ?? "none",
    dataFreshnessHours: 1,
  });
}

function decisionProjection(decision: ReturnType<typeof decideCreative>) {
  return {
    label: decision.label,
    reason: decision.reason,
    badges: decision.badges,
  };
}

describe("commercial stop-loss Cut isolation", () => {
  it("does not suppress an existing canonical Cut when the overlay threshold is higher", () => {
    const canonical = canonicalProfile({ cut: true, maturity: 100 });
    const overlaid = withAccountAovRepair(canonical, 500);
    const input = creative({ ratio: 0.5, spend: 300 });

    const baseline = decideCreative(input, canonical);
    const result = decideCreative(input, overlaid);

    expect(baseline.label).toBe("cut");
    expect(decisionProjection(result)).toEqual(decisionProjection(baseline));
  });

  it("does not let a P25-backed account-AOV overlay create an expanded Cut", () => {
    const canonical = canonicalProfile({
      cut: false,
      maturity: 100,
      hardCut: 1_000,
    });
    const overlaid = withAccountAovRepair(canonical, 500);
    const input = creative({ ratio: 0.75, spend: 300 });

    const baseline = decideCreative(input, canonical);
    const result = decideCreative(input, overlaid);

    expect(baseline.label).toBe("keep");
    expect(baseline.label).not.toBe("cut");
    expect(decisionProjection(result)).toEqual(decisionProjection(baseline));
  });

  it("repairs only the intended thin-cell Cut when trusted account spend depth is met", () => {
    const canonical = canonicalProfile({
      cut: false,
      maturity: 500,
      bottomQuartileRatio: null,
    });
    const overlaid = withAccountAovRepair(canonical, 100);
    const input = creative({ ratio: 0.5, spend: 300 });

    expect(decideCreative(input, canonical).label).toBe("test_more");
    expect(decideCreative(input, overlaid).label).toBe("cut");
  });

  it("does not reuse a lower untrusted canonical floor when the account-AOV repair floor is higher", () => {
    const canonical = canonicalProfile({
      cut: false,
      maturity: 100,
      hardCut: 100,
      recentSample: 50,
      bottomQuartileRatio: null,
    });
    const overlaid = withAccountAovRepair(canonical, 500);

    expect(
      decideCreative(creative({ ratio: 0.5, spend: 300 }), canonical).label,
    ).toBe("test_more");
    expect(
      decideCreative(creative({ ratio: 0.5, spend: 300 }), overlaid).label,
    ).toBe("test_more");
    expect(
      decideCreative(creative({ ratio: 0.5, spend: 500 }), overlaid).label,
    ).toBe("cut");
  });

  it("uses the lower account-AOV sample floor for Cut maturity but not recovery", () => {
    const canonical = canonicalProfile({
      cut: false,
      maturity: 1_000,
      recentSample: 200,
      bottomQuartileRatio: null,
    });
    const overlaid = withAccountAovRepair(canonical, 100);
    const input = creative({ ratio: 0.5, spend: 150 });

    expect(decideCreative(input, canonical).label).toBe("test_more");
    expect(decideCreative(input, overlaid).label).toBe("cut");
  });

  it("repairs a P25-null expanded-strip Cut only for confirmed recent economic loss", () => {
    const canonical = canonicalProfile({
      cut: false,
      maturity: 500,
      bottomQuartileRatio: null,
    });
    const overlaid = withAccountAovRepair(canonical, 100);
    const input = creative({
      ratio: 0.75,
      spend: 300,
      recent7dRoas: 1,
      recent7dSpend: 100,
    });

    expect(decideCreative(input, canonical).label).not.toBe("cut");
    expect(decideCreative(input, overlaid).label).toBe("cut");
  });

  it("keeps calibrated-relative-only native authority inside the legacy Cut region", () => {
    const profile = canonicalProfile({
      cut: true,
      maturity: 100,
      hardCut: 100,
      bottomQuartileRatio: 0.7,
    });
    profile.expandedEconomicCutAuthority = {
      eligible: false,
      authorityBasis: null,
      reason: "economic_spend_unit_authority_missing",
    };

    const expanded = decideCreative(
      creative({
        ratio: 0.75,
        spend: 500,
        recent7dSpend: 100,
        recent7dRoas: 1,
      }),
      profile,
    );
    const legacy = decideCreative(
      creative({
        ratio: 0.5,
        spend: 500,
        recent7dSpend: 100,
        recent7dRoas: 1,
      }),
      profile,
    );

    expect(expanded.label).toBe("keep");
    expect(expanded.preAuthorityLabel).toBe("keep");
    expect(expanded.blockedActionType).toBeNull();
    expect(legacy.label).toBe("cut");
    expect(legacy.preAuthorityLabel).toBe("cut");
  });

  it("does not let severe maturity bypass a denied expanded economic strip", () => {
    const base = makeAccountDecisionProfile();
    const profile = makeAccountDecisionProfile({
      spendUnitEvidence: {
        ...base.spendUnitEvidence,
        targetRoas: 3.5,
        breakEvenRoas: 1.2,
      },
      thresholds: {
        bottomQuartileRatio: 0.2,
        severeLoserRatio: 0.4,
        hardCutSpend: 250,
        commercialMaturitySpend: 500,
        recentSampleMinSpend: 50,
      },
    });
    profile.expandedEconomicCutAuthority = {
      eligible: false,
      authorityBasis: null,
      reason: "economic_spend_unit_authority_missing",
    };

    const decideAtRatio = (ratio: number) =>
      decideCreative(
        makeCreativeInput({
          effectiveCohort: "purchase",
          targetRoas: 3.5,
          breakevenRoas: 1.2,
          spend: 323,
          purchases: 10,
          purchaseValue: 323 * 3.5 * ratio,
          roas: 3.5 * ratio,
          recent7dSpend: 80,
          recent7dPurchases: 2,
          recent7dRoas: 0.9,
        }),
        profile,
      );

    const expanded = decideAtRatio(0.3);
    const legacy = decideAtRatio(0.15);
    expect(expanded.label).toBe("keep");
    expect(expanded.preAuthorityLabel).toBe("keep");
    expect(expanded.blockedActionType).toBeNull();
    expect(legacy.label).toBe("cut");
    expect(legacy.preAuthorityLabel).toBe("cut");
  });

  it("does not activate the P25-null account-AOV repair for confirmed recent recovery", () => {
    const canonical = canonicalProfile({
      cut: false,
      maturity: 500,
      bottomQuartileRatio: null,
    });
    const overlaid = withAccountAovRepair(canonical, 100);
    const input = creative({
      ratio: 0.75,
      spend: 300,
      recent7dRoas: 1.8,
      recent7dSpend: 100,
    });

    const baseline = decideCreative(input, canonical);
    const result = decideCreative(input, overlaid);
    expect(decisionProjection(result)).toEqual(decisionProjection(baseline));
    expect(result.authorityBlocker).not.toBe("recent_recovery_unverifiable");
  });

  it.each([
    {
      name: "missing",
      recent7dRoas: null,
      recent7dSpend: null,
      expectedBadge: "missing_recent_data",
    },
    {
      name: "thin",
      recent7dRoas: 1,
      recent7dSpend: 25,
      expectedBadge: null,
    },
  ])(
    "retains repaired Cut provenance while $name recent evidence holds the action",
    ({ recent7dRoas, recent7dSpend, expectedBadge }) => {
      const canonical = canonicalProfile({
        cut: false,
        maturity: 500,
        bottomQuartileRatio: null,
      });
      const overlaid = withAccountAovRepair(canonical, 100);
      const result = decideCreative(
        creative({
          ratio: 0.75,
          spend: 300,
          recent7dRoas,
          recent7dSpend,
        }),
        overlaid,
      );

      expect(result).toMatchObject({
        label: "test_more",
        preAuthorityLabel: "cut",
        authorityBlocker: "recent_recovery_unverifiable",
        blockedActionType: "cut",
      });
      expect(result.reason).toContain(
        "[cut verdict held - sufficient recent break-even evidence required]",
      );
      expect(result.badges.map((badge) => badge.type)).not.toContain(
        "pending_transition",
      );
      if (expectedBadge === null) {
        expect(result.badges.map((badge) => badge.type)).not.toContain(
          "missing_recent_data",
        );
      } else {
        expect(result.badges.map((badge) => badge.type)).toContain(
          expectedBadge,
        );
      }
    },
  );

  it("routes expanded-strip severe loss through recent evidence after Refresh precedence", () => {
    const profile = canonicalProfile({
      cut: true,
      maturity: 500,
      hardCut: 100,
      recentSample: 50,
      bottomQuartileRatio: 0.1,
      severeLoserRatio: 0.35,
      breakEvenRoas: 0.88,
    });
    const base = {
      ratio: 0.2,
      spend: 150,
      recent7dSpend: 80,
    } as const;

    const loss = decideCreative(
      creative({ ...base, recent7dRoas: 0.3 }),
      profile,
    );
    expect(loss.label).toBe("cut");
    expect(loss.reason).toContain("[economic stop-loss]");

    const recovery = decideCreative(
      creative({ ...base, recent7dRoas: 0.88 }),
      profile,
    );
    expect(recovery.label).toBe("keep");
    expect(recovery.reason).toContain("[economic recovery hold]");

    const missing = decideCreative(
      creative({
        ...base,
        recent7dRoas: null,
        recent7dSpend: null,
      }),
      profile,
    );
    expect(missing).toMatchObject({
      label: "test_more",
      preAuthorityLabel: "cut",
      authorityBlocker: "recent_recovery_unverifiable",
      blockedActionType: "cut",
    });
    expect(missing.badges.map((badge) => badge.type)).not.toContain(
      "pending_transition",
    );

    const fatigue = decideCreative(
      creative({
        ...base,
        recent7dRoas: 0.3,
        fatigueStatus: "fatigued",
      }),
      profile,
    );
    expect(fatigue.label).toBe("refresh");
  });

  it("never lets the early severe-loss gate Cut at or above explicit break-even", () => {
    const profile = canonicalProfile({
      cut: true,
      maturity: 500,
      hardCut: 100,
      bottomQuartileRatio: 0.2,
      severeLoserRatio: 0.4,
      breakEvenRoas: 0.6,
    });
    const aboveBreakEven = decideCreative(
      creative({
        ratio: 0.3,
        spend: 150,
        recent7dRoas: 0.5,
        recent7dSpend: 80,
      }),
      profile,
    );

    expect(aboveBreakEven.label).toBe("test_more");
    expect(aboveBreakEven.preAuthorityLabel).toBe("test_more");
    expect(aboveBreakEven.blockedActionType).toBeNull();
  });

  it("does not leak a manual-Cut advisory above a low explicit break-even", () => {
    const base = makeAccountDecisionProfile();
    const profile = makeAccountDecisionProfile({
      spendUnitEvidence: {
        ...base.spendUnitEvidence,
        targetRoas: 4,
        breakEvenRoas: 1,
      },
      thresholds: {
        bottomQuartileRatio: null,
        cutCandidateSpend: 300,
      },
    });
    const decision = decideCreative(
      makeCreativeInput({
        effectiveCohort: "purchase",
        targetRoas: 4,
        breakevenRoas: 1,
        spend: 500,
        purchases: 8,
        purchaseValue: 550,
        roas: 1.1,
        recent7dSpend: 100,
        recent7dPurchases: 2,
        recent7dRoas: 1.1,
      }),
      profile,
    );

    expect(decision.label).toBe("keep");
    expect(decision.badges.map((badge) => badge.type)).not.toContain(
      "cut_candidate",
    );
    expect(decision.blockedActionType).toBeNull();
  });

  it.each([
    {
      name: "recent purchases with zero ROAS",
      recent7dPurchases: 2,
      recent7dRoas: 0,
    },
    {
      name: "zero recent purchases with positive ROAS",
      recent7dPurchases: 0,
      recent7dRoas: 1,
    },
  ])(
    "fails closed on $name before expanded-strip Cut authority",
    ({ recent7dPurchases, recent7dRoas }) => {
      const profile = canonicalProfile({
        cut: true,
        maturity: 100,
        hardCut: 100,
        bottomQuartileRatio: 0.2,
      });
      const decision = decideCreative(
        creative({
          ratio: 0.5,
          spend: 500,
          recent7dSpend: 100,
          recent7dPurchases,
          recent7dRoas,
        }),
        profile,
      );

      expect(decision.label).toBe("diagnose");
      expect(decision.preAuthorityLabel).toBe("diagnose");
      expect(decision.blockedActionType).toBeNull();
      expect(decision.badges.map((badge) => badge.type)).toContain(
        "tracking_anomaly",
      );
    },
  );

  it("fails closed on recent purchase truth that would otherwise authorize Scale", () => {
    const profile = canonicalProfile({ cut: true, maturity: 100 });
    const decision = decideCreative(
      makeCreativeInput({
        effectiveCohort: "purchase",
        targetRoas: 2.2,
        breakevenRoas: 1.71,
        spend: 700,
        purchases: 12,
        purchaseValue: 2_100,
        roas: 3,
        recent7dSpend: 100,
        recent7dPurchases: 0,
        recent7dRoas: 3,
      }),
      profile,
    );

    expect(decision.label).toBe("diagnose");
    expect(decision.preAuthorityLabel).toBe("diagnose");
    expect(decision.blockedActionType).toBeNull();
    expect(decision.badges.map((badge) => badge.type)).toContain(
      "tracking_anomaly",
    );
  });

  it("fails closed on recent purchase truth that would otherwise authorize Refresh", () => {
    const profile = canonicalProfile({ cut: true, maturity: 100 });
    const decision = decideCreative(
      creative({
        ratio: 1,
        spend: 700,
        recent7dSpend: 100,
        recent7dPurchases: 2,
        recent7dRoas: 0,
        fatigueStatus: "fatigued",
      }),
      profile,
    );

    expect(decision.label).toBe("diagnose");
    expect(decision.preAuthorityLabel).toBe("diagnose");
    expect(decision.blockedActionType).toBeNull();
    expect(decision.badges.map((badge) => badge.type)).toContain(
      "tracking_anomaly",
    );
  });

  it("fails closed on recent purchase truth that would otherwise signal expanded-strip recovery", () => {
    const profile = canonicalProfile({
      cut: true,
      maturity: 100,
      bottomQuartileRatio: 0.2,
    });
    const decision = decideCreative(
      creative({
        ratio: 0.5,
        spend: 500,
        recent7dSpend: 100,
        recent7dPurchases: 0,
        recent7dRoas: 1.8,
      }),
      profile,
    );

    expect(decision.label).toBe("diagnose");
    expect(decision.preAuthorityLabel).toBe("diagnose");
    expect(decision.blockedActionType).toBeNull();
    expect(decision.badges.map((badge) => badge.type)).toContain(
      "tracking_anomaly",
    );
  });

  it("narrows severe-loss authority when break-even is below P25 but preserves the legacy loss below it", () => {
    const profile = canonicalProfile({
      cut: true,
      maturity: 500,
      hardCut: 100,
      bottomQuartileRatio: 0.5,
      severeLoserRatio: 0.4,
      breakEvenRoas: 0.44,
    });

    expect(
      decideCreative(
        creative({ ratio: 0.3, spend: 150, recent7dRoas: 0.3 }),
        profile,
      ).label,
    ).toBe("test_more");
    expect(
      decideCreative(
        creative({ ratio: 0.15, spend: 150, recent7dRoas: 0.3 }),
        profile,
      ).label,
    ).toBe("cut");
  });

  it("preserves the pre-D063 severe-loss safety path when explicit break-even is absent", () => {
    const profile = canonicalProfile({
      cut: true,
      maturity: 500,
      hardCut: 100,
      bottomQuartileRatio: 0.2,
      severeLoserRatio: 0.4,
      breakEvenRoas: null,
    });

    const decision = decideCreative(
      creative({ ratio: 0.3, spend: 150, recent7dRoas: 0.3 }),
      profile,
    );
    expect(decision.label).toBe("cut");
    expect(decision.reason).toContain("Severe loser at scale");
  });

  it.each([
    {
      name: "outside Cut ratio zone",
      input: creative({ ratio: 0.75, spend: 600 }),
      expected: "keep",
    },
    {
      name: "below repaired spend depth",
      input: creative({ ratio: 0.5, spend: 50 }),
      expected: "test_more",
    },
    {
      name: "canonical recent recovery",
      input: creative({
        ratio: 0.5,
        spend: 600,
        recent7dRoas: 2.4,
        recent7dSpend: 80,
      }),
      expected: "keep",
    },
    {
      name: "Scale",
      input: creative({
        ratio: 1.5,
        spend: 600,
        purchases: 15,
        recent7dRoas: 3.4,
      }),
      expected: "scale",
    },
    {
      name: "Refresh",
      input: creative({
        ratio: 1,
        spend: 600,
        recent7dRoas: 1,
        fatigueStatus: "fatigued",
      }),
      expected: "refresh",
    },
  ])("preserves $name action, reason, and badges", ({ input, expected }) => {
    const canonical = canonicalProfile({ cut: false, maturity: 500 });
    const overlaid = withAccountAovRepair(canonical, 100);

    const baseline = decideCreative(input, canonical);
    const result = decideCreative(input, overlaid);

    expect(baseline.label).toBe(expected);
    expect(decisionProjection(result)).toEqual(decisionProjection(baseline));
  });
});
