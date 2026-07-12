import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaAdDailyCoverage: vi.fn(),
  getMetaCreativeMediaPreviewCoverage: vi.fn(),
  getMetaCreativeMediaRange: vi.fn(),
  getMetaAdDailyRange: vi.fn(),
  getMetaCreativeDailyRange: vi.fn(),
  upsertMetaAdDailyRows: vi.fn(),
  upsertMetaCreativeDailyRows: vi.fn(),
  upsertMetaCreativeMediaRows: vi.fn(),
}));

vi.mock("@/lib/meta/request-model-store", () => ({
  readMetaAdDimensions: vi.fn(),
  readMetaCreativeDimensions: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-service", () => ({
  buildCreativesResponse: vi.fn(),
}));

vi.mock("@/lib/meta/cleanup", () => ({
  pruneMetaCreativeMediaOutsideRetention: vi.fn(),
}));

const creativeFetchers = await import("@/lib/meta/creatives-fetchers");
const creativesService = await import("@/lib/meta/creatives-service");
const cleanup = await import("@/lib/meta/cleanup");
const requestModelStore = await import("@/lib/meta/request-model-store");
const warehouse = await import("@/lib/meta/warehouse");
const {
  getMetaCreativesWarehousePayload,
  resolveMetaCreativesAccountScope,
  syncMetaCreativesWarehouseDay,
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

function buildCreativeFactRow(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "biz-1",
    providerAccountId: "act_1",
    date: "2026-04-03",
    campaignId: "cmp-1",
    adsetId: "adset-1",
    adId: "ad-1",
    creativeId: "crt-1",
    creativeName: "Creative 1",
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
    landingPageViews: 3,
    addToCart: 2,
    initiateCheckout: 1,
    sourceSnapshotId: null,
    payloadJson: {},
    ...overrides,
  };
}

function buildAdFactRow(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "biz-1",
    providerAccountId: "act_1",
    date: "2026-04-03",
    campaignId: "cmp-1",
    adsetId: "adset-1",
    adId: "ad-1",
    adNameCurrent: "Ad 1",
    adNameHistorical: "Ad 1",
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
    outboundClicks: 2,
    landingPageViews: 2,
    addToCart: 1,
    initiateCheckout: 1,
    sourceSnapshotId: null,
    truthState: "finalized",
    truthVersion: 1,
    payloadJson: {},
    ...overrides,
  };
}

describe("meta creatives warehouse", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(new Map());
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([] as never);
    vi.mocked(cleanup.pruneMetaCreativeMediaOutsideRetention).mockResolvedValue(undefined as never);
  });

  it("auto-resolves only a single assigned account", () => {
    expect(
      resolveMetaCreativesAccountScope({ assignedAccountIds: ["act_1"] }),
    ).toMatchObject({
      ok: true,
      providerAccountId: "act_1",
      assignedAccountIds: ["act_1"],
      resolution: "single_assigned_account",
    });
    expect(
      resolveMetaCreativesAccountScope({
        assignedAccountIds: ["act_1", "act_2"],
      }),
    ).toMatchObject({
      ok: false,
      status: "provider_account_required",
      assignedAccountCount: 2,
    });
  });

  it("fails closed for an unassigned explicit warehouse account", async () => {
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      providerAccountId: "act_other",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload).toMatchObject({
      status: "account_not_assigned",
      rows: [],
      providerAccountId: "act_other",
    });
    expect(warehouse.getMetaCreativeDailyRange).not.toHaveBeenCalled();
    expect(warehouse.getMetaAdDailyRange).not.toHaveBeenCalled();
  });

  it("passes one structured account filter to warehouse reads and drops foreign rows", async () => {
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      buildCreativeFactRow({
        providerAccountId: "act_2",
        adId: "ad-2",
        creativeId: "crt-2",
      }),
      buildCreativeFactRow({
        providerAccountId: "act_1",
        adId: "foreign-ad",
        creativeId: "foreign-crt",
      }),
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-2",
          {
            projectionJson: buildProjectionRow({
              id: "ad-2",
              creative_id: "crt-2",
              account_id: "act_2",
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      providerAccountId: "act_2",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(warehouse.getMetaCreativeDailyRange).toHaveBeenCalledWith({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      providerAccountIds: ["act_2"],
    });
    expect(payload).toMatchObject({
      status: "ok",
      providerAccountId: "act_2",
      account_scope: {
        status: "resolved",
        resolution: "explicit",
        assigned_account_count: 2,
      },
    });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      account_id: "act_2",
      creative_id: "crt-2",
    });
  });

  it("fails closed before creative financial rows are written without currency", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow({ currency: null })],
    } as never);

    await expect(
      syncMetaCreativesWarehouseDay({
        businessId: "biz-1",
        day: "2026-04-03",
        accessToken: "token",
        assignedAccountIds: ["act_1"],
      })
    ).rejects.toThrow("meta_currency_unavailable:creative_warehouse:act_1");

    expect(warehouse.upsertMetaAdDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeMediaRows).not.toHaveBeenCalled();
  });

  it("preserves genuine creative account currency in warehouse rows", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow({ currency: "TRY" })],
    } as never);

    await syncMetaCreativesWarehouseDay({
      businessId: "biz-1",
      day: "2026-04-03",
      accessToken: "token",
      assignedAccountIds: ["act_1"],
    });

    expect(warehouse.upsertMetaAdDailyRows).toHaveBeenCalledWith([
      expect.objectContaining({ accountCurrency: "TRY" }),
    ]);
    expect(warehouse.upsertMetaCreativeDailyRows).toHaveBeenCalledWith([
      expect.objectContaining({ accountCurrency: "TRY" }),
    ]);
  });

  it("persists full creative media at ad grain when a creative is reused", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [
        buildProjectionRow({
          id: "ad-1",
          creative_id: "shared-creative",
          object_story_id: "123_456",
          effective_object_story_id: "123_789",
          destination_url: "https://iwastore.com/products/lp",
          destination_url_raw: "https://iwastore.com/products/lp?utm_source=meta",
          destination_url_source: "creative_link_data",
          destination_url_confidence: "high",
          cta_type: "SHOP_NOW",
          preview_url: "https://example.com/ad-1-preview.jpg",
          thumbnail_url: "https://example.com/ad-1-thumb.jpg",
        }),
        buildProjectionRow({
          id: "ad-2",
          creative_id: "shared-creative",
          campaign_id: "cmp-2",
          campaign_name: "Campaign 2",
          adset_id: "adset-2",
          adset_name: "Adset 2",
          preview_url: "https://example.com/ad-2-preview.jpg",
          thumbnail_url: "https://example.com/ad-2-thumb.jpg",
        }),
      ],
    } as never);

    await syncMetaCreativesWarehouseDay({
      businessId: "biz-1",
      day: "2026-04-03",
      accessToken: "token",
      assignedAccountIds: ["act_1"],
      mediaMode: "full",
      sourceRunId: "run-1",
    });

    const mediaRows = vi.mocked(warehouse.upsertMetaCreativeMediaRows).mock.calls[0]?.[0] ?? [];

    expect(mediaRows).toHaveLength(2);
    expect(mediaRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adId: "ad-1",
          creativeId: "shared-creative",
          previewUrl: "https://example.com/ad-1-preview.jpg",
          sourceRunId: "run-1",
        }),
        expect.objectContaining({
          adId: "ad-2",
          creativeId: "shared-creative",
          previewUrl: "https://example.com/ad-2-preview.jpg",
          sourceRunId: "run-1",
        }),
      ]),
    );
    const adRows = vi.mocked(warehouse.upsertMetaAdDailyRows).mock.calls[0]?.[0] ?? [];
    expect(adRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adId: "ad-1",
          destinationUrl: "https://iwastore.com/products/lp",
          destinationUrlRaw: "https://iwastore.com/products/lp?utm_source=meta",
          destinationUrlSource: "creative_link_data",
          destinationUrlConfidence: "high",
          ctaType: "SHOP_NOW",
          objectStoryId: "123_456",
          effectiveObjectStoryId: "123_789",
        }),
      ]),
    );
    const creativeRows =
      vi.mocked(warehouse.upsertMetaCreativeDailyRows).mock.calls[0]?.[0] ?? [];
    expect(creativeRows).toHaveLength(1);
    expect(creativeRows[0]).toEqual(
      expect.objectContaining({
        creativeId: "shared-creative",
        destinationUrl: "https://iwastore.com/products/lp",
        destinationUrlRaw: "https://iwastore.com/products/lp?utm_source=meta",
        destinationUrlSource: "creative_link_data",
        destinationUrlConfidence: "high",
        ctaType: "SHOP_NOW",
        objectStoryId: "123_456",
        effectiveObjectStoryId: "123_789",
      }),
    );
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
        landingPageViews: 3,
        addToCart: 2,
        initiateCheckout: 1,
        sourceSnapshotId: null,
        payloadJson: buildProjectionRow({
          name: "Ignored Daily Payload",
          copy_text: "Ignored Daily Copy",
          landing_page_views: 999,
          add_to_cart: 999,
          initiate_checkout: 999,
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
      landing_page_views: 3,
      add_to_cart: 2,
      initiate_checkout: 1,
      click_to_atc: 66.67,
      atc_to_purchase: 100,
    });
  });

  it("keeps metadata warehouse reads working when retained dimensions omit nested preview", async () => {
    const projectionWithoutPreview = buildProjectionRow({
      name: "Dimension Creative",
      preview_url: null,
      thumbnail_url: null,
      image_url: null,
      table_thumbnail_url: null,
      card_preview_url: null,
    });
    delete (projectionWithoutPreview as Record<string, unknown>).preview;
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
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
        payloadJson: {},
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: projectionWithoutPreview,
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
      preview_status: "missing",
      spend: 25,
      purchase_value: 50,
    });
    expect(payload.rows[0]?.preview).toMatchObject({
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
    });
  });

  it("infers preview mode from retained top-level media URLs when nested preview is absent", async () => {
    const projectionWithoutPreview = buildProjectionRow({
      name: "Dimension Creative",
      preview_url: "https://example.com/preview.jpg",
      thumbnail_url: "https://example.com/thumb.jpg",
      image_url: "https://example.com/image.jpg",
      table_thumbnail_url: null,
      card_preview_url: null,
    });
    delete (projectionWithoutPreview as Record<string, unknown>).preview;
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
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
        payloadJson: {},
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: projectionWithoutPreview,
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

    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      preview_status: "ready",
      preview_url: "https://example.com/image.jpg",
      image_url: "https://example.com/image.jpg",
    });
    expect(payload.rows[0]?.preview).toMatchObject({
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      poster_url: "https://example.com/thumb.jpg",
    });
  });

  it("hydrates creative-group warehouse rows from the richest retained media row", async () => {
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
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
        payloadJson: {},
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: buildProjectionRow({
              preview_url: null,
              thumbnail_url: null,
              image_url: null,
              table_thumbnail_url: null,
              card_preview_url: null,
              preview: {
                render_mode: "missing",
                image_url: null,
                video_url: null,
                poster_url: null,
                source: null,
                is_catalog: false,
              },
            }),
          },
        ],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        previewUrl: null,
        thumbnailUrl: null,
        imageUrl: null,
        payloadJson: {},
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-2",
        adId: "ad-2",
        creativeId: "crt-1",
        previewUrl: "https://example.com/rich-preview.jpg",
        thumbnailUrl: "https://example.com/rich-thumb.jpg",
        imageUrl: "https://example.com/rich-image.jpg",
        posterUrl: "https://example.com/rich-poster.jpg",
        payloadJson: {},
      },
    ] as never);

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "full",
    });

    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      preview_url: "https://example.com/rich-poster.jpg",
      image_url: "https://example.com/rich-image.jpg",
      preview_status: "ready",
    });
  });

  it("filters exact ad-group creative usage before retained media hydration", async () => {
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildAdFactRow({
        providerAccountId: "act_1",
        adId: "ad-foreign",
        adNameCurrent: "Foreign Ad",
      }),
      buildAdFactRow({
        providerAccountId: "act_2",
        adId: "ad-selected",
        adNameCurrent: "Selected Ad",
      }),
      buildAdFactRow({
        providerAccountId: "act_2",
        adId: "ad-other",
        adNameCurrent: "Other Ad",
      }),
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-foreign",
          {
            creativeId: "crt-target",
            projectionJson: buildProjectionRow({
              id: "ad-foreign",
              creative_id: "crt-target",
              account_id: "act_1",
            }),
          },
        ],
        [
          "ad-selected",
          {
            creativeId: "crt-target",
            projectionJson: buildProjectionRow({
              id: "ad-selected",
              creative_id: "crt-target",
              account_id: "act_2",
            }),
          },
        ],
        [
          "ad-other",
          {
            creativeId: "crt-other",
            projectionJson: buildProjectionRow({
              id: "ad-other",
              creative_id: "crt-other",
              account_id: "act_2",
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      providerAccountId: "act_2",
      creativeId: "crt-target",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "ad",
      format: "all",
      sort: "spend",
      mediaMode: "full",
    });

    expect(warehouse.getMetaAdDailyRange).toHaveBeenCalledWith({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      providerAccountIds: ["act_2"],
    });
    expect(requestModelStore.readMetaAdDimensions).toHaveBeenCalledWith({
      businessId: "biz-1",
      adIds: ["ad-selected", "ad-other"],
    });
    expect(warehouse.getMetaCreativeMediaRange).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountIds: ["act_2"],
        creativeIds: null,
        adIds: ["ad-selected"],
      }),
    );
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      id: "ad-selected",
      account_id: "act_2",
      creative_id: "crt-target",
      name: "Selected Ad",
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
        outboundClicks: 2,
        landingPageViews: 2,
        addToCart: 1,
        initiateCheckout: 1,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        payloadJson: buildProjectionRow({
          name: "Ignored Ad Payload",
          copy_text: "Ignored Ad Copy",
          landing_page_views: 999,
          add_to_cart: 999,
          initiate_checkout: 999,
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
      outbound_clicks: 2,
      landing_page_views: 2,
      add_to_cart: 1,
      initiate_checkout: 1,
      click_to_atc: 50,
      atc_to_purchase: 100,
    });
  });

  it("backfills sparse ad-name funnel metrics from a unique creative daily row", async () => {
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
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
        ctr: 0,
        cpc: 0,
        linkClicks: 0,
        landingPageViews: 0,
        addToCart: 0,
        initiateCheckout: 0,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        payloadJson: {},
      },
    ] as never);
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        linkClicks: 18,
        landingPageViews: 10,
        addToCart: 2,
        initiateCheckout: 1,
        sourceSnapshotId: null,
        payloadJson: {},
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-1",
          {
            creativeId: "crt-1",
            projectionJson: buildProjectionRow({
              id: "ad-1",
              creative_id: "crt-1",
              name: "Dimension Ad",
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

    expect(payload.rows[0]).toMatchObject({
      id: "ad-1",
      link_clicks: 18,
      landing_page_views: 10,
      add_to_cart: 2,
      initiate_checkout: 1,
      ctr_all: 22.5,
      cpc_link: 0.67,
      click_to_atc: 11.11,
      atc_to_purchase: 50,
    });
  });

  it("hydrates ad-name warehouse rows from retained creative media", async () => {
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
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
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-1",
          {
            projectionJson: buildProjectionRow({
              preview_url: null,
              thumbnail_url: null,
              image_url: null,
              table_thumbnail_url: null,
              card_preview_url: null,
              preview: {
                render_mode: "missing",
                image_url: null,
                video_url: null,
                poster_url: null,
                source: null,
                is_catalog: false,
              },
            }),
          },
        ],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        previewUrl: "https://example.com/media-preview.jpg",
        thumbnailUrl: "https://example.com/media-thumb.jpg",
        imageUrl: "https://example.com/media-image.jpg",
        tableThumbnailUrl: "https://example.com/media-table.jpg",
        cardPreviewUrl: "https://example.com/media-card.jpg",
        videoUrl: null,
        posterUrl: "https://example.com/media-poster.jpg",
        payloadJson: {},
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        previewUrl: null,
        thumbnailUrl: null,
        imageUrl: null,
        payloadJson: {},
      },
    ] as never);

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "adName",
      format: "all",
      sort: "spend",
      mediaMode: "full",
    });

    expect(warehouse.getMetaCreativeMediaRange).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeIds: null,
        adIds: ["ad-1"],
      }),
    );
    expect(payload.rows[0]).toMatchObject({
      id: "ad-1",
      preview_url: "https://example.com/media-preview.jpg",
      thumbnail_url: "https://example.com/media-table.jpg",
      image_url: "https://example.com/media-image.jpg",
      preview_status: "ready",
    });
    if (payload.status !== "ok") throw new Error("expected scoped warehouse payload");
    expect(payload.media_hydrated).toBe(true);
  });
});
