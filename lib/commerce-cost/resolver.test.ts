import { describe, expect, it } from "vitest";

import type { CostFamily, CostLineContext } from "@/src/types/commerce-cost";
import { resolveOrderCosts } from "./resolver";
import { REPORTING_CURRENCY, component, entriesFor, entryFor, line, lineCost, order, resolve, structure } from "./__tests__/fixtures";

/**
 * The scenario matrix.
 *
 * Every case here is a real way an e-commerce business states its costs. The
 * assertions are about the two things that decide whether a profit number can
 * be trusted: exactly one owner per cost, and a stated gap wherever the truth
 * is missing.
 */

describe("resolver: how a cost is stated", () => {
  it("takes a per-unit product cost, the plain Shopify cost-per-item case", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            evidence: "classified_attribute",
            source: { kind: "shopify_unit_cost", ref: "inventory_item/1" },
            basis: { kind: "amount_per_unit", amount: 120 },
          }),
        ],
      }),
      lines: [line({ quantity: 3 })],
    });

    const entry = entryFor(result, "product_purchase");
    expect(entry?.state).toBe("value");
    expect(entry?.amount).toBe(360);
    expect(entry?.estimated).toBe(false);
    expect(entry?.evidence).toBe("classified_attribute");
  });

  it("takes a landed cost as one component that declares what it contains", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            basis: { kind: "amount_per_unit", amount: 150 },
            embeds: ["inbound_logistics", "duties_import"],
          }),
        ],
      }),
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(150);
    for (const family of ["inbound_logistics", "duties_import"] as CostFamily[]) {
      const embedded = entryFor(result, family);
      expect(embedded?.state).toBe("embedded");
      expect(embedded?.amount).toBeNull();
      expect(embedded?.shadowedBy?.componentId).toBe("component-1");
    }
    // The landed cost is counted once, not once per family it covers.
    expect(lineCost(result)).toBe(150);
  });

  it("takes a fully loaded percentage cost without double counting what it embeds", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            id: "loaded",
            basis: { kind: "percent_of_base", percent: 60, base: "line_net_sales" },
            embeds: ["outbound_shipping", "payment_processing", "packaging"],
            evidence: "operator_estimate",
          }),
          // A separate shipping rule exists but the loaded cost already owns it.
          component({
            id: "shipping",
            family: "outbound_shipping",
            basis: { kind: "amount_per_order", amount: 90, allocation: "revenue" },
          }),
        ],
      }),
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(600);
    const shipping = entryFor(result, "outbound_shipping");
    expect(shipping?.state).toBe("embedded");
    expect(shipping?.reasons).toContain("shadowed:shipping");
    expect(lineCost(result)).toBe(600);
    // A loaded cost that rests on a stated ratio is an estimate, and says so.
    expect(entryFor(result, "product_purchase")?.estimated).toBe(true);
  });

  it("lets a direct cost replace an embedded share only when that share is subtractable", () => {
    const withShare = resolve({
      structure: structure({
        components: [
          component({
            id: "loaded",
            basis: { kind: "amount_per_unit", amount: 600 },
            embeds: ["outbound_shipping"],
            embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          }),
          component({
            id: "measured-shipping",
            family: "outbound_shipping",
            replacesEmbedded: true,
            evidence: "observed_exact",
            source: { kind: "carrier_invoice", ref: "label-9" },
            basis: { kind: "amount_per_line", amount: 72 },
          }),
        ],
      }),
    });

    expect(entryFor(withShare, "outbound_shipping")?.amount).toBe(72);
    expect(entryFor(withShare, "outbound_shipping")?.reasons).toContain("replaced_embedded_share");
    // The host gives up exactly the share it declared: 600 − 50.
    expect(entryFor(withShare, "product_purchase")?.amount).toBe(550);
    expect(entryFor(withShare, "product_purchase")?.hostShareRemoved).toBe(50);
    expect(lineCost(withShare)).toBe(622);

    const withoutShare = resolve({
      structure: structure({
        components: [
          component({ id: "loaded", basis: { kind: "amount_per_unit", amount: 600 }, embeds: ["outbound_shipping"] }),
          component({
            id: "measured-shipping",
            family: "outbound_shipping",
            replacesEmbedded: true,
            evidence: "observed_exact",
            source: { kind: "carrier_invoice" },
            basis: { kind: "amount_per_line", amount: 72 },
          }),
        ],
      }),
    });

    // Without a stated share the host cannot be reduced, so the measured cost
    // is refused rather than added on top of the money already inside it.
    const shipping = entryFor(withoutShare, "outbound_shipping");
    expect(shipping?.state).toBe("embedded");
    expect(shipping?.reasons).toContain("embedded_share_unknown_replacement_rejected");
    expect(lineCost(withoutShare)).toBe(600);
  });

  it("subtracts an embedded replacement share once per line", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            id: "loaded",
            basis: { kind: "amount_per_unit", amount: 600 },
            embeds: ["outbound_shipping"],
            embeddedShares: [
              { family: "outbound_shipping", kind: "amount_per_unit", value: 50 },
            ],
          }),
          component({
            id: "measured-shipping",
            family: "outbound_shipping",
            replacesEmbedded: true,
            evidence: "observed_exact",
            source: { kind: "carrier_invoice" },
            basis: { kind: "amount_per_line", amount: 72 },
          }),
        ],
      }),
      order: order(),
      lines: [
        line({ lineId: "line-a", quantity: 1 }),
        line({ lineId: "line-b", quantity: 2 }),
      ],
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(entryFor(result, "product_purchase", "line-a")).toMatchObject({
      amount: 550,
      hostShareRemoved: 50,
    });
    expect(entryFor(result, "product_purchase", "line-b")).toMatchObject({
      amount: 1100,
      hostShareRemoved: 100,
    });
    expect(lineCost(result, "line-a")).toBe(622);
    expect(lineCost(result, "line-b")).toBe(1172);
  });

  it("implies every family a stated contribution margin covers", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            basis: { kind: "margin_input", marginKind: "contribution", marginPercent: 40, base: "line_net_sales" },
          }),
        ],
      }),
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(600);
    expect(entryFor(result, "outbound_shipping")?.state).toBe("embedded");
    expect(entryFor(result, "payment_processing")?.state).toBe("embedded");
    expect(lineCost(result)).toBe(600);
  });
});

describe("resolver: how a cost is shaped", () => {
  const twoLines: CostLineContext[] = [
    line({ lineId: "line-a", quantity: 1, sku: "SKU-A", variantId: "variant-a", bases: { line_net_sales: 700 }, weightKg: 3 }),
    line({ lineId: "line-b", quantity: 2, sku: "SKU-B", variantId: "variant-b", bases: { line_net_sales: 300 }, weightKg: 1 }),
  ];

  it("spreads a per-order cost across lines and loses nothing in the rounding", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            family: "outbound_shipping",
            basis: { kind: "amount_per_order", amount: 100.01, allocation: "revenue" },
          }),
        ],
      }),
      order: order(),
      lines: twoLines,
      reportingCurrency: REPORTING_CURRENCY,
    });

    const shipping = result.entries.filter((entry) => entry.family === "outbound_shipping");
    const total = shipping.reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
    expect(total).toBeCloseTo(100.01, 10);
    expect(shipping.map((entry) => entry.amount)).toEqual([70.01, 30]);
    expect(shipping[0]?.allocation).toMatchObject({ driver: "revenue", orderAmount: 100.01 });
  });

  it("charges a per-item cost by quantity and a weight-and-zone table by band", () => {
    const perItem = resolveOrderCosts({
      structure: structure({
        components: [
          component({ family: "packaging", basis: { kind: "amount_per_unit", amount: 4 } }),
        ],
      }),
      order: order(),
      lines: twoLines,
      reportingCurrency: REPORTING_CURRENCY,
    });
    expect(entryFor(perItem, "packaging", "line-b")?.amount).toBe(8);

    const zoned = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            family: "outbound_shipping",
            basis: {
              kind: "rate_table",
              level: "order",
              allocation: "weight",
              rows: [
                { when: [{ dimension: "market", operator: "in", values: ["TR"] }], weightMaxKg: 5, amount: 40 },
                { when: [{ dimension: "market", operator: "in", values: ["TR"] }], amount: 90 },
                { when: [{ dimension: "market", operator: "in", values: ["DE"] }], amount: 250 },
              ],
            },
          }),
        ],
      }),
      order: order({ dimensions: { market: ["TR"] }, weightKg: 4 }),
      lines: twoLines,
      reportingCurrency: REPORTING_CURRENCY,
    });

    const zonedTotal = zoned.entries
      .filter((entry) => entry.family === "outbound_shipping")
      .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
    expect(zonedTotal).toBe(40);
  });

  it("charges a payment fee as a percentage plus a fixed amount of what was captured", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            family: "payment_processing",
            basis: {
              kind: "percent_plus_fixed",
              percent: 2.9,
              base: "order_payment_captured",
              fixedAmount: 0.25,
              allocation: "revenue",
            },
            scope: [{ dimension: "payment_method", operator: "in", values: ["card"] }],
          }),
        ],
      }),
      order: order({ dimensions: { payment_method: ["card"] }, bases: { order_payment_captured: 1200 } }),
      lines: twoLines,
      reportingCurrency: REPORTING_CURRENCY,
    });

    const total = result.entries
      .filter((entry) => entry.family === "payment_processing")
      .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
    expect(total).toBeCloseTo(35.05, 10);
  });

  it("charges the fixed part once when a line-based percentage spans several lines", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            family: "payment_processing",
            basis: {
              kind: "percent_plus_fixed",
              percent: 2,
              base: "line_net_sales",
              fixedAmount: 3,
              fixedPer: "order",
              allocation: "revenue",
            },
          }),
        ],
      }),
      order: order(),
      lines: [
        line({ lineId: "a", bases: { line_net_sales: 600, line_gross_sales: 600 } }),
        line({ lineId: "b", bases: { line_net_sales: 400, line_gross_sales: 400 } }),
      ],
      reportingCurrency: REPORTING_CURRENCY,
    });

    const total = result.entries
      .filter((entry) => entry.family === "payment_processing")
      .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
    expect(total).toBe(23);
  });

  it("charges an order-base fixed part per unit when requested", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            family: "payment_processing",
            basis: {
              kind: "percent_plus_fixed",
              percent: 2,
              base: "order_payment_captured",
              fixedAmount: 1.5,
              fixedPer: "unit",
              allocation: "units",
            },
          }),
        ],
      }),
      order: order({ bases: { order_payment_captured: 1000 } }),
      lines: [line({ lineId: "a", quantity: 2 }), line({ lineId: "b", quantity: 3 })],
      reportingCurrency: REPORTING_CURRENCY,
    });

    const total = result.entries
      .filter((entry) => entry.family === "payment_processing")
      .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
    expect(total).toBe(27.5);
  });

  it("prices a bundle from its recipe and applies waste", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            id: "kit",
            scope: [{ dimension: "sku", operator: "in", values: ["KIT-1"] }],
            basis: {
              kind: "bom",
              wastePercent: 10,
              components: [
                { sku: "PART-A", quantity: 2 },
                { sku: "PART-B", quantity: 1, amount: 30 },
              ],
            },
          }),
          component({
            id: "part-a",
            scope: [{ dimension: "sku", operator: "in", values: ["PART-A"] }],
            basis: { kind: "amount_per_unit", amount: 25 },
          }),
        ],
      }),
      lines: [line({ sku: "KIT-1", quantity: 2 })],
    });

    // (2 × 25 + 30) × 1.10 × 2 units
    expect(entryFor(result, "product_purchase")?.amount).toBe(176);
  });

  it("never substitutes inbound freight for a BOM ingredient purchase cost", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            id: "kit",
            scope: [{ dimension: "sku", operator: "in", values: ["KIT"] }],
            basis: { kind: "bom", components: [{ sku: "PART", quantity: 1 }] },
          }),
          component({
            id: "part-purchase",
            scope: [{ dimension: "sku", operator: "in", values: ["PART"] }],
            basis: { kind: "amount_per_unit", amount: 10 },
          }),
          component({
            id: "part-freight",
            family: "inbound_logistics",
            evidence: "observed_exact",
            scope: [{ dimension: "sku", operator: "in", values: ["PART"] }],
            basis: { kind: "amount_per_unit", amount: 1 },
          }),
        ],
      }),
      lines: [line({ sku: "KIT", quantity: 1 })],
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(10);
  });

  it("converts a stated BOM amount from the host currency", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            id: "kit-usd",
            currency: "USD",
            fx: { policy: "fixed_rate", fixedRate: 30 },
            basis: { kind: "bom", components: [{ sku: "PART", quantity: 2, amount: 20 }] },
          }),
        ],
      }),
      lines: [line({ quantity: 1 })],
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(1200);
  });

  it("keeps a recurring cost out of every per-order number", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({ id: "rent", family: "overhead_fixed", recognition: "on_period", basis: { kind: "period_amount", amount: 30000, period: "month", allocation: "revenue" } }),
          component({ id: "product", basis: { kind: "amount_per_unit", amount: 100 } }),
        ],
      }),
    });

    expect(result.deferredPeriodComponentIds).toEqual(["rent"]);
    expect(result.entries.some((entry) => entry.family === "overhead_fixed" && entry.amount !== null)).toBe(false);
    expect(lineCost(result)).toBe(100);
  });
});

describe("resolver: which cost applies where", () => {
  it("prefers the narrower scope at equal evidence", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({ id: "store-wide", basis: { kind: "amount_per_unit", amount: 100 } }),
          component({
            id: "sku-specific",
            scope: [{ dimension: "sku", operator: "in", values: ["SKU-1"] }],
            basis: { kind: "amount_per_unit", amount: 140 },
          }),
        ],
      }),
    });

    const entry = entryFor(result, "product_purchase");
    expect(entry?.ownerComponentId).toBe("sku-specific");
    expect(entry?.amount).toBe(140);
    expect(entry?.reasons).toContain("outranked:store-wide");
  });

  it("separates subscription renewals, first orders and B2B by order type", () => {
    const components = [
      component({
        id: "renewal-fee",
        family: "channel_fees",
        scope: [{ dimension: "order_type", operator: "in", values: ["subscription_renewal"] }],
        basis: { kind: "percent_of_base", percent: 3, base: "line_net_sales" },
      }),
      component({
        id: "b2b-cost",
        family: "product_purchase",
        scope: [{ dimension: "order_type", operator: "in", values: ["b2b"] }],
        basis: { kind: "amount_per_unit", amount: 70 },
      }),
      component({ id: "retail-cost", basis: { kind: "amount_per_unit", amount: 100 } }),
    ];

    const renewal = resolve({
      structure: structure({ components }),
      order: order({ dimensions: { order_type: ["subscription_renewal"] } }),
    });
    expect(entryFor(renewal, "channel_fees")?.amount).toBe(30);
    expect(entryFor(renewal, "product_purchase")?.amount).toBe(100);

    const b2b = resolve({
      structure: structure({ components }),
      order: order({ dimensions: { order_type: ["b2b"] } }),
    });
    expect(entryFor(b2b, "product_purchase")?.ownerComponentId).toBe("b2b-cost");
    // A rule scoped elsewhere leaves a stated gap here. Saying "no fee on
    // first orders" is done with an explicit zero component, not with silence.
    expect(entryFor(b2b, "channel_fees")?.state).toBe("unknown");
  });

  it("does not apply a scoped cost when the dimension it needs is unknown", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            family: "channel_fees",
            scope: [{ dimension: "channel", operator: "not_in", values: ["marketplace"] }],
            basis: { kind: "percent_of_base", percent: 5, base: "line_net_sales" },
          }),
        ],
      }),
      order: order({ dimensions: {} }),
    });

    expect(entryFor(result, "channel_fees")?.state).toBe("unknown");
    expect(entryFor(result, "channel_fees")?.reasons).toContain("no_component_matched");
  });

  it("treats a gift card and a non-shipped line as genuinely not applicable", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({ basis: { kind: "amount_per_unit", amount: 100 } }),
          component({ id: "ship", family: "outbound_shipping", basis: { kind: "amount_per_line", amount: 30 } }),
        ],
      }),
      order: order(),
      lines: [
        line({ lineId: "gift", isGiftCard: true }),
        line({ lineId: "digital", requiresShipping: false }),
      ],
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(entryFor(result, "product_purchase", "gift")?.state).toBe("not_applicable");
    expect(entryFor(result, "product_purchase", "gift")?.reasons).toContain("gift_card_line");
    expect(entryFor(result, "outbound_shipping", "digital")?.state).toBe("not_applicable");
    // The digital line still carries a product cost.
    expect(entryFor(result, "product_purchase", "digital")?.amount).toBe(100);
  });

  it("costs a free gift even though it earns nothing", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            family: "promo_giveaway",
            scope: [{ dimension: "product_tag", operator: "in", values: ["gift"] }],
            basis: { kind: "amount_per_unit", amount: 45 },
          }),
        ],
        expectedFamilies: ["promo_giveaway"],
      }),
      lines: [line({ dimensions: { product_tag: ["gift"] }, bases: { line_net_sales: 0 } })],
    });

    expect(entryFor(result, "promo_giveaway")?.amount).toBe(45);
  });
});

describe("resolver: provenance, time and currency", () => {
  it("lets an observation beat a contracted rate and an override beat everything", () => {
    const observed = resolve({
      structure: structure({
        components: [component({ basis: { kind: "amount_per_unit", amount: 100 } })],
      }),
      lines: [
        line({
          observed: [
            { family: "product_purchase", amount: 93.5, currency: REPORTING_CURRENCY, source: { kind: "supplier_invoice", ref: "INV-1" } },
          ],
        }),
      ],
    });
    expect(entryFor(observed, "product_purchase")?.amount).toBe(93.5);
    expect(entryFor(observed, "product_purchase")?.evidence).toBe("observed_exact");

    const overridden = resolve({
      structure: structure({
        components: [
          component({ basis: { kind: "amount_per_unit", amount: 100 } }),
          component({
            id: "fix",
            evidence: "override",
            overrideOf: "component-1",
            reason: "supplier rebate",
            basis: { kind: "amount_per_unit", amount: 88 },
          }),
        ],
      }),
      lines: [
        line({
          observed: [
            { family: "product_purchase", amount: 93.5, currency: REPORTING_CURRENCY, source: { kind: "supplier_invoice" } },
          ],
        }),
      ],
    });
    expect(entryFor(overridden, "product_purchase")?.ownerComponentId).toBe("fix");
    expect(entryFor(overridden, "product_purchase")?.amount).toBe(88);
  });

  it("keeps observed and estimated costs distinguishable on the same order", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [component({ evidence: "operator_estimate", basis: { kind: "amount_per_unit", amount: 100 } })],
      }),
      order: order(),
      lines: [
        line({ lineId: "measured", observed: [{ family: "product_purchase", amount: 97, currency: REPORTING_CURRENCY, source: { kind: "supplier_invoice" } }] }),
        line({ lineId: "guessed" }),
      ],
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(entryFor(result, "product_purchase", "measured")?.estimated).toBe(false);
    expect(entryFor(result, "product_purchase", "guessed")?.estimated).toBe(true);
  });

  it("uses the cost that was valid when the order happened, not today's", () => {
    const components = [
      component({
        id: "cost",
        version: 1,
        basis: { kind: "amount_per_unit", amount: 100 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: "2026-06-01T00:00:00.000Z",
        recordedAt: "2026-01-01T00:00:00.000Z",
      }),
      component({
        id: "cost-2",
        version: 1,
        basis: { kind: "amount_per_unit", amount: 130 },
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        recordedAt: "2026-06-01T00:00:00.000Z",
      }),
    ];

    const march = resolve({
      structure: structure({ components }),
      order: order({ occurredAt: "2026-03-05T10:00:00.000Z", occurredDate: "2026-03-05" }),
    });
    expect(entryFor(march, "product_purchase")?.amount).toBe(100);

    const september = resolve({ structure: structure({ components }) });
    expect(entryFor(september, "product_purchase")?.amount).toBe(130);

    // Bitemporal replay: what we believed in May about a September order.
    const replayed = resolveOrderCosts({
      structure: structure({ components }),
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
      asOfRecordedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(entryFor(replayed, "product_purchase")?.state).toBe("unknown");
  });

  it("converts a supplier currency and blocks the family when no rate exists", () => {
    const converted = resolveOrderCosts({
      structure: structure({
        components: [
          component({ currency: "USD", fx: { policy: "transaction_date" }, basis: { kind: "amount_per_unit", amount: 10 } }),
        ],
      }),
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
      fxRates: { USD: 41.5 },
    });
    expect(entryFor(converted, "product_purchase")?.amount).toBe(415);

    const blocked = resolveOrderCosts({
      structure: structure({
        components: [
          component({ currency: "USD", fx: { policy: "transaction_date" }, basis: { kind: "amount_per_unit", amount: 10 } }),
        ],
      }),
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
    });
    const entry = entryFor(blocked, "product_purchase");
    expect(entry?.state).toBe("unavailable");
    expect(entry?.unavailableReason).toBe("currency_blocked");
    expect(entry?.amount).toBeNull();
  });

  it("does not apply a component fixed FX rate to a percentage base in another currency", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            family: "channel_fees",
            currency: "USD",
            fx: { policy: "fixed_rate", fixedRate: 40 },
            basis: { kind: "percent_of_base", percent: 10, base: "line_net_sales" },
          }),
        ],
      }),
      order: order({ currency: "EUR" }),
      lines: [line({ bases: { line_net_sales: 100, line_gross_sales: 100 } })],
      reportingCurrency: REPORTING_CURRENCY,
      fxRates: { EUR: 45 },
    });

    // The base is EUR, so EUR's transaction rate applies. The component's
    // USD fixed rate is irrelevant to this evaluated amount.
    expect(entryFor(result, "channel_fees")?.amount).toBe(450);
  });
});

describe("resolver: the four ways a number can be absent", () => {
  it("separates unknown, zero, not tracked and unreadable", () => {
    const unknown = resolve({ structure: structure({ components: [] }) });
    expect(entryFor(unknown, "product_purchase")?.state).toBe("unknown");

    const zero = resolve({
      structure: structure({
        components: [component({ basis: { kind: "amount_per_unit", amount: 0 }, evidence: "contracted_rate" })],
      }),
    });
    expect(entryFor(zero, "product_purchase")?.state).toBe("zero");
    expect(entryFor(zero, "product_purchase")?.amount).toBe(0);

    const notTracked = resolve({
      structure: structure({ components: [], notTracked: ["returns_loss"] }),
    });
    expect(entryFor(notTracked, "returns_loss")?.state).toBe("not_tracked");

    const unreadable = resolveOrderCosts({
      structure: structure({ components: [], expectedFamilies: ["product_purchase"] }),
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
      sourceIssues: [{ family: "product_purchase", reason: "permission_missing" }],
    });
    expect(entryFor(unreadable, "product_purchase")?.state).toBe("unavailable");
    expect(entryFor(unreadable, "product_purchase")?.unavailableReason).toBe("permission_missing");
  });

  it("does not grade unstated payment fees or shipping as implicit zero", () => {
    const result = resolve({
      structure: structure({
        components: [component({ basis: { kind: "amount_per_unit", amount: 40 } })],
      }),
      lines: [line({ requiresShipping: true })],
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(40);
    expect(entryFor(result, "payment_processing")?.state).toBe("unknown");
    expect(entryFor(result, "outbound_shipping")?.state).toBe("unknown");
  });

  it("does not require outbound shipping for a line declared non-shipping", () => {
    const result = resolve({
      structure: structure({ components: [] }),
      lines: [line({ requiresShipping: false })],
    });

    expect(entryFor(result, "payment_processing")?.state).toBe("unknown");
    expect(entryFor(result, "outbound_shipping")).toBeUndefined();
  });

  it("reports a base it was not given instead of approximating it", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({ basis: { kind: "percent_of_base", percent: 40, base: "order_shipping_revenue" } }),
        ],
      }),
      order: order({ bases: { order_net_product_sales: 1000 } }),
    });

    const entry = entryFor(result, "product_purchase");
    expect(entry?.state).toBe("unknown");
    expect(entry?.reasons).toContain("base_unavailable:order_shipping_revenue");
  });
});

describe("resolver: invariants", () => {
  it("never gives one family two owners, and reports an equal-rank disagreement", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({ id: "a", basis: { kind: "amount_per_unit", amount: 100 } }),
          component({ id: "b", basis: { kind: "amount_per_unit", amount: 130 } }),
        ],
      }),
    });

    expect(entriesFor(result, "product_purchase")).toHaveLength(1);
    const entry = entryFor(result, "product_purchase");
    expect(entry?.state).toBe("conflict");
    // A decision sees the conservative number while the disagreement stands.
    expect(entry?.amount).toBe(130);
    expect(entry?.conflictingComponentIds).toEqual(["a", "b"]);
  });

  it("keeps one entry per family and slot so composed costs are not conflicts", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({ id: "base-rate", family: "outbound_shipping", slot: "base", basis: { kind: "amount_per_line", amount: 30 } }),
          component({ id: "surcharge", family: "outbound_shipping", slot: "fuel_surcharge", basis: { kind: "amount_per_line", amount: 5 } }),
        ],
      }),
    });

    const shipping = entriesFor(result, "outbound_shipping");
    expect(shipping).toHaveLength(2);
    expect(shipping.every((entry) => entry.state === "value")).toBe(true);
    expect(shipping.reduce((sum, entry) => sum + (entry.amount ?? 0), 0)).toBe(35);
  });

  it("refuses to model ad spend as a cost", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({ id: "ads", family: "marketing_paid", basis: { kind: "percent_of_base", percent: 20, base: "line_net_sales" } }),
          component({ id: "hide-ads", basis: { kind: "amount_per_unit", amount: 100 }, embeds: ["marketing_paid"] }),
        ],
      }),
    });

    expect(result.entries.some((entry) => entry.family === "marketing_paid")).toBe(false);
    expect(result.reasons).toContain("component_family_not_allowed:ads");
    expect(result.reasons).toContain("embed_family_not_allowed:hide-ads:marketing_paid");
    expect(lineCost(result)).toBe(100);
  });

  it("is deterministic", () => {
    const build = () =>
      resolveOrderCosts({
        structure: structure({
          components: [
            component({ id: "a", basis: { kind: "amount_per_unit", amount: 100 }, embeds: ["packaging"] }),
            component({ id: "b", family: "outbound_shipping", basis: { kind: "amount_per_order", amount: 33.33, allocation: "units" } }),
          ],
        }),
        order: order(),
        lines: [line({ lineId: "l1", quantity: 2 }), line({ lineId: "l2", quantity: 1 })],
        reportingCurrency: REPORTING_CURRENCY,
      });

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

describe("resolver: an inconsistent embedded share", () => {
  it("empties the host instead of turning it into a negative cost", () => {
    // The host declares 50 of shipping inside it but only carries 30 in total.
    // A negative cost would read as revenue in every downstream sum.
    const result = resolve({
      structure: structure({
        components: [
          component({
            id: "loaded",
            basis: { kind: "amount_per_unit", amount: 30 },
            embeds: ["outbound_shipping"],
            embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          }),
          component({
            id: "measured",
            family: "outbound_shipping",
            replacesEmbedded: true,
            evidence: "observed_exact",
            source: { kind: "carrier_invoice" },
            basis: { kind: "amount_per_line", amount: 72 },
          }),
        ],
      }),
    });

    const host = entryFor(result, "product_purchase");
    expect(host?.amount).toBe(0);
    expect(host?.state).toBe("zero");
    expect(host?.hostShareRemoved).toBe(30);
    expect(host?.reasons.some((reason) => reason.startsWith("embedded_share_exceeded_host"))).toBe(true);
    expect(entryFor(result, "outbound_shipping")?.amount).toBe(72);
    expect(lineCost(result)).toBe(72);
  });

  it("scales a per-unit share by each line's own quantity", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            id: "loaded",
            basis: { kind: "amount_per_unit", amount: 600 },
            embeds: ["outbound_shipping"],
            embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          }),
          component({
            id: "measured",
            family: "outbound_shipping",
            replacesEmbedded: true,
            evidence: "observed_exact",
            source: { kind: "carrier_invoice" },
            basis: { kind: "amount_per_line", amount: 10 },
          }),
        ],
      }),
      order: order(),
      lines: [line({ lineId: "one", quantity: 1 }), line({ lineId: "three", quantity: 3 })],
      reportingCurrency: REPORTING_CURRENCY,
    });

    // 600 − 50 on the single-unit line; 1800 − 150 on the three-unit line.
    expect(entryFor(result, "product_purchase", "one")?.amount).toBe(550);
    expect(entryFor(result, "product_purchase", "three")?.amount).toBe(1650);
  });

  it("removes a share from the line that replaced it and from no other", () => {
    const result = resolveOrderCosts({
      structure: structure({
        components: [
          component({
            id: "loaded",
            basis: { kind: "amount_per_unit", amount: 600 },
            embeds: ["outbound_shipping"],
            embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          }),
          component({
            id: "measured",
            family: "outbound_shipping",
            scope: [{ dimension: "sku", operator: "in", values: ["SKU-REPLACED"] }],
            replacesEmbedded: true,
            evidence: "observed_exact",
            source: { kind: "carrier_invoice" },
            basis: { kind: "amount_per_line", amount: 70 },
          }),
        ],
      }),
      order: order(),
      lines: [
        line({ lineId: "replaced", sku: "SKU-REPLACED" }),
        line({ lineId: "untouched", sku: "SKU-PLAIN" }),
      ],
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(entryFor(result, "product_purchase", "replaced")?.amount).toBe(550);
    // The other line never gave up a share, so its loaded cost is intact.
    expect(entryFor(result, "product_purchase", "untouched")?.amount).toBe(600);
    expect(entryFor(result, "product_purchase", "untouched")?.hostShareRemoved ?? null).toBeNull();
    expect(entryFor(result, "outbound_shipping", "untouched")?.state).toBe("embedded");
  });
});

describe("resolver: ownership is decided before embedding", () => {
  const loadedHost = (overrides: Partial<Parameters<typeof component>[0]> = {}) =>
    component({
      id: "loaded",
      basis: { kind: "amount_per_unit", amount: 600 },
      embeds: ["outbound_shipping"],
      embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
      ...overrides,
    });
  const measuredShipping = (overrides: Partial<Parameters<typeof component>[0]> = {}) =>
    component({
      id: "measured",
      family: "outbound_shipping",
      replacesEmbedded: true,
      evidence: "observed_exact",
      source: { kind: "carrier_invoice" },
      basis: { kind: "amount_per_line", amount: 72 },
      ...overrides,
    });

  it("keeps the host whole when the replacement reports no number", () => {
    const result = resolve({
      structure: structure({
        components: [
          loadedHost(),
          measuredShipping({
            basis: { kind: "percent_of_base", percent: 10, base: "order_shipping_revenue" },
          }),
        ],
      }),
      order: order({ bases: { order_net_product_sales: 1000 } }),
    });

    // The host must not pay for a share the replacement never delivered.
    expect(entryFor(result, "product_purchase")?.amount).toBe(600);
    expect(entryFor(result, "outbound_shipping")?.state).toBe("embedded");
    expect(entryFor(result, "outbound_shipping")?.reasons).toContain("replacement_amount_unknown");
    expect(lineCost(result)).toBe(600);
  });

  it("takes one stated share out of the host once, however many slots replace it", () => {
    const result = resolve({
      structure: structure({
        components: [
          loadedHost(),
          measuredShipping({ id: "base-rate", slot: "base", basis: { kind: "amount_per_line", amount: 40 } }),
          measuredShipping({ id: "surcharge", slot: "fuel", basis: { kind: "amount_per_line", amount: 12 } }),
        ],
      }),
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(550);
    expect(entryFor(result, "product_purchase")?.hostShareRemoved).toBe(50);
    expect(lineCost(result)).toBe(602);
  });

  it("does not let a component that lost its own atom shadow another family", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            id: "template-loaded",
            evidence: "template_default",
            basis: { kind: "amount_per_line", amount: 500 },
            embeds: ["packaging"],
            embeddedShares: [{ family: "packaging", kind: "amount_per_unit", value: 20 }],
          }),
          component({
            id: "real-cogs",
            evidence: "observed_exact",
            source: { kind: "supplier_invoice" },
            basis: { kind: "amount_per_line", amount: 480 },
          }),
        ],
      }),
    });

    // The template lost, so its money is not in the result and it cannot claim
    // to be holding packaging either.
    expect(entryFor(result, "product_purchase")?.amount).toBe(480);
    expect(entryFor(result, "packaging")?.state).toBe("unknown");
  });

  it("does not let a host with no usable amount swallow a measured cost", () => {
    const result = resolve({
      structure: structure({
        components: [
          loadedHost({ basis: { kind: "percent_of_base", percent: 40, base: "order_shipping_revenue" } }),
          measuredShipping(),
        ],
      }),
      order: order({ bases: { order_net_product_sales: 1000 } }),
    });

    expect(entryFor(result, "product_purchase")?.state).toBe("unknown");
    expect(entryFor(result, "outbound_shipping")?.amount).toBe(72);
    expect(lineCost(result)).toBe(72);
  });

  it("refuses to pick between two equally-trusted replacements", () => {
    const result = resolve({
      structure: structure({
        components: [
          loadedHost(),
          measuredShipping({
            id: "vip",
            evidence: "contracted_rate",
            source: { kind: "manual" },
            scope: [{ dimension: "customer_tag", operator: "in", values: ["vip"] }],
            basis: { kind: "amount_per_line", amount: 40 },
          }),
          measuredShipping({
            id: "wholesale",
            evidence: "contracted_rate",
            source: { kind: "manual" },
            scope: [{ dimension: "customer_tag", operator: "in", values: ["wholesale"] }],
            basis: { kind: "amount_per_line", amount: 95 },
          }),
        ],
      }),
      order: order({ dimensions: { customer_tag: ["vip", "wholesale"] } }),
    });

    const shipping = entryFor(result, "outbound_shipping");
    expect(shipping?.state).toBe("conflict");
    expect(shipping?.amount).toBeNull();
    expect(shipping?.conflictingComponentIds).toEqual(["vip", "wholesale"]);
    // Neither host share is surrendered on the strength of a coin flip.
    expect(entryFor(result, "product_purchase")?.amount).toBe(600);
  });

  it("takes the share out of every host that was holding the family", () => {
    const result = resolve({
      structure: structure({
        components: [
          loadedHost(),
          component({
            id: "host-b",
            family: "fulfillment",
            basis: { kind: "amount_per_line", amount: 200 },
            embeds: ["outbound_shipping"],
            embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          }),
          measuredShipping(),
        ],
      }),
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(550);
    expect(entryFor(result, "fulfillment")?.amount).toBe(150);
    expect(entryFor(result, "outbound_shipping")?.amount).toBe(72);
    expect(lineCost(result)).toBe(772);
  });

  it("refuses a share that is not a share of a cost", () => {
    const result = resolve({
      structure: structure({
        components: [
          loadedHost({
            embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: -50 }],
          }),
          measuredShipping(),
        ],
      }),
    });

    // A negative share would grow the host it is taken out of.
    expect(entryFor(result, "product_purchase")?.amount).toBe(600);
    expect(entryFor(result, "outbound_shipping")?.state).toBe("embedded");
    expect(
      entryFor(result, "outbound_shipping")?.reasons.some((reason) =>
        reason.startsWith("embedded_share_not_a_cost"),
      ),
    ).toBe(true);
  });

  it("resolves a chain of replacements", () => {
    const result = resolve({
      structure: structure({
        components: [
          loadedHost(),
          component({
            id: "ship-loaded",
            family: "outbound_shipping",
            replacesEmbedded: true,
            basis: { kind: "amount_per_line", amount: 80 },
            embeds: ["packaging"],
            embeddedShares: [{ family: "packaging", kind: "amount_per_unit", value: 6 }],
          }),
          component({
            id: "measured-packaging",
            family: "packaging",
            replacesEmbedded: true,
            evidence: "observed_exact",
            source: { kind: "supplier_invoice" },
            basis: { kind: "amount_per_line", amount: 9 },
          }),
        ],
      }),
    });

    expect(entryFor(result, "product_purchase")?.amount).toBe(550);
    expect(entryFor(result, "outbound_shipping")?.amount).toBe(74);
    expect(entryFor(result, "packaging")?.amount).toBe(9);
    expect(lineCost(result)).toBe(633);
  });

  it("lets a measurement of this line beat configuration at the same tier", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({
            id: "config-shipping",
            family: "outbound_shipping",
            evidence: "observed_exact",
            source: { kind: "csv_import" },
            scope: [
              { dimension: "sku", operator: "in", values: ["SKU-1"] },
              { dimension: "variant_id", operator: "in", values: ["variant-1"] },
              { dimension: "product_id", operator: "in", values: ["product-1"] },
            ],
            basis: { kind: "amount_per_line", amount: 10 },
          }),
        ],
      }),
      lines: [
        line({
          observed: [
            {
              family: "outbound_shipping",
              amount: 88,
              currency: REPORTING_CURRENCY,
              source: { kind: "carrier_invoice" },
            },
          ],
        }),
      ],
    });

    // Three predicates outweigh nothing: the carrier invoice measured this line.
    expect(entryFor(result, "outbound_shipping")?.amount).toBe(88);
  });
});

describe("resolver: times it cannot read", () => {
  it("refuses to use a component whose own times are unreadable", () => {
    for (const field of ["effectiveFrom", "recordedAt", "effectiveTo"] as const) {
      const result = resolve({
        structure: structure({
          components: [component({ [field]: "2026-13-01" } as Parameters<typeof component>[0])],
        }),
      });
      // Collapsing a malformed date to the epoch made a cost effective for
      // every order that ever happened.
      expect(entryFor(result, "product_purchase")?.state).toBe("unknown");
    }
  });

  it("reads an offset-less timestamp as UTC, so the host timezone cannot change the answer", () => {
    const withZ = resolve({
      structure: structure({
        components: [component({ effectiveFrom: "2026-09-10T09:00:00.000Z" })],
      }),
    });
    const withoutZ = resolve({
      structure: structure({ components: [component({ effectiveFrom: "2026-09-10T09:00:00" })] }),
    });
    expect(entryFor(withoutZ, "product_purchase")?.amount).toBe(
      entryFor(withZ, "product_purchase")?.amount,
    );
  });

  it("refuses a replay it cannot pin to an instant", () => {
    expect(() =>
      resolveOrderCosts({
        structure: structure(),
        order: order(),
        lines: [line()],
        reportingCurrency: REPORTING_CURRENCY,
        asOfRecordedAt: "not-a-time",
      }),
    ).toThrow(/asOfRecordedAt/);
  });

  it("says when a recognition instant was missing and the order's was used", () => {
    const result = resolve({
      structure: structure({
        components: [
          component({ recognition: "on_payout", basis: { kind: "amount_per_line", amount: 12 } }),
        ],
      }),
      order: order({ payoutDate: "2026-09-18" }),
    });

    expect(entryFor(result, "product_purchase")?.reasons).toContain(
      "recognition_anchor_missing:on_payout",
    );
  });
});
