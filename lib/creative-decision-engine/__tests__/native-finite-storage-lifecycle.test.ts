import { describe, expect, it, vi } from "vitest";
import { FENCED_TABLES, type DbGrowthFenceDecision } from "@/lib/sync/db-growth-fence";
import type { NativeStorageMaintenanceEvidence, NativeStorageOperation } from "@/lib/sync/native-storage-maintenance-admission";
import { NATIVE_STORAGE_BATCH_CONTRACT, runFiniteNativeStorageBatch, validateNativeStorageBatchPlan,
  type NativeStorageBatchBackend, type NativeStorageBatchJournal, type NativeStorageBatchPlan,
  type NativeStorageBatchResult, type NativeStorageBatchResume, type NativeStorageStage, type NativeStorageStageReceipt,
  nativeStoragePlanDigest, nativeStorageBatchSchedule } from "../native-finite-storage-lifecycle";

const GiB = 1024 ** 3, clock = () => Date.parse("2026-10-05T04:29:00Z"), at = new Date(clock()).toISOString();
const plan = (): NativeStorageBatchPlan => ({ contract: NATIVE_STORAGE_BATCH_CONTRACT,
  purpose: "123456789abc", targetRevision: "d".repeat(40), sourceManifestSha256: "a".repeat(64),
  actualSourceReviewSha256: "b".repeat(64), expectedDatabaseBudgetBytes: 163 * GiB, cutoffObservedAt: at,
  units: [1, 2].map(n => ({ generation: { jobRunId: `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`,
    businessId: "12345678-1234-1234-1234-000000000010", asOfDate: "2026-10-03", engineVersion: "actual_epoch" },
  evaluations: n === 1 ? 702 : 1134, contexts: n, originalProofSha256: "c".repeat(64) })) });

function fixture() {
  const p = plan(), events: string[] = [], receipts: NativeStorageStageReceipt[] = [];
  let final: NativeStorageBatchResult | undefined, consumed = false;
  const journal: NativeStorageBatchJournal = {
    async begin() { if (consumed) throw Error("PURPOSE_ALREADY_CONSUMED_STATUS_ONLY"); consumed = true; events.push("begin"); },
    async intent(stage, jobs) { events.push(`intent:${stage}:${jobs.length}`); },
    async receipt(r) { events.push(`receipt:${r.stage}:${r.jobRunIds.length}`); receipts.push(r); },
    async finish(r) { final = r; events.push("finish"); },
  };
  const business: DbGrowthFenceDecision = { allowed: false, reason: "database_budget_exceeded", warning: false,
    databaseBytes: 163 * GiB + 1145879, databaseBudgetBytes: 163 * GiB,
    tableBytes: Object.fromEntries(FENCED_TABLES.map(n => [n, 0])),
    tableBudgetBytes: Object.fromEntries(FENCED_TABLES.map(n => [n, 32 * GiB])),
    offender: { table: "database", bytes: 163 * GiB + 1145879, budget: 163 * GiB },
    evaluatedAt: at, errorMessage: null, overridden: false, physical: { admitted: true, reason: "ok",
      snapshotId: "measured", sampledAt: at, ageSeconds: 0, maxAgeSeconds: 300, dataPath: "/actual/data",
      totalBytes: 250 * GiB, usedBytes: 200 * GiB, availableBytes: 50 * GiB, minimumFreeBytes: 40 * GiB,
      projectedFreeBytes: 50 * GiB, detail: "owned fixture" } };
  const evidence = (op: NativeStorageOperation): NativeStorageMaintenanceEvidence => ({ operation: op, observedAt: at,
    sourceManifestSha256: p.sourceManifestSha256, actualSourceReviewSha256: p.actualSourceReviewSha256,
    sourceMatches: true, exactRolesAndReaderRootMatch: true, unknownDatabaseConsumers: 0, nativeProducerIdle: true,
    originalRows: 1134, originalContexts: 2, serializedArchiveBytes: 2048,
    appVolume: { observedAt: at, availableBytes: 10 * GiB, minimumFreeBytes: 2 * GiB },
    walVolume: { observedAt: at, availableBytes: 50 * GiB, minimumFreeBytes: 40 * GiB },
    independentOriginalRestoreMatches: true, completeOriginalCopiesMatch: true, freshHistoricalHttpMatches: true,
    selectedPinClosureMatches: true, alreadyAbsentWithEnforcedLineage: true });
  const backend: NativeStorageBatchBackend = {
    async freshEvidence(op, units) { events.push(`fresh:${op}:${units.length}`); return { business,
      evidence: { ...evidence(op), originalRows: Math.max(...units.map(u => u.evaluations)),
        originalContexts: Math.max(...units.map(u => u.contexts)) } }; },
    async execute(stage, units) { events.push(`execute:${stage}:${units.length}`); return {
      purpose: p.purpose, stage, jobRunIds: units.map(u => u.generation.jobRunId), actualExitCode: 0,
      actionAcknowledged: true, independentFullOriginalBytesMatch: true, providerAuthority: false,
      reclaimedBytes: 0, evidenceSha256: "e".repeat(64) }; },
  };
  return { p, events, receipts, journal, backend, business, getFinal: () => final };
}
async function pausedFixture() {
  const f = fixture(), fresh = f.backend.freshEvidence;
  f.backend.freshEvidence = async (op, units, signal) => {
    const value = await fresh(op, units, signal);
    if (op === "retire-original") value.evidence.freshHistoricalHttpMatches = false;
    return value;
  };
  const paused = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
  expect(paused.actualExitCode).toBe(1); expect(paused.statusReadOnlyRequired).toBe(false);
  const resume: NativeStorageBatchResume = { contract: "finite-native-storage-resume.v1", purpose: f.p.purpose,
    planSha256: nativeStoragePlanDigest(f.p), startedAt: at, acknowledgedReceipts: [...f.receipts], unacknowledgedIntent: null };
  f.journal.begin = async () => resume;
  f.backend.freshEvidence = fresh;
  f.backend.verifyAcknowledged = async () => { f.events.push("verify-previous-read-only"); return true; };
  f.events.length = 0;
  return { ...f, resume };
}
describe("finite native operator protocol (does not substitute for actual backend/PG proof)", () => {
  it("publishes/activates once, retires each original separately, and keeps business refused", async () => {
    const f = fixture(), before = JSON.stringify(f.business);
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(0); expect(r.retiredOriginalJobs).toHaveLength(2);
    expect(f.events.filter(s => s.startsWith("execute:publish"))).toEqual(["execute:publish:2"]);
    expect(f.events.filter(s => s.startsWith("execute:activate"))).toEqual(["execute:activate:2"]);
    expect(f.events.indexOf("receipt:activate:2")).toBeLessThan(f.events.indexOf("intent:retire:1"));
    expect(JSON.stringify(f.business)).toBe(before);
    expect(r.newWebOwnObservationRequired).toBe(true); expect(r.sustainableStorageClosed).toBe(false);
    for (const stage of ["capture-restore", "publish", "activate", "retire", "independent-readback",
      "vacuum-main", "toast-observation", "space-readback"]) expect(f.events.findIndex(s => s.startsWith(`intent:${stage}:`)))
      .toBeLessThan(f.events.findIndex(s => s.startsWith(`execute:${stage}:`)));
  });
  it("refuses missing fresh pins before retirement dispatch and durable intent", async () => {
    const f = fixture(), fresh = f.backend.freshEvidence;
    f.backend.freshEvidence = async (op, units, signal) => { const r = await fresh(op, units, signal);
      if (op === "retire-original") r.evidence.selectedPinClosureMatches = false; return r; };
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(1); expect(r.statusReadOnlyRequired).toBe(false);
    expect(f.events).not.toContain("intent:retire:1"); expect(f.events).not.toContain("execute:retire:1");
  });
  it("never repeats or proceeds beyond an ambiguous commit", async () => {
    const f = fixture(), execute = f.backend.execute;
    f.backend.execute = async (stage, units, signal) => {
      if (stage === "retire") { f.events.push("one-commit-reply-lost"); throw Error("COMMIT_REPLY_LOST"); }
      return execute(stage, units, signal);
    };
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(1); expect(r.statusReadOnlyRequired).toBe(true);
    expect(f.events.filter(s => s === "one-commit-reply-lost")).toHaveLength(1);
    expect(f.events).not.toContain("intent:independent-readback:1"); expect(f.events).not.toContain("intent:vacuum-main:2");
  });
  it("an activation failure cannot retire a single row", async () => {
    const f = fixture(), execute = f.backend.execute;
    f.backend.execute = async (stage, units, signal) => stage === "activate"
      ? { ...await execute(stage, units, signal), actualExitCode: 1 } : execute(stage, units, signal);
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(1); expect(r.statusReadOnlyRequired).toBe(true);
    expect(f.events).not.toContain("intent:retire:1");
  });
  it("a wrong original identity in a nominal success receipt is not success", async () => {
    const f = fixture(), execute = f.backend.execute;
    f.backend.execute = async (stage, units, signal) => ({ ...await execute(stage, units, signal), jobRunIds: [] });
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(1); expect(f.events).not.toContain("intent:publish:2");
  });
  it("a consumed purpose cannot dispatch again", async () => {
    const f = fixture(); await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    const count = f.events.length, r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(1); expect(f.events).toHaveLength(count);
  });
  it("main vacuum acknowledgement cannot conceal a failed read-only TOAST observation", async () => {
    const f = fixture(), execute = f.backend.execute;
    f.backend.execute = async (stage, units, signal) => stage === "toast-observation"
      ? { ...await execute(stage, units, signal), actionAcknowledged: false, actualExitCode: 1 }
      : execute(stage, units, signal);
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(1); expect(r.stage).toBe("toast-observation");
    expect(f.events).not.toContain("intent:space-readback:2");
  });
  it("ends a hung stage with its abort signal and records status-only", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let aborted = false;
      f.backend.execute = async (_stage, _units, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(Error("OWN_CHILD_ABORTED")); }, { once: true });
      });
      const pending = runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
      await vi.advanceTimersByTimeAsync(300001);
      const r = await pending; expect(aborted).toBe(true); expect(r.actualExitCode).toBe(1);
      expect(r.statusReadOnlyRequired).toBe(true); expect(f.getFinal()).toEqual(r);
    } finally { vi.useRealTimers(); }
  });
  it.each(["duplicates", "current-day", "oversized", "false-clock"])("refuses %s before journal creation", async kind => {
    const f = fixture();
    if (kind === "duplicates") f.p.units[1] = f.p.units[0]!;
    if (kind === "current-day") f.p.units[0]!.generation.asOfDate = "2026-10-05";
    if (kind === "oversized") f.p.units[0]!.evaluations = 1135;
    if (kind === "false-clock") f.p.cutoffObservedAt = "2026-10-06T00:00:00Z";
    await expect(runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock)).rejects.toThrow();
    expect(f.events).toHaveLength(0);
  });
  it("accepts a genuine old date but rejects a normalized non-date", () => {
    const p = plan(); p.units[0]!.generation.asOfDate = "2026-02-30";
    expect(() => validateNativeStorageBatchPlan(p)).toThrow("CLOSED_DAY_WORST_OFFSET_BUFFER");
  });
  it("resumes only the undispatched retirement after read-only verification, without reactivating", async () => {
    const f = await pausedFixture();
    const result = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(result.actualExitCode).toBe(0); expect(result.retiredOriginalJobs).toHaveLength(2);
    expect(result.newWebOwnObservationRequired).toBe(true);
    expect(f.events.filter(e => /execute:(capture-restore|publish|activate)/.test(e))).toEqual([]);
    expect(f.events[0]).toBe("verify-previous-read-only");
    expect(f.events.indexOf("verify-previous-read-only")).toBeLessThan(f.events.indexOf("intent:retire:1"));
    expect(f.events.filter(e => e === "execute:retire:1")).toHaveLength(2);
  });
  it.each(["missing-prefix", "wrong-plan", "unacknowledged", "completed", "expired", "verification-failed"])
    ("refuses %s resume without any new action", async kind => {
      const f = await pausedFixture();
      if (kind === "missing-prefix") f.resume.acknowledgedReceipts.splice(2, 1);
      if (kind === "wrong-plan") f.resume.planSha256 = "f".repeat(64);
      if (kind === "unacknowledged") Object.assign(f.resume, { unacknowledgedIntent: { stage: "retire" } });
      if (kind === "completed") f.resume.acknowledgedReceipts = nativeStorageBatchSchedule(f.p).map(s => ({
        purpose: f.p.purpose, stage: s.stage, jobRunIds: s.units.map(u => u.generation.jobRunId), actualExitCode: 0,
        actionAcknowledged: true, independentFullOriginalBytesMatch: true, providerAuthority: false,
        reclaimedBytes: 0, evidenceSha256: "e".repeat(64) }));
      if (kind === "expired") {
        f.p.cutoffObservedAt = "2026-10-05T03:58:00Z";
        f.resume.planSha256 = nativeStoragePlanDigest(f.p); f.resume.startedAt = "2026-10-05T03:59:00Z";
      }
      if (kind === "verification-failed") f.backend.verifyAcknowledged = async () => false;
      const result = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
      expect(result.actualExitCode).toBe(1); expect(result.statusReadOnlyRequired).toBe(true);
      expect(f.events.some(e => e.startsWith("intent:") || e.startsWith("execute:"))).toBe(false);
    });
  it("aborts a stalled fresh gate before any stage intent or mutation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let aborted = false;
      f.backend.freshEvidence = async (_op, _units, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(Error("OWN_GATE_ABORTED")); }, { once: true });
      });
      const pending = runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
      await vi.advanceTimersByTimeAsync(60001);
      const result = await pending;
      expect(aborted).toBe(true); expect(result.actualExitCode).toBe(1); expect(result.statusReadOnlyRequired).toBe(false);
      expect(f.events.some(e => e.startsWith("intent:") || e.startsWith("execute:"))).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("post-retirement TOAST observation replaces the bounded TOAST VACUUM dispatch", () => {
  it("schedules a read-only observation between main VACUUM and space readback, never a TOAST VACUUM", () => {
    const stages = nativeStorageBatchSchedule(plan()).map(s => s.stage);
    expect(stages.slice(-3)).toEqual(["vacuum-main", "toast-observation", "space-readback"]);
    expect(stages).not.toContain("vacuum-toast");
  });
  it("admits the observation under the read-only class and lets space readback run", async () => {
    const f = fixture();
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(0);
    const observe = f.events.indexOf("intent:toast-observation:2");
    expect(f.events[observe - 1]).toBe("fresh:read-original:2");
    expect(f.events.some(s => s.includes("vacuum-toast"))).toBe(false);
    expect(f.events.indexOf("execute:toast-observation:2")).toBeLessThan(f.events.indexOf("intent:space-readback:2"));
  });
  it("refuses a v1 plan explicitly instead of reinterpreting its TOAST VACUUM schedule", async () => {
    const f = fixture(), v1 = { ...plan(), contract: "finite-native-storage-batch.v1" } as unknown as NativeStorageBatchPlan;
    expect(() => validateNativeStorageBatchPlan(v1)).toThrow("RETIRED_V1_TOAST_VACUUM_SCHEDULE");
    await expect(runFiniteNativeStorageBatch(v1, f.journal, f.backend, clock)).rejects.toThrow("RETIRED_V1_TOAST_VACUUM_SCHEDULE");
    expect(f.events).toEqual([]);
  });
  it("never accepts an old TOAST VACUUM acknowledgement as an observation", async () => {
    const f = fixture(), schedule = nativeStorageBatchSchedule(f.p);
    const ack = (stage: NativeStorageStage, ids: string[]): NativeStorageStageReceipt => ({ purpose: f.p.purpose, stage, jobRunIds: ids,
      actualExitCode: 0, actionAcknowledged: true, independentFullOriginalBytesMatch: true, providerAuthority: false, reclaimedBytes: 0,
      evidenceSha256: "e".repeat(64) });
    const observe = schedule.findIndex(s => s.stage === "toast-observation");
    const acknowledgedReceipts = [...schedule.slice(0, observe).map(s => ack(s.stage, s.units.map(u => u.generation.jobRunId))),
      ack("vacuum-toast", f.p.units.map(u => u.generation.jobRunId))];
    f.journal.begin = async () => ({ contract: "finite-native-storage-resume.v1", purpose: f.p.purpose,
      planSha256: nativeStoragePlanDigest(f.p), startedAt: at, acknowledgedReceipts, unacknowledgedIntent: null });
    f.backend.verifyAcknowledged = async () => { f.events.push("verify"); return true; };
    const r = await runFiniteNativeStorageBatch(f.p, f.journal, f.backend, clock);
    expect(r.actualExitCode).toBe(1); expect(r.reason).toBe("RESUME_ACKNOWLEDGED_PREFIX_REQUIRED");
    expect(r.statusReadOnlyRequired).toBe(true);
    expect(f.events.filter(s => s.startsWith("intent:") || s.startsWith("execute:") || s === "verify")).toEqual([]);
  });
});
