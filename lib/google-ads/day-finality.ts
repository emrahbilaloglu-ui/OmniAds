import { getDb } from "@/lib/db";
import { getTodayIsoForTimeZoneServer } from "@/lib/provider-platform-date";

/**
 * Google Ads date finality.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. Coverage is `SELECT DISTINCT date` — mere
 * row existence. So a date read once at 01:40 becomes "covered", every later
 * tick that day skips re-queueing it, and the D+1 path then marks it
 * finalize-complete WITHOUT calling Google. A day therefore freezes at its
 * first intraday read and is reported as settled forever.
 *
 * "Final" here means something a clock alone can never establish: the provider
 * was successfully fetched for that date AFTER the account's own timezone day
 * had closed. Elapsed time is not evidence. A row existing is not evidence.
 * Only a completed fetch, recorded against a closed day, is evidence.
 *
 * ABSENCE IS A THIRD STATE. A date with no row here predates this table. It is
 * neither trusted as final nor treated as an obligation to re-fetch all of
 * history — the rolling window below bounds what is reconsidered.
 */

/**
 * Google Ads restates a just-closed day for a while: conversions and some
 * metrics continue to settle after midnight. Finalizing at 00:00:01 would
 * record a number that is about to change.
 *
 * Deliberately a named constant with the reasoning attached rather than a bare
 * literal, because it is the one number here that is a judgement rather than a
 * fact. Conservative: a day is eligible to be called final only once this much
 * of the NEXT account-day has elapsed.
 */
export const GOOGLE_ADS_DAY_SETTLE_HOURS = 4;

/**
 * How far back the rolling reread reconsiders. Bounded on purpose: the cost is
 * (days x scopes x accounts) provider calls per pass, and an unbounded window
 * would re-read all history on every tick.
 */
export const GOOGLE_ADS_FINALITY_REREAD_WINDOW_DAYS = 3;

export type GoogleAdsDateTruthState = "provisional" | "settled";

/**
 * Whether a date is still mutable for an account.
 *
 * `provisional` = the account's day is open, or has closed too recently for the
 * provider's numbers to have settled. Such a date MUST stay re-readable and
 * must never be recorded as final.
 */
export function resolveGoogleAdsDateTruthState(input: {
  date: string;
  accountToday: string;
  /** Hours elapsed in the account's current day. */
  hoursIntoAccountToday: number;
  settleHours?: number;
}): GoogleAdsDateTruthState {
  const settleHours = input.settleHours ?? GOOGLE_ADS_DAY_SETTLE_HOURS;
  if (input.date >= input.accountToday) return "provisional";
  // The most recent closed day is settled only after the settle delay.
  const previousDate = addDays(input.accountToday, -1);
  if (input.date === previousDate && input.hoursIntoAccountToday < settleHours) {
    return "provisional";
  }
  return "settled";
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Hours elapsed in the account's current day, from the account's own clock.
 *
 * Computed by formatting "now" in the account timezone rather than by
 * subtracting offsets, so DST transitions cannot skew it.
 */
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
 * The instant an account's calendar day closed, as a timestamp.
 *
 * This is the `day_closed_at` proof the table's CHECK constraint requires, so
 * finality cannot be recorded without it.
 */
export function resolveAccountDayClosedAt(input: {
  date: string;
  timeZone: string;
}): Date | null {
  // Midnight at the START of the following day, in the account's zone. Derived
  // by probing rather than by offset arithmetic so DST is handled by the same
  // mechanism that decides the calendar date everywhere else.
  const nextDate = addDays(input.date, 1);
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
  return null;
}

export interface GoogleAdsDayFinalityRow {
  businessId: string;
  providerAccountId: string;
  scope: string;
  date: string;
  finalizedAt: string | null;
  dayClosedAt: string | null;
  lastFetchCompletedAt: string | null;
  attemptCount: number;
}

/**
 * Record that a date was OBSERVED. Never sets finality — that requires the
 * separate call below, which demands a closed-day proof.
 *
 * Idempotent: repeated observation bumps the attempt count and the last-fetch
 * time and cannot un-finalize an already-final date.
 */
export async function recordGoogleAdsDayObservation(input: {
  businessId: string;
  providerAccountId: string;
  scope: string;
  date: string;
  accountTimezone: string;
  fetchCompleted: boolean;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO google_ads_day_finality (
      business_id, provider_account_id, scope, date,
      account_timezone, last_fetch_completed_at, attempt_count
    )
    VALUES (
      ${input.businessId}, ${input.providerAccountId}, ${input.scope}, ${input.date}::date,
      ${input.accountTimezone},
      ${input.fetchCompleted ? new Date().toISOString() : null}::timestamptz,
      1
    )
    ON CONFLICT (business_id, provider_account_id, scope, date)
    DO UPDATE SET
      account_timezone = EXCLUDED.account_timezone,
      last_fetch_completed_at = COALESCE(
        EXCLUDED.last_fetch_completed_at,
        google_ads_day_finality.last_fetch_completed_at
      ),
      attempt_count = google_ads_day_finality.attempt_count + 1,
      updated_at = now()
  `;
}

/**
 * Record that a date is FINAL.
 *
 * Requires a real fetch and a closed day. The `day_closed_at` write is what the
 * table's CHECK constraint validates, so a caller that has not established the
 * day boundary cannot record finality even by mistake — the database refuses.
 *
 * Idempotent and monotonic: once final, `finalized_at` is never moved, so a
 * later replay cannot rewrite history.
 */
export async function markGoogleAdsDayFinal(input: {
  businessId: string;
  providerAccountId: string;
  scope: string;
  date: string;
  accountTimezone: string;
  dayClosedAt: Date;
  source: string;
}): Promise<void> {
  const sql = getDb();
  const closedAtIso = input.dayClosedAt.toISOString();
  await sql`
    INSERT INTO google_ads_day_finality (
      business_id, provider_account_id, scope, date,
      account_timezone, day_closed_at, finalized_at, finality_source,
      last_fetch_completed_at, attempt_count
    )
    VALUES (
      ${input.businessId}, ${input.providerAccountId}, ${input.scope}, ${input.date}::date,
      ${input.accountTimezone}, ${closedAtIso}::timestamptz, now(), ${input.source},
      now(), 1
    )
    ON CONFLICT (business_id, provider_account_id, scope, date)
    DO UPDATE SET
      account_timezone = EXCLUDED.account_timezone,
      day_closed_at = COALESCE(google_ads_day_finality.day_closed_at, EXCLUDED.day_closed_at),
      -- Monotonic: the FIRST final fetch is the one that counts.
      finalized_at = COALESCE(google_ads_day_finality.finalized_at, now()),
      finality_source = COALESCE(google_ads_day_finality.finality_source, EXCLUDED.finality_source),
      last_fetch_completed_at = now(),
      attempt_count = google_ads_day_finality.attempt_count + 1,
      updated_at = now()
  `;
}

/** Whether a specific date has recorded finality evidence. */
export async function isGoogleAdsDayFinal(input: {
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
      AND finalized_at IS NOT NULL
    LIMIT 1
  `) as Array<{ present: number }>;
  return rows.length > 0;
}

/** Dates within the window that already carry finality evidence. */
export async function getGoogleAdsFinalDates(input: {
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
      AND finalized_at IS NOT NULL
    ORDER BY date DESC
  `) as Array<{ date: string }>;
  return rows.map((row) => row.date);
}

/**
 * The bounded set of dates that must be re-read.
 *
 * A date is due when it is inside the rolling window and is NOT already final.
 * That covers all three cases the freeze produced: today (always mutable), a
 * just-closed day that has not been re-fetched since it closed, and a date that
 * predates this table and therefore has no proof either way.
 *
 * Bounded by construction — it can never return more than the window, whatever
 * the state of history.
 */
export function resolveGoogleAdsRereadDates(input: {
  accountToday: string;
  finalDates: readonly string[];
  windowDays?: number;
}): string[] {
  const windowDays = Math.max(
    1,
    input.windowDays ?? GOOGLE_ADS_FINALITY_REREAD_WINDOW_DAYS,
  );
  const final = new Set(input.finalDates);
  const dates: string[] = [];
  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = addDays(input.accountToday, -offset);
    if (!final.has(date)) dates.push(date);
  }
  return dates;
}
