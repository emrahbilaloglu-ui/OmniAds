/**
 * Retirement of the outgoing worker, case by case.
 *
 * The incident this exists for: after a recreate the old worker's `all` row is
 * `stopping` but its meta / shopify / google_ads rows are still `running` or
 * `idle` and still fresh, so `online_workers` counts a worker that has exited
 * and `deploy-disabled` refuses the staged worker on its behalf.
 *
 * Retirement must fix exactly that and nothing wider. Every refusal below is a
 * way of accidentally hiding a worker that is still doing work.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
const getSyncWorkerOwnedWorkUnits = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: () => sqlMock }));
vi.mock("@/lib/sync/worker-health", () => ({ getSyncWorkerOwnedWorkUnits }));

const INSTANCE = "sync-worker:18:dbgah1xc";
const OLD_BUILD = "8de30c461c51d3e76e7cd5cc4fb71984751d014e";
const NEW_BUILD = "cd3a07261ad53c1f3e070eb8e71d3a485d94bd91";
const STARTED = "2026-07-29T12:22:03.480Z";

/** After the canonical shutdown write in every fixture below. */
const FINISHED_AT = "2026-07-29T17:50:00.000Z";
const LATE_FINISHED_AT = "2026-07-29T19:01:00.000Z";
/** The stability wait is injected, so no test spends real time on it. */
const INSTANT = { sleep: async () => {} };

const NO_WORK = {
  runnerLeases: 0,
  googleLaneLeases: 0,
  metaPartitionClaims: 0,
  googlePartitionClaims: 0,
  metaCheckpointClaims: 0,
  googleCheckpointClaims: 0,
  jobLocks: 0,
};

/** The exact production shape: `all` retired, the three lanes left behind. */
function incidentRows() {
  return [
    row("all", "stopping", "2026-07-29T17:49:55.000Z"),
    row("google_ads", "idle", "2026-07-29T17:49:10.000Z"),
    row("meta", "running", "2026-07-29T17:49:50.000Z"),
    row("shopify", "idle", "2026-07-29T17:49:46.000Z"),
  ];
}

function row(scope: string, status: string, heartbeatAt: string, overrides: Record<string, unknown> = {}) {
  return {
    worker_id: scope === "all" ? INSTANCE : `${INSTANCE}:${scope}`,
    provider_scope: scope,
    status,
    last_heartbeat_at: heartbeatAt,
    meta_json: { workerBuildId: OLD_BUILD, workerStartedAt: STARTED },
    ...overrides,
  };
}

/**
 * The tagged-template `sql` is driven by call order: SELECTs return the row set
 * queued for them, UPDATEs return their RETURNING result.
 */
function queueSql(sequence: Array<Array<Record<string, unknown>>>) {
  let selectIndex = 0;
  sqlMock.mockImplementation((strings: unknown) => {
    const text = Array.isArray(strings) ? (strings as string[]).join("?") : "";
    if (text.includes("AS runner_leases")) return Promise.resolve([HELD_WORK]);
    if (text.includes("UPDATE sync_worker_heartbeats")) {
      return Promise.resolve(UPDATE_RESULT);
    }
    // Row reads, in order. The last queued set is reused, so a case that queues
    // one set gets the SAME rows for both stability samples — i.e. a silent
    // worker — unless it deliberately queues a second, different set.
    const next = sequence[selectIndex] ?? sequence[sequence.length - 1] ?? [];
    selectIndex += 1;
    return Promise.resolve(next);
  });
}

/** What a guarded UPDATE returns. Empty models a concurrent write. */
let UPDATE_RESULT: Array<Record<string, unknown>> = [{ worker_id: "updated" }];

/** Rows returned by the held-work probe. Nothing in force by default. */
let HELD_WORK: Record<string, unknown> = {
  runner_leases: 0, google_lane_leases: 0, meta_partition_claims: 0,
  google_partition_claims: 0, meta_checkpoint_claims: 0,
  google_checkpoint_claims: 0, job_locks: 0,
};

async function load() {
  return await import("@/lib/sync/worker-retirement");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  HELD_WORK = {
    runner_leases: 0, google_lane_leases: 0, meta_partition_claims: 0,
    google_partition_claims: 0, meta_checkpoint_claims: 0,
    google_checkpoint_claims: 0, job_locks: 0,
  };
  UPDATE_RESULT = [{ worker_id: "updated" }];
  getSyncWorkerOwnedWorkUnits.mockResolvedValue(NO_WORK);
});

describe("capture", () => {
  it("records every scope the outgoing worker registered, with its identity", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    expect(census.runtimeInstanceId).toBe(INSTANCE);
    expect(census.buildId).toBe(OLD_BUILD);
    expect(census.workerStartedAt).toBe(STARTED);
    expect(census.rows.map((r) => r.providerScope).sort()).toEqual([
      "all",
      "google_ads",
      "meta",
      "shopify",
    ]);
    expect(census.rows.find((r) => r.providerScope === "meta")?.status).toBe("running");
  });

  it("refuses when the worker has no rows at all", async () => {
    queueSql([[]]);
    const { captureOutgoingWorkerCensus, WorkerRetirementRefusal } = await load();
    await expect(
      captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE }),
    ).rejects.toBeInstanceOf(WorkerRetirementRefusal);
  });

  it("refuses an ambiguous worker with two rows for one scope", async () => {
    queueSql([[row("meta", "running", "2026-07-29T17:49:50.000Z"), row("meta", "idle", "2026-07-29T17:49:51.000Z")]]);
    const { captureOutgoingWorkerCensus } = await load();
    await expect(captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE })).rejects.toThrow(
      /more than one row for scope meta/,
    );
  });
});

describe("retire: the incident shape", () => {
  it("retires exactly the lane rows the old shutdown left behind", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    queueSql([incidentRows()]);
    const result = await retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT });

    expect(result.retiredWorkerIds.sort()).toEqual([
      `${INSTANCE}:google_ads`,
      `${INSTANCE}:meta`,
      `${INSTANCE}:shopify`,
    ]);
    // `all` was already `stopping`; it is left alone rather than rewritten.
    expect(result.alreadyTerminalWorkerIds).toEqual([INSTANCE]);
  });

  it("never advances last_heartbeat_at, so a departed worker cannot look fresh", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    queueSql([incidentRows()]);
    await retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT });

    const statements = sqlMock.mock.calls.map(([strings]) => (strings as string[]).join("?"));
    const updates = statements.filter((s) => s.includes("UPDATE sync_worker_heartbeats"));
    expect(updates).toHaveLength(3);
    for (const statement of updates) {
      expect(statement).toContain("status = 'stopping'");
      expect(statement).not.toContain("last_heartbeat_at = now()");
      // Guarded on the censused timestamp, at millisecond resolution on BOTH
      // sides: timestamptz keeps microseconds and the census only survives as a
      // JavaScript Date, so an untruncated equality guard matches nothing and
      // every retirement refuses as a phantom concurrent write.
      expect(statement).toContain("date_trunc('milliseconds', last_heartbeat_at)");
      expect(statement).toContain("date_trunc('milliseconds',");
    }
  });
});

describe("retire: refusals", () => {
  async function censusThen(live: Array<Record<string, unknown>>, owned = NO_WORK) {
    queueSql([incidentRows()]);
    const mod = await load();
    const census = await mod.captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    getSyncWorkerOwnedWorkUnits.mockResolvedValue(owned);
    queueSql([live]);
    return { mod, census };
  }

  it("refuses without an explicit container-stopped assertion", async () => {
    const { mod, census } = await censusThen(incidentRows());
    await expect(
      mod.retireStoppedSyncWorker({ census, containerStopped: false, containerFinishedAt: FINISHED_AT, ...INSTANT }),
    ).rejects.toThrow(/did not assert that the outgoing container is stopped/);
  });

  // A row that beat AFTER the canonical shutdown write is not this worker's
  // shutdown. Movement before it is the graceful-stop case and is accepted; see
  // the stop-sequence group below.
  it("refuses when a row beat after the container exited", async () => {
    const moved = incidentRows().map((r) =>
      r.provider_scope === "meta" ? { ...r, last_heartbeat_at: "2026-07-29T17:51:00.000Z" } : r,
    );
    const { mod, census } = await censusThen(moved);
    await expect(
      mod.retireStoppedSyncWorker({
        census, containerStopped: true,
        containerFinishedAt: "2026-07-29T17:49:56.000Z",
        clockSkewToleranceMs: 1_000, ...INSTANT,
      }),
    ).rejects.toThrow(/after the container exited/);
  });

  it("refuses when a censused row has vanished", async () => {
    const { mod, census } = await censusThen(incidentRows().filter((r) => r.provider_scope !== "meta"));
    await expect(mod.retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT })).rejects.toThrow(
      /no longer exists/,
    );
  });

  it("refuses when a scope appeared after the capture", async () => {
    const extra = [...incidentRows(), row("search_console", "running", "2026-07-29T17:50:30.000Z")];
    const { mod, census } = await censusThen(extra);
    await expect(mod.retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT })).rejects.toThrow(
      /the census did not record/,
    );
  });

  // Cross-run retirement: same worker id, different run.
  it("refuses when the rows now report a different build", async () => {
    const rebuilt = incidentRows().map((r) => ({
      ...r,
      meta_json: { workerBuildId: NEW_BUILD, workerStartedAt: STARTED },
    }));
    const { mod, census } = await censusThen(rebuilt);
    await expect(mod.retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT })).rejects.toThrow(
      /now reports build/,
    );
  });

  it("refuses when the rows now report a different start time", async () => {
    const restarted = incidentRows().map((r) => ({
      ...r,
      meta_json: { workerBuildId: OLD_BUILD, workerStartedAt: "2026-07-29T18:30:00.000Z" },
    }));
    const { mod, census } = await censusThen(restarted);
    await expect(mod.retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT })).rejects.toThrow(
      /this is a different run/,
    );
  });

  it.each([
    ["runner_leases", "runner_leases"],
    ["meta_partition_claims", "meta_partition_claims"],
    ["job_locks", "job_locks"],
  ])("refuses when the worker still holds %s in force", async (_label, key) => {
    queueSql([incidentRows()]);
    const mod = await load();
    const census = await mod.captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    HELD_WORK = { ...HELD_WORK, [key]: 1 };
    queueSql([incidentRows()]);
    await expect(mod.retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT })).rejects.toThrow(
      /still holds/,
    );
  });

  it("refuses if a row changes between the check and the write", async () => {
    queueSql([incidentRows()]);
    const mod = await load();
    const census = await mod.captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    queueSql([incidentRows()]);
    // The guarded UPDATE matches nothing: the row moved under it.
    UPDATE_RESULT = [];
    await expect(mod.retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT })).rejects.toThrow(
      /changed while it was being retired/,
    );
  });
});

describe("retire: blast radius", () => {
  it("touches only rows belonging to the censused instance", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    queueSql([incidentRows()]);
    await retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT });

    const params = sqlMock.mock.calls.flatMap(([, ...values]) => values as unknown[]);
    const targeted = params.filter(
      (value): value is string => typeof value === "string" && value.startsWith("sync-worker:"),
    );
    for (const workerId of targeted) {
      expect(workerId.startsWith(INSTANCE)).toBe(true);
    }
    // Scoping is by the provider_scope COLUMN, not by parsing the id. The id
    // contains colons of its own (`sync-worker:<pid>:<suffix>`), so a
    // positional split or a bare prefix match would both be wrong — and a
    // prefix match would additionally catch an unrelated worker whose id starts
    // with the same characters.
    const selects = sqlMock.mock.calls
      .map(([strings]) => (strings as string[]).join("?"))
      .filter((s) => s.includes("FROM sync_worker_heartbeats") && s.includes("SELECT"));
    expect(selects.some((s) => s.includes("provider_scope = 'all' AND worker_id ="))).toBe(true);
    expect(selects.some((s) => s.includes("|| ':' || provider_scope"))).toBe(true);
    expect(selects.every((s) => !s.includes("worker_id LIKE"))).toBe(true);
  });
});

describe("retire: the real stop SEQUENCE, not just the resulting state", () => {
  // The gap that shipped. Seeding rows with `all` already `stopping` models the
  // end state and proves nothing about how the database got there. In reality
  // the outgoing worker writes its own `stopping` on the way out, which
  // ADVANCES the `all` row's heartbeat — so a liveness check that runs before
  // the terminal short-circuit refuses the exact sequence this exists for.
  it("retires the lanes after the old worker's shutdown moved the all row", async () => {
    queueSql([[
      row("all", "idle", "2026-07-29T19:00:00.000Z"),
      row("meta", "running", "2026-07-29T19:00:01.000Z"),
      row("shopify", "idle", "2026-07-29T19:00:02.000Z"),
    ]]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    // The worker is stopped. Old-build shutdown retires `all` ONLY, and that
    // write moves its timestamp. The lane rows are left exactly as censused.
    queueSql([[
      row("all", "stopping", "2026-07-29T19:00:30.000Z"),
      row("meta", "running", "2026-07-29T19:00:01.000Z"),
      row("shopify", "idle", "2026-07-29T19:00:02.000Z"),
    ]]);
    const result = await retireStoppedSyncWorker({
      census, containerStopped: true, containerFinishedAt: LATE_FINISHED_AT, ...INSTANT,
    });
    expect(result.retiredWorkerIds.sort()).toEqual([
      `${INSTANCE}:meta`,
      `${INSTANCE}:shopify`,
    ]);
    expect(result.alreadyTerminalWorkerIds).toEqual([INSTANCE]);
  });

  // The steady state from the next upgrade onward: the new shutdown retires
  // every scope itself, so retirement arrives to find the work already done.
  it("is a no-op against a worker that retired every scope itself", async () => {
    queueSql([[
      row("all", "idle", "2026-07-29T19:00:00.000Z"),
      row("meta", "running", "2026-07-29T19:00:01.000Z"),
    ]]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    queueSql([[
      row("all", "stopping", "2026-07-29T19:00:31.000Z"),
      row("meta", "stopping", "2026-07-29T19:00:30.000Z"),
    ]]);
    const result = await retireStoppedSyncWorker({
      census, containerStopped: true, containerFinishedAt: LATE_FINISHED_AT, ...INSTANT,
    });
    expect(result.retiredWorkerIds).toEqual([]);
    expect(result.alreadyTerminalWorkerIds.sort()).toEqual([INSTANCE, `${INSTANCE}:meta`]);
  });

  // THE INCIDENT. A provider heartbeat legitimately advances after the census
  // and before the container reaches stopped, because a graceful shutdown keeps
  // beating while it finishes. Refusing that refuses every real graceful stop.
  it("accepts a provider heartbeat that advanced during the graceful stop", async () => {
    queueSql([[
      row("all", "idle", "2026-07-29T19:00:00.000Z"),
      row("meta", "running", "2026-07-29T19:00:01.000Z"),
    ]]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    // meta beat again at :29 — after the census, before the canonical :30.
    queueSql([[
      row("all", "stopping", "2026-07-29T19:00:30.000Z"),
      row("meta", "running", "2026-07-29T19:00:29.000Z"),
    ]]);
    const result = await retireStoppedSyncWorker({
      census, containerStopped: true, containerFinishedAt: LATE_FINISHED_AT, ...INSTANT,
    });
    expect(result.retiredWorkerIds).toEqual([`${INSTANCE}:meta`]);
    // Both rows moved during the stop — the lane because it was still beating,
    // the canonical row because the shutdown wrote it. Both are inside the window.
    expect(result.diagnostics.movedDuringGracefulStop).toContainEqual({
      workerId: `${INSTANCE}:meta`,
      from: "2026-07-29T19:00:01.000Z",
      to: "2026-07-29T19:00:29.000Z",
    });
  });

  // ...but only INSIDE the window. A write after the canonical shutdown write is
  // something other than this worker's shutdown.
  // The build being retired writes its canonical `stopping` FIRST and then keeps
  // working, so a lane row postdating the canonical write is normal and must be
  // accepted as long as it precedes the process's death.
  it("accepts a lane row that postdates the canonical shutdown write but precedes the exit", async () => {
    queueSql([[
      row("all", "idle", "2026-07-29T19:00:00.000Z"),
      row("meta", "running", "2026-07-29T19:00:01.000Z"),
    ]]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    queueSql([[
      row("all", "stopping", "2026-07-29T19:00:30.000Z"),
      row("meta", "running", "2026-07-29T19:00:31.000Z"),
    ]]);
    const result = await retireStoppedSyncWorker({
      census, containerStopped: true, containerFinishedAt: LATE_FINISHED_AT, ...INSTANT,
    });
    expect(result.retiredWorkerIds).toEqual([`${INSTANCE}:meta`]);
  });

  // And not after the process died, whatever the canonical row says.
  it("refuses a row that wrote after the container exited", async () => {
    queueSql([[
      row("all", "idle", "2026-07-29T19:00:00.000Z"),
      row("meta", "running", "2026-07-29T19:00:01.000Z"),
    ]]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    queueSql([[
      row("all", "stopping", "2026-07-29T19:00:30.000Z"),
      row("meta", "running", "2026-07-29T19:00:29.000Z"),
    ]]);
    await expect(
      retireStoppedSyncWorker({
        census, containerStopped: true,
        // The container exited BEFORE those writes.
        containerFinishedAt: "2026-07-29T19:00:10.000Z",
        clockSkewToleranceMs: 1_000,
        ...INSTANT,
      }),
    ).rejects.toThrow(/after the container exited/);
  });

  it("refuses when the canonical all row never reached a terminal state", async () => {
    queueSql([[
      row("all", "idle", "2026-07-29T19:00:00.000Z"),
      row("meta", "running", "2026-07-29T19:00:01.000Z"),
    ]]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    // Killed mid-tick: the shutdown path never ran to the end.
    queueSql([[
      row("all", "idle", "2026-07-29T19:00:05.000Z"),
      row("meta", "running", "2026-07-29T19:00:06.000Z"),
    ]]);
    await expect(
      retireStoppedSyncWorker({
        census, containerStopped: true, containerFinishedAt: LATE_FINISHED_AT, ...INSTANT,
      }),
    ).rejects.toThrow(/its shutdown did not complete/);
  });

  it("refuses when the container exit time is missing or unparseable", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    queueSql([incidentRows()]);
    await expect(
      retireStoppedSyncWorker({
        census, containerStopped: true, containerFinishedAt: "not-a-time", ...INSTANT,
      }),
    ).rejects.toThrow(/exit time is missing or unparseable/);
  });

  // The second, independent proof: nothing may write from the moment the bounds
  // were checked. Two full heartbeat periods of silence, observed not assumed.
  it("refuses when a row writes during the stability window", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    const moved = incidentRows().map((r) =>
      r.provider_scope === "meta" ? { ...r, last_heartbeat_at: "2026-07-29T17:49:54.000Z" } : r,
    );
    // Sample one, then a DIFFERENT sample two: something is still writing.
    queueSql([incidentRows(), moved]);
    await expect(
      retireStoppedSyncWorker({
        census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT,
      }),
    ).rejects.toThrow(/wrote during the .*stability window/);
  });

  it("derives the stability window from the heartbeat contract, not a constant", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    queueSql([incidentRows()]);
    const slept: number[] = [];
    const result = await retireStoppedSyncWorker({
      census, containerStopped: true, containerFinishedAt: FINISHED_AT,
      heartbeatIntervalMs: 7_000,
      sleep: async (ms) => { slept.push(ms); },
    });
    // Two full periods: a live worker must have written at least once.
    expect(slept).toEqual([14_000]);
    expect(result.diagnostics.stabilityWindowMs).toBe(14_000);
  });

  // Identity is checked ahead of the terminal short-circuit, so a different run
  // that happens to be terminal cannot be retired in the old one's name.
  it("refuses a terminal row belonging to a different run", async () => {
    queueSql([[row("all", "idle", "2026-07-29T19:00:00.000Z")]]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });

    queueSql([[
      {
        ...row("all", "stopping", "2026-07-29T19:00:30.000Z"),
        meta_json: { workerBuildId: NEW_BUILD, workerStartedAt: STARTED },
      },
    ]]);
    await expect(
      retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT }),
    ).rejects.toThrow(/now reports build/);
  });
});

describe("held work is what is in force, not what bears the name", () => {
  // The live-host finding. A checkpoint's `lease_owner` records who last
  // advanced it and is never cleared, so a real worker carries hundreds of
  // permanent NULL-expiry stamps — 185 meta and 161 google, measured. Gating on
  // those means no worker that has ever done work can be retired.
  it("retires a worker carrying hundreds of expired provenance stamps", async () => {
    getSyncWorkerOwnedWorkUnits.mockResolvedValue({
      ...NO_WORK,
      metaCheckpointClaims: 185,
      googleCheckpointClaims: 161,
    });
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, retireStoppedSyncWorker } = await load();
    const census = await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    queueSql([incidentRows()]);
    const result = await retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, ...INSTANT });

    expect(result.retiredWorkerIds).toHaveLength(3);
    // Held: nothing. Owned: reported, and deliberately not gating.
    expect(Object.values(result.heldWork).every((n) => n === 0)).toBe(true);
    expect(result.ownedWorkUnits.metaCheckpointClaims).toBe(185);
  });

  it("counts only unexpired leases as held", async () => {
    queueSql([incidentRows()]);
    const { captureOutgoingWorkerCensus, readHeldWorkForWorker } = await load();
    await captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    await readHeldWorkForWorker([`${INSTANCE}:meta`]);
    const held = sqlMock.mock.calls
      .map(([strings]) => (strings as string[]).join("?"))
      .filter((t) => t.includes("AS runner_leases"));
    expect(held).toHaveLength(1);
    // Every lease table is bounded by its expiry; job locks keep their status test.
    expect(held[0].match(/lease_expires_at > now\(\)/g) ?? []).toHaveLength(6);
    expect(held[0]).toContain("status = 'running'");
  });

  it("leaves the shared owned-work helper untouched for the staged predicate", async () => {
    const { readHeldWorkForWorker } = await load();
    queueSql([[]]);
    await readHeldWorkForWorker([]);
    // An empty id list short-circuits without querying, exactly as the shared
    // helper does, so the staged predicate's contract is unchanged.
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("the bounded wait for a lease to lapse", () => {
  it("returns as soon as the rows reach zero, without waiting", async () => {
    const { waitForHeldWorkToClear } = await load();
    let t = 0;
    const result = await waitForHeldWorkToClear({
      workerIds: [`${INSTANCE}:meta`],
      timeoutMs: 120_000,
      now: () => t,
      sleep: async () => { t += 5_000; },
    });
    expect(result.cleared).toBe(true);
    expect(result.waitedMs).toBe(0);
  });

  it("clears once the lease lapses, and reports how long it waited", async () => {
    HELD_WORK = { ...HELD_WORK, runner_leases: 1 };
    const { waitForHeldWorkToClear } = await load();
    let t = 0;
    let polls = 0;
    sqlMock.mockImplementation(() => {
      polls += 1;
      // The lease lapses on its own after the third look.
      return Promise.resolve([polls >= 3 ? { ...HELD_WORK, runner_leases: 0 } : HELD_WORK]);
    });
    const result = await waitForHeldWorkToClear({
      workerIds: [`${INSTANCE}:meta`],
      timeoutMs: 120_000,
      pollIntervalMs: 5_000,
      now: () => t,
      sleep: async (ms) => { t += ms; },
    });
    expect(result.cleared).toBe(true);
    expect(result.waitedMs).toBe(10_000);
  });

  // A deadline that passes is a refusal, not an acceptance. This is the whole
  // difference between waiting on a proof and sleeping instead of one.
  it("refuses when the lease is still in force at the deadline", async () => {
    HELD_WORK = { ...HELD_WORK, runner_leases: 1 };
    const { waitForHeldWorkToClear } = await load();
    let t = 0;
    sqlMock.mockImplementation(() => Promise.resolve([HELD_WORK]));
    const result = await waitForHeldWorkToClear({
      workerIds: [`${INSTANCE}:meta`],
      timeoutMs: 30_000,
      pollIntervalMs: 5_000,
      now: () => t,
      sleep: async (ms) => { t += ms; },
    });
    expect(result.cleared).toBe(false);
    expect(result.heldWork.runnerLeases).toBe(1);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30_000);
  });

  it("retirement surfaces the wait in its refusal", async () => {
    queueSql([incidentRows()]);
    const mod = await load();
    const census = await mod.captureOutgoingWorkerCensus({ runtimeInstanceId: INSTANCE });
    HELD_WORK = { ...HELD_WORK, runner_leases: 1 };
    queueSql([incidentRows()]);
    await expect(
      mod.retireStoppedSyncWorker({ census, containerStopped: true, containerFinishedAt: FINISHED_AT, waitForHeldWorkMs: 0, ...INSTANT }),
      // The elapsed figure is measured, not the configured budget: a machine
      // under load reports 1ms where an idle one reports 0. What the refusal
      // has to name is the lease it is refusing over and how long it waited,
      // and that is what is asserted.
    ).rejects.toThrow(/still holds runnerLeases=1 after \d+ms/);
  });
});
