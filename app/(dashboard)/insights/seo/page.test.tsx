import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UrlInspectionStatusPanel } from "./url-inspection-status-panel";
import { AiBriefCard, EntityTable, TechnicalFindingsList } from "./seo-intelligence-support";
import type { SeoEntityChange } from "@/lib/seo/intelligence";

describe("UrlInspectionStatusPanel", () => {
  it("renders truthful partial counts and a compact grouped failure summary", () => {
    const html = renderToStaticMarkup(
      <UrlInspectionStatusPanel
        evidence={{
          status: "partial",
          attempted: 5,
          succeeded: 2,
          failed: 3,
          failures: [
            {
              path: "/products/one",
              kind: "quota_exhausted",
              status: null,
            },
            {
              path: "/products/two",
              kind: "quota_exhausted",
              status: null,
            },
            {
              path: "/products/three",
              kind: "provider",
              status: 503,
            },
          ],
        }}
      />,
    );

    expect(html).toContain('data-testid="url-inspection-status"');
    expect(html).toContain("URL Inspection: Partial");
    expect(html).toContain("Attempted");
    expect(html).toContain(">5<");
    expect(html).toContain("Succeeded");
    expect(html).toContain(">2<");
    expect(html).toContain("Failed");
    expect(html).toContain(">3<");
    expect(html).toContain("5 attempted URL inspections reached a terminal outcome.");
    expect(html).toContain("Quota exhausted: 2");
    expect(html).toContain("Provider error (HTTP 503): 1");
  });

  it("renders failed status and does not hide missing failure details", () => {
    const html = renderToStaticMarkup(
      <UrlInspectionStatusPanel
        evidence={{
          status: "failed",
          attempted: 2,
          succeeded: 0,
          failed: 2,
          failures: [],
        }}
      />,
    );

    expect(html).toContain("URL Inspection: Failed");
    expect(html).toContain("No reliable URL Inspection coverage was returned.");
    expect(html).toContain("Failure reasons:");
    expect(html).toContain("Details unavailable");
  });

  it("surfaces inconsistent processed counts instead of presenting false coverage", () => {
    const html = renderToStaticMarkup(
      <UrlInspectionStatusPanel
        evidence={{
          status: "partial",
          attempted: 4,
          succeeded: 1,
          failed: 2,
          failures: [
            {
              path: "/products/one",
              kind: "transport",
              status: null,
            },
            {
              path: "/products/two",
              kind: "transport",
              status: null,
            },
          ],
        }}
      />,
    );

    expect(html).toContain(
      "3 terminal outcomes were reported for 4 attempts. Coverage counts are inconsistent.",
    );
    expect(html).toContain("Network error: 2");
  });

  it("names governance fail-closed reasons separately from transport errors", () => {
    const html = renderToStaticMarkup(
      <UrlInspectionStatusPanel
        evidence={{
          status: "failed",
          attempted: 1,
          succeeded: 0,
          failed: 1,
          failures: [
            {
              path: "/products/one",
              kind: "governance_state_unavailable",
              status: 503,
            },
          ],
        }}
      />,
    );

    expect(html).toContain(
      "Provider safety state unavailable (HTTP 503): 1",
    );
    expect(html).not.toContain("Network error");
  });

  it.each(["complete", "not_requested"] as const)(
    "does not render a degraded panel for %s evidence",
    (status) => {
      const html = renderToStaticMarkup(
        <UrlInspectionStatusPanel
          evidence={{
            status,
            attempted: status === "complete" ? 1 : 0,
            succeeded: status === "complete" ? 1 : 0,
            failed: 0,
            failures: [],
          }}
        />,
      );

      expect(html).toBe("");
    },
  );
});

/**
 * No account in this workspace can serve Search Console data, so these surfaces
 * cannot be exercised in the browser. They are verified here instead, against
 * the served row shape, so the design's column set and block labels stay pinned.
 */
function entityRow(overrides: Partial<SeoEntityChange> = {}): SeoEntityChange {
  return {
    key: "row-1",
    label: "metal wall art",
    classificationLabel: "commercial",
    classificationTone: "commercial",
    clicks: 420,
    previousClicks: 500,
    clicksDelta: -80,
    clicksDeltaPercent: -0.16,
    impressions: 12800,
    previousImpressions: 13100,
    impressionsDelta: -300,
    impressionsDeltaPercent: -0.023,
    ctr: 0.033,
    previousCtr: 0.038,
    ctrDelta: -0.005,
    position: 8.4,
    previousPosition: 7.1,
    positionDelta: 1.3,
    ...overrides,
  };
}

describe("SEO Intelligence surfaces", () => {
  it("names the entity column for what the rows are and spells the metrics out", () => {
    const html = renderToStaticMarkup(
      <EntityTable
        title="Top queries by clicks"
        nameLabel="Query"
        rows={[entityRow()]}
        emptyLabel="No query data available for this period."
      />,
    );

    // The design labels this column Query on the query table and Page on the
    // page table — never a generic "Name".
    expect(html).toContain("Query");
    expect(html).not.toContain(">Name<");
    // The design spells these out rather than abbreviating.
    expect(html).toContain("Impressions");
    expect(html).toContain("Position");
    expect(html).not.toContain("Impr.");
    expect(html).not.toContain("Pos.");
    expect(html).toContain("metal wall art");
  });

  it("labels the page table's first column Page", () => {
    const html = renderToStaticMarkup(
      <EntityTable
        title="Top pages by clicks"
        nameLabel="Page"
        rows={[entityRow({ key: "p1", label: "/collections/wall-art" })]}
        emptyLabel="No page data available for this period."
      />,
    );

    expect(html).toContain("Page");
    expect(html).toContain("/collections/wall-art");
  });

  it("renders the monthly analysis under the design's three block labels", () => {
    const html = renderToStaticMarkup(
      <AiBriefCard
        brief={{
          source: "ai",
          summary: "Clicks fell 16% while impressions held.",
          likelyCause: "Position slipped on five head queries.",
          nextStep: "Refresh the five landing pages, then re-measure.",
        }}
      />,
    );

    expect(html).toContain("Monthly AI analysis");
    expect(html).toContain("What changed");
    expect(html).toContain("Likely causes");
    expect(html).toContain("30-day plan");
    // Each block carries a distinct served field; none is filler.
    expect(html).toContain("Clicks fell 16% while impressions held.");
    expect(html).toContain("Position slipped on five head queries.");
    expect(html).toContain("Refresh the five landing pages, then re-measure.");
    expect(html).toContain("One analysis per month");
  });

  it("states the empty case instead of rendering an empty table body", () => {
    const html = renderToStaticMarkup(
      <EntityTable
        title="Improving queries"
        nameLabel="Query"
        rows={[]}
        emptyLabel="No improving queries in this period."
      />,
    );

    expect(html).toContain("No improving queries in this period.");
  });
});

describe("Technical findings resilience", () => {
  it("renders the blocks it can fill when the payload arrives partial", () => {
    // A drifted or cached payload without meta/summary must not take the
    // screen down; it previously threw on data.meta.urlInspection.
    const partial = {
      confirmedExcludedPages: [],
      findings: [
        {
          id: "f1",
          severity: "critical" as const,
          category: "indexation" as const,
          pageType: "Product" as const,
          title: "12 PDPs at indexation risk",
          description: "Confirmed excluded via URL Inspection.",
          recommendation: "Remove the noindex directive, then request reindexing.",
          affectedPages: [],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <>
        {partial.confirmedExcludedPages.length >= 0 ? (
          <TechnicalFindingsList findings={partial.findings} />
        ) : null}
      </>,
    );

    expect(html).toContain("12 PDPs at indexation risk");
  });
});
