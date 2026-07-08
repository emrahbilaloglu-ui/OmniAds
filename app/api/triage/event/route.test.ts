import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { recordTriageEvent } from "@/lib/triage-events";
import { POST } from "./route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/triage-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/triage-events")>();
  return {
    ...actual,
    recordTriageEvent: vi.fn(),
  };
});

function request(body: unknown) {
  return new NextRequest("http://localhost/api/triage/event", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email: "operator@adsecute.com" } } as never,
    membership: {
      id: "membership_1",
      userId: "user_1",
      businessId: "biz_1",
      role: "collaborator",
      status: "active",
      joinedAt: "2026-05-07T00:00:00.000Z",
    },
  });
  vi.mocked(recordTriageEvent).mockResolvedValue({
    businessId: "biz_1",
    scopeType: "creative",
    scopeId: "cr_1",
    action: "deferred",
    timestamp: "2026-05-07T00:00:00.000Z",
    reappearAt: "2026-05-08T00:00:00.000Z",
  });
});

describe("POST /api/triage/event", () => {
  it("persists a scoped defer event", async () => {
    const response = await POST(
      request({
        businessId: "biz_1",
        scopeType: "creative",
        scopeId: "cr_1",
        action: "deferred",
        reappearAt: "2026-05-08T00:00:00.000Z",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(recordTriageEvent).toHaveBeenCalledWith({
      businessId: "biz_1",
      scopeType: "creative",
      scopeId: "cr_1",
      action: "deferred",
      reappearAt: "2026-05-08T00:00:00.000Z",
    });
    expect(requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: "biz_1",
      minRole: "collaborator",
    });
  });

  it("rejects invalid action values", async () => {
    const response = await POST(
      request({
        businessId: "biz_1",
        scopeType: "creative",
        scopeId: "cr_1",
        action: "acted",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_action");
    expect(recordTriageEvent).not.toHaveBeenCalled();
  });

  it("returns auth errors unchanged", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "auth_error" }, { status: 401 }),
    });

    const response = await POST(
      request({
        businessId: "biz_1",
        scopeType: "creative",
        scopeId: "cr_1",
        action: "deferred",
      }),
    );

    expect(response.status).toBe(401);
    expect(recordTriageEvent).not.toHaveBeenCalled();
  });

  it("rejects reviewer read-only attempts before writing triage state", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "reviewer_1", email: "shopify-review@adsecute.com" } } as never,
      membership: {
        id: "membership_1",
        userId: "reviewer_1",
        businessId: "biz_1",
        role: "collaborator",
        status: "active",
        joinedAt: "2026-05-07T00:00:00.000Z",
      },
    });

    const response = await POST(
      request({
        businessId: "biz_1",
        scopeType: "adset",
        scopeId: "as_1",
        action: "deferred",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("reviewer_read_only");
    expect(payload.error.action).toBe("triage_deferred");
    expect(recordTriageEvent).not.toHaveBeenCalled();
  });
});
