/**
 * The EVIDENCE chain, not the predicate.
 *
 * The incident: a rehearsal reported PASSED while its own extraction had failed.
 * The verbose health payload passed 64 KiB, the shell capture truncated it, the
 * JSON parse raised, `staged_worker_id` came out empty, the next command tried
 * to run `/var/www/adsecute/-c`, and the script still printed RESULT=PASSED. The
 * checker's exit code was 0, and that was allowed to stand for the whole proof.
 *
 * These tests are about the artifact and its verification. A proof that cannot
 * detect its own truncation is not a proof.
 */
import { describe, expect, it } from "vitest";
import {
  COMPACT_SUMMARY_SCHEMA_VERSION,
  buildCompactStagedSummary,
  evaluateWorkerHealth,
  selectStagedWorkers,
  verifyCompactStagedProof,
  type WorkerHealthRow,
} from "@/lib/sync/staged-worker-predicate";

const BUILD = "e3bc29ca6a0eb23e6a7bfbbcd2fa39549e7d421c";
const OTHER = "8de30c461c51d3e76e7cd5cc4fb71984751d014e";
const NOW = Date.UTC(2026, 6, 30, 0, 5, 30);
const CONTAINER_STARTED_AT = new Date(NOW - 30_000).toISOString();
const STAGED_ID = "sync-worker:47:dyprv17d";

const ZERO_WORK = {
  runnerLeases: 0,
  googleLaneLeases: 0,
  metaPartitionClaims: 0,
  googlePartitionClaims: 0,
  metaCheckpointClaims: 0,
  googleCheckpointClaims: 0,
  jobLocks: 0,
};

function stagedRow(overrides: Partial<WorkerHealthRow> = {}): WorkerHealthRow {
  return {
    workerId: STAGED_ID,
    providerScope: "all",
    status: "disabled",
    workerFreshnessState: "staged",
    lastHeartbeatAt: new Date(NOW - 2_000).toISOString(),
    metaJson: {
      stagingIdle: true,
      workerBuildId: BUILD,
      workerStartedAt: new Date(NOW - 25_000).toISOString(),
      runtimeContract: { buildId: BUILD },
    },
    ...overrides,
  };
}

/** The compact artifact a passing staged proof produces. */
function compact(over: { workers?: WorkerHealthRow[]; onlineWorkers?: number; owned?: Record<string, number> | null; runtime?: unknown } = {}) {
  const workers = over.workers ?? [stagedRow()];
  const staged = selectStagedWorkers({ workers, nowMs: NOW, onlineWindowMinutes: 5 });
  const owned = over.owned === undefined ? ZERO_WORK : over.owned;
  const evaluation = evaluateWorkerHealth({
    summary: {
      onlineWorkers: over.onlineWorkers ?? 0,
      lastHeartbeatAt: new Date(NOW - 2_000).toISOString(),
      workers,
    },
    stagedWorkers: staged,
    ownedWorkUnits: owned,
    expectStagedIdle: true,
    expectBuildId: BUILD,
    minHeartbeatAfter: CONTAINER_STARTED_AT,
    minOnlineWorkers: 1,
  });
  return buildCompactStagedSummary({
    generatedAt: new Date(NOW).toISOString(),
    evaluation,
    onlineWorkers: over.onlineWorkers ?? 0,
    onlineWindowMinutes: 5,
    expectBuildId: BUILD,
    minHeartbeatAfter: CONTAINER_STARTED_AT,
    stagedWorkerCount: staged.length,
    ownedWorkUnits: owned,
    runtimeInstance:
      over.runtime === undefined
        ? {
            instanceId: STAGED_ID,
            buildId: BUILD,
            healthState: "healthy",
            updatedAt: new Date(NOW - 1_000).toISOString(),
          }
        : (over.runtime as never),
  });
}

function verify(summary: unknown, extra: Record<string, unknown> = {}) {
  return verifyCompactStagedProof({
    summary,
    expectBuildId: BUILD,
    minHeartbeatAfter: CONTAINER_STARTED_AT,
    ...extra,
  });
}

describe("the artifact is bounded, whatever the fleet looks like", () => {
  // THE CAUSE. The verbose payload embeds every heartbeat row; on the real host
  // it passed 64 KiB and the capture truncated it mid-string.
  it("stays tiny even when the verbose payload would exceed 64 KiB", () => {
    const crowd: WorkerHealthRow[] = [stagedRow()];
    for (let i = 0; i < 400; i += 1) {
      crowd.push({
        workerId: `sync-worker:${i}:noise`,
        providerScope: "meta",
        status: "stopped",
        workerFreshnessState: "stopped",
        lastHeartbeatAt: new Date(NOW - 600_000).toISOString(),
        metaJson: {
          // The kind of bulk the real payload carries per row.
          consumeStage: "lifecycle_tick_succeeded".repeat(4),
          batchBusinessIds: Array.from({ length: 8 }, (_, n) => `biz-${i}-${n}`),
          runtimeContract: { buildId: OTHER, issueCodes: [] },
        },
      });
    }
    const verbose = JSON.stringify({ summary: { workers: crowd } });
    expect(verbose.length).toBeGreaterThan(65_536);

    const artifact = JSON.stringify(compact({ workers: crowd }), null, 2);
    expect(artifact.length).toBeLessThan(2_048);
    expect(verify(JSON.parse(artifact)).ok).toBe(true);
  });

  it("declares its own schema version so a future shape cannot be misread", () => {
    expect(compact().schemaVersion).toBe(COMPACT_SUMMARY_SCHEMA_VERSION);
    expect(verify({ ...compact(), schemaVersion: 99 }).failures.join(" ")).toMatch(
      /unexpected schemaVersion/,
    );
  });
});

describe("the verifier refuses a broken evidence chain", () => {
  it("accepts a complete, passing proof", () => {
    const result = verify(compact());
    expect(result).toEqual({ ok: true, failures: [] });
  });

  // Truncation, detected two ways: by byte count and by an unparseable document.
  it("refuses when fewer bytes were read than the writer wrote", () => {
    const result = verify(compact(), { observedBytes: 900, expectedBytes: 1_024 });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/truncated in transit: read 900 bytes/);
  });

  it("refuses a document that is not an object at all", () => {
    expect(verify("truncated string…").ok).toBe(false);
    expect(verify([1, 2, 3]).ok).toBe(false);
    expect(verify(null).failures.join(" ")).toMatch(/not a JSON object/);
  });

  // The exact symptom: an empty id that the old extractor produced and ignored.
  it("refuses an empty staged worker id", () => {
    for (const value of ["", "   ", null, undefined, 42]) {
      const result = verify({ ...compact(), stagedWorkerId: value });
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toMatch(/stagedWorkerId is missing or empty/);
    }
  });

  it("refuses when the staged row is missing or duplicated", () => {
    expect(verify(compact({ workers: [] })).failures.join(" ")).toMatch(/stagedWorkerCount is 0/);
    const duplicated = compact({
      workers: [stagedRow(), stagedRow({ workerId: "sync-worker:47:other" })],
    });
    expect(verify(duplicated).failures.join(" ")).toMatch(/stagedWorkerCount is 2/);
  });

  it("refuses when the runtime row is missing", () => {
    const result = verify(compact({ runtime: null }));
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/runtimeInstance is missing/);
  });

  it("refuses when the runtime row names a different build than the heartbeat", () => {
    const result = verify(
      compact({ runtime: { instanceId: STAGED_ID, buildId: OTHER, healthState: "healthy", updatedAt: null } }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/runtimeInstance.buildId is "8de30c46/);
  });

  // THE REJECTED ALTERNATIVE, kept as a regression.
  //
  // A writer once emitted health_state='staged'. The column is binary: the CHECK
  // admits 'healthy' and 'invalid', the single reader collapses everything that
  // is not 'healthy' into 'invalid', both consumers branch on === "healthy", and
  // production holds no third value — every such write was silently discarded by
  // a swallowed constraint violation. Widening the constraint was considered and
  // rejected on that evidence, so an artifact resting on a third value must be
  // refused rather than absorbed, and the refusal has to say why.
  it("refuses a runtime row carrying a health_state outside the binary contract", () => {
    for (const value of ["staged", "invalid", "", null, 1]) {
      const result = verify(
        compact({ runtime: { instanceId: STAGED_ID, buildId: BUILD, healthState: value, updatedAt: null } }),
      );
      expect(result.ok).toBe(false);
      expect(result.failures.join(" ")).toMatch(/healthState is [\s\S]*binary/);
    }
  });

  it("accepts the canonical 'healthy' for a staged worker, because process health is what the column means", () => {
    const result = verify(
      compact({
        runtime: {
          instanceId: STAGED_ID,
          buildId: BUILD,
          healthState: "healthy",
          updatedAt: new Date(NOW - 1_000).toISOString(),
        },
      }),
    );
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("refuses when the runtime row belongs to a different instance", () => {
    const result = verify(
      compact({ runtime: { instanceId: "sync-worker:99:elsewhere", buildId: BUILD, healthState: "healthy", updatedAt: null } }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/is not the staged worker/);
  });

  it("refuses a wrong build identity", () => {
    const wrong = compact({
      workers: [
        stagedRow({
          metaJson: {
            stagingIdle: true,
            workerBuildId: OTHER,
            workerStartedAt: new Date(NOW - 25_000).toISOString(),
            runtimeContract: { buildId: OTHER },
          },
        }),
      ],
    });
    expect(verify(wrong).ok).toBe(false);
  });

  it("refuses a start time that predates the container", () => {
    const early = compact({
      workers: [
        stagedRow({
          metaJson: {
            stagingIdle: true,
            workerBuildId: BUILD,
            workerStartedAt: new Date(NOW - 600_000).toISOString(),
            runtimeContract: { buildId: BUILD },
          },
        }),
      ],
    });
    const result = verify(early);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/precedes the container start/);
  });

  it("refuses when a worker is online", () => {
    const result = verify(compact({ onlineWorkers: 2 }));
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/onlineWorkers is 2, not 0/);
  });

  // Zero work has to be established, not merely asserted.
  it("refuses when the owned-work map is absent or non-zero", () => {
    expect(verify(compact({ owned: null })).failures.join(" ")).toMatch(
      /ownedWorkUnits is missing/,
    );
    expect(verify({ ...compact(), ownedWorkUnits: {} }).failures.join(" ")).toMatch(
      /ownedWorkUnits is empty/,
    );
    expect(
      verify({ ...compact(), ownedWorkUnits: { ...ZERO_WORK, jobLocks: 1 } }).failures.join(" "),
    ).toMatch(/ownedWorkUnits.jobLocks is 1, not 0/);
  });

  it("refuses a zero-work disagreement between the map and the flag", () => {
    const result = verify({ ...compact(), holdsNothing: false });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/holdsNothing is false while ownedWorkUnits reads zero/);
  });

  // The heart of it: the predicate saying "pass" cannot excuse a broken artifact,
  // and a broken artifact cannot be rescued by the checker's exit code.
  it("refuses an artifact whose fields are wrong even when it claims pass", () => {
    const lying = { ...compact(), stagedWorkerId: "", pass: true, reason: "healthy" };
    const result = verify(lying);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/stagedWorkerId is missing or empty/);
  });

  it("reports every shortfall at once rather than only the first", () => {
    const result = verify({
      ...compact(),
      stagedWorkerId: "",
      onlineWorkers: 3,
      runtimeInstance: null,
      runtimeInstanceMatchesStaged: false,
    });
    expect(result.failures.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the strict predicate is unchanged by any of this", () => {
  it("still refuses a staged worker under the ordinary online contract", () => {
    const result = evaluateWorkerHealth({
      summary: { onlineWorkers: 0, lastHeartbeatAt: new Date(NOW).toISOString(), workers: [stagedRow()] },
      stagedWorkers: [stagedRow()],
      ownedWorkUnits: null,
      expectStagedIdle: false,
      expectBuildId: null,
      minHeartbeatAfter: null,
      minOnlineWorkers: 1,
    });
    expect(result.reason).toBe("insufficient_online_workers");
  });

  it("still refuses staged mode when a worker is online", () => {
    const workers = [stagedRow()];
    const result = evaluateWorkerHealth({
      summary: { onlineWorkers: 1, lastHeartbeatAt: new Date(NOW).toISOString(), workers },
      stagedWorkers: selectStagedWorkers({ workers, nowMs: NOW, onlineWindowMinutes: 5 }),
      ownedWorkUnits: ZERO_WORK,
      expectStagedIdle: true,
      expectBuildId: BUILD,
      minHeartbeatAfter: CONTAINER_STARTED_AT,
      minOnlineWorkers: 1,
    });
    expect(result.reason).toBe("unexpected_online_workers");
  });
});
