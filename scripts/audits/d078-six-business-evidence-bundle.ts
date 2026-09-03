#!/usr/bin/env node
// D078 six-business Meta decision + UI readiness acceptance — Phase A frozen
// evidence bundle.
//
// SELECT-only, one REPEATABLE READ READ ONLY transaction against the
// production database through the established read-only observation path.
// Measures assignment, freshness (by distinct clock), fence/scheduler state,
// economics/targets, campaign-role coverage, native decision generations,
// recommendation-lane state, governance, outcome/learning evidence, and the
// local-HEAD-versus-production schema compatibility surface for exactly the
// six charter businesses. Sanitized: IDs and decision facts only — no
// credentials, tokens, or personal data; error text is truncated and
// credential-shaped substrings are redacted.
//
// Output: docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json
// (deterministic ordering; SHA-256 of the canonical payload printed and
// embedded beside the payload).
import { createHash } from "node:crypto";
import { ASSIGNED_ACCOUNT_STATES_SQL } from "@/lib/meta/assigned-account-states";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const D078_BUNDLE_CONTRACT_VERSION =
  "adsecute.meta.d078-six-business-evidence-bundle.v3";

// Charter-pinned scope: business ids are the identity; names are verified
// against the database, never trusted as identity.
export const D078_BUSINESSES = [
  { name: "IwaStore", businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2" },
  { name: "Grandmix", businessId: "5dbc7147-f051-4681-a4d6-20617170074f" },
  { name: "Bilsem Zeka", businessId: "6c690fa4-6395-40b5-9755-e99b34d69bc3" },
  { name: "TheSwaf", businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3" },
  { name: "IwaTR", businessId: "b79683b4-6f87-48c0-a3ca-44d4356fef51" },
  { name: "ColorFullWorldsTR", businessId: "bc0c6178-7853-4f6f-b026-ef0222a4b9e7" },
] as const;

// The seven pinned assignments (charter table): business id -> exact
// account id(s). An account id under any OTHER business is a scope
// violation even when both ids are individually charter members.
export const D078_CHARTER_ASSIGNMENTS: Record<string, readonly string[]> = {
  "f8a3b5ac-588c-462f-8702-11cd24ff3cd2": ["act_1087566732415606"],
  "5dbc7147-f051-4681-a4d6-20617170074f": ["act_805150454596350"],
  "6c690fa4-6395-40b5-9755-e99b34d69bc3": ["act_840779107261785"],
  "172d0ab8-495b-4679-a4c6-ffa404c389d3": [
    "act_822913786458311",
    "act_921275999286619",
  ],
  "b79683b4-6f87-48c0-a3ca-44d4356fef51": ["act_2335220976649516"],
  "bc0c6178-7853-4f6f-b026-ef0222a4b9e7": ["act_3554615364751964"],
};

// The seven pinned account assignments (charter table): six selected plus
// TheSwaf's deselected-but-assigned second account.
export const D078_CHARTER_ACCOUNT_IDS = [
  "act_1087566732415606",
  "act_805150454596350",
  "act_840779107261785",
  "act_822913786458311",
  "act_921275999286619",
  "act_2335220976649516",
  "act_3554615364751964",
] as const;

// Local-HEAD fence constant for the state-history table (bytes). Recorded so
// the measured production size can be compared against the ceiling this
// worktree would enforce; the deployed build's constant is not readable from
// here and is recorded as unknown.
const LOCAL_HEAD_STATE_HISTORY_BUDGET_BYTES = 5 * 1024 ** 3;
const STATE_HISTORY_TABLE = "meta_entity_state_history";

const JSON_OUT =
  "docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json";

type Row = Record<string, unknown>;

function sanitizeErrorText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-dsn]")
    .replace(/(password|token|secret|authorization|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  const [{ getDb, runDbTransaction }, operational] = await Promise.all([
    import("@/lib/db"),
    import("@/scripts/_operational-runtime"),
  ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  process.env.DB_QUERY_TIMEOUT_MS = "180000";

  const businessIds = D078_BUSINESSES.map((b) => b.businessId);

  const payload = await operational.withOperationalStartupLogsSilenced(
    async () =>
      runDbTransaction(async () => {
        const db = getDb();
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const readOnly = await db.query<{ transaction_read_only: string }>(
          "SHOW transaction_read_only",
        );
        if (readOnly[0]?.transaction_read_only !== "on") {
          throw new Error(
            "D078 bundle refuses to run outside a read-only transaction",
          );
        }
        const isolation = await db.query<{ transaction_isolation: string }>(
          "SHOW transaction_isolation",
        );

        const retrievedAt = (
          await db.query<{ now: string }>("SELECT now()::text AS now")
        )[0]?.now;

        // ------------------------------------------------------------------
        // 1. Identity + assignment
        // ------------------------------------------------------------------
        const businesses = await db.query<Row>(
          `SELECT id::text AS business_id, name, timezone, timezone_source,
                  currency, is_demo_business
             FROM businesses WHERE id = ANY($1::uuid[]) ORDER BY name`,
          [businessIds],
        );

        const accounts = await db.query<Row>(
          `SELECT bpa.business_id, bpa.provider_account_id, bpa.is_selected,
                  bpa.position, bpa.updated_at::text AS assignment_updated_at
             FROM business_provider_accounts bpa
            WHERE bpa.provider = 'meta' AND bpa.business_id = ANY($1::text[])
            ORDER BY bpa.business_id, bpa.provider_account_id`,
          [businessIds],
        );

        const accountIdentity = await db.query<Row>(
          `SELECT DISTINCT ON (business_id, provider_account_id)
                  business_id, provider_account_id, account_name,
                  account_timezone, account_currency, date::text AS latest_fact_date
             FROM meta_account_daily
            WHERE business_id = ANY($1::text[])
            ORDER BY business_id, provider_account_id, date DESC`,
          [businessIds],
        );

        // Last-14-observed-day spend/revenue per account, windowed to each
        // account's own latest fact date (per-account currency; never summed
        // across accounts).
        const accountSpend14 = await db.query<Row>(
          `WITH latest AS (
             SELECT business_id, provider_account_id, MAX(date) AS max_date
               FROM meta_account_daily
              WHERE business_id = ANY($1::text[])
              GROUP BY 1, 2)
           SELECT d.business_id, d.provider_account_id,
                  l.max_date::text AS window_end,
                  (l.max_date - 13)::text AS window_start,
                  d.account_currency,
                  SUM(d.spend)::float8 AS spend_14d,
                  SUM(d.revenue)::float8 AS revenue_14d,
                  SUM(d.conversions)::float8 AS conversions_14d
             FROM meta_account_daily d
             JOIN latest l ON l.business_id = d.business_id
              AND l.provider_account_id = d.provider_account_id
            WHERE d.date > l.max_date - 14 AND d.date <= l.max_date
            GROUP BY 1, 2, 3, 4, 5
            ORDER BY 1, 2`,
          [businessIds],
        );

        // ------------------------------------------------------------------
        // 2. Freshness by distinct clock
        // ------------------------------------------------------------------
        const warehouseFreshness = await db.query<Row>(
          `SELECT business_id, provider_account_id,
                  MAX(date)::text AS max_fact_date,
                  MAX(date) FILTER (WHERE finalized_at IS NOT NULL)::text
                    AS max_finalized_date,
                  MAX(updated_at)::text AS max_row_updated_at
             FROM meta_ad_daily
            WHERE business_id = ANY($1::text[])
            GROUP BY 1, 2 ORDER BY 1, 2`,
          [businessIds],
        );

        const syncFreshness = await db.query<Row>(
          `SELECT business_id, provider_account_id,
                  MAX(finished_at) FILTER (WHERE status = 'succeeded')::text
                    AS last_succeeded_at,
                  MAX(finished_at)::text AS last_any_finished_at
             FROM meta_sync_runs
            WHERE business_id = ANY($1::text[])
            GROUP BY 1, 2 ORDER BY 1, 2`,
          [businessIds],
        );

        const syncTail = await db.query<Row>(
          `SELECT business_id, provider_account_id, lane, scope, status,
                  error_class, finished_at::text AS finished_at
             FROM meta_sync_runs
            WHERE business_id = ANY($1::text[])
            ORDER BY COALESCE(finished_at, created_at) DESC NULLS LAST
            LIMIT 8`,
          [businessIds],
        );

        const observationFreshness = await db.query<Row>(
          `SELECT business_id, provider_account_id, entity_type,
                  MAX(observed_at) FILTER (WHERE completeness = 'complete')::text
                    AS last_complete_observed_at,
                  MAX(observed_at)::text AS last_any_observed_at
             FROM meta_entity_observation_runs
            WHERE business_id = ANY($1::text[])
            GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
          [businessIds],
        );

        const osSnapshotFreshness = await db.query<Row>(
          `SELECT DISTINCT ON (business_id)
                  business_id, surface, status, decision_as_of::text AS decision_as_of,
                  generated_at::text AS generated_at
             FROM creative_decision_os_snapshots
            WHERE business_id = ANY($1::text[])
            ORDER BY business_id, generated_at DESC`,
          [businessIds],
        );

        const recommendationFreshness = await db.query<Row>(
          `SELECT business_id, MAX(snapshot_date)::text AS max_snapshot_date,
                  MAX(created_at)::text AS max_created_at,
                  COUNT(*)::int AS total_rows
             FROM meta_decision_snapshots_daily
            WHERE business_id = ANY($1::text[])
            GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        // ------------------------------------------------------------------
        // 3. Fence + scheduler/worker evidence (invocation vs admission vs
        //    execution vs data arrival are separate facts)
        // ------------------------------------------------------------------
        // Fleet-intrinsic physical facts (a table has one size for the whole
        // fleet; the durable worker is one process). Kept OUT of the
        // six-business sections and served under fleetGlobal only.
        const fenceGlobal = (
          await db.query<Row>(
            `SELECT pg_total_relation_size('${STATE_HISTORY_TABLE}')::bigint::text AS total_bytes,
                    (SELECT reltuples::bigint::text FROM pg_class
                      WHERE relname = '${STATE_HISTORY_TABLE}') AS approx_rows`,
          )
        )[0];

        const stateHistoryLastWriteGlobal = (
          await db.query<Row>(
            `SELECT MAX(created_at)::text AS last_state_write_at
               FROM ${STATE_HISTORY_TABLE}`,
          )
        )[0];

        // last_business_id deliberately NOT selected: heartbeats are fleet
        // rows and may name non-charter businesses.
        const workerHeartbeatsGlobal = await db.query<Row>(
          `SELECT worker_id, instance_type, provider_scope, status,
                  last_heartbeat_at::text AS last_heartbeat_at
             FROM sync_worker_heartbeats
            ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 5`,
        );

        const syncIncidents = await db.query<Row>(
          `SELECT business_id, provider_scope, fault_class, status,
                  blocker_class, observation_count,
                  first_seen_at::text AS first_seen_at,
                  last_seen_at::text AS last_seen_at,
                  cleared_at::text AS cleared_at
             FROM sync_incidents
            WHERE provider_scope IN ('meta', 'all')
              AND (business_id IS NULL OR business_id = ANY($1::text[]))
            ORDER BY last_seen_at DESC NULLS LAST LIMIT 10`,
          [businessIds],
        );

        const syncJobsTail = await db.query<Row>(
          `SELECT business_id, provider_account_id, sync_type, status,
                  trigger_source, finished_at::text AS finished_at,
                  updated_at::text AS updated_at
             FROM meta_sync_jobs
            WHERE business_id = ANY($1::text[])
            ORDER BY updated_at DESC NULLS LAST LIMIT 8`,
          [businessIds],
        );

        // ------------------------------------------------------------------
        // 4. Economics: target packs, cost truth, calibration
        // ------------------------------------------------------------------
        const targetPacks = await db.query<Row>(
          `SELECT COALESCE(business_ref_id, business_id)::text AS business_id,
                  target_cpa, target_roas, break_even_cpa, break_even_roas,
                  contribution_margin_assumption, aov_assumption,
                  cost_cogs_percent, cost_shipping_percent,
                  cost_fulfillment_percent, cost_payment_processing_percent,
                  source_label, updated_at::text AS updated_at
             FROM business_target_packs
            WHERE COALESCE(business_ref_id, business_id) = ANY($1::uuid[])
            ORDER BY 1`,
          [businessIds],
        );

        const costModels = await db.query<Row>(
          `SELECT COALESCE(business_ref_id, business_id)::text AS business_id,
                  cogs_percent, shipping_percent, fee_percent,
                  fixed_monthly_cost, updated_at::text AS updated_at
             FROM business_cost_models
            WHERE COALESCE(business_ref_id, business_id) = ANY($1::uuid[])
            ORDER BY 1`,
          [businessIds],
        );

        const calibrationProfiles = await db.query<Row>(
          `SELECT COALESCE(business_ref_id, business_id)::text AS business_id,
                  COUNT(*)::int AS profile_count,
                  ARRAY_AGG(DISTINCT archetype ORDER BY archetype) AS archetypes,
                  ARRAY_AGG(DISTINCT objective_family ORDER BY objective_family)
                    AS objective_families
             FROM business_decision_calibration_profiles
            WHERE COALESCE(business_ref_id, business_id) = ANY($1::uuid[])
            GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        // Objective / optimization-goal spend mix per account over each
        // account's own last 14 observed campaign-fact days.
        const goalMix = await db.query<Row>(
          `WITH latest AS (
             SELECT business_id, provider_account_id, MAX(date) AS max_date
               FROM meta_campaign_daily
              WHERE business_id = ANY($1::text[])
              GROUP BY 1, 2),
           latest_config AS (
             SELECT DISTINCT ON (business_id, provider_account_id, campaign_id)
                    business_id, provider_account_id, campaign_id,
                    objective, optimization_goal, custom_event_type
               FROM meta_campaign_config_history
              WHERE business_id = ANY($1::text[])
              ORDER BY business_id, provider_account_id, campaign_id,
                       captured_at DESC)
           SELECT d.business_id, d.provider_account_id,
                  COALESCE(c.objective, 'UNKNOWN') AS objective,
                  COALESCE(c.optimization_goal, 'UNKNOWN') AS optimization_goal,
                  COALESCE(c.custom_event_type, '') AS custom_event_type,
                  SUM(d.spend)::float8 AS spend_14d,
                  SUM(d.revenue)::float8 AS revenue_14d,
                  COUNT(DISTINCT d.campaign_id)::int AS campaigns
             FROM meta_campaign_daily d
             JOIN latest l ON l.business_id = d.business_id
              AND l.provider_account_id = d.provider_account_id
             LEFT JOIN latest_config c ON c.business_id = d.business_id
              AND c.provider_account_id = d.provider_account_id
              AND c.campaign_id = d.campaign_id
            WHERE d.date > l.max_date - 14 AND d.date <= l.max_date
              AND d.spend > 0
            GROUP BY 1, 2, 3, 4, 5
            ORDER BY 1, 2, 6 DESC`,
          [businessIds],
        );

        // ------------------------------------------------------------------
        // 5. Campaign-role/context rows (automatic authority only)
        // ------------------------------------------------------------------
        const contextRows = await db.query<Row>(
          `SELECT business_id,
                  COUNT(*)::int AS total_rows,
                  COUNT(*) FILTER (WHERE provider_account_id IS NULL)::int
                    AS account_null_rows,
                  COUNT(*) FILTER (WHERE provider_account_id IS NOT NULL)::int
                    AS account_bound_rows,
                  MAX(as_of_date)::text AS max_as_of,
                  ARRAY_AGG(DISTINCT resolver_version) AS resolver_versions
             FROM engine_v3_campaign_context_daily
            WHERE business_id = ANY($1::text[])
            GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        // Fleet denominator for the account-NULL v1-shadow population; the
        // per-six counts above are the six-business claim.
        const campaignContextGlobal = (
          await db.query<Row>(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE provider_account_id IS NULL)::int
                      AS account_null,
                    MAX(as_of_date)::text AS max_as_of
               FROM engine_v3_campaign_context_daily`,
          )
        )[0];

        // ------------------------------------------------------------------
        // 6. Native exact-Ad decision generations (persisted-authorized is
        //    NOT presentation-actionable and NOT execution-eligible)
        // ------------------------------------------------------------------
        const nativeGenerations = await db.query<Row>(
          `WITH latest AS (
             SELECT business_id, provider_account_id, MAX(as_of_date) AS as_of
               FROM engine_v3_ad_decision_snapshots_daily
              WHERE business_id = ANY($1::text[])
              GROUP BY 1, 2)
           SELECT s.business_id, s.provider_account_id,
                  l.as_of::text AS as_of_date,
                  COUNT(*)::int AS rows,
                  ARRAY_AGG(DISTINCT s.engine_version) AS engine_versions,
                  MAX(s.computed_at)::text AS max_computed_at,
                  COUNT(*) FILTER (WHERE s.authorized_action IS NOT NULL)::int
                    AS authorized_rows,
                  COUNT(*) FILTER (WHERE s.blocked_action_type IS NOT NULL)::int
                    AS blocked_rows,
                  COUNT(*) FILTER (WHERE s.authority_blocker IS NOT NULL)::int
                    AS authority_blocked_rows
             FROM engine_v3_ad_decision_snapshots_daily s
             JOIN latest l ON l.business_id = s.business_id
              AND l.provider_account_id = s.provider_account_id
              AND l.as_of = s.as_of_date
            GROUP BY 1, 2, 3 ORDER BY 1, 2`,
          [businessIds],
        );

        const nativeLabelMix = await db.query<Row>(
          `WITH latest AS (
             SELECT business_id, provider_account_id, MAX(as_of_date) AS as_of
               FROM engine_v3_ad_decision_snapshots_daily
              WHERE business_id = ANY($1::text[])
              GROUP BY 1, 2)
           SELECT s.business_id, s.provider_account_id, s.label,
                  COUNT(*)::int AS rows
             FROM engine_v3_ad_decision_snapshots_daily s
             JOIN latest l ON l.business_id = s.business_id
              AND l.provider_account_id = s.provider_account_id
              AND l.as_of = s.as_of_date
            GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC, 3`,
          [businessIds],
        );

        const hardActions = await db.query<Row>(
          `WITH latest AS (
             SELECT business_id, provider_account_id, MAX(as_of_date) AS as_of
               FROM engine_v3_ad_decision_snapshots_daily
              WHERE business_id = ANY($1::text[])
              GROUP BY 1, 2)
           SELECT s.business_id, s.provider_account_id,
                  s.as_of_date::text AS as_of_date, s.ad_id, s.creative_id,
                  s.label, s.raw_label, s.authorized_action,
                  s.blocked_action_type, s.authority_blocker, s.confidence,
                  s.truth_source, s.effective_target_roas, s.ratio_to_target,
                  s.spend, s.purchases, s.roas, s.recent7d_roas,
                  s.engine_version, s.computed_at::text AS computed_at,
                  s.evaluation_id::text AS evaluation_id,
                  s.input_hash, s.decision_hash,
                  LEFT(s.reason, 300) AS reason
             FROM engine_v3_ad_decision_snapshots_daily s
             JOIN latest l ON l.business_id = s.business_id
              AND l.provider_account_id = s.provider_account_id
              AND l.as_of = s.as_of_date
            WHERE s.authorized_action IS NOT NULL
            ORDER BY s.business_id, s.provider_account_id, s.ad_id`,
          [businessIds],
        );

        // Deterministic stratified sample for Phase B: per business/account
        // latest generation — up to 2 blocked/diagnose, 1 keep/test-more,
        // 1 out-of-scope (ordered by ad_id).
        const stratifiedSample = await db.query<Row>(
          `WITH latest AS (
             SELECT business_id, provider_account_id, MAX(as_of_date) AS as_of
               FROM engine_v3_ad_decision_snapshots_daily
              WHERE business_id = ANY($1::text[])
              GROUP BY 1, 2),
           g AS (
             SELECT s.*,
               CASE
                 WHEN s.blocked_action_type IS NOT NULL
                   OR s.label LIKE 'diagnose%' THEN 'blocked_or_diagnose'
                 WHEN s.label IN ('keep', 'test_more') THEN 'keep_or_test_more'
                 WHEN s.label = 'out_of_scope' THEN 'out_of_scope'
                 ELSE NULL
               END AS stratum
             FROM engine_v3_ad_decision_snapshots_daily s
             JOIN latest l ON l.business_id = s.business_id
              AND l.provider_account_id = s.provider_account_id
              AND l.as_of = s.as_of_date),
           ranked AS (
             SELECT g.*, ROW_NUMBER() OVER (
               PARTITION BY g.business_id, g.provider_account_id, g.stratum
               ORDER BY g.ad_id) AS rn
             FROM g WHERE g.stratum IS NOT NULL)
           SELECT business_id, provider_account_id,
                  as_of_date::text AS as_of_date, ad_id, stratum, label,
                  raw_label, blocked_action_type, authority_blocker,
                  confidence, spend, purchases, roas, effective_target_roas,
                  ratio_to_target, truth_source,
                  evaluation_id::text AS evaluation_id, input_hash,
                  decision_hash, computed_at::text AS computed_at,
                  LEFT(reason, 300) AS reason
             FROM ranked
            WHERE (stratum = 'blocked_or_diagnose' AND rn <= 2)
               OR (stratum <> 'blocked_or_diagnose' AND rn <= 1)
            ORDER BY business_id, provider_account_id, stratum, ad_id`,
          [businessIds],
        );

        const nativeJobTail = await db.query<Row>(
          `SELECT business_id, job_name, as_of_date::text AS as_of_date,
                  status, error_code,
                  finished_at::text AS finished_at, row_count
             FROM engine_v3_job_runs
            WHERE business_id = ANY($1::text[])
              AND job_name IN ('engine_v3_native_ad_decisions_shadow_job',
                               'engine_v3_native_ad_calibration_shadow_job')
            ORDER BY created_at DESC LIMIT 18`,
          [businessIds],
        );

        // ------------------------------------------------------------------
        // 7. Governance / controls / receipts
        // ------------------------------------------------------------------
        const automationControls = await db.query<Row>(
          `SELECT business_id::text AS business_id, kill_switch_engaged,
                  kill_switch_reason, auto_execution_enabled, readiness_tier,
                  guardrails_json, min_roas_floor,
                  quiet_hours_start::text AS quiet_hours_start,
                  quiet_hours_end::text AS quiet_hours_end,
                  quiet_hours_timezone,
                  updated_at::text AS updated_at
             FROM meta_automation_business_controls
            WHERE business_id = ANY($1::uuid[]) ORDER BY 1`,
          [businessIds],
        );

        const automationRules = await db.query<Row>(
          `SELECT business_id::text AS business_id, COUNT(*)::int AS rules,
                  COUNT(*) FILTER (WHERE active)::int AS active_rules
             FROM meta_automation_rules
            WHERE business_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        const proposals = await db.query<Row>(
          `SELECT business_id::text AS business_id, status,
                  COUNT(*)::int AS rows, MAX(created_at)::text AS latest_at
             FROM meta_automation_proposals
            WHERE business_id = ANY($1::uuid[])
            GROUP BY 1, 2 ORDER BY 1, 2`,
          [businessIds],
        );

        const promotionRecords = await db.query<Row>(
          `SELECT business_id::text AS business_id, COUNT(*)::int AS rows
             FROM meta_automation_promotion_records
            WHERE business_id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        const decisionTypeModes = await db.query<Row>(
          `SELECT business_id::text AS business_id, decision_type, mode,
                  lock_reason
             FROM meta_automation_decision_type_modes
            WHERE business_id = ANY($1::uuid[]) ORDER BY 1, 2`,
          [businessIds],
        );

        const engineFlags = await db.query<Row>(
          `SELECT business_id::text AS business_id, enabled, surface_visible,
                  shadow_only, preset_override
             FROM business_engine_v3_flags
            WHERE business_id = ANY($1::uuid[]) ORDER BY 1`,
          [businessIds],
        );

        const actionLog = await db.query<Row>(
          `SELECT business_id::text AS business_id, status,
                  COUNT(*)::int AS rows,
                  COUNT(*) FILTER (WHERE dry_run)::int AS dry_run_rows,
                  COUNT(*) FILTER (WHERE provider_verified)::int
                    AS provider_verified_rows,
                  COUNT(*) FILTER (WHERE decision_episode_key IS NOT NULL)::int
                    AS native_origin_rows,
                  MAX(requested_at)::text AS latest_requested_at
             FROM meta_ads_action_log
            WHERE business_id = ANY($1::uuid[])
            GROUP BY 1, 2 ORDER BY 1, 2`,
          [businessIds],
        );

        const operatorReceipts = await db.query<Row>(
          `SELECT business_id, action_status, COUNT(*)::int AS rows,
                  MAX(captured_at)::text AS latest_captured_at
             FROM engine_v3_ad_operator_action_receipts
            WHERE business_id = ANY($1::text[])
            GROUP BY 1, 2 ORDER BY 1, 2`,
          [businessIds],
        );

        const commandJournal = await db.query<Row>(
          `SELECT COALESCE(business_ref_id, business_id)::text AS business_id,
                  COUNT(*)::int AS rows, MAX(created_at)::text AS latest_at
             FROM command_center_action_journal
            WHERE COALESCE(business_ref_id, business_id) = ANY($1::uuid[])
            GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        // ------------------------------------------------------------------
        // 8. Outcome / learning evidence
        // ------------------------------------------------------------------
        const outcomesFleetGlobal = (
          await db.query<Row>(
            `SELECT COUNT(*)::int AS total_rows FROM engine_v3_ad_decision_outcomes_daily`,
          )
        )[0];

        const outcomesSixBusinesses = (
          await db.query<Row>(
            `SELECT COUNT(*)::int AS total_rows
               FROM engine_v3_ad_decision_outcomes_daily
              WHERE business_id = ANY($1::text[])`,
            [businessIds],
          )
        )[0];

        const outcomesPerBusiness = await db.query<Row>(
          `SELECT business_id, outcome_window_days, COUNT(*)::int AS rows,
                  COUNT(*) FILTER (WHERE window_complete)::int AS complete_rows,
                  MAX(evaluation_date)::text AS max_evaluation_date
             FROM engine_v3_ad_decision_outcomes_daily
            WHERE business_id = ANY($1::text[])
            GROUP BY 1, 2 ORDER BY 1, 2`,
          [businessIds],
        );

        const outcomeRunsTail = await db.query<Row>(
          `SELECT business_id, evaluation_date::text AS evaluation_date, status,
                  candidate_row_count, persisted_row_count,
                  started_at::text AS started_at,
                  completed_at::text AS completed_at
             FROM engine_v3_ad_decision_outcome_runs
            WHERE business_id = ANY($1::text[])
            ORDER BY created_at DESC LIMIT 10`,
          [businessIds],
        );

        const operatorResponses = await db.query<Row>(
          `SELECT business_id, COUNT(*)::int AS rows,
                  COUNT(*) FILTER (WHERE window_closed)::int AS closed_rows,
                  MAX(response_cutoff)::text AS max_response_cutoff
             FROM engine_v3_ad_operator_responses
            WHERE business_id = ANY($1::text[])
            GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        const experimentsSixBusinesses = (
          await db.query<Row>(
            `SELECT COUNT(*)::int AS experiments
               FROM meta_controlled_experiments
              WHERE business_id = ANY($1::uuid[])`,
            [businessIds],
          )
        )[0];
        const experimentsFleetGlobal = (
          await db.query<Row>(
            `SELECT (SELECT COUNT(*)::int FROM meta_controlled_experiments) AS experiments,
                    (SELECT COUNT(*)::int FROM meta_controlled_experiment_arms) AS arms,
                    (SELECT COUNT(*)::int FROM meta_controlled_random_assignments) AS assignments`,
          )
        )[0];

        const jobHealth = await db.query<Row>(
          `SELECT job_name,
                  MAX(created_at) FILTER (WHERE status = 'success')::text
                    AS last_succeeded_at,
                  MAX(created_at) FILTER (WHERE status <> 'success')::text
                    AS last_non_success_at,
                  COUNT(*) FILTER (WHERE status <> 'success')::int
                    AS non_success_rows
             FROM engine_v3_job_runs
            WHERE business_id = ANY($1::text[])
            GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );
        // Fleet denominator, deliberately separate: the six-business counts
        // above are the operational claim; these are all businesses.
        const jobHealthFleetGlobal = await db.query<Row>(
          `SELECT job_name,
                  COUNT(*) FILTER (WHERE status <> 'success')::int
                    AS non_success_rows,
                  COUNT(*)::int AS total_rows
             FROM engine_v3_job_runs
            GROUP BY 1 ORDER BY 1`,
        );

        const jobFailureTail = await db.query<Row>(
          `SELECT job_name, business_id, status, error_code,
                  LEFT(error_message, 300) AS error_message,
                  created_at::text AS created_at
             FROM engine_v3_job_runs
            WHERE status <> 'success' AND business_id = ANY($1::text[])
            ORDER BY created_at DESC LIMIT 12`,
          [businessIds],
        );

        // ------------------------------------------------------------------
        // 8b. The exact shipped assigned-account-states read, per business,
        //     against REAL production data inside this same RR RO
        //     transaction (D078 correction 2, C2.6): proves the new
        //     data-connected read path on production, not only on fixtures.
        // ------------------------------------------------------------------
        const assignedAccountStatesProbe: Row[] = [];
        for (const businessId of businessIds) {
          const rows = await db.query<Row>(ASSIGNED_ACCOUNT_STATES_SQL, [
            businessId,
          ]);
          for (const row of rows) {
            assignedAccountStatesProbe.push({ business_id: businessId, ...row });
          }
        }

        // ------------------------------------------------------------------
        // 9. Local-HEAD vs production schema compatibility surface
        // ------------------------------------------------------------------
        const d075Columns = await db.query<Row>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'meta_entity_observation_runs'
              AND column_name IN ('manifest_kind','base_run_id',
                                  'delta_stats_json','last_captured_at')
            ORDER BY column_name`,
        );
        const compactionTables = await db.query<Row>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name LIKE '%compaction%'
            ORDER BY table_name`,
        );

        return {
          retrievedAt,
          transactionIsolation: isolation[0]?.transaction_isolation,
          // Everything OUTSIDE fleetGlobal is strictly six-business scoped
          // (charter business ids; account-owned rows to the seven pinned
          // assignments). The scope guard test enforces this recursively.
          identity: { businesses, accounts, accountIdentity, accountSpend14 },
          freshnessClocks: {
            warehouseFreshness,
            syncFreshness,
            syncTail: syncTail.map((r) => ({
              ...r,
              error_class: sanitizeErrorText(r.error_class),
            })),
            observationFreshness,
            osSnapshotFreshness,
            recommendationFreshness,
          },
          scheduler: {
            syncIncidents: syncIncidents.map((r) => ({
              ...r,
              blocker_class: sanitizeErrorText(r.blocker_class),
            })),
            syncJobsTail,
          },
          economics: { targetPacks, costModels, calibrationProfiles, goalMix },
          campaignContext: { contextRows },
          assignedAccountStatesProbe,
          nativeDecisions: {
            nativeGenerations,
            nativeLabelMix,
            hardActions: hardActions.map((r) => ({
              ...r,
              reason: sanitizeErrorText(r.reason),
            })),
            stratifiedSample: stratifiedSample.map((r) => ({
              ...r,
              reason: sanitizeErrorText(r.reason),
            })),
            nativeJobTail: nativeJobTail.map((r) => ({
              ...r,
              error_code: sanitizeErrorText(r.error_code),
            })),
          },
          governance: {
            automationControls,
            automationRules,
            proposals,
            promotionRecords,
            decisionTypeModes,
            engineFlags,
            actionLog,
            operatorReceipts,
            commandJournal,
          },
          outcomes: {
            outcomesSixBusinesses,
            outcomesPerBusiness,
            outcomeRunsTail,
            operatorResponses,
            experimentsSixBusinesses,
            jobHealth,
            jobFailureTail: jobFailureTail.map((r) => ({
              ...r,
              error_message: sanitizeErrorText(r.error_message),
            })),
          },
          // Fleet/global structural facts that cannot be business-scoped.
          // Each entry names its scope; none of these numbers may stand in
          // for a six-business claim.
          fleetGlobal: {
            scopeNote:
              "Every value in this object is fleet-wide (all businesses / physical database objects / singleton worker processes). Six-business claims live exclusively in the sibling sections.",
            stateHistoryFence: {
              scope: "physical table, whole fleet",
              stateHistoryTable: STATE_HISTORY_TABLE,
              measuredBytes: fenceGlobal?.total_bytes ?? null,
              approxRows: fenceGlobal?.approx_rows ?? null,
              localHeadBudgetBytes: LOCAL_HEAD_STATE_HISTORY_BUDGET_BYTES,
              deployedBudgetBytes: "unknown_not_readable_from_here",
              lastStateWriteAt:
                stateHistoryLastWriteGlobal?.last_state_write_at ?? null,
            },
            workerHeartbeats: {
              scope: "singleton durable workers, whole fleet",
              rows: workerHeartbeatsGlobal,
            },
            campaignContext: {
              scope: "all businesses (denominator for the account-NULL census)",
              ...campaignContextGlobal,
            },
            outcomes: {
              scope: "all businesses",
              ...outcomesFleetGlobal,
            },
            experiments: {
              scope:
                "all businesses (arms/assignments tables carry no business key)",
              ...experimentsFleetGlobal,
            },
            jobHealth: {
              scope:
                "all businesses; numerator non_success_rows over denominator total_rows per job",
              rows: jobHealthFleetGlobal,
            },
          },
          schemaCompatibility: {
            d075ObservationRunColumnsPresent: d075Columns.map(
              (r) => r.column_name,
            ),
            compactionTablesPresent: compactionTables.map((r) => r.table_name),
            note:
              "Local HEAD expects manifest_kind/base_run_id/delta_stats_json/last_captured_at on meta_entity_observation_runs and the D077 compaction journal table; their absence above is the exact local-HEAD-versus-production schema gap.",
          },
        };
      }),
  );

  let localGitHead = "unknown";
  let localDirtyEntries = -1;
  try {
    localGitHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    localDirtyEntries = execSync("git status --porcelain", {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean).length;
  } catch {
    // metadata only
  }

  const bundle = {
    contract: D078_BUNDLE_CONTRACT_VERSION,
    generatedFor: "D078 six-business Meta decision + UI readiness acceptance",
    operatingClass: "read_only",
    businesses: D078_BUSINESSES,
    scopeContract: {
      charterBusinessIds: D078_BUSINESSES.map((b) => b.businessId),
      charterAccountIds: D078_CHARTER_ACCOUNT_IDS,
      charterAssignments: D078_CHARTER_ASSIGNMENTS,
      rule:
        "Every business_id / provider_account_id occurring outside payload.fleetGlobal must belong to the lists above (or be null), and every row carrying BOTH must be one of the seven pinned business->account assignments exactly. payload.fleetGlobal carries explicitly-labelled fleet facts only.",
    },
    localWorktree: { gitHead: localGitHead, dirtyEntries: localDirtyEntries },
    payload,
  };
  const bundleHash = sha256(bundle);
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, `${JSON.stringify({ bundleHash, ...bundle }, null, 1)}\n`);
  console.log(`bundle written: ${JSON_OUT}`);
  console.log(`bundleHash: ${bundleHash}`);
  console.log(`retrievedAt: ${bundle.payload.retrievedAt}`);
  console.log(`isolation: ${bundle.payload.transactionIsolation}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
