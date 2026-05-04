import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import { ENGINE_VERSION } from "../../types";
import {
  hashAdvisoryLock,
  JOB_NAME,
  runCalibrationJob,
} from "../../jobs/calibration-job";

const AS_OF = "2026-05-04";
const TEST_BUSINESS_IDS = [
  "00000000-0000-4000-8000-000000000321",
  "00000000-0000-4000-8000-000000000322",
  "00000000-0000-4000-8000-000000000323",
];

type CountRow = Record<string, unknown> & {
  count: unknown;
};

type JobRunRow = Record<string, unknown> & {
  status: unknown;
  row_count: unknown;
};

type CalibrationRow = Record<string, unknown> & {
  mature_creative_count: unknown;
  quality_status: unknown;
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
  });

  afterEach(async () => {
    await cleanupEngineRows();
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
    expect(result.rowsWritten).toBe(1);
    expect(result.calibration?.businessId).toBe(businessId);

    const [calibration] = await getDb().query<CalibrationRow>(
      `
      SELECT mature_creative_count, quality_status
      FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
        AND as_of_date = $2::date
        AND engine_version = $3
      `,
      [businessId, AS_OF, ENGINE_VERSION],
    );
    expect(toNumber(calibration?.mature_creative_count)).toBe(0);
    expect(calibration?.quality_status).toBe("low_sample");

    const [jobRun] = await getDb().query<JobRunRow>(
      `
      SELECT status, row_count
      FROM engine_v3_job_runs
      WHERE id = $1::uuid
      `,
      [result.jobRunId],
    );
    expect(jobRun?.status).toBe("success");
    expect(toNumber(jobRun?.row_count)).toBe(1);
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
    expect(toNumber(calibrationCount?.count)).toBe(1);

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
