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

  it.each([false, true])("keeps truthful process liveness across many short cycles (provider write fails: %s)", async (providerWriteFails) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T18:00:00Z"));
    vi.stubEnv("WORKER_CYCLE_KEEPALIVE_INTERVAL_MS", "150000");
    vi.stubEnv("WORKER_HEARTBEAT_INTERVAL_MS", "15000");
    vi.stubEnv("WORKER_MAX_BUSINESSES_PER_TICK", "8");
    readActiveBusinesses.mockResolvedValue({
      ok: true,
      businesses: Array.from({ length: 8 }, (_, i) => ({ id: `biz-${i}`, name: `Biz ${i}` })),
    });
    const writes: Array<{ scope: string; status: string; at: number }> = [];
    heartbeatSyncWorker.mockImplementation(async (input) => {
      if (providerWriteFails && input.providerScope === "meta") throw new Error("heartbeat write failed");
      writes.push({ scope: input.providerScope, status: input.status, at: Date.now() });
    });
    let completed = 0;
    const adapter = {
      providerScope: "meta", planPartitions: async () => ({ partitions: [] }),
      leasePartitions: async () => [], getCheckpoint: async () => null,
      fetchChunk: async () => ({}), persistChunk: async () => {}, transformChunk: async () => {},
      writeFacts: async () => {}, advanceCheckpoint: async () => {}, completePartition: async () => {},
      classifyFailure: () => "test",
      getReadiness: async () => ({ readinessLevel: "usable", checkpointHealth: null, domainReadiness: null }),
      consumeBusiness: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        completed++;
        return { outcome: "consume_succeeded" };
      },
    };
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter] as never });
    try {
      const elapsed = providerWriteFails ? 180_001 : 360_001;
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(completed).toBeGreaterThanOrEqual(providerWriteFails ? 3 : 6);
      // Each cycle finishes before its 150s keepalive fires. Provider work is
      // progressing, so the process row must not age out after five minutes.
      const latestProcessWrite = writes.filter((x) => x.scope === "all" && ["idle", "running"].includes(x.status)).at(-1);
      expect(latestProcessWrite).toBeDefined();
      if (providerWriteFails) {
        // Failed provider writes cannot mint fresh process evidence.
        expect(Date.now() - latestProcessWrite!.at).toBe(elapsed);
      } else {
        expect(Date.now() - latestProcessWrite!.at).toBeLessThan(300_000);
      }
    } finally {
      process.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(60_000);
      await runtime;
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])("coalesces concurrent mirrors without changing consumption when the process write fails: %s", async (mirrorWriteFails) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T18:00:00Z"));
    vi.stubEnv("WORKER_HEARTBEAT_INTERVAL_MS", "15000");
    vi.stubEnv("WORKER_CYCLE_KEEPALIVE_INTERVAL_MS", "150000");
    vi.stubEnv("WORKER_GLOBAL_DB_CONCURRENCY", "4");
    vi.stubEnv("META_WORKER_CONCURRENCY", "4");
    vi.stubEnv("WORKER_MAX_BUSINESSES_PER_TICK", "8");
    readActiveBusinesses.mockResolvedValue({
      ok: true,
      businesses: Array.from({ length: 8 }, (_, i) => ({ id: `biz-${i}`, name: `Biz ${i}` })),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const mirrors: Array<{ at: number; meta: Record<string, unknown> }> = [];
    heartbeatSyncWorker.mockImplementation(async (input) => {
      if (!input.metaJson?.processHeartbeatFromProvider) return;
      mirrors.push({ at: Date.now(), meta: input.metaJson });
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 250));
      inFlight--;
      if (mirrorWriteFails) throw new Error("process heartbeat write failed");
    });
    const consumed: string[] = [];
    let releases = 0;
    releaseSyncRunnerLease.mockImplementation(async () => {
      if (++releases === 8) process.emit("SIGTERM");
    });
    const adapter = {
      providerScope: "meta", planPartitions: async () => ({ partitions: [] }),
      leasePartitions: async () => [], getCheckpoint: async () => null,
      fetchChunk: async () => ({}), persistChunk: async () => {}, transformChunk: async () => {},
      writeFacts: async () => {}, advanceCheckpoint: async () => {}, completePartition: async () => {},
      classifyFailure: () => "test",
      getReadiness: async () => ({ readinessLevel: "usable", checkpointHealth: null, domainReadiness: null }),
      consumeBusiness: async (businessId: string) => {
        await new Promise((resolve) => setTimeout(resolve, Number(businessId.slice(4)) < 4 ? 60_000 : 1_000));
        consumed.push(businessId);
        return { outcome: "consume_succeeded" };
      },
    };
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter] as never });
    try {
      await vi.advanceTimersByTimeAsync(65_000);
      await runtime;
      expect(new Set(consumed).size).toBe(8);
      expect(releases).toBe(8);
      expect(maxInFlight).toBe(1);
      const outcomes = heartbeatSyncWorker.mock.calls.filter(([x]) => x.providerScope === "meta" && x.metaJson?.consumeOutcome === "consume_succeeded");
      expect(outcomes).toHaveLength(8);
      expect(mirrors.length).toBeGreaterThan(0);
      for (const { meta } of mirrors) {
        expect(meta).not.toHaveProperty("consumeOutcome");
        expect(meta).not.toHaveProperty("consumeStage");
        expect(meta).not.toHaveProperty("providerScope");
        expect(meta.activeProviderScope).toBe("meta");
      }
      if (mirrorWriteFails) {
        // A failed process write must not advance its own throttle clock.
        expect(mirrors.length).toBeGreaterThan(1);
        expect(mirrors[1].at - mirrors[0].at).toBeLessThan(15_000);
      } else {
        expect(mirrors).toHaveLength(1);
      }
    } finally {
      process.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(65_000);
      await runtime;
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("exits a stuck cycle while another concurrent cycle keeps producing process evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T18:00:00Z"));
    vi.stubEnv("WORKER_HEARTBEAT_INTERVAL_MS", "15");
    vi.stubEnv("WORKER_CYCLE_KEEPALIVE_INTERVAL_MS", "15");
    vi.stubEnv("WORKER_CYCLE_MAX_MS", "200");
    vi.stubEnv("WORKER_STALL_EXIT_MS", "50");
    vi.stubEnv("WORKER_GLOBAL_DB_CONCURRENCY", "2");
    vi.stubEnv("META_WORKER_CONCURRENCY", "2");
    vi.stubEnv("WORKER_MAX_BUSINESSES_PER_TICK", "2");
    readActiveBusinesses.mockResolvedValue({ ok: true, businesses: [{ id: "stuck", name: "Stuck" }, { id: "progress", name: "Progress" }] });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = {
      providerScope: "meta", planPartitions: async () => ({ partitions: [] }),
      leasePartitions: async () => [], getCheckpoint: async () => null,
      fetchChunk: async () => ({}), persistChunk: async () => {}, transformChunk: async () => {},
      writeFacts: async () => {}, advanceCheckpoint: async () => {}, completePartition: async () => {},
      classifyFailure: () => "test",
      getReadiness: async () => ({ readinessLevel: "usable", checkpointHealth: null, domainReadiness: null }),
      consumeBusiness: async (businessId: string) => {
        if (businessId === "stuck") await held;
        else await new Promise((resolve) => setTimeout(resolve, 180));
        return { outcome: "consume_succeeded" };
      },
    };
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter] as never });
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(heartbeatSyncWorker.mock.calls.some(([x]) => x.providerScope === "all" && x.lastBusinessId === "progress" && (x.metaJson?.cycleKeepalive || x.metaJson?.processHeartbeatFromProvider))).toBe(true);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.emit("SIGTERM"); finish();
      await vi.advanceTimersByTimeAsync(1);
      await runtime;
      exit.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs();
    }
  });

  it("keeps process liveness during one long provider cycle without inventing other-provider progress", async () => {
    process.env.WORKER_CYCLE_KEEPALIVE_INTERVAL_MS = "10";
    let finishCycle!: () => void;
    let entered = false;
    const held = new Promise<void>((resolve) => { finishCycle = resolve; });
    const adapter = (providerScope: string) => ({
      providerScope,
      planPartitions: async () => ({ partitions: [] }),
      leasePartitions: async () => [],
      getCheckpoint: async () => null,
      fetchChunk: async () => ({}),
      persistChunk: async () => {}, transformChunk: async () => {},
      writeFacts: async () => {}, advanceCheckpoint: async () => {},
      completePartition: async () => {}, classifyFailure: () => "test",
      getReadiness: async () => ({ readinessLevel: "usable", checkpointHealth: null, domainReadiness: null }),
      consumeBusiness: async () => { entered = true; await held; return { outcome: "consume_succeeded" }; },
    });
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter("meta"), adapter("google_ads")] as never });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const before = heartbeatSyncWorker.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 45));
      const during = heartbeatSyncWorker.mock.calls.slice(before).map(([x]) => x);
      expect(during.some((x) => x.providerScope === "all" && x.metaJson?.activeProviderScope === "meta")).toBe(true);
      expect(during.some((x) => x.providerScope === "meta")).toBe(true);
      expect(during.some((x) => x.providerScope === "google_ads")).toBe(false);
    } finally {
      process.emit("SIGTERM");
      finishCycle();
      await runtime;
      delete process.env.WORKER_CYCLE_KEEPALIVE_INTERVAL_MS;
    }
    // A completed cycle must not resurrect the process or start the next
    // provider after SIGTERM. This occurred in the retained production rows.
    const calls = heartbeatSyncWorker.mock.calls.map(([x]) => x);
    const firstStop = calls.findIndex((x) => x.status === "stopping");
    expect(firstStop).toBeGreaterThan(-1);
    expect(calls.slice(firstStop).every((x) => ["stopping", "stopped"].includes(x.status))).toBe(true);
  });

  it("exits a stuck cycle despite successful keepalives instead of reporting healthy forever", async () => {
    vi.stubEnv("WORKER_CYCLE_KEEPALIVE_INTERVAL_MS", "15");
    vi.stubEnv("WORKER_CYCLE_MAX_MS", "200");
    vi.stubEnv("WORKER_STALL_EXIT_MS", "50");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let finish!: () => void;
    let entered = false;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = {
      providerScope: "meta", planPartitions: async () => ({ partitions: [] }),
      leasePartitions: async () => [], getCheckpoint: async () => null,
      fetchChunk: async () => ({}), persistChunk: async () => {}, transformChunk: async () => {},
      writeFacts: async () => {}, advanceCheckpoint: async () => {}, completePartition: async () => {},
      classifyFailure: () => "test",
      getReadiness: async () => ({ readinessLevel: "usable", checkpointHealth: null, domainReadiness: null }),
      consumeBusiness: async () => { entered = true; await held; return {}; },
    };
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter] as never });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(heartbeatSyncWorker.mock.calls.some(([x]) => x.providerScope === "all" && x.metaJson?.cycleKeepalive)).toBe(true);
      const count = heartbeatSyncWorker.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(heartbeatSyncWorker.mock.calls.length).toBe(count);
    } finally {
      process.emit("SIGTERM"); finish(); await runtime;
      exit.mockRestore(); vi.unstubAllEnvs();
    }
  });

  it("does not renew process liveness while repeated work discovery fails", async () => {
    readActiveBusinesses.mockResolvedValue({ ok: false, reason: "read_failed", message: "test unavailable" });
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [] });
    try {
      await vi.waitFor(() => expect(readActiveBusinesses.mock.calls.length).toBeGreaterThan(2));
      expect(heartbeatSyncWorker.mock.calls.some(([x]) => x.providerScope === "all" && x.status === "idle")).toBe(false);
    } finally {
      process.emit("SIGTERM");
      await runtime;
    }
  });

});
