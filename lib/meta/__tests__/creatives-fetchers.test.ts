import { afterEach, describe, expect, it, vi } from "vitest";
import {
  batchFetchAdsByIds,
  fetchAdImageUrlMap,
  fetchAdCreativeBasicsByAdIds,
  fetchAccountInsights,
  fetchCreativeDetailsMap,
  getCreativeDetailAdvancedFields,
  getCreativeDetailFields,
  getCreativeMediaFields,
  getCreativeSummaryFields,
  getNestedCreativeMediaFields,
  getNestedCreativeSummaryFields,
} from "@/lib/meta/creatives-fetchers";

describe("fetchAccountInsights", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows Meta insights paging so spend rows beyond the first page are retained", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ ad_id: "ad_zero", spend: "0", date_start: "2026-05-03" }],
            paging: { next: "https://graph.facebook.com/v25.0/next-page" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ ad_id: "ad_spend", spend: "12.34", date_start: "2026-05-03" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                ad_id: "ad_spend",
                date_start: "2026-05-03",
                attribution_setting: "1d_view_7d_click",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const rows = await fetchAccountInsights(
      "act_1",
      "token-paged-insights-test",
      "2026-05-03",
      "2026-05-03"
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const baseRequestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(baseRequestUrl.searchParams.get("fields")).toContain("video_thruplay_watched_actions");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://graph.facebook.com/v25.0/next-page");
    const richRequestUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(richRequestUrl.searchParams.get("fields")).toContain("quality_ranking");
    expect(richRequestUrl.searchParams.get("filtering")).toContain('"field":"ad.id"');
    expect(rows).toEqual([
      { ad_id: "ad_zero", spend: "0", date_start: "2026-05-03" },
      {
        ad_id: "ad_spend",
        spend: "12.34",
        date_start: "2026-05-03",
        attribution_setting: "1d_view_7d_click",
      },
    ]);
  });
});

describe("fetchAdImageUrlMap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses only Graph-supported adimages fields and maps resolved URLs by hash", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ hash: "ABC123", url: "https://example.com/image.jpg" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAdImageUrlMap("act_1", [" ABC123 ", "ABC123"], "token-adimages-test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const fields = requestUrl.searchParams.get("fields") ?? "";

    expect(fields).toContain("hash");
    expect(fields).toContain("url");
    expect(fields).toContain("url_128");
    expect(fields).toContain("permalink_url");
    expect(fields).not.toContain("url_256");
    expect(requestUrl.searchParams.get("hashes")).toBe(JSON.stringify(["ABC123"]));
    expect(result.get("ABC123")).toBe("https://example.com/image.jpg");
    expect(result.get("abc123")).toBe("https://example.com/image.jpg");
  });
});

describe("creative detail field contracts", () => {
  it("keeps unsupported catalog fields out of the safe detail request", () => {
    expect(getCreativeDetailFields()).not.toMatch(/(^|[{,])catalog_id(?=[,}])/);
    expect(getCreativeDetailFields()).not.toMatch(/(^|[{,])product_set_id(?=[,}])/);
    expect(getCreativeDetailAdvancedFields()).not.toMatch(/(^|[{,])catalog_id(?=[,}])/);
    expect(getCreativeDetailAdvancedFields()).not.toMatch(/(^|[{,])product_set_id(?=[,}])/);
  });

  it("keeps thumbnail_url out of ids and nested ad creative field sets", () => {
    expect(getCreativeDetailFields().startsWith("id,name,object_story_spec")).toBe(true);
    expect(getCreativeDetailFields()).toContain("object_story_id");
    expect(getCreativeDetailFields()).toContain("effective_object_story_id");
    expect(getCreativeMediaFields().startsWith("id,name,object_type,video_id,object_story_spec")).toBe(true);
    expect(getCreativeMediaFields()).toContain("object_story_id");
    expect(getCreativeMediaFields()).toContain("effective_object_story_id");
    expect(getCreativeSummaryFields()).not.toContain("thumbnail_url");
    expect(getCreativeSummaryFields()).not.toContain("image_url");
    expect(getCreativeSummaryFields()).not.toContain("image_hash");
    expect(getCreativeSummaryFields()).toContain("template_data");
    expect(getCreativeSummaryFields()).toContain("object_story_id");
    expect(getCreativeSummaryFields()).toContain("effective_object_story_id");
    expect(getCreativeSummaryFields()).not.toMatch(/(^|[{,])catalog_id(?=[,}])/);
    expect(getCreativeSummaryFields()).not.toMatch(/(^|[{,])product_set_id(?=[,}])/);
    expect(getNestedCreativeMediaFields().startsWith("id,name,object_type,video_id,object_story_spec")).toBe(true);
    expect(getNestedCreativeMediaFields()).toContain("object_story_id");
    expect(getNestedCreativeMediaFields()).toContain("effective_object_story_id");
    expect(getNestedCreativeSummaryFields()).not.toContain("thumbnail_url");
    expect(getNestedCreativeSummaryFields()).not.toContain("image_url");
    expect(getNestedCreativeSummaryFields()).not.toContain("image_hash");
    expect(getNestedCreativeSummaryFields()).toContain("template_data");
    expect(getNestedCreativeSummaryFields()).toContain("object_story_id");
    expect(getNestedCreativeSummaryFields()).toContain("effective_object_story_id");
    expect(getNestedCreativeSummaryFields()).not.toMatch(/(^|[{,])catalog_id(?=[,}])/);
    expect(getNestedCreativeSummaryFields()).not.toMatch(/(^|[{,])product_set_id(?=[,}])/);
    expect(getCreativeDetailFields()).not.toContain("image_hash,");
    expect(getCreativeMediaFields()).not.toContain("image_hash,");
    expect(getCreativeMediaFields()).not.toMatch(/(^|[{,])catalog_id(?=[,}])/);
    expect(getCreativeMediaFields()).not.toMatch(/(^|[{,])product_set_id(?=[,}])/);
    expect(getCreativeMediaFields()).not.toContain("link_urls{website_url,display_url,url}");
    expect(getCreativeSummaryFields()).not.toContain("link_urls{website_url,display_url,url}");
    expect(getCreativeDetailFields()).not.toContain("link_urls{website_url,display_url,url}");
    expect(getNestedCreativeMediaFields()).not.toContain("image_hash,");
    expect(getNestedCreativeMediaFields()).not.toContain("link_urls{website_url,display_url,url}");
    expect(getNestedCreativeSummaryFields()).not.toContain("link_urls{website_url,display_url,url}");
  });
});

describe("fetchCreativeDetailsMap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps safe detail results without issuing unsupported advanced fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            "cr_1": {
              id: "cr_1",
              object_type: "VIDEO",
              thumbnail_url: "https://example.com/thumb.jpg",
              object_story_spec: {
                template_data: { link: "https://example.com" },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCreativeDetailsMap(["cr_1"], "token-fetchers-test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const fields = requestUrl.searchParams.get("fields") ?? "";

    expect(fields).toContain("object_story_id");
    expect(fields).toContain("effective_object_story_id");
    expect(result.get("cr_1")).toMatchObject({
      id: "cr_1",
      object_type: "VIDEO",
      thumbnail_url: "https://example.com/thumb.jpg",
    });
  });
});

describe("batchFetchAdsByIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps metadata batch ad requests on the Graph-supported field set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ad_1: { id: "ad_1", creative: { id: "cr_1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await batchFetchAdsByIds(["ad_1"], "token-fetchers-test", "metadata");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const fields = requestUrl.searchParams.get("fields") ?? "";

    expect(fields).toContain("adset{id,name,daily_budget,lifetime_budget");
    expect(fields).toContain("campaign{id,name,objective,daily_budget,lifetime_budget");
    expect(fields).not.toContain("status,bid_strategy");
    expect(fields).not.toContain("status,optimization_goal");
    expect(fields).not.toContain("status,attribution_setting");
    expect(fields).toContain("promoted_object{pixel_id,custom_event_type,custom_conversion_id}");
    expect(fields).toContain("template_data");
    expect(fields).toContain("object_story_id");
    expect(fields).toContain("effective_object_story_id");
    expect(fields).not.toContain("link_urls{website_url,display_url,url}");
    expect(fields).not.toMatch(/(^|[{,])catalog_id(?=[,}])/);
    expect(fields).not.toMatch(/(^|[{,])product_set_id(?=[,}])/);
  });
});

describe("fetchAdCreativeBasicsByAdIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps direct ad fallback requests on the Graph-supported field set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "ad_1", creative: { id: "cr_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchAdCreativeBasicsByAdIds(["ad_1"], "token-fetchers-test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const fields = requestUrl.searchParams.get("fields") ?? "";

    expect(fields).toContain("adset{id,name}");
    expect(fields).not.toContain("promoted_object");
    expect(fields).toContain("template_data");
    expect(fields).toContain("object_story_id");
    expect(fields).toContain("effective_object_story_id");
    expect(fields).not.toContain("link_urls{website_url,display_url,url}");
    expect(fields).not.toMatch(/(^|[{,])catalog_id(?=[,}])/);
    expect(fields).not.toMatch(/(^|[{,])product_set_id(?=[,}])/);
  });
});
