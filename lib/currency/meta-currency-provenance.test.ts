/**
 * What may be written into `meta_entity_state_history.budget_currency_exponent`.
 *
 * The column scales a PROVIDER amount, so the ISO exponent alone is not
 * sufficient evidence for it. These cases pin the rule that a value is
 * recorded only when Meta's own published offset implies the same number of
 * subdivision digits, and that a disagreement is recorded as nothing.
 */
import { describe, expect, it } from "vitest";

import { metaBudgetCurrencyProvenance } from "@/lib/api/meta";
import {
  META_ISO_OFFSET_DIVERGENCES,
  resolveMetaCurrencyOffset,
} from "@/lib/currency/meta-currency-offsets";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";

describe("what may be stamped as a budget currency exponent", () => {
  it("records the exponent when both authorities agree", () => {
    /* Every currency the warehouse actually holds. Nothing about this pass
       changes what a live account records. */
    for (const [code, exponent] of [
      ["USD", 2],
      ["TRY", 2],
      ["GBP", 2],
      ["JPY", 0],
      ["KRW", 0],
    ] as const) {
      const stamped = metaBudgetCurrencyProvenance(code);
      expect(stamped.budgetCurrencyExponent, code).toBe(exponent);
      expect(stamped.budgetCurrencyRegistryVersion, code).not.toBeNull();
    }
  });

  it("records nothing where Meta and ISO disagree", () => {
    /*
      Derived from the exported divergence table rather than restated, so a
      registry edit that re-aligns them cannot leave this case passing for the
      wrong reason. HUF/IDR/TWD/COP are 100x apart and BHD/JOD are 10x apart;
      either way the stored number would be a scale one authority denies.
    */
    const codes = Object.keys(META_ISO_OFFSET_DIVERGENCES);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const meta = resolveMetaCurrencyOffset(code);
      const iso = resolveMinorUnitExponent(code);
      expect(meta.status, code).toBe("resolved");
      expect(iso.status, code).toBe("resolved");
      const stamped = metaBudgetCurrencyProvenance(code);
      expect(stamped.budgetCurrencyExponent, code).toBeNull();
      expect(stamped.budgetCurrencyRegistryVersion, code).toBeNull();
    }
  });

  it("records nothing for a code ISO resolves and Meta does not publish", () => {
    /*
      ISO holds these at three decimals. Meta publishes no offset above 100
      anywhere in its table and lists none of them, and the two three-decimal
      currencies Meta DOES list — BHD and JOD — are both mapped to 100. So a
      three-decimal stamp here would be a scale no provider document supports.
    */
    for (const code of ["KWD", "OMR", "TND", "IQD", "LYD"]) {
      expect(resolveMinorUnitExponent(code).status, code).toBe("resolved");
      expect(resolveMetaCurrencyOffset(code).status, code).toBe(
        "unknown_currency",
      );
      expect(metaBudgetCurrencyProvenance(code).budgetCurrencyExponent, code)
        .toBeNull();
    }
  });

  it("still records nothing for an absent or unknown currency", () => {
    for (const code of [null, "", "ZZZ", "not-a-code"]) {
      expect(metaBudgetCurrencyProvenance(code as string | null)).toEqual({
        budgetCurrencyExponent: null,
        budgetCurrencyRegistryVersion: null,
      });
    }
  });
});
