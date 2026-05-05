import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: () => React.createElement("button", { type: "button" }, "Date range"),
}));

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: () =>
    React.createElement("div", { "data-testid": "creative-render-surface-stub" }),
}));

const { CreativesTopSection } = await import("@/components/creatives/CreativesTopSection");

describe("CreativesTopSection", () => {
  it("renders the preserved toolbar and preview strip without decision support UI", () => {
    const html = renderToStaticMarkup(
      <CreativesTopSection
        businessId="business-1"
        showHeader={false}
        showGroupByControl={false}
        dateRange={{
          preset: "last14Days",
          customStart: "2026-04-10",
          customEnd: "2026-04-23",
          lastDays: 14,
          sinceDate: "2026-04-10",
        }}
        onDateRangeChange={vi.fn()}
        groupBy="creative"
        onGroupByChange={vi.fn()}
        filters={[]}
        onFiltersChange={vi.fn()}
        selectedMetricIds={["spend", "roas"]}
        onSelectedMetricIdsChange={vi.fn()}
        selectedRows={[]}
        allRowsForHeatmap={[]}
        filterBarSlot={<span>Engine chips</span>}
        defaultCurrency="USD"
        onOpenRow={vi.fn()}
        onShareExport={vi.fn()}
        onCsvExport={vi.fn()}
      />,
    );

    expect(html).toContain("Date range");
    expect(html).toContain("Add filter");
    expect(html.indexOf("Add filter")).toBeLessThan(html.indexOf("Engine chips"));
    expect(html.indexOf("Engine chips")).toBeLessThan(html.indexOf("Export"));
    expect(html).toContain("Select creatives in the table to populate this strip.");
    expect(html).not.toContain("Decision OS");
    expect(html).not.toContain("Decision Center");
    expect(html).not.toContain("Scale:");
  });
});
