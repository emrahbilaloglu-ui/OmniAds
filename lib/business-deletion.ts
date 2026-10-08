import { getDb, runDbTransaction } from "@/lib/db";
import { runWithDbJitDisabled } from "@/lib/db-jit-scope";
import { deleteBusinessNativeEvaluations, BusinessNativeEvaluationCleanupError } from "@/lib/business-deletion-native-evaluations";
import { PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE } from "@/lib/provider-account-assignments";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { assertBusinessExternalDataRemoved, BusinessExternalCleanupError } from "@/lib/business-deletion-files";
import { deleteBusinessReleaseReceipts, deleteBusinessWorkerHistory, BusinessControlReceiptCleanupError } from "@/lib/business-deletion-control-receipts";

/** Explicit ownership allowlist. New tables must be reviewed, never auto-purged. */
export const BUSINESS_DELETE_TABLES = [
  "ai_creative_decisions_cache",
  "ai_daily_insights",
  "business_commerce_cost_structure_history",
  "business_commerce_cost_structures",
  "business_cost_models",
  "business_country_economics",
  "business_decision_calibration_profiles",
  "business_engine_v3_flags",
  "business_operating_constraints",
  "business_promo_calendar_events",
  "business_provider_accounts",
  "business_target_pack_history",
  "business_target_packs",
  "command_center_action_execution_audit",
  "command_center_action_execution_state",
  "command_center_action_journal",
  "command_center_action_state",
  "command_center_feedback",
  "command_center_handoffs",
  "command_center_mutation_receipts",
  "command_center_saved_views",
  "creative_decision_os_snapshots",
  "creative_media_cache",
  "creative_share_snapshots",
  "custom_reports",
  "decision_workflow_events",
  "decision_workflow_state",
  "discount_redemptions",
  "engine_v3_account_calibration_daily",
  "engine_v3_account_profile_output",
  "engine_v3_ad_account_calibration_batches",
  "engine_v3_ad_account_calibration_daily",
  "engine_v3_ad_campaign_context_objects",
  "engine_v3_ad_decision_evaluation_contexts",
  "engine_v3_ad_decision_evaluations",
  "engine_v3_ad_decision_events",
  "engine_v3_ad_decision_outcome_publications",
  "engine_v3_ad_decision_outcome_runs",
  "engine_v3_ad_decision_outcomes_daily",
  "engine_v3_ad_decision_snapshots_daily",
  "engine_v3_ad_operator_action_receipts",
  "engine_v3_ad_operator_response_events",
  "engine_v3_ad_operator_responses",
  "engine_v3_ad_recommendation_episodes",
  "engine_v3_campaign_context_daily",
  "engine_v3_campaign_role_authority",
  "engine_v3_creative_lifecycle_daily",
  "engine_v3_decision_evaluation_contexts",
  "engine_v3_decision_evaluations",
  "engine_v3_decision_events",
  "engine_v3_decision_outcomes_daily",
  "engine_v3_decision_snapshots_daily",
  "engine_v3_job_runs",
  "google_ads_account_daily",
  "google_ads_ad_daily",
  "google_ads_ad_dimensions",
  "google_ads_ad_group_daily",
  "google_ads_ad_group_dimensions",
  "google_ads_ad_group_state_history",
  "google_ads_advisor_execution_logs",
  "google_ads_advisor_memory",
  "google_ads_advisor_snapshots",
  "google_ads_asset_daily",
  "google_ads_asset_group_daily",
  "google_ads_asset_group_dimensions",
  "google_ads_audience_daily",
  "google_ads_campaign_daily",
  "google_ads_campaign_dimensions",
  "google_ads_campaign_state_history",
  "google_ads_day_finality",
  "google_ads_decision_action_outcome_logs",
  "google_ads_device_daily",
  "google_ads_geo_daily",
  "google_ads_keyword_daily",
  "google_ads_keyword_dimensions",
  "google_ads_product_daily",
  "google_ads_product_dimensions",
  "google_ads_raw_snapshots",
  "google_ads_runner_leases",
  "google_ads_search_cluster_daily",
  "google_ads_search_query_hot_daily",
  "google_ads_search_term_daily",
  "google_ads_sync_checkpoints",
  "google_ads_sync_jobs",
  "google_ads_sync_partitions",
  "google_ads_sync_runs",
  "google_ads_sync_state",
  "google_ads_top_query_weekly",
  "google_merchant_center_item_state",
  "invites",
  "klaviyo_flow_metrics",
  "memberships",
  "meta_account_daily",
  "meta_ad_daily",
  "meta_ad_dimensions",
  "meta_ads_action_log",
  "meta_ads_action_mutation_attempt_events",
  "meta_ads_action_reconciliation_events",
  "meta_ads_duplicate_action_attempt_events",
  "meta_ads_duplicate_action_reconciliation_events",
  "meta_ads_duplicate_reconciliation_observations",
  "meta_adset_config_history",
  "meta_adset_daily",
  "meta_adset_dimensions",
  "meta_authoritative_day_state",
  "meta_authoritative_publication_pointers",
  "meta_authoritative_reconciliation_events",
  "meta_authoritative_slice_versions",
  "meta_authoritative_source_manifests",
  "meta_authority_bootstrap_attempts",
  "meta_automation_activity_ledger",
  "meta_automation_business_controls",
  "meta_automation_decision_type_modes",
  "meta_automation_promotion_records",
  "meta_automation_proposals",
  "meta_automation_reconciliation_receipts",
  "meta_automation_rule_firings",
  "meta_automation_rules",
  "meta_breakdown_daily",
  "meta_budget_write_journal",
  "meta_campaign_config_history",
  "meta_campaign_daily",
  "meta_campaign_dimensions",
  "meta_campaign_label_history",
  "meta_campaign_labels",
  "meta_config_repair_audits",
  "meta_config_snapshots",
  "meta_controlled_assignment_batches",
  "meta_controlled_control_estimates",
  "meta_controlled_control_outcome_observations",
  "meta_controlled_experiment_arms",
  "meta_controlled_experiments",
  "meta_controlled_random_assignments",
  "meta_controlled_seed_reveals",
  "meta_creative_briefs",
  "meta_creative_daily",
  "meta_creative_dimensions",
  "meta_creative_lineage_edges",
  "meta_creative_media",
  "meta_creative_score_snapshots",
  "meta_creatives_snapshots",
  "meta_decision_action_outcome_logs",
  "meta_decision_calibration_daily",
  "meta_decision_responses",
  "meta_decision_snapshots_daily",
  "meta_entity_decision_signals_daily",
  "meta_entity_observation_receipts",
  "meta_entity_observation_receipts_v2",
  "meta_entity_observation_runs",
  "meta_entity_role_declarations",
  "meta_entity_state_history",
  "meta_entity_tombstones",
  "meta_launch_drafts",
  "meta_launch_intents",
  "meta_launch_templates",
  "meta_raw_snapshot_observations",
  "meta_raw_snapshots",
  "meta_structure_snapshot_runs",
  "meta_sync_checkpoints",
  "meta_sync_jobs",
  "meta_sync_partitions",
  "meta_sync_phase_timings",
  "meta_sync_runs",
  "meta_sync_state",
  "notification_events",
  "platform_overview_daily_summary",
  "platform_overview_summary_ranges",
  "product_instrumentation_events",
  "provider_account_rollover_state",
  "provider_account_assignments",
  "provider_account_snapshots",
  "provider_account_snapshot_runs",
  "provider_connections",
  "provider_integrations",
  "provider_cooldown_state",
  "provider_quota_usage",
  "provider_reporting_snapshots",
  "provider_request_audit_daily",
  "provider_sync_jobs",
  "seo_ai_monthly_analyses",
  "seo_results_cache",
  "shopify_customer_dimensions",
  "shopify_customer_events",
  "shopify_entity_payload_archives",
  "shopify_order_lines",
  "shopify_order_transactions",
  "shopify_orders",
  "shopify_product_dimensions",
  "shopify_raw_snapshot_observations",
  "shopify_raw_snapshots",
  "shopify_reconciliation_runs",
  "shopify_refunds",
  "shopify_repair_intents",
  "shopify_returns",
  "shopify_sales_events",
  "shopify_serving_overrides",
  "shopify_serving_state",
  "shopify_serving_state_history",
  "shopify_shop_dimensions",
  "shopify_subscriptions",
  "shopify_sync_state",
  "shopify_variant_dimensions",
  "shopify_variant_unit_cost_history",
  "shopify_variant_unit_costs",
  "shopify_webhook_deliveries",
  "sync_incidents",
  "sync_reclaim_events",
  "sync_repair_executions",
  "sync_runner_leases",
] as const;

/** Whole-business erasure includes retained lineage and normalization recovery.
 * These names grant no age-based pruning or ordinary decision writer authority. */
const ADDITIONAL_DELETE_TABLES = ["db_normalization_orphan_core_legacy", "shopify_install_contexts"] as const;
const ARCHIVE_SCHEMA = "adsecute_compact_20260726t0204z";

/** Exact reviewed immutable guards. Only a locked whole-business transaction
 * may suspend these; FKs and all other triggers remain active. */
const ERASURE_DELETE_GUARDS: Record<string, readonly [string, string, number]> = {
  "engine_v3_ad_account_calibration_batches": ["engine_v3_native_ad_calibration_batch_immutable_trigger", "engine_v3_native_ad_calibration_batch_immutable", 27],
  "engine_v3_ad_account_calibration_daily": ["engine_v3_native_ad_calibration_cell_immutable_trigger", "engine_v3_native_ad_calibration_cell_immutable", 31],
  "engine_v3_ad_campaign_context_objects": ["engine_v3_ad_campaign_objects_immutable", "refuse_native_campaign_context_object_mutation", 27],
  "engine_v3_ad_decision_outcome_runs": ["trg_engine_v3_ad_outcome_runs_complete_immutable", "reject_complete_engine_v3_ad_outcome_run_mutation", 27],
  "engine_v3_ad_decision_outcomes_daily": ["trg_engine_v3_ad_outcomes_immutable", "reject_engine_v3_ad_outcome_mutation", 27],
  "engine_v3_ad_operator_action_receipts": ["engine_v3_ad_operator_action_receipts_immutable", "reject_engine_v3_ad_operator_action_receipt_mutation", 27],
  "meta_ads_action_log": ["trg_meta_ads_action_log_controlled_verified_immutable", "meta_prevent_verified_controlled_action_mutation", 31],
  "meta_ads_action_mutation_attempt_events": ["trg_meta_ads_action_mutation_attempt_immutable", "reject_meta_ads_action_mutation_attempt_mutation", 27],
  "meta_ads_action_reconciliation_events": ["trg_meta_ads_action_reconciliation_immutable", "reject_meta_ads_action_reconciliation_mutation", 27],
  "meta_ads_duplicate_action_attempt_events": ["trg_meta_ads_duplicate_attempt_immutable", "reject_meta_ads_duplicate_attempt_mutation", 27],
  "meta_ads_duplicate_action_reconciliation_events": ["trg_meta_ads_duplicate_reconciliation_immutable", "reject_meta_ads_duplicate_reconciliation_mutation", 27],
  "meta_ads_duplicate_reconciliation_observations": ["trg_meta_ads_duplicate_observation_immutable", "reject_meta_ads_duplicate_observation_mutation", 27],
  "meta_controlled_assignment_batches": ["trg_meta_controlled_assignment_batches_immutable", "meta_reject_immutable_controlled_registry_write", 27],
  "meta_controlled_control_estimates": ["trg_meta_controlled_control_estimates_immutable", "meta_reject_immutable_controlled_registry_write", 27],
  "meta_controlled_control_outcome_observations": ["trg_meta_controlled_control_outcome_observations_immutable", "meta_reject_immutable_controlled_registry_write", 27],
  "meta_controlled_experiment_arms": ["trg_meta_controlled_experiment_arms_immutable", "meta_reject_immutable_controlled_registry_write", 27],
  "meta_controlled_experiments": ["trg_meta_controlled_experiments_immutable", "meta_reject_immutable_controlled_registry_write", 27],
  "meta_controlled_random_assignments": ["trg_meta_controlled_random_assignments_immutable", "meta_reject_immutable_controlled_registry_write", 27],
  "meta_controlled_seed_reveals": ["trg_meta_controlled_seed_reveals_immutable", "meta_reject_immutable_controlled_registry_write", 27],
  "meta_decision_action_outcome_logs": ["trg_meta_decision_controlled_outcome_immutable", "meta_prevent_bound_controlled_outcome_mutation", 27],
};

export class BusinessDeletionError extends Error {
  constructor(
    readonly code: "not_found" | "protected_history" | "schema_not_ready" | "scope_conflict" | "business_busy" | "control_reference_in_use" | "external_cleanup_required",
    readonly tables: string[] = [],
  ) { super(code); this.name = "BusinessDeletionError"; }
}

type ScopeColumn = { schema_name: string; table_name: string; column_name: string; type_name: string; not_null: boolean; identity_checked: boolean; indexed: boolean; owner_indexes: string[]; heap_bytes: string; relation_oid: string; relation_kind: string; episode_bound: boolean; row_security: boolean };
type Dependency = { child_table: string; parent_table: string };
type DeleteGuard = { table_name: string; trigger_name: string; function_name: string; function_schema: string; enabled: string; trigger_type: number; arguments: number };
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const qualified = (value: string) => value.split(".").map(identifier).join(".");

/** Children first; every FK remains active throughout the transaction. */
export function orderBusinessDeletionTables(tables: string[], dependencies: Dependency[]): string[] {
  const remaining = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { child_table: child, parent_table: parent } of dependencies) {
    if (child !== parent && remaining.has(child) && remaining.has(parent)) remaining.get(parent)!.add(child);
  }
  const ordered: string[] = [];
  while (remaining.size) {
    const leaves = [...remaining].filter(([, children]) => children.size === 0).map(([table]) => table).sort();
    if (!leaves.length) throw new BusinessDeletionError("schema_not_ready", [...remaining.keys()]);
    for (const table of leaves) remaining.delete(table);
    for (const children of remaining.values()) for (const table of leaves) children.delete(table);
    ordered.push(...leaves);
  }
  return ordered;
}

// Original creative history and its shared job-run registry predate dual-owner
// equality CHECKs. Their required UUID is the producer/lookup owner; nullable
// text is compatibility context. Never select a different canonical owner
// through a contradictory alias.
const LEGACY_CANONICAL_OWNERS = new Set(["engine_v3_job_runs", "engine_v3_account_calibration_daily", "engine_v3_creative_lifecycle_daily",
  "engine_v3_decision_events", "engine_v3_decision_outcomes_daily", "engine_v3_decision_snapshots_daily"]);

function scopePredicates(columns: ScopeColumn[]): { predicate: string; owner: ScopeColumn }[] {
  const first = columns[0]!;
  if (first.episode_bound) return [{ predicate: `episode_key IN (SELECT episode_key FROM public.engine_v3_ad_recommendation_episodes WHERE business_ref_id=$1::uuid)`, owner: first }];
  const canonical = columns.find(c => c.column_name === "business_ref_id" && c.not_null && c.indexed
    && (c.identity_checked || c.schema_name === "public" && LEGACY_CANONICAL_OWNERS.has(c.table_name)));
  const equalIndexedOwner = columns.find(c => c.identity_checked && c.not_null && c.indexed);
  if (first.schema_name === "public" && LEGACY_CANONICAL_OWNERS.has(first.table_name) && !canonical)
    throw new BusinessDeletionError("schema_not_ready", [first.table_name]);
  const owner = canonical ?? equalIndexedOwner;
  return (owner ? [owner] : columns).map(owner => {
    const { column_name: name, type_name: type } = owner;
    if (type !== "uuid" && type !== "text") throw new BusinessDeletionError("schema_not_ready");
    return { predicate: `${identifier(name)} = $1::${type}`, owner };
  });
}

function scopeFor(columns: ScopeColumn[]): string {
  return scopePredicates(columns).map(s => s.predicate).join(" OR ");
}

const OWNER_PAGE = 1024;
const OWNER_ROW_BOUND = 4_194_304;

/** Read complete owned identities, never a selective mismatch/LIMIT over the
 * whole relation. Each arm of a large union needs its actual leading index;
 * an eager sort/materialization or unrelated whole-index walk still refuses. */
function verifyOwnerReadPlan(plan: Record<string, unknown>, owners: ScopeColumn[]) {
  if (Number(owners[0]!.heap_bytes) <= 1024 * 1024) return;
  const found = new Set<string>();
  const checkIndex = (node: Record<string, unknown>) => {
    const owner = owners.find(o => o.owner_indexes.includes(String(node["Index Name"]))
      && new RegExp(`\\b${o.column_name}\\b\\s*=`).test(String(node["Index Cond"])));
    if (!owner) throw new BusinessDeletionError("schema_not_ready", [owners[0]!.table_name]);
    found.add(owner.column_name);
  };
  const walk = (node: Record<string, unknown>) => {
    if (["Sort", "Incremental Sort", "Materialize", "CTE Scan", "Gather", "Gather Merge"].includes(String(node["Node Type"])))
      throw new BusinessDeletionError("schema_not_ready", [owners[0]!.table_name]);
    if (node["Relation Name"] === owners[0]!.table_name) {
      if (["Index Scan", "Index Only Scan"].includes(String(node["Node Type"]))) checkIndex(node);
      else if (node["Node Type"] !== "Bitmap Heap Scan") throw new BusinessDeletionError("schema_not_ready", [owners[0]!.table_name]);
    }
    if (node["Node Type"] === "Bitmap Index Scan") checkIndex(node);
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
  };
  walk(plan);
  if (owners.some(o => !found.has(o.column_name))) throw new BusinessDeletionError("schema_not_ready", [owners[0]!.table_name]);
}

/** The caller already holds writer exclusion, has checked ownership and keeps
 * all FKs active. A non-holdable cursor visits each original owned tuple once;
 * exact physical pages avoid restarting an owner scan over deleted prefixes.
 * Only ordinary heap relations are supported. A changed plan/row/bound rolls
 * every earlier page back with the caller's transaction. */
async function deleteLargeOwnedRows(sql: ReturnType<typeof getDb>, table: string, scope: ScopeColumn[],
  businessId: string, progress: { ownedRows: number; ownedPages: number }) {
  const first = scope[0]!;
  if (first.relation_kind !== "r" || scope.some(c => c.episode_bound))
    throw new BusinessDeletionError("schema_not_ready", [table]);
  const predicate = scopeFor(scope);
  const declare = `DECLARE business_erasure_owned_rows NO SCROLL CURSOR FOR
    SELECT ctid::text AS row_tid,tableoid::text AS row_table FROM ${qualified(table)} WHERE (${predicate})`;
  const [readPlan] = await sql.query(`EXPLAIN (FORMAT JSON) ${declare}`, [businessId]);
  verifyOwnerReadPlan(readPlan!["QUERY PLAN"][0].Plan, scopePredicates(scope).map(s => s.owner));
  await sql.query(declare, [businessId]);
  const [settings] = await sql.query<{ index: string; bitmap: string }>(
    "SELECT current_setting('enable_indexscan') AS index,current_setting('enable_bitmapscan') AS bitmap");
  // The cursor's owner plan is already pinned. Exact TID probes must not be
  // replaced by a fresh full owner-index scan on each DELETE page.
  await sql.query("SET LOCAL enable_indexscan=off");
  await sql.query("SET LOCAL enable_bitmapscan=off");
  let rows = 0;
  for (;;) {
    const page = await sql.query<{ row_tid: string; row_table: string }>(`FETCH FORWARD ${OWNER_PAGE} FROM business_erasure_owned_rows`);
    rows += page.length;
    if (rows > OWNER_ROW_BOUND || page.some(r => r.row_table !== first.relation_oid))
      throw new BusinessDeletionError("schema_not_ready", [table]);
    if (!page.length) break;
    const query = `WITH removed AS (DELETE FROM ${qualified(table)}
      WHERE ctid=ANY($1::tid[]) AND tableoid=$2::oid AND (${predicate.replaceAll("$1", "$3")}) RETURNING 1)
      SELECT count(*)::int AS removed FROM removed`;
    const params = [page.map(r => r.row_tid), first.relation_oid, businessId];
    const [plan] = await sql.query(`EXPLAIN (FORMAT JSON) ${query}`, params);
    let exact = false;
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === first.table_name && node["Node Type"] !== "ModifyTable") {
        if (node["Node Type"] !== "Tid Scan" || !/ctid.*ANY/.test(String(node["TID Cond"])))
          throw new BusinessDeletionError("schema_not_ready", [table]);
        exact = true;
      }
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    walk(plan!["QUERY PLAN"][0].Plan);
    if (!exact) throw new BusinessDeletionError("schema_not_ready", [table]);
    const [deleted] = await sql.query<{ removed: number }>(query, params);
    if (deleted?.removed !== page.length) throw new BusinessDeletionError("schema_not_ready", [table]);
    progress.ownedRows += page.length; progress.ownedPages++;
  }
  await sql.query("CLOSE business_erasure_owned_rows");
  await sql.query("SELECT set_config('enable_indexscan',$1,true),set_config('enable_bitmapscan',$2,true)", [settings!.index, settings!.bitmap]);
}

const SCOPE_CATALOG = `SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
  t.typname AS type_name, a.attnotnull AS not_null, pg_relation_size(c.oid)::text AS heap_bytes,
  c.oid::text AS relation_oid,c.relkind::text AS relation_kind,
  c.relrowsecurity OR c.relforcerowsecurity AS row_security,
  EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
    JOIN pg_opclass op ON op.oid=i.indclass[0] WHERE i.indrelid=c.oid AND am.amname='btree' AND i.indkey[0]=a.attnum
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
    AND op.opcdefault AND i.indcollation[0]=a.attcollation) AS indexed,
  ARRAY(SELECT ic.relname::text FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
    JOIN pg_opclass op ON op.oid=i.indclass[0] WHERE i.indrelid=c.oid AND am.amname='btree' AND i.indkey[0]=a.attnum
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL
      AND op.opcdefault AND i.indcollation[0]=a.attcollation ORDER BY ic.relname) AS owner_indexes,
  (n.nspname='public' AND c.relname IN ('engine_v3_ad_operator_responses','engine_v3_ad_operator_response_events')
    AND EXISTS (SELECT 1 FROM pg_constraint fk JOIN pg_class parent ON parent.oid=fk.confrelid
      JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      WHERE fk.conrelid=c.oid AND fk.contype='f' AND fk.convalidated AND pn.nspname='public'
        AND parent.relname='engine_v3_ad_recommendation_episodes'
        AND ARRAY(SELECT ca.attname::text FROM unnest(fk.conkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=k.num ORDER BY k.ord)
          =ARRAY['episode_key','business_ref_id','business_id','provider_account_ref_id','provider_account_id']::text[]
        AND ARRAY(SELECT pa.attname::text FROM unnest(fk.confkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.num ORDER BY k.ord)
          =ARRAY['episode_key','business_ref_id','business_id','provider_account_ref_id','provider_account_id']::text[]
        AND NOT EXISTS (SELECT 1 FROM unnest(fk.conkey) k(num) JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=k.num WHERE NOT ca.attnotnull)
        AND EXISTS (SELECT 1 FROM pg_constraint ck WHERE ck.conrelid=parent.oid AND ck.contype='c' AND ck.convalidated
          AND regexp_replace(pg_get_constraintdef(ck.oid),'[[:space:]()]','','g')
            IN ('CHECKbusiness_id=business_ref_id::text','CHECKbusiness_ref_id::text=business_id')))) AS episode_bound,
  (EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='c' AND k.convalidated
    AND regexp_replace(pg_get_constraintdef(k.oid), '[[:space:]()]', '', 'g')
      IN ('CHECKbusiness_id=business_ref_id::text','CHECKbusiness_ref_id::text=business_id'))
   OR (n.nspname='public' AND c.relname='meta_entity_state_history'
    AND EXISTS (SELECT 1 FROM pg_constraint fk JOIN pg_class parent ON parent.oid=fk.confrelid
      JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      WHERE fk.conrelid=c.oid AND fk.contype='f' AND fk.convalidated AND pn.nspname='public'
        AND parent.relname='meta_entity_observation_runs'
        AND ARRAY(SELECT ca.attname::text FROM unnest(fk.conkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=k.num ORDER BY k.ord)
          =ARRAY['run_id','business_ref_id','business_id','provider_account_ref_id','provider_account_id','entity_type','captured_at','run_completeness']::text[]
        AND ARRAY(SELECT pa.attname::text FROM unnest(fk.confkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.num ORDER BY k.ord)
          =ARRAY['id','business_ref_id','business_id','provider_account_ref_id','provider_account_id','entity_type','captured_at','completeness']::text[]
        AND NOT EXISTS (SELECT 1 FROM unnest(fk.conkey) k(num) JOIN pg_attribute ca ON ca.attrelid=c.oid AND ca.attnum=k.num WHERE NOT ca.attnotnull)
        AND (SELECT count(*) FROM pg_trigger tr WHERE tr.tgconstraint=fk.oid AND tr.tgisinternal)=4
        AND NOT EXISTS (SELECT 1 FROM pg_trigger tr WHERE tr.tgconstraint=fk.oid AND tr.tgisinternal AND tr.tgenabled NOT IN ('O','A'))
        AND EXISTS (SELECT 1 FROM pg_constraint ck WHERE ck.conrelid=parent.oid AND ck.contype='c' AND ck.convalidated
          AND regexp_replace(pg_get_constraintdef(ck.oid),'[[:space:]()]','','g')
            IN ('CHECKbusiness_id=business_ref_id::text','CHECKbusiness_ref_id::text=business_id'))))) AS identity_checked
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp%' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    AND (a.attname IN ('business_id','business_ref_id')
      OR (n.nspname='public' AND c.relname='shopify_install_contexts' AND a.attname='preferred_business_id'))
  ORDER BY n.nspname,c.relname,a.attname`;

const ZERO_REFERENCE_INPUTS = `SELECT k.contract_version,k.input_hash::text AS input_hash
  FROM unnest($1::text[], $2::character(64)[]) k(contract_version,input_hash)
  LEFT JOIN LATERAL (SELECT 1 AS found FROM public.engine_v3_ad_decision_evaluations e
    WHERE e.contract_version=k.contract_version AND e.input_hash=k.input_hash LIMIT 1) referenced ON true
  WHERE referenced.found IS NULL`;

function verifyInputReferencePlan(value: unknown, indexes: string[]) {
  const plan = value as Array<{ Plan: Record<string, unknown> }>;
  let probes = 0;
  const walk = (node: Record<string, unknown>) => {
    if (node["Relation Name"] === "engine_v3_ad_decision_evaluations") {
      if (!["Index Scan", "Index Only Scan"].includes(String(node["Node Type"]))
        || !indexes.includes(String(node["Index Name"]))
        || !/contract_version/.test(String(node["Index Cond"])) || !/input_hash/.test(String(node["Index Cond"])))
        throw new BusinessDeletionError("schema_not_ready", ["input_evidence_reference_plan"]);
      probes++;
    }
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
  };
  if (!Array.isArray(plan) || plan.length !== 1 || !plan[0]?.Plan) throw new BusinessDeletionError("schema_not_ready");
  walk(plan[0].Plan);
  if (!probes) throw new BusinessDeletionError("schema_not_ready", ["input_evidence_reference_plan"]);
}

export async function deleteBusinessWithData(businessId: string): Promise<void> {
  assertSyncLaneEnabled("assignment_mutation");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(businessId)) throw new BusinessDeletionError("not_found");
  const startedAt = Date.now();
  let phase = "catalog", phaseAt = startedAt;
  const timings: { phase: string; ms: number }[] = [];
  const progress = { releaseRows: 0, releaseBytes: 0, nativeRows: 0, nativePages: 0, inputKeys: 0,
    ownershipRows: 0, ownershipPages: 0, ownedRows: 0, ownedPages: 0 };
  const mark = (next: string) => { timings.push({ phase, ms: Date.now()-phaseAt }); phase=next; phaseAt=Date.now(); };
  try { await runWithDbJitDisabled(() => runDbTransaction(async () => {
    const sql = getDb();
    await sql.query("SET LOCAL lock_timeout = '1500ms'");
    await sql`SELECT pg_advisory_xact_lock(${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
      hashtext(${`provider_account_selection:business:${businessId}`}))`;
    const columns = await sql.query<ScopeColumn>(SCOPE_CATALOG);
    if (columns.some(c=>c.row_security)) throw new BusinessDeletionError("schema_not_ready",["ownership_row_security"]);
    const allowed = new Set<string>([...BUSINESS_DELETE_TABLES, ...ADDITIONAL_DELETE_TABLES]);
    const unexpected = columns.filter(c => !(c.schema_name === "public" && allowed.has(c.table_name)
      || c.schema_name === ARCHIVE_SCHEMA && c.table_name === "meta_creative_lineage_edges"));
    if (unexpected.length) throw new BusinessDeletionError("schema_not_ready", [...new Set(unexpected.map(c => `${c.schema_name}.${c.table_name}`))]);
    const scopes = new Map<string, ScopeColumn[]>();
    for (const c of columns) { const name = `${c.schema_name}.${c.table_name}`; scopes.set(name, [...(scopes.get(name) ?? []), c]); }
    const existing = new Set((await sql.query<{ name: string }>(`SELECT n.nspname||'.'||c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p')
      AND n.nspname IN ('public', '${ARCHIVE_SCHEMA}')`)).map(r => r.name));
    const indirect = ["public.engine_v3_ad_decision_input_evidence", "public.custom_report_share_snapshots", "public.admin_audit_logs",
      "public.meta_state_history_compaction_journal", "public.meta_retention_runs", "public.google_ads_retention_runs",
      "public.sync_repair_plans", "public.sync_release_gates", "public.sync_worker_heartbeats", "public.sync_runtime_instances", `${ARCHIVE_SCHEMA}.keep_runs`, `${ARCHIVE_SCHEMA}.run_semantics`];
    const locked = [...new Set([...scopes.keys(), ...indirect.filter(t => existing.has(t))])].sort();
    mark("writer_exclusion");
    // SHARE ROW EXCLUSIVE permits reads and excludes every competing writer.
    // Locks and trigger changes are transactional, including rollback/COMMIT failure.
    try { await sql.query(`LOCK TABLE ${locked.map(qualified).join(", ")} IN SHARE ROW EXCLUSIVE MODE`); }
    catch (error) { if ((error as { code?: string }).code === "55P03") throw new BusinessDeletionError("business_busy"); throw error; }
    const [business] = await sql`SELECT id FROM businesses WHERE id=${businessId}::uuid FOR UPDATE`;
    if (!business) throw new BusinessDeletionError("not_found");
    const catalogIdentity = (items: ScopeColumn[]) => JSON.stringify(items.map(({heap_bytes: _size,...column})=>column));
    if (catalogIdentity(await sql.query<ScopeColumn>(SCOPE_CATALOG)) !== catalogIdentity(columns)) throw new BusinessDeletionError("schema_not_ready");
    const guards = await sql.query<DeleteGuard>(`SELECT n.nspname||'.'||c.relname AS table_name,t.tgname AS trigger_name,
      p.proname AS function_name,pn.nspname AS function_schema,t.tgenabled AS enabled,t.tgtype::int AS trigger_type,t.tgnargs::int AS arguments
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
      WHERE NOT t.tgisinternal AND (t.tgtype & 8)<>0 AND n.nspname IN ('public','${ARCHIVE_SCHEMA}') ORDER BY n.nspname,c.relname,t.tgname`);
    for (const g of guards.filter(g => locked.includes(g.table_name))) {
      const spec = ERASURE_DELETE_GUARDS[g.table_name.replace(/^public\./, "")];
      if (!spec || g.table_name !== `public.${g.table_name.split(".")[1]}` || spec[0] !== g.trigger_name
        || spec[1] !== g.function_name || spec[2] !== g.trigger_type || g.function_schema !== "public" || g.arguments !== 0
        || !["O", "A", "R"].includes(g.enabled)) throw new BusinessDeletionError("protected_history", [g.table_name]);
    }
    for (const [table, spec] of Object.entries(ERASURE_DELETE_GUARDS)) {
      if (scopes.has(`public.${table}`) && !guards.some(g => g.table_name === `public.${table}` && g.trigger_name === spec[0]))
        throw new BusinessDeletionError("schema_not_ready", [table]);
    }
    mark("active_work");
    await sql.query("SET LOCAL enable_seqscan = off");
    for (const table of ["sync_runner_leases", "google_ads_runner_leases"]) {
      if (!scopes.has(`public.${table}`)) continue;
      const [lease] = await sql.query(`SELECT 1 FROM public.${identifier(table)} WHERE business_id=$1::text AND lease_expires_at>clock_timestamp() LIMIT 1`, [businessId]);
      if (lease) throw new BusinessDeletionError("business_busy", [table]);
    }
    for (const table of ["provider_sync_jobs", "meta_sync_jobs", "meta_sync_partitions", "google_ads_sync_jobs", "google_ads_sync_partitions", "engine_v3_job_runs"]) {
      const scope = scopes.get(`public.${table}`); if (!scope) continue;
      const [job] = await sql.query(`SELECT 1 FROM public.${identifier(table)} WHERE (${scopeFor(scope)}) AND status IN ('running','claimed','processing') LIMIT 1`, [businessId]);
      if (job) throw new BusinessDeletionError("business_busy", [table]);
    }
    mark("ownership_conflicts");
    await sql.query("SET LOCAL cursor_tuple_fraction=1");
    for (const [table, scope] of scopes) {
      if (scope.length !== 2 || scope.some(c => c.identity_checked || c.episode_bound)) continue;
      mark(`ownership_conflicts:${table}`);
      const owners = scopePredicates(scope);
      const declare = `DECLARE business_erasure_owner_census NO SCROLL CURSOR FOR
        SELECT business_id,business_ref_id FROM ${qualified(table)} WHERE (${scopeFor(scope)})`;
      const [plan] = await sql.query(`EXPLAIN (FORMAT JSON) ${declare}`, [businessId]);
      verifyOwnerReadPlan(plan!["QUERY PLAN"][0].Plan, owners.map(s => s.owner));
      await sql.query(declare, [businessId]);
      let rows = 0;
      for (;;) {
        const page = await sql.query<{ business_id: string | null; business_ref_id: string | null }>(
          `FETCH FORWARD ${OWNER_PAGE} FROM business_erasure_owner_census`);
        rows += page.length; progress.ownershipRows += page.length;
        if (rows > OWNER_ROW_BOUND) throw new BusinessDeletionError("schema_not_ready", [table]);
        if (!page.length) break;
        progress.ownershipPages++;
        // Preserve SQL NULL semantics: a compatibility NULL is not itself a
        // contradiction. Required canonical ownership is established above.
        if (page.some(r => r.business_id !== null && r.business_ref_id !== null && r.business_id !== r.business_ref_id))
          throw new BusinessDeletionError("scope_conflict", [table]);
      }
      await sql.query("CLOSE business_erasure_owner_census");
    }
    mark("delete_plans");
    const dependencies = await sql.query<Dependency>(`SELECT cn.nspname||'.'||child.relname AS child_table,pn.nspname||'.'||parent.relname AS parent_table
      FROM pg_constraint f JOIN pg_class child ON child.oid=f.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
      JOIN pg_class parent ON parent.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace WHERE f.contype='f'`);
    const ordered = orderBusinessDeletionTables([...scopes.keys()], dependencies);
    // Never silently turn offboarding into a large table scan. Test the actual
    // DELETE plan before writes; keep the same planner setting through erasure.
    await sql.query("SET LOCAL enable_seqscan = off");
    for (const [table, scope] of scopes) {
      const plan = await sql.query(`EXPLAIN (FORMAT JSON) DELETE FROM ${qualified(table)} WHERE (${scopeFor(scope)})`, [businessId]);
      const walk = (node: Record<string, unknown>) => {
        if (node["Node Type"] === "Seq Scan" && node["Relation Name"] === scope[0]!.table_name && Number(scope[0]!.heap_bytes)>1024*1024)
          throw new BusinessDeletionError("schema_not_ready", [table]);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
      };
      walk(plan[0]!["QUERY PLAN"][0].Plan);
    }
    await sql.query(`CREATE TEMP TABLE business_erasure_input_keys
      (contract_version text NOT NULL,input_hash character(64) NOT NULL,PRIMARY KEY(contract_version,input_hash)) ON COMMIT DROP`);
    const [hasKeys] = await sql.query(`SELECT 1 FROM public.engine_v3_ad_decision_evaluations
      WHERE (${scopeFor(scopes.get("public.engine_v3_ad_decision_evaluations")!)}) LIMIT 1`,[businessId]);
    let referenceIndexes: string[] = [];
    if (hasKeys) {
      referenceIndexes = (await sql.query<{ name: string }>(`SELECT ic.relname AS name FROM pg_index i
        JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
        JOIN pg_attribute a0 ON a0.attrelid=i.indrelid AND a0.attnum=i.indkey[0]
        JOIN pg_attribute a1 ON a1.attrelid=i.indrelid AND a1.attnum=i.indkey[1]
        JOIN pg_opclass o0 ON o0.oid=i.indclass[0] JOIN pg_opclass o1 ON o1.oid=i.indclass[1]
        JOIN pg_class tc ON tc.oid=i.indrelid
        WHERE i.indrelid='public.engine_v3_ad_decision_evaluations'::regclass AND am.amname='btree' AND i.indnkeyatts>=2
          AND a0.attname='contract_version' AND a1.attname='input_hash' AND i.indpred IS NULL AND i.indexprs IS NULL
          AND i.indisvalid AND i.indisready AND i.indislive AND o0.opcdefault AND o1.opcdefault
          AND i.indcollation[0]=a0.attcollation AND i.indcollation[1]=a1.attcollation AND NOT tc.relrowsecurity AND NOT tc.relforcerowsecurity`)).map(r => r.name);
      if (!referenceIndexes.length) throw new BusinessDeletionError("schema_not_ready", ["input_evidence_reference_index"]);
    }
    mark("external_data");
    try { await assertBusinessExternalDataRemoved(businessId); }
    catch (error) { if (error instanceof BusinessExternalCleanupError) throw new BusinessDeletionError("external_cleanup_required"); throw error; }
    mark("worker_history");
    try { await deleteBusinessWorkerHistory(sql,businessId); }
    catch (error) {
      if (error instanceof BusinessControlReceiptCleanupError) throw new BusinessDeletionError(
        error.message.startsWith("control_history_active:") ? "control_reference_in_use" : "schema_not_ready",
        [error.message.startsWith("control_history_active:") ? error.message.split(":")[1]! : "worker_runtime_history"]);
      throw error;
    }
    mark("release_receipts");
    if (existing.has("public.sync_release_gates")) {
      try {
        const result = await deleteBusinessReleaseReceipts(sql,businessId);
        progress.releaseRows=result.rows; progress.releaseBytes=result.bytes;
      }
      catch (error) { if (error instanceof BusinessControlReceiptCleanupError) throw new BusinessDeletionError("schema_not_ready",["sync_release_gates"]); throw error; }
    }
    mark("indirect_copies");
    // Indirect copies must go while their authoritative parent IDs still exist.
    await sql`DELETE FROM custom_report_share_snapshots WHERE report_id IN (SELECT id::text FROM custom_reports WHERE business_id=${businessId})
      OR payload::text LIKE ${`%${businessId}%`}`;
    await sql`DELETE FROM admin_audit_logs WHERE (target_type='business' AND target_id=${businessId}) OR meta::text LIKE ${`%${businessId}%`}`;
    for (const [table, json] of [["meta_retention_runs","summary_json"], ["google_ads_retention_runs","summary_json"],
      ["sync_repair_plans","payload_json"], ["meta_state_history_compaction_journal","detail_json"]]) {
      if (!existing.has(`public.${table}`)) continue;
      const arrayScope = table === "meta_state_history_compaction_journal" ? " OR $1::text=ANY(business_ids)" : "";
      await sql.query(`DELETE FROM public.${identifier(table!)} WHERE ${identifier(json!)}::text LIKE ('%'||$1::text||'%')${arrayScope}`, [businessId]);
    }
    for (const table of ["keep_runs","run_semantics"]) {
      if (existing.has(`${ARCHIVE_SCHEMA}.${table}`)) await sql.query(`DELETE FROM ${qualified(`${ARCHIVE_SCHEMA}.${table}`)} WHERE run_id IN
        (SELECT id FROM meta_entity_observation_runs WHERE (${scopeFor(scopes.get("public.meta_entity_observation_runs")!)}))`, [businessId]);
    }
    const suspended = guards.filter(g => locked.includes(g.table_name));
    for (const g of suspended) await sql.query(`ALTER TABLE ${qualified(g.table_name)} DISABLE TRIGGER ${identifier(g.trigger_name)}`);
    for (const table of ordered) {
      mark(table);
      if (table === "public.engine_v3_ad_decision_evaluations") {
        try {
          const result = await deleteBusinessNativeEvaluations(sql,businessId);
          progress.nativeRows=result.rows; progress.nativePages=result.pages;
        }
        catch (error) { if (error instanceof BusinessNativeEvaluationCleanupError)
          throw new BusinessDeletionError("schema_not_ready",[error.message]); throw error; }
        continue;
      }
      const scope = scopes.get(table)!;
      // Page the histories with proven leading-owner access. Scoped stores
      // without that prerequisite and episode-bound response stores
      // retain their existing checked DELETE path and the same 30s deadline.
      if (Number(scope[0]!.heap_bytes) > 1024*1024 && scope[0]!.relation_kind === "r"
        && !scope.some(c => c.episode_bound) && scopePredicates(scope).every(s => s.owner.indexed)
        && table !== "public.creative_share_snapshots") {
        await deleteLargeOwnedRows(sql, table, scope, businessId, progress);
        continue;
      }
      if (table === "public.provider_connections") { await sql`DELETE FROM provider_connections WHERE business_id=${businessId} OR business_ref_id=${businessId}::uuid`; continue; }
      if (table === "public.business_provider_accounts") { await sql`DELETE FROM business_provider_accounts WHERE business_id=${businessId} OR business_ref_id=${businessId}::uuid`; continue; }
      if (table === "public.provider_account_assignments") { await sql`DELETE FROM provider_account_assignments WHERE business_id=${businessId} OR business_ref_id=${businessId}::uuid`; continue; }
      const legacyShare = table === "public.creative_share_snapshots"
        ? ` OR (${scope.map(c => `${identifier(c.column_name)} IS NULL`).join(" AND ")} AND payload->>'businessId'=$1::text)` : "";
      await sql.query(`DELETE FROM ${qualified(table)} WHERE (${scopeFor(scope)})${legacyShare}`, [businessId]);
    }
    mark("input_gc");
    while (hasKeys) {
      const keys = await sql.query<{ contract_version: string; input_hash: string }>("SELECT contract_version,input_hash::text FROM business_erasure_input_keys ORDER BY contract_version,input_hash LIMIT 400");
      if (!keys.length) break;
      progress.inputKeys+=keys.length;
      const params = [keys.map(k => k.contract_version), keys.map(k => k.input_hash)];
      await sql.query("SET LOCAL enable_seqscan = off");
      const plan = await sql.query(`EXPLAIN (FORMAT JSON) ${ZERO_REFERENCE_INPUTS}`, params);
      verifyInputReferencePlan(plan[0]!["QUERY PLAN"], referenceIndexes);
      const unreferenced = await sql.query<{ contract_version: string; input_hash: string }>(ZERO_REFERENCE_INPUTS, params);
      if (unreferenced.length) await sql.query(`DELETE FROM public.engine_v3_ad_decision_input_evidence i USING
        unnest($1::text[], $2::character(64)[]) k(contract_version,input_hash) WHERE i.contract_version=k.contract_version AND i.input_hash=k.input_hash`,
      [unreferenced.map(k => k.contract_version), unreferenced.map(k => k.input_hash)]);
      await sql.query(`DELETE FROM business_erasure_input_keys i USING unnest($1::text[], $2::character(64)[]) k(contract_version,input_hash)
        WHERE i.contract_version=k.contract_version AND i.input_hash=k.input_hash`, params);
    }
    mark("absence_and_guard_restore");
    for (const [table, scope] of scopes) {
      const [remaining] = await sql.query(`SELECT 1 FROM ${qualified(table)} WHERE (${scopeFor(scope)}) LIMIT 1`, [businessId]);
      if (remaining) throw new BusinessDeletionError("schema_not_ready", [table]);
    }
    for (const g of suspended) {
      const mode = g.enabled === "A" ? "ENABLE ALWAYS" : g.enabled === "R" ? "ENABLE REPLICA" : "ENABLE";
      await sql.query(`ALTER TABLE ${qualified(g.table_name)} ${mode} TRIGGER ${identifier(g.trigger_name)}`);
    }
    // Read back the exact original modes before COMMIT; rollback restores every
    // suspension automatically if any earlier or later statement fails.
    const modes = await sql.query<{ table_name: string; trigger_name: string; enabled: string }>(`SELECT n.nspname||'.'||c.relname AS table_name,
      t.tgname AS trigger_name,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND (t.tgtype & 8)<>0`);
    if (suspended.some(g => !modes.some(m => m.table_name===g.table_name && m.trigger_name===g.trigger_name && m.enabled===g.enabled)))
      throw new BusinessDeletionError("schema_not_ready", ["trigger_restoration"]);
    await sql`UPDATE sessions SET active_business_id=NULL WHERE active_business_id=${businessId}`;
    await sql`DELETE FROM businesses WHERE id=${businessId}::uuid`;
  // A complete bounded receipt census and millions of owned evaluations are
  // distinct work. Keep each statement at 30s; the 4m total budget fits inside
  // the existing 300s HTTP proxy limit without changing production settings.
  }, { timeoutMs: 30_000, deadlineAtMs: startedAt+240_000 }));
    mark("committed");
    console.info("[business erasure] committed", JSON.stringify({ elapsedMs: Date.now()-startedAt, ...progress,
      slowestPhases: [...timings].sort((a,b)=>b.ms-a.ms).slice(0,10) }));
  } catch (error) {
    console.error("[business erasure] failed", JSON.stringify({ phase, elapsedMs: Date.now()-startedAt,
      phaseElapsedMs: Date.now()-phaseAt, ...progress,
      slowestPhases: [...timings].sort((a,b)=>b.ms-a.ms).slice(0,10) }));
    throw error;
  }
}
