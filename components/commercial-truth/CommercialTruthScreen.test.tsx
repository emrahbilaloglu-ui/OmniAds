// @vitest-environment jsdom

/**
 * What Commercial Truth actually asks its endpoints for.
 *
 * The screen labels three figures "28d". These assert the requests behind them
 * carry that window explicitly, rather than falling through to each route's
 * 30-day default, and that the campaign table's entity level is the entity the
 * row is rather than where its budget happens to sit.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  createEmptyTargetPack,
  type BusinessCommercialTruthSnapshot,
} from "@/src/types/business-commercial";

const mockAppState = {
  businesses: [
    {
      id: "biz_1",
      name: "Workspace One",
      currency: "USD",
      timezone: "UTC",
    },
  ],
};

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof mockAppState) => unknown) => selector(mockAppState),
}));

import { CommercialTruthScreen } from "@/components/commercial-truth/CommercialTruthScreen";

const originalFetch = globalThis.fetch;
let requested: string[] = [];

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

/** Every Meta row here is `budgetLevel: "adset"`, exactly as a demo seed is. */
const META_ROWS = [
  { id: "m1", name: "Prospecting — Broad US", budgetLevel: "adset", spend: 21900, revenue: 112128, roas: 5.12 },
  { id: "m2", name: "Retargeting 7d — DPA", budgetLevel: "adset", spend: 12300, revenue: 23862, roas: 1.94 },
];

beforeEach(() => {
  requested = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith("/api/meta/campaigns")) return jsonResponse({ rows: META_ROWS });
    if (url.startsWith("/api/google-ads/campaigns")) {
      return jsonResponse({
        rows: [{ id: "g1", name: "PMax — Evergreen", spend: 18940, revenue: 71214, roas: 3.76 }],
      });
    }
    if (url.startsWith("/api/overview-summary")) {
      return jsonResponse({
        summary: {
          pins: [
            { id: "pins-spend", value: 26000 },
            { id: "pins-revenue", value: 100000 },
          ],
        },
      });
    }
    return jsonResponse({ entries: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

async function mount() {
  await act(async () => {
    render(React.createElement(CommercialTruthScreen, { businessId: "biz_1" }));
  });
}

function urlFor(prefix: string): URL {
  const raw = requested.find((url) => url.startsWith(prefix));
  expect(raw, `no request to ${prefix}`).toBeTruthy();
  return new URL(raw as string, "http://localhost");
}

function inclusiveDays(start: string, end: string) {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
}

describe("CommercialTruthScreen windows", () => {
  it("asks Meta for the 28 days the 'Spend · 28d' header claims", async () => {
    await mount();
    const url = urlFor("/api/meta/campaigns");
    const start = url.searchParams.get("startDate")!;
    const end = url.searchParams.get("endDate")!;
    expect(start).toBeTruthy();
    expect(end).toBeTruthy();
    expect(inclusiveDays(start, end)).toBe(28);
  });

  it("asks Google for the same window as a custom range, since it has no 28 preset", async () => {
    await mount();
    const url = urlFor("/api/google-ads/campaigns");
    expect(url.searchParams.get("dateRange")).toBe("custom");
    const start = url.searchParams.get("customStart")!;
    const end = url.searchParams.get("customEnd")!;
    expect(inclusiveDays(start, end)).toBe(28);

    const meta = urlFor("/api/meta/campaigns");
    expect(start).toBe(meta.searchParams.get("startDate"));
    expect(end).toBe(meta.searchParams.get("endDate"));
  });

  it("asks the overview summary for 28 days, not the route's 30-day default", async () => {
    await mount();
    const url = urlFor("/api/overview-summary");
    const start = url.searchParams.get("startDate")!;
    const end = url.searchParams.get("endDate")!;
    expect(inclusiveDays(start, end)).toBe(28);
  });
});

describe("CommercialTruthScreen campaign level", () => {
  it("labels a Meta campaign row 'Campaign' even when its budget sits on the ad set", async () => {
    await mount();
    // Both readers serve campaign rows, so no row may claim to be an ad set.
    expect(await screen.findAllByText("Meta · Campaign")).toHaveLength(META_ROWS.length);
    expect(screen.queryByText(/Meta · Ad set/)).toBeNull();
    expect(await screen.findAllByText("Google · Campaign")).toHaveLength(1);
  });
});

/* --------------------------------------------------------------- cost model */

/**
 * `business_cost_models` is the table overview profit estimates, reports and
 * the Google advisor read cost from. Commercial Truth used to write it only
 * when the monthly fixed base was part of the same edit, so an edit to gross
 * margin, shipping or payment fees landed on the target pack alone — where this
 * screen's own reader prefers it, hiding the divergence — and left that table
 * costing at the stale percentages.
 *
 * The route takes all four columns at once, so each of these asserts the one
 * edited column changed and the other three went back at their stored values.
 */
const STORED_COSTS = {
  cogsPercent: 0.38,
  shippingPercent: 0.06,
  feePercent: 0.029,
  fixedCost: 12000,
};

const REVISION = "a".repeat(64);

function costSnapshot(packCosts: boolean): BusinessCommercialTruthSnapshot {
  return {
    businessId: "biz_1",
    targetPack: {
      ...createEmptyTargetPack(),
      targetRoas: 3.8,
      breakEvenRoas: 2.1,
      targetCpa: 24,
      aovAssumption: 58,
      costStructure: packCosts
        ? {
            cogsPercent: STORED_COSTS.cogsPercent,
            shippingPercent: STORED_COSTS.shippingPercent,
            fulfillmentPercent: null,
            paymentProcessingPercent: STORED_COSTS.feePercent,
          }
        : null,
    },
    costModelContext: { ...STORED_COSTS, updatedAt: null },
  } as unknown as BusinessCommercialTruthSnapshot;
}

describe("CommercialTruthScreen cost model writes", () => {
  let costModelBodies: Array<Record<string, unknown>>;
  let packBodies: Array<Record<string, unknown>>;

  function installFetch(snapshot: BusinessCommercialTruthSnapshot) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/business-cost-model")) {
        costModelBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return jsonResponse({ costModel: null });
      }
      if (url.startsWith("/api/business-commercial-settings/history")) {
        return jsonResponse({ entries: [] });
      }
      if (url.startsWith("/api/business-commercial-settings")) {
        if (method === "PUT") packBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return jsonResponse({
          snapshot,
          revision: REVISION,
          permissions: { canEdit: true },
        });
      }
      if (url.startsWith("/api/overview-summary")) {
        return jsonResponse({ summary: { pins: [] } });
      }
      return jsonResponse({ rows: [] });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    costModelBodies = [];
    packBodies = [];
    installFetch(costSnapshot(true));
  });

  async function editAndSave(testId: string, value: string) {
    await mount();
    fireEvent.change(screen.getByTestId(testId), { target: { value } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("commercial-settings-save"));
    });
  }

  it("writes COGS from a gross-margin-only edit and keeps the other three columns", async () => {
    await editAndSave("commercial-gross-margin", "60%");

    expect(costModelBodies).toHaveLength(1);
    const body = costModelBodies[0]!;
    expect(body.businessId).toBe("biz_1");
    // Gross margin 60% is COGS 40%; the screen stores the cost side.
    expect(body.cogsPercent as number).toBeCloseTo(0.4, 10);
    expect(body.shippingPercent).toBe(STORED_COSTS.shippingPercent);
    expect(body.feePercent).toBe(STORED_COSTS.feePercent);
    expect(body.fixedCost).toBe(STORED_COSTS.fixedCost);
    // The pack is still written in the same save — this adds a mirror, it does
    // not move where the target pack lives.
    expect(packBodies).toHaveLength(1);
  });

  it("writes shipping from a shipping-only edit and keeps the other three columns", async () => {
    await editAndSave("commercial-cost-shipping", "7%");

    expect(costModelBodies).toHaveLength(1);
    const body = costModelBodies[0]!;
    expect(body.shippingPercent as number).toBeCloseTo(0.07, 10);
    expect(body.cogsPercent).toBe(STORED_COSTS.cogsPercent);
    expect(body.feePercent).toBe(STORED_COSTS.feePercent);
    expect(body.fixedCost).toBe(STORED_COSTS.fixedCost);
  });

  it("writes payment fees from a fees-only edit and keeps the other three columns", async () => {
    await editAndSave("commercial-cost-processing", "3.5%");

    expect(costModelBodies).toHaveLength(1);
    const body = costModelBodies[0]!;
    expect(body.feePercent as number).toBeCloseTo(0.035, 10);
    expect(body.cogsPercent).toBe(STORED_COSTS.cogsPercent);
    expect(body.shippingPercent).toBe(STORED_COSTS.shippingPercent);
    expect(body.fixedCost).toBe(STORED_COSTS.fixedCost);
  });

  it("writes the monthly fixed base from a fixed-base-only edit and keeps the percentages", async () => {
    await editAndSave("commercial-fixed-costs", "14000");

    expect(costModelBodies).toHaveLength(1);
    const body = costModelBodies[0]!;
    expect(body.fixedCost).toBe(14000);
    expect(body.cogsPercent).toBe(STORED_COSTS.cogsPercent);
    expect(body.shippingPercent).toBe(STORED_COSTS.shippingPercent);
    expect(body.feePercent).toBe(STORED_COSTS.feePercent);
  });

  it("falls back to the stored cost model for untouched columns the pack does not override", async () => {
    installFetch(costSnapshot(false));
    await editAndSave("commercial-cost-shipping", "7%");

    expect(costModelBodies).toHaveLength(1);
    const body = costModelBodies[0]!;
    expect(body.shippingPercent as number).toBeCloseTo(0.07, 10);
    // The pack carries no override for these, so the live cost model supplies
    // them rather than the write blanking what the operator never touched.
    expect(body.cogsPercent).toBe(STORED_COSTS.cogsPercent);
    expect(body.feePercent).toBe(STORED_COSTS.feePercent);
    expect(body.fixedCost).toBe(STORED_COSTS.fixedCost);
  });

  it("leaves the cost model alone when the edit touches no cost field", async () => {
    await editAndSave("commercial-target-roas", "4.20");

    expect(packBodies).toHaveLength(1);
    expect(costModelBodies).toHaveLength(0);
  });
});
