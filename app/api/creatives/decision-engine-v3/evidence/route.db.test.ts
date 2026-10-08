import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nativeCampaignContextSql, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION } from "@/lib/creative-decision-engine/native-campaign-context-storage";

// Never use the repository's production DATABASE_URL outside a disposable seam.
const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

describe.runIf(SEAM)("native evidence route SQL on real PostgreSQL", () => {
  let client: import("pg").Client;
  const business = "00000000-0000-4000-8000-000000000001";
  const ref = "00000000-0000-4000-8000-000000000002";
  const job = "00000000-0000-4000-8000-000000000003";
  const snapshot = "00000000-0000-4000-8000-000000000004";
  const evaluation = "00000000-0000-4000-8000-000000000005";
  const context = "00000000-0000-4000-8000-000000000006";
  const foreign = "00000000-0000-4000-8000-000000000099";
  const args = [business, "act_1", ref, "ad_1", snapshot, evaluation, job, "2026-10-07", "native-current", "a".repeat(64), "b".repeat(64)];
  // Execute the complete deployed query, including its real shared-object
  // expression. This intentionally fails if the route stops using this seam.
  const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const query = route.match(/return getDb\(\)\.query<NativeDecisionEvidenceDbRow>\(\s*`([\s\S]*?)`/u)?.[1]
    .replace('${nativeCampaignContextSql("evaluation")}', nativeCampaignContextSql("evaluation"));
  if (!query || query.includes("${")) throw new Error("Native evidence SQL seam changed");

  beforeAll(async () => {
    const { Client } = await import("pg");
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    // Temporary tables shadow any migrated tables and cannot affect them.
    await client.query(`
      CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily (
        id uuid, evaluation_id uuid, job_run_id uuid, business_ref_id uuid, business_id text,
        provider_account_ref_id uuid, provider_account_id text, ad_id text, creative_id text,
        decision_entity_type text, decision_entity_id text, raw_label text, label text,
        as_of_date date, engine_version text, scope_type text, scope_id text, input_hash text, decision_hash text
      );
      CREATE TEMP TABLE engine_v3_ad_decision_evaluations (
        LIKE engine_v3_ad_decision_snapshots_daily,
        context_id uuid, contract_version text, evaluated_at timestamptz,
        hysteresis_suppressed boolean, creative_input_json jsonb, campaign_context_json jsonb,
        campaign_context_ref bytea, prior_hysteresis_json jsonb, decision_output_json jsonb
      );
      CREATE TEMP TABLE engine_v3_ad_decision_evaluation_contexts (
        id uuid, job_run_id uuid, business_ref_id uuid, business_id text, provider_account_ref_id uuid,
        provider_account_id text, as_of_date date, engine_version text, scope_type text, scope_id text,
        contract_version text, context_hash text, evaluated_at timestamptz, context_json jsonb,
        account_profile_json jsonb, data_health_json jsonb, flags_json jsonb
      );
      CREATE TEMP TABLE engine_v3_ad_decision_input_evidence (contract_version text, input_hash text, input_evidence_json jsonb);
      CREATE TEMP TABLE engine_v3_ad_campaign_context_objects (business_ref_id uuid, payload_sha256 bytea, storage_encoding_version text, payload_json jsonb);
    `);
  });
  beforeEach(async () => {
    await client.query(`TRUNCATE engine_v3_ad_decision_snapshots_daily, engine_v3_ad_decision_evaluations,
      engine_v3_ad_decision_evaluation_contexts, engine_v3_ad_decision_input_evidence, engine_v3_ad_campaign_context_objects`);
    await client.query(`INSERT INTO engine_v3_ad_decision_snapshots_daily VALUES
      ($5::uuid,$6::uuid,$7::uuid,$1::uuid,$1::text,$3::uuid,$2,$4,'creative_1','ad',$4,'cut','keep',$8::date,$9,'account',$2,$10,$11)`, args);
    await client.query(`INSERT INTO engine_v3_ad_decision_evaluations
      SELECT $1::uuid, s.evaluation_id, s.job_run_id, s.business_ref_id, s.business_id, s.provider_account_ref_id,
        s.provider_account_id, s.ad_id, s.creative_id, s.decision_entity_type, s.decision_entity_id,
        s.raw_label, s.label, s.as_of_date, s.engine_version, s.scope_type, s.scope_id, s.input_hash, s.decision_hash,
        $2::uuid,'contract-v1',now(),false,'{"adId":"ad_1"}','{"kind":"main"}',NULL,'{}','{"label":"keep"}'
      FROM engine_v3_ad_decision_snapshots_daily s`, [evaluation, context]);
    await client.query(`INSERT INTO engine_v3_ad_decision_evaluation_contexts
      SELECT $1::uuid, job_run_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        as_of_date,engine_version,scope_type,scope_id,'contract-v1','context-hash',now(),'{}','{}','{}','{}'
      FROM engine_v3_ad_decision_snapshots_daily`, [context]);
    await client.query(`INSERT INTO engine_v3_ad_decision_input_evidence VALUES ('contract-v1',$1,'{"configEvidence":{"fullyVerified":false}}')`, [args[9]]);
  });
  afterAll(async () => { await client?.end(); });

  it("reads exact inline snapshot/evaluation/context and input evidence", async () => {
    const { rows } = await client.query(query!, args);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ snapshot_id: snapshot, evaluation_id: evaluation, context_id: context,
      campaign_context_json: { kind: "main" }, input_evidence_json: { configEvidence: { fullyVerified: false } } });
  });
  it("reads same-tenant reference context; never borrows foreign or absent objects", async () => {
    await client.query(`UPDATE engine_v3_ad_decision_evaluations SET campaign_context_json=NULL,campaign_context_ref=decode('aabb','hex')`);
    await client.query(`INSERT INTO engine_v3_ad_campaign_context_objects VALUES ($1::uuid,decode('aabb','hex'),$2,'{"kind":"main"}')`, [business, NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION]);
    expect((await client.query(query!, args)).rows[0].campaign_context_json).toEqual({ kind: "main" });
    await client.query(`UPDATE engine_v3_ad_campaign_context_objects SET business_ref_id=$1::uuid`, [foreign]);
    expect((await client.query(query!, args)).rows[0].campaign_context_json).toBeNull();
    await client.query(`TRUNCATE engine_v3_ad_campaign_context_objects`);
    expect((await client.query(query!, args)).rows[0].campaign_context_json).toBeNull();
  });
  it("refuses foreign identity, wrong hashes and missing context lineage", async () => {
    for (const [index, value] of [[0, foreign], [1, "act_foreign"], [3, "ad_foreign"], [9, "c".repeat(64)], [10, "d".repeat(64)]] as const) {
      const changed = [...args]; changed[index] = value;
      expect((await client.query(query!, changed)).rows).toEqual([]);
    }
    await client.query(`UPDATE engine_v3_ad_decision_evaluations SET input_hash='wrong'`);
    expect((await client.query(query!, args)).rows).toEqual([]);
    await client.query(`UPDATE engine_v3_ad_decision_evaluations SET input_hash=$1`, [args[9]]);
    await client.query(`DELETE FROM engine_v3_ad_decision_evaluation_contexts`);
    expect((await client.query(query!, args)).rows).toEqual([]);
  });
  it("detects the original UUID/text parameter failure rather than masking it", async () => {
    await expect(client.query(query!.replace("snapshot.business_id = $1::text", "snapshot.business_id = $1"), args))
      .rejects.toMatchObject({ code: "42883" });
  });
});
