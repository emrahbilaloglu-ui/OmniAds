import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { MetaCreativesSnapshotRecord } from "@/lib/meta-creatives-snapshot";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { buildMetaCreativesSnapshotPayload } from "@/lib/meta/creatives-snapshot-helpers";
import { buildCreativesResponse, type CreativesQueryParams } from "@/lib/meta/creatives-service";

vi.mock("@/lib/media-cache/media-service", () => ({
  MediaCacheService: {
    resolveUrls: vi.fn(async () => new Map()),
  },
}));

vi.mock("@/lib/meta-creatives-snapshot", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta-creatives-snapshot")>(
    "@/lib/meta-creatives-snapshot"
  );
  return {
    ...actual,
    getMetaCreativesSnapshot: vi.fn(),
    persistMetaCreativesSnapshot: vi.fn(),
  };
});

vi.mock("@/lib/meta/creatives-snapshot-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/creatives-snapshot-helpers")>(
    "@/lib/meta/creatives-snapshot-helpers"
  );
  return {
    ...actual,
    triggerSnapshotRefresh: vi.fn(),
  };
});

const snapshotStore = await import("@/lib/meta-creatives-snapshot");
const snapshotHelpers = await import("@/lib/meta/creatives-snapshot-helpers");
const creativesFetchers = await import("@/lib/meta/creatives-fetchers");

function buildRow(overrides: Partial<MetaCreativeApiRow> = {}): MetaCreativeApiRow {
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
    landing_page_views: 20,
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

function buildSnapshotRecord(input: {
  payload: Record<string, unknown>;
  lastSyncedAt?: string;
}): MetaCreativesSnapshotRecord {
  return {
    snapshotKey: "snapshot-key",
    businessId: "biz",
    assignedAccountsHash: "hash",
    payload: input.payload,
    snapshotLevel: "metadata",
    rowCount: Array.isArray(input.payload.rows) ? input.payload.rows.length : 0,
    previewReadyCount: Array.isArray(input.payload.rows) ? input.payload.rows.length : 0,
    lastSyncedAt: input.lastSyncedAt ?? new Date().toISOString(),
    refreshStartedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildQuery(): CreativesQueryParams {
  return {
    businessId: "biz",
    assignedAccountIds: [],
    accessToken: "token",
    mediaMode: "metadata",
    enableFullMediaHydration: false,
    groupBy: "creative",
    format: "all",
    sort: "roas",
    start: "2026-03-01",
    end: "2026-03-31",
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: false,
    snapshotWarm: false,
    enableCopyRecovery: true,
    enableCreativeBasicsFallback: false,
    enableCreativeDetails: false,
    enableThumbnailBackfill: false,
    enableCardThumbnailBackfill: false,
    enableImageHashLookup: false,
    enableMediaRecovery: false,
    enableMediaCache: false,
    enableDeepAudit: false,
    perAccountSampleLimit: 5,
    requestStartedAt: Date.now(),
  };
}

describe("buildCreativesResponse snapshot freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(null);
  });

  it("reuses a healthy deterministic v2 snapshot", async () => {
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload: buildMetaCreativesSnapshotPayload({
          status: "ok",
          rows: [buildRow()],
          mediaHydrated: false,
        }),
      })
    );

    const response = await buildCreativesResponse(
      buildQuery(),
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("ok");
    expect(response.snapshot_source).toBe("persisted");
    expect(response.rows).toHaveLength(1);
    expect(snapshotHelpers.triggerSnapshotRefresh).not.toHaveBeenCalled();
    expect(snapshotStore.persistMetaCreativesSnapshot).not.toHaveBeenCalled();
  });

  it("bypasses a snapshot missing taxonomy schema metadata and falls through to live", async () => {
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload: {
          status: "ok",
          rows: [buildRow()],
          media_hydrated: false,
        },
      })
    );

    const response = await buildCreativesResponse(
      buildQuery(),
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("no_data");
    expect(snapshotHelpers.triggerSnapshotRefresh).toHaveBeenCalledTimes(1);
  });

  it("bypasses a snapshot missing preview contract metadata and falls through to live", async () => {
    const payload = buildMetaCreativesSnapshotPayload({
      status: "ok",
      rows: [buildRow()],
      mediaHydrated: false,
    });
    delete payload.preview_contract_version;

    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload,
      })
    );

    const response = await buildCreativesResponse(
      buildQuery(),
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("no_data");
    expect(snapshotHelpers.triggerSnapshotRefresh).toHaveBeenCalledTimes(1);
  });

  it("returns a healthy stale-by-time snapshot immediately and schedules refresh", async () => {
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload: buildMetaCreativesSnapshotPayload({
          status: "ok",
          rows: [buildRow()],
          mediaHydrated: false,
        }),
        lastSyncedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      })
    );

    const response = await buildCreativesResponse(
      buildQuery(),
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("ok");
    expect(response.snapshot_source).toBe("persisted");
    expect(snapshotHelpers.triggerSnapshotRefresh).toHaveBeenCalledTimes(1);
  });

  it("reuses a renderable low-quality metadata snapshot instead of treating enrichment need as stale", async () => {
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload: buildMetaCreativesSnapshotPayload({
          status: "ok",
          rows: [
            buildRow({
              preview_manifest: {
                table_src: "https://example.com/thumb_p150x120.jpg",
                card_src: null,
                detail_image_src: "https://example.com/thumb_p150x120.jpg",
                detail_video_src: null,
                render_state: "renderable_low_quality",
                card_state: "waiting_meta",
                waiting_reason: "awaiting_card_source",
                table_source_kind: "thumbnail_static",
                card_source_kind: "thumbnail_static",
                resolution_class: "low_res",
                thumbnail_like: true,
                source_reason: "fallback_static_source",
                needs_card_enrichment: true,
                live_html_available: false,
              },
              thumbnail_url: "https://example.com/thumb_p150x120.jpg",
              image_url: "https://example.com/thumb_p150x120.jpg",
              preview_url: "https://example.com/thumb_p150x120.jpg",
              table_thumbnail_url: "https://example.com/thumb_p150x120.jpg",
              card_preview_url: "https://example.com/thumb_p150x120.jpg",
            }),
          ],
          mediaHydrated: false,
        }),
      })
    );

    const response = await buildCreativesResponse(
      buildQuery(),
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("ok");
    expect(response.snapshot_source).toBe("persisted");
    expect(snapshotHelpers.triggerSnapshotRefresh).not.toHaveBeenCalled();
  });

  it("still bypasses suspicious empty-copy snapshots", async () => {
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload: buildMetaCreativesSnapshotPayload({
          status: "ok",
          rows: [
            buildRow({
              copy_text: null,
              copy_variants: [],
              headline_variants: [],
              description_variants: [],
              copy_source: null,
              copy_debug_sources: [],
              unresolved_reason: null,
            }),
          ],
          mediaHydrated: false,
        }),
      })
    );

    const response = await buildCreativesResponse(
      buildQuery(),
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("no_data");
    expect(snapshotHelpers.triggerSnapshotRefresh).toHaveBeenCalledTimes(1);
  });

  it("bypasses snapshots with catalog purchases but no revenue signal", async () => {
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload: buildMetaCreativesSnapshotPayload({
          status: "ok",
          rows: [
            buildRow({
              is_catalog: true,
              spend: 140,
              purchases: 2,
              purchase_value: 0,
              roas: 0,
              cpa: 0,
            }),
          ],
          mediaHydrated: false,
        }),
      })
    );

    const response = await buildCreativesResponse(
      buildQuery(),
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("no_data");
    expect(snapshotHelpers.triggerSnapshotRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not persist metadata over an existing full preview snapshot", async () => {
    vi.mocked(snapshotStore.getMetaCreativesSnapshot).mockResolvedValue(
      buildSnapshotRecord({
        payload: buildMetaCreativesSnapshotPayload({
          status: "ok",
          rows: [buildRow()],
          mediaHydrated: true,
        }),
      })
    );

    const response = await buildCreativesResponse(
      {
        ...buildQuery(),
        snapshotBypass: true,
      },
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz")
    );

    expect(response.status).toBe("no_data");
    expect(snapshotStore.persistMetaCreativesSnapshot).not.toHaveBeenCalled();
  });

  it("uses direct creative basics fallback in metadata mode when batch ads miss creative payload", async () => {
    vi.mocked(snapshotStore.persistMetaCreativesSnapshot).mockResolvedValue(undefined);
    vi.spyOn(creativesFetchers, "fetchAccountInsights").mockResolvedValue([
      {
        ad_id: "ad_1",
        ad_name: "Advantage+ catalog",
        adset_id: "adset_1",
        adset_name: "Ad Set 1",
        campaign_id: "cmp_1",
        campaign_name: "Campaign 1",
        spend: "120",
        impressions: "1000",
        clicks: "80",
        ctr: "8",
        cpm: "120",
        cpc: "1.5",
        inline_link_clicks: "80",
        date_start: "2026-03-01",
        actions: [
          { action_type: "purchase", value: "4" },
          { action_type: "link_click", value: "80" },
          { action_type: "landing_page_view", value: "70" },
          { action_type: "add_to_cart", value: "10" },
        ],
        action_values: [{ action_type: "purchase", value: "480" }],
        purchase_roas: [{ action_type: "purchase", value: "4" }],
      },
    ]);
    vi.spyOn(creativesFetchers, "fetchAccountMeta").mockResolvedValue({
      id: "act_1",
      name: "Main",
      currency: "USD",
    });
    vi.spyOn(creativesFetchers, "batchFetchAdsByIds").mockResolvedValue(
      new Map([
        [
          "ad_1",
          {
            id: "ad_1",
            name: "Advantage+ catalog",
            adset_id: "adset_1",
            adset: { id: "adset_1", name: "Ad Set 1" },
            creative: null,
          },
        ],
      ])
    );
    const basicsSpy = vi.spyOn(creativesFetchers, "fetchAdCreativeBasicsByAdIds").mockResolvedValue(
      new Map([
        [
          "ad_1",
          {
            id: "ad_1",
            name: "Advantage+ catalog",
            adset_id: "adset_1",
            adset: { id: "adset_1", name: "Ad Set 1" },
            creative: {
              id: "cr_1",
              name: "{{product.name}} catalog creative",
              object_type: "SHARE",
              object_story_spec: {
                template_data: {
                  link: "https://example.com",
                  name: "{{product.name}}",
                },
              },
            },
          },
        ],
      ])
    );
    vi.spyOn(creativesFetchers, "fetchAdImageUrlMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchVideoSourceMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchCreativeThumbnailMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchCreativeDetailsMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchAdCreativeMediaByAdIds").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchAdCreativeMediaDirectByAdIds").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchCreativeDetailPreviewHtml").mockResolvedValue(null);

    const response = await buildCreativesResponse(
      {
        ...buildQuery(),
        snapshotBypass: true,
        assignedAccountIds: ["act_1"],
      },
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz&snapshotBypass=1")
    );

    expect(basicsSpy).toHaveBeenCalledWith(["ad_1"], "token");
    expect(response.status).toBe("ok");
    expect(response.snapshot_source).toBe("live");
    expect(response.rows[0]).toMatchObject({
      name: "Advantage+ catalog",
      is_catalog: true,
      format: "catalog",
      creative_delivery_type: "catalog",
      creative_primary_type: "catalog",
    });
    expect(response.rows[0]?.ai_tags?.assetType).toEqual(["Catalog"]);
    expect(response.rows[0]?.ai_tags?.visualFormat).toEqual(["Catalog"]);
  });

  it("does not refetch creative basics in metadata mode when batch ads already include creative IDs", async () => {
    vi.mocked(snapshotStore.persistMetaCreativesSnapshot).mockResolvedValue(undefined);
    vi.spyOn(creativesFetchers, "fetchAccountInsights").mockResolvedValue([
      {
        ad_id: "ad_zero",
        ad_name: "Zero spend",
        spend: "0",
        impressions: "10",
        clicks: "0",
        date_start: "2026-03-01",
      },
      {
        ad_id: "ad_1",
        ad_name: "Creative with id",
        adset_id: "adset_1",
        adset_name: "Ad Set 1",
        campaign_id: "cmp_1",
        campaign_name: "Campaign 1",
        spend: "120",
        impressions: "1000",
        clicks: "80",
        ctr: "8",
        cpm: "120",
        cpc: "1.5",
        inline_link_clicks: "80",
        date_start: "2026-03-01",
        actions: [{ action_type: "link_click", value: "80" }],
      },
    ]);
    vi.spyOn(creativesFetchers, "fetchAccountMeta").mockResolvedValue({
      id: "act_1",
      name: "Main",
      currency: "USD",
    });
    const batchSpy = vi.spyOn(creativesFetchers, "batchFetchAdsByIds").mockResolvedValue(
      new Map([
        [
          "ad_zero",
          {
            id: "ad_zero",
            name: "Zero spend",
            creative: {
              id: "cr_zero",
              name: "Zero spend creative",
              object_type: "SHARE",
            },
          },
        ],
        [
          "ad_1",
          {
            id: "ad_1",
            name: "Creative with id",
            adset_id: "adset_1",
            adset: { id: "adset_1", name: "Ad Set 1" },
            creative: {
              id: "cr_1",
              name: "Creative with id",
              object_type: "SHARE",
            },
          },
        ],
      ])
    );
    const basicsSpy = vi.spyOn(creativesFetchers, "fetchAdCreativeBasicsByAdIds").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchAdImageUrlMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchVideoSourceMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchCreativeThumbnailMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchCreativeDetailsMap").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchAdCreativeMediaByAdIds").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchAdCreativeMediaDirectByAdIds").mockResolvedValue(new Map());
    vi.spyOn(creativesFetchers, "fetchCreativeDetailPreviewHtml").mockResolvedValue(null);

    const response = await buildCreativesResponse(
      {
        ...buildQuery(),
        snapshotBypass: true,
        assignedAccountIds: ["act_1"],
      },
      new NextRequest("http://localhost/api/meta/creatives?businessId=biz&snapshotBypass=1")
    );

    expect(basicsSpy).not.toHaveBeenCalled();
    expect(batchSpy).toHaveBeenCalledWith(["ad_zero", "ad_1"], "token", "metadata");
    expect(response.status).toBe("ok");
    expect(response.rows.find((row) => row.creative_id === "cr_1")).toMatchObject({
      creative_id: "cr_1",
      spend: 120,
    });
    expect(response.rows.find((row) => row.creative_id === "cr_zero")).toMatchObject({
      creative_id: "cr_zero",
      spend: 0,
      impressions: 10,
    });
  });
});
