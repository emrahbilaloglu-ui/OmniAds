# D047 Native Ad Decision Parallel Schema Contract

Date: 2026-07-12

Status: runtime and migration-input SQL complete; migration intentionally pending.

Executable CREATE, idempotent ALTER, and index migration input is exported from
`lib/creative-decision-engine/ad-evaluation-schema.ts`. The capability gate and
that SQL share the same columns, nullable rules, constraint names, and ordered
unique-index signatures.

The native producer is `engine_v3_native_ad_decisions_shadow_job` and uses
`v3-ad-2026-07-12-native-provenance-shadow`. It must not read, write, prune, or
share uniqueness with the legacy creative decision authority tables.

## Tables

### `engine_v3_ad_decision_evaluation_contexts`

Required columns:

| Column                 | Type / nullability                           |
| ---------------------- | -------------------------------------------- |
| `id`                   | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `business_ref_id`      | `UUID NOT NULL`                              |
| `business_id`          | `TEXT NOT NULL`                              |
| `as_of_date`           | `DATE NOT NULL`                              |
| `engine_version`       | `TEXT NOT NULL`                              |
| `scope_type`           | `TEXT NOT NULL`                              |
| `scope_id`             | `TEXT NOT NULL`                              |
| `contract_version`     | `TEXT NOT NULL`                              |
| `context_json`         | `JSONB NOT NULL`                             |
| `account_profile_json` | `JSONB NOT NULL`                             |
| `data_health_json`     | `JSONB NOT NULL`                             |
| `flags_json`           | `JSONB NOT NULL`                             |
| `context_hash`         | `CHAR(64) NOT NULL`                          |
| `job_run_id`           | `UUID NOT NULL`                              |
| `evaluated_at`         | `TIMESTAMPTZ NOT NULL`                       |
| `created_at`           | `TIMESTAMPTZ NOT NULL DEFAULT now()`         |

Constraints and indexes:

- `business_ref_id -> businesses(id) ON DELETE RESTRICT`.
- `job_run_id -> engine_v3_job_runs(id) ON DELETE RESTRICT`.
- `engine_v3_ad_eval_contexts_run_scope_hash_unique` on
  `(job_run_id, business_ref_id, as_of_date, engine_version, scope_type,
scope_id, context_hash)`.
- A lineage unique constraint on
  `(id, business_ref_id, as_of_date, engine_version, scope_type, scope_id,
contract_version, job_run_id)`.
- Lookup indexes on
  `(business_ref_id, as_of_date DESC, engine_version, scope_type, scope_id,
evaluated_at DESC)` and `(job_run_id, evaluated_at DESC)`.

### `engine_v3_ad_decision_evaluations`

Required columns:

| Column                  | Type / nullability                           |
| ----------------------- | -------------------------------------------- |
| `id`                    | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `context_id`            | `UUID NOT NULL`                              |
| `business_ref_id`       | `UUID NOT NULL`                              |
| `business_id`           | `TEXT NOT NULL`                              |
| `provider_account_id`   | `TEXT NOT NULL`                              |
| `decision_entity_type`  | `TEXT NOT NULL CHECK (... = 'ad')`           |
| `decision_entity_id`    | `TEXT NOT NULL`                              |
| `ad_id`                 | `TEXT NOT NULL`                              |
| `creative_id`           | `TEXT NULL` (grouping only)                  |
| `as_of_date`            | `DATE NOT NULL`                              |
| `engine_version`        | `TEXT NOT NULL`                              |
| `scope_type`            | `TEXT NOT NULL`                              |
| `scope_id`              | `TEXT NOT NULL`                              |
| `contract_version`      | `TEXT NOT NULL`                              |
| `creative_input_json`   | `JSONB NOT NULL`                             |
| `campaign_context_json` | `JSONB NOT NULL`                             |
| `prior_hysteresis_json` | `JSONB NOT NULL`                             |
| `decision_output_json`  | `JSONB NOT NULL`                             |
| `raw_label`             | `TEXT NOT NULL`                              |
| `hysteresis_suppressed` | `BOOLEAN NOT NULL DEFAULT FALSE`             |
| `input_hash`            | `CHAR(64) NOT NULL`                          |
| `decision_hash`         | `CHAR(64) NOT NULL`                          |
| `job_run_id`            | `UUID NOT NULL`                              |
| `evaluated_at`          | `TIMESTAMPTZ NOT NULL`                       |
| `created_at`            | `TIMESTAMPTZ NOT NULL DEFAULT now()`         |

Constraints and indexes:

- `CHECK (decision_entity_id = ad_id)` and non-empty identity checks.
- Business and job-run FKs with `ON DELETE RESTRICT`.
- `engine_v3_ad_evaluations_context_lineage_fk`: composite FK from
  `(context_id, business_ref_id, as_of_date, engine_version, scope_type,
scope_id, contract_version, job_run_id)` to the context lineage unique key.
- Unique immutable evaluation key on
  `(context_id, provider_account_id, decision_entity_type,
decision_entity_id, input_hash, decision_hash)`.
- A snapshot-lineage unique key on
  `(id, business_ref_id, provider_account_id, decision_entity_type,
decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id,
input_hash, decision_hash)`.
- Timeline index on
  `(business_ref_id, provider_account_id, decision_entity_type,
decision_entity_id, as_of_date DESC, evaluated_at DESC)`.

### `engine_v3_ad_decision_snapshots_daily`

Required columns:

| Column                                        | Type / nullability                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                                          | `UUID PRIMARY KEY DEFAULT gen_random_uuid()`                            |
| `business_ref_id`                             | `UUID NOT NULL`                                                         |
| `business_id`                                 | `TEXT NOT NULL`                                                         |
| `provider_account_id`                         | `TEXT NOT NULL`                                                         |
| `decision_entity_type`                        | `TEXT NOT NULL CHECK (... = 'ad')`                                      |
| `decision_entity_id`                          | `TEXT NOT NULL`                                                         |
| `ad_id`                                       | `TEXT NOT NULL`                                                         |
| `creative_id`                                 | `TEXT NULL` (grouping only)                                             |
| `as_of_date`                                  | `DATE NOT NULL`                                                         |
| `engine_version`                              | `TEXT NOT NULL`                                                         |
| `scope_type`                                  | `TEXT NOT NULL`                                                         |
| `scope_id`                                    | `TEXT NOT NULL`                                                         |
| `label`, `raw_label`                          | decision-label `TEXT NOT NULL`                                          |
| `confidence`                                  | `INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100)`                 |
| `truth_source`                                | truth-source `TEXT NOT NULL`                                            |
| `effective_target_roas`                       | `DOUBLE PRECISION NOT NULL`                                             |
| `ratio_to_target`                             | `DOUBLE PRECISION NULL`                                                 |
| `badges`                                      | `JSONB NOT NULL DEFAULT '[]'::jsonb`                                    |
| `reason`                                      | `TEXT NOT NULL`                                                         |
| `spend`, `purchases`, `roas`, `recent7d_roas` | `DOUBLE PRECISION NULL` except producer always supplies spend/purchases |
| `label_transform`, `blocked_action_type`      | `TEXT NULL` with existing checks                                        |
| `job_run_id`                                  | `UUID NOT NULL`                                                         |
| `lifecycle_row_id`, `calibration_row_id`      | `UUID NULL`; calibration is null only for explicit soft-only rows        |
| `evaluation_id`                               | `UUID NOT NULL`                                                         |
| `input_hash`, `decision_hash`                 | `CHAR(64) NOT NULL`                                                     |
| `computed_at`                                 | `TIMESTAMPTZ NOT NULL`                                                  |
| `created_at`, `updated_at`                    | `TIMESTAMPTZ NOT NULL DEFAULT now()`                                    |

Constraints and indexes:

- `CHECK (decision_entity_id = ad_id)` and the existing decision enum checks.
- Identity unique key on
  `(business_ref_id, provider_account_id, decision_entity_type,
decision_entity_id, as_of_date, engine_version, scope_type, scope_id)`.
- Unique index on `evaluation_id`.
- `engine_v3_ad_snapshots_evaluation_lineage_fk`: composite FK from
  `(evaluation_id, business_ref_id, provider_account_id,
decision_entity_type, decision_entity_id, ad_id, as_of_date,
engine_version, scope_type, scope_id, input_hash, decision_hash)` to the
  evaluation snapshot-lineage unique key, `ON DELETE RESTRICT`.
- FKs to business, job run, and native ad calibration rows. Lifecycle is an
  unowned evidence identifier with no legacy-table FK. Evaluation is always
  `RESTRICT`; native calibration is `SET NULL` for retained soft-only history.
- Business/day/label and native entity timeline indexes.

### `engine_v3_ad_decision_events`

Required columns:

| Column                                      | Type / nullability                           |
| ------------------------------------------- | -------------------------------------------- |
| `id`                                        | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `business_ref_id`                           | `UUID NOT NULL`                              |
| `business_id`                               | `TEXT NOT NULL`                              |
| `provider_account_id`                       | `TEXT NOT NULL`                              |
| `decision_entity_type`                      | `TEXT NOT NULL CHECK (... = 'ad')`           |
| `decision_entity_id`                        | `TEXT NOT NULL`                              |
| `ad_id`                                     | `TEXT NOT NULL`                              |
| `creative_id`                               | `TEXT NULL` (grouping only)                  |
| `event_date`                                | `DATE NOT NULL`                              |
| `engine_version`                            | `TEXT NOT NULL`                              |
| `scope_type`, `scope_id`                    | `TEXT NOT NULL`                              |
| `event_type`                                | `TEXT NOT NULL`                              |
| `previous_label`, `current_label`           | `TEXT NULL`                                  |
| `previous_confidence`, `current_confidence` | `INTEGER NULL`                               |
| `operator_action_type`                      | `TEXT NULL` with existing action check       |
| `operator_evidence`                         | `JSONB NULL`                                 |
| `decision_snapshot_id`                      | `UUID NULL`                                  |
| `job_run_id`                                | `UUID NULL`                                  |
| `notes`                                     | `TEXT NULL`                                  |
| `created_at`, `updated_at`                  | `TIMESTAMPTZ NOT NULL DEFAULT now()`         |

Constraints and indexes:

- `CHECK (decision_entity_id = ad_id)` and event/label/confidence checks.
- `engine_v3_ad_events_snapshot_fk` from `decision_snapshot_id` to the native
  snapshot `id`; no legacy snapshot FK is permitted.
- Job-run and business FKs.
- Unique decision-change index on
  `(business_ref_id, provider_account_id, decision_entity_type,
decision_entity_id, event_date, engine_version, scope_type, scope_id,
event_type, previous_label, current_label, decision_snapshot_id)` with
  `WHERE event_type = 'decision_changed'`.
- Business/date/event and native entity timeline indexes.

## Activation Gate

1. Create only the four parallel tables above. Do not alter legacy creative
   evaluation/snapshot/event tables for D047.
2. Run migrations-from-zero and a production-shaped migration seam.
3. `inspectEvaluationStoreSchemaCapability()` must return `ready: true`.
4. Invoke `runAdDecisionsJob` only as shadow. It is intentionally absent from
   the scheduled producer chain.
5. Verify 100% evaluation linkage, separate rows for shared-creative ads,
   nullable creative survival, same-day evaluation preservation, and zero
   legacy-table mutations before considering a later authority-read phase.
6. Verify a mixed ready/unready batch: ready rows retain native calibration
   UUIDs while unready rows persist `diagnose` with null calibration UUID,
   explicit blocker/badge, and no hard action. Missing evidence must not abort
   unrelated ready rows; invalid schema or provenance must abort all writes.
