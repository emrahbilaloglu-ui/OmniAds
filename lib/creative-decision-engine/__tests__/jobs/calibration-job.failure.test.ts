import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => dbMocks),
  runDbTransaction: vi.fn((callback: () => Promise<unknown>) => callback()),
}));

import { runCalibrationJob } from "../../jobs/calibration-job";

describe("calibration job failure handling", () => {
  beforeEach(() => {
    dbMocks.query.mockReset();
  });

  it("marks a running job as failed when calibration computation errors", async () => {
    const jobRunId = "11111111-1111-4111-8111-111111111111";
    dbMocks.query
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([{ id: jobRunId }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("simulated compute failure"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await runCalibrationJob({
      businessId: "00000000-0000-4000-8000-000000000399",
      asOf: "2026-05-04",
    });

    expect(result).toMatchObject({
      jobRunId,
      status: "failed",
      rowsWritten: 0,
      calibration: null,
      errorMessage: "simulated compute failure",
    });

    const failedUpdate = dbMocks.query.mock.calls.find(
      ([queryText]) =>
        typeof queryText === "string" && queryText.includes("status = 'failed'"),
    );
    expect(failedUpdate).toBeTruthy();
  });
});
