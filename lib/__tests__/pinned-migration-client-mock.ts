/**
 * THE PINNED MIGRATION LEASE, AS A TEST DOUBLE.
 *
 * ── ROUND 20, ITEM 3 ────────────────────────────────────────────────────────
 * `runMigrations` leases ONE PoolClient for the whole run and proves a
 * `lock_timeout` on it before any DDL. The SQL-capture suites drive the
 * migration against a fake client, so they need a lease-shaped fake: one that
 * records every statement the way their own `sql` mock does, and answers the
 * session read-back that cross-checks the raw `lock_timeout` in milliseconds
 * and the backend PID. SQL-capture suites may explicitly opt into a small
 * catalog fixture for the migration's relation/index size measurements.
 *
 * It is deliberately NOT permissive. The read-back it returns is the value the
 * caller says it expects, so a suite cannot accidentally prove the fail-closed
 * check by feeding it agreement it did not ask for; the real negative controls
 * for that check live in the ephemeral-PostgreSQL seams, where a genuine
 * backend answers.
 */

/** The PID the fake lease reports. Arbitrary, but stable and non-zero. */
export const MIGRATION_MOCK_BACKEND_PID = 424_242;

/** Default `MIGRATION_LOCK_TIMEOUT_MS` when the environment sets none. */
export const MIGRATION_DEFAULT_LOCK_TIMEOUT_MS = 15_000;

type CapturingSql = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

type MigrationClientMockOptions = {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  backendPid?: number;
  catalog?: "small";
};

// An independent, fixed fixture contract: a migration that changes the query's
// table/index identity or key must update its catalog fixture deliberately.
const META_HISTORY_DELTA_KEY =
  "business_id, provider_account_id, entity_type, run_completeness, entity_id, captured_at DESC, created_at DESC, id DESC";
const META_HISTORY_SIZE_QUERY = `SELECT pg_total_relation_size('meta_entity_state_history'::regclass)::bigint AS relation_bytes,
  COALESCE(pg_relation_size(to_regclass('idx_meta_entity_state_history_manifest_delta')), 0)::bigint AS index_bytes,
  EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid=to_regclass('idx_meta_entity_state_history_manifest_delta')
      AND i.indrelid='meta_entity_state_history'::regclass
      AND i.indisvalid AND i.indisready AND i.indislive
      AND strpos(pg_get_indexdef(i.indexrelid), $1) > 0) AS index_valid`;
const CAPACITY_SIZE_QUERY = `SELECT COALESCE(pg_total_relation_size(to_regclass($1)), 0)::bigint AS relation_bytes,
  pg_database_size(current_database())::bigint AS database_bytes`;
// Explicit pre-existing FK access fixture for SQL-capture suites. Actual
// missing-index creation/refusal and plans are tested against real PostgreSQL.
const ERASURE_REFERENCE_FIXTURE = new Set([
  "engine_v3_ad_account_calibration_batches.job_run_id:idx_biz_erase_calibration_batch_job",
  "engine_v3_ad_account_calibration_daily.job_run_id:idx_biz_erase_ad_calibration_job",
  "engine_v3_ad_decision_events.decision_snapshot_id:idx_biz_erase_ad_event_snapshot",
  "engine_v3_ad_decision_outcomes_daily.decision_snapshot_id:idx_biz_erase_ad_outcome_snapshot",
  "engine_v3_ad_decision_snapshots_daily.calibration_row_id:idx_biz_erase_ad_snapshot_calibration",
  "engine_v3_ad_decision_evaluations.campaign_context_ref:idx_biz_erase_campaign_reference",
  "engine_v3_account_calibration_daily.job_run_id:idx_biz_erase_fk_7df07df156e8",
  "engine_v3_ad_decision_events.job_run_id:idx_biz_erase_fk_8bd033a67700",
  "engine_v3_ad_decision_outcomes_daily.job_run_id:idx_biz_erase_fk_291b511f25e9",
  "engine_v3_ad_decision_snapshots_daily.job_run_id:idx_biz_erase_fk_4df3a44b115a",
  "engine_v3_ad_operator_response_events.job_run_id:idx_biz_erase_fk_abc142c09034",
  "engine_v3_ad_operator_responses.job_run_id:idx_biz_erase_fk_ba068cfc8534",
  "engine_v3_campaign_context_daily.job_run_id:idx_biz_erase_fk_cdca4015f3f9",
  "engine_v3_creative_lifecycle_daily.job_run_id:idx_biz_erase_fk_617724a9c545",
  "engine_v3_decision_events.decision_snapshot_id:idx_biz_erase_fk_0abe983b3cbe",
  "engine_v3_decision_events.job_run_id:idx_biz_erase_fk_69a9118c5b65",
  "engine_v3_decision_outcomes_daily.job_run_id:idx_biz_erase_fk_fef4793b40b0",
  "engine_v3_decision_snapshots_daily.calibration_row_id:idx_biz_erase_fk_d4c1198906eb",
  "engine_v3_decision_snapshots_daily.job_run_id:idx_biz_erase_fk_c1735fe2613c",
  "engine_v3_decision_snapshots_daily.lifecycle_row_id:idx_biz_erase_fk_cc969935d222",
  "engine_v3_job_runs.dependency_run_id:idx_biz_erase_fk_ab49b4f5cc2b",
  "meta_account_daily.source_snapshot_id:idx_biz_erase_fk_a7a20f358f65",
  "meta_ad_daily.source_snapshot_id:idx_biz_erase_fk_686bef2721c4",
  "meta_adset_config_history.source_snapshot_id:idx_biz_erase_fk_42ef15999a34",
  "meta_adset_daily.source_snapshot_id:idx_biz_erase_fk_0ee10e1df934",
  "meta_authoritative_reconciliation_events.manifest_id:idx_biz_erase_fk_8786652778a2",
  "meta_authoritative_reconciliation_events.slice_version_id:idx_biz_erase_fk_c899e20faf22",
  "meta_breakdown_daily.source_snapshot_id:idx_biz_erase_fk_534d58421b12",
  "meta_campaign_config_history.source_snapshot_id:idx_biz_erase_fk_7e93dd17deec",
  "meta_campaign_daily.source_snapshot_id:idx_biz_erase_fk_8b5862293a5b",
  "meta_creative_daily.source_snapshot_id:idx_biz_erase_fk_b7a6c62573f3",
  "meta_entity_observation_receipts.run_id:idx_biz_erase_fk_c64f82d26a43",
  "meta_entity_observation_receipts.source_snapshot_ref_id:idx_biz_erase_fk_6d2ec8f8fa12",
  "meta_entity_observation_receipts_v2.run_id:idx_biz_erase_fk_5b859b87dee5",
  "meta_entity_observation_receipts_v2.source_snapshot_ref_id:idx_biz_erase_fk_14d1d173410d",
  "meta_entity_observation_receipts_v2.sync_run_id:idx_biz_erase_fk_50915a253220",
  "meta_raw_snapshot_observations.partition_id:idx_biz_erase_fk_9e077f2b0ee7",
  "meta_raw_snapshots.checkpoint_id:idx_biz_erase_fk_aea32a54dfa8",
]);
const normalizeSql = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Wrap a suite's own capturing `sql` mock in the `withPinnedDbClient` callback
 * shape. Statements still land in that mock, so existing emitted-SQL assertions
 * keep working unchanged.
 */
export function pinnedMigrationClientOver(
  sql: CapturingSql,
  options?: MigrationClientMockOptions,
) {
  const lockTimeoutMs =
    options?.lockTimeoutMs ?? MIGRATION_DEFAULT_LOCK_TIMEOUT_MS;
  const statementTimeoutMs = options?.statementTimeoutMs ?? 60_000;
  const backendPid = options?.backendPid ?? MIGRATION_MOCK_BACKEND_PID;
  let metaHistoryDeltaIndexExists = false;
  return {
    backendPid,
    query: async (text: string, params?: unknown[]) => {
      // Delegated first, so the statement is CAPTURED even when the fake
      // supplies the rows -- a suite asserting on emitted SQL must still see
      // the session read-back it ran.
      const delegated = await sql.query(text, params);
      if (/lock_timeout_ms/.test(text)) {
        return {
          rows: [
            {
              lock_timeout: `${lockTimeoutMs / 1000}s`,
              statement_timeout: `${statementTimeoutMs / 1000}s`,
              idle_timeout: "0",
              backend_pid: backendPid,
              lock_timeout_ms: String(lockTimeoutMs),
              statement_timeout_ms: String(statementTimeoutMs),
            },
          ],
        };
      }
      if (options?.catalog === "small") {
        const statement = normalizeSql(text);
        // Model the actual CREATE transition, not a permanent index-valid
        // answer. Delegated errors still throw before the fixture advances.
        if (statement === `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_entity_state_history_manifest_delta ON meta_entity_state_history (${META_HISTORY_DELTA_KEY})`) {
          metaHistoryDeltaIndexExists = true;
        }
        if (statement === "DROP INDEX CONCURRENTLY IF EXISTS idx_meta_entity_state_history_manifest_delta") {
          metaHistoryDeltaIndexExists = false;
        }
        // Explicit responses, including malformed measurements, are never
        // replaced with a healthy fixture. Real guards must still reject them.
        if (Array.isArray(delegated) && delegated.length === 0) {
          if (statement.includes("AS reference_foreign_key") && statement.includes("AS named_index_conflict")
            && params?.length === 4 && ERASURE_REFERENCE_FIXTURE.has(`${params[0]}.${params[1]}:${params[2]}`)) {
            return { rows: [{ relation_kind: "r", key_type: params?.[3] === "hash" ? 17 : 2950, reference_foreign_key: true,
              lookup_ready: true, named_index_conflict: false }] };
          }
          if (statement === normalizeSql(META_HISTORY_SIZE_QUERY) &&
              params?.length === 1 && params[0] === META_HISTORY_DELTA_KEY) {
            return { rows: [{
              relation_bytes: metaHistoryDeltaIndexExists ? "16384" : "8192",
              index_bytes: metaHistoryDeltaIndexExists ? "8192" : "0",
              index_valid: metaHistoryDeltaIndexExists,
            }] };
          }
          if (statement === normalizeSql(CAPACITY_SIZE_QUERY) && params?.length === 1 &&
              (params[0] === "sync_release_gates" || params[0] === "meta_entity_state_history")) {
            return { rows: [{
              relation_bytes: params[0] === "meta_entity_state_history" && metaHistoryDeltaIndexExists ? "16384" : "8192",
              database_bytes: "1073741824",
            }] };
          }
        }
      }
      return { rows: Array.isArray(delegated) ? delegated : [] };
    },
  };
}

/**
 * The full `@/lib/db` mock surface the migration runner touches. Kept in one
 * place so a future export cannot go missing from five separate factories --
 * which is exactly how these suites came to fail: Round 18 introduced
 * `withPinnedDbClient` in production and no mock grew it.
 */
export function migrationDbMockModule(
  sql: CapturingSql,
  options?: Omit<MigrationClientMockOptions, "statementTimeoutMs">,
) {
  return {
    getDb: () => sql,
    getDbWithTimeout: () => sql,
    runDbTransaction: async (operation: () => Promise<unknown>) => operation(),
    withPinnedDbClient: async <T>(
      fn: (client: ReturnType<typeof pinnedMigrationClientOver>) => Promise<T>,
      leaseOptions?: { timeoutMs?: number },
    ) =>
      fn(
        pinnedMigrationClientOver(sql, {
          ...options,
          statementTimeoutMs: leaseOptions?.timeoutMs,
        }),
      ),
    runPinnedDbTransaction: async <T>(input: {
      fn: (db: unknown) => Promise<T>;
    }) => input.fn(sql),
  };
}
