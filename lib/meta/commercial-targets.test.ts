import { describe, expect, it, vi } from "vitest";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import {
  metaCutRoasCeiling,
  metaLossBudgetMaturity,
  metaScaleRoasFloor,
  normalizeMetaCommercialTargets,
  readMetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
}));

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

  it("does not promote coverage fallback thresholds into configured hard-action targets", async () => {
    vi.mocked(getBusinessCommercialTruthSnapshot).mockResolvedValue({
      targetPack: null,
      coverage: {
        thresholds: {
          source: "conservative_fallback",
          targetRoas: 2.5,
          breakEvenRoas: 1.8,
          targetCpa: 40,
          breakEvenCpa: 55,
          defaultRiskPosture: "balanced",
        },
      },
    } as unknown as Awaited<ReturnType<typeof getBusinessCommercialTruthSnapshot>>);

    await expect(readMetaCommercialTargets("business-1")).resolves.toMatchObject({
      source: "none",
      targetRoas: null,
      breakEvenRoas: null,
      targetCpa: null,
      breakEvenCpa: null,
    });
  });
});
