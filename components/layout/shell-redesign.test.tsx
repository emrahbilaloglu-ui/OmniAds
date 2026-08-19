import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The console frame renders the notification bell, which reads data. The app
// mounts it under the root QueryProvider, so the test renders it the same way.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppRail,
  buildRailScopedHref,
} from "@/components/layout/v2/app-rail";
import { DashboardFrame } from "@/components/layout/dashboard-frame";

const state = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  plan: "growth",
  selectedBusinessId: "biz_1",
  search: "",
  actionNowCount: null as number | null,
  googleAdvisorCount: null as number | null,
  businesses: [
    {
      id: "biz_1",
      name: "TheSwaf",
      currency: "USD",
      timezone: "Europe/Istanbul",
    },
    {
      id: "demo",
      name: "Demo Co.",
      currency: "USD",
      timezone: "Europe/Istanbul",
      isDemoBusiness: true,
    },
  ],
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: state.push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) =>
    React.createElement("img", props),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: { language: "en" }) => unknown) =>
    selector({ language: "en" }),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (value: {
      hasHydrated: boolean;
      authBootstrapStatus: "ready";
      workspaceResolved: boolean;
      selectedBusinessId: string;
      businesses: typeof state.businesses;
      selectBusiness: () => void;
    }) => unknown,
  ) =>
    selector({
      hasHydrated: true,
      authBootstrapStatus: "ready",
      workspaceResolved: true,
      selectedBusinessId: state.selectedBusinessId,
      businesses: state.businesses,
      selectBusiness: () => {},
    }),
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlan: () => state.plan,
  usePlanState: () => ({ plan: state.plan, isLoading: false, isReady: true }),
}));

vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useMetaActionNowCount: () => state.actionNowCount,
  useGoogleAdvisorCount: () => state.googleAdvisorCount,
  // The rail mints links only from the business the shell has confirmed; this
  // suite renders a fully bootstrapped shell, so the selection is confirmed.
  useConfirmedShellBusinessId: () => state.selectedBusinessId,
  useWorkspaceSyncState: () => ({
    tone: "fresh",
    label: "Synced 12m ago",
    freshnessState: "ready",
  }),
}));

// Only the picker's value is stubbed. `useCanonicalDateWindowUrl` — the shell's
// single ITEM 10 authority, which states the window on the URL before any
// surface reads it — stays real, because a shell suite that stubbed it away
// could not notice the shell had stopped stating a window at all.
vi.mock("@/hooks/use-persistent-date-range", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-persistent-date-range")>();
  return {
    ...actual,
    usePersistentDateRange: () => [
      {
        rangePreset: "28d",
        customStart: "",
        customEnd: "",
        comparisonPreset: "previousPeriod",
        comparisonStart: "",
        comparisonEnd: "",
      },
      () => {},
    ],
  };
});

describe("dashboard v2 shell", () => {
  beforeEach(() => {
    state.pathname = "/platforms/meta/creatives";
    state.plan = "growth";
    state.selectedBusinessId = "biz_1";
    state.search = "";
    state.actionNowCount = null;
    state.googleAdvisorCount = null;
    state.push.mockReset();
  });

  it("renders one grouped rail with the Meta tree expanded", () => {
    const html = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);

    expect(html).toContain("adv-rail");
    expect(html).toContain("Platforms");
    expect(html).toContain("Growth");
    expect(html).toContain("Workspace");
    expect(html).toContain("Overview");
    expect(html).toContain("Decisions");
    expect(html).toContain("Creative Studio");
    expect(html).toContain("Launchpad");
    expect(html).toContain("Automation");
    expect(html).toContain("Commercial Truth");
    // The platform switcher is now the rail tree, not a topbar dropdown.
    expect(html).toContain("/platform-logos/Meta.png");
    expect(html).toContain("/platform-logos/googleAds.svg");
  });

  it("marks the routed Meta child active and leaves the parent as a family header", () => {
    state.pathname = "/platforms/meta/creatives";

    const html = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);

    expect(html).toContain(
      'data-active="true" data-nav="meta-creative-studio"',
    );
    expect(html).toContain('data-active="false" data-nav="meta-pulse"');
    expect(html).toContain(
      'data-active="false" data-family="true" data-platform="meta"',
    );
  });

  it("retains actual providerAccountId query values across Meta and Google rail transitions", () => {
    expect(
      buildRailScopedHref({
        href: "/platforms/meta/creatives",
        pathname: "/app/meta/decisions",
        businessId: "biz_1",
        providerAccountId: "act_1",
      }),
    ).toBe(
      "/app/creative/performance?businessId=biz_1&providerAccountId=act_1",
    );
    expect(
      buildRailScopedHref({
        href: "/platforms/google/advisor",
        pathname: "/c/biz_1/google/overview",
        businessId: "biz_1",
        providerAccountId: "google_1",
      }),
    ).toBe("/c/biz_1/google/advisor?providerAccountId=google_1");
    expect(
      buildRailScopedHref({
        href: "/platforms/google/advisor",
        pathname: "/app/meta/decisions",
        businessId: "biz_1",
        providerAccountId: "act_1",
      }),
    ).toBe("/app/google/advisor");
  });

  it("shows the two design-defined rail counts only when real snapshots are cached", () => {
    state.pathname = "/platforms/meta";

    expect(
      renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />),
    ).not.toContain("adv-rail-count");

    state.actionNowCount = 4;
    const withCount = renderToStaticMarkup(
      <AppRail userName="Emrah Bilaloglu" />,
    );
    expect(withCount).toContain("adv-rail-count");
    expect(withCount).toContain(">4<");

    state.pathname = "/platforms/google/advisor";
    state.actionNowCount = null;
    state.googleAdvisorCount = 3;
    const withAdvisorCount = renderToStaticMarkup(
      <AppRail userName="Emrah Bilaloglu" />,
    );
    expect(withAdvisorCount).toContain('data-nav="google-google-advisor"');
    expect(withAdvisorCount).toContain(">3<");
  });

  it("hides plan-lock indicators for demo businesses", () => {
    state.pathname = "/overview";
    state.selectedBusinessId = "demo";
    state.plan = "starter";

    const html = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);

    expect(html).toContain("Insights");
    expect(html).not.toContain("Upgrade to Pro");
  });

  it("preserves plan gating without adding a badge absent from the reference", () => {
    state.pathname = "/overview";
    state.selectedBusinessId = "biz_1";
    state.plan = "starter";

    const html = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);

    expect(html).toContain("Upgrade to Pro to unlock");
    expect(html).not.toContain("data-plan-entitlement-class");
  });

  it("uses the same shell on Overview as on platform routes", () => {
    for (const pathname of ["/overview", "/platforms/meta"]) {
      state.pathname = pathname;
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <DashboardFrame userName="Shopify App Reviewer">
            <div>{pathname} body</div>
          </DashboardFrame>
        </QueryClientProvider>,
      );
      expect(html).toContain("adv-shell");
      expect(html).toContain("adv-rail");
      expect(html).toContain("adv-topbar");
      expect(html).toContain(`${pathname} body`);
    }
  });

  it("renders the design's static freshness pill and binary comparison toggle", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardFrame userName="Shopify App Reviewer">
          <div>Overview body</div>
        </DashboardFrame>
      </QueryClientProvider>,
    );

    expect(html.match(/class="adv-pill"/g)).toHaveLength(1);
    expect(html).toContain('<span class="adv-pill"');
    expect(html).toContain('data-freshness-state="ready"');
    expect(html).not.toContain("Refresh data —");
    expect(html).toContain(
      'title="Toggle comparison with the previous period"',
    );
    expect(html).toContain(">vs previous period</span>");
    expect(html).not.toContain("vs previous year");
    expect(html).not.toContain('aria-label="Account"');
  });

  it("renders compact mobile shell hooks and leaves Meta Decisions mobile composition to the page", () => {
    state.pathname = "/platforms/meta";
    state.selectedBusinessId = "biz_1";

    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardFrame userName="Shopify App Reviewer">
          <div>Meta body</div>
        </DashboardFrame>
      </QueryClientProvider>,
    );

    expect(html).not.toContain("ad-console-mobile-readonly");
    expect(html).not.toContain("Adsecute · mobile read-only");
    expect(html).toContain('data-mobile-surface="none"');
    expect(html).toContain("Meta body");
    expect(html).not.toContain("Meta decisions mobile read-only");
  });

  it("does not replace Automation or Launchpad page-owned mobile surfaces with the generic Meta fallback", () => {
    for (const [pathname, mobileNote] of [
      ["/platforms/meta/automation", "Guardrails are view-only here"],
      ["/platforms/meta/launchpad", "Launch state is view-only here"],
    ] as const) {
      state.pathname = pathname;
      state.selectedBusinessId = "biz_1";

      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <DashboardFrame userName="Shopify App Reviewer">
            <div>{pathname} body</div>
          </DashboardFrame>
        </QueryClientProvider>,
      );

      expect(html).toContain('data-mobile-surface="none"');
      expect(html).not.toContain(mobileNote);
      expect(html).toContain(`${pathname} body`);
      expect(html).not.toContain("Meta evidence mobile read-only");
    }
  });

  it("leaves every exact Google Overview and Advisor mobile surface to the route", () => {
    for (const pathname of [
      "/platforms/google",
      "/platforms/google/advisor",
      "/app/google/overview",
      "/app/google/advisor",
      "/c/biz_1/google/overview",
      "/c/biz_1/google/advisor",
    ]) {
      state.pathname = pathname;
      state.selectedBusinessId = "biz_1";

      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <DashboardFrame userName="Shopify App Reviewer">
            <div>{pathname} responsive body</div>
          </DashboardFrame>
        </QueryClientProvider>,
      );

      expect(html).toContain('data-mobile-surface="none"');
      expect(html).toContain(`${pathname} responsive body`);
      expect(html).not.toContain("ad-console-mobile-readonly");
      expect(html).not.toContain("Adsecute · mobile read-only");
    }
  });

  it("keeps every Studio and History mobile route on its real responsive surface", () => {
    for (const pathname of [
      "/platforms/meta/history",
      "/platforms/meta/creatives",
      "/platforms/meta/copies",
      "/platforms/meta/landing-pages",
      "/platforms/meta/creative-inbox",
      "/platforms/meta/audiences",
    ]) {
      state.pathname = pathname;
      state.selectedBusinessId = "biz_1";

      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <DashboardFrame userName="Shopify App Reviewer">
            <div>{pathname} responsive body</div>
          </DashboardFrame>
        </QueryClientProvider>,
      );

      expect(html).toContain('data-mobile-surface="none"');
      expect(html).toContain(`${pathname} responsive body`);
      expect(html).not.toContain("Meta evidence mobile read-only");
    }
  });
});
