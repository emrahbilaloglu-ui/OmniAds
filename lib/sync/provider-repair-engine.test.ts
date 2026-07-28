import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMetaScheduledWork = vi.fn();
const syncMetaRepairRange = vi.fn();
const recoverMetaD1FinalizePartitions = vi.fn();
const refreshMetaSyncStateForBusiness = vi.fn();
const enqueueGoogleAdsScheduledWork = vi.fn();
const syncGoogleAdsRange = vi.fn();
const refreshGoogleAdsSyncStateForBusiness = vi.fn();
const getDb = vi.fn();
const runMigrations = vi.fn();
const getProviderAccountAssignments = vi.fn();
const readProviderAccountSnapshot = vi.fn();
const getProviderPlatformDateBoundaries = vi.fn();
const getProviderPlatformPreviousDate = vi.fn();
const validateMetaLiveAccountAccess = vi.fn();
const readGoogleAdsFreshness = vi.fn();

vi.mock("@/lib/sync/meta-sync", () => ({
  enqueueMetaScheduledWork,
  recoverMetaD1FinalizePartitions,
  refreshMetaSyncStateForBusiness,
  syncMetaRepairRange,
}));

vi.mock("@/lib/sync/google-ads-sync", () => ({
  enqueueGoogleAdsScheduledWork,
  syncGoogleAdsRange,
  refreshGoogleAdsSyncStateForBusiness,
}));

vi.mock("@/lib/meta/warehouse", () => ({
  cleanupMetaPartitionOrchestration: vi.fn(),
  getMetaAuthoritativeDayVerification: vi.fn(),
  reconcileMetaAuthoritativeDayStateFromVerification: vi.fn(),
  upsertMetaAuthoritativeDayState: vi.fn(),
  quarantineMetaTerminalActionRequiredPartitions: vi.fn(),
  replayMetaDeadLetterPartitions: vi.fn(),
  requeueMetaRetryableFailedPartitions: vi.fn(),
  getMetaQueueHealth: vi.fn(),
  getMetaCanonicalDriftIncidents: vi.fn(),
  getMetaWarehouseIntegrityIncidents: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments,
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderAccountSnapshot,
}));

vi.mock("@/lib/google-ads/warehouse", () => ({
  cleanupGoogleAdsPartitionOrchestration: vi.fn(),
  quarantineGoogleAdsTerminalActionRequiredPartitions: vi.fn(),
  replayGoogleAdsDeadLetterPartitions: vi.fn(),
  forceReplayGoogleAdsPoisonedPartitions: vi.fn(),
  requeueGoogleAdsRetryableFailedPartitions: vi.fn(),
  getGoogleAdsQueueHealth: vi.fn(),
  getGoogleAdsCheckpointHealth: vi.fn(),
  getGoogleAdsWarehouseIntegrityIncidents: vi.fn(),
  getGoogleAdsCoveredDates: vi.fn(),
}));

vi.mock("@/lib/google-ads/freshness-read", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-ads/freshness-read")>(
    "@/lib/google-ads/freshness-read",
  );
  // Only the evidence READ is faked; `toGoogleAdsFreshnessSummary` and the
  // verdict resolution stay real so these tests exercise production's mapping.
  return { ...actual, readGoogleAdsFreshness };
});

vi.mock("@/lib/provider-platform-date", () => ({
  getProviderPlatformDateBoundaries,
  getProviderPlatformPreviousDate,
}));

vi.mock("@/lib/sync/meta-live-auth", () => ({
  validateMetaLiveAccountAccess,
}));

vi.mock("@/lib/db", () => ({
  getDb,
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations,
}));

const GOOGLE_ADVISOR_SCOPES = ["search_term_daily", "product_daily"] as const;
const GOOGLE_ADVISOR_WINDOW_DAYS = 90;

const { resolveGoogleAdsCompletion, unknownGoogleAdsCompletion } = await import(
  "@/lib/google-ads/completion-semantics"
);

function googleAdvisorFreshnessSnapshot(input: {
  coveredDays: number;
  postCloseObservedDays: number;
  lookbackExhaustedDays?: number;
}) {
  const totalDays = GOOGLE_ADVISOR_WINDOW_DAYS;
  const verdict = resolveGoogleAdsCompletion({
    totalDays,
    coveredDays: input.coveredDays,
    postCloseObservedDays: input.postCloseObservedDays,
    lookbackExhaustedDays: input.lookbackExhaustedDays ?? 0,
    includesOpenDay: false,
  });
  return {
    businessId: "biz-1",
    startDate: "2026-01-07",
    endDate: "2026-04-06",
    totalDays,
    providerAccountIds: ["acc-1"],
    timeZoneSource: "account" as const,
    includesOpenDay: false,
    evidenceAvailable: true,
    unavailableReason: null,
    scopes: Object.fromEntries(
      GOOGLE_ADVISOR_SCOPES.map((scope) => [
        scope,
        {
          scope,
          coveredDays: input.coveredDays,
          postCloseObservedDays: input.postCloseObservedDays,
          lookbackExhaustedDays: input.lookbackExhaustedDays ?? 0,
          dueNowDays: totalDays - input.postCloseObservedDays,
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict,
        },
      ]),
    ),
    overall: verdict,
  };
}

function googleAdvisorUnavailableSnapshot(reason: string) {
  const verdict = unknownGoogleAdsCompletion(reason);
  return {
    businessId: "biz-1",
    startDate: "2026-01-07",
    endDate: "2026-04-06",
    totalDays: GOOGLE_ADVISOR_WINDOW_DAYS,
    providerAccountIds: [] as string[],
    timeZoneSource: "default" as const,
    includesOpenDay: true,
    evidenceAvailable: false,
    unavailableReason: reason,
    scopes: Object.fromEntries(
      GOOGLE_ADVISOR_SCOPES.map((scope) => [
        scope,
        {
          scope,
          coveredDays: 0,
          postCloseObservedDays: 0,
          lookbackExhaustedDays: 0,
          dueNowDays: 0,
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict,
        },
      ]),
    ),
    overall: verdict,
  };
}

/** Mock coverage as complete across whatever window the engine asks for. */
function mockFullGoogleAdsCoverage(
  mocked: { mockImplementation: (fn: (input: { startDate: string; endDate: string }) => Promise<string[]>) => unknown },
) {
  mocked.mockImplementation(async (input) => {
    const dates: string[] = [];
    const cursor = new Date(`${input.startDate}T00:00:00Z`);
    const end = new Date(`${input.endDate}T00:00:00Z`);
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  });
}

describe("provider repair engine", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    vi.resetAllMocks();
    runMigrations.mockResolvedValue(undefined);
    getDb.mockReturnValue(
      vi.fn(async () => [{ count: 0 }]) as never,
    );
    recoverMetaD1FinalizePartitions.mockResolvedValue({
      businessId: "biz-1",
      targetDate: "2026-04-06",
      candidateCount: 0,
      aliveSlowCount: 0,
      stalledReclaimableCount: 0,
      reclaimedPartitionIds: [],
      reconciledRunCount: 0,
      d1FinalizeRecoveryQueued: false,
      requeueResult: null,
    });
    refreshMetaSyncStateForBusiness.mockResolvedValue(undefined);
    refreshGoogleAdsSyncStateForBusiness.mockResolvedValue(undefined);
    syncGoogleAdsRange.mockResolvedValue(undefined);
    validateMetaLiveAccountAccess.mockResolvedValue({
      status: "invalid",
      checkedAccountCount: 0,
      validAccountIds: [],
      invalidAccountIds: [],
      unknownAccountIds: [],
      errorMessage: null,
    });
    const googleAdsWarehouse = await import("@/lib/google-ads/warehouse");
    vi.mocked(
      googleAdsWarehouse.quarantineGoogleAdsTerminalActionRequiredPartitions,
    ).mockResolvedValue({
      candidateCount: 0,
      terminalMatchedCount: 0,
      changedCount: 0,
      partitions: [],
    } as never);
    vi.mocked(
      googleAdsWarehouse.requeueGoogleAdsRetryableFailedPartitions,
    ).mockResolvedValue([] as never);
    // Default: the advisor window is covered, re-read after every close, and
    // past the conversion lookback. Tests that care override this.
    readGoogleAdsFreshness.mockResolvedValue(
      googleAdvisorFreshnessSnapshot({
        coveredDays: GOOGLE_ADVISOR_WINDOW_DAYS,
        postCloseObservedDays: GOOGLE_ADVISOR_WINDOW_DAYS,
        lookbackExhaustedDays: GOOGLE_ADVISOR_WINDOW_DAYS,
      }),
    );
    getProviderAccountAssignments.mockResolvedValue(null);
    readProviderAccountSnapshot.mockResolvedValue(null);
    getProviderPlatformDateBoundaries.mockResolvedValue([
      {
        provider: "meta",
        businessId: "biz-1",
        providerAccountId: "act_1",
        timeZone: "UTC",
        currentDate: "2026-04-07",
        previousDate: "2026-04-06",
        isPrimary: true,
      },
    ]);
    getProviderPlatformPreviousDate.mockResolvedValue("2026-04-06");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces Meta cleanup summary on successful repair", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 2,
      stalePartitionCount: 1,
      aliveSlowCount: 1,
      reconciledRunCount: 1,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {
        stalledReclaimable: ["lease_expired_no_progress"],
      },
      preservedByReason: {
        recentCheckpointProgress: 1,
        matchingRunnerLeasePresent: 0,
        leaseNotExpired: 0,
      },
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", { enqueueScheduledWork: false });

    expect(result.repair.blocked).toBe(false);
    expect(result.repair.reclaimed).toBe(1);
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        cleanupSummary: expect.objectContaining({
          candidateCount: 2,
          stalePartitionCount: 1,
          reconciledRunCount: 1,
        }),
        cleanupError: null,
        integrityIncidentCount: 0,
        d1FinalizeRecoveryQueued: false,
        stageTimings: expect.arrayContaining([
          expect.objectContaining({
            stage: "runMetaRepairCycle.cleanup",
            ok: true,
          }),
          expect.objectContaining({
            stage: "runMetaRepairCycle.refresh_state",
            ok: true,
          }),
        ]),
      })
    );
    expect(refreshMetaSyncStateForBusiness).toHaveBeenCalledWith({
      businessId: "biz-1",
    });
  });

  it("replays stale Meta action-required dead letters when live account access validates", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(
      metaWarehouse.quarantineMetaTerminalActionRequiredPartitions,
    ).mockResolvedValue({
      candidateCount: 0,
      terminalMatchedCount: 0,
      changedCount: 0,
      partitions: [],
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions)
      .mockResolvedValueOnce({
        outcome: "no_matching_partitions",
        partitions: [],
        matchedCount: 2,
        changedCount: 0,
        skippedActiveLeaseCount: 0,
        replayableMatchedCount: 0,
        terminalActionRequiredCount: 2,
        unknownMatchedCount: 0,
        manualTruthDefectCount: 0,
        manualTruthDefectPartitions: [],
      } as never)
      .mockResolvedValueOnce({
        outcome: "replayed",
        partitions: [
          {
            id: "partition-1",
            lane: "maintenance",
            scope: "account_daily",
            partitionDate: "2026-04-12",
          },
          {
            id: "partition-2",
            lane: "maintenance",
            scope: "account_daily",
            partitionDate: "2026-04-13",
          },
        ],
        matchedCount: 2,
        changedCount: 2,
        skippedActiveLeaseCount: 0,
        replayableMatchedCount: 0,
        terminalActionRequiredCount: 2,
        unknownMatchedCount: 0,
        manualTruthDefectCount: 0,
        manualTruthDefectPartitions: [],
      } as never);
    validateMetaLiveAccountAccess.mockResolvedValue({
      status: "valid",
      checkedAccountCount: 1,
      validAccountIds: ["act_1"],
      invalidAccountIds: [],
      unknownAccountIds: [],
      errorMessage: null,
    });
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 2,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", { enqueueScheduledWork: false });

    expect(validateMetaLiveAccountAccess).toHaveBeenCalledWith({ businessId: "biz-1" });
    expect(metaWarehouse.replayMetaDeadLetterPartitions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        businessId: "biz-1",
        recoveryKinds: ["terminal_action_required"],
      }),
    );
    expect(result.repair.replayed).toBe(2);
    expect(result.repair.blocked).toBe(false);
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        staleActionRequiredLiveAuth: expect.objectContaining({
          status: "valid",
        }),
        staleActionRequiredDeadLetters: expect.objectContaining({
          changedCount: 2,
        }),
      }),
    );
  });

  it("surfaces cleanup_error when Meta cleanup throws", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockRejectedValue(
      new Error("cleanup blew up")
    );
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", { enqueueScheduledWork: false });

    expect(result.repair.reclaimed).toBe(0);
    expect(result.repair.blocked).toBe(true);
    expect(result.repair.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "cleanup_error",
          repairable: true,
        }),
      ])
    );
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        cleanupSummary: null,
        cleanupError: "cleanup blew up",
        stageTimings: expect.arrayContaining([
          expect.objectContaining({
            stage: "runMetaRepairCycle.cleanup",
            ok: false,
            errorMessage: "cleanup blew up",
          }),
        ]),
      })
    );
  });

  it("treats blocked publication mismatches as blocked auto-heal outcomes", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_1"],
    });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_1", timezone: "UTC" }],
    });
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaAuthoritativeDayVerification).mockImplementation(
      async ({ day }) =>
        day === "2026-04-05"
          ? ({
              businessId: "biz-1",
              providerAccountId: "act_1",
              day: "2026-04-05",
              verificationState: "blocked",
              sourceManifestState: "completed",
              validationState: "blocked",
              activePublication: null,
              surfaces: [
                {
                  surface: "account_daily",
                  manifest: null,
                  publication: null,
                  detectorState: "blocked",
                  detectorReasonCode: "publication_pointer_missing_after_finalize",
                },
              ],
              lastFailure: null,
              detectorReasonCodes: ["publication_pointer_missing_after_finalize"],
              repairBacklog: 0,
              deadLetters: 0,
              staleLeases: 0,
              queuedPartitions: 0,
              leasedPartitions: 0,
            } as never)
          : (null as never),
    );
    vi.mocked(
      metaWarehouse.reconcileMetaAuthoritativeDayStateFromVerification,
    ).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.upsertMetaAuthoritativeDayState).mockResolvedValue(
      null as never,
    );

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", {
      enqueueScheduledWork: false,
      queueWarehouseRepairs: true,
    });

    expect(result.repair.blocked).toBe(true);
    expect(result.repair.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "blocked_authoritative_publication_mismatch",
          repairable: false,
        }),
      ]),
    );
    expect(result.repair.repairableActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "inspect_blocked_authoritative_days",
          available: true,
        }),
      ]),
    );
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        recentAuthoritativeWindow: expect.objectContaining({
          blockedDays: 1,
        }),
        queuedRecentAuthoritativeRepairs: 0,
      }),
    );
    expect(syncMetaRepairRange).not.toHaveBeenCalled();
  });

  it("keeps stale-lease proof cases non-terminal until no-progress evidence exists", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_1"],
    });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_1", timezone: "UTC" }],
    });
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 1,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: { recentCheckpointProgress: 1 },
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaAuthoritativeDayVerification).mockImplementation(
      async ({ day }) =>
        day === "2026-04-05"
          ? ({
              businessId: "biz-1",
              providerAccountId: "act_1",
              day: "2026-04-05",
              verificationState: "processing",
              sourceManifestState: "completed",
              validationState: "processing",
              activePublication: null,
              surfaces: [
                {
                  surface: "account_daily",
                  manifest: null,
                  publication: null,
                  detectorState: "pending",
                  detectorReasonCode: "stale_lease_pending_proof",
                },
              ],
              lastFailure: null,
              detectorReasonCodes: ["stale_lease_pending_proof"],
              repairBacklog: 0,
              deadLetters: 0,
              staleLeases: 1,
              queuedPartitions: 0,
              leasedPartitions: 0,
            } as never)
          : (null as never),
    );
    vi.mocked(
      metaWarehouse.reconcileMetaAuthoritativeDayStateFromVerification,
    ).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.upsertMetaAuthoritativeDayState).mockResolvedValue(
      null as never,
    );

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", {
      enqueueScheduledWork: false,
      queueWarehouseRepairs: true,
    });

    expect(result.repair.blocked).toBe(false);
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        recentAuthoritativeWindow: expect.objectContaining({
          staleLeaseProofDays: 1,
          blockedDays: 0,
        }),
        queuedRecentAuthoritativeRepairs: 0,
      }),
    );
    expect(result.repair.repairableActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "prove_stale_leases_before_cleanup",
          available: true,
        }),
      ]),
    );
    expect(syncMetaRepairRange).not.toHaveBeenCalled();
  });

  it("requeues idle queued Meta authoritative days so repair sources can take priority", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_1"],
    });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_1", timezone: "UTC" }],
    });
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 1,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaAuthoritativeDayVerification).mockImplementation(
      async ({ day }) =>
        day === "2026-04-12"
          ? ({
              businessId: "biz-1",
              providerAccountId: "act_1",
              day: "2026-04-12",
              verificationState: "processing",
              sourceManifestState: "missing",
              validationState: "processing",
              activePublication: null,
              surfaces: [
                {
                  surface: "account_daily",
                  manifest: null,
                  publication: null,
                  detectorState: "queued",
                  detectorReasonCode: "authoritative_retry_pending",
                },
              ],
              lastFailure: null,
              detectorReasonCodes: ["authoritative_retry_pending"],
              repairBacklog: 1,
              deadLetters: 0,
              staleLeases: 0,
              queuedPartitions: 1,
              leasedPartitions: 0,
            } as never)
          : ({
              businessId: "biz-1",
              providerAccountId: "act_1",
              day,
              verificationState: "finalized_verified",
              sourceManifestState: "completed",
              validationState: "passed",
              activePublication: null,
              surfaces: [],
              lastFailure: null,
              detectorReasonCodes: [],
              repairBacklog: 0,
              deadLetters: 0,
              staleLeases: 0,
              queuedPartitions: 0,
              leasedPartitions: 0,
            } as never),
    );
    vi.mocked(
      metaWarehouse.reconcileMetaAuthoritativeDayStateFromVerification,
    ).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.upsertMetaAuthoritativeDayState).mockResolvedValue(
      null as never,
    );
    syncMetaRepairRange.mockResolvedValue({
      businessId: "biz-1",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    });

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", {
      enqueueScheduledWork: false,
      queueWarehouseRepairs: true,
    });

    expect(metaWarehouse.getMetaWarehouseIntegrityIncidents).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        endDate: "2026-04-06",
        persistReconciliationEvents: true,
      }),
    );
    expect(syncMetaRepairRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        startDate: "2026-04-12",
        endDate: "2026-04-12",
        triggerSource: "repair_recent_day",
      }),
    );
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        recentAuthoritativeWindow: expect.objectContaining({
          retryableQueuedDays: 1,
          blockedDays: 0,
        }),
        recentAuthoritativeRepairRanges: [
          { startDate: "2026-04-12", endDate: "2026-04-12" },
        ],
        queuedRecentAuthoritativeRepairs: 1,
      }),
    );
  });

  it("requeues idle pending Meta authoritative days when no work remains queued", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_1"],
    });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_1", timezone: "UTC" }],
    });
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaAuthoritativeDayVerification).mockImplementation(
      async ({ day }) =>
        day === "2026-04-12"
          ? ({
              businessId: "biz-1",
              providerAccountId: "act_1",
              day: "2026-04-12",
              verificationState: "processing",
              sourceManifestState: "missing",
              validationState: "processing",
              activePublication: null,
              surfaces: [
                {
                  surface: "account_daily",
                  manifest: null,
                  publication: null,
                  detectorState: "pending",
                  detectorReasonCode: "awaiting_authoritative_work",
                },
              ],
              lastFailure: null,
              detectorReasonCodes: ["awaiting_authoritative_work"],
              repairBacklog: 0,
              deadLetters: 0,
              staleLeases: 0,
              queuedPartitions: 0,
              leasedPartitions: 0,
            } as never)
          : ({
              businessId: "biz-1",
              providerAccountId: "act_1",
              day,
              verificationState: "finalized_verified",
              sourceManifestState: "completed",
              validationState: "passed",
              activePublication: null,
              surfaces: [],
              lastFailure: null,
              detectorReasonCodes: [],
              repairBacklog: 0,
              deadLetters: 0,
              staleLeases: 0,
              queuedPartitions: 0,
              leasedPartitions: 0,
            } as never),
    );
    vi.mocked(
      metaWarehouse.reconcileMetaAuthoritativeDayStateFromVerification,
    ).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.upsertMetaAuthoritativeDayState).mockResolvedValue(
      null as never,
    );
    syncMetaRepairRange.mockResolvedValue({
      businessId: "biz-1",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    });

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", {
      enqueueScheduledWork: false,
      queueWarehouseRepairs: true,
    });

    expect(syncMetaRepairRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        startDate: "2026-04-12",
        endDate: "2026-04-12",
        triggerSource: "repair_recent_day",
      }),
    );
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        recentAuthoritativeWindow: expect.objectContaining({
          idlePendingDays: 1,
          blockedDays: 0,
        }),
        recentAuthoritativeRepairRanges: [
          { startDate: "2026-04-12", endDate: "2026-04-12" },
        ],
        queuedRecentAuthoritativeRepairs: 1,
      }),
    );
  });

  it("queues integrity repair windows when warehouse incidents are found", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-01",
        scope: "system",
        severity: "error",
        metricsCompared: ["spend"],
        delta: {},
        provenanceState: "missing_source_run",
        repairRecommended: true,
        repairStatus: "pending",
        suspectedCause: "missing_provenance",
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-02",
        scope: "system",
        severity: "error",
        metricsCompared: ["clicks"],
        delta: {},
        provenanceState: "legacy_schema",
        repairRecommended: true,
        repairStatus: "pending",
        suspectedCause: "legacy_click_semantics",
      },
    ] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);
    syncMetaRepairRange.mockResolvedValue({
      businessId: "biz-1",
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", {
      enqueueScheduledWork: false,
      queueWarehouseRepairs: true,
    });

    expect(syncMetaRepairRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        startDate: "2026-04-01",
        endDate: "2026-04-02",
        triggerSource: "priority_window",
      }),
    );
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        integrityIncidentCount: 2,
        integrityAttemptCount: 1,
        queuedWarehouseRepairs: 1,
        integrityRepairRanges: [
          { startDate: "2026-04-01", endDate: "2026-04-02" },
        ],
      }),
    );
  });

  it("blocks Meta auto-heal when finalized truth defects remain dead-lettered", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 1,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 1,
      manualTruthDefectPartitions: [
        {
          id: "partition-1",
          scope: "account_daily",
          partitionDate: "2026-04-01",
          lastError: "Meta finalized truth validation failed",
        },
      ],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 1,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", { enqueueScheduledWork: false });

    expect(result.repair.blocked).toBe(true);
    expect(result.repair.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manual_truth_defect",
          repairable: false,
        }),
      ]),
    );
  });

  it("keeps the first Google integrity mismatch attempt repairable", async () => {
    const googleAdsWarehouse = await import("@/lib/google-ads/warehouse");
    vi.mocked(googleAdsWarehouse.cleanupGoogleAdsPartitionOrchestration).mockResolvedValue({
      stalePartitionCount: 1,
    } as never);
    vi.mocked(googleAdsWarehouse.replayGoogleAdsDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.forceReplayGoogleAdsPoisonedPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsCheckpointHealth).mockResolvedValue({
      latestCheckpointScope: null,
      latestCheckpointPhase: null,
      latestCheckpointStatus: null,
      latestCheckpointUpdatedAt: null,
      checkpointLagMinutes: null,
      lastSuccessfulPageIndex: null,
      resumeCapable: false,
      checkpointFailures: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsCoveredDates).mockImplementation(
      async (input) => {
        const dates: string[] = [];
        const cursor = new Date(`${input.startDate}T00:00:00Z`);
        const end = new Date(`${input.endDate}T00:00:00Z`);
        while (cursor <= end) {
          dates.push(cursor.toISOString().slice(0, 10));
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        return dates as never;
      },
    );
    vi.mocked(googleAdsWarehouse.getGoogleAdsWarehouseIntegrityIncidents)
      .mockResolvedValueOnce([
        {
          businessId: "biz-1",
          providerAccountId: "acc-1",
          date: "2026-04-01",
          scope: "system",
          severity: "error",
          metricsCompared: ["spend"],
          delta: {},
          repairRecommended: true,
          repairStatus: "pending",
          suspectedCause: "account_campaign_drift",
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          businessId: "biz-1",
          providerAccountId: "acc-1",
          date: "2026-04-01",
          scope: "system",
          severity: "error",
          metricsCompared: ["spend"],
          delta: {},
          repairRecommended: true,
          repairStatus: "pending",
          suspectedCause: "account_campaign_drift",
        },
      ] as never);
    syncGoogleAdsRange.mockResolvedValue({
      businessId: "biz-1",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    });

    const { runGoogleAdsRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runGoogleAdsRepairCycle("biz-1", {
      enqueueScheduledWork: false,
      queueWarehouseRepairs: true,
    });

    expect(syncGoogleAdsRange).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        startDate: "2026-04-01",
        endDate: "2026-04-01",
        scopes: ["account_daily", "campaign_daily"],
      }),
    );
    expect(refreshGoogleAdsSyncStateForBusiness).toHaveBeenCalledWith({
      businessId: "biz-1",
      scopes: ["account_daily", "campaign_daily", "search_term_daily", "product_daily"],
    });
    expect(result.repair.blocked).toBe(false);
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        integrityAttemptCount: 1,
        remainingMismatchDates: ["2026-04-01"],
      }),
    );
  });

  it("runs Google integrity repair windows and blocks on persistent mismatches", async () => {
    const googleAdsWarehouse = await import("@/lib/google-ads/warehouse");
    vi.mocked(googleAdsWarehouse.cleanupGoogleAdsPartitionOrchestration).mockResolvedValue({
      stalePartitionCount: 1,
    } as never);
    vi.mocked(googleAdsWarehouse.replayGoogleAdsDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.forceReplayGoogleAdsPoisonedPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsCheckpointHealth).mockResolvedValue({
      latestCheckpointScope: null,
      latestCheckpointPhase: null,
      latestCheckpointStatus: null,
      latestCheckpointUpdatedAt: null,
      checkpointLagMinutes: null,
      lastSuccessfulPageIndex: null,
      resumeCapable: false,
      checkpointFailures: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsCoveredDates).mockImplementation(
      async (input) => {
        const dates: string[] = [];
        const cursor = new Date(`${input.startDate}T00:00:00Z`);
        const end = new Date(`${input.endDate}T00:00:00Z`);
        while (cursor <= end) {
          dates.push(cursor.toISOString().slice(0, 10));
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        return dates as never;
      },
    );
    vi.mocked(googleAdsWarehouse.getGoogleAdsWarehouseIntegrityIncidents)
      .mockResolvedValueOnce([
        {
          businessId: "biz-1",
          providerAccountId: "acc-1",
          date: "2026-04-01",
          scope: "system",
          severity: "error",
          metricsCompared: ["spend"],
          delta: {},
          repairRecommended: true,
          repairStatus: "pending",
          suspectedCause: "account_campaign_drift",
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          businessId: "biz-1",
          providerAccountId: "acc-1",
          date: "2026-04-01",
          scope: "system",
          severity: "error",
          metricsCompared: ["spend"],
          delta: {},
          repairRecommended: true,
          repairStatus: "pending",
          suspectedCause: "account_campaign_drift",
        },
      ] as never);
    getDb.mockReturnValue(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join(" ");
        if (query.includes("FROM admin_audit_logs")) {
          return [{ count: 1 }];
        }
        return [];
      }) as never,
    );
    syncGoogleAdsRange.mockResolvedValue({
      businessId: "biz-1",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    });

    const { runGoogleAdsRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runGoogleAdsRepairCycle("biz-1", {
      enqueueScheduledWork: false,
      queueWarehouseRepairs: true,
    });

    expect(result.repair.blocked).toBe(true);
    expect(result.repair.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "integrity_mismatch_persistent",
          repairable: false,
        }),
      ]),
    );
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        integrityAttemptCount: 2,
      }),
    );
  });

  it("blocks Google auto repair on terminal account action-required dead letters", async () => {
    const googleAdsWarehouse = await import("@/lib/google-ads/warehouse");
    vi.mocked(googleAdsWarehouse.cleanupGoogleAdsPartitionOrchestration).mockResolvedValue({
      stalePartitionCount: 0,
      staleRunCount: 0,
      poisonCandidateCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.replayGoogleAdsDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 1,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      replayableMatchedCount: 0,
      terminalActionRequiredCount: 1,
      unknownMatchedCount: 0,
      actionRequiredPartitions: [
        {
          id: "partition-auth",
          scope: "campaign_daily",
          source: "historical",
          partitionDate: "2026-05-01",
          lastError: "invalid_grant: token has been expired or revoked",
          errorClass: "account_action_required",
          reasonCode: "google_ads_auth_action_required",
        },
      ],
    } as never);
    vi.mocked(googleAdsWarehouse.forceReplayGoogleAdsPoisonedPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 1,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsCheckpointHealth).mockResolvedValue({
      latestCheckpointScope: null,
      latestCheckpointPhase: null,
      latestCheckpointStatus: null,
      latestCheckpointUpdatedAt: null,
      checkpointLagMinutes: null,
      lastSuccessfulPageIndex: null,
      resumeCapable: false,
      checkpointFailures: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsWarehouseIntegrityIncidents).mockResolvedValue([] as never);

    const { runGoogleAdsRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runGoogleAdsRepairCycle("biz-1", {
      enqueueScheduledWork: false,
    });

    expect(googleAdsWarehouse.replayGoogleAdsDeadLetterPartitions).toHaveBeenCalledWith({
      businessId: "biz-1",
      recoveryKinds: ["replayable_transient"],
    });
    expect(result.repair.blocked).toBe(true);
    expect(result.repair.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "account_action_required",
          repairable: false,
        }),
      ]),
    );
  });

  it("quarantines queued Meta checkpoint partitions and blocks replay as account action required", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(metaWarehouse.quarantineMetaTerminalActionRequiredPartitions).mockResolvedValue({
      candidateCount: 1,
      terminalMatchedCount: 1,
      changedCount: 1,
      partitions: [
        {
          id: "partition-checkpoint",
          lane: "maintenance",
          scope: "account_daily",
          source: "finalize_day",
          partitionDate: "2026-05-09",
          reasonCode: "meta_account_checkpoint",
        },
      ],
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 1,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      replayableMatchedCount: 0,
      terminalActionRequiredCount: 1,
      unknownMatchedCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
      actionRequiredPartitions: [
        {
          id: "partition-checkpoint",
          scope: "account_daily",
          source: "finalize_day",
          partitionDate: "2026-05-09",
          lastError: "You cannot access the app till you log in to www.facebook.com and follow the instructions given.",
          errorClass: "account_checkpoint",
          reasonCode: "meta_account_checkpoint",
        },
      ],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 1,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([] as never);

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", { enqueueScheduledWork: false });

    expect(result.repair.blocked).toBe(true);
    expect(result.repair.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "account_action_required",
          repairable: false,
        }),
      ]),
    );
    expect(result.repair.meta).toEqual(
      expect.objectContaining({
        quarantinedTerminalActionRequired: expect.objectContaining({
          changedCount: 1,
        }),
        stageTimings: expect.arrayContaining([
          expect.objectContaining({
            stage: "runMetaRepairCycle.quarantine_terminal_action_required",
            ok: true,
          }),
        ]),
      }),
    );
  });

  it("blocks Meta when canonical drift repeats within 24 hours", async () => {
    const metaWarehouse = await import("@/lib/meta/warehouse");
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      candidateCount: 0,
      stalePartitionCount: 0,
      aliveSlowCount: 0,
      reconciledRunCount: 0,
      staleRunCount: 0,
      staleLegacyCount: 0,
      reclaimReasons: {},
      preservedByReason: {},
    } as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
      manualTruthDefectCount: 0,
      manualTruthDefectPartitions: [],
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      retryableFailedPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.getMetaCanonicalDriftIncidents).mockResolvedValue([
      {
        providerAccountId: "act_1",
        date: "2026-04-01",
        sourceSpend: 9,
        warehouseAccountSpend: 12.5,
        warehouseCampaignSpend: 12.5,
        occurrenceCount: 2,
        latestCreatedAt: "2026-04-07T10:00:00.000Z",
        signature: "act_1:2026-04-01:9:12.5:12.5",
      },
    ] as never);

    const { runMetaRepairCycle } = await import("@/lib/sync/provider-repair-engine");
    const result = await runMetaRepairCycle("biz-1", { enqueueScheduledWork: false });

    expect(result.repair.blocked).toBe(true);
    expect(result.repair.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manual_truth_defect",
          repairable: false,
        }),
      ]),
    );
  });

  /**
   * The Google recent-gap gate used to conclude "nothing to repair" from
   * `SELECT DISTINCT date`. Every test below pins coverage COMPLETE, so a
   * regression to the coverage-based gate makes each of them read `blocked:
   * false` with no blocking reason — that is the negative control.
   */
  describe("Google advisor recency claims", () => {
    async function setUpQuietGoogleRepairCycle() {
      const googleAdsWarehouse = await import("@/lib/google-ads/warehouse");
      vi.mocked(googleAdsWarehouse.cleanupGoogleAdsPartitionOrchestration).mockResolvedValue({
        stalePartitionCount: 0,
      } as never);
      vi.mocked(googleAdsWarehouse.replayGoogleAdsDeadLetterPartitions).mockResolvedValue({
        outcome: "no_matching_partitions",
        partitions: [],
        matchedCount: 0,
        changedCount: 0,
        skippedActiveLeaseCount: 0,
      } as never);
      vi.mocked(googleAdsWarehouse.forceReplayGoogleAdsPoisonedPartitions).mockResolvedValue({
        outcome: "no_matching_partitions",
        partitions: [],
        matchedCount: 0,
        changedCount: 0,
        skippedActiveLeaseCount: 0,
      } as never);
      vi.mocked(googleAdsWarehouse.getGoogleAdsQueueHealth).mockResolvedValue({
        queueDepth: 0,
        leasedPartitions: 0,
        deadLetterPartitions: 0,
        retryableFailedPartitions: 0,
      } as never);
      vi.mocked(googleAdsWarehouse.getGoogleAdsCheckpointHealth).mockResolvedValue({
        checkpointFailures: 0,
      } as never);
      vi.mocked(googleAdsWarehouse.getGoogleAdsWarehouseIntegrityIncidents).mockResolvedValue(
        [] as never,
      );
      syncGoogleAdsRange.mockResolvedValue({
        businessId: "biz-1",
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: false,
      });
      return googleAdsWarehouse;
    }

    it("refuses to report a clean cycle when covered days were never re-read after closing", async () => {
      const googleAdsWarehouse = await setUpQuietGoogleRepairCycle();
      mockFullGoogleAdsCoverage(
        vi.mocked(googleAdsWarehouse.getGoogleAdsCoveredDates) as never,
      );
      readGoogleAdsFreshness.mockResolvedValue(
        googleAdvisorFreshnessSnapshot({
          coveredDays: GOOGLE_ADVISOR_WINDOW_DAYS,
          postCloseObservedDays: 0,
        }),
      );

      const { runGoogleAdsRepairCycle } = await import("@/lib/sync/provider-repair-engine");
      const result = await runGoogleAdsRepairCycle("biz-1", {
        enqueueScheduledWork: false,
        queueWarehouseRepairs: true,
      });

      expect(result.repair.blocked).toBe(true);
      expect(result.repair.blockingReasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "recent_surface_never_reobserved",
            // Retryable: the rolling refresh will get to them.
            repairable: true,
          }),
        ]),
      );
      expect(result.repair.meta).toEqual(
        expect.objectContaining({
          recentSurfaceComplete: false,
          recentSurfaceState: "provisional",
          recentGapRepairScopes: [],
        }),
      );
      expect(
        (result.repair.meta as { recentSurfaceUnreobservedScopes: unknown[] })
          .recentSurfaceUnreobservedScopes,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: "search_term_daily",
            unreobservedDays: GOOGLE_ADVISOR_WINDOW_DAYS,
          }),
        ]),
      );
      // Reported, not enqueued: the bounded rolling refresh owns these days, so
      // the ~1/min cycle must not queue the whole 90-day window.
      expect(syncGoogleAdsRange).not.toHaveBeenCalled();
    });

    it("fails closed and stays retryable when the freshness evidence cannot be read", async () => {
      const googleAdsWarehouse = await setUpQuietGoogleRepairCycle();
      mockFullGoogleAdsCoverage(
        vi.mocked(googleAdsWarehouse.getGoogleAdsCoveredDates) as never,
      );
      readGoogleAdsFreshness.mockResolvedValue(
        googleAdvisorUnavailableSnapshot("Google Ads freshness tables are not ready yet."),
      );

      const { runGoogleAdsRepairCycle } = await import("@/lib/sync/provider-repair-engine");
      const result = await runGoogleAdsRepairCycle("biz-1", {
        enqueueScheduledWork: false,
        queueWarehouseRepairs: true,
      });

      expect(result.repair.blocked).toBe(true);
      expect(result.repair.blockingReasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "recent_surface_freshness_unverified",
            repairable: true,
          }),
        ]),
      );
      expect(result.repair.meta).toEqual(
        expect.objectContaining({
          recentSurfaceFreshnessUnverified: true,
          recentSurfaceComplete: false,
          recentSurfaceState: "unknown",
        }),
      );
    });

    it("reports a clean cycle only when every advisor day was re-read after it closed", async () => {
      const googleAdsWarehouse = await setUpQuietGoogleRepairCycle();
      mockFullGoogleAdsCoverage(
        vi.mocked(googleAdsWarehouse.getGoogleAdsCoveredDates) as never,
      );
      readGoogleAdsFreshness.mockResolvedValue(
        googleAdvisorFreshnessSnapshot({
          coveredDays: GOOGLE_ADVISOR_WINDOW_DAYS,
          postCloseObservedDays: GOOGLE_ADVISOR_WINDOW_DAYS,
          lookbackExhaustedDays: GOOGLE_ADVISOR_WINDOW_DAYS,
        }),
      );

      const { runGoogleAdsRepairCycle } = await import("@/lib/sync/provider-repair-engine");
      const result = await runGoogleAdsRepairCycle("biz-1", {
        enqueueScheduledWork: false,
        queueWarehouseRepairs: true,
      });

      expect(result.repair.blocked).toBe(false);
      expect(result.repair.meta).toEqual(
        expect.objectContaining({
          recentSurfaceComplete: true,
          recentSurfaceState: "settled",
          recentSurfaceFreshnessUnverified: false,
        }),
      );
    });

    it("still queues genuinely missing advisor days from row existence alone", async () => {
      const googleAdsWarehouse = await setUpQuietGoogleRepairCycle();
      // Zero rows on 2026-04-06 for both advisor scopes: a real gap, detected
      // exactly as before and independent of any freshness verdict.
      vi.mocked(googleAdsWarehouse.getGoogleAdsCoveredDates).mockImplementation(
        async (input) => {
          const dates: string[] = [];
          const cursor = new Date(`${input.startDate}T00:00:00Z`);
          const end = new Date(`${input.endDate}T00:00:00Z`);
          while (cursor <= end) {
            const date = cursor.toISOString().slice(0, 10);
            if (date !== "2026-04-06") dates.push(date);
            cursor.setUTCDate(cursor.getUTCDate() + 1);
          }
          return dates as never;
        },
      );
      readGoogleAdsFreshness.mockResolvedValue(
        googleAdvisorFreshnessSnapshot({
          coveredDays: GOOGLE_ADVISOR_WINDOW_DAYS - 1,
          postCloseObservedDays: GOOGLE_ADVISOR_WINDOW_DAYS - 1,
          lookbackExhaustedDays: GOOGLE_ADVISOR_WINDOW_DAYS - 1,
        }),
      );

      const { runGoogleAdsRepairCycle } = await import("@/lib/sync/provider-repair-engine");
      const result = await runGoogleAdsRepairCycle("biz-1", {
        enqueueScheduledWork: false,
        queueWarehouseRepairs: true,
      });

      expect(syncGoogleAdsRange).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2026-04-06",
          endDate: "2026-04-06",
          scopes: ["search_term_daily"],
          triggerSource: "repair_recent_day:search_term_daily",
        }),
      );
      expect(result.repair.meta).toEqual(
        expect.objectContaining({
          recentGapRepairScopes: expect.arrayContaining([
            expect.objectContaining({
              scope: "product_daily",
              missingDates: ["2026-04-06"],
            }),
          ]),
        }),
      );
      expect(result.repair.blockingReasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "missing_recent_required_surfaces" }),
        ]),
      );
    });
  });
});
