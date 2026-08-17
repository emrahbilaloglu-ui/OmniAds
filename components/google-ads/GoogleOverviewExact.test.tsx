// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { GoogleOverviewExact } from "@/components/google-ads/GoogleOverviewExact";
import type {
  GoogleOverviewChartValueKind,
  GoogleOverviewExactModel,
} from "@/components/google-ads/google-overview-exact-model";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function chart(
  id: string,
  valueKind: GoogleOverviewChartValueKind = "integer",
) {
  return {
    id,
    valueKind,
    points: [
      { date: "2026-07-18", current: 100, previous: 80 },
      { date: "2026-07-19", current: 200, previous: 150 },
    ],
  };
}

function model(): GoogleOverviewExactModel {
  return {
    identity: {
      businessId: "business-1",
      providerAccountId: "493-118-2201",
      currencyCode: "USD",
      windowLabel: "28d",
      windowDays: 28,
    },
    freshness: { label: "Synced 26m ago", state: "fresh" },
    hero: [
      {
        key: "spend",
        label: "Spend · 28d",
        value: "$41,220",
        delta: "+6.4% vs prev",
        deltaTone: "positive",
        detail: "$1,472/day avg",
        chart: chart("spend", "currency-0"),
      },
      {
        key: "conversion-value",
        label: "Conv value",
        value: "$156,480",
        delta: "+9.8%",
        deltaTone: "positive",
        detail: "AOV $78.95",
        chart: chart("revenue", "currency-0"),
      },
      {
        key: "roas",
        label: "ROAS",
        value: "3.80",
        delta: "on target · 3.80",
        deltaTone: "neutral",
        detail: "breakeven 2.50",
        chart: chart("roas", "decimal-2"),
      },
      {
        key: "conversions",
        label: "Conversions",
        value: "1,982",
        delta: "+7.9%",
        deltaTone: "positive",
        detail: "CPA $20.80",
        chart: chart("conversions"),
      },
    ],
    secondary: [
      { key: "cpa", label: "CPA", value: "$20.80", chart: chart("cpa", "currency-2") },
      { key: "cpc", label: "CPC", value: "$1.42", chart: chart("cpc", "currency-2") },
      { key: "ctr", label: "CTR", value: "4.6%", chart: chart("ctr", "percent-1") },
      {
        key: "conversion-rate",
        label: "Conv rate",
        value: "6.8%",
        chart: chart("conversion-rate", "percent-1"),
      },
      {
        key: "impressions",
        label: "Impressions",
        value: "632k",
        chart: chart("impressions", "compact"),
      },
      { key: "clicks", label: "Clicks", value: "29.1k", chart: chart("clicks") },
    ],
    lookCards: [
      {
        id: "critical",
        severity: "Critical",
        tone: "critical",
        title: "Feed issue blocks a listing group",
        description: "The native advisor surfaced a product blocker.",
        evidence: "Google-served product status",
        actionLabel: "Open Products",
        target: "products",
      },
      {
        id: "waste",
        severity: "Waste",
        tone: "waste",
        title: "Search waste is verified",
        description: "The native advisor supplied the evidence.",
        evidence: "30+ clicks · conv = 0",
        actionLabel: "Open Search",
        target: "search",
      },
      {
        id: "opportunity",
        severity: "Opportunity",
        tone: "opportunity",
        title: "A bounded budget preview is ready",
        description: "Review it in Advisor.",
        evidence: "native action contract",
        actionLabel: "See Advisor",
        target: "advisor",
      },
      {
        id: "unsupported",
        severity: "—",
        tone: "neutral",
        title: "—",
        description: "—",
        evidence: "—",
        actionLabel: "—",
        target: null,
      },
    ],
    campaigns: [
      {
        id: "pmax",
        name: "PMax — Evergreen",
        type: "Performance Max",
        typeTone: "info",
        dailyBudget: "$700/day",
        spend: "$18,940",
        spendShare: "46%",
        spendShareWidth: 46,
        revenue: "$71,180",
        roas: "3.76",
        roasTone: "neutral",
        conversions: "902",
        impressionShare: "—",
        lostImpressionShareBudget: "—",
        lostImpressionShareTone: "neutral",
        pulse: "—",
        pulseTone: "neutral",
      },
    ],
    campaignSummary: "1 active · vs target 3.80 · impression-share signals are Google-served",
    budgetNote: "—",
    budgetKpis: [
      { key: "ready", label: "Ready to scale", value: "1", detail: "Search — Brand" },
      { key: "limited", label: "Budget-limited", value: "2", detail: "losing IS to budget" },
      {
        key: "low-efficiency",
        label: "Low-efficiency spend",
        value: "$5,000",
        detail: "Shopping — Core feed",
      },
      { key: "shift", label: "Suggested net shift", value: "$200/day", detail: "moved, not added" },
    ],
    budgetRecommendations: [
      {
        id: "brand",
        campaign: "Search — Brand",
        amount: "+$120/day",
        direction: "increase",
        reason: "Native bounded preview.",
      },
      {
        id: "non-brand",
        campaign: "Search — Non-brand",
        amount: "+$80/day",
        direction: "increase",
        reason: "Native bounded preview.",
      },
      {
        id: "shopping",
        campaign: "Shopping — Core feed",
        amount: "−$200/day",
        direction: "decrease",
        reason: "Native bounded preview.",
      },
    ],
  };
}

describe("GoogleOverviewExact", () => {
  it("renders the exact section order, counts, ten campaign columns, and no legacy chrome", () => {
    render(<GoogleOverviewExact model={model()} />);
    const desktop = document.querySelector('[data-layout="desktop"]');
    expect(desktop).not.toBeNull();
    const view = within(desktop as HTMLElement);

    expect(
      view.getAllByTestId("google-overview-hero-card").map((card) =>
        card.querySelector("p")?.textContent,
      ),
    ).toEqual(["Spend · 28d", "Conv value", "ROAS", "Conversions"]);
    expect(
      view.getAllByTestId("google-overview-secondary-metric").map((metric) =>
        metric.querySelector("p")?.textContent,
      ),
    ).toEqual(["CPA", "CPC", "CTR", "Conv rate", "Impressions", "Clicks"]);
    expect(view.getAllByTestId("google-overview-look-card")).toHaveLength(4);
    expect(view.getAllByTestId("google-overview-budget-kpi")).toHaveLength(4);
    expect(view.getAllByTestId("google-overview-budget-recommendation")).toHaveLength(3);
    expect(within(view.getByTestId("google-overview-budget")).getByText("—")).toBeInTheDocument();
    expect(within(view.getByTestId("google-overview-campaigns")).getAllByRole("columnheader"))
      .toHaveLength(10);
    expect(view.queryByText("Decision Snapshot")).not.toBeInTheDocument();
    expect(view.queryByText("Reconnect Google Ads")).not.toBeInTheDocument();
    expect(view.queryByText("Diagnostics")).not.toBeInTheDocument();
  });

  it("renders the served 46% share as a 46% bar", () => {
    render(<GoogleOverviewExact model={model()} />);
    const desktop = document.querySelector('[data-layout="desktop"]') as HTMLElement;
    const view = within(desktop);
    expect(view.getByText("46%")).toBeInTheDocument();
    const fill = view.getByTestId("google-overview-share-fill");

    expect(fill).toHaveStyle({ width: "46.0%" });
  });

  it("uses route callbacks only and leaves the mobile composition button-free", () => {
    const onNavigate = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<GoogleOverviewExact model={model()} onNavigate={onNavigate} />);

    const desktop = document.querySelector('[data-layout="desktop"]') as HTMLElement;
    fireEvent.click(within(desktop).getByRole("button", { name: "See Advisor →" }));
    expect(onNavigate).toHaveBeenCalledWith("advisor");
    expect(fetchSpy).not.toHaveBeenCalled();

    const mobile = document.querySelector('[data-layout="mobile-read-only"]') as HTMLElement;
    expect(within(mobile).queryAllByRole("button")).toHaveLength(0);
    expect(mobile.querySelector("form")).toBeNull();
    expect(within(mobile).getByText("Read-only")).toBeInTheDocument();
  });

  it("renders current, previous, average, extrema and deterministic hover detail", () => {
    render(<GoogleOverviewExact model={model()} />);
    const chartElement = screen.getByTestId("overview-chart-spend");
    vi.spyOn(chartElement, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 56,
      top: 0,
      right: 200,
      bottom: 56,
      left: 0,
      toJSON: () => ({}),
    });

    expect(within(chartElement).getByTestId("overview-chart-current")).toBeInTheDocument();
    expect(within(chartElement).getByTestId("overview-chart-previous")).toBeInTheDocument();
    expect(within(chartElement).getByTestId("overview-chart-average")).toBeInTheDocument();
    expect(within(chartElement).getByTestId("overview-chart-minimum")).toBeInTheDocument();
    expect(within(chartElement).getByTestId("overview-chart-maximum")).toBeInTheDocument();

    fireEvent.mouseMove(chartElement, { clientX: 200 });
    const tooltip = within(chartElement).getByTestId("overview-chart-tooltip");
    expect(tooltip).toHaveTextContent("Jul 19 · $200");
    expect(tooltip).toHaveTextContent("prev $150 · +33.3%");

    fireEvent.mouseLeave(chartElement);
    expect(within(chartElement).queryByTestId("overview-chart-tooltip")).not.toBeInTheDocument();
  });

  it("keeps the canonical cutoff, typography marker, and final-cell borders", () => {
    const css = readFileSync(
      "components/google-ads/GoogleOverviewExact.module.css",
      "utf8",
    );
    expect(css).toContain("/* dashboard-v2-google-overview-exact-reference-type:start */");
    expect(css).toContain("/* dashboard-v2-google-overview-exact-reference-type:end */");
    expect(css).toContain("@media (max-width: 1023px)");
    expect(css).toMatch(/\.desktopSurface\s*\{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/\.mobileSurface\s*\{[\s\S]*?display:\s*flex;/);
    expect(css).toMatch(/\.secondaryMetric\s*\{[\s\S]*?border-right:\s*1px solid #f3f5f9;/);
    expect(css).toMatch(/\.budgetKpi\s*\{[\s\S]*?border-right:\s*1px solid #f3f5f9;/);
    expect(css).not.toMatch(/\.secondaryMetric:last-child\s*\{[\s\S]*?border-right:\s*0;/);
    expect(css).not.toMatch(/\.budgetKpi:last-child\s*\{[\s\S]*?border-right:\s*0;/);
  });
});
