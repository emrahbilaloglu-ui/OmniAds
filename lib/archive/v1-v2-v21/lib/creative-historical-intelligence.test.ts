import { describe, expect, it } from "vitest";
import type { CreativeDecisionOsInputRow } from "@/lib/creative-decision-os";
import { buildCreativeHistoricalAnalysis } from "@/lib/creative-historical-intelligence";

function buildRow(
  overrides: Partial<CreativeDecisionOsInputRow> = {},
): CreativeDecisionOsInputRow {
  return {
    creativeId: overrides.creativeId ?? "creative_1",
    name: overrides.name ?? "Creative One",
    creativeFormat: overrides.creativeFormat ?? "video",
    previewUrl: null,
    imageUrl: null,
    creativeAgeDays: overrides.creativeAgeDays ?? 12,
    spendVelocity: overrides.spendVelocity ?? 20,
    frequency: overrides.frequency ?? 1.2,
    spend: overrides.spend ?? 240,
    purchaseValue: overrides.purchaseValue ?? 720,
    roas: overrides.roas ?? 3,
    cpa: overrides.cpa ?? 24,
    ctr: overrides.ctr ?? 1.5,
    cpm: overrides.cpm ?? 12,
    cpc: overrides.cpc ?? 2,
    purchases: overrides.purchases ?? 10,
    impressions: overrides.impressions ?? 12_000,
    linkClicks: overrides.linkClicks ?? 180,
    hookRate: overrides.hookRate ?? 22,
    holdRate: overrides.holdRate ?? 10,
    video25Rate: overrides.video25Rate ?? 30,
    watchRate: overrides.watchRate ?? 18,
    video75Rate: overrides.video75Rate ?? 8,
    clickToPurchaseRate: overrides.clickToPurchaseRate ?? 5.6,
    atcToPurchaseRate: overrides.atcToPurchaseRate ?? 38,
    copyText: overrides.copyText ?? "Travel without baggage fees",
    copyVariants: overrides.copyVariants ?? ["Travel without baggage fees"],
    headlineVariants: overrides.headlineVariants ?? ["Travel light today"],
    descriptionVariants: overrides.descriptionVariants ?? [],
    objectStoryId: overrides.objectStoryId ?? null,
    effectiveObjectStoryId: overrides.effectiveObjectStoryId ?? null,
    postId: overrides.postId ?? null,
    accountId: overrides.accountId ?? "act_1",
    accountName: overrides.accountName ?? "Main Account",
    campaignId: overrides.campaignId ?? "cmp_1",
    campaignName: overrides.campaignName ?? "Campaign One",
    adSetId: overrides.adSetId ?? "adset_1",
    adSetName: overrides.adSetName ?? "Ad Set One",
    taxonomyPrimaryLabel: overrides.taxonomyPrimaryLabel ?? "UGC",
    taxonomySecondaryLabel: overrides.taxonomySecondaryLabel ?? null,
    taxonomyVisualFormat: overrides.taxonomyVisualFormat ?? "video",
    aiTags: overrides.aiTags ?? {
      hookTactic: ["travel_pack"],
      messagingAngle: ["utility"],
    },
    historicalWindows: null,
  };
}

describe("buildCreativeHistoricalAnalysis", () => {
  it("aggregates selected-period format, hook, angle, and family performance", () => {
    const analysis = buildCreativeHistoricalAnalysis({
      startDate: "2026-02-01",
      endDate: "2026-02-10",
      rows: [
        buildRow({ creativeId: "creative_1", spend: 300, purchaseValue: 900 }),
        buildRow({
          creativeId: "creative_2",
          spend: 180,
          purchaseValue: 450,
          headlineVariants: ["Travel light today"],
        }),
        buildRow({
          creativeId: "creative_3",
          creativeFormat: "image",
          taxonomyVisualFormat: "image",
          spend: 120,
          purchaseValue: 216,
          roas: 1.8,
          aiTags: {
            hookTactic: ["before_after"],
            messagingAngle: ["social_proof"],
          },
        }),
      ],
    });

    expect(analysis.selectedWindow.startDate).toBe("2026-02-01");
    expect(analysis.selectedWindow.materialRowCount).toBe(3);
    expect(analysis.summary).toContain("analysis-only");
    expect(analysis.winningFormats[0]).toMatchObject({
      label: "Video",
      creativeCount: 2,
    });
    expect(analysis.hookTrends[0]?.label).toBe("Travel Pack");
    expect(analysis.angleTrends[0]?.label).toBe("Utility");
    expect(analysis.familyPerformance[0]).toMatchObject({
      familyLabel: "Travel light today",
      creativeCount: 2,
    });
  });

  it("suppresses tiny selected-period noise and returns an empty descriptive state", () => {
    const analysis = buildCreativeHistoricalAnalysis({
      startDate: "2026-02-01",
      endDate: "2026-02-10",
      rows: [
        buildRow({
          creativeId: "tiny",
          spend: 12,
          purchaseValue: 0,
          roas: 0,
          purchases: 0,
          impressions: 1_200,
        }),
      ],
    });

    expect(analysis.selectedWindow.rowCount).toBe(1);
    expect(analysis.selectedWindow.materialRowCount).toBe(0);
    expect(analysis.winningFormats).toEqual([]);
    expect(analysis.summary).toContain("does not change deterministic Decision Signals");
  });
});
