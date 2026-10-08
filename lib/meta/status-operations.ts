import type { DbGrowthFenceDecision } from "@/lib/sync/db-growth-fence";

export interface MetaSyncCapability {
  state: "admitted" | "capacity_refused" | "unknown";
  canStartSync: boolean;
  reason: string;
  evaluatedAt: string | null;
  message: string;
}

/** Projection of existing admission only; liveness and readable data cannot
 * grant new work. Old/unreadable observations remain unknown. */
export function buildMetaSyncCapability(
  admission: Pick<DbGrowthFenceDecision, "allowed" | "reason" | "evaluatedAt"> | null,
  nowMs = Date.now(),
): MetaSyncCapability {
  const at = admission ? Date.parse(admission.evaluatedAt) : NaN;
  const known = Boolean(admission && Number.isFinite(at) && at <= nowMs && nowMs - at <= 60_000 && admission.reason !== "fence_read_failed");
  const state = !known ? "unknown" : admission!.allowed ? "admitted" : "capacity_refused";
  return {
    state, canStartSync: state === "admitted",
    reason: known ? admission!.reason : "sync_admission_unavailable",
    evaluatedAt: admission?.evaluatedAt ?? null,
    message: state === "admitted"
      ? "Capacity admission permits new work; worker health and evidence freshness are separate checks."
      : state === "capacity_refused"
        ? "New Meta sync and decision generation are blocked by database capacity. Existing evidence remains readable; re-evaluate after admission is restored."
        : "Admission for new Meta sync and decision generation could not be verified. Existing evidence does not prove that new work can start.",
  };
}

export type MetaOperationsBlockReason =
  | "capacity_refused"
  | "sync_admission_unavailable"
  | "worker_offline"
  | "lease_denied"
  | "queue_backlogged";

function parseTimestampMs(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveMetaOperationsBlockReason(input: {
  workerHealthy: boolean;
  queueDepth: number;
  leasedPartitions: number;
  consumeStage?: string | null;
  heartbeatAgeMs?: number | null;
  latestActivityAt?: string | null;
  historicalCoreQueued?: number;
  extendedHistoricalQueued?: number;
  maintenanceQueued?: number;
  nowMs?: number;
  syncCapability?: MetaSyncCapability;
}): MetaOperationsBlockReason | null {
  if (input.syncCapability && !input.syncCapability.canStartSync) {
    return input.syncCapability.state === "capacity_refused" ? "capacity_refused" : "sync_admission_unavailable";
  }
  if (input.queueDepth <= 0) return null;
  if (!input.workerHealthy) return "worker_offline";
  if (input.consumeStage === "lease_denied") return "lease_denied";
  if (input.leasedPartitions > 0) return null;

  const historicalBacklog =
    (input.historicalCoreQueued ?? 0) > 0 || (input.extendedHistoricalQueued ?? 0) > 0;
  const maintenanceOnlyBacklog =
    !historicalBacklog && (input.maintenanceQueued ?? 0) > 0;

  const nowMs = input.nowMs ?? Date.now();
  const latestActivityMs = parseTimestampMs(input.latestActivityAt);
  const activityAgeMs =
    latestActivityMs != null ? Math.max(0, nowMs - latestActivityMs) : null;
  const heartbeatAgeMs = input.heartbeatAgeMs ?? null;
  const hasStaleActivity = activityAgeMs == null || activityAgeMs > 10 * 60_000;
  const hasFreshWorkerHeartbeat =
    heartbeatAgeMs != null && heartbeatAgeMs <= 3 * 60_000;

  if (historicalBacklog && (hasStaleActivity || hasFreshWorkerHeartbeat)) {
    return "queue_backlogged";
  }

  if (!historicalBacklog && maintenanceOnlyBacklog) {
    return null;
  }

  return null;
}
