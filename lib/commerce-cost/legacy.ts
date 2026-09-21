import type {
  CommerceCostComponent,
  CommerceCostStructure,
  CostFamily,
  CostStructureConflict,
} from "@/src/types/commerce-cost";

/**
 * Importing what the product already stores.
 *
 * Two legacy places hold cost assumptions today: `business_cost_models`
 * (the percentages Overview, reports and the Google advisor actually cost
 * with) and `business_target_packs.cost_*` (the percentages Commercial Truth
 * displays). They can disagree, and nothing reconciles them.
 *
 * This importer preserves both, and states where it cannot:
 *  - Nothing is marked as observed. These are operator estimates.
 *  - Nothing claims to know what the percentages include, so `confirmed`
 *    stays false until the owner says.
 *  - A disagreement between the two sources is recorded as a conflict rather
 *    than resolved silently. The component that carries the value is the one
 *    the runtime costs with today, and it says so.
 *
 * What the runtime's base actually is, and where this import diverges from it
 * (traced through `app/api/overview-summary/route.ts:1049-1074` →
 * `lib/overview-service.ts:643-756` → `lib/shopify/warehouse-overview.ts:34-50`
 * / `lib/shopify/revenue-ledger.ts:92-234` → `lib/shopify/commerce-sync.ts:468-483`):
 *
 *  - Today every percentage multiplies ONE window figure: the Shopify order
 *    total including tax and shipping, after discounts, MINUS refunds — and
 *    those refunds are netted on the refund's own date, so a refund can
 *    reduce a window whose orders it does not belong to.
 *  - `order_total_incl_tax` is therefore the right family for the positive
 *    half and the closest member of `COST_BASES`, but no base expresses the
 *    refund netting: this contract handles refunds through `refundBehaviour`
 *    instead, which is deliberately not equivalent. An imported structure will
 *    NOT reproduce a window that contains refunds, and will read higher cost
 *    (payment fees never reverse; shipping reverses only on a cancel).
 *  - The underlying Shopify field differs by serving source: the ledger path
 *    sums `original_total_price`, the warehouse path `total_price`. A caller
 *    filling `order.bases.order_total_incl_tax` has to pick the one its own
 *    source used; `current_total_price` would double-count refunds.
 *  - The monthly fixed cost is imported as a period amount, which prorates.
 *    Today's Overview adds the full monthly figure to every window regardless
 *    of length, and again to every day of the trend line, so this import
 *    deliberately does not reproduce that arithmetic.
 *  - The figure is in the Shopify shop currency with no conversion anywhere in
 *    the Overview path, while the UI labels it with the business currency.
 *  - Other consumers apply the same percentages to different bases, so one
 *    component cannot reproduce them all: the GA4 fallback path substitutes
 *    GA4 `purchaseRevenue` (`lib/ga4-ecommerce-fallback.ts`), and the Google
 *    advisor multiplies per-product Google Ads `conversions_value`
 *    (`lib/google-ads/commerce-signals.ts:62`). Commercial Truth only displays
 *    the percentages.
 */

export interface LegacyCostPercentages {
  cogsPercent: number | null;
  shippingPercent: number | null;
  feePercent: number | null;
  fixedCost?: number | null;
  updatedAt?: string | null;
}

export interface LegacyTargetPackCostStructure {
  cogsPercent: number | null;
  shippingPercent: number | null;
  fulfillmentPercent: number | null;
  paymentProcessingPercent: number | null;
  updatedAt?: string | null;
}

export interface LegacyCostImportInput {
  businessId: string;
  reportingCurrency: string;
  /** Transaction time of the import. */
  recordedAt: string;
  /** Valid-time start. Earlier windows keep whatever they had. */
  effectiveFrom: string;
  /** `business_cost_models`: what the runtime costs with today. */
  costModel?: LegacyCostPercentages | null;
  /** `business_target_packs.cost_*`: what Commercial Truth displays. */
  targetPackCosts?: LegacyTargetPackCostStructure | null;
  structureVersion?: number;
}

/** The base the current Overview percentages are applied to. */
export const LEGACY_PERCENT_BASE = "order_total_incl_tax" as const;

interface PercentSpec {
  family: CostFamily;
  slot: string;
  label: string;
  fromCostModel: number | null | undefined;
  fromTargetPack: number | null | undefined;
}

function toPercent(value: number | string | null | undefined): number | null {
  // Legacy columns store unit intervals (0.35), not percentages — and a
  // Postgres NUMERIC arrives as a string through some drivers, so a numeric
  // string is the same fact, not a missing one.
  const numeric = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return null;
  return numeric * 100;
}

export function buildLegacyCostStructure(input: LegacyCostImportInput): CommerceCostStructure {
  const { businessId, reportingCurrency, recordedAt, effectiveFrom } = input;
  const costModel = input.costModel ?? null;
  const pack = input.targetPackCosts ?? null;

  const specs: PercentSpec[] = [
    {
      family: "product_purchase",
      slot: "legacy_cogs",
      label: "COGS (legacy estimate)",
      fromCostModel: costModel?.cogsPercent,
      fromTargetPack: pack?.cogsPercent,
    },
    {
      family: "outbound_shipping",
      slot: "legacy_shipping",
      label: "Shipping (legacy estimate)",
      fromCostModel: costModel?.shippingPercent,
      fromTargetPack: pack?.shippingPercent,
    },
    {
      family: "payment_processing",
      slot: "legacy_fees",
      label: "Payment fees (legacy estimate)",
      fromCostModel: costModel?.feePercent,
      fromTargetPack: pack?.paymentProcessingPercent,
    },
    {
      family: "fulfillment",
      slot: "legacy_fulfillment",
      label: "Fulfilment (legacy estimate)",
      // Only the target pack ever stored this one.
      fromCostModel: undefined,
      fromTargetPack: pack?.fulfillmentPercent,
    },
  ];

  // Kept as provenance only: the legacy row's own change time says nothing
  // about which window the percentage was true for.
  const legacyChangedAt = costModel?.updatedAt ?? pack?.updatedAt ?? null;
  const components: CommerceCostComponent[] = [];
  const conflicts: CostStructureConflict[] = [];
  const expectedFamilies: CostFamily[] = [];

  for (const spec of specs) {
    const modelPercent = toPercent(spec.fromCostModel);
    const packPercent = toPercent(spec.fromTargetPack);
    if (modelPercent === null && packPercent === null) continue;

    const disagrees =
      modelPercent !== null && packPercent !== null && Math.abs(modelPercent - packPercent) > 0.0001;
    if (disagrees) {
      conflicts.push({
        family: spec.family,
        slot: spec.slot,
        detail:
          "business_cost_models and business_target_packs hold different percentages. The cost model value is what the runtime uses today; confirm which is right.",
        candidates: [
          {
            source: { kind: "legacy_import", ref: "business_cost_models" },
            value: modelPercent,
            note: "used by Overview, reports and the Google advisor",
          },
          {
            source: { kind: "legacy_import", ref: "business_target_packs" },
            value: packPercent,
            note: "shown on Commercial Truth",
          },
        ],
      });
    }

    const percent = modelPercent ?? packPercent!;
    const ref = modelPercent !== null ? "business_cost_models" : "business_target_packs";
    expectedFamilies.push(spec.family);
    components.push({
      id: `legacy:${spec.slot}`,
      version: 1,
      family: spec.family,
      slot: spec.slot,
      label: spec.label,
      scope: [],
      basis: { kind: "percent_of_base", percent, base: LEGACY_PERCENT_BASE, allocation: "revenue" },
      currency: reportingCurrency,
      taxTreatment: "unknown",
      effectiveFrom,
      recordedAt,
      recognition: "on_order",
      evidence: "operator_estimate",
      source: { kind: "legacy_import", ref },
      status: "active",
      reason: disagrees ? "Legacy sources disagree; conflict recorded." : null,
      audit: {
        createdAt: recordedAt,
        note: `imported from ${ref}${legacyChangedAt ? `, last changed ${legacyChangedAt}` : ""}`,
      },
    });
  }

  const fixedAmount = costModel?.fixedCost;
  if (typeof fixedAmount === "number" && Number.isFinite(fixedAmount)) {
    expectedFamilies.push("overhead_fixed");
    components.push({
      id: "legacy:fixed_monthly",
      version: 1,
      family: "overhead_fixed",
      slot: "legacy_fixed_monthly",
      label: "Fixed monthly costs (legacy)",
      scope: [],
      // Monthly, so the window prorates it. The legacy Overview added the full
      // monthly amount to every window and to every day of the trend line.
      basis: { kind: "period_amount", amount: fixedAmount, period: "month", allocation: "revenue" },
      currency: reportingCurrency,
      taxTreatment: "unknown",
      effectiveFrom,
      recordedAt,
      recognition: "on_period",
      evidence: "operator_estimate",
      source: { kind: "legacy_import", ref: "business_cost_models.fixed_monthly_cost" },
      status: "active",
      audit: { createdAt: recordedAt, note: "imported from business_cost_models" },
    });
  }

  return {
    businessId,
    version: input.structureVersion ?? 0,
    origin: "legacy_import",
    // The percentages exist; what they include is unknown until confirmed.
    confirmed: false,
    reportingCurrency,
    effectiveFrom,
    recordedAt,
    components,
    expectedFamilies: [...new Set(expectedFamilies)],
    conflicts,
    note:
      "Imported legacy estimates. The percentages keep the order total including tax and shipping as their base, which is what the runtime multiplies today apart from its refund netting; no family composition is assumed, and the monthly fixed cost prorates here where the legacy Overview did not.",
  };
}

/**
 * Whether an imported structure still needs the owner before profit can be
 * called actual. Kept separate so callers do not re-implement the rule.
 */
export function legacyStructureNeedsConfirmation(structure: CommerceCostStructure): boolean {
  return (
    structure.origin === "legacy_import" ||
    !structure.confirmed ||
    (structure.conflicts?.length ?? 0) > 0
  );
}
