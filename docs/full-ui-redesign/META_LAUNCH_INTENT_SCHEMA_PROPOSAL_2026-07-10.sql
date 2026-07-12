-- Migration ownership remains with the main migration worker.
-- Apply through lib/migrations.ts before enabling the LaunchIntent API/routes.

CREATE TABLE IF NOT EXISTS meta_launch_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider_account_id TEXT NOT NULL,
  operation TEXT NOT NULL
    CHECK (operation IN ('new_campaign', 'add_to_existing')),
  idempotency_key TEXT NOT NULL,
  requested_status TEXT NOT NULL DEFAULT 'PAUSED'
    CHECK (requested_status = 'PAUSED'),
  source_decision_id TEXT,
  source_decision_snapshot_id UUID,
  creative_brief_id UUID REFERENCES meta_creative_briefs(id) ON DELETE RESTRICT,
  source_draft_id UUID REFERENCES meta_launch_drafts(id) ON DELETE RESTRICT,
  request_payload_json JSONB NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN (
      'prepared',
      'validation_blocked',
      'write_blocked',
      'ready',
      'executing',
      'succeeded',
      'partially_succeeded',
      'failed',
      'silent_failure'
    )),
  validation_receipt_json JSONB,
  result_receipt_json JSONB,
  error_receipt_json JSONB,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (business_id, provider_account_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_meta_launch_intents_business_account_recent
  ON meta_launch_intents (business_id, provider_account_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_meta_launch_intents_lineage_decision
  ON meta_launch_intents (business_id, source_decision_id)
  WHERE source_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meta_launch_intents_lineage_brief
  ON meta_launch_intents (business_id, creative_brief_id)
  WHERE creative_brief_id IS NOT NULL;

-- Optional follow-up for direct joins from the existing action ledger. The
-- implementation also persists launch_intent_id inside payload_request so it
-- remains truthful before this additive column is adopted.
ALTER TABLE meta_ads_action_log
  ADD COLUMN IF NOT EXISTS launch_intent_id UUID
    REFERENCES meta_launch_intents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_meta_ads_action_log_launch_intent
  ON meta_ads_action_log (launch_intent_id, requested_at ASC)
  WHERE launch_intent_id IS NOT NULL;
