import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mapApiRowToUiRow } from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";

vi.mock("@/hooks/use-dropdown-behavior", () => ({
  useDropdownBehavior: () => {},
}));

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { name: string }) =>
    React.createElement("div", null, `preview:${props.name}`),
}));

const {
  CreativesTableSection,
  buildCreativeTableHeatBenchmark,
  evaluateCreativeMetricPreviewHeat,
} = await import("@/components/creatives/CreativesTableSection");

function buildApiRow(overrides: Partial<MetaCreativeApiRow> = {}): MetaCreativeApiRow {
  return {
    id: "creative_degraded",
    creative_id: "cr_degraded",
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
    name: "Truth Gated Creative",
    launch_date: "2026-03-01",
    copy_text: "Buy now",
    copy_variants: ["Buy now"],
    headline_variants: ["Headline"],
    description_variants: ["Description"],
    copy_source: null,
    copy_debug_sources: [],
    unresolved_reason: null,
    preview_url: "https://example.com/preview.jpg",
    preview_source: "image_url",
    thumbnail_url: "https://example.com/thumb.jpg",
    image_url: "https://example.com/image.jpg",
    table_thumbnail_url: "https://example.com/table.jpg",
    card_preview_url: "https://example.com/card.jpg",
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
    cached_thumbnail_url: null,
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
    preview_status: "ready",
    preview_origin: "snapshot",
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
    landing_page_views: 0,
    add_to_cart: 15,
    initiate_checkout: 0,
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

describe("CreativesTableSection", () => {
  it("keeps preview heat polarity aligned with table evaluation", () => {
    const highRoasLowCpa = mapApiRowToUiRow(
      buildApiRow({
        id: "ad_high",
        creative_id: "cr_high",
        name: "High performer",
        roas: 6.2,
        cpa: 18,
        spend: 300,
        purchase_value: 1860,
        purchases: 16,
      })
    );
    const lowRoasHighCpa = mapApiRowToUiRow(
      buildApiRow({
        id: "ad_low",
        creative_id: "cr_low",
        name: "Low performer",
        roas: 0.8,
        cpa: 140,
        spend: 280,
        purchase_value: 224,
        purchases: 2,
      })
    );

    const benchmark = buildCreativeTableHeatBenchmark([highRoasLowCpa, lowRoasHighCpa]);

    expect(
      evaluateCreativeMetricPreviewHeat({
        metricId: "roas",
        row: highRoasLowCpa,
        benchmark,
      })?.tone
    ).toMatch(/positive/);
    expect(
      evaluateCreativeMetricPreviewHeat({
        metricId: "roas",
        row: lowRoasHighCpa,
        benchmark,
      })?.tone
    ).toMatch(/negative/);
    expect(
      evaluateCreativeMetricPreviewHeat({
        metricId: "costPerPurchase",
        row: highRoasLowCpa,
        benchmark,
      })?.tone
    ).toMatch(/positive/);
    expect(
      evaluateCreativeMetricPreviewHeat({
        metricId: "costPerPurchase",
        row: lowRoasHighCpa,
        benchmark,
      })?.tone
    ).toMatch(/negative/);
  });

  it("keeps the table free of decision-support columns and copy", () => {
    const row = mapApiRowToUiRow(buildApiRow());
    const html = renderToStaticMarkup(
      <CreativesTableSection
        rows={[row]}
        creativeHistoryById={new Map()}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => {}}
        selectedRowIds={[]}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onOpenRow={() => {}}
      />,
    );

    expect(html).toContain("Truth Gated Creative");
    expect(html).not.toContain("Decision Center");
    expect(html).not.toContain("Legacy only");
    expect(html).not.toContain("No V2.1 row decision");
    expect(html).not.toContain("metrics-only");
  });

  it("renders the updated heatmap legend copy for the creatives table", () => {
    const row = mapApiRowToUiRow(buildApiRow());
    const html = renderToStaticMarkup(
      <CreativesTableSection
        rows={[row]}
        creativeHistoryById={new Map()}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => {}}
        selectedRowIds={[]}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onOpenRow={() => {}}
      />,
    );

    expect(html).toContain("Above baseline");
    expect(html).toContain("Near baseline");
    expect(html).toContain("Below baseline");
    expect(html).toContain("Stronger tint = larger gap");
    expect(html).not.toContain("Above avg");
    expect(html).not.toContain("Near avg");
    expect(html).not.toContain("Below avg");
  });

  it("does not render the legacy tags column", () => {
    const row = mapApiRowToUiRow(buildApiRow());
    const html = renderToStaticMarkup(
      <CreativesTableSection
        rows={[row]}
        creativeHistoryById={new Map()}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => {}}
        selectedRowIds={[]}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onOpenRow={() => {}}
      />,
    );

    expect(html).not.toContain("Resize Tags column");
    expect(html).not.toContain(">Tags<");
  });

  it("shows ecommerce performance metrics for catalog creatives", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        id: "catalog_1",
        creative_id: "catalog_creative_1",
        name: "Catalog Creative",
        is_catalog: true,
        format: "catalog",
        creative_type: "feed_catalog",
        creative_type_label: "Catalog",
        creative_delivery_type: "catalog",
        creative_primary_type: "catalog",
        creative_primary_label: "Catalog",
        spend: 120,
        purchase_value: 480,
        roas: 4,
        cpa: 30,
        impressions: 3000,
        link_clicks: 90,
        add_to_cart: 18,
        purchases: 4,
        click_to_atc: 20,
        atc_to_purchase: 22.22,
      })
    );
    const html = renderToStaticMarkup(
      <CreativesTableSection
        rows={[row]}
        creativeHistoryById={new Map()}
        defaultCurrency="USD"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => {}}
        selectedRowIds={[]}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onOpenRow={() => {}}
      />
    );

    expect(html).toContain("Catalog Creative");
    expect(html).toContain("$480.00");
    expect(html).toContain("4.00");
    expect(html).toContain("$30.00");
    expect(html).not.toContain("Metric is not applicable for this creative format.");
  });

  it("uses creative-team score columns instead of raw media-buying metrics for the Creative teams preset", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        ai_tags: {
          offerType: ["Discount"],
          hookTactic: ["Before/After"],
          messagingAngle: ["Problem Solution"],
        },
      }),
    );
    const html = renderToStaticMarkup(
      <CreativesTableSection
        rows={[row]}
        creativeHistoryById={new Map()}
        defaultCurrency="USD"
        initialPresetName="Creative teams"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => {}}
        selectedRowIds={[]}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onOpenRow={() => {}}
      />,
    );

    expect(html).toContain("Hook score");
    expect(html).toContain("CTA score");
    expect(html).toContain("Offer score");
    expect(html).toContain("Conversion fit score");
    expect(html).toContain("Creative-friendly score view");
    expect(html).toContain("Focus tags:");
    expect(html).toContain("Offer Type");
    expect(html).not.toContain("ROAS (return on ad spend)");
  });

  it("renders creative-team preset when AI tags arrive as scalar values", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        name: null as never,
        ai_tags: {
          offerType: "Bundle",
          hookTactic: "Before/After",
        } as never,
        preview: null as never,
      }),
    );

    const html = renderToStaticMarkup(
      <CreativesTableSection
        rows={[row]}
        creativeHistoryById={new Map()}
        defaultCurrency="USD"
        initialPresetName="Creative teams"
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={() => {}}
        selectedRowIds={[]}
        onToggleRow={() => {}}
        onToggleAll={() => {}}
        onOpenRow={() => {}}
      />,
    );

    expect(html).toContain("Buy now");
    expect(html).toContain("Bundle");
    expect(html).toContain("Before/After");
    expect(html).toContain("preview:Buy now");
  });
});
