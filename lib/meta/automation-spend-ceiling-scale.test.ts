/**
 * The per-action spend ceiling, and the scale it is stored at.
 *
 * ## Why this file exists
 *
 * `guardrails_json.perActionSpendCeilingMinor` is the only operator-set money
 * guardrail on the automated budget path, and it is compared UNSCALED against
 * the provider minor-unit amount a write would send
 * (`budget-write-safety-projection.ts`, `budget-sizing-policy.ts`). It was
 * minted from typed text using the ISO-4217 exponent.
 *
 * Meta publishes its own per-currency offset and disagrees with ISO for COP,
 * HUF, IDR and TWD (offset 1 versus two decimals) and for BHD and JOD (offset
 * 100 versus three). So on a HUF business a ceiling entered as 50,000 forint
 * was stored as 5,000,000 and compared against real forint amounts: a limit a
 * hundred times looser than the one the operator set. The read-back used the
 * same wrong exponent, so the form showed exactly what they typed and nothing
 * on screen could reveal it.
 *
 * A safety ceiling that fails OPEN is worse than no ceiling, because it
 * reports itself as configured. These cases pin the three independent gates
 * that now stop it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseBudgetAutomationConfig } from "@/lib/meta/budget-automation-config-contract";
import { resolveMetaCurrencyOffset } from "@/lib/currency/meta-currency-offsets";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";

const VIEW = "app/(dashboard)/platforms/meta/automation/automation-view.tsx";

describe("the ceiling is minted and read at the provider's scale", () => {
  /*
    The editor's two halves are module-private, so the arithmetic is
    reproduced here exactly as they perform it and the SOURCE is pinned
    separately below. Both together are the test: the behaviour proves the
    scale is right, the pin proves the editor is the thing performing it.
  */
  const mint = (typed: string, currency: string): number | null => {
    const offset = resolveMetaCurrencyOffset(currency);
    if (offset.status !== "resolved") return null;
    const places = offset.subdivisionDigits;
    const match = /^(\d+)(?:\.(\d+))?$/.exec(typed.trim());
    if (!match || (match[2]?.length ?? 0) > places) return null;
    return Number(`${match[1]}${(match[2] ?? "").padEnd(places, "0")}`);
  };
  const render = (minor: number, currency: string): string | null => {
    const offset = resolveMetaCurrencyOffset(currency);
    if (offset.status !== "resolved") return null;
    const places = offset.subdivisionDigits;
    const digits = String(minor).padStart(places + 1, "0");
    return places === 0
      ? digits
      : `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
  };

  it("does not inflate a ceiling on a currency Meta serves whole", () => {
    /*
      THE DEFECT, as a number. Meta lists HUF at offset 1, so 50,000 forint is
      50000 minor units. The ISO exponent is 2, which minted 5000000 — and the
      comparison at `budget-sizing-policy.ts` is against real forint, so the
      ceiling permitted a hundredfold larger budget than the one entered.
    */
    expect(resolveMetaCurrencyOffset("HUF")).toMatchObject({ subdivisionDigits: 0 });
    expect(resolveMinorUnitExponent("HUF")).toMatchObject({ exponent: 2 });

    expect(mint("50000", "HUF")).toBe(50_000);
    expect(mint("50000", "HUF")).not.toBe(5_000_000);
    expect(render(50_000, "HUF")).toBe("50000");
  });

  it("round-trips a typed ceiling back to the same text, per currency", () => {
    /*
      The read-back must agree with the mint, or the operator confirms a
      different number than the one stored — which is precisely how the old
      defect stayed invisible.
    */
    for (const [typed, currency, minor] of [
      ["50000", "HUF", 50_000],
      ["50000.00", "USD", 5_000_000],
      ["50000.00", "TRY", 5_000_000],
      ["50000.00", "GBP", 5_000_000],
      ["12000", "JPY", 12_000],
    ] as const) {
      expect(mint(typed, currency), currency).toBe(minor);
      expect(render(minor, currency), currency).toBe(typed);
    }
  });

  it("changes nothing for the currencies the warehouse actually holds", () => {
    /* USD, TRY, GBP and EUR agree between both registries, so the provider
       offset substitutes 2 for 2 and every stored ceiling keeps its meaning. */
    for (const code of ["USD", "TRY", "GBP", "EUR"]) {
      const offset = resolveMetaCurrencyOffset(code);
      const iso = resolveMinorUnitExponent(code);
      expect(offset.status, code).toBe("resolved");
      expect(iso.status, code).toBe("resolved");
      if (offset.status === "resolved" && iso.status === "resolved") {
        expect(offset.subdivisionDigits, code).toBe(iso.exponent);
      }
    }
  });

  it("mints nothing at all for a currency the provider does not publish", () => {
    /* No offset means no scale means no ceiling. Downstream that reads as
       "unset", and an unset ceiling WITHHOLDS the budget change entirely
       (`budget-sizing-policy.ts` -> `policy_spend_ceiling_unset`) rather than
       allowing an unlimited one. */
    for (const code of ["KWD", "OMR", "TND", "ZZZ"]) {
      expect(mint("50", code), code).toBeNull();
      expect(render(50_000, code), code).toBeNull();
    }
  });

  it("pins the editor to the provider offset, not the ISO exponent", () => {
    /*
      The behavioural cases above would keep passing if the editor quietly went
      back to ISO, so the source is pinned too. This is the file that mints the
      persisted value.
    */
    const source = readFileSync(VIEW, "utf8");
    expect(source).toContain("resolveMetaCurrencyOffset(ceilingCurrency)");
    expect(source).toContain("ceilingOffset.subdivisionDigits");
    /* `resolveMinorUnitExponent` must not come back for the ceiling. The file
       may still use `formatMinorUnitsForDisplay`, which takes a digit COUNT
       rather than a currency and is correct once the count is the provider's. */
    expect(source).not.toContain("resolveMinorUnitExponent");
  });
});

describe("the ceiling cannot be persisted at a scale nobody can name", () => {
  const VALID_BODY = {
    dryRunOnly: true,
    budgetMinHoursBetweenChanges: 12,
    budgetMaxChangesPer7d: 2,
    budgetMaxAccountConcentrationPct: 40,
    maxBudgetIncreasePct: 20,
    perActionSpendCeilingMinor: 5000,
    perActionSpendCeilingCurrency: "USD",
  };

  it("accepts a ceiling in a currency the provider publishes", () => {
    for (const code of ["USD", "TRY", "GBP", "EUR", "JPY", "HUF"]) {
      const parsed = parseBudgetAutomationConfig({
        ...VALID_BODY,
        perActionSpendCeilingCurrency: code,
      });
      expect(parsed.ok, code).toBe(true);
    }
  });

  it("refuses one it does not, by name, on the SERVER", () => {
    /*
      The editor refuses to mint it, but a raw POST never touches the editor.
      This is the gate between such a request and a persisted guardrail nobody
      can interpret.
    */
    for (const code of ["KWD", "OMR", "TND", "IQD", "LYD"]) {
      const parsed = parseBudgetAutomationConfig({
        ...VALID_BODY,
        perActionSpendCeilingCurrency: code,
      });
      expect(parsed.ok, code).toBe(false);
      if (!parsed.ok) {
        expect(parsed.rejection, code).toBe(
          "per_action_spend_ceiling_currency_unsupported_by_provider",
        );
      }
    }
  });

  it("still accepts clearing the ceiling, which is a real choice", () => {
    const parsed = parseBudgetAutomationConfig({
      ...VALID_BODY,
      perActionSpendCeilingMinor: null,
      perActionSpendCeilingCurrency: null,
    });
    expect(parsed.ok).toBe(true);
  });
});
