import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/creatives/detail/route";

/*
 * The tri-state posture read, at its one database read.
 *
 * The route no longer asks `isDemoBusiness`, which manufactured "live" from a
 * database it could not read. It asks `readMetaBusinessDataPosture`, which
 * reads `businesses.is_demo_business` through this module and answers
 * `unverified` when it cannot — and `getDb()` throws under vitest, so without
 * this the route would correctly refuse every case in this file.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));
vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativeDetailPayload: vi.fn(),
}));

const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const businessMode = await import("@/lib/business-mode.server");
const access = await import("@/lib/access");
const creativesApi = await import("@/lib/meta/creatives-api");

describe("GET /api/meta/creatives/detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
  });

  it("rejects missing creative ids", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/creatives/detail?businessId=biz")
    );

    expect(response.status).toBe(400);
  });

  it("routes detail requests through the live creative payload path", async () => {
    vi.mocked(creativesApi.getMetaCreativeDetailPayload).mockResolvedValue({
      status: "ok",
      detail_preview: {
        creative_id: "cr_1",
        mode: "html",
        html: "<div />",
      },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives/detail?businessId=biz&creativeId=cr_1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.detail_preview.creative_id).toBe("cr_1");
    expect(creativesApi.getMetaCreativeDetailPayload).toHaveBeenCalledWith({
      businessId: "biz",
      creativeId: "cr_1",
      adId: null,
      adFormat: null,
      adFormats: null,
    });
  });

  it("passes ad context and requested preview format to the detail payload path", async () => {
    vi.mocked(creativesApi.getMetaCreativeDetailPayload).mockResolvedValue({
      status: "ok",
      detail_preview: {
        creative_id: "cr_1",
        target_id: "ad_1",
        target_type: "ad",
        mode: "html",
        ad_format: "INSTAGRAM_STORY",
        html: "<iframe />",
      },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives/detail?businessId=biz&creativeId=cr_1&adId=ad_1&adFormat=INSTAGRAM_STORY",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.detail_preview.target_type).toBe("ad");
    expect(creativesApi.getMetaCreativeDetailPayload).toHaveBeenCalledWith({
      businessId: "biz",
      creativeId: "cr_1",
      adId: "ad_1",
      adFormat: "INSTAGRAM_STORY",
      adFormats: null,
    });
  });

  it("passes ordered fallback preview formats to the detail payload path", async () => {
    vi.mocked(creativesApi.getMetaCreativeDetailPayload).mockResolvedValue({
      status: "ok",
      detail_preview: {
        creative_id: "cr_1",
        target_id: "ad_1",
        target_type: "ad",
        mode: "html",
        ad_format: "FACEBOOK_REELS_MOBILE",
        html: "<iframe />",
      },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/creatives/detail?businessId=biz&creativeId=cr_1&adId=ad_1&adFormats=INSTAGRAM_REELS,FACEBOOK_REELS_MOBILE",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.detail_preview.ad_format).toBe("FACEBOOK_REELS_MOBILE");
    expect(creativesApi.getMetaCreativeDetailPayload).toHaveBeenCalledWith({
      businessId: "biz",
      creativeId: "cr_1",
      adId: "ad_1",
      adFormat: null,
      adFormats: ["INSTAGRAM_REELS", "FACEBOOK_REELS_MOBILE"],
    });
  });
});
