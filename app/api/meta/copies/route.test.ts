import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import { GET } from "@/app/api/meta/copies/route";

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  getDemoMetaCopies: vi.fn(() => ({ status: "ok", rows: [] })),
  getDemoProviderAccounts: vi.fn(() => [{ id: "act_1" }]),
}));

vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: vi.fn(),
}));

const businessMode = await import("@/lib/business-mode.server");
const access = await import("@/lib/access");
const creativesApi = await import("@/lib/meta/creatives-api");

function buildCreativeRow(overrides: Partial<MetaCreativeApiRow> = {}): MetaCreativeApiRow {
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
    name: "Winning copy",
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

describe("GET /api/meta/copies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
  });

  it("requires an explicit provider account scope", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/copies?businessId=biz"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "missing_provider_account_id",
    });
    expect(creativesApi.getMetaCreativesApiPayload).not.toHaveBeenCalled();
  });

  it("derives copy rows from the shared snapshot/live creatives payload", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow()],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].copy_text).toBe("Buy now");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: "act_1",
        mediaMode: "metadata",
        enableCopyRecovery: true,
        enableCreativeDetails: false,
        enableThumbnailBackfill: false,
        enableCardThumbnailBackfill: false,
        enableMediaRecovery: false,
      })
    );
  });

  it("defensively excludes rows from other provider accounts before grouping", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", account_id: "act_1", spend: 100 }),
        buildCreativeRow({ id: "ad_2", account_id: "act_2", spend: 900 }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.meta.provider_account_id).toBe("act_1");
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({ account_id: "act_1", spend: 100 });
  });

  it("maps real funnel/video metrics from the source rows and never fabricates see_more_rate", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({
          landing_page_views: 40,
          initiate_checkout: 12,
          leads: 3,
          messages: 2,
          video25: 500,
          video50: 300,
          video75: 150,
          video100: 80,
          ctr_all: 1.5,
        }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=adName"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    const row = payload.rows[0];
    expect(row.landing_page_views).toBe(40);
    expect(row.initiate_checkout).toBe(12);
    expect(row.leads).toBe(3);
    expect(row.messages).toBe(2);
    expect(row.video25).toBe(500);
    expect(row.video50).toBe(300);
    expect(row.video75).toBe(150);
    expect(row.video100).toBe(80);
    // The old implementation fabricated see_more_rate = ctr_all * 1.5; the
    // field is now removed from the contract entirely.
    expect("see_more_rate" in row).toBe(false);
  });

  it("sums funnel/video metrics across grouped copy buckets", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({
          id: "ad_1",
          landing_page_views: 40,
          initiate_checkout: 12,
          leads: 3,
          messages: 2,
          video25: 500,
          video100: 80,
        }),
        buildCreativeRow({
          id: "ad_2",
          landing_page_views: 10,
          initiate_checkout: 8,
          leads: 1,
          messages: 0,
          video25: 100,
          video100: 20,
        }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    const row = payload.rows[0];
    expect(row.landing_page_views).toBe(50);
    expect(row.initiate_checkout).toBe(20);
    expect(row.leads).toBe(4);
    expect(row.messages).toBe(2);
    expect(row.video25).toBe(600);
    expect(row.video100).toBe(100);
  });

  it("aggregates thumbstop as an impression-weighted mean, not a plain mean", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        // 9000 impressions at 10% and 1000 at 50%: weighted = 14%, plain = 30%.
        buildCreativeRow({ id: "ad_1", impressions: 9000, thumbstop: 10 }),
        buildCreativeRow({ id: "ad_2", impressions: 1000, thumbstop: 50 }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].thumbstop).toBeCloseTo(14, 5);
    expect(payload.rows[0].first_frame_retention).toBeCloseTo(14, 5);
  });

  it("returns null bucket thumbstop when the bucket had no delivery", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", impressions: 0, thumbstop: 10 }),
        buildCreativeRow({ id: "ad_2", impressions: 0, thumbstop: 50 }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(payload.rows[0].thumbstop).toBeNull();
    expect(payload.rows[0].first_frame_retention).toBeNull();
  });

  it("stamps meta.generatedAt as an ISO timestamp", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow()],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(typeof payload.meta.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload.meta.generatedAt))).toBe(false);
  });

  it("retries with snapshot bypass when source rows have no recoverable copy", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [
          buildCreativeRow({
            copy_text: null,
            copy_variants: [],
            headline_variants: [],
            description_variants: [],
            copy_source: null,
          }),
        ],
        snapshot_source: "live",
      } as never)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [
          buildCreativeRow({
            copy_text: "Recovered copy",
            copy_variants: ["Recovered copy"],
            copy_source: "preview_html",
          }),
        ],
        snapshot_source: "live",
      } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-21&end=2026-04-03&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].copy_text).toBe("Recovered copy");
    expect(payload.meta.recoveryAttempted).toBe(true);
    expect(payload.meta.recoveryRecovered).toBe(true);
    expect(payload.meta.recoveryReason).toBe("copy_empty_source_rows");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledTimes(2);
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        snapshotBypass: true,
        enableCreativeDetails: true,
        enableCreativeBasicsFallback: true,
        mediaMode: "metadata",
      })
    );
  });

  it("retries once when a persisted snapshot returns zero rows", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [],
        snapshot_source: "persisted",
      } as never)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [],
        snapshot_source: "live",
      } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-21&end=2026-04-03&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(0);
    expect(payload.meta.recoveryAttempted).toBe(true);
    expect(payload.meta.recoveryRecovered).toBe(false);
    expect(payload.meta.recoveryReason).toBe("persisted_snapshot_empty");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledTimes(2);
  });
});
