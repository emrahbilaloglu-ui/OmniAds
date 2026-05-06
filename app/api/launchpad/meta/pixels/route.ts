import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const sql = getDb();
  const rows = (await sql`
    WITH active_ad_pixels AS (
      SELECT
        ad.business_id,
        ad.provider_account_id,
        ad.ad_id,
        ad.updated_at,
        COALESCE(
          ad.projection_json->'adset'->'promoted_object'->>'pixel_id',
          ad.projection_json->'promoted_object'->>'pixel_id'
        ) AS pixel_id,
        COALESCE(
          ad.projection_json->'adset'->'promoted_object'->>'pixel_name',
          ad.projection_json->'adset'->'promoted_object'->>'name',
          ad.projection_json->'promoted_object'->>'pixel_name',
          ad.projection_json->'promoted_object'->>'name'
        ) AS pixel_name
      FROM meta_ad_dimensions ad
      WHERE ad.business_id = ${access.membership.businessId}
        AND UPPER(COALESCE(ad.ad_status, '')) = 'ACTIVE'
    ),
    spend_28d AS (
      SELECT
        active.pixel_id,
        SUM(daily.spend)::double precision AS last_spend_28d
      FROM active_ad_pixels active
      LEFT JOIN meta_ad_daily daily
        ON daily.business_id = active.business_id
        AND daily.provider_account_id = active.provider_account_id
        AND daily.ad_id = active.ad_id
        AND daily.date >= CURRENT_DATE - INTERVAL '27 days'
      WHERE active.pixel_id IS NOT NULL AND active.pixel_id <> ''
      GROUP BY active.pixel_id
    )
    SELECT
      active.pixel_id AS id,
      MAX(active.pixel_name) AS name,
      COALESCE(MAX(spend_28d.last_spend_28d), 0)::double precision AS last_spend_28d,
      MAX(active.updated_at) AS last_updated_at
    FROM active_ad_pixels active
    LEFT JOIN spend_28d ON spend_28d.pixel_id = active.pixel_id
    WHERE active.pixel_id IS NOT NULL AND active.pixel_id <> ''
    GROUP BY active.pixel_id
    ORDER BY COALESCE(MAX(spend_28d.last_spend_28d), 0) DESC, MAX(active.updated_at) DESC
  `) as Array<{
    id: string;
    name: string | null;
    last_spend_28d: number | string | null;
    last_updated_at: string | null;
  }>;

  return NextResponse.json(
    {
      pixels: rows.map((row, index) => ({
        id: row.id,
        name: row.name,
        lastSpend28d: Number(row.last_spend_28d ?? 0),
        lastUpdatedAt: row.last_updated_at,
        isMostUsed: index === 0,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
