import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

function normalizeEventType(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function isOneOf(value: string, allowed: string[]) {
  return allowed.includes(value);
}

export function classifyShopifyCustomerEventType(value: string | null | undefined) {
  const normalized = normalizeEventType(value);
  if (isOneOf(normalized, ["page_viewed", "page_view", "pageview"])) return "page_view";
  if (isOneOf(normalized, ["product_viewed", "product_view", "view_item"])) return "product_view";
  if (isOneOf(normalized, ["add_to_cart", "addtocart"])) return "add_to_cart";
  if (isOneOf(normalized, ["begin_checkout", "checkout_started"])) return "begin_checkout";
  if (isOneOf(normalized, ["purchase", "checkout_completed"])) return "purchase";
  return "other";
}

export interface ShopifyCustomerEventsDailyAggregate {
  date: string;
  sessions: number;
  sessionlessEvents: number;
  pageViews: number;
  productViews: number;
  addToCart: number;
  beginCheckout: number;
  purchases: number;
  productViewSessions: number;
  addToCartSessions: number;
  beginCheckoutSessions: number;
  purchaseSessions: number;
  productViewRate: number | null;
  addToCartRate: number | null;
  checkoutRate: number | null;
  checkoutCompletionRate: number | null;
  conversionRate: number | null;
}

export interface ShopifyCustomerEventsAggregate {
  sessions: number;
  sessionlessEvents: number;
  pageViews: number;
  productViews: number;
  addToCart: number;
  beginCheckout: number;
  purchases: number;
  productViewSessions: number;
  addToCartSessions: number;
  beginCheckoutSessions: number;
  purchaseSessions: number;
  productViewRate: number | null;
  addToCartRate: number | null;
  checkoutRate: number | null;
  checkoutCompletionRate: number | null;
  conversionRate: number | null;
  daily: ShopifyCustomerEventsDailyAggregate[];
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toRate(numerator: number, denominator: number) {
  if (denominator <= 0) return null;
  return Math.round((((numerator / denominator) * 100) + Number.EPSILON) * 100) / 100;
}

export async function getShopifyCustomerEventsAggregate(input: {
  businessId: string;
  providerAccountId?: string | null;
  timeZone?: string | null;
  startDate: string;
  endDate: string;
}) {
  const readiness = await getDbSchemaReadiness({
    tables: ["shopify_customer_events"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return {
      sessions: 0,
      sessionlessEvents: 0,
      pageViews: 0,
      productViews: 0,
      addToCart: 0,
      beginCheckout: 0,
      purchases: 0,
      productViewSessions: 0,
      addToCartSessions: 0,
      beginCheckoutSessions: 0,
      purchaseSessions: 0,
      productViewRate: null,
      addToCartRate: null,
      checkoutRate: null,
      checkoutCompletionRate: null,
      conversionRate: null,
      daily: [],
    } satisfies ShopifyCustomerEventsAggregate;
  }
  const sql = getDb();
  const timeZone = input.timeZone?.trim() || "UTC";
  const rows = (await sql`
    SELECT
      (occurred_at AT TIME ZONE ${timeZone})::date::text AS date,
      COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL AND session_id <> '') AS sessions,
      COUNT(*) FILTER (WHERE session_id IS NULL OR session_id = '') AS sessionless_events,
      COUNT(*) FILTER (
        WHERE lower(event_type) IN ('page_viewed', 'page_view', 'pageview')
      ) AS page_views,
      COUNT(*) FILTER (
        WHERE lower(event_type) IN ('product_viewed', 'product_view', 'view_item')
      ) AS product_views,
      COUNT(*) FILTER (
        WHERE lower(event_type) IN ('add_to_cart', 'addtocart')
      ) AS add_to_cart,
      COUNT(*) FILTER (
        WHERE lower(event_type) IN ('begin_checkout', 'checkout_started')
      ) AS begin_checkout,
      COUNT(*) FILTER (
        WHERE lower(event_type) IN ('purchase', 'checkout_completed')
      ) AS purchases
      ,
      COUNT(DISTINCT session_id) FILTER (
        WHERE session_id IS NOT NULL AND session_id <> ''
          AND lower(event_type) IN ('product_viewed', 'product_view', 'view_item')
      ) AS product_view_sessions,
      COUNT(DISTINCT session_id) FILTER (
        WHERE session_id IS NOT NULL AND session_id <> ''
          AND lower(event_type) IN ('add_to_cart', 'addtocart')
      ) AS add_to_cart_sessions,
      COUNT(DISTINCT session_id) FILTER (
        WHERE session_id IS NOT NULL AND session_id <> ''
          AND lower(event_type) IN ('begin_checkout', 'checkout_started')
      ) AS begin_checkout_sessions,
      COUNT(DISTINCT session_id) FILTER (
        WHERE session_id IS NOT NULL AND session_id <> ''
          AND lower(event_type) IN ('purchase', 'checkout_completed')
      ) AS purchase_sessions
    FROM shopify_customer_events
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
      AND (occurred_at AT TIME ZONE ${timeZone})::date >= ${input.startDate}::date
      AND (occurred_at AT TIME ZONE ${timeZone})::date <= ${input.endDate}::date
    GROUP BY 1
    ORDER BY 1 ASC
  `) as Array<Record<string, unknown>>;

  const daily = rows.map((row) => {
    const sessions = Math.trunc(toNumber(row.sessions));
    const productViewSessions = Math.trunc(toNumber(row.product_view_sessions));
    const addToCartSessions = Math.trunc(toNumber(row.add_to_cart_sessions));
    const beginCheckoutSessions = Math.trunc(toNumber(row.begin_checkout_sessions));
    const purchaseSessions = Math.trunc(toNumber(row.purchase_sessions));

    return {
      date: String(row.date ?? ""),
      sessions,
      sessionlessEvents: Math.trunc(toNumber(row.sessionless_events)),
      pageViews: Math.trunc(toNumber(row.page_views)),
      productViews: Math.trunc(toNumber(row.product_views)),
      addToCart: Math.trunc(toNumber(row.add_to_cart)),
      beginCheckout: Math.trunc(toNumber(row.begin_checkout)),
      purchases: Math.trunc(toNumber(row.purchases)),
      productViewSessions,
      addToCartSessions,
      beginCheckoutSessions,
      purchaseSessions,
      productViewRate: toRate(productViewSessions, sessions),
      addToCartRate: toRate(addToCartSessions, sessions),
      checkoutRate: toRate(beginCheckoutSessions, sessions),
      checkoutCompletionRate: toRate(purchaseSessions, beginCheckoutSessions),
      conversionRate: toRate(purchaseSessions, sessions),
    } satisfies ShopifyCustomerEventsDailyAggregate;
  });

  const sessions = daily.reduce((sum, row) => sum + row.sessions, 0);
  const productViewSessions = daily.reduce((sum, row) => sum + row.productViewSessions, 0);
  const addToCartSessions = daily.reduce((sum, row) => sum + row.addToCartSessions, 0);
  const beginCheckoutSessions = daily.reduce((sum, row) => sum + row.beginCheckoutSessions, 0);
  const purchaseSessions = daily.reduce((sum, row) => sum + row.purchaseSessions, 0);

  return {
    sessions,
    sessionlessEvents: daily.reduce((sum, row) => sum + row.sessionlessEvents, 0),
    pageViews: daily.reduce((sum, row) => sum + row.pageViews, 0),
    productViews: daily.reduce((sum, row) => sum + row.productViews, 0),
    addToCart: daily.reduce((sum, row) => sum + row.addToCart, 0),
    beginCheckout: daily.reduce((sum, row) => sum + row.beginCheckout, 0),
    purchases: daily.reduce((sum, row) => sum + row.purchases, 0),
    productViewSessions,
    addToCartSessions,
    beginCheckoutSessions,
    purchaseSessions,
    productViewRate: toRate(productViewSessions, sessions),
    addToCartRate: toRate(addToCartSessions, sessions),
    checkoutRate: toRate(beginCheckoutSessions, sessions),
    checkoutCompletionRate: toRate(purchaseSessions, beginCheckoutSessions),
    conversionRate: toRate(purchaseSessions, sessions),
    daily,
  } satisfies ShopifyCustomerEventsAggregate;
}
