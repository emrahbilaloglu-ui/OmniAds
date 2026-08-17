import { describe, expect, it } from "vitest";

import {
  buildInsightsSeoExactModel,
  buildSeoActionGroups,
  buildSeoKpis,
  buildSeoMonthly,
  buildSeoMovers,
  buildSeoQueries,
  buildSeoTechnical,
  seoActionGroupFor,
  seoExclusionTone,
  seoMonthlyGenerateControl,
  seoPassedPageCount,
  SEO_TABS,
  type SeoFindingsInput,
  type SeoMonthlyInput,
  type SeoOverviewInput,
} from "@/components/seo/insights-seo-exact-adapter";

const OVERVIEW: SeoOverviewInput = {
  summary: {
    clicks: { current: 48_240, previous: 44_200, delta: 4_040, deltaPercent: 0.0914 },
    impressions: {
      current: 1_940_000,
      previous: 1_730_000,
      delta: 210_000,
      deltaPercent: 0.1214,
    },
    ctr: { current: 0.0248, previous: 0.0255, delta: -0.0007, deltaPercent: -0.0275 },
    position: { current: 8.4, previous: 9.5, delta: -1.1, deltaPercent: -0.116 },
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
      {
        key: "q2",
        label: "travel kit organizer",
        clicks: 1_980,
        impressions: 122_000,
        ctr: 0.016,
        position: 9.1,
        positionDelta: 0.6,
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
    decliningQueries: [
      { key: "m1", label: "travel kit organizer", clicks: 1_980, clicksDelta: -214 },
    ],
    decliningPages: [],
    improvingQueries: [
      { key: "m2", label: "recycled sailcloth bag", clicks: 1_120, clicksDelta: 342 },
    ],
    improvingPages: [],
  },
};

describe("SEO sub-tabs", () => {
  it("names and orders the six sub-tabs exactly as the design does", () => {
    expect(SEO_TABS.map((tab) => [tab.id, tab.label])).toEqual([
      ["ai", "Monthly AI"],
      ["traffic", "Traffic changes"],
      ["queries", "Queries"],
      ["pages", "Pages"],
      ["actions", "Actions"],
      ["technical", "Technical findings"],
    ]);
  });
});

describe("buildSeoKpis", () => {
  it("renders the design's four cards with a delta pill and a mono prev line", () => {
    const kpis = buildSeoKpis(OVERVIEW);
    expect(kpis.map((kpi) => kpi.label)).toEqual([
      "Organic clicks",
      "Impressions",
      "CTR",
      "Avg position",
    ]);
    expect(kpis[0]).toMatchObject({
      value: "48.2K",
      delta: "+9.1%",
      deltaTone: "positive",
      previous: "prev 44.2K",
    });
    expect(kpis[1]).toMatchObject({ value: "1.94M", previous: "prev 1.73M" });
    expect(kpis[2]).toMatchObject({ value: "2.48%", delta: "−2.8%", deltaTone: "negative" });
  });

  it("prints the position improvement, not the raw delta", () => {
    const [, , , position] = buildSeoKpis(OVERVIEW);
    expect(position).toMatchObject({
      value: "8.4",
      delta: "↑ 1.1 better",
      deltaTone: "positive",
      previous: "prev 9.5",
    });
  });

  it("renders the em-dash rather than a zero when nothing is served", () => {
    const kpis = buildSeoKpis(null);
    expect(kpis.every((kpi) => kpi.value === "—")).toBe(true);
    expect(kpis.every((kpi) => kpi.delta === "—")).toBe(true);
    // No design seed leaks through.
    expect(kpis.map((kpi) => kpi.value)).not.toContain("48.2K");
  });
});

describe("buildSeoQueries", () => {
  it("prints Δ pos as the improvement: a negative positionDelta reads positive", () => {
    const [up, down] = buildSeoQueries(OVERVIEW);
    expect(up).toMatchObject({ positionDelta: "+0.8", positionDeltaTone: "positive" });
    expect(down).toMatchObject({ positionDelta: "−0.6", positionDeltaTone: "negative" });
  });

  it("renders an unmoved query as = with the neutral tone", () => {
    const [row] = buildSeoQueries({
      leaders: { queries: [{ key: "q", label: "x", positionDelta: 0 }] },
    });
    expect(row).toMatchObject({ positionDelta: "=", positionDeltaTone: "neutral" });
  });
});

describe("buildSeoMovers", () => {
  it("keeps all four mover cards even when a bucket is empty", () => {
    const movers = buildSeoMovers(OVERVIEW);
    expect(movers.map((card) => card.title)).toEqual([
      "Biggest declining queries",
      "Biggest declining pages",
      "Improving queries",
      "Improving pages",
    ]);
    expect(movers[0]!.rows[0]).toMatchObject({
      label: "travel kit organizer",
      current: "1,980",
      delta: "−214",
      deltaTone: "negative",
    });
    expect(movers[2]!.rows[0]).toMatchObject({ delta: "+342", deltaTone: "positive" });
    expect(movers[1]!.rows).toEqual([]);
  });
});

const MONTHLY: SeoMonthlyInput = {
  monthKey: "2026-08",
  monthLabel: "August 2026",
  generatedAt: "2026-08-03T09:20:00.000Z",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  status: "available",
  overviewData: {
    dataLayers: [{ title: "Search KPIs" }, { title: "Query & page movers" }],
  },
  analysis: {
    summary: "Organic growth is intact but concentrated.",
    rootCauses: [
      { title: "Template meta titles", detail: "Collection titles cap CTR at 1.6–1.9%." },
    ],
    // The design's own five Actions items (script L4003-4012), with the impact
    // and effort their copy states. The fourth is the counter-example: a
    // low-effort item the design files under Strategic, not Quick wins.
    priorities: [
      {
        title: "Fix canonical/noindex on 5 excluded PDPs",
        detail: "Excluded since the Aug 6 theme update.",
        impact: "medium",
        effort: "low",
        owner: "Developer",
      },
      {
        title: "Rewrite meta titles on 8 position-8–12 queries",
        detail: "Template titles cap CTR at 1.6–1.9%.",
        impact: "medium",
        effort: "low",
        owner: "Content",
      },
      {
        title: "Ship a “materials” hub page",
        detail: "Joins 14 mid-tail queries.",
        impact: "high",
        effort: "medium",
        owner: "Content",
      },
      {
        title: "Internal links from the two top guides to money pages",
        detail: "Guides earn links but pass no authority on.",
        impact: "high",
        effort: "low",
        owner: "SEO",
      },
      {
        title: "Refresh /blogs/gift-guide before Q4",
        detail: "Declining −91 clicks; last touched Nov 2025.",
        impact: "medium",
        effort: "medium",
        owner: "Content",
      },
    ],
    actionPlan: [
      { window: "week 1", focus: "Indexation", tasks: ["Fix noindex on 5 PDPs", "Re-request indexing"] },
      { window: "week 2–4", focus: "Content", tasks: ["Ship the materials hub"] },
    ],
    structured: {
      executiveSummary: { topFindings: ["Top 5 queries carry 61% of clicks."] },
    },
  },
};

describe("buildSeoMonthly", () => {
  it("fills the design's head, reads chips and three columns from the served analysis", () => {
    const monthly = buildSeoMonthly(MONTHLY);
    expect(monthly.head.title).toBe("Monthly AI analysis — August 2026");
    expect(monthly.head.statusLabel).toBe("available");
    expect(monthly.head.meta).toContain("window Jul 1 – Jul 31");
    expect(monthly.head.meta).toContain("saved as the team’s planning artifact");
    // "next window" is the first day of the month after the analysis month.
    expect(monthly.head.cadence).toBe("One analysis per month · next window Sep 1");
    expect(monthly.reads).toEqual(["Search KPIs", "Query & page movers"]);
    expect(monthly.whatChanged).toEqual(["Top 5 queries carry 61% of clicks."]);
    expect(monthly.likelyCauses[0]).toContain("Template meta titles —");
  });

  it("flattens the action plan into a numbered list carrying each task's window", () => {
    const monthly = buildSeoMonthly(MONTHLY);
    expect(monthly.plan.map((step) => [step.ordinal, step.text])).toEqual([
      ["01", "Fix noindex on 5 PDPs (week 1)"],
      ["02", "Re-request indexing (week 1)"],
      ["03", "Ship the materials hub (week 2–4)"],
    ]);
  });

  it("renders the em-dash and keeps the card's geometry when nothing is generated", () => {
    const monthly = buildSeoMonthly(null);
    expect(monthly.head.statusLabel).toBe("—");
    expect(monthly.summary).toBe("—");
    expect(monthly.reads).toEqual([]);
    expect(monthly.plan).toEqual([]);
  });
});

describe("seoMonthlyGenerateControl", () => {
  it("offers no control in the state the design draws", () => {
    expect(seoMonthlyGenerateControl(MONTHLY)).toBeNull();
    expect(buildSeoMonthly(MONTHLY).head.generate).toBeNull();
    // Nothing served yet: the state is unknown, so no control is offered.
    expect(seoMonthlyGenerateControl(null)).toBeNull();
    expect(seoMonthlyGenerateControl({ status: "available", canGenerate: true })).toBeNull();
  });

  it("offers the generator exactly when a run would be accepted", () => {
    expect(seoMonthlyGenerateControl({ status: "not_generated", canGenerate: true })).toEqual({
      label: "Generate this month’s analysis",
    });
    expect(seoMonthlyGenerateControl({ status: "failed", canGenerate: true })).toEqual({
      label: "Retry this month’s analysis",
    });
    // The server refuses the run — the design's disabled chip stands instead.
    expect(seoMonthlyGenerateControl({ status: "not_generated", canGenerate: false })).toBeNull();
    expect(seoMonthlyGenerateControl({ status: "not_generated" })).toBeNull();
  });
});

describe("buildSeoActionGroups", () => {
  it("routes every priority to one of the design's three tone groups", () => {
    expect(seoActionGroupFor({ impact: "medium", effort: "low" })).toBe("quick");
    expect(seoActionGroupFor({ impact: "high", effort: "medium" })).toBe("strategic");
    expect(seoActionGroupFor({ impact: "medium", effort: "medium" })).toBe("supporting");
  });

  it("puts the design's own low-effort Strategic item in Strategic, not Quick wins", () => {
    // Script L4010: "Internal links from the two top guides to money pages" is
    // "low effort · week 2" and the design files it under Strategic. An
    // effort-first rule would move it into Quick wins.
    expect(seoActionGroupFor({ impact: "high", effort: "low" })).toBe("strategic");

    const groups = buildSeoActionGroups(MONTHLY);
    const placement = new Map(
      groups.flatMap((group) => group.items.map((item) => [item.title, group.toneLabel])),
    );
    expect(placement.get("Internal links from the two top guides to money pages")).toBe(
      "Strategic",
    );
  });

  it("reproduces every one of the design's five Actions placements", () => {
    const groups = buildSeoActionGroups(MONTHLY);
    expect(
      groups.map((group) => [group.toneLabel, group.items.map((item) => item.title)]),
    ).toEqual([
      [
        "Quick wins",
        [
          "Fix canonical/noindex on 5 excluded PDPs",
          "Rewrite meta titles on 8 position-8–12 queries",
        ],
      ],
      [
        "Strategic",
        [
          "Ship a “materials” hub page",
          "Internal links from the two top guides to money pages",
        ],
      ],
      ["Supporting", ["Refresh /blogs/gift-guide before Q4"]],
    ]);
  });

  it("emits only the groups that have items, in the design's order", () => {
    const groups = buildSeoActionGroups(MONTHLY);
    expect(groups[0]!.items[0]).toMatchObject({
      title: "Fix canonical/noindex on 5 excluded PDPs",
      impact: "medium impact",
      effort: "low effort · Developer",
    });
    expect(buildSeoActionGroups(null)).toEqual([]);
    expect(
      buildSeoActionGroups({
        analysis: {
          priorities: [
            { title: "Only strategic", detail: "d", impact: "high", effort: "high" },
          ],
        },
      }).map((group) => group.toneLabel),
    ).toEqual(["Strategic"]);
  });
});

const FINDINGS: SeoFindingsInput = {
  meta: {
    auditedPageCount: 148,
    urlInspection: { attempted: 5, succeeded: 5 },
  },
  summary: { critical: 1, warning: 3, opportunity: 1, passed: 144 },
  confirmedExcludedPages: [
    { path: "/products/a", coverageState: "Excluded by ‘noindex’ tag" },
    { path: "/collections/b", coverageState: "Crawled - currently not indexed" },
  ],
  findings: [
    {
      id: "f1",
      severity: "critical",
      title: "12 product URLs went noindex",
      description: "5 remain excluded.",
      affectedPages: [{ path: "/products/a" }, { path: "/products/b" }],
    },
    {
      id: "f2",
      severity: "warning",
      title: "Sitemap stale",
      description: "Last fetched 9 days ago.",
      affectedPages: [{ path: "/products/a" }],
    },
    {
      id: "f3",
      severity: "opportunity",
      title: "Add FAQ structured data",
      description: "Eligible for rich results.",
      affectedPages: [{ path: "/pages/opportunity-only" }],
    },
    {
      id: "f4",
      severity: "passed",
      title: "Pages cleared every technical check that ran",
      description: "Checks that ran on these pages: title tag, H1 heading.",
      affectedPages: [{ path: "/products/c" }],
    },
  ],
};

/**
 * Shaped like the design's own data — no opportunity-only page, disjoint
 * critical and warning page sets — so the design's subtraction is checkable
 * against the served count.
 */
const DESIGN_SHAPED_FINDINGS: SeoFindingsInput = {
  meta: { auditedPageCount: 148 },
  summary: { critical: 5, warning: 12, opportunity: 0, passed: 131 },
  findings: [
    {
      id: "c",
      severity: "critical",
      affectedPages: Array.from({ length: 5 }, (_, i) => ({ path: `/critical/${i}` })),
    },
    {
      id: "w",
      severity: "warning",
      affectedPages: Array.from({ length: 12 }, (_, i) => ({ path: `/warning/${i}` })),
    },
    {
      id: "p",
      severity: "passed",
      affectedPages: Array.from({ length: 131 }, (_, i) => ({ path: `/passed/${i}` })),
    },
  ],
};

describe("buildSeoTechnical", () => {
  it("reads Passed from the served count rather than subtracting", () => {
    // 148 audited, but the card reports the 144 pages the provider actually
    // graded as passing — not 148 − 1 − 3. `/pages/opportunity-only` carries
    // an opportunity, so it cleared neither every check nor nothing at all,
    // and it belongs to no card but Pages audited.
    expect(seoPassedPageCount(FINDINGS)).toBe(144);
    const technical = buildSeoTechnical(FINDINGS);
    expect(technical.cards.map((card) => [card.label, card.value])).toEqual([
      ["Pages audited", "148"],
      ["Critical", "1"],
      ["Warnings", "3"],
      ["Passed", "144"],
    ]);
  });

  it("makes the four cards reconcile the design's way on design-shaped data", () => {
    // The design's own arithmetic, script L4013: 148 − 5 − 12 = 131 — which
    // the served count matches whenever the data has the design's shape.
    expect(seoPassedPageCount(DESIGN_SHAPED_FINDINGS)).toBe(131);
    const cards = buildSeoTechnical(DESIGN_SHAPED_FINDINGS).cards;
    const value = (label: string) =>
      Number(cards.find((card) => card.label === label)!.value.replace(/,/g, ""));
    expect(value("Pages audited") - value("Critical") - value("Warnings")).toBe(
      value("Passed"),
    );
  });

  it("keeps the Passed card and renders the em-dash when the count is not served", () => {
    // Findings cached before the severity existed carry no `summary.passed`.
    const technical = buildSeoTechnical({ meta: { auditedPageCount: 148 }, findings: [] });
    expect(technical.cards).toHaveLength(4);
    expect(technical.cards[3]).toMatchObject({ label: "Passed", value: "—" });
  });

  it("prints the URL Inspection coverage as the design's N-of-M hint", () => {
    expect(buildSeoTechnical(FINDINGS).inspectionHint).toBe("URL Inspection · 5 of 5");
    expect(buildSeoTechnical({}).inspectionHint).toBe("URL Inspection · not requested");
  });

  it("reduces an excluded page to a url and one reason badge", () => {
    const [blocked, crawled] = buildSeoTechnical(FINDINGS).excluded;
    expect(blocked).toMatchObject({ url: "/products/a", tone: "negative" });
    expect(crawled).toMatchObject({ url: "/collections/b", tone: "warning" });
    expect(seoExclusionTone("Blocked by robots.txt")).toBe("negative");
  });

  it("captions each finding with its real severity", () => {
    const findings = buildSeoTechnical(FINDINGS).findings;
    expect(findings.map((finding) => finding.severity)).toEqual([
      "Critical",
      "Warning",
      "Opportunity",
      "Passed",
    ]);
  });

  it("paints the design's green on Passed alone", () => {
    // Script L4021-4027: C.neg / C.warn / C.pos. Opportunity is a severity the
    // design has no chip for, so it takes C.info rather than a second green.
    const findings = buildSeoTechnical(FINDINGS).findings;
    expect(findings.map((finding) => [finding.severity, finding.tone])).toEqual([
      ["Critical", "negative"],
      ["Warning", "warning"],
      ["Opportunity", "info"],
      ["Passed", "positive"],
    ]);
  });
});

describe("buildInsightsSeoExactModel", () => {
  it("marks the active sub-tab and carries every block", () => {
    const model = buildInsightsSeoExactModel({
      activeTab: "queries",
      overview: OVERVIEW,
      monthly: MONTHLY,
      findings: FINDINGS,
    });
    expect(model.activeTab).toBe("queries");
    expect(model.tabs.filter((tab) => tab.active).map((tab) => tab.id)).toEqual(["queries"]);
    expect(model.queries).toHaveLength(2);
    expect(model.pages).toHaveLength(1);
    expect(model.actionGroups).toHaveLength(3);
  });
});
