import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GoogleAuthorizedScope } from "@/components/google-ads/google-authorized-scope";

const routeMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  workspace: vi.fn(
    (_props: {
      panel:
        | "summary"
        | "insights"
        | "search"
        | "products"
        | "assets"
        | "plan";
      title: string;
      authorizedScope: GoogleAuthorizedScope;
    }) => null,
  ),
}));

vi.mock("next/navigation", () => ({
  redirect: routeMocks.redirect,
  notFound: routeMocks.notFound,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: vi.fn((next: string) => `/login?next=${encodeURIComponent(next)}`),
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  readProviderScopeCatalog: vi.fn(),
  resolveProviderAccountId: vi.fn(),
}));
vi.mock("@/components/google-ads/GoogleWorkspaceScreen", () => ({
  GoogleWorkspaceScreen: (props: Parameters<typeof routeMocks.workspace>[0]) =>
    routeMocks.workspace(props),
}));

const GoogleOverviewPage = (
  await import("@/app/c/[businessId]/google/overview/page")
).default;
const GoogleAdvisorPage = (
  await import("@/app/c/[businessId]/google/advisor/page")
).default;
const GoogleSearchPage = (
  await import("@/app/c/[businessId]/google/search/page")
).default;
const GoogleProductsPage = (
  await import("@/app/c/[businessId]/google/products/page")
).default;
const GoogleAssetsPage = (
  await import("@/app/c/[businessId]/google/assets-audiences/page")
).default;
const GooglePlanPage = (
  await import("@/app/c/[businessId]/google/plan/page")
).default;
const auth = await import("@/lib/auth");
const access = await import("@/lib/access");
const pageAccess = await import("@/lib/access/require-business-page-context");
const providerScope = await import("@/lib/zero-base/provider-scope-server");

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
    activeBusinessId: "different_business",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function authorizedContext(input?: {
  reviewerReadOnly?: boolean;
  demo?: boolean;
  role?: "admin" | "collaborator" | "guest";
}) {
  const role = input?.role ?? "admin";
  return {
    kind: "ok" as const,
    context: {
      session: session(),
      membership: {
        businessId: "biz_route",
        userId: "user_1",
        role,
        status: "active" as const,
      },
      businessId: "biz_route",
      role,
      reviewerReadOnly: input?.reviewerReadOnly ?? false,
      demo: input?.demo ?? false,
    },
  };
}

const catalog = {
  provider: "google" as const,
  accounts: [
    {
      id: "4931182201",
      label: "Primary Google",
      currency: "USD",
      timezone: "America/New_York",
    },
  ],
};

async function renderRoute(
  route:
    | typeof GoogleOverviewPage
    | typeof GoogleAdvisorPage
    | typeof GoogleSearchPage
    | typeof GoogleProductsPage
    | typeof GoogleAssetsPage
    | typeof GooglePlanPage,
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  const element = await route({
    params: Promise.resolve({ businessId: "biz_route" }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(pageAccess.requireBusinessPageContext).mockResolvedValue(
    authorizedContext() as never,
  );
  vi.mocked(access.listUserBusinesses).mockResolvedValue([
    { id: "biz_route", name: "Route Business" },
  ] as never);
  vi.mocked(providerScope.readProviderScopeCatalog).mockResolvedValue(catalog);
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
    "4931182201",
  );
});

describe("Google canonical route authority", () => {
  it.each([
    ["Overview", GoogleOverviewPage, "summary"],
    ["Advisor", GoogleAdvisorPage, "insights"],
    ["Search intelligence", GoogleSearchPage, "search"],
    ["Products & feed", GoogleProductsPage, "products"],
    ["Assets & Audiences", GoogleAssetsPage, "assets"],
    ["Plan & activity", GooglePlanPage, "plan"],
  ] as const)(
    "passes immutable business/account metadata into %s",
    async (title, route, panel) => {
      await renderRoute(route, { providerAccountId: "4931182201" });

      expect(providerScope.readProviderScopeCatalog).toHaveBeenCalledWith(
        "biz_route",
        "google",
      );
      expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
        businessId: "biz_route",
        provider: "google",
        requestedAccountId: "4931182201",
        catalog,
      });
      expect(routeMocks.workspace).toHaveBeenCalledWith({
        panel,
        title,
        authorizedScope: {
          businessId: "biz_route",
          businessName: "Route Business",
          providerAccountId: "4931182201",
          accountLabel: "Primary Google",
          currency: "USD",
          timezone: "America/New_York",
          viewerReadOnly: false,
          demo: false,
        },
      });
    },
  );

  it("keeps null authoritative when a multi-account route has no explicit selection", async () => {
    const multi = {
      provider: "google" as const,
      accounts: [catalog.accounts[0]!, { ...catalog.accounts[0]!, id: "222" }],
    };
    vi.mocked(providerScope.readProviderScopeCatalog).mockResolvedValueOnce(multi);
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(null);

    await renderRoute(GoogleOverviewPage);

    expect(routeMocks.notFound).not.toHaveBeenCalled();
    expect(routeMocks.workspace.mock.calls[0]?.[0].authorizedScope).toMatchObject({
      providerAccountId: null,
      accountLabel: null,
      currency: null,
      timezone: null,
    });
  });

  it("returns not-found instead of falling back from an unassigned requested account", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(null);

    await expect(
      renderRoute(GoogleAdvisorPage, { providerAccountId: "foreign_account" }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(routeMocks.workspace).not.toHaveBeenCalled();
  });

  it.each([
    ["Search", GoogleSearchPage],
    ["Products", GoogleProductsPage],
    ["Assets & Audiences", GoogleAssetsPage],
    ["Plan & activity", GooglePlanPage],
  ] as const)(
    "refuses a foreign account on %s rather than reading another scope",
    async (_label, route) => {
      vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(null);

      await expect(
        renderRoute(route, { providerAccountId: "foreign_account" }),
      ).rejects.toThrow("NEXT_NOT_FOUND");

      expect(routeMocks.workspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Search", GoogleSearchPage],
    ["Products", GoogleProductsPage],
    ["Assets & Audiences", GoogleAssetsPage],
    ["Plan & activity", GooglePlanPage],
  ] as const)(
    "redirects %s before any provider scope read when there is no session",
    async (_label, route) => {
      vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

      await expect(renderRoute(route)).rejects.toThrow("NEXT_REDIRECT:");

      expect(pageAccess.requireBusinessPageContext).not.toHaveBeenCalled();
      expect(providerScope.readProviderScopeCatalog).not.toHaveBeenCalled();
    },
  );

  it("downgrades reviewers and demo sessions before the client surface mounts", async () => {
    vi.mocked(pageAccess.requireBusinessPageContext).mockResolvedValueOnce(
      authorizedContext({ reviewerReadOnly: true, demo: true }) as never,
    );

    await renderRoute(GoogleAdvisorPage);

    expect(routeMocks.workspace.mock.calls[0]?.[0].authorizedScope).toMatchObject({
      viewerReadOnly: true,
      demo: true,
    });
  });

  // Plan is the only Google surface that can drive a provider write, so the
  // read-only downgrade has to reach it, not just the advisor.
  it.each([
    ["a reviewer or demo session", { reviewerReadOnly: true, demo: true }],
    ["a guest reader", { role: "guest" as const }],
  ])("hands Plan a read-only scope for %s", async (_label, context) => {
    vi.mocked(pageAccess.requireBusinessPageContext).mockResolvedValueOnce(
      authorizedContext(context) as never,
    );

    await renderRoute(GooglePlanPage);

    expect(routeMocks.workspace.mock.calls[0]?.[0]).toMatchObject({
      panel: "plan",
      authorizedScope: { viewerReadOnly: true },
    });
  });

  it("marks guest readers read-only because advisor memory requires collaborator", async () => {
    vi.mocked(pageAccess.requireBusinessPageContext).mockResolvedValueOnce(
      authorizedContext({ role: "guest" }) as never,
    );

    await renderRoute(GoogleAdvisorPage);

    expect(routeMocks.workspace.mock.calls[0]?.[0].authorizedScope).toMatchObject({
      viewerReadOnly: true,
    });
  });

  it("redirects before any provider scope read when there is no session", async () => {
    vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

    await expect(renderRoute(GoogleOverviewPage)).rejects.toThrow("NEXT_REDIRECT:");

    expect(pageAccess.requireBusinessPageContext).not.toHaveBeenCalled();
    expect(providerScope.readProviderScopeCatalog).not.toHaveBeenCalled();
    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
  });

  it("returns not-found before reading a foreign business account catalog", async () => {
    vi.mocked(pageAccess.requireBusinessPageContext).mockResolvedValueOnce({
      kind: "not-found",
    } as never);

    await expect(renderRoute(GoogleAdvisorPage)).rejects.toThrow("NEXT_NOT_FOUND");

    expect(providerScope.readProviderScopeCatalog).not.toHaveBeenCalled();
    expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
  });
});
