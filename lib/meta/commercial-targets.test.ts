import { describe, expect, it } from "vitest";
import {
  metaCutRoasCeiling,
  metaLossBudgetMaturity,
  metaScaleRoasFloor,
  normalizeMetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

describe("Meta commercial target helpers", () => {
  it("normalizes missing targets as no hard-action anchor", () => {
    expect(normalizeMetaCommercialTargets(null)).toMatchObject({
      source: "none",
      targetRoas: null,
      breakEvenRoas: null,
      riskPosture: "balanced",
    });
    expect(metaScaleRoasFloor(null)).toBeNull();
    expect(metaCutRoasCeiling(null)).toBeNull();
  });

  it("derives scale and cut ROAS floors from configured targets", () => {
    const targets = normalizeMetaCommercialTargets({
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      riskPosture: "aggressive",
    });
    expect(metaScaleRoasFloor(targets)).toBe(2.4);
    expect(metaCutRoasCeiling(targets)).toBe(1.6);
  });

  it("uses CPA baseline and risk posture for loss-budget maturity", () => {
    const targets = normalizeMetaCommercialTargets({
      breakEvenCpa: 100,
      riskPosture: "conservative",
    });
    expect(metaLossBudgetMaturity({ targets, currency: "USD" })).toMatchObject({
      cpaBaseline: 100,
      multiplier: 2.5,
      spendThreshold: 250,
      source: "break_even_cpa",
    });
  });
});
