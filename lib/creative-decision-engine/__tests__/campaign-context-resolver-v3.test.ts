import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CampaignFeatures } from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
  DEFAULT_V3_CONFIG,
  classifyCampaignContextV3,
  computeSignalScoresV3,
  excessConcentration,
  type CampaignLifecycleFeatures,
} from "@/lib/creative-decision-engine/campaign-context/resolver-v3";

function features(overrides: Partial<CampaignFeatures>): CampaignFeatures {
  return {
    campaignId: "campaign-1",
    campaignName: null,
    spend28: 500,
    activeCreatives: 4,
    newCreatives: 0,
    medianCreativeAgeDays: 30,
    top3SpendShare: 0.9,
    spendHhi: null,
    adsetCount: 1,
    activeDays: 28,
    campaignAgeDays: 60,
    spendShareOfBusiness: 0.05,
    medianCreativeSpend: 100,
    accountMedianCreativeSpend: 100,
    lineageDonorCount: 0,
    lineageReceiverCount: 0,
    lineageSharedCount: 0,
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<CampaignLifecycleFeatures>,
): CampaignLifecycleFeatures {
  return {
    statusCoverageDays: 28,
    activeStatusShare28: 1,
    currentConfiguredStatus: "ACTIVE",
    daysSinceLastStatusChange: 10,
    effectiveDailyBudget: 100,
    accountMedianDailyBudget: 100,
    activeAdsetCount: 1,
    accountMedianActiveCreatives: 8,
    ...overrides,
  };
}

describe("excess concentration (D076 R3)", () => {
  it("is structurally unavailable at three or fewer creatives", () => {
    expect(excessConcentration(1, 3)).toBeNull();
    expect(excessConcentration(1, 1)).toBeNull();
    expect(excessConcentration(null, 10)).toBeNull();
  });

  it("measures only the excess over the structural floor", () => {
    // N=4: floor 0.75. top3=0.75 carries zero information; top3=1 is full.
    expect(excessConcentration(0.75, 4)).toBe(0);
    expect(excessConcentration(1, 4)).toBe(1);
    // N=30: floor 0.1; top3=0.55 is exactly half the excess range.
    expect(excessConcentration(0.55, 30)).toBeCloseTo(0.5, 10);
  });

  it("no longer inflates behavioralMain on a tiny creative set", () => {
    const smallCampaign = features({
      activeCreatives: 3,
      newCreatives: 3,
      top3SpendShare: 1,
      medianCreativeAgeDays: 5,
      campaignAgeDays: 13,
      spendShareOfBusiness: 0.006,
    });
    const signals = computeSignalScoresV3(smallCampaign, null);
    // v2 scored this shape's behavioralMain ~0.59, mostly from the
    // structural top3=1 term — past the 0.55 conflict strength, which is
    // what nulled small explicitly-named tests. v3 must stay clearly below
    // that bar once the concentration term is unavailable.
    expect(signals.excessConcentration).toBeNull();
    expect(signals.behavioralMain).toBeLessThan(0.35);
  });
});

describe("mixed gate recalibration (D076 R1/R2)", () => {
  const winnerCorePlusFewNew = features({
    activeCreatives: 8,
    newCreatives: 5,
    medianCreativeAgeDays: 40,
    top3SpendShare: 0.97,
    campaignAgeDays: 860,
    spend28: 888,
    spendShareOfBusiness: 0.04,
  });

  it("no longer publishes mixed for a small campaign cycling a few creatives", () => {
    // The R1 regression class: 8 creatives / 5 "new" published mixed/high
    // under v2 against a main label.
    const resolution = classifyCampaignContextV3(winnerCorePlusFewNew, null);
    expect(resolution.kind).not.toBe("mixed");
  });

  it("accepts a broad hybrid at the 0.45 winner-core bar", () => {
    const broadHybrid = features({
      activeCreatives: 32,
      newCreatives: 12,
      medianCreativeAgeDays: 40,
      top3SpendShare: 0.4747,
      campaignAgeDays: 59,
      spend28: 77_061,
      spendShareOfBusiness: 0.0688,
    });
    const resolution = classifyCampaignContextV3(broadHybrid, null);
    expect(resolution.kind).toBe("mixed");
  });

  it("keeps the 0.5 winner-core bar for narrow campaigns", () => {
    const narrow = features({
      activeCreatives: 14,
      newCreatives: 7,
      medianCreativeAgeDays: 40,
      top3SpendShare: 0.47,
      campaignAgeDays: 100,
    });
    expect(classifyCampaignContextV3(narrow, null).kind).not.toBe("mixed");
  });
});

describe("conflict correction (D076 R3 corollary)", () => {
  it("does not null a small low-share campaign for its test-token name", () => {
    const smallNamedTest = features({
      campaignName: "Deneme - yeni kreatif seti",
      activeCreatives: 3,
      newCreatives: 0,
      medianCreativeAgeDays: 45,
      top3SpendShare: 1,
      spendShareOfBusiness: 0.02,
      campaignAgeDays: 54,
      activeDays: 7,
      spend28: 4_128,
    });
    const resolution = classifyCampaignContextV3(smallNamedTest, null);
    expect(resolution.conflictReasons).not.toContain(
      "naming_contradicts_behavior",
    );
  });

  /**
   * D081 C5 supersedes the second half of this case. The reason is still
   * surfaced, because a reader benefits from knowing the name disagrees with
   * the behaviour. It no longer nulls the kind: letting a name force `conflict`
   * meant renaming a campaign could remove — and re-grant — hard authority,
   * which is the defect D081 C5 closes. Non-naming conflict still nulls it.
   */
  it("still surfaces the naming conflict, but no longer nulls the kind", () => {
    const testNamedButDominant = features({
      campaignName: "TEST winners",
      activeCreatives: 13,
      newCreatives: 0,
      medianCreativeAgeDays: 45,
      top3SpendShare: 0.954,
      spendShareOfBusiness: 0.3962,
      campaignAgeDays: 47,
      spend28: 5_453,
    });
    const resolution = classifyCampaignContextV3(testNamedButDominant, null);
    expect(resolution.conflictReasons).toContain("naming_contradicts_behavior");
    expect(resolution.kind).toBe("main");
    // And the same features without the contradicting name resolve identically,
    // which is the property the supersession buys.
    const unnamed = classifyCampaignContextV3(
      { ...testNamedButDominant, campaignName: null },
      null,
    );
    expect(resolution.kind).toBe(unnamed.kind);
    expect(resolution.confidenceClass).toBe(unnamed.confidenceClass);
  });
});

describe("lifecycle family (D076)", () => {
  const base = features({
    activeCreatives: 10,
    newCreatives: 0,
    medianCreativeAgeDays: 60,
    top3SpendShare: 0.7,
    spendShareOfBusiness: 0.25,
    campaignAgeDays: 120,
  });

  it("missing lifecycle evidence keeps its weight empty and never adds confidence", () => {
    const absent = computeSignalScoresV3(base, null);
    expect(absent.lifecyclePresent).toBe(false);
    expect(absent.lifecycleMain).toBe(0);
    const sparse = computeSignalScoresV3(
      base,
      lifecycle({ statusCoverageDays: 3, activeStatusShare28: null }),
    );
    expect(sparse.lifecyclePresent).toBe(false);
    const withoutLifecycle = classifyCampaignContextV3(base, null);
    const withLifecycle = classifyCampaignContextV3(
      base,
      lifecycle({ effectiveDailyBudget: 400, accountMedianDailyBudget: 100 }),
    );
    // Present, agreeing lifecycle evidence may only strengthen the same kind.
    expect(withoutLifecycle.kind).toBe("main");
    expect(withLifecycle.kind).toBe("main");
    expect(withLifecycle.mainScore).toBeGreaterThanOrEqual(
      withoutLifecycle.mainScore - 0.0001,
    );
  });

  it("does not inflate a score when lifecycle coverage is absent", () => {
    const fourCreativeMain = features({
      activeCreatives: 4,
      newCreatives: 0,
      medianCreativeAgeDays: 30,
      top3SpendShare: 0.9,
      spendShareOfBusiness: 0.05,
      campaignAgeDays: 60,
    });
    const absent = classifyCampaignContextV3(fourCreativeMain, null);
    const presentWithZeroMainSignal = classifyCampaignContextV3(
      fourCreativeMain,
      lifecycle({
        activeStatusShare28: 0,
        effectiveDailyBudget: 75,
        accountMedianDailyBudget: 100,
      }),
    );

    expect(absent.kind).toBe("main");
    expect(absent.mainScore).toBeLessThanOrEqual(
      presentWithZeroMainSignal.mainScore,
    );
    expect(absent.confidenceClass).not.toBe("high");
  });

  it("scores below-median budget and short life as test-side evidence", () => {
    const signals = computeSignalScoresV3(
      features({ campaignAgeDays: 10 }),
      lifecycle({ effectiveDailyBudget: 20, accountMedianDailyBudget: 400 }),
    );
    expect(signals.lifecyclePresent).toBe(true);
    expect(signals.lifecycleTest).toBeGreaterThan(signals.lifecycleMain);
  });
});

describe("challenger containment (D076)", () => {
  it("stamps every resolution with the v3 version string", () => {
    expect(CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION).toBe(
      "campaign-context-resolver.v3-lifecycle-name-neutral-2026-09-01",
    );
    expect(classifyCampaignContextV3(features({}), null).resolverVersion).toBe(
      CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
    );
  });

  it("fails closed below the floors exactly like v2", () => {
    const resolution = classifyCampaignContextV3(
      features({ spend28: 10, activeDays: 2 }),
      lifecycle({}),
    );
    expect(resolution.kind).toBeNull();
    expect(resolution.confidenceClass).toBe("unknown");
    expect(resolution.evidence[0]).toContain("insufficient_evidence");
  });

  it("has no runtime-label dependence and no DB access", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "lib/creative-decision-engine/campaign-context/resolver-v3.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/meta_campaign_label/);
    expect(source).not.toMatch(/campaign-labels/);
    expect(source).not.toMatch(/@\/lib\/db/);
    // The compiled default is still v2: the runtime version constant in
    // resolver.ts must not have been bumped by the challenger work.
    const runtime = readFileSync(
      resolve(
        process.cwd(),
        "lib/creative-decision-engine/campaign-context/resolver.ts",
      ),
      "utf8",
    );
    expect(runtime).toContain(
      'CAMPAIGN_CONTEXT_RESOLVER_VERSION =\n  "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01"',
    );
    expect(runtime).not.toContain("resolver-v3");
  });
});
