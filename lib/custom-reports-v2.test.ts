import { describe, expect, it } from "vitest";

import { resolveDateRangePreset } from "@/lib/custom-report-renderer";
import {
  CUSTOM_REPORT_TEMPLATES,
  colSpanToWidgetSize,
  createBlankReportDefinition,
  ensureReportDefinition,
  resolveWidgetSize,
  widgetSizeToColSpan,
} from "@/lib/custom-reports";

describe("report date ranges", () => {
  it("resolves the builder's default 28-day window as four whole weeks", () => {
    const range = resolveDateRangePreset("28");
    const start = new Date(`${range.startDate}T00:00:00Z`).getTime();
    const end = new Date(`${range.endDate}T00:00:00Z`).getTime();
    expect(Math.round((end - start) / 86_400_000) + 1).toBe(28);
  });

  it("treats 'this month' as a calendar window, not a trailing one", () => {
    const range = resolveDateRangePreset("this_month");
    expect(range.startDate.endsWith("-01")).toBe(true);
    expect(range.label).toBe("This month");
    expect(range.startDate <= range.endDate).toBe(true);
  });

  it("keeps the legacy presets resolving as before", () => {
    for (const [preset, days] of [
      ["7", 7],
      ["30", 30],
      ["90", 90],
    ] as const) {
      const range = resolveDateRangePreset(preset);
      const start = new Date(`${range.startDate}T00:00:00Z`).getTime();
      const end = new Date(`${range.endDate}T00:00:00Z`).getTime();
      expect(Math.round((end - start) / 86_400_000) + 1).toBe(days);
    }
  });
});

describe("document sanitising", () => {
  it("opens a new report on the 28-day window with comparison on", () => {
    const blank = createBlankReportDefinition();
    expect(blank.dateRangePreset).toBe("28");
    expect(blank.compareMode).toBe("previous_period");
  });

  it("accepts the v2 block kinds", () => {
    const document = ensureReportDefinition({
      version: 1,
      dateRangePreset: "28",
      compareMode: "previous_period",
      widgets: [
        { id: "a", type: "kpirow", slot: 0, colSpan: 4, rowSpan: 1, title: "Blended KPIs" },
        { id: "b", type: "donut", slot: 1, colSpan: 1, rowSpan: 1, title: "Channel mix" },
        { id: "c", type: "brief", slot: 2, colSpan: 4, rowSpan: 1, title: "Brief 01" },
      ],
    });
    expect(document.widgets.map((widget) => widget.type)).toEqual(["kpirow", "donut", "brief"]);
  });

  it("recovers a pre-v2 block's width from its stored column span", () => {
    const document = ensureReportDefinition({
      version: 1,
      dateRangePreset: "30",
      compareMode: "none",
      widgets: [
        { id: "a", type: "table", slot: 0, colSpan: 4, rowSpan: 2, title: "Campaigns" },
        { id: "b", type: "metric", slot: 1, colSpan: 1, rowSpan: 1, title: "Spend" },
      ],
    });
    expect(document.widgets.map((widget) => widget.size)).toEqual(["L", "S"]);
    // A document nobody touched keeps its own window.
    expect(document.dateRangePreset).toBe("30");
  });

  it("keeps `section` blocks stored reports already contain", () => {
    const document = ensureReportDefinition({
      version: 1,
      dateRangePreset: "30",
      compareMode: "none",
      widgets: [{ id: "a", type: "section", slot: 0, colSpan: 4, rowSpan: 1, title: "Overview" }],
    });
    expect(document.widgets[0].type).toBe("section");
  });

  it("falls back to a text block for a type nobody defines", () => {
    const document = ensureReportDefinition({
      version: 1,
      dateRangePreset: "30",
      compareMode: "none",
      widgets: [
        { id: "a", type: "sunburst" as never, slot: 0, colSpan: 2, rowSpan: 1, title: "?" },
      ],
    });
    expect(document.widgets[0].type).toBe("text");
  });
});

describe("block widths", () => {
  it("round-trips size through the grid columns print lays out from", () => {
    for (const size of ["S", "M", "L"] as const) {
      expect(colSpanToWidgetSize(widgetSizeToColSpan(size))).toBe(size);
    }
  });

  it("prefers the stored size over the column span when both exist", () => {
    expect(resolveWidgetSize({ size: "M", colSpan: 4 })).toBe("M");
    expect(resolveWidgetSize({ colSpan: 4 })).toBe("L");
  });
});

describe("template catalogue", () => {
  it("gives every template a cadence the card can print", () => {
    for (const template of CUSTOM_REPORT_TEMPLATES) {
      expect(template.cadence.trim().length).toBeGreaterThan(0);
    }
  });
});
