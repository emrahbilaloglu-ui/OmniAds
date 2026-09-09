import type { DbClient } from "@/lib/db";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import { deterministicCommercialCutoffMs } from "@/lib/meta/commercial-target-instant";

export interface MetaAttributedAovResult {
  aovMean: number | null;
  purchaseCount: number;
  totalRevenue: number;
  windowStart: string;
  windowEnd: string;
}

type MetaAovRow = Record<string, unknown> & {
  aov_mean: unknown;
  purchase_count: unknown;
  total_revenue: unknown;
  window_start: unknown;
  window_end: unknown;
};

export const READ_META_ATTRIBUTED_AOV_SQL = `
WITH cutoff_safe_facts AS (
  SELECT
    d.metric_schema_version,
    d.conversions,
    d.revenue,
    NULLIF(UPPER(BTRIM(d.account_currency)), '') AS source_currency,
    NULLIF(UPPER(BTRIM(account.currency)), '') AS bound_account_currency,
    (
      d.metric_schema_version > $6::integer
      OR (
        d.metric_schema_version = $6::integer
        AND (
          NULLIF(BTRIM(d.account_currency), '') IS NULL
          OR d.conversions::text IN ('NaN', 'Infinity', '-Infinity')
          OR d.revenue::text IN ('NaN', 'Infinity', '-Infinity')
          OR d.conversions < 0
          OR d.revenue < 0
          OR d.conversions <> TRUNC(d.conversions)
          OR (d.conversions > 0 AND d.revenue <= 0)
          OR (d.revenue > 0 AND d.conversions <= 0)
        )
      )
    ) AS contradictory
  FROM meta_ad_daily d
  JOIN business_provider_accounts binding
    ON binding.business_id = d.business_ref_id::text
   AND binding.provider = 'meta'
   AND binding.provider_account_ref_id = d.provider_account_ref_id
   AND binding.provider_account_id = d.provider_account_id
  JOIN provider_accounts account
    ON account.id = binding.provider_account_ref_id
   AND account.provider = 'meta'
   AND account.external_account_id = binding.provider_account_id
  WHERE d.business_id = $1::text
    AND d.business_ref_id = $1::uuid
    AND d.provider_account_id = $4::text
    AND d.date BETWEEN ($2::date - (($3::integer - 1) * INTERVAL '1 day')) AND $2::date
    AND UPPER(BTRIM(d.truth_state)) = 'FINALIZED'
    AND UPPER(BTRIM(d.validation_status)) = 'PASSED'
    AND d.finalized_at IS NOT NULL
    AND d.created_at <= $5::timestamptz
    AND d.updated_at <= $5::timestamptz
    AND d.finalized_at <= $5::timestamptz
), aggregate AS (
  SELECT
    COUNT(*) FILTER (WHERE contradictory)::integer AS contradictory_count,
    COUNT(DISTINCT source_currency)::integer AS source_currency_count,
    COUNT(DISTINCT bound_account_currency)::integer AS bound_currency_count,
    MIN(source_currency) AS source_currency,
    MIN(bound_account_currency) AS bound_account_currency,
    COALESCE(SUM(conversions) FILTER (
      WHERE metric_schema_version = $6::integer
        AND NOT contradictory
        AND conversions > 0
        AND revenue > 0
    ), 0) AS purchase_count,
    COALESCE(SUM(revenue) FILTER (
      WHERE metric_schema_version = $6::integer
        AND NOT contradictory
        AND conversions > 0
        AND revenue > 0
    ), 0) AS total_revenue
  FROM cutoff_safe_facts
)
SELECT
  CASE
    WHEN contradictory_count = 0
      AND source_currency_count = 1
      AND bound_currency_count = 1
      AND source_currency = bound_account_currency
      AND purchase_count > 0
      THEN total_revenue / purchase_count
  END AS aov_mean,
  CASE
    WHEN contradictory_count = 0
      AND source_currency_count = 1
      AND bound_currency_count = 1
      AND source_currency = bound_account_currency
      THEN purchase_count
    ELSE 0
  END::integer AS purchase_count,
  CASE
    WHEN contradictory_count = 0
      AND source_currency_count = 1
      AND bound_currency_count = 1
      AND source_currency = bound_account_currency
      THEN total_revenue
    ELSE 0
  END AS total_revenue,
  ($2::date - (($3::integer - 1) * INTERVAL '1 day'))::date AS window_start,
  $2::date AS window_end
FROM aggregate
`;

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toInteger(value: unknown): number {
  const parsed = toNumberOrNull(value);
  return parsed === null ? 0 : Math.floor(parsed);
}

function toIsoDateOrFallback(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const datePrefix = /^\d{4}-\d{2}-\d{2}/.exec(value.trim())?.[0];
    if (datePrefix) return datePrefix;
  }
  return fallback;
}

/**
 * The Meta-attributed average order value over the window.
 *
 * `providerAccountId` is optional only for interface compatibility. Its absence
 * cannot identify a physical account, so it returns an empty sample and cannot
 * become hard-action authority.
 *
 * The distinction is load-bearing rather than cosmetic. This is the rung the
 * spend-unit resolver reaches when an account has a Target ROAS, so an unscoped
 * read is exactly how an account with no
 * purchases of its own would acquire a sibling account's benchmark and read as
 * fully anchored. There is one statement for both readings, and it is this one.
 * A second statement elsewhere that added the account filter to a copy of this
 * window would have to be kept in step with it by hand — two aggregates that
 * must agree and nothing that makes them.
 */
export async function computeMetaAttributedAov(input: {
  businessId: string;
  asOf: string;
  windowDays?: number;
  providerAccountId?: string | null;
  db: DbClient;
}): Promise<MetaAttributedAovResult> {
  const windowDays = input.windowDays ?? 90;
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new Error("windowDays must be a positive integer");
  }
  const cutoffMs = deterministicCommercialCutoffMs(input.asOf);
  if (cutoffMs === null) {
    throw new Error("asOf must be a strict YYYY-MM-DD date or RFC 3339 instant");
  }
  const asOfCutoff = new Date(cutoffMs).toISOString();
  const windowEnd = asOfCutoff.slice(0, 10);
  const windowStart = new Date(
    Date.UTC(
      Number(windowEnd.slice(0, 4)),
      Number(windowEnd.slice(5, 7)) - 1,
      Number(windowEnd.slice(8, 10)) - (windowDays - 1),
    ),
  ).toISOString().slice(0, 10);
  /*
    Blank is not an account. An empty string reaching the filter as a scope
    would match nothing at all and read as "this account sold nothing", which is
    a different and much more dangerous answer than "no account was named".
  */
  const providerAccountId =
    typeof input.providerAccountId === "string"
    && input.providerAccountId.trim() !== ""
      ? input.providerAccountId.trim()
      : null;

  if (providerAccountId === null) {
    return {
      aovMean: null,
      purchaseCount: 0,
      totalRevenue: 0,
      windowStart,
      windowEnd,
    };
  }
  const [row] = await input.db.query<MetaAovRow>(
    READ_META_ATTRIBUTED_AOV_SQL,
    [
      input.businessId,
      windowEnd,
      windowDays,
      providerAccountId,
      asOfCutoff,
      META_CANONICAL_METRIC_SCHEMA_VERSION,
    ],
  );

  return {
    aovMean: toNumberOrNull(row?.aov_mean),
    purchaseCount: toInteger(row?.purchase_count),
    totalRevenue: toNumberOrNull(row?.total_revenue) ?? 0,
    windowStart: toIsoDateOrFallback(row?.window_start, windowStart),
    windowEnd: toIsoDateOrFallback(row?.window_end, windowEnd),
  };
}
