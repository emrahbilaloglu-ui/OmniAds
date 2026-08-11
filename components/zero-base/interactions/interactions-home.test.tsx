// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — interaction contracts owned by the Home composition.
 *
 * Both controls here are operated on the real `HomeView`, not on a surrogate.
 * That matters: the point of G7 is that a contract is satisfied by the
 * production owner, so if either control disappears from Home, or stops
 * producing its consequence, these cases fail rather than quietly passing
 * against a stand-in.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  expectNavigates,
  expectOperable,
  flushInteractionResults,
  interactionCase,
} from "@/components/zero-base/interactions/interaction-harness";

import { HomeView } from "@/components/zero-base/home/home-view";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";
import type { HomeContract } from "@/lib/zero-base/home/metric-contract";
import type { EconomicsContextModel } from "@/lib/zero-base/home/economics-context";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/c/biz/home",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

const CONTRACT: HomeContract = {
  metrics: [
    {
      key: "spend",
      title: "Spend",
      unit: "currency",
      availability: "available",
      value: 18420.5,
      reason: null,
      comparison: {
        available: true,
        changePercent: 4.2,
        changeValue: null,
        basisLabel: "vs previous period",
        sentiment: "neutral",
        arrow: "up",
      },
      money: { currency: "USD", proven: true, proof: "proven" },
      sparkline: [],
      source: { key: "meta", label: "Meta Ads" },
    },
  ],
  sources: [
    {
      key: "meta",
      label: "Meta Ads",
      state: "ok",
      reason: null,
      freshness: "fresh",
      lastUpdatedAt: "2026-08-09T06:00:00Z",
    },
  ],
  window: { startDate: "2026-07-13", endDate: "2026-08-09" },
  comparisonMode: "previous_period",
};

const ECONOMICS: EconomicsContextModel = {
  breakEvenRoas: 2.12,
  targetRoas: 2.6,
  diverges: true,
  sources: [
    { key: "target-pack", label: "Commercial Truth target pack", consumers: ["Meta decisions"] },
    { key: "cost-model", label: "cost model", consumers: ["Overview", "Google"] },
  ],
};

/** The trend panel's own table — Home also renders a source-health table. */
const trendTable = () => document.querySelector('[data-trend-panel="home"] table');

const POINTS = [
  { date: "2026-08-08", spend: 540, roas: 2.8 },
  { date: "2026-08-09", spend: null, roas: null },
];

function renderHome() {
  return render(
    <ZeroBaseCopyProvider language="en">
      <HomeView
        contract={CONTRACT}
        scopeLine="Halcyon Supply Co."
        businessId="biz"
        trend={{ points: POINTS, currency: "USD" }}
        economics={ECONOMICS}
      />
    </ZeroBaseCopyProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
afterAll(() => flushInteractionResults("home"));

describe("G7 — Home composition contracts", () => {
  interactionCase("live:chart-table-toggle", async () => {
    const user = userEvent.setup();
    const { unmount } = renderHome();

    const toggle = screen.getByRole("button", { name: /view as table/i });
    expectOperable(toggle, "chart/table toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    // The chart is present and there is no table yet.
    expect(document.querySelector("[data-trend-chart]")).not.toBeNull();
    expect(trendTable()).toBeNull();

    await user.click(toggle);

    // The consequence: real <table> markup, in place, with the figures.
    await waitFor(() => expect(trendTable()).not.toBeNull());
    expect(trendTable()!.querySelectorAll("tbody tr").length).toBe(POINTS.length);
    expect(document.querySelector("[data-trend-chart]")).toBeNull();
    // A day with no spend reads as "No data", never as 0.
    expect(screen.getAllByText("No data").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /view as chart/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Announced, because the content swapped under a user who cannot see it.
    await waitFor(() =>
      expect(document.querySelector('[data-trend-mode="table"]')?.textContent).toBe("table view"),
    );

    // Persisted per surface: a fresh mount of Home comes back as a table.
    unmount();
    renderHome();
    await waitFor(() => expect(trendTable()).not.toBeNull());
    // ...and the preference is scoped to this surface, not applied globally.
    expect(window.localStorage.getItem("zero-base:trend-view:home")).toBe("table");
    expect(window.localStorage.getItem("zero-base:trend-view:decisions")).toBeNull();
  });

  interactionCase("live:ECON-04 divergence-link", async () => {
    renderHome();

    const link = screen.getByRole("link", { name: /see consumers/i });
    expectOperable(link, "economics divergence link");
    // Both sources and their consumers are named on the surface itself, so the
    // number is never shown without saying who reads it.
    const panel = document.querySelector("[data-economics-context]");
    expect(panel?.textContent).toContain("Commercial Truth target pack");
    expect(panel?.textContent).toContain("Meta decisions");
    expect(panel?.textContent).toContain("Overview & Google");
    expect(document.querySelector('[data-econ-break-even="2.12"]')).not.toBeNull();
    expect(document.querySelector('[data-econ-target="2.6"]')).not.toBeNull();

    expectNavigates(link, /^\/c\/biz\/manage\/business#economics$/, "economics divergence link");
  });

  /**
   * Keyboard reachability, asserted honestly.
   *
   * An earlier version of this case called itself a keyboard/pointer parity
   * test and then fired `click` in the "keyboard" path, because jsdom does not
   * synthesise a click from Enter on a native button. That made both paths
   * identical and proved nothing.
   *
   * What actually guarantees Enter and Space activation is that the control is
   * a real `<button>` in the tab order — browser behaviour we inherit rather
   * than implement. So that is what is asserted, and `userEvent.tab()` +
   * `{Enter}` drives it the way a keyboard user would.
   */
  it("the toggle is reachable and operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    renderHome();
    const toggle = screen.getByRole("button", { name: /view as table/i });

    expect(toggle.tagName).toBe("BUTTON");
    // Not removed from the tab order.
    expect(toggle.getAttribute("tabindex")).not.toBe("-1");

    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(trendTable()).not.toBeNull());
  });
});

describe("G7 mutation controls — these must fail if the real controls regress", () => {
  it("the toggle is a real button, not a div with a click handler", () => {
    renderHome();
    const toggle = screen.getByRole("button", { name: /view as table/i });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("data-ctl", "live:chart-table-toggle");
  });

  it("the divergence link is a real link carrying an href, not a button", () => {
    renderHome();
    const link = screen.getByRole("link", { name: /see consumers/i });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBeTruthy();
    expect(link).toHaveAttribute("data-ctl", "live:ECON-04 divergence-link");
  });

  it("Home carries the anatomy the accepted design declares for H03", () => {
    renderHome();
    // If a refactor drops these, G10's reference comparison fails too — this
    // case names the reason so the failure is diagnosable at unit level.
    expect(document.querySelector('[data-el="home-kpis"]')).not.toBeNull();
    expect(document.querySelector('[data-el="source-readiness"]')).not.toBeNull();
    expect(document.querySelector('[data-collection="h03-sources"]')).not.toBeNull();
  });
});
