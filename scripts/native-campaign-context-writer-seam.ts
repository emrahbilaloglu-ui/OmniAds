import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "pg";
import type { DbClient } from "@/lib/db";
import { buildCanonicalEvaluationProvenance } from "@/lib/creative-decision-engine/canonical-evaluation";
import { buildAdCanonicalEvaluationProvenance, persistAdDecisionEvaluations } from "@/lib/creative-decision-engine/evaluation-store";
import { nativeCampaignContextSql } from "@/lib/creative-decision-engine/native-campaign-context-storage";
import { NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITER_SCHEMA_SQL, READ_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY } from "@/lib/creative-decision-engine/native-campaign-context-writer";
import { makeAccountDecisionProfile, makeCreativeInput, makeDataHealth } from "@/lib/creative-decision-engine/__tests__/helpers";
import { EMPTY_HYDRATED_CONFIG_AUTHORITY } from "@/lib/creative-decision-engine/native-ad-hydration-authority";
import { NATIVE_AD_ENGINE_VERSION, type DecisionOutput } from "@/lib/creative-decision-engine/types";

const FLAG = "ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED";
const CLOCK = "2026-09-24T07:00:00.000001Z";
const TABLES = ["engine_v3_ad_decision_evaluation_contexts", "engine_v3_ad_decision_evaluations",
  "engine_v3_ad_decision_input_evidence", "engine_v3_ad_campaign_context_objects"] as const;

/** Two NEW owned databases install the actual migration entrypoint independently.
 * Same public 501-input fixture, actual producer, no dropped constraints/triggers.
 * Quantized fixture heap/TOAST/index and cluster-WAL observations are not a
 * production/global saving forecast, natural job proof or historical reclaim. */
export async function verifyNativeCampaignContextReferenceProducer(parent: Client) {
  const cp = (parent as Client & { connectionParameters: { database: string; host: string; port: number } }).connectionParameters;
  assert(cp.database === "native_ad_seam" && cp.host === "127.0.0.1" && ![5432, 15432].includes(cp.port),
    "campaign writer requires the owned native-ad server");
  assert(process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1", "explicit ephemeral scope required");
  const previousFlag = process.env[FLAG];
  const business = randomUUID(), user = randomUUID(), accountRef = randomUUID(), job = randomUUID();
  const account = "act_campaign_reference_fixture", asOf = "2026-09-24";
  const profile = makeAccountDecisionProfile({ businessId: business, asOfDate: asOf, scope: { type: "account", id: account } });
  const evaluations = Array.from({ length: 501 }, (_, index) => {
    const adId = `campaign_reference_ad_${index}`;
    const creative = makeCreativeInput({ businessId: business, creativeId: `creative_${index}`, campaignId: `campaign_${index % 4}` });
    const decision: DecisionOutput = { creativeId: creative.creativeId, creativeName: "Owned storage fixture", label: "keep",
      preAuthorityLabel: "keep", authorityBlocker: null, reason: "Public storage equality fixture", confidence: 40,
      truthSource: "commercial_truth", effectiveTargetRoas: 2, ratioToTarget: 1, badges: [],
      metrics: { spend: 10, purchases: 1, roas: 2, recent7dRoas: 2 }, engineVersion: NATIVE_AD_ENGINE_VERSION, generatedAt: CLOCK };
    const base = buildCanonicalEvaluationProvenance({ engineVersion: NATIVE_AD_ENGINE_VERSION, accountProfile: profile,
      dataHealth: makeDataHealth(), scope: profile.scope, creativeInput: creative,
      flags: { businessId: business, enabled: true, surfaceVisible: false, shadowOnly: true, presetOverride: null,
        source: { enabled: "env", surfaceVisible: "env", shadowOnly: "env", presetOverride: null },
        envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: true } },
      campaignContext: { mode: "automatic", source: "system_inferred", campaignId: creative.campaignId,
        kind: "main", testDimension: null, contextTrust: "high", sourceRecordType: "engine_v3_campaign_context_daily",
        sourceRecordId: `campaign_source_${index % 4}`, sourceAsOfDate: asOf, sourceUpdatedAt: CLOCK,
        sourceHash: createHash("sha256").update(`source_${index % 4}`).digest("hex") },
      decision, rawLabel: "keep", publishedLabel: "keep", hysteresisSuppressed: false, evaluatedAt: CLOCK });
    return buildAdCanonicalEvaluationProvenance({ base,
      identity: { decisionEntityType: "ad", decisionEntityId: adId, adId, creativeId: creative.creativeId,
        providerAccountRefId: accountRef, providerAccountId: account },
      adEvidence: { customConversionId: null, configAuthority: EMPTY_HYDRATED_CONFIG_AUTHORITY } });
  });
  const input = { businessId: business, asOf, engineVersion: NATIVE_AD_ENGINE_VERSION, scope: profile.scope,
    jobRunId: job, evaluatedAt: CLOCK, evaluations };
  const originalInputBytes = JSON.stringify(input);
  const results: Array<Record<string, unknown>> = [], materialized: string[][] = [];
  try {
    for (const reference of [false, true]) {
      const name = `campaign_writer_${reference ? "reference" : "inline"}_${randomUUID().replaceAll("-", "")}`;
      assert(/^[a-z_0-9]+$/.test(name));
      assert((await parent.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount === 0, "refuse existing database");
      await parent.query(`CREATE DATABASE ${name}`);
      const connectionString = `postgresql://postgres@127.0.0.1:${cp.port}/${name}`;
      const db = new Client({ connectionString, connectionTimeoutMillis: 2000 });
      let connected = false;
      try {
        const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-migrations.ts"], { cwd: process.cwd(), stdio: "inherit",
          env: { ...process.env, [FLAG]: "false", DATABASE_URL: connectionString, DATABASE_URL_UNPOOLED: connectionString,
            DB_SSL_MODE: "disable", ENABLE_RUNTIME_MIGRATIONS: "1", ADSECUTE_EPHEMERAL_DB_SEAM: "1" } });
        const exit = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
        assert(exit === 0, `actual full-DDL migration EXIT${exit}`);
        await db.connect(); connected = true;
        const blocker = new Client({ connectionString, connectionTimeoutMillis: 2000, statement_timeout: 2000 });
        await blocker.connect();
        try {
          await blocker.query("BEGIN; LOCK TABLE engine_v3_ad_decision_evaluations IN ACCESS SHARE MODE");
          await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='7500ms'");
          try {
            await db.query(NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITER_SCHEMA_SQL);
            assert((await db.query("SELECT current_setting('lock_timeout') AS bound")).rows[0].bound === "5s", "R2 repeat changed caller lock bound");
            await db.query("ROLLBACK");
          } catch (error) { await db.query("ROLLBACK"); throw error; }
        } finally { await blocker.query("ROLLBACK"); await blocker.end(); }

        await db.query("INSERT INTO users(id,name,email,password_hash) VALUES ($1,'Owned campaign writer',$2,'fixture-only')", [user, `${user}@example.invalid`]);
        await db.query("INSERT INTO businesses(id,name,owner_id) VALUES ($1,'Owned campaign writer',$2)", [business, user]);
        await db.query("INSERT INTO provider_accounts(id,provider,external_account_id) VALUES ($1,'meta',$2)", [accountRef, account]);
        await db.query("INSERT INTO business_provider_accounts(business_id,provider,provider_account_ref_id,provider_account_id,is_selected) VALUES ($1,'meta',$2,$3,true)", [business, accountRef, account]);
        await db.query("INSERT INTO engine_v3_job_runs(id,business_ref_id,business_id,as_of_date,engine_version,job_name,status,row_count) VALUES ($1::uuid,$2::uuid,($2::uuid)::text,$3,$4,'owned-campaign-writer','success',501)", [job, business, asOf, NATIVE_AD_ENGINE_VERSION]);
        const adapter = { query: async (sql: string, values?: unknown[]) => (await db.query(sql, values)).rows } as DbClient;
        const sizes = async () => (await db.query(`SELECT relation, pg_relation_size(relation::regclass)::text AS heap_bytes,
          pg_indexes_size(relation::regclass)::text AS index_bytes, pg_total_relation_size(relation::regclass)::text AS total_bytes
          FROM unnest($1::text[]) AS relation ORDER BY relation`, [[...TABLES]])).rows;
        const before = await sizes(), walStart = (await db.query("SELECT pg_current_wal_insert_lsn()::text AS value")).rows[0].value;
        process.env[FLAG] = reference ? "true" : "false";
        await db.query("BEGIN; SET LOCAL statement_timeout='7500ms'; SET LOCAL lock_timeout='500ms'");
        try {
          const stored = await persistAdDecisionEvaluations(input, adapter);
          assert(stored.size === 501, "actual producer lost a batch member");
          await db.query("COMMIT");
        } catch (error) { await db.query("ROLLBACK"); throw error; }
        const walEnd = (await db.query("SELECT pg_current_wal_insert_lsn()::text AS value")).rows[0].value;
        const walBytes = (await db.query("SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::text AS bytes", [walEnd, walStart])).rows[0].bytes;
        const after = await sizes();
        const counts = (await db.query(`SELECT count(*)::int AS evaluations,
          count(*) FILTER (WHERE campaign_context_json IS NULL AND campaign_context_ref IS NOT NULL)::int AS references,
          (SELECT count(*)::int FROM engine_v3_ad_campaign_context_objects) AS objects
          FROM engine_v3_ad_decision_evaluations WHERE job_run_id=$1`, [job])).rows[0];
        assert(counts.evaluations === 501 && counts.references === (reference ? 501 : 0) && counts.objects === (reference ? 4 : 0), "storage representation/count mismatch");
        const rows = (await db.query(`SELECT evaluation.decision_entity_id, evaluation.input_hash::text AS input_hash,
          evaluation.decision_hash::text AS decision_hash,
          ((to_jsonb(evaluation)-'id'-'context_id'-'created_at'-'campaign_context_ref'-'campaign_context_json') ||
            jsonb_build_object('campaign_context_json',${nativeCampaignContextSql("evaluation")}))::text AS original_bytes,
          context.context_json::text AS context_bytes
          FROM engine_v3_ad_decision_evaluations evaluation
          JOIN engine_v3_ad_decision_evaluation_contexts context ON context.id=evaluation.context_id
          WHERE evaluation.job_run_id=$1 ORDER BY evaluation.decision_entity_id`, [job])).rows;
        assert(rows.length === 501);
        const expected = new Map(evaluations.map(value => [value.identity.adId, value]));
        for (const row of rows) {
          const original = expected.get(row.decision_entity_id);
          assert(original && row.input_hash === original.inputHash && row.decision_hash === original.decisionHash, "original canonical hashes changed");
          assert.deepEqual(JSON.parse(row.context_bytes), original.contextPayload, "original canonical context changed");
        }
        materialized.push(rows.map(row => row.original_bytes + "\n" + row.context_bytes));
        assert(JSON.stringify(input) === originalInputBytes, "producer changed original input");
        const readOriginalEvaluations = async () => (await db.query(`SELECT evaluation.id::text,
          to_jsonb(evaluation)::text AS original_bytes FROM engine_v3_ad_decision_evaluations evaluation
          WHERE job_run_id=$1 ORDER BY evaluation.id`, [job])).rows;
        const originalsBeforeRepeat = await readOriginalEvaluations();
        if (!reference) {
          // Switching the writer for an already existing original must not
          // convert that immutable inline generation or change its identity.
          process.env[FLAG] = "true";
          await db.query("BEGIN; SET LOCAL statement_timeout='7500ms'");
          try { assert((await persistAdDecisionEvaluations(input, adapter)).size === 501); await db.query("COMMIT"); }
          catch (error) { await db.query("ROLLBACK"); throw error; }
          assert.deepEqual(await readOriginalEvaluations(), originalsBeforeRepeat,
            "opt-in rewrote existing original inline evaluations");
          process.env[FLAG] = "false";
        }
        if (reference) {
          const beforeRepeat = (await db.query("SELECT payload_sha256,payload_json::text,created_at::text FROM engine_v3_ad_campaign_context_objects ORDER BY payload_sha256")).rows;
          await db.query("BEGIN; SET LOCAL statement_timeout='7500ms'");
          try { assert((await persistAdDecisionEvaluations(input, adapter)).size === 501); await db.query("COMMIT"); }
          catch (error) { await db.query("ROLLBACK"); throw error; }
          assert.deepEqual((await db.query("SELECT payload_sha256,payload_json::text,created_at::text FROM engine_v3_ad_campaign_context_objects ORDER BY payload_sha256")).rows, beforeRepeat, "repeat mutated immutable originals");
          assert((await db.query("SELECT count(*)::int AS n FROM engine_v3_ad_decision_evaluations")).rows[0].n === 501, "repeat duplicated evaluations");
          assert.deepEqual(await readOriginalEvaluations(), originalsBeforeRepeat,
            "repeat changed original referenced evaluation IDs, payload or clocks");
          const faultValue = buildAdCanonicalEvaluationProvenance({ base: buildCanonicalEvaluationProvenance({
            engineVersion: NATIVE_AD_ENGINE_VERSION, accountProfile: profile, dataHealth: makeDataHealth(), scope: profile.scope,
            creativeInput: makeCreativeInput({ businessId: business, creativeId: "rollback_creative", campaignId: "rollback_campaign" }),
            flags: { businessId: business, enabled: true, surfaceVisible: false, shadowOnly: true, presetOverride: null,
              source: { enabled: "env", surfaceVisible: "env", shadowOnly: "env", presetOverride: null }, envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: true } },
            campaignContext: { mode: "automatic", source: "system_inferred", campaignId: "rollback_campaign", kind: null, testDimension: null, contextTrust: null },
            decision: { ...JSON.parse(evaluations[0].decisionJson).decision, creativeId: "rollback_creative" }, rawLabel: "keep", publishedLabel: "keep", hysteresisSuppressed: false, evaluatedAt: CLOCK }),
            identity: { decisionEntityType: "ad", decisionEntityId: "rollback_ad", adId: "rollback_ad", creativeId: "rollback_creative", providerAccountRefId: accountRef, providerAccountId: account },
            adEvidence: { customConversionId: null, configAuthority: EMPTY_HYDRATED_CONFIG_AUTHORITY } });
          const beforeFault = (await db.query(`SELECT (SELECT count(*) FROM engine_v3_ad_decision_evaluation_contexts)::text AS contexts,
            (SELECT count(*) FROM engine_v3_ad_decision_input_evidence)::text AS evidence,
            (SELECT count(*) FROM engine_v3_ad_campaign_context_objects)::text AS objects,
            (SELECT count(*) FROM engine_v3_ad_decision_evaluations)::text AS evaluations`)).rows[0];
          const faultAdapter = { query: async (sql: string, values?: unknown[]) => {
            const actual = await adapter.query(sql, values);
            return sql === READ_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY ? actual.map(row => ({ ...row, original_payload_matches: false })) : actual;
          } } as DbClient;
          await db.query("BEGIN; SET LOCAL statement_timeout='7500ms'");
          try { await assert.rejects(persistAdDecisionEvaluations({ ...input, evaluations: [faultValue] }, faultAdapter), /identity differs/); }
          finally { await db.query("ROLLBACK"); }
          assert.deepEqual((await db.query(`SELECT (SELECT count(*) FROM engine_v3_ad_decision_evaluation_contexts)::text AS contexts,
            (SELECT count(*) FROM engine_v3_ad_decision_input_evidence)::text AS evidence,
            (SELECT count(*) FROM engine_v3_ad_campaign_context_objects)::text AS objects,
            (SELECT count(*) FROM engine_v3_ad_decision_evaluations)::text AS evaluations`)).rows[0], beforeFault,
          "caller rollback failed to remove new context/evidence/object/evaluation writes");
        }
        results.push({ referenceWriterEnabled: reference, rows: 501, originalInputUnchanged: true, originalHashesMatched: true,
          storageCounts: counts, before, after, observedClusterWalBytes: walBytes,
          clusterWalExclusiveAttribution: false, publicSyntheticFixtureOnly: true, naturalProducerProof: false });
      } finally {
        if (connected) await db.end();
        await parent.query(`DROP DATABASE ${name}`);
      }
    }
    assert.deepEqual(materialized[1], materialized[0], "inline/reference original persisted column bytes or clocks differ");
    console.log(JSON.stringify({ contract: "native-campaign-reference-producer-fixture.v1", rows: 501,
      fullProductionSchemaInstalledBothLanes: true, actualProducerInvoked: true,
      originalPersistedColumnsAndContextByteParity: true, generatedStorageIdsExcludedFromComparison: ["id", "context_id", "created_at"],
      materializedSha256: createHash("sha256").update(JSON.stringify(materialized[0])).digest("hex"),
      repeatedObjectsAndEvaluationIdsRetained: true, callerRollbackFaultPassed: true, results,
      optInDoesNotRewriteExistingInlineGenerations: true,
      measuredProductionSaving: false, providerAuthority: false, reclaimEligible: false }));
  } finally {
    if (previousFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = previousFlag;
  }
}
