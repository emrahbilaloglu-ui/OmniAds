// Child of ephemeral-postgres-migrations-check: runs the observed-AOV order
// coverage reader against a real migrated database.
//
// This seam exists because the freshness clock it guards was
// `MAX(latest_successful_sync_at)` over an UNFILTERED `sync_target`. There are
// four targets per store — orders and returns, each recent and historical — so
// a returns pass that finished an hour ago certified orders last read five days
// earlier as current, and nothing anywhere checked that the 28-day window being
// averaged was a window we had actually read.
//
// A unit test cannot close that. The reader fails closed: any SQLSTATE 42703
// from a renamed column lands in its catch and comes back as `unavailable`,
// which is indistinguishable from a store that never synced. Only a real
// `shopify_sync_state` — with a genuine returns row sitting in it — can prove
// that the returns row is now unreachable and that every column the reader
// names exists.
//
// Every row here is written through the sync's own writer,
// `upsertShopifySyncState`, never through a hand-written INSERT: `sync_target`
// has no CHECK constraint and the four legal names exist only as string
// literals in `lib/sync/shopify-sync.ts`, so a rename has to break this seam
// rather than silently make coverage unprovable forever.
import { getDb } from "@/lib/db";
import {
  proveShopifyOrderWindowCovered,
  readOrderSyncCoverage,
  resolveObservedShopifyAov,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import { ensureProviderAccountReferenceIds } from "@/lib/provider-account-reference-store";
import { upsertShopifySyncState } from "@/lib/shopify/sync-state";
import { resolveShopifySyncWebhookRepairPolicy } from "@/lib/shopify/webhooks";

const LABEL = "shopify-aov-coverage-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const BUSINESS_ID = "d0000000-0000-4000-8000-000000000301";
const OWNER_ID = "d0000000-0000-4000-8000-0000000003ff";

// The 28 closed store days the evidence is built over, as
// `resolveObservedShopifyAov` computes them.
const WINDOW = { from: "2026-08-08", to: "2026-09-04" };

// One store per case, so a COALESCEd row from an earlier case can never make a
// later one pass.
const SHOP_RETURNS_MASK = "returns-mask.myshopify.com";
const SHOP_SHORT_BACKFILL = "short-backfill.myshopify.com";
const SHOP_COVERED = "covered.myshopify.com";
const SHOP_NO_HISTORICAL = "no-historical.myshopify.com";
const SHOP_REPAIR_RUNNING = "repair-running.myshopify.com";
const SHOP_REPAIR_FAILED = "repair-failed.myshopify.com";
const SHOP_REPAIR_FINISHED = "repair-finished.myshopify.com";

const FRESH_SYNC_AT = "2026-09-05T08:30:00.000Z";
const FIVE_DAYS_OLD_SYNC_AT = "2026-08-31T08:30:00.000Z";

// The instant the whole expanded-repair group is evaluated at. 09:00Z is
// 02:00 in America/Los_Angeles, so the store's today is 2026-09-05 and the
// twenty-eight closed days are exactly WINDOW.
const NOW = new Date("2026-09-05T09:00:00.000Z");
const STORE_TIME_ZONE = "America/Los_Angeles";
const STORE_TODAY = "2026-09-05";
const SEVEN_DAY_SUCCESS_AT = "2026-09-05T06:00:00.000Z";
const REPAIR_STARTED_AT = "2026-09-05T06:25:00.000Z";
const REPAIR_FINISHED_AT = "2026-09-05T06:30:00.000Z";
// Enough orders to clear OBSERVED_SHOPIFY_AOV_MIN_ORDERS, so a covered store
// reaches `observed` rather than `sample_thin` and the two cases below differ
// by coverage alone.
const SEEDED_ORDERS = 41;
const SEEDED_ORDER_VALUE = 58;

async function seedBusiness() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, 'shopify-aov-coverage-seam@example.test',
             'AOV coverage seam', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER_ID],
  );
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency)
     VALUES ($1::uuid, 'AOV coverage seam', $2::uuid, 'America/Los_Angeles', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, OWNER_ID],
  );
}

/*
  The store row and its binding to the business.

  `upsertShopifySyncState` resolves both reference ids itself, but the sync
  state row carries them, so the store has to be a real provider account before
  any sync state for it can exist.
*/
async function seedStore(shopId: string) {
  const sql = getDb();
  const refIds = await ensureProviderAccountReferenceIds({
    provider: "shopify",
    accounts: [{ externalAccountId: shopId, currency: "USD", timezone: "America/Los_Angeles" }],
  });
  const refId = refIds.get(shopId);
  if (!refId) fail("provider_account_ref_missing", shopId);
  await sql.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id)
     VALUES ($1, 'shopify', $2::uuid, $3)
     ON CONFLICT (business_id, provider, provider_account_ref_id) DO NOTHING`,
    [BUSINESS_ID, refId, shopId],
  );
}

function addIsoDays(value: string, days: number) {
  const next = new Date(`${value}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/*
  Real orders and real ledger events inside the window.

  The expanded-repair cases below run the whole reader, not just its coverage
  proof, so the ledger aggregate, the window currency read and the observed-at
  read all have to answer from actual rows. Without them a covered store would
  come back `observed_zero_orders` and the two cases would stop differing by
  coverage — which is the only thing they are here to test.
*/
async function seedWindowOrders(shopId: string) {
  const sql = getDb();
  for (let index = 0; index < SEEDED_ORDERS; index += 1) {
    const day = addIsoDays(WINDOW.from, index % 28);
    const orderId = `${shopId}-order-${index}`;
    await sql.query(
      `INSERT INTO shopify_orders (
         business_id, provider_account_id, shop_id, order_id, currency_code,
         order_created_at, order_created_date_local, total_price, current_total_price
       )
       VALUES ($1, $2, $2, $3, 'USD', ($4 || 'T12:00:00Z')::timestamptz, $4::date, $5, $5)
       ON CONFLICT (business_id, provider_account_id, shop_id, order_id) DO NOTHING`,
      [BUSINESS_ID, shopId, orderId, day, SEEDED_ORDER_VALUE],
    );
    await sql.query(
      `INSERT INTO shopify_sales_events (
         business_id, provider_account_id, shop_id, event_id, source_kind, source_id,
         order_id, occurred_at, occurred_date_local, gross_sales, net_revenue, currency_code
       )
       VALUES ($1, $2, $2, $3, 'order', $3, $3,
               ($4 || 'T12:00:00Z')::timestamptz, $4::date, $5, $5, 'USD')
       ON CONFLICT (business_id, provider_account_id, shop_id, event_id) DO NOTHING`,
      [BUSINESS_ID, shopId, orderId, day, SEEDED_ORDER_VALUE],
    );
  }
}

/*
  The recent-orders pass, written exactly as it writes itself on success
  (`lib/sync/shopify-sync.ts:880-896`): the window it read, the success-only
  `ready_through_date` and the success receipt, all in one upsert.
*/
async function recordSuccessfulRecentOrdersPass(input: {
  shopId: string;
  windowStart: string;
  windowEnd: string;
  succeededAt: string;
  historicalTargetStart: string;
}) {
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: input.shopId,
    syncTarget: "commerce_orders_recent",
    historicalTargetStart: input.historicalTargetStart,
    historicalTargetEnd: input.windowEnd,
    readyThroughDate: input.windowEnd,
    cursorTimestamp: `${input.windowEnd}T23:59:59.000Z`,
    cursorValue: input.windowEnd,
    latestSyncStartedAt: input.succeededAt,
    latestSuccessfulSyncAt: input.succeededAt,
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: input.windowStart,
    latestSyncWindowEnd: input.windowEnd,
    lastError: null,
  });
}

/*
  The same pass writing its window BEFORE doing any work
  (`lib/sync/shopify-sync.ts:380-391`), and the failure write that replaces the
  status with the provider's own reason (`:527-535`). Neither carries a
  `ready_through_date` or a success timestamp, so `upsertShopifySyncState`
  COALESCE-preserves the earlier pass's — which is the whole defect.
*/
async function recordUnsuccessfulRecentOrdersAttempt(input: {
  shopId: string;
  windowStart: string;
  windowEnd: string;
  status: "running" | (string & {});
  startedAt?: string;
  lastError?: string | null;
}) {
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: input.shopId,
    syncTarget: "commerce_orders_recent",
    latestSyncStartedAt: input.startedAt ?? null,
    latestSyncStatus: input.status,
    latestSyncWindowStart: input.windowStart,
    latestSyncWindowEnd: input.windowEnd,
    lastError: input.lastError ?? null,
  });
}

/*
  The reader, end to end, with only the Shopify credential injected.

  There is no OAuth install in an ephemeral database, so the store's identity
  and IANA zone are supplied; everything the verdict depends on — the schema
  readiness gate, the revenue ledger, the window currency read, the observed-at
  read and the order sync coverage read — runs against the real tables.
*/
async function resolveEvidenceForStore(shopId: string) {
  return resolveObservedShopifyAov({
    businessId: BUSINESS_ID,
    accountCurrency: "USD",
    currencyExponent: 2,
    now: NOW,
    deps: {
      resolveCredentials: (async () => ({
        businessId: BUSINESS_ID,
        shopId,
        accessToken: "seam",
        scopes: [],
        metadata: { iana_timezone: STORE_TIME_ZONE },
      })) as never,
    },
  });
}

async function main() {
  await seedBusiness();
  for (const shopId of [
    SHOP_RETURNS_MASK,
    SHOP_SHORT_BACKFILL,
    SHOP_COVERED,
    SHOP_NO_HISTORICAL,
    SHOP_REPAIR_RUNNING,
    SHOP_REPAIR_FAILED,
    SHOP_REPAIR_FINISHED,
  ]) {
    await seedStore(shopId);
  }

  /*
    Case A — a returns pass cannot answer a question about orders.

    Returns synced minutes ago, orders five days ago. The old clock took the
    maximum across both and called the store current.
  */
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_RETURNS_MASK,
    syncTarget: "commerce_returns_recent",
    readyThroughDate: "2026-09-05",
    latestSuccessfulSyncAt: FRESH_SYNC_AT,
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: "2026-08-30",
    latestSyncWindowEnd: "2026-09-05",
  });
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_RETURNS_MASK,
    syncTarget: "commerce_returns_historical",
    historicalTargetStart: "2025-09-05",
    historicalTargetEnd: "2026-09-04",
    readyThroughDate: "2026-09-04",
    latestSuccessfulSyncAt: FRESH_SYNC_AT,
    latestSyncStatus: "ready",
  });
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_RETURNS_MASK,
    syncTarget: "commerce_orders_recent",
    historicalTargetStart: "2026-08-25",
    historicalTargetEnd: "2026-08-31",
    readyThroughDate: "2026-08-31",
    latestSuccessfulSyncAt: FIVE_DAYS_OLD_SYNC_AT,
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: "2026-08-25",
    latestSyncWindowEnd: "2026-08-31",
  });

  const masked = await readOrderSyncCoverage({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_RETURNS_MASK,
  });
  if (masked === null) {
    // The reader fails closed, so a renamed column arrives here as `null` and
    // would otherwise be reported as a store that never synced.
    fail("reader_returned_null", "every column must resolve against the real schema");
  }
  // Two slots, and neither of them a returns target — the defect is not merely
  // unwritten, it has nowhere to be written.
  expectEqual(Object.keys(masked).sort(), ["historical", "recent"], "coverage_slots");
  expectEqual(masked.historical, null, "returns_historical_is_not_historical_orders");
  expectEqual(
    masked.recent?.latestSuccessfulSyncAt,
    FIVE_DAYS_OLD_SYNC_AT,
    "clock_is_the_orders_pass",
  );
  expectEqual(masked.recent?.readyThroughDate, "2026-08-31", "recent_ready_through");
  expectEqual(masked.recent?.latestSyncWindowStart, "2026-08-25", "recent_window_start");
  if (JSON.stringify(masked).includes("commerce_returns")) {
    fail("returns_leaked_into_coverage", JSON.stringify(masked));
  }

  /*
    Case B — a backfill that reaches the window's start but stops two hundred
    days short of its end leaves days nobody read.
  */
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_SHORT_BACKFILL,
    syncTarget: "commerce_orders_historical",
    historicalTargetStart: "2025-09-05",
    historicalTargetEnd: "2026-09-04",
    readyThroughDate: "2026-02-16",
    latestSuccessfulSyncAt: FRESH_SYNC_AT,
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: "2026-01-18",
    latestSyncWindowEnd: "2026-02-16",
  });
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_SHORT_BACKFILL,
    syncTarget: "commerce_orders_recent",
    readyThroughDate: "2026-09-05",
    latestSuccessfulSyncAt: FRESH_SYNC_AT,
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: "2026-08-30",
    latestSyncWindowEnd: "2026-09-05",
  });
  const short = await readOrderSyncCoverage({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_SHORT_BACKFILL,
  });
  if (short === null) fail("reader_returned_null", "short backfill case");
  expectEqual(
    proveShopifyOrderWindowCovered({ window: WINDOW, coverage: short }),
    { covered: false, reason: "orders_coverage_gap" },
    "short_backfill_is_a_gap",
  );

  /*
    Case C — a backfill spanning the window, joined by the recent pass, is
    covered. Nothing here asks whether any order rows exist: a fully synced
    store that sold nothing all month is still covered, which is the case the
    freshness fix was originally for.
  */
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_COVERED,
    syncTarget: "commerce_orders_historical",
    historicalTargetStart: "2025-09-05",
    historicalTargetEnd: "2026-09-04",
    readyThroughDate: "2026-09-04",
    latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
    latestSyncStatus: "ready",
    latestSyncWindowStart: "2026-08-06",
    latestSyncWindowEnd: "2026-09-04",
  });
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_COVERED,
    syncTarget: "commerce_orders_recent",
    readyThroughDate: "2026-09-05",
    latestSuccessfulSyncAt: FRESH_SYNC_AT,
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: "2026-08-30",
    latestSyncWindowEnd: "2026-09-05",
  });
  const covered = await readOrderSyncCoverage({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_COVERED,
  });
  if (covered === null) fail("reader_returned_null", "covered case");
  expectEqual(covered.historical?.historicalTargetStart, "2025-09-05", "historical_start");
  expectEqual(covered.historical?.readyThroughDate, "2026-09-04", "historical_ready_through");
  expectEqual(
    proveShopifyOrderWindowCovered({ window: WINDOW, coverage: covered }),
    { covered: true },
    "full_span_is_covered",
  );

  /*
    Case D — only the recent pass. Seven days cannot cover twenty-eight, and
    that is a backfill which has not arrived rather than a gap in the middle or
    an aged sync.
  */
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_NO_HISTORICAL,
    syncTarget: "commerce_orders_recent",
    historicalTargetStart: "2026-08-30",
    historicalTargetEnd: "2026-09-05",
    readyThroughDate: "2026-09-05",
    latestSuccessfulSyncAt: FRESH_SYNC_AT,
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: "2026-08-30",
    latestSyncWindowEnd: "2026-09-05",
  });
  const recentOnly = await readOrderSyncCoverage({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_NO_HISTORICAL,
  });
  if (recentOnly === null) fail("reader_returned_null", "recent-only case");
  expectEqual(recentOnly.historical, null, "no_historical_row");
  expectEqual(
    proveShopifyOrderWindowCovered({ window: WINDOW, coverage: recentOnly }),
    { covered: false, reason: "orders_backfill_incomplete" },
    "recent_only_is_incomplete",
  );

  /*
    Cases E, F and G — an expanded recent window that no successful pass
    established.

    A seven-day recent pass succeeds. A webhook then arrives carrying an order
    forty days old, and the repair policy expands the recent window to the
    thirty-day ceiling, so the repair's start is three weeks EARLIER than the
    successful pass's. `latest_sync_window_start` is written by running and
    failed attempts, while `ready_through_date` and `latest_successful_sync_at`
    are success-only and COALESCE-preserved through them, so the row is left
    holding a thirty-day start beside a seven-day success.

    Nothing here asserts that thirty; it is read back out of the real repair
    policy, so a change to the ceiling or to the expansion rule breaks this
    seam rather than quietly making the case unreachable.
  */
  const repairPolicy = resolveShopifySyncWebhookRepairPolicy({
    topic: "ORDERS_UPDATED",
    payload: { updated_at: "2026-07-27T12:00:00.000Z" },
    receivedAt: NOW,
  });
  if (!repairPolicy.windowExpanded) {
    fail("repair_window_not_expanded", JSON.stringify(repairPolicy));
  }
  // `classifyShopifySyncWindow` ends the recent window on the store's today and
  // counts the days inclusive (`lib/sync/shopify-sync.ts:88-92`).
  const repairWindowStart = addIsoDays(STORE_TODAY, -(repairPolicy.recentWindowDays - 1));
  if (repairWindowStart > WINDOW.from) {
    fail(
      "repair_window_does_not_reach_the_window",
      `repair start ${repairWindowStart} is not before ${WINDOW.from}; `
      + "this case only reproduces the defect when the expanded start precedes "
      + "the twenty-eight day window's first day",
    );
  }

  for (const store of [
    { shopId: SHOP_REPAIR_RUNNING, status: "running" as const, label: "running" },
    {
      shopId: SHOP_REPAIR_FAILED,
      status: "shopify_admin_error",
      label: "failed",
    },
  ]) {
    await seedWindowOrders(store.shopId);
    await recordSuccessfulRecentOrdersPass({
      shopId: store.shopId,
      windowStart: addIsoDays(STORE_TODAY, -6),
      windowEnd: STORE_TODAY,
      succeededAt: SEVEN_DAY_SUCCESS_AT,
      historicalTargetStart: addIsoDays(STORE_TODAY, -6),
    });
    await recordUnsuccessfulRecentOrdersAttempt({
      shopId: store.shopId,
      windowStart: repairWindowStart,
      windowEnd: STORE_TODAY,
      status: "running",
      startedAt: REPAIR_STARTED_AT,
    });
    if (store.status !== "running") {
      await recordUnsuccessfulRecentOrdersAttempt({
        shopId: store.shopId,
        windowStart: repairWindowStart,
        windowEnd: STORE_TODAY,
        status: store.status,
        lastError: store.status,
      });
    }

    const persisted = await readOrderSyncCoverage({
      businessId: BUSINESS_ID,
      providerAccountId: store.shopId,
    });
    if (persisted === null) fail("reader_returned_null", `${store.label} repair case`);
    // What the writer actually left behind, read back: the unsuccessful
    // attempt's start, the earlier pass's success end and success receipt.
    expectEqual(
      persisted.recent?.latestSyncWindowStart,
      repairWindowStart,
      `${store.label}_start_is_the_unsuccessful_attempt`,
    );
    expectEqual(
      persisted.recent?.readyThroughDate,
      STORE_TODAY,
      `${store.label}_end_survived_from_the_earlier_success`,
    );
    expectEqual(
      persisted.recent?.latestSuccessfulSyncAt,
      SEVEN_DAY_SUCCESS_AT,
      `${store.label}_receipt_survived_from_the_earlier_success`,
    );
    expectEqual(
      persisted.recent?.latestSyncStatus,
      store.status,
      `${store.label}_status_is_the_unsuccessful_attempt`,
    );
    expectEqual(persisted.historical, null, `${store.label}_no_historical_coverage`);
    // The pair really does span the window, which is why combining them read
    // as covered. The refusal below is not the window being out of reach.
    if (
      !(persisted.recent!.latestSyncWindowStart! <= WINDOW.from)
      || !(persisted.recent!.readyThroughDate! >= WINDOW.to)
    ) {
      fail(`${store.label}_shape_does_not_reproduce`, JSON.stringify(persisted.recent));
    }

    expectEqual(
      proveShopifyOrderWindowCovered({ window: WINDOW, coverage: persisted }),
      { covered: false, reason: "orders_coverage_unproven" },
      `${store.label}_repair_does_not_prove_coverage`,
    );

    const evidence = await resolveEvidenceForStore(store.shopId);
    expectEqual(evidence.status, "orders_coverage_unproven", `${store.label}_evidence_status`);
    expectEqual(evidence.aovMinor, null, `${store.label}_no_unit_offered`);
    // Freshness is not what refused it: the seven-day pass succeeded three
    // hours ago and the store really did record its orders.
    expectEqual(evidence.orderCount, SEEDED_ORDERS, `${store.label}_orders_were_counted`);
  }

  /*
    Case G — the same thirty-day window, once the pass actually finishes.

    Nothing about the window changed; the repair completed and wrote its own
    end and its own receipt beside its own start. This is the half the refusal
    must not swallow.
  */
  await seedWindowOrders(SHOP_REPAIR_FINISHED);
  await recordSuccessfulRecentOrdersPass({
    shopId: SHOP_REPAIR_FINISHED,
    windowStart: addIsoDays(STORE_TODAY, -6),
    windowEnd: STORE_TODAY,
    succeededAt: SEVEN_DAY_SUCCESS_AT,
    historicalTargetStart: addIsoDays(STORE_TODAY, -6),
  });
  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_REPAIR_FINISHED,
    windowStart: repairWindowStart,
    windowEnd: STORE_TODAY,
    status: "running",
    startedAt: REPAIR_STARTED_AT,
  });
  await recordSuccessfulRecentOrdersPass({
    shopId: SHOP_REPAIR_FINISHED,
    windowStart: repairWindowStart,
    windowEnd: STORE_TODAY,
    succeededAt: REPAIR_FINISHED_AT,
    historicalTargetStart: addIsoDays(STORE_TODAY, -6),
  });

  const finished = await readOrderSyncCoverage({
    businessId: BUSINESS_ID,
    providerAccountId: SHOP_REPAIR_FINISHED,
  });
  if (finished === null) fail("reader_returned_null", "finished repair case");
  expectEqual(finished.recent?.latestSyncStatus, "succeeded", "finished_status");
  expectEqual(finished.recent?.latestSuccessfulSyncAt, REPAIR_FINISHED_AT, "finished_receipt");
  expectEqual(finished.historical, null, "finished_no_historical_coverage");
  expectEqual(
    proveShopifyOrderWindowCovered({ window: WINDOW, coverage: finished }),
    { covered: true },
    "completed_thirty_day_pass_proves_coverage",
  );
  const finishedEvidence = await resolveEvidenceForStore(SHOP_REPAIR_FINISHED);
  expectEqual(finishedEvidence.status, "observed", "finished_evidence_status");
  expectEqual(finishedEvidence.currency, "USD", "finished_evidence_currency");
  expectEqual(finishedEvidence.aovMinor, SEEDED_ORDER_VALUE * 100, "finished_evidence_aov");

  console.log(
    `[${LABEL}] PASS: order coverage read from shopify_sync_state through the real `
    + "columns, a fresh returns row unreachable from the result, a short backfill "
    + "refused as a gap, a joined historical+recent span covered, a recent-only "
    + "store refused as an incomplete backfill, a seven-day success followed by a "
    + `${repairPolicy.recentWindowDays}-day running or failed repair refused as `
    + "unproven, and the same repair accepted once it completed.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
