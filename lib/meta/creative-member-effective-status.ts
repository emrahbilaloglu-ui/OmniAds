/**
 * A creative-day has an exact, source-backed set of Ads, but its v2 writer has
 * no provider observation of delivery status. Resolve current-at-decision
 * delivery from the latest historical Ad and parent observations known at the
 * evaluation cutoff. Never borrow mutable detail or a later observation.
 */
export function creativeMemberEffectiveStatusLateralSql(
  dailyAlias: string,
  cutoffParameter: string,
  resultAlias = "creative_member_status",
): string {
  for (const alias of [dailyAlias, resultAlias]) {
    if (!/^[a-z_][a-z_0-9]*$/i.test(alias)) {
      throw new Error("Invalid creative member status SQL alias");
    }
  }
  if (!/^\$[1-9][0-9]*$/.test(cutoffParameter)) {
    throw new Error("Creative member status requires an evaluation cutoff parameter");
  }

  const latestTruth = (entityType: "ad" | "adset" | "campaign", entityId: string) => `
    SELECT event_kind, presence, creative_id, campaign_id, adset_id, effective_status
    FROM (
      SELECT 'state'::text AS event_kind, state.presence,
        state.creative_id, state.campaign_id, state.adset_id,
        state.effective_status, state.observed_at, state.captured_at,
        state.created_at, state.id
      FROM meta_entity_state_history state
      WHERE state.business_ref_id = ${dailyAlias}.business_ref_id
        AND state.business_id = ${dailyAlias}.business_id
        AND state.provider_account_ref_id = ${dailyAlias}.provider_account_ref_id
        AND state.provider_account_id = ${dailyAlias}.provider_account_id
        AND state.entity_type = '${entityType}'
        AND state.entity_id = ${entityId}
        AND state.run_completeness IN ('complete', 'partial', 'point_lookup')
        AND state.observed_at <= ${cutoffParameter}::timestamptz
        AND state.captured_at <= ${cutoffParameter}::timestamptz
        AND state.created_at <= ${cutoffParameter}::timestamptz

      UNION ALL

      SELECT 'tombstone'::text AS event_kind, NULL::text AS presence,
        NULL::text AS creative_id, NULL::text AS campaign_id,
        NULL::text AS adset_id, NULL::text AS effective_status,
        tombstone.observed_at, tombstone.captured_at,
        tombstone.created_at, tombstone.id
      FROM meta_entity_tombstones tombstone
      WHERE tombstone.business_ref_id = ${dailyAlias}.business_ref_id
        AND tombstone.business_id = ${dailyAlias}.business_id
        AND tombstone.provider_account_ref_id = ${dailyAlias}.provider_account_ref_id
        AND tombstone.provider_account_id = ${dailyAlias}.provider_account_id
        AND tombstone.entity_type = '${entityType}'
        AND tombstone.entity_id = ${entityId}
        AND tombstone.reason IN ('explicit_deleted', 'explicit_not_found')
        AND tombstone.observed_at <= ${cutoffParameter}::timestamptz
        AND tombstone.captured_at <= ${cutoffParameter}::timestamptz
        AND tombstone.created_at <= ${cutoffParameter}::timestamptz
    ) truth
    ORDER BY observed_at DESC, captured_at DESC,
      (event_kind = 'tombstone') DESC, created_at DESC, id DESC
    LIMIT 1`;

  const normalizedStatus = (alias: string) => `
    CASE UPPER(BTRIM(${alias}.effective_status))
      WHEN 'CAMPAIGN_PAUSED' THEN 'PAUSED'
      WHEN 'ADSET_PAUSED' THEN 'PAUSED'
      ELSE UPPER(BTRIM(${alias}.effective_status))
    END`;
  const adStatus = normalizedStatus("ad_state");
  const adsetStatus = normalizedStatus("adset_state");
  const campaignStatus = normalizedStatus("campaign_state");

  return `LEFT JOIN LATERAL (
    SELECT CASE
      WHEN COUNT(*) > 0
        AND ${cutoffParameter}::timestamptz <= now()
        AND COUNT(DISTINCT NULLIF(BTRIM(member.ad_id), '')) = COUNT(*)
        AND COALESCE(BOOL_AND(member_status.status IS NOT NULL), FALSE)
      THEN CASE
        WHEN BOOL_OR(member_status.status = 'ACTIVE')
          AND BOOL_AND(member_status.status IN ('ACTIVE', 'PAUSED')) THEN 'ACTIVE'
        WHEN BOOL_AND(member_status.status = 'PAUSED') THEN 'PAUSED'
        WHEN BOOL_AND(member_status.status = 'REJECTED') THEN 'REJECTED'
        WHEN BOOL_AND(member_status.status = 'DELETED') THEN 'DELETED'
      END
    END AS effective_status
    FROM jsonb_array_elements_text(CASE
      WHEN jsonb_typeof(${dailyAlias}.payload_json->'source_ad_ids') = 'array'
      THEN ${dailyAlias}.payload_json->'source_ad_ids'
      ELSE '[]'::jsonb
    END) member(ad_id)
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN COALESCE(
          ad_state.event_kind = 'state' AND ad_state.presence = 'present'
          AND ad_state.creative_id = ${dailyAlias}.creative_id
          AND ad_state.campaign_id = ${dailyAlias}.campaign_id
          AND ad_state.adset_id = ${dailyAlias}.adset_id
          AND adset_state.event_kind = 'state' AND adset_state.presence = 'present'
          AND adset_state.campaign_id = ${dailyAlias}.campaign_id
          AND campaign_state.event_kind = 'state'
          AND campaign_state.presence = 'present', FALSE)
        THEN CASE
          WHEN 'REJECTED' IN (${adStatus}, ${adsetStatus}, ${campaignStatus})
            THEN 'REJECTED'
          WHEN 'DELETED' IN (${adStatus}, ${adsetStatus}, ${campaignStatus})
            THEN 'DELETED'
          WHEN 'PAUSED' IN (${adStatus}, ${adsetStatus}, ${campaignStatus})
            THEN 'PAUSED'
          WHEN ${adStatus} = 'ACTIVE' AND ${adsetStatus} = 'ACTIVE'
            AND ${campaignStatus} = 'ACTIVE' THEN 'ACTIVE'
        END
      END AS status
      FROM (SELECT 1) anchor
      LEFT JOIN LATERAL (${latestTruth("ad", "member.ad_id")}) ad_state ON TRUE
      LEFT JOIN LATERAL (${latestTruth("adset", `${dailyAlias}.adset_id`)}) adset_state ON TRUE
      LEFT JOIN LATERAL (${latestTruth("campaign", `${dailyAlias}.campaign_id`)}) campaign_state ON TRUE
    ) member_status ON TRUE
  ) ${resultAlias} ON TRUE`;
}
