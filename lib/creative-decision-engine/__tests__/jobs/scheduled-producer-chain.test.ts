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
  JOB_NAME: "engine_v3_calibration_job",
  runCalibrationJob: vi.fn(),
}));

vi.mock("../../jobs/campaign-context-job", () => ({
  JOB_NAME: "engine_v3_campaign_context_job",
  runCampaignContextJob: vi.fn(),
}));

vi.mock("../../jobs/lifecycle-job", () => ({
  JOB_NAME: "engine_v3_lifecycle_job",
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
const campaignContextJob = await import("../../jobs/campaign-context-job");
const lifecycleJob = await import("../../jobs/lifecycle-job");
const decisionsJob = await import("../../jobs/decisions-job");
const {
  ENGINE_V3_PRODUCER_DAILY_UTC_START_HOUR,
  runEngineV3ProducerChainForActiveBusinessesIfDue,
} = await import("../../jobs/scheduled");

const providerDays = ["biz_1", "biz_2"].map((business_id) => ({
  business_id, provider_account_id: `act_${business_id}`,
  timezone: "UTC", latest_published_day: "2026-05-07",
}));

function makeDbRows(rows: Array<{ business_ref_id: string; as_of_date: string }>) {
  return {
    query: vi.fn().mockImplementation(async (sql: string) =>
      sql.includes("FROM business_provider_accounts bpa") ? providerDays : rows),
  };
}

const successCampaignContext = {
  jobRunId: "campaign-context-run",
  status: "success",
  rowsWritten: 1,
  durationMs: 1,
};

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
    vi.mocked(campaignContextJob.runCampaignContextJob).mockResolvedValue(
      successCampaignContext as never,
    );
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
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T03:10:00.000Z",
    });
  });

  it("selects the last closed local reporting day for Anchorage and Chicago at 03Z", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) =>
      sql.includes("FROM business_provider_accounts bpa") ? [
        { business_id: "biz_1", provider_account_id: "act_anchorage",
          timezone: "America/Anchorage", latest_published_day: "2026-05-07" },
        { business_id: "biz_2", provider_account_id: "act_chicago",
          timezone: "America/Chicago", latest_published_day: "2026-05-07" },
      ] : []);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
    );
    expect(result.asOf).toBe("2026-05-06");
    expect(result.results?.map((row) => [row.businessId, row.asOf])).toEqual([
      ["biz_1", "2026-05-06"], ["biz_2", "2026-05-06"],
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("manifest.completed_at >=");
    expect(query.mock.calls[0]?.[0]).toContain("slice.staged_row_count =");
  });

  it("uses the earliest closed published day across a business's accounts", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) =>
      sql.includes("FROM business_provider_accounts bpa") ? [
        { business_id: "biz_1", provider_account_id: "act_anchorage",
          timezone: "America/Anchorage", latest_published_day: "2026-05-07" },
        { business_id: "biz_1", provider_account_id: "act_honolulu",
          timezone: "Pacific/Honolulu", latest_published_day: "2026-05-07" },
      ] : []);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T09:10:00.000Z"), [{ id: "biz_1", name: null }],
    );
    expect(result.results?.[0]?.asOf).toBe("2026-05-06");
  });

  it("advances after a late source publication instead of completing an unpublished day", async () => {
    let latestPublishedDay = "2026-05-05";
    const query = vi.fn().mockImplementation(async (sql: string) =>
      sql.includes("FROM business_provider_accounts bpa") ? [
        { business_id: "biz_1", provider_account_id: "act_anchorage",
          timezone: "America/Anchorage", latest_published_day: latestPublishedDay },
      ] : []);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const first = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"), [{ id: "biz_1", name: null }],
    );
    latestPublishedDay = "2026-05-06";
    const second = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:20:00.000Z"), [{ id: "biz_1", name: null }],
    );
    expect(first.results?.[0]?.asOf).toBe("2026-05-05");
    expect(second.results?.[0]?.asOf).toBe("2026-05-06");
    expect(calibrationJob.runCalibrationJob).toHaveBeenCalledTimes(2);
  });

  it("skips an unchanged successful day and compares stable config certification clocks", async () => {
    const query = makeDbRows([{
      business_ref_id: "biz_1", as_of_date: "2026-05-07",
    }]).query;
    vi.mocked(db.getDb).mockReturnValue({ query } as never);
    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"), [{ id: "biz_1", name: null }],
    );
    expect(result).toMatchObject({ skipped: true, reason: "already_ran", asOf: "2026-05-07" });
    expect(query.mock.calls[1]?.[0]).toContain("historical_config_proof,certified_at");
    expect(query.mock.calls[1]?.[0]).toContain("> latest_decision.evaluation_cutoff_at");
    expect(query.mock.calls[1]?.[0]).not.toContain("decisions_finished_at");
    expect(query.mock.calls[1]?.[0]).not.toContain("creative.updated_at >");
    expect(calibrationJob.runCalibrationJob).not.toHaveBeenCalled();
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

  it("uses enabled engine businesses and skips businesses with completed producer chains", async () => {
    const query = makeDbRows([{ business_ref_id: "biz_1", as_of_date: "2026-05-07" }]).query;
    vi.mocked(db.getDb).mockReturnValue({ query } as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T05:10:00.000Z"),
    );

    expect(result.skipped).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results?.[0]?.businessId).toBe("biz_2");
    expect(featureFlags.listEnabledBusinessIds).toHaveBeenCalled();
    expect(calibrationJob.runCalibrationJob).toHaveBeenCalledWith({
      businessId: "biz_2",
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T05:10:00.000Z",
    });
    expect(query.mock.calls[1]?.[0]).toContain("engine_v3_calibration_job");
    expect(query.mock.calls[1]?.[0]).toContain("engine_v3_lifecycle_job");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "engine_v3_decisions_job",
      ["biz_1", "biz_2"],
      ["2026-05-07", "2026-05-07"],
      expect.any(String),
    ]);
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

  it("skips downstream jobs for a business when calibration fails but continues the batch", async () => {
    vi.mocked(calibrationJob.runCalibrationJob).mockRejectedValueOnce(
      new Error("calibration failed"),
    );

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [
        { id: "biz_1", name: null },
        { id: "biz_2", name: null },
      ],
    );

    expect(result.skipped).toBe(false);
    expect(result.results?.[0]?.calibration.status).toBe("failed");
    expect(result.results?.[0]?.calibration.errorMessage).toBe(
      "calibration failed",
    );
    expect(result.results?.[0]?.lifecycle.status).toBe("skipped");
    expect(result.results?.[0]?.lifecycle.errorMessage).toBe(
      "upstream_calibration_not_success",
    );
    expect(result.results?.[0]?.decisions.status).toBe("skipped");
    expect(result.results?.[0]?.decisions.errorMessage).toBe(
      "upstream_calibration_not_success",
    );
    expect(result.results?.[1]?.calibration.status).toBe("success");
    expect(lifecycleJob.runLifecycleJob).toHaveBeenCalledTimes(1);
    expect(lifecycleJob.runLifecycleJob).toHaveBeenCalledWith({
      businessId: "biz_2",
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T03:10:00.000Z",
    });
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalledTimes(1);
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalledWith({
      businessId: "biz_2",
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T03:10:00.000Z",
    });
  });

  it("continues downstream when calibration skips but the same-day success already exists", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(providerDays)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ exists: true }]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);
    vi.mocked(calibrationJob.runCalibrationJob).mockResolvedValueOnce({
      jobRunId: "skipped-calibration-run",
      status: "skipped",
      rowsWritten: 0,
      durationMs: 1,
      calibration: null,
      errorMessage: "Advisory lock not acquired (job may already be running)",
    } as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [{ id: "biz_1", name: null }],
    );

    expect(result.skipped).toBe(false);
    expect(result.results?.[0]?.calibration.status).toBe("skipped");
    expect(result.results?.[0]?.lifecycle.status).toBe("success");
    expect(result.results?.[0]?.decisions.status).toBe("success");
    expect(lifecycleJob.runLifecycleJob).toHaveBeenCalledWith({
      businessId: "biz_1",
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T03:10:00.000Z",
    });
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalledWith({
      businessId: "biz_1",
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T03:10:00.000Z",
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[1]).toEqual([
      "biz_1",
      "2026-05-07",
      expect.any(String),
      "engine_v3_calibration_job",
      "2026-05-08T03:10:00.000Z",
    ]);
    expect(query.mock.calls[2]?.[0]).toContain(
      "error_json#>>'{metadata,evaluation_cutoff_at}' = $5::text",
    );
  });

  it("does not borrow a prior-cutoff calibration success for a repaired source retry", async () => {
    const query = vi.fn().mockResolvedValueOnce(providerDays)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ exists: false }]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);
    vi.mocked(calibrationJob.runCalibrationJob).mockResolvedValueOnce({
      jobRunId: "skipped-calibration-run", status: "skipped", rowsWritten: 0,
      durationMs: 1, calibration: null,
      errorMessage: "Advisory lock not acquired (job may already be running)",
    } as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"), [{ id: "biz_1", name: null }],
    );
    expect(result.results?.[0]?.decisions.errorMessage).toBe(
      "upstream_calibration_not_success",
    );
    expect(lifecycleJob.runLifecycleJob).not.toHaveBeenCalled();
    expect(decisionsJob.runDecisionsJob).not.toHaveBeenCalled();
    expect(query.mock.calls[2]?.[1]?.[4]).toBe("2026-05-08T03:10:00.000Z");
  });

  it("skips decisions for a business when lifecycle fails but continues the batch", async () => {
    vi.mocked(lifecycleJob.runLifecycleJob)
      .mockRejectedValueOnce(new Error("lifecycle failed"))
      .mockResolvedValueOnce(successLifecycle as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [
        { id: "biz_1", name: null },
        { id: "biz_2", name: null },
      ],
    );

    expect(result.skipped).toBe(false);
    expect(result.results?.[0]?.calibration.status).toBe("success");
    expect(result.results?.[0]?.lifecycle.status).toBe("failed");
    expect(result.results?.[0]?.lifecycle.errorMessage).toBe(
      "lifecycle failed",
    );
    expect(result.results?.[0]?.decisions.status).toBe("skipped");
    expect(result.results?.[0]?.decisions.errorMessage).toBe(
      "upstream_lifecycle_not_success",
    );
    expect(result.results?.[1]?.decisions.status).toBe("success");
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalledTimes(1);
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalledWith({
      businessId: "biz_2",
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T03:10:00.000Z",
    });
  });

  it("continues decisions when lifecycle skips but the same-day success already exists", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(providerDays)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ exists: true }]);
    vi.mocked(db.getDb).mockReturnValue({ query } as never);
    vi.mocked(lifecycleJob.runLifecycleJob).mockResolvedValueOnce({
      jobRunId: "skipped-lifecycle-run",
      dependencyRunId: "calibration-run",
      status: "skipped",
      rowsWritten: 0,
      durationMs: 1,
      errorMessage: "Advisory lock not acquired (job may already be running)",
    } as never);

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [{ id: "biz_1", name: null }],
    );

    expect(result.skipped).toBe(false);
    expect(result.results?.[0]?.lifecycle.status).toBe("skipped");
    expect(result.results?.[0]?.decisions.status).toBe("success");
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalledWith({
      businessId: "biz_1",
      asOf: "2026-05-07",
      evaluationCutoffAt: "2026-05-08T03:10:00.000Z",
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[1]).toEqual([
      "biz_1",
      "2026-05-07",
      expect.any(String),
      "engine_v3_lifecycle_job",
      "2026-05-08T03:10:00.000Z",
    ]);
  });

  it("retries a partial lifecycle failure on the next tick before marking the business complete", async () => {
    vi.mocked(lifecycleJob.runLifecycleJob).mockRejectedValueOnce(
      new Error("lifecycle failed"),
    );

    const first = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
      [{ id: "biz_1", name: null }],
    );
    const second = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:20:00.000Z"),
      [{ id: "biz_1", name: null }],
    );

    expect(first.skipped).toBe(false);
    expect(first.results?.[0]?.lifecycle.status).toBe("failed");
    expect(first.results?.[0]?.decisions.status).toBe("skipped");
    expect(second.skipped).toBe(false);
    expect(second.results?.[0]?.calibration.status).toBe("success");
    expect(second.results?.[0]?.lifecycle.status).toBe("success");
    expect(second.results?.[0]?.decisions.status).toBe("success");
    expect(calibrationJob.runCalibrationJob).toHaveBeenCalledTimes(2);
    expect(lifecycleJob.runLifecycleJob).toHaveBeenCalledTimes(2);
    expect(decisionsJob.runDecisionsJob).toHaveBeenCalledTimes(1);
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

  it("runs campaign context first and does not gate the chain on its failure", async () => {
    const order: string[] = [];
    vi.mocked(campaignContextJob.runCampaignContextJob).mockImplementation(
      async () => {
        order.push("campaign_context");
        return {
          jobRunId: "",
          status: "failed",
          rowsWritten: 0,
          durationMs: 1,
          errorMessage: "context boom",
        } as never;
      },
    );
    vi.mocked(calibrationJob.runCalibrationJob).mockImplementation(async () => {
      order.push("calibration");
      return successCalibration as never;
    });
    vi.mocked(lifecycleJob.runLifecycleJob).mockImplementation(async () => {
      order.push("lifecycle");
      return successLifecycle as never;
    });
    vi.mocked(decisionsJob.runDecisionsJob).mockImplementation(async () => {
      order.push("decisions");
      return successDecisions as never;
    });

    const result = await runEngineV3ProducerChainForActiveBusinessesIfDue(
      new Date("2026-05-08T03:10:00.000Z"),
    );

    expect(result.skipped).toBe(false);
    expect(order.slice(0, 4)).toEqual([
      "campaign_context",
      "calibration",
      "lifecycle",
      "decisions",
    ]);
    const first = result.results?.[0];
    expect(first?.campaignContext?.status).toBe("failed");
    expect(first?.decisions.status).toBe("success");
  });
});
