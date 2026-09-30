import { Client } from "pg";
import { assessNativeArchivePins, NATIVE_PIN_CLASSES, readNativeArchivePinCensus,
  type NativePinClass } from "@/lib/creative-decision-engine/native-archive-pin-census";
import type { NativeArchiveGeneration } from "@/lib/creative-decision-engine/native-evidence-archive";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`native archive pin seam FAILED: ${message}`);
}
function isolated(client: Client) {
  const p = (client as Client & { connectionParameters: { database: string; host: string; port: number } }).connectionParameters;
  assert(p.database === "native_ad_seam" && p.host === "127.0.0.1" && ![5432,15432].includes(p.port), "unsafe server");
}
function quote(s: string) { assert(/^[a-z_][a-z0-9_]*$/.test(s), "unsafe fixture identifier"); return `"${s}"`; }

/** Missing leaf tables are synthetic PIN fixtures, not production DDL/closure proof. */
export async function prepareNativeArchivePinFixtureLeaves(client: Client, schema: string) {
  isolated(client); const s = quote(schema);
  for (const table of ["engine_v3_ad_decision_outcomes_daily", "engine_v3_ad_recommendation_episodes", "meta_controlled_random_assignments"]) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.${quote(table)}
      (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluation_id UUID NOT NULL REFERENCES ${s}.engine_v3_ad_decision_evaluations(id))`);
  }
  await client.query(`CREATE TABLE IF NOT EXISTS ${s}.engine_v3_ad_decision_events
    (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), job_run_id UUID REFERENCES ${s}.engine_v3_job_runs(id),
      decision_snapshot_id UUID REFERENCES ${s}.engine_v3_ad_decision_snapshots_daily(id))`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${s}.engine_v3_creative_lifecycle_daily
    (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), job_run_id UUID REFERENCES ${s}.engine_v3_job_runs(id))`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${s}.meta_ads_action_log
    (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_evaluation_id UUID, decision_snapshot_id UUID,
      source_evaluation_id UUID, source_snapshot_id UUID)`);
}
function adapter(client: Client) {
  return { query: async (sql: string, values?: unknown[]) => client.query(sql, values) };
}
export async function readSupersededFixturePinCensus(client: Client, generation: NativeArchiveGeneration) {
  isolated(client);
  const census = await readNativeArchivePinCensus(adapter(client), { schema: "public", generation, unmodeledReferences: [] });
  assert(census.unknownReferences.length === 0, `unsupported source fixture references: ${census.unknownReferences.join(",")}`);
  assert(census.counts.find(c => c.pinClass === "snapshots")?.count === "0", "superseded original still serves snapshots");
  console.log(`[native-archive-pin-seam] actual superseded fixture census: ${JSON.stringify({ ...assessNativeArchivePins(census, generation), counts: census.counts })}. Declared fixture inventory only, NOT production reader closure.`);
  return census;
}

/** Independent sensitivity fixtures for every declared pin class. Actual producer
 * bytes/constraints/restore parity are tested by the companion archive seam. */
export async function verifyNativeArchivePinCensusSeam(client: Client) {
  isolated(client); const schema = "native_archive_pin_fixture", s = quote(schema);
  const g = { businessId: "00000000-0000-4000-8000-000000000801",
    jobRunId: "00000000-0000-4000-8000-000000000802", asOfDate: "2026-09-30", engineVersion: "archive-pin-fixture" };
  const evaluation = "00000000-0000-4000-8000-000000000803", context = "00000000-0000-4000-8000-000000000804";
  const otherJob = "00000000-0000-4000-8000-000000000805";
  await client.query(`CREATE SCHEMA ${s}`);
  const read = async (unmodeledReferences: string[] = []) => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      await client.query("SET LOCAL statement_timeout='7500ms'");
      return await readNativeArchivePinCensus(adapter(client), { schema, generation: g, unmodeledReferences });
    } finally { await client.query("ROLLBACK"); }
  };
  try {
    await client.query(`CREATE TABLE ${s}.engine_v3_job_runs (id UUID PRIMARY KEY,business_ref_id UUID,
      business_id TEXT,as_of_date DATE,engine_version TEXT,job_name TEXT,status TEXT,row_count BIGINT,
      finished_at TIMESTAMPTZ,dependency_run_id UUID REFERENCES ${s}.engine_v3_job_runs(id),error_json JSONB);
      CREATE TABLE ${s}.engine_v3_ad_decision_evaluation_contexts (id UUID PRIMARY KEY,job_run_id UUID REFERENCES ${s}.engine_v3_job_runs(id));
      CREATE TABLE ${s}.engine_v3_ad_decision_evaluations (id UUID PRIMARY KEY,context_id UUID REFERENCES ${s}.engine_v3_ad_decision_evaluation_contexts(id),
        job_run_id UUID,contract_version TEXT,input_hash TEXT);
      CREATE TABLE ${s}.engine_v3_ad_decision_input_evidence (contract_version TEXT,input_hash TEXT,PRIMARY KEY(contract_version,input_hash));
      CREATE TABLE ${s}.engine_v3_ad_decision_snapshots_daily (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        evaluation_id UUID REFERENCES ${s}.engine_v3_ad_decision_evaluations(id),job_run_id UUID REFERENCES ${s}.engine_v3_job_runs(id))`);
    await prepareNativeArchivePinFixtureLeaves(client, schema);
    await client.query(`INSERT INTO ${s}.engine_v3_job_runs
      (id,business_ref_id,business_id,as_of_date,engine_version,job_name,status,row_count,finished_at)
      VALUES ($1,$2::uuid,$2::uuid::text,$3,$4,'engine_v3_native_ad_decisions_shadow_job','success',1,now()-interval '1 hour')`,
    [g.jobRunId,g.businessId,g.asOfDate,g.engineVersion]);
    await client.query(`INSERT INTO ${s}.engine_v3_ad_decision_evaluation_contexts VALUES ($1,$2)`, [context,g.jobRunId]);
    await client.query(`INSERT INTO ${s}.engine_v3_ad_decision_evaluations VALUES ($1,$2,$3,'fixture',$4)`, [evaluation,context,g.jobRunId,"a".repeat(64)]);
    assert(assessNativeArchivePins(await read(), g).candidateWithinSupportedScope, "zero-pin isolated fixture was refused");
    const probes: { pinClass: NativePinClass; insert: string; values: unknown[]; cleanup: string }[] = [
      { pinClass: "snapshots", insert: `INSERT INTO ${s}.engine_v3_ad_decision_snapshots_daily (evaluation_id,job_run_id) VALUES ($1,$2)`, values:[evaluation,g.jobRunId], cleanup:`DELETE FROM ${s}.engine_v3_ad_decision_snapshots_daily` },
      ...([['outcomes','engine_v3_ad_decision_outcomes_daily'],['episodes','engine_v3_ad_recommendation_episodes'],['assignments','meta_controlled_random_assignments']] as const).map(([pinClass,table]) =>
        ({ pinClass, insert:`INSERT INTO ${s}.${quote(table)} (evaluation_id) VALUES ($1)`,values:[evaluation],cleanup:`DELETE FROM ${s}.${quote(table)}` })),
      { pinClass:"events",insert:`INSERT INTO ${s}.engine_v3_ad_decision_events (job_run_id) VALUES ($1)`,values:[g.jobRunId],cleanup:`DELETE FROM ${s}.engine_v3_ad_decision_events` },
      { pinClass:"job_dependencies",insert:`INSERT INTO ${s}.engine_v3_job_runs (id,dependency_run_id) VALUES ($1,$2)`,values:[otherJob,g.jobRunId],cleanup:`DELETE FROM ${s}.engine_v3_job_runs WHERE id='${otherJob}'` },
      { pinClass:"reuse_attempts",insert:`INSERT INTO ${s}.engine_v3_job_runs (id,error_json) VALUES ($1,$2::jsonb)`,values:[otherJob,JSON.stringify({metadata:{reused_job_run_id:g.jobRunId}})],cleanup:`DELETE FROM ${s}.engine_v3_job_runs WHERE id='${otherJob}'` },
      { pinClass:"shared_input_evidence",insert:`INSERT INTO ${s}.engine_v3_ad_decision_evaluations (id,job_run_id,contract_version,input_hash) VALUES ($1,$2,'fixture',$3)`,values:[otherJob,otherJob,"a".repeat(64)],cleanup:`DELETE FROM ${s}.engine_v3_ad_decision_evaluations WHERE id='${otherJob}'` },
      { pinClass:"action_lineage",insert:`INSERT INTO ${s}.meta_ads_action_log (decision_evaluation_id) VALUES ($1)`,values:[evaluation],cleanup:`DELETE FROM ${s}.meta_ads_action_log` },
    ];
    for (const probe of probes) {
      await client.query(probe.insert,probe.values);
      try {
        const census = await read(), disposition = assessNativeArchivePins(census,g);
        assert(disposition.reason === "live_pins" && disposition.pinClasses.includes(probe.pinClass) &&
          !disposition.candidateWithinSupportedScope && !disposition.reclaimEligible, `${probe.pinClass} did not veto`);
      } finally { await client.query(probe.cleanup); }
    }
    const undeclared = await read(["unsupported_proposal_json_reader"]);
    assert(assessNativeArchivePins(undeclared,g).reason === "unsupported_reference_inventory", "declared unknown was ignored");
    await client.query(`CREATE TABLE ${s}.archive_future_pin (evaluation_id UUID REFERENCES ${s}.engine_v3_ad_decision_evaluations(id))`);
    const zero = await read();
    assert(zero.foreignKeyReferences.some(x=>x.childTable === "archive_future_pin" && x.count === "0" && x.pinClass === null) &&
      assessNativeArchivePins(zero,g).candidateWithinSupportedScope, "unclassified measured ZERO edge was omitted/refused");
    await client.query(`INSERT INTO ${s}.archive_future_pin VALUES ($1)`, [evaluation]);
    const unknown = await read();
    assert(unknown.unknownReferences.some(x=>x.includes("unclassified_live_reference") && x.includes("archive_future_pin")) &&
      !assessNativeArchivePins(unknown,g).candidateWithinSupportedScope, "unclassified live edge was ignored");
    await client.query(`DROP TABLE ${s}.archive_future_pin`);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='7500ms'");
    let timeout: string | undefined;
    try { await client.query("SELECT pg_sleep(8)"); } catch (error) { timeout=(error as {code?:string}).code; }
    finally { await client.query("ROLLBACK"); }
    assert(timeout === "57014", "7.5s statement timeout did not cancel before8s pool boundary");
    console.log(`[native-archive-pin-seam] PASS: ${NATIVE_PIN_CLASSES.length} isolated declared pin classes independently veto; unclassified catalog ZERO recorded/live edge and unknown non-FK class fail-closed; repeatable-read readonly snapshot and7.5s SQL cancellation57014. No production census, transitive-reader completeness or reclaim authority.`);
  } finally { await client.query("ROLLBACK").catch(()=>undefined); await client.query(`DROP SCHEMA ${s} CASCADE`); }
}
