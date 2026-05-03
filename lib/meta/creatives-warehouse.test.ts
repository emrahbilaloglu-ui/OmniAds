import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaAdDailyCoverage: vi.fn(),
  getMetaCreativeMediaPreviewCoverage: vi.fn(),
  getMetaAdDailyRange: vi.fn(),
  getMetaCreativeDailyRange: vi.fn(),
  upsertMetaAdDailyRows: vi.fn(),
  upsertMetaCreativeDailyRows: vi.fn(),
}));

vi.mock("@/lib/meta/request-model-store", () => ({
  readMetaAdDimensions: vi.fn(),
  readMetaCreativeDimensions: vi.fn(),
}));

const creativeFetchers = await import("@/lib/meta/creatives-fetchers");
const requestModelStore = await import("@/lib/meta/request-model-store");
const warehouse = await import("@/lib/meta/warehouse");
const {
  getMetaCreativesWarehousePayload,
} = await import("@/lib/meta/creatives-warehouse");

function buildProjectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ad-1",
    creative_id: "crt-1",
    object_story_id: null,
    effective_object_story_id: null,
    post_id: null,
    associated_ads_count: 1,
    account_id: "act_1",
    account_name: "Account 1",
    campaign_id: "cmp-1",
    campaign_name: "Campaign 1",
    adset_id: "adset-1",
    adset_name: "Adset 1",
    currency: "USD",
    name: "Projected Creative",
    launch_date: "2026-04-03",
    copy_text: "Projected Copy",
    copy_variants: ["Projected Copy"],
    headline_variants: ["Projected Headline"],
    description_variants: [],
    copy_source: null,
    copy_debug_sources: [],
    unresolved_reason: null,
    preview_url: "https://example.com/preview.jpg",
    preview_source: "snapshot",
    thumbnail_url: "https://example.com/thumb.jpg",
    image_url: "https://example.com/image.jpg",
    table_thumbnail_url: null,
    card_preview_url: null,
    is_catalog: false,
    preview_state: "preview",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      video_url: null,
      poster_url: "https://example.com/thumb.jpg",
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
    spend: 0,
    purchase_value: 0,
    roas: 0,
    cpa: 0,
    clicks: 0,
    cpc_link: 0,
    cpm: 0,
    ctr_all: 0,
    purchases: 0,
    impressions: 0,
    link_clicks: 0,
    landing_page_views: 0,
    add_to_cart: 0,
    initiate_checkout: 0,
    thumbstop: 0,
    click_to_atc: 0,
    atc_to_purchase: 0,
    leads: 0,
    messages: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    ...overrides,
  };
}

describe("meta creatives warehouse", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(new Map());
  });

  it("builds creative-group payloads from creative dimensions instead of daily payloadJson", async () => {
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Wrong Daily Creative",
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 25,
        impressions: 100,
        clicks: 4,
        conversions: 2,
        revenue: 50,
        roas: 2,
        ctr: 4,
        cpc: 6.25,
        linkClicks: 3,
        sourceSnapshotId: null,
        payloadJson: buildProjectionRow({
          name: "Ignored Daily Payload",
          copy_text: "Ignored Daily Copy",
        }),
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: buildProjectionRow({
              name: "Dimension Creative",
              copy_text: "Dimension Copy",
              spend: 999,
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload.status).toBe("ok");
    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      name: "Dimension Creative",
      copy_text: "Dimension Copy",
      spend: 25,
      purchase_value: 50,
    });
  });

  it("builds ad-group payloads from ad dimensions instead of daily payloadJson", async () => {
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Wrong Daily Ad",
        adNameHistorical: "Wrong Daily Ad",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        reach: 80,
        frequency: null,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        linkClicks: 2,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        payloadJson: buildProjectionRow({
          name: "Ignored Ad Payload",
          copy_text: "Ignored Ad Copy",
        }),
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-1",
          {
            projectionJson: buildProjectionRow({
              name: "Dimension Ad",
              copy_text: "Dimension Ad Copy",
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "adName",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload.status).toBe("ok");
    expect(payload.rows[0]).toMatchObject({
      id: "ad-1",
      name: "Dimension Ad",
      copy_text: "Dimension Ad Copy",
      spend: 12,
      purchase_value: 24,
    });
  });
});
