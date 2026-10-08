import { getDb, runDbTransaction } from "@/lib/db";
import { PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE } from "@/lib/provider-account-assignments";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";

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

/** Retained native lineage and frozen label evidence have no offboarding
 * contract. Refuse before writes; ordinary business deletion never purges them. */
const RETAINED_HISTORY_TABLES = [
  "engine_v3_ad_decision_evaluations",
  "engine_v3_ad_decision_snapshots_daily",
  "engine_v3_ad_decision_evaluation_contexts",
  "engine_v3_ad_decision_input_evidence",
  "engine_v3_ad_decision_events",
  "meta_campaign_labels",
  "meta_campaign_label_history",
] as const;

export class BusinessDeletionError extends Error {
  constructor(
    readonly code: "not_found" | "protected_history" | "schema_not_ready" | "scope_conflict" | "business_busy",
    readonly tables: string[] = [],
  ) {
    super(code);
    this.name = "BusinessDeletionError";
  }
}

type ScopeColumn = { table_name: string; column_name: string; type_name: string };
type Dependency = { child_table: string; parent_table: string };
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

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

function scopeFor(columns: ScopeColumn[]): string {
  return columns.map(({ column_name: name, type_name: type }) => {
    if (type !== "uuid" && type !== "text") throw new BusinessDeletionError("schema_not_ready");
    return `${identifier(name)} = $1::${type}`;
  }).join(" OR ");
}

export async function deleteBusinessWithData(businessId: string): Promise<void> {
  assertSyncLaneEnabled("assignment_mutation");
  await runDbTransaction(async () => {
    const sql = getDb();
    await sql`SELECT pg_advisory_xact_lock(${PROVIDER_ACCOUNT_SELECTION_LOCK_NAMESPACE}::int,
      hashtext(${`provider_account_selection:business:${businessId}`}))`;
    const [business] = await sql`SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
    if (!business) throw new BusinessDeletionError("not_found");
    const columns = await sql.query<ScopeColumn>(`
      SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS type_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('business_id', 'business_ref_id')
      ORDER BY c.relname, a.attname
    `);
    const allowed = new Set<string>(BUSINESS_DELETE_TABLES);
    const unexpected = [...new Set(columns.map((row) => row.table_name))].filter((table) => !allowed.has(table));
    if (unexpected.length) throw new BusinessDeletionError("schema_not_ready", unexpected);
    const scopes = new Map<string, ScopeColumn[]>();
    for (const column of columns) scopes.set(column.table_name, [...(scopes.get(column.table_name) ?? []), column]);
    const dependencies = await sql.query<Dependency>(`
      SELECT child.relname AS child_table, parent.relname AS parent_table
      FROM pg_constraint f JOIN pg_class child ON child.oid = f.conrelid
      JOIN pg_class parent ON parent.oid = f.confrelid
      WHERE f.contype = 'f' AND f.connamespace = 'public'::regnamespace
    `);
    const ordered = orderBusinessDeletionTables([...scopes.keys()], dependencies);
    // DELETE guards are authoritative. Never disable triggers or hide a refused
    // purge behind a successful removal of membership. All checks precede writes.
    const guarded = await sql.query<{ table_name: string }>(`
      SELECT DISTINCT c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND (t.tgtype & 8) <> 0
    `);
    const protectedTables: string[] = [];
    const protectedNames = new Set<string>([...guarded.map((row) => row.table_name), ...RETAINED_HISTORY_TABLES]);
    for (const table of protectedNames) {
      const scope = scopes.get(table);
      if (!scope) continue;
      const [row] = await sql.query(`SELECT 1 FROM public.${identifier(table)} WHERE (${scopeFor(scope)}) LIMIT 1`, [businessId]);
      if (row) protectedTables.push(table);
    }
    if (protectedTables.length) throw new BusinessDeletionError("protected_history", protectedTables.sort());

    for (const table of ["sync_runner_leases", "google_ads_runner_leases"]) {
      if (!scopes.has(table)) continue;
      const [lease] = await sql.query(`SELECT 1 FROM public.${identifier(table)}
        WHERE business_id = $1::text AND lease_expires_at > clock_timestamp() FOR UPDATE`, [businessId]);
      if (lease) throw new BusinessDeletionError("business_busy", [table]);
    }
    for (const table of ["provider_sync_jobs", "meta_sync_jobs", "meta_sync_partitions", "google_ads_sync_jobs", "google_ads_sync_partitions", "engine_v3_job_runs"]) {
      const scope = scopes.get(table);
      if (!scope) continue;
      const [job] = await sql.query(`SELECT 1 FROM public.${identifier(table)} WHERE (${scopeFor(scope)})
        AND status IN ('running', 'claimed', 'processing') LIMIT 1 FOR UPDATE`, [businessId]);
      if (job) throw new BusinessDeletionError("business_busy", [table]);
    }

    for (const table of ordered) {
      const scope = scopes.get(table)!;
      // Conflicting text/canonical owners must never widen this delete to another
      // tenant. Nullable legacy references are supported, contradictory ones are not.
      if (scope.length === 2) {
        const [conflict] = await sql.query(`
          SELECT 1 FROM public.${identifier(table)}
          WHERE (${scopeFor(scope)}) AND business_id IS NOT NULL AND business_ref_id IS NOT NULL
            AND business_id::text <> business_ref_id::text LIMIT 1
        `, [businessId]);
        if (conflict) throw new BusinessDeletionError("scope_conflict", [table]);
      }
    }
    for (const table of ordered) {
      if (protectedNames.has(table)) continue;
      // Keep identity writes explicit so the request-path reachability guard can
      // enforce that only the authenticated DELETE boundary reaches this helper.
      if (table === "provider_connections") {
        await sql`DELETE FROM provider_connections WHERE business_id = ${businessId}`;
        continue;
      }
      if (table === "business_provider_accounts") {
        await sql`DELETE FROM business_provider_accounts WHERE business_id = ${businessId}`;
        continue;
      }
      if (table === "provider_account_assignments") {
        await sql`DELETE FROM provider_account_assignments WHERE business_id = ${businessId}`;
        continue;
      }
      const scope = scopeFor(scopes.get(table)!);
      const legacyShareScope = table === "creative_share_snapshots"
        ? ` OR (${scopes.get(table)!.map(({ column_name: name }) => `${identifier(name)} IS NULL`).join(" AND ")} AND payload->>'businessId' = $1::text)` : "";
      await sql.query(`DELETE FROM public.${identifier(table)} WHERE (${scope})${legacyShareScope}`, [businessId]);
    }
    // Credentials cascade only from this business's connections. Shared provider
    // accounts, user identities, global journals and external backups stay intact.
    await sql`UPDATE sessions SET active_business_id = NULL WHERE active_business_id = ${businessId}`;
    await sql`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
  });
}
