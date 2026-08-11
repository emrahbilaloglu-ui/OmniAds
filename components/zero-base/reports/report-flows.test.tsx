// @vitest-environment jsdom

/**
 * WP-22 mounted report flows against the real route contracts.
 *
 * Two production defects these cover:
 *
 * - `ReportBuilderView` captured `initial` in `useState` once, while
 *   `ReportBuilderClient` loaded the record asynchronously. Every stored report
 *   opened as a blank canvas.
 * - the viewer keyed cards on a `dataSource` the rendered payload does not
 *   carry, so every widget shared the key `""` and all non-table content was
 *   dropped.
 *
 * Every fixture is typed against the producer's own types.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ReportBuilderClient, ReportViewerClient } from "@/components/zero-base/reports/report-clients";
import type { CustomReportDocument, RenderedReportPayload } from "@/lib/custom-reports";

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const REPORT = "rep-1";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

/** A stored document with configuration the builder does not model. */
const STORED: CustomReportDocument = {
  version: 1,
  dateRangePreset: "7",
  compareMode: "previous_period",
  reportPlatforms: ["meta"],
  widgets: [
    {
      id: "w1",
      type: "table",
      slot: 0,
      colSpan: 2,
      rowSpan: 2,
      title: "Top Meta Campaigns",
      dataSource: "meta_campaigns",
      accountId: "act_123",
      limit: 25,
      columns: ["name", "spend", "roas"],
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
      yMetrics: ["meta.spend"],
      breakdown: "week",
    },
  ],
};

/** Exactly what `/render` returns — note there is no `dataSource` anywhere. */
const RENDERED: { report: RenderedReportPayload } = {
  report: {
    businessId: BUSINESS,
    name: "Weekly review",
    dateRangeLabel: "Last 7 days",
    currency: "USD",
    generatedAt: "2026-08-11T09:00:00Z",
    widgets: [
      { id: "w1", slot: 0, colSpan: 2, rowSpan: 2, type: "table", title: "Top Meta Campaigns", rows: [{ name: "Brand" }], columns: ["name"] },
      { id: "w2", slot: 8, colSpan: 2, rowSpan: 2, type: "metric", title: "Spend", value: "980.00 USD", deltaLabel: "+3.2% vs previous" },
    ],
  },
};

function stubFetch(handler: (url: string, init?: RequestInit) => { ok?: boolean; body: unknown }) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = handler(String(input), init);
    return {
      ok: route.ok ?? true,
      status: route.ok === false ? 400 : 200,
      json: async () => route.body,
    } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("WP-22 builder edit route", () => {
  it("REGRESSION: a mounted edit route renders its stored widgets and name", async () => {
    stubFetch((url) => {
      if (url.startsWith(`/api/reports/${REPORT}`)) {
        return { body: { report: { id: REPORT, name: "Weekly review", definition: STORED } } };
      }
      throw new Error(`unstubbed: ${url}`);
    });

    render(<ReportBuilderClient businessId={BUSINESS} reportId={REPORT} />);

    // The canvas stayed permanently blank before the load gate was added.
    await waitFor(() => {
      expect(document.querySelector('[data-widget="w1"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-widget="w2"]')).not.toBeNull();
    expect((document.querySelector("[data-report-name]") as HTMLInputElement).value).toBe("Weekly review");
  });

  it("does not show an empty canvas while the record is still loading", () => {
    stubFetch(() => ({ body: new Promise(() => {}) }));
    render(<ReportBuilderClient businessId={BUSINESS} reportId={REPORT} />);
    // A blank builder is indistinguishable from a report with no widgets.
    expect(document.querySelector("[data-builder-canvas]")).toBeNull();
    expect(document.querySelector("[data-builder-loading]")).not.toBeNull();
  });

  it("refuses rather than presenting a blank canvas when the record cannot be read", async () => {
    stubFetch(() => ({ ok: false, body: {} }));
    render(<ReportBuilderClient businessId={BUSINESS} reportId={REPORT} />);
    await waitFor(() => {
      expect(document.querySelector("[data-report-error]")).not.toBeNull();
    });
    expect(document.querySelector("[data-builder-canvas]")).toBeNull();
  });

  it("REGRESSION: saving preserves stored fields the grid never modelled", async () => {
    let patched: CustomReportDocument | null = null;
    stubFetch((url, init) => {
      if (init?.method === "PATCH") {
        patched = (JSON.parse(String(init.body)) as { definition: CustomReportDocument }).definition;
        return { body: { report: {} } };
      }
      return { body: { report: { id: REPORT, name: "Weekly review", definition: STORED } } };
    });

    render(<ReportBuilderClient businessId={BUSINESS} reportId={REPORT} />);
    await waitFor(() => {
      expect(document.querySelector('[data-widget="w1"]')).not.toBeNull();
    });
    (document.querySelector("[data-builder-save]") as HTMLElement).click();

    await waitFor(() => expect(patched).not.toBeNull());
    const saved = patched as unknown as CustomReportDocument;
    const table = saved.widgets.find((widget) => widget.id === "w1");
    const trend = saved.widgets.find((widget) => widget.id === "w2");
    expect(table?.columns).toEqual(["name", "spend", "roas"]);
    expect(table?.accountId).toBe("act_123");
    expect(table?.limit).toBe(25);
    expect(trend?.yMetrics).toEqual(["meta.spend"]);
    expect(trend?.breakdown).toBe("week");
    expect(saved.dateRangePreset).toBe("7");
    expect(saved.compareMode).toBe("previous_period");
    expect(saved.reportPlatforms).toEqual(["meta"]);
  });
});

describe("WP-22 viewer renders the real rendered payload", () => {
  function stubViewer() {
    return stubFetch((url) => {
      if (url.includes("/render")) return { body: RENDERED };
      return { body: { report: { id: REPORT, definition: STORED } } };
    });
  }

  it("REGRESSION: renders each widget as its own type, keyed by widget id", async () => {
    stubViewer();
    render(<ReportViewerClient businessId={BUSINESS} reportId={REPORT} />);

    await waitFor(() => {
      expect(document.querySelector('[data-report-widget="w1"]')).not.toBeNull();
    });
    // Both cards present: keying on the absent dataSource collapsed them to one.
    expect(document.querySelectorAll("[data-report-widget]").length).toBe(2);
    // The metric renders its value, not an empty table.
    expect(document.querySelector('[data-widget-value="w2"]')!.textContent).toBe("980.00 USD");
    expect(document.querySelector('[data-report-widget="w2"] table')).toBeNull();
    // The table renders its rows.
    expect(document.querySelector('[data-report-widget="w1"] table')).not.toBeNull();
  });

  it("names the report and its period from the rendered payload", async () => {
    stubViewer();
    render(<ReportViewerClient businessId={BUSINESS} reportId={REPORT} />);
    await waitFor(() => expect(screen.getByText("Weekly review")).toBeTruthy());
    expect(document.querySelector("[data-report-range]")!.textContent).toMatch(/Last 7 days/);
  });

  it("offers CSV only where the stored definition says it is safe", async () => {
    stubViewer();
    render(<ReportViewerClient businessId={BUSINESS} reportId={REPORT} />);
    await waitFor(() => {
      expect(document.querySelector('[data-widget-csv="w1"]')).not.toBeNull();
    });
    // w2's stored source is overview_trend, which is not CSV-eligible.
    expect(document.querySelector('[data-widget-csv="w2"]')).toBeNull();
    expect(document.querySelector('[data-widget-csv-blocked="w2"]')).not.toBeNull();
  });

  it("print drops the share section and keeps every widget", async () => {
    stubViewer();
    render(<ReportViewerClient businessId={BUSINESS} reportId={REPORT} print />);
    await waitFor(() => {
      expect(document.querySelectorAll("[data-report-widget]").length).toBe(2);
    });
    expect(document.querySelector('[data-report-share="disabled"]')).toBeNull();
  });

  it("a failed render refuses instead of showing an empty report", async () => {
    stubFetch((url) => (url.includes("/render") ? { ok: false, body: {} } : { body: { report: {} } }));
    render(<ReportViewerClient businessId={BUSINESS} reportId={REPORT} />);
    await waitFor(() => {
      expect(document.querySelector("[data-report-unavailable]")).not.toBeNull();
    });
    expect(document.querySelectorAll("[data-report-widget]").length).toBe(0);
  });
});
