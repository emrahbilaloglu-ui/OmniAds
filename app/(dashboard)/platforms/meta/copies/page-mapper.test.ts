import { describe, expect, it } from "vitest";
import { mapApiRowToCopyRow } from "@/app/(dashboard)/platforms/meta/copies/page-support";
import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";
import { DEFAULT_COPY_TOP_METRIC_IDS } from "@/components/creatives/creatives-top-section-support";

function buildCopyApiRow(overrides: Partial<MetaCopyApiRow> = {}): MetaCopyApiRow {
  return {
    id: "ad_1",
    ad_id: "ad_1",
    associated_ads_count: 1,
    creative_id: "cr_1",
    post_id: null,
    name: "Winning copy",
    campaign_id: "cmp_1",
    campaign_name: "Campaign 1",
    adset_id: "adset_1",
    adset_name: "Ad Set 1",
    account_id: "act_1",
    account_name: "Main",
    currency: "USD",
    launch_date: "2026-03-01",
    primary_text: "Buy now",
    headline: "Headline",
    description: "Description",
    copy_text: "Buy now",
    copy_variants: ["Buy now"],
    headline_variants: ["Headline"],
    description_variants: ["Description"],
    normalized_copy_key: "buy now",
    copy_source: "creative.body",
    copy_asset_type: "bundle",
    copy_debug_sources: ["creative.body"],
    unresolved_reason: null,
    preview_url: null,
    thumbnail_url: null,
    image_url: null,
    table_thumbnail_url: null,
    card_preview_url: null,
    is_catalog: false,
    preview_state: "unavailable",
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    spend: 100,
    purchase_value: 250,
    roas: 2.5,
    cpa: 10,
    cpc_link: 2,
    cpm: 12,
    ctr_all: 1.5,
    purchases: 10,
    impressions: 1000,
    link_clicks: 50,
    add_to_cart: 15,
    landing_page_views: 40,
    initiate_checkout: 12,
    leads: 3,
    messages: 2,
    video25: 500,
    video50: 300,
    video75: 150,
    video100: 80,
    click_to_purchase: 20,
    thumbstop: 12,
    first_frame_retention: 12,
    aov: 25,
    click_to_atc_ratio: 30,
    atc_to_purchase_ratio: 66.7,
    ...overrides,
  } as MetaCopyApiRow;
}

describe("copies page mapApiRowToCopyRow", () => {
  it("maps real funnel/video metrics from the API row instead of zero-filling", () => {
    const row = mapApiRowToCopyRow(buildCopyApiRow());

    expect(row.landingPageViews).toBe(40);
    expect(row.initiateCheckout).toBe(12);
    expect(row.leads).toBe(3);
    expect(row.messages).toBe(2);
    expect(row.video25).toBe(500);
    expect(row.video50).toBe(300);
    expect(row.video75).toBe(150);
    expect(row.video100).toBe(80);
  });

  it("carries no see-more field at all (the metric does not exist in the source)", () => {
    // History: the API fabricated see_more_rate = clamp(ctr_all * 1.5) and the
    // page re-fabricated it on null. The field was then nulled, and finally
    // removed end-to-end together with the shared-registry column. This guard
    // keeps the phantom from coming back under either name.
    const row = mapApiRowToCopyRow(buildCopyApiRow({ ctr_all: 1.5 }));
    expect("seeMoreRate" in row).toBe(false);
    expect("see_more_rate" in row).toBe(false);
  });

  it("uses server-computed ratios verbatim without client re-derivation", () => {
    // Inputs deliberately disagree with what a client-side re-derivation
    // would produce, so any fallback math is caught.
    const row = mapApiRowToCopyRow(
      buildCopyApiRow({
        click_to_atc_ratio: 30,
        click_to_purchase: 20,
        atc_to_purchase_ratio: 66.7,
        link_clicks: 999,
        add_to_cart: 1,
        purchases: 1,
      }),
    );

    expect(row.clickToAddToCart).toBe(30);
    expect(row.clickToPurchase).toBe(20);
    expect(row.atcToPurchaseRatio).toBe(66.7);
  });

  it("keeps the phantom see-more metric out of the copies default metric list", () => {
    expect(DEFAULT_COPY_TOP_METRIC_IDS).not.toContain("seeMoreRate");
  });

  it("maps only a real server messaging angle and does not invent one", () => {
    const tagged = mapApiRowToCopyRow(
      buildCopyApiRow({ ai_tags: { messagingAngle: ["", "Social Proof"] } }),
    );
    const untagged = mapApiRowToCopyRow(buildCopyApiRow({ ai_tags: {} }));

    expect(tagged.copyAngle).toBe("Social Proof");
    expect(untagged.copyAngle).toBeNull();
  });

  // LAW: the row carries the tags the server actually supplied. `aiTags: {}` was
  // hardcoded, so a copy the engine had tagged still described itself as
  // untagged — and the Angle column and angle roll-up read an em dash for data
  // that existed on the sibling Assets tab.
  it("carries the server's ai_tags onto the mapped row rather than an empty map", () => {
    const row = mapApiRowToCopyRow(
      buildCopyApiRow({ ai_tags: { messagingAngle: ["Promotional"], offerType: ["Discount"] } }),
    );

    expect(row.aiTags).toEqual({
      messagingAngle: ["Promotional"],
      offerType: ["Discount"],
    });
  });

  it("keeps an untagged row's angle unknown instead of guessing", () => {
    const row = mapApiRowToCopyRow(buildCopyApiRow({ ai_tags: {} }));

    expect(row.aiTags).toEqual({});
    expect(row.copyAngle).toBeNull();
  });

  /**
   * This used to assert "Ads stays unavailable because the copies contract has
   * no aggregate ad count". The contract HAS one now: `?groupBy=copy` merges
   * the per-ad rows and the route publishes `associated_ads_count` from inside
   * each bucket, because after the merge the client can no longer see the ads.
   * The mapper's job is to carry that number, and only that number.
   */
  it("carries the served ad count instead of deriving one", () => {
    const row = mapApiRowToCopyRow(
      buildCopyApiRow({ associated_ads_count: 7 }),
    );

    expect(row.associatedAdsCount).toBe(7);
    expect(row.associatedAdsCountAvailable).toBe(true);
  });

  it("leaves Ads unavailable when the server sent no count", () => {
    // An absent count is an uncounted set. The row it arrived on is one row —
    // reading 1 off that would be the exact substitution that made a copy on
    // ten ads render "Ads = 1".
    const missing = mapApiRowToCopyRow(
      buildCopyApiRow({ associated_ads_count: null }),
    );
    expect(missing.associatedAdsCountAvailable).toBe(false);

    // 0 is not a measured zero here either: no served line runs on zero ads,
    // so it can only be a failed count.
    const zero = mapApiRowToCopyRow(
      buildCopyApiRow({ associated_ads_count: 0 }),
    );
    expect(zero.associatedAdsCountAvailable).toBe(false);
  });
});
