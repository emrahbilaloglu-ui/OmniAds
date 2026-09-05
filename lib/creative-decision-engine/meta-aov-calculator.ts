import type { DbClient } from "@/lib/db";

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
 * `providerAccountId` is OPTIONAL and its absence means the business: null
 * aggregates every ad account the business owns, which is the reading every
 * business-wide caller has always had. A value restricts the window to that one
 * physical ad account.
 *
 * The distinction is load-bearing rather than cosmetic. This is the rung the
 * spend-unit resolver reaches when an account has no configured unit and no
 * store evidence, so an unscoped read is exactly how an account with no
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
  const [row] = await input.db.query<MetaAovRow>(
    `
    SELECT
      CASE WHEN SUM(conversions) > 0 THEN SUM(revenue) / SUM(conversions) END AS aov_mean,
      COALESCE(SUM(conversions), 0)::integer AS purchase_count,
      COALESCE(SUM(revenue), 0) AS total_revenue,
      ($2::date - (($3::integer - 1) * INTERVAL '1 day'))::date AS window_start,
      $2::date AS window_end
    FROM meta_creative_daily
    WHERE business_ref_id = $1::uuid
      AND ($4::text IS NULL OR provider_account_id = $4::text)
      AND date BETWEEN ($2::date - (($3::integer - 1) * INTERVAL '1 day')) AND $2::date
      AND objective = 'OUTCOME_SALES'
    `,
    [input.businessId, input.asOf, windowDays, providerAccountId],
  );

  return {
    aovMean: toNumberOrNull(row?.aov_mean),
    purchaseCount: toInteger(row?.purchase_count),
    totalRevenue: toNumberOrNull(row?.total_revenue) ?? 0,
    windowStart: toIsoDateOrFallback(row?.window_start, input.asOf),
    windowEnd: toIsoDateOrFallback(row?.window_end, input.asOf),
  };
}
