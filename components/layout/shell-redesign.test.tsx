import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppRail } from "@/components/layout/v2/app-rail";
import { DashboardFrame } from "@/components/layout/dashboard-frame";

const state = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  plan: "growth",
  selectedBusinessId: "biz_1",
  search: "",
  actionNowCount: null as number | null,
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
  useWorkspaceSyncState: () => ({ tone: "fresh", label: "Synced 12m ago" }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
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
}));

describe("dashboard v2 shell", () => {
  beforeEach(() => {
    state.pathname = "/platforms/meta/creatives";
    state.plan = "growth";
    state.selectedBusinessId = "biz_1";
    state.search = "";
    state.actionNowCount = null;
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

    expect(html).toContain('data-active="true" data-nav="meta-creative-studio"');
    expect(html).toContain('data-active="false" data-nav="meta-pulse"');
    expect(html).toContain('data-active="false" data-family="true" data-platform="meta"');
  });

  it("preserves the selected Meta business and ad account across menu transitions", () => {
    state.pathname = "/platforms/meta";

    const html = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);

    expect(html).toContain("/platforms/meta/creatives?businessId=biz_1");
    expect(html).toContain("/platforms/meta/automation?businessId=biz_1");
  });

  it("shows the Action Now count only when a snapshot is cached", () => {
    state.pathname = "/platforms/meta";

    expect(
      renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />),
    ).not.toContain("adv-rail-count");

    state.actionNowCount = 4;
    const withCount = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);
    expect(withCount).toContain("adv-rail-count");
    expect(withCount).toContain(">4<");
  });

  it("hides plan-lock indicators for demo businesses", () => {
    state.pathname = "/overview";
    state.selectedBusinessId = "demo";
    state.plan = "starter";

    const html = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);

    expect(html).toContain("Insights");
    expect(html).not.toContain("Upgrade to Pro");
  });

  it("renders plan trails for gated entries on a starter workspace", () => {
    state.pathname = "/overview";
    state.selectedBusinessId = "biz_1";
    state.plan = "starter";

    const html = renderToStaticMarkup(<AppRail userName="Emrah Bilaloglu" />);

    expect(html).toContain("Upgrade to Pro to unlock");
    expect(html).toContain("adv-rail-badge");
  });

  it("uses the same shell on Overview as on platform routes", () => {
    for (const pathname of ["/overview", "/platforms/meta"]) {
      state.pathname = pathname;
      const html = renderToStaticMarkup(
        <DashboardFrame userName="Shopify App Reviewer">
          <div>{pathname} body</div>
        </DashboardFrame>,
      );
      expect(html).toContain("adv-shell");
      expect(html).toContain("adv-rail");
      expect(html).toContain("adv-topbar");
      expect(html).toContain(`${pathname} body`);
    }
  });

  it("renders compact mobile shell hooks and leaves Meta Decisions mobile composition to the page", () => {
    state.pathname = "/platforms/meta";
    state.selectedBusinessId = "biz_1";

    const html = renderToStaticMarkup(
      <DashboardFrame userName="Shopify App Reviewer">
        <div>Meta body</div>
      </DashboardFrame>,
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
        <DashboardFrame userName="Shopify App Reviewer">
          <div>{pathname} body</div>
        </DashboardFrame>,
      );

      expect(html).toContain('data-mobile-surface="none"');
      expect(html).not.toContain(mobileNote);
      expect(html).toContain(`${pathname} body`);
      expect(html).not.toContain("Meta evidence mobile read-only");
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
        <DashboardFrame userName="Shopify App Reviewer">
          <div>{pathname} responsive body</div>
        </DashboardFrame>,
      );

      expect(html).toContain('data-mobile-surface="none"');
      expect(html).toContain(`${pathname} responsive body`);
      expect(html).not.toContain("Meta evidence mobile read-only");
    }
  });
});
