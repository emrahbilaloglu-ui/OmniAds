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
  | "insufficient_online_workers"
  // Heartbeating but not sync-capable: every online worker's last business
  // cycle was refused for capacity, so the fleet is running and doing nothing.
  | "sync_capacity_refused";

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
  // True when every online worker's last cycle was refused for capacity. Always
  // reported, so the condition is visible even where it is not asserted.
  capacityRefused: boolean;
};

export function evaluateWorkerHealth(input: {
  summary: WorkerHealthSummaryView;
  stagedWorkers: WorkerHealthRow[];
  ownedWorkUnits: Record<string, number> | null;
  expectStagedIdle: boolean;
  expectBuildId: string | null;
  minHeartbeatAfter: string | null;
  minOnlineWorkers: number;
  // Opt-in: treat "heartbeating but capacity-refused" as a hard failure.
  // Off for the container probe, on for callers that can actually act.
  requireSyncCapable?: boolean;
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

  // Heartbeat liveness is not sync capability.
  //
  // Measured 2026-08-08: the worker reported healthy for 26 hours while every
  // business cycle was refused - meta_entity_state_history sat 208 KB over its
  // 4 GiB budget, the growth fence correctly fail-closed, and zero google or
  // meta runs were recorded the entire time. The gate saw a fresh heartbeat and
  // called that healthy, so a total sync stop was invisible to the one signal
  // whose job is to notice it.
  //
  // Capacity refusal specifically, NOT generic admission refusal: a not-due or
  // lease-contended tick is ordinary and transient, whereas a capacity refusal
  // persists until an operator or a retention policy acts. The worker preserves
  // the original refusal identity in consumeReason, so the distinction is
  // already durable in the heartbeat.
  //
  // This never fails the CONTAINER probe on its own - see requireSyncCapable
  // below. Restarting a container cannot free a byte of disk, so failing the
  // probe here would hand autoheal an unfixable condition and produce exactly
  // the restart loop this codebase forbids.
  const onlineWorkers = (input.summary.workers ?? []).filter(
    (worker) => worker.workerFreshnessState === "online",
  );
  const capacityRefused =
    onlineWorkers.length > 0 &&
    onlineWorkers.every(
      (worker) => readMetaString(worker.metaJson, "consumeReason") === "capacity_refused",
    );

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
  } else if (capacityRefused) {
    reason = "sync_capacity_refused";
  } else {
    reason = "healthy";
  }

  // A capacity refusal is reported always and asserted only on request. The
  // container probe stays green so autoheal does not thrash against a
  // condition no restart can clear; the operational callers that CAN act on it
  // - post-deploy verification and monitoring - pass requireSyncCapable and get
  // a hard failure. Silent it is not: the reason travels in every payload.
  const pass =
    reason === "healthy" ||
    (reason === "sync_capacity_refused" && !input.requireSyncCapable);

  return {
    pass,
    reason,
    stagedWorkerId: stagedWorker?.workerId ?? null,
    stagedWorkerStartedAt: stagedStartedAt,
    stagedWorkerBuildId: stagedBuildId,
    stagedWorkerContractBuildId: stagedContractBuildId,
    stagedIsThisRun,
    stagedBuildIdMatches,
    heartbeatSatisfied,
    holdsNothing,
    capacityRefused,
  };
}

/**
 * The staged worker's own row in `sync_runtime_instances`.
 *
 * Read here so the compact summary is self-contained: the heartbeat metadata and
 * the runtime row are written by different code paths, and a proof that quotes
 * only one of them cannot show they agree.
 */
export async function readStagedRuntimeInstance(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>,
  instanceId: string,
): Promise<{ instanceId: string; buildId: string | null; healthState: string | null; updatedAt: string | null } | null> {
  const rows = await sql`
    SELECT instance_id, build_id, health_state, updated_at
      FROM sync_runtime_instances
     WHERE instance_id = ${instanceId}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    instanceId: String(row.instance_id),
    buildId: row.build_id == null ? null : String(row.build_id),
    healthState: row.health_state == null ? null : String(row.health_state),
    updatedAt: row.updated_at == null ? null : new Date(String(row.updated_at)).toISOString(),
  };
}

/** Every field of the compact summary. Bounded by construction: no arrays of rows. */
export const COMPACT_SUMMARY_SCHEMA_VERSION = 1;

/**
 * A bounded, machine-readable statement of the staged predicate.
 *
 * The verbose payload embeds every heartbeat row and grows past 64 KiB on a real
 * host. A caller that pipes that through a shell capture gets a truncated
 * document, and a truncated document that is then parsed leniently — or parsed
 * strictly by a step whose failure is not propagated — turns a broken extraction
 * into a green result. That happened: JSON parsing raised, the staged worker id
 * came out empty, and the rehearsal still printed PASSED.
 *
 * So the proof gets its own artifact: small, fixed-shape, and containing exactly
 * the fields a caller must check. It carries no row arrays, so its size does not
 * grow with the fleet.
 */
export function buildCompactStagedSummary(input: {
  generatedAt: string;
  evaluation: WorkerHealthEvaluation;
  onlineWorkers: number;
  onlineWindowMinutes: number;
  expectBuildId: string | null;
  minHeartbeatAfter: string | null;
  stagedWorkerCount: number;
  ownedWorkUnits: Record<string, number> | null;
  runtimeInstance: Awaited<ReturnType<typeof readStagedRuntimeInstance>>;
}) {
  const e = input.evaluation;
  const runtime = input.runtimeInstance;
  return {
    schemaVersion: COMPACT_SUMMARY_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    pass: e.pass,
    reason: e.reason,
    onlineWindowMinutes: input.onlineWindowMinutes,
    expectBuildId: input.expectBuildId,
    minHeartbeatAfter: input.minHeartbeatAfter,
    stagedWorkerCount: input.stagedWorkerCount,
    stagedWorkerId: e.stagedWorkerId,
    stagedWorkerStartedAt: e.stagedWorkerStartedAt,
    stagedWorkerBuildId: e.stagedWorkerBuildId,
    stagedWorkerContractBuildId: e.stagedWorkerContractBuildId,
    stagedIsThisRun: e.stagedIsThisRun,
    stagedBuildIdMatches: e.stagedBuildIdMatches,
    heartbeatSatisfied: e.heartbeatSatisfied,
    holdsNothing: e.holdsNothing,
    onlineWorkers: input.onlineWorkers,
    ownedWorkUnits: input.ownedWorkUnits,
    runtimeInstance: runtime,
    // The heartbeat metadata and the runtime row must name the same build, or the
    // two writers disagree about which release is staged.
    runtimeInstanceMatchesStaged:
      runtime != null &&
      e.stagedWorkerId != null &&
      runtime.instanceId === e.stagedWorkerId &&
      runtime.buildId != null &&
      runtime.buildId === e.stagedWorkerBuildId,
  };
}

/**
 * Independently verify a compact staged proof, or say exactly why not.
 *
 * The checker's exit code is not evidence on its own. The rehearsal that
 * "passed" had the checker exit 0 while its own extraction raised, produced an
 * empty worker id, and printed PASSED anyway — a proof chain that fails open. So
 * the artifact is verified here field by field, against the same expectations the
 * caller pinned, and every shortfall is named rather than summarised.
 *
 * This is a pure function so each refusal can be asserted without a database, a
 * container or a host.
 */
export function verifyCompactStagedProof(input: {
  summary: unknown;
  expectBuildId: string;
  minHeartbeatAfter: string;
  /** Bytes actually read, checked against the artifact's own declared length. */
  observedBytes?: number;
  expectedBytes?: number;
  requirePass?: boolean;
}): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  const requirePass = input.requirePass ?? true;

  if (
    input.observedBytes != null &&
    input.expectedBytes != null &&
    input.observedBytes !== input.expectedBytes
  ) {
    fail(
      `artifact truncated in transit: read ${input.observedBytes} bytes, the writer reported ${input.expectedBytes}`,
    );
  }

  if (input.summary == null || typeof input.summary !== "object" || Array.isArray(input.summary)) {
    fail("the proof artifact is not a JSON object");
    return { ok: false, failures };
  }
  const s = input.summary as Record<string, unknown>;

  if (s.schemaVersion !== COMPACT_SUMMARY_SCHEMA_VERSION) {
    fail(
      `unexpected schemaVersion ${JSON.stringify(s.schemaVersion)}; this verifier understands ${COMPACT_SUMMARY_SCHEMA_VERSION}`,
    );
  }

  const str = (key: string): string | null =>
    typeof s[key] === "string" && (s[key] as string).trim().length > 0 ? (s[key] as string) : null;

  if (requirePass) {
    if (s.pass !== true) fail(`pass is ${JSON.stringify(s.pass)}, not true`);
    if (s.reason !== "healthy") fail(`reason is ${JSON.stringify(s.reason)}, not "healthy"`);
  }
  if (s.stagedWorkerCount !== 1) {
    fail(`stagedWorkerCount is ${JSON.stringify(s.stagedWorkerCount)}, not exactly 1`);
  }

  // The failure that started this: an empty id read as success.
  const stagedWorkerId = str("stagedWorkerId");
  if (stagedWorkerId == null) fail("stagedWorkerId is missing or empty");

  const startedAt = str("stagedWorkerStartedAt");
  if (startedAt == null) {
    fail("stagedWorkerStartedAt is missing or empty");
  } else {
    const startedMs = new Date(startedAt).getTime();
    const boundMs = new Date(input.minHeartbeatAfter).getTime();
    if (!Number.isFinite(startedMs)) fail(`stagedWorkerStartedAt ${startedAt} is not a timestamp`);
    else if (!Number.isFinite(boundMs)) fail(`minHeartbeatAfter ${input.minHeartbeatAfter} is not a timestamp`);
    else if (startedMs < boundMs) {
      fail(`stagedWorkerStartedAt ${startedAt} precedes the container start ${input.minHeartbeatAfter}`);
    }
  }

  for (const key of ["stagedWorkerBuildId", "stagedWorkerContractBuildId"] as const) {
    const value = str(key);
    if (value !== input.expectBuildId) {
      fail(`${key} is ${JSON.stringify(s[key])}, expected ${input.expectBuildId}`);
    }
  }
  if (s.stagedIsThisRun !== true) fail(`stagedIsThisRun is ${JSON.stringify(s.stagedIsThisRun)}`);
  if (s.stagedBuildIdMatches !== true) {
    fail(`stagedBuildIdMatches is ${JSON.stringify(s.stagedBuildIdMatches)}`);
  }
  if (s.onlineWorkers !== 0) fail(`onlineWorkers is ${JSON.stringify(s.onlineWorkers)}, not 0`);

  // Zero-work has to be stated AND agreed: a null owned-work map with
  // holdsNothing true would be a vacuous pass.
  const owned = s.ownedWorkUnits;
  if (owned == null || typeof owned !== "object" || Array.isArray(owned)) {
    fail("ownedWorkUnits is missing; zero work was never established");
  } else {
    const entries = Object.entries(owned as Record<string, unknown>);
    if (entries.length === 0) fail("ownedWorkUnits is empty; zero work was never established");
    for (const [key, value] of entries) {
      if (typeof value !== "number") fail(`ownedWorkUnits.${key} is not a number`);
      else if (value !== 0) fail(`ownedWorkUnits.${key} is ${value}, not 0`);
    }
    if (s.holdsNothing !== true) {
      fail(`holdsNothing is ${JSON.stringify(s.holdsNothing)} while ownedWorkUnits reads zero`);
    }
  }

  // The runtime row is written by a different code path than the heartbeat
  // metadata, so a proof quoting only one cannot show they agree.
  const runtime = s.runtimeInstance;
  if (runtime == null || typeof runtime !== "object" || Array.isArray(runtime)) {
    fail("runtimeInstance is missing; sync_runtime_instances was never corroborated");
  } else {
    const r = runtime as Record<string, unknown>;
    if (r.instanceId !== stagedWorkerId) {
      fail(`runtimeInstance.instanceId ${JSON.stringify(r.instanceId)} is not the staged worker ${JSON.stringify(stagedWorkerId)}`);
    }
    if (r.buildId !== input.expectBuildId) {
      fail(`runtimeInstance.buildId is ${JSON.stringify(r.buildId)}, expected ${input.expectBuildId}`);
    }
    // `health_state` is binary. A row reading anything else means a value was
    // written that the schema does not admit and no reader distinguishes — which
    // is how staged runtime rows were being discarded unnoticed.
    if (r.healthState !== "healthy") {
      fail(
        `runtimeInstance.healthState is ${JSON.stringify(r.healthState)}; this column is binary and a staged worker's process health is 'healthy' — staging is proven by the disabled/all heartbeat and the run identity, not here`,
      );
    }
  }
  if (s.runtimeInstanceMatchesStaged !== true) {
    fail(`runtimeInstanceMatchesStaged is ${JSON.stringify(s.runtimeInstanceMatchesStaged)}`);
  }

  return { ok: failures.length === 0, failures };
}
