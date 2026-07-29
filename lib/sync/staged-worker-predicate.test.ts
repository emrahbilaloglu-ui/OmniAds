/**
 * What `deploy-disabled` refuses, case by case.
 *
 * The phase reads `sync_worker_heartbeats` and decides whether THIS run of THIS
 * build is staged. Every case below is one it must refuse, and several of them
 * used to pass: a `disabled` row is `staged` forever regardless of age, and
 * freshness was read from a MAX across the whole table that any other worker
 * could satisfy on the staged worker's behalf.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateWorkerHealth,
  selectStagedWorkers,
  type WorkerHealthRow,
} from "@/lib/sync/staged-worker-predicate";

const TARGET = "8de30c461c51d3e76e7cd5cc4fb71984751d014e";
const STALE = "6b0a30df42133c1f5ba07f0bd4c4e0b8bb1b7f5a";

const NOW = Date.UTC(2026, 6, 29, 14, 55, 0);
/** When the staged container started, as `docker inspect .State.StartedAt` reports it. */
const CONTAINER_STARTED_AT = new Date(NOW - 30_000).toISOString();

function stagedRow(overrides: Partial<WorkerHealthRow> = {}): WorkerHealthRow {
  return {
    workerId: "sync-worker:1:u8fvgd2m",
    providerScope: "all",
    status: "disabled",
    workerFreshnessState: "staged",
    lastHeartbeatAt: new Date(NOW - 2_000).toISOString(),
    metaJson: {
      stagingIdle: true,
      workerBuildId: TARGET,
      workerStartedAt: new Date(NOW - 25_000).toISOString(),
      runtimeContract: { buildId: TARGET },
    },
    ...overrides,
  };
}

function evaluate(input: {
  workers: WorkerHealthRow[];
  onlineWorkers?: number;
  owned?: Record<string, number> | null;
  expectBuildId?: string | null;
  minHeartbeatAfter?: string | null;
}) {
  const staged = selectStagedWorkers({
    workers: input.workers,
    nowMs: NOW,
    onlineWindowMinutes: 5,
  });
  const lastHeartbeatAt =
    input.workers
      .map((worker) => worker.lastHeartbeatAt)
      .filter((value): value is string => typeof value === "string")
      .sort()
      .at(-1) ?? null;
  return {
    staged,
    result: evaluateWorkerHealth({
      summary: {
        onlineWorkers: input.onlineWorkers ?? 0,
        lastHeartbeatAt,
        workers: input.workers,
      },
      stagedWorkers: staged,
      ownedWorkUnits: input.owned ?? { runnerLeases: 0, jobLocks: 0 },
      expectStagedIdle: true,
      expectBuildId: input.expectBuildId ?? TARGET,
      minHeartbeatAfter: input.minHeartbeatAfter ?? CONTAINER_STARTED_AT,
      minOnlineWorkers: 1,
    }),
  };
}

describe("deploy-disabled accepts a correctly staged worker", () => {
  it("passes on exactly one fresh disabled/all registration from this run and build", () => {
    const { result } = evaluate({ workers: [stagedRow()] });
    expect(result).toMatchObject({
      pass: true,
      reason: "healthy",
      stagedWorkerId: "sync-worker:1:u8fvgd2m",
      stagedWorkerBuildId: TARGET,
      stagedWorkerContractBuildId: TARGET,
      stagedIsThisRun: true,
      stagedBuildIdMatches: true,
    });
  });

  it("still passes the ordinary contract when no build id is pinned", () => {
    const { result } = evaluate({ workers: [stagedRow()], expectBuildId: null });
    expect(result.pass).toBe(true);
  });
});

describe("deploy-disabled refuses", () => {
  it("when no worker registered at all", () => {
    const { result } = evaluate({ workers: [] });
    expect(result.reason).toBe("staged_idle_not_observed");
  });

  // The production shape: the outgoing worker's shutdown row is all that is
  // left, because the staged registration was overwritten on the same key.
  it("when only a stopping heartbeat is present", () => {
    const { result } = evaluate({
      workers: [
        stagedRow({ status: "stopping", workerFreshnessState: "online" }),
      ],
    });
    expect(result.reason).toBe("staged_idle_not_observed");
  });

  it("when two workers registered as staged", () => {
    const { result } = evaluate({
      workers: [stagedRow(), stagedRow({ workerId: "sync-worker:1:other" })],
    });
    expect(result.reason).toBe("staged_idle_not_observed");
  });

  // A `disabled` row never stops reporting workerFreshnessState 'staged', so
  // without a freshness bound a worker from a previous epoch certifies a run
  // that never came up.
  it("when the only disabled row is from an earlier epoch", () => {
    const stale = stagedRow({
      lastHeartbeatAt: new Date(NOW - 45 * 60_000).toISOString(),
    });
    expect(selectStagedWorkers({ workers: [stale], nowMs: NOW, onlineWindowMinutes: 5 }))
      .toHaveLength(0);
    expect(evaluate({ workers: [stale] }).result.reason).toBe("staged_idle_not_observed");
  });

  // Fresh enough to be inside the window, but written by the container that was
  // just replaced — so it says nothing about the build now running.
  it("when the fresh disabled row predates this container's start", () => {
    const previousRun = stagedRow({
      lastHeartbeatAt: new Date(NOW - 90_000).toISOString(),
      metaJson: {
        stagingIdle: true,
        workerBuildId: TARGET,
        workerStartedAt: new Date(NOW - 120_000).toISOString(),
        runtimeContract: { buildId: TARGET },
      },
    });
    expect(evaluate({ workers: [previousRun] }).result.reason).toBe(
      "staged_worker_is_not_this_run",
    );
  });

  it("when the registration carries no start time to prove which run it is", () => {
    const { result } = evaluate({
      workers: [
        stagedRow({
          metaJson: { stagingIdle: true, workerBuildId: TARGET, runtimeContract: { buildId: TARGET } },
        }),
      ],
    });
    expect(result.reason).toBe("staged_worker_is_not_this_run");
  });

  // The stale-.env.production case: the image is 8de3…, the heartbeat says
  // 6b0a…, and nothing downstream can tell the difference without this check.
  it("when the staged worker reports a different build than the pinned target", () => {
    const { result } = evaluate({
      workers: [
        stagedRow({
          metaJson: {
            stagingIdle: true,
            workerBuildId: STALE,
            workerStartedAt: new Date(NOW - 25_000).toISOString(),
            runtimeContract: { buildId: STALE },
          },
        }),
      ],
    });
    expect(result.reason).toBe("staged_worker_build_identity_mismatch");
    expect(result.stagedWorkerBuildId).toBe(STALE);
  });

  it("when the heartbeat metadata and the runtime contract disagree with each other", () => {
    const { result } = evaluate({
      workers: [
        stagedRow({
          metaJson: {
            stagingIdle: true,
            workerBuildId: TARGET,
            workerStartedAt: new Date(NOW - 25_000).toISOString(),
            runtimeContract: { buildId: STALE },
          },
        }),
      ],
    });
    expect(result.reason).toBe("staged_worker_build_identity_mismatch");
  });

  it("when the registration carries no build identity at all", () => {
    const { result } = evaluate({
      workers: [
        stagedRow({
          metaJson: {
            stagingIdle: true,
            workerStartedAt: new Date(NOW - 25_000).toISOString(),
          },
        }),
      ],
    });
    expect(result.reason).toBe("staged_worker_build_identity_mismatch");
  });

  it("when a worker is online — the lanes are supposed to be off", () => {
    const { result } = evaluate({ workers: [stagedRow()], onlineWorkers: 1 });
    expect(result.reason).toBe("unexpected_online_workers");
  });

  it("when the staged worker holds any unit of work", () => {
    const { result } = evaluate({
      workers: [stagedRow()],
      owned: { runnerLeases: 0, metaPartitionClaims: 1, jobLocks: 0 },
    });
    expect(result.reason).toBe("staged_worker_holds_work");
  });

  // The registration is a per-provider row, not the canonical singleton.
  it("when the only disabled row is scoped to a provider rather than all", () => {
    const scoped = stagedRow({ providerScope: "meta", workerId: "sync-worker:1:x::meta" });
    expect(evaluate({ workers: [scoped] }).result.reason).toBe("staged_idle_not_observed");
  });

  // Freshness used to come from MAX(last_heartbeat_at) over every row, so an
  // unrelated worker's heartbeat answered for the staged one.
  it("when only another worker's heartbeat is fresh", () => {
    const stale = stagedRow({
      lastHeartbeatAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    const noisyNeighbour: WorkerHealthRow = {
      workerId: "sync-worker:1:neighbour",
      providerScope: "all",
      status: "stopping",
      workerFreshnessState: "online",
      lastHeartbeatAt: new Date(NOW - 1_000).toISOString(),
      metaJson: {},
    };
    const { result } = evaluate({ workers: [stale, noisyNeighbour] });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("staged_idle_not_observed");
  });
});

describe("the ordinary online contract is unchanged", () => {
  it("refuses when no worker is online", () => {
    const result = evaluateWorkerHealth({
      summary: { onlineWorkers: 0, lastHeartbeatAt: null, workers: [] },
      stagedWorkers: [],
      ownedWorkUnits: null,
      expectStagedIdle: false,
      expectBuildId: null,
      minHeartbeatAfter: null,
      minOnlineWorkers: 1,
    });
    expect(result.reason).toBe("insufficient_online_workers");
  });

  // --min-online-workers 1 must keep failing against a staged worker; if it
  // passed, staged and working would be interchangeable.
  it("refuses a staged worker under the online contract", () => {
    const result = evaluateWorkerHealth({
      summary: {
        onlineWorkers: 0,
        lastHeartbeatAt: new Date(NOW - 2_000).toISOString(),
        workers: [stagedRow()],
      },
      stagedWorkers: [stagedRow()],
      ownedWorkUnits: null,
      expectStagedIdle: false,
      expectBuildId: null,
      minHeartbeatAfter: null,
      minOnlineWorkers: 1,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("insufficient_online_workers");
  });

  it("passes an ordinary fresh online worker", () => {
    const result = evaluateWorkerHealth({
      summary: {
        onlineWorkers: 1,
        lastHeartbeatAt: new Date(NOW - 1_000).toISOString(),
        workers: [],
      },
      stagedWorkers: [],
      ownedWorkUnits: null,
      expectStagedIdle: false,
      expectBuildId: null,
      minHeartbeatAfter: CONTAINER_STARTED_AT,
      minOnlineWorkers: 1,
    });
    expect(result.pass).toBe(true);
  });

  it("rejects an unparseable --min-heartbeat-after rather than ignoring it", () => {
    expect(() =>
      evaluateWorkerHealth({
        summary: { onlineWorkers: 1, lastHeartbeatAt: null, workers: [] },
        stagedWorkers: [],
        ownedWorkUnits: null,
        expectStagedIdle: false,
        expectBuildId: null,
        minHeartbeatAfter: "not-a-timestamp",
        minOnlineWorkers: 1,
      }),
    ).toThrow(/invalid ISO timestamp/);
  });
});

describe("the outgoing worker's lane rows are what fail the gate", () => {
  // The exact production shape. The old worker's shutdown retired `all` only,
  // so its three lane rows stayed fresh and non-terminal and counted as online.
  const OLD = "sync-worker:18:dbgah1xc";
  function outgoingLaneRows(status = "idle"): WorkerHealthRow[] {
    return [
      {
        workerId: OLD,
        providerScope: "all",
        status: "stopping",
        workerFreshnessState: "online",
        lastHeartbeatAt: new Date(NOW - 5_000).toISOString(),
        metaJson: {},
      },
      ...["meta", "shopify", "google_ads"].map((scope) => ({
        workerId: `${OLD}::${scope}`,
        providerScope: scope,
        status: scope === "meta" ? "running" : status,
        workerFreshnessState: "online" as const,
        lastHeartbeatAt: new Date(NOW - 150_000).toISOString(),
        metaJson: {},
      })),
    ];
  }

  it("refuses while the departed worker's lane rows are still non-terminal", () => {
    const { result } = evaluate({
      workers: [stagedRow(), ...outgoingLaneRows()],
      onlineWorkers: 3,
    });
    expect(result.reason).toBe("unexpected_online_workers");
    // Everything ABOUT the staged worker was already correct — the staged
    // worker is not what is wrong here.
    expect(result.stagedIsThisRun).toBe(true);
    expect(result.stagedBuildIdMatches).toBe(true);
    expect(result.holdsNothing).toBe(true);
  });

  it("passes once those exact rows are retired to stopping", () => {
    const retired = outgoingLaneRows().map((row) => ({ ...row, status: "stopping" }));
    const { result } = evaluate({ workers: [stagedRow(), ...retired], onlineWorkers: 0 });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("healthy");
  });

  // Retirement must not be able to buy a pass by hiding a worker that is
  // genuinely still running: the predicate is unchanged, so a live worker that
  // was never retired still refuses.
  it("still refuses an unrelated worker that is genuinely online", () => {
    const retired = outgoingLaneRows().map((row) => ({ ...row, status: "stopping" }));
    const other: WorkerHealthRow = {
      workerId: "sync-worker:99:someoneelse::meta",
      providerScope: "meta",
      status: "running",
      workerFreshnessState: "online",
      lastHeartbeatAt: new Date(NOW - 1_000).toISOString(),
      metaJson: {},
    };
    const { result } = evaluate({
      workers: [stagedRow(), ...retired, other],
      onlineWorkers: 1,
    });
    expect(result.reason).toBe("unexpected_online_workers");
  });
});
