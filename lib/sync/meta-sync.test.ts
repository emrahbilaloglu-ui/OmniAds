import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMetaDailyCoverageLookup,
  buildMetaFairnessLeasePlan,
  buildMetaFollowupLeasePlan,
  buildMetaLaneProgressEvidence,
  buildMetaWorkerLeasePlan,
  hasMetaInProcessBackgroundWorkerIdentity,
  getDeprecatedMetaPartitionCancellationReason,
  getMetaExtendedHistoricalFairnessLimit,
  getMetaHistoricalCoreFairnessLimit,
  isMetaAuthoritativeHistoricalSource,
  logMetaQueueVisibility,
  normalizeMetaPartitionDate,
  resolveMetaBackgroundLoopDelayMs,
  resolveMetaTruthState,
  resolveMetaHistoricalReplaySource,
  resolveMetaWorkerRequestedLimit,
  shouldBypassMetaCreativeCoverageShortCircuit,
  shouldBypassMetaCoverageShortCircuit,
} from "@/lib/sync/meta-sync";

vi.mock("@/lib/meta/warehouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/warehouse")>();
  return {
    ...actual,
    getMetaQueueHealth: vi.fn(),
  };
});

const warehouse = await import("@/lib/meta/warehouse");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hasMetaInProcessBackgroundWorkerIdentity", () => {
  it("requires an explicit tracked worker id", () => {
    expect(
      hasMetaInProcessBackgroundWorkerIdentity({
        NODE_ENV: "development",
        SYNC_WORKER_MODE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      hasMetaInProcessBackgroundWorkerIdentity({
        META_WORKER_ID: "meta-repair:biz-1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      hasMetaInProcessBackgroundWorkerIdentity({
        WORKER_INSTANCE_ID: "worker-1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("buildMetaLaneProgressEvidence", () => {
  it("keeps historical evidence on the bottleneck timestamp", () => {
    const evidence = buildMetaLaneProgressEvidence({
      statesByScope: {
        account_daily: [
          {
            completedDays: 30,
            readyThroughDate: "2026-03-28",
            latestSuccessfulSyncAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
          },
        ],
        campaign_daily: [
          {
            completedDays: 28,
            readyThroughDate: "2026-03-26",
            latestSuccessfulSyncAt: "2026-04-02T09:30:00.000Z",
            updatedAt: "2026-04-02T09:30:00.000Z",
          },
        ],
      },
      queueHealth: {
        latestCoreActivityAt: "2026-04-02T10:05:00.000Z",
        latestExtendedActivityAt: null,
        latestMaintenanceActivityAt: null,
      } as never,
    });

    expect(evidence.core.lastCompletedAt).toBe("2026-04-02T09:30:00.000Z");
  });
});

describe("getMetaHistoricalCoreFairnessLimit", () => {
  it("boosts historical core fairness when advancement is stale", () => {
    const limit = getMetaHistoricalCoreFairnessLimit({
      queueHealth: {
        historicalCoreQueueDepth: 8,
        historicalCoreLeasedPartitions: 0,
        latestCoreActivityAt: "2026-04-02T09:00:00.000Z",
      } as never,
      progressEvidence: {
        lastCheckpointAdvancedAt: "2026-04-02T09:00:00.000Z",
        lastReadyThroughAdvancedAt: null,
        lastCompletedAt: "2026-04-02T09:00:00.000Z",
        backlogDelta: null,
        completedPartitionDelta: null,
        lastReplayAt: null,
        lastReclaimAt: null,
        recentActivityWindowMinutes: 20,
      },
      nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
    });

    expect(limit).toBeGreaterThan(1);
  });

  it("keeps base fairness when historical core is still advancing", () => {
    const limit = getMetaHistoricalCoreFairnessLimit({
      queueHealth: {
        historicalCoreQueueDepth: 8,
        historicalCoreLeasedPartitions: 0,
        latestCoreActivityAt: "2026-04-02T09:25:00.000Z",
      } as never,
      progressEvidence: {
        lastCheckpointAdvancedAt: "2026-04-02T09:25:00.000Z",
        lastReadyThroughAdvancedAt: null,
        lastCompletedAt: "2026-04-02T09:25:00.000Z",
        backlogDelta: null,
        completedPartitionDelta: null,
        lastReplayAt: null,
        lastReclaimAt: null,
        recentActivityWindowMinutes: 20,
      },
      nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
    });

    expect(limit).toBe(1);
  });
});

describe("getMetaExtendedHistoricalFairnessLimit", () => {
  it("drops to zero without extended historical backlog", () => {
    const limit = getMetaExtendedHistoricalFairnessLimit({
      queueHealth: {
        extendedHistoricalQueueDepth: 0,
        extendedHistoricalLeasedPartitions: 0,
        latestExtendedActivityAt: null,
      } as never,
      progressEvidence: null,
    });

    expect(limit).toBe(0);
  });
});

describe("buildMetaFairnessLeasePlan", () => {
  it("returns boosted historical fairness limits from stale evidence", () => {
    const plan = buildMetaFairnessLeasePlan({
      queueHealth: {
        historicalCoreQueueDepth: 6,
        historicalCoreLeasedPartitions: 0,
        extendedHistoricalQueueDepth: 4,
        extendedHistoricalLeasedPartitions: 0,
        latestCoreActivityAt: "2026-04-02T09:00:00.000Z",
        latestExtendedActivityAt: "2026-04-02T09:00:00.000Z",
      } as never,
      laneProgressEvidence: {
        core: {
          lastCheckpointAdvancedAt: "2026-04-02T09:00:00.000Z",
          lastReadyThroughAdvancedAt: null,
          lastCompletedAt: "2026-04-02T09:00:00.000Z",
          backlogDelta: null,
          completedPartitionDelta: null,
          lastReplayAt: null,
          lastReclaimAt: null,
          recentActivityWindowMinutes: 20,
        },
        extended_historical: {
          lastCheckpointAdvancedAt: "2026-04-02T09:00:00.000Z",
          lastReadyThroughAdvancedAt: null,
          lastCompletedAt: "2026-04-02T09:00:00.000Z",
          backlogDelta: null,
          completedPartitionDelta: null,
          lastReplayAt: null,
          lastReclaimAt: null,
          recentActivityWindowMinutes: 20,
        },
      },
      nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
    });

    expect(plan.coreFairnessLimit).toBeGreaterThanOrEqual(1);
    expect(plan.extendedHistoricalFairnessLimit).toBeGreaterThanOrEqual(1);
  });
});

describe("buildMetaFollowupLeasePlan", () => {
  it("keeps recent leasing off while maintenance backlog exists", () => {
    const plan = buildMetaFollowupLeasePlan({
      queueHealth: {
        maintenanceQueueDepth: 3,
        maintenanceLeasedPartitions: 0,
        extendedRecentQueueDepth: 5,
        extendedRecentLeasedPartitions: 0,
      } as never,
      leasedCoreFairnessCount: 1,
      leasedExtendedHistoricalFairnessCount: 1,
    });

    expect(plan.extendedRecentLimit).toBe(0);
    expect(plan.historicalCoreLimit).toBe(0);
  });

  it("keeps historical tail leasing available while recent backlog exists", () => {
    const plan = buildMetaFollowupLeasePlan({
      queueHealth: {
        maintenanceQueueDepth: 0,
        maintenanceLeasedPartitions: 0,
        extendedRecentQueueDepth: 5,
        extendedRecentLeasedPartitions: 0,
      } as never,
      leasedCoreFairnessCount: 1,
      leasedExtendedHistoricalFairnessCount: 1,
      leasedExtendedRecentCount: 0,
    });

    expect(plan.extendedHistoricalLimit).toBeGreaterThan(0);
    expect(plan.extendedRecentLimit).toBeGreaterThan(0);
  });

  it("keeps historical core follow-up available while core backlog exists", () => {
    const plan = buildMetaFollowupLeasePlan({
      queueHealth: {
        maintenanceQueueDepth: 0,
        maintenanceLeasedPartitions: 0,
        coreQueueDepth: 6,
        historicalCoreQueueDepth: 2,
      } as never,
      leasedCorePriorityCount: 0,
      leasedCoreFairnessCount: 0,
      leasedExtendedHistoricalFairnessCount: 0,
    });

    expect(plan.historicalCoreLimit).toBeGreaterThan(0);
  });
});

describe("resolveMetaWorkerRequestedLimit", () => {
  it("expands the per-tick lease budget when priority backlog is moving", () => {
    const requestedLimit = resolveMetaWorkerRequestedLimit({
      leaseLimit: 1,
      queueHealth: {
        queueDepth: 18,
        coreQueueDepth: 6,
        historicalCoreQueueDepth: 0,
        maintenanceQueueDepth: 2,
        extendedRecentQueueDepth: 4,
        deadLetterPartitions: 0,
        retryableFailedPartitions: 0,
        latestCoreActivityAt: "2026-04-02T09:27:00.000Z",
        latestMaintenanceActivityAt: "2026-04-02T09:27:00.000Z",
        latestExtendedActivityAt: "2026-04-02T09:27:00.000Z",
      } as never,
      laneProgressEvidence: {
        core: {
          lastCheckpointAdvancedAt: "2026-04-02T09:27:00.000Z",
          lastReadyThroughAdvancedAt: null,
          lastCompletedAt: "2026-04-02T09:27:00.000Z",
          backlogDelta: -3,
          completedPartitionDelta: 2,
          lastReplayAt: null,
          lastReclaimAt: null,
          recentActivityWindowMinutes: 20,
        },
      },
      nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
    });

    expect(requestedLimit).toBeGreaterThan(1);
  });

  it("stays conservative when retryable failure pressure exists", () => {
    const requestedLimit = resolveMetaWorkerRequestedLimit({
      leaseLimit: 1,
      queueHealth: {
        queueDepth: 9,
        coreQueueDepth: 4,
        historicalCoreQueueDepth: 0,
        retryableFailedPartitions: 2,
        deadLetterPartitions: 0,
      } as never,
    });

    expect(requestedLimit).toBe(1);
  });
});

describe("resolveMetaBackgroundLoopDelayMs", () => {
  it("returns the near-immediate busy delay when work is moving", () => {
    const busyDelay = resolveMetaBackgroundLoopDelayMs({
      hasPendingWork: true,
      hasForwardProgress: true,
    });
    const idleDelay = resolveMetaBackgroundLoopDelayMs({
      hasPendingWork: false,
      hasForwardProgress: false,
    });

    expect(busyDelay).toBeLessThan(idleDelay);
  });

  it("backs off errors exponentially but stays bounded", () => {
    expect(
      resolveMetaBackgroundLoopDelayMs({
        hasPendingWork: true,
        hasForwardProgress: false,
        hadError: true,
        errorStreak: 2,
      }),
    ).toBeGreaterThan(
      resolveMetaBackgroundLoopDelayMs({
        hasPendingWork: true,
        hasForwardProgress: false,
        hadError: true,
        errorStreak: 1,
      }),
    );
    expect(
      resolveMetaBackgroundLoopDelayMs({
        hasPendingWork: true,
        hasForwardProgress: false,
        hadError: true,
        errorStreak: 99,
      }),
    ).toBeLessThanOrEqual(15_000);
  });
});

describe("buildMetaWorkerLeasePlan", () => {
  it("returns normal queue order without maintenance jumping ahead of core and extended work", async () => {
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 9,
      leasedPartitions: 0,
      coreQueueDepth: 3,
      historicalCoreQueueDepth: 3,
      historicalCoreLeasedPartitions: 0,
      maintenanceQueueDepth: 2,
      maintenanceLeasedPartitions: 0,
      extendedQueueDepth: 4,
      extendedRecentQueueDepth: 1,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 3,
      extendedHistoricalLeasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
      latestExtendedActivityAt: "2026-04-02T09:28:00.000Z",
      latestCoreActivityAt: "2026-04-02T09:29:00.000Z",
      latestMaintenanceActivityAt: "2026-04-02T09:27:00.000Z",
    } as never);

    const plan = await buildMetaWorkerLeasePlan({
      businessId: "biz-1",
      leaseLimit: 1,
    });

    expect(plan.steps.map((step) => step.key)).toEqual([
      "core",
      "extended",
      "maintenance",
    ]);
  });

  it("leases all extended backlog through the unified extended lane", async () => {
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 12,
      leasedPartitions: 0,
      coreQueueDepth: 0,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      maintenanceQueueDepth: 0,
      maintenanceLeasedPartitions: 0,
      extendedQueueDepth: 12,
      extendedRecentQueueDepth: 4,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 8,
      extendedHistoricalLeasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
      latestExtendedActivityAt: "2026-04-02T09:28:00.000Z",
      latestCoreActivityAt: null,
      latestMaintenanceActivityAt: null,
    } as never);

    const plan = await buildMetaWorkerLeasePlan({
      businessId: "biz-1",
      leaseLimit: 1,
    });

    expect(plan.requestedLimit).toBeGreaterThanOrEqual(1);
    expect(plan.steps.map((step) => step.key)).toEqual([
      "extended",
    ]);
  });
});

describe("resolveMetaHistoricalReplaySource", () => {
  it("returns historical for unseen dates", () => {
    expect(resolveMetaHistoricalReplaySource(new Map())).toBe("historical");
  });

  it("returns null when a core historical date is already active", () => {
    expect(
      resolveMetaHistoricalReplaySource(
        new Map([
          [
            "account_daily",
            {
              status: "queued",
              source: "historical",
              finishedAt: null,
            },
          ],
        ]),
      ),
    ).toBeNull();
  });

  it("returns historical_recovery when a terminal partition exists but coverage is still incomplete", () => {
    expect(
      resolveMetaHistoricalReplaySource(
        new Map([
          [
            "account_daily",
            {
              status: "succeeded",
              source: "historical",
              finishedAt: "2026-04-03T09:00:00.000Z",
            },
          ],
        ]),
      ),
    ).toBe("historical_recovery");
  });
});

describe("normalizeMetaPartitionDate", () => {
  it("keeps D-1 finalize partition dates stable when pg returns Date objects", () => {
    expect(
      normalizeMetaPartitionDate(new Date("2026-04-12T21:00:00.000Z")),
    ).toBe("2026-04-12");
  });

  it("accepts ISO-like strings without using locale string coercion", () => {
    expect(
      normalizeMetaPartitionDate("2026-04-13T00:00:00.000Z"),
    ).toBe("2026-04-13");
  });
});

describe("meta creatives sync gating", () => {
  it("does not reference creativesMediaReady in partition gating or logs", () => {
    const source = readFileSync(
      new URL("./meta-sync.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("creativesMediaReady");
    expect(source).not.toContain("getMetaAdDailyPreviewCoverage");
    expect(source).not.toContain("creativesMediaReadyBefore");
    expect(source).not.toContain("creativesMediaReadyAfter");
  });

  it("keeps creative_daily active for warehouse sync partitions", () => {
    expect(getDeprecatedMetaPartitionCancellationReason("creative_daily")).toBeNull();
    expect(getDeprecatedMetaPartitionCancellationReason("ad_daily")).toBeNull();
  });

  it("bypasses the creative coverage short-circuit for provisional current-day partitions", () => {
    expect(
      shouldBypassMetaCreativeCoverageShortCircuit({
        truthState: "provisional",
      }),
    ).toBe(true);
    expect(
      shouldBypassMetaCreativeCoverageShortCircuit({
        truthState: "finalized",
      }),
    ).toBe(false);
  });
});

describe("syncMetaRepairRange trigger source precedence", () => {
  it("keeps explicit triggerSource values from collapsing to finalize_day", () => {
    const source = readFileSync(
      new URL("./meta-sync.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'input.triggerSource ??\n      (input.startDate === input.endDate ? "finalize_day" : "priority_window")',
    );
    expect(source).not.toContain(
      'input.triggerSource ??\n      input.startDate === input.endDate ? "finalize_day" : "priority_window"',
    );
  });
});

describe("recoverMetaD1FinalizePartitions partition updates", () => {
  it("does not reference run.finished_at from partition-only UPDATE statements", () => {
    const source = readFileSync(
      new URL("./meta-sync.ts", import.meta.url),
      "utf8",
    );

    const runQualifiedMatches = source.match(
      /finished_at = COALESCE\(run\.finished_at, now\(\)\)/g,
    );
    const partitionQualifiedMatches = source.match(
      /finished_at = COALESCE\(finished_at, now\(\)\)/g,
    );

    expect(runQualifiedMatches).toHaveLength(1);
    expect(partitionQualifiedMatches).toHaveLength(2);
  });

  it("casts finalize candidate partition dates to text before comparison", () => {
    const source = readFileSync(
      new URL("./meta-sync.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("partition.partition_date::text AS partition_date");
  });
});

describe("logMetaQueueVisibility", () => {
  it("emits structured background scheduling visibility events", () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    logMetaQueueVisibility("meta_background_sync_already_scheduled", {
      businessId: "business-1",
      delayMs: 0,
      source: "schedule",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[meta-sync] meta_background_sync_already_scheduled",
      expect.objectContaining({
        businessId: "business-1",
        source: "schedule",
      }),
    );
  });

  it("emits queue visibility when partitions exist but no runner lease is acquired", () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    logMetaQueueVisibility("meta_queue_present_no_runner_lease", {
      businessId: "business-2",
      workerId: "worker-1",
      queueDepth: 5,
    });
    logMetaQueueVisibility("meta_runner_lease_not_acquired", {
      businessId: "business-2",
      workerId: "worker-1",
      queueDepth: 5,
    });

    expect(infoSpy).toHaveBeenNthCalledWith(
      1,
      "[meta-sync] meta_queue_present_no_runner_lease",
      expect.objectContaining({
        businessId: "business-2",
        workerId: "worker-1",
      }),
    );
    expect(infoSpy).toHaveBeenNthCalledWith(
      2,
      "[meta-sync] meta_runner_lease_not_acquired",
      expect.objectContaining({
        queueDepth: 5,
      }),
    );
  });
});

describe("authoritative finalization gating", () => {
  it("scopes daily coverage lookup by business, account, and day", () => {
    expect(
      buildMetaDailyCoverageLookup({
        businessId: "biz-1",
        providerAccountId: "act_1",
        day: "2026-04-06T09:10:11.000Z",
      }),
    ).toEqual({
      businessId: "biz-1",
      providerAccountId: "act_1",
      day: "2026-04-06",
    });
  });

  it("treats manual refresh as an authoritative historical source", () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";

    expect(isMetaAuthoritativeHistoricalSource("manual_refresh")).toBe(true);
    expect(
      shouldBypassMetaCoverageShortCircuit({
        source: "manual_refresh",
        truthState: "finalized",
        businessId: "biz-1",
      }),
    ).toBe(true);
  });

  it("keeps current-day repair work provisional", () => {
    expect(
      resolveMetaTruthState({
        day: "2026-04-08",
        referenceToday: "2026-04-08",
      }),
    ).toBe("provisional");
    expect(
      resolveMetaTruthState({
        day: "2026-04-07",
        referenceToday: "2026-04-08",
      }),
    ).toBe("finalized");
  });
});
