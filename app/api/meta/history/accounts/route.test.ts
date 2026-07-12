import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/history-read-model", () => ({
  readMetaHistoryAccounts: vi.fn(),
}));

const access = await import("@/lib/access");
const readModel = await import("@/lib/meta/history-read-model");
const route = await import("@/app/api/meta/history/accounts/route");

describe("GET /api/meta/history/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "business_1" } as never,
    });
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    ]);
  });

  it("returns only the authenticated business account scopes", async () => {
    const request = new NextRequest(
      "http://localhost/api/meta/history/accounts?businessId=business_1",
    );
    const response = await route.GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      mode: "read_only",
      businessId: "business_1",
      accounts: [{ id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" }],
    });
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "business_1",
      minRole: "guest",
    });
  });

  it("returns auth errors before account reads", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const response = await route.GET(
      new NextRequest("http://localhost/api/meta/history/accounts?businessId=business_1"),
    );

    expect(response.status).toBe(403);
    expect(readModel.readMetaHistoryAccounts).not.toHaveBeenCalled();
  });

  it("exports no POST handler", () => {
    expect("POST" in route).toBe(false);
  });
});
