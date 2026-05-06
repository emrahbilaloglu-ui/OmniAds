import { getDb } from "@/lib/db";

export interface MixedObjectiveFixture {
  businessId: string;
  userId: string;
  userEmail: string;
}

export const MIXED_OBJECTIVE_SALES_CREATIVE_IDS = [
  "mixed_sales_1",
  "mixed_sales_2",
  "mixed_sales_3",
  "mixed_sales_4",
  "mixed_sales_5",
] as const;

export const MIXED_OBJECTIVE_ENGAGEMENT_CREATIVE_IDS = [
  "mixed_engagement_1",
  "mixed_engagement_2",
  "mixed_engagement_3",
] as const;

interface FixtureCreativeRow {
  creative_id: string;
  objective: "OUTCOME_SALES" | "OUTCOME_ENGAGEMENT";
  creative_format: "image" | "video";
  spend: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  conversions: number;
  revenue: number;
}

export async function cleanupMixedObjectiveFixture(
  fixture: MixedObjectiveFixture,
) {
  const db = getDb();
  await db.query(
    `
    DELETE FROM meta_creative_daily
    WHERE business_ref_id = $1::uuid
       OR business_id = $1::text
    `,
    [fixture.businessId],
  );
  await db.query(
    `
    DELETE FROM business_target_packs
    WHERE business_id = $1::uuid
    `,
    [fixture.businessId],
  );
  await db.query(
    `
    DELETE FROM businesses
    WHERE id = $1::uuid
    `,
    [fixture.businessId],
  );
  await db.query(
    `
    DELETE FROM users
    WHERE id = $1::uuid
       OR email = $2
    `,
    [fixture.userId, fixture.userEmail],
  );
}

export async function setupMixedObjectiveFixture(
  fixture: MixedObjectiveFixture,
  asOf: string,
) {
  await cleanupMixedObjectiveFixture(fixture);
  const db = getDb();

  await db.query(
    `
    INSERT INTO users (id, name, email, password_hash)
    VALUES ($1::uuid, $2, $3, $4)
    `,
    [
      fixture.userId,
      "Engine V3 Mixed Objective Test",
      fixture.userEmail,
      "test-password-hash",
    ],
  );

  await db.query(
    `
    INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
    VALUES ($1::uuid, $2, $3::uuid, 'UTC', 'USD', true)
    `,
    [
      fixture.businessId,
      "Engine V3 Mixed Objective Fixture",
      fixture.userId,
    ],
  );

  await db.query(
    `
    INSERT INTO business_target_packs (business_id, target_roas, break_even_roas)
    VALUES ($1::uuid, 2.0, 1.5)
    `,
    [fixture.businessId],
  );

  const rows: FixtureCreativeRow[] = [
    ...MIXED_OBJECTIVE_SALES_CREATIVE_IDS.map((creativeId, index) => ({
      creative_id: creativeId,
      objective: "OUTCOME_SALES" as const,
      creative_format: index % 2 === 0 ? ("image" as const) : ("video" as const),
      spend: 100 + index * 10,
      impressions: 10_000,
      clicks: (index + 1) * 100,
      link_clicks: (index + 1) * 90,
      conversions: 1,
      revenue: 300 + index * 10,
    })),
    ...MIXED_OBJECTIVE_ENGAGEMENT_CREATIVE_IDS.map((creativeId, index) => ({
      creative_id: creativeId,
      objective: "OUTCOME_ENGAGEMENT" as const,
      creative_format: "video" as const,
      spend: 80 + index * 10,
      impressions: 10_000,
      clicks: (index + 7) * 1_000,
      link_clicks: (index + 7) * 900,
      conversions: 1,
      revenue: 10 + index,
    })),
  ];

  await db.query(
    `
    INSERT INTO meta_creative_daily (
      business_id,
      business_ref_id,
      provider_account_id,
      date,
      campaign_id,
      adset_id,
      ad_id,
      creative_id,
      creative_name,
      account_timezone,
      account_currency,
      spend,
      impressions,
      clicks,
      link_clicks,
      outbound_clicks,
      conversions,
      revenue,
      roas,
      objective,
      effective_status,
      creative_visual_format,
      payload_json
    )
    SELECT
      $1,
      $1::uuid,
      $2,
      $3::date,
      'mixed_objective_campaign',
      'mixed_objective_adset',
      'ad_' || row.creative_id,
      row.creative_id,
      row.creative_id,
      'UTC',
      'USD',
      row.spend,
      row.impressions,
      row.clicks,
      row.link_clicks,
      row.link_clicks,
      row.conversions,
      row.revenue,
      CASE WHEN row.spend > 0 THEN row.revenue / row.spend ELSE 0 END,
      row.objective,
      'ACTIVE',
      row.creative_format,
      jsonb_build_object(
        'creative_format', row.creative_format,
        'landing_page_views', row.link_clicks * 0.8,
        'add_to_cart', row.link_clicks * 0.2,
        'initiate_checkout', row.link_clicks * 0.1,
        'thumbstop', 0.3
      )
    FROM jsonb_to_recordset($4::jsonb) AS row(
      creative_id text,
      objective text,
      creative_format text,
      spend double precision,
      impressions bigint,
      clicks bigint,
      link_clicks bigint,
      conversions double precision,
      revenue double precision
    )
    `,
    [
      fixture.businessId,
      `mixed-objective-${fixture.businessId.slice(-12)}`,
      asOf,
      JSON.stringify(rows),
    ],
  );
}
