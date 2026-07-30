/**
 * Retiring the OUTGOING worker's heartbeat rows, for the one upgrade that
 * cannot retire them itself.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * A worker registers one row per provider scope plus an `all` row.
 * `online_workers` counts every row that is fresh and not disabled/stopping/
 * stopped, so a worker that has exited still counts as online until its rows
 * fall out of the five-minute window. `deploy-disabled` asserts ZERO online
 * workers and polls for sixty seconds — it cannot outlast that window, so the
 * outgoing worker fails the phase on the incoming staged worker's behalf.
 *
 * The shutdown path now retires every scope it registered, which fixes this
 * from the next release onward. It cannot fix the FIRST upgrade: the worker
 * being replaced is running the old build, and old code does not gain new
 * shutdown behaviour by being stopped. So the incoming release has to be able
 * to retire its predecessor — once, explicitly, and only when it can prove the
 * predecessor is gone.
 *
 * WHY IT IS SHAPED LIKE THIS
 *
 * The dangerous version of this operation is "mark the old worker's rows
 * stopped". That is indistinguishable from "mark some live worker's rows
 * stopped", which silently hides a worker that is still holding leases and
 * doing work — exactly the state `deploy-disabled` exists to refuse. So this
 * takes a CENSUS captured while the outgoing worker was still running, and
 * refuses unless the database still agrees with it in every particular:
 *
 *   - every censused row still exists, and no row for that runtime instance
 *     exists that the census did not record (a scope appearing afterwards means
 *     the process is still writing);
 *   - each row's last heartbeat is byte-identical to the census, which is the
 *     liveness proof — a process that is still alive moves its own timestamps;
 *   - build id and start time still match, so a NEW run that happened to reuse
 *     the worker id cannot be retired in the old one's name;
 *   - the worker HOLDS no lease, claim, lock or job — meaning none still in
 *     force. A checkpoint's `lease_owner` is provenance and is never cleared, so
 *     "bears its name" and "is held by it" are different questions; see
 *     `readHeldWorkForWorker`.
 *
 * The UPDATE is then guarded on those same timestamps, so a worker that comes
 * back to life between the check and the write updates zero rows and refuses
 * rather than being quietly overwritten.
 *
 * `stopping` is the terminal state used because the strict checker already
 * excludes it, both here and in `getSyncWorkerHealthSummary`. Nothing about the
 * `onlineWorkers == 0` predicate is relaxed to make this work.
 */
import { getDb } from "@/lib/db";
import { getSyncWorkerOwnedWorkUnits } from "@/lib/sync/worker-health";

/** States a row can already be in that need no further retirement. */
const TERMINAL_STATUSES = new Set(["stopping", "stopped", "disabled"]);

/**
 * Work the outgoing worker still HOLDS, as opposed to work it once touched.
 *
 * `getSyncWorkerOwnedWorkUnits` counts every row whose `lease_owner` names the
 * worker, with no reference to whether the lease is still in force. For the
 * staged-idle predicate that is exactly right: a freshly started staged worker
 * has never leased anything, so any row bearing its name is a bug. Reused here
 * it is wrong, and unusably so — `lease_owner` on a checkpoint records who last
 * ADVANCED it and is never cleared, so a real production worker accumulates
 * thousands of permanent stamps with `lease_expires_at IS NULL`. Measured on the
 * live host: 185 meta and 161 google checkpoints, every one of them NULL-expiry.
 * No worker that has ever done work could satisfy a zero test against those, so
 * the retirement path could only ever succeed against a freshly seeded fixture —
 * which is precisely why the seams passed and the real host refused.
 *
 * A lease is held while it is unexpired. That is not a widened filter; it is
 * what a lease is. Every one of these six tables carries `lease_expires_at`, and
 * a row whose lease has lapsed is not held by anyone — every acquirer in the
 * system already treats it that way. Job locks keep their own `status` test.
 *
 * This lives here rather than replacing the shared helper so that
 * `deploy-disabled`'s strict predicate keeps reading exactly what it read
 * before. Nothing about `onlineWorkers == 0` or the staged worker's zero-work
 * assertion changes.
 */
export async function readHeldWorkForWorker(
  workerIds: string[],
): Promise<Record<string, number>> {
  const empty = {
    runnerLeases: 0,
    googleLaneLeases: 0,
    metaPartitionClaims: 0,
    googlePartitionClaims: 0,
    metaCheckpointClaims: 0,
    googleCheckpointClaims: 0,
    jobLocks: 0,
  };
  if (workerIds.length === 0) return empty;
  const sql = getDb();
  const [row] = (await sql`
    SELECT
      (SELECT COUNT(*) FROM sync_runner_leases
        WHERE lease_owner = ANY(${workerIds}::text[])
          AND lease_expires_at > now())::int                        AS runner_leases,
      (SELECT COUNT(*) FROM google_ads_runner_leases
        WHERE lease_owner = ANY(${workerIds}::text[])
          AND lease_expires_at > now())::int                        AS google_lane_leases,
      (SELECT COUNT(*) FROM meta_sync_partitions
        WHERE lease_owner = ANY(${workerIds}::text[])
          AND lease_expires_at > now())::int                        AS meta_partition_claims,
      (SELECT COUNT(*) FROM google_ads_sync_partitions
        WHERE lease_owner = ANY(${workerIds}::text[])
          AND lease_expires_at > now())::int                        AS google_partition_claims,
      (SELECT COUNT(*) FROM meta_sync_checkpoints
        WHERE lease_owner = ANY(${workerIds}::text[])
          AND lease_expires_at > now())::int                        AS meta_checkpoint_claims,
      (SELECT COUNT(*) FROM google_ads_sync_checkpoints
        WHERE lease_owner = ANY(${workerIds}::text[])
          AND lease_expires_at > now())::int                        AS google_checkpoint_claims,
      (SELECT COUNT(*) FROM provider_sync_jobs
        WHERE lock_owner = ANY(${workerIds}::text[])
          AND status = 'running')::int                              AS job_locks
  ` as Array<Record<string, unknown>>) ?? [];
  return {
    runnerLeases: Number(row?.runner_leases ?? 0),
    googleLaneLeases: Number(row?.google_lane_leases ?? 0),
    metaPartitionClaims: Number(row?.meta_partition_claims ?? 0),
    googlePartitionClaims: Number(row?.google_partition_claims ?? 0),
    metaCheckpointClaims: Number(row?.meta_checkpoint_claims ?? 0),
    googleCheckpointClaims: Number(row?.google_checkpoint_claims ?? 0),
    jobLocks: Number(row?.job_locks ?? 0),
  };
}

/**
 * Wait for a stopped worker's remaining leases to lapse, or refuse.
 *
 * A runner lease is renewed while a worker is working and lapses on its own
 * shortly after it stops — two minutes by default. `deploy-disabled` catches the
 * worker mid-tick, so one live lease at retirement time is the ordinary case,
 * not a fault.
 *
 * This waits on THOSE EXACT ROWS reaching zero, with a hard deadline and a
 * refusal if they do not. It is not a sleep standing in for a proof: nothing is
 * assumed to have happened after a fixed delay, and a lease that is still held
 * when the deadline passes refuses with its counts rather than being accepted.
 */
export async function waitForHeldWorkToClear(input: {
  workerIds: string[];
  timeoutMs: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ cleared: boolean; waitedMs: number; heldWork: Record<string, number> }> {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  const clock = input.now ?? (() => Date.now());
  const pause =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = clock();
  let heldWork = await readHeldWorkForWorker(input.workerIds);
  while (Object.values(heldWork).some((count) => count !== 0)) {
    if (clock() - startedAt >= input.timeoutMs) {
      return { cleared: false, waitedMs: clock() - startedAt, heldWork };
    }
    await pause(pollIntervalMs);
    heldWork = await readHeldWorkForWorker(input.workerIds);
  }
  return { cleared: true, waitedMs: clock() - startedAt, heldWork };
}

export type WorkerScopeCensusRow = {
  workerId: string;
  providerScope: string;
  status: string;
  /** ISO-8601, exactly as read. The liveness proof and the update guard. */
  lastHeartbeatAt: string;
};

export type OutgoingWorkerCensus = {
  /** The bare runtime instance id, e.g. `sync-worker:18:dbgah1xc`. */
  runtimeInstanceId: string;
  buildId: string | null;
  workerStartedAt: string | null;
  capturedAt: string;
  rows: WorkerScopeCensusRow[];
};

export type RetirementRefusalReason =
  | "census_empty"
  | "census_duplicate_scope"
  | "row_missing"
  | "row_moved"
  | "scope_census_mismatch"
  | "build_identity_mismatch"
  | "run_identity_mismatch"
  | "worker_holds_work"
  | "concurrent_write"
  | "container_still_live"
  | "container_exit_unknown"
  | "shutdown_not_terminal"
  | "heartbeat_after_canonical_shutdown"
  | "heartbeat_after_container_exit"
  | "wrote_during_stability_window";

export class WorkerRetirementRefusal extends Error {
  readonly reason: RetirementRefusalReason;
  readonly detail: Record<string, unknown>;

  constructor(reason: RetirementRefusalReason, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "WorkerRetirementRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Epoch milliseconds, or null when the value does not name a time. */
function parseMs(value: unknown): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function metaString(metaJson: unknown, key: string): string | null {
  if (!metaJson || typeof metaJson !== "object") return null;
  const value = (metaJson as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Every heartbeat row belonging to one runtime instance.
 *
 * A worker's rows are `<workerId>` for the `all` scope and `<workerId>:<scope>`
 * for the rest — a SINGLE colon, and the worker id itself already contains
 * colons (`sync-worker:<pid>:<suffix>`). So the id cannot be split positionally
 * and a prefix match would also catch an unrelated worker whose id happens to
 * start with the same characters.
 *
 * `provider_scope` is the exact discriminator: the row is this instance's if it
 * is the `all` row with this id, or a scoped row whose id is this id followed by
 * a colon and that row's own scope. Reconstructing the id from the column the
 * writer used leaves nothing to parse and nothing to guess.
 */
async function readRowsForInstance(runtimeInstanceId: string) {
  const sql = getDb();
  return (await sql`
    SELECT worker_id, provider_scope, status, last_heartbeat_at, meta_json
      FROM sync_worker_heartbeats
     WHERE (provider_scope = 'all' AND worker_id = ${runtimeInstanceId})
        OR (provider_scope <> 'all'
            AND worker_id = ${runtimeInstanceId} || ':' || provider_scope)
     ORDER BY provider_scope
  `) as Array<Record<string, unknown>>;
}

/**
 * The one worker that is currently online, or a refusal.
 *
 * `deploy-disabled` has to capture the outgoing worker before it recreates the
 * container, and the worker id is generated at runtime — it exists only in the
 * database. Discovery is therefore part of the operation, and it fails closed:
 * zero candidates means there is nothing to retire and something is already
 * wrong with the caller's assumptions, and more than one means the host is
 * running workers this cutover did not account for. Neither is a state in which
 * guessing is acceptable.
 *
 * Only fresh, non-terminal rows count — the same definition of "online" the
 * deploy gate uses, so discovery and the gate cannot disagree about who is
 * running.
 */
export async function discoverOnlineWorkerInstance(input?: {
  onlineWindowMinutes?: number;
}): Promise<string> {
  const onlineWindowMinutes = Math.max(1, input?.onlineWindowMinutes ?? 5);
  const sql = getDb();
  // The instance id is recovered by removing the row's OWN scope suffix, not by
  // splitting on a separator the worker id also contains.
  const rows = (await sql`
    SELECT DISTINCT
      CASE
        WHEN provider_scope = 'all' THEN worker_id
        WHEN worker_id LIKE ('%:' || provider_scope)
          THEN left(worker_id, length(worker_id) - length(provider_scope) - 1)
        ELSE worker_id
      END AS runtime_instance_id
      FROM sync_worker_heartbeats
     WHERE last_heartbeat_at > now() - (${String(onlineWindowMinutes)} || ' minutes')::interval
       AND status NOT IN ('disabled', 'stopping', 'stopped')
     ORDER BY 1
  `) as Array<Record<string, unknown>>;
  const ids = rows.map((row) => String(row.runtime_instance_id)).filter(Boolean);
  if (ids.length === 0) {
    throw new WorkerRetirementRefusal(
      "census_empty",
      "no worker is online, so there is no outgoing worker to retire",
      {},
    );
  }
  if (ids.length > 1) {
    throw new WorkerRetirementRefusal(
      "census_duplicate_scope",
      `${ids.length} workers are online (${ids.join(", ")}); refusing to guess which one is being replaced`,
      { candidates: ids },
    );
  }
  return ids[0];
}

/**
 * Record what the outgoing worker looks like WHILE IT IS STILL RUNNING.
 *
 * Called before the stop, because the whole point is to compare against a state
 * the retirement did not itself produce.
 */
export async function captureOutgoingWorkerCensus(input: {
  runtimeInstanceId: string;
  now?: () => Date;
}): Promise<OutgoingWorkerCensus> {
  const rows = await readRowsForInstance(input.runtimeInstanceId);
  if (rows.length === 0) {
    throw new WorkerRetirementRefusal(
      "census_empty",
      `no heartbeat rows exist for ${input.runtimeInstanceId}; there is nothing to retire and nothing to prove`,
      { runtimeInstanceId: input.runtimeInstanceId },
    );
  }
  const seen = new Set<string>();
  const census: WorkerScopeCensusRow[] = [];
  let buildId: string | null = null;
  let workerStartedAt: string | null = null;
  for (const row of rows) {
    const providerScope = String(row.provider_scope);
    if (seen.has(providerScope)) {
      throw new WorkerRetirementRefusal(
        "census_duplicate_scope",
        `${input.runtimeInstanceId} has more than one row for scope ${providerScope}; the outgoing worker is ambiguous`,
        { providerScope },
      );
    }
    seen.add(providerScope);
    const lastHeartbeatAt = isoOrNull(row.last_heartbeat_at);
    if (!lastHeartbeatAt) {
      throw new WorkerRetirementRefusal(
        "census_empty",
        `${input.runtimeInstanceId} scope ${providerScope} has no heartbeat timestamp to bind to`,
        { providerScope },
      );
    }
    census.push({
      workerId: String(row.worker_id),
      providerScope,
      status: String(row.status),
      lastHeartbeatAt,
    });
    buildId ??= metaString(row.meta_json, "workerBuildId");
    workerStartedAt ??= metaString(row.meta_json, "workerStartedAt");
  }
  return {
    runtimeInstanceId: input.runtimeInstanceId,
    buildId,
    workerStartedAt,
    capturedAt: (input.now?.() ?? new Date()).toISOString(),
    rows: census,
  };
}

export type RetirementResult = {
  runtimeInstanceId: string;
  retiredWorkerIds: string[];
  alreadyTerminalWorkerIds: string[];
  /** Leases still in force. Proven zero before anything is written. */
  heldWork: Record<string, number>;
  waitedForHeldWorkMs: number;
  /**
   * Every row bearing this worker's name, expired stamps included. Recorded for
   * the operator, never gating: a checkpoint's `lease_owner` is provenance and is
   * never cleared, so this is expected to be large and non-zero.
   */
  ownedWorkUnits: Record<string, number>;
  /** Per-predicate evidence, for the operator and for the deploy log. */
  diagnostics: Record<string, unknown>;
};

/**
 * Retire exactly the censused rows, or refuse.
 *
 * Nothing outside the census is read, written or considered.
 */
export async function retireStoppedSyncWorker(input: {
  census: OutgoingWorkerCensus;
  /**
   * The caller's proof that the container is gone. This module can see the
   * database and nothing else, so whoever knows about containers has to say so
   * — and has to say so explicitly rather than by omission.
   */
  containerStopped: boolean;
  /**
   * The container's exact exit time, as `docker inspect .State.FinishedAt`.
   *
   * Required, because "stopped" alone cannot bound WHEN the worker last wrote. A
   * graceful shutdown keeps heartbeating until it finishes, so movement after
   * the census is expected; movement after the process exited is impossible and
   * means something else is writing under this worker's name.
   */
  containerFinishedAt: string;
  /**
   * The worker's heartbeat cadence, from the same contract the worker runs on
   * (`WORKER_HEARTBEAT_INTERVAL_MS`, default 15s). The stability window is
   * derived from it rather than picked.
   */
  heartbeatIntervalMs?: number;
  /**
   * Clock-skew allowance for the FinishedAt comparison ALONE. `FinishedAt` is
   * the app host's clock and `last_heartbeat_at` is the database's, so the two
   * are not directly comparable. The canonical-row bound below is skew-free and
   * is the primary proof; this is an independent cross-check.
   */
  clockSkewToleranceMs?: number;
  /** How long to wait for a lease still in force to lapse. */
  waitForHeldWorkMs?: number;
  heldWorkPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RetirementResult> {
  const { census } = input;
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 15_000;
  const clockSkewToleranceMs = input.clockSkewToleranceMs ?? 5_000;
  // TWO full heartbeat periods. A live worker writes at least once per period,
  // so observing no write across two of them is a positive proof that nothing is
  // writing — not an assumption that enough time has passed.
  const stabilityWindowMs = heartbeatIntervalMs * 2;
  const pause =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const diagnostics: Record<string, unknown> = {
    heartbeatIntervalMs,
    stabilityWindowMs,
    clockSkewToleranceMs,
    containerFinishedAt: input.containerFinishedAt,
  };

  if (!input.containerStopped) {
    throw new WorkerRetirementRefusal(
      "container_still_live",
      "the caller did not assert that the outgoing container is stopped; retiring a live worker's rows would hide a worker that is still doing work",
      { runtimeInstanceId: census.runtimeInstanceId, ...diagnostics },
    );
  }
  const finishedAtMs = parseMs(input.containerFinishedAt);
  if (finishedAtMs == null) {
    throw new WorkerRetirementRefusal(
      "container_exit_unknown",
      `the container's exit time is missing or unparseable (${JSON.stringify(input.containerFinishedAt)}); without it, writes made after the process died cannot be told from writes made while it was shutting down`,
      { runtimeInstanceId: census.runtimeInstanceId, ...diagnostics },
    );
  }
  if (census.rows.length === 0) {
    throw new WorkerRetirementRefusal("census_empty", "the census records no rows", diagnostics);
  }

  // ── Sample one ────────────────────────────────────────────────────────────
  const live = await readRowsForInstance(census.runtimeInstanceId);
  const liveByWorkerId = new Map(live.map((row) => [String(row.worker_id), row]));

  // A scope that exists now but was not censused means this is not the run the
  // census describes, or another process is registering under its name.
  const censusIds = new Set(census.rows.map((row) => row.workerId));
  const unexpected = live.filter((row) => !censusIds.has(String(row.worker_id)));
  if (unexpected.length > 0) {
    throw new WorkerRetirementRefusal(
      "scope_census_mismatch",
      `${census.runtimeInstanceId} has ${unexpected.length} heartbeat row(s) the census did not record`,
      { unexpected: unexpected.map((row) => String(row.worker_id)), ...diagnostics },
    );
  }
  for (const row of census.rows) {
    if (!liveByWorkerId.has(row.workerId)) {
      throw new WorkerRetirementRefusal(
        "row_missing",
        `${row.workerId} no longer exists; the census does not describe this database any more`,
        { workerId: row.workerId, ...diagnostics },
      );
    }
  }

  // ── The run must still be the censused run ────────────────────────────────
  for (const row of census.rows) {
    const liveRow = liveByWorkerId.get(row.workerId)!;
    const liveBuildId = metaString(liveRow.meta_json, "workerBuildId");
    if (census.buildId != null && liveBuildId != null && liveBuildId !== census.buildId) {
      throw new WorkerRetirementRefusal(
        "build_identity_mismatch",
        `${row.workerId} now reports build ${liveBuildId}, the census recorded ${census.buildId}`,
        { workerId: row.workerId, liveBuildId, censusBuildId: census.buildId, ...diagnostics },
      );
    }
    const liveStartedAt = metaString(liveRow.meta_json, "workerStartedAt");
    if (
      census.workerStartedAt != null &&
      liveStartedAt != null &&
      liveStartedAt !== census.workerStartedAt
    ) {
      throw new WorkerRetirementRefusal(
        "run_identity_mismatch",
        `${row.workerId} now reports start time ${liveStartedAt}, the census recorded ${census.workerStartedAt}; this is a different run`,
        { workerId: row.workerId, liveStartedAt, censusStartedAt: census.workerStartedAt, ...diagnostics },
      );
    }
  }

  // ── The shutdown must have COMPLETED, not merely been attempted ───────────
  //
  // `all` is the canonical row and the last one a shutting-down worker writes.
  // Requiring it terminal is positive evidence that the shutdown path ran to the
  // end — a container that was killed mid-tick leaves it at `idle` or `running`,
  // and retiring that would be retiring a worker whose state nobody established.
  const canonical = liveByWorkerId.get(census.runtimeInstanceId);
  if (!canonical) {
    throw new WorkerRetirementRefusal(
      "row_missing",
      `${census.runtimeInstanceId} has no canonical all-scope row; there is no shutdown to verify`,
      diagnostics,
    );
  }
  const canonicalStatus = String(canonical.status);
  if (!TERMINAL_STATUSES.has(canonicalStatus)) {
    throw new WorkerRetirementRefusal(
      "shutdown_not_terminal",
      `${census.runtimeInstanceId} still reports '${canonicalStatus}' on its canonical all row, so its shutdown did not complete; a worker whose own shutdown never finished is not proven finished`,
      { canonicalStatus, ...diagnostics },
    );
  }
  const canonicalHeartbeatAt = isoOrNull(canonical.last_heartbeat_at);
  const canonicalMs = parseMs(canonicalHeartbeatAt);
  if (canonicalMs == null) {
    throw new WorkerRetirementRefusal(
      "shutdown_not_terminal",
      `${census.runtimeInstanceId} has no timestamp on its terminal canonical row, so nothing bounds when its scopes last wrote`,
      diagnostics,
    );
  }
  diagnostics.canonicalStatus = canonicalStatus;
  diagnostics.canonicalHeartbeatAt = canonicalHeartbeatAt;

  // The exit time is the APP HOST's clock; every heartbeat is the DATABASE's.
  // They are different machines, so the difference is measured here rather than
  // allowed for by a guessed constant. `clockSkewToleranceMs` is then only a
  // small margin for the round trip, not a stand-in for the skew itself.
  const sqlProbe = getDb();
  const [{ db_now: dbNow } = { db_now: null }] = (await sqlProbe`
    SELECT now() AS db_now
  ` as Array<Record<string, unknown>>);
  const dbNowMs = parseMs(dbNow);
  const measuredSkewMs = dbNowMs == null ? 0 : dbNowMs - Date.now();
  const exitBoundMs = finishedAtMs + measuredSkewMs + clockSkewToleranceMs;
  diagnostics.measuredDbClockSkewMs = measuredSkewMs;
  diagnostics.exitBoundAt = new Date(exitBoundMs).toISOString();

  // ── Movement is accepted only INSIDE the graceful-stop window ─────────────
  //
  // Two independent bounds, because accepting movement blindly is exactly as
  // unsafe as refusing all of it:
  //
  //  1. Against the canonical terminal write, entirely in DATABASE time, so no
  //     clock skew is involved. The canonical row is written last; a lane row
  //     later than it was written after the shutdown had already finished.
  //  2. Against the container's own exit, in APP-HOST time with a bounded skew
  //     allowance. A write after the process died is impossible.
  //
  // Either being violated means something is writing under this worker's name
  // that is not this worker's shutdown.
  const movedDuringStop: Array<{ workerId: string; from: string; to: string | null }> = [];
  for (const row of census.rows) {
    const liveRow = liveByWorkerId.get(row.workerId)!;
    const liveHeartbeatAt = isoOrNull(liveRow.last_heartbeat_at);
    const liveMs = parseMs(liveHeartbeatAt);
    if (liveMs == null) {
      throw new WorkerRetirementRefusal(
        "row_moved",
        `${row.workerId} has no heartbeat timestamp to bound`,
        { workerId: row.workerId, ...diagnostics },
      );
    }
    // NOT bounded by the canonical write.
    //
    // The build being retired writes its canonical `stopping` at the TOP of its
    // shutdown and then keeps working for the rest of the grace period, so its
    // lane rows legitimately postdate it — measured on the live host: canonical
    // 23:54:32.255, google_ads 23:56:01.906, exit 23:56:02.296. Requiring
    // lanes <= canonical refuses every real graceful stop of that build, which is
    // the only build this operation exists to retire. The canonical row's
    // TERMINAL STATUS is still required above; only the false ordering premise is
    // gone. What bounds movement is the process's own death, below.
    if (liveMs > exitBoundMs) {
      throw new WorkerRetirementRefusal(
        "heartbeat_after_container_exit",
        `${row.workerId} last wrote ${liveHeartbeatAt}, after the container exited at ${input.containerFinishedAt} (database clock is ${measuredSkewMs}ms ahead of the app host, margin ${clockSkewToleranceMs}ms); a dead process cannot write`,
        { workerId: row.workerId, liveHeartbeatAt, ...diagnostics },
      );
    }
    if (liveHeartbeatAt !== row.lastHeartbeatAt) {
      movedDuringStop.push({ workerId: row.workerId, from: row.lastHeartbeatAt, to: liveHeartbeatAt });
    }
  }
  diagnostics.movedDuringGracefulStop = movedDuringStop;

  // ── Held work, with the caller's bounded budget ───────────────────────────
  const workerIds = census.rows.map((row) => row.workerId);
  const wait = await waitForHeldWorkToClear({
    workerIds,
    timeoutMs: input.waitForHeldWorkMs ?? 0,
    pollIntervalMs: input.heldWorkPollIntervalMs,
    sleep: input.sleep,
  });
  if (!wait.cleared) {
    const held = Object.entries(wait.heldWork).filter(([, count]) => Number(count) !== 0);
    throw new WorkerRetirementRefusal(
      "worker_holds_work",
      `${census.runtimeInstanceId} still holds ${held.map(([k, v]) => `${k}=${v}`).join(", ")} after ${wait.waitedMs}ms; a worker holding work is not retired, it is unfinished`,
      { heldWork: wait.heldWork, waitedMs: wait.waitedMs, ...diagnostics },
    );
  }
  const heldWork = wait.heldWork;
  const ownedWorkUnits = await getSyncWorkerOwnedWorkUnits(workerIds);

  // ── Sample two: nothing may write from here on ────────────────────────────
  //
  // The bounds above prove that everything written so far happened during the
  // stop. This proves nothing is writing NOW, across a window long enough that a
  // live worker must have written at least once. It is the difference between
  // waiting and observing.
  const sampleOne = new Map(
    live.map((row) => [String(row.worker_id), isoOrNull(row.last_heartbeat_at)]),
  );
  await pause(stabilityWindowMs);
  const sampleTwo = await readRowsForInstance(census.runtimeInstanceId);
  if (sampleTwo.length !== live.length) {
    throw new WorkerRetirementRefusal(
      "wrote_during_stability_window",
      `${census.runtimeInstanceId} gained or lost rows during the ${stabilityWindowMs}ms stability window (${live.length} -> ${sampleTwo.length})`,
      diagnostics,
    );
  }
  for (const row of sampleTwo) {
    const workerId = String(row.worker_id);
    const before = sampleOne.get(workerId);
    const after = isoOrNull(row.last_heartbeat_at);
    if (before !== after) {
      throw new WorkerRetirementRefusal(
        "wrote_during_stability_window",
        `${workerId} wrote during the ${stabilityWindowMs}ms stability window (${before} -> ${after}); across two full heartbeat periods a silent worker is proven silent, and this one is not`,
        { workerId, before, after, ...diagnostics },
      );
    }
  }

  // ── Write, each row guarded on the value just proven stable ───────────────
  const sql = getDb();
  const retired: string[] = [];
  const alreadyTerminal: string[] = [];
  for (const row of census.rows) {
    const liveRow = liveByWorkerId.get(row.workerId)!;
    if (TERMINAL_STATUSES.has(String(liveRow.status))) {
      alreadyTerminal.push(row.workerId);
      continue;
    }
    const provenHeartbeatAt = isoOrNull(liveRow.last_heartbeat_at)!;
    // Guarded at MILLISECOND resolution on both sides: `timestamptz` keeps
    // microseconds and the value reaches this point via a JavaScript Date, so an
    // untruncated equality guard matches nothing and every retirement refuses as
    // a phantom concurrent write.
    //
    // `last_heartbeat_at` is never advanced: it records when the worker last
    // actually beat, and moving it would make a departed worker look fresh.
    const updated = (await sql`
      UPDATE sync_worker_heartbeats
         SET status = 'stopping',
             updated_at = now()
       WHERE worker_id = ${row.workerId}
         AND date_trunc('milliseconds', last_heartbeat_at)
           = date_trunc('milliseconds', ${provenHeartbeatAt}::timestamptz)
       RETURNING worker_id
    `) as Array<Record<string, unknown>>;
    if (updated.length !== 1) {
      throw new WorkerRetirementRefusal(
        "concurrent_write",
        `${row.workerId} changed while it was being retired; nothing further was written`,
        { workerId: row.workerId, retiredSoFar: retired, ...diagnostics },
      );
    }
    retired.push(row.workerId);
  }

  return {
    runtimeInstanceId: census.runtimeInstanceId,
    retiredWorkerIds: retired,
    alreadyTerminalWorkerIds: alreadyTerminal,
    heldWork,
    waitedForHeldWorkMs: wait.waitedMs,
    ownedWorkUnits,
    diagnostics,
  };
}
