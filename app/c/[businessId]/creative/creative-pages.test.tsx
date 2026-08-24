import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type LegacyCreativePageProps = {
  businessId?: string;
  providerAccountId?: string | null;
  serverDateWindow?: { start: string; end: string } | null;
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
  /**
   * The surface-state resolver reads the SCOPE, not just the id: it needs the
   * refusal reason to tell "nothing assigned" from "several assigned, none
   * chosen". Derived from the same mock so the two can never disagree about
   * which account this request resolved to.
   */
  resolveProviderAccountScope: async (input: unknown) => {
    // Reaches the same mock through the module itself, because the factory
    // runs before the file's own bindings exist and cannot close over one.
    const { resolveProviderAccountId: resolveId } = (await import(
      "@/lib/zero-base/provider-scope-server"
    )) as { resolveProviderAccountId: (value: unknown) => Promise<string | null> };
    const id = await resolveId(input);
    return id
      ? { providerAccountId: id, refusal: null, requestedButUnassigned: null }
      : {
          providerAccountId: null,
          refusal: "provider_account_none_assigned" as const,
          requestedButUnassigned: null,
        };
  },
  readProviderScopeCatalog: async () => ({ provider: "meta" as const, accounts: [] }),
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
  /**
   * Whether the route hands its server-parsed `?start`/`?end` window to the
   * body. Audiences does not: its body reads the same pair off the URL itself
   * with the same validator, so the window already survives a reload there.
   */
  forwardsWindow: boolean;
}> = [
  {
    label: "Assets",
    path: "performance",
    Page: PerformancePage,
    body: routeMocks.performanceBody,
    forwardsWindow: true,
  },
  {
    label: "Copies",
    path: "copies",
    Page: CopiesPage,
    body: routeMocks.copiesBody,
    forwardsWindow: true,
  },
  {
    label: "Landers",
    path: "landing-pages",
    Page: LandingPagesPage,
    body: routeMocks.landingPagesBody,
    forwardsWindow: true,
  },
  {
    label: "Inbox",
    path: "inbox",
    Page: InboxPage,
    body: routeMocks.inboxBody,
    forwardsWindow: true,
  },
  {
    label: "Audiences",
    path: "audiences",
    Page: AudiencesPage,
    body: routeMocks.audiencesBody,
    forwardsWindow: false,
  },
];

const windowForwardingRoutes = routes.filter((route) => route.forwardsWindow);

/** The props a route hands its body, with the window only where one is sent. */
function expectedBodyProps(
  route: (typeof routes)[number],
  serverDateWindow: { start: string; end: string } | null,
) {
  return route.forwardsWindow
    ? {
        businessId: "biz_route",
        providerAccountId: "act_assigned",
        serverDateWindow,
      }
    : { businessId: "biz_route", providerAccountId: "act_assigned" };
}

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
    async (route) => {
      const { Page, body } = route;
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
      expect(body).toHaveBeenCalledWith(expectedBodyProps(route, null));
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

  it.each(windowForwardingRoutes)(
    "$label hands the body the window the link names, not the one the browser last stored",
    async (route) => {
      await renderPage(route.Page, {
        providerAccountId: "act_requested",
        start: "2026-03-01",
        end: "2026-03-07",
      });

      expect(route.body).toHaveBeenCalledWith(
        expectedBodyProps(route, { start: "2026-03-01", end: "2026-03-07" }),
      );
    },
  );

  it.each(windowForwardingRoutes)(
    "$label reads the window in the shell's spelling too",
    async (route) => {
      // The shell date control states its window as ?window/?startDate/?endDate
      // (lib/dashboard/date-window-url.ts). A route that understood only the
      // Creative Studio's own ?start/?end would ignore the operator's control
      // on the server, where a stored preference cannot reach.
      await renderPage(route.Page, {
        window: "custom",
        startDate: "2026-03-01",
        endDate: "2026-03-07",
      });

      expect(route.body).toHaveBeenCalledWith(
        expectedBodyProps(route, { start: "2026-03-01", end: "2026-03-07" }),
      );
    },
  );

  it.each(windowForwardingRoutes)(
    "$label lets the shell's window outrank a stale Studio pair",
    async (route) => {
      await renderPage(route.Page, {
        start: "2026-01-01",
        end: "2026-01-28",
        startDate: "2026-03-01",
        endDate: "2026-03-07",
      });

      // Both spellings on one URL is the ordinary case after the operator moves
      // the control on a Studio link: the range they just chose is the answer.
      expect(route.body).toHaveBeenCalledWith(
        expectedBodyProps(route, { start: "2026-03-01", end: "2026-03-07" }),
      );
    },
  );

  it.each(windowForwardingRoutes)(
    "$label reproduces the same window on reload",
    async (route) => {
      const link = {
        providerAccountId: "act_requested",
        start: "2026-03-01",
        end: "2026-03-07",
      };

      await renderPage(route.Page, link);
      await renderPage(route.Page, link);

      // Two requests for one URL: the window is a property of the link, not of
      // whatever the last visit left in browser storage. Reload determinism is
      // the whole point of parsing it on the server.
      const [first, second] = route.body.mock.calls;
      expect(second).toEqual(first);
      expect(route.body).toHaveBeenLastCalledWith(
        expectedBodyProps(route, { start: "2026-03-01", end: "2026-03-07" }),
      );
    },
  );

  it.each(windowForwardingRoutes)(
    "$label reports an absent window as absent rather than inventing 28 days",
    async (route) => {
      await renderPage(route.Page, { providerAccountId: "act_requested" });

      // A route-side default would silently outrank the shell's date control:
      // it is resolved on a UTC clock rather than the account's, so it can name
      // a different day, and it would overwrite a range the operator chose. The
      // honest answer to "no window was requested" is null.
      expect(route.body).toHaveBeenCalledWith(expectedBodyProps(route, null));
    },
  );

  it.each(windowForwardingRoutes)(
    "$label refuses a half window instead of repairing it",
    async (route) => {
      await renderPage(route.Page, { start: "2026-03-01" });

      expect(route.body).toHaveBeenCalledWith(expectedBodyProps(route, null));
    },
  );

  it.each(windowForwardingRoutes)(
    "$label refuses a malformed, impossible or backwards window",
    async (route) => {
      for (const link of [
        { start: "yesterday", end: "2026-03-07" },
        { start: "2026-02-30", end: "2026-03-07" },
        { start: "2026-03-08", end: "2026-03-07" },
        { start: ["2026-03-01", "2026-04-01"], end: "not-a-date" },
      ] as Array<Record<string, string | string[]>>) {
        route.body.mockClear();
        await renderPage(route.Page, link);

        // A URL is a request, never authority. A window that cannot be read is
        // not repaired into one the link never named and never reaches a read.
        expect(route.body).toHaveBeenCalledWith(expectedBodyProps(route, null));
      }
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
