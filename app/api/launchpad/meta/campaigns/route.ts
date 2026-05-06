import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

function toMinorUnits(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const objective = searchParams.get("objective")?.trim() || "OUTCOME_SALES";
  const status = (searchParams.get("status")?.trim() || "ACTIVE").toUpperCase();

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  const objectiveFilter = objective.toUpperCase() === "ALL" ? null : objective;
  const sql = getDb();
  const rows = (await sql`
    WITH latest_campaign_config AS (
      SELECT DISTINCT ON (business_id, provider_account_id, campaign_id)
        business_id,
        provider_account_id,
        campaign_id,
        objective,
        daily_budget,
        lifetime_budget
      FROM meta_campaign_config_history
      WHERE business_id = ${access.membership.businessId}
      ORDER BY business_id, provider_account_id, campaign_id, captured_at DESC
    ),
    adset_counts AS (
      SELECT
        business_id,
        provider_account_id,
        campaign_id,
        COUNT(DISTINCT adset_id)::int AS adset_count
      FROM meta_adset_dimensions
      WHERE business_id = ${access.membership.businessId}
        AND UPPER(COALESCE(adset_status, '')) = 'ACTIVE'
      GROUP BY business_id, provider_account_id, campaign_id
    ),
    spend_28d AS (
      SELECT
        business_id,
        provider_account_id,
        campaign_id,
        SUM(spend)::double precision AS last_spend_28d
      FROM meta_creative_daily
      WHERE business_id = ${access.membership.businessId}
        AND date >= CURRENT_DATE - INTERVAL '27 days'
      GROUP BY business_id, provider_account_id, campaign_id
    )
    SELECT
      campaign.campaign_id AS id,
      COALESCE(campaign.campaign_name_current, campaign.campaign_name_historical, campaign.campaign_id) AS name,
      config.objective,
      campaign.campaign_status AS status,
      campaign.campaign_status AS effective_status,
      config.daily_budget,
      config.lifetime_budget,
      COALESCE(config.daily_budget, config.lifetime_budget) IS NOT NULL AS is_adset_budget_sharing_enabled,
      COALESCE(adset_counts.adset_count, 0)::int AS adset_count,
      COALESCE(spend_28d.last_spend_28d, 0)::double precision AS last_spend_28d
    FROM meta_campaign_dimensions campaign
    LEFT JOIN latest_campaign_config config
      ON config.business_id = campaign.business_id
      AND config.provider_account_id = campaign.provider_account_id
      AND config.campaign_id = campaign.campaign_id
    LEFT JOIN adset_counts
      ON adset_counts.business_id = campaign.business_id
      AND adset_counts.provider_account_id = campaign.provider_account_id
      AND adset_counts.campaign_id = campaign.campaign_id
    LEFT JOIN spend_28d
      ON spend_28d.business_id = campaign.business_id
      AND spend_28d.provider_account_id = campaign.provider_account_id
      AND spend_28d.campaign_id = campaign.campaign_id
    WHERE campaign.business_id = ${access.membership.businessId}
      AND UPPER(COALESCE(campaign.campaign_status, '')) = ${status}
      AND (${objectiveFilter}::text IS NULL OR config.objective = ${objectiveFilter})
    ORDER BY COALESCE(spend_28d.last_spend_28d, 0) DESC, campaign.updated_at DESC
    LIMIT 200
  `) as Array<{
    id: string;
    name: string;
    objective: string | null;
    status: string | null;
    effective_status: string | null;
    daily_budget: number | string | null;
    lifetime_budget: number | string | null;
    is_adset_budget_sharing_enabled: boolean | null;
    adset_count: number | null;
    last_spend_28d: number | string | null;
  }>;

  return NextResponse.json(
    {
      campaigns: rows.map((row) => ({
        id: row.id,
        name: row.name,
        objective: row.objective,
        status: row.status,
        effectiveStatus: row.effective_status,
        dailyBudgetMinor: toMinorUnits(row.daily_budget),
        lifetimeBudgetMinor: toMinorUnits(row.lifetime_budget),
        isAdsetBudgetSharingEnabled: Boolean(row.is_adset_budget_sharing_enabled),
        adsetCount: Number(row.adset_count ?? 0),
        lastSpend28d: Number(row.last_spend_28d ?? 0),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
