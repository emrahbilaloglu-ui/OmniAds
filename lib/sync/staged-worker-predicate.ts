/**
 * What `deploy-disabled` is actually asserting, as a pure function.
 *
 * The phase brings the release up with every lane off and then has to decide,
 * from `sync_worker_heartbeats` alone, whether THIS run of THIS build is alive
 * and holding nothing. Every one of those words is load-bearing, and each was
 * missing at least once:
 *
 *  - "this run"   — a `disabled` row from an earlier epoch has the same status
 *                   and scope forever, so a worker that never came up at all
 *                   could be certified by its own predecessor.
 *  - "this build" — docker-compose interpolates APP_BUILD_ID from the host and
 *                   `environment:` overrides the image's own copy, so a stale
 *                   env file renames the running build without changing it.
 *  - "alive"      — freshness was read from MAX(last_heartbeat_at) across the
 *                   whole table, which any other worker could satisfy.
 *
 * Keeping this out of the CLI is what lets the cases be asserted without a
 * database, including the ones that must REFUSE.
 */

export type WorkerHealthRow = {
  workerId: string;
  providerScope: string;
  status: string;
  workerFreshnessState?: string | null;
  lastHeartbeatAt?: string | null;
  metaJson?: Record<string, unknown> | null;
};

export type WorkerHealthSummaryView = {
  onlineWorkers: number;
  lastHeartbeatAt: string | null;
  workers?: WorkerHealthRow[] | null;
};

export type WorkerHealthReason =
  | "healthy"
  | "staged_idle_not_observed"
  | "unexpected_online_workers"
  | "staged_worker_holds_work"
  | "staged_worker_is_not_this_run"
  | "staged_worker_build_identity_mismatch"
  | "fresh_heartbeat_not_observed"
  | "insufficient_online_workers";

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function readMetaString(
  metaJson: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metaJson?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The build id the RUNTIME CONTRACT recorded, which is what
 * `sync_runtime_instances` carries. Read separately from
 * `metaJson.workerBuildId` on purpose: the two are written by different code
 * paths, and requiring both to equal the pinned target is what stops a worker
 * that resolved one identity for its own metadata and another for its runtime
 * row from looking consistent.
 */
export function readContractBuildId(
  metaJson: Record<string, unknown> | null | undefined,
): string | null {
  const contract = metaJson?.runtimeContract;
  if (!contract || typeof contract !== "object") return null;
  return readMetaString(contract as Record<string, unknown>, "buildId");
}

/**
 * The staged registrations, which is a strictly smaller set than "rows whose
 * status is disabled".
 *
 * `workerFreshnessState === "staged"` is derived from the status alone, so it
 * stays true for a row that has not been written to in weeks. A staged worker
 * has to be fresh, and it has to be the canonical `all`-scope singleton — a
 * per-provider `disabled` row would change the count without ever being the
 * registration the gate is looking for.
 */
export function selectStagedWorkers(input: {
  workers: WorkerHealthRow[] | null | undefined;
  nowMs: number;
  onlineWindowMinutes: number;
}): WorkerHealthRow[] {
  const windowStartMs = input.nowMs - input.onlineWindowMinutes * 60_000;
  return (input.workers ?? []).filter((worker) => {
    if (worker.status !== "disabled") return false;
    if (worker.workerFreshnessState !== "staged") return false;
    if (worker.providerScope !== "all") return false;
    const heartbeatMs = parseMs(worker.lastHeartbeatAt);
    return heartbeatMs != null && heartbeatMs > windowStartMs;
  });
}

export type WorkerHealthEvaluation = {
  pass: boolean;
  reason: WorkerHealthReason;
  stagedWorkerId: string | null;
  stagedWorkerStartedAt: string | null;
  stagedWorkerBuildId: string | null;
  stagedWorkerContractBuildId: string | null;
  stagedIsThisRun: boolean;
  stagedBuildIdMatches: boolean;
  heartbeatSatisfied: boolean;
  holdsNothing: boolean;
};

export function evaluateWorkerHealth(input: {
  summary: WorkerHealthSummaryView;
  stagedWorkers: WorkerHealthRow[];
  ownedWorkUnits: Record<string, number> | null;
  expectStagedIdle: boolean;
  expectBuildId: string | null;
  minHeartbeatAfter: string | null;
  minOnlineWorkers: number;
}): WorkerHealthEvaluation {
  const minHeartbeatAfterMs =
    input.minHeartbeatAfter != null ? parseMs(input.minHeartbeatAfter) : null;
  if (input.minHeartbeatAfter != null && minHeartbeatAfterMs == null) {
    throw new Error("invalid ISO timestamp for --min-heartbeat-after");
  }

  const lastHeartbeatMs = parseMs(input.summary.lastHeartbeatAt);
  const heartbeatSatisfied =
    minHeartbeatAfterMs == null ||
    (lastHeartbeatMs != null && lastHeartbeatMs >= minHeartbeatAfterMs);

  const holdsNothing =
    input.ownedWorkUnits == null ||
    Object.values(input.ownedWorkUnits).every((count) => count === 0);

  // Everything below is about the ONE staged worker, not about the fleet.
  const stagedWorker = input.stagedWorkers.length === 1 ? input.stagedWorkers[0] : null;
  const stagedHeartbeatMs = parseMs(stagedWorker?.lastHeartbeatAt);
  const stagedStartedAt = readMetaString(stagedWorker?.metaJson, "workerStartedAt");
  const stagedStartedAtMs = parseMs(stagedStartedAt);
  const stagedBuildId = readMetaString(stagedWorker?.metaJson, "workerBuildId");
  const stagedContractBuildId = readContractBuildId(stagedWorker?.metaJson);

  // The staged row belongs to a process that started AFTER the container did.
  // Without this a `disabled` row written by the previous container — same
  // status, same scope, still inside the window — satisfies the gate while the
  // new worker never came up at all.
  const stagedIsThisRun =
    minHeartbeatAfterMs == null ||
    (stagedHeartbeatMs != null &&
      stagedHeartbeatMs >= minHeartbeatAfterMs &&
      stagedStartedAtMs != null &&
      stagedStartedAtMs >= minHeartbeatAfterMs);

  // The identity the orchestrator pinned, required from BOTH writers.
  const stagedBuildIdMatches =
    input.expectBuildId == null ||
    (stagedBuildId === input.expectBuildId &&
      stagedContractBuildId === input.expectBuildId);

  let reason: WorkerHealthReason;
  if (input.expectStagedIdle) {
    if (input.stagedWorkers.length !== 1) reason = "staged_idle_not_observed";
    else if (input.summary.onlineWorkers > 0) reason = "unexpected_online_workers";
    else if (!holdsNothing) reason = "staged_worker_holds_work";
    else if (!stagedIsThisRun) reason = "staged_worker_is_not_this_run";
    else if (!stagedBuildIdMatches) reason = "staged_worker_build_identity_mismatch";
    else if (!heartbeatSatisfied) reason = "fresh_heartbeat_not_observed";
    else reason = "healthy";
  } else if (input.summary.onlineWorkers < input.minOnlineWorkers) {
    reason = "insufficient_online_workers";
  } else if (!heartbeatSatisfied) {
    reason = "fresh_heartbeat_not_observed";
  } else {
    reason = "healthy";
  }

  return {
    pass: reason === "healthy",
    reason,
    stagedWorkerId: stagedWorker?.workerId ?? null,
    stagedWorkerStartedAt: stagedStartedAt,
    stagedWorkerBuildId: stagedBuildId,
    stagedWorkerContractBuildId: stagedContractBuildId,
    stagedIsThisRun,
    stagedBuildIdMatches,
    heartbeatSatisfied,
    holdsNothing,
  };
}
