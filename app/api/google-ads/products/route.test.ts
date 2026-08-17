import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness: vi.fn() }));
vi.mock("@/lib/demo-business", () => ({ getDemoGoogleAdsProducts: vi.fn() }));
vi.mock("@/lib/google-ads/serving", () => ({
  getGoogleAdsProductsReport: vi.fn(),
}));
vi.mock("@/lib/google-ads/account-authority", () => ({
  googleAdsReadAccountAuthorityFailure: vi.fn(() => null),
  resolveGoogleAdsReadAccountAuthority: vi.fn(),
}));

const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const serving = await import("@/lib/google-ads/serving");
const { GET } = await import("@/app/api/google-ads/products/route");

function request(search = "?businessId=biz_1") {
  return new NextRequest(`https://app.test/api/google-ads/products${search}`);
}

describe("GET /api/google-ads/products — authorization boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false as never);
    vi.mocked(serving.getGoogleAdsProductsReport).mockResolvedValue({
      rows: [],
      summary: {},
      insights: {},
      meta: {},
      feed: null,
    } as never);
  });

  it("requires a businessId before any access check runs", async () => {
    const response = await GET(request("?"));
    expect(response.status).toBe(400);
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  /**
   * The boundary this surface inherits, unchanged by the Merchant Center work.
   * `minRole: "guest"` is the same shape its siblings use
   * (`/api/google-ads/diagnostics`, `/api/google-ads/keywords`); the feed block
   * is served through the SAME check, not around it.
   */
  it("gates the read on membership at the guest floor", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      businessId: "biz_1",
    } as never);

    await GET(request());

    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_1", minRole: "guest" }),
    );
  });

  it("returns the refusal and reads nothing when access is denied", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(serving.getGoogleAdsProductsReport).not.toHaveBeenCalled();
  });
});

describe("GET /api/google-ads/products — the feed block", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false as never);
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      businessId: "biz_1",
    } as never);
  });

  it("serves null when no Merchant Center read has landed", async () => {
    vi.mocked(serving.getGoogleAdsProductsReport).mockResolvedValue({
      rows: [],
      summary: {},
      insights: {},
      meta: {},
      feed: null,
    } as never);

    const body = await (await GET(request())).json();

    expect(body.feed).toBeNull();
  });

  it("passes the served tallies through untouched", async () => {
    vi.mocked(serving.getGoogleAdsProductsReport).mockResolvedValue({
      rows: [{ itemId: "AT-104", feedState: "disapproved" }],
      summary: {},
      insights: {},
      meta: {},
      feed: {
        totalItemsInFeed: 226,
        servingItemCount: 214,
        limitedItemCount: 9,
        disapprovedItemCount: 3,
        syncedAt: "2026-08-17T11:34:00.000Z",
        merchantCenterIds: ["512233"],
      },
    } as never);

    const body = await (await GET(request())).json();

    expect(body.feed).toEqual({
      totalItemsInFeed: 226,
      servingItemCount: 214,
      limitedItemCount: 9,
      disapprovedItemCount: 3,
      syncedAt: "2026-08-17T11:34:00.000Z",
      merchantCenterIds: ["512233"],
    });
    expect(body.rows[0].feedState).toBe("disapproved");
  });
});
