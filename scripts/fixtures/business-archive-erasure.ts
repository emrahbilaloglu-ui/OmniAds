/** Synthetic historical-only fixture. Never a native decision producer or a
 * current authority source. Used by disposable tests and explicit release QA. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildNativeEvidenceArchive, buildNativeReferenceEvidenceArchive } from "../../lib/creative-decision-engine/native-evidence-archive";
import { buildNativeCalibrationParentArchive } from "../../lib/creative-decision-engine/native-calibration-parent-archive";
import { computeNativeAdCalibrationCellSetHash } from "../../lib/creative-decision-engine/jobs/ad-calibration-job";
import { openNativeHistoricalArchiveEnvelope, sealCompressedNativeHistoricalArchive,
  NATIVE_HISTORICAL_COMPACT_ROOT_CATALOG_CONTRACT,
  NATIVE_HISTORICAL_TENANT_OBJECT_LAYOUT, nativeHistoricalArchiveObjectKey,
  type NativeHistoricalArchiveCatalogEntry } from "../../lib/creative-decision-engine/native-historical-archive";
import { splitNativeReferenceArchive } from "../../lib/creative-decision-engine/native-reference-archive-segments";
import { encodeNativeArchiveRoot, NATIVE_ARCHIVE_ROOT_ENCODING } from "../../lib/creative-decision-engine/native-archive-root-codec";

export async function businessArchiveFixture(businessId: string, options: {
  inputEvidenceRowJson?: string; encryptionKey?: Buffer; encryptionKeyId?: string;
  compactRoot?: boolean;
  jobRunId?: string;
  tenantObjects?: boolean;
} = {}) {
  const f = JSON.parse(await readFile(join(process.cwd(), options.compactRoot ?
    "scripts/fixtures/native-historical-worker-reference.json" : "scripts/fixtures/native-historical-worker.json"), "utf8"));
  const original = openNativeHistoricalArchiveEnvelope(Buffer.from(f.ciphertextBase64, "base64"), f.entry,
    Buffer.from(f.fixtureEncryptionKeyHex, "hex"), f.request.generation).bundle;
  const generation = { ...original.core.manifest.generation, businessId, jobRunId: options.jobRunId ?? randomUUID() };
  const oldInputRef = original.core.manifest.tables.find(t => t.table === "engine_v3_ad_decision_input_evidence")!.rows[0]!;
  const oldInput = JSON.parse(original.core.objects[oldInputRef.objectHash]!);
  const input = options.inputEvidenceRowJson ? JSON.parse(options.inputEvidenceRowJson) : oldInput;
  const rewrittenHashes = new Map<string, string>();
  const rewrite = (text: string) => {
    let updated = text.replaceAll(original.core.manifest.generation.businessId, businessId)
    .replaceAll(original.core.manifest.generation.jobRunId, generation.jobRunId)
    .replaceAll(oldInput.contract_version, input.contract_version).replaceAll(oldInput.input_hash, input.input_hash);
    for (const [before, after] of rewrittenHashes) updated = updated.replaceAll(before, after);
    return updated;
  };
  const parentTables = original.manifest.tables.map(t => ({ table: t.table, rowJson: t.rows.map(r => rewrite(original.objects[r.objectHash]!)) }));
  const cells = parentTables.find(t => t.table === "engine_v3_ad_account_calibration_daily")!.rowJson.map(raw => JSON.parse(raw));
  const batches = parentTables.find(t => t.table === "engine_v3_ad_account_calibration_batches")!;
  batches.rowJson = batches.rowJson.map(raw => {
    const batch = JSON.parse(raw);
    const after = computeNativeAdCalibrationCellSetHash(cells.filter(c => c.batch_id === batch.id).map(c => ({ key: {
      businessId: c.business_id, providerAccountRefId: c.provider_account_ref_id, providerAccountId: c.provider_account_id,
      accountTimezone: c.account_timezone, accountCurrency: c.account_currency, cellScope: c.cell_scope,
      objective: c.objective, cohort: c.funnel_cohort, optimizationContext: c.optimization_context,
    }, inputManifestHash: c.input_manifest_hash, sourceManifestHash: c.source_manifest_hash })), batch.contract_version);
    rewrittenHashes.set(batch.cell_set_hash, after); batch.cell_set_hash = after; return JSON.stringify(batch);
  });
  const coreSchema = structuredClone(original.core.manifest.schema);
  if (options.inputEvidenceRowJson) coreSchema.tables.find(t => t.table === "engine_v3_ad_decision_input_evidence")!.columns =
    Object.keys(input).map(name => ({ name, type: "synthetic-qa-row", nullable: input[name] === null }));
  const buildCore = options.compactRoot ? buildNativeReferenceEvidenceArchive : buildNativeEvidenceArchive;
  const core = buildCore({ ...original.core.manifest, generation, schema: coreSchema,
    tables: original.core.manifest.tables.map(t => ({ table: t.table,
      rowJson: t.table === "engine_v3_ad_decision_input_evidence" && options.inputEvidenceRowJson ? [options.inputEvidenceRowJson]
        : t.rows.map(r => rewrite(original.core.objects[r.objectHash]!)) })) });
  const parents = buildNativeCalibrationParentArchive({ schema: original.manifest.schema,
    core: core.bundle, coreManifestHash: core.manifestHash,
    tables: parentTables.map(t => ({ ...t, rowJson: t.rowJson.map(rewrite) })) });
  const key = options.encryptionKey ?? Buffer.from(f.fixtureEncryptionKeyHex, "hex"), keyId = options.encryptionKeyId ?? f.entry.encryptionKeyId;
  const expected = { generation, manifestHash: parents.manifestHash, schemaHash: parents.bundle.manifest.schemaHash };
  const split = options.compactRoot ? splitNativeReferenceArchive(parents.bundle,expected) : null;
  const part = split?.parts[0];
  if(split && split.parts.length!==1)throw new Error("synthetic fixture requires one original fragment");
  const sealed = part && split ? sealCompressedNativeHistoricalArchive(part.bundle,{...expected,
    manifestHash:part.manifestHash,schemaHash:part.bundle.manifest.schemaHash},keyId,key,{
      coverageRoot:split.root,coverageRootSha256:split.rootDigest,evaluationIds:part.bundle.core.manifest.segment!.evaluationIds,
    },{metadataEncoding:NATIVE_ARCHIVE_ROOT_ENCODING}) : sealCompressedNativeHistoricalArchive(parents.bundle,expected,keyId,key);
  const entry: NativeHistoricalArchiveCatalogEntry = { ...sealed.trust, object: { bucket: "adsecute-native-local",
    key: nativeHistoricalArchiveObjectKey(sealed.trust,options.tenantObjects?NATIVE_HISTORICAL_TENANT_OBJECT_LAYOUT:undefined),
    versionId: sealed.trust.ciphertextSha256,...(options.tenantObjects?{layout:NATIVE_HISTORICAL_TENANT_OBJECT_LAYOUT}:{}) } };
  const leaf = split ? Buffer.from(JSON.stringify({contract:NATIVE_HISTORICAL_COMPACT_ROOT_CATALOG_CONTRACT,
    groups:[{coverageRoot:encodeNativeArchiveRoot(split.root),coverageRootSha256:split.rootDigest}],
    entries:[{...entry,segment:{coverageRootSha256:split.rootDigest,evaluationIds:sealed.trust.segment!.evaluationIds}}]})) : null;
  return { syntheticFixtureOnly: true as const, entry, leaf, bytes: sealed.bytes, generation, key, keyId,
    inputEvidence: parents.bundle.core.objects[parents.bundle.core.manifest.tables.find(t => t.table === "engine_v3_ad_decision_input_evidence")!.rows[0]!.objectHash]! };
}
