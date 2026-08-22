/**
 * The Launchpad candidate window, stated once so the label cannot drift from
 * the read.
 *
 * The creative fetch asked for `isoDateDaysAgo(29)` → today — thirty inclusive
 * days — while the creative table's column header read "28d metrics". Two
 * numbers for one window, and the one the operator could see was the wrong one:
 * every spend, ROAS and CTR in that table covered two more days than it
 * claimed. That is the master plan's WP5 item 3, and the reason this is a
 * shared constant rather than a literal in each place.
 *
 * This is a **candidate-evidence** window and is deliberately separate from the
 * shell's reporting range (§8.1 "mixed"): Launchpad also shows current provider
 * target state, which no date range scopes. The two are never merged.
 */
export const LAUNCHPAD_CANDIDATE_WINDOW_DAYS = 30;

/** Derived, so changing the window changes every label that names it. */
export const LAUNCHPAD_CANDIDATE_WINDOW_LABEL = `${LAUNCHPAD_CANDIDATE_WINDOW_DAYS}d metrics`;
