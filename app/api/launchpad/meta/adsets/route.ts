import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { normalizeAttributionSpecItems, summarizeAttributionSpec } from "@/lib/launchpad/attribution-presets";

export const dynamic = "force-dynamic";

function toMinorUnits(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

function readTargetingSummary(value: unknown) {
  const targeting = isRecord(value) ? value : {};
  const geo = isRecord(targeting.geo_locations)
    ? targeting.geo_locations
    : isRecord(targeting.geoLocations)
      ? targeting.geoLocations
      : {};
  const automation = isRecord(targeting.targeting_automation)
    ? targeting.targeting_automation
    : isRecord(targeting.targetingAutomation)
      ? targeting.targetingAutomation
      : {};
  const publisherPlatforms = stringArray(targeting.publisher_platforms ?? targeting.publisherPlatforms);
  const facebookPositions = stringArray(targeting.facebook_positions ?? targeting.facebookPositions);
  const instagramPositions = stringArray(targeting.instagram_positions ?? targeting.instagramPositions);
  const placementSummary = publisherPlatforms.length
    ? [...publisherPlatforms, ...facebookPositions, ...instagramPositions].join(", ")
    : "Advantage+ placements";

  return {
    geoCountries: stringArray(geo.countries),
    ageMin: Number(targeting.age_min ?? targeting.ageMin ?? 18),
    ageMax: Number(targeting.age_max ?? targeting.ageMax ?? 65),
    advantageAudience:
      automation.advantage_audience === 1 ||
      automation.advantageAudience === 1 ||
      automation.advantage_audience === true ||
      automation.advantageAudience === true,
    placementSummary,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const campaignId = searchParams.get("campaignId")?.trim() ?? "";
  if (!campaignId) {
    return NextResponse.json(
      { ok: false, error: { code: "missing_campaign_id", message: "campaignId is required." } },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  const sql = getDb();
  const rows = (await sql`
    WITH latest_projection AS (
      SELECT DISTINCT ON (business_id, provider_account_id, adset_id)
        business_id,
        provider_account_id,
        adset_id,
        projection_json
      FROM meta_ad_dimensions
      WHERE business_id = ${access.membership.businessId}
        AND adset_id IS NOT NULL
      ORDER BY business_id, provider_account_id, adset_id, updated_at DESC
    ),
    active_ads AS (
      SELECT
        business_id,
        provider_account_id,
        adset_id,
        COUNT(DISTINCT ad_id)::int AS current_ad_count
      FROM meta_ad_dimensions
      WHERE business_id = ${access.membership.businessId}
        AND UPPER(COALESCE(ad_status, '')) = 'ACTIVE'
      GROUP BY business_id, provider_account_id, adset_id
    ),
    spend_7d AS (
      SELECT
        business_id,
        provider_account_id,
        adset_id,
        SUM(spend)::double precision AS last_7d_spend,
        SUM(revenue)::double precision AS last_7d_revenue
      FROM meta_creative_daily
      WHERE business_id = ${access.membership.businessId}
        AND date >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY business_id, provider_account_id, adset_id
    )
    SELECT
      adset.adset_id AS id,
      COALESCE(adset.adset_name_current, adset.adset_name_historical, adset.adset_id) AS name,
      adset.adset_status AS status,
      adset.adset_status AS effective_status,
      config.optimization_goal,
      'IMPRESSIONS'::text AS billing_event,
      COALESCE(
        projection.projection_json->'adset'->'promoted_object'->>'pixel_id',
        projection.projection_json->'promoted_object'->>'pixel_id'
      ) AS pixel_id,
      COALESCE(
        projection.projection_json->'adset'->'promoted_object'->>'custom_event_type',
        projection.projection_json->'promoted_object'->>'custom_event_type'
      ) AS custom_event_type,
      config.daily_budget,
      config.lifetime_budget,
      COALESCE(
        projection.projection_json->'adset'->'attribution_spec',
        projection.projection_json->'attribution_spec'
      ) AS attribution_spec,
      COALESCE(
        projection.projection_json->'adset'->'targeting',
        projection.projection_json->'targeting'
      ) AS targeting,
      COALESCE(active_ads.current_ad_count, 0)::int AS current_ad_count,
      COALESCE(spend_7d.last_7d_spend, 0)::double precision AS last_7d_spend,
      CASE
        WHEN COALESCE(spend_7d.last_7d_spend, 0) > 0
          THEN COALESCE(spend_7d.last_7d_revenue, 0) / spend_7d.last_7d_spend
        ELSE NULL
      END AS last_7d_roas
    FROM meta_adset_dimensions adset
    LEFT JOIN LATERAL (
      SELECT
        cfg.optimization_goal,
        cfg.bid_strategy_type,
        cfg.bid_value,
        cfg.bid_value_format,
        cfg.daily_budget,
        cfg.lifetime_budget
      FROM meta_adset_config_history cfg
      WHERE cfg.business_id = adset.business_id
        AND cfg.provider_account_id = adset.provider_account_id
        AND cfg.adset_id = adset.adset_id
      ORDER BY cfg.captured_at DESC
      LIMIT 1
    ) config ON TRUE
    LEFT JOIN latest_projection projection
      ON projection.business_id = adset.business_id
      AND projection.provider_account_id = adset.provider_account_id
      AND projection.adset_id = adset.adset_id
    LEFT JOIN active_ads
      ON active_ads.business_id = adset.business_id
      AND active_ads.provider_account_id = adset.provider_account_id
      AND active_ads.adset_id = adset.adset_id
    LEFT JOIN spend_7d
      ON spend_7d.business_id = adset.business_id
      AND spend_7d.provider_account_id = adset.provider_account_id
      AND spend_7d.adset_id = adset.adset_id
    WHERE adset.business_id = ${access.membership.businessId}
      AND adset.campaign_id = ${campaignId}
      AND UPPER(COALESCE(adset.adset_status, '')) = 'ACTIVE'
    ORDER BY COALESCE(spend_7d.last_7d_spend, 0) DESC, adset.updated_at DESC
    LIMIT 300
  `) as Array<{
    id: string;
    name: string;
    status: string | null;
    effective_status: string | null;
    optimization_goal: string | null;
    billing_event: string | null;
    pixel_id: string | null;
    custom_event_type: string | null;
    daily_budget: number | string | null;
    lifetime_budget: number | string | null;
    attribution_spec: unknown;
    targeting: unknown;
    current_ad_count: number | null;
    last_7d_spend: number | string | null;
    last_7d_roas: number | string | null;
  }>;

  return NextResponse.json(
    {
      adsets: rows.map((row) => {
        const attributionSpec = normalizeAttributionSpecItems(row.attribution_spec);
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          effectiveStatus: row.effective_status,
          optimizationGoal: row.optimization_goal,
          billingEvent: row.billing_event,
          pixelId: row.pixel_id,
          customEventType: row.custom_event_type,
          dailyBudgetMinor: toMinorUnits(row.daily_budget),
          lifetimeBudgetMinor: toMinorUnits(row.lifetime_budget),
          attributionSpec,
          attributionSummary: summarizeAttributionSpec(attributionSpec),
          targeting: readTargetingSummary(row.targeting),
          currentAdCount: Number(row.current_ad_count ?? 0),
          last7dSpend: Number(row.last_7d_spend ?? 0),
          last7dRoas:
            row.last_7d_roas == null || !Number.isFinite(Number(row.last_7d_roas))
              ? null
              : Number(row.last_7d_roas),
        };
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
