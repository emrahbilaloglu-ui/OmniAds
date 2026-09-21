import { describe, expect, it } from "vitest";

import { COST_PAYLOAD_LIMITS, parseCostStructurePayload } from "./payload";
import { validateCostStructure } from "./validate";

/**
 * The HTTP boundary.
 *
 * Every case here is a body that must not reach storage as a number: an
 * unknown enum, a string where money belongs, a time nobody can read, a
 * claim to another business. The rule is refuse-with-a-path, never coerce.
 */

const AUTHORITY = {
  businessId: "business-1",
  version: 7,
  recordedAt: "2026-09-20T10:00:00.000Z",
};

function componentBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "cogs",
    family: "product_purchase",
    basis: { kind: "amount_per_unit", amount: 120 },
    currency: "try",
    taxTreatment: "net_of_recoverable_tax",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    recognition: "on_order",
    evidence: "classified_attribute",
    source: { kind: "shopify_unit_cost", ref: "inventory_item/1" },
    status: "active",
    ...overrides,
  };
}

function structureBody(overrides: Record<string, unknown> = {}) {
  return {
    origin: "operator",
    confirmed: true,
    reportingCurrency: "TRY",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    components: [componentBody()],
    ...overrides,
  };
}

function parse(body: unknown) {
  return parseCostStructurePayload(body, AUTHORITY);
}

function issuesOf(body: unknown) {
  const result = parse(body);
  if (result.ok) throw new Error("expected the payload to be refused");
  return result.issues;
}

describe("parseCostStructurePayload: what it accepts", () => {
  it("rebuilds a structure and normalises the currency", () => {
    const result = parse(structureBody());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.structure.components[0]).toMatchObject({
      id: "cogs",
      family: "product_purchase",
      currency: "TRY",
      slot: "default",
      version: 1,
      scope: [],
    });
    // A clean body is also a structure the domain accepts.
    expect(validateCostStructure(result.structure).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("takes businessId, version and recordedAt from the server, not the body", () => {
    const result = parse(
      structureBody({
        businessId: "someone-elses-business",
        version: 999,
        recordedAt: "1999-01-01T00:00:00.000Z",
        components: [componentBody({ recordedAt: "1999-01-01T00:00:00.000Z", version: 4 })],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.structure.businessId).toBe("business-1");
    expect(result.structure.version).toBe(7);
    expect(result.structure.recordedAt).toBe(AUTHORITY.recordedAt);
    // A component cannot claim when it was recorded either.
    expect(result.structure.components[0]?.recordedAt).toBe(AUTHORITY.recordedAt);
    // Its own version is its business, though.
    expect(result.structure.components[0]?.version).toBe(4);
  });

  it("drops keys it does not know instead of storing them", () => {
    const result = parse(
      structureBody({
        somethingElse: { nested: true },
        components: [componentBody({ injected: "value" })],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect("somethingElse" in result.structure).toBe(false);
    expect("injected" in (result.structure.components[0] ?? {})).toBe(false);
  });

  it("keeps an explicit null and an absent field apart", () => {
    const withNull = parse(structureBody({ components: [componentBody({ effectiveTo: null })] }));
    const without = parse(structureBody());
    expect(withNull.ok && "effectiveTo" in withNull.structure.components[0]!).toBe(true);
    expect(withNull.ok && withNull.structure.components[0]?.effectiveTo).toBeNull();
    expect(without.ok && "effectiveTo" in without.structure.components[0]!).toBe(false);
  });

  it("keeps a zero as a zero", () => {
    const result = parse(
      structureBody({ components: [componentBody({ basis: { kind: "amount_per_unit", amount: 0 } })] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structure.components[0]?.basis).toEqual({ kind: "amount_per_unit", amount: 0 });
  });

  it("accepts every basis kind with its own required fields", () => {
    const bases: Array<Record<string, unknown>> = [
      { kind: "amount_per_line", amount: 12 },
      { kind: "amount_per_order", amount: 12, allocation: "revenue" },
      { kind: "percent_of_base", percent: 2.9, base: "line_net_sales" },
      {
        kind: "percent_plus_fixed",
        percent: 2.9,
        base: "order_payment_captured",
        fixedAmount: 0.25,
        fixedPer: "order",
      },
      {
        kind: "rate_table",
        level: "order",
        rows: [{ amount: 40, weightMaxKg: 5, when: [{ dimension: "market", operator: "in", values: ["TR"] }] }],
        fallbackAmount: null,
      },
      { kind: "bom", components: [{ sku: "PART", quantity: 2, amount: null }], wastePercent: 5 },
      { kind: "period_amount", amount: 30_000, period: "month", allocation: "revenue" },
      { kind: "margin_input", marginKind: "contribution", marginPercent: 40, base: "line_net_sales" },
    ];

    for (const basis of bases) {
      const result = parse(structureBody({ components: [componentBody({ basis })] }));
      expect(result.ok, JSON.stringify(basis)).toBe(true);
    }
  });

  it("carries scope, embeds, shares and fx through", () => {
    const result = parse(
      structureBody({
        notTracked: ["returns_loss", "returns_loss"],
        expectedFamilies: ["product_purchase"],
        note: "imported",
        components: [
          componentBody({
            slot: "base",
            label: "Loaded cost",
            scope: [
              { dimension: "sku", operator: "in", values: [" SKU-1 "] },
              { dimension: "supplier", operator: "exists" },
            ],
            embeds: ["outbound_shipping"],
            embeddedShares: [{ family: "outbound_shipping", kind: "amount_per_unit", value: 50 }],
            replacesEmbedded: false,
            fx: { policy: "fixed_rate", fixedRate: 41.5 },
            refundBehaviour: "product_share_only",
            decisionClass: "contribution",
            currency: "USD",
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [first] = result.structure.components;
    expect(first?.scope[0]).toEqual({ dimension: "sku", operator: "in", values: ["SKU-1"] });
    expect(first?.scope[1]).toEqual({ dimension: "supplier", operator: "exists" });
    expect(first?.embeddedShares).toEqual([
      { family: "outbound_shipping", kind: "amount_per_unit", value: 50 },
    ]);
    expect(first?.fx).toEqual({ policy: "fixed_rate", fixedRate: 41.5 });
    // Deduplicated: a family listed twice means the same thing once.
    expect(result.structure.notTracked).toEqual(["returns_loss"]);
  });

  it("whitelists the business-level Shopify source policy", () => {
    const result = parse(
      structureBody({
        components: [],
        sourcePolicy: {
          productCostAuthority: "hybrid",
          shopifyUnitCost: {
            meaning: "loaded_variable_cost",
            includedFamilies: ["product_purchase", "packaging", "packaging"],
            minimumCoveragePercent: 95,
            missingCostPolicy: "manual_fallback",
            fallbackComponentId: "manual-cogs",
            historicalPolicy: "manual_components_before_first_observation",
            injected: "drop-me",
          },
          injected: "drop-me",
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structure.sourcePolicy).toEqual({
      productCostAuthority: "hybrid",
      shopifyUnitCost: {
        meaning: "loaded_variable_cost",
        includedFamilies: ["product_purchase", "packaging"],
        minimumCoveragePercent: 95,
        missingCostPolicy: "manual_fallback",
        fallbackComponentId: "manual-cogs",
        historicalPolicy: "manual_components_before_first_observation",
      },
    });
  });
});

describe("parseCostStructurePayload: what it refuses", () => {
  it("refuses a body that is not an object", () => {
    for (const body of [null, undefined, 42, "structure", [], true]) {
      expect(issuesOf(body)[0]?.code).toBe("expected_object");
    }
  });

  it("refuses an unknown enum value with the path that carries it", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ origin: "imported" }, "structure.origin"],
      [{ components: [componentBody({ family: "shipping" })] }, "structure.components[0].family"],
      [{ components: [componentBody({ status: "enabled" })] }, "structure.components[0].status"],
      [{ components: [componentBody({ evidence: "guess" })] }, "structure.components[0].evidence"],
      [
        { components: [componentBody({ taxTreatment: "gross" })] },
        "structure.components[0].taxTreatment",
      ],
      [
        { components: [componentBody({ source: { kind: "guesswork" } })] },
        "structure.components[0].source.kind",
      ],
      [
        { components: [componentBody({ basis: { kind: "percent_of_base", percent: 5, base: "gross" } })] },
        "structure.components[0].basis.base",
      ],
      [
        {
          components: [
            componentBody({ scope: [{ dimension: "weather", operator: "in", values: ["rain"] }] }),
          ],
        },
        "structure.components[0].scope[0].dimension",
      ],
      [
        { sourcePolicy: { productCostAuthority: "spreadsheet" } },
        "structure.sourcePolicy.productCostAuthority",
      ],
    ];

    for (const [overrides, path] of cases) {
      const [issue] = issuesOf(structureBody(overrides));
      expect(issue?.code, path).toBe("unknown_value");
      expect(issue?.path).toBe(path);
    }
  });

  it("refuses money that is not a finite number", () => {
    for (const amount of ["120", null, Number.NaN, Number.POSITIVE_INFINITY, {}, undefined]) {
      const [issue] = issuesOf(
        structureBody({ components: [componentBody({ basis: { kind: "amount_per_unit", amount } })] }),
      );
      expect(issue?.code).toBe("expected_finite_number");
      expect(issue?.path).toBe("structure.components[0].basis.amount");
    }
  });

  it("refuses a time nobody can read", () => {
    expect(issuesOf(structureBody({ effectiveFrom: "2026-13-01" }))[0]).toMatchObject({
      code: "unreadable_time",
      path: "structure.effectiveFrom",
    });
    expect(
      issuesOf(structureBody({ components: [componentBody({ effectiveTo: "last tuesday" })] }))[0],
    ).toMatchObject({ code: "unreadable_time", path: "structure.components[0].effectiveTo" });
  });

  it("refuses an unknown basis kind", () => {
    expect(
      issuesOf(structureBody({ components: [componentBody({ basis: { kind: "guess", amount: 1 } })] }))[0],
    ).toMatchObject({ code: "unknown_basis_kind", path: "structure.components[0].basis.kind" });
  });

  it("requires the fields a basis cannot work without", () => {
    const [missingBase] = issuesOf(
      structureBody({ components: [componentBody({ basis: { kind: "percent_of_base", percent: 5 } })] }),
    );
    // A percentage with no base is the defect the domain exists to prevent.
    expect(missingBase).toMatchObject({ path: "structure.components[0].basis.base" });

    const [missingAllocation] = issuesOf(
      structureBody({
        components: [componentBody({ basis: { kind: "amount_per_order", amount: 10 } })],
      }),
    );
    expect(missingAllocation?.path).toBe("structure.components[0].basis.allocation");
  });

  it("requires values for a matching predicate, but not for `exists`", () => {
    expect(
      issuesOf(
        structureBody({
          components: [componentBody({ scope: [{ dimension: "sku", operator: "in" }] })],
        }),
      )[0],
    ).toMatchObject({ code: "values_required", path: "structure.components[0].scope[0].values" });

    expect(parse(structureBody({ components: [componentBody({ scope: [{ dimension: "sku", operator: "exists" }] })] })).ok).toBe(true);
  });

  it("requires confirmed to be stated", () => {
    const body = structureBody();
    delete (body as Record<string, unknown>).confirmed;
    expect(issuesOf(body)[0]).toMatchObject({
      code: "field_required",
      path: "structure.confirmed",
    });
  });

  it("refuses an empty or oversized string", () => {
    expect(issuesOf(structureBody({ components: [componentBody({ id: "   " })] }))[0]?.code).toBe(
      "empty_string",
    );
    expect(
      issuesOf(structureBody({ note: "x".repeat(COST_PAYLOAD_LIMITS.noteLength + 1) }))[0]?.code,
    ).toBe("string_too_long");
  });

  it("refuses more items than it will store", () => {
    const tooMany = Array.from({ length: COST_PAYLOAD_LIMITS.components + 1 }, (_, index) =>
      componentBody({ id: `c-${index}` }),
    );
    expect(issuesOf(structureBody({ components: tooMany }))[0]).toMatchObject({
      code: "too_many_items",
      path: "structure.components",
    });
  });

  it("refuses two records of the same component id, whatever versions they claim", () => {
    // A current structure holds one record per id: a superseded version
    // replaces its predecessor. Appending both would leave the runtime free to
    // keep the wrong one live, because it drops non-active records before it
    // picks the latest version.
    for (const versions of [
      [2, 2],
      [1, 2],
      [3, 1],
    ]) {
      expect(
        issuesOf(
          structureBody({
            components: versions.map((version) => componentBody({ version })),
          }),
        )[0],
      ).toMatchObject({ code: "duplicate_component_id", path: "structure.components[1]" });
    }
  });

  it("allows the same content under different ids", () => {
    expect(
      parse(
        structureBody({
          components: [componentBody({ id: "cogs-a" }), componentBody({ id: "cogs-b" })],
        }),
      ).ok,
    ).toBe(true);
  });

  it("refuses a component version below one", () => {
    expect(
      issuesOf(structureBody({ components: [componentBody({ version: 0 })] }))[0],
    ).toMatchObject({ code: "expected_integer", path: "structure.components[0].version" });
  });
});
