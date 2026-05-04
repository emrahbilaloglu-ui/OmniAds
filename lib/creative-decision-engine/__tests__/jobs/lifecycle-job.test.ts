import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import {
  JOB_NAME as CALIBRATION_JOB_NAME,
  runCalibrationJob,
} from "../../jobs/calibration-job";
import {
  JOB_NAME,
  lifecycleJobAdvisoryLockKey,
  runLifecycleJob,
} from "../../jobs/lifecycle-job";
import { ENGINE_VERSION } from "../../types";

const AS_OF = "2026-05-04";
const TEST_BUSINESS_IDS = [
  "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
];

type CountRow = Record<string, unknown> & {
  count: unknown;
};

type JobRunRow = Record<string, unknown> & {
  status: unknown;
  row_count: unknown;
  dependency_run_id: unknown;
};

type DistributionRow = Record<string, unknown> & {
  lifecycle_position: unknown;
  count: unknown;
};

function toNumber(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

async function cleanupEngineRows() {
  const db = getDb();
  await db.query(
    `
    DELETE FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION],
  );
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
      AND job_name = ANY($3::text[])
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION, [JOB_NAME, CALIBRATION_JOB_NAME]],
  );
}

async function countLifecycleRows(businessId: string) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    `,
    [businessId, AS_OF, ENGINE_VERSION],
  );
  return toNumber(row?.count);
}

async function lifecycleDistribution(businessId: string) {
  return getDb().query<DistributionRow>(
    `
    SELECT lifecycle_position, COUNT(*) AS count
    FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    GROUP BY lifecycle_position
    ORDER BY lifecycle_position
    `,
    [businessId, AS_OF, ENGINE_VERSION],
  );
}

describe.skipIf(!process.env.DATABASE_URL)("lifecycle job", () => {
  beforeEach(async () => {
    await cleanupEngineRows();
  });

  afterEach(async () => {
    await cleanupEngineRows();
  });

  afterAll(() => {
    resetDbClientCache();
  });

  it("inserts lifecycle rows for both businesses and marks job runs successful", async () => {
    const positions = new Set<string>();

    for (const businessId of TEST_BUSINESS_IDS) {
      const calibration = await runCalibrationJob({ businessId, asOf: AS_OF });
      expect(calibration.status).toBe("success");

      const result = await runLifecycleJob({ businessId, asOf: AS_OF });
      expect(result.status).toBe("success");
      expect(result.dependencyRunId).toBe(calibration.jobRunId);
      expect(result.rowsWritten).toBeGreaterThan(0);
      expect(await countLifecycleRows(businessId)).toBe(result.rowsWritten);

      const [jobRun] = await getDb().query<JobRunRow>(
        `
        SELECT status, row_count, dependency_run_id
        FROM engine_v3_job_runs
        WHERE id = $1::uuid
        `,
        [result.jobRunId],
      );
      expect(jobRun?.status).toBe("success");
      expect(toNumber(jobRun?.row_count)).toBe(result.rowsWritten);
      expect(jobRun?.dependency_run_id).toBe(calibration.jobRunId);

      const distribution = await lifecycleDistribution(businessId);
      expect(distribution.length).toBeGreaterThan(0);
      for (const row of distribution) {
        const position = String(row.lifecycle_position ?? "");
        positions.add(position);
        expect(position).not.toBe("past_peak_inaction");
      }
    }

    expect(positions.has("insufficient_history")).toBe(true);
    expect(
      [...positions].some((position) =>
        ["plateau", "closing", "past_peak_natural", "past_peak_unclear"].includes(
          position,
        ),
      ),
    ).toBe(true);
  });

  it("is idempotent for lifecycle rows while recording each invocation", async () => {
    const businessId = TEST_BUSINESS_IDS[0]!;
    await runCalibrationJob({ businessId, asOf: AS_OF });

    const first = await runLifecycleJob({ businessId, asOf: AS_OF });
    const second = await runLifecycleJob({ businessId, asOf: AS_OF });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(await countLifecycleRows(businessId)).toBe(second.rowsWritten);

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
    const businessId = TEST_BUSINESS_IDS[1]!;
    const lockKey = lifecycleJobAdvisoryLockKey({ businessId, asOf: AS_OF });
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
    let result: Awaited<ReturnType<typeof runLifecycleJob>> | null = null;
    try {
      result = await runLifecycleJob({ businessId, asOf: AS_OF });
    } finally {
      releaseLock();
      await holder;
    }

    expect(result).not.toBeNull();
    expect(result!.status).toBe("skipped");
    expect(result!.rowsWritten).toBe(0);

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
