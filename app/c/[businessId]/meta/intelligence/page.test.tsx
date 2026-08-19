// @vitest-environment jsdom

/**
 * Meta Account Intelligence canonical route — scope and window.
 *
 * Two laws are pinned.
 *
 * 1. The account is the one the operator selected. The route read no
 *    `searchParams` and the composer resolved an account only when exactly one
 *    was assigned, so with several accounts the shell showed B selected while
 *    every account-scoped section reported "No Meta account is selected".
 *
 * 2. The window is the shell's, read through the shared URL authority
 *    (`lib/dashboard/date-window-url`), and its "today" is the workspace's. The
 *    route computed a private UTC 28-day range ending on TODAY, so the surface
 *    printed "Every windowed source below covers X to Y" contradicting the range
 *    chip above it; the UTC-vs-workspace skew moved the window by a day for
 *    accounts east or west of UTC; and `?window=7d` — the preset key the shell
 *    itself writes — was not read at all.
 *
 * The window assertions below moved when that private resolver was deleted, and
 * they moved in one direction only: a preset now ends on YESTERDAY. Today is a
 * part-day whose spend and conversions are still arriving, so counting it as a
 * whole day understates every rate and inflates every per-day divisor — the
 * budget-utilisation invariant in its other form. `DATE_WINDOW_INCLUDES_CURRENT_DAY`
 * is the one switch that says so, and this surface now obeys it like every other.
 * The expansion itself is pinned to the shared expander in
 * `lib/zero-base/meta/intelligence-window.test.ts`; what is pinned here is that
 * the ROUTE reads the URL through it and hands the result to the composer.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((href: string): never => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});
const notFound = vi.fn((): never => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: vi.fn((next: string) => `/login?next=${encodeURIComponent(next)}`),
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  resolveProviderAccountId: vi.fn(),
}));
vi.mock("@/lib/zero-base/meta/intelligence-server", () => ({
  readMetaIntelligence: vi.fn(),
}));

const pageModule = await import("@/app/c/[businessId]/meta/intelligence/page");
const MetaIntelligencePage = pageModule.default;
const auth = await import("@/lib/auth");
const businessPageAccess = await import(
  "@/lib/access/require-business-page-context"
);
const access = await import("@/lib/access");
const providerScope = await import("@/lib/zero-base/provider-scope-server");
const intelligenceServer = await import("@/lib/zero-base/meta/intelligence-server");

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
    activeBusinessId: "biz_route",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function authorizedContext(businessId: string) {
  return {
    kind: "ok" as const,
    context: {
      session: session(),
      membership: {
        businessId,
        userId: "user_1",
        role: "admin" as const,
        status: "active" as const,
      },
      businessId,
      role: "admin" as const,
      reviewerReadOnly: false,
      demo: false,
    },
  };
}

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  const element = await MetaIntelligencePage({
    params: Promise.resolve({ businessId: "biz_route" }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue(
    authorizedContext("biz_route") as never,
  );
  vi.mocked(access.listUserBusinesses).mockResolvedValue([
    { id: "biz_route", name: "Route", timezone: "Europe/Istanbul", currency: "USD" },
  ] as never);
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue("act_B");
  vi.mocked(intelligenceServer.readMetaIntelligence).mockResolvedValue({
    providerAccountId: "act_B",
    sections: [],
    unavailableReason: null,
  });
});

describe("Account Intelligence honours the selected account", () => {
  it("resolves the requested account and composes for it", async () => {
    await renderPage({ providerAccountId: "act_B" });

    expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
      businessId: "biz_route",
      provider: "meta",
      requestedAccountId: "act_B",
    });
    expect(
      vi.mocked(intelligenceServer.readMetaIntelligence).mock.calls[0]?.[0]
        .providerAccountId,
    ).toBe("act_B");
  });

  it("passes null through rather than picking one, when nothing resolves", async () => {
    // The composer's "null means unresolved" law is unchanged: it still refuses
    // to scope account-owned sections to an account nobody chose.
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(null);

    await renderPage();

    expect(
      vi.mocked(intelligenceServer.readMetaIntelligence).mock.calls[0]?.[0]
        .providerAccountId,
    ).toBeNull();
  });
});

describe("Account Intelligence honours the shell's window", () => {
  it("uses the range carried in the URL instead of its own default", async () => {
    const html = await renderPage({ startDate: "2026-08-05", endDate: "2026-08-11" });

    const call = vi.mocked(intelligenceServer.readMetaIntelligence).mock.calls[0]?.[0];
    expect(call?.startDate).toBe("2026-08-05");
    expect(call?.endDate).toBe("2026-08-11");
    // And the sentence on screen names the window that was actually read.
    expect(html).toContain("2026-08-05");
    expect(html).toContain("2026-08-11");
  });

  it("supports `?window=7d` alone — the preset key the shell writes", async () => {
    // The private resolver looked for startDate/endDate and nothing else, so
    // this URL produced 28 days ending today. The key is now read, expanded
    // exactly once, and ends on a completed day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T09:00:00.000Z"));
    try {
      await renderPage({ window: "7d" });
    } finally {
      vi.useRealTimers();
    }

    const call = vi.mocked(intelligenceServer.readMetaIntelligence).mock.calls[0]?.[0];
    expect(call?.startDate).toBe("2026-08-11");
    expect(call?.endDate).toBe("2026-08-17");
  });

  it("resolves its default 'today' on the workspace clock, not UTC", async () => {
    // 2026-08-11T22:30Z is already 2026-08-12 in Istanbul (UTC+3). Computing the
    // end date in UTC named a day the workspace had already left, so the window
    // disagreed with the shell's chip by a day.
    //
    // The end date is 08-11, not 08-12: the workspace's today is 08-12 and today
    // is excluded, because a day still in progress is not a day of evidence.
    // That is the assertion that changed when the private resolver was deleted,
    // and it changed because the old one was wrong, not because the new one is
    // more convenient.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T22:30:00.000Z"));
    try {
      await renderPage();
    } finally {
      vi.useRealTimers();
    }

    const call = vi.mocked(intelligenceServer.readMetaIntelligence).mock.calls[0]?.[0];
    expect(call?.endDate).toBe("2026-08-11");
    expect(call?.startDate).toBe("2026-07-15");
  });

  it("keeps the 28-day default when the URL carries no usable range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T09:00:00.000Z"));
    try {
      await renderPage();
    } finally {
      vi.useRealTimers();
    }

    const call = vi.mocked(intelligenceServer.readMetaIntelligence).mock.calls[0]?.[0];
    // 12:00 Istanbul on the 11th; today is the 11th, so the window is the 28
    // completed days ending on the 10th.
    expect({ startDate: call?.startDate, endDate: call?.endDate }).toEqual({
      startDate: "2026-07-14",
      endDate: "2026-08-10",
    });
  });

  it("falls back rather than repairing a half-supplied or inverted range", async () => {
    // An end before a start is not a window, and half a pair is not a window.
    // Reading either would return a result that looked like "no data in this
    // period" or like a window the operator had chosen. The unusable pair is
    // dropped whole and the canonical default is read instead — and because the
    // view prints the resolved dates verbatim, the operator sees the window that
    // was actually measured rather than the one they mistyped.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T09:00:00.000Z"));
    try {
      await renderPage({ startDate: "2026-08-20", endDate: "2026-08-01" });
      await renderPage({ startDate: "2026-08-01" });
    } finally {
      vi.useRealTimers();
    }

    const calls = vi.mocked(intelligenceServer.readMetaIntelligence).mock.calls;
    for (const [call] of calls) {
      expect({ startDate: call?.startDate, endDate: call?.endDate }).toEqual({
        startDate: "2026-07-14",
        endDate: "2026-08-10",
      });
    }
    // Specifically NOT repaired into something shaped like what was typed.
    expect(calls.some(([call]) => call?.startDate === "2026-08-01")).toBe(false);
    expect(calls.some(([call]) => call?.endDate === "2026-08-11")).toBe(false);
  });
});
