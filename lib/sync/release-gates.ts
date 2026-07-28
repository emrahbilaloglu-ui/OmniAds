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

/**
 * A deploy gate is not a Meta fact.
 *
 * `evaluateDeployGate` measures the runtime contract, service liveness and the
 * build fingerprint — one verdict for the whole deployment, not per provider.
 * Writing it under `provider_scope='meta'` made it invisible to the Google
 * control plane, which asks for `google_ads` and got no deploy gate at all: not
 * "blocked", not "stale", but absent, which reads as "no gate configured".
 *
 * So global identity gets its own scope value that no provider ever requests,
 * and every reader resolves a deploy gate to it regardless of which provider it
 * is asking about.
 */
export const SYNC_GATE_GLOBAL_PROVIDER_SCOPE = "global";

/**
 * Legacy rows whose provider is genuinely unrecorded.
 *
 * Explicitly unknown, never silently Meta. `COALESCE(provider_scope, 'meta')`
 * asserted a fact about rows that never carried one, so a legacy Google verdict
 * answered Meta questions and both landed in the same retention group.
 */
export const SYNC_GATE_UNKNOWN_PROVIDER_SCOPE = "unknown";

/**
 * Every provider scope the deploy gate must find healthy.
 *
 * The gate is GLOBAL — one verdict for the deployment, read by both control
 * planes — so measuring only Meta made a silent Google worker invisible to a
 * PASS that the Google control plane then read as evidence about itself.
 *
 * Overridable so a deployment that genuinely carries one provider does not fail
 * on the absence of the other; the default names both because both ship.
 */
export function resolveDeployGateProviderScopes(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = env.SYNC_DEPLOY_GATE_PROVIDER_SCOPES?.trim();
  if (!configured) return ["meta", "google_ads"];
  const scopes = configured
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : ["meta", "google_ads"];
}

/**
 * The environment a gate is filed under when the emitter did not know one.
 *
 * This is the ONLY cross-environment fallback that is ever consulted, and it is
 * still an equality predicate — a staging row can never answer a production
 * question, because `'staging' <> 'production'` and `'staging' <> 'unknown'`.
 */
const SYNC_GATE_UNKNOWN_ENVIRONMENT = "unknown";

function normalizeRequestedReleaseGateProviderScope(
  providerScope?: string | null,
) {
  const normalized = providerScope?.trim();
  return normalized && normalized.length > 0 ? normalized : "meta";
}

/**
 * The scope a READER must use for a gate kind.
 *
 * Deploy gates are global, so a Google reader and a Meta reader resolve the
 * same row; release gates are per provider, so they never do.
 */
export function resolveSyncGateReadProviderScope(input: {
  gateKind: SyncGateKind;
  providerScope?: string | null;
}): string {
  if (input.gateKind === "deploy_gate") return SYNC_GATE_GLOBAL_PROVIDER_SCOPE;
  return normalizeRequestedReleaseGateProviderScope(input.providerScope);
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
  /**
   * Whether every day in the measured range was re-read AFTER it closed
   * (`converging` or `settled`).
   *
   * `false` refuses the pass outright, so no already-passing shape — a drained
   * queue, a healthy activity state, a recent successful run — can imply
   * freshness by itself. `null`/`undefined` means the caller supplies no
   * post-close evidence at all; that case is left to `truthReady`, which the
   * Google Ads path already gates on this same verdict, and keeps Meta (whose
   * finality model is not Google's) unaffected.
   */
  freshnessPostCloseObserved?: boolean | null;
  /** The completion state behind the flag above, recorded as gate evidence. */
  freshnessState?: string | null;
  /** False means "we could not look", which is non-green AND retryable. */
  freshnessEvidenceAvailable?: boolean | null;
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
 * Exact provider scope for a gate row at WRITE time.
 *
 * Deploy gates are global. Release gates carry their provider inside evidence,
 * where absent has always meant "meta" for a row this code wrote — that default
 * is safe here precisely because it applies to rows being written now, whose
 * emitter we control, and not to legacy rows whose provider was never recorded.
 */
export function resolveSyncGateProviderScope(input: {
  gateKind: SyncGateKind;
  evidence?: Record<string, unknown> | null;
}): string {
  if (input.gateKind === "deploy_gate") return SYNC_GATE_GLOBAL_PROVIDER_SCOPE;
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
        AND provider_scope = ${providerScope}
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

/**
 * Prefer the exact-environment row; accept an environment-less one only if
 * there is no exact row at all.
 *
 * The fallback is already an equality read on `environment = 'unknown'`, so
 * this merge cannot admit a foreign environment even if it wanted to. The
 * previous shape ran an unconstrained-environment query unconditionally and
 * then filtered in JavaScript, which meant a staging evaluation was fetched on
 * every production read and — for the deploy gate, which had no filter at all —
 * could be returned.
 */
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
  const acceptable = (record: SyncGateRecord | null) => {
    if (record == null) return null;
    if (record.environment === input.environment) return record;
    if (record.environment !== SYNC_GATE_UNKNOWN_ENVIRONMENT) return null;
    // An unknown-environment gate is EVIDENCE, not authority.
    //
    // It was emitted by a process that could not determine which environment it
    // was running in. A `fail` from it is still worth honouring — something was
    // genuinely wrong — but a `pass` says only "whatever environment that was,
    // it looked fine", and letting it satisfy a production readiness question
    // is precisely the reasoning a gate exists to prevent. Fail closed: the
    // pass is reported as misconfigured, which every enforcement path already
    // treats as blocking.
    if (record.verdict !== "pass" && record.baseResult !== "pass") return record;
    return {
      ...record,
      baseResult: "misconfigured" as const,
      verdict: "misconfigured" as const,
      blockerClass: "misconfigured" as const,
      summary:
        `${record.summary} (Recorded under an UNKNOWN environment; a pass from it is not authoritative for ` +
        `'${input.environment}'.)`,
    };
  };

  return {
    deployGate: input.exact.deployGate ?? acceptable(input.fallbackByBuild.deployGate),
    releaseGate: input.exact.releaseGate ?? acceptable(input.fallbackByBuild.releaseGate),
  };
}

/**
 * Legacy gate evidence whose provider was never recorded.
 *
 * Preserved, inspectable and NEVER returned for a provider question. A row
 * filed under `unknown` is real history — it says something happened — but it
 * does not say which provider it happened to, so answering a Meta or Google
 * question with it would be inventing the one fact it lacks. This is the
 * surface that lets an operator see that such evidence exists without any
 * reader silently consuming it.
 */
export async function readAmbiguousLegacyGateEvidence(input?: {
  buildId?: string;
  environment?: string;
  limit?: number;
}): Promise<{
  count: number;
  newest: SyncGateRecord | null;
}> {
  await assertGateTablesReady("sync_release_gates:ambiguous_legacy");
  const { buildId, environment } = resolveSyncControlPlaneKey({
    buildId: input?.buildId,
    environment: input?.environment,
  });
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT ${SYNC_GATE_ROW_COLUMNS}
     FROM sync_release_gates
     WHERE build_id = $1
       AND environment = $2
       AND provider_scope = $3
     ORDER BY emitted_at DESC, id DESC
     LIMIT 1`,
    [buildId, environment, SYNC_GATE_UNKNOWN_PROVIDER_SCOPE],
  )) as Array<Record<string, unknown>>;
  const counted = (await sql.query(
    `SELECT COUNT(*)::int AS count
     FROM sync_release_gates
     WHERE build_id = $1 AND environment = $2 AND provider_scope = $3`,
    [buildId, environment, SYNC_GATE_UNKNOWN_PROVIDER_SCOPE],
  )) as Array<{ count: number }>;
  return {
    count: Number(counted[0]?.count ?? 0),
    newest: rows[0] ? hydrateSyncGateRecordRow(rows[0]) : null,
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
  // Deploy gates resolve globally; release gates resolve to the caller's
  // provider. Both are equality predicates, so neither can bleed into the other.
  const deployScope = resolveSyncGateReadProviderScope({ gateKind: "deploy_gate" });
  const releaseScope = resolveSyncGateReadProviderScope({
    gateKind: "release_gate",
    providerScope: input?.providerScope,
  });

  // Two keyed LIMIT 1 reads instead of two unbounded scans, and the two
  // environment-less fallbacks are issued ONLY for a kind that had no exact row.
  // A healthy deployment therefore issues exactly two queries per call.
  const [deployExact, releaseExact] = await Promise.all([
    readLatestSyncGateRow({
      buildId,
      environment,
      gateKind: "deploy_gate",
      providerScope: deployScope,
    }),
    readLatestSyncGateRow({
      buildId,
      environment,
      gateKind: "release_gate",
      providerScope: releaseScope,
    }),
  ]);

  const [deployFallback, releaseFallback] = await Promise.all([
    deployExact
      ? Promise.resolve(null)
      : readLatestSyncGateRow({
          buildId,
          environment: SYNC_GATE_UNKNOWN_ENVIRONMENT,
          gateKind: "deploy_gate",
          providerScope: deployScope,
        }),
    releaseExact
      ? Promise.resolve(null)
      : readLatestSyncGateRow({
          buildId,
          environment: SYNC_GATE_UNKNOWN_ENVIRONMENT,
          gateKind: "release_gate",
          providerScope: releaseScope,
        }),
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
 * `environment` is ALWAYS an equality predicate. There is no "any environment"
 * mode: the only fallback is the literal `'unknown'` environment, which is what
 * an emitter that could not determine one writes. That keeps every read on the
 * same four-column index prefix and makes a staging row structurally incapable
 * of answering a production question.
 */
async function readLatestSyncGateRow(input: {
  buildId: string;
  environment: string;
  gateKind: SyncGateKind;
  providerScope: string;
}): Promise<SyncGateRecord | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT ${SYNC_GATE_ROW_COLUMNS}
     FROM sync_release_gates
     WHERE build_id = $1
       AND environment = $2
       AND gate_kind = $3
       AND provider_scope = $4
     ORDER BY emitted_at DESC, id DESC
     LIMIT 1`,
    [input.buildId, input.environment, input.gateKind, input.providerScope],
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  return row ? hydrateSyncGateRecordRow(row) : null;
}

/**
 * Keyed newest row for a gate kind regardless of build. Diagnostics only.
 *
 * Still environment-constrained: a diagnostic that reports a staging verdict on
 * a production status page is a wrong answer, not a weaker one.
 */
export async function readLatestSyncGateRowForKind(input: {
  gateKind: SyncGateKind;
  environment: string;
  providerScope: string;
}): Promise<SyncGateRecord | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT ${SYNC_GATE_ROW_COLUMNS}
     FROM sync_release_gates
     WHERE gate_kind = $1
       AND provider_scope = $2
       AND environment = $3
     ORDER BY emitted_at DESC, id DESC
     LIMIT 1`,
    [input.gateKind, input.providerScope, input.environment],
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
export interface SyncGateRetentionCursor {
  emittedAt: string;
  id: string;
}

export async function pruneSyncGateRecords(input?: {
  maxAgeDays?: number;
  limit?: number;
  forceExecute?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  /** Resume point from a previous batch's `nextCursor`. */
  cursor?: SyncGateRetentionCursor | null;
}): Promise<{
  mode: "execute" | "dry_run";
  /** Rows the scan looked at, whether or not they were deletable. */
  examined: number;
  candidates: number;
  deleted: number;
  nextCursor: SyncGateRetentionCursor | null;
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

  // Bounded by construction, in two steps.
  //
  // `aged` walks the OLDEST rows in `(emitted_at, id)` order straight off
  // `idx_sync_release_gates_retention_scan` and stops at `limit`. That is the
  // only scan, and its cost is the batch size — not the size of the table.
  //
  // Then each of those (at most `limit`) rows asks one keyed question: "does a
  // newer row exist for my exact key?" If yes, this row is not current evidence
  // and may be deleted. That EXISTS is a single index probe on
  // `idx_sync_release_gates_key_latest`, whose leading four columns are exactly
  // the key and whose trailing `(emitted_at DESC, id DESC)` serves the row
  // comparison.
  //
  // The previous shape computed `DISTINCT ON` over the WHOLE relation to build a
  // latest-per-key set before applying any limit, so retention read every one of
  // the 1.35 GB on every tick and the LIMIT bounded only the DELETE. It also
  // grouped on `COALESCE(provider_scope, 'meta')`, which put legacy Google rows
  // in the Meta retention group.
  // ...and it makes deterministic PROGRESS even when a batch deletes nothing.
  //
  // `LIMIT` is applied BEFORE the "is this current evidence?" filter, so a batch
  // whose oldest N rows all happen to be the newest row for their own key
  // returns zero candidates. Without a cursor the next call re-reads exactly the
  // same N rows and returns zero again — retention starves permanently at the
  // head of the table, which on this table is precisely the shape a build with
  // one evaluation produces. The scan therefore resumes from the last row it
  // EXAMINED, not from the last row it deleted.
  const candidateSql = `
    WITH aged AS (
      SELECT id, build_id, environment, gate_kind, provider_scope, emitted_at
      FROM sync_release_gates
      WHERE emitted_at < now() - make_interval(days => $1)
        AND ($3::timestamptz IS NULL OR (emitted_at, id) > ($3::timestamptz, $4::uuid))
      ORDER BY emitted_at ASC, id ASC
      LIMIT $2
    )
    SELECT aged.id,
           aged.emitted_at::text AS emitted_at,
           EXISTS (
             SELECT 1
             FROM sync_release_gates newer
             WHERE newer.build_id = aged.build_id
               AND newer.environment = aged.environment
               AND newer.gate_kind = aged.gate_kind
               AND newer.provider_scope = aged.provider_scope
               AND (newer.emitted_at, newer.id) > (aged.emitted_at, aged.id)
           ) AS superseded
    FROM aged
    ORDER BY aged.emitted_at ASC, aged.id ASC
  `;
  const examined = (await sql.query(candidateSql, [
    maxAgeDays,
    limit,
    input?.cursor?.emittedAt ?? null,
    input?.cursor?.id ?? null,
  ])) as Array<{ id: string; emitted_at: string; superseded: boolean }>;

  const candidates = examined.filter((row) => row.superseded);
  const last = examined[examined.length - 1];
  const nextCursor =
    examined.length === limit && last
      ? { emittedAt: last.emitted_at, id: last.id }
      : null;

  if (decision.mode !== "execute" || candidates.length === 0) {
    return {
      mode: decision.mode,
      examined: examined.length,
      candidates: candidates.length,
      deleted: 0,
      nextCursor,
      laneReason: decision.laneAdmission.reason,
    };
  }

  const deleted = (await sql.query(
    `DELETE FROM sync_release_gates WHERE id = ANY($1::uuid[]) RETURNING id`,
    [candidates.map((row) => row.id)],
  )) as Array<{ id: string }>;
  return {
    mode: decision.mode,
    examined: examined.length,
    candidates: candidates.length,
    deleted: deleted.length,
    nextCursor,
    laneReason: decision.laneAdmission.reason,
  };
}

/**
 * The production retention pass for `sync_release_gates`.
 *
 * `pruneSyncGateRecords` had no caller at all: the table's containment existed
 * as a function nothing invoked, so the 1.35 GB stayed 1.35 GB no matter how
 * correct the single-batch logic was. This is the loop that actually runs it,
 * and it is the only thing that ever will.
 *
 * Bounded (a batch cap and a row cap per call), resumable (an explicit keyset
 * cursor carried between batches so a pass that stops mid-table resumes exactly
 * where it left off), and DEFAULT-OFF: `resolveDestructiveRetentionMode` keeps
 * every batch in dry-run while the retention lane is disabled, so the caller
 * below reports what it WOULD delete and deletes nothing.
 */
export async function runSyncGateRetentionPass(input?: {
  maxAgeDays?: number;
  batchLimit?: number;
  maxBatches?: number;
  forceExecute?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<{
  mode: "execute" | "dry_run";
  batches: number;
  examined: number;
  candidates: number;
  deleted: number;
  completed: boolean;
  nextCursor: SyncGateRetentionCursor | null;
  laneReason: string;
}> {
  const maxBatches = Math.max(1, Math.min(1_000, input?.maxBatches ?? 20));
  let cursor: SyncGateRetentionCursor | null = null;
  let batches = 0;
  let examined = 0;
  let candidates = 0;
  let deleted = 0;
  let mode: "execute" | "dry_run" = "dry_run";
  let laneReason = "not_evaluated";

  for (; batches < maxBatches; batches += 1) {
    const batch = await pruneSyncGateRecords({
      maxAgeDays: input?.maxAgeDays,
      limit: input?.batchLimit,
      forceExecute: input?.forceExecute,
      env: input?.env,
      cursor,
    });
    mode = batch.mode;
    laneReason = batch.laneReason;
    examined += batch.examined;
    candidates += batch.candidates;
    deleted += batch.deleted;

    // In EXECUTE mode a deleted batch shrinks the head of the table, so the
    // cursor is deliberately not advanced past rows that are now gone: the next
    // scan starts from the same place and finds what moved into it. In dry-run
    // nothing is removed, so the cursor is the only thing that can make
    // progress — which is exactly the starvation case.
    const advance = batch.mode === "execute" && batch.deleted > 0 ? null : batch.nextCursor;
    if (advance == null) {
      return {
        mode,
        batches: batches + 1,
        examined,
        candidates,
        deleted,
        completed: batch.nextCursor == null,
        nextCursor: null,
        laneReason,
      };
    }
    cursor = advance;
  }

  return {
    mode,
    batches,
    examined,
    candidates,
    deleted,
    completed: false,
    nextCursor: cursor,
    laneReason,
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
  /**
   * Freshness refuses the pass on its own.
   *
   * Belt and braces with `truthReady`: the Google Ads path already ANDs
   * post-close observation into `truthReady`, and this second refusal means a
   * future caller that reconstructs `truthReady` from something weaker still
   * cannot get a pass over data captured once intraday and never re-read.
   */
  const freshnessUnobserved = input.freshnessPostCloseObserved === false;
  const pass =
    healthyActivity && draining && input.truthReady && !blocked && !freshnessUnobserved;
  // Order unchanged on purpose. An independently observed incident — dead
  // letters that blocked the queue, a stalled worker, stuck leases — must keep
  // naming itself, even when freshness is `unknown`. Suppressing a real
  // incident because we could not read freshness would be a regression, so
  // freshness only ever lands in the residual `not_release_ready` class, which
  // is non-terminal and retryable.
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
      freshnessPostCloseObserved: input.freshnessPostCloseObserved ?? null,
      freshnessState: input.freshnessState ?? null,
      freshnessEvidenceAvailable: input.freshnessEvidenceAvailable ?? null,
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
  // A GLOBAL gate measures every provider the deployment carries, not Meta.
  //
  // The gate is filed under the `global` scope and read by the Meta AND Google
  // control planes, but its health input was `providerScopes: ["meta"]` and a
  // single `metaWorker.hasFreshHeartbeat`. A deployment whose Google worker had
  // been silent for hours therefore produced a PASSING global deploy gate, and
  // the Google control plane read that pass as evidence about itself.
  const providerScopes = resolveDeployGateProviderScopes();
  const [registry, workerHealth] = await Promise.all([
    getRuntimeRegistryStatus({ buildId }),
    getSyncWorkerHealthSummary({
      providerScopes,
      onlineWindowMinutes: 5,
    }),
  ]);
  const providerObservations = providerScopes.map((providerScope) => ({
    providerScope,
    observation: getProviderScopeWorkerObservation({
      providerScope,
      workers: workerHealth.workers,
      staleThresholdMs: 5 * 60_000,
    }),
  }));
  const staleProviderScopes = providerObservations
    .filter((entry) => !entry.observation.hasFreshHeartbeat)
    .map((entry) => entry.providerScope);
  const allHeartbeatsFresh = staleProviderScopes.length === 0;
  const servicesHealthy =
    registry.webPresent &&
    registry.workerPresent &&
    registry.serviceHealth.web?.healthState === "healthy" &&
    registry.serviceHealth.worker?.healthState === "healthy";
  const baseResult: SyncGateBaseResult =
    servicesHealthy &&
    allHeartbeatsFresh &&
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
        : !allHeartbeatsFresh
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
              ? `heartbeat_missing:${staleProviderScopes.join(",")}`
              : blockerClass === "service_unavailable"
                ? "service_unavailable"
                : "unknown")
          }`,
    breakGlass: Boolean(input?.breakGlass),
    overrideReason: input?.overrideReason ?? null,
    evidence: {
      buildId,
      // Every provider this deployment carries, named. A single `metaHeartbeat`
      // object could not express "Google is silent", which is why it never did.
      providerScopes,
      staleProviderScopes,
      providerHeartbeats: Object.fromEntries(
        providerObservations.map((entry) => [
          entry.providerScope,
          {
            workerId: entry.observation.workerId,
            hasFreshHeartbeat: entry.observation.hasFreshHeartbeat,
            heartbeatAgeMs: entry.observation.heartbeatAgeMs,
          },
        ]),
      ),
      workerHealth: {
        onlineWorkers: workerHealth.onlineWorkers,
        workerInstances: workerHealth.workerInstances,
        lastHeartbeatAt: workerHealth.lastHeartbeatAt,
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
