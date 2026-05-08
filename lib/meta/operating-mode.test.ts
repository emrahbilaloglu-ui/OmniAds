import { describe, expect, it } from "vitest";
import {
  classifyMetaOperatingMode,
  classifyMetaSeasonalRegime,
  modeAwareScaleCeiling,
} from "@/lib/meta/operating-mode";

describe("Meta operating mode classifier", () => {
  it("classifies aggressive volume when spend and purchases expand near target", () => {
    expect(
      classifyMetaOperatingMode({
        current: { spend: 1300, revenue: 2600, purchases: 26, roas: 2 },
        previous: { spend: 1000, revenue: 2100, purchases: 20, roas: 2.1 },
        targetRoas: 2,
      }),
    ).toBe("aggressive_volume");
  });

  it("classifies profit first when constrained bidding dominates", () => {
    expect(
      classifyMetaOperatingMode({
        current: { spend: 1300, revenue: 2600, purchases: 26, roas: 2 },
        previous: { spend: 1000, revenue: 2100, purchases: 20, roas: 2.1 },
        targetRoas: 2,
        constrainedBidShare: 0.75,
      }),
    ).toBe("profit_first");
  });

  it("classifies seasonal regimes from account-relative ROAS and spend movement", () => {
    expect(classifyMetaSeasonalRegime({ d7Roas: 3, d14Roas: 2.6, d28Roas: 2, currentSpend: 1300, previousSpend: 1000 })).toBe("peak");
    expect(classifyMetaSeasonalRegime({ d7Roas: 1.2, d14Roas: 1.7, d28Roas: 2, currentSpend: 900, previousSpend: 1000 })).toBe("post_peak");
    expect(classifyMetaSeasonalRegime({ d7Roas: 2.8, d14Roas: 1.8, d28Roas: 2, currentSpend: 1000, previousSpend: 1000 })).toBe("unstable");
    expect(classifyMetaSeasonalRegime({ d7Roas: 2.05, d14Roas: 1.95, d28Roas: 2, currentSpend: 1000, previousSpend: 1000 })).toBe("normalized");
  });

  it("returns mode and regime aware scale ceilings", () => {
    expect(modeAwareScaleCeiling({ mode: "aggressive_volume", regime: "peak" })).toBe(0.3);
    expect(modeAwareScaleCeiling({ mode: "profit_first", regime: "post_peak" })).toBe(0.1);
  });
});
