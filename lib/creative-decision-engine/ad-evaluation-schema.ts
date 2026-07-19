/**
 * Exact migration input for D047 native-ad authority. Runtime never executes
 * this module and no statement targets a legacy creative decision table.
 */
export const ALTER_NATIVE_AD_JOB_RUN_LINEAGE_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'engine_v3_job_runs'::regclass
      AND conname = 'engine_v3_job_runs_native_lineage_unique'
  ) THEN
    ALTER TABLE engine_v3_job_runs
      ADD CONSTRAINT engine_v3_job_runs_native_lineage_unique UNIQUE (
        id, business_ref_id, business_id, as_of_date, engine_version
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'engine_v3_ad_account_calibration_daily'::regclass
      AND conname = 'engine_v3_ad_calibration_snapshot_lineage_unique'
  ) THEN
    ALTER TABLE engine_v3_ad_account_calibration_daily
      ADD CONSTRAINT engine_v3_ad_calibration_snapshot_lineage_unique UNIQUE (
        id, business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, as_of_date, engine_version
      );
  END IF;
END
$$
`;

export const NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_EXPRESSION = `((
  (
    calibration_row_id IS NULL AND
    label IN ('diagnose', 'out_of_scope', 'keep') AND
    raw_label IN ('diagnose', 'out_of_scope', 'keep') AND
    confidence <= 40 AND
    authorized_action IS NULL AND
    blocked_action_type IS NULL AND
    badges @> '[{"type":"native_calibration_unavailable"}]'::jsonb
  ) OR (
    calibration_row_id IS NOT NULL AND
    (
      (
        authority_blocker IS NOT NULL AND
        authorized_action IS NULL AND
        (
          label NOT IN ('scale', 'cut', 'refresh') OR
          label = raw_label
        )
      ) OR (
        authority_blocker IS NULL AND
        (
          (
            raw_label IN ('scale', 'cut', 'refresh') AND
            (
              (label = raw_label AND authorized_action = raw_label) OR
              (
                label NOT IN ('scale', 'cut', 'refresh') AND
                authorized_action IS NULL AND
                blocked_action_type = raw_label AND
                badges @> '[{"type":"pending_transition"}]'::jsonb
              )
            )
          ) OR (
            raw_label NOT IN ('scale', 'cut', 'refresh') AND
            label NOT IN ('scale', 'cut', 'refresh') AND
            authorized_action IS NULL
          )
        )
      )
    )
  ) AND (
    authorized_action IS NULL OR
    blocked_action_type IS NULL
  )
) IS TRUE)`;

export const CREATE_NATIVE_AD_EVALUATION_CONTEXTS_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_evaluation_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  business_id TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL CHECK (BTRIM(provider_account_id) <> ''),
  as_of_date DATE NOT NULL,
  engine_version TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('account', 'campaign')),
  scope_id TEXT NOT NULL CHECK (BTRIM(scope_id) <> ''),
  contract_version TEXT NOT NULL,
  context_json JSONB NOT NULL CHECK (jsonb_typeof(context_json) = 'object'),
  account_profile_json JSONB NOT NULL CHECK (jsonb_typeof(account_profile_json) = 'object'),
  data_health_json JSONB NOT NULL CHECK (jsonb_typeof(data_health_json) = 'object'),
  flags_json JSONB NOT NULL CHECK (jsonb_typeof(flags_json) = 'object'),
  context_hash CHAR(64) NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  job_run_id UUID NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_eval_contexts_business_identity_check CHECK (
    business_id = business_ref_id::text
  ),
  CONSTRAINT engine_v3_ad_eval_contexts_account_scope_check CHECK (
    scope_type <> 'account' OR scope_id = provider_account_id
  ),
  CONSTRAINT engine_v3_ad_eval_contexts_binding_fk FOREIGN KEY (
    business_id, provider_account_ref_id, provider_account_id
  ) REFERENCES business_provider_accounts (
    business_id, provider_account_ref_id, provider_account_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_eval_contexts_job_run_lineage_fk FOREIGN KEY (
    job_run_id, business_ref_id, business_id, as_of_date, engine_version
  ) REFERENCES engine_v3_job_runs (
    id, business_ref_id, business_id, as_of_date, engine_version
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_eval_contexts_run_scope_hash_unique UNIQUE (
    job_run_id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, as_of_date, engine_version, scope_type, scope_id,
    context_hash
  ),
  CONSTRAINT engine_v3_ad_eval_contexts_lineage_unique UNIQUE (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, as_of_date, engine_version, scope_type, scope_id,
    contract_version, job_run_id
  )
)
`;

export const CREATE_NATIVE_AD_EVALUATIONS_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id UUID NOT NULL,
  business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  business_id TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL CHECK (BTRIM(provider_account_id) <> ''),
  decision_entity_type TEXT NOT NULL CHECK (decision_entity_type = 'ad'),
  decision_entity_id TEXT NOT NULL CHECK (BTRIM(decision_entity_id) <> ''),
  ad_id TEXT NOT NULL CHECK (BTRIM(ad_id) <> ''),
  creative_id TEXT,
  as_of_date DATE NOT NULL,
  engine_version TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('account', 'campaign')),
  scope_id TEXT NOT NULL CHECK (BTRIM(scope_id) <> ''),
  contract_version TEXT NOT NULL,
  creative_input_json JSONB NOT NULL CHECK (jsonb_typeof(creative_input_json) = 'object'),
  campaign_context_json JSONB NOT NULL CHECK (jsonb_typeof(campaign_context_json) = 'object'),
  prior_hysteresis_json JSONB NOT NULL CHECK (jsonb_typeof(prior_hysteresis_json) = 'object'),
  decision_output_json JSONB NOT NULL CHECK (jsonb_typeof(decision_output_json) = 'object'),
  raw_label TEXT NOT NULL CHECK (raw_label IN (
    'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
  )),
  hysteresis_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  input_hash CHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  decision_hash CHAR(64) NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  job_run_id UUID NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_evaluations_business_identity_check CHECK (
    business_id = business_ref_id::text
  ),
  CONSTRAINT engine_v3_ad_evaluations_account_scope_check CHECK (
    scope_type <> 'account' OR scope_id = provider_account_id
  ),
  CONSTRAINT engine_v3_ad_evaluations_entity_identity_check CHECK (
    decision_entity_id = ad_id
  ),
  CONSTRAINT engine_v3_ad_evaluations_binding_fk FOREIGN KEY (
    business_id, provider_account_ref_id, provider_account_id
  ) REFERENCES business_provider_accounts (
    business_id, provider_account_ref_id, provider_account_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_evaluations_context_lineage_fk FOREIGN KEY (
    context_id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, as_of_date, engine_version, scope_type, scope_id,
    contract_version, job_run_id
  ) REFERENCES engine_v3_ad_decision_evaluation_contexts (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, as_of_date, engine_version, scope_type, scope_id,
    contract_version, job_run_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_evaluations_ad_identity_unique UNIQUE (
    context_id, provider_account_ref_id, provider_account_id,
    decision_entity_type, decision_entity_id, input_hash, decision_hash
  ),
  CONSTRAINT engine_v3_ad_evaluations_snapshot_lineage_unique UNIQUE (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    as_of_date, engine_version, scope_type, scope_id, input_hash,
    decision_hash, job_run_id
  )
)
`;

export const CREATE_NATIVE_AD_SNAPSHOTS_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_snapshots_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  business_id TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL CHECK (BTRIM(provider_account_id) <> ''),
  decision_entity_type TEXT NOT NULL CHECK (decision_entity_type = 'ad'),
  decision_entity_id TEXT NOT NULL CHECK (BTRIM(decision_entity_id) <> ''),
  ad_id TEXT NOT NULL CHECK (BTRIM(ad_id) <> ''),
  creative_id TEXT,
  as_of_date DATE NOT NULL,
  engine_version TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('account', 'campaign')),
  scope_id TEXT NOT NULL CHECK (BTRIM(scope_id) <> ''),
  label TEXT NOT NULL CHECK (label IN (
    'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
  )),
  raw_label TEXT NOT NULL CHECK (raw_label IN (
    'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
  )),
  pre_authority_label TEXT,
  authority_blocker TEXT,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  truth_source TEXT NOT NULL CHECK (truth_source IN (
    'commercial_truth', 'commercial_truth_stale', 'account_baseline',
    'account_baseline_thin', 'global_default'
  )),
  effective_target_roas DOUBLE PRECISION NOT NULL,
  ratio_to_target DOUBLE PRECISION,
  badges JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(badges) = 'array'),
  reason TEXT NOT NULL,
  spend DOUBLE PRECISION,
  purchases DOUBLE PRECISION,
  roas DOUBLE PRECISION,
  recent7d_roas DOUBLE PRECISION,
  label_transform TEXT CHECK (label_transform IN ('test_cohort_refresh_to_cut')),
  blocked_action_type TEXT CHECK (blocked_action_type IN ('scale', 'cut', 'refresh')),
  authorized_action TEXT CHECK (authorized_action IN ('scale', 'cut', 'refresh')),
  job_run_id UUID NOT NULL REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT,
  creative_evidence_lifecycle_row_id UUID,
  calibration_row_id UUID,
  evaluation_id UUID NOT NULL,
  input_hash CHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  decision_hash CHAR(64) NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  computed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_snapshots_business_identity_check CHECK (
    business_id = business_ref_id::text
  ),
  CONSTRAINT engine_v3_ad_snapshots_account_scope_check CHECK (
    scope_type <> 'account' OR scope_id = provider_account_id
  ),
  CONSTRAINT engine_v3_ad_snapshots_entity_identity_check CHECK (
    decision_entity_id = ad_id
  ),
  CONSTRAINT engine_v3_ad_snapshots_pre_authority_label_check CHECK (
    pre_authority_label IS NULL OR pre_authority_label IN (
      'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
    )
  ),
  CONSTRAINT engine_v3_ad_snapshots_authority_blocker_check CHECK (
    authority_blocker IS NULL OR authority_blocker IN (
      'profile_hard_action_ineligible', 'source_freshness',
      'campaign_context', 'native_metrics_unavailable',
      'native_profile_unavailable', 'recent_recovery_unverifiable'
    )
  ),
  CONSTRAINT engine_v3_ad_snapshots_binding_fk FOREIGN KEY (
    business_id, provider_account_ref_id, provider_account_id
  ) REFERENCES business_provider_accounts (
    business_id, provider_account_ref_id, provider_account_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_snapshots_authority_check
    CHECK ${NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_EXPRESSION},
  CONSTRAINT engine_v3_ad_snapshots_ad_identity_unique UNIQUE (
    business_ref_id, provider_account_ref_id, provider_account_id,
    decision_entity_type, decision_entity_id, as_of_date, engine_version,
    scope_type, scope_id
  ),
  CONSTRAINT engine_v3_ad_snapshots_evaluation_unique UNIQUE (evaluation_id),
  CONSTRAINT engine_v3_ad_snapshots_evaluation_lineage_fk FOREIGN KEY (
    evaluation_id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    as_of_date, engine_version, scope_type, scope_id, input_hash,
    decision_hash, job_run_id
  ) REFERENCES engine_v3_ad_decision_evaluations (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    as_of_date, engine_version, scope_type, scope_id, input_hash,
    decision_hash, job_run_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_snapshots_event_lineage_unique UNIQUE (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    as_of_date, engine_version, scope_type, scope_id, label, confidence,
    job_run_id
  )
)
`;

export const ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL = `
ALTER TABLE IF EXISTS engine_v3_ad_decision_snapshots_daily
  ADD COLUMN IF NOT EXISTS pre_authority_label TEXT,
  ADD COLUMN IF NOT EXISTS authority_blocker TEXT;
DO $$
BEGIN
  IF to_regclass('engine_v3_ad_decision_snapshots_daily') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'engine_v3_ad_decision_snapshots_daily'::regclass
        AND conname = 'engine_v3_ad_snapshots_pre_authority_label_check') THEN
      ALTER TABLE engine_v3_ad_decision_snapshots_daily
        ADD CONSTRAINT engine_v3_ad_snapshots_pre_authority_label_check
        CHECK (pre_authority_label IS NULL OR pre_authority_label IN (
          'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
        ));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'engine_v3_ad_decision_snapshots_daily'::regclass
        AND conname = 'engine_v3_ad_snapshots_authority_blocker_check') THEN
      ALTER TABLE engine_v3_ad_decision_snapshots_daily
        ADD CONSTRAINT engine_v3_ad_snapshots_authority_blocker_check
        CHECK (authority_blocker IS NULL OR authority_blocker IN (
          'profile_hard_action_ineligible', 'source_freshness',
          'campaign_context', 'native_metrics_unavailable',
          'native_profile_unavailable', 'recent_recovery_unverifiable'
        ));
    END IF;
  END IF;
END
$$
`;

export const ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL = `
DO $$
BEGIN
  IF to_regclass('engine_v3_ad_decision_snapshots_daily') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass('engine_v3_ad_decision_snapshots_daily')
        AND conname = 'engine_v3_ad_snapshots_authority_check'
        AND LOWER(pg_get_constraintdef(oid, true)) LIKE '%authority_blocker%'
        AND LOWER(pg_get_constraintdef(oid, true)) LIKE '%pending_transition%'
        AND LOWER(pg_get_constraintdef(oid, true))
          LIKE '%authorized_action is null or blocked_action_type is null%'
        AND LOWER(pg_get_constraintdef(oid, true)) LIKE '%is true%'
    ) THEN
    ALTER TABLE engine_v3_ad_decision_snapshots_daily
      DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_authority_check;
    UPDATE engine_v3_ad_decision_snapshots_daily
    SET authorized_action = NULL
    WHERE authorized_action IS NOT NULL
      AND NOT (
        calibration_row_id IS NOT NULL AND
        authority_blocker IS NULL AND
        blocked_action_type IS NULL AND
        label IN ('scale', 'cut', 'refresh') AND
        raw_label = label AND
        authorized_action = label
      );
    ALTER TABLE engine_v3_ad_decision_snapshots_daily
      ADD CONSTRAINT engine_v3_ad_snapshots_authority_check
      CHECK ${NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_EXPRESSION};
  END IF;
END
$$
`;

export const CREATE_NATIVE_AD_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_decision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  business_id TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL CHECK (BTRIM(provider_account_id) <> ''),
  decision_entity_type TEXT NOT NULL CHECK (decision_entity_type = 'ad'),
  decision_entity_id TEXT NOT NULL CHECK (BTRIM(decision_entity_id) <> ''),
  ad_id TEXT NOT NULL CHECK (BTRIM(ad_id) <> ''),
  creative_id TEXT,
  event_date DATE NOT NULL,
  engine_version TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('account', 'campaign')),
  scope_id TEXT NOT NULL CHECK (BTRIM(scope_id) <> ''),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'decision_changed', 'operator_action', 'data_disabled', 'manual_override'
  )),
  previous_label TEXT CHECK (previous_label IS NULL OR previous_label IN (
    'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
  )),
  current_label TEXT CHECK (current_label IS NULL OR current_label IN (
    'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
  )),
  previous_confidence INTEGER CHECK (
    previous_confidence IS NULL OR previous_confidence BETWEEN 0 AND 100
  ),
  current_confidence INTEGER CHECK (
    current_confidence IS NULL OR current_confidence BETWEEN 0 AND 100
  ),
  operator_action_type TEXT CHECK (operator_action_type IN (
    'scaled', 'paused', 'budget_increased', 'budget_decreased',
    'creative_archived', 'unknown'
  )),
  operator_evidence JSONB,
  decision_snapshot_id UUID,
  job_run_id UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_events_business_identity_check CHECK (
    business_id = business_ref_id::text
  ),
  CONSTRAINT engine_v3_ad_events_account_scope_check CHECK (
    scope_type <> 'account' OR scope_id = provider_account_id
  ),
  CONSTRAINT engine_v3_ad_events_entity_identity_check CHECK (
    decision_entity_id = ad_id
  ),
  CONSTRAINT engine_v3_ad_events_change_lineage_check CHECK (
    event_type <> 'decision_changed' OR (
      previous_label IS NOT NULL AND current_label IS NOT NULL AND
      previous_label <> current_label AND
      previous_confidence IS NOT NULL AND current_confidence IS NOT NULL AND
      decision_snapshot_id IS NOT NULL AND job_run_id IS NOT NULL
    )
  ),
  CONSTRAINT engine_v3_ad_events_binding_fk FOREIGN KEY (
    business_id, provider_account_ref_id, provider_account_id
  ) REFERENCES business_provider_accounts (
    business_id, provider_account_ref_id, provider_account_id
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_events_job_run_fk FOREIGN KEY (job_run_id)
    REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_events_snapshot_fk FOREIGN KEY (
    decision_snapshot_id, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id, decision_entity_type,
    decision_entity_id, ad_id, event_date, engine_version, scope_type,
    scope_id, current_label, current_confidence, job_run_id
  ) REFERENCES engine_v3_ad_decision_snapshots_daily (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, decision_entity_type, decision_entity_id, ad_id,
    as_of_date, engine_version, scope_type, scope_id, label, confidence,
    job_run_id
  ) ON DELETE RESTRICT
)
`;

export const ALTER_NATIVE_AD_DECISION_COLUMNS_SQL = `
ALTER TABLE engine_v3_ad_decision_evaluation_contexts
  ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID,
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT;
ALTER TABLE engine_v3_ad_decision_evaluations
  ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID;
ALTER TABLE engine_v3_ad_decision_snapshots_daily
  ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID,
  ADD COLUMN IF NOT EXISTS authorized_action TEXT,
  ADD COLUMN IF NOT EXISTS creative_evidence_lifecycle_row_id UUID;
ALTER TABLE engine_v3_ad_decision_events
  ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID;

UPDATE engine_v3_ad_decision_evaluation_contexts context
SET provider_account_id = COALESCE(context.provider_account_id, context.scope_id),
    provider_account_ref_id = binding.provider_account_ref_id
FROM business_provider_accounts binding
WHERE binding.business_id = context.business_id
  AND binding.provider = 'meta'
  AND binding.provider_account_id = COALESCE(context.provider_account_id, context.scope_id)
  AND context.provider_account_ref_id IS NULL;
UPDATE engine_v3_ad_decision_evaluations evaluation
SET provider_account_ref_id = binding.provider_account_ref_id
FROM business_provider_accounts binding
WHERE binding.business_id = evaluation.business_id
  AND binding.provider = 'meta'
  AND binding.provider_account_id = evaluation.provider_account_id
  AND evaluation.provider_account_ref_id IS NULL;
UPDATE engine_v3_ad_decision_snapshots_daily snapshot
SET provider_account_ref_id = binding.provider_account_ref_id,
    authorized_action = CASE
      WHEN snapshot.raw_label IN ('scale', 'cut', 'refresh')
        AND snapshot.calibration_row_id IS NOT NULL THEN snapshot.raw_label
      ELSE NULL
    END
FROM business_provider_accounts binding
WHERE binding.business_id = snapshot.business_id
  AND binding.provider = 'meta'
  AND binding.provider_account_id = snapshot.provider_account_id;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'engine_v3_ad_decision_snapshots_daily'
      AND column_name = 'lifecycle_row_id'
  ) THEN
    EXECUTE 'UPDATE engine_v3_ad_decision_snapshots_daily
      SET creative_evidence_lifecycle_row_id = COALESCE(
        creative_evidence_lifecycle_row_id, lifecycle_row_id
      )';
  END IF;
END
$$;
UPDATE engine_v3_ad_decision_events event
SET provider_account_ref_id = binding.provider_account_ref_id
FROM business_provider_accounts binding
WHERE binding.business_id = event.business_id
  AND binding.provider = 'meta'
  AND binding.provider_account_id = event.provider_account_id
  AND event.provider_account_ref_id IS NULL;

ALTER TABLE engine_v3_ad_decision_evaluation_contexts
  ALTER COLUMN provider_account_ref_id SET NOT NULL,
  ALTER COLUMN provider_account_id SET NOT NULL;
ALTER TABLE engine_v3_ad_decision_evaluations
  ALTER COLUMN provider_account_ref_id SET NOT NULL,
  ALTER COLUMN creative_id DROP NOT NULL;
ALTER TABLE engine_v3_ad_decision_snapshots_daily
  ALTER COLUMN provider_account_ref_id SET NOT NULL,
  ALTER COLUMN creative_id DROP NOT NULL,
  ALTER COLUMN calibration_row_id DROP NOT NULL;
ALTER TABLE engine_v3_ad_decision_events
  ALTER COLUMN provider_account_ref_id SET NOT NULL,
  ALTER COLUMN creative_id DROP NOT NULL;
`;

export const ALTER_NATIVE_AD_DECISION_CONSTRAINTS_SQL = `
ALTER TABLE engine_v3_ad_decision_events
  DROP CONSTRAINT IF EXISTS engine_v3_ad_events_snapshot_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_events_business_identity_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_events_account_scope_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_events_entity_identity_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_events_change_lineage_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_events_binding_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_events_job_run_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_decision_events_job_run_id_fkey;
ALTER TABLE engine_v3_ad_decision_snapshots_daily
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_ad_identity_unique,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_evaluation_unique,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_evaluation_lineage_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_event_lineage_unique,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_business_identity_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_account_scope_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_entity_identity_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_binding_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_calibration_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_calibration_lineage_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_snapshots_authority_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_decision_snapshots_daily_calibration_row_id_fkey;
ALTER TABLE engine_v3_ad_decision_evaluations
  DROP CONSTRAINT IF EXISTS engine_v3_ad_evaluations_ad_identity_unique,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_evaluations_snapshot_lineage_unique,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_evaluations_context_lineage_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_evaluations_business_identity_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_evaluations_account_scope_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_evaluations_entity_identity_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_evaluations_binding_fk;
ALTER TABLE engine_v3_ad_decision_evaluation_contexts
  DROP CONSTRAINT IF EXISTS engine_v3_ad_eval_contexts_run_scope_hash_unique,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_eval_contexts_lineage_unique,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_eval_contexts_business_identity_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_eval_contexts_account_scope_check,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_eval_contexts_binding_fk,
  DROP CONSTRAINT IF EXISTS engine_v3_ad_eval_contexts_job_run_lineage_fk;

ALTER TABLE engine_v3_ad_decision_evaluation_contexts
  ADD CONSTRAINT engine_v3_ad_eval_contexts_business_identity_check CHECK (business_id = business_ref_id::text),
  ADD CONSTRAINT engine_v3_ad_eval_contexts_account_scope_check CHECK (scope_type <> 'account' OR scope_id = provider_account_id),
  ADD CONSTRAINT engine_v3_ad_eval_contexts_binding_fk FOREIGN KEY (business_id, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts (business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_eval_contexts_job_run_lineage_fk FOREIGN KEY (job_run_id, business_ref_id, business_id, as_of_date, engine_version) REFERENCES engine_v3_job_runs (id, business_ref_id, business_id, as_of_date, engine_version) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_eval_contexts_run_scope_hash_unique UNIQUE (job_run_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, scope_type, scope_id, context_hash),
  ADD CONSTRAINT engine_v3_ad_eval_contexts_lineage_unique UNIQUE (id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, scope_type, scope_id, contract_version, job_run_id);
ALTER TABLE engine_v3_ad_decision_evaluations
  ADD CONSTRAINT engine_v3_ad_evaluations_business_identity_check CHECK (business_id = business_ref_id::text),
  ADD CONSTRAINT engine_v3_ad_evaluations_account_scope_check CHECK (scope_type <> 'account' OR scope_id = provider_account_id),
  ADD CONSTRAINT engine_v3_ad_evaluations_entity_identity_check CHECK (decision_entity_id = ad_id),
  ADD CONSTRAINT engine_v3_ad_evaluations_binding_fk FOREIGN KEY (business_id, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts (business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_evaluations_context_lineage_fk FOREIGN KEY (context_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, scope_type, scope_id, contract_version, job_run_id) REFERENCES engine_v3_ad_decision_evaluation_contexts (id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, scope_type, scope_id, contract_version, job_run_id) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_evaluations_ad_identity_unique UNIQUE (context_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, input_hash, decision_hash),
  ADD CONSTRAINT engine_v3_ad_evaluations_snapshot_lineage_unique UNIQUE (id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, input_hash, decision_hash, job_run_id);
ALTER TABLE engine_v3_ad_decision_snapshots_daily
  ADD CONSTRAINT engine_v3_ad_snapshots_business_identity_check CHECK (business_id = business_ref_id::text),
  ADD CONSTRAINT engine_v3_ad_snapshots_account_scope_check CHECK (scope_type <> 'account' OR scope_id = provider_account_id),
  ADD CONSTRAINT engine_v3_ad_snapshots_entity_identity_check CHECK (decision_entity_id = ad_id),
  ADD CONSTRAINT engine_v3_ad_snapshots_binding_fk FOREIGN KEY (business_id, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts (business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_snapshots_calibration_lineage_fk FOREIGN KEY (calibration_row_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version) REFERENCES engine_v3_ad_account_calibration_daily (id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_snapshots_authority_check
    CHECK ${NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_EXPRESSION},
  ADD CONSTRAINT engine_v3_ad_snapshots_ad_identity_unique UNIQUE (business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, as_of_date, engine_version, scope_type, scope_id),
  ADD CONSTRAINT engine_v3_ad_snapshots_evaluation_unique UNIQUE (evaluation_id),
  ADD CONSTRAINT engine_v3_ad_snapshots_evaluation_lineage_fk FOREIGN KEY (evaluation_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, input_hash, decision_hash, job_run_id) REFERENCES engine_v3_ad_decision_evaluations (id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, input_hash, decision_hash, job_run_id) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_snapshots_event_lineage_unique UNIQUE (id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, label, confidence, job_run_id);
ALTER TABLE engine_v3_ad_decision_events
  ADD CONSTRAINT engine_v3_ad_events_business_identity_check CHECK (business_id = business_ref_id::text),
  ADD CONSTRAINT engine_v3_ad_events_account_scope_check CHECK (scope_type <> 'account' OR scope_id = provider_account_id),
  ADD CONSTRAINT engine_v3_ad_events_entity_identity_check CHECK (decision_entity_id = ad_id),
  ADD CONSTRAINT engine_v3_ad_events_change_lineage_check CHECK (event_type <> 'decision_changed' OR (previous_label IS NOT NULL AND current_label IS NOT NULL AND previous_label <> current_label AND previous_confidence IS NOT NULL AND current_confidence IS NOT NULL AND decision_snapshot_id IS NOT NULL AND job_run_id IS NOT NULL)),
  ADD CONSTRAINT engine_v3_ad_events_binding_fk FOREIGN KEY (business_id, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts (business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_events_job_run_fk FOREIGN KEY (job_run_id) REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT engine_v3_ad_events_snapshot_fk FOREIGN KEY (decision_snapshot_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, event_date, engine_version, scope_type, scope_id, current_label, current_confidence, job_run_id) REFERENCES engine_v3_ad_decision_snapshots_daily (id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, label, confidence, job_run_id) ON DELETE RESTRICT;
`;

export const ALTER_NATIVE_AD_DECISION_SCHEMA_SQL = [
  ALTER_NATIVE_AD_JOB_RUN_LINEAGE_SQL,
  ALTER_NATIVE_AD_DECISION_COLUMNS_SQL,
  ALTER_NATIVE_AD_DECISION_CONSTRAINTS_SQL,
] as const;

export const CREATE_NATIVE_AD_DECISION_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_eval_contexts_business_scope
   ON engine_v3_ad_decision_evaluation_contexts
   (business_ref_id, provider_account_ref_id, provider_account_id, as_of_date DESC, engine_version, scope_type, scope_id, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_eval_contexts_job
   ON engine_v3_ad_decision_evaluation_contexts (job_run_id, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_evaluations_entity_timeline
   ON engine_v3_ad_decision_evaluations
   (business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, as_of_date DESC, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_evaluations_context
   ON engine_v3_ad_decision_evaluations (context_id, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_snapshots_business_day_label
   ON engine_v3_ad_decision_snapshots_daily
   (business_ref_id, as_of_date DESC, engine_version, label)`,
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_snapshots_entity_timeline
   ON engine_v3_ad_decision_snapshots_daily
   (business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, as_of_date DESC, computed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_events_business_date
   ON engine_v3_ad_decision_events
   (business_ref_id, event_date DESC, event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_events_entity_timeline
   ON engine_v3_ad_decision_events
   (business_ref_id, provider_account_ref_id, provider_account_id, decision_entity_type, decision_entity_id, event_date DESC)`,
  `DROP INDEX IF EXISTS engine_v3_ad_events_change_unique`,
  `CREATE UNIQUE INDEX engine_v3_ad_events_change_unique
   ON engine_v3_ad_decision_events
   (business_ref_id, provider_account_ref_id, provider_account_id,
    decision_entity_type, decision_entity_id, event_date, engine_version,
    scope_type, scope_id, event_type)
   WHERE event_type = 'decision_changed'`,
] as const;

export const NATIVE_AD_DECISION_SCHEMA_SQL = [
  ALTER_NATIVE_AD_JOB_RUN_LINEAGE_SQL,
  CREATE_NATIVE_AD_EVALUATION_CONTEXTS_SQL,
  CREATE_NATIVE_AD_EVALUATIONS_SQL,
  CREATE_NATIVE_AD_SNAPSHOTS_SQL,
  CREATE_NATIVE_AD_EVENTS_SQL,
  ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL,
  ALTER_NATIVE_AD_DECISION_COLUMNS_SQL,
  ALTER_NATIVE_AD_DECISION_CONSTRAINTS_SQL,
  ...CREATE_NATIVE_AD_DECISION_INDEXES_SQL,
] as const;
