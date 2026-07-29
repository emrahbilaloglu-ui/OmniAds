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
 *   - the worker owns no lease, claim, lock or job anywhere.
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
  | "concurrent_write";

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

function metaString(metaJson: unknown, key: string): string | null {
  if (!metaJson || typeof metaJson !== "object") return null;
  const value = (metaJson as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Every heartbeat row belonging to one runtime instance.
 *
 * A worker's rows are `<workerId>` for the `all` scope and `<workerId>::<scope>`
 * for the rest, so the instance owns exactly the rows whose id is the bare id or
 * begins with it followed by the separator. Matching on a bare prefix would also
 * catch an unrelated worker whose id happens to start with the same characters,
 * which is why the separator is part of the pattern.
 */
async function readRowsForInstance(runtimeInstanceId: string) {
  const sql = getDb();
  return (await sql`
    SELECT worker_id, provider_scope, status, last_heartbeat_at, meta_json
      FROM sync_worker_heartbeats
     WHERE worker_id = ${runtimeInstanceId}
        OR worker_id LIKE ${runtimeInstanceId + "::%"}
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
  const rows = (await sql`
    SELECT DISTINCT split_part(worker_id, '::', 1) AS runtime_instance_id
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
  ownedWorkUnits: Record<string, number>;
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
}): Promise<RetirementResult> {
  const { census } = input;
  if (!input.containerStopped) {
    throw new WorkerRetirementRefusal(
      "row_moved",
      "the caller did not assert that the outgoing container is stopped; retiring a live worker's rows would hide a worker that is still doing work",
      { runtimeInstanceId: census.runtimeInstanceId },
    );
  }
  if (census.rows.length === 0) {
    throw new WorkerRetirementRefusal("census_empty", "the census records no rows", {});
  }

  const live = await readRowsForInstance(census.runtimeInstanceId);
  const liveByWorkerId = new Map(live.map((row) => [String(row.worker_id), row]));

  // A scope that exists now but was not censused means the process wrote after
  // the capture — it is not gone.
  const censusIds = new Set(census.rows.map((row) => row.workerId));
  const unexpected = live.filter((row) => !censusIds.has(String(row.worker_id)));
  if (unexpected.length > 0) {
    throw new WorkerRetirementRefusal(
      "scope_census_mismatch",
      `${census.runtimeInstanceId} has ${unexpected.length} heartbeat row(s) the census did not record, so it was still writing after the capture`,
      { unexpected: unexpected.map((row) => String(row.worker_id)) },
    );
  }

  const owned = await getSyncWorkerOwnedWorkUnits(census.rows.map((row) => row.workerId));
  const held = Object.entries(owned).filter(([, count]) => Number(count) !== 0);
  if (held.length > 0) {
    throw new WorkerRetirementRefusal(
      "worker_holds_work",
      `${census.runtimeInstanceId} still holds ${held.map(([k, v]) => `${k}=${v}`).join(", ")}; a worker holding work is not retired, it is unfinished`,
      { ownedWorkUnits: owned },
    );
  }

  const toRetire: WorkerScopeCensusRow[] = [];
  const alreadyTerminal: string[] = [];
  for (const row of census.rows) {
    const liveRow = liveByWorkerId.get(row.workerId);
    if (!liveRow) {
      throw new WorkerRetirementRefusal(
        "row_missing",
        `${row.workerId} no longer exists; the census does not describe this database any more`,
        { workerId: row.workerId },
      );
    }
    const liveHeartbeat = isoOrNull(liveRow.last_heartbeat_at);
    if (liveHeartbeat !== row.lastHeartbeatAt) {
      throw new WorkerRetirementRefusal(
        "row_moved",
        `${row.workerId} has beaten since the census (${row.lastHeartbeatAt} -> ${liveHeartbeat}); the worker is alive`,
        { workerId: row.workerId, censusHeartbeatAt: row.lastHeartbeatAt, liveHeartbeatAt: liveHeartbeat },
      );
    }
    // A run that reused the worker id is a DIFFERENT worker. Retiring it in the
    // old one's name is the cross-run retirement this binding exists to stop.
    const liveBuildId = metaString(liveRow.meta_json, "workerBuildId");
    if (census.buildId != null && liveBuildId != null && liveBuildId !== census.buildId) {
      throw new WorkerRetirementRefusal(
        "build_identity_mismatch",
        `${row.workerId} now reports build ${liveBuildId}, the census recorded ${census.buildId}`,
        { workerId: row.workerId, liveBuildId, censusBuildId: census.buildId },
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
        { workerId: row.workerId, liveStartedAt, censusStartedAt: census.workerStartedAt },
      );
    }
    if (TERMINAL_STATUSES.has(String(liveRow.status))) {
      alreadyTerminal.push(row.workerId);
      continue;
    }
    toRetire.push(row);
  }

  const sql = getDb();
  const retired: string[] = [];
  for (const row of toRetire) {
    // Guarded on the censused timestamp: if the worker wrote between the check
    // above and this statement, zero rows match and the refusal below fires
    // instead of the write silently landing on a live worker.
    //
    // `last_heartbeat_at` is deliberately NOT advanced. It records when the
    // worker last actually beat, and moving it would both destroy that and make
    // a departed worker look freshly alive to every other reader.
    //
    // Compared at MILLISECOND resolution on both sides. `timestamptz` keeps
    // microseconds, but the census reaches this point via a JavaScript Date,
    // which has only milliseconds — so a plain equality guard compares a
    // truncated value against an untruncated one and never matches, and every
    // retirement refuses as a phantom concurrent write. Truncating both sides
    // costs nothing that matters: heartbeats are fifteen seconds apart, so a
    // worker that has genuinely beaten again moves this value by far more than
    // a millisecond and is still refused.
    const updated = (await sql`
      UPDATE sync_worker_heartbeats
         SET status = 'stopping',
             updated_at = now()
       WHERE worker_id = ${row.workerId}
         AND date_trunc('milliseconds', last_heartbeat_at)
           = date_trunc('milliseconds', ${row.lastHeartbeatAt}::timestamptz)
       RETURNING worker_id
    `) as Array<Record<string, unknown>>;
    if (updated.length !== 1) {
      throw new WorkerRetirementRefusal(
        "concurrent_write",
        `${row.workerId} changed while it was being retired; nothing further was written`,
        { workerId: row.workerId, retiredSoFar: retired },
      );
    }
    retired.push(row.workerId);
  }

  return {
    runtimeInstanceId: census.runtimeInstanceId,
    retiredWorkerIds: retired,
    alreadyTerminalWorkerIds: alreadyTerminal,
    ownedWorkUnits: owned,
  };
}
