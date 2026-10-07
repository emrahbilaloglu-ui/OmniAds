import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeStoragePlanDigest, type NativeStorageBatchPlan } from "../../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { pad, writeExclusive } from "../common";
import { JOURNAL_CONTRACT } from "../journal";
import { acquireOwner, disposeExpiredCaptureOnly, ownershipStatus, purposeState, requireOwner } from "../operator-ownership";

/** D149 terminal disposition of an EXPIRED capture-only purpose. Owned temp roots; the journal is a correctly chained
 * synthetic history whose begin instant lies before the original 30 min window, so expiry is real, not injected. */
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) { await chmodTree(r); await rm(r, { recursive: true, force: true }); } });
async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await chmodTree(p); else if (e.isFile()) await chmod(p, 0o600).catch(() => undefined);
  }
}
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const P = "c0ffee000001", OTHER = "c0ffee000002";
const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ids = [id(1), id(2)];
const plan = (purpose = P): NativeStorageBatchPlan => ({ contract: "finite-native-storage-batch.v2", purpose, targetRevision: "a".repeat(40),
  sourceManifestSha256: "b".repeat(64), actualSourceReviewSha256: "c".repeat(64), expectedDatabaseBudgetBytes: 175019917312,
  cutoffObservedAt: "2026-10-01T00:00:00.000Z", units: ids.map((jobRunId, i) => ({ generation: { businessId: id(900), jobRunId, asOfDate: "2026-09-01",
    engineVersion: "v3" }, evaluations: 10, contexts: 1, originalProofSha256: sha(`proof-${i}`) })) }) as unknown as NativeStorageBatchPlan;
const result = (o: Record<string, unknown> = {}) => ({ contract: "finite-native-storage-batch.v2", purpose: P, actualExitCode: 1, stage: "publish",
  reason: "MAINTENANCE_REFUSED:app_physical_reserve", statusReadOnlyRequired: false, retiredOriginalJobs: [], providerAuthority: false,
  physicalBytesReclaimed: 0, sustainableStorageClosed: false, newWebOwnObservationRequired: false, ...o });
type Rec = { kind: string; body: Record<string, unknown> };
/** Writes a correctly chained journal (same record format as FileBatchJournal) starting at `start`. */
async function writeJournal(r: string, p: NativeStorageBatchPlan, records: Rec[], start: number) {
  const dir = join(r, "batches", p.purpose, "journal");
  await mkdir(dir, { mode: 0o700 });
  let previous: string | null = null;
  for (const [i, rec] of records.entries()) {
    const bytes = JSON.stringify({ contract: JOURNAL_CONTRACT, sequence: i + 1, kind: rec.kind, at: new Date(start + i * 1000).toISOString(),
      previousSha256: previous, ...rec.body });
    previous = await writeExclusive(join(dir, `${pad(i + 1)}-${rec.kind}.json`), bytes);
  }
  await writeExclusive(join(r, "purposes", `${p.purpose}.json`), JSON.stringify({ purpose: p.purpose, planDigest: nativeStoragePlanDigest(p), journal: dir }));
}
interface Build { startMinutesAgo?: number; records?: (p: NativeStorageBatchPlan, receipts: Record<string, unknown>[]) => Rec[]; owned?: boolean;
  receipt?: (i: number, r: Record<string, unknown>) => Record<string, unknown>; after?: (r: string, p: NativeStorageBatchPlan) => Promise<void> }
/** The exact local layout an actual capture-only purpose leaves (see the real 733c6cc3c9dd file census). */
async function build(o: Build = {}) {
  const r = await realpath(await mkdtemp(join(tmpdir(), "nsb-cap-")));
  roots.push(r);
  await mkdir(join(r, "batches"), { mode: 0o700 }); await mkdir(join(r, "purposes"), { mode: 0o700 });
  const p = plan(), batch = join(r, "batches", P), digest = nativeStoragePlanDigest(p);
  if (o.owned !== false) await acquireOwner(r, P, { cursor: null, revisit: false });
  for (const dir of [batch, join(batch, "units"), join(batch, "stages"), join(batch, "remote"), join(r, "copies"), join(r, "copies", P)]) await mkdir(dir, { mode: 0o700 });
  await writeExclusive(join(batch, "plan.json"), JSON.stringify(p));
  await writeExclusive(join(batch, "remote", "app-0001-plan-db.json"), "{}");
  const receipts: Record<string, unknown>[] = [];
  let seq = 2;
  for (const [i, u] of p.units.entries()) {
    const jobRunId = u.generation.jobRunId, cipher = Buffer.from(`ciphertext-${i}`), trust = Buffer.from(`{"trust":${i}}`), leaf = Buffer.from(`{"leaf":${i}}`);
    const meta = { proofSha256: u.originalProofSha256, generation: u.generation, leafSha256: sha(leaf),
      parts: [{ ciphertextSha256: sha(cipher), ciphertextBytes: cipher.length, trustSha256: sha(trust) }] };
    await writeExclusive(join(batch, "units", `${jobRunId}.config.json`), "{}");
    await mkdir(join(batch, "units", jobRunId), { mode: 0o700 });
    await writeExclusive(join(batch, "units", jobRunId, "capture.json"), JSON.stringify({ metadata: meta, samples: [] }));
    await writeExclusive(join(batch, "units", jobRunId, "restore.json"), JSON.stringify({ frozenProofParity: true, plaintextRestoreDropped: true }));
    await mkdir(join(r, "copies", P, jobRunId), { mode: 0o700 });
    for (const copy of ["primary", "recovery"]) {
      const dir = join(r, "copies", P, jobRunId, copy); await mkdir(dir, { mode: 0o700 });
      await writeExclusive(join(dir, `${sha(cipher)}.bin`), cipher); await writeExclusive(join(dir, `${sha(cipher)}.trust.json`), trust);
      await writeExclusive(join(dir, `leaf-${sha(leaf)}.json`), leaf); await writeExclusive(join(dir, "capture.json"), JSON.stringify(meta));
    }
    const evidenceSha256 = await writeExclusive(join(batch, "stages", `${pad(i + 1)}-capture-restore.json`), JSON.stringify({ remoteSequence: 3,
      parts: 1, coverageRootSha256: "f".repeat(64), leafSha256: sha(leaf), privateCopies: 2, restoreTableHashes: {}, plaintextRestoreDropped: true,
      contract: "finite-native-storage-stage-evidence.v2", purpose: P, stage: "capture-restore", stageSequence: i + 1, jobRunIds: [jobRunId],
      planSha256: digest, sourceManifestSha256: "b".repeat(64), actualSourceReviewSha256: "c".repeat(64), operatorRevision: "a".repeat(40),
      runtimeRevision: "a".repeat(40), remote: [], at: "2026-10-07T04:35:00.000Z" }));
    await writeExclusive(join(batch, "remote", `app-${pad(seq++)}-evidence-db.json`), "{}");
    await writeExclusive(join(batch, "remote", `db-${pad(seq++)}-evidence-sample-capacity.json`), "{}");
    await writeExclusive(join(batch, "remote", `app-${pad(seq++)}-capture-restore-db.json`), JSON.stringify({ actualExitCode: 0, purpose: P,
      stage: "capture-restore", op: "db", unitJobRunIds: [jobRunId], sequence: seq - 1 }));
    const receipt = { purpose: P, stage: "capture-restore", jobRunIds: [jobRunId], actualExitCode: 0, actionAcknowledged: true,
      independentFullOriginalBytesMatch: true, providerAuthority: false, reclaimedBytes: 0, evidenceSha256 };
    receipts.push(o.receipt ? o.receipt(i, receipt) : receipt);
  }
  const fin = result();
  const records = o.records ? o.records(p, receipts) : [{ kind: "begin", body: { planDigest: digest, plan: p } },
    ...receipts.flatMap(rc => [{ kind: "intent", body: { stage: "capture-restore", jobRunIds: rc.jobRunIds } }, { kind: "receipt", body: { receipt: rc } }]),
    { kind: "finish", body: { result: fin } }];
  await writeJournal(r, p, records, Date.now() - (o.startMinutesAgo ?? 45) * 60_000);
  await writeExclusive(join(batch, `result-${Date.now()}.json`), JSON.stringify(fin));
  if (o.after) await o.after(r, p);
  return r;
}
const refusal = (p: Promise<unknown>) => p.then(() => "NO_REFUSAL", (e: Error) => e.message);
const tree = async (dir: string): Promise<string> => sha(JSON.stringify(await Promise.all((await readdir(dir, { withFileTypes: true }))
  .sort((a, b) => a.name < b.name ? -1 : 1).map(async e => [e.name, e.isDirectory() ? await tree(join(dir, e.name)) : sha(await readFile(join(dir, e.name)))]))));
const tamper = async (file: string, edit: (b: Buffer) => Buffer) => { await chmod(file, 0o600); await writeFile(file, edit(await readFile(file))); await chmod(file, 0o400); };
const begin = (p: NativeStorageBatchPlan) => ({ kind: "begin", body: { planDigest: nativeStoragePlanDigest(p), plan: p } });
const pair = (rc: Record<string, unknown>) => [{ kind: "intent", body: { stage: "capture-restore", jobRunIds: rc.jobRunIds } }, { kind: "receipt", body: { receipt: rc } }];

describe("expired capture-only terminal disposition", () => {
  it("disposes the actual capture-only shape once expired: bytes preserved, no success/retry/reclaim, no chain advance, own lease only", async () => {
    const r = await build();
    expect(await purposeState(r, P)).toBe("resumable");
    expect(await refusal(acquireOwner(r, OTHER, { cursor: null, revisit: false }))).toBe(`OWNER_LEASE_HELD:${P}`);
    const before = { batch: await tree(join(r, "batches", P)), copies: await tree(join(r, "copies", P)), marker: sha(await readFile(join(r, "purposes", `${P}.json`))) };
    const out = await disposeExpiredCaptureOnly(r, P);
    const detail = out.release.detail as Record<string, unknown>;
    expect([out.release.outcome, out.release.advancesChain, detail.successClaimed, detail.retryPermitted, detail.reclaimClaimed, detail.units,
      detail.originalStage, detail.journalRecords]).toEqual(["terminal-expired-capture-only", false, false, false, false, 2, "publish", 6]);
    expect({ batch: await tree(join(r, "batches", P)), copies: await tree(join(r, "copies", P)), marker: sha(await readFile(join(r, "purposes", `${P}.json`))) })
      .toEqual(before);
    expect(await purposeState(r, P)).toBe("resumable");                                                  // history never becomes "finished"
    expect(await ownershipStatus(r)).toMatchObject({ owner: null, frontier: null, purposes: { [P]: "released:terminal-expired-capture-only" } });
    expect(await refusal(requireOwner(r, P))).toBe("OWNER_LEASE_REQUIRED");                              // never resumed/retried
    expect(await refusal(disposeExpiredCaptureOnly(r, P))).toBe("PURPOSE_ALREADY_RELEASED");
    expect(await refusal(acquireOwner(r, OTHER, { cursor: null, revisit: false }))).toBe("NO_REFUSAL"); // a new purpose is allowed
  });
  it("refuses while the original 30 min window has not elapsed (no reset) and writes nothing", async () => {
    const r = await build({ startMinutesAgo: 10 });
    expect(await refusal(disposeExpiredCaptureOnly(r, P))).toBe("PURPOSE_DEADLINE_NOT_EXPIRED");
    expect(await readdir(join(r, "control", "released"))).toEqual([]);
  });
  it("refuses every shape that is not exactly acknowledged capture-only before publish", async () => {
    const cases: [string, Build, string][] = [
      ["missing-ack", { records: (p, rc) => [begin(p), ...pair(rc[0]!), { kind: "intent", body: { stage: "capture-restore", jobRunIds: rc[1]!.jobRunIds } },
        { kind: "finish", body: { result: result({ stage: "capture-restore", statusReadOnlyRequired: true }) } }] }, "NOT_AN_EXPIRED_CAPTURE_ONLY_STATE"],
      ["one-unit-only", { records: (p, rc) => [begin(p), ...pair(rc[0]!), { kind: "finish", body: { result: result({ stage: "capture-restore" }) } }] },
        "CAPTURE_ONLY_REQUIRES_EXACT_CAPTURE_PREFIX_JOURNAL"],
      ["false-ack", { receipt: (i, rc) => i === 1 ? { ...rc, actionAcknowledged: false } : rc }, "CAPTURE_ONLY_ACKNOWLEDGED_RECEIPTS"],
      ["foreign-ack", { receipt: (i, rc) => i === 0 ? { ...rc, purpose: OTHER } : rc }, "CAPTURE_ONLY_ACKNOWLEDGED_RECEIPTS"],
      ["byte-mismatch-ack", { receipt: (i, rc) => i === 0 ? { ...rc, independentFullOriginalBytesMatch: false } : rc }, "CAPTURE_ONLY_ACKNOWLEDGED_RECEIPTS"],
      ["status-only", { records: (p, rc) => [begin(p), ...rc.flatMap(pair), { kind: "finish", body: { result: result({ statusReadOnlyRequired: true }) } }] },
        "NOT_AN_EXPIRED_CAPTURE_ONLY_STATE"],
      ["refused-later-than-publish", { records: (p, rc) => [begin(p), ...rc.flatMap(pair), { kind: "finish", body: { result: result({ stage: "activate" }) } }] },
        "CAPTURE_ONLY_PRE_PUBLISH_REFUSAL_REQUIRED"],
      ["resumed", { records: (p, rc) => [begin(p), ...rc.flatMap(pair), { kind: "finish", body: { result: result() } },
        { kind: "resume", body: { planDigest: nativeStoragePlanDigest(p), acknowledged: 2 } }, { kind: "finish", body: { result: result({ reason: "BATCH_DEADLINE" }) } }] },
        "CAPTURE_ONLY_REQUIRES_EXACT_CAPTURE_PREFIX_JOURNAL"],
      ["publish-dispatch", { after: async r => { await writeExclusive(join(r, "batches", P, "remote", "app-0009-publish-publish-root.json"), "{}"); } },
        "CAPTURE_ONLY_EXECUTION_DISPATCH_RECORDED:app-0009-publish-publish-root.json"],
      ["publication-artifact", { after: async r => { await writeExclusive(join(r, "batches", P, "publication.json"), "{}"); } },
        "CAPTURE_ONLY_EXECUTION_ARTIFACT_PRESENT:publication.json"],
      ["http-proof-artifact", { after: async r => { await mkdir(join(r, "batches", P, "http-proof")); } }, "CAPTURE_ONLY_EXECUTION_ARTIFACT_PRESENT:http-proof"],
      ["extra-stage", { after: async r => { await writeExclusive(join(r, "batches", P, "stages", "0003-publish.json"), "{}"); } }, "CAPTURE_ONLY_STAGE_EVIDENCE_SET"],
      ["foreign-copy", { after: async r => { await mkdir(join(r, "copies", P, id(9))); } }, "CAPTURE_ONLY_COPY_SET"],
      ["missing-recovery-copy", { after: async r => { await rm(join(r, "copies", P, ids[1]!, "recovery"), { recursive: true }); } }, "CAPTURE_ONLY_COPY_PAIR"],
      ["tampered-copy", { after: async r => { const dir = join(r, "copies", P, ids[0]!, "recovery");
        const bin = (await readdir(dir)).find(n => n.endsWith(".bin"))!; await tamper(join(dir, bin), b => Buffer.concat([b, Buffer.from("x")])); } },
        "CAPTURE_ONLY_COPY_PARITY"],
      ["tampered-stage-evidence", { after: async r => { await tamper(join(r, "batches", P, "stages", "0001-capture-restore.json"),
        b => Buffer.from(b.toString().replace('"privateCopies":2', '"privateCopies":1'))); } }, "CAPTURE_ONLY_STAGE_EVIDENCE_BINDING"],
      ["restore-parity-false", { after: async r => { await tamper(join(r, "batches", P, "units", ids[1]!, "restore.json"),
        () => Buffer.from(JSON.stringify({ frozenProofParity: false, plaintextRestoreDropped: true }))); } }, "CAPTURE_ONLY_RESTORE_PARITY"],
      ["foreign-capture-dispatch", { after: async r => { const dir = join(r, "batches", P, "remote");
        const n = (await readdir(dir)).find(x => x.includes("capture-restore"))!;
        await tamper(join(dir, n), b => Buffer.from(b.toString().replace(`"purpose":"${P}"`, `"purpose":"${OTHER}"`))); } }, "CAPTURE_ONLY_CAPTURE_DISPATCH"],
      ["result-copy-mismatch", { after: async r => { await writeExclusive(join(r, "batches", P, "result-1.json"), JSON.stringify(result({ reason: "X" }))); } },
        "CAPTURE_ONLY_RESULT_COPY_MISMATCH:result-1.json"],
    ];
    for (const [name, o, code] of cases) {
      const r = await build(o);
      expect(await refusal(disposeExpiredCaptureOnly(r, P)), name).toContain(code);
      expect(await readdir(join(r, "control", "released")), name).toEqual([]);
      expect((await ownershipStatus(r)).owner, name).toBe(P);                                            // the lease is never released
    }
  });
  it("re-proves its facts on every ownership read: tampered copies or release detail refuse everything", async () => {
    const r = await build();
    await disposeExpiredCaptureOnly(r, P);
    const dir = join(r, "copies", P, ids[0]!, "primary"), bin = (await readdir(dir)).find(n => n.endsWith(".bin"))!, saved = await readFile(join(dir, bin));
    await tamper(join(dir, bin), b => Buffer.concat([b, Buffer.from("x")]));
    expect(await refusal(acquireOwner(r, OTHER, { cursor: null, revisit: false }))).toBe(`RELEASE_RECORD_INVALID:${P}:CAPTURE_ONLY_COPY_PARITY:${ids[0]}:primary`);
    await tamper(join(dir, bin), () => saved);
    const rel = join(r, "control", "released", `${P}.json`);
    await tamper(rel, b => Buffer.from(b.toString().replace('"reclaimClaimed":false', '"reclaimClaimed":true')));
    expect(await refusal(ownershipStatus(r))).toBe(`RELEASE_RECORD_INVALID:${P}:RELEASE_DETAIL`);
  });
  it("concurrent dispositions: exactly one release; only the purpose's own lease (or a never-leased one with no owner) is ended", async () => {
    const r = await build();
    expect(await refusal(disposeExpiredCaptureOnly(r, OTHER))).toBe(`OWNER_LEASE_HELD:${P}`);              // never another purpose's lease
    const outs = await Promise.allSettled([disposeExpiredCaptureOnly(r, P), disposeExpiredCaptureOnly(r, P)]);
    expect(outs.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(await readdir(join(r, "control", "released"))).toEqual([`${P}.json`]);
    expect((await ownershipStatus(r)).purposes).toEqual({ [P]: "released:terminal-expired-capture-only" });
    const legacy = await build({ owned: false });                                                          // pre-lease purpose, no active owner
    expect((await disposeExpiredCaptureOnly(legacy, P)).release.outcome).toBe("terminal-expired-capture-only");
  });
});
