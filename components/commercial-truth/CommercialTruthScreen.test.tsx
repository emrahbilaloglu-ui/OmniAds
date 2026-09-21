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
import type { CommerceCostStructure } from "@/src/types/commerce-cost";

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

const EMPTY_SHOPIFY_COST_CATALOG = {
  storage: { ready: true, missingTables: [] },
  connection: {
    connected: true,
    shopDomain: "store.myshopify.com",
    scopeReady: true,
    missingScopes: [],
  },
  summary: {
    totalVariants: 0,
    costedVariants: 0,
    missingCostVariants: 0,
    coveragePercent: null,
    currencyCounts: [],
    lastSyncedAt: null,
  },
  rows: [],
  matchedVariants: 0,
  limit: 50,
  offset: 0,
};

/** Every Meta row here is `budgetLevel: "adset"`, exactly as a demo seed is. */
const META_ROWS = [
  { id: "m1", name: "Prospecting — Broad US", budgetLevel: "adset", spend: 21900, revenue: 112128, roas: 5.12 },
  { id: "m2", name: "Retargeting 7d — DPA", budgetLevel: "adset", spend: 12300, revenue: 23862, roas: 1.94 },
];

const COST_REVISION = "b".repeat(64);
const EMPTY_COST_STRUCTURE: CommerceCostStructure = {
  businessId: "biz_1",
  version: 0,
  origin: "operator",
  confirmed: false,
  reportingCurrency: "USD",
  effectiveFrom: "2026-09-17T00:00:00.000Z",
  recordedAt: "2026-09-17T00:00:00.000Z",
  components: [],
};

beforeEach(() => {
  requested = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith("/api/business-commerce-cost-structure/shopify")) {
      return jsonResponse(EMPTY_SHOPIFY_COST_CATALOG);
    }
    if (url.startsWith("/api/business-commerce-cost-structure")) {
      return jsonResponse({
        structure: EMPTY_COST_STRUCTURE,
        source: "empty",
        revision: COST_REVISION,
        issues: [],
        permissions: { canEdit: true },
      });
    }
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

describe("CommercialTruthScreen versioned cost model", () => {
  let costStructureBodies: Array<Record<string, unknown>>;
  let legacyCostWrites: Array<Record<string, unknown>>;
  let packBodies: Array<Record<string, unknown>>;

  function installFetch(
    snapshot: BusinessCommercialTruthSnapshot,
    costResponse: Record<string, unknown> = {},
  ) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/business-commerce-cost-structure/shopify")) {
        return jsonResponse(EMPTY_SHOPIFY_COST_CATALOG);
      }
      if (url.startsWith("/api/business-commerce-cost-structure")) {
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          costStructureBodies.push(body);
          return jsonResponse({
            structure: body.structure,
            source: "stored",
            revision: "c".repeat(64),
            issues: [],
            permissions: { canEdit: true },
          });
        }
        return jsonResponse({
          structure: EMPTY_COST_STRUCTURE,
          source: "empty",
          revision: COST_REVISION,
          issues: [],
          permissions: { canEdit: true },
          ...costResponse,
        });
      }
      if (url.startsWith("/api/business-cost-model")) {
        legacyCostWrites.push(JSON.parse(String(init?.body ?? "{}")));
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
    costStructureBodies = [];
    legacyCostWrites = [];
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

  it("removes the four legacy cost inputs so there is one cost-editing path", async () => {
    await mount();

    expect(await screen.findByTestId("shopify-cost-source-panel")).toBeTruthy();
    expect(await screen.findByTestId("commerce-cost-model-editor")).toBeTruthy();
    expect(screen.queryByTestId("commercial-gross-margin")).toBeNull();
    expect(screen.queryByTestId("commercial-cost-shipping")).toBeNull();
    expect(screen.queryByTestId("commercial-cost-processing")).toBeNull();
    expect(screen.queryByTestId("commercial-fixed-costs")).toBeNull();
  });

  it("shows the cost model as a read-only preview while versioned storage is unavailable", async () => {
    installFetch(costSnapshot(true), {
      storage: {
        ready: false,
        missingTables: ["business_commerce_cost_structures"],
      },
      permissions: { canEdit: false },
    });

    await mount();

    expect(await screen.findByTestId("commerce-cost-model-editor")).toBeTruthy();
    expect(screen.getByText(/storage is not ready yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add cost" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save cost model" })).toBeDisabled();
  });

  it("keeps target-pack saves separate from the versioned cost model", async () => {
    await editAndSave("commercial-target-roas", "4.20");

    expect(packBodies).toHaveLength(1);
    expect(costStructureBodies).toHaveLength(0);
    expect(legacyCostWrites).toHaveLength(0);
  });

  it("writes a new component with the revision returned by GET", async () => {
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add cost" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Loaded product cost" } });
    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "42" } });
    const addButtons = screen.getAllByRole("button", { name: "Add cost" });
    fireEvent.click(addButtons[addButtons.length - 1]!);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save cost model" }));
    });

    expect(costStructureBodies).toHaveLength(1);
    expect(costStructureBodies[0]).toMatchObject({
      businessId: "biz_1",
      expectedRevision: COST_REVISION,
    });
    const saved = costStructureBodies[0]!.structure as CommerceCostStructure;
    expect(saved.components).toHaveLength(1);
    expect(saved.components[0]?.basis).toMatchObject({
      kind: "percent_of_base",
      percent: 42,
    });
    expect(legacyCostWrites).toHaveLength(0);
  });
});

describe("CommercialTruthScreen business isolation", () => {
  it("ignores a late cost-model response from the previously selected business", async () => {
    let resolveFirstCost!: (response: Response) => void;
    const firstCost = new Promise<Response>((resolve) => {
      resolveFirstCost = resolve;
    });
    const costFor = (businessId: string, label: string): CommerceCostStructure => ({
      ...EMPTY_COST_STRUCTURE,
      businessId,
      components: [
        {
          id: `cost-${businessId}`,
          version: 1,
          family: "product_purchase",
          slot: "default",
          label,
          scope: [],
          basis: { kind: "amount_per_unit", amount: 10 },
          currency: "USD",
          taxTreatment: "unknown",
          effectiveFrom: "2026-09-01T00:00:00.000Z",
          recordedAt: "2026-09-01T00:00:00.000Z",
          recognition: "on_order",
          refundBehaviour: "reverse_on_restock",
          evidence: "operator_estimate",
          source: { kind: "manual" },
          decisionClass: "contribution",
          status: "active",
        },
      ],
    });

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/business-commerce-cost-structure/shopify")) {
        return jsonResponse(EMPTY_SHOPIFY_COST_CATALOG);
      }
      if (url.startsWith("/api/business-commerce-cost-structure")) {
        if (url.includes("businessId=biz_1")) return firstCost;
        return jsonResponse({
          structure: costFor("biz_2", "Business two cost"),
          source: "stored",
          revision: "2".repeat(64),
          issues: [],
          permissions: { canEdit: true },
        });
      }
      if (url.startsWith("/api/business-commercial-settings/history")) {
        return jsonResponse({ entries: [] });
      }
      if (url.startsWith("/api/business-commercial-settings")) {
        const businessId = url.includes("businessId=biz_2") ? "biz_2" : "biz_1";
        return jsonResponse({
          snapshot: { ...costSnapshot(false), businessId },
          revision: REVISION,
          permissions: { canEdit: true },
        });
      }
      if (url.startsWith("/api/overview-summary")) {
        return jsonResponse({ summary: { pins: [] } });
      }
      return jsonResponse({ rows: [] });
    }) as unknown as typeof fetch;

    const view = render(React.createElement(CommercialTruthScreen, { businessId: "biz_1" }));
    await act(async () => {
      view.rerender(React.createElement(CommercialTruthScreen, { businessId: "biz_2" }));
    });

    expect(await screen.findByText("Business two cost")).toBeTruthy();

    await act(async () => {
      resolveFirstCost({
        ok: true,
        json: () =>
          Promise.resolve({
            structure: costFor("biz_1", "Late business one cost"),
            source: "stored",
            revision: "1".repeat(64),
            issues: [],
            permissions: { canEdit: true },
          }),
      } as Response);
      await Promise.resolve();
    });

    expect(screen.queryByText("Late business one cost")).toBeNull();
    expect(screen.getByText("Business two cost")).toBeTruthy();
  });
});
