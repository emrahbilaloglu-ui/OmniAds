import { describe, expect, it } from "vitest";
import { normalizeReportCurrency } from "@/lib/custom-report-renderer";

describe("normalizeReportCurrency", () => {
  it("accepts ISO 4217 codes regardless of stored casing or padding", () => {
    expect(normalizeReportCurrency("try")).toBe("TRY");
    expect(normalizeReportCurrency(" gbp ")).toBe("GBP");
    expect(normalizeReportCurrency("EUR")).toBe("EUR");
  });

  it("refuses anything that is not an ISO code rather than guessing", () => {
    expect(normalizeReportCurrency(null)).toBeNull();
    expect(normalizeReportCurrency(undefined)).toBeNull();
    expect(normalizeReportCurrency("")).toBeNull();
    expect(normalizeReportCurrency("$")).toBeNull();
    expect(normalizeReportCurrency("dollars")).toBeNull();
    expect(normalizeReportCurrency("US")).toBeNull();
  });

  it("never substitutes USD for an unknown currency", () => {
    expect(normalizeReportCurrency("???")).not.toBe("USD");
    expect(normalizeReportCurrency(null)).not.toBe("USD");
  });
});

/**
 * Guards the defect this slice fixes: report money was formatted with a
 * hard-coded en-US/USD Intl formatter, so a TRY or GBP account received a
 * client report denominated in dollars.
 */
describe("report money formatting has no hard-coded currency", () => {
  it("keeps the renderer free of a literal USD formatter", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/custom-report-renderer.ts", "utf8");
    expect(source).not.toMatch(/currency:\s*["']USD["']/);
    expect(source).not.toMatch(/Intl\.NumberFormat\(\s*["']en-US["']\s*,\s*\{\s*style:\s*["']currency["']/);
  });
});
