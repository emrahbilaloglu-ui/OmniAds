import { beforeEach, describe, expect, it, vi } from "vitest";

const queueGoogleAdsSyncPartition = vi.fn();
const leaseGoogleAdsSyncPartitions = vi.fn();
const getGoogleAdsSyncCheckpoint = vi.fn();
const upsertGoogleAdsSyncCheckpoint = vi.fn();
const getGoogleAdsCheckpointHealth = vi.fn();
const getConnectedAssignedGoogleAccounts = vi.fn();
const processGoogleAdsLifecyclePartition = vi.fn();
const buildGoogleAdsWorkerLeasePlan = vi.fn();
const syncGoogleAdsReports = vi.fn();
const releaseGoogleAdsLeasedPartitionsForWorker = vi.fn();

const resolveMetaCredentials = vi.fn();
const getMetaCheckpointHealth = vi.fn();
const getMetaSyncCheckpoint = vi.fn();
const upsertMetaSyncCheckpoint = vi.fn();
const processMetaLifecyclePartition = vi.fn();
const leaseMetaSyncPartitions = vi.fn();
const quarantineMetaTerminalActionRequiredPartitions = vi.fn();
const queueMetaSyncPartition = vi.fn();
const buildMetaWorkerLeasePlan = vi.fn();
const consumeMetaQueuedWork = vi.fn();
const releaseMetaLeasedPartitionsForWorker = vi.fn();
const runMetaRepairCycle = vi.fn();
const runGoogleAdsRepairCycle = vi.fn();
const runAutoSyncRepairPass = vi.fn();
const mergeAutoRepairResult = vi.fn();
const getIntegration = vi.fn();
const upsertIntegration = vi.fn();
const fetchGoogleAdsAccounts = vi.fn();
const refreshGoogleAccessToken = vi.fn();
const fetchMetaAdAccounts = vi.fn();
const getMetaApiErrorMessage = vi.fn();
const readProviderAccountSnapshot = vi.fn();
const resolveProviderAccountSnapshot = vi.fn();
const scheduleProviderAccountSnapshotRefresh = vi.fn();

class MockProviderAccountSnapshotRefreshError extends Error {
  dueToRecentFailure: boolean;

  constructor(input: { message: string; dueToRecentFailure?: boolean }) {
    super(input.message);
    this.dueToRecentFailure = input.dueToRecentFailure ?? false;
  }
}

vi.mock("@/lib/google-ads-gaql", () => ({
  getConnectedAssignedGoogleAccounts,
}));

vi.mock("@/lib/google-ads/warehouse", () => ({
  getGoogleAdsCheckpointHealth,
  getGoogleAdsSyncCheckpoint,
  leaseGoogleAdsSyncPartitions,
  queueGoogleAdsSyncPartition,
  releaseGoogleAdsLeasedPartitionsForWorker,
  upsertGoogleAdsSyncCheckpoint,
}));

vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials,
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration,
  upsertIntegration,
}));

vi.mock("@/lib/google-ads-accounts", () => ({
  fetchGoogleAdsAccounts,
  refreshGoogleAccessToken,
}));

vi.mock("@/lib/meta-ad-accounts", () => ({
  fetchMetaAdAccounts,
  getMetaApiErrorMessage,
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  ProviderAccountSnapshotRefreshError: MockProviderAccountSnapshotRefreshError,
  readProviderAccountSnapshot,
  resolveProviderAccountSnapshot,
  scheduleProviderAccountSnapshotRefresh,
}));

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaCheckpointHealth,
  getMetaSyncCheckpoint,
  leaseMetaSyncPartitions,
  quarantineMetaTerminalActionRequiredPartitions,
  queueMetaSyncPartition,
  releaseMetaLeasedPartitionsForWorker,
  upsertMetaSyncCheckpoint,
}));

vi.mock("@/lib/sync/google-ads-sync", () => ({
  syncGoogleAdsReports,
  processGoogleAdsLifecyclePartition,
  buildGoogleAdsWorkerLeasePlan,
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  consumeMetaQueuedWork,
  processMetaLifecyclePartition,
  buildMetaWorkerLeasePlan,
}));

vi.mock("@/lib/sync/provider-repair-engine", () => ({
  runMetaRepairCycle,
  runGoogleAdsRepairCycle,
}));

vi.mock("@/lib/sync/repair-executor", () => ({
  runAutoSyncRepairPass,
  mergeAutoRepairResult,
}));

vi.mock("@/lib/sync/shopify-sync", () => ({
  syncShopifyCommerceReports: vi.fn(),
}));

describe("provider-worker-adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mergeAutoRepairResult.mockImplementation((base, results) => ({
      ...(base ?? {}),
      meta: {
        autoExecutions: results,
      },
    }));
    getIntegration.mockResolvedValue({
      status: "connected",
      access_token: "token",
      refresh_token: "refresh-token",
      token_expires_at: "2026-06-01T00:00:00.000Z",
      scopes: "https://www.googleapis.com/auth/adwords",
    });
    upsertIntegration.mockResolvedValue({});
    fetchGoogleAdsAccounts.mockResolvedValue({
      ok: true,
      customers: [
        {
          id: "123-456-7890",
          name: "Google Account",
          currency: "USD",
          timezone: "UTC",
          isManager: false,
        },
      ],
    });
    refreshGoogleAccessToken.mockResolvedValue({
      accessToken: "fresh-token",
      expiresIn: 3600,
    });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_1", name: "Account 1" }],
      meta: {
        fetchedAt: "2026-05-10T00:00:00.000Z",
        stale: false,
        refreshInProgress: false,
        retryAfterAt: null,
        failureClass: null,
      },
    });
    resolveProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_1", name: "Account 1" }],
      meta: { fetchedAt: "2026-05-10T00:00:00.000Z" },
    });
    scheduleProviderAccountSnapshotRefresh.mockResolvedValue(null);
    fetchMetaAdAccounts.mockResolvedValue({
      ok: true,
      body: null,
      normalized: [{ id: "act_1", name: "Account 1" }],
    });
    getMetaApiErrorMessage.mockReturnValue("Meta API error");
    quarantineMetaTerminalActionRequiredPartitions.mockResolvedValue({
      candidateCount: 0,
      terminalMatchedCount: 0,
      changedCount: 0,
      partitions: [],
    });
  });

  it("queues Google core partitions through the shared adapter plan contract", async () => {
    getConnectedAssignedGoogleAccounts.mockResolvedValue(["acct-1"]);
    queueGoogleAdsSyncPartition.mockResolvedValue({ id: "queued-1", status: "queued" });

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const result = await googleAdsWorkerAdapter.planPartitions({
      businessId: "biz-1",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
    });

    expect(queueGoogleAdsSyncPartition).toHaveBeenCalledTimes(4);
    expect(result.partitions).toHaveLength(4);
    expect(result.partitions[0]).toMatchObject({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      scope: "account_daily",
      partitionDate: "2026-03-01",
    });
  });

  it("leases Google partitions through the shared adapter lifecycle contract", async () => {
    leaseGoogleAdsSyncPartitions.mockResolvedValue([
      {
        id: "part-1",
        businessId: "biz-1",
        providerAccountId: "acct-1",
        lane: "core",
        scope: "campaign_daily",
        partitionDate: "2026-03-01",
        status: "leased",
        priority: 200,
        source: "selected_range",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-01T00:05:00.000Z",
        attemptCount: 1,
        nextRetryAt: null,
        lastError: null,
      },
    ]);

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const leased = await googleAdsWorkerAdapter.leasePartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 1,
    });

    expect(leased[0]).toMatchObject({
      partitionId: "part-1",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      scope: "campaign_daily",
    });
  });

  it("applies Google lease-plan steps on the dominant lifecycle path", async () => {
    leaseGoogleAdsSyncPartitions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "part-2",
          businessId: "biz-1",
          providerAccountId: "acct-1",
          lane: "extended",
          scope: "campaign_daily",
          partitionDate: "2026-03-01",
          status: "leased",
          priority: 190,
          source: "historical",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2026-03-01T00:05:00.000Z",
          attemptCount: 1,
          nextRetryAt: null,
          lastError: null,
        },
      ]);

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const leased = await googleAdsWorkerAdapter.leasePartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 1,
      plan: {
        kind: "google_ads_policy_lease_plan",
        requestedLimit: 1,
        steps: [
          { key: "core", lane: "core", limit: 1 },
          {
            key: "historical_fairness",
            lane: "extended",
            limit: 1,
            sourceFilter: "historical_only",
          },
        ],
      },
    });

    expect(leaseGoogleAdsSyncPartitions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        lane: "extended",
        sourceFilter: "historical_only",
      })
    );
    expect(leased).toHaveLength(1);
  });

  it("lets Meta use the lease-plan requestedLimit when productive backlog should keep draining", async () => {
    leaseMetaSyncPartitions
      .mockResolvedValueOnce([
        {
          id: "meta-part-1",
          businessId: "biz-1",
          providerAccountId: "act-1",
          lane: "maintenance",
          scope: "account_daily",
          partitionDate: "2026-03-01",
          status: "leased",
          priority: 200,
          source: "finalize_day",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2026-03-01T00:05:00.000Z",
          attemptCount: 1,
          nextRetryAt: null,
          lastError: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "meta-part-2",
          businessId: "biz-1",
          providerAccountId: "act-1",
          lane: "core",
          scope: "account_daily",
          partitionDate: "2026-03-02",
          status: "leased",
          priority: 180,
          source: "recent",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2026-03-01T00:05:00.000Z",
          attemptCount: 1,
          nextRetryAt: null,
          lastError: null,
        },
      ]);

    const { metaWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const leased = await metaWorkerAdapter.leasePartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 1,
      plan: {
        kind: "meta_policy_lease_plan",
        requestedLimit: 2,
        steps: [
          { key: "maintenance", lane: "maintenance", limit: 1 },
          { key: "core_priority", lane: "core", limit: 1, sources: ["recent"] },
        ],
      },
    });

    expect(leaseMetaSyncPartitions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        lane: "maintenance",
        limit: 1,
      }),
    );
    expect(leaseMetaSyncPartitions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        lane: "core",
        sources: ["recent"],
        limit: 1,
      }),
    );
    expect(leased).toHaveLength(2);
  });

  it("runs Meta auto-heal through the shared repair engine", async () => {
    runMetaRepairCycle.mockResolvedValue({
      repair: {
        reclaimed: 1,
        replayed: 2,
        requeued: 3,
        blocked: false,
        blockingReasons: [],
        repairableActions: [],
      },
    });

    runAutoSyncRepairPass.mockResolvedValue({
      execution: { id: "exec-1", status: "succeeded" },
      recommendation: { businessId: "biz-1", recommendedAction: "replay_dead_letter" },
      skippedReason: null,
      budgetState: null,
      releaseGate: null,
      repairPlan: null,
    });
    consumeMetaQueuedWork.mockResolvedValue({
      businessId: "biz-1",
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });

    const { metaWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const repair = await metaWorkerAdapter.runAutoHeal?.("biz-1");

    expect(runMetaRepairCycle).toHaveBeenCalledWith("biz-1", {
      enqueueScheduledWork: false,
      metaDeadLetterSources: [
        "finalize_day",
        "priority_window",
        "repair_recent_day",
        "today_observe",
        "request_runtime",
        "manual_refresh",
        "recent",
        "recent_recovery",
        "historical",
        "historical_recovery",
        "initial_connect",
      ],
      metaDeadLetterRecoveryKinds: ["replayable_transient"],
    });
    expect(consumeMetaQueuedWork).toHaveBeenCalledWith("biz-1", {
      runtimeWorkerId: "meta-autoheal:biz-1",
    });
    expect(runAutoSyncRepairPass).toHaveBeenCalledWith({
      providerScope: "meta",
      source: "worker",
      businessId: "biz-1",
      consumeQueuedMetaWork: true,
    });
    expect(repair).toEqual(
      expect.objectContaining({
        reclaimed: 1,
        replayed: 2,
        requeued: 3,
        meta: expect.objectContaining({
          consumeAfterRepair: expect.objectContaining({
            attempted: 1,
            succeeded: 1,
          }),
          providerAccountSnapshotRepair: expect.objectContaining({
            outcome: "fresh",
            accountCount: 1,
          }),
        }),
      })
    );
  });

  it("refreshes a missing Meta account-list snapshot during worker auto-heal", async () => {
    readProviderAccountSnapshot.mockResolvedValueOnce(null);
    runMetaRepairCycle.mockResolvedValue({
      repair: {
        reclaimed: 0,
        replayed: 0,
        requeued: 0,
        blocked: false,
        blockingReasons: [],
        repairableActions: [],
      },
    });
    runAutoSyncRepairPass.mockResolvedValue({
      execution: null,
      recommendation: null,
      skippedReason: "no_recommendation",
      budgetState: null,
      releaseGate: null,
      repairPlan: null,
    });

    const { metaWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const repair = await metaWorkerAdapter.runAutoHeal?.("biz-1");

    expect(resolveProviderAccountSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        provider: "meta",
        reason: "worker_missing_account_snapshot",
      }),
    );
    expect(repair?.meta).toEqual(
      expect.objectContaining({
        providerAccountSnapshotRepair: expect.objectContaining({
          outcome: "refreshed_missing_snapshot",
          accountCount: 1,
        }),
      }),
    );
  });

  it("runs Google auto-heal through the shared repair executor", async () => {
    runGoogleAdsRepairCycle.mockResolvedValue({
      repair: {
        reclaimed: 0,
        replayed: 1,
        requeued: 2,
        blocked: false,
        blockingReasons: [],
        repairableActions: [],
      },
    });
    runAutoSyncRepairPass.mockResolvedValue({
      execution: { id: "exec-2", status: "succeeded" },
      recommendation: { businessId: "biz-1", recommendedAction: "refresh_state" },
      skippedReason: null,
      budgetState: null,
      releaseGate: null,
      repairPlan: null,
    });
    syncGoogleAdsReports.mockResolvedValue({
      businessId: "biz-1",
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const repair = await googleAdsWorkerAdapter.runAutoHeal?.("biz-1");

    expect(runGoogleAdsRepairCycle).toHaveBeenCalledWith("biz-1", {
      enqueueScheduledWork: false,
      googleDeadLetterRecoveryKinds: ["replayable_transient"],
    });
    expect(syncGoogleAdsReports).toHaveBeenCalledWith("biz-1", {
      runtimeWorkerId: "google-ads-autoheal:biz-1",
    });
    expect(runAutoSyncRepairPass).toHaveBeenCalledWith({
      providerScope: "google_ads",
      source: "worker",
      businessId: "biz-1",
    });
    expect(repair).toEqual(
      expect.objectContaining({
        replayed: 1,
        requeued: 2,
        meta: expect.objectContaining({
          consumeAfterRepair: expect.objectContaining({
            attempted: 1,
            succeeded: 1,
          }),
          providerAccountSnapshotRepair: expect.objectContaining({
            outcome: "fresh",
            accountCount: 1,
          }),
        }),
      }),
    );
  });

  it("does not consume Google queued work when auto-heal found nothing to repair", async () => {
    runGoogleAdsRepairCycle.mockResolvedValue({
      repair: {
        reclaimed: 0,
        replayed: 0,
        requeued: 0,
        blocked: false,
        blockingReasons: [],
        repairableActions: [],
        meta: {
          queuedWarehouseRepairs: 0,
          queuedRecentGapRepairs: 0,
        },
      },
    });
    runAutoSyncRepairPass.mockResolvedValue({
      execution: null,
      recommendation: null,
      skippedReason: "no_recommendation",
      budgetState: null,
      releaseGate: null,
      repairPlan: null,
    });

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const repair = await googleAdsWorkerAdapter.runAutoHeal?.("biz-1");

    expect(syncGoogleAdsReports).not.toHaveBeenCalled();
    expect(repair?.meta).toEqual(
      expect.objectContaining({
        consumeAfterRepair: null,
      }),
    );
  });

  it("refreshes a missing Google account-list snapshot during worker auto-heal", async () => {
    readProviderAccountSnapshot.mockResolvedValueOnce(null);
    resolveProviderAccountSnapshot.mockResolvedValueOnce({
      accounts: [{ id: "123-456-7890", name: "Google Account" }],
      meta: { fetchedAt: "2026-05-10T00:00:00.000Z" },
    });
    runGoogleAdsRepairCycle.mockResolvedValue({
      repair: {
        reclaimed: 0,
        replayed: 0,
        requeued: 0,
        blocked: false,
        blockingReasons: [],
        repairableActions: [],
      },
    });
    runAutoSyncRepairPass.mockResolvedValue({
      execution: null,
      recommendation: null,
      skippedReason: "no_recommendation",
      budgetState: null,
      releaseGate: null,
      repairPlan: null,
    });

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const repair = await googleAdsWorkerAdapter.runAutoHeal?.("biz-1");

    expect(resolveProviderAccountSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        provider: "google",
        reason: "worker_missing_account_snapshot",
      }),
    );
    expect(repair?.meta).toEqual(
      expect.objectContaining({
        providerAccountSnapshotRepair: expect.objectContaining({
          outcome: "refreshed_missing_snapshot",
          accountCount: 1,
        }),
      }),
    );
  });

  it("forwards the durable runtime worker id through Meta fallback consumption", async () => {
    consumeMetaQueuedWork.mockResolvedValue({ outcome: "consume_succeeded" });

    const { metaWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    await metaWorkerAdapter.consumeBusiness("biz-1", {
      runtimeWorkerId: "worker-1",
    });

    expect(consumeMetaQueuedWork).toHaveBeenCalledWith("biz-1", {
      runtimeWorkerId: "worker-1",
    });
  });

  it("forwards the durable runtime worker id through Google fallback consumption", async () => {
    syncGoogleAdsReports.mockResolvedValue({ outcome: "consume_succeeded" });

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    await googleAdsWorkerAdapter.consumeBusiness("biz-1", {
      runtimeWorkerId: "worker-1",
    });

    expect(syncGoogleAdsReports).toHaveBeenCalledWith("biz-1", {
      runtimeWorkerId: "worker-1",
    });
  });

  it("releases leftover Meta leased partitions for the current runtime worker", async () => {
    releaseMetaLeasedPartitionsForWorker.mockResolvedValue(2);

    const { metaWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const released = await metaWorkerAdapter.cleanupOwnedLeasedPartitions?.({
      businessId: "biz-1",
      workerId: "worker-1",
      failureReason: "runner_lease_conflict",
    });

    expect(released).toBe(2);
    expect(releaseMetaLeasedPartitionsForWorker).toHaveBeenCalledWith({
      businessId: "biz-1",
      workerId: "worker-1",
      lastError:
        "leased partition released automatically after runner_lease_conflict",
    });
  });

  it("releases leftover Google leased partitions for the current runtime worker", async () => {
    releaseGoogleAdsLeasedPartitionsForWorker.mockResolvedValue(3);

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const released = await googleAdsWorkerAdapter.cleanupOwnedLeasedPartitions?.({
      businessId: "biz-1",
      workerId: "worker-1",
      failureReason: "runner_lease_conflict",
    });

    expect(released).toBe(3);
    expect(releaseGoogleAdsLeasedPartitionsForWorker).toHaveBeenCalledWith({
      businessId: "biz-1",
      workerId: "worker-1",
      lastError:
        "leased partition released automatically after runner_lease_conflict",
    });
  });

  it("routes Meta writeFacts through the legacy partition processor", async () => {
    processMetaLifecyclePartition.mockResolvedValue(true);

    const { metaWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    await metaWorkerAdapter.writeFacts({
      partition: {
        partitionId: "part-1",
        businessId: "biz-1",
        providerAccountId: "act_1",
        scope: "account_daily",
        partitionDate: "2026-04-01",
        lane: "core",
        leaseOwner: "worker-1",
        attemptCount: 0,
        source: "historical",
      } as never,
      chunk: {},
    });

    expect(processMetaLifecyclePartition).toHaveBeenCalledWith({
      partition: expect.objectContaining({
        id: "part-1",
        businessId: "biz-1",
        scope: "account_daily",
      }),
      workerId: "worker-1",
    });
  });

  it("routes Google writeFacts through the legacy partition processor", async () => {
    processGoogleAdsLifecyclePartition.mockResolvedValue(true);

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    await googleAdsWorkerAdapter.writeFacts({
      partition: {
        partitionId: "part-1",
        businessId: "biz-1",
        providerAccountId: "acct-1",
        scope: "campaign_daily",
        partitionDate: "2026-04-01",
        lane: "core",
        leaseEpoch: 9,
        leaseOwner: "worker-1",
        attemptCount: 1,
        source: "selected_range",
      } as never,
      chunk: {},
    });

    expect(processGoogleAdsLifecyclePartition).toHaveBeenCalledWith({
      partition: expect.objectContaining({
        id: "part-1",
        businessId: "biz-1",
        scope: "campaign_daily",
        leaseEpoch: 9,
      }),
      workerId: "worker-1",
    });
  });

  it("advances Google checkpoints through the shared adapter contract", async () => {
    getGoogleAdsSyncCheckpoint.mockResolvedValue(null);
    upsertGoogleAdsSyncCheckpoint.mockResolvedValue("checkpoint-1");

    const { googleAdsWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    await googleAdsWorkerAdapter.advanceCheckpoint({
      partition: {
        partitionId: "part-1",
        businessId: "biz-1",
        providerAccountId: "acct-1",
        scope: "campaign_daily",
        partitionDate: "2026-03-01",
        leaseEpoch: 7,
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-01T00:05:00.000Z",
      } as never,
      chunk: {
        pageIndex: 2,
        nextCursor: "token-2",
        rowsFetched: 25,
        rowsWritten: 25,
        status: "running",
      },
    });

    expect(upsertGoogleAdsSyncCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        partitionId: "part-1",
        businessId: "biz-1",
        providerAccountId: "acct-1",
        checkpointScope: "campaign_daily",
        pageIndex: 2,
        nextPageToken: "token-2",
        rowsFetched: 25,
        rowsWritten: 25,
        leaseEpoch: 7,
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-01T00:05:00.000Z",
      })
    );
  });

  it("derives Meta readiness from shared checkpoint health", async () => {
    resolveMetaCredentials.mockResolvedValue({
      businessId: "biz-1",
      accountIds: ["act_1"],
      accessToken: "token",
      currency: "USD",
      accountProfiles: {},
    });
    getMetaCheckpointHealth.mockResolvedValue({
      latestCheckpointScope: "account_daily",
      latestCheckpointPhase: "fetch_raw",
      latestCheckpointStatus: "running",
      latestCheckpointUpdatedAt: "2026-04-02T10:00:00.000Z",
      checkpointLagMinutes: 5,
      lastSuccessfulPageIndex: 2,
      resumeCapable: true,
      checkpointFailures: 0,
    });

    const { metaWorkerAdapter } = await import("@/lib/sync/provider-worker-adapters");
    const readiness = await metaWorkerAdapter.getReadiness?.({
      businessId: "biz-1",
      providerAccountId: "act_1",
    });

    expect(readiness).toMatchObject({
      readinessLevel: "ready",
      checkpointHealth: expect.objectContaining({
        latestCheckpointScope: "account_daily",
      }),
    });
  });
});
