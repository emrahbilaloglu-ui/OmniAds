// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsGeoExact } from "./InsightsGeoExact";
import {
  buildInsightsGeoExactModel,
  type InsightsGeoAdapterInput,
} from "./insights-geo-exact-adapter";
import type { GeoTabId } from "./insights-geo-exact-model";

const OVERVIEW: InsightsGeoAdapterInput["overview"] = {
  kpis: {
    aiSessions: 3_840,
    aiSessionsDelta: 0.38,
    aiEngagementRate: 0.742,
    aiPurchaseCvr: 0.0294,
    geoScore: 62,
    aiPageCount: 34,
    topAiSource: "ChatGPT",
    topAiSourceSessions: 2_148,
    topAiSourceShare: 0.5594,
    siteAvgEngagementRate: 0.656,
    siteAvgPurchaseCvr: 0.0177,
    aiStyleQueryCount: 41,
    totalQueryCount: 220,
  },
  insights: [{ type: "positive", text: "AI-source visitors convert above the site average." }],
  top3Priorities: [
    {
      title: "Answer-first FAQ on /pages/materials",
      description: "Materials questions drive the top AI-intent queries.",
      priority: "high",
      effort: "Low",
      impact: "+15–25% AI citations",
    },
  ],
  highlights: {
    strongestGeoQuery: { query: "how to clean a canvas tote", geoScore: 78, impressions: 8_140 },
    strongestGeoTopic: { topic: "Tote care", geoScore: 74, impressions: 24_300, coverageStrength: "Strong" },
    highestAiValueSource: { engine: "ChatGPT", label: "elite", score: 82 },
  },
};

const SOURCES: InsightsGeoAdapterInput["sources"] = [
  {
    engine: "ChatGPT",
    sessions: 2_148,
    engagementRate: 0.762,
    purchases: 71,
    revenue: 5_900,
    purchaseCvr: 0.0331,
    aiTrafficValueScore: 82,
    aiTrafficValueLabel: "elite",
    momentum: { status: "rising", growthRate: 0.38 },
    recommendation: "Protect the tote-care guide.",
  },
];

const PAGES: InsightsGeoAdapterInput["pages"] = [
  {
    path: "/blogs/tote-care-guide",
    aiSessions: 1_214,
    engagementRate: 0.81,
    purchaseCvr: 0.021,
    geoScore: 84,
    sourcedBy: ["ChatGPT", "Perplexity"],
  },
];

const QUERIES: InsightsGeoAdapterInput["queries"] = [
  {
    query: "how to clean a canvas tote",
    impressions: 8_140,
    ctr: 0.046,
    position: 2.8,
    isAiStyle: true,
    classification: { intentLabel: "Informational", formatLabel: "How-to" },
    geoScore: 78,
    geoScoreBreakdown: { impressions: 26, positionQuality: 20, ctrGap: 14, intent: 18 },
    momentum: { status: "rising", growthRate: 0.26 },
    priority: "high",
    recommendation: "Add step-list schema to the guide.",
  },
];

const TOPICS: InsightsGeoAdapterInput["topics"] = [
  {
    topic: "Tote care",
    queryCount: 12,
    impressions: 24_300,
    clicks: 1_180,
    avgPosition: 3.4,
    geoScore: 74,
    coverageStrength: "Strong",
    authorityStrength: "Strong",
    coverageGap: "low",
    priority: "low",
    queries: ["how to clean a canvas tote"],
    momentum: { status: "rising", growthRate: 0.26 },
    recommendation: { title: "Add an FAQ block.", effort: "Low", impact: "+15% answer eligibility" },
  },
];

const PLAYS: InsightsGeoAdapterInput["opportunities"] = [
  {
    title: "Restructure /pages/materials into answer-first Q&A",
    evidence: "9 of the top AI-intent queries are materials questions.",
    recommendation: "+15–25% AI citations within 60 days.",
    effort: "Low",
    impact: "+15–25% AI citations",
    priority: "high",
  },
];

function renderTab(activeTab: GeoTabId, overrides: Partial<InsightsGeoAdapterInput> = {}) {
  const onSelectTab = vi.fn();
  const onSelectFilter = vi.fn();
  const model = buildInsightsGeoExactModel({
    activeTab,
    queryFilter: "ai",
    windowDays: 28,
    overview: OVERVIEW,
    sources: SOURCES,
    pages: PAGES,
    queries: QUERIES,
    topics: TOPICS,
    opportunities: PLAYS,
    ...overrides,
  });
  const utils = render(
    <InsightsGeoExact
      model={model}
      onSelectTab={onSelectTab}
      onSelectFilter={onSelectFilter}
    />,
  );
  return { ...utils, onSelectTab, onSelectFilter };
}

function headers(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll("thead th")).map((cell) => cell.textContent ?? "");
}

afterEach(cleanup);

describe("InsightsGeoExact — chrome", () => {
  it("opens on the explainer band with no page header and no connection chips", () => {
    const { container } = renderTab("overview");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("heading", { name: "AI Visibility" })).toBeNull();
    expect(screen.queryByText("connected")).toBeNull();
    expect(screen.queryByText("not connected")).toBeNull();
    expect(screen.getByText("What is AI Visibility?")).toBeTruthy();
    // The design's clause the shipped copy had dropped.
    expect(container.textContent).toContain(
      "measured from your own traffic and search data",
    );
  });

  it("names and orders the six sub-tabs exactly as the design does", () => {
    const { onSelectTab } = renderTab("overview");
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "AI Sources",
      "Pages",
      "Query Intelligence",
      "Topic Authority",
      "Playbook",
    ]);
    fireEvent.click(tabs[5]!);
    expect(onSelectTab).toHaveBeenCalledWith("plays");
  });

  it("keeps the methodology accordion below every tab, collapsed, with four paragraphs", () => {
    renderTab("topics");
    const toggle = screen.getByRole("button", { name: /Methodology & data assumptions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("AI referral traffic")).toBeTruthy();
    expect(screen.getByText("GEO scores")).toBeTruthy();
    expect(screen.getByText("Query intent classification")).toBeTruthy();
    expect(screen.getByText("Direct citation visibility")).toBeTruthy();
    expect(screen.queryByText("Topic clusters")).toBeNull();
  });
});

describe("InsightsGeoExact — Overview", () => {
  it("draws six KPI cards with sub-lines and no group labels", () => {
    renderTab("overview");
    expect(screen.getByText("+38% vs prev 28d")).toBeTruthy();
    expect(screen.getByText("site avg 65.6%")).toBeTruthy();
    expect(screen.getByText("composite · deterministic")).toBeTruthy();
    expect(screen.getByText("proxy · capped at 50")).toBeTruthy();
    expect(screen.getByText("2,148 sessions · 56% of AI traffic")).toBeTruthy();
    expect(screen.queryByText("Top Priorities")).toBeNull();
    expect(screen.queryByText("Insights")).toBeNull();
  });

  it("renders the search intelligence band with both counts and a violet bar", () => {
    renderTab("overview");
    expect(screen.getByText("Search intelligence")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
    expect(screen.getByText("220")).toBeTruthy();
  });

  it("draws no icons — every marker is text or a coloured chip", () => {
    const { container } = renderTab("overview");
    expect(container.querySelectorAll("svg").length).toBe(0);
  });
});

describe("InsightsGeoExact — tables", () => {
  it("gives AI Sources the design's nine columns, ending Revenue then Recommendation", () => {
    renderTab("sources");
    expect(headers(screen.getByRole("table"))).toEqual([
      "AI engine",
      "AI value",
      "Momentum",
      "Sessions",
      "Engagement",
      "Purchases",
      "CVR",
      "Revenue",
      "Recommendation",
    ]);
    expect(screen.getByText("elite · 82")).toBeTruthy();
    expect(screen.getByText("Rising · +38%")).toBeTruthy();
  });

  it("gives Pages exactly the design's six columns, including Sourced by", () => {
    renderTab("pages");
    expect(headers(screen.getByRole("table"))).toEqual([
      "Page",
      "AI sessions",
      "Engagement",
      "Purchase CVR",
      "AIV score",
      "Sourced by",
    ]);
    expect(screen.getByText("AIV 84")).toBeTruthy();
    expect(screen.getByText("ChatGPT · Perplexity")).toBeTruthy();
  });

  it("has no sortable header buttons in the GEO tables", () => {
    const { container } = renderTab("pages");
    expect(container.querySelectorAll("thead button").length).toBe(0);
  });
});

describe("InsightsGeoExact — Query Intelligence", () => {
  it("leads the filter pills with AI intent and puts the footnote inside the card", () => {
    const { onSelectFilter } = renderTab("queries");
    const chips = screen
      .getAllByRole("button")
      .filter((button) => /AI intent|All queries|High impressions|Weak CTR|Rising/.test(button.textContent ?? ""));
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "AI intent 1",
      "All queries 1",
      "High impressions 1",
      "Weak CTR 0",
      "Rising ↑ 1",
    ]);
    fireEvent.click(chips[1]!);
    expect(onSelectFilter).toHaveBeenCalledWith("all");

    const table = screen.getByRole("table");
    const card = table.closest("article") as HTMLElement;
    expect(card.textContent).toContain("✦ marks high answer-engine potential");
    expect(card.textContent).toContain("counts reflect the full 1-query dataset");
  });

  it("combines intent and format into one badge and expands the score breakdown on click", () => {
    renderTab("queries");
    expect(screen.getByText("✦ Informational · How-to")).toBeTruthy();
    const scorePill = screen.getByRole("button", { name: "78" });
    expect(scorePill.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("CTR gap")).toBeNull();
    fireEvent.click(scorePill);
    expect(scorePill.getAttribute("aria-expanded")).toBe("true");
    // Four component bars, captioned from the real scoreQueryGeo keys.
    const breakdown = scorePill.parentElement!.querySelector("div") as HTMLElement;
    expect(
      Array.from(breakdown.children).map(
        (bar) => bar.firstElementChild?.textContent,
      ),
    ).toEqual(["Impressions", "Position", "CTR gap", "Intent"]);
  });
});

describe("InsightsGeoExact — Topic Authority", () => {
  it("renders the card, the aside stack and the design's trailing note, with no intro", () => {
    renderTab("topics");
    expect(screen.getByText("Tote care")).toBeTruthy();
    expect(screen.getByText("Strong")).toBeTruthy();
    expect(screen.getByText("12 queries")).toBeTruthy();
    expect(screen.getByText("GEO 74")).toBeTruthy();
    expect(screen.getByText("impressions")).toBeTruthy();
    expect(screen.getByText("avg pos 3.4")).toBeTruthy();
    expect(screen.getByText("strong authority")).toBeTruthy();
    expect(
      screen.getByText(/Clusters built from your ranking queries/),
    ).toBeTruthy();
  });
});

describe("InsightsGeoExact — Playbook", () => {
  it("is a numbered play grid — no filter pills, no sort control, no Target line", () => {
    const { container } = renderTab("plays");
    expect(screen.getByText("01")).toBeTruthy();
    expect(
      screen.getByText("Restructure /pages/materials into answer-first Q&A"),
    ).toBeTruthy();
    expect(screen.getByText(/^Evidence: /)).toBeTruthy();
    expect(screen.getByText(/^Expected: /)).toBeTruthy();
    expect(screen.getByText("low effort")).toBeTruthy();
    expect(container.querySelectorAll("select").length).toBe(0);
    expect(screen.queryByText(/^Target/)).toBeNull();
    // Only the six sub-tabs and the methodology toggle are buttons here.
    expect(container.querySelectorAll("button").length).toBe(7);
  });
});

describe("InsightsGeoExact — truthfulness", () => {
  it("renders the em-dash, never a design seed, when nothing is served", () => {
    const { container } = renderTab("overview", {
      overview: null,
      sources: null,
      pages: null,
      queries: null,
      topics: null,
      opportunities: null,
    });
    expect(container.textContent).not.toContain("3,840");
    // "ChatGPT" is in the design's static explainer copy, so the seed to check
    // for is the value slot the top-source card would otherwise carry.
    expect(container.textContent).not.toContain("2,148 sessions");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    // The six card slots survive with their geometry intact.
    expect(screen.getByText("AI-source sessions")).toBeTruthy();
    expect(screen.getByText("Top AI source")).toBeTruthy();
  });
});
