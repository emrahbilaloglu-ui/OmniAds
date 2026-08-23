// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ReportsExact } from "@/components/reports/ReportsExact";
import {
  BUILDER_DATE_RANGE_OPTIONS,
  BUILDER_DROP_HINT,
  BUILDER_PALETTE_EYEBROW,
  REPORTS_EXPORT_NOTE,
  REPORTS_MINE_FOOTNOTE,
  REPORTS_TEMPLATES_FOOTNOTE,
  buildPaletteGroups,
  buildReportInspector,
  buildSizeOptions,
  buildTemplateCards,
} from "@/components/reports/reports-exact-adapter";
import type {
  ReportsExactHandlers,
  ReportsExactModel,
  ReportsTabId,
} from "@/components/reports/reports-exact-model";

afterEach(cleanup);

function handlers(): ReportsExactHandlers {
  return {
    onSelectTab: vi.fn(),
    onNewReport: vi.fn(),
    onOpenReport: vi.fn(),
    onDuplicateReport: vi.fn(),
    onShareReport: vi.fn(),
    onExportReportPdf: vi.fn(),
    onPreviewTemplate: vi.fn(),
    onUseTemplate: vi.fn(),
    onRenameReport: vi.fn(),
    onChangeDateRange: vi.fn(),
    onPreview: vi.fn(),
    onSave: vi.fn(),
    onPaletteAdd: vi.fn(),
    onPaletteDragStart: vi.fn(),
    onBlockSelect: vi.fn(),
    onBlockRemove: vi.fn(),
    onBlockCycleSize: vi.fn(),
    onBlockDragStart: vi.fn(),
    onBlockDropOn: vi.fn(),
    onDropEnd: vi.fn(),
    onInspectorTitleChange: vi.fn(),
    onInspectorMetricChange: vi.fn(),
    onInspectorSourceChange: vi.fn(),
    onInspectorSizeChange: vi.fn(),
    onToggleCompare: vi.fn(),
    onRemoveSelected: vi.fn(),
  };
}

function model(activeTab: ReportsTabId): ReportsExactModel {
  return {
    eyebrow: "Growth · Client-ready output",
    title: "Reports",
    newReportLabel: "+ New report",
    tabs: [
      { id: "mine", label: "My reports", count: 2, active: activeTab === "mine" },
      { id: "templates", label: "Templates", count: 7, active: activeTab === "templates" },
      { id: "builder", label: "Builder", count: 2, active: activeTab === "builder" },
    ],
    exportNote: REPORTS_EXPORT_NOTE,
    activeTab,
    mine: {
      reports: [
        {
          id: "r1",
          name: "Weekly Exec Summary",
          status: "—",
          statusBg: "#F1F4F9",
          statusFg: "#555d6d",
          thumbTone: "#2a5fe2",
          description: "Top-line blended performance.",
          meta: "updated Aug 12 · 9 blocks · Blended + Meta",
          busy: false,
        },
      ],
      footnote: REPORTS_MINE_FOOTNOTE,
    },
    templates: { cards: buildTemplateCards(), footnote: REPORTS_TEMPLATES_FOOTNOTE },
    builder: {
      name: "Weekly Exec Summary",
      dateRange: "28",
      dateRangeOptions: BUILDER_DATE_RANGE_OPTIONS,
      comparePillLabel: "vs previous period",
      counterLabel: "2 blocks · autosaved",
      pageMeta: "Aurora Supply Co. · 2026-07-17 – 2026-08-13 · Page 1",
      blocks: [
        {
          uid: "w1",
          title: "Blended KPIs",
          size: "L",
          sizeLabel: "L",
          widthCss: "100%",
          borderColor: "#2a5fe2",
          selected: true,
          kind: "kpi",
          body: { kind: "kpi", value: "$118,220", delta: "+8.1%", deltaTone: "#0b7954" },
          sourceNote: "blended · last 28 days · vs previous period",
        },
        {
          uid: "w2",
          title: "Fatigue watchlist",
          size: "M",
          sizeLabel: "M",
          widthCss: "calc(50% - 5px)",
          borderColor: "#E4E8F0",
          selected: false,
          kind: "heat",
          body: { kind: "unavailable" },
          sourceNote: "meta · last 28 days · vs previous period",
        },
      ],
      palette: buildPaletteGroups(),
      paletteEyebrow: BUILDER_PALETTE_EYEBROW,
      dropHint: BUILDER_DROP_HINT,
      inspector: {
        mode: "block",
        kindLabel: "KPI tile",
        title: "Blended KPIs",
        metric: "spend",
        metricOptions: [
          { value: "spend", label: "Spend" },
          { value: "revenue", label: "Revenue" },
        ],
        source: "overview_summary",
        sourceOptions: [
          { value: "overview_summary", label: "Blended · all providers" },
          { value: "meta_campaigns", label: "Meta Ads" },
        ],
        dateRange: "report",
        dateRangeOptions: [{ value: "report", label: "Report range" }],
        dateRangeDisabled: true,
        sizeOptions: buildSizeOptions("L"),
        compareOn: true,
        footnote: "changes apply to the page live · provenance is stamped per block on send",
      },
      saveEnabled: true,
      saveLabel: "Save & schedule",
    },
  };
}

describe("header and tabs", () => {
  it("draws only the eyebrow, the title and the new-report action", () => {
    render(<ReportsExact model={model("mine")} handlers={handlers()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Reports");
    expect(screen.getByText("Growth · Client-ready output")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New report" })).toBeTruthy();
    expect(screen.queryByText(/Save report formats/)).toBeNull();
  });

  it("puts the export note at the end of the tab row, not in the header", () => {
    render(<ReportsExact model={model("mine")} handlers={handlers()} />);
    expect(screen.getByText(REPORTS_EXPORT_NOTE)).toBeTruthy();
  });

  it("switches tabs through the handler", () => {
    const bag = handlers();
    render(<ReportsExact model={model("mine")} handlers={bag} />);
    fireEvent.click(screen.getByRole("button", { name: /Builder/ }));
    expect(bag.onSelectTab).toHaveBeenCalledWith("builder");
  });
});

describe("my reports", () => {
  it("offers the design's four row actions and no delete", () => {
    render(<ReportsExact model={model("mine")} handlers={handlers()} />);
    for (const label of ["Open in builder", "Duplicate", "Share link", "PDF"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /Delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
  });

  it("has no search box and no sort control", () => {
    render(<ReportsExact model={model("mine")} handlers={handlers()} />);
    expect(screen.queryByPlaceholderText(/Search/i)).toBeNull();
    expect(screen.queryByText(/Sort:/)).toBeNull();
  });

  it("carries the footnote under the list", () => {
    render(<ReportsExact model={model("mine")} handlers={handlers()} />);
    expect(screen.getByText(REPORTS_MINE_FOOTNOTE)).toBeTruthy();
  });

  it("renders the status badge even when nothing establishes a status", () => {
    render(<ReportsExact model={model("mine")} handlers={handlers()} />);
    expect(screen.getByText("Weekly Exec Summary")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("templates", () => {
  it("draws the cadence, the numbered contents, the meta footer and both actions", () => {
    render(<ReportsExact model={model("templates")} handlers={handlers()} />);
    expect(screen.getAllByText("best weekly · Mon").length).toBe(1);
    expect(screen.getAllByText("01").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Preview" }).length).toBe(7);
    expect(screen.getAllByRole("button", { name: "Use template" }).length).toBe(7);
    expect(screen.getByText(REPORTS_TEMPLATES_FOOTNOTE)).toBeTruthy();
  });

  it("routes Preview and Use template to different handlers", () => {
    const bag = handlers();
    render(<ReportsExact model={model("templates")} handlers={bag} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Preview" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Use template" })[0]);
    expect(bag.onPreviewTemplate).toHaveBeenCalledWith("one-click-paid-media");
    expect(bag.onUseTemplate).toHaveBeenCalledWith("one-click-paid-media");
  });
});

describe("builder toolbar", () => {
  it("carries the counter, Preview and Save & schedule", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.getByText("2 blocks · autosaved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save & schedule" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save$/ })).toBeNull();
  });

  it("shows comparison as a pill, not a control", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    const pill = screen.getByText("vs previous period");
    expect(pill.tagName).toBe("SPAN");
  });

  it("offers the design's ranges and refuses the custom one", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    const select = screen.getByLabelText("Report date range") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      "Last 28 days",
      "Last 7 days",
      "This month",
      "Custom range…",
    ]);
    expect(select.options[3].disabled).toBe(true);
  });

  it("has no back control and no actions dropdown", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions/ })).toBeNull();
    expect(screen.queryByText(/Export CSV/)).toBeNull();
    expect(screen.queryByText(/Share expiry/)).toBeNull();
  });
});

describe("builder palette", () => {
  it("groups the thirteen blocks under the design's four headings", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.getByText(BUILDER_PALETTE_EYEBROW)).toBeTruthy();
    for (const group of ["KPIs", "Charts", "Tables", "Content"]) {
      expect(screen.getByText(group)).toBeTruthy();
    }
    expect(screen.getByText("Creative brief")).toBeTruthy();
    expect(screen.getByText("Share donut")).toBeTruthy();
    expect(screen.queryByText("Section")).toBeNull();
  });

  it("adds a block on click", () => {
    const bag = handlers();
    render(<ReportsExact model={model("builder")} handlers={bag} />);
    fireEvent.click(screen.getByText("Share donut"));
    expect(bag.onPaletteAdd).toHaveBeenCalledWith("donut");
  });
});

describe("builder canvas", () => {
  it("draws the report page header with the accent square and page meta", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.getByText("Aurora Supply Co. · 2026-07-17 – 2026-08-13 · Page 1")).toBeTruthy();
    expect(screen.queryByText("Canvas")).toBeNull();
    expect(screen.queryByPlaceholderText(/Add a description/)).toBeNull();
    expect(screen.queryByText(/^Template:/)).toBeNull();
  });

  it("gives every block a drag handle, a size chip, a remove control and provenance", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.getAllByTitle("Drag to reorder")).toHaveLength(2);
    expect(screen.getAllByTitle("Cycle width S → M → L")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove Blended KPIs" })).toBeTruthy();
    expect(screen.getByText("blended · last 28 days · vs previous period")).toBeTruthy();
  });

  it("lays blocks out on the design's S/M/L flow widths", () => {
    const { container } = render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    const blocks = container.querySelectorAll("[data-block-uid]");
    expect((blocks[0] as HTMLElement).style.width).toBe("100%");
    expect((blocks[1] as HTMLElement).style.width).toBe("calc(50% - 5px)");
  });

  it("shows an em dash for a block no renderer can build yet", () => {
    const { container } = render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    const heat = container.querySelector('[data-block-uid="w2"]') as HTMLElement;
    expect(within(heat).getByText("—")).toBeTruthy();
  });

  it("cycles size and removes without also selecting the block", () => {
    const bag = handlers();
    render(<ReportsExact model={model("builder")} handlers={bag} />);
    fireEvent.click(screen.getAllByTitle("Cycle width S → M → L")[0]);
    expect(bag.onBlockCycleSize).toHaveBeenCalledWith("w1");
    expect(bag.onBlockSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Blended KPIs" }));
    expect(bag.onBlockRemove).toHaveBeenCalledWith("w1");
  });

  it("carries one dashed drop zone and no onboarding panel", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.getByText(BUILDER_DROP_HINT)).toBeTruthy();
    expect(screen.queryByText(/Start with your first widget/)).toBeNull();
    expect(screen.queryByText(/Cmd\/Ctrl/)).toBeNull();
  });
});

describe("builder inspector", () => {
  it("carries the block-settings eyebrow, the kind chip and the six controls", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    const head = screen.getByText("Block settings").parentElement as HTMLElement;
    expect(within(head).getByText("KPI tile")).toBeTruthy();
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Metric")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
    expect(screen.getByText("Date range")).toBeTruthy();
    expect(screen.getByText("Width")).toBeTruthy();
    expect(screen.getByText("Show vs previous period")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove block" })).toBeTruthy();
  });

  it("offers width as ⅓ / ½ / Full", () => {
    const bag = handlers();
    render(<ReportsExact model={model("builder")} handlers={bag} />);
    fireEvent.click(screen.getByRole("button", { name: "½" }));
    expect(bag.onInspectorSizeChange).toHaveBeenCalledWith("M");
  });

  it("has no table, breakdown, body or subtitle sections", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.queryByText("Breakdown")).toBeNull();
    expect(screen.queryByText("Body")).toBeNull();
    expect(screen.queryByPlaceholderText(/Subtitle/)).toBeNull();
    expect(screen.queryByText("Dimension")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Metric" })).toBeNull();
  });

  it("shows no template list in the right rail", () => {
    render(<ReportsExact model={model("builder")} handlers={handlers()} />);
    expect(screen.queryByText("Executive Overview")).toBeNull();
    expect(screen.queryByText("Meta Deep Dive")).toBeNull();
    expect(screen.queryByText("Store Economics")).toBeNull();
  });

  it("shows report settings when nothing is selected", () => {
    const base = model("builder");
    const withReportSettings: ReportsExactModel = {
      ...base,
      builder: {
        ...base.builder,
        inspector: buildReportInspector({
          clientName: "Aurora Supply Co.",
          clientOptions: [{ id: "b1", name: "Aurora Supply Co." }],
        }),
      },
    };
    render(<ReportsExact model={withReportSettings} handlers={handlers()} />);
    expect(screen.getByText("Report settings")).toBeTruthy();
    expect(screen.getByText("Client")).toBeTruthy();
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.getByText("Recipients")).toBeTruthy();
    expect(screen.getByText("Live share link")).toBeTruthy();
    expect(screen.getByText("viewer role")).toBeTruthy();
  });
});

describe("styling lives in the module, not the shared sheet", () => {
  const source = readFileSync("components/reports/ReportsExact.tsx", "utf8");

  it("uses only the CSS module and inline model values", () => {
    expect(source).toContain('from "@/components/reports/ReportsExact.module.css"');
    expect(source).not.toContain("className=\"ad-");
  });

  it("never introduces a page shell inside the workspace column", () => {
    const css = readFileSync("components/reports/ReportsExact.module.css", "utf8");
    expect(css).not.toContain("min-height: 100vh");
    expect(source).not.toContain("min-h-screen");
  });
});
