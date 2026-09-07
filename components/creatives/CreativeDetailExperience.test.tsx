import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mapApiRowToUiRow } from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";

const observedQueries = vi.hoisted(() => ({ keys: [] as unknown[][] }));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
  useQuery: (input: { queryKey?: unknown[] }) => {
    if (input.queryKey) observedQueries.keys.push(input.queryKey);
    return {
      data: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: () => React.createElement("div", null, "date-range-picker"),
}));

const { CreativeDetailExperience } =
  await import("@/components/creatives/CreativeDetailExperience");

function buildApiRow(
  overrides: Partial<MetaCreativeApiRow> = {},
): MetaCreativeApiRow {
  return {
    id: "creative_1",
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
    name: "Creative Detail Row",
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
      live_html_available: false,
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

function renderDetail(row = mapApiRowToUiRow(buildApiRow())) {
  return renderToStaticMarkup(
    <CreativeDetailExperience
      businessId="biz"
      row={row}
      allRows={[row]}
      creativeHistoryById={new Map()}
      open
      notes="Existing note"
      dateRange={{
        preset: "last30Days",
        customStart: "2026-04-01",
        customEnd: "2026-04-10",
        lastDays: 30,
        sinceDate: "",
      }}
      defaultCurrency="USD"
      onOpenChange={() => {}}
      onNotesChange={() => {}}
      onDateRangeChange={() => {}}
    />,
  );
}

describe("CreativeDetailExperience", () => {
  beforeEach(() => {
    observedQueries.keys = [];
  });

  it("passes the exact selected account and real Ad identity to actions without mounting raw evidence", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        id: "row-1",
        real_ad_id: "ad-1",
        account_id: "act_1",
      }),
    );

    renderDetail(row);

    expect(observedQueries.keys).toContainEqual([
      "meta-ad-actions",
      "biz",
      "ad-1",
    ]);
    expect(
      observedQueries.keys.some(
        ([key]) => key === "engine-v3-native-ad-evidence",
      ),
    ).toBe(false);
  });

  it("does not mount raw evidence when creative grouping metadata is absent", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        id: "row-without-creative-group",
        real_ad_id: "ad-without-creative-group",
        account_id: "act_1",
      }),
    );
    row.creativeId = "";

    renderDetail(row);

    expect(
      observedQueries.keys.some(
        ([key]) => key === "engine-v3-native-ad-evidence",
      ),
    ).toBe(false);
  });

  it("fails closed instead of treating a row id as a provider Ad id", () => {
    const html = renderDetail(
      mapApiRowToUiRow(buildApiRow({ id: "synthetic-row", real_ad_id: null })),
    );

    expect(html).toContain(
      "Actions are unavailable because this row could not be matched to one confirmed Meta ad. Review it in Ads Manager.",
    );
    expect(html).not.toContain("provider Ad id");
    expect(html).not.toContain("exact ad, creative, and account identity");
    expect(html).not.toContain("Exact Ad evidence unavailable");
    expect(observedQueries.keys).not.toContainEqual([
      "engine-v3-native-ad-evidence",
      "biz",
      "act_1",
      "synthetic-row",
    ]);
  });

  it("renders preview, performance, and notes without decision payloads", () => {
    const html = renderDetail();

    expect(html).toContain("Creative Detail Row");
    expect(html).toContain("Performance");
    expect(html).toContain("Spend");
    expect(html).toContain("$100.00");
    expect(html).toContain("ROAS");
    expect(html).toContain("2.50x");
    expect(html).toContain("Notes");
    expect(html).toContain("Existing note");
    expect(html).not.toContain("Decision OS");
    expect(html).not.toContain("Decision Center");
    expect(html).not.toContain("decision support payload");
    expect(html).not.toContain("commercial-context-card");
    expect(html).not.toContain("Command Center");
    expect(html).not.toContain("AI strategy interpretation");
  });

  it("renders the unavailable-preview state without decision wording", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        name: "No Preview Creative",
        preview_url: null,
        preview_source: null,
        thumbnail_url: null,
        image_url: null,
        table_thumbnail_url: null,
        card_preview_url: null,
        preview_manifest: {
          table_src: null,
          card_src: null,
          detail_image_src: null,
          detail_video_src: null,
          render_state: "missing",
          card_state: "missing",
          waiting_reason: "missing_media",
          table_source_kind: "none",
          card_source_kind: "none",
          resolution_class: "unknown",
          thumbnail_like: false,
          source_reason: "unavailable",
          needs_card_enrichment: false,
          live_html_available: false,
        },
        preview_state: "unavailable",
        preview: {
          render_mode: "unavailable",
          image_url: null,
          video_url: null,
          poster_url: null,
          source: null,
          is_catalog: false,
        },
        preview_status: "missing",
      }),
    );
    const html = renderDetail(row);

    expect(html).toContain(
      "No renderable preview is available for this creative.",
    );
    expect(html).not.toContain("decision-window");
    expect(html).not.toContain("metrics-only");
  });
});
