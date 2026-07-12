import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopSidebar } from "@/components/layout/sidebar";
import { SidebarContent } from "@/components/layout/sidebar-content";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";
import { DashboardFrame } from "@/components/layout/dashboard-frame";

const state = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  plan: "growth",
  selectedBusinessId: "biz_1",
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
  useSearchParams: () => new URLSearchParams(),
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
    }) => unknown,
  ) =>
    selector({
      hasHydrated: true,
      authBootstrapStatus: "ready",
      workspaceResolved: true,
      selectedBusinessId: state.selectedBusinessId,
      businesses: state.businesses,
    }),
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlan: () => state.plan,
}));

describe("phase shell redesign", () => {
  it("renders the 3-layer sidebar with Meta platform context", () => {
    state.pathname = "/platforms/meta/creatives";
    state.selectedBusinessId = "biz_1";
    state.plan = "growth";

    const html = renderToStaticMarkup(<SidebarContent />);

    expect(html).toContain("Workspace");
    expect(html).toContain("Platform");
    expect(html).toContain("Manage");
    expect(html).toContain("Meta");
    expect(html).toContain("Creative Studio");
    expect(html).toContain("/platforms/meta/creatives");
    expect(html).not.toContain(">Copies<");
    expect(html).not.toContain(">Landing Pages<");
    expect(html).not.toContain("v3.4.1");
  });

  it("keeps the primary sidebar available in a compact icon mode", () => {
    state.pathname = "/platforms/meta";
    const html = renderToStaticMarkup(
      <SidebarContent variant="console" collapsed />,
    );

    expect(html).toContain("w-[56px]");
    expect(html).toContain('aria-label="Decisions"');
    expect(html).toContain('title="Creative Studio"');
    expect(html).toContain("/platforms/meta/automation");
  });

  it("keeps the existing expanded console navigation unchanged by the compact mode", () => {
    state.pathname = "/platforms/meta";
    const html = renderToStaticMarkup(<SidebarContent variant="console" />);

    expect(html).toContain("w-[196px]");
    expect(html).not.toContain("w-[56px]");
    expect(html).toContain("Workspace");
    expect(html).toContain("Platform");
    expect(html).toContain("Manage");
    expect(html).toContain('data-l2="pulse"');
    expect(html).toContain("h-[15px] w-[15px]");
  });

  it("keeps the sidebar desktop-only so mobile Meta pages retain usable width", () => {
    const html = renderToStaticMarkup(<DesktopSidebar />);

    expect(html).toContain("hidden w-60 shrink-0 md:block");
    expect(html).toContain("data-shell-sidebar");
  });

  it("dims Layer 2 and keeps the last-viewed platform on Layer 1 routes", () => {
    state.pathname = "/overview";

    const html = renderToStaticMarkup(<SidebarContent />);

    expect(html).toContain("last viewed");
    expect(html).toContain("opacity-50");
  });

  it("hides plan-lock indicators for demo businesses", () => {
    state.pathname = "/overview";
    state.selectedBusinessId = "demo";
    state.plan = "starter";

    const html = renderToStaticMarkup(<SidebarContent />);

    expect(html).toContain("Insights");
    expect(html).not.toContain("Upgrade to Pro");
  });

  it("renders the PlatformSwitcher with the active platform logo and no search input", () => {
    state.pathname = "/platforms/meta";
    state.selectedBusinessId = "biz_1";

    const html = renderToStaticMarkup(<PlatformSwitcher />);

    expect(html).toContain("Meta");
    expect(html).toContain("/platform-logos/Meta.png");
    expect(html).not.toContain("Search");
  });

  it("renders compact mobile shell hooks and leaves Meta Decisions mobile composition to the page", () => {
    state.pathname = "/platforms/meta";
    state.selectedBusinessId = "biz_1";

    const html = renderToStaticMarkup(
      <DashboardFrame userName="Shopify App Reviewer">
        <div>Meta body</div>
      </DashboardFrame>,
    );

    expect(html).toContain("ad-console-brand");
    expect(html).toContain("ad-console-business");
    expect(html).toContain("ad-console-platform");
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
