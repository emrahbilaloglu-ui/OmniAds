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
import { act, cleanup, render, screen } from "@testing-library/react";

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
