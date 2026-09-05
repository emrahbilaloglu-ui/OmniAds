import { describe, expect, it, vi } from "vitest";

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

  Each row is shaped as the sync's own SUCCESS write leaves it: the recorded
  attempt's status is a success, and its window end is the same day as the
  success-only `ready_through_date`, because one upsert wrote both. That
  pairing is what the coverage proof now requires, so a fixture that omits it
  is describing a store whose window start belongs to some later attempt.
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
      latestSyncStatus: "succeeded",
      historicalTargetStart: "2026-08-30",
    },
    historical: {
      latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
      latestSyncWindowStart: "2026-08-06",
      readyThroughDate: "2026-09-04",
      latestSyncWindowEnd: "2026-09-04",
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
              latestSyncStatus: "succeeded",
              historicalTargetStart: "2026-08-30",
            },
            historical: {
              latestSuccessfulSyncAt: "2026-09-05T08:55:00.000Z",
              latestSyncWindowStart: "2026-08-06",
              readyThroughDate: "2026-09-04",
              latestSyncWindowEnd: "2026-09-04",
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
            latestSyncStatus: null,
            historicalTargetStart: null,
          },
          historical: {
            latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
            latestSyncWindowStart: "2026-08-01",
            readyThroughDate: "2026-08-20",
            latestSyncWindowEnd: "2026-08-20",
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

  describe("an expanded recent window that no successful pass established", () => {
    /*
      The defect, as the sync itself persists it.

      A seven-day recent pass succeeded at 06:00 and wrote `ready_through_date`
      and `latest_successful_sync_at` together with its own window. A webhook
      then arrived carrying a thirty-day-old order, so the repair pass expanded
      the recent window to thirty days (`lib/shopify/webhooks.ts:183-191`) and
      wrote its start before doing any work. `latest_sync_window_start` is
      written by running, cancelled and failed attempts alike, while the two
      success-only columns are COALESCE-preserved through them
      (`lib/shopify/sync-state.ts:201`, `:205`).

      What is left on the row is a THIRTY-day start beside a SEVEN-day
      success — and the old proof combined them into twenty-eight days of
      coverage for days the store had never read.
    */
    const window = { from: "2026-08-08", to: "2026-09-04" };
    function afterExpandedRepair(status: string): ShopifyOrderSyncCoverage {
      return {
        recent: {
          // The seven-day pass that really did succeed, half an hour before
          // the repair started. Still inside the freshness ceiling, so this
          // case reaches the coverage proof rather than stopping at `stale`.
          latestSuccessfulSyncAt: "2026-09-05T06:00:00.000Z",
          readyThroughDate: "2026-09-05",
          // The repair's window, which nothing has finished reading.
          latestSyncWindowStart: "2026-08-07",
          latestSyncWindowEnd: "2026-09-05",
          latestSyncStatus: status,
          historicalTargetStart: "2026-08-30",
        },
        // No backfill has run for this store, so the recent row is the only
        // thing that could speak for the window.
        historical: null,
      };
    }

    it("is refused rather than combined into a window nobody read", () => {
      for (const status of ["running", "failed", "missing_read_orders_scope", "cancelled"]) {
        const coverage = afterExpandedRepair(status);
        // The naive combination really would have covered the window: the
        // retained start is before its first day and the retained success end
        // is after its last. This is the shape the review reproduced
        // `{"covered":true}` on.
        expect(coverage.recent!.latestSyncWindowStart! <= window.from).toBe(true);
        expect(coverage.recent!.readyThroughDate! >= window.to).toBe(true);

        expect(proveShopifyOrderWindowCovered({ window, coverage })).toEqual({
          covered: false,
          reason: "orders_coverage_unproven",
        });
      }
    });

    it("needs the recorded OUTCOME, because the bounds alone still match", () => {
      /*
        Both halves of the pairing are load-bearing and neither is redundant.

        A same-day repair ends on the same day the last success ended, so the
        attempt's own end equals the retained `ready_through_date` and that
        check passes on its own. Only the status says the attempt that wrote
        the start never finished.
      */
      const coverage = afterExpandedRepair("running");
      expect(coverage.recent!.latestSyncWindowEnd).toBe(coverage.recent!.readyThroughDate);
      expect(proveShopifyOrderWindowCovered({ window, coverage })).toEqual({
        covered: false,
        reason: "orders_coverage_unproven",
      });

      // And the mirror: a success status whose own end is NOT the retained
      // success end is a start paired with someone else's receipt.
      const mismatched: ShopifyOrderSyncCoverage = {
        recent: {
          ...afterExpandedRepair("succeeded").recent!,
          latestSyncWindowEnd: "2026-09-04",
        },
        historical: null,
      };
      expect(proveShopifyOrderWindowCovered({ window, coverage: mismatched })).toEqual({
        covered: false,
        reason: "orders_coverage_unproven",
      });
    });

    it("is accepted once that same thirty-day pass actually finishes", () => {
      // Nothing about the window changed; the pass completed and wrote its
      // own end and receipt beside its own start.
      const coverage: ShopifyOrderSyncCoverage = {
        recent: {
          latestSuccessfulSyncAt: "2026-09-05T06:30:00.000Z",
          latestSyncWindowStart: "2026-08-07",
          latestSyncWindowEnd: "2026-09-05",
          readyThroughDate: "2026-09-05",
          latestSyncStatus: "succeeded",
          historicalTargetStart: "2026-08-30",
        },
        historical: null,
      };
      expect(proveShopifyOrderWindowCovered({ window, coverage })).toEqual({ covered: true });
    });

    it("names the absence as unproven, not as a backfill that never arrived", async () => {
      // Through the reader, end to end. `orders_backfill_incomplete` would say
      // the days were never read; what is actually true is that the days may
      // well have been read and the row can no longer show it.
      const withheldEvidence = await resolve({
        deps: deps({ readOrderSyncCoverage: async () => afterExpandedRepair("running") }),
      });
      expect(withheldEvidence.status).toBe("orders_coverage_unproven");
      expect(observedShopifyAovIsUsable(withheldEvidence)).toBe(false);
      expect(withheldEvidence.aovMinor).toBeNull();

      const finished = await resolve({
        deps: deps({
          readOrderSyncCoverage: async () => ({
            recent: {
              ...afterExpandedRepair("succeeded").recent!,
              latestSuccessfulSyncAt: "2026-09-05T06:30:00.000Z",
            },
            historical: null,
          }),
        }),
      });
      expect(finished.status).toBe("observed");
      expect(observedShopifyAovIsUsable(finished)).toBe(true);
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
      "latestSyncStatus",
      "latestSyncWindowEnd",
      "latestSyncWindowStart",
      "readyThroughDate",
    ]);
    // The two fields the proof gained are the recorded attempt's OUTCOME and
    // its own end, which is what pairs a retained window start to a retained
    // success receipt. Neither is a per-day fact about orders, so the law
    // above is unchanged: every field here is something the sync wrote about
    // itself.
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
