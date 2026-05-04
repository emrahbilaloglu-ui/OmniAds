import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  WarehouseDataSource,
  type DecisionResponse,
} from "@/lib/creative-decision-engine";
import { requireBusinessAccess } from "@/lib/access";
import { resolveDataSource } from "./data-source";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

const previousDataSourceFlag = process.env.DECISION_ENGINE_V3_DATA_SOURCE;

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
  mockBusinessAccess();
});

afterEach(() => {
  if (previousDataSourceFlag === undefined) {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;
  } else {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = previousDataSourceFlag;
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
    expect(payload.dataHealth.worstTier).toBe("none");
    expect(payload.dataHealth.degraded).toBe(false);
    expect(payload.dataHealth.calibration).toBeDefined();
    expect(payload.dataHealth.lifecycle).toBeDefined();
    expect(payload.dataHealth.decisions).toBeDefined();
    expect(payload.decisions).toHaveLength(3);
    expect(requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: "biz-1",
      minRole: "guest",
    });
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
