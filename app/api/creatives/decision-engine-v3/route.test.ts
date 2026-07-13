import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  WarehouseDataSource,
  type DecisionResponse,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine";
import { requireBusinessAccess } from "@/lib/access";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { resolveDataSource } from "./data-source";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(),
}));

vi.mock("@/lib/meta/campaign-labels", () => ({
  readMetaCampaignLabels: vi.fn(),
}));

const previousDataSourceFlag = process.env.DECISION_ENGINE_V3_DATA_SOURCE;
const previousCampaignContextMode = process.env.CAMPAIGN_CONTEXT_MODE;

function makeFlags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz-1",
    enabled: true,
    surfaceVisible: false,
    shadowOnly: true,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
    ...overrides,
  };
}

function mockBusinessAccess(businessId = "biz-1") {
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: {
      user: {
        id: "user-1",
        email: "operator@adsecute.com",
      },
    } as never,
    membership: {
      id: "membership-1",
      userId: "user-1",
      businessId,
      role: "guest",
      status: "active",
      joinedAt: "2026-05-04T00:00:00.000Z",
    },
  });
}

function mockAccessError(status: 401 | 403) {
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    error: NextResponse.json(
      {
        error: "auth_error",
        message:
          status === 401
            ? "Authentication required."
            : "You do not have access to this business.",
      },
      { status },
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CAMPAIGN_CONTEXT_MODE = "legacy_labels";
  mockBusinessAccess();
  vi.mocked(readMetaCampaignLabels).mockResolvedValue([
    {
      businessId: "biz-1",
      campaignId: "mock-campaign-001",
      kind: "main",
      testDimension: null,
      source: "user",
      providerAccountId: null,
      campaignName: null,
      labeledBy: "user-1",
      labeledAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    },
  ]);
  vi.mocked(resolveEngineV3Flags).mockImplementation(async (businessId) =>
    makeFlags({ businessId: String(businessId) }),
  );
});

afterEach(() => {
  if (previousDataSourceFlag === undefined) {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;
  } else {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = previousDataSourceFlag;
  }
  if (previousCampaignContextMode === undefined) {
    delete process.env.CAMPAIGN_CONTEXT_MODE;
  } else {
    process.env.CAMPAIGN_CONTEXT_MODE = previousCampaignContextMode;
  }
});

describe("GET /api/creatives/decision-engine-v3", () => {
  it("uses MockDataSource when DECISION_ENGINE_V3_DATA_SOURCE=mock", async () => {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = "mock";

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&asOf=2026-05-04",
      ),
    );
    const payload = (await response.json()) as DecisionResponse;

    expect(response.status).toBe(200);
    expect(payload.dataSource).toBe("mock");
    expect(payload.businessId).toBe("biz-1");
    expect(payload.flags).toMatchObject({
      businessId: "biz-1",
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    });
    expect(payload.dataHealth.worstTier).toBe("none");
    expect(payload.dataHealth.degraded).toBe(false);
    expect(payload.dataHealth.calibration).toBeDefined();
    expect(payload.dataHealth.lifecycle).toBeDefined();
    expect(payload.dataHealth.decisions).toBeDefined();
    expect(payload.accountProfile).toMatchObject({
      businessId: "biz-1",
      preset: "balanced",
      spendUnitSource: "meta_derived_aov",
      scope: { type: "account", id: "*" },
    });
    expect(payload.scope).toEqual({ type: "account", id: "*" });
    expect(payload.decisions).toHaveLength(3);
    expect(payload.decisions[0]?.campaignLabelStatus).toBe("labeled");
    expect(payload.decisions[0]?.campaignKind).toBe("main");
    expect(requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: "biz-1",
      minRole: "guest",
    });
  });

  it("passes campaignId through to campaign-scoped profile resolution", async () => {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = "mock";

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&campaignId=mock-campaign-001&asOf=2026-05-04",
      ),
    );
    const payload = (await response.json()) as DecisionResponse;

    expect(response.status).toBe(200);
    expect(payload.scope).toEqual({
      type: "campaign",
      id: "mock-campaign-001",
    });
    expect(payload.accountProfile.scope).toEqual(payload.scope);
    expect(payload.decisions).toHaveLength(3);
  });

  it("adds missing campaign label context when labels are absent", async () => {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = "mock";
    vi.mocked(readMetaCampaignLabels).mockResolvedValue([]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&asOf=2026-05-04",
      ),
    );
    const payload = (await response.json()) as DecisionResponse;

    expect(response.status).toBe(200);
    expect(payload.decisions[0]).toMatchObject({
      campaignLabelStatus: "unlabeled",
      campaignKind: null,
      blockedActionType: null,
    });
    expect(payload.decisions[0]?.badges.map((badge) => badge.type)).toContain(
      "unlabeled_campaign_context",
    );
  });

  it("returns 403 for an authenticated user with no membership", async () => {
    mockAccessError(403);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1",
      ),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(403);
    expect(payload.error).toBe("auth_error");
  });

  it("returns a disabled response when engine v3 is disabled for the business", async () => {
    vi.mocked(resolveEngineV3Flags).mockResolvedValue(
      makeFlags({
        businessId: "biz-1",
        enabled: false,
        source: {
          enabled: "business_override",
          surfaceVisible: "env",
          shadowOnly: "env",
          presetOverride: null,
        },
      }),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1&asOf=2026-05-04",
      ),
    );
    const payload = (await response.json()) as {
      status?: string;
      reason?: string;
      flags?: EngineV3Flags;
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "disabled",
      reason: "engine_v3_disabled_for_business",
      flags: {
        businessId: "biz-1",
        enabled: false,
      },
    });
  });

  it("returns 403 for an authenticated user with membership for a different business", async () => {
    mockAccessError(403);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-requested",
      ),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(403);
    expect(payload.error).toBe("auth_error");
    expect(requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: "biz-requested",
      minRole: "guest",
    });
  });

  it("returns 401 for a missing or invalid session", async () => {
    mockAccessError(401);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/decision-engine-v3?businessId=biz-1",
      ),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe("auth_error");
  });

  it("defaults to WarehouseDataSource without an env override", () => {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;

    const resolved = resolveDataSource();

    expect(resolved.label).toBe("warehouse");
    expect(resolved.instance).toBeInstanceOf(WarehouseDataSource);
  });

  it("returns 400 when businessId is missing", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-engine-v3"),
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("businessId required");
    expect(requireBusinessAccess).not.toHaveBeenCalled();
  });
});
