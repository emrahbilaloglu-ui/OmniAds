import { getDb } from "@/lib/db";
import { getTodayIsoForTimeZoneServer } from "@/lib/provider-platform-date";

/**
 * Google Ads date freshness.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. Coverage is `SELECT DISTINCT date` — mere
 * row existence. So a date read once at 01:40 becomes "covered", every later
 * tick that day skips re-queueing it, and the D+1 path then marks it
 * finalize-complete WITHOUT calling Google. A day freezes at its first intraday
 * read and is reported settled forever.
 *
 * WHAT GOOGLE ACTUALLY GUARANTEES — and does not. Per Google's own
 * documentation: clicks/impressions/cost carry roughly a 1-hour freshness
 * objective; last-click conversions lag about 3 hours and other attribution
 * models about 15; reports "may occasionally be updated one or more days after
 * an event occurs" for invalid traffic, late-arriving conversions and
 * end-of-month adjustments; and a conversion can be attributed back to its
 * click date for as long as the conversion window allows — configurable from 1
 * to 90 days, defaulting to 30 for click-through.
 *
 * So there is NO instant at which Google promises a date will never change
 * again. This module therefore refuses to model one. It tracks five DISTINCT
 * things and never collapses them into a single "final" bit:
 *
 *   1. dayClosedAt      — the account-timezone instant the calendar day ended.
 *                         A fact about the clock.
 *   2. lastObservedAt   — when we last completed a real provider fetch for this
 *                         date. A fact about us.
 *   3. metricsSettledAt — the point after day close when the VOLATILE intraday
 *                         metrics have settled per Google's stated lags. A
 *                         policy claim about spend/clicks, explicitly NOT about
 *                         conversions, and never a claim of immutability.
 *   4. nextRefreshDueAt — when this date should be re-read again. Drives the
 *                         bounded rolling reread.
 *   5. lookbackExhaustedAt — dayClosedAt + the configured conversion window,
 *                         after which further revision is unlikely. Still a
 *                         POLICY horizon, not a provider guarantee.
 *
 * ABSENCE IS A SIXTH STATE. A date with no row here predates this table: it is
 * neither trusted nor treated as an obligation to re-fetch all of history — the
 * rolling window bounds what is reconsidered.
 */

/**
 * When the volatile intraday metrics for a closed day can be considered
 * settled. Google reports ~15h for non-last-click attribution models, which is
 * the slowest of the per-metric lags it publishes. Deliberately named for what
 * it covers — metrics, not conversions.
 */
export const GOOGLE_ADS_METRICS_SETTLE_HOURS = Number(
  process.env.GOOGLE_ADS_METRICS_SETTLE_HOURS ?? 15,
);

/**
 * How long a date stays eligible for conversion revision.
 *
 * Google supports 1-90 days and defaults click-through to 30. The
 * account-specific window is not reliably retrievable here, so this is a
 * CONSERVATIVE configurable maximum. It is a policy horizon we chose, not
 * something Google told us, and it must never be presented as immutability.
 */
export const GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS = Math.min(
  90,
  Math.max(1, Number(process.env.GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS ?? 30)),
);

/**
 * Freshness tiers. A date's tier decides how often it is re-read, so the
 * ~1/min planner cannot enqueue every date on every pass.
 */
export type GoogleAdsFreshnessTier =
  /** The account's open day. Changing continuously. */
  | "open"
  /** Closed, but inside the metrics settle window. */
  | "settling"
  /** Metrics settled; conversions may still arrive. */
  | "converging"
  /** Past the configured conversion window. Revision unlikely, not impossible. */
  | "aged";

/** Re-read cadence per tier, in minutes. */
export const GOOGLE_ADS_TIER_REFRESH_MINUTES: Record<GoogleAdsFreshnessTier, number> = {
  open: 60,
  settling: 180,
  converging: 1440,
  // Deliberately finite: "aged" is a policy horizon, not immutability, so the
  // date keeps a slow heartbeat rather than being declared closed forever.
  aged: 10080,
};

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Hours elapsed in the account's current day, from the account's own clock. */
export function hoursIntoAccountDay(timeZone: string, reference = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(reference);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour + minute / 60;
}

/**
 * The instant an account's calendar day closed.
 *
 * Derived by probing the account's own zone rather than by offset arithmetic,
 * so DST transitions are handled by the same mechanism that decides the
 * calendar date everywhere else. Returns null when the zone is unusable — the
 * caller must fail closed rather than substitute UTC.
 */
export function resolveAccountDayClosedAt(input: {
  date: string;
  timeZone: string;
}): Date | null {
  const nextDate = addDays(input.date, 1);
  try {
    for (let offsetHours = -14; offsetHours <= 14; offsetHours += 0.25) {
      const candidate = new Date(`${nextDate}T00:00:00Z`);
      candidate.setUTCMinutes(candidate.getUTCMinutes() + offsetHours * 60);
      if (
        getTodayIsoForTimeZoneServer(input.timeZone, candidate) === nextDate &&
        hoursIntoAccountDay(input.timeZone, candidate) < 0.25
      ) {
        return candidate;
      }
    }
  } catch {
    // An invalid IANA name throws inside Intl. Refuse rather than guess.
    return null;
  }
  return null;
}

/**
 * Which freshness tier a date is in, for a given account clock.
 *
 * Never returns a terminal state. `aged` means "past the configured conversion
 * window", which is the weakest claim in the set — not "will not change".
 */
export function resolveGoogleAdsFreshnessTier(input: {
  date: string;
  accountToday: string;
  dayClosedAt: Date | null;
  now?: Date;
  metricsSettleHours?: number;
  lookbackDays?: number;
}): GoogleAdsFreshnessTier {
  if (input.date >= input.accountToday) return "open";
  if (!input.dayClosedAt) return "settling";
  const now = input.now ?? new Date();
  const settleHours = input.metricsSettleHours ?? GOOGLE_ADS_METRICS_SETTLE_HOURS;
  const lookbackDays = input.lookbackDays ?? GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS;
  const hoursSinceClose = (now.getTime() - input.dayClosedAt.getTime()) / 3_600_000;
  if (hoursSinceClose < settleHours) return "settling";
  if (hoursSinceClose < lookbackDays * 24) return "converging";
  return "aged";
}

export interface GoogleAdsDayFreshnessRow {
  businessId: string;
  providerAccountId: string;
  scope: string;
  date: string;
  accountTimezone: string | null;
  dayClosedAt: string | null;
  lastObservedAt: string | null;
  metricsSettledAt: string | null;
  lookbackExhaustedAt: string | null;
  nextRefreshDueAt: string | null;
  freshnessTier: GoogleAdsFreshnessTier | null;
  observationCount: number;
}

/**
 * Record a COMPLETED provider fetch whose rows were persisted.
 *
 * This is the only writer of observation evidence, and it is called from the
 * lease-guarded completion path AFTER the fetch and all required writes
 * succeeded. It never asserts immutability — it records when we last looked and
 * when to look again.
 *
 * Idempotent and monotonic: replays advance the observation clock and the tier,
 * and can only move `nextRefreshDueAt` forward from the same evidence.
 */
export async function recordGoogleAdsDayObservation(input: {
  businessId: string;
  providerAccountId: string;
  scope: string;
  date: string;
  accountTimezone: string;
  dayClosedAt: Date | null;
  tier: GoogleAdsFreshnessTier;
  observedAt?: Date;
}): Promise<void> {
  const sql = getDb();
  const observedAt = (input.observedAt ?? new Date()).toISOString();
  const closedAt = input.dayClosedAt ? input.dayClosedAt.toISOString() : null;
  const settleMs = GOOGLE_ADS_METRICS_SETTLE_HOURS * 3_600_000;
  const metricsSettledAt = input.dayClosedAt
    ? new Date(input.dayClosedAt.getTime() + settleMs).toISOString()
    : null;
  const lookbackExhaustedAt = input.dayClosedAt
    ? new Date(
        input.dayClosedAt.getTime() +
          GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS * 24 * 3_600_000,
      ).toISOString()
    : null;
  const nextDueAt = new Date(
    (input.observedAt ?? new Date()).getTime() +
      GOOGLE_ADS_TIER_REFRESH_MINUTES[input.tier] * 60_000,
  ).toISOString();

  await sql`
    INSERT INTO google_ads_day_finality (
      business_id, provider_account_id, scope, date,
      account_timezone, day_closed_at, last_observed_at,
      metrics_settled_at, lookback_exhausted_at, next_refresh_due_at,
      freshness_tier, observation_count
    )
    VALUES (
      ${input.businessId}, ${input.providerAccountId}, ${input.scope}, ${input.date}::date,
      ${input.accountTimezone}, ${closedAt}::timestamptz, ${observedAt}::timestamptz,
      ${metricsSettledAt}::timestamptz, ${lookbackExhaustedAt}::timestamptz,
      ${nextDueAt}::timestamptz, ${input.tier}, 1
    )
    ON CONFLICT (business_id, provider_account_id, scope, date)
    DO UPDATE SET
      account_timezone = EXCLUDED.account_timezone,
      day_closed_at = COALESCE(google_ads_day_finality.day_closed_at, EXCLUDED.day_closed_at),
      -- Monotonic: an out-of-order replay can never rewind what we observed.
      last_observed_at = GREATEST(
        google_ads_day_finality.last_observed_at,
        EXCLUDED.last_observed_at
      ),
      metrics_settled_at = COALESCE(
        google_ads_day_finality.metrics_settled_at,
        EXCLUDED.metrics_settled_at
      ),
      lookback_exhausted_at = COALESCE(
        google_ads_day_finality.lookback_exhausted_at,
        EXCLUDED.lookback_exhausted_at
      ),
      next_refresh_due_at = GREATEST(
        google_ads_day_finality.next_refresh_due_at,
        EXCLUDED.next_refresh_due_at
      ),
      freshness_tier = EXCLUDED.freshness_tier,
      observation_count = google_ads_day_finality.observation_count + 1,
      updated_at = now()
  `;
}

/**
 * Whether a date has been observed by a real fetch taken AFTER its day closed.
 *
 * This is the predicate a rollover completion receipt must satisfy. It is
 * deliberately NOT called "final": it says the day is closed and we have looked
 * at it since, which is the strongest honest claim available.
 */
export async function hasPostCloseObservation(input: {
  businessId: string;
  providerAccountId: string;
  scope: string;
  date: string;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT 1 AS present
    FROM google_ads_day_finality
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND scope = ${input.scope}
      AND date = ${input.date}::date
      AND day_closed_at IS NOT NULL
      AND last_observed_at IS NOT NULL
      AND last_observed_at >= day_closed_at
    LIMIT 1
  `) as Array<{ present: number }>;
  return rows.length > 0;
}

/** Dates in the window with a post-close observation, newest first. */
export async function getGoogleAdsPostCloseObservedDates(input: {
  businessId: string;
  providerAccountId: string;
  scope: string;
  startDate: string;
  endDate: string;
}): Promise<string[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT to_char(date, 'YYYY-MM-DD') AS date
    FROM google_ads_day_finality
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND scope = ${input.scope}
      AND date >= ${input.startDate}::date
      AND date <= ${input.endDate}::date
      AND day_closed_at IS NOT NULL
      AND last_observed_at IS NOT NULL
      AND last_observed_at >= day_closed_at
    ORDER BY date DESC
  `) as Array<{ date: string }>;
  return rows.map((row) => row.date);
}

/**
 * The bounded, quota-aware set of dates due for a re-read.
 *
 * Due means: never observed, or `next_refresh_due_at` has passed. Ordered
 * newest-first so the most decision-relevant days refresh first, and hard-capped
 * by `limit` so the ~1/min planner can never enqueue the whole window on every
 * pass however much is outstanding.
 */
export async function getGoogleAdsDatesDueForRefresh(input: {
  businessId: string;
  providerAccountId: string;
  scope: string;
  startDate: string;
  endDate: string;
  limit: number;
  now?: Date;
}): Promise<string[]> {
  const sql = getDb();
  const now = (input.now ?? new Date()).toISOString();
  const limit = Math.max(0, Math.floor(input.limit));
  if (limit === 0) return [];
  const rows = (await sql`
    WITH window_dates AS (
      SELECT generate_series(
        ${input.startDate}::date,
        ${input.endDate}::date,
        interval '1 day'
      )::date AS date
    )
    SELECT to_char(window_dates.date, 'YYYY-MM-DD') AS date
    FROM window_dates
    LEFT JOIN google_ads_day_finality freshness
      ON freshness.business_id = ${input.businessId}
     AND freshness.provider_account_id = ${input.providerAccountId}
     AND freshness.scope = ${input.scope}
     AND freshness.date = window_dates.date
    WHERE freshness.date IS NULL
       OR freshness.next_refresh_due_at IS NULL
       OR freshness.next_refresh_due_at <= ${now}::timestamptz
    ORDER BY window_dates.date DESC
    LIMIT ${limit}
  `) as Array<{ date: string }>;
  return rows.map((row) => row.date);
}
