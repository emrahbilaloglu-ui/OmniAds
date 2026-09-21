import { describe, expect, it } from "vitest";

import {
  allocationWeight,
  basisLevel,
  evaluateBasis,
  type BasisAmount,
  type BasisDependencies,
  type BomChildCost,
} from "@/lib/commerce-cost/basis";
import { REPORTING_CURRENCY, component, line, order } from "@/lib/commerce-cost/__tests__/fixtures";
import {
  COST_BASES,
  COST_BASIS_KINDS,
  COST_LINE_BASES,
  type CostBasis,
  type CostBasisKind,
  type CostBomComponent,
  type CostLineContext,
  type CostOrderContext,
} from "@/src/types/commerce-cost";

/**
 * Unit tests for the basis evaluator.
 *
 * The single rule this module exists to protect: it never invents a number. A
 * percentage of a base nobody supplied, a rate table with no matching row and
 * an unweighed parcel must all come back as `amount: null` with a reason, so
 * the resolver can report "unknown" instead of a plausible-looking zero. Most
 * of what follows is that rule, checked once per escape hatch.
 */

const OTHER_CURRENCY = "USD";

/** One representative basis per kind, so `basisLevel` can be swept for real. */
const BASIS_BY_KIND: Record<CostBasisKind, CostBasis> = {
  amount_per_unit: { kind: "amount_per_unit", amount: 1 },
  amount_per_line: { kind: "amount_per_line", amount: 1 },
  amount_per_order: { kind: "amount_per_order", amount: 1, allocation: "equal" },
  percent_of_base: { kind: "percent_of_base", percent: 1, base: "line_net_sales" },
  percent_plus_fixed: {
    kind: "percent_plus_fixed",
    percent: 1,
    base: "line_net_sales",
    fixedAmount: 1,
  },
  rate_table: { kind: "rate_table", level: "order", rows: [{ amount: 1 }] },
  bom: { kind: "bom", components: [{ quantity: 1, amount: 1 }] },
  period_amount: { kind: "period_amount", amount: 1, period: "month", allocation: "equal" },
  margin_input: {
    kind: "margin_input",
    marginKind: "gross",
    marginPercent: 10,
    base: "line_net_sales",
  },
};

/**
 * Evaluates one basis against the boring fixture order/line, so every test
 * states only the thing it is about. `line: null` is passed through on purpose
 * (an order-level evaluation has no line), hence the `undefined` check.
 */
function evaluate(args: {
  basis: CostBasis;
  currency?: string;
  order?: CostOrderContext;
  line?: CostLineContext | null;
  scopeContext?: Map<string, string[]>;
  deps?: Partial<BasisDependencies>;
}): BasisAmount {
  return evaluateBasis({
    component: component({
      basis: args.basis,
      currency: args.currency ?? REPORTING_CURRENCY,
    }),
    order: args.order ?? order(),
    line: args.line === undefined ? line() : args.line,
    scopeContext: args.scopeContext ?? new Map<string, string[]>(),
    deps: { reportingCurrency: REPORTING_CURRENCY, ...args.deps },
  });
}

function childCost(overrides: Partial<BomChildCost> = {}): BomChildCost {
  return { amount: 10, estimated: false, reasons: [], ...overrides };
}

function bomChild(overrides: Partial<CostBomComponent> = {}): CostBomComponent {
  return { sku: "CHILD-1", quantity: 1, ...overrides };
}

// ---------------------------------------------------------------------------
// basisLevel
// ---------------------------------------------------------------------------

describe("basisLevel", () => {
  // The resolver switches on this value to decide whether it must allocate, so
  // a kind that falls through the switch (returning undefined) would silently
  // book an order-level cost onto one line.
  it("answers for every declared basis kind", () => {
    for (const kind of COST_BASIS_KINDS) {
      expect(["order", "line", "period"]).toContain(basisLevel(BASIS_BY_KIND[kind]));
    }
  });

  it("treats a recurring amount as period, not as order or line", () => {
    expect(basisLevel({ kind: "period_amount", amount: 99, period: "month", allocation: "equal" }))
      .toBe("period");
  });

  it("is period for period_amount and nothing else", () => {
    const periodKinds = COST_BASIS_KINDS.filter(
      (kind) => basisLevel(BASIS_BY_KIND[kind]) === "period",
    );
    expect(periodKinds).toEqual(["period_amount"]);
  });

  it("is line for per-unit, per-line and BOM bases", () => {
    expect(basisLevel({ kind: "amount_per_unit", amount: 5 })).toBe("line");
    expect(basisLevel({ kind: "amount_per_line", amount: 5 })).toBe("line");
    expect(basisLevel({ kind: "bom", components: [bomChild({ amount: 1 })] })).toBe("line");
  });

  it("is order for a per-order amount", () => {
    expect(basisLevel({ kind: "amount_per_order", amount: 5, allocation: "equal" })).toBe("order");
  });

  // A unit-level rate table is priced per item shipped; an order-level one
  // prices the parcel once and has to be spread across the lines in it.
  it("is line for a unit rate table and order for an order rate table", () => {
    expect(basisLevel({ kind: "rate_table", level: "unit", rows: [{ amount: 3 }] })).toBe("line");
    expect(basisLevel({ kind: "rate_table", level: "order", rows: [{ amount: 3 }] })).toBe("order");
  });

  // The base decides the level, not the kind: 2.9% of line net sales is a line
  // cost, 2.9% of the captured payment is one number for the whole order.
  it("derives the level of a percent basis from its base", () => {
    expect(basisLevel({ kind: "percent_of_base", percent: 2.9, base: "line_net_sales" })).toBe(
      "line",
    );
    expect(
      basisLevel({ kind: "percent_of_base", percent: 2.9, base: "order_payment_captured" }),
    ).toBe("order");
  });

  it("derives the level of percent_of_base from COST_LINE_BASES for every base", () => {
    for (const base of COST_BASES) {
      const expected = COST_LINE_BASES.includes(base) ? "line" : "order";
      expect(basisLevel({ kind: "percent_of_base", percent: 1, base })).toBe(expected);
    }
  });

  it("derives the level of percent_plus_fixed from its base", () => {
    for (const base of COST_BASES) {
      const expected = COST_LINE_BASES.includes(base) ? "line" : "order";
      expect(basisLevel({ kind: "percent_plus_fixed", percent: 1, base, fixedAmount: 1 })).toBe(
        expected,
      );
    }
  });

  it("derives the level of margin_input from its base", () => {
    for (const base of COST_BASES) {
      const expected = COST_LINE_BASES.includes(base) ? "line" : "order";
      expect(
        basisLevel({ kind: "margin_input", marginKind: "gross", marginPercent: 40, base }),
      ).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixed amounts
// ---------------------------------------------------------------------------

describe("evaluateBasis: fixed amounts", () => {
  it("multiplies a per-unit amount by the line quantity", () => {
    const result = evaluate({
      basis: { kind: "amount_per_unit", amount: 12.5 },
      line: line({ quantity: 3 }),
    });
    expect(result).toEqual({
      amount: 37.5,
      currency: REPORTING_CURRENCY,
      level: "line",
      estimated: false,
      reasons: [],
    });
  });

  // Zero units is a real answer (a fully refunded line still exists), and it
  // must be 0 rather than null: null would be reported as unknown cost.
  it("returns zero, not unknown, for a zero-quantity line", () => {
    const result = evaluate({
      basis: { kind: "amount_per_unit", amount: 12.5 },
      line: line({ quantity: 0 }),
    });
    expect(result.amount).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  // With no line there are no units, so a per-unit cost is zero rather than a
  // stray full-price charge.
  it("treats an absent line as zero units", () => {
    const result = evaluate({ basis: { kind: "amount_per_unit", amount: 12.5 }, line: null });
    expect(result.amount).toBe(0);
  });

  it("rounds a per-unit amount to cents", () => {
    const result = evaluate({
      basis: { kind: "amount_per_unit", amount: 0.1 },
      line: line({ quantity: 3 }),
    });
    // 0.1 * 3 is 0.30000000000000004 in binary floating point.
    expect(result.amount).toBe(0.3);
  });

  it("charges a per-line amount once, whatever the quantity", () => {
    const result = evaluate({
      basis: { kind: "amount_per_line", amount: 4.25 },
      line: line({ quantity: 7 }),
    });
    expect(result.amount).toBe(4.25);
    expect(result.level).toBe("line");
  });

  it("returns a per-order amount at order level so the caller allocates it", () => {
    const result = evaluate({
      basis: { kind: "amount_per_order", amount: 19.9, allocation: "units" },
      line: line({ quantity: 7 }),
    });
    expect(result.amount).toBe(19.9);
    expect(result.level).toBe("order");
  });

  // A stated amount is money in the component's own currency; the FX step
  // happens later in the resolver, and mislabelling it here would convert twice
  // or not at all.
  it("reports a fixed amount in the component currency, not the order currency", () => {
    const result = evaluate({
      basis: { kind: "amount_per_unit", amount: 10 },
      currency: OTHER_CURRENCY,
      order: order({ currency: REPORTING_CURRENCY }),
    });
    expect(result.currency).toBe(OTHER_CURRENCY);
  });

  it("never marks a stated amount as estimated", () => {
    for (const basis of [
      { kind: "amount_per_unit", amount: 1 } as const,
      { kind: "amount_per_line", amount: 1 } as const,
      { kind: "amount_per_order", amount: 1, allocation: "equal" } as const,
    ]) {
      expect(evaluate({ basis }).estimated).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// percent_of_base
// ---------------------------------------------------------------------------

describe("evaluateBasis: percent_of_base", () => {
  it("takes a percentage of a line base at line level", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      line: line({ bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(29);
    expect(result.level).toBe("line");
  });

  it("takes a percentage of an order base at order level", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "order_total_incl_tax" },
    });
    // The fixture order carries order_total_incl_tax = 1200.
    expect(result.amount).toBe(34.8);
    expect(result.level).toBe("order");
  });

  // A percentage is a percentage OF the supplied revenue, which is denominated
  // in the order's currency. Stamping it with the component currency would make
  // the resolver convert an already-correct number.
  it("reports a percentage in the order currency, not the component currency", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 10, base: "line_net_sales" },
      currency: OTHER_CURRENCY,
      order: order({ currency: REPORTING_CURRENCY }),
    });
    expect(result.currency).toBe(REPORTING_CURRENCY);
  });

  it("rounds to cents", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 33.333, base: "line_net_sales" },
      line: line({ bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(333.33);
  });

  it("returns zero for a zero percent", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 0, base: "line_net_sales" },
    });
    expect(result.amount).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  // The honesty rule. Everything below is the same rule seen from a different
  // angle: no base, no number.
  it("refuses when the line base was not supplied", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      line: line({ bases: undefined }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:line_net_sales"]);
    expect(result.level).toBe("line");
  });

  it("refuses when the line base is explicitly null", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      line: line({ bases: { line_net_sales: null } }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:line_net_sales"]);
  });

  it("refuses when the base is a non-finite number", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      line: line({ bases: { line_net_sales: Number.NaN } }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:line_net_sales"]);
  });

  it("refuses when there is no line at all and the base is a line base", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      line: null,
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:line_net_sales"]);
  });

  it("refuses at order level when the order base was not supplied", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "order_payment_captured" },
      order: order({ bases: {} }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:order_payment_captured"]);
    expect(result.level).toBe("order");
  });

  // Never substitute a base for another one. An order total sitting right there
  // is not a line's net sales, and quietly using it would understate per-line
  // margin on multi-line orders.
  it("does not fall back to an order base when a line base is missing", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      order: order({ bases: { order_net_product_sales: 5000, order_total_incl_tax: 5000 } }),
      line: line({ bases: {} }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:line_net_sales"]);
  });

  it("does not fall back to a line base when an order base is missing", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "order_net_product_sales" },
      order: order({ bases: {} }),
      line: line({ bases: { line_net_sales: 5000 } }),
    });
    expect(result.amount).toBeNull();
  });

  it("still reports the order currency when it refuses", () => {
    const result = evaluate({
      basis: { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      currency: OTHER_CURRENCY,
      order: order({ currency: "EUR" }),
      line: line({ bases: {} }),
    });
    expect(result.currency).toBe("EUR");
  });
});

// ---------------------------------------------------------------------------
// percent_plus_fixed
// ---------------------------------------------------------------------------

describe("evaluateBasis: percent_plus_fixed", () => {
  // The classic payment-processing shape: 2.9% + 0.30 per order.
  it("adds the fixed part once per order by default", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
      },
      line: line({ quantity: 3, bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(29.3);
  });

  it("adds the fixed part once per order when fixedPer is stated as order", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
        fixedPer: "order",
      },
      line: line({ quantity: 3, bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(29.3);
  });

  it("multiplies the fixed part by the quantity when fixedPer is unit", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
        fixedPer: "unit",
      },
      line: line({ quantity: 3, bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(29.9);
  });

  it("charges no fixed part per unit on a zero-quantity line", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
        fixedPer: "unit",
      },
      line: line({ quantity: 0, bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(29);
  });

  it("works on an order base at order level", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "order_total_incl_tax",
        fixedAmount: 0.3,
      },
    });
    expect(result.amount).toBe(35.1);
    expect(result.level).toBe("order");
  });

  // The percentage lands in the order currency and the fixed part in the
  // component currency. Adding them would be adding unlike money, so the
  // evaluator refuses instead of producing a number that looks fine.
  it("refuses when the component currency differs from the order currency", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
      },
      currency: OTHER_CURRENCY,
      order: order({ currency: REPORTING_CURRENCY }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["percent_plus_fixed_currency_mismatch"]);
    expect(result.currency).toBe(REPORTING_CURRENCY);
  });

  // The mismatch check runs before the base check, so a mixed-currency setup
  // reports the mismatch even when the base is also missing.
  it("reports the currency mismatch ahead of a missing base", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
      },
      currency: OTHER_CURRENCY,
      line: line({ bases: {} }),
    });
    expect(result.reasons).toEqual(["percent_plus_fixed_currency_mismatch"]);
  });

  it("compares currencies case-insensitively rather than refusing on casing", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
      },
      currency: REPORTING_CURRENCY.toLowerCase(),
      order: order({ currency: REPORTING_CURRENCY }),
    });
    expect(result.amount).toBe(29.3);
    expect(result.reasons).toEqual([]);
  });

  it("refuses when the base is unavailable and the currencies agree", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
      },
      line: line({ bases: {} }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:line_net_sales"]);
  });

  // Not "0.30 is close enough": without the base there is no percentage part,
  // so the fixed part alone is not the cost.
  it("does not fall back to the fixed part alone when the base is unavailable", () => {
    const result = evaluate({
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "line_net_sales",
        fixedAmount: 0.3,
      },
      line: line({ bases: {} }),
    });
    expect(result.amount).not.toBe(0.3);
    expect(result.amount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rate_table
// ---------------------------------------------------------------------------

describe("evaluateBasis: rate_table", () => {
  it("returns the first matching row", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [{ amount: 40 }, { amount: 90 }],
      },
    });
    expect(result.amount).toBe(40);
    expect(result.reasons).toEqual([]);
    expect(result.level).toBe("order");
  });

  it("returns the rate in the component currency", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "order", rows: [{ amount: 40 }] },
      currency: OTHER_CURRENCY,
    });
    expect(result.currency).toBe(OTHER_CURRENCY);
  });

  it("skips a row whose when-predicate does not match the context", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { when: [{ dimension: "shipping_method", operator: "in", values: ["express"] }], amount: 90 },
          { when: [{ dimension: "shipping_method", operator: "in", values: ["standard"] }], amount: 40 },
        ],
      },
      scopeContext: new Map([["shipping_method", ["standard"]]]),
    });
    expect(result.amount).toBe(40);
  });

  // An unknown dimension must not pull in a dimension-specific rate: not
  // knowing the shipping method is not evidence that it was express.
  it("skips a conditional row when the dimension is unknown", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { when: [{ dimension: "shipping_method", operator: "in", values: ["express"] }], amount: 90 },
          { amount: 40 },
        ],
      },
      scopeContext: new Map(),
    });
    expect(result.amount).toBe(40);
  });

  it("treats an empty when-array as unconditional", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "order", rows: [{ when: [], amount: 40 }] },
    });
    expect(result.amount).toBe(40);
  });

  it("matches an exists predicate when the dimension is present", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { when: [{ dimension: "discount_code", operator: "exists" }], amount: 15 },
          { amount: 40 },
        ],
      },
      scopeContext: new Map([["discount_code", ["welcome10"]]]),
    });
    expect(result.amount).toBe(15);
  });

  it("applies a not_in predicate", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { when: [{ dimension: "market", operator: "not_in", values: ["tr"] }], amount: 90 },
          { amount: 40 },
        ],
      },
      scopeContext: new Map([["market", ["tr"]]]),
    });
    expect(result.amount).toBe(40);
  });

  // The weight bound is documented as inclusive: a parcel weighing exactly the
  // bound belongs in that bracket, not the next one up.
  it("treats weightMaxKg as an inclusive upper bound", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { weightMaxKg: 1, amount: 30 },
          { weightMaxKg: 5, amount: 60 },
        ],
      },
      order: order({ weightKg: 1 }),
    });
    expect(result.amount).toBe(30);
  });

  it("falls to the next bracket when the weight exceeds the bound", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { weightMaxKg: 1, amount: 30 },
          { weightMaxKg: 5, amount: 60 },
        ],
      },
      order: order({ weightKg: 1.0001 }),
    });
    expect(result.amount).toBe(60);
  });

  it("matches an unbounded row regardless of weight", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { weightMaxKg: 1, amount: 30 },
          { weightMaxKg: null, amount: 120 },
        ],
      },
      order: order({ weightKg: 99 }),
    });
    expect(result.amount).toBe(120);
  });

  // A weight-banded rate cannot be guessed from an unweighed parcel. The row is
  // skipped and the reason says why, rather than the lightest band winning.
  it("cannot match a weight-banded row when the weight is unknown", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [{ weightMaxKg: 1, amount: 30 }],
      },
      order: order({ weightKg: null }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["weight_unknown", "rate_table_no_match"]);
  });

  it("reports weight_unknown for each weight-banded row it had to skip", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { weightMaxKg: 1, amount: 30 },
          { weightMaxKg: 5, amount: 60 },
        ],
      },
      order: order({ weightKg: undefined }),
    });
    expect(result.reasons).toEqual(["weight_unknown", "weight_unknown", "rate_table_no_match"]);
  });

  // The unweighed parcel still gets a rate from an unbanded row, but the
  // skipped band is reported so the number is not mistaken for an exact match.
  it("keeps weight_unknown on the reasons when a later unbanded row matches", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { weightMaxKg: 1, amount: 30 },
          { amount: 45 },
        ],
      },
      order: order({ weightKg: null }),
    });
    expect(result.amount).toBe(45);
    expect(result.reasons).toEqual(["weight_unknown"]);
  });

  it("refuses when a non-finite weight is supplied", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "order", rows: [{ weightMaxKg: 5, amount: 30 }] },
      order: order({ weightKg: Number.NaN }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toContain("weight_unknown");
  });

  it("reads the order weight for an order-level table", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "order", rows: [{ weightMaxKg: 2, amount: 30 }] },
      order: order({ weightKg: 2 }),
      line: line({ weightKg: 99 }),
    });
    expect(result.amount).toBe(30);
  });

  it("reads the line weight for a unit-level table", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "unit", rows: [{ weightMaxKg: 2, amount: 30 }] },
      order: order({ weightKg: 99 }),
      line: line({ weightKg: 2, quantity: 1 }),
    });
    expect(result.amount).toBe(30);
    expect(result.level).toBe("line");
  });

  it("multiplies a matched unit-level rate by the quantity", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "unit", rows: [{ amount: 7.5 }] },
      line: line({ quantity: 4 }),
    });
    expect(result.amount).toBe(30);
  });

  it("refuses with rate_table_no_match when nothing matches and there is no fallback", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [
          { when: [{ dimension: "market", operator: "in", values: ["de"] }], amount: 90 },
        ],
      },
      scopeContext: new Map([["market", ["tr"]]]),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["rate_table_no_match"]);
  });

  it("refuses when the fallback is explicitly null", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [{ weightMaxKg: 1, amount: 30 }],
        fallbackAmount: null,
      },
      order: order({ weightKg: 10 }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["rate_table_no_match"]);
  });

  // A fallback is a deliberate operator statement ("anything else costs this"),
  // so using it is allowed — but it is labelled, because it is not a match.
  it("uses the fallback and labels it when nothing matches", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [{ weightMaxKg: 1, amount: 30 }],
        fallbackAmount: 150,
      },
      order: order({ weightKg: 10 }),
    });
    expect(result.amount).toBe(150);
    expect(result.reasons).toEqual(["rate_table_fallback"]);
  });

  it("multiplies the fallback by the quantity on a unit-level table", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "unit",
        rows: [{ weightMaxKg: 1, amount: 30 }],
        fallbackAmount: 12.5,
      },
      line: line({ quantity: 4, weightKg: 10 }),
    });
    expect(result.amount).toBe(50);
    expect(result.reasons).toEqual(["rate_table_fallback"]);
  });

  it("keeps the lookup reasons alongside the fallback label", () => {
    const result = evaluate({
      basis: {
        kind: "rate_table",
        level: "order",
        rows: [{ weightMaxKg: 1, amount: 30 }],
        fallbackAmount: 150,
      },
      order: order({ weightKg: null }),
    });
    expect(result.reasons).toEqual(["weight_unknown", "rate_table_fallback"]);
  });

  it("refuses with rate_table_empty when the table has no rows", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "order", rows: [] },
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["rate_table_empty"]);
  });

  // Documents actual behaviour: the empty-table branch hands back the raw
  // fallback and labels it rate_table_empty, without the rate_table_fallback
  // label and without the per-unit multiplication the no-match branch applies.
  it("applies the fallback of an empty unit-level table per unit, like a no-match", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "unit", rows: [], fallbackAmount: 12.5 },
      line: line({ quantity: 4 }),
    });
    expect(result.amount).toBe(50);
    expect(result.reasons).toEqual(["rate_table_empty", "rate_table_fallback"]);
  });

  it("refuses an empty table that has no fallback", () => {
    const result = evaluate({
      basis: { kind: "rate_table", level: "order", rows: [] },
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["rate_table_empty"]);
  });
});

// ---------------------------------------------------------------------------
// bom
// ---------------------------------------------------------------------------

describe("evaluateBasis: bom", () => {
  it("sums each child amount times its quantity, then times the line quantity", () => {
    const result = evaluate({
      basis: {
        kind: "bom",
        components: [bomChild({ amount: 10, quantity: 2 }), bomChild({ amount: 5, quantity: 1 })],
      },
      line: line({ quantity: 3 }),
    });
    // (10*2 + 5*1) = 25 per assembled unit, three units on the line.
    expect(result.amount).toBe(75);
    expect(result.level).toBe("line");
    expect(result.reasons).toEqual([]);
  });

  it("applies wastePercent to the assembled unit cost", () => {
    const result = evaluate({
      basis: {
        kind: "bom",
        components: [bomChild({ amount: 10, quantity: 2 }), bomChild({ amount: 5, quantity: 1 })],
        wastePercent: 10,
      },
      line: line({ quantity: 3 }),
    });
    // 25 * 1.10 = 27.5 per unit, times three units.
    expect(result.amount).toBe(82.5);
  });

  it("treats an absent or null wastePercent as zero waste", () => {
    const components = [bomChild({ amount: 10, quantity: 1 })];
    expect(evaluate({ basis: { kind: "bom", components } }).amount).toBe(10);
    expect(evaluate({ basis: { kind: "bom", components, wastePercent: null } }).amount).toBe(10);
  });

  it("returns zero for a zero-quantity line", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ amount: 10, quantity: 1 })] },
      line: line({ quantity: 0 }),
    });
    expect(result.amount).toBe(0);
  });

  it("requires conversion for a stated BOM amount in another currency", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ amount: 10, quantity: 1 })] },
      currency: OTHER_CURRENCY,
      deps: { reportingCurrency: REPORTING_CURRENCY },
    });
    expect(result.amount).toBeNull();
    expect(result.currency).toBe(REPORTING_CURRENCY);
    expect(result.reasons).toContain("bom_stated_amount_currency_unresolved");
  });

  it("sums a stated BOM amount only after conversion to reporting currency", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ amount: 10, quantity: 2 })] },
      currency: OTHER_CURRENCY,
      deps: {
        reportingCurrency: REPORTING_CURRENCY,
        convertStatedBomAmount: (amount) => childCost({ amount: amount * 30 }),
      },
    });
    expect(result.amount).toBe(600);
    expect(result.currency).toBe(REPORTING_CURRENCY);
  });

  it("resolves a child that has no stated amount through the dependency", () => {
    const seen: Array<{ sku: string | null | undefined; depth: number }> = [];
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ sku: "CAP", quantity: 2 })] },
      deps: {
        resolveChildUnitCost: (child, depth) => {
          seen.push({ sku: child.sku, depth });
          return childCost({ amount: 4 });
        },
      },
    });
    expect(result.amount).toBe(8);
    expect(seen).toEqual([{ sku: "CAP", depth: 1 }]);
  });

  // A stated amount is authoritative; re-resolving it would let a child's own
  // components silently override what the operator typed.
  it("does not call the resolver for a child with a stated amount", () => {
    let calls = 0;
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ amount: 10, quantity: 1 })] },
      deps: {
        resolveChildUnitCost: () => {
          calls += 1;
          return childCost();
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.amount).toBe(10);
  });

  // Zero is a stated cost (a free insert), not a missing one.
  it("treats a stated zero child amount as stated", () => {
    let calls = 0;
    const result = evaluate({
      basis: {
        kind: "bom",
        components: [bomChild({ amount: 0, quantity: 5 }), bomChild({ amount: 3, quantity: 1 })],
      },
      deps: {
        resolveChildUnitCost: () => {
          calls += 1;
          return childCost();
        },
      },
    });
    expect(calls).toBe(0);
    expect(result.amount).toBe(3);
  });

  it("resolves a child whose stated amount is null or non-finite", () => {
    for (const amount of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluate({
        basis: { kind: "bom", components: [bomChild({ amount, quantity: 1 })] },
        deps: { resolveChildUnitCost: () => childCost({ amount: 7 }) },
      });
      expect(result.amount).toBe(7);
    }
  });

  // A BOM whose children cannot be priced has no cost, not a partial cost:
  // summing only the children that resolved would understate the product.
  it("refuses when no resolver is supplied for a child without an amount", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ quantity: 1 })] },
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["bom_child_unresolved"]);
  });

  it("refuses when the resolver cannot price a child, and keeps its reasons", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ quantity: 1 })] },
      deps: {
        resolveChildUnitCost: () =>
          childCost({ amount: null, reasons: ["child_component_missing"] }),
      },
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["bom_child_unresolved", "child_component_missing"]);
    expect(result.estimated).toBe(false);
  });

  it("refuses the whole assembly when only one of several children is unresolved", () => {
    const result = evaluate({
      basis: {
        kind: "bom",
        components: [bomChild({ amount: 10, quantity: 1 }), bomChild({ sku: "CAP", quantity: 1 })],
      },
      deps: { resolveChildUnitCost: () => childCost({ amount: null }) },
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["bom_child_unresolved"]);
  });

  // The refusal must not cost us the audit trail: why the earlier children
  // resolved the way they did is still part of the explanation.
  it("keeps the reasons of earlier resolved children when a later one fails", () => {
    const result = evaluate({
      basis: {
        kind: "bom",
        components: [bomChild({ sku: "A", quantity: 1 }), bomChild({ sku: "B", quantity: 1 })],
      },
      deps: {
        resolveChildUnitCost: (child) =>
          child.sku === "A"
            ? childCost({ amount: 4, reasons: ["a_from_template"] })
            : childCost({ amount: null, reasons: ["b_missing"] }),
      },
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["a_from_template", "bom_child_unresolved", "b_missing"]);
  });

  // An assembly is only as good as its worst child: one estimated part makes
  // the whole product cost an estimate, which drives the truth grade.
  it("propagates the estimated flag from a child", () => {
    const result = evaluate({
      basis: {
        kind: "bom",
        components: [bomChild({ amount: 10, quantity: 1 }), bomChild({ sku: "CAP", quantity: 1 })],
      },
      deps: { resolveChildUnitCost: () => childCost({ amount: 4, estimated: true }) },
    });
    expect(result.amount).toBe(14);
    expect(result.estimated).toBe(true);
  });

  it("stays exact when every resolved child is exact", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ quantity: 1 })] },
      deps: { resolveChildUnitCost: () => childCost({ amount: 4, estimated: false }) },
    });
    expect(result.estimated).toBe(false);
  });

  it("collects the reasons of resolved children", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ quantity: 1 })] },
      deps: {
        resolveChildUnitCost: () => childCost({ amount: 4, reasons: ["child_from_template"] }),
      },
    });
    expect(result.reasons).toEqual(["child_from_template"]);
  });

  it("refuses an empty bill of materials", () => {
    const result = evaluate({ basis: { kind: "bom", components: [] } });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["bom_empty"]);
    expect(result.currency).toBe(REPORTING_CURRENCY);
    expect(result.level).toBe("line");
  });

  // The depth cap stops a cyclic or pathologically deep bill of materials from
  // recursing forever; it refuses rather than returning a truncated sum.
  it("refuses when the depth cap is already reached", () => {
    let calls = 0;
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ quantity: 1 })] },
      deps: {
        depth: 8,
        resolveChildUnitCost: () => {
          calls += 1;
          return childCost();
        },
      },
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["bom_depth_exceeded"]);
    expect(calls).toBe(0);
  });

  it("still evaluates one level below the cap and hands the child the next depth", () => {
    const depths: number[] = [];
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ quantity: 1 })] },
      deps: {
        depth: 7,
        resolveChildUnitCost: (_child, depth) => {
          depths.push(depth);
          return childCost({ amount: 5 });
        },
      },
    });
    expect(result.amount).toBe(5);
    expect(depths).toEqual([8]);
  });

  it("treats an absent depth as zero", () => {
    const depths: number[] = [];
    evaluate({
      basis: { kind: "bom", components: [bomChild({ quantity: 1 })] },
      deps: {
        resolveChildUnitCost: (_child, depth) => {
          depths.push(depth);
          return childCost();
        },
      },
    });
    expect(depths).toEqual([1]);
  });

  it("rounds the assembled amount to cents", () => {
    const result = evaluate({
      basis: { kind: "bom", components: [bomChild({ amount: 0.1, quantity: 1 })] },
      line: line({ quantity: 3 }),
    });
    expect(result.amount).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// margin_input
// ---------------------------------------------------------------------------

describe("evaluateBasis: margin_input", () => {
  // An operator who states "we run 35% gross margin" has implied the cost of
  // every family that margin covers. The number is labelled as implied so the
  // ladder never presents it as an observation.
  it("implies the cost from the stated margin", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 35,
        base: "line_net_sales",
      },
      line: line({ bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(650);
    expect(result.reasons).toEqual(["implied_from_margin"]);
    expect(result.level).toBe("line");
    expect(result.currency).toBe(REPORTING_CURRENCY);
  });

  it("implies zero cost from a 100% margin", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 100,
        base: "line_net_sales",
      },
      line: line({ bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(0);
    expect(result.reasons).toEqual(["implied_from_margin"]);
  });

  it("implies the whole base as cost from a zero margin", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "contribution",
        marginPercent: 0,
        base: "line_net_sales",
      },
      line: line({ bases: { line_net_sales: 1000 } }),
    });
    expect(result.amount).toBe(1000);
  });

  it("works on an order base at order level", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 40,
        base: "order_net_product_sales",
      },
    });
    expect(result.amount).toBe(600);
    expect(result.level).toBe("order");
  });

  it("reports the margin-implied cost in the order currency", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 40,
        base: "line_net_sales",
      },
      currency: OTHER_CURRENCY,
      order: order({ currency: "EUR" }),
    });
    expect(result.currency).toBe("EUR");
  });

  // A margin without revenue to apply it to is not a cost. This is the same
  // honesty rule as percent_of_base.
  it("refuses when the base is unavailable", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 35,
        base: "line_net_sales",
      },
      line: line({ bases: {} }),
    });
    expect(result.amount).toBeNull();
    expect(result.reasons).toEqual(["base_unavailable:line_net_sales"]);
  });

  it("does not claim implied_from_margin when it could not imply anything", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 35,
        base: "order_payment_captured",
      },
      order: order({ bases: {} }),
    });
    expect(result.reasons).not.toContain("implied_from_margin");
  });

  it("never marks a margin-implied cost as estimated on this hop", () => {
    const result = evaluate({
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 35,
        base: "line_net_sales",
      },
    });
    expect(result.estimated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// period_amount
// ---------------------------------------------------------------------------

describe("evaluateBasis: period_amount", () => {
  // A monthly subscription fee is not a cost of the order that happened to
  // arrive today. It has to be prorated over a window by a different path, so
  // the order-scoped evaluator refuses it outright.
  it("refuses to turn a recurring amount into an order cost", () => {
    const result = evaluate({
      basis: { kind: "period_amount", amount: 990, period: "month", allocation: "equal" },
    });
    expect(result).toEqual({
      amount: null,
      currency: REPORTING_CURRENCY,
      level: "order",
      estimated: false,
      reasons: ["period_component_not_order_scoped"],
    });
  });

  it("refuses for every period, not just monthly", () => {
    for (const period of ["day", "week", "month", "year"] as const) {
      const result = evaluate({
        basis: { kind: "period_amount", amount: 990, period, allocation: "units" },
      });
      expect(result.amount).toBeNull();
      expect(result.reasons).toEqual(["period_component_not_order_scoped"]);
    }
  });

  it("reports the refusal in the component currency", () => {
    const result = evaluate({
      basis: { kind: "period_amount", amount: 990, period: "month", allocation: "equal" },
      currency: OTHER_CURRENCY,
    });
    expect(result.currency).toBe(OTHER_CURRENCY);
  });
});

// ---------------------------------------------------------------------------
// allocationWeight
// ---------------------------------------------------------------------------

describe("allocationWeight", () => {
  it("weights by line net sales for the revenue driver", () => {
    expect(allocationWeight("revenue", line({ bases: { line_net_sales: 250 } }))).toBe(250);
  });

  // Gross is the honest second-best when net has not been computed; it is the
  // same revenue measured before discounts, not a different quantity.
  it("falls back to gross sales when net sales is absent", () => {
    expect(allocationWeight("revenue", line({ bases: { line_gross_sales: 400 } }))).toBe(400);
  });

  it("falls back to gross sales when net sales is null", () => {
    expect(
      allocationWeight(
        "revenue",
        line({ bases: { line_net_sales: null, line_gross_sales: 400 } }),
      ),
    ).toBe(400);
  });

  // A line that genuinely sold for nothing (a 100%-off gift) takes no share of
  // a revenue-driven cost; it does not silently inherit the gross figure.
  it("weights a zero net-sales line at zero without falling back to gross", () => {
    expect(
      allocationWeight("revenue", line({ bases: { line_net_sales: 0, line_gross_sales: 400 } })),
    ).toBe(0);
  });

  it("weights a negative revenue line at zero", () => {
    expect(allocationWeight("revenue", line({ bases: { line_net_sales: -50 } }))).toBe(0);
  });

  it("weights a non-finite revenue at zero", () => {
    expect(allocationWeight("revenue", line({ bases: { line_net_sales: Number.NaN } }))).toBe(0);
  });

  it("weights a line with no bases at zero for revenue", () => {
    expect(allocationWeight("revenue", line({ bases: undefined }))).toBe(0);
  });

  it("weights by quantity for the units driver", () => {
    expect(allocationWeight("units", line({ quantity: 4 }))).toBe(4);
  });

  it("weights a zero, negative or non-finite quantity at zero", () => {
    expect(allocationWeight("units", line({ quantity: 0 }))).toBe(0);
    expect(allocationWeight("units", line({ quantity: -2 }))).toBe(0);
    expect(allocationWeight("units", line({ quantity: Number.NaN }))).toBe(0);
  });

  it("weights by line weight for the weight driver", () => {
    expect(allocationWeight("weight", line({ weightKg: 2.5 }))).toBe(2.5);
  });

  // An unweighed line takes no share of a weight-driven cost. The money still
  // lands, because the allocator falls back to an equal split when every weight
  // is zero — it is never invented here.
  it("weights a missing, null, zero or negative weight at zero", () => {
    expect(allocationWeight("weight", line({ weightKg: undefined }))).toBe(0);
    expect(allocationWeight("weight", line({ weightKg: null }))).toBe(0);
    expect(allocationWeight("weight", line({ weightKg: 0 }))).toBe(0);
    expect(allocationWeight("weight", line({ weightKg: -1 }))).toBe(0);
  });

  it("weights every line equally for the orders and equal drivers", () => {
    const rich = line({ quantity: 9, weightKg: 12, bases: { line_net_sales: 9000 } });
    const bare = line({ quantity: 0, weightKg: null, bases: {} });
    for (const driver of ["orders", "equal"] as const) {
      expect(allocationWeight(driver, rich)).toBe(1);
      expect(allocationWeight(driver, bare)).toBe(1);
    }
  });

  it("answers for every allocation driver", () => {
    for (const driver of ["revenue", "units", "orders", "weight", "equal"] as const) {
      expect(Number.isFinite(allocationWeight(driver, line()))).toBe(true);
    }
  });
});
