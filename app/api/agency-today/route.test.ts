import { describe, expect, it, vi, beforeEach } from "vitest";

const getSessionFromRequest = vi.hoisted(() => vi.fn());
const listUserBusinesses = vi.hoisted(() => vi.fn());
const readAgencyTodayTotals = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ getSessionFromRequest }));
// The route joins client health to the canonical provider connection state, so
// its test has to supply one. Default: connected, which is the case the health
// assertions below vary against.
const connectionRows = vi.hoisted(() => ({
  value: [] as Array<{
    business_id: string;
    status: string;
    selected_count?: number;
  }>,
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: async () => connectionRows.value }),
}));
vi.mock("@/lib/access", () => ({ listUserBusinesses }));
vi.mock("@/lib/agency-today-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agency-today-store")>(
    "@/lib/agency-today-store",
  );
  return { ...actual, readAgencyTodayTotals };
});

import { GET } from "@/app/api/agency-today/route";

function request(search = "") {
  return {
    nextUrl: { searchParams: new URLSearchParams(search) },
  } as unknown as Parameters<typeof GET>[0];
}

function business(overrides: Record<string, unknown> = {}) {
  return {
    id: "biz-1",
    name: "Client One",
    currency: "USD",
    membershipStatus: "active",
    ...overrides,
  };
}

describe("GET /api/agency-today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionFromRequest.mockResolvedValue({ user: { id: "user-1" } });
    listUserBusinesses.mockResolvedValue([business()]);
    readAgencyTodayTotals.mockResolvedValue(
      new Map([
        [
          "biz-1",
          {
            businessId: "biz-1",
            spend: 1000,
            revenue: 3000,
            purchases: 20,
            lastSourceUpdatedAt: new Date().toISOString(),
          },
        ],
      ]),
    );
  });

  it("refuses an unauthenticated caller", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it("returns a ranked model for the caller's active clients", async () => {
    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.model.rows).toHaveLength(1);
    expect(body.model.rows[0].businessId).toBe("biz-1");
    expect(body.model.rows[0].roas).toBe(3);
  });

  it("reads every client in one call rather than one per client", async () => {
    listUserBusinesses.mockResolvedValue([
      business({ id: "a" }),
      business({ id: "b" }),
      business({ id: "c" }),
    ]);
    await GET(request());
    expect(readAgencyTodayTotals).toHaveBeenCalledTimes(1);
    expect(readAgencyTodayTotals.mock.calls[0][0].businessIds).toEqual(["a", "b", "c"]);
  });

  it("excludes memberships that are not active", async () => {
    listUserBusinesses.mockResolvedValue([
      business({ id: "a" }),
      business({ id: "b", membershipStatus: "invited" }),
    ]);
    await GET(request());
    expect(readAgencyTodayTotals.mock.calls[0][0].businessIds).toEqual(["a"]);
  });

  it("reports a failed read as a failure instead of an empty roster", async () => {
    readAgencyTodayTotals.mockRejectedValue(new Error("connection reset"));
    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.error).toBe("agency_today_unavailable");
    expect(body.model).toBeUndefined();
  });

  it("marks a client with no totals as unrankable rather than zero-spend", async () => {
    connectionRows.value = [
      { business_id: "biz-1", status: "connected", selected_count: 1 },
    ];
    readAgencyTodayTotals.mockResolvedValue(new Map());
    const body = await (await GET(request())).json();
    // A connected client with no totals is degraded, not unknown: we know the
    // connection works, so the absence of numbers is a real gap rather than an
    // unreadable state. Spend stays null -- it is missing, not zero.
    expect(body.model.rows[0].severity).toBe("attention");
    expect(body.model.rows[0].spend).toBeNull();
  });

  it("withholds a portfolio total across mixed currencies", async () => {
    listUserBusinesses.mockResolvedValue([
      business({ id: "a", currency: "USD" }),
      business({ id: "b", currency: "TRY" }),
    ]);
    readAgencyTodayTotals.mockResolvedValue(
      new Map([
        ["a", { businessId: "a", spend: 100, revenue: 200, purchases: 1, lastSourceUpdatedAt: null }],
        ["b", { businessId: "b", spend: 300, revenue: 900, purchases: 3, lastSourceUpdatedAt: null }],
      ]),
    );
    const body = await (await GET(request())).json();
    expect(body.model.portfolio.available).toBe(false);
    expect(body.model.portfolio.withheldReason).toBe("mixed_currency");
  });

  it("honours an explicit window and validates it", async () => {
    await GET(request("startDate=2026-07-01&endDate=2026-07-07"));
    expect(readAgencyTodayTotals.mock.calls[0][0]).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-07-07",
    });

    vi.clearAllMocks();
    readAgencyTodayTotals.mockResolvedValue(new Map());
    await GET(request("startDate=last-week&endDate=today"));
    expect(readAgencyTodayTotals.mock.calls[0][0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns an explicit empty model when the caller has no clients", async () => {
    listUserBusinesses.mockResolvedValue([]);
    const body = await (await GET(request())).json();
    expect(body.model.rows).toEqual([]);
    expect(body.model.portfolio.withheldReason).toBe("no_clients");
    expect(readAgencyTodayTotals).not.toHaveBeenCalled();
  });

  it("joins client health to the canonical connection state, not to whether totals exist", async () => {
    // The bug this closes: a client with a revoked token but yesterday's cached
    // numbers read "healthy" here while Integrations showed action required for
    // the same client at the same moment.
    for (const [status, expected] of [
      ["connected", "healthy"],
      ["revoked", "action_required"],
      ["expired", "action_required"],
      // Integrations maps error to action_required too; diverging here is how
      // the two surfaces disagreed about the same client.
      ["error", "action_required"],
    ] as const) {
      connectionRows.value = [
        { business_id: "biz-1", status, selected_count: 1 },
      ];
      const response = await GET(request());
      const body = (await response.json()) as {
        model: { rows: Array<{ dataHealth: string }> };
      };
      expect(body.model.rows[0]?.dataHealth, `status ${status}`).toBe(expected);
    }

    // Connected with nothing selected needs a person: no account can produce
    // data for this client. Reporting it as healthy is finding G0-F5 (an
    // unassigned account is indistinguishable from an empty one) on the
    // surface whose entire job is deciding who to look at.
    connectionRows.value = [
      { business_id: "biz-1", status: "connected", selected_count: 0 },
    ];
    const unassigned = await GET(request());
    const unassignedBody = (await unassigned.json()) as {
      model: { rows: Array<{ dataHealth: string }> };
    };
    expect(unassignedBody.model.rows[0]?.dataHealth).toBe("action_required");

    // No connection row at all is disconnected -- never "unknown", which would
    // read as "we could not tell" when in fact we know there is nothing.
    connectionRows.value = [];
    const disconnected = await GET(request());
    const body = (await disconnected.json()) as {
      model: { rows: Array<{ dataHealth: string }> };
    };
    expect(body.model.rows[0]?.dataHealth).toBe("disconnected");
  });
});
