import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const access = await import("@/lib/access");
const integrations = await import("@/lib/integrations");
const db = await import("@/lib/db");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    campaign: {
      name: "Launchpad test",
      objective: "OUTCOME_SALES",
      specialAdCategories: [],
    },
    budget: {
      mode: "CBO",
      schedule: "daily",
      amountMinor: 5000,
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    },
    creatives: [{ creativeId: "creative_1", name: "Creative 1" }],
    adSets: [
      {
        clientId: "adset-1",
        name: "Ad set 1",
        optimizationGoal: "OFFSITE_CONVERSIONS",
        pixelId: "pixel_1",
        customEventType: "PURCHASE",
        targeting: {
          countries: ["US"],
          ageMin: 18,
          ageMax: 65,
          advantageAudience: true,
          advantagePlacements: true,
        },
        attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
      },
    ],
    ...overrides,
  };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/launchpad/meta/validate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function mockDbStatus(status: string | null) {
  const sql = vi.fn(async () => [
    { creative_id: "creative_1", effective_status: status },
  ]);
  vi.mocked(db.getDb).mockReturnValue(sql as never);
}

describe("POST /api/launchpad/meta/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      provider_account_id: "act_123",
      access_token: "secret-token",
    } as never);
    mockDbStatus("ACTIVE");
  });

  it("returns a blocker when the selected pixel is missing", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ account_status: 1 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const response = await POST(
      request({ businessId: BUSINESS_ID, payload: payload() }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pixel_not_active" }),
      ]),
    );
  });

  it("returns a blocker when a selected creative is rejected", async () => {
    mockDbStatus("REJECTED");
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ account_status: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "pixel_1", name: "Pixel", is_unavailable: false }],
        }),
      );

    const response = await POST(
      request({ businessId: BUSINESS_ID, payload: payload() }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "creative_rejected" }),
      ]),
    );
  });

  it("returns ok for valid input", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ account_status: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "pixel_1", name: "Pixel", is_unavailable: false }],
        }),
      );

    const response = await POST(
      request({ businessId: BUSINESS_ID, payload: payload() }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, blockers: [] });
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: BUSINESS_ID,
      minRole: "collaborator",
    });
  });

  it("returns auth errors before validation work", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await POST(
      request({ businessId: BUSINESS_ID, payload: payload() }),
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
