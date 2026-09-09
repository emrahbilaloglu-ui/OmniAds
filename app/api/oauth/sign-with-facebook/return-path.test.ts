import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  attachSessionCookie: vi.fn(),
  createSession: vi.fn(async () => ({ token: "session", expiresAt: new Date() })),
}));
vi.mock("@/lib/account-store", () => ({
  findOrCreateFacebookUser: vi.fn(async () => ({ id: "user", email: "operator@example.test" })),
}));
vi.mock("@/lib/access", () => ({
  listUserBusinesses: vi.fn(async () => [{ id: "biz", membershipStatus: "active" }] ),
}));
vi.mock("@/lib/auth-diagnostics", () => ({ logServerAuthEvent: vi.fn() }));

const start = await import("./start/route");
const callback = await import("./callback/route");
const auth = await import("@/lib/auth");

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["META_APP_ID", "META_APP_SECRET", "SIGN_WITH_FACEBOOK_REDIRECT_URI"]) vi.stubEnv(key, "test-config");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
    String(url).includes("oauth/access_token")
      ? { access_token: "provider-token" }
      : { id: "fb-user", email: "operator@example.test" },
  )));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Facebook sign-in return paths", () => {
  it.each(["/\\evil.example", "//evil.example", "/\t/evil.example", "https://evil.example", "/overview?tab=meta"])(
    "sanitizes start state and independently checks callback state: %j", async (next) => {
      const safe = next === "/overview?tab=meta";
      const response = await start.GET(new NextRequest(`https://app.example.test/api/oauth/sign-with-facebook/start?${new URLSearchParams({ next })}`));
      const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
      expect(JSON.parse(Buffer.from(state, "base64url").toString()).next).toBe(safe ? next : "");

      // A pre-fix state cookie may still contain the raw path. Matching CSRF
      // state must not authorize a cross-origin post-login redirect.
      const historicalState = Buffer.from(JSON.stringify({ nonce: "nonce", next })).toString("base64url");
      const returned = await callback.GET(new NextRequest(`https://app.example.test/api/oauth/sign-with-facebook/callback?${new URLSearchParams({ code: "code", state: historicalState })}`, {
        headers: { cookie: `facebook_login_state=${historicalState}` },
      }));
      expect(returned.headers.get("location")).toBe(`https://app.example.test${safe ? next : "/overview"}`);
      expect(auth.attachSessionCookie).toHaveBeenCalledOnce();
    },
  );
});
