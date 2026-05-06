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
    dbMocks.query.mockImplementation(async (queryText: string) => {
      if (queryText.includes("business_engine_v3_flags")) {
        return [];
      }
      if (queryText.includes("pg_try_advisory_xact_lock")) {
        return [{ acquired: true }];
      }
      if (
        queryText.includes("SELECT id") &&
        queryText.includes("engine_v3_job_runs")
      ) {
        return [];
      }
      if (queryText.includes("INSERT INTO engine_v3_job_runs")) {
        return [{ id: jobRunId }];
      }
      if (queryText.includes("SAVEPOINT")) return [];
      if (queryText.includes("WITH selected_creatives AS")) {
        throw new Error("simulated lifecycle failure");
      }
      if (queryText.includes("business_target_packs")) return [];
      if (queryText.includes("business_decision_calibration_profiles")) {
        return [];
      }
      if (
        queryText.includes("engine_v3_account_calibration_daily") &&
        queryText.includes("creative_format,")
      ) {
        return [];
      }
      if (queryText.includes("engine_v3_account_calibration_daily")) {
        return [
          {
            business_ref_id: "00000000-0000-4000-8000-000000000499",
            engine_version: "v3-2026-05-04-phase-3.9",
            mature_creative_count: 35,
            roas_p75: 2.4,
            roas_p60: 1.9,
            refresh_ratio_p10: 0.82,
            low_ctr_p10: 0.7,
            account_cpa_p50: 58,
            account_cpa_sample_count: 24,
            meta_attributed_aov_mean_90d: 50,
            meta_attributed_aov_purchase_count_90d: 42,
            meta_attributed_revenue_90d: 2100,
            meta_aov_quality: "ready",
            mature_spend_p50: 300,
            mature_spend_p75: 450,
            winner_spend_p25: 250,
            winner_spend_p50: 500,
            winner_purchase_p50: 5,
            roas_ratio_p10: 0.4,
            roas_ratio_p25: 0.6,
            roas_ratio_p50: 1,
            roas_ratio_p75: 1.35,
            computed_at: new Date().toISOString(),
            source_max_updated_at: new Date().toISOString(),
            source_max_date: "2026-05-04",
            as_of_date: "2026-05-04",
            quality_status: "ready",
          },
        ];
      }
      if (queryText.includes("ROLLBACK TO SAVEPOINT")) return [];
      if (queryText.includes("UPDATE engine_v3_job_runs")) return [];
      return [];
    });

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
