/**
 * Observed average order value, from the store's own orders.
 *
 * Target ROAS is the only commercial target this product requires. Everything
 * that needs a money-per-purchase unit — the loss-budget maturity floor, the
 * derived CPA benchmark — was previously reachable only through a Target CPA or
 * an operator-typed AOV assumption, so a business with a perfectly good ROAS
 * target and a connected Shopify store was told to go and type a number it
 * already had. That is what this closes: AOV is observed, never asked for.
 *
 * ## What it refuses to do
 *
 * - It never falls back to `businesses.currency`. That column is configuration;
 *   the currency of a row is a property of the row, and a benchmark denominated
 *   in a currency nobody proved is worse than no benchmark.
 * - It never claims a closed store day without the store's own time zone. The
 *   sync writes `*_date_local` from `metadata.iana_timezone`; with no zone there
 *   is no "yesterday" to end a window on, so the derivation is withheld rather
 *   than computed against a zone this module picked.
 * - It never reads zero orders as an observation. The ledger reader answers
 *   with zeros when its tables are not ready, so "no orders" and "no data" have
 *   the same shape; availability is established first, separately.
 * - It is not, on its own, authority for a hard action. It supplies a unit; the
 *   sample floor and the existing confidence ladder still decide what may be
 *   done with it.
 */
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getDb } from "@/lib/db";
import { getTodayIsoForTimeZoneServer, addDaysToIsoDateUtc } from "@/lib/provider-platform-date";
import { resolveShopifyAdminCredentials } from "@/lib/shopify/admin";
import { getShopifyRevenueLedgerAggregate } from "@/lib/shopify/revenue-ledger";

/** The contract this evidence is written under; it travels with the evidence. */
export const OBSERVED_SHOPIFY_AOV_CONTRACT = "meta.observed-shopify-aov.v1" as const;

/**
 * Closed days in the window.
 *
 * Twenty-eight, to match the 28-day ROAS window the decision engine already
 * uses. It is a window choice, not a derived optimum.
 */
export const OBSERVED_SHOPIFY_AOV_WINDOW_DAYS = 28;

/**
 * The order floor below which an observed AOV is reported but not offered as a
 * unit. Named policy, versioned with the contract above; it is not a claim that
 * thirty orders make an estimate correct.
 */
export const OBSERVED_SHOPIFY_AOV_MIN_ORDERS = 30;

/** Beyond this, the store's numbers are not a current observation. */
export const OBSERVED_SHOPIFY_AOV_MAX_SYNC_AGE_HOURS = 48;

/**
 * The sync targets that can speak for this evidence, and the two that cannot.
 *
 * `shopify_sync_state` holds four rows per store — orders and returns, each
 * recent and historical — and the freshness clock used to be
 * `MAX(latest_successful_sync_at)` across all of them. That let a returns pass
 * that finished an hour ago vouch for orders last read five days ago.
 *
 * The returns pass cannot vouch for anything this module reads. It writes only
 * `source_kind: 'return'` rows (`lib/shopify/commerce-sync.ts:588-600`), and
 * the ledger's revenue and purchase counts are built from `order`,
 * `adjustment` and `refund` rows alone (`lib/shopify/revenue-ledger.ts:92-123,
 * 234-237`), all of which are written by the orders pass
 * (`lib/shopify/commerce-sync.ts:464-551`). A returns row therefore proves
 * nothing about the numbers the average order value divides.
 */
export const OBSERVED_SHOPIFY_AOV_ORDER_SYNC_TARGETS = [
  "commerce_orders_recent",
  "commerce_orders_historical",
] as const;

export type ObservedShopifyAovStatus =
  | "observed"
  /** Enough orders were counted, but fewer than the floor. */
  | "sample_thin"
  /** The store really did record zero orders in the window. */
  | "observed_zero_orders"
  /** No connected store, or its tables are not ready. */
  | "unavailable"
  /** Connected, but the last successful sync is too old to speak for today. */
  | "stale"
  /**
   * The orders sync has never reached back as far as the window's first day,
   * so there is no complete window to average over. Distinct from `stale`: the
   * store may have synced twenty minutes ago and simply not have backfilled
   * twenty-eight days yet.
   */
  | "orders_backfill_incomplete"
  /**
   * The window's first day is covered but the covered run does not continue
   * unbroken to its last day, so the average would be taken over whichever
   * fraction of the window happens to exist.
   */
  | "orders_coverage_gap"
  /**
   * The window is not covered, AND the recent row carries an attempt over days
   * no successful pass has proven — so the missing days cannot be attributed
   * to a backfill that has not arrived or to a hole nobody is working on.
   *
   * Read it as "refused, and the reason is not settled", never as "the store is
   * probably fine". It is the same refusal as the two above with a weaker
   * claim attached, and it is reached in two quite different situations:
   *
   * - The days really are unread, and an attempt happens to be recorded over
   *   them. A store with a permanent hole in its backfill reports
   *   `orders_coverage_gap` when nothing is in flight, and this instead the
   *   moment any wider attempt is on the row — including an ordinary recurring
   *   refresh, whose window ends on the store's today and so reaches past
   *   yesterday's proven end. Verified on a real database: a store missing nine
   *   days answers `orders_coverage_gap` quiet, `orders_coverage_unproven` with
   *   a repair or a routine refresh running.
   * - The days may well be read and only the proof is missing: a row with no
   *   retained bounds whose last attempt did not finish. The next successful
   *   pass records the bounds and settles it either way.
   *
   * What this status does NOT mean is that a covered store lost its coverage
   * to a running pass. It cannot: the retained bounds outlive every
   * unsuccessful attempt, so a store the last successful pass proved stays
   * `observed` throughout a refresh and never reaches a refusal at all.
   */
  | "orders_coverage_unproven"
  /** Connected with no IANA zone, so no store day can be closed. */
  | "timezone_absent"
  /** The window's rows carry more than one currency, or none. */
  | "currency_mixed"
  | "currency_absent"
  /** The store's currency is not the ad account's; no conversion is performed. */
  | "currency_mismatch";

export interface ObservedShopifyAovEvidence {
  contract: typeof OBSERVED_SHOPIFY_AOV_CONTRACT;
  status: ObservedShopifyAovStatus;
  source: "shopify_revenue_ledger";
  /** The Shopify store this was read from — never "the business's stores". */
  providerAccountId: string | null;
  /** Gross minus refunds, which is what `averageOrderValue` divides. */
  revenueBasis: "net_ledger";
  window: { from: string; to: string } | null;
  /** The store's own IANA zone. Null means no store day could be closed. */
  zoneName: string | null;
  orderCount: number;
  currency: string | null;
  /** The exponent `aovMinor` and `revenueMinor` were minted with. */
  currencyExponent: number;
  revenueMinor: number | null;
  aovMinor: number | null;
  /** When the underlying rows were observed by the store. */
  observedAt: string | null;
  /** When this read happened. A historical replay compares against both. */
  knowledgeAsOf: string;
}

/**
 * Only `observed` supplies a unit; every other status is a stated absence.
 *
 * It is a CONTENT test, not a point-in-time test. It never reads `window`,
 * `observedAt` or `knowledgeAsOf`, so it cannot tell a caller whether this
 * evidence was knowable at some earlier cutoff — and `knowledgeAsOf` is stamped
 * from the wall clock at read time (`resolveObservedShopifyAov` below), so for
 * anything cutoff-bound the answer is routinely "no".
 *
 * Treating it as an admission gate is what broke production on 2026-09-07: the
 * native ad-profile validator gated the store spend-unit basis on this function
 * alone while the builder also compared the three clocks, the two disagreed by
 * about a second, and three accounts lost every native decision to
 * `native_target_authority_mismatch`. The native hard-decision path no longer
 * has a store-AOV basis at all. Any future cutoff-bound caller must compare the
 * clocks itself; this predicate will not do it.
 */
export function observedShopifyAovIsUsable(
  evidence: ObservedShopifyAovEvidence | null,
): evidence is ObservedShopifyAovEvidence & { aovMinor: number; currency: string } {
  return (
    evidence !== null &&
    evidence.status === "observed" &&
    typeof evidence.aovMinor === "number" &&
    evidence.aovMinor > 0 &&
    typeof evidence.currency === "string"
  );
}

function withheld(
  status: ObservedShopifyAovStatus,
  partial: Partial<ObservedShopifyAovEvidence>,
  knowledgeAsOf: string,
): ObservedShopifyAovEvidence {
  return {
    contract: OBSERVED_SHOPIFY_AOV_CONTRACT,
    status,
    source: "shopify_revenue_ledger",
    providerAccountId: null,
    revenueBasis: "net_ledger",
    window: null,
    zoneName: null,
    orderCount: 0,
    currency: null,
    currencyExponent: 2,
    revenueMinor: null,
    aovMinor: null,
    observedAt: null,
    knowledgeAsOf,
    ...partial,
  };
}

/**
 * The currencies carried by the rows that supply the ledger AOV.
 *
 * Read rather than assumed: a business setting cannot prove what a Shopify
 * order was denominated in, and a mixed window cannot produce one benchmark.
 */
async function readWindowCurrencies(input: {
  businessId: string;
  providerAccountId: string;
  from: string;
  to: string;
}): Promise<string[] | null> {
  const sql = getDb();
  try {
    /*
      Bound to the SELECTED store.

      Match the ledger's numerator and denominator: order gross sales minus
      refunds, by EVENT day. A refund of an older order still contributes in
      this window. Adjustment/return rows do not contribute to ledger AOV.
      The selected business/store and local-day fallback match that aggregate.
      Missing currencies must remain visible; discarding one would label its
      amount with the currency of a different row.
    */
    const rows = (await sql`
      SELECT DISTINCT UPPER(BTRIM(currency_code)) AS currency
      FROM shopify_sales_events
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND COALESCE(occurred_date_local, occurred_at::date)
              BETWEEN ${input.from}::date AND ${input.to}::date
        AND source_kind IN ('order', 'refund')
    `) as Array<{ currency: string | null }>;
    if (rows.some((row) => typeof row.currency !== "string" || row.currency.length === 0)) {
      return null;
    }
    return rows.map((row) => row.currency as string);
  } catch {
    return null;
  }
}

/**
 * The most recent order this store recorded inside the window.
 *
 * This is a fact about SALES, not about syncing, and conflating the two was
 * the defect: a store synced an hour ago with forty orders in the window but
 * none in the last three days is perfectly current, and reading its newest
 * sale as its sync clock reported it stale. It is kept because it is the
 * honest `observedAt` for the evidence — when the newest fact in the window
 * happened — and it no longer decides freshness.
 */
async function readObservedAt(input: {
  businessId: string;
  providerAccountId: string;
  from: string;
  to: string;
}): Promise<string | null> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT MAX(order_created_at) AS observed_at
      FROM shopify_orders
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND COALESCE(order_created_date_local, order_created_at::date)
              BETWEEN ${input.from}::date AND ${input.to}::date
    `) as Array<{ observed_at: string | Date | null }>;
    const value = rows[0]?.observed_at ?? null;
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  } catch {
    return null;
  }
}

/**
 * The statuses `upsertShopifySyncState` records for a pass that FINISHED.
 *
 * Deny by default, and an allowlist rather than a list of failures, because
 * the recent-orders failure path writes the failure reason itself as the
 * status (`lib/sync/shopify-sync.ts:527-535`) — `missing_read_orders_scope`,
 * whatever the provider said — so the set of non-success values is open-ended
 * and a denylist would let the next new reason through as a success.
 *
 * `succeeded` is what the recent pass writes (`shopify-sync.ts:898`);
 * historical chunks write `ready` once they reach the target end and
 * `succeeded` before that (`:763`, `:788`).
 *
 * NOTHING IN THIS MODULE READS IT ANY MORE. Coverage used to be inferred from
 * the row's recorded status; it is now read from the retained success bounds
 * below, which the success paths write themselves, and the refusal is named by
 * comparing window bounds rather than by inspecting a status. This is kept as
 * the named definition of "a status that means the pass finished", which is
 * still what `lib/sync/shopify-sync.ts` writes.
 *
 * The one place that list is still load-bearing spells it out rather than
 * importing it: `SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL` in
 * `lib/migrations.ts`, deliberately, because a migration must keep meaning what
 * it meant on the day it ran even if this array later grows a value.
 */
export const OBSERVED_SHOPIFY_AOV_SUCCESSFUL_SYNC_STATUSES = [
  "succeeded",
  "ready",
] as const;

/** What one order sync target has recorded about itself. */
export interface ShopifyOrderSyncTargetState {
  latestSuccessfulSyncAt: string | null;
  /**
   * The window the last recorded ATTEMPT names. Written before any work
   * happens and again on failure, so it describes intent, not coverage.
   */
  latestSyncWindowStart: string | null;
  latestSyncWindowEnd: string | null;
  /**
   * The window the last SUCCESSFUL pass actually read, retained through every
   * unsuccessful attempt (`lib/shopify/sync-state.ts` ON CONFLICT block).
   *
   * Both NULL is "not proven", never coverage. A row that predates these
   * columns is NOT automatically in that state: the migration that adds them
   * also backfills the pair on every row whose last recorded attempt finished
   * over a window ending on its own `ready_through_date`
   * (`SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL`), which is the same
   * pairing the release before this one accepted as proof. What is left NULL
   * is a row that has never had a successful pass, or a pre-deploy row whose
   * last attempt was still running or had failed.
   */
  latestSuccessfulSyncWindowStart: string | null;
  latestSuccessfulSyncWindowEnd: string | null;
  readyThroughDate: string | null;
  historicalTargetStart: string | null;
  /**
   * The outcome of the LAST attempt recorded on this row, which is not
   * necessarily the attempt that wrote the success-only columns beside it.
   */
  latestSyncStatus: string | null;
}

/**
 * The two order targets, each in its own slot.
 *
 * Shaped this way so a returns row has nowhere to go. The old clock summed
 * `MAX(latest_successful_sync_at)` over an unfiltered `sync_target`, so a
 * returns pass could answer a question about orders; here the defect is not
 * merely unwritten, it is unrepresentable.
 */
export interface ShopifyOrderSyncCoverage {
  recent: ShopifyOrderSyncTargetState | null;
  historical: ShopifyOrderSyncTargetState | null;
}

/*
  DATE columns arrive as a `Date` at LOCAL midnight or as text depending on the
  driver path, and reading local midnight with UTC components moves the day
  backwards in every negative-offset zone. This mirrors `normalizeDate` in
  `lib/shopify/sync-state.ts:10-23`, which is what wrote the column, so the
  reader and the writer agree on which day a row names.
*/
function normalizeSyncStateDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function normalizeSyncStateTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * What the ORDER sync has actually covered for this store.
 *
 * The real freshness evidence, from the state the sync itself writes.
 * `latest_successful_sync_at` is a statement about our own pipeline; the
 * newest order is a statement about the merchant's customers. Only the first
 * can say whether the window we are about to read is complete — and only when
 * it is read from the targets that write the rows being read.
 *
 * A missing row, or a `latestSuccessfulSyncAt` of `null`, means no successful
 * orders sync is recorded, which is `unavailable` rather than `stale` — we have
 * not looked successfully, as distinct from having looked and found old data.
 */
export async function readOrderSyncCoverage(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<ShopifyOrderSyncCoverage | null> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT sync_target,
             latest_successful_sync_at,
             latest_sync_window_start,
             latest_sync_window_end,
             latest_successful_sync_window_start,
             latest_successful_sync_window_end,
             latest_sync_status,
             ready_through_date,
             historical_target_start
      FROM shopify_sync_state
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND sync_target IN (
          ${OBSERVED_SHOPIFY_AOV_ORDER_SYNC_TARGETS[0]},
          ${OBSERVED_SHOPIFY_AOV_ORDER_SYNC_TARGETS[1]}
        )
    `) as Array<{
      sync_target: string | null;
      latest_successful_sync_at: string | Date | null;
      latest_sync_window_start: string | Date | null;
      latest_sync_window_end: string | Date | null;
      latest_successful_sync_window_start: string | Date | null;
      latest_successful_sync_window_end: string | Date | null;
      latest_sync_status: string | null;
      ready_through_date: string | Date | null;
      historical_target_start: string | Date | null;
    }>;
    const coverage: ShopifyOrderSyncCoverage = { recent: null, historical: null };
    for (const row of rows) {
      const state: ShopifyOrderSyncTargetState = {
        latestSuccessfulSyncAt: normalizeSyncStateTimestamp(row.latest_successful_sync_at),
        latestSyncWindowStart: normalizeSyncStateDate(row.latest_sync_window_start),
        latestSyncWindowEnd: normalizeSyncStateDate(row.latest_sync_window_end),
        latestSuccessfulSyncWindowStart: normalizeSyncStateDate(
          row.latest_successful_sync_window_start,
        ),
        latestSuccessfulSyncWindowEnd: normalizeSyncStateDate(
          row.latest_successful_sync_window_end,
        ),
        latestSyncStatus:
          typeof row.latest_sync_status === "string" && row.latest_sync_status.trim()
            ? row.latest_sync_status.trim()
            : null,
        readyThroughDate: normalizeSyncStateDate(row.ready_through_date),
        historicalTargetStart: normalizeSyncStateDate(row.historical_target_start),
      };
      if (row.sync_target === "commerce_orders_recent") coverage.recent = state;
      if (row.sync_target === "commerce_orders_historical") coverage.historical = state;
    }
    return coverage;
  } catch {
    return null;
  }
}

export type ShopifyOrderWindowCoverageVerdict =
  | { covered: true }
  | {
      covered: false;
      reason:
        | "orders_backfill_incomplete"
        | "orders_coverage_gap"
        | "orders_coverage_unproven";
    };

/**
 * The days a SUCCESSFUL recent pass actually read, as that pass recorded them.
 *
 * Both halves come from `latest_successful_sync_window_start`/`_end`, which
 * only the success paths write (`lib/sync/shopify-sync.ts:887-916` for recent,
 * `:752-780`/`:781-806` for historical) and which the upsert COALESCE-preserves
 * through every unsuccessful attempt (`lib/shopify/sync-state.ts` ON CONFLICT).
 * That is the whole point: a start and an end that were established together,
 * by one pass that finished, and that no later attempt can move.
 *
 * What this replaces, and why the replacement is not weaker:
 *
 * `latest_sync_window_start` is written by running, cancelled and failed
 * attempts as well as successful ones (`shopify-sync.ts:388`, `:415`, `:532`,
 * `:1089`). The proof used to pair that start with the success-only
 * `ready_through_date`, and guarded the pairing by requiring the last recorded
 * status to be a success and its end to equal `ready_through_date`. Both
 * guards were necessary, because webhook repair expands the recent window
 * BACKWARD to reach an old order, up to thirty days
 * (`lib/shopify/webhooks.ts:183-191`) — a seven-day success followed by a
 * thirty-day repair leaves a thirty-day start beside a seven-day receipt.
 *
 * The guards worked and cost too much: an ORDINARY recurring pass writes
 * `running` before it does anything, so every store lost its proven window for
 * the duration of a routine refresh, and with it the derived CPA benchmark and
 * every sizing decision that needs a money-per-purchase unit. Retaining the
 * successful bounds removes the need to infer anything from an attempt: the
 * expanded repair's window is not read at all, so it cannot be borrowed
 * whether it is running, failed or finished.
 *
 * A NULL bound is not proven. It is never read as coverage, and the next
 * successful pass records the proof.
 *
 * Rows written before these columns existed are not left in that state by the
 * deploy. The migration that adds the columns backfills the pair from
 * `latest_sync_window_start` and `ready_through_date` on exactly the rows the
 * previous release's proof already accepted — last attempt a success, its own
 * end equal to that `ready_through_date`
 * (`SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL`). Had it not, every
 * already-synced store whose recent span is load-bearing would have lost its
 * observed AOV on the deploy and kept it lost until its next successful pass,
 * which is the same refusal this change exists to remove. A pre-deploy row
 * whose last attempt was running or failed is backfilled with nothing and is
 * refused exactly as the previous release refused it.
 */
export function resolveRetainedRecentOrderSpan(
  state: ShopifyOrderSyncTargetState | null,
): { start: string; end: string } | null {
  const start = state?.latestSuccessfulSyncWindowStart ?? null;
  const end = state?.latestSuccessfulSyncWindowEnd ?? null;
  // The receipt is required too. The bounds and `latest_successful_sync_at` are
  // written by the same upsert, so bounds without a receipt are not a shape any
  // success path produces.
  if (!start || !end || !state?.latestSuccessfulSyncAt) return null;
  if (start > end) return null;
  return { start, end };
}

/**
 * Whether the recent row is describing days it cannot prove it read.
 *
 * This only RENAMES a refusal; it can never turn a refusal into coverage, and
 * on a covered store it is never consulted at all. Two shapes qualify:
 *
 * - An attempt is recorded whose window reaches outside the retained proven
 *   span. The expanded webhook repair is the case this was written for, but an
 *   ordinary recurring pass qualifies too, because its window ends on the
 *   store's today while the last success proved only through yesterday. The
 *   attempt's own window is not evidence either way; it is a reason to stop
 *   short of `orders_backfill_incomplete` or `orders_coverage_gap`, both of
 *   which assert something definite about days nobody is currently reading.
 * - A row with no retained bounds at all, which still carries a
 *   `ready_through_date` or a success receipt. On a database migrated by
 *   `SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL` this is a row whose last
 *   recorded attempt did not finish, or finished over a window whose end is not
 *   the `ready_through_date` beside it — the backfill deliberately invents
 *   nothing for either. The next successful pass records the bounds.
 *
 * Neither shape is a claim that the store is probably covered. A store with a
 * permanent hole in its backfill lands in the first one for as long as any
 * wider attempt sits on the row, and the hole is still a hole.
 */
function recentCoverageIsUnproven(state: ShopifyOrderSyncTargetState | null): boolean {
  if (!state) return false;
  const retained = resolveRetainedRecentOrderSpan(state);
  const attemptStart = state.latestSyncWindowStart;
  const attemptEnd = state.latestSyncWindowEnd ?? state.readyThroughDate;
  if (!attemptStart || !attemptEnd) return false;
  if (!retained) {
    return Boolean(state.readyThroughDate || state.latestSuccessfulSyncAt);
  }
  return attemptStart < retained.start || attemptEnd > retained.end;
}

/**
 * Whether the orders sync has covered every day of the window, unbroken.
 *
 * The defect this closes: nothing checked that the window being averaged was
 * a window we had actually read. A store with a seven-day recent pass and a
 * backfill that had only reached back two hundred days produced an average
 * over whatever fraction of the twenty-eight days happened to exist, labelled
 * it a twenty-eight day observation, and counted the partial order count
 * against the thirty-order floor.
 *
 * The proof reads ONLY the windows the sync recorded — never whether order
 * rows exist on a given day. That is deliberate and load-bearing: a store that
 * is fully synced and simply sold nothing for a week is covered, which is the
 * case the freshness fix was originally for, and a day-presence proof would
 * re-break it.
 *
 * Which columns may bound a span:
 *
 * - Only success-only columns may bound a span: `ready_through_date` and the
 *   retained `latest_successful_sync_window_*` pair. `latest_sync_window_end`
 *   is written by running, cancelled and failed attempts too
 *   (`lib/sync/shopify-sync.ts:389`, `:416`, `:533`, `:1090`) and so would let
 *   an attempt that never finished claim coverage.
 * - The historical span starts at `historical_target_start`, and the chunk
 *   walk (`computeHistoricalChunk`, `shopify-sync.ts:135-147`) only ever moves
 *   forward from it, so `[historical_target_start, ready_through_date]` is one
 *   unbroken run.
 * - The recent span is the RETAINED successful window
 *   (`resolveRetainedRecentOrderSpan`), never the window of the attempt
 *   currently on the row. An ordinary pass overwrites `latest_sync_window_*`
 *   with `running` before it does any work, and a webhook repair overwrites it
 *   with a window expanded backward by up to thirty days; neither is evidence,
 *   and neither now erases the evidence an earlier pass left.
 * - The recent row's own `historical_target_start` is NOT a span start: it is
 *   COALESCE-frozen to the first recent run there ever was
 *   (`lib/shopify/sync-state.ts:237`) and says nothing about continuity since.
 *
 * The refusal is therefore as narrow as the evidence requires. A store whose
 * last successful pass proved the window keeps it through a refresh, through a
 * failure and through an expanded repair — and loses it only when the proof
 * itself ages out of the freshness ceiling, which is a different absence with
 * a different name (`stale`). Rows that existed before the retained columns
 * were added keep it too, through the one-time backfill in the migration that
 * adds them (`SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL`); without it
 * this narrowing would have cost every already-synced store its AOV on the
 * deploy.
 *
 * Narrow refers to WHETHER it refuses, not to the name it gives the refusal.
 * `recentCoverageIsUnproven` below renames a refusal that stands on its own
 * evidence, and it can rename one that is entirely deserved.
 */
export function proveShopifyOrderWindowCovered(input: {
  window: { from: string; to: string };
  coverage: ShopifyOrderSyncCoverage;
}): ShopifyOrderWindowCoverageVerdict {
  const spans: Array<{ start: string; end: string }> = [];
  const historical = input.coverage.historical;
  if (historical?.historicalTargetStart && historical.readyThroughDate) {
    spans.push({
      start: historical.historicalTargetStart,
      end: historical.readyThroughDate,
    });
  }
  const recent = input.coverage.recent;
  const retainedRecentSpan = resolveRetainedRecentOrderSpan(recent);
  if (retainedRecentSpan) {
    spans.push(retainedRecentSpan);
  }

  /*
    Rename the refusal when the recent row is describing days it cannot prove
    it read. This changes the NAME only; the refusal below stands either way.

    `orders_backfill_incomplete` and `orders_coverage_gap` each assert
    something definite — a backfill that has not arrived, days nobody read —
    and an attempt recorded over unproven days is a reason not to assert
    either yet. It is NOT a finding that the days are probably fine: a store
    with a genuine permanent hole is renamed too, for as long as any wider
    attempt sits on its row, and the hole is unchanged. What the rename buys is
    honesty about which of the two definite statements we are entitled to.
  */
  const recentSpanWithheld = recentCoverageIsUnproven(recent);
  const refuse = (
    reason: "orders_backfill_incomplete" | "orders_coverage_gap",
  ): ShopifyOrderWindowCoverageVerdict => ({
    covered: false,
    reason: recentSpanWithheld ? "orders_coverage_unproven" : reason,
  });

  // ISO dates compare lexicographically, so no parsing is needed to order them.
  const usable = spans
    .filter((span) => span.start <= span.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const earliest = usable[0];
  if (!earliest || earliest.start > input.window.from) {
    // Never reached back this far. Not a gap in the middle and not an aged
    // sync — a backfill that has not arrived yet.
    return refuse("orders_backfill_incomplete");
  }

  let reach = earliest.end;
  for (const span of usable.slice(1)) {
    if (reach >= input.window.to) break;
    // Adjacent days are contiguous; a span starting two days after the current
    // reach leaves a day nobody read.
    if (span.start > addDaysToIsoDateUtc(reach, 1)) {
      return refuse("orders_coverage_gap");
    }
    if (span.end > reach) reach = span.end;
  }
  if (reach < input.window.to) {
    return refuse("orders_coverage_gap");
  }
  return { covered: true };
}

export interface ResolveObservedShopifyAovInput {
  businessId: string;
  /**
   * The ad account's currency. A benchmark in another currency is not a
   * benchmark for this account, and no conversion is performed.
   */
  accountCurrency: string | null;
  /** Minor-unit exponent for that currency, from the ISO registry. */
  currencyExponent: number | null;
  now?: Date;
  /** Injectable for tests; production uses the real readers. */
  deps?: {
    resolveCredentials?: typeof resolveShopifyAdminCredentials;
    readAggregate?: typeof getShopifyRevenueLedgerAggregate;
    readCurrencies?: typeof readWindowCurrencies;
    readObservedAt?: typeof readObservedAt;
    /** What the ORDER sync has covered. The real freshness evidence. */
    readOrderSyncCoverage?: typeof readOrderSyncCoverage;
    schemaReady?: () => Promise<boolean>;
  };
}

export async function resolveObservedShopifyAov(
  input: ResolveObservedShopifyAovInput,
): Promise<ObservedShopifyAovEvidence> {
  const now = input.now ?? new Date();
  const knowledgeAsOf = now.toISOString();
  const deps = input.deps ?? {};
  const resolveCredentials = deps.resolveCredentials ?? resolveShopifyAdminCredentials;
  const readAggregate = deps.readAggregate ?? getShopifyRevenueLedgerAggregate;
  const readCurrencies = deps.readCurrencies ?? readWindowCurrencies;
  const readWindowObservedAt = deps.readObservedAt ?? readObservedAt;
  const readCoverage = deps.readOrderSyncCoverage ?? readOrderSyncCoverage;
  const schemaReady =
    deps.schemaReady ??
    (async () =>
      Boolean(
        (
          await getDbSchemaReadiness({
            /*
              Every table this evidence actually depends on, not just the two it
              names directly.

              `shopify_order_transactions` is in the aggregate's own readiness
              gate (`lib/shopify/revenue-ledger.ts:56-58`), and when it is
              missing that reader answers with zeros rather than refusing
              (`:60-85`). A store missing only that table therefore passed this
              availability gate, came back with `purchases: 0`, and was reported
              as having sold nothing — the exact "no data becomes no sales"
              confusion this module's header forbids.

              `shopify_sync_state` is load-bearing now that coverage is read
              from it, so its absence must be named `unavailable` here rather
              than swallowed by the reader's fail-closed catch and mistaken for
              a store that never synced.
            */
            tables: [
              "shopify_orders",
              "shopify_sales_events",
              "shopify_order_transactions",
              "shopify_sync_state",
            ],
          }).catch(() => null)
        )?.ready,
      ));

  // Availability first, and separately. The ledger reader answers with zeros
  // when its tables are missing, so asking it "how many orders" before knowing
  // whether it can answer at all is how "no data" becomes "no sales".
  if (!(await schemaReady())) {
    return withheld("unavailable", {}, knowledgeAsOf);
  }

  const credentials = await resolveCredentials(input.businessId).catch(() => null);
  if (!credentials?.shopId) {
    return withheld("unavailable", {}, knowledgeAsOf);
  }
  const providerAccountId = credentials.shopId;

  const zoneName =
    typeof credentials.metadata?.iana_timezone === "string" &&
    credentials.metadata.iana_timezone.trim()
      ? credentials.metadata.iana_timezone.trim()
      : null;
  if (!zoneName) {
    // No zone, no store day. Computing "yesterday" in a zone this module chose
    // would be an invented cutoff wearing the store's name.
    return withheld("timezone_absent", { providerAccountId }, knowledgeAsOf);
  }

  let storeToday: string;
  try {
    storeToday = getTodayIsoForTimeZoneServer(zoneName, now);
  } catch {
    return withheld("timezone_absent", { providerAccountId, zoneName }, knowledgeAsOf);
  }
  const to = addDaysToIsoDateUtc(storeToday, -1);
  const from = addDaysToIsoDateUtc(to, -(OBSERVED_SHOPIFY_AOV_WINDOW_DAYS - 1));
  const window = { from, to };

  const aggregate = await readAggregate({
    businessId: input.businessId,
    providerAccountId,
    startDate: from,
    endDate: to,
  }).catch(() => null);
  if (!aggregate) {
    return withheld("unavailable", { providerAccountId, zoneName, window }, knowledgeAsOf);
  }

  const orderCount = Number(aggregate.purchases ?? 0);
  const observedAt = await readWindowObservedAt({
    businessId: input.businessId,
    providerAccountId,
    from,
    to,
  });

  const base = {
    providerAccountId,
    zoneName,
    window,
    orderCount: Number.isFinite(orderCount) ? orderCount : 0,
    observedAt,
  };

  /*
    Freshness is a fact about OUR sync, not about the merchant's last sale.

    Reading `MAX(order_created_at)` as a sync clock reported a store that
    synced an hour ago as stale whenever it happened not to have sold anything
    for two days — which is an ordinary week for plenty of shops, and exactly
    the case where a 28-day average order value is still perfectly good
    evidence.

    Two distinct absences: no successful sync recorded at all is `unavailable`
    (we have not looked successfully), and a successful sync too long ago is
    `stale` (we looked, and what we hold has aged).

    The clock is `commerce_orders_recent` and nothing else. It is the
    `updated_at`-driven pass (`lib/sync/shopify-sync.ts:449`), so it is also the
    only mechanism by which a refund settled today against an old order
    re-enters the window we are about to average. A historical chunk finishing,
    or either returns pass finishing, says nothing about that.
  */
  const coverage = await readCoverage({
    businessId: input.businessId,
    providerAccountId,
  });
  if (!coverage?.recent?.latestSuccessfulSyncAt) {
    return withheld("unavailable", base, knowledgeAsOf);
  }
  const syncAgeHours =
    (now.getTime() - new Date(coverage.recent.latestSuccessfulSyncAt).getTime()) / 3_600_000;
  if (
    !Number.isFinite(syncAgeHours)
    || syncAgeHours > OBSERVED_SHOPIFY_AOV_MAX_SYNC_AGE_HOURS
  ) {
    return withheld("stale", base, knowledgeAsOf);
  }

  /*
    A current sync is not a complete window.

    Freshness says when we last read; coverage says how far back that reading
    ever reached. Averaging twenty-eight days we only hold nineteen of is a
    number about nineteen days wearing a twenty-eight day label, so an
    unproven window is refused by name instead.
  */
  const coverageVerdict = proveShopifyOrderWindowCovered({ window, coverage });
  if (!coverageVerdict.covered) {
    return withheld(coverageVerdict.reason, base, knowledgeAsOf);
  }

  if (base.orderCount <= 0) {
    // Reached only after availability AND coverage were established, so this
    // really is the store saying it sold nothing rather than the product
    // failing to look, or looking at a window it never read. An uncovered
    // window reports few or no orders too, and calling that
    // `observed_zero_orders` is the same confusion in a different costume.
    return withheld("observed_zero_orders", base, knowledgeAsOf);
  }

  const currencies = await readCurrencies({
    businessId: input.businessId, providerAccountId, from, to,
  });
  if (currencies === null || currencies.length === 0) {
    return withheld("currency_absent", base, knowledgeAsOf);
  }
  if (currencies.length > 1) {
    return withheld("currency_mixed", base, knowledgeAsOf);
  }
  const currency = currencies[0];
  const accountCurrency = input.accountCurrency?.trim().toUpperCase() || null;
  if (!accountCurrency || accountCurrency !== currency) {
    // No conversion. A rate this product does not hold is not evidence.
    return withheld("currency_mismatch", { ...base, currency }, knowledgeAsOf);
  }

  const aov = Number(aggregate.averageOrderValue ?? Number.NaN);
  const revenue = Number(aggregate.revenue ?? Number.NaN);
  if (!Number.isFinite(aov) || aov <= 0) {
    return withheld("observed_zero_orders", { ...base, currency }, knowledgeAsOf);
  }

  const exponent =
    Number.isSafeInteger(input.currencyExponent) && (input.currencyExponent as number) >= 0
      ? (input.currencyExponent as number)
      : 2;
  const factor = 10 ** exponent;
  const aovMinor = Math.round(aov * factor);
  const revenueMinor = Number.isFinite(revenue) ? Math.round(revenue * factor) : null;

  const status: ObservedShopifyAovStatus =
    base.orderCount >= OBSERVED_SHOPIFY_AOV_MIN_ORDERS ? "observed" : "sample_thin";

  return {
    contract: OBSERVED_SHOPIFY_AOV_CONTRACT,
    status,
    source: "shopify_revenue_ledger",
    revenueBasis: "net_ledger",
    currency,
    currencyExponent: exponent,
    aovMinor,
    revenueMinor,
    knowledgeAsOf,
    ...base,
  };
}
