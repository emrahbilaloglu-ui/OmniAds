import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const requireBusinessAccess = vi.fn();
const getSearchConsoleStatus = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/search-console-status", () => ({ getSearchConsoleStatus }));

const { GET } = await import("@/app/api/google-search-console/status/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function request(query: string) {
  return new NextRequest(
    `https://app.example/api/google-search-console/status${query}`,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  requireBusinessAccess.mockResolvedValue({ session: { userId: "u1" } });
  getSearchConsoleStatus.mockResolvedValue({
    provider: "search_console",
    connected: true,
    state: "action_required",
    connectedAt: "2026-08-15T09:00:00.000Z",
    site: { url: "sc-domain:aurora.example", type: "domain" },
    siteReady: true,
    googleAuthority: { connected: false, hasSearchConsoleScope: false },
    backfillPercent: null,
    snapshotReady: false,
    snapshotAt: null,
    latestSync: null,
    errorMessage: null,
  });
});

describe("GET /api/google-search-console/status", () => {
  it("rejects a request with no businessId before touching the status reader", async () => {
    const response = await GET(request(""));
    expect(response.status).toBe(400);
    expect(requireBusinessAccess).not.toHaveBeenCalled();
    expect(getSearchConsoleStatus).not.toHaveBeenCalled();
  });

  it("guards the read at minRole guest, exactly as its sibling sites read does", async () => {
    await GET(request(`?businessId=${BUSINESS_ID}`));
    expect(requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "guest" }),
    );
  });

  it("returns the refusal from requireBusinessAccess and reads nothing", async () => {
    requireBusinessAccess.mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const response = await GET(request(`?businessId=${BUSINESS_ID}`));

    expect(response.status).toBe(403);
    expect(getSearchConsoleStatus).not.toHaveBeenCalled();
  });

  it("serves the broken-authority verdict uncached", async () => {
    const response = await GET(request(`?businessId=${BUSINESS_ID}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      provider: "search_console",
      state: "action_required",
      googleAuthority: { connected: false, hasSearchConsoleScope: false },
    });
  });
});
