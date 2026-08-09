import { getDb } from "@/lib/db";
import {
  attributeObservedChange,
  describeChangeOrigin,
  type RecordedAction,
} from "@/lib/external-change-attribution";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  encodeMetaHistoryCursor,
  META_HISTORY_ENTITY_TYPES,
  META_HISTORY_KINDS,
  META_HISTORY_SOURCES,
  type MetaHistoryAccount,
  type MetaHistoryAccountScopeBasis,
  type MetaHistoryEntry,
  type MetaHistoryEntryStatus,
  type MetaHistoryEntityType,
  type MetaHistoryKind,
  type MetaHistoryMoneyFact,
  type MetaHistoryQuery,
  type MetaHistoryResponse,
  type MetaHistorySource,
  type MetaHistorySourceIdKind,
} from "@/lib/meta/history-contract";

const CANONICAL_ID_LIMITATION =
  "A canonical date-free decision ID is not persisted yet. This entry is keyed only by its persisted source row.";

export const META_HISTORY_ACCOUNTS_SQL = `
WITH latest_account AS (
  SELECT DISTINCT ON (business_id, provider_account_id)
    business_id,
    provider_account_id,
    account_name,
    account_currency,
    account_timezone
  FROM meta_account_daily
  WHERE business_id = $1
  ORDER BY business_id, provider_account_id, date DESC, updated_at DESC
)
SELECT
  pa.external_account_id AS id,
  COALESCE(NULLIF(pa.account_name, ''), NULLIF(latest.account_name, '')) AS name,
  COALESCE(NULLIF(UPPER(pa.currency), ''), NULLIF(UPPER(latest.account_currency), '')) AS currency,
  COALESCE(NULLIF(pa.timezone, ''), NULLIF(latest.account_timezone, '')) AS timezone
FROM business_provider_accounts assignment
INNER JOIN provider_accounts pa
  ON pa.id = assignment.provider_account_ref_id
 AND pa.provider = 'meta'
LEFT JOIN latest_account latest
  ON latest.business_id = assignment.business_id
 AND latest.provider_account_id = pa.external_account_id
WHERE assignment.business_id = $1
  AND assignment.provider = 'meta'
ORDER BY assignment.position, assignment.id
`;

// Every account association below is exact. Business-only rows and creatives
// observed in more than one account are deliberately absent from the union.
// Correlation uses persisted rec_id / snapshot UUID keys only; no JSON text or
// recommendation-fingerprint substring matching is permitted.
export const META_HISTORY_READ_SQL = `
WITH creative_account_keys AS (
  SELECT DISTINCT business_id, provider_account_id, creative_id
  FROM meta_creative_dimensions
  WHERE business_id = $1
  UNION
  SELECT DISTINCT business_id, provider_account_id, creative_id
  FROM meta_creative_daily
  WHERE business_id = $1
),
creative_account_scope AS (
  SELECT
    creative_id,
    MIN(provider_account_id) AS provider_account_id
  FROM creative_account_keys
  GROUP BY creative_id
  HAVING COUNT(DISTINCT provider_account_id) = 1
     AND MIN(provider_account_id) = $2
),
creative_names AS (
  SELECT DISTINCT ON (creative_id)
    creative_id,
    creative_name
  FROM (
    SELECT
      creative_id,
      creative_name,
      COALESCE(source_updated_at, updated_at) AS observed_at
    FROM meta_creative_dimensions
    WHERE business_id = $1
      AND provider_account_id = $2
    UNION ALL
    SELECT
      creative_id,
      creative_name,
      updated_at AS observed_at
    FROM meta_creative_daily
    WHERE business_id = $1
      AND provider_account_id = $2
  ) names
  ORDER BY creative_id, observed_at DESC NULLS LAST
),
v1_scoped_snapshots AS (
  SELECT
    snapshot.*,
    COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical,
             adset.adset_name_current, adset.adset_name_historical) AS entity_name,
    CASE
      WHEN snapshot.scope_type = 'campaign' THEN 'campaign'
      ELSE 'adset'
    END AS resolved_entity_type,
    snapshot.scope_type || ':' || snapshot.scope_id || ':' || snapshot.snapshot_date::text || ':' || snapshot.rec_type AS persisted_id
  FROM meta_decision_snapshots_daily snapshot
  LEFT JOIN meta_campaign_dimensions campaign
    ON snapshot.scope_type = 'campaign'
   AND campaign.business_id = snapshot.business_id
   AND campaign.provider_account_id = $2
   AND campaign.campaign_id = snapshot.scope_id
  LEFT JOIN meta_adset_dimensions adset
    ON snapshot.scope_type = 'adset'
   AND adset.business_id = snapshot.business_id
   AND adset.provider_account_id = $2
   AND adset.adset_id = snapshot.scope_id
  WHERE snapshot.business_id = $1
    AND (
      (snapshot.scope_type = 'campaign' AND campaign.id IS NOT NULL)
      OR (snapshot.scope_type = 'adset' AND adset.id IS NOT NULL)
    )
),
history_entries AS (
  SELECT
    'meta_decision_snapshots_daily'::text AS source_key,
    snapshot.persisted_id::text AS source_id,
    'persisted_composite_key'::text AS source_id_kind,
    'decisions'::text AS kind,
    COALESCE(snapshot.created_at, snapshot.snapshot_date::timestamp) AS occurred_at,
    snapshot.snapshot_date AS event_date,
    COALESCE(NULLIF(snapshot.recommended_action, ''), 'Persisted decision') AS title,
    NULLIF(snapshot.reasoning, '') AS summary,
    snapshot.resolved_entity_type::text AS entity_type,
    snapshot.scope_id::text AS entity_id,
    snapshot.entity_name::text AS entity_name,
    COALESCE(NULLIF(snapshot.decision_label, ''), NULLIF(snapshot.rec_type, '')) AS label,
    CASE
      WHEN COALESCE(snapshot.kind, 'recommendation') = 'anomaly' AND snapshot.resolved_at IS NOT NULL THEN 'resolved'
      WHEN COALESCE(snapshot.kind, 'recommendation') = 'anomaly' THEN 'open'
      ELSE 'published'
    END::text AS status_raw,
    NULL::text AS actor_id,
    NULL::text AS actor_name,
    'not_applicable'::text AS actor_availability,
    'exact_entity_key'::text AS account_scope_basis,
    'engine_snapshot'::text AS attribution,
    'unavailable'::text AS correlation_status,
    NULL::text AS correlation_key,
    'Date-free decision identity is not persisted for Meta v1 snapshots.'::text AS correlation_reason,
    snapshot.snapshot_date::text AS replay_date,
    snapshot.engine_version::text AS engine_version,
    jsonb_build_object(
      'recId', snapshot.rec_id,
      'recType', snapshot.rec_type,
      'decisionState', snapshot.decision_state,
      'confidenceScore', snapshot.confidence_score,
      'recommendedAction', snapshot.recommended_action,
      'expectedImpact', snapshot.expected_impact,
      'severity', snapshot.severity,
      'stateReason', snapshot.state_reason,
      'detectedAt', snapshot.detected_at,
      'resolvedAt', snapshot.resolved_at
    ) AS detail_json
  FROM v1_scoped_snapshots snapshot

  UNION ALL

  SELECT
    'engine_v3_decision_snapshots_daily',
    snapshot.id::text,
    'persisted_uuid',
    'decisions',
    COALESCE(snapshot.computed_at, snapshot.created_at, snapshot.as_of_date::timestamp),
    snapshot.as_of_date,
    INITCAP(REPLACE(snapshot.label, '_', ' ')) || ' decision',
    NULLIF(snapshot.reason, ''),
    'creative',
    snapshot.creative_id,
    names.creative_name,
    snapshot.label,
    'published',
    NULL,
    NULL,
    'not_applicable',
    'unique_creative_key',
    'engine_snapshot',
    'unavailable',
    NULL,
    'Date-free decision identity is not persisted for Engine V3 snapshots.',
    snapshot.as_of_date::text,
    snapshot.engine_version,
    jsonb_build_object(
      'rawLabel', snapshot.raw_label,
      'confidence', snapshot.confidence,
      'truthSource', snapshot.truth_source,
      'effectiveTargetRoas', snapshot.effective_target_roas,
      'ratioToTarget', snapshot.ratio_to_target,
      'badges', snapshot.badges,
      'labelTransform', snapshot.label_transform,
      'spend', snapshot.spend,
      'purchases', snapshot.purchases,
      'roas', snapshot.roas,
      'recent7dRoas', snapshot.recent7d_roas
    )
  FROM engine_v3_decision_snapshots_daily snapshot
  INNER JOIN creative_account_scope account_scope
    ON account_scope.creative_id = snapshot.creative_id
  LEFT JOIN creative_names names
    ON names.creative_id = snapshot.creative_id
  WHERE (snapshot.business_ref_id::text = $1 OR snapshot.business_id = $1)

  UNION ALL

  SELECT
    'engine_v3_decision_events',
    event.id::text,
    'persisted_uuid',
    'label_flips',
    COALESCE(event.created_at, event.event_date::timestamp),
    event.event_date,
    INITCAP(REPLACE(event.event_type, '_', ' ')),
    NULLIF(event.notes, ''),
    'creative',
    event.creative_id,
    names.creative_name,
    COALESCE(event.current_label, event.previous_label),
    'recorded',
    NULL,
    NULL,
    CASE WHEN event.event_type IN ('operator_action', 'manual_override') THEN 'unavailable' ELSE 'not_applicable' END,
    'unique_creative_key',
    'engine_transition',
    CASE WHEN snapshot.id IS NOT NULL THEN 'keyed' ELSE 'unavailable' END,
    snapshot.id::text,
    CASE WHEN snapshot.id IS NULL THEN 'The transition has no surviving decision_snapshot_id join.' ELSE NULL END,
    event.event_date::text,
    snapshot.engine_version,
    jsonb_build_object(
      'eventType', event.event_type,
      'previousLabel', event.previous_label,
      'currentLabel', event.current_label,
      'previousConfidence', event.previous_confidence,
      'currentConfidence', event.current_confidence,
      'operatorActionType', event.operator_action_type,
      'operatorEvidence', event.operator_evidence,
      'jobRunId', event.job_run_id
    )
  FROM engine_v3_decision_events event
  INNER JOIN creative_account_scope account_scope
    ON account_scope.creative_id = event.creative_id
  LEFT JOIN creative_names names
    ON names.creative_id = event.creative_id
  LEFT JOIN engine_v3_decision_snapshots_daily snapshot
    ON snapshot.id = event.decision_snapshot_id
   AND (snapshot.business_ref_id::text = $1 OR snapshot.business_id = $1)
  WHERE (event.business_ref_id::text = $1 OR event.business_id = $1)

  UNION ALL

  SELECT
    'engine_v3_decision_outcomes_daily',
    outcome.id::text,
    'persisted_uuid',
    'outcomes',
    COALESCE(outcome.computed_at, outcome.created_at, outcome.evaluation_date::timestamp),
    outcome.evaluation_date,
    outcome.outcome_window_days::text || '-day outcome',
    'Persisted correlational outcome for ' || REPLACE(outcome.label, '_', ' ') || '.',
    'creative',
    outcome.creative_id,
    names.creative_name,
    outcome.label,
    outcome.realized_outcome,
    NULL,
    NULL,
    'not_applicable',
    'exact_snapshot_key',
    'correlational_outcome',
    'keyed',
    outcome.decision_snapshot_id::text,
    NULL,
    outcome.decision_as_of_date::text,
    outcome.engine_version,
    jsonb_build_object(
      'outcomeWindowDays', outcome.outcome_window_days,
      'evaluationDate', outcome.evaluation_date,
      'severity', outcome.severity,
      'classifierVersion', outcome.classifier_version,
      'baselineSpend', outcome.baseline_spend,
      'baselinePurchases', outcome.baseline_purchases,
      'baselineRoas', outcome.baseline_roas,
      'outcomeSpend', outcome.outcome_spend,
      'outcomePurchases', outcome.outcome_purchases,
      'outcomeRevenue', outcome.outcome_revenue,
      'outcomeRoas', outcome.outcome_roas,
      'evidence', outcome.evidence_json
    )
  FROM engine_v3_decision_outcomes_daily outcome
  INNER JOIN engine_v3_decision_snapshots_daily snapshot
    ON snapshot.id = outcome.decision_snapshot_id
   AND (snapshot.business_ref_id::text = $1 OR snapshot.business_id = $1)
  INNER JOIN creative_account_scope account_scope
    ON account_scope.creative_id = outcome.creative_id
  LEFT JOIN creative_names names
    ON names.creative_id = outcome.creative_id
  WHERE (outcome.business_ref_id::text = $1 OR outcome.business_id = $1)

  UNION ALL

  SELECT
    'meta_decision_responses',
    response.rec_id || ':' || response.action || ':' || response.timestamp::text,
    'persisted_composite_key',
    'responses',
    response.timestamp,
    response.timestamp::date,
    INITCAP(REPLACE(response.action, '_', ' ')) || ' response',
    CASE
      WHEN response.reappear_at IS NOT NULL THEN 'Reappears ' || response.reappear_at::text || '.'
      ELSE NULL
    END,
    snapshot.resolved_entity_type,
    snapshot.scope_id,
    snapshot.entity_name,
    COALESCE(NULLIF(snapshot.decision_label, ''), NULLIF(snapshot.rec_type, '')),
    'recorded',
    NULL,
    NULL,
    'unavailable',
    'exact_snapshot_key',
    'operator_recorded',
    'keyed',
    response.rec_id,
    NULL,
    snapshot.snapshot_date::text,
    snapshot.engine_version,
    jsonb_build_object(
      'recId', response.rec_id,
      'action', response.action,
      'actionSubtype', response.action_subtype,
      'reappearAt', response.reappear_at,
      'actorLimitation', 'meta_decision_responses does not persist a user id'
    )
  FROM meta_decision_responses response
  INNER JOIN LATERAL (
    SELECT scoped.*
    FROM v1_scoped_snapshots scoped
    WHERE scoped.business_id = response.business_id
      AND scoped.rec_id = response.rec_id
      AND scoped.snapshot_date <= response.timestamp::date
    ORDER BY scoped.snapshot_date DESC, scoped.created_at DESC
    LIMIT 1
  ) snapshot ON TRUE
  WHERE response.business_id = $1

  UNION ALL

  SELECT
    'meta_ads_action_log',
    action_log.id::text,
    'persisted_uuid',
    'writes',
    action_log.requested_at,
    action_log.requested_at::date,
    INITCAP(REPLACE(action_log.action, '_', ' ')) || ' | ' || COALESCE(resolved.entity_name, resolved.entity_id),
    NULLIF(action_log.error_message, ''),
    resolved.entity_type,
    resolved.entity_id,
    resolved.entity_name,
    linked.decision_label,
    CASE
      WHEN action_log.status = 'success' AND action_log.verified_at IS NOT NULL THEN 'verified_success'
      WHEN action_log.status = 'success' THEN 'recorded'
      ELSE action_log.status
    END,
    action_log.requested_by::text,
    actor.name,
    CASE WHEN actor.id IS NOT NULL THEN 'available' ELSE 'unavailable' END,
    'exact_entity_key',
    'provider_write_log',
    CASE WHEN linked.rec_id IS NOT NULL THEN 'keyed' ELSE 'unavailable' END,
    linked.rec_id,
    CASE
      WHEN action_log.rec_id_origin IS NULL THEN 'The action log does not persist a decision reference.'
      WHEN linked.rec_id IS NULL THEN 'No account-scoped snapshot matched rec_id_origin.'
      ELSE NULL
    END,
    linked.snapshot_date::text,
    linked.engine_version,
    jsonb_build_object(
      'action', action_log.action,
      'source', action_log.source,
      'requestedAt', action_log.requested_at,
      'verifiedAt', action_log.verified_at,
      'durationMs', action_log.duration_ms,
      'errorCode', action_log.error_code,
      'errorMessage', action_log.error_message,
      'resultingAdId', action_log.resulting_ad_id,
      'request', action_log.payload_request,
      'response', action_log.payload_response,
      'verification', action_log.verification_payload
    )
  FROM meta_ads_action_log action_log
  INNER JOIN LATERAL (
    SELECT candidates.entity_type, candidates.entity_id, candidates.entity_name
    FROM (
      SELECT
        1 AS priority,
        'campaign'::text AS entity_type,
        COALESCE(action_log.resulting_ad_id, action_log.ad_id)::text AS entity_id,
        COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical)::text AS entity_name
      FROM meta_campaign_dimensions campaign
      WHERE campaign.business_id = action_log.business_id::text
        AND campaign.provider_account_id = $2
        AND campaign.campaign_id = COALESCE(action_log.resulting_ad_id, action_log.ad_id)
        AND (action_log.payload_request->>'scope_type' = 'campaign' OR action_log.action = 'launch_campaign')
      UNION ALL
      SELECT
        2,
        'adset',
        COALESCE(action_log.resulting_ad_id, action_log.ad_id),
        COALESCE(adset.adset_name_current, adset.adset_name_historical)
      FROM meta_adset_dimensions adset
      WHERE adset.business_id = action_log.business_id::text
        AND adset.provider_account_id = $2
        AND adset.adset_id = COALESCE(action_log.resulting_ad_id, action_log.ad_id)
        AND (action_log.payload_request->>'scope_type' = 'adset' OR action_log.action = 'launch_adset')
      UNION ALL
      SELECT
        3,
        'ad',
        COALESCE(action_log.resulting_ad_id, action_log.ad_id),
        COALESCE(ad_result.ad_name_current, ad_result.ad_name_historical)
      FROM meta_ad_dimensions ad_result
      WHERE ad_result.business_id = action_log.business_id::text
        AND ad_result.provider_account_id = $2
        AND ad_result.ad_id = COALESCE(action_log.resulting_ad_id, action_log.ad_id)
        AND COALESCE(action_log.payload_request->>'scope_type', 'ad') NOT IN ('campaign', 'adset')
      UNION ALL
      SELECT
        4,
        'ad',
        COALESCE(action_log.resulting_ad_id, action_log.ad_id),
        COALESCE(ad_source.ad_name_current, ad_source.ad_name_historical)
      FROM meta_ad_dimensions ad_source
      WHERE ad_source.business_id = action_log.business_id::text
        AND ad_source.provider_account_id = $2
        AND ad_source.ad_id = action_log.ad_id
        AND COALESCE(action_log.payload_request->>'scope_type', 'ad') NOT IN ('campaign', 'adset')
      UNION ALL
      SELECT
        5,
        'ad',
        COALESCE(action_log.resulting_ad_id, action_log.ad_id),
        NULLIF(action_log.payload_request->>'source_name', '')
      FROM meta_adset_dimensions target_adset
      WHERE target_adset.business_id = action_log.business_id::text
        AND target_adset.provider_account_id = $2
        AND target_adset.adset_id = COALESCE(
          NULLIF(action_log.payload_request->>'target_adset_id', ''),
          NULLIF(action_log.payload_request->'body'->>'target_adset_id', ''),
          NULLIF(action_log.payload_request->'body'->>'adset_id', '')
        )
        AND action_log.action IN ('duplicate', 'launch_ad')
      UNION ALL
      SELECT
        6,
        'adset',
        COALESCE(action_log.resulting_ad_id, action_log.ad_id),
        NULLIF(action_log.payload_request->'body'->>'name', '')
      FROM meta_campaign_dimensions parent_campaign
      WHERE parent_campaign.business_id = action_log.business_id::text
        AND parent_campaign.provider_account_id = $2
        AND parent_campaign.campaign_id = NULLIF(action_log.payload_request->'body'->>'campaign_id', '')
        AND action_log.action = 'launch_adset'
    ) candidates
    ORDER BY candidates.priority
    LIMIT 1
  ) resolved ON TRUE
  LEFT JOIN users actor
    ON actor.id = action_log.requested_by
  LEFT JOIN LATERAL (
    SELECT
      scoped.rec_id,
      scoped.decision_label,
      scoped.snapshot_date,
      scoped.engine_version
    FROM v1_scoped_snapshots scoped
    WHERE action_log.rec_id_origin IS NOT NULL
      AND scoped.rec_id = action_log.rec_id_origin
      AND scoped.snapshot_date <= action_log.requested_at::date
    ORDER BY scoped.snapshot_date DESC, scoped.created_at DESC
    LIMIT 1
  ) linked ON TRUE
  WHERE action_log.business_id::text = $1

  UNION ALL

  SELECT
    'meta_decision_action_outcome_logs',
    outcome_log.id::text,
    'persisted_uuid',
    CASE
      WHEN outcome_log.action_type = 'outcome' THEN 'outcomes'
      WHEN outcome_log.action_type = 'operator_response' THEN 'responses'
      ELSE 'writes'
    END,
    outcome_log.occurred_at,
    outcome_log.occurred_at::date,
    INITCAP(REPLACE(outcome_log.action_type, '_', ' ')),
    NULLIF(outcome_log.summary, ''),
    CASE
      WHEN outcome_log.payload_json->>'scopeType' IN ('account', 'campaign', 'adset', 'ad', 'creative')
        THEN outcome_log.payload_json->>'scopeType'
      WHEN linked.resolved_entity_type IS NOT NULL THEN linked.resolved_entity_type
      ELSE 'recommendation'
    END,
    COALESCE(
      NULLIF(outcome_log.payload_json->>'scopeId', ''),
      linked.scope_id,
      outcome_log.rec_id,
      outcome_log.recommendation_fingerprint
    ),
    linked.entity_name,
    COALESCE(outcome_log.decision_label, linked.decision_label),
    COALESCE(NULLIF(outcome_log.outcome_status, ''), 'recorded'),
    NULL,
    NULL,
    CASE WHEN outcome_log.action_type = 'operator_response' THEN 'unavailable' ELSE 'not_applicable' END,
    CASE WHEN outcome_log.provider_account_id = $2 THEN 'direct_provider_account_id' ELSE 'exact_snapshot_key' END,
    CASE
      WHEN outcome_log.action_type = 'outcome' THEN 'correlational_outcome'
      WHEN outcome_log.action_type = 'operator_response' THEN 'operator_recorded'
      ELSE 'provider_write_log'
    END,
    CASE WHEN linked.rec_id IS NOT NULL THEN 'keyed' ELSE 'unavailable' END,
    linked.rec_id,
    CASE WHEN linked.rec_id IS NULL THEN 'No account-scoped snapshot matched the persisted rec_id.' ELSE NULL END,
    COALESCE(linked.snapshot_date::text, outcome_log.payload_json->>'snapshotDate'),
    linked.engine_version,
    jsonb_build_object(
      'recommendationFingerprint', outcome_log.recommendation_fingerprint,
      'recId', outcome_log.rec_id,
      'recType', outcome_log.rec_type,
      'decisionFamily', outcome_log.decision_family,
      'actionType', outcome_log.action_type,
      'outcomeStatus', outcome_log.outcome_status,
      'payload', outcome_log.payload_json
    )
  FROM meta_decision_action_outcome_logs outcome_log
  LEFT JOIN LATERAL (
    SELECT scoped.*
    FROM v1_scoped_snapshots scoped
    WHERE outcome_log.rec_id IS NOT NULL
      AND scoped.rec_id = outcome_log.rec_id
      AND scoped.snapshot_date <= outcome_log.occurred_at::date
    ORDER BY scoped.snapshot_date DESC, scoped.created_at DESC
    LIMIT 1
  ) linked ON TRUE
  WHERE outcome_log.business_id = $1
    AND (
      outcome_log.provider_account_id = $2
      OR (outcome_log.provider_account_id IS NULL AND linked.rec_id IS NOT NULL)
    )

  /* OPTIONAL_META_CREATIVE_BRIEFS_START */
  UNION ALL

  SELECT
    'meta_creative_briefs',
    brief.id::text,
    'persisted_uuid',
    'briefs',
    brief.updated_at,
    brief.updated_at::date,
    'Creative Brief ' || brief.status,
    NULLIF(brief.source_reason, ''),
    'creative_brief',
    brief.id::text,
    names.creative_name,
    brief.source_published_label,
    brief.status,
    COALESCE(brief.updated_by, brief.created_by)::text,
    actor.name,
    CASE WHEN actor.id IS NOT NULL THEN 'available' ELSE 'unavailable' END,
    'direct_provider_account_id',
    'workflow_object',
    'keyed',
    brief.source_decision_id,
    NULL,
    brief.source_snapshot_as_of::text,
    brief.source_engine_version,
    jsonb_build_object(
      'briefId', brief.id,
      'contractVersion', brief.contract_version,
      'providerAccountId', brief.provider_account_id,
      'sourceDecisionId', brief.source_decision_id,
      'sourceSnapshotId', brief.source_snapshot_id,
      'sourceCreativeId', brief.source_creative_id,
      'sourceScopeType', brief.source_scope_type,
      'sourceScopeId', brief.source_scope_id,
      'publishedLabel', brief.source_published_label,
      'rawLabel', brief.source_raw_label,
      'sourceTrigger', brief.source_trigger,
      'keep', brief.keep_text,
      'change', brief.change_text,
      'next', brief.next_text,
      'version', brief.version,
      'reviewedAt', brief.reviewed_at
    )
  FROM meta_creative_briefs brief
  LEFT JOIN creative_names names
    ON names.creative_id = brief.source_creative_id
  LEFT JOIN users actor
    ON actor.id = COALESCE(brief.updated_by, brief.created_by)
  WHERE brief.business_id::text = $1
    AND brief.provider_account_id = $2
  /* OPTIONAL_META_CREATIVE_BRIEFS_END */

  /* OPTIONAL_META_LAUNCH_INTENTS_START */
  UNION ALL

  SELECT
    'meta_launch_intents',
    intent.id::text,
    'persisted_uuid',
    'launches',
    intent.updated_at,
    intent.updated_at::date,
    INITCAP(REPLACE(intent.operation, '_', ' ')) || ' LaunchIntent',
    COALESCE(
      NULLIF(intent.error_receipt_json->>'message', ''),
      'Account-scoped PAUSED launch workflow.'
    ),
    'launch_intent',
    intent.id::text,
    INITCAP(REPLACE(intent.operation, '_', ' ')),
    intent.requested_status,
    intent.status,
    intent.created_by::text,
    actor.name,
    CASE WHEN actor.id IS NOT NULL THEN 'available' ELSE 'unavailable' END,
    'direct_provider_account_id',
    'workflow_object',
    CASE
      WHEN intent.source_decision_id IS NOT NULL
        OR intent.creative_brief_id IS NOT NULL
        OR intent.source_draft_id IS NOT NULL
      THEN 'keyed'
      ELSE 'unavailable'
    END,
    COALESCE(
      intent.source_decision_id,
      intent.creative_brief_id::text,
      intent.source_draft_id::text
    ),
    CASE
      WHEN intent.source_decision_id IS NULL
        AND intent.creative_brief_id IS NULL
        AND intent.source_draft_id IS NULL
      THEN 'The LaunchIntent has no persisted Decision, Brief, or Draft lineage.'
      ELSE NULL
    END,
    snapshot.as_of_date::text,
    snapshot.engine_version,
    jsonb_build_object(
      'launchIntentId', intent.id,
      'providerAccountId', intent.provider_account_id,
      'operation', intent.operation,
      'requestedStatus', intent.requested_status,
      'sourceDecisionId', intent.source_decision_id,
      'sourceDecisionSnapshotId', intent.source_decision_snapshot_id,
      'creativeBriefId', intent.creative_brief_id,
      'sourceDraftId', intent.source_draft_id,
      'status', intent.status,
      'validationReceipt', intent.validation_receipt_json,
      'resultReceipt', intent.result_receipt_json,
      'errorReceipt', intent.error_receipt_json,
      'requestFingerprint', intent.request_fingerprint,
      'startedAt', intent.started_at,
      'completedAt', intent.completed_at
    )
  FROM meta_launch_intents intent
  LEFT JOIN users actor
    ON actor.id = intent.created_by
  LEFT JOIN engine_v3_decision_snapshots_daily snapshot
    ON snapshot.id = intent.source_decision_snapshot_id
   AND (snapshot.business_ref_id::text = $1 OR snapshot.business_id = $1)
  WHERE intent.business_id::text = $1
    AND intent.provider_account_id = $2
  /* OPTIONAL_META_LAUNCH_INTENTS_END */

  UNION ALL

  SELECT
    'meta_campaign_dimensions',
    campaign.id::text,
    'persisted_uuid',
    'structures',
    COALESCE(campaign.source_updated_at, campaign.updated_at, campaign.last_seen_at, campaign.created_at),
    COALESCE(campaign.source_updated_at, campaign.updated_at, campaign.last_seen_at, campaign.created_at)::date,
    COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical, campaign.campaign_id),
    'Last persisted campaign status: ' || UPPER(campaign.campaign_status) || '.',
    'campaign',
    campaign.campaign_id,
    COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical),
    NULL,
    'closed',
    NULL,
    NULL,
    'not_applicable',
    'direct_provider_account_id',
    'warehouse_dimension',
    'not_applicable',
    NULL,
    NULL,
    NULL,
    NULL,
    jsonb_build_object(
      'status', UPPER(campaign.campaign_status),
      'buyingType', campaign.buying_type,
      'firstSeenAt', campaign.first_seen_at,
      'lastSeenAt', campaign.last_seen_at,
      'sourceUpdatedAt', campaign.source_updated_at
    )
  FROM meta_campaign_dimensions campaign
  WHERE campaign.business_id = $1
    AND campaign.provider_account_id = $2
    AND UPPER(COALESCE(campaign.campaign_status, '')) IN ('PAUSED', 'ARCHIVED', 'DELETED')

  UNION ALL

  SELECT
    'meta_adset_dimensions',
    adset.id::text,
    'persisted_uuid',
    'structures',
    COALESCE(adset.source_updated_at, adset.updated_at, adset.last_seen_at, adset.created_at),
    COALESCE(adset.source_updated_at, adset.updated_at, adset.last_seen_at, adset.created_at)::date,
    COALESCE(adset.adset_name_current, adset.adset_name_historical, adset.adset_id),
    'Last persisted ad set status: ' || UPPER(adset.adset_status) || '.',
    'adset',
    adset.adset_id,
    COALESCE(adset.adset_name_current, adset.adset_name_historical),
    NULL,
    'closed',
    NULL,
    NULL,
    'not_applicable',
    'direct_provider_account_id',
    'warehouse_dimension',
    'not_applicable',
    NULL,
    NULL,
    NULL,
    NULL,
    jsonb_build_object(
      'status', UPPER(adset.adset_status),
      'campaignId', adset.campaign_id,
      'firstSeenAt', adset.first_seen_at,
      'lastSeenAt', adset.last_seen_at,
      'sourceUpdatedAt', adset.source_updated_at
    )
  FROM meta_adset_dimensions adset
  WHERE adset.business_id = $1
    AND adset.provider_account_id = $2
    AND UPPER(COALESCE(adset.adset_status, '')) IN ('PAUSED', 'ARCHIVED', 'DELETED')

  UNION ALL

  -- Campaign configuration observed to change. Whether it was this product or
  -- somebody in Ads Manager is decided in mapHistoryRow by correlating against
  -- the action log, not guessed at here: the SQL only reports what changed and
  -- when, and carries the previous value so the reader can see the movement.
  SELECT
    'meta_campaign_config_history',
    config.id::text,
    'persisted_uuid',
    'external_changes',
    config.captured_at,
    config.captured_at::date,
    'Campaign configuration changed | '
      || COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical, config.campaign_id),
    NULL,
    'campaign',
    config.campaign_id,
    COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical),
    NULL,
    'observed',
    NULL,
    NULL,
    'not_applicable',
    'direct_provider_account_id',
    'provider_config_history',
    'unavailable',
    NULL,
    'Origin is attributed from the action log when this row is presented.',
    NULL,
    NULL,
    jsonb_build_object(
      'configFingerprint', config.config_fingerprint,
      'dailyBudget', config.daily_budget,
      'lifetimeBudget', config.lifetime_budget,
      'bidStrategyType', config.bid_strategy_type,
      'bidValue', config.bid_value,
      'optimizationGoal', config.optimization_goal,
      'previousDailyBudget', previous.daily_budget,
      'previousBidValue', previous.bid_value,
      'previousBidStrategyType', previous.bid_strategy_type,
      'observedAt', config.captured_at
    )
  FROM meta_campaign_config_history config
  LEFT JOIN LATERAL (
    SELECT prior.daily_budget, prior.bid_value, prior.bid_strategy_type
    FROM meta_campaign_config_history prior
    WHERE prior.business_id = config.business_id
      AND prior.provider_account_id = config.provider_account_id
      AND prior.campaign_id = config.campaign_id
      AND prior.captured_at < config.captured_at
    ORDER BY prior.captured_at DESC
    LIMIT 1
  ) previous ON TRUE
  LEFT JOIN LATERAL (
    SELECT dimension.campaign_name_current, dimension.campaign_name_historical
    FROM meta_campaign_dimensions dimension
    WHERE dimension.business_id = config.business_id
      AND dimension.provider_account_id = config.provider_account_id
      AND dimension.campaign_id = config.campaign_id
    ORDER BY dimension.updated_at DESC
    LIMIT 1
  ) campaign ON TRUE
  WHERE config.business_id = $1
    AND config.provider_account_id = $2
    -- Only rows that represent a change; the first snapshot of a campaign is
    -- not something anyone did.
    AND previous.daily_budget IS DISTINCT FROM config.daily_budget

  UNION ALL

  -- Workflow ownership. Who claimed, deferred or disagreed with a decision is
  -- part of what happened to it; without this History showed the engine's
  -- verdict and nothing about the people acting on it.
  SELECT
    'decision_workflow_events',
    workflow.id::text,
    'persisted_uuid',
    'decisions',
    workflow.created_at,
    workflow.created_at::date,
    'Workflow ' || REPLACE(workflow.event, '_', ' '),
    NULLIF(workflow.reason_code, ''),
    'decision',
    workflow.decision_key,
    NULL,
    workflow.to_state,
    'recorded',
    NULL,
    NULL,
    'not_applicable',
    'decision_key',
    'operator_workflow',
    'unavailable',
    NULL,
    'Workflow state is owned by the operator, not by the engine.',
    workflow.created_at::date::text,
    NULL,
    jsonb_build_object(
      'event', workflow.event,
      'fromState', workflow.from_state,
      'toState', workflow.to_state,
      'stateVersion', workflow.state_version
    )
  FROM decision_workflow_events workflow
  WHERE workflow.business_id = $1

  UNION ALL

  -- The provider attempt journal. An operator reviewing an incident needs to
  -- see that a write was attempted, what the provider said, and whether the
  -- outcome was ambiguous -- not just that a decision existed.
  SELECT
    'meta_ads_action_mutation_attempt_events',
    attempt.id::text,
    'persisted_uuid',
    'actions',
    attempt.created_at,
    attempt.created_at::date,
    CASE attempt.event_kind
      WHEN 'attempt_started' THEN 'Provider write attempted'
      ELSE 'Provider write ' || COALESCE(
        REPLACE(attempt.completion_outcome, '_', ' '),
        'completed'
      )
    END,
    NULL,
    'ad',
    attempt.ad_id,
    NULL,
    attempt.action,
    CASE
      WHEN attempt.event_kind = 'attempt_started' THEN 'pending'
      WHEN attempt.completion_outcome = 'provider_response_verified_success'
        THEN 'recorded'
      ELSE 'failed'
    END,
    NULL,
    NULL,
    'not_applicable',
    'exact_ad_key',
    'provider_attempt',
    'unavailable',
    NULL,
    'Attempt lineage is append-only and never rewritten.',
    attempt.created_at::date::text,
    NULL,
    jsonb_build_object(
      'eventKind', attempt.event_kind,
      'completionOutcome', attempt.completion_outcome,
      'providerOutcome', attempt.provider_outcome,
      'httpStatus', attempt.http_status,
      'creativeId', attempt.creative_id,
      'campaignId', attempt.campaign_id,
      'adsetId', attempt.adset_id
    )
  FROM meta_ads_action_mutation_attempt_events attempt
  -- business_id is UUID on this table, and $1 is already pinned to text by the
  -- earlier branches of this UNION. Without the cast Postgres refuses the whole
  -- query with "operator does not exist: uuid = text", which took the entire
  -- History surface down -- every source, not just this one.
  WHERE attempt.business_id::text = $1
    AND attempt.provider_account_id = $2
),
filtered_entries AS (
  SELECT *
  FROM history_entries
  WHERE ($3::text IS NOT NULL OR kind <> 'structures')
    AND ($3::text IS NULL OR kind = $3)
    AND ($4::text IS NULL OR entity_type = $4)
    AND ($5::text IS NULL OR LOWER(COALESCE(label, '')) = LOWER($5))
    AND ($6::date IS NULL OR event_date >= $6::date)
    AND ($7::date IS NULL OR event_date <= $7::date)
    AND (
      $8::text IS NULL
      OR COALESCE(title, '') ILIKE '%' || $8 || '%'
      OR COALESCE(summary, '') ILIKE '%' || $8 || '%'
      OR COALESCE(entity_id, '') ILIKE '%' || $8 || '%'
      OR COALESCE(entity_name, '') ILIKE '%' || $8 || '%'
      OR COALESCE(label, '') ILIKE '%' || $8 || '%'
    )
),
cursor_entries AS (
  SELECT *
  FROM filtered_entries
  WHERE (
      $9::timestamptz IS NULL
      OR (occurred_at, source_key, source_id) < ($9::timestamptz, $10::text, $11::text)
    )
)
SELECT
  source_key,
  source_id,
  source_id_kind,
  kind,
  occurred_at::text AS occurred_at,
  title,
  summary,
  entity_type,
  entity_id,
  entity_name,
  label,
  status_raw,
  actor_id,
  actor_name,
  actor_availability,
  account_scope_basis,
  attribution,
  correlation_status,
  correlation_key,
  correlation_reason,
  replay_date,
  engine_version,
  detail_json
FROM cursor_entries
ORDER BY occurred_at DESC, source_key DESC, source_id DESC
LIMIT $12
`;

function omitOptionalHistoryBlock(
  sql: string,
  marker: "META_CREATIVE_BRIEFS" | "META_LAUNCH_INTENTS",
) {
  const start = `/* OPTIONAL_${marker}_START */`;
  const end = `/* OPTIONAL_${marker}_END */`;
  const startIndex = sql.indexOf(start);
  const endIndex = sql.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error(`Meta History SQL marker ${marker} is missing.`);
  }
  return `${sql.slice(0, startIndex)}${sql.slice(endIndex + end.length)}`;
}

export function buildMetaHistoryReadSql(input: {
  includeCreativeBriefs: boolean;
  includeLaunchIntents: boolean;
}) {
  let sql = META_HISTORY_READ_SQL;
  if (!input.includeCreativeBriefs) {
    sql = omitOptionalHistoryBlock(sql, "META_CREATIVE_BRIEFS");
  }
  if (!input.includeLaunchIntents) {
    sql = omitOptionalHistoryBlock(sql, "META_LAUNCH_INTENTS");
  }
  return sql;
}

interface MetaHistoryAccountDbRow {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

interface MetaHistoryDbRow {
  source_key: string;
  source_id: string;
  source_id_kind: string;
  kind: string;
  occurred_at: string;
  title: string;
  summary: string | null;
  entity_type: string;
  entity_id: string;
  entity_name: string | null;
  label: string | null;
  status_raw: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_availability: string;
  account_scope_basis: string;
  attribution: string;
  correlation_status: string;
  correlation_key: string | null;
  correlation_reason: string | null;
  replay_date: string | null;
  engine_version: string | null;
  detail_json: unknown;
}

const STATUS_VALUES = new Set<MetaHistoryEntryStatus>([
  "published",
  "recorded",
  "pending",
  "verified_success",
  "failed",
  "silent_failure",
  "unknown_outcome",
  "open",
  "resolved",
  "closed",
  "improved",
  "regressed",
  "flat",
  "inconclusive",
  "positive",
  "negative",
  "neutral",
  "unknown",
]);

const SENSITIVE_KEY = /(access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)/i;

function normalizeCurrency(value: string | null | undefined) {
  const currency = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizedDateTime(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function toFiniteNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function redactString(value: string) {
  return value
    .replace(/([?&]access_token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/bearer\s+[a-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .slice(0, 4_000);
}

export function redactMetaHistoryDetail(value: unknown, depth = 0): unknown {
  if (depth >= 8) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactMetaHistoryDetail(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : redactMetaHistoryDetail(item, depth + 1),
    ]),
  );
}

function moneyFact(input: {
  label: string;
  value: unknown;
  currency: string | null;
}): MetaHistoryMoneyFact | null {
  const amount = toFiniteNumber(input.value);
  if (amount == null) return null;
  return {
    label: input.label,
    amount: input.currency ? amount : null,
    currency: input.currency,
    availability: input.currency ? "available" : "currency_unavailable",
    attribution: "meta_attributed",
  };
}

function moneyFactsForRow(
  source: MetaHistorySource,
  detail: Record<string, unknown> | null,
  currency: string | null,
) {
  if (!detail) return [];
  const candidates: Array<{ label: string; value: unknown }> = [];
  if (source === "engine_v3_decision_snapshots_daily") {
    candidates.push({ label: "Spend at decision", value: detail.spend });
  } else if (source === "engine_v3_decision_outcomes_daily") {
    candidates.push(
      { label: "Baseline spend", value: detail.baselineSpend },
      { label: "Outcome spend", value: detail.outcomeSpend },
      { label: "Meta-attributed outcome revenue", value: detail.outcomeRevenue },
    );
  } else if (source === "meta_decision_action_outcome_logs") {
    const payload = asRecord(detail.payload);
    const kpis = asRecord(payload?.kpis);
    candidates.push(
      { label: "Before spend", value: kpis?.spendBefore },
      { label: "After spend", value: kpis?.spendAfter },
      { label: "Meta-attributed before revenue", value: kpis?.revenueBefore },
      { label: "Meta-attributed after revenue", value: kpis?.revenueAfter },
    );
  }
  return candidates
    .map((candidate) => moneyFact({ ...candidate, currency }))
    .filter((fact): fact is MetaHistoryMoneyFact => fact !== null);
}

function normalizeStatus(value: string | null): MetaHistoryEntryStatus {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "success") return "recorded";
  if (normalized === "failure") return "failed";
  if (normalized === "ambiguous" || normalized === "unknown outcome") {
    return "unknown_outcome";
  }
  return STATUS_VALUES.has(normalized as MetaHistoryEntryStatus)
    ? (normalized as MetaHistoryEntryStatus)
    : "unknown";
}

function mapHistoryRow(
  row: MetaHistoryDbRow,
  currency: string | null,
  recordedActions: RecordedAction[] = [],
): MetaHistoryEntry | null {
  if (
    !META_HISTORY_SOURCES.includes(row.source_key as MetaHistorySource) ||
    !META_HISTORY_KINDS.includes(row.kind as MetaHistoryKind) ||
    !META_HISTORY_ENTITY_TYPES.includes(row.entity_type as MetaHistoryEntityType)
  ) {
    return null;
  }
  const occurredAt = normalizedDateTime(row.occurred_at);
  if (!occurredAt || !row.source_id || !row.entity_id) return null;

  const source = row.source_key as MetaHistorySource;
  const detail = asRecord(row.detail_json);

  // Origin for an observed configuration change is decided here rather than in
  // SQL, so the single tested correlation is the only implementation.
  if (source === "meta_campaign_config_history" && detail) {
    const attributed = attributeObservedChange(
      {
        entityType: "campaign",
        entityId: row.entity_id,
        businessId: "",
        field: "daily_budget",
        previousValue:
          detail.previousDailyBudget == null ? null : String(detail.previousDailyBudget),
        nextValue: detail.dailyBudget == null ? null : String(detail.dailyBudget),
        observedAt: occurredAt,
      },
      recordedActions,
    );
    detail.origin = attributed.origin;
    detail.originLabel = describeChangeOrigin(attributed.origin);
    detail.originReason = attributed.reason;
  }
  const sourceIdKind: MetaHistorySourceIdKind =
    row.source_id_kind === "persisted_composite_key"
      ? "persisted_composite_key"
      : "persisted_uuid";
  const accountScopeBasis = row.account_scope_basis as MetaHistoryAccountScopeBasis;
  const actorAvailability =
    row.actor_availability === "available" || row.actor_availability === "unavailable"
      ? row.actor_availability
      : "not_applicable";
  const correlationStatus =
    row.correlation_status === "keyed" || row.correlation_status === "unavailable"
      ? row.correlation_status
      : "not_applicable";

  return {
    id: `${source}:${row.source_id}`,
    kind: row.kind as MetaHistoryKind,
    occurredAt,
    title: row.title?.trim() || "Persisted Meta journal entry",
    summary: row.summary?.trim() || null,
    entity: {
      type: row.entity_type as MetaHistoryEntityType,
      id: row.entity_id,
      name: row.entity_name?.trim() || null,
    },
    label: row.label?.trim() || null,
    status: normalizeStatus(row.status_raw),
    actor: {
      id: row.actor_id,
      name: row.actor_name?.trim() || null,
      availability: actorAvailability,
    },
    identity: {
      canonicalDecisionId: null,
      sourceId: row.source_id,
      sourceIdKind,
      limitation: CANONICAL_ID_LIMITATION,
    },
    provenance: {
      provider: "meta",
      source,
      sourceId: row.source_id,
      accountScopeBasis,
      attribution: row.attribution as MetaHistoryEntry["provenance"]["attribution"],
    },
    correlation: {
      status: correlationStatus,
      key: row.correlation_key,
      reason: row.correlation_reason,
    },
    replay: row.replay_date
      ? {
          date: row.replay_date.slice(0, 10),
          engineVersion: row.engine_version,
        }
      : null,
    money: moneyFactsForRow(source, detail, currency),
    detail: asRecord(redactMetaHistoryDetail(detail)),
  };
}

export async function readMetaHistoryAccounts(
  businessId: string,
): Promise<MetaHistoryAccount[]> {
  const rows = await getDb().query<MetaHistoryAccountDbRow>(META_HISTORY_ACCOUNTS_SQL, [
    businessId,
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name?.trim() || null,
    currency: normalizeCurrency(row.currency),
    timezone: row.timezone?.trim() || null,
  }));
}

/**
 * Recent provider actions this product recorded, shaped for attribution.
 *
 * Verification status matters more than success here: an action we never
 * verified cannot be claimed as the cause of an observed change.
 */
async function readRecordedActionsForAttribution(input: {
  businessId: string;
}): Promise<RecordedAction[]> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_ads_action_log"],
  }).catch(() => null);
  if (!readiness?.ready) return [];
  const rows = (await getDb().query<{
    entity_id: string;
    requested_at: string;
    status: string;
    verified_at: string | null;
    requested_by: string | null;
  }>(
    `
      SELECT ad_id AS entity_id,
             requested_at::text,
             status,
             verified_at::text,
             requested_by::text
      FROM meta_ads_action_log
      WHERE business_id::text = $1
      ORDER BY requested_at DESC
      LIMIT 500
    `,
    [input.businessId],
  )) as
    | Array<{
        entity_id: string;
        requested_at: string;
        status: string;
        verified_at: string | null;
        requested_by: string | null;
      }>
    | undefined;

  return (rows ?? []).map((row) => ({
    entityId: row.entity_id,
    field: "daily_budget",
    requestedAt: row.requested_at,
    status:
      row.status === "success" && row.verified_at
        ? "verified"
        : row.status === "failed"
          ? "failed"
          : row.status === "ambiguous"
            ? "ambiguous"
            : "pending",
    actorUserId: row.requested_by,
  }));
}

export async function readMetaHistoryJournal(input: {
  query: MetaHistoryQuery;
  account: MetaHistoryAccount;
}): Promise<MetaHistoryResponse> {
  if (input.account.id !== input.query.providerAccountId) {
    throw new Error("Meta History account scope does not match the query.");
  }
  const cursor = input.query.cursor;
  const optionalSources = await getDbSchemaReadiness({
    tables: ["meta_creative_briefs", "meta_launch_intents"],
  });
  const includeCreativeBriefs = !optionalSources.missingTables.includes(
    "meta_creative_briefs",
  );
  const includeLaunchIntents = !optionalSources.missingTables.includes(
    "meta_launch_intents",
  );
  const readSql = buildMetaHistoryReadSql({
    includeCreativeBriefs,
    includeLaunchIntents,
  });
  const sqlRows = await getDb().query<MetaHistoryDbRow>(readSql, [
    input.query.businessId,
    input.query.providerAccountId,
    input.query.kind,
    input.query.entity,
    input.query.label,
    input.query.from,
    input.query.to,
    input.query.q,
    cursor?.occurredAt ?? null,
    cursor?.source ?? null,
    cursor?.sourceId ?? null,
    input.query.limit + 1,
  ]);

  const hasMore = sqlRows.length > input.query.limit;
  const visibleRows = sqlRows.slice(0, input.query.limit);
  // Actions this product recorded, so an observed change can be attributed to
  // us, to somebody else, or to neither with honesty about which. Only read
  // when the page actually contains an observed change to attribute.
  const needsAttribution = visibleRows.some(
    (row) => row.source_key === "meta_campaign_config_history",
  );
  const recordedActions = needsAttribution
    ? await readRecordedActionsForAttribution({ businessId: input.query.businessId })
    : [];
  const entries = visibleRows
    .map((row) => mapHistoryRow(row, input.account.currency, recordedActions))
    .filter((entry): entry is MetaHistoryEntry => entry !== null);
  const lastRow = hasMore ? visibleRows.at(-1) : null;
  const lastOccurredAt = lastRow ? normalizedDateTime(lastRow.occurred_at) : null;
  const nextCursor =
    lastRow &&
    lastOccurredAt &&
    META_HISTORY_SOURCES.includes(lastRow.source_key as MetaHistorySource)
      ? encodeMetaHistoryCursor({
          occurredAt: lastOccurredAt,
          source: lastRow.source_key as MetaHistorySource,
          sourceId: lastRow.source_id,
        })
      : null;

  return {
    mode: "read_only",
    scope: {
      businessId: input.query.businessId,
      providerAccountId: input.account.id,
      providerAccountName: input.account.name,
      currency: input.account.currency,
      timezone: input.account.timezone,
    },
    filters: {
      businessId: input.query.businessId,
      providerAccountId: input.query.providerAccountId,
      kind: input.query.kind,
      entity: input.query.entity,
      label: input.query.label,
      from: input.query.from,
      to: input.query.to,
      q: input.query.q,
    },
    entries,
    page: {
      limit: input.query.limit,
      returned: entries.length,
      total: null,
      nextCursor,
    },
    identityContract: {
      canonicalDecisionIdAvailable: false,
      grouping: "persisted_source_rows",
      limitation:
        "Canonical date-free decision identity is not available in the current journals. Entries remain separate persisted source rows; no synthetic episodes are created.",
    },
    limitations: [
      {
        code: "canonical_decision_id_unavailable",
        message:
          "A date-free decision ID is not persisted yet. Snapshot rows use their persisted UUID or composite primary key.",
      },
      {
        code: "business_only_rows_omitted",
        message:
          "Business-only records without an exact provider-account or entity-key join are omitted from this account-scoped journal.",
      },
      {
        code: "shared_creative_rows_omitted",
        message:
          "Creative snapshots observed under more than one provider account are omitted because their persisted rows do not isolate account or currency.",
      },
      {
        code: "missing_join_unavailable",
        message:
          "Missing decision, actor, or receipt links are shown as unavailable; text and fingerprint similarity are never used to correlate records.",
      },
      ...(input.query.kind === null
        ? [
            {
              code: "structure_inventory_explicit_filter" as const,
              message:
                "Current paused/archive structure inventory is excluded from the default event journal. Select Structure inventory explicitly to inspect those warehouse rows.",
            },
          ]
        : []),
      ...(!includeCreativeBriefs || !includeLaunchIntents
        ? [
            {
              code: "optional_source_unavailable" as const,
              message: `Optional workflow sources are omitted until their pending migration is applied: ${[
                !includeCreativeBriefs ? "Creative Briefs" : null,
                !includeLaunchIntents ? "LaunchIntents" : null,
              ]
                .filter(Boolean)
                .join(", ")}.`,
            },
          ]
        : []),
    ],
  };
}
