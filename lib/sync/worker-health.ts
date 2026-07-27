import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  buildRuntimeContract,
  upsertRuntimeContractInstance,
} from "@/lib/sync/runtime-contract";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import type {
  ProviderReclaimDisposition,
  ProviderReclaimReasonCode,
} from "@/lib/sync/provider-orchestration";

async function assertSyncWorkerHealthTablesReady(
  tables: string[],
  context: string,
) {
  await assertDbSchemaReady({
    tables,
    context,
  });
}

function normalizeTimestamp(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return text;
}

function normalizeMetaJson(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getMetaBusinessIds(metaJson: Record<string, unknown> | null) {
  const ids = new Set<string>();
  const currentBusinessId = metaJson?.currentBusinessId;
  if (typeof currentBusinessId === "string" && currentBusinessId.trim()) {
    ids.add(currentBusinessId.trim());
  }
  const batchBusinessIds = metaJson?.batchBusinessIds;
  if (Array.isArray(batchBusinessIds)) {
    for (const entry of batchBusinessIds) {
      if (typeof entry === "string" && entry.trim()) ids.add(entry.trim());
    }
  }
  return Array.from(ids);
}

export function selectProviderWorkerForBusiness(input: {
  businessId: string;
  activeLeaseOwner?: string | null;
  workers?: Array<{
    workerId: string;
    workerFreshnessState?: "online" | "stale" | "stopped";
    lastHeartbeatAt?: string | null;
    lastBusinessId: string | null;
    lastConsumedBusinessId?: string | null;
    metaJson?: Record<string, unknown> | null;
  }>;
}) {
  const workers = input.workers ?? [];
  return (
    workers.find(
      (worker) =>
        worker.workerId === (input.activeLeaseOwner ?? "") ||
        worker.workerId.startsWith(`${input.activeLeaseOwner ?? ""}:`)
    ) ??
    workers.find((worker) => worker.lastConsumedBusinessId === input.businessId) ??
    workers.find((worker) => worker.lastBusinessId === input.businessId) ??
    workers.find((worker) => getMetaBusinessIds(worker.metaJson ?? null).includes(input.businessId)) ??
    null
  );
}

export function selectLatestWorkerForProviderScope(input: {
  providerScope: string;
  workers?: Array<{
    workerId: string;
    workerFreshnessState?: "online" | "stale" | "stopped";
    lastHeartbeatAt?: string | null;
    providerScope?: string | null;
    metaJson?: Record<string, unknown> | null;
  }>;
}) {
  const workers = (input.workers ?? []).filter(
    (worker) => String(worker.providerScope ?? "") === input.providerScope,
  );
  return (
    [...workers].sort((left, right) => {
      const leftHeartbeat = normalizeTimestamp(left.lastHeartbeatAt ?? null);
      const rightHeartbeat = normalizeTimestamp(right.lastHeartbeatAt ?? null);
      const leftMs = leftHeartbeat ? new Date(leftHeartbeat).getTime() : 0;
      const rightMs = rightHeartbeat ? new Date(rightHeartbeat).getTime() : 0;
      return rightMs - leftMs;
    })[0] ?? null
  );
}

export function getProviderScopeWorkerObservation(input: {
  providerScope: string;
  staleThresholdMs: number;
  nowMs?: number;
  workers?: Array<{
    workerId: string;
    workerFreshnessState?: "online" | "stale" | "stopped";
    lastHeartbeatAt?: string | null;
    providerScope?: string | null;
    metaJson?: Record<string, unknown> | null;
  }>;
}) {
  const matchingWorker = selectLatestWorkerForProviderScope({
    providerScope: input.providerScope,
    workers: input.workers,
  });
  const lastHeartbeatAt = normalizeTimestamp(matchingWorker?.lastHeartbeatAt ?? null);
  const nowMs = input.nowMs ?? Date.now();
  const heartbeatAgeMs =
    lastHeartbeatAt != null
      ? Math.max(0, nowMs - new Date(lastHeartbeatAt).getTime())
      : null;
  const hasFreshHeartbeat =
    matchingWorker?.workerFreshnessState === "online" ||
    (heartbeatAgeMs != null &&
      heartbeatAgeMs <= Math.max(1, input.staleThresholdMs));

  return {
    workerId: matchingWorker?.workerId ?? null,
    workerFreshnessState: matchingWorker?.workerFreshnessState ?? null,
    lastHeartbeatAt,
    heartbeatAgeMs,
    hasFreshHeartbeat,
    metaJson: matchingWorker?.metaJson ?? null,
  };
}

export function getProviderBusinessWorkerObservation(input: {
  businessId: string;
  activeLeaseOwner?: string | null;
  staleThresholdMs: number;
  nowMs?: number;
  workers?: Array<{
    workerId: string;
    workerFreshnessState?: "online" | "stale" | "stopped";
    lastHeartbeatAt?: string | null;
    lastBusinessId: string | null;
    lastConsumedBusinessId?: string | null;
    metaJson?: Record<string, unknown> | null;
  }>;
}) {
  const matchingWorker = selectProviderWorkerForBusiness({
    businessId: input.businessId,
    activeLeaseOwner: input.activeLeaseOwner ?? null,
    workers: input.workers,
  });
  const lastHeartbeatAt = normalizeTimestamp(matchingWorker?.lastHeartbeatAt ?? null);
  const nowMs = input.nowMs ?? Date.now();
  const heartbeatAgeMs =
    lastHeartbeatAt != null
      ? Math.max(0, nowMs - new Date(lastHeartbeatAt).getTime())
      : null;
  const hasFreshHeartbeat =
    matchingWorker?.workerFreshnessState === "online" ||
    (heartbeatAgeMs != null &&
      heartbeatAgeMs <= Math.max(1, input.staleThresholdMs));
  const currentBusinessId =
    matchingWorker?.metaJson &&
    typeof matchingWorker.metaJson.currentBusinessId === "string" &&
    matchingWorker.metaJson.currentBusinessId.trim().length > 0
      ? matchingWorker.metaJson.currentBusinessId.trim()
      : matchingWorker?.lastConsumedBusinessId ?? null;

  return {
    workerId: matchingWorker?.workerId ?? null,
    workerFreshnessState: matchingWorker?.workerFreshnessState ?? null,
    lastHeartbeatAt,
    heartbeatAgeMs,
    hasFreshHeartbeat,
    currentBusinessId,
    lastConsumedBusinessId: matchingWorker?.lastConsumedBusinessId ?? null,
    consumeStage:
      matchingWorker?.metaJson &&
      typeof matchingWorker.metaJson.consumeStage === "string"
        ? matchingWorker.metaJson.consumeStage
        : null,
    batchBusinessIds: getMetaBusinessIds(matchingWorker?.metaJson ?? null),
    metaJson: matchingWorker?.metaJson ?? null,
  };
}

export async function heartbeatSyncWorker(input: {
  workerId: string;
  instanceType: string;
  providerScope: string;
  status: "starting" | "idle" | "running" | "stopping" | "stopped" | "disabled";
  lastBusinessId?: string | null;
  lastPartitionId?: string | null;
  metaJson?: Record<string, unknown>;
}) {
  await assertSyncWorkerHealthTablesReady(
    ["sync_worker_heartbeats"],
    "sync_worker_health:heartbeat",
  );
  const runtimeContract = buildRuntimeContract({
    service: "worker",
    instanceId: input.workerId,
  });
  const sql = getDb();
  await sql`
    INSERT INTO sync_worker_heartbeats (
      worker_id,
      instance_type,
      provider_scope,
      status,
      last_heartbeat_at,
      last_business_id,
      last_partition_id,
      meta_json,
      updated_at
    )
    VALUES (
      ${input.workerId},
      ${input.instanceType},
      ${input.providerScope},
      ${input.status},
      now(),
      ${input.lastBusinessId ?? null},
      ${input.lastPartitionId ?? null},
      ${JSON.stringify({
        ...(input.metaJson ?? {}),
        runtimeContract: {
          buildId: runtimeContract.buildId,
          dbFingerprint: runtimeContract.dbFingerprint,
          configFingerprint: runtimeContract.configFingerprint,
          validationPass: runtimeContract.validation.pass,
          issueCodes: runtimeContract.validation.issues.map((issue) => issue.code),
        },
      })}::jsonb,
      now()
    )
    ON CONFLICT (worker_id) DO UPDATE SET
      instance_type = EXCLUDED.instance_type,
      provider_scope = EXCLUDED.provider_scope,
      status = EXCLUDED.status,
      last_heartbeat_at = now(),
      last_business_id = EXCLUDED.last_business_id,
      last_partition_id = EXCLUDED.last_partition_id,
      meta_json = EXCLUDED.meta_json,
      updated_at = now()
  `;
  await upsertRuntimeContractInstance({
    contract: runtimeContract,
    healthState: runtimeContract.validation.pass ? "healthy" : "invalid",
  }).catch(() => null);
}

export async function acquireSyncRunnerLease(input: {
  businessId: string;
  providerScope: string;
  leaseOwner: string;
  leaseMinutes: number;
}) {
  await assertSyncWorkerHealthTablesReady(
    ["sync_runner_leases"],
    "sync_worker_health:acquire_runner_lease",
  );
  const businessRefIds = await resolveBusinessReferenceIds([input.businessId]);
  const sql = getDb();
  const rows = await sql`
    INSERT INTO sync_runner_leases (
      business_id,
      business_ref_id,
      provider_scope,
      lease_owner,
      lease_expires_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${businessRefIds.get(input.businessId) ?? null},
      ${input.providerScope},
      ${input.leaseOwner},
      now() + (${Math.max(1, input.leaseMinutes)} || ' minutes')::interval,
      now()
    )
    ON CONFLICT (business_id, provider_scope) DO UPDATE SET
      business_ref_id = COALESCE(sync_runner_leases.business_ref_id, EXCLUDED.business_ref_id),
      lease_owner = CASE
        WHEN sync_runner_leases.lease_expires_at <= now() OR sync_runner_leases.lease_owner = ${input.leaseOwner}
          THEN EXCLUDED.lease_owner
        ELSE sync_runner_leases.lease_owner
      END,
      lease_expires_at = CASE
        WHEN sync_runner_leases.lease_expires_at <= now() OR sync_runner_leases.lease_owner = ${input.leaseOwner}
          THEN EXCLUDED.lease_expires_at
        ELSE sync_runner_leases.lease_expires_at
      END,
      updated_at = now()
    RETURNING lease_owner
  ` as Array<{ lease_owner: string }>;
  return rows[0]?.lease_owner === input.leaseOwner;
}

export async function renewSyncRunnerLease(input: {
  businessId: string;
  providerScope: string;
  leaseOwner: string;
  leaseMinutes: number;
}) {
  await assertSyncWorkerHealthTablesReady(
    ["sync_runner_leases"],
    "sync_worker_health:renew_runner_lease",
  );
  const businessRefIds = await resolveBusinessReferenceIds([input.businessId]);
  const sql = getDb();
  const rows = await sql`
    UPDATE sync_runner_leases
    SET
      business_ref_id = COALESCE(
        sync_runner_leases.business_ref_id,
        ${businessRefIds.get(input.businessId) ?? null}
      ),
      lease_expires_at = now() + (${Math.max(1, input.leaseMinutes)} || ' minutes')::interval,
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND provider_scope = ${input.providerScope}
      AND lease_owner = ${input.leaseOwner}
      AND lease_expires_at > now()
    RETURNING lease_owner
  ` as Array<{ lease_owner: string }>;
  return rows[0]?.lease_owner === input.leaseOwner;
}

export async function releaseSyncRunnerLease(input: {
  businessId: string;
  providerScope: string;
  leaseOwner: string;
}) {
  await assertSyncWorkerHealthTablesReady(
    ["sync_runner_leases"],
    "sync_worker_health:release_runner_lease",
  );
  const sql = getDb();
  await sql`
    DELETE FROM sync_runner_leases
    WHERE business_id = ${input.businessId}
      AND provider_scope = ${input.providerScope}
      AND lease_owner = ${input.leaseOwner}
  `;
}

export async function getSyncRunnerLeaseHealth(input: {
  businessId: string;
  providerScope: string;
}) {
  await assertSyncWorkerHealthTablesReady(
    ["sync_runner_leases"],
    "sync_worker_health:get_runner_lease_health",
  );
  const sql = getDb();
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE lease_expires_at > now())::int AS active_leases,
      MAX(lease_expires_at) AS latest_lease_expires_at,
      MAX(updated_at) AS latest_lease_updated_at,
      MAX(lease_owner) FILTER (WHERE lease_expires_at > now()) AS active_lease_owner,
      BOOL_OR(lease_expires_at > now()) AS has_active_lease
    FROM sync_runner_leases
    WHERE business_id = ${input.businessId}
      AND provider_scope = ${input.providerScope}
  ` as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    activeLeases: Number(row.active_leases ?? 0),
    hasActiveLease: Boolean(row.has_active_lease),
    latestLeaseExpiresAt: normalizeTimestamp(row.latest_lease_expires_at),
    latestLeaseUpdatedAt: normalizeTimestamp(row.latest_lease_updated_at),
    activeLeaseOwner: row.active_lease_owner ? String(row.active_lease_owner) : null,
  };
}

export async function getSyncWorkerHealthSummary(input?: {
  providerScopes?: string[];
  onlineWindowMinutes?: number;
}) {
  await assertSyncWorkerHealthTablesReady(
    ["sync_worker_heartbeats"],
    "sync_worker_health:get_health_summary",
  );
  const sql = getDb();
  const providerScopes =
    input?.providerScopes
      ?.map((scope) => String(scope).trim())
      .filter(Boolean) ?? [];
  const onlineWindowMinutes = Math.max(1, input?.onlineWindowMinutes ?? 2);
  const [summaryRows, workerRows] = await Promise.all([
    sql`
      SELECT
        -- A 'disabled' worker started, registered and is admitted to
        -- NOTHING: it heartbeats so a staged release can be inspected before it
        -- is enabled, and it takes no lease and claims no partition. Counting it
        -- as online is the exact failure the fatal boot refusal was written to
        -- prevent — an operator surface reporting a healthy worker doing no
        -- work. It is excluded here rather than at each call site so a new
        -- reader of this data cannot miss it.
        COUNT(*) FILTER (
          WHERE last_heartbeat_at > now() - (${String(onlineWindowMinutes)} || ' minutes')::interval
            AND status <> 'disabled'
        )::int AS online_workers,
        COUNT(*) FILTER (
          WHERE last_heartbeat_at > now() - (${String(onlineWindowMinutes)} || ' minutes')::interval
            AND status = 'disabled'
        )::int AS staged_workers,
        COUNT(*)::int AS worker_instances,
        MAX(last_heartbeat_at) AS last_heartbeat_at
      FROM sync_worker_heartbeats
      WHERE (
        COALESCE(array_length(${providerScopes}::text[], 1), 0) = 0
        OR provider_scope = ANY(${providerScopes}::text[])
      )
    ` as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        worker_id,
        instance_type,
        provider_scope,
        status,
        last_heartbeat_at,
        last_business_id,
        last_partition_id,
        meta_json
      FROM sync_worker_heartbeats
      WHERE (
        COALESCE(array_length(${providerScopes}::text[], 1), 0) = 0
        OR provider_scope = ANY(${providerScopes}::text[])
      )
      ORDER BY last_heartbeat_at DESC
    ` as Promise<Array<Record<string, unknown>>>,
  ]);
  const summary = summaryRows[0] ?? {};
  const nowMs = Date.now();
  const staleThresholdMs = onlineWindowMinutes * 60_000;
  return {
    onlineWorkers: Number(summary.online_workers ?? 0),
    workerInstances: Number(summary.worker_instances ?? 0),
    lastHeartbeatAt: normalizeTimestamp(summary.last_heartbeat_at),
    lastProgressHeartbeatAt: null,
    workers: workerRows.map((row) => {
      const metaJson = normalizeMetaJson(row.meta_json);
      return {
      workerFreshnessState:
        String(row.status) === "stopped"
          ? ("stopped" as const)
          : (() => {
              const heartbeatAt = normalizeTimestamp(row.last_heartbeat_at);
              if (!heartbeatAt) return "stale" as const;
              return nowMs - new Date(heartbeatAt).getTime() <= staleThresholdMs
                ? ("online" as const)
                : ("stale" as const);
            })(),
      workerId: String(row.worker_id),
      instanceType: String(row.instance_type),
      providerScope: String(row.provider_scope),
      status: String(row.status),
      lastHeartbeatAt: normalizeTimestamp(row.last_heartbeat_at),
      lastBusinessId: row.last_business_id ? String(row.last_business_id) : null,
      lastPartitionId: row.last_partition_id ? String(row.last_partition_id) : null,
      lastConsumedBusinessId:
        typeof metaJson?.currentBusinessId === "string" &&
        metaJson.currentBusinessId.trim().length > 0
          ? metaJson.currentBusinessId.trim()
          : row.last_business_id
            ? String(row.last_business_id)
            : null,
      lastConsumeOutcome:
        typeof metaJson?.consumeOutcome === "string" ? metaJson.consumeOutcome : null,
      lastConsumeFinishedAt:
        typeof metaJson?.consumeFinishedAt === "string"
          ? metaJson.consumeFinishedAt
          : null,
      metaJson,
    };
    }),
  };
}

export function evaluateProviderWorkerHealth(input: {
  onlineWorkers: number;
  lastHeartbeatAt: string | null;
  runnerLeaseActive: boolean;
  staleThresholdMs: number;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const heartbeatAgeMs =
    input.lastHeartbeatAt != null
      ? Math.max(0, nowMs - new Date(input.lastHeartbeatAt).getTime())
      : null;
  const hasFreshHeartbeat =
    input.onlineWorkers > 0 ||
    (heartbeatAgeMs != null && heartbeatAgeMs <= Math.max(1, input.staleThresholdMs));
  return {
    workerHealthy: hasFreshHeartbeat || input.runnerLeaseActive,
    heartbeatAgeMs,
    runnerLeaseActive: input.runnerLeaseActive,
    hasFreshHeartbeat,
  };
}

export async function getProviderWorkerHealthState(input: {
  businessId: string;
  providerScope: "google_ads" | "meta";
  staleThresholdMs: number;
}) {
  const [health, leaseHealth] = await Promise.all([
    getSyncWorkerHealthSummary({
      providerScopes: [input.providerScope],
      onlineWindowMinutes: Math.max(1, Math.floor(input.staleThresholdMs / 60_000)),
    }).catch(() => null),
    getSyncRunnerLeaseHealth({
      businessId: input.businessId,
      providerScope: input.providerScope,
    }).catch(() => null),
  ]);
  const matchingWorker = getProviderBusinessWorkerObservation({
    businessId: input.businessId,
    activeLeaseOwner: leaseHealth?.activeLeaseOwner ?? null,
    workers: health?.workers,
    staleThresholdMs: input.staleThresholdMs,
  });
  const providerWorker = getProviderScopeWorkerObservation({
    providerScope: input.providerScope,
    workers: health?.workers,
    staleThresholdMs: input.staleThresholdMs,
  });
  const evaluated = evaluateProviderWorkerHealth({
    onlineWorkers: providerWorker.hasFreshHeartbeat ? 1 : 0,
    lastHeartbeatAt: providerWorker.lastHeartbeatAt,
    runnerLeaseActive: Boolean(leaseHealth?.hasActiveLease),
    staleThresholdMs: input.staleThresholdMs,
  });
  return {
    providerScope: input.providerScope,
    workerHealthy: evaluated.workerHealthy,
    heartbeatAgeMs: providerWorker.heartbeatAgeMs,
    runnerLeaseActive: evaluated.runnerLeaseActive,
    hasFreshHeartbeat: providerWorker.hasFreshHeartbeat,
    ownerWorkerId: leaseHealth?.activeLeaseOwner ?? null,
    matchedWorkerId: matchingWorker.workerId,
    lastHeartbeatAt: providerWorker.lastHeartbeatAt,
    latestLeaseUpdatedAt: leaseHealth?.latestLeaseUpdatedAt ?? null,
    workerFreshnessState: providerWorker.workerFreshnessState,
    currentBusinessId: matchingWorker.currentBusinessId,
    lastConsumedBusinessId: matchingWorker.lastConsumedBusinessId,
    consumeStage: matchingWorker.consumeStage,
    batchBusinessIds: matchingWorker.batchBusinessIds,
    workerMeta: matchingWorker.metaJson,
  };
}

export async function recordSyncReclaimEvents(input: {
  providerScope: string;
  businessId: string;
  partitionIds: string[];
  checkpointScope?: string | null;
  eventType: "reclaimed" | "poisoned" | "skipped_active_lease";
  disposition?: ProviderReclaimDisposition | null;
  reasonCode?: ProviderReclaimReasonCode | null;
  detail?: string | null;
}) {
  if (input.partitionIds.length === 0) return;
  await assertSyncWorkerHealthTablesReady(
    ["sync_reclaim_events"],
    "sync_worker_health:record_reclaim_events",
  );
  const sql = getDb();
  for (const partitionId of input.partitionIds) {
    await sql`
      INSERT INTO sync_reclaim_events (
        provider_scope,
        business_id,
        partition_id,
        checkpoint_scope,
        event_type,
        disposition,
        reason_code,
        detail
      )
      VALUES (
        ${input.providerScope},
        ${input.businessId},
        ${partitionId},
        ${input.checkpointScope ?? null},
        ${input.eventType},
        ${input.disposition ?? null},
        ${input.reasonCode ?? null},
        ${input.detail ?? null}
      )
    `;
  }
}
