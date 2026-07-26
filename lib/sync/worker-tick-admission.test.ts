import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker's tick leased partitions before anything checked whether it was
 * allowed to work at all.
 *
 * `runAdapterLifecycleTick` is the real work-unit boundary: taking leases,
 * reading and advancing checkpoints, persisting chunks and completing
 * partitions all happen inside it. Leasing first meant a disabled lane or a
 * database over budget still mutated partition state on every tick — and when
 * the refusal did surface it arrived as one more string in `failureReasons`,
 * indistinguishable from a provider timeout to everything downstream.
 */

const assertSyncGrowthBoundary = vi.fn();

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return { ...actual, assertSyncGrowthBoundary };
});

const { runAdapterLifecycleTick } = await import("@/lib/sync/worker-runtime");
const { DbGrowthFenceRefusal } = await import("@/lib/sync/db-growth-fence");

const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_META_SYNC_ENABLED: "enabled",
};

function buildAdapter(calls: string[]) {
  return {
    providerScope: "meta" as const,
    planPartitions: async () => ({ partitions: [] }),
    leasePartitions: async () => {
      calls.push("leasePartitions");
      return [
        {
          partitionId: "part-1",
          businessId: "biz-1",
          providerAccountId: "act_1",
          scope: "account_daily",
          partitionDate: "2026-04-01",
          lane: "core",
        },
      ];
    },
    getCheckpoint: async () => {
      calls.push("getCheckpoint");
      return null;
    },
    fetchChunk: async () => {
      calls.push("fetchChunk");
      return { payload: "chunk" };
    },
    persistChunk: async () => {
      calls.push("persistChunk");
    },
    transformChunk: async () => {
      calls.push("transformChunk");
    },
    advanceCheckpoint: async () => {
      calls.push("advanceCheckpoint");
    },
    writeFacts: async () => {
      calls.push("writeFacts");
    },
    completePartition: async () => {
      calls.push("completePartition");
    },
    classifyFailure: () => "x",
    consumeBusiness: async () => null,
  };
}

const run = (calls: string[]) =>
  runAdapterLifecycleTick({
    adapter: buildAdapter(calls) as never,
    businessId: "biz-1",
    workerId: "worker-1",
    leaseLimit: 1,
  });

function withEnv(patch: Record<string, string>, body: () => Promise<void>) {
  const saved = { ...process.env };
  Object.assign(process.env, patch);
  return body().finally(() => {
    process.env = saved;
  });
}

describe("worker tick admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    assertSyncGrowthBoundary.mockResolvedValue({ allowed: true, reason: "ready" });
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    delete process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED;
  });

  it.each([
    ["nothing set", {}],
    ["master on, lane unset", { ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled" }],
    [
      "master on, lane off",
      {
        ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
        ADSECUTE_SYNC_LANE_META_SYNC_ENABLED: "off",
      },
    ],
  ])("leases nothing and mutates nothing with %s", (_label, env) =>
    withEnv(env, async () => {
      const calls: string[] = [];
      const result = await run(calls);

      // Zero mutation of any kind: no lease, no checkpoint read, no checkpoint
      // advance, no completion.
      expect(calls).toEqual([]);
      expect(result.attempted).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.leasedPartitionIds).toEqual([]);
      // And the growth fence was not even consulted, because the lane closed
      // first.
      expect(assertSyncGrowthBoundary).not.toHaveBeenCalled();
    }),
  );

  it("keeps a capacity refusal as structure rather than one more failure string", () =>
    withEnv(LANE_ON, async () => {
      assertSyncGrowthBoundary.mockRejectedValue(
        new DbGrowthFenceRefusal(
          {
            allowed: false,
            reason: "physical_free_space_low",
            warning: false,
            databaseBytes: 1,
            databaseBudgetBytes: 2,
            tableBytes: {},
            offender: null,
            evaluatedAt: new Date(0).toISOString(),
            errorMessage: "disk full",
            overridden: false,
            physical: null,
          },
          "meta_worker_tick",
        ),
      );

      const calls: string[] = [];
      const result = await run(calls);

      expect(calls).toEqual([]);
      expect(result.attempted).toBe(0);
      // The discriminated refusal survives, so a caller can tell "we were told
      // not to" from "we tried and failed".
      expect(result.safetyRefusal).toMatchObject({
        kind: "capacity_refused",
        scope: "meta_worker_tick",
      });
    }));

  it("measures freshly at the tick boundary, not from a previous tick's cache", () =>
    withEnv(LANE_ON, async () => {
      await run([]);
      expect(assertSyncGrowthBoundary).toHaveBeenCalledWith(
        "meta_worker_tick",
        expect.objectContaining({ fresh: true }),
      );
    }));

  it("re-checks at every work unit and stops the loop on refusal", () =>
    withEnv(LANE_ON, async () => {
      // Admitted at the tick boundary, refused at the partition boundary: a
      // long tick must not cross the budget unchecked.
      let call = 0;
      assertSyncGrowthBoundary.mockImplementation(async () => {
        call += 1;
        if (call === 1) return { allowed: true, reason: "ready" };
        throw new DbGrowthFenceRefusal(
          {
            allowed: false,
            reason: "table_budget_exceeded",
            warning: false,
            databaseBytes: 2,
            databaseBudgetBytes: 1,
            tableBytes: {},
            offender: { table: "meta_raw_snapshots", bytes: 2, budget: 1 },
            evaluatedAt: new Date(0).toISOString(),
            errorMessage: null,
            overridden: false,
            physical: null,
          },
          "meta_worker_partition",
        );
      });

      const calls: string[] = [];
      const result = await run(calls);

      // The lease happened — that is what makes this the partition boundary
      // rather than the tick boundary — but nothing was processed, so the
      // leased work stays claimed and is retried later.
      expect(calls).toEqual(["leasePartitions"]);
      expect(result.succeeded).toBe(0);
      expect(result.safetyRefusal).toMatchObject({ kind: "capacity_refused" });
    }));

  it("runs the full lifecycle once admitted", () =>
    withEnv(LANE_ON, async () => {
      const calls: string[] = [];
      const result = await run(calls);
      expect(result.succeeded).toBe(1);
      expect(calls).toEqual([
        "leasePartitions",
        "getCheckpoint",
        "fetchChunk",
        "persistChunk",
        "transformChunk",
        "advanceCheckpoint",
        "writeFacts",
        "completePartition",
      ]);
    }));
});
