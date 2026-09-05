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

/** Only `observed` supplies a unit; every other status is a stated absence. */
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
 * The currencies the window's own rows carry.
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

      The revenue this evidence is built from is read for one provider account;
      scoping the currency by business alone let a second store's orders decide
      whether this one's window was "mixed". Two stores in two currencies is a
      perfectly ordinary arrangement and it is not a defect in either.
    */
    const rows = (await sql`
      SELECT DISTINCT UPPER(BTRIM(currency_code)) AS currency
      FROM shopify_orders
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND COALESCE(order_created_date_local, order_created_at::date)
              BETWEEN ${input.from}::date AND ${input.to}::date
        AND currency_code IS NOT NULL
        AND BTRIM(currency_code) <> ''
    `) as Array<{ currency: string | null }>;
    return rows
      .map((row) => row.currency)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
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
 * When this store last completed a successful sync.
 *
 * The real freshness evidence, from the state the sync itself writes.
 * `latest_successful_sync_at` is a statement about our own pipeline; the
 * newest order is a statement about the merchant's customers. Only the first
 * can say whether the window we are about to read is complete.
 *
 * `null` means no successful sync is recorded for this store, which is
 * `unavailable` rather than `stale` — we have not looked successfully, as
 * distinct from having looked and found old data.
 */
async function readLastSuccessfulSyncAt(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<string | null> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT MAX(latest_successful_sync_at) AS synced_at
      FROM shopify_sync_state
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
    `) as Array<{ synced_at: string | Date | null }>;
    const value = rows[0]?.synced_at ?? null;
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  } catch {
    return null;
  }
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
    /** When this store last completed a sync. The real freshness evidence. */
    readSyncedAt?: typeof readLastSuccessfulSyncAt;
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
  const readSyncedAt = deps.readSyncedAt ?? readLastSuccessfulSyncAt;
  const schemaReady =
    deps.schemaReady ??
    (async () =>
      Boolean(
        (
          await getDbSchemaReadiness({
            tables: ["shopify_orders", "shopify_sales_events"],
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
  */
  const lastSyncedAt = await readSyncedAt({
    businessId: input.businessId,
    providerAccountId,
  });
  if (!lastSyncedAt) return withheld("unavailable", base, knowledgeAsOf);
  const syncAgeHours = (now.getTime() - new Date(lastSyncedAt).getTime()) / 3_600_000;
  if (
    !Number.isFinite(syncAgeHours)
    || syncAgeHours > OBSERVED_SHOPIFY_AOV_MAX_SYNC_AGE_HOURS
  ) {
    return withheld("stale", base, knowledgeAsOf);
  }

  if (base.orderCount <= 0) {
    // Reached only after availability was established, so this really is the
    // store saying it sold nothing rather than the product failing to look.
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
