import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  resolveSyncGateReadProviderScope,
  type SyncGateRecord,
} from "@/lib/sync/release-gates";
import {
  resolveSyncControlPlaneKey,
  type SyncControlPlaneKey,
} from "@/lib/sync/control-plane-key";

type SyncGateIdentity = {
  id: string;
  buildId: string;
  environment: string;
  gateKind: "deploy_gate" | "release_gate";
  verdict: string | null;
  emittedAt: string | null;
};

type SyncRepairPlanIdentity = {
  id: string;
  buildId: string;
  environment: string;
  providerScope: string;
  eligible: boolean | null;
  emittedAt: string | null;
};

type SyncGateIdentityMap = {
  deployGate: SyncGateIdentity | null;
  releaseGate: SyncGateIdentity | null;
};

export interface SyncControlPlanePersistenceStatus {
  identity: SyncControlPlaneKey;
  exact: SyncGateIdentityMap & {
    repairPlan: SyncRepairPlanIdentity | null;
  };
  fallbackByBuild: SyncGateIdentityMap & {
    repairPlan: SyncRepairPlanIdentity | null;
  };
  latest: SyncGateIdentityMap & {
    repairPlan: SyncRepairPlanIdentity | null;
  };
  missingExact: Array<"deployGate" | "releaseGate" | "repairPlan">;
  exactRowsPresent: boolean;
}

async function assertControlPlaneTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: ["sync_release_gates", "sync_repair_plans"],
    context,
  });
}

function toIso(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function mapGateRowToRecord(row: Record<string, unknown>): SyncGateRecord {
  return {
    id: String(row.id),
    gateKind: row.gate_kind === "release_gate" ? "release_gate" : "deploy_gate",
    gateScope:
      row.gate_scope === "runtime_contract"
        ? "runtime_contract"
        : row.gate_scope === "service_liveness"
          ? "service_liveness"
          : "release_readiness",
    buildId: String(row.build_id),
    environment: String(row.environment),
    mode: row.mode === "warn_only" ? "warn_only" : row.mode === "block" ? "block" : "measure_only",
    baseResult:
      row.base_result === "misconfigured"
        ? "misconfigured"
        : row.base_result === "pass"
          ? "pass"
          : "fail",
    verdict:
      row.verdict === "pass" ||
      row.verdict === "fail" ||
      row.verdict === "misconfigured" ||
      row.verdict === "measure_only" ||
      row.verdict === "warn_only" ||
      row.verdict === "blocked"
        ? row.verdict
        : "fail",
    blockerClass: typeof row.blocker_class === "string" ? (row.blocker_class as SyncGateRecord["blockerClass"]) : null,
    summary: typeof row.summary === "string" ? row.summary : "",
    breakGlass: Boolean(row.break_glass),
    overrideReason: typeof row.override_reason === "string" ? row.override_reason : null,
    evidence:
      row.evidence_json && typeof row.evidence_json === "object"
        ? (row.evidence_json as Record<string, unknown>)
        : {},
    emittedAt: toIso(row.emitted_at) ?? new Date(0).toISOString(),
  };
}

function toGateIdentity(record: SyncGateRecord | null): SyncGateIdentity | null {
  if (!record?.id) return null;
  return {
    id: record.id,
    buildId: record.buildId,
    environment: record.environment,
    gateKind: record.gateKind,
    verdict: record.verdict,
    emittedAt: record.emittedAt,
  };
}

/**
 * One gate row for exactly one key.
 *
 * `buildId: null` means "newest for this kind, scope and environment", which is
 * the diagnostic the previous unkeyed `LIMIT 100` scan was trying to answer. It
 * is served by `idx_sync_release_gates_kind_latest`, whose leading columns are
 * `(gate_kind, provider_scope, environment)` exactly so that this predicate is a
 * prefix rather than a filter applied while walking history.
 *
 * `environment` is never optional. Every tier here — exact, build fallback and
 * global-latest — constrains it, so a staging evaluation cannot be reported as
 * this production process's control-plane state. The build fallback constrains
 * it to the literal `'unknown'`, which is what an emitter that could not
 * determine an environment writes; it is not "any environment".
 */
async function readKeyedGateRow(
  sql: ReturnType<typeof getDb>,
  input: {
    buildId: string | null;
    environment: string;
    gateKind: "deploy_gate" | "release_gate";
    providerScope: string;
  },
): Promise<SyncGateRecord | null> {
  const columns = `id, build_id, environment, gate_kind, verdict, emitted_at,
    gate_scope, mode, base_result, blocker_class, summary, break_glass,
    override_reason, evidence_json`;
  const predicates: string[] = [
    "gate_kind = $1",
    "provider_scope = $2",
    "environment = $3",
  ];
  const values: unknown[] = [input.gateKind, input.providerScope, input.environment];
  if (input.buildId != null) {
    values.push(input.buildId);
    predicates.push(`build_id = $${values.length}`);
  }
  const rows = (await sql.query(
    `SELECT ${columns}
     FROM sync_release_gates
     WHERE ${predicates.join(" AND ")}
     ORDER BY emitted_at DESC, id DESC
     LIMIT 1`,
    values,
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  return row ? mapGateRowToRecord(row) : null;
}

function mapRepairPlanRow(row: Record<string, unknown> | undefined): SyncRepairPlanIdentity | null {
  if (!row) return null;
  return {
    id: String(row.id),
    buildId: String(row.build_id),
    environment: String(row.environment),
    providerScope: String(row.provider_scope),
    eligible: typeof row.eligible === "boolean" ? row.eligible : row.eligible == null ? null : Boolean(row.eligible),
    emittedAt: toIso(row.emitted_at),
  };
}

export async function getSyncControlPlanePersistenceStatus(input?: {
  buildId?: string;
  environment?: string;
  providerScope?: string;
}): Promise<SyncControlPlanePersistenceStatus> {
  await assertControlPlaneTablesReady("sync_control_plane_persistence:get_status");
  const sql = getDb();
  const identity = resolveSyncControlPlaneKey(input);

  // Eight keyed LIMIT 1 reads.
  //
  // These were three `LIMIT 100` gate scans — including one with NO key
  // predicate at all, which read the hundred globally newest rows of a
  // multi-gigabyte table on every /build-info request — followed by a
  // pick-the-first-of-each-kind in JavaScript. `LIMIT 100` is not a bound on
  // work: the planner still had to order the matching set to find the first
  // hundred. Each read below is keyed on exactly what it answers and returns at
  // most one row, with the same `emitted_at DESC, id DESC` tie-break the index
  // carries so two readers cannot disagree about the current verdict.
  // A deploy gate is a property of the DEPLOYMENT, not of a provider. Reading it
  // under `identity.providerScope` meant the Google control plane asked for
  // `google_ads` and found no deploy gate at all — reported as "missing", which
  // reads identically to "never evaluated".
  const deployScope = resolveSyncGateReadProviderScope({ gateKind: "deploy_gate" });
  const releaseScope = resolveSyncGateReadProviderScope({
    gateKind: "release_gate",
    providerScope: identity.providerScope,
  });
  const UNKNOWN_ENVIRONMENT = "unknown";

  const [
    exactDeploy,
    exactRelease,
    fallbackDeploy,
    fallbackRelease,
    latestDeploy,
    latestRelease,
    exactRepairRows,
    fallbackRepairRows,
    latestRepairRows,
  ] = await Promise.all([
    readKeyedGateRow(sql, {
      buildId: identity.buildId,
      environment: identity.environment,
      gateKind: "deploy_gate",
      providerScope: deployScope,
    }),
    readKeyedGateRow(sql, {
      buildId: identity.buildId,
      environment: identity.environment,
      gateKind: "release_gate",
      providerScope: releaseScope,
    }),
    readKeyedGateRow(sql, {
      buildId: identity.buildId,
      environment: UNKNOWN_ENVIRONMENT,
      gateKind: "deploy_gate",
      providerScope: deployScope,
    }),
    readKeyedGateRow(sql, {
      buildId: identity.buildId,
      environment: UNKNOWN_ENVIRONMENT,
      gateKind: "release_gate",
      providerScope: releaseScope,
    }),
    readKeyedGateRow(sql, {
      buildId: null,
      environment: identity.environment,
      gateKind: "deploy_gate",
      providerScope: deployScope,
    }),
    readKeyedGateRow(sql, {
      buildId: null,
      environment: identity.environment,
      gateKind: "release_gate",
      providerScope: releaseScope,
    }),
    sql`
      SELECT id, build_id, environment, provider_scope, eligible, emitted_at
      FROM sync_repair_plans
      WHERE build_id = ${identity.buildId}
        AND environment = ${identity.environment}
        AND provider_scope = ${identity.providerScope}
      ORDER BY emitted_at DESC, id DESC
      LIMIT 1
    ` as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT id, build_id, environment, provider_scope, eligible, emitted_at
      FROM sync_repair_plans
      WHERE build_id = ${identity.buildId}
        AND environment = ${UNKNOWN_ENVIRONMENT}
        AND provider_scope = ${identity.providerScope}
      ORDER BY emitted_at DESC, id DESC
      LIMIT 1
    ` as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT id, build_id, environment, provider_scope, eligible, emitted_at
      FROM sync_repair_plans
      WHERE provider_scope = ${identity.providerScope}
        AND environment = ${identity.environment}
      ORDER BY emitted_at DESC, id DESC
      LIMIT 1
    ` as Promise<Array<Record<string, unknown>>>,
  ]);

  const exact = {
    deployGate: toGateIdentity(exactDeploy),
    releaseGate: toGateIdentity(exactRelease),
    repairPlan: mapRepairPlanRow(exactRepairRows[0]),
  };
  const fallbackByBuild = {
    deployGate: toGateIdentity(fallbackDeploy),
    releaseGate: toGateIdentity(fallbackRelease),
    repairPlan: mapRepairPlanRow(fallbackRepairRows[0]),
  };
  const latest = {
    deployGate: toGateIdentity(latestDeploy),
    releaseGate: toGateIdentity(latestRelease),
    repairPlan: mapRepairPlanRow(latestRepairRows[0]),
  };
  const missingExact = ([
    !exact.deployGate ? "deployGate" : null,
    !exact.releaseGate ? "releaseGate" : null,
    !exact.repairPlan ? "repairPlan" : null,
  ].filter(Boolean) as Array<"deployGate" | "releaseGate" | "repairPlan">);

  return {
    identity,
    exact,
    fallbackByBuild,
    latest,
    missingExact,
    exactRowsPresent: missingExact.length === 0,
  };
}
