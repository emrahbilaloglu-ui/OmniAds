import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import {
  JOB_NAME as CALIBRATION_JOB_NAME,
  runCalibrationJob,
} from "../../jobs/calibration-job";
import {
  decisionsJobAdvisoryLockKey,
  JOB_NAME,
  runDecisionsJob,
} from "../../jobs/decisions-job";
import {
  JOB_NAME as LIFECYCLE_JOB_NAME,
  runLifecycleJob,
} from "../../jobs/lifecycle-job";
import { WarehouseDataSource } from "../../data-source";
import { ENGINE_VERSION, type DecisionLabel } from "../../types";

const AS_OF = "2026-05-04";
const PREVIOUS_AS_OF = "2026-05-03";
const THESWAF_BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const IWASTORE_BUSINESS_ID = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const FAILURE_BUSINESS_ID = "00000000-0000-4000-8000-000000000551";
const TEST_BUSINESS_IDS = [
  THESWAF_BUSINESS_ID,
  IWASTORE_BUSINESS_ID,
  FAILURE_BUSINESS_ID,
];

type CountRow = Record<string, unknown> & {
  count: unknown;
};

type SnapshotLinkageCountRow = Record<string, unknown> & {
  missing_lifecycle_count: unknown;
  missing_calibration_count: unknown;
};

type JobRunRow = Record<string, unknown> & {
  status: unknown;
  row_count: unknown;
  dependency_run_id: unknown;
  error_message: unknown;
  error_json: unknown;
};

type DecisionSnapshotFixtureRow = Record<string, unknown> & {
  id: unknown;
  business_id: unknown;
  creative_id: unknown;
  scope_type: unknown;
  scope_id: unknown;
  label: unknown;
  confidence: unknown;
  truth_source: unknown;
  effective_target_roas: unknown;
  ratio_to_target: unknown;
  badges: unknown;
  reason: unknown;
  spend: unknown;
  purchases: unknown;
  roas: unknown;
  recent7d_roas: unknown;
};

type DecisionEventRow = Record<string, unknown> & {
  creative_id: unknown;
  previous_label: unknown;
  current_label: unknown;
  operator_evidence: unknown;
};

function toNumber(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function toString(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function toDecisionLabel(value: unknown): DecisionLabel {
  const text = toString(value);
  if (
    text === "scale" ||
    text === "keep" ||
    text === "refresh" ||
    text === "cut" ||
    text === "test_more" ||
    text === "diagnose" ||
    text === "out_of_scope"
  ) {
    return text;
  }
  throw new Error(`Unexpected decision label in fixture row: ${text}`);
}

function alternateLabel(label: DecisionLabel): DecisionLabel {
  return label === "diagnose" ? "test_more" : "diagnose";
}

function changeEventCountMetadata(value: unknown) {
  if (value === null || typeof value !== "object") return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") return null;
  const count = (metadata as { change_event_count?: unknown })
    .change_event_count;
  return typeof count === "number" ? count : null;
}

async function cleanupEngineRows() {
  const db = getDb();
  await db.query(
    `
    DELETE FROM business_engine_v3_flags
    WHERE business_id = ANY($1::uuid[])
    `,
    [TEST_BUSINESS_IDS],
  );
  await db.query(
    `
    DELETE FROM engine_v3_decision_events
    WHERE business_ref_id = ANY($1::uuid[])
      AND event_type = 'decision_changed'
      AND event_date BETWEEN $2::date AND $3::date
    `,
    [TEST_BUSINESS_IDS, PREVIOUS_AS_OF, AS_OF],
  );
  await db.query(
    `
    DELETE FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION],
  );
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
    [
      TEST_BUSINESS_IDS,
      ENGINE_VERSION,
      [JOB_NAME, LIFECYCLE_JOB_NAME, CALIBRATION_JOB_NAME],
    ],
  );
}

async function prepareUpstream(businessId: string) {
  const calibration = await runCalibrationJob({ businessId, asOf: AS_OF });
  expect(calibration.status).toBe("success");

  const lifecycle = await runLifecycleJob({ businessId, asOf: AS_OF });
  expect(lifecycle.status).toBe("success");
  expect(lifecycle.rowsWritten).toBeGreaterThan(0);

  return { calibration, lifecycle };
}

async function countDecisionSnapshots(businessId: string) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    `,
    [businessId, AS_OF, ENGINE_VERSION],
  );
  return toNumber(row?.count);
}

async function countDecisionEvents(businessId: string) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_decision_events
    WHERE business_ref_id = $1::uuid
      AND event_date = $2::date
      AND event_type = 'decision_changed'
    `,
    [businessId, AS_OF],
  );
  return toNumber(row?.count);
}

async function snapshotLinkageCounts(businessId: string) {
  const [row] = await getDb().query<SnapshotLinkageCountRow>(
    `
    SELECT
      COUNT(*) FILTER (WHERE lifecycle_row_id IS NULL) AS missing_lifecycle_count,
      COUNT(*) FILTER (WHERE calibration_row_id IS NULL) AS missing_calibration_count
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    `,
    [businessId, AS_OF, ENGINE_VERSION],
  );
  return {
    missingLifecycleCount: toNumber(row?.missing_lifecycle_count),
    missingCalibrationCount: toNumber(row?.missing_calibration_count),
  };
}

async function countDecisionJobRuns(businessId: string) {
  const [row] = await getDb().query<CountRow>(
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
  return toNumber(row?.count);
}

async function fetchJobRun(jobRunId: string) {
  const [row] = await getDb().query<JobRunRow>(
    `
    SELECT status, row_count, dependency_run_id, error_message, error_json
    FROM engine_v3_job_runs
    WHERE id = $1::uuid
    `,
    [jobRunId],
  );
  return row;
}

async function fetchDecisionSnapshots(input: {
  businessId: string;
  limit: number;
}) {
  return getDb().query<DecisionSnapshotFixtureRow>(
    `
    SELECT
      id,
      business_id,
      creative_id,
      scope_type,
      scope_id,
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
      recent7d_roas
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    ORDER BY creative_id ASC
    LIMIT $4::integer
    `,
    [input.businessId, AS_OF, ENGINE_VERSION, input.limit],
  );
}

async function insertPreviousSnapshotFromCurrent(input: {
  businessId: string;
  current: DecisionSnapshotFixtureRow;
  label: DecisionLabel;
}) {
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
      $2,
      $3,
      $4::date,
      $5,
      $6,
      $7::integer,
      $8,
      $9::double precision,
      $10::double precision,
      $11::jsonb,
      $12,
      $13::double precision,
      $14::double precision,
      $15::double precision,
      $16::double precision,
      now()
    )
    `,
    [
      input.businessId,
      toString(input.current.business_id) || input.businessId,
      toString(input.current.creative_id),
      PREVIOUS_AS_OF,
      ENGINE_VERSION,
      input.label,
      toNumber(input.current.confidence),
      toString(input.current.truth_source),
      toNumber(input.current.effective_target_roas),
      input.current.ratio_to_target,
      JSON.stringify(input.current.badges ?? []),
      toString(input.current.reason),
      input.current.spend,
      input.current.purchases,
      input.current.roas,
      input.current.recent7d_roas,
    ],
  );
}

describe.skipIf(!process.env.DATABASE_URL)("decisions job", () => {
  beforeEach(async () => {
    await cleanupEngineRows();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupEngineRows();
  });

  afterAll(() => {
    resetDbClientCache();
  });

  it("inserts decision snapshots and marks the job run successful", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    const { lifecycle } = await prepareUpstream(businessId);

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.snapshotsWritten).toBeGreaterThan(0);
    expect(result.changeEventsWritten).toBe(0);
    expect(await countDecisionSnapshots(businessId)).toBe(
      result.snapshotsWritten,
    );

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRun?.status).toBe("success");
    expect(toNumber(jobRun?.row_count)).toBe(result.snapshotsWritten);
    expect(jobRun?.dependency_run_id).toBe(lifecycle.jobRunId);
    expect(changeEventCountMetadata(jobRun?.error_json)).toBe(0);

    const linkage = await snapshotLinkageCounts(businessId);
    expect(linkage.missingLifecycleCount).toBe(0);
    expect(linkage.missingCalibrationCount).toBe(0);

    const [snapshot] = await fetchDecisionSnapshots({ businessId, limit: 1 });
    expect(snapshot?.scope_type).toBe("account");
    expect(snapshot?.scope_id).toBe("*");
  });

  it("is idempotent for snapshots while recording each invocation", async () => {
    const businessId = IWASTORE_BUSINESS_ID;
    await prepareUpstream(businessId);

    const first = await runDecisionsJob({ businessId, asOf: AS_OF });
    const second = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(await countDecisionSnapshots(businessId)).toBe(
      second.snapshotsWritten,
    );
    expect(await countDecisionEvents(businessId)).toBe(0);
    expect(await countDecisionJobRuns(businessId)).toBe(2);
  });

  it("records skipped when the advisory lock is already held", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    await prepareUpstream(businessId);

    const lockKey = decisionsJobAdvisoryLockKey({ businessId, asOf: AS_OF });
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
    let result: Awaited<ReturnType<typeof runDecisionsJob>> | null = null;
    try {
      result = await runDecisionsJob({ businessId, asOf: AS_OF });
    } finally {
      releaseLock();
      await holder;
    }

    expect(result).not.toBeNull();
    expect(result!.status).toBe("skipped");
    expect(result!.snapshotsWritten).toBe(0);
    expect(result!.changeEventsWritten).toBe(0);

    const jobRun = await fetchJobRun(result!.jobRunId);
    expect(jobRun?.status).toBe("skipped");
    expect(toNumber(jobRun?.row_count)).toBe(0);
  });

  it("returns skipped and writes no snapshots when engine v3 is disabled for the business", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    await getDb().query(
      `
      INSERT INTO business_engine_v3_flags (
        business_id,
        enabled,
        surface_visible,
        shadow_only,
        notes,
        updated_by
      )
      VALUES ($1::uuid, false, NULL, NULL, 'disabled in test', 'vitest')
      ON CONFLICT (business_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        surface_visible = EXCLUDED.surface_visible,
        shadow_only = EXCLUDED.shadow_only,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      `,
      [businessId],
    );

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "engine_v3_disabled",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
    });
    expect(await countDecisionSnapshots(businessId)).toBe(0);
  });

  it("writes a change event only when the prior snapshot label differs", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    await prepareUpstream(businessId);
    const initial = await runDecisionsJob({ businessId, asOf: AS_OF });
    expect(initial.status).toBe("success");

    const snapshots = await fetchDecisionSnapshots({ businessId, limit: 2 });
    expect(snapshots.length).toBe(2);

    const changedSnapshot = snapshots[0]!;
    const unchangedSnapshot = snapshots[1]!;
    const changedCreativeId = toString(changedSnapshot.creative_id);
    const unchangedCreativeId = toString(unchangedSnapshot.creative_id);
    const changedCurrentLabel = toDecisionLabel(changedSnapshot.label);
    const changedPreviousLabel = alternateLabel(changedCurrentLabel);
    const unchangedLabel = toDecisionLabel(unchangedSnapshot.label);

    await insertPreviousSnapshotFromCurrent({
      businessId,
      current: changedSnapshot,
      label: changedPreviousLabel,
    });
    await insertPreviousSnapshotFromCurrent({
      businessId,
      current: unchangedSnapshot,
      label: unchangedLabel,
    });

    const second = await runDecisionsJob({ businessId, asOf: AS_OF });
    const third = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(second.status).toBe("success");
    expect(second.changeEventsWritten).toBe(1);
    expect(third.status).toBe("success");
    expect(third.changeEventsWritten).toBe(0);

    const events = await getDb().query<DecisionEventRow>(
      `
      SELECT creative_id, previous_label, current_label, operator_evidence
      FROM engine_v3_decision_events
      WHERE business_ref_id = $1::uuid
        AND event_date = $2::date
        AND event_type = 'decision_changed'
      ORDER BY creative_id ASC
      `,
      [businessId, AS_OF],
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.creative_id).toBe(changedCreativeId);
    expect(events[0]?.creative_id).not.toBe(unchangedCreativeId);
    expect(events[0]?.previous_label).toBe(changedPreviousLabel);
    expect(events[0]?.current_label).toBe(changedCurrentLabel);
    expect(events[0]?.operator_evidence).toMatchObject({
      previous_decision_snapshot_id: expect.any(String),
      current_decision_snapshot_id: expect.any(String),
    });
  });

  it("marks a running job as failed when decision computation errors", async () => {
    const error = new Error("simulated decisions failure");
    vi.spyOn(
      WarehouseDataSource.prototype,
      "getAccountCalibration",
    ).mockRejectedValueOnce(error);

    const result = await runDecisionsJob({
      businessId: FAILURE_BUSINESS_ID,
      asOf: AS_OF,
    });

    expect(result).toMatchObject({
      status: "failed",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
      errorMessage: "simulated decisions failure",
    });

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRun?.status).toBe("failed");
    expect(toNumber(jobRun?.row_count)).toBe(0);
    expect(jobRun?.error_message).toBe("simulated decisions failure");
  });
});
