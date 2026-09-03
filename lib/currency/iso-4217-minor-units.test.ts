import { describe, expect, it } from "vitest";

import {
  ISO_4217_REGISTRY_VERSION,
  MAX_MINOR_UNITS,
  applyPercentToMinorUnits,
  formatMinorUnitsForDisplay,
  knownCurrencies,
  resolveMinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";

describe("D081-C — the currency exponent is authority, never an assumption", () => {
  it("resolves zero-, two- and three-decimal currencies from the registry", () => {
    expect(resolveMinorUnitExponent("JPY")).toMatchObject({ status: "resolved", exponent: 0 });
    expect(resolveMinorUnitExponent("KRW")).toMatchObject({ status: "resolved", exponent: 0 });
    expect(resolveMinorUnitExponent("USD")).toMatchObject({ status: "resolved", exponent: 2 });
    expect(resolveMinorUnitExponent("TRY")).toMatchObject({ status: "resolved", exponent: 2 });
    expect(resolveMinorUnitExponent("KWD")).toMatchObject({ status: "resolved", exponent: 3 });
    expect(resolveMinorUnitExponent("BHD")).toMatchObject({ status: "resolved", exponent: 3 });
  });

  it("covers every currency the accepted D080B snapshot actually observed", () => {
    // USD on six accounts and TRY on one. Both must resolve, and neither may
    // rely on a default branch.
    for (const observed of ["USD", "TRY"]) {
      expect(resolveMinorUnitExponent(observed), observed).toMatchObject({ status: "resolved" });
    }
  });

  it("fails closed on unknown, malformed and retired codes", () => {
    expect(resolveMinorUnitExponent("XYZ").status).toBe("unknown_currency");
    expect(resolveMinorUnitExponent("US").status).toBe("unknown_currency");
    expect(resolveMinorUnitExponent("usdd").status).toBe("unknown_currency");
    expect(resolveMinorUnitExponent("").status).toBe("unknown_currency");
    expect(resolveMinorUnitExponent(null).status).toBe("unknown_currency");
    expect(resolveMinorUnitExponent(42).status).toBe("unknown_currency");
    // A redenominated code must fail loudly, not resolve to its old exponent.
    expect(resolveMinorUnitExponent("TRL").status).toBe("retired_currency");
    expect(resolveMinorUnitExponent("ROL").status).toBe("retired_currency");
  });

  it("never guesses two decimals for an unlisted code", () => {
    const r = resolveMinorUnitExponent("ZZZ");
    expect(r.status).toBe("unknown_currency");
    expect(JSON.stringify(r)).not.toContain('"exponent"');
    expect(String((r as { reason: string }).reason)).toContain("refusing rather than assuming");
  });

  it("accepts case and whitespace without accepting nonsense", () => {
    expect(resolveMinorUnitExponent("  jpy ")).toMatchObject({ status: "resolved", exponent: 0 });
    expect(resolveMinorUnitExponent("j p y").status).toBe("unknown_currency");
  });

  it("binds a registry version into every resolution", () => {
    const r = resolveMinorUnitExponent("USD");
    expect(r).toMatchObject({ registryVersion: ISO_4217_REGISTRY_VERSION });
    expect(knownCurrencies()).not.toContain("TRL");
    expect(knownCurrencies().length).toBeGreaterThan(50);
  });

  it("is not specialised to the six charter businesses", () => {
    // A registry that only knew USD and TRY would pass D080B and fail the next
    // account onboarded.
    for (const code of ["EUR", "GBP", "BRL", "INR", "IDR", "JPY", "KWD", "VND"]) {
      expect(resolveMinorUnitExponent(code).status, code).toBe("resolved");
    }
  });
});

describe("D081-C — integer-safe money arithmetic", () => {
  it("applies a percentage in integers with one explicit rounding step", () => {
    expect(applyPercentToMinorUnits(100_000, 10, "increase")).toMatchObject({ status: "ok", minorUnits: 110_000, roundingApplied: false });
    expect(applyPercentToMinorUnits(100_000, 25, "decrease")).toMatchObject({ status: "ok", minorUnits: 75_000 });
  });

  it("rounds half up away from zero, symmetrically in both directions", () => {
    // 105 * 1.05 = 110.25 -> 110 ; 105 * 0.95 = 99.75 -> 100
    expect(applyPercentToMinorUnits(105, 5, "increase")).toMatchObject({ minorUnits: 110, roundingApplied: true });
    expect(applyPercentToMinorUnits(105, 5, "decrease")).toMatchObject({ minorUnits: 100, roundingApplied: true });
    // An exact half rounds away from zero rather than to even.
    expect(applyPercentToMinorUnits(10, 5, "increase")).toMatchObject({ minorUnits: 11 });
  });

  it("never uses floating-point equality for money", () => {
    const source = require("node:fs").readFileSync("lib/currency/iso-4217-minor-units.ts", "utf8");
    expect(source).not.toMatch(/===\s*0\.\d/);
    expect(source).not.toMatch(/toFixed\(/);
  });

  it("refuses non-integer, zero, negative and overflowing amounts", () => {
    expect(applyPercentToMinorUnits(100.5, 10, "increase").status).toBe("invalid");
    expect(applyPercentToMinorUnits(0, 10, "increase").status).toBe("invalid");
    expect(applyPercentToMinorUnits(-100, 10, "increase").status).toBe("invalid");
    expect(applyPercentToMinorUnits(MAX_MINOR_UNITS, 25, "increase").status).toBe("invalid");
    expect(applyPercentToMinorUnits(Number.MAX_SAFE_INTEGER, 5, "increase").status).toBe("invalid");
  });

  it("refuses a decrease that would leave no budget at all", () => {
    // 1 minor unit minus 25% is 0.75, which rounds away from zero to 1.
    expect(applyPercentToMinorUnits(1, 25, "decrease")).toMatchObject({ status: "ok", minorUnits: 1 });
    // A 100% cut is a zeroing, not a budget change, and is refused as such.
    const zeroed = applyPercentToMinorUnits(1000, 100, "decrease");
    expect(zeroed.status).toBe("invalid");
    expect(String((zeroed as { reason: string }).reason)).toContain("rounds to zero");
  });

  it("refuses a non-integer or out-of-range percentage", () => {
    expect(applyPercentToMinorUnits(1000, 10.5, "increase").status).toBe("invalid");
    expect(applyPercentToMinorUnits(1000, 0, "increase").status).toBe("invalid");
    expect(applyPercentToMinorUnits(1000, -10, "increase").status).toBe("invalid");
    expect(applyPercentToMinorUnits(1000, 100_000, "increase").status).toBe("invalid");
  });

  it("formats by exponent without touching the arithmetic", () => {
    expect(formatMinorUnitsForDisplay(300_000, 2)).toBe("3000.00");
    expect(formatMinorUnitsForDisplay(300_000, 0)).toBe("300000");
    expect(formatMinorUnitsForDisplay(300_000, 3)).toBe("300.000");
    expect(formatMinorUnitsForDisplay(5, 2)).toBe("0.05");
    expect(formatMinorUnitsForDisplay(5, 3)).toBe("0.005");
  });
});
