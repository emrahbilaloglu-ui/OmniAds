import { describe, expect, it } from "vitest";

import {
  OBSERVED_SHOPIFY_AOV_MIN_ORDERS,
  observedShopifyAovIsUsable,
  resolveObservedShopifyAov,
  type ObservedShopifyAovEvidence,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";

const NOW = new Date("2026-09-05T09:00:00.000Z");

function deps(overrides: Partial<Parameters<typeof resolveObservedShopifyAov>[0]["deps"]> = {}) {
  return {
    schemaReady: async () => true,
    resolveCredentials: async () =>
      ({
        businessId: "biz",
        shopId: "grandmix.myshopify.com",
        accessToken: "token",
        scopes: [],
        metadata: { iana_timezone: "America/Los_Angeles" },
      }) as never,
    readAggregate: async () =>
      ({ purchases: 41, revenue: 2378, averageOrderValue: 58 }) as never,
    readCurrencies: async () => ["USD"],
    readObservedAt: async () => "2026-09-04T18:00:00.000Z",
    ...overrides,
  };
}

async function resolve(
  overrides: Partial<Parameters<typeof resolveObservedShopifyAov>[0]> = {},
) {
  return resolveObservedShopifyAov({
    businessId: "biz",
    accountCurrency: "USD",
    currencyExponent: 2,
    now: NOW,
    deps: deps(),
    ...overrides,
  });
}

describe("observed Shopify AOV", () => {
  it("reads the store's own AOV over 28 closed store days", async () => {
    const evidence = await resolve();
    expect(evidence.status).toBe("observed");
    expect(evidence.aovMinor).toBe(5800);
    expect(evidence.currency).toBe("USD");
    expect(evidence.orderCount).toBe(41);
    expect(evidence.providerAccountId).toBe("grandmix.myshopify.com");
    expect(evidence.zoneName).toBe("America/Los_Angeles");
    // Yesterday in the STORE's zone, and 28 days inclusive.
    expect(evidence.window).toEqual({ from: "2026-08-08", to: "2026-09-04" });
    expect(observedShopifyAovIsUsable(evidence)).toBe(true);
  });

  it("supplies the spend unit as AOV divided by Target ROAS", () => {
    // The whole point of the source: ROAS is the only configured target, and
    // both optional fields stay null.
    const resolution = resolveSpendUnit({
      targetCpa: null,
      operatorAovAssumption: null,
      observedShopifyAov: 58,
      observedShopifyAovOrderCount: 41,
      observedShopifyAovStatus: "observed",
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      targetRoas: 2.2,
      breakEvenRoas: 1.8,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    });
    expect(resolution.source).toBe("observed_shopify_aov");
    // $58.00 / 2.2 = $26.36 (2636 minor), the A3.6 worked case.
    expect(Math.round(resolution.spendUnit! * 100)).toBe(2636);
    expect(resolution.evidence.warnings).not.toContain("operator_aov_missing");
  });

  it("prefers a configured Target CPA over the observed store number", () => {
    const resolution = resolveSpendUnit({
      targetCpa: 30,
      operatorAovAssumption: null,
      observedShopifyAov: 58,
      observedShopifyAovStatus: "observed",
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      targetRoas: 2.2,
      breakEvenRoas: null,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    });
    // A configured number is a decision; this source is a measurement.
    expect(resolution.source).toBe("target_cpa");
  });

  it("precedes the Meta-attributed estimate of the same quantity", () => {
    const resolution = resolveSpendUnit({
      targetCpa: null,
      operatorAovAssumption: null,
      observedShopifyAov: 58,
      observedShopifyAovStatus: "observed",
      metaAttributedAovMean90d: 71,
      metaAttributedAovPurchaseCount90d: 400,
      metaAttributedRevenue90d: 28400,
      targetRoas: 2.2,
      breakEvenRoas: null,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    });
    expect(resolution.source).toBe("observed_shopify_aov");
  });

  it("withholds without the store's own time zone, rather than picking one", async () => {
    const evidence = await resolve({
      deps: deps({
        resolveCredentials: async () =>
          ({ shopId: "shop", metadata: {} }) as never,
      }),
    });
    expect(evidence.status).toBe("timezone_absent");
    expect(evidence.window).toBeNull();
    expect(observedShopifyAovIsUsable(evidence)).toBe(false);
  });

  it("separates an unavailable store from one that truly sold nothing", async () => {
    // The ledger reader answers with zeros when its tables are missing, so
    // availability is established first and the two are never the same answer.
    const unavailable = await resolve({
      deps: deps({ schemaReady: async () => false }),
    });
    expect(unavailable.status).toBe("unavailable");

    const zero = await resolve({
      deps: deps({
        readAggregate: async () =>
          ({ purchases: 0, revenue: 0, averageOrderValue: null }) as never,
      }),
    });
    expect(zero.status).toBe("observed_zero_orders");
  });

  it("reports a thin sample as thin, and does not offer it as a unit", async () => {
    const evidence = await resolve({
      deps: deps({
        readAggregate: async () =>
          ({ purchases: 12, revenue: 700, averageOrderValue: 58 }) as never,
      }),
    });
    expect(evidence.status).toBe("sample_thin");
    expect(evidence.orderCount).toBeLessThan(OBSERVED_SHOPIFY_AOV_MIN_ORDERS);
    expect(observedShopifyAovIsUsable(evidence)).toBe(false);
  });

  it("never converts a currency, and never borrows the business setting", async () => {
    const mismatch = await resolve({ accountCurrency: "TRY" });
    expect(mismatch.status).toBe("currency_mismatch");
    expect(mismatch.currency).toBe("USD");

    const mixed = await resolve({
      deps: deps({ readCurrencies: async () => ["USD", "CAD"] }),
    });
    expect(mixed.status).toBe("currency_mixed");

    const absent = await resolve({
      deps: deps({ readCurrencies: async () => [] }),
    });
    expect(absent.status).toBe("currency_absent");
  });

  it("treats a store that stopped syncing as stale, not as current", async () => {
    const evidence = await resolve({
      deps: deps({ readObservedAt: async () => "2026-09-01T00:00:00.000Z" }),
    });
    expect(evidence.status).toBe("stale");
  });

  it("carries the exponent its minor units were minted with", async () => {
    const evidence: ObservedShopifyAovEvidence = await resolve();
    expect(evidence.currencyExponent).toBe(2);
    expect(evidence.revenueMinor).toBe(237800);
  });
});

describe("a business with no Shopify evidence", () => {
  it("keeps ROAS-based evaluation and asks for no CPA or AOV", async () => {
    const evidence = await resolve({ deps: deps({ schemaReady: async () => false }) });
    expect(evidence.status).toBe("unavailable");

    // The ROAS anchors are untouched; only the AOV-derived unit waits.
    const resolution = resolveSpendUnit({
      targetCpa: null,
      operatorAovAssumption: null,
      observedShopifyAov: null,
      observedShopifyAovStatus: evidence.status,
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      targetRoas: 2,
      breakEvenRoas: 1.6,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    });
    expect(resolution.spendUnit).toBeNull();
    expect(resolution.evidence.targetRoas).toBe(2);
    expect(resolution.evidence.breakEvenRoas).toBe(1.6);
    // Named as a store-side absence, not as a missing operator input.
    expect(resolution.evidence.warnings).toContain(
      "observed_shopify_aov_unavailable",
    );
  });
});
