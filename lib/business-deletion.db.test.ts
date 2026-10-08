import { randomUUID, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { addObservedProductionReferenceIndex, seedCalibration, seedGeneration, seedTenant } from "../scripts/native-storage-batch/owned-fixture";
import { getDb, runDbTransaction } from "@/lib/db";
import { BusinessDeletionError, deleteBusinessWithData } from "@/lib/business-deletion";
import { deleteBusinessReleaseReceipts, deleteBusinessWorkerHistory } from "@/lib/business-deletion-control-receipts";
import { deleteBusinessNativeEvaluations } from "@/lib/business-deletion-native-evaluations";
import { upsertSyncGateRecord } from "@/lib/sync/release-gates";
import { heartbeatSyncWorker } from "@/lib/sync/worker-health";
import { buildRuntimeContract, upsertRuntimeContractInstance } from "@/lib/sync/runtime-contract";
import { NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION } from "@/lib/creative-decision-engine/ad-operator-response-detection";

// Only the migrated, disposable cluster may execute these destructive fixtures.
const seam = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
if (seam) {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || ["5432", "15432", ""].includes(url.port)) throw new Error("Unsafe deletion test database");
}

async function fixture() {
  const sql = getDb();
  const [user] = await sql`INSERT INTO users (name, email, password_hash)
    VALUES ('Deletion fixture', ${`${randomUUID()}@example.invalid`}, 'fixture') RETURNING id`;
  const ids: string[] = [];
  const [account] = await sql`INSERT INTO provider_accounts (provider, external_account_id)
    VALUES ('meta', ${`act_delete_${randomUUID()}`}) RETURNING id, external_account_id`;
  for (const name of ["Remove this business", "Preserve this business"]) {
    const [business] = await sql`INSERT INTO businesses (name, owner_id) VALUES (${name}, ${user!.id}) RETURNING id`;
    const id = String(business!.id);
    ids.push(id);
    await sql`INSERT INTO memberships (user_id, business_id, role, status) VALUES (${user!.id}, ${id}, 'admin', 'active')`;
    await sql`INSERT INTO business_provider_accounts (business_id, provider, provider_account_ref_id, provider_account_id)
      VALUES (${id}, 'meta', ${account!.id}, ${account!.external_account_id})`;
    const [connection] = await sql`INSERT INTO provider_connections (business_id, provider, status)
      VALUES (${id}, 'meta', 'connected') RETURNING id`;
    await sql`INSERT INTO integration_credentials (provider_connection_id, access_token)
      VALUES (${connection!.id}, 'disposable-fixture')`;
    await sql`INSERT INTO meta_entity_observation_runs (business_ref_id, business_id, provider_account_ref_id,
      provider_account_id, entity_type, endpoint, observed_at, captured_at, completeness, run_hash)
      VALUES (${id}, ${id}, ${account!.id}, ${account!.external_account_id}, 'ad', 'ads', now(), now(), 'complete', ${randomBytes(32).toString("hex")})`;
    await sql`INSERT INTO business_cost_models (business_id) VALUES (${id})`;
  }
  await sql`INSERT INTO sessions (user_id, token_hash, active_business_id, expires_at)
    VALUES (${user!.id}, ${randomUUID()}, ${ids[0]}, now() + interval '1 day')`;
  return { businessId: ids[0]!, otherId: ids[1]!, userId: String(user!.id), accountId: String(account!.id) };
}

async function remains(id: string, table = "businesses", column = "id") {
  return (await getDb().query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [id])).length === 1;
}

// This recovery table is created by an optional normalization tool, so the
// canonical migrations alone cannot reproduce its presence on older databases.
async function normalizationArchive(businessId: string) {
  await getDb()`CREATE TABLE db_normalization_orphan_core_legacy (
    id BIGSERIAL PRIMARY KEY,
    source_table TEXT NOT NULL,
    business_id TEXT,
    provider TEXT,
    payload_hash TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    reason TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_table, payload_hash)
  )`;
  await getDb()`INSERT INTO db_normalization_orphan_core_legacy
    (source_table, business_id, provider, payload_hash, payload_json, reason)
    VALUES ('provider_connections', ${businessId}, 'meta', 'fixture-hash',
      '{"fixture":"recovery-original"}'::jsonb, 'business_missing_during_normalization')`;
  return getDb()`SELECT * FROM db_normalization_orphan_core_legacy ORDER BY id`;
}

describe.skipIf(!seam)("business deletion on the full migrated PostgreSQL schema", () => {
  beforeEach(() => {
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED = "enabled";
  });

  it("reproduces the old teardown's foreign-key failure and proves its rollback", async () => {
    const { businessId } = await fixture();
    await expect(runDbTransaction(async () => {
      await getDb()`DELETE FROM memberships WHERE business_id = ${businessId}`;
      await getDb()`DELETE FROM business_provider_accounts WHERE business_id = ${businessId}`;
    })).rejects.toMatchObject({ code: "23503", constraint: "meta_entity_observation_runs_binding_fk" });
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("deletes provenance children first, credentials and facts, preserving shared accounts and the other tenant", async () => {
    const { businessId, otherId, userId, accountId } = await fixture();
    await deleteBusinessWithData(businessId);
    for (const table of ["memberships", "business_provider_accounts", "provider_connections", "meta_entity_observation_runs", "business_cost_models"]) {
      expect(await remains(businessId, table, "business_id"), table).toBe(false);
      expect(await remains(otherId, table, "business_id"), table).toBe(true);
    }
    expect(await remains(businessId)).toBe(false);
    expect(await remains(otherId)).toBe(true);
    expect(await remains(userId, "users")).toBe(true);
    expect(await remains(accountId, "provider_accounts")).toBe(true);
    const [session] = await getDb()`SELECT active_business_id FROM sessions WHERE user_id = ${userId}`;
    expect(session!.active_business_id).toBeNull();
    const credentials = await getDb()`SELECT credentials.id FROM integration_credentials credentials
      JOIN provider_connections connection ON connection.id = credentials.provider_connection_id
      WHERE connection.business_id = ${otherId}`;
    expect(credentials).toHaveLength(1);
  });

  it("erases protected target evidence and preserves the other tenant and ordinary immutability", async () => {
    const { businessId, otherId } = await fixture();
    for (const id of [businessId, otherId]) await getDb()`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id, payload_sha256, storage_encoding_version, payload_json, byte_length)
      VALUES (${id}, sha256(convert_to('{}'::jsonb::text, 'UTF8')), 'native-campaign-context-jsonb.v1', '{}'::jsonb, 2)`;
    const before = await getDb()`SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=${otherId}`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId)).toBe(false);
    expect(await remains(businessId, "engine_v3_ad_campaign_context_objects", "business_ref_id")).toBe(false);
    expect(await getDb()`SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=${otherId}`).toEqual(before);
    await expect(getDb()`DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id = ${otherId}`).rejects.toThrow();
  });

  it("rejects an unreviewed new ownership table before any destructive query", async () => {
    const { businessId } = await fixture();
    await getDb()`CREATE TABLE business_delete_unknown_fixture (business_id text)`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "schema_not_ready" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
    } finally { await getDb()`DROP TABLE business_delete_unknown_fixture`; }
  });

  it("refuses an unreviewed archive guard before changing access", async () => {
    const { businessId } = await fixture();
    const archiveBefore = await normalizationArchive(randomUUID());
    try {
      await getDb()`CREATE FUNCTION business_delete_archive_fixture_guard() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Recovery archive DELETE is forbidden'; END $$`;
      await getDb()`CREATE TRIGGER business_delete_archive_fixture_guard
        BEFORE DELETE ON db_normalization_orphan_core_legacy FOR EACH STATEMENT
        EXECUTE FUNCTION business_delete_archive_fixture_guard()`;
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "protected_history" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
      expect(await getDb()`SELECT * FROM db_normalization_orphan_core_legacy ORDER BY id`).toEqual(archiveBefore);
    } finally {
      await getDb()`DROP TABLE db_normalization_orphan_core_legacy`;
      await getDb()`DROP FUNCTION IF EXISTS business_delete_archive_fixture_guard()`;
    }
  });

  it("removes only target-owned normalization recovery history", async () => {
    const { businessId, otherId } = await fixture();
    await normalizationArchive(businessId);
    await getDb()`INSERT INTO db_normalization_orphan_core_legacy
      (source_table,business_id,payload_hash,payload_json,reason)
      VALUES ('provider_connections',${otherId},'other-fixture','{"keep":true}'::jsonb,'fixture')`;
    const before = await getDb()`SELECT * FROM db_normalization_orphan_core_legacy WHERE business_id=${otherId}`;
    try {
      await deleteBusinessWithData(businessId);
      expect(await remains(businessId)).toBe(false);
      expect(await remains(businessId, "db_normalization_orphan_core_legacy", "business_id")).toBe(false);
      expect(await getDb()`SELECT * FROM db_normalization_orphan_core_legacy WHERE business_id=${otherId}`).toEqual(before);
    } finally { await getDb()`DROP TABLE db_normalization_orphan_core_legacy`; }
  });

  it("rolls every change back when an unforeseen indirect foreign key refuses deletion", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id,payload_sha256,storage_encoding_version,payload_json,byte_length)
      VALUES (${otherId},sha256(convert_to('{}'::jsonb::text,'UTF8')),'native-campaign-context-jsonb.v1','{}'::jsonb,2)`;
    const guardsBefore = await getDb()`SELECT tgrelid,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgrelid,tgname`;
    await getDb()`CREATE TABLE business_delete_fk_fixture (member_id uuid REFERENCES memberships(id) ON DELETE RESTRICT)`;
    await getDb()`INSERT INTO business_delete_fk_fixture SELECT id FROM memberships WHERE business_id = ${businessId}`;
    try {
      await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "23503" });
      expect(await remains(businessId, "memberships", "business_id")).toBe(true);
      expect(await remains(businessId, "meta_entity_observation_runs", "business_id")).toBe(true);
      expect(await remains(businessId, "provider_connections", "business_id")).toBe(true);
      expect(await getDb()`SELECT tgrelid,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgrelid,tgname`).toEqual(guardsBefore);
      await expect(getDb()`DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=${otherId}`).rejects.toThrow();
    } finally { await getDb()`DROP TABLE business_delete_fk_fixture`; }
  });

  it("does not delete while a provider runner owns a live lease", async () => {
    const { businessId } = await fixture();
    await getDb()`INSERT INTO sync_runner_leases (business_id, provider_scope, lease_owner, lease_expires_at)
      VALUES (${businessId}, 'meta', 'disposable-owner', now() + interval '10 minutes')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "business_busy" });
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("allows data removal under a growth refusal, without changing the growth budget", async () => {
    const { businessId } = await fixture();
    const old = process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES;
    process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES = "1";
    try {
      await deleteBusinessWithData(businessId);
      expect(await remains(businessId)).toBe(false);
      expect(process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES).toBe("1");
    } finally {
      if (old === undefined) delete process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES;
      else process.env.SYNC_GROWTH_FENCE_DATABASE_BYTES = old;
    }
  });

  it("refuses contradictory canonical and text ownership without touching either tenant", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO provider_connections (business_id, business_ref_id, provider)
      VALUES (${businessId}, ${otherId}, 'shopify')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({ code: "scope_conflict" });
    expect(await remains(businessId)).toBe(true);
    expect(await remains(otherId)).toBe(true);
  });

  it("keeps the assignment kill switch authoritative", async () => {
    const { businessId } = await fixture();
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
    await expect(deleteBusinessWithData(businessId)).rejects.toThrow("disabled");
    expect(await remains(businessId, "memberships", "business_id")).toBe(true);
  });

  it("returns not found without attempting a purge for an absent business", async () => {
    await expect(deleteBusinessWithData(randomUUID())).rejects.toBeInstanceOf(BusinessDeletionError);
  });

  it("removes frozen labels as whole-business teardown without reviving the label writer", async () => {
    const { businessId, otherId } = await fixture();
    for (const id of [businessId, otherId]) await getDb()`INSERT INTO meta_campaign_labels (business_id, campaign_id, campaign_kind)
      VALUES (${id}, 'frozen-history', 'main')`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId, "meta_campaign_labels", "business_id")).toBe(false);
    expect(await remains(otherId, "meta_campaign_labels", "business_id")).toBe(true);
  });

  it("blocks competing writers during the suspended-guard transaction and restores the guard on commit", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO engine_v3_ad_campaign_context_objects
      (business_ref_id,payload_sha256,storage_encoding_version,payload_json,byte_length)
      VALUES (${otherId},sha256(convert_to('{}'::jsonb::text,'UTF8')),'native-campaign-context-jsonb.v1','{}'::jsonb,2)`;
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const competitor = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect(); await competitor.connect();
    let deletion: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM memberships WHERE business_id=$1 FOR UPDATE", [businessId]);
      deletion = deleteBusinessWithData(businessId);
      // Consume rejection immediately; the assertions below still observe it.
      void deletion.catch(() => undefined);
      let waiting = false;
      for (let n = 0; n < 80 && !waiting; n++) {
        const r = await competitor.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE 'DELETE FROM%memberships%'");
        waiting = r.rowCount === 1;
        if (!waiting) await new Promise(r => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      const modes = await competitor.query("SELECT tgenabled FROM pg_trigger WHERE tgname='engine_v3_ad_campaign_objects_immutable'");
      expect(modes.rows).toEqual([{ tgenabled: "O" }]);
      await competitor.query("SET lock_timeout='100ms'");
      await expect(competitor.query("DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1", [otherId])).rejects.toMatchObject({ code: "55P03" });
      await blocker.query("COMMIT");
      await deletion;
      await expect(competitor.query("DELETE FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1", [otherId])).rejects.toThrow();
      expect(await remains(businessId)).toBe(false);
    } finally {
      await blocker.query("ROLLBACK");
      if (deletion) await deletion.catch(() => undefined);
      await blocker.end(); await competitor.end();
    }
  });

  it("removes indirect report/audit copies and compact run metadata, preserving other business records", async () => {
    const { businessId, otherId, userId } = await fixture();
    for (const id of [businessId, otherId]) {
      await getDb()`INSERT INTO custom_report_share_snapshots(token,report_id,payload,expires_at)
        VALUES (${randomUUID()},'removed-parent',${JSON.stringify({ businessId:id })}::jsonb,now()+interval '1 day')`;
      await getDb()`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,meta)
        VALUES (${userId},'business.plan_override','business',${id},'{}'::jsonb)`;
    }
    const before = await getDb()`SELECT * FROM custom_report_share_snapshots WHERE payload->>'businessId'=${otherId}`;
    await getDb()`CREATE SCHEMA IF NOT EXISTS adsecute_compact_20260726t0204z`;
    for (const table of ["keep_runs", "run_semantics"]) await getDb().query(`CREATE TABLE adsecute_compact_20260726t0204z.${table} AS SELECT id AS run_id FROM meta_entity_observation_runs WHERE business_id=$1 OR business_id=$2`, [businessId,otherId]);
    try {
      await deleteBusinessWithData(businessId);
      expect(await getDb()`SELECT 1 FROM custom_report_share_snapshots WHERE payload->>'businessId'=${businessId}`).toHaveLength(0);
      expect(await getDb()`SELECT 1 FROM admin_audit_logs WHERE target_id=${businessId}`).toHaveLength(0);
      expect(await getDb()`SELECT * FROM custom_report_share_snapshots WHERE payload->>'businessId'=${otherId}`).toEqual(before);
      for (const table of ["keep_runs", "run_semantics"]) expect(await getDb().query(`SELECT * FROM adsecute_compact_20260726t0204z.${table}`)).toHaveLength(1);
    } finally { await getDb()`DROP SCHEMA adsecute_compact_20260726t0204z CASCADE`; }
  });

  it("collects only globally unreferenced native inputs and deletes protected calibration/context evidence", async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    try {
      const target = await seedTenant(db,1), other = await seedTenant(db,1);
      for (const [tenant,tag] of [[target,"delete"],[other,"preserve"]] as const) {
        const producer = await seedCalibration(db,tenant,"2026-09-23","2026-09-23T12:00:00Z");
        await seedGeneration(db,tenant,{ date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[2],tag });
      }
      const keys = (await db.query("SELECT contract_version,input_hash::text FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY input_hash",[target.business])).rows;
      // Deliberate shared-key fixture proves GLOBAL reference safety; it grants no decision authority.
      await db.query("UPDATE engine_v3_ad_decision_evaluations SET input_hash=$1 WHERE id=(SELECT id FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$2 LIMIT 1)",[keys[0].input_hash,other.business]);
      await expect(deleteBusinessWithData(target.business)).rejects.toMatchObject({ code:"schema_not_ready", tables:["input_evidence_reference_index"] });
      expect(await remains(target.business)).toBe(true);
      await addObservedProductionReferenceIndex(db);
      try {
        const preserved = (await db.query("SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1 ORDER BY payload_sha256",[other.business])).rows;
        await deleteBusinessWithData(target.business);
        for (const table of ["engine_v3_ad_decision_evaluations","engine_v3_ad_campaign_context_objects","engine_v3_ad_account_calibration_batches","engine_v3_ad_account_calibration_daily"]) {
          expect(await remains(target.business,table,"business_ref_id"),table).toBe(false);
          expect(await remains(other.business,table,"business_ref_id"),table).toBe(true);
        }
        expect((await db.query("SELECT * FROM engine_v3_ad_campaign_context_objects WHERE business_ref_id=$1 ORDER BY payload_sha256",[other.business])).rows).toEqual(preserved);
        expect((await db.query("SELECT input_hash::text FROM engine_v3_ad_decision_input_evidence WHERE input_hash=ANY($1::character(64)[])",[keys.map(k=>k.input_hash)])).rows).toEqual([{input_hash:keys[0].input_hash}]);
      } finally { await db.query("DROP INDEX idx_engine_v3_ad_evaluations_contract_input"); }
    } finally { await db.end(); }
  });

  it("walks native history across pages/contexts once, rolls back a partial page limit, and removes every owned input", async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    try {
      const target = await seedTenant(db,1);
      const producer = await seedCalibration(db,target,"2026-09-23","2026-09-23T12:00:00Z");
      for (const [tag,count] of [["large-context",1025],["second-context",3]] as const)
        await seedGeneration(db,target,{ date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[count],tag });
      const before = (await db.query("SELECT id,contract_version,input_hash::text FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY id",[target.business])).rows;
      expect(before).toHaveLength(1028);
      await expect(runDbTransaction(async () => {
        const sql=getDb();
        await sql.query("SET LOCAL enable_seqscan=off");
        await sql.query("CREATE TEMP TABLE business_erasure_input_keys (contract_version text,input_hash character(64),PRIMARY KEY(contract_version,input_hash)) ON COMMIT DROP");
        await deleteBusinessNativeEvaluations(sql,target.business,{maxRows:1024});
      })).rejects.toThrow("native_evaluation_page_limit");
      expect((await db.query("SELECT id,contract_version,input_hash::text FROM engine_v3_ad_decision_evaluations WHERE business_ref_id=$1 ORDER BY id",[target.business])).rows).toEqual(before);
      await addObservedProductionReferenceIndex(db);
      try {
        await deleteBusinessWithData(target.business);
        expect(await remains(target.business)).toBe(false);
        expect(await remains(target.business,"engine_v3_ad_decision_evaluations","business_ref_id")).toBe(false);
        expect((await db.query("SELECT 1 FROM engine_v3_ad_decision_input_evidence WHERE input_hash=ANY($1::character(64)[])",[before.map(r=>r.input_hash)])).rows).toHaveLength(0);
      } finally { await db.query("DROP INDEX idx_engine_v3_ad_evaluations_contract_input"); }
    } finally { await db.end(); }
  },60_000);

  it("cancels a statement at its shorter cap, rolls back, and releases its row lock before the overall deadline", async () => {
    const {businessId}=await fixture();
    const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
    try {
      const original=(await db.query("SELECT name FROM businesses WHERE id=$1",[businessId])).rows[0];
      const started=Date.now();
      await expect(runDbTransaction(async()=>{
        await getDb()`UPDATE businesses SET name='must roll back' WHERE id=${businessId}`;
        await getDb().query("SELECT pg_sleep(5)");
      },{timeoutMs:80,deadlineAtMs:Date.now()+10_000})).rejects.toThrow();
      expect(Date.now()-started).toBeLessThan(3000);
      await db.query("BEGIN");
      expect((await db.query("SELECT name FROM businesses WHERE id=$1 FOR UPDATE NOWAIT",[businessId])).rows[0]).toEqual(original);
      await db.query("ROLLBACK");
    } finally { await db.end(); }
  });

  it("erases original creative-grain evidence with a NULL compatibility owner and preserves the other canonical owner", async () => {
    const { businessId, otherId } = await fixture();
    for (const id of [businessId,otherId]) await getDb()`INSERT INTO engine_v3_decision_events
      (business_ref_id,business_id,creative_id,event_date,event_type)
      VALUES (${id},NULL,'legacy-original','2026-10-01','data_disabled')`;
    const before = await getDb()`SELECT * FROM engine_v3_decision_events WHERE business_ref_id=${otherId}`;
    await deleteBusinessWithData(businessId);
    expect(await remains(businessId,"engine_v3_decision_events","business_ref_id")).toBe(false);
    expect(await getDb()`SELECT * FROM engine_v3_decision_events WHERE business_ref_id=${otherId}`).toEqual(before);
  });

  it("refuses a contradictory compatibility owner in the selected canonical creative history", async () => {
    const { businessId, otherId } = await fixture();
    await getDb()`INSERT INTO engine_v3_decision_events (business_ref_id,business_id,creative_id,event_date,event_type)
      VALUES (${businessId},${otherId},'legacy-conflict','2026-10-01','data_disabled')`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"scope_conflict"});
    expect(await remains(businessId)).toBe(true);
    expect(await remains(otherId)).toBe(true);
  });

  it("removes native operator responses through their validated complete episode ownership, preserving foreign responses", async () => {
    const db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
    try {
      const target = await seedTenant(db,1), other = await seedTenant(db,1);
      for (const [tenant,tag] of [[target,"response-delete"],[other,"response-preserve"]] as const) {
        const producer = await seedCalibration(db,tenant,"2026-09-23","2026-09-23T12:00:00Z");
        const generation = await seedGeneration(db,tenant,{date:"2026-09-23",clock:"2026-09-23T12:01:00Z",finishedAt:"2026-09-23T12:02:00Z",producer,perAccount:[1],tag,snapshots:true});
        const key = randomBytes(32).toString("hex");
        await db.query(`INSERT INTO engine_v3_ad_recommendation_episodes
          (contract_version,episode_key,business_ref_id,business_id,provider_account_ref_id,provider_account_id,
          decision_entity_type,decision_entity_id,ad_id,creative_id,as_of_date,engine_version,scope_type,scope_id,
          decision_snapshot_id,evaluation_id,input_hash,decision_hash,decision_label,recommended_at,captured_at,job_run_id)
          SELECT $1,$2,business_ref_id,business_id,provider_account_ref_id,provider_account_id,
          decision_entity_type,decision_entity_id,ad_id,creative_id,as_of_date,engine_version,scope_type,scope_id,
          id,evaluation_id,input_hash,decision_hash,label,computed_at,computed_at,job_run_id
          FROM engine_v3_ad_decision_snapshots_daily WHERE job_run_id=$3`,[NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,key,generation.jobRunId]);
        await db.query(`INSERT INTO engine_v3_ad_operator_responses
          (contract_version,episode_key,business_ref_id,business_id,provider_account_ref_id,provider_account_id,job_run_id,
          response_cutoff,observation_status,response_type,operator_response_detected,ad_treatment_detected,
          window_start,window_end,window_closed,source_complete,source_set_hash,action_receipt_count,state_observation_count,
          tombstone_observation_count,required_state_target_count,complete_state_target_count,evidence_count,evidence_set_hash,replacement_set_hash,response_hash)
          SELECT contract_version,episode_key,business_ref_id,business_id,provider_account_ref_id,provider_account_id,job_run_id,
          '2026-09-24','unknown_incomplete','unknown_incomplete',false,false,'2026-09-23','2026-09-24',true,false,
          $2,0,0,0,1,0,0,$2,$2,$2 FROM engine_v3_ad_recommendation_episodes WHERE episode_key=$1`,[key,randomBytes(32).toString("hex")]);
      }
      await addObservedProductionReferenceIndex(db);
      try {
        const before = await getDb()`SELECT * FROM engine_v3_ad_operator_responses WHERE business_ref_id=${other.business}`;
        expect(before).toHaveLength(1);
        await deleteBusinessWithData(target.business);
        expect(await remains(target.business,"engine_v3_ad_operator_responses","business_ref_id")).toBe(false);
        expect(await getDb()`SELECT * FROM engine_v3_ad_operator_responses WHERE business_ref_id=${other.business}`).toEqual(before);
      } finally { await db.query("DROP INDEX idx_engine_v3_ad_evaluations_contract_input"); }
    } finally { await db.end(); }
  });

  async function releaseReceipts(businessId: string, otherId: string, year: number) {
    const build = randomUUID();
    await getDb().query(`INSERT INTO sync_release_gates (build_id,environment,gate_kind,gate_scope,mode,base_result,verdict,summary,evidence_json,emitted_at)
      SELECT $1,'fixture','release_gate','release_readiness','measure_only','pass','pass','fixture',
      jsonb_build_object('canaries',jsonb_build_array(jsonb_build_object('businessId',CASE WHEN n IN (1,1025) THEN $2 ELSE $3 END))),
      make_timestamptz($4::int,1,1,0,0,0,'UTC')+n*interval '1 second' FROM generate_series(1,1025) n`,[build,businessId,otherId,year]);
    return build;
  }

  it("erases identifying release receipts across multiple bounded index pages and preserves other receipts byte-for-byte", async () => {
    const { businessId,otherId } = await fixture();
    const build = await releaseReceipts(businessId,otherId,2000);
    const before = await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} AND NOT evidence_json::text LIKE ${`%${businessId}%`} ORDER BY id`;
    try {
      await deleteBusinessWithData(businessId);
      expect(await getDb()`SELECT 1 FROM sync_release_gates WHERE build_id=${build} AND evidence_json::text LIKE ${`%${businessId}%`}`).toHaveLength(0);
      expect(await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} ORDER BY id`).toEqual(before);
    } finally { await getDb()`DELETE FROM sync_release_gates WHERE build_id=${build}`; }
  });

  it("rolls back already erased receipt pages when the complete census exceeds its bound", async () => {
    const { businessId,otherId } = await fixture();
    const build = await releaseReceipts(businessId,otherId,1900);
    const before = await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} ORDER BY id`;
    try {
      await expect(runDbTransaction(async()=>{
        await getDb().query("LOCK TABLE sync_release_gates IN SHARE ROW EXCLUSIVE MODE");
        await getDb().query("SET LOCAL enable_seqscan=off");
        await deleteBusinessReleaseReceipts(getDb(),businessId,{maxRows:1024,maxBytes:1024**3});
      })).rejects.toThrow("release_receipt_census_limit");
      expect(await getDb()`SELECT * FROM sync_release_gates WHERE build_id=${build} ORDER BY id`).toEqual(before);
      expect(await remains(businessId)).toBe(true);
    } finally { await getDb()`DELETE FROM sync_release_gates WHERE build_id=${build}`; }
  });

  it("refuses to persist a stale canary collected before the business was erased", async () => {
    const { businessId } = await fixture();
    await deleteBusinessWithData(businessId);
    await expect(upsertSyncGateRecord({gateKind:"release_gate",gateScope:"release_readiness",buildId:randomUUID(),environment:"fixture",
      mode:"measure_only",baseResult:"pass",verdict:"pass",blockerClass:null,overrideReason:null,summary:"stale canary",breakGlass:false,emittedAt:new Date().toISOString(),
      evidence:{providerScope:"google_ads",canaries:[{businessId}]}})).rejects.toThrow("sync_gate_business_removed");
  });

  it("removes stale worker aliases and JSON-only/runtime copies while preserving foreign observation bytes", async()=>{
    const {businessId,otherId}=await fixture();const sql=getDb();const prefix=randomUUID();
    for (const [suffix,owner,meta] of [["owner",businessId.toUpperCase(),{}],["json",null,{lastConsumedBusinessId:businessId.toUpperCase()}],
      ["foreign",otherId,{currentBusinessId:otherId}]] as const) {
      await sql`INSERT INTO sync_worker_heartbeats(worker_id,instance_type,provider_scope,status,last_heartbeat_at,last_business_id,meta_json)
        VALUES (${prefix+suffix},'fixture','meta','idle',now()-interval '1 hour',${owner},${JSON.stringify(meta)}::jsonb)`;
    }
    const contract=buildRuntimeContract({service:"worker",instanceId:prefix+"runtime"});
    await upsertRuntimeContractInstance({contract:{...contract,config:{...contract.config,releaseCanaryBusinesses:[businessId]}}});
    await sql`UPDATE sync_runtime_instances SET last_seen_at=now()-interval '1 hour' WHERE instance_id=${contract.instanceId}`;
    const foreign=await sql`SELECT * FROM sync_worker_heartbeats WHERE worker_id=${prefix+"foreign"}`;
    await deleteBusinessWithData(businessId);
    expect(await sql`SELECT * FROM sync_worker_heartbeats WHERE worker_id=ANY(${[prefix+"owner",prefix+"json"]}::text[])`).toEqual([]);
    expect(await sql`SELECT * FROM sync_runtime_instances WHERE instance_id=${contract.instanceId}`).toEqual([]);
    expect(await sql`SELECT * FROM sync_worker_heartbeats WHERE worker_id=${prefix+"foreign"}`).toEqual(foreign);
  });

  it("refuses fresh identifying worker presence and rolls the whole business deletion back",async()=>{
    const {businessId}=await fixture();const key=randomUUID();
    await getDb()`INSERT INTO sync_worker_heartbeats(worker_id,instance_type,provider_scope,status,meta_json)
      VALUES(${key},'fixture','meta','running',${JSON.stringify({batchBusinessIds:[businessId]})}::jsonb)`;
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"control_reference_in_use",tables:["sync_worker_heartbeats"]});
    expect(await remains(businessId)).toBe(true);expect(await remains(businessId,"memberships","business_id")).toBe(true);
    expect(await remains(key,"sync_worker_heartbeats","worker_id")).toBe(true);
  });

  it("rolls an earlier worker-history page back when its finite census bound is exceeded",async()=>{
    const {businessId}=await fixture();const prefix="000-"+randomUUID();const sql=getDb();
    await sql`INSERT INTO sync_worker_heartbeats(worker_id,instance_type,provider_scope,status,last_heartbeat_at,last_business_id)
      SELECT ${prefix}||lpad(g::text,5,'0'),'fixture','meta','idle',now()-interval '1 hour',${businessId} FROM generate_series(1,1025) g`;
    const before=await sql`SELECT * FROM sync_worker_heartbeats WHERE last_business_id=${businessId} ORDER BY worker_id`;
    await expect(runDbTransaction(async()=>{
      await getDb().query("LOCK TABLE sync_worker_heartbeats,sync_runtime_instances IN SHARE ROW EXCLUSIVE MODE");
      await getDb().query("SET LOCAL enable_seqscan=off");
      await deleteBusinessWorkerHistory(getDb(),businessId,{maxRows:1024,maxBytes:512*1024**2});
    })).rejects.toThrow("worker_history_census_limit");
    expect(await sql`SELECT * FROM sync_worker_heartbeats WHERE last_business_id=${businessId} ORDER BY worker_id`).toEqual(before);
  });

  it("allows idle presence erasure and makes a real delayed idle heartbeat anonymous without retaining old names or metrics",async()=>{
    const {businessId,otherId}=await fixture();const workerId=randomUUID();
    const heartbeat={workerId,instanceType:"fixture",providerScope:"meta",status:"idle" as const,lastBusinessId:businessId,lastPartitionId:randomUUID(),
      metaJson:{lastConsumedBusinessId:businessId,batchBusinessIds:[otherId,businessId],oldBusinessName:"Sensitive old fixture",oldMetric:123}};
    await heartbeatSyncWorker(heartbeat);
    await deleteBusinessWithData(businessId);
    expect(await remains(workerId,"sync_worker_heartbeats","worker_id")).toBe(false);
    await heartbeatSyncWorker(heartbeat);
    const [row]=await getDb()`SELECT * FROM sync_worker_heartbeats WHERE worker_id=${workerId}`;
    expect(row).toMatchObject({last_business_id:null,last_partition_id:null,meta_json:{businessAdmitted:false,consumeReason:"business_reference_removed"}});
    expect(JSON.stringify(row)).not.toContain(businessId);
    expect(JSON.stringify(row)).not.toContain("Sensitive old fixture");
    expect(row!.meta_json).not.toHaveProperty("oldMetric");
    expect(await remains(otherId)).toBe(true);
  });

  it("refuses a real delayed running heartbeat instead of reviving removed business execution",async()=>{
    const {businessId}=await fixture();await deleteBusinessWithData(businessId);const workerId=randomUUID();
    await expect(heartbeatSyncWorker({workerId,instanceType:"fixture",providerScope:"meta",status:"running",
      metaJson:{currentBusinessId:businessId}})).rejects.toThrow("control_metadata_business_removed");
    expect(await remains(workerId,"sync_worker_heartbeats","worker_id")).toBe(false);
  });

  it("refuses a fresh runtime canary reference with the specific configuration blocker and preserves the business",async()=>{
    const {businessId}=await fixture();const contract=buildRuntimeContract({service:"worker",instanceId:randomUUID()});
    await upsertRuntimeContractInstance({contract:{...contract,config:{...contract.config,releaseCanaryBusinesses:[businessId]}}});
    await expect(deleteBusinessWithData(businessId)).rejects.toMatchObject({code:"control_reference_in_use",tables:["sync_runtime_instances"]});
    expect(await remains(businessId)).toBe(true);
  });

  it("refuses the real delayed runtime writer with a removed canary business",async()=>{
    const {businessId}=await fixture();const contract=buildRuntimeContract({service:"worker",instanceId:randomUUID()});
    await deleteBusinessWithData(businessId);
    await expect(upsertRuntimeContractInstance({contract:{...contract,config:{...contract.config,releaseCanaryBusinesses:[businessId]}}}))
      .rejects.toThrow("control_metadata_business_removed");
    expect(await remains(contract.instanceId,"sync_runtime_instances","instance_id")).toBe(false);
  });
});
