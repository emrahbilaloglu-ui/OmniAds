import { describe, expect, it } from "vitest";
import {
  formatMoney,
  normalizeCurrencyCode,
  resolveCreativeCurrency,
} from "./money";

describe("creative money formatting", () => {
  it("normalizes valid codes and rejects unavailable units", () => {
    expect(normalizeCurrencyCode(" try ")).toBe("TRY");
    expect(normalizeCurrencyCode("US dollars")).toBeNull();
    expect(normalizeCurrencyCode(null)).toBeNull();
  });

  it("preserves row currency before the account default", () => {
    expect(resolveCreativeCurrency("EUR", "USD")).toBe("EUR");
    expect(resolveCreativeCurrency(null, "TRY")).toBe("TRY");
  });

  it("formats missing currency unitlessly with an explicit unavailable state", () => {
    const formatted = formatMoney(12.5, null, null);
    expect(formatted).toContain("12.5");
    expect(formatted).toContain("Currency unavailable");
    expect(formatted).not.toContain("$");
  });

  it("formats genuine currency without an unavailable marker", () => {
    const formatted = formatMoney(12.5, "EUR", "USD");
    expect(formatted).toBe(
      (12.5).toLocaleString("de-DE", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 2,
      })
    );
    expect(formatted).not.toContain("Currency unavailable");
  });
});
