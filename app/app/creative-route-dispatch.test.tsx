import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatcherMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  audiencesPage: vi.fn(),
  creativeDetailPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: dispatcherMocks.notFound,
  redirect: dispatcherMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/app/c/[businessId]/creative/audiences/page", () => ({
  default: dispatcherMocks.audiencesPage,
}));
vi.mock("@/app/c/[businessId]/creative/[creativeId]/page", () => ({
  default: dispatcherMocks.creativeDetailPage,
}));

const SessionScopedPage = (await import("@/app/app/[[...path]]/page")).default;
const auth = await import("@/lib/auth");

function session() {
  return {
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
  };
}

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
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  dispatcherMocks.audiencesPage.mockResolvedValue(null);
  dispatcherMocks.creativeDetailPage.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/app Creative Studio route dispatch", () => {
  it("dispatches /app/creative/audiences to the exact audiences page rather than creative detail", async () => {
    const searchParams = Promise.resolve({ providerAccountId: "act_1" });

    await SessionScopedPage({
      params: Promise.resolve({ path: ["creative", "audiences"] }),
      searchParams,
    });

    expect(dispatcherMocks.audiencesPage).toHaveBeenCalledTimes(1);
    const pageProps = dispatcherMocks.audiencesPage.mock.calls[0]?.[0];
    await expect(pageProps.params).resolves.toEqual({
      businessId: "biz_active",
    });
    expect(pageProps.searchParams).toBe(searchParams);
    expect(dispatcherMocks.creativeDetailPage).not.toHaveBeenCalled();
  });

  it("keeps genuine creative ids on the existing detail fallback", async () => {
    await SessionScopedPage({
      params: Promise.resolve({ path: ["creative", "creative_123"] }),
      searchParams: Promise.resolve({ providerAccountId: "act_1" }),
    });

    expect(dispatcherMocks.audiencesPage).not.toHaveBeenCalled();
    expect(dispatcherMocks.creativeDetailPage).toHaveBeenCalledTimes(1);
    await expect(
      dispatcherMocks.creativeDetailPage.mock.calls[0]?.[0].params,
    ).resolves.toEqual({
      businessId: "biz_active",
      creativeId: "creative_123",
    });
  });
});

describe("/app rollback — the reverse half of the compatibility decision", () => {
  /**
   * `/c/:businessId/**` is rewritten into `/app/**` before any page renders, so
   * this dispatcher is the one place every canonical request passes through.
   * That makes it the only place the rollback can be applied once and hold for
   * both families.
   */
  it("falls back to the preserved legacy owner when the mode is off", async () => {
    vi.stubEnv("ZERO_BASE_UI_MODE", "off");

    await expect(
      SessionScopedPage({
        params: Promise.resolve({ path: ["creative", "audiences"] }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/platforms/meta/audiences");

    // Not a 404, and not the canonical body: the legacy screen that has always
    // rendered this surface.
    expect(dispatcherMocks.audiencesPage).not.toHaveBeenCalled();
    expect(dispatcherMocks.notFound).not.toHaveBeenCalled();
  });

  it("carries the query string across the hop", async () => {
    vi.stubEnv("ZERO_BASE_UI_MODE", "off");

    await expect(
      SessionScopedPage({
        params: Promise.resolve({ path: ["creative", "audiences"] }),
        searchParams: Promise.resolve({ providerAccountId: "act_1", window: "7d" }),
      }),
    ).rejects.toThrow(
      "NEXT_REDIRECT:/platforms/meta/audiences?providerAccountId=act_1&window=7d",
    );
  });

  it("falls back for a business the allowlist does not name", async () => {
    vi.stubEnv("ZERO_BASE_UI_MODE", "allowlist");
    vi.stubEnv("ZERO_BASE_UI_BUSINESS_IDS", "some_other_business");

    await expect(
      SessionScopedPage({
        params: Promise.resolve({ path: ["creative", "audiences"] }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/platforms/meta/audiences");
  });

  it("dispatches for a business the allowlist does name", async () => {
    vi.stubEnv("ZERO_BASE_UI_MODE", "allowlist");
    vi.stubEnv("ZERO_BASE_UI_BUSINESS_IDS", "biz_active");

    await SessionScopedPage({
      params: Promise.resolve({ path: ["creative", "audiences"] }),
      searchParams: Promise.resolve({}),
    });

    expect(dispatcherMocks.audiencesPage).toHaveBeenCalledTimes(1);
  });

  it("names a surface with no legacy owner instead of borrowing another screen", async () => {
    /*
     * The Shares ledger was introduced with the new console, so a rollback has
     * nothing earlier to show. Sending it to a neighbouring legacy screen would
     * answer a question about one surface with another surface's data; a bare
     * 404 would say the page does not exist when it does and will return.
     */
    vi.stubEnv("ZERO_BASE_UI_MODE", "off");

    const rendered = await SessionScopedPage({
      params: Promise.resolve({ path: ["creative", "shares"] }),
      searchParams: Promise.resolve({}),
    });

    expect(dispatcherMocks.redirect).not.toHaveBeenCalled();
    expect(dispatcherMocks.notFound).not.toHaveBeenCalled();
    expect(JSON.stringify(rendered)).toContain("creative/shares");
  });
});
