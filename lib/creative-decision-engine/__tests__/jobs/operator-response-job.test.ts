import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import { JOB_NAME as DECISIONS_JOB_NAME } from "../../jobs/decisions-job";
import {
  JOB_NAME,
  operatorResponseJobAdvisoryLockKey,
  runOperatorResponseJob,
} from "../../jobs/operator-response-job";
import { ENGINE_VERSION } from "../../types";

const AS_OF = "2026-05-05";
const RECOMMENDED_AT = "2026-04-25";
const THESWAF_BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const SYNTHETIC_IGNORED_CREATIVE_ID = "operator-response-synthetic-ignored";
const SYNTHETIC_SCALED_CREATIVE_ID = "operator-response-synthetic-scaled";
const SYNTHETIC_UNLABELED_CREATIVE_ID =
  "operator-response-synthetic-unlabeled";
const SYNTHETIC_CREATIVE_IDS = [
  SYNTHETIC_IGNORED_CREATIVE_ID,
  SYNTHETIC_SCALED_CREATIVE_ID,
  SYNTHETIC_UNLABELED_CREATIVE_ID,
];

type JobRunRow = Record<string, unknown> & {
  status: unknown;
  row_count: unknown;
  dependency_run_id: unknown;
};

type LifecycleRow = Record<string, unknown> & {
  operator_response_type: unknown;
  lifecycle_position: unknown;
  decision_recommended_at: unknown;
  operator_response_detected_at: unknown;
};

type CountRow = Record<string, unknown> & {
  count: unknown;
};

function toNumber(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

async function cleanupSyntheticRows() {
  const db = getDb();
  await db.query(
    `
    DELETE FROM meta_campaign_labels
    WHERE business_id = $1
      AND campaign_id = ANY($2::text[])
    `,
    [
      THESWAF_BUSINESS_ID,
      SYNTHETIC_CREATIVE_IDS.map((creativeId) => `${creativeId}-campaign`),
    ],
  );
  await db.query(
    `
    DELETE FROM engine_v3_decision_events
    WHERE business_ref_id = $1::uuid
      AND creative_id = ANY($2::text[])
      AND event_type = 'operator_action'
    `,
    [THESWAF_BUSINESS_ID, SYNTHETIC_CREATIVE_IDS],
  );
  await db.query(
    `
    DELETE FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND creative_id = ANY($2::text[])
    `,
    [THESWAF_BUSINESS_ID, SYNTHETIC_CREATIVE_IDS],
  );
  await db.query(
    `
    DELETE FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND creative_id = ANY($2::text[])
    `,
    [THESWAF_BUSINESS_ID, SYNTHETIC_CREATIVE_IDS],
  );
  await db.query(
    `
    DELETE FROM meta_creative_daily
    WHERE business_ref_id = $1::uuid
      AND creative_id = ANY($2::text[])
    `,
    [THESWAF_BUSINESS_ID, SYNTHETIC_CREATIVE_IDS],
  );
  await db.query(
    `
    DELETE FROM meta_adset_config_history
    WHERE business_id = $1
      AND adset_id = ANY($2::text[])
    `,
    [
      THESWAF_BUSINESS_ID,
      SYNTHETIC_CREATIVE_IDS.map((creativeId) => `${creativeId}-adset`),
    ],
  );
  await db.query(
    `
    DELETE FROM engine_v3_job_runs
    WHERE business_ref_id = $1::uuid
      AND engine_version = $2
      AND job_name = ANY($3::text[])
    `,
    [THESWAF_BUSINESS_ID, ENGINE_VERSION, [JOB_NAME, DECISIONS_JOB_NAME]],
  );
}

async function insertSuccessfulDecisionsRun() {
  const [row] = await getDb().query<Record<string, unknown> & { id: unknown }>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name,
      business_ref_id,
      business_id,
      as_of_date,
      engine_version,
      status,
      finished_at,
      duration_ms,
      row_count
    )
    VALUES (
      $1,
      $2::uuid,
      $2,
      $3::date,
      $4,
      'success',
      now(),
      1,
      1
    )
    RETURNING id
    `,
    [DECISIONS_JOB_NAME, THESWAF_BUSINESS_ID, AS_OF, ENGINE_VERSION],
  );
  return typeof row?.id === "string" ? row.id : "";
}

async function insertSyntheticFixture(input: {
  creativeId: string;
  withBudgetIncrease?: boolean;
  withCampaignLabel?: boolean;
}) {
  const adsetId = `${input.creativeId}-adset`;
  const campaignId = `${input.creativeId}-campaign`;
  const adId = `${input.creativeId}-ad`;
  if (input.withCampaignLabel !== false) {
    await getDb().query(
      `
      INSERT INTO meta_campaign_labels (
        business_id,
        campaign_id,
        campaign_kind,
        source,
        labeled_by,
        labeled_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'main',
        'user',
        'vitest',
        now(),
        now()
      )
      ON CONFLICT (business_id, campaign_id) DO UPDATE SET
        campaign_kind = EXCLUDED.campaign_kind,
        source = EXCLUDED.source,
        labeled_by = EXCLUDED.labeled_by,
        updated_at = now()
      `,
      [THESWAF_BUSINESS_ID, campaignId],
    );
  }
  await getDb().query(
    `
    INSERT INTO engine_v3_creative_lifecycle_daily (
      business_ref_id,
      business_id,
      campaign_id,
      adset_id,
      ad_id,
      creative_id,
      as_of_date,
      engine_version,
      spend_28d,
      purchases_28d,
      roas_28d,
      spend_7d,
      purchases_7d,
      roas_7d,
      frequency_28d,
      lifecycle_position,
      effective_status,
      computed_at
    )
    VALUES (
      $1::uuid,
      $1,
      $2,
      $3,
      $4,
      $5,
      $6::date,
      $7,
      1000,
      10,
      3.0,
      250,
      2,
      2.8,
      1.2,
      'past_peak_unclear',
      'ACTIVE',
      now()
    )
    ON CONFLICT (business_ref_id, creative_id, as_of_date, engine_version)
    DO UPDATE SET
      lifecycle_position = EXCLUDED.lifecycle_position,
      operator_response_type = NULL,
      operator_response_detected_at = NULL,
      decision_recommended_at = NULL,
      updated_at = now()
    `,
    [
      THESWAF_BUSINESS_ID,
      campaignId,
      adsetId,
      adId,
      input.creativeId,
      AS_OF,
      ENGINE_VERSION,
    ],
  );
  await getDb().query(
    `
    INSERT INTO engine_v3_decision_snapshots_daily (
      business_ref_id,
      business_id,
      creative_id,
      as_of_date,
      engine_version,
      label,
      confidence,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      badges,
      reason,
      spend,
      purchases,
      roas,
      recent7d_roas,
      computed_at
    )
    VALUES (
      $1::uuid,
      $1,
      $2,
      $3::date,
      $4,
      'scale',
      82,
      'commercial_truth',
      2.2,
      1.36,
      '[]'::jsonb,
      'synthetic scale recommendation',
      1000,
      10,
      3.0,
      2.8,
      now()
    )
    ON CONFLICT (business_ref_id, creative_id, as_of_date, engine_version)
    DO UPDATE SET
      label = EXCLUDED.label,
      confidence = EXCLUDED.confidence,
      updated_at = now()
    `,
    [THESWAF_BUSINESS_ID, input.creativeId, RECOMMENDED_AT, ENGINE_VERSION],
  );

  for (let dayOffset = 1; dayOffset <= 10; dayOffset += 1) {
    const date = addDays(RECOMMENDED_AT, dayOffset);
    await getDb().query(
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
        conversions,
        revenue,
        roas,
        ctr,
        cpc,
        link_clicks,
        effective_status,
        objective
      )
      VALUES (
        $1,
        $1::uuid,
        'operator-response-test-provider',
        $2::date,
        $3,
        $4,
        $5,
        $6,
        'Operator Response Synthetic',
        'UTC',
        'USD',
        100,
        10000,
        100,
        1,
        300,
        3,
        1,
        1,
        100,
        'ACTIVE',
        'OUTCOME_SALES'
      )
      ON CONFLICT (business_id, provider_account_id, date, creative_id)
      DO UPDATE SET
        spend = EXCLUDED.spend,
        conversions = EXCLUDED.conversions,
        revenue = EXCLUDED.revenue,
        effective_status = EXCLUDED.effective_status,
        business_ref_id = EXCLUDED.business_ref_id,
        updated_at = now()
      `,
      [THESWAF_BUSINESS_ID, date, campaignId, adsetId, adId, input.creativeId],
    );
  }

  if (input.withBudgetIncrease === true) {
    await insertAdsetBudgetSnapshot({
      adsetId,
      capturedAt: "2026-04-24T00:00:00.000Z",
      dailyBudget: 100,
    });
    await insertAdsetBudgetSnapshot({
      adsetId,
      capturedAt: "2026-05-01T00:00:00.000Z",
      dailyBudget: 150,
    });
  }
}

async function insertAdsetBudgetSnapshot(input: {
  adsetId: string;
  capturedAt: string;
  dailyBudget: number;
}) {
  await getDb().query(
    `
    INSERT INTO meta_adset_config_history (
      business_id,
      provider_account_id,
      campaign_id,
      adset_id,
      config_fingerprint,
      daily_budget,
      lifetime_budget,
      captured_at
    )
    VALUES (
      $1,
      'operator-response-test-provider',
      $2,
      $3,
      $4,
      $5::double precision,
      NULL,
      $6::timestamptz
    )
    ON CONFLICT (business_id, provider_account_id, adset_id, config_fingerprint, captured_at)
    DO UPDATE SET daily_budget = EXCLUDED.daily_budget
    `,
    [
      THESWAF_BUSINESS_ID,
      input.adsetId.replace(/-adset$/, "-campaign"),
      input.adsetId,
      `${input.adsetId}-${input.dailyBudget}`,
      input.dailyBudget,
      input.capturedAt,
    ],
  );
}

function addDays(date: string, offset: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}

async function fetchLifecycle(creativeId: string) {
  const [row] = await getDb().query<LifecycleRow>(
    `
    SELECT
      operator_response_type,
      lifecycle_position,
      decision_recommended_at,
      operator_response_detected_at
    FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND creative_id = $2
      AND as_of_date = $3::date
      AND engine_version = $4
    `,
    [THESWAF_BUSINESS_ID, creativeId, AS_OF, ENGINE_VERSION],
  );
  return row;
}

async function fetchJobRun(jobRunId: string) {
  const [row] = await getDb().query<JobRunRow>(
    `
    SELECT status, row_count, dependency_run_id
    FROM engine_v3_job_runs
    WHERE id = $1::uuid
    `,
    [jobRunId],
  );
  return row;
}

async function countOperatorEvents(creativeId: string) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_decision_events
    WHERE business_ref_id = $1::uuid
      AND creative_id = $2
      AND event_type = 'operator_action'
    `,
    [THESWAF_BUSINESS_ID, creativeId],
  );
  return toNumber(row?.count);
}

describe.skipIf(!process.env.DATABASE_URL)("operator response job", () => {
  beforeEach(async () => {
    await cleanupSyntheticRows();
  });

  afterEach(async () => {
    await cleanupSyntheticRows();
  });

  afterAll(() => {
    resetDbClientCache();
  });

  it("updates lifecycle rows for synthetic TheSwaf scale recommendations", async () => {
    const dependencyRunId = await insertSuccessfulDecisionsRun();
    await insertSyntheticFixture({ creativeId: SYNTHETIC_IGNORED_CREATIVE_ID });

    const result = await runOperatorResponseJob({
      businessId: THESWAF_BUSINESS_ID,
      asOf: AS_OF,
    });

    expect(result.status).toBe("success");
    expect(result.creativesEvaluated).toBeGreaterThanOrEqual(1);
    expect(result.lifecycleRowsUpdated).toBeGreaterThanOrEqual(1);

    const lifecycle = await fetchLifecycle(SYNTHETIC_IGNORED_CREATIVE_ID);
    expect(lifecycle?.operator_response_type).toBe("ignored");
    expect(lifecycle?.lifecycle_position).toBe("past_peak_inaction");
    expect(lifecycle?.decision_recommended_at).not.toBeNull();
    expect(lifecycle?.operator_response_detected_at).not.toBeNull();

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRun?.status).toBe("success");
    expect(toNumber(jobRun?.row_count)).toBe(result.lifecycleRowsUpdated);
    expect(result.dependencyRunId).toBe(dependencyRunId);
  });

  it("is idempotent for operator_action events while recording each invocation", async () => {
    await insertSuccessfulDecisionsRun();
    await insertSyntheticFixture({
      creativeId: SYNTHETIC_SCALED_CREATIVE_ID,
      withBudgetIncrease: true,
    });

    const first = await runOperatorResponseJob({
      businessId: THESWAF_BUSINESS_ID,
      asOf: AS_OF,
    });
    const second = await runOperatorResponseJob({
      businessId: THESWAF_BUSINESS_ID,
      asOf: AS_OF,
    });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");

    const lifecycle = await fetchLifecycle(SYNTHETIC_SCALED_CREATIVE_ID);
    expect(lifecycle?.operator_response_type).toBe("scaled");
    expect(await countOperatorEvents(SYNTHETIC_SCALED_CREATIVE_ID)).toBe(1);
  });

  it("ignores historical hard snapshots when the campaign is still unlabeled", async () => {
    await insertSuccessfulDecisionsRun();
    await insertSyntheticFixture({
      creativeId: SYNTHETIC_UNLABELED_CREATIVE_ID,
      withCampaignLabel: false,
    });

    const result = await runOperatorResponseJob({
      businessId: THESWAF_BUSINESS_ID,
      asOf: AS_OF,
    });

    expect(result.status).toBe("success");
    expect(result.creativesEvaluated).toBe(0);

    const lifecycle = await fetchLifecycle(SYNTHETIC_UNLABELED_CREATIVE_ID);
    expect(lifecycle?.operator_response_type).toBeNull();
    expect(await countOperatorEvents(SYNTHETIC_UNLABELED_CREATIVE_ID)).toBe(0);
  });

  it("records skipped when the advisory lock is already held", async () => {
    const lockKey = operatorResponseJobAdvisoryLockKey({
      businessId: THESWAF_BUSINESS_ID,
      asOf: AS_OF,
    });
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
    let result: Awaited<ReturnType<typeof runOperatorResponseJob>> | null = null;
    try {
      result = await runOperatorResponseJob({
        businessId: THESWAF_BUSINESS_ID,
        asOf: AS_OF,
      });
    } finally {
      releaseLock();
      await holder;
    }

    expect(result).not.toBeNull();
    expect(result!.status).toBe("skipped");
    expect(result!.lifecycleRowsUpdated).toBe(0);

    const jobRun = await fetchJobRun(result!.jobRunId);
    expect(jobRun?.status).toBe("skipped");
    expect(toNumber(jobRun?.row_count)).toBe(0);
  });
});
