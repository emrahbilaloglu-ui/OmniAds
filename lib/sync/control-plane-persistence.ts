import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  selectLatestSyncGateRecords,
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

function mapGateRows(
  rows: Array<Record<string, unknown>>,
  providerScope: string,
): SyncGateIdentityMap {
  const selected = selectLatestSyncGateRecords(
    rows.map((row) => mapGateRowToRecord(row)),
    { providerScope },
  );
  return {
    deployGate: toGateIdentity(selected.deployGate),
    releaseGate: toGateIdentity(selected.releaseGate),
  };
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

  const [exactGateRows, fallbackGateRows, latestGateRows, exactRepairRows, fallbackRepairRows, latestRepairRows] =
    await Promise.all([
      sql`
        SELECT id, build_id, environment, gate_kind, verdict, emitted_at
        , gate_scope, mode, base_result, blocker_class, summary, break_glass, override_reason, evidence_json
        FROM sync_release_gates
        WHERE build_id = ${identity.buildId}
          AND environment = ${identity.environment}
        ORDER BY emitted_at DESC
        LIMIT 100
      ` as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT id, build_id, environment, gate_kind, verdict, emitted_at
        , gate_scope, mode, base_result, blocker_class, summary, break_glass, override_reason, evidence_json
        FROM sync_release_gates
        WHERE build_id = ${identity.buildId}
        ORDER BY emitted_at DESC
        LIMIT 100
      ` as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT
          id, build_id, environment, gate_kind, verdict, emitted_at,
          gate_scope, mode, base_result, blocker_class, summary, break_glass, override_reason, evidence_json
        FROM sync_release_gates
        ORDER BY emitted_at DESC
        LIMIT 100
      ` as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT id, build_id, environment, provider_scope, eligible, emitted_at
        FROM sync_repair_plans
        WHERE build_id = ${identity.buildId}
          AND environment = ${identity.environment}
          AND provider_scope = ${identity.providerScope}
        ORDER BY emitted_at DESC
        LIMIT 1
      ` as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT id, build_id, environment, provider_scope, eligible, emitted_at
        FROM sync_repair_plans
        WHERE build_id = ${identity.buildId}
          AND provider_scope = ${identity.providerScope}
        ORDER BY emitted_at DESC
        LIMIT 1
      ` as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT id, build_id, environment, provider_scope, eligible, emitted_at
        FROM sync_repair_plans
        WHERE provider_scope = ${identity.providerScope}
        ORDER BY emitted_at DESC
        LIMIT 1
      ` as Promise<Array<Record<string, unknown>>>,
    ]);

  const exact = {
    ...mapGateRows(exactGateRows, identity.providerScope),
    repairPlan: mapRepairPlanRow(exactRepairRows[0]),
  };
  const fallbackByBuild = {
    ...mapGateRows(fallbackGateRows, identity.providerScope),
    repairPlan: mapRepairPlanRow(fallbackRepairRows[0]),
  };
  const latest = {
    ...mapGateRows(latestGateRows, identity.providerScope),
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
