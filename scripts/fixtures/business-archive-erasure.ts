/** Synthetic historical-only fixture. Never a native decision producer or a
 * current authority source. Used by disposable tests and explicit release QA. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildNativeEvidenceArchive } from "../../lib/creative-decision-engine/native-evidence-archive";
import { buildNativeCalibrationParentArchive } from "../../lib/creative-decision-engine/native-calibration-parent-archive";
import { computeNativeAdCalibrationCellSetHash } from "../../lib/creative-decision-engine/jobs/ad-calibration-job";
import { openNativeHistoricalArchiveEnvelope, sealCompressedNativeHistoricalArchive,
  type NativeHistoricalArchiveCatalogEntry } from "../../lib/creative-decision-engine/native-historical-archive";

export async function businessArchiveFixture(businessId: string, options: {
  inputEvidenceRowJson?: string; encryptionKey?: Buffer; encryptionKeyId?: string;
} = {}) {
  const f = JSON.parse(await readFile(join(process.cwd(), "scripts/fixtures/native-historical-worker.json"), "utf8"));
  const original = openNativeHistoricalArchiveEnvelope(Buffer.from(f.ciphertextBase64, "base64"), f.entry,
    Buffer.from(f.fixtureEncryptionKeyHex, "hex"), f.request.generation).bundle;
  const generation = { ...original.core.manifest.generation, businessId, jobRunId: randomUUID() };
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
  const core = buildNativeEvidenceArchive({ ...original.core.manifest, generation, schema: coreSchema,
    tables: original.core.manifest.tables.map(t => ({ table: t.table,
      rowJson: t.table === "engine_v3_ad_decision_input_evidence" && options.inputEvidenceRowJson ? [options.inputEvidenceRowJson]
        : t.rows.map(r => rewrite(original.core.objects[r.objectHash]!)) })) });
  const parents = buildNativeCalibrationParentArchive({ schema: original.manifest.schema,
    core: core.bundle, coreManifestHash: core.manifestHash,
    tables: parentTables.map(t => ({ ...t, rowJson: t.rowJson.map(rewrite) })) });
  const key = options.encryptionKey ?? Buffer.from(f.fixtureEncryptionKeyHex, "hex"), keyId = options.encryptionKeyId ?? f.entry.encryptionKeyId;
  const sealed = sealCompressedNativeHistoricalArchive(parents.bundle, { generation, manifestHash: parents.manifestHash,
    schemaHash: parents.bundle.manifest.schemaHash }, keyId, key);
  const entry: NativeHistoricalArchiveCatalogEntry = { ...sealed.trust, object: { bucket: "adsecute-native-local",
    key: `native/v2/${sealed.trust.ciphertextSha256}.bin`, versionId: sealed.trust.ciphertextSha256 } };
  return { syntheticFixtureOnly: true as const, entry, bytes: sealed.bytes, generation, key, keyId,
    inputEvidence: parents.bundle.core.objects[parents.bundle.core.manifest.tables.find(t => t.table === "engine_v3_ad_decision_input_evidence")!.rows[0]!.objectHash]! };
}
