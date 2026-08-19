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

describe("GET /api/launchpad/meta/adsets", () => {
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

  it("returns active ad sets in a campaign with ad count and 7d aggregates", async () => {
    const sql = vi.fn(async () => [
      {
        id: "adset_1",
        name: "Prospecting",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        optimization_goal: "OFFSITE_CONVERSIONS",
        billing_event: "IMPRESSIONS",
        pixel_id: "pixel_1",
        custom_event_type: "PURCHASE",
        daily_budget: 25,
        lifetime_budget: null,
        attribution_spec: [
          { event_type: "CLICK_THROUGH", window_days: 7 },
          { event_type: "VIEW_THROUGH", window_days: 1 },
        ],
        targeting: {
          geo_locations: { countries: ["US", "CA"] },
          age_min: 21,
          age_max: 55,
          targeting_automation: { advantage_audience: 1 },
        },
        current_ad_count: 8,
        last_7d_spend: 400,
        last_7d_roas: 2.5,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}&providerAccountId=act_1&campaignId=cmp_1`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.adsets[0]).toMatchObject({
      id: "adset_1",
      pixelId: "pixel_1",
      currentAdCount: 8,
      last7dSpend: 400,
      last7dRoas: 2.5,
      dailyBudgetMinor: 2500,
      targeting: {
        geoCountries: ["US", "CA"],
        ageMin: 21,
        ageMax: 55,
        advantageAudience: true,
      },
    });
    expect(body.adsets[0].attributionSpec).toEqual([
      { event_type: "CLICK_THROUGH", window_days: 7 },
      { event_type: "VIEW_THROUGH", window_days: 1 },
    ]);
    // Account-scoped for the same reason the campaign list is: a target the
    // launch account does not own is only refused at Create time.
    expect(String((sql.mock.calls[0] as unknown[])?.[0])).toContain(
      "adset.provider_account_id =",
    );
    expect((sql.mock.calls[0] as unknown[])).toContain("act_1");
  });

  it("requires a campaign id", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}`),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("missing_campaign_id");
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  // Refusing beats widening: a business-wide ad-set list offers targets from
  // another assigned account, and the operator only discovers it when the
  // server rejects the Create naming an account they never chose.
  it("refuses a business-wide read instead of widening past one account", async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}&campaignId=cmp_1`,
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
      new NextRequest(
        `http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}&campaignId=cmp_1&providerAccountId=act_A`,
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
      new NextRequest(
        `http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}&campaignId=cmp_1&providerAccountId=act_B`,
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
      new NextRequest(
        `http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}&campaignId=cmp_1&providerAccountId=act_C`,
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
      new NextRequest(
        `http://localhost/api/launchpad/meta/adsets?businessId=${BUSINESS_ID}&campaignId=cmp_1&providerAccountId=act_1`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("provider_account_scope_unavailable");
    expect(body.adsets).toBeUndefined();
    expect(sql).not.toHaveBeenCalled();
  });
});
