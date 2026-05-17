import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
  fetchCreativeDetailPreviewHtml: vi.fn(),
  fetchCreativeThumbnailMap: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-service", () => ({
  buildCreativesResponse: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-warehouse", () => ({
  getMetaCreativesWarehousePayload: vi.fn(),
}));

vi.mock("@/lib/meta/readiness", () => ({
  getMetaPartialReason: vi.fn(() => "Meta is still preparing current-day warehouse data."),
  getMetaRangePreparationContext: vi.fn(),
}));

vi.mock("@/lib/meta/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/history")>();
  return {
    ...actual,
    dayCountInclusive: vi.fn((start: string, end: string) => {
      const startMs = Date.parse(`${start}T00:00:00Z`);
      const endMs = Date.parse(`${end}T00:00:00Z`);
      return Math.floor((endMs - startMs) / 86_400_000) + 1;
    }),
  };
});

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaAdDailyCoverage: vi.fn(),
  getMetaCreativeDailyCoverage: vi.fn(),
}));

const integrations = await import("@/lib/integrations");
const fetchers = await import("@/lib/meta/creatives-fetchers");
const service = await import("@/lib/meta/creatives-service");
const warehousePayloads = await import("@/lib/meta/creatives-warehouse");
const readiness = await import("@/lib/meta/readiness");
const warehouse = await import("@/lib/meta/warehouse");
const { getMetaCreativeDetailPayload, getMetaCreativesApiPayload } = await import("@/lib/meta/creatives-api");

function buildInput(request = new NextRequest("http://localhost/api/meta/creatives?businessId=biz")) {
  return {
    request,
    requestStartedAt: Date.now(),
    businessId: "biz",
    mediaMode: "full" as const,
    groupBy: "creative" as const,
    format: "all" as const,
    sort: "roas" as const,
    start: "2026-03-01",
    end: "2026-03-31",
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: false,
    snapshotWarm: false,
    enableCopyRecovery: true,
    enableCreativeBasicsFallback: true,
    enableCreativeDetails: true,
    enableThumbnailBackfill: true,
    enableCardThumbnailBackfill: true,
    enableImageHashLookup: true,
    enableMediaRecovery: true,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 10,
  };
}

describe("getMetaCreativeDetailPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tries the ad preview first and falls back to the creative preview", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "token",
    } as never);
    vi.mocked(fetchers.fetchCreativeDetailPreviewHtml)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        html: "<iframe />",
        adFormat: "MOBILE_FEED_STANDARD",
        source: "meta_creative_previews",
      });

    const payload = await getMetaCreativeDetailPayload({
      businessId: "biz",
      creativeId: "cr_1",
      adId: "ad_1",
      adFormat: "MOBILE_FEED_STANDARD",
    });

    expect(fetchers.fetchCreativeDetailPreviewHtml).toHaveBeenNthCalledWith(
      1,
      "ad_1",
      "token",
      { adFormats: ["MOBILE_FEED_STANDARD"] },
    );
    expect(fetchers.fetchCreativeDetailPreviewHtml).toHaveBeenNthCalledWith(
      2,
      "cr_1",
      "token",
      { adFormats: ["MOBILE_FEED_STANDARD"] },
    );
    expect(payload.detail_preview).toMatchObject({
      creative_id: "cr_1",
      target_id: "cr_1",
      target_type: "creative",
      mode: "html",
      ad_format: "MOBILE_FEED_STANDARD",
      html: "<iframe />",
    });
  });

  it("returns the ad preview when the ad edge supplies html", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "token",
    } as never);
    vi.mocked(fetchers.fetchCreativeDetailPreviewHtml).mockResolvedValueOnce({
      html: "<iframe />",
      adFormat: "INSTAGRAM_STORY",
      source: "meta_creative_previews",
    });

    const payload = await getMetaCreativeDetailPayload({
      businessId: "biz",
      creativeId: "cr_1",
      adId: "ad_1",
      adFormat: "INSTAGRAM_STORY",
    });

    expect(fetchers.fetchCreativeDetailPreviewHtml).toHaveBeenCalledTimes(1);
    expect(payload.detail_preview).toMatchObject({
      creative_id: "cr_1",
      target_id: "ad_1",
      target_type: "ad",
      mode: "html",
      ad_format: "INSTAGRAM_STORY",
      html: "<iframe />",
    });
  });

  it("uses ordered placement fallback formats when provided", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "token",
    } as never);
    vi.mocked(fetchers.fetchCreativeDetailPreviewHtml).mockResolvedValueOnce({
      html: "<iframe />",
      adFormat: "FACEBOOK_REELS_MOBILE",
      source: "meta_creative_previews",
    });

    const payload = await getMetaCreativeDetailPayload({
      businessId: "biz",
      creativeId: "cr_1",
      adId: "ad_1",
      adFormats: ["INSTAGRAM_REELS", "FACEBOOK_REELS_MOBILE"],
    });

    expect(fetchers.fetchCreativeDetailPreviewHtml).toHaveBeenCalledWith(
      "ad_1",
      "token",
      { adFormats: ["INSTAGRAM_REELS", "FACEBOOK_REELS_MOBILE"] },
    );
    expect(payload.detail_preview).toMatchObject({
      target_type: "ad",
      ad_format: "FACEBOOK_REELS_MOBILE",
      html: "<iframe />",
    });
  });
});

describe("getMetaCreativesApiPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "token",
    } as never);
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(fetchers.fetchCreativeThumbnailMap).mockResolvedValue(new Map());
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
      latest_updated_at: null,
    } as never);
    vi.mocked(warehouse.getMetaAdDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
      latest_updated_at: null,
    } as never);
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      primaryAccountTimezone: "UTC",
      currentDateInTimezone: "2026-04-01",
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-03-31",
      selectedRangeTruthEndDate: "2026-03-31",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    } as never);
  });

  it("serves warehouse rows when creative coverage is complete", async () => {
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 31,
      ready_through_date: "2026-03-31",
      latest_updated_at: "2026-04-01T03:00:00.000Z",
    } as never);
    vi.mocked(warehousePayloads.getMetaCreativesWarehousePayload).mockResolvedValue({
      status: "ok",
      rows: [],
      snapshot_source: "persisted",
    } as never);

    const result = await getMetaCreativesApiPayload(buildInput());

    expect((result as { readSource?: string }).readSource).toBe("warehouse");
    expect(warehousePayloads.getMetaCreativesWarehousePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        start: "2026-03-01",
        end: "2026-03-31",
        groupBy: "creative",
        mediaMode: "full",
      }),
    );
    expect(service.buildCreativesResponse).not.toHaveBeenCalled();
  });

  it("refreshes warehouse media URLs before serving full-media creative rows", async () => {
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 31,
      ready_through_date: "2026-03-31",
      latest_updated_at: "2026-04-01T03:00:00.000Z",
    } as never);
    vi.mocked(warehousePayloads.getMetaCreativesWarehousePayload).mockResolvedValue({
      status: "ok",
      media_mode: "full",
      media_hydrated: true,
      rows: [
        {
          id: "creative_row_1",
          creative_id: "cr_1",
          name: "Creative 1",
          thumbnail_url: "https://old.example/thumb.jpg",
          table_thumbnail_url: "https://old.example/table.jpg",
          card_preview_url: "https://old.example/card.jpg",
          preview_url: "https://old.example/preview.jpg",
          image_url: "https://old.example/image.jpg",
          cached_thumbnail_url: null,
          preview_state: "preview",
          preview_origin: "snapshot",
          preview: {
            render_mode: "image",
            image_url: "https://old.example/image.jpg",
            video_url: null,
            poster_url: "https://old.example/table.jpg",
            source: "thumbnail_url",
            is_catalog: false,
          },
        },
      ],
      snapshot_source: "persisted",
    } as never);
    vi.mocked(fetchers.fetchCreativeThumbnailMap)
      .mockResolvedValueOnce(new Map([["cr_1", "https://fresh.example/table.jpg"]]))
      .mockResolvedValueOnce(new Map([["cr_1", "https://fresh.example/card.jpg"]]));

    const result = await getMetaCreativesApiPayload(buildInput());
    const row = result.rows[0];

    expect((result as { readSource?: string }).readSource).toBe("warehouse");
    expect((result as { media_hydrated?: boolean }).media_hydrated).toBe(true);
    expect(fetchers.fetchCreativeThumbnailMap).toHaveBeenNthCalledWith(
      1,
      ["cr_1"],
      "token",
      150,
      120,
      false,
    );
    expect(fetchers.fetchCreativeThumbnailMap).toHaveBeenNthCalledWith(
      2,
      ["cr_1"],
      "token",
      640,
      640,
      false,
    );
    expect(row.table_thumbnail_url).toBe("https://fresh.example/table.jpg");
    expect(row.thumbnail_url).toBe("https://fresh.example/table.jpg");
    expect(row.card_preview_url).toBe("https://fresh.example/card.jpg");
    expect(row.image_url).toBe("https://fresh.example/card.jpg");
    expect(row.preview.image_url).toBe("https://fresh.example/card.jpg");
    expect(row.preview.poster_url).toBe("https://fresh.example/table.jpg");
    expect(row.preview_origin).toBe("live");
    expect(service.buildCreativesResponse).not.toHaveBeenCalled();
  });

  it("uses the historical truth end date when a selected range includes today", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      primaryAccountTimezone: "UTC",
      currentDateInTimezone: "2026-03-31",
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: true,
      selectedRangeHistoricalEndDate: "2026-03-30",
      selectedRangeTruthEndDate: "2026-03-30",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 30,
      ready_through_date: "2026-03-30",
      latest_updated_at: "2026-03-31T03:00:00.000Z",
    } as never);
    vi.mocked(warehousePayloads.getMetaCreativesWarehousePayload).mockResolvedValue({
      status: "ok",
      rows: [],
      snapshot_source: "persisted",
    } as never);
    const request = new NextRequest("http://localhost/api/meta/creatives?businessId=biz");

    const result = await getMetaCreativesApiPayload(buildInput(request));

    expect((result as { readSource?: string }).readSource).toBe("warehouse");
    expect(warehouse.getMetaCreativeDailyCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-03-01",
        endDate: "2026-03-30",
      }),
    );
    expect(warehousePayloads.getMetaCreativesWarehousePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        start: "2026-03-01",
        end: "2026-03-30",
        groupBy: "creative",
        mediaMode: "full",
      }),
    );
    expect(service.buildCreativesResponse).not.toHaveBeenCalled();
  });

  it("trims historical live fallback to yesterday when a range ends today", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      primaryAccountTimezone: "UTC",
      currentDateInTimezone: "2026-03-31",
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: true,
      selectedRangeHistoricalEndDate: "2026-03-30",
      selectedRangeTruthEndDate: "2026-03-30",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    } as never);
    vi.mocked(service.buildCreativesResponse).mockResolvedValue({
      status: "ok",
      rows: [],
      media_mode: "full",
      media_hydrated: false,
    } as never);
    const request = new NextRequest("http://localhost/api/meta/creatives?businessId=biz");

    const result = await getMetaCreativesApiPayload(buildInput(request));

    expect((result as { readSource?: string }).readSource).toBe("live_fallback");
    expect(service.buildCreativesResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "2026-03-01",
        end: "2026-03-30",
        allowSnapshotPersistence: false,
        allowSnapshotRefreshTrigger: false,
      }),
      request,
    );
  });

  it("reads selected current-day creatives live even when warehouse coverage exists", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      primaryAccountTimezone: "UTC",
      currentDateInTimezone: "2026-03-31",
      isSelectedCurrentDay: true,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-03-31",
      selectedRangeTruthEndDate: "2026-03-31",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "current_day_live",
      breakdownReadMode: "current_day_live",
    } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-03-31",
      latest_updated_at: "2026-03-31T12:00:00.000Z",
    } as never);
    vi.mocked(service.buildCreativesResponse).mockResolvedValue({
      status: "ok",
      rows: [],
      media_mode: "full",
      media_hydrated: false,
    } as never);
    const request = new NextRequest("http://localhost/api/meta/creatives?businessId=biz");

    const result = await getMetaCreativesApiPayload({
      ...buildInput(request),
      start: "2026-03-31",
      end: "2026-03-31",
    });

    expect((result as { readSource?: string }).readSource).toBe("current_day_live");
    expect((result as { isPartial?: boolean }).isPartial).toBe(true);
    expect(warehouse.getMetaCreativeDailyCoverage).not.toHaveBeenCalled();
    expect(warehousePayloads.getMetaCreativesWarehousePayload).not.toHaveBeenCalled();
    expect(service.buildCreativesResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "2026-03-31",
        end: "2026-03-31",
        snapshotBypass: true,
        snapshotWarm: true,
        enableMediaCache: false,
        allowSnapshotPersistence: false,
        allowSnapshotRefreshTrigger: false,
      }),
      request,
    );
  });

  it("uses request-scoped live fallback without snapshot persistence or media cache writes", async () => {
    vi.mocked(service.buildCreativesResponse).mockResolvedValue({
      status: "ok",
      rows: [],
      media_mode: "full",
      media_hydrated: false,
    } as never);
    const request = new NextRequest("http://localhost/api/meta/creatives?businessId=biz");
    const input = buildInput(request);

    const first = await getMetaCreativesApiPayload(input);
    const second = await getMetaCreativesApiPayload(input);

    expect((first as { readSource?: string }).readSource).toBe("live_fallback");
    expect((second as { readSource?: string }).readSource).toBe("live_fallback");
    expect(service.buildCreativesResponse).toHaveBeenCalledTimes(1);
    expect(service.buildCreativesResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotBypass: true,
        snapshotWarm: true,
        enableMediaCache: false,
        allowSnapshotPersistence: false,
        allowSnapshotRefreshTrigger: false,
      }),
      request,
    );
    expect(warehousePayloads.getMetaCreativesWarehousePayload).not.toHaveBeenCalled();
  });
});
