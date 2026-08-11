/**
 * WP-26 / G11 budgets.
 *
 * In `lib/` rather than `scripts/` so the Playwright spec can import them:
 * Playwright applies a CommonJS transform to anything a spec pulls in, and a
 * script using `import.meta.url` breaks that.
 */

/** The plan's G11 thresholds. */
export const LCP_BUDGET_MS = 2500;
export const CLS_BUDGET = 0.1;
export const TBT_BUDGET_MS = 300;

/** Shared client JS every route pays, in KB, above which we investigate. */
export const SHARED_BASELINE_BUDGET_KB = 400;

/** First-load API calls above which a fan-out is worth investigating. */
export const FIRST_LOAD_API_CALL_BUDGET = 12;
