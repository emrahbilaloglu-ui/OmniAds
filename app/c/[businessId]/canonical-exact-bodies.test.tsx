/**
 * The three screens whose canonical leaves used to render a different surface
 * than their legacy path.
 *
 * Overview, Settings and Commercial Truth each have exactly one exact body.
 * Before this test they had two: `/overview`, `/settings` and
 * `/commercial-truth` mounted the Dashboard v2 components, while `/app/home`,
 * `/app/manage/plan` and `/app/manage/business` — which are the same three
 * screens once `ZERO_BASE_UI_MODE` is on — mounted `HomeView`, `PlanView` and
 * `BusinessView` instead. Nothing failed; the canonical family simply showed
 * a different product.
 *
 * So this asserts convergence structurally, from both ends: the `/c` leaf
 * mounts the preserved legacy body (with its authorization prologue intact),
 * and the legacy shim mounts that same module.
 */
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string): never => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  loginUrlFor: vi.fn((next: string) => `/login?next=${encodeURIComponent(next)}`),
  overviewBody: vi.fn(),
  settingsBody: vi.fn(),
  commercialTruthBody: vi.fn(),
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

// The bridge is a pass-through here so the mounted body is observable in the
// rendered markup rather than only in a call count.
vi.mock("@/components/legacy/legacy-interior-bridge", () => ({
  LegacyInteriorBridge: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/app/(dashboard)/overview/legacy-page", () => ({
  default: () => {
    routeMocks.overviewBody();
    return <div data-exact-body="overview" />;
  },
}));
vi.mock("@/app/(dashboard)/settings/legacy-page", () => ({
  default: () => {
    routeMocks.settingsBody();
    return <div data-exact-body="settings" />;
  },
}));
vi.mock("@/app/(dashboard)/commercial-truth/legacy-page", () => ({
  default: () => {
    routeMocks.commercialTruthBody();
    return <div data-exact-body="commercial-truth" />;
  },
}));

const HomePage = (await import("@/app/c/[businessId]/home/page")).default;
const PlanPage = (await import("@/app/c/[businessId]/manage/plan/page")).default;
const BusinessPage = (await import("@/app/c/[businessId]/manage/business/page")).default;

const auth = await import("@/lib/auth");
const businessPageAccess = await import("@/lib/access/require-business-page-context");

type ScopedPage = (props: {
  params: Promise<{ businessId: string }>;
}) => Promise<ReactElement>;

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

const screens: Array<{
  label: string;
  Page: ScopedPage;
  marker: string;
  loginNext: string;
  body: ReturnType<typeof vi.fn>;
  /** The one exact body module both families must resolve to. */
  legacyModule: string;
  /** The `/c` page file and the legacy shim file that must agree on it. */
  canonicalPage: string;
  legacyShim: string;
}> = [
  {
    label: "Overview",
    Page: HomePage as unknown as ScopedPage,
    marker: "overview",
    loginNext: "/c/biz_route/home",
    body: routeMocks.overviewBody,
    legacyModule: "@/app/(dashboard)/overview/legacy-page",
    canonicalPage: "app/c/[businessId]/home/page.tsx",
    legacyShim: "app/(dashboard)/overview/page.tsx",
  },
  {
    label: "Settings",
    Page: PlanPage as unknown as ScopedPage,
    marker: "settings",
    loginNext: "/c/biz_route/manage",
    body: routeMocks.settingsBody,
    legacyModule: "@/app/(dashboard)/settings/legacy-page",
    canonicalPage: "app/c/[businessId]/manage/plan/page.tsx",
    legacyShim: "app/(dashboard)/settings/page.tsx",
  },
  {
    label: "Commercial Truth",
    Page: BusinessPage as unknown as ScopedPage,
    marker: "commercial-truth",
    loginNext: "/c/biz_route/manage",
    body: routeMocks.commercialTruthBody,
    legacyModule: "@/app/(dashboard)/commercial-truth/legacy-page",
    canonicalPage: "app/c/[businessId]/manage/business/page.tsx",
    legacyShim: "app/(dashboard)/commercial-truth/page.tsx",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.getSessionFromCookies).mockResolvedValue(session() as never);
  vi.mocked(businessPageAccess.requireBusinessPageContext).mockResolvedValue(
    authorizedContext("biz_route") as never,
  );
});

describe("canonical /c leaves mount the exact Dashboard v2 body", () => {
  it.each(screens)(
    "$label renders its exact body on /c",
    async ({ Page, marker, body }) => {
      const html = renderToStaticMarkup(
        (await Page({
          params: Promise.resolve({ businessId: "biz_route" }),
        })) as ReactElement,
      );

      expect(businessPageAccess.requireBusinessPageContext).toHaveBeenCalledWith({
        businessId: "biz_route",
      });
      expect(body).toHaveBeenCalledTimes(1);
      expect(html).toContain(`data-exact-body="${marker}"`);
    },
  );

  it.each(screens)(
    "$label redirects an unauthenticated request before it reads membership",
    async ({ Page, loginNext, body }) => {
      vi.mocked(auth.getSessionFromCookies).mockResolvedValueOnce(null as never);

      await expect(
        Page({ params: Promise.resolve({ businessId: "biz_route" }) }),
      ).rejects.toThrow("NEXT_REDIRECT:");

      expect(routeMocks.loginUrlFor).toHaveBeenCalledWith(loginNext);
      expect(
        businessPageAccess.requireBusinessPageContext,
      ).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    },
  );

  it.each(screens)(
    "$label answers not-found for a business outside the actor's scope",
    async ({ Page, body }) => {
      vi.mocked(
        businessPageAccess.requireBusinessPageContext,
      ).mockResolvedValueOnce({ kind: "not-found" } as never);

      await expect(
        Page({ params: Promise.resolve({ businessId: "biz_foreign" }) }),
      ).rejects.toThrow("NEXT_NOT_FOUND");

      expect(businessPageAccess.requireBusinessPageContext).toHaveBeenCalledWith({
        businessId: "biz_foreign",
      });
      expect(routeMocks.notFound).toHaveBeenCalledTimes(1);
      expect(body).not.toHaveBeenCalled();
    },
  );

  it.each(screens)(
    "$label answers not-found when the actor's role is refused",
    async ({ Page, body }) => {
      vi.mocked(
        businessPageAccess.requireBusinessPageContext,
      ).mockResolvedValueOnce({ kind: "forbidden" } as never);

      await expect(
        Page({ params: Promise.resolve({ businessId: "biz_route" }) }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(body).not.toHaveBeenCalled();
    },
  );
});

describe("both route families resolve to one exact body module", () => {
  it.each(screens)(
    "$label is the same module on the canonical leaf and the legacy shim",
    ({ legacyModule, canonicalPage, legacyShim }) => {
      const canonicalSource = readFileSync(canonicalPage, "utf8");
      expect(canonicalSource).toContain(`from "${legacyModule}"`);

      // The shim imports the preserved body relatively and hands it to
      // `compatibilityPage`, which mounts it whenever the canonical UI is not
      // being presented. Same file, therefore same screen.
      const shimSource = readFileSync(legacyShim, "utf8");
      expect(shimSource).toContain('from "./legacy-page"');
      expect(shimSource).toContain("compatibilityPage(");
    },
  );

  it("no canonical leaf falls back to a zero-base manage or home surface", () => {
    for (const { canonicalPage } of screens) {
      const source = readFileSync(canonicalPage, "utf8");
      expect(source).not.toContain("manage-clients");
      expect(source).not.toContain("home-view");
    }
  });
});
