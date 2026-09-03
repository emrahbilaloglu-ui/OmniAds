import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

// These cases are the proven-live path. D071 gates this route on posture, so a
// live posture is pinned here; the demo and unverified branches are covered in
// app/api/meta/history/accounts/demo-posture-parity.test.ts.
vi.mock("@/lib/meta/business-data-posture", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/meta/business-data-posture")
  >();
  return {
    ...actual,
    readMetaBusinessDataPosture: vi.fn(async () => "live" as const),
  };
});

vi.mock("@/lib/meta/assigned-account-states", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/meta/assigned-account-states")
  >()),
  readMetaAssignedAccountStates: vi.fn(),
}));

vi.mock("@/lib/meta/history-read-model", () => ({
  readMetaHistoryAccounts: vi.fn(),
  readMetaHistoryAssignedAccountIds: vi.fn(),
  readMetaHistoryJournal: vi.fn(),
}));

const access = await import("@/lib/access");
const accountStates = await import("@/lib/meta/assigned-account-states");
const readModel = await import("@/lib/meta/history-read-model");
const route = await import("@/app/api/meta/history/route");

const payload = {
  mode: "read_only" as const,
  scope: {
    businessId: "business_1",
    providerAccountId: "act_1",
    providerAccountName: "Primary",
    currency: "EUR",
    timezone: "UTC",
  },
  filters: {
    businessId: "business_1",
    providerAccountId: "act_1",
    kind: null,
    entity: null,
    label: null,
    outcome: null,
    from: null,
    to: null,
    q: null,
  },
  entries: [],
  page: { limit: 40, returned: 0, total: null, nextCursor: null },
  identityContract: {
    canonicalDecisionIdAvailable: false as const,
    grouping: "persisted_source_rows" as const,
    limitation: "Date-free identity unavailable.",
  },
  limitations: [],
};

describe("GET /api/meta/history", () => {
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
    vi.mocked(accountStates.readMetaAssignedAccountStates).mockResolvedValue([]);
    vi.mocked(readModel.readMetaHistoryJournal).mockResolvedValue(payload);
  });

  it("authenticates guest access and serves a private no-store read model", async () => {
    const request = new NextRequest(
      "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_1&kind=writes",
    );
    const response = await route.GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ mode: "read_only", entries: [] });
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "business_1",
      minRole: "guest",
    });
    expect(readModel.readMetaHistoryJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          businessId: "business_1",
          providerAccountId: "act_1",
          kind: "writes",
        }),
        account: expect.objectContaining({ id: "act_1", currency: "EUR" }),
      }),
    );
  });

  it("rejects missing explicit account scope before reading or authenticating", async () => {
    const response = await route.GET(
      new NextRequest("http://localhost/api/meta/history?businessId=business_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("missing_provider_account_id");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
  });

  it("rejects an account that is not assigned to the authorized business", async () => {
    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_other",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("provider_account_not_assigned");
    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
  });

  it("serves a deselected-but-still-bound account as a marked read-only historical scope (D078 R4)", async () => {
    // ITEM 11, amended by D078 R4. `business_provider_accounts` keeps the
    // identity binding forever and records the CURRENT selection in
    // `is_selected`. A deselected identity may hold spend and produced
    // decisions no other surface can show, so this READ-ONLY journal now
    // serves it — explicitly marked — while it stays out of the selected
    // picker group and out of every write scope. An identity with NO
    // binding at all still 404s (next test).
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
      { id: "act_stale", name: "Removed", currency: "EUR", timezone: "UTC" },
    ]);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_1",
    ]);
    vi.mocked(accountStates.readMetaAssignedAccountStates).mockResolvedValue([
      {
        providerAccountId: "act_stale",
        accountName: "Removed",
        selectionState: "deselected_historical",
        accountCurrency: "EUR",
        accountTimezone: "UTC",
        latestFactDate: "2026-08-20",
        spend14d: 10,
        latestDecisionAsOf: "2026-08-21",
        latestDecisionRows: 5,
        latestDecisionAuthorizedRows: 0,
        servedByCurrentSurfaces: false,
      },
    ]);

    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_stale",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accountScope).toBe("deselected_historical");
    expect(
      vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0].account.id,
    ).toBe("act_stale");
  });

  it("answers fail-closed UNAVAILABLE when the account-state authority read failed for a non-selected scope (C2.3)", async () => {
    // Absence is unproven while the authority read is down: a deselected
    // deep link must not become a confident "not assigned" 404.
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    ]);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_1",
    ]);
    vi.mocked(accountStates.readMetaAssignedAccountStates).mockRejectedValue(
      new Error("authority read failed"),
    );

    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_second",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("meta_history_account_scope_unavailable");
    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();

    // The SELECTED scope stays servable through the same failure — the
    // additive authority read may not take down the primary journal.
    const selected = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_1",
      ),
    );
    expect(selected.status).toBe(200);
  });

  it("still refuses an identity with no binding to this business at all", async () => {
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    ]);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_1",
    ]);
    vi.mocked(accountStates.readMetaAssignedAccountStates).mockResolvedValue([]);

    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_unbound",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("provider_account_not_assigned");
    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
  });

  it("serves the selected account and only the selected account", async () => {
    vi.mocked(readModel.readMetaHistoryAccounts).mockResolvedValue([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
      { id: "act_2", name: "Secondary", currency: "EUR", timezone: "UTC" },
    ]);
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockResolvedValue([
      "act_1",
    ]);

    const allowed = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_1",
      ),
    );
    expect(allowed.status).toBe(200);
    expect(
      vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0].account.id,
    ).toBe("act_1");

    // act_2 appears in History's projection but has NO assignment-state row:
    // an unbound identity stays refused (D078 R4 widened only BOUND
    // deselected identities).
    const refused = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_2",
      ),
    );
    expect(refused.status).toBe(404);
    expect(readModel.readMetaHistoryJournal).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when the assignment cannot be read, never permissive", async () => {
    // An assignment read that fails is unknown, not empty and not a licence.
    // Catching it and treating the projection as authoritative would serve a
    // journal the guard never approved; catching it and calling the business
    // unassigned would state a configuration fact nobody established.
    vi.mocked(readModel.readMetaHistoryAssignedAccountIds).mockRejectedValue(
      new Error("assignment read failed"),
    );

    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_1",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("meta_history_unavailable");
    expect(readModel.readMetaHistoryJournal).not.toHaveBeenCalled();
  });

  it("carries the caller's date window into the journal read", async () => {
    // ITEM 12's server half. The window arrives as `from`/`to` and is passed
    // through unchanged — the endpoint neither invents one nor widens one.
    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_1&from=2026-08-11&to=2026-08-17",
      ),
    );

    expect(response.status).toBe(200);
    const query = vi.mocked(readModel.readMetaHistoryJournal).mock.calls[0]?.[0]
      .query;
    expect(query?.from).toBe("2026-08-11");
    expect(query?.to).toBe("2026-08-17");
  });

  it("returns authorization failures without reading journal tables", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await route.GET(
      new NextRequest(
        "http://localhost/api/meta/history?businessId=business_1&providerAccountId=act_1",
      ),
    );

    expect(response.status).toBe(403);
    expect(readModel.readMetaHistoryAccounts).not.toHaveBeenCalled();
  });

  it("exports no POST handler", () => {
    expect("POST" in route).toBe(false);
  });
});
