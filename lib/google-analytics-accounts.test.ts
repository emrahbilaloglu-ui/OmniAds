import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The GA4 property record is the only place the unit of every GA4 money metric
 * is stated. `purchaseRevenue`, `itemRevenue` and `totalRevenue` are all
 * reported in `Property.currencyCode`, and this Admin read is what puts that
 * code into our hands — it used to parse `timeZone` and discard the rest, which
 * is why every revenue figure on the analytics surfaces printed a hardcoded
 * dollar sign.
 */
import {
  fetchGA4PropertyMetadata,
  normalizeCurrencyCode,
} from "@/lib/google-analytics-accounts";

const originalFetch = globalThis.fetch;

function respondWith(payload: unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("normalizeCurrencyCode", () => {
  it("accepts an ISO 4217 alphabetic code in any case", () => {
    expect(normalizeCurrencyCode("USD")).toBe("USD");
    expect(normalizeCurrencyCode(" try ")).toBe("TRY");
    expect(normalizeCurrencyCode("eur")).toBe("EUR");
  });

  it("refuses anything that is not a three-letter code", () => {
    // `Intl.NumberFormat` throws a RangeError on a malformed code, which would
    // take a whole revenue table down instead of rendering the missing value.
    expect(normalizeCurrencyCode("")).toBeNull();
    expect(normalizeCurrencyCode("US")).toBeNull();
    expect(normalizeCurrencyCode("USDD")).toBeNull();
    expect(normalizeCurrencyCode("84")).toBeNull();
    expect(normalizeCurrencyCode(840)).toBeNull();
    expect(normalizeCurrencyCode(null)).toBeNull();
    expect(normalizeCurrencyCode(undefined)).toBeNull();
  });
});

describe("fetchGA4PropertyMetadata", () => {
  it("reads the property's currency from the same Admin record as its time zone", async () => {
    const calls = respondWith({
      name: "properties/12345",
      displayName: "Grandmix",
      timeZone: "Europe/Istanbul",
      currencyCode: "TRY",
    });

    const metadata = await fetchGA4PropertyMetadata("token", "12345");

    expect(metadata).toEqual({
      propertyId: "properties/12345",
      timeZone: "Europe/Istanbul",
      currencyCode: "TRY",
    });
    // One Admin call, the one that already existed — the currency rides along
    // with the time zone rather than costing a second request.
    expect(calls).toEqual([
      "https://analyticsadmin.googleapis.com/v1beta/properties/12345",
    ]);
  });

  it("reports no currency rather than a default when the record omits it", async () => {
    respondWith({ name: "properties/12345", timeZone: "UTC" });

    const metadata = await fetchGA4PropertyMetadata("token", "properties/12345");

    expect(metadata.currencyCode).toBeNull();
    expect(metadata.timeZone).toBe("UTC");
  });

  it("reports no currency when the record's value is not a usable code", async () => {
    respondWith({ name: "properties/12345", currencyCode: "dollars" });

    const metadata = await fetchGA4PropertyMetadata("token", "properties/12345");

    expect(metadata.currencyCode).toBeNull();
  });

  it("propagates an Admin failure instead of returning a guessed record", async () => {
    globalThis.fetch = (async () =>
      new Response("permission denied", { status: 403 })) as unknown as typeof fetch;

    await expect(
      fetchGA4PropertyMetadata("token", "properties/12345"),
    ).rejects.toThrow(/permission denied/);
  });
});
