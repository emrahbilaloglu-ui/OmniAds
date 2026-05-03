import { describe, expect, it } from "vitest";
import { buildMetaIntegrationSummary } from "@/lib/meta/integration-summary";
import type { MetaStatusResponse } from "@/lib/meta/status-types";

function buildStatus(
  overrides: Partial<MetaStatusResponse> = {}
): MetaStatusResponse {
  return {
    state: "syncing",
    connected: true,
    assignedAccountIds: ["act_1"],
    primaryAccountTimezone: "UTC",
    latestSync: {
      status: "running",
      readyThroughDate: "2026-04-10",
      progressPercent: 71,
      completedDays: 10,
      totalDays: 14,
    },
    coreReadiness: {
      state: "ready",
      usable: true,
      complete: true,
      percent: 100,
      reason: null,
      summary: "Summary and campaign data are ready.",
      missingSurfaces: [],
      blockedSurfaces: [],
      surfaces: {} as never,
    },
    extendedCompleteness: {
      state: "syncing",
      complete: false,
      percent: 33,
      reason: "Breakdown data is still being prepared.",
      summary: "Breakdown data is still being prepared.",
      missingSurfaces: ["breakdowns.age"],
      blockedSurfaces: [],
      surfaces: {} as never,
    },
    pageReadiness: {
      state: "partial",
      usable: true,
      complete: false,
      selectedRangeMode: "historical_warehouse",
      reason: "Breakdown data is still being prepared.",
      missingRequiredSurfaces: ["breakdowns.age"],
      requiredSurfaces: {} as never,
      optionalSurfaces: {} as never,
    },
    rangeCompletionBySurface: {
      account_daily: {
        recentCompletedDays: 10,
        recentTotalDays: 14,
        historicalCompletedDays: 180,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-10",
      },
      campaign_daily: {
        recentCompletedDays: 10,
        recentTotalDays: 14,
        historicalCompletedDays: 180,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-10",
      },
      adset_daily: {
        recentCompletedDays: 8,
        recentTotalDays: 14,
        historicalCompletedDays: 160,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-08",
      },
      creative_daily: {
        recentCompletedDays: 6,
        recentTotalDays: 14,
        historicalCompletedDays: 120,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-06",
        oldestStoredDate: "2025-12-08",
      },
      ad_daily: {
        recentCompletedDays: 6,
        recentTotalDays: 14,
        historicalCompletedDays: 110,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-05",
        oldestStoredDate: "2025-12-18",
      },
    },
    recentExtendedReady: false,
    historicalExtendedReady: false,
    warehouse: {
      coverage: {
        pendingSurfaces: ["creative_daily", "ad_daily"],
        breakdowns: {
          completedDays: 120,
          totalDays: 365,
          readyThroughDate: "2026-04-04",
        },
      },
    } as never,
    jobHealth: {
      queueDepth: 8,
      leasedPartitions: 2,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
    } as never,
    operations: {
      progressState: "syncing",
      blockingReasons: [],
      repairableActions: [],
      stallFingerprints: [],
    },
    ...overrides,
  };
}

describe("buildMetaIntegrationSummary", () => {
  it("returns a hidden not_applicable summary when Meta is disconnected or unassigned", () => {
    expect(
      buildMetaIntegrationSummary(buildStatus({ connected: false }))
    ).toMatchObject({
      visible: false,
      scope: "not_applicable",
      attentionNeeded: false,
      stages: [],
    });

    expect(
      buildMetaIntegrationSummary(buildStatus({ assignedAccountIds: [] }))
    ).toMatchObject({
      visible: false,
      scope: "not_applicable",
      attentionNeeded: false,
      stages: [],
    });
  });

  it("builds a recent-window summary for the integrations card default fetch", () => {
    const summary = buildMetaIntegrationSummary(buildStatus());

    expect(summary).toMatchObject({
      visible: true,
      scope: "recent_window",
      state: "working",
      attentionNeeded: false,
    });
    expect(summary.stages.map((stage) => stage.key)).toEqual([
      "connection",
      "queue_worker",
      "core_data",
      "extended_surfaces",
    ]);
    expect(summary.stages[1]).toMatchObject({
      key: "queue_worker",
      state: "working",
      code: "queue_active",
      evidence: {
        queueDepth: 8,
        leasedPartitions: 2,
      },
    });
    expect(summary.stages[3]).toMatchObject({
      key: "extended_surfaces",
      state: "working",
      code: "historical_extended_preparing",
      percent: 33,
      evidence: {
        completedDays: 120,
        totalDays: 365,
        pendingSurfaceCount: 1,
        pendingSurfaces: ["breakdowns.age"],
        oldestStoredDate: "2025-12-18",
      },
    });
  });

  it("reports historical extended lag when recent extended queues are empty but historical backlog remains", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        jobHealth: {
          queueDepth: 3,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
          extendedRecentQueueDepth: 0,
          extendedRecentLeasedPartitions: 0,
          extendedHistoricalQueueDepth: 3,
          extendedHistoricalLeasedPartitions: 1,
        } as never,
      })
    );

    expect(summary.stages[3]).toMatchObject({
      key: "extended_surfaces",
      state: "working",
      code: "historical_extended_preparing",
      percent: 33,
      evidence: {
        completedDays: 120,
        totalDays: 365,
        pendingSurfaceCount: 1,
        pendingSurfaces: ["breakdowns.age"],
      },
    });
  });

  it("keeps recent-window extended surfaces ready even when historical breakdown history still lags", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        state: "ready",
        latestSync: {
          status: "succeeded",
          readyThroughDate: "2026-04-14",
          progressPercent: 100,
          completedDays: 14,
          totalDays: 14,
        },
        extendedCompleteness: {
          state: "syncing",
          complete: false,
          percent: 0,
          reason: "Breakdown history is still being prepared.",
          summary: "Breakdown history is still being prepared.",
          missingSurfaces: ["breakdowns.age"],
          blockedSurfaces: [],
          surfaces: {} as never,
        },
        rangeCompletionBySurface: {
          account_daily: {
            recentCompletedDays: 14,
            recentTotalDays: 14,
            historicalCompletedDays: 180,
            historicalTotalDays: 365,
            readyThroughDate: "2026-04-14",
          },
          campaign_daily: {
            recentCompletedDays: 14,
            recentTotalDays: 14,
            historicalCompletedDays: 180,
            historicalTotalDays: 365,
            readyThroughDate: "2026-04-14",
          },
          adset_daily: {
            recentCompletedDays: 14,
            recentTotalDays: 14,
            historicalCompletedDays: 160,
            historicalTotalDays: 365,
            readyThroughDate: "2026-04-14",
          },
          creative_daily: {
            recentCompletedDays: 14,
            recentTotalDays: 14,
            historicalCompletedDays: 120,
            historicalTotalDays: 365,
            readyThroughDate: "2026-04-14",
          },
          ad_daily: {
            recentCompletedDays: 14,
            recentTotalDays: 14,
            historicalCompletedDays: 110,
            historicalTotalDays: 365,
            readyThroughDate: "2026-04-14",
          },
        },
        recentExtendedReady: true,
        historicalExtendedReady: false,
        warehouse: {
          coverage: {
            pendingSurfaces: [],
            breakdowns: {
              completedDays: 0,
              totalDays: 365,
              readyThroughDate: null,
            },
          },
        } as never,
      })
    );

    expect(summary.scope).toBe("recent_window");
    expect(summary.stages.find((stage) => stage.key === "extended_surfaces")).toMatchObject({
      state: "ready",
      code: "extended_ready",
      percent: null,
      evidence: {
        readyThroughDate: "2026-04-14",
      },
    });
  });

  it("prefers extended completeness truth over stale pending surfaces when recent window breakdowns are already ready", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        state: "syncing",
        extendedCompleteness: {
          state: "ready",
          complete: true,
          percent: 100,
          reason: null,
          summary: "Breakdowns are ready.",
          missingSurfaces: [],
          blockedSurfaces: [],
          surfaces: {} as never,
        },
        recentExtendedReady: false,
        historicalExtendedReady: false,
        warehouse: {
          coverage: {
            pendingSurfaces: [
              "account_daily",
              "campaign_daily",
              "adset_daily",
              "creative_daily",
              "ad_daily",
            ],
            breakdowns: {
              completedDays: 14,
              totalDays: 14,
              readyThroughDate: "2026-04-14",
            },
          },
        } as never,
      })
    );

    expect(summary.stages.find((stage) => stage.key === "extended_surfaces")).toMatchObject({
      state: "ready",
      code: "extended_ready",
      percent: null,
      evidence: {
        readyThroughDate: "2026-04-14",
      },
    });
  });

  it("treats worker-unavailable queue lag as non-blocking when default page truth is already ready", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        state: "ready",
        coreReadiness: {
          state: "ready",
          usable: true,
          complete: true,
          percent: 100,
          reason: null,
          summary: "Summary and campaign data are ready.",
          missingSurfaces: [],
          blockedSurfaces: [],
          surfaces: {} as never,
        },
        extendedCompleteness: {
          state: "ready",
          complete: true,
          percent: 100,
          reason: null,
          summary: "Breakdown data is ready.",
          missingSurfaces: [],
          blockedSurfaces: [],
          surfaces: {} as never,
        },
        pageReadiness: {
          state: "ready",
          usable: true,
          complete: true,
          selectedRangeMode: "historical_warehouse",
          reason: null,
          missingRequiredSurfaces: [],
          requiredSurfaces: {} as never,
          optionalSurfaces: {} as never,
        },
        jobHealth: {
          queueDepth: 3,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
        } as never,
        operations: {
          workerHealthy: false,
          progressState: "partial_stuck",
          blockingReasons: [
            {
              code: "operations_worker_offline",
              detail: "Meta sync operations are currently limited by worker_offline.",
              repairable: false,
            },
          ],
          repairableActions: [],
          stallFingerprints: ["worker_unavailable"],
        },
      })
    );

    expect(summary.attentionNeeded).toBe(false);
    expect(summary.stages.find((stage) => stage.key === "queue_worker")).toMatchObject({
      state: "waiting",
      code: "queue_waiting",
      evidence: {
        queueDepth: 3,
      },
    });
    expect(summary.stages.find((stage) => stage.key === "core_data")).toMatchObject({
      state: "ready",
      code: "core_ready",
    });
  });

  it("keeps selected-range extended surfaces ready when extended completeness is complete", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        state: "ready",
        pageReadiness: {
          state: "ready",
          usable: true,
          complete: true,
          selectedRangeMode: "historical_live_fallback",
          reason: null,
          missingRequiredSurfaces: [],
          requiredSurfaces: {} as never,
          optionalSurfaces: {} as never,
        },
        priorityWindow: {
          startDate: "2026-04-13",
          endDate: "2026-04-18",
          completedDays: 6,
          totalDays: 6,
          isActive: false,
        },
        selectedRangeTruth: {
          truthReady: true,
          state: "finalized_verified",
          verificationState: "finalized_verified",
          completedCoreDays: 6,
          totalDays: 6,
          blockingReasons: [],
          reasonCounts: {},
        },
        extendedCompleteness: {
          state: "ready",
          complete: true,
          percent: 100,
          reason: null,
          summary: "Breakdowns are ready.",
          missingSurfaces: [],
          blockedSurfaces: [],
          surfaces: {} as never,
        },
        warehouse: {
          coverage: {
            selectedRange: {
              startDate: "2026-04-13",
              endDate: "2026-04-18",
              completedDays: 6,
              totalDays: 6,
              readyThroughDate: "2026-04-18",
              isComplete: true,
            },
            pendingSurfaces: [
              "account_daily",
              "campaign_daily",
              "adset_daily",
              "creative_daily",
              "ad_daily",
            ],
            breakdowns: {
              completedDays: 6,
              totalDays: 6,
              readyThroughDate: "2026-04-18",
            },
          },
        } as never,
      })
    );

    expect(summary.scope).toBe("selected_range");
    expect(summary.stages.find((stage) => stage.key === "extended_surfaces")).toMatchObject({
      state: "ready",
      code: "extended_ready",
      percent: null,
      evidence: {
        readyThroughDate: "2026-04-18",
      },
    });
  });

  it("uses historical breakdown progress when recent extended queues are idle but background extended truth is still incomplete", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        extendedCompleteness: {
          state: "partial",
          complete: false,
          percent: 83,
          reason: "Breakdown history is still being prepared.",
          summary: "Breakdown history is still being prepared.",
          missingSurfaces: ["breakdowns.age"],
          blockedSurfaces: [],
          surfaces: {} as never,
        },
        warehouse: {
          coverage: {
            pendingSurfaces: ["account_daily", "campaign_daily"],
            breakdowns: {
              completedDays: 5,
              totalDays: 6,
              readyThroughDate: "2026-04-18",
            },
          },
        } as never,
        recentExtendedReady: false,
        historicalExtendedReady: false,
        jobHealth: {
          queueDepth: 0,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
          extendedRecentQueueDepth: 0,
          extendedRecentLeasedPartitions: 0,
          extendedHistoricalQueueDepth: 0,
          extendedHistoricalLeasedPartitions: 0,
        } as never,
      })
    );

    expect(summary.stages.find((stage) => stage.key === "extended_surfaces")).toMatchObject({
      state: "working",
      code: "historical_extended_preparing",
      percent: 83,
      evidence: {
        completedDays: 5,
        totalDays: 6,
        pendingSurfaceCount: 1,
        pendingSurfaces: ["breakdowns.age"],
        readyThroughDate: "2026-04-18",
      },
    });
  });

  it("keeps recent-window extended surfaces ready when generic warehouse pending surfaces remain but recent breakdown truth is complete", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        extendedCompleteness: {
          state: "partial",
          complete: false,
          percent: 83,
          reason: "Breakdown history is still being prepared.",
          summary: "Breakdown history is still being prepared.",
          missingSurfaces: [],
          blockedSurfaces: [],
          surfaces: {} as never,
        },
        warehouse: {
          coverage: {
            pendingSurfaces: ["account_daily", "campaign_daily", "adset_daily", "creative_daily"],
            breakdowns: {
              completedDays: 5,
              totalDays: 6,
              readyThroughDate: "2026-04-18",
            },
          },
        } as never,
        recentExtendedReady: true,
        historicalExtendedReady: false,
        jobHealth: {
          queueDepth: 0,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
          extendedRecentQueueDepth: 2,
          extendedRecentLeasedPartitions: 1,
          extendedHistoricalQueueDepth: 3,
          extendedHistoricalLeasedPartitions: 1,
        } as never,
      })
    );

    expect(summary.stages.find((stage) => stage.key === "extended_surfaces")).toMatchObject({
      state: "ready",
      code: "extended_ready",
      percent: null,
      evidence: {
        readyThroughDate: "2026-04-18",
      },
    });
  });

  it("marks blocked selected-range truth and adds the attention stage", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        state: "action_required",
        priorityWindow: {
          startDate: "2026-04-01",
          endDate: "2026-04-07",
          completedDays: 3,
          totalDays: 7,
          isActive: false,
        },
        warehouse: {
          coverage: {
            selectedRange: {
              startDate: "2026-04-01",
              endDate: "2026-04-07",
              completedDays: 3,
              totalDays: 7,
              readyThroughDate: "2026-04-03",
              isComplete: false,
            },
            pendingSurfaces: ["creative_daily", "ad_daily"],
          },
        } as never,
        selectedRangeTruth: {
          truthReady: false,
          state: "blocked",
          verificationState: "blocked",
          totalDays: 7,
          completedCoreDays: 3,
          blockingReasons: ["validation_failed"],
          reasonCounts: { validation_failed: 1 },
        },
        operations: {
          progressState: "blocked",
          blockingReasons: [
            {
              code: "blocked_publication_mismatch",
              detail: "Historical Meta selected-range truth is not yet published.",
              repairable: false,
            },
          ],
          repairableActions: [],
          stallFingerprints: [],
        },
      })
    );

    expect(summary).toMatchObject({
      visible: true,
      scope: "selected_range",
      state: "blocked",
      attentionNeeded: true,
    });
    expect(summary.stages.find((stage) => stage.key === "priority_window")).toMatchObject({
      state: "blocked",
      code: "selected_range_blocked",
      percent: 43,
      evidence: {
        blockerCount: 1,
        blockerCodes: ["blocked_publication_mismatch"],
      },
    });
    expect(summary.stages.find((stage) => stage.key === "attention")).toMatchObject({
      state: "blocked",
      code: "attention_needed",
    });
  });

  it("distinguishes current-day scope from selected-range or recent-window work", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        pageReadiness: {
          state: "syncing",
          usable: false,
          complete: false,
          selectedRangeMode: "current_day_live",
          reason: "Current-day data is still preparing.",
          missingRequiredSurfaces: ["campaigns"],
          requiredSurfaces: {} as never,
          optionalSurfaces: {} as never,
        },
        priorityWindow: {
          startDate: "2026-04-10",
          endDate: "2026-04-10",
          completedDays: 0,
          totalDays: 1,
          isActive: true,
        },
        warehouse: {
          coverage: {
            selectedRange: {
              startDate: "2026-04-10",
              endDate: "2026-04-10",
              completedDays: 0,
              totalDays: 1,
              readyThroughDate: null,
              isComplete: false,
            },
            pendingSurfaces: ["creative_daily"],
          },
        } as never,
      })
    );

    expect(summary.scope).toBe("current_day");
    expect(summary.stages.find((stage) => stage.key === "priority_window")).toMatchObject({
      state: "working",
      code: "current_day_preparing",
      percent: 0,
      evidence: {
        completedDays: 0,
        totalDays: 1,
      },
    });
  });

  it("blocks the queue stage when backlog has no healthy worker or active lease", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        state: "partial",
        latestSync: {
          status: "succeeded",
          readyThroughDate: "2026-04-10",
          progressPercent: 14,
          completedDays: 2,
          totalDays: 14,
        },
        jobHealth: {
          queueDepth: 11,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
        } as never,
        operations: {
          workerHealthy: false,
          progressState: "partial_stuck",
          blockingReasons: [
            {
              code: "operations_worker_offline",
              detail: "Meta sync operations are currently limited by worker_offline.",
              repairable: false,
            },
          ],
          repairableActions: [],
          stallFingerprints: ["worker_unavailable"],
        },
      })
    );

    expect(summary).toMatchObject({
      visible: true,
      state: "blocked",
    });
    expect(summary.stages.find((stage) => stage.key === "queue_worker")).toMatchObject({
      state: "blocked",
      code: "queue_blocked",
      evidence: {
        queueDepth: 11,
        blockerCodes: ["operations_worker_offline"],
      },
    });
  });

  it("suppresses recoverable queue attention when exact control-plane truth is closed", () => {
    const summary = buildMetaIntegrationSummary(
      buildStatus({
        state: "action_required",
        blockerClass: "none",
        syncTruthState: "ready",
        controlPlanePersistence: {
          exactRowsPresent: true,
        } as never,
        releaseGate: {
          verdict: "pass",
        } as never,
        repairPlan: {
          recommendations: [],
        } as never,
        jobHealth: {
          queueDepth: 2,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 1,
        } as never,
        operations: {
          progressState: "blocked",
          blockingReasons: [],
          repairableActions: [],
          stallFingerprints: ["dead_letter_blocking_completion"],
        } as never,
      })
    );

    expect(summary.attentionNeeded).toBe(false);
    expect(summary.stages.some((stage) => stage.key === "attention")).toBe(false);
    expect(summary.stages.find((stage) => stage.key === "queue_worker")).toMatchObject({
      state: "ready",
      code: "queue_clear",
      evidence: null,
    });
  });
});
