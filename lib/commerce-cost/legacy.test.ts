import { describe, expect, it } from "vitest";
import type {
  CommerceCostComponent,
  CommerceCostStructure,
  CostStructureConflict,
} from "@/src/types/commerce-cost";
import {
  LEGACY_PERCENT_BASE,
  buildLegacyCostStructure,
  legacyStructureNeedsConfirmation,
  type LegacyCostImportInput,
} from "./legacy";
import { REPORTING_CURRENCY, entryFor, resolve, structure } from "./__tests__/fixtures";
import { validateCostStructure } from "./validate";

/**
 * Importing the legacy cost percentages.
 *
 * The module exists because two legacy places hold cost assumptions that can
 * disagree — `business_cost_models` (what Overview, reports and the Google
 * advisor actually cost with) and `business_target_packs.cost_*` (what
 * Commercial Truth displays) — and nothing reconciles them today. The tests
 * below are about the four promises that makes: nothing is invented, nothing
 * is silently reconciled, nothing is promoted to an observation, and the
 * numbers an import produces are the numbers the product already shows.
 */

const EFFECTIVE_FROM = "2026-01-01T00:00:00.000Z";
const RECORDED_AT = "2026-09-01T12:30:00.000Z";

function input(overrides: Partial<LegacyCostImportInput> = {}): LegacyCostImportInput {
  return {
    businessId: "business-1",
    reportingCurrency: REPORTING_CURRENCY,
    recordedAt: RECORDED_AT,
    effectiveFrom: EFFECTIVE_FROM,
    ...overrides,
  };
}

/** Both legacy sources agreeing — the boring case the others deviate from. */
function agreeingInput(overrides: Partial<LegacyCostImportInput> = {}): LegacyCostImportInput {
  return input({
    costModel: {
      cogsPercent: 0.35,
      shippingPercent: 0.08,
      feePercent: 0.025,
      fixedCost: 12000,
      updatedAt: "2026-05-05T00:00:00.000Z",
    },
    targetPackCosts: {
      cogsPercent: 0.35,
      shippingPercent: 0.08,
      fulfillmentPercent: 0.02,
      paymentProcessingPercent: 0.025,
      updatedAt: "2026-06-06T00:00:00.000Z",
    },
    ...overrides,
  });
}

function bySlot(built: CommerceCostStructure, slot: string): CommerceCostComponent | undefined {
  return built.components.find((component) => component.slot === slot);
}

/** The slot's percentage, or null when the slot was not imported at all. */
function percentOf(built: CommerceCostStructure, slot: string): number | null {
  const basis = bySlot(built, slot)?.basis;
  return basis && basis.kind === "percent_of_base" ? basis.percent : null;
}

// ---------------------------------------------------------------------------
// Percentage conversion
// ---------------------------------------------------------------------------

describe("legacy percentage conversion", () => {
  it("reads the legacy columns as unit intervals and stores percentages", () => {
    // 0.35 in the column means 35%. Storing 0.35 as the percent would divide
    // every cost by a hundred and make everything look wildly profitable.
    const built = buildLegacyCostStructure(agreeingInput());
    expect(percentOf(built, "legacy_cogs")).toBe(35);
    expect(percentOf(built, "legacy_shipping")).toBe(8);
    expect(percentOf(built, "legacy_fees")).toBe(2.5);
    expect(percentOf(built, "legacy_fulfillment")).toBe(2);
  });

  it("keeps a legacy zero as a real 0% component rather than dropping it", () => {
    // Absent and zero are different states in this domain. The cost-model
    // loader turns a NULL column into 0, so a 0 that reaches here is a stated
    // "no cost", and dropping it would turn it into "unknown".
    const built = buildLegacyCostStructure(
      input({ costModel: { cogsPercent: 0, shippingPercent: null, feePercent: null } }),
    );
    expect(built.components).toHaveLength(1);
    expect(percentOf(built, "legacy_cogs")).toBe(0);
    expect(built.expectedFamilies).toEqual(["product_purchase"]);
  });

  it("skips a null percentage entirely instead of importing a zero", () => {
    // A null column is an unanswered question. Importing it as 0% would state
    // that the cost does not exist, which is a different and wrong claim.
    const built = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: 0.35, shippingPercent: null, feePercent: null },
      }),
    );
    expect(built.components.map((component) => component.slot)).toEqual(["legacy_cogs"]);
    expect(bySlot(built, "legacy_shipping")).toBeUndefined();
    expect(bySlot(built, "legacy_fees")).toBeUndefined();
  });

  it("skips an undefined percentage, including when a whole source is absent", () => {
    const built = buildLegacyCostStructure(
      input({
        costModel: {
          cogsPercent: 0.35,
          shippingPercent: undefined as unknown as number,
          feePercent: null,
        },
        targetPackCosts: null,
      }),
    );
    expect(built.components.map((component) => component.slot)).toEqual(["legacy_cogs"]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("skips a non-finite percentage (%s)", (_label, value) => {
    // A non-finite percentage would propagate NaN/Infinity into every profit
    // number downstream; refusing it keeps the family honestly unknown.
    const built = buildLegacyCostStructure(
      input({ costModel: { cogsPercent: value, shippingPercent: null, feePercent: null } }),
    );
    expect(built.components).toEqual([]);
    expect(built.expectedFamilies).toEqual([]);
  });

  it("skips a value that is not a number at all", () => {
    // Defence against a numeric DB column arriving as a string: a string is
    // dropped rather than coerced, so it can never become "0.35%".
    // A Postgres NUMERIC arrives as a string through some drivers, so a
    // numeric string is the same fact and must not drop the family.
    const numericString = buildLegacyCostStructure(
      input({
        costModel: {
          cogsPercent: "0.35" as unknown as number,
          shippingPercent: null,
          feePercent: null,
        },
      }),
    );
    expect(numericString.components).toHaveLength(1);
    expect(numericString.components[0]?.basis).toMatchObject({ percent: 35 });

    // Text that is not a number at all is still a missing value.
    const notANumber = buildLegacyCostStructure(
      input({
        costModel: {
          cogsPercent: "n/a" as unknown as number,
          shippingPercent: null,
          feePercent: null,
        },
      }),
    );
    expect(notANumber.components).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Family mapping
// ---------------------------------------------------------------------------

describe("legacy field to family mapping", () => {
  it("maps each legacy field to the family that carries that cost", () => {
    const built = buildLegacyCostStructure(agreeingInput());
    expect(
      built.components.map((component) => [component.slot, component.family]),
    ).toEqual([
      ["legacy_cogs", "product_purchase"],
      ["legacy_shipping", "outbound_shipping"],
      ["legacy_fees", "payment_processing"],
      ["legacy_fulfillment", "fulfillment"],
      ["legacy_fixed_monthly", "overhead_fixed"],
    ]);
  });

  it("maps the target pack's payment-processing column onto the fee family", () => {
    // The two sources name the same cost differently (`feePercent` vs
    // `paymentProcessingPercent`); they must land on one family, or the same
    // money is counted twice.
    const built = buildLegacyCostStructure(
      input({
        targetPackCosts: {
          cogsPercent: null,
          shippingPercent: null,
          fulfillmentPercent: null,
          paymentProcessingPercent: 0.025,
        },
      }),
    );
    const fees = bySlot(built, "legacy_fees");
    expect(fees?.family).toBe("payment_processing");
    expect(percentOf(built, "legacy_fees")).toBe(2.5);
  });

  it("takes fulfilment only from the target pack, because only it ever stored one", () => {
    // `business_cost_models` has no fulfilment column, so a fulfilment
    // component can never claim the cost model as its source.
    const built = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: 0.35, shippingPercent: 0.08, feePercent: 0.025 },
        targetPackCosts: {
          cogsPercent: null,
          shippingPercent: null,
          fulfillmentPercent: 0.02,
          paymentProcessingPercent: null,
        },
      }),
    );
    expect(bySlot(built, "legacy_fulfillment")?.source).toEqual({
      kind: "legacy_import",
      ref: "business_target_packs",
    });
  });

  it("imports no fulfilment component when the target pack has none", () => {
    const built = buildLegacyCostStructure(
      input({ costModel: { cogsPercent: 0.35, shippingPercent: 0.08, feePercent: 0.025 } }),
    );
    expect(bySlot(built, "legacy_fulfillment")).toBeUndefined();
    expect(built.expectedFamilies).not.toContain("fulfillment");
  });
});

// ---------------------------------------------------------------------------
// Component shape
// ---------------------------------------------------------------------------

describe("imported component shape", () => {
  const built = buildLegacyCostStructure(agreeingInput());
  const percentComponents = built.components.filter(
    (component) => component.basis.kind === "percent_of_base",
  );

  it("imports four percentage components", () => {
    expect(percentComponents).toHaveLength(4);
  });

  it("marks every imported percentage as an operator estimate, never an observation", () => {
    // These numbers were typed by a human. Presenting them at an observed tier
    // would let an estimate outrank a real payout or invoice.
    for (const component of percentComponents) {
      expect(component.evidence).toBe("operator_estimate");
    }
  });

  it("names legacy_import as the source kind with the table it came from", () => {
    for (const component of percentComponents) {
      expect(component.source.kind).toBe("legacy_import");
    }
    expect(bySlot(built, "legacy_cogs")?.source.ref).toBe("business_cost_models");
    expect(bySlot(built, "legacy_shipping")?.source.ref).toBe("business_cost_models");
    expect(bySlot(built, "legacy_fees")?.source.ref).toBe("business_cost_models");
    expect(bySlot(built, "legacy_fulfillment")?.source.ref).toBe("business_target_packs");
  });

  it("imports the percentages as active components", () => {
    for (const component of percentComponents) expect(component.status).toBe("active");
  });

  it("keeps the base the percentages are applied against today", () => {
    // The legacy percentages are taken off the order total including tax and
    // shipping. Re-basing them on net sales would silently restate history.
    expect(LEGACY_PERCENT_BASE).toBe("order_total_incl_tax");
    for (const component of percentComponents) {
      expect(component.basis).toMatchObject({
        kind: "percent_of_base",
        base: "order_total_incl_tax",
        allocation: "revenue",
      });
    }
  });

  it("states each percentage in the reporting currency", () => {
    // A percentage of a base carries no currency of its own; claiming a
    // different one would demand an FX policy that does not exist.
    const inOtherCurrency = buildLegacyCostStructure(
      agreeingInput({ reportingCurrency: "EUR" }),
    );
    for (const component of built.components) expect(component.currency).toBe(REPORTING_CURRENCY);
    for (const component of inOtherCurrency.components) expect(component.currency).toBe("EUR");
    expect(inOtherCurrency.reportingCurrency).toBe("EUR");
  });

  it("takes both effective and recorded time from the input, not from a clock", () => {
    // Valid time and transaction time are what make "what did we believe
    // then" reproducible; reading a clock here would make imports untestable.
    for (const component of built.components) {
      expect(component.effectiveFrom).toBe(EFFECTIVE_FROM);
      expect(component.recordedAt).toBe(RECORDED_AT);
      expect(component.audit?.createdAt).toBe(RECORDED_AT);
    }
  });

  it("gives every component a stable legacy id, version 1 and a store-wide scope", () => {
    expect(built.components.map((component) => component.id)).toEqual([
      "legacy:legacy_cogs",
      "legacy:legacy_shipping",
      "legacy:legacy_fees",
      "legacy:legacy_fulfillment",
      "legacy:fixed_monthly",
    ]);
    for (const component of built.components) {
      expect(component.version).toBe(1);
      expect(component.scope).toEqual([]);
    }
  });

  it("leaves the tax treatment unknown and recognises percentages on the order", () => {
    // Nothing in the legacy columns says whether the percentages are gross or
    // net of recoverable tax, so the import refuses to guess.
    for (const component of percentComponents) {
      expect(component.taxTreatment).toBe("unknown");
      expect(component.recognition).toBe("on_order");
    }
  });

  it("labels each component as a legacy estimate and records where it came from", () => {
    expect(bySlot(built, "legacy_cogs")?.label).toBe("COGS (legacy estimate)");
    expect(bySlot(built, "legacy_fulfillment")?.audit?.note).toContain(
      "imported from business_target_packs",
    );
    expect(bySlot(built, "legacy_cogs")?.audit?.note).toContain(
      "imported from business_cost_models",
    );
  });

  it("records the legacy change time as provenance without letting it set time", () => {
    // The legacy row's own change time says nothing about which window the
    // percentage was true for, so it informs the audit note only.
    const withOtherStamps = buildLegacyCostStructure(
      agreeingInput({
        costModel: {
          cogsPercent: 0.35,
          shippingPercent: 0.08,
          feePercent: 0.025,
          fixedCost: 12000,
          updatedAt: "1999-01-01T00:00:00.000Z",
        },
        targetPackCosts: {
          cogsPercent: 0.35,
          shippingPercent: 0.08,
          fulfillmentPercent: 0.02,
          paymentProcessingPercent: 0.025,
          updatedAt: null,
        },
      }),
    );
    for (const component of withOtherStamps.components) {
      expect(component.effectiveFrom).toBe(built.components[0]?.effectiveFrom);
      expect(component.recordedAt).toBe(built.components[0]?.recordedAt);
    }
    expect(bySlot(withOtherStamps, "legacy_cogs")?.audit?.note).toContain(
      "last changed 1999-01-01T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Structure level
// ---------------------------------------------------------------------------

describe("imported structure", () => {
  it("declares its origin and refuses to claim confirmation", () => {
    // The percentages exist; what they include is unknown until the owner
    // says. `confirmed` is the gate that keeps profit labelled as estimated.
    const built = buildLegacyCostStructure(agreeingInput());
    expect(built.origin).toBe("legacy_import");
    expect(built.confirmed).toBe(false);
  });

  it("carries the business, currency and both times through unchanged", () => {
    const built = buildLegacyCostStructure(agreeingInput({ businessId: "business-42" }));
    expect(built.businessId).toBe("business-42");
    expect(built.reportingCurrency).toBe(REPORTING_CURRENCY);
    expect(built.effectiveFrom).toBe(EFFECTIVE_FROM);
    expect(built.recordedAt).toBe(RECORDED_AT);
  });

  it("defaults the structure version to 0", () => {
    expect(buildLegacyCostStructure(agreeingInput()).version).toBe(0);
  });

  it("honours an explicit structure version, including an explicit 0", () => {
    // `?? 0` rather than `|| 0`, so version 0 is a real choice and not a hole.
    expect(buildLegacyCostStructure(agreeingInput({ structureVersion: 7 })).version).toBe(7);
    expect(buildLegacyCostStructure(agreeingInput({ structureVersion: 0 })).version).toBe(0);
  });

  it("expects exactly the families it imported", () => {
    // `expectedFamilies` drives gap detection. Listing a family nobody
    // imported would invent a permanent unknown; omitting one would hide it.
    const built = buildLegacyCostStructure(agreeingInput());
    expect(built.expectedFamilies).toEqual([
      "product_purchase",
      "outbound_shipping",
      "payment_processing",
      "fulfillment",
      "overhead_fixed",
    ]);
  });

  it("lists each expected family once", () => {
    const built = buildLegacyCostStructure(agreeingInput());
    const families = [...(built.expectedFamilies ?? [])];
    expect(families).toEqual([...new Set(families)]);
  });

  it("carries a note that states what the import did and did not assume", () => {
    const built = buildLegacyCostStructure(agreeingInput());
    expect(built.note).toContain("Imported legacy estimates");
    expect(built.note).toContain("order total including tax and shipping");
  });

  it("still returns an unconfirmed legacy structure when neither source has anything", () => {
    // A business with no legacy cost model must not produce a structure that
    // looks confirmed and complete with zero components.
    const built = buildLegacyCostStructure(input());
    expect(built.components).toEqual([]);
    expect(built.expectedFamilies).toEqual([]);
    expect(built.conflicts).toEqual([]);
    expect(built.origin).toBe("legacy_import");
    expect(built.confirmed).toBe(false);
    expect(built.note).toBeTruthy();
    expect(legacyStructureNeedsConfirmation(built)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Conflicts between the two legacy sources
// ---------------------------------------------------------------------------

describe("disagreement between the legacy sources", () => {
  const conflicting = buildLegacyCostStructure(
    input({
      costModel: { cogsPercent: 0.35, shippingPercent: 0.08, feePercent: 0.025 },
      targetPackCosts: {
        cogsPercent: 0.3,
        shippingPercent: 0.08,
        fulfillmentPercent: 0.02,
        paymentProcessingPercent: 0.025,
      },
    }),
  );

  it("records the disagreement instead of silently picking a side", () => {
    expect(conflicting.conflicts).toHaveLength(1);
    expect(conflicting.conflicts?.[0]).toMatchObject({
      family: "product_purchase",
      slot: "legacy_cogs",
    });
  });

  it("names both candidate sources and both values in the conflict", () => {
    // Whoever resolves this has to see which table said what; a conflict that
    // only says "they disagree" is not actionable.
    expect(conflicting.conflicts?.[0]?.candidates).toEqual([
      {
        source: { kind: "legacy_import", ref: "business_cost_models" },
        value: 35,
        note: "used by Overview, reports and the Google advisor",
      },
      {
        source: { kind: "legacy_import", ref: "business_target_packs" },
        value: 30,
        note: "shown on Commercial Truth",
      },
    ]);
  });

  it("explains which value the runtime uses today", () => {
    expect(conflicting.conflicts?.[0]?.detail).toContain("business_cost_models");
    expect(conflicting.conflicts?.[0]?.detail).toContain("business_target_packs");
    expect(conflicting.conflicts?.[0]?.detail).toContain("the runtime uses today");
  });

  it("keeps the cost-model value on the component, so the import reproduces today's numbers", () => {
    // Runtime parity is the point of the import. Taking the Commercial Truth
    // value here would change every Overview number the day it landed.
    expect(percentOf(conflicting, "legacy_cogs")).toBe(35);
    expect(bySlot(conflicting, "legacy_cogs")?.source.ref).toBe("business_cost_models");
  });

  it("states on the component itself that the sources disagreed", () => {
    expect(bySlot(conflicting, "legacy_cogs")?.reason).toBe(
      "Legacy sources disagree; conflict recorded.",
    );
  });

  it("leaves agreeing families free of a conflict and of a reason", () => {
    const slots = conflicting.conflicts?.map((conflict) => conflict.slot) ?? [];
    expect(slots).not.toContain("legacy_shipping");
    expect(bySlot(conflicting, "legacy_shipping")?.reason).toBeNull();
    expect(bySlot(conflicting, "legacy_fees")?.reason).toBeNull();
  });

  it("records no conflict when both sources agree", () => {
    expect(buildLegacyCostStructure(agreeingInput()).conflicts).toEqual([]);
  });

  it("records a conflict per disagreeing family, independently", () => {
    const built = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: 0.35, shippingPercent: 0.08, feePercent: 0.025 },
        targetPackCosts: {
          cogsPercent: 0.3,
          shippingPercent: 0.05,
          fulfillmentPercent: 0.02,
          paymentProcessingPercent: 0.01,
        },
      }),
    );
    expect(built.conflicts?.map((conflict) => conflict.family)).toEqual([
      "product_purchase",
      "outbound_shipping",
      "payment_processing",
    ]);
    // Every conflicting component still carries the cost-model number.
    expect(percentOf(built, "legacy_shipping")).toBe(8);
    expect(percentOf(built, "legacy_fees")).toBe(2.5);
  });

  it("treats a difference below the tolerance as agreement", () => {
    // Legacy columns are stored at different precisions; a rounding artefact
    // is not an operator disagreement worth a confirmation prompt.
    const built = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: 0.35, shippingPercent: null, feePercent: null },
        targetPackCosts: {
          cogsPercent: 0.3500001,
          shippingPercent: null,
          fulfillmentPercent: null,
          paymentProcessingPercent: null,
        },
      }),
    );
    expect(built.conflicts).toEqual([]);
    expect(bySlot(built, "legacy_cogs")?.reason).toBeNull();
  });

  it("records no conflict when only the cost model holds the value", () => {
    // One source being silent is not a disagreement.
    const built = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: 0.35, shippingPercent: null, feePercent: null },
        targetPackCosts: {
          cogsPercent: null,
          shippingPercent: null,
          fulfillmentPercent: null,
          paymentProcessingPercent: null,
        },
      }),
    );
    expect(built.conflicts).toEqual([]);
    expect(bySlot(built, "legacy_cogs")?.source.ref).toBe("business_cost_models");
    expect(bySlot(built, "legacy_cogs")?.audit?.note).toBe("imported from business_cost_models");
  });

  it("points the ref at the target pack when only the target pack holds the value", () => {
    const built = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: null, shippingPercent: null, feePercent: null },
        targetPackCosts: {
          cogsPercent: 0.3,
          shippingPercent: null,
          fulfillmentPercent: null,
          paymentProcessingPercent: null,
        },
      }),
    );
    expect(built.conflicts).toEqual([]);
    expect(percentOf(built, "legacy_cogs")).toBe(30);
    expect(bySlot(built, "legacy_cogs")?.source.ref).toBe("business_target_packs");
    expect(bySlot(built, "legacy_cogs")?.audit?.note).toBe("imported from business_target_packs");
  });

  it("treats a 0 in one source against a value in the other as a real disagreement", () => {
    // 0% and 30% are two different claims about the same cost, not a gap.
    const built = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: 0, shippingPercent: null, feePercent: null },
        targetPackCosts: {
          cogsPercent: 0.3,
          shippingPercent: null,
          fulfillmentPercent: null,
          paymentProcessingPercent: null,
        },
      }),
    );
    expect(built.conflicts).toHaveLength(1);
    expect(percentOf(built, "legacy_cogs")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The fixed monthly cost
// ---------------------------------------------------------------------------

describe("legacy fixed monthly cost", () => {
  const built = buildLegacyCostStructure(agreeingInput());
  const fixed = bySlot(built, "legacy_fixed_monthly");

  it("becomes a monthly period amount on the fixed-overhead family", () => {
    // The legacy Overview added the whole monthly amount to every window and
    // every day of the trend line. As a period amount the window prorates it,
    // and it can never be added to a marginal per-order cost.
    expect(fixed?.family).toBe("overhead_fixed");
    expect(fixed?.basis).toEqual({
      kind: "period_amount",
      amount: 12000,
      period: "month",
      allocation: "revenue",
    });
  });

  it("is recognised on the period rather than on the order", () => {
    expect(fixed?.recognition).toBe("on_period");
  });

  it("names the exact legacy column it came from", () => {
    expect(fixed?.source).toEqual({
      kind: "legacy_import",
      ref: "business_cost_models.fixed_monthly_cost",
    });
    expect(fixed?.evidence).toBe("operator_estimate");
    expect(fixed?.status).toBe("active");
    expect(fixed?.currency).toBe(REPORTING_CURRENCY);
    expect(fixed?.effectiveFrom).toBe(EFFECTIVE_FROM);
    expect(fixed?.recordedAt).toBe(RECORDED_AT);
  });

  it("adds overhead_fixed to the expected families only when a fixed cost exists", () => {
    expect(built.expectedFamilies).toContain("overhead_fixed");
  });

  it("preserves a stated zero fixed cost as distinct from missing", () => {
    const zero = buildLegacyCostStructure(
      input({ costModel: { cogsPercent: 0.35, shippingPercent: null, feePercent: null, fixedCost: 0 } }),
    );
    expect(bySlot(zero, "legacy_fixed_monthly")?.basis).toEqual({
      kind: "period_amount",
      amount: 0,
      period: "month",
      allocation: "revenue",
    });
    expect(zero.expectedFamilies).toContain("overhead_fixed");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("creates no component for a %s fixed cost", (_label, value) => {
    const built2 = buildLegacyCostStructure(
      input({
        costModel: {
          cogsPercent: 0.35,
          shippingPercent: null,
          feePercent: null,
          fixedCost: value as number | null | undefined,
        },
      }),
    );
    expect(bySlot(built2, "legacy_fixed_monthly")).toBeUndefined();
    expect(built2.expectedFamilies).not.toContain("overhead_fixed");
  });

  it("never invents a fixed cost from the target pack, which has no such column", () => {
    const packOnly = buildLegacyCostStructure(
      input({
        targetPackCosts: {
          cogsPercent: 0.3,
          shippingPercent: 0.05,
          fulfillmentPercent: 0.02,
          paymentProcessingPercent: 0.01,
        },
      }),
    );
    expect(bySlot(packOnly, "legacy_fixed_monthly")).toBeUndefined();
  });

  it("imports a negative fixed cost as-is and lets validation refuse it", () => {
    // Documented actual behaviour: the importer does not sanitise, so bad
    // legacy data stays visible rather than being quietly zeroed. The
    // structure validator is what blocks it.
    const negative = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: null, shippingPercent: null, feePercent: null, fixedCost: -500 },
      }),
    );
    expect(bySlot(negative, "legacy_fixed_monthly")?.basis).toMatchObject({ amount: -500 });
    expect(
      validateCostStructure(negative).filter((issue) => issue.severity === "error"),
    ).toMatchObject([{ code: "negative_amount" }]);
  });
});

// ---------------------------------------------------------------------------
// The confirmation rule
// ---------------------------------------------------------------------------

describe("legacyStructureNeedsConfirmation", () => {
  const conflict: CostStructureConflict = {
    family: "product_purchase",
    slot: "legacy_cogs",
    detail: "two sources disagree",
    candidates: [],
  };

  it("is true for any legacy import", () => {
    // A legacy import is estimates with unknown composition, whatever else is
    // true of it, so profit from it can never be called actual.
    expect(legacyStructureNeedsConfirmation(buildLegacyCostStructure(agreeingInput()))).toBe(true);
  });

  it("stays true for a legacy import even if something marked it confirmed", () => {
    const built = { ...buildLegacyCostStructure(agreeingInput()), confirmed: true };
    expect(legacyStructureNeedsConfirmation(built)).toBe(true);
  });

  it("is true whenever conflicts exist, even on a confirmed operator structure", () => {
    expect(
      legacyStructureNeedsConfirmation(structure({ conflicts: [conflict] })),
    ).toBe(true);
  });

  it("is true for an unconfirmed structure of any origin", () => {
    expect(legacyStructureNeedsConfirmation(structure({ confirmed: false }))).toBe(true);
    expect(
      legacyStructureNeedsConfirmation(structure({ origin: "template", confirmed: false })),
    ).toBe(true);
  });

  it("is false only for a confirmed, conflict-free, non-legacy structure", () => {
    expect(legacyStructureNeedsConfirmation(structure())).toBe(false);
    expect(legacyStructureNeedsConfirmation(structure({ conflicts: [] }))).toBe(false);
    expect(legacyStructureNeedsConfirmation(structure({ origin: "template" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: the imported structure has to survive the rest of the pipeline
// ---------------------------------------------------------------------------

describe("imported structure against validation and resolution", () => {
  const built = buildLegacyCostStructure(agreeingInput());

  it("produces no error-severity validation issues", () => {
    // An import nobody can activate is useless. The percentages are in range,
    // sum to well under the whole order, the currency matches the reporting
    // currency and the fixed cost is a period amount on a fixed family.
    expect(validateCostStructure(built).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("still validates cleanly when the two sources disagree", () => {
    // A recorded conflict is a product-level question, not a structural
    // defect; it must not block the import from being stored.
    const conflicting = buildLegacyCostStructure(
      input({
        costModel: { cogsPercent: 0.35, shippingPercent: 0.08, feePercent: 0.025, fixedCost: 12000 },
        targetPackCosts: {
          cogsPercent: 0.2,
          shippingPercent: 0.04,
          fulfillmentPercent: 0.02,
          paymentProcessingPercent: 0.01,
        },
      }),
    );
    expect(conflicting.conflicts?.length).toBeGreaterThan(0);
    expect(
      validateCostStructure(conflicting).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
  });

  it("resolves each imported percentage as that percentage of the order total including tax", () => {
    // The order fixture has order_total_incl_tax = 1200 on a single 1000-line,
    // so the order-level amount is spread whole onto that line. This is the
    // runtime-parity check: 35% of 1200 is what Overview shows today.
    const result = resolve({ structure: built });
    expect(entryFor(result, "product_purchase", "line-1", "legacy_cogs")).toMatchObject({
      state: "value",
      amount: 420,
    });
    expect(entryFor(result, "outbound_shipping", "line-1", "legacy_shipping")).toMatchObject({
      state: "value",
      amount: 96,
    });
    expect(entryFor(result, "payment_processing", "line-1", "legacy_fees")).toMatchObject({
      state: "value",
      amount: 30,
    });
    expect(entryFor(result, "fulfillment", "line-1", "legacy_fulfillment")).toMatchObject({
      state: "value",
      amount: 24,
    });
  });

  it("carries the estimate flag, evidence and legacy source through to every entry", () => {
    // An imported estimate must arrive at the ladder still labelled as one.
    const result = resolve({ structure: built });
    const cogs = entryFor(result, "product_purchase", "line-1", "legacy_cogs");
    expect(cogs?.estimated).toBe(true);
    expect(cogs?.evidence).toBe("operator_estimate");
    expect(cogs?.source).toEqual({ kind: "legacy_import", ref: "business_cost_models" });
    expect(cogs?.ownerComponentId).toBe("legacy:legacy_cogs");
    expect(cogs?.recognition).toBe("on_order");
  });

  it("spreads the order-level percentage by revenue rather than pinning it to a line", () => {
    const result = resolve({ structure: built });
    expect(entryFor(result, "product_purchase", "line-1", "legacy_cogs")?.allocation).toEqual({
      driver: "revenue",
      orderAmount: 420,
      weight: 1000,
      totalWeight: 1000,
    });
  });

  it("keeps the fixed monthly cost out of the per-order numbers entirely", () => {
    // The whole reason it is a period component: it is deferred to the window,
    // so no marginal decision can ever see it.
    const result = resolve({ structure: built });
    expect(result.deferredPeriodComponentIds).toEqual(["legacy:fixed_monthly"]);
    expect(
      result.entries.filter((entry) => entry.ownerComponentId === "legacy:fixed_monthly"),
    ).toEqual([]);
    // And it is not reported as a per-line gap either: a recurring cost is
    // answered at the window, so no line is missing it.
    expect(entryFor(result, "overhead_fixed")).toBeUndefined();
  });

  it("resolves nothing at all from an empty legacy import", () => {
    // No components and no expected families, so every family is silent rather
    // than reported as a zero cost.
    const result = resolve({ structure: buildLegacyCostStructure(input()) });
    expect(result.entries).toEqual([]);
    expect(result.deferredPeriodComponentIds).toEqual([]);
  });
});
