import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { stableCanonicalJson } from "../../lib/creative-decision-engine/canonical-evaluation";

/** Shared, side-effect free helpers for the finite native storage batch. No
 * module in this directory connects, writes or spawns on import. */
export const EVAL = "engine_v3_ad_decision_evaluations";
export const CONTEXT = "engine_v3_ad_decision_evaluation_contexts";
export const INPUT = "engine_v3_ad_decision_input_evidence";
export const NATIVE_JOB = "engine_v3_native_ad_decisions_shadow_job";
export const CLOSED_DAY_BUFFER_MS = 38 * 60 * 60_000;
export const UNIT_TABLES = ["engine_v3_job_runs", CONTEXT, EVAL, INPUT,
  "engine_v3_ad_decision_snapshots_daily", "engine_v3_ad_campaign_context_objects",
  "engine_v3_ad_account_calibration_batches", "engine_v3_ad_account_calibration_daily"] as const;
export type UnitTable = typeof UNIT_TABLES[number];
/** Rows kept by retirement. Only the exact evaluation/context IDs are removed. */
export const RETAINED_TABLES = UNIT_TABLES.filter(t => t !== EVAL && t !== CONTEXT);
/** D150 (v3): the retained roots that stay byte-identical. Input evidence is the
 * one conditionally retired class: only frozen keys with zero global live
 * evaluation references are removed; every other frozen key stays byte-identical. */
export const BYTE_PRESERVED_TABLES = RETAINED_TABLES.filter(t => t !== INPUT);
/** Unit config v2 carries the per-key frozen input-evidence bytes; v1 configs are history only. */
export const UNIT_CONFIG_CONTRACT = "finite-native-storage-unit-config.v2" as const;
export const RETIRED_UNIT_CONFIG_CONTRACTS = Object.freeze(["finite-native-storage-unit-config.v1"] as const);
export const NON_FK_TABLES = ["meta_ads_action_log", "decision_workflow_state", "decision_workflow_events",
  "meta_automation_proposals", "meta_launch_drafts"] as const;
/** The complete measured incoming FK set. Any other FK to either table vetoes. */
export const EXPECTED_INCOMING_FKS = ["engine_v3_ad_evaluations_context_lineage_fk", "engine_v3_ad_outcomes_evaluation_fk",
  "engine_v3_ad_snapshots_evaluation_lineage_fk", "engine_v3_ad_response_episode_evaluation_fk",
  "meta_controlled_random_assignments_evaluation_fk"].sort();
export const NON_FK_CLASSES = ["action_lineage", "workflow_state", "workflow_events", "proposal_identity",
  "launch_handoff_possible_identity"].sort();
export const DECLARED_CLOSURE_GAP = "production_transitive_reader_closure_unproven";
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const SHA = /^[a-f0-9]{64}$/;

export class BatchRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = "BatchRefusal"; }
}
export function need(value: unknown, code: string): asserts value {
  if (!value) throw new BatchRefusal(code);
}
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const canonical = (value: unknown) => stableCanonicalJson(value);
export const canonicalSha = (value: unknown) => sha256(canonical(value));
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function ident(value: string) { need(/^[a-z_][a-z0-9_]*$/.test(value), "UNSAFE_IDENTIFIER"); return `"${value}"`; }
export function exactIds(values: unknown, count: number, code: string): string[] {
  need(Array.isArray(values) && values.length === count && new Set(values).size === count &&
    values.every(v => typeof v === "string" && UUID.test(v)), code);
  return [...values as string[]].sort();
}
export function rowSetHash(rows: string[]) { return sha256(JSON.stringify([...rows].sort())); }
/** Static diagnostic: a stable code and optional SQLSTATE. Never SQL, values, rows or paths. */
export function safeError(error: unknown) {
  const e = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = e instanceof BatchRefusal ? e.code
    : typeof e?.message === "string" && /^[A-Z0-9_:,-]{1,160}$/.test(e.message) ? e.message : "STAGE_REFUSED";
  return { code, sqlState: typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null };
}

/** Writes a NEW file exactly once: O_EXCL, no symlink follow, fsync file and
 * parent directory. An existing name is never replaced. */
export async function writeExclusive(filename: string, bytes: string | Uint8Array, mode = 0o400) {
  need(isAbsolute(filename) && resolve(filename) === filename, "ABSOLUTE_CANONICAL_PATH");
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.chmod(mode); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(resolve(filename, ".."));
  return sha256(typeof bytes === "string" ? Buffer.from(bytes) : bytes);
}
export async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
/** A private directory owned by this uid, not group/other accessible. */
export async function privateDirectory(directory: string) {
  need(isAbsolute(directory) && resolve(directory) === directory && directory !== "/", "PRIVATE_DIRECTORY_PATH");
  need(await realpath(directory) === directory, "PRIVATE_DIRECTORY_CANONICAL");
  const stat = await lstat(directory);
  need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(),
    "PRIVATE_DIRECTORY_OWNER_MODE");
  return directory;
}
export async function readExact(filename: string, limit: number) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    need(stat.isFile() && stat.size > 0 && stat.size <= limit && (stat.mode & 0o022) === 0, "BOUNDED_PRIVATE_FILE");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    need(bytesRead === stat.size, "FILE_CHANGED_DURING_READ");
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}
export async function sortedEntries(directory: string) { return (await readdir(directory)).sort(); }
export const pad = (n: number) => String(n).padStart(4, "0");
