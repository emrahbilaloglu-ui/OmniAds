import {
  GOOGLE_ADS_COMPLETION_LABELS,
  type GoogleAdsCompletionState,
} from "@/lib/google-ads/completion-semantics";
// Type-only on purpose: `freshness-read` reaches for the database, and this
// module is imported by client components. The wire shape is shared; the server
// read is not dragged into the browser bundle.
import type { GoogleAdsFreshnessSummary } from "@/lib/google-ads/freshness-read";
import type { GoogleAdsProgressState, GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";

export type GoogleAdsSyncProgressVariant = "default" | "compact" | "inline";

export interface GoogleAdsResolvedSyncProgress {
  kind: "advisor" | "historical" | "freshness";
  percent: number;
  title: string;
  description: string;
  tone: "primary" | "secondary";
  /** Authoritative freshness state behind this card, never inferred from coverage. */
  freshnessState: GoogleAdsCompletionState;
  /** Curated label for that state. Never "Final", "Complete" or "Immutable". */
  freshnessLabel: string;
  /** Why the verdict is what it is, so the surface can show its reasoning. */
  freshnessDetail: string;
  /** False when the server produced no usable evidence — render non-green, keep polling. */
  freshnessVerified: boolean;
}

/**
 * The client-side, fail-closed reading of the authoritative freshness summary.
 *
 * Every user-visible Google Ads completion claim in this group goes through
 * here. The summary arrives over the wire, so it is treated as untrusted input:
 * an unrecognised state, a `settled` that does not agree with its own
 * `complete`/`mayStopPolling`/`percent`, or a missing field all collapse to a
 * non-green verdict that keeps polling. A surface can therefore never be handed
 * a 100% it cannot justify.
 */
export interface GoogleAdsFreshnessView {
  /** True only when the server actually produced evidence for this range. */
  evidenceAvailable: boolean;
  state: GoogleAdsCompletionState;
  label: string;
  /** 0-100. Capped below 100 for every state except a self-consistent `settled`. */
  percent: number;
  detail: string;
  /** True only for a self-consistent `settled` verdict. */
  settled: boolean;
  /**
   * The bar for a healthy steady state: `converging` or `settled`, i.e. EVERY
   * day in the range has been re-read after it closed — precisely the property
   * the day frozen at 01:40 lacked.
   *
   * Deliberately not `settled` alone. With a 30-day conversion lookback a
   * rolling recent range can never settle, so a surface that only went green on
   * `settled` would never go green and the signal would be worthless. Steady
   * still means < 100 and still means keep polling; only `settled` earns those.
   */
  steady: boolean;
  /**
   * The single authority for ending a poll loop. Derived from `settled`, never
   * from the server's `mayStopPolling` alone: a poller that stopped while the
   * percent was still moving is what let a stale day stay on screen.
   */
  mayStopPolling: boolean;
  /** The lookback the verdict was measured against, when the server published it. */
  conversionLookbackDays: number | null;
}

const FRESHNESS_STATES: readonly GoogleAdsCompletionState[] = [
  "unknown",
  "missing",
  "provisional",
  "converging",
  "settled",
];

/** Evidence is unavailable while we ask again — deliberately not 30s, not never. */
export const GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS = 15_000;
/** Evidence exists and says the range is still moving. */
export const GOOGLE_ADS_UNSETTLED_REFETCH_MS = 30_000;

function unknownFreshnessView(
  detail: string,
  conversionLookbackDays: number | null = null,
): GoogleAdsFreshnessView {
  return {
    evidenceAvailable: false,
    state: "unknown",
    label: GOOGLE_ADS_COMPLETION_LABELS.unknown,
    percent: 0,
    detail,
    settled: false,
    steady: false,
    mayStopPolling: false,
    conversionLookbackDays,
  };
}

function readLookbackDays(summary: GoogleAdsFreshnessSummary | null | undefined) {
  const value = summary?.conversionLookbackDays;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function resolveGoogleAdsFreshnessView(
  status: GoogleAdsStatusResponse | undefined | null,
): GoogleAdsFreshnessView {
  if (!status) {
    return unknownFreshnessView("Google Ads status has not been read yet.");
  }

  const summary = status.freshness;
  const lookbackDays = readLookbackDays(summary);

  // Absent field: an older server, or a mid-deploy client talking to a route
  // that predates the evidence table. Silence is not consent to show 100%.
  if (summary == null) {
    return unknownFreshnessView(
      "This deployment did not report Google Ads freshness evidence.",
      lookbackDays,
    );
  }

  if (summary.evidenceAvailable !== true) {
    return unknownFreshnessView(
      summary.unavailableReason ??
        summary.detail ??
        "Google Ads freshness evidence could not be read.",
      lookbackDays,
    );
  }

  const state = FRESHNESS_STATES.includes(summary.state) ? summary.state : "unknown";
  if (state === "unknown") {
    return unknownFreshnessView(
      summary.detail ?? "Google Ads freshness could not be determined.",
      lookbackDays,
    );
  }

  const reportedPercent = Number.isFinite(summary.percent)
    ? Math.max(0, Math.min(100, Math.floor(summary.percent)))
    : 0;
  const detail =
    typeof summary.detail === "string" && summary.detail.length > 0
      ? summary.detail
      : "Google Ads freshness evidence did not explain itself.";

  // A `settled` verdict has to agree with itself. Anything less is treated as
  // still converging: the strongest claim we make is never taken on trust.
  const settled =
    state === "settled" &&
    summary.complete === true &&
    summary.mayStopPolling === true &&
    reportedPercent >= 100;

  if (state === "settled" && !settled) {
    return {
      evidenceAvailable: true,
      state: "converging",
      label: GOOGLE_ADS_COMPLETION_LABELS.converging,
      percent: Math.min(99, reportedPercent),
      detail:
        "Google Ads reported a settled range without the evidence to back it, so it is still treated as refreshing.",
      settled: false,
      // A verdict that contradicts itself does not get the healthy bar either.
      steady: false,
      mayStopPolling: false,
      conversionLookbackDays: lookbackDays,
    };
  }

  return {
    evidenceAvailable: true,
    state,
    label: GOOGLE_ADS_COMPLETION_LABELS[state],
    // Only a self-consistent `settled` may reach 100.
    percent: settled ? reportedPercent : Math.min(99, reportedPercent),
    detail,
    settled,
    steady: settled || state === "converging",
    mayStopPolling: settled,
    conversionLookbackDays: lookbackDays,
  };
}

/**
 * The one predicate any caller may use to end a Google Ads poll loop.
 */
export function googleAdsFreshnessMayStopPolling(
  status: GoogleAdsStatusResponse | undefined | null,
) {
  return resolveGoogleAdsFreshnessView(status).mayStopPolling;
}

/**
 * One wording source for every surface, so a stage caption and a progress card
 * can never describe the same verdict differently. `settled` always carries the
 * window it was settled against — Google keeps the right to revise conversions
 * inside it, so an unqualified "final" would be a lie.
 */
export function describeGoogleAdsFreshness(view: GoogleAdsFreshnessView) {
  if (view.settled) {
    return view.conversionLookbackDays != null
      ? `Settled against a ${view.conversionLookbackDays}-day conversion window; Google can still revise conversions inside it.`
      : "Settled against the configured conversion window; Google can still revise conversions inside it.";
  }
  if (!view.evidenceAvailable) {
    return `${view.detail} Coverage is still being polled until it can be verified.`;
  }
  return view.conversionLookbackDays != null
    ? `${view.detail} Measured against a ${view.conversionLookbackDays}-day conversion window.`
    : view.detail;
}

function isVisibleProgress(progress: GoogleAdsProgressState | null | undefined) {
  return Boolean(progress?.visible && typeof progress.percent === "number");
}

export function isGoogleAdsControlPlaneClosed(
  status: GoogleAdsStatusResponse | undefined | null,
) {
  if (!status || !status.connected) return false;
  if ((status.assignedAccountIds?.length ?? 0) === 0) return false;
  return (
    status.controlPlanePersistence?.exactRowsPresent === true &&
    status.releaseGate?.verdict === "pass" &&
    (status.repairPlan?.recommendations?.length ?? 0) === 0 &&
    status.blockerClass === "none"
  );
}

/**
 * The ONLY place in this module allowed to answer "stop polling".
 *
 * Every quiet branch of the interval below routes through here, so the poller
 * cannot come to rest on a control-plane verdict, an empty queue, or a passing
 * release gate — none of which know whether a closed day was ever re-read.
 */
function quietRefetchInterval(status: GoogleAdsStatusResponse): number | false {
  const freshness = resolveGoogleAdsFreshnessView(status);
  if (freshness.mayStopPolling) return false;
  return freshness.evidenceAvailable
    ? GOOGLE_ADS_UNSETTLED_REFETCH_MS
    : GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS;
}

export function getGoogleAdsStatusRefetchInterval(
  status: GoogleAdsStatusResponse | undefined | null,
) {
  // No payload yet, or the last fetch failed. We could not look, which is not
  // the same as being done, so keep asking rather than going quiet forever.
  if (!status) return GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS;
  // Nothing is connected or assigned: there is no range to be fresh about.
  // A data-availability fact, not a completion claim.
  if (!status.connected) return false;
  if ((status.assignedAccountIds?.length ?? 0) === 0) return false;

  if (isGoogleAdsControlPlaneClosed(status)) {
    return status.backgroundBackfill?.incomplete === true
      ? 30_000
      : quietRefetchInterval(status);
  }

  const state = status.state;
  const queueDepth = status.jobHealth?.queueDepth ?? 0;
  const leasedPartitions = status.jobHealth?.leasedPartitions ?? 0;
  const repairCount = status.repairPlan?.recommendations?.length ?? 0;
  const exactRowsPresent = status.controlPlanePersistence?.exactRowsPresent === true;

  if (
    state === "syncing" ||
    state === "partial" ||
    state === "advisor_not_ready"
  ) {
    return 5_000;
  }

  if (
    state === "paused" ||
    state === "stale" ||
    queueDepth > 0 ||
    leasedPartitions > 0 ||
    repairCount > 0 ||
    (exactRowsPresent && status.releaseGate?.verdict && status.releaseGate.verdict !== "pass")
  ) {
    return 10_000;
  }

  return quietRefetchInterval(status);
}

/**
 * A work percent may report progress, never more completion than the freshness
 * verdict allows. The weakest evidence wins, exactly as it does server-side.
 */
export function boundGoogleAdsWorkPercent(
  workPercent: number,
  freshness: GoogleAdsFreshnessView,
) {
  const work = Number.isFinite(workPercent)
    ? Math.max(0, Math.min(99, Math.round(workPercent)))
    : 0;
  return freshness.evidenceAvailable ? Math.min(work, freshness.percent) : work;
}

function freshnessTitle(
  view: GoogleAdsFreshnessView,
  variant: GoogleAdsSyncProgressVariant,
) {
  if (variant === "inline") return view.label;
  switch (view.state) {
    case "converging":
      return "Google Ads is re-reading closed days";
    case "provisional":
      return "Some Google Ads days have not been re-read since they closed";
    case "missing":
      return "Some Google Ads days have no data yet";
    default:
      return "Google Ads freshness could not be verified";
  }
}

/**
 * The freshness card, but only when there is evidence to put on it.
 *
 * An `unknown` verdict carries percent 0, and this resolver's percent is read
 * downstream as a progress number (`resolveGooglePercent` in the sync pill
 * chain). Publishing a 0 there would replace one wrong claim with a worse one:
 * "nothing has synced" for a workspace that simply could not be measured. So
 * unverified freshness stays out of the progress card and is surfaced where it
 * cannot be mistaken for progress — the Data freshness stage, the sync pill,
 * and the poller, all of which handle `unknown` explicitly.
 */
function buildFreshnessProgress(
  view: GoogleAdsFreshnessView,
  variant: GoogleAdsSyncProgressVariant,
): GoogleAdsResolvedSyncProgress | null {
  if (!view.evidenceAvailable) return null;
  return {
    kind: "freshness",
    percent: view.percent,
    title: freshnessTitle(view, variant),
    description: describeGoogleAdsFreshness(view),
    // Never the primary/blue "we are working on it" tone: this is a statement
    // about what we know, not about a job in flight.
    tone: "secondary",
    freshnessState: view.state,
    freshnessLabel: view.label,
    freshnessDetail: view.detail,
    freshnessVerified: view.evidenceAvailable,
  };
}

function withFreshness(
  card: Omit<
    GoogleAdsResolvedSyncProgress,
    "freshnessState" | "freshnessLabel" | "freshnessDetail" | "freshnessVerified"
  >,
  view: GoogleAdsFreshnessView,
): GoogleAdsResolvedSyncProgress {
  return {
    ...card,
    freshnessState: view.state,
    freshnessLabel: view.label,
    freshnessDetail: view.detail,
    freshnessVerified: view.evidenceAvailable,
  };
}

export function resolveGoogleAdsSyncProgress(
  status: GoogleAdsStatusResponse | undefined | null,
  variant: GoogleAdsSyncProgressVariant = "default"
): GoogleAdsResolvedSyncProgress | null {
  if (!status || !status.connected) return null;
  if ((status.assignedAccountIds?.length ?? 0) === 0) return null;

  const freshness = resolveGoogleAdsFreshnessView(status);

  if (
    isGoogleAdsControlPlaneClosed(status) &&
    status.backgroundBackfill?.incomplete !== true
  ) {
    // A closed control plane says the pipeline has nothing to complain about.
    // It says nothing about whether the days were re-read after they closed,
    // so only the freshness verdict may take the surface down to nothing.
    return freshness.settled ? null : buildFreshnessProgress(freshness, variant);
  }

  if (status.backgroundBackfill?.incomplete === true) {
    return withFreshness(
      {
        kind: "historical",
        percent: boundGoogleAdsWorkPercent(status.backgroundBackfill.percent, freshness),
        title:
          variant === "inline"
            ? "Background backfill"
            : "Historical backfill continues in the background",
        description:
          status.backgroundBackfill.readyThroughDate != null
            ? `Google Ads background coverage is ready through ${status.backgroundBackfill.readyThroughDate}.`
            : status.backgroundBackfill.reason ??
              "Google Ads background coverage is still preparing.",
        tone: "secondary",
      },
      freshness,
    );
  }

  if (
    status.requiredScopeCompletion &&
    !status.requiredScopeCompletion.complete &&
    status.platformDateBoundary?.selectedRangeMode !== "current_day_live"
  ) {
    return withFreshness(
      {
        kind: "historical",
        // `requiredScopeCompletion.percent` is completedDays/totalDays — the
        // row-existence arithmetic this whole change exists to demote. It may
        // only ever lower the number the freshness verdict permits.
        percent: boundGoogleAdsWorkPercent(status.requiredScopeCompletion.percent, freshness),
        title:
          variant === "inline"
            ? "Required sync continues"
            : "Required warehouse sync continues in the background",
        description:
          status.requiredScopeCompletion.readyThroughDate
            ? `Required Google Ads warehouse coverage is ready through ${status.requiredScopeCompletion.readyThroughDate}.`
            : "Required Google Ads warehouse coverage is still preparing.",
        tone: "secondary",
      },
      freshness,
    );
  }

  if (isVisibleProgress(status.advisorProgress)) {
    return withFreshness(
      {
        kind: "advisor",
        percent: boundGoogleAdsWorkPercent(status.advisorProgress!.percent, freshness),
        title:
          variant === "inline"
            ? "Preparing analysis inputs"
            : "Growth analysis is preparing",
        description: status.advisorProgress!.summary,
        tone: "primary",
      },
      freshness,
    );
  }

  if (isVisibleProgress(status.historicalProgress)) {
    return withFreshness(
      {
        kind: "historical",
        percent: boundGoogleAdsWorkPercent(status.historicalProgress!.percent, freshness),
        title:
          variant === "inline"
            ? "Historical sync continues"
            : "Historical sync continues in the background",
        description: status.historicalProgress!.summary,
        tone: "secondary",
      },
      freshness,
    );
  }

  // No job is in flight. That is not the same as "the range is done": the days
  // may simply never have been re-read since they closed.
  if (!freshness.settled) {
    return buildFreshnessProgress(freshness, variant);
  }

  return null;
}

/**
 * Whether the progress surface has anything to render at all.
 *
 * A data-availability question, deliberately left as one: it asks "is there
 * something to show?", not "is the data complete?". It answers yes for a
 * non-settled freshness verdict precisely because that IS something to show.
 */
export function shouldRenderGoogleAdsSyncProgress(
  status: GoogleAdsStatusResponse | undefined | null,
  variant: GoogleAdsSyncProgressVariant = "default"
) {
  return resolveGoogleAdsSyncProgress(status, variant) !== null;
}
