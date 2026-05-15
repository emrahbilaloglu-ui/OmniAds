import { describe, expect, it } from "vitest";
import {
  buildMetaCreativeApiRow,
  buildMetaCreativeApiRowLightweight,
} from "@/lib/meta/creatives-service-support";
import type { RawCreativeRow } from "@/lib/meta/creatives-types";

function buildRawRow(overrides: Partial<RawCreativeRow> = {}): RawCreativeRow {
  return {
    id: "ad_1",
    creative_id: "cr_1",
    object_story_id: null,
    effective_object_story_id: null,
    post_id: null,
    associated_ads_count: 1,
    account_id: "act_1",
    account_name: "Main",
    campaign_id: "cmp_1",
    campaign_name: "Campaign 1",
    adset_id: "adset_1",
    adset_name: "Ad Set 1",
    currency: "USD",
    name: "Creative 1",
    launch_date: "2026-03-01",
    copy_text: "Buy now",
    copy_variants: ["Buy now"],
    headline_variants: ["Headline"],
    description_variants: ["Description"],
    copy_source: "creative.body",
    copy_debug_sources: ["creative.body"],
    unresolved_reason: null,
    preview_url: "https://example.com/preview.jpg",
    preview_source: "image_url",
    thumbnail_url: "https://example.com/thumb.jpg",
    image_url: "https://example.com/image.jpg",
    table_thumbnail_url: "https://example.com/table.jpg",
    card_preview_url: "https://example.com/card.jpg",
    preview_contract_version: "v5",
    preview_manifest: {
      table_src: "https://example.com/table.jpg",
      card_src: "https://example.com/card.jpg",
      detail_image_src: "https://example.com/image.jpg",
      detail_video_src: null,
      render_state: "renderable_high_quality",
      card_state: "ready",
      waiting_reason: null,
      table_source_kind: "thumbnail_static",
      card_source_kind: "non_thumbnail_static",
      resolution_class: "high_res",
      thumbnail_like: false,
      source_reason: "card_prefer_non_thumbnail",
      needs_card_enrichment: false,
      live_html_available: true,
    },
    card_preview_source_kind: "non_thumbnail_static",
    card_preview_resolution_class: "high_res",
    table_preview_source_kind: "thumbnail_static",
    preview_source_reason: "card_prefer_non_thumbnail",
    is_catalog: false,
    preview_state: "preview",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      video_url: null,
      poster_url: null,
      source: "image_url",
      is_catalog: false,
    },
    tags: [],
    ai_tags: {},
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
    taxonomy_version: "v2",
    taxonomy_source: "deterministic",
    taxonomy_reconciled_by_video_evidence: false,
    spend: 100,
    purchase_value: 250,
    roas: 2.5,
    cpa: 10,
    cpc_link: 2,
    cpm: 12,
    ctr_all: 1.5,
    purchases: 10,
    impressions: 1000,
    clicks: 75,
    link_clicks: 50,
    landing_page_views: 20,
    thruplay_actions: 12,
    view_content: 18,
    post_engagement: 24,
    add_to_cart: 15,
    initiate_checkout: 5,
    leads: 0,
    messages: 0,
    thumbstop: 12,
    click_to_atc: 20,
    atc_to_purchase: 66,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    ...overrides,
  };
}

describe("buildMetaCreativeApiRowLightweight", () => {
  it("preserves expanded funnel metrics from persisted rows", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        thruplay_actions: 12.4,
        view_content: 18.6,
        post_engagement: 24.2,
      }),
      includeDebugFields: false,
    });

    expect(row.thruplay_actions).toBe(12);
    expect(row.view_content).toBe(19);
    expect(row.post_engagement).toBe(24);
  });

  it("reuses persisted preview metadata without rebuilding derived preview fields", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow(),
      includeDebugFields: false,
    });

    expect(row.preview_manifest?.card_src).toBe("https://example.com/card.jpg");
    expect(row.preview_status).toBe("ready");
    expect(row.preview_origin).toBe("snapshot");
    expect(row.thumbnail_url).toBe("https://example.com/table.jpg");
    expect(row.image_url).toBe("https://example.com/card.jpg");
    expect(row.taxonomy_source).toBe("deterministic");
  });

  it("derives AI tags from metadata and extracted copy when source tags are missing", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        name: "3 ways to refresh your kitchen",
        copy_text:
          "Are you ready for before and after results? Save 20% today only with free shipping during our summer sale.",
        copy_variants: [
          "Are you ready for before and after results? Save 20% today only with free shipping during our summer sale.",
        ],
        headline_variants: ["3 ways to refresh your kitchen"],
        description_variants: ["Shop the full collection now."],
      }),
      includeDebugFields: false,
    });

    expect(row.ai_tags.assetType).toContain("Static Image");
    expect(row.ai_tags.offerType).toEqual(
      expect.arrayContaining(["Discount", "Free Shipping", "Limited Time"])
    );
    expect(row.ai_tags.seasonality).toContain("Summer");
    expect(row.ai_tags.headlineTactic).toContain("Number Headline");
    expect(row.ai_tags.hookTactic).toContain("Before/After");
    expect(row.ai_tags.messagingAngle).toContain("Promotional");
  });

  it("keeps explicit AI tags authoritative while filling missing keys", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        copy_text: "Save 15% on your first order today.",
        copy_variants: ["Save 15% on your first order today."],
        headline_variants: ["How to get started faster"],
        ai_tags: {
          offerType: ["Bundle"],
          messagingAngle: ["Social Proof"],
        },
      }),
      includeDebugFields: false,
    });

    expect(row.ai_tags.offerType).toEqual(["Bundle"]);
    expect(row.ai_tags.messagingAngle).toEqual(["Social Proof"]);
    expect(row.ai_tags.assetType).toContain("Static Image");
    expect(row.ai_tags.headlineTactic).toContain("How To");
  });

  it("stays conservative for ambiguous creative text instead of over-tagging", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        name: "Clean hydration ritual",
        copy_text: "Shop our favorite hydration essentials.",
        copy_variants: ["Shop our favorite hydration essentials."],
        headline_variants: ["Clean hydration ritual"],
        description_variants: ["A simple daily routine."],
      }),
      includeDebugFields: false,
    });

    expect(row.ai_tags.assetType).toContain("Static Image");
    expect(row.ai_tags.visualFormat).toContain("Image");
    expect(row.ai_tags.offerType).toEqual(["No Explicit Offer"]);
    expect(row.ai_tags.seasonality).toBeUndefined();
    expect(row.ai_tags.headlineTactic).toBeUndefined();
    expect(row.ai_tags.hookTactic).toBeUndefined();
    expect(row.ai_tags.messagingAngle).toBeUndefined();
    expect(row.ai_tags.intendedAudience).toBeUndefined();
  });

  it("uses deterministic visual format when media metadata is explicit", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        format: "video",
        creative_type: "video",
        creative_visual_format: "video",
        creative_primary_type: "video",
        creative_primary_label: "Video",
        preview: {
          render_mode: "video",
          image_url: "https://example.com/poster.jpg",
          video_url: "https://example.com/video.mp4",
          poster_url: "https://example.com/poster.jpg",
          source: "image_url",
          is_catalog: false,
        },
        copy_text: "Watch how it works.",
        copy_variants: ["Watch how it works."],
        headline_variants: ["See it in action"],
      }),
      includeDebugFields: false,
    });

    expect(row.ai_tags.assetType).toContain("Video");
    expect(row.ai_tags.visualFormat).toContain("Video");
  });

  it("normalizes explicit AI tag aliases into canonical filter values", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        ai_tags: {
          visualFormat: ["product_focus"],
          messagingAngle: ["social_proof"],
          offerType: ["limited_offer"],
          hookTactic: ["before_after"],
        },
      }),
      includeDebugFields: false,
    });

    expect(row.ai_tags.visualFormat).toEqual(["Product Focus"]);
    expect(row.ai_tags.messagingAngle).toEqual(["Social Proof"]);
    expect(row.ai_tags.offerType).toEqual(["Limited Time"]);
    expect(row.ai_tags.hookTactic).toEqual(["Before/After"]);
  });

  it("falls back to headline-led hooks when body copy is generic", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        copy_text: "Shop now.",
        copy_variants: ["Shop now."],
        headline_variants: ["5 reasons creators switch"],
      }),
      includeDebugFields: false,
    });

    expect(row.ai_tags.headlineTactic).toContain("Number Headline");
    expect(row.ai_tags.hookTactic).toContain("List Hook");
  });

  it("rebuilds commerce metrics when persisted metadata only has spend, purchases, and roas", () => {
    const row = buildMetaCreativeApiRowLightweight({
      row: buildRawRow({
        is_catalog: true,
        spend: 120,
        purchases: 4,
        purchase_value: 0,
        roas: 3.5,
        cpa: 0,
        cpc_link: 0,
        cpm: 0,
        ctr_all: 0,
        click_to_atc: 0,
        atc_to_purchase: 0,
        impressions: 2400,
        link_clicks: 96,
        add_to_cart: 18,
      }),
      includeDebugFields: false,
    });

    expect(row.purchase_value).toBe(420);
    expect(row.roas).toBe(3.5);
    expect(row.cpa).toBe(30);
    expect(row.cpc_link).toBe(1.25);
    expect(row.cpm).toBe(50);
    expect(row.ctr_all).toBe(4);
    expect(row.click_to_atc).toBe(18.75);
    expect(row.atc_to_purchase).toBe(22.22);
  });
});

describe("buildMetaCreativeApiRow", () => {
  it("preserves expanded funnel metrics from live rows before warehouse payload persistence", () => {
    const row = buildMetaCreativeApiRow({
      row: buildRawRow({
        thruplay_actions: 9.7,
        view_content: 15.2,
        post_engagement: 27.8,
      }),
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    });

    expect(row.thruplay_actions).toBe(10);
    expect(row.view_content).toBe(15);
    expect(row.post_engagement).toBe(28);
  });
});
