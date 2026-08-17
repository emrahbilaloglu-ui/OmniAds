import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two v2 block kinds the renderer builds: the KPI row and the share
 * donut. Both read the blended summary the rest of the report already reads,
 * which is what stops a strip and a table on one page from disagreeing.
 */
const summary = vi.hoisted(() => ({
  payload: {
    pins: [
      { id: "spend", title: "Spend", value: 118220, changePct: 8.1 },
      { id: "revenue", title: "Revenue", value: 483900, changePct: 4.2 },
      { id: "roas", title: "MER", value: 4.09, changePct: 3.6 },
      { id: "purchases", title: "Orders", value: null, changePct: null },
    ] as Array<{ id: string; title: string; value: number | null; changePct: number | null }>,
    attribution: [
      { channel: "Meta", spend: 60, revenue: 300 },
      { channel: "Google", spend: 30, revenue: 150 },
      { channel: "Email", spend: 10, revenue: 50 },
    ] as Array<Record<string, unknown>>,
  },
}));

const { renderCustomReport } = await import("@/lib/custom-report-renderer");

function request() {
  return new NextRequest("https://app.example/api/reports/render");
}

function widget(overrides: Record<string, unknown>) {
  return {
    id: "w1",
    slot: 0,
    colSpan: 4,
    rowSpan: 1,
    title: "Block",
    ...overrides,
  } as never;
}

beforeEach(() => {
  // Under vitest the renderer reaches its sources over HTTP, so the source of
  // truth for this test is the overview-summary response itself.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/overview-summary")) {
        return new Response(JSON.stringify(summary.payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  summary.payload = {
    pins: [
      { id: "spend", title: "Spend", value: 118220, changePct: 8.1 },
      { id: "revenue", title: "Revenue", value: 483900, changePct: 4.2 },
      { id: "roas", title: "MER", value: 4.09, changePct: 3.6 },
      { id: "purchases", title: "Orders", value: null, changePct: null },
    ],
    attribution: [
      { channel: "Meta", spend: 60, revenue: 300 },
      { channel: "Google", spend: 30, revenue: 150 },
      { channel: "Email", spend: 10, revenue: 50 },
    ],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderOne(definitionWidget: unknown) {
  const payload = await renderCustomReport({
    request: request(),
    businessId: "biz",
    name: "Report",
    definition: {
      version: 1,
      dateRangePreset: "28",
      compareMode: "previous_period",
      widgets: [definitionWidget as never],
    },
    currency: "USD",
  });
  return payload.widgets[0];
}

describe("KPI row", () => {
  it("carries four figures from the blended summary", async () => {
    const rendered = await renderOne(widget({ type: "kpirow", dataSource: "overview_summary" }));
    expect(rendered.metrics?.map((metric) => metric.label)).toEqual([
      "Spend",
      "Revenue",
      "MER",
      "Orders",
    ]);
    expect(rendered.metrics?.[0].value).toContain("118,220");
  });

  it("dashes a figure the summary did not measure instead of printing zero", async () => {
    const rendered = await renderOne(widget({ type: "kpirow", dataSource: "overview_summary" }));
    expect(rendered.metrics?.[3].value).toBe("—");
  });

  it("says the period is empty when nothing at all was measured", async () => {
    summary.payload.pins = [];
    const rendered = await renderOne(widget({ type: "kpirow", dataSource: "overview_summary" }));
    expect(rendered.metrics?.every((metric) => metric.value === "—")).toBe(true);
    expect(rendered.emptyMessage).toBe("No blended figures for this period yet.");
  });
});

describe("share donut", () => {
  it("splits revenue by channel, largest first, from the attribution rows", async () => {
    const rendered = await renderOne(
      widget({ type: "donut", dataSource: "channel_attribution", metricKey: "revenue" }),
    );
    expect(rendered.slices?.map((slice) => slice.label)).toEqual(["Meta", "Google", "Email"]);
    expect(rendered.slices?.map((slice) => Math.round(slice.sharePct))).toEqual([60, 30, 10]);
  });

  it("splits by spend when the block asks for spend", async () => {
    const rendered = await renderOne(
      widget({ type: "donut", dataSource: "channel_attribution", metricKey: "spend" }),
    );
    expect(rendered.slices?.map((slice) => Math.round(slice.sharePct))).toEqual([60, 30, 10]);
  });

  it("reports no split rather than an empty ring when nothing is attributed", async () => {
    summary.payload.attribution = [];
    const rendered = await renderOne(
      widget({ type: "donut", dataSource: "channel_attribution", metricKey: "revenue" }),
    );
    expect(rendered.slices).toEqual([]);
    expect(rendered.emptyMessage).toBe("No channel split for this period yet.");
  });
});
