import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db";
import { READ_AD_DECISION_INPUT_EVIDENCE_QUERY } from "../../evaluation-store";
import { readCompletedCreativeProducerScopes } from "../../jobs/creative-producer-completion";

const originalEvidence = "\nWITH payload AS (\n  SELECT *\n  FROM jsonb_to_recordset($1::jsonb) AS row(\n    contract_version text,\n    input_hash text,\n    input_evidence_json jsonb\n  )\n)\nSELECT\n  payload.contract_version,\n  payload.input_hash,\n  COALESCE(\n    stored.input_evidence_json = payload.input_evidence_json,\n    FALSE\n  ) AS evidence_matches\nFROM payload\nLEFT JOIN engine_v3_ad_decision_input_evidence stored\n  ON stored.contract_version = payload.contract_version\n AND stored.input_hash = payload.input_hash\nORDER BY payload.contract_version, payload.input_hash\n";
const originalCompletion = "\n    WITH requested AS (\n      SELECT business_id, as_of_date\n      FROM unnest($2::text[], $3::date[]) AS scope(business_id, as_of_date)\n    ), completed AS (\n      SELECT\n        runs.business_ref_id, runs.as_of_date,\n        bool_or(job_name = 'engine_v3_calibration_job' AND status = 'success') AS calibration_success,\n        bool_or(job_name = 'engine_v3_lifecycle_job' AND status = 'success') AS lifecycle_success,\n        bool_or(job_name = $1 AND status = 'success') AS decisions_success\n      FROM engine_v3_job_runs runs\n      JOIN requested ON requested.business_id::uuid = runs.business_ref_id\n        AND requested.as_of_date = runs.as_of_date\n      WHERE job_name IN (\n          'engine_v3_calibration_job',\n          'engine_v3_lifecycle_job',\n          $1\n        )\n        AND engine_version = $4\n      GROUP BY runs.business_ref_id, runs.as_of_date\n    ), latest_decision AS (\n      SELECT DISTINCT ON (runs.business_ref_id, runs.as_of_date)\n        runs.business_ref_id, runs.as_of_date,\n        CASE WHEN\n          runs.error_json#>>'{metadata,evaluation_cutoff_at}' ~\n            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$'\n          AND pg_input_is_valid(runs.error_json#>>'{metadata,evaluation_cutoff_at}', 'timestamptz')\n          THEN (runs.error_json#>>'{metadata,evaluation_cutoff_at}')::timestamptz\n          ELSE NULL\n        END AS evaluation_cutoff_at\n      FROM engine_v3_job_runs runs\n      JOIN requested ON requested.business_id::uuid = runs.business_ref_id\n        AND requested.as_of_date = runs.as_of_date\n      WHERE runs.job_name = $1 AND runs.status = 'success' AND runs.engine_version = $4\n      ORDER BY runs.business_ref_id, runs.as_of_date, runs.finished_at DESC NULLS LAST, runs.id DESC\n    )\n    SELECT completed.business_ref_id, completed.as_of_date::text\n    FROM completed\n    JOIN latest_decision ON latest_decision.business_ref_id = completed.business_ref_id\n      AND latest_decision.as_of_date = completed.as_of_date\n    WHERE calibration_success = TRUE\n      AND lifecycle_success = TRUE\n      AND decisions_success = TRUE\n      AND latest_decision.evaluation_cutoff_at IS NOT NULL\n      AND NOT EXISTS (\n        SELECT 1 FROM meta_creative_daily creative\n        WHERE creative.business_ref_id = completed.business_ref_id\n          AND creative.date BETWEEN (completed.as_of_date - INTERVAL '89 days')\n            AND completed.as_of_date\n          AND creative.payload_json->>'historical_config_provenance' IN\n            ('provider_receipt_day_bracketed', 'provider_receipt_legacy_bracketed')\n          AND CASE WHEN\n            creative.payload_json#>>'{historical_config_proof,certified_at}' ~\n              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$'\n            AND pg_input_is_valid(creative.payload_json#>>'{historical_config_proof,certified_at}', 'timestamptz')\n            THEN (creative.payload_json#>>'{historical_config_proof,certified_at}')::timestamptz\n              > latest_decision.evaluation_cutoff_at\n            ELSE FALSE END\n      )\n      AND NOT EXISTS (\n        SELECT 1 FROM meta_creative_daily creative\n        WHERE creative.business_ref_id = completed.business_ref_id\n          AND creative.date BETWEEN (completed.as_of_date - INTERVAL '89 days')\n            AND completed.as_of_date\n          -- The writer stamps this only when a previously certified creative\n          -- day loses authority. Ordinary same-content upserts advance\n          -- updated_at, so that clock would rerun the chain on every sync.\n          AND CASE WHEN\n            creative.payload_json->>'historical_config_authority_changed_at' ~\n              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$'\n            AND pg_input_is_valid(\n              creative.payload_json->>'historical_config_authority_changed_at',\n              'timestamptz')\n            THEN (creative.payload_json->>'historical_config_authority_changed_at')::timestamptz\n              > latest_decision.evaluation_cutoff_at\n            ELSE FALSE END\n      )\n      AND NOT EXISTS (\n        SELECT 1 FROM meta_authoritative_publication_pointers pointer\n        WHERE pointer.business_id = completed.business_ref_id::text\n          AND pointer.day BETWEEN (completed.as_of_date - INTERVAL '89 days')\n            AND completed.as_of_date\n          AND pointer.surface = 'ad_daily'\n          AND pointer.updated_at > latest_decision.evaluation_cutoff_at\n      )\n    ";
const seam = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const scope = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const day = "2026-09-28", epoch = "query-plan-seam";
const cutoff = "2026-09-28T12:00:00.000Z", later = "2026-09-28T12:00:00.000001Z";
let client: Client, writer: Client;
const schema = `q130_${randomUUID().replaceAll("-", "")}`;
const db = { query: async (sql: string, params?: unknown[]) =>
  (await client.query(sql, params)).rows } as DbClient;
async function jobs(i: number, omit = "", latestCutoff = cutoff) {
  for (const job of ["calibration", "lifecycle", "decisions"]) {
    if (job === omit) continue;
    await client.query(`INSERT INTO engine_v3_job_runs VALUES ($1,$2,$3,$4,$5,'success',$6,$7)`,
      [randomUUID(), scope(i), day, `engine_v3_${job}_job`, epoch,
        "2026-09-28T12:01:00Z", { metadata: { evaluation_cutoff_at: latestCutoff } }]);
  }
}
async function creative(i: number, payload: object, date = day) {
  await client.query(`INSERT INTO meta_creative_daily VALUES($1,'legacy-display-id',$2,$3,now())`,
    [scope(i), date, payload]);
}
async function pointer(i: number, date: string, time: string, surface = "ad_daily") {
  await client.query(`INSERT INTO meta_authoritative_publication_pointers VALUES($1,$2,$3,$4)`,
    [scope(i), date, surface, time]);
}
function planNodes(plan: Record<string, unknown>): Array<Record<string, unknown>> {
  return [plan, ...((plan.Plans ?? []) as Array<Record<string, unknown>>).flatMap(planNodes)];
}

describe.skipIf(!seam)("real SQL completion parity and default planner", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!seam || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.port || ["5432", "15432"].includes(url.port)) throw Error("Ephemeral cluster required");
    client = new Client({ connectionString: url.toString() });
    writer = new Client({ connectionString: url.toString() });
    await client.connect(); await writer.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path=${schema}; SET statement_timeout='8s'; SET jit=DEFAULT`);
    await writer.query(`SET search_path=${schema}`);
    await client.query(`
      CREATE TABLE engine_v3_ad_decision_input_evidence (
        contract_version text,input_hash char(64),input_evidence_json jsonb,
        PRIMARY KEY(contract_version,input_hash));
      CREATE TABLE engine_v3_job_runs(id uuid PRIMARY KEY,business_ref_id uuid,
        as_of_date date,job_name text,engine_version text,status text,
        finished_at timestamptz,error_json jsonb);
      CREATE INDEX ON engine_v3_job_runs(job_name,business_ref_id,as_of_date);
      CREATE TABLE meta_creative_daily(business_ref_id uuid,business_id text,date date,
        payload_json jsonb,updated_at timestamptz);
      CREATE INDEX ON meta_creative_daily(business_ref_id);
      CREATE TABLE meta_authoritative_publication_pointers(business_id text,day date,
        surface text,updated_at timestamptz);
      CREATE INDEX ON meta_authoritative_publication_pointers(business_id,day,surface);
    `);
  });
  beforeEach(async () => { await client.query(`TRUNCATE engine_v3_ad_decision_input_evidence,
    engine_v3_job_runs,meta_creative_daily,meta_authoritative_publication_pointers`); });
  afterAll(async () => {
    await client?.query("ROLLBACK");
    await client?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client?.end(); await writer?.end();
  });

  it("retains exact equality, collision, missing, duplicate and malformed hash behavior", async () => {
    const key = "a".repeat(64), value = { configEvidence: { zero: 0 }, metricContract: null };
    await client.query("INSERT INTO engine_v3_ad_decision_input_evidence VALUES('v1',$1,$2)", [key,value]);
    const batch = [
      { contract_version: "v1", input_hash: key, input_evidence_json: value },
      { contract_version: "v1", input_hash: key, input_evidence_json: value },
      { contract_version: "v1", input_hash: key, input_evidence_json: { zero: null } },
      { contract_version: "v1", input_hash: "b".repeat(64), input_evidence_json: value },
      ...[key+" ", key+"b", key.slice(1), null].map(input_hash =>
        ({ contract_version: "v1", input_hash, input_evidence_json: value })),
      { contract_version: "foreign", input_hash: key, input_evidence_json: value },
    ];
    // Duplicate tie order is unspecified in BOTH statements: compare multisets.
    const normalize = (rows: unknown[]) => rows.map(x => JSON.stringify(x)).sort();
    const reference = (await client.query(originalEvidence,[JSON.stringify(batch)])).rows;
    const candidate = (await client.query(READ_AD_DECISION_INPUT_EVIDENCE_QUERY,[JSON.stringify(batch)])).rows;
    expect(normalize(candidate)).toEqual(normalize(reference));
    expect(candidate.filter(x => x.evidence_matches)).toHaveLength(2);
    expect((await client.query("SELECT input_evidence_json FROM engine_v3_ad_decision_input_evidence")).rows[0]?.input_evidence_json).toEqual(value);
  });

  it("uses both primary-key columns for a real 100-row batch over 25000 unrelated identities", async () => {
    await client.query(`INSERT INTO engine_v3_ad_decision_input_evidence
      SELECT 'v1',lpad(to_hex(n),64,'0'),jsonb_build_object('n',n,'detail',repeat('x',1000))
      FROM generate_series(1,25000) n; ANALYZE engine_v3_ad_decision_input_evidence`);
    const batch = (await client.query(`SELECT * FROM engine_v3_ad_decision_input_evidence
      WHERE contract_version='v1' ORDER BY input_hash LIMIT 100`)).rows;
    const params = [JSON.stringify(batch)];
    const current = (await client.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+READ_AD_DECISION_INPUT_EVIDENCE_QUERY,params)).rows[0]["QUERY PLAN"][0];
    const indexed = planNodes(current.Plan).filter(x => String(x["Index Cond"]).includes("input_hash"));
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.["Actual Loops"]).toBe(100);
    expect((await client.query(READ_AD_DECISION_INPUT_EVIDENCE_QUERY,params)).rows.every(x => x.evidence_matches)).toBe(true);
    const original = (await client.query('EXPLAIN(FORMAT JSON) '+originalEvidence,params)).rows[0]["QUERY PLAN"][0];
    expect(planNodes(original.Plan).some(x => String(x["Index Cond"]).includes("input_hash"))).toBe(false);
  });

  it("matches the original whole-scope query across complete, invalid and late-source cases", async () => {
    const count = 17;
    for (let i=1;i<=count;i++) await jobs(i, i===2 ? "lifecycle" : "", i===3 ? "2026-02-30T12:00:00Z" : cutoff);
    const proof = (time: string) => ({ historical_config_provenance: "provider_receipt_day_bracketed", historical_config_proof: { certified_at: time } });
    await creative(4,proof(later));
    await creative(5,{ historical_config_authority_changed_at: later });
    await creative(6,proof("2026-02-30T12:00:00Z"));
    await creative(7,proof(cutoff));
    await creative(8,proof(later),"2026-07-01"); // inclusive day -89
    await creative(9,proof(later),"2026-06-30"); // outside the full 90 days
    await pointer(10,day,later);
    await pointer(11,day,later,"creative_daily");
    await pointer(12,"2026-06-30",later);
    await creative(13,{ historical_config_provenance: "untrusted", historical_config_proof: { certified_at: later } });
    await creative(14,{ historical_config_provenance: "untrusted", historical_config_authority_changed_at: later });
    await creative(15,{ historical_config_authority_changed_at: "not-an-instant" });
    await client.query(`INSERT INTO engine_v3_job_runs VALUES($1,$2,$3,'engine_v3_decisions_job',$4,'success','2026-09-28T12:02:00Z','{"metadata":{}}')`,[randomUUID(),scope(16),day,epoch]);
    await client.query("UPDATE engine_v3_job_runs SET engine_version='foreign' WHERE business_ref_id=$1 AND job_name='engine_v3_lifecycle_job'",[scope(17)]);
    const businesses = Array.from({length:count},(_,i)=>({ id:scope(i+1),asOf:day }));
    const reference = (await client.query(originalCompletion,["engine_v3_decisions_job",businesses.map(x=>x.id),businesses.map(x=>x.asOf),epoch])).rows;
    const candidate = await readCompletedCreativeProducerScopes(db,[...businesses,businesses[0]!],epoch);
    const sort = (rows: typeof candidate) => rows.map(x=>`${x.business_ref_id}:${x.as_of_date}`).sort();
    expect(sort(candidate)).toEqual(sort(reference));
    expect(candidate.map(x=>x.business_ref_id).sort()).toEqual([1,6,7,9,11,12,13,15].map(scope).sort());
  });

  it("uses one repeatable-read view when a second backend publishes between scopes", async () => {
    await jobs(1); await jobs(2);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let calls=0;
    const concurrentDb = { query: async (sql: string, params?: unknown[]) => {
      const result = (await client.query(sql,params)).rows;
      if (++calls===1) await writer.query(`INSERT INTO meta_authoritative_publication_pointers VALUES($1,$2,'ad_daily',$3)`,[scope(2),day,later]);
      return result;
    }} as DbClient;
    try {
      expect(await readCompletedCreativeProducerScopes(concurrentDb,[{id:scope(1),asOf:day},{id:scope(2),asOf:day}],epoch)).toHaveLength(2);
    } finally { await client.query("ROLLBACK"); }
    expect(await readCompletedCreativeProducerScopes(db,[{id:scope(1),asOf:day},{id:scope(2),asOf:day}],epoch)).toHaveLength(1);
  });

  it("propagates a later real statement failure instead of returning partial completion", async () => {
    await jobs(1); await jobs(2);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='25ms'");
    let calls=0;
    const failingDb = { query: async (sql: string, params?: unknown[]) => {
      if (++calls===2) await client.query("SELECT pg_sleep(1)");
      return (await client.query(sql,params)).rows;
    }} as DbClient;
    try {
      await expect(readCompletedCreativeProducerScopes(failingDb,[{id:scope(1),asOf:day},{id:scope(2),asOf:day}],epoch)).rejects.toMatchObject({code:"57014"});
    } finally { await client.query("ROLLBACK"); }
  });
});
