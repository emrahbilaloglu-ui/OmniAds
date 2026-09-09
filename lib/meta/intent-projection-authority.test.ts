import { describe, expect, it } from "vitest";

import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";
import type { MetaCommercialTargets } from "@/lib/meta/commercial-targets";
import { resolveMetaIntentProjectionAuthority } from "@/lib/meta/intent-projection-authority";

function targets(
  overrides: Partial<MetaCommercialTargets> = {},
): MetaCommercialTargets {
  return {
    source: "configured_targets",
    targetRoas: 2,
    breakEvenRoas: 1.5,
    targetCpa: null,
    breakEvenCpa: null,
    aovAssumption: null,
    riskPosture: "balanced",
    freshness: "fresh",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function resolution(input: {
  targetRoas: number | null;
  targetCpa: number | null;
  metaAov: number | null;
  purchases: number;
}) {
  return resolveSpendUnit({
    targetCpa: input.targetCpa,
    operatorAovAssumption: null,
    metaAttributedAovMean90d: input.metaAov,
    metaAttributedAovPurchaseCount90d: input.purchases,
    metaAttributedRevenue90d: (input.metaAov ?? 0) * input.purchases,
    targetRoas: input.targetRoas,
    breakEvenRoas: 1.5,
    accountCpaP50: null,
    accountCpaSampleCount: 0,
  });
}

describe("intent projection authority", () => {
  it("authorizes both projectors from trusted Target ROAS and READY Meta AOV", () => {
    const spendUnitResolution = resolution({
      targetRoas: 2,
      targetCpa: null,
      metaAov: 100,
      purchases: 30,
    });

    expect(resolveMetaIntentProjectionAuthority({
      targets: targets(),
      metaAttributedAov: { aovMean: 100, purchaseCount: 30 },
      spendUnitResolution,
      spendUnitMinor: 5000,
    })).toEqual({
      budgetActionAuthorized: true,
      bidActionAuthorized: true,
    });
  });

  it("refuses READY AOV when the target pack provenance is unknown", () => {
    const spendUnitResolution = resolution({
      targetRoas: 2,
      targetCpa: null,
      metaAov: 100,
      purchases: 30,
    });

    expect(resolveMetaIntentProjectionAuthority({
      targets: targets({ freshness: "unknown", updatedAt: null }),
      metaAttributedAov: { aovMean: 100, purchaseCount: 30 },
      spendUnitResolution,
      spendUnitMinor: 5000,
    })).toEqual({
      budgetActionAuthorized: false,
      bidActionAuthorized: false,
    });
  });

  it("does not replace a failed exact read with a sample carried on the pack", () => {
    const spendUnitResolution = resolution({
      targetRoas: 2,
      targetCpa: null,
      metaAov: null,
      purchases: 0,
    });

    expect(resolveMetaIntentProjectionAuthority({
      targets: targets({
        metaAttributedAov: { aovMean: 100, purchaseCount: 30 },
      }),
      metaAttributedAov: null,
      spendUnitResolution,
      spendUnitMinor: null,
    })).toEqual({
      budgetActionAuthorized: false,
      bidActionAuthorized: false,
    });
  });

  it("keeps the trusted no-ROAS Target CPA bid path without authorizing budget", () => {
    const spendUnitResolution = resolution({
      targetRoas: null,
      targetCpa: 25,
      metaAov: null,
      purchases: 0,
    });

    expect(resolveMetaIntentProjectionAuthority({
      targets: targets({ targetRoas: null, targetCpa: 25 }),
      metaAttributedAov: null,
      spendUnitResolution,
      spendUnitMinor: 2500,
    })).toEqual({
      budgetActionAuthorized: false,
      bidActionAuthorized: true,
    });
  });

  it("refuses bid projection when the resolved unit cannot be represented safely", () => {
    const spendUnitResolution = resolution({
      targetRoas: null,
      targetCpa: 25,
      metaAov: null,
      purchases: 0,
    });

    expect(resolveMetaIntentProjectionAuthority({
      targets: targets({ targetRoas: null, targetCpa: 25 }),
      metaAttributedAov: null,
      spendUnitResolution,
      spendUnitMinor: null,
    }).bidActionAuthorized).toBe(false);
  });
});
