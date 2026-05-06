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
      request(`http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}`),
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
        `http://localhost/api/launchpad/meta/campaigns?businessId=${BUSINESS_ID}&objective=ALL`,
      ),
    );

    expect((sql.mock.calls[0] as unknown[])).toContain(null);
  });
});
