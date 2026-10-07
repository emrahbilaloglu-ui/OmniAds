import { CONTEXT, EVAL, INPUT, canonical, canonicalSha, need, same, SHA, UUID } from "./common";
import { independentReadback } from "./maintenance";
import type { Q, UnitConfig } from "./capture";

/** D149 settlement of a LOST post-retirement maintenance ACK. A bounded, SELECT-only collector proves, at one DB
 * instant, that the purpose's unacknowledged maintenance SQL cannot still be in flight. It binds the exact
 * purpose/plan/journal head/consumed marker/unacknowledged stage and every retired unit's frozen config to the
 * declared target database, then reads:
 * - every unit again through the reviewed independent readback (its own READ ONLY snapshot, ROLLBACK);
 * - in ONE READ ONLY REPEATABLE READ snapshot with the original 7.5 s statement / 1 s lock limits: database
 *   identity, full backend visibility, no operator (`nsb-*`) backend, no maintenance verb in a client backend,
 *   no vacuum/analyze/cluster/index progress and no maintenance-mode lock on the purpose's vacuum targets (the
 *   two target tables; plus input evidence for a v3 purpose), their TOAST relations or indexes. That snapshot ends
 *   with an acknowledged ROLLBACK.
 * The proof never claims the original SQL succeeded and never permits a retry. Nothing here runs at import. */
export const SETTLEMENT_CONTRACT = "native-finite-maintenance-settlement.v1" as const;
export const SETTLEMENT_APPLICATION = "nsb-maintenance-settlement" as const;
export const SETTLEMENT_MAX_AGE_MS = 10 * 60_000;
export const CLOCK_SKEW_MS = 60_000;
const MAINTENANCE_STAGES = ["vacuum-main", "toast-observation", "vacuum-toast", "space-readback"];
const PLAN_CONTRACTS = ["finite-native-storage-batch.v1", "finite-native-storage-batch.v2", "finite-native-storage-batch.v3"];
/** The relations the purpose's own vacuum-main touched: v3 (D150) adds input evidence; v1/v2 exactly the two targets. */
export const settlementRelations = (planContract: string) =>
  planContract === "finite-native-storage-batch.v3" ? [EVAL, CONTEXT, INPUT] : [EVAL, CONTEXT];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/, REVISION = /^[a-f0-9]{40}$/, PURPOSE = /^[a-f0-9]{12}$/;

/** A canonical millisecond UTC instant (exactly what Date#toISOString emits). */
export const isInstant = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
const exactKeys = (value: unknown, keys: string[], code: string) => {
  need(value !== null && typeof value === "object" && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort()), code);
  return value as Record<string, any>;
};
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export interface SettlementBinding {
  purpose: string; planDigest: string; planContract: string;
  unacknowledged: { stage: string; jobRunIds: string[]; sequence: number };
  journalRecords: number; journalHeadSha256: string; journalFinishedAt: string; markerSha256: string;
  units: { jobRunId: string; originalProofSha256: string }[];
  expectedDatabase: string; operatorRevision: string; runtimeRevision: string; sourceManifestSha256: string;
}
const BINDING_KEYS = ["purpose", "planDigest", "planContract", "unacknowledged", "journalRecords", "journalHeadSha256", "journalFinishedAt",
  "markerSha256", "units", "expectedDatabase", "operatorRevision", "runtimeRevision", "sourceManifestSha256"];
export function checkSettlementBinding(value: unknown): SettlementBinding {
  const b = exactKeys(value, BINDING_KEYS, "SETTLEMENT_BINDING_SHAPE");
  const u = exactKeys(b.unacknowledged, ["stage", "jobRunIds", "sequence"], "SETTLEMENT_BINDING_SHAPE");
  need(PURPOSE.test(b.purpose) && SHA.test(b.planDigest) && PLAN_CONTRACTS.includes(b.planContract) && MAINTENANCE_STAGES.includes(u.stage) &&
    Array.isArray(u.jobRunIds) && u.jobRunIds.length >= 1 && u.jobRunIds.every((j: unknown) => typeof j === "string" && UUID.test(j)) &&
    Number.isSafeInteger(u.sequence) && u.sequence > 1 && Number.isSafeInteger(b.journalRecords) && b.journalRecords > u.sequence &&
    SHA.test(b.journalHeadSha256) && isInstant(b.journalFinishedAt) && SHA.test(b.markerSha256) && Array.isArray(b.units) &&
    b.units.length >= 1 && b.units.length <= 8 && IDENT.test(b.expectedDatabase) && REVISION.test(b.operatorRevision) &&
    REVISION.test(b.runtimeRevision) && SHA.test(b.sourceManifestSha256), "SETTLEMENT_BINDING_INVALID");
  for (const x of b.units) {
    const unit = exactKeys(x, ["jobRunId", "originalProofSha256"], "SETTLEMENT_BINDING_SHAPE");
    need(UUID.test(unit.jobRunId) && SHA.test(unit.originalProofSha256), "SETTLEMENT_BINDING_INVALID");
  }
  need(new Set(b.units.map((x: { jobRunId: string }) => x.jobRunId)).size === b.units.length, "SETTLEMENT_BINDING_INVALID");
  return b as SettlementBinding;
}

/** The collector. `db` is a connection to the declared target database; it must only ever read. */
export async function collectMaintenanceSettlement(db: Q, binding: SettlementBinding, configs: UnitConfig[], clock: () => number = Date.now) {
  checkSettlementBinding(binding);
  need(configs.length === binding.units.length && configs.every((c, i) => c?.generation?.jobRunId === binding.units[i]!.jobRunId &&
    canonicalSha(c) === binding.units[i]!.originalProofSha256), "FROZEN_UNIT_CONFIG_BINDING");
  // Independent retirement facts: the reviewed readback returns only after its own ROLLBACK resolved.
  const units: { jobRunId: string; exactUnitAbsent: boolean; retainedRootsFullBytesMatch: boolean; readbackRollbackAcknowledged: true }[] = [];
  for (const c of configs) {
    const r = await independentReadback(db, c);
    units.push({ jobRunId: c.generation.jobRunId, exactUnitAbsent: r.exactUnitAbsent === true,
      retainedRootsFullBytesMatch: r.retainedRootsFullBytesMatch === true, readbackRollbackAcknowledged: true });
  }
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let facts: Record<string, any>;
  try {
    await db.query("SET LOCAL statement_timeout='7500ms'"); await db.query("SET LOCAL lock_timeout='1000ms'"); await db.query("SET LOCAL timezone='UTC'");
    const id = (await db.query(`SELECT current_database() d,current_user u,session_user s,current_setting('transaction_read_only') ro,
        current_setting('transaction_isolation') iso,current_setting('statement_timeout') st,current_setting('lock_timeout') lt,
        to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') observed,
        to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') postmaster,
        pg_backend_pid() pid,current_setting('server_version_num')::int v,
        coalesce((SELECT rolsuper FROM pg_roles WHERE rolname=current_user),false) su,pg_has_role(current_user,'pg_read_all_stats','USAGE') stats,
        has_function_privilege('pg_control_system()','EXECUTE') ctl`)).rows[0];
    // Nothing else is read unless this is an actual read-only transaction.
    need(id.ro === "on", "READ_ONLY_TRANSACTION_REQUIRED");
    const systemIdentifier = id.ctl ? String((await db.query("SELECT system_identifier::text v FROM pg_control_system()")).rows[0].v) : null;
    const rel = (await db.query(`WITH m AS (SELECT c.oid,c.reltoastrelid t FROM pg_class c WHERE c.oid=ANY(ARRAY(SELECT to_regclass('public.'||x) FROM unnest($1::text[]) x))),
        r AS (SELECT oid FROM m UNION SELECT t FROM m WHERE t<>0),
        x AS (SELECT oid FROM r UNION SELECT i.indexrelid FROM pg_index i WHERE i.indrelid IN (SELECT oid FROM r))
      SELECT (SELECT count(*) FROM m)::int main,coalesce(array_agg(oid::bigint ORDER BY oid),'{}') oids FROM x`, [settlementRelations(binding.planContract)])).rows[0];
    const oids = (rel.oids as (string | number)[]).map(Number);
    const backends = (await db.query(`SELECT count(*)::int visible,
        count(*) FILTER (WHERE query='<insufficient privilege>')::int insufficient,
        count(*) FILTER (WHERE application_name LIKE 'nsb-%')::int owned,
        count(*) FILTER (WHERE backend_type='client backend' AND state IS DISTINCT FROM 'idle'
          AND query ~* '\\m(vacuum|analyze|cluster|reindex)\\M')::int maintenance
      FROM pg_stat_activity WHERE pid IS DISTINCT FROM pg_backend_pid()`)).rows[0];
    const progress = (await db.query(`SELECT ((SELECT count(*) FROM pg_stat_progress_vacuum WHERE relid=ANY($1::oid[]))
        +(SELECT count(*) FROM pg_stat_progress_analyze WHERE relid=ANY($1::oid[]))
        +(SELECT count(*) FROM pg_stat_progress_cluster WHERE relid=ANY($1::oid[]))
        +(SELECT count(*) FROM pg_stat_progress_create_index WHERE relid=ANY($1::oid[])))::int n`, [oids])).rows[0].n;
    const locks = (await db.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype='relation' AND relation=ANY($1::oid[])
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND pid IS DISTINCT FROM pg_backend_pid()
        AND mode IN ('ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')`, [oids])).rows[0].n;
    facts = { id, systemIdentifier, rel: { main: rel.main as number, oids }, backends, progress: progress as number, locks: locks as number };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  const rollback = await db.query("ROLLBACK");
  need(rollback.command === "ROLLBACK", "ROLLBACK_ACK_REQUIRED");
  const { id, systemIdentifier, rel, backends } = facts;
  return {
    contract: SETTLEMENT_CONTRACT, binding,
    collector: { application: SETTLEMENT_APPLICATION, collectedAt: new Date(clock()).toISOString() },
    database: { name: id.d as string, user: id.u as string, sessionUser: id.s as string, superuser: id.su === true, readAllStats: id.stats === true,
      serverVersionNum: Number(id.v), systemIdentifier, postmasterStartedAt: id.postmaster as string, backendPid: Number(id.pid) },
    transaction: { readOnly: id.ro as string, isolation: id.iso as string, statementTimeout: id.st as string, lockTimeout: id.lt as string,
      observedAt: id.observed as string, rollbackAcknowledged: true },
    visibility: { fullBackendVisibility: id.su === true || id.stats === true, visibleBackends: backends.visible as number,
      insufficientPrivilegeBackends: backends.insufficient as number },
    targets: { mainRelations: rel.main, relationOids: rel.oids },
    backends: { ownedOperatorBackends: backends.owned as number, maintenanceQueryBackends: backends.maintenance as number,
      maintenanceProgressRows: facts.progress, maintenanceModeTargetLocks: facts.locks },
    units, actualExitCode: 0 as const, errors: [] as string[],
  };
}
export type SettlementProof = Awaited<ReturnType<typeof collectMaintenanceSettlement>>;

/** Fail-closed verification of a settlement proof against the binding derived from the local journal at `atMs`. */
export function verifyMaintenanceSettlement(value: unknown, expected: SettlementBinding, atMs: number): SettlementProof {
  checkSettlementBinding(expected);
  const p = exactKeys(value, ["contract", "binding", "collector", "database", "transaction", "visibility", "targets", "backends", "units", "actualExitCode", "errors"],
    "SETTLEMENT_PROOF_SHAPE");
  need(p.contract === SETTLEMENT_CONTRACT, "SETTLEMENT_PROOF_SHAPE");
  need(canonical(checkSettlementBinding(p.binding)) === canonical(expected), "SETTLEMENT_BINDING_MISMATCH");
  const c = exactKeys(p.collector, ["application", "collectedAt"], "SETTLEMENT_PROOF_SHAPE");
  const d = exactKeys(p.database, ["name", "user", "sessionUser", "superuser", "readAllStats", "serverVersionNum", "systemIdentifier", "postmasterStartedAt",
    "backendPid"], "SETTLEMENT_PROOF_SHAPE");
  const t = exactKeys(p.transaction, ["readOnly", "isolation", "statementTimeout", "lockTimeout", "observedAt", "rollbackAcknowledged"], "SETTLEMENT_PROOF_SHAPE");
  const v = exactKeys(p.visibility, ["fullBackendVisibility", "visibleBackends", "insufficientPrivilegeBackends"], "SETTLEMENT_PROOF_SHAPE");
  const g = exactKeys(p.targets, ["mainRelations", "relationOids"], "SETTLEMENT_PROOF_SHAPE");
  const b = exactKeys(p.backends, ["ownedOperatorBackends", "maintenanceQueryBackends", "maintenanceProgressRows", "maintenanceModeTargetLocks"],
    "SETTLEMENT_PROOF_SHAPE");
  need(c.application === SETTLEMENT_APPLICATION && isInstant(c.collectedAt) && typeof d.name === "string" && IDENT.test(d.user) && IDENT.test(d.sessionUser) &&
    typeof d.superuser === "boolean" && typeof d.readAllStats === "boolean" && Number.isSafeInteger(d.serverVersionNum) && d.serverVersionNum >= 100000 &&
    (d.systemIdentifier === null || /^\d{1,20}$/.test(d.systemIdentifier)) && isInstant(d.postmasterStartedAt) && Number.isSafeInteger(d.backendPid) &&
    d.backendPid > 0 && typeof v.fullBackendVisibility === "boolean" && count(v.visibleBackends) && count(v.insufficientPrivilegeBackends) &&
    Number.isSafeInteger(g.mainRelations) && Array.isArray(g.relationOids) && g.relationOids.every((o: unknown) => Number.isSafeInteger(o) && (o as number) > 0) &&
    Object.values(b).every(count) && Array.isArray(p.errors), "SETTLEMENT_PROOF_MALFORMED");
  need(d.name === expected.expectedDatabase, "SETTLEMENT_WRONG_DATABASE");
  need(t.readOnly === "on" && t.isolation === "repeatable read" && t.statementTimeout === "7500ms" && t.lockTimeout === "1s", "READ_ONLY_TRANSACTION_REQUIRED");
  need(t.rollbackAcknowledged === true, "ROLLBACK_ACK_REQUIRED");
  need(p.actualExitCode === 0 && p.errors.length === 0, "SETTLEMENT_COLLECTOR_NOT_EXIT_ZERO");
  need(v.fullBackendVisibility === true && v.fullBackendVisibility === (d.superuser || d.readAllStats), "BACKEND_VISIBILITY_UNAVAILABLE");
  need(v.insufficientPrivilegeBackends === 0, "BACKEND_VISIBILITY_AMBIGUOUS");
  const targets = settlementRelations(expected.planContract).length;
  need(g.mainRelations === targets && g.relationOids.length >= targets, "SETTLEMENT_TARGET_RELATIONS");
  need(b.ownedOperatorBackends === 0, "OWNED_OPERATOR_BACKEND_PRESENT");
  need(b.maintenanceQueryBackends === 0, "MAINTENANCE_BACKEND_ACTIVE");
  need(b.maintenanceProgressRows === 0, "MAINTENANCE_PROGRESS_ON_TARGET");
  need(b.maintenanceModeTargetLocks === 0, "TARGET_MAINTENANCE_LOCK_PRESENT");
  need(Array.isArray(p.units) && p.units.length === expected.units.length, "SETTLEMENT_UNITS_MISMATCH");
  p.units.forEach((x: unknown, i: number) => {
    const u = exactKeys(x, ["jobRunId", "exactUnitAbsent", "retainedRootsFullBytesMatch", "readbackRollbackAcknowledged"], "SETTLEMENT_PROOF_SHAPE");
    need(u.jobRunId === expected.units[i]!.jobRunId, "SETTLEMENT_UNITS_MISMATCH");
    need(u.exactUnitAbsent === true, "RETIREMENT_NOT_INDEPENDENTLY_OBSERVED");
    need(u.retainedRootsFullBytesMatch === true, "RETAINED_ROOTS_NOT_BYTE_EQUAL");
    need(u.readbackRollbackAcknowledged === true, "ROLLBACK_ACK_REQUIRED");
  });
  need(isInstant(t.observedAt), "SETTLEMENT_PROOF_MALFORMED");
  const observed = Date.parse(t.observedAt);
  need(observed > Date.parse(expected.journalFinishedAt), "EVIDENCE_MUST_POSTDATE_JOURNAL_END");
  need(Math.abs(observed - Date.parse(c.collectedAt)) <= CLOCK_SKEW_MS, "COLLECTOR_CLOCK_SKEW");
  need(observed <= atMs + CLOCK_SKEW_MS, "FUTURE_EVIDENCE");
  need(atMs - observed <= SETTLEMENT_MAX_AGE_MS, "STALE_EVIDENCE");
  return p as SettlementProof;
}
