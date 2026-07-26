import { createHash } from "node:crypto";
import { getDb, runDbTransaction } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import { resolveDestructiveRetentionMode } from "@/lib/sync/global-kill-switch";
import type { MetaSyncBenchmarkSnapshot } from "@/lib/meta-sync-benchmark";
import {
  getRuntimeRegistryStatus,
  readSyncGateMode,
  type SyncGateMode,
} from "@/lib/sync/runtime-contract";
import {
  getProviderScopeWorkerObservation,
  getSyncWorkerHealthSummary,
} from "@/lib/sync/worker-health";
import { resolveSyncControlPlaneKey } from "@/lib/sync/control-plane-key";

export type SyncGateKind = "deploy_gate" | "release_gate";
export type SyncGateBaseResult = "pass" | "fail" | "misconfigured";
export type SyncGateVerdict =
  | "pass"
  | "fail"
  | "misconfigured"
  | "measure_only"
  | "warn_only"
  | "blocked";
export type SyncGateScope =
  | "runtime_contract"
  | "service_liveness"
  | "release_readiness";
export type SyncBlockerClass =
  | "none"
  | "runtime_contract_invalid"
  | "service_unavailable"
  | "heartbeat_missing"
  | "worker_unavailable"
  | "not_release_ready"
  | "queue_blocked"
  | "stalled"
  | "misconfigured"
  | "unknown";

export interface SyncGateRecord {
  id?: string | null;
  gateKind: SyncGateKind;
  gateScope: SyncGateScope;
  buildId: string;
  environment: string;
  mode: SyncGateMode;
  baseResult: SyncGateBaseResult;
  verdict: SyncGateVerdict;
  blockerClass: SyncBlockerClass | null;
  summary: string;
  breakGlass: boolean;
  overrideReason: string | null;
  evidence: Record<string, unknown>;
  emittedAt: string;
}

function normalizeRequestedReleaseGateProviderScope(
  providerScope?: string | null,
) {
  const normalized = providerScope?.trim();
  return normalized && normalized.length > 0 ? normalized : "meta";
}

function readReleaseGateProviderScope(
  evidence: Record<string, unknown> | null | undefined,
) {
  const value = evidence?.providerScope;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export type ProviderReleaseTruthInput = {
  activityState: string | null;
  progressState: string | null;
  workerOnline: boolean | null;
  queueDepth: number;
  leasedPartitions: number;
  truthReady: boolean;
  retryableFailedPartitions?: number;
  deadLetterPartitions?: number;
  staleLeasePartitions?: number;
  repairBacklog?: number;
  validationFailures24h?: number;
  reclaimCandidateCount?: number;
  staleRunCount24h?: number;
  d1FinalizeNonTerminalCount?: number;
  recentTruthState?: string | null;
  priorityTruthState?: string | null;
  stallFingerprints?: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function gateModeForKind(kind: SyncGateKind, env: NodeJS.ProcessEnv = process.env) {
  return kind === "deploy_gate"
    ? readSyncGateMode("SYNC_DEPLOY_GATE_MODE", env)
    : readSyncGateMode("SYNC_RELEASE_GATE_MODE", env);
}

function mapVerdict(
  baseResult: SyncGateBaseResult,
  mode: SyncGateMode,
): SyncGateVerdict {
  if (baseResult === "pass") return "pass";
  if (baseResult === "misconfigured") return "misconfigured";
  if (mode === "measure_only") return "measure_only";
  if (mode === "warn_only") return "warn_only";
  return "blocked";
}

function summarizeRuntimeServingReadiness(
  registry: Awaited<ReturnType<typeof getRuntimeRegistryStatus>>,
) {
  return {
    sampledAt: registry.sampledAt,
    buildId: registry.buildId,
    freshnessWindowMinutes: registry.freshnessWindowMinutes,
    contractValid: registry.contractValid,
    webPresent: registry.webPresent,
    workerPresent: registry.workerPresent,
    dbFingerprintMatch: registry.dbFingerprintMatch,
    configFingerprintMatch: registry.configFingerprintMatch,
    serviceHealth: {
      web: registry.serviceHealth.web
        ? {
            service: registry.serviceHealth.web.service,
            runtimeRole: registry.serviceHealth.web.runtimeRole,
            buildId: registry.serviceHealth.web.buildId,
            healthState: registry.serviceHealth.web.healthState,
            fresh: registry.serviceHealth.web.fresh,
            lastSeenAt: registry.serviceHealth.web.lastSeenAt,
          }
        : null,
      worker: registry.serviceHealth.worker
        ? {
            service: registry.serviceHealth.worker.service,
            runtimeRole: registry.serviceHealth.worker.runtimeRole,
            buildId: registry.serviceHealth.worker.buildId,
            healthState: registry.serviceHealth.worker.healthState,
            fresh: registry.serviceHealth.worker.fresh,
            lastSeenAt: registry.serviceHealth.worker.lastSeenAt,
          }
        : null,
    },
    issues: registry.issues,
  };
}

async function assertGateTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: ["sync_release_gates"],
    context,
  });
}

/**
 * Advisory-lock namespace for release-gate coalescing.
 *
 * Two concurrent evaluations of the same gate reach the same key. Without a
 * lock both would read "no current row" or "fingerprint differs" and both would
 * insert, which is precisely how identical rows accumulate under load.
 */
const SYNC_GATE_COALESCE_LOCK_NAMESPACE = 0x53474154;

function gateCoalesceKey(input: {
  buildId: string;
  environment: string;
  gateKind: SyncGateKind;
  providerScope: string;
}) {
  return `sync_release_gate:${input.buildId}:${input.environment}:${input.gateKind}:${input.providerScope}`;
}

/**
 * Exact provider scope for a gate row.
 *
 * Deploy gates have never carried one; release gates carry it inside evidence,
 * where absent has always meant "meta". Normalising it into a column at write
 * time is what makes the keyed read a single indexable predicate instead of a
 * scan-and-filter-in-JavaScript.
 */
export function resolveSyncGateProviderScope(input: {
  gateKind: SyncGateKind;
  evidence?: Record<string, unknown> | null;
}): string {
  if (input.gateKind === "deploy_gate") return "meta";
  return (
    readReleaseGateProviderScope(input.evidence) ??
    normalizeRequestedReleaseGateProviderScope(null)
  );
}

/**
 * The DECISION, with no clocks in it.
 *
 * Coalescing has to distinguish "the same verdict again" from "the verdict
 * changed". Evidence detail moves on every evaluation — queue depth, sampled
 * timestamps, lag — so hashing evidence would make every evaluation a
 * transition and coalesce nothing. What an operator, a deploy gate and a
 * rollback decision all read is the verdict tuple, so that is what defines
 * identity. The newest evidence and summary are still written onto the current
 * row, so the freshest detail remains readable without a new row per sample.
 */
export function computeSyncGateDecisionFingerprint(input: {
  gateKind: SyncGateKind;
  gateScope: SyncGateScope;
  providerScope: string;
  mode: SyncGateMode;
  baseResult: SyncGateBaseResult;
  verdict: SyncGateVerdict;
  blockerClass: SyncBlockerClass | null;
  breakGlass: boolean;
  overrideReason: string | null;
}): string {
  return createHash("sha256")
    .update(
      [
        input.gateKind,
        input.gateScope,
        input.providerScope,
        input.mode,
        input.baseResult,
        input.verdict,
        input.blockerClass ?? "",
        input.breakGlass ? "1" : "0",
        input.overrideReason ?? "",
      ].join(""),
    )
    .digest("hex");
}

export interface SyncGateWriteResult extends SyncGateRecord {
  /** True when this evaluation folded into the current row instead of appending. */
  coalesced: boolean;
  coalescedCount: number;
  providerScope: string;
}

/**
 * Record a gate evaluation, appending only on a genuine transition.
 *
 * Every evaluation used to INSERT. Cron evaluates both gates on every run, and
 * the deploy pipeline evaluates them again per phase, so an unchanged "pass"
 * wrote a new row indefinitely — the direct cause of a 1.35 GB table whose
 * reads then scanned all of it.
 *
 * Now: one advisory lock per key, one keyed `FOR UPDATE` read of the current
 * row, and either an UPDATE that advances `last_seen_at`/`coalesced_count` and
 * refreshes the evidence, or an INSERT because the decision actually changed.
 */
export async function upsertSyncGateRecord(
  input: SyncGateRecord,
): Promise<SyncGateWriteResult> {
  await assertGateTablesReady("sync_release_gates:upsert");
  const providerScope = resolveSyncGateProviderScope({
    gateKind: input.gateKind,
    evidence: input.evidence,
  });
  const fingerprint = computeSyncGateDecisionFingerprint({
    gateKind: input.gateKind,
    gateScope: input.gateScope,
    providerScope,
    mode: input.mode,
    baseResult: input.baseResult,
    verdict: input.verdict,
    blockerClass: input.blockerClass ?? null,
    breakGlass: input.breakGlass,
    overrideReason: input.overrideReason ?? null,
  });

  return runDbTransaction(async () => {
    const sql = getDb();
    await sql`
      SELECT pg_advisory_xact_lock(
        ${SYNC_GATE_COALESCE_LOCK_NAMESPACE}::int,
        hashtext(${gateCoalesceKey({
          buildId: input.buildId,
          environment: input.environment,
          gateKind: input.gateKind,
          providerScope,
        })})
      )
    `;

    // The keyed latest read, inside the lock, so it is by construction fresh:
    // no cache can serve it and no concurrent writer can pass through it.
    const current = (await sql`
      SELECT id, decision_fingerprint, coalesced_count
      FROM sync_release_gates
      WHERE build_id = ${input.buildId}
        AND environment = ${input.environment}
        AND gate_kind = ${input.gateKind}
        AND COALESCE(provider_scope, 'meta') = ${providerScope}
      ORDER BY emitted_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `) as Array<{
      id: string;
      decision_fingerprint: string | null;
      coalesced_count: number | string | null;
    }>;

    const existing = current[0];
    if (existing && existing.decision_fingerprint === fingerprint) {
      const updated = (await sql`
        UPDATE sync_release_gates
        SET last_seen_at = ${input.emittedAt},
            coalesced_count = coalesced_count + 1,
            summary = ${input.summary},
            evidence_json = ${JSON.stringify(input.evidence ?? {})}::jsonb,
            updated_at = now()
        WHERE id = ${existing.id}
        RETURNING id, coalesced_count
      `) as Array<{ id: string; coalesced_count: number | string }>;
      return {
        ...input,
        id: updated[0]?.id ?? existing.id,
        coalesced: true,
        coalescedCount: Number(updated[0]?.coalesced_count ?? 0),
        providerScope,
      };
    }

    const inserted = (await sql`
      INSERT INTO sync_release_gates (
        build_id,
        environment,
        gate_kind,
        gate_scope,
        provider_scope,
        decision_fingerprint,
        mode,
        base_result,
        verdict,
        blocker_class,
        summary,
        break_glass,
        override_reason,
        evidence_json,
        emitted_at,
        last_seen_at,
        coalesced_count,
        updated_at
      )
      VALUES (
        ${input.buildId},
        ${input.environment},
        ${input.gateKind},
        ${input.gateScope},
        ${providerScope},
        ${fingerprint},
        ${input.mode},
        ${input.baseResult},
        ${input.verdict},
        ${input.blockerClass ?? null},
        ${input.summary},
        ${input.breakGlass},
        ${input.overrideReason ?? null},
        ${JSON.stringify(input.evidence ?? {})}::jsonb,
        ${input.emittedAt},
        ${input.emittedAt},
        1,
        now()
      )
      RETURNING id
    `) as Array<{ id: string }>;
    return {
      ...input,
      id: inserted[0]?.id ?? input.id ?? null,
      coalesced: false,
      coalescedCount: 1,
      providerScope,
    };
  });
}

function hydrateSyncGateRecordRow(row: Record<string, unknown>): SyncGateRecord {
  return {
    id: row.id ? String(row.id) : null,
    gateKind: String(row.gate_kind) === "release_gate" ? "release_gate" : "deploy_gate",
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
    blockerClass: (row.blocker_class as SyncBlockerClass | null) ?? null,
    summary: String(row.summary ?? ""),
    breakGlass: Boolean(row.break_glass),
    overrideReason: row.override_reason ? String(row.override_reason) : null,
    evidence:
      row.evidence_json && typeof row.evidence_json === "object"
        ? (row.evidence_json as Record<string, unknown>)
        : {},
    emittedAt: typeof row.emitted_at === "string"
      ? row.emitted_at
      : row.emitted_at instanceof Date
        ? row.emitted_at.toISOString()
        : nowIso(),
  };
}

export function selectLatestSyncGateRecords(
  records: SyncGateRecord[],
  input?: {
    providerScope?: string | null;
  },
): {
  deployGate: SyncGateRecord | null;
  releaseGate: SyncGateRecord | null;
} {
  const requestedProviderScope = normalizeRequestedReleaseGateProviderScope(
    input?.providerScope,
  );
  const deployGate =
    records.find((record) => record.gateKind === "deploy_gate") ?? null;
  const releaseGate =
    records.find((record) => {
      if (record.gateKind !== "release_gate") return false;
      const recordProviderScope = readReleaseGateProviderScope(record.evidence);
      if (requestedProviderScope === "meta") {
        return recordProviderScope == null || recordProviderScope === "meta";
      }
      return recordProviderScope === requestedProviderScope;
    }) ?? null;

  return {
    deployGate,
    releaseGate,
  };
}

export function mergeLatestSyncGateRecords(input: {
  environment: string;
  exact: {
    deployGate: SyncGateRecord | null;
    releaseGate: SyncGateRecord | null;
  };
  fallbackByBuild: {
    deployGate: SyncGateRecord | null;
    releaseGate: SyncGateRecord | null;
  };
}) {
  const fallbackReleaseGate =
    input.fallbackByBuild.releaseGate != null &&
    (input.fallbackByBuild.releaseGate.environment === input.environment ||
      input.fallbackByBuild.releaseGate.environment === "unknown")
      ? input.fallbackByBuild.releaseGate
      : null;

  return {
    deployGate: input.exact.deployGate ?? input.fallbackByBuild.deployGate,
    releaseGate: input.exact.releaseGate ?? fallbackReleaseGate,
  };
}

export async function getLatestSyncGateRecords(input?: {
  buildId?: string;
  environment?: string;
  providerScope?: string;
}) : Promise<{
  deployGate: SyncGateRecord | null;
  releaseGate: SyncGateRecord | null;
}> {
  await assertGateTablesReady("sync_release_gates:get_latest");
  const { buildId, environment } = resolveSyncControlPlaneKey({
    buildId: input?.buildId,
    environment: input?.environment,
  });
  const providerScope = normalizeRequestedReleaseGateProviderScope(
    input?.providerScope,
  );

  // Four keyed LIMIT 1 reads instead of two unbounded scans.
  //
  // The previous version selected EVERY row for a build (and every row for a
  // build+environment) ordered by emitted_at, then picked the first of each kind
  // in JavaScript. On a table that grew a row per evaluation that is a scan of
  // the whole build's history to answer a question about one row, and it got
  // slower exactly as the runaway got worse.
  const [deployExact, releaseExact, deployFallback, releaseFallback] =
    await Promise.all([
      readLatestSyncGateRow({ buildId, environment, gateKind: "deploy_gate", providerScope }),
      readLatestSyncGateRow({ buildId, environment, gateKind: "release_gate", providerScope }),
      readLatestSyncGateRow({ buildId, environment: null, gateKind: "deploy_gate", providerScope }),
      readLatestSyncGateRow({ buildId, environment: null, gateKind: "release_gate", providerScope }),
    ]);

  return mergeLatestSyncGateRecords({
    environment,
    exact: { deployGate: deployExact, releaseGate: releaseExact },
    fallbackByBuild: { deployGate: deployFallback, releaseGate: releaseFallback },
  });
}

const SYNC_GATE_ROW_COLUMNS = `
  id,
  build_id,
  environment,
  gate_kind,
  gate_scope,
  provider_scope,
  mode,
  base_result,
  verdict,
  blocker_class,
  summary,
  break_glass,
  override_reason,
  evidence_json,
  emitted_at,
  last_seen_at,
  coalesced_count
`;

/**
 * One gate row, chosen deterministically.
 *
 * `emitted_at DESC, id DESC`: the tie-break is not decoration. Two evaluations
 * within the same millisecond — which the deploy pipeline produces routinely —
 * would otherwise return whichever row the planner happened to reach first, so
 * two readers could disagree about the current verdict. The index carries the
 * same ordering, so this is a one-row index scan.
 *
 * `environment: null` means "any environment for this build", used only as the
 * fallback when no exact row exists. It is still keyed and still LIMIT 1.
 */
async function readLatestSyncGateRow(input: {
  buildId: string;
  environment: string | null;
  gateKind: SyncGateKind;
  providerScope: string;
}): Promise<SyncGateRecord | null> {
  const sql = getDb();
  const rows = (input.environment == null
    ? await sql.query(
        `SELECT ${SYNC_GATE_ROW_COLUMNS}
         FROM sync_release_gates
         WHERE build_id = $1
           AND gate_kind = $2
           AND COALESCE(provider_scope, 'meta') = $3
         ORDER BY emitted_at DESC, id DESC
         LIMIT 1`,
        [input.buildId, input.gateKind, input.providerScope],
      )
    : await sql.query(
        `SELECT ${SYNC_GATE_ROW_COLUMNS}
         FROM sync_release_gates
         WHERE build_id = $1
           AND environment = $2
           AND gate_kind = $3
           AND COALESCE(provider_scope, 'meta') = $4
         ORDER BY emitted_at DESC, id DESC
         LIMIT 1`,
        [input.buildId, input.environment, input.gateKind, input.providerScope],
      )) as Array<Record<string, unknown>>;
  const row = rows[0];
  return row ? hydrateSyncGateRecordRow(row) : null;
}

/** Keyed newest row for a gate kind regardless of build. Diagnostics only. */
export async function readLatestSyncGateRowForKind(input: {
  gateKind: SyncGateKind;
  providerScope: string;
}): Promise<SyncGateRecord | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT ${SYNC_GATE_ROW_COLUMNS}
     FROM sync_release_gates
     WHERE gate_kind = $1
       AND COALESCE(provider_scope, 'meta') = $2
     ORDER BY emitted_at DESC, id DESC
     LIMIT 1`,
    [input.gateKind, input.providerScope],
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  return row ? hydrateSyncGateRecordRow(row) : null;
}

/**
 * Bounded retention for gate evidence.
 *
 * Guarded three ways, because this is the only path here that deletes:
 *   - it runs under the retention lane, so it is dry-run while that lane is off;
 *   - it never touches the newest row for any key, so the current verdict for
 *     every build/environment/kind/scope survives regardless of age;
 *   - it deletes at most `limit` rows per call, so a first run on a table with
 *     millions of stale rows cannot become an unbounded delete.
 */
export async function pruneSyncGateRecords(input?: {
  maxAgeDays?: number;
  limit?: number;
  forceExecute?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<{
  mode: "execute" | "dry_run";
  candidates: number;
  deleted: number;
  laneReason: string;
}> {
  await assertGateTablesReady("sync_release_gates:prune");
  const maxAgeDays = Math.max(1, Math.min(3650, input?.maxAgeDays ?? 90));
  const limit = Math.max(1, Math.min(50_000, input?.limit ?? 5_000));
  const decision = resolveDestructiveRetentionMode({
    requestedExecute: input?.forceExecute === true,
    env: input?.env,
  });
  const sql = getDb();

  // `latest` is the newest row per key. Anything in it is current evidence and
  // is excluded from deletion by identity, not by age — a build that has not
  // been evaluated for a year still has a readable verdict.
  const candidateSql = `
    WITH latest AS (
      SELECT DISTINCT ON (build_id, environment, gate_kind, COALESCE(provider_scope, 'meta'))
             id
      FROM sync_release_gates
      ORDER BY build_id, environment, gate_kind,
               COALESCE(provider_scope, 'meta'), emitted_at DESC, id DESC
    )
    SELECT id FROM sync_release_gates
    WHERE emitted_at < now() - make_interval(days => $1)
      AND id NOT IN (SELECT id FROM latest)
    ORDER BY emitted_at ASC, id ASC
    LIMIT $2
  `;
  const candidates = (await sql.query(candidateSql, [maxAgeDays, limit])) as Array<{
    id: string;
  }>;

  if (decision.mode !== "execute" || candidates.length === 0) {
    return {
      mode: decision.mode,
      candidates: candidates.length,
      deleted: 0,
      laneReason: decision.laneAdmission.reason,
    };
  }

  const deleted = (await sql.query(
    `DELETE FROM sync_release_gates WHERE id = ANY($1::uuid[]) RETURNING id`,
    [candidates.map((row) => row.id)],
  )) as Array<{ id: string }>;
  return {
    mode: decision.mode,
    candidates: candidates.length,
    deleted: deleted.length,
    laneReason: decision.laneAdmission.reason,
  };
}

export async function getSyncGateRecordById(input: {
  id: string;
}): Promise<SyncGateRecord | null> {
  await assertGateTablesReady("sync_release_gates:get_by_id");
  const sql = getDb();
  const rows = await sql`
    SELECT
      id,
      build_id,
      environment,
      gate_kind,
      gate_scope,
      mode,
      base_result,
      verdict,
      blocker_class,
      summary,
      break_glass,
      override_reason,
      evidence_json,
      emitted_at
    FROM sync_release_gates
    WHERE id = ${input.id}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return hydrateSyncGateRecordRow(row);
}

export function classifyReleaseSnapshot(snapshot: MetaSyncBenchmarkSnapshot) {
  return classifyProviderReleaseTruth({
    activityState: snapshot.operator.activityState,
    progressState: snapshot.operator.progressState,
    workerOnline: snapshot.operator.workerOnline,
    queueDepth: snapshot.queue.queueDepth,
    leasedPartitions: snapshot.queue.leasedPartitions,
    truthReady:
      snapshot.userFacing.recentSelectedRangeTruth.truthReady ||
      snapshot.userFacing.priorityWindowTruth.truthReady,
    retryableFailedPartitions: snapshot.queue.retryableFailedPartitions,
    deadLetterPartitions: snapshot.queue.deadLetterPartitions,
    staleLeasePartitions: snapshot.queue.staleLeasePartitions,
    repairBacklog: snapshot.authoritative.repairBacklog,
    validationFailures24h: snapshot.authoritative.validationFailures24h,
    reclaimCandidateCount: snapshot.operator.reclaimCandidateCount ?? 0,
    staleRunCount24h: snapshot.operator.staleRunCount24h ?? 0,
    d1FinalizeNonTerminalCount: snapshot.operator.d1FinalizeNonTerminalCount,
    recentTruthState: snapshot.userFacing.recentSelectedRangeTruth.state,
    priorityTruthState: snapshot.userFacing.priorityWindowTruth.state,
    stallFingerprints: snapshot.operator.stallFingerprints,
  });
}

export function classifyProviderReleaseTruth(input: ProviderReleaseTruthInput) {
  const healthyActivity = input.activityState === "ready" || input.activityState === "busy";
  const backgroundBackfillProgressing =
    input.truthReady && input.progressState === "partial_progressing";
  const draining =
    input.queueDepth === 0 ||
    input.leasedPartitions > 0 ||
    backgroundBackfillProgressing;
  const blocked =
    input.progressState === "blocked" || input.activityState === "blocked";
  const workerUnavailable =
    input.workerOnline === false &&
    input.queueDepth > 0 &&
    input.leasedPartitions === 0;
  const stalled =
    input.activityState === "stalled" || input.progressState === "partial_stuck";
  const pass = healthyActivity && draining && input.truthReady && !blocked;
  const blockerClass: SyncBlockerClass =
    workerUnavailable
      ? "worker_unavailable"
      : blocked
        ? "queue_blocked"
        : stalled
          ? "stalled"
          : pass
            ? "none"
            : "not_release_ready";

  return {
    pass,
    blockerClass,
    evidence: {
      activityState: input.activityState,
      progressState: input.progressState,
      workerOnline: input.workerOnline,
      queueDepth: input.queueDepth,
      leasedPartitions: input.leasedPartitions,
      recentTruthState: input.recentTruthState ?? null,
      priorityTruthState: input.priorityTruthState ?? null,
      truthReady: input.truthReady,
      retryableFailedPartitions: input.retryableFailedPartitions ?? 0,
      deadLetterPartitions: input.deadLetterPartitions ?? 0,
      staleLeasePartitions: input.staleLeasePartitions ?? 0,
      repairBacklog: input.repairBacklog ?? 0,
      validationFailures24h: input.validationFailures24h ?? 0,
      reclaimCandidateCount: input.reclaimCandidateCount ?? 0,
      staleRunCount24h: input.staleRunCount24h ?? 0,
      d1FinalizeNonTerminalCount: input.d1FinalizeNonTerminalCount ?? 0,
      stallFingerprints: input.stallFingerprints ?? [],
    },
  };
}

export async function evaluateDeployGate(input?: {
  buildId?: string;
  persist?: boolean;
  breakGlass?: boolean;
  overrideReason?: string | null;
  environment?: string;
}) : Promise<SyncGateRecord> {
  const { buildId, environment } = resolveSyncControlPlaneKey({
    buildId: input?.buildId,
    environment: input?.environment,
  });
  const mode = gateModeForKind("deploy_gate");
  const [registry, workerHealth] = await Promise.all([
    getRuntimeRegistryStatus({ buildId }),
    getSyncWorkerHealthSummary({
      providerScopes: ["meta"],
      onlineWindowMinutes: 5,
    }),
  ]);
  const metaWorker = getProviderScopeWorkerObservation({
    providerScope: "meta",
    workers: workerHealth.workers,
    staleThresholdMs: 5 * 60_000,
  });
  const servicesHealthy =
    registry.webPresent &&
    registry.workerPresent &&
    registry.serviceHealth.web?.healthState === "healthy" &&
    registry.serviceHealth.worker?.healthState === "healthy";
  const baseResult: SyncGateBaseResult =
    servicesHealthy &&
    metaWorker.hasFreshHeartbeat &&
    registry.dbFingerprintMatch &&
    registry.configFingerprintMatch &&
    registry.contractValid
      ? "pass"
      : "fail";
  const blockerClass: SyncBlockerClass =
    !registry.contractValid || !registry.dbFingerprintMatch || !registry.configFingerprintMatch
      ? "runtime_contract_invalid"
      : !servicesHealthy
        ? "service_unavailable"
        : !metaWorker.hasFreshHeartbeat
          ? "heartbeat_missing"
          : "none";
  const record: SyncGateRecord = {
    id: null,
    gateKind: "deploy_gate",
    gateScope:
      blockerClass === "runtime_contract_invalid" ? "runtime_contract" : "service_liveness",
    buildId,
    environment,
    mode,
    baseResult,
    verdict: mapVerdict(baseResult, mode),
    blockerClass: blockerClass === "none" ? null : blockerClass,
    summary:
      baseResult === "pass"
        ? "Synthetic deploy gate passed."
        : `Synthetic deploy gate failed: ${
            registry.issues[0] ??
            (blockerClass === "heartbeat_missing"
              ? "meta_heartbeat_missing"
              : blockerClass === "service_unavailable"
                ? "service_unavailable"
                : "unknown")
          }`,
    breakGlass: Boolean(input?.breakGlass),
    overrideReason: input?.overrideReason ?? null,
    evidence: {
      buildId,
      metaHeartbeat: {
        onlineWorkers: workerHealth.onlineWorkers,
        workerInstances: workerHealth.workerInstances,
        lastHeartbeatAt: workerHealth.lastHeartbeatAt,
        workerId: metaWorker.workerId,
        hasFreshHeartbeat: metaWorker.hasFreshHeartbeat,
        heartbeatAgeMs: metaWorker.heartbeatAgeMs,
      },
      runtimeRegistry: registry,
    },
    emittedAt: nowIso(),
  };
  if (input?.persist ?? true) {
    return upsertSyncGateRecord(record);
  }
  return record;
}

export async function evaluateReleaseGate(input?: {
  buildId?: string;
  persist?: boolean;
  breakGlass?: boolean;
  overrideReason?: string | null;
  environment?: string;
}) : Promise<SyncGateRecord> {
  const { buildId, environment } = resolveSyncControlPlaneKey({
    buildId: input?.buildId,
    environment: input?.environment,
  });
  const mode = gateModeForKind("release_gate");
  const registry = await getRuntimeRegistryStatus({ buildId });
  const servicesHealthy =
    registry.webPresent &&
    registry.workerPresent &&
    registry.serviceHealth.web?.healthState === "healthy" &&
    registry.serviceHealth.worker?.healthState === "healthy";
  const baseResult: SyncGateBaseResult =
    servicesHealthy &&
    registry.dbFingerprintMatch &&
    registry.configFingerprintMatch &&
    registry.contractValid
      ? "pass"
      : "fail";
  const blockerClass: SyncBlockerClass =
    !registry.contractValid || !registry.dbFingerprintMatch || !registry.configFingerprintMatch
      ? "runtime_contract_invalid"
      : !servicesHealthy
        ? "service_unavailable"
        : "none";
  const record: SyncGateRecord = {
    id: null,
    gateKind: "release_gate",
    gateScope:
      blockerClass === "runtime_contract_invalid" ? "runtime_contract" : "release_readiness",
    buildId,
    environment,
    mode,
    baseResult,
    verdict: mapVerdict(baseResult, mode),
    blockerClass: blockerClass === "none" ? null : blockerClass,
    summary:
      baseResult === "pass"
        ? "Release gate serving readiness passed."
        : `Release gate serving readiness failed: ${
            registry.issues[0] ??
            (blockerClass === "service_unavailable"
              ? "service_unavailable"
              : blockerClass === "runtime_contract_invalid"
                ? "runtime_contract_invalid"
                : "unknown")
          }`,
    breakGlass: Boolean(input?.breakGlass),
    overrideReason: input?.overrideReason ?? null,
    evidence: {
      buildId,
      runtimeRegistry: summarizeRuntimeServingReadiness(registry),
    },
    emittedAt: nowIso(),
  };
  if (input?.persist ?? true) {
    return upsertSyncGateRecord(record);
  }
  return record;
}

export async function evaluateAndPersistSyncGates(input?: {
  buildId?: string;
  environment?: string;
  breakGlass?: boolean;
  overrideReason?: string | null;
}) {
  const [deployGate, releaseGate] = await Promise.all([
    evaluateDeployGate({
      buildId: input?.buildId,
      environment: input?.environment,
      breakGlass: input?.breakGlass,
      overrideReason: input?.overrideReason,
      persist: true,
    }),
    evaluateReleaseGate({
      buildId: input?.buildId,
      environment: input?.environment,
      breakGlass: input?.breakGlass,
      overrideReason: input?.overrideReason,
      persist: true,
    }),
  ]);
  return {
    checkedAt: nowIso(),
    deployGate,
    releaseGate,
  };
}

export function shouldEnforceSyncGateFailure(
  records: Array<Pick<SyncGateRecord, "verdict"> | null | undefined>,
) {
  return records.some(
    (record) =>
      record != null &&
      (record.verdict === "blocked" || record.verdict === "misconfigured"),
  );
}
