import { describe, expect, it } from "vitest";
import {
  decideGoogleAdsAdvisorReadiness,
  decideGoogleAdsFullSyncPriority,
  decideGoogleAdsStatusState,
} from "@/lib/google-ads/status-machine";
import {
  resolveGoogleAdsCompletion,
  unknownGoogleAdsCompletion,
} from "@/lib/google-ads/completion-semantics";

const HISTORICAL_DAYS = 730;
const ADVISOR_DAYS = 84;

/** Real verdicts, not literals: the contract is part of what is under test. */
function historical(options: {
  coveredDays?: number;
  postCloseObservedDays: number;
  lookbackExhaustedDays?: number;
}) {
  return resolveGoogleAdsCompletion({
    totalDays: HISTORICAL_DAYS,
    coveredDays: options.coveredDays ?? HISTORICAL_DAYS,
    postCloseObservedDays: options.postCloseObservedDays,
    lookbackExhaustedDays: options.lookbackExhaustedDays ?? 0,
    includesOpenDay: false,
  });
}

const SETTLED = historical({
  postCloseObservedDays: HISTORICAL_DAYS,
  lookbackExhaustedDays: HISTORICAL_DAYS,
});
/** Every day has a row; no day has been read since it closed. */
const FROZEN = historical({ postCloseObservedDays: 0 });
/** Every day re-read after closing, still inside the conversion window. */
const CONVERGING = historical({
  postCloseObservedDays: HISTORICAL_DAYS,
  lookbackExhaustedDays: HISTORICAL_DAYS - 30,
});
const UNKNOWN = unknownGoogleAdsCompletion("Freshness evidence could not be read.");

function advisorWindow(options: {
  postCloseObservedDays: number;
  lookbackExhaustedDays?: number;
}) {
  return resolveGoogleAdsCompletion({
    totalDays: ADVISOR_DAYS,
    coveredDays: ADVISOR_DAYS,
    postCloseObservedDays: options.postCloseObservedDays,
    lookbackExhaustedDays: options.lookbackExhaustedDays ?? 0,
    // The advisor window ends at the last CLOSED day; an open day would force
    // `provisional` by construction and pin the advisor off forever.
    includesOpenDay: false,
  });
}

describe("decideGoogleAdsAdvisorReadiness", () => {
  const base = {
    connected: true,
    assignedAccountCount: 1,
    deadLetterPartitions: 0,
    recentSupportReady: true,
    snapshotAvailable: true,
    recentCompletion: advisorWindow({ postCloseObservedDays: ADVISOR_DAYS }),
  };

  it("is ready when required surfaces exist and every day was re-read after closing", () => {
    const decision = decideGoogleAdsAdvisorReadiness(base);

    // `converging`, not `settled`: a rolling recent window is always partly
    // inside the conversion lookback, so demanding `settled` would mean the
    // advisor is never available.
    expect(decision.recentCompletionState).toBe("converging");
    expect(decision.ready).toBe(true);
    expect(decision.notReady).toBe(false);
    expect(decision.freshnessBlocked).toBe(false);
    expect(decision.readinessModel).toBe("recent_84d_required_support");
  });

  it("is ready when the recent window is fully settled", () => {
    const decision = decideGoogleAdsAdvisorReadiness({
      ...base,
      recentCompletion: advisorWindow({
        postCloseObservedDays: ADVISOR_DAYS,
        lookbackExhaustedDays: ADVISOR_DAYS,
      }),
    });

    expect(decision.recentCompletionState).toBe("settled");
    expect(decision.ready).toBe(true);
  });

  it("refuses readiness when the window is covered but never re-read after closing", () => {
    const decision = decideGoogleAdsAdvisorReadiness({
      ...base,
      recentCompletion: advisorWindow({ postCloseObservedDays: 0 }),
    });

    expect(decision.recentCompletionState).toBe("provisional");
    expect(decision.ready).toBe(false);
    expect(decision.notReady).toBe(true);
    // The surfaces are all there; freshness is the blocker, and the caller can
    // say so instead of blaming a missing surface.
    expect(decision.freshnessBlocked).toBe(true);
  });

  it("refuses readiness when the freshness evidence could not be read", () => {
    const decision = decideGoogleAdsAdvisorReadiness({
      ...base,
      recentCompletion: unknownGoogleAdsCompletion("Freshness tables are not ready yet."),
    });

    expect(decision.ready).toBe(false);
    expect(decision.notReady).toBe(true);
    expect(decision.freshnessBlocked).toBe(true);
  });

  it("still refuses readiness while required recent surfaces are missing", () => {
    const decision = decideGoogleAdsAdvisorReadiness({
      ...base,
      recentSupportReady: false,
    });

    expect(decision.ready).toBe(false);
    expect(decision.notReady).toBe(true);
    expect(decision.freshnessBlocked).toBe(false);
  });

  it("ignores historical dead letters, as before", () => {
    expect(
      decideGoogleAdsAdvisorReadiness({
        ...base,
        deadLetterPartitions: 2,
        snapshotAvailable: false,
      }).ready,
    ).toBe(true);
  });

  it("is neither ready nor not-ready without a connection or an assignment", () => {
    expect(decideGoogleAdsAdvisorReadiness({ ...base, connected: false })).toMatchObject({
      ready: false,
      notReady: false,
    });
    expect(
      decideGoogleAdsAdvisorReadiness({ ...base, assignedAccountCount: 0 }),
    ).toMatchObject({ ready: false, notReady: false });
  });
});

describe("decideGoogleAdsStatusState", () => {
  const baseInput = {
    connected: true,
    assignedAccountCount: 1,
    coreUsable: true,
    historicalQueuePaused: false,
    deadLetterPartitions: 0,
    advisorRelevantDeadLetterPartitions: 0,
    advisorRelevantFailedPartitions: 0,
    advisorRelevantUnhealthyLeases: 0,
    latestSyncStatus: null,
    runningJobs: 0,
    staleRunningJobs: 0,
    selectedRangeCoreIncomplete: false,
    visibleSelectedRangePendingSurfaces: [],
    historicalProgressPercent: SETTLED.percent,
    needsBootstrap: false,
    productPendingSurfaces: [],
    selectedRangeTotalDays: 28,
    advisorMissingSurfaces: [],
    supportWindowMissingCount: 0,
    advisorNotReady: false,
    historicalCompletion: SETTLED,
  };

  it("returns ready only for a policy-settled workspace", () => {
    expect(decideGoogleAdsStatusState({ ...baseInput })).toBe("ready");
  });

  it("never returns ready over a covered but never re-read range", () => {
    // Everything the old machine looked at says green: core usable, no
    // bootstrap, no pending surfaces, nothing running.
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        historicalCompletion: FROZEN,
        historicalProgressPercent: FROZEN.percent,
      }),
    ).toBe("partial");
  });

  it("treats a re-read range inside the conversion lookback as ready, but never as 100%", () => {
    // The steady state of a healthy Google Ads workspace. Every day has been
    // re-read after it closed, and the most recent ~30 are still inside the
    // conversion window — which is permanent for a rolling range, so `settled`
    // is unreachable here.
    //
    // Reporting this as `partial` would say "surfaces are missing", which is a
    // different claim and a false one. The conversion caveat is carried by the
    // verdict state and the sub-100 percent instead.
    expect(CONVERGING.percent).toBe(99);
    expect(CONVERGING.complete).toBe(false);
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        historicalCompletion: CONVERGING,
        historicalProgressPercent: CONVERGING.percent,
      }),
    ).toBe("ready");
  });

  it("still refuses ready when a re-read range has genuinely pending surfaces", () => {
    // Proves the relaxation above did not become a blanket pass: `converging`
    // is necessary for green, not sufficient.
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        historicalCompletion: CONVERGING,
        historicalProgressPercent: CONVERGING.percent,
        productPendingSurfaces: ["search_term_daily"],
      }),
    ).toBe("partial");
  });

  it("keeps an unknown verdict retryable: syncing, never ready, never action_required", () => {
    const state = decideGoogleAdsStatusState({
      ...baseInput,
      historicalCompletion: UNKNOWN,
      historicalProgressPercent: UNKNOWN.percent,
    });

    expect(state).toBe("syncing");
    expect(state).not.toBe("ready");
    expect(state).not.toBe("action_required");
  });

  it("does not claim a paused queue on evidence it could not read", () => {
    // `paused` asserts history is incomplete AND nothing is working on it. With
    // an unknown verdict the first half is unsupported, so we stay retryable.
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        historicalQueuePaused: true,
        historicalCompletion: UNKNOWN,
        historicalProgressPercent: UNKNOWN.percent,
      }),
    ).toBe("syncing");
  });

  it("does not let an unknown verdict mask an independently observed failure", () => {
    // A dead-lettered partition is a fact about the queue, not about freshness.
    // `unknown` means we could not read freshness; it is not a reason to stop
    // reporting an incident we did observe.
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        historicalCompletion: UNKNOWN,
        historicalProgressPercent: UNKNOWN.percent,
        deadLetterPartitions: 12,
        advisorRelevantDeadLetterPartitions: 1,
      }),
    ).toBe("action_required");
  });

  it("ignores a stale display percent when deciding ready", () => {
    // A caller that hands over a coverage-shaped 100 cannot buy a green state;
    // the verdict is the only gate.
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        historicalCompletion: FROZEN,
        historicalProgressPercent: 100,
      }),
    ).toBe("partial");
  });

  it("still reports pending product surfaces as partial", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        productPendingSurfaces: ["campaign_daily"],
        historicalCompletion: FROZEN,
        historicalProgressPercent: FROZEN.percent,
      }),
    ).toBe("partial");
  });

  it("returns partial when core history is settled but selected-range surfaces lag", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        visibleSelectedRangePendingSurfaces: ["product_daily"],
      }),
    ).toBe("partial");
  });

  it("returns advisor_not_ready when the page is usable but canonical advisor inputs lag", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        advisorNotReady: true,
      }),
    ).toBe("advisor_not_ready");
  });

  it("keeps the provider syncing while core reporting is not yet usable", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        coreUsable: false,
      }),
    ).toBe("syncing");
  });

  it("keeps the provider syncing while selected-range core coverage is incomplete", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        selectedRangeCoreIncomplete: true,
      }),
    ).toBe("syncing");
  });

  it("returns paused when history is incomplete and background activity stopped", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        historicalQueuePaused: true,
        historicalCompletion: FROZEN,
        historicalProgressPercent: FROZEN.percent,
      }),
    ).toBe("paused");
  });

  it("returns action_required when advisor-relevant dead letters exist", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        deadLetterPartitions: 12,
        advisorRelevantDeadLetterPartitions: 1,
      }),
    ).toBe("action_required");
  });

  it("does not return action_required when only historical dead letters exist", () => {
    expect(
      decideGoogleAdsStatusState({
        ...baseInput,
        deadLetterPartitions: 12,
      }),
    ).toBe("ready");
  });
});

describe("decideGoogleAdsFullSyncPriority", () => {
  it("requires full sync when advisor is blocked by search term or product history", () => {
    expect(
      decideGoogleAdsFullSyncPriority({
        advisorReady: false,
        advisorMissingSurfaces: ["search_term_daily", "asset_daily"],
      })
    ).toEqual({
      required: true,
      reason: "Advisor blocked by missing extended historical support; prioritizing full sync.",
      targetScopes: ["search_term_daily", "asset_daily"],
    });

    expect(
      decideGoogleAdsFullSyncPriority({
        advisorReady: false,
        advisorMissingSurfaces: ["product_daily"],
      })
    ).toEqual({
      required: true,
      reason: "Advisor blocked by missing extended historical support; prioritizing full sync.",
      targetScopes: ["product_daily"],
    });
  });

  it("does not require full sync when only non-primary advisor support surfaces are missing", () => {
    expect(
      decideGoogleAdsFullSyncPriority({
        advisorReady: false,
        advisorMissingSurfaces: ["asset_daily"],
      })
    ).toEqual({
      required: false,
      reason: null,
      targetScopes: ["asset_daily"],
    });
  });
});
