import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => dbMocks),
  runDbTransaction: vi.fn((callback: () => Promise<unknown>) => callback()),
}));

import { runLifecycleJob } from "../../jobs/lifecycle-job";

describe("lifecycle job failure handling", () => {
  beforeEach(() => {
    dbMocks.query.mockReset();
  });

  it("marks a running job as failed when lifecycle computation errors", async () => {
    const jobRunId = "22222222-2222-4222-8222-222222222222";
    dbMocks.query
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: jobRunId }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("simulated lifecycle failure"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await runLifecycleJob({
      businessId: "00000000-0000-4000-8000-000000000499",
      asOf: "2026-05-04",
    });

    expect(result).toMatchObject({
      jobRunId,
      status: "failed",
      rowsWritten: 0,
      errorMessage: "simulated lifecycle failure",
    });

    const failedUpdate = dbMocks.query.mock.calls.find(
      ([queryText]) =>
        typeof queryText === "string" && queryText.includes("status = 'failed'"),
    );
    expect(failedUpdate).toBeTruthy();
  });
});
