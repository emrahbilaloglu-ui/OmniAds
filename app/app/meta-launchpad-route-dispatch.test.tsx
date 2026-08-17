import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatcherMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  launchpadPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: dispatcherMocks.notFound,
  redirect: dispatcherMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/app/c/[businessId]/meta/launchpad/page", () => ({
  default: dispatcherMocks.launchpadPage,
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
  dispatcherMocks.launchpadPage.mockResolvedValue(null);
});

describe("/app Meta Launchpad route dispatch", () => {
  it("inherits the canonical business route and preserves provider scope", async () => {
    const searchParams = Promise.resolve({ providerAccountId: "act_1" });

    await SessionScopedPage({
      params: Promise.resolve({ path: ["meta", "launchpad"] }),
      searchParams,
    });

    expect(dispatcherMocks.launchpadPage).toHaveBeenCalledTimes(1);
    const props = dispatcherMocks.launchpadPage.mock.calls[0]?.[0];
    await expect(props.params).resolves.toEqual({ businessId: "biz_active" });
    expect(props.searchParams).toBe(searchParams);
    expect(dispatcherMocks.notFound).not.toHaveBeenCalled();
  });
});
