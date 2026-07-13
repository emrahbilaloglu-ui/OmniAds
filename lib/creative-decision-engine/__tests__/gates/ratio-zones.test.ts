import { describe, expect, it } from "vitest";
import { defaultBusinessConfig } from "../../config";
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
      "ROAS 3.00 (28d) = 150% of target 2.00 with 15 purchases (28d) and recent 7d holding at 2.20 — scale the ad set budget.",
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
      "[near scale] ROAS 3.00 (28d) above target (150%) — spend $600 / purchases 8 below scale floor (need ≥$200, ≥10); observe.",
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
      "[near scale] ROAS 3.00 (28d) above target (150%) — spend $150 / purchases 15 below scale floor (need ≥$200, ≥10); observe.",
    );
    expect(output.reason).toContain("spend $150");
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
      "[weak target] ROAS 1.80 (28d) just above breakeven (90% of target) — keep observing; consider tightening if recent 7d weakens.",
    );
    expect(output.reason.startsWith("[weak target]")).toBe(true);
  });

  it("keeps creatives at target without fatigue", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(1.0)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[at target] ROAS 2.00 (28d) at/around target 2.00 (100%) — stable, let it run.",
    );
    expect(output.reason.startsWith("[at target]")).toBe(true);
    expect(output.badges).toEqual([]);
  });

  it("keeps approaching-scale creatives in the near-scale sub-band", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(1.2)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[near scale] ROAS 2.40 (28d) approaching scale threshold (120%) — needs $200+ spend or 10+ purchases for full scale.",
    );
    expect(output.reason.startsWith("[near scale]")).toBe(true);
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
      "[at target] ROAS 2.00 (28d) at/around target 2.00 (100%) — stable, let it run; fatigue watch — monitor for refresh signal.",
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
      "ROAS 1.00 (28d) = 50% of target after $1,500 spend (28d) — clear loser at scale.",
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
      "ROAS 0.60 (28d) = 30% of target after $700 spend (28d) — sustained loser.",
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
      "ROAS 1.00 (28d) = 50% of target after $300 spend (28d) — loss-budget maturity reached at $200; cut underperforming creative.",
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
      "ROAS 1.00 (28d) = 50% of target after $150 spend (28d) — underperforming but spend not yet mature for hard cut, observe or pause manually.",
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
      "ROAS 1.00 (28d) = 50% of target and fatigued — replace with fresh iteration.",
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
    const output = terminalOutput(ratioZonesGate(ratioContext(0.75)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[weak zone] ROAS 1.50 (28d) = 75% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.",
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
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toBe(
      "ROAS 1.50 (28d) = 75% of target and fatigued with recent 7d ROAS 1.05 decaying — iterate.",
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

describe("ratioZonesGate - below-breakeven demote-candidate branch", () => {
  it("keeps mature working-zone creatives with a demote-candidate reason when below breakeven", () => {
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
    expect(output.reason.startsWith("[demote candidate]")).toBe(true);
    expect(output.reason).toContain(
      "above account bottom quartile (52%) but below breakeven (1.56 = 78% of target) at $9,000 mature spend",
    );
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

  it("does not expand the account cut zone toward breakeven", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.6, {
          input: { spend: 9000 },
          profile: profileWithBreakeven({
            breakEvenRoas: TARGET_ROAS * 0.78,
          }),
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[demote candidate]")).toBe(true);
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
      ratio: 0.52,
      mode: "account_p25",
      accountP25: 0.52,
      breakevenRatio: null,
    });
  });

  it("does not feed the 0.7 cold-start fallback into the adaptive formula", () => {
    const context = ratioContext(0.6, {
      profile: profileWithBreakeven({
        breakEvenRoas: TARGET_ROAS * 0.78,
        bottomQuartileRatio: undefined,
      }),
    });
    context.profile.thresholds.bottomQuartileRatio = null;

    expect(resolveCutBoundary(context)).toEqual({
      ratio: 0.7,
      mode: "account_p25",
      accountP25: null,
      breakevenRatio: null,
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
      "ROAS 3.00 (28d) = 150% of target 2.00 with 15 purchases (28d) and recent 7d holding at 2.20 — scale the ad set budget.",
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
