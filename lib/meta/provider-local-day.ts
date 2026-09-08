/**
 * THE END OF A PROVIDER-LOCAL DAY, AS AN ABSOLUTE INSTANT.
 *
 * ── ROUND 10 ITEM 4 ────────────────────────────────────────────────────────
 * Two historical readers bounded a `timestamptz` column against a DATE:
 *
 *     AND outcome_log.occurred_at  < (${cutoff}::date + 1)
 *     AND captured_at              < (${cutoff}::date + 1)
 *
 * PostgreSQL casts the `date` on the right to `timestamptz` using the SESSION's
 * `TimeZone` setting. So the boundary of "the served day" was whatever timezone
 * the connection happened to be configured with — not the advertiser's. On a
 * UTC session reading a Los Angeles account, the window ended eight hours early
 * and silently dropped the last third of the account's own day; on an Istanbul
 * account it ended three hours late and pulled in evidence from the next day.
 * Both directions change a confidence signal that can carry a recommendation
 * into the act lane.
 *
 * What this module produces instead is an absolute instant — the first moment
 * of the NEXT provider-local day — computed from the account's own IANA
 * timezone and bound into the query as a `timestamptz`. A `timestamptz`
 * compared to a `timestamptz` has no session dependency at all.
 *
 * FAIL CLOSED. A missing, blank, or non-IANA timezone yields `null`, and the
 * callers answer "no history" rather than guessing UTC. Guessing is what the
 * defect already did.
 */

/**
 * Is this a real IANA zone THIS runtime can resolve?
 *
 * `Intl.DateTimeFormat` throws `RangeError` on an unknown identifier, which is
 * the only trustworthy check available without shipping a tz database. A
 * fixed-offset string like `"+03:00"` is refused on purpose: it cannot express
 * a DST transition, and an account whose zone observes one would be wrong for
 * half the year.
 */
export function isSupportedIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  // A real zone identifier always has a region component; `UTC` is the one
  // conventional exception and is accepted explicitly.
  if (trimmed !== "UTC" && !/^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+\-/]+$/.test(trimmed)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * The UTC offset, in minutes, that `timeZone` was observing at `instant`.
 *
 * Derived by asking `Intl` to render the instant in that zone and reading the
 * calendar fields back — the standard way to get a historically correct offset
 * without a tz library, and correct across DST because the offset is sampled at
 * the instant rather than assumed.
 */
interface ZoneWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zoneWallClock(instantMs: number, timeZone: string): ZoneWallClock {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = new Map(
    formatter
      .formatToParts(new Date(instantMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    // `hour12: false` can render midnight as "24"; normalise it.
    hour: Number(parts.get("hour")) % 24,
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
  };
}

function zoneCalendarDate(instantMs: number, timeZone: string): string {
  const wall = zoneWallClock(instantMs, timeZone);
  return `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

function zoneOffsetMinutes(instantMs: number, timeZone: string): number {
  const wall = zoneWallClock(instantMs, timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return (asUtc - instantMs) / 60_000;
}

function parseRealCalendarDay(
  value: unknown,
): { year: number; month: number; dayOfMonth: number } | null {
  if (typeof value !== "string") return null;
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const monthStart = Date.UTC(year!, month! - 1, 1);
  if (!Number.isFinite(monthStart)) return null;
  if (month! < 1 || month! > 12) return null;
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (dayOfMonth! < 1 || dayOfMonth! > daysInMonth) return null;
  return { year: year!, month: month!, dayOfMonth: dayOfMonth! };
}

/**
 * The absolute instant at which the provider-local day `day` ENDS.
 *
 * Returned as an exclusive upper bound: the first moment of `day + 1` in the
 * account's own zone. Null when the day or the zone is unusable.
 *
 * The offset that applies at the target wall-clock moment is not necessarily
 * the offset at the naive UTC guess. More importantly, local midnight can be a
 * DST gap or overlap: a fixed-point iteration can then oscillate between the
 * offsets on either side and return neither boundary. We sample both sides of
 * the target, build the midnight candidate for every observed offset, and
 * accept only a candidate whose instant is the actual forward crossing into
 * the intended next local date. This explicitly handles a skipped midnight
 * (the first clock time may be 01:00) and a repeated midnight (the first
 * crossing wins). If that date never exists, the function fails closed.
 */
export function providerLocalDayEndExclusive(input: {
  /** `YYYY-MM-DD`, the last provider-local day the window includes. */
  day: string;
  timeZone: string;
}): Date | null {
  const parsedDay = parseRealCalendarDay(input.day);
  if (!parsedDay) return null;
  if (!isSupportedIanaTimeZone(input.timeZone)) return null;

  // Midnight at the start of the NEXT local day, expressed as if UTC.
  const naiveNextMidnightUtc = Date.UTC(
    parsedDay.year,
    parsedDay.month - 1,
    parsedDay.dayOfMonth + 1,
  );
  if (!Number.isFinite(naiveNextMidnightUtc)) return null;

  const targetLocalDay = new Date(naiveNextMidnightUtc)
    .toISOString()
    .slice(0, 10);
  const offsetSampleDistanceMs = 36 * 60 * 60 * 1_000;
  const offsets = new Set(
    [
      naiveNextMidnightUtc - offsetSampleDistanceMs,
      naiveNextMidnightUtc,
      naiveNextMidnightUtc + offsetSampleDistanceMs,
    ].map((instantMs) => zoneOffsetMinutes(instantMs, input.timeZone)),
  );
  const candidates = [
    ...new Set(
      [...offsets]
        .filter(Number.isFinite)
        .map(
          (offsetMinutes) =>
            naiveNextMidnightUtc - offsetMinutes * 60_000,
        ),
    ),
  ].sort((left, right) => left - right);

  for (const candidate of candidates) {
    if (
      zoneCalendarDate(candidate, input.timeZone) === targetLocalDay &&
      zoneCalendarDate(candidate - 1, input.timeZone) < targetLocalDay
    ) {
      return new Date(candidate);
    }
  }
  return null;
}

/**
 * The trusted, ACCOUNT-SCOPED timezone read.
 *
 * Joined through `business_provider_accounts` so the zone can only come from an
 * account this business is actually assigned — a bare `provider_accounts`
 * lookup would let one business's window be bounded by another's advertiser
 * zone. The physical binding columns are matched exactly, the same way every
 * other account-scoped read in this codebase matches them.
 */
const READ_META_ACCOUNT_TIMEZONE_SQL = `
SELECT account.timezone AS timezone
FROM business_provider_accounts binding
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE binding.business_id = $1
  AND binding.provider = 'meta'
  AND binding.provider_account_id = $2
LIMIT 1
`;

/**
 * Resolve the exclusive end instant of one provider-local day for one account.
 *
 * Null on ANY of: no binding, a null/blank zone, a zone this runtime cannot
 * resolve, or an unusable day. Every one of those is "we cannot say where this
 * account's day ends", and the callers turn it into "no history" rather than
 * into a UTC guess — because a UTC guess is the defect.
 */
export async function resolveMetaProviderLocalDayEnd(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  query: (
    text: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>;
}): Promise<Date | null> {
  const providerAccountId = input.providerAccountId?.trim() ?? "";
  if (!providerAccountId) return null;
  const rows = await input
    .query(READ_META_ACCOUNT_TIMEZONE_SQL, [input.businessId, providerAccountId])
    .catch(() => null);
  if (!rows || rows.length !== 1) return null;
  const timeZone = rows[0]?.timezone;
  if (!isSupportedIanaTimeZone(timeZone)) return null;
  return providerLocalDayEndExclusive({ day: input.day, timeZone });
}

/**
 * The absolute instant at which the provider-local day `day` BEGINS.
 *
 * The start of day D is the end of day D-1, so it is derived from the same
 * two-pass offset resolution rather than restated — a second implementation is
 * a second chance to place a DST boundary differently from the first.
 */
export function providerLocalDayStartInclusive(input: {
  day: string;
  timeZone: string;
}): Date | null {
  const parsedDay = parseRealCalendarDay(input.day);
  if (!parsedDay) return null;
  const previous = new Date(
    Date.UTC(
      parsedDay.year,
      parsedDay.month - 1,
      parsedDay.dayOfMonth - 1,
    ),
  );
  if (!Number.isFinite(previous.getTime())) return null;
  return providerLocalDayEndExclusive({
    day: previous.toISOString().slice(0, 10),
    timeZone: input.timeZone,
  });
}

/**
 * The provider-local CALENDAR DATE an absolute instant falls on.
 *
 * ── ROUND 11 ITEM 1 ────────────────────────────────────────────────────────
 * `entity-signals-backfill.ts` derived this with
 * `new Date(value).toISOString().slice(0, 10)` — the UTC date. For a Los
 * Angeles account an edit at 23:30 local on the 5th is 06:30Z on the 6th, so
 * it was attributed to the WRONG DAY, and `daysSinceSignificantEdit` came out
 * one short or one long. That number is compared against 7 to decide whether a
 * recent-edit veto still holds a purchase-budget hard action, so an off-by-one
 * day is an off-by-one on the veto itself.
 */
export function providerLocalCalendarDate(input: {
  instant: Date | string | number;
  timeZone: string;
}): string | null {
  if (!isSupportedIanaTimeZone(input.timeZone)) return null;
  const instant =
    input.instant instanceof Date ? input.instant : new Date(input.instant);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Map(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/**
 * The trusted IANA timezone for each of several accounts of one business.
 *
 * The single-account reader above answers one day-end; a backfill scoped to a
 * whole business needs the zone per account, because a business can carry
 * accounts in different zones and one account's calendar must never bound
 * another's history. Accounts with no binding, a null zone or an unresolvable
 * zone are ABSENT from the map — callers read absence as "cannot establish"
 * and fail closed.
 */
export async function readMetaAccountTimeZones(input: {
  businessId: string;
  providerAccountIds: readonly string[];
  query: (
    text: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>;
}): Promise<Map<string, string>> {
  const accountIds = Array.from(
    new Set(
      input.providerAccountIds
        .map((value) => value?.trim() ?? "")
        .filter((value) => value.length > 0),
    ),
  );
  const resolved = new Map<string, string>();
  if (accountIds.length === 0) return resolved;
  const rows = await input
    .query(
      `
      SELECT binding.provider_account_id AS provider_account_id,
             account.timezone AS timezone
      FROM business_provider_accounts binding
      JOIN provider_accounts account
        ON account.id = binding.provider_account_ref_id
       AND account.external_account_id = binding.provider_account_id
      WHERE binding.business_id = $1
        AND binding.provider = 'meta'
        AND binding.provider_account_id = ANY($2::text[])
      `,
      [input.businessId, accountIds],
    )
    .catch(() => null);
  if (!rows) return resolved;
  for (const row of rows) {
    const accountId =
      typeof row.provider_account_id === "string"
        ? row.provider_account_id
        : null;
    if (!accountId) continue;
    if (!isSupportedIanaTimeZone(row.timezone)) continue;
    // A duplicate binding is ambiguity, not a choice to make.
    if (resolved.has(accountId) && resolved.get(accountId) !== row.timezone) {
      resolved.delete(accountId);
      continue;
    }
    resolved.set(accountId, String(row.timezone).trim());
  }
  return resolved;
}
