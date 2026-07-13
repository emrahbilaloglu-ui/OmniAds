/**
 * Ephemeral-Postgres "migrations from zero" verification.
 *
 * Boots a throwaway PostgreSQL 16 cluster (Homebrew binaries, no Docker) in an
 * OS temp directory on a random free port, creates an empty database, runs the
 * repo's real deploy migration entry point (scripts/run-migrations.ts →
 * lib/migrations.ts runMigrations) against it twice — first run must build the
 * full schema from zero, second run must exit clean to prove idempotency —
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
import { inspectAdOperatorResponseSchemaCapability } from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import { createControlledExperimentRegistryStore } from "@/lib/meta/controlled-experiment-registry";

const FORBIDDEN_PORTS = new Set([15432, 5432]);
const EPHEMERAL_DB_NAME = "adsecute_migrations_from_zero";
const EPHEMERAL_DB_USER = "postgres";
const REQUIRED_TABLES = [
  "engine_v3_decision_snapshots_daily",
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
] as const;
const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "engine_v3_decision_snapshots_daily", column: "raw_label" },
  {
    table: "engine_v3_decision_snapshots_daily",
    column: "blocked_action_type",
  },
  { table: "engine_v3_decision_snapshots_daily", column: "evaluation_id" },
  { table: "engine_v3_decision_snapshots_daily", column: "input_hash" },
  { table: "engine_v3_decision_snapshots_daily", column: "decision_hash" },
  { table: "engine_v3_decision_evaluation_contexts", column: "business_ref_id" },
  { table: "engine_v3_decision_evaluation_contexts", column: "as_of_date" },
  { table: "engine_v3_decision_evaluation_contexts", column: "engine_version" },
  { table: "engine_v3_decision_evaluation_contexts", column: "scope_type" },
  { table: "engine_v3_decision_evaluation_contexts", column: "scope_id" },
  { table: "engine_v3_decision_evaluation_contexts", column: "contract_version" },
  { table: "engine_v3_decision_evaluation_contexts", column: "context_json" },
  { table: "engine_v3_decision_evaluation_contexts", column: "account_profile_json" },
  { table: "engine_v3_decision_evaluation_contexts", column: "data_health_json" },
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
    column: "idempotency_key",
  },
  { table: "meta_ads_action_log", column: "decision_episode_key" },
  { table: "meta_ads_action_log", column: "decision_snapshot_id" },
  { table: "meta_ads_action_log", column: "decision_evaluation_id" },
  { table: "meta_ads_action_log", column: "terminal_finalized_at" },
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
const REQUIRED_CONSTRAINTS: ReadonlyArray<{
  table: string;
  constraint: string;
  type: "c" | "f" | "u";
  deleteAction?: "r";
}> = [
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
] as const;

const REQUIRED_TRIGGERS = [
  "engine_v3_native_ad_calibration_batch_immutable_trigger",
  "engine_v3_native_ad_calibration_cell_immutable_trigger",
  "engine_v3_ad_operator_action_receipts_immutable",
  "trg_engine_v3_ad_outcomes_immutable",
  "trg_meta_controlled_seed_reveal_guard",
  "trg_meta_ads_action_log_controlled_verified_immutable",
] as const;

function log(message: string) {
  console.log(`[migrations-from-zero] ${message}`);
}

function resolvePgBinDir(): string {
  const required = ["initdb", "pg_ctl", "postgres"];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of candidates) {
    if (required.every((binary) => fs.existsSync(path.join(dir, binary)))) {
      return dir;
    }
  }
  throw new Error(
    `PostgreSQL binaries (${required.join(", ")}) not found in any of: ${candidates.join(", ")}. ` +
      "Install postgresql@16 via Homebrew or set EPHEMERAL_PG_BIN_DIR.",
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
  const result = spawnSync(command, args, { encoding: "utf8", env: PG_TOOL_ENV });
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
  const child = spawn(
    process.execPath,
    ["--import", "tsx", scriptPath],
    {
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
      throw new Error("Migration capability checks use parameterized query only.");
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

    for (const { table, constraint, type, deleteAction } of REQUIRED_CONSTRAINTS) {
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

async function assertDecisionEvaluationProvenance(databaseUrl: string): Promise<void> {
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
    if (!businessId) throw new Error("Could not create provenance-check business.");

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
      if (!contextId) throw new Error("Could not create provenance-check context.");
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
      throw new Error("Same-day rerun uniqueness did not preserve two jobs while deduping one retry.");
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
        [contextId, businessId, inputHash, decisionHash, index === 0 ? firstJobId : secondJobId],
      );
      const evaluationId = evaluationResult.rows[0]?.id;
      if (!evaluationId) throw new Error("Could not create provenance-check evaluation.");
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
      throw new Error("Composite context lineage FK accepted a mismatched job run.");
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
      await client.query(`DELETE FROM engine_v3_decision_evaluations WHERE id = $1`, [
        evaluationIds[0],
      ]);
      throw new Error("Snapshot evaluation FK allowed authoritative provenance deletion.");
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-ephemeral-pg-"));
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
      ["-D", dataDir, "-U", EPHEMERAL_DB_USER, "--auth=trust", "--encoding=UTF8", "--no-locale"],
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
      ["-h", "127.0.0.1", "-p", String(port), "-U", EPHEMERAL_DB_USER, EPHEMERAL_DB_NAME],
      "createdb",
    );

    // Two separate child processes: lib/migrations.ts keeps module-level
    // "already completed" state, so in-process re-runs would be no-ops and
    // prove nothing about idempotency.
    await runMigrationsChild(repoRoot, databaseUrl, "run 1: from zero");
    const run1Tables = await assertSchema(databaseUrl);
    await runMigrationsChild(repoRoot, databaseUrl, "run 2: idempotency");
    const run2Tables = await assertSchema(databaseUrl);
    reportConvergenceGap(run1Tables, run2Tables);
    await assertDecisionEvaluationProvenance(databaseUrl);

    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-entity-state-history-seam-child.ts"),
      "entity state history DB seam check",
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

    log("PASS: migrations build the schema from zero and are idempotent.");
  } catch (error) {
    if (fs.existsSync(logFile)) {
      const logTail = fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-40).join("\n");
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
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
