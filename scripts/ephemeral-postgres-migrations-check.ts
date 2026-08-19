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
  NATIVE_DECISION_RUNNING_GRACE_MS,
  READ_NATIVE_DECISION_GENERATION_QUERY,
} from "@/lib/meta/decisions-workspace-read-model";
import { createControlledExperimentRegistryStore } from "@/lib/meta/controlled-experiment-registry";

const FORBIDDEN_PORTS = new Set([15432, 5432]);
const EPHEMERAL_DB_NAME = "adsecute_migrations_from_zero";
const EPHEMERAL_DB_USER = "postgres";
const REQUIRED_TABLES = [
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
// ("postmaster became multithreaded during startup").
const PG_TOOL_ENV = { ...process.env, LC_ALL: "C" };

function runSync(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: PG_TOOL_ENV,
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
        job_status: string;
        job_run_id: string;
        as_of_date: string;
      }>(READ_NATIVE_DECISION_GENERATION_QUERY, [
        businessId,
        "act_seam",
        AD_DECISIONS_JOB_NAME,
        asOf,
        NATIVE_DECISION_RUNNING_GRACE_MS,
      ]);

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
    if (
      historical.rows[0]?.job_run_id !== d1Success ||
      historical.rows[0]?.job_status !== "success" ||
      current.rows[0]?.job_run_id !== d2Failure ||
      current.rows[0]?.job_status !== "failed"
    ) {
      throw new Error(
        "Newer native failure did not invalidate the older success.",
      );
    }

    const staleRunning = await insertRun({
      asOf: "2026-07-12",
      status: "running",
      startedOffsetSeconds: -(NATIVE_DECISION_RUNNING_GRACE_MS / 1000 + 60),
    });
    const stale = await readGeneration("2026-07-12");
    if (
      stale.rows[0]?.job_run_id !== staleRunning ||
      stale.rows[0]?.job_status !== "failed"
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
      overlapped.rows[0]?.job_run_id !== holder ||
      overlapped.rows[0]?.job_status !== "success"
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
      isolated.rows[0]?.job_run_id !== isolatedSkip ||
      isolated.rows[0]?.job_status !== "skipped"
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
      crossEpoch.rows[0]?.job_run_id !== crossEpochFailure ||
      crossEpoch.rows[0]?.job_status !== "failed"
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

    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join(
        "scripts",
        "ephemeral-postgres-duplicate-ad-reconciliation-seam-child.ts",
      ),
      "duplicate-ad reconciliation DB seam check",
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
