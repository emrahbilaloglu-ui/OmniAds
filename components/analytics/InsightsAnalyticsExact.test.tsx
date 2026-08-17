// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsAnalyticsExact } from "./InsightsAnalyticsExact";
import {
  buildInsightsAnalyticsExactModel,
  type InsightsAnalyticsAdapterInput,
} from "./insights-analytics-exact-adapter";
import type { AnalyticsTabId } from "./insights-analytics-exact-model";

const OVERVIEW: InsightsAnalyticsAdapterInput["overview"] = {
  kpis: {
    sessions: 241_800,
    engagedSessions: 158_600,
    engagementRate: 0.656,
    purchases: 4_290,
    purchaseCvr: 0.0177,
    revenue: 326_400,
  },
  previousKpis: {
    sessions: 223_500,
    engagedSessions: 148_400,
    engagementRate: 0.664,
    purchases: 3_850,
    purchaseCvr: 0.0172,
    revenue: 297_300,
  },
  newVsReturning: {
    new: { sessions: 178_400, purchaseCvr: 0.0121, engagementRate: 0.612 },
    returning: { sessions: 63_400, purchaseCvr: 0.0336, engagementRate: 0.781 },
  },
  insights: [{ type: "positive", text: "Returning users convert 2.8× better." }],
};

function renderTab(
  activeTab: AnalyticsTabId,
  overrides: Partial<InsightsAnalyticsAdapterInput> = {},
) {
  const onSelectTab = vi.fn();
  const onSelectDemoDimension = vi.fn();
  const model = buildInsightsAnalyticsExactModel({
    activeTab,
    demoDimension: "country",
    windowDays: 28,
    overview: OVERVIEW,
    ...overrides,
  });
  const utils = render(
    <InsightsAnalyticsExact
      model={model}
      onSelectTab={onSelectTab}
      onSelectDemoDimension={onSelectDemoDimension}
    />,
  );
  return { ...utils, onSelectTab, onSelectDemoDimension };
}

function headers(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll("thead th")).map(
    (cell) => cell.textContent ?? "",
  );
}

afterEach(cleanup);

describe("InsightsAnalyticsExact — chrome", () => {
  it("has no page header of its own and no wrapping card", () => {
    const { container } = renderTab("overview");
    expect(container.querySelectorAll("h2").length).toBe(0);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // The sub-tab strip is the first child; nothing wraps the tab body.
    const root = container.firstElementChild as HTMLElement;
    expect(root.firstElementChild?.getAttribute("role")).toBe("tablist");
  });

  it("names the seven sub-tabs the design names", () => {
    const { onSelectTab } = renderTab("overview");
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Products",
      "Landing pages",
      "Audience",
      "Demographics",
      "Cohorts",
      "Opportunities",
    ]);
    fireEvent.click(tabs[2]!);
    expect(onSelectTab).toHaveBeenCalledWith("landing");
  });
});

describe("InsightsAnalyticsExact — overview", () => {
  it("gives every KPI card a third comparison line", () => {
    renderTab("overview");
    expect(screen.getByText("241.8K")).toBeTruthy();
    expect(screen.getByText("+8.2% vs prev 28d")).toBeTruthy();
    expect(screen.getByText("−0.80 pt")).toBeTruthy();
  });

  it("renders new/returning as a three-up grid with Engagement", () => {
    renderTab("overview");
    // Two segment cards, each a Sessions / Engagement / Purchase CVR triple.
    expect(screen.getAllByText("Engagement").length).toBe(2);
    expect(screen.getByText("61.2%")).toBeTruthy();
    expect(screen.getByText("78.1%")).toBeTruthy();
    expect(screen.getByText("2.8× better CVR")).toBeTruthy();
  });

  it("labels callouts with a text kind chip, not an icon", () => {
    const { container } = renderTab("overview");
    expect(screen.getByText("Positive")).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBe(0);
  });
});

describe("InsightsAnalyticsExact — tables", () => {
  it("gives the product funnel its own card header and footer note", () => {
    renderTab("products", {
      products: [
        {
          name: "Aurora Tote",
          views: 48_210,
          addToCarts: 4_630,
          checkouts: 2_410,
          purchases: 1_552,
          revenue: 118_000,
          atcRate: 0.096,
          checkoutRate: 0.521,
          purchaseRate: 0.032,
        },
      ],
    });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Product funnel");
    expect(
      screen.getByText("view → cart → checkout → purchase · shaded cells run hot"),
    ).toBeTruthy();
    expect(headers(screen.getByRole("table"))).toEqual([
      "Product",
      "Views",
      "Add to cart",
      "Checkout",
      "Purchases",
      "ATC rate",
      "Checkout rate",
      "Purchase rate",
      "Revenue",
    ]);
    expect(
      screen.getByText(/Showing 1 of up to 50 rows · GA4 item-scoped events/),
    ).toBeTruthy();
  });

  it("shades heat cells on the background, not the text", () => {
    const { container } = renderTab("products", {
      products: [
        {
          name: "Aurora Tote",
          views: 48_210,
          atcRate: 0.096,
          checkoutRate: 0.521,
          purchaseRate: 0.032,
        },
      ],
    });
    const shaded = Array.from(container.querySelectorAll<HTMLElement>("td")).filter(
      (cell) => cell.style.background.startsWith("rgba(14, 159, 110"),
    );
    // ATC rate, checkout rate and purchase rate all carry the green wash.
    expect(shaded).toHaveLength(3);
    expect(shaded.every((cell) => cell.style.color === "")).toBe(true);
  });

  it("gives the landing-page table exactly six columns", () => {
    renderTab("landing", {
      landingPages: [
        {
          path: "/collections/new",
          sessions: 22_140,
          engagementRate: 0.71,
          purchases: 642,
          purchaseCvr: 0.029,
        },
      ],
    });
    expect(headers(screen.getByRole("table"))).toEqual([
      "Page",
      "Sessions",
      "Engagement",
      "Purchases",
      "Purchase CVR",
      "Signal",
    ]);
    expect(screen.getByText("Healthy")).toBeTruthy();
    // No "strong"/"weak" badge is injected beside the engagement value.
    expect(screen.queryByText("strong")).toBeNull();
  });

  it("draws static mono headers with no sort control", () => {
    const { container } = renderTab("landing", {
      landingPages: [{ path: "/", sessions: 10, engagementRate: 0.7, purchases: 1 }],
    });
    expect(container.querySelectorAll("thead button").length).toBe(0);
    expect(container.querySelectorAll("thead svg").length).toBe(0);
  });
});

describe("InsightsAnalyticsExact — demographics, cohorts, opportunities", () => {
  it("offers the seven dimension chips and reports the choice", () => {
    const { onSelectDemoDimension } = renderTab("demo", {
      demographics: {
        rows: [
          {
            value: "Germany",
            sessions: 24_180,
            engagementRate: 0.702,
            purchases: 742,
            purchaseCvr: 0.0307,
            revenue: 54_100,
          },
        ],
        summary: {
          topValue: "Germany",
          topValuePurchaseCvr: 0.0307,
          avgPurchaseCvr: 0.0177,
        },
      },
    });
    expect(
      screen.getByText(
        "Country “Germany” has the highest purchase rate at 3.07% (site avg 1.77%).",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Age group"));
    expect(onSelectDemoDimension).toHaveBeenCalledWith("userAgeBracket");
  });

  it("lays the two cohort tables side by side, each with its own card header", () => {
    const { container } = renderTab("cohorts", {
      cohorts: {
        cohortWeeks: [
          {
            week: "202627",
            newSessions: 20_140,
            returningSessions: 6_890,
            newPurchases: 214,
            returningPurchases: 231,
            retentionRate: 0.245,
          },
        ],
        monthlyData: [
          {
            month: "202603",
            newUsers: 48_200,
            activeUsers: 71_400,
            sessions: 198_400,
            purchases: 3_214,
            revenue: 238_100,
            purchaseCvr: 0.0162,
          },
        ],
      },
    });
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(["Weekly new vs returning", "Monthly acquisition summary"]);
    expect(screen.getByText("retention pill = returning share of sessions")).toBeTruthy();
    expect(screen.getByText("do acquired users return and repurchase")).toBeTruthy();
    const grid = container.querySelector("[class*='cohortGrid']");
    expect(grid?.children.length).toBe(2);
    expect(headers(screen.getAllByRole("table")[0]!)).toEqual([
      "Week",
      "New",
      "Returning",
      "Retention",
      "New purch.",
      "Return purch.",
    ]);
    expect(headers(screen.getAllByRole("table")[1]!)).toEqual([
      "Month",
      "New users",
      "Active users",
      "Sessions",
      "Purchases",
      "CVR",
      "Revenue",
    ]);
  });

  it("renders opportunities as a card grid with text kind chips", () => {
    const { container } = renderTab("opps", {
      overview: {
        ...OVERVIEW,
        newVsReturning: {
          new: { sessions: 100, purchaseCvr: 0.01 },
          returning: { sessions: 50, purchaseCvr: 0.03 },
        },
      },
      landingPages: [
        { path: "/tote", sessions: 500, engagementRate: 0.7, purchases: 40, purchaseCvr: 0.08 },
      ],
    });
    expect(screen.getByText("Opportunity")).toBeTruthy();
    expect(screen.getByText("Strong")).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBe(0);
    expect(container.querySelector("[class*='opportunityGrid']")).not.toBeNull();
    expect(
      screen.getByText(/thresholds, not opinions\. Not enough data → no flag\./),
    ).toBeTruthy();
  });
});

describe("InsightsAnalyticsExact — stylesheet", () => {
  const css = readFileSync(
    join(process.cwd(), "components/analytics/InsightsAnalyticsExact.module.css"),
    "utf8",
  );

  it("pins the design's KPI card geometry", () => {
    expect(css).toContain("font-size: 9.5px");
    expect(css).toContain("font-size: 22px");
    expect(css).toMatch(/\.kpiCard\s*{[^}]*border-radius: 14px/);
    expect(css).toMatch(/\.kpiCard\s*{[^}]*padding: 14px 16px/);
  });

  it("fills the table header band and sets it in mono 10px", () => {
    expect(css).toMatch(/\.th\s*{[^}]*background: #f7f9fc/);
    expect(css).toMatch(/\.th\s*{[^}]*font-size: 10px/);
    expect(css).toMatch(/\.th\s*{[^}]*letter-spacing: 0\.1em/);
  });

  it("underlines the active sub-tab in #0b1020 at weight 600", () => {
    expect(css).toMatch(
      /\.tab\[data-active="true"\]\s*{[^}]*border-bottom-color: #0b1020[^}]*font-weight: 600/,
    );
  });

  it("keeps the table footer note inside the card on a #f3f5f9 rule", () => {
    expect(css).toMatch(/\.tableNote\s*{[^}]*border-top: 1px solid #f3f5f9/);
    expect(css).toMatch(/\.tableNote\s*{[^}]*font-size: 11\.5px/);
  });
});
