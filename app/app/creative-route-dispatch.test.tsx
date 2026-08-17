import { beforeEach, describe, expect, it, vi } from "vitest";

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
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  dispatcherMocks.audiencesPage.mockResolvedValue(null);
  dispatcherMocks.creativeDetailPage.mockResolvedValue(null);
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
