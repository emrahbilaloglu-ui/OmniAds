/**
 * The one bulk read of Google Ads freshness evidence.
 *
 * WHY A BULK READ AND NOT A HELPER. The completion decision already lives in
 * one place (`resolveGoogleAdsCompletion`), but a decision is only as good as
 * what is fed into it. If every surface gathered its own inputs, each would
 * reach for the cheapest signal to hand — `SELECT DISTINCT date` — and we would
 * be back to forty independent definitions of "complete" that happen to share a
 * function. So the INPUTS are gathered here too, once, and every consumer reads
 * the same snapshot.
 *
 * The status route alone renders a dozen scope cards; a per-card query would be
 * an N+1 against the hottest endpoint in the product. This issues two bounded
 * statements regardless of scope count: one aggregate over the freshness table,
 * one UNION ALL over the scope fact tables.
 *
 * FAIL CLOSED, STAY RETRYABLE. Schema not ready, query failure, no assigned
 * accounts, an account timezone we cannot trust — every one of these yields
 * `unknown`, never a green default and never a terminal failure. Callers must
 * keep polling on `unknown`, because it means we could not look, not that there
 * is nothing there.
 */

import { getDb, getDbWithTimeout } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  getProviderPlatformDateBoundaries,
  addDaysToIsoDateUtc,
} from "@/lib/provider-platform-date";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import {
  GOOGLE_ADS_COMPLETION_LABELS,
  resolveGoogleAdsCompletion,
  unknownGoogleAdsCompletion,
  type GoogleAdsCompletionState,
  type GoogleAdsCompletionVerdict,
} from "@/lib/google-ads/completion-semantics";
import { GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS } from "@/lib/google-ads/day-finality";

const GOOGLE_ADS_SCOPE_TABLES: Record<GoogleAdsWarehouseScope, string> = {
  account_daily: "google_ads_account_daily",
  campaign_daily: "google_ads_campaign_daily",
  ad_group_daily: "google_ads_ad_group_daily",
  ad_daily: "google_ads_ad_daily",
  keyword_daily: "google_ads_keyword_daily",
  search_term_daily: "google_ads_search_term_daily",
  asset_group_daily: "google_ads_asset_group_daily",
  asset_daily: "google_ads_asset_daily",
  audience_daily: "google_ads_audience_daily",
  geo_daily: "google_ads_geo_daily",
  device_daily: "google_ads_device_daily",
  product_daily: "google_ads_product_daily",
};

export interface GoogleAdsScopeFreshness {
  scope: string;
  /** Days with at least one warehouse row. Data availability, NOT completion. */
  coveredDays: number;
  /**
   * Days where EVERY assigned account has an observation taken after that
   * account's own day closed. Conjunctive on purpose: with three accounts and
   * one never re-read, the business's day is not observed.
   */
  postCloseObservedDays: number;
  /** Days past the configured conversion lookback for every assigned account. */
  lookbackExhaustedDays: number;
  /** Days currently due for a re-read. Non-zero means the worker still has work. */
  dueNowDays: number;
  /** Oldest last-observation across the range, i.e. the weakest link. */
  oldestObservationAt: string | null;
  /** Newest last-observation across the range. */
  latestObservationAt: string | null;
  verdict: GoogleAdsCompletionVerdict;
}

export interface GoogleAdsFreshnessSnapshot {
  businessId: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  providerAccountIds: string[];
  /** Whether every account's timezone came from its snapshot. */
  timeZoneSource: "account" | "default";
  /** Whether the range reaches the account's still-open day. */
  includesOpenDay: boolean;
  /**
   * False when the evidence could not be read. Every verdict is then `unknown`
   * and no caller may render green, claim completion, or stop polling.
   */
  evidenceAvailable: boolean;
  unavailableReason: string | null;
  scopes: Record<string, GoogleAdsScopeFreshness>;
  /** The weakest scope verdict — a range is only as complete as its worst scope. */
  overall: GoogleAdsCompletionVerdict;
}

function countDaysInclusive(startDate: string, endDate: string) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

const STATE_RANK: Record<GoogleAdsCompletionVerdict["state"], number> = {
  unknown: 0,
  missing: 1,
  provisional: 2,
  converging: 3,
  settled: 4,
};

/** The weakest verdict wins: a range is not complete because most of it is. */
export function weakestGoogleAdsCompletion(
  verdicts: GoogleAdsCompletionVerdict[],
): GoogleAdsCompletionVerdict {
  if (verdicts.length === 0) {
    return unknownGoogleAdsCompletion("No Google Ads surfaces were evaluated.");
  }
  return verdicts.reduce((weakest, candidate) => {
    const weakestRank = STATE_RANK[weakest.state];
    const candidateRank = STATE_RANK[candidate.state];
    if (candidateRank !== weakestRank) return candidateRank < weakestRank ? candidate : weakest;
    return candidate.percent < weakest.percent ? candidate : weakest;
  });
}

function unavailableSnapshot(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  scopes: readonly GoogleAdsWarehouseScope[];
  providerAccountIds: string[];
  reason: string;
}): GoogleAdsFreshnessSnapshot {
  const verdict = unknownGoogleAdsCompletion(input.reason);
  const scopes: Record<string, GoogleAdsScopeFreshness> = {};
  for (const scope of input.scopes) {
    scopes[scope] = {
      scope,
      coveredDays: 0,
      postCloseObservedDays: 0,
      lookbackExhaustedDays: 0,
      dueNowDays: 0,
      oldestObservationAt: null,
      latestObservationAt: null,
      verdict,
    };
  }
  return {
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    totalDays: countDaysInclusive(input.startDate, input.endDate),
    providerAccountIds: input.providerAccountIds,
    timeZoneSource: "default",
    // Unknown clock: assume the range is still moving rather than assume it is not.
    includesOpenDay: true,
    evidenceAvailable: false,
    unavailableReason: input.reason,
    scopes,
    overall: verdict,
  };
}

interface FreshnessAggregateRow {
  scope: string;
  observed_days: string | number | null;
  exhausted_days: string | number | null;
  due_days: string | number | null;
  oldest_observation_at: string | Date | null;
  latest_observation_at: string | Date | null;
}

interface CoverageRow {
  scope: string;
  covered_days: string | number | null;
}

function toCount(value: string | number | null | undefined) {
  const parsed = typeof value === "string" ? Number(value) : (value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed as number)) : 0;
}

function toIso(value: string | Date | null) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Read freshness evidence for a business across several scopes in one pass.
 *
 * Never throws: every failure mode collapses into an `unknown` snapshot, so a
 * status endpoint degrades to "we could not tell" instead of to "all good".
 */
export async function readGoogleAdsFreshness(input: {
  businessId: string;
  scopes: readonly GoogleAdsWarehouseScope[];
  startDate: string;
  endDate: string;
  providerAccountIds?: string[] | null;
  now?: Date;
  timeoutMs?: number;
}): Promise<GoogleAdsFreshnessSnapshot> {
  const scopes = Array.from(new Set(input.scopes)).filter(
    (scope): scope is GoogleAdsWarehouseScope => scope in GOOGLE_ADS_SCOPE_TABLES,
  );
  const startDate = input.startDate.slice(0, 10);
  const endDate = input.endDate.slice(0, 10);
  const totalDays = countDaysInclusive(startDate, endDate);
  const fail = (reason: string, providerAccountIds: string[] = []) =>
    unavailableSnapshot({
      businessId: input.businessId,
      startDate,
      endDate,
      scopes,
      providerAccountIds,
      reason,
    });

  if (scopes.length === 0) return fail("No Google Ads surfaces were requested.");
  if (totalDays === 0) return fail("The requested date range is empty.");

  let providerAccountIds: string[];
  let timeZoneSource: "account" | "default";
  let openDayFrom: string;
  try {
    const boundaries = await getProviderPlatformDateBoundaries({
      provider: "google",
      businessId: input.businessId,
      providerAccountIds: input.providerAccountIds ?? undefined,
    });
    providerAccountIds = boundaries
      .map((boundary) => boundary.providerAccountId)
      .filter((id): id is string => Boolean(id));
    if (providerAccountIds.length === 0) {
      return fail("No Google Ads accounts are assigned to this business.");
    }
    timeZoneSource = boundaries.every((boundary) => boundary.timeZoneSource === "account")
      ? "account"
      : "default";
    const currentDates = boundaries.map((boundary) => boundary.currentDate).sort();
    openDayFrom =
      timeZoneSource === "account"
        ? // The EARLIEST account "today": if any account's day is still open,
          // the business's range is still open.
          (currentDates[0] ?? endDate)
        : // We do not know the clock. Treat an extra day as open rather than
          // settle a Los Angeles day on a UTC server's say-so.
          addDaysToIsoDateUtc(
            (input.now ?? new Date()).toISOString().slice(0, 10),
            -1,
          );
  } catch {
    return fail("Google Ads account boundaries could not be resolved.");
  }

  try {
    await assertDbSchemaReady({
      tables: ["google_ads_day_finality", ...scopes.map((scope) => GOOGLE_ADS_SCOPE_TABLES[scope])],
      context: "google_ads_freshness_read",
    });
  } catch {
    return fail(
      "Google Ads freshness tables are not ready yet.",
      providerAccountIds,
    );
  }

  const sql = input.timeoutMs ? getDbWithTimeout(input.timeoutMs) : getDb();
  const now = (input.now ?? new Date()).toISOString();
  const accountCount = providerAccountIds.length;

  let aggregateRows: FreshnessAggregateRow[];
  let coverageRows: CoverageRow[];
  try {
    const coverageSql = scopes
      .map(
        (scope, index) => `
          SELECT '${scope}'::text AS scope, COUNT(DISTINCT date) AS covered_days
          FROM ${GOOGLE_ADS_SCOPE_TABLES[scope]}
          WHERE business_id = $1
            AND provider_account_id = ANY($2::text[])
            AND date >= $3::date
            AND date <= $4::date
          ${index === scopes.length - 1 ? "" : "UNION ALL"}`,
      )
      .join("\n");

    [aggregateRows, coverageRows] = (await Promise.all([
      sql.query(
        `
          WITH per_day AS (
            SELECT
              scope,
              date,
              COUNT(DISTINCT provider_account_id) FILTER (
                WHERE day_closed_at IS NOT NULL
                  AND last_observed_at IS NOT NULL
                  AND last_observed_at >= day_closed_at
              ) AS observed_accounts,
              COUNT(DISTINCT provider_account_id) FILTER (
                WHERE lookback_exhausted_at IS NOT NULL
                  AND lookback_exhausted_at <= $6::timestamptz
              ) AS exhausted_accounts,
              COUNT(DISTINCT provider_account_id) FILTER (
                WHERE next_refresh_due_at IS NULL
                   OR next_refresh_due_at <= $6::timestamptz
              ) AS due_accounts,
              MIN(last_observed_at) AS oldest_observation_at,
              MAX(last_observed_at) AS latest_observation_at
            FROM google_ads_day_finality
            WHERE business_id = $1
              AND provider_account_id = ANY($2::text[])
              AND scope = ANY($5::text[])
              AND date >= $3::date
              AND date <= $4::date
            GROUP BY scope, date
          )
          SELECT
            scope,
            COUNT(*) FILTER (WHERE observed_accounts >= $7::int) AS observed_days,
            COUNT(*) FILTER (
              WHERE observed_accounts >= $7::int AND exhausted_accounts >= $7::int
            ) AS exhausted_days,
            COUNT(*) FILTER (WHERE due_accounts > 0) AS due_days,
            MIN(oldest_observation_at) AS oldest_observation_at,
            MAX(latest_observation_at) AS latest_observation_at
          FROM per_day
          GROUP BY scope
        `,
        [
          input.businessId,
          providerAccountIds,
          startDate,
          endDate,
          scopes,
          now,
          accountCount,
        ],
      ) as Promise<FreshnessAggregateRow[]>,
      sql.query(coverageSql, [
        input.businessId,
        providerAccountIds,
        startDate,
        endDate,
      ]) as Promise<CoverageRow[]>,
    ])) as [FreshnessAggregateRow[], CoverageRow[]];
  } catch {
    return fail("Google Ads freshness evidence could not be read.", providerAccountIds);
  }

  const aggregateByScope = new Map(aggregateRows.map((row) => [row.scope, row]));
  const coverageByScope = new Map(coverageRows.map((row) => [row.scope, row]));
  const includesOpenDay = endDate >= openDayFrom;

  const resolved: Record<string, GoogleAdsScopeFreshness> = {};
  for (const scope of scopes) {
    const aggregate = aggregateByScope.get(scope);
    const coveredDays = toCount(coverageByScope.get(scope)?.covered_days);
    const postCloseObservedDays = toCount(aggregate?.observed_days);
    const lookbackExhaustedDays = toCount(aggregate?.exhausted_days);
    // Days with no freshness row at all are due too — the aggregate can only
    // count rows that exist, so anything the table has never seen is added
    // back here. Otherwise a pre-table range would report zero outstanding work.
    const dueNowDays = Math.max(
      toCount(aggregate?.due_days),
      totalDays - Math.max(postCloseObservedDays, toCount(aggregate?.observed_days)),
    );
    resolved[scope] = {
      scope,
      coveredDays,
      postCloseObservedDays,
      lookbackExhaustedDays,
      dueNowDays,
      oldestObservationAt: toIso(aggregate?.oldest_observation_at ?? null),
      latestObservationAt: toIso(aggregate?.latest_observation_at ?? null),
      verdict: resolveGoogleAdsCompletion({
        totalDays,
        coveredDays,
        postCloseObservedDays,
        lookbackExhaustedDays,
        includesOpenDay,
      }),
    };
  }

  return {
    businessId: input.businessId,
    startDate,
    endDate,
    totalDays,
    providerAccountIds,
    timeZoneSource,
    includesOpenDay,
    evidenceAvailable: true,
    unavailableReason: null,
    scopes: resolved,
    overall: weakestGoogleAdsCompletion(scopes.map((scope) => resolved[scope].verdict)),
  };
}

/**
 * Percent for a surface that has only one scope's numbers to hand.
 *
 * Exists so a caller that already holds a `GoogleAdsScopeFreshness` never
 * recomputes `covered / total * 100` inline — that arithmetic is the defect.
 */
export function googleAdsScopePercent(scope: GoogleAdsScopeFreshness | undefined) {
  return scope?.verdict.percent ?? 0;
}

export interface GoogleAdsFreshnessScopeSummary {
  scope: string;
  state: GoogleAdsCompletionState;
  label: string;
  percent: number;
  complete: boolean;
  mayStopPolling: boolean;
  detail: string;
  coveredDays: number;
  postCloseObservedDays: number;
  lookbackExhaustedDays: number;
  dueNowDays: number;
  oldestObservationAt: string | null;
  latestObservationAt: string | null;
}

/**
 * The wire shape. One serialisable summary, shared by the status route, the
 * health endpoints and the UI, so a client can never be handed a percent from
 * one definition and a label from another.
 */
export interface GoogleAdsFreshnessSummary {
  evidenceAvailable: boolean;
  unavailableReason: string | null;
  state: GoogleAdsCompletionState;
  label: string;
  percent: number;
  complete: boolean;
  /** Clients MUST keep polling while this is false, including on `unknown`. */
  mayStopPolling: boolean;
  detail: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  includesOpenDay: boolean;
  timeZoneSource: "account" | "default";
  /**
   * The lookback this verdict was measured against. Published so a client can
   * say "settled against a 30-day window" instead of the unqualified "final"
   * that Google never offers.
   */
  conversionLookbackDays: number;
  scopes: GoogleAdsFreshnessScopeSummary[];
}

export function toGoogleAdsFreshnessSummary(
  snapshot: GoogleAdsFreshnessSnapshot,
): GoogleAdsFreshnessSummary {
  return {
    evidenceAvailable: snapshot.evidenceAvailable,
    unavailableReason: snapshot.unavailableReason,
    state: snapshot.overall.state,
    label: GOOGLE_ADS_COMPLETION_LABELS[snapshot.overall.state],
    percent: snapshot.overall.percent,
    complete: snapshot.overall.complete,
    mayStopPolling: snapshot.overall.mayStopPolling,
    detail: snapshot.overall.detail,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    totalDays: snapshot.totalDays,
    includesOpenDay: snapshot.includesOpenDay,
    timeZoneSource: snapshot.timeZoneSource,
    conversionLookbackDays: GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS,
    scopes: Object.values(snapshot.scopes).map((scope) => ({
      scope: scope.scope,
      state: scope.verdict.state,
      label: GOOGLE_ADS_COMPLETION_LABELS[scope.verdict.state],
      percent: scope.verdict.percent,
      complete: scope.verdict.complete,
      mayStopPolling: scope.verdict.mayStopPolling,
      detail: scope.verdict.detail,
      coveredDays: scope.coveredDays,
      postCloseObservedDays: scope.postCloseObservedDays,
      lookbackExhaustedDays: scope.lookbackExhaustedDays,
      dueNowDays: scope.dueNowDays,
      oldestObservationAt: scope.oldestObservationAt,
      latestObservationAt: scope.latestObservationAt,
    })),
  };
}
