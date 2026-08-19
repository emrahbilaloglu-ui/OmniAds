import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

// Mocked at the assignment SOURCE, not at `resolveAssignedMetaLaunchAccount`,
// so these tests exercise the real intersection and the real failure mapping
// (403 not-assigned / 503 unavailable) rather than a stubbed verdict.
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const assignments = await import("@/lib/provider-account-assignments");
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

function request(url: string) {
  return new NextRequest(url);
}

describe("GET /api/launchpad/meta/campaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
  });

  it("returns active OUTCOME_SALES campaigns with server-side aggregates", async () => {
    const sql = vi.fn(async () => [
      {
        id: "cmp_1",
        name: "Sales campaign",
        objective: "OUTCOME_SALES",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        daily_budget: 50,
        lifetime_budget: null,
        is_adset_budget_sharing_enabled: true,
        adset_count: 3,
        last_spend_28d: 1234.5,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&providerAccountId=act_1`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.campaigns).toEqual([
      {
        id: "cmp_1",
        name: "Sales campaign",
        objective: "OUTCOME_SALES",
        status: "ACTIVE",
        effectiveStatus: "ACTIVE",
        dailyBudgetMinor: 5000,
        lifetimeBudgetMinor: null,
        isAdsetBudgetSharingEnabled: true,
        adsetCount: 3,
        lastSpend28d: 1234.5,
      },
    ]);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: BUSINESS_ID,
      minRole: "collaborator",
    });
  });

  it("widens objective filtering when objective=ALL", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&providerAccountId=act_1&objective=ALL`,
      ),
    );

    expect((sql.mock.calls[0] as unknown[])).toContain(null);
  });

  // A launch is written into exactly one ad account and `meta-validation`
  // refuses a target from any other one at Create time. Listing every campaign
  // in the business lets the operator build a whole launch against a foreign
  // campaign, so the read is account-scoped and refuses when no account is
  // named rather than widening to the business.
  it("scopes the campaign list to the requested provider account", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&providerAccountId=act_1`,
      ),
    );

    expect(String((sql.mock.calls[0] as unknown[])?.[0])).toContain(
      "campaign.provider_account_id =",
    );
    expect((sql.mock.calls[0] as unknown[])).toContain("act_1");
  });

  it("refuses a business-wide read instead of widening past one account", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("missing_provider_account_id");
    expect(sql).not.toHaveBeenCalled();
  });
  // ---------------------------------------------------------------------
  // LAW: filtering by `provider_account_id` is NOT authorization.
  //
  // The warehouse keeps a row for every account this business has ever synced,
  // keyed by (business_id, provider_account_id). An account that was assigned
  // last month and removed today still has campaigns sitting under this
  // business, so a WHERE clause fed straight from the URL answers a request for
  // a stale account with real rows — and Launchpad then offers them as launch
  // targets. Membership proves the tenant; only the CURRENT assignment proves
  // the account. Both are proven before any statement is issued.
  // ---------------------------------------------------------------------

  it("answers only the requested assigned account (A -> A)", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_A", "act_B"],
    } as never);
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&providerAccountId=act_A`,
      ),
    );

    expect(response.status).toBe(200);
    const bound = sql.mock.calls[0] as unknown[];
    expect(bound).toContain("act_A");
    expect(bound).not.toContain("act_B");
  });

  it("answers only the requested assigned account (B -> B)", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_A", "act_B"],
    } as never);
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&providerAccountId=act_B`,
      ),
    );

    expect(response.status).toBe(200);
    const bound = sql.mock.calls[0] as unknown[];
    expect(bound).toContain("act_B");
    expect(bound).not.toContain("act_A");
  });

  it("refuses an unassigned or stale account with NO query issued", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_A", "act_B"],
    } as never);
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&providerAccountId=act_C`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("provider_account_not_assigned");
    expect(sql).not.toHaveBeenCalled();
  });

  // A read failure is never an empty success and never a wider read. "I could
  // not check" is not "there was nothing to check", so this answers unavailable
  // rather than dropping the account predicate and returning the business.
  it("answers unavailable when the assignment source cannot be read", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockRejectedValue(
      new Error("assignments unavailable"),
    );
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      request(
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&providerAccountId=act_1`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("provider_account_scope_unavailable");
    expect(body.campaigns).toBeUndefined();
    expect(sql).not.toHaveBeenCalled();
  });
});
