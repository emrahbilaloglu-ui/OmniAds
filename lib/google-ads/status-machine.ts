/**
 * The Google Ads status state machine.
 *
 * WHAT WAS WRONG. `decideGoogleAdsStatusState` fell through to "ready", and the
 * only thing standing between a workspace and that green state was a set of
 * flags derived from row existence: `coreUsable`, `needsBootstrap`,
 * `productPendingSurfaces` and `historicalProgressPercent < 100`. Once coverage
 * hit 730/730 the percent hit 100, the pending list emptied, and the machine
 * said "ready" over dates nobody had re-read since the moment they were first
 * captured. `decideGoogleAdsAdvisorReadiness` was worse: it returned `ready`
 * with no freshness input at all, so the advisor could act on intraday-frozen
 * numbers.
 *
 * WHAT CHANGED. Both decisions now take a `GoogleAdsCompletionVerdict`.
 * "ready" requires `complete === true`, which only `settled` produces, and an
 * `unknown` verdict routes to `syncing` — non-green, retryable, and never
 * mistaken for a failure, because `unknown` means we could not look, not that
 * something broke.
 */

import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import { GOOGLE_ADS_ADVISOR_READINESS_MODEL } from "@/lib/google-ads/advisor-readiness";
import type {
  GoogleAdsCompletionState,
  GoogleAdsCompletionVerdict,
} from "@/lib/google-ads/completion-semantics";

export interface GoogleAdsStatusDecisionInput {
  connected: boolean;
  assignedAccountCount: number;
  coreUsable: boolean;
  historicalQueuePaused: boolean;
  deadLetterPartitions: number;
  advisorRelevantDeadLetterPartitions?: number;
  advisorRelevantUnhealthyLeases?: number;
  advisorRelevantFailedPartitions?: number;
  latestSyncStatus?: string | null;
  runningJobs: number;
  staleRunningJobs: number;
  selectedRangeCoreIncomplete: boolean;
  visibleSelectedRangePendingSurfaces: string[];
  /**
   * Display only. Must be `historicalCompletion.percent` (that is what
   * `buildGoogleAdsCoreReadiness` returns); it no longer gates any state, so a
   * stale or hand-computed value cannot open the door to "ready".
   */
  historicalProgressPercent: number;
  needsBootstrap: boolean;
  productPendingSurfaces: string[];
  selectedRangeTotalDays: number | null;
  advisorMissingSurfaces: string[];
  supportWindowMissingCount?: number;
  /**
   * The authoritative freshness verdict for the core historical range —
   * `buildGoogleAdsCoreReadiness(...).historicalCompletion`. Required: there is
   * no coverage-shaped fallback, because falling back to coverage is the defect.
   */
  historicalCompletion: GoogleAdsCompletionVerdict;
}

export interface GoogleAdsAdvisorDecision {
  ready: boolean;
  notReady: boolean;
  readinessModel: typeof GOOGLE_ADS_ADVISOR_READINESS_MODEL;
  /** True when freshness — not missing surfaces — is what blocks the advisor. */
  freshnessBlocked: boolean;
  /** The verdict state the decision was taken against. */
  recentCompletionState: GoogleAdsCompletionState;
}

export interface GoogleAdsFullSyncPriorityDecision {
  required: boolean;
  reason: string | null;
  targetScopes: string[];
}

/**
 * Whether the advisor may act on the recent window.
 *
 * The bar is deliberately NOT `complete`. The advisor's window is a rolling
 * recent range, so part of it is always inside the conversion lookback and it
 * would never be `settled` — demanding `settled` here would mean the advisor is
 * permanently unavailable. The bar is instead "every day in the window has been
 * re-read after it closed", which is what `converging` and `settled` assert and
 * what `provisional` denies. That is exactly the property the frozen-at-01:40
 * day lacked.
 *
 * The caller must therefore pass a verdict measured over CLOSED days only: an
 * open day forces `provisional` by construction, which would make this
 * permanently false. The status route's advisor window already ends at
 * yesterday, which satisfies that.
 */
function isRecentWindowObservedPostClose(state: GoogleAdsCompletionState) {
  return state === "converging" || state === "settled";
}

export function decideGoogleAdsAdvisorReadiness(
  input: Pick<
    GoogleAdsStatusDecisionInput,
    | "connected"
    | "assignedAccountCount"
    | "deadLetterPartitions"
  > & {
    recentSupportReady: boolean;
    snapshotAvailable: boolean;
    /**
     * Freshness verdict for the advisor's recent decision window, measured over
     * closed days only. Pass `unknownGoogleAdsCompletion(reason)` when the
     * evidence could not be read — the advisor then stays not-ready.
     */
    recentCompletion: GoogleAdsCompletionVerdict;
  }
): GoogleAdsAdvisorDecision {
  const recentCompletionState = input.recentCompletion.state;
  const windowObserved = isRecentWindowObservedPostClose(recentCompletionState);

  const ready =
    input.connected &&
    input.assignedAccountCount > 0 &&
    input.recentSupportReady &&
    windowObserved;

  // Previously this required `!recentSupportReady`, so an advisor blocked only
  // by stale data reported neither ready nor not-ready. Any connected,
  // assigned workspace that is not ready is now explicitly not ready.
  const notReady =
    input.connected &&
    input.assignedAccountCount > 0 &&
    !ready;

  return {
    ready,
    notReady,
    readinessModel: GOOGLE_ADS_ADVISOR_READINESS_MODEL,
    freshnessBlocked: input.recentSupportReady && !windowObserved,
    recentCompletionState,
  };
}

export function decideGoogleAdsFullSyncPriority(input: {
  advisorReady: boolean;
  advisorMissingSurfaces: string[];
}) : GoogleAdsFullSyncPriorityDecision {
  const targetScopes = input.advisorMissingSurfaces.filter((scope) =>
    ["search_term_daily", "product_daily", "asset_daily"].includes(scope)
  );
  const primaryBlocker = targetScopes.some(
    (scope) => scope === "search_term_daily" || scope === "product_daily"
  );
  const required = !input.advisorReady && primaryBlocker;

  return {
    required,
    reason: required
      ? "Advisor blocked by missing extended historical support; prioritizing full sync."
      : null,
    targetScopes,
  };
}

export function decideGoogleAdsStatusState(
  input: GoogleAdsStatusDecisionInput & {
    advisorNotReady: boolean;
  }
): GoogleAdsStatusResponse["state"] {
  const completionState = input.historicalCompletion.state;
  const evidenceAvailable = completionState !== "unknown";

  if (!input.connected) return "not_connected";
  if (input.assignedAccountCount === 0) return "connected_no_assignment";
  // "Paused" asserts that history is incomplete AND nothing is working on it.
  // With an `unknown` verdict we cannot support the first half, so we do not
  // make the claim; the `unknown` branch below keeps the workspace retryable.
  if (input.historicalQueuePaused && evidenceAvailable) return "paused";
  // Independently observed failures still win over `unknown`. A dead-lettered
  // partition is a fact about the queue, not about freshness, and suppressing
  // it because we could not read freshness would hide a real incident.
  if ((input.advisorRelevantDeadLetterPartitions ?? 0) > 0) return "action_required";
  if ((input.advisorRelevantFailedPartitions ?? 0) > 0) return "action_required";
  if ((input.advisorRelevantUnhealthyLeases ?? 0) > 0) return "action_required";
  if (input.latestSyncStatus === "failed" && input.runningJobs === 0) return "action_required";
  if (input.staleRunningJobs > 0) return "stale";
  // `unknown` on its own is never green and never terminal: we could not read
  // the evidence, so the only honest state is "still working on it, ask again".
  if (!evidenceAvailable) return "syncing";
  if (
    input.latestSyncStatus === "running" ||
    input.runningJobs > 0 ||
    input.needsBootstrap ||
    !input.coreUsable ||
    input.selectedRangeCoreIncomplete
  ) {
    return "syncing";
  }
  if (input.visibleSelectedRangePendingSurfaces.length > 0) return "partial";
  if (input.advisorNotReady) return "advisor_not_ready";
  // The old form was `productPendingSurfaces.length > 0 && historicalProgressPercent < 100`.
  // The percent conjunct was an escape hatch: coverage-derived 100 cancelled a
  // genuinely pending surface. Pending surfaces are now verdict-derived, so the
  // hatch is both unnecessary and unsafe.
  if (input.productPendingSurfaces.length > 0) return "partial";
  // The last gate, and the one that matters: green requires that every day in
  // the range has been re-read AFTER it closed. That is exactly the property
  // the frozen-at-01:40 day lacked, and it is what `converging` and `settled`
  // assert and `provisional` denies.
  //
  // Deliberately NOT `complete`, which only `settled` produces. A rolling
  // historical range always has its most recent ~30 days inside the conversion
  // lookback, so `settled` is unreachable for it and demanding it would pin
  // every healthy workspace at "partial" forever. `partial` in this machine
  // means "surfaces are missing"; using it for "recent conversions can still
  // arrive" would re-collapse the two distinctions this whole model exists to
  // separate. The conversion caveat is carried honestly by the verdict state,
  // the "Refreshing" label and the sub-100 percent — not by pretending data is
  // absent.
  if (!isRecentWindowObservedPostClose(completionState)) return "partial";
  return "ready";
}
