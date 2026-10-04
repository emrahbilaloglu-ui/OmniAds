import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Client } from "pg";
import type { DbClient } from "@/lib/db";
import { buildCanonicalEvaluationProvenance } from "@/lib/creative-decision-engine/canonical-evaluation";
import { buildAdCanonicalEvaluationProvenance, persistAdDecisionEvaluations } from "@/lib/creative-decision-engine/evaluation-store";
import { makeAccountDecisionProfile, makeCreativeInput, makeDataHealth, makeDataLayerHealth } from "@/lib/creative-decision-engine/__tests__/helpers";
import { EMPTY_HYDRATED_CONFIG_AUTHORITY } from "@/lib/creative-decision-engine/native-ad-hydration-authority";
import { NATIVE_AD_ENGINE_VERSION, type DecisionOutput } from "@/lib/creative-decision-engine/types";
import { nativeCampaignContextSql, NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE } from "@/lib/creative-decision-engine/native-campaign-context-storage";
import { buildNativeReferenceEvidenceArchive, buildNativeSupersededReferenceEvidenceArchive,
  NATIVE_REFERENCE_ARCHIVE_TABLES, type NativeArchiveSchema, type NativeArchiveTableInput } from "@/lib/creative-decision-engine/native-evidence-archive";
import { buildNativeCalibrationParentArchive, NATIVE_CALIBRATION_PARENT_TABLES,
  type NativeCalibrationParentSchema,type NativeCalibrationParentBundle } from "@/lib/creative-decision-engine/native-calibration-parent-archive";
import { readNativeArchivePinCensus } from "@/lib/creative-decision-engine/native-archive-pin-census";
import { openNativeHistoricalArchiveEnvelope, sealCompressedNativeHistoricalArchive,
  openNativeHistoricalArchiveEvidence,openNativeHistoricalArchiveCatalog,resolveNativeHistoricalArchiveEntry,
  nativeArchiveByteDigest,NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT } from "@/lib/creative-decision-engine/native-historical-archive";
import { splitNativeReferenceArchive, reassembleNativeReferenceArchive } from "@/lib/creative-decision-engine/native-reference-archive-segments";
import { AD_CALIBRATION_JOB_NAME, NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  computeNativeAdCalibrationCellSetHash } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";

const FLAG = "ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED";
const CLOCK = "2026-09-24T07:00:00.000001Z";
function quote(name: string) {
  assert(/^[a-z_][a-z0-9_]*$/.test(name), "unsafe owned identifier");
  return `"${name}"`;
}
async function insert(db: Client, table: string, row: Record<string, unknown>) {
  const names = Object.keys(row);
  await db.query(`INSERT INTO public.${quote(table)} (${names.map(quote).join(",")})
    VALUES (${names.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(row));
}
async function sqlState(db: Client, sql: string, values: unknown[], expected: string) {
  await db.query("SAVEPOINT reference_archive_negative");
  let actual: string | undefined;
  try { await db.query(sql, values); } catch (error) { actual = (error as { code?: string }).code; }
  finally { await db.query("ROLLBACK TO SAVEPOINT reference_archive_negative; RELEASE SAVEPOINT reference_archive_negative"); }
  assert(actual === expected, `expected SQLSTATE${expected}, actual${actual}`);
}

/** Public 501-row actual-producer fixture only. Each source/restore installs
 * actual migrations in a different NEW owned database. Identity roots are
 * provisioned independently; credentials and source parent tables are not
 * copied. This does not grant production capture/removal/shared-object GC or
 * establish a natural successor, positive reuse, all readers or full DR. */
export async function verifyNativeReferenceArchiveRoundTrip(cluster: Client) {
  return verifyOwnedReferenceTransport(cluster,false);
}

/** NEW1134-row actual-producer path, deliberately larger than8MiB original
 * content. No natural-production or parent-DR claim is inferred from a fixture. */
export async function verifyNativeSegmentedReferenceArchiveRoundTrip(cluster: Client) {
  return verifyOwnedReferenceTransport(cluster,true);
}

async function verifyOwnedReferenceTransport(cluster: Client, segmented: boolean) {
  const cp = (cluster as Client & { connectionParameters: { database: string; host: string; port: number } }).connectionParameters;
  assert(cp.database === "native_ad_seam" && cp.host === "127.0.0.1" && ![5432, 15432].includes(cp.port),
    "reference archive requires the owned native-ad server");
  assert(process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1", "explicit owned scope required");
  const previous = process.env[FLAG];
  const business = randomUUID(), accountRef = randomUUID(), native = randomUUID(), producer = randomUUID(), batch = randomUUID();
  const cells = [randomUUID(), randomUUID()], account = "act_reference_archive_fixture", date = "2026-09-24";
  const epoch = NATIVE_AD_ENGINE_VERSION, hash = "a".repeat(64);
  const evaluationCount = segmented ? 1134 : 501;
  const provisionIdentity = async (db: Client) => {
    const user = randomUUID();
    await insert(db, "users", { id: user, name: "Owned reference archive", email: `${user}@example.invalid`, password_hash: "owned-fixture-only" });
    await insert(db, "businesses", { id: business, name: "Owned reference archive", owner_id: user });
    await insert(db, "provider_accounts", { id: accountRef, provider: "meta", external_account_id: account });
    await insert(db, "business_provider_accounts", { business_id: business, provider: "meta", provider_account_ref_id: accountRef,
      provider_account_id: account, is_selected: true });
    return user;
  };
  const withDatabase = async (purpose: string, run: (db: Client) => Promise<void>) => {
    const name = `reference_archive_${purpose}_${randomUUID().replaceAll("-", "")}`;
    assert((await cluster.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount === 0, "refuse existing database");
    await cluster.query(`CREATE DATABASE ${quote(name)} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    const url = `postgresql://postgres@127.0.0.1:${cp.port}/${name}`;
    const db = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    let connected = false;
    try {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-migrations.ts"], { cwd: process.cwd(), stdio: "inherit",
        env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, DB_SSL_MODE: "disable",
          ENABLE_RUNTIME_MIGRATIONS: "1", ADSECUTE_EPHEMERAL_DB_SEAM: "1", [FLAG]: "false" } });
      const exit = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
      assert(exit === 0, `actual full-DDL migrations EXIT${exit}`);
      await db.connect(); connected = true;
      assert((await db.query("SHOW server_encoding")).rows[0].server_encoding === "UTF8", "owned reference archive database encoding differs");
      await run(db);
    } finally {
      if (connected) await db.end();
      await cluster.query(`DROP DATABASE ${quote(name)}`);
    }
  };
  try {
    await withDatabase("source", async source => {
      const sourceOwner = await provisionIdentity(source);
      const jobCommon = { business_ref_id: business, business_id: business, as_of_date: date, engine_version: epoch,
        status: "success", started_at: CLOCK, finished_at: CLOCK, created_at: CLOCK };
      await insert(source, "engine_v3_job_runs", { ...jobCommon, id: producer, job_name: AD_CALIBRATION_JOB_NAME, row_count: 2 });
      await insert(source, "engine_v3_job_runs", { ...jobCommon, id: native, job_name: "engine_v3_native_ad_decisions_shadow_job",
        row_count: evaluationCount, dependency_run_id: producer, finished_at: "2026-09-24T07:02:00.000001Z" });
      const parentCommon = { business_ref_id: business, business_id: business, provider: "meta", provider_account_ref_id: accountRef,
        provider_account_id: account, as_of_date: date, as_of_cutoff: CLOCK, computed_at: CLOCK, engine_version: epoch,
        policy_version: "reference-archive-fixture", contract_version: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
        source_manifest_hash: hash, job_run_id: producer, created_at: CLOCK };
      const parentCells = cells.map((id, i) => ({ ...parentCommon, id, batch_id: batch, account_timezone: "UTC", account_currency: "USD",
        cell_scope: "objective_cohort_context" as const, objective: "sales", funnel_cohort: "purchase" as const, optimization_context: String(i),
        sample_window_start: "2026-06-26", sample_window_end: "2026-09-23", sample_window_days: 90,
        source_ad_count: 1, source_day_count: 1, eligible_ad_count: 1, mature_ad_count: 1, zero_conversion_ad_count: 0,
        account_cpa_sample_count: 1, meta_attributed_aov_purchase_count_90d: 1, meta_attributed_revenue_90d: 100,
        meta_aov_quality: "low_sample", funnel_calibration_json: {}, metric_sample_counts_json: {}, action_readiness_json: {}, quality_counts_json: {},
        config_authority_counts_json: {}, quality_status: "low_sample", target_authority_status: "missing", target_authority_hash: hash,
        batch_input_manifest_hash: hash, input_manifest_hash: hash }));
      const cellSet = computeNativeAdCalibrationCellSetHash(parentCells.map(cell => ({ key: {
        businessId: business, providerAccountRefId: accountRef, providerAccountId: account, accountTimezone: cell.account_timezone,
        accountCurrency: cell.account_currency, cellScope: cell.cell_scope, objective: cell.objective, cohort: cell.funnel_cohort,
        optimizationContext: cell.optimization_context }, inputManifestHash: hash, sourceManifestHash: hash })));
      await source.query("BEGIN");
      await insert(source, "engine_v3_ad_account_calibration_batches", { ...parentCommon, id: batch,
        transaction_isolation: "repeatable read", source_mode: "current_transaction_snapshot",
        source_provenance_json: { mode: "current_transaction_snapshot", transactionCutoff: CLOCK, transactionIsolation: "repeatable read" },
        expected_cell_count: 2, generation_content_hash: hash, input_manifest_hash: hash, cell_set_hash: cellSet, completeness_status: "writing" });
      for (const cell of parentCells) await insert(source, "engine_v3_ad_account_calibration_daily", cell);
      await source.query("UPDATE engine_v3_ad_account_calibration_batches SET completeness_status='complete',completed_at=$2 WHERE id=$1", [batch, CLOCK]);
      await source.query("COMMIT");
      const profile = makeAccountDecisionProfile({ businessId: business, asOfDate: date, scope: { type: "account", id: account } });
      const health = makeDataHealth({ calibration: makeDataLayerHealth({ asOfDate: date, computedAt: CLOCK }) });
      const evaluations = Array.from({ length: evaluationCount }, (_, index) => {
        const creative = makeCreativeInput({ businessId: business, creativeId: `reference_archive_creative_${index}`, campaignId: `campaign_${index % 4}` });
        if(segmented) creative.creativeName = `Owned1134 UTF8 İstanbul şğı 🚀 ${index}: ${"Özgün metin 🚀 ".repeat(32)}`;
        const decision: DecisionOutput = { creativeId: creative.creativeId, creativeName: "Owned archive fixture", label: "keep",
          preAuthorityLabel: "keep", authorityBlocker: null, reason: "Public reference archive fixture", confidence: 40,
          truthSource: "commercial_truth", effectiveTargetRoas: 2, ratioToTarget: 1, badges: [], metrics: { spend: 10, purchases: 1, roas: 2, recent7dRoas: 2 },
          engineVersion: epoch, generatedAt: CLOCK };
        const base = buildCanonicalEvaluationProvenance({ engineVersion: epoch, accountProfile: profile, dataHealth: health, scope: profile.scope,
          creativeInput: creative, flags: { businessId: business, enabled: true, surfaceVisible: false, shadowOnly: true, presetOverride: null,
            source: { enabled: "env", surfaceVisible: "env", shadowOnly: "env", presetOverride: null }, envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: true } },
          campaignContext: { mode: "automatic", source: "system_inferred", campaignId: creative.campaignId, kind: "main", testDimension: null,
            contextTrust: "high", sourceRecordType: "engine_v3_campaign_context_daily", sourceRecordId: `archive_İstanbul_şğı_🚀_${index % 4}`,
            sourceAsOfDate: date, sourceUpdatedAt: CLOCK, sourceHash: createHash("sha256").update(`archive_İstanbul_şğı_🚀_${index % 4}`, "utf8").digest("hex") },
          decision, rawLabel: "keep", publishedLabel: "keep", hysteresisSuppressed: false, evaluatedAt: CLOCK });
        return buildAdCanonicalEvaluationProvenance({ base, identity: { decisionEntityType: "ad", decisionEntityId: `reference_archive_ad_${index}`,
          adId: `reference_archive_ad_${index}`, creativeId: creative.creativeId, providerAccountRefId: accountRef, providerAccountId: account },
          adEvidence: { customConversionId: null, configAuthority: EMPTY_HYDRATED_CONFIG_AUTHORITY } });
      });
      const adapter = { query: async (sql: string, values?: unknown[]) => (await source.query(sql, values)).rows } as DbClient;
      process.env[FLAG] = "true";
      await source.query("BEGIN; SET LOCAL statement_timeout='7500ms'");
      try {
        assert((await persistAdDecisionEvaluations({ businessId: business, asOf: date, engineVersion: epoch, scope: profile.scope,
          jobRunId: native, evaluatedAt: CLOCK, evaluations }, adapter)).size === evaluationCount, "actual producer lost selected evaluations");
        await source.query(`INSERT INTO engine_v3_ad_decision_snapshots_daily
          (business_ref_id,business_id,provider_account_ref_id,provider_account_id,decision_entity_type,decision_entity_id,ad_id,
          creative_id,as_of_date,engine_version,scope_type,scope_id,label,raw_label,confidence,truth_source,effective_target_roas,
          badges,reason,job_run_id,calibration_row_id,evaluation_id,input_hash,decision_hash,computed_at)
          SELECT business_ref_id,business_id,provider_account_ref_id,provider_account_id,decision_entity_type,decision_entity_id,ad_id,
          creative_id,as_of_date,engine_version,scope_type,scope_id,'keep','keep',40,'commercial_truth',2,'[]'::jsonb,
          'Owned reference archive fixture',job_run_id,$2::uuid,id,input_hash,decision_hash,evaluated_at
          FROM engine_v3_ad_decision_evaluations WHERE job_run_id=$1`, [native, cells[0]]);
        await source.query("COMMIT");
      } catch (error) { await source.query("ROLLBACK"); throw error; }
      const originalCampaigns = (await source.query(`SELECT to_jsonb(t)::text AS bytes FROM ${quote(NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE)} t ORDER BY payload_sha256`)).rows.map(row => row.bytes);
      assert(originalCampaigns.length === 4, "public fixture shared membership differs");
      for (const row of (await source.query(`SELECT payload_json::text AS bytes, byte_length, encode(payload_sha256,'hex') AS digest
        FROM ${quote(NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE)}`)).rows) {
        assert(row.bytes.includes("İstanbul_şğı_🚀"), "actual producer fixture lost multibyte payload");
        assert(Buffer.byteLength(row.bytes, "utf8") > row.bytes.length && row.byte_length === Buffer.byteLength(row.bytes, "utf8"),
          "actual PG UTF8 byte length differs from original text");
        assert(row.digest === createHash("sha256").update(row.bytes, "utf8").digest("hex"), "actual PG UTF8 digest differs");
      }
      const originalEvaluations = (await source.query("SELECT to_jsonb(t)::text AS bytes FROM engine_v3_ad_decision_evaluations t WHERE job_run_id=$1 ORDER BY id", [native])).rows.map(row => row.bytes);
      const expected = new Map(evaluations.map(value => [value.identity.adId, value]));
      for (const raw of originalEvaluations) {
        const row = JSON.parse(raw), prior = expected.get(row.ad_id);
        assert(prior && prior.inputHash === row.input_hash && prior.decisionHash === row.decision_hash, "original producer canonical hashes differ");
        assert(row.campaign_context_json === null && row.campaign_context_ref, "actual producer did not write original references");
      }
      const generation = { businessId: business, jobRunId: native, asOfDate: date, engineVersion: epoch };
      const capture = async (superseded: boolean) => {
        await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='7500ms'; SET LOCAL timezone='UTC'");
        try {
          const names = [...new Set([...NATIVE_REFERENCE_ARCHIVE_TABLES, ...NATIVE_CALIBRATION_PARENT_TABLES])];
          const columns = (await source.query(`SELECT c.relname AS table,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
            NOT a.attnotnull AS nullable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
            WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [names])).rows;
          const foreignKeys = (await source.query(`SELECT child.relname AS "childTable",parent.relname AS "parentTable",pg_get_constraintdef(con.oid) AS definition
            FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid
            JOIN pg_namespace n ON n.oid=child.relnamespace WHERE con.contype='f' AND n.nspname='public' AND child.relname=ANY($1::text[])
            ORDER BY child.relname,con.conname`, [names])).rows;
          const schemaTables = <T extends string>(tables: readonly T[]) => tables.map(table => ({ table,
            columns: columns.filter(column => column.table === table).map(column => ({ name: column.name as string, type: column.type as string, nullable: column.nullable as boolean })) }));
          const schema: NativeArchiveSchema = { tables: schemaTables(NATIVE_REFERENCE_ARCHIVE_TABLES), foreignKeys };
          const tables: NativeArchiveTableInput[] = [];
          for (const table of NATIVE_REFERENCE_ARCHIVE_TABLES) {
            const predicate = table === "engine_v3_job_runs" ? "t.id=$1::uuid" : table === "engine_v3_ad_decision_input_evidence" ?
              `(t.contract_version,t.input_hash) IN (SELECT contract_version,input_hash FROM engine_v3_ad_decision_evaluations WHERE job_run_id=$1::uuid)` :
              table === NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE ? `(t.business_ref_id,t.payload_sha256) IN
                (SELECT business_ref_id,campaign_context_ref FROM engine_v3_ad_decision_evaluations WHERE job_run_id=$1::uuid)` : "t.job_run_id=$1::uuid";
            tables.push({ table, rowJson: (await source.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${quote(table)} t WHERE ${predicate}`, [native])).rows.map(row => row.bytes as string) });
          }
          const capturedAt = (await source.query("SELECT transaction_timestamp()::text AS captured")).rows[0].captured as string;
          const coreInput = { generation, capturedAt, schema, tables,
            sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            sourceWorkspaceDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0 };
          const census = superseded ? await readNativeArchivePinCensus(source, { schema: "public", generation, unmodeledReferences: [] }) : null;
          const core = census ? buildNativeSupersededReferenceEvidenceArchive({ ...coreInput, capturedAt: census.observedAt, pinCensus: census }) :
            buildNativeReferenceEvidenceArchive(coreInput);
          const parentSchema: NativeCalibrationParentSchema = { tables: schemaTables(NATIVE_CALIBRATION_PARENT_TABLES), foreignKeys };
          const parentTables = [];
          for (const table of NATIVE_CALIBRATION_PARENT_TABLES) parentTables.push({ table,
            rowJson: (await source.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${quote(table)} t WHERE ${table === "engine_v3_job_runs" || table === "engine_v3_ad_account_calibration_batches" ? "t.id=$1::uuid" : "t.batch_id=$1::uuid"}`,
              [table === "engine_v3_job_runs" ? producer : batch])).rows.map(row => row.bytes as string) });
          return buildNativeCalibrationParentArchive({ core: core.bundle, coreManifestHash: core.manifestHash, schema: parentSchema, tables: parentTables });
        } finally { await source.query("ROLLBACK"); }
      };
      const original = await capture(false);
      // Fixture-only state change: original shared/evaluation bytes stay
      // immutable. This is not a naturally produced successor or retention.
      await source.query("DELETE FROM engine_v3_ad_decision_snapshots_daily WHERE job_run_id=$1", [native]);
      const superseded = await capture(true);
      assert.deepEqual((await source.query("SELECT to_jsonb(t)::text AS bytes FROM engine_v3_ad_decision_evaluations t WHERE job_run_id=$1 ORDER BY id", [native])).rows.map(row => row.bytes), originalEvaluations);
      assert.deepEqual((await source.query(`SELECT to_jsonb(t)::text AS bytes FROM ${quote(NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE)} t ORDER BY payload_sha256`)).rows.map(row => row.bytes), originalCampaigns);
      for (const [index, built] of [original, superseded].entries()) await withDatabase(`restore_${index}`, async target => {
        assert(await provisionIdentity(target) !== sourceOwner, "restore borrowed source credential identity");
        const trust = { generation, manifestHash: built.manifestHash, schemaHash: built.bundle.manifest.schemaHash };
        let transportSummary:Record<string,unknown>;
        let opened;
        if(segmented) {
          const originalBytes=Buffer.byteLength(JSON.stringify(built.bundle),"utf8");
          assert(originalBytes>8*1024*1024,"1134 fixture failed to exercise the measured oversized shape");
          assert.throws(()=>sealCompressedNativeHistoricalArchive(built.bundle,trust,"public-fixture-key",Buffer.alloc(32,0x5a)),/outside bound/);
          const captured=splitNativeReferenceArchive(built.bundle,trust);
          assert(captured.parts.length>1,"oversized complete original was not fragmented");
          const sizes:{decodedBytes:number;compressedBytes:number|undefined;ciphertextBytes:number}[]=[];
          const decrypted:NativeCalibrationParentBundle[]=[];
          const encrypted=[];
          for(const part of captured.parts) {
            const sealed=sealCompressedNativeHistoricalArchive(part.bundle,{manifestHash:part.manifestHash,
              schemaHash:part.bundle.manifest.schemaHash,generation},"public-fixture-key",Buffer.alloc(32,0x5a),{
              coverageRoot:captured.root,coverageRootSha256:captured.rootDigest,evaluationIds:part.bundle.core.manifest.segment!.evaluationIds,
            });
            const partial=openNativeHistoricalArchiveEnvelope(sealed.bytes,sealed.trust,Buffer.alloc(32,0x5a),generation);
            assert.deepEqual(partial.bundle,part.bundle,"fragment changed original byte strings");
            const selected=partial.view.readCoreTable("engine_v3_ad_decision_evaluations")[0]!,r=JSON.parse(selected.rowJson);
            const request={generation,evaluationId:r.id,providerAccountId:r.provider_account_id,adId:r.ad_id};
            if(built.bundle.manifest.sourceWorkspaceDirty) {
              assert.throws(()=>openNativeHistoricalArchiveEvidence(sealed.bytes,sealed.trust,Buffer.alloc(32,0x5a),request),/dirty published/);
            } else {
              const evidence=openNativeHistoricalArchiveEvidence(sealed.bytes,sealed.trust,Buffer.alloc(32,0x5a),request);
              assert(evidence.rowJson.evaluation===selected.rowJson&&evidence.providerAuthority===false,"clean fragment evidence differs/grants authority");
            }
            sizes.push({decodedBytes:sealed.trust.plaintextBytes,compressedBytes:sealed.trust.payloadBytes,ciphertextBytes:sealed.trust.ciphertextBytes});
            decrypted.push(partial.bundle);
            encrypted.push(sealed);
          }
          const catalogBytes=Buffer.from(JSON.stringify({contract:NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT,
            groups:[{coverageRoot:captured.root,coverageRootSha256:captured.rootDigest}],entries:encrypted.map((blob,index)=>({
              ...blob.trust,segment:{coverageRootSha256:captured.rootDigest,evaluationIds:blob.trust.segment!.evaluationIds},
              object:{bucket:"owned-fixture",key:`native/v2/${blob.trust.ciphertextSha256}.bin`,versionId:`owned-fixture-${index}`},
            }))}),"utf8");
          const catalog=openNativeHistoricalArchiveCatalog(catalogBytes,nativeArchiveByteDigest(catalogBytes));
          for(let index=0;index<decrypted.length;index++) {
            const r=JSON.parse(decrypted[index]!.core.objects[decrypted[index]!.core.manifest.tables.find(t=>t.table==="engine_v3_ad_decision_evaluations")!.rows[0]!.objectHash]!);
            const selected=resolveNativeHistoricalArchiveEntry(catalog,{generation,evaluationId:r.id,providerAccountId:r.provider_account_id,adId:r.ad_id});
            assert(selected.ciphertextSha256===encrypted[index]!.trust.ciphertextSha256,"v3 catalog selected a different original fragment");
            assert.deepEqual(openNativeHistoricalArchiveEnvelope(encrypted[index]!.bytes,selected,Buffer.alloc(32,0x5a),generation).bundle,decrypted[index]);
          }
          opened=reassembleNativeReferenceArchive(decrypted,captured.root,captured.rootDigest);
          assert.throws(()=>reassembleNativeReferenceArchive(decrypted.slice(1),captured.root,captured.rootDigest),/incomplete/);
          assert.throws(()=>reassembleNativeReferenceArchive([...decrypted,decrypted[0]!],captured.root,captured.rootDigest),/overlapping/);
          transportSummary={wholeOriginalDecodedBytes:originalBytes,segments:sizes,wholeReassemblyExact:true,
            catalogBytes:catalogBytes.length,catalogOriginalSelectionMatched:true,
            cleanHistoricalResponseObserved:!built.bundle.manifest.sourceWorkspaceDirty};
        } else {
          const sealed=sealCompressedNativeHistoricalArchive(built.bundle,trust,"public-fixture-key",Buffer.alloc(32,0x5a));
          opened=openNativeHistoricalArchiveEnvelope(sealed.bytes,sealed.trust,Buffer.alloc(32,0x5a),generation);
          transportSummary={plaintextBytes:sealed.trust.plaintextBytes,ciphertextBytes:sealed.trust.ciphertextBytes};
        }
        const {view,bundle}=opened;
        assert.deepEqual(bundle, built.bundle, "encrypted reference transport changed original bytes");
        await target.query("BEGIN; SET LOCAL statement_timeout='7500ms'; SET LOCAL timezone='UTC'");
        try {
          const restore = async (table: string, raw: string) => target.query(`INSERT INTO public.${quote(table)}
            SELECT * FROM jsonb_populate_record(NULL::public.${quote(table)},$1::jsonb)`, [raw]);
          for (const raw of view.readParentTable("engine_v3_job_runs")) await restore("engine_v3_job_runs", raw);
          const batchBytes = view.readParentTable("engine_v3_ad_account_calibration_batches")[0]!;
          await target.query(`INSERT INTO engine_v3_ad_account_calibration_batches SELECT * FROM jsonb_populate_record(
            NULL::engine_v3_ad_account_calibration_batches,jsonb_set(jsonb_set($1::jsonb,'{completeness_status}','"writing"'::jsonb),'{completed_at}','null'::jsonb))`, [batchBytes]);
          for (const raw of view.readParentTable("engine_v3_ad_account_calibration_daily")) await restore("engine_v3_ad_account_calibration_daily", raw);
          await target.query("UPDATE engine_v3_ad_account_calibration_batches SET completeness_status='complete',completed_at=$2 WHERE id=$1", [batch, JSON.parse(batchBytes).completed_at]);
          const order = [NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE, ...NATIVE_REFERENCE_ARCHIVE_TABLES.filter(table => table !== NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE)];
          for (const table of order) {
            const rows = view.readCoreTable(table).map(row => row.rowJson);
            for (let offset = 0; offset < rows.length; offset += 100) await target.query(`INSERT INTO public.${quote(table)}
              SELECT * FROM jsonb_populate_recordset(NULL::public.${quote(table)},$1::jsonb)`, [`[${rows.slice(offset, offset + 100).join(",")}]`]);
          }
          for (const table of [...new Set([...NATIVE_REFERENCE_ARCHIVE_TABLES, ...NATIVE_CALIBRATION_PARENT_TABLES])]) {
            const expectedRows = table === "engine_v3_job_runs" ? [...view.readParentTable(table), ...view.readCoreTable(table).map(row => row.rowJson)] :
              NATIVE_REFERENCE_ARCHIVE_TABLES.includes(table as never) ? view.readCoreTable(table as typeof NATIVE_REFERENCE_ARCHIVE_TABLES[number]).map(row => row.rowJson) :
              view.readParentTable(table as typeof NATIVE_CALIBRATION_PARENT_TABLES[number]);
            const actual = (await target.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${quote(table)} t`)).rows.map(row => row.bytes as string).sort();
            assert.deepEqual(actual, expectedRows.sort(), `${table} full original JSONB/ID/hash/clock parity`);
          }
          assert((await target.query(`SELECT count(*)::int AS n FROM engine_v3_ad_decision_evaluations e
            WHERE ${nativeCampaignContextSql("e")} IS NOT NULL AND e.campaign_context_json IS NULL`)).rows[0].n === evaluationCount,
          "restored actual SQL accessor lost a shared original");
          const selected = view.readCoreTable("engine_v3_ad_decision_evaluations")[0]!;
          assert(view.readCampaignContext(String(JSON.parse(selected.rowJson).id))?.objectRowJson, "historical reader shared root absent");
          await sqlState(target, `DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1`, [business], "23514");
          await sqlState(target, `UPDATE engine_v3_ad_decision_evaluations SET campaign_context_ref=decode($1,'hex') WHERE id=$2`,
            ["b".repeat(64), JSON.parse(selected.rowJson).id], "23503");
          await sqlState(target, "UPDATE engine_v3_ad_account_calibration_daily SET computed_at=computed_at+interval '1 microsecond' WHERE id=$1", [cells[0]], "P0001");
          assert(view.providerAuthority === false && view.reclaimEligible === false, "historical copy granted authority");
          await target.query("COMMIT");
        } catch (error) { await target.query("ROLLBACK"); throw error; }
        console.log(JSON.stringify({ contract: segmented?"native-reference-segmented-archive-real-schema-fixture.v1":"native-reference-archive-real-schema-fixture.v1", superseded: index === 1,
          actualProducerEvaluations: evaluationCount, sharedObjects: 4, uniqueTransportTables: 8, fullMigrationSourceAndRestore: true,
          originalFullRowIdClockHashParity: true, independentIdentityRoots: true, productionAccess: false,
          serverEncoding: "UTF8", multibyteOriginalProducerAndRestoreParity: true,
          sourceWorkspaceDirty: built.bundle.manifest.sourceWorkspaceDirty,...transportSummary,
          sharedObjectGcEligible: false, naturalSuccessorProof: false,
          physicalReclaimProof: false, providerAuthority: false }));
      });
    });
  } finally { if (previous === undefined) delete process.env[FLAG]; else process.env[FLAG] = previous; }
}
