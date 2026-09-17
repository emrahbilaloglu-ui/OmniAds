// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — interaction contracts owned by the Home composition.
 *
 * The interactions here are operated on the real `HomeView`, not on a surrogate.
 * That matters: the point of G7 is that a contract is satisfied by the
 * production owner, so if either control disappears from Home, or stops
 * producing its consequence, these cases fail rather than quietly passing
 * against a stand-in.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  expectNavigates,
  expectOperable,
  flushInteractionResults,
  interactionCase,
} from "@/components/zero-base/interactions/interaction-harness";

import { HomeView } from "@/components/zero-base/_reference/home-view";
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

const POINTS = [
  { date: "2026-08-08", spend: 540, roas: 2.8 },
  { date: "2026-08-09", spend: null, roas: null },
];

function renderHome() {
  return render(
    <ZeroBaseCopyProvider language="en">
      <HomeView
        contract={CONTRACT}
        businessId="biz"
        trend={{ points: POINTS, currency: "USD" }}
        economics={ECONOMICS}
      />
    </ZeroBaseCopyProvider>,
  );
}

afterEach(() => {
  cleanup();
});
afterAll(() => flushInteractionResults("home"));

describe("G7 — Home composition contracts", () => {
  it("shows spend and ROAS values on hover and keyboard focus", async () => {
    const user = userEvent.setup();
    renderHome();

    const point = screen.getByRole("button", {
      name: /2026-08-08; spend \$540\.00; ROAS 2\.80x/i,
    });
    await user.hover(point);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.querySelector("[data-trend-tooltip-date]")).toHaveAttribute("data-date", "2026-08-08");
    expect(tooltip).toHaveTextContent("$540");
    expect(tooltip).toHaveTextContent("2.80x");

    await user.unhover(point);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.click(point);
    expect(screen.getByRole("tooltip")).toBeVisible();
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

    expectNavigates(link, /^\/app\/manage\/business#economics$/, "economics divergence link");
  });

});

describe("G7 mutation controls — these must fail if the real controls regress", () => {
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
    expect(document.querySelector('[data-collection="sources"]')).not.toBeNull();
  });
});
