import { describe, expect, it } from "vitest";

import type {
  CommerceCostStructure,
  CostLedgerEvent,
  CostResolutionResult,
} from "@/src/types/commerce-cost";
import { buildEconomicsLadder, summarizeCostCoverage } from "./ladder";
import { buildPeriodLedger, buildRefundLedger, buildSaleLedger } from "./ledger";
import { resolveOrderCosts } from "./resolver";
import { REPORTING_CURRENCY, component, line, order, structure } from "./__tests__/fixtures";

/**
 * The ladder and what it authorises.
 *
 * Two properties matter more than the arithmetic:
 *  - A rung with a missing input is not stated. Treating an unknown cost as
 *    zero produces a number that reads as profit and gets scaled.
 *  - A confirmed target ROAS keeps its authority no matter how poor the cost
 *    truth is, so incomplete costs can never stop existing ROAS decisions.
 */

const WINDOW = { startDate: "2026-09-01", endDate: "2026-09-30", days: 30 };

function completeStructure(overrides: Partial<CommerceCostStructure> = {}) {
  const components = overrides.components ?? [
    component({ id: "product", basis: { kind: "amount_per_line", amount: 300 } }),
    component({ id: "ship", family: "outbound_shipping", basis: { kind: "amount_per_line", amount: 50 } }),
    component({ id: "fee", family: "payment_processing", basis: { kind: "amount_per_line", amount: 35 } }),
  ];
  const expectedFamilies =
    overrides.expectedFamilies ??
    (overrides.components
      ? [...new Set(components.flatMap((entry) => [entry.family, ...(entry.embeds ?? [])]))]
      : undefined);
  return structure({
    ...overrides,
    components,
    ...(expectedFamilies ? { expectedFamilies } : {}),
  });
}

function windowFrom(args: {
  structure: CommerceCostStructure;
  lines?: Parameters<typeof resolveOrderCosts>[0]["lines"];
  periodEvents?: boolean;
  adSpend?: number | null;
  targetRoas?: number | null;
  aovAssumption?: number | null;
  netProductSales?: number | null;
}) {
  const resolution: CostResolutionResult = resolveOrderCosts({
    structure: args.structure,
    order: order(),
    lines: args.lines ?? [line()],
    reportingCurrency: REPORTING_CURRENCY,
  });
  const events: CostLedgerEvent[] = [
    ...buildSaleLedger(resolution),
    ...(args.periodEvents
      ? buildPeriodLedger({
          structure: args.structure,
          window: WINDOW,
          reportingCurrency: REPORTING_CURRENCY,
        })
      : []),
  ];
  const coverage = summarizeCostCoverage({ resolutions: [resolution], structure: args.structure });
  const ladder = buildEconomicsLadder({
    window: WINDOW,
    reportingCurrency: REPORTING_CURRENCY,
    structure: args.structure,
    events,
    coverage,
    revenue: {
      netProductSales: args.netProductSales === undefined ? 1000 : args.netProductSales,
      rateBase: "line_net_sales",
    },
    adSpend: args.adSpend === undefined ? 200 : args.adSpend,
    targetRoas: args.targetRoas === undefined ? 2.5 : args.targetRoas,
    aovAssumption: args.aovAssumption,
  });
  return { resolution, coverage, ladder };
}

describe("economics ladder", () => {
  it("states every rung when the cost structure is complete", () => {
    const { ladder } = windowFrom({ structure: completeStructure() });

    expect(ladder.rungs.productCost).toMatchObject({ amount: 300, state: "complete" });
    expect(ladder.rungs.preMarketingContribution).toMatchObject({ amount: 615, state: "complete" });
    expect(ladder.rungs.postMarketingContribution.amount).toBe(415);
    expect(ladder.readiness.thresholds.variableCostRate).toBeCloseTo(0.385, 10);
    expect(ladder.readiness.thresholds.breakEvenRoasSuggested).toBe(1.63);
    expect(ladder.readiness.truthGrade).toBe("A");
  });

  it("subtracts recurring costs from operating profit only, never from the marginal rate", () => {
    const withFixed = completeStructure({
      components: [
        ...completeStructure().components,
        component({
          id: "rent",
          family: "overhead_fixed",
          recognition: "on_period",
          basis: { kind: "period_amount", amount: 100_000, period: "month", allocation: "revenue" },
        }),
      ],
    });
    const { ladder } = windowFrom({ structure: withFixed, periodEvents: true });

    // A huge fixed cost must not move the marginal numbers at all.
    expect(ladder.readiness.thresholds.variableCostRate).toBeCloseTo(0.385, 10);
    expect(ladder.readiness.thresholds.breakEvenRoasSuggested).toBe(1.63);
    expect(ladder.rungs.preMarketingContribution.amount).toBe(615);
    // A whole calendar month charges exactly the stated monthly amount.
    expect(ladder.rungs.operatingProfit.amount).toBe(415 - 100_000);
    expect(ladder.families.find((family) => family.family === "overhead_fixed")?.layer).toBe("fixed");
  });

  it("refuses to state contribution while a cost family is missing", () => {
    const partial = completeStructure({
      components: [
        ...completeStructure().components,
        component({
          id: "returns",
          family: "returns_processing",
          scope: [{ dimension: "market", operator: "in", values: ["DE"] }],
          basis: { kind: "amount_per_line", amount: 10 },
        }),
      ],
    });
    const { ladder } = windowFrom({ structure: partial });

    expect(ladder.rungs.preMarketingContribution.amount).toBeNull();
    expect(ladder.rungs.preMarketingContribution.state).toBe("partial");
    expect(ladder.rungs.preMarketingContribution.missingFamilies).toContain("returns_processing");
    // What IS known stays visible.
    expect(ladder.rungs.productCost.amount).toBe(300);
    expect(ladder.families.find((entry) => entry.family === "returns_processing")?.state).toBe("unknown");
    expect(ladder.diagnostics).toContain("contribution_missing_families:returns_processing");
    expect(ladder.readiness.truthGrade).toBe("D");
  });

  it("cannot state contribution without revenue or post-marketing without ad spend", () => {
    const noRevenue = windowFrom({ structure: completeStructure(), netProductSales: null });
    expect(noRevenue.ladder.rungs.preMarketingContribution.amount).toBeNull();
    expect(noRevenue.ladder.diagnostics).toContain("net_product_sales_unavailable");

    const noSpend = windowFrom({ structure: completeStructure(), adSpend: null });
    expect(noSpend.ladder.rungs.preMarketingContribution.amount).toBe(615);
    expect(noSpend.ladder.rungs.postMarketingContribution.amount).toBeNull();
    expect(noSpend.ladder.diagnostics).toContain("ad_spend_unavailable");
  });

  it("preserves an exact zero post-marketing contribution", () => {
    const { ladder } = windowFrom({ structure: completeStructure(), adSpend: 615 });

    expect(ladder.rungs.postMarketingContribution).toMatchObject({
      amount: 0,
      state: "complete",
    });
  });

  it("does not treat an unresolved other-marketing cost as zero", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [
          ...completeStructure().components,
          component({
            id: "affiliate-fee",
            family: "marketing_other",
            basis: {
              kind: "percent_of_base",
              percent: 5,
              base: "line_gross_sales",
            },
          }),
        ],
      }),
      lines: [line({ bases: { line_net_sales: 1000 } })],
    });

    expect(ladder.rungs.preMarketingContribution.amount).toBe(615);
    expect(ladder.rungs.postMarketingContribution.amount).toBeNull();
    expect(ladder.rungs.postMarketingContribution.state).toBe("partial");
    expect(ladder.rungs.postMarketingContribution.missingFamilies).toContain("marketing_other");
  });

  it("weights coverage by revenue and counts an embedded family as covered", () => {
    const { coverage } = windowFrom({
      structure: structure({
        expectedFamilies: ["product_purchase"],
        components: [
          component({
            scope: [{ dimension: "sku", operator: "in", values: ["SKU-A"] }],
            basis: { kind: "amount_per_line", amount: 120 },
          }),
        ],
      }),
      lines: [
        line({ lineId: "a", sku: "SKU-A", bases: { line_net_sales: 700 } }),
        line({ lineId: "b", sku: "SKU-B", bases: { line_net_sales: 300 } }),
      ],
    });

    expect(coverage.productCostCoverage).toBeCloseTo(0.7, 10);
    expect(coverage.costedLineCount).toBe(1);
    expect(coverage.lineCount).toBe(2);
    expect(coverage.unknownFamilies).toContain("product_purchase");

    const embedded = windowFrom({
      structure: structure({
        expectedFamilies: ["product_purchase", "outbound_shipping"],
        components: [
          component({ basis: { kind: "amount_per_line", amount: 400 }, embeds: ["outbound_shipping"] }),
        ],
      }),
    });
    // Shipping has no number of its own, but its money is inside a cost that does.
    expect(embedded.coverage.familyCoverage?.outbound_shipping).toBe(1);
    expect(embedded.coverage.unknownFamilies).not.toContain("outbound_shipping");
  });

  it("keeps estimates visible instead of promoting them", () => {
    const { ladder, coverage } = windowFrom({
      structure: completeStructure({
        components: [
          component({ id: "product", basis: { kind: "amount_per_line", amount: 300 } }),
          component({
            id: "ship",
            family: "outbound_shipping",
            evidence: "operator_estimate",
            basis: { kind: "amount_per_line", amount: 40 },
          }),
          component({ id: "fee", family: "payment_processing", basis: { kind: "amount_per_line", amount: 35 } }),
        ],
      }),
    });

    expect(coverage.estimatedShare).toBeCloseTo(40 / 375, 6);
    expect(ladder.rungs.preMarketingContribution.estimatedAmount).toBe(40);
    expect(ladder.readiness.truthGrade).toBe("B");
  });
});

describe("decision readiness", () => {
  it("keeps a confirmed target ROAS authoritative even when cost truth is poor", () => {
    const { ladder } = windowFrom({
      structure: structure({ components: [], expectedFamilies: ["product_purchase"] }),
      targetRoas: 2.5,
    });

    expect(ladder.readiness.truthGrade).toBe("D");
    expect(ladder.readiness.thresholds.targetRoasSource).toBe("target_pack");
    // The whole point: a weak cost structure must not stop existing decisions.
    expect(ladder.readiness.gates.roas_target_scaling).toMatchObject({ allowed: true, ceiling: null });
    expect(ladder.readiness.gates.monitor).toMatchObject({ allowed: true, ceiling: null });
    expect(ladder.readiness.gates.loss_guardrail).toMatchObject({ allowed: true, ceiling: "review_reduce" });
    // Only profit-based authority degrades.
    expect(ladder.readiness.gates.profit_scaling).toMatchObject({
      allowed: false,
      ceiling: "degraded_no_scale",
    });
    expect(ladder.readiness.gates.product_margin.allowed).toBe(false);
  });

  it("falls back to the derived break-even only when it is trustworthy", () => {
    const good = windowFrom({ structure: completeStructure(), targetRoas: null });
    expect(good.ladder.readiness.thresholds.targetRoasSource).toBe("absent");
    expect(good.ladder.readiness.gates.roas_target_scaling).toMatchObject({
      allowed: true,
      ceiling: "monitor_low_truth",
    });

    const poor = windowFrom({
      structure: structure({ components: [], expectedFamilies: ["product_purchase"] }),
      targetRoas: null,
    });
    expect(poor.ladder.readiness.gates.roas_target_scaling).toMatchObject({
      allowed: false,
      ceiling: "review_hold",
    });
  });

  it("never requires a CPA or an AOV assumption", () => {
    const withAov = windowFrom({ structure: completeStructure(), aovAssumption: 500 });
    expect(withAov.ladder.readiness.thresholds.breakEvenCpaSuggested).toBe(307.5);

    const withoutAov = windowFrom({ structure: completeStructure() });
    expect(withoutAov.ladder.readiness.thresholds.breakEvenCpaSuggested).toBeNull();
    // Identical authority with and without it.
    expect(withoutAov.ladder.readiness.gates).toEqual(withAov.ladder.readiness.gates);
  });

  it("holds product-level margin decisions until product coverage is nearly complete", () => {
    const { ladder } = windowFrom({
      structure: structure({
        expectedFamilies: ["product_purchase"],
        components: [
          component({
            scope: [{ dimension: "sku", operator: "in", values: ["SKU-A"] }],
            basis: { kind: "amount_per_line", amount: 120 },
          }),
          component({ id: "zero-b", scope: [{ dimension: "sku", operator: "in", values: ["SKU-B"] }], basis: { kind: "amount_per_unit", amount: 0 } }),
        ],
      }),
      lines: [
        line({ lineId: "a", sku: "SKU-A", bases: { line_net_sales: 940 } }),
        line({ lineId: "b", sku: "SKU-B", bases: { line_net_sales: 60 } }),
      ],
    });

    // Both lines carry a stated number (one of them a real zero), so product
    // coverage is complete and product-level decisions are allowed.
    expect(ladder.coverage.productCostCoverage).toBe(1);
    expect(ladder.readiness.gates.product_margin.allowed).toBe(true);
  });

  it("caps unconfirmed and conflicting structures", () => {
    const unconfirmed = windowFrom({ structure: completeStructure({ confirmed: false }) });
    // Complete numbers whose meaning nobody confirmed are not grade A or B.
    expect(unconfirmed.ladder.readiness.truthGrade).toBe("C");
    expect(unconfirmed.ladder.readiness.gates.profit_scaling.allowed).toBe(false);

    const conflicting = windowFrom({
      structure: completeStructure({
        conflicts: [
          {
            family: "product_purchase",
            slot: "default",
            detail: "two legacy sources disagree",
            candidates: [
              { source: { kind: "legacy_import", ref: "business_cost_models" }, value: 35 },
              { source: { kind: "legacy_import", ref: "business_target_packs" }, value: 40 },
            ],
          },
        ],
      }),
    });
    expect(conflicting.ladder.readiness.truthGrade).toBe("D");
  });

  it("has only one grade, so a chip cannot disagree with the ladder", async () => {
    // A second, differently-argued grade helper reported A while the ladder
    // refused to state contribution. It is gone.
    const module = await import("./ladder");
    expect("costTruthGrade" in module).toBe(false);
  });
});

describe("ladder: what a declared decision class and tax treatment change", () => {
  it("keeps an informational cost out of every rung and says so", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [
          component({ id: "product", basis: { kind: "amount_per_line", amount: 300 } }),
          component({
            id: "allocated",
            family: "returns_loss",
            decisionClass: "informational",
            basis: { kind: "amount_per_line", amount: 200 },
          }),
        ],
      }),
    });

    // 300 of real cost, not 500: the owner said the allocation is for
    // information, so it must not move a break-even.
    expect(ladder.readiness.thresholds.variableCostRate).toBeCloseTo(0.3, 10);
    expect(ladder.rungs.preMarketingContribution.amount).toBe(700);
    expect(ladder.diagnostics).toContain("informational_excluded:returns_loss");
    // It is still reported, so nothing disappears silently.
    expect(ladder.families.find((entry) => entry.family === "returns_loss")?.amount).toBe(200);
  });

  it("keeps an operating-class variable cost out of the rate but inside operating profit", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [
          component({ id: "product", basis: { kind: "amount_per_line", amount: 300 } }),
          component({
            id: "handling",
            family: "fulfillment",
            decisionClass: "operating",
            basis: { kind: "amount_per_line", amount: 100 },
          }),
          // "We have no overheads" is stated as a nil cost, not as an
          // untracked family, so the rung can be stated at all.
          component({
            id: "no-overhead",
            family: "overhead_fixed",
            recognition: "on_period",
            basis: { kind: "period_amount", amount: 0, period: "month", allocation: "equal" },
          }),
        ],
      }),
      periodEvents: true,
    });

    expect(ladder.readiness.thresholds.variableCostRate).toBeCloseTo(0.3, 10);
    expect(ladder.rungs.preMarketingContribution.amount).toBe(700);
    // 700 − 200 ad spend − 100 operating handling.
    expect(ladder.rungs.operatingProfit.amount).toBe(400);
  });

  it("does not read a fixed cost it could not compute as zero", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [
          ...completeStructure().components,
          component({
            id: "rent",
            family: "overhead_fixed",
            recognition: "on_period",
            currency: "USD",
            fx: { policy: "transaction_date" },
            basis: { kind: "period_amount", amount: 1_000, period: "month", allocation: "revenue" },
          }),
        ],
      }),
      periodEvents: true,
    });

    expect(ladder.rungs.operatingProfit.amount).toBeNull();
    expect(ladder.rungs.operatingProfit.state).toBe("partial");
    expect(ladder.diagnostics).toContain("fixed_missing_families:overhead_fixed");
  });

  it("caps the grade when a cost's tax treatment is unknown or mixed", () => {
    const unknownTax = windowFrom({
      structure: completeStructure({
        components: [
          component({ id: "product", taxTreatment: "unknown", basis: { kind: "amount_per_line", amount: 300 } }),
        ],
      }),
    });
    // Complete numbers whose tax basis is unknown are overstated against a net
    // revenue base by the whole tax rate, and nothing here can convert them.
    expect(unknownTax.ladder.readiness.truthGrade).toBe("C");
    expect(unknownTax.ladder.diagnostics).toContain("cost_tax_treatment_unknown");

    const mixedTax = windowFrom({
      structure: completeStructure({
        components: [
          component({ id: "product", basis: { kind: "amount_per_line", amount: 300 } }),
          component({
            id: "ship",
            family: "outbound_shipping",
            taxTreatment: "gross_including_tax",
            basis: { kind: "amount_per_line", amount: 50 },
          }),
        ],
      }),
    });
    expect(mixedTax.ladder.readiness.truthGrade).toBe("C");
    expect(
      mixedTax.ladder.diagnostics.some((entry) => entry.startsWith("cost_tax_treatment_mixed")),
    ).toBe(true);
  });

  it("says when the revenue base it was given carries tax", () => {
    const resolution = resolveOrderCosts({
      structure: completeStructure(),
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
    });
    const ladder = buildEconomicsLadder({
      window: WINDOW,
      reportingCurrency: REPORTING_CURRENCY,
      structure: completeStructure(),
      events: buildSaleLedger(resolution),
      coverage: summarizeCostCoverage({ resolutions: [resolution], structure: completeStructure() }),
      revenue: { netProductSales: 1200, rateBase: "order_total_incl_tax" },
      adSpend: 200,
      targetRoas: 2.5,
    });

    expect(ladder.diagnostics).toContain("revenue_base_includes_tax:order_total_incl_tax");
  });
});

describe("ladder: refunds and stateful non-values", () => {
  it("states contribution for a window whose only cost event is a zero reversal", () => {
    const saleStructure = completeStructure();
    const sale = resolveOrderCosts({
      structure: saleStructure,
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
    });
    // A later window that contains only the non-recoverable reversal.
    const refundEvents = buildRefundLedger({
      saleResolution: sale,
      refundLines: [
        {
          refundLineId: "r1",
          lineId: "line-1",
          quantity: 1,
          restockType: "no_restock",
          refundedDate: "2026-09-25",
        },
      ],
    });
    const ladder = buildEconomicsLadder({
      window: WINDOW,
      reportingCurrency: REPORTING_CURRENCY,
      structure: saleStructure,
      events: refundEvents,
      coverage: summarizeCostCoverage({ resolutions: [sale], structure: saleStructure }),
      revenue: { netProductSales: 1000, rateBase: "line_net_sales" },
      adSpend: 200,
      targetRoas: 2.5,
    });

    // Nothing came back, which is a number: 1000 − 0.
    expect(ladder.rungs.preMarketingContribution.amount).toBe(1000);
    expect(ladder.rungs.preMarketingContribution.state).not.toBe("partial");
    expect(ladder.families.find((entry) => entry.family === "payment_processing")?.state).toBe("zero");
  });

  it("reports an embedded family as embedded, and counts its money once", () => {
    const embedded = windowFrom({
      structure: structure({
        expectedFamilies: ["product_purchase", "outbound_shipping"],
        components: [
          component({ basis: { kind: "amount_per_line", amount: 400 }, embeds: ["outbound_shipping"] }),
        ],
      }),
    });

    expect(embedded.ladder.families.find((entry) => entry.family === "outbound_shipping")?.state).toBe(
      "embedded",
    );
    // The shipping money is inside the product cost, which is in this rung.
    expect(embedded.ladder.rungs.preMarketingContribution.amount).toBe(600);
  });

  it("will not state a rung that needs a family the owner does not track", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({ notTracked: ["packaging"] }),
    });

    // An acknowledged gap is not a zero: summing it as one understated the
    // break-even at the top grade.
    expect(ladder.rungs.preMarketingContribution.amount).toBeNull();
    expect(ladder.rungs.preMarketingContribution.missingFamilies).toContain("packaging");
    expect(ladder.readiness.truthGrade).toBe("D");
    expect(ladder.readiness.gates.profit_scaling.allowed).toBe(false);
    // The ROAS path still runs on the operator's confirmed target.
    expect(ladder.readiness.gates.roas_target_scaling).toMatchObject({
      allowed: true,
      ceiling: null,
    });
  });

  it("will not state a product cost whose money sits in another rung's family", () => {
    const { ladder } = windowFrom({
      structure: structure({
        expectedFamilies: ["product_purchase", "packaging"],
        components: [
          component({
            id: "loaded-packaging",
            family: "packaging",
            basis: { kind: "amount_per_line", amount: 350 },
            embeds: ["product_purchase"],
            embeddedShares: [{ family: "product_purchase", kind: "amount_per_unit", value: 300 }],
          }),
        ],
      }),
    });

    // Reporting 0 / complete here let a product-margin decision see a 100%
    // gross margin and scale on it.
    expect(ladder.rungs.productCost.amount).toBeNull();
    expect(ladder.rungs.productCost.state).toBe("partial");
    expect(ladder.rungs.productCost.missingFamilies).toContain("product_purchase");
    expect(ladder.readiness.gates.product_margin.allowed).toBe(false);
    // The contribution rung holds the money once, inside packaging.
    expect(ladder.rungs.preMarketingContribution.amount).toBe(650);
  });
});

describe("ladder: coverage with no revenue to weight by", () => {
  it("counts lines when a window's revenue is zero", () => {
    const { coverage, ladder } = windowFrom({
      structure: structure({
        components: [
          component({
            scope: [{ dimension: "sku", operator: "in", values: ["GIFT"] }],
            basis: { kind: "amount_per_unit", amount: 45 },
          }),
        ],
      }),
      // A giveaway order: real costs, no revenue to weight them against.
      lines: [line({ sku: "GIFT", bases: { line_net_sales: 0 } })],
      netProductSales: 0,
    });

    expect(coverage.productCostCoverage).toBe(1);
    expect(coverage.totalNetSales).toBe(0);
    // The cost is known; only the margin is not.
    expect(ladder.rungs.productCost.amount).toBe(45);
    expect(ladder.readiness.thresholds.variableCostRate).toBeNull();
  });
});

describe("ladder: grading what it can and cannot see", () => {
  it("does not punish measured data for an untagged tax basis, but says so", () => {
    const untagged = windowFrom({
      structure: completeStructure(),
      lines: [
        line({
          observed: [
            {
              family: "outbound_shipping",
              amount: 50,
              currency: REPORTING_CURRENCY,
              source: { kind: "carrier_invoice" },
            },
          ],
        }),
      ],
    });

    // A carrier invoice is the best evidence there is; it must not lock the
    // business out of profit decisions because nobody tagged its VAT.
    expect(untagged.ladder.readiness.truthGrade).toBe("A");
    expect(untagged.ladder.diagnostics).toContain("cost_tax_treatment_unspecified_observed");
    expect(untagged.ladder.readiness.gates.profit_scaling.allowed).toBe(true);
  });

  it("caps the grade when the cost and revenue tax bases disagree", () => {
    const resolution = resolveOrderCosts({
      structure: completeStructure(),
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
    });
    const ladder = buildEconomicsLadder({
      window: WINDOW,
      reportingCurrency: REPORTING_CURRENCY,
      structure: completeStructure(),
      events: buildSaleLedger(resolution),
      coverage: summarizeCostCoverage({ resolutions: [resolution], structure: completeStructure() }),
      // Costs net of tax, revenue base carrying it: the rate is understated by
      // about the tax rate, which is the same error the cost-side rule catches.
      revenue: { netProductSales: 1200, rateBase: "order_total_incl_tax" },
      adSpend: 200,
      targetRoas: 2.5,
    });

    expect(ladder.diagnostics).toContain("cost_and_revenue_tax_bases_disagree");
    expect(ladder.readiness.truthGrade).toBe("C");
  });

  it("caps the grade when a cost excluded from the rate cannot be resolved", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [
          ...completeStructure().components,
          component({
            id: "handling",
            family: "fulfillment",
            decisionClass: "informational",
            // Applies here, but no row matches and there is no fallback, so
            // the amount cannot be computed at all.
            basis: {
              kind: "rate_table",
              level: "unit",
              rows: [{ when: [{ dimension: "market", operator: "in", values: ["DE"] }], amount: 10 }],
            },
          }),
        ],
      }),
    });

    expect(ladder.diagnostics).toContain("excluded_contribution_family_unknown");
    expect(ladder.readiness.truthGrade).toBe("C");
  });

  it("refuses a window whose reversals belong to another window's sales", () => {
    const saleStructure = completeStructure();
    const sale = resolveOrderCosts({
      structure: saleStructure,
      order: order(),
      lines: [line({ quantity: 1, bases: { line_net_sales: 3000 } })],
      reportingCurrency: REPORTING_CURRENCY,
    });
    const hugeReversal = buildRefundLedger({
      saleResolution: resolveOrderCosts({
        structure: structure({
          components: [component({ basis: { kind: "amount_per_line", amount: 3000 } })],
        }),
        order: order({ orderId: "last-month" }),
        lines: [line()],
        reportingCurrency: REPORTING_CURRENCY,
      }),
      refundLines: [
        {
          refundLineId: "r1",
          lineId: "line-1",
          quantity: 1,
          restockType: "return",
          refundedDate: "2026-09-25",
        },
      ],
    });

    const ladder = buildEconomicsLadder({
      window: WINDOW,
      reportingCurrency: REPORTING_CURRENCY,
      structure: saleStructure,
      events: [...buildSaleLedger(sale), ...hugeReversal],
      coverage: summarizeCostCoverage({ resolutions: [sale], structure: saleStructure }),
      // Revenue for this window only, reversals from the last one.
      revenue: { netProductSales: 1000, rateBase: "line_net_sales" },
      adSpend: 200,
      targetRoas: null,
    });

    expect(ladder.diagnostics).toContain("contribution_cost_negative_after_reversals");
    expect(ladder.diagnostics).toContain("variable_cost_rate_negative");
    expect(ladder.readiness.thresholds.breakEvenRoasSuggested).toBeNull();
    // A window reported more profitable than its revenue is not grade A.
    expect(ladder.readiness.truthGrade).toBe("C");
    expect(ladder.readiness.gates.profit_scaling.allowed).toBe(false);
  });

  it("refuses a break-even CPA for the same rate that refuses a break-even ROAS", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [component({ id: "product", basis: { kind: "amount_per_line", amount: 1500 } })],
      }),
      aovAssumption: 500,
    });

    expect(ladder.readiness.thresholds.variableCostRate).toBeCloseTo(1.5, 10);
    expect(ladder.readiness.thresholds.breakEvenRoasSuggested).toBeNull();
    // A CPA derived from that rate would be a negative target.
    expect(ladder.readiness.thresholds.breakEvenCpaSuggested).toBeNull();
    expect(ladder.diagnostics).toContain("variable_cost_rate_at_or_above_revenue");
  });

  it("treats a zero or unusable target ROAS as no target at all", () => {
    for (const targetRoas of [0, Number.NaN]) {
      const { ladder } = windowFrom({ structure: completeStructure(), targetRoas });
      expect(ladder.readiness.thresholds.targetRoasSource).toBe("absent");
      // It falls back to the derived break-even rather than claiming authority.
      expect(ladder.readiness.gates.roas_target_scaling.ceiling).toBe("monitor_low_truth");
    }
  });

  it("keeps the estimated portion inside the amount it is a portion of", () => {
    const saleStructure = structure({
      components: [
        component({
          id: "ship",
          family: "outbound_shipping",
          evidence: "operator_estimate",
          refundBehaviour: "reverse_on_cancel_only",
          basis: { kind: "amount_per_line", amount: 50 },
        }),
        component({ id: "product", basis: { kind: "amount_per_line", amount: 35 } }),
      ],
    });
    const sale = resolveOrderCosts({
      structure: saleStructure,
      order: order(),
      lines: [line()],
      reportingCurrency: REPORTING_CURRENCY,
    });
    const events = [
      ...buildSaleLedger(sale),
      ...buildRefundLedger({
        saleResolution: sale,
        refundLines: [
          {
            refundLineId: "r1",
            lineId: "line-1",
            quantity: 1,
            restockType: "cancel",
            refundedDate: "2026-09-20",
          },
        ],
      }),
    ];
    const ladder = buildEconomicsLadder({
      window: WINDOW,
      reportingCurrency: REPORTING_CURRENCY,
      structure: saleStructure,
      events,
      coverage: summarizeCostCoverage({ resolutions: [sale], structure: saleStructure }),
      revenue: { netProductSales: 1000, rateBase: "line_net_sales" },
      adSpend: 200,
      targetRoas: 2.5,
    });

    // The estimate was reversed, so it is no longer part of the cost.
    expect(ladder.rungs.preMarketingContribution.estimatedAmount).toBeLessThanOrEqual(
      Math.abs(ladder.rungs.preMarketingContribution.amount ?? 0),
    );
    expect(ladder.rungs.preMarketingContribution.estimatedAmount).toBe(0);
  });

  it("counts a line once per family, and leaves an inapplicable line out of coverage", () => {
    const multiSlot = windowFrom({
      structure: structure({
        components: [
          component({ id: "product", basis: { kind: "amount_per_line", amount: 300 } }),
          component({
            id: "fee-base",
            family: "payment_processing",
            slot: "base",
            basis: { kind: "amount_per_line", amount: 35 },
          }),
          component({
            id: "fee-surcharge",
            family: "payment_processing",
            slot: "surcharge",
            basis: { kind: "percent_of_base", percent: 1, base: "order_shipping_revenue" },
          }),
        ],
      }),
    });
    // One line, one family: coverage is 0 or 1, never a half.
    expect(multiSlot.coverage.familyCoverage?.payment_processing).toBe(1);

    const digital = windowFrom({
      structure: completeStructure(),
      lines: [
        line({ lineId: "physical", bases: { line_net_sales: 600 } }),
        line({
          lineId: "digital",
          bases: { line_net_sales: 400 },
          notApplicableFamilies: ["product_purchase"],
        }),
      ],
    });
    // The digital line has no product cost to cover, so it is not an
    // uncovered line.
    expect(digital.coverage.productCostCoverage).toBe(1);
    expect(digital.coverage.lineCount).toBe(1);
  });

  it("says why a window-level cost is unavailable", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [
          ...completeStructure().components,
          component({
            id: "saas",
            family: "platform_software",
            recognition: "on_period",
            currency: "USD",
            fx: { policy: "transaction_date" },
            basis: { kind: "period_amount", amount: 500, period: "month", allocation: "equal" },
          }),
        ],
      }),
      periodEvents: true,
    });

    const saas = ladder.families.find((entry) => entry.family === "platform_software");
    expect(saas?.state).toBe("unavailable");
    expect(saas?.unavailableReason).toBe("currency_blocked");
  });

  it("lists the operating-class costs it subtracts", () => {
    const { ladder } = windowFrom({
      structure: completeStructure({
        components: [
          ...completeStructure().components,
          component({
            id: "handling",
            family: "packaging",
            decisionClass: "operating",
            basis: { kind: "amount_per_line", amount: 20 },
          }),
          component({
            id: "no-overhead",
            family: "overhead_fixed",
            recognition: "on_period",
            basis: { kind: "period_amount", amount: 0, period: "month", allocation: "equal" },
          }),
        ],
      }),
      periodEvents: true,
    });

    expect(ladder.rungs.operatingProfit.includedFamilies).toContain("packaging");
    expect(ladder.rungs.operatingProfit.amount).toBe(395);
  });
});
