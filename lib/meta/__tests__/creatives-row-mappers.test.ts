import { describe, it, expect } from "vitest";
import {
  r2,
  toISODate,
  nDaysAgo,
  groupRows,
  sortRows,
  hasRetainedZeroSpendActivity,
  hasSuspiciousMissingCatalogRevenueMetrics,
  hasSuspiciousMissingFunnelMetrics,
  mergeCreativeData,
  toRawRow,
} from "@/lib/meta/creatives-row-mappers";
import type { RawCreativeRow } from "@/lib/meta/creatives-types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<RawCreativeRow> = {}): RawCreativeRow {
  return {
    id: "row_1",
    creative_id: "cre_1",
    object_story_id: null,
    effective_object_story_id: null,
    post_id: null,
    associated_ads_count: 1,
    account_id: "act_123",
    account_name: "Test Account",
    campaign_id: "camp_1",
    campaign_name: "Campaign",
    currency: "USD",
    adset_id: "adset_1",
    adset_name: "Adset",
    name: "Creative Name",
    format: "image",
    creative_type: "feed",
    creative_type_label: "Feed",
    creative_delivery_type: "standard",
    creative_visual_format: "image",
    creative_primary_type: "standard",
    creative_primary_label: "Standard",
    creative_secondary_type: null,
    creative_secondary_label: null,
    classification_signals: null,
    tags: [],
    launch_date: "2025-01-01",
    spend: 100,
    impressions: 10000,
    clicks: 260,
    link_clicks: 200,
    landing_page_views: 180,
    thruplay_actions: 0,
    view_content: 0,
    post_engagement: 0,
    add_to_cart: 20,
    initiate_checkout: 10,
    purchases: 5,
    purchase_value: 500,
    leads: 0,
    messages: 0,
    thumbstop: 30,
    video25: 20,
    video50: 15,
    video75: 10,
    video100: 5,
    ctr_all: 2,
    cpm: 10,
    cpc_link: 0.5,
    cpa: 20,
    click_to_atc: 0.1,
    atc_to_purchase: 0.25,
    roas: 5,
    thumbnail_url: null,
    image_url: null,
    table_thumbnail_url: null,
    card_preview_url: null,
    preview_url: null,
    preview_source: null,
    preview_state: "unavailable",
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    is_catalog: false,
    copy_text: null,
    copy_variants: [],
    headline_variants: [],
    description_variants: [],
    copy_source: null,
    copy_debug_sources: [],
    unresolved_reason: null,
    ai_tags: {},
    ...overrides,
  };
}

function mapInsight(overrides: Parameters<typeof toRawRow>[0]) {
  return toRawRow(
    {
      ad_id: "ad_1",
      ad_name: "Test Ad",
      spend: "1",
      clicks: "0",
      impressions: "0",
      reach: "0",
      date_start: "2026-05-13",
      ...overrides,
    },
    undefined,
    { id: "act_123", name: "Test Account", currency: "USD" },
    new Map(),
    new Map(),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("r2", () => {
  it("rounds to 2 decimal places", () => {
    expect(r2(1.234567)).toBe(1.23);
    expect(r2(1.235)).toBe(1.24);
    expect(r2(0)).toBe(0);
  });
});

describe("toISODate", () => {
  it("returns YYYY-MM-DD formatted string", () => {
    const date = new Date("2025-06-15T12:00:00Z");
    const result = toISODate(date);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("nDaysAgo", () => {
  it("returns a date approximately N days before now", () => {
    const now = Date.now();
    const result = nDaysAgo(7);
    const diff = now - result.getTime();
    const diffDays = diff / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });
});

describe("hasSuspiciousMissingFunnelMetrics", () => {
  it("returns false for empty rows", () => {
    expect(hasSuspiciousMissingFunnelMetrics([])).toBe(false);
  });

  it("returns false when rows have funnel metrics", () => {
    const rows = [
      makeRow({ spend: 200, purchases: 5, add_to_cart: 10 }),
      makeRow({ spend: 150, purchases: 3, add_to_cart: 8 }),
    ];
    expect(hasSuspiciousMissingFunnelMetrics(rows)).toBe(false);
  });

  it("returns true when rows have link_clicks and purchases but zero landing_page_views and initiate_checkout", () => {
    // Mirrors the snapshot corruption pattern: funnel middle is missing
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `row_${i}`, link_clicks: 100, purchases: 3, landing_page_views: 0, initiate_checkout: 0 })
    );
    expect(hasSuspiciousMissingFunnelMetrics(rows)).toBe(true);
  });

  it("returns false when fewer than 5 rows", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      makeRow({ id: `row_${i}`, link_clicks: 100, purchases: 3, landing_page_views: 0, initiate_checkout: 0 })
    );
    expect(hasSuspiciousMissingFunnelMetrics(rows)).toBe(false);
  });
});

describe("toRawRow funnel metrics", () => {
  it("maps video_thruplay_watched_actions into thruplay_actions", () => {
    const row = mapInsight({ video_thruplay_watched_actions: [{ action_type: "video_view", value: "42" }] });

    expect(row?.thruplay_actions).toBe(42);
  });

  it("defaults missing video_thruplay_watched_actions to zero", () => {
    const row = mapInsight({});

    expect(row?.thruplay_actions).toBe(0);
  });

  it("maps view_content actions into view_content", () => {
    const row = mapInsight({ actions: [{ action_type: "view_content", value: "17" }] });

    expect(row?.view_content).toBe(17);
  });

  it("maps pixel view_content aliases into view_content", () => {
    const row = mapInsight({ actions: [{ action_type: "offsite_conversion.fb_pixel_view_content", value: "9" }] });

    expect(row?.view_content).toBe(9);
  });

  it("maps post_engagement actions into post_engagement", () => {
    const row = mapInsight({ actions: [{ action_type: "post_engagement", value: "55" }] });

    expect(row?.post_engagement).toBe(55);
  });

  it("defaults missing ThruPlay, view_content, and post_engagement signals to zero", () => {
    const row = mapInsight({ actions: [] });

    expect(row?.thruplay_actions).toBe(0);
    expect(row?.view_content).toBe(0);
    expect(row?.post_engagement).toBe(0);
  });

  it("retains zero-spend rows when only ThruPlay activity is present", () => {
    expect(
      hasRetainedZeroSpendActivity({
        impressions: 0,
        reach: 0,
        clicks: 0,
        effectiveLinkClicks: 0,
        outboundClicks: 0,
        purchases: 0,
        purchaseValue: 0,
        landingPageViews: 0,
        thruplayActions: 42,
        viewContent: 0,
        postEngagement: 0,
        addToCart: 0,
        initiateCheckout: 0,
        allActionTotal: 0,
        video3sViews: 0,
        video25Views: 0,
        video50Views: 0,
        video75Views: 0,
        video100Views: 0,
      }),
    ).toBe(true);

    const row = mapInsight({
      spend: "0",
      video_thruplay_watched_actions: [{ action_type: "video_view", value: "42" }],
    });
    expect(row?.thruplay_actions).toBe(42);
  });
});

describe("hasSuspiciousMissingCatalogRevenueMetrics", () => {
  it("returns false when there are no rows", () => {
    expect(hasSuspiciousMissingCatalogRevenueMetrics([])).toBe(false);
  });

  it("returns false for healthy catalog rows", () => {
    expect(
      hasSuspiciousMissingCatalogRevenueMetrics([
        makeRow({ is_catalog: true, purchases: 2, purchase_value: 240, roas: 2.4 }),
      ])
    ).toBe(false);
  });

  it("returns true when a catalog row has purchases but no revenue signal", () => {
    expect(
      hasSuspiciousMissingCatalogRevenueMetrics([
        makeRow({ is_catalog: true, spend: 120, purchases: 3, purchase_value: 0, roas: 0 }),
      ])
    ).toBe(true);
  });
});

describe("groupRows", () => {
  it("returns rows unchanged for groupBy=adName", () => {
    const rows = [makeRow({ id: "a" }), makeRow({ id: "b" })];
    const result = groupRows(rows, "adName", new Map());
    expect(result).toHaveLength(2);
  });

  it("groups rows by creative name+format for groupBy=creative", () => {
    const rows = [
      makeRow({ id: "a1", creative_id: "cre_1", name: "Creative A", format: "image", spend: 100 }),
      makeRow({ id: "a2", creative_id: "cre_1", name: "Creative A", format: "image", spend: 200 }),
      makeRow({ id: "b1", creative_id: "cre_2", name: "Creative B", format: "image", spend: 50 }),
    ];
    const result = groupRows(rows, "creative", new Map());
    expect(result).toHaveLength(2);

    const groupA = result.find((r) => r.name === "Creative A");
    expect(groupA?.spend).toBeCloseTo(300);
    expect(groupA?.associated_ads_count).toBe(2);
  });

  it("counts distinct real ad ids for grouped creative placement totals", () => {
    const rows = [
      makeRow({ id: "creative_1", real_ad_id: "ad_1", creative_id: "cre_1", name: "Creative A", spend: 100 }),
      makeRow({ id: "creative_1", real_ad_id: "ad_1", creative_id: "cre_1", name: "Creative A", spend: 50 }),
      makeRow({ id: "creative_1", real_ad_id: "ad_2", creative_id: "cre_2", name: "Creative A", spend: 25 }),
    ];

    const result = groupRows(rows, "creative", new Map());

    expect(result).toHaveLength(1);
    expect(result[0].associated_ads_count).toBe(2);
  });

  it("sums impressions and purchases across grouped rows", () => {
    const rows = [
      makeRow({ id: "a1", name: "Ad X", format: "image", impressions: 5000, purchases: 3, spend: 100 }),
      makeRow({ id: "a2", name: "Ad X", format: "image", impressions: 3000, purchases: 2, spend: 80 }),
    ];
    const result = groupRows(rows, "creative", new Map());
    expect(result).toHaveLength(1);
    expect(result[0].impressions).toBe(8000);
    expect(result[0].purchases).toBe(5);
  });

  it("sums ThruPlay, view_content, and post_engagement across grouped rows", () => {
    const rows = [
      makeRow({
        id: "a1",
        name: "Ad X",
        format: "image",
        thruplay_actions: 40,
        view_content: 10,
        post_engagement: 25,
      }),
      makeRow({
        id: "a2",
        name: "Ad X",
        format: "image",
        thruplay_actions: 2,
        view_content: 7,
        post_engagement: 30,
      }),
    ];
    const result = groupRows(rows, "creative", new Map());

    expect(result[0].thruplay_actions).toBe(42);
    expect(result[0].view_content).toBe(17);
    expect(result[0].post_engagement).toBe(55);
  });

  it("keeps canonical clicks separate from link_clicks when grouping", () => {
    const rows = [
      makeRow({ id: "a1", name: "Ad X", format: "image", clicks: 120, link_clicks: 80 }),
      makeRow({ id: "a2", name: "Ad X", format: "image", clicks: 90, link_clicks: 60 }),
    ];
    const result = groupRows(rows, "creative", new Map());
    expect(result).toHaveLength(1);
    expect(result[0].clicks).toBe(210);
    expect(result[0].link_clicks).toBe(140);
  });

  it("computes grouped frequency from aggregate impressions and reach", () => {
    const rows = [
      makeRow({ id: "a1", name: "Ad X", format: "image", impressions: 100, reach: 100, frequency: 10 }),
      makeRow({ id: "a2", name: "Ad X", format: "image", impressions: 300, reach: 100, frequency: 1 }),
    ];

    const result = groupRows(rows, "creative", new Map());

    expect(result[0].impressions).toBe(400);
    expect(result[0].reach).toBe(200);
    expect(result[0].frequency).toBe(2);
  });

  it("groups by adset_id for groupBy=adset", () => {
    const rows = [
      makeRow({ id: "a1", adset_id: "adset_A", name: "Ad 1", spend: 100 }),
      makeRow({ id: "a2", adset_id: "adset_A", name: "Ad 2", spend: 150 }),
      makeRow({ id: "b1", adset_id: "adset_B", name: "Ad 3", spend: 200 }),
    ];
    const result = groupRows(rows, "adSet", new Map());
    expect(result).toHaveLength(2);

    const adsetA = result.find((r) => r.adset_id === "adset_A");
    expect(adsetA?.spend).toBeCloseTo(250);
  });

  it("groups daily rows by real ad id for groupBy=ad", () => {
    const rows = [
      makeRow({ id: "ad_1", creative_id: "cre_1", name: "Placement A", spend: 100, impressions: 1000, purchases: 1 }),
      makeRow({ id: "ad_1", creative_id: "cre_1", name: "Placement A", spend: 50, impressions: 500, purchases: 2 }),
      makeRow({ id: "ad_2", creative_id: "cre_2", name: "Placement A", spend: 25, impressions: 250, purchases: 0 }),
    ];

    const result = groupRows(rows, "ad", new Map());

    expect(result).toHaveLength(2);
    const ad1 = result.find((row) => row.id === "ad_1");
    expect(ad1?.name).toBe("Placement A");
    expect(ad1?.spend).toBeCloseTo(150);
    expect(ad1?.impressions).toBe(1500);
    expect(ad1?.purchases).toBe(3);
    expect(ad1?.associated_ads_count).toBe(1);
  });

  it("marks grouped rows as Mixed when underlying primary types conflict", () => {
    const rows = [
      makeRow({
        id: "a1",
        creative_id: "cre_1",
        name: "Creative A",
        format: "image",
        creative_primary_type: "carousel",
        creative_primary_label: "Carousel",
        creative_visual_format: "carousel",
      }),
      makeRow({
        id: "a2",
        creative_id: "cre_1",
        name: "Creative A",
        format: "image",
        creative_primary_type: "standard",
        creative_primary_label: "Standard",
        creative_visual_format: "image",
      }),
    ];

    const result = groupRows(rows, "creative", new Map());

    expect(result).toHaveLength(1);
    expect(result[0].creative_primary_type).toBe("mixed");
    expect(result[0].creative_primary_label).toBe("Mixed");
    expect(result[0].creative_secondary_type).toBeNull();
    expect(result[0].creative_type).toBe("feed");
  });
});

describe("mergeCreativeData", () => {
  it("preserves base catalog signals when detail enrichment is poorer", () => {
    const merged = mergeCreativeData(
      {
        object_story_spec: {
          template_data: {
            template_url: "https://example.com/template",
          },
        },
        asset_feed_spec: {
          catalog_id: "catalog_1",
          product_set_id: "ps_1",
          images: [{ image_url: "https://example.com/base.jpg" }],
        },
      } as never,
      {
        object_story_spec: {
          link_data: {
            message: "detail only",
          },
        },
        asset_feed_spec: {
          images: [],
        },
      } as never
    );

    expect(merged?.object_story_spec?.template_data).toEqual({
      template_url: "https://example.com/template",
    });
    expect(merged?.asset_feed_spec?.catalog_id).toBe("catalog_1");
    expect(merged?.asset_feed_spec?.product_set_id).toBe("ps_1");
    expect(merged?.asset_feed_spec?.images).toHaveLength(1);
  });
});

describe("sortRows", () => {
  it("sorts by roas descending", () => {
    const rows = [
      makeRow({ id: "a", roas: 2, spend: 100 }),
      makeRow({ id: "b", roas: 5, spend: 100 }),
      makeRow({ id: "c", roas: 1, spend: 100 }),
    ];
    const sorted = sortRows(rows, "roas");
    expect(sorted[0].roas).toBe(5);
    expect(sorted[2].roas).toBe(1);
  });

  it("sorts by spend descending", () => {
    const rows = [
      makeRow({ id: "a", spend: 50 }),
      makeRow({ id: "b", spend: 200 }),
      makeRow({ id: "c", spend: 100 }),
    ];
    const sorted = sortRows(rows, "spend");
    expect(sorted[0].spend).toBe(200);
    expect(sorted[2].spend).toBe(50);
  });

  it("does not mutate original array", () => {
    const rows = [
      makeRow({ id: "a", spend: 50 }),
      makeRow({ id: "b", spend: 200 }),
    ];
    const original = [...rows];
    sortRows(rows, "spend");
    expect(rows[0].id).toBe(original[0].id);
  });
});
