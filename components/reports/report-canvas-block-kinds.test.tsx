// @vitest-environment jsdom

/**
 * Every block kind a report can be saved with, rendered through the export
 * path.
 *
 * `ReportCanvas` is the only renderer behind all three client-facing surfaces —
 * `/reports/[id]`, `/reports/[id]/print` and `/share/report/[token]` — so a
 * kind it cannot draw is a kind that exports as a blank white box. That is
 * exactly what happened when the builder gained six new kinds and this renderer
 * was not taught them, and it is what these tests exist to prevent.
 *
 * Two assertions per kind: the measured content actually appears, and the
 * design's own geometry is present so an unmeasured block still exports as the
 * block it is rather than as an empty card.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ReportCanvas } from "@/components/reports/report-canvas";
import { REPORT_WIDGET_TYPES } from "@/lib/custom-reports";
import type {
  RenderedReportPayload,
  RenderedReportWidget,
} from "@/lib/custom-reports";

const DASH = "—";

function payload(widgets: Array<Partial<RenderedReportWidget>>): RenderedReportPayload {
  return {
    businessId: "biz_1",
    name: "Weekly Exec Summary",
    dateRangeLabel: "Last 28 days (2026-07-17 to 2026-08-13)",
    generatedAt: "2026-08-17T00:00:00.000Z",
    widgets: widgets.map((widget, index) => ({
      id: `w${index}`,
      slot: index * 4,
      colSpan: 4,
      rowSpan: 1,
      type: "text",
      title: "Block",
      ...widget,
    })) as RenderedReportWidget[],
  };
}

/** The export path exactly as `/share/report/[token]` mounts it. */
function exportHtml(widgets: Array<Partial<RenderedReportWidget>>) {
  const html = renderToStaticMarkup(<ReportCanvas report={payload(widgets)} />);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return { html, doc };
}

function block(doc: Document, kind: string) {
  return doc.querySelector(`[data-report-block="${kind}"]`);
}

describe("every saved block kind renders through the export path", () => {
  it("covers every kind the widget-type union allows", () => {
    // The guard on the whole file: if a kind is added to the union and to the
    // palette without a branch here, this list is what makes that visible.
    expect(REPORT_WIDGET_TYPES).toEqual([
      "metric",
      "kpirow",
      "trend",
      "bar",
      "donut",
      "funnel",
      "table",
      "heat",
      "ai",
      "text",
      "brief",
      "section",
    ]);
  });

  it("prints the kpirow's measured figures, not just its title", () => {
    const { html, doc } = exportHtml([
      {
        type: "kpirow",
        title: "Blended KPIs",
        metrics: [
          { key: "spend", label: "Spend", value: "$118,220" },
          { key: "roas", label: "MER", value: "4.09" },
        ],
      },
    ]);
    expect(html).toContain("Blended KPIs");
    expect(html).toContain("$118,220");
    expect(html).toContain("4.09");
    expect(html).toContain("Spend");
    expect(html).toContain("MER");
    expect(block(doc, "kpirow")).not.toBeNull();
  });

  it("dashes an unmeasured kpirow inside the strip rather than dropping it", () => {
    const { doc } = exportHtml([
      { type: "kpirow", title: "Blended KPIs", metrics: [] },
    ]);
    const strip = block(doc, "kpirow");
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain(DASH);
  });

  it("prints the donut's measured shares and draws the ring from them", () => {
    const { html, doc } = exportHtml([
      {
        type: "donut",
        title: "Channel mix",
        slices: [
          { label: "Meta", value: "$60,000", sharePct: 60 },
          { label: "Google", value: "$40,000", sharePct: 40 },
        ],
      },
    ]);
    expect(html).toContain("Meta 60%");
    expect(html).toContain("Google 40%");
    const donut = block(doc, "donut");
    expect(donut).not.toBeNull();
    const ring = donut!.firstElementChild as HTMLElement;
    // The ring is drawn from the same shares the legend prints, so a client
    // cannot be shown one split in the chart and another in the key.
    expect(ring.getAttribute("style")).toContain("#2F6BFF 0.00% 60.00%");
    expect(ring.getAttribute("style")).toContain("#0E9F6E 60.00% 100.00%");
  });

  it("draws an unmeasured donut as the neutral ring with a dashed legend", () => {
    const { doc } = exportHtml([{ type: "donut", title: "Channel mix", slices: [] }]);
    const donut = block(doc, "donut");
    expect(donut).not.toBeNull();
    expect(donut!.textContent).toContain(DASH);
    expect((donut!.firstElementChild as HTMLElement).getAttribute("style")).toContain(
      "#EDF0F6",
    );
  });

  it("draws a funnel as the reference's track, dashed, not as a blank box", () => {
    const { html, doc } = exportHtml([{ type: "funnel", title: "Click to purchase" }]);
    expect(html).toContain("Click to purchase");
    const funnel = block(doc, "funnel");
    expect(funnel).not.toBeNull();
    expect(funnel!.querySelectorAll("[data-funnel-step]")).toHaveLength(1);
    expect(funnel!.textContent).toContain(DASH);
  });

  it("draws a heat block as the reference's six-column grid", () => {
    const { html, doc } = exportHtml([{ type: "heat", title: "Creative heat table" }]);
    expect(html).toContain("Creative heat table");
    const heat = block(doc, "heat");
    expect(heat).not.toBeNull();
    // Twelve cells, exactly as the reference lays the grid out. None of them is
    // tinted, because a tint is a reading and nothing was read.
    const cells = heat!.querySelectorAll("[data-heat-cell]");
    expect(cells).toHaveLength(12);
    for (const cell of Array.from(cells)) {
      expect(cell.getAttribute("style")).toBeNull();
    }
  });

  it("draws an AI block as the reference's panel with its tag", () => {
    const { html, doc } = exportHtml([{ type: "ai", title: "Board brief" }]);
    expect(html).toContain("Board brief");
    const ai = block(doc, "ai");
    expect(ai).not.toBeNull();
    expect(ai!.textContent).toContain("AI BRIEF");
    expect(ai!.textContent).toContain(DASH);
  });

  it("draws a creative brief at the reference's full layout, dashed throughout", () => {
    const { html, doc } = exportHtml([
      { type: "brief", title: "Brief 01 — Hook variants" },
    ]);
    expect(html).toContain("Brief 01 — Hook variants");
    const brief = block(doc, "brief");
    expect(brief).not.toBeNull();
    // The reference's own static scaffolding survives; every field that would
    // carry a measurement reads as an em dash.
    expect(brief!.textContent).toContain("THE CREATIVE");
    expect(brief!.textContent).toContain("→ WHAT WE NEED");
    expect(brief!.textContent).toContain("WHY");
    expect(brief!.textContent).toContain("RULES");
    expect(brief!.textContent).toContain(DASH);
  });

  it("still renders the kinds that predate the v2 builder", () => {
    const { html } = exportHtml([
      { type: "metric", title: "Spend", value: "$118,220", deltaLabel: "+8.1% vs prev" },
      {
        type: "trend",
        title: "Spend trend",
        points: [
          { label: "Aug 1", value: 10 },
          { label: "Aug 2", value: 20 },
        ],
      },
      {
        type: "table",
        title: "Channel attribution",
        columns: ["channel", "spend"],
        rows: [{ channel: "Meta", spend: "$60,000" }],
      },
      { type: "text", title: "Notes", text: "Caveats for this period." },
      { type: "section", title: "Executive Overview", subtitle: "This window." },
    ]);
    expect(html).toContain("$118,220");
    expect(html).toContain("Spend trend");
    expect(html).toContain("$60,000");
    expect(html).toContain("Caveats for this period.");
    expect(html).toContain("Executive Overview");
  });

  it("never exports a saved block as an empty card", () => {
    // The regression itself, stated as a rule: for every kind the union allows,
    // an exported card carries a body — either text beyond its own title, or
    // the design's geometry for that kind. A card with neither is the blank
    // white box a report containing a kind this renderer did not know produced.
    for (const type of REPORT_WIDGET_TYPES) {
      const { doc } = exportHtml([{ type, title: `Title for ${type}` }]);
      const card = doc.querySelector("article");
      expect(card, type).not.toBeNull();
      const text = (card!.textContent ?? "").replace(`Title for ${type}`, "").trim();
      const geometry = card!.querySelector(
        "[data-report-block], svg, table",
      );
      expect(
        text.length > 0 || geometry !== null,
        `${type} exported with a title and nothing else`,
      ).toBe(true);
    }
  });
});
