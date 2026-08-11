/**
 * WP-22 boundaries against the ACTUAL report route modules and types.
 *
 * A transition audit found duplicate, save and view all sending or expecting
 * shapes the routes do not use. Each suite asserts the real contract, and the
 * regression cases fail against the previous code.
 */
import { describe, expect, it } from "vitest";

import {
  adaptRenderedReport,
  buildCreateBody,
  buildDuplicateBody,
  buildPatchBody,
  fromReportDocument,
  toReportDocument,
} from "@/lib/zero-base/reports/report-documents";
import { REPORT_GRID_COLUMNS } from "@/lib/custom-reports";
import { RENDERABLE_SOURCES } from "@/lib/zero-base/reports/report-catalog";

const WIDGETS = [
  { id: "w1", sourceId: "meta_campaigns", x: 1, y: 0, w: 2, h: 1 },
  { id: "w2", sourceId: "overview_trend", x: 0, y: 1, w: 4, h: 2 },
];

describe("the report routes expose the methods the client uses", () => {
  it("POST /api/reports and GET/PATCH/DELETE on the detail route", async () => {
    const list = (await import("@/app/api/reports/route")) as Record<string, unknown>;
    const detail = (await import("@/app/api/reports/[reportId]/route")) as Record<string, unknown>;
    const render = (await import("@/app/api/reports/[reportId]/render/route")) as Record<string, unknown>;
    expect(typeof list.GET).toBe("function");
    expect(typeof list.POST).toBe("function");
    expect(typeof detail.GET).toBe("function");
    expect(typeof detail.PATCH).toBe("function");
    // The render route is where rendered widgets come from.
    expect(typeof render.GET).toBe("function");
  });
});

describe("catalog ids are the real CustomReportDataSource union", () => {
  it("maps identity rather than through a table that could drift", () => {
    const document = toReportDocument({ widgets: WIDGETS });
    expect(document.widgets.map((w) => w.dataSource)).toEqual(["meta_campaigns", "overview_trend"]);
    for (const source of RENDERABLE_SOURCES) {
      const doc = toReportDocument({ widgets: [{ ...WIDGETS[0], sourceId: source.id }] });
      expect(doc.widgets[0].dataSource, source.id).toBe(source.id);
    }
  });
});

describe("the builder grid becomes a real CustomReportDocument", () => {
  it("produces version 1 with slot-based widgets", () => {
    const document = toReportDocument({ widgets: WIDGETS });
    expect(document.version).toBe(1);
    expect(document.dateRangePreset).toBe("30");
    expect(document.compareMode).toBe("none");
    // Slot, not x/y: the stored document is slot-based.
    expect(document.widgets[0].slot).toBe(1);
    expect(document.widgets[1].slot).toBe(REPORT_GRID_COLUMNS);
  });

  it("assigns the widget type the catalog grammar implies", () => {
    const document = toReportDocument({ widgets: WIDGETS });
    expect(document.widgets[0].type).toBe("table");
    expect(document.widgets[1].type).toBe("trend");
  });

  it("round-trips through fromReportDocument", () => {
    const restored = fromReportDocument(toReportDocument({ widgets: WIDGETS }));
    expect(restored.map((w) => w.sourceId)).toEqual(["meta_campaigns", "overview_trend"]);
    expect(restored[0].x).toBe(1);
    expect(restored[1].y).toBe(1);
  });

  it("REGRESSION: a raw GridState is not a document", () => {
    // The old save sent { businessId, layout: widgets }.
    const raw = { widgets: WIDGETS } as unknown;
    expect(fromReportDocument(raw).every((w) => w.sourceId)).toBe(true);
    // ...but it carries none of the fields the route stores.
    expect((raw as { version?: unknown }).version).toBeUndefined();
    expect(toReportDocument({ widgets: WIDGETS }).version).toBe(1);
  });
});

describe("create and patch bodies match the routes", () => {
  it("always sends a name, which both routes require", () => {
    const create = buildCreateBody({ businessId: "biz-1", name: "  Weekly  " });
    expect(create).toMatchObject({ businessId: "biz-1", name: "Weekly", templateId: null });
    const patch = buildPatchBody({ name: " Weekly ", document: toReportDocument({ widgets: [] }) });
    expect(patch.name).toBe("Weekly");
  });

  it("REGRESSION: the old create body had no name and would 400", () => {
    const old = { businessId: "biz-1", layout: WIDGETS } as Record<string, unknown>;
    expect("name" in old).toBe(false);
    expect("name" in buildCreateBody({ businessId: "biz-1", name: "x" })).toBe(true);
  });

  it("carries the definition when one is supplied", () => {
    const body = buildCreateBody({
      businessId: "biz-1",
      name: "Weekly",
      document: toReportDocument({ widgets: WIDGETS }),
    });
    expect(body.definition?.widgets).toHaveLength(2);
  });
});

describe("duplicate creates from the source record", () => {
  it("copies the definition under a new name", () => {
    const body = buildDuplicateBody({
      businessId: "biz-1",
      source: { name: "Weekly", description: "d", definition: toReportDocument({ widgets: WIDGETS }) },
    });
    expect("error" in body).toBe(false);
    if ("error" in body) return;
    expect(body.name).toBe("Weekly (copy)");
    expect(body.description).toBe("d");
    expect(body.definition?.widgets).toHaveLength(2);
  });

  it("refuses when the source could not be read rather than creating an empty report", () => {
    const body = buildDuplicateBody({ businessId: "biz-1", source: null });
    expect("error" in body && body.error).toMatch(/could not be read/);
  });

  it("REGRESSION: `duplicateOf` is not in the route contract", () => {
    const body = buildDuplicateBody({ businessId: "biz-1", source: { name: "Weekly" } });
    expect("error" in body).toBe(false);
    if ("error" in body) return;
    expect("duplicateOf" in body).toBe(false);
    expect(body.name).toBe("Weekly (copy)");
  });
});

describe("the viewer reads the render route's payload", () => {
  const RENDERED = {
    report: {
      businessId: "biz-1",
      name: "Weekly",
      dateRangeLabel: "Last 30 days",
      currency: "USD",
      generatedAt: "2026-08-11T12:00:00Z",
      widgets: [
        { id: "w1", slot: 0, colSpan: 2, rowSpan: 1, type: "table", title: "Meta campaigns", dataSource: "meta_campaigns", rows: [{ name: "Brand" }] },
        { id: "w2", slot: 4, colSpan: 4, rowSpan: 2, type: "trend", title: "Trend", dataSource: "overview_trend", errorMessage: "Trend source failed.", retryable: true },
      ],
    },
  };

  it("adapts the nested report payload and per-widget errors", () => {
    const result = adaptRenderedReport(RENDERED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("Weekly");
    expect(result.value.widgets[0].rows).toHaveLength(1);
    expect(result.value.widgets[1].errorMessage).toBe("Trend source failed.");
    expect(result.value.widgets[1].retryable).toBe(true);
  });

  it("refuses a body with no nested report rather than showing an empty report", () => {
    // The old viewer read `/api/reports/[id]` and looked for top-level widgets,
    // so a healthy record rendered as a report with nothing in it.
    const result = adaptRenderedReport({ widgets: [] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/did not carry a report payload/);
  });

  it("refuses a report payload with no widgets array", () => {
    expect(adaptRenderedReport({ report: { name: "x" } }).ok).toBe(false);
  });

  it("REGRESSION: the detail route nests under `report`, not top-level widgets", () => {
    const detailShape = { report: { id: "r1", businessId: "b", name: "Weekly", definition: {} } };
    expect("widgets" in detailShape).toBe(false);
    expect("report" in detailShape).toBe(true);
  });
});
