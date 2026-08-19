import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/history-read-model", () => ({
  readMetaHistoryAccounts: vi.fn(),
  readMetaHistoryAssignedAccountIds: vi.fn(),
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
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_1",
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

  it("does not offer an account the business has deselected", async () => {
    // This list is what an account picker offers. Offering a deselected account
    // would hand the operator a scope the journal endpoint then refuses — and,
    // before `is_selected` was honoured at all, one it quietly served.
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
      { id: "act_stale", name: "Removed", currency: "EUR", timezone: "UTC" },
    ]);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_1",
    ]);

    const response = await route.GET(
      new NextRequest("http://localhost/api/meta/history/accounts?businessId=business_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accounts).toEqual([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    ]);
  });

  it("is unavailable when the assignment cannot be read, not an empty list", async () => {
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockRejectedValue(
      new Error("assignment read failed"),
    );

    const response = await route.GET(
      new NextRequest("http://localhost/api/meta/history/accounts?businessId=business_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("meta_history_accounts_unavailable");
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
