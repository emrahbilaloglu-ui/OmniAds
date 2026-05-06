import { describe, expect, it } from "vitest";
import {
  classifyMetaAovQuality,
  resolveSpendUnit,
} from "../spend-unit-resolver";

const baseInput = {
  targetCpa: null,
  operatorAovAssumption: null,
  metaAttributedAovMean90d: null,
  metaAttributedAovPurchaseCount90d: 0,
  metaAttributedRevenue90d: 0,
  targetRoas: null,
  breakEvenRoas: null,
  accountCpaP50: null,
  accountCpaSampleCount: 0,
  attributionAovAdjustmentMultiplier: 1,
};

describe("resolveSpendUnit", () => {
  it("uses target_cpa directly with high confidence", () => {
    const result = resolveSpendUnit({ ...baseInput, targetCpa: 42 });

    expect(result).toMatchObject({
      spendUnit: 42,
      source: "target_cpa",
      confidence: "high",
      hardEligibleByDefault: true,
    });
  });

  it("uses operator AOV divided by target ROAS", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      operatorAovAssumption: 120,
      targetRoas: 3,
    });

    expect(result.source).toBe("operator_aov");
    expect(result.spendUnit).toBe(40);
    expect(result.confidence).toBe("high");
  });

  it("uses ready Meta-derived AOV with medium confidence and hard eligibility", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 20,
      metaAttributedRevenue90d: 1000,
      targetRoas: 2,
    });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.spendUnit).toBe(25);
    expect(result.confidence).toBe("medium");
    expect(result.hardEligibleByDefault).toBe(true);
  });

  it("keeps low-sample Meta-derived AOV soft-only", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 9,
      metaAttributedRevenue90d: 450,
      targetRoas: 2,
    });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.confidence).toBe("low");
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("keeps unstable Meta-derived AOV soft-only", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 3,
      metaAttributedRevenue90d: 150,
      targetRoas: 2,
    });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.confidence).toBe("low");
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("falls through when Meta purchase count is unavailable", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 0,
      targetRoas: 2,
      accountCpaP50: 35,
      accountCpaSampleCount: 20,
    });

    expect(result.source).toBe("account_history");
    expect(result.spendUnit).toBe(35);
  });

  it("uses account CPA history as soft-only degraded threshold evidence", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      accountCpaP50: 35,
      accountCpaSampleCount: 20,
      targetRoas: 2,
    });

    expect(result.source).toBe("account_history");
    expect(result.confidence).toBe("medium");
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("uses break-even AOV as a low-confidence soft-only floor", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 0,
      breakEvenRoas: 1.5,
    });

    expect(result.source).toBe("break_even_aov");
    expect(result.spendUnit).toBe(40);
    expect(result.confidence).toBe("low");
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("returns insufficient when all tiers are missing", () => {
    const result = resolveSpendUnit(baseInput);

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.confidence).toBe("insufficient");
  });
});

describe("classifyMetaAovQuality", () => {
  it("classifies purchase-count tiers", () => {
    expect(classifyMetaAovQuality(0)).toBe("unavailable");
    expect(classifyMetaAovQuality(1)).toBe("unstable");
    expect(classifyMetaAovQuality(5)).toBe("low_sample");
    expect(classifyMetaAovQuality(20)).toBe("ready");
  });
});
