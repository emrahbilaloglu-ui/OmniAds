import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_LIMIT = process.env.GOOGLE_ADS_CAMPAIGN_CORE_LIMIT;

afterEach(() => {
  if (ORIGINAL_LIMIT == null) {
    delete process.env.GOOGLE_ADS_CAMPAIGN_CORE_LIMIT;
  } else {
    process.env.GOOGLE_ADS_CAMPAIGN_CORE_LIMIT = ORIGINAL_LIMIT;
  }
  vi.resetModules();
});

describe("buildCampaignCoreBasicQuery", () => {
  it("applies the default campaign hard cap", async () => {
    delete process.env.GOOGLE_ADS_CAMPAIGN_CORE_LIMIT;
    vi.resetModules();
    const { buildCampaignCoreBasicQuery } = await import("@/lib/google-ads/query-builders");

    const query = buildCampaignCoreBasicQuery("2026-04-01", "2026-04-01").query;

    expect(query).toContain("LIMIT 10000");
  });

  it("uses the env override for the campaign hard cap", async () => {
    process.env.GOOGLE_ADS_CAMPAIGN_CORE_LIMIT = "1234";
    vi.resetModules();
    const { buildCampaignCoreBasicQuery } = await import("@/lib/google-ads/query-builders");

    const query = buildCampaignCoreBasicQuery("2026-04-01", "2026-04-01").query;

    expect(query).toContain("LIMIT 1234");
  });
});

describe("buildMerchantCenterItemStateQuery", () => {
  it("selects the item-state fields the shopping report cannot serve", async () => {
    const { buildMerchantCenterItemStateQuery } = await import(
      "@/lib/google-ads/query-builders"
    );

    const named = buildMerchantCenterItemStateQuery();

    expect(named.resource).toBe("shopping_product");
    expect(named.query).toContain("shopping_product.merchant_center_id");
    expect(named.query).toContain("shopping_product.item_id");
    expect(named.query).toContain("shopping_product.status");
    expect(named.query).toContain("shopping_product.issues");
    expect(named.query).toContain("shopping_product.availability");
    expect(named.query).toContain("FROM shopping_product");
  });

  it("is dateless and metric-free, because item state is not a daily fact", async () => {
    const { buildMerchantCenterItemStateQuery } = await import(
      "@/lib/google-ads/query-builders"
    );

    const named = buildMerchantCenterItemStateQuery();

    expect(named.metrics).toEqual([]);
    expect(named.query).not.toContain("segments.date");
    expect(named.query).not.toContain("metrics.");
  });

  it("caps the read", async () => {
    const { buildMerchantCenterItemStateQuery } = await import(
      "@/lib/google-ads/query-builders"
    );

    expect(buildMerchantCenterItemStateQuery().query).toContain("LIMIT 5000");
    expect(buildMerchantCenterItemStateQuery(120).query).toContain("LIMIT 120");
  });
});
