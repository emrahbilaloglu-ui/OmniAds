import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Client } from "pg";
import { readNativeArchivePinCensus, assessNativeArchivePins,
  type NativePinClass, type NativeArchivePinCensus } from "@/lib/creative-decision-engine/native-archive-pin-census";
import { buildNativeSupersededEvidenceArchive, openNativeSupersededEvidenceArchive,
  NATIVE_ARCHIVE_TABLES, type NativeArchiveGeneration, type NativeArchiveSchema } from "@/lib/creative-decision-engine/native-evidence-archive";
import { NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION } from "@/lib/creative-decision-engine/ad-operator-response-detection";

const DB = "native_archive_schema_seam";
const AS_OF = "2026-09-24", EPOCH = "native-archive-schema-fixture", CONTRACT = "schema-fixture.v1";
const HASH = "a".repeat(64), CLOCK = "2026-09-24T07:00:00.000001Z";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`native archive production-schema seam FAILED: ${message}`);
}
function quote(name: string): string {
  assert(/^[a-z_][a-z0-9_]*$/.test(name), "invalid fixture/catalog identifier");
  return `"${name}"`;
}
interface Fixture {
  generation: NativeArchiveGeneration; evaluation: string; snapshot?: string;
  inputHash: string; common: Record<string, unknown>;
}

/** Own NEW database on the native-ad seam's random loopback cluster only.
 * Real run-migrations installs all production DDL; no simplified leaf schema,
 * production connection, migration switch or immutable-row deletion is used.
 * Fixture rows below prove schema/pin handling, not a natural decision outcome.
 */
export async function verifyNativeArchiveProductionSchema(client: Client) {
  const cp = (client as Client & { connectionParameters: { database: string; host: string; port: number } }).connectionParameters;
  assert(cp.database === "native_ad_seam" && cp.host === "127.0.0.1" &&
    ![5432, 15432].includes(cp.port), "not the owned isolated native-ad server");
  assert((await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [DB])).rowCount === 0,
    "target fixture database already exists; refuse to adopt/drop it");
  await client.query(`CREATE DATABASE ${quote(DB)}`);
  const connectionString = `postgresql://postgres@127.0.0.1:${cp.port}/${DB}`;
  const db = new Client({ connectionString });
  let connected = false;
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-migrations.ts"], {
      cwd: process.cwd(), stdio: "inherit", env: { ...process.env,
        DATABASE_URL: connectionString, DATABASE_URL_UNPOOLED: connectionString,
        DB_SSL_MODE: "disable", ENABLE_RUNTIME_MIGRATIONS: "1", ADSECUTE_EPHEMERAL_DB_SEAM: "1" },
    });
    const exit = await new Promise<number>((resolve, reject) => {
      child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
    });
    assert(exit === 0, `real migration entrypoint EXIT${exit}`);
    await db.connect(); connected = true;
    const insert = async (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      await db.query(`INSERT INTO public.${quote(table)} (${keys.map(quote).join(",")})
        VALUES (${keys.map((_, i) => `$${i+1}`).join(",")})`, Object.values(row));
    };
    const foreignEvaluation = async (table: string, row: Record<string, unknown>, evaluation: string, inTransaction = false) => {
      if (!inTransaction) await db.query("BEGIN");
      await db.query("SAVEPOINT foreign_evaluation_probe");
      let code: string | undefined, constraint: string | undefined;
      try { await insert(table, { ...row, evaluation_id: evaluation }); }
      catch (error) { ({code, constraint}=error as {code?:string; constraint?:string}); }
      finally {
        await db.query("ROLLBACK TO SAVEPOINT foreign_evaluation_probe");
        await db.query("RELEASE SAVEPOINT foreign_evaluation_probe");
        if (!inTransaction) await db.query("ROLLBACK");
      }
      assert(code === "23503", `${table} INSERT foreign lineage did not hit FK (${code})`);
      console.log(`[native-archive-production-schema] ${table} foreign-evaluation INSERT SQLSTATE${code} ${constraint}`);
    };
    const user = randomUUID(), business = randomUUID(), accountRef = randomUUID(), account = "act_archive_schema_fixture";
    await insert("users", { id: user, name: "Owned archive schema fixture", email: `${user}@example.invalid`, password_hash: "fixture-only" });
    await insert("businesses", { id: business, name: "Owned archive schema fixture", owner_id: user });
    await insert("provider_accounts", { id: accountRef, provider: "meta", external_account_id: account });
    await insert("business_provider_accounts", { business_id: business, provider: "meta", provider_account_ref_id: accountRef,
      provider_account_id: account, is_selected: true });
    const seedJob = async (id: string, extra: Record<string, unknown> = {}) => insert("engine_v3_job_runs", {
      id, business_ref_id: business, business_id: business, as_of_date: AS_OF, engine_version: EPOCH,
      job_name: "engine_v3_native_ad_decisions_shadow_job", status: "success", row_count: 0,
      started_at: "2026-09-24T06:00:00Z", finished_at: CLOCK, ...extra });
    const read = async (f: Fixture, unknown: string[] = []) => {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL statement_timeout='7500ms'");
      try { return await readNativeArchivePinCensus(db, { schema: "public", generation: f.generation, unmodeledReferences: unknown }); }
      finally { await db.query("ROLLBACK"); }
    };
    const seed = async (label: string, sharedHash?: string): Promise<Fixture> => {
      const job = randomUUID(), context = randomUUID(), evaluation = randomUUID();
      const hash = sharedHash ?? createHash("sha256").update(label).digest("hex");
      await seedJob(job, { row_count: 1 });
      // A later successful same-day run exists; it is not an incoming dependency.
      await seedJob(randomUUID(), { finished_at: "2026-09-24T08:00:00Z" });
      const common = { business_ref_id: business, business_id: business, provider_account_ref_id: accountRef,
        provider_account_id: account, as_of_date: AS_OF, engine_version: EPOCH,
        scope_type: "account", scope_id: account, job_run_id: job };
      await insert("engine_v3_ad_decision_evaluation_contexts", { ...common, id: context, contract_version: CONTRACT,
        context_json: {}, account_profile_json: {}, data_health_json: {}, flags_json: {}, context_hash: hash, evaluated_at: CLOCK });
      await insert("engine_v3_ad_decision_evaluations", { ...common, id: evaluation, context_id: context,
        contract_version: CONTRACT, decision_entity_type: "ad", decision_entity_id: label, ad_id: label,
        creative_input_json: {}, campaign_context_json: {}, prior_hysteresis_json: {}, decision_output_json: {},
        raw_label: "diagnose", input_hash: hash, decision_hash: HASH, evaluated_at: CLOCK });
      await db.query(`INSERT INTO engine_v3_ad_decision_input_evidence (contract_version,input_hash,input_evidence_json)
        VALUES ($1,$2,'{}') ON CONFLICT (contract_version,input_hash) DO NOTHING`, [CONTRACT, hash]);
      return { generation: { businessId: business, jobRunId: job, asOfDate: AS_OF, engineVersion: EPOCH },
        evaluation, inputHash: hash, common: { ...common, decision_entity_type: "ad", decision_entity_id: label, ad_id: label } };
    };
    const snapshot = async (f: Fixture) => {
      f.snapshot = randomUUID();
      await insert("engine_v3_ad_decision_snapshots_daily", { ...f.common, id: f.snapshot, evaluation_id: f.evaluation,
        label: "diagnose", raw_label: "diagnose", confidence: 0, truth_source: "global_default", effective_target_roas: 1,
        badges: JSON.stringify([{ type: "native_calibration_unavailable" }]), reason: "Schema fixture only",
        input_hash: f.inputHash, decision_hash: HASH, computed_at: CLOCK });
    };
    const copy = async (f: Fixture, census: NativeArchivePinCensus) => {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL statement_timeout='7500ms'");
      try {
        const fresh = await readNativeArchivePinCensus(db, { schema: "public", generation: f.generation, unmodeledReferences: [] });
        assert(assessNativeArchivePins(fresh, f.generation).reason === assessNativeArchivePins(census, f.generation).reason,
          "copy/census disposition changed");
        const columns = (await db.query(`SELECT c.relname AS table,a.attname AS name,
          format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
          WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
          ORDER BY c.relname,a.attnum`, [[...NATIVE_ARCHIVE_TABLES]])).rows;
        const foreignKeys = (await db.query(`SELECT child.relname AS "childTable",parent.relname AS "parentTable",
          pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con
          JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid
          JOIN pg_namespace cn ON cn.oid=child.relnamespace JOIN pg_namespace pn ON pn.oid=parent.relnamespace
          WHERE con.contype='f' AND (cn.nspname='public' AND child.relname=ANY($1::text[])
            OR pn.nspname='public' AND parent.relname=ANY($1::text[])) ORDER BY child.relname,con.conname`,
          [[...NATIVE_ARCHIVE_TABLES]])).rows;
        const schema: NativeArchiveSchema = { tables: NATIVE_ARCHIVE_TABLES.map(table => ({ table,
          columns: columns.filter(c => c.table === table).map(c => ({ name: c.name, type: c.type, nullable: c.nullable })) })),
          foreignKeys };
        const tables = [];
        for (const table of NATIVE_ARCHIVE_TABLES) {
          const predicate = table === "engine_v3_job_runs" ? "t.id=$1::uuid" : table === "engine_v3_ad_decision_input_evidence" ?
            `(t.contract_version,t.input_hash) IN (SELECT contract_version,input_hash FROM engine_v3_ad_decision_evaluations WHERE job_run_id=$1::uuid)` : "t.job_run_id=$1::uuid";
          const rows = (await db.query(`SELECT to_jsonb(t)::text AS bytes FROM public.${quote(table)} t WHERE ${predicate}`, [f.generation.jobRunId])).rows;
          tables.push({ table, rowJson: rows.map(r => r.bytes as string) });
        }
        const built = buildNativeSupersededEvidenceArchive({ generation: f.generation, capturedAt: fresh.observedAt,
          sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          sourceWorkspaceDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
          schema, tables, pinCensus: fresh });
        const reader = openNativeSupersededEvidenceArchive(built.bundle, { manifestHash: built.manifestHash,
          schemaHash: built.bundle.manifest.schemaHash, generation: f.generation });
        assert(reader.providerAuthority === false && reader.reclaimEligible === false &&
          reader.readTable("engine_v3_ad_decision_snapshots_daily").length === 0, "copy granted authority/fabricated snapshots");
        for (const table of tables) assert(JSON.stringify(reader.readTable(table.table).map(r => r.rowJson).sort()) ===
          JSON.stringify(table.rowJson.sort()), "production-schema core copy full-byte parity");
      } finally { await db.query("ROLLBACK"); }
    };
    const pinFree = await seed("full_ddl_pin_free"), initial = await read(pinFree);
    assert(assessNativeArchivePins(initial,pinFree.generation).candidateWithinSupportedScope && initial.unknownReferences.length === 0,
      `actual production-DDL zero-pin generation refused: ${JSON.stringify(initial.unknownReferences)}`);
    for (const table of ["engine_v3_ad_account_calibration_batches", "engine_v3_ad_account_calibration_daily", "engine_v3_ad_decision_outcome_runs"])
      assert(initial.foreignKeyReferences.some(e => e.childTable === table && e.count === "0"), `${table} unclassified ZERO edge absent`);
    await copy(pinFree,initial);
    const check = async (f: Fixture, pinClass: NativePinClass, canCopy = false) => {
      const census = await read(f), a = assessNativeArchivePins(census,f.generation);
      assert(a.reason === "live_pins" && a.pinClasses.includes(pinClass) && !a.candidateWithinSupportedScope && !a.reclaimEligible,
        `${pinClass} real DDL pin not counted/vetoed: ${JSON.stringify(a)}`);
      if (canCopy) await copy(f,census);
      console.log(`[native-archive-production-schema] ${pinClass}: ${JSON.stringify(census.counts)}; historicalCopy=${canCopy}`);
    };
    const s = await seed("full_ddl_snapshot"); await snapshot(s); await check(s,"snapshots");
    for (const column of ["decision_evaluation_id", "source_evaluation_id", "decision_snapshot_id", "source_snapshot_id"]) {
      const f = await seed(`full_ddl_${column}`);
      if (column.endsWith("snapshot_id")) await snapshot(f);
      await insert("meta_ads_action_log", { business_id: business, ad_id: f.common.ad_id, action: "pause", source: "ui_manual",
        [column]: column.endsWith("snapshot_id") ? f.snapshot : f.evaluation });
      await check(f,"action_lineage",!f.snapshot);
    }
    const dependency = await seed("full_ddl_dependency"); await seedJob(randomUUID(), { dependency_run_id: dependency.generation.jobRunId });
    await check(dependency,"job_dependencies",true);
    const reuse = await seed("full_ddl_reuse"); await seedJob(randomUUID(), { error_json: { metadata: { reused_job_run_id: reuse.generation.jobRunId } } });
    await check(reuse,"reuse_attempts",true);
    const shared = await seed("full_ddl_shared"); await seed("full_ddl_shared_other",shared.inputHash); await check(shared,"shared_input_evidence",true);
    const event = await seed("full_ddl_event"), { as_of_date: _eventDate, ...eventCommon } = event.common;
    await insert("engine_v3_ad_decision_events", { ...eventCommon, event_date: AS_OF, event_type: "manual_override" });
    await check(event,"events",true);
    const episode = await seed("full_ddl_episode"); await snapshot(episode);
    const episodeRow = { ...episode.common, contract_version: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
      episode_key: createHash("sha256").update(episode.evaluation).digest("hex"), decision_snapshot_id: episode.snapshot,
      evaluation_id: episode.evaluation, input_hash: episode.inputHash, decision_hash: HASH, decision_label: "diagnose",
      recommended_at: CLOCK, captured_at: CLOCK };
    await foreignEvaluation("engine_v3_ad_recommendation_episodes",episodeRow,pinFree.evaluation);
    await insert("engine_v3_ad_recommendation_episodes",episodeRow);
    await check(episode,"episodes");
    const assignment = await seed("full_ddl_assignment"); await snapshot(assignment);
    const experiment = randomUUID(), arm = randomUUID(), batch = randomUUID();
    const tenant = { business_id: business, provider_account_ref_id: accountRef, provider_account_id: account };
    await insert("meta_controlled_experiments", { ...tenant, id: experiment, contract_version: "meta-controlled-experiment.v2",
      name: "Schema fixture", hypothesis: "Schema only", primary_metric: "fixture", metric_direction: "higher",
      randomization_unit: "ad", randomization_algorithm: "sha256-threshold-v1", seed_commitment_hash: HASH,
      eligibility_count: 1, eligibility_hash: HASH, assignment_manifest_hash: HASH, registration_hash: HASH,
      starts_at: "2026-09-25T00:00Z", outcome_window_start_at: "2026-09-25T00:00Z", outcome_window_end_at: "2026-09-26T00:00Z",
      ends_at: "2026-09-27T00:00Z", preregistered_at: CLOCK, created_at: CLOCK });
    await db.query("BEGIN");
    await insert("meta_controlled_experiment_arms", { ...tenant, id: arm, experiment_id: experiment,
      contract_version: "meta-controlled-experiment-arm.v2", arm_role: "control", allocation_order: 0, assignment_probability: 0.5,
      treatment_action: null, arm_hash: HASH, created_at: CLOCK });
    await insert("meta_controlled_experiment_arms", { ...tenant, id: randomUUID(), experiment_id: experiment,
      contract_version: "meta-controlled-experiment-arm.v2", arm_role: "treatment", allocation_order: 1, assignment_probability: 0.5,
      treatment_action: "pause", arm_hash: HASH, created_at: CLOCK });
    await db.query("COMMIT");
    await db.query("BEGIN");
    await insert("meta_controlled_assignment_batches", { ...tenant, id: batch, experiment_id: experiment,
      contract_version: "meta-controlled-assignment-batch.v2", eligibility_count: 1, eligibility_hash: HASH,
      assignment_manifest_hash: HASH, eligibility_manifest_json: "[]", batch_hash: HASH, assigned_at: CLOCK, created_at: CLOCK });
    const assignmentRow = { ...tenant, id: randomUUID(), experiment_id: experiment, batch_id: batch, arm_id: arm,
      contract_version: "meta-controlled-random-assignment.v2", arm_role: "control", recommendation_fingerprint: "fixture", rec_id: "fixture",
      evaluation_id: assignment.evaluation, snapshot_id: assignment.snapshot, entity_type: "ad", entity_id: assignment.common.ad_id,
      assigned_action: null, assignment_probability: 0.5, randomization_algorithm: "sha256-threshold-v1", seed_commitment_hash: HASH,
      eligibility_hash: HASH, randomization_draw: 0.25, randomization_proof_hash: HASH, assignment_hash: HASH, assigned_at: CLOCK, created_at: CLOCK };
    await foreignEvaluation("meta_controlled_random_assignments",assignmentRow,pinFree.evaluation,true);
    await insert("meta_controlled_random_assignments",assignmentRow);
    await db.query("COMMIT");
    await check(assignment,"assignments");
    const outcome = await seed("full_ddl_outcome"); await snapshot(outcome);
    const outcomeJob = randomUUID(), outcomeRun = randomUUID(), evaluationDate = "2026-09-28";
    await seedJob(outcomeJob, { as_of_date: evaluationDate });
    const runRow = { id: outcomeRun, job_run_id: outcomeJob, business_ref_id: business, business_id: business,
      evaluation_date: evaluationDate, engine_version: EPOCH, contract_version: CONTRACT, classifier_version: "fixture",
      windows_days: [3], lookback_days: 1, candidate_row_count: 1, window_counts_json: {}, source_set_hash: HASH, status: "pending", started_at: CLOCK };
    await insert("engine_v3_ad_decision_outcome_runs", runRow);
    const { as_of_date: _outcomeDate, ...outcomeCommon } = outcome.common;
    await insert("engine_v3_ad_decision_outcomes_daily", { ...outcomeCommon, job_run_id: outcomeJob,
      contract_version: CONTRACT, classifier_version: "fixture", decision_snapshot_id: outcome.snapshot, evaluation_id: outcome.evaluation,
      source_decision_job_run_id: outcome.generation.jobRunId, decision_as_of_date: AS_OF, evaluation_date: evaluationDate,
      source_cutoff_at: "2026-09-28T05:00:00Z", outcome_window_days: 3, outcome_window_start: "2026-09-25", outcome_window_end: "2026-09-27",
      label: "diagnose", raw_label: "diagnose", confidence: 0, effective_target_roas: 1, currency_status: "unknown",
      commercial_context_json: {}, cohort_context_json: {}, outcome_spend: 0, outcome_purchases: 0, outcome_revenue: 0,
      expected_day_count: 3, completed_day_count: 0, window_complete: false, measurement_status: "unknown", realized_outcome: "unknown",
      severity: "low", treatment_status: "observational_untreated", action_contaminated: false, controlled_registry_available: false,
      treatment_receipt_validated: false, causal_assignment_validated: false, causal_estimate_validated: false, controlled_evidence_validated: false,
      source_input_hash: outcome.inputHash, source_decision_hash: HASH, ad_publication_receipts_hash: HASH, fact_source_hash: HASH,
      action_source_hash: HASH, state_source_hash: HASH, controlled_source_hash: HASH, source_manifest_hash: HASH,
      source_receipts_json: {}, controlled_evidence_json: {}, evidence_json: {}, outcome_run_id: outcomeRun, source_set_hash: HASH, computed_at: CLOCK });
    await check(outcome,"outcomes");
    const unclassified = await seed("full_ddl_outcome_run_pin");
    await insert("engine_v3_ad_decision_outcome_runs", { ...runRow, id: randomUUID(), job_run_id: unclassified.generation.jobRunId });
    const unknown = await read(unclassified);
    assert(unknown.foreignKeyReferences.some(e => e.childTable === "engine_v3_ad_decision_outcome_runs" && e.pinClass === null && e.count === "1") &&
      assessNativeArchivePins(unknown,unclassified.generation).reason === "unsupported_reference_inventory", "real outcome-run unknown live edge did not veto");
    const declared = await read(pinFree,["unclosed_production_json_reader"]);
    assert(assessNativeArchivePins(declared,pinFree.generation).reason === "unsupported_reference_inventory", "declared non-FK registry ignored");
    await db.query(`CREATE SCHEMA archive_cross_pin_fixture;
      CREATE TABLE archive_cross_pin_fixture.future_pin
        (evaluation_id UUID REFERENCES public.engine_v3_ad_decision_evaluations(id))`);
    const crossZero = await read(pinFree);
    assert(crossZero.foreignKeyReferences.some(e => e.childSchema === "archive_cross_pin_fixture" && e.count === "0") &&
      assessNativeArchivePins(crossZero,pinFree.generation).candidateWithinSupportedScope, "cross-schema ZERO edge not measured");
    await db.query("INSERT INTO archive_cross_pin_fixture.future_pin VALUES ($1)",[pinFree.evaluation]);
    const crossLive = await read(pinFree);
    assert(crossLive.foreignKeyReferences.some(e => e.childSchema === "archive_cross_pin_fixture" && e.count === "1") &&
      assessNativeArchivePins(crossLive,pinFree.generation).reason === "unsupported_reference_inventory", "cross-schema live edge not refused");
    console.log(`[native-archive-production-schema] PASS actual run-migrations/all production DDL: measured calibration/outcome-run ZERO FKs; pin-free superseded full-byte copy; nine positive pin classes and FOUR action lineage columns; known-pin copy/removal veto; unclassified live/outcome-run and non-FK veto. Snapshot-dependent classes include existing snapshot pins. Schema fixtures are not natural producer/production census/independent parent closure/eviction or reclaim proof.`);
  } finally {
    if (connected) await db.end();
    // Only the new DB we created, on the guarded owned cluster. No FORCE or
    // unrelated connection termination; a cleanup failure is a test failure.
    await client.query(`DROP DATABASE ${quote(DB)}`);
  }
}
