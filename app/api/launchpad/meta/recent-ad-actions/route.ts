import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireLaunchpadBusinessAccess } from "../route-utils";

export const dynamic = "force-dynamic";

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

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const sinceDays = Math.max(
    1,
    Math.min(Number(request.nextUrl.searchParams.get("sinceDays") ?? 14) || 14, 30),
  );
  const limit = Math.max(
    1,
    Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 300) || 300, 500),
  );

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
      ad.provider_account_id,
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
      AND log.requested_at > NOW() - (${sinceDays}::int * interval '1 day')
    ORDER BY log.requested_at DESC
    LIMIT ${limit}
  `) as RecentAdActionDbRow[];

  return NextResponse.json(
    {
      actions: rows.map((row) => {
        const requestPayload = isRecord(row.payload_request) ? row.payload_request : {};
        const requestBody = isRecord(requestPayload.body) ? requestPayload.body : {};
        return {
          action: row.action,
          requestedAt: row.requested_at,
          sourceAdId: row.ad_id,
          resultingAdId: row.resulting_ad_id,
          creativeId:
            row.dim_creative_id ??
            row.creative_id ??
            readString(requestBody, "source_creative_id") ??
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
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
