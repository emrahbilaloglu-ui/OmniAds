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

/**
 * Diagnostic only — NOT a plan gate.
 *
 * The master plan defines G11 as representative LCP ≤ 2.5 s, CLS ≤ 0.1,
 * TBT ≤ 300 ms and no unbounded N+1. It sets no client-bundle budget at all.
 * This number is a local investigation trigger: crossing it means "go look",
 * not "the gate failed". Treating it as a blocker would be inventing an
 * authority the plan does not grant.
 */
export const SHARED_BASELINE_INVESTIGATION_KB = 400;

/** First-load API calls above which a fan-out is worth investigating. */
export const FIRST_LOAD_API_CALL_BUDGET = 12;
