import { describe, expect, it, vi } from "vitest";

const currencySql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb: () => currencySql }));

/*
  The readiness list is the availability gate, so the tables it names are part
  of the contract rather than an implementation detail: a store missing only
  `shopify_order_transactions` used to pass this gate, get zeros back from the
  ledger reader, and be reported as having sold nothing.
*/
const readiness = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: async (input: { tables: string[] }) => {
    readiness.calls.push(input.tables);
    return { ready: false, missingTables: input.tables };
  },
  assertDbSchemaReady: async () => {},
}));

import {
  OBSERVED_SHOPIFY_AOV_MIN_ORDERS,
  OBSERVED_SHOPIFY_AOV_ORDER_SYNC_TARGETS,
  observedShopifyAovIsUsable,
  proveShopifyOrderWindowCovered,
  resolveObservedShopifyAov,
  type ObservedShopifyAovEvidence,
  type ShopifyOrderSyncCoverage,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";

const NOW = new Date("2026-09-05T09:00:00.000Z");

/*
  A store whose ORDER sync covers the whole 28-day window.

  The historical backfill runs from a year ago to the day before the recent
  pass picks up, and the recent pass covers the last seven days through the
  store's today. Between them there is no day of `2026-08-08 .. 2026-09-04`
  that nobody read.

  Each row is shaped as the sync's own SUCCESS write leaves it: the attempt
  columns and the retained `latestSuccessfulSyncWindow*` pair agree, because
  one upsert wrote both. The retained pair is what the coverage proof reads, so
  a fixture that omits it is describing a store that has never had a successful
  pass — which is refused, by design.
*/
function fullCoverage(
  overrides: Partial<ShopifyOrderSyncCoverage> = {},
): ShopifyOrderSyncCoverage {
  return {
    recent: {
      latestSuccessfulSyncAt: "2026-09-05T08:30:00.000Z",
      latestSyncWindowStart: "2026-08-30",
      readyThroughDate: "2026-09-05",
      latestSyncWindowEnd: "2026-09-05",
      latestSuccessfulSyncWindowStart: "2026-08-30",
      latestSuccessfulSyncWindowEnd: "2026-09-05",
      latestSyncStatus: "succeeded",
      historicalTargetStart: "2026-08-30",
    },
    historical: {
      latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
      latestSyncWindowStart: "2026-08-06",
      readyThroughDate: "2026-09-04",
      latestSyncWindowEnd: "2026-09-04",
      latestSuccessfulSyncWindowStart: "2026-08-06",
      latestSuccessfulSyncWindowEnd: "2026-09-04",
      latestSyncStatus: "succeeded",
      historicalTargetStart: "2025-09-05",
    },
    ...overrides,
  };
}

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
    // The newest SALE in the window. A fact about the merchant's customers.
    readObservedAt: async () => "2026-09-04T18:00:00.000Z",
    // What OUR ORDER sync has read, and how far back. The freshness evidence,
    // and a different question from the one above.
    readOrderSyncCoverage: async () => fullCoverage(),
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

  it("supplies no spend unit, and holds by name when Meta attributed nothing", () => {
    /*
      RE-PINNED to the canonical rule. This case used to assert the opposite —
      `source: "observed_shopify_aov"` and $58.00 / 2.2 = 2636 minor, the A3.6
      worked case — because the store's AOV was a rung of `resolveSpendUnit`.
      It is not one any more: for a META decision the money-per-purchase unit is
      META's own attributed purchase AOV, and the merchant's settled orders are
      a different book.

      The refusal is EXPLICIT, not silence. `insufficient` with a null unit is
      the resolver's own hold, and the warnings say which absence caused it —
      including `operator_aov_missing`, which this case used to assert was NOT
      emitted. It is emitted correctly now: with no Meta AOV, nothing at all can
      supply the quantity a Target ROAS divides.
    */
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
    expect(resolution.source).toBe("insufficient");
    expect(resolution.spendUnit).toBeNull();
    expect(resolution.confidence).toBe("insufficient");
    expect(resolution.hardEligibleByDefault).toBe(false);
    // A NAMED hold: the two absences the operator can act on, not silence.
    expect(resolution.evidence.warnings).toContain("meta_aov_unavailable");
    expect(resolution.evidence.warnings).toContain("operator_aov_missing");
    // The store's number is still CARRIED, as context beside the refusal.
    expect(resolution.evidence.observedShopifyAov).toBe(58);
    expect(resolution.evidence.observedShopifyAovOrderCount).toBe(41);
    expect(resolution.evidence.observedShopifyAovStatus).toBe("observed");
  });

  it("still mints a unit from the Meta platform AOV and a Target ROAS", () => {
    /*
      THE GUARD AGAINST OVER-CORRECTING the case above into a resolver that
      never answers. The canonical basis is present here — 71.00 of attributed
      revenue per attributed purchase over a `ready` sample — and it must still
      produce a unit, with no store evidence anywhere in the input.
    */
    const resolution = resolveSpendUnit({
      targetCpa: null,
      operatorAovAssumption: null,
      metaAttributedAovMean90d: 71,
      metaAttributedAovPurchaseCount90d: 400,
      metaAttributedRevenue90d: 28_400,
      targetRoas: 2.2,
      breakEvenRoas: 1.8,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    });
    expect(resolution.source).toBe("meta_derived_aov");
    expect(Math.round(resolution.spendUnit! * 100)).toBe(3227);
    expect(resolution.hardEligibleByDefault).toBe(true);
    expect(resolution.evidence.warnings).not.toContain("meta_aov_unavailable");
    expect(resolution.evidence.warnings).not.toContain("operator_aov_missing");
  });

  it("prefers a configured Target CPA over the observed store number", () => {
    // RE-PINNED: this case used to also carry `targetRoas: 2.2`, and it was the
    // Target ROAS, not the CPA, that has since become decisive. With no ratio
    // the CPA is still the only anchor there is, and the store's measurement
    // still does not become one.
    const resolution = resolveSpendUnit({
      targetCpa: 30,
      operatorAovAssumption: null,
      observedShopifyAov: 58,
      observedShopifyAovStatus: "observed",
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      targetRoas: null,
      breakEvenRoas: null,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    });
    // A configured number is a decision; this source is a measurement.
    expect(resolution.source).toBe("target_cpa");
  });

  it("holds on a missing Meta AOV rather than taking the CPA or the store's", () => {
    // The same account WITH a Target ROAS: the canonical basis is the platform
    // AOV over that ratio, and neither the operator's CPA (30) nor the store's
    // 58 / 2.2 = 26.36 stands in for it when Meta has attributed nothing.
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

    expect(resolution.source).toBe("insufficient");
    expect(resolution.spendUnit).toBeNull();
    expect(resolution.hardEligibleByDefault).toBe(false);
    expect(resolution.evidence.warnings).toContain("meta_aov_unavailable");
    expect(resolution.evidence.observedShopifyAov).toBe(58);
  });

  it("yields to the Meta-attributed estimate of the same quantity", () => {
    /*
      RE-PINNED, and the direction is the whole point. This used to assert that
      the store's 58.00 PRECEDED Meta's own 71.00 — the merchant's book winning
      over the platform's own attribution of the very spend being decided. Under
      the canonical rule the platform's number is the basis, and the store's is
      carried beside it as context.
    */
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
    expect(resolution.source).toBe("meta_derived_aov");
    // 71.00 / 2.2, not the store's 58.00 / 2.2 = 2636.
    expect(Math.round(resolution.spendUnit! * 100)).toBe(3227);
    expect(resolution.evidence.observedShopifyAov).toBe(58);
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

  it.each([null, ""])("withholds an otherwise single-currency ledger with a missing currency (%s)", async (currency) => {
    currencySql.mockResolvedValueOnce([{ currency: "USD" }, { currency }]);
    const evidence = await resolve({ deps: deps({ readCurrencies: undefined }) });
    expect(evidence.status).toBe("currency_absent");
    expect(evidence.aovMinor).toBeNull();
    expect(evidence.currency).toBeNull();
    expect(observedShopifyAovIsUsable(evidence)).toBe(false);
  });

  it("keeps mixed-currency refusal when every contributing row has a currency", async () => {
    currencySql.mockResolvedValueOnce([{ currency: "USD" }, { currency: "EUR" }]);
    const evidence = await resolve({ deps: deps({ readCurrencies: undefined }) });
    expect(evidence.status).toBe("currency_mixed");
    expect(evidence.aovMinor).toBeNull();
  });

  it("treats a store that stopped SYNCING as stale", async () => {
    // The sync clock, not the newest sale. This one really has not been read
    // successfully in four days.
    const evidence = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () =>
          fullCoverage({
            recent: {
              latestSuccessfulSyncAt: "2026-09-01T00:00:00.000Z",
              latestSyncWindowStart: "2026-08-30",
              readyThroughDate: "2026-09-05",
              latestSyncWindowEnd: "2026-09-05",
              latestSuccessfulSyncWindowStart: "2026-08-30",
              latestSuccessfulSyncWindowEnd: "2026-09-05",
              latestSyncStatus: "succeeded",
              historicalTargetStart: "2026-08-30",
            },
          }),
      }),
    });
    expect(evidence.status).toBe("stale");
  });

  it("does not let a fresh RETURNS sync speak for stale orders", async () => {
    /*
      The defect. The clock was `MAX(latest_successful_sync_at)` across every
      `sync_target` for the store, and there are four — orders and returns,
      each recent and historical. A returns pass that finished minutes ago
      therefore certified orders last read five days earlier as current, even
      though the returns pass writes only `source_kind: 'return'` rows, which
      the revenue and purchase counts this average divides never touch.

      There is now no returns row to read: the coverage shape offers only the
      two order targets, so the returns pass has nowhere to put an answer.
    */
    expect([...OBSERVED_SHOPIFY_AOV_ORDER_SYNC_TARGETS]).toEqual([
      "commerce_orders_recent",
      "commerce_orders_historical",
    ]);
    expect(OBSERVED_SHOPIFY_AOV_ORDER_SYNC_TARGETS).not.toContain(
      "commerce_returns_recent",
    );
    expect(OBSERVED_SHOPIFY_AOV_ORDER_SYNC_TARGETS).not.toContain(
      "commerce_returns_historical",
    );

    const coverage = fullCoverage({
      recent: {
        latestSuccessfulSyncAt: "2026-08-31T09:00:00.000Z",
        latestSyncWindowStart: "2026-08-25",
        readyThroughDate: "2026-09-05",
        latestSyncWindowEnd: "2026-09-05",
        latestSuccessfulSyncWindowStart: "2026-08-25",
        latestSuccessfulSyncWindowEnd: "2026-09-05",
        latestSyncStatus: "succeeded",
        historicalTargetStart: "2026-08-25",
      },
    });
    // Every slot the coverage has, and not one of them a returns target.
    expect(Object.keys(coverage).sort()).toEqual(["historical", "recent"]);

    const evidence = await resolve({
      deps: deps({ readOrderSyncCoverage: async () => coverage }),
    });
    expect(evidence.status).toBe("stale");
    expect(evidence.aovMinor).toBeNull();
    expect(observedShopifyAovIsUsable(evidence)).toBe(false);
  });

  it("reads the clock from the recent ORDERS pass, not from a historical chunk", async () => {
    /*
      A historical chunk finishing minutes ago says a backfill advanced; it
      does not say the store was read today. Only the `updated_at`-driven
      recent pass carries a refund settled this morning against an old order
      back into the window.
    */
    const evidence = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () =>
          fullCoverage({
            recent: {
              latestSuccessfulSyncAt: "2026-09-01T09:00:00.000Z",
              latestSyncWindowStart: "2026-08-30",
              readyThroughDate: "2026-09-05",
              latestSyncWindowEnd: "2026-09-05",
              latestSuccessfulSyncWindowStart: "2026-08-30",
              latestSuccessfulSyncWindowEnd: "2026-09-05",
              latestSyncStatus: "succeeded",
              historicalTargetStart: "2026-08-30",
            },
            historical: {
              latestSuccessfulSyncAt: "2026-09-05T08:55:00.000Z",
              latestSyncWindowStart: "2026-08-06",
              readyThroughDate: "2026-09-04",
              latestSyncWindowEnd: "2026-09-04",
              latestSuccessfulSyncWindowStart: "2026-08-06",
              latestSuccessfulSyncWindowEnd: "2026-09-04",
              latestSyncStatus: "succeeded",
              historicalTargetStart: "2025-09-05",
            },
          }),
      }),
    });
    expect(evidence.status).toBe("stale");
  });

  it("refuses a window that begins before the earliest covered day", async () => {
    /*
      An incomplete backfill is not a stale sync and not an absent store. The
      store below synced half an hour ago; it has simply never read as far
      back as `2026-08-08`, so the twenty-eight day average would be an
      average over whatever fraction exists.
    */
    const partial = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () =>
          fullCoverage({
            historical: {
              latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
              latestSyncWindowStart: "2026-08-20",
              readyThroughDate: "2026-09-04",
              latestSyncWindowEnd: "2026-09-04",
              latestSuccessfulSyncWindowStart: "2026-08-20",
              latestSuccessfulSyncWindowEnd: "2026-09-04",
              latestSyncStatus: "succeeded",
              historicalTargetStart: "2026-08-20",
            },
          }),
      }),
    });
    expect(partial.status).toBe("orders_backfill_incomplete");
    expect(observedShopifyAovIsUsable(partial)).toBe(false);

    // The same refusal when the backfill has not started at all and only the
    // seven-day recent pass exists.
    const recentOnly = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () => fullCoverage({ historical: null }),
      }),
    });
    expect(recentOnly.status).toBe("orders_backfill_incomplete");
  });

  it("refuses when the covered spans do not join up across the window", async () => {
    const gapped = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () =>
          fullCoverage({
            historical: {
              latestSuccessfulSyncAt: "2026-02-16T04:00:00.000Z",
              latestSyncWindowStart: "2026-02-01",
              readyThroughDate: "2026-02-16",
              latestSyncWindowEnd: "2026-02-16",
              latestSuccessfulSyncWindowStart: "2026-02-01",
              latestSuccessfulSyncWindowEnd: "2026-02-16",
              latestSyncStatus: "succeeded",
              historicalTargetStart: "2025-09-05",
            },
          }),
      }),
    });
    expect(gapped.status).toBe("orders_coverage_gap");

    // And the tail: a backfill that reaches the window's start but stops
    // before its last day, with no recent pass to close it.
    const shortTail = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () => ({
          recent: {
            latestSuccessfulSyncAt: "2026-09-05T08:30:00.000Z",
            latestSyncWindowStart: null,
            readyThroughDate: null,
            latestSyncWindowEnd: null,
            latestSuccessfulSyncWindowStart: null,
            latestSuccessfulSyncWindowEnd: null,
            latestSyncStatus: null,
            historicalTargetStart: null,
          },
          historical: {
            latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
            latestSyncWindowStart: "2026-08-01",
            readyThroughDate: "2026-08-20",
            latestSyncWindowEnd: "2026-08-20",
            latestSuccessfulSyncWindowStart: "2026-08-01",
            latestSuccessfulSyncWindowEnd: "2026-08-20",
            latestSyncStatus: "succeeded",
            historicalTargetStart: "2025-09-05",
          },
        }),
      }),
    });
    expect(shortTail.status).toBe("orders_coverage_gap");
  });

  it("never reports an uncovered window as a store that sold nothing", async () => {
    /*
      The ordering pin. An uncovered window reports few or no orders too, and
      `observed_zero_orders` would claim the merchant sold nothing when what
      actually happened is that we never read those days.
    */
    const evidence = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () => fullCoverage({ historical: null }),
        readAggregate: async () =>
          ({ purchases: 0, revenue: 0, averageOrderValue: null }) as never,
      }),
    });
    expect(evidence.status).toBe("orders_backfill_incomplete");
    expect(evidence.status).not.toBe("observed_zero_orders");
  });

  it("proves coverage from recorded sync windows alone, at the boundaries", () => {
    const window = { from: "2026-08-08", to: "2026-09-04" };
    const span = (start: string, end: string) => ({
      latestSuccessfulSyncAt: "2026-09-05T08:30:00.000Z",
      latestSyncWindowStart: start,
      readyThroughDate: end,
      latestSyncWindowEnd: end,
      latestSuccessfulSyncWindowStart: start,
      latestSuccessfulSyncWindowEnd: end,
      latestSyncStatus: "succeeded",
      historicalTargetStart: start,
    });

    // One span exactly equal to the window.
    expect(
      proveShopifyOrderWindowCovered({
        window,
        coverage: { recent: span("2026-08-08", "2026-09-04"), historical: null },
      }),
    ).toEqual({ covered: true });

    // One day short at the front is an incomplete backfill, not a gap.
    expect(
      proveShopifyOrderWindowCovered({
        window,
        coverage: { recent: span("2026-08-09", "2026-09-04"), historical: null },
      }),
    ).toEqual({ covered: false, reason: "orders_backfill_incomplete" });

    // Adjacent spans one day apart are contiguous.
    expect(
      proveShopifyOrderWindowCovered({
        window,
        coverage: {
          historical: span("2026-08-08", "2026-08-20"),
          recent: span("2026-08-21", "2026-09-04"),
        },
      }),
    ).toEqual({ covered: true });

    // Two days apart is a day nobody read.
    expect(
      proveShopifyOrderWindowCovered({
        window,
        coverage: {
          historical: span("2026-08-08", "2026-08-20"),
          recent: span("2026-08-22", "2026-09-04"),
        },
      }),
    ).toEqual({ covered: false, reason: "orders_coverage_gap" });

    // A merged run ending one day short of the window's last day.
    expect(
      proveShopifyOrderWindowCovered({
        window,
        coverage: {
          historical: span("2026-08-08", "2026-08-20"),
          recent: span("2026-08-21", "2026-09-03"),
        },
      }),
    ).toEqual({ covered: false, reason: "orders_coverage_gap" });

    // Nothing recorded at all.
    expect(
      proveShopifyOrderWindowCovered({
        window,
        coverage: { recent: null, historical: null },
      }),
    ).toEqual({ covered: false, reason: "orders_backfill_incomplete" });
  });

  describe("an attempt in flight, beside the window a pass actually proved", () => {
    /*
      Two failures live in this one row shape, and the fix has to answer both.

      `latest_sync_window_start`/`_end` are written by running, cancelled and
      failed attempts alike (`lib/sync/shopify-sync.ts:388`, `:415`, `:532`,
      `:1056`); `ready_through_date`, `latest_successful_sync_at` and the
      retained `latest_successful_sync_window_*` pair are success-only and are
      COALESCE-preserved through them (`lib/shopify/sync-state.ts` ON CONFLICT).

      1. BORROWING. A webhook carrying a thirty-day-old order expands the recent
         window BACKWARD (`lib/shopify/webhooks.ts:183-191`), so a seven-day
         success is left sitting beside a thirty-day start. Combining them
         claimed twenty-eight days of coverage for days nobody had read.
      2. WITHDRAWING. Refusing to read that start at all — the previous fix —
         means an ORDINARY recurring pass, which writes `running` before doing
         any work, takes the store's proven window away for the duration of a
         routine refresh, and with it the derived CPA benchmark.

      Reading the retained SUCCESSFUL bounds answers both: the attempt's own
      window is never evidence, and it never erases the evidence a finished
      pass left.
    */
    const window = { from: "2026-08-08", to: "2026-09-04" };

    /** The seven-day pass that really did finish, at 06:00. */
    const SEVEN_DAY_PROVEN = {
      latestSuccessfulSyncAt: "2026-09-05T06:00:00.000Z",
      readyThroughDate: "2026-09-05",
      latestSuccessfulSyncWindowStart: "2026-08-30",
      latestSuccessfulSyncWindowEnd: "2026-09-05",
      historicalTargetStart: "2026-08-30",
    } as const;

    /** The same store after a thirty-day repair started, and did not finish. */
    function afterExpandedRepair(status: string): ShopifyOrderSyncCoverage {
      return {
        recent: {
          ...SEVEN_DAY_PROVEN,
          // The repair's window, which nothing has finished reading.
          latestSyncWindowStart: "2026-08-07",
          latestSyncWindowEnd: "2026-09-05",
          latestSyncStatus: status,
        },
        // No backfill has run for this store, so the recent row is the only
        // thing that could speak for the window.
        historical: null,
      };
    }

    /**
     * A store whose last SUCCESSFUL recent pass was itself a completed
     * thirty-day repair, so the recent row alone proves the whole window.
     */
    function afterProvenThirtyDayPass(
      attempt: { start: string; end: string; status: string } | null,
    ): ShopifyOrderSyncCoverage {
      return {
        recent: {
          latestSuccessfulSyncAt: "2026-09-05T06:30:00.000Z",
          readyThroughDate: "2026-09-05",
          latestSuccessfulSyncWindowStart: "2026-08-07",
          latestSuccessfulSyncWindowEnd: "2026-09-05",
          latestSyncWindowStart: attempt?.start ?? "2026-08-07",
          latestSyncWindowEnd: attempt?.end ?? "2026-09-05",
          latestSyncStatus: attempt?.status ?? "succeeded",
          historicalTargetStart: "2026-08-30",
        },
        historical: null,
      };
    }

    it("never borrows the expanded window of an attempt that did not finish", () => {
      for (const status of ["running", "failed", "missing_read_orders_scope", "cancelled"]) {
        const coverage = afterExpandedRepair(status);
        // The naive combination really would have covered the window: the
        // attempt's start is before its first day and the retained success end
        // is after its last. This is the shape the review reproduced
        // `{"covered":true}` on.
        expect(coverage.recent!.latestSyncWindowStart! <= window.from).toBe(true);
        expect(coverage.recent!.readyThroughDate! >= window.to).toBe(true);
        // What is actually proven is seven days, and seven days is what counts.
        expect(coverage.recent!.latestSuccessfulSyncWindowStart).toBe("2026-08-30");

        expect(proveShopifyOrderWindowCovered({ window, coverage })).toEqual({
          covered: false,
          reason: "orders_coverage_unproven",
        });
      }
    });

    it("keeps a proven window through an ORDINARY pass that is merely running", () => {
      /*
        The finding this file exists for. Nothing about the store changed: a
        completed pass proved 2026-08-07..2026-09-05 at 06:30, and the next
        scheduled tick wrote its own seven-day window with `running` before
        reading a single order. Withdrawing coverage for that is a refusal
        with no evidence behind it.
      */
      const before = afterProvenThirtyDayPass(null);
      expect(proveShopifyOrderWindowCovered({ window, coverage: before })).toEqual({
        covered: true,
      });

      const during = afterProvenThirtyDayPass({
        start: "2026-08-30",
        end: "2026-09-05",
        status: "running",
      });
      expect(proveShopifyOrderWindowCovered({ window, coverage: during })).toEqual({
        covered: true,
      });
    });

    it("keeps it through a FAILED attempt too, and infers nothing from the failure", () => {
      const failed = afterProvenThirtyDayPass({
        start: "2026-08-30",
        end: "2026-09-05",
        status: "shopify_admin_error",
      });
      expect(proveShopifyOrderWindowCovered({ window, coverage: failed })).toEqual({
        covered: true,
      });

      // And the failure adds nothing: a failed attempt reaching further back
      // than anything proven is still refused.
      expect(
        proveShopifyOrderWindowCovered({
          window,
          coverage: afterExpandedRepair("shopify_admin_error"),
        }),
      ).toEqual({ covered: false, reason: "orders_coverage_unproven" });
    });

    it("is accepted once that same thirty-day pass actually finishes", () => {
      // Nothing about the window changed; the pass completed and recorded the
      // days it read as its own retained bounds.
      expect(
        proveShopifyOrderWindowCovered({ window, coverage: afterProvenThirtyDayPass(null) }),
      ).toEqual({ covered: true });
    });

    it("treats a row with no retained bounds as unproven, never as coverage", () => {
      /*
        A row written before the retained columns existed. Its last recorded
        attempt is a clean success whose end is the retained
        `ready_through_date` — exactly the pairing the previous proof accepted —
        and it is still refused, because no pass has recorded which days it
        read. The next successful pass supplies them.
      */
      const legacy: ShopifyOrderSyncCoverage = {
        recent: {
          latestSuccessfulSyncAt: "2026-09-05T06:30:00.000Z",
          latestSyncWindowStart: "2026-08-07",
          latestSyncWindowEnd: "2026-09-05",
          readyThroughDate: "2026-09-05",
          latestSuccessfulSyncWindowStart: null,
          latestSuccessfulSyncWindowEnd: null,
          latestSyncStatus: "succeeded",
          historicalTargetStart: "2026-08-30",
        },
        historical: null,
      };
      expect(proveShopifyOrderWindowCovered({ window, coverage: legacy })).toEqual({
        covered: false,
        reason: "orders_coverage_unproven",
      });
    });

    it("names the absence as unproven, not as a backfill that never arrived", async () => {
      // Through the reader, end to end. `orders_backfill_incomplete` would say
      // the days were never read; what is actually true is that the days may
      // well have been read and no finished pass has said so.
      const withheldEvidence = await resolve({
        deps: deps({ readOrderSyncCoverage: async () => afterExpandedRepair("running") }),
      });
      expect(withheldEvidence.status).toBe("orders_coverage_unproven");
      expect(observedShopifyAovIsUsable(withheldEvidence)).toBe(false);
      expect(withheldEvidence.aovMinor).toBeNull();

      const finished = await resolve({
        deps: deps({ readOrderSyncCoverage: async () => afterProvenThirtyDayPass(null) }),
      });
      expect(finished.status).toBe("observed");
      expect(observedShopifyAovIsUsable(finished)).toBe(true);
    });

    it("supplies the unit end to end while an ordinary refresh is in flight", async () => {
      const evidence = await resolve({
        deps: deps({
          readOrderSyncCoverage: async () =>
            afterProvenThirtyDayPass({
              start: "2026-08-30",
              end: "2026-09-05",
              status: "running",
            }),
        }),
      });
      expect(evidence.status).toBe("observed");
      expect(observedShopifyAovIsUsable(evidence)).toBe(true);
      expect(evidence.aovMinor).toBe(5800);
    });

    it("lets the retained bounds go stale honestly, and never resurrects them", async () => {
      /*
        Retention is not immortality. A pass that keeps failing never refreshes
        `latest_successful_sync_at`, so the receipt beside the retained bounds
        ages past the 48-hour ceiling and the evidence is `stale` — the proven
        window is still readable, and it is no longer current enough to speak
        for today.
      */
      const stale = afterProvenThirtyDayPass({
        start: "2026-08-30",
        end: "2026-09-05",
        status: "shopify_admin_error",
      });
      stale.recent!.latestSuccessfulSyncAt = "2026-09-02T06:30:00.000Z";

      // The bounds themselves still prove the window — this is not a coverage
      // refusal wearing a freshness label.
      expect(proveShopifyOrderWindowCovered({ window, coverage: stale })).toEqual({
        covered: true,
      });

      const evidence = await resolve({
        deps: deps({ readOrderSyncCoverage: async () => stale }),
      });
      expect(evidence.status).toBe("stale");
      expect(observedShopifyAovIsUsable(evidence)).toBe(false);
    });

    it("withholds only the recent span, never a backfill that can still prove itself", async () => {
      /*
        The refusal is as narrow as the evidence requires. A store whose
        historical backfill has genuinely reached across the whole window is
        covered even while a recent repair is in flight, because the
        historical span's start is the backfill target the chunk walk provably
        runs forward from, not an attempt's own window.
      */
      const coverage: ShopifyOrderSyncCoverage = {
        recent: afterExpandedRepair("running").recent,
        historical: {
          latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
          latestSyncWindowStart: "2026-08-06",
          latestSyncWindowEnd: "2026-09-04",
          readyThroughDate: "2026-09-04",
          latestSuccessfulSyncWindowStart: "2026-08-06",
          latestSuccessfulSyncWindowEnd: "2026-09-04",
          latestSyncStatus: "ready",
          historicalTargetStart: "2025-09-05",
        },
      };
      expect(proveShopifyOrderWindowCovered({ window, coverage })).toEqual({ covered: true });

      const evidence = await resolve({
        deps: deps({ readOrderSyncCoverage: async () => coverage }),
      });
      expect(evidence.status).toBe("observed");
    });

    it("names a permanent hole 'unproven' the moment ANY wider attempt is on the row", () => {
      /*
        What `orders_coverage_unproven` is, and is not.

        Its docstring used to say the status means the store "may well be fully
        covered" and that "it is NOT what an ordinary refresh produces". Both
        were false, and this pins the truth so the sentence cannot drift back.

        One store, genuinely missing 2026-08-21 to 2026-08-29 — a backfill that
        finished at 2026-08-20 and a recent span that starts on 2026-08-30. No
        successful pass will ever close that hole; only a wider backfill target
        would. The refusal is right in every variant below. The NAME is what
        moves, and it moves with something that has no bearing on the hole.
      */
      const historicalStopsShort = {
        latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
        latestSyncWindowStart: "2026-08-01",
        latestSyncWindowEnd: "2026-08-20",
        readyThroughDate: "2026-08-20",
        latestSuccessfulSyncWindowStart: "2026-08-01",
        latestSuccessfulSyncWindowEnd: "2026-08-20",
        latestSyncStatus: "ready",
        historicalTargetStart: "2025-09-05",
      } as const;
      const withRecentAttempt = (
        attempt: { start: string; end: string; status: string },
      ): ShopifyOrderSyncCoverage => ({
        recent: {
          ...SEVEN_DAY_PROVEN,
          latestSyncWindowStart: attempt.start,
          latestSyncWindowEnd: attempt.end,
          latestSyncStatus: attempt.status,
        },
        historical: { ...historicalStopsShort },
      });

      // Quiet: the last attempt IS the pass that proved the recent span, so
      // nothing reaches past it and the hole is named for what it is.
      expect(
        proveShopifyOrderWindowCovered({
          window,
          coverage: withRecentAttempt({
            start: "2026-08-30",
            end: "2026-09-05",
            status: "succeeded",
          }),
        }),
      ).toEqual({ covered: false, reason: "orders_coverage_gap" });

      // An ORDINARY recurring pass on the next store day. `classifyShopifySyncWindow`
      // ends the recent window on the store's today, so a routine refresh names a
      // window one day past anything the last success proved — enough to rename the
      // refusal. That is precisely what "NOT what an ordinary refresh produces"
      // denied.
      expect(
        proveShopifyOrderWindowCovered({
          window,
          coverage: withRecentAttempt({
            start: "2026-08-31",
            end: "2026-09-06",
            status: "running",
          }),
        }),
      ).toEqual({ covered: false, reason: "orders_coverage_unproven" });

      // The expanded webhook repair, which is the case the status was written
      // for. Same hole, same nine missing days, different name again.
      expect(
        proveShopifyOrderWindowCovered({
          window,
          coverage: withRecentAttempt({
            start: "2026-08-07",
            end: "2026-09-05",
            status: "running",
          }),
        }),
      ).toEqual({ covered: false, reason: "orders_coverage_unproven" });
    });
  });

  it("does NOT call a freshly synced store stale for want of recent sales", async () => {
    /*
      The defect this replaces. Freshness was measured from
      `MAX(order_created_at)`, so a store synced half an hour ago with forty
      orders in the 28-day window but nothing in the last three days was
      reported stale — which is an ordinary week for plenty of shops, and
      exactly the case where a 28-day average order value is still good
      evidence.
    */
    const coverage = fullCoverage();
    const evidence = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () => coverage,
        readObservedAt: async () => "2026-09-02T10:00:00.000Z",
        readAggregate: async () =>
          ({ purchases: 40, revenue: 2320, averageOrderValue: 58 }) as never,
      }),
    });
    expect(evidence.status).toBe("observed");
    expect(evidence.orderCount).toBe(40);
    expect(observedShopifyAovIsUsable(evidence)).toBe(true);
    // The newest sale is still reported as what it is — when the newest fact
    // in the window happened — it just no longer decides freshness.
    expect(evidence.observedAt).toBe("2026-09-02T10:00:00.000Z");

    /*
      And the coverage proof cannot be satisfied by sales existing either: it
      is given only the windows the sync recorded, with no per-day row
      information anywhere in the shape, so "we read these days" and "these
      days had orders" stay separate questions.
    */
    const recordedFields = Object.keys(coverage.recent!).sort();
    expect(recordedFields).toEqual([
      "historicalTargetStart",
      "latestSuccessfulSyncAt",
      "latestSuccessfulSyncWindowEnd",
      "latestSuccessfulSyncWindowStart",
      "latestSyncStatus",
      "latestSyncWindowEnd",
      "latestSyncWindowStart",
      "readyThroughDate",
    ]);
    // The two fields the proof now reads are the bounds a SUCCESSFUL pass
    // recorded for itself. Neither is a per-day fact about orders, so the law
    // above is unchanged: every field here is something the sync wrote about
    // itself, never a count of rows on a day.
  });

  it("separates 'never synced successfully' from 'synced too long ago'", async () => {
    // Two different absences, and only one of them is about age.
    const neverSynced = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () => fullCoverage({ recent: null }),
      }),
    });
    expect(neverSynced.status).toBe("unavailable");

    // A recent row that exists but has never succeeded is the same absence:
    // we have not looked successfully, as distinct from having looked and
    // found old data.
    const neverSucceeded = await resolve({
      deps: deps({
        readOrderSyncCoverage: async () =>
          fullCoverage({
            recent: {
              latestSuccessfulSyncAt: null,
              latestSyncWindowStart: "2026-08-30",
              readyThroughDate: null,
              latestSyncWindowEnd: "2026-09-05",
              latestSuccessfulSyncWindowStart: null,
              latestSuccessfulSyncWindowEnd: null,
              latestSyncStatus: "running",
              historicalTargetStart: "2026-08-30",
            },
          }),
      }),
    });
    expect(neverSucceeded.status).toBe("unavailable");

    // And a read that failed outright fails closed to the same answer rather
    // than to a coverage verdict it has no rows to support.
    const readFailed = await resolve({
      deps: deps({ readOrderSyncCoverage: async () => null }),
    });
    expect(readFailed.status).toBe("unavailable");
  });

  it("gates availability on every table the evidence depends on", async () => {
    /*
      `shopify_order_transactions` is in the ledger reader's own readiness gate
      and that reader answers with zeros — not a refusal — when it is missing,
      so a store missing only that table surfaced as `observed_zero_orders`.
      `shopify_sync_state` is load-bearing now that coverage is read from it,
      and a missing table must be named here rather than swallowed by the
      coverage reader's fail-closed catch.
    */
    readiness.calls.length = 0;
    const evidence = await resolve({
      deps: deps({ schemaReady: undefined }),
    });
    expect(evidence.status).toBe("unavailable");
    expect(evidence.status).not.toBe("observed_zero_orders");
    expect(readiness.calls[0]).toEqual([
      "shopify_orders",
      "shopify_sales_events",
      "shopify_order_transactions",
      "shopify_sync_state",
    ]);
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
