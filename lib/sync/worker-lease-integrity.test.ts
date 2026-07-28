import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A runner lease lost part-way through a partition used to complete the
 * partition anyway.
 *
 * `runAdapterLifecycleTick` checked `leaseGuard.isLeaseLost()` only at the top
 * of the partition loop. WORKER_PARTITION_TICK_LIMIT defaults to 1, so that
 * check ran exactly once per tick — before any work — and the pipeline that
 * followed (getCheckpoint, fetchChunk, persistChunk, transformChunk,
 * advanceCheckpoint, writeFacts, completePartition) had no further check.
 * fetchChunk is the long provider read, which is precisely when a two-minute
 * lease expires. So a worker that had already lost its lease to a new owner ran
 * every write to completion and the tick reported `succeeded`, while the new
 * owner was working the same business.
 *
 * These tests drive the real tick with a guard that loses the lease mid-flight.
 */

vi.mock("@/lib/sync/global-kill-switch", () => ({
  assertSyncLaneEnabled: vi.fn(),
  SyncLaneDisabledError: class extends Error {},
}));
vi.mock("@/lib/sync/db-growth-fence", () => ({
  assertSyncGrowthBoundary: vi.fn().mockResolvedValue(undefined),
}));

const PIPELINE_STEPS = [
  "getCheckpoint",
  "fetchChunk",
  "persistChunk",
  "transformChunk",
  "advanceCheckpoint",
  "writeFacts",
  "completePartition",
] as const;

function buildAdapter(calls: string[], loseLeaseDuring: string | null, guard: { markLeaseLost(reason: string): void }) {
  const step = (name: (typeof PIPELINE_STEPS)[number]) => async () => {
    calls.push(name);
    if (loseLeaseDuring === name) guard.markLeaseLost("runner_lease_conflict");
    return {} as never;
  };
  return {
    providerScope: "meta" as const,
    leasePartitions: async () => [
      { partitionId: "part-1", businessId: "biz-1", providerAccountId: "act_1" },
    ],
    getCheckpoint: step("getCheckpoint"),
    fetchChunk: step("fetchChunk"),
    persistChunk: step("persistChunk"),
    transformChunk: step("transformChunk"),
    advanceCheckpoint: step("advanceCheckpoint"),
    writeFacts: step("writeFacts"),
    completePartition: step("completePartition"),
    classifyFailure: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  };
}

describe("runner lease loss mid-partition", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.WORKER_PARTITION_TICK_LIMIT = "1";
  });

  it("stops writing as soon as the lease is lost during the provider read", async () => {
    const { createRunnerLeaseGuard, runAdapterLifecycleTick } = await import(
      "./worker-runtime"
    );
    const guard = createRunnerLeaseGuard();
    const calls: string[] = [];
    const adapter = buildAdapter(calls, "fetchChunk", guard);

    const result = await runAdapterLifecycleTick({
      adapter,
      businessId: "biz-1",
      workerId: "worker-1",
      leaseGuard: guard,
    } as never);

    expect(
      calls,
      "every write after the lease was lost must be abandoned",
    ).toEqual(["getCheckpoint", "fetchChunk"]);
    expect(calls).not.toContain("persistChunk");
    expect(calls).not.toContain("writeFacts");
    expect(calls).not.toContain("completePartition");
  });

  it("never reports a partition it abandoned as succeeded", async () => {
    const { createRunnerLeaseGuard, runAdapterLifecycleTick } = await import(
      "./worker-runtime"
    );
    const guard = createRunnerLeaseGuard();
    const calls: string[] = [];
    const adapter = buildAdapter(calls, "fetchChunk", guard);

    const result = (await runAdapterLifecycleTick({
      adapter,
      businessId: "biz-1",
      workerId: "worker-1",
      leaseGuard: guard,
    } as never)) as { succeeded: number; failed: number; failureReasons: string[] };

    expect(result.succeeded, "a lost lease is not a success").toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failureReasons).toContain("runner_lease_conflict");
  });

  it("still runs the whole pipeline when the lease is held throughout", async () => {
    const { createRunnerLeaseGuard, runAdapterLifecycleTick } = await import(
      "./worker-runtime"
    );
    const guard = createRunnerLeaseGuard();
    const calls: string[] = [];
    const adapter = buildAdapter(calls, null, guard);

    const result = (await runAdapterLifecycleTick({
      adapter,
      businessId: "biz-1",
      workerId: "worker-1",
      leaseGuard: guard,
    } as never)) as { succeeded: number; failed: number };

    expect(calls).toEqual([...PIPELINE_STEPS]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("abandons before the facts are written when the lease drops later in the pipeline", async () => {
    const { createRunnerLeaseGuard, runAdapterLifecycleTick } = await import(
      "./worker-runtime"
    );
    const guard = createRunnerLeaseGuard();
    const calls: string[] = [];
    const adapter = buildAdapter(calls, "transformChunk", guard);

    await runAdapterLifecycleTick({
      adapter,
      businessId: "biz-1",
      workerId: "worker-1",
      leaseGuard: guard,
    } as never);

    expect(calls).toContain("transformChunk");
    expect(
      calls,
      "advanceCheckpoint/writeFacts must not run once the lease is gone",
    ).not.toContain("advanceCheckpoint");
    expect(calls).not.toContain("writeFacts");
  });
});
