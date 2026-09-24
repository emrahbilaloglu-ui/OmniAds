import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  getSessionFromCookies: vi.fn(),
  setSessionActiveBusiness: vi.fn(),
}));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));

const { GET } = await import("./route");
const auth = await import("@/lib/auth");
const access = await import("@/lib/access/require-business-page-context");

const businessId = "biz_target";
const session = {
  sessionId: "session_1",
  activeBusinessId: "biz_previous",
  user: {
    id: "user_1",
    name: "Operator",
    email: "operator@example.com",
    avatar: null,
    language: "en" as const,
  },
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function request(query = "") {
  return new NextRequest(`https://app.example/switch-business/${businessId}${query}`);
}

function get(query = "") {
  return GET(request(query), { params: Promise.resolve({ businessId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session);
  vi.mocked(access.requireBusinessPageContext).mockResolvedValue({
    kind: "ok",
    context: { session, businessId },
  } as never);
});

describe("GET /switch-business/[businessId]", () => {
  it("changes the authorized session before a no-store HTTP redirect and keeps destination query", async () => {
    const target = "/app/meta/decisions?scope=creatives&window=7d";
    const response = await get(`?next=${encodeURIComponent(target)}`);

    expect(access.requireBusinessPageContext).toHaveBeenCalledWith({ businessId });
    expect(auth.setSessionActiveBusiness).toHaveBeenCalledOnce();
    expect(auth.setSessionActiveBusiness).toHaveBeenCalledWith("session_1", businessId);
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(`https://app.example${target}`);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(await response.text()).toBe("");
  });

  it("does not write the session when the requested business is already active", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValue({
      ...session,
      activeBusinessId: businessId,
    });
    const response = await get("?next=%2Fapp%2Fhome");
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("https://app.example/app/home");
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();
  });

  it("preserves an allowlisted Agency return and drops an invalid one", async () => {
    const valid = encodeURIComponent("/a/desk/clients?row=biz_target");
    const target = encodeURIComponent("/app/meta/decisions?scope=creatives");
    const allowed = await get(`?next=${target}&returnTo=${valid}`);
    expect(allowed.headers.get("Location")).toBe(
      "https://app.example/app/meta/decisions?scope=creatives&returnTo=%2Fa%2Fdesk%2Fclients%3Frow%3Dbiz_target",
    );

    const refused = await get(`?next=${target}&returnTo=${encodeURIComponent("//evil.example")}`);
    expect(refused.headers.get("Location")).toBe(
      "https://app.example/app/meta/decisions?scope=creatives",
    );
  });

  it("does not change scope for an unauthenticated or unauthorized request", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValue(null);
    const login = await get("?next=%2Fapp%2Fmeta%2Fdecisions");
    expect(login.status).toBe(307);
    const loginUrl = new URL(login.headers.get("Location")!);
    expect(loginUrl.pathname).toBe("/login");
    expect(loginUrl.searchParams.get("next")).toBe(
      "/switch-business/biz_target?next=%2Fapp%2Fmeta%2Fdecisions",
    );
    expect(access.requireBusinessPageContext).not.toHaveBeenCalled();
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();

    vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session);
    vi.mocked(access.requireBusinessPageContext).mockResolvedValue({ kind: "not-found" });
    const denied = await get("?next=%2Fapp%2Fmeta%2Fdecisions");
    expect(denied.status).toBe(404);
    expect(denied.headers.get("Location")).toBeNull();
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(auth.setSessionActiveBusiness).not.toHaveBeenCalled();
  });

  it("does not honor an external or malformed destination", async () => {
    for (const unsafe of ["//evil.example", "/\\evil.example", "https://evil.example/"]) {
      const response = await get(`?next=${encodeURIComponent(unsafe)}`);
      expect(response.headers.get("Location")).toBe("https://app.example/overview");
    }
  });
});
