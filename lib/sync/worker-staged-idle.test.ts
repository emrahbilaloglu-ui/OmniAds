/**
 * The staged-idle worker contract, at the level the production incident lived.
 *
 * `deploy-disabled` brings the release up with every lane off and then reads
 * `sync_worker_heartbeats` for proof that the new build is alive, is the right
 * build, and is holding nothing. The branch logged `staging_idle` for the exact
 * run that failed, and the table showed only a `stopping` row — no durable
 * `disabled` registration anywhere.
 *
 * The cause was not persistence. Every heartbeat for a scope upserts
 * ON CONFLICT (worker_id), and `all` maps to the bare worker id — so the staged
 * `disabled` registration and the shutdown `stopping` write land on the SAME
 * ROW. A signal fired both the runtime's shutdown handler and the staged
 * block's own `process.once` stop handler, and `stopping` replaced the evidence
 * the phase exists to read. A refresh tick already in flight could just as
 * easily land after it and put `disabled` back.
 *
 * These tests drive the real runtime with the heartbeat writer mocked, so the
 * ORDER of writes on that one row is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const heartbeatSyncWorker = vi.fn();
const acquireSyncRunnerLease = vi.fn();
const renewSyncRunnerLease = vi.fn();
const releaseSyncRunnerLease = vi.fn();
const readActiveBusinesses = vi.fn();
const getActiveBusinesses = vi.fn();

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

vi.mock("@/lib/sync/worker-health", () => ({
  acquireSyncRunnerLease,
  heartbeatSyncWorker,
  renewSyncRunnerLease,
  releaseSyncRunnerLease,
}));

vi.mock("@/lib/sync/active-businesses", () => ({
  readActiveBusinesses,
  getActiveBusinesses,
}));

const TARGET = "8de30c461c51d3e76e7cd5cc4fb71984751d014e";
const STALE = "6b0a30df42133c1f5ba07f0bd4c4e0b8bb1b7f5a";

type HeartbeatCall = {
  workerId: string;
  providerScope: string;
  status: string;
  metaJson?: Record<string, unknown>;
};

function calls(): HeartbeatCall[] {
  return heartbeatSyncWorker.mock.calls.map(([input]) => input as HeartbeatCall);
}

/** Only the `all`-scope row — the one the staged registration and the shutdown share. */
function allScopeStatuses(): string[] {
  return calls()
    .filter((call) => call.providerScope === "all")
    .map((call) => call.status);
}

const stagedAdapter = {
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
    readinessLevel: "usable" as const,
    checkpointHealth: null,
    domainReadiness: null,
  }),
  consumeBusiness: async () => ({ outcome: "consume_succeeded" }),
};

const ENV_KEYS = [
  "SYNC_WORKER_STAGING_IDLE",
  "APP_BUILD_ID",
  "ADSECUTE_IMAGE_BUILD_ID",
  "ADSECUTE_SYNC_GLOBAL_ENABLED",
  "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
  "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
  "ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED",
  "WORKER_HEARTBEAT_INTERVAL_MS",
  "WORKER_POLL_INTERVAL_MS",
] as const;

let savedEnv: Record<string, string | undefined> = {};

async function importRuntime() {
  return await import("@/lib/sync/worker-runtime");
}

/** Let queued microtasks and timers drain without leaning on real time. */
const settle = async (ticks = 6) => {
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  vi.resetAllMocks();
  vi.resetModules();
  heartbeatSyncWorker.mockResolvedValue(undefined);
  growthFenceMocks.assertSyncGrowthBoundary.mockResolvedValue({
    allowed: true,
    reason: "ready",
  } as never);
  readActiveBusinesses.mockResolvedValue({ ok: true, businesses: [] });
  // Every lane denied — exactly deploy-disabled's configuration.
  delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
  delete process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED;
  delete process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED;
  delete process.env.ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED;
  delete process.env.ADSECUTE_IMAGE_BUILD_ID;
  process.env.SYNC_WORKER_STAGING_IDLE = "1";
  process.env.APP_BUILD_ID = TARGET;
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = "5";
  process.env.WORKER_POLL_INTERVAL_MS = "1";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

describe("staged idle worker: the registration is durable", () => {
  it("persists a canonical disabled/all heartbeat before it is ready to be read", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle();

    // Observable BEFORE anything stops it, and awaited — not queued behind a
    // timer the gate would have to wait out.
    const first = calls()[0];
    expect(first.status).toBe("disabled");
    expect(first.providerScope).toBe("all");
    expect(first.metaJson).toMatchObject({
      stagingIdle: true,
      workerBuildId: TARGET,
    });
    expect(typeof first.metaJson?.workerStartedAt).toBe("string");

    process.emit("SIGTERM");
    await runtime;
  });

  it("refreshes that registration at the heartbeat cadence", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle(40);

    const disabledWrites = calls().filter((call) => call.status === "disabled");
    expect(disabledWrites.length).toBeGreaterThan(1);
    // Every refresh carries the same identity, so freshness advances without
    // the row ever describing a different build.
    for (const write of disabledWrites) {
      expect(write.providerScope).toBe("all");
      expect(write.metaJson).toMatchObject({ stagingIdle: true, workerBuildId: TARGET });
    }

    process.emit("SIGTERM");
    await runtime;
  });

  it("acquires no lease and consumes no work while staged", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const consumeBusiness = vi.fn(async () => ({ outcome: "consume_succeeded" }));
    const leasePartitions = vi.fn(async () => []);
    const runtime = runDurableWorkerRuntime({
      adapters: [{ ...stagedAdapter, consumeBusiness, leasePartitions }] as never,
    });
    await settle(20);

    expect(acquireSyncRunnerLease).not.toHaveBeenCalled();
    expect(renewSyncRunnerLease).not.toHaveBeenCalled();
    expect(releaseSyncRunnerLease).not.toHaveBeenCalled();
    expect(consumeBusiness).not.toHaveBeenCalled();
    expect(leasePartitions).not.toHaveBeenCalled();
    expect(readActiveBusinesses).not.toHaveBeenCalled();
    // Nothing but the `all` registration is ever written.
    expect(calls().every((call) => call.providerScope === "all")).toBe(true);

    process.emit("SIGTERM");
    await runtime;
  });
});

describe("staged idle worker: the Phase-2 incident shape", () => {
  // THE regression. Before the fix, the staged block registered its own
  // process.once stop handler while the runtime's shutdown handler stayed
  // armed; a signal ran both, and `stopping` overwrote `disabled` on the same
  // upsert key. The gate then saw a shutdown where its evidence should be.
  it("does not fall through and replace the registration with stopping", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle(20);

    const statuses = allScopeStatuses();
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain("stopping");
    expect(statuses).not.toContain("stopped");
    expect(statuses.every((status) => status === "disabled")).toBe(true);

    process.emit("SIGTERM");
    await runtime;
  });

  it("moves disabled -> stopping exactly once on a genuine signal, and never back", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle(20);

    process.emit("SIGTERM");
    await runtime;
    await settle(20);

    const statuses = allScopeStatuses();
    expect(statuses.filter((status) => status === "stopping")).toHaveLength(1);
    // `stopping` is the LAST word on that row. A refresh tick landing after it
    // would resurrect a worker that no longer exists.
    expect(statuses[statuses.length - 1]).toBe("stopping");
    expect(statuses.slice(0, -1).every((status) => status === "disabled")).toBe(true);
  });

  it("writes stopping once even when both signals arrive", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle(20);

    process.emit("SIGTERM");
    process.emit("SIGINT");
    await runtime;
    await settle(20);

    expect(allScopeStatuses().filter((status) => status === "stopping")).toHaveLength(1);
  });

  // The overwrite, made deterministic.
  //
  // A refresh tick is a DB round trip, so at the moment SIGTERM arrives one is
  // routinely still in flight. Before the fix, shutdown issued `stopping`
  // immediately alongside it: two writes racing for the same upsert key, with
  // the loser deciding what the deploy gate reads. Whichever way that race
  // lands the row is wrong — `disabled` means a worker that is gone, `stopping`
  // means the registration is destroyed.
  //
  // The contract is that shutdown lets the in-flight refresh finish FIRST and
  // only then writes `stopping`, so the row is never contended at all.
  it("waits for an in-flight refresh before writing stopping, so the two never race", async () => {
    const settled: string[] = [];
    const pending: Array<{ status: string; release: () => void }> = [];
    heartbeatSyncWorker.mockImplementation(
      (input: HeartbeatCall) =>
        new Promise<void>((resolve) => {
          pending.push({
            status: input.status,
            release: () => {
              settled.push(input.status);
              resolve();
            },
          });
        }),
    );
    const release = () => {
      const inFlight = pending.splice(0, pending.length);
      for (const entry of inFlight) entry.release();
    };

    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });

    // The initial registration, awaited by the runtime.
    await settle(4);
    expect(pending.map((entry) => entry.status)).toEqual(["disabled"]);
    release();

    // A refresh tick is now in flight and deliberately left unresolved.
    await settle(10);
    expect(pending.map((entry) => entry.status)).toEqual(["disabled"]);

    process.emit("SIGTERM");
    await settle(10);

    // Nothing has been written against the pending refresh. Before the fix,
    // `stopping` was already queued here and the row's final value was decided
    // by whichever of the two round trips returned last.
    expect(pending.map((entry) => entry.status)).toEqual(["disabled"]);
    expect(settled).not.toContain("stopping");

    release();
    await settle(6);
    expect(pending.map((entry) => entry.status)).toEqual(["stopping"]);
    release();
    await runtime;

    expect(settled[settled.length - 1]).toBe("stopping");
    expect(settled.filter((status) => status === "stopping")).toHaveLength(1);
  });

  it("stops refreshing once the signal arrives", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle(20);

    process.emit("SIGTERM");
    await runtime;
    const afterShutdown = heartbeatSyncWorker.mock.calls.length;
    await settle(40);
    expect(heartbeatSyncWorker.mock.calls.length).toBe(afterShutdown);
  });
});

describe("staged idle worker: failure never looks ready", () => {
  it("exits with the failure when the registration cannot be persisted", async () => {
    heartbeatSyncWorker.mockRejectedValue(new Error("heartbeat write refused"));
    const { runDurableWorkerRuntime } = await importRuntime();

    await expect(
      runDurableWorkerRuntime({ adapters: [stagedAdapter] as never }),
    ).rejects.toThrow("heartbeat write refused");

    // No refresh loop was started behind the failure, so the process cannot sit
    // there looking alive with nothing in the table.
    const before = heartbeatSyncWorker.mock.calls.length;
    await settle(20);
    expect(heartbeatSyncWorker.mock.calls.length).toBe(before);
  });

  it("still refuses fatally when staging is not requested", async () => {
    process.env.SYNC_WORKER_STAGING_IDLE = "0";
    const { runDurableWorkerRuntime } = await importRuntime();

    await expect(
      runDurableWorkerRuntime({ adapters: [stagedAdapter] as never }),
    ).rejects.toThrow();
    expect(heartbeatSyncWorker).not.toHaveBeenCalled();
  });

  it("refuses to stage at all when the host renames the image's build", async () => {
    process.env.ADSECUTE_IMAGE_BUILD_ID = TARGET;
    process.env.APP_BUILD_ID = STALE;
    const { runDurableWorkerRuntime } = await importRuntime();

    await expect(
      runDurableWorkerRuntime({ adapters: [stagedAdapter] as never }),
    ).rejects.toThrow(/build_identity|APP_BUILD_ID/);
    // Refused before any write, so there is no heartbeat claiming either build.
    expect(heartbeatSyncWorker).not.toHaveBeenCalled();
  });

  it("refuses to stage when nothing names a build", async () => {
    delete process.env.APP_BUILD_ID;
    delete process.env.ADSECUTE_IMAGE_BUILD_ID;
    const { runDurableWorkerRuntime } = await importRuntime();

    await expect(
      runDurableWorkerRuntime({ adapters: [stagedAdapter] as never }),
    ).rejects.toThrow(/no immutable release identity/);
    expect(heartbeatSyncWorker).not.toHaveBeenCalled();
  });

  it("registers under the image's identity and makes APP_BUILD_ID agree", async () => {
    process.env.ADSECUTE_IMAGE_BUILD_ID = TARGET;
    delete process.env.APP_BUILD_ID;
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle();

    expect(calls()[0].metaJson).toMatchObject({ workerBuildId: TARGET });
    // buildRuntimeContract() reads APP_BUILD_ID, and that is what the runtime
    // row carries — so heartbeat metadata and sync_runtime_instances cannot
    // disagree about which release this is.
    expect(process.env.APP_BUILD_ID).toBe(TARGET);

    process.emit("SIGTERM");
    await runtime;
  });
});

describe("ordinary worker behaviour is unchanged", () => {
  beforeEach(() => {
    delete process.env.SYNC_WORKER_STAGING_IDLE;
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED = "enabled";
  });

  it("starts, heartbeats per scope, and shuts down through stopping to stopped", async () => {
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle(10);

    const statuses = allScopeStatuses();
    expect(statuses[0]).toBe("starting");
    expect(statuses).not.toContain("disabled");
    expect(calls().some((call) => call.providerScope === "meta")).toBe(true);

    process.emit("SIGTERM");
    await runtime;

    const finalStatuses = allScopeStatuses();
    expect(finalStatuses).toContain("stopping");
    expect(finalStatuses[finalStatuses.length - 1]).toBe("stopped");
  });

  it("does not enforce build identity outside production when unstaged", async () => {
    delete process.env.APP_BUILD_ID;
    delete process.env.ADSECUTE_IMAGE_BUILD_ID;
    const { runDurableWorkerRuntime } = await importRuntime();
    const runtime = runDurableWorkerRuntime({ adapters: [stagedAdapter] as never });
    await settle(10);

    expect(calls()[0].status).toBe("starting");
    expect(calls()[0].metaJson).toMatchObject({ workerBuildId: "dev-build" });

    process.emit("SIGTERM");
    await runtime;
  });
});
