import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateWorkerHealth } from "@/lib/sync/staged-worker-predicate";
import type { WorkerHealthRow } from "@/lib/sync/staged-worker-predicate";
import { DbGrowthFenceRefusal, type DbGrowthFenceDecision } from "@/lib/sync/db-growth-fence";

const mocks = vi.hoisted(() => ({
  fence: vi.fn(), heartbeat: vi.fn(), discover: vi.fn(), acquire: vi.fn(),
  renew: vi.fn(), release: vi.fn(), prune: vi.fn(), googleRetention: vi.fn(), metaRetention: vi.fn(),
}));
vi.mock("@/lib/sync/db-growth-fence", async (original) => ({
  ...await original<object>(), assertSyncGrowthBoundary: mocks.fence,
}));
vi.mock("@/lib/sync/worker-health", () => ({
  heartbeatSyncWorker: mocks.heartbeat, acquireSyncRunnerLease: mocks.acquire,
  renewSyncRunnerLease: mocks.renew, releaseSyncRunnerLease: mocks.release,
}));
vi.mock("@/lib/sync/active-businesses", () => ({ readActiveBusinesses: mocks.discover, getActiveBusinesses: vi.fn() }));
vi.mock("@/lib/sync/retention", () => ({ pruneSyncLifecycleData: mocks.prune }));
vi.mock("@/lib/google-ads/warehouse-retention", () => ({ executeGoogleAdsRetentionPolicy: mocks.googleRetention }));
vi.mock("@/lib/meta/warehouse-retention", () => ({ executeMetaRetentionPolicy: mocks.metaRetention }));

function aggregateRefusal(reason = "database_budget_exceeded") {
  return new DbGrowthFenceRefusal({
    allowed: false, reason, databaseBytes: 101, databaseBudgetBytes: 100,
    offender: { table: "database", bytes: 101, budget: 100 }, overridden: false,
    physical: { admitted: true },
  } as DbGrowthFenceDecision, "durable_worker_boot");
}
function adapter(providerScope: string) {
  return { providerScope, consumeBusiness: vi.fn(), runAutoHeal: vi.fn(), planPartitions: vi.fn(),
    leasePartitions: vi.fn(), fetchChunk: vi.fn(), persistChunk: vi.fn(), writeFacts: vi.fn() };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  for (const key of ["ADSECUTE_SYNC_GLOBAL_ENABLED", "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED", "ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED"]) vi.stubEnv(key, "enabled");
  vi.stubEnv("APP_BUILD_ID", "capacity-idle-unit");
  vi.stubEnv("ADSECUTE_IMAGE_BUILD_ID", "capacity-idle-unit");
  vi.stubEnv("SYNC_WORKER_STAGING_IDLE", "0"); vi.stubEnv("WORKER_POLL_INTERVAL_MS", "1000");
  vi.stubEnv("WORKER_HEARTBEAT_INTERVAL_MS", "15000");
  mocks.fence.mockRejectedValue(aggregateRefusal()); mocks.heartbeat.mockResolvedValue(undefined);
  mocks.discover.mockResolvedValue({ ok: true, businesses: [] });
});
afterEach(() => {
  process.removeAllListeners("SIGTERM"); process.removeAllListeners("SIGINT");
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
});

describe("aggregate capacity refusal at actual worker boot", () => {
  it("stays alive with explicit refusal clocks, without discovery, maintenance, leases or provider calls", async () => {
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const meta = adapter("meta"), google = adapter("google_ads");
    let failure: unknown = null;
    const runtime = runDurableWorkerRuntime({ adapters: [meta, google] as never }).catch((e) => { failure = e; });
    try {
      await vi.advanceTimersByTimeAsync(31000);
      expect(failure).toBeNull();
      const rows = mocks.heartbeat.mock.calls.map(([r]) => r);
      for (const scope of ["all", "meta", "google_ads"]) {
        const writes = rows.filter((r) => r.providerScope === scope);
        expect(writes.length).toBeGreaterThanOrEqual(2);
        expect(writes.every((r) => r.status === "idle" && r.metaJson.capacityRefusedIdle === true &&
          r.metaJson.businessAdmitted === false && r.metaJson.consumeOutcome === "admission_refused" &&
          r.metaJson.consumeReason === "capacity_refused" && r.metaJson.safetyRefusal.kind === "capacity_refused")).toBe(true);
      }
      for (const fn of [mocks.discover, mocks.acquire, mocks.renew, mocks.release, mocks.prune,
        mocks.googleRetention, mocks.metaRetention, meta.consumeBusiness, meta.runAutoHeal, meta.planPartitions,
        google.consumeBusiness, google.runAutoHeal, google.planPartitions]) expect(fn).not.toHaveBeenCalled();
      for (const scope of ["all", "meta"]) {
        const r = rows.find((r) => r.providerScope === scope);
        const worker = { ...r, workerFreshnessState: "online", lastHeartbeatAt: new Date().toISOString() } as unknown as WorkerHealthRow;
        for (const requireSyncCapable of [false, true]) {
          const h = evaluateWorkerHealth({ summary: { onlineWorkers: 1, workers: [worker], lastHeartbeatAt: worker.lastHeartbeatAt ?? null },
            stagedWorkers: [], ownedWorkUnits: null, expectStagedIdle: false, expectBuildId: null,
            minHeartbeatAfter: null, minOnlineWorkers: 1, requireSyncCapable });
          expect(h.reason).toBe("sync_capacity_refused"); expect(h.capacityRefused).toBe(true);
          expect(h.pass).toBe(!requireSyncCapable);
        }
      }
      expect(mocks.fence.mock.calls.every(([, options]) => options.fresh === true)).toBe(true);
    } finally {
      process.emit("SIGTERM"); await vi.advanceTimersByTimeAsync(0); await runtime;
    }
    const calls = mocks.heartbeat.mock.calls.map(([r]) => r);
    const firstStop = calls.findIndex((r) => r.status === "stopping");
    expect(firstStop).toBeGreaterThan(-1);
    expect(calls.slice(firstStop).every((r) => ["stopping", "stopped"].includes(r.status))).toBe(true);
  });
  it.each([
    ["staged aggregate", () => vi.stubEnv("SYNC_WORKER_STAGING_IDLE", "1"), aggregateRefusal],
    ["lane off aggregate", () => vi.stubEnv("ADSECUTE_SYNC_LANE_META_SYNC_ENABLED", "disabled"), aggregateRefusal],
    ["physical refusal", () => {}, () => aggregateRefusal("physical_capacity_refused")],
    ["unknown read", () => {}, () => new Error("capacity measurement unavailable")],
    ["untyped lookalike", () => {}, () => ({ decision: aggregateRefusal().decision })],
    ["missing physical proof", () => {}, () => new DbGrowthFenceRefusal({ ...aggregateRefusal().decision, physical: null }, "durable_worker_boot")],
    ["override", () => {}, () => new DbGrowthFenceRefusal({ ...aggregateRefusal().decision, overridden: true }, "durable_worker_boot")],
    ["wrong offender", () => {}, () => new DbGrowthFenceRefusal({ ...aggregateRefusal().decision, offender: { table: "meta_entity_state_history", bytes: 101, budget: 100 } }, "durable_worker_boot")],
    ["malformed budget", () => {}, () => new DbGrowthFenceRefusal({ ...aggregateRefusal().decision, databaseBudgetBytes: Number.NaN }, "durable_worker_boot")],
  ])("keeps %s fatal before all heartbeat/business writes", async (_name, setup, error) => {
    setup(); const failure = error(); mocks.fence.mockRejectedValue(failure);
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    await expect(runDurableWorkerRuntime({ adapters: [adapter("meta")] as never })).rejects.toBe(failure);
    expect(mocks.heartbeat).not.toHaveBeenCalled(); expect(mocks.discover).not.toHaveBeenCalled();
  });

  it("propagates a failed capacity heartbeat instead of manufacturing health", async () => {
    const error = new Error("heartbeat insert failed"); mocks.heartbeat.mockRejectedValue(error);
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    await expect(runDurableWorkerRuntime({ adapters: [adapter("meta")] as never })).rejects.toBe(error);
    expect(mocks.fence).toHaveBeenCalledTimes(1); expect(mocks.discover).not.toHaveBeenCalled();
  });

  it("waits for an outstanding heartbeat and retires once without starting another refresh", async () => {
    let release!: () => void;
    mocks.heartbeat.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter("meta")] as never });
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.fence).toHaveBeenCalledTimes(1); expect(mocks.heartbeat).toHaveBeenCalledTimes(1);
    process.emit("SIGTERM"); process.emit("SIGTERM"); release();
    await vi.advanceTimersByTimeAsync(60000); await runtime;
    const rows = mocks.heartbeat.mock.calls.map(([r]) => r);
    expect(rows.filter((r) => r.status === "stopping").map((r) => r.providerScope)).toEqual(["meta", "all"]);
    expect(rows.filter((r) => r.status === "idle")).toHaveLength(1);
    expect(mocks.discover).not.toHaveBeenCalled();
  });

  it("reruns lane admission before leaving the wait and refuses a newly disabled lane", async () => {
    mocks.fence.mockRejectedValueOnce(aggregateRefusal()).mockResolvedValue(undefined);
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    let failure: unknown;
    const runtime = runDurableWorkerRuntime({ adapters: [adapter("meta")] as never }).catch((e) => { failure = e; });
    await vi.advanceTimersByTimeAsync(0);
    vi.stubEnv("ADSECUTE_SYNC_LANE_META_SYNC_ENABLED", "disabled");
    await vi.advanceTimersByTimeAsync(15000); await runtime;
    expect(failure).toBeTruthy(); expect(mocks.fence).toHaveBeenCalledTimes(2);
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.heartbeat.mock.calls.every(([r]) => r.status === "idle")).toBe(true);
  });

  it("refuses a missing immutable identity before the capacity loop", async () => {
    vi.stubEnv("SYNC_WORKER_STAGING_IDLE", "1"); vi.stubEnv("APP_BUILD_ID", ""); vi.stubEnv("ADSECUTE_IMAGE_BUILD_ID", "");
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    await expect(runDurableWorkerRuntime({ adapters: [adapter("meta")] as never })).rejects.toMatchObject({ reason: "build_identity_missing" });
    expect(mocks.fence).not.toHaveBeenCalled(); expect(mocks.heartbeat).not.toHaveBeenCalled();
  });

  it("does not restart normal work when shutdown lands during the fresh admission read", async () => {
    let admit!: () => void;
    mocks.fence.mockRejectedValueOnce(aggregateRefusal()).mockImplementation(() => new Promise<void>((r) => { admit = r; }));
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter("meta")] as never });
    await vi.advanceTimersByTimeAsync(45000);
    expect(mocks.fence).toHaveBeenCalledTimes(2); // No overlapping admission reads.
    process.emit("SIGTERM"); admit(); await vi.advanceTimersByTimeAsync(0); await runtime;
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.heartbeat.mock.calls.some(([r]) => r.status === "starting")).toBe(false);
  });

  it("fails on physical refusal discovered by a later fresh read", async () => {
    const physical = aggregateRefusal("physical_free_space_low");
    mocks.fence.mockRejectedValueOnce(aggregateRefusal()).mockRejectedValue(physical);
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    let failure: unknown;
    const runtime = runDurableWorkerRuntime({ adapters: [adapter("meta")] as never }).catch((e) => { failure = e; });
    await vi.advanceTimersByTimeAsync(15000); await runtime;
    expect(failure).toBe(physical); expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.heartbeat.mock.calls.filter(([r]) => r.status === "idle")).toHaveLength(2);
  });

  it("enters the single normal starting/discovery path only after fresh admission", async () => {
    mocks.fence.mockRejectedValueOnce(aggregateRefusal()).mockResolvedValue(undefined);
    mocks.discover.mockImplementation(async () => { process.emit("SIGTERM"); return { ok: true, businesses: [] }; });
    const { runDurableWorkerRuntime } = await import("@/lib/sync/worker-runtime");
    const runtime = runDurableWorkerRuntime({ adapters: [adapter("meta")] as never });
    await vi.advanceTimersByTimeAsync(0); expect(mocks.discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(17000); await runtime;
    expect(mocks.fence).toHaveBeenCalledTimes(2); expect(mocks.discover).toHaveBeenCalledTimes(1);
    expect(mocks.heartbeat.mock.calls.filter(([r]) => r.status === "starting").map(([r]) => r.providerScope)).toEqual(["all", "meta"]);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
});
