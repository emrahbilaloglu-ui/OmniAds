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
  adaptGeoOverview,
  adaptSources,
  analyticsValue,
  seoRoleState,
} from "@/lib/zero-base/analytics/analytics-contract";

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
        rows={[]}
        capText="Backend cap not supplied"
        insight={{ text: null, generatedAt: null, absentReason: "none yet" }}
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
              conversions: analyticsValue(null, String),
            },
          },
        ]}
        columns={[
          { id: "path", header: "Page" },
          { id: "sessions", header: "Sessions", numeric: true },
          { id: "conversions", header: "Conversions", numeric: true },
        ]}
        capText="Showing 1 of up to 300 rows."
      />,
    );
    expect(document.querySelector('[data-value="sessions"]')!.getAttribute("data-measured-zero")).toBe("true");
    expect(document.querySelector('[data-value-unavailable="conversions"]')!.textContent).toMatch(/Not served/);
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
    render(<SeoView panels={[]} role={seoRoleState("guest")} findings={[]} />);
    expect(document.querySelector("[data-seo-role-blocked]")!.textContent).toMatch(/cannot change them/);
  });

  it("adds no blocked notice for a collaborator", () => {
    render(<SeoView panels={[]} role={seoRoleState("collaborator")} findings={[]} />);
    expect(document.querySelector("[data-seo-role-blocked]")).toBeNull();
  });
});

describe("the AI insight is read only", () => {
  it("renders the absent state without a generate control", () => {
    render(
      <SourceOverviewView
        panels={[]}
        rows={[]}
        capText=""
        insight={{ text: null, generatedAt: null, absentReason: "No AI insight has been generated yet." }}
      />,
    );
    expect(document.querySelector('[data-insight="absent"]')).not.toBeNull();
    expect(document.querySelector("[data-insight-read-only]")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/generate insight/i);
    expect(document.querySelectorAll("button").length).toBe(0);
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
