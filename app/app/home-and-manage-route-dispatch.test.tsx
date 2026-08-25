/**
 * `/app/**` is a dispatcher, not a second implementation.
 *
 * Overview, Settings and Commercial Truth are reached from this family as
 * `/app/home`, `/app/manage/plan` and `/app/manage/business`. Each must land on
 * the very `/c/[businessId]/**` module that mounts the exact Dashboard v2 body
 * (proved in `app/c/[businessId]/canonical-exact-bodies.test.tsx`), carrying
 * only the session's own authorized business id — never one taken from the URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatcherMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  homePage: vi.fn(),
  planPage: vi.fn(),
  businessPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: dispatcherMocks.notFound,
  redirect: dispatcherMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/app/c/[businessId]/home/page", () => ({
  default: dispatcherMocks.homePage,
}));
vi.mock("@/app/c/[businessId]/manage/plan/page", () => ({
  default: dispatcherMocks.planPage,
}));
vi.mock("@/app/c/[businessId]/manage/business/page", () => ({
  default: dispatcherMocks.businessPage,
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

const routes = [
  { label: "Overview", path: ["home"], page: dispatcherMocks.homePage },
  {
    label: "Settings",
    path: ["manage", "plan"],
    page: dispatcherMocks.planPage,
  },
  {
    label: "Commercial Truth",
    path: ["manage", "business"],
    page: dispatcherMocks.businessPage,
  },
];

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
  for (const { page } of routes) page.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/app dispatch for the three converged screens", () => {
  it.each(routes)(
    "$label dispatches to the canonical leaf that mounts the exact body",
    async ({ path, page }) => {
      const searchParams = Promise.resolve({});

      await SessionScopedPage({
        params: Promise.resolve({ path }),
        searchParams,
      });

      expect(page).toHaveBeenCalledTimes(1);
      await expect(page.mock.calls[0]?.[0].params).resolves.toEqual({
        businessId: "biz_active",
      });
    },
  );

  it("an empty path is Overview, not a not-found", async () => {
    await SessionScopedPage({
      params: Promise.resolve({ path: undefined }),
      searchParams: Promise.resolve({}),
    });

    expect(dispatcherMocks.homePage).toHaveBeenCalledTimes(1);
  });

  it.each(routes)(
    "$label sends an unauthenticated caller to login before importing anything",
    async ({ path, page }) => {
      vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

      await expect(
        SessionScopedPage({
          params: Promise.resolve({ path }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow("NEXT_REDIRECT:");

      expect(page).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "$label sends a session with no active business to selection",
    async ({ path, page }) => {
      vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce({
        ...session(),
        activeBusinessId: null,
      } as never);

      await expect(
        SessionScopedPage({
          params: Promise.resolve({ path }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow("NEXT_REDIRECT:/select-business");

      expect(page).not.toHaveBeenCalled();
    },
  );
});
