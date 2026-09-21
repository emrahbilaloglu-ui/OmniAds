import { describe, expect, it } from "vitest";
import {
  COST_STRUCTURE_ISSUE_CODES,
  type CommerceCostComponent,
  type CostBase,
  type CostScopePredicate,
  type CostStructureIssue,
  type CostStructureIssueCode,
} from "@/src/types/commerce-cost";
import { isCostStructureActivatable, validateCostStructure } from "@/lib/commerce-cost/validate";
import { component, structure } from "@/lib/commerce-cost/__tests__/fixtures";

/**
 * Structure validation is the only gate between an owner's cost model and a
 * profit number nobody can reconcile. Every case below is a shape that would
 * either double-count money, smuggle ad spend into a cost, or state a
 * percentage that cannot mean anything — and the passing counterpart that must
 * NOT be blocked, because a validator that cries wolf gets switched off.
 *
 * Assertions are on `code`, `severity` and `componentIds`: the message text is
 * a UI concern, the code is the contract.
 */

const FOREIGN_CURRENCY = "USD"; // fixtures report in TRY

function validateOf(...components: CommerceCostComponent[]): CostStructureIssue[] {
  return validateCostStructure(structure({ components }));
}

function codesOf(issues: readonly CostStructureIssue[]): CostStructureIssueCode[] {
  return issues.map((entry) => entry.code);
}

function errorsOf(issues: readonly CostStructureIssue[]): CostStructureIssue[] {
  return issues.filter((entry) => entry.severity === "error");
}

/** `channel in (…)` — two disjoint `in` predicates are the one provably non-overlapping scope. */
function channelScope(...values: string[]): CostScopePredicate[] {
  return [{ dimension: "channel", operator: "in", values }];
}

function variantScope(value: string): CostScopePredicate[] {
  return [{ dimension: "variant_id", operator: "in", values: [value] }];
}

/** A chain of BOM components, each scoped to a variant the previous one names. */
function bomChain(length: number): CommerceCostComponent[] {
  return Array.from({ length }, (_unused, index) =>
    component({
      id: `bom-${index}`,
      scope: variantScope(`v-${index}`),
      basis: { kind: "bom", components: [{ variantId: `v-${index + 1}`, quantity: 1 }] },
    }),
  );
}

/** The boring, fully-stated structure a real store would have. */
function realisticComponents(): CommerceCostComponent[] {
  return [
    component({ id: "cogs", family: "product_purchase", basis: { kind: "amount_per_unit", amount: 120 } }),
    component({ id: "pack", family: "packaging", basis: { kind: "amount_per_line", amount: 4.5 } }),
    component({
      id: "ship",
      family: "outbound_shipping",
      basis: {
        kind: "rate_table",
        level: "unit",
        rows: [{ weightMaxKg: 5, amount: 40 }],
        fallbackAmount: 60,
      },
    }),
    component({
      id: "psp",
      family: "payment_processing",
      basis: {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "order_total_incl_tax",
        fixedAmount: 1.5,
        fixedPer: "order",
        allocation: "revenue",
      },
    }),
    component({
      id: "marketplace",
      family: "channel_fees",
      basis: {
        kind: "percent_of_base",
        percent: 5,
        base: "order_net_product_sales",
        allocation: "revenue",
      },
    }),
    component({
      id: "saas",
      family: "platform_software",
      basis: { kind: "period_amount", amount: 4000, period: "month", allocation: "revenue" },
    }),
  ];
}

describe("paid marketing is never a cost component", () => {
  it("refuses a component whose family is paid marketing", () => {
    // Ad spend already arrives from the ad platforms; modelling it as a cost
    // would subtract the same money twice from every profit and ROAS figure.
    const issues = validateOf(component({ id: "ads", family: "marketing_paid" }));

    expect(codesOf(issues)).toEqual(["marketing_family_not_allowed"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["ads"]);
    expect(issues[0].family).toBe("marketing_paid");
  });

  it("accepts non-ad marketing costs, which do not come from the platforms", () => {
    // marketing_other (agency retainers, influencer fees) has no platform feed,
    // so refusing it would leave the cost unmodellable anywhere.
    const issues = validateOf(component({ id: "agency", family: "marketing_other" }));

    expect(issues).toEqual([]);
  });

  it("refuses ad spend hidden inside another component", () => {
    // Embedding is the back door: the host's amount would quietly contain ad
    // spend that the platform also reports.
    const issues = validateOf(component({ id: "cogs", embeds: ["marketing_paid"] }));

    expect(codesOf(issues)).toEqual(["family_not_embeddable"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["cogs"]);
    expect(issues[0].family).toBe("marketing_paid");
  });

  it("accepts embedding a family that is allowed to hide inside a host", () => {
    // A supplier price that includes freight is the normal case, and it is only
    // a problem once freight is ALSO modelled directly (covered below).
    const issues = validateOf(
      component({
        id: "cogs",
        embeds: ["outbound_shipping"],
        refundBehaviour: "product_share_only",
      }),
    );

    expect(issues).toEqual([]);
  });

  it("refuses embedding any family that may not hide, not only paid marketing", () => {
    // Fixed families are non-embeddable too: a recurring cost buried in a unit
    // cost would reach marginal decisions it must stay out of.
    const issues = validateOf(component({ id: "cogs", embeds: ["platform_software"] }));

    expect(codesOf(issues)).toEqual(["family_not_embeddable"]);
    expect(issues[0].family).toBe("platform_software");
  });
});

describe("a family that is both embedded in a host and modelled directly", () => {
  const host = () =>
    component({
      id: "cogs",
      family: "product_purchase",
      embeds: ["outbound_shipping"],
      refundBehaviour: "product_share_only",
    });
  const direct = (overrides: Partial<CommerceCostComponent> = {}) =>
    component({
      id: "ship",
      family: "outbound_shipping",
      basis: { kind: "amount_per_line", amount: 40 },
      ...overrides,
    });

  it("is an error when the scopes and the periods can both describe one line", () => {
    // Shipping would be subtracted once inside the landed product cost and
    // again as its own component.
    const issues = validateOf(host(), direct());

    expect(codesOf(issues)).toEqual(["embedded_family_also_direct"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["cogs", "ship"]);
    expect(issues[0].family).toBe("outbound_shipping");
  });

  it("is not an issue when the scopes are provably disjoint", () => {
    // Freight-inclusive supplier pricing on the web channel and a separate
    // shipping cost at retail never meet on the same line.
    const issues = validateOf(
      component({ ...host(), scope: channelScope("web") }),
      direct({ scope: channelScope("retail") }),
    );

    expect(issues).toEqual([]);
  });

  it("is not an issue when the effective ranges do not overlap", () => {
    // The supplier stopped including freight on 1 February and the direct
    // shipping component starts there: a handover, not a double count.
    const issues = validateOf(
      component({ ...host(), effectiveTo: "2026-02-01T00:00:00.000Z" }),
      direct({ effectiveFrom: "2026-02-01T00:00:00.000Z" }),
    );

    expect(issues).toEqual([]);
  });

  it("is not an issue when the direct component replaces a stated host share", () => {
    // The host says how much of its amount is shipping, so the resolver can
    // subtract exactly that share and let the direct component own the family.
    const issues = validateOf(
      component({
        ...host(),
        embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 35 }],
      }),
      direct({ replacesEmbedded: true }),
    );

    expect(issues).toEqual([]);
  });

  it("refuses a replacement when the host never states the share it contains", () => {
    // Without a number there is nothing to subtract, so the host would keep
    // charging shipping on top of the replacement.
    const issues = validateOf(host(), direct({ replacesEmbedded: true }));

    expect(codesOf(issues)).toEqual(["embedded_share_required_for_replacement"]);
    expect(issues[0].severity).toBe("error");
    // The replacement is named first: it is the component the owner must fix.
    expect(issues[0].componentIds).toEqual(["ship", "cogs"]);
    expect(issues[0].family).toBe("outbound_shipping");
  });

  it("refuses a replacement when nothing embeds the family at all", () => {
    const issues = validateOf(direct({ replacesEmbedded: true }));

    expect(codesOf(issues)).toEqual(["replacement_without_host"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["ship"]);
    expect(issues[0].family).toBe("outbound_shipping");
  });

  it("refuses a replacement whose only candidate host is out of scope or out of period", () => {
    // A host that can never meet this component is not a host.
    const disjointScope = validateOf(
      component({ ...host(), scope: channelScope("web") }),
      direct({ replacesEmbedded: true, scope: channelScope("retail") }),
    );
    expect(codesOf(disjointScope)).toEqual(["replacement_without_host"]);

    const disjointTime = validateOf(
      component({ ...host(), effectiveTo: "2026-02-01T00:00:00.000Z" }),
      direct({ replacesEmbedded: true, effectiveFrom: "2026-02-01T00:00:00.000Z" }),
    );
    expect(codesOf(disjointTime)).toEqual(["replacement_without_host"]);
  });
});

describe("a stated margin already contains the costs it covers", () => {
  const grossMargin = (overrides: Partial<CommerceCostComponent> = {}) =>
    component({
      id: "margin",
      family: "product_purchase",
      basis: {
        kind: "margin_input",
        marginKind: "gross",
        marginPercent: 40,
        base: "line_net_sales",
      },
      ...overrides,
    });

  it("refuses a gross margin alongside a direct product-layer cost", () => {
    // A 40% gross margin already implies the cost of goods AND its freight;
    // stating freight again would subtract it twice.
    const issues = validateOf(
      grossMargin(),
      component({ id: "freight", family: "inbound_logistics", basis: { kind: "amount_per_unit", amount: 10 } }),
    );

    expect(codesOf(issues)).toEqual(["margin_input_with_direct_component"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["margin", "freight"]);
    expect(issues[0].family).toBe("inbound_logistics");
  });

  it("lets a gross margin coexist with variable operating costs it does not cover", () => {
    // Gross margin stops at the product layer: payment fees are still the
    // owner's to state, and blocking them would make the structure unusable.
    const issues = validateOf(
      grossMargin(),
      component({
        id: "psp",
        family: "payment_processing",
        basis: { kind: "percent_of_base", percent: 3, base: "line_net_sales" },
      }),
    );

    expect(issues).toEqual([]);
  });

  it("refuses a contribution margin alongside a variable operating cost", () => {
    // Contribution margin implies the product layer AND the variable operating
    // layer, so the same payment fee is now inside the margin.
    const issues = validateOf(
      grossMargin({
        basis: {
          kind: "margin_input",
          marginKind: "contribution",
          marginPercent: 25,
          base: "line_net_sales",
        },
      }),
      component({
        id: "psp",
        family: "payment_processing",
        basis: { kind: "percent_of_base", percent: 3, base: "line_net_sales" },
      }),
    );

    expect(codesOf(issues)).toEqual(["margin_input_with_direct_component"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["margin", "psp"]);
    expect(issues[0].family).toBe("payment_processing");
  });

  it("does not fault a margin against its own family", () => {
    // The margin component IS the product cost; it does not collide with itself.
    const issues = validateOf(grossMargin());

    expect(issues).toEqual([]);
  });

  it("accepts a negative margin but refuses one outside ±100%", () => {
    // Selling below cost is a real, reportable situation; -150% is not a margin.
    expect(validateOf(grossMargin({ basis: { kind: "margin_input", marginKind: "gross", marginPercent: -40, base: "line_net_sales" } }))).toEqual([]);

    const tooHigh = validateOf(
      grossMargin({ basis: { kind: "margin_input", marginKind: "gross", marginPercent: 150, base: "line_net_sales" } }),
    );
    expect(codesOf(tooHigh)).toEqual(["margin_out_of_range"]);
    expect(tooHigh[0].severity).toBe("error");

    const tooLow = validateOf(
      grossMargin({ basis: { kind: "margin_input", marginKind: "gross", marginPercent: -150, base: "line_net_sales" } }),
    );
    expect(codesOf(tooLow)).toEqual(["margin_out_of_range"]);
  });
});

describe("bases and numbers that cannot mean anything", () => {
  it("refuses a percentage of a base the engine does not know", () => {
    // A percentage of an unknown base can never be evaluated, so storing it
    // would produce a silent `unknown` on every order instead of a refusal now.
    const issues = validateOf(
      component({
        id: "psp",
        basis: {
          kind: "percent_of_base",
          percent: 5,
          base: "gross_revenue_total" as CostBase,
          allocation: "revenue",
        },
      }),
    );

    expect(codesOf(issues)).toEqual(["unknown_base"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["psp"]);
  });

  it("accepts every declared base", () => {
    const issues = validateOf(
      component({ id: "psp", basis: { kind: "percent_of_base", percent: 5, base: "line_net_sales" } }),
    );

    expect(issues).toEqual([]);
  });

  it("refuses a percentage below 0 or above 100", () => {
    const negative = validateOf(
      component({ id: "psp", basis: { kind: "percent_of_base", percent: -5, base: "line_net_sales" } }),
    );
    expect(codesOf(negative)).toEqual(["percent_out_of_range"]);
    expect(negative[0].severity).toBe("error");
    expect(negative[0].componentIds).toEqual(["psp"]);

    // Scoped so this stays out of the store-wide percentage sum, which has its
    // own code and would otherwise mask this one.
    const tooHigh = validateOf(
      component({
        id: "psp",
        scope: channelScope("web"),
        basis: { kind: "percent_of_base", percent: 150, base: "line_net_sales" },
      }),
    );
    expect(codesOf(tooHigh)).toEqual(["percent_out_of_range"]);
  });

  it("checks the percentage half of percent-plus-fixed too", () => {
    const issues = validateOf(
      component({
        id: "psp",
        scope: channelScope("web"),
        basis: {
          kind: "percent_plus_fixed",
          percent: 120,
          base: "line_net_sales",
          fixedAmount: 1,
        },
      }),
    );

    expect(codesOf(issues)).toEqual(["percent_out_of_range"]);
  });

  it("treats 0% and 100% as in range", () => {
    // A cost that consumes the whole line is extreme but expressible; the
    // bound is inclusive.
    const zero = validateOf(
      component({ id: "a", basis: { kind: "percent_of_base", percent: 0, base: "line_net_sales" } }),
    );
    const full = validateOf(
      component({
        id: "b",
        scope: channelScope("web"),
        basis: { kind: "percent_of_base", percent: 100, base: "line_net_sales" },
      }),
    );

    expect(zero).toEqual([]);
    expect(full).toEqual([]);
  });

  it("refuses a negative amount in any of the amount bases", () => {
    const perUnit = validateOf(component({ id: "cogs", basis: { kind: "amount_per_unit", amount: -5 } }));
    expect(codesOf(perUnit)).toEqual(["negative_amount"]);
    expect(perUnit[0].severity).toBe("error");
    expect(perUnit[0].componentIds).toEqual(["cogs"]);

    const perLine = validateOf(component({ id: "pack", basis: { kind: "amount_per_line", amount: -1 } }));
    expect(codesOf(perLine)).toEqual(["negative_amount"]);

    const perOrder = validateOf(
      component({ id: "ship", basis: { kind: "amount_per_order", amount: -20, allocation: "revenue" } }),
    );
    expect(codesOf(perOrder)).toEqual(["negative_amount"]);

    const perPeriod = validateOf(
      component({
        id: "saas",
        family: "platform_software",
        basis: { kind: "period_amount", amount: -100, period: "month", allocation: "equal" },
      }),
    );
    expect(codesOf(perPeriod)).toEqual(["negative_amount"]);
  });

  it("accepts a zero amount, which is a real answer", () => {
    // Free shipping on a channel is zero, not missing — as long as the zero was
    // not left behind by a template (see the template-zero warning).
    const issues = validateOf(
      component({ id: "ship", family: "outbound_shipping", basis: { kind: "amount_per_unit", amount: 0 } }),
    );

    expect(issues).toEqual([]);
  });

  it("catches negative money wherever a basis hides it", () => {
    // A negative cost is revenue the owner never earned, so it is refused in
    // every part of a basis, not only in a bare `amount`.
    const fixedPart = validateOf(
      component({
        id: "psp",
        basis: {
          kind: "percent_plus_fixed",
          percent: 2,
          base: "line_net_sales",
          fixedAmount: -50,
        },
      }),
    );
    expect(codesOf(fixedPart)).toContain("negative_amount");

    const tableRow = validateOf(
      component({
        id: "ship",
        basis: { kind: "rate_table", level: "unit", rows: [{ amount: -10 }] },
      }),
    );
    expect(codesOf(tableRow)).toContain("negative_amount");

    const recipe = validateOf(
      component({
        id: "kit",
        basis: { kind: "bom", components: [{ sku: "PART", quantity: 1, amount: -5 }] },
      }),
    );
    expect(codesOf(recipe)).toContain("negative_amount");
  });
});

describe("recurring costs versus marginal ones", () => {
  it("warns when a fixed family is stated per unit", () => {
    // A per-unit overhead would ride into every marginal decision, making a
    // profitable incremental order look unprofitable.
    const perUnitOverhead = structure({
      components: [
        component({ id: "rent", family: "overhead_fixed", basis: { kind: "amount_per_unit", amount: 3 } }),
      ],
    });
    const issues = validateCostStructure(perUnitOverhead);

    expect(codesOf(issues)).toEqual(["fixed_family_needs_period_basis"]);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].componentIds).toEqual(["rent"]);
    expect(issues[0].family).toBe("overhead_fixed");
    // A warning is advice, not a block.
    expect(isCostStructureActivatable(perUnitOverhead)).toBe(true);
  });

  it("is satisfied by a period amount on a fixed family", () => {
    const issues = validateOf(
      component({
        id: "rent",
        family: "overhead_fixed",
        basis: { kind: "period_amount", amount: 25000, period: "month", allocation: "revenue" },
      }),
    );

    expect(issues).toEqual([]);
  });

  it("warns when a variable family is stated as a period amount", () => {
    // Packaging is consumed per order; a monthly figure would never reach a
    // line, so the family would silently read as zero.
    const issues = validateOf(
      component({
        id: "pack",
        family: "packaging",
        basis: { kind: "period_amount", amount: 500, period: "month", allocation: "units" },
      }),
    );

    expect(codesOf(issues)).toEqual(["period_basis_on_variable_family"]);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].componentIds).toEqual(["pack"]);
    expect(issues[0].family).toBe("packaging");
  });

  it("allows a period amount on a marketing-layer family", () => {
    // Non-ad marketing is semi-fixed: a monthly retainer is its natural shape.
    const issues = validateOf(
      component({
        id: "agency",
        family: "marketing_other",
        basis: { kind: "period_amount", amount: 30000, period: "month", allocation: "revenue" },
      }),
    );

    expect(issues).toEqual([]);
  });
});

describe("percentages that would eat the whole order", () => {
  const percent = (id: string, family: CommerceCostComponent["family"], value: number, overrides: Partial<CommerceCostComponent> = {}) =>
    component({
      id,
      family,
      basis: {
        kind: "percent_of_base",
        percent: value,
        base: "order_total_incl_tax",
        allocation: "revenue",
      },
      ...overrides,
    });

  it("refuses store-wide percentages of one base that reach 100%", () => {
    // Two store-wide percentages that consume the order leave nothing to sell:
    // the structure is arithmetically impossible, not merely aggressive.
    const issues = validateOf(
      percent("psp", "payment_processing", 60),
      percent("marketplace", "channel_fees", 45),
    );

    expect(codesOf(issues)).toEqual(["variable_percent_exceeds_full_revenue"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["psp", "marketplace"]);
  });

  it("treats exactly 100% as already impossible and 99% as allowed", () => {
    const exactly = validateOf(
      percent("psp", "payment_processing", 60),
      percent("marketplace", "channel_fees", 40),
    );
    expect(codesOf(exactly)).toEqual(["variable_percent_exceeds_full_revenue"]);

    const under = validateOf(
      percent("psp", "payment_processing", 60),
      percent("marketplace", "channel_fees", 39),
    );
    expect(under).toEqual([]);
  });

  it("excludes scoped components from the sum", () => {
    // A 60% cost that only applies to one channel cannot be added to a
    // store-wide 60%: they may never apply to the same order.
    const issues = validateOf(
      percent("psp", "payment_processing", 60),
      percent("marketplace", "channel_fees", 60, { scope: channelScope("marketplace") }),
    );

    expect(issues).toEqual([]);
  });

  it("sums each base separately", () => {
    // Percentages of different bases are not commensurable, so they are not
    // added together.
    const issues = validateOf(
      percent("psp", "payment_processing", 60),
      component({
        id: "marketplace",
        family: "channel_fees",
        basis: {
          kind: "percent_of_base",
          percent: 60,
          base: "order_net_product_sales",
          allocation: "revenue",
        },
      }),
    );

    expect(codesOf(issues)).not.toContain("variable_percent_exceeds_full_revenue");
    expect(errorsOf(issues)).toEqual([]);
  });

  it("excludes fixed-layer percentages from the sum", () => {
    // A fixed cost expressed as a percentage never competes for the marginal
    // order, so it cannot exhaust it either.
    const issues = validateOf(
      percent("psp", "payment_processing", 60),
      percent("saas", "platform_software", 60),
    );

    expect(codesOf(issues)).toEqual(["fixed_family_needs_period_basis"]);
    expect(errorsOf(issues)).toEqual([]);
  });

  it("counts the percentage half of percent-plus-fixed", () => {
    const issues = validateOf(
      percent("psp", "payment_processing", 60),
      component({
        id: "marketplace",
        family: "channel_fees",
        basis: {
          kind: "percent_plus_fixed",
          percent: 45,
          base: "order_total_incl_tax",
          fixedAmount: 2,
          allocation: "revenue",
        },
      }),
    );

    expect(codesOf(issues)).toEqual(["variable_percent_exceeds_full_revenue"]);
    expect(issues[0].componentIds).toEqual(["psp", "marketplace"]);
  });

  it("does not add percentages that are never effective at the same time", () => {
    const issues = validateOf(
      percent("old", "payment_processing", 60, {
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: "2026-02-01T00:00:00.000Z",
      }),
      percent("new", "channel_fees", 60, {
        effectiveFrom: "2026-02-01T00:00:00.000Z",
      }),
    );

    expect(codesOf(issues)).not.toContain("variable_percent_exceeds_full_revenue");
  });

  it("does not add an older stored version to its current replacement", () => {
    const issues = validateOf(
      percent("psp", "payment_processing", 60, { version: 1 }),
      percent("psp", "payment_processing", 40, {
        version: 2,
        recordedAt: "2026-02-01T00:00:00.000Z",
      }),
      percent("marketplace", "channel_fees", 50),
    );

    expect(codesOf(issues)).not.toContain("variable_percent_exceeds_full_revenue");
  });
});

describe("two components competing for the same slot at the same time", () => {
  const rate = (id: string, overrides: Partial<CommerceCostComponent> = {}) =>
    component({
      id,
      family: "outbound_shipping",
      slot: "base_rate",
      basis: { kind: "amount_per_line", amount: 40 },
      ...overrides,
    });

  it("refuses two equally-trusted values for the same family, slot, scope and period", () => {
    // Neither can win on evidence or specificity, so the resolver would have to
    // pick silently — exactly the coin flip this product refuses.
    const issues = validateOf(rate("ship-a"), rate("ship-b", { basis: { kind: "amount_per_line", amount: 55 } }));

    expect(codesOf(issues)).toEqual(["duplicate_effective_range"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["ship-a", "ship-b"]);
    expect(issues[0].family).toBe("outbound_shipping");
  });

  it("is not an issue when one succeeds the other in time", () => {
    // A rate change is two components in sequence, which is the normal way a
    // new carrier price is recorded.
    const issues = validateOf(
      rate("ship-a", { effectiveTo: "2026-02-01T00:00:00.000Z" }),
      rate("ship-b", { effectiveFrom: "2026-02-01T00:00:00.000Z" }),
    );

    expect(issues).toEqual([]);
  });

  it("reports every overlapping pair in a slot, not just the first", () => {
    // ship-a overlaps ship-b, and ship-b also overlaps ship-c. Reporting only
    // the first pair would leave a live collision in the structure.
    const issues = validateOf(
      rate("ship-a", { effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-02-01T00:00:00.000Z" }),
      rate("ship-b", { effectiveFrom: "2026-01-15T00:00:00.000Z", effectiveTo: "2026-03-01T00:00:00.000Z" }),
      rate("ship-c", { effectiveFrom: "2026-02-01T00:00:00.000Z", effectiveTo: "2026-03-01T00:00:00.000Z" }),
    );

    expect(codesOf(issues)).toEqual(["duplicate_effective_range", "duplicate_effective_range"]);
    expect(issues.map((entry) => entry.componentIds)).toEqual([
      ["ship-a", "ship-b"],
      ["ship-b", "ship-c"],
    ]);
  });

  it("is not an issue across different slots, scopes or evidence tiers", () => {
    // A base rate plus a surcharge is two real costs in one family.
    expect(validateOf(rate("ship-a"), rate("ship-b", { slot: "fuel_surcharge" }))).toEqual([]);
    // Different situations, not a conflict.
    expect(
      validateOf(
        rate("ship-a", { scope: channelScope("web") }),
        rate("ship-b", { scope: channelScope("retail") }),
      ),
    ).toEqual([]);
    // Better evidence simply wins, so this is resolvable without asking.
    expect(validateOf(rate("ship-a"), rate("ship-b", { evidence: "observed_exact" }))).toEqual([]);
  });
});

describe("foreign currency without a conversion policy", () => {
  it("refuses an amount in another currency that has no fx policy", () => {
    // Summing unlike money is the fastest way to a wrong profit figure.
    const issues = validateOf(component({ id: "cogs", currency: FOREIGN_CURRENCY }));

    expect(codesOf(issues)).toEqual(["currency_without_fx_policy"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["cogs"]);
  });

  it("accepts a fixed rate", () => {
    const issues = validateOf(
      component({ id: "cogs", currency: FOREIGN_CURRENCY, fx: { policy: "fixed_rate", fixedRate: 41.5 } }),
    );

    expect(issues).toEqual([]);
  });

  it("accepts a transaction-date policy", () => {
    const issues = validateOf(
      component({ id: "cogs", currency: FOREIGN_CURRENCY, fx: { policy: "transaction_date" } }),
    );

    expect(issues).toEqual([]);
  });

  it("still refuses the reporting-currency policy on foreign money", () => {
    // "It is already in the reporting currency" is a claim the amount's own
    // currency contradicts, so it is treated as no policy at all.
    const issues = validateOf(
      component({ id: "cogs", currency: FOREIGN_CURRENCY, fx: { policy: "reporting_currency" } }),
    );

    expect(codesOf(issues)).toEqual(["currency_without_fx_policy"]);
  });

  it("refuses a fixed-rate policy that carries no rate", () => {
    // Pinning to a fixed rate and then not stating it leaves nothing to
    // convert with, which would silently block the family at resolve time.
    const issues = validateOf(
      component({ id: "cogs", currency: FOREIGN_CURRENCY, fx: { policy: "fixed_rate" } }),
    );
    expect(codesOf(issues)).toEqual(["currency_without_fx_policy"]);

    const withRate = validateOf(
      component({
        id: "cogs",
        currency: FOREIGN_CURRENCY,
        fx: { policy: "fixed_rate", fixedRate: 41.5 },
      }),
    );
    expect(withRate).toEqual([]);
  });

  it("compares currency codes case-insensitively", () => {
    // "try" and "TRY" are the same money; a casing difference is not a gap.
    const issues = validateOf(component({ id: "cogs", currency: "try" }));

    expect(issues).toEqual([]);
  });
});

describe("effective ranges and overrides", () => {
  it("refuses a range that ends before or when it starts", () => {
    const inverted = validateOf(
      component({
        id: "cogs",
        effectiveFrom: "2026-03-01T00:00:00.000Z",
        effectiveTo: "2026-02-01T00:00:00.000Z",
      }),
    );
    expect(codesOf(inverted)).toEqual(["effective_range_inverted"]);
    expect(inverted[0].severity).toBe("error");
    expect(inverted[0].componentIds).toEqual(["cogs"]);

    // An empty window owns nothing, so it is refused as well.
    const empty = validateOf(
      component({
        id: "cogs",
        effectiveFrom: "2026-03-01T00:00:00.000Z",
        effectiveTo: "2026-03-01T00:00:00.000Z",
      }),
    );
    expect(codesOf(empty)).toEqual(["effective_range_inverted"]);
  });

  it("accepts an open-ended range and a forward range", () => {
    expect(validateOf(component({ id: "cogs", effectiveTo: null }))).toEqual([]);
    expect(validateOf(component({ id: "cogs", effectiveTo: "2027-01-01T00:00:00.000Z" }))).toEqual([]);
  });

  it("refuses an override with no stated reason", () => {
    // An override outranks every source; without a reason nobody can audit why
    // the observed number was discarded.
    const issues = validateOf(
      component({ id: "cogs" }),
      component({ id: "fix", overrideOf: "cogs", evidence: "override" }),
    );

    expect(codesOf(issues)).toEqual(["override_without_reason"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["fix"]);
  });

  it("treats a whitespace-only reason as no reason", () => {
    const issues = validateOf(
      component({ id: "cogs" }),
      component({ id: "fix", overrideOf: "cogs", evidence: "override", reason: "   " }),
    );

    expect(codesOf(issues)).toEqual(["override_without_reason"]);
  });

  it("accepts an override with a reason", () => {
    const issues = validateOf(
      component({ id: "cogs" }),
      component({
        id: "fix",
        overrideOf: "cogs",
        evidence: "override",
        reason: "Supplier invoice 4471 supersedes the catalogue price.",
      }),
    );

    expect(issues).toEqual([]);
  });

  it("refuses an override that points at nothing", () => {
    const issues = validateOf(
      component({ id: "fix", overrideOf: "ghost", evidence: "override", reason: "carrier invoice" }),
    );

    expect(codesOf(issues)).toEqual(["override_target_missing"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["fix"]);
  });

  it("reports both problems when an override is unexplained and unanchored", () => {
    const issues = validateOf(component({ id: "fix", overrideOf: "ghost", evidence: "override" }));

    expect(codesOf(issues)).toEqual(["override_without_reason", "override_target_missing"]);
  });

  it("lets an override point at a retired component", () => {
    // The override target is looked up across the whole structure, including
    // retired components: retiring the original must not orphan its override.
    const issues = validateOf(
      component({ id: "old", status: "retired" }),
      component({ id: "fix", overrideOf: "old", evidence: "override", reason: "invoice 118" }),
    );

    expect(issues).toEqual([]);
  });
});

describe("rate tables and order-level allocation", () => {
  it("rejects a line-scoped percentage that would charge an order-level base", () => {
    const issues = validateOf(
      component({
        id: "collection-cogs",
        scope: [{ dimension: "collection", operator: "in", values: ["wall-art"] }],
        basis: {
          kind: "percent_of_base",
          percent: 38,
          base: "order_net_product_sales",
          allocation: "revenue",
        },
      }),
    );

    expect(codesOf(issues)).toContain("line_scope_with_order_base");
    expect(issues.find((entry) => entry.code === "line_scope_with_order_base")?.severity).toBe("error");
  });

  it("accepts the same scope when the percentage uses line sales", () => {
    expect(
      validateOf(
        component({
          id: "collection-cogs",
          scope: [{ dimension: "collection", operator: "in", values: ["wall-art"] }],
          basis: { kind: "percent_of_base", percent: 38, base: "line_net_sales" },
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a rate table with neither rows nor a fallback", () => {
    // It can never produce a number; storing it hides the gap behind a
    // configured-looking component.
    const issues = validateOf(
      component({ id: "ship", basis: { kind: "rate_table", level: "unit", rows: [] } }),
    );

    expect(codesOf(issues)).toEqual(["rate_table_without_rows"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["ship"]);
  });

  it("accepts an empty table that has a fallback, and a table with rows", () => {
    expect(
      validateOf(
        component({ id: "ship", basis: { kind: "rate_table", level: "unit", rows: [], fallbackAmount: 45 } }),
      ),
    ).toEqual([]);
    expect(
      validateOf(
        component({
          id: "ship",
          basis: { kind: "rate_table", level: "unit", rows: [{ weightMaxKg: 2, amount: 30 }] },
        }),
      ),
    ).toEqual([]);
  });

  it("catches an empty table whose fallback is explicitly null", () => {
    // An explicit null is not a fallback: the table would resolve to no number
    // on every order, which is a gap the owner should be told about now.
    const issues = validateOf(
      component({
        id: "ship",
        basis: { kind: "rate_table", level: "unit", rows: [], fallbackAmount: null },
      }),
    );

    expect(codesOf(issues)).toContain("rate_table_without_rows");
  });

  it("warns when an order-level cost states no allocation driver", () => {
    // Without a driver the amount is spread by revenue, which is a decision the
    // owner did not make.
    const issues = validateOf(
      component({
        id: "psp",
        basis: { kind: "percent_of_base", percent: 2, base: "order_total_excl_tax" },
      }),
    );

    expect(codesOf(issues)).toEqual(["allocation_missing_for_order_amount"]);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].componentIds).toEqual(["psp"]);
  });

  it("warns for an order-level rate table with no allocation driver", () => {
    const issues = validateOf(
      component({
        id: "ship",
        basis: { kind: "rate_table", level: "order", rows: [{ amount: 50 }] },
      }),
    );

    expect(codesOf(issues)).toEqual(["allocation_missing_for_order_amount"]);
  });

  it("does not warn once the driver is stated, nor for line-level bases", () => {
    expect(
      validateOf(
        component({
          id: "psp",
          basis: {
            kind: "percent_of_base",
            percent: 2,
            base: "order_total_excl_tax",
            allocation: "units",
          },
        }),
      ),
    ).toEqual([]);
    // amount_per_order carries its driver in the type, so it is never faulted.
    expect(
      validateOf(component({ id: "ship", basis: { kind: "amount_per_order", amount: 30, allocation: "equal" } })),
    ).toEqual([]);
    // A line-level base needs no allocation at all.
    expect(
      validateOf(
        component({ id: "psp", basis: { kind: "percent_of_base", percent: 2, base: "line_net_sales" } }),
      ),
    ).toEqual([]);
  });
});

describe("a zero nobody confirmed", () => {
  it("warns about a template zero, which is indistinguishable from an unanswered question", () => {
    const perUnit = validateOf(
      component({
        id: "pack",
        family: "packaging",
        basis: { kind: "amount_per_unit", amount: 0 },
        evidence: "template_default",
        source: { kind: "template" },
      }),
    );
    expect(codesOf(perUnit)).toEqual(["unconfirmed_zero_amount"]);
    expect(perUnit[0].severity).toBe("warning");
    expect(perUnit[0].componentIds).toEqual(["pack"]);
    expect(perUnit[0].family).toBe("packaging");

    const perLine = validateOf(
      component({
        id: "pack",
        family: "packaging",
        basis: { kind: "amount_per_line", amount: 0 },
        evidence: "template_default",
      }),
    );
    expect(codesOf(perLine)).toEqual(["unconfirmed_zero_amount"]);
  });

  it("does not warn about a zero the owner stated, nor about a non-zero template value", () => {
    // An operator estimate of zero is an answer; a template default of 100 is a
    // number somebody can check.
    expect(
      validateOf(
        component({ id: "pack", basis: { kind: "amount_per_unit", amount: 0 }, evidence: "operator_estimate" }),
      ),
    ).toEqual([]);
    expect(
      validateOf(
        component({ id: "pack", basis: { kind: "amount_per_unit", amount: 100 }, evidence: "template_default" }),
      ),
    ).toEqual([]);
  });
});

describe("bills of materials", () => {
  it("refuses a recipe line with neither an identity nor a cost", () => {
    // Nothing can be resolved from it, and its absence would silently
    // under-state the finished good.
    const issues = validateOf(
      component({ id: "kit", basis: { kind: "bom", components: [{ quantity: 2 }] } }),
    );

    expect(codesOf(issues)).toEqual(["bom_child_unidentified"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["kit"]);
  });

  it("accepts a recipe line identified by variant or SKU, or priced inline", () => {
    expect(
      validateOf(
        component({ id: "kit", basis: { kind: "bom", components: [{ variantId: "v-2", quantity: 2 }] } }),
      ),
    ).toEqual([]);
    expect(
      validateOf(component({ id: "kit", basis: { kind: "bom", components: [{ sku: "SKU-2", quantity: 1 }] } })),
    ).toEqual([]);
    // A stated cost needs no identity: the number is already there.
    expect(
      validateOf(
        component({ id: "kit", basis: { kind: "bom", components: [{ quantity: 3, amount: 12 }] } }),
      ),
    ).toEqual([]);
  });

  it("refuses a recipe that walks back to something it already contains", () => {
    // Two recipes naming each other's variant would recurse forever at
    // resolution time and, worse, count the same cost repeatedly.
    const issues = validateOf(
      component({
        id: "kit-a",
        scope: variantScope("v-a"),
        basis: { kind: "bom", components: [{ variantId: "v-b", quantity: 1 }] },
      }),
      component({
        id: "kit-b",
        scope: variantScope("v-b"),
        basis: { kind: "bom", components: [{ variantId: "v-a", quantity: 1 }] },
      }),
    );

    expect(codesOf(issues)).toEqual(["bom_cycle", "bom_cycle"]);
    expect(issues.every((entry) => entry.severity === "error")).toBe(true);
    // The walk starts from each recipe, so the cycle is reported from both ends.
    expect(issues.map((entry) => entry.componentIds).flat().sort()).toEqual(["kit-a", "kit-b"]);
  });

  it("does not fault a deep but finite recipe chain", () => {
    const issues = validateOf(...bomChain(8));

    expect(issues).toEqual([]);
  });

  it("refuses a recipe chain that nests deeper than the walk allows", () => {
    // Beyond the depth bound the resolver stops, so the finished cost would be
    // partial; it is refused instead.
    const issues = validateOf(...bomChain(9));

    expect(codesOf(issues)).toEqual(["bom_depth_exceeded"]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].componentIds).toEqual(["bom-8"]);
  });
});

describe("retired components", () => {
  it("ignores a retired component entirely", () => {
    // A retired component is history. Validating it would make old, superseded
    // mistakes block today's activation forever.
    const issues = validateOf(
      component({ id: "live" }),
      component({ id: "dead-ads", family: "marketing_paid", status: "retired" }),
      component({
        id: "dead-percent",
        basis: { kind: "percent_of_base", percent: 400, base: "line_net_sales" },
        status: "retired",
      }),
    );

    expect(issues).toEqual([]);
  });

  it("does not treat a retired twin as a conflicting duplicate", () => {
    const issues = validateOf(component({ id: "current" }), component({ id: "previous", status: "retired" }));

    expect(issues).toEqual([]);
  });

  it("still validates draft components, which are on their way to being active", () => {
    const issues = validateOf(component({ id: "ads", family: "marketing_paid", status: "draft" }));

    expect(codesOf(issues)).toEqual(["marketing_family_not_allowed"]);
  });
});

describe("a realistic structure and the activation gate", () => {
  it("produces no issues at all for a fully-stated store", () => {
    const issues = validateCostStructure(structure({ components: realisticComponents() }));

    expect(issues).toEqual([]);
  });

  it("is activatable when it is clean", () => {
    expect(isCostStructureActivatable(structure({ components: realisticComponents() }))).toBe(true);
  });

  it("is not activatable once any error exists", () => {
    const withError = structure({
      components: [...realisticComponents(), component({ id: "ads", family: "marketing_paid" })],
    });

    expect(isCostStructureActivatable(withError)).toBe(false);
  });

  it("stays activatable when only warnings exist", () => {
    // Warnings describe a structure that is worse than it could be, not one
    // that is wrong; blocking on them would stall every honest owner.
    const withWarning = structure({
      components: [
        ...realisticComponents(),
        component({ id: "rent", family: "overhead_fixed", basis: { kind: "amount_per_unit", amount: 2 } }),
      ],
    });
    const issues = validateCostStructure(withWarning);

    expect(codesOf(issues)).toEqual(["fixed_family_needs_period_basis"]);
    expect(errorsOf(issues)).toEqual([]);
    expect(isCostStructureActivatable(withWarning)).toBe(true);
  });

  it("is pure: the same structure yields the same issues in the same order", () => {
    const subject = structure({
      components: [
        component({ id: "ads", family: "marketing_paid" }),
        component({ id: "rent", family: "overhead_fixed", basis: { kind: "amount_per_unit", amount: 2 } }),
        component({ id: "fix", overrideOf: "ghost", evidence: "override" }),
      ],
    });

    expect(validateCostStructure(subject)).toEqual(validateCostStructure(subject));
  });

  it("reports every independent problem rather than stopping at the first", () => {
    const issues = validateOf(
      component({ id: "ads", family: "marketing_paid" }),
      component({
        id: "broken",
        currency: FOREIGN_CURRENCY,
        basis: { kind: "amount_per_unit", amount: -5 },
        effectiveFrom: "2026-03-01T00:00:00.000Z",
        effectiveTo: "2026-02-01T00:00:00.000Z",
      }),
    );

    expect(codesOf(issues)).toEqual([
      "marketing_family_not_allowed",
      "effective_range_inverted",
      "currency_without_fx_policy",
      "negative_amount",
    ]);
  });
});

describe("a margin host counts as a host for a replacement", () => {
  it("accepts a replacement whose host only implies the family through its margin", () => {
    // Both embedding rules read the same set: what a component declares plus
    // what a stated margin necessarily covers.
    const issues = validateOf(
      component({
        id: "margin",
        family: "packaging",
        basis: {
          kind: "margin_input",
          marginKind: "gross",
          marginPercent: 40,
          base: "line_net_sales",
        },
        embeddedShares: [{ family: "product_purchase", kind: "percent_of_host", value: 50 }],
      }),
      component({ id: "cogs", family: "product_purchase", replacesEmbedded: true }),
    );

    expect(issues).toEqual([]);
  });

  it("accepts the same structure once the host also lists the family in embeds", () => {
    const issues = validateOf(
      component({
        id: "margin",
        family: "packaging",
        basis: {
          kind: "margin_input",
          marginKind: "gross",
          marginPercent: 40,
          base: "line_net_sales",
        },
        embeds: ["product_purchase"],
        embeddedShares: [{ family: "product_purchase", kind: "percent_of_host", value: 50 }],
      }),
      component({ id: "cogs", family: "product_purchase", replacesEmbedded: true }),
    );

    expect(issues).toEqual([]);
  });
});

describe("Shopify product-cost source ownership", () => {
  const policy = {
    productCostAuthority: "hybrid" as const,
    shopifyUnitCost: {
      meaning: "landed_cost" as const,
      includedFamilies: ["product_purchase", "inbound_logistics", "duties_import"] as const,
      minimumCoveragePercent: 95,
      missingCostPolicy: "manual_fallback" as const,
      fallbackComponentId: "fallback",
      historicalPolicy: "unknown_before_first_observation" as const,
    },
  };

  it("allows one product component when it is explicitly the missing-variant fallback", () => {
    const issues = validateCostStructure(
      structure({
        components: [
          component({ id: "fallback", embeds: ["inbound_logistics", "duties_import"] }),
        ],
        sourcePolicy: policy,
      }),
    );
    expect(issues).toEqual([]);
  });

  it("refuses a second owner for a family already inside Shopify unit cost", () => {
    const issues = validateCostStructure(
      structure({
        components: [
          component({ id: "fallback", embeds: ["inbound_logistics", "duties_import"] }),
          component({ id: "freight", family: "inbound_logistics" }),
        ],
        sourcePolicy: policy,
      }),
    );
    expect(codesOf(issues)).toContain("shopify_source_family_also_direct");
  });

  it("finds Shopify overlap hidden inside a loaded manual component", () => {
    const issues = validateCostStructure(
      structure({
        components: [
          component({
            id: "loaded-manual",
            family: "packaging",
            embeds: ["inbound_logistics"],
          }),
        ],
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            ...policy.shopifyUnitCost,
            missingCostPolicy: "leave_unknown",
            fallbackComponentId: null,
          },
        },
      }),
    );

    expect(codesOf(issues)).toContain("shopify_source_family_also_direct");
  });

  it("refuses an override as a missing-variant fallback", () => {
    const issues = validateCostStructure(
      structure({
        components: [
          component({
            id: "fallback",
            evidence: "override",
            embeds: ["inbound_logistics", "duties_import"],
          }),
        ],
        sourcePolicy: policy,
      }),
    );

    expect(codesOf(issues)).toContain("shopify_fallback_component_invalid");
  });

  it("allows a reference-only composite beside Shopify because it owns no decision input", () => {
    const issues = validateCostStructure(
      structure({
        components: [
          component({
            id: "reference",
            slot: "all-expense-reference",
            decisionClass: "informational",
            basis: {
              kind: "percent_of_base",
              percent: 42,
              base: "line_net_sales",
            },
          }),
        ],
        sourcePolicy: {
          productCostAuthority: "shopify_unit_cost",
          shopifyUnitCost: {
            ...policy.shopifyUnitCost,
            meaning: "product_purchase_only",
            includedFamilies: ["product_purchase"],
            missingCostPolicy: "leave_unknown",
            fallbackComponentId: null,
          },
        },
      }),
    );

    expect(codesOf(issues)).not.toContain("shopify_source_family_also_direct");
  });
});

describe("issue-code coverage", () => {
  /**
   * One minimal trigger per code. This is the guard that keeps a newly added
   * code from shipping unreachable — and documents the smallest structure that
   * provokes each one.
   */
  const triggers: Partial<Record<CostStructureIssueCode, CommerceCostComponent[]>> = {
    embedded_share_not_a_cost: [
      component({
        id: "x",
        embeds: ["outbound_shipping"],
        embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: -5 }],
      }),
    ],
    embedded_share_without_embed: [
      component({
        id: "x",
        embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 5 }],
      }),
    ],
    loaded_product_refund_policy_invalid: [
      component({
        id: "loaded",
        embeds: ["outbound_shipping"],
        refundBehaviour: "reverse_on_restock",
      }),
    ],
    unparseable_time: [component({ id: "x", effectiveFrom: "2026-13-01" })],
    duplicate_component_version: [
      component({ id: "x", version: 1 }),
      component({ id: "x", version: 1, basis: { kind: "amount_per_unit", amount: 55 } }),
    ],
    marketing_family_not_allowed: [component({ id: "x", family: "marketing_paid" })],
    family_not_embeddable: [component({ id: "x", embeds: ["marketing_paid"] })],
    embedded_family_also_direct: [
      component({ id: "host", embeds: ["outbound_shipping"] }),
      component({ id: "x", family: "outbound_shipping" }),
    ],
    margin_input_with_direct_component: [
      component({
        id: "host",
        basis: { kind: "margin_input", marginKind: "gross", marginPercent: 40, base: "line_net_sales" },
      }),
      component({ id: "x", family: "inbound_logistics" }),
    ],
    embedded_share_required_for_replacement: [
      component({ id: "host", embeds: ["outbound_shipping"] }),
      component({ id: "x", family: "outbound_shipping", replacesEmbedded: true }),
    ],
    replacement_without_host: [
      component({ id: "x", family: "outbound_shipping", replacesEmbedded: true }),
    ],
    unknown_base: [
      component({
        id: "x",
        basis: { kind: "percent_of_base", percent: 2, base: "nope" as CostBase, allocation: "equal" },
      }),
    ],
    line_scope_with_order_base: [
      component({
        id: "x",
        scope: [{ dimension: "sku", operator: "in", values: ["SKU-1"] }],
        basis: {
          kind: "percent_of_base",
          percent: 10,
          base: "order_net_product_sales",
          allocation: "revenue",
        },
      }),
    ],
    fixed_family_needs_period_basis: [component({ id: "x", family: "overhead_fixed" })],
    period_basis_on_variable_family: [
      component({
        id: "x",
        basis: { kind: "period_amount", amount: 10, period: "month", allocation: "equal" },
      }),
    ],
    variable_percent_exceeds_full_revenue: [
      component({
        id: "a",
        family: "payment_processing",
        basis: { kind: "percent_of_base", percent: 60, base: "line_net_sales" },
      }),
      component({
        id: "b",
        family: "channel_fees",
        basis: { kind: "percent_of_base", percent: 60, base: "line_net_sales" },
      }),
    ],
    margin_out_of_range: [
      component({
        id: "x",
        basis: { kind: "margin_input", marginKind: "gross", marginPercent: 200, base: "line_net_sales" },
      }),
    ],
    percent_out_of_range: [
      component({
        id: "x",
        basis: { kind: "percent_of_base", percent: -1, base: "line_net_sales" },
      }),
    ],
    negative_amount: [component({ id: "x", basis: { kind: "amount_per_unit", amount: -1 } })],
    bom_cycle: [
      component({
        id: "a",
        scope: variantScope("v-a"),
        basis: { kind: "bom", components: [{ variantId: "v-b", quantity: 1 }] },
      }),
      component({
        id: "b",
        scope: variantScope("v-b"),
        basis: { kind: "bom", components: [{ variantId: "v-a", quantity: 1 }] },
      }),
    ],
    bom_depth_exceeded: bomChain(10),
    bom_child_unidentified: [component({ id: "x", basis: { kind: "bom", components: [{ quantity: 1 }] } })],
    override_without_reason: [component({ id: "x", overrideOf: "x" })],
    override_target_missing: [component({ id: "x", overrideOf: "ghost", reason: "why" })],
    override_target_mismatch: [
      component({ id: "base", family: "outbound_shipping", slot: "shipping" }),
      component({ id: "x", overrideOf: "base", reason: "corrected invoice" }),
    ],
    duplicate_effective_range: [component({ id: "a" }), component({ id: "b" })],
    currency_without_fx_policy: [component({ id: "x", currency: FOREIGN_CURRENCY })],
    effective_range_inverted: [
      component({
        id: "x",
        effectiveFrom: "2026-03-01T00:00:00.000Z",
        effectiveTo: "2026-01-01T00:00:00.000Z",
      }),
    ],
    unconfirmed_zero_amount: [
      component({ id: "x", basis: { kind: "amount_per_unit", amount: 0 }, evidence: "template_default" }),
    ],
    rate_table_without_rows: [
      component({ id: "x", basis: { kind: "rate_table", level: "unit", rows: [] } }),
    ],
    allocation_missing_for_order_amount: [
      component({
        id: "x",
        basis: { kind: "percent_of_base", percent: 2, base: "order_total_excl_tax" },
      }),
    ],
  };

  const shopifyPolicy = (overrides: Record<string, unknown> = {}) => ({
    productCostAuthority: "shopify_unit_cost" as const,
    shopifyUnitCost: {
      meaning: "product_purchase_only" as const,
      includedFamilies: ["product_purchase" as const],
      minimumCoveragePercent: 100,
      missingCostPolicy: "leave_unknown" as const,
      historicalPolicy: "unknown_before_first_observation" as const,
      ...overrides,
    },
  });

  const sourceTriggers: Partial<Record<CostStructureIssueCode, ReturnType<typeof structure>>> = {
    shopify_source_meaning_unknown: structure({
      components: [],
      sourcePolicy: { productCostAuthority: "shopify_unit_cost" },
    }),
    shopify_source_product_cost_missing: structure({
      components: [],
      sourcePolicy: shopifyPolicy({ includedFamilies: [] }),
    }),
    shopify_source_family_not_embeddable: structure({
      components: [],
      sourcePolicy: shopifyPolicy({ includedFamilies: ["product_purchase", "overhead_fixed"] }),
    }),
    shopify_source_family_also_direct: structure({
      components: [component({ id: "direct-product" })],
      sourcePolicy: shopifyPolicy(),
    }),
    shopify_fallback_component_missing: structure({
      components: [],
      sourcePolicy: shopifyPolicy({ missingCostPolicy: "manual_fallback" }),
    }),
    shopify_fallback_component_invalid: structure({
      components: [component({ id: "fallback", family: "packaging" })],
      sourcePolicy: shopifyPolicy({
        missingCostPolicy: "manual_fallback",
        fallbackComponentId: "fallback",
      }),
    }),
    shopify_fallback_composition_mismatch: structure({
      components: [component({ id: "fallback" })],
      sourcePolicy: shopifyPolicy({
        meaning: "landed_cost",
        includedFamilies: ["product_purchase", "inbound_logistics", "duties_import"],
        missingCostPolicy: "manual_fallback",
        fallbackComponentId: "fallback",
      }),
    }),
    shopify_coverage_threshold_invalid: structure({
      components: [],
      sourcePolicy: shopifyPolicy({ minimumCoveragePercent: 101 }),
    }),
  };

  it("covers every declared issue code", () => {
    expect([...Object.keys(triggers), ...Object.keys(sourceTriggers)].sort()).toEqual(
      [...COST_STRUCTURE_ISSUE_CODES].sort(),
    );
  });

  it.each(COST_STRUCTURE_ISSUE_CODES)("emits %s for its minimal trigger", (code) => {
    const sourceTrigger = sourceTriggers[code];
    const issues = sourceTrigger
      ? validateCostStructure(sourceTrigger)
      : validateOf(...(triggers[code] ?? []));
    expect(codesOf(issues)).toContain(code);
  });
});
