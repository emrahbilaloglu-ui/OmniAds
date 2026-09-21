import { describe, expect, it } from "vitest";

import type { CostRefundLine } from "@/src/types/commerce-cost";
import { buildPeriodLedger, buildRefundLedger, buildSaleLedger } from "./ledger";
import { REPORTING_CURRENCY, component, line, order, resolve, structure } from "./__tests__/fixtures";

/**
 * Ledger behaviour.
 *
 * The rule the whole design turns on: a sale books what was true when it
 * happened, and a refund is computed from that stored decision. Editing a cost
 * later must never move a past day's profit.
 */

function saleOf(overrides: Parameters<typeof resolve>[0]) {
  return resolve(overrides);
}

const refund = (overrides: Partial<CostRefundLine> = {}): CostRefundLine => ({
  refundLineId: "refund-line-1",
  lineId: "line-1",
  quantity: 1,
  restockType: "return",
  refundedDate: "2026-09-20",
  ...overrides,
});

describe("sale ledger", () => {
  it("books every resolved family on the order date and keeps ids stable", () => {
    const sale = saleOf({
      structure: structure({
        components: [
          component({ basis: { kind: "amount_per_unit", amount: 100 } }),
          component({ id: "ship", family: "outbound_shipping", basis: { kind: "amount_per_line", amount: 30 } }),
        ],
      }),
    });

    const events = buildSaleLedger(sale);
    const product = events.find((event) => event.family === "product_purchase");
    expect(product?.eventId).toBe("sale:order-1:line-1:product_purchase:default");
    expect(product?.occurredDate).toBe("2026-09-10");
    expect(product?.amount).toBe(100);
    expect(product?.kind).toBe("sale");
    expect(product?.structureVersion).toBe(1);

    // Re-deriving the window must be an upsert, not a duplicate.
    expect(buildSaleLedger(sale).map((event) => event.eventId)).toEqual(
      events.map((event) => event.eventId),
    );
  });

  it("books a cost on the date its recognition names, and says when that date is missing", () => {
    const withDates = saleOf({
      structure: structure({
        components: [
          component({ id: "pick", family: "fulfillment", recognition: "on_fulfillment", basis: { kind: "amount_per_line", amount: 20 } }),
          component({ id: "fee", family: "payment_processing", recognition: "on_payout", basis: { kind: "amount_per_line", amount: 12 } }),
        ],
      }),
      order: order({ fulfilledDate: "2026-09-12", payoutDate: "2026-09-18" }),
    });

    const events = buildSaleLedger(withDates);
    expect(events.find((event) => event.family === "fulfillment")?.occurredDate).toBe("2026-09-12");
    expect(events.find((event) => event.family === "payment_processing")?.occurredDate).toBe("2026-09-18");

    const withoutDates = saleOf({
      structure: structure({
        components: [
          component({ id: "pick", family: "fulfillment", recognition: "on_fulfillment", basis: { kind: "amount_per_line", amount: 20 } }),
        ],
      }),
    });
    const fallback = buildSaleLedger(withoutDates).find((event) => event.family === "fulfillment");
    expect(fallback?.occurredDate).toBe("2026-09-10");
    expect(fallback?.reasons).toContain("fulfillment_date_missing");
  });
});

describe("refund ledger", () => {
  const saleWithFamilies = () =>
    saleOf({
      structure: structure({
        components: [
          component({ basis: { kind: "amount_per_unit", amount: 90 } }),
          component({ id: "ship", family: "outbound_shipping", basis: { kind: "amount_per_line", amount: 30 } }),
          component({ id: "fee", family: "payment_processing", basis: { kind: "amount_per_line", amount: 12 } }),
        ],
      }),
      lines: [line({ quantity: 3 })],
    });

  it("reverses the returned share of product cost on the refund date", () => {
    const sale = saleWithFamilies();
    const events = buildRefundLedger({ saleResolution: sale, refundLines: [refund({ quantity: 1 })] });
    const product = events.find((event) => event.family === "product_purchase");

    // 1 of 3 units came back: one third of 270.
    expect(product?.amount).toBe(-90);
    expect(product?.occurredDate).toBe("2026-09-20");
    expect(product?.quantity).toBe(-1);
    expect(product?.eventId).toBe(
      "refund:order-1:line-1:refund-line-1:product_purchase:default",
    );
    // The sale day itself is untouched — no event rewrites it.
    expect(buildSaleLedger(sale).find((event) => event.family === "product_purchase")?.amount).toBe(270);
  });

  it("does not give back money the return never recovers", () => {
    const events = buildRefundLedger({
      saleResolution: saleWithFamilies(),
      refundLines: [refund({ quantity: 3 })],
    });

    // The parcel already flew and the processor already took its cut. That is
    // a stated zero, not an unknown: the window can still state contribution.
    const shipping = events.find((event) => event.family === "outbound_shipping");
    expect(shipping?.amount).toBe(0);
    expect(shipping?.state).toBe("zero");
    expect(shipping?.reasons).toContain("only_reversed_before_fulfillment");

    const fee = events.find((event) => event.family === "payment_processing");
    expect(fee?.state).toBe("zero");
    expect(fee?.amount).toBe(0);
    expect(fee?.reasons).toContain("non_recoverable_family");
  });

  it("reverses pre-fulfilment costs when the order was cancelled instead", () => {
    const events = buildRefundLedger({
      saleResolution: saleWithFamilies(),
      refundLines: [refund({ quantity: 3, restockType: "cancel" })],
    });

    expect(events.find((event) => event.family === "outbound_shipping")?.amount).toBe(-30);
    expect(events.find((event) => event.family === "product_purchase")?.amount).toBe(-270);
  });

  it("states an unknown rather than a zero when the restock is not known", () => {
    const events = buildRefundLedger({
      saleResolution: saleWithFamilies(),
      refundLines: [refund({ quantity: 1, restockType: "unknown" })],
    });

    const product = events.find((event) => event.family === "product_purchase");
    expect(product?.state).toBe("unknown");
    expect(product?.amount).toBeNull();
    expect(product?.reasons).toContain("restock_type_unknown");

    const notRestocked = buildRefundLedger({
      saleResolution: saleWithFamilies(),
      refundLines: [refund({ quantity: 1, restockType: "no_restock" })],
    });
    const kept = notRestocked.find((event) => event.family === "product_purchase");
    expect(kept?.state).toBe("zero");
    expect(kept?.reasons).toContain("not_restocked");
  });

  it("reverses only the product part of a loaded cost, and refuses when that part is unknown", () => {
    const loadedStructure = structure({
      components: [
        component({
          id: "loaded",
          basis: { kind: "amount_per_unit", amount: 600 },
          embeds: ["outbound_shipping"],
          embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          refundBehaviour: "product_share_only",
        }),
      ],
    });
    const sale = saleOf({ structure: loadedStructure });
    const events = buildRefundLedger({
      saleResolution: sale,
      refundLines: [refund()],
      structure: loadedStructure,
    });
    // 600 loaded − 50 of embedded shipping that does not come back.
    expect(events.find((event) => event.family === "product_purchase")?.amount).toBe(-550);

    const opaqueStructure = structure({
      components: [
        component({
          id: "loaded",
          basis: { kind: "amount_per_unit", amount: 600 },
          embeds: ["outbound_shipping"],
          refundBehaviour: "product_share_only",
        }),
      ],
    });
    const opaque = buildRefundLedger({
      saleResolution: saleOf({ structure: opaqueStructure }),
      refundLines: [refund()],
      structure: opaqueStructure,
    });
    const unresolved = opaque.find((event) => event.family === "product_purchase");
    expect(unresolved?.state).toBe("unknown");
    expect(unresolved?.reasons).toContain("embedded_product_share_unknown");
  });

  it("does not subtract an embedded percentage twice after a direct source replaces it", () => {
    const loadedStructure = structure({
      components: [
        component({
          id: "loaded",
          basis: { kind: "amount_per_unit", amount: 600 },
          embeds: ["outbound_shipping"],
          embeddedShares: [
            { family: "outbound_shipping", kind: "percent_of_host", value: 10 },
          ],
          refundBehaviour: "product_share_only",
        }),
        component({
          id: "carrier",
          family: "outbound_shipping",
          replacesEmbedded: true,
          evidence: "observed_exact",
          source: { kind: "carrier_invoice" },
          basis: { kind: "amount_per_line", amount: 40 },
        }),
      ],
    });
    const sale = saleOf({ structure: loadedStructure });
    const host = sale.entries.find((entry) => entry.family === "product_purchase");
    expect(host?.amount).toBe(540);
    expect(host?.hostShareRemoved).toBe(60);

    const events = buildRefundLedger({
      saleResolution: sale,
      refundLines: [refund()],
      structure: loadedStructure,
    });

    // Product share is 90% of the original 600 loaded amount. The resolver
    // already removed the 60 shipping share from the host once.
    expect(events.find((event) => event.family === "product_purchase")?.amount).toBe(-540);
  });

  it("uses the stored sale decision, not whatever the structure says now", () => {
    const sale = saleWithFamilies();
    const laterStructure = structure({
      components: [component({ basis: { kind: "amount_per_unit", amount: 5000 } })],
    });

    const events = buildRefundLedger({
      saleResolution: sale,
      refundLines: [refund({ quantity: 3 })],
      structure: laterStructure,
    });

    expect(events.find((event) => event.family === "product_purchase")?.amount).toBe(-270);
  });

  it("books nothing for a refund line that was never sold", () => {
    const events = buildRefundLedger({
      saleResolution: saleWithFamilies(),
      refundLines: [refund({ lineId: "line-unknown" })],
    });
    expect(events).toEqual([]);
  });
});

describe("period ledger", () => {
  it("prorates a recurring cost into the window and never touches a line", () => {
    const periodStructure = structure({
      components: [
        component({
          id: "rent",
          family: "overhead_fixed",
          recognition: "on_period",
          basis: { kind: "period_amount", amount: 30_000, period: "month", allocation: "revenue" },
        }),
        component({ id: "product", basis: { kind: "amount_per_unit", amount: 100 } }),
      ],
    });

    const events = buildPeriodLedger({
      structure: periodStructure,
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.family).toBe("overhead_fixed");
    expect(events[0]?.lineId ?? null).toBeNull();
    expect(events[0]?.amount).toBe(30_000);
    expect(events[0]?.occurredDate).toBe("2026-09-30");
    expect(events[0]?.eventId).toBe("period:rent:1:2026-09-01:2026-09-30");
    expect(events[0]?.decisionClass).toBe("operating");
  });

  it("marks a recurring cost unavailable when its currency cannot be converted", () => {
    const events = buildPeriodLedger({
      structure: structure({
        components: [
          component({
            id: "saas",
            family: "platform_software",
            currency: "USD",
            fx: { policy: "transaction_date" },
            recognition: "on_period",
            basis: { kind: "period_amount", amount: 500, period: "month", allocation: "equal" },
          }),
        ],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(events[0]?.state).toBe("unavailable");
    expect(events[0]?.amount).toBeNull();
    expect(events[0]?.reasons).toContain("currency_unconvertible:USD");
  });

  it("charges only the days on which a recurring component is effective", () => {
    const startsMidWindow = buildPeriodLedger({
      structure: structure({
        components: [
          component({
            id: "rent",
            family: "overhead_fixed",
            recognition: "on_period",
            effectiveFrom: "2026-09-16T00:00:00.000Z",
            basis: {
              kind: "period_amount",
              amount: 30_000,
              period: "month",
              allocation: "revenue",
            },
          }),
        ],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });
    expect(startsMidWindow[0]?.amount).toBe(15_000);
    expect(startsMidWindow[0]?.reasons).toContain("effective_overlap_days:15");

    const endsMidWindow = buildPeriodLedger({
      structure: structure({
        components: [
          component({
            id: "rent",
            family: "overhead_fixed",
            recognition: "on_period",
            effectiveTo: "2026-09-16T00:00:00.000Z",
            basis: {
              kind: "period_amount",
              amount: 30_000,
              period: "month",
              allocation: "revenue",
            },
          }),
        ],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });
    expect(endsMidWindow[0]?.amount).toBe(15_000);

    const outsideWindow = buildPeriodLedger({
      structure: structure({
        components: [
          component({
            id: "future-rent",
            family: "overhead_fixed",
            recognition: "on_period",
            effectiveFrom: "2026-10-01T00:00:00.000Z",
            basis: {
              kind: "period_amount",
              amount: 30_000,
              period: "month",
              allocation: "revenue",
            },
          }),
        ],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });
    expect(outsideWindow).toEqual([]);
  });

  it("replays only recurring component records known at the requested time", () => {
    const periodStructure = structure({
      components: [
        component({
          id: "saas",
          family: "platform_software",
          recognition: "on_period",
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          recordedAt: "2026-09-10T00:00:00.000Z",
          supersededAt: "2026-09-20T00:00:00.000Z",
          basis: { kind: "period_amount", amount: 300, period: "month", allocation: "equal" },
        }),
      ],
    });
    const request = {
      structure: periodStructure,
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    };

    expect(buildPeriodLedger({ ...request, asOfRecordedAt: "2026-09-05T00:00:00.000Z" })).toEqual([]);
    expect(buildPeriodLedger({ ...request, asOfRecordedAt: "2026-09-15T00:00:00.000Z" })).toHaveLength(1);
    expect(buildPeriodLedger({ ...request, asOfRecordedAt: "2026-09-25T00:00:00.000Z" })).toEqual([]);
    expect(buildPeriodLedger(request)).toEqual([]);
  });
});

describe("period ledger: time and identity", () => {
  const rent = (overrides: Parameters<typeof component>[0] = {}) =>
    component({
      id: "rent",
      family: "overhead_fixed",
      recognition: "on_period",
      basis: { kind: "period_amount", amount: 30_000, period: "month", allocation: "revenue" },
      ...overrides,
    });

  it("charges one recurring cost per component id, not one per stored version", () => {
    // Two versions of the same rent in one structure must not double the
    // overhead. The latest version is the one that is true.
    const events = buildPeriodLedger({
      structure: structure({
        components: [
          rent({ version: 1, basis: { kind: "period_amount", amount: 30_000, period: "month", allocation: "revenue" } }),
          rent({ version: 2, basis: { kind: "period_amount", amount: 40_000, period: "month", allocation: "revenue" } }),
        ],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.ownerComponentVersion).toBe(2);
    expect(events[0]?.amount).toBe(40_000);
  });

  it("charges only the part of the window the cost was effective for", () => {
    const events = buildPeriodLedger({
      structure: structure({
        components: [rent({ effectiveFrom: "2026-09-16T00:00:00.000Z" })],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });

    // Effective for the last 15 days of a 30-day window.
    expect(events[0]?.amount).toBe(15_000);
    expect(events[0]?.reasons).toContain("effective_overlap_days:15");
  });

  it("charges nothing for a cost that was not yet effective, or already ended", () => {
    const later = buildPeriodLedger({
      structure: structure({ components: [rent({ effectiveFrom: "2026-10-01T00:00:00.000Z" })] }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });
    expect(later).toEqual([]);

    const ended = buildPeriodLedger({
      structure: structure({
        components: [rent({ effectiveTo: "2026-09-01T00:00:00.000Z" })],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });
    expect(ended).toEqual([]);
  });

  it("replays what was known at an instant", () => {
    const structureWithHistory = structure({
      components: [
        rent({
          version: 1,
          recordedAt: "2026-08-01T00:00:00.000Z",
          supersededAt: "2026-09-20T00:00:00.000Z",
        }),
        rent({ version: 2, recordedAt: "2026-09-20T00:00:00.000Z", basis: { kind: "period_amount", amount: 50_000, period: "month", allocation: "revenue" } }),
      ],
    });
    const window = { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 };

    const today = buildPeriodLedger({ structure: structureWithHistory, window, reportingCurrency: REPORTING_CURRENCY });
    expect(today[0]?.ownerComponentVersion).toBe(2);

    const asOfSeptemberFirst = buildPeriodLedger({
      structure: structureWithHistory,
      window,
      reportingCurrency: REPORTING_CURRENCY,
      asOfRecordedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(asOfSeptemberFirst[0]?.ownerComponentVersion).toBe(1);
  });

  it("states a window whose day count disagrees with its own dates", () => {
    const events = buildPeriodLedger({
      structure: structure({ components: [rent()] }),
      // The dates span 30 days; the caller says 28.
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 28 },
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(events[0]?.reasons).toContain("window_days_mismatch:30");
  });
});

describe("refund ledger: how much can come back", () => {
  const saleOfThree = () =>
    saleOf({
      structure: structure({
        components: [component({ basis: { kind: "amount_per_unit", amount: 90 } })],
      }),
      lines: [line({ quantity: 3 })],
    });

  it("never gives back more than was sold, however the refunds arrive", () => {
    const events = buildRefundLedger({
      saleResolution: saleOfThree(),
      refundLines: [
        refund({ refundLineId: "r1", quantity: 2 }),
        refund({ refundLineId: "r2", quantity: 2 }),
      ],
    });

    const product = events.filter((event) => event.family === "product_purchase");
    expect(product.map((event) => event.amount)).toEqual([-180, -90]);
    expect(product[1]?.reasons).toContain("refund_quantity_capped_at_sold");
    // 270 was booked, so 270 is the most that can ever be reversed.
    expect(product.reduce((sum, event) => sum + (event.amount ?? 0), 0)).toBe(-270);
  });

  it("counts quantities already reversed by earlier refunds", () => {
    const events = buildRefundLedger({
      saleResolution: saleOfThree(),
      refundLines: [refund({ quantity: 2 })],
      priorRefundedQuantityByLine: { "line-1": 2 },
    });

    const product = events.find((event) => event.family === "product_purchase");
    expect(product?.amount).toBe(-90);
    expect(product?.quantity).toBe(-1);
  });

  it("treats a repeated refund line as the same refund", () => {
    const events = buildRefundLedger({
      saleResolution: saleOfThree(),
      refundLines: [refund({ quantity: 1 }), refund({ quantity: 1 })],
    });

    expect(events.filter((event) => event.family === "product_purchase")).toHaveLength(1);
  });

  it("refuses an impossible refund quantity instead of adding cost", () => {
    const events = buildRefundLedger({
      saleResolution: saleOfThree(),
      refundLines: [refund({ quantity: -1 })],
    });

    const product = events.find((event) => event.family === "product_purchase");
    expect(product?.state).toBe("unknown");
    expect(product?.amount).toBeNull();
    expect(product?.reasons).toContain("refund_quantity_invalid");
  });

  it("uses the embedded share that was true at sale time, not today's", () => {
    const atSale = structure({
      components: [
        component({
          id: "loaded",
          version: 1,
          basis: { kind: "amount_per_unit", amount: 600 },
          embeds: ["outbound_shipping"],
          embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          refundBehaviour: "product_share_only",
        }),
      ],
    });
    const sale = saleOf({ structure: atSale });

    const edited = structure({
      components: [
        ...atSale.components,
        component({
          id: "loaded",
          version: 2,
          basis: { kind: "amount_per_unit", amount: 600 },
          embeds: ["outbound_shipping"],
          embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 200 }],
          refundBehaviour: "product_share_only",
        }),
      ],
    });

    const events = buildRefundLedger({
      saleResolution: sale,
      refundLines: [refund()],
      structure: edited,
    });
    // v1's share of 50, not v2's 200.
    expect(events.find((event) => event.family === "product_purchase")?.amount).toBe(-550);
  });

  it("states an unknown when only part of a loaded cost is quantified", () => {
    const partial = structure({
      components: [
        component({
          id: "loaded",
          basis: { kind: "amount_per_unit", amount: 600 },
          embeds: ["outbound_shipping", "packaging"],
          embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
          refundBehaviour: "product_share_only",
        }),
      ],
    });
    const events = buildRefundLedger({
      saleResolution: saleOf({ structure: partial }),
      refundLines: [refund()],
      structure: partial,
    });

    const product = events.find((event) => event.family === "product_purchase");
    expect(product?.state).toBe("unknown");
    expect(product?.reasons).toContain("embedded_product_share_unknown");
  });

  it("states an unknown when the stated shares contradict the cost", () => {
    const contradictory = structure({
      components: [
        component({
          id: "loaded",
          basis: { kind: "amount_per_line", amount: 100 },
          embeds: ["outbound_shipping"],
          embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 60 }],
          refundBehaviour: "product_share_only",
        }),
      ],
    });
    const events = buildRefundLedger({
      saleResolution: saleOf({ structure: contradictory, lines: [line({ quantity: 2 })] }),
      refundLines: [refund({ quantity: 2 })],
      structure: contradictory,
    });

    const product = events.find((event) => event.family === "product_purchase");
    expect(product?.state).toBe("unknown");
    expect(product?.reasons).toContain("embedded_product_share_inconsistent");
    // Never a positive "reversal".
    expect(product?.amount).toBeNull();
  });

  it("states an unknown when a cancel-only cost meets an unknown restock", () => {
    const events = buildRefundLedger({
      saleResolution: saleOf({
        structure: structure({
          components: [
            component({ id: "ship", family: "outbound_shipping", basis: { kind: "amount_per_line", amount: 30 } }),
          ],
        }),
      }),
      refundLines: [refund({ restockType: "unknown" })],
    });

    const shipping = events.find((event) => event.family === "outbound_shipping");
    expect(shipping?.state).toBe("unknown");
    expect(shipping?.reasons).toContain("restock_type_unknown");
  });

  it("keeps ids unique across orders and lines, and escapes their segments", () => {
    const sale = saleOf({
      structure: structure({
        components: [component({ basis: { kind: "amount_per_unit", amount: 10 } })],
      }),
      order: order({ orderId: "gid://shopify/Order/9:1" }),
    });
    const events = buildRefundLedger({ saleResolution: sale, refundLines: [refund()] });

    expect(events[0]?.eventId).toBe(
      "refund:gid%3A%2F%2Fshopify%2FOrder%2F9%3A1:line-1:refund-line-1:product_purchase:default",
    );
    expect(buildSaleLedger(sale)[0]?.eventId).toContain("gid%3A%2F%2Fshopify%2FOrder%2F9%3A1");
  });
});

describe("period ledger: what it refuses", () => {
  it("charges a whole calendar month exactly once, whatever the month's length", () => {
    const monthly = structure({
      components: [
        component({
          id: "rent",
          family: "overhead_fixed",
          recognition: "on_period",
          basis: { kind: "period_amount", amount: 30_000, period: "month", allocation: "revenue" },
        }),
      ],
    });

    for (const [startDate, endDate, days] of [
      ["2026-02-01", "2026-02-28", 28],
      ["2026-03-01", "2026-03-31", 31],
      ["2026-09-01", "2026-09-30", 30],
    ] as const) {
      const events = buildPeriodLedger({
        structure: monthly,
        window: { startDate, endDate, days },
        reportingCurrency: REPORTING_CURRENCY,
      });
      // The operator typed 30,000 a month; every full month charges 30,000.
      expect(events[0]?.amount).toBe(30_000);
    }

    // A window across two months takes each month's own share.
    const across = buildPeriodLedger({
      structure: monthly,
      window: { startDate: "2026-02-15", endDate: "2026-03-14", days: 28 },
      reportingCurrency: REPORTING_CURRENCY,
    });
    expect(across[0]?.amount).toBeCloseTo(30_000 * (14 / 28 + 14 / 31), 2);
  });

  it("does not let a miscategorised retainer be charged on top of ad spend", () => {
    const events = buildPeriodLedger({
      structure: structure({
        components: [
          component({
            id: "agency",
            family: "marketing_paid",
            recognition: "on_period",
            basis: { kind: "period_amount", amount: 5_000, period: "month", allocation: "equal" },
          }),
        ],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(events).toEqual([]);
  });

  it("distinguishes a corrupt amount from a currency it cannot convert", () => {
    const events = buildPeriodLedger({
      structure: structure({
        components: [
          component({
            id: "rent",
            family: "overhead_fixed",
            recognition: "on_period",
            basis: { kind: "period_amount", amount: Number.NaN, period: "month", allocation: "equal" },
          }),
        ],
      }),
      window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
      reportingCurrency: REPORTING_CURRENCY,
    });

    expect(events[0]?.state).toBe("unavailable");
    expect(events[0]?.reasons).toContain("period_amount_not_finite");
    expect(events[0]?.reasons.some((reason) => reason.startsWith("currency_unconvertible"))).toBe(false);
  });

  it("charges nothing when the window dates or the component times are unreadable", () => {
    const rent = component({
      id: "rent",
      family: "overhead_fixed",
      recognition: "on_period",
      basis: { kind: "period_amount", amount: 30_000, period: "month", allocation: "revenue" },
    });

    expect(
      buildPeriodLedger({
        structure: structure({ components: [rent] }),
        window: { startDate: "not-a-date", endDate: "2026-09-30", days: 30 },
        reportingCurrency: REPORTING_CURRENCY,
      }),
    ).toEqual([]);

    expect(
      buildPeriodLedger({
        structure: structure({ components: [component({ ...rent, recordedAt: "2026-13-01" })] }),
        window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
        reportingCurrency: REPORTING_CURRENCY,
      }),
    ).toEqual([]);
  });

  it("refuses a replay it cannot pin to an instant", () => {
    expect(() =>
      buildPeriodLedger({
        structure: structure({ components: [] }),
        window: { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 },
        reportingCurrency: REPORTING_CURRENCY,
        asOfRecordedAt: "oops",
      }),
    ).toThrow(/asOfRecordedAt/);
  });
});
