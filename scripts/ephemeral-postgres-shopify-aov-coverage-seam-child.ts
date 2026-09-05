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
} from "@/lib/creative-decision-engine/shopify-aov-source";
import { ensureProviderAccountReferenceIds } from "@/lib/provider-account-reference-store";
import { upsertShopifySyncState } from "@/lib/shopify/sync-state";

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

const FRESH_SYNC_AT = "2026-09-05T08:30:00.000Z";
const FIVE_DAYS_OLD_SYNC_AT = "2026-08-31T08:30:00.000Z";

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

async function main() {
  await seedBusiness();
  for (const shopId of [
    SHOP_RETURNS_MASK,
    SHOP_SHORT_BACKFILL,
    SHOP_COVERED,
    SHOP_NO_HISTORICAL,
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

  console.log(
    `[${LABEL}] PASS: order coverage read from shopify_sync_state through the real `
    + "columns, a fresh returns row unreachable from the result, a short backfill "
    + "refused as a gap, a joined historical+recent span covered, and a recent-only "
    + "store refused as an incomplete backfill.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
