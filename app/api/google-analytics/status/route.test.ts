import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * The GA4 status read must refuse before it reads anything, and it must refuse
 * at the same threshold every other provider status read uses.
 */
const requireBusinessAccess = vi.fn();
const getGoogleAnalyticsStatus = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/google-analytics-status", () => ({ getGoogleAnalyticsStatus }));

const { GET } = await import("@/app/api/google-analytics/status/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function request(query: string) {
  return new NextRequest(
    `https://app.example/api/google-analytics/status${query}`,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  requireBusinessAccess.mockResolvedValue({ session: { userId: "u1" } });
  getGoogleAnalyticsStatus.mockResolvedValue({
    provider: "ga4",
    connected: true,
    state: "syncing",
    connectedAt: "2026-08-15T09:00:00.000Z",
    property: { id: "properties/1", name: "Aurora" },
    propertyReady: true,
    backfillPercent: null,
    snapshotReady: false,
    snapshotAt: null,
    latestSync: null,
    errorMessage: null,
  });
});

describe("GET /api/google-analytics/status", () => {
  it("rejects a request with no businessId before touching the status reader", async () => {
    const response = await GET(request(""));
    expect(response.status).toBe(400);
    expect(requireBusinessAccess).not.toHaveBeenCalled();
    expect(getGoogleAnalyticsStatus).not.toHaveBeenCalled();
  });

  it("guards the read at minRole guest, the shape its sibling status reads use", async () => {
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
    expect(getGoogleAnalyticsStatus).not.toHaveBeenCalled();
  });

  it("serves the status uncached", async () => {
    const response = await GET(request(`?businessId=${BUSINESS_ID}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      provider: "ga4",
      state: "syncing",
      backfillPercent: null,
    });
  });
});
