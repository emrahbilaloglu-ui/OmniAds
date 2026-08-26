/**
 * Recent Launchpad ad actions, as a function rather than only as a route.
 *
 * `/api/launchpad/meta/recent-ad-actions` was the only way to read this, so the
 * Launchpad first load spent a request on it beside six others answering the
 * same question — "what does this account's Launchpad look like right now" —
 * with the same authorization and the same scope. Composing them required the
 * query to be callable, so it is.
 *
 * The route still exists and still calls this. Nothing about the SQL, the
 * bounds or the shape changed in the move: the composed read and the standalone
 * route return the same rows for the same account, because they run the same
 * code.
 */
import { getDb } from "@/lib/db";

type RecentAdActionDbRow = {
  action: "launch_ad" | "duplicate";
  requested_at: string;
  ad_id: string;
  creative_id: string | null;
  resulting_ad_id: string;
  payload_request: Record<string, unknown> | null;
  ad_name_current: string | null;
  ad_name_historical: string | null;
  ad_status: string | null;
  dim_creative_id: string | null;
  source_ad_name_current: string | null;
  source_ad_name_historical: string | null;
  source_dim_creative_id: string | null;
  provider_account_id: string | null;
  campaign_id: string | null;
  campaign_name_current: string | null;
  campaign_name_historical: string | null;
  adset_id: string | null;
  adset_name_current: string | null;
  adset_name_historical: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The bounds, applied identically wherever this is called.
 *
 * `sinceDays` is clamped to 1..30 and `limit` to 1..500 — an unbounded window
 * over an action log is a query that gets slower every day it runs.
 */
export function clampRecentAdActionBounds(input: {
  sinceDays?: number | string | null;
  limit?: number | string | null;
}): { sinceDays: number; limit: number } {
  return {
    sinceDays: Math.max(1, Math.min(Number(input.sinceDays ?? 14) || 14, 30)),
    limit: Math.max(1, Math.min(Number(input.limit ?? 300) || 300, 500)),
  };
}

export async function readRecentLaunchpadAdActions(input: {
  businessId: string;
  providerAccountId: string;
  sinceDays?: number;
  limit?: number;
}) {
  const { sinceDays, limit } = clampRecentAdActionBounds(input);
  // Named to match the query below, which was moved here verbatim.
  const access = { businessId: input.businessId };
  const account = { providerAccountId: input.providerAccountId };
  const sql = getDb();
  const rows = (await sql`
    SELECT
      log.action,
      log.requested_at,
      log.ad_id,
      log.creative_id,
      log.resulting_ad_id,
      log.payload_request,
      ad.ad_name_current,
      ad.ad_name_historical,
      ad.ad_status,
      ad.creative_id AS dim_creative_id,
      source_ad.ad_name_current AS source_ad_name_current,
      source_ad.ad_name_historical AS source_ad_name_historical,
      source_ad.creative_id AS source_dim_creative_id,
      COALESCE(
        ad.provider_account_id,
        source_ad.provider_account_id,
        launch_intent.provider_account_id
      ) AS provider_account_id,
      campaign.campaign_id,
      campaign.campaign_name_current,
      campaign.campaign_name_historical,
      adset.adset_id,
      adset.adset_name_current,
      adset.adset_name_historical
    FROM meta_ads_action_log log
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_ad_dimensions
      WHERE business_id = ${access.businessId}
        AND ad_id = log.resulting_ad_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) ad ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_ad_dimensions
      WHERE business_id = ${access.businessId}
        AND ad_id = log.ad_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) source_ad ON TRUE
    LEFT JOIN meta_launch_intents launch_intent
      ON launch_intent.business_id = log.business_id
      AND launch_intent.id::text = COALESCE(
        log.launch_intent_id::text,
        log.payload_request->>'launch_intent_id'
      )
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_campaign_dimensions
      WHERE business_id = ${access.businessId}
        AND provider_account_id = ad.provider_account_id
        AND campaign_id = ad.campaign_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) campaign ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_adset_dimensions
      WHERE business_id = ${access.businessId}
        AND provider_account_id = ad.provider_account_id
        AND adset_id = ad.adset_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) adset ON TRUE
    WHERE log.business_id = ${access.businessId}
      AND log.action IN ('launch_ad', 'duplicate')
      AND log.status IN ('success', 'silent_failure')
      AND log.resulting_ad_id IS NOT NULL
      AND COALESCE(
        ad.provider_account_id,
        source_ad.provider_account_id,
        launch_intent.provider_account_id
      ) = ${account.providerAccountId}
      AND log.requested_at > NOW() - (${sinceDays}::int * interval '1 day')
    ORDER BY log.requested_at DESC
    LIMIT ${limit}
  `) as RecentAdActionDbRow[];

  return rows.map((row) => {
        const requestPayload = isRecord(row.payload_request) ? row.payload_request : {};
        const requestBody = isRecord(requestPayload.body) ? requestPayload.body : {};
        return {
          action: row.action,
          requestedAt: row.requested_at,
          sourceAdId: row.ad_id,
          resultingAdId: row.resulting_ad_id,
          creativeId:
            row.dim_creative_id ??
            row.source_dim_creative_id ??
            row.creative_id ??
            readString(requestBody, "source_creative_id") ??
            null,
          sourceName:
            row.source_ad_name_current ??
            row.source_ad_name_historical ??
            readString(requestPayload, "source_name") ??
            readString(requestBody, "source_name") ??
            null,
          adName:
            row.ad_name_current ??
            row.ad_name_historical ??
            readString(requestBody, "name") ??
            null,
          status:
            row.ad_status ??
            readString(requestPayload, "status_option") ??
            readString(requestBody, "status_option") ??
            null,
          accountId: row.provider_account_id,
          targetCampaignId:
            row.campaign_id ??
            readString(requestPayload, "target_campaign_id") ??
            null,
          targetCampaignName:
            row.campaign_name_current ??
            row.campaign_name_historical ??
            readString(requestPayload, "target_campaign_name") ??
            null,
          targetAdsetId:
            row.adset_id ??
            readString(requestPayload, "target_adset_id") ??
            readString(requestBody, "target_adset_id") ??
            readString(requestBody, "adset_id") ??
            null,
          targetAdsetName:
            row.adset_name_current ??
            row.adset_name_historical ??
            readString(requestPayload, "target_adset_name") ??
            null,
        };
      });
}

export type RecentLaunchpadAdAction = Awaited<
  ReturnType<typeof readRecentLaunchpadAdActions>
>[number];
