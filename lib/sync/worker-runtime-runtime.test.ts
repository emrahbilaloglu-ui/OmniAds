import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveBusinesses = vi.fn();
const readActiveBusinesses = vi.fn();
const acquireSyncRunnerLease = vi.fn();
const heartbeatSyncWorker = vi.fn();
const renewSyncRunnerLease = vi.fn();
const releaseSyncRunnerLease = vi.fn();
const pruneSyncLifecycleData = vi.fn();
const executeGoogleAdsRetentionPolicy = vi.fn();
const executeMetaRetentionPolicy = vi.fn();
const getLatestSyncGateRecords = vi.fn();

// The business cycle is now admitted BEFORE the runner lease, so these tests
// have to state which admission they run under. Default-admit; refusal is
// proven in lib/sync/worker-tick-admission.test.ts.
const growthFenceMocks = vi.hoisted(() => ({
  assertSyncGrowthBoundary: vi.fn(async () => ({ allowed: true, reason: "ready" })),
}));
vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertSyncGrowthBoundary: growthFenceMocks.assertSyncGrowthBoundary,
  };
});

vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses,
  readActiveBusinesses,
}));

vi.mock("@/lib/sync/worker-health", () => ({
  acquireSyncRunnerLease,
  heartbeatSyncWorker,
  renewSyncRunnerLease,
  releaseSyncRunnerLease,
}));

vi.mock("@/lib/sync/retention", () => ({
  pruneSyncLifecycleData,
}));

vi.mock("@/lib/google-ads/warehouse-retention", () => ({
  executeGoogleAdsRetentionPolicy,
}));

vi.mock("@/lib/meta/warehouse-retention", () => ({
  executeMetaRetentionPolicy,
}));

vi.mock("@/lib/sync/release-gates", () => ({
  getLatestSyncGateRecords,
}));

describe("worker runtime heartbeat repair metadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // The business cycle is admitted before the runner lease.
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED = "enabled";
    growthFenceMocks.assertSyncGrowthBoundary.mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    readActiveBusinesses.mockResolvedValue({
      ok: true,
      businesses: [{ id: "biz-1", name: "Biz 1" }],
    });
    acquireSyncRunnerLease.mockResolvedValue(true);
    renewSyncRunnerLease.mockResolvedValue(true);
    releaseSyncRunnerLease.mockResolvedValue(undefined);
    pruneSyncLifecycleData.mockResolvedValue({ pruned: 0 });
    executeGoogleAdsRetentionPolicy.mockResolvedValue({
      mode: "dry_run",
      skippedDueToActiveLease: false,
    });
    executeMetaRetentionPolicy.mockResolvedValue({
      mode: "dry_run",
      skippedDueToActiveLease: false,
    });
    process.env.WORKER_POLL_INTERVAL_MS = "1";
    process.env.WORKER_MAX_BUSINESSES_PER_TICK = "1";
    process.env.WORKER_PARTITION_TICK_LIMIT = "1";
    process.env.WORKER_GLOBAL_DB_CONCURRENCY = "1";
    process.env.META_WORKER_CONCURRENCY = "1";
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "";
    getLatestSyncGateRecords.mockResolvedValue({
      deployGate: null,
      releaseGate: null,
    });
  });

  it("includes auto-heal cleanup details in provider heartbeats and defers maintenance at startup", async () => {
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const cleanupOwnedLeasedPartitions = vi.fn().mockResolvedValue(1);

    const runtime = runDurableWorkerRuntime({
      adapters: [
        {
          providerScope: "meta",
          planPartitions: async () => ({ partitions: [] }),
          leasePartitions: async () => [],
          getCheckpoint: async () => null,
          fetchChunk: async () => ({}),
          persistChunk: async () => {},
          transformChunk: async () => {},
          writeFacts: async () => {},
          advanceCheckpoint: async () => {},
          completePartition: async () => {},
          classifyFailure: () => "x",
          buildLeasePlan: async () => null,
          cleanupOwnedLeasedPartitions,
          getReadiness: async () => ({
            readinessLevel: "usable",
            checkpointHealth: null,
            domainReadiness: null,
          }),
          runAutoHeal: async () => ({
            reclaimed: 1,
            replayed: 0,
            requeued: 0,
            blocked: false,
            blockingReasons: [],
            repairableActions: [],
            meta: {
              cleanupSummary: {
                candidateCount: 1,
                stalePartitionCount: 1,
                aliveSlowCount: 0,
                reconciledRunCount: 1,
                staleRunCount: 0,
                staleLegacyCount: 0,
                reclaimReasons: {
                  stalledReclaimable: ["lease_expired_no_progress"],
                },
                preservedByReason: {
                  recentCheckpointProgress: 0,
                  matchingRunnerLeasePresent: 0,
                  leaseNotExpired: 0,
                },
              },
              cleanupError: null,
            },
          }),
          consumeBusiness: async () => {
            process.emit("SIGTERM");
            return { outcome: "consume_succeeded" };
          },
        },
      ],
    });

    await runtime;

    expect(cleanupOwnedLeasedPartitions).toHaveBeenCalledWith({
      businessId: "biz-1",
      workerId: expect.stringMatching(/^sync-worker:/),
      failureReason: null,
    });
    expect(cleanupOwnedLeasedPartitions.mock.invocationCallOrder[0]).toBeLessThan(
      releaseSyncRunnerLease.mock.invocationCallOrder[0]
    );

    expect(
      heartbeatSyncWorker.mock.calls.some(([input]) => {
        const heartbeat = input as {
          workerId?: string;
          status?: string;
          metaJson?: Record<string, unknown>;
        };
        return (
          typeof heartbeat.workerId === "string" &&
          heartbeat.workerId.startsWith("sync-worker:") &&
          heartbeat.status === "starting" &&
          heartbeat.metaJson?.workerBuildId != null
        );
      })
    ).toBe(true);
    expect(
      heartbeatSyncWorker.mock.calls.some(([input]) => {
        const heartbeat = input as {
          workerId?: string;
          status?: string;
          metaJson?: Record<string, unknown>;
        };
        return (
          typeof heartbeat.workerId === "string" &&
          heartbeat.workerId.endsWith(":meta") &&
          heartbeat.status === "starting" &&
          heartbeat.metaJson?.providerScope === "meta"
        );
      })
    ).toBe(true);

    expect(
      heartbeatSyncWorker.mock.calls.some(([input]) => {
        const meta = (input as { metaJson?: Record<string, unknown> }).metaJson;
        return (
          typeof (input as { workerId?: string }).workerId === "string" &&
          (input as { workerId: string }).workerId.endsWith(":meta") &&
          Boolean(
            (meta?.repairMeta as { cleanupSummary?: { candidateCount?: number } } | undefined)
              ?.cleanupSummary?.candidateCount === 1
          )
        );
      })
    ).toBe(true);
    expect(pruneSyncLifecycleData).not.toHaveBeenCalled();
    expect(executeGoogleAdsRetentionPolicy).not.toHaveBeenCalled();
    expect(executeMetaRetentionPolicy).not.toHaveBeenCalled();
  });

  it("limits blocked provider ticks to prioritized canaries", async () => {
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "biz-priority";
    readActiveBusinesses.mockResolvedValue({
      ok: true,
      businesses: [
        { id: "biz-priority", name: "Priority" },
        { id: "biz-other", name: "Other" },
      ],
    });
    getLatestSyncGateRecords.mockResolvedValue({
      deployGate: null,
      releaseGate: {
        id: "gate-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "build-1",
        environment: "test",
        mode: "block",
        baseResult: "fail",
        verdict: "blocked",
        blockerClass: "not_release_ready",
        summary: "blocked",
        breakGlass: false,
        overrideReason: null,
        evidence: { providerScope: "meta" },
        emittedAt: "2026-04-20T00:00:00.000Z",
      },
    });

    const consumedBusinesses: string[] = [];
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");

    const runtime = runDurableWorkerRuntime({
      adapters: [
        {
          providerScope: "meta",
          planPartitions: async () => ({ partitions: [] }),
          leasePartitions: async () => [],
          getCheckpoint: async () => null,
          fetchChunk: async () => ({}),
          persistChunk: async () => {},
          transformChunk: async () => {},
          writeFacts: async () => {},
          advanceCheckpoint: async () => {},
          completePartition: async () => {},
          classifyFailure: () => "x",
          buildLeasePlan: async () => null,
          getReadiness: async () => ({
            readinessLevel: "usable",
            checkpointHealth: null,
            domainReadiness: null,
          }),
          runAutoHeal: async () => null,
          consumeBusiness: async (businessId: string) => {
            consumedBusinesses.push(businessId);
            process.emit("SIGTERM");
            return { outcome: "consume_succeeded" };
          },
        },
      ],
    });

    await runtime;

    expect(consumedBusinesses).toEqual(["biz-priority"]);
  });
});
