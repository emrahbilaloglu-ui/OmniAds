import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("../../feature-flags", () => ({
  listEnabledBusinessIds: vi.fn(),
}));

vi.mock("../../jobs/calibration-job", () => ({
  runCalibrationJob: vi.fn(),
}));

vi.mock("../../jobs/lifecycle-job", () => ({
  runLifecycleJob: vi.fn(),
}));

vi.mock("../../jobs/decisions-job", () => ({
  JOB_NAME: "engine_v3_decisions_job",
  runDecisionsJob: vi.fn(),
}));

const db = await import("@/lib/db");
const readiness = await import("@/lib/db-schema-readiness");
const featureFlags = await import("../../feature-flags");
const calibrationJob = await import("../../jobs/calibration-job");
const lifecycleJob = await import("../../jobs/lifecycle-job");
const decisionsJob = await import("../../jobs/decisions-job");
const {
  ENGINE_V3_PRODUCER_DAILY_UTC_START_HOUR,
  runEngineV3ProducerChainForActiveBusinessesIfDue,
} = await import("../../jobs/scheduled");

function makeDbRows(rows: Array<{ business_ref_id: string }>) {
  return {
    query: vi.fn().mockResolvedValue(rows),
  };
}

const successCalibration = {
  jobRunId: "calibration-run",
  status: "success",
  rowsWritten: 1,
  durationMs: 1,
  calibration: null,
};

const successLifecycle = {
  jobRunId: "lifecycle-run",
  dependencyRunId: "calibration-run",
  status: "success",
  rowsWritten: 1,
  durationMs: 1,
};

const successDecisions = {
  jobRunId: "decisions-run",
  status: "success",
  snapshotsWritten: 1,
  changeEventsWritten: 0,
  durationMs: 1,
};

describe("runEngineV3ProducerChainForActiveBusinessesIfDue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.DECISION_ENGINE_V3_JOBS_DISABLED;
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-05-08T00:00:00.000Z",
    });
    vi.mocked(featureFlags.listEnabledBusinessIds).mockResolvedValue([
      "biz_1",
      "biz_2",
    ]);
    vi.mocked(db.getDb).mockReturnValue(makeDbRows([]) as never);
    vi.mocked(calibrationJob.runCalibrationJob).mockResolvedValue(
      successCalibration as never,
    );
    vi.mocked(lifecycleJob.runLifecycleJob).mockResolvedValue(
      successLifecycle as never,
    );
    vi.mocked(decisionsJob.runDecisionsJob).mockResolvedValue(
      successDecisions as never,
    );
  });

  it("skips before the daily producer catch-up slot", async () => {
    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T02:10:00.000Z"),
    );

    expect(result).toEqual({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-05-08",
    });
    expect(calibrationJob.runCalibrationJob).not.toHaveBeenCalled();
  });

  it("runs at and after the daily producer catch-up slot", async () => {
    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date(
        `2026-05-08T${String(ENGINE_V3_PRODUCER_DAILY_UTC_START_HOUR).padStart(
          2,
          "0",
        )}:10:00.000Z`,
      ),
      [{ id: "biz_1", name: null }],
    );

    expect(result.skipped).toBe(false);
    expect(calibrationJob.runCalibrationJob).toHaveBeenCalledWith({
      businessId: "biz_1",
      asOf: "2026-05-08",
    });
  });

  it("supports the rollback kill switch", async () => {
    process.env.DECISION_ENGINE_V3_JOBS_DISABLED = "1";

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
    );

    expect(result).toEqual({
      skipped: true,
      reason: "jobs_disabled",
      asOf: "2026-05-08",
    });
    expect(readiness.getDbSchemaReadiness).not.toHaveBeenCalled();
  });

  it("uses enabled engine businesses and skips businesses with completed decisions", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeDbRows([{ business_ref_id: "biz_1" }]) as never,
    );

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T05:10:00.000Z"),
    );

    expect(result.skipped).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results?.[0]?.businessId).toBe("biz_2");
    expect(featureFlags.listEnabledBusinessIds).toHaveBeenCalled();
    expect(calibrationJob.runCalibrationJob).toHaveBeenCalledWith({
      businessId: "biz_2",
      asOf: "2026-05-08",
    });
  });

  it("runs calibration, lifecycle, and decisions in order", async () => {
    await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [{ id: "biz_1", name: null }],
    );

    expect(
      vi.mocked(calibrationJob.runCalibrationJob).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(lifecycleJob.runLifecycleJob).mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(
      vi.mocked(lifecycleJob.runLifecycleJob).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(decisionsJob.runDecisionsJob).mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
  });

  it("keeps running downstream jobs when an upstream producer job fails", async () => {
    vi.mocked(calibrationJob.runCalibrationJob).mockRejectedValueOnce(
      new Error("calibration failed"),
    );

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [{ id: "biz_1", name: null }],
    );

    expect(result.skipped).toBe(false);
    expect(result.results?.[0]?.calibration.status).toBe("failed");
    expect(result.results?.[0]?.calibration.errorMessage).toBe(
      "calibration failed",
    );
    expect(lifecycleJob.runLifecycleJob).toHaveBeenCalled();
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalled();
  });

  it("isolates failures so one business does not prevent the next business", async () => {
    vi.mocked(decisionsJob.runDecisionsJob)
      .mockRejectedValueOnce(new Error("decisions failed"))
      .mockResolvedValueOnce(successDecisions as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [
        { id: "biz_1", name: null },
        { id: "biz_2", name: null },
      ],
    );

    expect(result.skipped).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results?.[0]?.decisions.status).toBe("failed");
    expect(result.results?.[1]?.decisions.status).toBe("success");
  });
});
