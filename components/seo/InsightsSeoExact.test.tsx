// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsSeoExact } from "./InsightsSeoExact";
import {
  buildInsightsSeoExactModel,
  type InsightsSeoAdapterInput,
} from "./insights-seo-exact-adapter";
import type { SeoTabId } from "./insights-seo-exact-model";

const OVERVIEW: InsightsSeoAdapterInput["overview"] = {
  summary: {
    clicks: { current: 48_240, previous: 44_200, deltaPercent: 0.0914 },
    impressions: { current: 1_940_000, previous: 1_730_000, deltaPercent: 0.1214 },
    ctr: { current: 0.0248, previous: 0.0255, deltaPercent: -0.0275 },
    position: { current: 8.4, previous: 9.5, deltaPercent: -0.116 },
  },
  leaders: {
    queries: [
      {
        key: "q1",
        label: "canvas tote bag",
        clicks: 6_210,
        impressions: 214_000,
        ctr: 0.029,
        position: 4.2,
        positionDelta: -0.8,
      },
    ],
    pages: [
      {
        key: "p1",
        label: "/products/aurora-tote",
        clicks: 8_940,
        impressions: 214_000,
        ctr: 0.042,
        position: 3.8,
      },
    ],
  },
  movers: {
    decliningQueries: [{ key: "m1", label: "travel kit", clicks: 1_980, clicksDelta: -214 }],
    decliningPages: [],
    improvingQueries: [],
    improvingPages: [],
  },
};

const MONTHLY: InsightsSeoAdapterInput["monthly"] = {
  monthKey: "2026-08",
  monthLabel: "August 2026",
  generatedAt: "2026-08-03T09:20:00.000Z",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  status: "available",
  overviewData: { dataLayers: [{ title: "Search KPIs" }, { title: "Landing pages" }] },
  analysis: {
    summary: "Organic growth is intact but concentrated.",
    rootCauses: [{ title: "Template titles", detail: "CTR capped at 1.9%." }],
    priorities: [
      {
        title: "Fix canonical",
        detail: "5 PDPs excluded.",
        impact: "medium",
        effort: "low",
        owner: "Developer",
      },
      {
        title: "Internal links from the two top guides to money pages",
        detail: "Guides earn links but pass no authority on.",
        impact: "high",
        effort: "low",
        owner: "SEO",
      },
    ],
    actionPlan: [{ window: "week 1", focus: "Indexation", tasks: ["Fix noindex on 5 PDPs"] }],
    structured: { executiveSummary: { topFindings: ["Top 5 queries carry 61% of clicks."] } },
  },
};

const FINDINGS: InsightsSeoAdapterInput["findings"] = {
  meta: { auditedPageCount: 148, urlInspection: { attempted: 5, succeeded: 5 } },
  summary: { critical: 1, warning: 3, opportunity: 0, passed: 144 },
  confirmedExcludedPages: [
    { path: "/products/a", coverageState: "Excluded by ‘noindex’ tag" },
  ],
  findings: [
    {
      id: "f1",
      severity: "critical",
      title: "12 product URLs went noindex",
      description: "5 remain excluded.",
      affectedPages: [{ path: "/products/a" }],
    },
    {
      id: "f2",
      severity: "passed",
      title: "Pages cleared every technical check that ran",
      description: "Checks that ran on these pages: title tag, H1 heading.",
      affectedPages: [{ path: "/products/b" }],
    },
  ],
};

function renderTab(activeTab: SeoTabId, overrides: Partial<InsightsSeoAdapterInput> = {}) {
  const onSelectTab = vi.fn();
  const onGenerateMonthly = vi.fn();
  const model = buildInsightsSeoExactModel({
    activeTab,
    overview: OVERVIEW,
    monthly: MONTHLY,
    findings: FINDINGS,
    ...overrides,
  });
  const utils = render(
    <InsightsSeoExact
      model={model}
      onSelectTab={onSelectTab}
      onGenerateMonthly={onGenerateMonthly}
    />,
  );
  return { ...utils, onSelectTab, onGenerateMonthly };
}

function headers(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll("thead th")).map((cell) => cell.textContent ?? "");
}

afterEach(cleanup);

describe("InsightsSeoExact — chrome", () => {
  it("has no page header of its own and no wrapping card", () => {
    const { container } = renderTab("traffic");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const root = container.firstElementChild as HTMLElement;
    // KPI grid first, then the sub-tab strip; the tab body is a direct sibling.
    expect(root.children[1]?.getAttribute("role")).toBe("tablist");
  });

  it("names and orders the six sub-tabs exactly as the design does", () => {
    const { onSelectTab } = renderTab("ai");
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Monthly AI",
      "Traffic changes",
      "Queries",
      "Pages",
      "Actions",
      "Technical findings",
    ]);
    fireEvent.click(tabs[5]!);
    expect(onSelectTab).toHaveBeenCalledWith("technical");
  });

  it("keeps the KPI band above the strip on every sub-tab", () => {
    renderTab("technical");
    expect(screen.getByText("Organic clicks")).toBeTruthy();
    expect(screen.getByText("prev 44.2K")).toBeTruthy();
    expect(screen.getByText("↑ 1.1 better")).toBeTruthy();
  });
});

describe("InsightsSeoExact — Monthly AI", () => {
  it("renders the reads chips and the What changed / Likely causes / 30-day plan grid", () => {
    renderTab("ai");
    expect(screen.getByText("Monthly AI analysis — August 2026")).toBeTruthy();
    expect(screen.getByText("available")).toBeTruthy();
    expect(screen.getByText("reads")).toBeTruthy();
    expect(screen.getByText("Search KPIs")).toBeTruthy();
    expect(screen.getByText("What changed")).toBeTruthy();
    expect(screen.getByText("Likely causes")).toBeTruthy();
    expect(screen.getByText("30-day plan")).toBeTruthy();
    expect(screen.getByText("01")).toBeTruthy();
    expect(screen.getByText("One analysis per month · next window Sep 1")).toBeTruthy();
  });

  it("draws no generate button in the state the design draws", () => {
    // An analysis exists, so the head is the design's inert cadence chip and
    // the only buttons on screen are the six sub-tabs.
    const { container } = renderTab("ai");
    expect(container.querySelectorAll("button[type='button']").length).toBe(
      within(screen.getByRole("tablist")).getAllByRole("tab").length,
    );
  });

  it("offers the generator in the pre-generation state the design never draws", () => {
    const { onGenerateMonthly } = renderTab("ai", {
      monthly: { ...MONTHLY, status: "not_generated", canGenerate: true, analysis: null },
    });
    // The cadence chip's slot carries the control instead; nothing else moves.
    expect(screen.queryByText("One analysis per month · next window Sep 1")).toBeNull();
    const generate = screen.getByRole("button", { name: "Generate this month’s analysis" });
    fireEvent.click(generate);
    expect(onGenerateMonthly).toHaveBeenCalledTimes(1);
  });

  it("keeps the design's chip when the server refuses a run", () => {
    renderTab("ai", {
      monthly: { ...MONTHLY, status: "not_generated", canGenerate: false, analysis: null },
    });
    expect(screen.getByText("One analysis per month · next window Sep 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /analysis$/ })).toBeNull();
  });
});

describe("InsightsSeoExact — tables", () => {
  it("gives Query leaders the design's six columns ending in Δ pos", () => {
    renderTab("queries");
    expect(headers(screen.getByRole("table"))).toEqual([
      "Query",
      "Clicks",
      "Impressions",
      "CTR",
      "Position",
      "Δ pos",
    ]);
    expect(screen.getByText("+0.8")).toBeTruthy();
  });

  it("gives Page leaders the design's five columns and no click-delta", () => {
    renderTab("pages");
    expect(headers(screen.getByRole("table"))).toEqual([
      "Page",
      "Clicks",
      "Impressions",
      "CTR",
      "Position",
    ]);
  });

  it("renders Traffic changes as four compact mover cards, not tables", () => {
    const { container } = renderTab("traffic");
    expect(container.querySelectorAll("table").length).toBe(0);
    expect(screen.getByText("Biggest declining queries")).toBeTruthy();
    expect(screen.getByText("Improving pages")).toBeTruthy();
    expect(screen.getAllByText("clicks · 28d vs prev").length).toBe(4);
  });
});

describe("InsightsSeoExact — Actions", () => {
  it("renders tone groups, not an impact/effort matrix or a timeline", () => {
    const { container } = renderTab("actions");
    expect(screen.getByText("Quick wins")).toBeTruthy();
    expect(screen.getByText("medium impact")).toBeTruthy();
    expect(screen.getByText("· low effort · Developer")).toBeTruthy();
    // The design's own low-effort Strategic item stays in Strategic.
    const strategic = screen.getByText("Strategic").closest("article") as HTMLElement;
    expect(strategic.textContent).toContain(
      "Internal links from the two top guides to money pages",
    );
    expect(container.querySelectorAll("table").length).toBe(0);
    expect(
      screen.getByText(
        "Sequenced from the monthly model output — what to fix first, what to schedule, what to defer.",
      ),
    ).toBeTruthy();
  });
});

describe("InsightsSeoExact — Technical findings", () => {
  it("renders the four stat cards the design names, in order", () => {
    const { container } = renderTab("technical");
    // The first four articles are the always-on KPI band; the tech cards follow.
    const cards = Array.from(container.querySelectorAll("article")).slice(4, 8);
    expect(
      cards.map((card) => [
        card.querySelector("p:first-child")?.textContent,
        card.querySelector("p:last-child")?.textContent,
      ]),
    ).toEqual([
      ["Pages audited", "148"],
      ["Critical", "1"],
      ["Warnings", "3"],
      // The served `summary.passed` — a per-page verdict the builder emits,
      // not 148 minus the flagged paths.
      ["Passed", "144"],
    ]);
  });

  it("captions the passing chip with the design's word", () => {
    const { container } = renderTab("technical");
    const chips = Array.from(container.querySelectorAll("[data-tone]"))
      .filter((node) => node.textContent === "Passed" || node.textContent === "Critical")
      .map((node) => [node.textContent, node.getAttribute("data-tone")]);
    expect(chips).toContainEqual(["Passed", "positive"]);
  });

  it("reduces Confirmed excluded pages to a url + reason list, not a table", () => {
    const { container } = renderTab("technical");
    expect(container.querySelectorAll("table").length).toBe(0);
    expect(screen.getByText("Confirmed excluded pages")).toBeTruthy();
    expect(screen.getByText("URL Inspection · 5 of 5")).toBeTruthy();
    expect(screen.getByText("/products/a")).toBeTruthy();
    expect(screen.getByText("Excluded by ‘noindex’ tag")).toBeTruthy();
  });

  it("draws no recommendation line and no affected-pages list on a finding", () => {
    renderTab("technical");
    expect(screen.getByText("12 product URLs went noindex")).toBeTruthy();
    expect(screen.getByText("5 remain excluded.")).toBeTruthy();
    expect(screen.queryByText(/Recommended fix/i)).toBeNull();
    expect(screen.queryByText(/Affected pages/i)).toBeNull();
  });

  it("still renders every block when the payload arrives partial", () => {
    renderTab("technical", { findings: { findings: [{ id: "f", severity: "warning", title: "t", description: "d" }] } });
    expect(screen.getByText("Pages audited")).toBeTruthy();
    expect(screen.getByText("Confirmed excluded pages")).toBeTruthy();
    expect(screen.getByText("t")).toBeTruthy();
  });
});

describe("InsightsSeoExact — truthfulness", () => {
  it("renders the em-dash, never a design seed, when nothing is served", () => {
    const { container } = renderTab("queries", {
      overview: null,
      monthly: null,
      findings: null,
    });
    expect(container.textContent).not.toContain("48.2K");
    expect(container.textContent).not.toContain("1.94M");
    expect(container.textContent).not.toContain("canvas tote bag");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("draws no icons anywhere — the design's chips are text", () => {
    const { container } = renderTab("technical");
    expect(container.querySelectorAll("svg").length).toBe(0);
  });
});
