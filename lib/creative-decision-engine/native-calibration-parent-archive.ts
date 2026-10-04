import { createHash } from "node:crypto";
import { stableCanonicalJson } from "./canonical-evaluation";
import { openNativeArchiveByContract, isReferenceNativeArchiveContract, isNativeArchiveSegmentContract,
  type NativeArchiveBundle, type NativeArchiveGeneration } from "./native-evidence-archive";
import { AD_CALIBRATION_JOB_NAME, computeNativeAdCalibrationCellSetHash,
  isNativeAdCalibrationReadableContract } from "./jobs/ad-calibration-job";

/** Offline transport only. Does not provide a database connection, uploader,
 * production reader, schema deployment, credential export or removal authority. */
export const NATIVE_CALIBRATION_PARENT_ARCHIVE_CONTRACT = "native-calibration-parent-archive.v1" as const;
export const NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT = "native-calibration-reference-parent-archive.v1" as const;
export const NATIVE_SEGMENT_CALIBRATION_PARENT_ARCHIVE_CONTRACT = "native-calibration-reference-segment-parent-archive.v1" as const;
export const NATIVE_CALIBRATION_PARENT_TABLES = [
  "engine_v3_ad_account_calibration_batches", "engine_v3_ad_account_calibration_daily", "engine_v3_job_runs",
] as const;
type ParentTable = typeof NATIVE_CALIBRATION_PARENT_TABLES[number];
type Row = Record<string, unknown>;
export interface NativeCalibrationParentSchema {
  tables: { table: ParentTable; columns: { name: string; type: string; nullable: boolean }[] }[];
  foreignKeys: { childTable: string; parentTable: string; definition: string }[];
}
export interface NativeCalibrationParentInput {
  core: NativeArchiveBundle;
  /** From the independently trusted core index, not a downloaded self-report. */
  coreManifestHash: string;
  schema: NativeCalibrationParentSchema;
  tables: { table: ParentTable; rowJson: string[] }[];
}
export interface NativeCalibrationParentBundle {
  core: NativeArchiveBundle;
  manifest: {
    contract: typeof NATIVE_CALIBRATION_PARENT_ARCHIVE_CONTRACT | typeof NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT |
      typeof NATIVE_SEGMENT_CALIBRATION_PARENT_ARCHIVE_CONTRACT;
    coverage: "core_referenced_complete_calibration_batches" | "segment_referenced_complete_calibration_batches";
    providerAuthority: false; reclaimEligible: false;
    generation: NativeArchiveGeneration; capturedAt: string;
    sourceRevision: string; sourceWorkspaceDirty: boolean;
    coreManifestHash: string; coreSchemaHash: string;
    schema: NativeCalibrationParentSchema; schemaHash: string;
    externalIdentityRoots: { businessId: string; provider: "meta"; providerAccountRefId: string; providerAccountId: string }[];
    tables: { table: ParentTable; rowCount: number; rows: { id: string; objectHash: string }[] }[];
  };
  objects: Record<string, string>;
}
function refused(message: string): never { throw new Error(`Calibration parent archive refused: ${message}`); }
function hash(bytes: string) { return createHash("sha256").update(bytes, "utf8").digest("hex"); }
function digest(value: unknown) { return hash(stableCanonicalJson(value)); }
function order(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) refused("object missing");
  return value as Row;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) refused("text identity missing");
  return value;
}
function uuid(value: unknown) {
  const s = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) refused("UUID identity invalid");
  return s;
}
/** Comparison only: retains PostgreSQL microseconds and never rewrites stored
 * or canonical clocks. The exporter must serialize timestamptz in UTC. */
function instant(value: unknown): string {
  // The existing pin census retains transaction_timestamp()::text, whereas
  // row JSONB uses ISO text. Accept BOTH original UTC spellings unchanged.
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00(?::00)?)$/.exec(text(value));
  const seconds = m ? m[1]! + "T" + m[2]! : "";
  if (!m || !Number.isFinite(Date.parse(seconds + "Z")) ||
    new Date(seconds + "Z").toISOString().slice(0,19) !== seconds) refused("UTC microsecond clock invalid");
  return seconds + "." + (m[3] ?? "").padEnd(6, "0");
}
function noCredentials(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(access_token|refresh_token|password_hash|client_secret|credentials?)$/i.test(key)) refused("credential field in parent payload");
    noCredentials(child);
  }
}
function verify(bundle: NativeCalibrationParentBundle) {
  const m = bundle.manifest, core = bundle.core.manifest;
  const segmented = isNativeArchiveSegmentContract(core.contract);
  const expectedContract = segmented ? NATIVE_SEGMENT_CALIBRATION_PARENT_ARCHIVE_CONTRACT : isReferenceNativeArchiveContract(core.contract) ?
    NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT : NATIVE_CALIBRATION_PARENT_ARCHIVE_CONTRACT;
  if (m.contract !== expectedContract || m.coverage !== (segmented ? "segment_referenced_complete_calibration_batches" : "core_referenced_complete_calibration_batches") ||
    m.providerAuthority !== false || m.reclaimEligible !== false || digest(m.generation) !== digest(core.generation) ||
    m.capturedAt !== core.capturedAt || m.sourceRevision !== core.sourceRevision || m.sourceWorkspaceDirty !== core.sourceWorkspaceDirty ||
    m.coreSchemaHash !== core.schemaHash || digest(m.schema) !== m.schemaHash) refused("scope/source/schema differs");
  const trusted = { manifestHash: m.coreManifestHash, schemaHash: m.coreSchemaHash, generation: m.generation };
  const coreReader = openNativeArchiveByContract(bundle.core, trusted);
  const names = [...NATIVE_CALIBRATION_PARENT_TABLES], schema = new Map(m.schema.tables.map(t => [t.table, t]));
  const tables = new Map(m.tables.map(t => [t.table, t]));
  if (m.schema.tables.length !== names.length || schema.size !== names.length || m.tables.length !== names.length ||
    tables.size !== names.length || names.some(t => !schema.has(t) || !tables.has(t))) refused("parent table inventory differs");
  const parsed = new Map<ParentTable, Row[]>(), verified = new Map<ParentTable, string[]>(), usedObjects = new Set<string>();
  for (const name of names) {
    const t = tables.get(name)!, columns = schema.get(name)!.columns.map(c => c.name).sort();
    if (!columns.length || new Set(columns).size !== columns.length || !columns.includes("id") ||
      t.rowCount !== t.rows.length || !Number.isInteger(t.rowCount)) refused("invalid parent schema/count");
    const ids = new Set<string>(), rows: Row[] = [], bytes: string[] = [];
    for (const ref of t.rows) {
      const raw = bundle.objects[ref.objectHash];
      if (!/^[0-9a-f]{64}$/.test(ref.objectHash) || typeof raw !== "string" || hash(raw) !== ref.objectHash) refused("missing/corrupt parent bytes");
      const row = object(JSON.parse(raw)); noCredentials(row);
      if (uuid(row.id) !== ref.id || ids.has(ref.id) || digest(Object.keys(row).sort()) !== digest(columns)) refused("parent identity/columns differ");
      if (row.business_ref_id !== m.generation.businessId || row.business_id !== m.generation.businessId ||
        row.as_of_date !== m.generation.asOfDate || row.engine_version !== m.generation.engineVersion) refused("foreign calibration parent");
      ids.add(ref.id); usedObjects.add(ref.objectHash); rows.push(row); bytes.push(raw);
    }
    parsed.set(name, rows); verified.set(name, bytes);
  }
  if (usedObjects.size !== Object.keys(bundle.objects).length) refused("unreferenced parent object");
  const batches = parsed.get(names[0]!)!, cells = parsed.get(names[1]!)!, jobs = parsed.get(names[2]!)!;
  const batchById = new Map(batches.map(b => [b.id, b])), cellById = new Map(cells.map(c => [c.id, c]));
  const usedBatches = new Set<unknown>(), usedJobs = new Set<unknown>();
  const jobsById = new Map(jobs.map(j => [j.id, j]));
  const roots = new Map<string, NativeCalibrationParentBundle["manifest"]["externalIdentityRoots"][number]>();
  for (const batch of batches) {
    const contractVersion = text(batch.contract_version);
    if (batch.provider !== "meta" || batch.completeness_status !== "complete" || !batch.completed_at ||
      instant(batch.computed_at) !== instant(batch.as_of_cutoff) || instant(batch.completed_at) > instant(m.capturedAt) ||
      !isNativeAdCalibrationReadableContract(contractVersion)) refused("incomplete/unsupported batch");
    const batchCells = cells.filter(c => c.batch_id === batch.id);
    if (!Number.isSafeInteger(batch.expected_cell_count) || Number(batch.expected_cell_count) <= 0 ||
      batchCells.length !== batch.expected_cell_count) refused("complete batch cardinality differs");
    const job = jobsById.get(batch.job_run_id);
    if (!job || job.job_name !== AD_CALIBRATION_JOB_NAME || job.status !== "success" || !job.finished_at ||
      instant(job.finished_at) > instant(m.capturedAt) || (job.dependency_run_id !== null && job.dependency_run_id !== undefined)) refused("original calibration producer receipt missing/unsupported");
    usedJobs.add(job.id);
    for (const cell of batchCells) {
      if (["business_ref_id", "business_id", "provider", "provider_account_ref_id", "provider_account_id", "as_of_date",
        "engine_version", "policy_version", "contract_version", "source_manifest_hash", "job_run_id"].some(k => cell[k] !== batch[k]) ||
        cell.batch_input_manifest_hash !== batch.input_manifest_hash || instant(cell.as_of_cutoff) !== instant(batch.as_of_cutoff) ||
        instant(cell.computed_at) !== instant(batch.computed_at)) refused("cell/batch lineage differs");
    }
    const cellSetHash = computeNativeAdCalibrationCellSetHash(batchCells.map(c => ({ key: {
      businessId: text(c.business_id), providerAccountRefId: uuid(c.provider_account_ref_id), providerAccountId: text(c.provider_account_id),
      accountTimezone: text(c.account_timezone), accountCurrency: text(c.account_currency), cellScope: c.cell_scope as "objective_cohort_context",
      objective: text(c.objective), cohort: c.funnel_cohort as "purchase", optimizationContext: text(c.optimization_context),
    }, inputManifestHash: text(c.input_manifest_hash), sourceManifestHash: text(c.source_manifest_hash) })), contractVersion);
    if (cellSetHash !== batch.cell_set_hash) refused("complete batch cell-set hash differs");
  }
  if (cells.some(c => !batchById.has(c.batch_id))) refused("cell batch absent");
  for (const id of usedJobs) {
    const receipt = jobsById.get(id)!;
    const retainedCellCount = batches.filter(b => b.job_run_id === id).reduce((n,b) => n + Number(b.expected_cell_count), 0);
    if (!Number.isSafeInteger(receipt.row_count) || Number(receipt.row_count) < retainedCellCount) refused("original producer row count differs");
  }
  const contexts = coreReader.readTable("engine_v3_ad_decision_evaluation_contexts").map(r => object(JSON.parse(r.rowJson)));
  const contextBatch = new Map<unknown, Row | null>();
  for (const context of contexts) {
    const envelope = object(context.context_json), health = object(envelope.dataHealth), calibration = object(health.calibration);
    if (context.data_health_json !== undefined && digest(context.data_health_json) !== digest(envelope.dataHealth)) refused("context health projection differs");
    const root = { businessId: m.generation.businessId, provider: "meta" as const,
      providerAccountRefId: uuid(context.provider_account_ref_id), providerAccountId: text(context.provider_account_id) };
    if (roots.has(root.providerAccountRefId) && digest(roots.get(root.providerAccountRefId)) !== digest(root)) refused("conflicting external identity root");
    roots.set(root.providerAccountRefId, root);
    if (calibration.computedAt === null) {
      const profile = object(envelope.accountProfile);
      if (profile.profileType !== "native_ad_soft_only" || profile.selectedCell !== null) refused("unresolved original calibration identity");
      contextBatch.set(context.id, null); continue;
    }
    const matching = batches.filter(b => b.provider_account_ref_id === context.provider_account_ref_id &&
      b.provider_account_id === context.provider_account_id && b.as_of_date === calibration.asOfDate &&
      instant(b.computed_at) === instant(calibration.computedAt));
    if (matching.length !== 1) refused("missing/ambiguous original calibration computation");
    if (instant(matching[0]!.computed_at) > instant(context.evaluated_at)) refused("calibration after original evaluation");
    contextBatch.set(context.id, matching[0]!); usedBatches.add(matching[0]!.id);
  }
  const evaluations = new Map(coreReader.readTable("engine_v3_ad_decision_evaluations").map(r => {
    const row = object(JSON.parse(r.rowJson)); return [row.id, row] as const;
  }));
  for (const copy of coreReader.readTable("engine_v3_ad_decision_snapshots_daily")) {
    const s = object(JSON.parse(copy.rowJson)), batch = contextBatch.get(evaluations.get(s.evaluation_id)!.context_id);
    if (s.calibration_row_id === null) {
      const context = contexts.find(c => c.id === evaluations.get(s.evaluation_id)!.context_id)!;
      if (batch && object(object(context.context_json).accountProfile).profileType !== "native_ad_soft_only") refused("snapshot calibration parent absent");
      continue;
    }
    const cell = cellById.get(s.calibration_row_id);
    if (!cell || !batch || cell.batch_id !== batch.id || cell.provider_account_ref_id !== s.provider_account_ref_id ||
      cell.provider_account_id !== s.provider_account_id) refused("snapshot calibration lineage differs");
  }
  const nativeJob = object(JSON.parse(coreReader.readTable("engine_v3_job_runs")[0]!.rowJson));
  if (nativeJob.dependency_run_id !== null && nativeJob.dependency_run_id !== undefined) {
    const dependency = jobsById.get(nativeJob.dependency_run_id);
    // A later idempotent calibration attempt can differ from the immutable
    // original batch producer. Preserve both receipts instead of relabeling it.
    if (!dependency || dependency.job_name !== AD_CALIBRATION_JOB_NAME || dependency.status !== "success" ||
      !dependency.finished_at || instant(dependency.finished_at) > instant(m.capturedAt)) refused("native dependency receipt absent");
    usedJobs.add(dependency.id);
  }
  if (usedBatches.size !== batches.length || usedJobs.size !== jobs.length) refused("unreferenced calibration batch/job");
  const externalRoots = [...roots.values()].sort((a,b) => order(a.providerAccountRefId,b.providerAccountRefId));
  if (digest(externalRoots) !== digest(m.externalIdentityRoots)) refused("external identity roots differ");
  return { coreReader, verified };
}

export function buildNativeCalibrationParentArchive(input: NativeCalibrationParentInput) {
  const cm = input.core.manifest, objects: Record<string, string> = {};
  const contexts = cm.tables.find(t => t.table === "engine_v3_ad_decision_evaluation_contexts")!.rows;
  const roots = new Map<string, NativeCalibrationParentBundle["manifest"]["externalIdentityRoots"][number]>();
  for (const ref of contexts) {
    const c = object(JSON.parse(input.core.objects[ref.objectHash]!));
    roots.set(text(c.provider_account_ref_id), { businessId: cm.generation.businessId, provider: "meta",
      providerAccountRefId: uuid(c.provider_account_ref_id), providerAccountId: text(c.provider_account_id) });
  }
  const bundle: NativeCalibrationParentBundle = { core: input.core, objects, manifest: {
    contract: isNativeArchiveSegmentContract(cm.contract) ? NATIVE_SEGMENT_CALIBRATION_PARENT_ARCHIVE_CONTRACT :
      isReferenceNativeArchiveContract(cm.contract) ? NATIVE_REFERENCE_CALIBRATION_PARENT_ARCHIVE_CONTRACT :
      NATIVE_CALIBRATION_PARENT_ARCHIVE_CONTRACT,
    coverage: isNativeArchiveSegmentContract(cm.contract) ? "segment_referenced_complete_calibration_batches" : "core_referenced_complete_calibration_batches",
    providerAuthority: false, reclaimEligible: false, generation: cm.generation, capturedAt: cm.capturedAt,
    sourceRevision: cm.sourceRevision, sourceWorkspaceDirty: cm.sourceWorkspaceDirty,
    coreManifestHash: input.coreManifestHash, coreSchemaHash: cm.schemaHash, schema: input.schema, schemaHash: digest(input.schema),
    externalIdentityRoots: [...roots.values()].sort((a,b) => order(a.providerAccountRefId,b.providerAccountRefId)),
    tables: input.tables.map(t => ({ table: t.table, rowCount: t.rowJson.length, rows: t.rowJson.map(rowJson => {
      const objectHash = hash(rowJson); objects[objectHash] = rowJson;
      return { id: uuid(object(JSON.parse(rowJson)).id), objectHash };
    }).sort((a,b) => order(a.id,b.id)) })).sort((a,b) => order(a.table,b.table)),
  } };
  verify(bundle);
  return { bundle, manifestHash: digest(bundle.manifest) };
}

export function openNativeCalibrationParentArchive(bundle: NativeCalibrationParentBundle, expected: {
  manifestHash: string; schemaHash: string; generation: NativeArchiveGeneration;
}) {
  if (digest(bundle.manifest) !== expected.manifestHash || bundle.manifest.schemaHash !== expected.schemaHash ||
    digest(bundle.manifest.generation) !== digest(expected.generation)) refused("trusted manifest/schema/generation differs");
  const { coreReader, verified } = verify(bundle);
  return { authority: "historical_read_only" as const, providerAuthority: false as const, reclaimEligible: false as const,
    originalJobRunId: bundle.manifest.generation.jobRunId, readCoreTable: coreReader.readTable,
    readCampaignContext: coreReader.readCampaignContext,
    readParentTable(table: ParentTable) { return [...(verified.get(table) ?? refused("unsupported parent table"))]; } };
}

/** Offline projection from a COMPLETE independently verified original bundle.
 * Retains each referenced batch's ALL cells and the original dependency receipt.
 * It does not trim/recompute a batch or change any original row/clock. */
export function projectNativeCalibrationParentsToSegment(original: NativeCalibrationParentBundle, expected: {
  manifestHash: string; schemaHash: string; generation: NativeArchiveGeneration;
}, core: NativeArchiveBundle) {
  if (isNativeArchiveSegmentContract(original.core.manifest.contract) || !isNativeArchiveSegmentContract(core.manifest.contract))
    refused("complete original and explicit segment required");
  const view = openNativeCalibrationParentArchive(original, expected);
  const selected = openNativeArchiveByContract(core, { manifestHash: digest(core.manifest),
    schemaHash: core.manifest.schemaHash, generation: core.manifest.generation });
  if (core.manifest.segment!.originalParentManifestHash !== expected.manifestHash ||
      core.manifest.segment!.originalCoreManifestHash !== original.manifest.coreManifestHash ||
      digest(core.manifest.generation) !== digest(original.manifest.generation)) refused("segment original root differs");
  const batches = view.readParentTable("engine_v3_ad_account_calibration_batches").map(raw => ({ raw, row: object(JSON.parse(raw)) }));
  const batchIds = new Set<unknown>();
  for (const copy of selected.readTable("engine_v3_ad_decision_evaluation_contexts")) {
    const c = object(JSON.parse(copy.rowJson)), calibration = object(object(object(c.context_json).dataHealth).calibration);
    if (calibration.computedAt === null) continue;
    const matches = batches.filter(({row}) => row.provider_account_ref_id === c.provider_account_ref_id &&
      row.provider_account_id === c.provider_account_id && row.as_of_date === calibration.asOfDate &&
      instant(row.computed_at) === instant(calibration.computedAt));
    if (matches.length !== 1) refused("selected original calibration batch differs");
    batchIds.add(matches[0]!.row.id);
  }
  const neededBatches = batches.filter(({row}) => batchIds.has(row.id));
  const jobIds = new Set(neededBatches.map(({row}) => row.job_run_id));
  const nativeJob = object(JSON.parse(selected.readTable("engine_v3_job_runs")[0]!.rowJson));
  if (nativeJob.dependency_run_id !== null && nativeJob.dependency_run_id !== undefined) jobIds.add(nativeJob.dependency_run_id);
  return buildNativeCalibrationParentArchive({ core, coreManifestHash: digest(core.manifest), schema: original.manifest.schema,
    tables: [
      { table: "engine_v3_ad_account_calibration_batches", rowJson: neededBatches.map(({raw}) => raw) },
      { table: "engine_v3_ad_account_calibration_daily", rowJson: view.readParentTable("engine_v3_ad_account_calibration_daily")
        .filter(raw => batchIds.has(object(JSON.parse(raw)).batch_id)) },
      { table: "engine_v3_job_runs", rowJson: view.readParentTable("engine_v3_job_runs").filter(raw => jobIds.has(object(JSON.parse(raw)).id)) },
    ] });
}
