import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => new Proxy({}, { get: () => () => null }));

import { ReportWidgetCard } from "@/components/reports/report-canvas";
import type { RenderedReportWidget } from "@/lib/custom-reports";

function widget(overrides: Partial<RenderedReportWidget>): RenderedReportWidget {
  return {
    id: "w1",
    slot: 0,
    colSpan: 1,
    rowSpan: 1,
    type: "table",
    title: "Campaign performance",
    ...overrides,
  } as RenderedReportWidget;
}

function render(w: RenderedReportWidget) {
  return renderToStaticMarkup(<ReportWidgetCard widget={w} />);
}

describe("a report widget that failed does not look empty", () => {
  it("labels a failed widget as failed, not as a warning", () => {
    const html = render(
      widget({ errorMessage: "Upstream request failed.", retryable: true }),
    );
    expect(html).toContain("Failed to load");
    expect(html).toContain("Upstream request failed.");
  });

  it("does not present a failure through the empty-state voice", () => {
    const html = render(
      widget({
        errorMessage: "Upstream request failed.",
        emptyMessage: "No rows for this period.",
      }),
    );
    expect(html).not.toContain("No rows for this period.");
  });

  it("still shows a genuine empty period as empty", () => {
    const html = render(widget({ emptyMessage: "No rows for this period." }));
    expect(html).toContain("No rows for this period.");
    expect(html).not.toContain("Failed to load");
  });

  it("keeps warnings distinct from failures", () => {
    const html = render(widget({ warning: "Partial permissions." }));
    expect(html).toContain("Warning");
    expect(html).toContain("Partial permissions.");
    expect(html).not.toContain("Failed to load");
  });
});
