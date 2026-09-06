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
  resolveRetainedRecentOrderSpan,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";
import { SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL } from "@/lib/migrations";
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
// The retention group: one store per in-flight shape, so a COALESCEd column
// from one case can never carry a later one.
const SHOP_ORDINARY_REFRESH = "ordinary-refresh.myshopify.com";
const SHOP_EXPANDED_IN_FLIGHT = "expanded-in-flight.myshopify.com";
const SHOP_FAILED_ATTEMPT = "failed-attempt.myshopify.com";
const SHOP_AGED_RECEIPT = "aged-receipt.myshopify.com";
const SHOP_NEVER_SUCCEEDED = "never-succeeded.myshopify.com";
const SHOP_LEGACY_ROW = "legacy-row.myshopify.com";
// The deploy-day group: rows that already existed when the retained columns
// were added, one per shape the backfill has to tell apart.
const SHOP_PREDEPLOY_SUCCESS = "predeploy-success.myshopify.com";
const SHOP_PREDEPLOY_RUNNING = "predeploy-running.myshopify.com";
const SHOP_PREDEPLOY_FAILED = "predeploy-failed.myshopify.com";
const SHOP_PREDEPLOY_END_MISMATCH = "predeploy-end-mismatch.myshopify.com";
// The permanent-hole group: what the reader CALLS a store that is genuinely
// missing days, with and without an attempt sitting on the row.
const SHOP_HOLE_QUIET = "hole-quiet.myshopify.com";
const SHOP_HOLE_REPAIR = "hole-repair.myshopify.com";
const SHOP_HOLE_REFRESH = "hole-refresh.myshopify.com";

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
  (`lib/sync/shopify-sync.ts:887-916`): the window it read, the success-only
  `ready_through_date`, the retained success bounds and the success receipt,
  all in one upsert.

  `retainSuccessfulWindow: false` reproduces a row written by the PREVIOUS
  version of that call site — a real shape on any database migrated before the
  retained columns existed, and the one the reader must treat as unproven.
*/
async function recordSuccessfulRecentOrdersPass(input: {
  shopId: string;
  windowStart: string;
  windowEnd: string;
  succeededAt: string;
  historicalTargetStart: string;
  retainSuccessfulWindow?: boolean;
}) {
  const retain = input.retainSuccessfulWindow !== false;
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
    latestSuccessfulSyncWindowStart: retain ? input.windowStart : null,
    latestSuccessfulSyncWindowEnd: retain ? input.windowEnd : null,
    lastError: null,
  });
}

/*
  A historical backfill chunk that finished, exactly as `:752-780` writes it.

  The chunk walk only moves forward from `historical_target_start`, so the span
  a reader may take from this row is `[historical_target_start,
  ready_through_date]` — the retained bounds on it describe the last CHUNK.
*/
async function recordSuccessfulHistoricalOrdersChunk(input: {
  shopId: string;
  targetStart: string;
  targetEnd: string;
  chunkStart: string;
  chunkEnd: string;
  succeededAt: string;
}) {
  await upsertShopifySyncState({
    businessId: BUSINESS_ID,
    providerAccountId: input.shopId,
    syncTarget: "commerce_orders_historical",
    historicalTargetStart: input.targetStart,
    historicalTargetEnd: input.targetEnd,
    readyThroughDate: input.chunkEnd,
    cursorTimestamp: `${input.chunkEnd}T23:59:59.000Z`,
    cursorValue: input.chunkEnd,
    latestSuccessfulSyncAt: input.succeededAt,
    latestSyncStatus: input.chunkEnd >= input.targetEnd ? "ready" : "succeeded",
    latestSyncWindowStart: input.chunkStart,
    latestSyncWindowEnd: input.chunkEnd,
    latestSuccessfulSyncWindowStart: input.chunkStart,
    latestSuccessfulSyncWindowEnd: input.chunkEnd,
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
    SHOP_ORDINARY_REFRESH,
    SHOP_EXPANDED_IN_FLIGHT,
    SHOP_FAILED_ATTEMPT,
    SHOP_AGED_RECEIPT,
    SHOP_NEVER_SUCCEEDED,
    SHOP_LEGACY_ROW,
    SHOP_PREDEPLOY_SUCCESS,
    SHOP_PREDEPLOY_RUNNING,
    SHOP_PREDEPLOY_FAILED,
    SHOP_PREDEPLOY_END_MISMATCH,
    SHOP_HOLE_QUIET,
    SHOP_HOLE_REPAIR,
    SHOP_HOLE_REFRESH,
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
    latestSuccessfulSyncWindowStart: "2026-08-30",
    latestSuccessfulSyncWindowEnd: "2026-09-05",
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
    latestSuccessfulSyncWindowStart: "2026-08-25",
    latestSuccessfulSyncWindowEnd: "2026-08-31",
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
    latestSuccessfulSyncWindowStart: "2026-01-18",
    latestSuccessfulSyncWindowEnd: "2026-02-16",
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
    latestSuccessfulSyncWindowStart: "2026-08-30",
    latestSuccessfulSyncWindowEnd: "2026-09-05",
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
    latestSuccessfulSyncWindowStart: "2026-08-06",
    latestSuccessfulSyncWindowEnd: "2026-09-04",
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
    latestSuccessfulSyncWindowStart: "2026-08-30",
    latestSuccessfulSyncWindowEnd: "2026-09-05",
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
    latestSuccessfulSyncWindowStart: "2026-08-30",
    latestSuccessfulSyncWindowEnd: "2026-09-05",
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

  /*
    Cases H to M — a proven window survives a refresh, and proves nothing more.

    The refusal above was correct and too wide. `latest_sync_window_start` and
    `latest_sync_window_end` are written by an ORDINARY recurring pass before it
    reads anything (`lib/sync/shopify-sync.ts:379-391`), so requiring the
    recorded attempt to be a success withdrew the store's coverage — and with it
    the derived CPA benchmark — for the whole duration of a routine sync.

    The success paths now record the window they actually read
    (`latest_successful_sync_window_start`/`_end`), the upsert preserves it
    through every unsuccessful attempt, and the proof reads THAT. These cases
    drive the real writer and the real reader over the shapes a live store
    passes through.
  */
  const RETENTION_HISTORICAL_TARGET_START = "2025-09-05";
  // The backfill's chunk walk has reached three days short of the window's last
  // day, which is why the recent pass is load-bearing here at all. A store whose
  // backfill already reaches yesterday never needed the recent span.
  const RETENTION_HISTORICAL_READY_THROUGH = "2026-09-01";
  const RECENT_PROVEN_START = addIsoDays(STORE_TODAY, -6);

  async function seedRetentionStore(shopId: string, succeededAt = SEVEN_DAY_SUCCESS_AT) {
    await seedWindowOrders(shopId);
    await recordSuccessfulHistoricalOrdersChunk({
      shopId,
      targetStart: RETENTION_HISTORICAL_TARGET_START,
      targetEnd: WINDOW.to,
      chunkStart: "2026-08-03",
      chunkEnd: RETENTION_HISTORICAL_READY_THROUGH,
      succeededAt: "2026-09-05T04:00:00.000Z",
    });
    await recordSuccessfulRecentOrdersPass({
      shopId,
      windowStart: RECENT_PROVEN_START,
      windowEnd: STORE_TODAY,
      succeededAt,
      historicalTargetStart: RECENT_PROVEN_START,
    });
  }

  /*
    One store, one moment: what the row holds, what the coverage proof makes of
    it, what the reader answers, and whether a money-per-purchase unit comes out
    the other end. The last of those is the thing the operator actually loses
    when coverage is withheld.
  */
  async function inspect(shopId: string) {
    const coverage = await readOrderSyncCoverage({
      businessId: BUSINESS_ID,
      providerAccountId: shopId,
    });
    if (coverage === null) fail("reader_returned_null", shopId);
    const verdict = proveShopifyOrderWindowCovered({ window: WINDOW, coverage });
    const evidence = await resolveEvidenceForStore(shopId);
    const unit = resolveSpendUnit({
      targetCpa: null,
      operatorAovAssumption: null,
      observedShopifyAov:
        evidence.status === "observed" && evidence.aovMinor
          ? evidence.aovMinor / 100
          : null,
      observedShopifyAovOrderCount: evidence.orderCount,
      observedShopifyAovStatus: evidence.status,
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      targetRoas: 2.2,
      breakEvenRoas: 1.8,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    });
    return {
      recent: coverage.recent,
      retainedSpan: resolveRetainedRecentOrderSpan(coverage.recent),
      verdict,
      evidence,
      derivedCpaMinor:
        unit.source === "observed_shopify_aov" && unit.spendUnit !== null
          ? Math.round(unit.spendUnit * 100)
          : null,
    };
  }

  /*
    Printed, not only asserted. The whole complaint this closes is an operator
    watching a concrete recommendation turn into "needs review" for no reason
    they can see, so the seam shows the verdict, the status and the unit at each
    moment rather than only failing when they are wrong.
  */
  function show(label: string, state: Awaited<ReturnType<typeof inspect>>) {
    console.log(
      `[${LABEL}] ${label}`
      + ` | attempt=${state.recent?.latestSyncWindowStart}..${state.recent?.latestSyncWindowEnd}`
      + ` (${state.recent?.latestSyncStatus})`
      + ` | proven=${state.retainedSpan ? `${state.retainedSpan.start}..${state.retainedSpan.end}` : "none"}`
      + ` | verdict=${JSON.stringify(state.verdict)}`
      + ` | status=${state.evidence.status}`
      + ` | aovMinor=${JSON.stringify(state.evidence.aovMinor)}`
      + ` | derivedCpaMinor=${JSON.stringify(state.derivedCpaMinor)}`,
    );
  }

  function expectUsableEvidence(
    state: Awaited<ReturnType<typeof inspect>>,
    label: string,
  ) {
    expectEqual(state.verdict, { covered: true }, `${label}_covered`);
    expectEqual(state.evidence.status, "observed", `${label}_evidence_status`);
    expectEqual(state.evidence.aovMinor, SEEDED_ORDER_VALUE * 100, `${label}_aov`);
    // $58.00 / 2.2 = $26.36. The benchmark that disappears when coverage does.
    expectEqual(state.derivedCpaMinor, 2636, `${label}_derived_cpa`);
  }

  /*
    Case H — an ORDINARY recurring pass, merely running.

    Before it started the store was covered and had a CPA benchmark; the pass
    has read nothing, changed nothing and proved nothing new, so taking the
    benchmark away for its duration is a refusal with no evidence behind it.
  */
  await seedRetentionStore(SHOP_ORDINARY_REFRESH);
  const refreshBefore = await inspect(SHOP_ORDINARY_REFRESH);
  show("H before  — last pass succeeded  ", refreshBefore);
  expectUsableEvidence(refreshBefore, "ordinary_refresh_before");
  expectEqual(
    refreshBefore.retainedSpan,
    { start: RECENT_PROVEN_START, end: STORE_TODAY },
    "ordinary_refresh_before_retained_span",
  );

  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_ORDINARY_REFRESH,
    windowStart: RECENT_PROVEN_START,
    windowEnd: STORE_TODAY,
    status: "running",
    startedAt: "2026-09-05T08:55:00.000Z",
  });
  const refreshDuring = await inspect(SHOP_ORDINARY_REFRESH);
  show("H during  — ordinary pass running", refreshDuring);
  expectEqual(
    refreshDuring.recent?.latestSyncStatus,
    "running",
    "ordinary_refresh_during_status",
  );
  expectEqual(
    refreshDuring.retainedSpan,
    { start: RECENT_PROVEN_START, end: STORE_TODAY },
    "ordinary_refresh_during_retained_span_survived",
  );
  expectUsableEvidence(refreshDuring, "ordinary_refresh_during");

  await recordSuccessfulRecentOrdersPass({
    shopId: SHOP_ORDINARY_REFRESH,
    windowStart: RECENT_PROVEN_START,
    windowEnd: STORE_TODAY,
    succeededAt: "2026-09-05T08:58:00.000Z",
    historicalTargetStart: RECENT_PROVEN_START,
  });
  const refreshAfter = await inspect(SHOP_ORDINARY_REFRESH);
  show("H after   — ordinary pass done   ", refreshAfter);
  expectEqual(
    refreshAfter.recent?.latestSyncStatus,
    "succeeded",
    "ordinary_refresh_after_status",
  );
  expectUsableEvidence(refreshAfter, "ordinary_refresh_after");

  /*
    Case I — the in-flight attempt is the THIRTY-day expanded repair.

    Retention is not borrowing. The repair's start is three weeks earlier than
    anything proven, and the covered recent span is still the seven days the
    last finished pass read. Cases E and F above are the other half of this
    claim: strip the backfill away and the expanded window establishes nothing.
  */
  await seedRetentionStore(SHOP_EXPANDED_IN_FLIGHT);
  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_EXPANDED_IN_FLIGHT,
    windowStart: repairWindowStart,
    windowEnd: STORE_TODAY,
    status: "running",
    startedAt: REPAIR_STARTED_AT,
  });
  const expandedInFlight = await inspect(SHOP_EXPANDED_IN_FLIGHT);
  show("I expanded 30-day repair in flight", expandedInFlight);
  expectEqual(
    expandedInFlight.recent?.latestSyncWindowStart,
    repairWindowStart,
    "expanded_in_flight_attempt_start_is_the_repair",
  );
  expectEqual(
    expandedInFlight.retainedSpan,
    { start: RECENT_PROVEN_START, end: STORE_TODAY },
    "expanded_in_flight_covered_span_is_the_retained_one",
  );
  if (!(repairWindowStart < RECENT_PROVEN_START)) {
    fail(
      "expanded_window_does_not_exceed_the_retained_one",
      `repair start ${repairWindowStart} must precede the retained ${RECENT_PROVEN_START} `
      + "for this case to distinguish borrowing from retaining",
    );
  }
  expectUsableEvidence(expandedInFlight, "expanded_in_flight");

  /*
    Case J — the attempt FAILED.

    The failure is not evidence in either direction: it neither proves the days
    it named nor unproves the days an earlier pass read.
  */
  await seedRetentionStore(SHOP_FAILED_ATTEMPT);
  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_FAILED_ATTEMPT,
    windowStart: RECENT_PROVEN_START,
    windowEnd: STORE_TODAY,
    status: "missing_read_orders_scope",
    lastError: "missing_read_orders_scope",
  });
  const failedAttempt = await inspect(SHOP_FAILED_ATTEMPT);
  show("J failed attempt                 ", failedAttempt);
  expectEqual(
    failedAttempt.recent?.latestSyncStatus,
    "missing_read_orders_scope",
    "failed_attempt_status",
  );
  expectEqual(
    failedAttempt.recent?.latestSuccessfulSyncAt,
    SEVEN_DAY_SUCCESS_AT,
    "failed_attempt_receipt_not_refreshed",
  );
  expectEqual(
    failedAttempt.retainedSpan,
    { start: RECENT_PROVEN_START, end: STORE_TODAY },
    "failed_attempt_retained_span_survived",
  );
  expectUsableEvidence(failedAttempt, "failed_attempt");

  /*
    Case K — the receipt ages out.

    Retention is not immortality. A pass that keeps failing never refreshes
    `latest_successful_sync_at`, so 75 hours after the last success the evidence
    is `stale` — even though the retained bounds are intact and the window is
    still, on paper, covered. Freshness refuses first, and by name.
  */
  const AGED_SUCCESS_AT = "2026-09-02T06:00:00.000Z";
  await seedWindowOrders(SHOP_AGED_RECEIPT);
  await recordSuccessfulHistoricalOrdersChunk({
    shopId: SHOP_AGED_RECEIPT,
    targetStart: RETENTION_HISTORICAL_TARGET_START,
    targetEnd: WINDOW.to,
    chunkStart: "2026-08-03",
    chunkEnd: WINDOW.to,
    succeededAt: "2026-09-05T04:00:00.000Z",
  });
  await recordSuccessfulRecentOrdersPass({
    shopId: SHOP_AGED_RECEIPT,
    windowStart: "2026-08-27",
    windowEnd: "2026-09-02",
    succeededAt: AGED_SUCCESS_AT,
    historicalTargetStart: "2026-08-27",
  });
  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_AGED_RECEIPT,
    windowStart: RECENT_PROVEN_START,
    windowEnd: STORE_TODAY,
    status: "shopify_admin_error",
    lastError: "shopify_admin_error",
  });
  const agedReceipt = await inspect(SHOP_AGED_RECEIPT);
  show("K receipt aged past 48h          ", agedReceipt);
  expectEqual(
    agedReceipt.retainedSpan,
    { start: "2026-08-27", end: "2026-09-02" },
    "aged_receipt_retained_span_still_readable",
  );
  // The backfill alone covers the window, so this is freshness refusing, not
  // coverage: the retained bounds did not resurrect a window that has aged.
  expectEqual(agedReceipt.verdict, { covered: true }, "aged_receipt_still_covered");
  expectEqual(
    agedReceipt.recent?.latestSuccessfulSyncAt,
    AGED_SUCCESS_AT,
    "aged_receipt_not_refreshed_by_the_failure",
  );
  expectEqual(agedReceipt.evidence.status, "stale", "aged_receipt_evidence_status");
  expectEqual(agedReceipt.evidence.aovMinor, null, "aged_receipt_no_unit_offered");

  /*
    Case L — a store that has never had a successful pass.

    Both retained columns NULL and no receipt at all: refused exactly as before,
    and as `unavailable` rather than as a coverage verdict the row has nothing
    to support.
  */
  await seedWindowOrders(SHOP_NEVER_SUCCEEDED);
  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_NEVER_SUCCEEDED,
    windowStart: RECENT_PROVEN_START,
    windowEnd: STORE_TODAY,
    status: "running",
    startedAt: "2026-09-05T08:55:00.000Z",
  });
  const neverSucceeded = await inspect(SHOP_NEVER_SUCCEEDED);
  show("L never succeeded                ", neverSucceeded);
  expectEqual(neverSucceeded.retainedSpan, null, "never_succeeded_no_retained_span");
  expectEqual(
    neverSucceeded.recent?.latestSuccessfulSyncAt,
    null,
    "never_succeeded_no_receipt",
  );
  expectEqual(
    neverSucceeded.verdict,
    { covered: false, reason: "orders_backfill_incomplete" },
    "never_succeeded_verdict",
  );
  expectEqual(neverSucceeded.evidence.status, "unavailable", "never_succeeded_evidence");
  expectEqual(neverSucceeded.evidence.aovMinor, null, "never_succeeded_no_unit");

  /*
    Case M — a row with no retained bounds at all, written AFTER the migration.

    This is not the deploy-day shape: a pre-deploy row of exactly this shape is
    given its bounds by the migration's own backfill, which cases N1 to N4 below
    drive. What this case pins is the reader in isolation — with no retained
    bounds on the row, the same pairing the PREVIOUS proof accepted
    (`latest_sync_window_end` equal to `ready_through_date`, last status a
    success) is no longer read as coverage by the reader itself. One successful
    pass later, the proof is back, with no other change.
  */
  await seedWindowOrders(SHOP_LEGACY_ROW);
  await recordSuccessfulHistoricalOrdersChunk({
    shopId: SHOP_LEGACY_ROW,
    targetStart: RETENTION_HISTORICAL_TARGET_START,
    targetEnd: WINDOW.to,
    chunkStart: "2026-08-03",
    chunkEnd: RETENTION_HISTORICAL_READY_THROUGH,
    succeededAt: "2026-09-05T04:00:00.000Z",
  });
  await recordSuccessfulRecentOrdersPass({
    shopId: SHOP_LEGACY_ROW,
    windowStart: RECENT_PROVEN_START,
    windowEnd: STORE_TODAY,
    succeededAt: SEVEN_DAY_SUCCESS_AT,
    historicalTargetStart: RECENT_PROVEN_START,
    retainSuccessfulWindow: false,
  });
  const legacyRow = await inspect(SHOP_LEGACY_ROW);
  show("M no retained bounds on the row  ", legacyRow);
  expectEqual(legacyRow.retainedSpan, null, "legacy_row_no_retained_span");
  expectEqual(legacyRow.recent?.latestSyncStatus, "succeeded", "legacy_row_status");
  expectEqual(
    legacyRow.recent?.latestSyncWindowEnd,
    legacyRow.recent?.readyThroughDate,
    "legacy_row_bounds_would_have_satisfied_the_old_pairing",
  );
  expectEqual(
    legacyRow.verdict,
    { covered: false, reason: "orders_coverage_unproven" },
    "legacy_row_is_unproven",
  );
  expectEqual(legacyRow.evidence.aovMinor, null, "legacy_row_no_unit");

  await recordSuccessfulRecentOrdersPass({
    shopId: SHOP_LEGACY_ROW,
    windowStart: RECENT_PROVEN_START,
    windowEnd: STORE_TODAY,
    succeededAt: "2026-09-05T08:58:00.000Z",
    historicalTargetStart: RECENT_PROVEN_START,
  });
  const legacyHealed = await inspect(SHOP_LEGACY_ROW);
  show("M healed by one pass            ", legacyHealed);
  expectUsableEvidence(legacyHealed, "legacy_row_healed");

  /*
    Cases N1 to N4 — DEPLOY DAY.

    Every row that already exists when the retained columns are added holds
    NULLs, and a store whose recent span is load-bearing therefore loses its
    observed AOV and its derived CPA benchmark the moment the release ships —
    the same refusal this whole change exists to remove, moved from "while a
    sync is running" to "until a sync runs". The migration closes it with one
    additive statement, and these cases drive THAT statement, imported from
    `lib/migrations.ts` rather than restated here, over the four pre-deploy
    shapes it has to tell apart.

    The rows are written through the real writer with the retained pair left
    unset, which is byte-for-byte what a database migrated before those columns
    existed holds.
  */
  async function seedPreDeployStore(input: {
    shopId: string;
    status: string;
    readyThrough?: string;
  }) {
    await seedWindowOrders(input.shopId);
    // The backfill has not walked up to the window's last day, so the recent
    // span is what carries the last three days. A store whose backfill already
    // reaches yesterday would not notice the regression at all.
    await upsertShopifySyncState({
      businessId: BUSINESS_ID,
      providerAccountId: input.shopId,
      syncTarget: "commerce_orders_historical",
      historicalTargetStart: RETENTION_HISTORICAL_TARGET_START,
      historicalTargetEnd: WINDOW.to,
      readyThroughDate: RETENTION_HISTORICAL_READY_THROUGH,
      cursorTimestamp: `${RETENTION_HISTORICAL_READY_THROUGH}T23:59:59.000Z`,
      cursorValue: RETENTION_HISTORICAL_READY_THROUGH,
      latestSuccessfulSyncAt: "2026-09-05T04:00:00.000Z",
      latestSyncStatus: "succeeded",
      latestSyncWindowStart: "2026-08-03",
      latestSyncWindowEnd: RETENTION_HISTORICAL_READY_THROUGH,
      lastError: null,
    });
    await upsertShopifySyncState({
      businessId: BUSINESS_ID,
      providerAccountId: input.shopId,
      syncTarget: "commerce_orders_recent",
      historicalTargetStart: RECENT_PROVEN_START,
      historicalTargetEnd: STORE_TODAY,
      readyThroughDate: input.readyThrough ?? STORE_TODAY,
      cursorTimestamp: `${STORE_TODAY}T23:59:59.000Z`,
      cursorValue: STORE_TODAY,
      latestSyncStartedAt: SEVEN_DAY_SUCCESS_AT,
      // Every one of these rows has a success receipt: the regression is about
      // stores that HAVE synced successfully, not stores that never have.
      latestSuccessfulSyncAt: SEVEN_DAY_SUCCESS_AT,
      latestSyncStatus: input.status,
      latestSyncWindowStart: RECENT_PROVEN_START,
      latestSyncWindowEnd: STORE_TODAY,
      lastError: null,
    });
  }

  async function readRetainedPair(shopId: string) {
    const sql = getDb();
    const rows = (await sql`
      SELECT latest_successful_sync_window_start::text AS start,
             latest_successful_sync_window_end::text AS "end"
      FROM shopify_sync_state
      WHERE business_id = ${BUSINESS_ID}
        AND provider_account_id = ${shopId}
        AND sync_target = 'commerce_orders_recent'
    `) as Array<{ start: string | null; end: string | null }>;
    const row = rows[0];
    if (!row) fail("predeploy_row_missing", shopId);
    return { start: row.start ?? null, end: row.end ?? null };
  }

  await seedPreDeployStore({ shopId: SHOP_PREDEPLOY_SUCCESS, status: "succeeded" });
  await seedPreDeployStore({ shopId: SHOP_PREDEPLOY_RUNNING, status: "running" });
  await seedPreDeployStore({
    shopId: SHOP_PREDEPLOY_FAILED,
    status: "missing_read_orders_scope",
  });
  // A success whose own window end is NOT the `ready_through_date` beside it.
  // The previous release's proof refused this pairing, so the backfill must
  // refuse it too — it may only restate what was already accepted.
  await seedPreDeployStore({
    shopId: SHOP_PREDEPLOY_END_MISMATCH,
    status: "succeeded",
    readyThrough: WINDOW.to,
  });

  const predeployBefore = await inspect(SHOP_PREDEPLOY_SUCCESS);
  show("N1 pre-deploy row, before backfill", predeployBefore);
  expectEqual(predeployBefore.retainedSpan, null, "predeploy_before_no_retained_span");
  // This IS the regression, stated as an assertion: the row the release before
  // this one served an AOV from is refused on the deploy, with nothing in
  // flight and nothing wrong with the store.
  expectEqual(
    predeployBefore.verdict,
    { covered: false, reason: "orders_coverage_unproven" },
    "predeploy_before_verdict",
  );
  expectEqual(predeployBefore.evidence.aovMinor, null, "predeploy_before_no_unit");
  expectEqual(predeployBefore.derivedCpaMinor, null, "predeploy_before_no_cpa_benchmark");

  // The shipped statement, not a restatement of it.
  await getDb().query(SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL);

  const predeployAfter = await inspect(SHOP_PREDEPLOY_SUCCESS);
  show("N1 same row, after backfill      ", predeployAfter);
  expectEqual(
    predeployAfter.retainedSpan,
    { start: RECENT_PROVEN_START, end: STORE_TODAY },
    "predeploy_after_retained_span",
  );
  expectUsableEvidence(predeployAfter, "predeploy_after");

  for (const store of [
    { shopId: SHOP_PREDEPLOY_RUNNING, label: "N2 pre-deploy, last attempt running" },
    { shopId: SHOP_PREDEPLOY_FAILED, label: "N3 pre-deploy, last attempt failed " },
    {
      shopId: SHOP_PREDEPLOY_END_MISMATCH,
      label: "N4 pre-deploy, end != ready_through",
    },
  ]) {
    const state = await inspect(store.shopId);
    show(`${store.label} (after backfill)`, state);
    // Nothing was invented for these. The backfill is not "give everyone
    // bounds"; it is "restate the proof the old code already accepted".
    expectEqual(
      await readRetainedPair(store.shopId),
      { start: null, end: null },
      `${store.shopId}_backfill_invented_nothing`,
    );
    expectEqual(state.retainedSpan, null, `${store.shopId}_no_retained_span`);
    expectEqual(
      state.verdict,
      { covered: false, reason: "orders_coverage_unproven" },
      `${store.shopId}_still_refused`,
    );
    expectEqual(state.evidence.aovMinor, null, `${store.shopId}_no_unit`);
  }

  /*
    The same statement again, which is what a re-deploy does.

    Idempotent by construction rather than by a marker: the predicate requires
    both retained columns to be NULL, so a second run matches nothing, and a
    value a real pass wrote can never be overwritten. Case H's store has bounds
    from an actual successful pass and is checked here for exactly that.
  */
  const realPassPairBefore = await readRetainedPair(SHOP_ORDINARY_REFRESH);
  await getDb().query(SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL);
  expectEqual(
    await readRetainedPair(SHOP_PREDEPLOY_SUCCESS),
    { start: RECENT_PROVEN_START, end: STORE_TODAY },
    "backfill_second_run_is_a_no_op",
  );
  expectEqual(
    await readRetainedPair(SHOP_ORDINARY_REFRESH),
    realPassPairBefore,
    "backfill_never_overwrites_a_real_pass",
  );
  expectEqual(
    await readRetainedPair(SHOP_PREDEPLOY_RUNNING),
    { start: null, end: null },
    "backfill_second_run_still_invents_nothing",
  );

  /*
    Cases O1 to O3 — what `orders_coverage_unproven` actually reports.

    Its docstring used to say the status means the store "may well be fully
    covered" and that it is "NOT what an ordinary refresh produces". Both were
    false, and these three cases are why. One store shape — a backfill that
    stopped for good nine days short of the recent span, so 2026-08-21 to
    2026-08-29 were never read by anyone and no successful pass will ever cover
    them — reported under three different in-flight conditions.

    The refusal is right in all three. The NAME changes with something that has
    no bearing on the hole, so the name must not be read as a claim about the
    store's coverage.
  */
  const HOLE_HISTORICAL_READY_THROUGH = "2026-08-20";
  async function seedHoleStore(shopId: string) {
    await seedWindowOrders(shopId);
    await recordSuccessfulHistoricalOrdersChunk({
      shopId,
      targetStart: RETENTION_HISTORICAL_TARGET_START,
      // The target ENDS where the chunk walk stopped, so this is a backfill
      // that has finished, not one still walking forward.
      targetEnd: HOLE_HISTORICAL_READY_THROUGH,
      chunkStart: "2026-08-01",
      chunkEnd: HOLE_HISTORICAL_READY_THROUGH,
      succeededAt: "2026-09-05T04:00:00.000Z",
    });
    await recordSuccessfulRecentOrdersPass({
      shopId,
      windowStart: RECENT_PROVEN_START,
      windowEnd: STORE_TODAY,
      succeededAt: SEVEN_DAY_SUCCESS_AT,
      historicalTargetStart: RECENT_PROVEN_START,
    });
  }
  for (const shopId of [SHOP_HOLE_QUIET, SHOP_HOLE_REPAIR, SHOP_HOLE_REFRESH]) {
    await seedHoleStore(shopId);
  }
  if (!(HOLE_HISTORICAL_READY_THROUGH < addIsoDays(RECENT_PROVEN_START, -1))) {
    fail(
      "hole_does_not_reproduce",
      `historical reach ${HOLE_HISTORICAL_READY_THROUGH} must stop more than a day `
      + `short of the recent span's start ${RECENT_PROVEN_START}`,
    );
  }

  const holeQuiet = await inspect(SHOP_HOLE_QUIET);
  show("O1 permanent hole, nothing in flight", holeQuiet);
  expectEqual(
    holeQuiet.verdict,
    { covered: false, reason: "orders_coverage_gap" },
    "hole_quiet_is_a_gap",
  );

  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_HOLE_REPAIR,
    windowStart: repairWindowStart,
    windowEnd: STORE_TODAY,
    status: "running",
    startedAt: REPAIR_STARTED_AT,
  });
  const holeRepair = await inspect(SHOP_HOLE_REPAIR);
  show("O2 same hole, 30-day repair running ", holeRepair);
  expectEqual(
    holeRepair.verdict,
    { covered: false, reason: "orders_coverage_unproven" },
    "hole_with_repair_is_named_unproven",
  );

  /*
    O3 — an ORDINARY recurring pass, on the next store day.

    `classifyShopifySyncWindow` ends the recent window on the store's today, so
    a routine pass that starts after midnight names a window ending one day past
    anything the last success proved. That is enough to rename the refusal, which
    is why "it is NOT what an ordinary refresh produces" was false.
  */
  await recordUnsuccessfulRecentOrdersAttempt({
    shopId: SHOP_HOLE_REFRESH,
    windowStart: addIsoDays(STORE_TODAY, -5),
    windowEnd: addIsoDays(STORE_TODAY, 1),
    status: "running",
    startedAt: "2026-09-05T08:55:00.000Z",
  });
  const holeRefresh = await inspect(SHOP_HOLE_REFRESH);
  show("O3 same hole, ordinary refresh      ", holeRefresh);
  expectEqual(
    holeRefresh.verdict,
    { covered: false, reason: "orders_coverage_unproven" },
    "hole_with_ordinary_refresh_is_named_unproven",
  );
  // And the claim the status may NOT be read as: none of the three is a store
  // that is probably covered. All nine days are still missing in all three.
  for (const state of [holeQuiet, holeRepair, holeRefresh]) {
    expectEqual(state.evidence.aovMinor, null, "hole_never_offers_a_unit");
  }

  // Currency authority follows the exact order/refund event population used
  // by ledger AOV, including a refund of an order outside the order window.
  const currencySql = getDb();
  const currencyStore = SHOP_REPAIR_FINISHED;
  const currencyOrderId = `${currencyStore}-order-0`;
  const setOrderCurrency = async (currency: string | null) => {
    await currencySql.query(
      `UPDATE shopify_sales_events SET currency_code = $3
       WHERE business_id = $1 AND provider_account_id = $2 AND event_id = $4`,
      [BUSINESS_ID, currencyStore, currency, currencyOrderId],
    );
  };
  const assertCurrency = async (status: string, label: string) => {
    const evidence = await resolveEvidenceForStore(currencyStore);
    expectEqual(evidence.status, status, label);
    if (status !== "observed") {
      expectEqual(evidence.aovMinor, null, `${label}_no_unit`);
    }
    return evidence;
  };
  await assertCurrency("observed", "currency_complete_window");
  for (const currency of [null, "   "]) {
    await setOrderCurrency(currency);
    await assertCurrency("currency_absent", `currency_missing_order_${String(currency)}`);
  }
  await setOrderCurrency("EUR");
  await assertCurrency("currency_mixed", "currency_mixed_orders");
  await setOrderCurrency(" usd ");
  await assertCurrency("observed", "currency_normalized_orders");

  const currencyEvent = async (input: {
    id: string; kind: string; day: string | null; at?: string; currency: string | null;
    store?: string;
  }) => {
    await currencySql.query(
      `INSERT INTO shopify_sales_events (
        business_id, provider_account_id, shop_id, event_id, source_kind, source_id,
        order_id, occurred_at, occurred_date_local, gross_sales, refunded_sales,
        refunded_shipping, refunded_taxes, net_revenue, currency_code
      ) VALUES ($1, $2, $2, $3, $4, $3, 'older-order-outside-window', $5::timestamptz,
                $6::date, 100, 100, 0, 0, 100, $7)`,
      [BUSINESS_ID, input.store ?? currencyStore, input.id, input.kind,
        input.at ?? `${input.day}T12:00:00Z`, input.day, input.currency],
    );
  };
  await currencyEvent({ id: "currency-carryover", kind: "refund", day: WINDOW.from, currency: null });
  await assertCurrency("currency_absent", "currency_missing_carryover_refund_at_first_day");
  await currencySql.query(
    `UPDATE shopify_sales_events SET currency_code = 'EUR'
     WHERE business_id = $1 AND provider_account_id = $2 AND event_id = 'currency-carryover'`,
    [BUSINESS_ID, currencyStore],
  );
  await assertCurrency("currency_mixed", "currency_mixed_carryover_refund");
  await currencySql.query(
    `UPDATE shopify_sales_events SET currency_code = 'USD'
     WHERE business_id = $1 AND provider_account_id = $2 AND event_id = 'currency-carryover'`,
    [BUSINESS_ID, currencyStore],
  );
  const refunded = await assertCurrency("observed", "currency_known_carryover_refund");
  expectEqual(refunded.revenueMinor, (SEEDED_ORDERS * SEEDED_ORDER_VALUE - 100) * 100,
    "currency_refund_is_in_the_actual_aov_numerator");
  for (const kind of ["adjustment", "return"]) {
    await currencyEvent({ id: `currency-irrelevant-${kind}`, kind, day: WINDOW.from, currency: null });
  }
  await currencyEvent({ id: "currency-before", kind: "refund", day: addIsoDays(WINDOW.from, -1), currency: null });
  await currencyEvent({ id: "currency-after", kind: "order", day: addIsoDays(WINDOW.to, 1), currency: null });
  await currencyEvent({ id: "currency-sibling", kind: "order", day: WINDOW.from, currency: null, store: SHOP_COVERED });
  await assertCurrency("observed", "currency_ignores_non_aov_events_other_days_and_stores");
  await currencyEvent({ id: "currency-last-local", kind: "refund", day: WINDOW.to,
    at: `${addIsoDays(WINDOW.to, 1)}T02:00:00Z`, currency: " " });
  await assertCurrency("currency_absent", "currency_includes_last_local_day_even_when_utc_is_outside");
  await currencySql.query(
    `DELETE FROM shopify_sales_events
     WHERE business_id = $1 AND provider_account_id = $2 AND event_id = 'currency-last-local'`,
    [BUSINESS_ID, currencyStore],
  );
  await currencyEvent({ id: "currency-fallback", kind: "refund", day: null,
    at: `${WINDOW.to}T12:00:00Z`, currency: null });
  await assertCurrency("currency_absent", "currency_uses_ledger_timestamp_fallback_when_local_day_is_absent");
  console.log(`[${LABEL}] currency membership PASS: 11 cases; order/refund amounts, missing/mixed currencies, exact local-day bounds and selected store`);

  console.log(
    `[${LABEL}] PASS: order coverage read from shopify_sync_state through the real `
    + "columns, a fresh returns row unreachable from the result, a short backfill "
    + "refused as a gap, a joined historical+recent span covered, a recent-only "
    + "store refused as an incomplete backfill, a seven-day success followed by a "
    + `${repairPolicy.recentWindowDays}-day running or failed repair refused as `
    + "unproven, the same repair accepted once it completed, a proven window and "
    + "its derived CPA benchmark held through an ordinary running pass, through a "
    + `failed attempt and through a ${repairPolicy.recentWindowDays}-day repair in `
    + "flight without borrowing its span, aged out honestly once the receipt "
    + "passed the freshness ceiling, and refused for a store that never succeeded "
    + "and for a row carrying no retained bounds; the shipped deploy backfill "
    + "restoring a pre-deploy row's proven span and its derived CPA benchmark "
    + "while inventing nothing for a pre-deploy row whose last attempt was "
    + "running, had failed, or ended somewhere other than its own "
    + "ready_through_date, and changing nothing on a second run; and a store with "
    + "a permanent nine-day hole named a coverage gap when nothing is in flight "
    + "and unproven the moment either a repair or an ordinary refresh is, with no "
    + "unit offered in any of the three.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
