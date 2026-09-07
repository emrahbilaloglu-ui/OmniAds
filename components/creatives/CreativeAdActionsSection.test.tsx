import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

let queryPayloads: Record<string, unknown>;

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
  useQuery: vi.fn((input: { queryKey: unknown[] }) => {
    const key = String(input.queryKey[0] ?? "");
    return {
      data: queryPayloads[key],
      isLoading: false,
      isFetching: false,
      isError: false,
    };
  }),
}));

const {
  CreativeAdActionsSection,
  buildDuplicateActionBody,
  formatActionError,
  isDuplicateConfirmDisabled,
  postManualAdAction,
  resolveManualAdActionCandidateIds,
  resolveManualAdActionId,
} = await import("@/components/creatives/CreativeAdActionsSection");

function makeRow(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "ad_1",
    realAdId: "ad_1",
    creativeId: "creative_1",
    name: "Creative One",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "Main",
    campaignId: "cmp_1",
    campaignName: "Campaign 1",
    adSetId: "adset_1",
    adSetName: "Ad Set 1",
    effectiveStatus: "ACTIVE",
    currency: "USD",
    format: "image",
    creativeType: "feed",
    creativeTypeLabel: "Feed",
    creativeDeliveryType: "standard",
    creativeVisualFormat: "image",
    creativePrimaryType: "standard",
    creativePrimaryLabel: "Standard",
    creativeSecondaryType: null,
    creativeSecondaryLabel: null,
    taxonomyVersion: "v2",
    taxonomySource: "deterministic",
    taxonomyReconciledByVideoEvidence: false,
    thumbnailUrl: "https://example.com/thumb.jpg",
    previewUrl: "https://example.com/preview.jpg",
    imageUrl: "https://example.com/image.jpg",
    tableThumbnailUrl: "https://example.com/table.jpg",
    cardPreviewUrl: "https://example.com/card.jpg",
    previewManifest: null,
    cachedThumbnailUrl: null,
    previewStatus: "ready",
    previewOrigin: "snapshot",
    isCatalog: false,
    previewState: "preview",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      video_url: null,
      poster_url: null,
      source: "image_url",
      is_catalog: false,
    },
    launchDate: "2026-05-01",
    tags: [],
    aiTags: {},
    spend: 100,
    purchaseValue: 250,
    roas: 2.5,
    cpa: 10,
    cpcLink: 2,
    cpm: 12,
    ctrAll: 1.5,
    linkCtr: 1.2,
    purchases: 10,
    impressions: 1000,
    clicks: 75,
    linkClicks: 50,
    landingPageViews: 0,
    addToCart: 15,
    initiateCheckout: 0,
    leads: 0,
    messages: 0,
    thumbstop: 12,
    clickToAddToCart: 20,
    clickToPurchase: 20,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio: 66,
    ...overrides,
  };
}

function renderSection(
  row: MetaCreativeRow,
  options?: { initialDuplicateOpen?: boolean },
) {
  return renderToStaticMarkup(
    <CreativeAdActionsSection
      businessId="172d0ab8-495b-4679-a4c6-ffa404c389d3"
      row={row}
      open
      initialDuplicateOpen={options?.initialDuplicateOpen}
    />,
  );
}

function buttonOpeningTag(html: string, label: string) {
  const index = html.indexOf(label);
  expect(index).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", index);
  const end = html.indexOf(">", index);
  return html.slice(start, end);
}

function hasDisabledAttribute(buttonTag: string) {
  return /\sdisabled(?:=""|\s|$)/.test(buttonTag);
}

describe("CreativeAdActionsSection", () => {
  beforeEach(() => {
    queryPayloads = {
      "meta-action-campaigns": [
        { id: "cmp_1", name: "Campaign 1", status: "ACTIVE" },
      ],
      "meta-action-adsets": [
        {
          id: "adset_1",
          name: "Ad Set 1",
          campaignId: "cmp_1",
          status: "ACTIVE",
        },
      ],
      "meta-ad-actions": [],
    };
  });

  it("renders action buttons with pause enabled for ACTIVE ads", () => {
    const html = renderSection(makeRow({ effectiveStatus: "ACTIVE" }));

    expect(html).toContain("Active");
    expect(html).not.toContain(">ACTIVE<");
    expect(html).toContain("Pause ad");
    expect(html).toContain("Resume ad");
    expect(html).toContain("Duplicate to campaign...");
    expect(hasDisabledAttribute(buttonOpeningTag(html, "Pause ad"))).toBe(
      false,
    );
    expect(hasDisabledAttribute(buttonOpeningTag(html, "Resume ad"))).toBe(
      true,
    );
  });

  it("renders action buttons with resume enabled for PAUSED ads", () => {
    const html = renderSection(makeRow({ effectiveStatus: "PAUSED" }));

    expect(hasDisabledAttribute(buttonOpeningTag(html, "Pause ad"))).toBe(true);
    expect(hasDisabledAttribute(buttonOpeningTag(html, "Resume ad"))).toBe(
      false,
    );
  });

  it("renders recent action history rows", () => {
    queryPayloads["meta-ad-actions"] = [
      {
        id: "log_1",
        action: "pause",
        status: "success",
        requestedAt: "2026-05-05T12:00:00.000Z",
        errorCode: null,
        errorMessage: null,
        resultingAdId: null,
      },
    ];

    const html = renderSection(makeRow());

    expect(html).toContain("Recent actions on this ad");
    expect(html).toContain("pause");
    expect(html).toContain("success");
  });

  it("never renders stored provider errors in action history", () => {
    queryPayloads["meta-ad-actions"] = [
      {
        id: "log_failed",
        action: "pause",
        status: "failure",
        requestedAt: "2026-05-05T12:00:00.000Z",
        errorCode: "provider_write_rejected",
        errorMessage: "Graph API token and internal request details",
        resultingAdId: null,
      },
    ];

    const html = renderSection(makeRow());

    expect(html).toContain(
      "This action could not be completed. Check the ad in Ads Manager.",
    );
    expect(html).not.toContain("provider_write_rejected");
    expect(html).not.toContain("Graph API token");
  });

  it("uses stable action copy instead of response codes and messages", () => {
    const message = formatActionError(
      {
        ok: false,
        error: {
          code: "configured_status_precondition_failed",
          message: "Raw provider response body",
        },
      },
      "Could not pause ad.",
    );

    expect(message).toBe("Could not pause ad.");
    expect(message).not.toContain("configured_status_precondition_failed");
    expect(message).not.toContain("Raw provider response");
  });

  it("keeps duplicate confirmation disabled until campaign and ad set are selected", () => {
    expect(
      isDuplicateConfirmDisabled({
        selectedCampaignId: "",
        selectedAdsetId: "",
        progress: "idle",
      }),
    ).toBe(true);
    expect(
      isDuplicateConfirmDisabled({
        selectedCampaignId: "cmp_1",
        selectedAdsetId: "",
        progress: "idle",
      }),
    ).toBe(true);
    expect(
      isDuplicateConfirmDisabled({
        selectedCampaignId: "cmp_1",
        selectedAdsetId: "adset_1",
        progress: "idle",
      }),
    ).toBe(false);
    expect(
      isDuplicateConfirmDisabled({
        selectedCampaignId: "cmp_1",
        selectedAdsetId: "adset_1",
        progress: "verifying",
      }),
    ).toBe(true);
  });

  it("renders the PAUSED-only duplicate modal without activation or budget controls", () => {
    const html = renderSection(makeRow(), { initialDuplicateOpen: true });

    expect(html).toContain("Duplicate to campaign");
    expect(html).toContain("Target campaign");
    expect(html).toContain("Target ad set");
    expect(html).toContain("Name override");
    expect(html).not.toContain("Activate immediately");
    expect(html).not.toContain("activateAfterCreate");
    expect(html).not.toContain("Daily budget");
    expect(html).not.toContain("dailyBudgetMinor");
  });

  it("builds a duplicate mutation payload without ACTIVE-create options", () => {
    const payload = buildDuplicateActionBody({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adId: "ad_1",
      creativeId: "creative_1",
      targetAdsetId: "adset_2",
      nameOverride: "  Source copy  ",
    });

    expect(payload).toEqual({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adId: "ad_1",
      creativeId: "creative_1",
      targetAdsetId: "adset_2",
      name: "Source copy",
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
    });
    expect(payload).not.toHaveProperty("activateAfterCreate");
    expect(payload).not.toHaveProperty("dailyBudgetMinor");
  });

  it("uses the real Meta ad id for manual actions when grouped rows have a synthetic id", () => {
    const row = makeRow({
      id: "creative_synthetic",
      realAdId: " 120000000001 ",
    });

    expect(resolveManualAdActionId(row)).toBe("120000000001");
    expect(resolveManualAdActionCandidateIds(row)).toEqual(["120000000001"]);
  });

  it("keeps discovery-only rows review-only when no exact Meta ad id is present", () => {
    const row = makeRow({
      id: "ad_1",
      realAdId: null,
      creativeId: "creative_1",
    });

    expect(resolveManualAdActionId(row)).toBe("");
    expect(resolveManualAdActionCandidateIds(row)).toEqual([]);
  });

  it("explains unavailable actions without exposing internal identity terms", () => {
    const html = renderSection(
      makeRow({ id: "ad_1", realAdId: null, creativeId: "creative_1" }),
    );

    expect(html).toContain("could not be matched to one confirmed Meta ad");
    expect(html).not.toContain("creative, and account identity");
    expect(html).not.toContain("Provider actions");
  });

  it("refuses synthetic fallback candidates before issuing a write request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await postManualAdAction({
      candidateAdIds: ["stale_ad", "creative_1"],
      action: "pause",
      body: {
        businessId: "biz_1",
        providerAccountId: "act_1",
        adId: "stale_ad",
        creativeId: "creative_1",
      },
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "exact_ad_authority_required" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
