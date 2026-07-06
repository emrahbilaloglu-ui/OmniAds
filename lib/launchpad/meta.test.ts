import { describe, expect, it } from "vitest";
import {
  amountFromMinorUnits,
  amountToMinorUnits,
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
} from "@/lib/launchpad/meta";

describe("normalizeMetaLaunchPayload", () => {
  it("produces a complete safe payload from garbage input", () => {
    const payload = normalizeMetaLaunchPayload("not-an-object");

    expect(payload.mode).toBe("new_campaign");
    expect(payload.currencyCode).toBeNull();
    expect(payload.campaign).toEqual({
      name: "",
      objective: "OUTCOME_SALES",
      smartPromotionType: null,
      specialAdCategories: [],
    });
    expect(payload.budget.mode).toBe("CBO");
    expect(payload.creativeIds).toEqual([]);
    expect(payload.adSets).toEqual([]);
  });

  it("normalizes currencyCode to uppercase ISO and rejects non-ISO values", () => {
    expect(normalizeMetaLaunchPayload({ currencyCode: "try" }).currencyCode).toBe("TRY");
    expect(normalizeMetaLaunchPayload({ currencyCode: " usd " }).currencyCode).toBe("USD");
    expect(normalizeMetaLaunchPayload({ currencyCode: "US" }).currencyCode).toBeNull();
    expect(normalizeMetaLaunchPayload({ currencyCode: 42 }).currencyCode).toBeNull();
  });

  it("forces the sales objective regardless of input", () => {
    const payload = normalizeMetaLaunchPayload({
      campaign: { name: "C", objective: "OUTCOME_TRAFFIC" },
    });
    expect(payload.campaign.objective).toBe("OUTCOME_SALES");
  });

  it("whitelists optimization goal and custom event type per ad set", () => {
    const payload = normalizeMetaLaunchPayload({
      adSets: [
        { optimizationGoal: "VALUE", customEventType: "ADD_TO_CART" },
        { optimizationGoal: "REACH", customEventType: "SIGN_UP" },
      ],
    });

    expect(payload.adSets[0]?.optimizationGoal).toBe("VALUE");
    expect(payload.adSets[0]?.customEventType).toBe("ADD_TO_CART");
    // Unknown values collapse to the purchase defaults, never pass through.
    expect(payload.adSets[1]?.optimizationGoal).toBe("OFFSITE_CONVERSIONS");
    expect(payload.adSets[1]?.customEventType).toBe("PURCHASE");
  });

  it("assigns stable fallback clientIds and clamps targeting ages", () => {
    const payload = normalizeMetaLaunchPayload({
      adSets: [{ targeting: { ageMin: 5, ageMax: 99 } }, { clientId: "custom" }],
    });

    expect(payload.adSets[0]?.clientId).toBe("adset-1");
    expect(payload.adSets[1]?.clientId).toBe("custom");
    expect(payload.adSets[0]?.targeting.ageMin).toBe(13);
    expect(payload.adSets[0]?.targeting.ageMax).toBe(65);
    expect(payload.adSets[0]?.targeting.countries).toEqual(["US"]);
  });

  it("merges creatives from creativeIds and creative refs, deduplicating by id", () => {
    const payload = normalizeMetaLaunchPayload({
      creativeIds: ["cr_1", "cr_2"],
      creatives: [{ creativeId: "cr_2", sourceAdId: "ad_2", name: "Ref name" }],
      sourceAdIds: { cr_1: "ad_1" },
    });

    expect(payload.creativeIds).toEqual(["cr_1", "cr_2"]);
    expect(payload.creatives).toEqual([
      { creativeId: "cr_1", sourceAdId: "ad_1", name: null },
      { creativeId: "cr_2", sourceAdId: "ad_2", name: "Ref name" },
    ]);
  });

  it("whitelists the budget bid strategy", () => {
    const capped = normalizeMetaLaunchPayload({
      budget: { mode: "CBO", bidStrategy: "COST_CAP", amountMinor: 5000.9 },
    });
    expect(capped.budget.bidStrategy).toBe("COST_CAP");
    expect(capped.budget.amountMinor).toBe(5000);

    const unknown = normalizeMetaLaunchPayload({
      budget: { mode: "CBO", bidStrategy: "MAX_DELIVERY", amountMinor: 5000 },
    });
    expect(unknown.budget.bidStrategy).toBe("LOWEST_COST_WITHOUT_CAP");
  });
});

describe("normalizeMetaAddToExistingPayload", () => {
  it("builds targets from the flat legacy fields when the array is absent", () => {
    const payload = normalizeMetaAddToExistingPayload({
      targetCampaignId: "cmp_1",
      targetAdsetId: "adset_1",
      targetCampaignName: "Campaign",
    });

    expect(payload.mode).toBe("add_to_existing");
    expect(payload.targets).toEqual([
      {
        targetCampaignId: "cmp_1",
        targetAdsetId: "adset_1",
        targetCampaignName: "Campaign",
        targetAdsetName: null,
      },
    ]);
    expect(payload.targetCampaignId).toBe("cmp_1");
  });

  it("deduplicates targets by campaign/adset pair", () => {
    const payload = normalizeMetaAddToExistingPayload({
      targets: [
        { campaignId: "cmp_1", adsetId: "adset_1" },
        { targetCampaignId: "cmp_1", targetAdsetId: "adset_1", targetAdsetName: "Kept" },
        { targetCampaignId: "cmp_2", targetAdsetId: "adset_2" },
      ],
    });

    expect(payload.targets).toHaveLength(2);
    expect(payload.targets[0]?.targetAdsetName).toBe("Kept");
  });

  it("whitelists copyMode and defaults to rebuild_creative", () => {
    expect(
      normalizeMetaAddToExistingPayload({ copyMode: "reuse_creative" }).copyMode,
    ).toBe("reuse_creative");
    expect(normalizeMetaAddToExistingPayload({ copyMode: "anything" }).copyMode).toBe(
      "rebuild_creative",
    );
  });

  it("applies name overrides from the names record", () => {
    const payload = normalizeMetaAddToExistingPayload({
      creativeIds: ["cr_1", "cr_2"],
      names: { cr_1: "Override" },
    });

    expect(payload.creatives.find((c) => c.creativeId === "cr_1")?.nameOverride).toBe(
      "Override",
    );
    expect(payload.creatives.find((c) => c.creativeId === "cr_2")?.nameOverride).toBeNull();
    expect(payload.names).toEqual({ cr_1: "Override" });
  });
});

describe("minor unit conversion", () => {
  it("round-trips amounts through minor units", () => {
    expect(amountToMinorUnits("12.34")).toBe(1234);
    expect(amountFromMinorUnits(1234)).toBe("12.34");
  });
});
