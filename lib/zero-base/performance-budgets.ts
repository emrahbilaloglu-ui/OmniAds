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

/**
 * First-load duplicates that are measured, root-caused and still open.
 *
 * Every entry is a URL a mounted Meta surface requests more than once on a
 * single load, recorded with the reason. Anything not on this list fails the
 * runtime gate, so the debt can shrink but cannot grow quietly.
 *
 * The two that are gone were the ones worth the risk: `/api/auth/me` was
 * requested twice on every page in the product (the bootstrap effect depended
 * on the status its own first act set), and `screen_view` was emitted twice on
 * every Meta surface (the once-per-screen guard was a ref, and the shell's
 * emitter remounts during first load). Both are fixed and neither appears here.
 *
 * What remains is legacy fan-out with more than one owner, and untangling it
 * needs a change to how the integrations store is filled rather than a local
 * fix at the call site.
 */
export const KNOWN_DUPLICATE_FIRST_LOAD_READS: readonly string[] = [
  // `use-business-integrations-bootstrap` fills the manifest under a lock, and
  // `use-integration-connection.fetchStatuses` re-reads the same URL on mount
  // to clear stale "connecting" state. Both sync the same store.
  "/api/integrations",
  // The Integrations surface asks each provider for its status while the
  // manifest read is already in flight, so Meta is asked three times and
  // Google Ads twice.
  "/api/meta/status",
  "/api/google-ads/status",
  // Automation reads its control plane once for the page and once for the
  // guardrail panel.
  "/api/meta/automation",
];

/**
 * Surfaces measured above `FIRST_LOAD_API_CALL_BUDGET`, with the count.
 *
 * Recorded rather than waived: the number is the measurement, and the gate
 * fails if a surface exceeds the figure written here. Launchpad and
 * Integrations are both composition screens that ask every provider for its
 * own state; Creative Studio adds the share ledger and the brief authority.
 */
export const FIRST_LOAD_API_CALL_DEBT: Readonly<Record<string, number>> = {
  "meta-launchpad": 16,
  "manage-integrations": 17,
  "creative-studio": 13,
};
