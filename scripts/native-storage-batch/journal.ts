import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { NativeStorageBatchJournal, NativeStorageBatchPlan, NativeStorageBatchResult, NativeStorageBatchResume, NativeStorageStage,
  NativeStorageStageReceipt } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { nativeStoragePlanDigest } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { need, pad, privateDirectory, readExact, sha256, sortedEntries, writeExclusive } from "./common";

/** Durable, append-only batch journal. Every record is a NEW file written with
 * O_EXCL + fsync + directory fsync, and carries the digest of the previous
 * record. A purpose is consumed by an EXCL marker and can never run again. */
export const JOURNAL_CONTRACT = "finite-native-storage-journal.v1" as const;
type Kind = "begin" | "intent" | "receipt" | "finish" | "note" | "resume";
export class FileBatchJournal implements NativeStorageBatchJournal {
  private sequence = 0; private previous: string | null = null; private lastKind: Kind | null = null;
  /** mode "resume" is an explicit operator choice; it never creates a purpose. */
  constructor(private readonly directory: string, private readonly purposesRoot: string, private readonly mode: "fresh" | "resume" = "fresh") {}
  private async append(kind: Kind, body: Record<string, unknown>) {
    const record = JSON.stringify({ contract: JOURNAL_CONTRACT, sequence: ++this.sequence, kind, at: new Date().toISOString(),
      previousSha256: this.previous, ...body });
    this.previous = await writeExclusive(join(this.directory, `${pad(this.sequence)}-${kind}.json`), record);
    if (kind !== "note") this.lastKind = kind;
  }
  async begin(plan: NativeStorageBatchPlan): Promise<void | NativeStorageBatchResume> {
    if (this.mode === "resume") return this.resumeExisting(plan);
    await privateDirectory(this.purposesRoot);
    await mkdir(this.directory, { mode: 0o700 });
    await privateDirectory(this.directory);
    need((await sortedEntries(this.directory)).length === 0, "FRESH_JOURNAL_REQUIRED");
    // A consumed purpose is never repeated, even from another directory.
    await writeExclusive(join(this.purposesRoot, `${plan.purpose}.json`), JSON.stringify({ purpose: plan.purpose,
      planDigest: nativeStoragePlanDigest(plan), journal: this.directory }));
    await this.append("begin", { planDigest: nativeStoragePlanDigest(plan), plan });
  }
  async intent(stage: NativeStorageStage, jobs: string[]) {
    // Never stack a new intent on an unacknowledged one: that would hide an ambiguous dispatch.
    need(this.lastKind !== "intent", "INTENT_OVER_UNACKNOWLEDGED_INTENT");
    await this.append("intent", { stage, jobRunIds: jobs });
  }
  async receipt(receipt: NativeStorageStageReceipt) { await this.append("receipt", { receipt }); }
  async finish(result: NativeStorageBatchResult) { await this.append("finish", { result }); }
  /** Side records (e.g. a retire COMMIT challenge about to be sent). */
  async note(body: Record<string, unknown>) { await this.append("note", body); }
  /** Resume ONLY a chain-verified journal of the SAME plan whose last segment
   * finished after a PRE-DISPATCH refusal: no unacknowledged intent, every
   * intent has its receipt, statusReadOnlyRequired=false. Ambiguous, lost-reply
   * or consumed stages are never returned for execution. The original start is
   * kept, so the runner cannot reset the 30 min deadline. */
  private async resumeExisting(plan: NativeStorageBatchPlan): Promise<NativeStorageBatchResume> {
    const state = await readJournal(this.directory), names = await sortedEntries(this.directory);
    need(state.plan && nativeStoragePlanDigest(state.plan) === nativeStoragePlanDigest(plan), "RESUME_SAME_MANIFEST_BOUND_PLAN");
    need(state.ended && state.lastResult?.actualExitCode === 1 && state.lastResult.statusReadOnlyRequired === false &&
      state.unacknowledgedIntents.length === 0 && !state.ambiguousHistory && state.intents.length === state.receipts.length,
    "RESUME_REFUSED_AMBIGUOUS_OR_DISPATCHED");
    need(state.startedAt && Number.isFinite(Date.parse(state.startedAt)), "RESUME_ORIGINAL_START_REQUIRED");
    this.sequence = names.length; this.lastKind = "finish";
    this.previous = sha256(await readExact(join(this.directory, names[names.length - 1]!), 4 * 1024 * 1024));
    await this.append("resume", { planDigest: nativeStoragePlanDigest(plan), acknowledged: state.receipts.length });
    return { contract: "finite-native-storage-resume.v1", purpose: plan.purpose, planSha256: nativeStoragePlanDigest(plan),
      startedAt: state.startedAt!, acknowledgedReceipts: state.receipts, unacknowledgedIntent: null };
  }
}

/** READ-ONLY journal recovery: verifies the chain and reports the last
 * unacknowledged intent. It never repeats an action. */
export async function readJournal(directory: string) {
  await privateDirectory(directory);
  const names = await sortedEntries(directory);
  let previous: string | null = null, pending: { stage: string; jobRunIds: string[]; sequence: number } | null = null;
  const stacked: { stage: string; jobRunIds: string[]; sequence: number }[] = [];
  const records: Record<string, any>[] = [];
  for (const [index, name] of names.entries()) {
    need(new RegExp(`^${pad(index + 1)}-(begin|intent|receipt|finish|note|resume)\\.json$`).test(name), "JOURNAL_SEQUENCE_GAP");
    const bytes = await readExact(join(directory, name), 4 * 1024 * 1024), record = JSON.parse(bytes.toString("utf8"));
    need(record.contract === JOURNAL_CONTRACT && record.sequence === index + 1 && record.previousSha256 === previous, "JOURNAL_CHAIN_BROKEN");
    previous = sha256(bytes); records.push(record);
    if (record.kind === "intent") {
      // An intent over an unacknowledged intent is kept visible as ambiguous history, never overwritten.
      if (pending) stacked.push(pending);
      pending = { stage: record.stage, jobRunIds: record.jobRunIds, sequence: record.sequence };
    }
    if (record.kind === "receipt") {
      need(pending && pending.stage === record.receipt.stage && JSON.stringify(pending.jobRunIds) === JSON.stringify(record.receipt.jobRunIds), "RECEIPT_WITHOUT_INTENT");
      pending = null;
    }
  }
  const begin = records.find(r => r.kind === "begin"), last = records.at(-1);
  need(records.filter(r => r.kind === "begin").length <= 1, "ONE_BEGIN_PER_JOURNAL");
  // The LAST finish is the current result; "finished" means an actual exit 0 only.
  const lastResult = (records.filter(r => r.kind === "finish").at(-1)?.result ?? null) as NativeStorageBatchResult | null;
  const ended = last?.kind === "finish";
  const unacknowledgedIntents = [...stacked, ...(pending ? [pending] : [])];
  return { records: records.length, plan: begin?.plan ?? null, ended, finished: ended && lastResult?.actualExitCode === 0, lastResult,
    unacknowledgedIntents, ambiguousHistory: stacked.length > 0,
    intents: records.filter(r => r.kind === "intent").map(r => ({ stage: r.stage, jobRunIds: r.jobRunIds })),
    receipts: records.filter(r => r.kind === "receipt").map(r => r.receipt as NativeStorageStageReceipt),
    startedAt: (begin?.at as string | undefined) ?? null,
    resumes: records.filter(r => r.kind === "resume").length,
    unacknowledgedIntent: pending, notes: records.filter(r => r.kind === "note").map(({ contract, sequence, previousSha256, ...r }) => r),
    acknowledged: records.filter(r => r.kind === "receipt").map(r => ({ stage: r.receipt.stage, jobRunIds: r.receipt.jobRunIds,
      evidenceSha256: r.receipt.evidenceSha256 })) };
}
