import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCreativeDecisionEngineV3,
  mapApiRowToUiRow,
  toCsv,
  toSharedCreative,
  type DecisionEngineV3Response,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import type { AccountDecisionProfile } from "@/lib/creative-decision-engine";

function buildApiRow(overrides: Partial<MetaCreativeApiRow> = {}): MetaCreativeApiRow {
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
    name: "Creative name",
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
    creative_delivery_type: "catalog",
    creative_visual_format: "video",
    creative_primary_type: "catalog",
    creative_primary_label: "Catalog",
    creative_secondary_type: "video",
    creative_secondary_label: "Video",
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeAccountProfile(): AccountDecisionProfile {
  return {
    businessId: "biz-1",
    asOfDate: "2026-05-04",
    channel: "meta",
    objectiveFamily: "sales",
    preset: "balanced",
    presetSource: "default",
    spendUnit: 50,
    spendUnitSource: "meta_derived_aov",
    spendUnitConfidence: "high",
    spendUnitEvidence: {
      targetCpa: null,
      operatorAovAssumption: 55,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      targetRoas: 2.2,
      breakEvenRoas: 1.71,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      warnings: [],
    },
    multipliers: {
      zeroConvBurner: 1.5,
      cutCandidate: 2,
      sustainedLoser: 3,
      hardCut: 4,
      scaleEvidence: 1.2,
      scalePurchase: 1,
      winnerMemory: 0.8,
      recentSample: 0.5,
      weakFunnelRate: 0.8,
    },
    thresholds: {
      zeroConvBurnerSpend: 75,
      cutCandidateSpend: 100,
      sustainedLoserSpend: 150,
      hardCutSpend: 200,
      recentSampleMinSpend: 50,
      scaleMinEvidenceSpend: 100,
      winnerMemoryMinSpend: 80,
      scaleMinPurchases: 3,
      winnerMemoryMinPurchases: 2,
      bottomQuartileRatio: 0.6,
      severeLoserRatio: 0.4,
    },
    accountBaselines: {
      businessId: "biz-1",
      computedAt: "2026-05-04T12:00:00.000Z",
      matureCreativeCount: 35,
      roasP75: 2.4,
      roasP60: 1.9,
      refreshRatioP10: 0.82,
      lowCtrP10: 0.7,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      matureSpendP50: 300,
      matureSpendP75: 450,
      winnerSpendP25: 250,
      winnerSpendP50: 500,
      winnerPurchaseP50: 5,
      roasRatioP10: 0.4,
      roasRatioP25: 0.6,
      roasRatioP50: 1,
      roasRatioP75: 1.35,
      metaAovQuality: "ready",
    },
    funnelCalibration: { byFormat: {} },
    scope: { type: "account", id: "*" },
    hardActionEligibility: {
      scale: true,
      cut: true,
      refresh: true,
      reason: null,
    },
    quality: {
      commercialTruthReady: true,
      calibrationReady: true,
      metaAovQuality: "ready",
      thresholdQuality: "ready",
    },
  };
}

describe("mapApiRowToUiRow", () => {
  it("maps new taxonomy labels to the UI row", () => {
    const row = mapApiRowToUiRow(buildApiRow());

    expect(row.copyText).toBe("Buy now");
    expect(row.copyVariants).toEqual(["Buy now"]);
    expect(row.headlineVariants).toEqual(["Headline"]);
    expect(row.descriptionVariants).toEqual(["Description"]);
    expect(row.objectStoryId).toBeNull();
    expect(row.postId).toBeNull();
    expect(row.creativePrimaryType).toBe("catalog");
    expect(row.creativePrimaryLabel).toBe("Catalog");
    expect(row.creativeSecondaryType).toBe("video");
    expect(row.creativeSecondaryLabel).toBe("Video");
    expect(row.taxonomyVersion).toBe("v2");
    expect(row.taxonomySource).toBe("deterministic");
    expect(row.taxonomyReconciledByVideoEvidence).toBe(false);
  });

  it("keeps legacy aliases exactly as provided by the API", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        format: "image",
        creative_type: "feed",
        creative_type_label: "Feed",
        creative_delivery_type: "catalog",
        creative_visual_format: "video",
        creative_primary_type: "video",
        creative_primary_label: "Video",
        creative_secondary_type: null,
        creative_secondary_label: null,
      })
    );

    expect(row.format).toBe("image");
    expect(row.creativeType).toBe("feed");
    expect(row.creativeTypeLabel).toBe("Feed");
    expect(row.creativeVisualFormat).toBe("video");
    expect(row.creativePrimaryType).toBe("video");
  });

  it("does not reinterpret taxonomy on the client from preview evidence", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        creative_delivery_type: "standard",
        creative_visual_format: "image",
        creative_primary_type: "standard",
        creative_primary_label: "Standard",
        creative_secondary_type: null,
        creative_secondary_label: null,
        preview: {
          render_mode: "video",
          image_url: "https://example.com/poster.jpg",
          video_url: "https://example.com/video.mp4",
          poster_url: "https://example.com/poster.jpg",
          source: "image_url",
          is_catalog: false,
        },
        thumbstop: 0,
        video25: 0,
        video50: 0,
        video75: 0,
        video100: 0,
        taxonomy_reconciled_by_video_evidence: false,
      })
    );

    expect(row.creativeVisualFormat).toBe("image");
    expect(row.creativePrimaryType).toBe("standard");
    expect(row.creativePrimaryLabel).toBe("Standard");
    expect(row.taxonomyReconciledByVideoEvidence).toBe(false);
  });

  it("defaults rows without taxonomy metadata to legacy fallback", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        creative_delivery_type: undefined as never,
        creative_visual_format: undefined as never,
        creative_primary_type: undefined as never,
        creative_primary_label: undefined as never,
        creative_secondary_type: undefined as never,
        creative_secondary_label: undefined as never,
        taxonomy_version: undefined,
        taxonomy_source: undefined,
        taxonomy_reconciled_by_video_evidence: undefined,
        format: "video",
        creative_type: "video",
        creative_type_label: "Video",
      })
    );

    expect(row.creativePrimaryType).toBe("standard");
    expect(row.creativePrimaryLabel).toBeNull();
    expect(row.creativeSecondaryType).toBeNull();
    expect(row.taxonomySource).toBe("legacy_fallback");
    expect(row.format).toBe("video");
    expect(row.creativeType).toBe("video");
    expect(row.creativeTypeLabel).toBe("Video");
  });

  it("normalizes malformed live creative fields before the table renders them", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        id: 123 as never,
        creative_id: null as never,
        name: null as never,
        tags: ["fatigue", null, 42] as never,
        ai_tags: {
          offerType: "Bundle",
          hookTactic: ["Before/After", null],
        } as never,
        copy_variants: "Buy now" as never,
        preview: null as never,
        is_catalog: "false" as never,
        spend: "120.5" as never,
        frequency: "2.4" as never,
      }),
    );

    expect(row.id).toBe("123");
    expect(row.creativeId).toBe("123");
    expect(row.name).toBe("Buy now");
    expect(row.tags).toEqual(["fatigue", "42"]);
    expect(row.aiTags.offerType).toEqual(["Bundle"]);
    expect(row.aiTags.hookTactic).toEqual(["Before/After"]);
    expect(row.copyVariants).toEqual(["Buy now"]);
    expect(row.preview.render_mode).toBe("unavailable");
    expect(row.isCatalog).toBe(false);
    expect(row.spend).toBe(120.5);
    expect(row.frequency).toBe(2.4);
  });

  it("keeps click truth distinct across clicks, link CTR, add-to-cart, and purchase conversion", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        clicks: 75,
        link_clicks: 50,
        impressions: 1000,
        add_to_cart: 15,
        purchases: 10,
        click_to_atc: 30,
      })
    );

    expect(row.clicks).toBe(75);
    expect(row.linkClicks).toBe(50);
    expect(row.linkCtr).toBe(5);
    expect(row.clickToAddToCart).toBe(30);
    expect(row.clickToPurchase).toBe(20);
  });

  it("keeps shared creative payload parity with the UI row truth fields", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        clicks: 120,
        link_clicks: 80,
        impressions: 2000,
        add_to_cart: 24,
        purchases: 12,
        click_to_atc: 30,
      })
    );

    const shared = toSharedCreative(row);

    expect(shared.clicks).toBe(120);
    expect(shared.linkClicks).toBe(80);
    expect(shared.linkCtr).toBe(4);
    expect(shared.clickToAddToCart).toBe(30);
    expect(shared.clickToPurchase).toBe(15);
  });

  it("exports truthful CSV headers and values without misleading duplicate columns", () => {
    const row = mapApiRowToUiRow(
      buildApiRow({
        spend: 100,
        clicks: 75,
        link_clicks: 50,
        impressions: 1000,
        add_to_cart: 15,
        purchases: 10,
        click_to_atc: 30,
      })
    );

    const [headerLine, valueLine] = toCsv([row]).split("\n");
    const headers = headerLine.split(",").map((item) => item.slice(1, -1));
    const values = valueLine.split(",").map((item) => item.slice(1, -1));

    expect(headers).not.toContain("Click through rate (outbound)");
    expect(headers).not.toContain("First frame retention");
    expect(headers).not.toContain("Hold rate");
    expect(headers).not.toContain("Hook score");

    expect(values[headers.indexOf("Cost per click (all)")]).toBe("1.33");
    expect(values[headers.indexOf("Clicks (all)")]).toBe("75");
    expect(values[headers.indexOf("Link clicks")]).toBe("50");
    expect(values[headers.indexOf("Click through rate (link clicks)")]).toBe("5.00");
    expect(values[headers.indexOf("Click to add-to-cart ratio")]).toBe("30.00");
    expect(values[headers.indexOf("Click to purchase ratio")]).toBe("20.00");
  });
});

describe("fetchCreativeDecisionEngineV3", () => {
  it("fetches v3 decisions with business, date, and creative id filters", async () => {
    const payload: DecisionEngineV3Response = {
      businessId: "biz-1",
      asOf: "2026-05-04",
      engineVersion: "v3-2026-05-04-stub",
      dataSource: "warehouse",
      scope: { type: "account", id: "*" },
      accountProfile: makeAccountProfile(),
      dataHealth: {
        calibration: {
          asOfDate: "2026-05-04",
          computedAt: "2026-05-04T12:00:00.000Z",
          sourceFreshnessHours: 0,
          staleTier: "none",
          fallbackMode: "runtime_sql",
          note: null,
        },
        lifecycle: {
          asOfDate: "2026-05-04",
          computedAt: "2026-05-04T12:00:00.000Z",
          sourceFreshnessHours: 0,
          staleTier: "none",
          fallbackMode: "runtime_sql",
          note: null,
        },
        decisions: {
          asOfDate: "2026-05-04",
          computedAt: "2026-05-04T12:00:00.000Z",
          sourceFreshnessHours: 0,
          staleTier: "none",
          fallbackMode: "runtime_sql",
          note: null,
        },
        worstTier: "none",
        degraded: false,
      },
      flags: {
        businessId: "biz-1",
        enabled: true,
        surfaceVisible: true,
        shadowOnly: true,
        presetOverride: null,
        source: {
          enabled: "env",
          surfaceVisible: "business_override",
          shadowOnly: "env",
          presetOverride: null,
        },
        envDefaults: {
          enabled: true,
          surfaceVisible: false,
          shadowOnly: true,
        },
      },
      decisions: [
        {
          creativeId: "creative-1",
          creativeName: "Creative One",
          label: "test_more",
          reason: "Engine v3 stub - real gate logic not yet implemented.",
          confidence: 50,
          truthSource: "commercial_truth",
          effectiveTargetRoas: 2.2,
          ratioToTarget: 1.1,
          badges: [],
          metrics: {
            spend: 100,
            purchases: 2,
            roas: 2.4,
            recent7dRoas: 2.1,
          },
          engineVersion: "v3-2026-05-04-stub",
          generatedAt: "2026-05-04T12:00:00.000Z",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { origin: "https://app.example" },
    });

    const result = await fetchCreativeDecisionEngineV3({
      businessId: "biz-1",
      asOf: "2026-05-04",
      creativeIds: ["creative-1", "creative-2"],
      campaignId: "campaign-1",
    });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.origin).toBe("https://app.example");
    expect(requestUrl.pathname).toBe("/api/creatives/decision-engine-v3");
    expect(requestUrl.searchParams.get("businessId")).toBe("biz-1");
    expect(requestUrl.searchParams.get("asOf")).toBe("2026-05-04");
    expect(requestUrl.searchParams.get("creativeIds")).toBe("creative-1,creative-2");
    expect(requestUrl.searchParams.get("campaignId")).toBe("campaign-1");
  });
});
