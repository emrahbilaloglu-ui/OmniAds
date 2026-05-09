import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/creatives-warehouse", () => ({
  syncMetaCreativesWarehouseDay: vi.fn(),
}));

vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: vi.fn(),
  syncMetaAccountCoreWarehouseDay: vi.fn(),
  syncMetaAccountBreakdownWarehouseDay: vi.fn(),
  publishMetaBreakdownAuthoritativeSurface: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/warehouse")>(
    "@/lib/meta/warehouse"
  );
  return {
    ...actual,
    cancelObsoleteMetaCoreScopePartitions: vi.fn(),
    backfillMetaRunningRunsForTerminalPartition: vi.fn(),
    cleanupMetaPartitionOrchestration: vi.fn(),
    completeMetaPartitionAttempt: vi.fn(),
    completeMetaPartition: vi.fn(),
    createMetaAuthoritativeReconciliationEvent: vi.fn(),
    createMetaSyncJob: vi.fn(),
    createMetaSyncRun: vi.fn(),
    expireStaleMetaSyncJobs: vi.fn(),
    getMetaAuthoritativeDayVerification: vi.fn(),
    getMetaPartitionCompletionDenialSnapshot: vi.fn(),
    getLatestMetaCheckpointForPartition: vi.fn(),
    getLatestRunningMetaSyncRunIdForPartition: vi.fn(),
    heartbeatMetaPartitionLease: vi.fn().mockResolvedValue(true),
    getLatestMetaSyncHealth: vi.fn(),
    getMetaAdDailyCoverage: vi.fn(),
    getMetaAdSetDailyCoverage: vi.fn(),
    getMetaAccountDailyCoverage: vi.fn(),
    getMetaCampaignDailyCoverage: vi.fn(),
    getMetaCreativeDailyCoverage: vi.fn(),
    getMetaIncompleteCoreDates: vi.fn(),
    getMetaPartitionStatesForDate: vi.fn(),
    getMetaPublishedVerificationSummary: vi.fn(),
    getMetaQueueComposition: vi.fn(),
    getMetaPartitionHealth: vi.fn(),
    getMetaQueueHealth: vi.fn(),
    getMetaRawSnapshotCoverageByEndpoint: vi.fn(),
    getMetaSyncCheckpoint: vi.fn(),
    getMetaSyncState: vi.fn(),
    leaseMetaSyncPartitions: vi.fn(),
    markMetaPartitionRunning: vi.fn(),
    queueMetaSyncPartition: vi.fn(),
    reconcileMetaAuthoritativeDayStateFromVerification: vi.fn(),
    replayMetaDeadLetterPartitions: vi.fn(),
    requeueMetaRetryableFailedPartitions: vi.fn(),
    updateMetaSyncJob: vi.fn(),
    updateMetaSyncRun: vi.fn(),
    upsertMetaSyncCheckpoint: vi.fn(),
    upsertMetaSyncState: vi.fn(),
  };
});

const apiMeta = await import("@/lib/api/meta");
const creativesWarehouse = await import("@/lib/meta/creatives-warehouse");
const warehouse = await import("@/lib/meta/warehouse");
const { processMetaLifecyclePartition } = await import("@/lib/sync/meta-sync");

function buildPublishedPlannerStates(day: string) {
  return [
    "account_daily",
    "campaign_daily",
    "adset_daily",
    "ad_daily",
    "breakdown_daily",
  ].map(
    (surface) =>
      ({
        businessId: "biz-1",
        providerAccountId: "act_1",
        day,
        surface,
        state: "published",
        accountTimezone: "UTC",
        lastRunId: "run-1",
        lastManifestId: `manifest-${surface}`,
        lastPublicationPointerId: `publication-${surface}`,
        publishedAt: "2026-04-04T00:05:00.000Z",
        retryAfterAt: null,
        failureStreak: 0,
        diagnosisCode: null,
        diagnosisDetailJson: {},
        lastStartedAt: "2026-04-04T00:00:00.000Z",
        lastFinishedAt: "2026-04-04T00:05:00.000Z",
        lastAutohealAt: null,
        autohealCount: 0,
      }) as never,
  );
}

describe("processMetaLifecyclePartition lease epoch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.META_AUTHORITATIVE_FINALIZATION_V2;
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: {},
    } as never);
    vi.mocked(apiMeta.syncMetaAccountCoreWarehouseDay).mockResolvedValue({
      accountRowsWritten: 1,
      campaignRowsWritten: 1,
      adsetRowsWritten: 0,
      adRowsWritten: 0,
      positiveSpendAdIds: [],
      pageCount: 1,
      restoredPageCount: 0,
      throttleCount: 0,
      lastUsagePercent: 0,
      memoryInstrumentation: {
        maxHeapUsedBytes: 0,
        maxRowsBuffered: 0,
        flushThresholdRows: 0,
        oversizeWarning: false,
      },
    } as never);
    vi.mocked(apiMeta.syncMetaAccountBreakdownWarehouseDay).mockResolvedValue(undefined);
    vi.mocked(apiMeta.publishMetaBreakdownAuthoritativeSurface).mockResolvedValue({
      published: true,
      stagedRowCount: 3,
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 0,
      latest_updated_at: null,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 0,
      latest_updated_at: null,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 0,
      latest_updated_at: null,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaAdDailyCoverage).mockResolvedValue({
      completed_days: 0,
      latest_updated_at: null,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 0,
      latest_updated_at: null,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue({
      verificationState: "finalized_verified",
      truthReady: true,
      totalDays: 1,
      completedCoreDays: 1,
      sourceFetchedAt: "2026-04-04T00:05:00.000Z",
      publishedAt: "2026-04-04T00:05:00.000Z",
      asOf: "2026-04-04T00:05:00.000Z",
      publishedSlices: 5,
      totalExpectedSlices: 5,
      reasonCounts: {},
      publishedKeysBySurface: {},
    } as never);
    vi.mocked(warehouse.getMetaAuthoritativeDayVerification).mockResolvedValue({
      businessId: "biz-1",
      providerAccountId: "act_1",
      day: "2026-04-03",
      verificationState: "finalized_verified",
      sourceManifestState: "completed",
      validationState: "passed",
      activePublication: {
        id: "publication-1",
        businessId: "biz-1",
        providerAccountId: "act_1",
        day: "2026-04-03",
        pointerKind: "validation_basis",
        pointerValue: "validation-basis-1",
        manifestIds: ["manifest-account_daily"],
        validationStatus: "passed",
        verificationState: "finalized_verified",
        createdAt: "2026-04-04T00:05:00.000Z",
      },
      surfaces: [
        "account_daily",
        "campaign_daily",
        "adset_daily",
        "ad_daily",
        "breakdown_daily",
      ].map(
        (surface) =>
          ({
            surface,
            manifest: {
              id: `manifest-${surface}`,
              businessId: "biz-1",
              providerAccountId: "act_1",
              day: "2026-04-03",
              surface,
              accountTimezone: "UTC",
              sourceKind: "recent_recovery",
              sourceWindowKind: "historical",
              runId: "run-1",
              fetchStatus: "completed",
              freshStartApplied: true,
              checkpointResetApplied: false,
              rawSnapshotWatermark: "run-1",
              sourceSpend: 10,
              validationBasisVersion: "meta-authoritative-finalization-v2",
              metaJson: {},
              startedAt: "2026-04-04T00:00:00.000Z",
              completedAt: "2026-04-04T00:05:00.000Z",
              createdAt: "2026-04-04T00:00:00.000Z",
              updatedAt: "2026-04-04T00:05:00.000Z",
            },
            publication: {
              id: `publication-${surface}`,
              businessId: "biz-1",
              providerAccountId: "act_1",
              day: "2026-04-03",
              surface,
              status: "published",
              validationStatus: "passed",
              pointerKind: "validation_basis",
              pointerValue: `validation-${surface}`,
              manifestId: `manifest-${surface}`,
              publishedAt: "2026-04-04T00:05:00.000Z",
              createdAt: "2026-04-04T00:05:00.000Z",
            },
          }) as never,
      ),
      lastFailure: null,
      repairBacklog: 0,
      deadLetters: 0,
      staleLeases: 0,
      queuedPartitions: 0,
      leasedPartitions: 0,
    } as never);
    vi.mocked(
      warehouse.reconcileMetaAuthoritativeDayStateFromVerification,
    ).mockResolvedValue(buildPublishedPlannerStates("2026-04-03") as never);
    vi.mocked(
      warehouse.createMetaAuthoritativeReconciliationEvent,
    ).mockResolvedValue(null as never);
    vi.mocked(warehouse.markMetaPartitionRunning).mockResolvedValue(true);
    vi.mocked(warehouse.createMetaSyncRun).mockResolvedValue("run-1");
    vi.mocked(warehouse.heartbeatMetaPartitionLease).mockResolvedValue(true);
    vi.mocked(warehouse.getMetaPartitionCompletionDenialSnapshot).mockResolvedValue({
      currentPartitionStatus: "running",
      currentLeaseOwner: "worker-2",
      currentLeaseEpoch: 99,
      currentLeaseExpiresAt: "2026-04-04T00:05:00.000Z",
      ownerMatchesCaller: false,
      epochMatchesCaller: false,
      leaseExpiredAtObservation: false,
      currentPartitionFinishedAt: null,
      latestCheckpointScope: "account_daily",
      latestCheckpointPhase: "finalize",
      latestCheckpointUpdatedAt: "2026-04-04T00:00:00.000Z",
      latestRunningRunId: "run-foreign",
      runningRunCount: 1,
      denialClassification: "owner_mismatch",
    } as never);
    vi.mocked(warehouse.completeMetaPartitionAttempt).mockResolvedValue({
      ok: true,
      runUpdated: true,
      closedRunningRunCount: 1,
      callerRunIdWasClosed: true,
      closedRunningRunIds: ["run-1"],
      closedCheckpointGroups: [],
      observedLatestRunningRunId: null,
      callerRunIdMatchedLatestRunningRunId: null,
    });
    vi.mocked(warehouse.backfillMetaRunningRunsForTerminalPartition).mockResolvedValue({
      partitionStatus: "succeeded",
      closedRunningRunCount: 0,
      callerRunIdWasClosed: null,
      closedRunningRunIds: [],
    } as never);
    vi.mocked(warehouse.completeMetaPartition).mockResolvedValue(true);
    vi.mocked(warehouse.updateMetaSyncRun).mockResolvedValue(undefined);
    vi.mocked(warehouse.getLatestRunningMetaSyncRunIdForPartition).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaPartitionStatesForDate).mockResolvedValue(new Map());
    vi.mocked(warehouse.queueMetaSyncPartition).mockResolvedValue({
      id: "queued-1",
      businessId: "biz-1",
      providerAccountId: "act_1",
      lane: "extended",
      scope: "ad_daily",
      partitionDate: "2026-04-03",
      status: "queued",
      priority: 55,
      source: "recent_recovery",
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      nextRetryAt: null,
      lastError: null,
      createdAt: "2026-04-04T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      updatedAt: "2026-04-04T00:00:00.000Z",
      leaseEpoch: 0,
    } as never);
    vi.mocked(warehouse.getLatestMetaCheckpointForPartition).mockResolvedValue({
      checkpointScope: "account_daily",
      phase: "finalize",
      status: "running",
      updatedAt: "2026-04-04T00:00:00.000Z",
    });
  });

  it("keeps quota failures retryable instead of permanent dead-lettering at max attempts", async () => {
    vi.mocked(apiMeta.syncMetaAccountCoreWarehouseDay).mockRejectedValueOnce(
      new Error("Application request limit reached")
    );

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-quota",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "maintenance",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 99,
        leaseEpoch: 7,
        source: "finalize_day",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(false);
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-quota",
        partitionStatus: "failed",
        runStatus: "failed",
        errorClass: "quota",
        retryDelayMinutes: 60,
      })
    );
  });

  it("dead-letters Meta checkpoint/login failures because backend replay cannot solve them", async () => {
    vi.mocked(apiMeta.syncMetaAccountCoreWarehouseDay).mockRejectedValueOnce(
      new Error("You cannot access the app till you log in to www.facebook.com and follow the instructions given.")
    );

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-checkpoint",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "maintenance",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 0,
        leaseEpoch: 7,
        source: "finalize_day",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(false);
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-checkpoint",
        partitionStatus: "dead_letter",
        runStatus: "failed",
        errorClass: "account_checkpoint",
        retryDelayMinutes: undefined,
      })
    );
  });

  it("threads leaseEpoch through run creation, core sync, breakdown sync, and completion", async () => {
    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-1",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 2,
        leaseEpoch: 7,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(warehouse.markMetaPartitionRunning).toHaveBeenCalledWith({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 7,
      leaseMinutes: 6,
    });
    expect(apiMeta.syncMetaAccountCoreWarehouseDay).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-1",
        workerId: "worker-1",
        leaseEpoch: 7,
      })
    );
    expect(
      vi.mocked(apiMeta.syncMetaAccountBreakdownWarehouseDay).mock.calls.every(
        ([input]) => input.leaseEpoch === 7 && input.publishAuthoritativeSurface === false
      )
    ).toBe(true);
    expect(warehouse.createMetaSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-1",
        metaJson: {
          source: "recent_recovery",
          leaseEpoch: 7,
        },
      })
    );
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-1",
        workerId: "worker-1",
        leaseEpoch: 7,
        runId: "run-1",
        partitionStatus: "succeeded",
        runStatus: "succeeded",
        durationMs: expect.any(Number),
        finishedAt: expect.any(String),
        lane: "extended",
        scope: "account_daily",
        observabilityPath: "primary",
        recoveredRunId: null,
      })
    );
    expect(warehouse.heartbeatMetaPartitionLease).toHaveBeenCalledWith({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 7,
      leaseMinutes: 6,
    });
    expect(
      vi.mocked(warehouse.heartbeatMetaPartitionLease).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(warehouse.completeMetaPartitionAttempt).mock.invocationCallOrder[0]!);
  });

  it("publishes breakdown truth once after all breakdown slices succeed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T12:00:00.000Z"));
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-1",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 2,
        leaseEpoch: 7,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(apiMeta.syncMetaAccountBreakdownWarehouseDay).toHaveBeenCalledTimes(3);
    expect(apiMeta.publishMetaBreakdownAuthoritativeSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-1",
        workerId: "worker-1",
        leaseEpoch: 7,
        endpointName:
          "breakdown_publisher_platform,platform_position,impression_device",
      }),
    );

    vi.useRealTimers();
  });

  it("refreshes current-day creative warehouse partitions even when coverage is already complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 1,
      latest_updated_at: "2026-04-05T08:00:00.000Z",
      ready_through_date: "2026-04-05",
    } as never);

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-creative-today",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "creative_daily",
        partitionDate: "2026-04-05",
        attemptCount: 1,
        leaseEpoch: 21,
        source: "today_observe",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(creativesWarehouse.syncMetaCreativesWarehouseDay).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        day: "2026-04-05",
        assignedAccountIds: ["act_1"],
        sourceRunId: "partition-creative-today",
        mediaMode: "full",
      }),
    );

    vi.useRealTimers();
  });

  it("uses the partition account timezone when deciding creative current-day freshness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:30:00.000Z"));
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1", "act_2"],
      currency: "USD",
      accountProfiles: {
        act_1: { currency: "USD", timezone: "America/Anchorage", name: "Account 1" },
        act_2: { currency: "USD", timezone: "Pacific/Kiritimati", name: "Account 2" },
      },
    } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 1,
      latest_updated_at: "2026-04-06T08:00:00.000Z",
      ready_through_date: "2026-04-07",
    } as never);

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-creative-kiritimati",
        businessId: "biz-1",
        providerAccountId: "act_2",
        lane: "extended",
        scope: "creative_daily",
        partitionDate: "2026-04-07",
        attemptCount: 1,
        leaseEpoch: 22,
        source: "today_observe",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(creativesWarehouse.syncMetaCreativesWarehouseDay).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        day: "2026-04-07",
        assignedAccountIds: ["act_2"],
        sourceRunId: "partition-creative-kiritimati",
        mediaMode: "full",
      }),
    );

    vi.useRealTimers();
  });

  it("returns false and records lease_conflict when completion loses the current epoch", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(warehouse.completeMetaPartitionAttempt).mockResolvedValue({
      ok: false,
      reason: "lease_conflict",
    });

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-2",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 4,
        leaseEpoch: 12,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(false);
    expect(warehouse.updateMetaSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        status: "failed",
        errorClass: "lease_conflict",
        errorMessage: expect.stringContaining("partition lost ownership before"),
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[meta-sync] partition_success_completion_denied",
      expect.objectContaining({
        partitionId: "partition-2",
        runId: "run-1",
        recoveredRunId: null,
        workerId: "worker-1",
        leaseEpoch: 12,
        lane: "extended",
        scope: "account_daily",
        partitionStatus: "succeeded",
        runStatusBefore: "running",
        runStatusAfter: "succeeded",
        reason: "lease_conflict",
        currentPartitionStatus: "running",
        currentLeaseOwner: "worker-2",
        currentLeaseEpoch: 99,
        currentLeaseExpiresAt: "2026-04-04T00:05:00.000Z",
        ownerMatchesCaller: false,
        epochMatchesCaller: false,
        leaseExpiredAtObservation: false,
        checkpointScope: "account_daily",
        checkpointPhase: "finalize",
        checkpointUpdatedAt: "2026-04-04T00:00:00.000Z",
        latestRunningRunId: "run-foreign",
        runningRunCount: 1,
        denialClassification: "owner_mismatch",
      })
    );
  });

  it("skips completion when the pre-completion heartbeat loses the current epoch", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 1,
      latest_updated_at: null,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 1,
      latest_updated_at: null,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.heartbeatMetaPartitionLease)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-3",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 15,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(false);
    expect(warehouse.completeMetaPartitionAttempt).not.toHaveBeenCalled();
    expect(warehouse.updateMetaSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        status: "failed",
        errorClass: "lease_conflict",
        errorMessage: expect.stringContaining("partition lost ownership before"),
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[meta-sync] partition_success_completion_denied",
      expect.objectContaining({
        scope: "account_daily",
        lane: "extended",
        leaseEpoch: 15,
        reason: "lease_conflict",
      })
    );
  });

  it("logs denial snapshots with recoveredRunId when run creation returned null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(warehouse.createMetaSyncRun).mockResolvedValue(null as never);
    vi.mocked(warehouse.getLatestRunningMetaSyncRunIdForPartition).mockResolvedValue("run-recovered");
    vi.mocked(warehouse.completeMetaPartitionAttempt).mockResolvedValue({
      ok: false,
      reason: "lease_conflict",
    });
    vi.mocked(warehouse.getMetaPartitionCompletionDenialSnapshot).mockResolvedValue({
      currentPartitionStatus: "running",
      currentLeaseOwner: "worker-1",
      currentLeaseEpoch: 20,
      currentLeaseExpiresAt: "2026-04-04T00:06:00.000Z",
      ownerMatchesCaller: true,
      epochMatchesCaller: true,
      leaseExpiredAtObservation: true,
      currentPartitionFinishedAt: null,
      latestCheckpointScope: "account_daily",
      latestCheckpointPhase: "finalize",
      latestCheckpointUpdatedAt: "2026-04-04T00:01:00.000Z",
      latestRunningRunId: "run-recovered",
      runningRunCount: 1,
      denialClassification: "lease_expired",
    } as never);

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-3b",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 20,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "[meta-sync] partition_success_completion_denied",
      expect.objectContaining({
        partitionId: "partition-3b",
        recoveredRunId: "run-recovered",
        lane: "extended",
        scope: "account_daily",
        denialClassification: "lease_expired",
        latestRunningRunId: "run-recovered",
      })
    );
  });

  it("backfills remaining running runs when denial is already_terminal", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(warehouse.completeMetaPartitionAttempt).mockResolvedValue({
      ok: false,
      reason: "lease_conflict",
    });
    vi.mocked(warehouse.getMetaPartitionCompletionDenialSnapshot).mockResolvedValue({
      currentPartitionStatus: "succeeded",
      currentLeaseOwner: null,
      currentLeaseEpoch: 12,
      currentLeaseExpiresAt: null,
      ownerMatchesCaller: null,
      epochMatchesCaller: true,
      leaseExpiredAtObservation: true,
      currentPartitionFinishedAt: "2026-04-04T00:02:00.000Z",
      latestCheckpointScope: "account_daily",
      latestCheckpointPhase: "finalize",
      latestCheckpointUpdatedAt: "2026-04-04T00:02:00.000Z",
      latestRunningRunId: "run-foreign",
      runningRunCount: 1,
      denialClassification: "already_terminal",
    } as never);
    vi.mocked(warehouse.backfillMetaRunningRunsForTerminalPartition).mockResolvedValue({
      partitionStatus: "succeeded",
      closedRunningRunCount: 1,
      callerRunIdWasClosed: false,
      closedRunningRunIds: ["run-foreign"],
    } as never);

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-2b",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "maintenance",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 4,
        leaseEpoch: 12,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(warehouse.backfillMetaRunningRunsForTerminalPartition).toHaveBeenCalledWith({
      partitionId: "partition-2b",
      runId: "run-1",
      recoveredRunId: null,
    });
    expect(warehouse.updateMetaSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        status: "succeeded",
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[meta-sync] terminal_parent_running_runs_backfilled",
      expect.objectContaining({
        partitionId: "partition-2b",
        runId: "run-1",
        workerId: "worker-1",
        leaseEpoch: 12,
        lane: "maintenance",
        scope: "account_daily",
        pathKind: "primary",
        partitionStatus: "succeeded",
        closedRunningRunCount: 1,
        callerRunIdWasClosed: false,
        closedRunningRunIds: ["run-foreign"],
      })
    );
  });

  it("does not misclassify operational completion errors as lease_conflict", async () => {
    vi.mocked(warehouse.completeMetaPartitionAttempt)
      .mockRejectedValueOnce(new Error("db completion timeout"))
      .mockResolvedValueOnce({
        ok: true,
        runUpdated: true,
        closedRunningRunCount: 1,
        callerRunIdWasClosed: true,
        closedRunningRunIds: ["run-1"],
        closedCheckpointGroups: [],
        observedLatestRunningRunId: null,
        callerRunIdMatchedLatestRunningRunId: null,
      });

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-4",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 18,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(false);
    expect(warehouse.updateMetaSyncRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        errorClass: "lease_conflict",
        errorMessage: "partition lost ownership before success completion",
      })
    );
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        partitionStatus: "failed",
        runStatus: "failed",
        errorClass: expect.any(String),
        errorMessage: "db completion timeout",
      })
    );
  });

  it("backfills the run terminal state when partition completion succeeds without updating the run row", async () => {
    vi.mocked(warehouse.completeMetaPartitionAttempt).mockResolvedValue({
      ok: true,
      runUpdated: false,
      closedRunningRunCount: 0,
      callerRunIdWasClosed: null,
      closedRunningRunIds: [],
      closedCheckpointGroups: [],
      observedLatestRunningRunId: null,
      callerRunIdMatchedLatestRunningRunId: null,
    });

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-4b",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 19,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(warehouse.updateMetaSyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        status: "succeeded",
        finishedAt: expect.any(String),
        onlyIfCurrentStatus: "running",
      })
    );
  });

  it("dead-letters authoritative finalize attempts when required publications are still missing", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    vi.mocked(warehouse.getMetaAuthoritativeDayVerification).mockResolvedValue({
      businessId: "biz-1",
      providerAccountId: "act_1",
      day: "2026-04-03",
      verificationState: "processing",
      sourceManifestState: "completed",
      validationState: "processing",
      activePublication: null,
      surfaces: [
        "account_daily",
        "campaign_daily",
        "adset_daily",
        "ad_daily",
        "breakdown_daily",
      ].map(
        (surface) =>
          ({
            surface,
            manifest: {
              id: `manifest-${surface}`,
              businessId: "biz-1",
              providerAccountId: "act_1",
              day: "2026-04-03",
              surface,
              accountTimezone: "UTC",
              sourceKind: "historical_recovery",
              sourceWindowKind: "historical",
              runId: "run-1",
              fetchStatus: "completed",
              freshStartApplied: true,
              checkpointResetApplied: false,
              rawSnapshotWatermark: "run-1",
              sourceSpend: 10,
              validationBasisVersion: "meta-authoritative-finalization-v2",
              metaJson: {},
              startedAt: "2026-04-04T00:00:00.000Z",
              completedAt: "2026-04-04T00:05:00.000Z",
              createdAt: "2026-04-04T00:00:00.000Z",
              updatedAt: "2026-04-04T00:05:00.000Z",
            },
            publication: null,
          }) as never,
      ),
      lastFailure: null,
      repairBacklog: 0,
      deadLetters: 0,
      staleLeases: 0,
      queuedPartitions: 0,
      leasedPartitions: 0,
    } as never);
    vi.mocked(
      warehouse.reconcileMetaAuthoritativeDayStateFromVerification,
    ).mockResolvedValue(
      [
        "account_daily",
        "campaign_daily",
        "adset_daily",
        "ad_daily",
        "breakdown_daily",
      ].map(
        (surface) =>
          ({
            businessId: "biz-1",
            providerAccountId: "act_1",
            day: "2026-04-03",
            surface,
            state: "blocked",
            accountTimezone: "UTC",
            activePartitionId: null,
            lastRunId: "run-1",
            lastManifestId: `manifest-${surface}`,
            lastPublicationPointerId: null,
            publishedAt: null,
            retryAfterAt: "2026-04-04T00:05:00.000Z",
            failureStreak: 1,
            diagnosisCode: "publication_pointer_missing",
            diagnosisDetailJson: {},
            lastStartedAt: "2026-04-04T00:00:00.000Z",
            lastFinishedAt: "2026-04-04T00:05:00.000Z",
            lastAutohealAt: null,
            autohealCount: 0,
          }) as never,
      ),
    );

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-missing-publish",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "maintenance",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 24,
        source: "historical_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(false);
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-missing-publish",
        partitionStatus: "dead_letter",
        runStatus: "failed",
        errorClass: "authoritative_blocked",
        errorMessage: expect.stringContaining(
          "authoritative_publication_missing",
        ),
      }),
    );
    expect(
      warehouse.createMetaAuthoritativeReconciliationEvent,
    ).toHaveBeenCalled();
  });

  it("requeues authoritative partitions that return without published planner progress", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    vi.mocked(warehouse.getMetaAuthoritativeDayVerification).mockResolvedValue({
      businessId: "biz-1",
      providerAccountId: "act_1",
      day: "2026-04-03",
      verificationState: "processing",
      sourceManifestState: "missing",
      validationState: "processing",
      activePublication: null,
      surfaces: [
        "account_daily",
        "campaign_daily",
        "adset_daily",
        "ad_daily",
        "breakdown_daily",
      ].map(
        (surface) =>
          ({
            surface,
            manifest: null,
            publication: null,
          }) as never,
      ),
      lastFailure: null,
      repairBacklog: 0,
      deadLetters: 0,
      staleLeases: 0,
      queuedPartitions: 0,
      leasedPartitions: 0,
    } as never);
    vi.mocked(
      warehouse.reconcileMetaAuthoritativeDayStateFromVerification,
    ).mockResolvedValue(
      [
        "account_daily",
        "campaign_daily",
        "adset_daily",
        "ad_daily",
        "breakdown_daily",
      ].map(
        (surface) =>
          ({
            businessId: "biz-1",
            providerAccountId: "act_1",
            day: "2026-04-03",
            surface,
            state: "pending",
            accountTimezone: "UTC",
          }) as never,
      ),
    );

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-no-progress",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "core",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 2,
        leaseEpoch: 25,
        source: "historical",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-no-progress",
        partitionStatus: "cancelled",
        runStatus: "cancelled",
      }),
    );
    expect(warehouse.completeMetaPartitionAttempt).not.toHaveBeenCalledWith(
      expect.objectContaining({
        partitionStatus: "succeeded",
      }),
    );
    expect(warehouse.queueMetaSyncPartition).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "core",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        status: "queued",
        source: "historical",
      }),
    );
  });

  it("does not requeue creative warehouse partitions on core authoritative publication state", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-creative-finalize",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "creative_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 26,
        source: "finalize_day",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(creativesWarehouse.syncMetaCreativesWarehouseDay).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        day: "2026-04-03",
        assignedAccountIds: ["act_1"],
        sourceRunId: "partition-creative-finalize",
      }),
    );
    expect(warehouse.getMetaAuthoritativeDayVerification).not.toHaveBeenCalled();
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "partition-creative-finalize",
        partitionStatus: "succeeded",
        runStatus: "succeeded",
      }),
    );
    expect(warehouse.queueMetaSyncPartition).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "creative_daily",
        partitionDate: "2026-04-03",
        status: "queued",
      }),
    );
  });

  it("recovers the current running run id when run creation returns null", async () => {
    vi.mocked(warehouse.createMetaSyncRun).mockResolvedValue(null as never);
    vi.mocked(warehouse.getLatestRunningMetaSyncRunIdForPartition).mockResolvedValue("run-recovered");

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-4c",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "extended",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 20,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(warehouse.getLatestRunningMetaSyncRunIdForPartition).toHaveBeenCalledWith({
      partitionId: "partition-4c",
    });
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-recovered",
        partitionStatus: "succeeded",
      })
    );
  });

  it("completes core partitions before enqueueing extended follow-up work", async () => {
    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-5",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "core",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 21,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionStatus: "succeeded",
        runStatus: "succeeded",
      })
    );
    expect(warehouse.queueMetaSyncPartition).toHaveBeenCalled();
    expect(
      vi.mocked(warehouse.completeMetaPartitionAttempt).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(warehouse.queueMetaSyncPartition).mock.invocationCallOrder[0]!);
  });

  it("keeps parent success when post-success extended enqueue retries fail", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(warehouse.queueMetaSyncPartition).mockRejectedValue(new Error("queue write failed"));

    const processed = await processMetaLifecyclePartition({
      partition: {
        id: "partition-6",
        businessId: "biz-1",
        providerAccountId: "act_1",
        lane: "core",
        scope: "account_daily",
        partitionDate: "2026-04-03",
        attemptCount: 1,
        leaseEpoch: 22,
        source: "recent_recovery",
      },
      workerId: "worker-1",
    });

    expect(processed).toBe(true);
    expect(warehouse.completeMetaPartitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionStatus: "succeeded",
        runStatus: "succeeded",
      })
    );
    expect(warehouse.queueMetaSyncPartition).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      "[meta-sync] post_success_extended_enqueue_failed",
      expect.objectContaining({
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        attempts: 3,
        message: "queue write failed",
      })
    );
  });
});
