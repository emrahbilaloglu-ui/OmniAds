import { NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITER_SCHEMA_SQL } from "@/lib/creative-decision-engine/native-campaign-context-writer";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import type { DbClient } from "@/lib/db";
import { canonicalSha256 } from "@/lib/creative-decision-engine/canonical-evaluation";
import { INSERT_AD_DECISION_EVALUATIONS_QUERY, inspectEvaluationStoreSchemaCapability } from "@/lib/creative-decision-engine/evaluation-store";
import { assertInlineCampaignContextArchiveRow, inspectNativeCampaignContextImmutability,
  nativeCampaignContextSql, requireNativeCampaignContext,
  NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION,
} from "@/lib/creative-decision-engine/native-campaign-context-storage";

/** Called only by the existing owned, fully migrated native archive seam. All
 * future-writer rows, ALTER and fault injections roll back; no live DB access. */
export async function verifyNativeCampaignContextStorage(db: Client, baseEvaluationId: string) {
  const cp = (db as Client & { connectionParameters: { database: string; host: string; port: number } }).connectionParameters;
  if (cp.database !== "native_archive_schema_seam" || cp.host !== "127.0.0.1" || [5432, 15432].includes(cp.port)) {
    throw new Error("Campaign storage seam requires its owned migration fixture");
  }
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Campaign storage seam: ${message}`); };
  const adapter = { query: async (sql: string, values?: unknown[]) => (await db.query(sql, values)).rows } as DbClient;
  // The owned full-migration fixture starts with R1 installed. Restore only the
  // old inline column shape, then exercise the actual first ADD path on data.
  // No other table/constraint is removed; this database is deleted by its owner.
  await db.query("ALTER TABLE engine_v3_ad_decision_evaluations ALTER COLUMN campaign_context_json SET NOT NULL");
  await db.query("ALTER TABLE engine_v3_ad_decision_evaluations DROP COLUMN campaign_context_ref");
  const beforeUpgrade = (await db.query("SELECT to_jsonb(e)::text AS bytes FROM engine_v3_ad_decision_evaluations e WHERE id=$1::uuid", [baseEvaluationId])).rows[0];
  check(beforeUpgrade, "pre-upgrade fixture absent");
  const fileBeforeUpgrade = (await db.query("SELECT pg_relation_filenode('engine_v3_ad_decision_evaluations') AS file")).rows[0].file;
  await db.query("BEGIN");
  await db.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='7500ms'");
  const fails = async (sql: string, values: unknown[], code: string, constraint?: string) => {
    await db.query("SAVEPOINT campaign_storage_fault");
    let observed: string | undefined, named: string | undefined;
    try { await db.query(sql, values); } catch (e) { ({ code: observed, constraint: named } = e as { code?: string; constraint?: string }); }
    finally { await db.query("ROLLBACK TO SAVEPOINT campaign_storage_fault; RELEASE SAVEPOINT campaign_storage_fault"); }
    check(observed === code && (!constraint || named === constraint), `${code}/${constraint ?? ""} refused (${observed}/${named})`);
  };
  try {
    const blocker = new Client({ host: cp.host, port: cp.port, database: cp.database, user: "postgres",
      connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 3000 });
    await blocker.connect();
    try {
      await blocker.query("BEGIN; LOCK TABLE engine_v3_ad_decision_evaluations IN ACCESS SHARE MODE");
      await db.query("SET LOCAL lock_timeout='5s'");
      const started = Date.now();
      await fails(NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL, [], "55P03");
      console.log(`[native-campaign-context-storage] bounded hot-table lock refusal 55P03, observed ${Date.now()-started}ms (sample, not latency SLA)`);
      check((await db.query("SELECT current_setting('lock_timeout') AS bound")).rows[0].bound === "5s",
        "failed own savepoint did not restore caller's lock bound");
    } finally {
      await blocker.query("ROLLBACK"); await blocker.end();
    }
    await db.query(NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL);
    check((await db.query("SELECT current_setting('lock_timeout') AS bound")).rows[0].bound === "5s",
      "successful hot-table DDL did not restore caller's lock bound");
    check((await db.query("SELECT pg_relation_filenode('engine_v3_ad_decision_evaluations') AS file")).rows[0].file === fileBeforeUpgrade,
      "first addition rewrote evaluation heap");
    check((await db.query("SELECT (to_jsonb(e)-'campaign_context_ref')::text AS bytes,campaign_context_ref FROM engine_v3_ad_decision_evaluations e WHERE id=$1::uuid", [baseEvaluationId])).rows[0].bytes === beforeUpgrade.bytes,
      "first addition changed any pre-existing column bytes/clocks");
    const constraints = (await db.query(`SELECT convalidated FROM pg_constraint WHERE
      conrelid='engine_v3_ad_decision_evaluations'::regclass AND conname=ANY($1::text[])`,
      [["engine_v3_ad_evaluations_campaign_storage_check", "engine_v3_ad_evaluations_campaign_object_fk"]])).rows;
    check(constraints.length === 2 && constraints.every(r => r.convalidated === false), "first addition scanned/validated old rows");
    const ready = await inspectEvaluationStoreSchemaCapability(adapter);
    check(ready.ready, `R1 capability after first addition: ${ready.missing.join(',')}`);
    check(createHash("sha256").update(INSERT_AD_DECISION_EVALUATIONS_QUERY).digest("hex") ===
      "2c52bbfd5f2c4c191d81c375c4db2e67483a5567024931ac394b6c30a1f04314",
      "inline INSERT no longer equals the actual a89 writer query");
    const old = JSON.parse(beforeUpgrade.bytes), oldAd = `old_inline_${randomUUID()}`;
    const oldInsert = (await db.query(INSERT_AD_DECISION_EVALUATIONS_QUERY,
      [JSON.stringify([{ ...old, ad_id: oldAd, decision_entity_id: oldAd }])])).rows;
    check(oldInsert.length === 1, "actual unchanged a89 inline writer refused after upgrade");
    const oldStored = (await db.query("SELECT campaign_context_json,campaign_context_ref FROM engine_v3_ad_decision_evaluations WHERE id=$1::uuid", [oldInsert[0].id])).rows[0];
    check(oldStored?.campaign_context_json && oldStored.campaign_context_ref === null, "old inline writer did not retain inline/NULL ref");
    await db.query("DELETE FROM engine_v3_ad_decision_evaluations WHERE id=$1::uuid", [oldInsert[0].id]);
    // Commit only the owned fixture's schema upgrade, releasing its initial
    // ACCESS EXCLUSIVE. Future writer and fault rows below still all roll back.
    await db.query("COMMIT; BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='7500ms'");
    const original = (await db.query("SELECT to_jsonb(e) AS row,to_jsonb(e)::text AS bytes FROM engine_v3_ad_decision_evaluations e WHERE id=$1::uuid", [baseEvaluationId])).rows[0];
    const repeatBlocker = new Client({ host: cp.host, port: cp.port, database: cp.database, user: "postgres",
      connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 3000 });
    await repeatBlocker.connect();
    try {
      await repeatBlocker.query("BEGIN; LOCK TABLE engine_v3_ad_decision_evaluations IN ACCESS SHARE MODE");
      // Exact former no-op ALTER shape is RED while this read lock is held.
      await fails("SET LOCAL lock_timeout='500ms'; ALTER TABLE engine_v3_ad_decision_evaluations ADD COLUMN IF NOT EXISTS campaign_context_ref BYTEA", [], "55P03");
      await fails(NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITER_SCHEMA_SQL, [], "55P03");
      await db.query(NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL);
      check((await db.query("SELECT current_setting('lock_timeout') AS bound")).rows[0].bound === "5s", "repeat did not restore caller bound");
      check((await db.query("SELECT pg_relation_filenode('engine_v3_ad_decision_evaluations') AS file")).rows[0].file === fileBeforeUpgrade,
        "metadata-only repeat rewrote evaluation heap");
      check((await db.query("SELECT to_jsonb(e)::text AS bytes FROM engine_v3_ad_decision_evaluations e WHERE id=$1::uuid", [baseEvaluationId])).rows[0].bytes === original.bytes,
        "repeat changed full existing row bytes/clocks");
    } finally { await repeatBlocker.query("ROLLBACK"); await repeatBlocker.end(); }
    check(await inspectNativeCampaignContextImmutability(adapter), "real immutable trigger metadata");
    const context = '{"campaignId":"fixture_campaign","sourceUpdatedAt":"2026-09-24T07:00:00.000001Z","amount":1.00,"unicode":"İstanbul"}';
    const insertObject = `INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id,payload_sha256,storage_encoding_version,payload_json,byte_length)
      VALUES ($1::uuid,sha256(convert_to(($2::jsonb)::text,'UTF8')),$3,$2::jsonb,octet_length(convert_to(($2::jsonb)::text,'UTF8')))
      RETURNING encode(payload_sha256,'hex') AS hash,payload_json::text AS bytes`;
    const object = (await db.query(insertObject, [original.row.business_ref_id, context, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION])).rows[0];
    const insertEvaluation = `INSERT INTO engine_v3_ad_decision_evaluations
      SELECT (jsonb_populate_record(NULL::engine_v3_ad_decision_evaluations,$1::jsonb)).*`;
    const make = (inline: unknown, reference: unknown) => {
      const id = randomUUID(), ad = `campaign_storage_${id}`;
      return { ...original.row, id, ad_id: ad, decision_entity_id: ad,
        campaign_context_json: inline, campaign_context_ref: reference };
    };
    const reference = `\\x${object.hash}`;
    await fails(insertEvaluation, [JSON.stringify(make(null, reference))], "23502");
    // Only this owned transaction simulates R2. R1 production keeps NOT NULL.
    await db.query(NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITER_SCHEMA_SQL);
    const inline = make(JSON.parse(context), null), referred = make(null, reference);
    await db.query(insertEvaluation, [JSON.stringify(inline)]);
    // Preserve PG's numeric display scale; JS parsing is for canonical hashing only.
    await db.query("UPDATE engine_v3_ad_decision_evaluations SET campaign_context_json=$2::jsonb WHERE id=$1::uuid", [inline.id, context]);
    await db.query(insertEvaluation, [JSON.stringify(referred)]);
    const materialized = (await db.query(`SELECT id::text,${nativeCampaignContextSql("evaluation")}::text AS campaign_bytes,
      creative_input_json,prior_hysteresis_json,decision_output_json,input_hash::text,decision_hash::text,evaluated_at::text
      FROM engine_v3_ad_decision_evaluations evaluation WHERE id=ANY($1::uuid[]) ORDER BY id`, [[inline.id, referred.id]])).rows;
    check(materialized.length === 2 && materialized.every(r => r.campaign_bytes === object.bytes), "inline/reference original JSONB byte parity");
    const hashes = materialized.map(r => canonicalSha256({ creativeInput: r.creative_input_json,
      campaignContext: requireNativeCampaignContext(JSON.parse(r.campaign_bytes)), priorHysteresis: r.prior_hysteresis_json,
      decisionOutput: r.decision_output_json, inputHash: r.input_hash, decisionHash: r.decision_hash, evaluatedAt: r.evaluated_at }));
    check(hashes[0] === hashes[1], "materialized canonical payload/hash/clock parity");
    await fails(insertEvaluation, [JSON.stringify(make(null, null))], "23514", "engine_v3_ad_evaluations_campaign_storage_check");
    await fails(insertEvaluation, [JSON.stringify(make(JSON.parse(context), reference))], "23514", "engine_v3_ad_evaluations_campaign_storage_check");
    await fails(insertEvaluation, [JSON.stringify(make(null, `\\x${"ab".repeat(32)}`))], "23503", "engine_v3_ad_evaluations_campaign_object_fk");
    const foreignBusiness = randomUUID();
    await db.query("INSERT INTO businesses(id,name,owner_id) SELECT $1::uuid,'Owned foreign-tenant fixture',owner_id FROM businesses WHERE id=$2::uuid", [foreignBusiness, original.row.business_ref_id]);
    const foreign = (await db.query(insertObject, [foreignBusiness, '{"campaignId":"foreign"}', NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION])).rows[0];
    await fails(insertEvaluation, [JSON.stringify(make(null, `\\x${foreign.hash}`))], "23503", "engine_v3_ad_evaluations_campaign_object_fk");
    await fails("UPDATE engine_v3_ad_campaign_context_objects SET payload_json='{}' WHERE business_ref_id=$1::uuid", [original.row.business_ref_id], "23514");
    await fails("DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1::uuid", [original.row.business_ref_id], "23514");
    await fails(`INSERT INTO engine_v3_ad_campaign_context_objects VALUES
      ($1::uuid,decode(repeat('00',32),'hex'),$2,'{}',2,now())`, [original.row.business_ref_id, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION], "23514", "engine_v3_ad_campaign_objects_digest_check");
    await fails(insertObject, [original.row.business_ref_id, '{"campaignId":"bad-version"}', "unknown.v9"], "23514", "engine_v3_ad_campaign_objects_version_check");
    await fails(`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id,payload_sha256,storage_encoding_version,payload_json,byte_length)
      VALUES ($1::uuid,sha256(convert_to('{}'::jsonb::text,'UTF8')),$2,'{}',3)`,
      [original.row.business_ref_id,NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION], "23514", "engine_v3_ad_campaign_objects_payload_check");
    assertInlineCampaignContextArchiveRow(inline);
    let rejectedArchive = false;
    try { assertInlineCampaignContextArchiveRow(referred); } catch { rejectedArchive = true; }
    check(rejectedArchive, "legacy archive silently lost referenced object root");
    await db.query("ALTER TABLE engine_v3_ad_campaign_context_objects DISABLE TRIGGER engine_v3_ad_campaign_objects_immutable");
    check(!await inspectNativeCampaignContextImmutability(adapter), "disabled mutation guard accepted");
    await db.query("ALTER TABLE engine_v3_ad_campaign_context_objects ENABLE TRIGGER engine_v3_ad_campaign_objects_immutable");
    check(await inspectNativeCampaignContextImmutability(adapter), "restored guard did not validate");
    console.log("[native-campaign-context-storage] PASS first-add old-column bytes/clock+filenode parity, NOT VALID guards, actual unchanged a89 inline INSERT and R1 capability; former repeat ALTER RED55P03/new repeat GREEN under competing ACCESS SHARE; future inline/reference original JSONB/numeric/microsecond/Unicode+hash parity; XOR/missing-object/wrong-tenant FK/digest/version/length/immutable/disabled-trigger refusals. Not an executed a89 capability or full old-schema install. R1 writer remains inline, storage saved/reclaimed=0; future writer rows and ALTER roll back.");
  } finally { await db.query("ROLLBACK"); }
}
