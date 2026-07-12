import { describe, expect, it } from "vitest";
import { assessQualityOnly, computeFunnelDiagnosis } from "../funnel";
import type { FormatFunnelBaseline } from "../types";
import {
  makeAccountDecisionProfile,
  makeAccountFunnelCalibration,
  makeCreativeInput,
} from "./helpers";

function baseline(
  overrides: Partial<FormatFunnelBaseline> = {},
): FormatFunnelBaseline {
  const overall = makeAccountFunnelCalibration().byFormat.overall;
  if (!overall) throw new Error("Missing test funnel baseline.");
  return { ...overall, ...overrides };
}

function diagnose(input: {
  creative?: Parameters<typeof makeCreativeInput>[0];
  byFormat?: Record<string, FormatFunnelBaseline>;
  preset?: "aggressive" | "balanced" | "conservative";
  weakFunnelRate?: number;
}) {
  const profile = makeAccountDecisionProfile({
    preset: input.preset ?? "balanced",
    multipliers: { weakFunnelRate: input.weakFunnelRate ?? 0.5 },
  });
  return computeFunnelDiagnosis({
    creative: makeCreativeInput(input.creative),
    funnelCalibration: makeAccountFunnelCalibration({
      byFormat: input.byFormat ?? { overall: baseline() },
    }),
    profile,
  });
}

describe("computeFunnelDiagnosis", () => {
  it("marks healthy creatives as no weak funnel stage", () => {
    const result = diagnose({
      creative: {
        purchases: 16,
        initiateCheckout: 40,
      },
    });

    expect(result.primaryWeakStage).toBe("none");
    expect(result.creativeResponsible).toBe(false);
    expect(result.confidence).toBe(1);
  });

  it("marks weak thumbstop and CTR as upper_funnel and creative-responsible", () => {
    const result = diagnose({
      creative: {
        ctr: 0.5,
        thumbstop: 10,
      },
    });

    expect(result.primaryWeakStage).toBe("upper_funnel");
    expect(result.creativeResponsible).toBe(true);
    expect(result.evidence.join(" ")).toContain("CTR");
    expect(result.evidence.join(" ")).toContain("Thumbstop");
  });

  it("marks LPV-to-ATC weakness as a landing page issue", () => {
    const result = diagnose({
      creative: {
        linkClicks: 1_000,
        landingPageViews: 800,
        addToCart: 40,
        initiateCheckout: 30,
        purchases: 12,
        ctr: 1.5,
        thumbstop: 30,
      },
    });

    expect(result.primaryWeakStage).toBe("landing_page");
    expect(result.creativeResponsible).toBe(false);
  });

  it("marks ATC-to-IC weakness as checkout", () => {
    const result = diagnose({
      creative: {
        linkClicks: 1_000,
        landingPageViews: 800,
        addToCart: 120,
        initiateCheckout: 20,
        purchases: 10,
        ctr: 1.5,
        thumbstop: 30,
      },
    });

    expect(result.primaryWeakStage).toBe("checkout");
    expect(result.creativeResponsible).toBe(false);
  });

  it("marks healthy upstream activity with zero purchases as checkout breakdown", () => {
    const result = diagnose({
      creative: {
        spend: 500,
        linkClicks: 600,
        landingPageViews: 480,
        addToCart: 80,
        initiateCheckout: 40,
        purchases: 0,
      },
    });

    expect(result.primaryWeakStage).toBe("checkout");
    expect(result.creativeResponsible).toBe(false);
    expect(result.evidence.join(" ")).toContain("IC-to-purchase");
  });

  it("returns insufficient_signal when the weak denominator is too thin", () => {
    const result = diagnose({
      creative: {
        linkClicks: 10,
        landingPageViews: 8,
        addToCart: 0,
        initiateCheckout: 0,
        purchases: 0,
        ctr: 1.2,
        thumbstop: 25,
      },
    });

    expect(result.primaryWeakStage).toBe("insufficient_signal");
    expect(result.creativeResponsible).toBe(false);
  });

  it("uses format-specific baselines before overall", () => {
    const result = diagnose({
      creative: {
        creativeFormat: "video",
        ctr: 1,
        thumbstop: 30,
        purchases: 16,
      },
      byFormat: {
        overall: baseline({ ctrP25: 0.5, ctrP50: 1 }),
        video: baseline({
          creativeFormat: "video",
          ctrP25: 2,
          ctrP50: 2.5,
        }),
      },
    });

    expect(result.primaryWeakStage).toBe("upper_funnel");
    expect(result.evidence.join(" ")).toContain("CTR");
  });

  it("falls back to overall when format-specific baseline is missing", () => {
    const result = diagnose({
      creative: {
        creativeFormat: "image",
        ctr: 0.9,
        thumbstop: 30,
        purchases: 16,
      },
      byFormat: {
        overall: baseline({ ctrP25: 1.5, ctrP50: 2 }),
      },
    });

    expect(result.primaryWeakStage).toBe("upper_funnel");
  });

  it("makes aggressive presets more sensitive than conservative presets", () => {
    const byFormat = {
      overall: baseline({
        linkToLpvP25: null,
        linkToLpvP50: 100,
        linkToAtcP25: null,
        lpvToAtcP25: null,
        atcToIcP25: null,
        icToPurchaseP25: null,
      }),
    };
    const creative = {
      linkClicks: 1_000,
      landingPageViews: 600,
      addToCart: 120,
      initiateCheckout: 60,
      purchases: 24,
      ctr: 1.5,
      thumbstop: 30,
    };

    expect(
      diagnose({
        creative,
        byFormat,
        preset: "aggressive",
        weakFunnelRate: 0.65,
      }).primaryWeakStage,
    ).toBe("landing_page");
    expect(
      diagnose({
        creative,
        byFormat,
        preset: "conservative",
        weakFunnelRate: 0.35,
      }).primaryWeakStage,
    ).toBe("none");
  });

  it("does not call a tiny account-P25 miss materially weak", () => {
    const result = diagnose({
      creative: {
        linkClicks: 10_000,
        landingPageViews: 3_006,
        addToCart: 1_000,
        initiateCheckout: 500,
        purchases: 200,
        ctr: 1.5,
        thumbstop: 30,
      },
      byFormat: {
        overall: baseline({
          linkToLpvP25: 30.84,
          linkToLpvP50: 50,
        }),
      },
    });

    expect(result.primaryWeakStage).toBe("none");
  });
});

describe("assessQualityOnly", () => {
  it("does not lose confidence when compatible scored evidence is added", () => {
    const profile = makeAccountDecisionProfile();
    const funnelCalibration = makeAccountFunnelCalibration();
    const base = {
      ctr: 1.2,
      cpm: 12,
      impressions: 10_000,
      linkClicks: 100,
      landingPageViews: 75,
      initiateCheckout: null,
      creativeFormat: null,
    };
    const withoutMidFunnel = assessQualityOnly({
      creative: makeCreativeInput({ ...base, addToCart: null }),
      funnelCalibration,
      profile,
    });
    const withCompatibleMidFunnel = assessQualityOnly({
      creative: makeCreativeInput({ ...base, addToCart: 12 }),
      funnelCalibration,
      profile,
    });

    expect(withCompatibleMidFunnel.score).toBeCloseTo(
      withoutMidFunnel.score ?? 0,
    );
    expect(withCompatibleMidFunnel.confidence).toBeGreaterThanOrEqual(
      withoutMidFunnel.confidence,
    );
  });
});
