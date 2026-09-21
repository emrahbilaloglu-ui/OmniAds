import { getDb } from "@/lib/db";
import { getDbSchemaReadiness, isMissingRelationError } from "@/lib/db-schema-readiness";
import type { BreakEvenPreviewFacts } from "@/lib/commerce-cost/break-even-preview";

const PREVIEW_TABLES = [
  "shopify_orders",
  "shopify_order_lines",
  "shopify_variant_unit_costs",
] as const;

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = numericOrNull(value);
  return parsed === null ? null : Math.max(0, Math.trunc(parsed));
}

function daysInclusive(startDate: string, endDate: string) {
  return Math.floor(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
      86_400_000,
  ) + 1;
}

function unavailableFacts(input: {
  startDate: string;
  endDate: string;
  reportingCurrency: string;
  reason: string;
}): BreakEvenPreviewFacts {
  return {
    window: {
      startDate: input.startDate,
      endDate: input.endDate,
      days: daysInclusive(input.startDate, input.endDate),
    },
    reportingCurrency: input.reportingCurrency,
    baseTotals: {},
    orderCount: null,
    unitCount: null,
    lineCount: null,
    currencyMismatchNetSales: null,
    shopify: {
      available: false,
      unavailableReason: input.reason,
      currentUnitCostTotal: null,
      costedNetSales: null,
      missingNetSales: null,
      latestObservedAt: null,
    },
  };
}

/**
 * Reads only the aggregate facts required to preview a draft. Current catalog
 * cost is joined to the selected sales mix, so no current value is mislabeled
 * as the historical cost booked when the order occurred.
 */
export async function readBreakEvenPreviewFacts(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  reportingCurrency: string;
}): Promise<BreakEvenPreviewFacts> {
  const readiness = await getDbSchemaReadiness({ tables: [...PREVIEW_TABLES] }).catch(() => null);
  if (!readiness?.ready) {
    return unavailableFacts({
      ...input,
      reason: "Shopify order or unit-cost storage is unavailable.",
    });
  }

  try {
    const rows = await getDb().query<Record<string, unknown>>(
      `WITH selected_orders AS (
         SELECT business_id, provider_account_id, shop_id, order_id,
                currency_code, shop_currency_code, subtotal_price,
                total_shipping, total_tax, total_price
         FROM shopify_orders
         WHERE business_id = $1
           AND (
             (order_created_date_local IS NOT NULL
               AND order_created_date_local >= $2::date
               AND order_created_date_local <= $3::date)
             OR
             (order_created_date_local IS NULL
               AND order_created_at::date >= $2::date
               AND order_created_at::date <= $3::date)
           )
       ),
       eligible_orders AS (
         SELECT *
         FROM selected_orders
         WHERE COALESCE(shop_currency_code, currency_code) = $4
       ),
       order_totals AS (
         SELECT COUNT(*)::integer AS order_count,
                COALESCE(SUM(total_price), 0) AS total_incl_tax,
                COALESCE(SUM(total_price - total_tax), 0) AS total_excl_tax,
                COALESCE(SUM(total_shipping), 0) AS shipping_revenue
         FROM eligible_orders
       ),
       line_facts AS (
         SELECT lines.discounted_total, lines.original_total, lines.quantity,
                costs.unit_cost, costs.currency_code AS cost_currency,
                costs.observed_at AS cost_observed_at
         FROM eligible_orders orders
         JOIN shopify_order_lines lines
           ON lines.business_id = orders.business_id
          AND lines.provider_account_id = orders.provider_account_id
          AND lines.shop_id = orders.shop_id
          AND lines.order_id = orders.order_id
         LEFT JOIN shopify_variant_unit_costs costs
           ON costs.business_id::text = lines.business_id
          AND costs.provider_account_id = lines.provider_account_id
          -- Commerce sync stores the numeric Admin API id while the catalog
          -- endpoint returns GraphQL GIDs. Keep both indexed equality forms;
          -- a regex-normalized join makes the warehouse scan the full catalog.
          AND (
            costs.variant_id = lines.variant_id
            OR costs.variant_id = 'gid://shopify/ProductVariant/' || lines.variant_id
          )
          AND costs.active = true
       ),
       line_totals AS (
         SELECT COALESCE(SUM(discounted_total), 0) AS net_product_sales,
                COALESCE(SUM(original_total), 0) AS gross_product_sales,
                COALESCE(SUM(quantity), 0)::integer AS unit_count,
                COUNT(*)::integer AS line_count,
                COALESCE(SUM(
                  CASE WHEN unit_cost IS NOT NULL AND cost_currency = $4
                       THEN unit_cost * quantity ELSE 0 END
                ), 0) AS current_unit_cost_total,
                COALESCE(SUM(
                  CASE WHEN unit_cost IS NOT NULL AND cost_currency = $4
                       THEN discounted_total ELSE 0 END
                ), 0) AS costed_net_sales,
                COALESCE(SUM(
                  CASE WHEN unit_cost IS NULL OR cost_currency IS DISTINCT FROM $4
                       THEN discounted_total ELSE 0 END
                ), 0) AS missing_net_sales,
                MAX(cost_observed_at) AS latest_observed_at
         FROM line_facts
       ),
       mismatched AS (
         SELECT COALESCE(SUM(lines.discounted_total), 0) AS net_sales
         FROM selected_orders orders
         JOIN shopify_order_lines lines
           ON lines.business_id = orders.business_id
          AND lines.provider_account_id = orders.provider_account_id
          AND lines.shop_id = orders.shop_id
          AND lines.order_id = orders.order_id
         WHERE COALESCE(orders.shop_currency_code, orders.currency_code, '') <> $4
       )
       SELECT order_totals.*, line_totals.*,
              mismatched.net_sales AS currency_mismatch_net_sales
       FROM order_totals CROSS JOIN line_totals CROSS JOIN mismatched`,
      [input.businessId, input.startDate, input.endDate, input.reportingCurrency.toUpperCase()],
    );
    const row = rows[0] ?? {};
    const netProductSales = numericOrNull(row.net_product_sales);
    const grossProductSales = numericOrNull(row.gross_product_sales);
    return {
      window: {
        startDate: input.startDate,
        endDate: input.endDate,
        days: daysInclusive(input.startDate, input.endDate),
      },
      reportingCurrency: input.reportingCurrency.toUpperCase(),
      baseTotals: {
        line_net_sales: netProductSales,
        order_net_product_sales: netProductSales,
        line_gross_sales: grossProductSales,
        order_gross_product_sales: grossProductSales,
        order_total_excl_tax: numericOrNull(row.total_excl_tax),
        order_total_incl_tax: numericOrNull(row.total_incl_tax),
        order_shipping_revenue: numericOrNull(row.shipping_revenue),
        order_payment_captured: null,
      },
      orderCount: integerOrNull(row.order_count),
      unitCount: integerOrNull(row.unit_count),
      lineCount: integerOrNull(row.line_count),
      currencyMismatchNetSales: numericOrNull(row.currency_mismatch_net_sales),
      shopify: {
        available: true,
        unavailableReason: null,
        currentUnitCostTotal: numericOrNull(row.current_unit_cost_total),
        costedNetSales: numericOrNull(row.costed_net_sales),
        missingNetSales: numericOrNull(row.missing_net_sales),
        latestObservedAt: row.latest_observed_at ? String(row.latest_observed_at) : null,
      },
    };
  } catch (error) {
    if (isMissingRelationError(error, [...PREVIEW_TABLES])) {
      return unavailableFacts({
        ...input,
        reason: "Shopify order or unit-cost storage is unavailable.",
      });
    }
    throw error;
  }
}
