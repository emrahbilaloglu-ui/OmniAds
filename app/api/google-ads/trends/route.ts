import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import {
  getDemoGoogleAdsCampaigns,
  getDemoSparklines,
} from "@/lib/demo-business";
import { getGoogleAdsCampaignsReport } from "@/lib/google-ads/serving";
import { parseGoogleAdsRequestParams } from "@/lib/google-ads-request-params";
import {
  googleAdsReadAccountAuthorityFailure,
  resolveGoogleAdsReadAccountAuthority,
} from "@/lib/google-ads/account-authority";
import {
  isGoogleAdsReadComplete,
  type GoogleAdsReadCompletenessMeta,
} from "@/lib/google-ads/read-completeness";

interface GoogleAdsTrendCampaignRow {
  id: string;
  name: string;
  status: string;
  channel: string;
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  impressionShare: number | null;
  lostIsBudget: number | null;
}

interface GoogleAdsTrendPoint {
  date: string;
  rows: GoogleAdsTrendCampaignRow[];
  complete: boolean;
}

function enumerateDates(startDate: string, endDate: string) {
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function buildDemoTrendRows(): GoogleAdsTrendPoint[] {
  const campaigns = getDemoGoogleAdsCampaigns().rows;
  const googleTrend = getDemoSparklines().providerTrends.google ?? [];
  return googleTrend.map((point) => ({
    date: point.date,
    complete: true,
    rows: campaigns.map((campaign) => {
      const spendShare = Number(campaign.spendShare ?? 0) / 100;
      const revenueShare = Number(campaign.revenueShare ?? 0) / 100;
      const spend = Number((point.spend * spendShare).toFixed(4));
      const revenue = Number((point.revenue * revenueShare).toFixed(4));
      const conversions = campaign.cpa > 0 ? Number((spend / campaign.cpa).toFixed(4)) : 0;
      const clicks = campaign.cpc > 0 ? Number((spend / campaign.cpc).toFixed(4)) : 0;
      const impressions = campaign.ctr > 0 ? Number((clicks / (campaign.ctr / 100)).toFixed(4)) : 0;
      return {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        channel: campaign.channel,
        spend,
        revenue,
        conversions,
        impressions,
        clicks,
        impressionShare: campaign.impressionShare,
        lostIsBudget: campaign.lostIsBudget,
      };
    }),
  }));
}

export async function GET(request: NextRequest) {
  const {
    businessId,
    accountId,
    dateRange,
    customStart,
    customEnd,
    debug,
  } = parseGoogleAdsRequestParams(request.nextUrl.searchParams);

  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  if (await isDemoBusiness(businessId)) {
    return NextResponse.json({
      rows: buildDemoTrendRows(),
      meta: { dateRange, customStart, customEnd, complete: true, incompleteDates: [] },
    });
  }

  if (accountId && accountId !== "all") {
    const refusal = googleAdsReadAccountAuthorityFailure(
      await resolveGoogleAdsReadAccountAuthority(businessId, accountId),
    );
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, code: refusal.code },
        { status: refusal.httpStatus },
      );
    }
  }

  if (!customStart || !customEnd) {
    return NextResponse.json({ error: "customStart and customEnd are required" }, { status: 400 });
  }

  const dates = enumerateDates(customStart, customEnd);
  const rows: GoogleAdsTrendPoint[] = await Promise.all(
    dates.map(async (date) => {
      const report = await getGoogleAdsCampaignsReport({
        businessId,
        accountId,
        dateRange: "custom",
        customStart: date,
        customEnd: date,
        compareMode: "none",
        compareStart: null,
        compareEnd: null,
        debug,
        source: "google_ads_daily_trends_route",
      });
      const complete = isGoogleAdsReadComplete(
        report.meta as GoogleAdsReadCompletenessMeta,
      );

      return {
        date,
        complete,
        rows: complete ? report.rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          status: String(row.status ?? "paused"),
          channel: String(row.channel ?? "Unknown"),
          spend: Number(row.spend ?? 0),
          revenue: Number(row.revenue ?? 0),
          conversions: Number(row.conversions ?? 0),
          impressions: Number(row.impressions ?? 0),
          clicks: Number(row.clicks ?? 0),
          impressionShare:
            typeof row.impressionShare === "number" ? row.impressionShare : null,
          lostIsBudget:
            typeof row.lostIsBudget === "number" ? row.lostIsBudget : null,
        })) : [],
      };
    })
  );

  const incompleteDates = rows
    .filter((point) => !point.complete)
    .map((point) => point.date);
  const payload = {
    rows,
    meta: {
      dateRange,
      customStart,
      customEnd,
      complete: incompleteDates.length === 0,
      incompleteDates,
    },
  };
  return NextResponse.json(payload);
}
