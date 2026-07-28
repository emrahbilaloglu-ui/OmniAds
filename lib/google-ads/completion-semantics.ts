/**
 * The single decision for "is this Google Ads range complete?".
 *
 * WHY THIS IS CENTRAL. Around forty separate fields across the status route,
 * readiness helpers, progress UX and serving layer each derived "ready",
 * "100%", "Active", "synced through" or "stop polling" from the same weak
 * signal: whether a date has at least one warehouse row. A day read once at
 * 01:40 and never refreshed satisfies every one of them. Hand-patching forty
 * call sites would guarantee they drift apart again, so the decision lives
 * here and the surfaces consult it.
 *
 * WHAT IT WILL NOT CLAIM. Google publishes no instant at which a date stops
 * changing — clicks/cost carry ~1h freshness, conversions ~3h last-click and
 * ~15h for other models, reports are revised days later for invalid traffic and
 * late conversions, and a conversion can land on its original click date for
 * the whole conversion window (1-90 days, default 30). So nothing here returns
 * "final" or "immutable". The strongest verdict is `settled`, meaning: the day
 * closed, we fetched it after it closed, and the configured lookback has
 * elapsed. That is a policy statement about our own evidence, not a promise
 * from Google.
 */

export type GoogleAdsCompletionState =
  /**
   * The evidence could not be read at all — schema not ready, query failed, no
   * assigned accounts, unusable account timezone. Deliberately NOT "missing":
   * missing is a fact about the data, unknown is an admission about us. Both
   * are non-green, but only unknown means "ask again", so callers must keep
   * polling and must never present it as a completed or failed sync.
   */
  | "unknown"
  /** No rows at all for part of the range. */
  | "missing"
  /** Rows exist, but at least one date has never been observed after it closed. */
  | "provisional"
  /** Every date observed post-close; some still inside the conversion window. */
  | "converging"
  /** Every date observed post-close and past the configured lookback. */
  | "settled";

/**
 * Words a surface may show. Deliberately curated here rather than left to each
 * caller, because the wording IS the claim: "Final" and "Complete" were the
 * labels that made a frozen day look trustworthy. `settled` renders as
 * "Policy-settled" — settled against OUR configured lookback, not a promise
 * from Google that the numbers have stopped moving.
 */
export const GOOGLE_ADS_COMPLETION_LABELS: Record<GoogleAdsCompletionState, string> = {
  unknown: "Unknown",
  missing: "Missing data",
  provisional: "Provisional",
  converging: "Refreshing",
  settled: "Policy-settled",
};

/**
 * The fail-closed verdict. Every read path that cannot produce evidence must
 * return this rather than falling back to coverage, which is exactly the
 * substitution that produced a green 100% over a day captured at 01:40.
 */
export function unknownGoogleAdsCompletion(reason: string): GoogleAdsCompletionVerdict {
  return {
    state: "unknown",
    percent: 0,
    complete: false,
    mayStopPolling: false,
    detail: reason,
  };
}

export interface GoogleAdsCompletionInput {
  /** Calendar days in the requested range. */
  totalDays: number;
  /** Days with at least one warehouse row — the OLD notion of complete. */
  coveredDays: number;
  /** Days with an observation taken after that account's day closed. */
  postCloseObservedDays: number;
  /** Days past the configured conversion lookback. */
  lookbackExhaustedDays: number;
  /**
   * Whether the range includes the account's open day. An open day can never
   * be complete, so a range containing it is capped below 100.
   */
  includesOpenDay: boolean;
}

export interface GoogleAdsCompletionVerdict {
  state: GoogleAdsCompletionState;
  /**
   * Percent complete, computed from POST-CLOSE OBSERVED days rather than
   * covered days. Never reaches 100 while any date is unobserved or open.
   */
  percent: number;
  /** Safe for a caller to present as done. Only ever true for `settled`. */
  complete: boolean;
  /**
   * Whether a poller may stop. Deliberately false for anything short of
   * settled: a frozen day previously made the UI stop refreshing itself, which
   * is what let it stay wrong.
   */
  mayStopPolling: boolean;
  /** Short, honest description for a surface that wants to say why. */
  detail: string;
}

export function resolveGoogleAdsCompletion(
  input: GoogleAdsCompletionInput,
): GoogleAdsCompletionVerdict {
  const totalDays = Math.max(0, Math.floor(input.totalDays));
  if (totalDays === 0) {
    return {
      state: "missing",
      percent: 0,
      complete: false,
      mayStopPolling: false,
      detail: "No days requested.",
    };
  }
  const covered = clamp(input.coveredDays, totalDays);
  const observed = clamp(input.postCloseObservedDays, totalDays);
  const exhausted = clamp(input.lookbackExhaustedDays, observed);

  // Progress is measured in days we have actually re-read after they closed.
  // Covered days are what froze; counting them is what produced a green 100%
  // over a day captured at 01:40.
  const rawPercent = Math.floor((observed / totalDays) * 100);

  if (covered < totalDays) {
    return {
      state: "missing",
      percent: Math.min(99, rawPercent),
      complete: false,
      mayStopPolling: false,
      detail: `${totalDays - covered} of ${totalDays} days have no data yet.`,
    };
  }
  if (observed < totalDays || input.includesOpenDay) {
    const pending = totalDays - observed;
    return {
      state: "provisional",
      percent: Math.min(99, rawPercent),
      complete: false,
      mayStopPolling: false,
      detail: input.includesOpenDay
        ? "This range includes today, which is still changing."
        : `${pending} of ${totalDays} days have not been re-read since they closed.`,
    };
  }
  if (exhausted < totalDays) {
    return {
      state: "converging",
      // Deliberately capped: every day has been re-read after closing, but
      // conversions can still arrive within the lookback window, so this is
      // not "done".
      percent: 99,
      complete: false,
      mayStopPolling: false,
      detail:
        "All days re-read after closing; conversions may still arrive within the conversion window.",
    };
  }
  return {
    state: "settled",
    percent: 100,
    complete: true,
    mayStopPolling: true,
    detail: "All days re-read after closing and past the conversion window.",
  };
}

function clamp(value: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), max));
}
