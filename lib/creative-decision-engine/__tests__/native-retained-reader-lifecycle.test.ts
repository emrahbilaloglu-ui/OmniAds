import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeRetainedReaderSources, inspectNativeRetainedReaderSources } from "@/scripts/native-retained-reader-lifecycle-guard";
import { assessNativeRetainedGenerationLifecycle, NATIVE_RETAINED_LEDGER_PATH,
  validateNativeRetainedReaderLedger, type NativeRetainedReaderLedger } from "../native-retained-reader-lifecycle";
import type { NativeEvaluationContextMeasurement } from "../native-evaluation-context-unit";

const ledger = JSON.parse(readFileSync(join(process.cwd(), NATIVE_RETAINED_LEDGER_PATH), "utf8")) as NativeRetainedReaderLedger;
const sources = nativeRetainedReaderSources();
const generation = { businessId: "11111111-1111-4111-8111-111111111111", jobRunId: "22222222-2222-4222-8222-222222222222",
  asOfDate: "2026-10-02", engineVersion: "public-lifecycle-fixture" };
const childColumns = ["context_id", "business_ref_id", "business_id", "provider_account_ref_id", "provider_account_id",
  "as_of_date", "engine_version", "scope_type", "scope_id", "contract_version", "job_run_id"];
function measurement(): NativeEvaluationContextMeasurement {
  return { contract: "native-evaluation-context-measurement.v2", generation: { ...generation },
    observedAt: "2026-10-04T21:00:00Z", jobFinishedAt: "2026-10-02T12:00:00Z", originalJobRowCount: "702",
    evaluationCount: "702", selectedContextCount: "1", contextSharingCount: "0",
    incomingReferences: [{ childSchema: "public", childTable: "engine_v3_ad_decision_evaluations", constraint: "exact_lineage",
      parentTable: "engine_v3_ad_decision_evaluation_contexts", childColumns, parentColumns: ["id", ...childColumns.slice(1)],
      count: "702", internalSelectedMembership: true }],
    nonFkCounts: ["action_lineage", "workflow_state", "workflow_events", "proposal_identity", "launch_handoff_possible_identity"]
      .map(pinClass => ({ pinClass, count: "0" })) as NativeEvaluationContextMeasurement["nonFkCounts"],
    unknownReferences: [], schemaHash: "a".repeat(64), consumerInventorySha256: ledger.sourceInventorySha256,
    retainedRoots: ["original_jobs", "calibration_parents", "shared_input_evidence", "provider_roots", "shared_campaign_context_objects"],
    providerAuthority: false, reclaimEligible: false };
}
const assess = (m = measurement(), unknownOperationalConsumers: string[] = []) =>
  assessNativeRetainedGenerationLifecycle({ generation, measurement: m, ledger, actualSources: sources, unknownOperationalConsumers });
describe("whole retained-table source and closed-day lifecycle", () => {
  it("pins the actual consumer source and role set, including operator/fixture/provenance files", () => {
    expect(inspectNativeRetainedReaderSources().issues).toEqual([]);
    expect(ledger.entries.find(x => x.path === "lib/creative-decision-engine/decision-stability.ts")?.role).toBe("outcomes-and-stability");
    expect(ledger.entries.find(x => x.path === "lib/meta/decisions-workspace-read-model.ts")?.retention).toContain("every retained snapshot");
  });
  it.each(["lib/undeclared-reader.ts", "scripts/undeclared-reader.cjs", "scripts/undeclared-reader.py", "scripts/undeclared-reader.sql"])("refuses a new reader %s", path => {
    const changed = new Map(sources); changed.set(path, "SELECT e.* FROM engine_v3_ad_decision_evaluations e");
    expect(validateNativeRetainedReaderLedger(changed, ledger).issues).toContain(`${path}: unclassified retained-table consumer`);
  });
  it("refuses split prefix and centralized alias consumers rather than whitelist SQL spellings", () => {
    for (const text of ['const t="engine_v3_ad_"+"decision_evaluations";',
      'const t="engine_v3_ad_decision_"+"evaluations";', 'const t="engine_v3_"+"ad_decision_evaluations";',
      "query(`SELECT * FROM ${AD_EVALUATIONS_TABLE}`)"]) {
      const changed = new Map(sources); changed.set("lib/new-dynamic-reader.ts", text);
      expect(validateNativeRetainedReaderLedger(changed, ledger).sourceMatches).toBe(false);
    }
  });
  it("classifies a retained reader in a nested archive directory while excluding only frozen lib/archive", () => {
    const root = mkdtempSync(join(tmpdir(), "owned-nested-archive-reader-"));
    try {
      for (const folder of ["app", "components", "lib", "scripts"]) mkdirSync(join(root, folder));
      mkdirSync(join(root, "lib", "x", "archive"), { recursive: true });
      mkdirSync(join(root, "lib", "archive"));
      const reader = "SELECT * FROM engine_v3_ad_decision_evaluations";
      writeFileSync(join(root, "lib", "x", "archive", "reader.ts"), reader);
      writeFileSync(join(root, "lib", "archive", "frozen.ts"), reader);
      const actual = nativeRetainedReaderSources(root);
      expect(actual.has("lib/archive/frozen.ts")).toBe(false);
      expect(actual.get("lib/x/archive/reader.ts")).toBe(reader);
      expect(validateNativeRetainedReaderLedger(actual, ledger).issues)
        .toContain("lib/x/archive/reader.ts: unclassified retained-table consumer");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses a new reader that uses only the centralized event table alias", () => {
    const changed = new Map(sources);
    changed.set("lib/new-event-reader.ts", "query(`SELECT * FROM ${AD_EVENTS_TABLE}`)");
    expect(validateNativeRetainedReaderLedger(changed, ledger).issues)
      .toContain("lib/new-event-reader.ts: unclassified retained-table consumer");
  });
  it("allows an explicitly reviewed nested archive reader declaration", () => {
    const path = "lib/x/archive/reader.ts", source = "SELECT * FROM engine_v3_ad_decision_evaluations";
    const changed = new Map(sources); changed.set(path, source);
    const body = { contract: ledger.contract, baselineRevision: ledger.baselineRevision,
      entries: [...ledger.entries, { path, role: "serving-and-history" as const,
        sha256: createHash("sha256").update(source).digest("hex"), retention: "every retained snapshot" }] };
    const declared = { ...body, sourceInventorySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    expect(validateNativeRetainedReaderLedger(changed, declared).issues).toEqual([]);
  });
  it("refuses a linked source instead of silently omitting it from the actual filesystem census", () => {
    const root = mkdtempSync(join(tmpdir(), "owned-native-reader-guard-"));
    try {
      for (const folder of ["app", "components", "lib", "scripts"]) mkdirSync(join(root, folder));
      writeFileSync(join(root, "public-source.ts"), "SELECT * FROM engine_v3_ad_decision_evaluations");
      symlinkSync(join(root, "public-source.ts"), join(root, "lib", "linked.ts"));
      expect(() => nativeRetainedReaderSources(root)).toThrow("unclassified source symlink");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses a changed query predicate with exactly the same table-reference count", () => {
    const changed = new Map(sources), path = "lib/creative-decision-engine/decision-stability.ts";
    const original = changed.get(path)!;
    expect(original).toContain("snapshot.as_of_date");
    changed.set(path, original.replace("snapshot.as_of_date", "snapshot.computed_at"));
    expect(validateNativeRetainedReaderLedger(changed, ledger).issues).toContain(`${path}: source changed; review selection and retention before repinning`);
  });
  it("refuses missing consumers and a self-consistent but duplicated ledger", () => {
    const changed = new Map(sources); changed.delete(ledger.entries[0]!.path);
    expect(validateNativeRetainedReaderLedger(changed, ledger).sourceMatches).toBe(false);
    const body = { contract: ledger.contract, baselineRevision: ledger.baselineRevision, entries: [...ledger.entries, ledger.entries[0]!] };
    const copied = { ...body, sourceInventorySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    expect(validateNativeRetainedReaderLedger(sources, copied).sourceMatches).toBe(false);
    const emptyBody = { ...body, entries: [] };
    const empty = { ...emptyBody, sourceInventorySha256: createHash("sha256").update(JSON.stringify(emptyBody)).digest("hex") };
    expect(validateNativeRetainedReaderLedger(new Map(), empty).sourceMatches).toBe(false);
  });
  it("a measured pin-free closed day grants bounded preparation and zero live/removal authority", () => {
    const r = assess(); expect(r.eligibleForBoundedArchivePreparation).toBe(true);
    expect(r.removalAuthorized).toBe(false); expect(r.reclaimEligible).toBe(false);
    expect(r.productionConsumerClosureProved).toBe(false); expect(r.snapshotAgePruningAllowed).toBe(false);
    expect(r.providerAuthority).toBe(false); expect(r.physicalBytesReclaimed).toBe("0");
  });
  it("preserves any historical snapshot lineage, irrespective of today's current winner", () => {
    const m = measurement(); m.incomingReferences.push({ childSchema: "public", childTable: "engine_v3_ad_decision_snapshots_daily",
      constraint: "retained_historical_snapshot", parentTable: "engine_v3_ad_decision_evaluations",
      childColumns: ["evaluation_id"], parentColumns: ["id"], count: "1", internalSelectedMembership: false });
    expect(assess(m).eligibleForBoundedArchivePreparation).toBe(false);
  });
  it.each(["action_lineage", "workflow_state", "workflow_events", "proposal_identity", "launch_handoff_possible_identity"])("keeps terminal %s history as a pin", pin => {
    const m = measurement(); m.nonFkCounts.find(x => x.pinClass === pin)!.count = "1";
    expect(assess(m).eligibleForBoundedArchivePreparation).toBe(false);
  });
  it("refuses shared contexts and unknown operational/non-FK consumers", () => {
    const m = measurement(); m.contextSharingCount = "1"; expect(assess(m).eligibleForBoundedArchivePreparation).toBe(false);
    expect(assess(measurement(), ["unclassified_dynamic_external_reader"]).reason).toBe("unknown_consumer");
    const unknown = measurement(); unknown.unknownReferences.push("unknown_pin"); expect(assess(unknown).reason).toBe("unknown_consumer");
  });
  it("never retires current/future days or accepts a normalized invalid UTC date", () => {
    const current = measurement(); current.observedAt = "2026-10-02T23:59:59Z";
    expect(assess(current).reason).toBe("current_or_future_day");
    const bad = measurement(); bad.generation.asOfDate = "2026-02-30";
    expect(() => assessNativeRetainedGenerationLifecycle({ generation: bad.generation, measurement: bad,
      ledger, actualSources: sources, unknownOperationalConsumers: [] })).toThrow("invalid exact UTC day");
  });
  it("binds the actual measurement to the exact consumer ledger and latest shared-root contract", () => {
    const wrong = measurement(); wrong.consumerInventorySha256 = "b".repeat(64); expect(() => assess(wrong)).toThrow();
    const old = measurement(); old.contract = "native-evaluation-context-measurement.v1"; expect(() => assess(old)).toThrow();
  });
});
