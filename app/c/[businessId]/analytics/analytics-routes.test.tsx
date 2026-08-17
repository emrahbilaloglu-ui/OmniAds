import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Insights route family must reach the same exact screen, and none of
 * them may reach it before the server-side authorizer has said yes.
 */
const routeMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  chrome: vi.fn(
    (_props: { businessId?: string | null; pathname?: string }) => null,
  ),
  screen: vi.fn((_props: { businessId?: string; initialTab?: string }) => null),
  seo: vi.fn((_props: { businessId?: string; initialTab?: string }) => null),
  geo: vi.fn((_props: { businessId?: string; initialTab?: string }) => null),
}));

vi.mock("next/navigation", () => ({
  redirect: routeMocks.redirect,
  notFound: routeMocks.notFound,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: vi.fn((next: string) => `/login?next=${encodeURIComponent(next)}`),
}));
vi.mock("@/components/insights/InsightsChrome", () => ({
  InsightsChrome: (
    props: Parameters<typeof routeMocks.chrome>[0] & { children?: unknown },
  ) => {
    routeMocks.chrome({ businessId: props.businessId, pathname: props.pathname });
    return props.children as never;
  },
}));
vi.mock("@/components/analytics/InsightsAnalyticsScreen", () => ({
  InsightsAnalyticsScreen: (props: Parameters<typeof routeMocks.screen>[0]) => {
    routeMocks.screen(props);
    return null;
  },
}));
vi.mock("@/components/seo/InsightsSeoScreen", () => ({
  InsightsSeoScreen: (props: Parameters<typeof routeMocks.seo>[0]) => {
    routeMocks.seo(props);
    return null;
  },
}));
vi.mock("@/components/geo/InsightsGeoScreen", () => ({
  InsightsGeoScreen: (props: Parameters<typeof routeMocks.geo>[0]) => {
    routeMocks.geo(props);
    return null;
  },
}));

const Ga4ShopifyPage = (
  await import("@/app/c/[businessId]/analytics/ga4-shopify/page")
).default;
const LandingPagesPage = (
  await import("@/app/c/[businessId]/analytics/landing-pages/page")
).default;
const SeoPage = (await import("@/app/c/[businessId]/analytics/seo/page")).default;
const GeoPage = (await import("@/app/c/[businessId]/analytics/geo/page")).default;
const auth = await import("@/lib/auth");
const pageAccess = await import("@/lib/access/require-business-page-context");

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

function authorizedContext() {
  return {
    kind: "ok" as const,
    context: {
      session: session(),
      membership: {
        businessId: "biz_route",
        userId: "user_1",
        role: "admin" as const,
        status: "active" as const,
      },
      businessId: "biz_route",
      role: "admin" as const,
      reviewerReadOnly: false,
      demo: false,
    },
  };
}

async function renderRoute(route: typeof Ga4ShopifyPage) {
  const element = await route({ params: Promise.resolve({ businessId: "biz_route" }) });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(pageAccess.requireBusinessPageContext).mockResolvedValue(
    authorizedContext() as never,
  );
});

describe("canonical analytics routes", () => {
  it("mounts the exact Insights screen on the GA4 leaf", async () => {
    await renderRoute(Ga4ShopifyPage);
    expect(routeMocks.chrome).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_route",
        pathname: "/c/biz_route/analytics/ga4-shopify",
      }),
    );
    expect(routeMocks.screen).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_route" }),
    );
    expect(routeMocks.screen.mock.calls[0]?.[0].initialTab).toBeUndefined();
  });

  it("opens the same screen pinned to the landing-pages sub-tab", async () => {
    await renderRoute(LandingPagesPage);
    expect(routeMocks.chrome).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/c/biz_route/analytics/landing-pages",
      }),
    );
    expect(routeMocks.screen).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_route", initialTab: "landing" }),
    );
  });

  it("mounts the exact SEO screen inside the same outer chrome", async () => {
    await renderRoute(SeoPage);
    expect(routeMocks.chrome).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_route",
        pathname: "/c/biz_route/analytics/seo",
      }),
    );
    expect(routeMocks.seo).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_route" }),
    );
  });

  it("mounts the exact AI-visibility screen inside the same outer chrome", async () => {
    await renderRoute(GeoPage);
    expect(routeMocks.chrome).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_route",
        pathname: "/c/biz_route/analytics/geo",
      }),
    );
    expect(routeMocks.geo).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_route" }),
    );
  });

  it.each([
    ["ga4-shopify", Ga4ShopifyPage],
    ["landing-pages", LandingPagesPage],
    ["seo", SeoPage],
    ["geo", GeoPage],
  ] as const)("sends an anonymous visitor to login on %s", async (leaf, route) => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValue(null as never);
    await expect(renderRoute(route)).rejects.toThrow(
      `NEXT_REDIRECT:/login?next=${encodeURIComponent(`/c/biz_route/analytics/${leaf}`)}`,
    );
    expect(routeMocks.screen).not.toHaveBeenCalled();
    expect(routeMocks.seo).not.toHaveBeenCalled();
    expect(routeMocks.geo).not.toHaveBeenCalled();
  });

  it.each([
    ["ga4-shopify", Ga4ShopifyPage],
    ["landing-pages", LandingPagesPage],
    ["seo", SeoPage],
    ["geo", GeoPage],
  ] as const)("refuses a foreign tenant on %s", async (_leaf, route) => {
    vi.mocked(pageAccess.requireBusinessPageContext).mockResolvedValue({
      kind: "not_found",
    } as never);
    await expect(renderRoute(route)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(routeMocks.screen).not.toHaveBeenCalled();
    expect(routeMocks.seo).not.toHaveBeenCalled();
    expect(routeMocks.geo).not.toHaveBeenCalled();
  });
});
