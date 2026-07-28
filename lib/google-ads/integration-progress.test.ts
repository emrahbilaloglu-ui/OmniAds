import { describe, expect, it } from "vitest";
import { resolveGoogleIntegrationProgress } from "@/lib/google-ads/integration-progress";
import type { GoogleAdsFreshnessSummary } from "@/lib/google-ads/freshness-read";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";

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
    startDate: "2026-04-13",
    endDate: "2026-04-19",
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
        // Every day has rows; only three were ever re-read after closing.
        coveredDays: 7,
        postCloseObservedDays: 3,
        lookbackExhaustedDays: 0,
        dueNowDays: 4,
        oldestObservationAt: "2026-04-14T01:40:00.000Z",
        latestObservationAt: "2026-04-17T01:40:00.000Z",
      },
    ],
    ...overrides,
  };
}

function buildGoogleStatus(
  overrides: Partial<GoogleAdsStatusResponse> = {},
): GoogleAdsStatusResponse {
  return {
    state: "action_required",
    connected: true,
    assignedAccountIds: ["acc_1"],
    blockerClass: "none",
    controlPlanePersistence: {
      identity: {
        buildId: "build-1",
        environment: "production",
        providerScope: "google_ads",
      },
      exact: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      fallbackByBuild: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      latest: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      missingExact: [],
      exactRowsPresent: true,
    },
    releaseGate: {
      id: "gate-1",
      gateKind: "release_gate",
      gateScope: "release_readiness",
      buildId: "build-1",
      environment: "production",
      mode: "block",
      baseResult: "pass",
      verdict: "pass",
      blockerClass: null,
      summary: "passed",
      breakGlass: false,
      overrideReason: null,
      evidence: {},
      emittedAt: "2026-04-20T07:22:20.362Z",
    },
    repairPlan: {
      id: "plan-1",
      buildId: "build-1",
      environment: "production",
      providerScope: "google_ads",
      planMode: "dry_run",
      eligible: true,
      blockedReason: null,
      breakGlass: false,
      summary: "no recommendations",
      recommendations: [],
      emittedAt: "2026-04-20T07:22:20.672Z",
    },
    operations: {
      currentMode: "safe_mode",
      globalExtendedExecutionEnabled: false,
      quotaPressure: 0,
      breakerState: "closed",
      progressState: "blocked",
      blockingReasons: [],
      repairableActions: [],
      stallFingerprints: [],
      activityState: "ready",
    } as never,
    domains: {
      core: {
        state: "ready",
        label: "Core ready",
        detail: "Summary and campaign data are ready.",
      },
      selectedRange: {
        state: "ready",
        label: "Range ready",
        detail: "Selected range surfaces are ready.",
      },
      advisor: {
        state: "ready",
        label: "Analysis ready",
        detail: "Analysis inputs are ready.",
      },
    },
    panel: {
      coreUsable: true,
      extendedLimited: false,
      headline: "Google Ads is ready.",
      detail: "All primary surfaces are available.",
      surfaceStates: [],
    },
    advisor: {
      ready: true,
      readinessWindowDays: 90,
      requiredSurfaces: [],
      availableSurfaces: [],
      missingSurfaces: [],
      readyRangeStart: "2026-01-01",
      readyRangeEnd: "2026-04-19",
    },
    primaryAccountTimezone: "UTC",
    warehouse: {
      rowCount: 7,
      firstDate: "2026-04-13",
      lastDate: "2026-04-19",
      coverage: {
        selectedRange: {
          startDate: "2026-04-13",
          endDate: "2026-04-19",
          completedDays: 7,
          totalDays: 7,
          readyThroughDate: "2026-04-19",
          isComplete: true,
        },
      },
    },
    jobHealth: {
      runningJobs: 0,
      staleRunningJobs: 0,
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
    },
    ...overrides,
  };
}

describe("resolveGoogleIntegrationProgress", () => {
  it("suppresses the attention stage when the shared control plane is closed", () => {
    const model = resolveGoogleIntegrationProgress(buildGoogleStatus(), "en");

    expect(model?.attentionNeeded).toBe(false);
    expect(model?.stages.some((stage) => stage.key === "attention")).toBe(false);
    expect(model?.stages.find((stage) => stage.key === "queue_worker")).toMatchObject({
      state: "ready",
      label: "queue clear",
    });
    expect(model?.stages.find((stage) => stage.key === "selected_range")).toMatchObject({
      title: "Visible coverage",
      label: "coverage ready",
    });
  });

  it("separates core readiness from historical backfill progress", () => {
    const model = resolveGoogleIntegrationProgress(
      buildGoogleStatus({
        requiredScopeCompletion: {
          completedDays: 10,
          totalDays: 90,
          percent: 11,
          readyThroughDate: "2026-01-14",
          complete: false,
        },
        warehouse: {
          rowCount: 700,
          firstDate: "2026-01-01",
          lastDate: "2026-04-19",
          coverage: {
            historical: {
              completedDays: 10,
              totalDays: 90,
              readyThroughDate: "2026-01-14",
            },
          },
        },
      }),
      "en",
    );

    expect(model?.stages.find((stage) => stage.key === "core_data")).toMatchObject({
      state: "ready",
      label: "core ready",
      percent: null,
    });
    expect(model?.stages.find((stage) => stage.key === "selected_range")).toMatchObject({
      title: "Historical backfill",
      state: "working",
      label: "background",
      percent: 11,
      evidence: "Ready through 2026-01-14",
    });
  });

  it("suppresses attention stage when release gate only reflects background backfill", () => {
    const model = resolveGoogleIntegrationProgress(
      buildGoogleStatus({
        state: "partial",
        blockerClass: "not_release_ready",
        releaseGate: {
          id: "gate-2",
          gateKind: "release_gate",
          gateScope: "release_readiness",
          buildId: "build-1",
          environment: "production",
          mode: "block",
          baseResult: "fail",
          verdict: "blocked",
          blockerClass: "not_release_ready",
          summary: "Google Ads release gate snapshot failed for TheSwaf.",
          breakGlass: false,
          overrideReason: null,
          evidence: {},
          emittedAt: "2026-04-20T07:22:20.362Z",
        },
        backgroundBackfill: {
          state: "waiting",
          percent: 18,
          incomplete: true,
          pendingScopes: ["account_daily", "campaign_daily"],
          readyThroughDate: "2025-11-27",
          latestProgressAt: null,
          reason: "waiting",
        },
        requiredScopeCompletion: {
          completedDays: 16,
          totalDays: 90,
          percent: 18,
          readyThroughDate: "2025-11-27",
          complete: false,
        },
        warehouse: {
          rowCount: 700,
          firstDate: "2025-11-27",
          lastDate: "2026-04-20",
          coverage: {
            historical: {
              completedDays: 16,
              totalDays: 90,
              readyThroughDate: "2025-11-27",
            },
          },
        },
      }),
      "en",
    );

    expect(model?.attentionNeeded).toBe(false);
    expect(model?.stages.some((stage) => stage.key === "attention")).toBe(false);
    expect(model?.stages.find((stage) => stage.key === "selected_range")).toMatchObject({
      title: "Historical backfill",
      state: "working",
      label: "background",
      percent: 18,
    });
  });

  it("renders the attention stage when release truth is actually blocked", () => {
    const model = resolveGoogleIntegrationProgress(
      buildGoogleStatus({
        blockerClass: "queue_blocked",
        releaseGate: {
          id: "gate-2",
          gateKind: "release_gate",
          gateScope: "release_readiness",
          buildId: "build-1",
          environment: "production",
          mode: "block",
          baseResult: "fail",
          verdict: "blocked",
          blockerClass: "queue_blocked",
          summary: "queue blocked",
          breakGlass: false,
          overrideReason: null,
          evidence: {},
          emittedAt: "2026-04-20T07:22:20.362Z",
        },
        repairPlan: {
          id: "plan-2",
          buildId: "build-1",
          environment: "production",
          providerScope: "google_ads",
          planMode: "dry_run",
          eligible: true,
          blockedReason: null,
          breakGlass: false,
          summary: "1 recommendation",
          recommendations: [
            {
              action: "replay_dead_letter",
              reason: "dead letter present",
              blockerClass: "queue_blocked",
              evidence: {},
            } as never,
          ],
          emittedAt: "2026-04-20T07:22:20.672Z",
        },
        jobHealth: {
          runningJobs: 0,
          staleRunningJobs: 0,
          queueDepth: 4,
          leasedPartitions: 0,
          deadLetterPartitions: 1,
        },
      }),
      "en",
    );

    expect(model?.attentionNeeded).toBe(true);
    expect(model?.stages.some((stage) => stage.key === "attention")).toBe(true);
  });

  describe("data freshness stage", () => {
    it("reports a covered-but-never-re-read range as non-green and below 100", () => {
      const model = resolveGoogleIntegrationProgress(
        buildGoogleStatus({ freshness: buildFreshness() }),
        "en",
      );

      const stage = model?.stages.find((s) => s.key === "freshness");
      expect(stage).toMatchObject({
        title: "Data freshness",
        // Not "ready": ready is the only green state this component paints.
        state: "working",
        label: "Provisional",
        percent: 42,
      });
      expect(stage?.percent).toBeLessThan(100);
      expect(stage?.detail).not.toMatch(IMMUTABILITY_CLAIMS);
      expect(stage?.detail).toContain("30-day conversion window");
      // The evidence is the count that matters: days re-read after close.
      expect(stage?.evidence).toBe("3/7 days re-read after close • 4 days due now");
    });

    it("keeps a converging range at 99 and calls it refreshing", () => {
      const model = resolveGoogleIntegrationProgress(
        buildGoogleStatus({
          freshness: buildFreshness({
            state: "converging",
            label: "Refreshing",
            percent: 99,
            detail:
              "All days re-read after closing; conversions may still arrive within the conversion window.",
            scopes: [],
          }),
        }),
        "en",
      );

      const stage = model?.stages.find((s) => s.key === "freshness");
      expect(stage).toMatchObject({
        state: "working",
        label: "Refreshing",
        percent: 99,
      });
      expect(stage?.detail).not.toMatch(IMMUTABILITY_CLAIMS);
    });

    it("only reports 100 on a settled verdict, and says what it was settled against", () => {
      const model = resolveGoogleIntegrationProgress(
        buildGoogleStatus({
          freshness: buildFreshness({
            state: "settled",
            label: "Policy-settled",
            percent: 100,
            complete: true,
            mayStopPolling: true,
            detail: "All days re-read after closing and past the conversion window.",
            scopes: [],
          }),
        }),
        "en",
      );

      const stage = model?.stages.find((s) => s.key === "freshness");
      expect(stage).toMatchObject({
        state: "ready",
        label: "Policy-settled",
        percent: 100,
      });
      expect(stage?.detail).toBe(
        "Settled against a 30-day conversion window; Google can still revise conversions inside it.",
      );
      expect(stage?.detail).not.toMatch(IMMUTABILITY_CLAIMS);
    });

    it("renders unreadable evidence as neutral and numberless, never as an error", () => {
      const model = resolveGoogleIntegrationProgress(
        buildGoogleStatus({
          freshness: buildFreshness({
            evidenceAvailable: false,
            unavailableReason: "Google Ads freshness tables are not ready yet.",
            state: "unknown",
            label: "Unknown",
            percent: 0,
            scopes: [],
          }),
        }),
        "en",
      );

      const stage = model?.stages.find((s) => s.key === "freshness");
      expect(stage).toMatchObject({
        // Neutral grey, not the amber "blocked" the user would read as a fault.
        state: "waiting",
        label: "Unknown",
        // A percent we cannot back is worse than none at all.
        percent: null,
      });
      expect(stage?.detail).toContain("Google Ads freshness tables are not ready yet.");
      expect(stage?.detail).toContain("still being polled");
      expect(stage?.evidence).toBeNull();
    });

    it("fails closed when the response carries no freshness at all", () => {
      const model = resolveGoogleIntegrationProgress(buildGoogleStatus(), "en");

      const stage = model?.stages.find((s) => s.key === "freshness");
      expect(stage).toMatchObject({
        state: "waiting",
        label: "Unknown",
        percent: null,
      });
      expect(stage?.detail).toContain(
        "This deployment did not report Google Ads freshness evidence.",
      );
    });

    it("localizes the freshness verdict", () => {
      const model = resolveGoogleIntegrationProgress(
        buildGoogleStatus({ freshness: buildFreshness() }),
        "tr",
      );

      const stage = model?.stages.find((s) => s.key === "freshness");
      expect(stage).toMatchObject({
        title: "Veri tazeliği",
        label: "geçici",
        percent: 42,
      });
      expect(stage?.evidence).toBe("3/7 gün kapanış sonrası okundu • 4 gün sırada");
    });
  });

  describe("visible coverage never states its own completion percent", () => {
    function buildPartialRangeStatus(
      freshness?: GoogleAdsFreshnessSummary,
    ): GoogleAdsStatusResponse {
      return buildGoogleStatus({
        domains: {
          core: {
            state: "ready",
            label: "Core ready",
            detail: "Summary and campaign data are ready.",
          },
          selectedRange: {
            state: "partial",
            label: "Range partial",
            detail: "Selected range surfaces are still preparing.",
          },
          advisor: {
            state: "ready",
            label: "Analysis ready",
            detail: "Analysis inputs are ready.",
          },
        },
        warehouse: {
          rowCount: 5,
          firstDate: "2026-04-13",
          lastDate: "2026-04-19",
          coverage: {
            selectedRange: {
              startDate: "2026-04-13",
              endDate: "2026-04-19",
              // 5/7 -> the old code rendered 71% straight from row existence.
              completedDays: 5,
              totalDays: 7,
              readyThroughDate: "2026-04-17",
              isComplete: false,
            },
          },
        },
        ...(freshness ? { freshness } : {}),
      });
    }

    it("takes the visible percent from the verdict, not from completedDays/totalDays", () => {
      const model = resolveGoogleIntegrationProgress(
        buildPartialRangeStatus(buildFreshness()),
        "en",
      );

      const stage = model?.stages.find((s) => s.key === "selected_range");
      expect(stage?.percent).toBe(42);
      expect(stage?.percent).not.toBe(71);
      // Row presence is still shown, but named for what it is.
      expect(stage?.evidence).toBe("5/7 days with data • Rows through 2026-04-17");
    });

    it("publishes no percent at all when there is no verdict to back one", () => {
      const model = resolveGoogleIntegrationProgress(buildPartialRangeStatus(), "en");

      const stage = model?.stages.find((s) => s.key === "selected_range");
      expect(stage?.percent).toBeNull();
    });
  });
});
