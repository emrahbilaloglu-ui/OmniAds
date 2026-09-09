import { describe, expect, it } from "vitest";
import { defaultBusinessConfig } from "../../config";
import { HARD_ACTION_HOLD_CONFIDENCE_CAP } from "../../config-values";
import { ratioZonesGate, resolveCutBoundary } from "../../gates/ratio-zones";
import type { GateContext } from "../../gates/types";
import type {
  AccountCalibration,
  BusinessConfig,
  CreativeInput,
} from "../../types";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

const TARGET_ROAS = 2.0;

function ratioContext(
  ratio: number | null,
  overrides: {
    input?: Partial<CreativeInput>;
    businessConfig?: Partial<BusinessConfig>;
    calibration?: Partial<AccountCalibration>;
    profile?: ReturnType<typeof makeAccountDecisionProfile>;
    gate?: Partial<
      Omit<GateContext, "input" | "businessConfig" | "calibration">
    >;
  } = {},
): GateContext {
  const businessConfig = {
    ...defaultBusinessConfig("biz-1"),
    ...overrides.businessConfig,
  };
  const roas = ratio === null ? null : TARGET_ROAS * ratio;
  const input = makeCreativeInput({
    spend: 600,
    purchases: 10,
    roas,
    recent7dSpend: 80,
    recent7dRoas: TARGET_ROAS,
    fatigueStatus: "none",
    targetRoas: TARGET_ROAS,
    lifecyclePosition: "past_peak_natural",
    daysSincePeak: 4,
    ...overrides.input,
  });

  return makeGateContext({
    input,
    businessConfig,
    calibration: makeAccountCalibration(overrides.calibration),
    profile: overrides.profile,
    gate: {
      effectiveTargetRoas: TARGET_ROAS,
      truthSource: "commercial_truth",
      ratioToTarget: ratio,
      ...overrides.gate,
    },
  });
}

function terminalOutput(result: ReturnType<typeof ratioZonesGate>) {
  if (result.kind !== "terminal") {
    throw new Error("Expected terminal ratio zones result.");
  }
  return result.output;
}

function profileWithBreakeven(input: {
  breakEvenRoas: number | null;
  bottomQuartileRatio?: number;
  hardCutSpend?: number | null;
}) {
  const baseProfile = makeAccountDecisionProfile();

  return makeAccountDecisionProfile({
    thresholds: {
      bottomQuartileRatio: input.bottomQuartileRatio ?? 0.52,
      hardCutSpend:
        input.hardCutSpend === undefined ? 1000 : input.hardCutSpend,
    },
    spendUnitEvidence: {
      ...baseProfile.spendUnitEvidence,
      breakEvenRoas: input.breakEvenRoas,
    },
  });
}

describe("ratioZonesGate - scale zone", () => {
  it("scales mature winners with recent 7d holding", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.reason).toBe(
      "ROAS 3.00 (28d) = 150% of commercial target 2.00 with 15 purchases (28d) and recent 7d holding at 2.20 — scale the ad set budget.",
    );
  });

  it("keeps scale-zone creatives without enough purchases for scale", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 8,
            recent7dRoas: 2.2,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[near scale] ROAS 3.00 (28d) above commercial target (150%) — spend 600 / purchases 8 below scale floor (need spend ≥200, ≥10); observe.",
    );
    expect(output.reason.startsWith("[near scale]")).toBe(true);
    expect(output.reason).toContain("purchases 8 below scale floor");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "scale_readiness_blocked",
    );
    expect(output.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "scale_purchase_depth",
          observed: 8,
          threshold: 10,
        }),
      ]),
    );
  });

  it("keeps scale-zone creatives without enough spend for scale", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            spend: 150,
            purchases: 15,
            recent7dRoas: 2.2,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[near scale] ROAS 3.00 (28d) above commercial target (150%) — spend 150 / purchases 15 below scale floor (need spend ≥200, ≥10); observe.",
    );
    expect(output.reason).toContain("spend 150");
  });

  it("keeps scale-zone creatives when recent 7d ROAS is missing", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[near scale]")).toBe(true);
    expect(output.reason).toContain("recent 7d ROAS missing");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "scale_readiness_blocked",
    );
  });

  it("blocks hard scale when source freshness is unknown", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
            dataFreshnessHours: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toContain("source evidence freshness is unknown");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "scale_readiness_blocked",
    );
    expect(output.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "scale_recent_freshness",
          observed:
            "source evidence freshness is unknown; scale requires fresh recent performance proof",
          status: "missing",
        }),
      ]),
    );
  });

  it("blocks hard scale when account calibration is too thin for scale", () => {
    const profile = makeAccountDecisionProfile({
      accountBaselines: makeAccountCalibration({
        matureCreativeCount: 12,
        winnerPurchaseP50: 3,
      }),
      quality: {
        commercialTruthReady: true,
        calibrationReady: false,
        metaAovQuality: "ready",
        thresholdQuality: "ready",
      },
      thresholds: {
        scaleMinPurchases: 3,
      },
    });

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 10,
            recent7dRoas: 2.2,
          },
          profile,
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toContain("account scale calibration thin");
    expect(output.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "scale_readiness_blocked",
        "scale_calibration_thin",
      ]),
    );
  });

  it("blocks hard scale when the account winner purchase benchmark is missing", () => {
    const profile = makeAccountDecisionProfile({
      accountBaselines: makeAccountCalibration({
        matureCreativeCount: 35,
        winnerPurchaseP50: null,
      }),
      thresholds: {
        scaleMinPurchases: 1,
      },
    });

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 10,
            recent7dRoas: 2.2,
          },
          profile,
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.confidence).toBeLessThanOrEqual(
      HARD_ACTION_HOLD_CONFIDENCE_CAP,
    );
    expect(output.reason).toContain("winner purchase benchmark unavailable");
    expect(output.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "scale_readiness_blocked",
        "scale_calibration_thin",
      ]),
    );
  });

  it("keeps scale label unchanged and adds fatigued badge", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
            fatigueStatus: "fatigued",
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.badges).toEqual([
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });
});
describe("ratioZonesGate - target band", () => {
  it("keeps weak-target creatives in the weak target sub-band", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(0.9)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[weak target] ROAS 1.80 (28d) just above breakeven (90% of commercial target) — keep observing; consider tightening if recent 7d weakens.",
    );
    expect(output.reason.startsWith("[weak target]")).toBe(true);
  });

  it("keeps creatives at target without fatigue", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(1.0)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[at target] ROAS 2.00 (28d) at/around commercial target 2.00 (100%) — stable, let it run.",
    );
    expect(output.reason.startsWith("[at target]")).toBe(true);
    expect(output.badges).toEqual([]);
  });

  it("keeps approaching-scale creatives in the near-scale sub-band", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(1.2)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[near scale] ROAS 2.40 (28d) approaching scale threshold (120% of commercial target) — performance ratio remains below the 130% scale zone; keep running.",
    );
    expect(output.reason.startsWith("[near scale]")).toBe(true);
  });

  it("names an account fallback as a baseline instead of a commercial target", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.2, {
          gate: { truthSource: "account_baseline" },
        }),
      ),
    );

    expect(output.reason).toContain("account P75 baseline");
    expect(output.reason).not.toContain("commercial target");
  });

  it("keeps creatives at target and adds fatigue watch badge", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "watch",
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[at target] ROAS 2.00 (28d) at/around commercial target 2.00 (100%) — stable, let it run; fatigue watch — monitor for refresh signal.",
    );
    expect(output.reason.startsWith("[at target]")).toBe(true);
    expect(output.badges).toEqual([
      {
        type: "fatigue_watch",
        label: "Fatigue watch",
        severity: "warning",
      },
    ]);
  });

  it("refreshes fatigued creatives when recent 7d ROAS has decayed", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.4,
            recent7dSpend: 80,
            lifecyclePosition: "plateau",
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toBe(
      "Fatigued + recent 7d ROAS 1.40 dropped to 70% of ROAS 2.00 (28d) — replace creative with new iteration.",
    );
  });

  it("keeps fatigued creatives when recent 7d ROAS is holding", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.9,
            recent7dSpend: 80,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.badges).toEqual([
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });

  it("keeps fatigued creatives when recent sample size is insufficient", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.4,
            recent7dSpend: 20,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.badges).toEqual([
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });
});

describe("ratioZonesGate - cut zone", () => {
  it("cuts clear losers at scale", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 1500,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toBe(
      "ROAS 1.00 (28d) = 50% of commercial target after 1,500 spend (28d) — clear loser at scale.",
    );
  });

  it("cuts sustained losers before full cut maturity", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.3, {
          input: {
            spend: 700,
            ctr: 0.5,
            thumbstop: 10,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toBe(
      "ROAS 0.60 (28d) = 30% of commercial target after 700 spend (28d) — sustained loser.",
    );
  });

  it("cuts loss-budget mature losers before hard-cut spend", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 300,
            purchases: 1,
            ctr: 0.5,
            thumbstop: 10,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toBe(
      "ROAS 1.00 (28d) = 50% of commercial target after 300 spend (28d) — loss-budget maturity reached at 200; cut underperforming creative.",
    );
  });

  it("keeps cut-zone creatives when recent recovery is holding above target", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 300,
            purchases: 1,
            recent7dRoas: 2.4,
            recent7dSpend: 80,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toContain("[recovery hold]");
    expect(output.reason).toContain(
      "do not hard cut while recovery is holding",
    );
    expect(output.badges).toContainEqual({
      type: "weak_performance",
      label: "Below target",
      severity: "warning",
    });
  });

  it("keeps the canonical recent-spend floor on non-Cut recovery rows", () => {
    const baseProfile = makeAccountDecisionProfile();
    const profile = makeAccountDecisionProfile({
      spendUnitEvidence: {
        ...baseProfile.spendUnitEvidence,
        breakEvenRoas: 1.5,
      },
      thresholds: {
        bottomQuartileRatio: 0.52,
        recentSampleMinSpend: 200,
        commercialMaturitySpend: 1_000,
        hardCutSpend: 1_000,
        sustainedLoserSpend: 1_000,
      },
    });
    profile.commercialStopLossThresholds = {
      ...profile.thresholds,
      recentSampleMinSpend: 50,
      commercialMaturitySpend: 100,
      hardCutSpend: 100,
      sustainedLoserSpend: 100,
    };

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          profile,
          input: {
            spend: 300,
            purchases: 1,
            recent7dRoas: 2.4,
            recent7dSpend: 80,
          },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toContain("spend not yet mature for hard cut");
  });

  it("returns test_more below cut maturity without fatigue", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 150,
          },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "ROAS 1.00 (28d) = 50% of commercial target after 150 spend (28d) — underperforming but spend not yet mature for hard cut, observe or pause manually.",
    );
  });

  it("refreshes below cut maturity when fatigued", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 150,
            fatigueStatus: "fatigued",
            lifecyclePosition: "plateau",
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toBe(
      "ROAS 1.00 (28d) = 50% of commercial target and fatigued — replace with fresh iteration.",
    );
  });

  it("keeps cut primary when funnel points to a landing page issue and adds diagnosis evidence", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 1500,
            linkClicks: 1_000,
            landingPageViews: 800,
            addToCart: 40,
            initiateCheckout: 20,
            purchases: 5,
            ctr: 1.5,
            thumbstop: 30,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toContain("Secondary diagnosis");
    expect(output.reason).toContain("landing_page");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "landing_page_issue",
    );
    expect(output.badges.map((badge) => badge.type)).toContain(
      "upper_funnel_strong_site_weak",
    );
  });

  it("keeps cut primary when funnel points to checkout breakdown and adds diagnosis evidence", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 1500,
            linkClicks: 1_000,
            landingPageViews: 800,
            addToCart: 120,
            initiateCheckout: 20,
            purchases: 5,
            ctr: 1.5,
            thumbstop: 30,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toContain("Secondary diagnosis");
    expect(output.reason).toContain("checkout");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "checkout_breakdown",
    );
  });

  it("keeps cut when the creative is responsible", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 1500,
            ctr: 0.5,
            thumbstop: 10,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "creative_quality_weak",
    );
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "landing_page_issue",
    );
  });
});

describe("ratioZonesGate - working zone", () => {
  it("keeps working-zone creatives and adds weak performance badge", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.7,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[weak zone] ROAS 1.50 (28d) = 75% of commercial target — below the comparison benchmark but in the working zone; no aggressive action, revisit if ROAS drifts further.",
    );
    expect(output.reason.startsWith("[weak zone]")).toBe(true);
    expect(output.badges).toEqual([
      {
        type: "weak_performance",
        label: "Below target",
        severity: "warning",
      },
    ]);
  });

  it("refreshes fatigued working-zone creatives when recent decay fires", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.05,
            recent7dSpend: 80,
            lifecyclePosition: "plateau",
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.7,
          }),
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toBe(
      "ROAS 1.50 (28d) = 75% of commercial target and fatigued with recent 7d ROAS 1.05 decaying — iterate.",
    );
  });

  it("blocks refresh when funnel points to a landing page issue and adds diagnosis evidence", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.05,
            recent7dSpend: 80,
            lifecyclePosition: "plateau",
            linkClicks: 1_000,
            landingPageViews: 800,
            addToCart: 40,
            initiateCheckout: 20,
            purchases: 5,
            ctr: 1.5,
            thumbstop: 30,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.7,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toContain("do not refresh creative");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "landing_page_issue",
    );
  });

  it("keeps fatigued working-zone creatives without recent decay", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.43,
            recent7dSpend: 80,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.7,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.badges).toEqual([
      {
        type: "weak_performance",
        label: "Below target",
        severity: "warning",
      },
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });
});

describe("ratioZonesGate - bounded economic stop-loss branch", () => {
  it("preserves the canonical non-native expanded strip when native authority metadata is absent", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.95,
      bottomQuartileRatio: 0.7,
    });
    profile.expandedEconomicCutAuthority = undefined;

    expect(profile.hardActionEligibility.cut).toBe(true);
    expect(profile.expandedEconomicCutAuthority).toBeUndefined();

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.preAuthorityLabel).toBe("cut");
    expect(output.reason.startsWith("[economic stop-loss]")).toBe(true);
  });

  it("reaches confirmed-loss Cut when the expanded economic strip is above the generic target band", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 80,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.95,
            bottomQuartileRatio: 0.7,
          }),
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.preAuthorityLabel).toBe("cut");
    expect(output.reason.startsWith("[economic stop-loss]")).toBe(true);
    expect(output.reason).toContain("remains below break-even 1.90");
  });

  it("still reaches the economic Cut when lifecycle evidence is unavailable and the recent window decayed", () => {
    /*
      INVARIANTS.md: "The bounded P25-to-break-even economic strip may cross
      the generic `0.85` target-band boundary. Refresh keeps precedence, but
      target-band Keep must not terminate a below-break-even row before the
      economic Cut/recovery/evidence branch runs."

      This row sits at 90% of target, below an explicit 1.90 break-even, with
      9,000 spend behind it. `fatigueStatus: null` is what every thin native
      account produces — `resolveNativeAdFrequencyPressureThreshold` returns
      null below eight sibling observations, so the ad-level contract emits
      `unknown` — and 1.40/1.80 = 0.78 clears the 0.82 refresh decay floor. The
      held-Refresh branch therefore matches this row exactly. If it ran before
      the `canonicalCutZone` test, this $9,000 stop-loss would be served as a
      `keep` whose `blocked_action_type` is `refresh`: the Cut erased, and not
      recoverable downstream because nothing records it.
    */
    for (const fatigueStatus of [null, "unknown"] as const) {
      const output = terminalOutput(
        ratioZonesGate(
          ratioContext(0.9, {
            input: {
              spend: 9000,
              recent7dRoas: 1.4,
              recent7dSpend: 80,
              fatigueStatus,
            },
            profile: profileWithBreakeven({
              breakEvenRoas: TARGET_ROAS * 0.95,
              bottomQuartileRatio: 0.7,
            }),
          }),
        ),
      );

      expect(output.label).toBe("cut");
      expect(output.preAuthorityLabel).toBe("cut");
      expect(output.blockedActionType).toBeNull();
      expect(output.reason.startsWith("[economic stop-loss]")).toBe(true);
    }
  });

  it("holds the Refresh candidate only above the economic strip", () => {
    // Same decayed recent window and the same missing fatigue verdict, but no
    // explicit break-even, so there is no economic Cut branch to preempt. The
    // candidate is held rather than deleted: `keep` is served, `refresh` is
    // recorded, and no provider action is authorized.
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 600,
            recent7dRoas: 1.4,
            recent7dSpend: 80,
            fatigueStatus: null,
          },
          profile: profileWithBreakeven({ breakEvenRoas: null }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("refresh");
    expect(output.blockedActionType).toBe("refresh");
    expect(output.authorityBlocker).toBe("native_metrics_unavailable");
    expect(output.reason).toContain(
      "[refresh verdict held - ad-level fatigue evidence required]",
    );
  });

  it("names source freshness first when the held Refresh was measured on stale evidence", () => {
    /*
      `finalizeDecision` applies its stale/unknown-freshness path only when the
      FINAL label is a hard action; this branch serves `keep`, so that path is
      skipped and the branch has to name freshness itself. A confirmed Refresh
      on the same window is held with `source_freshness`, and a held one must
      not silently report a cleaner story than the confirmed one.
    */
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 600,
            recent7dRoas: 1.4,
            recent7dSpend: 80,
            fatigueStatus: null,
            dataFreshnessHours: null,
          },
          profile: profileWithBreakeven({ breakEvenRoas: null }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("refresh");
    expect(output.blockedActionType).toBe("refresh");
    expect(output.authorityBlocker).toBe("source_freshness");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "unknown_freshness",
    );
  });

  it("describes an authority-denied above-0.85 expanded row as below break-even", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.95,
      bottomQuartileRatio: 0.7,
    });
    profile.expandedEconomicCutAuthority = {
      eligible: false,
      authorityBasis: null,
      reason: "economic_spend_unit_authority_missing",
    };

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("keep");
    expect(output.reason).toContain(
      "[below break-even - stop-loss review]",
    );
    expect(output.reason).toContain("below explicit break-even 1.90");
    expect(output.reason).not.toContain("just above breakeven");
    expect(output.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "below_breakeven",
        "weak_performance",
        "stop_loss_review",
      ]),
    );
    expect(output.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "expanded_economic_cut_authority",
          observed: "economic_spend_unit_authority_missing",
          threshold: "eligible",
          status: "missing",
        }),
      ]),
    );
  });

  it("keeps above-0.85 expanded-loss geometry visible when retained-side Cut eligibility denies authority", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.95,
      bottomQuartileRatio: 0.7,
    });
    profile.hardActionEligibility = {
      ...profile.hardActionEligibility,
      cut: false,
      reason: "native calibration does not authorize Cut",
      reasons: {
        ...profile.hardActionEligibility.reasons,
        cut: "native calibration does not authorize Cut",
      },
    };
    profile.expandedEconomicCutAuthority = {
      eligible: true,
      authorityBasis: "calibrated_relative_with_economic_stop_loss",
      reason: null,
    };

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("keep");
    expect(output.authorityBlocker).toBeNull();
    expect(output.blockedActionType).toBeNull();
    expect(output.reason).toContain(
      "[below break-even - stop-loss review]",
    );
    expect(output.reason).toContain("below explicit break-even 1.90");
    expect(output.reason).not.toContain("just above breakeven");
    expect(output.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "below_breakeven",
        "weak_performance",
        "stop_loss_review",
      ]),
    );
    expect(output.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "hard_action_eligibility.cut",
          observed: "native calibration does not authorize Cut",
          threshold: "true",
          status: "missing",
        }),
      ]),
    );
  });

  it("keeps below-0.85 expanded-loss geometry visible for a legacy profile without expanded authority metadata", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.95,
      bottomQuartileRatio: 0.7,
    });
    profile.hardActionEligibility = {
      ...profile.hardActionEligibility,
      cut: false,
      reason: "legacy soft-only profile",
      reasons: {
        ...profile.hardActionEligibility.reasons,
        cut: "legacy soft-only profile",
      },
    };
    profile.expandedEconomicCutAuthority = undefined;

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.8, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("keep");
    expect(output.authorityBlocker).toBeNull();
    expect(output.blockedActionType).toBeNull();
    expect(output.reason).toContain(
      "[below break-even - stop-loss review]",
    );
    expect(output.reason).toContain("below explicit break-even 1.90");
    expect(output.reason).not.toContain("just above breakeven");
    expect(output.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "hard_action_eligibility.cut",
          observed: "legacy soft-only profile",
          threshold: "true",
          status: "missing",
        }),
      ]),
    );
  });

  it("keeps stop-loss review visible below 0.85 when expanded authority is denied", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.95,
      bottomQuartileRatio: 0.7,
    });
    profile.expandedEconomicCutAuthority = {
      eligible: false,
      authorityBasis: null,
      reason: "economic_spend_unit_authority_missing",
    };

    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.8, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("keep");
    expect(output.authorityBlocker).toBeNull();
    expect(output.blockedActionType).toBeNull();
    expect(output.reason).toContain(
      "[below break-even - stop-loss review]",
    );
    expect(output.reason).toContain("below explicit break-even 1.90");
    expect(output.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "below_breakeven",
        "weak_performance",
        "stop_loss_review",
      ]),
    );
    expect(output.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "expanded_economic_cut_authority",
          observed: "economic_spend_unit_authority_missing",
          threshold: "eligible",
          status: "missing",
        }),
      ]),
    );
  });

  it("preserves confirmed-loss Cut and Refresh precedence below 0.85", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.95,
      bottomQuartileRatio: 0.7,
    });

    const confirmedLoss = terminalOutput(
      ratioZonesGate(
        ratioContext(0.8, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );
    const fatigued = terminalOutput(
      ratioZonesGate(
        ratioContext(0.8, {
          input: {
            spend: 9000,
            fatigueStatus: "fatigued",
            recent7dRoas: 1,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );

    expect(confirmedLoss.label).toBe("cut");
    expect(confirmedLoss.reason.startsWith("[economic stop-loss]")).toBe(true);
    expect(fatigued.label).toBe("refresh");
  });

  it("uses explicit break-even as a safety veto when target provenance is stale", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.75,
      bottomQuartileRatio: 0.9,
    });
    const aboveBreakEven = terminalOutput(
      ratioZonesGate(
        ratioContext(0.8, {
          input: { spend: 9000 },
          profile,
          gate: { truthSource: "commercial_truth_stale" },
        }),
      ),
    );
    const atBreakEven = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: { spend: 9000 },
          profile,
          gate: { truthSource: "commercial_truth_stale" },
        }),
      ),
    );
    const belowBreakEven = terminalOutput(
      ratioZonesGate(
        ratioContext(0.74, {
          input: { spend: 9000 },
          profile,
          gate: { truthSource: "commercial_truth_stale" },
        }),
      ),
    );

    for (const output of [aboveBreakEven, atBreakEven]) {
      expect(output.label).toBe("keep");
      expect(output.preAuthorityLabel).toBe("keep");
      expect(output.blockedActionType).toBeNull();
      expect(output.badges.map((badge) => badge.type)).not.toContain(
        "cut_candidate",
      );
    }
    expect(belowBreakEven.label).toBe("cut");
    expect(belowBreakEven.preAuthorityLabel).toBe("cut");
  });

  it("keeps recovery and holds thin recent evidence in the above-0.85 economic strip", () => {
    const profile = profileWithBreakeven({
      breakEvenRoas: TARGET_ROAS * 0.95,
      bottomQuartileRatio: 0.7,
    });
    const recovered = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 9000,
            recent7dRoas: 1.9,
            recent7dSpend: 80,
          },
          profile,
        }),
      ),
    );
    const thin = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 9000,
            recent7dRoas: 1.5,
            recent7dSpend: 10,
          },
          profile,
        }),
      ),
    );

    expect(recovered.label).toBe("keep");
    expect(recovered.reason.startsWith("[economic recovery hold]")).toBe(true);
    expect(thin.label).toBe("test_more");
    expect(thin.preAuthorityLabel).toBe("cut");
    expect(thin.authorityBlocker).toBe("recent_recovery_unverifiable");
    expect(thin.blockedActionType).toBe("cut");
  });

  it("preserves Refresh precedence inside the above-0.85 economic strip", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.9, {
          input: {
            spend: 9000,
            fatigueStatus: "fatigued",
            lifecyclePosition: "plateau",
            recent7dRoas: 1,
            recent7dSpend: 80,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.95,
            bottomQuartileRatio: 0.7,
          }),
        }),
      ),
    );

    expect(output.label).toBe("refresh");
  });

  it("keeps an expanded-strip loser when recent ROAS has recovered above break-even", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: {
            spend: 9000,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[economic recovery hold]")).toBe(true);
    expect(output.reason).toContain("at or above break-even 1.56");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "below_breakeven",
    );
    expect(output.badges.map((badge) => badge.type)).toContain(
      "weak_performance",
    );
  });

  it("falls back to weak-zone keep when below breakeven spend is not mature", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: {
            spend: 150,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[weak zone]")).toBe(true);
    expect(output.reason.startsWith("[demote candidate]")).toBe(false);
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "below_breakeven",
    );
  });

  it("falls through normally when mature working-zone ratio is above breakeven", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.85, {
          input: {
            spend: 9000,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[weak target]")).toBe(true);
    expect(output.reason.startsWith("[demote candidate]")).toBe(false);
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "below_breakeven",
    );
  });

  it("falls back to weak-zone keep when profile breakeven ROAS is unavailable", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: {
            spend: 9000,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: null,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[weak zone]")).toBe(true);
    expect(output.reason.startsWith("[demote candidate]")).toBe(false);
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "below_breakeven",
    );
  });

  it("keeps cut-zone precedence when ratio is below the account bottom quartile", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.4, {
          input: {
            spend: 9000,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason.startsWith("[demote candidate]")).toBe(false);
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "below_breakeven",
    );
  });

  it("cuts the expanded strip only when sufficient recent ROAS remains below break-even", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: {
            spend: 9000,
            recent7dRoas: 1.2,
            recent7dSpend: 80,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.preAuthorityLabel).toBe("cut");
    expect(output.authorityBlocker).toBeNull();
    expect(output.reason.startsWith("[economic stop-loss]")).toBe(true);
    expect(output.reason).toContain("remains below break-even 1.56");
  });

  it("holds the expanded-strip Cut when recent evidence is missing", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: {
            spend: 9000,
            recent7dRoas: null,
            recent7dSpend: null,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output).toMatchObject({
      label: "test_more",
      preAuthorityLabel: "cut",
      authorityBlocker: "recent_recovery_unverifiable",
      blockedActionType: "cut",
    });
    expect(output.badges.map((badge) => badge.type)).toContain(
      "missing_recent_data",
    );
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "pending_transition",
    );
  });

  it("holds the expanded-strip Cut without a missing-data badge when recent spend is thin", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: {
            spend: 9000,
            recent7dRoas: 1.2,
            recent7dSpend: 49,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output).toMatchObject({
      label: "test_more",
      preAuthorityLabel: "cut",
      authorityBlocker: "recent_recovery_unverifiable",
      blockedActionType: "cut",
    });
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "missing_recent_data",
    );
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "pending_transition",
    );
  });

  it("treats recent ROAS equality with break-even as recovery", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: {
            spend: 9000,
            recent7dRoas: TARGET_ROAS * 0.78,
            recent7dSpend: 80,
          },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[economic recovery hold]")).toBe(true);
  });

  it("does not cut when lifetime ratio equals explicit break-even", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.78, {
          input: { spend: 9000, recent7dRoas: 1.2 },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("keep");
  });

  it("does not cut above breakeven when account P25 is economically too high", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.8, {
          input: { spend: 9000 },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.7,
            bottomQuartileRatio: 0.9,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[weak zone]")).toBe(true);
  });

  it("keeps the current P25 boundary when commercial authority is stale", () => {
    const context = ratioContext(0.6, {
      profile: profileWithBreakeven({
        breakEvenRoas: TARGET_ROAS * 0.78,
      }),
      gate: { truthSource: "commercial_truth_stale" },
    });

    expect(resolveCutBoundary(context)).toEqual({
      legacyRatio: 0.52,
      ratio: 0.52,
      mode: "account_p25",
      accountP25: 0.52,
      breakevenRatio: null,
      economicUpperRatio: null,
    });
  });

  it("keeps the cold-start stop-loss boundary but records the commercial path", () => {
    const context = ratioContext(0.6, {
      profile: profileWithBreakeven({
        breakEvenRoas: TARGET_ROAS * 0.78,
        bottomQuartileRatio: undefined,
      }),
    });
    context.profile.thresholds.bottomQuartileRatio = null;

    expect(resolveCutBoundary(context)).toEqual({
      legacyRatio: 0.7,
      ratio: 0.7,
      mode: "uncalibrated_commercial_stop_loss",
      accountP25: null,
      breakevenRatio: 0.78,
      economicUpperRatio: 0.78,
    });
  });

  it("caps the uncalibrated stop-loss below break-even", () => {
    const context = ratioContext(0.65, {
      input: { spend: 9000 },
      profile: profileWithBreakeven({
        breakEvenRoas: TARGET_ROAS * 0.6,
        bottomQuartileRatio: undefined,
      }),
    });
    context.profile.thresholds.bottomQuartileRatio = null;

    expect(resolveCutBoundary(context)).toEqual({
      legacyRatio: 0.7,
      ratio: 0.6,
      mode: "uncalibrated_commercial_stop_loss",
      accountP25: null,
      breakevenRatio: 0.6,
      economicUpperRatio: 0.6,
    });

    const output = terminalOutput(ratioZonesGate(context));
    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[weak zone]")).toBe(true);
  });

  it("treats a zero peer percentile as unavailable rather than disabling stop-loss", () => {
    const context = ratioContext(0.5, {
      profile: profileWithBreakeven({
        breakEvenRoas: TARGET_ROAS * 0.65,
        bottomQuartileRatio: 0,
      }),
    });

    expect(resolveCutBoundary(context)).toEqual({
      legacyRatio: 0.7,
      ratio: 0.65,
      mode: "uncalibrated_commercial_stop_loss",
      accountP25: null,
      breakevenRatio: 0.65,
      economicUpperRatio: 0.65,
    });
  });
});

describe("ratioZonesGate - edge cases", () => {
  it("returns test_more when ratioToTarget is null", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(null)));

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "ROAS unavailable (28d) — cannot evaluate against target.",
    );
  });

  it("keeps fatigued creatives on the less-sensitive refresh fallback", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.6,
            recent7dSpend: 80,
          },
          calibration: {
            refreshRatioP10: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.badges).toEqual([
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });

  it("refreshes fatigued creatives below the cold-start refresh fallback", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.4,
            recent7dSpend: 80,
          },
          calibration: {
            refreshRatioP10: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
  });
});

describe("ratioZonesGate - lifecycle reason hints", () => {
  it("appends a momentum hint for rising scale decisions", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
            lifecyclePosition: "rising",
            daysSincePeak: 2,
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.reason).toContain("; momentum: rising (peak 2d ago)");
  });

  it("leaves scale reasons unchanged when lifecycle is null", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
            lifecyclePosition: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.reason).toBe(
      "ROAS 3.00 (28d) = 150% of commercial target 2.00 with 15 purchases (28d) and recent 7d holding at 2.20 — scale the ad set budget.",
    );
  });

  it("appends an operator review hint for at-target unclear post-peak keep decisions", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: { lifecyclePosition: "past_peak_unclear" },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toContain("; lifecycle: past_peak_unclear");
  });

  it("appends lifecycle context for natural post-peak refresh decisions", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.05,
            recent7dSpend: 80,
            lifecyclePosition: "past_peak_natural",
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toContain("; lifecycle: past_peak_natural");
  });

  it("does not append lifecycle hints to test_more reasons", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(null, {
          input: { lifecyclePosition: "rising" },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).not.toContain("; lifecycle:");
    expect(output.reason).not.toContain("; momentum:");
  });
});

describe("ratioZonesGate - F2 cut boundary clamp", () => {
  it("caps the cut boundary at 1.0 when account P25 exceeds it (curve-grading guard)", () => {
    // Strong account: roasRatioP25 = 1.3. A creative at ratio 1.05 is above
    // the clamped boundary and must not be zone-cut despite being below P25.
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.05, {
          profile: profileWithBreakeven({
            breakEvenRoas: 1.7,
            bottomQuartileRatio: 1.3,
          }),
          input: { spend: 1500 },
        }),
      ),
    );
    expect(output.label).not.toBe("cut");
  });

  it("still cuts genuinely below-boundary losers with a high account P25", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          profile: profileWithBreakeven({
            breakEvenRoas: 1.7,
            bottomQuartileRatio: 1.3,
          }),
          input: { spend: 1500 },
        }),
      ),
    );
    expect(output.label).toBe("cut");
  });
});

describe("ratioZonesGate - paused-delivery advisory badges", () => {
  it("adds confirm_kill to a cut verdict on a PAUSED creative", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: { spend: 1500, effectiveStatus: "PAUSED" },
        }),
      ),
    );
    expect(output.label).toBe("cut");
    expect(output.badges.map((badge) => badge.type)).toContain("confirm_kill");
  });

  it("adds no advisory badge on ACTIVE creatives", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: { spend: 1500, effectiveStatus: "ACTIVE" },
        }),
      ),
    );
    expect(output.label).toBe("cut");
    expect(output.badges.map((badge) => badge.type)).not.toContain(
      "confirm_kill",
    );
  });
});
