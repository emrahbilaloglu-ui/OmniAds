import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/integrations", () => ({ getIntegration: vi.fn() }));
vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

const query = vi.fn();
const providerFetch = vi.fn();
const url = "http://localhost/api/meta/creative-thumbnail?businessId=biz-1&providerAccountId=act_123456&creativeId=987654";

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/meta/creative-thumbnail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireBusinessAccess).mockResolvedValue({ session: {}, membership: {} } as never);
    vi.mocked(fetchAssignedAccountIds).mockResolvedValue(["act_123456"]);
    vi.mocked(getDb).mockReturnValue({ query } as never);
    query.mockResolvedValue([{ creative_id: "987654" }]);
    vi.mocked(getIntegration).mockResolvedValue({ status: "connected", access_token: "token" } as never);
    providerFetch.mockResolvedValue({ ok: true, json: async () => ({ thumbnail_url: "https://meta.example/fresh.jpg" }) });
    vi.stubGlobal("fetch", providerFetch);
  });

  it("rejects malformed IDs before reading account or provider data", async () => {
    const response = await GET(new NextRequest(url.replace("987654", "../bad")));
    expect(response.status).toBe(400);
    expect(requireBusinessAccess).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("requires business membership and assigned account scope", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValueOnce({ error: new Response(null, { status: 403 }) } as never);
    expect((await GET(new NextRequest(url))).status).toBe(403);
    expect(fetchAssignedAccountIds).not.toHaveBeenCalled();
    vi.mocked(fetchAssignedAccountIds).mockResolvedValueOnce([]);
    expect((await GET(new NextRequest(url))).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("does not ask Meta for a creative absent from the scoped warehouse", async () => {
    query.mockResolvedValueOnce([]);
    expect((await GET(new NextRequest(url))).status).toBe(404);
    expect(getIntegration).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("recovers an exact native Ad creative when separate media rows are absent", async () => {
    const nativeUrl = new URL(url.replace("biz-1", "11111111-1111-4111-8111-111111111111"));
    nativeUrl.searchParams.set("adId", "123456789");
    nativeUrl.searchParams.set("providerAccountRefId", "22222222-2222-4222-8222-222222222222");
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ creative_id: "987654" }]);
    const response = await GET(new NextRequest(nativeUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thumbnailUrl: "https://meta.example/fresh.jpg" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("FROM engine_v3_ad_decision_snapshots_daily");
    expect(query.mock.calls[1]?.[0]).toContain("provider_account_ref_id = $5::uuid");
    expect(query.mock.calls[1]?.[0]).toContain("ad_id = $4");
    expect(query.mock.calls[1]?.[0]).toContain("creative_id = $3");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "11111111-1111-4111-8111-111111111111", "act_123456", "987654",
      "123456789", "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("keeps an unproven native Ad creative unavailable", async () => {
    const nativeUrl = new URL(url.replace("biz-1", "11111111-1111-4111-8111-111111111111"));
    nativeUrl.searchParams.set("adId", "123456789");
    nativeUrl.searchParams.set("providerAccountRefId", "22222222-2222-4222-8222-222222222222");
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect((await GET(new NextRequest(nativeUrl))).status).toBe(404);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects a partial native membership handle", async () => {
    expect((await GET(new NextRequest(`${url}&adId=123456789`))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a fresh provider URL only for the matching creative and account", async () => {
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ thumbnailUrl: "https://meta.example/fresh.jpg" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("meta_creative_media"), ["biz-1", "act_123456", "987654"]);
    const providerUrl = providerFetch.mock.calls[0][0] as URL;
    expect(providerUrl.origin).toBe("https://graph.facebook.com");
    expect(providerUrl.pathname).toBe("/v25.0/987654");
    expect(providerUrl.searchParams.get("fields")).toBe("thumbnail_url");
  });

  it("keeps an unavailable provider image absent rather than fabricating a preview", async () => {
    providerFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ thumbnail_url: null }) });
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thumbnailUrl: null });
  });

  it("reports a temporary provider failure so the browser can retry", async () => {
    providerFetch.mockResolvedValueOnce({ ok: false });
    const response = await GET(new NextRequest(url));
    expect(response.status).toBe(502);
  });
});
