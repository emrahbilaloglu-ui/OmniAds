import { describe, expect, it } from "vitest";

import { canonicalCostStructureJson, costStructureRevision, costStructureRevisionOf } from "./revision";
import { component, structure } from "./__tests__/fixtures";

/**
 * The concurrency token.
 *
 * It has to be stable for the same meaning and different for a different one,
 * because a token that collides lets one operator's save overwrite another's.
 */

describe("costStructureRevision", () => {
  it("does not depend on key order", () => {
    const left = structure();
    const reordered = JSON.parse(
      JSON.stringify({
        components: left.components,
        recordedAt: left.recordedAt,
        businessId: left.businessId,
        reportingCurrency: left.reportingCurrency,
        effectiveFrom: left.effectiveFrom,
        confirmed: left.confirmed,
        origin: left.origin,
        version: left.version,
      }),
    );

    expect(costStructureRevision(reordered)).toBe(costStructureRevision(left));
    expect(canonicalCostStructureJson(left).startsWith('{"businessId"')).toBe(true);
  });

  it("changes when anything that matters changes", () => {
    const base = structure();
    const tokens = new Set([
      costStructureRevision(base),
      costStructureRevision({ ...base, version: base.version + 1 }),
      costStructureRevision({ ...base, confirmed: !base.confirmed }),
      costStructureRevision({ ...base, recordedAt: "2026-02-02T00:00:00.000Z" }),
      costStructureRevision({
        ...base,
        components: [component({ basis: { kind: "amount_per_unit", amount: 101 } })],
      }),
      costStructureRevision({ ...base, notTracked: ["packaging"] }),
    ]);

    expect(tokens.size).toBe(6);
  });

  it("includes the declared cost-source authority and Shopify meaning", () => {
    const base = structure();
    const manual = {
      ...base,
      sourcePolicy: { productCostAuthority: "manual_components" as const },
    };
    const shopify = {
      ...base,
      sourcePolicy: {
        productCostAuthority: "shopify_unit_cost" as const,
        shopifyUnitCost: {
          meaning: "landed_cost" as const,
          includedFamilies: ["product_purchase", "inbound_logistics", "duties_import"] as const,
          minimumCoveragePercent: 95,
          missingCostPolicy: "leave_unknown" as const,
          historicalPolicy: "unknown_before_first_observation" as const,
        },
      },
    };

    expect(costStructureRevision(manual)).not.toBe(costStructureRevision(base));
    expect(costStructureRevision(shopify)).not.toBe(costStructureRevision(manual));
  });

  it("keeps component order significant", () => {
    const first = component({ id: "a" });
    const second = component({ id: "b" });
    expect(costStructureRevision(structure({ components: [first, second] }))).not.toBe(
      costStructureRevision(structure({ components: [second, first] })),
    );
  });

  it("tells an explicit null apart from an absent field", () => {
    const absent = structure({ components: [component()] });
    const explicitNull = structure({
      components: [component({ effectiveTo: null })],
    });

    // "There is no end date" and "nobody said" are different answers here, so
    // a token that hid the difference would let a stale write through.
    expect(costStructureRevision(explicitNull)).not.toBe(costStructureRevision(absent));
  });

  it("is a hex sha-256, and null has no token", () => {
    expect(costStructureRevision(structure())).toMatch(/^[0-9a-f]{64}$/);
    expect(costStructureRevisionOf(null)).toBeNull();
    expect(costStructureRevisionOf(structure())).toBe(costStructureRevision(structure()));
  });
});
