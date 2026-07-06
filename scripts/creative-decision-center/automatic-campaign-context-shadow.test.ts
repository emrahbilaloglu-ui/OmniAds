import { describe, expect, it } from "vitest";
import {
  applyHysteresisSequence,
  campaignFamilyKey,
  classifyCampaignContext,
  computeFamilyInheritance,
  computeSignalScores,
  DEFAULT_CONTEXT_CONFIG,
  type CampaignFeatures,
} from "./automatic-campaign-context-shadow";

function baseFeatures(overrides: Partial<CampaignFeatures> = {}): CampaignFeatures {
  return {
    campaignId: "c-1",
    campaignName: "Neutral Campaign",
    spend28: 5_000,
    activeCreatives: 10,
    newCreatives: 1,
    medianCreativeAgeDays: 40,
    top3SpendShare: 0.7,
    spendHhi: 0.3,
    adsetCount: 3,
    activeDays: 28,
    campaignAgeDays: 120,
    spendShareOfBusiness: 0.3,
    medianCreativeSpend: 400,
    accountMedianCreativeSpend: 150,
    lineageDonorCount: 0,
    lineageReceiverCount: 2,
    lineageSharedCount: 2,
    ...overrides,
  };
}

function testLikeFeatures(overrides: Partial<CampaignFeatures> = {}): CampaignFeatures {
  // A mature, continuously rotating test container: old campaign, young
  // creatives. Young campaigns cannot reach high-confidence test from
  // behavior alone (age normalization) — that is deliberate.
  return baseFeatures({
    campaignName: "Creative Test Lab",
    spend28: 900,
    activeCreatives: 24,
    newCreatives: 14,
    medianCreativeAgeDays: 8,
    top3SpendShare: 0.25,
    campaignAgeDays: 90,
    spendShareOfBusiness: 0.04,
    medianCreativeSpend: 35,
    accountMedianCreativeSpend: 150,
    lineageDonorCount: 4,
    lineageReceiverCount: 0,
    lineageSharedCount: 4,
    ...overrides,
  });
}

describe("automatic campaign context resolver (shadow)", () => {
  it("is deterministic: same features produce identical output", () => {
    const features = testLikeFeatures();
    const first = classifyCampaignContext(features);
    const second = classifyCampaignContext(features);
    expect(second).toEqual(first);
  });

  it("classifies behavioral+structure test campaigns as high-confidence test", () => {
    const resolution = classifyCampaignContext(testLikeFeatures());
    expect(resolution.kind).toBe("test");
    expect(resolution.confidenceClass).toBe("high");
    expect(resolution.agreeingFamilies).toContain("behavioral");
  });

  it("classifies stable winner-concentrated campaigns as main", () => {
    const resolution = classifyCampaignContext(baseFeatures({ campaignName: "Core Prospecting" }));
    expect(resolution.kind).toBe("main");
    expect(["high", "medium"]).toContain(resolution.confidenceClass);
  });

  it("never produces high-confidence Test from naming alone", () => {
    // Main-shaped behavior with a test token in the name.
    const resolution = classifyCampaignContext(
      baseFeatures({ campaignName: "Test Campaign Alpha" }),
    );
    expect(
      resolution.kind === "test" && resolution.confidenceClass === "high",
    ).toBe(false);
  });

  it("flags naming-contradicts-behavior as conflict, not mixed", () => {
    const resolution = classifyCampaignContext(
      baseFeatures({
        campaignName: "Big Test Push",
        newCreatives: 0,
        medianCreativeAgeDays: 70,
        top3SpendShare: 0.9,
        spendShareOfBusiness: 0.45,
      }),
    );
    expect(resolution.confidenceClass).toBe("conflict");
    expect(resolution.kind).toBeNull();
    expect(resolution.conflictReasons).toContain("naming_contradicts_behavior");
  });

  it("classifies winner-core plus active-testing behavior as positive mixed", () => {
    const resolution = classifyCampaignContext(
      baseFeatures({
        campaignName: "Blended Performance",
        activeCreatives: 20,
        newCreatives: 8,
        medianCreativeAgeDays: 26,
        top3SpendShare: 0.6,
      }),
    );
    expect(resolution.kind).toBe("mixed");
    expect(["high", "medium", "low"]).toContain(resolution.confidenceClass);
  });

  it("test high-confidence requires a stricter margin than main", () => {
    expect(DEFAULT_CONTEXT_CONFIG.thresholds.highMarginTest).toBeGreaterThan(
      DEFAULT_CONTEXT_CONFIG.thresholds.highMarginMain,
    );
  });

  it("returns unknown when evidence floors fail", () => {
    const resolution = classifyCampaignContext(
      baseFeatures({ spend28: 10, activeCreatives: 1, activeDays: 2 }),
    );
    expect(resolution.confidenceClass).toBe("unknown");
    expect(resolution.kind).toBeNull();
  });

  it("lineage ablation changes scores but keeps determinism", () => {
    const features = testLikeFeatures();
    const withLineage = classifyCampaignContext(features, DEFAULT_CONTEXT_CONFIG, {
      includeLineage: true,
    });
    const withoutLineage = classifyCampaignContext(features, DEFAULT_CONTEXT_CONFIG, {
      includeLineage: false,
    });
    expect(withoutLineage.testScore).toBeLessThanOrEqual(withLineage.testScore);
    expect(
      classifyCampaignContext(features, DEFAULT_CONTEXT_CONFIG, { includeLineage: false }),
    ).toEqual(withoutLineage);
  });

  it("computeSignalScores caps lineage contribution", () => {
    const signals = computeSignalScores(
      testLikeFeatures({ lineageDonorCount: 100, activeCreatives: 10 }),
    );
    expect(signals.lineageTest).toBeLessThanOrEqual(0.6);
  });
});

describe("age normalization and floors", () => {
  it("does not read a young campaign's all-new cohort as test behavior", () => {
    // 14-day-old campaign where every creative is new: young, not testing.
    const resolution = classifyCampaignContext(
      baseFeatures({
        campaignName: "EMB-Permanent-USCA",
        campaignAgeDays: 14,
        newCreatives: 10,
        activeCreatives: 10,
        medianCreativeAgeDays: 10,
        top3SpendShare: 0.6,
      }),
    );
    expect(resolution.confidenceClass).not.toBe("conflict");
    expect(resolution.kind).toBe("main");
  });

  it("lets a single-creative high-spend catalog campaign pass floors", () => {
    const resolution = classifyCampaignContext(
      baseFeatures({
        campaignName: "TS_F5K_US_DPA_Value_InStock_202606",
        activeCreatives: 1,
        newCreatives: 1,
        spend28: 12_000,
        medianCreativeSpend: 12_000,
        top3SpendShare: 1,
      }),
    );
    expect(resolution.confidenceClass).not.toBe("unknown");
  });

  it("keeps low-spend single-creative campaigns unknown", () => {
    const resolution = classifyCampaignContext(
      baseFeatures({ activeCreatives: 1, newCreatives: 0, spend28: 200 }),
    );
    expect(resolution.confidenceClass).toBe("unknown");
  });
});

describe("family inheritance", () => {
  it("derives a stable family key from structured names", () => {
    expect(campaignFamilyKey("TS_F5K_US_DPA_Value_InStock_202606")).toBe("ts f5k");
    expect(campaignFamilyKey("TS_F5K_GB_Diagnostic_Value_202606")).toBe("ts f5k");
    expect(campaignFamilyKey("EMB-Perm-UK-2026Q2")).toBe("emb perm");
    expect(campaignFamilyKey(null)).toBeNull();
  });

  it("inherits the unanimous family kind into unknown members at medium", () => {
    const outcomes = computeFamilyInheritance([
      { campaignId: "a", familyKey: "ts f5k", kind: "mixed", confidenceClass: "high" },
      { campaignId: "b", familyKey: "ts f5k", kind: "mixed", confidenceClass: "medium" },
      { campaignId: "c", familyKey: "ts f5k", kind: null, confidenceClass: "unknown" },
      { campaignId: "d", familyKey: "ts f5k", kind: null, confidenceClass: "conflict" },
    ]);
    expect(outcomes).toEqual([
      { campaignId: "c", inheritedKind: "mixed", basisMembers: 2 },
    ]);
  });

  it("overrides weak low-confidence guesses that disagree with unanimous family", () => {
    const outcomes = computeFamilyInheritance([
      { campaignId: "a", familyKey: "ts f5k", kind: "mixed", confidenceClass: "high" },
      { campaignId: "b", familyKey: "ts f5k", kind: "mixed", confidenceClass: "high" },
      { campaignId: "c", familyKey: "ts f5k", kind: "main", confidenceClass: "low" },
    ]);
    expect(outcomes).toEqual([
      { campaignId: "c", inheritedKind: "mixed", basisMembers: 2 },
    ]);
  });

  it("does not inherit when classified members disagree (medium splits the family)", () => {
    const outcomes = computeFamilyInheritance([
      { campaignId: "a", familyKey: "ts f5k", kind: "mixed", confidenceClass: "high" },
      { campaignId: "b", familyKey: "ts f5k", kind: "mixed", confidenceClass: "high" },
      { campaignId: "c", familyKey: "ts f5k", kind: "main", confidenceClass: "medium" },
      { campaignId: "d", familyKey: "ts f5k", kind: null, confidenceClass: "unknown" },
    ]);
    expect(outcomes).toEqual([]);
  });

  it("never inherits test kind (false-Test protection)", () => {
    const outcomes = computeFamilyInheritance([
      { campaignId: "a", familyKey: "x lab", kind: "test", confidenceClass: "high" },
      { campaignId: "b", familyKey: "x lab", kind: "test", confidenceClass: "high" },
      { campaignId: "c", familyKey: "x lab", kind: null, confidenceClass: "unknown" },
    ]);
    expect(outcomes).toEqual([]);
  });

  it("requires unanimity among classified members", () => {
    const outcomes = computeFamilyInheritance([
      { campaignId: "a", familyKey: "f k", kind: "main", confidenceClass: "high" },
      { campaignId: "b", familyKey: "f k", kind: "mixed", confidenceClass: "high" },
      { campaignId: "c", familyKey: "f k", kind: null, confidenceClass: "unknown" },
    ]);
    expect(outcomes).toEqual([]);
  });
});

describe("hysteresis", () => {
  it("suppresses a one-off flip and downgrades high to medium", () => {
    const result = applyHysteresisSequence([
      { kind: "main", confidenceClass: "high" },
      { kind: "main", confidenceClass: "high" },
      { kind: "test", confidenceClass: "high" },
      { kind: "main", confidenceClass: "high" },
    ]);
    expect(result.finalKind).toBe("main");
    expect(result.suppressedFlip).toBe(true);
    expect(result.flips).toBe(0);
  });

  it("accepts a change confirmed by two consecutive evaluations", () => {
    const result = applyHysteresisSequence([
      { kind: "main", confidenceClass: "high" },
      { kind: "test", confidenceClass: "medium" },
      { kind: "test", confidenceClass: "high" },
    ]);
    expect(result.finalKind).toBe("test");
    expect(result.flips).toBe(1);
  });

  it("ignores unknown gaps without counting flips", () => {
    const result = applyHysteresisSequence([
      { kind: "main", confidenceClass: "medium" },
      { kind: null, confidenceClass: "unknown" },
      { kind: "main", confidenceClass: "high" },
    ]);
    expect(result.finalKind).toBe("main");
    expect(result.flips).toBe(0);
    expect(result.suppressedFlip).toBe(false);
  });
});
