import { readTargetCatalog, type Q, type UnitConfig } from "./capture";
import { CLOSED_DAY_BUFFER_MS, CONTEXT, EVAL, NATIVE_JOB, RETAINED_TABLES, UUID, need, rowSetHash, same } from "./common";

/** Metadata-only bounded closed-day candidate selection. Reads job receipts and
 * the job-leading context index only; never an evaluation row. A candidate is
 * NOT eligible until a whole-original freeze measures it (vetoes apply there). */
export async function selectClosedDayCandidates(db: Q, input: { cursor: { asOfDate: string; jobRunId: string } | null;
  limit: number; cutoffObservedAt: string; maxEvaluations?: number }) {
  need(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 64, "FINITE_SELECTION_LIMIT");
  need(Number.isFinite(Date.parse(input.cutoffObservedAt)), "EXACT_CUTOFF");
  const c = input.cursor ?? { asOfDate: "1970-01-01", jobRunId: "00000000-0000-0000-0000-000000000000" };
  need(/^\d{4}-\d{2}-\d{2}$/.test(c.asOfDate) && UUID.test(c.jobRunId), "EXACT_CURSOR");
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout='7500ms'"); await db.query("SET LOCAL timezone='UTC'");
    const observed = (await db.query("SELECT transaction_timestamp()::text t,current_setting('transaction_read_only') ro")).rows[0];
    need(observed.ro === "on" && Date.parse(input.cutoffObservedAt) <= Date.parse(observed.t), "FUTURE_CUTOFF_REFUSED");
    const rows = (await db.query(`SELECT j.id::text job_run_id,j.business_ref_id::text business_id,j.as_of_date::text as_of_date,
        j.engine_version,j.row_count,to_jsonb(j.finished_at)#>>'{}' finished_at,
        (SELECT count(*) FROM public.${CONTEXT} c WHERE c.job_run_id=j.id)::int contexts,
        EXISTS(SELECT 1 FROM public.engine_v3_job_runs l WHERE l.business_ref_id=j.business_ref_id AND l.business_id=j.business_id
          AND l.engine_version=j.engine_version AND l.job_name=j.job_name AND l.status='success' AND l.as_of_date>j.as_of_date
          AND l.finished_at>j.finished_at) later_day
      FROM public.engine_v3_job_runs j
      WHERE j.job_name=$1 AND j.status='success' AND j.finished_at IS NOT NULL AND j.business_id=j.business_ref_id::text
        AND j.row_count>=1 AND $2::int>=1 AND (j.as_of_date,j.id)>($3::date,$4::uuid)
        AND (j.as_of_date::timestamp AT TIME ZONE 'UTC')+make_interval(hours=>38)<=$5::timestamptz
      ORDER BY j.as_of_date,j.id LIMIT $6`, [NATIVE_JOB, input.maxEvaluations ?? 1134, c.asOfDate, c.jobRunId,
      input.cutoffObservedAt, input.limit])).rows;
    const candidates = rows.map(r => ({ generation: { businessId: r.business_id, jobRunId: r.job_run_id, asOfDate: r.as_of_date,
      engineVersion: r.engine_version }, evaluations: Number(r.row_count), contexts: Number(r.contexts), finishedAt: r.finished_at,
      // Over-cap originals are reported as a real refusal, never silently skipped or subset.
      metadataVeto: Number(r.row_count) > (input.maxEvaluations ?? 1134) ? `FINITE_ORIGINAL_POPULATION_EXCEEDED:${Number(r.row_count)}>${input.maxEvaluations ?? 1134}` :
        Number(r.contexts) < 1 || Number(r.contexts) > 4 ? "CONTEXT_COUNT_OUTSIDE_1_4" :
        r.later_day !== true ? "SUBSEQUENT_DISTINCT_DAY_SUCCESS_REQUIRED" : null }));
    const last = rows.at(-1);
    return { observedAt: observed.t as string, candidates,
      nextCursor: last ? { asOfDate: last.as_of_date as string, jobRunId: last.job_run_id as string } : c,
      closedDayBufferHours: CLOSED_DAY_BUFFER_MS / 3_600_000, evaluationRowsRead: 0 as const };
  } finally { await db.query("ROLLBACK"); }
}

/** Retained-root rows equal to the frozen config (no locks; READ ONLY caller). */
export async function readRetainedRoots(db: Q, config: UnitConfig) {
  const g = config.generation, out: Record<string, { rows: number; rowByteSetSha256: string }> = {};
  const hash = (rows: { bytes: string }[]) => ({ rows: rows.length, rowByteSetSha256: rowSetHash(rows.map(r => r.bytes)) });
  for (const [table, values] of [["engine_v3_job_runs", config.jobIds], ["engine_v3_ad_account_calibration_batches", config.batchIds],
    ["engine_v3_ad_account_calibration_daily", config.cellIds]] as const)
    out[table] = hash((await db.query(`SELECT to_jsonb(t)::text bytes FROM public.${table} t WHERE id=ANY($1::uuid[])`, [values])).rows);
  const inputs: { bytes: string }[] = [];
  for (let i = 0; i < config.inputKeys.length; i += 400) { const page = config.inputKeys.slice(i, i + 400);
    inputs.push(...(await db.query(`SELECT to_jsonb(t)::text bytes FROM public.engine_v3_ad_decision_input_evidence t JOIN unnest($1::text[],$2::character(64)[]) k(contract_version,input_hash) ON t.contract_version=k.contract_version AND t.input_hash=k.input_hash`,
      [page.map(k => k[0]), page.map(k => k[1])])).rows); }
  out.engine_v3_ad_decision_input_evidence = hash(inputs);
  out.engine_v3_ad_campaign_context_objects = hash((await db.query(`SELECT to_jsonb(t)::text bytes FROM public.engine_v3_ad_campaign_context_objects t WHERE business_ref_id=$1::uuid AND payload_sha256=ANY($2::bytea[])`,
    [g.businessId, config.campaignObjectHashes.map(x => Buffer.from(x.slice(2), "hex"))])).rows);
  const snapshots: { bytes: string }[] = [];
  for (let i = 0; i < config.evaluationIds.length; i += 400) snapshots.push(...(await db.query(`SELECT to_jsonb(t)::text bytes FROM public.engine_v3_ad_decision_snapshots_daily t WHERE evaluation_id=ANY($1::uuid[])`, [config.evaluationIds.slice(i, i + 400)])).rows);
  out.engine_v3_ad_decision_snapshots_daily = hash(snapshots);
  return out;
}

/** Independent READ ONLY readback on its own connection: exact IDs absent by
 * PK, job-leading context index empty, every retained root byte-equal. */
export async function independentReadback(db: Q, config: UnitConfig) {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout='7500ms'"); await db.query("SET LOCAL timezone='UTC'");
    let present = 0;
    for (let i = 0; i < config.evaluationIds.length; i += 400)
      present += Number((await db.query(`SELECT count(*)::int n FROM public.${EVAL} WHERE id=ANY($1::uuid[])`, [config.evaluationIds.slice(i, i + 400)])).rows[0].n);
    const ctx = (await db.query(`SELECT (SELECT count(*) FROM public.${CONTEXT} WHERE id=ANY($1::uuid[]))::int ids,(SELECT count(*) FROM public.${CONTEXT} WHERE job_run_id=$2::uuid)::int job`,
      [config.contextIds, config.generation.jobRunId])).rows[0];
    const roots = await readRetainedRoots(db, config);
    const rootsMatch = RETAINED_TABLES.every(t => same(roots[t], config.tableHashes[t]));
    return { exactUnitAbsent: present === 0 && ctx.ids === 0 && ctx.job === 0, evaluationsPresent: present,
      contextsPresent: ctx.ids, jobContexts: ctx.job, retainedRootsFullBytesMatch: rootsMatch, roots };
  } finally { await db.query("ROLLBACK"); }
}

/** Index-backed absence + enforced lineage (vacuum-core r2 semantics): zero
 * contexts by job via idx_engine_v3_ad_eval_contexts_job, plus the validated,
 * non-deferrable, all-NOT-NULL 11-key FK with its 4 enabled internal triggers,
 * in session_replication_role=origin. Never scans evaluations. */
export async function enforcedLineageAbsence(db: Q, jobRunIds: string[]) {
  need(jobRunIds.length >= 1 && jobRunIds.length <= 8 && jobRunIds.every(j => UUID.test(j)), "EXACT_JOB_SET");
  const counts = (await db.query(`SELECT count(*)::int n FROM public.${CONTEXT} WHERE job_run_id=ANY($1::uuid[])`, [jobRunIds])).rows[0];
  const lineage = (await db.query(`SELECT current_setting('session_replication_role') role,
      (SELECT count(*) FROM pg_constraint con WHERE con.conname='engine_v3_ad_evaluations_context_lineage_fk' AND con.contype='f'
        AND con.conrelid='public.${EVAL}'::regclass AND con.confrelid='public.${CONTEXT}'::regclass AND con.convalidated
        AND NOT con.condeferrable AND NOT con.condeferred
        AND ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.n ORDER BY k.o)
          =ARRAY['context_id','business_ref_id','business_id','provider_account_ref_id','provider_account_id','as_of_date','engine_version','scope_type','scope_id','contract_version','job_run_id']
        AND ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.n ORDER BY k.o)
          =ARRAY['id','business_ref_id','business_id','provider_account_ref_id','provider_account_id','as_of_date','engine_version','scope_type','scope_id','contract_version','job_run_id']
        AND (SELECT bool_and(a.attnotnull) FROM unnest(con.conkey) k(n) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.n)
        AND (SELECT count(*)=4 AND bool_and(t.tgisinternal AND t.tgenabled IN ('O','A')) FROM pg_trigger t WHERE t.tgconstraint=con.oid))::int fk,
      (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE ic.relname='idx_engine_v3_ad_eval_contexts_job'
        AND i.indrelid='public.${CONTEXT}'::regclass AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL
        AND (SELECT attname FROM pg_attribute WHERE attrelid=i.indrelid AND attnum=i.indkey[0])='job_run_id')::int idx`)).rows[0];
  return { jobContexts: counts.n as number, enforced: lineage.role === "origin" && lineage.fk === 1 && lineage.idx === 1,
    absent: counts.n === 0 && lineage.role === "origin" && lineage.fk === 1 && lineage.idx === 1 };
}

/** One ordinary VACUUM component (main OR toast) over both relations. Separate
 * ACK per component, finite 60 s statement, 1 s lock wait, no FULL/TRUNCATE. */
export async function vacuumComponent(db: Q, component: "main" | "toast", jobRunIds: string[], notices: string[]) {
  const own = (await db.query(`SELECT count(*)::int n FROM pg_class WHERE oid IN ('public.${EVAL}'::regclass,'public.${CONTEXT}'::regclass) AND relkind='r' AND pg_has_role(current_user,relowner,'USAGE')`)).rows[0];
  need(own.n === 2, "OWNED_EXACT_TWO_RELATIONS");
  const lineage = await enforcedLineageAbsence(db, jobRunIds);
  need(lineage.absent, lineage.enforced ? "UNIT_NOT_ABSENT" : "ENFORCED_CONTEXT_JOB_LINEAGE");
  await db.query("SET statement_timeout='60000ms'"); await db.query("SET lock_timeout='1000ms'");
  await db.query("SET vacuum_cost_delay='2ms'"); await db.query("SET vacuum_cost_limit=200");
  const option = component === "main" ? "PROCESS_TOAST FALSE" : "PROCESS_MAIN FALSE";
  const started = Date.now();
  const result = await db.query(`VACUUM (${option}, INDEX_CLEANUP AUTO, TRUNCATE FALSE, PARALLEL 0, BUFFER_USAGE_LIMIT '8MB') public.${EVAL}, public.${CONTEXT}`);
  const elapsedMs = Date.now() - started;
  need(result.command === "VACUUM", "VACUUM_ACK_REQUIRED");
  need(notices.length === 0, "VACUUM_NOTICE_STATUS_ONLY");
  return { component, acknowledged: true, elapsedMs, lineage };
}

/** Catalog/statistics only. Never claims reclaimed or OS-returned bytes. */
export async function spaceReadback(db: Q) {
  const rows = (await db.query(`SELECT c.relname relation,pg_relation_size(c.oid)::text main_bytes,
      coalesce(pg_relation_size(NULLIF(c.reltoastrelid,0)),0)::text toast_bytes,pg_indexes_size(c.oid)::text index_bytes,
      s.n_live_tup::text live,s.n_dead_tup::text dead,to_jsonb(s.last_vacuum)#>>'{}' last_vacuum,
      t.n_dead_tup::text toast_dead,to_jsonb(t.last_vacuum)#>>'{}' toast_last_vacuum
    FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid=c.oid LEFT JOIN pg_stat_all_tables t ON t.relid=c.reltoastrelid
    WHERE c.oid IN ('public.${EVAL}'::regclass,'public.${CONTEXT}'::regclass) ORDER BY c.relname`)).rows;
  need(rows.length === 2, "EXACT_TWO_RELATIONS");
  return { relations: rows, reclaimedBytes: 0 as const, osReturnedBytes: 0 as const };
}

/** Fresh DB-side admission measurements. Unknown consumers = concrete catalog
 * consumers on the targets plus any client session whose application_name is
 * not in the exact allowlist. Producer idle = no running native/calibration job. */
export async function databaseAdmissionFacts(db: Q, input: { expectedRole: string; knownApplicationNames: string[]; jobRunIds: string[] }) {
  const who = (await db.query(`SELECT current_user u,session_user s,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su,current_database() d`)).rows[0];
  let catalogConsumers = 0;
  try { await readTargetCatalog(async (s, v) => (await db.query(s, v)).rows); }
  catch { catalogConsumers = 1; }
  const sessions = (await db.query(`SELECT coalesce(application_name,'') app FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows;
  const unknownSessions = sessions.filter(s => !input.knownApplicationNames.includes(s.app)).length;
  const running = (await db.query(`SELECT count(*)::int n FROM public.engine_v3_job_runs WHERE status='running' AND job_name IN ($1,'engine_v3_native_ad_calibration_shadow_job')`, [NATIVE_JOB])).rows[0];
  const lineage = await enforcedLineageAbsence(db, input.jobRunIds);
  return { role: who.u as string, roleMatches: who.u === input.expectedRole && who.s === input.expectedRole, database: who.d as string,
    unknownDatabaseConsumers: catalogConsumers + unknownSessions, nativeProducerIdle: running.n === 0, lineage };
}
