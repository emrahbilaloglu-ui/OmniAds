import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatcherMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  klaviyoPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: dispatcherMocks.notFound,
  redirect: dispatcherMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/app/c/[businessId]/klaviyo/page", () => ({
  default: dispatcherMocks.klaviyoPage,
}));

const SessionScopedPage = (await import("@/app/app/[[...path]]/page")).default;
const auth = await import("@/lib/auth");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue({
    sessionId: "session_1",
    activeBusinessId: "biz_active",
  } as never);
  dispatcherMocks.klaviyoPage.mockResolvedValue(null);
});

describe("/app Klaviyo route dispatch", () => {
  it("resolves /app/klaviyo onto the canonical business-scoped page", async () => {
    await SessionScopedPage({
      params: Promise.resolve({ path: ["klaviyo"] }),
      searchParams: Promise.resolve({}),
    });
    expect(dispatcherMocks.klaviyoPage).toHaveBeenCalledTimes(1);
    const call = dispatcherMocks.klaviyoPage.mock.calls[0]![0] as {
      params: Promise<{ businessId: string }>;
    };
    await expect(call.params).resolves.toEqual({ businessId: "biz_active" });
  });

  it("still 404s the Layer-2 spellings the design does not define", async () => {
    for (const leaf of ["flows", "campaigns", "templates", "segments"]) {
      await expect(
        SessionScopedPage({
          params: Promise.resolve({ path: ["klaviyo", leaf] }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });
});
