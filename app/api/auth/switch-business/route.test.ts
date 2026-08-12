/**
 * Enforcement guard for the business switch.
 *
 * This endpoint writes the active business onto the session, so it is the one
 * place where getting authorization wrong silently rescopes every later
 * request. WP-03 left its behavior untouched; these tests pin that down —
 * particularly that the session is only written after reviewer scope and an
 * active membership have both been proven.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getSessionFromRequest: vi.fn(),
    setSessionActiveBusiness: vi.fn(),
  };
});

vi.mock("@/lib/access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/access")>("@/lib/access");
  return { ...actual, findMembership: vi.fn() };
});

vi.mock("@/lib/auth-diagnostics", () => ({ logServerAuthEvent: vi.fn() }));

const { POST } = await import("@/app/api/auth/switch-business/route");
const auth = await import("@/lib/auth");
const access = await import("@/lib/access");
const { SHOPIFY_REVIEWER_EMAIL } = await import("@/lib/reviewer-access");
const { DEMO_BUSINESS_ID } = await import("@/lib/demo-business");

function session(email = "ada@example.com"): import("@/lib/auth").SessionContext {
  return {
    sessionId: "sess_1",
    user: { id: "user_1", name: "Ada", email, avatar: null, language: "en" },
    activeBusinessId: "biz_1",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function membership(
  overrides: Partial<import("@/lib/access").MembershipRecord> = {},
): import("@/lib/access").MembershipRecord {
  return {
    id: "mem_1",
    userId: "user_1",
    businessId: "biz_2",
    role: "collaborator",
    status: "active",
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function post(body: unknown) {
  return new NextRequest("https://app.example/api/auth/switch-business", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/auth/switch-business", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(session());
    vi.mocked(access.findMembership).mockResolvedValue(membership());
  });

  it("switches the session when membership is active", async () => {
    const response = await POST(post({ businessId: "biz_2" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      activeBusinessId: "biz_2",
    });
    expect(auth.setSessionActiveBusiness).toHaveBeenCalledWith("sess_1", "biz_2");
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it("401s an unauthenticated caller and writes nothing", async () => {
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(null);
    const response = await POST(post({ businessId: "biz_2" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "auth_error",
      message: "Authentication required.",
    });
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();
  });

  it("400s a missing or unparseable body and writes nothing", async () => {
    for (const body of [{}, { businessId: "" }, "not json"]) {
      const response = await POST(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_payload",
        message: "businessId is required.",
      });
    }
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();
  });

  it("403s a reviewer switching outside the demo business, before any membership read", async () => {
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(session(SHOPIFY_REVIEWER_EMAIL));
    const response = await POST(post({ businessId: "biz_2" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      message: "No access to this business.",
    });
    expect(access.findMembership).not.toHaveBeenCalled();
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();
  });

  it("lets a reviewer switch into the demo business", async () => {
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(session(SHOPIFY_REVIEWER_EMAIL));
    vi.mocked(access.findMembership).mockResolvedValue(
      membership({ businessId: DEMO_BUSINESS_ID }),
    );
    const response = await POST(post({ businessId: DEMO_BUSINESS_ID }));
    expect(response.status).toBe(200);
    expect(auth.setSessionActiveBusiness).toHaveBeenCalledWith("sess_1", DEMO_BUSINESS_ID);
  });

  it("403s a business the caller has no membership in", async () => {
    vi.mocked(access.findMembership).mockResolvedValue(null);
    const response = await POST(post({ businessId: "biz_other" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      message: "No access to this business.",
    });
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();
  });

  it("403s pending and invited memberships", async () => {
    for (const status of ["pending", "invited"] as const) {
      vi.mocked(access.findMembership).mockResolvedValue(membership({ status }));
      const response = await POST(post({ businessId: "biz_2" }));
      expect(response.status, status).toBe(403);
    }
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();
  });

  it("does not require any particular role to switch", async () => {
    // Switching is scope selection, not a privileged action.
    vi.mocked(access.findMembership).mockResolvedValue(membership({ role: "guest" }));
    expect((await POST(post({ businessId: "biz_2" }))).status).toBe(200);
  });
});
