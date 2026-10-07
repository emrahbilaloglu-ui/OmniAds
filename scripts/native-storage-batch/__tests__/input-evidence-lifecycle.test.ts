import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AD_DECISIONS_JOB_NAME, adDecisionsJobAdvisoryLockKey } from "../../../lib/creative-decision-engine/jobs/ad-decisions-job";
import { NATIVE_STORAGE_BATCH_CONTRACT, validateNativeStorageBatchPlan,
  type NativeStorageBatchPlan } from "../../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { BYTE_PRESERVED_TABLES, CONTEXT, EVAL, INPUT, NATIVE_JOB, UNIT_CONFIG_CONTRACT, UNIT_TABLES, canonicalSha, rowSetHash,
  safeError, sha256 } from "../common";
import { RETAINED_DEPENDENTS_CONTRACT, type UnitConfig } from "../capture";
import { INPUT_EVIDENCE_LIFECYCLE, advisoryLockParts, inspectReferencePlan, keyedDigest, producerExclusionKey,
  verifyFrozenInputRows } from "../input-evidence-lifecycle";
import { acceptPrepared, unitScope } from "../retire";
import { settlementRelations } from "../maintenance-settlement";
import { ACTOR_FILE } from "../production-transport";
import { parityCases, parityWorlds, pythonOutcomes, tsOutcome } from "./d150-parent-parity-cases";

/** D150 focused guards: producer-key identity with the ACTUAL producer function,
 * bounded index-probe plan shape, frozen per-key bytes, prepared partition
 * acceptance (TypeScript parent AND the production actor's own gate), and the
 * v2/v1 refusals. Real-PG behaviour is input-evidence-lifecycle-pg.ts. */
const refusal = (fn: () => unknown) => { try { fn(); return "NO_REFUSAL"; } catch (e) { return safeError(e).code; } };
const B = "11111111-1111-4111-8111-111111111111", J = "22222222-2222-4222-8222-222222222222";
const generation = { businessId: B, jobRunId: J, asOfDate: "2026-09-01", engineVersion: "native-fixture" };
type Key = [string, string];
const keys: Key[] = (["a", "b", "c"].map(x => ["native-ad-evaluation.v1", x.repeat(64)]) as Key[]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
const bytes = new Map(keys.map(k => [JSON.stringify(k), JSON.stringify({ contract_version: k[0], input_hash: k[1], input_evidence_json: { k: k[1][0] } })]));
const byteOf = (k: Key) => bytes.get(JSON.stringify(k))!, shaOf = (k: Key) => sha256(byteOf(k));
const h = (rows: string[]) => ({ rows: rows.length, rowByteSetSha256: rowSetHash(rows) });
function config(): UnitConfig {
  const tableHashes = Object.fromEntries(UNIT_TABLES.map(t => [t, h([`${t}-row`])])) as UnitConfig["tableHashes"];
  tableHashes[INPUT] = h(keys.map(byteOf));
  return { contract: UNIT_CONFIG_CONTRACT, generation: { ...generation }, evaluations: 1, contexts: 1,
    evaluationIds: ["33333333-3333-4333-8333-333333333333"], contextIds: ["44444444-4444-4444-8444-444444444444"], inputKeys: keys,
    campaignObjectHashes: [], jobIds: [J], batchIds: [], cellIds: [], tableHashes, evaluationRowSha256: {}, jobFinishedAt: "2026-09-01T02:00:00Z",
    schemaHash: "d".repeat(64), catalogFingerprint: "e".repeat(64), consumerInventorySha256: "f".repeat(64),
    retainedDependents: { contract: RETAINED_DEPENDENTS_CONTRACT, jobIds: [], rows: 0, rowByteSetSha256: rowSetHash([]), dependencyForeignKey: null },
    inputEvidence: { lifecycle: INPUT_EVIDENCE_LIFECYCLE, rowSha256: keys.map(shaOf), catalogFingerprint: "9".repeat(64) } };
}
const INDEX = "idx_engine_v3_ad_evaluations_contract_input";
function prepared(c: UnitConfig, deleted: Key[] = [keys[0]!, keys[2]!]) {
  const ids = new Set(deleted.map(k => JSON.stringify(k))), shared = keys.filter(k => !ids.has(JSON.stringify(k)));
  const part = (ks: Key[]) => ({ keys: ks.length, keysSha256: sha256(JSON.stringify(ks)), rows: ks.length,
    rowByteSetSha256: rowSetHash(ks.map(byteOf)), keyedSha256: keyedDigest(ks, shaOf) });
  return { preparedUncommitted: true, committed: false, observedAt: "2026-10-07 10:00:00.000002+00",
    deletedEvaluationIdsSha256: sha256(JSON.stringify(c.evaluationIds)), deletedContextIdsSha256: sha256(JSON.stringify(c.contextIds)),
    retainedRoots: Object.fromEntries(BYTE_PRESERVED_TABLES.map(t => [t, c.tableHashes[t]])),
    originalHashes: { evaluations: c.tableHashes[EVAL], contexts: c.tableHashes[CONTEXT] },
    retainedDependents: { jobIds: [], rows: 0, rowByteSetSha256: rowSetHash([]) },
    inputEvidence: { lifecycle: INPUT_EVIDENCE_LIFECYCLE, frozenKeys: keys.length,
      before: { rows: keys.length, rowByteSetSha256: rowSetHash(keys.map(byteOf)), keyedSha256: keyedDigest(keys, shaOf) },
      deletedKeys: deleted, deleted: part(deleted), retainedShared: part(shared), danglingAfterDelete: 0,
      referenceIndexes: [{ name: INDEX, oid: "94977158", bytes: "8192" }], indexesUsed: [INDEX], catalogFingerprint: "9".repeat(64) },
    producerExclusion: { key: producerExclusionKey(generation), ...advisoryLockParts(producerExclusionKey(generation)), pid: 4242,
      acquiredAt: "2026-10-07 10:00:00.000001+00", acquiredBeforeTransaction: true, heldThroughPreparation: true },
    pins: { measuredKnownPinsZero: true }, providerAuthority: false, physicalReclaimedBytes: 0 } as any;
}
const tamper = (f: (p: any) => void) => { const c = config(), p = prepared(c); f(p); return refusal(() => acceptPrepared(p, c)); };

describe("D150 zero-live-reference input-evidence lifecycle guards", () => {
  it("derives exactly the actual producer job lock (same job name, same formula) and its pg_locks halves", () => {
    expect(NATIVE_JOB).toBe(AD_DECISIONS_JOB_NAME);
    for (const [businessId, asOf] of [[B, "2026-09-01"], ["0f0e0d0c-0b0a-4908-8706-050403020100", "2025-12-31"], [J, "2026-02-28"]])
      expect(producerExclusionKey({ businessId, asOfDate: asOf })).toBe(adDecisionsJobAdvisoryLockKey({ businessId, asOf }).toString());
    for (const key of ["-1", "1", "-9223372036854775808", "9223372036854775807", producerExclusionKey(generation)]) {
      const { classid, objid } = advisoryLockParts(key);
      expect(BigInt.asIntN(64, (BigInt(classid) << BigInt(32)) | BigInt(objid)).toString()).toBe(key);
    }
    expect(refusal(() => producerExclusionKey({ businessId: "not-a-uuid", asOfDate: "2026-09-01" }))).toBe("EXACT_PRODUCER_EXCLUSION_IDENTITY");
  });

  it("admits only a bounded parameterized probe of a verified reference index", () => {
    const plan = (inner: object, join = "Nested Loop") => JSON.stringify([{ Plan: { "Node Type": join, Plans: [
      { "Node Type": "Function Scan", "Function Name": "unnest" }, inner] } }]);
    const probe = { "Node Type": "Index Only Scan", "Relation Name": EVAL, "Index Name": INDEX,
      "Index Cond": "((contract_version = k.contract_version) AND (input_hash = k.input_hash))" };
    expect(inspectReferencePlan(plan(probe), [INDEX])).toEqual([INDEX]);
    expect(inspectReferencePlan(plan({ "Node Type": "Bitmap Heap Scan", "Relation Name": EVAL, Plans: [{ "Node Type": "Bitmap Index Scan",
      "Index Name": INDEX, "Index Cond": probe["Index Cond"] }] }), [INDEX])).toEqual([INDEX]);
    for (const bad of [{ "Node Type": "Seq Scan", "Relation Name": EVAL }, { ...probe, "Index Name": "engine_v3_ad_evaluations_pkey" },
      { ...probe, "Index Cond": undefined }, { ...probe, "Index Cond": "(contract_version = k.contract_version)" },
      { "Node Type": "Bitmap Heap Scan", "Relation Name": EVAL, Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "other" }] }])
      expect(refusal(() => inspectReferencePlan(plan(bad), [INDEX]))).toBe("INPUT_REFERENCE_PLAN_NOT_INDEXED");
    // A merge anti join over the whole index carries no Index Cond: refused.
    expect(refusal(() => inspectReferencePlan(plan({ ...probe, "Index Cond": undefined }, "Merge Anti Join"), [INDEX]))).toBe("INPUT_REFERENCE_PLAN_NOT_INDEXED");
  });

  it("verifies frozen full-row bytes per key", () => {
    const rows = keys.map(k => ({ contract_version: k[0], input_hash: k[1], bytes: byteOf(k) }));
    expect(verifyFrozenInputRows(rows, keys, shaOf).rowByteSetSha256).toBe(rowSetHash(keys.map(byteOf)));
    expect(refusal(() => verifyFrozenInputRows([{ ...rows[0]!, bytes: `${rows[0]!.bytes} ` }, ...rows.slice(1)], keys, shaOf))).toBe("SOURCE_DRIFT_INPUT_EVIDENCE_BYTES");
    expect(refusal(() => verifyFrozenInputRows(rows.slice(1), keys, shaOf))).toBe("SOURCE_DRIFT_INPUT_EVIDENCE_KEYS");
  });

  it("accepts exactly the frozen zero-reference partition and refuses every tampered prepared shape", () => {
    const c = config();
    expect(acceptPrepared(prepared(c), c)).toBe(true);
    expect(acceptPrepared(prepared(c, []), c)).toBe(true);
    expect(tamper(p => { p.inputEvidence.deletedKeys = [["native-ad-evaluation.v1", "d".repeat(64)]]; })).toBe("PREPARED_INPUT_EVIDENCE_PARTITION");
    expect(tamper(p => { p.inputEvidence.retainedShared.keyedSha256 = "0".repeat(64); })).toBe("PREPARED_INPUT_EVIDENCE_PARTITION");
    expect(tamper(p => { p.inputEvidence.before.rowByteSetSha256 = "0".repeat(64); })).toBe("PREPARED_INPUT_EVIDENCE_BEFORE");
    expect(tamper(p => { p.inputEvidence.danglingAfterDelete = 1; })).toBe("PREPARED_INPUT_REFERENCE_PROOF");
    expect(tamper(p => { p.inputEvidence.indexesUsed = ["engine_v3_ad_evaluations_pkey"]; })).toBe("PREPARED_INPUT_REFERENCE_PROOF");
    expect(tamper(p => { p.retainedRoots[INPUT] = c.tableHashes[INPUT]; })).toBe("PREPARED_RETAINED_ROOTS");
    expect(tamper(p => { p.producerExclusion.key = "1"; })).toBe("PREPARED_PRODUCER_EXCLUSION");
    expect(tamper(p => { p.producerExclusion.acquiredBeforeTransaction = false; })).toBe("PREPARED_PRODUCER_EXCLUSION");
    expect(tamper(p => { delete p.producerExclusion; })).toBe("PREPARED_PRODUCER_EXCLUSION");
  });

  it("the production actor's Python prepared_gate enforces every acceptPrepared condition independently (nonvacuous parity matrix)", () => {
    const cases = parityCases(), py = pythonOutcomes(ACTOR_FILE, cases);
    const ts = Object.fromEntries(Object.entries(cases).map(([name, c]) => [name, tsOutcome(c)]));
    expect(Object.keys(cases).length).toBeGreaterThanOrEqual(45);
    // Every rejection is one field away from a line BOTH gates accept, and every outcome is a coded refusal.
    expect(Object.entries(cases).filter(([n]) => n.startsWith("valid_")).map(([n]) => [ts[n], py.cases[n]]))
      .toEqual(Object.keys(cases).filter(n => n.startsWith("valid_")).map(() => ["true", "COMMIT_EXACT_UNIT_ONCE"]));
    expect(ts).toEqual(Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, c.ts])));
    expect(py.cases).toEqual(Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, c.py])));
    expect(Object.values(py.cases).filter(v => v.startsWith("UNCODED:"))).toEqual([]);
    for (const probe of ["wrong_deleted_keyed_digest", "wrong_shared_keyed_digest", "unverified_reference_index"])
      expect([ts[probe], py.cases[probe]]).not.toContain("COMMIT_EXACT_UNIT_ONCE");
  });

  it("keeps JSON.stringify UTF-8 digest and UTF-16 order parity for Turkish, astral, high-BMP and escaped keys", () => {
    const worlds = parityWorlds(), py = pythonOutcomes(ACTOR_FILE, {});
    for (const [name, w] of Object.entries(worlds))
      expect(py.digests[name]).toEqual({ keysSha256: sha256(JSON.stringify(w.keys)), keyedSha256: keyedDigest(w.keys, w.shaOf) });
    const order = worlds.nonAscii.keys.map(k => k[0]);
    // UTF-16 code-unit order: the astral key (high surrogate 0xD83D) sorts before U+FFFD, unlike code-point order.
    expect(order.indexOf("a\u{1F680}")).toBeLessThan(order.indexOf("a\uFFFD"));
    expect(order).toContain("değerlendirme.v1-ğüşİıöç");
  });

  it("never executes or resumes a v2 purpose or a v1 unit config as v3", () => {
    const plan = (contract: string) => ({ contract, purpose: "c0ffee0000d1", targetRevision: "a".repeat(40), sourceManifestSha256: "b".repeat(64),
      actualSourceReviewSha256: "c".repeat(64), expectedDatabaseBudgetBytes: 1, cutoffObservedAt: "2026-10-01T00:00:00.000Z",
      units: [{ generation, evaluations: 1, contexts: 1, originalProofSha256: "d".repeat(64) }] }) as unknown as NativeStorageBatchPlan;
    expect(NATIVE_STORAGE_BATCH_CONTRACT).toBe("finite-native-storage-batch.v3");
    expect(refusal(() => validateNativeStorageBatchPlan(plan("finite-native-storage-batch.v2")))).toBe("RETIRED_V2_BYTE_RETAINED_INPUT_SCHEDULE");
    expect(refusal(() => validateNativeStorageBatchPlan(plan("finite-native-storage-batch.v1")))).toBe("RETIRED_V1_TOAST_VACUUM_SCHEDULE");
    expect(validateNativeStorageBatchPlan(plan(NATIVE_STORAGE_BATCH_CONTRACT))).toMatch(/^[a-f0-9]{64}$/);
    const v1 = { ...config(), contract: "finite-native-storage-unit-config.v1" as const };
    delete v1.inputEvidence;
    expect(refusal(() => unitScope(v1, canonicalSha(v1)))).toBe("RETIRED_UNIT_CONFIG_NOT_EXECUTABLE");
    const c = config();
    expect(unitScope(c, canonicalSha(c)).evalIds).toEqual(c.evaluationIds);
    expect(refusal(() => unitScope({ ...c, inputEvidence: undefined }, canonicalSha({ ...c, inputEvidence: undefined })))).toBe("EXACT_FROZEN_INPUT_EVIDENCE_CONFIG");
    expect(settlementRelations("finite-native-storage-batch.v3")).toEqual([EVAL, CONTEXT, INPUT]);
    expect(settlementRelations("finite-native-storage-batch.v2")).toEqual([EVAL, CONTEXT]);
  });
});
