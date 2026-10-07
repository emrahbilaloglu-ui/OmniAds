import { readNativeEvaluationContextUnit } from "../../lib/creative-decision-engine/native-evaluation-context-unit";
import { readNativeArchivePinCensus } from "../../lib/creative-decision-engine/native-archive-pin-census";
import { DEPENDENT_ROWS_SQL, censusVeto, readOnlyAdapter, readTargetCatalog, type Q, type UnitConfig } from "./capture";
import { BYTE_PRESERVED_TABLES, CLOSED_DAY_BUFFER_MS, CONTEXT, DECLARED_CLOSURE_GAP, EVAL, INPUT, NATIVE_JOB, RETAINED_TABLES, UNIT_CONFIG_CONTRACT, UUID,
  need, rowSetHash, safeError, same, sha256 } from "./common";
import { INPUT_EVIDENCE_LIFECYCLE, frozenRowSha, globalZeroReferenceKeys, liveReferenceCount, readInputRows, requireReferenceIndex,
  type InputEvidenceConfig } from "./input-evidence-lifecycle";
import { readNativeProducerIdle } from "./native-producer-idle";
import { archiveEngineVeto } from "./archive-engine-eligibility";

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
      // D149: the receipt's engine decides archive eligibility FIRST (typed veto; the header stays, never a WHERE skip).
      // Over-cap originals are reported as a real refusal, never silently skipped or subset.
      metadataVeto: archiveEngineVeto(r.engine_version) ??
        (Number(r.row_count) > (input.maxEvaluations ?? 1134) ? `FINITE_ORIGINAL_POPULATION_EXCEEDED:${Number(r.row_count)}>${input.maxEvaluations ?? 1134}` :
        Number(r.contexts) < 1 || Number(r.contexts) > 4 ? "CONTEXT_COUNT_OUTSIDE_1_4" :
        r.later_day !== true ? "SUBSEQUENT_DISTINCT_DAY_SUCCESS_REQUIRED" : null) }));
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

/** v3 (D150) input-evidence readback, independent of the retirement's own
 * partition: every frozen key still present is byte-identical to its frozen
 * bytes AND still has a live reference (no zero-reference key left behind);
 * every absent frozen key has ZERO live evaluation references (no dangling).
 * Both global checks are index-probed (catalog + EXPLAIN verified). */
async function readInputEvidenceLifecycle(db: Q, config: UnitConfig & { inputEvidence: InputEvidenceConfig }) {
  const rowSha = frozenRowSha(config), keys = config.inputKeys as [string, string][];
  const indexNames = (await requireReferenceIndex((s, v) => db.query(s, v))).map(i => i.name);
  const present = await readInputRows((s, v) => db.query(s, v), keys);
  const presentIds = new Set(present.map(r => JSON.stringify([r.contract_version, r.input_hash])));
  const presentKeys = keys.filter(k => presentIds.has(JSON.stringify(k))), absentKeys = keys.filter(k => !presentIds.has(JSON.stringify(k)));
  const presentBytesMatch = presentIds.size === present.length && present.every(r => sha256(r.bytes) === rowSha([r.contract_version, r.input_hash]));
  const presentUnreferenced = (await globalZeroReferenceKeys((s, v) => db.query(s, v), presentKeys, indexNames)).keys.length;
  const danglingAbsent = await liveReferenceCount((s, v) => db.query(s, v), absentKeys, indexNames);
  return { lifecycle: INPUT_EVIDENCE_LIFECYCLE, frozenKeys: keys.length, presentShared: presentKeys.length, absentRetired: absentKeys.length,
    absentKeysSha256: sha256(JSON.stringify(absentKeys)), presentBytesMatch, presentUnreferenced, danglingAbsent,
    match: presentBytesMatch && presentUnreferenced === 0 && danglingAbsent === 0 };
}

/** Independent READ ONLY readback on its own connection: exact IDs absent by
 * PK, job-leading context index empty, every retained root byte-equal. A v2
 * unit config (D150) checks the byte-preserved roots plus the input-evidence
 * lifecycle invariants; a v1 config (history) keeps its original all-roots rule. */
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
    const v3 = config.contract === UNIT_CONFIG_CONTRACT;
    const inputEvidence = v3 ? await readInputEvidenceLifecycle(db, config as UnitConfig & { inputEvidence: InputEvidenceConfig }) : null;
    const rootsMatch = v3 ? BYTE_PRESERVED_TABLES.every(t => same(roots[t], config.tableHashes[t])) && inputEvidence!.match === true
      : RETAINED_TABLES.every(t => same(roots[t], config.tableHashes[t]));
    // The retained original job's terminal NO-OP dependents: exact frozen set and full bytes.
    const dependents = (await db.query(DEPENDENT_ROWS_SQL, [config.generation.jobRunId])).rows as { id: string; bytes: string }[];
    const dependentsMatch = same(dependents.map(r => r.id), config.retainedDependents.jobIds) &&
      rowSetHash(dependents.map(r => r.bytes)) === config.retainedDependents.rowByteSetSha256;
    return { exactUnitAbsent: present === 0 && ctx.ids === 0 && ctx.job === 0, evaluationsPresent: present,
      contextsPresent: ctx.ids, jobContexts: ctx.job, retainedRootsFullBytesMatch: rootsMatch && dependentsMatch,
      retainedTerminalNoopDependentsMatch: dependentsMatch, roots, ...(inputEvidence ? { inputEvidence } : {}) };
  } finally { await db.query("ROLLBACK"); }
}

/** Fresh pre-retirement pin closure in its own READ ONLY RR snapshot (same
 * EXPLAIN-vetoed adapter as the freeze): the selected unit's FK/non-FK pins,
 * plus a FRESH whole census whose job_dependencies must classify to exactly the
 * frozen terminal NO-OP dependents (ids and full bytes); anything else is false. */
export async function readSelectedPinClosure(db: Q, c: UnitConfig) {
  const source = readOnlyAdapter(db);
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await source.query("SET LOCAL statement_timeout='7500ms'"); await source.query("SET LOCAL timezone='UTC'");
    const observed = (await source.query("SELECT transaction_timestamp()::text observed")).rows[0].observed as string;
    const catalog = await readTargetCatalog(async (s, v) => (await source.query(s, v)).rows);
    const unit = await readNativeEvaluationContextUnit(source, { schema: "public", generation: c.generation,
      consumerInventorySha256: c.consumerInventorySha256, unmodeledConsumers: [DECLARED_CLOSURE_GAP] });
    const fkZero = unit.incomingReferences.filter(e => !e.internalSelectedMembership).every(e => e.count === "0");
    const nonFkZero = unit.nonFkCounts.every(p => p.count === "0");
    let retainedDependentsMatch = false, recensusRefusal: string | null = null;
    try {
      const census = await readNativeArchivePinCensus(source, { schema: "public", generation: c.generation, unmodeledReferences: [] });
      retainedDependentsMatch = same((await censusVeto(source.query, census, c.generation, observed)).dependents, c.retainedDependents);
      if (!retainedDependentsMatch) recensusRefusal = "RETAINED_TERMINAL_NOOP_DEPENDENTS_CHANGED";
    } catch (error) { recensusRefusal = safeError(error).code; }
    return { selectedPinClosureMatches: catalog.fingerprint === c.catalogFingerprint && fkZero && nonFkZero &&
      unit.contextSharingCount === "0" && unit.evaluationCount === String(c.evaluations) &&
      JSON.stringify(unit.unknownReferences) === JSON.stringify([DECLARED_CLOSURE_GAP]) && retainedDependentsMatch,
    retainedDependentsMatch, recensusRefusal };
  } finally { await source.query("ROLLBACK").catch(() => undefined); }
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

/** One ordinary VACUUM component (main OR toast) over the three relations a v3
 * retirement deletes from (D150: the two targets + input evidence). Separate
 * ACK per component, finite 60 s statement, 1 s lock wait, no FULL/TRUNCATE. */
export const VACUUM_RELATIONS = [EVAL, CONTEXT, INPUT] as const;
export async function vacuumComponent(db: Q, component: "main" | "toast", jobRunIds: string[], notices: string[]) {
  const own = (await db.query(`SELECT count(*)::int n FROM pg_class WHERE oid IN (${VACUUM_RELATIONS.map(r => `'public.${r}'::regclass`).join(",")}) AND relkind='r' AND pg_has_role(current_user,relowner,'USAGE')`)).rows[0];
  need(own.n === VACUUM_RELATIONS.length, "OWNED_EXACT_THREE_RELATIONS");
  const lineage = await enforcedLineageAbsence(db, jobRunIds);
  need(lineage.absent, lineage.enforced ? "UNIT_NOT_ABSENT" : "ENFORCED_CONTEXT_JOB_LINEAGE");
  await db.query("SET statement_timeout='60000ms'"); await db.query("SET lock_timeout='1000ms'");
  await db.query("SET vacuum_cost_delay='2ms'"); await db.query("SET vacuum_cost_limit=200");
  const option = component === "main" ? "PROCESS_TOAST FALSE" : "PROCESS_MAIN FALSE";
  const started = Date.now();
  const result = await db.query(`VACUUM (${option}, INDEX_CLEANUP AUTO, TRUNCATE FALSE, PARALLEL 0, BUFFER_USAGE_LIMIT '8MB') ${VACUUM_RELATIONS.map(r => `public.${r}`).join(", ")}`);
  const elapsedMs = Date.now() - started;
  need(result.command === "VACUUM", "VACUUM_ACK_REQUIRED");
  need(notices.length === 0, "VACUUM_NOTICE_STATUS_ONLY");
  return { component, acknowledged: true, elapsedMs, lineage };
}

/** Post-retirement TOAST OBSERVATION (replaces the bounded TOAST VACUUM). One
 * READ ONLY REPEATABLE READ snapshot, the original 7.5 s statement / 1 s lock
 * read limits, ROLLBACK. Catalog + pg_stat metadata of EXACTLY the two target
 * relations' TOAST relations: no heap/tuple scan, no VACUUM, no DDL/DML. It
 * records whether any (auto)vacuum has run; it never claims a TOAST VACUUM ACK,
 * reusable bytes or OS shrink. */
export const TOAST_OBSERVATION_CONTRACT = "native-post-retirement-toast-observation.v1" as const;
export async function observeTargetToast(db: Q) {
  const source = readOnlyAdapter(db);
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await source.query("SET LOCAL statement_timeout='7500ms'"); await source.query("SET LOCAL lock_timeout='1000ms'");
    await source.query("SET LOCAL timezone='UTC'");
    const rows = (await source.query(`SELECT c.relname::text relation,t.oid::text toast_oid,t.relpages::text relpages,t.reltuples::text reltuples,
        t.relallvisible::text relallvisible,pg_relation_size(t.oid)::text toast_bytes,pg_indexes_size(t.oid)::text toast_index_bytes,
        s.n_live_tup::text live,s.n_dead_tup::text dead,s.n_tup_ins::text inserted,s.n_tup_del::text deleted,
        to_jsonb(s.last_vacuum)#>>'{}' last_vacuum,to_jsonb(s.last_autovacuum)#>>'{}' last_autovacuum,
        s.vacuum_count::text vacuum_count,s.autovacuum_count::text autovacuum_count,
        CASE WHEN pg_has_role(current_user,'pg_read_all_stats','USAGE')
          THEN EXISTS(SELECT 1 FROM pg_stat_progress_vacuum v WHERE v.relid=t.oid) END vacuum_in_progress,
        current_setting('transaction_read_only') read_only,transaction_timestamp()::text observed_at
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class t ON t.oid=c.reltoastrelid
      JOIN pg_namespace tn ON tn.oid=t.relnamespace JOIN pg_stat_all_tables s ON s.relid=t.oid
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) AND t.relkind='t' AND tn.nspname='pg_toast'
      ORDER BY c.relname`, [[CONTEXT, EVAL]])).rows;
    const count = (v: unknown) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
    need(rows.length === 2 && same(rows.map(r => r.relation), [CONTEXT, EVAL].sort()) && rows.every(r => r.read_only === "on" &&
      [r.toast_oid, r.relpages, r.relallvisible, r.toast_bytes, r.toast_index_bytes, r.live, r.dead, r.inserted, r.deleted,
        r.vacuum_count, r.autovacuum_count].every(count) && (r.vacuum_in_progress === null || typeof r.vacuum_in_progress === "boolean")), "EXACT_TWO_TARGET_TOAST_RELATIONS");
    return { contract: TOAST_OBSERVATION_CONTRACT, observedAt: rows[0].observed_at as string, readOnly: true as const,
      vacuumCommandExecuted: false as const, toastVacuumAcknowledged: false as const, reusableBytesClaimed: 0 as const,
      osReturnedBytesClaimed: 0 as const,
      relations: rows.map(r => ({ relation: r.relation as string, toastOid: r.toast_oid as string, toastBytes: r.toast_bytes as string,
        toastIndexBytes: r.toast_index_bytes as string, relpages: r.relpages as string, reltuples: r.reltuples as string,
        relallvisible: r.relallvisible as string, liveTuples: r.live as string, deadTuples: r.dead as string, inserted: r.inserted as string,
        deleted: r.deleted as string, lastVacuum: (r.last_vacuum ?? null) as string | null, lastAutovacuum: (r.last_autovacuum ?? null) as string | null,
        vacuumCount: r.vacuum_count as string, autovacuumCount: r.autovacuum_count as string, vacuumInProgress: r.vacuum_in_progress as boolean | null })) };
    // A failed explicit ROLLBACK propagates: the observation is never acknowledged without it.
  } finally { await source.query("ROLLBACK"); }
}

type ToastObservation = Partial<Awaited<ReturnType<typeof observeTargetToast>>> | null | undefined;
/** Stage evidence: the observation's own fields verbatim (never re-asserted here). */
export function toastObservationEvidence(o: ToastObservation) {
  return { observationContract: o?.contract ?? null, readOnly: o?.readOnly ?? null, vacuumCommandExecuted: o?.vacuumCommandExecuted ?? null,
    toastVacuumAcknowledged: o?.toastVacuumAcknowledged ?? null, reusableBytesClaimed: o?.reusableBytesClaimed ?? null,
    osReturnedBytesClaimed: o?.osReturnedBytesClaimed ?? null, observedAt: o?.observedAt ?? null, relations: o?.relations ?? null };
}
/** Acknowledged ONLY as a completed read-only observation of exactly two TOAST
 * relations with every non-claim intact; it is never a TOAST VACUUM ACK. */
export function toastObservationAcknowledged(o: ToastObservation) {
  return o?.contract === TOAST_OBSERVATION_CONTRACT && o.readOnly === true && o.vacuumCommandExecuted === false &&
    o.toastVacuumAcknowledged === false && o.reusableBytesClaimed === 0 && o.osReturnedBytesClaimed === 0 &&
    Array.isArray(o.relations) && o.relations.length === 2;
}

/** Catalog/statistics only, over the three vacuum relations. Never claims reclaimed or OS-returned bytes. */
export async function spaceReadback(db: Q) {
  const rows = (await db.query(`SELECT c.relname relation,pg_relation_size(c.oid)::text main_bytes,
      coalesce(pg_relation_size(NULLIF(c.reltoastrelid,0)),0)::text toast_bytes,pg_indexes_size(c.oid)::text index_bytes,
      s.n_live_tup::text live,s.n_dead_tup::text dead,to_jsonb(s.last_vacuum)#>>'{}' last_vacuum,
      t.n_dead_tup::text toast_dead,to_jsonb(t.last_vacuum)#>>'{}' toast_last_vacuum
    FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid=c.oid LEFT JOIN pg_stat_all_tables t ON t.relid=c.reltoastrelid
    WHERE c.oid IN (${VACUUM_RELATIONS.map(r => `'public.${r}'::regclass`).join(",")}) ORDER BY c.relname`)).rows;
  need(rows.length === VACUUM_RELATIONS.length, "EXACT_THREE_RELATIONS");
  return { relations: rows, reclaimedBytes: 0 as const, osReturnedBytes: 0 as const };
}

/** Fresh DB-side admission measurements. Unknown consumers = concrete catalog
 * consumers on the targets plus any client session whose application_name is
 * not in the exact allowlist. Current/fresh/owned/unknown running producers veto;
 * only explicitly reviewed stale retired-epoch metadata may be distinguished. */
export async function databaseAdmissionFacts(db: Q, input: { expectedRole: string; knownApplicationNames: string[]; jobRunIds: string[] }) {
  const who = (await db.query(`SELECT current_user u,session_user s,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) su,current_database() d`)).rows[0];
  let catalogConsumers = 0;
  try { await readTargetCatalog(async (s, v) => (await db.query(s, v)).rows); }
  catch { catalogConsumers = 1; }
  const sessions = (await db.query(`SELECT coalesce(application_name,'') app FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`)).rows;
  const unknownSessions = sessions.filter(s => !input.knownApplicationNames.includes(s.app)).length;
  const roleMatches = who.u === input.expectedRole && who.s === input.expectedRole;
  const producerLedger = await readNativeProducerIdle(db, roleMatches && catalogConsumers + unknownSessions === 0);
  const lineage = await enforcedLineageAbsence(db, input.jobRunIds);
  return { role: who.u as string, roleMatches: who.u === input.expectedRole && who.s === input.expectedRole, database: who.d as string,
    unknownDatabaseConsumers: catalogConsumers + unknownSessions, nativeProducerIdle: producerLedger.nativeProducerIdle,
    producerLedger, lineage };
}
