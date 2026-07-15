import { describe, expect, it, vi } from "vitest";
import {
  getBusinessCommercialTruthSnapshot,
  getBusinessTargetPackHistoryAsOf,
} from "@/lib/business-commercial";
import {
  hasMetaHardActionAnchor,
  metaCutRoasCeiling,
  metaCutRoasReviewCeiling,
  metaLossBudgetMaturity,
  metaScaleRoasFloor,
  normalizeMetaCommercialTargets,
  readMetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

vi.mock("@/lib/business-commercial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/business-commercial")>();
  return {
    ...actual,
    getBusinessCommercialTruthSnapshot: vi.fn(),
    getBusinessTargetPackHistoryAsOf: vi.fn(),
  };
});

describe("Meta commercial target helpers", () => {
  it("normalizes missing targets as no hard-action anchor", () => {
    expect(normalizeMetaCommercialTargets(null)).toMatchObject({
      source: "none",
      targetRoas: null,
      breakEvenRoas: null,
      riskPosture: "balanced",
      freshness: "unknown",
    });
    expect(metaScaleRoasFloor(null)).toBeNull();
    expect(metaCutRoasCeiling(null)).toBeNull();
  });

  it("derives scale and cut ROAS floors from configured targets", () => {
    const targets = normalizeMetaCommercialTargets({
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      riskPosture: "aggressive",
      freshness: "fresh",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });
    expect(metaScaleRoasFloor(targets)).toBe(2.4);
    expect(metaCutRoasCeiling(targets)).toBe(1.6);
  });

  it("does not invent a scale floor from break-even alone", () => {
    const targets = normalizeMetaCommercialTargets({
      breakEvenRoas: 1.6,
      freshness: "fresh",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    expect(metaScaleRoasFloor(targets)).toBeNull();
  });

  it("does not invent a loss ceiling as a fixed fraction of target ROAS", () => {
    const targets = normalizeMetaCommercialTargets({
      targetRoas: 2.4,
      freshness: "fresh",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    expect(metaCutRoasCeiling(targets)).toBeNull();
    expect(metaCutRoasReviewCeiling(targets)).toBeNull();
  });

  it("keeps timestamp-less targets visible but never grants hard-action authority", () => {
    const targets = normalizeMetaCommercialTargets({
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      freshness: "fresh",
    });

    expect(targets).toMatchObject({
      source: "configured_targets",
      freshness: "unknown",
      updatedAt: null,
    });
    expect(hasMetaHardActionAnchor(targets)).toBe(false);
    expect(metaScaleRoasFloor(targets)).toBeNull();
    expect(metaCutRoasCeiling(targets)).toBeNull();
  });

  it("rejects an invalid target timestamp", () => {
    const targets = normalizeMetaCommercialTargets({
      targetRoas: 2.4,
      freshness: "fresh",
      updatedAt: "not-a-date",
    });

    expect(targets.freshness).toBe("unknown");
    expect(targets.updatedAt).toBeNull();
    expect(hasMetaHardActionAnchor(targets)).toBe(false);
  });

  it("does not reclassify invalid stale provenance as age-only review metadata", () => {
    const targets = normalizeMetaCommercialTargets({
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      freshness: "stale",
      updatedAt: "not-a-date",
    });

    expect(targets).toMatchObject({
      freshness: "unknown",
      updatedAt: null,
    });
    expect(hasMetaHardActionAnchor(targets)).toBe(false);
  });

  it("rejects a future configured-target timestamp against the authority cutoff", () => {
    const targets = normalizeMetaCommercialTargets(
      {
        targetRoas: 2.4,
        breakEvenRoas: 1.6,
        freshness: "stale",
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
      new Date("2026-07-15T00:00:00.000Z"),
    );

    expect(targets).toMatchObject({
      freshness: "unknown",
      updatedAt: null,
    });
    expect(metaScaleRoasFloor(targets)).toBeNull();
    expect(metaCutRoasCeiling(targets)).toBeNull();
    expect(hasMetaHardActionAnchor(targets)).toBe(false);
  });

  it("keeps an old configured target as a hard-action anchor when its timestamp is valid", () => {
    const targets = normalizeMetaCommercialTargets(
      {
        targetRoas: 2.4,
        breakEvenRoas: 1.6,
        freshness: "stale",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      new Date("2026-07-15T00:00:00.000Z"),
    );

    expect(targets.source).toBe("configured_targets");
    expect(targets.freshness).toBe("stale");
    expect(metaScaleRoasFloor(targets)).toBe(2.4);
    expect(metaCutRoasCeiling(targets)).toBe(1.6);
    expect(metaCutRoasReviewCeiling(targets)).toBe(1.6);
    expect(hasMetaHardActionAnchor(targets)).toBe(true);
  });

  it("keeps unknown-age targets visible but removes hard-action thresholds", () => {
    const targets = normalizeMetaCommercialTargets({
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      freshness: "unknown",
    });

    expect(targets).toMatchObject({
      source: "configured_targets",
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      freshness: "unknown",
    });
    expect(hasMetaHardActionAnchor(targets)).toBe(false);
    expect(metaScaleRoasFloor(targets)).toBeNull();
    expect(metaCutRoasCeiling(targets)).toBeNull();
  });

  it("uses CPA baseline and risk posture for loss-budget maturity", () => {
    const targets = normalizeMetaCommercialTargets({
      breakEvenCpa: 100,
      riskPosture: "conservative",
    });
    expect(metaLossBudgetMaturity({
      targets,
      calibratedHardCutSpend: 300,
    })).toMatchObject({
      cpaBaseline: 100,
      multiplier: 2.5,
      calibratedSpendFloor: 300,
      spendThreshold: 300,
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

  it("reads historical targets at the exact producer cutoff", async () => {
    vi.mocked(getBusinessTargetPackHistoryAsOf).mockResolvedValue({
      targetCpa: 100,
      targetRoas: 2.4,
      breakEvenCpa: 130,
      breakEvenRoas: 1.6,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      costStructure: {
        cogsPercent: null,
        shippingPercent: null,
        fulfillmentPercent: null,
        paymentProcessingPercent: null,
      },
      sourceLabel: "settings_manual_entry",
      updatedAt: "2026-05-04T02:00:00.000Z",
      updatedByUserId: null,
    });

    await expect(
      readMetaCommercialTargets("business-1", { asOf: "2026-05-04" }),
    ).resolves.toMatchObject({
      source: "configured_targets",
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      freshness: "fresh",
      updatedAt: "2026-05-04T02:00:00.000Z",
    });
    expect(getBusinessTargetPackHistoryAsOf).toHaveBeenCalledWith({
      businessId: "business-1",
      asOf: "2026-05-04",
    });
  });

  it("normalizes replay targets against the requested cutoff instead of wall-clock time", async () => {
    vi.mocked(getBusinessTargetPackHistoryAsOf).mockResolvedValue({
      targetCpa: 100,
      targetRoas: 2.4,
      breakEvenCpa: 130,
      breakEvenRoas: 1.6,
      contributionMarginAssumption: null,
      aovAssumption: null,
      newCustomerWeight: null,
      defaultRiskPosture: "balanced",
      costStructure: {
        cogsPercent: null,
        shippingPercent: null,
        fulfillmentPercent: null,
        paymentProcessingPercent: null,
      },
      sourceLabel: "settings_manual_entry",
      updatedAt: "2099-12-01T00:00:00.000Z",
      updatedByUserId: null,
    });

    await expect(
      readMetaCommercialTargets("business-1", {
        asOf: "2100-01-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      source: "configured_targets",
      targetRoas: 2.4,
      breakEvenRoas: 1.6,
      freshness: "stale",
      updatedAt: "2099-12-01T00:00:00.000Z",
    });
  });
});
