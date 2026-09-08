/**
 * Ephemeral-Postgres "migrations from zero" verification.
 *
 * Boots a throwaway PostgreSQL 16 cluster (Homebrew binaries, no Docker) in an
 * OS temp directory on a random free port, creates an empty database, runs the
 * repo's real deploy migration entry point (scripts/run-migrations.ts →
 * lib/migrations.ts runMigrations) against it three times — first run must
 * build the full schema from zero, second run upgrades seeded prior-epoch
 * constraints, and third run proves post-upgrade idempotency —
 * then asserts key Engine v3 tables/columns exist.
 *
 * Hard safety rules:
 * - NEVER connects to 127.0.0.1:15432 (live prod tunnel) or 5432 (local
 *   volume Postgres). Both ports are rejected outright.
 * - DATABASE_URL is force-set on the child process env; @next/env's
 *   loadEnvConfig never overrides pre-existing process.env values, so the
 *   .env.local prod tunnel URL can never leak into the migration run.
 * - The cluster and its temp directory are always stopped/deleted in a
 *   finally block, even on failure.
 *
 * Usage: npm run test:migrations-from-zero
 * Env overrides:
 *   EPHEMERAL_PG_BIN_DIR  — directory containing initdb/pg_ctl/postgres
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { DbClient } from "@/lib/db";
import { inspectEvaluationStoreSchemaCapability } from "@/lib/creative-decision-engine/evaluation-store";
import { inspectNativeAdCalibrationSchemaCapability } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { inspectAdDecisionOutcomeSchemaCapability } from "@/lib/creative-decision-engine/jobs/ad-decision-outcomes-job";
import {
  AD_OPERATOR_RESPONSE_EPOCH_COMPATIBILITY_SQL,
  inspectAdOperatorResponseSchemaCapability,
  NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
} from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import { AD_DECISIONS_JOB_NAME } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "@/lib/creative-decision-engine/execution-safety";
import {
  NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS,
  NATIVE_DECISION_RUNNING_GRACE_MS,
  READ_NATIVE_DECISION_GENERATION_QUERY,
} from "@/lib/meta/decisions-workspace-read-model";
import { createControlledExperimentRegistryStore } from "@/lib/meta/controlled-experiment-registry";
import { D086_REQUIRED_PROFILE_COLUMNS } from "@/lib/meta/budget-readiness-retention";

const FORBIDDEN_PORTS = new Set([15432, 5432]);
const EPHEMERAL_DB_NAME = "adsecute_migrations_from_zero";
const EPHEMERAL_DB_USER = "postgres";
const REQUIRED_TABLES = [
  "engine_v3_account_profile_output",
  "engine_v3_decision_snapshots_daily",
  "engine_v3_decision_outcomes_daily",
  "engine_v3_decision_evaluation_contexts",
  "engine_v3_decision_evaluations",
  "engine_v3_campaign_context_daily",
  "engine_v3_job_runs",
  "engine_v3_decision_events",
  "business_target_pack_history",
  "meta_entity_observation_runs",
  "meta_entity_state_history",
  "meta_campaign_label_history",
  "meta_entity_tombstones",
  "meta_creative_lineage_edges",
  "engine_v3_ad_account_calibration_batches",
  "engine_v3_ad_account_calibration_daily",
  "engine_v3_ad_decision_evaluation_contexts",
  "engine_v3_ad_decision_evaluations",
  "engine_v3_ad_decision_snapshots_daily",
  "engine_v3_ad_decision_events",
  "engine_v3_ad_recommendation_episodes",
  "engine_v3_ad_operator_action_receipts",
  "engine_v3_ad_operator_response_events",
  "engine_v3_ad_operator_responses",
  "engine_v3_ad_decision_outcome_runs",
  "engine_v3_ad_decision_outcome_publications",
  "engine_v3_ad_decision_outcomes_daily",
  "meta_controlled_experiments",
  "meta_controlled_experiment_arms",
  "meta_controlled_assignment_batches",
  "meta_controlled_random_assignments",
  "meta_controlled_seed_reveals",
  "meta_controlled_control_outcome_observations",
  "meta_controlled_control_estimates",
  "meta_creative_briefs",
  "meta_launch_intents",
  "meta_ads_action_mutation_attempt_events",
  "meta_ads_action_reconciliation_events",
  "meta_ads_duplicate_action_attempt_events",
  "meta_ads_duplicate_action_reconciliation_events",
  "meta_ads_duplicate_reconciliation_observations",
] as const;
const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  /*
    The success-only retained bounds the Shopify order-coverage proof reads.

    Without them `readOrderSyncCoverage`'s SELECT throws and its catch returns
    null, which the seam child treats as a hard failure — this only makes the
    diagnosis say which column is missing instead of "coverage unreadable".
  */
  { table: "shopify_sync_state", column: "latest_successful_sync_window_start" },
  { table: "shopify_sync_state", column: "latest_successful_sync_window_end" },
  { table: "engine_v3_decision_snapshots_daily", column: "raw_label" },
  {
    table: "engine_v3_decision_snapshots_daily",
    column: "pre_authority_label",
  },
  { table: "engine_v3_decision_snapshots_daily", column: "authority_blocker" },
  { table: "engine_v3_decision_outcomes_daily", column: "pre_authority_label" },
  { table: "engine_v3_decision_outcomes_daily", column: "authority_blocker" },
  {
    table: "engine_v3_decision_snapshots_daily",
    column: "blocked_action_type",
  },
  { table: "engine_v3_decision_snapshots_daily", column: "evaluation_id" },
  { table: "engine_v3_decision_snapshots_daily", column: "input_hash" },
  { table: "engine_v3_decision_snapshots_daily", column: "decision_hash" },
  {
    table: "engine_v3_decision_evaluation_contexts",
    column: "business_ref_id",
  },
  { table: "engine_v3_decision_evaluation_contexts", column: "as_of_date" },
  { table: "engine_v3_decision_evaluation_contexts", column: "engine_version" },
  { table: "engine_v3_decision_evaluation_contexts", column: "scope_type" },
  { table: "engine_v3_decision_evaluation_contexts", column: "scope_id" },
  {
    table: "engine_v3_decision_evaluation_contexts",
    column: "contract_version",
  },
  { table: "engine_v3_decision_evaluation_contexts", column: "context_json" },
  {
    table: "engine_v3_decision_evaluation_contexts",
    column: "account_profile_json",
  },
  {
    table: "engine_v3_decision_evaluation_contexts",
    column: "data_health_json",
  },
  { table: "engine_v3_decision_evaluation_contexts", column: "flags_json" },
  { table: "engine_v3_decision_evaluation_contexts", column: "context_hash" },
  { table: "engine_v3_decision_evaluation_contexts", column: "job_run_id" },
  { table: "engine_v3_decision_evaluation_contexts", column: "evaluated_at" },
  { table: "engine_v3_decision_evaluations", column: "context_id" },
  { table: "engine_v3_decision_evaluations", column: "business_ref_id" },
  { table: "engine_v3_decision_evaluations", column: "creative_id" },
  { table: "engine_v3_decision_evaluations", column: "as_of_date" },
  { table: "engine_v3_decision_evaluations", column: "engine_version" },
  { table: "engine_v3_decision_evaluations", column: "scope_type" },
  { table: "engine_v3_decision_evaluations", column: "scope_id" },
  { table: "engine_v3_decision_evaluations", column: "contract_version" },
  { table: "engine_v3_decision_evaluations", column: "creative_input_json" },
  { table: "engine_v3_decision_evaluations", column: "campaign_context_json" },
  { table: "engine_v3_decision_evaluations", column: "prior_hysteresis_json" },
  { table: "engine_v3_decision_evaluations", column: "decision_output_json" },
  { table: "engine_v3_decision_evaluations", column: "raw_label" },
  { table: "engine_v3_decision_evaluations", column: "hysteresis_suppressed" },
  { table: "engine_v3_decision_evaluations", column: "input_hash" },
  { table: "engine_v3_decision_evaluations", column: "decision_hash" },
  { table: "engine_v3_decision_evaluations", column: "job_run_id" },
  { table: "engine_v3_decision_evaluations", column: "evaluated_at" },
  { table: "meta_creative_briefs", column: "source_snapshot_id" },
  { table: "meta_creative_briefs", column: "idempotency_key" },
  { table: "meta_creative_briefs", column: "version" },
  { table: "meta_launch_drafts", column: "provider_account_id" },
  { table: "meta_launch_templates", column: "provider_account_id" },
  { table: "meta_launch_intents", column: "requested_status" },
  { table: "meta_ads_action_log", column: "launch_intent_id" },
  { table: "creative_share_snapshots", column: "provider_account_id" },
  { table: "meta_entity_observation_runs", column: "observed_at" },
  { table: "meta_entity_observation_runs", column: "captured_at" },
  { table: "meta_entity_observation_runs", column: "completeness" },
  { table: "meta_entity_state_history", column: "run_completeness" },
  { table: "meta_entity_state_history", column: "budget_origin" },
  { table: "meta_entity_state_history", column: "learning_source" },
  { table: "meta_entity_state_history", column: "field_coverage_json" },
  // D083 budget-fact observation columns.
  { table: "meta_entity_state_history", column: "campaign_start_time" },
  { table: "meta_entity_state_history", column: "campaign_end_time" },
  { table: "meta_entity_state_history", column: "adset_start_time" },
  { table: "meta_entity_state_history", column: "adset_end_time" },
  { table: "meta_entity_state_history", column: "budget_currency_exponent" },
  { table: "meta_entity_state_history", column: "budget_currency_registry_version" },
  { table: "meta_entity_state_history", column: "provider_api_version" },
  /*
    PRE-DEPLOY AUDIT: `budget_shape_support` was added by the same D083 slice
    and is read by production SQL (budget-readiness-read-model.ts), but was
    listed in neither schema gate — so a database missing that one ALTER
    reported green here and failed at runtime as a broken readiness read.
  */
  { table: "meta_entity_state_history", column: "budget_shape_support" },
  /*
    PR #272 review: the scheduled budget sweep now SELECTs this column in its
    enablement query and scopes the whole queue page to it, so a database
    missing that one ALTER would fail the sweep at runtime rather than here.
  */
  {
    table: "meta_automation_business_controls",
    column: "auto_execution_provider_account_id",
  },
  {
    table: "meta_automation_business_controls",
    column: "auto_execution_enabled_by",
  },
  { table: "meta_campaign_label_history", column: "state_hash" },
  { table: "meta_campaign_label_history", column: "business_ref_id" },
  {
    table: "meta_campaign_label_history",
    column: "provider_account_ref_id",
  },
  { table: "meta_entity_tombstones", column: "reason" },
  { table: "meta_creative_lineage_edges", column: "lineage_type" },
  {
    table: "meta_creative_lineage_edges",
    column: "observation_run_entity_type",
  },
  {
    table: "meta_creative_lineage_edges",
    column: "observation_run_completeness",
  },
  { table: "meta_creative_lineage_edges", column: "action_type" },
  { table: "meta_creative_lineage_edges", column: "action_status" },
  { table: "meta_creative_lineage_edges", column: "action_verified_at" },
  {
    table: "engine_v3_ad_account_calibration_batches",
    column: "provider_account_ref_id",
  },
  {
    table: "engine_v3_ad_account_calibration_batches",
    column: "generation_content_hash",
  },
  {
    table: "engine_v3_ad_account_calibration_daily",
    column: "action_readiness_json",
  },
  {
    table: "engine_v3_ad_decision_evaluations",
    column: "decision_entity_id",
  },
  { table: "engine_v3_ad_decision_evaluations", column: "ad_id" },
  {
    table: "engine_v3_ad_decision_snapshots_daily",
    column: "calibration_row_id",
  },
  {
    table: "engine_v3_ad_decision_snapshots_daily",
    column: "pre_authority_label",
  },
  {
    table: "engine_v3_ad_decision_snapshots_daily",
    column: "authority_blocker",
  },
  {
    table: "engine_v3_ad_decision_snapshots_daily",
    column: "idempotency_key",
  },
  { table: "meta_ads_action_log", column: "decision_episode_key" },
  { table: "meta_ads_action_log", column: "decision_snapshot_id" },
  { table: "meta_ads_action_log", column: "decision_evaluation_id" },
  { table: "meta_ads_action_log", column: "terminal_finalized_at" },
  {
    table: "meta_ads_action_mutation_attempt_events",
    column: "provider_account_ref_id",
  },
  {
    table: "meta_ads_action_mutation_attempt_events",
    column: "completion_outcome",
  },
  {
    table: "meta_ads_action_mutation_attempt_events",
    column: "lease_deadline",
  },
  {
    table: "meta_ads_action_mutation_attempt_events",
    column: "evidence_hash",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    column: "source_authority_kind",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    column: "provider_account_ref_id",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    column: "settlement_not_before",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    column: "evidence_hash",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    column: "provider_account_ref_id",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    column: "marker",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    column: "event_kind",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    column: "provider_response_successful",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    column: "verification_observed_at",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    column: "evidence_hash",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    column: "source_prepared_event_id",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    column: "resolution",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    column: "observation_count",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    column: "evidence_hash",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "attempt_ordinal",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "observation_count",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "scan_cycle_id",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "scan_segment_index",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "segment_start_after_cursor",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "segment_start_cursor_hash",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "segment_end_after_cursor",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "segment_end_cursor_hash",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "scan_cycle_complete",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "next_attempt_not_before",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    column: "evidence_hash",
  },
  {
    table: "engine_v3_ad_operator_action_receipts",
    column: "receipt_hash",
  },
  {
    table: "engine_v3_ad_operator_responses",
    column: "observation_status",
  },
  {
    table: "engine_v3_ad_decision_outcomes_daily",
    column: "source_manifest_hash",
  },
  {
    table: "engine_v3_ad_decision_outcomes_daily",
    column: "pre_authority_label",
  },
  {
    table: "engine_v3_ad_decision_outcomes_daily",
    column: "authority_blocker",
  },
  {
    table: "engine_v3_ad_decision_outcome_publications",
    column: "active_outcome_run_id",
  },
  {
    table: "meta_controlled_random_assignments",
    column: "randomization_proof_hash",
  },
  {
    table: "meta_controlled_control_estimates",
    column: "confidence_95_lower",
  },
];
const AUTHORITY_PROVENANCE_TABLES = [
  ["engine_v3_decision_snapshots_daily", "engine_v3_decision_snapshots"],
  ["engine_v3_decision_outcomes_daily", "engine_v3_decision_outcomes"],
  ["engine_v3_ad_decision_snapshots_daily", "engine_v3_ad_snapshots"],
  ["engine_v3_ad_decision_outcomes_daily", "engine_v3_ad_outcomes"],
] as const;

const D060_AUTHORITY_BLOCKERS = [
  "profile_hard_action_ineligible",
  "source_freshness",
  "campaign_context",
  "native_metrics_unavailable",
  "native_profile_unavailable",
] as const;
const D063_AUTHORITY_BLOCKERS = [
  ...D060_AUTHORITY_BLOCKERS,
  "recent_recovery_unverifiable",
] as const;

const REQUIRED_CONSTRAINTS: ReadonlyArray<{
  table: string;
  constraint: string;
  type: "c" | "f" | "u";
  deleteAction?: "r";
}> = [
  ...AUTHORITY_PROVENANCE_TABLES.flatMap(([table, prefix]) => [
    {
      table,
      constraint: `${prefix}_pre_authority_label_check`,
      type: "c" as const,
    },
    {
      table,
      constraint: `${prefix}_authority_blocker_check`,
      type: "c" as const,
    },
  ]),
  {
    table: "engine_v3_decision_evaluation_contexts",
    constraint: "engine_v3_eval_contexts_business_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_decision_evaluation_contexts",
    constraint: "engine_v3_eval_contexts_job_run_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_decision_evaluation_contexts",
    constraint: "engine_v3_eval_contexts_run_scope_hash_unique",
    type: "u",
  },
  {
    table: "engine_v3_decision_evaluation_contexts",
    constraint: "engine_v3_eval_contexts_lineage_unique",
    type: "u",
  },
  {
    table: "engine_v3_decision_evaluations",
    constraint: "engine_v3_decision_evaluations_business_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_decision_evaluations",
    constraint: "engine_v3_decision_evaluations_job_run_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_decision_evaluations",
    constraint: "engine_v3_decision_evaluations_context_lineage_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_decision_evaluations",
    constraint: "engine_v3_decision_evaluations_event_unique",
    type: "u",
  },
  {
    table: "engine_v3_decision_snapshots_daily",
    constraint: "engine_v3_decision_snapshots_daily_evaluation_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_decision_snapshots_daily",
    constraint: "engine_v3_decision_snapshots_daily_decision_hash_check",
    type: "c",
  },
  {
    table: "meta_entity_observation_runs",
    constraint: "meta_entity_observation_runs_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_entity_observation_runs",
    constraint: "meta_entity_observation_runs_binding_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_entity_observation_runs",
    constraint: "meta_entity_observation_runs_business_identity_check",
    type: "c",
  },
  {
    table: "meta_entity_observation_runs",
    constraint: "meta_entity_observation_runs_lineage_unique",
    type: "u",
  },
  {
    table: "meta_entity_observation_runs",
    constraint: "meta_entity_observation_runs_capture_lineage_unique",
    type: "u",
  },
  {
    table: "meta_entity_state_history",
    constraint: "meta_entity_state_history_run_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_entity_state_history",
    constraint: "meta_entity_state_history_entity_identity_check",
    type: "c",
  },
  {
    table: "meta_campaign_label_history",
    constraint: "meta_campaign_label_history_event_unique",
    type: "u",
  },
  {
    table: "meta_campaign_label_history",
    constraint: "meta_campaign_label_history_tenant_fields_check",
    type: "c",
  },
  {
    table: "meta_campaign_label_history",
    constraint: "meta_campaign_label_history_business_identity_check",
    type: "c",
  },
  {
    table: "meta_campaign_label_history",
    constraint: "meta_campaign_label_history_business_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_campaign_label_history",
    constraint: "meta_campaign_label_history_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_campaign_label_history",
    constraint: "meta_campaign_label_history_binding_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_entity_tombstones",
    constraint: "meta_entity_tombstones_run_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_entity_tombstones",
    constraint: "meta_entity_tombstones_not_found_check",
    type: "c",
  },
  {
    table: "meta_entity_tombstones",
    constraint: "meta_entity_tombstones_point_evidence_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_binding_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_business_identity_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_observation_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_action_business_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_observation_fields_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_action_fields_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_action_time_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_identity_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_evidence_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_account_authority_check",
    type: "c",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_source_state_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_creative_lineage_edges",
    constraint: "meta_creative_lineage_target_state_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_ad_account_calibration_daily",
    constraint: "engine_v3_ad_calibration_daily_batch_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_ad_decision_snapshots_daily",
    constraint: "engine_v3_ad_snapshots_authority_check",
    type: "c",
  },
  {
    table: "engine_v3_ad_decision_snapshots_daily",
    constraint: "engine_v3_ad_snapshots_evaluation_lineage_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_action_log",
    constraint: "meta_ads_action_log_decision_origin_typed_check",
    type: "c",
  },
  {
    table: "engine_v3_ad_operator_action_receipts",
    constraint: "engine_v3_ad_action_receipt_action_log_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_ad_operator_responses",
    constraint: "engine_v3_ad_response_source_completion_check",
    type: "c",
  },
  {
    table: "engine_v3_ad_decision_outcomes_daily",
    constraint: "engine_v3_ad_outcomes_snapshot_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "engine_v3_ad_decision_outcomes_daily",
    constraint: "engine_v3_ad_outcomes_measurement_check",
    type: "c",
  },
  {
    table: "meta_controlled_random_assignments",
    constraint: "meta_controlled_random_assignments_snapshot_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_controlled_control_estimates",
    constraint: "meta_controlled_control_estimates_native_outcome_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_action_mutation_attempt_events",
    constraint: "meta_ads_action_mutation_attempt_source_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_action_mutation_attempt_events",
    constraint: "meta_ads_action_mutation_attempt_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_action_mutation_attempt_events",
    constraint: "meta_ads_action_mutation_attempt_source_event_unique",
    type: "u",
  },
  {
    table: "meta_ads_action_mutation_attempt_events",
    constraint: "meta_ads_action_mutation_attempt_shape_check",
    type: "c",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    constraint: "meta_ads_action_reconciliation_source_action_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    constraint: "meta_ads_action_reconciliation_attempt_event_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    constraint: "meta_ads_action_reconciliation_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    constraint: "meta_ads_action_reconciliation_source_unique",
    type: "u",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    constraint: "meta_ads_action_reconciliation_resolution_geometry_check",
    type: "c",
  },
  {
    table: "meta_ads_action_reconciliation_events",
    constraint: "meta_ads_action_reconciliation_time_check",
    type: "c",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    constraint: "meta_ads_duplicate_attempt_source_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    constraint: "meta_ads_duplicate_attempt_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    constraint: "meta_ads_duplicate_attempt_source_event_unique",
    type: "u",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    constraint: "meta_ads_duplicate_attempt_id_event_unique",
    type: "u",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    constraint: "meta_ads_duplicate_attempt_shape_check",
    type: "c",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    constraint: "meta_ads_duplicate_reconciliation_source_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    constraint: "meta_ads_duplicate_reconciliation_attempt_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    constraint: "meta_ads_duplicate_reconciliation_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    constraint: "meta_ads_duplicate_reconciliation_source_unique",
    type: "u",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    constraint: "meta_ads_duplicate_reconciliation_shape_check",
    type: "c",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    constraint: "meta_ads_duplicate_observation_source_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    constraint: "meta_ads_duplicate_observation_attempt_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    constraint: "meta_ads_duplicate_observation_account_fk",
    type: "f",
    deleteAction: "r",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    constraint: "meta_ads_duplicate_observation_ordinal_unique",
    type: "u",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    constraint: "meta_ads_duplicate_observation_shape_check",
    type: "c",
  },
];
const REQUIRED_INDEXES = [
  "idx_engine_v3_eval_contexts_business_scope",
  "idx_engine_v3_eval_contexts_job_run",
  "idx_engine_v3_evaluations_business_scope_creative",
  "idx_engine_v3_evaluations_creative_timeline",
  "idx_engine_v3_evaluations_context",
  "idx_engine_v3_decisions_evaluation_unique",
  "idx_engine_v3_decisions_decision_hash",
  "idx_meta_entity_observation_runs_asof",
  "idx_provider_accounts_id_external",
  "idx_business_provider_accounts_binding",
  "idx_meta_entity_state_history_asof",
  "idx_meta_entity_state_history_run_ad_identity",
  "idx_meta_campaign_label_history_asof",
  "idx_meta_campaign_label_history_refs",
  "idx_meta_entity_tombstones_asof",
  "idx_meta_ads_action_log_id_business",
  "idx_meta_ads_action_log_verified_lineage",
  "idx_meta_creative_lineage_source_asof",
  "idx_meta_creative_lineage_target_asof",
  "idx_engine_v3_ad_calibration_batch_lookup",
  "idx_engine_v3_ad_account_calibration_lookup",
  "idx_engine_v3_ad_evaluations_entity_timeline",
  "engine_v3_ad_snapshots_idempotency_key_unique",
  "engine_v3_ad_events_change_unique",
  "meta_ads_action_log_decision_idempotency_unique",
  "engine_v3_ad_response_episode_timeline_idx",
  "engine_v3_ad_action_receipts_timeline_idx",
  "engine_v3_ad_responses_timeline_idx",
  "idx_engine_v3_ad_outcomes_native_timeline",
  "idx_meta_ads_action_log_controlled_verified_receipt_unique",
  "idx_meta_ads_action_mutation_attempt_business_ad",
  "idx_meta_ads_action_reconciliation_business_ad",
  "idx_meta_ads_duplicate_attempt_business",
  "idx_meta_ads_duplicate_reconciliation_business",
  "idx_meta_ads_duplicate_observation_schedule",
  "idx_meta_ads_duplicate_open_claim_unique",
] as const;

const REQUIRED_TRIGGERS = [
  "engine_v3_native_ad_calibration_batch_immutable_trigger",
  "engine_v3_native_ad_calibration_cell_immutable_trigger",
  "engine_v3_ad_operator_action_receipts_immutable",
  "trg_engine_v3_ad_outcomes_immutable",
  "trg_meta_controlled_seed_reveal_guard",
  "trg_meta_ads_action_log_controlled_verified_immutable",
  "trg_meta_ads_action_mutation_attempt_validate",
  "trg_meta_ads_action_mutation_attempt_immutable",
  "trg_meta_ads_action_reconciliation_validate",
  "trg_meta_ads_action_reconciliation_immutable",
  "trg_meta_ads_duplicate_attempt_validate",
  "trg_meta_ads_duplicate_attempt_immutable",
  "trg_meta_ads_duplicate_reconciliation_validate",
  "trg_meta_ads_duplicate_reconciliation_immutable",
  "trg_meta_ads_duplicate_observation_validate",
  "trg_meta_ads_duplicate_observation_immutable",
  "trg_manual_meta_ads_duplicate_terminal_validate",
  "trg_manual_meta_ads_duplicate_insert_contract",
  "trg_manual_meta_ads_duplicate_preparation_required",
  "trg_manual_meta_ads_action_terminal_validate",
] as const;

const REQUIRED_DUPLICATE_TRIGGER_BINDINGS = [
  {
    table: "meta_ads_duplicate_action_attempt_events",
    trigger: "trg_meta_ads_duplicate_attempt_validate",
  },
  {
    table: "meta_ads_duplicate_action_attempt_events",
    trigger: "trg_meta_ads_duplicate_attempt_immutable",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    trigger: "trg_meta_ads_duplicate_reconciliation_validate",
  },
  {
    table: "meta_ads_duplicate_action_reconciliation_events",
    trigger: "trg_meta_ads_duplicate_reconciliation_immutable",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    trigger: "trg_meta_ads_duplicate_observation_validate",
  },
  {
    table: "meta_ads_duplicate_reconciliation_observations",
    trigger: "trg_meta_ads_duplicate_observation_immutable",
  },
  {
    table: "meta_ads_action_log",
    trigger: "trg_manual_meta_ads_duplicate_terminal_validate",
  },
  {
    table: "meta_ads_action_log",
    trigger: "trg_manual_meta_ads_duplicate_insert_contract",
  },
  {
    table: "meta_ads_action_log",
    trigger: "trg_manual_meta_ads_duplicate_preparation_required",
  },
] as const;

const DUPLICATE_JOURNAL_TABLES = [
  "meta_ads_duplicate_action_attempt_events",
  "meta_ads_duplicate_action_reconciliation_events",
  "meta_ads_duplicate_reconciliation_observations",
] as const;

function log(message: string) {
  console.log(`[migrations-from-zero] ${message}`);
}

function resolvePgBinDir(): string {
  const required = ["initdb", "pg_ctl", "postgres", "createdb"];
  const linuxVersionedDirs = fs.existsSync("/usr/lib/postgresql")
    ? fs
        .readdirSync("/usr/lib/postgresql", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .map((version) => path.join("/usr/lib/postgresql", version, "bin"))
    : [];
  const candidates = Array.from(new Set([
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    ...linuxVersionedDirs,
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter((dir): dir is string => Boolean(dir))));

  for (const dir of candidates) {
    if (required.every((binary) => fs.existsSync(path.join(dir, binary)))) {
      return dir;
    }
  }
  throw new Error(
    `PostgreSQL binaries (${required.join(", ")}) not found in any of: ${candidates.join(", ")}. ` +
      "Install PostgreSQL or set EPHEMERAL_PG_BIN_DIR.",
  );
}

function assertSafePort(port: number) {
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(
      `Refusing to use port ${port}: 15432 is the live prod tunnel and 5432 is the local volume Postgres.`,
    );
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid ephemeral Postgres port: ${port}`);
  }
}

async function findFreeSafePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === "object") {
            resolve(address.port);
          } else {
            reject(new Error("Could not determine a free port."));
          }
        });
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) {
      assertSafePort(port);
      return port;
    }
  }
  throw new Error("Could not find a safe free port after 10 attempts.");
}

// Without a valid LC_ALL, macOS CoreFoundation locale init makes the
// postmaster multithreaded during startup and it refuses to boot
// ("postmaster became multithreaded during startup"). The PostgreSQL binaries
// never need the integration encryption key. Build this environment at call
// time and remove the key explicitly so neither a caller's production value nor
// this harness's throwaway value is inherited by the database server process.
function pgToolEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  delete env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  return env;
}

function runSync(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: pgToolEnv(),
  });
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited with code ${result.status}.` +
        `${result.stdout?.trim() ? `\nstdout: ${result.stdout.trim()}` : ""}` +
        `${result.stderr?.trim() ? `\nstderr: ${result.stderr.trim()}` : ""}`,
    );
  }
  return result;
}

async function runMigrationsChild(
  repoRoot: string,
  databaseUrl: string,
  runLabel: string,
): Promise<void> {
  await runChildScript(
    repoRoot,
    databaseUrl,
    path.join("scripts", "run-migrations.ts"),
    `deploy migrations (${runLabel})`,
  );
}

async function runChildScript(
  repoRoot: string,
  databaseUrl: string,
  scriptPath: string,
  runLabel: string,
): Promise<void> {
  log(`running ${runLabel}...`);
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      // Pre-set so scripts/run-migrations.ts's loadEnvConfig (.env.local →
      // prod tunnel) can never override them: @next/env skips keys that
      // already exist in process.env.
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      PGHOST: "127.0.0.1",
      PGDATABASE: EPHEMERAL_DB_NAME,
      PGUSER: EPHEMERAL_DB_USER,
      ENABLE_RUNTIME_MIGRATIONS: "1",
      ADSECUTE_EPHEMERAL_DB_SEAM: "1",
    },
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`${runLabel} exited with code ${exitCode}.`);
  }

  log(`${runLabel} exited clean.`);
}

/**
 * The same thing, for a seam-guarded vitest file.
 *
 * A few claims are about SQL the application ships but no seam child owns — the
 * Meta History title expression is one: it is extracted from
 * `META_HISTORY_READ_SQL` at run time and executed by PostgreSQL over a VALUES
 * list, so the test runs whatever the shipped expression currently says. That
 * needs a connection and no schema, which makes a vitest file the right shape
 * and `runChildScript` the wrong spawner — it invokes `node --import tsx`
 * directly. The environment is identical, `ADSECUTE_EPHEMERAL_DB_SEAM=1`
 * included, because outside a seam `DATABASE_URL` in this repository points at
 * PRODUCTION and the file refuses to run without it.
 */
async function runChildVitest(
  repoRoot: string,
  databaseUrl: string,
  testPath: string,
  runLabel: string,
  expectedPassingTests: number,
): Promise<void> {
  log(`running ${runLabel}...`);
  /*
    A SKIPPED child is not a pass, and the exit code cannot tell them apart.

    Every file registered here gates itself on `ADSECUTE_EPHEMERAL_DB_SEAM`, so
    a future edit that renames the flag, or a `describe.skipIf` whose predicate
    silently stops matching, produces a child that exits 0 having executed no
    assertions at all — and this runner announced "exited clean". That is the
    precise failure `scripts/verify-database-seams.sh` warns about in its own
    header: "a skipped database test reads exactly like a pass."

    So the JSON report is read back and the PASSING count must equal what the
    caller declared, the same way `scripts/ephemeral-postgres-breakdown-dimension-seam.ts`
    has always done it. An exit code is a floor, not evidence.
  */
  const reportPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "d077-child-vitest-")),
    "report.json",
  );
  const child = spawn(
    process.execPath,
    /*
      The package's own JS entry, not `node_modules/.bin/vitest`.

      That path is a POSIX shell wrapper; handing it to `process.execPath`
      makes node parse `basedir=$(dirname ...)` as JavaScript and die with
      "SyntaxError: missing ) after argument list" before the test is reached.
    */
    [
      path.join("node_modules", "vitest", "vitest.mjs"),
      "run",
      testPath,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATABASE_URL_UNPOOLED: databaseUrl,
        PGHOST: "127.0.0.1",
        PGDATABASE: EPHEMERAL_DB_NAME,
        PGUSER: EPHEMERAL_DB_USER,
        ENABLE_RUNTIME_MIGRATIONS: "1",
        ADSECUTE_EPHEMERAL_DB_SEAM: "1",
      },
    },
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`${runLabel} exited with code ${exitCode}.`);
  }

  if (!fs.existsSync(reportPath)) {
    throw new Error(`${runLabel}: vitest wrote no JSON report.`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    numTotalTests?: number;
    numPassedTests?: number;
    numPendingTests?: number;
    numFailedTests?: number;
  };
  log(
    `${runLabel} report: total=${report.numTotalTests} ` +
      `passed=${report.numPassedTests} skipped=${report.numPendingTests} ` +
      `failed=${report.numFailedTests}`,
  );
  if ((report.numFailedTests ?? 0) !== 0) {
    throw new Error(`${runLabel}: ${report.numFailedTests} test(s) failed.`);
  }
  if ((report.numPendingTests ?? 0) !== 0) {
    throw new Error(
      `${runLabel}: ${report.numPendingTests} test(s) SKIPPED — a skipped database test is not a pass.`,
    );
  }
  if ((report.numPassedTests ?? 0) !== expectedPassingTests) {
    throw new Error(
      `${runLabel}: expected ${expectedPassingTests} passing tests, saw ${report.numPassedTests}.`,
    );
  }
  log(`${runLabel} exited clean.`);
}

function dbAdapter(client: Client): DbClient {
  let queue = Promise.resolve();
  const query = async <TRow extends Record<string, unknown>>(
    queryText: string,
    params: unknown[] = [],
  ) => {
    const operation = queue.then(async () => {
      const result = await client.query<TRow>(queryText, params);
      return result.rows;
    });
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  return Object.assign(
    (() => {
      throw new Error(
        "Migration capability checks use parameterized query only.",
      );
    }) as unknown as DbClient,
    { query },
  );
}

async function assertNativeSchemaCapabilities(
  client: Client,
  failures: string[],
) {
  const db = dbAdapter(client);
  const calibration = await inspectNativeAdCalibrationSchemaCapability(db);
  const decisions = await inspectEvaluationStoreSchemaCapability(db);
  const operatorResponse = await inspectAdOperatorResponseSchemaCapability(db);
  const outcomes = await inspectAdDecisionOutcomeSchemaCapability(db);
  const controlledQuery = async <TRow extends Record<string, unknown>>(
    queryText: string,
    params: readonly unknown[] = [],
  ) => {
    const result = await client.query<TRow>(queryText, [...params]);
    return result.rows;
  };
  const controlled = await createControlledExperimentRegistryStore({
    query: controlledQuery,
    transaction: async (operation) => operation(controlledQuery),
  }).inspectCapabilities();

  const checks = [
    {
      name: "native calibration",
      ready: calibration.ready,
      issues: [...calibration.missing, ...calibration.mismatched],
    },
    { name: "native decisions", ...decisions, issues: decisions.missing },
    {
      name: "native operator response",
      ...operatorResponse,
      issues: operatorResponse.missing,
    },
    { name: "native outcomes", ...outcomes, issues: outcomes.missing },
    {
      name: "controlled registry",
      ready: controlled.ready,
      issues: controlled.issues,
    },
  ];
  for (const check of checks) {
    if (check.ready) {
      log(`capability ok: ${check.name}`);
    } else {
      failures.push(
        `capability not ready: ${check.name}: ${check.issues.join(", ")}`,
      );
    }
  }
}


/**
 * The proposal lineage widening, and the reason it needs watching.
 *
 * `launch_intent_id` carries a foreign key to `meta_launch_intents`, and the
 * batch it lives in swallows its own errors. Run before that table exists, the
 * statement fails, the error is discarded, and the release ships a schema where
 * every launch proposal is refused by a constraint whose column is missing —
 * silently, and only at runtime. So the column is asserted here, together with
 * the two constraint vocabularies it travels with.
 */
async function assertProposalLineageWidening(
  client: Client,
  failures: string[],
): Promise<void> {
  const { rows: columnRows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'meta_automation_proposals'
         AND column_name = 'launch_intent_id'
     ) AS exists`,
  );
  if (columnRows[0]?.exists) {
    log("proposal launch_intent_id column present");
  } else {
    failures.push(
      "meta_automation_proposals.launch_intent_id is missing — its FK target probably did not exist when the ALTER ran",
    );
  }

  const { rows: fkRows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class r ON r.oid = c.confrelid
      WHERE t.relname = 'meta_automation_proposals'
        AND r.relname = 'meta_launch_intents'
        AND c.contype = 'f'`,
  );
  if (Number(fkRows[0]?.count ?? "0") === 1) {
    log("proposal launch_intent_id references meta_launch_intents");
  } else {
    failures.push("launch_intent_id does not reference meta_launch_intents");
  }

  const { rows: checkRows } = await client.query<{
    conname: string;
    definition: string;
  }>(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'meta_automation_proposals' AND c.contype = 'c'`,
  );
  const byName = new Map(checkRows.map((row) => [row.conname, row.definition]));
  const origin = byName.get("meta_automation_proposals_origin_check") ?? "";
  if (origin.includes("operator_action")) {
    log("proposal origin accepts operator_action");
  } else {
    failures.push("origin check does not accept operator_action");
  }
  const action = byName.get("meta_automation_proposals_action_budget_check") ?? "";
  if (action.includes("launch")) {
    log("proposal action accepts launch");
  } else {
    failures.push("proposed_action check does not accept launch");
  }
  // The arm that already existed must still hold: widening must not relax it.
  const lineage = byName.get("meta_automation_proposals_origin_lineage") ?? "";
  if (lineage.includes("engine_decision") && lineage.includes("operator_action")) {
    log("proposal lineage keeps the engine arm and adds the operator arm");
  } else {
    failures.push("origin lineage lost an arm during the widening");
  }
  if (byName.has("meta_automation_proposals_launch_lineage")) {
    log("a launch proposal must name its launch intent");
  } else {
    failures.push("launch rows are not required to carry a launch intent");
  }
}

/**
 * The retained campaign-role authority the budget path reads.
 *
 * Its DDL used to live only in an audit module, so production had no such
 * table: the reader threw, the caller turned that into `unknown`, and no budget
 * proposal could be produced. Asserted here so it cannot quietly go missing
 * again.
 */
async function assertRoleAuthorityRetention(
  client: Client,
  failures: string[],
): Promise<void> {
  const required = [
    "contract", "business_id", "provider_account_id", "campaign_id",
    "as_of_date", "inferred_kind", "kind_source", "resolver_version",
    "confidence_class", "evidence_hash", "input_hash", "effective_at",
    "recorded_at", "provenance",
  ];
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'engine_v3_campaign_role_authority'`,
  );
  const present = new Set(rows.map((row) => row.column_name));
  const missing = required.filter((column) => !present.has(column));
  if (rows.length === 0) {
    failures.push("engine_v3_campaign_role_authority does not exist");
  } else if (missing.length > 0) {
    failures.push(
      `engine_v3_campaign_role_authority is missing: ${missing.join(", ")}`,
    );
  } else {
    log("campaign-role authority retention table present with every read column");
  }
}

/**
 * The other table the budget path reads.
 *
 * `engine_v3_account_profile_output` carries the day's commercial verdict per
 * canonical action. Its DDL lived only in the D086 pack
 * (`lib/meta/budget-readiness-retention.ts`) and not in `lib/migrations.ts`,
 * so a database built by the migration runner did not have it and the loader's
 * read failed into `composition_sources_unavailable` — no budget candidate
 * could be admitted at all, for a reason no surface showed. Both the migration
 * and the producer exist now.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DOES NOT. It asserts what the migration
 * runner builds on a freshly migrated cluster, which is the whole scope of
 * this seam. It says nothing about the state of any deployed database: this
 * process reaches an ephemeral cluster only, and a claim about production
 * would be a claim with no evidence behind it.
 */
async function assertAccountProfileOutputRetention(
  client: Client,
  failures: string[],
): Promise<void> {
  const required = [...D086_REQUIRED_PROFILE_COLUMNS];
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'engine_v3_account_profile_output'`,
  );
  const present = new Set(rows.map((row) => row.column_name));
  const missing = required.filter((column) => !present.has(column));
  if (rows.length === 0) {
    failures.push("engine_v3_account_profile_output does not exist");
  } else if (missing.length > 0) {
    failures.push(
      `engine_v3_account_profile_output is missing: ${missing.join(", ")}`,
    );
  } else {
    log("account profile output retention table present with every read column");
  }
}

/**
 * The activation approval, and the thing it must never become.
 *
 * `requested_status = 'PAUSED'` is what makes a launch intent unable to turn
 * on what it created. If that CHECK ever loosened, creating and activating
 * would collapse into one authorization and the approval column would be
 * decoration. Both are asserted together for that reason.
 */
async function assertActivationApproval(
  client: Client,
  failures: string[],
): Promise<void> {
  const { rows } = await client.query<{ is_nullable: string; data_type: string }>(
    `SELECT is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'meta_launch_intents'
        AND column_name = 'activation_approval_json'`,
  );
  const column = rows[0];
  if (!column) {
    failures.push("meta_launch_intents.activation_approval_json is missing");
  } else if (column.is_nullable !== "YES") {
    // NULL means "operator only", which every existing row must keep.
    failures.push("activation_approval_json is NOT NULL, so old rows cannot mean 'operator only'");
  } else if (column.data_type !== "jsonb") {
    failures.push(`activation_approval_json is ${column.data_type}, not jsonb`);
  } else {
    log("launch intents carry a nullable activation approval");
  }

  /*
    The receipt of the activation that ran, which is a different fact.

    An approval authorizes; a receipt records. Kept in separate columns
    deliberately: a consumed approval is still the approval, and a receipt
    saying the ad set blocked is not a revocation of anything.
  */
  const { rows: receiptRows } = await client.query<{
    is_nullable: string; data_type: string;
  }>(
    `SELECT is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'meta_launch_intents'
        AND column_name = 'activation_receipt_json'`,
  );
  const receipt = receiptRows[0];
  if (!receipt) {
    failures.push("meta_launch_intents.activation_receipt_json is missing");
  } else if (receipt.is_nullable !== "YES") {
    // NULL is "no activation has run", which every existing row is.
    failures.push("activation_receipt_json is NOT NULL, so old rows claim an activation");
  } else if (receipt.data_type !== "jsonb") {
    failures.push(`activation_receipt_json is ${receipt.data_type}, not jsonb`);
  } else {
    log("launch intents carry a nullable activation receipt");
  }

  const { rows: checks } = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'meta_launch_intents' AND c.contype = 'c'`,
  );
  const all = checks.map((row) => row.definition).join(" ");
  if (all.includes("requested_status") && all.includes("'PAUSED'")) {
    log("a launch intent still may only create something paused");
  } else {
    failures.push("the PAUSED-only creation rule is gone; creating and activating have merged");
  }
}

/**
 * The per-slot completion record the second daily snapshot depends on.
 *
 * Its primary key is the whole point: without the slot in the key, the 15:00
 * catch-up would collide with the 03:00 run's row and be reported as already
 * done.
 */
async function assertStructureSnapshotRuns(
  client: Client,
  failures: string[],
): Promise<void> {
  const { rows } = await client.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
      WHERE t.relname = 'meta_structure_snapshot_runs' AND i.indisprimary`,
  );
  const key = new Set(rows.map((row) => row.attname));
  const required = ["business_id", "provider_account_id", "as_of_date", "slot"];
  const missing = required.filter((column) => !key.has(column));
  if (rows.length === 0) {
    failures.push("meta_structure_snapshot_runs does not exist");
  } else if (missing.length > 0) {
    failures.push(
      `the snapshot run key is missing ${missing.join(", ")}, so slots would collide`,
    );
  } else {
    log("structure snapshot runs are keyed per business, account, day and slot");
  }

  /*
    `source_max_date` must be NULLABLE, and that is not a formality.

    It records the newest source day a run actually READ. A run that could not
    read one has no honest value to write, and a NOT NULL column would force it
    to invent one — which is exactly the defect this column was added to end:
    the requested snapshot date was being stored as though it were an
    observation, so a slot whose sources had not moved looked freshly covered.
  */
  const { rows: sourceColumn } = await client.query<{
    is_nullable: string;
    data_type: string;
  }>(
    `SELECT is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'meta_structure_snapshot_runs'
        AND column_name = 'source_max_date'`,
  );
  const source = sourceColumn[0];
  if (!source) {
    failures.push("meta_structure_snapshot_runs.source_max_date is missing");
  } else if (source.is_nullable !== "YES") {
    failures.push(
      "source_max_date is NOT NULL, so a run that read nothing would have to invent a date",
    );
  } else if (source.data_type !== "date") {
    failures.push(`source_max_date is ${source.data_type}, not date`);
  } else {
    log("a snapshot run may record no source date rather than inventing one");
  }
}

async function assertSchema(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const failures: string[] = [];

    for (const table of REQUIRED_TABLES) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${table}`],
      );
      if (rows[0]?.exists) {
        log(`table ok: ${table}`);
      } else {
        failures.push(`missing table: ${table}`);
      }
    }

    for (const { table, column } of REQUIRED_COLUMNS) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = $1
             AND column_name = $2
         ) AS exists`,
        [table, column],
      );
      if (rows[0]?.exists) {
        log(`column ok: ${table}.${column}`);
      } else {
        failures.push(`missing column: ${table}.${column}`);
      }
    }

    for (const {
      table,
      constraint,
      type,
      deleteAction,
    } of REQUIRED_CONSTRAINTS) {
      const { rows } = await client.query<{
        constraint_type: string;
        delete_action: string;
      }>(
        `SELECT c.contype::text AS constraint_type,
                c.confdeltype::text AS delete_action
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = $1
           AND c.conname = $2`,
        [table, constraint],
      );
      const actual = rows[0];
      if (
        actual?.constraint_type === type &&
        (deleteAction == null || actual.delete_action === deleteAction)
      ) {
        log(`constraint ok: ${table}.${constraint}`);
      } else {
        failures.push(
          `invalid constraint: ${table}.${constraint} ` +
            `(expected type=${type}${deleteAction ? ` delete=${deleteAction}` : ""}, ` +
            `actual type=${actual?.constraint_type ?? "missing"} delete=${actual?.delete_action ?? "missing"})`,
        );
      }
    }

    for (const index of REQUIRED_INDEXES) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${index}`],
      );
      if (rows[0]?.exists) {
        log(`index ok: ${index}`);
      } else {
        failures.push(`missing index: ${index}`);
      }
    }

    for (const trigger of REQUIRED_TRIGGERS) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
           WHERE namespace_row.nspname = 'public'
             AND trigger_row.tgname = $1
             AND NOT trigger_row.tgisinternal
         ) AS exists`,
        [trigger],
      );
      if (rows[0]?.exists) {
        log(`trigger ok: ${trigger}`);
      } else {
        failures.push(`missing trigger: ${trigger}`);
      }
    }

    for (const { table, trigger } of REQUIRED_DUPLICATE_TRIGGER_BINDINGS) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace namespace_row
             ON namespace_row.oid = relation.relnamespace
           WHERE namespace_row.nspname = 'public'
             AND relation.relname = $1
             AND trigger_row.tgname = $2
             AND NOT trigger_row.tgisinternal
         ) AS exists`,
        [table, trigger],
      );
      if (rows[0]?.exists) {
        log(`trigger binding ok: ${table}.${trigger}`);
      } else {
        failures.push(`missing trigger binding: ${table}.${trigger}`);
      }
    }

    const { rows: preparationTriggerRows } = await client.query<{
      is_deferrable: boolean;
      is_initially_deferred: boolean;
    }>(
      `SELECT trigger_row.tgdeferrable AS is_deferrable,
              trigger_row.tginitdeferred AS is_initially_deferred
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace_row
         ON namespace_row.oid = relation.relnamespace
       WHERE namespace_row.nspname = 'public'
         AND relation.relname = 'meta_ads_action_log'
         AND trigger_row.tgname =
           'trg_manual_meta_ads_duplicate_preparation_required'
         AND NOT trigger_row.tgisinternal`,
    );
    if (
      preparationTriggerRows[0]?.is_deferrable === true &&
      preparationTriggerRows[0]?.is_initially_deferred === true
    ) {
      log("duplicate preparation constraint trigger deferral ok");
    } else {
      failures.push(
        "duplicate preparation constraint trigger is not initially deferred",
      );
    }

    const { rows: duplicateClaimIndexRows } = await client.query<{
      is_unique: boolean;
      index_definition: string;
      predicate: string | null;
    }>(
      `SELECT index_row.indisunique AS is_unique,
              pg_get_indexdef(index_row.indexrelid) AS index_definition,
              pg_get_expr(
                index_row.indpred,
                index_row.indrelid
              ) AS predicate
       FROM pg_index index_row
       JOIN pg_class index_relation
         ON index_relation.oid = index_row.indexrelid
       JOIN pg_namespace namespace_row
         ON namespace_row.oid = index_relation.relnamespace
       WHERE namespace_row.nspname = 'public'
         AND index_relation.relname =
           'idx_meta_ads_duplicate_open_claim_unique'`,
    );
    const duplicateClaimIndex = duplicateClaimIndexRows[0];
    const duplicateClaimDefinition =
      duplicateClaimIndex?.index_definition.toLowerCase() ?? "";
    const duplicateClaimPredicate =
      duplicateClaimIndex?.predicate?.toLowerCase() ?? "";
    const duplicateClaimIdentityFragments = [
      "business_id",
      "provider_account_ref_id",
      "provider_account_id",
      "ad_id",
      "targetadsetid",
    ];
    const duplicateClaimPredicateFragments = [
      "action",
      "duplicate",
      "source",
      "manual_operator_v1",
      "status",
      "pending",
      "silent_failure",
      "dry_run",
      "duplicate_attempt_contract_version",
      "duplicate_attempt_required",
    ];
    if (
      duplicateClaimIndex?.is_unique === true &&
      duplicateClaimIdentityFragments.every((fragment) =>
        duplicateClaimDefinition.includes(fragment),
      ) &&
      duplicateClaimPredicateFragments.every((fragment) =>
        duplicateClaimPredicate.includes(fragment),
      )
    ) {
      log("duplicate open-claim unique-index contract ok");
    } else {
      failures.push(
        "invalid duplicate open-claim unique-index columns or predicate",
      );
    }

    await assertNativeSchemaCapabilities(client, failures);
    await assertProposalLineageWidening(client, failures);
    await assertRoleAuthorityRetention(client, failures);
    await assertAccountProfileOutputRetention(client, failures);
    await assertActivationApproval(client, failures);
    await assertStructureSnapshotRuns(client, failures);

    const { rows: tableRows } = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tables = tableRows.map((row) => row.table_name);
    log(`public schema contains ${tables.length} base tables.`);

    if (failures.length > 0) {
      throw new Error(`Schema assertions failed:\n- ${failures.join("\n- ")}`);
    }
    return tables;
  } finally {
    await client.end();
  }
}

async function readDuplicateJournalTableOids(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      table_name: string;
      table_oid: string;
    }>(
      `SELECT relation.relname AS table_name,
              relation.oid::text AS table_oid
       FROM pg_class relation
       JOIN pg_namespace namespace_row
         ON namespace_row.oid = relation.relnamespace
       WHERE namespace_row.nspname = 'public'
         AND relation.relkind = 'r'
         AND relation.relname = ANY($1::text[])
       ORDER BY relation.relname`,
      [[...DUPLICATE_JOURNAL_TABLES]],
    );
    if (rows.length !== DUPLICATE_JOURNAL_TABLES.length) {
      throw new Error(
        "Duplicate journal OID snapshot is incomplete after migration.",
      );
    }
    return new Map(rows.map((row) => [row.table_name, row.table_oid]));
  } finally {
    await client.end();
  }
}

function assertDuplicateJournalTableOids(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
  label: string,
) {
  for (const table of DUPLICATE_JOURNAL_TABLES) {
    if (actual.get(table) !== expected.get(table)) {
      throw new Error(
        `${label}: ${table} OID changed across migration reruns; ` +
          "the append-only journal table was recreated.",
      );
    }
  }
  log(`${label}: duplicate journal table OIDs preserved.`);
}

type TargetHistoryBackfillCases = {
  missingHistoryBusinessId: string;
  existingHistoryBusinessId: string;
};

const PRIOR_NATIVE_OPERATOR_EPOCH = NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION;

async function seedPriorEpochOperatorConstraints(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      ALTER TABLE meta_ads_action_log
        DROP CONSTRAINT meta_ads_action_log_decision_origin_typed_check;
      ALTER TABLE meta_ads_action_log
        ADD CONSTRAINT meta_ads_action_log_decision_origin_typed_check
        CHECK (
          source <> 'decision_origin' OR
          decision_engine_version = '${PRIOR_NATIVE_OPERATOR_EPOCH}'
        );
      ALTER TABLE engine_v3_ad_recommendation_episodes
        DROP CONSTRAINT engine_v3_ad_response_episode_native_epoch_check;
      ALTER TABLE engine_v3_ad_recommendation_episodes
        ADD CONSTRAINT engine_v3_ad_response_episode_native_epoch_check
        CHECK (engine_version = '${PRIOR_NATIVE_OPERATOR_EPOCH}');
      ALTER TABLE engine_v3_ad_operator_action_receipts
        DROP CONSTRAINT engine_v3_ad_action_receipt_source_epoch_check;
      ALTER TABLE engine_v3_ad_operator_action_receipts
        ADD CONSTRAINT engine_v3_ad_operator_action_receipts_source_engine_version_check
        CHECK (source_engine_version = '${PRIOR_NATIVE_OPERATOR_EPOCH}');
    `);
    log("prior-epoch native operator constraints seeded.");
  } finally {
    await client.end();
  }
}

async function assertNativeOperatorEpochCompatibility(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      oid: string;
      table_name: string;
      constraint_name: string;
      definition: string;
    }>(`
      SELECT constraint_row.oid::text AS oid,
        relation.relname AS table_name,
        constraint_row.conname AS constraint_name,
        pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      WHERE (relation.relname, constraint_row.conname) IN (
        ('meta_ads_action_log', 'meta_ads_action_log_decision_origin_typed_check'),
        ('engine_v3_ad_recommendation_episodes', 'engine_v3_ad_response_episode_native_epoch_check'),
        ('engine_v3_ad_operator_action_receipts', 'engine_v3_ad_action_receipt_source_epoch_check')
      )
    `);
    if (rows.length !== 3) {
      throw new Error(
        "Native operator epoch compatibility constraints are incomplete.",
      );
    }
    for (const row of rows) {
      const definition = row.definition.toLowerCase();
      if (
        !definition.includes("length") ||
        !definition.includes("btrim") ||
        !definition.includes(PRIOR_NATIVE_OPERATOR_EPOCH.toLowerCase())
      ) {
        throw new Error(
          `Native operator epoch constraint was not generalized: ${row.table_name}.${row.constraint_name}`,
        );
      }
      if (
        row.table_name === "meta_ads_action_log" &&
        !definition
          .replaceAll(" ", "")
          .includes("decision_engine_versionisnotnull")
      ) {
        throw new Error(
          "Decision-origin action constraint permits a null engine version.",
        );
      }
    }

    await client.query("BEGIN");
    for (const [probe, table, column] of [
      [
        "native_episode_epoch_probe",
        "engine_v3_ad_recommendation_episodes",
        "engine_version",
      ],
      [
        "native_receipt_epoch_probe",
        "engine_v3_ad_operator_action_receipts",
        "source_engine_version",
      ],
    ] as const) {
      await client.query(
        `CREATE TEMP TABLE ${probe} (LIKE ${table} INCLUDING CONSTRAINTS) ON COMMIT DROP`,
      );
      const required = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema LIKE 'pg_temp_%' AND table_name = $1
           AND is_nullable = 'NO'`,
        [probe],
      );
      for (const row of required.rows) {
        await client.query(
          `ALTER TABLE ${probe} ALTER COLUMN "${row.column_name.replaceAll('"', '""')}" DROP NOT NULL`,
        );
      }
      await client.query(`INSERT INTO ${probe} (${column}) VALUES ($1), ($2)`, [
        PRIOR_NATIVE_OPERATOR_EPOCH,
        NATIVE_AD_ENGINE_VERSION,
      ]);
    }

    await client.query(
      "CREATE TEMP TABLE native_action_epoch_probe (LIKE meta_ads_action_log INCLUDING CONSTRAINTS) ON COMMIT DROP",
    );
    const actionRequired = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema LIKE 'pg_temp_%'
         AND table_name = 'native_action_epoch_probe'
         AND is_nullable = 'NO'`,
    );
    for (const row of actionRequired.rows) {
      await client.query(
        `ALTER TABLE native_action_epoch_probe ALTER COLUMN "${row.column_name.replaceAll('"', '""')}" DROP NOT NULL`,
      );
    }
    const insertActionProbe = (engineVersion: string | null, suffix: string) =>
      client.query(
        `INSERT INTO native_action_epoch_probe (
           source, decision_contract_version, provider_account_ref_id,
           provider_account_id, decision_episode_key, decision_snapshot_id,
           decision_evaluation_id, decision_engine_version, decision_hash,
           idempotency_key, action, status, provider_verified, dry_run
         ) VALUES (
           'decision_origin', $1, '11111111-1111-4111-8111-111111111111',
           'act_probe', $2, '22222222-2222-4222-8222-222222222222',
           '33333333-3333-4333-8333-333333333333', $3, $4, $5,
           'pause', 'pending', false, false
         )`,
        [
          DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
          suffix.padEnd(64, "0").slice(0, 64),
          engineVersion,
          "a".repeat(64),
          `probe-${suffix}`,
        ],
      );
    await insertActionProbe(PRIOR_NATIVE_OPERATOR_EPOCH, "prior");
    await insertActionProbe(NATIVE_AD_ENGINE_VERSION, "current");
    await client.query("SAVEPOINT null_engine_probe");
    let nullEngineRejected = false;
    try {
      await insertActionProbe(null, "null");
    } catch (error) {
      if ((error as { code?: string }).code !== "23514") throw error;
      nullEngineRejected = true;
      await client.query("ROLLBACK TO SAVEPOINT null_engine_probe");
    }
    if (!nullEngineRejected) {
      await client.query("ROLLBACK TO SAVEPOINT null_engine_probe");
      throw new Error("Decision-origin action accepted a null engine version.");
    }
    await client.query("RELEASE SAVEPOINT null_engine_probe");
    await client.query("ROLLBACK");

    const constraintOidsBefore = new Map(
      rows.map((row) => [`${row.table_name}.${row.constraint_name}`, row.oid]),
    );
    await client.query(AD_OPERATOR_RESPONSE_EPOCH_COMPATIBILITY_SQL);
    const { rows: rowsAfterNoop } = await client.query<{
      oid: string;
      table_name: string;
      constraint_name: string;
    }>(`
      SELECT constraint_row.oid::text AS oid,
        relation.relname AS table_name,
        constraint_row.conname AS constraint_name
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      WHERE (relation.relname, constraint_row.conname) IN (
        ('meta_ads_action_log', 'meta_ads_action_log_decision_origin_typed_check'),
        ('engine_v3_ad_recommendation_episodes', 'engine_v3_ad_response_episode_native_epoch_check'),
        ('engine_v3_ad_operator_action_receipts', 'engine_v3_ad_action_receipt_source_epoch_check')
      )
    `);
    for (const row of rowsAfterNoop) {
      if (
        constraintOidsBefore.get(`${row.table_name}.${row.constraint_name}`) !==
        row.oid
      ) {
        throw new Error(
          `Compatible native operator constraint was rebuilt: ${row.table_name}.${row.constraint_name}`,
        );
      }
    }
    log(
      "native operator epoch compatibility ok: rollback/current epochs pass, null lineage fails, and compatible constraints are not rebuilt.",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function seedTargetHistoryBackfillCases(
  databaseUrl: string,
): Promise<TargetHistoryBackfillCases> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const ownerResult = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Target history migration check', 'target-history-migration-check@example.invalid', 'unused')
       RETURNING id`,
    );
    const ownerId = ownerResult.rows[0]?.id;
    if (!ownerId)
      throw new Error("Could not create target-history migration owner.");

    const businessResult = await client.query<{ id: string; name: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Target history missing', $1), ('Target history existing', $1)
       RETURNING id, name`,
      [ownerId],
    );
    const missingHistoryBusinessId = businessResult.rows.find(
      (row) => row.name === "Target history missing",
    )?.id;
    const existingHistoryBusinessId = businessResult.rows.find(
      (row) => row.name === "Target history existing",
    )?.id;
    if (!missingHistoryBusinessId || !existingHistoryBusinessId) {
      throw new Error(
        "Could not create both target-history migration businesses.",
      );
    }

    await client.query(
      `INSERT INTO business_target_packs (
         business_id, target_roas, break_even_roas, default_risk_posture,
         source_label, updated_by_user_id, created_at, updated_at
       ) VALUES
         ($1, 3.5, 2.7, 'balanced', 'settings_manual_entry', $3,
          TIMESTAMPTZ '2026-04-29 12:34:56+00', TIMESTAMPTZ '2026-04-29 12:34:56+00'),
         ($2, 4.0, 3.0, 'balanced', 'settings_manual_entry', $3,
          TIMESTAMPTZ '2026-04-29 12:34:56+00', TIMESTAMPTZ '2026-04-29 12:34:56+00')`,
      [missingHistoryBusinessId, existingHistoryBusinessId, ownerId],
    );
    await client.query(
      `INSERT INTO business_target_pack_history (
         business_id, business_ref_id, target_roas, break_even_roas,
         default_risk_posture, source_label, operation, effective_at, recorded_at,
         updated_by_user_id
       ) VALUES (
         $1, $1, 9.9, 8.8, 'balanced', 'preexisting_history', 'upsert',
         TIMESTAMPTZ '2026-01-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00', $2
       )`,
      [existingHistoryBusinessId, ownerId],
    );

    log("target-history backfill fixtures seeded.");
    return { missingHistoryBusinessId, existingHistoryBusinessId };
  } finally {
    await client.end();
  }
}

async function assertTargetHistoryBackfillCases(
  databaseUrl: string,
  cases: TargetHistoryBackfillCases,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{
      business_id: string;
      target_roas: number;
      break_even_roas: number;
      source_label: string;
      operation: string;
      effective_at: Date;
      recorded_at: Date;
    }>(
      `SELECT business_id, target_roas, break_even_roas, source_label, operation,
              effective_at, recorded_at
       FROM business_target_pack_history
       WHERE business_id = ANY($1::uuid[])
       ORDER BY business_id, recorded_at, id`,
      [[cases.missingHistoryBusinessId, cases.existingHistoryBusinessId]],
    );
    const missingRows = result.rows.filter(
      (row) => row.business_id === cases.missingHistoryBusinessId,
    );
    const existingRows = result.rows.filter(
      (row) => row.business_id === cases.existingHistoryBusinessId,
    );
    const backfilled = missingRows[0];
    const preexisting = existingRows[0];
    if (
      missingRows.length !== 1 ||
      Number(backfilled?.target_roas) !== 3.5 ||
      Number(backfilled?.break_even_roas) !== 2.7 ||
      backfilled?.source_label !== "settings_manual_entry" ||
      backfilled?.operation !== "upsert" ||
      backfilled?.effective_at.toISOString() !== "2026-04-29T12:34:56.000Z" ||
      backfilled.recorded_at.getTime() < backfilled.effective_at.getTime()
    ) {
      throw new Error(
        "Missing target history was not backfilled exactly once with preserved values.",
      );
    }
    if (
      existingRows.length !== 1 ||
      Number(preexisting?.target_roas) !== 9.9 ||
      Number(preexisting?.break_even_roas) !== 8.8 ||
      preexisting?.source_label !== "preexisting_history"
    ) {
      throw new Error(
        "Existing target history was duplicated or overwritten by the backfill.",
      );
    }

    log(
      "target-history backfill ok: missing history filled, existing history unchanged.",
    );
  } finally {
    await client.end();
  }
}

async function assertDecisionEvaluationProvenance(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");

    const ownerResult = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Migration provenance check', 'migration-provenance-check@example.invalid', 'unused')
       RETURNING id`,
    );
    const ownerId = ownerResult.rows[0]?.id;
    if (!ownerId) throw new Error("Could not create provenance-check owner.");

    const businessResult = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Migration provenance check', $1)
       RETURNING id`,
      [ownerId],
    );
    const businessId = businessResult.rows[0]?.id;
    if (!businessId)
      throw new Error("Could not create provenance-check business.");

    const jobResult = await client.query<{ id: string }>(
      `INSERT INTO engine_v3_job_runs (
         job_name, business_ref_id, business_id, as_of_date, engine_version, status, finished_at
       )
       VALUES
         ('decisions', $1, 'migration-provenance-check', DATE '2026-07-12', 'migration-check-v1', 'success', now()),
         ('decisions', $1, 'migration-provenance-check', DATE '2026-07-12', 'migration-check-v1', 'success', now())
       RETURNING id`,
      [businessId],
    );
    const [firstJobId, secondJobId] = jobResult.rows.map((row) => row.id);
    if (!firstJobId || !secondJobId) {
      throw new Error("Could not create both provenance-check job runs.");
    }

    const contextHash = "a".repeat(64);
    const contextIds: string[] = [];
    for (const jobRunId of [firstJobId, secondJobId]) {
      const contextResult = await client.query<{ id: string }>(
        `INSERT INTO engine_v3_decision_evaluation_contexts (
           business_ref_id, business_id, as_of_date, engine_version, scope_type, scope_id,
           contract_version, context_json, account_profile_json, data_health_json, flags_json,
           context_hash, job_run_id, evaluated_at
         ) VALUES (
           $1, 'migration-provenance-check', DATE '2026-07-12', 'migration-check-v1',
           'account', '*', 'engine-v3-canonical-evaluation.v1', '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, '{}'::jsonb, $2, $3, now()
         )
         RETURNING id`,
        [businessId, contextHash, jobRunId],
      );
      const contextId = contextResult.rows[0]?.id;
      if (!contextId)
        throw new Error("Could not create provenance-check context.");
      contextIds.push(contextId);
    }

    const duplicateContext = await client.query(
      `INSERT INTO engine_v3_decision_evaluation_contexts (
         business_ref_id, business_id, as_of_date, engine_version, scope_type, scope_id,
         contract_version, context_json, account_profile_json, data_health_json, flags_json,
         context_hash, job_run_id, evaluated_at
       ) VALUES (
         $1, 'migration-provenance-check', DATE '2026-07-12', 'migration-check-v1',
         'account', '*', 'engine-v3-canonical-evaluation.v1', '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, $2, $3, now()
       )
       ON CONFLICT ON CONSTRAINT engine_v3_eval_contexts_run_scope_hash_unique DO NOTHING`,
      [businessId, contextHash, firstJobId],
    );
    if (duplicateContext.rowCount !== 0 || contextIds.length !== 2) {
      throw new Error(
        "Same-day rerun uniqueness did not preserve two jobs while deduping one retry.",
      );
    }

    const inputHash = "b".repeat(64);
    const decisionHash = "c".repeat(64);
    const evaluationIds: string[] = [];
    for (const [index, contextId] of contextIds.entries()) {
      const evaluationResult = await client.query<{ id: string }>(
        `INSERT INTO engine_v3_decision_evaluations (
           context_id, business_ref_id, business_id, creative_id, as_of_date, engine_version,
           scope_type, scope_id, contract_version, creative_input_json, campaign_context_json,
           prior_hysteresis_json, decision_output_json, raw_label, hysteresis_suppressed,
           input_hash, decision_hash, job_run_id, evaluated_at
         ) VALUES (
           $1, $2, 'migration-provenance-check', 'creative-rerun-check', DATE '2026-07-12',
           'migration-check-v1', 'account', '*', 'engine-v3-canonical-evaluation.v1',
           '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'keep', FALSE,
           $3, $4, $5, now()
         )
         RETURNING id`,
        [
          contextId,
          businessId,
          inputHash,
          decisionHash,
          index === 0 ? firstJobId : secondJobId,
        ],
      );
      const evaluationId = evaluationResult.rows[0]?.id;
      if (!evaluationId)
        throw new Error("Could not create provenance-check evaluation.");
      evaluationIds.push(evaluationId);
    }

    await client.query("SAVEPOINT lineage_mismatch");
    try {
      await client.query(
        `INSERT INTO engine_v3_decision_evaluations (
           context_id, business_ref_id, creative_id, as_of_date, engine_version, scope_type, scope_id,
           contract_version, creative_input_json, campaign_context_json, prior_hysteresis_json,
           decision_output_json, raw_label, input_hash, decision_hash, job_run_id, evaluated_at
         ) VALUES (
           $1, $2, 'lineage-mismatch', DATE '2026-07-12', 'migration-check-v1', 'account', '*',
           'engine-v3-canonical-evaluation.v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, 'keep', $3, $4, $5, now()
         )`,
        [contextIds[0], businessId, inputHash, decisionHash, secondJobId],
      );
      throw new Error(
        "Composite context lineage FK accepted a mismatched job run.",
      );
    } catch (error) {
      const code =
        typeof error === "object" && error != null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code !== "23503") throw error;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT lineage_mismatch");
    }

    await client.query(
      `INSERT INTO engine_v3_decision_snapshots_daily (
         business_ref_id, business_id, creative_id, as_of_date, engine_version, scope_type, scope_id,
         label, confidence, truth_source, effective_target_roas, badges, reason, evaluation_id,
         input_hash, decision_hash
       ) VALUES (
         $1, 'migration-provenance-check', 'creative-rerun-check', DATE '2026-07-12',
         'migration-check-v1', 'account', '*', 'keep', 50, 'global_default', 1.0,
         '[]'::jsonb, 'migration provenance check', $2, $3, $4
       )`,
      [businessId, evaluationIds[0], inputHash, decisionHash],
    );

    await client.query("SAVEPOINT immutable_evaluation");
    try {
      await client.query(
        `DELETE FROM engine_v3_decision_evaluations WHERE id = $1`,
        [evaluationIds[0]],
      );
      throw new Error(
        "Snapshot evaluation FK allowed authoritative provenance deletion.",
      );
    } catch (error) {
      const code =
        typeof error === "object" && error != null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code !== "23503") throw error;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT immutable_evaluation");
    }

    log(
      "provenance seam ok: same-day job reruns persist separately, retries dedupe, lineage mismatches fail, snapshot-linked evaluations are delete-restricted.",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

async function assertDecisionAuthorityProvenance(
  databaseUrl: string,
): Promise<void> {
  const labels = [
    "scale",
    "keep",
    "refresh",
    "cut",
    "test_more",
    "diagnose",
    "out_of_scope",
  ];
  const blockers = D063_AUTHORITY_BLOCKERS;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const [index, [table]] of AUTHORITY_PROVENANCE_TABLES.entries()) {
      const probe = `authority_provenance_probe_${index}`;
      await client.query(
        `CREATE TEMP TABLE ${probe} (LIKE ${table} INCLUDING CONSTRAINTS) ON COMMIT DROP`,
      );
      if (table === "engine_v3_ad_decision_snapshots_daily") {
        // This probe isolates the two nullable provenance-domain checks. The
        // native snapshot authority CHECK is exercised by its own real-row
        // seam and now deliberately rejects an otherwise empty probe row
        // instead of passing PostgreSQL UNKNOWN.
        await client.query(
          `ALTER TABLE ${probe}
           DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_authority_check`,
        );
      }
      const { rows: requiredColumns } = await client.query<{
        column_name: string;
      }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema LIKE 'pg_temp_%' AND table_name = $1 AND is_nullable = 'NO'`,
        [probe],
      );
      for (const { column_name: column } of requiredColumns) {
        await client.query(
          `ALTER TABLE ${probe} ALTER COLUMN "${column.replaceAll('"', '""')}" DROP NOT NULL`,
        );
      }

      const allowed = [
        ...labels.map((label) => [label, null]),
        ...blockers.map((blocker) => [null, blocker]),
        [null, null],
      ];
      for (const [label, blocker] of allowed) {
        const { rows } = await client.query<{
          pre_authority_label: string | null;
          authority_blocker: string | null;
        }>(
          `INSERT INTO ${probe} (pre_authority_label, authority_blocker)
           VALUES ($1, $2) RETURNING pre_authority_label, authority_blocker`,
          [label, blocker],
        );
        if (
          rows[0]?.pre_authority_label !== label ||
          rows[0]?.authority_blocker !== blocker
        )
          throw new Error(`Authority provenance round trip failed: ${table}`);
      }

      for (const [column, value] of [
        ["pre_authority_label", "future_label"],
        ["authority_blocker", "future_blocker"],
      ]) {
        await client.query("SAVEPOINT invalid_authority_provenance");
        try {
          await client.query(`INSERT INTO ${probe} (${column}) VALUES ($1)`, [
            value,
          ]);
          throw new Error(
            `Authority constraint accepted ${column}=${value}: ${table}`,
          );
        } catch (error) {
          const code =
            typeof error === "object" && error && "code" in error
              ? String((error as { code?: unknown }).code ?? "")
              : "";
          if (code !== "23514") throw error;
        } finally {
          await client.query(
            "ROLLBACK TO SAVEPOINT invalid_authority_provenance",
          );
          await client.query("RELEASE SAVEPOINT invalid_authority_provenance");
        }
      }
    }
    log(
      "authority provenance seam ok: four nullable, closed contracts round-trip.",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

async function seedD060AuthorityBlockerConstraints(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const oldValues = D060_AUTHORITY_BLOCKERS.map(
      (value) => `'${value}'`,
    ).join(", ");
    for (const [table, prefix] of AUTHORITY_PROVENANCE_TABLES) {
      const constraint = `${prefix}_authority_blocker_check`;
      await client.query(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`,
      );
      await client.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraint}
         CHECK (authority_blocker IS NULL OR authority_blocker IN (${oldValues}))`,
      );
    }
    const { rows } = await client.query<{
      table_name: string;
      constraint_name: string;
      constraint_type: string;
      validated: boolean;
      definition: string;
    }>(
      `SELECT relation.relname AS table_name,
        constraint_row.conname AS constraint_name,
        constraint_row.contype::text AS constraint_type,
        constraint_row.convalidated AS validated,
        pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint constraint_row
       INNER JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       INNER JOIN pg_namespace namespace_row
         ON namespace_row.oid = relation.relnamespace
       WHERE namespace_row.nspname = current_schema()
         AND (relation.relname, constraint_row.conname) IN (
           SELECT * FROM unnest($1::text[], $2::text[])
         )`,
      [
        AUTHORITY_PROVENANCE_TABLES.map(([table]) => table),
        AUTHORITY_PROVENANCE_TABLES.map(
          ([, prefix]) => `${prefix}_authority_blocker_check`,
        ),
      ],
    );
    if (rows.length !== AUTHORITY_PROVENANCE_TABLES.length) {
      throw new Error(
        `D060 authority constraint seed count mismatch: expected ${AUTHORITY_PROVENANCE_TABLES.length}, got ${rows.length}`,
      );
    }
    for (const row of rows) {
      const definition = row.definition.toLowerCase();
      if (
        row.constraint_type !== "c" ||
        row.validated !== true ||
        D060_AUTHORITY_BLOCKERS.some(
          (blocker) => !definition.includes(blocker),
        ) ||
        definition.includes("recent_recovery_unverifiable")
      ) {
        throw new Error(
          `D060 authority constraint seed is not the narrow validated CHECK: ${row.table_name}.${row.constraint_name} ${row.definition}`,
        );
      }
    }
    await client.query("COMMIT");
    log(
      "seeded four canonical, validated D060 authority-blocker CHECK constraints",
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function assertD063AuthorityBlockerConstraintUpgrade(
  databaseUrl: string,
  expectedOids?: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      oid: string;
      table_name: string;
      constraint_name: string;
      constraint_type: string;
      validated: boolean;
      definition: string;
    }>(
      `SELECT constraint_row.oid::text AS oid,
        relation.relname AS table_name,
        constraint_row.conname AS constraint_name,
        constraint_row.contype::text AS constraint_type,
        constraint_row.convalidated AS validated,
        pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint constraint_row
       INNER JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       INNER JOIN pg_namespace namespace_row
         ON namespace_row.oid = relation.relnamespace
       WHERE namespace_row.nspname = current_schema()
         AND (relation.relname, constraint_row.conname) IN (
           SELECT * FROM unnest($1::text[], $2::text[])
         )`,
      [
        AUTHORITY_PROVENANCE_TABLES.map(([table]) => table),
        AUTHORITY_PROVENANCE_TABLES.map(
          ([, prefix]) => `${prefix}_authority_blocker_check`,
        ),
      ],
    );
    if (rows.length !== AUTHORITY_PROVENANCE_TABLES.length) {
      throw new Error(
        `D063 authority constraint count mismatch: expected ${AUTHORITY_PROVENANCE_TABLES.length}, got ${rows.length}`,
      );
    }
    const expectedNames = new Map<string, string>(
      AUTHORITY_PROVENANCE_TABLES.map(([table, prefix]) => [
        table,
        `${prefix}_authority_blocker_check`,
      ]),
    );
    const actualOids = new Map<string, string>();
    for (const row of rows) {
      const expectedName = expectedNames.get(row.table_name);
      const definition = row.definition.toLowerCase();
      const identity = `${row.table_name}.${row.constraint_name}`;
      if (
        row.constraint_name !== expectedName ||
        row.constraint_type !== "c" ||
        row.validated !== true ||
        D063_AUTHORITY_BLOCKERS.some(
          (blocker) => !definition.includes(blocker),
        )
      ) {
        throw new Error(
          `D063 authority constraint is not the canonical validated CHECK: ${identity} type=${row.constraint_type} validated=${row.validated} ${row.definition}`,
        );
      }
      if (expectedOids && expectedOids.get(identity) !== row.oid) {
        throw new Error(
          `D063 post-upgrade idempotency rebuilt ${identity}: expected oid=${expectedOids.get(identity) ?? "missing"}, got oid=${row.oid}`,
        );
      }
      actualOids.set(identity, row.oid);
    }
    const temporaryNames = AUTHORITY_PROVENANCE_TABLES.map(
      ([, prefix]) => `${prefix}_authority_blocker_check_d063`,
    );
    const temporary = await client.query<{ constraint_name: string }>(
      `SELECT conname AS constraint_name
       FROM pg_constraint
       WHERE conname = ANY($1::text[])`,
      [temporaryNames],
    );
    if (temporary.rows.length > 0) {
      throw new Error(
        `D063 temporary authority constraints remain installed: ${temporary.rows.map((row) => row.constraint_name).join(", ")}`,
      );
    }
    log(
      `D063 authority constraints ok: canonical names, CHECK type, validated definitions${expectedOids ? ", and stable post-upgrade OIDs" : ""}`,
    );
    return actualOids;
  } finally {
    await client.end();
  }
}

async function assertNativeDecisionAttemptDurability(
  databaseUrl: string,
  businessId: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const durableAttempt = await client.query<{ id: string }>(
      `INSERT INTO engine_v3_job_runs (
         job_name, business_ref_id, business_id, as_of_date, engine_version, status
       ) VALUES ($1, $2::uuid, $2, DATE '2026-07-09', $3, 'running')
       RETURNING id::text AS id`,
      [AD_DECISIONS_JOB_NAME, businessId, NATIVE_AD_ENGINE_VERSION],
    );
    const durableAttemptId = durableAttempt.rows[0]?.id;
    if (!durableAttemptId) {
      throw new Error("Could not create durable native attempt fixture.");
    }
    const worker = new Client({ connectionString: databaseUrl });
    await worker.connect();
    try {
      await worker.query("BEGIN");
      await worker.query(
        `UPDATE engine_v3_job_runs SET status = 'success', finished_at = now()
         WHERE id = $1::uuid`,
        [durableAttemptId],
      );
      await worker.query("ROLLBACK");
    } finally {
      await worker.end();
    }
    const durableStatus = await client.query<{ status: string }>(
      "SELECT status FROM engine_v3_job_runs WHERE id = $1::uuid",
      [durableAttemptId],
    );
    if (durableStatus.rows[0]?.status !== "running") {
      throw new Error(
        "Work-transaction rollback erased or finalized the durable attempt.",
      );
    }
    await client.query("DELETE FROM engine_v3_job_runs WHERE id = $1::uuid", [
      durableAttemptId,
    ]);

    await client.query("BEGIN");
    const insertRun = async (input: {
      asOf: string;
      status: "running" | "success" | "failed" | "skipped";
      startedOffsetSeconds: number;
      finishedOffsetSeconds?: number;
      errorMessage?: string;
      receipt?: boolean;
      engineVersion?: string;
    }) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO engine_v3_job_runs (
           job_name, business_ref_id, business_id, as_of_date, engine_version,
           status, started_at, finished_at, error_message, error_json
         ) VALUES (
           $1, $2::uuid, $2, $3::date, $4, $5,
           statement_timestamp() + make_interval(secs => $6),
           CASE WHEN $7::double precision IS NULL THEN NULL
             ELSE statement_timestamp() + make_interval(secs => $7) END,
           $8,
           CASE WHEN $9::boolean THEN jsonb_build_object(
             'metadata', jsonb_build_object(
               'hydration_receipts', jsonb_build_array(jsonb_build_object(
                 'provider_account_ref_id', '00000000-0000-4000-8000-000000000001',
                 'provider_account_id', 'act_seam',
                 'expected_ad_count', 1,
                 'expected_manifest_hash', repeat('a', 64),
                 'hydrated_ad_count', 1,
                 'hydrated_manifest_hash', repeat('a', 64),
                 'authoritative_for_prune', true
               ))
             )
           ) ELSE NULL END
         ) RETURNING id::text AS id`,
        [
          AD_DECISIONS_JOB_NAME,
          businessId,
          input.asOf,
          input.engineVersion ?? NATIVE_AD_ENGINE_VERSION,
          input.status,
          input.startedOffsetSeconds,
          input.finishedOffsetSeconds ?? null,
          input.errorMessage ?? null,
          input.receipt ?? false,
        ],
      );
      const id = rows[0]?.id;
      if (!id)
        throw new Error("Could not insert native decision attempt fixture.");
      return id;
    };
    const readGeneration = (asOf: string) =>
      client.query<{
        // `latest` or `last_success` — the query returns both since D091, and
        // which row is which is the answer, not an implementation detail.
        selection: string;
        job_status: string;
        job_run_id: string;
        as_of_date: string;
      }>(READ_NATIVE_DECISION_GENERATION_QUERY, [
        businessId,
        "act_seam",
        AD_DECISIONS_JOB_NAME,
        asOf,
        NATIVE_DECISION_RUNNING_GRACE_MS,
        /*
          THE LAST THREE ARE THE LAST-GOOD FALLBACK'S OWN BOUNDS, and the seam
          must pass them or it tests a different statement than production runs.
          $6 pins the engine epoch a retained generation may come from, $7 is
          the serving day the age ceiling is measured against, and $8 is that
          ceiling in days. This call supplied five and the statement wanted
          eight — the seam failed with "bind message supplies 5 parameters, but
          prepared statement requires 8", which is the honest outcome and is why
          it is a gate.

          The engine version is the CURRENT constant, matching what `insertRun`
          writes, so the epoch filter admits these fixtures. `asOf` doubles as
          the serving day: every run this leg inserts is dated on or near it, so
          the ceiling never fires and this leg keeps testing what it was written
          to test — latest-versus-retained selection, not the age bound.
        */
        NATIVE_AD_ENGINE_VERSION,
        asOf,
        NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS,
      ]);

    /*
      SINCE D091 THE QUERY RETURNS TWO SELECTIONS, and `rows[0]` is no longer
      the latest one. It orders by `job.selection` first, and `last_success`
      sorts BEFORE `latest`, so every leg below that means "the current
      generation" must ask for it by name rather than by position.
    */
    type GenerationRow = {
      selection: string;
      job_status: string;
      job_run_id: string;
      as_of_date: string;
    };
    const latestOf = (result: { rows: GenerationRow[] }) =>
      result.rows.find((row) => row.selection === "latest") ?? result.rows[0];
    const retainedOf = (result: { rows: GenerationRow[] }) =>
      result.rows.find((row) => row.selection === "last_success") ?? null;

    const d1Success = await insertRun({
      asOf: "2026-07-10",
      status: "success",
      startedOffsetSeconds: -60,
      finishedOffsetSeconds: -50,
      receipt: true,
    });
    const d2Failure = await insertRun({
      asOf: "2026-07-11",
      status: "failed",
      startedOffsetSeconds: -40,
      finishedOffsetSeconds: -30,
      errorMessage: "forced seam failure",
    });
    const historical = await readGeneration("2026-07-10");
    const current = await readGeneration("2026-07-11");
    /*
      D091 AMENDS D054, AND THIS LEG STATES THE AMENDMENT.

      This used to require that a newer failure leave ONLY the failure — the
      older success was expected to disappear from the answer entirely, and the
      reader fell back to legacy creative evidence. It no longer does: the query
      returns the failed LATEST run alongside the last successful generation
      whose hydration receipt for THIS account is complete, so the workspace can
      serve yesterday's decisions marked stale while still showing that today's
      run failed.

      What did NOT change, and is asserted below, is the authority: the row
      labelled `latest` is still the FAILURE. The retained success is offered
      under its own `last_success` selection, and every decision served from it
      carries `actionEligible: false` / `authorizedAction: null`, so nothing it
      contains can authorize a provider write. A newer failure still strips the
      older generation's authority; it no longer strips the generation.
    */
    const historicalLatest = latestOf(historical);
    const currentLatest = latestOf(current);
    if (
      historicalLatest?.job_run_id !== d1Success ||
      historicalLatest?.job_status !== "success" ||
      currentLatest?.job_run_id !== d2Failure ||
      currentLatest?.job_status !== "failed"
    ) {
      throw new Error(
        "Newer native failure is no longer the latest terminal generation.",
      );
    }
    const retained = retainedOf(current);
    if (retained !== null && retained.job_status !== "success") {
      throw new Error(
        "A retained last-good generation must be a success, or absent.",
      );
    }

    const staleRunning = await insertRun({
      asOf: "2026-07-12",
      status: "running",
      startedOffsetSeconds: -(NATIVE_DECISION_RUNNING_GRACE_MS / 1000 + 60),
    });
    const stale = await readGeneration("2026-07-12");
    if (
      latestOf(stale)?.job_run_id !== staleRunning ||
      latestOf(stale)?.job_status !== "failed"
    ) {
      throw new Error("Stale running native attempt did not fail closed.");
    }

    const holder = await insertRun({
      asOf: "2026-07-13",
      status: "success",
      startedOffsetSeconds: -20,
      finishedOffsetSeconds: -5,
      receipt: true,
    });
    await insertRun({
      asOf: "2026-07-13",
      status: "skipped",
      startedOffsetSeconds: -15,
      finishedOffsetSeconds: -14,
      errorMessage:
        "Advisory lock not acquired (native ad job may already be running)",
    });
    const overlapped = await readGeneration("2026-07-13");
    if (
      latestOf(overlapped)?.job_run_id !== holder ||
      latestOf(overlapped)?.job_status !== "success"
    ) {
      throw new Error(
        "Overlapped advisory skip displaced its terminal holder.",
      );
    }

    const isolatedSkip = await insertRun({
      asOf: "2026-07-14",
      status: "skipped",
      startedOffsetSeconds: -4,
      finishedOffsetSeconds: -3,
      errorMessage:
        "Advisory lock not acquired (native ad job may already be running)",
    });
    const isolated = await readGeneration("2026-07-14");
    if (
      latestOf(isolated)?.job_run_id !== isolatedSkip ||
      latestOf(isolated)?.job_status !== "skipped"
    ) {
      throw new Error("Unproven advisory skip did not fail authority closed.");
    }

    await insertRun({
      asOf: "2026-07-15",
      status: "success",
      startedOffsetSeconds: -12,
      finishedOffsetSeconds: -10,
      receipt: true,
    });
    const crossEpochFailure = await insertRun({
      asOf: "2026-07-15",
      status: "failed",
      startedOffsetSeconds: -6,
      finishedOffsetSeconds: -5,
      errorMessage: "forced cross-epoch failure",
      engineVersion: "v3-prior-native-epoch",
    });
    const crossEpoch = await readGeneration("2026-07-15");
    if (
      latestOf(crossEpoch)?.job_run_id !== crossEpochFailure ||
      latestOf(crossEpoch)?.job_status !== "failed"
    ) {
      throw new Error(
        "A newer cross-epoch failure did not invalidate current authority.",
      );
    }

    log(
      "native decision attempt seam ok: newer/cross-epoch failure, stale running, and advisory overlap all resolve fail-closed.",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

/**
 * Non-fatal convergence report: tables that only appear after the SECOND
 * migration run mean a from-zero deploy does not converge in a single pass.
 *
 * Known defect (2026-07-06): google_ads_campaign_state_history and
 * google_ads_ad_group_state_history reference google_ads_raw_snapshots(id)
 * but are created BEFORE google_ads_raw_snapshots in lib/migrations.ts
 * (~lines 3277/3321 vs ~3949), and their CREATE errors are swallowed by
 * .catch(() => {}). First run: FK target missing → silently skipped.
 * Second run: target exists → created. Fix belongs in lib/migrations.ts
 * (reorder or drop the swallow), out of scope for this check.
 */
function reportConvergenceGap(run1Tables: string[], run2Tables: string[]) {
  const run1Set = new Set(run1Tables);
  const onlyAfterSecondRun = run2Tables.filter((table) => !run1Set.has(table));
  if (onlyAfterSecondRun.length === 0) {
    log("convergence ok: first run already produced the full table set.");
    return;
  }
  console.warn(
    `[migrations-from-zero] WARNING: from-zero deploy does NOT converge in one run. ` +
      `${onlyAfterSecondRun.length} table(s) only exist after the second migration run:\n` +
      onlyAfterSecondRun.map((table) => `  - ${table}`).join("\n") +
      `\n  A fresh single-run deploy would be missing these tables (silent .catch(() => {}) ` +
      `swallows the CREATE failure in lib/migrations.ts).`,
  );
}

async function main() {
  const repoRoot = process.cwd();
  if (!fs.existsSync(path.join(repoRoot, "scripts", "run-migrations.ts"))) {
    throw new Error(
      `Expected to run from the repo root (scripts/run-migrations.ts not found under ${repoRoot}). Use: npm run test:migrations-from-zero`,
    );
  }

  const pgBinDir = resolvePgBinDir();
  const port = await findFreeSafePort();
  assertSafePort(port);

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsecute-ephemeral-pg-"),
  );
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const databaseUrl = `postgresql://${EPHEMERAL_DB_USER}@127.0.0.1:${port}/${EPHEMERAL_DB_NAME}`;
  const previousIntegrationTokenEncryptionKey =
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;

  // Every child shares this throwaway database. Several seam fixtures insert
  // legacy plaintext credentials deliberately, and later idempotency checks
  // run the real migration over those rows. Give the whole ephemeral run one
  // private, throwaway key so that conversion is exercised without borrowing
  // production key material and later children can still read the ciphertext.
  process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");

  log(`pg binaries: ${pgBinDir}`);
  log(`data dir:    ${dataDir}`);
  log(`port:        ${port} (never 15432 / 5432)`);

  let serverStarted = false;
  try {
    log("initdb: creating fresh cluster...");
    runSync(
      path.join(pgBinDir, "initdb"),
      [
        "-D",
        dataDir,
        "-U",
        EPHEMERAL_DB_USER,
        "--auth=trust",
        "--encoding=UTF8",
        "--no-locale",
      ],
      "initdb",
    );

    log("pg_ctl: starting ephemeral server...");
    runSync(
      path.join(pgBinDir, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-t",
        "60",
        "-o",
        // TCP only on loopback; unix sockets disabled (temp paths can exceed
        // the socket path length limit on macOS). fsync off: throwaway data.
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off`,
        "start",
      ],
      "pg_ctl start",
    );
    serverStarted = true;

    log(`createdb: ${EPHEMERAL_DB_NAME}`);
    runSync(
      path.join(pgBinDir, "createdb"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        EPHEMERAL_DB_USER,
        EPHEMERAL_DB_NAME,
      ],
      "createdb",
    );

    // Three separate child processes: lib/migrations.ts keeps module-level
    // "already completed" state, so in-process re-runs would be no-ops and
    // prove nothing about idempotency.
    await runMigrationsChild(repoRoot, databaseUrl, "run 1: from zero");
    const run1Tables = await assertSchema(databaseUrl);
    const duplicateJournalRun1Oids =
      await readDuplicateJournalTableOids(databaseUrl);
    const targetHistoryCases =
      await seedTargetHistoryBackfillCases(databaseUrl);
    await seedPriorEpochOperatorConstraints(databaseUrl);
    await seedD060AuthorityBlockerConstraints(databaseUrl);
    await runMigrationsChild(
      repoRoot,
      databaseUrl,
      "run 2: idempotency + target backfill",
    );
    const run2Tables = await assertSchema(databaseUrl);
    const duplicateJournalRun2Oids =
      await readDuplicateJournalTableOids(databaseUrl);
    assertDuplicateJournalTableOids(
      duplicateJournalRun1Oids,
      duplicateJournalRun2Oids,
      "run 2",
    );
    reportConvergenceGap(run1Tables, run2Tables);
    const run2D063ConstraintOids =
      await assertD063AuthorityBlockerConstraintUpgrade(databaseUrl);
    await runMigrationsChild(
      repoRoot,
      databaseUrl,
      "run 3: post-D063 idempotency",
    );
    const run3Tables = await assertSchema(databaseUrl);
    const duplicateJournalRun3Oids =
      await readDuplicateJournalTableOids(databaseUrl);
    assertDuplicateJournalTableOids(
      duplicateJournalRun1Oids,
      duplicateJournalRun3Oids,
      "run 3",
    );
    reportConvergenceGap(run2Tables, run3Tables);
    await assertD063AuthorityBlockerConstraintUpgrade(
      databaseUrl,
      run2D063ConstraintOids,
    );
    await assertTargetHistoryBackfillCases(databaseUrl, targetHistoryCases);
    await assertNativeOperatorEpochCompatibility(databaseUrl);
    await assertDecisionEvaluationProvenance(databaseUrl);
    await assertDecisionAuthorityProvenance(databaseUrl);
    await assertNativeDecisionAttemptDurability(
      databaseUrl,
      targetHistoryCases.missingHistoryBusinessId,
    );

    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-business-commercial-seam-child.ts",
      ),
      "business commercial atomic/CAS DB seam check",
    );

    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-entity-state-history-seam-child.ts",
      ),
      "entity state history DB seam check",
    );
    // D077: the growth-fence recovery operation. Real Postgres is the only
    // place its deletion contract, lease exclusivity, and pre/post
    // equivalence can be proven.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-state-history-compaction-seam-child.ts",
      ),
      "state-history compaction DB seam check",
    );
    // D066 requires a real PostgreSQL seam: a mocked SQL-shape test cannot show
    // what actually landed in meta_ad_daily.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-ad-daily-ownership-seam-child.ts",
      ),
      "decision-fact ownership DB seam check",
    );
    // D065/D067/D069: drive the real manual Ad status write path against a
    // controlled fake provider, with the authority guards live rather than
    // stubbed. The fixture supplies a genuinely connected, genuinely selected
    // integration; no guard is weakened and no live provider is contacted.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-manual-ad-status-route-seam-child.ts",
      ),
      "manual Ad status ROUTE-level DB seam check",
    );

    // Instrumentation storage behaviour: constraints, scope/tenancy, retention
    // and sink health can only be proven against real PostgreSQL.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-instrumentation-seam-child.ts"),
      "product instrumentation DB seam check",
    );

    // Workflow overlay atomicity and idempotency. Only a real transaction and
    // a real unique index can prove that a failed event insert rolls the state
    // back and that a replayed mutation appends nothing.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-workflow-overlay-seam-child.ts"),
      "decision workflow overlay DB seam check",
    );

    // Decision-bound provider targets. The claims here — business scoping,
    // per-grain column mapping, ambiguity detection — are claims about SQL, so
    // a mock that echoes its own input proves none of them.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-decision-bound-target-seam-child.ts"),
      "decision-bound provider target DB seam check",
    );

    // Public creative share lifecycle. Rotation atomicity and the "every dead
    // state looks the same" property are claims about a transaction and a SQL
    // predicate, so a mocked store proves neither.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-public-share-seam-child.ts"),
      "public creative share DB seam check",
    );

    // Agency directory keyset pagination. Only real PostgreSQL can prove that
    // the ORDER BY producing a cursor and the comparison consuming it agree —
    // collation, tie-breaks, duplicate and accented names included.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-agency-directory-seam-child.ts"),
      "agency directory pagination DB seam check",
    );

    // The notification lifecycle, driven through its real production
    // transitions rather than asserted from shape.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-notification-seam-child.ts"),
      "notification lifecycle DB seam check",
    );

    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-native-ad-fact-ownership-seam-child.ts",
      ),
      "native-ad decision-fact ownership DB seam check",
    );

    /*
      The sizing projection's own queries, against the real schema.

      This module shipped broken and green: its unit test mocked the database
      and fed rows named after columns that do not exist, so every statement
      raised 42703, the error was swallowed, and the projection returned every
      recommendation unchanged. A mocked row agrees with any schema; only
      PostgreSQL refuses one.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-intent-projection-seam-child.ts",
      ),
      "sizing projection source DB seam check",
    );

    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-duplicate-ad-reconciliation-seam-child.ts",
      ),
      "duplicate-ad reconciliation DB seam check",
    );

    /*
      The bid arm's own SQL, which is the part a mock cannot answer: the typed
      candidate query reads real payload columns, and the database — not a
      hopeful reader — is what refuses a `bid` row with no amount on it.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-bid-queue-seam-child.ts"),
      "bid queue DB seam check",
    );

    /*
      The two economic chains, end to end, through the REAL producers.

      Both were previously proved only by seams that minted their own
      `target_value`, and that is what hid the defect: the bid projection
      persisted a payload the candidate query could never select, so no
      snapshot-produced bid intent had ever become a queue row. This child
      seeds facts and calls the shipped snapshot, the shipped candidate
      readers and the shipped producers, so a payload mismatch fails here
      instead of being invisible until an operator notices an empty queue.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-economics-bid-chain-seam-child.ts",
      ),
      "economics and bid chain DB seam check",
    );

    /*
      The card-level Apply, on real storage.

      Its key derivation is a claim about a stored JSON blob surviving the read
      path, and the defect it pins was not a data question at all: the ceremony
      sent a display identity where the server demands
      `campaign|adset|ad:<id>`, so every Apply on a decision card was refused
      before anything could be written.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-decision-card-apply-seam-child.ts",
      ),
      "decision card apply DB seam check",
    );

    /*
      Shopify order-window coverage.

      The freshness clock took MAX(latest_successful_sync_at) across every sync
      target, so a returns pass that finished an hour ago vouched for orders
      last read five days ago. Only a real database can show that the coverage
      proof reads the recorded windows rather than the presence of rows — and
      that an expanded recent window written by a running or failed repair
      cannot borrow an earlier pass's success end.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-shopify-aov-coverage-seam-child.ts",
      ),
      "Shopify order coverage DB seam check",
    );

    /*
      The slot outcome recorded from what was ATTEMPTED, not from what is
      required.

      A retry that runs only the outstanding accounts and then throws as a whole
      used to fail every required account — including the one that had already
      succeeded, whose slot row was overwritten and whose work the next tick
      then redid. Only a real database shows that, because the damage is an
      ON CONFLICT DO UPDATE on the run table's own primary key.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-slot-retry-scope-seam-child.ts"),
      "slot retry scope DB seam check",
    );

    /*
      The complete activation identity set, and the approval re-read.

      Activation took only the first ad set and the first ad of a launch and
      still called itself delivering. It also validated the stored approval once,
      from the intent it loaded at the start, so a revocation mid-sequence could
      not stop the next POST. Both are claims about persisted state across
      steps, which is why they are proved here rather than only in memory.

      It now also drives the real resume primitives against an in-process
      provider double and proves that a revocation committed during the journal
      claim, or inside the primitive's own preflight, yields zero POSTs and a
      settled failure row. Three awaits used to stand between the last authority
      question and the request.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-activation-identity-seam-child.ts",
      ),
      "activation identity, approval and pre-POST boundary DB seam check",
    );

    /*
      Decision to staged intent to queue row to create to activation.

      The launch family shipped complete and unreachable: nothing turned a
      decision into the staged intent its queue producer selects. This child
      starts from an eligible published decision — not a hand-inserted row —
      and walks the whole chain through the shipped producers and routes,
      including the rerun that must duplicate neither the intent nor the
      provider entity.

      It then runs the same chain with nobody at the queue: creative mode
      `auto`, the account-bound scheduled authority, the real sweep, one PAUSED
      provider entity and no activation. The staged intent carries
      `launchpad_decision_staged_v1`, not a fabricated operator confirmation —
      which is the whole reason the auto arm could not simply reuse the manual
      authority.
    */
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-decision-launch-chain-seam-child.ts",
      ),
      "decision to launch chain DB seam check",
    );

    /*
      The DIRECT Launchpad create routes, whose pre-POST boundary was optional.

      Both route files call the shared handler with no options, so until the
      handler composed one, an approval withdrawn between two provider POSTs
      was seen by nothing on the operator's own path. It is proved here because
      the whole question is whether the CURRENT rows still say the brief is
      reviewed: the intent stores the brief's id, `patchMetaCreativeBrief` is an
      UPDATE, and the standing re-read is a SELECT.

      Registered rather than left to a hand run: with the seam flag unset the
      file reports "7 skipped", which reads green, so nothing would have caught
      a regression of this exact guard.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "launchpad", "direct-launch-standing-boundary.db.test.ts"),
      "direct Launchpad create route approval-standing DB seam check",
      7,
    );

    /*
      The Writes journal names the verb the write actually was.

      A verified cost-cap change was journalled as `launch_adset` with the real
      verb one level down in `payload_request.operation`, and the journal titles
      a row from the action column — so an operator's receipt for a bid apply
      read "Launch Adset". The route writes `bid` now, but every row already in
      the table keeps the old shape forever, so the READER has to answer for
      both spellings. The title expression is extracted from the shipped SQL and
      executed by PostgreSQL, which is why this needs a database at all.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "bid-history-verb-title.db.test.ts"),
      "Meta History bid verb title DB seam check",
      2,
    );

    /*
      The Writes journal ADMITS a bid row — the other half of the verb story,
      and until now the half nothing ran.

      `lib/meta/bid-history-writes-journal.db.test.ts` gates five of its six
      cases on `describe.runIf(ADSECUTE_EPHEMERAL_DB_SEAM === "1")`, and it was
      registered nowhere: not here, not in any sibling seam runner, not in
      package.json. Under `npx vitest run` the flag is unset, so those five
      reported as skipped and the file reported green on the strength of its one
      static assertion. A release note that called this "the lane the 40-stage
      seam shell runs — and it passed" was describing a run that never happened.

      Registering it is the fix; `runChildVitest` asserting the passing COUNT is
      what stops the same thing recurring silently.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "bid-history-writes-journal.db.test.ts"),
      "Meta History bid write journal admission DB seam check",
      6,
    );

    /*
      The partial-lane delta dedupe and the narrowed lineage carry.

      `lib/meta/entity-state-history-partial-delta.db.test.ts` was delivered
      with the 2026-09-07 rewrite-storm fix and ran in NO gate: it is not in
      package.json, no sibling seam runner spawns it, and it was absent here.
      vitest's DEFAULT include does collect it, and `describe.skipIf(!SEAM)`
      then reports every case as SKIPPED while the run exits 0 — the exact
      shape `scripts/verify-database-seams.sh` calls out, "a skipped database
      test reads exactly like a pass". Measured on this branch: as delivered,
      `npx vitest run <file>` with the seam flag unset printed "10 skipped
      (10)" and exited 0; against a freshly migrated ephemeral cluster the same
      file — with the eleventh case this pass adds for the partial lane's own
      lineage carry — reports 11 passed, 0 skipped.

      A database is not optional for it. Both halves are decided by rows a
      PREVIOUS call committed — the dedupe compares each observed entity
      against the winner its own baseline lateral resolves, and the lineage
      carry exists because `meta_creative_lineage_edges` FK-references state
      rows BY RUN. A template-SQL mock would answer both questions with
      whatever the test author typed.

      AREA S4 2026-09-07 — 11 -> 16. Five cases were added and every one of
      them needs real rows:

        - the partial lane's AS-OF / TIMELINE EQUIVALENCE, run as an A/B over
          two scopes that receive the identical complete history and differ
          only by an interleaved partial observation. The claim is that the
          partial run is invisible to a reader AND costs nothing, which is a
          statement about what a previous call committed;
        - POSITIVE RE-OBSERVATION RECENCY: two partial captures whose truth is
          identical and whose failure receipts differ only in request identity
          must land on ONE run whose heartbeat clocks advance. Decided by the
          stored `semantic_hash` of a row already committed;
        - its over-correction guard: two genuinely DIFFERENT failures must
          still append separately;
        - and the two writer-pressure window boundaries — a run appended
          BEFORE the window and re-observed inside it, and a run appended
          inside whose re-sighting lands after `until`. Both are decided by
          `meta_entity_observation_receipts` rows the writer appended in an
          earlier transaction, and by the run-versus-receipt clock disagreement
          that only real coalescing produces.

      Measured against a freshly migrated ephemeral cluster on this branch: 17
      passed, 0 skipped.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join(
        "lib",
        "meta",
        "entity-state-history-partial-delta.db.test.ts",
      ),
      "Meta partial-lane state-history delta dedupe DB seam check",
      17,
    );

    /*
      The ad-grain link-click column is PERSISTED by the authoritative sync.

      `lib/api/meta.ts` wrote a literal `0` into `meta_ad_daily.link_clicks` for
      every ad-day it has ever produced — `MetaAggregateTotals` has no
      link-click member, so the number was typed on the provider's behalf — and
      the correction replaced it with `null`. This file is the forward half:
      the sync now derives the count from the insight row's own `actions` array
      and stores it, and a re-sync that supplies nothing must still not
      overwrite what is stored.

      It needs the migrated schema, not a template mock. The distinction it
      exists to prove is a STORAGE distinction: `link_clicks` is a nullable
      BIGINT after the widening in `lib/migrations.ts`, and the ON CONFLICT
      clause the writer ships is `COALESCE(EXCLUDED.link_clicks,
      meta_ad_daily.link_clicks)` — two arguments, where the old three-argument
      form had an unreachable third arm. Whether an absence survives that merge
      is decided by PostgreSQL, over a row a previous statement committed.

      Registered rather than left to a hand run: with the seam flag unset the
      file gates itself on `describe.skipIf(!SEAM)`, so `npx vitest run` reports
      every case as skipped and exits 0 — the shape
      `scripts/verify-database-seams.sh` warns about in its own header, "a
      skipped database test reads exactly like a pass".

      Measured against a freshly migrated ephemeral cluster on this branch:
      29 passed, 0 skipped.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "ad-day-link-click-persistence.db.test.ts"),
      "Meta ad-day link-click persistence DB seam check",
      29,
    );

    /*
      The REPAIR half, and its readback verifier.

      Forward-only accrual is not closure: the engine's fatigue verdict needs
      the equal, disjoint 14/14 pair, and `admitCompositeBand` in
      `lib/creative-decision-engine/jobs/ad-decisions-job.ts` withholds with
      `ad_<label>_window_link_clicks_unavailable` unless BOTH bands carry a
      positive link-click total. A forward-only fix leaves the preceding band
      as the fabricated zeros it already stored. `scripts/meta/
      link-click-repair-backfill.ts` projects the measurement out of each row's
      own `payload_json` — no provider call — and
      `scripts/meta/link-click-readback-verify.ts` re-reads the result.

      A database is not optional for any of it. The candidate query decides
      ABSENT versus MEASURED ZERO in SQL (`jsonb_typeof(payload_json->'actions')
      = 'array'` plus a `jsonb_array_elements` extraction); the write is an
      `UPDATE ... FROM unnest(...)` whose pre-image guard is `IS NOT DISTINCT
      FROM`, which differs from `=` exactly where it matters; and "the dry run
      wrote nothing" is only a real claim when it is checked by re-reading the
      table rather than by counting the statements the command chose to issue.

      Measured against a freshly migrated ephemeral cluster on this branch:
      10 passed, 0 skipped. With `ADSECUTE_EPHEMERAL_DB_SEAM` unset the same
      file reports "10 skipped (10)" and exits 0, which is why the passing
      COUNT is asserted and not just the exit code.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("scripts", "meta", "link-click-repair-backfill.db.test.ts"),
      "Meta link-click repair and readback DB seam check",
      /*
        28, up from 16. 16 was Codex B11/B12/B13/B14: a truncated execute that
        must change zero rows, source freshness left untouched, provisional /
        failed-validation / post-cutoff exclusion, and the two
        readback-completeness refusals with their control.

        The twelve added in Round 5 are the two repairs that could not be
        proven without a real client:

          - THE TRANSACTION BOUNDARY (3). The executor issued BEGIN / UPDATE /
            COMMIT as separate `getDb()` calls, and a pool hands out a
            different client per call — so a multi-batch failure left the
            earlier batches applied. Proven with pool max > 1, a second
            connection held for the whole run, and a mid-run read from that
            connection that must see NOTHING after two batches; plus the
            successful control and the refusal to write with no boundary at
            all.
          - THE READBACK'S ADMISSIBILITY CONTRACT (9). The verifier counted
            every row in the window, so it certified a population decision
            hydration will never read. Four exclusions (provisional, failed
            validation, created-after-cutoff, updated-after-cutoff), the
            admissible control that makes them discriminating, the two
            requested-account cases that must not vanish from the report, the
            baseline, and the cutoff-mismatched receipt.

        The count is pinned because with `ADSECUTE_EPHEMERAL_DB_SEAM` unset this
        file reports "skipped" and exits 0, and a skipped database test reads
        exactly like a pass.

        ROUND 6 adds nine more, all about the readback counting the SAME
        population the engine reads: the seeded-complete control, the wholly
        inert NULL day that must NOT block, the five one-column activity rows
        that must (clicks / conversions / revenue alone, plus the two the old
        impressions-or-spend predicate already caught), the composition with
        the admissibility contract, and the empty-account behaviour under the
        new predicate.
      */
      37,
    );

    /*
      CODEX ROUND 5 ITEM 5 — a partial link-click band is UNKNOWN, including
      when the missing day spent nothing.

      `ad_band_aggregates` counted a missing link-click reading against a row
      only when that row had positive impressions or spend. An ad-day can carry
      clicks, conversions and revenue while its spend and impressions come back
      zero — a late-attributed conversion, a lifetime-budget day whose spend
      lands on the parent, a partial capture — and such a row was read as "did
      not deliver", so its absent reading did not count, the band was admitted
      as fully measured, and the click-to-purchase composite divided a
      numerator that INCLUDED that row's conversions by a denominator that
      EXCLUDED its link clicks.

      Only PostgreSQL can answer whether a `COUNT(*) FILTER (...)` over a real
      mixed band returned 1 or 0. The mapper tests in
      `lib/creative-decision-engine/__tests__/data-source.ad-grain.test.ts` set
      `recent14_link_clicks` by hand and cannot reach the predicate that
      produces it.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join(
        "lib",
        "creative-decision-engine",
        "ad-band-completeness.db.test.ts",
      ),
      "Native ad band link-click completeness DB seam check",
      4,
    );

    /*
      CODEX ROUND 4 ITEM 7 — schedule timestamps are validated before the write.

      Measured on a real cluster: 'not-a-date'::timestamptz and ''::timestamptz
      both raise, and '99999-01-01' is ACCEPTED by the cast while its signed
      six-digit-year ISO round-trip raises "time zone displacement out of
      range" — so NORMALIZING an out-of-range date would create the very abort
      it was meant to prevent. It has to become an explicit unknown.
      PostgreSQL was the first thing to look at these values, inside the
      transaction, so one bad provider string aborted an entire account's
      capture. Only a real database can prove the fix, which is why this is a
      seam and not a unit test.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "schedule-timestamp-normalization.db.test.ts"),
      "Meta schedule timestamp normalization DB seam check",
      8,
    );

    /*
      CODEX ROUND 4 ITEM 8 — the >60-Ad canonical-universe acceptance.

      The defect this catches is invisible below 61 ads and invisible to any
      test that builds the identity universe by hand: `structuredClone` inside
      `applyMetaExecutionGovernanceToReadModel` drops a non-enumerable
      symbol-keyed property, and every exact decision the response cap omitted
      was then counted as UN-DECIDED ACTIVE INVENTORY. On the 80-ad, 60-served
      fixture this seam seeds, that was 20 real verdicts reported to the
      operator as evidence that does not exist.

      It drives the exported GET against a migrated cluster with only the live
      Graph call stubbed, so nothing at or after the attachment point is
      mocked. Registered because with `ADSECUTE_EPHEMERAL_DB_SEAM` unset the
      file reports "8 skipped (8)" and exits 0 — a skipped database test reads
      exactly like a pass. The count is measured, not chosen.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join(
        "app",
        "api",
        "meta",
        "decisions-workspace-sixty-ad-acceptance.db.test.ts",
      ),
      "Meta decisions >60-Ad canonical universe acceptance DB seam check",
      8,
    );

    /*
      ROUND 14. The recent-edit authority's three durable contracts: the receipt
      is ranked status-blind and its sync attempt LEFT-joined (so a newer
      failure cannot be stepped over), the manifest membership is reconstructed
      from rows a writer actually committed (full and delta lanes,
      `absent_unconfirmed` removing membership, partial/point_lookup excluded),
      and `sync_run_id` is really persisted by the receipt INSERT. All three are
      decided by SQL and by committed rows, so a template mock can only restate
      what the test author typed. Registered because with
      `ADSECUTE_EPHEMERAL_DB_SEAM` unset the file reports "9 skipped (9)" and
      exits 0 — a skipped database test reads exactly like a pass.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "recent-edit-authority-receipt.db.test.ts"),
      "Meta recent-edit authority receipt/sync-run/manifest DB seam check",
      17,
    );

    /*
      ROUND 16. The bootstrap probe must ask the SAME question the recent-edit
      authority asks. Round 15's probe used a weaker predicate, so a receipt the
      authority refuses — errored, stale, cross-account, count-corrupt, or from
      an attempt that finished after the cutoff — could suppress the one-shot
      repair while every hard action stayed on HOLD. Registered because with
      `ADSECUTE_EPHEMERAL_DB_SEAM` unset the file reports "14 skipped (14)" and
      exits 0.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "authority-bootstrap-lifecycle.db.test.ts"),
      "Meta recent-edit authority bootstrap lifecycle DB seam check",
      19,
    );

    /*
      ROUND 21, ITEM 1. The lifecycle seam above drives the bootstrap's PIECES;
      this one drives the shipped orchestration -- the real
      `syncMetaPartitionDay`, with only the Graph fetch stubbed.

      Registered as its own child because it was previously verified only by
      hand. It is also the file whose account-calendar discriminator was
      vacuous until Round 21: the DB binding (America/Los_Angeles) and the
      credential profile (Europe/Istanbul) are on the same calendar date for
      most of any real day, so "the run used the DB binding" passed whichever
      source it had read. It now pins an instant where the two provably differ
      and asserts the difference before relying on it.

      Exactly 2 passed and 0 skipped: `runChildVitest` already refuses a
      skipped child and requires the exact passing count.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "authority-bootstrap-orchestration.db.test.ts"),
      "Meta authority bootstrap orchestration DB seam check",
      2,
    );

    /*
      ROUND 22, ITEM 1. `provider_accounts.timezone` is the binding the Meta
      partition authority resolves the provider-local day from, and ordinary
      warehouse persistence used to overwrite it with whatever timezone the
      credential payload or a cached account snapshot carried. The seam above
      proves a real core sync no longer moves it; this one proves the three
      semantics underneath: an absent binding is still POPULATED, an existing
      one cannot be moved by an ordinary write, and an explicit fresh-profile
      reconciliation still can.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "provider-account-timezone-authority.db.test.ts"),
      "Provider account timezone binding authority check",
      5,
    );

    /*
      ROUND 23. The seam above proves WHO may move a timezone binding; this one
      proves the "fresh profile" that is allowed to is genuinely bound to the
      grant it was fetched under.

      Two real-database facts, neither of which survives inspection of code
      shape alone: a manual refresh whose credential predates the current
      connection generation is refused before the provider is called, and a
      reconnect cannot commit between the commit-time compare-and-set and the
      timezone write -- proven with two clients and a deterministic barrier
      placed exactly in that window.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "provider-account-generation-binding.db.test.ts"),
      "Provider account generation binding check",
      4,
    );

    /*
      ROUND 24. The in-process refresh coalescer used to store a bare promise
      keyed by business/provider, and a joiner absorbed its rejection -- so a
      failed refresh was re-read and relabelled `source: "live"`,
      `sourceHealth: "fresh"`, `trustLevel: "safe"` by the caller, and a caller
      holding a credential from a NEWER generation adopted an older
      generation's outcome without ever reaching the durable refusal.

      Proven through the public entry points against a real database, because
      what is at stake is what those entry points RETURN under concurrency.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "provider-account-refresh-coalescing.db.test.ts"),
      "Provider account refresh coalescing check",
      4,
    );

    /*
      ROUND 18, ITEM C13. `SET lock_timeout` and the DDL it bounds must be the
      same backend: the migration ran through the POOL, so serialisation was not
      affinity and the setting could apply to a session that then did no work.
      Both facts here are about backends rather than code text.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "migration-pinned-session.db.test.ts"),
      "Migration pinned-session backend check",
      5,
    );

    /*
      ROUND 19, ITEMS C5/C6/C7. The legacy occurrence key must never be
      recreated (it 23505s against multi-attempt receipts), every physical
      capacity refusal must be non-overridable, and the lock bound must be
      verified on the pinned backend against the RAW millisecond value.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "migration-safety-contract.db.test.ts"),
      "Migration safety contract DB seam check",
      10,
    );

    /*
      ROUND 20, ITEM 3. The pinned-session check above proves the LEASE HELPER
      keeps one backend; it cannot see the defect this file closes, because the
      escape happened downstream of the helper, inside `runMigrations`:
      `runNativeAdSchemaMigrations` opened `runDbTransaction`, which leases its
      own client, so the whole native-ad schema group ran on a second backend
      the proven `lock_timeout` had never touched.

      This drives the REAL `runMigrations` from zero against a scratch database
      and asks PostgreSQL -- through a `ddl_command_end` event trigger, which
      fires inside the executing backend -- which sessions ran DDL. It also
      proves the three fail-closed aborts reach NO DDL at all.

      ROUND 21, ITEM 2 added the other half of the same subject: the run must
      also RELEASE that lease before the post-migration verifier, which brings
      its own pooled and transactional clients. Held together they deadlocked
      the run against itself under the supported `DB_POOL_MAX=1`. Two further
      cases here prove a real one-connection migration completes, and that a
      failing verifier still prevents completion.
    */
    await runChildVitest(
      repoRoot,
      databaseUrl,
      path.join("lib", "meta", "migration-ddl-session-boundedness.db.test.ts"),
      "Migration DDL session boundedness check",
      6,
    );

    // The null-versus-zero contract rests on a claim about the SCHEMA — that a
    // NULL column and an absent payload key are still distinguishable from a
    // measured 0 after the read. In memory that claim is unfalsifiable, so it
    // is proven here against the migrated tables and then carried through the
    // real producer chain to the API row.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-creative-null-presence-seam-child.ts",
      ),
      "creative null-versus-zero presence DB seam check",
    );

    // Production-seam checks against the freshly migrated schema: real
    // write query -> real reader, the class of defect in-memory tests miss.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-seam-child.ts"),
      "hysteresis DB seam check",
    );
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-meta-store-seam-child.ts"),
      "launchpad meta-store DB seam check",
    );
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-creative-brief-seam-child.ts"),
      "creative brief DB seam check",
    );
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-launch-intent-seam-child.ts"),
      "launch intent DB seam check",
    );
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-automation-control-plane-seam-child.ts",
      ),
      "automation control-plane DB seam check",
    );

    log("PASS: migrations build the schema from zero and are idempotent.");
  } catch (error) {
    if (fs.existsSync(logFile)) {
      const logTail = fs
        .readFileSync(logFile, "utf8")
        .split(/\r?\n/)
        .slice(-40)
        .join("\n");
      console.error(`[migrations-from-zero] postgres log tail:\n${logTail}`);
    }
    throw error;
  } finally {
    if (serverStarted) {
      const stop = spawnSync(
        path.join(pgBinDir, "pg_ctl"),
        ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
        { encoding: "utf8" },
      );
      if (stop.status !== 0) {
        console.error(
          `[migrations-from-zero] warning: pg_ctl stop exited with ${stop.status}: ${stop.stderr?.trim() ?? ""}`,
        );
      } else {
        log("ephemeral server stopped.");
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    log(`temp dir removed: ${tempDir}`);
    if (previousIntegrationTokenEncryptionKey === undefined) {
      delete process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
        previousIntegrationTokenEncryptionKey;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
