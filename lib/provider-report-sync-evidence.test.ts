import { describe, expect, it } from "vitest";

import {
  PROVIDER_REPORT_SYNC_JOB_STUCK_MS,
  isProviderReportSyncJobInFlight,
  type ProviderReportSyncJob,
} from "@/lib/provider-report-sync-evidence";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function job(overrides: Partial<ProviderReportSyncJob>): ProviderReportSyncJob {
  return {
    status: "running",
    triggeredAt: new Date(NOW - 60_000).toISOString(),
    startedAt: new Date(NOW - 60_000).toISOString(),
    completedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("isProviderReportSyncJobInFlight", () => {
  it("matches the fifteen-minute boundary the operations surface already uses", () => {
    expect(PROVIDER_REPORT_SYNC_JOB_STUCK_MS).toBe(15 * 60_000);
  });

  it("counts a freshly triggered running job as in flight", () => {
    expect(isProviderReportSyncJobInFlight(job({}), NOW)).toBe(true);
  });

  it("still counts a job triggered exactly on the boundary", () => {
    const triggeredAt = new Date(
      NOW - PROVIDER_REPORT_SYNC_JOB_STUCK_MS,
    ).toISOString();
    expect(isProviderReportSyncJobInFlight(job({ triggeredAt }), NOW)).toBe(true);
  });

  it("refuses a running job that has sat past the boundary", () => {
    const triggeredAt = new Date(
      NOW - PROVIDER_REPORT_SYNC_JOB_STUCK_MS - 1,
    ).toISOString();
    expect(isProviderReportSyncJobInFlight(job({ triggeredAt }), NOW)).toBe(false);
  });

  it("refuses every terminal status", () => {
    for (const status of ["done", "failed", "pending", ""]) {
      expect(isProviderReportSyncJobInFlight(job({ status }), NOW)).toBe(false);
    }
  });

  it("refuses a job with no usable trigger time, and a missing job", () => {
    expect(isProviderReportSyncJobInFlight(job({ triggeredAt: null }), NOW)).toBe(
      false,
    );
    expect(
      isProviderReportSyncJobInFlight(job({ triggeredAt: "not a date" }), NOW),
    ).toBe(false);
    expect(isProviderReportSyncJobInFlight(null, NOW)).toBe(false);
  });
});
