import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

describe("GET /api/launchpad/meta/pixels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
  });

  it("returns pixels with usage stats and marks the top pixel as most used", async () => {
    const sql = vi.fn(async () => [
      {
        id: "pixel_2",
        name: "Primary",
        last_spend_28d: 900,
        last_updated_at: "2026-05-05T00:00:00.000Z",
      },
      {
        id: "pixel_1",
        name: "Backup",
        last_spend_28d: 100,
        last_updated_at: "2026-05-04T00:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      new NextRequest(`http://localhost/api/launchpad/meta/pixels?businessId=${BUSINESS_ID}`),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.pixels).toEqual([
      {
        id: "pixel_2",
        name: "Primary",
        lastSpend28d: 900,
        lastUpdatedAt: "2026-05-05T00:00:00.000Z",
        isMostUsed: true,
      },
      {
        id: "pixel_1",
        name: "Backup",
        lastSpend28d: 100,
        lastUpdatedAt: "2026-05-04T00:00:00.000Z",
        isMostUsed: false,
      },
    ]);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: BUSINESS_ID,
      minRole: "guest",
    });
  });
});
