import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeStorageBatchPlan, NativeStorageBatchResult, NativeStorageStage } from "../../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { canonicalSha, sha256, writeExclusive } from "../common";
import { FileBatchJournal } from "../journal";
import { productionPlan } from "../production-cli";
import { computeSourcePack, REPO_ROOT } from "../source-pack";
import { SETTLEMENT_APPLICATION, SETTLEMENT_CONTRACT, type SettlementBinding } from "../maintenance-settlement";
import { abandonOwnedPurpose, acquireOwner, chainFrontier, chainGate, disposePreDispatchRefused, disposeUnacknowledgedMaintenance, ownershipStatus,
  purposeState, recordExamined, releaseOwner, requireOwner, settledPrefix, vetoPermanence, type Cursor, type Disposition } from "../operator-ownership";

/** D149 owned mechanics: real FileBatchJournal, real O_EXCL files, temp private roots only. No database, host or network.
 * The live SELECT-only settlement collector runs against owned PostgreSQL in production-fixture-e2e.ts. */
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) { await chmodTree(r); await rm(r, { recursive: true, force: true }); } });
async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await chmodTree(p); else if (e.isFile()) await chmod(p, 0o600).catch(() => undefined);
  }
}
async function root() {
  const r = await realpath(await mkdtemp(join(tmpdir(), "nsb-own-")));
  roots.push(r);
  await mkdir(join(r, "batches"), { mode: 0o700 }); await mkdir(join(r, "purposes"), { mode: 0o700 });
  return r;
}
const P = (n: number) => n.toString(16).padStart(12, "0");
const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const cur = (n: number): Cursor => ({ asOfDate: `2026-09-${String(1 + Math.floor(n / 4)).padStart(2, "0")}`, jobRunId: id(n) });
const V1 = "finite-native-storage-batch.v1", V2 = "finite-native-storage-batch.v2", CUTOFF = "2026-10-01T00:00:00.000Z";
const gen = (i: number) => ({ businessId: id(900), jobRunId: id(i + 1), asOfDate: "2026-09-01", engineVersion: "v3" });
const plan = (purpose: string, units = 2, contract = V2, proofs: string[] = []): NativeStorageBatchPlan => ({ contract, purpose,
  targetRevision: "a".repeat(40), sourceManifestSha256: "b".repeat(64), actualSourceReviewSha256: "c".repeat(64), expectedDatabaseBudgetBytes: 1,
  cutoffObservedAt: CUTOFF, units: Array.from({ length: units }, (_, i) => ({ generation: gen(i), evaluations: 10, contexts: 1,
    originalProofSha256: proofs[i] ?? "d".repeat(64) })) }) as unknown as NativeStorageBatchPlan;
const result = (purpose: string, exit: 0 | 1, statusReadOnlyRequired: boolean, o: { contract?: string; stage?: string | null; reason?: string; retired?: string[] } = {}) =>
  ({ contract: o.contract ?? V2, purpose, actualExitCode: exit, stage: o.stage === undefined ? null : o.stage, reason: o.reason ?? (exit ? "X" : "OK"),
    statusReadOnlyRequired, retiredOriginalJobs: o.retired ?? [], providerAuthority: false, physicalBytesReclaimed: 0, sustainableStorageClosed: false,
    newWebOwnObservationRequired: false }) as unknown as NativeStorageBatchResult;
const ack = (purpose: string, stage: NativeStorageStage, jobRunIds: string[]) => ({ purpose, stage, jobRunIds, actualExitCode: 0, actionAcknowledged: true,
  independentFullOriginalBytesMatch: true, providerAuthority: false as const, reclaimedBytes: 0 as const, evidenceSha256: "e".repeat(64) });
const selection = (purpose: string, cursor: Cursor | null = null) => JSON.stringify({ contract: "native-storage-selection-prelude.v1", purpose,
  operatorRevision: "a".repeat(40), runtimeRevision: "a".repeat(40), sourceManifestSha256: "b".repeat(64), actualSourceReviewSha256: "c".repeat(64),
  expectedDatabaseBudgetBytes: 1, cutoffObservedAt: CUTOFF, cursor, limit: 32, maxUnits: 8 });
/** Declares a purpose the way productionPlan does (batch dir + write-once selection declaration), optionally with a plan. */
async function declare(r: string, p: string, o: { plan?: NativeStorageBatchPlan | null; cursor?: Cursor | null } = {}) {
  await mkdir(join(r, "batches", p), { mode: 0o700 });
  await writeExclusive(join(r, "batches", p, "selection.json"), selection(p, o.cursor ?? null));
  if (o.plan) await writeExclusive(join(r, "batches", p, "plan.json"), JSON.stringify(o.plan));
}
/** Records the examined prefix through the REAL helper (validated against its selection declaration and lease). */
async function examine(r: string, p: string, dispositions: Disposition[], start: Cursor | null = null, revisit = false) {
  const sel = await readFile(join(r, "batches", p, "selection.json"));
  return recordExamined(r, p, { startCursor: start, revisit, selectionSha256: sha256(sel), cutoffObservedAt: CUTOFF, limit: 32, maxUnits: 8,
    windowSize: dispositions.length, dispositions, ...settledPrefix(start, dispositions.map(d => d.candidate), dispositions, null) });
}
const vetoAt = (n: number, code = "ALREADY_ARCHIVED_ROUTE"): Disposition => ({ candidate: cur(n), outcome: "veto", code, permanence: vetoPermanence(code) });
/** Runs the REAL journal through the given acknowledged stages, then optionally one unacknowledged intent, then finish. */
async function journalOf(r: string, p: string, pl: NativeStorageBatchPlan, acked: [NativeStorageStage, string[]][], pending: [NativeStorageStage, string[]] | null,
  fin: NativeStorageBatchResult | null) {
  const j = new FileBatchJournal(join(r, "batches", p, "journal"), join(r, "purposes"));
  await j.begin(pl);
  for (const [stage, ids] of acked) { await j.intent(stage, ids); await j.receipt(ack(p, stage, ids)); }
  if (pending) await j.intent(...pending);
  if (fin) await j.finish(fin);
  return j;
}
const refusal = (p: Promise<unknown>) => p.then(() => "NO_REFUSAL", (e: Error) => e.message);
/** Every file under dir (recursively) by relative path and SHA-256. */
const bytesOf = async (dir: string, base = dir): Promise<Record<string, string>> => Object.fromEntries((await Promise.all((await readdir(dir, { withFileTypes: true }))
  .map(async e => e.isDirectory() ? Object.entries(await bytesOf(join(dir, e.name), base)) : [[join(dir, e.name).slice(base.length + 1), sha256(await readFile(join(dir, e.name)))]])))
  .flat().sort(([a], [b]) => (a! < b! ? -1 : 1)));
const tamper = async (file: string, edit: (s: string) => string) => { await chmod(file, 0o600); await writeFile(file, edit(await readFile(file, "utf8"))); await chmod(file, 0o400); };

describe("D149 settled prefix and chain", () => {
  it("records the fb9-shaped window prefix; the loop-breaking candidate is never examined", () => {
    const ordered = Array.from({ length: 32 }, (_, i) => cur(i));
    const d: Disposition[] = ordered.slice(0, 30).map((c, i) => i % 4 === 1 ? { candidate: c, outcome: "unit" as const }
      : { candidate: c, outcome: "veto" as const, code: "RETAINED_SNAPSHOT_VETO", permanence: "permanent" as const });
    expect(settledPrefix(null, ordered, d, 30)).toEqual({ examinedThrough: cur(29), breakCandidate: cur(30), transientVetoes: [] });
    expect(() => settledPrefix(null, ordered, d.slice(1), 29)).toThrow("DISPOSITIONS_MUST_BE_THE_ORDERED_PREFIX");
    expect(() => settledPrefix(null, ordered, d, 31)).toThrow("BREAK_MUST_BE_THE_FIRST_UNSETTLED_CANDIDATE");
    expect(() => settledPrefix(null, ordered, d, null)).toThrow("BREAK_MUST_BE_THE_FIRST_UNSETTLED_CANDIDATE");
    expect(() => settledPrefix(cur(3), ordered, d, 30)).toThrow("SELECTION_NOT_AFTER_START");
    expect(() => settledPrefix(null, [cur(2), cur(1)], [], null)).toThrow("SELECTION_ORDER_REQUIRED");
    expect(settledPrefix(cur(5), [], [], null)).toEqual({ examinedThrough: cur(5), breakCandidate: null, transientVetoes: [] });
    const t: Disposition[] = [{ candidate: cur(0), outcome: "veto", code: "SUBSEQUENT_DISTINCT_DAY_SUCCESS_REQUIRED", permanence: "transient" }];
    expect(settledPrefix(null, [cur(0)], t, null).transientVetoes).toEqual([cur(0)]);
  });
  it("classifies veto permanence by code head", () => {
    expect(vetoPermanence("FINITE_ORIGINAL_POPULATION_EXCEEDED:2860>1134")).toBe("permanent");
    for (const c of ["CONTEXT_COUNT_OUTSIDE_1_4", "ALREADY_ARCHIVED_ROUTE", "RETAINED_SNAPSHOT_VETO"]) expect(vetoPermanence(c)).toBe("permanent");
    for (const c of ["SUBSEQUENT_DISTINCT_DAY_SUCCESS_REQUIRED", "PRODUCTION_ACTOR_REFUSED:X", "FROZEN_PROOF_SELF_CHECK"]) expect(vetoPermanence(c)).toBe("transient");
  });
  it("chain gate: null after progress rescans, ahead skips, behind needs an explicit revisit, exact continues", () => {
    expect(() => chainGate(null, cur(29), false)).toThrow("CURSOR_BEHIND_CHAIN_FRONTIER_WOULD_RESCAN");
    expect(() => chainGate(cur(31), cur(29), false)).toThrow("CURSOR_AHEAD_OF_FRONTIER_WOULD_SKIP_UNEXAMINED");
    expect(() => chainGate(cur(31), cur(29), true)).toThrow("CURSOR_AHEAD_OF_FRONTIER_WOULD_SKIP_UNEXAMINED");
    expect(() => chainGate(cur(10), cur(29), false)).toThrow("CURSOR_BEHIND_CHAIN_FRONTIER_WOULD_RESCAN");
    expect(() => chainGate(null, cur(29), true)).toThrow("EXPLICIT_REVISIT_CURSOR_REQUIRED");
    expect(() => chainGate(cur(10), cur(29), true)).not.toThrow();
    expect(() => chainGate(cur(29), cur(29), false)).not.toThrow();
    expect(() => chainGate(null, null, false)).not.toThrow();
    expect(() => chainGate(cur(1), null, false)).toThrow("FIRST_CHAINED_PURPOSE_STARTS_AT_BEGINNING");
    expect(() => chainGate(cur(29), cur(29), true)).toThrow("REVISIT_CURSOR_MUST_BE_BEHIND_FRONTIER");    // equality is a continuation
    expect(() => chainGate(null, null, "false" as unknown as boolean)).toThrow("EXACT_REVISIT_FLAG");
  });
});

describe("D149 single owner on a private operator root", () => {
  it("exactly one of many concurrent in-process acquisitions wins (check-then-write race closed by O_EXCL)", async () => {
    const r = await root();
    const out = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => acquireOwner(r, P(i + 1), { cursor: null, revisit: false })));
    const won = out.flatMap((o, i) => o.status === "fulfilled" ? [P(i + 1)] : []);
    expect(won).toHaveLength(1);
    for (const o of out) if (o.status === "rejected") expect(String(o.reason.message)).toBe(`OWNER_LEASE_HELD:${won[0]}`);
    expect((await ownershipStatus(r)).owner).toBe(won[0]);
  });
  it("exactly one of several concurrent PROCESSES wins", async () => {
    const r = await root(), mod = resolve(__dirname, "../operator-ownership.ts");
    const one = (p: string) => new Promise<string>((done, fail) => {
      const c = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
        `const i = await import(${JSON.stringify(mod)}), m = i.acquireOwner ? i : i.default; try { await m.acquireOwner(${JSON.stringify(r)}, "${p}", { cursor: null, revisit: false }); console.log("WON"); } catch (e) { console.log(e.message); }`],
      { cwd: resolve(__dirname, "../../.."), stdio: ["ignore", "pipe", "pipe"] });
      let s = ""; c.stdout.on("data", d => { s += d; }); c.on("error", fail); c.on("close", () => done(s.trim()));
    });
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) => one(P(i + 1))));
    expect(out.filter(x => x === "WON")).toHaveLength(1);
    const winner = P(out.indexOf("WON") + 1);
    expect(out.filter(x => x !== "WON").every(x => x === `OWNER_LEASE_HELD:${winner}`)).toBe(true);
  }, 60_000);
  it("fails closed on symlinked, half-written, unknown-shape, group-writable or unknown control metadata", async () => {
    const L = (r: string) => join(r, "control", "lease-000001.json");
    const cases: [string, (r: string) => Promise<void>, string][] = [
      ["symlink", async r => { await writeExclusive(join(r, "elsewhere.json"), "{}"); await symlink(join(r, "elsewhere.json"), L(r)); }, "OWNERSHIP_METADATA_NOT_REGULAR_FILE"],
      ["half-written", async r => { await writeExclusive(L(r), '{"contract":"native-finite-operator-owner.v1","purp'); }, "OWNERSHIP_METADATA_UNREADABLE:JSON"],
      ["unknown-shape", async r => { await writeExclusive(L(r), JSON.stringify({ contract: "native-finite-operator-owner.v1", sequence: 1, purpose: P(9) })); },
        "OWNERSHIP_METADATA_UNKNOWN_SHAPE"],
      ["group-writable", async r => { await writeExclusive(L(r), "{}", 0o620); }, "OWNERSHIP_METADATA_UNREADABLE"],
      ["unknown-control", async r => { await writeExclusive(join(r, "control", "owner.json.tmp"), "{}"); }, "UNKNOWN_CONTROL_METADATA"],
      ["lease-gap", async r => { await writeExclusive(join(r, "control", "lease-000002.json"), "{}"); }, "LEASE_SEQUENCE_GAP"],
      ["unknown-release", async r => { await writeExclusive(join(r, "control", "released", "x.json"), "{}"); }, "UNKNOWN_RELEASE_METADATA"],
      ["unknown-purpose-dir", async r => { await mkdir(join(r, "batches", "not-a-purpose")); }, "UNKNOWN_PURPOSE_METADATA"],
    ];
    for (const [name, arrange, code] of cases) {
      const r = await root();
      await mkdir(join(r, "control", "released"), { recursive: true, mode: 0o700 });
      await arrange(r);
      const before = await readdir(join(r, "control"));
      expect(await refusal(acquireOwner(r, P(1), { cursor: null, revisit: false })), name).toContain(code);
      expect(await readdir(join(r, "control")), name).toEqual(before);                                   // nothing acquired
    }
    const open = await realpath(await mkdtemp(join(tmpdir(), "nsb-own-"))); roots.push(open); await chmod(open, 0o755);
    expect(await refusal(acquireOwner(open, P(1), { cursor: null, revisit: false }))).not.toBe("NO_REFUSAL");
  });
  it("planned, running, paused-resumable and ambiguous purposes block a second owner; finished legacy is released without a chain claim", async () => {
    const r = await root();
    await declare(r, P(1));
    expect(await refusal(acquireOwner(r, P(9), { cursor: null, revisit: false }))).toBe(`OTHER_PURPOSE_OPEN:${P(1)}:planned`);
    await rm(join(r, "batches", P(1)), { recursive: true, force: true });
    const pl = plan(P(2)), ids = pl.units.map(u => u.generation.jobRunId);
    await declare(r, P(2), { plan: pl });
    await journalOf(r, P(2), pl, [], null, null);
    expect(await refusal(acquireOwner(r, P(9), { cursor: null, revisit: false }))).toBe(`OTHER_PURPOSE_OPEN:${P(2)}:running`);
    const r2 = await root();
    await declare(r2, P(3), { plan: plan(P(3)) });
    await journalOf(r2, P(3), plan(P(3)), [["capture-restore", [ids[0]!]], ["capture-restore", [ids[1]!]], ["publish", ids], ["activate", ids]], null, result(P(3), 1, false));
    expect(await purposeState(r2, P(3))).toBe("resumable");
    expect(await refusal(acquireOwner(r2, P(9), { cursor: null, revisit: false }))).toBe(`OTHER_PURPOSE_OPEN:${P(3)}:resumable`);
    const r3 = await root();
    await declare(r3, P(4), { plan: plan(P(4)) });
    await journalOf(r3, P(4), plan(P(4)), [["capture-restore", [ids[0]!]], ["capture-restore", [ids[1]!]], ["publish", ids], ["activate", ids]],
      ["retire", [ids[0]!]], result(P(4), 1, true));
    expect(await purposeState(r3, P(4))).toBe("ambiguous-routing");
    expect(await refusal(acquireOwner(r3, P(9), { cursor: null, revisit: false }))).toBe(`OTHER_PURPOSE_OPEN:${P(4)}:ambiguous-routing`);
    const r4 = await root();
    await declare(r4, P(5), { plan: plan(P(5)) });
    await journalOf(r4, P(5), plan(P(5)), [], null, result(P(5), 0, false));
    await acquireOwner(r4, P(9), { cursor: null, revisit: false });
    const rel = JSON.parse(await readFile(join(r4, "control", "released", `${P(5)}.json`), "utf8"));
    expect([rel.outcome, rel.advancesChain, rel.detail]).toEqual(["finished", false, { legacyUnowned: true }]);
  });
  it("leases are immutable and never unlinked; the next number is created exactly once", async () => {
    const r = await root();
    for (let i = 1; i <= 3; i++) {
      await acquireOwner(r, P(i), { cursor: null, revisit: false }); await declare(r, P(i));
      await examine(r, P(i), []); await releaseOwner(r, P(i), "terminal-scan");
    }
    expect((await readdir(join(r, "control"))).filter(n => n.startsWith("lease-"))).toEqual(["lease-000001.json", "lease-000002.json", "lease-000003.json"]);
    expect(await refusal(writeExclusive(join(r, "control", "lease-000003.json"), "{}"))).toContain("EEXIST");
    expect((await ownershipStatus(r)).leases).toBe(3);
  });
  it("execute/resume and release require the lease; a finished release needs an actual exit-0 journal", async () => {
    const r = await root();
    expect(await refusal(requireOwner(r, P(1)))).toBe("OWNER_LEASE_REQUIRED");
    await acquireOwner(r, P(1), { cursor: null, revisit: false });
    await declare(r, P(1), { plan: plan(P(1)) });
    expect(await refusal(requireOwner(r, P(2)))).toBe("OWNER_LEASE_REQUIRED");
    await journalOf(r, P(1), plan(P(1)), [], null, result(P(1), 1, false));
    expect(await refusal(releaseOwner(r, P(1), "finished"))).toBe("RELEASE_SELF_CHECK:RELEASE_WITHOUT_FINISHED_JOURNAL");
    expect(await refusal(releaseOwner(r, P(1), "terminal-scan"))).toBe("RELEASE_SELF_CHECK:RELEASE_DETAIL");
    expect(await readdir(join(r, "control", "released"))).toEqual([]);
    expect(await refusal(requireOwner(r, P(1)))).toBe("NO_REFUSAL");
  });
});

describe("RC-O1: complete-key semantically corrupt ownership metadata never releases an owner", () => {
  const now = () => new Date().toISOString();
  const release = (p: string, over: Record<string, unknown>) => JSON.stringify({ contract: "native-finite-operator-release.v1", purpose: p, outcome: "finished",
    at: now(), advancesChain: false, examinedThrough: null, examinedSha256: null, detail: null, ...over });
  async function plannedOwner() {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false });
    await declare(r, P(1));
    return r;
  }
  it("root's exact CORRUPT_UNKNOWN_OUTCOME record and every complete-key semantic variant refuse; P1 is not freed and P2 not admitted", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["root-reproduction", { outcome: "CORRUPT_UNKNOWN_OUTCOME" }, "RELEASE_FIELDS"],
      ["finished-without-journal", { outcome: "finished" }, "RELEASE_WITHOUT_FINISHED_JOURNAL"],
      ["finished-legacy-detail-on-leased", { outcome: "finished", detail: { legacyUnowned: true } }, "RELEASE_DETAIL"],
      ["finished-extra-detail", { outcome: "finished", detail: { legacyUnowned: true, extra: 1 } }, "RELEASE_DETAIL"],
      ["abandoned-without-marker", { outcome: "abandoned", detail: { preD149Unleased: false } }, "RELEASE_WITHOUT_ABANDON_MARKER"],
      ["terminal-scan-without-record", { outcome: "terminal-scan" }, "RELEASE_DETAIL"],
      ["maintenance-fabricated", { outcome: "terminal-maintenance-outcome-unknown", detail: { settlementProofSha256: "a".repeat(64), unacknowledgedStage: "vacuum-toast",
        journalHeadSha256: "b".repeat(64), markerSha256: "c".repeat(64), planDigest: "d".repeat(64), observedAt: now(), successClaimed: false, retryPermitted: false } },
      "RELEASE_WITHOUT_LOST_MAINTENANCE_ACK"],
      ["pre-dispatch-fabricated", { outcome: "terminal-pre-dispatch-refused", detail: { journalHeadSha256: "b".repeat(64), markerSha256: "c".repeat(64),
        planDigest: "d".repeat(64), journalRecords: 2, originalExitCode: 1, originalStage: "capture-restore", originalReason: "X", successClaimed: false,
        retryPermitted: false } }, "NOT_A_PRE_DISPATCH_REFUSAL_STATE"],
      ["not-a-date", { at: "not-a-date" }, "RELEASE_FIELDS"],
      ["non-canonical-date", { at: "2026-10-06T23:00:25Z" }, "RELEASE_FIELDS"],
      ["future-date", { at: "2099-01-01T00:00:00.000Z" }, "RELEASE_FIELDS"],
      ["string-boolean", { advancesChain: "false" }, "RELEASE_FIELDS"],
      ["advances-without-record", { outcome: "terminal-scan", advancesChain: true, examinedThrough: cur(1), examinedSha256: "e".repeat(64) }, "RELEASE_EXAMINED_BINDING"],
      ["wrong-purpose", { purpose: P(7) }, "RELEASE_FIELDS"],
    ];
    for (const [name, over, code] of cases) {
      const r = await plannedOwner();
      await writeExclusive(join(r, "control", "released", `${P(1)}.json`), release(P(1), over));
      const control = await readdir(join(r, "control"));
      expect(await refusal(acquireOwner(r, P(2), { cursor: null, revisit: false })), name).toBe(`RELEASE_RECORD_INVALID:${P(1)}:${code}`);
      expect(await refusal(requireOwner(r, P(1))), name).toContain("RELEASE_RECORD_INVALID");
      expect(await refusal(ownershipStatus(r)), name).toContain("RELEASE_RECORD_INVALID");
      expect(await readdir(join(r, "control")), name).toEqual(control);                                   // no lease-000002
    }
  });
  it("a valid release later contradicted by its facts or record bytes refuses (flipped chain claim, tampered examined record)", async () => {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false }); await declare(r, P(1));
    await examine(r, P(1), [vetoAt(0), vetoAt(1)]);
    expect((await releaseOwner(r, P(1), "terminal-scan")).advancesChain).toBe(true);
    expect(await chainFrontier(r)).toEqual(cur(1));
    const ex = join(r, "batches", P(1), "examined.json"), saved = await readFile(ex, "utf8");
    await tamper(ex, s => s.replace('"permanence":"permanent"', '"permanence":"transient"'));
    expect(await refusal(acquireOwner(r, P(2), { cursor: cur(1), revisit: false }))).toBe(`RELEASE_RECORD_INVALID:${P(1)}:EXAMINED_RECORD_INVALID:${P(1)}:EXAMINED_DISPOSITION_FIELDS`);
    await tamper(ex, () => saved.replaceAll(id(1), id(2)));                                         // internally consistent, different bytes
    expect(await refusal(acquireOwner(r, P(2), { cursor: cur(1), revisit: false }))).toBe(`RELEASE_RECORD_INVALID:${P(1)}:RELEASE_EXAMINED_BINDING`);
    await tamper(ex, () => saved);
    const rel = join(r, "control", "released", `${P(1)}.json`);
    await tamper(rel, s => s.replace('"advancesChain":true', '"advancesChain":false').replace(/"examinedThrough":\{[^}]*\}/, '"examinedThrough":null'));
    expect(await refusal(acquireOwner(r, P(2), { cursor: null, revisit: false }))).toBe(`RELEASE_RECORD_INVALID:${P(1)}:RELEASE_CHAIN_COMBINATION`);
  });
  it("complete-key semantically corrupt leases and an unreleased lease history refuse", async () => {
    const lease = (seq: number, p: string, over: Record<string, unknown>) => JSON.stringify({ contract: "native-finite-operator-owner.v1", sequence: seq, purpose: p,
      acquiredAt: now(), scope: "local-operator-state-root-only", startCursor: null, revisit: false, frontierAtAcquire: null, ...over });
    const cases: [string, string, string][] = [
      ["sequence", lease(7, P(1), {}), "LEASE_FIELDS"],
      ["acquired-not-instant", lease(1, P(1), { acquiredAt: "yesterday" }), "LEASE_FIELDS"],
      ["acquired-future", lease(1, P(1), { acquiredAt: "2099-01-01T00:00:00.000Z" }), "LEASE_FIELDS"],
      ["revisit-string", lease(1, P(1), { revisit: "no" }), "LEASE_FIELDS"],
      ["scope", lease(1, P(1), { scope: "global-database-lock" }), "LEASE_FIELDS"],
      ["ahead-of-frontier", lease(1, P(1), { startCursor: cur(5), frontierAtAcquire: cur(1) }), "LEASE_CHAIN_COMBINATION"],
      ["cursor-without-frontier", lease(1, P(1), { startCursor: cur(1) }), "LEASE_CHAIN_COMBINATION"],
      ["revisit-not-behind", lease(1, P(1), { startCursor: cur(1), frontierAtAcquire: cur(1), revisit: true }), "LEASE_CHAIN_COMBINATION"],
    ];
    for (const [name, bytes, code] of cases) {
      const r = await root();
      await mkdir(join(r, "control", "released"), { recursive: true, mode: 0o700 });
      await writeExclusive(join(r, "control", "lease-000001.json"), bytes);
      expect(await refusal(acquireOwner(r, P(2), { cursor: null, revisit: false })), name).toBe(`LEASE_RECORD_INVALID:1:${code}`);
    }
    const r = await root();
    await mkdir(join(r, "control", "released"), { recursive: true, mode: 0o700 });
    await writeExclusive(join(r, "control", "lease-000001.json"), lease(1, P(1), {}));
    await writeExclusive(join(r, "control", "lease-000002.json"), lease(2, P(2), {}));
    expect(await refusal(acquireOwner(r, P(3), { cursor: null, revisit: false }))).toBe("LEASE_HISTORY_UNRELEASED:1");
    const r2 = await root();
    await mkdir(join(r2, "control", "released"), { recursive: true, mode: 0o700 });
    await writeExclusive(join(r2, "control", "lease-000001.json"), lease(1, P(1), {}));
    await writeExclusive(join(r2, "control", "lease-000002.json"), lease(2, P(1), {}));
    expect(await refusal(acquireOwner(r2, P(3), { cursor: null, revisit: false }))).toBe("LEASE_RECORD_INVALID:2:LEASE_FIELDS");
  });
  it("examined records must match their selection declaration and lease before they can exist; markers are exact", async () => {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false }); await declare(r, P(1));
    const sel = await readFile(join(r, "batches", P(1), "selection.json"));
    const good = { startCursor: null, revisit: false, selectionSha256: sha256(sel), cutoffObservedAt: CUTOFF, limit: 32, maxUnits: 8, windowSize: 1,
      dispositions: [vetoAt(0)], ...settledPrefix(null, [cur(0)], [vetoAt(0)], null) };
    const bad: [string, Record<string, unknown>, string][] = [
      ["selection-sha", { selectionSha256: "f".repeat(64) }, "EXAMINED_RECORD_FIELDS"],
      ["limit-mismatch", { limit: 16 }, "EXAMINED_SELECTION_MISMATCH"],
      ["lease-revisit", { revisit: true }, "EXAMINED_LEASE_MISMATCH"],
      ["through", { examinedThrough: cur(5) }, "EXAMINED_THROUGH"],
      ["permanence", { dispositions: [{ ...vetoAt(0), permanence: "transient" }] }, "EXAMINED_DISPOSITION_FIELDS"],
      ["window", { windowSize: 2 }, "EXAMINED_BREAK_CANDIDATE"],
      ["transient-list", { transientVetoes: [cur(0)] }, "EXAMINED_TRANSIENT_VETOES"],
    ];
    for (const [name, over, code] of bad) expect(await refusal(recordExamined(r, P(1), { ...good, ...over })), name).toBe(`EXAMINED_SELF_CHECK:${code}`);
    expect(await refusal(recordExamined(r, P(1), good))).toBe("NO_REFUSAL");
    const r2 = await root();
    await declare(r2, P(2), { plan: plan(P(2)) });
    await journalOf(r2, P(2), plan(P(2)), [], null, result(P(2), 0, false));
    await tamper(join(r2, "purposes", `${P(2)}.json`), s => s.replace(`"purpose":"${P(2)}"`, `"purpose":"${P(2)}","extra":1`));
    expect(await refusal(acquireOwner(r2, P(9), { cursor: null, revisit: false }))).toBe(`PURPOSE_MARKER_INVALID:${P(2)}:MARKER_SHAPE`);
  });
});

describe("D149 safe abandon against the real journal begin", () => {
  it("abandon first: the consumed marker is taken, begin can never run, the chain does not advance", async () => {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false });
    await declare(r, P(1), { plan: plan(P(1), 1) });
    await examine(r, P(1), [{ candidate: { asOfDate: "2026-09-01", jobRunId: id(1) }, outcome: "unit" }]);
    const out = await abandonOwnedPurpose(r, P(1));
    expect([out.release.outcome, out.release.advancesChain, out.chainAdvanced, out.preD149Unleased]).toEqual(["abandoned", false, false, false]);
    expect(await refusal(new FileBatchJournal(join(r, "batches", P(1), "journal"), join(r, "purposes")).begin(plan(P(1), 1)))).toContain("EEXIST");
    expect(await purposeState(r, P(1))).toBe("abandoned");
    expect(await chainFrontier(r)).toBeNull();
    expect(await refusal(requireOwner(r, P(1)))).toBe("OWNER_LEASE_REQUIRED");
  });
  it("begin first: abandon is refused and the journal is untouched", async () => {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false });
    await declare(r, P(1), { plan: plan(P(1)) });
    await journalOf(r, P(1), plan(P(1)), [], null, null);
    const before = await bytesOf(join(r, "batches", P(1), "journal"));
    expect(await refusal(abandonOwnedPurpose(r, P(1)))).toBe("PURPOSE_EXECUTION_STARTED_NOT_ABANDONABLE");
    expect(await bytesOf(join(r, "batches", P(1), "journal"))).toEqual(before);
  });
  it("migration: a never-leased pre-D149 plan is abandonable only while no owner is active; a leased or begun one is not", async () => {
    const r = await root();
    await declare(r, P(1), { plan: plan(P(1)) });
    expect(await refusal(acquireOwner(r, P(9), { cursor: null, revisit: false }))).toBe(`OTHER_PURPOSE_OPEN:${P(1)}:planned`);
    const out = await abandonOwnedPurpose(r, P(1));
    expect([out.preD149Unleased, out.release.outcome, out.release.advancesChain]).toEqual([true, "abandoned", false]);
    await acquireOwner(r, P(9), { cursor: null, revisit: false });
    await declare(r, P(2), { plan: plan(P(2)) });
    expect(await refusal(abandonOwnedPurpose(r, P(2)))).toBe("OWNER_LEASE_REQUIRED");
    const r2 = await root();
    await declare(r2, P(3), { plan: plan(P(3)) }); await journalOf(r2, P(3), plan(P(3)), [], null, result(P(3), 1, false));
    expect(await refusal(abandonOwnedPurpose(r2, P(3)))).toBe("PURPOSE_EXECUTION_STARTED_NOT_ABANDONABLE");
    expect(await refusal(abandonOwnedPurpose(r2, P(4)))).toBe("OWNER_LEASE_REQUIRED");
  });
  it("concurrent abandon and begin: exactly one wins, every time", async () => {
    for (let i = 0; i < 16; i++) {
      const r = await root();
      await acquireOwner(r, P(1), { cursor: null, revisit: false });
      await declare(r, P(1), { plan: plan(P(1)) });
      const j = new FileBatchJournal(join(r, "batches", P(1), "journal"), join(r, "purposes"));
      const [a, b] = await Promise.allSettled([abandonOwnedPurpose(r, P(1)), j.begin(plan(P(1)))]);
      expect([a.status, b.status].filter(s => s === "fulfilled")).toHaveLength(1);
      expect(await purposeState(r, P(1))).toBe(a.status === "fulfilled" ? "abandoned" : "running");
    }
  });
});

describe("RC-O2: a lost maintenance ACK is settled only by a bound live SELECT-only proof (never a checkbox)", () => {
  const FB9 = "fb9f2dc56bcb";
  const context = { expectedDatabase: "nsb_source_fixture", operatorRevision: "a".repeat(40), runtimeRevision: "d".repeat(40), sourceManifestSha256: "f".repeat(64) };
  async function fb9(o: { skipRetireOf?: number } = {}) {
    const r = await root(), configs = [0, 1].map(i => ({ generation: gen(i), evaluations: 10, contexts: 1, frozen: `config-${i}` }));
    const pl = plan(FB9, 2, V1, configs.map(c => canonicalSha(c))), ids = pl.units.map(u => u.generation.jobRunId);
    await declare(r, FB9, { plan: pl });
    await mkdir(join(r, "batches", FB9, "units"), { mode: 0o700 });
    for (const c of configs) await writeExclusive(join(r, "batches", FB9, "units", `${c.generation.jobRunId}.config.json`), JSON.stringify(c));
    const acked: [NativeStorageStage, string[]][] = [["capture-restore", [ids[0]!]], ["capture-restore", [ids[1]!]], ["publish", ids], ["activate", ids]];
    for (const [i, u] of ids.entries()) if (o.skipRetireOf !== i) acked.push(["retire", [u]], ["independent-readback", [u]]);
    if (o.skipRetireOf === undefined) acked.push(["vacuum-main", ids]);
    await journalOf(r, FB9, pl, acked, [o.skipRetireOf === undefined ? "vacuum-toast" as NativeStorageStage : "vacuum-main", ids],
      result(FB9, 1, true, { contract: V1, stage: "vacuum-toast", reason: "UNKNOWN_ACK", retired: ids }));
    await new Promise(res => setTimeout(res, 5));
    return { r, configs };
  }
  /** A proof shaped exactly as collectMaintenanceSettlement returns it (the collector itself runs on owned PostgreSQL in the e2e). */
  const proofFor = (binding: SettlementBinding, over: (p: any) => void = () => undefined, at = new Date().toISOString()) => {
    const p: any = { contract: SETTLEMENT_CONTRACT, binding, collector: { application: SETTLEMENT_APPLICATION, collectedAt: at },
      database: { name: binding.expectedDatabase, user: "nsb_owner", sessionUser: "nsb_owner", superuser: true, readAllStats: true, serverVersionNum: 160015,
        systemIdentifier: "7412345678901234567", postmasterStartedAt: "2026-10-01T00:00:00.000Z", backendPid: 4242 },
      transaction: { readOnly: "on", isolation: "repeatable read", statementTimeout: "7500ms", lockTimeout: "1s", observedAt: at, rollbackAcknowledged: true },
      visibility: { fullBackendVisibility: true, visibleBackends: 7, insufficientPrivilegeBackends: 0 },
      targets: { mainRelations: 2, relationOids: [16401, 16402, 16403, 16404] },
      backends: { ownedOperatorBackends: 0, maintenanceQueryBackends: 0, maintenanceProgressRows: 0, maintenanceModeTargetLocks: 0 },
      units: binding.units.map(u => ({ jobRunId: u.jobRunId, exactUnitAbsent: true, retainedRootsFullBytesMatch: true, readbackRollbackAcknowledged: true })),
      actualExitCode: 0, errors: [] };
    over(p); return p;
  };
  it("root's exact checkbox-only evidence shape is refused and nothing is written", async () => {
    const { r } = await fb9();
    expect(await purposeState(r, FB9)).toBe("maintenance-ack-unknown");
    expect(await refusal(acquireOwner(r, P(9), { cursor: null, revisit: false }))).toBe(`OTHER_PURPOSE_OPEN:${FB9}:maintenance-ack-unknown`);
    const before = await readdir(join(r, "batches", FB9));
    expect(await refusal(disposeUnacknowledgedMaintenance(r, FB9, context, async () => ({ readOnly: true, observedAt: new Date().toISOString() }))))
      .toBe("SETTLEMENT_PROOF_SHAPE");
    expect([await readdir(join(r, "batches", FB9)), await readdir(join(r, "control", "released"))]).toEqual([before, []]);
  });
  it("every missing or contrary settlement fact refuses with its own code; nothing is written", async () => {
    const { r } = await fb9();
    const cases: [string, (p: any, b: SettlementBinding) => void, string, (() => number)?][] = [
      ["wrong-purpose-binding", p => { p.binding = { ...p.binding, purpose: P(5) }; }, "SETTLEMENT_BINDING_MISMATCH"],
      ["wrong-plan", p => { p.binding = { ...p.binding, planDigest: "0".repeat(64) }; }, "SETTLEMENT_BINDING_MISMATCH"],
      ["wrong-stage", p => { p.binding = { ...p.binding, unacknowledged: { ...p.binding.unacknowledged, stage: "vacuum-main" } }; }, "SETTLEMENT_BINDING_MISMATCH"],
      ["wrong-marker", p => { p.binding = { ...p.binding, markerSha256: "0".repeat(64) }; }, "SETTLEMENT_BINDING_MISMATCH"],
      ["wrong-runtime", p => { p.binding = { ...p.binding, runtimeRevision: "e".repeat(40) }; }, "SETTLEMENT_BINDING_MISMATCH"],
      ["wrong-database", p => { p.database.name = "postgres"; }, "SETTLEMENT_WRONG_DATABASE"],
      ["no-visibility", p => { p.database.superuser = false; p.database.readAllStats = false; p.visibility.fullBackendVisibility = false; }, "BACKEND_VISIBILITY_UNAVAILABLE"],
      ["claimed-visibility", p => { p.database.superuser = false; p.database.readAllStats = false; }, "BACKEND_VISIBILITY_UNAVAILABLE"],
      ["ambiguous-visibility", p => { p.visibility.insufficientPrivilegeBackends = 1; }, "BACKEND_VISIBILITY_AMBIGUOUS"],
      ["owned-backend", p => { p.backends.ownedOperatorBackends = 1; }, "OWNED_OPERATOR_BACKEND_PRESENT"],
      ["active-maintenance", p => { p.backends.maintenanceQueryBackends = 1; }, "MAINTENANCE_BACKEND_ACTIVE"],
      ["progress", p => { p.backends.maintenanceProgressRows = 1; }, "MAINTENANCE_PROGRESS_ON_TARGET"],
      ["lock", p => { p.backends.maintenanceModeTargetLocks = 2; }, "TARGET_MAINTENANCE_LOCK_PRESENT"],
      ["not-read-only", p => { p.transaction.readOnly = "off"; }, "READ_ONLY_TRANSACTION_REQUIRED"],
      ["no-rollback", p => { p.transaction.rollbackAcknowledged = false; }, "ROLLBACK_ACK_REQUIRED"],
      ["exit", p => { p.actualExitCode = 1; }, "SETTLEMENT_COLLECTOR_NOT_EXIT_ZERO"],
      ["errors", p => { p.errors = ["57014"]; }, "SETTLEMENT_COLLECTOR_NOT_EXIT_ZERO"],
      ["not-retired", p => { p.units[1].exactUnitAbsent = false; }, "RETIREMENT_NOT_INDEPENDENTLY_OBSERVED"],
      ["roots", p => { p.units[0].retainedRootsFullBytesMatch = false; }, "RETAINED_ROOTS_NOT_BYTE_EQUAL"],
      ["readback-rollback", p => { p.units[0].readbackRollbackAcknowledged = false; }, "ROLLBACK_ACK_REQUIRED"],
      ["units", p => { p.units.pop(); }, "SETTLEMENT_UNITS_MISMATCH"],
      ["before-journal-end", (p, b) => { const t = new Date(Date.parse(b.journalFinishedAt) - 1000).toISOString(); p.transaction.observedAt = t; p.collector.collectedAt = t; },
        "EVIDENCE_MUST_POSTDATE_JOURNAL_END"],
      ["stale", () => undefined, "STALE_EVIDENCE", () => Date.now() + 11 * 60_000],
      ["future", p => { const t = new Date(Date.now() + 5 * 60_000).toISOString(); p.transaction.observedAt = t; p.collector.collectedAt = t; }, "FUTURE_EVIDENCE"],
      ["skew", p => { p.collector.collectedAt = new Date(Date.now() - 2 * 60_000).toISOString(); }, "COLLECTOR_CLOCK_SKEW"],
      ["non-canonical-time", p => { p.transaction.observedAt = "2026-10-07 01:00:00+00"; }, "SETTLEMENT_PROOF_MALFORMED"],
      ["malformed", p => { p.database.serverVersionNum = "160015"; }, "SETTLEMENT_PROOF_MALFORMED"],
      ["extra-key", p => { p.trustMe = true; }, "SETTLEMENT_PROOF_SHAPE"],
      ["isolation", p => { p.transaction.isolation = "read committed"; }, "READ_ONLY_TRANSACTION_REQUIRED"],
    ];
    const before = await readdir(join(r, "batches", FB9));
    for (const [name, mutate, code, clock] of cases) {
      const out = await refusal(disposeUnacknowledgedMaintenance(r, FB9, context, async b => proofFor(b, p => mutate(p, b)), clock));
      expect(out, name).toBe(code);
    }
    expect(await refusal(disposeUnacknowledgedMaintenance(r, FB9, context, async () => { throw new Error("57014"); }))).toBe("57014");
    expect([await readdir(join(r, "batches", FB9)), await readdir(join(r, "control", "released"))]).toEqual([before, []]);
  });
  it("a complete bound proof records UNKNOWN (never success/retry), preserves history and unblocks; later tamper refuses", async () => {
    const { r, configs } = await fb9();
    const journal = join(r, "batches", FB9, "journal"), before = { j: await bytesOf(journal), m: await bytesOf(join(r, "purposes")) };
    let seen: unknown[] = [];
    const out = await disposeUnacknowledgedMaintenance(r, FB9, context, async (b, c) => { seen = c; return proofFor(b); });
    expect(seen).toEqual(configs);                                                                       // exact frozen configs reach the collector
    expect([out.release.outcome, out.release.advancesChain, (out.release.detail as any).successClaimed, (out.release.detail as any).retryPermitted,
      (out.release.detail as any).unacknowledgedStage]).toEqual(["terminal-maintenance-outcome-unknown", false, false, false, "vacuum-toast"]);
    expect({ j: await bytesOf(journal), m: await bytesOf(join(r, "purposes")) }).toEqual(before);
    expect(await purposeState(r, FB9)).toBe("maintenance-ack-unknown");
    expect((await ownershipStatus(r)).purposes[FB9]).toBe("released:terminal-maintenance-outcome-unknown");
    expect(await refusal(disposeUnacknowledgedMaintenance(r, FB9, context, async b => proofFor(b)))).toBe("PURPOSE_ALREADY_RELEASED");
    expect(await refusal(acquireOwner(r, P(9), { cursor: null, revisit: false }))).toBe("NO_REFUSAL");
    const proofFile = join(r, "batches", FB9, `maintenance-settlement-${(out.release.detail as any).settlementProofSha256}.json`);
    await tamper(proofFile, s => s.replace('"ownedOperatorBackends":0', '"ownedOperatorBackends":1'));
    expect(await refusal(requireOwner(r, P(9)))).toBe(`RELEASE_RECORD_INVALID:${FB9}:RELEASE_SETTLEMENT_BYTES`);
  });
  it("is refused when a retirement was not acknowledged, or for routing-unknown purposes", async () => {
    const { r } = await fb9({ skipRetireOf: 1 });
    expect(await refusal(disposeUnacknowledgedMaintenance(r, FB9, context, async b => proofFor(b)))).toBe("EVERY_RETIREMENT_ACKNOWLEDGED_REQUIRED");
    const r2 = await root(), pl = plan(P(4)), ids = pl.units.map(u => u.generation.jobRunId);
    await declare(r2, P(4), { plan: pl });
    await journalOf(r2, P(4), pl, [["capture-restore", [ids[0]!]], ["capture-restore", [ids[1]!]], ["publish", ids], ["activate", ids]], ["retire", [ids[0]!]],
      result(P(4), 1, true));
    expect(await refusal(disposeUnacknowledgedMaintenance(r2, P(4), context, async b => proofFor(b)))).toBe("ONLY_UNACKNOWLEDGED_POST_RETIREMENT_MAINTENANCE_IS_DISPOSABLE");
  });
});

describe("Addendum: terminal pre-dispatch refusal (5aa1-shaped legacy) is strictly zero-action", () => {
  const LG = "5aa13653f41b", REFUSED = { contract: V1, stage: "capture-restore", reason: "MAINTENANCE_REFUSED:app_physical_reserve" };
  async function legacy(o: { acked?: [NativeStorageStage, string[]][]; pending?: [NativeStorageStage, string[]] | null; fin?: NativeStorageBatchResult | null } = {}) {
    const r = await root(), pl = plan(LG, 1, V1);
    await mkdir(join(r, "batches", LG), { mode: 0o700 });
    await writeExclusive(join(r, "batches", LG, "plan.json"), JSON.stringify(pl));
    const fin = o.fin === undefined ? result(LG, 1, false, REFUSED) : o.fin;
    await journalOf(r, LG, pl, o.acked ?? [], o.pending ?? null, fin);
    if (fin) await writeExclusive(join(r, "batches", LG, `result-${Date.now()}.json`), JSON.stringify(fin));
    await mkdir(join(r, "batches", LG, "remote"), { mode: 0o700 });
    await writeExclusive(join(r, "batches", LG, "remote", "db-0001-evidence-sample-capacity.json"), "{}");     // read-only pre-intent evidence send
    return { r, pl };
  }
  it("the actual shape is disposed as terminal-pre-dispatch-refused; bytes preserved, no success, no retry, no chain", async () => {
    const { r } = await legacy();
    expect(await purposeState(r, LG)).toBe("resumable");
    expect(await refusal(acquireOwner(r, P(9), { cursor: null, revisit: false }))).toBe(`OTHER_PURPOSE_OPEN:${LG}:resumable`);
    const before = { b: await bytesOf(join(r, "batches", LG)), j: await bytesOf(join(r, "batches", LG, "journal")), m: await bytesOf(join(r, "purposes")) };
    const out = await disposePreDispatchRefused(r, LG);
    expect([out.release.outcome, out.release.advancesChain, out.release.detail]).toEqual(["terminal-pre-dispatch-refused", false,
      { ...out.release.detail, journalRecords: 2, originalExitCode: 1, originalStage: "capture-restore", originalReason: REFUSED.reason, successClaimed: false,
        retryPermitted: false }]);
    expect({ b: await bytesOf(join(r, "batches", LG)), j: await bytesOf(join(r, "batches", LG, "journal")), m: await bytesOf(join(r, "purposes")) }).toEqual(before);
    expect(await purposeState(r, LG)).toBe("resumable");                                                // history unchanged, never "finished"
    expect(await refusal(abandonOwnedPurpose(r, LG))).toBe("OWNER_LEASE_REQUIRED");                      // released: never abandoned/reused
    expect(await refusal(requireOwner(r, LG))).toBe("OWNER_LEASE_REQUIRED");                             // can never resume
    expect(await refusal(disposePreDispatchRefused(r, LG))).toBe("PURPOSE_ALREADY_RELEASED");
    expect(await refusal(acquireOwner(r, P(9), { cursor: null, revisit: false }))).toBe("NO_REFUSAL");
    await writeExclusive(join(r, "batches", LG, "activation.json"), "{}");                              // facts are re-proved on every read
    expect(await refusal(requireOwner(r, P(9)))).toBe(`RELEASE_RECORD_INVALID:${LG}:PRE_DISPATCH_EXECUTION_ARTIFACT_PRESENT:activation.json`);
  });
  it("is refused for any action, unknown ACK, running, status-only, success, retirement, resume, bad chain or execution artifact", async () => {
    const id1 = id(1);
    const cases: [string, () => Promise<{ r: string }>, string][] = [
      ["intent-and-receipt", () => legacy({ acked: [["capture-restore", [id1]]] }), "PRE_DISPATCH_REQUIRES_EXACTLY_BEGIN_AND_FINISH"],
      ["ack-unknown", () => legacy({ pending: ["capture-restore", [id1]], fin: result(LG, 1, true, REFUSED) }), "NOT_A_PRE_DISPATCH_REFUSAL_STATE"],
      ["running", () => legacy({ fin: null }), "NOT_A_PRE_DISPATCH_REFUSAL_STATE"],
      ["status-only", () => legacy({ fin: result(LG, 1, true, REFUSED) }), "NOT_A_PRE_DISPATCH_REFUSAL_STATE"],
      ["finished-exit-0", () => legacy({ fin: result(LG, 0, false, { contract: V1 }) }), "NOT_A_PRE_DISPATCH_REFUSAL_STATE"],
      ["retired-something", () => legacy({ fin: result(LG, 1, false, { ...REFUSED, retired: [id1] }) }), "PRE_DISPATCH_RESULT_REQUIRED"],
      ["later-stage", () => legacy({ fin: result(LG, 1, false, { ...REFUSED, stage: "retire" }) }), "PRE_DISPATCH_RESULT_REQUIRED"],
      ["resumed-once", async () => { const x = await legacy();
        const j = new FileBatchJournal(join(x.r, "batches", LG, "journal"), join(x.r, "purposes"), "resume"); await j.begin(x.pl); await j.finish(result(LG, 1, false, REFUSED));
        return x; }, "PRE_DISPATCH_REQUIRES_EXACTLY_BEGIN_AND_FINISH"],
      ["bad-chain", async () => { const x = await legacy(); await tamper(join(x.r, "batches", LG, "journal", "0001-begin.json"), s => s.replace('"evaluations":10', '"evaluations":11'));
        return x; }, "JOURNAL_CHAIN_BROKEN"],
      ["activation", async () => { const x = await legacy(); await writeExclusive(join(x.r, "batches", LG, "activation.json"), "{}"); return x; },
        "PRE_DISPATCH_EXECUTION_ARTIFACT_PRESENT:activation.json"],
      ["capture-dir", async () => { const x = await legacy(); await mkdir(join(x.r, "batches", LG, "units", id1), { recursive: true }); return x; },
        `PRE_DISPATCH_EXECUTION_ARTIFACT_PRESENT:units/${id1}`],
      ["stage-dispatch", async () => { const x = await legacy(); await writeExclusive(join(x.r, "batches", LG, "remote", "app-0002-capture-restore-db.json"), "{}"); return x; },
        "PRE_DISPATCH_EXECUTION_DISPATCH_RECORDED:app-0002-capture-restore-db.json"],
      ["copies", async () => { const x = await legacy(); await mkdir(join(x.r, "copies", LG), { recursive: true }); return x; }, "PRE_DISPATCH_EXECUTION_ARTIFACT_PRESENT:copies"],
      ["result-copy", async () => { const x = await legacy(); await writeExclusive(join(x.r, "batches", LG, "result-1.json"), JSON.stringify(result(LG, 1, false))); return x; },
        "PRE_DISPATCH_RESULT_COPY_MISMATCH:result-1.json"],
    ];
    for (const [name, arrange, code] of cases) {
      const { r } = await arrange();
      expect(await refusal(disposePreDispatchRefused(r, LG)), name).toContain(code);
      expect(await readdir(join(r, "control", "released")), name).toEqual([]);
    }
    const r = await root();                                                                              // another active owner
    await acquireOwner(r, P(1), { cursor: null, revisit: false });
    const pl = plan(LG, 1, V1); await mkdir(join(r, "batches", LG), { mode: 0o700 });
    await journalOf(r, LG, pl, [], null, result(LG, 1, false, REFUSED));
    expect(await refusal(disposePreDispatchRefused(r, LG))).toBe(`OWNER_LEASE_HELD:${P(1)}`);
  });
});

describe("r2 revisit invariant: an accepted acquisition can never write a lease the reader refuses", () => {
  /** Frontier F = cur(f) through the real helpers: P1 terminal-scans one settled veto at F. */
  async function withFrontier(f: number) {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false }); await declare(r, P(1));
    await examine(r, P(1), [vetoAt(f)]); await releaseOwner(r, P(1), "terminal-scan");
    return r;
  }
  it("root's measured sequence: equal-frontier revisit is refused before any lease; the exact continuation uses revisit=false", async () => {
    const r = await withFrontier(1);
    const control = await readdir(join(r, "control"));
    expect(await refusal(acquireOwner(r, P(2), { cursor: cur(1), revisit: true }))).toBe("REVISIT_CURSOR_MUST_BE_BEHIND_FRONTIER");
    expect(await readdir(join(r, "control"))).toEqual(control);
    expect(await ownershipStatus(r)).toMatchObject({ owner: null, leases: 1, frontier: cur(1) });
    expect(await refusal(requireOwner(r, P(2)))).toBe("OWNER_LEASE_REQUIRED");
    expect(await acquireOwner(r, P(2), { cursor: cur(1), revisit: false })).toEqual({ sequence: 2, frontier: cur(1) });
    expect(await ownershipStatus(r)).toMatchObject({ owner: P(2), leases: 2 });
    expect(JSON.parse(await readFile(join(r, "control", "lease-000002.json"), "utf8"))).toMatchObject({ purpose: P(2), startCursor: cur(1), revisit: false,
      frontierAtAcquire: cur(1) });
  });
  it("malformed requests (non-boolean revisit, non-exact cursor) are refused before anything is written", async () => {
    const r = await withFrontier(1);
    const control = await readdir(join(r, "control"));
    const bad: [string, unknown, string][] = [
      ["revisit-string", { cursor: cur(1), revisit: "true" }, "EXACT_REVISIT_FLAG"],
      ["revisit-number", { cursor: cur(1), revisit: 1 }, "EXACT_REVISIT_FLAG"],
      ["revisit-missing", { cursor: cur(1) }, "EXACT_REVISIT_FLAG"],
      ["null-request", null, "EXACT_REVISIT_FLAG"],
      ["cursor-extra-key", { cursor: { ...cur(1), extra: 1 }, revisit: false }, "EXACT_CURSOR"],
      ["cursor-non-canonical-date", { cursor: { asOfDate: "2026-9-01", jobRunId: id(1) }, revisit: false }, "EXACT_CURSOR"],
      ["cursor-uppercase-id", { cursor: { asOfDate: cur(1).asOfDate, jobRunId: id(0xabc).toUpperCase() }, revisit: false }, "EXACT_CURSOR"],
      ["cursor-string", { cursor: `${cur(1).asOfDate}:${id(1)}`, revisit: false }, "EXACT_CURSOR"],
    ];
    for (const [name, request, code] of bad) {
      expect(await refusal(acquireOwner(r, P(2), request as never)), name).toBe(code);
      expect(await readdir(join(r, "control")), name).toEqual(control);
      expect((await ownershipStatus(r)).leases, name).toBe(1);
    }
  });
  it("sweep: every accepted (cursor, revisit) leaves a readable owner; every refused one writes nothing", async () => {
    const accepted: string[] = [];
    for (const requested of [null, cur(3), cur(5), cur(7)]) for (const revisit of [false, true]) {
      const r = await withFrontier(5), control = await readdir(join(r, "control"));
      const out = await refusal(acquireOwner(r, P(2), { cursor: requested, revisit }));
      const label = `${requested ? requested.jobRunId.slice(0, 8) : "null"}/${revisit}`;
      if (out === "NO_REFUSAL") {
        accepted.push(label);
        expect(await ownershipStatus(r), label).toMatchObject({ owner: P(2), leases: 2 });
      } else {
        expect(await readdir(join(r, "control")), label).toEqual(control);
        expect(await ownershipStatus(r), label).toMatchObject({ owner: null, leases: 1 });
      }
    }
    expect(accepted.sort()).toEqual([`${id(3).slice(0, 8)}/true`, `${id(5).slice(0, 8)}/false`]);
  });
  it("the real productionPlan entry refuses an equal-frontier revisit before the lease and before any transport; exact continuation leases revisit=false", async () => {
    const r = await withFrontier(1), head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const pack = await computeSourcePack(head, REPO_ROOT, head), review = join(r, "owned-review.md"), hostFile = join(r, "host.json");
    await writeExclusive(review, `# OWNED_FIXTURE_REVIEW (unit guard; not a human or production review)\nsourceManifestSha256: ${pack.sourceManifestSha256}\nverdict: APPROVE_EXECUTION\n`);
    await writeExclusive(hostFile, JSON.stringify({ contract: "native-storage-production-host.v2", mode: "production", stateRoot: r, operatorRevision: head,
      runtimeRevision: head, prestate: { path: join(r, "absent-prestate.json"), sha256: "a".repeat(64) },
      runtimeSourceManifest: { path: join(r, "absent-manifest.json"), sha256: "b".repeat(64) },
      heldKey: { keyId: "unit", sha256: "c".repeat(64), primaryPath: join(r, "k1"), recoveryPath: join(r, "k2") },
      privateRestore: { socketDirectory: join(r, "pg-sock"), port: 5999, template: "nsb_restore_000000000000", role: "nsb_owner" },
      role: "nsb_owner", knownApplicationNames: [], databaseBudgetBytes: 1 }));
    let transportCalls = 0;
    const transport = { kind: "fixture" as const, send: async () => { transportCalls++; throw new Error("TRANSPORT_MUST_NOT_BE_REACHED"); } };
    const plan = (p: string, extra: Record<string, string>) => refusal(productionPlan({ host: hostFile, purpose: p, cutoff: CUTOFF, review, limit: "32",
      "max-units": "1", cursor: `${cur(1).asOfDate}:${cur(1).jobRunId}`, ...extra }, transport));
    expect(await plan(P(2), { revisit: "true" })).toBe("REVISIT_CURSOR_MUST_BE_BEHIND_FRONTIER");
    expect(await plan(P(3), { revisit: "yes" })).toBe("EXACT_REVISIT_FLAG");
    expect([await ownershipStatus(r).then(s => ({ owner: s.owner, leases: s.leases })), await readdir(join(r, "batches"))]).toEqual([{ owner: null, leases: 1 }, [P(1)]]);
    // Exact continuation: the lease is taken (revisit=false), then the absent pinned prestate refuses before any transport.
    expect(await plan(P(4), {})).toContain("ENOENT");
    expect(await ownershipStatus(r)).toMatchObject({ owner: P(4), leases: 2 });
    expect(JSON.parse(await readFile(join(r, "control", "lease-000002.json"), "utf8"))).toMatchObject({ purpose: P(4), revisit: false, startCursor: cur(1) });
    expect(transportCalls).toBe(0);
  }, 60_000);
});

describe("D149 examined records, frontier and interrupted release", () => {
  it("all-veto scan advances, empty scan and abandon do not; the frontier never regresses; revisit is recorded", async () => {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false }); await declare(r, P(1));
    await examine(r, P(1), []);
    expect((await releaseOwner(r, P(1), "terminal-scan")).advancesChain).toBe(false);
    await acquireOwner(r, P(2), { cursor: null, revisit: false }); await declare(r, P(2));
    await examine(r, P(2), [vetoAt(0), vetoAt(1)]);
    expect(await refusal(examine(r, P(2), [vetoAt(0), vetoAt(1)]))).toContain("EEXIST");                 // immutable
    expect((await releaseOwner(r, P(2), "terminal-scan")).advancesChain).toBe(true);
    expect(await chainFrontier(r)).toEqual(cur(1));
    expect(await refusal(acquireOwner(r, P(3), { cursor: null, revisit: false }))).toBe("CURSOR_BEHIND_CHAIN_FRONTIER_WOULD_RESCAN");
    await acquireOwner(r, P(3), { cursor: cur(0), revisit: true }); await declare(r, P(3), { cursor: cur(0) });
    expect(JSON.parse(await readFile(join(r, "control", "lease-000003.json"), "utf8"))).toMatchObject({ sequence: 3, purpose: P(3), revisit: true, startCursor: cur(0) });
    await examine(r, P(3), [vetoAt(1)], cur(0), true);
    await releaseOwner(r, P(3), "terminal-scan");
    expect(await chainFrontier(r)).toEqual(cur(1));
    await acquireOwner(r, P(4), { cursor: cur(1), revisit: false }); await declare(r, P(4), { cursor: cur(1) });
    await examine(r, P(4), [{ candidate: cur(4), outcome: "unit" }], cur(1));
    await abandonOwnedPurpose(r, P(4));
    expect(await chainFrontier(r)).toEqual(cur(1));
  });
  it("completes an interrupted release only from durable facts", async () => {
    const r = await root();
    await acquireOwner(r, P(1), { cursor: null, revisit: false }); await declare(r, P(1), { plan: plan(P(1)) });
    await journalOf(r, P(1), plan(P(1)), [], null, result(P(1), 0, false));                             // crashed before release
    await acquireOwner(r, P(2), { cursor: null, revisit: false });
    expect(JSON.parse(await readFile(join(r, "control", "released", `${P(1)}.json`), "utf8")).outcome).toBe("finished");
    await declare(r, P(2)); await examine(r, P(2), []);                                                  // terminal scan crashed before release
    await acquireOwner(r, P(3), { cursor: null, revisit: false });
    expect(JSON.parse(await readFile(join(r, "control", "released", `${P(2)}.json`), "utf8")).outcome).toBe("terminal-scan");
    await declare(r, P(3));                                                                              // planned, no record: keeps the lease
    expect(await refusal(acquireOwner(r, P(4), { cursor: null, revisit: false }))).toBe(`OWNER_LEASE_HELD:${P(3)}`);
  });
  it("owner-status is read-only and a stage-bundle-only batch directory is not a purpose", async () => {
    const r = await root();
    await mkdir(join(r, "batches", P(8), "bundle"), { recursive: true, mode: 0o700 });
    const before = await readdir(r);
    expect(await ownershipStatus(r)).toMatchObject({ readOnly: true, owner: null, purposes: {}, frontier: null });
    expect(await readdir(r)).toEqual(before);
    expect(await refusal(acquireOwner(r, P(1), { cursor: null, revisit: false }))).toBe("NO_REFUSAL");
  });
});
