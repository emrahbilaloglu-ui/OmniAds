// @vitest-environment jsdom

/**
 * Home rendering rules.
 *
 * The card is not allowed to invent meaning: it renders what the contract
 * decided. These assert the three things the legacy card got wrong — a zero
 * where there was no comparison, a colour taken from the arrow, and a chart
 * with no readable alternative — plus the refresh behaviour that must not
 * throw away known-good numbers.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MetricCard } from "@/components/zero-base/home/metric-card";
import { Sparkline } from "@/components/zero-base/home/sparkline";
import { HomeView } from "@/components/zero-base/home/home-view";
import { BannerStack, SourceHealthPanel } from "@/components/zero-base/home/source-health";
import {
  buildBannerStack,
  toHomeMetric,
  type HomeContract,
  type HomeMetric,
  type HomeSourceState,
} from "@/lib/zero-base/home/metric-contract";
import type { OverviewMetricCardData } from "@/src/types/models";

afterEach(cleanup);

function metric(metricKey: string, overrides: Partial<OverviewMetricCardData> = {}): HomeMetric {
  const card: OverviewMetricCardData = {
    id: metricKey,
    title: metricKey,
    value: 1000,
    previousValue: 800,
    changePct: 25,
    sparklineData: [],
    trendDirection: "up",
    dataSource: { key: "shopify_ledger", label: "Shopify ledger" },
    status: "available",
    unit: "currency",
    ...overrides,
  };
  return toHomeMetric({
    metricKey,
    card,
    mode: "previous_period",
    currency: "USD",
    currencyProof: "configured-only",
  });
}

describe("MetricCard", () => {
  it("renders no percentage at all when there is no comparison", () => {
    render(<MetricCard metric={metric("revenue", { previousValue: null, changePct: null })} />);
    const comparison = document.querySelector('[data-comparison="unavailable"]')!;
    expect(comparison).toHaveTextContent("No comparable earlier window");
    // The specific failure: "0.0%" where the truth is "we do not know".
    expect(comparison.textContent).not.toMatch(/0\.0\s*%/);
    expect(document.querySelector('[data-comparison="available"]')).toBeNull();
  });

  it("renders an em dash, not 0, for a missing value", () => {
    render(<MetricCard metric={metric("revenue", { status: "unavailable", value: null })} />);
    expect(screen.getByText("—")).toBeVisible();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("takes the arrow from direction and the colour from meaning", () => {
    cleanup();
    render(<MetricCard metric={metric("cpa", { value: 50, previousValue: 40, changePct: 25 })} />);
    const comparison = document.querySelector('[data-comparison="available"]')!;
    // Up arrow, negative colour — the pair the legacy card could not express.
    expect(comparison.textContent).toContain("▲");
    expect(comparison.getAttribute("data-sentiment")).toBe("negative");
  });

  it("keeps spend neutral whichever way it moved", () => {
    for (const changePct of [25, -25]) {
      cleanup();
      render(
        <MetricCard metric={metric("spend", { value: 500, previousValue: 400, changePct })} />,
      );
      expect(document.querySelector('[data-comparison="available"]')?.getAttribute("data-sentiment")).toBe(
        "neutral",
      );
    }
  });

  it("says whether the currency was observed or only configured", () => {
    render(<MetricCard metric={metric("revenue")} />);
    expect(screen.getByText(/configured — not observed/)).toBeVisible();
  });

  it("prints no currency symbol when the currency is unknown", () => {
    const unknown = toHomeMetric({
      metricKey: "revenue",
      card: {
        id: "revenue",
        title: "Revenue",
        value: 1000,
        changePct: null,
        sparklineData: [],
        trendDirection: "neutral",
        dataSource: { key: "x", label: "X" },
        status: "available",
        unit: "currency",
      },
      mode: "none",
      currency: null,
      currencyProof: "unknown",
    });
    render(<MetricCard metric={unknown} />);
    const value = document.querySelector("[data-metric-value]")!;
    // "$1,000" would be a claim about which money this is.
    expect(value.textContent).not.toContain("$");
    expect(screen.getByText("Currency unknown")).toBeVisible();
  });

  it("states the reason on a partial metric", () => {
    render(<MetricCard metric={metric("revenue", { status: "partial", helperText: "GA4 incomplete." })} />);
    expect(screen.getByText("GA4 incomplete.")).toBeVisible();
  });
});

describe("Sparkline has a real alternative", () => {
  const points = [
    { date: "2026-08-01", value: 10 },
    { date: "2026-08-02", value: null },
    { date: "2026-08-03", value: 30 },
  ];

  it("labels the chart with a summary a screen reader can use", () => {
    render(<Sparkline title="Revenue" points={points} unit="currency" />);
    const chart = screen.getByRole("img");
    const label = chart.getAttribute("aria-label") ?? "";
    expect(label).toContain("Revenue");
    expect(label).toContain("2026-08-01");
    expect(label).toContain("low");
    expect(label).toContain("high");
  });

  it("exposes the same numbers as a table", async () => {
    const user = userEvent.setup();
    render(<Sparkline title="Revenue" points={points} unit="count" />);
    const toggle = screen.getByRole("button", { name: "Show values" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    const table = screen.getByRole("table");
    const cells = within(table).getAllByRole("cell");
    // 10, gap, 30 — the plotted points, from the same array.
    expect(cells.map((cell) => cell.textContent)).toEqual(["10", "—", "30"]);
  });

  it("shows the exact date and value on hover and focus", async () => {
    const user = userEvent.setup();
    render(<Sparkline title="Revenue" points={points} unit="currency" currency="USD" />);

    const point = screen.getByRole("button", { name: "Revenue, 2026-08-03: USD 30" });
    await user.hover(point);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Aug 03, 2026");
    expect(screen.getByRole("tooltip")).toHaveTextContent("USD 30");
    await user.unhover(point);
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.click(point);
    expect(screen.getByRole("tooltip")).toBeVisible();
  });

  it("breaks the line at a gap instead of dropping to zero", () => {
    const { container } = render(<Sparkline title="Revenue" points={points} unit="count" />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
  });

  it("says so when there is nothing to plot", () => {
    render(<Sparkline title="Revenue" points={[]} unit="count" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("no values");
  });
});

describe("banner stack and source health", () => {
  const sources: HomeSourceState[] = [
    { key: "meta", label: "Meta", state: "unavailable", reason: "Token expired.", freshness: "unknown", lastUpdatedAt: null },
    { key: "ga4", label: "GA4", state: "partial", reason: "Window incomplete.", freshness: "stale", lastUpdatedAt: "2026-08-01" },
  ];

  it("renders hard and partial banners together", () => {
    render(<BannerStack banners={buildBannerStack(sources)} />);
    expect(document.querySelector('[data-banner="hard"]')).not.toBeNull();
    expect(document.querySelector('[data-banner="partial"]')).not.toBeNull();
  });

  it("pairs each banner's colour with a word", () => {
    render(<BannerStack banners={buildBannerStack(sources)} />);
    expect(screen.getByText("Unavailable:")).toBeVisible();
    expect(screen.getByText("Incomplete:")).toBeVisible();
  });

  it("lists each source with its state and freshness", () => {
    render(<SourceHealthPanel sources={sources} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Token expired.")).toBeVisible();
    expect(within(table).getByText("Not recorded")).toBeVisible();
    expect(within(table).getAllByText("unknown").length).toBeGreaterThan(0);
  });
});

describe("HomeView refresh keeps the last truthful content", () => {
  const contract: HomeContract = {
    metrics: [metric("revenue"), metric("spend", { id: "spend", unit: "currency" })],
    sources: [
      { key: "shopify", label: "Shopify", state: "ok", reason: null, freshness: "fresh", lastUpdatedAt: "2026-08-11" },
    ],
    window: { startDate: "2026-08-01", endDate: "2026-08-11" },
    comparisonMode: "previous_period",
  };

  it("keeps the figures visible while refreshing", () => {
    render(<HomeView contract={contract} scopeLine="Grandmix" refreshState="refreshing" />);
    // Blanking to skeletons replaces known-good numbers with nothing.
    expect(document.querySelectorAll("[data-metric-card]")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("the last ones we served");
  });

  it("keeps them visible and says so when a refresh fails", () => {
    render(<HomeView contract={contract} scopeLine="Grandmix" refreshState="failed" />);
    expect(document.querySelectorAll("[data-metric-card]")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Refresh failed");
    expect(screen.getByRole("status")).toHaveTextContent("unchanged");
  });

  it("shows no refresh notice when idle", () => {
    render(<HomeView contract={contract} scopeLine="Grandmix" />);
    expect(document.querySelector("[data-refresh-notice]")).toBeNull();
  });

  it("states the scope and window", () => {
    render(<HomeView contract={contract} scopeLine="Grandmix" />);
    expect(document.querySelector("[data-scope-line]")).toHaveTextContent(
      "Grandmix · 2026-08-01 to 2026-08-11",
    );
  });

  it("does not disable refresh into a dead control", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<HomeView contract={contract} scopeLine="G" onRefresh={onRefresh} />);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalled();
  });
});
