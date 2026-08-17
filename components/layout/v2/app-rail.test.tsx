// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/overview",
  search: "",
  plan: "scale",
  selectedBusinessId: "biz_1",
  push: vi.fn(),
  domainsByBusinessId: {} as Record<
    string,
    Record<string, { connection: { status: string; lastSyncAt?: string } }>
  >,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
  useRouter: () => ({ push: state.push }),
}));

vi.mock("next/image", () => ({
  default: ({
    unoptimized: _unoptimized,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) =>
    React.createElement("img", props),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (value: { language: "en" }) => unknown) =>
    selector({ language: "en" }),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (value: {
      selectedBusinessId: string;
      businesses: Array<{
        id: string;
        name: string;
        currency: string;
        isDemoBusiness?: boolean;
      }>;
    }) => unknown,
  ) =>
    selector({
      selectedBusinessId: state.selectedBusinessId,
      businesses: [
        { id: "biz_1", name: "Grandmix", currency: "USD" },
      ],
    }),
}));

vi.mock("@/lib/pricing/usePlan", () => ({ usePlan: () => state.plan }));
vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: vi.fn(),
}));
vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (
    selector: (value: {
      domainsByBusinessId: typeof state.domainsByBusinessId;
    }) => unknown,
  ) => selector({ domainsByBusinessId: state.domainsByBusinessId }),
}));
vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useMetaActionNowCount: () => null,
  useGoogleAdvisorCount: () => null,
}));

import {
  AppRail,
  buildRailScopedHref,
} from "@/components/layout/v2/app-rail";

describe("Dashboard v2 rail navigation", () => {
  beforeEach(() => {
    state.pathname = "/overview";
    state.search = "";
    state.plan = "scale";
    state.selectedBusinessId = "biz_1";
    state.domainsByBusinessId = {};
    state.push.mockReset();
  });

  afterEach(() => cleanup());

  it("retains the actual providerAccountId=act_77 query in an /app Meta destination", () => {
    expect(
      buildRailScopedHref({
        href: "/platforms/meta/creatives?tab=assets",
        pathname: "/app/meta/decisions",
        businessId: "biz_1",
        providerAccountId: "act_77",
      }),
    ).toBe(
      "/app/creative/performance?tab=assets&businessId=biz_1&providerAccountId=act_77",
    );
  });

  it("retains the actual providerAccountId=google_99 query in a /c Google destination", () => {
    expect(
      buildRailScopedHref({
        href: "/platforms/google/advisor?view=queue",
        pathname: "/c/biz_1/google/overview",
        businessId: "biz_1",
        providerAccountId: "google_99",
      }),
    ).toBe(
      "/c/biz_1/google/advisor?view=queue&providerAccountId=google_99",
    );
  });

  it("drops providerAccountId in both Meta-to-Google and Google-to-Meta rail transitions", () => {
    expect(
      buildRailScopedHref({
        href: "/platforms/google/advisor?providerAccountId=act_stale&view=queue",
        pathname: "/app/creative/performance",
        businessId: "biz_1",
        providerAccountId: "act_77",
      }),
    ).toBe("/app/google/advisor?view=queue");
    expect(
      buildRailScopedHref({
        href: "/platforms/meta/creatives?providerAccountId=google_stale",
        pathname: "/c/biz_1/google/overview",
        businessId: "biz_1",
        providerAccountId: "google_99",
      }),
    ).toBe("/c/biz_1/creative/performance?businessId=biz_1");
  });

  it("keeps Klaviyo out of the rail until the source has actually synced", () => {
    // Design 3284: `navPlatforms` carries Klaviyo only when `klaviyoOn`, and
    // 2864 says roadmap sources "stay out of the sidebar until the integration
    // is live". Standing on the Klaviyo screen is not evidence that it is live.
    state.pathname = "/platforms/klaviyo";
    const { container } = render(<AppRail userName="Emrah Bilaloglu" />);
    expect(container.querySelector('[data-platform="klaviyo"]')).toBeNull();
    expect(container.textContent).not.toContain("Klaviyo");
  });

  it("adds Klaviyo to the rail once its connection reports a landed sync", () => {
    state.domainsByBusinessId = {
      biz_1: {
        klaviyo: {
          connection: {
            status: "connected",
            lastSyncAt: "2026-08-17T11:56:00.000Z",
          },
        },
      },
    };
    const { container } = render(<AppRail userName="Emrah Bilaloglu" />);
    expect(container.querySelector('[data-platform="klaviyo"]')).not.toBeNull();
    expect(container.textContent).toContain("Klaviyo");
  });

  it("keeps Klaviyo out while its connection has never synced", () => {
    state.domainsByBusinessId = {
      biz_1: { klaviyo: { connection: { status: "connected" } } },
    };
    const { container } = render(<AppRail userName="Emrah Bilaloglu" />);
    expect(container.textContent).not.toContain("Klaviyo");
  });

  it("keeps every canonical div rail row keyboard reachable and activates Enter or Space", () => {
    state.pathname = "/app/google/overview";
    state.search = "providerAccountId=google_99";
    const { container } = render(<AppRail userName="Emrah Bilaloglu" />);

    const rows = Array.from(
      container.querySelectorAll(".adv-rail-item, .adv-rail-child"),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tagName).toBe("DIV");
      expect(row).toHaveAttribute("role", "link");
      expect(row).toHaveAttribute("tabindex", "0");
    }

    expect(
      fireEvent.keyDown(container.querySelector('[data-nav="overview"]')!, {
        key: "Enter",
      }),
    ).toBe(false);
    expect(
      fireEvent.keyDown(
        container.querySelector('[data-nav="google-google-advisor"]')!,
        { key: " " },
      ),
    ).toBe(false);

    expect(state.push.mock.calls).toEqual([
      ["/app/home"],
      ["/app/google/advisor?providerAccountId=google_99"],
    ]);
  });
});
