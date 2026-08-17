import { describe, expect, it } from "vitest";

import {
  BUILDER_DATE_RANGE_OPTIONS,
  BUILDER_METRIC_OPTIONS,
  BUILDER_PALETTE,
  BUILDER_SOURCE_OPTIONS,
  DASH,
  buildBlockBody,
  buildBlockInspector,
  buildBlocks,
  buildCounterLabel,
  buildPageMeta,
  buildPaletteGroups,
  buildReportInspector,
  buildSavedReports,
  buildSizeOptions,
  buildSparkPath,
  buildTabs,
  buildTemplateCards,
  deriveProviders,
  toBuilderKind,
  toWidgetType,
  widthCssForSize,
} from "@/components/reports/reports-exact-adapter";
import {
  CUSTOM_REPORT_TEMPLATES,
  type CustomReportDocument,
  type CustomReportRecord,
  type CustomReportWidgetDefinition,
  type RenderedReportWidget,
} from "@/lib/custom-reports";

function widget(
  overrides: Partial<CustomReportWidgetDefinition> = {},
): CustomReportWidgetDefinition {
  return {
    id: "w1",
    type: "metric",
    slot: 0,
    colSpan: 1,
    rowSpan: 1,
    size: "S",
    title: "Spend",
    dataSource: "overview_summary",
    metricKey: "spend",
    ...overrides,
  };
}

function document(widgets: CustomReportWidgetDefinition[]): CustomReportDocument {
  return { version: 1, dateRangePreset: "28", compareMode: "previous_period", widgets };
}

function record(overrides: Partial<CustomReportRecord> = {}): CustomReportRecord {
  return {
    id: "r1",
    businessId: "b1",
    name: "Weekly Exec Summary",
    description: "Top-line blended performance.",
    templateId: "one-click-paid-media",
    definition: document([widget()]),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("tabs", () => {
  it("carries the design's three tabs with live counts", () => {
    const tabs = buildTabs({ active: "builder", savedCount: 4, templateCount: 7, blockCount: 5 });
    expect(tabs.map((tab) => tab.label)).toEqual(["My reports", "Templates", "Builder"]);
    expect(tabs.map((tab) => tab.count)).toEqual([4, 7, 5]);
    expect(tabs.filter((tab) => tab.active).map((tab) => tab.id)).toEqual(["builder"]);
  });
});

describe("saved report rows", () => {
  it("reports the block count and the providers the document actually reads", () => {
    const [row] = buildSavedReports({
      reports: [
        record({
          definition: document([
            widget(),
            widget({ id: "w2", type: "table", dataSource: "meta_campaigns" }),
          ]),
        }),
      ],
      busyReportId: null,
    });
    expect(row.meta).toContain("2 blocks");
    expect(row.meta).toContain("Blended + Meta");
  });

  it("never claims a send state, because none is stored against a report", () => {
    const [row] = buildSavedReports({ reports: [record()], busyReportId: null });
    expect(row.status).toBe(DASH);
  });

  it("shows an em dash rather than inventing a description", () => {
    const [row] = buildSavedReports({
      reports: [record({ description: "   " })],
      busyReportId: null,
    });
    expect(row.description).toBe(DASH);
  });

  it("marks only the row whose action is in flight", () => {
    const rows = buildSavedReports({
      reports: [record(), record({ id: "r2" })],
      busyReportId: "r2",
    });
    expect(rows.map((row) => row.busy)).toEqual([false, true]);
  });
});

describe("template cards", () => {
  const cards = buildTemplateCards();

  it("covers every catalogue template and carries its cadence", () => {
    expect(cards).toHaveLength(CUSTOM_REPORT_TEMPLATES.length);
    expect(cards[0].cadence).toBe("best weekly · Mon");
    expect(cards.every((card) => card.cadence.length > 0)).toBe(true);
  });

  it("numbers the contents list from the template's own blocks", () => {
    const executive = cards.find((card) => card.id === "one-click-paid-media");
    expect(executive?.contents[0]).toEqual({ n: "01", t: "Spend" });
    expect(executive?.contents.every((entry) => /^\d\d$/.test(entry.n))).toBe(true);
    expect(executive?.contents.length).toBeLessThanOrEqual(5);
  });

  it("derives the footer meta from the real block count and providers", () => {
    const executive = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === "one-click-paid-media");
    const card = cards.find((item) => item.id === "one-click-paid-media");
    expect(card?.meta).toBe(
      `${executive?.definition.widgets.length} blocks · Meta + Google + GA4 + Shopify`,
    );
  });

  it("draws one preview band per block", () => {
    for (const card of cards) {
      const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === card.id);
      expect(card.blocks).toHaveLength(template?.definition.widgets.length ?? -1);
    }
  });
});

describe("palette", () => {
  it("offers the design's thirteen blocks in four groups", () => {
    const groups = buildPaletteGroups();
    expect(groups.map((group) => group.name)).toEqual(["KPIs", "Charts", "Tables", "Content"]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(13);
  });

  it("labels and tags each block exactly as the design does", () => {
    const groups = buildPaletteGroups();
    const items = groups.flatMap((group) => group.items);
    expect(items.map((item) => item.label)).toEqual([
      "KPI tile",
      "KPI row · 4 up",
      "Trend line",
      "Bar compare",
      "Share donut",
      "Funnel",
      "Campaign table",
      "Creative heat table",
      "Query table",
      "AI summary",
      "Text block",
      "Decision log",
      "Creative brief",
    ]);
    expect(items.find((item) => item.label === "Campaign table")?.source).toBe("Meta·G");
    expect(items.find((item) => item.label === "Query table")?.source).toBe("GSC");
    expect(items.find((item) => item.label === "Text block")?.source).toBe(DASH);
  });

  it("gives each group its own icon colour", () => {
    const groups = buildPaletteGroups();
    expect(groups.map((group) => group.items[0].iconBg)).toEqual([
      "#2F6BFF",
      "#0E9F6E",
      "#B45309",
      "#6C41BE",
    ]);
  });

  it("has no Section block", () => {
    expect(BUILDER_PALETTE.some((entry) => entry.label === "Section")).toBe(false);
  });

  it("round-trips every palette kind through the stored widget type", () => {
    for (const entry of BUILDER_PALETTE) {
      expect(toBuilderKind(toWidgetType(entry.kind))).toBe(entry.kind);
    }
  });
});

describe("block widths", () => {
  it("uses the design's S/M/L flow widths", () => {
    expect(widthCssForSize("S")).toBe("calc(33.333% - 7px)");
    expect(widthCssForSize("M")).toBe("calc(50% - 5px)");
    expect(widthCssForSize("L")).toBe("100%");
  });

  it("marks the active width segment", () => {
    expect(buildSizeOptions("M")).toEqual([
      { size: "S", label: "⅓", active: false },
      { size: "M", label: "½", active: true },
      { size: "L", label: "Full", active: false },
    ]);
  });
});

describe("block bodies", () => {
  it("reports a KPI's measured value and delta", () => {
    const body = buildBlockBody("kpi", {
      id: "w1",
      slot: 0,
      colSpan: 1,
      rowSpan: 1,
      type: "metric",
      title: "Spend",
      value: "$118,220",
      deltaLabel: "+8.1%",
    });
    expect(body).toEqual({
      kind: "kpi",
      value: "$118,220",
      delta: "+8.1%",
      deltaTone: "#0E9F6E",
    });
  });

  it("does not invent a figure when the renderer supplied none", () => {
    expect(buildBlockBody("kpi", { id: "w1", slot: 0, colSpan: 1, rowSpan: 1, type: "metric", title: "Spend" })).toEqual({
      kind: "unavailable",
    });
  });

  it("treats a failed widget as unavailable rather than empty", () => {
    const failed: RenderedReportWidget = {
      id: "w1",
      slot: 0,
      colSpan: 1,
      rowSpan: 1,
      type: "metric",
      title: "Spend",
      value: "$1",
      errorMessage: "upstream unavailable",
    };
    expect(buildBlockBody("kpi", failed)).toEqual({ kind: "unavailable" });
  });

  it("colours a negative delta as a loss", () => {
    const body = buildBlockBody("kpi", {
      id: "w1",
      slot: 0,
      colSpan: 1,
      rowSpan: 1,
      type: "metric",
      title: "ROAS",
      value: "2.10",
      deltaLabel: "−4.2%",
    });
    expect(body).toMatchObject({ deltaTone: "#E11D48" });
  });

  it("builds a KPI row from the renderer's four figures", () => {
    const body = buildBlockBody("kpirow", {
      id: "w1",
      slot: 0,
      colSpan: 4,
      rowSpan: 1,
      type: "kpirow",
      title: "Blended KPIs",
      metrics: [
        { key: "spend", label: "Spend", value: "$118.2k" },
        { key: "revenue", label: "Revenue", value: DASH },
      ],
    });
    expect(body).toEqual({
      kind: "kpirow",
      minis: [
        { k: "Spend", v: "$118.2k" },
        { k: "Revenue", v: DASH },
      ],
    });
  });

  it("turns attribution shares into a donut whose legend sums from real slices", () => {
    const body = buildBlockBody("donut", {
      id: "w1",
      slot: 0,
      colSpan: 1,
      rowSpan: 1,
      type: "donut",
      title: "Channel mix",
      slices: [
        { label: "Meta", value: "$1", sharePct: 60 },
        { label: "Google", value: "$1", sharePct: 40 },
      ],
    });
    expect(body).toMatchObject({
      kind: "donut",
      legend: [
        { color: "#2F6BFF", text: "Meta 60%" },
        { color: "#0E9F6E", text: "Google 40%" },
      ],
    });
  });

  it("keeps funnel, heat and brief as their own kinds so the design's geometry survives", () => {
    // Until a renderer measures them these carry no payload, but they must not
    // collapse to `unavailable`: that drops the block's shape from the page the
    // client receives. The geometry is drawn and the em dash sits inside it.
    for (const kind of ["funnel", "heat", "brief", "ai"] as const) {
      expect(buildBlockBody(kind, null)).toEqual({ kind });
    }
  });

  it("still reports a failed block of those kinds as unavailable", () => {
    // A failure is not an unmeasured figure. It keeps the explicit unavailable
    // body so the surface can say so rather than drawing an empty structure.
    for (const kind of ["funnel", "heat", "brief", "ai"] as const) {
      expect(
        buildBlockBody(kind, {
          id: "w1",
          slot: 0,
          colSpan: 4,
          rowSpan: 1,
          type: "funnel",
          title: "Click to purchase",
          errorMessage: "Upstream request failed.",
        }),
      ).toEqual({ kind: "unavailable" });
    }
  });
});

describe("spark paths", () => {
  it("refuses to draw a trend through fewer than two points", () => {
    expect(buildSparkPath([{ value: 5 }])).toBeNull();
  });

  it("spans the design's 100-wide viewBox", () => {
    const spark = buildSparkPath([{ value: 1 }, { value: 3 }, { value: 2 }]);
    expect(spark?.path.startsWith("M0.0 ")).toBe(true);
    expect(spark?.path).toContain("L100.0 ");
    expect(spark?.area.endsWith("L100 26 L0 26 Z")).toBe(true);
  });

  it("puts a flat series in the middle of the band rather than on the axis", () => {
    const spark = buildSparkPath([{ value: 4 }, { value: 4 }]);
    expect(spark?.path).toBe("M0.0 13.0 L100.0 13.0");
  });
});

describe("canvas blocks", () => {
  it("stamps provenance from the block's own source and the report window", () => {
    const [block] = buildBlocks({
      definition: document([widget({ dataSource: "meta_campaigns", type: "table" })]),
      rendered: null,
      selectedUid: null,
      compareOn: true,
      rangeLabel: "last 28 days",
    });
    expect(block.sourceNote).toBe("meta · last 28 days · vs previous period");
  });

  it("says so when comparison is off", () => {
    const [block] = buildBlocks({
      definition: document([widget()]),
      rendered: null,
      selectedUid: null,
      compareOn: false,
      rangeLabel: "last 7 days",
    });
    expect(block.sourceNote).toContain("no comparison");
  });

  it("marks the selected block with the accent border", () => {
    const [block] = buildBlocks({
      definition: document([widget()]),
      rendered: null,
      selectedUid: "w1",
      compareOn: true,
      rangeLabel: "last 28 days",
    });
    expect(block.selected).toBe(true);
    expect(block.borderColor).toBe("#2F6BFF");
  });

  it("recovers a pre-v2 block's width from its stored column span", () => {
    const [block] = buildBlocks({
      definition: document([widget({ size: undefined, colSpan: 4 })]),
      rendered: null,
      selectedUid: null,
      compareOn: true,
      rangeLabel: "last 28 days",
    });
    expect(block.size).toBe("L");
    expect(block.widthCss).toBe("100%");
  });
});

describe("inspector", () => {
  it("offers the design's six block controls", () => {
    const inspector = buildBlockInspector({ widget: widget(), compareOn: true });
    expect(inspector.kindLabel).toBe("KPI tile");
    expect(inspector.metricOptions.map((option) => option.label)).toEqual([
      "Spend",
      "Revenue",
      "ROAS",
      "Orders",
      "CTR",
      "CVR",
      "Sessions",
    ]);
    expect(inspector.sourceOptions.map((option) => option.label)).toEqual([
      "Blended · all providers",
      "Meta Ads",
      "Google Ads",
      "GA4",
      "Shopify",
      "Search Console",
    ]);
    expect(inspector.dateRangeOptions.map((option) => option.label)).toEqual([
      "Report range",
      "Last 7 days",
      "Last 28 days",
    ]);
    expect(inspector.compareOn).toBe(true);
  });

  it("does not offer a per-block window no renderer honours", () => {
    expect(buildBlockInspector({ widget: widget(), compareOn: false }).dateRangeDisabled).toBe(true);
  });

  it("falls back to the first metric when the block stores one the design does not list", () => {
    const inspector = buildBlockInspector({
      widget: widget({ metricKey: "combined.spend" }),
      compareOn: false,
    });
    expect(inspector.metric).toBe(BUILDER_METRIC_OPTIONS[0].value);
  });

  it("names the real client and withholds the settings it cannot honour", () => {
    const inspector = buildReportInspector({
      clientName: "Aurora Supply Co.",
      clientOptions: [{ id: "b1", name: "Aurora Supply Co." }],
    });
    expect(inspector.client).toBe("Aurora Supply Co.");
    expect(inspector.clientDisabled).toBe(true);
    expect(inspector.scheduleDisabled).toBe(true);
    expect(inspector.recipients).toEqual([{ label: DASH, removable: false }]);
    expect(inspector.liveShareOn).toBe(false);
  });
});

describe("toolbar", () => {
  it("offers the design's four ranges and refuses the one with no contract", () => {
    expect(BUILDER_DATE_RANGE_OPTIONS.map((option) => option.label)).toEqual([
      "Last 28 days",
      "Last 7 days",
      "This month",
      "Custom range…",
    ]);
    expect(BUILDER_DATE_RANGE_OPTIONS.find((option) => option.value === "custom")?.disabled).toBe(
      true,
    );
  });

  it("only says autosaved once a save has actually landed", () => {
    expect(buildCounterLabel(5, "idle")).toBe("5 blocks");
    expect(buildCounterLabel(5, "saving")).toBe("5 blocks · saving…");
    expect(buildCounterLabel(5, "saved")).toBe("5 blocks · autosaved");
    expect(buildCounterLabel(5, "error")).toBe("5 blocks · not saved");
    expect(buildCounterLabel(1, "saved")).toBe("1 block · autosaved");
  });

  it("dashes the page header's client and window when neither is established", () => {
    expect(buildPageMeta({ clientName: null, rangeLabel: null })).toBe(`${DASH} · ${DASH} · Page 1`);
    expect(buildPageMeta({ clientName: "Aurora", rangeLabel: "Jul 17 – Aug 13" })).toBe(
      "Aurora · Jul 17 – Aug 13 · Page 1",
    );
  });
});

describe("provider derivation", () => {
  it("lists each provider once, in block order", () => {
    expect(
      deriveProviders(
        document([
          widget({ dataSource: "meta_campaigns" }),
          widget({ id: "w2", dataSource: "overview_summary" }),
          widget({ id: "w3", dataSource: "meta_campaigns" }),
        ]),
      ),
    ).toEqual(["Meta", "Blended"]);
  });

  it("names every source option the inspector can write", () => {
    for (const option of BUILDER_SOURCE_OPTIONS) {
      expect(deriveProviders(document([widget({ dataSource: option.value as never })]))).toHaveLength(
        1,
      );
    }
  });
});
