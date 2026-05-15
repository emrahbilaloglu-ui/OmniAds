import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import { ENGINE_VERSION } from "../../types";
import {
  hashAdvisoryLock,
  JOB_NAME,
  runCalibrationJob,
} from "../../jobs/calibration-job";
import {
  cleanupMixedObjectiveFixture,
  MIXED_OBJECTIVE_ENGAGEMENT_CREATIVE_IDS,
  MIXED_OBJECTIVE_SALES_CREATIVE_IDS,
  setupMixedObjectiveFixture,
  type MixedObjectiveFixture,
} from "./mixed-objective-fixture";

const AS_OF = "2026-05-04";
const MIXED_OBJECTIVE_FIXTURE: MixedObjectiveFixture = {
  businessId: "00000000-0000-4000-8000-000000000391",
  userId: "00000000-0000-4000-8000-000000000392",
  userEmail: "engine-v3-mixed-calibration@example.test",
};
const CAMPAIGN_SCOPE_FIXTURES = [
  {
    businessId: "00000000-0000-4000-8000-000000000393",
    userId: "00000000-0000-4000-8000-000000000394",
    userEmail: "engine-v3-campaign-scope-a@example.test",
  },
  {
    businessId: "00000000-0000-4000-8000-000000000395",
    userId: "00000000-0000-4000-8000-000000000396",
    userEmail: "engine-v3-campaign-scope-b@example.test",
  },
] as const;
const TEST_BUSINESS_IDS = [
  "00000000-0000-4000-8000-000000000321",
  "00000000-0000-4000-8000-000000000322",
  "00000000-0000-4000-8000-000000000323",
  MIXED_OBJECTIVE_FIXTURE.businessId,
  ...CAMPAIGN_SCOPE_FIXTURES.map((fixture) => fixture.businessId),
];

type CountRow = Record<string, unknown> & {
  count: unknown;
};

type JobRunRow = Record<string, unknown> & {
  status: unknown;
  row_count: unknown;
};

type CalibrationRow = Record<string, unknown> & {
  scope_type: unknown;
  scope_id: unknown;
  campaign_kind: unknown;
  creative_format: unknown;
  eligible_creative_count: unknown;
  mature_creative_count: unknown;
  roas_p75: unknown;
  roas_p60: unknown;
  quality_status: unknown;
  ctr_p50: unknown;
  funnel_sample_count: unknown;
  funnel_quality_status: unknown;
};

interface CampaignScopeFixture {
  businessId: string;
  userId: string;
  userEmail: string;
}

function toNumber(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

async function cleanupEngineRows() {
  const db = getDb();
  await db.query(
    `
    DELETE FROM engine_v3_account_calibration_daily
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION],
  );
  await db.query(
    `
    DELETE FROM engine_v3_job_runs
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
      AND job_name = $3
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION, JOB_NAME],
  );
}

async function cleanupCampaignScopeFixture(fixture: CampaignScopeFixture) {
  const db = getDb();
  await db.query(
    `
    DELETE FROM meta_campaign_labels
    WHERE business_id = $1
    `,
    [fixture.businessId],
  );
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

async function insertCampaignLabels(
  fixture: CampaignScopeFixture,
  labels: Record<string, "main" | "test" | "mixed">,
) {
  const rows = Object.entries(labels).map(([campaignId, campaignKind]) => ({
    campaign_id: campaignId,
    campaign_kind: campaignKind,
  }));
  await getDb().query(
    `
    INSERT INTO meta_campaign_labels (
      business_id,
      campaign_id,
      campaign_kind,
      source,
      labeled_by
    )
    SELECT
      $1,
      row.campaign_id,
      row.campaign_kind,
      'user',
      'calibration-job-test'
    FROM jsonb_to_recordset($2::jsonb) AS row(
      campaign_id text,
      campaign_kind text
    )
    `,
    [fixture.businessId, JSON.stringify(rows)],
  );
}

async function setupCampaignScopeFixture(
  fixture: CampaignScopeFixture,
  asOf: string,
  campaignCounts: Record<string, number>,
) {
  await cleanupCampaignScopeFixture(fixture);
  const db = getDb();

  await db.query(
    `
    INSERT INTO users (id, name, email, password_hash)
    VALUES ($1::uuid, $2, $3, $4)
    `,
    [
      fixture.userId,
      "Engine V3 Campaign Scope Test",
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
      "Engine V3 Campaign Scope Fixture",
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

  const rows = Object.entries(campaignCounts).flatMap(([campaignId, count]) =>
    Array.from({ length: count }, (_, index) => ({
      campaign_id: campaignId,
      creative_id: `${campaignId}_creative_${index + 1}`,
      creative_format: index % 2 === 0 ? "image" : "video",
      spend: 100 + index * 10,
      impressions: 10_000,
      clicks: 100 + index * 5,
      link_clicks: 90 + index * 5,
      conversions: 1,
      revenue: 220 + index * 10,
    })),
  );

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
      row.campaign_id,
      row.campaign_id || '_adset',
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
      'OUTCOME_SALES',
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
      campaign_id text,
      creative_id text,
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
      `campaign-scope-${fixture.businessId.slice(-12)}`,
      asOf,
      JSON.stringify(rows),
    ],
  );
}

describe.skipIf(!process.env.DATABASE_URL)("calibration job", () => {
  beforeEach(async () => {
    await cleanupEngineRows();
    await cleanupMixedObjectiveFixture(MIXED_OBJECTIVE_FIXTURE);
    await Promise.all(
      CAMPAIGN_SCOPE_FIXTURES.map((fixture) =>
        cleanupCampaignScopeFixture(fixture),
      ),
    );
  });

  afterEach(async () => {
    await cleanupEngineRows();
    await cleanupMixedObjectiveFixture(MIXED_OBJECTIVE_FIXTURE);
    await Promise.all(
      CAMPAIGN_SCOPE_FIXTURES.map((fixture) =>
        cleanupCampaignScopeFixture(fixture),
      ),
    );
  });

  afterAll(() => {
    resetDbClientCache();
  });

  it("inserts calibration and marks the job run success", async () => {
    const businessId = TEST_BUSINESS_IDS[0]!;
    const result = await runCalibrationJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.jobRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.rowsWritten).toBe(20);
    expect(result.calibration?.businessId).toBe(businessId);
    expect(result.calibration?.campaignKind).toBe("all");

    const rows = await getDb().query<CalibrationRow>(
      `
      SELECT creative_format, mature_creative_count, quality_status, funnel_sample_count, funnel_quality_status
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND campaign_kind = 'all'
      ORDER BY creative_format
      `,
      [businessId, AS_OF, ENGINE_VERSION],
    );
    expect(rows.map((row) => row.creative_format).sort()).toEqual([
      "catalog",
      "carousel",
      "image",
      "overall",
      "video",
    ]);
    const overall = rows.find((row) => row.creative_format === "overall");
    expect(toNumber(overall?.mature_creative_count)).toBe(0);
    expect(overall?.quality_status).toBe("low_sample");
    expect(toNumber(overall?.funnel_sample_count)).toBeGreaterThanOrEqual(0);
    expect(["ready", "low_sample", "insufficient"]).toContain(
      overall?.funnel_quality_status,
    );

    const [jobRun] = await getDb().query<JobRunRow>(
      `
      SELECT status, row_count
      FROM engine_v3_job_runs
      WHERE id = $1::uuid
      `,
      [result.jobRunId],
    );
    expect(jobRun?.status).toBe("success");
    expect(toNumber(jobRun?.row_count)).toBe(20);
  });

  it("is idempotent for calibration rows while recording each invocation", async () => {
    const businessId = TEST_BUSINESS_IDS[1]!;

    await runCalibrationJob({ businessId, asOf: AS_OF });
    await runCalibrationJob({ businessId, asOf: AS_OF });

    const [calibrationCount] = await getDb().query<CountRow>(
      `
      SELECT COUNT(*) AS count
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
      `,
      [businessId, AS_OF, ENGINE_VERSION],
    );
    expect(toNumber(calibrationCount?.count)).toBe(20);

    const [jobRunCount] = await getDb().query<CountRow>(
      `
      SELECT COUNT(*) AS count
      FROM engine_v3_job_runs
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND job_name = $4
      `,
      [businessId, AS_OF, ENGINE_VERSION, JOB_NAME],
    );
    expect(toNumber(jobRunCount?.count)).toBe(2);
  });

  it("writes per-campaign calibration rows only when campaign mature count meets the threshold", async () => {
    const fixture = CAMPAIGN_SCOPE_FIXTURES[0]!;
    await setupCampaignScopeFixture(fixture, AS_OF, {
      campaign_large: 8,
      campaign_small: 7,
    });

    const result = await runCalibrationJob({
      businessId: fixture.businessId,
      asOf: AS_OF,
    });

    expect(result.status).toBe("success");
    expect(result.rowsWritten).toBe(25);

    const campaignRows = await getDb().query<CalibrationRow>(
      `
      SELECT scope_type, scope_id, campaign_kind, creative_format, mature_creative_count
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND scope_type = 'campaign'
      ORDER BY scope_id, creative_format
      `,
      [fixture.businessId, AS_OF, ENGINE_VERSION],
    );

    expect(new Set(campaignRows.map((row) => row.scope_id))).toEqual(
      new Set(["campaign_large"]),
    );
    expect(campaignRows).toHaveLength(5);
    expect(new Set(campaignRows.map((row) => row.campaign_kind))).toEqual(
      new Set(["all"]),
    );
    const overall = campaignRows.find(
      (row) => row.creative_format === "overall",
    );
    expect(toNumber(overall?.mature_creative_count)).toBe(8);
  });

  it("writes account calibration rows segmented by campaign kind without segmenting campaign-scope rows", async () => {
    const fixture = CAMPAIGN_SCOPE_FIXTURES[0]!;
    await setupCampaignScopeFixture(fixture, AS_OF, {
      campaign_main: 30,
      campaign_test: 12,
      campaign_unlabeled: 8,
    });
    await insertCampaignLabels(fixture, {
      campaign_main: "main",
      campaign_test: "test",
    });

    const result = await runCalibrationJob({
      businessId: fixture.businessId,
      asOf: AS_OF,
    });

    expect(result.status).toBe("success");
    expect(result.rowsWritten).toBe(35);

    const accountRows = await getDb().query<CalibrationRow>(
      `
      SELECT campaign_kind, mature_creative_count, roas_p75, roas_p60, quality_status
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND scope_type = 'account'
        AND scope_id = '*'
        AND creative_format = 'overall'
      ORDER BY campaign_kind
      `,
      [fixture.businessId, AS_OF, ENGINE_VERSION],
    );

    const byKind = new Map(
      accountRows.map((row) => [String(row.campaign_kind), row]),
    );
    expect(accountRows).toHaveLength(4);
    expect(toNumber(byKind.get("all")?.mature_creative_count)).toBe(50);
    expect(toNumber(byKind.get("main")?.mature_creative_count)).toBe(30);
    expect(toNumber(byKind.get("test")?.mature_creative_count)).toBe(12);
    expect(toNumber(byKind.get("mixed")?.mature_creative_count)).toBe(0);
    expect(byKind.get("all")?.quality_status).toBe("ready");
    expect(byKind.get("main")?.quality_status).toBe("ready");
    expect(byKind.get("test")?.quality_status).toBe("low_sample");
    expect(byKind.get("mixed")?.quality_status).toBe("low_sample");
    expect(byKind.get("main")?.roas_p75).not.toBeNull();
    expect(byKind.get("test")?.roas_p75).toBeNull();
    expect(byKind.get("test")?.roas_p60).not.toBeNull();
    expect(byKind.get("mixed")?.roas_p60).toBeNull();

    const campaignKinds = await getDb().query<{ campaign_kind: unknown }>(
      `
      SELECT DISTINCT campaign_kind
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND scope_type = 'campaign'
      ORDER BY campaign_kind
      `,
      [fixture.businessId, AS_OF, ENGINE_VERSION],
    );
    expect(campaignKinds.map((row) => row.campaign_kind)).toEqual(["all"]);
  });

  it("does not write campaign rows below the mature creative threshold", async () => {
    const fixture = CAMPAIGN_SCOPE_FIXTURES[0]!;
    await setupCampaignScopeFixture(fixture, AS_OF, {
      campaign_small: 7,
    });

    const result = await runCalibrationJob({
      businessId: fixture.businessId,
      asOf: AS_OF,
    });

    expect(result.status).toBe("success");
    expect(result.rowsWritten).toBe(20);

    const [campaignRowCount] = await getDb().query<CountRow>(
      `
      SELECT COUNT(*) AS count
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND scope_type = 'campaign'
      `,
      [fixture.businessId, AS_OF, ENGINE_VERSION],
    );

    expect(toNumber(campaignRowCount?.count)).toBe(0);
  });

  it("sweeps multiple businesses and campaigns with correct row counts", async () => {
    const [firstFixture, secondFixture] = CAMPAIGN_SCOPE_FIXTURES;
    await setupCampaignScopeFixture(firstFixture, AS_OF, {
      campaign_a: 8,
      campaign_b: 8,
      campaign_too_small: 7,
    });
    await setupCampaignScopeFixture(secondFixture, AS_OF, {
      campaign_c: 8,
    });

    const first = await runCalibrationJob({
      businessId: firstFixture.businessId,
      asOf: AS_OF,
    });
    const second = await runCalibrationJob({
      businessId: secondFixture.businessId,
      asOf: AS_OF,
    });

    expect(first.rowsWritten).toBe(30);
    expect(second.rowsWritten).toBe(25);

    const rows = await getDb().query<CountRow & { business_ref_id: unknown }>(
      `
      SELECT business_ref_id, COUNT(*) AS count
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = ANY($1::uuid[])
        AND as_of_date = $2::date
        AND engine_version = $3
      GROUP BY business_ref_id
      ORDER BY business_ref_id
      `,
      [
        [firstFixture.businessId, secondFixture.businessId],
        AS_OF,
        ENGINE_VERSION,
      ],
    );

    const counts = new Map(
      rows.map((row) => [String(row.business_ref_id), toNumber(row.count)]),
    );
    expect(counts.get(firstFixture.businessId)).toBe(30);
    expect(counts.get(secondFixture.businessId)).toBe(25);
  });

  it("excludes unsupported objectives from calibration baselines", async () => {
    const businessId = MIXED_OBJECTIVE_FIXTURE.businessId;
    await setupMixedObjectiveFixture(MIXED_OBJECTIVE_FIXTURE, AS_OF);

    const result = await runCalibrationJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    const [engagementSourceCount] = await getDb().query<CountRow>(
      `
      SELECT COUNT(DISTINCT creative_id) AS count
      FROM meta_creative_daily
      WHERE business_ref_id = $1::uuid
        AND date = $2::date
        AND objective = 'OUTCOME_ENGAGEMENT'
      `,
      [businessId, AS_OF],
    );
    const [overall] = await getDb().query<CalibrationRow>(
      `
      SELECT
        eligible_creative_count,
        mature_creative_count,
        ctr_p50,
        funnel_sample_count,
        funnel_quality_status
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
        AND creative_format = 'overall'
      `,
      [businessId, AS_OF, ENGINE_VERSION],
    );

    expect(toNumber(engagementSourceCount?.count)).toBe(
      MIXED_OBJECTIVE_ENGAGEMENT_CREATIVE_IDS.length,
    );
    expect(toNumber(overall?.eligible_creative_count)).toBe(
      MIXED_OBJECTIVE_SALES_CREATIVE_IDS.length,
    );
    expect(toNumber(overall?.mature_creative_count)).toBe(
      MIXED_OBJECTIVE_SALES_CREATIVE_IDS.length,
    );
    expect(toNumber(overall?.funnel_sample_count)).toBe(
      MIXED_OBJECTIVE_SALES_CREATIVE_IDS.length,
    );
    expect(toNumber(overall?.ctr_p50)).toBeCloseTo(3, 6);
    expect(overall?.funnel_quality_status).toBe("insufficient");
  });

  it("records skipped when the advisory lock is already held", async () => {
    const businessId = TEST_BUSINESS_IDS[2]!;
    const lockKey = hashAdvisoryLock(`${JOB_NAME}:${businessId}:${AS_OF}`);
    let releaseLock: () => void = () => undefined;
    let holder: Promise<void> | null = null;
    const locked = new Promise<void>((resolve, reject) => {
      holder = runDbTransaction(async () => {
        await getDb().query("SELECT pg_advisory_xact_lock($1::bigint)", [
          lockKey.toString(),
        ]);
        resolve();
        await new Promise<void>((release) => {
          releaseLock = release;
        });
      }).catch(reject);
    });

    await locked;
    let result: Awaited<ReturnType<typeof runCalibrationJob>> | null = null;
    try {
      result = await runCalibrationJob({ businessId, asOf: AS_OF });
    } finally {
      releaseLock();
      await holder;
    }

    expect(result).not.toBeNull();
    expect(result!.status).toBe("skipped");
    expect(result!.rowsWritten).toBe(0);
    expect(result!.calibration).toBeNull();

    const [jobRun] = await getDb().query<JobRunRow>(
      `
      SELECT status, row_count
      FROM engine_v3_job_runs
      WHERE id = $1::uuid
      `,
      [result!.jobRunId],
    );
    expect(jobRun?.status).toBe("skipped");
    expect(toNumber(jobRun?.row_count)).toBe(0);
  });
});
