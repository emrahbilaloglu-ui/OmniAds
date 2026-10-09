import type { DbClient } from "@/lib/db";

/** Reviewed FK-column lookups used by Meta/native whole-business erasure. */
export const BUSINESS_ERASURE_REFERENCE_INDEXES = [
  // Composite lineage FKs still need their selective parent UUID as a leading
  // lookup after child-first deletes; an owner/date residual repeats dead rows.
  { table: "engine_v3_ad_account_calibration_batches", column: "job_run_id", index: "idx_biz_erase_calibration_batch_job" },
  { table: "engine_v3_ad_account_calibration_daily", column: "job_run_id", index: "idx_biz_erase_ad_calibration_job" },
  { table: "engine_v3_ad_decision_events", column: "decision_snapshot_id", index: "idx_biz_erase_ad_event_snapshot" },
  { table: "engine_v3_ad_decision_outcomes_daily", column: "decision_snapshot_id", index: "idx_biz_erase_ad_outcome_snapshot" },
  { table: "engine_v3_ad_decision_snapshots_daily", column: "calibration_row_id", index: "idx_biz_erase_ad_snapshot_calibration" },
  { table: "engine_v3_account_calibration_daily", column: "job_run_id", index: "idx_biz_erase_fk_7df07df156e8" },
  { table: "engine_v3_ad_decision_events", column: "job_run_id", index: "idx_biz_erase_fk_8bd033a67700" },
  { table: "engine_v3_ad_decision_outcomes_daily", column: "job_run_id", index: "idx_biz_erase_fk_291b511f25e9" },
  { table: "engine_v3_ad_decision_snapshots_daily", column: "job_run_id", index: "idx_biz_erase_fk_4df3a44b115a" },
  { table: "engine_v3_ad_operator_response_events", column: "job_run_id", index: "idx_biz_erase_fk_abc142c09034" },
  { table: "engine_v3_ad_operator_responses", column: "job_run_id", index: "idx_biz_erase_fk_ba068cfc8534" },
  { table: "engine_v3_campaign_context_daily", column: "job_run_id", index: "idx_biz_erase_fk_cdca4015f3f9" },
  { table: "engine_v3_creative_lifecycle_daily", column: "job_run_id", index: "idx_biz_erase_fk_617724a9c545" },
  { table: "engine_v3_decision_events", column: "decision_snapshot_id", index: "idx_biz_erase_fk_0abe983b3cbe" },
  { table: "engine_v3_decision_events", column: "job_run_id", index: "idx_biz_erase_fk_69a9118c5b65" },
  { table: "engine_v3_decision_outcomes_daily", column: "job_run_id", index: "idx_biz_erase_fk_fef4793b40b0" },
  { table: "engine_v3_decision_snapshots_daily", column: "calibration_row_id", index: "idx_biz_erase_fk_d4c1198906eb" },
  { table: "engine_v3_decision_snapshots_daily", column: "job_run_id", index: "idx_biz_erase_fk_c1735fe2613c" },
  { table: "engine_v3_decision_snapshots_daily", column: "lifecycle_row_id", index: "idx_biz_erase_fk_cc969935d222" },
  { table: "engine_v3_job_runs", column: "dependency_run_id", index: "idx_biz_erase_fk_ab49b4f5cc2b" },
  { table: "meta_account_daily", column: "source_snapshot_id", index: "idx_biz_erase_fk_a7a20f358f65" },
  { table: "meta_ad_daily", column: "source_snapshot_id", index: "idx_biz_erase_fk_686bef2721c4" },
  { table: "meta_adset_config_history", column: "source_snapshot_id", index: "idx_biz_erase_fk_42ef15999a34" },
  { table: "meta_adset_daily", column: "source_snapshot_id", index: "idx_biz_erase_fk_0ee10e1df934" },
  { table: "meta_authoritative_reconciliation_events", column: "manifest_id", index: "idx_biz_erase_fk_8786652778a2" },
  { table: "meta_authoritative_reconciliation_events", column: "slice_version_id", index: "idx_biz_erase_fk_c899e20faf22" },
  { table: "meta_breakdown_daily", column: "source_snapshot_id", index: "idx_biz_erase_fk_534d58421b12" },
  { table: "meta_campaign_config_history", column: "source_snapshot_id", index: "idx_biz_erase_fk_7e93dd17deec" },
  { table: "meta_campaign_daily", column: "source_snapshot_id", index: "idx_biz_erase_fk_8b5862293a5b" },
  { table: "meta_creative_daily", column: "source_snapshot_id", index: "idx_biz_erase_fk_b7a6c62573f3" },
  { table: "meta_entity_observation_receipts", column: "run_id", index: "idx_biz_erase_fk_c64f82d26a43" },
  { table: "meta_entity_observation_receipts", column: "source_snapshot_ref_id", index: "idx_biz_erase_fk_6d2ec8f8fa12" },
  { table: "meta_entity_observation_receipts_v2", column: "run_id", index: "idx_biz_erase_fk_5b859b87dee5" },
  { table: "meta_entity_observation_receipts_v2", column: "source_snapshot_ref_id", index: "idx_biz_erase_fk_14d1d173410d" },
  { table: "meta_entity_observation_receipts_v2", column: "sync_run_id", index: "idx_biz_erase_fk_50915a253220" },
  { table: "meta_raw_snapshot_observations", column: "partition_id", index: "idx_biz_erase_fk_9e077f2b0ee7" },
  { table: "meta_raw_snapshots", column: "checkpoint_id", index: "idx_biz_erase_fk_aea32a54dfa8" },
  // D157: account-binding RI predicates do not include business_ref_id.
  // A condition on a later UUID key still walks the whole owner-prefix index.
  // Lead with the fixed account UUID; the complete FK rechecks owner/text IDs.
  { table: "engine_v3_ad_operator_action_receipts", column: "provider_account_ref_id", index: "idx_biz_erase_binding_action_account" },
  { table: "engine_v3_ad_account_calibration_batches", column: "provider_account_ref_id", index: "idx_biz_erase_binding_cal_batch_account" },
  { table: "engine_v3_ad_account_calibration_daily", column: "provider_account_ref_id", index: "idx_biz_erase_binding_cal_daily_account" },
  { table: "engine_v3_ad_decision_evaluation_contexts", column: "provider_account_ref_id", index: "idx_biz_erase_binding_eval_context_account" },
  { table: "engine_v3_ad_decision_evaluations", column: "provider_account_ref_id", index: "idx_biz_erase_binding_evaluation_account" },
  { table: "engine_v3_ad_decision_events", column: "provider_account_ref_id", index: "idx_biz_erase_binding_event_account" },
  { table: "engine_v3_ad_decision_outcomes_daily", column: "provider_account_ref_id", index: "idx_biz_erase_binding_outcome_account" },
  { table: "engine_v3_ad_recommendation_episodes", column: "provider_account_ref_id", index: "idx_biz_erase_binding_episode_account" },
  { table: "engine_v3_ad_decision_snapshots_daily", column: "provider_account_ref_id", index: "idx_biz_erase_binding_snapshot_account" },
  // BYTEA has no validated width bound. Hash stores a fixed four-byte value
  // and rechecks equality; it must not use the scalar heap/TOAST sizing model.
  { table: "engine_v3_ad_decision_evaluations", column: "campaign_context_ref", index: "idx_biz_erase_campaign_reference", method: "hash" },
] as const;

// A valid raw leading key satisfies these scalar catalog contracts; actual
// compound RI plans still need independent acceptance (see D156). A full FK is not
// required. Only an absent index is built. Unknown/invalid named indexes are
// refused rather than dropped/rebuilt by offboarding.
export const BUSINESS_ERASURE_REFERENCE_INDEX_STATUS_SQL = `
  SELECT c.relkind AS relation_kind, a.atttypid::int AS key_type,
    EXISTS (SELECT 1 FROM pg_constraint fk WHERE fk.contype='f'
      AND fk.conrelid=c.oid AND a.attnum=ANY(fk.conkey))
      AS reference_foreign_key,
    EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
      JOIN pg_am am ON am.oid=ix.relam
      JOIN pg_opclass op ON op.oid=i.indclass[0]
      WHERE i.indrelid=c.oid AND am.amname=$4::text
        AND i.indisvalid AND i.indisready AND i.indislive
        AND i.indnkeyatts>=1 AND i.indkey[0]=a.attnum AND i.indexprs IS NULL
        AND op.opcdefault AND i.indcollation[0]=a.attcollation
        AND (i.indpred IS NULL OR pg_get_expr(i.indpred,i.indrelid)='('||a.attname||' IS NOT NULL)'))
      AS lookup_ready,
    EXISTS (SELECT 1 FROM pg_class named
      LEFT JOIN pg_index i ON i.indexrelid=named.oid
      LEFT JOIN pg_am am ON am.oid=named.relam
      LEFT JOIN pg_opclass op ON op.oid=i.indclass[0]
      WHERE named.oid=to_regclass(format('public.%I',$3::text))
        AND NOT COALESCE(i.indrelid=c.oid AND am.amname=$4::text
          AND i.indisvalid AND i.indisready AND i.indislive
          AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=a.attnum
          AND i.indexprs IS NULL AND op.opcdefault AND i.indcollation[0]=a.attcollation
          AND pg_get_expr(i.indpred,i.indrelid)='('||a.attname||' IS NOT NULL)',false))
      AS named_index_conflict
  FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE c.oid=to_regclass(format('public.%I',$1::text))
    AND a.attname=$2::text AND NOT a.attisdropped AND a.attnum>0
`;

type CatalogRow = {
  relation_kind: string; key_type: number; reference_foreign_key: boolean;
  lookup_ready: boolean; named_index_conflict: boolean;
};

/** Additive only; the caller must reserve physical build/sort/WAL capacity. */
export async function ensureBusinessErasureReferenceIndexes(
  sql: Pick<DbClient, "query">,
  admitScalarIndex: (relation: string, method: "btree" | "hash", column: string) => Promise<unknown>,
) {
  const built: string[] = [];
  const read = async (entry: (typeof BUSINESS_ERASURE_REFERENCE_INDEXES)[number]) => {
    const method = "method" in entry ? entry.method : "btree";
    const rows = await sql.query(BUSINESS_ERASURE_REFERENCE_INDEX_STATUS_SQL,
      [entry.table, entry.column, entry.index, method]) as CatalogRow[];
    const row = rows.length === 1 ? rows[0] : undefined;
    // Btree keys must be fixed-width bigint/integer/UUID. The one BYTEA
    // hash has a separate PK-coverage admission; text/expressions refuse.
    if (!row || !["r", "p"].includes(row.relation_kind)
      || !(method === "hash" ? row.relation_kind === "r" && row.key_type === 17 : [20, 23, 2950].includes(row.key_type))
      || row.reference_foreign_key !== true
      || typeof row.lookup_ready !== "boolean" || row.named_index_conflict !== false) {
      throw new Error(`business_erasure_reference_index_contract:${entry.table}.${entry.column}`);
    }
    return row;
  };
  for (const entry of BUSINESS_ERASURE_REFERENCE_INDEXES) {
    const before = await read(entry);
    if (before.lookup_ready) continue;
    const method = "method" in entry ? entry.method : "btree";
    await admitScalarIndex(`public.${entry.table}`, method, entry.column);
    // PostgreSQL cannot build a partitioned parent's index CONCURRENTLY.
    // Its child heap sum is capacity checked; the existing migration lock and
    // statement deadlines also apply to that ordinary parent/leaf DDL.
    const concurrently = before.relation_kind === "r" ? " CONCURRENTLY" : "";
    await sql.query(`CREATE INDEX${concurrently} IF NOT EXISTS ${entry.index}
      ON public.${entry.table} USING ${method} (${entry.column}) WHERE ${entry.column} IS NOT NULL`);
    if (!(await read(entry)).lookup_ready) {
      throw new Error(`business_erasure_reference_index_not_ready:${entry.table}.${entry.column}`);
    }
    built.push(entry.index);
  }
  return { built, verified: BUSINESS_ERASURE_REFERENCE_INDEXES.length };
}
