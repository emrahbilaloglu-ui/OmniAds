// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShopifyCostSourcePanel } from "@/components/commercial-truth/ShopifyCostSourcePanel";
import type { CommerceCostComponent, CommerceCostStructure } from "@/src/types/commerce-cost";

const NOW = "2026-09-18T00:00:00.000Z";
const originalFetch = globalThis.fetch;

function component(overrides: Partial<CommerceCostComponent> = {}): CommerceCostComponent {
  return {
    id: "manual-cogs",
    version: 1,
    family: "product_purchase",
    slot: "default",
    label: "Manual COGS rate",
    scope: [],
    basis: { kind: "percent_of_base", percent: 42, base: "order_net_product_sales" },
    currency: "USD",
    taxTreatment: "unknown",
    effectiveFrom: NOW,
    recordedAt: NOW,
    recognition: "on_order",
    refundBehaviour: "reverse_on_restock",
    evidence: "operator_estimate",
    source: { kind: "manual" },
    status: "active",
    ...overrides,
  };
}

function structure(overrides: Partial<CommerceCostStructure> = {}): CommerceCostStructure {
  return {
    businessId: "biz-1",
    version: 1,
    origin: "operator",
    confirmed: true,
    reportingCurrency: "USD",
    effectiveFrom: NOW,
    recordedAt: NOW,
    components: [],
    ...overrides,
  };
}

function renderPanel(costStructure: CommerceCostStructure) {
  const onChange = vi.fn();
  const onCatalogSynced = vi.fn();
  render(
    <ShopifyCostSourcePanel
      businessId="biz-1"
      structure={costStructure}
      canEdit
      saving={false}
      onChange={onChange}
      onCatalogSynced={onCatalogSynced}
    />,
  );
  return { onChange, onCatalogSynced };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      storage: { ready: true, missingTables: [] },
      connection: { connected: true, scopeReady: true, shopDomain: "store.myshopify.com" },
      summary: {
        totalVariants: 100,
        costedVariants: 97,
        missingCostVariants: 3,
        coveragePercent: 97,
        currencyCounts: [{ currencyCode: "USD", count: 97 }],
        lastSyncedAt: NOW,
      },
      rows: [
        {
          productId: "product-1",
          variantId: "variant-1",
          inventoryItemId: "inventory-1",
          sku: "SKU-1",
          productTitle: "Sample product",
          variantTitle: "Default variant",
          unitCost: "12.50",
          currencyCode: "USD",
          sourceUpdatedAt: NOW,
          observedAt: NOW,
        },
      ],
      matchedVariants: 100,
      limit: 50,
      offset: 0,
    }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("ShopifyCostSourcePanel source policy", () => {
  it("signals a completed catalog sync so the break-even preview can refresh", async () => {
    const user = userEvent.setup();
    const { onCatalogSynced } = renderPanel(structure());

    await screen.findByText("Shopify connected");
    await user.click(screen.getByRole("button", { name: /Sync from Shopify/i }));

    await waitFor(() => expect(onCatalogSynced).toHaveBeenCalledTimes(1));
  });

  it("keeps product rows collapsed until the catalog is opened", async () => {
    const user = userEvent.setup();
    renderPanel(structure());

    await screen.findByText("Shopify connected");
    const toggle = screen.getByRole("button", { name: /Products and variants/i });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Sample product")).toBeNull();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Sample product")).toBeTruthy();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps every readiness signal unresolved until a source authority is chosen", async () => {
    renderPanel(structure());

    await screen.findByText("Shopify connected");
    expect(screen.getByText("Not selected")).toBeTruthy();
    expect(screen.getByText("Waiting for authority")).toBeTruthy();
  });

  it("stores an explicit manual authority for percentage, margin, BOM or scoped models", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel(structure());

    await user.click(screen.getByRole("radio", { name: /Use Adsecute cost rules/i }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmed: false,
        sourcePolicy: { productCostAuthority: "manual_components" },
      }),
    );
  });

  it("captures loaded Shopify composition instead of assuming unit cost is product-only", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel(
      structure({
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            meaning: "product_purchase_only",
            includedFamilies: ["product_purchase"],
            minimumCoveragePercent: 95,
            missingCostPolicy: "leave_unknown",
            historicalPolicy: "unknown_before_first_observation",
          },
        },
      }),
    );

    await screen.findByText("Shopify connected");
    await user.selectOptions(
      screen.getByRole("combobox", { name: /What is included in Shopify/i }),
      "loaded_variable_cost",
    );

    const next = onChange.mock.calls[0]?.[0] as CommerceCostStructure;
    expect(next.confirmed).toBe(false);
    expect(next.sourcePolicy?.shopifyUnitCost).toMatchObject({
      meaning: "loaded_variable_cost",
      includedFamilies: expect.arrayContaining([
        "product_purchase",
        "inbound_logistics",
        "packaging",
        "payment_processing",
        "returns_loss",
      ]),
    });
  });

  it("binds hybrid missing variants to one explicit manual fallback", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel(
      structure({
        components: [component()],
        sourcePolicy: {
          productCostAuthority: "hybrid",
          shopifyUnitCost: {
            meaning: "product_purchase_only",
            includedFamilies: ["product_purchase"],
            minimumCoveragePercent: 100,
            missingCostPolicy: "leave_unknown",
            historicalPolicy: "unknown_before_first_observation",
          },
        },
      }),
    );

    await screen.findByText("Shopify connected");
    await user.click(screen.getByRole("button", { name: /Coverage and older orders/i }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Products with no Shopify cost/i }),
      "manual_fallback",
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePolicy: expect.objectContaining({
          productCostAuthority: "hybrid",
          shopifyUnitCost: expect.objectContaining({
            missingCostPolicy: "manual_fallback",
            fallbackComponentId: "manual-cogs",
          }),
        }),
      }),
    );
  });

  it("blocks saving when Shopify and a direct component both own the same cost", async () => {
    renderPanel(
      structure({
        components: [component()],
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            meaning: "product_purchase_only",
            includedFamilies: ["product_purchase"],
            minimumCoveragePercent: 95,
            missingCostPolicy: "leave_unknown",
            historicalPolicy: "unknown_before_first_observation",
          },
        },
      }),
    );

    expect(screen.getByText(/Product purchase also configured directly/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save setup" })).toBeNull();
    expect(screen.getByText(/Saved with the cost model below/i)).toBeTruthy();
  });

  it("explains Shopify product cost in a keyboard and touch accessible tooltip", async () => {
    const user = userEvent.setup();
    renderPanel(
      structure({
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            meaning: "product_purchase_only",
            includedFamilies: ["product_purchase"],
            minimumCoveragePercent: 100,
            missingCostPolicy: "leave_unknown",
            historicalPolicy: "unknown_before_first_observation",
          },
        },
      }),
    );

    const help = screen.getByRole("button", { name: "Explain Shopify Cost per item" });
    await user.click(help);

    expect(screen.getByRole("tooltip")).toHaveTextContent(/stored on each Shopify product or variant/i);
    expect(help).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(help).toHaveAttribute("aria-expanded", "false");
  });

  it("puts an invalid fallback beside a safe one-click correction", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPanel(
      structure({
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            meaning: "product_purchase_only",
            includedFamilies: ["product_purchase"],
            minimumCoveragePercent: 100,
            missingCostPolicy: "manual_fallback",
            fallbackComponentId: null,
            historicalPolicy: "unknown_before_first_observation",
          },
        },
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/Fallback cannot be used yet/i);
    await user.click(screen.getByRole("button", { name: "Keep missing costs unknown" }));

    const next = onChange.mock.calls.at(-1)?.[0] as CommerceCostStructure;
    expect(next.sourcePolicy?.shopifyUnitCost).toMatchObject({
      missingCostPolicy: "leave_unknown",
      fallbackComponentId: null,
    });
  });
});
