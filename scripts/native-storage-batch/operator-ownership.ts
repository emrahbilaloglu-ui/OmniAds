import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_STORAGE_BATCH_CONTRACT, NATIVE_STORAGE_BATCH_LIMITS, nativeStorageBatchSchedule, nativeStoragePlanDigest,
  type NativeStorageBatchPlan } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { BatchRefusal, canonical, canonicalSha, need, pad, privateDirectory, readExact, SHA, sha256, UUID, writeExclusive } from "./common";
import { readJournal } from "./journal";
import { checkSettlementBinding, CLOCK_SKEW_MS, isInstant, verifyMaintenanceSettlement, type SettlementBinding, type SettlementProof } from "./maintenance-settlement";
import type { UnitConfig } from "./capture";

/** D149 finite operator ownership. ONE declared private operator state root holds at most one active purpose.
 * Ownership is a sequence of immutable O_EXCL lease files (control/lease-NNNNNN.json): the newest lease is the owner
 * until its purpose has an immutable release record; the next lease number can be created exactly once, so two
 * planners can never both win, and nothing is ever unlinked. Every lease, release, examined record and marker is
 * schema- AND fact-validated on every read: a record that does not match the real journal, marker, examined prefix
 * or settlement evidence it claims refuses everything instead of releasing ownership. The scope is this LOCAL
 * operator state root only: it is not a remote or global database lock. Nothing here changes a decision, budget,
 * limit, pin, copy, restore, serving proof or provider authority; nothing runs at import. */
export const OWNER_CONTRACT = "native-finite-operator-owner.v1" as const;
export const RELEASE_CONTRACT = "native-finite-operator-release.v1" as const;
export const EXAMINED_CONTRACT = "native-finite-examined-prefix.v1" as const;
export const ABANDON_CONTRACT = "native-finite-abandoned-before-execution.v1" as const;
const SELECTION_CONTRACT = "native-storage-selection-prelude.v1";
const SCOPE = "local-operator-state-root-only";
export interface Cursor { asOfDate: string; jobRunId: string }
export type Disposition = { candidate: Cursor; outcome: "unit" }
  | { candidate: Cursor; outcome: "veto"; code: string; permanence: "permanent" | "transient" };
export type PurposeState = "planned" | "running" | "resumable" | "ambiguous-routing" | "ambiguous" | "maintenance-ack-unknown"
  | "finished" | "abandoned" | "unknown";
export const RELEASE_OUTCOMES = ["finished", "terminal-scan", "abandoned", "terminal-maintenance-outcome-unknown", "terminal-pre-dispatch-refused",
  "terminal-expired-capture-only"] as const;
export type ReleaseOutcome = typeof RELEASE_OUTCOMES[number];
/** Outcomes whose settled examined prefix may advance the chain (a pre-dispatch refusal never retired its units). */
const ADVANCING = new Set<string>(["finished", "terminal-scan", "terminal-maintenance-outcome-unknown"]);

const PURPOSE = /^[a-f0-9]{12}$/, DATE = /^\d{4}-\d{2}-\d{2}$/, LEASE = /^lease-(\d{6})\.json$/;
/** An unacknowledged dispatch of these leaves routing/serving/retirement unknown: never disposable here. */
const ROUTING_OR_RETIREMENT = new Set(["capture-restore", "publish", "activate", "retire", "independent-readback"]);
/** Post-retirement maintenance only (all retirements acknowledged before it): disposable with a settlement proof. */
const MAINTENANCE = new Set(["vacuum-main", "toast-observation", "vacuum-toast", "space-readback"]);
/** Cannot become eligible under the current reviewed bounds; everything else is transient (explicit revisit). */
const PERMANENT_VETOES = new Set(["FINITE_ORIGINAL_POPULATION_EXCEEDED", "CONTEXT_COUNT_OUTSIDE_1_4", "ALREADY_ARCHIVED_ROUTE", "RETAINED_SNAPSHOT_VETO",
  "ARCHIVE_ENGINE_UNSUPPORTED"]);
const PLAN_CONTRACTS = ["finite-native-storage-batch.v1", "finite-native-storage-batch.v2"];
const OWNER_KEYS = ["contract", "sequence", "purpose", "acquiredAt", "scope", "startCursor", "revisit", "frontierAtAcquire"];
const RELEASE_KEYS = ["contract", "purpose", "outcome", "at", "advancesChain", "examinedThrough", "examinedSha256", "detail"];
const EXAMINED_KEYS = ["contract", "purpose", "startCursor", "revisit", "selectionSha256", "cutoffObservedAt", "limit", "maxUnits", "windowSize",
  "dispositions", "examinedThrough", "breakCandidate", "transientVetoes"];
const MAINTENANCE_DETAIL_KEYS = ["settlementProofSha256", "unacknowledgedStage", "journalHeadSha256", "markerSha256", "planDigest", "observedAt",
  "successClaimed", "retryPermitted"];
const PRE_DISPATCH_DETAIL_KEYS = ["journalHeadSha256", "markerSha256", "planDigest", "journalRecords", "originalExitCode", "originalStage", "originalReason",
  "successClaimed", "retryPermitted"];
const EXPIRED_CAPTURE_DETAIL_KEYS = ["journalHeadSha256", "markerSha256", "planDigest", "journalRecords", "units", "captureStageEvidenceSha256s",
  "originalStage", "originalReason", "originalStartedAt", "deadlineExpiredAt", "successClaimed", "retryPermitted", "reclaimClaimed"];
const RECEIPT_KEYS = ["purpose", "stage", "jobRunIds", "actualExitCode", "actionAcknowledged", "independentFullOriginalBytesMatch", "providerAuthority",
  "reclaimedBytes", "evidenceSha256"];
const RESULT_KEYS = ["contract", "purpose", "actualExitCode", "stage", "reason", "statusReadOnlyRequired", "retiredOriginalJobs", "providerAuthority",
  "physicalBytesReclaimed", "sustainableStorageClosed", "newWebOwnObservationRequired"];

export const vetoPermanence = (code: string) => (PERMANENT_VETOES.has(code.split(":")[0]!) ? "permanent" : "transient") as "permanent" | "transient";
export function exactCursor(value: unknown): Cursor {
  const c = value as Cursor;
  need(c && typeof c === "object" && !Array.isArray(c) && DATE.test(c.asOfDate) && UUID.test(c.jobRunId) && Object.keys(c).length === 2, "EXACT_CURSOR");
  return { asOfDate: c.asOfDate, jobRunId: c.jobRunId };
}
export function parseCursor(value: string | undefined): Cursor | null {
  if (value === undefined || value === "") return null;
  const parts = value.split(":");
  need(parts.length === 2, "EXACT_CURSOR");
  return exactCursor({ asOfDate: parts[0], jobRunId: parts[1] });
}
export const compareCursor = (a: Cursor, b: Cursor) =>
  a.asOfDate < b.asOfDate ? -1 : a.asOfDate > b.asOfDate ? 1 : a.jobRunId < b.jobRunId ? -1 : a.jobRunId > b.jobRunId ? 1 : 0;
const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const cursorOrNull = (v: unknown) => v === null ? null : exactCursor(v);
const notFuture = (v: unknown) => isInstant(v) && Date.parse(v) <= Date.now() + CLOCK_SKEW_MS;
const exactKeys = (value: unknown, keys: string[], code: string) => {
  need(value !== null && typeof value === "object" && !Array.isArray(value) && eq(Object.keys(value).sort(), [...keys].sort()), code);
  return value as Record<string, any>;
};
/** Re-labels any failure inside one record's validation with the record it concerns. */
async function guarded<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { throw new BatchRefusal(`${label}:${e instanceof BatchRefusal ? e.code : (e as NodeJS.ErrnoException)?.code ?? "UNREADABLE"}`); }
}

/** The fully settled prefix of ONE ordered selection window. The candidate that stopped the loop (maxUnits or
 * the 9,072 total) was not settled: it is reported separately and never counted as examined. */
export function settledPrefix(start: Cursor | null, ordered: Cursor[], dispositions: Disposition[], brokeAt: number | null) {
  ordered.forEach(exactCursor);
  for (let i = 1; i < ordered.length; i++) need(compareCursor(ordered[i - 1]!, ordered[i]!) < 0, "SELECTION_ORDER_REQUIRED");
  need(!start || !ordered.length || compareCursor(ordered[0]!, start) > 0, "SELECTION_NOT_AFTER_START");
  need(dispositions.length <= ordered.length && dispositions.every((d, i) => compareCursor(d.candidate, ordered[i]!) === 0),
    "DISPOSITIONS_MUST_BE_THE_ORDERED_PREFIX");
  need(brokeAt === null ? dispositions.length === ordered.length : brokeAt === dispositions.length && brokeAt < ordered.length,
    "BREAK_MUST_BE_THE_FIRST_UNSETTLED_CANDIDATE");
  return { examinedThrough: dispositions.length ? dispositions.at(-1)!.candidate : start,
    breakCandidate: brokeAt === null ? null : ordered[brokeAt]!,
    transientVetoes: dispositions.filter(d => d.outcome === "veto" && d.permanence === "transient").map(d => d.candidate) };
}

/** Chain: a new purpose starts EXACTLY at the newest released frontier (revisit=false); behind = rescan (only an
 * explicit, recorded revisit strictly behind the frontier, bounded by one selection window); ahead = silent skip of
 * unexamined candidates (never). The first chained purpose starts at the beginning. This is the same combination
 * every lease must satisfy on read, so an accepted request can never produce an unreadable lease. */
export function chainGate(requested: Cursor | null, frontier: Cursor | null, revisit: boolean) {
  need(typeof revisit === "boolean", "EXACT_REVISIT_FLAG");
  if (frontier === null) { need(requested === null && !revisit, "FIRST_CHAINED_PURPOSE_STARTS_AT_BEGINNING"); return; }
  need(requested !== null, revisit ? "EXPLICIT_REVISIT_CURSOR_REQUIRED" : "CURSOR_BEHIND_CHAIN_FRONTIER_WOULD_RESCAN");
  const c = compareCursor(exactCursor(requested), frontier);
  need(c <= 0, "CURSOR_AHEAD_OF_FRONTIER_WOULD_SKIP_UNEXAMINED");
  // An equal cursor is the exact continuation: it must be requested as such, never as a revisit.
  need(revisit ? c < 0 : c === 0, revisit ? "REVISIT_CURSOR_MUST_BE_BEHIND_FRONTIER" : "CURSOR_BEHIND_CHAIN_FRONTIER_WOULD_RESCAN");
}

const layout = (root: string) => ({ control: join(root, "control"), released: join(root, "control", "released"),
  batches: join(root, "batches"), purposes: join(root, "purposes"), copies: join(root, "copies") });
async function exists(path: string) {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw e; }
}
async function listOrEmpty(dir: string) {
  try { return (await readdir(dir)).sort(); } catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw e; }
}
async function ensurePrivate(dir: string) {
  await mkdir(dir, { mode: 0o700 }).catch(e => { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; });
  return privateDirectory(dir);
}
async function readJson(path: string, limit: number, code: string) {
  const bytes = await readExact(path, limit);
  try { return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown }; } catch { throw new BatchRefusal(code); }
}
/** Strict metadata read: regular private file (no symlink), bounded, exact contract and key set. */
async function strict(path: string, contract: string, keys: string[]) {
  const st = await lstat(path);
  need(st.isFile() && !st.isSymbolicLink(), "OWNERSHIP_METADATA_NOT_REGULAR_FILE");
  let value: Record<string, unknown>;
  try { value = JSON.parse((await readExact(path, 64 * 1024)).toString("utf8")); }
  catch (e) { throw new BatchRefusal(`OWNERSHIP_METADATA_UNREADABLE:${e instanceof BatchRefusal ? e.code : "JSON"}`); }
  need(value && typeof value === "object" && !Array.isArray(value) && value.contract === contract && eq(Object.keys(value).sort(), [...keys].sort()),
    "OWNERSHIP_METADATA_UNKNOWN_SHAPE");
  return value as Record<string, any>;
}
async function controlTree(root: string) {
  await privateDirectory(root);
  const d = layout(root);
  await ensurePrivate(d.control); await ensurePrivate(d.released);
  return d;
}

interface Lease { sequence: number; purpose: string; acquiredAt: string; startCursor: Cursor | null; revisit: boolean; frontierAtAcquire: Cursor | null }
/** Every control entry must be a lease or the release directory; the lease sequence must be gap-free from 1. */
async function leaseNames(root: string) {
  const names = await listOrEmpty(layout(root).control);
  need(names.every(n => n === "released" || LEASE.test(n)), "UNKNOWN_CONTROL_METADATA");
  const leases = names.filter(n => LEASE.test(n));
  leases.forEach((n, i) => need(Number(LEASE.exec(n)![1]) === i + 1, "LEASE_SEQUENCE_GAP"));
  return leases;
}
/** One lease's exact schema, sane acquisition instant and the chain combination chainGate admits. Used on every read
 * AND on the exact bytes acquireOwner is about to write, so the writer can never create a lease the reader refuses. */
function checkLease(value: unknown, sequence: number, seen: Set<string>): Lease {
  const o = exactKeys(value, OWNER_KEYS, "OWNERSHIP_METADATA_UNKNOWN_SHAPE");
  need(o.contract === OWNER_CONTRACT, "OWNERSHIP_METADATA_UNKNOWN_SHAPE");
  need(o.sequence === sequence && typeof o.purpose === "string" && PURPOSE.test(o.purpose) && !seen.has(o.purpose) && o.scope === SCOPE &&
    notFuture(o.acquiredAt) && typeof o.revisit === "boolean", "LEASE_FIELDS");
  const start = cursorOrNull(o.startCursor), frontier = cursorOrNull(o.frontierAtAcquire);
  need(frontier === null ? start === null && !o.revisit
    : start !== null && (o.revisit ? compareCursor(start, frontier) < 0 : compareCursor(start, frontier) === 0), "LEASE_CHAIN_COMBINATION");
  return { sequence: o.sequence, purpose: o.purpose, acquiredAt: o.acquiredAt, startCursor: start, revisit: o.revisit, frontierAtAcquire: frontier };
}
async function readLeases(root: string): Promise<Lease[]> {
  const out: Lease[] = [], seen = new Set<string>();
  for (const [i, name] of (await leaseNames(root)).entries()) out.push(await guarded(`LEASE_RECORD_INVALID:${i + 1}`, async () => {
    const lease = checkLease(await strict(join(layout(root).control, name), OWNER_CONTRACT, OWNER_KEYS), i + 1, seen);
    seen.add(lease.purpose);
    return lease;
  }));
  return out;
}
/** Leases + fact-validated releases. Every lease but the newest must be released (a new lease is only ever created
 * after its predecessor's release); the active owner is the newest lease without a release. */
async function ownershipView(root: string) {
  const leases = await readLeases(root), leased = new Map(leases.map(l => [l.purpose, l]));
  const released = await readReleases(root, leased);
  for (const l of leases.slice(0, -1)) need(released.has(l.purpose), `LEASE_HISTORY_UNRELEASED:${l.sequence}`);
  const newest = leases.at(-1) ?? null;
  return { leases, leased, released, active: newest && !released.has(newest.purpose) ? newest : null };
}
type View = Awaited<ReturnType<typeof ownershipView>>;
async function readReleases(root: string, leased: Map<string, Lease>) {
  const d = layout(root), out = new Map<string, Record<string, any>>();
  const names = await listOrEmpty(d.released);
  need(names.every(n => /^[a-f0-9]{12}\.json$/.test(n)), "UNKNOWN_RELEASE_METADATA");
  for (const name of names) {
    const purpose = name.slice(0, 12);
    out.set(purpose, await guarded(`RELEASE_RECORD_INVALID:${purpose}`, async () => {
      const r = await strict(join(d.released, name), RELEASE_CONTRACT, RELEASE_KEYS);
      await validateRelease(root, purpose, r, leased.get(purpose) ?? null);
      return r;
    }));
  }
  return out;
}
/** Every declared purpose: a batch directory holding ONLY the locally built stage-bundle cache never declared a
 * selection, never recorded a dispatch and never consumed a purpose, so it is not a purpose. */
async function declaredPurposes(root: string) {
  const d = layout(root), names = new Set<string>();
  for (const n of await listOrEmpty(d.batches)) {
    need(PURPOSE.test(n), "UNKNOWN_PURPOSE_METADATA");
    const entries = await listOrEmpty(join(d.batches, n));
    if (!(entries.length === 1 && entries[0] === "bundle")) names.add(n);
  }
  for (const n of await listOrEmpty(d.purposes)) { need(/^[a-f0-9]{12}\.json$/.test(n), "UNKNOWN_PURPOSE_METADATA"); names.add(n.slice(0, 12)); }
  return [...names].sort();
}

/** The consumed marker: the journal's begin marker for exactly this purpose and journal, or an abandon marker. */
async function markerOf(root: string, purpose: string) {
  const path = join(layout(root).purposes, `${purpose}.json`);
  if (!(await exists(path))) return null;
  return guarded(`PURPOSE_MARKER_INVALID:${purpose}`, async () => {
    const { bytes, value } = await readJson(path, 64 * 1024, "MARKER_JSON");
    const v = value as Record<string, any>;
    if (v?.contract === ABANDON_CONTRACT) {
      exactKeys(v, ["contract", "purpose", "at"], "MARKER_SHAPE");
      need(v.purpose === purpose && notFuture(v.at), "MARKER_FIELDS");
      return { kind: "abandon" as const, sha256: sha256(bytes), value: v };
    }
    exactKeys(v, ["purpose", "planDigest", "journal"], "MARKER_SHAPE");
    need(v.purpose === purpose && SHA.test(v.planDigest) && v.journal === join(layout(root).batches, purpose, "journal"), "MARKER_FIELDS");
    return { kind: "begin" as const, sha256: sha256(bytes), value: v };
  });
}

/** State from the existing on-disk artifacts only; a broken journal chain or malformed marker throws (fail closed).
 * A lost maintenance ACK is never read as "no SQL in flight": it is its own state until a settlement proof. */
export async function purposeState(root: string, purpose: string): Promise<PurposeState> {
  const d = layout(root), batch = join(d.batches, purpose), journal = join(batch, "journal");
  const marker = await markerOf(root, purpose), entries = await listOrEmpty(journal);
  // An abandon marker won the EXCL race; a begin that lost it may have left an EMPTY journal directory only.
  if (marker?.kind === "abandon") return entries.length === 0 ? "abandoned" : "unknown";
  if (entries.length === 0) return marker === null && await exists(join(batch, "selection.json")) ? "planned" : "unknown";
  if (marker?.kind !== "begin") return "unknown";
  const j = await readJournal(journal);
  if (!j.plan || nativeStoragePlanDigest(j.plan) !== marker.value.planDigest) return "unknown";
  if (!j.ended) return "running";
  if (j.finished) return "finished";
  if (j.ambiguousHistory) return "ambiguous";
  const pending = j.unacknowledgedIntent?.stage;
  if (pending) return ROUTING_OR_RETIREMENT.has(pending) ? "ambiguous-routing" : MAINTENANCE.has(pending) ? "maintenance-ack-unknown" : "ambiguous";
  if (j.lastResult?.statusReadOnlyRequired) return "ambiguous";
  const plan = j.plan as NativeStorageBatchPlan;
  need(Array.isArray(plan.units), "JOURNAL_PLAN_REQUIRED");
  return j.receipts.length < nativeStorageBatchSchedule(plan).length ? "resumable" : "unknown";
}

/** Pure examined-record validation against its write-once selection declaration, the plan (if written) and lease. */
function validateExamined(purpose: string, value: unknown, selectionBytes: Buffer, plan: NativeStorageBatchPlan | null, lease: Lease | null) {
  const e = exactKeys(value, EXAMINED_KEYS, "EXAMINED_RECORD_SHAPE");
  const start = cursorOrNull(e.startCursor);
  need(e.contract === EXAMINED_CONTRACT && e.purpose === purpose && typeof e.revisit === "boolean" && SHA.test(e.selectionSha256) &&
    e.selectionSha256 === sha256(selectionBytes) && typeof e.cutoffObservedAt === "string" && Number.isFinite(Date.parse(e.cutoffObservedAt)) &&
    Number.isInteger(e.limit) && e.limit >= 1 && e.limit <= 64 && Number.isInteger(e.maxUnits) && e.maxUnits >= 1 && e.maxUnits <= 8 &&
    Number.isInteger(e.windowSize) && e.windowSize >= 0 && e.windowSize <= e.limit && Array.isArray(e.dispositions) &&
    e.dispositions.length <= e.windowSize && Array.isArray(e.transientVetoes), "EXAMINED_RECORD_FIELDS");
  let selection: Record<string, any>;
  try { selection = JSON.parse(selectionBytes.toString("utf8")); } catch { throw new BatchRefusal("EXAMINED_SELECTION_UNREADABLE"); }
  need(selection?.contract === SELECTION_CONTRACT && selection.purpose === purpose && eq(selection.cursor, start) && selection.limit === e.limit &&
    selection.maxUnits === e.maxUnits && selection.cutoffObservedAt === e.cutoffObservedAt, "EXAMINED_SELECTION_MISMATCH");
  const dispositions: Disposition[] = e.dispositions.map((x: unknown) => {
    const o = x as Record<string, any>;
    if (o?.outcome === "unit") { exactKeys(o, ["candidate", "outcome"], "EXAMINED_DISPOSITION_SHAPE"); return { candidate: exactCursor(o.candidate), outcome: "unit" }; }
    exactKeys(o, ["candidate", "outcome", "code", "permanence"], "EXAMINED_DISPOSITION_SHAPE");
    need(o.outcome === "veto" && typeof o.code === "string" && o.code.length >= 1 && o.code.length <= 200 && o.permanence === vetoPermanence(o.code),
      "EXAMINED_DISPOSITION_FIELDS");
    return { candidate: exactCursor(o.candidate), outcome: "veto", code: o.code, permanence: o.permanence };
  });
  // Strictly increasing and strictly after the start cursor: exactly the ordered window the selection returns.
  dispositions.forEach((x, i) => {
    const before = i === 0 ? start : dispositions[i - 1]!.candidate;
    need(before === null || compareCursor(x.candidate, before) > 0, "EXAMINED_ORDER");
  });
  const through = dispositions.length ? dispositions.at(-1)!.candidate : start, brk = cursorOrNull(e.breakCandidate);
  need(eq(cursorOrNull(e.examinedThrough), through), "EXAMINED_THROUGH");
  need(brk === null ? dispositions.length === e.windowSize
    : dispositions.length < e.windowSize && (through === null || compareCursor(brk, through) > 0), "EXAMINED_BREAK_CANDIDATE");
  need(eq(e.transientVetoes, dispositions.filter(x => x.outcome === "veto" && x.permanence === "transient").map(x => x.candidate)), "EXAMINED_TRANSIENT_VETOES");
  const units = dispositions.filter(x => x.outcome === "unit").map(x => x.candidate);
  need(units.length <= e.maxUnits, "EXAMINED_UNIT_COUNT");
  if (plan) need(Array.isArray(plan.units) && eq(units.map(u => u.jobRunId).sort(), plan.units.map(u => u.generation.jobRunId).sort()) &&
    units.every(u => plan.units.some(p => p.generation.jobRunId === u.jobRunId && p.generation.asOfDate === u.asOfDate)), "EXAMINED_PLAN_UNITS");
  if (lease) need(eq(lease.startCursor, start) && lease.revisit === e.revisit, "EXAMINED_LEASE_MISMATCH");
  return { value: e, dispositions };
}
async function examinedOf(root: string, purpose: string, lease: Lease | null) {
  const batch = join(layout(root).batches, purpose), path = join(batch, "examined.json");
  if (!(await exists(path))) return null;
  return guarded(`EXAMINED_RECORD_INVALID:${purpose}`, async () => {
    const { bytes, value } = await readJson(path, 4 * 1024 * 1024, "EXAMINED_JSON");
    const plan = await exists(join(batch, "plan.json")) ? (await readJson(join(batch, "plan.json"), 1024 * 1024, "PLAN_JSON")).value as NativeStorageBatchPlan : null;
    const checked = validateExamined(purpose, value, await readExact(join(batch, "selection.json"), 64 * 1024), plan, lease);
    return { sha256: sha256(bytes), value: checked.value, dispositions: checked.dispositions };
  });
}
type Examined = Awaited<ReturnType<typeof examinedOf>>;
const chainAdvance = (outcome: string, ex: Examined) => ADVANCING.has(outcome) && !!ex && ex.dispositions.length > 0;

/** The settled facts every release outcome claims, re-proved from the real files on every read. */
async function validateRelease(root: string, purpose: string, r: Record<string, any>, lease: Lease | null) {
  need(r.purpose === purpose && (RELEASE_OUTCOMES as readonly string[]).includes(r.outcome) && notFuture(r.at) && typeof r.advancesChain === "boolean" &&
    (r.examinedSha256 === null || SHA.test(r.examinedSha256)), "RELEASE_FIELDS");
  const through = cursorOrNull(r.examinedThrough), ex = await examinedOf(root, purpose, lease);
  need(r.examinedSha256 === (ex?.sha256 ?? null), "RELEASE_EXAMINED_BINDING");
  const advances = chainAdvance(r.outcome, ex);
  need(r.advancesChain === advances && eq(through, advances ? cursorOrNull(ex!.value.examinedThrough) : null), "RELEASE_CHAIN_COMBINATION");
  const d = layout(root), batch = join(d.batches, purpose);
  switch (r.outcome as ReleaseOutcome) {
    case "finished":
      need(r.detail === null ? lease !== null : eq(r.detail, { legacyUnowned: true }) && lease === null, "RELEASE_DETAIL");
      need(await purposeState(root, purpose) === "finished", "RELEASE_WITHOUT_FINISHED_JOURNAL");
      return;
    case "terminal-scan":
      need(r.detail === null && lease !== null && ex !== null && !ex.dispositions.some(x => x.outcome === "unit"), "RELEASE_DETAIL");
      need(!(await exists(join(batch, "plan.json"))) && (await listOrEmpty(join(batch, "journal"))).length === 0 &&
        !(await exists(join(d.purposes, `${purpose}.json`))), "TERMINAL_SCAN_FACTS");
      return;
    case "abandoned":
      need(eq(r.detail, { preD149Unleased: lease === null }), "RELEASE_DETAIL");
      need(await purposeState(root, purpose) === "abandoned", "RELEASE_WITHOUT_ABANDON_MARKER");
      return;
    case "terminal-maintenance-outcome-unknown": {
      const detail = exactKeys(r.detail, MAINTENANCE_DETAIL_KEYS, "RELEASE_DETAIL");
      need(detail.successClaimed === false && detail.retryPermitted === false && SHA.test(detail.settlementProofSha256), "RELEASE_DETAIL");
      need(await purposeState(root, purpose) === "maintenance-ack-unknown", "RELEASE_WITHOUT_LOST_MAINTENANCE_ACK");
      const disk = await maintenanceJournalBinding(root, purpose);
      need(detail.unacknowledgedStage === disk.binding.unacknowledged.stage && detail.journalHeadSha256 === disk.binding.journalHeadSha256 &&
        detail.markerSha256 === disk.binding.markerSha256 && detail.planDigest === disk.binding.planDigest, "RELEASE_SETTLEMENT_BINDING");
      const { bytes, value } = await readJson(join(batch, `maintenance-settlement-${detail.settlementProofSha256}.json`), 4 * 1024 * 1024, "SETTLEMENT_JSON");
      need(sha256(bytes) === detail.settlementProofSha256, "RELEASE_SETTLEMENT_BYTES");
      const recorded = (value as { binding?: Record<string, unknown> })?.binding ?? {};
      const proof = verifyMaintenanceSettlement(value, { ...disk.binding, expectedDatabase: recorded.expectedDatabase, operatorRevision: recorded.operatorRevision,
        runtimeRevision: recorded.runtimeRevision, sourceManifestSha256: recorded.sourceManifestSha256 } as SettlementBinding, Date.parse(r.at));
      need(detail.observedAt === proof.transaction.observedAt, "RELEASE_SETTLEMENT_BINDING");
      return;
    }
    case "terminal-pre-dispatch-refused":
      need(r.detail !== null && typeof r.detail === "object" && eq(Object.keys(r.detail).sort(), [...PRE_DISPATCH_DETAIL_KEYS].sort()) &&
        eq(r.detail, { ...(await preDispatchFacts(root, purpose)), successClaimed: false, retryPermitted: false }), "RELEASE_DETAIL");
      return;
    case "terminal-expired-capture-only":
      // Expiry is re-proved against the release instant: once expired, always expired.
      need(r.detail !== null && typeof r.detail === "object" && eq(Object.keys(r.detail).sort(), [...EXPIRED_CAPTURE_DETAIL_KEYS].sort()) &&
        eq(r.detail, { ...(await expiredCaptureOnlyFacts(root, purpose, Date.parse(r.at))), successClaimed: false, retryPermitted: false,
          reclaimClaimed: false }), "RELEASE_DETAIL");
      return;
  }
}

/** Immutable release record (EXCL). It ends the purpose's lease. It is validated against the facts it claims BEFORE it
 * is written, so a release this code writes can never later be refused by the same validation. */
async function writeRelease(root: string, purpose: string, outcome: ReleaseOutcome, detail: Record<string, unknown> | null, lease: Lease | null) {
  const ex = await examinedOf(root, purpose, lease), advancesChain = chainAdvance(outcome, ex);
  const record = { contract: RELEASE_CONTRACT, purpose, outcome, at: new Date().toISOString(), advancesChain,
    examinedThrough: advancesChain ? cursorOrNull(ex!.value.examinedThrough) : null, examinedSha256: ex?.sha256 ?? null, detail };
  await guarded("RELEASE_SELF_CHECK", () => validateRelease(root, purpose, record, lease));
  await writeExclusive(join(layout(root).released, `${purpose}.json`), JSON.stringify(record), 0o400);
  return record;
}
/** A crash after a finish/abandon/terminal scan but before its release record is completed from durable facts only;
 * anything else keeps the lease. A concurrent completion of the SAME decision may win the EXCL write. */
async function completeInterruptedRelease(root: string, v: View) {
  const owner = v.active;
  if (!owner) return false;
  const state = await purposeState(root, owner.purpose), ex = await examinedOf(root, owner.purpose, owner);
  const batch = join(layout(root).batches, owner.purpose);
  const outcome: ReleaseOutcome | null = state === "finished" || state === "abandoned" ? state
    // A terminal scan recorded its unit-free prefix and can never write a plan.
    : state === "planned" && ex && !ex.dispositions.some(x => x.outcome === "unit") && !(await exists(join(batch, "plan.json"))) ? "terminal-scan" : null;
  if (!outcome) return false;
  await writeRelease(root, owner.purpose, outcome, outcome === "abandoned" ? { preD149Unleased: false } : null, owner)
    .catch(e => { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; });
  return true;
}
async function settledView(root: string) {
  const v = await ownershipView(root);
  return await completeInterruptedRelease(root, v) ? ownershipView(root) : v;
}
/** Newest frontier over fact-validated releases that advance the chain. */
export async function chainFrontier(root: string) { return frontierOf(await ownershipView(root)); }
function frontierOf(v: View) {
  let frontier: Cursor | null = null;
  for (const r of v.released.values()) {
    if (r.advancesChain !== true) continue;
    const c = exactCursor(r.examinedThrough);
    if (frontier === null || compareCursor(c, frontier) > 0) frontier = c;
  }
  return frontier;
}

/** Atomic single-owner acquisition: every other declared purpose must be released (an objectively finished,
 * never-owned legacy purpose is released as finished without a chain claim); the cursor must satisfy the chain;
 * the O_EXCL creation of the NEXT lease number is the only arbiter between concurrent planners. */
export async function acquireOwner(root: string, purpose: string, request: { cursor: Cursor | null; revisit: boolean }) {
  need(PURPOSE.test(purpose), "EXACT_PURPOSE");
  // The request itself is validated before anything is read or written: a boolean flag and an exact cursor (or null).
  need(request !== null && typeof request === "object" && typeof request.revisit === "boolean", "EXACT_REVISIT_FLAG");
  const cursor = request.cursor === null ? null : exactCursor(request.cursor);
  const d = await controlTree(root);
  let v = await settledView(root);
  need(!v.active, `OWNER_LEASE_HELD:${v.active?.purpose}`);
  need(!(await exists(join(d.batches, purpose))) && !(await exists(join(d.purposes, `${purpose}.json`))) && !v.released.has(purpose) &&
    !v.leased.has(purpose), "PURPOSE_ALREADY_DECLARED");
  let legacy = false;
  for (const p of await declaredPurposes(root)) {
    if (v.released.has(p)) continue;
    const state = await purposeState(root, p);
    if (state === "finished" && !v.leased.has(p)) {
      await writeRelease(root, p, "finished", { legacyUnowned: true }, null).catch(e => { if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e; });
      legacy = true; continue;
    }
    throw new BatchRefusal(`OTHER_PURPOSE_OPEN:${p}:${state}`);
  }
  if (legacy) v = await ownershipView(root);
  const frontier = frontierOf(v);
  chainGate(cursor, frontier, request.revisit);
  const sequence = v.leases.length + 1;
  const bytes = JSON.stringify({ contract: OWNER_CONTRACT, sequence, purpose, acquiredAt: new Date().toISOString(), scope: SCOPE, startCursor: cursor,
    revisit: request.revisit, frontierAtAcquire: frontier });
  // The exact bytes are checked by the reader's own lease validation before the EXCL write.
  checkLease(JSON.parse(bytes), sequence, new Set(v.leases.map(l => l.purpose)));
  try {
    await writeExclusive(join(d.control, `lease-${String(sequence).padStart(6, "0")}.json`), bytes, 0o400);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") throw new BatchRefusal(`OWNER_LEASE_HELD:${(await readLeases(root)).at(-1)?.purpose}`);
    throw e;
  }
  return { sequence, frontier };
}
export async function requireOwner(root: string, purpose: string) {
  await controlTree(root);
  need((await ownershipView(root)).active?.purpose === purpose, "OWNER_LEASE_REQUIRED");
}
export async function recordExamined(root: string, purpose: string, record: Record<string, unknown>) {
  await requireOwner(root, purpose);
  const batch = join(layout(root).batches, purpose), lease = (await readLeases(root)).find(l => l.purpose === purpose)!;
  const value = { contract: EXAMINED_CONTRACT, purpose, ...record };
  // The record is validated against its selection declaration and lease before it can exist.
  await guarded("EXAMINED_SELF_CHECK", async () => validateExamined(purpose, value, await readExact(join(batch, "selection.json"), 64 * 1024), null, lease));
  return writeExclusive(join(batch, "examined.json"), JSON.stringify(value), 0o400);
}
export async function releaseOwner(root: string, purpose: string, outcome: "finished" | "terminal-scan") {
  await requireOwner(root, purpose);
  return writeRelease(root, purpose, outcome, null, (await readLeases(root)).find(l => l.purpose === purpose)!);
}
/** Who may terminally dispose a purpose: its active owner, or, while no owner is active, a purpose no lease ever named. */
function disposer(v: View, purpose: string) {
  need(!v.released.has(purpose), "PURPOSE_ALREADY_RELEASED");
  if (v.active?.purpose === purpose) return v.active;
  need(v.active === null, `OWNER_LEASE_HELD:${v.active?.purpose}`);
  need(!v.leased.has(purpose), "OWNER_LEASE_REQUIRED");
  return null;
}
/** Abandon ONLY a purpose whose execution never began: the consumed marker is claimed with O_EXCL, the same file
 * FileBatchJournal.begin claims, so abandon and execute cannot both win. Never advances the chain. It is the active
 * owner's, or (migration) a pre-D149 declared purpose that no lease ever named while no owner is active: such a
 * purpose can never execute or resume under D149, which both require its lease. */
export async function abandonOwnedPurpose(root: string, purpose: string) {
  const d = await controlTree(root);
  need(PURPOSE.test(purpose), "EXACT_PURPOSE");
  const v = await settledView(root);
  const lease = v.active?.purpose === purpose ? v.active : null;
  if (!lease) need(v.active === null && !v.leased.has(purpose) && !v.released.has(purpose) && (await declaredPurposes(root)).includes(purpose),
    "OWNER_LEASE_REQUIRED");
  need((await listOrEmpty(join(d.batches, purpose, "journal"))).length === 0, "PURPOSE_EXECUTION_STARTED_NOT_ABANDONABLE");
  await ensurePrivate(d.purposes);
  try { await writeExclusive(join(d.purposes, `${purpose}.json`), JSON.stringify({ contract: ABANDON_CONTRACT, purpose, at: new Date().toISOString() }), 0o400); }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code === "EEXIST") throw new BatchRefusal("PURPOSE_EXECUTION_STARTED_NOT_ABANDONABLE"); throw e; }
  return { command: "abandon", purpose, preD149Unleased: lease === null,
    release: await writeRelease(root, purpose, "abandoned", { preD149Unleased: lease === null }, lease), chainAdvanced: false };
}

/** The settlement binding derivable from the local journal alone: purpose, exact plan digest/contract, the single
 * unacknowledged post-retirement maintenance intent, the chained journal head and the begin marker. Every planned
 * retirement and independent readback must be acknowledged. */
async function maintenanceJournalBinding(root: string, purpose: string) {
  const journal = join(layout(root).batches, purpose, "journal"), j = await readJournal(journal), plan = j.plan as NativeStorageBatchPlan;
  need(plan && plan.purpose === purpose && PLAN_CONTRACTS.includes(plan.contract) && Array.isArray(plan.units) && plan.units.length >= 1 &&
    plan.units.length <= 8, "MAINTENANCE_PLAN_REQUIRED");
  const pending = j.unacknowledgedIntent;
  need(j.ended && !j.finished && !j.ambiguousHistory && j.unacknowledgedIntents.length === 1 && pending && MAINTENANCE.has(pending.stage),
    "ONLY_UNACKNOWLEDGED_POST_RETIREMENT_MAINTENANCE_IS_DISPOSABLE");
  for (const stage of ["retire", "independent-readback"]) for (const u of plan.units)
    need(j.receipts.some(r => r.stage === stage && r.jobRunIds.length === 1 && r.jobRunIds[0] === u.generation.jobRunId), "EVERY_RETIREMENT_ACKNOWLEDGED_REQUIRED");
  const names = await listOrEmpty(journal), lastBytes = await readExact(join(journal, names.at(-1)!), 4 * 1024 * 1024);
  const last = JSON.parse(lastBytes.toString("utf8"));
  need(last.kind === "finish" && isInstant(last.at), "JOURNAL_FINISH_REQUIRED");
  const marker = await markerOf(root, purpose);
  need(marker?.kind === "begin" && marker.value.planDigest === nativeStoragePlanDigest(plan), "BEGIN_MARKER_REQUIRED");
  return { plan, binding: { purpose, planDigest: nativeStoragePlanDigest(plan), planContract: plan.contract,
    unacknowledged: { stage: pending.stage, jobRunIds: pending.jobRunIds, sequence: pending.sequence }, journalRecords: names.length,
    journalHeadSha256: sha256(lastBytes), journalFinishedAt: last.at as string, markerSha256: marker.sha256,
    units: plan.units.map(u => ({ jobRunId: u.generation.jobRunId, originalProofSha256: u.originalProofSha256 })) } };
}
export interface SettlementContext { expectedDatabase: string; operatorRevision: string; runtimeRevision: string; sourceManifestSha256: string }
/** Terminal disposition of a purpose whose ONLY unacknowledged dispatch is post-retirement maintenance. The caller's
 * collector must produce a live SELECT-only settlement proof (see maintenance-settlement.ts) for the binding derived
 * here; the proof is verified, kept write-once, and bound into the release. It records an UNKNOWN outcome: never
 * success, never a retry permission; the journal and consumed marker are not touched. */
export async function disposeUnacknowledgedMaintenance(root: string, purpose: string, context: SettlementContext,
  collect: (binding: SettlementBinding, configs: UnitConfig[]) => Promise<unknown>, clock: () => number = Date.now) {
  const d = await controlTree(root);
  need(PURPOSE.test(purpose), "EXACT_PURPOSE");
  const lease = disposer(await settledView(root), purpose);
  need(await purposeState(root, purpose) === "maintenance-ack-unknown", "ONLY_UNACKNOWLEDGED_POST_RETIREMENT_MAINTENANCE_IS_DISPOSABLE");
  const disk = await maintenanceJournalBinding(root, purpose), batch = join(d.batches, purpose);
  const binding = checkSettlementBinding({ ...disk.binding, ...context });
  const configs: UnitConfig[] = [];
  for (const u of disk.plan.units) {
    const c = (await readJson(join(batch, "units", `${u.generation.jobRunId}.config.json`), 4 * 1024 * 1024, "FROZEN_UNIT_CONFIG_JSON")).value as UnitConfig;
    need(canonicalSha(c) === u.originalProofSha256 && eq(c.generation, u.generation), "EXACT_FROZEN_UNIT_CONFIG");
    configs.push(c);
  }
  const proof: SettlementProof = verifyMaintenanceSettlement(await collect(binding, configs), binding, clock());
  const bytes = JSON.stringify(proof), proofSha256 = sha256(bytes);
  await writeExclusive(join(batch, `maintenance-settlement-${proofSha256}.json`), bytes, 0o400);
  const release = await writeRelease(root, purpose, "terminal-maintenance-outcome-unknown", { settlementProofSha256: proofSha256,
    unacknowledgedStage: binding.unacknowledged.stage, journalHeadSha256: binding.journalHeadSha256, markerSha256: binding.markerSha256,
    planDigest: binding.planDigest, observedAt: proof.transaction.observedAt, successClaimed: false, retryPermitted: false }, lease);
  return { command: "dispose-maintenance-unknown", purpose, release, settlement: { proofSha256, database: proof.database.name,
    observedAt: proof.transaction.observedAt, units: proof.units.length } };
}

/** Strict proof that a purpose never dispatched anything: its verified journal is EXACTLY begin + finish (no intent,
 * receipt, note or resume), the finish is an actual exit 1 that is not status-only and retired nothing, and the batch
 * holds no execution artifact (only plan-phase files, read-only plan/evidence actor receipts and the result copy). */
async function preDispatchFacts(root: string, purpose: string) {
  const d = layout(root), batch = join(d.batches, purpose), journal = join(batch, "journal");
  need(await purposeState(root, purpose) === "resumable", "NOT_A_PRE_DISPATCH_REFUSAL_STATE");
  const names = await listOrEmpty(journal);
  need(eq(names, ["0001-begin.json", "0002-finish.json"]), "PRE_DISPATCH_REQUIRES_EXACTLY_BEGIN_AND_FINISH");
  const j = await readJournal(journal);
  need(j.records === 2 && j.intents.length === 0 && j.receipts.length === 0 && j.unacknowledgedIntents.length === 0 && !j.ambiguousHistory &&
    j.resumes === 0 && j.notes.length === 0 && j.ended && !j.finished, "PRE_DISPATCH_ZERO_ACTION_JOURNAL_REQUIRED");
  const plan = j.plan as NativeStorageBatchPlan, result = exactKeys(j.lastResult, RESULT_KEYS, "PRE_DISPATCH_RESULT_SHAPE");
  need(plan && plan.purpose === purpose && PLAN_CONTRACTS.includes(plan.contract) && result.contract === plan.contract && result.purpose === purpose &&
    result.actualExitCode === 1 && result.statusReadOnlyRequired === false && Array.isArray(result.retiredOriginalJobs) &&
    result.retiredOriginalJobs.length === 0 && result.providerAuthority === false && result.physicalBytesReclaimed === 0 &&
    result.sustainableStorageClosed === false && result.newWebOwnObservationRequired === false &&
    (result.stage === null || result.stage === "capture-restore") && typeof result.reason === "string" && result.reason.length >= 1 &&
    result.reason.length <= 200, "PRE_DISPATCH_RESULT_REQUIRED");
  const planDigest = nativeStoragePlanDigest(plan);
  if (await exists(join(batch, "plan.json")))
    need(nativeStoragePlanDigest((await readJson(join(batch, "plan.json"), 1024 * 1024, "PLAN_JSON")).value as NativeStorageBatchPlan) === planDigest,
      "PRE_DISPATCH_PLAN_MISMATCH");
  const marker = await markerOf(root, purpose);
  need(marker?.kind === "begin" && marker.value.planDigest === planDigest, "BEGIN_MARKER_REQUIRED");
  // Allow-list: everything else (publication/activation/http-proof/stages/copies/measured outcomes/resume files) refuses.
  for (const n of await listOrEmpty(batch)) {
    if (["selection.json", "plan.json", "journal", "bundle", "examined.json"].includes(n)) continue;
    if (/^result-\d+\.json$/.test(n)) {
      need(eq((await readJson(join(batch, n), 1024 * 1024, "RESULT_JSON")).value, j.lastResult), `PRE_DISPATCH_RESULT_COPY_MISMATCH:${n}`); continue;
    }
    if (n === "units") {
      for (const u of await listOrEmpty(join(batch, n)))
        need(/^[a-f0-9-]{36}\.config\.json$/.test(u) && (await lstat(join(batch, n, u))).isFile(), `PRE_DISPATCH_EXECUTION_ARTIFACT_PRESENT:units/${u}`);
      continue;
    }
    if (n === "remote") {
      for (const x of await listOrEmpty(join(batch, n)))
        need(/^(app|db)-\d{4}-(plan|evidence)-[a-z-]+\.json$/.test(x) && (await lstat(join(batch, n, x))).isFile(), `PRE_DISPATCH_EXECUTION_DISPATCH_RECORDED:${x}`);
      continue;
    }
    throw new BatchRefusal(`PRE_DISPATCH_EXECUTION_ARTIFACT_PRESENT:${n}`);
  }
  need(!(await exists(join(d.copies, purpose))), "PRE_DISPATCH_EXECUTION_ARTIFACT_PRESENT:copies");
  const lastBytes = await readExact(join(journal, "0002-finish.json"), 4 * 1024 * 1024);
  return { journalHeadSha256: sha256(lastBytes), markerSha256: marker.sha256, planDigest, journalRecords: 2, originalExitCode: 1,
    originalStage: result.stage as string | null, originalReason: result.reason as string };
}
/** Terminal disposition of a consumed purpose that provably never dispatched an action (see preDispatchFacts). The
 * original consumed marker, plan and journal stay byte-identical; the release claims no success, permits no retry and
 * never advances the chain. */
export async function disposePreDispatchRefused(root: string, purpose: string) {
  await controlTree(root);
  need(PURPOSE.test(purpose), "EXACT_PURPOSE");
  const lease = disposer(await settledView(root), purpose);
  const facts = await preDispatchFacts(root, purpose);
  const release = await writeRelease(root, purpose, "terminal-pre-dispatch-refused", { ...facts, successClaimed: false, retryPermitted: false }, lease);
  return { command: "dispose-pre-dispatch-refused", purpose, release };
}
/** Strict proof that an EXPIRED purpose did nothing beyond capture: its verified journal is EXACTLY begin + one
 * acknowledged capture-restore intent/receipt pair per planned unit (plan order) + finish; the finish is an actual exit 1
 * at stage publish, not status-only, retiring nothing; the original 30 min batch window (journal begin) has elapsed by
 * nowMs. Each unit's stage evidence hashes to its receipt, its capture/restore records show full parity, both private
 * copies still hold every sealed part/trust/leaf, and only plan/evidence/capture-restore actor receipts exist. Any
 * publish/activate/retire/maintenance/HTTP artifact or extra/foreign entry refuses. Local files only; no network. */
async function expiredCaptureOnlyFacts(root: string, purpose: string, nowMs: number) {
  const d = layout(root), batch = join(d.batches, purpose), journal = join(batch, "journal");
  need(await purposeState(root, purpose) === "resumable", "NOT_AN_EXPIRED_CAPTURE_ONLY_STATE");
  const j = await readJournal(journal), plan = j.plan as NativeStorageBatchPlan;
  need(plan && plan.purpose === purpose && plan.contract === NATIVE_STORAGE_BATCH_CONTRACT && Array.isArray(plan.units) && plan.units.length >= 1 &&
    plan.units.length <= NATIVE_STORAGE_BATCH_LIMITS.generations, "CAPTURE_ONLY_PLAN_REQUIRED");
  const units = plan.units, ids = units.map(u => u.generation.jobRunId), names = await listOrEmpty(journal);
  need(eq(names, ["0001-begin.json", ...units.flatMap((_, i) => [`${pad(2 + 2 * i)}-intent.json`, `${pad(3 + 2 * i)}-receipt.json`]),
    `${pad(2 + 2 * units.length)}-finish.json`]), "CAPTURE_ONLY_REQUIRES_EXACT_CAPTURE_PREFIX_JOURNAL");
  need(j.resumes === 0 && j.notes.length === 0 && !j.ambiguousHistory && j.unacknowledgedIntents.length === 0 && j.ended && !j.finished &&
    j.intents.length === units.length && j.receipts.length === units.length, "CAPTURE_ONLY_ZERO_AMBIGUITY_JOURNAL_REQUIRED");
  units.forEach((u, i) => {
    const receipt = exactKeys(j.receipts[i], RECEIPT_KEYS, "CAPTURE_ONLY_ACKNOWLEDGED_RECEIPTS");
    need(j.intents[i]!.stage === "capture-restore" && eq(j.intents[i]!.jobRunIds, [ids[i]]) && receipt.purpose === purpose &&
      receipt.stage === "capture-restore" && eq(receipt.jobRunIds, [ids[i]]) && receipt.actualExitCode === 0 && receipt.actionAcknowledged === true &&
      receipt.independentFullOriginalBytesMatch === true && receipt.providerAuthority === false && receipt.reclaimedBytes === 0 &&
      SHA.test(receipt.evidenceSha256), "CAPTURE_ONLY_ACKNOWLEDGED_RECEIPTS");
  });
  const result = exactKeys(j.lastResult, RESULT_KEYS, "CAPTURE_ONLY_RESULT_SHAPE");
  need(result.contract === plan.contract && result.purpose === purpose && result.actualExitCode === 1 && result.statusReadOnlyRequired === false &&
    result.stage === "publish" && Array.isArray(result.retiredOriginalJobs) && result.retiredOriginalJobs.length === 0 && result.providerAuthority === false &&
    result.physicalBytesReclaimed === 0 && result.sustainableStorageClosed === false && result.newWebOwnObservationRequired === false &&
    typeof result.reason === "string" && result.reason.length >= 1 && result.reason.length <= 200, "CAPTURE_ONLY_PRE_PUBLISH_REFUSAL_REQUIRED");
  const planDigest = nativeStoragePlanDigest(plan);
  need(nativeStoragePlanDigest((await readJson(join(batch, "plan.json"), 1024 * 1024, "PLAN_JSON")).value as NativeStorageBatchPlan) === planDigest,
    "CAPTURE_ONLY_PLAN_MISMATCH");
  const marker = await markerOf(root, purpose);
  need(marker?.kind === "begin" && marker.value.planDigest === planDigest, "BEGIN_MARKER_REQUIRED");
  need(isInstant(j.startedAt), "CAPTURE_ONLY_ORIGINAL_START_REQUIRED");
  const deadline = Date.parse(j.startedAt!) + NATIVE_STORAGE_BATCH_LIMITS.wallMilliseconds;
  need(Number.isFinite(nowMs) && nowMs >= deadline, "PURPOSE_DEADLINE_NOT_EXPIRED");
  // Allow-list of the batch: plan phase, journal, capture stages and their actor receipts only.
  for (const n of await listOrEmpty(batch)) {
    if (["selection.json", "plan.json", "examined.json", "journal", "bundle"].includes(n)) continue;
    if (/^result-\d+\.json$/.test(n)) {
      need(eq((await readJson(join(batch, n), 1024 * 1024, "RESULT_JSON")).value, j.lastResult), `CAPTURE_ONLY_RESULT_COPY_MISMATCH:${n}`); continue;
    }
    need(["units", "stages", "remote"].includes(n), `CAPTURE_ONLY_EXECUTION_ARTIFACT_PRESENT:${n}`);
  }
  need(eq(await listOrEmpty(join(batch, "stages")), ids.map((_, i) => `${pad(i + 1)}-capture-restore.json`)), "CAPTURE_ONLY_STAGE_EVIDENCE_SET");
  need(eq(await listOrEmpty(join(batch, "units")), [...ids.map(id => `${id}.config.json`), ...ids].sort()), "CAPTURE_ONLY_UNIT_ARTIFACT_SET");
  need(eq(await listOrEmpty(join(d.copies, purpose)), [...ids].sort()), "CAPTURE_ONLY_COPY_SET");
  const captureRemote = new Set<string>();
  for (const n of await listOrEmpty(join(batch, "remote"))) {
    const m = /^(app|db)-\d{4}-(plan|evidence|capture-restore)-[a-z-]+\.json$/.exec(n);
    need(m && (await lstat(join(batch, "remote", n))).isFile(), `CAPTURE_ONLY_EXECUTION_DISPATCH_RECORDED:${n}`);
    if (m[2] !== "capture-restore") continue;
    const r = (await readJson(join(batch, "remote", n), 1024 * 1024, "REMOTE_JSON")).value as Record<string, any>;
    need(m[1] === "app" && r?.purpose === purpose && r.stage === "capture-restore" && r.op === "db" && r.actualExitCode === 0 &&
      Array.isArray(r.unitJobRunIds) && r.unitJobRunIds.length === 1 && ids.includes(r.unitJobRunIds[0]) && !captureRemote.has(r.unitJobRunIds[0]),
    `CAPTURE_ONLY_CAPTURE_DISPATCH:${n}`);
    captureRemote.add(r.unitJobRunIds[0]);
  }
  need(captureRemote.size === ids.length, "CAPTURE_ONLY_CAPTURE_DISPATCH_SET");
  for (const [i, u] of units.entries()) {
    const id = ids[i]!, unitDir = join(batch, "units", id);
    need(eq(await listOrEmpty(unitDir), ["capture.json", "restore.json"]), `CAPTURE_ONLY_UNIT_FILES:${id}`);
    const capture = (await readJson(join(unitDir, "capture.json"), 4 * 1024 * 1024, "CAPTURE_JSON")).value as Record<string, any>;
    const meta = capture?.metadata as { proofSha256: string; generation: unknown; leafSha256: string;
      parts: { ciphertextSha256: string; ciphertextBytes: number; trustSha256: string }[] };
    need(meta && meta.proofSha256 === u.originalProofSha256 && eq(meta.generation, u.generation) && SHA.test(meta.leafSha256) &&
      Array.isArray(meta.parts) && meta.parts.length >= 1, `CAPTURE_ONLY_CAPTURE_RECORD:${id}`);
    const restore = (await readJson(join(unitDir, "restore.json"), 4 * 1024 * 1024, "RESTORE_JSON")).value as Record<string, any>;
    need(restore?.frozenProofParity === true && restore.plaintextRestoreDropped === true, `CAPTURE_ONLY_RESTORE_PARITY:${id}`);
    const stageBytes = await readExact(join(batch, "stages", `${pad(i + 1)}-capture-restore.json`), 4 * 1024 * 1024);
    need(sha256(stageBytes) === j.receipts[i]!.evidenceSha256, `CAPTURE_ONLY_STAGE_EVIDENCE_BINDING:${id}`);
    const stage = JSON.parse(stageBytes.toString("utf8"));
    need(stage?.contract === "finite-native-storage-stage-evidence.v2" && stage.purpose === purpose && stage.stage === "capture-restore" &&
      stage.stageSequence === i + 1 && eq(stage.jobRunIds, [id]) && stage.planSha256 === planDigest && stage.leafSha256 === meta.leafSha256 &&
      stage.privateCopies === 2 && stage.plaintextRestoreDropped === true, `CAPTURE_ONLY_STAGE_EVIDENCE:${id}`);
    need(eq(await listOrEmpty(join(d.copies, purpose, id)), ["primary", "recovery"]), `CAPTURE_ONLY_COPY_PAIR:${id}`);
    for (const copy of ["primary", "recovery"]) {
      const dir = join(d.copies, purpose, id, copy);
      for (const part of meta.parts) {
        const bytes = await readExact(join(dir, `${part.ciphertextSha256}.bin`), 2 * 1024 * 1024 + 128);
        need(sha256(bytes) === part.ciphertextSha256 && bytes.length === part.ciphertextBytes &&
          sha256(await readExact(join(dir, `${part.ciphertextSha256}.trust.json`), 1024 * 1024)) === part.trustSha256, `CAPTURE_ONLY_COPY_PARITY:${id}:${copy}`);
      }
      need(sha256(await readExact(join(dir, `leaf-${meta.leafSha256}.json`), 16 * 1024 * 1024)) === meta.leafSha256 &&
        eq((await readJson(join(dir, "capture.json"), 4 * 1024 * 1024, "COPY_CAPTURE_JSON")).value, meta), `CAPTURE_ONLY_COPY_PARITY:${id}:${copy}`);
    }
  }
  const lastBytes = await readExact(join(journal, names.at(-1)!), 4 * 1024 * 1024);
  return { journalHeadSha256: sha256(lastBytes), markerSha256: marker.sha256, planDigest, journalRecords: names.length, units: units.length,
    captureStageEvidenceSha256s: j.receipts.map(r => r.evidenceSha256), originalStage: result.stage as string, originalReason: result.reason as string,
    originalStartedAt: j.startedAt!, deadlineExpiredAt: new Date(deadline).toISOString() };
}
/** LOCAL-ONLY terminal disposition of an EXPIRED purpose that only captured (see expiredCaptureOnlyFacts). Its journal,
 * consumed marker, plan, private copies and restores stay byte-identical. It claims no batch success, permits no retry or
 * reclaim, never advances the examined chain and ends only this purpose's own lease. */
export async function disposeExpiredCaptureOnly(root: string, purpose: string, clock: () => number = Date.now) {
  await controlTree(root);
  need(PURPOSE.test(purpose), "EXACT_PURPOSE");
  const lease = disposer(await settledView(root), purpose);
  const facts = await expiredCaptureOnlyFacts(root, purpose, clock());
  const release = await writeRelease(root, purpose, "terminal-expired-capture-only",
    { ...facts, successClaimed: false, retryPermitted: false, reclaimClaimed: false }, lease);
  return { command: "dispose-expired-capture-only", purpose, release };
}
/** Read-only: the active owner, every declared purpose's state and the chain frontier. Creates nothing. */
export async function ownershipStatus(root: string) {
  await privateDirectory(root);
  const v = await ownershipView(root), out: Record<string, string> = {};
  for (const p of await declaredPurposes(root)) out[p] = v.released.has(p) ? `released:${v.released.get(p)!.outcome}` : await purposeState(root, p);
  return { command: "owner-status", readOnly: true, scope: SCOPE, owner: v.active?.purpose ?? null, leases: v.leases.length, purposes: out, frontier: frontierOf(v) };
}
