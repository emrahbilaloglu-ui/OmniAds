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
const TEST_BUSINESS_IDS = [
  "00000000-0000-4000-8000-000000000321",
  "00000000-0000-4000-8000-000000000322",
  "00000000-0000-4000-8000-000000000323",
  MIXED_OBJECTIVE_FIXTURE.businessId,
];

type CountRow = Record<string, unknown> & {
  count: unknown;
};

type JobRunRow = Record<string, unknown> & {
  status: unknown;
  row_count: unknown;
};

type CalibrationRow = Record<string, unknown> & {
  creative_format: unknown;
  eligible_creative_count: unknown;
  mature_creative_count: unknown;
  quality_status: unknown;
  ctr_p50: unknown;
  funnel_sample_count: unknown;
  funnel_quality_status: unknown;
};

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

describe.skipIf(!process.env.DATABASE_URL)("calibration job", () => {
  beforeEach(async () => {
    await cleanupEngineRows();
    await cleanupMixedObjectiveFixture(MIXED_OBJECTIVE_FIXTURE);
  });

  afterEach(async () => {
    await cleanupEngineRows();
    await cleanupMixedObjectiveFixture(MIXED_OBJECTIVE_FIXTURE);
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
    expect(result.rowsWritten).toBe(5);
    expect(result.calibration?.businessId).toBe(businessId);

    const rows = await getDb().query<CalibrationRow>(
      `
      SELECT creative_format, mature_creative_count, quality_status, funnel_sample_count, funnel_quality_status
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
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
    expect(toNumber(jobRun?.row_count)).toBe(5);
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
    expect(toNumber(calibrationCount?.count)).toBe(5);

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
