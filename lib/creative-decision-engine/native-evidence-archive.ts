import { createHash } from "node:crypto";
import { stableCanonicalJson } from "./canonical-evaluation";

/** Offline preparation only. No runtime reader, uploader, writer or evictor imports this module. */
export const NATIVE_ARCHIVE_CONTRACT = "native-generation-core-archive.v1" as const;
export const NATIVE_ARCHIVE_TABLES = [
  "engine_v3_job_runs",
  "engine_v3_ad_decision_evaluation_contexts",
  "engine_v3_ad_decision_evaluations",
  "engine_v3_ad_decision_input_evidence",
  "engine_v3_ad_decision_snapshots_daily",
] as const;
export type NativeArchiveTable = typeof NATIVE_ARCHIVE_TABLES[number];
export interface NativeArchiveGeneration {
  businessId: string;
  jobRunId: string;
  asOfDate: string;
  engineVersion: string;
}
export interface NativeArchiveSchema {
  tables: { table: NativeArchiveTable; columns: { name: string; type: string; nullable: boolean }[] }[];
  /** Catalog definitions, including external roots and incoming pins. Not a claim of closure. */
  foreignKeys: { childTable: string; parentTable: string; definition: string }[];
}
export interface NativeArchiveTableInput {
  table: NativeArchiveTable;
  /** PostgreSQL to_jsonb(row)::text. Never parse and reserialize decimal/bigint evidence. */
  rowJson: string[];
}
export interface NativeArchiveBundle {
  manifest: {
    contract: typeof NATIVE_ARCHIVE_CONTRACT;
    coverage: "sampled_native_generation_core";
    reclaimEligible: false;
    providerAuthority: false;
    capturedAt: string;
    /** HEAD of the captured workspace; a dirty workspace is not an exact build revision. */
    sourceRevision: string;
    sourceWorkspaceDirty: boolean;
    generation: NativeArchiveGeneration;
    schema: NativeArchiveSchema;
    schemaHash: string;
    tables: { table: NativeArchiveTable; rowCount: number; rows: { key: string; objectHash: string }[] }[];
  };
  /** Content-addressed exact PostgreSQL JSON bytes, with a separate trusted manifest digest. */
  objects: Record<string, string>;
}
const KEY_COLUMNS: Record<NativeArchiveTable, string[]> = {
  engine_v3_job_runs: ["id"],
  engine_v3_ad_decision_evaluation_contexts: ["id"],
  engine_v3_ad_decision_evaluations: ["id"],
  engine_v3_ad_decision_input_evidence: ["contract_version", "input_hash"],
  engine_v3_ad_decision_snapshots_daily: ["id"],
};
function fail(message: string): never { throw new Error(`Native archive refused: ${message}`); }
function sha(bytes: string): string { return createHash("sha256").update(bytes, "utf8").digest("hex"); }
function compareCodeUnits(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function jsonRow(bytes: string): Record<string, unknown> {
  const row: unknown = JSON.parse(bytes);
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("row is not an object");
  return row as Record<string, unknown>;
}
function rowKey(table: NativeArchiveTable, row: Record<string, unknown>): string {
  const parts = KEY_COLUMNS[table].map(column => {
    const value = row[column];
    if (typeof value !== "string" || !value.trim()) fail(`invalid ${table} primary key`);
    return value;
  });
  return stableCanonicalJson(parts);
}
function verifyRows(bundle: NativeArchiveBundle): Map<NativeArchiveTable, { key: string; rowJson: string }[]> {
  const m = bundle.manifest;
  if (m.contract !== NATIVE_ARCHIVE_CONTRACT || m.coverage !== "sampled_native_generation_core" ||
      m.reclaimEligible !== false || m.providerAuthority !== false) fail("unsupported scope or authority");
  if (!/^[0-9a-f]{40}$/.test(m.sourceRevision) || typeof m.sourceWorkspaceDirty !== "boolean" ||
      !Number.isFinite(Date.parse(m.capturedAt))) fail("source clock/revision missing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.generation.asOfDate) || !m.generation.engineVersion.trim()) fail("generation date/epoch missing");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(m.generation.businessId) || !uuid.test(m.generation.jobRunId)) fail("generation identity invalid");
  if (sha(stableCanonicalJson(m.schema)) !== m.schemaHash) fail("schema digest mismatch");
  const schemas = new Map(m.schema.tables.map(t => [t.table, t]));
  const tables = new Map(m.tables.map(t => [t.table, t]));
  if (m.tables.length !== NATIVE_ARCHIVE_TABLES.length || tables.size !== NATIVE_ARCHIVE_TABLES.length ||
      m.schema.tables.length !== NATIVE_ARCHIVE_TABLES.length || schemas.size !== NATIVE_ARCHIVE_TABLES.length ||
      NATIVE_ARCHIVE_TABLES.some(t => !tables.has(t) || !schemas.has(t))) fail("missing/extra/duplicate core table");
  const used = new Set<string>();
  const parsed = new Map<NativeArchiveTable, Record<string, unknown>[]>();
  const verified = new Map<NativeArchiveTable, { key: string; rowJson: string }[]>();
  for (const name of NATIVE_ARCHIVE_TABLES) {
    const table = tables.get(name)!;
    const columns = schemas.get(name)!.columns.map(c => c.name).sort();
    if (!columns.length || new Set(columns).size !== columns.length) fail("invalid schema columns");
    if (!Number.isInteger(table.rowCount) || table.rowCount !== table.rows.length) fail("row count mismatch");
    const keys = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    const copies: { key: string; rowJson: string }[] = [];
    for (const ref of table.rows) {
      if (!/^[0-9a-f]{64}$/.test(ref.objectHash)) fail("invalid object digest");
      const bytes = bundle.objects[ref.objectHash];
      if (typeof bytes !== "string" || sha(bytes) !== ref.objectHash) fail("missing/corrupt object");
      const row = jsonRow(bytes);
      if (stableCanonicalJson(Object.keys(row).sort()) !== stableCanonicalJson(columns)) fail("row/schema columns differ");
      if (rowKey(name, row) !== ref.key || keys.has(ref.key)) fail("changed/duplicate row identity");
      keys.add(ref.key); used.add(ref.objectHash);
      if (name !== "engine_v3_ad_decision_input_evidence") {
        const g = m.generation;
        if (row.business_ref_id !== g.businessId || row.business_id !== g.businessId ||
            row.as_of_date !== g.asOfDate || row.engine_version !== g.engineVersion ||
            (name === "engine_v3_job_runs" ? row.id : row.job_run_id) !== g.jobRunId) fail("foreign generation row");
      }
      rows.push(row); copies.push({ key: ref.key, rowJson: bytes });
    }
    parsed.set(name, rows); verified.set(name, copies);
  }
  if (Object.keys(bundle.objects).length !== used.size) fail("unreferenced object");
  const jobs = parsed.get("engine_v3_job_runs")!;
  const evaluations = parsed.get("engine_v3_ad_decision_evaluations")!;
  const contexts = new Map(parsed.get("engine_v3_ad_decision_evaluation_contexts")!.map(r => [r.id, r]));
  const snapshots = parsed.get("engine_v3_ad_decision_snapshots_daily")!;
  const evidence = new Set(parsed.get("engine_v3_ad_decision_input_evidence")!.map(r =>
    stableCanonicalJson([r.contract_version, r.input_hash])));
  if (jobs.length !== 1 || jobs[0]!.status !== "success" ||
      jobs[0]!.job_name !== "engine_v3_native_ad_decisions_shadow_job" ||
      !evaluations.length || Number(jobs[0]!.row_count) !== evaluations.length || snapshots.length !== evaluations.length) fail("incomplete original generation");
  const evalById = new Map(evaluations.map(r => [r.id, r]));
  const shared = ["business_ref_id", "business_id", "provider_account_ref_id", "provider_account_id",
    "as_of_date", "engine_version", "scope_type", "scope_id", "job_run_id"];
  const usedEvidence = new Set<string>(), usedContexts = new Set<unknown>(), usedEvaluations = new Set<unknown>();
  for (const evaluation of evaluations) {
    const context = contexts.get(evaluation.context_id);
    if (!context || [...shared, "contract_version"].some(k => context[k] !== evaluation[k])) fail("broken context lineage");
    const key = stableCanonicalJson([evaluation.contract_version, evaluation.input_hash]);
    if (!evidence.has(key)) fail("input evidence absent (legacy contracts need a separate adapter)");
    usedContexts.add(evaluation.context_id); usedEvidence.add(key);
  }
  for (const snapshot of snapshots) {
    const evaluation = evalById.get(snapshot.evaluation_id);
    if (!evaluation || usedEvaluations.has(snapshot.evaluation_id) ||
        [...shared, "decision_entity_type", "decision_entity_id", "ad_id", "input_hash", "decision_hash"]
          .some(k => snapshot[k] !== evaluation[k])) fail("broken snapshot lineage");
    usedEvaluations.add(snapshot.evaluation_id);
  }
  if (usedContexts.size !== contexts.size || usedEvidence.size !== evidence.size) fail("extra context/evidence");
  return verified;
}

export function buildNativeEvidenceArchive(input: {
  generation: NativeArchiveGeneration; capturedAt: string; sourceRevision: string; sourceWorkspaceDirty: boolean;
  schema: NativeArchiveSchema; tables: NativeArchiveTableInput[];
}): { bundle: NativeArchiveBundle; manifestHash: string } {
  const objects: Record<string, string> = {};
  const bundle: NativeArchiveBundle = {
    manifest: { contract: NATIVE_ARCHIVE_CONTRACT, coverage: "sampled_native_generation_core",
      reclaimEligible: false, providerAuthority: false, capturedAt: input.capturedAt,
      sourceRevision: input.sourceRevision, sourceWorkspaceDirty: input.sourceWorkspaceDirty,
      generation: input.generation, schema: input.schema,
      schemaHash: sha(stableCanonicalJson(input.schema)),
      tables: input.tables.map(t => ({ table: t.table, rowCount: t.rowJson.length,
        rows: t.rowJson.map(bytes => {
          const hash = sha(bytes); objects[hash] = bytes;
          return { key: rowKey(t.table, jsonRow(bytes)), objectHash: hash };
        }).sort((a, b) => compareCodeUnits(a.key, b.key)),
      })).sort((a, b) => compareCodeUnits(a.table, b.table)) }, objects,
  };
  verifyRows(bundle);
  return { bundle, manifestHash: sha(stableCanonicalJson(bundle.manifest)) };
}

/** Digest must come from a trusted index, never from the downloaded bundle itself. */
export function openNativeEvidenceArchive(bundle: NativeArchiveBundle, expected: {
  manifestHash: string; schemaHash: string; generation: NativeArchiveGeneration;
}) {
  if (sha(stableCanonicalJson(bundle.manifest)) !== expected.manifestHash ||
      bundle.manifest.schemaHash !== expected.schemaHash ||
      stableCanonicalJson(bundle.manifest.generation) !== stableCanonicalJson(expected.generation)) fail("trusted manifest/schema/generation mismatch");
  const verified = verifyRows(bundle);
  return {
    // Historical record bytes may describe an original authorized verdict.
    // Their archive availability never authorizes execution now.
    authority: "historical_read_only" as const,
    providerAuthority: false as const,
    reclaimEligible: false as const,
    originalJobRunId: bundle.manifest.generation.jobRunId,
    capturedAt: bundle.manifest.capturedAt,
    readTable(table: NativeArchiveTable): readonly { key: string; rowJson: string }[] {
      return verified.get(table)!.map(row => ({ ...row }));
    },
  };
}
