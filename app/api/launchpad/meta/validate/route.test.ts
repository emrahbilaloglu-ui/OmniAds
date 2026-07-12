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

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

const access = await import("@/lib/access");
const integrations = await import("@/lib/integrations");
const db = await import("@/lib/db");
const assignments = await import("@/lib/provider-account-assignments");
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
  const scopedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? { providerAccountId: "act_123", ...body }
      : body;
  return new NextRequest("http://localhost/api/launchpad/meta/validate", {
    method: "POST",
    body: JSON.stringify(scopedBody),
    headers: { "Content-Type": "application/json" },
  });
}

function mockDbStatus(status: string | null) {
  const sql = vi.fn(async () => [
    {
      creative_id: "creative_1",
      resolved_creative_id: "creative_1",
      effective_status: status,
    },
  ]);
  vi.mocked(db.getDb).mockReturnValue(sql as never);
}

function mockAddToExistingDb(input: {
  targetProviderAccountId: string;
  sourceProviderAccountId: string;
}) {
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("FROM meta_adset_dimensions")) {
      return [
        {
          campaign_id: "cmp_1",
          campaign_name_current: "Campaign",
          campaign_name_historical: null,
          adset_id: "adset_1",
          adset_name_current: "Ad set",
          adset_name_historical: null,
          adset_status: "ACTIVE",
          provider_account_id: input.targetProviderAccountId,
        },
      ];
    }
    if (query.includes("FROM unnest") && query.includes("meta_creative_daily")) {
      return [
        {
          creative_id: "creative_1",
          creative_name: "Creative 1",
          effective_status: "ACTIVE",
          source_ad_id: "source_ad_1",
          provider_account_id: input.sourceProviderAccountId,
        },
      ];
    }
    return [];
  });
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
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_123", "act_222"],
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

  it("blocks duplicate mode when source and target ad accounts differ", async () => {
    mockAddToExistingDb({
      targetProviderAccountId: "act_222",
      sourceProviderAccountId: "act_111",
    });

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        providerAccountId: "act_222",
        payload: {
          mode: "add_to_existing",
          copyMode: "reuse_creative",
          targets: [{ targetCampaignId: "cmp_1", targetAdsetId: "adset_1" }],
          creativeIds: ["creative_1"],
          creatives: [{ creativeId: "creative_1", sourceAdId: "source_ad_1" }],
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cross_account_duplicate_not_supported" }),
      ]),
    );
  });

  it("blocks recreate mode until the source creative is explicitly in account scope", async () => {
    mockAddToExistingDb({
      targetProviderAccountId: "act_222",
      sourceProviderAccountId: "act_111",
    });

    const response = await POST(
      request({
        businessId: BUSINESS_ID,
        providerAccountId: "act_222",
        payload: {
          mode: "add_to_existing",
          copyMode: "rebuild_creative",
          targets: [{ targetCampaignId: "cmp_1", targetAdsetId: "adset_1" }],
          creativeIds: ["creative_1"],
          creatives: [{ creativeId: "creative_1", sourceAdId: "source_ad_1" }],
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "creative_account_mismatch" }),
      ]),
    );
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
