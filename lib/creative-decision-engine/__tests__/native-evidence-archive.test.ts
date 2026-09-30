import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { stableCanonicalJson } from "../canonical-evaluation";
import { buildNativeEvidenceArchive, openNativeEvidenceArchive, NATIVE_ARCHIVE_TABLES,
  buildNativeSupersededEvidenceArchive, openNativeSupersededEvidenceArchive,
  type NativeArchiveBundle, type NativeArchiveTableInput } from "../native-evidence-archive";
import { assessNativeArchivePins, NATIVE_PIN_CLASSES, type NativeArchivePinCensus } from "../native-archive-pin-census";

const businessId = "00000000-0000-4000-8000-000000000001";
const jobRunId = "00000000-0000-4000-8000-000000000002";
const generation = { businessId, jobRunId, asOfDate: "2026-09-30", engineVersion: "fixture-native" };
const common = { business_ref_id: businessId, business_id: businessId,
  as_of_date: generation.asOfDate, engine_version: generation.engineVersion, job_run_id: jobRunId,
  provider_account_ref_id: "account-ref", provider_account_id: "act_1", scope_type: "account", scope_id: "act_1" };
const context = { ...common, id: "context", contract_version: "fixture-v1", context_json: { calibration: "historical" } };
const evaluation = { ...common, id: "evaluation", context_id: "context", contract_version: "fixture-v1",
  input_hash: "a".repeat(64), decision_hash: "b".repeat(64), decision_entity_type: "ad", decision_entity_id: "ad_1", ad_id: "ad_1" };
function fixture() {
  const rowByTable = [
    { ...common, id: jobRunId, job_name: "engine_v3_native_ad_decisions_shadow_job", status: "success", row_count: 1,
      finished_at: "2026-09-30T03:00:00Z" },
    context, evaluation,
    { contract_version: "fixture-v1", input_hash: evaluation.input_hash, input_evidence_json: { purchase: "verified" } },
    { ...common, id: "snapshot", evaluation_id: evaluation.id,
      input_hash: evaluation.input_hash, decision_hash: evaluation.decision_hash,
      decision_entity_type: "ad", decision_entity_id: "ad_1", ad_id: "ad_1",
      computed_at: "2026-09-30T03:01:00Z", authorized_action: "cut" },
  ];
  const tables: NativeArchiveTableInput[] = NATIVE_ARCHIVE_TABLES.map((table, i) => ({ table, rowJson: [JSON.stringify(rowByTable[i])] }));
  return buildNativeEvidenceArchive({ generation, capturedAt: "2026-09-30T04:00:00Z", sourceRevision: "a".repeat(40), sourceWorkspaceDirty: false,
    schema: { tables: tables.map((t, i) => ({ table: t.table, columns: Object.keys(rowByTable[i]!).map(name => ({ name, type: "fixture", nullable: false })) })),
      foreignKeys: [{ childTable: "outcomes", parentTable: "engine_v3_ad_decision_evaluations", definition: "external pin: not an eviction bundle" }] }, tables });
}
function trusted(f = fixture()) {
  return { manifestHash: f.manifestHash, schemaHash: f.bundle.manifest.schemaHash, generation };
}
function resign(bundle: NativeArchiveBundle) {
  return { manifestHash: createHash("sha256").update(stableCanonicalJson(bundle.manifest)).digest("hex"), schemaHash: bundle.manifest.schemaHash, generation };
}
describe("offline native core archive", () => {
  it("preserves original evidence while exposing only historical read authority", () => {
    const f = fixture(), reader = openNativeEvidenceArchive(f.bundle, trusted(f));
    expect(reader).toMatchObject({ authority: "historical_read_only", providerAuthority: false, reclaimEligible: false, originalJobRunId: jobRunId });
    expect(JSON.parse(reader.readTable("engine_v3_ad_decision_snapshots_daily")[0]!.rowJson)).toMatchObject({ authorized_action: "cut", computed_at: "2026-09-30T03:01:00Z" });
    // Mutating the downloaded bundle after opening must not mutate verified data.
    f.bundle.objects = {};
    expect(reader.readTable("engine_v3_ad_decision_evaluations")).toHaveLength(1);
  });
  it("refuses corrupt, missing and extra content objects", () => {
    for (const change of ["corrupt", "missing", "extra"]) {
      const f = fixture(), key = Object.keys(f.bundle.objects)[0]!;
      if (change === "corrupt") f.bundle.objects[key] += " ";
      else if (change === "missing") delete f.bundle.objects[key];
      else f.bundle.objects["c".repeat(64)] = "{}";
      expect(() => openNativeEvidenceArchive(f.bundle, trusted(f))).toThrow(/archive refused/i);
    }
  });
  it("refuses an untrusted digest, foreign generation or schema", () => {
    const f = fixture();
    expect(() => openNativeEvidenceArchive(f.bundle, { ...trusted(f), manifestHash: "d".repeat(64) })).toThrow();
    expect(() => openNativeEvidenceArchive(f.bundle, { ...trusted(f), generation: { ...generation, businessId: jobRunId } })).toThrow();
    expect(() => openNativeEvidenceArchive(f.bundle, { ...trusted(f), schemaHash: "d".repeat(64) })).toThrow();
  });
  it("refuses altered scope or row counts even if a manifest is resigned", () => {
    for (const change of ["count", "table", "duplicate", "authority"]) {
      const f = fixture();
      if (change === "count") f.bundle.manifest.tables[0]!.rowCount++;
      else if (change === "table") f.bundle.manifest.tables.pop();
      else if (change === "duplicate") f.bundle.manifest.tables.push(f.bundle.manifest.tables[0]!);
      else Object.assign(f.bundle.manifest, { providerAuthority: true });
      expect(() => openNativeEvidenceArchive(f.bundle, resign(f.bundle))).toThrow();
    }
  });
  it("refuses broken context/snapshot/input lineage rather than returning an incomplete historical row", () => {
    for (const table of ["engine_v3_ad_decision_evaluations", "engine_v3_ad_decision_snapshots_daily", "engine_v3_ad_decision_input_evidence"] as const) {
      const f = fixture(), manifest = f.bundle.manifest.tables.find(t => t.table === table)!;
      const row = JSON.parse(f.bundle.objects[manifest.rows[0]!.objectHash]!);
      if (table === "engine_v3_ad_decision_evaluations") row.context_id = "missing";
      else if (table === "engine_v3_ad_decision_snapshots_daily") row.decision_hash = "f".repeat(64);
      else row.input_hash = "f".repeat(64);
      const tables = NATIVE_ARCHIVE_TABLES.map(name => ({ table: name, rowJson: f.bundle.manifest.tables.find(t => t.table === name)!.rows.map(r => name === table ? JSON.stringify(row) : f.bundle.objects[r.objectHash]!) }));
      expect(() => buildNativeEvidenceArchive({ generation, capturedAt: f.bundle.manifest.capturedAt, sourceRevision: f.bundle.manifest.sourceRevision, sourceWorkspaceDirty: f.bundle.manifest.sourceWorkspaceDirty, schema: f.bundle.manifest.schema, tables })).toThrow();
    }
  });
  it("preserves JSONB numeric bytes beyond Javascript precision without reserialization", () => {
    const f = fixture(), m = f.bundle.manifest.tables.find(t => t.table === "engine_v3_ad_decision_input_evidence")!;
    const bytes = f.bundle.objects[m.rows[0]!.objectHash]!.replace('"verified"', '9007199254740993.123456789');
    const tables = NATIVE_ARCHIVE_TABLES.map(table => ({ table, rowJson: f.bundle.manifest.tables.find(t => t.table === table)!.rows.map(r => table === m.table ? bytes : f.bundle.objects[r.objectHash]!) }));
    const packed = buildNativeEvidenceArchive({ generation, capturedAt: f.bundle.manifest.capturedAt, sourceRevision: f.bundle.manifest.sourceRevision, sourceWorkspaceDirty: f.bundle.manifest.sourceWorkspaceDirty, schema: f.bundle.manifest.schema, tables });
    expect(openNativeEvidenceArchive(packed.bundle, trusted(packed)).readTable(m.table)[0]!.rowJson).toContain("9007199254740993.123456789");
  });
  it("records a dirty workspace without presenting HEAD as an exact source build", () => {
    const f = fixture();
    const tables = NATIVE_ARCHIVE_TABLES.map(table => ({ table, rowJson: f.bundle.manifest.tables.find(t => t.table === table)!.rows.map(ref => f.bundle.objects[ref.objectHash]!) }));
    const packed = buildNativeEvidenceArchive({ generation, capturedAt: f.bundle.manifest.capturedAt,
      sourceRevision: f.bundle.manifest.sourceRevision, sourceWorkspaceDirty: true, schema: f.bundle.manifest.schema, tables });
    expect(packed.bundle.manifest.sourceWorkspaceDirty).toBe(true);
    expect(openNativeEvidenceArchive(packed.bundle, trusted(packed)).providerAuthority).toBe(false);
  });
  it("refuses a foreign tenant or job inside a row even when bundle digests are rebuilt", () => {
    for (const column of ["business_ref_id", "business_id", "job_run_id"] as const) {
      const f = fixture();
      const tables = NATIVE_ARCHIVE_TABLES.map(table => ({ table, rowJson: f.bundle.manifest.tables.find(t => t.table === table)!.rows.map(ref => {
        const bytes = f.bundle.objects[ref.objectHash]!;
        return table === "engine_v3_ad_decision_evaluations" ? JSON.stringify({ ...JSON.parse(bytes), [column]: "00000000-0000-4000-8000-999999999999" }) : bytes;
      }) }));
      expect(() => buildNativeEvidenceArchive({ generation, capturedAt: f.bundle.manifest.capturedAt,
        sourceRevision: f.bundle.manifest.sourceRevision, sourceWorkspaceDirty: f.bundle.manifest.sourceWorkspaceDirty, schema: f.bundle.manifest.schema, tables })).toThrow(/foreign generation row/);
    }
  });
});

function supersededInput() {
  const f = fixture();
  const pinCensus: NativeArchivePinCensus = {
    contract: "bounded-native-pin-census.v1", coverage: "catalog_incoming_and_declared_non_fk",
    generation, observedAt: f.bundle.manifest.capturedAt, jobFinishedAt: "2026-09-30T03:00:00Z",
    jobRowCount: "1", evaluationCount: "1", catalogHash: "c".repeat(64), reclaimEligible: false,
    counts: NATIVE_PIN_CLASSES.map(pinClass => ({ pinClass, count: "0" })), foreignKeyReferences: [], unknownReferences: [],
  };
  return { generation, capturedAt: f.bundle.manifest.capturedAt, sourceRevision: f.bundle.manifest.sourceRevision,
    sourceWorkspaceDirty: false, schema: f.bundle.manifest.schema, pinCensus,
    tables: NATIVE_ARCHIVE_TABLES.map(table => ({ table, rowJson: table === "engine_v3_ad_decision_snapshots_daily" ? [] :
      f.bundle.manifest.tables.find(t => t.table === table)!.rows.map(r => f.bundle.objects[r.objectHash]!) })) };
}
describe("superseded historical archive boundary", () => {
  it("preserves a complete original generation without fabricating old serving snapshots", () => {
    const input = supersededInput(), f = buildNativeSupersededEvidenceArchive(input);
    const reader = openNativeSupersededEvidenceArchive(f.bundle, trusted(f));
    expect(reader.readTable("engine_v3_ad_decision_snapshots_daily")).toEqual([]);
    expect(reader.readTable("engine_v3_ad_decision_evaluations")).toHaveLength(1);
    expect(reader).toMatchObject({ providerAuthority: false, reclaimEligible: false, originalJobRunId: jobRunId });
    expect(() => openNativeEvidenceArchive(f.bundle, trusted(f))).toThrow(/contract mismatch/);
  });
  it("refuses still-serving, unknown-inventory and changed-clock copies", () => {
    for (const change of ["snapshot_pin", "unknown", "clock", "finish_clock", "precision_clock", "count"]) {
      const input = supersededInput();
      if (change === "snapshot_pin") input.pinCensus.counts[0]!.count = "1";
      else if (change === "unknown") input.pinCensus.unknownReferences = ["new_proposal_reader"];
      else if (change === "clock") input.pinCensus.observedAt = "2026-09-30T04:01:00Z";
      else if (change === "finish_clock") input.pinCensus.jobFinishedAt = "2026-09-30T03:01:00Z";
      else if (change === "precision_clock") input.pinCensus.jobFinishedAt = "2026-09-30T03:00:00.000001Z";
      else input.pinCensus.evaluationCount = "2";
      expect(() => buildNativeSupersededEvidenceArchive(input)).toThrow(/refused/);
    }
  });
  it("historical copying retains pins; each pin independently vetoes a removal candidate", () => {
    for (const pinClass of NATIVE_PIN_CLASSES.filter(c => c !== "snapshots")) {
      const input = supersededInput();
      input.pinCensus.counts.find(c => c.pinClass === pinClass)!.count = "1";
      expect(assessNativeArchivePins(input.pinCensus, generation)).toMatchObject({ candidateWithinSupportedScope: false, reason: "live_pins", reclaimEligible: false });
      const f = buildNativeSupersededEvidenceArchive(input);
      expect(openNativeSupersededEvidenceArchive(f.bundle, trusted(f)).reclaimEligible).toBe(false);
    }
  });
  it("refuses corrupt content and cross-contract authority even with a resigned manifest", () => {
    const input = supersededInput(), f = buildNativeSupersededEvidenceArchive(input);
    f.bundle.objects[Object.keys(f.bundle.objects)[0]!] += " ";
    expect(() => openNativeSupersededEvidenceArchive(f.bundle, trusted(f))).toThrow(/corrupt/);
    const valid = buildNativeSupersededEvidenceArchive(supersededInput());
    Object.assign(valid.bundle.manifest, { reclaimEligible: true });
    expect(() => openNativeSupersededEvidenceArchive(valid.bundle, resign(valid.bundle))).toThrow(/authority/);
  });
});
