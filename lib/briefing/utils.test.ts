import { describe, expect, it } from "vitest";
import { formatCurrency, formatPercent, formatRoas, initials, sparklinePath, tileFor } from "@/lib/briefing/utils";

describe("briefing utils", () => {
  it("formats numeric strings without throwing", () => {
    expect(formatCurrency("1234.4", "GBP")).toBe(
      (1234).toLocaleString("en-GB", {
        style: "currency",
        currency: "GBP",
        maximumFractionDigits: 2,
      }),
    );
    expect(formatRoas("1.835")).toBe("1.83×");
    expect(formatPercent("12.345", 1, { signed: true })).toBe("+12.3%");
  });

  it("falls back safely for malformed numeric values", () => {
    expect(formatCurrency("not-a-number", "USD")).toBe("—");
    expect(formatRoas({})).toBe("0.00×");
    expect(formatPercent(null, 0, { signed: true })).toBe("+0%");
  });

  it("does not infer USD when the account currency is unavailable", () => {
    const unknown = formatCurrency(1234, null);
    expect(unknown).toContain("1,234");
    expect(unknown).toContain("Currency unavailable");
    expect(unknown).not.toContain("$");
    expect(formatCurrency(1234, "TRY")).toContain("₺");
    expect(formatCurrency(1234, "EUR")).toContain("€");
  });

  it("normalizes sparkline values before building paths", () => {
    expect(sparklinePath(["1", 2, "bad", 4])).toBe("M0.0,16.0 L30.0,10.7 L60.0,0.0");
    expect(sparklinePath(["bad"])).toBe("");
  });

  it("handles missing tile names safely", () => {
    expect(initials(null)).toBe("C");
    expect(tileFor(undefined)).toHaveLength(2);
  });
});
