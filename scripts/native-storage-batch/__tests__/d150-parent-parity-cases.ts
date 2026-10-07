import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BYTE_PRESERVED_TABLES, CONTEXT, EVAL, INPUT, UNIT_CONFIG_CONTRACT, UNIT_TABLES, canonicalSha, rowSetHash, safeError, sha256 } from "../common";
import { RETAINED_DEPENDENTS_CONTRACT, type UnitConfig } from "../capture";
import { INPUT_EVIDENCE_LIFECYCLE, advisoryLockParts, compareKeys, keyedDigest, producerExclusionKey } from "../input-evidence-lifecycle";
import { acceptPrepared } from "../retire";

/** TEST ONLY. D150 parent-parity cases shared by the vitest guard and the
 * pre/post evidence runner: ONE valid prepared line per world, then single-field
 * tamperings. Each case runs through the child's TypeScript acceptPrepared AND,
 * independently, the production actor's Python prepared_gate. */
type Key = [string, string];
export const PARITY_INDEX = "idx_engine_v3_ad_evaluations_contract_input";
const B = "11111111-1111-4111-8111-111111111111", J = "22222222-2222-4222-8222-222222222222";
export const parityGeneration = { businessId: B, jobRunId: J, asOfDate: "2026-09-01", engineVersion: "native-fixture" };
const h = (rows: string[]) => ({ rows: rows.length, rowByteSetSha256: rowSetHash(rows) });

/** Contract strings are the only free text in a key; ASCII in production, arbitrary text here. */
export function parityWorld(contracts: string[], order: "js" | "codepoint" = "js") {
  const raw = contracts.map((cv, i) => [cv, (i + 10).toString(16).padStart(2, "0").repeat(32)] as Key);
  const keys = order === "js" ? [...raw].sort(compareKeys)
    : [...raw].sort((a, b) => { const x = [...JSON.stringify(a)].map(c => c.codePointAt(0)!), y = [...JSON.stringify(b)].map(c => c.codePointAt(0)!);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return x.length - y.length; });
  const bytes = new Map(keys.map(k => [JSON.stringify(k), JSON.stringify({ contract_version: k[0], input_hash: k[1], input_evidence_json: { cv: k[0] } })]));
  const byteOf = (k: Key) => bytes.get(JSON.stringify(k))!, shaOf = (k: Key) => sha256(byteOf(k));
  const tableHashes = Object.fromEntries(UNIT_TABLES.map(t => [t, h([`${t}-row`])])) as UnitConfig["tableHashes"];
  tableHashes[INPUT] = h(keys.map(byteOf));
  const config: UnitConfig = { contract: UNIT_CONFIG_CONTRACT, generation: { ...parityGeneration }, evaluations: 1, contexts: 1,
    evaluationIds: ["33333333-3333-4333-8333-333333333333"], contextIds: ["44444444-4444-4444-8444-444444444444"], inputKeys: keys,
    campaignObjectHashes: [], jobIds: [J], batchIds: [], cellIds: [], tableHashes, evaluationRowSha256: {}, jobFinishedAt: "2026-09-01T02:00:00Z",
    schemaHash: "d".repeat(64), catalogFingerprint: "e".repeat(64), consumerInventorySha256: "f".repeat(64),
    retainedDependents: { contract: RETAINED_DEPENDENTS_CONTRACT, jobIds: [], rows: 0, rowByteSetSha256: rowSetHash([]), dependencyForeignKey: null },
    inputEvidence: { lifecycle: INPUT_EVIDENCE_LIFECYCLE, rowSha256: keys.map(shaOf), catalogFingerprint: "9".repeat(64) } };
  const prepared = (deleted: Key[]) => {
    const ids = new Set(deleted.map(k => JSON.stringify(k))), shared = keys.filter(k => !ids.has(JSON.stringify(k)));
    const part = (ks: Key[]) => ({ keys: ks.length, keysSha256: sha256(JSON.stringify(ks)), rows: ks.length,
      rowByteSetSha256: rowSetHash(ks.map(byteOf)), keyedSha256: keyedDigest(ks, shaOf) });
    const key = producerExclusionKey(parityGeneration);
    // Deep copy: a tampering must never reach the world's config or another case.
    return structuredClone({ preparedUncommitted: true, committed: false, observedAt: "2026-10-07 10:00:00.000002+00",
      deletedEvaluationIdsSha256: sha256(JSON.stringify(config.evaluationIds)), deletedContextIdsSha256: sha256(JSON.stringify(config.contextIds)),
      retainedRoots: Object.fromEntries(BYTE_PRESERVED_TABLES.map(t => [t, config.tableHashes[t]])),
      originalHashes: { evaluations: config.tableHashes[EVAL], contexts: config.tableHashes[CONTEXT] },
      retainedDependents: { jobIds: [], rows: 0, rowByteSetSha256: rowSetHash([]) },
      inputEvidence: { lifecycle: INPUT_EVIDENCE_LIFECYCLE, frozenKeys: keys.length,
        before: { rows: keys.length, rowByteSetSha256: rowSetHash(keys.map(byteOf)), keyedSha256: keyedDigest(keys, shaOf) },
        deletedKeys: [...deleted].sort(compareKeys), deleted: part([...deleted].sort(compareKeys)), retainedShared: part(shared), danglingAfterDelete: 0,
        referenceIndexes: [{ name: PARITY_INDEX, oid: "94977158", bytes: "1024851968" }], indexesUsed: [PARITY_INDEX], catalogFingerprint: "9".repeat(64) },
      producerExclusion: { key, ...advisoryLockParts(key), pid: 4242, acquiredAt: "2026-10-07 10:00:00.000001+00",
        acquiredBeforeTransaction: true, heldThroughPreparation: true },
      pins: { measuredKnownPinsZero: true }, providerAuthority: false, physicalReclaimedBytes: 0 }) as any;
  };
  return { keys, config, prepared, byteOf, shaOf };
}

export interface ParityCase { prepared: any; config: UnitConfig; producerLockKey: string; ts: string; py: string }
const W = "0".repeat(64);
/** Every case is one field away from a prepared line both gates accept. `ts`/`py` are the exact expected outcomes. */
export function parityCases(): Record<string, ParityCase> {
  const ascii = parityWorld(["native-ad-evaluation.v1", "native-ad-evaluation.v1", "native-ad-evaluation.v1"]);
  const key = producerExclusionKey(parityGeneration), ok = "COMMIT_EXACT_UNIT_ONCE";
  const cases: Record<string, ParityCase> = {};
  const base = (w = ascii, del: Key[] = [w.keys[0]!, w.keys[2]!]) => ({ prepared: w.prepared(del), config: structuredClone(w.config), producerLockKey: key });
  const add = (name: string, ts: string, py: string, f: (c: ReturnType<typeof base>) => void, w = ascii, del?: Key[]) => {
    const c = base(w, del); f(c); cases[name] = { ...c, ts, py }; };
  const P = "PREPARED_INPUT_EVIDENCE_PARTITION", R = "PREPARED_INPUT_REFERENCE_PROOF", X = "PREPARED_PRODUCER_EXCLUSION";
  add("valid_two_deleted_one_shared", "true", ok, () => undefined);
  add("valid_all_shared", "true", ok, () => undefined, ascii, []);
  add("valid_all_deleted", "true", ok, () => undefined, ascii, [...ascii.keys]);
  // The three root/Grok probe shapes.
  add("wrong_deleted_keyed_digest", P, P, c => { c.prepared.inputEvidence.deleted.keyedSha256 = W; });
  add("wrong_shared_keyed_digest", P, P, c => { c.prepared.inputEvidence.retainedShared.keyedSha256 = W; });
  add("unverified_reference_index", R, R, c => { c.prepared.inputEvidence.indexesUsed = ["engine_v3_ad_evaluations_pkey"]; });
  // Digests, keys and counts.
  add("wrong_before_keyed_digest", "PREPARED_INPUT_EVIDENCE_BEFORE", "PREPARED_INPUT_EVIDENCE_BEFORE", c => { c.prepared.inputEvidence.before.keyedSha256 = W; });
  add("wrong_before_row_set", "PREPARED_INPUT_EVIDENCE_BEFORE", "PREPARED_INPUT_EVIDENCE_BEFORE", c => { c.prepared.inputEvidence.before.rowByteSetSha256 = W; });
  add("wrong_deleted_keys_sha", P, P, c => { c.prepared.inputEvidence.deleted.keysSha256 = W; });
  add("wrong_shared_keys_sha", P, P, c => { c.prepared.inputEvidence.retainedShared.keysSha256 = W; });
  add("deleted_count_off", P, P, c => { c.prepared.inputEvidence.deleted.keys += 1; });
  add("shared_count_boolean_true_for_one", P, P, c => { c.prepared.inputEvidence.retainedShared.keys = true; });
  add("deleted_rows_off", P, P, c => { c.prepared.inputEvidence.deleted.rows -= 1; });
  add("shared_rows_off", P, P, c => { c.prepared.inputEvidence.retainedShared.rows = 0; });
  add("deleted_row_set_not_hex", P, P, c => { c.prepared.inputEvidence.deleted.rowByteSetSha256 = "not-a-digest"; });
  add("deleted_part_missing", P, P, c => { delete c.prepared.inputEvidence.deleted; });
  add("deleted_unsorted", P, P, c => { c.prepared.inputEvidence.deletedKeys.reverse(); });
  add("deleted_duplicate", P, P, c => { const e = c.prepared.inputEvidence; e.deletedKeys = [e.deletedKeys[0], e.deletedKeys[0]]; });
  add("deleted_unfrozen_key", P, P, c => { c.prepared.inputEvidence.deletedKeys = [["native-ad-evaluation.v1", "d".repeat(64)]]; c.prepared.inputEvidence.deleted.keys = 1; });
  add("deleted_three_element_key", P, P, c => { c.prepared.inputEvidence.deletedKeys[0] = [...c.prepared.inputEvidence.deletedKeys[0], "x"]; });
  add("deleted_non_string_key", P, P, c => { c.prepared.inputEvidence.deletedKeys[0] = [c.prepared.inputEvidence.deletedKeys[0][0], 7]; });
  add("deleted_keys_not_list", P, P, c => { c.prepared.inputEvidence.deletedKeys = "all"; });
  add("frozen_keys_off", "PREPARED_INPUT_EVIDENCE", "PREPARED_INPUT_EVIDENCE", c => { c.prepared.inputEvidence.frozenKeys += 1; });
  add("catalog_fingerprint_off", "PREPARED_INPUT_EVIDENCE", "PREPARED_INPUT_EVIDENCE", c => { c.prepared.inputEvidence.catalogFingerprint = W; });
  add("lifecycle_wrong", "PREPARED_INPUT_EVIDENCE", "PREPARED_INPUT_EVIDENCE", c => { c.prepared.inputEvidence.lifecycle = "byte-retained.v2"; });
  add("v2_prepared_shape", "PREPARED_INPUT_EVIDENCE", "PREPARED_INPUT_EVIDENCE", c => { delete c.prepared.inputEvidence; delete c.prepared.producerExclusion; });
  // Reference index proof.
  add("reference_indexes_missing", R, R, c => { c.prepared.inputEvidence.referenceIndexes = []; });
  add("reference_index_fabricated_oid", R, R, c => { c.prepared.inputEvidence.referenceIndexes[0].oid = "made-up"; });
  add("reference_index_fabricated_name", R, R, c => { c.prepared.inputEvidence.referenceIndexes[0].name = "Fabricated Index"; c.prepared.inputEvidence.indexesUsed = ["Fabricated Index"]; });
  add("reference_index_duplicate", R, R, c => { const i = c.prepared.inputEvidence.referenceIndexes[0]; c.prepared.inputEvidence.referenceIndexes = [i, { ...i }]; });
  add("indexes_used_empty", R, R, c => { c.prepared.inputEvidence.indexesUsed = []; });
  add("indexes_used_duplicate", R, R, c => { c.prepared.inputEvidence.indexesUsed = [PARITY_INDEX, PARITY_INDEX]; });
  add("dangling_one", R, R, c => { c.prepared.inputEvidence.danglingAfterDelete = 1; });
  add("dangling_boolean_false", R, R, c => { c.prepared.inputEvidence.danglingAfterDelete = false; });
  // Producer exclusion.
  for (const [name, pid] of [["pid_zero", 0], ["pid_negative", -1], ["pid_boolean_true", true], ["pid_fraction", 1.5], ["pid_string", "4242"]] as const)
    add(name, X, X, c => { c.prepared.producerExclusion.pid = pid; });
  add("pid_missing", X, X, c => { delete c.prepared.producerExclusion.pid; });
  add("foreign_key_matching_tampered_request", X, X, c => { c.prepared.producerExclusion.key = "1"; c.producerLockKey = "1"; });
  add("acquired_after_transaction", X, X, c => { c.prepared.producerExclusion.acquiredBeforeTransaction = false; });
  add("not_held_through_preparation", X, X, c => { c.prepared.producerExclusion.heldThroughPreparation = false; });
  // Remaining acceptPrepared conditions (same() semantics: true is not 1).
  add("original_hashes_wrong", "PREPARED_ORIGINAL_BYTES", "PREPARED_ORIGINAL_BYTES", c => { c.prepared.originalHashes.evaluations = { rows: 2, rowByteSetSha256: W }; });
  add("retained_dependents_wrong", "PREPARED_RETAINED_DEPENDENTS", "PREPARED_RETAINED_DEPENDENTS", c => { c.prepared.retainedDependents.rows = 1; });
  add("retained_root_boolean_rows", "PREPARED_RETAINED_ROOTS", "RETAINED_ROOTS_FULL_BYTES", c => { c.prepared.retainedRoots.engine_v3_job_runs.rows = true; });
  // Non-ASCII keys: Turkish, high-BMP vs astral (JavaScript UTF-16 order differs from code-point order), JSON escapes.
  const text = parityWorld(["değerlendirme.v1-ğüşİıöç", "a�", "a\u{1F680}", "q\"uote\\back\ttab\u0001", "native-ad-evaluation.v1"]);
  add("valid_non_ascii", "true", ok, () => undefined, text, [text.keys[1]!, text.keys[3]!]);
  add("non_ascii_wrong_shared_keyed_digest", P, P, c => { c.prepared.inputEvidence.retainedShared.keyedSha256 = W; }, text, [text.keys[1]!, text.keys[3]!]);
  const naive = parityWorld(["a�", "a\u{1F680}", "değerlendirme.v1"], "codepoint");
  add("config_in_code_point_order", "EXACT_FROZEN_INPUT_EVIDENCE_CONFIG", "EXACT_FROZEN_INPUT_EVIDENCE_CONFIG", () => undefined, naive, []);
  return cases;
}
export const parityWorlds = () => ({ ascii: parityWorld(["native-ad-evaluation.v1", "native-ad-evaluation.v1", "native-ad-evaluation.v1"]),
  nonAscii: parityWorld(["değerlendirme.v1-ğüşİıöç", "a�", "a\u{1F680}", "q\"uote\\back\ttab\u0001", "native-ad-evaluation.v1"]) });

export function tsOutcome(c: ParityCase) {
  try { return acceptPrepared(c.prepared, c.config) === true ? "true" : "FALSE"; } catch (e) { return safeError(e).code; }
}
const PY = `import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('nsb_actor_d150_parity', sys.argv[1]); a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a)
d = json.loads(sys.stdin.buffer.read().decode('utf-8')); out, digests = {}, {}
for name, c in d['cases'].items():
    try: out[name] = a.prepared_gate(c['line'], {'request': c['request']})['action']
    except RuntimeError as e: out[name] = str(e)
    except Exception as e: out[name] = 'UNCODED:' + type(e).__name__
for name, w in d['worlds'].items():
    try:
        rs = a.frozen_row_sha(w)
        digests[name] = {'keysSha256': a.sha(a.js_json(w['inputKeys'])), 'keyedSha256': a.keyed_digest(w['inputKeys'], rs)}
    except Exception as e: digests[name] = 'UNAVAILABLE:' + type(e).__name__
sys.stdout.write(json.dumps({'cases': out, 'digests': digests}, ensure_ascii=True))`;
/** The actor's own prepared_gate (fixture mode), for every case; plus its digests of each world's frozen keys. */
export function pythonOutcomes(actorFile: string, cases: Record<string, ParityCase>) {
  const fx = mkdtempSync(join(tmpdir(), "nsb-d150-parity-"));
  try {
    writeFileSync(join(fx, "fixture.json"), JSON.stringify({ hostname: "adsecute-prod-8gb-ash-1", bin: { docker: "/usr/bin/false", curl: "/usr/bin/false", systemctl: "/usr/bin/false" } }));
    const input = { cases: Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, {
      line: { type: "prepared", preparedSha256: sha256(JSON.stringify(c.prepared)), challengeNonce: "a".repeat(32), prepared: c.prepared },
      request: { config: c.config, proofSha256: canonicalSha(c.config), producerLockKey: c.producerLockKey } }])),
    worlds: Object.fromEntries(Object.entries(parityWorlds()).map(([n, w]) => [n, w.config])) };
    const run = spawnSync("python3", ["-c", PY, actorFile], { input: Buffer.from(JSON.stringify(input), "utf8"), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NSB_ACTOR_FIXTURE: fx } });
    if (run.status !== 0) throw new Error(`PYTHON_PARITY_RUN_FAILED:${run.status}:${(run.stderr ?? "").slice(-400)}`);
    return JSON.parse(run.stdout) as { cases: Record<string, string>; digests: Record<string, { keysSha256: string; keyedSha256: string } | string> };
  } finally { rmSync(fx, { recursive: true, force: true }); }
}
