import type {
  CommerceCostComponent,
  CommerceCostStructure,
  CostFamily,
  CostLineContext,
  CostOrderContext,
  CostResolutionEntry,
  CostResolutionRequest,
  CostResolutionResult,
} from "@/src/types/commerce-cost";
import { resolveOrderCosts } from "../resolver";

/**
 * Builders for cost-model tests.
 *
 * Defaults are the boring case — one store-wide per-unit product cost in the
 * reporting currency — so each test states only the thing it is about.
 */

export const REPORTING_CURRENCY = "TRY";

export function component(overrides: Partial<CommerceCostComponent> = {}): CommerceCostComponent {
  return {
    id: overrides.id ?? "component-1",
    version: 1,
    family: "product_purchase",
    slot: "default",
    scope: [],
    basis: { kind: "amount_per_unit", amount: 100 },
    currency: REPORTING_CURRENCY,
    taxTreatment: "net_of_recoverable_tax",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    recognition: "on_order",
    evidence: "contracted_rate",
    source: { kind: "manual" },
    status: "active",
    ...overrides,
  };
}

export function structure(overrides: Partial<CommerceCostStructure> = {}): CommerceCostStructure {
  return {
    businessId: "business-1",
    version: 1,
    origin: "operator",
    confirmed: true,
    reportingCurrency: REPORTING_CURRENCY,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    components: [component()],
    ...overrides,
  };
}

export function order(overrides: Partial<CostOrderContext> = {}): CostOrderContext {
  return {
    orderId: "order-1",
    occurredAt: "2026-09-10T09:00:00.000Z",
    occurredDate: "2026-09-10",
    currency: REPORTING_CURRENCY,
    bases: {
      order_net_product_sales: 1000,
      order_gross_product_sales: 1000,
      order_total_excl_tax: 1000,
      order_total_incl_tax: 1200,
      order_payment_captured: 1200,
      order_shipping_revenue: 0,
    },
    ...overrides,
  };
}

export function line(overrides: Partial<CostLineContext> = {}): CostLineContext {
  return {
    lineId: "line-1",
    quantity: 1,
    productId: "product-1",
    variantId: "variant-1",
    sku: "SKU-1",
    bases: { line_net_sales: 1000, line_gross_sales: 1000 },
    ...overrides,
  };
}

export function resolve(
  overrides: Partial<CostResolutionRequest> & { structure: CommerceCostStructure },
): CostResolutionResult {
  return resolveOrderCosts({
    order: order(),
    lines: [line()],
    reportingCurrency: REPORTING_CURRENCY,
    ...overrides,
  });
}

export function entryFor(
  result: CostResolutionResult,
  family: CostFamily,
  lineId = "line-1",
  slot?: string,
): CostResolutionEntry | undefined {
  return result.entries.find(
    (entry) =>
      entry.lineId === lineId &&
      entry.family === family &&
      (slot === undefined || entry.slot === slot),
  );
}

export function entriesFor(
  result: CostResolutionResult,
  family: CostFamily,
  lineId = "line-1",
): CostResolutionEntry[] {
  return result.entries.filter((entry) => entry.lineId === lineId && entry.family === family);
}

/** Total resolved cost for one line, the way the ladder would sum it. */
export function lineCost(result: CostResolutionResult, lineId = "line-1"): number {
  return result.entries
    .filter((entry) => entry.lineId === lineId && entry.amount !== null)
    .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
}
