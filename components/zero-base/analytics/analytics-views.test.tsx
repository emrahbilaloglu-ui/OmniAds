// @vitest-environment jsdom

/**
 * The mounted analytics surfaces, plus a scan proving the AI generate endpoint
 * has zero call sites in the shipped bundle.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  AnalyticsTableView,
  GeoView,
  SeoView,
  SourceOverviewView,
} from "@/components/zero-base/analytics/analytics-views";
import {
  AI_GENERATE_ENDPOINT,
  adaptAnalyticsOverview,
  adaptGeoOverview,
  adaptSeoOverview,
  adaptSources,
  analyticsValue,
  seoRoleState,
} from "@/lib/zero-base/analytics/analytics-contract";

/** Built from the handler's real return type. */
const OVERVIEW_PAYLOAD = {
  propertyName: "Acme GA4",
  kpis: { sessions: 12000, purchases: 0, revenue: 4820.25 },
  newVsReturning: {
    new: { sessions: 9000, purchases: 210, purchaseCvr: 0.023 },
    returning: { sessions: 3000, purchases: 120, purchaseCvr: 0.04 },
  },
  insights: [{ text: "Returning visitors convert better." }],
};

const SEO_PAYLOAD = {
  meta: { siteUrl: "https://acme.example", rowCount: 812 },
  summary: { clicks: { current: 4200, deltaPercent: 0.077 }, ctr: { current: 0.035, deltaPercent: null } },
  leaders: { queries: [{ query: "acme pricing" }] },
  movers: { decliningQueries: [{ query: "acme review" }] },
  causes: [{ title: "Lost featured snippet" }],
  recommendations: [{ title: "Refresh pricing" }],
  aiBrief: { headline: "Clicks up." },
};

afterEach(cleanup);

const ROOT = process.cwd();

const GEO_PAYLOAD = {
  sources: { ga4: { connected: true }, searchConsole: { connected: false, error: "Token expired." } },
  kpis: { aiPageCount: 50, aiSessions: 0 },
  top3Priorities: [
    { title: "Publish comparison pages", priority: "high", detail: null },
    { title: "Add FAQ schema", priority: "medium", detail: null },
    { title: "Refresh pricing", priority: "low", detail: null },
  ],
};

describe("source panels", () => {
  it("names the source that did not answer, and keeps the other", () => {
    render(
      <SourceOverviewView
        panels={adaptSources(GEO_PAYLOAD)}
        overview={null}
        insight={{ text: null, generatedAt: null, absentReason: "none yet" }}
        unavailableReason="not read"
      />,
    );
    expect(document.querySelector('[data-source-connected="ga4"]')).not.toBeNull();
    expect(document.querySelector('[data-source-down="search_console"]')!.textContent).toBe("Token expired.");
    expect(document.querySelector("[data-source-degraded]")!.textContent).toMatch(
      /missing rather than zero/,
    );
    expect(document.querySelector('[data-source-panels="partial"]')).not.toBeNull();
  });
});

describe("measured zero is visibly different from unavailable", () => {
  it("marks a served zero and names an absent value", () => {
    render(
      <AnalyticsTableView
        title="Landing pages"
        panels={[]}
        rows={[
          {
            id: "r1",
            cells: {
              path: "/pricing",
              sessions: analyticsValue(0, String),
              purchases: analyticsValue(null, String),
            },
          },
        ]}
        columns={[
          { id: "path", header: "Page" },
          { id: "sessions", header: "Sessions", numeric: true },
          { id: "purchases", header: "Purchases", numeric: true },
        ]}
        capText="Showing 1 of up to 300 rows."
      />,
    );
    expect(document.querySelector('[data-value="sessions"]')!.getAttribute("data-measured-zero")).toBe("true");
    expect(document.querySelector('[data-value-unavailable="purchases"]')!.textContent).toMatch(/Not served/);
  });

  it("shows the served cap text", () => {
    render(
      <AnalyticsTableView title="Products" panels={[]} rows={[]} columns={[{ id: "x", header: "X" }]} capText="Backend cap not supplied" />,
    );
    expect(document.querySelector("[data-cap-text]")!.textContent).toBe("Backend cap not supplied");
  });
});

describe("GEO disclosures", () => {
  function geo() {
    const adapted = adaptGeoOverview(GEO_PAYLOAD);
    render(<GeoView geo={adapted.ok ? adapted.value : null} />);
  }

  it("discloses the 50 proxy whenever the number is shown", () => {
    geo();
    expect(document.querySelector("[data-geo-proxy-disclosure]")!.textContent).toMatch(/capped at 50/);
    expect(document.querySelector("[data-geo-at-cap]")).not.toBeNull();
  });

  it("shows exactly three priorities and says others may exist", () => {
    geo();
    expect(document.querySelectorAll("[data-geo-priority]").length).toBe(3);
    expect(document.querySelector("[data-geo-top-three-disclosure]")!.textContent).toMatch(
      /Others may exist/,
    );
  });
});

describe("SEO role gate is visible", () => {
  it("states why a guest has no controls", () => {
    const adapted = adaptSeoOverview(SEO_PAYLOAD);
    render(<SeoView panels={[]} role={seoRoleState("guest")} seo={adapted.ok ? adapted.value : null} />);
    expect(document.querySelector("[data-seo-role-blocked]")!.textContent).toMatch(/cannot change them/);
  });

  it("adds no blocked notice for a collaborator", () => {
    const adapted = adaptSeoOverview(SEO_PAYLOAD);
    render(<SeoView panels={[]} role={seoRoleState("collaborator")} seo={adapted.ok ? adapted.value : null} />);
    expect(document.querySelector("[data-seo-role-blocked]")).toBeNull();
  });
});

describe("the AI insight is read only", () => {
  it("renders the absent state without a generate control", () => {
    render(
      <SourceOverviewView
        panels={[]}
        overview={(() => {
          const a = adaptAnalyticsOverview(OVERVIEW_PAYLOAD);
          return a.ok ? a.value : null;
        })()}
        insight={{ text: null, generatedAt: null, absentReason: "No AI insight has been generated yet." }}
      />,
    );
    expect(document.querySelector('[data-insight="absent"]')).not.toBeNull();
    expect(document.querySelector("[data-insight-read-only]")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/generate insight/i);
    expect(document.body.textContent).not.toMatch(/generate insight/i);
  });

  it("renders the real overview payload rather than degrading", () => {
    const adapted = adaptAnalyticsOverview(OVERVIEW_PAYLOAD);
    render(
      <SourceOverviewView
        panels={[]}
        overview={adapted.ok ? adapted.value : null}
        insight={{ text: null, generatedAt: null, absentReason: "none" }}
      />,
    );
    expect(document.querySelector("[data-ga4-property]")!.textContent).toMatch(/Acme GA4/);
    expect(document.querySelector('[data-value="sessions"]')).not.toBeNull();
    // Two cohorts, never summed.
    expect(document.querySelector('[data-value="new-sessions"]')).not.toBeNull();
    expect(document.querySelector('[data-value="returning-sessions"]')).not.toBeNull();
  });

  it("renders the real SEO payload rather than degrading", () => {
    const adapted = adaptSeoOverview(SEO_PAYLOAD);
    render(<SeoView panels={[]} role={seoRoleState("collaborator")} seo={adapted.ok ? adapted.value : null} />);
    expect(document.querySelector('[data-seo-list="leaders"]')!.textContent).toMatch(/acme pricing/);
    expect(document.querySelector('[data-seo-list="causes"]')!.textContent).toMatch(/featured snippet/);
    // A null deltaPercent is unavailable, not 0%.
    expect(document.querySelector('[data-value-unavailable="ctr-delta"]')).not.toBeNull();
  });

  it("has zero call sites to the generate endpoint in the shipped bundle", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    }
    const files = [
      ...walk(path.join(ROOT, "components", "zero-base", "analytics")),
      ...walk(path.join(ROOT, "lib", "zero-base", "analytics")),
      ...walk(path.join(ROOT, "app", "c", "[businessId]", "analytics")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      // The contract module names the endpoint in a constant so this test can
      // check for it; that declaration is the only occurrence.
      if (file.endsWith("analytics-contract.ts")) continue;
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      expect(source.includes(AI_GENERATE_ENDPOINT), path.basename(file)).toBe(false);
      expect(source.includes("insights/generate"), path.basename(file)).toBe(false);
    }
  });
});
