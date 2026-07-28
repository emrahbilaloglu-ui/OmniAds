import { describe, expect, it } from "vitest";
import type { GoogleAdsFreshnessSummary } from "@/lib/google-ads/freshness-read";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import {
  GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS,
  GOOGLE_ADS_UNSETTLED_REFETCH_MS,
  describeGoogleAdsFreshness,
  getGoogleAdsStatusRefetchInterval,
  resolveGoogleAdsFreshnessView,
  resolveGoogleAdsSyncProgress,
  shouldRenderGoogleAdsSyncProgress,
} from "@/lib/google-ads/sync-progress-ux";

const baseStatus: GoogleAdsStatusResponse = {
  state: "syncing",
  connected: true,
  assignedAccountIds: ["acct_1"],
  advisorProgress: null,
  historicalProgress: null,
};

/** Words no Google Ads freshness surface may ever use. */
const IMMUTABILITY_CLAIMS =
  /\b(final|finalis|finaliz|immutable|complete|frozen|locked|never change|100% synced)/i;

function buildFreshness(
  overrides: Partial<GoogleAdsFreshnessSummary> = {},
): GoogleAdsFreshnessSummary {
  return {
    evidenceAvailable: true,
    unavailableReason: null,
    state: "provisional",
    label: "Provisional",
    percent: 42,
    complete: false,
    mayStopPolling: false,
    detail: "4 of 7 days have not been re-read since they closed.",
    startDate: "2026-04-01",
    endDate: "2026-04-07",
    totalDays: 7,
    includesOpenDay: false,
    timeZoneSource: "account",
    conversionLookbackDays: 30,
    scopes: [
      {
        scope: "campaign_daily",
        state: "provisional",
        label: "Provisional",
        percent: 42,
        complete: false,
        mayStopPolling: false,
        detail: "4 of 7 days have not been re-read since they closed.",
        // The defect in one row: every day has data, only three were ever
        // looked at again after the day closed.
        coveredDays: 7,
        postCloseObservedDays: 3,
        lookbackExhaustedDays: 0,
        dueNowDays: 4,
        oldestObservationAt: "2026-04-02T01:40:00.000Z",
        latestObservationAt: "2026-04-05T01:40:00.000Z",
      },
    ],
    ...overrides,
  };
}

const CONVERGING_FRESHNESS = buildFreshness({
  state: "converging",
  label: "Refreshing",
  percent: 99,
  detail:
    "All days re-read after closing; conversions may still arrive within the conversion window.",
  scopes: [],
});

const SETTLED_FRESHNESS = buildFreshness({
  state: "settled",
  label: "Policy-settled",
  percent: 100,
  complete: true,
  mayStopPolling: true,
  detail: "All days re-read after closing and past the conversion window.",
  scopes: [],
});

/**
 * A workspace that looks finished by every signal the old code trusted: control
 * plane closed, release gate passing, no repairs, no queue, coverage complete.
 * Only the freshness verdict can tell these apart.
 */
function buildClosedControlPlaneStatus(
  freshness?: GoogleAdsFreshnessSummary | null,
): GoogleAdsStatusResponse {
  return {
    ...baseStatus,
    state: "ready",
    blockerClass: "none",
    controlPlanePersistence: { exactRowsPresent: true },
    releaseGate: { verdict: "pass" },
    repairPlan: { recommendations: [] },
    requiredScopeCompletion: {
      completedDays: 7,
      totalDays: 7,
      percent: 100,
      readyThroughDate: "2026-04-07",
      complete: true,
    },
    warehouse: {
      rowCount: 7,
      firstDate: "2026-04-01",
      lastDate: "2026-04-07",
      coverage: {
        selectedRange: {
          startDate: "2026-04-01",
          endDate: "2026-04-07",
          completedDays: 7,
          totalDays: 7,
          readyThroughDate: "2026-04-07",
          isComplete: true,
        },
      },
    },
    ...(freshness === undefined ? {} : { freshness }),
    // Partial control-plane records on purpose: only the fields the completion
    // decision reads are supplied.
  } as unknown as GoogleAdsStatusResponse;
}

describe("google ads sync progress ux", () => {
  it("prefers required scope completion over advisor progress for workspace sync completion", () => {
    const status: GoogleAdsStatusResponse = {
      ...baseStatus,
      requiredScopeCompletion: {
        completedDays: 97,
        totalDays: 100,
        percent: 97,
        readyThroughDate: "2026-04-05",
        complete: false,
      },
      platformDateBoundary: {
        primaryAccountId: "acct_1",
        primaryAccountTimezone: "UTC",
        currentDateInTimezone: "2026-04-07",
        previousDateInTimezone: "2026-04-06",
        selectedRangeMode: "historical_warehouse",
        mixedCurrentDates: false,
        accounts: [],
      },
      advisorProgress: {
        percent: 94,
        visible: true,
        summary: "Search term, product, and asset history are still being prepared for analysis.",
      },
    };

    expect(resolveGoogleAdsSyncProgress(status, "inline")).toMatchObject({
      kind: "historical",
      percent: 97,
      title: "Required sync continues",
      description: "Required Google Ads warehouse coverage is ready through 2026-04-05.",
      tone: "secondary",
    });
  });

  it("prefers advisor progress while advisor unlock is incomplete", () => {
    const status: GoogleAdsStatusResponse = {
      ...baseStatus,
      advisorProgress: {
        percent: 94,
        visible: true,
        summary: "Search term, product, and asset history are still being prepared for analysis.",
      },
      historicalProgress: {
        percent: 52,
        visible: true,
        summary: "Historical sync continues in the background with recent dates prioritized first.",
      },
    };

    expect(resolveGoogleAdsSyncProgress(status, "inline")).toMatchObject({
      kind: "advisor",
      percent: 94,
      title: "Preparing analysis inputs",
      description: "Search term, product, and asset history are still being prepared for analysis.",
      tone: "primary",
    });
  });

  it("switches to historical progress only after advisor unlock progress disappears", () => {
    const status: GoogleAdsStatusResponse = {
      ...baseStatus,
      state: "ready",
      advisorProgress: {
        percent: 100,
        visible: false,
        summary: "Growth analysis is ready.",
      },
      historicalProgress: {
        percent: 61,
        visible: true,
        summary: "Historical sync continues in the background with recent dates prioritized first.",
      },
    };

    expect(resolveGoogleAdsSyncProgress(status, "inline")).toMatchObject({
      kind: "historical",
      percent: 61,
      title: "Historical sync continues",
      description: "Historical sync continues in the background with recent dates prioritized first.",
      tone: "secondary",
    });
  });

  it("shows historical progress even when advisor snapshot is still unavailable", () => {
    const status: GoogleAdsStatusResponse = {
      ...baseStatus,
      state: "syncing",
      advisor: {
        ready: false,
        requiredSurfaces: ["campaign_daily", "search_term_daily", "product_daily"],
        availableSurfaces: ["campaign_daily", "search_term_daily", "product_daily"],
        missingSurfaces: [],
        readyRangeStart: "2025-12-30",
        readyRangeEnd: "2026-03-29",
      },
      advisorProgress: {
        percent: 99,
        visible: false,
        summary: "Finalizing growth analysis.",
      },
      historicalProgress: {
        percent: 61,
        visible: true,
        summary: "Historical sync continues in the background with recent dates prioritized first.",
      },
    };

    expect(resolveGoogleAdsSyncProgress(status, "inline")).toMatchObject({
      kind: "historical",
      percent: 61,
      title: "Historical sync continues",
      description: "Historical sync continues in the background with recent dates prioritized first.",
      tone: "secondary",
    });
  });

  it("keeps neutral backfill progress visible when control-plane is closed but historical work remains", () => {
    const status: GoogleAdsStatusResponse = {
      ...baseStatus,
      state: "ready",
      blockerClass: "none",
      backgroundBackfill: {
        state: "waiting",
        percent: 11,
        incomplete: true,
        pendingScopes: ["account_daily", "campaign_daily"],
        readyThroughDate: "2026-01-14",
        latestProgressAt: null,
        reason: "waiting for worker",
      },
      controlPlanePersistence: {
        exactRowsPresent: true,
      },
      releaseGate: {
        verdict: "pass",
      },
      repairPlan: {
        recommendations: [],
      },
    } as never;

    expect(resolveGoogleAdsSyncProgress(status, "inline")).toMatchObject({
      kind: "historical",
      percent: 11,
      title: "Background backfill",
      description: "Google Ads background coverage is ready through 2026-01-14.",
      tone: "secondary",
    });
    expect(shouldRenderGoogleAdsSyncProgress(status, "inline")).toBe(true);
    expect(getGoogleAdsStatusRefetchInterval(status)).toBe(30_000);
  });

  describe("freshness is the only completion authority", () => {
    it("shows a non-green provisional state below 100 and keeps polling when every day has rows but was never re-read", () => {
      const status = buildClosedControlPlaneStatus(buildFreshness());

      const progress = resolveGoogleAdsSyncProgress(status, "inline");

      expect(progress).toMatchObject({
        kind: "freshness",
        freshnessState: "provisional",
        freshnessLabel: "Provisional",
        freshnessVerified: true,
        // Never the primary/blue "job in flight" tone, and never green.
        tone: "secondary",
      });
      // Coverage says 7/7 days and requiredScopeCompletion says 100. The
      // verdict says 42, and the verdict is what the user sees.
      expect(progress?.percent).toBe(42);
      expect(progress?.percent).toBeLessThan(100);
      expect(progress?.description).not.toMatch(IMMUTABILITY_CLAIMS);
      expect(shouldRenderGoogleAdsSyncProgress(status, "inline")).toBe(true);

      // The whole point: the surface is not green AND the client keeps asking.
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(
        GOOGLE_ADS_UNSETTLED_REFETCH_MS,
      );
    });

    it("labels a converging range as refreshing, holds it at 99 and keeps polling", () => {
      const status = buildClosedControlPlaneStatus(CONVERGING_FRESHNESS);
      const view = resolveGoogleAdsFreshnessView(status);

      expect(view).toMatchObject({
        state: "converging",
        label: "Refreshing",
        percent: 99,
        settled: false,
        // Every day was re-read after it closed: healthy, but not done.
        steady: true,
        mayStopPolling: false,
      });

      const progress = resolveGoogleAdsSyncProgress(status, "inline");
      expect(progress).toMatchObject({
        kind: "freshness",
        percent: 99,
        title: "Refreshing",
        freshnessState: "converging",
      });
      expect(progress?.description).toContain("30-day conversion window");
      expect(progress?.description).not.toMatch(IMMUTABILITY_CLAIMS);
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(
        GOOGLE_ADS_UNSETTLED_REFETCH_MS,
      );
    });

    it("only reaches 100 and releases the poller on a settled verdict, without claiming immutability", () => {
      const status = buildClosedControlPlaneStatus(SETTLED_FRESHNESS);
      const view = resolveGoogleAdsFreshnessView(status);

      expect(view).toMatchObject({
        state: "settled",
        label: "Policy-settled",
        percent: 100,
        settled: true,
        steady: true,
        mayStopPolling: true,
      });
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(false);
      // Nothing left to report, so nothing is rendered.
      expect(resolveGoogleAdsSyncProgress(status, "inline")).toBeNull();

      const copy = describeGoogleAdsFreshness(view);
      expect(copy).toContain("30-day conversion window");
      expect(copy).toContain("Google can still revise conversions");
      expect(copy).not.toMatch(IMMUTABILITY_CLAIMS);
    });

    it("treats unreadable evidence as unknown: not green, not an error, still polling", () => {
      const status = buildClosedControlPlaneStatus(
        buildFreshness({
          evidenceAvailable: false,
          unavailableReason: "Google Ads freshness tables are not ready yet.",
          state: "unknown",
          label: "Unknown",
          percent: 0,
          scopes: [],
        }),
      );

      const view = resolveGoogleAdsFreshnessView(status);
      expect(view).toMatchObject({
        evidenceAvailable: false,
        state: "unknown",
        label: "Unknown",
        percent: 0,
        settled: false,
        steady: false,
        mayStopPolling: false,
      });
      expect(view.detail).toBe("Google Ads freshness tables are not ready yet.");

      // An unverified verdict publishes no progress number at all: its percent
      // is 0, and 0 read as progress ("nothing has synced") is a worse claim
      // than the one being removed. The Data freshness stage, the sync pill and
      // the poller carry `unknown`; the progress bar stays out of it.
      expect(resolveGoogleAdsSyncProgress(status, "inline")).toBeNull();
      expect(shouldRenderGoogleAdsSyncProgress(status, "inline")).toBe(false);

      // Non-negotiable: unknown never stops the poller.
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(
        GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS,
      );
    });

    it("fails closed when the response carries no freshness at all", () => {
      const status = buildClosedControlPlaneStatus();
      expect(status.freshness).toBeUndefined();

      const view = resolveGoogleAdsFreshnessView(status);
      expect(view.state).toBe("unknown");
      expect(view.percent).toBe(0);
      expect(view.settled).toBe(false);
      expect(view.steady).toBe(false);
      expect(view.mayStopPolling).toBe(false);

      // Every old signal on this fixture says "done"; none of them may claim it.
      expect(resolveGoogleAdsSyncProgress(status, "inline")).toBeNull();
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(
        GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS,
      );
    });

    it("still attaches the verdict to a work card while evidence is unavailable", () => {
      const status: GoogleAdsStatusResponse = {
        ...buildClosedControlPlaneStatus(),
        backgroundBackfill: {
          state: "waiting",
          percent: 63,
          incomplete: true,
          pendingScopes: ["campaign_daily"],
          readyThroughDate: "2026-04-05",
          latestProgressAt: null,
          reason: "waiting for worker",
        },
      };

      // Real backfill progress is still reported — an unverified verdict may
      // not inflate it, and here it has nothing to lower either.
      expect(resolveGoogleAdsSyncProgress(status, "inline")).toMatchObject({
        kind: "historical",
        percent: 63,
        freshnessState: "unknown",
        freshnessVerified: false,
      });
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(30_000);
    });

    it("keeps polling when no payload has arrived yet, because we could not look", () => {
      expect(getGoogleAdsStatusRefetchInterval(undefined)).toBe(
        GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS,
      );
      expect(getGoogleAdsStatusRefetchInterval(null)).toBe(
        GOOGLE_ADS_UNKNOWN_FRESHNESS_REFETCH_MS,
      );
    });

    it("stops polling for a disconnected or unassigned provider, which is not a completion claim", () => {
      expect(
        getGoogleAdsStatusRefetchInterval({
          ...baseStatus,
          state: "not_connected",
          connected: false,
        }),
      ).toBe(false);
      expect(
        getGoogleAdsStatusRefetchInterval({
          ...baseStatus,
          state: "connected_no_assignment",
          assignedAccountIds: [],
        }),
      ).toBe(false);
    });

    it("ignores a mayStopPolling flag that its own state does not support", () => {
      const status = buildClosedControlPlaneStatus(
        buildFreshness({ mayStopPolling: true, complete: true, percent: 100 }),
      );

      const view = resolveGoogleAdsFreshnessView(status);
      expect(view.state).toBe("provisional");
      expect(view.mayStopPolling).toBe(false);
      // A provisional verdict may not present itself as 100 either.
      expect(view.percent).toBe(99);
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(
        GOOGLE_ADS_UNSETTLED_REFETCH_MS,
      );
    });

    it("demotes a settled verdict that contradicts its own evidence", () => {
      const status = buildClosedControlPlaneStatus(
        buildFreshness({
          state: "settled",
          label: "Policy-settled",
          percent: 100,
          complete: false,
          mayStopPolling: true,
          scopes: [],
        }),
      );

      const view = resolveGoogleAdsFreshnessView(status);
      expect(view.state).toBe("converging");
      expect(view.settled).toBe(false);
      expect(view.steady).toBe(false);
      expect(view.percent).toBe(99);
      expect(getGoogleAdsStatusRefetchInterval(status)).toBe(
        GOOGLE_ADS_UNSETTLED_REFETCH_MS,
      );
    });

    it("never lets a work percent claim more completion than the verdict allows", () => {
      const status: GoogleAdsStatusResponse = {
        ...buildClosedControlPlaneStatus(buildFreshness()),
        backgroundBackfill: {
          state: "waiting",
          percent: 97,
          incomplete: true,
          pendingScopes: ["campaign_daily"],
          readyThroughDate: "2026-04-05",
          latestProgressAt: null,
          reason: "waiting for worker",
        },
      };

      // Backfill reports 97 from coverage; the verdict caps it at 42.
      expect(resolveGoogleAdsSyncProgress(status, "inline")).toMatchObject({
        kind: "historical",
        percent: 42,
        freshnessState: "provisional",
      });
    });

    it("cannot return a stop-polling interval unless the verdict is settled", () => {
      const matrix: Array<{ name: string; status: GoogleAdsStatusResponse }> = [
        { name: "no freshness at all", status: buildClosedControlPlaneStatus() },
        {
          name: "explicit null freshness",
          status: buildClosedControlPlaneStatus(null),
        },
        {
          name: "evidence unavailable",
          status: buildClosedControlPlaneStatus(
            buildFreshness({ evidenceAvailable: false, state: "unknown", percent: 0 }),
          ),
        },
        {
          name: "missing days",
          status: buildClosedControlPlaneStatus(
            buildFreshness({ state: "missing", label: "Missing data", percent: 10 }),
          ),
        },
        {
          name: "covered but never re-read",
          status: buildClosedControlPlaneStatus(buildFreshness()),
        },
        {
          name: "converging",
          status: buildClosedControlPlaneStatus(CONVERGING_FRESHNESS),
        },
        {
          name: "settled range",
          status: buildClosedControlPlaneStatus(SETTLED_FRESHNESS),
        },
        {
          name: "settled but self-contradictory",
          status: buildClosedControlPlaneStatus(
            buildFreshness({ state: "settled", percent: 100, complete: false }),
          ),
        },
        {
          name: "lying mayStopPolling",
          status: buildClosedControlPlaneStatus(
            buildFreshness({ mayStopPolling: true, complete: true, percent: 100 }),
          ),
        },
      ];

      const stopped: string[] = [];
      for (const { name, status } of matrix) {
        const interval = getGoogleAdsStatusRefetchInterval(status);
        const view = resolveGoogleAdsFreshnessView(status);

        if (interval === false || interval === 0 || interval == null) {
          stopped.push(name);
          // The poller and the visible percent must agree, always.
          expect(view.state, name).toBe("settled");
          expect(view.percent, name).toBe(100);
          expect(view.mayStopPolling, name).toBe(true);
        } else {
          expect(view.mayStopPolling, name).toBe(false);
          expect(view.percent, name).toBeLessThan(100);
          expect(interval, name).toBeGreaterThan(0);
        }
      }

      // Not a vacuous loop: exactly one of these workspaces may go quiet.
      expect(stopped).toEqual(["settled range"]);
    });
  });
});
