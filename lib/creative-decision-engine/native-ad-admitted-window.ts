/**
 * Which of an ad's days may form ONE observation.
 *
 * ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
 *
 * The rule was all-or-nothing: every positive-spend day in the 90-day window had
 * to resolve a context, and one that did not eliminated the whole ad. Measured on
 * ColorFull at 2026-09-22 over a full 90-day window — 1,409 ad-days, 30 candidate
 * ads — that rule discarded 25 of the 30 as `missingContext`. It could not have
 * done otherwise: 311 of the 1,409 ad-days carry no objective provenance and 517
 * no optimization-goal provenance, a direct consequence of the provider-side
 * `campaign_configs` break, and at roughly 47 ad-days per ad the chance that an
 * ad has NO such day is near zero.
 *
 * The failure compounds forward. A gap in August keeps killing an ad every day
 * until it ages out of the window — a full quarter after the source is repaired —
 * while fresh, corroborated receipts arrive daily and change nothing. An ad with
 * thirty consecutive verified days at the recent end was thrown away because of a
 * day two months earlier that nobody will ever observe again.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Admit the LATEST maximal contiguous run of economically meaningful days that
 * share one resolvable context. Everything outside it is dropped and counted.
 *
 * Three properties earn their place:
 *
 *   AN UNRESOLVED DAY IS NOT A BRIDGE. Days on the far side of a day that HAS a
 *   row and fails to resolve a context are not merged back in, even when their
 *   context matches. Merging would assume the configuration held across a day we
 *   looked at and could not read.
 *
 *   A MISSING CALENDAR DAY IS NOT THE SAME THING, and the run does span one. The
 *   warehouse holds a row only for a day the ad delivered, so an ad that paused
 *   over a weekend simply has no rows for it; splitting there would shred every
 *   intermittently delivering ad for a reason that has nothing to do with its
 *   configuration. What the run therefore asserts is precise and narrower than
 *   "the configuration held every day": EVERY OBSERVED ECONOMIC DAY between
 *   `startDate` and `endDate` carried this context. How sparse that is, is not
 *   left implicit — `observedDayCount` against `calendarDaySpan` says it, and
 *   `missingCalendarDays` is the difference.
 *
 *   The residual assumption is that a day with no row is a day with no delivery.
 *   That is an ingest-completeness question rather than a configuration one, and
 *   it is answered elsewhere: monthly `meta_ad_daily` and `meta_campaign_daily`
 *   spend reconcile exactly (2026-09: 913,581 = 913,581) with no unfinalized
 *   rows. If that ever stops being true, a missing day stops being evidence of
 *   absence and this rule has to be revisited — which is why the count is
 *   carried rather than the assumption being buried here.
 *
 *   A CHANGE SPLITS, IT DOES NOT KILL. An ad whose objective genuinely changed
 *   mid-window used to be discarded as `mixedContext`. Its post-change days are
 *   real, internally consistent evidence about what it is now, and the run ends
 *   at the change rather than the ad ending at it.
 *
 *   AN EMPTY DAY IS TRANSPARENT. A day with no spend, no conversions and no
 *   revenue contributes nothing to any economy computed from the run, so it
 *   neither extends a run nor breaks one. Only all three being zero counts as
 *   empty: a zero-spend day carrying a late-attributed conversion or revenue is
 *   economically real and is classified like any other.
 *
 * What this deliberately does NOT do is step over a trailing unresolvable day for
 * free and pretend the run is current. The run simply ends earlier, and
 * `endDate` says so — the staleness is reported rather than forbidden, and the
 * existing recency machinery reads it like any other `sourceMaxDate`.
 *
 * Authority is a SEPARATE question answered elsewhere. This decides which days
 * may form an observation at all — it asks whether the config VALUES are present
 * and consistent. Whether those values were well enough observed to carry a hard
 * decision is `resolveVerifiedAuthoritySuffix` and the config-authority counts,
 * computed over the window this returns. Collapsing the two would gut the
 * product while the provider-side source is broken: on the accounts measured,
 * only 23-49% of spend currently rests on authoritative config.
 */

export interface AdmittedContextWindowDay {
  date: string;
  spend: number;
  conversions: number;
  revenue: number;
  /**
   * A stable key for the day's context, or null when it does not resolve.
   *
   * A KEY rather than the context object, so this module never has to know what
   * a context is made of; the caller decides what counts as "the same".
   */
  contextKey: string | null;
}

export type AdmittedContextWindowReason =
  /** A run was found. */
  | "admitted"
  /** Every economically meaningful day failed to resolve a context. */
  | "no_context_day"
  /** The ad had no economically meaningful day at all. */
  | "no_economic_day";

export interface AdmittedContextWindow<T> {
  rows: T[];
  contextKey: string | null;
  startDate: string | null;
  endDate: string | null;
  reason: AdmittedContextWindowReason;
  /** Economically meaningful days before the run: an older gap or another context. */
  droppedOlderDays: number;
  /** Economically meaningful days after the run: it does not reach the window end. */
  droppedNewerDays: number;
  /** The run ended where a resolvable context CHANGED, not where evidence stopped. */
  truncatedByChange: boolean;
  /** The run ended at a day whose context did not resolve at all. */
  truncatedByGap: boolean;
  /** Days with a row inside the run — what the context claim actually covers. */
  observedDayCount: number;
  /** Calendar days from `startDate` to `endDate` inclusive. */
  calendarDaySpan: number;
  /** Calendar days inside the run with no row at all. See the note above. */
  missingCalendarDays: number;
}

/** Calendar days from `from` to `to` inclusive; 0 if either is unreadable. */
function calendarSpan(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

function isEconomicallyEmpty(day: AdmittedContextWindowDay): boolean {
  return (
    (day.spend || 0) === 0 &&
    (day.conversions || 0) === 0 &&
    (day.revenue || 0) === 0
  );
}

export function resolveAdmittedContextWindow<T>(
  days: readonly T[],
  read: (day: T) => AdmittedContextWindowDay,
): AdmittedContextWindow<T> {
  const ordered = [...days].sort((left, right) =>
    read(left).date.localeCompare(read(right).date),
  );
  const empty: AdmittedContextWindow<T> = {
    rows: [],
    contextKey: null,
    startDate: null,
    endDate: null,
    reason: "no_economic_day",
    droppedOlderDays: 0,
    droppedNewerDays: 0,
    truncatedByChange: false,
    truncatedByGap: false,
    observedDayCount: 0,
    calendarDaySpan: 0,
    missingCalendarDays: 0,
  };

  /* Indices of the days that can carry economic weight, newest last. */
  const economic: number[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    if (!isEconomicallyEmpty(read(ordered[i]!))) economic.push(i);
  }
  if (economic.length === 0) return empty;

  /*
    Walk back to the newest day that resolves a context. Days after it are
    dropped and counted; the run is then as recent as the evidence allows,
    and `endDate` reports how recent that is.
  */
  let last = economic.length - 1;
  while (last >= 0 && read(ordered[economic[last]!]!).contextKey === null) {
    last -= 1;
  }
  if (last < 0) {
    return {
      ...empty,
      reason: "no_context_day",
      droppedNewerDays: economic.length,
    };
  }

  const contextKey = read(ordered[economic[last]!]!).contextKey!;
  let first = last;
  let truncatedByChange = false;
  let truncatedByGap = false;
  while (first - 1 >= 0) {
    const candidate = read(ordered[economic[first - 1]!]!);
    if (candidate.contextKey === null) {
      truncatedByGap = true;
      break;
    }
    if (candidate.contextKey !== contextKey) {
      truncatedByChange = true;
      break;
    }
    first -= 1;
  }

  /*
    Empty days INSIDE the run come with it: they are transparent to the rule, and
    excluding them would silently reshape an ad's window for no reason — a
    zero-spend day between two admitted days is part of the same stretch of time.
  */
  const startIndex = economic[first]!;
  const endIndex = economic[last]!;
  const rows = ordered.slice(startIndex, endIndex + 1);
  const startDate = read(ordered[startIndex]!).date;
  const endDate = read(ordered[endIndex]!).date;
  /* Distinct dates, because a day can legitimately carry more than one row. */
  const observedDayCount = new Set(rows.map((row) => read(row).date)).size;
  const calendarDaySpan = calendarSpan(startDate, endDate);
  return {
    rows,
    contextKey,
    startDate,
    endDate,
    reason: "admitted",
    droppedOlderDays: first,
    droppedNewerDays: economic.length - 1 - last,
    truncatedByChange,
    truncatedByGap,
    observedDayCount,
    calendarDaySpan,
    missingCalendarDays: Math.max(0, calendarDaySpan - observedDayCount),
  };
}
