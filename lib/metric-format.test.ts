import { describe, expect, it } from "vitest";
import {
  MISSING_VALUE,
  formatCurrencySmart,
  formatMetricValue,
  formatMoneyIso,
  formatPercentFromRatioSmart,
  formatPercentSmart,
} from "@/lib/metric-format";

describe("formatMoneyIso", () => {
  it("renders provider currencies without a USD fallback (MR-D064-01)", () => {
    expect(formatMoneyIso(1234.5, { currency: "GBP", locale: "en-GB" })).toContain("£");
    expect(formatMoneyIso(1234.5, { currency: "TRY", locale: "tr-TR" })).toContain("₺");
    expect(formatMoneyIso(1234.5, { currency: "EUR", locale: "de-DE" })).toContain("€");
  });

  it("refuses to invent a currency when the code is missing or invalid", () => {
    expect(formatMoneyIso(100, { currency: null })).toBe(MISSING_VALUE);
    expect(formatMoneyIso(100, { currency: "" })).toBe(MISSING_VALUE);
    expect(formatMoneyIso(100, { currency: "dollars" })).toBe(MISSING_VALUE);
    expect(formatMoneyIso(100, { currency: undefined })).toBe(MISSING_VALUE);
  });

  it("never renders a missing amount as zero", () => {
    expect(formatMoneyIso(null, { currency: "USD" })).toBe(MISSING_VALUE);
    expect(formatMoneyIso(undefined, { currency: "USD" })).toBe(MISSING_VALUE);
    expect(formatMoneyIso(Number.NaN, { currency: "USD" })).toBe(MISSING_VALUE);
    expect(formatMoneyIso(Number.POSITIVE_INFINITY, { currency: "USD" })).toBe(MISSING_VALUE);
  });

  it("formats a real zero as zero", () => {
    expect(formatMoneyIso(0, { currency: "USD", locale: "en-US" })).toBe("$0.00");
  });
});

describe("fabricated-zero regressions", () => {
  it("formatCurrencySmart renders missing money as a missing value, not currency zero", () => {
    expect(formatCurrencySmart(Number.NaN, "$")).toBe(MISSING_VALUE);
    expect(formatCurrencySmart(Number.POSITIVE_INFINITY, "₺")).toBe(MISSING_VALUE);
  });

  it("percent formatters render missing values as a missing value, not 0%", () => {
    expect(formatPercentSmart(Number.NaN)).toBe(MISSING_VALUE);
    expect(formatPercentFromRatioSmart(Number.NaN)).toBe(MISSING_VALUE);
  });

  it("still formats real values normally", () => {
    expect(formatCurrencySmart(1500, "$")).toBe("$1.5K");
    expect(formatPercentSmart(12.5)).toBe("12.5%");
  });
});

describe("formatMetricValue", () => {
  it("renders missing and non-finite values as a missing value", () => {
    expect(formatMetricValue(null, "currency", "$")).toBe(MISSING_VALUE);
    expect(formatMetricValue(Number.NaN, "ratio", "$")).toBe(MISSING_VALUE);
    expect(formatMetricValue(Number.POSITIVE_INFINITY, "ratio", "$")).toBe(MISSING_VALUE);
  });

  it("renders a real zero rather than hiding it", () => {
    expect(formatMetricValue(0, "count", "$")).toBe("0");
    expect(formatMetricValue(0, "ratio", "$")).toBe("0.00");
  });
});
