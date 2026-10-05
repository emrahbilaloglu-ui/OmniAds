import { createHash } from "node:crypto";
import type { NativeArchiveGeneration } from "./native-evidence-archive";
import { assessNativeStorageMaintenanceAdmission, type NativeStorageMaintenanceEvidence,
  type NativeStorageOperation } from "@/lib/sync/native-storage-maintenance-admission";
import type { DbGrowthFenceDecision } from "@/lib/sync/db-growth-fence";

/** One finite operator batch, never a provider job. Publication and same-image
 * root activation happen once for the complete batch, before any retirement.
 * A journal intent is durable before every externally visible action. A
 * missing acknowledgement is status-only; this runner never repeats it. */
export const NATIVE_STORAGE_BATCH_CONTRACT = "finite-native-storage-batch.v1" as const;
export const NATIVE_STORAGE_BATCH_LIMITS = Object.freeze({ generations: 8, evaluationsPerGeneration: 1134,
  contextsPerGeneration: 4, evaluations: 9072, wallMilliseconds: 30 * 60_000 });
export type NativeStorageStage = "capture-restore" | "publish" | "activate" | "retire" |
  "independent-readback" | "vacuum-main" | "vacuum-toast" | "space-readback";
const operation: Record<NativeStorageStage, NativeStorageOperation> = {
  "capture-restore": "read-original", publish: "publish-original", activate: "activate-root",
  retire: "retire-original", "independent-readback": "read-original",
  "vacuum-main": "vacuum-main", "vacuum-toast": "vacuum-toast", "space-readback": "read-original",
};
export interface NativeStorageBatchUnit {
  generation: NativeArchiveGeneration;
  evaluations: number;
  contexts: number;
  /** Frozen full-byte original proof/config. No guessed IDs or row subset. */
  originalProofSha256: string;
}
export interface NativeStorageBatchPlan {
  contract: typeof NATIVE_STORAGE_BATCH_CONTRACT;
  purpose: string;
  targetRevision: string;
  sourceManifestSha256: string;
  actualSourceReviewSha256: string;
  expectedDatabaseBudgetBytes: number;
  cutoffObservedAt: string;
  units: NativeStorageBatchUnit[];
}
export interface NativeStorageStageReceipt {
  purpose: string;
  stage: NativeStorageStage;
  jobRunIds: string[];
  actualExitCode: number;
  actionAcknowledged: boolean;
  independentFullOriginalBytesMatch: boolean;
  providerAuthority: false;
  reclaimedBytes: 0;
  evidenceSha256: string;
}
export interface NativeStorageBatchBackend {
  /** Reads actual host/source/archive/capacity; no caller-supplied growthBytes. */
  freshEvidence(operation: NativeStorageOperation, units: NativeStorageBatchUnit[], signal: AbortSignal): Promise<{
    business: DbGrowthFenceDecision; evidence: NativeStorageMaintenanceEvidence;
  }>;
  execute(stage: NativeStorageStage, units: NativeStorageBatchUnit[], signal: AbortSignal): Promise<NativeStorageStageReceipt>;
  /** A resumed journal is not evidence of current host state. This must perform
   * actual read-only source/copy/root/original/receipt verification and restore
   * the backend's state, without executing any acknowledged action again. */
  verifyAcknowledged?(plan: NativeStorageBatchPlan, receipts: NativeStorageStageReceipt[], signal: AbortSignal): Promise<boolean>;
}
export interface NativeStorageBatchResume {
  contract: "finite-native-storage-resume.v1";
  purpose: string;
  planSha256: string;
  startedAt: string;
  acknowledgedReceipts: NativeStorageStageReceipt[];
  unacknowledgedIntent: null;
}
export interface NativeStorageBatchJournal {
  /** A fresh EXCL purpose, or an explicit verified unfinished journal. Resume
   * never grants permission to repeat an intent whose reply was lost. */
  begin(plan: NativeStorageBatchPlan): Promise<void | NativeStorageBatchResume>;
  intent(stage: NativeStorageStage, jobs: string[]): Promise<void>;
  receipt(receipt: NativeStorageStageReceipt): Promise<void>;
  finish(result: NativeStorageBatchResult): Promise<void>;
}
export interface NativeStorageBatchResult {
  contract: typeof NATIVE_STORAGE_BATCH_CONTRACT;
  purpose: string;
  actualExitCode: 0 | 1;
  stage: NativeStorageStage | null;
  reason: string;
  statusReadOnlyRequired: boolean;
  retiredOriginalJobs: string[];
  providerAuthority: false;
  physicalBytesReclaimed: 0;
  sustainableStorageClosed: false;
  newWebOwnObservationRequired: boolean;
}
const digest = (v: string) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: string) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const need = (v: unknown, code: string) => { if (!v) throw new Error(code); };
export const nativeStoragePlanDigest = (p: NativeStorageBatchPlan) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

export function nativeStorageBatchSchedule(plan: NativeStorageBatchPlan): { stage: NativeStorageStage; units: NativeStorageBatchUnit[] }[] {
  return [...plan.units.map(u => ({ stage: "capture-restore" as const, units: [u] })),
    { stage: "publish" as const, units: plan.units }, { stage: "activate" as const, units: plan.units },
    ...plan.units.flatMap(u => [{ stage: "retire" as const, units: [u] },
      { stage: "independent-readback" as const, units: [u] }]),
    { stage: "vacuum-main" as const, units: plan.units }, { stage: "vacuum-toast" as const, units: plan.units },
    { stage: "space-readback" as const, units: plan.units }];
}
function receiptMatches(receipt: NativeStorageStageReceipt, purpose: string, stage: NativeStorageStage, ids: string[]) {
  return receipt && receipt.purpose === purpose && receipt.stage === stage &&
    JSON.stringify(receipt.jobRunIds) === JSON.stringify(ids) && receipt.actualExitCode === 0 &&
    receipt.actionAcknowledged === true && receipt.independentFullOriginalBytesMatch === true &&
    receipt.providerAuthority === false && receipt.reclaimedBytes === 0 && digest(receipt.evidenceSha256);
}

export function validateNativeStorageBatchPlan(p: NativeStorageBatchPlan) {
  need(p.contract === NATIVE_STORAGE_BATCH_CONTRACT && /^[a-f0-9]{12}$/.test(p.purpose) &&
    /^[a-f0-9]{40}$/.test(p.targetRevision) && digest(p.sourceManifestSha256) &&
    digest(p.actualSourceReviewSha256) && Number.isSafeInteger(p.expectedDatabaseBudgetBytes) &&
    p.expectedDatabaseBudgetBytes > 0 && Number.isFinite(Date.parse(p.cutoffObservedAt)), "EXACT_BATCH_IDENTITY");
  need(Array.isArray(p.units) && p.units.length > 0 && p.units.length <= NATIVE_STORAGE_BATCH_LIMITS.generations,
    "FINITE_GENERATION_COUNT");
  const jobs = new Set<string>(); let total = 0;
  for (const u of p.units) {
    const g = u.generation;
    need(g && uuid(g.jobRunId) && uuid(g.businessId) && !jobs.has(g.jobRunId) && digest(u.originalProofSha256) &&
      typeof g.engineVersion === "string" && /^[a-zA-Z0-9_.-]{1,120}$/.test(g.engineVersion), "EXACT_ORIGINAL_GENERATION");
    const end = Date.parse(`${g.asOfDate}T00:00:00Z`) + 38 * 60 * 60_000;
    need(/^\d{4}-\d{2}-\d{2}$/.test(g.asOfDate) && Number.isFinite(end) &&
      new Date(end - 38 * 60 * 60_000).toISOString().slice(0, 10) === g.asOfDate &&
      end <= Date.parse(p.cutoffObservedAt), "CLOSED_DAY_WORST_OFFSET_BUFFER");
    need(Number.isInteger(u.evaluations) && u.evaluations > 0 && u.evaluations <= 1134 &&
      Number.isInteger(u.contexts) && u.contexts > 0 && u.contexts <= 4, "FINITE_ORIGINAL_POPULATION");
    total += u.evaluations; jobs.add(g.jobRunId);
  }
  need(total <= NATIVE_STORAGE_BATCH_LIMITS.evaluations, "FINITE_BATCH_POPULATION");
  return nativeStoragePlanDigest(p);
}

export async function runFiniteNativeStorageBatch(plan: NativeStorageBatchPlan,
  journal: NativeStorageBatchJournal, backend: NativeStorageBatchBackend,
  clock: () => number = Date.now): Promise<NativeStorageBatchResult> {
  validateNativeStorageBatchPlan(plan);
  const result: NativeStorageBatchResult = { contract: NATIVE_STORAGE_BATCH_CONTRACT, purpose: plan.purpose,
    actualExitCode: 1, stage: null, reason: "NOT_STARTED", statusReadOnlyRequired: false,
    retiredOriginalJobs: [], providerAuthority: false, physicalBytesReclaimed: 0,
    sustainableStorageClosed: false, newWebOwnObservationRequired: false };
  let started = clock(), dispatched = false, begun = false, resumeVerificationPending = false;
  need(Date.parse(plan.cutoffObservedAt) <= started, "FUTURE_BATCH_CUTOFF_REFUSED");
  const bounded = async <T>(action: (signal: AbortSignal) => Promise<T>, maximumMs: number, code: string): Promise<T> => {
    const remaining = NATIVE_STORAGE_BATCH_LIMITS.wallMilliseconds - (clock() - started);
    need(remaining > 0, "BATCH_DEADLINE");
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error(code)); }, Math.min(maximumMs, remaining));
    });
    try { return await Promise.race([action(abort.signal), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const step = async (stage: NativeStorageStage, units: NativeStorageBatchUnit[]) => {
    result.stage = stage; dispatched = false;
    need(clock() - started < NATIVE_STORAGE_BATCH_LIMITS.wallMilliseconds, "BATCH_DEADLINE");
    const fresh = await bounded(signal => backend.freshEvidence(operation[stage], units, signal), 60_000, "FRESH_GATE_DEADLINE");
    const decision = assessNativeStorageMaintenanceAdmission({ ...fresh,
      expectedDatabaseBudgetBytes: plan.expectedDatabaseBudgetBytes, nowMs: clock() });
    need(fresh.evidence.sourceManifestSha256 === plan.sourceManifestSha256 &&
      fresh.evidence.actualSourceReviewSha256 === plan.actualSourceReviewSha256 &&
      fresh.evidence.operation === operation[stage] &&
      fresh.evidence.originalRows === Math.max(...units.map(u => u.evaluations)) &&
      fresh.evidence.originalContexts === Math.max(...units.map(u => u.contexts)) && decision.admitted,
    `MAINTENANCE_REFUSED:${decision.issues.join(",")}`);
    const ids = units.map(u => u.generation.jobRunId);
    await journal.intent(stage, ids);
    // The intent is durable. Never repeat this call after a lost reply.
    dispatched = true;
    const receipt = await bounded(signal => backend.execute(stage, units, signal), 300_000, "STAGE_DEADLINE_STATUS_ONLY");
    need(receiptMatches(receipt, plan.purpose, stage, ids), "ACTUAL_STAGE_RECEIPT_REQUIRED");
    await journal.receipt(receipt); dispatched = false;
    need(clock() - started < NATIVE_STORAGE_BATCH_LIMITS.wallMilliseconds, "BATCH_DEADLINE");
  };
  try {
    const resume = await journal.begin(plan); begun = true;
    const schedule = nativeStorageBatchSchedule(plan); let completed = 0;
    if (resume) {
      resumeVerificationPending = true;
      need(resume.contract === "finite-native-storage-resume.v1" && resume.purpose === plan.purpose &&
        resume.planSha256 === nativeStoragePlanDigest(plan) && resume.unacknowledgedIntent === null &&
        Array.isArray(resume.acknowledgedReceipts) && resume.acknowledgedReceipts.length < schedule.length,
      "EXACT_UNFINISHED_RESUME_REQUIRED");
      const originalStart = Date.parse(resume.startedAt);
      need(Number.isFinite(originalStart) && originalStart >= Date.parse(plan.cutoffObservedAt) &&
        originalStart <= clock() && clock() - originalStart < NATIVE_STORAGE_BATCH_LIMITS.wallMilliseconds,
      "RESUME_CANNOT_RESET_DEADLINE");
      started = originalStart;
      for (const [i, r] of resume.acknowledgedReceipts.entries()) {
        const previous = schedule[i]!;
        need(receiptMatches(r, plan.purpose, previous.stage, previous.units.map(u => u.generation.jobRunId)),
          "RESUME_ACKNOWLEDGED_PREFIX_REQUIRED");
      }
      need(typeof backend.verifyAcknowledged === "function" &&
        await bounded(signal => backend.verifyAcknowledged!(plan, resume.acknowledgedReceipts, signal),
          60_000, "RESUME_VERIFICATION_DEADLINE") === true, "RESUME_READ_ONLY_VERIFICATION_REQUIRED");
      resumeVerificationPending = false; completed = resume.acknowledgedReceipts.length;
      for (const previous of schedule.slice(0, completed)) {
        if (previous.stage === "activate") result.newWebOwnObservationRequired = true;
        if (previous.stage === "independent-readback") result.retiredOriginalJobs.push(previous.units[0]!.generation.jobRunId);
      }
    }
    for (const next of schedule.slice(completed)) {
      await step(next.stage, next.units);
      if (next.stage === "activate") result.newWebOwnObservationRequired = true;
      if (next.stage === "independent-readback") result.retiredOriginalJobs.push(next.units[0]!.generation.jobRunId);
    }
    result.actualExitCode = 0; result.reason = "FINITE_BATCH_ACKNOWLEDGED_NOT_GLOBAL_STORAGE_ACCEPTANCE";
  } catch (error) {
    result.reason = error instanceof Error && /^[A-Z0-9_,:-]{1,300}$/i.test(error.message)
      ? error.message : "BOUNDED_STAGE_REFUSED_OR_AMBIGUOUS";
    result.statusReadOnlyRequired = dispatched || resumeVerificationPending;
  }
  if (begun) await journal.finish(result);
  return result;
}
