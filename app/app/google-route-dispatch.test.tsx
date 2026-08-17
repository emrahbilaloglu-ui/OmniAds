import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatcherMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  overviewPage: vi.fn(),
  advisorPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: dispatcherMocks.notFound,
  redirect: dispatcherMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/app/c/[businessId]/google/overview/page", () => ({
  default: dispatcherMocks.overviewPage,
}));
vi.mock("@/app/c/[businessId]/google/advisor/page", () => ({
  default: dispatcherMocks.advisorPage,
}));

const SessionScopedPage = (await import("@/app/app/[[...path]]/page")).default;
const auth = await import("@/lib/auth");

beforeEach(() => {
  vi.clearAllMocks();
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
  dispatcherMocks.overviewPage.mockResolvedValue(null);
  dispatcherMocks.advisorPage.mockResolvedValue(null);
});

describe("/app Google route dispatch", () => {
  it.each([
    ["overview", dispatcherMocks.overviewPage],
    ["advisor", dispatcherMocks.advisorPage],
  ] as const)(
    "inherits the canonical %s route and preserves explicit account scope",
    async (leaf, routedPage) => {
      const searchParams = Promise.resolve({ providerAccountId: "4931182201" });

      await SessionScopedPage({
        params: Promise.resolve({ path: ["google", leaf] }),
        searchParams,
      });

      expect(routedPage).toHaveBeenCalledTimes(1);
      const props = routedPage.mock.calls[0]?.[0];
      await expect(props.params).resolves.toEqual({ businessId: "biz_active" });
      expect(props.searchParams).toBe(searchParams);
      expect(dispatcherMocks.notFound).not.toHaveBeenCalled();
    },
  );
});
