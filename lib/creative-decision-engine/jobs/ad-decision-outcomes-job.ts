import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import * as controlledExperimentRegistry from "@/lib/meta/controlled-experiment-registry";
import {
  CONTROLLED_HYDRATION_VERSION,
  ControlledRegistrySchemaError,
  type ReadControlledEvidenceInput,
} from "@/lib/meta/controlled-experiment-registry";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import {
  assertExactMetaAdsActionReceiptForEpisode,
  buildAdRecommendationEpisode,
  NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION,
  type ExactMetaAdsActionLineage,
} from "../ad-operator-response-detection";
import { canonicalSha256 } from "../canonical-evaluation";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "../execution-safety";
import { NATIVE_AD_ENGINE_VERSION, type DecisionLabel } from "../types";
import { hashAdvisoryLock } from "./calibration-job";
import { engineV3JobsDisabled } from "./job-switch";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";

export const AD_DECISION_OUTCOMES_JOB_NAME =
  "engine_v3_ad_decision_outcomes_job";
export const AD_DECISION_OUTCOMES_TABLE =
  "engine_v3_ad_decision_outcomes_daily";
export const AD_DECISION_OUTCOME_RUNS_TABLE =
  "engine_v3_ad_decision_outcome_runs";
export const AD_DECISION_OUTCOME_PUBLICATIONS_TABLE =
  "engine_v3_ad_decision_outcome_publications";
export const AD_DECISION_OUTCOME_CONTRACT_VERSION =
  "engine-v3-ad-decision-outcome.v1";
export const AD_DECISION_OUTCOME_CLASSIFIER_VERSION =
  "engine-v3-ad-outcome-classifier.v1";
export const AD_DECISION_CONTROLLED_LINEAGE_VERSION =
  "engine-v3-ad-controlled-outcome-lineage.v1";
export const AD_DECISION_OUTCOME_WINDOWS_DAYS = [3, 7, 14] as const;
export const AD_DECISION_OUTCOME_LOOKBACK_DAYS = 120;
export const AD_DECISION_OUTCOME_BATCH_LIMIT = 5_000;
export const AD_DECISION_OUTCOME_DAILY_UTC_HOUR = 4;
export const AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR = 5;
export const AD_DECISION_CONTROLLED_REC_TYPES = [
  "engine_v3_ad_decision",
] as const;

export type AdDecisionOutcomeWindowDays =
  (typeof AD_DECISION_OUTCOME_WINDOWS_DAYS)[number];
export type AdDecisionOutcomeMeasurementStatus =
  "known" | "unknown" | "censored" | "explained_zero_spend";
export type AdDecisionOutcomeTreatmentStatus =
  | "observational_untreated"
  | "observational_action_exposed"
  | "controlled_treatment";
export type AdDecisionRealizedOutcome =
  "positive" | "negative" | "neutral" | "unknown";
export type AdDecisionOutcomeSeverity = "critical" | "high" | "medium" | "low";

export const AD_DECISION_OUTCOME_SCHEMA_REQUIREMENTS = {
  table: AD_DECISION_OUTCOMES_TABLE,
  columns: [
    "id",
    "contract_version",
    "classifier_version",
    "decision_snapshot_id",
    "evaluation_id",
    "source_decision_job_run_id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "creative_id",
    "decision_as_of_date",
    "evaluation_date",
    "source_cutoff_at",
    "outcome_window_days",
    "outcome_window_start",
    "outcome_window_end",
    "engine_version",
    "scope_type",
    "scope_id",
    "label",
    "raw_label",
    "confidence",
    "effective_target_roas",
    "target_roas",
    "break_even_roas",
    "account_currency",
    "currency_status",
    "effective_cohort",
    "objective",
    "optimization_goal",
    "custom_event_type",
    "commercial_context_json",
    "cohort_context_json",
    "baseline_spend",
    "baseline_purchases",
    "baseline_roas",
    "outcome_spend",
    "outcome_purchases",
    "outcome_revenue",
    "outcome_roas",
    "expected_day_count",
    "completed_day_count",
    "window_complete",
    "measurement_status",
    "realized_outcome",
    "severity",
    "treatment_status",
    "action_contaminated",
    "controlled_registry_available",
    "treatment_receipt_validated",
    "causal_assignment_validated",
    "causal_estimate_validated",
    "controlled_evidence_validated",
    "source_input_hash",
    "source_decision_hash",
    "ad_publication_receipts_hash",
    "fact_source_hash",
    "action_source_hash",
    "state_source_hash",
    "controlled_source_hash",
    "source_manifest_hash",
    "source_receipts_json",
    "controlled_evidence_json",
    "evidence_json",
    "outcome_run_id",
    "job_run_id",
    "source_set_hash",
    "computed_at",
    "created_at",
  ],
  constraints: [
    "engine_v3_ad_outcomes_native_identity_check",
    "engine_v3_ad_outcomes_business_identity_check",
    "engine_v3_ad_outcomes_account_scope_check",
    "engine_v3_ad_outcomes_account_binding_fk",
    "engine_v3_ad_outcomes_window_check",
    "engine_v3_ad_outcomes_completeness_check",
    "engine_v3_ad_outcomes_measurement_check",
    "engine_v3_ad_outcomes_treatment_check",
    "engine_v3_ad_outcomes_source_hash_check",
    "engine_v3_ad_outcomes_snapshot_fk",
    "engine_v3_ad_outcomes_evaluation_fk",
    "engine_v3_ad_outcomes_run_fk",
    "engine_v3_ad_outcomes_run_lineage_fk",
    "engine_v3_ad_outcomes_job_run_fk",
    "engine_v3_ad_outcomes_run_episode_unique",
  ],
  indexes: [
    "idx_engine_v3_ad_outcomes_business_window",
    "idx_engine_v3_ad_outcomes_native_timeline",
    "idx_engine_v3_ad_outcomes_evaluation",
    "idx_engine_v3_ad_outcomes_run",
  ],
  triggers: ["trg_engine_v3_ad_outcomes_immutable"],
} as const;

export const AD_DECISION_OUTCOME_RUN_SCHEMA_REQUIREMENTS = {
  table: AD_DECISION_OUTCOME_RUNS_TABLE,
  columns: [
    "id",
    "job_run_id",
    "business_ref_id",
    "business_id",
    "evaluation_date",
    "engine_version",
    "contract_version",
    "classifier_version",
    "windows_days",
    "lookback_days",
    "candidate_row_count",
    "persisted_row_count",
    "window_counts_json",
    "source_set_hash",
    "status",
    "started_at",
    "completed_at",
    "created_at",
  ],
  constraints: [
    "engine_v3_ad_outcome_runs_job_fk",
    "engine_v3_ad_outcome_runs_business_fk",
    "engine_v3_ad_outcome_runs_identity_unique",
    "engine_v3_ad_outcome_runs_publication_lineage_unique",
    "engine_v3_ad_outcome_runs_completeness_check",
  ],
  indexes: ["idx_engine_v3_ad_outcome_runs_business_date"],
  triggers: ["trg_engine_v3_ad_outcome_runs_complete_immutable"],
} as const;

export const AD_DECISION_OUTCOME_PUBLICATION_SCHEMA_REQUIREMENTS = {
  table: AD_DECISION_OUTCOME_PUBLICATIONS_TABLE,
  columns: [
    "business_ref_id",
    "business_id",
    "evaluation_date",
    "outcome_window_days",
    "engine_version",
    "contract_version",
    "classifier_version",
    "active_job_run_id",
    "active_outcome_run_id",
    "source_set_hash",
    "published_at",
    "created_at",
    "updated_at",
  ],
  constraints: [
    "engine_v3_ad_outcome_publications_business_fk",
    "engine_v3_ad_outcome_publications_run_fk",
    "engine_v3_ad_outcome_publications_run_lineage_fk",
    "engine_v3_ad_outcome_publications_identity_unique",
    "engine_v3_ad_outcome_publications_window_check",
  ],
  indexes: ["idx_engine_v3_ad_outcome_publications_active_run"],
  triggers: [],
} as const;

export const AD_DECISION_OUTCOME_SOURCE_SCHEMA_REQUIREMENTS = {
  engine_v3_job_runs: [
    "id",
    "job_name",
    "business_ref_id",
    "business_id",
    "as_of_date",
    "engine_version",
    "status",
    "started_at",
    "finished_at",
    "duration_ms",
    "row_count",
    "input_hash",
    "error_code",
    "error_message",
    "error_json",
    "updated_at",
  ],
  engine_v3_ad_decision_snapshots_daily: [
    "id",
    "evaluation_id",
    "job_run_id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "creative_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "label",
    "raw_label",
    "confidence",
    "effective_target_roas",
    "spend",
    "purchases",
    "roas",
    "input_hash",
    "decision_hash",
    "idempotency_key",
    "computed_at",
  ],
  engine_v3_ad_decision_evaluations: [
    "id",
    "contract_version",
    "job_run_id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "creative_input_json",
    "campaign_context_json",
    "input_hash",
    "decision_hash",
    "evaluated_at",
  ],
  meta_ad_daily: [
    "id",
    "business_ref_id",
    "provider_account_id",
    "provider_account_ref_id",
    "date",
    "ad_id",
    "account_currency",
    "spend",
    "conversions",
    "revenue",
    "truth_state",
    "truth_version",
    "finalized_at",
    "validation_status",
    "source_run_id",
    "source_snapshot_id",
    "metric_schema_version",
    "updated_at",
  ],
  meta_authoritative_publication_pointers: [
    "id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "day",
    "surface",
    "active_slice_version_id",
    "published_at",
  ],
  meta_authoritative_slice_versions: [
    "id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "day",
    "surface",
    "manifest_id",
    "state",
    "truth_state",
    "validation_status",
    "status",
    "source_run_id",
    "published_at",
  ],
  engine_v3_ad_recommendation_episodes: [
    "id",
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "ad_id",
    "creative_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "decision_snapshot_id",
    "evaluation_id",
    "input_hash",
    "decision_hash",
    "decision_label",
    "source_campaign_id",
    "source_adset_id",
    "recommended_at",
  ],
  engine_v3_ad_operator_action_receipts: [
    "id",
    "receipt_hash",
    "source_action_log_id",
    "contract_version",
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "source_ad_id",
    "source_snapshot_id",
    "source_evaluation_id",
    "source_engine_version",
    "source_decision_hash",
    "target_entity_type",
    "target_entity_id",
    "operator_action",
    "successor_kind",
    "resulting_ad_id",
    "idempotency_key",
    "action_status",
    "dry_run",
    "provider_verified",
    "requested_at",
    "verified_at",
    "finalized_at",
    "captured_at",
    "verification_entity_id",
    "verification_status",
    "created_at",
  ],
  meta_entity_state_history: [
    "id",
    "business_ref_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "entity_id",
    "configured_status",
    "effective_status",
    "presence",
    "observed_at",
    "captured_at",
    "run_completeness",
    "state_hash",
  ],
  business_provider_accounts: [
    "business_id",
    "provider",
    "provider_account_ref_id",
    "provider_account_id",
  ],
} as const;

export interface AdDecisionOutcomeSchemaCapability {
  ready: boolean;
  missing: string[];
}

type SchemaColumnRow = Record<string, unknown> & {
  table_name: unknown;
  column_name: unknown;
  data_type: unknown;
  udt_name: unknown;
  is_nullable: unknown;
  character_maximum_length: unknown;
};

export async function inspectAdDecisionOutcomeSchemaCapability(
  db: DbClient = getDb(),
): Promise<AdDecisionOutcomeSchemaCapability> {
  const requiredColumns: Record<string, readonly string[]> = {
    [AD_DECISION_OUTCOMES_TABLE]:
      AD_DECISION_OUTCOME_SCHEMA_REQUIREMENTS.columns,
    [AD_DECISION_OUTCOME_RUNS_TABLE]:
      AD_DECISION_OUTCOME_RUN_SCHEMA_REQUIREMENTS.columns,
    [AD_DECISION_OUTCOME_PUBLICATIONS_TABLE]:
      AD_DECISION_OUTCOME_PUBLICATION_SCHEMA_REQUIREMENTS.columns,
    ...AD_DECISION_OUTCOME_SOURCE_SCHEMA_REQUIREMENTS,
  };
  const tableNames = Object.keys(requiredColumns);
  const triggerFunctionNames = [
    "reject_engine_v3_ad_outcome_mutation",
    "reject_complete_engine_v3_ad_outcome_run_mutation",
    "reject_engine_v3_ad_operator_action_receipt_mutation",
  ];
  const [columns, constraints, indexes, triggers, triggerFunctions] =
    await Promise.all([
      db.query<SchemaColumnRow>(
        `
      SELECT table_name, column_name, data_type, udt_name, is_nullable,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      `,
        [tableNames],
      ),
      db.query<Record<string, unknown>>(
        `
      SELECT relation.relname AS table_name,
        constraint_row.conname AS constraint_name,
        constraint_row.contype AS constraint_type,
        pg_get_constraintdef(constraint_row.oid, true) AS constraint_definition
      FROM pg_constraint constraint_row
      INNER JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      INNER JOIN pg_namespace namespace_row
        ON namespace_row.oid = relation.relnamespace
      WHERE namespace_row.nspname = current_schema()
        AND relation.relname = ANY($1::text[])
      `,
        [tableNames],
      ),
      db.query<Record<string, unknown>>(
        `
      SELECT tablename AS table_name, indexname AS index_name,
        indexdef AS index_definition
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = ANY($1::text[])
      `,
        [tableNames],
      ),
      db.query<Record<string, unknown>>(
        `
      SELECT relation.relname AS table_name, trigger_row.tgname AS trigger_name,
        pg_get_triggerdef(trigger_row.oid, true) AS trigger_definition
      FROM pg_trigger trigger_row
      INNER JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      INNER JOIN pg_namespace namespace_row
        ON namespace_row.oid = relation.relnamespace
      WHERE namespace_row.nspname = current_schema()
        AND NOT trigger_row.tgisinternal
        AND relation.relname = ANY($1::text[])
      `,
        [tableNames],
      ),
      db.query<Record<string, unknown>>(
        `
      SELECT procedure_row.proname AS function_name,
        pg_get_functiondef(procedure_row.oid) AS function_definition
      FROM pg_proc procedure_row
      INNER JOIN pg_namespace namespace_row
        ON namespace_row.oid = procedure_row.pronamespace
      WHERE namespace_row.nspname = current_schema()
        AND procedure_row.proname = ANY($1::text[])
      `,
        [triggerFunctionNames],
      ),
    ]);
  const columnMap = new Map(
    columns.map((row) => [
      `${String(row.table_name)}.${String(row.column_name)}`,
      row,
    ]),
  );
  const missing: string[] = [];
  for (const [table, names] of Object.entries(requiredColumns)) {
    for (const name of names) {
      if (!columnMap.has(`${table}.${name}`)) missing.push(`${table}.${name}`);
    }
  }
  for (const [table, column, nullable] of [
    [AD_DECISION_OUTCOMES_TABLE, "creative_id", "YES"],
    [AD_DECISION_OUTCOMES_TABLE, "provider_account_ref_id", "NO"],
    [AD_DECISION_OUTCOMES_TABLE, "source_decision_job_run_id", "NO"],
    [AD_DECISION_OUTCOMES_TABLE, "source_cutoff_at", "NO"],
    [AD_DECISION_OUTCOMES_TABLE, "outcome_run_id", "NO"],
    [AD_DECISION_OUTCOMES_TABLE, "source_set_hash", "NO"],
    [AD_DECISION_OUTCOME_RUNS_TABLE, "persisted_row_count", "YES"],
    [AD_DECISION_OUTCOME_RUNS_TABLE, "completed_at", "YES"],
    [AD_DECISION_OUTCOME_PUBLICATIONS_TABLE, "active_job_run_id", "NO"],
    [AD_DECISION_OUTCOME_PUBLICATIONS_TABLE, "active_outcome_run_id", "NO"],
  ] as const) {
    const row = columnMap.get(`${table}.${column}`);
    if (row && String(row.is_nullable) !== nullable) {
      missing.push(`${table}.${column}.nullable_${nullable.toLowerCase()}`);
    }
  }
  for (const [table, column, dataType, length] of [
    [AD_DECISION_OUTCOMES_TABLE, "outcome_run_id", "uuid", null],
    [AD_DECISION_OUTCOMES_TABLE, "source_decision_job_run_id", "uuid", null],
    [AD_DECISION_OUTCOMES_TABLE, "provider_account_ref_id", "uuid", null],
    [AD_DECISION_OUTCOMES_TABLE, "source_set_hash", "character", 64],
    [
      AD_DECISION_OUTCOMES_TABLE,
      "source_cutoff_at",
      "timestamp with time zone",
      null,
    ],
    [AD_DECISION_OUTCOME_RUNS_TABLE, "id", "uuid", null],
    [AD_DECISION_OUTCOME_RUNS_TABLE, "windows_days", "array", null],
    [AD_DECISION_OUTCOME_RUNS_TABLE, "source_set_hash", "character", 64],
    [
      AD_DECISION_OUTCOME_PUBLICATIONS_TABLE,
      "active_outcome_run_id",
      "uuid",
      null,
    ],
    [AD_DECISION_OUTCOME_PUBLICATIONS_TABLE, "active_job_run_id", "uuid", null],
    ["engine_v3_ad_operator_action_receipts", "id", "uuid", null],
    ["engine_v3_ad_operator_action_receipts", "receipt_hash", "character", 64],
    [
      "engine_v3_ad_operator_action_receipts",
      "source_action_log_id",
      "uuid",
      null,
    ],
    ["engine_v3_ad_operator_action_receipts", "episode_key", "character", 64],
    [
      "engine_v3_ad_operator_action_receipts",
      "provider_account_ref_id",
      "uuid",
      null,
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "source_snapshot_id",
      "uuid",
      null,
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "source_evaluation_id",
      "uuid",
      null,
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "source_decision_hash",
      "character",
      64,
    ],
  ] as const) {
    const row = columnMap.get(`${table}.${column}`);
    if (
      row &&
      (String(row.data_type).toLowerCase() !== dataType ||
        (length !== null && Number(row.character_maximum_length) !== length))
    ) {
      missing.push(`${table}.${column}.type_${dataType}`);
    }
  }
  const normalizedDefinition = (value: unknown) =>
    String(value ?? "")
      .toLowerCase()
      .replaceAll('"', "")
      .replace(/\s+/g, " ")
      .trim();
  const availableConstraints = new Map(
    constraints.map((row) => [
      `${String(row.table_name)}.${String(row.constraint_name)}`,
      {
        type: String(row.constraint_type),
        definition: normalizedDefinition(row.constraint_definition),
      },
    ]),
  );
  for (const contract of [
    AD_DECISION_OUTCOME_SCHEMA_REQUIREMENTS,
    AD_DECISION_OUTCOME_RUN_SCHEMA_REQUIREMENTS,
    AD_DECISION_OUTCOME_PUBLICATION_SCHEMA_REQUIREMENTS,
  ]) {
    for (const name of contract.constraints) {
      if (!availableConstraints.has(`${contract.table}.${name}`)) {
        missing.push(`${contract.table}.${name}`);
      }
    }
  }
  for (const [table, name] of [
    [
      "engine_v3_ad_recommendation_episodes",
      "engine_v3_ad_response_episode_snapshot_fk",
    ],
    [
      "engine_v3_ad_recommendation_episodes",
      "engine_v3_ad_response_episode_evaluation_fk",
    ],
    [
      "engine_v3_ad_recommendation_episodes",
      "engine_v3_ad_response_episode_account_binding_fk",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_action_receipt_episode_lineage_fk",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_action_receipt_account_binding_fk",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_action_receipt_action_log_fk",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_action_receipt_time_check",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_action_receipt_verification_check",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_action_receipt_successor_check",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_action_receipt_contract_action_check",
    ],
  ] as const) {
    if (!availableConstraints.has(`${table}.${name}`)) {
      missing.push(`${table}.${name}`);
    }
  }
  const constraintDefinitions: Array<{
    table: string;
    name: string;
    type: "c" | "f" | "u";
    fragments: string[];
  }> = [
    {
      table: AD_DECISION_OUTCOME_RUNS_TABLE,
      name: "engine_v3_ad_outcome_runs_job_fk",
      type: "f",
      fragments: [
        "foreign key (job_run_id)",
        "references engine_v3_job_runs(id)",
        "on delete restrict",
      ],
    },
    {
      table: AD_DECISION_OUTCOME_RUNS_TABLE,
      name: "engine_v3_ad_outcome_runs_completeness_check",
      type: "c",
      fragments: [
        "windows_days",
        "persisted_row_count = candidate_row_count",
        "status = 'complete'",
      ],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_native_identity_check",
      type: "c",
      fragments: ["decision_entity_type = 'ad'", "decision_entity_id = ad_id"],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_business_identity_check",
      type: "c",
      fragments: ["business_id = business_ref_id::text"],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_account_scope_check",
      type: "c",
      fragments: ["scope_type = 'account'", "scope_id = provider_account_id"],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_account_binding_fk",
      type: "f",
      fragments: [
        "business_id, provider_account_ref_id, provider_account_id",
        "references business_provider_accounts",
        "on delete restrict",
      ],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_window_check",
      type: "c",
      fragments: [
        "outcome_window_days",
        "outcome_window_end = (evaluation_date - 1)",
        "outcome_window_end < evaluation_date",
        "source_cutoff_at",
      ],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_snapshot_fk",
      type: "f",
      fragments: [
        "decision_snapshot_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id",
        "source_decision_job_run_id",
        "references engine_v3_ad_decision_snapshots_daily",
        "on delete restrict",
      ],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_evaluation_fk",
      type: "f",
      fragments: [
        "evaluation_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id",
        "source_input_hash, source_decision_hash, source_decision_job_run_id",
        "references engine_v3_ad_decision_evaluations",
        "on delete restrict",
      ],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_treatment_check",
      type: "c",
      fragments: [
        "controlled_treatment",
        "causal_assignment_validated",
        "causal_estimate_validated",
      ],
    },
    {
      table: AD_DECISION_OUTCOMES_TABLE,
      name: "engine_v3_ad_outcomes_run_lineage_fk",
      type: "f",
      fragments: [
        "foreign key (outcome_run_id, job_run_id",
        "references engine_v3_ad_decision_outcome_runs",
        "on delete restrict",
      ],
    },
    {
      table: AD_DECISION_OUTCOME_PUBLICATIONS_TABLE,
      name: "engine_v3_ad_outcome_publications_run_lineage_fk",
      type: "f",
      fragments: [
        "active_outcome_run_id, active_job_run_id",
        "references engine_v3_ad_decision_outcome_runs",
        "on delete restrict",
      ],
    },
    {
      table: "engine_v3_ad_operator_action_receipts",
      name: "engine_v3_ad_action_receipt_episode_lineage_fk",
      type: "f",
      fragments: [
        "episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id",
        "source_snapshot_id, source_evaluation_id, source_engine_version, source_decision_hash",
        "references engine_v3_ad_recommendation_episodes",
        "on delete restrict",
      ],
    },
    {
      table: "engine_v3_ad_operator_action_receipts",
      name: "engine_v3_ad_action_receipt_time_check",
      type: "c",
      fragments: [
        "finalized_at >= requested_at",
        "captured_at >= finalized_at",
        "verified_at >= requested_at",
      ],
    },
    {
      table: "engine_v3_ad_operator_action_receipts",
      name: "engine_v3_ad_action_receipt_verification_check",
      type: "c",
      fragments: [
        "provider_verified",
        "action_status = 'success'",
        "dry_run",
        "verified_at is not null",
      ],
    },
  ];
  for (const requirement of constraintDefinitions) {
    const actual = availableConstraints.get(
      `${requirement.table}.${requirement.name}`,
    );
    if (
      actual &&
      (actual.type !== requirement.type ||
        requirement.fragments.some(
          (fragment) => !actual.definition.includes(fragment),
        ))
    ) {
      missing.push(`${requirement.table}.${requirement.name}.definition`);
    }
  }
  const availableIndexes = new Map(
    indexes.map((row) => [
      `${String(row.table_name)}.${String(row.index_name)}`,
      normalizedDefinition(row.index_definition),
    ]),
  );
  for (const contract of [
    AD_DECISION_OUTCOME_SCHEMA_REQUIREMENTS,
    AD_DECISION_OUTCOME_RUN_SCHEMA_REQUIREMENTS,
    AD_DECISION_OUTCOME_PUBLICATION_SCHEMA_REQUIREMENTS,
  ]) {
    for (const name of contract.indexes) {
      if (!availableIndexes.has(`${contract.table}.${name}`)) {
        missing.push(`${contract.table}.${name}`);
      }
    }
  }
  const receiptIndexDefinitions = Array.from(availableIndexes.entries())
    .filter(([key]) => key.startsWith("engine_v3_ad_operator_action_receipts."))
    .map(([, definition]) => definition);
  for (const column of ["receipt_hash", "source_action_log_id"] as const) {
    if (
      !receiptIndexDefinitions.some(
        (definition) =>
          definition.includes("create unique index") &&
          definition.includes(`(${column})`),
      )
    ) {
      missing.push(
        `engine_v3_ad_operator_action_receipts.${column}_unique_index`,
      );
    }
  }
  const receiptTimelineIndex = availableIndexes.get(
    "engine_v3_ad_operator_action_receipts.engine_v3_ad_action_receipts_timeline_idx",
  );
  if (
    !receiptTimelineIndex ||
    [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      "source_ad_id",
      "requested_at",
    ].some((fragment) => !receiptTimelineIndex.includes(fragment))
  ) {
    missing.push(
      "engine_v3_ad_operator_action_receipts.engine_v3_ad_action_receipts_timeline_idx",
    );
  }
  const availableTriggers = new Map(
    triggers.map((row) => [
      `${String(row.table_name)}.${String(row.trigger_name)}`,
      normalizedDefinition(row.trigger_definition),
    ]),
  );
  const availableTriggerFunctions = new Map(
    triggerFunctions.map((row) => [
      String(row.function_name),
      normalizedDefinition(row.function_definition),
    ]),
  );
  for (const [table, name, triggerFunction] of [
    [
      AD_DECISION_OUTCOMES_TABLE,
      "trg_engine_v3_ad_outcomes_immutable",
      "reject_engine_v3_ad_outcome_mutation",
    ],
    [
      AD_DECISION_OUTCOME_RUNS_TABLE,
      "trg_engine_v3_ad_outcome_runs_complete_immutable",
      "reject_complete_engine_v3_ad_outcome_run_mutation",
    ],
    [
      "engine_v3_ad_operator_action_receipts",
      "engine_v3_ad_operator_action_receipts_immutable",
      "reject_engine_v3_ad_operator_action_receipt_mutation",
    ],
  ] as const) {
    const definition = availableTriggers.get(`${table}.${name}`);
    if (!definition) {
      missing.push(`${table}.${name}`);
    } else if (
      !definition.includes(" before ") ||
      !definition.includes(" update ") ||
      !definition.includes(" delete ") ||
      !definition.includes("for each row execute function") ||
      !definition.includes(triggerFunction)
    ) {
      missing.push(`${table}.${name}.definition`);
    }
  }
  for (const [name, fragments] of [
    [
      "reject_engine_v3_ad_outcome_mutation",
      [
        "returns trigger",
        "raise exception",
        "outcomes_daily rows are immutable",
      ],
    ],
    [
      "reject_complete_engine_v3_ad_outcome_run_mutation",
      ["returns trigger", "old.status = 'complete'", "raise exception"],
    ],
    [
      "reject_engine_v3_ad_operator_action_receipt_mutation",
      ["returns trigger", "raise exception", "action_receipts is immutable"],
    ],
  ] as const) {
    const definition = availableTriggerFunctions.get(name);
    if (!definition) {
      missing.push(`function.${name}`);
    } else if (fragments.some((fragment) => !definition.includes(fragment))) {
      missing.push(`function.${name}.definition`);
    }
  }
  return { ready: missing.length === 0, missing: [...new Set(missing)].sort() };
}

export const CREATE_AD_DECISION_OUTCOMES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_outcome_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_run_id UUID NOT NULL,
  business_ref_id UUID NOT NULL,
  business_id TEXT NOT NULL,
  evaluation_date DATE NOT NULL,
  engine_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  windows_days INTEGER[] NOT NULL,
  lookback_days INTEGER NOT NULL CHECK (lookback_days > 0),
  candidate_row_count INTEGER NOT NULL CHECK (candidate_row_count >= 0),
  persisted_row_count INTEGER,
  window_counts_json JSONB NOT NULL CHECK (jsonb_typeof(window_counts_json) = 'object'),
  source_set_hash CHAR(64) NOT NULL CHECK (source_set_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_outcome_runs_job_fk FOREIGN KEY (job_run_id)
    REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcome_runs_business_fk FOREIGN KEY (business_ref_id)
    REFERENCES businesses(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcome_runs_identity_unique UNIQUE (
    job_run_id, business_ref_id, evaluation_date, engine_version,
    contract_version, classifier_version
  ),
  CONSTRAINT engine_v3_ad_outcome_runs_publication_lineage_unique UNIQUE (
    id, job_run_id, business_ref_id, business_id, evaluation_date,
    engine_version, contract_version, classifier_version, source_set_hash
  ),
  CONSTRAINT engine_v3_ad_outcome_runs_completeness_check CHECK (
    cardinality(windows_days) > 0
    AND windows_days <@ ARRAY[3, 7, 14]::integer[]
    AND (
      windows_days = ARRAY[3]::integer[]
      OR windows_days = ARRAY[7]::integer[]
      OR windows_days = ARRAY[14]::integer[]
      OR windows_days = ARRAY[3, 7]::integer[]
      OR windows_days = ARRAY[3, 14]::integer[]
      OR windows_days = ARRAY[7, 14]::integer[]
      OR windows_days = ARRAY[3, 7, 14]::integer[]
    )
    AND (
      (status = 'pending' AND persisted_row_count IS NULL AND completed_at IS NULL)
      OR
      (status = 'complete' AND persisted_row_count = candidate_row_count
       AND completed_at IS NOT NULL)
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_outcome_runs_business_date
  ON engine_v3_ad_decision_outcome_runs
  (business_ref_id, evaluation_date DESC, engine_version, completed_at DESC);

CREATE OR REPLACE FUNCTION reject_complete_engine_v3_ad_outcome_run_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'complete' THEN
    RAISE EXCEPTION 'complete engine_v3_ad_decision_outcome_runs rows are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_engine_v3_ad_outcome_runs_complete_immutable
  ON engine_v3_ad_decision_outcome_runs;
CREATE TRIGGER trg_engine_v3_ad_outcome_runs_complete_immutable
BEFORE UPDATE OR DELETE ON engine_v3_ad_decision_outcome_runs
FOR EACH ROW EXECUTE FUNCTION reject_complete_engine_v3_ad_outcome_run_mutation();

CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_outcome_publications (
  business_ref_id UUID NOT NULL,
  business_id TEXT NOT NULL,
  evaluation_date DATE NOT NULL,
  outcome_window_days INTEGER NOT NULL,
  engine_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  active_job_run_id UUID NOT NULL,
  active_outcome_run_id UUID NOT NULL,
  source_set_hash CHAR(64) NOT NULL CHECK (source_set_hash ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_outcome_publications_business_fk
    FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcome_publications_run_fk
    FOREIGN KEY (active_outcome_run_id)
    REFERENCES engine_v3_ad_decision_outcome_runs(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcome_publications_run_lineage_fk FOREIGN KEY (
    active_outcome_run_id, active_job_run_id, business_ref_id, business_id,
    evaluation_date, engine_version, contract_version, classifier_version,
    source_set_hash
  ) REFERENCES engine_v3_ad_decision_outcome_runs (
    id, job_run_id, business_ref_id, business_id, evaluation_date,
    engine_version, contract_version, classifier_version, source_set_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcome_publications_identity_unique UNIQUE (
    business_ref_id, evaluation_date, outcome_window_days, engine_version,
    contract_version, classifier_version
  ),
  CONSTRAINT engine_v3_ad_outcome_publications_window_check CHECK (
    outcome_window_days IN (3, 7, 14)
  )
);

CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_outcome_publications_active_run
  ON engine_v3_ad_decision_outcome_publications
  (active_outcome_run_id, outcome_window_days);

CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_outcomes_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  decision_snapshot_id UUID NOT NULL,
  evaluation_id UUID NOT NULL,
  source_decision_job_run_id UUID NOT NULL,
  business_ref_id UUID NOT NULL,
  business_id TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  decision_entity_type TEXT NOT NULL,
  decision_entity_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  creative_id TEXT,
  decision_as_of_date DATE NOT NULL,
  evaluation_date DATE NOT NULL,
  source_cutoff_at TIMESTAMPTZ NOT NULL,
  outcome_window_days INTEGER NOT NULL,
  outcome_window_start DATE NOT NULL,
  outcome_window_end DATE NOT NULL,
  engine_version TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  label TEXT NOT NULL,
  raw_label TEXT NOT NULL,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  effective_target_roas DOUBLE PRECISION NOT NULL,
  target_roas DOUBLE PRECISION,
  break_even_roas DOUBLE PRECISION,
  account_currency TEXT,
  currency_status TEXT NOT NULL CHECK (currency_status IN ('known', 'unknown', 'conflict')),
  effective_cohort TEXT,
  objective TEXT,
  optimization_goal TEXT,
  custom_event_type TEXT,
  commercial_context_json JSONB NOT NULL CHECK (jsonb_typeof(commercial_context_json) = 'object'),
  cohort_context_json JSONB NOT NULL CHECK (jsonb_typeof(cohort_context_json) = 'object'),
  baseline_spend DOUBLE PRECISION,
  baseline_purchases DOUBLE PRECISION,
  baseline_roas DOUBLE PRECISION,
  outcome_spend DOUBLE PRECISION NOT NULL CHECK (outcome_spend >= 0),
  outcome_purchases DOUBLE PRECISION NOT NULL CHECK (outcome_purchases >= 0),
  outcome_revenue DOUBLE PRECISION NOT NULL CHECK (outcome_revenue >= 0),
  outcome_roas DOUBLE PRECISION,
  expected_day_count INTEGER NOT NULL CHECK (expected_day_count > 0),
  completed_day_count INTEGER NOT NULL CHECK (completed_day_count >= 0),
  window_complete BOOLEAN NOT NULL,
  measurement_status TEXT NOT NULL CHECK (
    measurement_status IN ('known', 'unknown', 'censored', 'explained_zero_spend')
  ),
  realized_outcome TEXT NOT NULL CHECK (
    realized_outcome IN ('positive', 'negative', 'neutral', 'unknown')
  ),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  treatment_status TEXT NOT NULL CHECK (
    treatment_status IN (
      'observational_untreated',
      'observational_action_exposed',
      'controlled_treatment'
    )
  ),
  action_contaminated BOOLEAN NOT NULL,
  controlled_registry_available BOOLEAN NOT NULL,
  treatment_receipt_validated BOOLEAN NOT NULL,
  causal_assignment_validated BOOLEAN NOT NULL,
  causal_estimate_validated BOOLEAN NOT NULL,
  controlled_evidence_validated BOOLEAN NOT NULL,
  source_input_hash CHAR(64) NOT NULL,
  source_decision_hash CHAR(64) NOT NULL,
  ad_publication_receipts_hash CHAR(64) NOT NULL,
  fact_source_hash CHAR(64) NOT NULL,
  action_source_hash CHAR(64) NOT NULL,
  state_source_hash CHAR(64) NOT NULL,
  controlled_source_hash CHAR(64) NOT NULL,
  source_manifest_hash CHAR(64) NOT NULL,
  source_receipts_json JSONB NOT NULL CHECK (jsonb_typeof(source_receipts_json) = 'object'),
  controlled_evidence_json JSONB NOT NULL CHECK (jsonb_typeof(controlled_evidence_json) = 'object'),
  evidence_json JSONB NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
  outcome_run_id UUID NOT NULL,
  job_run_id UUID NOT NULL,
  source_set_hash CHAR(64) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_outcomes_native_identity_check CHECK (
    decision_entity_type = 'ad'
    AND decision_entity_id = ad_id
    AND length(btrim(provider_account_id)) > 0
    AND length(btrim(ad_id)) > 0
  ),
  CONSTRAINT engine_v3_ad_outcomes_business_identity_check CHECK (
    business_id = business_ref_id::text
  ),
  CONSTRAINT engine_v3_ad_outcomes_account_scope_check CHECK (
    scope_type = 'account' AND scope_id = provider_account_id
  ),
  CONSTRAINT engine_v3_ad_outcomes_account_binding_fk FOREIGN KEY (
    business_id, provider_account_ref_id, provider_account_id
  ) REFERENCES business_provider_accounts (
    business_id, provider_account_ref_id, provider_account_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcomes_window_check CHECK (
    outcome_window_days IN (3, 7, 14)
    AND outcome_window_start = decision_as_of_date + 1
    AND outcome_window_end = decision_as_of_date + outcome_window_days
    AND outcome_window_end = evaluation_date - 1
    AND outcome_window_end < evaluation_date
    AND expected_day_count = outcome_window_days
    AND source_cutoff_at = (
      (evaluation_date::timestamp + INTERVAL '${AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR} hours')
      AT TIME ZONE 'UTC'
    )
  ),
  CONSTRAINT engine_v3_ad_outcomes_completeness_check CHECK (
    completed_day_count <= expected_day_count
    AND window_complete = (completed_day_count = expected_day_count)
  ),
  CONSTRAINT engine_v3_ad_outcomes_measurement_check CHECK (
    (measurement_status = 'known' AND window_complete AND outcome_spend > 0
      AND realized_outcome IN ('positive', 'negative', 'neutral'))
    OR (measurement_status IN ('censored', 'explained_zero_spend')
      AND window_complete AND outcome_spend = 0 AND realized_outcome = 'unknown')
    OR (measurement_status = 'unknown' AND realized_outcome = 'unknown')
  ),
  CONSTRAINT engine_v3_ad_outcomes_treatment_check CHECK (
    (
      treatment_status = 'observational_untreated'
      AND NOT action_contaminated
      AND NOT controlled_evidence_validated
    )
    OR (
      treatment_status = 'observational_action_exposed'
      AND action_contaminated
      AND NOT controlled_evidence_validated
    )
    OR (
      treatment_status = 'controlled_treatment'
      AND action_contaminated
      AND treatment_receipt_validated
      AND causal_assignment_validated
      AND causal_estimate_validated
      AND controlled_evidence_validated
    )
  ),
  CONSTRAINT engine_v3_ad_outcomes_source_hash_check CHECK (
    source_input_hash ~ '^[0-9a-f]{64}$'
    AND source_decision_hash ~ '^[0-9a-f]{64}$'
    AND ad_publication_receipts_hash ~ '^[0-9a-f]{64}$'
    AND fact_source_hash ~ '^[0-9a-f]{64}$'
    AND action_source_hash ~ '^[0-9a-f]{64}$'
    AND state_source_hash ~ '^[0-9a-f]{64}$'
    AND controlled_source_hash ~ '^[0-9a-f]{64}$'
    AND source_manifest_hash ~ '^[0-9a-f]{64}$'
    AND source_set_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT engine_v3_ad_outcomes_snapshot_fk FOREIGN KEY (
    decision_snapshot_id, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id, decision_entity_type,
    decision_entity_id, ad_id, decision_as_of_date, engine_version,
    scope_type, scope_id, label, confidence, source_decision_job_run_id
  ) REFERENCES engine_v3_ad_decision_snapshots_daily (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    as_of_date, engine_version, scope_type, scope_id, label, confidence,
    job_run_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcomes_evaluation_fk FOREIGN KEY (
    evaluation_id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    decision_as_of_date, engine_version, scope_type, scope_id,
    source_input_hash, source_decision_hash, source_decision_job_run_id
  ) REFERENCES engine_v3_ad_decision_evaluations (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    as_of_date, engine_version, scope_type, scope_id, input_hash,
    decision_hash, job_run_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcomes_run_fk FOREIGN KEY (outcome_run_id)
    REFERENCES engine_v3_ad_decision_outcome_runs(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcomes_run_lineage_fk FOREIGN KEY (
    outcome_run_id, job_run_id, business_ref_id, business_id, evaluation_date,
    engine_version, contract_version, classifier_version, source_set_hash
  ) REFERENCES engine_v3_ad_decision_outcome_runs (
    id, job_run_id, business_ref_id, business_id, evaluation_date,
    engine_version, contract_version, classifier_version, source_set_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcomes_job_run_fk FOREIGN KEY (job_run_id)
    REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_outcomes_run_episode_unique UNIQUE (
    outcome_run_id,
    decision_snapshot_id,
    evaluation_id,
    outcome_window_days
  )
);

CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_outcomes_business_window
  ON engine_v3_ad_decision_outcomes_daily
  (business_ref_id, decision_as_of_date DESC, outcome_window_days, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_outcomes_native_timeline
  ON engine_v3_ad_decision_outcomes_daily
  (business_ref_id, provider_account_ref_id, provider_account_id,
   decision_entity_type, decision_entity_id, engine_version,
   decision_as_of_date DESC, outcome_window_days);
CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_outcomes_evaluation
  ON engine_v3_ad_decision_outcomes_daily (evaluation_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_outcomes_run
  ON engine_v3_ad_decision_outcomes_daily
  (outcome_run_id, outcome_window_days, decision_as_of_date, ad_id);

CREATE OR REPLACE FUNCTION reject_engine_v3_ad_outcome_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'engine_v3_ad_decision_outcomes_daily rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_engine_v3_ad_outcomes_immutable
  ON engine_v3_ad_decision_outcomes_daily;
CREATE TRIGGER trg_engine_v3_ad_outcomes_immutable
BEFORE UPDATE OR DELETE ON engine_v3_ad_decision_outcomes_daily
FOR EACH ROW EXECUTE FUNCTION reject_engine_v3_ad_outcome_mutation();
`;

export const READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL = `
WITH windows AS (
  SELECT unnest($3::integer[]) AS outcome_window_days
), candidate_windows AS (
  SELECT
    snapshot.id AS decision_snapshot_id,
    snapshot.evaluation_id,
    snapshot.job_run_id AS source_decision_job_run_id,
    snapshot.business_ref_id,
    snapshot.business_id,
    snapshot.provider_account_id,
    snapshot.provider_account_ref_id,
    snapshot.decision_entity_type,
    snapshot.decision_entity_id,
    snapshot.ad_id,
    snapshot.creative_id,
    snapshot.as_of_date AS decision_as_of_date,
    $2::date AS evaluation_date,
    windows.outcome_window_days,
    (snapshot.as_of_date + 1)::date AS outcome_window_start,
    (snapshot.as_of_date + windows.outcome_window_days)::date AS outcome_window_end,
    snapshot.engine_version,
    snapshot.scope_type,
    snapshot.scope_id,
    snapshot.label,
    snapshot.raw_label,
    snapshot.confidence,
    snapshot.effective_target_roas,
    snapshot.spend AS baseline_spend,
    snapshot.purchases AS baseline_purchases,
    snapshot.roas AS baseline_roas,
    snapshot.input_hash::text AS source_input_hash,
    snapshot.decision_hash::text AS source_decision_hash,
    GREATEST(snapshot.computed_at, evaluation.evaluated_at)
      AS decision_recommended_at,
    evaluation.contract_version AS evaluation_contract_version,
    evaluation.creative_input_json,
    evaluation.campaign_context_json
  FROM engine_v3_ad_decision_snapshots_daily snapshot
  INNER JOIN engine_v3_ad_decision_evaluations evaluation
    ON evaluation.id = snapshot.evaluation_id
   AND evaluation.business_ref_id = snapshot.business_ref_id
   AND evaluation.business_id = snapshot.business_id
   AND evaluation.provider_account_ref_id = snapshot.provider_account_ref_id
   AND evaluation.provider_account_id = snapshot.provider_account_id
   AND evaluation.decision_entity_type = snapshot.decision_entity_type
   AND evaluation.decision_entity_id = snapshot.decision_entity_id
   AND evaluation.ad_id = snapshot.ad_id
   AND evaluation.as_of_date = snapshot.as_of_date
   AND evaluation.engine_version = snapshot.engine_version
   AND evaluation.scope_type = snapshot.scope_type
   AND evaluation.scope_id = snapshot.scope_id
   AND evaluation.input_hash = snapshot.input_hash
   AND evaluation.decision_hash = snapshot.decision_hash
   AND evaluation.job_run_id = snapshot.job_run_id
  INNER JOIN business_provider_accounts account_binding
    ON account_binding.business_id = snapshot.business_id
    AND account_binding.provider = 'meta'
   AND account_binding.provider_account_ref_id = snapshot.provider_account_ref_id
    AND account_binding.provider_account_id = snapshot.provider_account_id
  CROSS JOIN windows
  WHERE snapshot.business_ref_id = $1::uuid
    AND snapshot.decision_entity_type = 'ad'
    AND snapshot.decision_entity_id = snapshot.ad_id
    AND snapshot.business_id = snapshot.business_ref_id::text
    AND snapshot.engine_version = $6::text
    AND snapshot.scope_type = 'account'
    AND snapshot.scope_id = snapshot.provider_account_id
    AND snapshot.as_of_date BETWEEN
      ($2::date - (($4::integer - 1) * INTERVAL '1 day')) AND $2::date
    AND snapshot.as_of_date + windows.outcome_window_days = ($2::date - 1)
)
SELECT
  candidate.*,
  COUNT(*) OVER ()::integer AS total_candidate_count,
  CASE
    WHEN jsonb_typeof(candidate.creative_input_json->'targetRoas') = 'number'
      THEN (candidate.creative_input_json->>'targetRoas')::double precision
  END AS target_roas,
  CASE
    WHEN jsonb_typeof(candidate.creative_input_json->'breakevenRoas') = 'number'
      THEN (candidate.creative_input_json->>'breakevenRoas')::double precision
  END AS break_even_roas,
  NULLIF(candidate.creative_input_json->>'effectiveCohort', '') AS effective_cohort,
  NULLIF(candidate.creative_input_json->>'objective', '') AS objective,
  NULLIF(candidate.creative_input_json->>'optimizationGoal', '') AS optimization_goal,
  NULLIF(candidate.creative_input_json->>'customEventType', '') AS custom_event_type,
  candidate.creative_input_json->'commercialTargetFreshness'
    AS commercial_target_freshness_json,
  completeness.expected_day_count,
  completeness.completed_day_count,
  completeness.ad_publication_receipts_json,
  facts.fact_rows_json,
  facts.fact_currency_count,
  facts.invalid_fact_count,
  facts.invalid_fact_receipts_json,
  actions.candidate_action_receipts_json,
  states.state_receipts_json
FROM candidate_windows candidate
CROSS JOIN LATERAL (
  SELECT
    COUNT(*)::integer AS expected_day_count,
    COUNT(*) FILTER (
      WHERE pointer.id IS NOT NULL
        AND slice.id IS NOT NULL
        AND slice.state = 'finalized_verified'
        AND slice.truth_state = 'finalized'
        AND slice.validation_status = 'passed'
        AND slice.status = 'published'
        AND slice.manifest_id IS NOT NULL
        AND NULLIF(btrim(slice.source_run_id), '') IS NOT NULL
        AND pointer.published_at <
          ((candidate.evaluation_date::timestamp + INTERVAL '${AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR} hours') AT TIME ZONE 'UTC')
        AND pointer.published_at >=
          ((day.day + INTERVAL '1 day') AT TIME ZONE 'UTC')
        AND slice.published_at IS NOT NULL
        AND slice.published_at <= pointer.published_at
    )::integer AS completed_day_count,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'date', day.day::date,
          'pointerId', pointer.id::text,
          'sliceVersionId', slice.id::text,
          'manifestId', slice.manifest_id::text,
          'sourceRunId', slice.source_run_id,
          'state', slice.state,
          'truthState', slice.truth_state,
          'validationStatus', slice.validation_status,
          'status', slice.status,
          'publishedAt', pointer.published_at
        ) ORDER BY day.day
      ) FILTER (
        WHERE pointer.id IS NOT NULL
          AND slice.id IS NOT NULL
          AND slice.state = 'finalized_verified'
          AND slice.truth_state = 'finalized'
          AND slice.validation_status = 'passed'
          AND slice.status = 'published'
          AND slice.manifest_id IS NOT NULL
          AND NULLIF(btrim(slice.source_run_id), '') IS NOT NULL
          AND pointer.published_at <
            ((candidate.evaluation_date::timestamp + INTERVAL '${AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR} hours') AT TIME ZONE 'UTC')
          AND pointer.published_at >=
            ((day.day + INTERVAL '1 day') AT TIME ZONE 'UTC')
          AND slice.published_at IS NOT NULL
          AND slice.published_at <= pointer.published_at
      ),
      '[]'::jsonb
    ) AS ad_publication_receipts_json
  FROM generate_series(
    candidate.outcome_window_start::timestamp,
    candidate.outcome_window_end::timestamp,
    INTERVAL '1 day'
  ) AS day(day)
  LEFT JOIN meta_authoritative_publication_pointers pointer
    ON pointer.business_ref_id = candidate.business_ref_id
   AND pointer.business_id = candidate.business_id
   AND pointer.provider_account_ref_id = candidate.provider_account_ref_id
   AND pointer.provider_account_id = candidate.provider_account_id
   AND pointer.day = day.day::date
   AND pointer.surface = 'ad_daily'
  LEFT JOIN meta_authoritative_slice_versions slice
    ON slice.id = pointer.active_slice_version_id
   AND slice.business_ref_id = candidate.business_ref_id
   AND slice.business_id = candidate.business_id
   AND slice.provider_account_ref_id = candidate.provider_account_ref_id
   AND slice.provider_account_id = candidate.provider_account_id
   AND slice.day = day.day::date
   AND slice.surface = 'ad_daily'
) completeness
CROSS JOIN LATERAL (
  SELECT
    COUNT(DISTINCT fact.account_currency)
      FILTER (WHERE fact.lineage_valid)::integer AS fact_currency_count,
    COUNT(*) FILTER (WHERE fact.lineage_valid IS NOT TRUE)::integer AS invalid_fact_count,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', fact.id::text,
          'date', fact.date,
          'truthState', fact.truth_state,
          'truthVersion', fact.truth_version,
          'validationStatus', fact.validation_status,
          'sourceRunId', fact.source_run_id,
          'sourceSnapshotId', fact.source_snapshot_id::text,
          'metricSchemaVersion', fact.metric_schema_version,
          'finalizedAt', fact.finalized_at,
          'updatedAt', fact.updated_at
        ) ORDER BY fact.date, fact.id
      ) FILTER (WHERE fact.lineage_valid IS NOT TRUE),
      '[]'::jsonb
    ) AS invalid_fact_receipts_json,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', fact.id::text,
          'date', fact.date,
          'accountCurrency', fact.account_currency,
          'spend', fact.spend,
          'purchases', fact.conversions,
          'revenue', fact.revenue,
          'truthState', fact.truth_state,
          'truthVersion', fact.truth_version,
          'finalizedAt', fact.finalized_at,
          'validationStatus', fact.validation_status,
          'sourceRunId', fact.source_run_id,
          'sourceSnapshotId', fact.source_snapshot_id::text,
          'metricSchemaVersion', fact.metric_schema_version,
          'updatedAt', fact.updated_at
        ) ORDER BY fact.date, fact.id
      ) FILTER (WHERE fact.lineage_valid),
      '[]'::jsonb
    ) AS fact_rows_json
  FROM (
    SELECT fact.*,
      (
        pointer.id IS NOT NULL
        AND slice.id IS NOT NULL
        AND pointer.published_at <
          ((candidate.evaluation_date::timestamp + INTERVAL '${AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR} hours') AT TIME ZONE 'UTC')
        AND pointer.published_at >=
          ((fact.date + 1)::timestamp AT TIME ZONE 'UTC')
        AND slice.state = 'finalized_verified'
        AND slice.truth_state = 'finalized'
        AND slice.validation_status = 'passed'
        AND slice.status = 'published'
        AND slice.manifest_id IS NOT NULL
        AND NULLIF(btrim(slice.source_run_id), '') IS NOT NULL
        AND slice.published_at IS NOT NULL
        AND slice.published_at <= pointer.published_at
        AND fact.truth_state = 'finalized'
        AND fact.validation_status = 'passed'
        AND fact.source_run_id = slice.source_run_id
        AND fact.finalized_at IS NOT NULL
        AND fact.finalized_at <= pointer.published_at
        AND fact.updated_at <= pointer.published_at
      ) AS lineage_valid
    FROM meta_ad_daily fact
    LEFT JOIN meta_authoritative_publication_pointers pointer
      ON pointer.business_ref_id = candidate.business_ref_id
     AND pointer.business_id = candidate.business_id
     AND pointer.provider_account_ref_id = candidate.provider_account_ref_id
     AND pointer.provider_account_id = candidate.provider_account_id
     AND pointer.day = fact.date
     AND pointer.surface = 'ad_daily'
    LEFT JOIN meta_authoritative_slice_versions slice
      ON slice.id = pointer.active_slice_version_id
     AND slice.business_ref_id = candidate.business_ref_id
     AND slice.business_id = candidate.business_id
     AND slice.provider_account_ref_id = candidate.provider_account_ref_id
     AND slice.provider_account_id = candidate.provider_account_id
     AND slice.day = fact.date
     AND slice.surface = 'ad_daily'
    WHERE fact.business_ref_id = candidate.business_ref_id
      AND fact.provider_account_ref_id = candidate.provider_account_ref_id
      AND fact.provider_account_id = candidate.provider_account_id
      AND fact.ad_id = candidate.ad_id
      AND fact.date BETWEEN candidate.outcome_window_start AND candidate.outcome_window_end
  ) fact
) facts
CROSS JOIN LATERAL (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'receiptId', receipt.id::text,
        'receiptHash', receipt.receipt_hash::text,
        'actionLogId', receipt.source_action_log_id::text,
        'contractVersion', receipt.contract_version,
        'businessId', receipt.business_ref_id::text,
        'providerAccountRefId', receipt.provider_account_ref_id::text,
        'providerAccountId', receipt.provider_account_id,
        'sourceAdId', receipt.source_ad_id,
        'sourceSnapshotId', receipt.source_snapshot_id::text,
        'sourceEvaluationId', receipt.source_evaluation_id::text,
        'sourceEngineVersion', receipt.source_engine_version,
        'sourceDecisionHash', receipt.source_decision_hash::text,
        'targetEntityType', receipt.target_entity_type,
        'targetEntityId', receipt.target_entity_id,
        'action', receipt.operator_action,
        'successorKind', receipt.successor_kind,
        'resultingAdId', receipt.resulting_ad_id,
        'idempotencyKey', receipt.idempotency_key,
        'status', receipt.action_status,
        'dryRun', receipt.dry_run,
        'providerVerified', receipt.provider_verified,
        'requestedAt', receipt.requested_at,
        'verifiedAt', receipt.verified_at,
        'finalizedAt', receipt.finalized_at,
        'capturedAt', receipt.captured_at,
        'verificationEntityId', receipt.verification_entity_id,
        'verificationStatus', receipt.verification_status,
        'episode', jsonb_build_object(
          'episodeKey', episode.episode_key::text,
          'businessId', episode.business_ref_id::text,
          'businessDisplayId', episode.business_id,
          'providerAccountRefId', episode.provider_account_ref_id::text,
          'providerAccountId', episode.provider_account_id,
          'adId', episode.ad_id,
          'creativeId', episode.creative_id,
          'asOfDate', episode.as_of_date,
          'engineVersion', episode.engine_version,
          'scopeType', episode.scope_type,
          'scopeId', episode.scope_id,
          'snapshotId', episode.decision_snapshot_id::text,
          'evaluationId', episode.evaluation_id::text,
          'inputHash', episode.input_hash::text,
          'decisionHash', episode.decision_hash::text,
          'decisionLabel', episode.decision_label,
          'sourceCampaignId', episode.source_campaign_id,
          'sourceAdsetId', episode.source_adset_id,
          'recommendedAt', episode.recommended_at
        )
      ) ORDER BY receipt.requested_at, receipt.id
    ),
    '[]'::jsonb
  ) AS candidate_action_receipts_json
  FROM engine_v3_ad_recommendation_episodes episode
  INNER JOIN engine_v3_ad_operator_action_receipts receipt
    ON receipt.episode_key = episode.episode_key
   AND receipt.business_ref_id = episode.business_ref_id
   AND receipt.business_id = episode.business_id
   AND receipt.provider_account_ref_id = episode.provider_account_ref_id
   AND receipt.provider_account_id = episode.provider_account_id
   AND receipt.source_ad_id = episode.ad_id
   AND receipt.source_snapshot_id = episode.decision_snapshot_id
   AND receipt.source_evaluation_id = episode.evaluation_id
   AND receipt.source_engine_version = episode.engine_version
   AND receipt.source_decision_hash = episode.decision_hash
  WHERE episode.business_ref_id = candidate.business_ref_id
    AND episode.business_id = candidate.business_id
    AND episode.provider_account_ref_id = candidate.provider_account_ref_id
    AND episode.provider_account_id = candidate.provider_account_id
    AND episode.ad_id = candidate.ad_id
    AND episode.as_of_date = candidate.decision_as_of_date
    AND episode.engine_version = candidate.engine_version
    AND episode.scope_type = candidate.scope_type
    AND episode.scope_id = candidate.scope_id
    AND episode.decision_snapshot_id = candidate.decision_snapshot_id
    AND episode.evaluation_id = candidate.evaluation_id
    AND episode.input_hash = candidate.source_input_hash
    AND episode.decision_hash = candidate.source_decision_hash
    AND episode.decision_label = candidate.label
    AND episode.recommended_at = candidate.decision_recommended_at
    AND receipt.requested_at > candidate.decision_recommended_at
    AND receipt.requested_at <
      ((candidate.outcome_window_end + 1)::timestamp AT TIME ZONE 'UTC')
    AND receipt.captured_at <
      ((candidate.evaluation_date::timestamp + INTERVAL '${AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR} hours') AT TIME ZONE 'UTC')
) actions
CROSS JOIN LATERAL (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', state.id::text,
        'businessId', state.business_ref_id::text,
        'providerAccountRefId', state.provider_account_ref_id::text,
        'providerAccountId', state.provider_account_id,
        'entityType', state.entity_type,
        'entityId', state.entity_id,
        'configuredStatus', state.configured_status,
        'effectiveStatus', state.effective_status,
        'presence', state.presence,
        'observedAt', state.observed_at,
        'capturedAt', state.captured_at,
        'runCompleteness', state.run_completeness,
        'stateHash', state.state_hash
      ) ORDER BY state.observed_at, state.captured_at, state.id
    ),
    '[]'::jsonb
  ) AS state_receipts_json
  FROM (
    (
      SELECT history.*
      FROM meta_entity_state_history history
      WHERE history.business_ref_id = candidate.business_ref_id
        AND history.provider_account_ref_id = candidate.provider_account_ref_id
        AND history.provider_account_id = candidate.provider_account_id
        AND history.entity_type = 'ad'
        AND history.entity_id = candidate.ad_id
        AND history.observed_at <
          (candidate.outcome_window_start::timestamp AT TIME ZONE 'UTC')
        AND history.captured_at <
          ((candidate.evaluation_date::timestamp + INTERVAL '${AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR} hours') AT TIME ZONE 'UTC')
        AND history.run_completeness IN ('complete', 'point_lookup')
      ORDER BY history.observed_at DESC, history.captured_at DESC, history.id DESC
      LIMIT 1
    )
    UNION ALL
    SELECT history.*
    FROM meta_entity_state_history history
    WHERE history.business_ref_id = candidate.business_ref_id
      AND history.provider_account_ref_id = candidate.provider_account_ref_id
      AND history.provider_account_id = candidate.provider_account_id
      AND history.entity_type = 'ad'
      AND history.entity_id = candidate.ad_id
      AND history.observed_at >=
        (candidate.outcome_window_start::timestamp AT TIME ZONE 'UTC')
      AND history.observed_at <
        ((candidate.outcome_window_end + 1)::timestamp AT TIME ZONE 'UTC')
      AND history.captured_at <
        ((candidate.evaluation_date::timestamp + INTERVAL '${AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR} hours') AT TIME ZONE 'UTC')
      AND history.run_completeness IN ('complete', 'point_lookup')
  ) state
) states
ORDER BY
  candidate.decision_as_of_date,
  candidate.provider_account_id,
  candidate.ad_id,
  candidate.outcome_window_days
LIMIT ($5::integer + 1)
`;

export const START_AD_DECISION_OUTCOME_RUN_SQL = `
WITH inserted AS (
  INSERT INTO engine_v3_ad_decision_outcome_runs (
    job_run_id, business_ref_id, business_id, evaluation_date, engine_version,
    contract_version, classifier_version, windows_days, lookback_days,
    candidate_row_count, persisted_row_count, window_counts_json,
    source_set_hash, status, started_at, completed_at
  ) VALUES (
    $1::uuid, $2::uuid, $2, $3::date, $4, $5, $6, $7::integer[],
    $8::integer, $9::integer, NULL, $10::jsonb, $11, 'pending',
    clock_timestamp(), NULL
  )
  ON CONFLICT ON CONSTRAINT engine_v3_ad_outcome_runs_identity_unique
  DO NOTHING
  RETURNING *
)
SELECT * FROM inserted
UNION ALL
SELECT existing.*
FROM engine_v3_ad_decision_outcome_runs existing
WHERE existing.job_run_id = $1::uuid
  AND existing.business_ref_id = $2::uuid
  AND existing.evaluation_date = $3::date
  AND existing.engine_version = $4
  AND existing.contract_version = $5
  AND existing.classifier_version = $6
  AND NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1
`;

export const INSERT_AD_DECISION_OUTCOMES_SQL = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    contract_version text,
    classifier_version text,
    decision_snapshot_id uuid,
    evaluation_id uuid,
    source_decision_job_run_id uuid,
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text,
    ad_id text,
    creative_id text,
    decision_as_of_date date,
    evaluation_date date,
    source_cutoff_at timestamptz,
    outcome_window_days integer,
    outcome_window_start date,
    outcome_window_end date,
    engine_version text,
    scope_type text,
    scope_id text,
    label text,
    raw_label text,
    confidence integer,
    effective_target_roas double precision,
    target_roas double precision,
    break_even_roas double precision,
    account_currency text,
    currency_status text,
    effective_cohort text,
    objective text,
    optimization_goal text,
    custom_event_type text,
    commercial_context_json jsonb,
    cohort_context_json jsonb,
    baseline_spend double precision,
    baseline_purchases double precision,
    baseline_roas double precision,
    outcome_spend double precision,
    outcome_purchases double precision,
    outcome_revenue double precision,
    outcome_roas double precision,
    expected_day_count integer,
    completed_day_count integer,
    window_complete boolean,
    measurement_status text,
    realized_outcome text,
    severity text,
    treatment_status text,
    action_contaminated boolean,
    controlled_registry_available boolean,
    treatment_receipt_validated boolean,
    causal_assignment_validated boolean,
    causal_estimate_validated boolean,
    controlled_evidence_validated boolean,
    source_input_hash text,
    source_decision_hash text,
    ad_publication_receipts_hash text,
    fact_source_hash text,
    action_source_hash text,
    state_source_hash text,
    controlled_source_hash text,
    source_manifest_hash text,
    source_receipts_json jsonb,
    controlled_evidence_json jsonb,
    evidence_json jsonb,
    outcome_run_id uuid,
    job_run_id uuid,
    source_set_hash text,
    computed_at timestamptz
  )
), accepted AS (
  SELECT payload.*
  FROM payload
  INNER JOIN engine_v3_ad_decision_outcome_runs outcome_run
    ON outcome_run.id = payload.outcome_run_id
   AND outcome_run.job_run_id = payload.job_run_id
   AND outcome_run.business_ref_id = payload.business_ref_id
   AND outcome_run.business_id = payload.business_id
   AND outcome_run.evaluation_date = payload.evaluation_date
   AND outcome_run.engine_version = payload.engine_version
   AND outcome_run.contract_version = payload.contract_version
   AND outcome_run.classifier_version = payload.classifier_version
   AND outcome_run.source_set_hash = payload.source_set_hash
   AND outcome_run.status IN ('pending', 'complete')
  INNER JOIN business_provider_accounts account_binding
    ON account_binding.business_id = payload.business_id
   AND account_binding.provider = 'meta'
   AND account_binding.provider_account_ref_id = payload.provider_account_ref_id
   AND account_binding.provider_account_id = payload.provider_account_id
  INNER JOIN engine_v3_ad_decision_snapshots_daily snapshot
    ON snapshot.id = payload.decision_snapshot_id
   AND snapshot.evaluation_id = payload.evaluation_id
   AND snapshot.job_run_id = payload.source_decision_job_run_id
   AND snapshot.business_ref_id = payload.business_ref_id
   AND snapshot.business_id = payload.business_id
   AND snapshot.provider_account_ref_id = payload.provider_account_ref_id
   AND snapshot.provider_account_id = payload.provider_account_id
   AND snapshot.decision_entity_type = payload.decision_entity_type
   AND snapshot.decision_entity_id = payload.decision_entity_id
   AND snapshot.ad_id = payload.ad_id
   AND snapshot.as_of_date = payload.decision_as_of_date
   AND snapshot.engine_version = payload.engine_version
   AND snapshot.scope_type = payload.scope_type
   AND snapshot.scope_id = payload.scope_id
   AND snapshot.input_hash = payload.source_input_hash
   AND snapshot.decision_hash = payload.source_decision_hash
  INNER JOIN engine_v3_ad_decision_evaluations evaluation
    ON evaluation.id = payload.evaluation_id
   AND evaluation.job_run_id = payload.source_decision_job_run_id
   AND evaluation.business_ref_id = payload.business_ref_id
   AND evaluation.business_id = payload.business_id
   AND evaluation.provider_account_ref_id = payload.provider_account_ref_id
   AND evaluation.provider_account_id = payload.provider_account_id
   AND evaluation.decision_entity_type = payload.decision_entity_type
   AND evaluation.decision_entity_id = payload.decision_entity_id
   AND evaluation.ad_id = payload.ad_id
   AND evaluation.as_of_date = payload.decision_as_of_date
   AND evaluation.engine_version = payload.engine_version
   AND evaluation.scope_type = payload.scope_type
   AND evaluation.scope_id = payload.scope_id
   AND evaluation.input_hash = payload.source_input_hash
   AND evaluation.decision_hash = payload.source_decision_hash
), inserted AS (
  INSERT INTO engine_v3_ad_decision_outcomes_daily (
    contract_version, classifier_version, decision_snapshot_id, evaluation_id,
    source_decision_job_run_id, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id,
    decision_entity_type, decision_entity_id, ad_id, creative_id,
    decision_as_of_date, evaluation_date, source_cutoff_at,
    outcome_window_days, outcome_window_start, outcome_window_end, engine_version,
    scope_type, scope_id, label, raw_label, confidence, effective_target_roas,
    target_roas, break_even_roas, account_currency, currency_status,
    effective_cohort, objective, optimization_goal, custom_event_type,
    commercial_context_json, cohort_context_json, baseline_spend,
    baseline_purchases, baseline_roas, outcome_spend, outcome_purchases,
    outcome_revenue, outcome_roas, expected_day_count, completed_day_count,
    window_complete, measurement_status, realized_outcome, severity,
    treatment_status, action_contaminated, controlled_registry_available,
    treatment_receipt_validated, causal_assignment_validated,
    causal_estimate_validated, controlled_evidence_validated, source_input_hash,
    source_decision_hash, ad_publication_receipts_hash, fact_source_hash,
    action_source_hash, state_source_hash, controlled_source_hash,
    source_manifest_hash, source_receipts_json, controlled_evidence_json,
    evidence_json, outcome_run_id, job_run_id, source_set_hash, computed_at
  )
  SELECT
    contract_version, classifier_version, decision_snapshot_id, evaluation_id,
    source_decision_job_run_id, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id,
    decision_entity_type, decision_entity_id, ad_id, creative_id,
    decision_as_of_date, evaluation_date, source_cutoff_at,
    outcome_window_days, outcome_window_start, outcome_window_end, engine_version,
    scope_type, scope_id, label, raw_label, confidence, effective_target_roas,
    target_roas, break_even_roas, account_currency, currency_status,
    effective_cohort, objective, optimization_goal, custom_event_type,
    commercial_context_json, cohort_context_json, baseline_spend,
    baseline_purchases, baseline_roas, outcome_spend, outcome_purchases,
    outcome_revenue, outcome_roas, expected_day_count, completed_day_count,
    window_complete, measurement_status, realized_outcome, severity,
    treatment_status, action_contaminated, controlled_registry_available,
    treatment_receipt_validated, causal_assignment_validated,
    causal_estimate_validated, controlled_evidence_validated, source_input_hash,
    source_decision_hash, ad_publication_receipts_hash, fact_source_hash,
    action_source_hash, state_source_hash, controlled_source_hash,
    source_manifest_hash, source_receipts_json, controlled_evidence_json,
    evidence_json, outcome_run_id, job_run_id, source_set_hash, computed_at
  FROM accepted
  ON CONFLICT ON CONSTRAINT engine_v3_ad_outcomes_run_episode_unique
  DO NOTHING
  RETURNING id
)
SELECT
  outcome.id,
  outcome.outcome_run_id,
  outcome.decision_snapshot_id,
  outcome.evaluation_id,
  outcome.source_set_hash,
  outcome.source_manifest_hash,
  EXISTS (SELECT 1 FROM inserted WHERE inserted.id = outcome.id) AS inserted
FROM engine_v3_ad_decision_outcomes_daily outcome
INNER JOIN accepted
  ON outcome.outcome_run_id = accepted.outcome_run_id
 AND outcome.decision_snapshot_id = accepted.decision_snapshot_id
 AND outcome.evaluation_id = accepted.evaluation_id
 AND outcome.outcome_window_days = accepted.outcome_window_days
 AND outcome.contract_version = accepted.contract_version
 AND outcome.classifier_version = accepted.classifier_version
 AND outcome.source_manifest_hash = accepted.source_manifest_hash
ORDER BY outcome.decision_as_of_date, outcome.provider_account_id,
  outcome.ad_id, outcome.outcome_window_days
`;

export const FINALIZE_AD_DECISION_OUTCOME_RUN_SQL = `
WITH locked_run AS (
  SELECT run.*
  FROM engine_v3_ad_decision_outcome_runs run
  WHERE run.id = $1::uuid
    AND run.job_run_id = $2::uuid
    AND run.business_ref_id = $3::uuid
    AND run.evaluation_date = $4::date
    AND run.engine_version = $5
    AND run.contract_version = $6
    AND run.classifier_version = $7
    AND run.source_set_hash = $8
  FOR UPDATE
), persisted AS (
  SELECT COUNT(outcome.id)::integer AS persisted_row_count
  FROM locked_run run
  LEFT JOIN engine_v3_ad_decision_outcomes_daily outcome
    ON outcome.outcome_run_id = run.id
   AND outcome.job_run_id = run.job_run_id
   AND outcome.business_ref_id = run.business_ref_id
   AND outcome.evaluation_date = run.evaluation_date
   AND outcome.engine_version = run.engine_version
   AND outcome.contract_version = run.contract_version
   AND outcome.classifier_version = run.classifier_version
   AND outcome.source_set_hash = run.source_set_hash
), completed AS (
  UPDATE engine_v3_ad_decision_outcome_runs run
  SET status = 'complete',
      persisted_row_count = persisted.persisted_row_count,
      completed_at = clock_timestamp()
  FROM persisted
  WHERE run.id = $1::uuid
    AND run.status = 'pending'
    AND persisted.persisted_row_count = run.candidate_row_count
  RETURNING run.*
), accepted_run AS (
  SELECT * FROM completed
  UNION ALL
  SELECT run.*
  FROM locked_run run
  CROSS JOIN persisted
  WHERE run.status = 'complete'
    AND run.persisted_row_count = run.candidate_row_count
    AND persisted.persisted_row_count = run.candidate_row_count
    AND NOT EXISTS (SELECT 1 FROM completed)
), publication_upsert AS (
  INSERT INTO engine_v3_ad_decision_outcome_publications (
    business_ref_id, business_id, evaluation_date, outcome_window_days,
    engine_version, contract_version, classifier_version,
    active_job_run_id, active_outcome_run_id, source_set_hash, published_at
  )
  SELECT
    run.business_ref_id, run.business_id, run.evaluation_date, window.days,
    run.engine_version, run.contract_version, run.classifier_version,
    run.job_run_id, run.id, run.source_set_hash, clock_timestamp()
  FROM accepted_run run
  CROSS JOIN unnest(run.windows_days) AS window(days)
  ON CONFLICT ON CONSTRAINT engine_v3_ad_outcome_publications_identity_unique
  DO UPDATE SET
    business_id = EXCLUDED.business_id,
    active_job_run_id = EXCLUDED.active_job_run_id,
    active_outcome_run_id = EXCLUDED.active_outcome_run_id,
    source_set_hash = EXCLUDED.source_set_hash,
    published_at = EXCLUDED.published_at,
    updated_at = clock_timestamp()
  WHERE (
    SELECT active_run.completed_at
    FROM engine_v3_ad_decision_outcome_runs active_run
    WHERE active_run.id = engine_v3_ad_decision_outcome_publications.active_outcome_run_id
  ) <= (
    SELECT replacement_run.completed_at
    FROM engine_v3_ad_decision_outcome_runs replacement_run
    WHERE replacement_run.id = EXCLUDED.active_outcome_run_id
  )
  RETURNING outcome_window_days
), published AS (
  SELECT outcome_window_days FROM publication_upsert
)
SELECT
  run.id,
  run.status,
  run.candidate_row_count,
  run.persisted_row_count,
  run.source_set_hash,
  (SELECT COUNT(*)::integer FROM published) AS published_window_count
FROM accepted_run run
`;

export interface AdDecisionOutcomeSourceRow extends Record<string, unknown> {
  total_candidate_count: unknown;
  decision_snapshot_id: unknown;
  evaluation_id: unknown;
  source_decision_job_run_id: unknown;
  business_ref_id: unknown;
  business_id: unknown;
  provider_account_id: unknown;
  provider_account_ref_id: unknown;
  decision_entity_type: unknown;
  decision_entity_id: unknown;
  ad_id: unknown;
  creative_id: unknown;
  decision_as_of_date: unknown;
  evaluation_date: unknown;
  outcome_window_days: unknown;
  outcome_window_start: unknown;
  outcome_window_end: unknown;
  engine_version: unknown;
  scope_type: unknown;
  scope_id: unknown;
  label: unknown;
  raw_label: unknown;
  confidence: unknown;
  effective_target_roas: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  effective_cohort: unknown;
  objective: unknown;
  optimization_goal: unknown;
  custom_event_type: unknown;
  commercial_target_freshness_json: unknown;
  baseline_spend: unknown;
  baseline_purchases: unknown;
  baseline_roas: unknown;
  source_input_hash: unknown;
  source_decision_hash: unknown;
  decision_recommended_at: unknown;
  evaluation_contract_version: unknown;
  campaign_context_json: unknown;
  expected_day_count: unknown;
  completed_day_count: unknown;
  ad_publication_receipts_json: unknown;
  fact_rows_json: unknown;
  fact_currency_count: unknown;
  invalid_fact_count: unknown;
  invalid_fact_receipts_json: unknown;
  candidate_action_receipts_json: unknown;
  state_receipts_json: unknown;
}

export interface AdDecisionAdPublicationReceipt {
  date: string;
  pointerId: string;
  sliceVersionId: string;
  manifestId: string;
  sourceRunId: string;
  state: "finalized_verified";
  truthState: "finalized";
  validationStatus: "passed";
  status: "published";
  publishedAt: string;
}

export interface AdDecisionFactReceipt {
  id: string;
  date: string;
  accountCurrency: string;
  spend: number;
  purchases: number;
  revenue: number;
  truthState: "finalized";
  truthVersion: number;
  finalizedAt: string | null;
  validationStatus: "passed";
  sourceRunId: string | null;
  sourceSnapshotId: string | null;
  metricSchemaVersion: number;
  updatedAt: string;
}

export interface NativeAdActionReceipt {
  id: string;
  receiptId: string;
  receiptHash: string;
  episodeKey: string;
  contractVersion:
    | typeof DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
    | typeof NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceAdId: string;
  sourceSnapshotId: string;
  sourceEvaluationId: string;
  sourceEngineVersion: string;
  sourceDecisionHash: string;
  targetEntityType: "ad" | "adset" | "campaign";
  targetEntityId: string;
  action: ExactMetaAdsActionLineage["action"];
  successorKind: "duplicate" | "rebuild" | null;
  resultingAdId: string | null;
  idempotencyKey: string;
  status: ExactMetaAdsActionLineage["status"];
  dryRun: boolean;
  providerVerified: boolean;
  requestedAt: string;
  verifiedAt: string | null;
  finalizedAt: string;
  capturedAt: string;
  verificationEntityId: string | null;
  verificationStatus: string | null;
  exactLineageValidated: true;
  treatmentEligible: boolean;
  definitiveNonTreatment: boolean;
}

export interface AdStateReceipt {
  id: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  entityType: "ad";
  entityId: string;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  presence: string;
  observedAt: string;
  capturedAt: string;
  runCompleteness: "complete" | "point_lookup";
  stateHash: string;
}

export interface AdDecisionControlledEvidenceResolution {
  registryAvailable: boolean;
  treatmentReceiptValidated: boolean;
  causalAssignmentValidated: boolean;
  causalEstimateValidated: boolean;
  controlledEvidenceValidated: boolean;
  outcomeLogId: string | null;
  invalidReasonCodes: string[];
  evidence: Record<string, unknown>;
}

interface NormalizedControlledEvidenceRow {
  contractVersion: string;
  outcomeLogId: string;
  businessId: string | null;
  providerAccountRefId: string | null;
  providerAccountId: string | null;
  recType: string | null;
  recId: string | null;
  occurredAt: string | null;
  estimateFinalizedAt: string | null;
  treatmentReceiptValidated: boolean;
  causalAssignmentValidated: boolean;
  causalEstimateValidated: boolean;
  controlledEvidenceValidated: boolean;
  invalidReasonCodes: string[];
  evaluationId: string | null;
  snapshotId: string | null;
  adId: string | null;
  actionLogId: string | null;
  windowStartAt: string | null;
  windowEndAt: string | null;
  experimentId: string | null;
  assignmentId: string | null;
  estimateId: string | null;
  evidenceSummary: Record<string, unknown>;
}

interface AdDecisionOutcomeDraft {
  decisionSnapshotId: string;
  evaluationId: string;
  sourceDecisionJobRunId: string;
  businessRefId: string;
  businessId: string;
  providerAccountId: string;
  providerAccountRefId: string;
  decisionEntityType: "ad";
  decisionEntityId: string;
  adId: string;
  creativeId: string | null;
  decisionAsOfDate: string;
  evaluationDate: string;
  sourceCutoffAt: string;
  outcomeWindowDays: AdDecisionOutcomeWindowDays;
  outcomeWindowStart: string;
  outcomeWindowEnd: string;
  engineVersion: string;
  scopeType: string;
  scopeId: string;
  label: DecisionLabel;
  rawLabel: DecisionLabel;
  confidence: number;
  effectiveTargetRoas: number;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  effectiveCohort: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  commercialTargetFreshness: unknown;
  campaignContext: Record<string, unknown>;
  evaluationContractVersion: string;
  baselineSpend: number | null;
  baselinePurchases: number | null;
  baselineRoas: number | null;
  sourceInputHash: string;
  sourceDecisionHash: string;
  decisionRecommendedAt: string;
  adPublicationReceipts: AdDecisionAdPublicationReceipt[];
  facts: AdDecisionFactReceipt[];
  exactActionReceipts: NativeAdActionReceipt[];
  verifiedActions: NativeAdActionReceipt[];
  nonTreatmentActionReceipts: NativeAdActionReceipt[];
  ambiguousActionReceipts: NativeAdActionReceipt[];
  invalidActionReceipts: unknown[];
  stateReceipts: AdStateReceipt[];
  accountCurrency: string | null;
  currencyStatus: "known" | "unknown" | "conflict";
  expectedDayCount: number;
  completedDayCount: number;
  windowComplete: boolean;
  outcomeSpend: number;
  outcomePurchases: number;
  outcomeRevenue: number;
  outcomeRoas: number | null;
  zeroSpendExplanation: Record<string, unknown> | null;
  metricSchemaComplete: boolean;
  factLineageComplete: boolean;
  invalidFactCount: number;
  invalidFactReceipts: unknown[];
}

export interface AdDecisionOutcomePayloadRow {
  contract_version: string;
  classifier_version: string;
  decision_snapshot_id: string;
  evaluation_id: string;
  source_decision_job_run_id: string;
  business_ref_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  decision_entity_type: "ad";
  decision_entity_id: string;
  ad_id: string;
  creative_id: string | null;
  decision_as_of_date: string;
  evaluation_date: string;
  source_cutoff_at: string;
  outcome_window_days: AdDecisionOutcomeWindowDays;
  outcome_window_start: string;
  outcome_window_end: string;
  engine_version: string;
  scope_type: string;
  scope_id: string;
  label: DecisionLabel;
  raw_label: DecisionLabel;
  confidence: number;
  effective_target_roas: number;
  target_roas: number | null;
  break_even_roas: number | null;
  account_currency: string | null;
  currency_status: "known" | "unknown" | "conflict";
  effective_cohort: string | null;
  objective: string | null;
  optimization_goal: string | null;
  custom_event_type: string | null;
  commercial_context_json: Record<string, unknown>;
  cohort_context_json: Record<string, unknown>;
  baseline_spend: number | null;
  baseline_purchases: number | null;
  baseline_roas: number | null;
  outcome_spend: number;
  outcome_purchases: number;
  outcome_revenue: number;
  outcome_roas: number | null;
  expected_day_count: number;
  completed_day_count: number;
  window_complete: boolean;
  measurement_status: AdDecisionOutcomeMeasurementStatus;
  realized_outcome: AdDecisionRealizedOutcome;
  severity: AdDecisionOutcomeSeverity;
  treatment_status: AdDecisionOutcomeTreatmentStatus;
  action_contaminated: boolean;
  controlled_registry_available: boolean;
  treatment_receipt_validated: boolean;
  causal_assignment_validated: boolean;
  causal_estimate_validated: boolean;
  controlled_evidence_validated: boolean;
  source_input_hash: string;
  source_decision_hash: string;
  ad_publication_receipts_hash: string;
  fact_source_hash: string;
  action_source_hash: string;
  state_source_hash: string;
  controlled_source_hash: string;
  source_manifest_hash: string;
  source_receipts_json: Record<string, unknown>;
  controlled_evidence_json: Record<string, unknown>;
  evidence_json: Record<string, unknown>;
  outcome_run_id: string;
  job_run_id: string;
  source_set_hash: string;
  computed_at: string;
}

export interface AccrueAdDecisionOutcomesInput {
  businessId: string;
  evaluationDate: string;
  jobRunId: string;
  windowsDays?: readonly AdDecisionOutcomeWindowDays[];
  lookbackDays?: number;
  batchLimit?: number;
}

export interface StoredAdDecisionOutcome {
  id: string;
  outcomeRunId: string;
  decisionSnapshotId: string;
  evaluationId: string;
  sourceSetHash: string;
  sourceManifestHash: string;
  inserted: boolean;
}

export interface AccrueAdDecisionOutcomesResult {
  sourceRowCount: number;
  outcomeRowCount: number;
  insertedRowCount: number;
  controlledRegistryAvailable: boolean;
  outcomeRunId: string;
  sourceSetHash: string;
  publishedWindowCount: number;
  outcomes: StoredAdDecisionOutcome[];
}

export interface AdDecisionOutcomesJobInput {
  businessId: string;
  asOf: string;
  windowsDays?: readonly AdDecisionOutcomeWindowDays[];
  lookbackDays?: number;
  batchLimit?: number;
}

export interface AdDecisionOutcomesJobResult {
  jobRunId: string;
  status: "success" | "failed" | "skipped";
  engineVersion: typeof NATIVE_AD_ENGINE_VERSION;
  sourceRowCount: number;
  outcomeRowCount: number;
  insertedRowCount: number;
  publishedWindowCount: number;
  controlledRegistryAvailable: boolean;
  sourceSetHash: string | null;
  durationMs: number;
  reason?: "lock_not_acquired" | "schema_not_ready" | "invalid_input";
  missingSchema?: string[];
  errorMessage?: string;
}

export interface AdDecisionOutcomesJobDueResult {
  skipped: boolean;
  asOf: string;
  reason?:
    | "jobs_disabled"
    | "outside_slot"
    | "schema_not_ready"
    | "already_ran"
    | "no_active_businesses";
  missingSchema?: string[];
  results?: Array<
    AdDecisionOutcomesJobResult & {
      businessId: string;
      businessName: string | null;
    }
  >;
}

export interface AdDecisionOutcomesJobDueOptions {
  jobsDisabled?: () => boolean;
  inspectSchema?: () => Promise<AdDecisionOutcomeSchemaCapability>;
  readCompletedBusinessIds?: (input: {
    asOf: string;
    engineVersion: typeof NATIVE_AD_ENGINE_VERSION;
  }) => Promise<readonly string[]>;
  runJob?: (
    input: AdDecisionOutcomesJobInput,
  ) => Promise<AdDecisionOutcomesJobResult>;
}

export type AdDecisionOutcomeQuery = <
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  queryText: string,
  params?: readonly unknown[],
) => Promise<Row[]>;

export type ControlledEvidenceReader = (
  input: ReadControlledEvidenceInput,
) => Promise<readonly unknown[]>;

export interface AccrueAdDecisionOutcomesOptions {
  query?: AdDecisionOutcomeQuery;
  readControlledEvidence?: ControlledEvidenceReader;
  now?: () => Date;
  runInTransaction?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const UNAVAILABLE_CONTROLLED_EVIDENCE: AdDecisionControlledEvidenceResolution =
  {
    registryAvailable: false,
    treatmentReceiptValidated: false,
    causalAssignmentValidated: false,
    causalEstimateValidated: false,
    controlledEvidenceValidated: false,
    outcomeLogId: null,
    invalidReasonCodes: ["controlled_registry_schema_unavailable"],
    evidence: { schemaAvailable: false },
  };

const AVAILABLE_NO_CONTROLLED_EVIDENCE: AdDecisionControlledEvidenceResolution =
  {
    registryAvailable: true,
    treatmentReceiptValidated: false,
    causalAssignmentValidated: false,
    causalEstimateValidated: false,
    controlledEvidenceValidated: false,
    outcomeLogId: null,
    invalidReasonCodes: [],
    evidence: { schemaAvailable: true, matched: false },
  };

const EMPTY_SOURCE_SET_HASH = "0".repeat(64);

export async function accrueAdDecisionOutcomes(
  input: AccrueAdDecisionOutcomesInput,
  options: AccrueAdDecisionOutcomesOptions = {},
): Promise<AccrueAdDecisionOutcomesResult> {
  const normalized = normalizeAccrualInput(input);
  const query = options.query ?? defaultQuery;
  if (options.query && !options.runInTransaction) {
    throw new TypeError(
      "A custom native outcome query requires an explicit transaction wrapper.",
    );
  }
  const runInTransaction =
    options.runInTransaction ?? ((fn) => runDbTransaction(fn));
  return runInTransaction(async () => {
    const sourceRows = await query<AdDecisionOutcomeSourceRow>(
      READ_AD_DECISION_OUTCOME_SOURCE_ROWS_SQL,
      [
        normalized.businessId,
        normalized.evaluationDate,
        normalized.windowsDays,
        normalized.lookbackDays,
        normalized.batchLimit,
        NATIVE_AD_ENGINE_VERSION,
      ],
    );
    assertCompleteSourceSet(sourceRows, normalized.batchLimit);
    const drafts = sourceRows.map(buildAdDecisionOutcomeDraft);
    assertUniqueDrafts(drafts);
    const controlledByDraft = await hydrateControlledEvidenceForAdOutcomes(
      drafts,
      options.readControlledEvidence ?? defaultControlledEvidenceReader,
    );
    const computedAt = (options.now ?? (() => new Date()))().toISOString();
    const provisionalRows = drafts.map((draft) =>
      buildAdDecisionOutcomePayload({
        draft,
        controlled:
          controlledByDraft.get(draftKey(draft)) ??
          AVAILABLE_NO_CONTROLLED_EVIDENCE,
        outcomeRunId: normalized.jobRunId,
        jobRunId: normalized.jobRunId,
        sourceSetHash: EMPTY_SOURCE_SET_HASH,
        computedAt,
      }),
    );
    const sourceSetHash = canonicalOutcomeSourceSetHash({
      businessId: normalized.businessId,
      evaluationDate: normalized.evaluationDate,
      windowsDays: normalized.windowsDays,
      lookbackDays: normalized.lookbackDays,
      rows: provisionalRows,
    });
    const windowCounts = Object.fromEntries(
      normalized.windowsDays.map((window) => [
        String(window),
        provisionalRows.filter((row) => row.outcome_window_days === window)
          .length,
      ]),
    );
    const [rawRun] = await query<Record<string, unknown>>(
      START_AD_DECISION_OUTCOME_RUN_SQL,
      [
        normalized.jobRunId,
        normalized.businessId,
        normalized.evaluationDate,
        NATIVE_AD_ENGINE_VERSION,
        AD_DECISION_OUTCOME_CONTRACT_VERSION,
        AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
        normalized.windowsDays,
        normalized.lookbackDays,
        provisionalRows.length,
        JSON.stringify(windowCounts),
        sourceSetHash,
      ],
    );
    const outcomeRun = mapAndValidateOutcomeRun(rawRun, {
      ...normalized,
      sourceSetHash,
      candidateRowCount: provisionalRows.length,
    });
    const payloadRows = provisionalRows.map((row) => ({
      ...row,
      outcome_run_id: outcomeRun.id,
      source_set_hash: sourceSetHash,
    }));
    const storedRows =
      payloadRows.length === 0
        ? []
        : await query<Record<string, unknown>>(
            INSERT_AD_DECISION_OUTCOMES_SQL,
            [JSON.stringify(payloadRows)],
          );
    if (storedRows.length !== payloadRows.length) {
      throw new Error(
        `Native ad outcome lineage rejected ${payloadRows.length - storedRows.length} row(s).`,
      );
    }
    const outcomes = storedRows.map(mapStoredOutcome);
    if (
      outcomes.some(
        (outcome) =>
          outcome.outcomeRunId !== outcomeRun.id ||
          outcome.sourceSetHash !== sourceSetHash,
      )
    ) {
      throw new Error("Native outcome persistence returned a stale run row.");
    }
    const [finalizedRaw] = await query<Record<string, unknown>>(
      FINALIZE_AD_DECISION_OUTCOME_RUN_SQL,
      [
        outcomeRun.id,
        normalized.jobRunId,
        normalized.businessId,
        normalized.evaluationDate,
        NATIVE_AD_ENGINE_VERSION,
        AD_DECISION_OUTCOME_CONTRACT_VERSION,
        AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
        sourceSetHash,
      ],
    );
    const finalized = validateFinalizedOutcomeRun(finalizedRaw, {
      outcomeRunId: outcomeRun.id,
      sourceSetHash,
      candidateRowCount: payloadRows.length,
      publishedWindowCount: normalized.windowsDays.length,
    });
    return {
      sourceRowCount: sourceRows.length,
      outcomeRowCount: outcomes.length,
      insertedRowCount: outcomes.filter((row) => row.inserted).length,
      controlledRegistryAvailable:
        controlledByDraft.size === 0 ||
        Array.from(controlledByDraft.values()).every(
          (resolution) => resolution.registryAvailable,
        ),
      outcomeRunId: outcomeRun.id,
      sourceSetHash,
      publishedWindowCount: finalized.publishedWindowCount,
      outcomes,
    };
  });
}

export interface ExecuteAdDecisionOutcomesJobOptions {
  inspectSchema?: (db: DbClient) => Promise<AdDecisionOutcomeSchemaCapability>;
  readControlledEvidence?: ControlledEvidenceReader;
  now?: () => Date;
}

function normalizeJobInput(input: AdDecisionOutcomesJobInput) {
  const normalized = normalizeAccrualInput({
    businessId: input.businessId,
    evaluationDate: input.asOf,
    jobRunId: "pending-job-run",
    windowsDays: input.windowsDays,
    lookbackDays: input.lookbackDays,
    batchLimit: input.batchLimit,
  });
  return {
    businessId: normalized.businessId,
    asOf: normalized.evaluationDate,
    windowsDays: normalized.windowsDays,
    lookbackDays: normalized.lookbackDays,
    batchLimit: normalized.batchLimit,
  };
}

export function adDecisionOutcomesJobAdvisoryLockKey(
  input: AdDecisionOutcomesJobInput,
): bigint {
  const normalized = normalizeJobInput(input);
  return hashAdvisoryLock(
    `${AD_DECISION_OUTCOMES_JOB_NAME}:${normalized.businessId}:${normalized.asOf}:${NATIVE_AD_ENGINE_VERSION}`,
  );
}

export async function executeAdDecisionOutcomesJob(
  input: AdDecisionOutcomesJobInput,
  db: DbClient,
  startedAt = Date.now(),
  options: ExecuteAdDecisionOutcomesJobOptions = {},
): Promise<AdDecisionOutcomesJobResult> {
  let normalized: ReturnType<typeof normalizeJobInput>;
  try {
    normalized = normalizeJobInput(input);
  } catch (error) {
    return failedAdDecisionOutcomeJobWithoutRun({
      startedAt,
      reason: "invalid_input",
      error,
    });
  }
  const [lock] = await db.query<Record<string, unknown>>(
    "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
    [adDecisionOutcomesJobAdvisoryLockKey(normalized).toString()],
  );
  if (lock?.acquired !== true) {
    const durationMs = Date.now() - startedAt;
    const jobRunId = await insertAdDecisionOutcomeJobRun(
      {
        ...normalized,
        status: "skipped",
        durationMs,
        errorCode: "lock_not_acquired",
        errorMessage: "Native ad outcome advisory lock was not acquired.",
      },
      db,
    );
    return {
      jobRunId,
      status: "skipped",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      sourceRowCount: 0,
      outcomeRowCount: 0,
      insertedRowCount: 0,
      publishedWindowCount: 0,
      controlledRegistryAvailable: false,
      sourceSetHash: null,
      durationMs,
      reason: "lock_not_acquired",
    };
  }

  const jobRunId = await insertAdDecisionOutcomeJobRun(
    { ...normalized, status: "running" },
    db,
  );
  await db.query("SAVEPOINT engine_v3_ad_decision_outcomes_job_work");
  try {
    const capability = await (
      options.inspectSchema ?? inspectAdDecisionOutcomeSchemaCapability
    )(db);
    if (!capability.ready) {
      const durationMs = Date.now() - startedAt;
      await markAdDecisionOutcomeJobSkipped(
        {
          jobRunId,
          durationMs,
          reason: "schema_not_ready",
          metadata: { missing_schema: capability.missing },
        },
        db,
      );
      return {
        jobRunId,
        status: "skipped",
        engineVersion: NATIVE_AD_ENGINE_VERSION,
        sourceRowCount: 0,
        outcomeRowCount: 0,
        insertedRowCount: 0,
        publishedWindowCount: 0,
        controlledRegistryAvailable: false,
        sourceSetHash: null,
        durationMs,
        reason: "schema_not_ready",
        missingSchema: capability.missing,
      };
    }

    const result = await accrueAdDecisionOutcomes(
      {
        businessId: normalized.businessId,
        evaluationDate: normalized.asOf,
        jobRunId,
        windowsDays: normalized.windowsDays,
        lookbackDays: normalized.lookbackDays,
        batchLimit: normalized.batchLimit,
      },
      {
        query: <Row extends Record<string, unknown>>(
          queryText: string,
          params?: readonly unknown[],
        ) => db.query<Row>(queryText, params ? [...params] : undefined),
        runInTransaction: async (fn) => fn(),
        readControlledEvidence: options.readControlledEvidence,
        now: options.now,
      },
    );
    const durationMs = Date.now() - startedAt;
    await markAdDecisionOutcomeJobSuccess(
      { jobRunId, durationMs, normalized, result },
      db,
    );
    return {
      jobRunId,
      status: "success",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      sourceRowCount: result.sourceRowCount,
      outcomeRowCount: result.outcomeRowCount,
      insertedRowCount: result.insertedRowCount,
      publishedWindowCount: result.publishedWindowCount,
      controlledRegistryAvailable: result.controlledRegistryAvailable,
      sourceSetHash: result.sourceSetHash,
      durationMs,
    };
  } catch (error) {
    await db.query(
      "ROLLBACK TO SAVEPOINT engine_v3_ad_decision_outcomes_job_work",
    );
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    await markAdDecisionOutcomeJobFailed(
      { jobRunId, durationMs, error, message },
      db,
    );
    return {
      jobRunId,
      status: "failed",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      sourceRowCount: 0,
      outcomeRowCount: 0,
      insertedRowCount: 0,
      publishedWindowCount: 0,
      controlledRegistryAvailable: false,
      sourceSetHash: null,
      durationMs,
      errorMessage: message,
    };
  }
}

export async function runAdDecisionOutcomesJob(
  input: AdDecisionOutcomesJobInput,
): Promise<AdDecisionOutcomesJobResult> {
  const startedAt = Date.now();
  try {
    return await runDbTransaction(
      async () => executeAdDecisionOutcomesJob(input, getDb(), startedAt),
      { timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    return failedAdDecisionOutcomeJobWithoutRun({
      startedAt,
      error,
    });
  }
}

export async function runAdDecisionOutcomesJobForActiveBusinessesIfDue(
  now = new Date(),
  activeBusinesses?: readonly { id: string; name?: string | null }[],
  options: AdDecisionOutcomesJobDueOptions = {},
): Promise<AdDecisionOutcomesJobDueResult> {
  const asOf = now.toISOString().slice(0, 10);
  if ((options.jobsDisabled ?? engineV3JobsDisabled)()) {
    return { skipped: true, reason: "jobs_disabled", asOf };
  }
  if (now.getUTCHours() !== AD_DECISION_OUTCOME_DAILY_UTC_HOUR) {
    return { skipped: true, reason: "outside_slot", asOf };
  }
  const capability = await (
    options.inspectSchema ?? inspectAdDecisionOutcomeSchemaCapability
  )().catch((error) => ({
    ready: false,
    missing: [
      `schema_inspection_failed:${error instanceof Error ? error.message : String(error)}`,
    ],
  }));
  if (!capability.ready) {
    return {
      skipped: true,
      reason: "schema_not_ready",
      asOf,
      missingSchema: capability.missing,
    };
  }
  const businesses = activeBusinesses ?? (await getActiveBusinesses());
  if (businesses.length === 0) {
    return { skipped: true, reason: "no_active_businesses", asOf };
  }
  const completed = new Set(
    await (
      options.readCompletedBusinessIds ?? readCompletedAdOutcomeBusinessIds
    )({ asOf, engineVersion: NATIVE_AD_ENGINE_VERSION }),
  );
  const pending = businesses.filter((business) => !completed.has(business.id));
  if (pending.length === 0) {
    return { skipped: true, reason: "already_ran", asOf };
  }
  const results = await Promise.all(
    pending.map(async (business) => ({
      businessId: business.id,
      businessName: business.name ?? null,
      ...(await (options.runJob ?? runAdDecisionOutcomesJob)({
        businessId: business.id,
        asOf,
        windowsDays: AD_DECISION_OUTCOME_WINDOWS_DAYS,
      })),
    })),
  );
  return { skipped: false, asOf, results };
}

async function readCompletedAdOutcomeBusinessIds(input: {
  asOf: string;
  engineVersion: typeof NATIVE_AD_ENGINE_VERSION;
}) {
  const rows = await getDb().query<Record<string, unknown>>(
    `
    SELECT business_ref_id::text AS business_ref_id
    FROM engine_v3_job_runs
    WHERE job_name = $1
      AND as_of_date = $2::date
      AND engine_version = $3
      AND status = 'success'
    GROUP BY business_ref_id
    `,
    [AD_DECISION_OUTCOMES_JOB_NAME, input.asOf, input.engineVersion],
  );
  return rows.map((row) =>
    requiredText(row.business_ref_id, "business_ref_id"),
  );
}

async function insertAdDecisionOutcomeJobRun(
  input: ReturnType<typeof normalizeJobInput> & {
    status: "running" | "skipped";
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
  },
  db: DbClient,
) {
  const inputHash = canonicalSha256({
    jobName: AD_DECISION_OUTCOMES_JOB_NAME,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    businessId: input.businessId,
    asOf: input.asOf,
    windowsDays: input.windowsDays,
    lookbackDays: input.lookbackDays,
    batchLimit: input.batchLimit,
  });
  const [row] = await db.query<Record<string, unknown>>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, finished_at, duration_ms, row_count, input_hash,
      error_code, error_message, error_json
    ) VALUES (
      $1, $2::uuid, $2, $3::date, $4, $5,
      CASE WHEN $5 = 'running' THEN NULL ELSE now() END,
      $6::integer, CASE WHEN $5 = 'running' THEN NULL ELSE 0 END,
      $7, $8, $9, $10::jsonb
    )
    RETURNING id
    `,
    [
      AD_DECISION_OUTCOMES_JOB_NAME,
      input.businessId,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      input.status,
      input.durationMs ?? null,
      inputHash,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      JSON.stringify({
        metadata: {
          native_ad_grain: true,
          parallel_authority: true,
          windows_days: input.windowsDays,
          lookback_days: input.lookbackDays,
          batch_limit: input.batchLimit,
        },
      }),
    ],
  );
  return requiredText(row?.id, "jobRun.id");
}

async function markAdDecisionOutcomeJobSkipped(
  input: {
    jobRunId: string;
    durationMs: number;
    reason: string;
    metadata: Record<string, unknown>;
  },
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'skipped', finished_at = now(), duration_ms = $1::integer,
      row_count = 0, error_code = $2, error_message = $2,
      error_json = $3::jsonb, updated_at = now()
    WHERE id = $4::uuid AND status = 'running'
    RETURNING id
    `,
    [
      input.durationMs,
      input.reason,
      JSON.stringify({ metadata: input.metadata }),
      input.jobRunId,
    ],
  );
  if (rows.length !== 1) {
    throw new Error("Native outcome job run skipped transition was rejected.");
  }
}

async function markAdDecisionOutcomeJobSuccess(
  input: {
    jobRunId: string;
    durationMs: number;
    normalized: ReturnType<typeof normalizeJobInput>;
    result: AccrueAdDecisionOutcomesResult;
  },
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'success', finished_at = now(), duration_ms = $1::integer,
      row_count = $2::integer, input_hash = $3, error_code = NULL,
      error_message = NULL, error_json = $4::jsonb, updated_at = now()
    WHERE id = $5::uuid AND status = 'running'
    RETURNING id
    `,
    [
      input.durationMs,
      input.result.outcomeRowCount,
      input.result.sourceSetHash,
      JSON.stringify({
        metadata: {
          native_ad_grain: true,
          parallel_authority: true,
          contract_version: AD_DECISION_OUTCOME_CONTRACT_VERSION,
          classifier_version: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
          windows_days: input.normalized.windowsDays,
          lookback_days: input.normalized.lookbackDays,
          batch_limit: input.normalized.batchLimit,
          source_row_count: input.result.sourceRowCount,
          outcome_row_count: input.result.outcomeRowCount,
          inserted_row_count: input.result.insertedRowCount,
          outcome_run_id: input.result.outcomeRunId,
          source_set_hash: input.result.sourceSetHash,
          published_window_count: input.result.publishedWindowCount,
          controlled_registry_available:
            input.result.controlledRegistryAvailable,
        },
      }),
      input.jobRunId,
    ],
  );
  if (rows.length !== 1) {
    throw new Error("Native outcome job run success transition was rejected.");
  }
}

async function markAdDecisionOutcomeJobFailed(
  input: {
    jobRunId: string;
    durationMs: number;
    error: unknown;
    message: string;
  },
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'failed', finished_at = now(), duration_ms = $1::integer,
      row_count = 0, error_code = 'native_outcome_job_failed',
      error_message = $2, error_json = $3::jsonb, updated_at = now()
    WHERE id = $4::uuid AND status = 'running'
    RETURNING id
    `,
    [
      input.durationMs,
      input.message,
      JSON.stringify(errorToJson(input.error)),
      input.jobRunId,
    ],
  );
  if (rows.length !== 1) {
    throw new Error("Native outcome job run failed transition was rejected.");
  }
}

function failedAdDecisionOutcomeJobWithoutRun(input: {
  startedAt: number;
  reason?: AdDecisionOutcomesJobResult["reason"];
  error: unknown;
}): AdDecisionOutcomesJobResult {
  return {
    jobRunId: "",
    status: "failed",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    sourceRowCount: 0,
    outcomeRowCount: 0,
    insertedRowCount: 0,
    publishedWindowCount: 0,
    controlledRegistryAvailable: false,
    sourceSetHash: null,
    durationMs: Date.now() - input.startedAt,
    ...(input.reason ? { reason: input.reason } : {}),
    errorMessage:
      input.error instanceof Error ? input.error.message : String(input.error),
  };
}

export function buildAdDecisionOutcomeRecord(input: {
  source: AdDecisionOutcomeSourceRow;
  jobRunId: string;
  computedAt: string;
}): AdDecisionOutcomePayloadRow {
  const jobRunId = requiredText(input.jobRunId, "jobRunId");
  const provisional = buildAdDecisionOutcomePayload({
    draft: buildAdDecisionOutcomeDraft(input.source),
    controlled: UNAVAILABLE_CONTROLLED_EVIDENCE,
    outcomeRunId: jobRunId,
    jobRunId,
    sourceSetHash: EMPTY_SOURCE_SET_HASH,
    computedAt: requiredTimestamp(input.computedAt, "computedAt"),
  });
  const sourceSetHash = canonicalOutcomeSourceSetHash({
    businessId: provisional.business_ref_id,
    evaluationDate: provisional.evaluation_date,
    windowsDays: [provisional.outcome_window_days],
    lookbackDays: 1,
    rows: [provisional],
  });
  return { ...provisional, source_set_hash: sourceSetHash };
}

export function parseExactNativeAdActionReceipts(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string | null;
  decisionAsOfDate: string;
  decisionSnapshotId: string;
  evaluationId: string;
  engineVersion: string;
  scopeType: string;
  scopeId: string;
  sourceInputHash: string;
  decisionHash: string;
  decisionLabel: DecisionLabel;
  decisionRecommendedAt: string;
  windowEnd: string;
  evaluationDate: string;
  receipts: readonly unknown[];
}): NativeAdActionReceipt[] {
  const decisionRecommendedAt = requiredTimestamp(
    input.decisionRecommendedAt,
    "decisionRecommendedAt",
  );
  const windowEndExclusive = `${addIsoDays(input.windowEnd, 1)}T00:00:00.000Z`;
  const evaluationEndExclusive = adDecisionOutcomeCutoffAt(
    input.evaluationDate,
  );
  return input.receipts
    .flatMap((value) => {
      const row = record(value);
      const episodeRow = record(row?.episode);
      if (!row || !episodeRow) return [];
      const contractVersion = textOrNull(row.contractVersion);
      const targetEntityType = textOrNull(row.targetEntityType);
      const action = textOrNull(row.action);
      const status = textOrNull(row.status);
      if (
        (contractVersion !== DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION &&
          contractVersion !== NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION) ||
        (targetEntityType !== "ad" &&
          targetEntityType !== "adset" &&
          targetEntityType !== "campaign") ||
        ![
          "pause",
          "resume",
          "duplicate",
          "rebuild",
          "budget_increase",
          "budget_decrease",
          "budget_change",
        ].includes(action ?? "") ||
        (status !== "success" &&
          status !== "failure" &&
          status !== "silent_failure")
      ) {
        return [];
      }
      const requestedAt = timestampOrNull(row.requestedAt);
      const verifiedAt = timestampOrNull(row.verifiedAt);
      const finalizedAt = timestampOrNull(row.finalizedAt);
      const capturedAt = timestampOrNull(row.capturedAt);
      if (!requestedAt || !finalizedAt || !capturedAt) return [];
      let episode: ReturnType<typeof buildAdRecommendationEpisode>;
      let exactAction: ExactMetaAdsActionLineage;
      try {
        episode = buildAdRecommendationEpisode({
          businessId: requiredText(episodeRow.businessId, "episode.businessId"),
          businessDisplayId: requiredText(
            episodeRow.businessDisplayId,
            "episode.businessDisplayId",
          ),
          providerAccountRefId: requiredText(
            episodeRow.providerAccountRefId,
            "episode.providerAccountRefId",
          ),
          providerAccountId: requiredText(
            episodeRow.providerAccountId,
            "episode.providerAccountId",
          ),
          adId: requiredText(episodeRow.adId, "episode.adId"),
          creativeId: textOrNull(episodeRow.creativeId),
          asOfDate: requiredDate(episodeRow.asOfDate, "episode.asOfDate"),
          engineVersion: requiredText(
            episodeRow.engineVersion,
            "episode.engineVersion",
          ),
          scopeType: requiredText(episodeRow.scopeType, "episode.scopeType"),
          scopeId: requiredText(episodeRow.scopeId, "episode.scopeId"),
          snapshotId: requiredText(episodeRow.snapshotId, "episode.snapshotId"),
          evaluationId: requiredText(
            episodeRow.evaluationId,
            "episode.evaluationId",
          ),
          inputHash: requiredHash(episodeRow.inputHash, "episode.inputHash"),
          decisionHash: requiredHash(
            episodeRow.decisionHash,
            "episode.decisionHash",
          ),
          decisionLabel: requiredText(
            episodeRow.decisionLabel,
            "episode.decisionLabel",
          ),
          sourceCampaignId: textOrNull(episodeRow.sourceCampaignId),
          sourceAdsetId: textOrNull(episodeRow.sourceAdsetId),
          recommendedAt: requiredTimestamp(
            episodeRow.recommendedAt,
            "episode.recommendedAt",
          ),
        });
        if (
          requiredHash(episodeRow.episodeKey, "episode.episodeKey") !==
          episode.episodeKey
        ) {
          return [];
        }
        exactAction = {
          receiptId: requiredText(row.receiptId, "actionReceipt.receiptId"),
          receiptHash: requiredHash(
            row.receiptHash,
            "actionReceipt.receiptHash",
          ),
          actionLogId: requiredText(
            row.actionLogId,
            "actionReceipt.actionLogId",
          ),
          contractVersion,
          businessId: requiredText(row.businessId, "actionReceipt.businessId"),
          providerAccountRefId: requiredText(
            row.providerAccountRefId,
            "actionReceipt.providerAccountRefId",
          ),
          providerAccountId: requiredText(
            row.providerAccountId,
            "actionReceipt.providerAccountId",
          ),
          sourceAdId: requiredText(row.sourceAdId, "actionReceipt.sourceAdId"),
          sourceSnapshotId: requiredText(
            row.sourceSnapshotId,
            "actionReceipt.sourceSnapshotId",
          ),
          sourceEvaluationId: requiredText(
            row.sourceEvaluationId,
            "actionReceipt.sourceEvaluationId",
          ),
          sourceEngineVersion: requiredText(
            row.sourceEngineVersion,
            "actionReceipt.sourceEngineVersion",
          ),
          sourceDecisionHash: requiredHash(
            row.sourceDecisionHash,
            "actionReceipt.sourceDecisionHash",
          ),
          targetEntityType,
          targetEntityId: requiredText(
            row.targetEntityId,
            "actionReceipt.targetEntityId",
          ),
          action: action as ExactMetaAdsActionLineage["action"],
          successorKind:
            row.successorKind === "duplicate" || row.successorKind === "rebuild"
              ? row.successorKind
              : null,
          resultingAdId: textOrNull(row.resultingAdId),
          idempotencyKey: requiredText(
            row.idempotencyKey,
            "actionReceipt.idempotencyKey",
          ),
          status,
          dryRun: requiredBoolean(row.dryRun, "actionReceipt.dryRun"),
          providerVerified: requiredBoolean(
            row.providerVerified,
            "actionReceipt.providerVerified",
          ),
          requestedAt,
          verifiedAt,
          finalizedAt,
          capturedAt,
          verificationEntityId: textOrNull(row.verificationEntityId),
          verificationStatus: textOrNull(row.verificationStatus),
        };
        assertExactMetaAdsActionReceiptForEpisode({
          action: exactAction,
          episode,
        });
      } catch {
        return [];
      }
      if (
        episode.businessId !== input.businessId ||
        episode.providerAccountRefId !== input.providerAccountRefId ||
        episode.providerAccountId !== input.providerAccountId ||
        episode.adId !== input.adId ||
        episode.creativeId !== input.creativeId ||
        episode.asOfDate !== input.decisionAsOfDate ||
        episode.snapshotId !== input.decisionSnapshotId ||
        episode.evaluationId !== input.evaluationId ||
        episode.engineVersion !== input.engineVersion ||
        episode.scopeType !== input.scopeType ||
        episode.scopeId !== input.scopeId ||
        episode.inputHash !== input.sourceInputHash ||
        episode.decisionHash !== input.decisionHash ||
        episode.decisionLabel !== input.decisionLabel ||
        episode.recommendedAt !== decisionRecommendedAt ||
        requestedAt <= decisionRecommendedAt ||
        requestedAt >= windowEndExclusive ||
        finalizedAt < requestedAt ||
        finalizedAt >= windowEndExclusive ||
        capturedAt < finalizedAt ||
        capturedAt >= evaluationEndExclusive ||
        (verifiedAt !== null &&
          (verifiedAt < requestedAt || verifiedAt > finalizedAt))
      ) {
        return [];
      }
      const treatmentEligible = nativeReceiptTreatmentEligible(exactAction);
      const definitiveNonTreatment =
        exactAction.dryRun || exactAction.status === "failure";
      return [
        {
          id: exactAction.actionLogId,
          receiptId: exactAction.receiptId,
          receiptHash: exactAction.receiptHash,
          episodeKey: episode.episodeKey,
          contractVersion: exactAction.contractVersion,
          businessId: input.businessId,
          providerAccountRefId: input.providerAccountRefId,
          providerAccountId: input.providerAccountId,
          sourceAdId: exactAction.sourceAdId,
          sourceSnapshotId: exactAction.sourceSnapshotId,
          sourceEvaluationId: exactAction.sourceEvaluationId,
          sourceEngineVersion: exactAction.sourceEngineVersion,
          sourceDecisionHash: exactAction.sourceDecisionHash,
          targetEntityType: exactAction.targetEntityType,
          targetEntityId: exactAction.targetEntityId,
          action: exactAction.action,
          successorKind: exactAction.successorKind,
          resultingAdId: exactAction.resultingAdId,
          idempotencyKey: exactAction.idempotencyKey,
          status: exactAction.status,
          dryRun: exactAction.dryRun,
          providerVerified: exactAction.providerVerified,
          requestedAt,
          verifiedAt,
          finalizedAt,
          capturedAt,
          verificationEntityId: exactAction.verificationEntityId,
          verificationStatus: exactAction.verificationStatus,
          exactLineageValidated: true as const,
          treatmentEligible,
          definitiveNonTreatment,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.receiptId.localeCompare(right.receiptId),
    );
}

function nativeReceiptTreatmentEligible(action: ExactMetaAdsActionLineage) {
  if (
    action.status !== "success" ||
    action.dryRun ||
    !action.providerVerified ||
    action.verifiedAt === null ||
    action.verificationEntityId === null ||
    action.verificationStatus === null
  ) {
    return false;
  }
  if (action.action === "pause") {
    return (
      action.targetEntityType === "ad" &&
      action.targetEntityId === action.sourceAdId &&
      action.verificationEntityId === action.sourceAdId &&
      action.verificationStatus === "PAUSED"
    );
  }
  if (action.action === "resume") {
    return (
      action.targetEntityType === "ad" &&
      action.targetEntityId === action.sourceAdId &&
      action.verificationEntityId === action.sourceAdId &&
      action.verificationStatus === "ACTIVE"
    );
  }
  return action.verificationEntityId === action.targetEntityId;
}

export async function hydrateControlledEvidenceForAdOutcomes(
  drafts: readonly AdDecisionOutcomeDraft[],
  reader: ControlledEvidenceReader = defaultControlledEvidenceReader,
): Promise<Map<string, AdDecisionControlledEvidenceResolution>> {
  const result = new Map<string, AdDecisionControlledEvidenceResolution>();
  const groups = new Map<string, AdDecisionOutcomeDraft[]>();
  for (const draft of drafts) {
    const key = `${draft.businessRefId}\u0000${draft.providerAccountRefId}\u0000${draft.providerAccountId}`;
    const rows = groups.get(key) ?? [];
    rows.push(draft);
    groups.set(key, rows);
  }

  await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const first = group[0];
      if (!first) return;
      let evidenceRows: readonly unknown[];
      try {
        evidenceRows = await reader({
          businessId: first.businessRefId,
          providerAccountRefId: first.providerAccountRefId,
          providerAccountId: first.providerAccountId,
          recTypes: AD_DECISION_CONTROLLED_REC_TYPES,
          limit: AD_DECISION_OUTCOME_BATCH_LIMIT,
        });
      } catch (error) {
        if (!(error instanceof ControlledRegistrySchemaError)) {
          throw error;
        }
        for (const draft of group) {
          result.set(draftKey(draft), UNAVAILABLE_CONTROLLED_EVIDENCE);
        }
        return;
      }
      for (const draft of group) {
        result.set(
          draftKey(draft),
          matchControlledEvidence(draft, evidenceRows),
        );
      }
    }),
  );
  return result;
}

function matchControlledEvidence(
  draft: AdDecisionOutcomeDraft,
  rows: readonly unknown[],
): AdDecisionControlledEvidenceResolution {
  const actionsById = new Map(
    draft.verifiedActions.map((row) => [row.id, row] as const),
  );
  const evaluationEndExclusive = adDecisionOutcomeCutoffAt(
    draft.evaluationDate,
  );
  const outcomeWindowCompleteAt = `${addIsoDays(
    draft.outcomeWindowEnd,
    1,
  )}T00:00:00.000Z`;
  const matches = rows
    .flatMap((row) => normalizeControlledEvidenceRow(row) ?? [])
    .filter((row) => {
      const action = row.actionLogId
        ? actionsById.get(row.actionLogId)
        : undefined;
      return (
        row.contractVersion === CONTROLLED_HYDRATION_VERSION &&
        row.businessId === draft.businessRefId &&
        row.providerAccountRefId === draft.providerAccountRefId &&
        row.providerAccountId === draft.providerAccountId &&
        row.recType === AD_DECISION_CONTROLLED_REC_TYPES[0] &&
        row.evaluationId === draft.evaluationId &&
        row.snapshotId === draft.decisionSnapshotId &&
        row.adId === draft.adId &&
        row.actionLogId !== null &&
        action?.exactLineageValidated === true &&
        action.treatmentEligible &&
        row.assignmentId !== null &&
        row.recId !== null &&
        sameIsoDate(row.windowStartAt, draft.outcomeWindowStart) &&
        sameIsoDate(row.windowEndAt, draft.outcomeWindowEnd) &&
        row.occurredAt !== null &&
        row.occurredAt >= outcomeWindowCompleteAt &&
        row.occurredAt < evaluationEndExclusive &&
        row.estimateFinalizedAt !== null &&
        row.estimateFinalizedAt >= row.occurredAt &&
        row.estimateFinalizedAt < evaluationEndExclusive
      );
    });
  if (matches.length === 0) return AVAILABLE_NO_CONTROLLED_EVIDENCE;
  if (matches.length > 1) {
    return {
      ...AVAILABLE_NO_CONTROLLED_EVIDENCE,
      invalidReasonCodes: ["multiple_exact_controlled_claims"],
      evidence: {
        schemaAvailable: true,
        matched: false,
        candidateOutcomeLogIds: matches.map((row) => row.outcomeLogId).sort(),
      },
    };
  }
  const match = matches[0]!;
  const controlledClaimsComplete =
    match.experimentId !== null &&
    match.assignmentId !== null &&
    match.estimateId !== null &&
    match.actionLogId !== null &&
    match.invalidReasonCodes.length === 0;
  return {
    registryAvailable: true,
    treatmentReceiptValidated: match.treatmentReceiptValidated,
    causalAssignmentValidated: match.causalAssignmentValidated,
    causalEstimateValidated: match.causalEstimateValidated,
    controlledEvidenceValidated:
      match.controlledEvidenceValidated && controlledClaimsComplete,
    outcomeLogId: match.outcomeLogId,
    invalidReasonCodes: [...match.invalidReasonCodes].sort(),
    evidence: {
      schemaAvailable: true,
      matched: true,
      contractVersion: match.contractVersion,
      outcomeLogId: match.outcomeLogId,
      experimentId: match.experimentId,
      assignmentId: match.assignmentId,
      actionLogId: match.actionLogId,
      estimateId: match.estimateId,
      hydrated: match.evidenceSummary,
    },
  };
}

function normalizeControlledEvidenceRow(
  value: unknown,
): NormalizedControlledEvidenceRow | null {
  const row = record(value);
  if (!row) return null;
  const evidence = record(row.evidence) ?? {};
  const payload = record(row.payloadJson) ?? {};
  const nativeLineage = record(payload.nativeAdDecisionLineage);
  const window = record(payload.outcomeWindow);
  const outcomeLogId = textOrNull(row.outcomeLogId);
  const contractVersion = textOrNull(row.contractVersion);
  if (
    !outcomeLogId ||
    !contractVersion ||
    !nativeLineage ||
    nativeLineage.contractVersion !== AD_DECISION_CONTROLLED_LINEAGE_VERSION ||
    nativeLineage.entityType !== "ad"
  ) {
    return null;
  }

  const evaluationId = textOrNull(nativeLineage.evaluationId);
  const snapshotId = textOrNull(nativeLineage.snapshotId);
  const adId = textOrNull(nativeLineage.adId);
  const businessId = textOrNull(nativeLineage.businessId);
  const providerAccountRefId = textOrNull(nativeLineage.providerAccountRefId);
  const providerAccountId = textOrNull(nativeLineage.providerAccountId);
  if (
    businessId !== textOrNull(row.businessId) ||
    providerAccountId !== textOrNull(row.providerAccountId)
  ) {
    return null;
  }
  const actionLogId = textOrNull(evidence.actionLogId);
  const assignmentId = textOrNull(evidence.assignmentId);
  const recId = textOrNull(row.recId);
  if (
    actionLogId !== textOrNull(nativeLineage.actionLogId) ||
    assignmentId !== textOrNull(nativeLineage.controlledAssignmentId) ||
    recId !== textOrNull(nativeLineage.recId)
  ) {
    return null;
  }
  const windowStartAt =
    textOrNull(nativeLineage.outcomeWindowStart) ?? textOrNull(window?.start);
  const windowEndAt =
    textOrNull(nativeLineage.outcomeWindowEnd) ?? textOrNull(window?.end);

  return {
    contractVersion,
    outcomeLogId,
    businessId,
    providerAccountRefId,
    providerAccountId,
    recType: textOrNull(row.recType),
    recId,
    occurredAt: timestampOrNull(row.occurredAt),
    estimateFinalizedAt: timestampOrNull(evidence.estimateFinalizedAt),
    treatmentReceiptValidated: row.treatmentReceiptValidated === true,
    causalAssignmentValidated: row.causalAssignmentValidated === true,
    causalEstimateValidated: row.causalEstimateValidated === true,
    controlledEvidenceValidated: row.controlledEvidenceValidated === true,
    invalidReasonCodes: jsonArray(row.invalidReasonCodes)
      .flatMap((reason) => textOrNull(reason) ?? [])
      .sort(),
    evaluationId,
    snapshotId,
    adId,
    actionLogId,
    windowStartAt,
    windowEndAt,
    experimentId: textOrNull(evidence.experimentId),
    assignmentId,
    estimateId: textOrNull(evidence.estimateId),
    evidenceSummary: {
      registryEvidence: evidence,
      nativeAdDecisionLineage: nativeLineage,
    },
  };
}

function buildAdDecisionOutcomeDraft(
  row: AdDecisionOutcomeSourceRow,
): AdDecisionOutcomeDraft {
  const businessRefId = requiredText(row.business_ref_id, "business_ref_id");
  const businessId = requiredText(row.business_id, "business_id");
  if (businessId !== businessRefId) {
    throw new Error("Native outcome source business identity is inconsistent.");
  }
  const providerAccountId = requiredText(
    row.provider_account_id,
    "provider_account_id",
  );
  const adId = requiredText(row.ad_id, "ad_id");
  const decisionEntityId = requiredText(
    row.decision_entity_id,
    "decision_entity_id",
  );
  if (row.decision_entity_type !== "ad" || decisionEntityId !== adId) {
    throw new Error("Native outcome source identity is not exact ad grain.");
  }
  const decisionAsOfDate = requiredDate(
    row.decision_as_of_date,
    "decision_as_of_date",
  );
  const evaluationDate = requiredDate(row.evaluation_date, "evaluation_date");
  const outcomeWindowDays = toOutcomeWindowDays(row.outcome_window_days);
  const outcomeWindowStart = requiredDate(
    row.outcome_window_start,
    "outcome_window_start",
  );
  const outcomeWindowEnd = requiredDate(
    row.outcome_window_end,
    "outcome_window_end",
  );
  if (
    outcomeWindowStart !== addIsoDays(decisionAsOfDate, 1) ||
    outcomeWindowEnd !== addIsoDays(decisionAsOfDate, outcomeWindowDays)
  ) {
    throw new Error(
      "Native outcome source window does not match decision date.",
    );
  }
  const expectedDates = dateRange(outcomeWindowStart, outcomeWindowEnd);
  const adPublicationReceipts = parseAdPublicationReceipts(
    row.ad_publication_receipts_json,
    expectedDates,
    evaluationDate,
  );
  const facts = parseFactReceipts(row.fact_rows_json, {
    start: outcomeWindowStart,
    end: outcomeWindowEnd,
    evaluationDate,
    adPublicationReceipts,
  });
  const decisionRecommendedAt = requiredTimestamp(
    row.decision_recommended_at,
    "decision_recommended_at",
  );
  const decisionSnapshotId = requiredText(
    row.decision_snapshot_id,
    "decision_snapshot_id",
  );
  const evaluationId = requiredText(row.evaluation_id, "evaluation_id");
  const sourceDecisionJobRunId = requiredText(
    row.source_decision_job_run_id,
    "source_decision_job_run_id",
  );
  const engineVersion = requiredText(row.engine_version, "engine_version");
  if (engineVersion !== NATIVE_AD_ENGINE_VERSION) {
    throw new Error("Native outcome source engine epoch is not current.");
  }
  const sourceInputHash = requiredHash(
    row.source_input_hash,
    "source_input_hash",
  );
  const sourceDecisionHash = requiredHash(
    row.source_decision_hash,
    "source_decision_hash",
  );
  const providerAccountRefId = requiredText(
    row.provider_account_ref_id,
    "provider_account_ref_id",
  );
  const creativeId = textOrNull(row.creative_id);
  const scopeType = exactText(row.scope_type, "account", "scope_type");
  const scopeId = exactText(row.scope_id, providerAccountId, "scope_id");
  const label = toDecisionLabel(row.label);
  const candidateActions = jsonArray(row.candidate_action_receipts_json);
  const exactActionReceipts = parseExactNativeAdActionReceipts({
    businessId: businessRefId,
    providerAccountRefId,
    providerAccountId,
    adId,
    creativeId,
    decisionAsOfDate,
    decisionSnapshotId,
    evaluationId,
    engineVersion,
    scopeType,
    scopeId,
    sourceInputHash,
    decisionHash: sourceDecisionHash,
    decisionLabel: label,
    decisionRecommendedAt,
    windowEnd: outcomeWindowEnd,
    evaluationDate,
    receipts: candidateActions,
  });
  const exactReceiptIds = new Set(
    exactActionReceipts.map((action) => action.receiptId),
  );
  if (exactReceiptIds.size !== exactActionReceipts.length) {
    throw new Error("Duplicate immutable native action receipt selected.");
  }
  const invalidActionReceipts = candidateActions.filter((candidate) => {
    const id = textOrNull(record(candidate)?.receiptId);
    return !id || !exactReceiptIds.has(id);
  });
  const verifiedActions = exactActionReceipts.filter(
    (action) => action.treatmentEligible,
  );
  const nonTreatmentActionReceipts = exactActionReceipts.filter(
    (action) => action.definitiveNonTreatment,
  );
  const ambiguousActionReceipts = exactActionReceipts.filter(
    (action) => !action.treatmentEligible && !action.definitiveNonTreatment,
  );
  const stateReceipts = parseStateReceipts(row.state_receipts_json, {
    businessId: businessRefId,
    providerAccountRefId,
    providerAccountId,
    adId,
    evaluationDate,
    windowEnd: outcomeWindowEnd,
  });
  const currencies = new Set(
    facts.map((fact) => normalizeCurrency(fact.accountCurrency)),
  );
  const invalidFactCount = boundedInteger(
    row.invalid_fact_count,
    0,
    Number.MAX_SAFE_INTEGER,
    "invalid_fact_count",
  );
  const invalidFactReceipts = jsonArray(row.invalid_fact_receipts_json);
  if (invalidFactReceipts.length !== invalidFactCount) {
    throw new Error("Native invalid fact receipt count drifted.");
  }
  const currencyStatus =
    currencies.size === 1
      ? "known"
      : currencies.size === 0
        ? "unknown"
        : "conflict";
  const accountCurrency =
    currencyStatus === "known"
      ? (currencies.values().next().value ?? null)
      : null;
  const expectedDayCount = expectedDates.length;
  const completedDayCount = adPublicationReceipts.length;
  if (
    boundedInteger(
      row.expected_day_count,
      0,
      AD_DECISION_OUTCOME_WINDOWS_DAYS.at(-1) ?? 14,
      "expected_day_count",
    ) !== expectedDayCount ||
    boundedInteger(
      row.completed_day_count,
      0,
      expectedDayCount,
      "completed_day_count",
    ) !== completedDayCount ||
    boundedInteger(
      row.fact_currency_count,
      0,
      Number.MAX_SAFE_INTEGER,
      "fact_currency_count",
    ) !== currencies.size
  ) {
    throw new Error("Native outcome source completeness receipt drifted.");
  }
  const windowComplete =
    completedDayCount === expectedDayCount && outcomeWindowEnd < evaluationDate;
  const outcomeSpend = sum(facts.map((fact) => fact.spend));
  const outcomePurchases = sum(facts.map((fact) => fact.purchases));
  const outcomeRevenue = sum(facts.map((fact) => fact.revenue));
  const outcomeRoas = outcomeSpend > 0 ? outcomeRevenue / outcomeSpend : null;
  const zeroSpendExplanation =
    outcomeSpend === 0
      ? explainZeroSpend({
          windowStart: outcomeWindowStart,
          actions: verifiedActions,
          states: stateReceipts,
        })
      : null;

  return {
    decisionSnapshotId,
    evaluationId,
    sourceDecisionJobRunId,
    businessRefId,
    businessId,
    providerAccountId,
    providerAccountRefId,
    decisionEntityType: "ad",
    decisionEntityId,
    adId,
    creativeId,
    decisionAsOfDate,
    evaluationDate,
    sourceCutoffAt: adDecisionOutcomeCutoffAt(evaluationDate),
    outcomeWindowDays,
    outcomeWindowStart,
    outcomeWindowEnd,
    engineVersion,
    scopeType,
    scopeId,
    label,
    rawLabel: toDecisionLabel(row.raw_label),
    confidence: boundedInteger(row.confidence, 0, 100, "confidence"),
    effectiveTargetRoas: requiredFiniteNumber(
      row.effective_target_roas,
      "effective_target_roas",
    ),
    targetRoas: finiteNumberOrNull(row.target_roas),
    breakEvenRoas: finiteNumberOrNull(row.break_even_roas),
    effectiveCohort: textOrNull(row.effective_cohort),
    objective: textOrNull(row.objective),
    optimizationGoal: textOrNull(row.optimization_goal),
    customEventType: textOrNull(row.custom_event_type),
    commercialTargetFreshness: jsonValue(row.commercial_target_freshness_json),
    campaignContext: record(row.campaign_context_json) ?? {},
    evaluationContractVersion: requiredText(
      row.evaluation_contract_version,
      "evaluation_contract_version",
    ),
    baselineSpend: finiteNumberOrNull(row.baseline_spend),
    baselinePurchases: finiteNumberOrNull(row.baseline_purchases),
    baselineRoas: finiteNumberOrNull(row.baseline_roas),
    sourceInputHash,
    sourceDecisionHash,
    decisionRecommendedAt,
    adPublicationReceipts,
    facts,
    exactActionReceipts,
    verifiedActions,
    nonTreatmentActionReceipts,
    ambiguousActionReceipts,
    invalidActionReceipts,
    stateReceipts,
    accountCurrency,
    currencyStatus,
    expectedDayCount,
    completedDayCount,
    windowComplete,
    outcomeSpend,
    outcomePurchases,
    outcomeRevenue,
    outcomeRoas,
    zeroSpendExplanation,
    metricSchemaComplete: facts.every(
      (fact) =>
        fact.metricSchemaVersion >= META_CANONICAL_METRIC_SCHEMA_VERSION,
    ),
    factLineageComplete: invalidFactCount === 0,
    invalidFactCount,
    invalidFactReceipts,
  };
}

function buildAdDecisionOutcomePayload(input: {
  draft: AdDecisionOutcomeDraft;
  controlled: AdDecisionControlledEvidenceResolution;
  outcomeRunId: string;
  jobRunId: string;
  sourceSetHash: string;
  computedAt: string;
}): AdDecisionOutcomePayloadRow {
  const { draft, controlled } = input;
  const classification = classifyAdDecisionOutcome({
    label: draft.label,
    baselineSpend: draft.baselineSpend,
    baselineRoas: draft.baselineRoas,
    targetRoas: draft.targetRoas,
    breakEvenRoas: draft.breakEvenRoas,
    effectiveCohort: draft.effectiveCohort,
    currencyStatus: draft.currencyStatus,
    windowComplete: draft.windowComplete,
    outcomeSpend: draft.outcomeSpend,
    outcomePurchases: draft.outcomePurchases,
    outcomeRevenue: draft.outcomeRevenue,
    outcomeRoas: draft.outcomeRoas,
    zeroSpendExplanation: draft.zeroSpendExplanation,
    metricSchemaComplete: draft.metricSchemaComplete,
    factLineageComplete: draft.factLineageComplete,
    invalidFactCount: draft.invalidFactCount,
    actionLineageComplete: draft.invalidActionReceipts.length === 0,
    invalidActionCount: draft.invalidActionReceipts.length,
    ambiguousActionCount: draft.ambiguousActionReceipts.length,
  });
  const controlledValidated =
    controlled.controlledEvidenceValidated &&
    controlled.treatmentReceiptValidated &&
    controlled.causalAssignmentValidated &&
    controlled.causalEstimateValidated;
  const actionContaminated =
    draft.verifiedActions.length > 0 ||
    draft.ambiguousActionReceipts.length > 0 ||
    draft.invalidActionReceipts.length > 0;
  const treatmentStatus: AdDecisionOutcomeTreatmentStatus = controlledValidated
    ? "controlled_treatment"
    : actionContaminated
      ? "observational_action_exposed"
      : "observational_untreated";
  const adPublicationReceiptsHash = canonicalSha256(
    draft.adPublicationReceipts,
  );
  const factSourceHash = canonicalSha256(draft.facts);
  const invalidFactSourceHash = canonicalSha256(draft.invalidFactReceipts);
  const actionSourceHash = canonicalSha256(draft.exactActionReceipts);
  const verifiedActionSourceHash = canonicalSha256(draft.verifiedActions);
  const nonTreatmentActionSourceHash = canonicalSha256(
    draft.nonTreatmentActionReceipts,
  );
  const ambiguousActionSourceHash = canonicalSha256(
    draft.ambiguousActionReceipts,
  );
  const invalidActionSourceHash = canonicalSha256(draft.invalidActionReceipts);
  const stateSourceHash = canonicalSha256(draft.stateReceipts);
  const controlledSource = {
    registryAvailable: controlled.registryAvailable,
    treatmentReceiptValidated: controlled.treatmentReceiptValidated,
    causalAssignmentValidated: controlled.causalAssignmentValidated,
    causalEstimateValidated: controlled.causalEstimateValidated,
    controlledEvidenceValidated: controlled.controlledEvidenceValidated,
    outcomeLogId: controlled.outcomeLogId,
    invalidReasonCodes: controlled.invalidReasonCodes,
    evidence: controlled.evidence,
  };
  const controlledSourceHash = canonicalSha256(controlledSource);
  const sourceManifest = {
    contractVersion: AD_DECISION_OUTCOME_CONTRACT_VERSION,
    classifierVersion: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
    snapshot: {
      id: draft.decisionSnapshotId,
      evaluationId: draft.evaluationId,
      sourceDecisionJobRunId: draft.sourceDecisionJobRunId,
      recommendedAt: draft.decisionRecommendedAt,
      businessId: draft.businessRefId,
      providerAccountId: draft.providerAccountId,
      providerAccountRefId: draft.providerAccountRefId,
      entityType: draft.decisionEntityType,
      entityId: draft.decisionEntityId,
      adId: draft.adId,
      decisionAsOfDate: draft.decisionAsOfDate,
      engineVersion: draft.engineVersion,
      scopeType: draft.scopeType,
      scopeId: draft.scopeId,
      inputHash: draft.sourceInputHash,
      decisionHash: draft.sourceDecisionHash,
      evaluationContractVersion: draft.evaluationContractVersion,
    },
    window: {
      days: draft.outcomeWindowDays,
      start: draft.outcomeWindowStart,
      end: draft.outcomeWindowEnd,
      sourceCutoffAt: draft.sourceCutoffAt,
    },
    adPublicationReceiptsHash,
    factSourceHash,
    invalidFactSourceHash,
    actionSourceHash,
    verifiedActionSourceHash,
    nonTreatmentActionSourceHash,
    ambiguousActionSourceHash,
    invalidActionSourceHash,
    stateSourceHash,
    controlledSourceHash,
    invalidFactCount: draft.invalidFactCount,
    invalidActionCount: draft.invalidActionReceipts.length,
    ambiguousActionCount: draft.ambiguousActionReceipts.length,
  };
  const sourceManifestHash = canonicalSha256(sourceManifest);
  const commercialContext = {
    effectiveTargetRoas: draft.effectiveTargetRoas,
    targetRoas: draft.targetRoas,
    breakEvenRoas: draft.breakEvenRoas,
    commercialTargetFreshness: draft.commercialTargetFreshness,
  };
  const cohortContext = {
    accountCurrency: draft.accountCurrency,
    currencyStatus: draft.currencyStatus,
    effectiveCohort: draft.effectiveCohort,
    objective: draft.objective,
    optimizationGoal: draft.optimizationGoal,
    customEventType: draft.customEventType,
    campaignContext: draft.campaignContext,
  };
  const sourceReceipts = {
    adDailyPublication: draft.adPublicationReceipts,
    adFacts: draft.facts,
    invalidAdFacts: draft.invalidFactReceipts,
    exactNativeActions: draft.exactActionReceipts,
    verifiedActions: draft.verifiedActions,
    nonTreatmentActions: draft.nonTreatmentActionReceipts,
    ambiguousActions: draft.ambiguousActionReceipts,
    invalidActions: draft.invalidActionReceipts,
    entityStates: draft.stateReceipts,
    invalidFactCount: draft.invalidFactCount,
  };
  return {
    contract_version: AD_DECISION_OUTCOME_CONTRACT_VERSION,
    classifier_version: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
    decision_snapshot_id: draft.decisionSnapshotId,
    evaluation_id: draft.evaluationId,
    source_decision_job_run_id: draft.sourceDecisionJobRunId,
    business_ref_id: draft.businessRefId,
    business_id: draft.businessId,
    provider_account_ref_id: draft.providerAccountRefId,
    provider_account_id: draft.providerAccountId,
    decision_entity_type: draft.decisionEntityType,
    decision_entity_id: draft.decisionEntityId,
    ad_id: draft.adId,
    creative_id: draft.creativeId,
    decision_as_of_date: draft.decisionAsOfDate,
    evaluation_date: draft.evaluationDate,
    source_cutoff_at: draft.sourceCutoffAt,
    outcome_window_days: draft.outcomeWindowDays,
    outcome_window_start: draft.outcomeWindowStart,
    outcome_window_end: draft.outcomeWindowEnd,
    engine_version: draft.engineVersion,
    scope_type: draft.scopeType,
    scope_id: draft.scopeId,
    label: draft.label,
    raw_label: draft.rawLabel,
    confidence: draft.confidence,
    effective_target_roas: draft.effectiveTargetRoas,
    target_roas: draft.targetRoas,
    break_even_roas: draft.breakEvenRoas,
    account_currency: draft.accountCurrency,
    currency_status: draft.currencyStatus,
    effective_cohort: draft.effectiveCohort,
    objective: draft.objective,
    optimization_goal: draft.optimizationGoal,
    custom_event_type: draft.customEventType,
    commercial_context_json: commercialContext,
    cohort_context_json: cohortContext,
    baseline_spend: draft.baselineSpend,
    baseline_purchases: draft.baselinePurchases,
    baseline_roas: draft.baselineRoas,
    outcome_spend: draft.outcomeSpend,
    outcome_purchases: draft.outcomePurchases,
    outcome_revenue: draft.outcomeRevenue,
    outcome_roas: draft.outcomeRoas,
    expected_day_count: draft.expectedDayCount,
    completed_day_count: draft.completedDayCount,
    window_complete: draft.windowComplete,
    measurement_status: classification.measurementStatus,
    realized_outcome: classification.realizedOutcome,
    severity: classification.severity,
    treatment_status: treatmentStatus,
    action_contaminated: actionContaminated,
    controlled_registry_available: controlled.registryAvailable,
    treatment_receipt_validated: controlled.treatmentReceiptValidated,
    causal_assignment_validated: controlled.causalAssignmentValidated,
    causal_estimate_validated: controlled.causalEstimateValidated,
    controlled_evidence_validated: controlledValidated,
    source_input_hash: draft.sourceInputHash,
    source_decision_hash: draft.sourceDecisionHash,
    ad_publication_receipts_hash: adPublicationReceiptsHash,
    fact_source_hash: factSourceHash,
    action_source_hash: actionSourceHash,
    state_source_hash: stateSourceHash,
    controlled_source_hash: controlledSourceHash,
    source_manifest_hash: sourceManifestHash,
    source_receipts_json: sourceReceipts,
    controlled_evidence_json: controlledSource,
    evidence_json: {
      ...classification.evidence,
      sourceManifest,
      sourceManifestHash,
      actionContaminated,
      treatmentStatus,
    },
    outcome_run_id: requiredText(input.outcomeRunId, "outcomeRunId"),
    job_run_id: requiredText(input.jobRunId, "jobRunId"),
    source_set_hash: requiredHash(input.sourceSetHash, "sourceSetHash"),
    computed_at: requiredTimestamp(input.computedAt, "computedAt"),
  };
}

export function classifyAdDecisionOutcome(input: {
  label: DecisionLabel;
  baselineSpend: number | null;
  baselineRoas: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  effectiveCohort: string | null;
  currencyStatus: "known" | "unknown" | "conflict";
  windowComplete: boolean;
  outcomeSpend: number;
  outcomePurchases: number;
  outcomeRevenue: number;
  outcomeRoas: number | null;
  zeroSpendExplanation: Record<string, unknown> | null;
  metricSchemaComplete: boolean;
  factLineageComplete: boolean;
  invalidFactCount: number;
  actionLineageComplete: boolean;
  invalidActionCount: number;
  ambiguousActionCount: number;
}): {
  measurementStatus: AdDecisionOutcomeMeasurementStatus;
  realizedOutcome: AdDecisionRealizedOutcome;
  severity: AdDecisionOutcomeSeverity;
  evidence: Record<string, unknown>;
} {
  const severity = severityFromSpend(input.outcomeSpend, input.baselineSpend);
  const baseEvidence = {
    classifierVersion: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
    label: input.label,
    windowComplete: input.windowComplete,
    effectiveCohort: input.effectiveCohort,
    currencyStatus: input.currencyStatus,
    targetRoas: input.targetRoas,
    breakEvenRoas: input.breakEvenRoas,
    baselineRoas: input.baselineRoas,
    metricSchemaComplete: input.metricSchemaComplete,
    factLineageComplete: input.factLineageComplete,
    invalidFactCount: input.invalidFactCount,
    actionLineageComplete: input.actionLineageComplete,
    invalidActionCount: input.invalidActionCount,
    ambiguousActionCount: input.ambiguousActionCount,
    outcome: {
      spend: input.outcomeSpend,
      purchases: input.outcomePurchases,
      revenue: input.outcomeRevenue,
      roas: input.outcomeRoas,
    },
  };
  if (!input.windowComplete) {
    return unknownClassification(
      "missing_ad_daily_publication_receipts",
      baseEvidence,
    );
  }
  if (!input.factLineageComplete) {
    return unknownClassification("ad_fact_lineage_invalid", baseEvidence);
  }
  if (!input.actionLineageComplete) {
    return unknownClassification("action_lineage_invalid", baseEvidence);
  }
  if (input.ambiguousActionCount > 0) {
    return unknownClassification(
      "action_treatment_state_unresolved",
      baseEvidence,
    );
  }
  if (input.outcomeSpend === 0) {
    if (input.zeroSpendExplanation) {
      return {
        measurementStatus: "explained_zero_spend",
        realizedOutcome: "unknown",
        severity: "low",
        evidence: {
          ...baseEvidence,
          rule: "zero_spend_explained_by_exact_receipt",
          zeroSpendExplanation: input.zeroSpendExplanation,
          causalEffectClaimed: false,
        },
      };
    }
    return {
      measurementStatus: "censored",
      realizedOutcome: "unknown",
      severity: "low",
      evidence: {
        ...baseEvidence,
        rule: "zero_spend_censored_without_exact_receipt",
        causalEffectClaimed: false,
      },
    };
  }
  if (!input.metricSchemaComplete) {
    return unknownClassification("metric_schema_unproven", baseEvidence);
  }
  if (input.currencyStatus !== "known") {
    return unknownClassification("currency_context_unresolved", baseEvidence);
  }
  if (input.effectiveCohort !== "purchase") {
    return unknownClassification(
      "roas_outcome_unsupported_for_cohort",
      baseEvidence,
    );
  }
  if (input.outcomeRoas === null) {
    return unknownClassification("positive_spend_roas_missing", baseEvidence);
  }

  const target = positiveNumberOrNull(input.targetRoas);
  const breakEven = positiveNumberOrNull(input.breakEvenRoas);
  const roas = input.outcomeRoas;
  if (input.label === "scale") {
    if (target === null)
      return unknownClassification("scale_target_missing", baseEvidence);
    if (roas >= target && input.outcomePurchases > 0) {
      return knownClassification(
        "positive",
        severity,
        "scale_held_above_target",
        baseEvidence,
      );
    }
    if (breakEven !== null && roas < breakEven) {
      return knownClassification(
        "negative",
        severity,
        "scale_fell_below_break_even",
        baseEvidence,
      );
    }
    return knownClassification(
      "neutral",
      severity,
      "scale_between_commercial_anchors",
      baseEvidence,
    );
  }
  if (input.label === "cut") {
    if (breakEven === null) {
      return unknownClassification("cut_break_even_missing", baseEvidence);
    }
    if (roas < breakEven) {
      return knownClassification(
        "positive",
        severity,
        "cut_loss_continued",
        baseEvidence,
      );
    }
    return knownClassification(
      "negative",
      severity,
      "cut_recovered_above_break_even",
      baseEvidence,
    );
  }
  if (input.label === "refresh") {
    if (target === null || breakEven === null) {
      return unknownClassification("refresh_anchor_missing", baseEvidence);
    }
    if (roas < breakEven) {
      return knownClassification(
        "positive",
        severity,
        "refresh_loss_continued_below_break_even",
        baseEvidence,
      );
    }
    if (roas >= target) {
      return knownClassification(
        "negative",
        severity,
        "refresh_recovered_above_target",
        baseEvidence,
      );
    }
    return knownClassification(
      "neutral",
      severity,
      "refresh_inconclusive",
      baseEvidence,
    );
  }

  if (target === null && breakEven === null) {
    return unknownClassification("commercial_anchors_missing", baseEvidence);
  }
  const comparableSpend = positiveNumberOrNull(input.baselineSpend);
  if (comparableSpend === null) {
    return unknownClassification("opportunity_maturity_missing", baseEvidence);
  }
  if (input.outcomeSpend < comparableSpend) {
    return knownClassification(
      "neutral",
      severity,
      "non_hard_insufficient_comparable_exposure",
      baseEvidence,
    );
  }
  if (target !== null && roas >= target && input.outcomePurchases > 0) {
    return knownClassification(
      "positive",
      severity,
      "non_hard_missed_scale_opportunity",
      baseEvidence,
    );
  }
  if (breakEven !== null && roas < breakEven) {
    return knownClassification(
      "positive",
      severity,
      "non_hard_missed_cut_opportunity",
      baseEvidence,
    );
  }
  return knownClassification(
    "neutral",
    severity,
    "non_hard_no_missed_hard_action",
    baseEvidence,
  );
}

function knownClassification(
  realizedOutcome: Exclude<AdDecisionRealizedOutcome, "unknown">,
  severity: AdDecisionOutcomeSeverity,
  rule: string,
  evidence: Record<string, unknown>,
) {
  return {
    measurementStatus: "known" as const,
    realizedOutcome,
    severity,
    evidence: { ...evidence, rule },
  };
}

function unknownClassification(
  rule: string,
  evidence: Record<string, unknown>,
) {
  return {
    measurementStatus: "unknown" as const,
    realizedOutcome: "unknown" as const,
    severity: "low" as const,
    evidence: { ...evidence, rule },
  };
}

function explainZeroSpend(input: {
  windowStart: string;
  actions: readonly NativeAdActionReceipt[];
  states: readonly AdStateReceipt[];
}): Record<string, unknown> | null {
  const windowStart = `${input.windowStart}T00:00:00.000Z`;
  const statusActions = input.actions.filter(
    (receipt) => receipt.action === "pause" || receipt.action === "resume",
  );
  const lastStatusActionBeforeWindow = statusActions
    .filter((receipt) => receipt.finalizedAt <= windowStart)
    .at(-1);
  const resumedAfterPause =
    lastStatusActionBeforeWindow?.action === "pause" &&
    statusActions.some(
      (receipt) =>
        receipt.action === "resume" &&
        receipt.finalizedAt > lastStatusActionBeforeWindow.finalizedAt,
    );
  if (lastStatusActionBeforeWindow?.action === "pause" && !resumedAfterPause) {
    return {
      source: "provider_verified_action",
      actionLogId: lastStatusActionBeforeWindow.id,
      actionReceiptId: lastStatusActionBeforeWindow.receiptId,
      action: "pause",
      finalizedAt: lastStatusActionBeforeWindow.finalizedAt,
    };
  }

  const stateAtStart = input.states
    .filter((receipt) => receipt.observedAt <= windowStart)
    .at(-1);
  const laterDeliverableState = input.states.some(
    (receipt) =>
      receipt.observedAt > windowStart &&
      isDeliverableStatus(receipt.effectiveStatus),
  );
  if (
    stateAtStart &&
    isNonDeliveringStatus(
      stateAtStart.effectiveStatus ?? stateAtStart.configuredStatus,
    ) &&
    !laterDeliverableState
  ) {
    return {
      source: "entity_state_history",
      stateReceiptId: stateAtStart.id,
      stateHash: stateAtStart.stateHash,
      status: stateAtStart.effectiveStatus ?? stateAtStart.configuredStatus,
      observedAt: stateAtStart.observedAt,
    };
  }
  return null;
}

function isDeliverableStatus(value: string | null) {
  return value?.trim().toUpperCase() === "ACTIVE";
}

function isNonDeliveringStatus(value: string | null) {
  const status = value?.trim().toUpperCase() ?? "";
  return [
    "PAUSED",
    "DELETED",
    "ARCHIVED",
    "REJECTED",
    "DISAPPROVED",
    "CAMPAIGN_PAUSED",
    "ADSET_PAUSED",
  ].includes(status);
}

function parseAdPublicationReceipts(
  value: unknown,
  expectedDates: readonly string[],
  evaluationDate: string,
) {
  const expected = new Set(expectedDates);
  const evaluationEndExclusive = adDecisionOutcomeCutoffAt(evaluationDate);
  const byDate = new Map<string, AdDecisionAdPublicationReceipt>();
  for (const item of jsonArray(value)) {
    const row = record(item);
    if (!row) continue;
    const date = dateOrNull(row.date);
    const pointerId = textOrNull(row.pointerId);
    const sliceVersionId = textOrNull(row.sliceVersionId);
    const manifestId = textOrNull(row.manifestId);
    const sourceRunId = textOrNull(row.sourceRunId);
    const publishedAt = timestampOrNull(row.publishedAt);
    const dayCompleteAt = date ? `${addIsoDays(date, 1)}T00:00:00.000Z` : null;
    if (
      !date ||
      !expected.has(date) ||
      !pointerId ||
      !sliceVersionId ||
      !manifestId ||
      !sourceRunId ||
      !publishedAt ||
      !dayCompleteAt ||
      publishedAt < dayCompleteAt ||
      publishedAt >= evaluationEndExclusive ||
      row.state !== "finalized_verified" ||
      row.truthState !== "finalized" ||
      row.validationStatus !== "passed" ||
      row.status !== "published" ||
      byDate.has(date)
    ) {
      continue;
    }
    byDate.set(date, {
      date,
      pointerId,
      sliceVersionId,
      manifestId,
      sourceRunId,
      state: "finalized_verified",
      truthState: "finalized",
      validationStatus: "passed",
      status: "published",
      publishedAt,
    });
  }
  return Array.from(byDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

function parseFactReceipts(
  value: unknown,
  window: {
    start: string;
    end: string;
    evaluationDate: string;
    adPublicationReceipts: readonly AdDecisionAdPublicationReceipt[];
  },
): AdDecisionFactReceipt[] {
  const rows: AdDecisionFactReceipt[] = [];
  const ids = new Set<string>();
  const dates = new Set<string>();
  const adPublicationReceiptByDate = new Map(
    window.adPublicationReceipts.map(
      (receipt) => [receipt.date, receipt] as const,
    ),
  );
  const evaluationEndExclusive = adDecisionOutcomeCutoffAt(
    window.evaluationDate,
  );
  for (const item of jsonArray(value)) {
    const row = record(item);
    if (!row) throw new Error("Malformed finalized ad fact receipt.");
    const id = requiredText(row.id, "fact.id");
    const date = requiredDate(row.date, "fact.date");
    const adPublicationReceipt = adPublicationReceiptByDate.get(date);
    const sourceRunId = textOrNull(row.sourceRunId);
    const finalizedAt = timestampOrNull(row.finalizedAt);
    const updatedAt = timestampOrNull(row.updatedAt);
    if (
      ids.has(id) ||
      dates.has(date) ||
      date < window.start ||
      date > window.end ||
      !adPublicationReceipt ||
      !sourceRunId ||
      sourceRunId !== adPublicationReceipt.sourceRunId ||
      !finalizedAt ||
      !updatedAt ||
      finalizedAt > adPublicationReceipt.publishedAt ||
      updatedAt > adPublicationReceipt.publishedAt ||
      finalizedAt >= evaluationEndExclusive ||
      updatedAt >= evaluationEndExclusive ||
      row.truthState !== "finalized" ||
      row.validationStatus !== "passed"
    ) {
      throw new Error("Finalized ad fact lineage is duplicate or invalid.");
    }
    ids.add(id);
    dates.add(date);
    rows.push({
      id,
      date,
      accountCurrency: normalizeCurrency(
        requiredText(row.accountCurrency, "fact.accountCurrency"),
      ),
      spend: nonNegativeNumber(row.spend, "fact.spend"),
      purchases: nonNegativeNumber(row.purchases, "fact.purchases"),
      revenue: nonNegativeNumber(row.revenue, "fact.revenue"),
      truthState: "finalized",
      truthVersion: boundedInteger(
        row.truthVersion,
        1,
        Number.MAX_SAFE_INTEGER,
        "fact.truthVersion",
      ),
      finalizedAt,
      validationStatus: "passed",
      sourceRunId,
      sourceSnapshotId: textOrNull(row.sourceSnapshotId),
      metricSchemaVersion: boundedInteger(
        row.metricSchemaVersion,
        1,
        Number.MAX_SAFE_INTEGER,
        "fact.metricSchemaVersion",
      ),
      updatedAt,
    });
  }
  return rows.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  );
}

function parseStateReceipts(
  value: unknown,
  identity: {
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    adId: string;
    evaluationDate: string;
    windowEnd: string;
  },
): AdStateReceipt[] {
  const evaluationEnd = adDecisionOutcomeCutoffAt(identity.evaluationDate);
  const windowEnd = `${addIsoDays(identity.windowEnd, 1)}T00:00:00.000Z`;
  return jsonArray(value)
    .flatMap((item) => {
      const row = record(item);
      const observedAt = timestampOrNull(row?.observedAt);
      const capturedAt = timestampOrNull(row?.capturedAt);
      if (
        !row ||
        row.businessId !== identity.businessId ||
        row.providerAccountRefId !== identity.providerAccountRefId ||
        row.providerAccountId !== identity.providerAccountId ||
        row.entityType !== "ad" ||
        row.entityId !== identity.adId ||
        (row.runCompleteness !== "complete" &&
          row.runCompleteness !== "point_lookup") ||
        !observedAt ||
        !capturedAt ||
        capturedAt < observedAt ||
        observedAt >= windowEnd ||
        capturedAt >= evaluationEnd
      ) {
        return [];
      }
      const runCompleteness = row.runCompleteness as
        "complete" | "point_lookup";
      return [
        {
          id: requiredText(row.id, "stateReceipt.id"),
          businessId: identity.businessId,
          providerAccountRefId: identity.providerAccountRefId,
          providerAccountId: identity.providerAccountId,
          entityType: "ad" as const,
          entityId: identity.adId,
          configuredStatus: textOrNull(row.configuredStatus),
          effectiveStatus: textOrNull(row.effectiveStatus),
          presence: requiredText(row.presence, "stateReceipt.presence"),
          observedAt,
          capturedAt,
          runCompleteness,
          stateHash: requiredHash(row.stateHash, "stateReceipt.stateHash"),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.capturedAt.localeCompare(right.capturedAt) ||
        left.id.localeCompare(right.id),
    );
}

function normalizeAccrualInput(input: AccrueAdDecisionOutcomesInput) {
  const windowsDays = input.windowsDays ?? AD_DECISION_OUTCOME_WINDOWS_DAYS;
  const uniqueWindows = Array.from(new Set(windowsDays));
  if (
    uniqueWindows.length === 0 ||
    uniqueWindows.length !== windowsDays.length ||
    uniqueWindows.some(
      (window) => !AD_DECISION_OUTCOME_WINDOWS_DAYS.includes(window),
    )
  ) {
    throw new TypeError(
      "Outcome windows must be unique members of 3d, 7d, and 14d.",
    );
  }
  const lookbackDays = boundedInteger(
    input.lookbackDays ?? AD_DECISION_OUTCOME_LOOKBACK_DAYS,
    1,
    3650,
    "lookbackDays",
  );
  const minimumLookbackDays = Math.max(...uniqueWindows) + 1;
  if (lookbackDays < minimumLookbackDays) {
    throw new TypeError(
      `Outcome lookback must be at least ${minimumLookbackDays} days for the requested windows.`,
    );
  }
  return {
    businessId: requiredText(input.businessId, "businessId"),
    evaluationDate: requiredDate(input.evaluationDate, "evaluationDate"),
    jobRunId: requiredText(input.jobRunId, "jobRunId"),
    windowsDays: uniqueWindows.sort((left, right) => left - right),
    lookbackDays,
    batchLimit: boundedInteger(
      input.batchLimit ?? AD_DECISION_OUTCOME_BATCH_LIMIT,
      1,
      AD_DECISION_OUTCOME_BATCH_LIMIT,
      "batchLimit",
    ),
  };
}

function assertCompleteSourceSet(
  rows: readonly AdDecisionOutcomeSourceRow[],
  batchLimit: number,
) {
  if (rows.length === 0) return;
  const totals = new Set(
    rows.map((row) =>
      boundedInteger(
        row.total_candidate_count,
        1,
        Number.MAX_SAFE_INTEGER,
        "total_candidate_count",
      ),
    ),
  );
  if (totals.size !== 1) {
    throw new Error("Native outcome source count proof is inconsistent.");
  }
  const total = totals.values().next().value;
  if (total === undefined || total > batchLimit || rows.length !== total) {
    throw new Error(
      `Native outcome source set is incomplete: selected=${rows.length}, total=${String(total)}, limit=${batchLimit}.`,
    );
  }
}

function canonicalOutcomeSourceSetHash(input: {
  businessId: string;
  evaluationDate: string;
  windowsDays: readonly AdDecisionOutcomeWindowDays[];
  lookbackDays: number;
  rows: readonly AdDecisionOutcomePayloadRow[];
}) {
  return canonicalSha256({
    contractVersion: AD_DECISION_OUTCOME_CONTRACT_VERSION,
    classifierVersion: AD_DECISION_OUTCOME_CLASSIFIER_VERSION,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    businessId: input.businessId,
    evaluationDate: input.evaluationDate,
    windowsDays: [...input.windowsDays].sort((left, right) => left - right),
    lookbackDays: input.lookbackDays,
    rows: input.rows
      .map((row) => ({
        decisionSnapshotId: row.decision_snapshot_id,
        evaluationId: row.evaluation_id,
        sourceDecisionJobRunId: row.source_decision_job_run_id,
        providerAccountRefId: row.provider_account_ref_id,
        providerAccountId: row.provider_account_id,
        adId: row.ad_id,
        decisionAsOfDate: row.decision_as_of_date,
        outcomeWindowDays: row.outcome_window_days,
        sourceManifestHash: row.source_manifest_hash,
      }))
      .sort((left, right) =>
        [
          left.decisionAsOfDate,
          left.providerAccountId,
          left.adId,
          String(left.outcomeWindowDays).padStart(2, "0"),
          left.decisionSnapshotId,
          left.evaluationId,
        ]
          .join("\u0000")
          .localeCompare(
            [
              right.decisionAsOfDate,
              right.providerAccountId,
              right.adId,
              String(right.outcomeWindowDays).padStart(2, "0"),
              right.decisionSnapshotId,
              right.evaluationId,
            ].join("\u0000"),
          ),
      ),
  });
}

function mapAndValidateOutcomeRun(
  row: Record<string, unknown> | undefined,
  expected: ReturnType<typeof normalizeAccrualInput> & {
    sourceSetHash: string;
    candidateRowCount: number;
  },
) {
  if (!row) throw new Error("Native outcome run insert returned no row.");
  const id = requiredText(row.id, "outcomeRun.id");
  const status = requiredText(row.status, "outcomeRun.status");
  const windows = integerArray(row.windows_days).sort(
    (left, right) => left - right,
  );
  if (
    requiredText(row.job_run_id, "outcomeRun.jobRunId") !== expected.jobRunId ||
    requiredText(row.business_ref_id, "outcomeRun.businessId") !==
      expected.businessId ||
    requiredDate(row.evaluation_date, "outcomeRun.evaluationDate") !==
      expected.evaluationDate ||
    requiredText(row.engine_version, "outcomeRun.engineVersion") !==
      NATIVE_AD_ENGINE_VERSION ||
    requiredText(row.contract_version, "outcomeRun.contractVersion") !==
      AD_DECISION_OUTCOME_CONTRACT_VERSION ||
    requiredText(row.classifier_version, "outcomeRun.classifierVersion") !==
      AD_DECISION_OUTCOME_CLASSIFIER_VERSION ||
    JSON.stringify(windows) !== JSON.stringify(expected.windowsDays) ||
    boundedInteger(row.lookback_days, 1, 3650, "outcomeRun.lookbackDays") !==
      expected.lookbackDays ||
    boundedInteger(
      row.candidate_row_count,
      0,
      AD_DECISION_OUTCOME_BATCH_LIMIT,
      "outcomeRun.candidateRowCount",
    ) !== expected.candidateRowCount ||
    requiredHash(row.source_set_hash, "outcomeRun.sourceSetHash") !==
      expected.sourceSetHash ||
    (status !== "pending" && status !== "complete")
  ) {
    throw new Error(
      "Native outcome run identity or completeness proof drifted.",
    );
  }
  if (
    status === "complete" &&
    boundedInteger(
      row.persisted_row_count,
      0,
      AD_DECISION_OUTCOME_BATCH_LIMIT,
      "outcomeRun.persistedRowCount",
    ) !== expected.candidateRowCount
  ) {
    throw new Error("Completed native outcome run has a stale row count.");
  }
  return { id, status };
}

function validateFinalizedOutcomeRun(
  row: Record<string, unknown> | undefined,
  expected: {
    outcomeRunId: string;
    sourceSetHash: string;
    candidateRowCount: number;
    publishedWindowCount: number;
  },
) {
  if (!row) {
    throw new Error("Native outcome run did not finalize atomically.");
  }
  const publishedWindowCount = boundedInteger(
    row.published_window_count,
    0,
    AD_DECISION_OUTCOME_WINDOWS_DAYS.length,
    "published_window_count",
  );
  if (
    requiredText(row.id, "finalizedRun.id") !== expected.outcomeRunId ||
    row.status !== "complete" ||
    boundedInteger(
      row.candidate_row_count,
      0,
      AD_DECISION_OUTCOME_BATCH_LIMIT,
      "finalizedRun.candidateRowCount",
    ) !== expected.candidateRowCount ||
    boundedInteger(
      row.persisted_row_count,
      0,
      AD_DECISION_OUTCOME_BATCH_LIMIT,
      "finalizedRun.persistedRowCount",
    ) !== expected.candidateRowCount ||
    requiredHash(row.source_set_hash, "finalizedRun.sourceSetHash") !==
      expected.sourceSetHash ||
    publishedWindowCount !== expected.publishedWindowCount
  ) {
    throw new Error("Native outcome run publication proof is incomplete.");
  }
  return { publishedWindowCount };
}

function assertUniqueDrafts(drafts: readonly AdDecisionOutcomeDraft[]) {
  const keys = new Set<string>();
  for (const draft of drafts) {
    const key = draftKey(draft);
    if (keys.has(key)) {
      throw new Error(`Duplicate native outcome source: ${key}`);
    }
    keys.add(key);
  }
}

function draftKey(draft: AdDecisionOutcomeDraft) {
  return `${draft.decisionSnapshotId}\u0000${draft.evaluationId}\u0000${draft.outcomeWindowDays}`;
}

function mapStoredOutcome(
  row: Record<string, unknown>,
): StoredAdDecisionOutcome {
  return {
    id: requiredText(row.id, "storedOutcome.id"),
    outcomeRunId: requiredText(
      row.outcome_run_id,
      "storedOutcome.outcomeRunId",
    ),
    decisionSnapshotId: requiredText(
      row.decision_snapshot_id,
      "storedOutcome.decisionSnapshotId",
    ),
    evaluationId: requiredText(row.evaluation_id, "storedOutcome.evaluationId"),
    sourceSetHash: requiredHash(
      row.source_set_hash,
      "storedOutcome.sourceSetHash",
    ),
    sourceManifestHash: requiredHash(
      row.source_manifest_hash,
      "storedOutcome.sourceManifestHash",
    ),
    inserted: row.inserted === true,
  };
}

const defaultQuery: AdDecisionOutcomeQuery = async <
  Row extends Record<string, unknown>,
>(
  queryText: string,
  params?: readonly unknown[],
) => getDb().query<Row>(queryText, params ? [...params] : undefined);

const defaultControlledEvidenceReader: ControlledEvidenceReader = async (
  input,
) => {
  const candidate = (
    controlledExperimentRegistry as unknown as Record<string, unknown>
  ).readVerifiedControlledEvidenceForOutcomes;
  if (typeof candidate !== "function") {
    throw new ControlledRegistrySchemaError({
      ready: false,
      issues: ["readVerifiedControlledEvidenceForOutcomes export unavailable"],
    });
  }
  return (candidate as ControlledEvidenceReader)(input);
};

function severityFromSpend(
  outcomeSpend: number,
  baselineSpend: number | null,
): AdDecisionOutcomeSeverity {
  const baseline = positiveNumberOrNull(baselineSpend);
  if (baseline === null) return "low";
  if (outcomeSpend >= baseline) return "critical";
  if (outcomeSpend >= baseline * 0.5) return "high";
  if (outcomeSpend >= baseline * 0.25) return "medium";
  return "low";
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function integerArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid native outcome integer array.");
  }
  return value.map((entry, index) =>
    boundedInteger(
      entry,
      1,
      AD_DECISION_OUTCOME_WINDOWS_DAYS.at(-1) ?? 14,
      `integerArray[${index}]`,
    ),
  );
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function textOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredText(value: unknown, field: string): string {
  const text = textOrNull(value);
  if (!text) throw new Error(`Missing native outcome field: ${field}`);
  return text;
}

function exactText(value: unknown, expected: string, field: string) {
  const actual = requiredText(value, field);
  if (actual !== expected) {
    throw new Error(`Unexpected native outcome field: ${field}`);
  }
  return actual;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function requiredFiniteNumber(value: unknown, field: string) {
  const parsed = finiteNumberOrNull(value);
  if (parsed === null)
    throw new Error(`Invalid native outcome number: ${field}`);
  return parsed;
}

function nonNegativeNumber(value: unknown, field: string) {
  const parsed = requiredFiniteNumber(value, field);
  if (parsed < 0) throw new Error(`Negative native outcome number: ${field}`);
  return parsed;
}

function positiveNumberOrNull(value: number | null) {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  field: string,
) {
  const parsed = finiteNumberOrNull(value);
  if (
    parsed === null ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    throw new Error(`Invalid native outcome integer: ${field}`);
  }
  return parsed;
}

function dateOrNull(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = textOrNull(value)?.slice(0, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text
    ? text
    : null;
}

function requiredDate(value: unknown, field: string) {
  const date = dateOrNull(value);
  if (!date) throw new Error(`Invalid native outcome date: ${field}`);
  return date;
}

function timestampOrNull(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const text = textOrNull(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function requiredTimestamp(value: unknown, field: string) {
  const timestamp = timestampOrNull(value);
  if (!timestamp) throw new Error(`Invalid native outcome timestamp: ${field}`);
  return timestamp;
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid native outcome boolean: ${field}`);
  }
  return value;
}

function requiredHash(value: unknown, field: string) {
  const hash = hashOrNull(value);
  if (!hash) {
    throw new Error(`Invalid native outcome hash: ${field}`);
  }
  return hash;
}

function hashOrNull(value: unknown) {
  const hash = textOrNull(value)?.toLowerCase() ?? null;
  return hash && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function toDecisionLabel(value: unknown): DecisionLabel {
  const label = requiredText(value, "decision_label");
  if (
    label === "scale" ||
    label === "keep" ||
    label === "refresh" ||
    label === "cut" ||
    label === "test_more" ||
    label === "diagnose" ||
    label === "out_of_scope"
  ) {
    return label;
  }
  throw new Error(`Unexpected native decision label: ${label}`);
}

function toOutcomeWindowDays(value: unknown): AdDecisionOutcomeWindowDays {
  const window = boundedInteger(value, 1, 14, "outcome_window_days");
  if (window === 3 || window === 7 || window === 14) return window;
  throw new Error(`Unsupported native outcome window: ${window}`);
}

function normalizeCurrency(value: string) {
  const currency = value.trim().toUpperCase();
  if (!currency) throw new Error("Native outcome currency is empty.");
  return currency;
}

function addIsoDays(date: string, days: number): string {
  const parsed = new Date(`${requiredDate(date, "date")}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function adDecisionOutcomeCutoffAt(evaluationDate: string) {
  const date = requiredDate(evaluationDate, "evaluationDate");
  return `${date}T${String(AD_DECISION_OUTCOME_CUTOFF_UTC_HOUR).padStart(2, "0")}:00:00.000Z`;
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let current = start; current <= end; current = addIsoDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

function sameIsoDate(value: string | null | undefined, expected: string) {
  return dateOrNull(value) === expected;
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
