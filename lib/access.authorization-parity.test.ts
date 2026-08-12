/**
 * Parity guard for `requireBusinessAccess`.
 *
 * WP-03 moved the decision into a shared authorizer. Every API route in the
 * app depends on this function's exact status codes and message strings, so
 * this asserts the observable contract rather than the refactor: same order of
 * checks, same bodies, and no membership read for a caller who has not proven
 * who they are.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getSessionFromRequest: vi.fn() };
});

vi.mock("@/lib/access-membership", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/access-membership")>("@/lib/access-membership");
  return { ...actual, findMembershipResult: vi.fn() };
});

const { requireBusinessAccess } = await import("@/lib/access");
const auth = await import("@/lib/auth");
const membershipModule = await import("@/lib/access-membership");
const { SHOPIFY_REVIEWER_EMAIL } = await import("@/lib/reviewer-access");
const { DEMO_BUSINESS_ID } = await import("@/lib/demo-business");

const request = () => new NextRequest("https://app.example/api/thing");

function session(email = "ada@example.com"): import("@/lib/auth").SessionContext {
  return {
    sessionId: "sess_1",
    user: { id: "user_1", name: "Ada", email, avatar: null, language: "en" },
    activeBusinessId: "biz_1",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function membership(
  overrides: Partial<import("@/lib/access-membership").MembershipRecord> = {},
): import("@/lib/access-membership").MembershipRecord {
  return {
    id: "mem_1",
    userId: "user_1",
    businessId: "biz_1",
    role: "collaborator",
    status: "active",
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function callAndRead(input: {
  businessId: string | null;
  minRole?: "guest" | "collaborator" | "admin";
}) {
  const result = await requireBusinessAccess({ request: request(), ...input });
  if (!("error" in result)) return { ok: true as const, result };
  return {
    ok: false as const,
    status: result.error.status,
    body: (await result.error.json()) as { error: string; message: string },
  };
}

describe("requireBusinessAccess parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(session());
    vi.mocked(membershipModule.findMembershipResult).mockResolvedValue({
      schemaReady: true,
      membership: membership(),
    });
  });

  it("returns the session and membership when authorized", async () => {
    const outcome = await callAndRead({ businessId: "biz_1" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toEqual({ session: session(), membership: membership() });
    }
  });

  it("400s a missing business ID without reading the session or membership", async () => {
    const outcome = await callAndRead({ businessId: null });
    expect(outcome).toMatchObject({
      status: 400,
      body: { error: "missing_business_id", message: "businessId is required." },
    });
    expect(auth.getSessionFromRequest).not.toHaveBeenCalled();
    expect(membershipModule.findMembershipResult).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller without reading membership", async () => {
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(null);
    const outcome = await callAndRead({ businessId: "biz_1" });
    expect(outcome).toMatchObject({
      status: 401,
      body: { error: "auth_error", message: "Authentication required." },
    });
    expect(membershipModule.findMembershipResult).not.toHaveBeenCalled();
  });

  it("403s a reviewer outside the demo business without reading membership", async () => {
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(session(SHOPIFY_REVIEWER_EMAIL));
    const outcome = await callAndRead({ businessId: "biz_1" });
    expect(outcome).toMatchObject({
      status: 403,
      body: { error: "auth_error", message: "You do not have access to this business." },
    });
    expect(membershipModule.findMembershipResult).not.toHaveBeenCalled();
  });

  it("authorizes a reviewer inside the demo business", async () => {
    vi.mocked(auth.getSessionFromRequest).mockResolvedValue(session(SHOPIFY_REVIEWER_EMAIL));
    vi.mocked(membershipModule.findMembershipResult).mockResolvedValue({
      schemaReady: true,
      membership: membership({ businessId: DEMO_BUSINESS_ID }),
    });
    expect((await callAndRead({ businessId: DEMO_BUSINESS_ID })).ok).toBe(true);
  });

  it("403s a cross-tenant business ID taken from the URL", async () => {
    vi.mocked(membershipModule.findMembershipResult).mockResolvedValue({
      schemaReady: true,
      membership: null,
    });
    expect(await callAndRead({ businessId: "biz_other" })).toMatchObject({
      status: 403,
      body: { error: "auth_error", message: "You do not have access to this business." },
    });
    expect(membershipModule.findMembershipResult).toHaveBeenCalledWith({
      userId: "user_1",
      businessId: "biz_other",
    });
  });

  it("403s pending and invited memberships with the same body", async () => {
    for (const status of ["pending", "invited"] as const) {
      vi.mocked(membershipModule.findMembershipResult).mockResolvedValue({
        schemaReady: true,
        membership: membership({ status }),
      });
      expect(await callAndRead({ businessId: "biz_1" }), status).toMatchObject({
        status: 403,
        body: { error: "auth_error", message: "You do not have access to this business." },
      });
    }
  });

  it("403s an unavailable schema exactly as before, revealing nothing new", async () => {
    vi.mocked(membershipModule.findMembershipResult).mockResolvedValue({
      schemaReady: false,
      membership: null,
    });
    expect(await callAndRead({ businessId: "biz_1" })).toMatchObject({
      status: 403,
      body: { error: "auth_error", message: "You do not have access to this business." },
    });
  });

  it("403s an insufficient role with the role-specific message", async () => {
    vi.mocked(membershipModule.findMembershipResult).mockResolvedValue({
      schemaReady: true,
      membership: membership({ role: "guest" }),
    });
    expect(await callAndRead({ businessId: "biz_1", minRole: "admin" })).toMatchObject({
      status: 403,
      body: { error: "auth_error", message: "Insufficient role permissions for this action." },
    });
  });

  it("defaults to guest when no minimum role is given", async () => {
    vi.mocked(membershipModule.findMembershipResult).mockResolvedValue({
      schemaReady: true,
      membership: membership({ role: "guest" }),
    });
    expect((await callAndRead({ businessId: "biz_1" })).ok).toBe(true);
  });
});
