import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatcherMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  automationPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: dispatcherMocks.notFound,
  redirect: dispatcherMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/app/c/[businessId]/meta/automation/page", () => ({
  default: dispatcherMocks.automationPage,
}));

const SessionScopedPage = (await import("@/app/app/[[...path]]/page")).default;
const auth = await import("@/lib/auth");

beforeEach(() => {
  vi.clearAllMocks();
  /*
   * These cases are about DISPATCH, so the canonical UI is switched on.
   *
   * `/app/**` now consults the rollout mode before it dispatches — the reverse
   * half of the compatibility decision, added because the mode defaults to OFF
   * and the canonical family was serving every surface regardless, which made
   * the documented rollback roll nothing back. With the mode unset these tests
   * would be asserting the fallback rather than the routing table. The fallback
   * has its own cases in `lib/zero-base/canonical-fallback.test.ts` and, at
   * runtime, in `playwright/tests/meta-runtime-rollout.spec.ts`.
   */
  vi.stubEnv("ZERO_BASE_UI_MODE", "on");
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue({
    sessionId: "session_1",
    user: {
      id: "user_1",
      name: "Route Operator",
      email: "operator@example.com",
      avatar: null,
      language: "en",
    },
    activeBusinessId: "biz_active",
    expiresAt: "2099-01-01T00:00:00.000Z",
  } as never);
  dispatcherMocks.automationPage.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/app Meta Automation route dispatch", () => {
  it("uses the canonical authorized business route and preserves explicit account scope", async () => {
    const searchParams = Promise.resolve({ providerAccountId: "act_1" });

    await SessionScopedPage({
      params: Promise.resolve({ path: ["meta", "automation"] }),
      searchParams,
    });

    expect(dispatcherMocks.automationPage).toHaveBeenCalledTimes(1);
    const props = dispatcherMocks.automationPage.mock.calls[0]?.[0];
    await expect(props.params).resolves.toEqual({ businessId: "biz_active" });
    expect(props.searchParams).toBe(searchParams);
    expect(dispatcherMocks.notFound).not.toHaveBeenCalled();
  });
});
