import { DEPENDENT_ROWS_SQL, RETAINED_DEPENDENTS_CONTRACT, TERMINAL_NOOP_DEPENDENT, readTargetCatalog, type Q, type UnitConfig } from "./capture";
import { readUnitTransactionInventory } from "./rw-unit-inventory";
import { CLOSED_DAY_BUFFER_MS, CONTEXT, DECLARED_CLOSURE_GAP, EVAL, EXPECTED_INCOMING_FKS, NATIVE_JOB, NON_FK_CLASSES,
  NON_FK_TABLES, RETAINED_TABLES, SHA, UUID, canonicalSha, exactIds, need, rowSetHash, same, sha256 } from "./common";

/** Generic port of the reviewed C3 one-unit retirement: one short own
 * REPEATABLE READ READ WRITE transaction, both target tables ACCESS EXCLUSIVE,
 * the five non-FK classes SHARE, measured pins, exact frozen IDs and full JSONB
 * hashes, retained roots FOR SHARE and byte-equal before/after, DELETE by full
 * identity predicate. The literal 82e3/tenant/1134/1239 guards are replaced by
 * the frozen unit config whose canonical digest is the plan's originalProofSha256.
 * Returns PREPARED (uncommitted); the caller commits once after a challenge. */
export function unitScope(config: UnitConfig, proofSha256: string) {
  need(config?.contract === "finite-native-storage-unit-config.v1" && canonicalSha(config) === proofSha256, "EXACT_FROZEN_UNIT_CONFIG");
  need(config.evaluations >= 1 && config.evaluations <= 1134 && config.contexts >= 1 && config.contexts <= 4, "FINITE_ORIGINAL_POPULATION");
  const d = config.retainedDependents;
  need(d?.contract === RETAINED_DEPENDENTS_CONTRACT && Array.isArray(d.jobIds) && d.jobIds.length === d.rows &&
    d.rows <= TERMINAL_NOOP_DEPENDENT.maxPerOriginal && d.jobIds.every(x => UUID.test(x)) && same(d.jobIds, [...new Set(d.jobIds)].sort()) &&
    SHA.test(d.rowByteSetSha256), "EXACT_FROZEN_UNIT_CONFIG");
  return { evalIds: exactIds(config.evaluationIds, config.evaluations, "EXACT_ORIGINAL_UUID_SET"),
    contextIds: exactIds(config.contextIds, config.contexts, "EXACT_ORIGINAL_CONTEXT_SET") };
}
function pinGate(m: Awaited<ReturnType<typeof readUnitTransactionInventory>>, config: UnitConfig) {
  const n = String(config.evaluations);
  need(m.generation.jobRunId === config.generation.jobRunId && m.generation.businessId === config.generation.businessId &&
    m.originalJobRowCount === n && m.evaluationCount === n && m.selectedContextCount === String(config.contexts), "WHOLE_UNIT_SCOPE_MISMATCH");
  need(m.contextSharingCount === "0", "WHOLE_UNIT_SCOPE_MISMATCH:CONTEXT_SHARED");
  need(same(m.incomingReferences.map(x => x.constraint).sort(), EXPECTED_INCOMING_FKS), "ACTUAL_TABLE_FK_SET_VETO");
  need(m.incomingReferences.filter(x => x.internalSelectedMembership && x.count === n).length === 1, "WHOLE_UNIT_SCOPE_MISMATCH:LINEAGE");
  for (const e of m.incomingReferences.filter(x => !x.internalSelectedMembership))
    need(e.count === "0", e.childTable === "engine_v3_ad_decision_snapshots_daily" ? "RETAINED_SNAPSHOT_VETO" : `RETAINED_FK_PIN_VETO:${e.childTable}`);
  need(same(m.nonFkCounts.map(x => x.pinClass).sort(), NON_FK_CLASSES), "NON_FK_INVENTORY_INCOMPLETE");
  for (const p of m.nonFkCounts) need(p.count === "0", p.pinClass === "action_lineage" ? "RETAINED_ACTION_VETO" : `RETAINED_NON_FK_VETO:${p.pinClass}`);
  need(same(m.unknownReferences, [DECLARED_CLOSURE_GAP]) && m.consumerInventorySha256 === config.consumerInventorySha256 &&
    m.providerAuthority === false && m.reclaimEligible === false, "UNKNOWN_CONSUMER_VETO");
  return { measuredKnownPinsZero: true, generalProductionClosureProved: false, generalReclaimEligible: false };
}

export async function prepareUnitRetirement(db: Q, config: UnitConfig, proofSha256: string, unitLockKey: [number, number]) {
  const selected = unitScope(config, proofSha256), g = config.generation;
  const deadline = Date.now() + 60_000, events: { sqlSha256: string; command?: string; rows?: number | null }[] = [];
  let began = false;
  const q = async (sql: string, values: unknown[] = []) => {
    need(Date.now() < deadline && events.length < 192, "FINITE_ONE_TRANSACTION");
    const r = await db.query(sql, values);
    need(r.rows.length <= 500 && Buffer.byteLength(JSON.stringify(r.rows)) <= 8 * 1024 * 1024, "UNCHANGED_BOUNDED_QUERY_RESULT");
    events.push({ sqlSha256: sha256(sql), command: r.command, rows: r.rowCount }); return r;
  };
  const exactRows = (rows: { bytes: string }[], table: keyof UnitConfig["tableHashes"]) => {
    const expected = config.tableHashes[table];
    need(rows.length === expected.rows && rows.every(x => typeof x.bytes === "string"), "EXACT_ORIGINAL_ROW_COUNT");
    const hash = rowSetHash(rows.map(x => x.bytes));
    need(hash === expected.rowByteSetSha256, "SOURCE_DRIFT_FULL_JSONB_BYTES");
    return { rows: rows.length, rowByteSetSha256: hash };
  };
  try {
    await q("BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE"); began = true;
    await q("SET LOCAL statement_timeout='7500ms'"); await q("SET LOCAL lock_timeout='1000ms'");
    await q("SET LOCAL idle_in_transaction_session_timeout='15000ms'"); await q("SET LOCAL timezone='UTC'");
    await q(`LOCK TABLE public.${CONTEXT},public.${EVAL} IN ACCESS EXCLUSIVE MODE`);
    await q(`LOCK TABLE ${NON_FK_TABLES.map(t => `public.${t}`).join(",")} IN SHARE MODE`);
    const meta = (await q(`SELECT current_setting('transaction_read_only') readonly,current_setting('transaction_isolation') isolation,current_setting('session_replication_role') replication_role,transaction_timestamp()::text observed_at,pg_try_advisory_xact_lock($1::int,$2::int) own_unit_lock`, unitLockKey)).rows[0];
    need(meta.readonly === "off" && meta.isolation === "repeatable read" && meta.replication_role === "origin" && meta.own_unit_lock === true, "ACTUAL_RW_RR_OWN_UNIT_LOCK");
    const locks = (await q(`SELECT count(*)::text n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND mode='AccessExclusiveLock' AND granted AND relation=ANY(ARRAY['public.${CONTEXT}'::regclass,'public.${EVAL}'::regclass]::oid[])`)).rows[0];
    need(locks.n === "2", "BOTH_EXACT_TARGET_TABLE_LOCKS");
    const catalog = await readTargetCatalog(async (s, a) => (await q(s, a)).rows);
    need(catalog.fingerprint === config.catalogFingerprint, "EXACT_CURRENT_DEPENDENCY_CATALOG");
    const measurement = await readUnitTransactionInventory({ query: q }, { schema: "public", generation: g,
      consumerInventorySha256: config.consumerInventorySha256, unmodeledConsumers: [DECLARED_CLOSURE_GAP] });
    const pins = pinGate(measurement, config);
    need(measurement.jobFinishedAt === config.jobFinishedAt, "SOURCE_DRIFT_JOB_RECEIPT");
    need(Date.parse(meta.observed_at) >= Date.parse(`${g.asOfDate}T00:00:00Z`) + CLOSED_DAY_BUFFER_MS, "CURRENT_DAY_VETO");
    const later = (await q(`SELECT id::text id,to_jsonb(finished_at)#>>'{}' finished FROM public.engine_v3_job_runs WHERE business_ref_id=$1::uuid AND business_id=$1::text AND as_of_date>$2::date AND engine_version=$3 AND status='success' AND job_name=$4 AND finished_at>$5::timestamptz ORDER BY as_of_date DESC,finished_at DESC,id DESC LIMIT 1`,
      [g.businessId, g.asOfDate, g.engineVersion, NATIVE_JOB, measurement.jobFinishedAt])).rows;
    need(later.length === 1 && Date.parse(later[0].finished) > Date.parse(measurement.jobFinishedAt), "SUBSEQUENT_DISTINCT_DAY_SUCCESS_REQUIRED");
    const evaluationRows: { id: string; bytes: string }[] = [];
    for (let i = 0; i < selected.evalIds.length; i += 400) evaluationRows.push(...(await q(`SELECT e.id::text id,to_jsonb(e)::text bytes FROM public.${EVAL} e WHERE e.id=ANY($1::uuid[]) ORDER BY e.id FOR UPDATE`, [selected.evalIds.slice(i, i + 400)])).rows);
    need(same(evaluationRows.map(x => x.id).sort(), selected.evalIds), "EXACT_ALL_ORIGINAL_IDS");
    const contextRows = (await q(`SELECT c.id::text id,to_jsonb(c)::text bytes FROM public.${CONTEXT} c WHERE c.id=ANY($1::uuid[]) ORDER BY c.id FOR UPDATE`, [selected.contextIds])).rows;
    need(same(contextRows.map((x: { id: string }) => x.id).sort(), selected.contextIds), "EXACT_ALL_ORIGINAL_CONTEXT_IDS");
    const originalHashes = { evaluations: exactRows(evaluationRows, EVAL), contexts: exactRows(contextRows, CONTEXT) };
    const keys = [...new Set(evaluationRows.map(x => { const r = JSON.parse(x.bytes); return JSON.stringify([r.contract_version, r.input_hash]); }))].sort();
    need(same(keys.map(x => JSON.parse(x)), config.inputKeys), "SOURCE_DRIFT_INPUT_KEYS");
    const retained = async (lock: boolean) => {
      const out: Record<string, { rows: number; rowByteSetSha256: string }> = {}, share = lock ? " FOR SHARE" : "";
      for (const [table, values] of [["engine_v3_job_runs", config.jobIds], ["engine_v3_ad_account_calibration_batches", config.batchIds],
        ["engine_v3_ad_account_calibration_daily", config.cellIds]] as const)
        out[table] = exactRows((await q(`SELECT to_jsonb(t)::text bytes FROM public.${table} t WHERE id=ANY($1::uuid[])${share}`, [values])).rows, table);
      const inputs: { bytes: string }[] = [];
      for (let i = 0; i < config.inputKeys.length; i += 400) { const page = config.inputKeys.slice(i, i + 400);
        inputs.push(...(await q(`SELECT to_jsonb(t)::text bytes FROM public.engine_v3_ad_decision_input_evidence t JOIN unnest($1::text[],$2::character(64)[]) k(contract_version,input_hash) ON t.contract_version=k.contract_version AND t.input_hash=k.input_hash${share}`,
          [page.map(k => k[0]), page.map(k => k[1])])).rows); }
      out.engine_v3_ad_decision_input_evidence = exactRows(inputs, "engine_v3_ad_decision_input_evidence");
      out.engine_v3_ad_campaign_context_objects = exactRows((await q(`SELECT to_jsonb(t)::text bytes FROM public.engine_v3_ad_campaign_context_objects t WHERE business_ref_id=$1::uuid AND payload_sha256=ANY($2::bytea[])${share}`,
        [g.businessId, config.campaignObjectHashes.map(x => Buffer.from(x.slice(2), "hex"))])).rows, "engine_v3_ad_campaign_context_objects");
      out.engine_v3_ad_decision_snapshots_daily = exactRows((await q(`SELECT to_jsonb(t)::text bytes FROM public.engine_v3_ad_decision_snapshots_daily t WHERE evaluation_id=ANY($1::uuid[])`, [selected.evalIds])).rows, "engine_v3_ad_decision_snapshots_daily");
      return out;
    };
    const before = await retained(true);
    need(same(Object.keys(before).sort(), [...RETAINED_TABLES].sort()), "ALL_RETAINED_ROOT_CLASSES");
    // Terminal NO-OP dependents of the retained original job: exactly the frozen set
    // (no new or vanished dependent since freeze), FOR SHARE, full bytes unchanged.
    const dependents = async (lock: boolean) => {
      const rows = (await q(`${DEPENDENT_ROWS_SQL}${lock ? " FOR SHARE" : ""}`, [g.jobRunId])).rows as { id: string; bytes: string }[];
      need(same(rows.map(r => r.id), config.retainedDependents.jobIds), "EXACT_RETAINED_TERMINAL_NOOP_DEPENDENTS");
      const rowByteSetSha256 = rowSetHash(rows.map(r => r.bytes));
      need(rowByteSetSha256 === config.retainedDependents.rowByteSetSha256, "RETAINED_TERMINAL_NOOP_DEPENDENT_BYTES");
      return { jobIds: rows.map(r => r.id), rows: rows.length, rowByteSetSha256 };
    };
    const dependentsBefore = await dependents(true);
    const deleted: string[] = [];
    for (let i = 0; i < selected.evalIds.length; i += 400) deleted.push(...(await q(`DELETE FROM public.${EVAL} WHERE id=ANY($1::uuid[]) AND business_ref_id=$2::uuid AND business_id=$2::text AND job_run_id=$3::uuid AND as_of_date=$4::date AND engine_version=$5 RETURNING id::text`,
      [selected.evalIds.slice(i, i + 400), g.businessId, g.jobRunId, g.asOfDate, g.engineVersion])).rows.map((x: { id: string }) => x.id));
    need(same(deleted.sort(), selected.evalIds), "EXACT_DELETE_IDS");
    const deletedContexts = (await q(`DELETE FROM public.${CONTEXT} WHERE id=ANY($1::uuid[]) AND business_ref_id=$2::uuid AND business_id=$2::text AND job_run_id=$3::uuid AND as_of_date=$4::date AND engine_version=$5 RETURNING id::text`,
      [selected.contextIds, g.businessId, g.jobRunId, g.asOfDate, g.engineVersion])).rows.map((x: { id: string }) => x.id).sort();
    need(same(deletedContexts, selected.contextIds), "EXACT_CONTEXT_DELETE_IDS");
    const after = await retained(false);
    need(same(before, after) && same(await dependents(false), dependentsBefore), "RETAINED_ROOT_BYTES_CHANGED");
    const absent = (await q(`SELECT (SELECT count(*) FROM public.${EVAL} WHERE id=ANY($1::uuid[]))::text evaluations,(SELECT count(*) FROM public.${CONTEXT} WHERE id=ANY($2::uuid[]))::text contexts,(SELECT count(*) FROM public.${CONTEXT} WHERE job_run_id=$3::uuid)::text job_contexts`,
      [selected.evalIds, selected.contextIds, g.jobRunId])).rows[0];
    need(absent.evaluations === "0" && absent.contexts === "0" && absent.job_contexts === "0", "IN_TX_EXACT_UNIT_ABSENT");
    return { preparedUncommitted: true as const, committed: false as const, observedAt: meta.observed_at as string,
      catalogFingerprint: catalog.fingerprint, pins, subsequentDistinctDay: later[0].id as string, originalHashes,
      retainedRoots: before, retainedDependents: dependentsBefore, deletedEvaluationIdsSha256: sha256(JSON.stringify(selected.evalIds)),
      deletedContextIdsSha256: sha256(JSON.stringify(selected.contextIds)), events,
      providerWrites: false as const, providerAuthority: false as const, physicalReclaimedBytes: 0 as const };
  } catch (error) {
    if (began) await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
/** Parent-side acceptance of a prepared transaction before the one COMMIT. */
export function acceptPrepared(prepared: Awaited<ReturnType<typeof prepareUnitRetirement>>, config: UnitConfig) {
  need(prepared.preparedUncommitted === true && prepared.committed === false, "ACTUAL_UNCOMMITTED_PREPARATION_REQUIRED");
  need(prepared.deletedEvaluationIdsSha256 === sha256(JSON.stringify(config.evaluationIds)) &&
    prepared.deletedContextIdsSha256 === sha256(JSON.stringify(config.contextIds)), "PREPARED_EXACT_IDS");
  for (const table of RETAINED_TABLES) need(same(prepared.retainedRoots[table], config.tableHashes[table]), "PREPARED_RETAINED_ROOTS");
  need(same(prepared.originalHashes.evaluations, config.tableHashes[EVAL]) && same(prepared.originalHashes.contexts, config.tableHashes[CONTEXT]), "PREPARED_ORIGINAL_BYTES");
  const d = config.retainedDependents;
  need(same(prepared.retainedDependents, { jobIds: d.jobIds, rows: d.rows, rowByteSetSha256: d.rowByteSetSha256 }), "PREPARED_RETAINED_DEPENDENTS");
  return true;
}
