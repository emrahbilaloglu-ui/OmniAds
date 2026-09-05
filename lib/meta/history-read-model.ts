import { getDb } from "@/lib/db";
import {
  attributeObservedChange,
  describeChangeOrigin,
  type RecordedAction,
} from "@/lib/external-change-attribution";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
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
  metaHistoryOutcomeRawValues,
} from "@/lib/meta/history-contract";

const CANONICAL_ID_LIMITATION =
  "A canonical date-free decision ID is not persisted yet. This entry is keyed only by its persisted source row.";

/**
 * The Meta accounts this business has SELECTED right now.
 *
 * `business_provider_accounts` carries two different facts in one table: the
 * immutable historical identity binding (created once, never deleted, because
 * many rows reference it as provenance) and the CURRENT selection, which is
 * `is_selected`. Deselecting an account only flips the flag.
 *
 * This read used to ignore the flag, so it answered with the identity binding
 * instead of the assignment. An account the operator had removed from the
 * business still appeared in the History account scope, and — because the
 * `/api/meta/history` endpoint validates the caller's `providerAccountId`
 * against exactly this list — its journal, currency and account name were still
 * served. Every other surface in the product resolves scope through
 * `getProviderAccountAssignments`, which has always filtered `is_selected`;
 * History was the one reader that disagreed with the rest about what "assigned"
 * means.
 *
 * `assignment.is_selected` is therefore part of the WHERE clause, not a
 * post-filter: a stale or unselected identity row is not an assignment and must
 * never reach a caller.
 */
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
  AND assignment.is_selected
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
-- The same exact-and-unique inference creative_account_scope makes, for the
-- two entity grains a v1 snapshot can be about.
--
-- It exists ONLY to attribute rows written before snapshots carried a lineage
-- (D-M011). A legacy row names a campaign or an ad set; if that entity belongs
-- to exactly ONE account in this business AND that account is the selected one,
-- the row's account is proven rather than guessed. If the id appears under two
-- accounts the inference is refused, and the row stays out of an account-scoped
-- view — which is the whole point of HAVING COUNT(DISTINCT ...) = 1.
campaign_account_scope AS (
  SELECT
    campaign_id,
    MIN(provider_account_id) AS provider_account_id
  FROM meta_campaign_dimensions
  WHERE business_id = $1
  GROUP BY campaign_id
  HAVING COUNT(DISTINCT provider_account_id) = 1
     AND MIN(provider_account_id) = $2
),
adset_account_scope AS (
  SELECT
    adset_id,
    MIN(provider_account_id) AS provider_account_id
  FROM meta_adset_dimensions
  WHERE business_id = $1
  GROUP BY adset_id
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
-- NOT MATERIALIZED so each reference can push its own predicates down.
-- Four references made Postgres materialise this and rescan the whole result
-- inside three per-row LATERALs ("the latest snapshot for this rec_id"), which
-- a materialised CTE cannot index: 113 rescans, and the slowest branch of the
-- journal read. Inlined, each reference reaches
-- meta_decision_snapshots_daily's own indexes. Same rows either way.
v1_scoped_snapshots AS NOT MATERIALIZED (
  SELECT
    snapshot.*,
    COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical,
             adset.adset_name_current, adset.adset_name_historical) AS entity_name,
    CASE
      WHEN snapshot.scope_type = 'campaign' THEN 'campaign'
      ELSE 'adset'
    END AS resolved_entity_type,
    -- The account is part of the identity (D-M011), because two assigned
    -- accounts may legitimately hold the same scope, date and rec type — and
    -- without it those two rows collapse to ONE id in a journal that uses this
    -- as its source_id. A row with no lineage says so rather than borrowing the
    -- selected account's name.
    snapshot.scope_type || ':' || snapshot.scope_id || ':' || snapshot.snapshot_date::text || ':' || snapshot.rec_type
      || ':' || COALESCE(snapshot.provider_account_id, 'unattributed') AS persisted_id,
    -- How this row's account was established, carried through to the journal so
    -- a reader is told which of the two it is looking at.
    CASE
      WHEN snapshot.provider_account_id IS NOT NULL THEN 'direct_provider_account_id'
      ELSE 'unique_entity_key'
    END AS account_scope_basis
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
  LEFT JOIN campaign_account_scope campaign_scope
    ON snapshot.scope_type = 'campaign'
   AND campaign_scope.campaign_id = snapshot.scope_id
  LEFT JOIN adset_account_scope adset_scope
    ON snapshot.scope_type = 'adset'
   AND adset_scope.adset_id = snapshot.scope_id
  WHERE snapshot.business_id = $1
    /*
     * The account, PROVEN, one of exactly two ways.
     *
     * Direct: the snapshot carries the lineage it was computed under (D-M011),
     * and it must be the selected account. This is the only admission path for
     * anything written since, and it is an equality rather than an inference.
     *
     * Legacy: the row predates the column. It is admitted only when its entity
     * resolves to exactly ONE account in this business and that account is the
     * selected one. A campaign id seen under two accounts proves nothing and is
     * refused. The entity-name joins above are NOT this proof — they establish
     * that an entity by that id exists under the selected account, not that it
     * exists under no other.
     *
     * Nothing is admitted on a rec id. Rec ids may now repeat across accounts.
     */
    AND (
      snapshot.provider_account_id = $2
      OR (
        snapshot.provider_account_id IS NULL
        AND (
          (snapshot.scope_type = 'campaign' AND campaign_scope.campaign_id IS NOT NULL)
          OR (snapshot.scope_type = 'adset' AND adset_scope.adset_id IS NOT NULL)
        )
      )
    )
    AND (
      (snapshot.scope_type = 'campaign' AND campaign.id IS NOT NULL)
      OR (snapshot.scope_type = 'adset' AND adset.id IS NOT NULL)
    )
),
-- Configuration edits, with each row's predecessor resolved in one pass.
--
-- Both branches used to answer "what did this look like before" with a
-- correlated LATERAL per row. The change test compares against that lookup, so
-- Postgres had to run it for every stored row before it could discard the ones
-- that were not edits: 1.8 million index lookups to keep 2,038 rows, and the
-- whole History read timed out at 8s on a real account and reported itself
-- unavailable. LAG over the same ordering is one sorted pass and the identical
-- predecessor.
campaign_config_window AS (
  SELECT
    config.*,
    LAG(config.daily_budget) OVER w AS prev_daily_budget,
    LAG(config.lifetime_budget) OVER w AS prev_lifetime_budget,
    LAG(config.bid_value) OVER w AS prev_bid_value,
    LAG(config.bid_strategy_type) OVER w AS prev_bid_strategy_type,
    LAG(config.optimization_goal) OVER w AS prev_optimization_goal
  FROM meta_campaign_config_history config
  WHERE config.business_id = $1
    AND config.provider_account_id = $2
    -- The same slice bounds the whole union (see filtered_entries). Without
    -- them this scanned every stored configuration row for the account to
    -- surface a handful of recent edits.
    -- COALESCE, not an IS NULL disjunction: the disjunctive form is not
    -- sargable, so the planner ignored the index and seq-scanned regardless.
    AND config.captured_at >= COALESCE($15::timestamptz, '-infinity'::timestamptz)
    AND config.captured_at <= COALESCE($9::timestamptz, 'infinity'::timestamptz)
  WINDOW w AS (
    PARTITION BY config.business_id, config.provider_account_id, config.campaign_id
    ORDER BY config.captured_at
  )
),
adset_config_window AS (
  SELECT
    adset_config.*,
    LAG(adset_config.daily_budget) OVER w AS prev_daily_budget,
    LAG(adset_config.lifetime_budget) OVER w AS prev_lifetime_budget,
    LAG(adset_config.bid_value) OVER w AS prev_bid_value,
    LAG(adset_config.bid_strategy_type) OVER w AS prev_bid_strategy_type,
    LAG(adset_config.optimization_goal) OVER w AS prev_optimization_goal
  FROM meta_adset_config_history adset_config
  WHERE adset_config.business_id = $1
    AND adset_config.provider_account_id = $2
    -- The same slice bounds the whole union (see filtered_entries). Without
    -- them this scanned every stored configuration row for the account to
    -- surface a handful of recent edits.
    -- COALESCE, not an IS NULL disjunction: the disjunctive form is not
    -- sargable, so the planner ignored the index and seq-scanned regardless.
    AND adset_config.captured_at >= COALESCE($15::timestamptz, '-infinity'::timestamptz)
    AND adset_config.captured_at <= COALESCE($9::timestamptz, 'infinity'::timestamptz)
  WINDOW w AS (
    PARTITION BY adset_config.business_id, adset_config.provider_account_id, adset_config.adset_id
    ORDER BY adset_config.captured_at
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
    snapshot.account_scope_basis::text AS account_scope_basis,
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
  -- Cast the PARAMETER, never the column. Casting business_ref_id to text makes
  -- the comparison a computed expression, so its index cannot be used and the
  -- branch degrades to a sequential scan -- repeated once per outer row. On the
  -- outcomes branch that was 457 sequential scans of the whole table, 15 of the
  -- read's 27 seconds, against an 8s budget.
  WHERE (snapshot.business_ref_id = $1::uuid OR snapshot.business_id = $1)

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
   AND (snapshot.business_ref_id = $1::uuid OR snapshot.business_id = $1)
  WHERE (event.business_ref_id = $1::uuid OR event.business_id = $1)

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
   AND (snapshot.business_ref_id = $1::uuid OR snapshot.business_id = $1)
  INNER JOIN creative_account_scope account_scope
    ON account_scope.creative_id = outcome.creative_id
  LEFT JOIN creative_names names
    ON names.creative_id = outcome.creative_id
  WHERE (outcome.business_ref_id = $1::uuid OR outcome.business_id = $1)

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
      -- The snapshot this response answered must be the SAME account's. A rec
      -- id is not an account, and two accounts may now hold the same one, so
      -- matching on it alone would show account A the response account B gave.
      AND scoped.provider_account_id IS NOT DISTINCT FROM response.provider_account_id
      AND scoped.snapshot_date <= response.timestamp::date
    ORDER BY scoped.snapshot_date DESC, scoped.created_at DESC
    LIMIT 1
  ) snapshot ON TRUE
  WHERE response.business_id = $1
    /*
     * The response's OWN lineage decides, because it persists one (D-M012).
     *
     * A legacy response with no lineage is admitted only alongside a legacy
     * snapshot with none either — and that snapshot reached this CTE only by
     * the exact unique-entity inference above, so the pair is attributable
     * without either half being assigned an account it never proved.
     *
     * A legacy response against a lineage-carrying snapshot is REFUSED: the rec
     * id is the only thing linking them, and that is not proof.
     */
    AND (
      response.provider_account_id = $2
      OR (
        response.provider_account_id IS NULL
        AND snapshot.provider_account_id IS NULL
      )
    )

  UNION ALL

  SELECT
    'meta_ads_action_log',
    action_log.id::text,
    'persisted_uuid',
    'writes',
    action_log.requested_at,
    action_log.requested_at::date,
    /*
      The verb the write actually was.

      The operator bid route used to journal a cap change as
      action = 'launch_adset' with the real operation in
      payload_request.operation, so this title read "Launch Adset | Broad
      prospecting" for a verified bid apply. The route now writes 'bid' (which
      the CHECK and the unattended sweep have always used), and the rows already
      in the table keep their old spelling forever -- so the title is derived
      from the pair rather than from the column alone. Nothing is rewritten in
      place and the detail object below still carries the stored value
      verbatim: this reads the persisted row, it does not correct it.
    */
    INITCAP(REPLACE(
      CASE
        WHEN action_log.action = 'launch_adset'
         AND action_log.payload_request->>'operation' = 'apply_bid'
        THEN 'bid'
        ELSE action_log.action
      END,
      '_', ' '
    )) || ' | ' || COALESCE(resolved.entity_name, resolved.entity_id),
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
        /*
          A 'bid' row joins the ad-set dimension the same way. Both spellings of
          an operator bid write also carry scope_type = 'adset', and the
          unattended sweep's rows do too (lib/meta/scheduled-bid-runtime.ts
          writes action 'bid' with scope_type 'adset'), so this is belt-and-braces
          for a row whose payload lost its scope rather than a new admission.
          Driven, including that scopeless case, by
          lib/meta/bid-history-writes-journal.db.test.ts.
        */
        AND (
          action_log.payload_request->>'scope_type' = 'adset'
          OR action_log.action IN ('launch_adset', 'bid')
        )
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
      AND scoped.business_id = action_log.business_id::text
      AND scoped.rec_id = action_log.rec_id_origin
      -- Same account, proven on both sides rather than assumed from the CTE's
      -- own scoping: the decision a write is credited to must be one THIS
      -- account was actually given.
      AND scoped.provider_account_id IS NOT DISTINCT FROM action_log.provider_account_id
      AND scoped.snapshot_date <= action_log.requested_at::date
    ORDER BY scoped.snapshot_date DESC, scoped.created_at DESC
    LIMIT 1
  ) linked ON TRUE
  WHERE action_log.business_id::text = $1
    /*
     * Direct lineage. insertMetaAdsActionLog writes provider_account_id
     * alongside provider_account_ref_id, so the account is a persisted fact
     * here and does not have to be inferred from a dimension row — which would
     * also be incomplete, because this log records campaign, ad-set and launch
     * actions that no ad dimension resolves.
     *
     * A row whose lineage is null fails closed. Attaching it through
     * rec_id_origin would credit one account with the other's write the first
     * time a rec id repeats.
     */
    AND action_log.provider_account_id = $2

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
    CASE
      WHEN outcome_log.provider_account_id = $2 THEN 'direct_provider_account_id'
      ELSE 'unique_entity_key'
    END,
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
      AND scoped.business_id = outcome_log.business_id
      AND scoped.rec_id = outcome_log.rec_id
      AND scoped.provider_account_id IS NOT DISTINCT FROM outcome_log.provider_account_id
      AND scoped.snapshot_date <= outcome_log.occurred_at::date
    ORDER BY scoped.snapshot_date DESC, scoped.created_at DESC
    LIMIT 1
  ) linked ON TRUE
  WHERE outcome_log.business_id = $1
    /*
     * THE DEFECT THIS REPLACED. The old fallback admitted ANY null-lineage
     * outcome whose rec id matched an account-scoped snapshot — so once two
     * accounts could hold the same rec id (D-M011), an unattributed outcome
     * about account B appeared inside account A's history as if it were A's.
     *
     * A null-lineage outcome is now admitted only against a null-lineage
     * snapshot, which itself reached this CTE by exact unique-entity inference.
     * Both halves are legacy, and the pair is attributable without either being
     * assigned an account it never proved.
     */
    AND (
      outcome_log.provider_account_id = $2
      OR (
        outcome_log.provider_account_id IS NULL
        AND linked.rec_id IS NOT NULL
        AND linked.provider_account_id IS NULL
      )
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
   AND (snapshot.business_ref_id = $1::uuid OR snapshot.business_id = $1)
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
      'previousDailyBudget', config.prev_daily_budget,
      'previousLifetimeBudget', config.prev_lifetime_budget,
      'previousBidValue', config.prev_bid_value,
      'previousBidStrategyType', config.prev_bid_strategy_type,
      'previousOptimizationGoal', config.prev_optimization_goal,
      'observedAt', config.captured_at
    )
  FROM campaign_config_window config
  LEFT JOIN LATERAL (
    SELECT dimension.campaign_name_current, dimension.campaign_name_historical
    FROM meta_campaign_dimensions dimension
    WHERE dimension.business_id = config.business_id
      AND dimension.provider_account_id = config.provider_account_id
      AND dimension.campaign_id = config.campaign_id
    ORDER BY dimension.updated_at DESC
    LIMIT 1
  ) campaign ON TRUE
  WHERE
    -- Only rows that represent a change; the first snapshot of a campaign is
    -- not something anyone did.
    --
    -- Gated on daily_budget alone, this reported nothing at all on an
    -- ABO account: budget lives on the ad set there, so the campaign's
    -- daily_budget is null in every row and null IS NOT DISTINCT FROM null.
    -- A bid-strategy or optimization-goal change is just as much an edit, and
    -- was equally invisible on every account.
    (
      config.prev_daily_budget IS DISTINCT FROM config.daily_budget
      OR config.prev_lifetime_budget IS DISTINCT FROM config.lifetime_budget
      OR config.prev_bid_value IS DISTINCT FROM config.bid_value
      OR config.prev_bid_strategy_type IS DISTINCT FROM config.bid_strategy_type
      OR config.prev_optimization_goal IS DISTINCT FROM config.optimization_goal
    )

  UNION ALL

  -- Ad-set configuration. The same shape as the campaign branch above, and it
  -- was missing for the same reason it exists: an operator who changes an
  -- ad-set budget or bid in Ads Manager has changed what the engine is
  -- reasoning about, and History showed nothing. Budget lives at the campaign
  -- level for some accounts and the ad-set level for others, so projecting only
  -- campaigns made half the accounts look like nobody ever touched them.
  SELECT
    'meta_adset_config_history',
    adset_config.id::text,
    'persisted_uuid',
    'external_changes',
    adset_config.captured_at,
    adset_config.captured_at::date,
    'Ad set configuration changed | '
      || COALESCE(adset_dim.adset_name_current, adset_dim.adset_name_historical, adset_config.adset_id),
    NULL,
    'adset',
    adset_config.adset_id,
    COALESCE(adset_dim.adset_name_current, adset_dim.adset_name_historical),
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
      'configFingerprint', adset_config.config_fingerprint,
      'campaignId', adset_config.campaign_id,
      'dailyBudget', adset_config.daily_budget,
      'lifetimeBudget', adset_config.lifetime_budget,
      'bidStrategyType', adset_config.bid_strategy_type,
      'bidValue', adset_config.bid_value,
      'optimizationGoal', adset_config.optimization_goal,
      'previousDailyBudget', adset_config.prev_daily_budget,
      'previousBidValue', adset_config.prev_bid_value,
      'previousBidStrategyType', adset_config.prev_bid_strategy_type,
      'previousOptimizationGoal', adset_config.prev_optimization_goal,
      'observedAt', adset_config.captured_at
    )
  FROM adset_config_window adset_config
  LEFT JOIN LATERAL (
    SELECT dimension.adset_name_current, dimension.adset_name_historical
    FROM meta_adset_dimensions dimension
    WHERE dimension.business_id = adset_config.business_id
      AND dimension.provider_account_id = adset_config.provider_account_id
      AND dimension.adset_id = adset_config.adset_id
    ORDER BY dimension.updated_at DESC
    LIMIT 1
  ) adset_dim ON TRUE
  WHERE
    -- Only rows representing a change. The first snapshot of an ad set is not
    -- something anyone did. Budget, bid and optimization goal are each a
    -- separate way to change what the engine reasons about, so any of them
    -- moving qualifies.
    (
      adset_config.prev_daily_budget IS DISTINCT FROM adset_config.daily_budget
      OR adset_config.prev_lifetime_budget IS DISTINCT FROM adset_config.lifetime_budget
      OR adset_config.prev_bid_value IS DISTINCT FROM adset_config.bid_value
      OR adset_config.prev_bid_strategy_type IS DISTINCT FROM adset_config.bid_strategy_type
      OR adset_config.prev_optimization_goal IS DISTINCT FROM adset_config.optimization_goal
    )

  UNION ALL

  -- Status transitions at every level: campaign, ad set, ad and creative.
  --
  -- This is the source that made "ad and creative changes are not projected"
  -- true. Someone pausing an ad in Ads Manager is the single most common
  -- external change there is, and it was invisible here while a campaign
  -- budget edit was not.
  --
  -- Only a genuine transition is reported: meta_entity_state_history records
  -- an observation per run, so without the previous-state join this would
  -- report an unchanged ad every time the syncer looked at it.
  SELECT
    'meta_entity_state_history',
    entity_state.id::text,
    'persisted_uuid',
    'external_changes',
    entity_state.observed_at,
    entity_state.observed_at::date,
    CASE entity_state.entity_type
      WHEN 'campaign' THEN 'Campaign status changed | '
      WHEN 'adset' THEN 'Ad set status changed | '
      WHEN 'ad' THEN 'Ad status changed | '
      WHEN 'creative' THEN 'Creative status changed | '
      -- The column is CHECK-constrained to those four, so there is no fifth
      -- case; naming them all keeps the label honest if one is ever added.
      ELSE 'Entity status changed | '
    END || COALESCE(entity_state.entity_name, entity_state.entity_id),
    NULL,
    entity_state.entity_type,
    entity_state.entity_id,
    entity_state.entity_name,
    entity_state.configured_status,
    'observed',
    NULL,
    NULL,
    'not_applicable',
    'direct_provider_account_id',
    'provider_state_history',
    'unavailable',
    NULL,
    'Origin is attributed from the action log when this row is presented.',
    NULL,
    NULL,
    jsonb_build_object(
      'campaignId', entity_state.campaign_id,
      'adsetId', entity_state.adset_id,
      'adId', entity_state.ad_id,
      'creativeId', entity_state.creative_id,
      'configuredStatus', entity_state.configured_status,
      'effectiveStatus', entity_state.effective_status,
      'previousConfiguredStatus', entity_previous.configured_status,
      'previousEffectiveStatus', entity_previous.effective_status,
      'reviewStatus', entity_state.review_status,
      'policyStatus', entity_state.policy_status,
      'presence', entity_state.presence,
      'observedAt', entity_state.observed_at
    )
  FROM meta_entity_state_history entity_state
  LEFT JOIN LATERAL (
    SELECT prior.configured_status, prior.effective_status
    FROM meta_entity_state_history prior
    WHERE prior.business_id = entity_state.business_id
      AND prior.provider_account_id = entity_state.provider_account_id
      AND prior.entity_type = entity_state.entity_type
      AND prior.entity_id = entity_state.entity_id
      AND prior.observed_at < entity_state.observed_at
      -- D075 consumer sweep: status transitions are computed over PRESENT
      -- observations only. An absent_unconfirmed row carries no provider
      -- status (absence is evidence, not a state), so comparing against it
      -- would fabricate or mask transitions around scope exit/re-entry.
      AND prior.presence = 'present'
    ORDER BY prior.observed_at DESC
    LIMIT 1
  ) entity_previous ON TRUE
  WHERE entity_state.business_id = $1
    AND entity_state.provider_account_id = $2
    -- D075 consumer sweep: a scope-exit (absent_unconfirmed) row is not a
    -- status change — reporting it as one would turn every scope exit (and
    -- the one-time exit backfill of a scope's first delta run) into a burst
    -- of fabricated "status changed" history entries.
    AND entity_state.presence = 'present'
    -- A first observation is not a change, and an unchanged re-observation is
    -- not either. Both would turn the syncer's own cadence into activity.
    AND entity_previous.configured_status IS NOT NULL
    AND entity_previous.configured_status IS DISTINCT FROM entity_state.configured_status

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
    /*
     * The operator who moved it -- not "no human actor".
     *
     * These three columns were NULL, NULL, not_applicable, and not_applicable
     * renders as "No human actor (engine)". A workflow event is the one thing
     * in this journal that is ALWAYS a person: acknowledging, deferring,
     * rejecting and reopening are ownership acts, and
     * decision_workflow_events.actor_user_id records who performed them.
     * Attributing them to the engine inverted the single fact the row exists to
     * carry -- WP12 item 5.
     *
     * "unavailable" rather than "not_applicable" when the id no longer resolves
     * to a user (the FK is ON DELETE SET NULL, so a departed colleague's rows
     * survive them): a person acted and we cannot name them, which is a
     * different fact from no person having acted.
     *
     * No backticks anywhere in this comment: it lives inside a TypeScript
     * template literal, where a backtick ends the string.
     */
    workflow.actor_user_id::text,
    workflow_actor.name,
    CASE WHEN workflow_actor.id IS NOT NULL THEN 'available' ELSE 'unavailable' END,
    'decision_key',
    'operator_workflow',
    'unavailable',
    NULL,
    'Workflow state is owned by the operator, not by the engine.',
    workflow.created_at::date::text,
    NULL,
    jsonb_build_object(
      'event', workflow.event,
      -- Before/after, both of them. toState alone says where a decision ended
      -- up and hides what it was moved from, which is half of what an audit
      -- reader needs (WP12 item 7).
      'fromState', workflow.from_state,
      'toState', workflow.to_state,
      'stateVersion', workflow.state_version,
      'reasonCode', NULLIF(workflow.reason_code, ''),
      'actorUserId', workflow.actor_user_id::text
    )
  FROM decision_workflow_events workflow
  LEFT JOIN users workflow_actor
    ON workflow_actor.id = workflow.actor_user_id
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
  -- One slice for every source. The caller widens it until the page is full,
  -- so a bounded read never hides an entry — it only stops the union from
  -- materialising the account's entire history to return forty rows.
  WHERE occurred_at >= COALESCE($15::timestamptz, '-infinity'::timestamptz)
    AND ($3::text IS NOT NULL OR kind <> 'structures')
    AND ($3::text IS NULL OR kind = $3)
    AND ($4::text IS NULL OR entity_type = $4)
    AND ($5::text IS NULL OR LOWER(COALESCE(label, '')) = LOWER($5))
    -- Outcome groups the per-source status vocabularies (see
    -- META_HISTORY_OUTCOME_GROUPS). Server-side for the same reason search is:
    -- filtering the loaded page would report "no failed entries" for a failure
    -- that sits on the next one.
    AND (
      $13::text[] IS NULL
      OR (
        CASE
          WHEN $14::boolean
            THEN NOT (LOWER(COALESCE(status_raw, '')) = ANY($13::text[]))
          ELSE LOWER(COALESCE(status_raw, '')) = ANY($13::text[])
        END
      )
    )
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

/**
 * The canonical current assignment, read through the guard the whole product
 * shares — not through History's own SQL.
 *
 * `readMetaHistoryAccounts` and this function answer the same question from two
 * independent statements on purpose. History's own SQL exists because the
 * surface needs the account's NAME, CURRENCY and TIMEZONE, which the assignment
 * guard does not carry; but a scope decision must not rest on a projection that
 * only History maintains. When the two disagree — a warehouse row that outlives
 * a deselection, a join that widens — the intersection is what survives, so the
 * narrower answer always wins.
 *
 * Errors are NOT swallowed. An assignment read that fails is unknown, not
 * empty and not permissive: the caller must turn it into an unavailable state.
 * Catching it here would turn "we could not read the assignment" into "no
 * account is assigned", which reads as a settled fact on screen.
 */
export async function readMetaHistoryAssignedAccountIds(
  businessId: string,
): Promise<string[]> {
  const assignment = await getProviderAccountAssignments(businessId, "meta");
  return assignment?.account_ids ?? [];
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
  /**
   * The selected account. A change observed in one account must never be
   * attributed to a write recorded in another — the join downstream is on
   * `entityId`, and the answer it produces is "we caused this" or "somebody
   * else did", which is exactly the claim an unscoped read gets wrong.
   */
  providerAccountId: string;
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
        -- Direct lineage, and null fails closed: an action we cannot place in
        -- an account cannot be offered as the cause of that account's change.
        AND provider_account_id = $2
      ORDER BY requested_at DESC
      LIMIT 500
    `,
    [input.businessId, input.providerAccountId],
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

/**
 * How far back one read reaches, and when it reaches further.
 *
 * The union spans every Meta source, so an unbounded read materialised the
 * account's entire recorded history — 444k rows sorted to return forty — and
 * timed out at 8s on a real account, which the surface reported as "the
 * persisted Meta journal could not be read". Bounding it makes the common read
 * cheap; widening on a short page keeps it honest, because a bounded read that
 * stopped early would look exactly like the end of the journal.
 *
 * The last slice is unbounded on purpose: the loop must be able to prove there
 * is nothing older, not merely fail to find it.
 */
const META_HISTORY_SLICE_DAYS = [7, 30, 180, 730] as const;

async function readMetaHistorySlices(
  read: (sliceFloor: string | null) => Promise<MetaHistoryDbRow[]>,
  input: { wanted: number; from: string | null },
): Promise<MetaHistoryDbRow[]> {
  // An explicit from-date is already a floor; widening past it would read rows
  // the caller asked not to see.
  if (input.from) return read(input.from);
  for (const days of META_HISTORY_SLICE_DAYS) {
    const floor = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = await read(floor);
    if (rows.length >= input.wanted) return rows;
  }
  return read(null);
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
  const outcomeMatch = input.query.outcome
    ? metaHistoryOutcomeRawValues(input.query.outcome)
    : null;
  const sqlRows = await readMetaHistorySlices(async (sliceFloor) =>
    getDb().query<MetaHistoryDbRow>(readSql, [
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
      outcomeMatch?.values ?? null,
      outcomeMatch?.negate ?? false,
      sliceFloor,
    ]),
    { wanted: input.query.limit + 1, from: input.query.from },
  );

  const hasMore = sqlRows.length > input.query.limit;
  const visibleRows = sqlRows.slice(0, input.query.limit);
  // Actions this product recorded, so an observed change can be attributed to
  // us, to somebody else, or to neither with honesty about which. Only read
  // when the page actually contains an observed change to attribute.
  const needsAttribution = visibleRows.some(
    (row) => row.source_key === "meta_campaign_config_history",
  );
  const recordedActions = needsAttribution
    ? await readRecordedActionsForAttribution({
        businessId: input.query.businessId,
        providerAccountId: input.query.providerAccountId,
      })
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
      outcome: input.query.outcome,
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
