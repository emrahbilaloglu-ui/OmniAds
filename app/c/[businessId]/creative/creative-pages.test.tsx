import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type LegacyCreativePageProps = {
  businessId?: string;
  providerAccountId?: string | null;
};

const routeMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  loginUrlFor: vi.fn(
    (next: string) => `/login?next=${encodeURIComponent(next)}`,
  ),
  performanceBody: vi.fn(),
  copiesBody: vi.fn(),
  landingPagesBody: vi.fn(),
  inboxBody: vi.fn(),
  audiencesBody: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: routeMocks.notFound,
  redirect: routeMocks.redirect,
}));
vi.mock("@/lib/auth", () => ({ getSessionFromCookies: vi.fn() }));
vi.mock("@/lib/access/require-business-page-context", () => ({
  requireBusinessPageContext: vi.fn(),
}));
vi.mock("@/lib/zero-base/auth-routing", () => ({
  loginUrlFor: routeMocks.loginUrlFor,
}));
vi.mock("@/lib/zero-base/provider-scope-server", () => ({
  resolveProviderAccountId: vi.fn(),
}));

vi.mock("@/app/(dashboard)/platforms/meta/creatives/legacy-page", () => ({
  default: (props: LegacyCreativePageProps) => {
    routeMocks.performanceBody(props);
    return null;
  },
}));
vi.mock("@/app/(dashboard)/platforms/meta/copies/legacy-page", () => ({
  default: (props: LegacyCreativePageProps) => {
    routeMocks.copiesBody(props);
    return null;
  },
}));
vi.mock(
  "@/app/(dashboard)/platforms/meta/landing-pages/legacy-page",
  () => ({
    default: (props: LegacyCreativePageProps) => {
      routeMocks.landingPagesBody(props);
      return null;
    },
  }),
);
vi.mock(
  "@/app/(dashboard)/platforms/meta/creative-inbox/legacy-page",
  () => ({
    default: (props: LegacyCreativePageProps) => {
      routeMocks.inboxBody(props);
      return null;
    },
  }),
);
vi.mock("@/app/(dashboard)/platforms/meta/audiences/legacy-page", () => ({
  default: (props: LegacyCreativePageProps) => {
    routeMocks.audiencesBody(props);
    return null;
  },
}));

const PerformancePage = (
  await import("@/app/c/[businessId]/creative/performance/page")
).default;
const CopiesPage = (
  await import("@/app/c/[businessId]/creative/copies/page")
).default;
const LandingPagesPage = (
  await import("@/app/c/[businessId]/creative/landing-pages/page")
).default;
const InboxPage = (
  await import("@/app/c/[businessId]/creative/inbox/page")
).default;
const AudiencesPage = (
  await import("@/app/c/[businessId]/creative/audiences/page")
).default;

const auth = await import("@/lib/auth");
const businessPageAccess = await import(
  "@/lib/access/require-business-page-context"
);
const providerScope = await import("@/lib/zero-base/provider-scope-server");

type CreativeRoutePage = typeof PerformancePage;

const routes: Array<{
  label: string;
  path: string;
  Page: CreativeRoutePage;
  body: typeof routeMocks.performanceBody;
}> = [
  {
    label: "Assets",
    path: "performance",
    Page: PerformancePage,
    body: routeMocks.performanceBody,
  },
  {
    label: "Copies",
    path: "copies",
    Page: CopiesPage,
    body: routeMocks.copiesBody,
  },
  {
    label: "Landers",
    path: "landing-pages",
    Page: LandingPagesPage,
    body: routeMocks.landingPagesBody,
  },
  {
    label: "Inbox",
    path: "inbox",
    Page: InboxPage,
    body: routeMocks.inboxBody,
  },
  {
    label: "Audiences",
    path: "audiences",
    Page: AudiencesPage,
    body: routeMocks.audiencesBody,
  },
];

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
    activeBusinessId: "different_selected_business",
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

async function renderPage(
  Page: CreativeRoutePage,
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  const element = await Page({
    params: Promise.resolve({ businessId: "biz_route" }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(
    businessPageAccess.requireBusinessPageContext,
  ).mockResolvedValue(authorizedContext("biz_route") as never);
  vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValue(
    "act_assigned",
  );
});

describe("Creative Studio canonical route authority", () => {
  it.each(routes)(
    "$label forwards only the authorized business and assigned provider account to the exact legacy body",
    async ({ Page, body }) => {
      await renderPage(Page, { providerAccountId: "act_requested" });

      expect(
        businessPageAccess.requireBusinessPageContext,
      ).toHaveBeenCalledWith({ businessId: "biz_route" });
      expect(providerScope.resolveProviderAccountId).toHaveBeenCalledWith({
        businessId: "biz_route",
        provider: "meta",
        requestedAccountId: "act_requested",
      });
      expect(body).toHaveBeenCalledTimes(1);
      expect(body).toHaveBeenCalledWith({
        businessId: "biz_route",
        providerAccountId: "act_assigned",
      });
    },
  );

  it.each(routes)(
    "$label redirects an unauthenticated request before membership and provider resolution",
    async ({ path, Page, body }) => {
      vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

      await expect(
        Page({
          params: Promise.resolve({ businessId: "biz_route" }),
          searchParams: Promise.resolve({
            providerAccountId: "act_unassigned",
          }),
        }),
      ).rejects.toThrow("NEXT_REDIRECT:");

      expect(routeMocks.loginUrlFor).toHaveBeenCalledWith(
        `/c/biz_route/creative/${path}`,
      );
      expect(routeMocks.redirect).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent(`/c/biz_route/creative/${path}`)}`,
      );
      expect(
        businessPageAccess.requireBusinessPageContext,
      ).not.toHaveBeenCalled();
      expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "$label returns not-found for an authenticated user outside the route business",
    async ({ Page, body }) => {
      vi.mocked(
        businessPageAccess.requireBusinessPageContext,
      ).mockResolvedValueOnce({ kind: "not-found" } as never);

      await expect(
        Page({
          params: Promise.resolve({ businessId: "biz_foreign" }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow("NEXT_NOT_FOUND");

      expect(
        businessPageAccess.requireBusinessPageContext,
      ).toHaveBeenCalledWith({ businessId: "biz_foreign" });
      expect(routeMocks.notFound).toHaveBeenCalledTimes(1);
      expect(providerScope.resolveProviderAccountId).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    },
  );

  it("forwards a refused provider account as null instead of widening scope", async () => {
    vi.mocked(providerScope.resolveProviderAccountId).mockResolvedValueOnce(
      null,
    );

    await renderPage(AudiencesPage, {
      providerAccountId: "act_unassigned",
    });

    expect(routeMocks.audiencesBody).toHaveBeenCalledWith({
      businessId: "biz_route",
      providerAccountId: null,
    });
  });
});
