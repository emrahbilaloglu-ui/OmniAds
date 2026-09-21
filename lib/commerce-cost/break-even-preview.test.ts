import { describe, expect, it } from "vitest";

import {
  buildBreakEvenRoasPreview,
  type BreakEvenPreviewFacts,
} from "@/lib/commerce-cost/break-even-preview";
import { component, structure } from "@/lib/commerce-cost/__tests__/fixtures";
import { CONTRIBUTION_COST_FAMILIES } from "@/lib/commerce-cost/taxonomy";

const FACTS: BreakEvenPreviewFacts = {
  window: { startDate: "2026-08-25", endDate: "2026-09-21", days: 28 },
  reportingCurrency: "TRY",
  baseTotals: {
    line_net_sales: 100_000,
    order_net_product_sales: 100_000,
    line_gross_sales: 110_000,
    order_gross_product_sales: 110_000,
    order_total_excl_tax: 105_000,
    order_total_incl_tax: 126_000,
    order_shipping_revenue: 5_000,
  },
  orderCount: 1_000,
  unitCount: 2_000,
  lineCount: 1_500,
  currencyMismatchNetSales: 0,
  shopify: {
    available: true,
    unavailableReason: null,
    currentUnitCostTotal: 42_000,
    costedNetSales: 100_000,
    missingNetSales: 0,
    latestObservedAt: "2026-09-21T08:00:00.000Z",
  },
};

describe("break-even ROAS preview", () => {
  it("derives break-even from a stated variable-cost percentage without AOV", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        expectedFamilies: ["product_purchase"],
        components: [
          component({
            basis: { kind: "percent_of_base", percent: 60, base: "order_net_product_sales" },
          }),
        ],
      }),
      facts: FACTS,
    });

    expect(preview.status).toBe("ready");
    expect(preview.variableCostRate).toBe(0.6);
    expect(preview.contributionMarginRate).toBe(0.4);
    expect(preview.breakEvenRoas).toBe(2.5);
  });

  it("combines gross-margin product cost with a separate shipping rate", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        expectedFamilies: ["product_purchase", "outbound_shipping"],
        components: [
          component({
            id: "gross-margin",
            basis: {
              kind: "margin_input",
              marginKind: "gross",
              marginPercent: 60,
              base: "order_net_product_sales",
            },
          }),
          component({
            id: "shipping",
            family: "outbound_shipping",
            slot: "default",
            basis: { kind: "percent_of_base", percent: 10, base: "line_net_sales" },
          }),
        ],
      }),
      facts: FACTS,
    });

    expect(preview.status).toBe("ready");
    expect(preview.variableCostRate).toBe(0.5);
    expect(preview.breakEvenRoas).toBe(2);
  });

  it("treats a contribution-margin input as the complete variable-cost rate", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        expectedFamilies: [...CONTRIBUTION_COST_FAMILIES],
        components: [
          component({
            basis: {
              kind: "margin_input",
              marginKind: "contribution",
              marginPercent: 40,
              base: "line_net_sales",
            },
          }),
        ],
      }),
      facts: FACTS,
    });

    expect(preview.status).toBe("ready");
    expect(preview.variableCostRate).toBe(0.6);
    expect(preview.breakEvenRoas).toBe(2.5);
  });

  it("applies current Shopify catalog cost once to the recent sales mix", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        components: [],
        expectedFamilies: [...CONTRIBUTION_COST_FAMILIES],
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            meaning: "custom_composite",
            includedFamilies: [...CONTRIBUTION_COST_FAMILIES],
            minimumCoveragePercent: 100,
            missingCostPolicy: "leave_unknown",
            historicalPolicy: "unknown_before_first_observation",
          },
        },
      }),
      facts: FACTS,
    });

    expect(preview.status).toBe("ready");
    expect(preview.variableCostRate).toBe(0.42);
    expect(preview.breakEvenRoas).toBe(1.72);
    expect(preview.contributions).toHaveLength(1);
    expect(preview.assumptions.join(" ")).toMatch(/not historical COGS/i);
  });

  it("excludes fixed and informational costs from marginal break-even", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        expectedFamilies: ["product_purchase"],
        components: [
          component({
            basis: { kind: "percent_of_base", percent: 50, base: "line_net_sales" },
          }),
          component({
            id: "overhead",
            family: "overhead_fixed",
            slot: "rent",
            basis: { kind: "period_amount", amount: 1_000_000, period: "month", allocation: "revenue" },
            recognition: "on_period",
            decisionClass: "operating",
          }),
          component({
            id: "reference",
            family: "returns_loss",
            slot: "reference",
            basis: { kind: "percent_of_base", percent: 30, base: "line_net_sales" },
            decisionClass: "informational",
          }),
        ],
      }),
      facts: FACTS,
    });

    expect(preview.status).toBe("ready");
    expect(preview.variableCostRate).toBe(0.5);
    expect(preview.breakEvenRoas).toBe(2);
  });

  it("withholds the number when a required contribution family is absent", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        expectedFamilies: ["product_purchase", "payment_processing"],
        components: [
          component({
            basis: { kind: "percent_of_base", percent: 40, base: "line_net_sales" },
          }),
        ],
      }),
      facts: FACTS,
    });

    expect(preview.status).toBe("incomplete");
    expect(preview.breakEvenRoas).toBeNull();
    expect(preview.blockers.join(" ")).toMatch(/Payment processing/i);
  });

  it("labels the calculable part as a floor when Shopify sales-mix coverage is incomplete", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        components: [],
        expectedFamilies: ["product_purchase"],
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            meaning: "product_purchase_only",
            includedFamilies: ["product_purchase"],
            minimumCoveragePercent: 90,
            missingCostPolicy: "leave_unknown",
            historicalPolicy: "unknown_before_first_observation",
          },
        },
      }),
      facts: {
        ...FACTS,
        shopify: { ...FACTS.shopify, costedNetSales: 90_000, missingNetSales: 10_000 },
      },
    });

    expect(preview.status).toBe("provisional");
    expect(preview.breakEvenRoas).toBe(1.72);
    expect(preview.blockers.join(" ")).toMatch(/10000.00 TRY.*no compatible Shopify unit cost/i);
  });

  it("refuses a rate at or above all revenue", () => {
    const preview = buildBreakEvenRoasPreview({
      structure: structure({
        expectedFamilies: ["product_purchase"],
        components: [
          component({
            basis: { kind: "percent_of_base", percent: 100, base: "line_net_sales" },
          }),
        ],
      }),
      facts: FACTS,
    });

    expect(preview.status).toBe("invalid");
    expect(preview.breakEvenRoas).toBeNull();
  });
});
