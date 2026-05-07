import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarContent } from "@/components/layout/sidebar-content";
import { PlatformSwitcher } from "@/components/layout/PlatformSwitcher";

const state = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  plan: "growth",
  selectedBusinessId: "biz_1",
  businesses: [
    { id: "biz_1", name: "TheSwaf", currency: "USD", timezone: "Europe/Istanbul" },
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
  useRouter: () => ({ push: state.push, refresh: vi.fn() }),
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
      selectedBusinessId: string;
      businesses: typeof state.businesses;
    }) => unknown
  ) =>
    selector({
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
    expect(html).toContain("/platforms/meta/creatives");
    expect(html).not.toContain("v3.4.1");
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
});
