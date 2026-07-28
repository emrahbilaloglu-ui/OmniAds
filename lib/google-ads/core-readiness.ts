/**
 * Core (account_daily + campaign_daily) readiness for a Google Ads business.
 *
 * WHAT WAS WRONG. This module used to be handed `accountCoverageDays` and
 * `campaignCoverageDays` — `COUNT(DISTINCT date)` over the warehouse — and it
 * treated them as completion. 730 of 730 covered days became
 * `historicalProgressPercent: 100`, `needsBootstrap: false`, an empty
 * `productPendingSurfaces`, and (via the status machine) a green "ready". A
 * date fetched once at 01:40 while it was still accumulating satisfied that
 * arithmetic forever, because a row's existence never expires.
 *
 * WHAT COVERAGE IS STILL FOR. Exactly one question: "is there anything at all
 * to render?", which is what `coreUsable` gates the product on. That is a data
 * AVAILABILITY question, not a completion claim, so it keeps its own clearly
 * named inputs. Every field that asserts completion — the percent, the pending
 * surfaces, the bootstrap flag, the "completed days" counters — now comes from
 * `GoogleAdsCompletionVerdict`, which is derived from post-close observation
 * evidence rather than row existence.
 *
 * WHY IT STAYS PURE. The freshness evidence is read once, in bulk, by the
 * caller (`readGoogleAdsFreshness`). This module never touches a database; it
 * receives the verdicts and the day counts behind them. That keeps one read per
 * request and keeps this decision unit-testable without a warehouse.
 */

import type {
  GoogleAdsCompletionState,
  GoogleAdsCompletionVerdict,
} from "@/lib/google-ads/completion-semantics";

/**
 * Mirrors the ordering used by `weakestGoogleAdsCompletion`.
 *
 * Duplicated rather than imported because that helper lives in the DB-backed
 * read module and this one must stay importable without a database. The
 * duplication is compile-checked: `Record<GoogleAdsCompletionState, number>`
 * fails to build if the state union ever grows and this table is not updated.
 */
const COMPLETION_RANK: Record<GoogleAdsCompletionState, number> = {
  unknown: 0,
  missing: 1,
  provisional: 2,
  converging: 3,
  settled: 4,
};

/** The weaker of two verdicts: core is only as complete as its worst scope. */
function weakerCompletion(
  left: GoogleAdsCompletionVerdict,
  right: GoogleAdsCompletionVerdict,
): GoogleAdsCompletionVerdict {
  const leftRank = COMPLETION_RANK[left.state];
  const rightRank = COMPLETION_RANK[right.state];
  if (leftRank !== rightRank) return leftRank < rightRank ? left : right;
  return right.percent < left.percent ? right : left;
}

function clampDays(value: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), max));
}

export interface GoogleAdsCoreReadinessState {
  /**
   * Is there enough data to render the product at all? A DATA-AVAILABILITY
   * answer, deliberately not a completion claim — except that it is false when
   * the freshness evidence could not be read, because "we could not look" is
   * not a basis for declaring the core usable.
   */
  coreUsable: boolean;
  effectiveHistoricalTotalDays: number;
  /**
   * Campaign days we have RE-READ AFTER THEY CLOSED. Formerly the count of days
   * with any row at all, which is what froze at 730/730.
   */
  overallCompletedDays: number;
  /** Account days re-read after they closed. Same change as above. */
  overallAccountCompletedDays: number;
  historicalReadyThroughDate: string | null;
  productPendingSurfaces: string[];
  /**
   * Always `historicalCompletion.percent`. Never recomputed from coverage —
   * that arithmetic is the defect this module exists to stop repeating.
   */
  historicalProgressPercent: number;
  needsBootstrap: boolean;

  // --- added by the freshness migration; nothing above was renamed ---

  /** The authoritative verdict for the core historical range (weakest scope). */
  historicalCompletion: GoogleAdsCompletionVerdict;
  /** Convenience mirror of `historicalCompletion.state`. */
  historicalCompletionState: GoogleAdsCompletionState;
  /** Only ever true for `settled`. The only safe basis for a green surface. */
  historicalComplete: boolean;
  /** False for anything short of `settled`, including `unknown`. */
  historicalMayStopPolling: boolean;
  /** False when the verdict is `unknown`: we could not look. */
  evidenceAvailable: boolean;
  /** Raw campaign row-existence days. Availability only; never a percent. */
  overallCoveredDays: number;
  /** Raw account row-existence days. Availability only; never a percent. */
  overallAccountCoveredDays: number;
}

export interface GoogleAdsCoreReadinessInput {
  connected: boolean;
  assignedAccountCount: number;
  totalDays: number;
  campaignReadyThroughDate: string | null;

  // --- (b) DATA AVAILABILITY: "is there anything at all?" ---

  /**
   * Days with at least one `account_daily` row. Feeds `coreUsable` and nothing
   * else. Must never reach a percent, a pending-surface list or a ready gate.
   */
  accountCoveredDays: number;
  /** Days with at least one `campaign_daily` row. Same restriction. */
  campaignCoveredDays: number;

  // --- (a) COMPLETION: the authoritative freshness evidence ---

  /**
   * `account_daily` verdict from `resolveGoogleAdsCompletion`, normally
   * `snapshot.scopes.account_daily.verdict`. Pass
   * `unknownGoogleAdsCompletion(reason)` when the evidence could not be read;
   * do NOT fall back to coverage.
   */
  accountCompletion: GoogleAdsCompletionVerdict;
  /** `campaign_daily` verdict, normally `snapshot.scopes.campaign_daily.verdict`. */
  campaignCompletion: GoogleAdsCompletionVerdict;
  /** `snapshot.scopes.account_daily.postCloseObservedDays`. */
  accountPostCloseObservedDays: number;
  /** `snapshot.scopes.campaign_daily.postCloseObservedDays`. */
  campaignPostCloseObservedDays: number;
}

export function buildGoogleAdsCoreReadiness(
  input: GoogleAdsCoreReadinessInput,
): GoogleAdsCoreReadinessState {
  const effectiveHistoricalTotalDays = Math.max(1, input.totalDays);
  const historicalCompletion = weakerCompletion(
    input.accountCompletion,
    input.campaignCompletion,
  );
  const evidenceAvailable = historicalCompletion.state !== "unknown";

  const overallCoveredDays = clampDays(
    input.campaignCoveredDays,
    effectiveHistoricalTotalDays,
  );
  const overallAccountCoveredDays = clampDays(
    input.accountCoveredDays,
    effectiveHistoricalTotalDays,
  );

  // Post-close observation is the only day count allowed to mean "done with".
  // Under `unknown` we hold it at zero rather than trust numbers that came from
  // a read that failed.
  const overallCompletedDays = evidenceAvailable
    ? clampDays(input.campaignPostCloseObservedDays, effectiveHistoricalTotalDays)
    : 0;
  const overallAccountCompletedDays = evidenceAvailable
    ? clampDays(input.accountPostCloseObservedDays, effectiveHistoricalTotalDays)
    : 0;

  // (b) Availability only. Coverage answers "is there anything to render", and
  // `evidenceAvailable` stops us answering yes off a read we never completed.
  const coreUsable =
    input.connected &&
    input.assignedAccountCount > 0 &&
    evidenceAvailable &&
    overallAccountCoveredDays > 0 &&
    overallCoveredDays > 0;

  // (a) "Pending" means we still owe a fetch: at least one day has not been
  // re-read since it closed, or we could not tell (the counts above are held at
  // zero under `unknown`, so that case falls out here too).
  //
  // Deliberately NOT `!verdict.complete`. A `converging` range owes no fetch —
  // every day has been re-read and it is merely inside the conversion window —
  // and listing it as pending would drive the route's repair and
  // partial-coverage signals in a loop that no amount of fetching can clear.
  // "Not settled" is still refused a green state, by the status machine's final
  // `complete` gate rather than by this list.
  const productPendingSurfaces = [
    overallAccountCompletedDays < effectiveHistoricalTotalDays ? "account_daily" : null,
    overallCompletedDays < effectiveHistoricalTotalDays ? "campaign_daily" : null,
  ].filter((value): value is string => Boolean(value));

  // (a) The verdict's percent, verbatim. Recomputing this from coverage is the
  // regression; the negative-control test exists to catch its return.
  const historicalProgressPercent = Math.max(
    0,
    Math.min(100, Math.floor(historicalCompletion.percent)),
  );

  // (a) Outstanding FETCH work, which is a different question from "settled":
  // a range whose days have all been re-read but are still inside the
  // conversion window is `converging`, not incomplete, and must not keep the
  // product pinned in "syncing" forever.
  const needsBootstrap =
    input.connected &&
    input.assignedAccountCount > 0 &&
    (!evidenceAvailable ||
      overallCompletedDays < effectiveHistoricalTotalDays ||
      overallAccountCompletedDays < effectiveHistoricalTotalDays);

  return {
    coreUsable,
    effectiveHistoricalTotalDays,
    overallCompletedDays,
    overallAccountCompletedDays,
    historicalReadyThroughDate: input.campaignReadyThroughDate,
    productPendingSurfaces,
    historicalProgressPercent,
    needsBootstrap,
    historicalCompletion,
    historicalCompletionState: historicalCompletion.state,
    historicalComplete: historicalCompletion.complete,
    historicalMayStopPolling: historicalCompletion.mayStopPolling,
    evidenceAvailable,
    overallCoveredDays,
    overallAccountCoveredDays,
  };
}
