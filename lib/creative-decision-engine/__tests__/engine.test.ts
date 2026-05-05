import { describe, expect, it } from "vitest";
import {
  decideCreative,
  ENGINE_VERSION,
  MockDataSource,
} from "..";
import {
  makeAccountDecisionProfile,
  makeDataHealth,
  makeDataLayerHealth,
} from "./helpers";

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
        scaleMinEvidenceSpend: 600,
        scaleMinPurchases: 10,
        zeroConvBurnerSpend: 200,
      },
    });
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

  it("returns keep for mock creative in scale zone without scale purchase depth", async () => {
    const input = await getMockCreativeInput("c-1");
    const profile = await getMockProfile();

    const out = decideCreative(input, profile);

    expect(out.label).toBe("keep");
    expect(out.reason).toBe(
      "[near scale] ROAS 3.00 (28d) above target (136%) — spend $500 / purchases 8 below scale floor (need ≥$600, ≥10); observe.",
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
      "stale_calibration",
      "stale_lifecycle",
      "stale_decision_context",
      "opportunity_window_open",
    ]);
    expect(out.confidence).toBe(67);
  });

  it("clamps confidence to the lower bound when penalties stack", async () => {
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
        ctr: 0.5,
        recent7dRoas: null,
        ageDays: 14,
        targetRoas: null,
      },
      profile,
    );

    expect(out.label).toBe("cut");
    expect(out.badges.map((badge) => badge.type)).toEqual([
      "truth_global_default",
      "low_ctr",
      "missing_recent_data",
    ]);
    expect(out.confidence).toBe(40);
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
        ageDays: 14,
      },
      profile,
    );

    expect(out.label).toBe("cut");
    expect(out.reason).toBe(
      "0 purchases on $300 spend (28d cumulative, age 14d) — sustained zero-conversion burn.",
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
    expect(out.effectiveTargetRoas).toBe(2.0);
    expect(out.ratioToTarget).toBeNull();
    expect(out.reason).not.toContain("; lifecycle:");
    expect(out.reason).not.toContain("; momentum:");
  });

  it("returns diagnose for active creatives with no recent spend", async () => {
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

    expect(out.label).toBe("diagnose");
    expect(out.reason).toBe(
      "Active creative — 0 spend in last 7d, 28d total $500 — check delivery (ad set status, budget, audience size, frequency caps).",
    );
    expect(out.reason).not.toContain("; lifecycle:");
    expect(out.reason).not.toContain("; momentum:");
  });
});
