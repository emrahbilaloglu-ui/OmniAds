import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { jsonError, requireLaunchpadAssignedAccountScope } from "../route-utils";

export const dynamic = "force-dynamic";

function toMinorUnits(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const providerAccountId = searchParams.get("providerAccountId")?.trim() ?? "";
  const objective = searchParams.get("objective")?.trim() || "OUTCOME_SALES";
  const status = (searchParams.get("status")?.trim() || "ACTIVE").toUpperCase();

  // Launchpad always works inside one account, and `meta-validation` refuses a
  // target from any other one at Create time. Answering business-wide when the
  // account is absent would offer campaigns the launch can never use, so the
  // read refuses instead of silently widening.
  if (!providerAccountId) {
    return jsonError(
      400,
      "missing_provider_account_id",
      "providerAccountId is required.",
    );
  }

  // Membership alone is not scope. The `provider_account_id` below is a filter
  // over rows this business has synced at some point, so a stale or foreign id
  // in the URL would still be answered with real campaigns unless the current
  // assignment is proven first. No statement is issued when it is not.
  const scope = await requireLaunchpadAssignedAccountScope({
    request,
    businessId,
    providerAccountId,
    minRole: "collaborator",
  });
  if (!scope.ok) return scope.response;

  const objectiveFilter = objective.toUpperCase() === "ALL" ? null : objective;
  const sql = getDb();
  const rows = (await sql`
    WITH adset_counts AS (
      SELECT
        business_id,
        provider_account_id,
        campaign_id,
        COUNT(DISTINCT adset_id)::int AS adset_count
      FROM meta_adset_dimensions
      WHERE business_id = ${scope.businessId}
        AND provider_account_id = ${scope.providerAccountId}
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
      WHERE business_id = ${scope.businessId}
        AND provider_account_id = ${scope.providerAccountId}
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
    LEFT JOIN LATERAL (
      SELECT
        cfg.objective,
        cfg.daily_budget,
        cfg.lifetime_budget
      FROM meta_campaign_config_history cfg
      WHERE cfg.business_id = campaign.business_id
        AND cfg.provider_account_id = campaign.provider_account_id
        AND cfg.campaign_id = campaign.campaign_id
      ORDER BY cfg.captured_at DESC
      LIMIT 1
    ) config ON TRUE
    LEFT JOIN adset_counts
      ON adset_counts.business_id = campaign.business_id
      AND adset_counts.provider_account_id = campaign.provider_account_id
      AND adset_counts.campaign_id = campaign.campaign_id
    LEFT JOIN spend_28d
      ON spend_28d.business_id = campaign.business_id
      AND spend_28d.provider_account_id = campaign.provider_account_id
      AND spend_28d.campaign_id = campaign.campaign_id
    WHERE campaign.business_id = ${scope.businessId}
      AND campaign.provider_account_id = ${scope.providerAccountId}
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
