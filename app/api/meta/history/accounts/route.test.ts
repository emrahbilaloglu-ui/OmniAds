import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/history-read-model", () => ({
  readMetaHistoryAccounts: vi.fn(),
  readMetaHistoryAssignedAccountIds: vi.fn(),
}));

// These cases are the proven-live path. D071 gates the route on posture, so a
// live posture is pinned here and the demo/unverified branches are covered in
// demo-posture-parity.test.ts.
vi.mock("@/lib/meta/business-data-posture", () => ({
  readMetaBusinessDataPosture: vi.fn(),
}));

// D078 R4: the route additionally reads the full assigned-account states to
// serve the deselected/historical read-only group. The policy formatter is
// the real one so the served copy is the shipped copy.
vi.mock("@/lib/meta/assigned-account-states", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/meta/assigned-account-states")
  >()),
  readMetaAssignedAccountStates: vi.fn(),
}));

const access = await import("@/lib/access");
const accountStates = await import("@/lib/meta/assigned-account-states");
const readModel = await import("@/lib/meta/history-read-model");
const posture = await import("@/lib/meta/business-data-posture");
const route = await import("@/app/api/meta/history/accounts/route");

describe("GET /api/meta/history/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(posture.readMetaBusinessDataPosture).mockResolvedValue("live");
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
    vi.mocked(accountStates.readMetaAssignedAccountStates).mockResolvedValue([
      {
        providerAccountId: "act_1",
        accountName: "Primary",
        selectionState: "selected",
        accountCurrency: "EUR",
        accountTimezone: "UTC",
        latestFactDate: "2026-08-21",
        spend14d: 100,
        latestDecisionAsOf: "2026-08-22",
        latestDecisionRows: 10,
        latestDecisionAuthorizedRows: 1,
        servedByCurrentSurfaces: true,
      },
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
      historicalAccounts: [],
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

    // D078 R4: the deselected-but-still-assigned identity is served as an
    // explicitly-marked read-only historical group instead of vanishing.
    vi.mocked(accountStates.readMetaAssignedAccountStates).mockResolvedValue([
      {
        providerAccountId: "act_1",
        accountName: "Primary",
        selectionState: "selected",
        accountCurrency: "EUR",
        accountTimezone: "UTC",
        latestFactDate: "2026-08-21",
        spend14d: 100,
        latestDecisionAsOf: "2026-08-22",
        latestDecisionRows: 10,
        latestDecisionAuthorizedRows: 1,
        servedByCurrentSurfaces: true,
      },
      {
        providerAccountId: "act_stale",
        accountName: "Removed",
        selectionState: "deselected_historical",
        accountCurrency: "EUR",
        accountTimezone: "UTC",
        latestFactDate: "2026-08-20",
        spend14d: 1652.29,
        latestDecisionAsOf: "2026-08-21",
        latestDecisionRows: 126,
        latestDecisionAuthorizedRows: 2,
        servedByCurrentSurfaces: false,
      },
    ]);

    const response = await route.GET(
      new NextRequest("http://localhost/api/meta/history/accounts?businessId=business_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accounts).toEqual([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    ]);
    expect(body.historicalAccounts).toHaveLength(1);
    const historical = body.historicalAccounts[0];
    expect(historical.id).toBe("act_stale");
    expect(historical.selectionState).toBe("deselected_historical");
    expect(historical.spend14d).toBe(1652.29);
    expect(historical.latestDecisionRows).toBe(126);
    expect(historical.policy).toContain("Deselected — read-only historical evidence");
    expect(historical.policy).toContain("explicit operator decision");
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
