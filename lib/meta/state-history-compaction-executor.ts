// D077 — state-history compaction EXECUTOR.
//
// NOT part of app runtime. The static isolation guard fails the build if any
// route, component, job, or scheduled module imports this file; the only
// legitimate callers are the operator CLI, the real-Postgres seam, and
// tests. It is never scheduled and never runs implicitly.
//
// Trust model: nothing in the received plan object is trusted. The canonical
// execution-payload hash is RECOMPUTED from the received fields and both the
// hash and the approval token must match it before ANY database write. The
// token is an on-the-record operator acknowledgement bound to one exact
// planner artifact — it is derivable from the plan and is NOT cryptographic
// provenance or authenticity. What makes the gate unforgeable is the
// authoritative pre-write re-plan: before lease or journal, the executor
// re-derives the current plan from the database (REPEATABLE READ READ
// ONLY, production planner) and requires exact payload equality, so an
// edited status/total/projection/clearance, an injected foreign run, or a
// stale world refuses with ZERO writes, journal included. Ownership is an expiring
// journal lease acquired atomically under an advisory lock, so two executors
// cannot interleave between batches; each batch transaction renews the lease
// and fully revalidates every run it deletes (scope identity, non-head
// status, expected row count, expected manifest signature, an identical
// retained predecessor, and all pin families) and rolls the batch back on
// any mismatch. The final whole-timeline recheck is defense-in-depth on top
// of that per-batch proof, not the only line.
import { randomUUID } from "node:crypto";
import { getDb, runDbTransaction } from "@/lib/db";
import {
  STATE_HISTORY_COMPACTION_CONTRACT,
  STATE_HISTORY_COMPACTION_LOCK_KEY,
  computeExecutionPayloadHash,
  computeScopeFingerprint,
  computeTimelineHashes,
  detectArchivedLineageSchema,
  expectedApprovalToken,
  pinnedExistsSql,
  planStateHistoryCompaction,
  type CompactionRunPlan,
  type StateHistoryCompactionPlan,
} from "./state-history-compaction";

export const COMPACTION_KILL_SWITCH_ENV = "STATE_HISTORY_COMPACTION_ABORT";
export const COMPACTION_LEASE_TTL_MS = 15 * 60_000;

const MIN_BATCH_RUN_LIMIT = 1;
const MAX_BATCH_RUN_LIMIT = 1_000;
const MIN_STATEMENT_TIMEOUT_MS = 1_000;
const MAX_STATEMENT_TIMEOUT_MS = 600_000;

export interface CompactionExecutionResult {
  status:
    | "completed"
    | "completed_with_skips"
    | "refused"
    | "aborted_kill_switch"
    | "batch_validation_failed"
    | "equivalence_failed";
  refusalReason: string | null;
  planHash: string | null;
  batchesExecuted: number;
  /** Runs whose rows this invocation actually deleted. */
  runsDeleted: number;
  rowsDeleted: number;
  /** Resume targets: planned runs found already empty (prior invocation). */
  runsAlreadyEmpty: number;
  /** Runs skipped because a pin appeared after planning. */
  runsSkippedPinned: number;
  equivalence: { checked: boolean; mismatchedScopes: string[] };
}

interface PlannedRun extends CompactionRunPlan {
  businessId: string;
  providerAccountId: string;
  entityType: string;
  endpoint: string;
}

function zeroResult(
  status: CompactionExecutionResult["status"],
  refusalReason: string | null,
  planHash: string | null,
): CompactionExecutionResult {
  return {
    status,
    refusalReason,
    planHash,
    batchesExecuted: 0,
    runsDeleted: 0,
    rowsDeleted: 0,
    runsAlreadyEmpty: 0,
    runsSkippedPinned: 0,
    equivalence: { checked: false, mismatchedScopes: [] },
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

class BatchValidationError extends Error {
  constructor(
    readonly reason: string,
    readonly runId: string | null,
  ) {
    super(`state-history compaction batch validation failed: ${reason}`);
    this.name = "BatchValidationError";
  }
}

export async function executeStateHistoryCompaction(input: {
  plan: StateHistoryCompactionPlan;
  approvalToken: string;
  /**
   * Always required. This is an on-the-record acknowledgement, never an
   * override: DELETE alone cannot shrink pg_total_relation_size, so the
   * physical-shrink step (REINDEX CONCURRENTLY / pg_repack / VACUUM FULL)
   * remains outstanding after a successful run. A plan whose free-space
   * proof is unavailable is refused regardless of this flag.
   */
  acknowledgePhysicalShrinkRequired: boolean;
  batchRunLimit?: number;
  statementTimeoutMs?: number;
  shouldAbort?: () => boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<CompactionExecutionResult> {
  const { plan } = input;
  const env = input.env ?? process.env;

  /* ---------------- Validation phase: ZERO writes on any failure. -------- */

  if (plan?.contract !== STATE_HISTORY_COMPACTION_CONTRACT) {
    return zeroResult("refused", "unknown_plan_contract", null);
  }
  const recomputedHash = computeExecutionPayloadHash({
    contract: plan.contract,
    businessIds: plan.businessIds,
    scopes: plan.scopes,
    timelines: plan.timelines,
    totals: plan.totals,
    fence: plan.fence,
    fenceProjection: plan.fenceProjection,
    status: plan.status,
    insufficiencyReasons: plan.insufficiencyReasons,
    scopeFingerprint: plan.scopeFingerprint,
  });
  if (recomputedHash !== plan.planHash) {
    return zeroResult("refused", "plan_payload_tampered", null);
  }
  if (input.approvalToken !== expectedApprovalToken(recomputedHash)) {
    return zeroResult("refused", "approval_token_mismatch", recomputedHash);
  }
  if (input.acknowledgePhysicalShrinkRequired !== true) {
    return zeroResult(
      "refused",
      "physical_shrink_acknowledgement_required",
      recomputedHash,
    );
  }
  if (plan.businessIds.length === 0) {
    return zeroResult("refused", "global_or_unresolved_scope", recomputedHash);
  }
  // Strict readiness: insufficient evidence is never executable — proof of
  // reusable space (and therefore a meaningful clearance projection) must
  // exist BEFORE approval, not be acknowledged away.
  if (plan.status !== "ready") {
    return zeroResult("refused", `plan_not_ready:${plan.status}`, recomputedHash);
  }
  if (plan.fenceProjection.effectiveReusableHeap.cleared !== true) {
    return zeroResult(
      "refused",
      "projected_reclaim_does_not_clear_fence",
      recomputedHash,
    );
  }
  const batchRunLimit = input.batchRunLimit ?? 200;
  if (
    !Number.isSafeInteger(batchRunLimit) ||
    batchRunLimit < MIN_BATCH_RUN_LIMIT ||
    batchRunLimit > MAX_BATCH_RUN_LIMIT
  ) {
    return zeroResult("refused", "invalid_batch_run_limit", recomputedHash);
  }
  const statementTimeoutMs = input.statementTimeoutMs ?? 120_000;
  if (
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < MIN_STATEMENT_TIMEOUT_MS ||
    statementTimeoutMs > MAX_STATEMENT_TIMEOUT_MS
  ) {
    return zeroResult("refused", "invalid_statement_timeout", recomputedHash);
  }
  const businessIdSet = new Set(plan.businessIds);
  const plannedRuns: PlannedRun[] = [];
  const seenRunIds = new Set<string>();
  for (const scope of plan.scopes) {
    if (!businessIdSet.has(scope.businessId)) {
      return zeroResult("refused", "scope_outside_business_ids", recomputedHash);
    }
    for (const run of scope.removable) {
      if (seenRunIds.has(run.runId)) {
        return zeroResult("refused", "duplicate_planned_run", recomputedHash);
      }
      seenRunIds.add(run.runId);
      plannedRuns.push({
        ...run,
        businessId: scope.businessId,
        providerAccountId: scope.providerAccountId,
        entityType: scope.entityType,
        endpoint: scope.endpoint,
      });
    }
  }

  /* ---------------- Authoritative pre-write policy proof. ----------------
   * The received plan's hash/token consistency above proves only that the
   * OPERATOR approved exactly this payload — the approval token is an
   * on-the-record acknowledgement bound to one artifact, NOT cryptographic
   * provenance: anyone can edit policy fields (status, totals, projection,
   * clearance) and recompute a consistent hash+token. So before ANY write —
   * lease and journal included — the executor re-derives the authoritative
   * plan from the database itself, in one REPEATABLE READ READ ONLY
   * transaction through the production planner, and requires the incoming
   * payload to match that authoritative result exactly (same canonical
   * hash, which binds scope, scopes/removable sets, all protection counts,
   * timelines, fingerprint, fence measurement, projection, insufficiency
   * reasons, and status). Incoming arithmetic and clearance flags are never
   * trusted.
   *
   * Resume rule: the equality gate applies to a plan's FIRST admission. A
   * resume (this planHash already has a 'planned' journal row and is not
   * completed) skips the re-plan equality — deletions from the earlier
   * batches have legitimately changed the world — and relies on the same
   * per-batch full revalidation that admitted it, plus the lease and the
   * completed-plan block. A forged plan can never reach resume: its first
   * admission refuses here, before any journal row exists for its hash.
   */
  let previouslyAdmitted = false;
  try {
    const admitted = await getDb().query<{ n: unknown }>(
      `SELECT COUNT(*)::int AS n
       FROM meta_state_history_compaction_journal
       WHERE plan_hash = $1 AND event = 'planned'`,
      [recomputedHash],
    );
    previouslyAdmitted = Number(admitted[0]?.n ?? 0) > 0;
  } catch (error) {
    return zeroResult(
      "refused",
      `authoritative_replan_failed:journal_read:${error instanceof Error ? error.message : String(error)}`,
      recomputedHash,
    );
  }
  if (!previouslyAdmitted) {
    let authoritativeHash: string;
    try {
      const authoritative = await runDbTransaction(async () => {
        const db = getDb();
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return planStateHistoryCompaction(db, {
          businessIds: plan.businessIds,
        });
      });
      authoritativeHash = authoritative.planHash;
      if (authoritative.status !== "ready") {
        return zeroResult(
          "refused",
          `authoritative_replan_not_ready:${authoritative.status}`,
          recomputedHash,
        );
      }
    } catch (error) {
      return zeroResult(
        "refused",
        `authoritative_replan_failed:${error instanceof Error ? error.message : String(error)}`,
        recomputedHash,
      );
    }
    if (authoritativeHash !== recomputedHash) {
      return zeroResult(
        "refused",
        "authoritative_replan_mismatch",
        recomputedHash,
      );
    }
  }

  /* ---------------- Leased execution phase (journaled). ------------------ */

  const journal = async (entry: {
    event:
      | "planned"
      | "lease_acquired"
      | "lease_renewed"
      | "lease_released"
      | "batch_deleted"
      | "completed"
      | "completed_with_skips"
      | "refused"
      | "equivalence_failed"
      | "kill_switch";
    batchIndex?: number | null;
    runsDeleted?: number | null;
    rowsDeleted?: number | null;
    detail?: Record<string, unknown> | null;
  }) => {
    await getDb().query(
      `INSERT INTO meta_state_history_compaction_journal (
         plan_hash, plan_contract, business_ids, event, batch_index,
         runs_deleted, rows_deleted, detail_json
       ) VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8::jsonb)`,
      [
        recomputedHash,
        plan.contract,
        plan.businessIds,
        entry.event,
        entry.batchIndex ?? null,
        entry.runsDeleted ?? null,
        entry.rowsDeleted ?? null,
        entry.detail == null ? null : JSON.stringify(entry.detail),
      ],
    );
  };

  const leaseId = randomUUID();
  // Atomic lease acquisition: under the advisory lock, refuse when another
  // unexpired lease exists for ANY plan, or this plan already completed.
  const leased = await runDbTransaction(async () => {
    const db = getDb();
    await db.query(`SELECT pg_advisory_xact_lock($1)`, [
      STATE_HISTORY_COMPACTION_LOCK_KEY,
    ]);
    const completed = await db.query<{ n: unknown }>(
      `SELECT COUNT(*)::int AS n FROM meta_state_history_compaction_journal
       WHERE plan_hash = $1 AND event IN ('completed', 'completed_with_skips')`,
      [recomputedHash],
    );
    if (Number(completed[0]?.n ?? 0) > 0) return "plan_already_completed";
    const activeLease = await db.query<{ n: unknown }>(
      `SELECT COUNT(*)::int AS n
       FROM meta_state_history_compaction_journal acquired
       WHERE acquired.event IN ('lease_acquired', 'lease_renewed')
         AND acquired.created_at > now() - ($1 || ' milliseconds')::interval
         AND NOT EXISTS (
           SELECT 1 FROM meta_state_history_compaction_journal released
           WHERE released.event = 'lease_released'
             AND released.detail_json->>'leaseId' = acquired.detail_json->>'leaseId'
         )`,
      [String(COMPACTION_LEASE_TTL_MS)],
    );
    if (Number(activeLease[0]?.n ?? 0) > 0) return "another_executor_active";
    await db.query(
      `INSERT INTO meta_state_history_compaction_journal (
         plan_hash, plan_contract, business_ids, event, detail_json
       ) VALUES ($1, $2, $3::text[], 'lease_acquired', $4::jsonb)`,
      [
        recomputedHash,
        plan.contract,
        plan.businessIds,
        JSON.stringify({ leaseId, ttlMs: COMPACTION_LEASE_TTL_MS }),
      ],
    );
    return "acquired";
  });
  if (leased !== "acquired") {
    return zeroResult("refused", leased, recomputedHash);
  }

  const releaseLease = async () => {
    await journal({ event: "lease_released", detail: { leaseId } });
  };

  // Staleness: the plan binds a scope fingerprint (per-scope complete-run
  // census). A world that changed since planning gets a fresh plan, not a
  // best-effort execution of an old one.
  const liveFingerprint = await computeScopeFingerprint(
    getDb(),
    plan.businessIds,
  );
  if (liveFingerprint !== plan.scopeFingerprint) {
    await journal({
      event: "refused",
      detail: { leaseId, reason: "stale_plan_scope_changed" },
    });
    await releaseLease();
    return zeroResult("refused", "stale_plan_scope_changed", recomputedHash);
  }

  const archivedSchemaPresent = await detectArchivedLineageSchema(getDb());
  const pinnedSql = pinnedExistsSql(archivedSchemaPresent, "s2");

  await journal({
    event: "planned",
    detail: {
      totals: plan.totals,
      status: plan.status,
      leaseId,
      fenceMetric: plan.fence.metric,
      acknowledgePhysicalShrinkRequired: true,
    },
  });

  const batches = chunk(plannedRuns, batchRunLimit);
  let batchesExecuted = 0;
  let runsDeleted = 0;
  let rowsDeleted = 0;
  let runsAlreadyEmpty = 0;
  let runsSkippedPinned = 0;

  for (const [batchIndex, batch] of batches.entries()) {
    if (input.shouldAbort?.() || env[COMPACTION_KILL_SWITCH_ENV] === "1") {
      await journal({
        event: "kill_switch",
        batchIndex,
        detail: { leaseId, remainingBatches: batches.length - batchIndex },
      });
      await releaseLease();
      return {
        status: "aborted_kill_switch",
        refusalReason: null,
        planHash: recomputedHash,
        batchesExecuted,
        runsDeleted,
        rowsDeleted,
        runsAlreadyEmpty,
        runsSkippedPinned,
        equivalence: { checked: false, mismatchedScopes: [] },
      };
    }

    let batchOutcome: {
      deletedRuns: number;
      deletedRows: number;
      alreadyEmpty: number;
      pinnedNow: string[];
    };
    try {
      batchOutcome = await runDbTransaction(async () => {
        const db = getDb();
        await db.query(
          `SET LOCAL statement_timeout = '${Math.floor(statementTimeoutMs)}ms'`,
        );
        await db.query(`SET LOCAL lock_timeout = '10s'`);
        // Lease ownership recheck + renewal, serialized by the advisory lock
        // so a competing acquisition cannot interleave with it.
        await db.query(`SELECT pg_advisory_xact_lock($1)`, [
          STATE_HISTORY_COMPACTION_LOCK_KEY,
        ]);
        const newestLease = await db.query<{ lease_id: string | null }>(
          `SELECT detail_json->>'leaseId' AS lease_id
           FROM meta_state_history_compaction_journal
           WHERE event IN ('lease_acquired', 'lease_renewed')
             AND created_at > now() - ($1 || ' milliseconds')::interval
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [String(COMPACTION_LEASE_TTL_MS)],
        );
        if (newestLease[0]?.lease_id !== leaseId) {
          throw new BatchValidationError("lease_lost", null);
        }
        await db.query(
          `INSERT INTO meta_state_history_compaction_journal (
             plan_hash, plan_contract, business_ids, event, batch_index, detail_json
           ) VALUES ($1, $2, $3::text[], 'lease_renewed', $4, $5::jsonb)`,
          [
            recomputedHash,
            plan.contract,
            plan.businessIds,
            batchIndex,
            JSON.stringify({ leaseId }),
          ],
        );

        // Full revalidation of every run in this batch, in one statement:
        // scope identity, current row count, current manifest signature, an
        // identical retained EARLIER manifest in the same scope, a retained
        // NEWER run with rows (non-head proof), and pin freedom.
        const runIds = batch.map((run) => run.runId);
        const current = await db.query<{
          run_id: string;
          business_id: string;
          provider_account_id: string;
          entity_type: string;
          endpoint: string;
          physical_rows: unknown;
          manifest_sig: string | null;
          has_newer_with_rows: unknown;
          pinned: unknown;
        }>(
          `
          SELECT r.id::text AS run_id, r.business_id, r.provider_account_id,
            r.entity_type, r.endpoint,
            COUNT(s.id)::int AS physical_rows,
            md5(string_agg(s.entity_id || ':' || s.state_hash, '|' ORDER BY s.entity_id)) AS manifest_sig,
            EXISTS (
              SELECT 1 FROM meta_entity_observation_runs newer
              WHERE newer.completeness = 'complete'
                AND newer.business_id = r.business_id
                AND newer.provider_account_id = r.provider_account_id
                AND newer.entity_type = r.entity_type
                AND newer.endpoint = r.endpoint
                AND (newer.captured_at, newer.id) > (r.captured_at, r.id)
                AND EXISTS (SELECT 1 FROM meta_entity_state_history ns WHERE ns.run_id = newer.id)
            ) AS has_newer_with_rows,
            EXISTS (
              SELECT 1 FROM meta_entity_state_history s2
              WHERE s2.run_id = r.id AND (${pinnedSql})
            ) AS pinned
          FROM meta_entity_observation_runs r
          LEFT JOIN meta_entity_state_history s ON s.run_id = r.id
          WHERE r.id = ANY($1::uuid[])
          GROUP BY r.id, r.business_id, r.provider_account_id, r.entity_type,
            r.endpoint, r.captured_at
          `,
          [runIds],
        );
        const byRunId = new Map(current.map((row) => [row.run_id, row]));
        const deletable: string[] = [];
        let alreadyEmpty = 0;
        const pinnedNow: string[] = [];
        let expectedRows = 0;
        for (const planned of batch) {
          const row = byRunId.get(planned.runId);
          if (!row) throw new BatchValidationError("run_missing", planned.runId);
          if (
            row.business_id !== planned.businessId ||
            row.provider_account_id !== planned.providerAccountId ||
            row.entity_type !== planned.entityType ||
            row.endpoint !== planned.endpoint
          ) {
            throw new BatchValidationError("run_scope_mismatch", planned.runId);
          }
          const physicalRows = Number(row.physical_rows ?? 0);
          if (physicalRows === 0) {
            // Idempotent resume: a prior invocation already emptied it.
            alreadyEmpty += 1;
            continue;
          }
          const pinned = row.pinned === true || row.pinned === "t";
          if (pinned) {
            pinnedNow.push(planned.runId);
            continue;
          }
          if (physicalRows !== planned.physicalRows) {
            throw new BatchValidationError("run_row_count_drift", planned.runId);
          }
          if (row.manifest_sig !== planned.manifestSig) {
            throw new BatchValidationError("run_signature_drift", planned.runId);
          }
          if (!(row.has_newer_with_rows === true || row.has_newer_with_rows === "t")) {
            throw new BatchValidationError("run_is_scope_head", planned.runId);
          }
          deletable.push(planned.runId);
          expectedRows += physicalRows;
        }
        // Interleave recheck bound in-transaction: a partial/point-lookup row
        // that arrived (or was backdated) into (previousObservedAt,
        // observedAt] since planning makes the duplicate load-bearing for
        // mixed-lane as-of reads.
        for (const planned of batch) {
          if (!deletable.includes(planned.runId)) continue;
          const interleaved = await db.query<{ n: unknown }>(
            `SELECT COUNT(*)::int AS n FROM meta_entity_state_history interleaved
             WHERE interleaved.business_id = $1
               AND interleaved.provider_account_id = $2
               AND interleaved.entity_type = $3
               AND interleaved.run_completeness IN ('partial', 'point_lookup')
               AND interleaved.observed_at > $4::timestamptz
               AND interleaved.observed_at <= $5::timestamptz`,
            [
              planned.businessId,
              planned.providerAccountId,
              planned.entityType,
              planned.previousObservedAt,
              planned.observedAt,
            ],
          );
          if (Number(interleaved[0]?.n ?? 0) > 0) {
            throw new BatchValidationError(
              "interleaved_partial_appeared",
              planned.runId,
            );
          }
        }
        // Identical retained-predecessor proof for every run this batch will
        // delete: an EARLIER complete run of the same scope, still holding
        // rows, whose manifest signature equals the planned signature. This
        // is the semantic-equivalence guarantee bound INSIDE the transaction:
        // the content being deleted provably survives in an older run.
        if (deletable.length > 0) {
          const sigs = deletable.map(
            (runId) =>
              batch.find((planned) => planned.runId === runId)!.manifestSig,
          );
          const predecessorProof = await db.query<{ run_id: string }>(
            `
            SELECT pair.run_id::text AS run_id
            FROM unnest($1::uuid[], $2::text[]) AS pair(run_id, sig)
            JOIN meta_entity_observation_runs r ON r.id = pair.run_id
            WHERE EXISTS (
              SELECT 1
              FROM meta_entity_observation_runs earlier
              JOIN meta_entity_state_history es ON es.run_id = earlier.id
              WHERE earlier.completeness = 'complete'
                AND earlier.business_id = r.business_id
                AND earlier.provider_account_id = r.provider_account_id
                AND earlier.entity_type = r.entity_type
                AND earlier.endpoint = r.endpoint
                AND (earlier.captured_at, earlier.id) < (r.captured_at, r.id)
              GROUP BY earlier.id
              HAVING md5(string_agg(es.entity_id || ':' || es.state_hash, '|' ORDER BY es.entity_id)) = pair.sig
            )
            `,
            [deletable, sigs],
          );
          const proven = new Set(predecessorProof.map((row) => row.run_id));
          const unproven = deletable.find((runId) => !proven.has(runId));
          if (unproven) {
            throw new BatchValidationError(
              "no_identical_retained_predecessor",
              unproven,
            );
          }
        }
        const deleted = await db.query<{ n: unknown }>(
          `WITH removed AS (
             DELETE FROM meta_entity_state_history
             WHERE run_id = ANY($1::uuid[])
             RETURNING 1
           ) SELECT COUNT(*)::bigint AS n FROM removed`,
          [deletable],
        );
        const deletedRows = Number(deleted[0]?.n ?? 0);
        if (deletedRows !== expectedRows) {
          // Rolls the whole batch back — accounting must be exact.
          throw new BatchValidationError("deleted_row_count_mismatch", null);
        }
        return {
          deletedRuns: deletable.length,
          deletedRows,
          alreadyEmpty,
          pinnedNow,
        };
      });
    } catch (error) {
      const reason =
        error instanceof BatchValidationError
          ? `${error.reason}${error.runId ? `:${error.runId}` : ""}`
          : `batch_error:${error instanceof Error ? error.message : String(error)}`;
      await journal({
        event: "refused",
        batchIndex,
        detail: { leaseId, reason, rolledBack: true },
      });
      await releaseLease();
      return {
        status: "batch_validation_failed",
        refusalReason: reason,
        planHash: recomputedHash,
        batchesExecuted,
        runsDeleted,
        rowsDeleted,
        runsAlreadyEmpty,
        runsSkippedPinned,
        equivalence: { checked: false, mismatchedScopes: [] },
      };
    }

    batchesExecuted += 1;
    runsDeleted += batchOutcome.deletedRuns;
    rowsDeleted += batchOutcome.deletedRows;
    runsAlreadyEmpty += batchOutcome.alreadyEmpty;
    runsSkippedPinned += batchOutcome.pinnedNow.length;
    await journal({
      event: "batch_deleted",
      batchIndex,
      runsDeleted: batchOutcome.deletedRuns,
      rowsDeleted: batchOutcome.deletedRows,
      detail: {
        leaseId,
        alreadyEmpty: batchOutcome.alreadyEmpty,
        skippedPinnedRuns: batchOutcome.pinnedNow,
      },
    });
  }

  // Defense-in-depth: the per-batch identical-predecessor proofs already
  // guarantee this, but recompute the whole distinct-state timeline anyway.
  const after = await computeTimelineHashes(getDb(), plan.businessIds);
  const afterByScope = new Map(
    after.map((row) => [
      `${row.businessId} ${row.providerAccountId} ${row.entityType}`,
      row.timelineHash,
    ]),
  );
  const mismatchedScopes = plan.timelines
    .filter(
      (row) =>
        afterByScope.get(
          `${row.businessId} ${row.providerAccountId} ${row.entityType}`,
        ) !== row.timelineHash,
    )
    .map(
      (row) => `${row.businessId}/${row.providerAccountId}/${row.entityType}`,
    );
  if (mismatchedScopes.length > 0) {
    await journal({
      event: "equivalence_failed",
      detail: { leaseId, mismatchedScopes, rowsDeleted, runsDeleted },
    });
    await releaseLease();
    return {
      status: "equivalence_failed",
      refusalReason: null,
      planHash: recomputedHash,
      batchesExecuted,
      runsDeleted,
      rowsDeleted,
      runsAlreadyEmpty,
      runsSkippedPinned,
      equivalence: { checked: true, mismatchedScopes },
    };
  }

  const status = runsSkippedPinned > 0 ? "completed_with_skips" : "completed";
  await journal({
    event: status,
    runsDeleted,
    rowsDeleted,
    detail: {
      leaseId,
      batchesExecuted,
      runsAlreadyEmpty,
      runsSkippedPinned,
      plannedRemovableRows: plan.totals.removableRows,
    },
  });
  await releaseLease();
  return {
    status,
    refusalReason: null,
    planHash: recomputedHash,
    batchesExecuted,
    runsDeleted,
    rowsDeleted,
    runsAlreadyEmpty,
    runsSkippedPinned,
    equivalence: { checked: true, mismatchedScopes: [] },
  };
}
