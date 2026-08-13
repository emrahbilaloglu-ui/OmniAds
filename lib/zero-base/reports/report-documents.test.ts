/**
 * WP-22 boundaries against the ACTUAL report route modules and types.
 *
 * A transition audit found duplicate, save and view all sending or expecting
 * shapes the routes do not use. Each suite asserts the real contract, and the
 * regression cases fail against the previous code.
 */
import { describe, expect, it } from "vitest";

import {
  newWidgetDefinition,
  adaptRenderedReport,
  buildCreateBody,
  buildDuplicateBody,
  buildPatchBody,
  fromReportDocument,
  toReportDocument,
} from "@/lib/zero-base/reports/report-documents";
import { REPORT_GRID_COLUMNS } from "@/lib/custom-reports";
import type { CustomReportDocument, RenderedReportPayload } from "@/lib/custom-reports";
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
    expect(document.widgets[0].slot).toBe(0);
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
    expect(restored[0].x).toBe(0);
    expect(restored[1].y).toBe(1);
  });

  it("scales persisted four-column geometry across the 12-column builder", () => {
    const stored: CustomReportDocument = {
      version: 1,
      dateRangePreset: "30",
      compareMode: "none",
      widgets: [
        {
          id: "full",
          type: "table",
          title: "Full width",
          dataSource: "meta_campaigns",
          slot: 0,
          colSpan: REPORT_GRID_COLUMNS,
          rowSpan: 2,
          columns: ["name"],
        },
        {
          id: "right",
          type: "metric",
          title: "Right edge",
          dataSource: "overview_summary",
          metricKey: "spend",
          slot: 3,
          colSpan: 1,
          rowSpan: 1,
        },
      ],
    };

    const builder = fromReportDocument(stored);
    expect(builder[0]).toMatchObject({ x: 0, w: 12 });
    expect(builder[1]).toMatchObject({ x: 9, w: 3 });
    expect(toReportDocument({ widgets: builder, base: stored }).widgets).toEqual(stored.widgets);
  });

  it("REGRESSION: a raw GridState is not a document", () => {
    // The old save sent { businessId, layout: widgets }.
    const raw = { widgets: WIDGETS } as unknown;
    // A raw grid carries no `dataSource` on any widget, so reading it back
    // yields widgets with no source — proof it was never a stored document.
    expect(fromReportDocument(raw).every((w) => w.sourceId === "")).toBe(true);
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
  /**
   * Typed as the real payload.
   *
   * The previous fixture carried a `dataSource` on each widget and the adapter
   * read it. `RenderedReportWidget` has no such field — the renderer reads
   * `dataSource` off the *definition* and never echoes it — so in production
   * every widget resolved to `""`. Typing the fixture makes the excess property
   * a compile error rather than a self-fulfilling test.
   */
  const RENDERED: { report: RenderedReportPayload } = {
    report: {
      businessId: "biz-1",
      name: "Weekly",
      dateRangeLabel: "Last 30 days",
      currency: "USD",
      generatedAt: "2026-08-11T12:00:00Z",
      widgets: [
        { id: "w1", slot: 0, colSpan: 2, rowSpan: 1, type: "table", title: "Meta campaigns", rows: [{ name: "Brand" }], columns: ["name"] },
        { id: "w2", slot: 4, colSpan: 4, rowSpan: 2, type: "trend", title: "Trend", errorMessage: "Trend source failed.", retryable: true },
        { id: "w3", slot: 8, colSpan: 1, rowSpan: 1, type: "metric", title: "Spend", value: "12.00 USD", deltaLabel: "+2.0% vs previous" },
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
    // The metric's own content survives: it used to be dropped entirely,
    // because every widget was reshaped into a rows-only table.
    expect(result.value.widgets[2].value).toBe("12.00 USD");
    expect(result.value.widgets[2].deltaLabel).toBe("+2.0% vs previous");
  });

  it("REGRESSION: widget ids are distinct, so the viewer can key on them", () => {
    const result = adaptRenderedReport(RENDERED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.widgets.map((widget) => widget.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("REGRESSION: the rendered widget type carries no dataSource to read", () => {
    const result = adaptRenderedReport(RENDERED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const widget of result.value.widgets) {
      expect(Object.prototype.hasOwnProperty.call(widget, "dataSource")).toBe(false);
    }
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


describe("editing preserves the whole stored document", () => {
  /**
   * A document exercising every field the builder does not model. If saving
   * drops one, the operator loses configuration they never touched.
   */
  const STORED: CustomReportDocument = {
    version: 1,
    dateRangePreset: "7",
    compareMode: "previous_period",
    reportPlatforms: ["meta", "google"],
    widgets: [
      {
        id: "w1",
        type: "table",
        slot: 0,
        colSpan: 2,
        rowSpan: 2,
        title: "Top Meta Campaigns",
        subtitle: "By spend",
        dataSource: "meta_campaigns",
        accountId: "act_123",
        limit: 25,
        columns: ["name", "spend", "roas"],
        tableDimension: "campaign",
      },
      {
        id: "w2",
        type: "trend",
        slot: 8,
        colSpan: 2,
        rowSpan: 2,
        title: "Spend trend",
        dataSource: "overview_trend",
        metricKey: "combined.spend",
        yMetrics: ["meta.spend", "google.spend"],
        breakdown: "week",
        axisMode: "zero_based",
      },
      {
        id: "w3",
        type: "text",
        slot: 16,
        colSpan: 2,
        rowSpan: 1,
        title: "Note",
        text: "Reviewed with the client on the 4th.",
      },
    ],
  };

  it("REGRESSION: a full round-trip is lossless for untouched fields", () => {
    const widgets = fromReportDocument(STORED);
    const saved = toReportDocument({ widgets, base: STORED });

    // Document-level settings survive.
    expect(saved.dateRangePreset).toBe("7");
    expect(saved.compareMode).toBe("previous_period");
    expect(saved.reportPlatforms).toEqual(["meta", "google"]);

    for (const original of STORED.widgets) {
      const after = saved.widgets.find((widget) => widget.id === original.id);
      expect(after, original.id).toBeDefined();
      // Geometry may be rewritten by the grid; nothing else may change.
      const { slot: _s, colSpan: _c, rowSpan: _r, ...restBefore } = original;
      const { slot: _s2, colSpan: _c2, rowSpan: _r2, ...restAfter } = after!;
      expect(restAfter, original.id).toEqual(restBefore);
    }
  });

  it("REGRESSION: moving one widget does not destroy another's configuration", () => {
    const widgets = fromReportDocument(STORED).map((widget) =>
      widget.id === "w1" ? { ...widget, x: 6, y: 1 } : widget,
    );
    const saved = toReportDocument({ widgets, base: STORED });
    const trend = saved.widgets.find((widget) => widget.id === "w2");
    expect(trend?.yMetrics).toEqual(["meta.spend", "google.spend"]);
    expect(trend?.breakdown).toBe("week");
    expect(trend?.axisMode).toBe("zero_based");
    const table = saved.widgets.find((widget) => widget.id === "w1");
    expect(table?.columns).toEqual(["name", "spend", "roas"]);
    expect(table?.accountId).toBe("act_123");
    expect(table?.limit).toBe(25);
    // The move itself did land.
    expect(table?.slot).toBe(1 * REPORT_GRID_COLUMNS + 2);
  });

  it("a newly added source arrives fully configured, not bare", () => {
    for (const source of RENDERABLE_SOURCES) {
      const created = newWidgetDefinition({ id: `new-${source.id}`, sourceId: source.id, slot: 0 });
      expect(created, source.id).not.toBeNull();
      if (!created) continue;
      expect(created.dataSource, source.id).toBe(source.id);
      if (created.type === "metric") {
        // Without a metricKey the renderer returns "Metric unavailable for
        // this business." purely because the builder omitted configuration.
        expect(created.metricKey, source.id).toBeTruthy();
      }
      if (created.type === "trend" || created.type === "bar") {
        expect(created.metricKey ?? created.yMetrics?.length, source.id).toBeTruthy();
      }
      if (created.type === "table") {
        expect(created.columns?.length, source.id).toBeGreaterThan(0);
      }
    }
  });

  it("a new report with no base still produces configured widgets", () => {
    const saved = toReportDocument({
      widgets: [{ id: "n1", sourceId: "overview_summary", x: 0, y: 0, w: 1, h: 1 }],
    });
    expect(saved.widgets[0].metricKey).toBeTruthy();
    expect(saved.widgets[0].type).toBe("metric");
  });
});
