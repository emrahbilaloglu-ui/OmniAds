// @vitest-environment jsdom

import React, { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pathname: "/overview",
  plan: "starter",
  selectedBusinessId: "biz_1",
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  selectBusiness: vi.fn(),
  instrumentation: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({
    push: state.push,
    replace: state.replace,
    refresh: state.refresh,
  }),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (value: { language: "en" }) => unknown) =>
    selector({ language: "en" }),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (value: {
      businesses: Array<{
        id: string;
        name: string;
        currency: string;
        isDemoBusiness?: boolean;
      }>;
      selectedBusinessId: string;
      selectBusiness: typeof state.selectBusiness;
    }) => unknown,
  ) =>
    selector({
      businesses: [
        {
          id: "biz_1",
          name: "Grandmix",
          currency: "USD",
          isDemoBusiness: false,
        },
        {
          id: "biz_2",
          name: "TheSwaf",
          currency: "USD",
          isDemoBusiness: false,
        },
        {
          id: "demo",
          name: "Demo Co.",
          currency: "USD",
          isDemoBusiness: true,
        },
      ],
      selectedBusinessId: state.selectedBusinessId,
      selectBusiness: state.selectBusiness,
    }),
}));

vi.mock("@/components/layout/v2/nav-model", () => ({
  getRailModel: () => ({
    home: [{ id: "overview", href: "/overview" }],
    platforms: [],
    growth: [
      { id: "reports", href: "/reports", requiredPlan: "pro" },
      {
        id: "commercial-truth",
        href: "/commercial-truth",
        requiredPlan: "growth",
      },
    ],
    workspace: [
      { id: "team", href: "/team", requiredPlan: "scale" },
      { id: "settings", href: "/settings" },
    ],
    labels: {
      platforms: "Platforms",
      growth: "Growth",
      workspace: "Workspace",
    },
  }),
  getRailJumpTargets: () => [
    { id: "overview", label: "Overview", group: "Home", href: "/overview" },
    { id: "reports", label: "Reports", group: "Growth", href: "/reports" },
    {
      id: "commercial-truth",
      label: "Commercial Truth",
      group: "Growth",
      href: "/commercial-truth",
    },
    { id: "team", label: "Team", group: "Workspace", href: "/team" },
    {
      id: "settings",
      label: "Settings",
      group: "Workspace",
      href: "/settings",
    },
  ],
}));

vi.mock("@/lib/auth-diagnostics", () => ({ logClientAuthEvent: vi.fn() }));
vi.mock("@/lib/pricing/usePlan", () => ({ usePlan: () => state.plan }));
vi.mock("@/lib/product-instrumentation-client", () => ({
  emitProductInstrumentation: state.instrumentation,
}));

import { GlobalSearch } from "@/components/layout/GlobalSearch";
import { CommandPalette } from "@/components/layout/v2/command-palette";

function PaletteHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <GlobalSearch open={open} onOpen={() => setOpen(true)} />
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}

describe("dashboard command palette", () => {
  beforeEach(() => {
    state.pathname = "/overview";
    state.plan = "starter";
    state.selectedBusinessId = "biz_1";
    state.push.mockReset();
    state.replace.mockReset();
    state.refresh.mockReset();
    state.selectBusiness.mockReset();
    state.instrumentation.mockReset();
    state.fetch.mockReset();
    vi.stubGlobal("fetch", state.fetch);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens exactly one palette from the canonical topbar button", () => {
    render(<PaletteHarness />);

    const launcher = screen.getByRole("button", { name: "Jump or act" });
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(launcher);

    expect(screen.getAllByRole("dialog", { name: "Jump or act" })).toHaveLength(
      1,
    );
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    expect(
      within(screen.getByRole("dialog", { name: "Jump or act" })).getByRole(
        "combobox",
        {
          name: "Search navigation, businesses and entities",
        },
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ["/app/google/overview", "/app/home"],
    ["/c/biz_1/meta/decisions", "/c/biz_1/home"],
  ])(
    "keeps command navigation in the current route family from %s",
    (pathname, expectedHref) => {
      state.pathname = pathname;
      state.plan = "scale";
      render(<CommandPalette open onOpenChange={vi.fn()} />);

      fireEvent.click(screen.getByRole("option", { name: /Overview/ }));

      expect(state.push).toHaveBeenCalledWith(expectedHref);
    },
  );

  it.each([
    ["/app/home", "/app/manage/plan"],
    ["/c/biz_1/home", "/c/biz_1/manage/plan"],
  ])(
    "sends starter-plan Reports, Commercial Truth and Team from %s to its plan gate",
    (pathname, planGateHref) => {
      state.pathname = pathname;
      state.plan = "starter";
      render(<CommandPalette open onOpenChange={vi.fn()} />);

      for (const label of ["Reports", "Commercial Truth", "Team"]) {
        fireEvent.click(
          screen.getByRole("option", { name: new RegExp(label) }),
        );
      }

      expect(state.push.mock.calls).toEqual([
        [planGateHref],
        [planGateHref],
        [planGateHref],
      ]);
    },
  );

  it("matches the rail demo exemption instead of sending Commercial Truth to the plan gate", () => {
    state.pathname = "/app/home";
    state.plan = "starter";
    state.selectedBusinessId = "demo";
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("option", { name: /Commercial Truth/ }));

    expect(state.push).toHaveBeenCalledWith("/app/manage/business");
  });

  it("switches /c/biz_1 routes to the same path under /c/biz_2", async () => {
    state.pathname = "/c/biz_1/meta/decisions";
    state.plan = "scale";
    state.fetch.mockResolvedValue({ ok: true });
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("option", { name: /TheSwaf/ }));

    await waitFor(() => {
      expect(state.replace).toHaveBeenCalledWith("/c/biz_2/meta/decisions");
    });
    expect(state.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      state.replace.mock.invocationCallOrder[0]!,
    );
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("leaves the /c/biz_1 store scope unchanged when business switching fails", async () => {
    state.pathname = "/c/biz_1/meta/decisions";
    state.plan = "scale";
    state.fetch.mockResolvedValue({ ok: false });
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("option", { name: /TheSwaf/ }));

    await waitFor(() => {
      expect(state.fetch).toHaveBeenCalledWith(
        "/api/auth/switch-business",
        expect.anything(),
      );
    });
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["/app/home", "/app/meta/decisions", true],
    ["/c/biz_1/meta/decisions", "/c/biz_2/meta/decisions", false],
  ])(
    "switches to an entity's business before routing its legacy href from %s",
    async (pathname, expectedPathname, optimistic) => {
      const legacyHref =
        "/platforms/meta?businessId=biz_2&providerAccountId=act_2&entityId=cmp_2&entityType=campaign";
      state.pathname = pathname;
      state.plan = "scale";
      state.fetch.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("/api/search?")) {
          return {
            ok: true,
            json: async () => ({
              results: [
                {
                  entityType: "campaign",
                  entityId: "cmp_2",
                  name: "Cross-business campaign",
                  businessId: "biz_2",
                  matchKind: "prefix",
                  score: 2,
                  href: legacyHref,
                },
              ],
            }),
          };
        }
        return { ok: true };
      });
      render(<CommandPalette open onOpenChange={vi.fn()} />);

      fireEvent.change(
        screen.getByRole("combobox", {
          name: "Search navigation, businesses and entities",
        }),
        { target: { value: "Cross-business" } },
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 210));
      });
      fireEvent.click(
        await screen.findByRole("option", {
          name: /Cross-business campaign/,
        }),
      );

      await waitFor(() => {
        expect(state.push).toHaveBeenCalledWith(
          `${expectedPathname}?businessId=biz_2&providerAccountId=act_2&entityId=cmp_2&entityType=campaign`,
        );
      });
      expect(state.fetch).toHaveBeenNthCalledWith(
        2,
        "/api/auth/switch-business",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId: "biz_2" }),
        },
      );
      if (optimistic) {
        expect(state.selectBusiness).toHaveBeenCalledWith("biz_2");
        expect(state.selectBusiness.mock.invocationCallOrder[0]).toBeLessThan(
          state.fetch.mock.invocationCallOrder[1]!,
        );
      } else {
        expect(state.selectBusiness).not.toHaveBeenCalled();
      }
      expect(state.fetch.mock.invocationCallOrder[1]).toBeLessThan(
        state.push.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("adapts a same-business legacy entity href to /c without a session switch", async () => {
    state.pathname = "/c/biz_1/meta/decisions";
    state.plan = "scale";
    state.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            entityType: "campaign",
            entityId: "cmp_1",
            name: "Same-business campaign",
            businessId: "biz_1",
            matchKind: "prefix",
            score: 2,
            href: "/platforms/meta?businessId=biz_1&providerAccountId=act_1",
          },
        ],
      }),
    });
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Search navigation, businesses and entities",
      }),
      { target: { value: "Same-business" } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 210));
    });
    fireEvent.click(
      await screen.findByRole("option", { name: /Same-business campaign/ }),
    );

    expect(state.push).toHaveBeenCalledWith(
      "/c/biz_1/meta/decisions?businessId=biz_1&providerAccountId=act_1",
    );
    expect(state.fetch).not.toHaveBeenCalledWith(
      "/api/auth/switch-business",
      expect.anything(),
    );
  });

  it("returns server-backed entity results inside that same palette", async () => {
    state.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            entityType: "campaign",
            entityId: "cmp_1",
            name: "Aurora Prospecting",
            businessId: "biz_1",
            businessName: "Grandmix",
            status: "ACTIVE",
            matchKind: "prefix",
            score: 2,
            href: "/platforms/meta?businessId=biz_1&entityId=cmp_1&entityType=campaign",
          },
        ],
      }),
    });
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Search navigation, businesses and entities",
      }),
      { target: { value: "Aurora" } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 210));
    });

    const result = await screen.findByRole("option", {
      name: /Aurora Prospecting/,
    });
    expect(result).toHaveTextContent("Campaign");
    expect(result).toHaveTextContent("Grandmix · ACTIVE · name starts with");
    expect(state.fetch).toHaveBeenCalledWith("/api/search?q=Aurora", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    fireEvent.click(result);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(state.push).toHaveBeenCalledWith(
        "/platforms/meta?businessId=biz_1&entityId=cmp_1&entityType=campaign",
      );
    });
    expect(state.instrumentation).toHaveBeenCalledWith({
      eventName: "search_result_opened",
      surface: "global_search",
      outcome: "ok",
      scope: "business",
      businessId: "biz_1",
    });
  });

  it("keeps already-scoped and absolute internal entity hrefs byte-for-byte", async () => {
    const scopedHref =
      "/c/biz_1/meta/decisions?providerAccountId=act_1&entityId=cmp_2";
    const absoluteInternalHref =
      "https://adsecute.com/app/reports/report_7?download=0";
    state.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            entityType: "campaign",
            entityId: "cmp_2",
            name: "Scoped campaign",
            businessId: "biz_1",
            matchKind: "prefix",
            score: 2,
            href: scopedHref,
          },
          {
            entityType: "report",
            entityId: "report_7",
            name: "Scoped absolute report",
            businessId: "biz_1",
            matchKind: "prefix",
            score: 2,
            href: absoluteInternalHref,
          },
        ],
      }),
    });
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Search navigation, businesses and entities",
      }),
      { target: { value: "Scoped" } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 210));
    });

    fireEvent.click(
      await screen.findByRole("option", { name: /Scoped campaign/ }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /Scoped absolute report/ }),
    );

    expect(state.push.mock.calls).toEqual([
      [scopedHref],
      [absoluteInternalHref],
    ]);
  });
});
