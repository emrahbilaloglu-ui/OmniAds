import { beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.fn();
const getDbWithTimeout = vi.fn();
const assertDbSchemaReady = vi.fn();
const getDbSchemaReadiness = vi.fn();
const acquireSyncRunnerLease = vi.fn();
const releaseSyncRunnerLease = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb,
  getDbWithTimeout,
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady,
  getDbSchemaReadiness,
}));

vi.mock("@/lib/sync/worker-health", () => ({
  acquireSyncRunnerLease,
  releaseSyncRunnerLease,
}));

const retention = await import("@/lib/google-ads/warehouse-retention");

describe("Google Ads warehouse retention policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.GOOGLE_ADS_RETENTION_EXECUTION_ENABLED;
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    delete process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
    delete process.env.GOOGLE_ADS_RETENTION_BATCH_SIZE;
    delete process.env.GOOGLE_ADS_RETENTION_LEASE_MINUTES;
    delete process.env.GOOGLE_ADS_RETENTION_QUERY_TIMEOUT_MS;
    vi.mocked(assertDbSchemaReady).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-10T00:00:00.000Z",
    });
    vi.mocked(getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: [],
      checkedAt: "2026-04-10T00:00:00.000Z",
    });
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(true);
    vi.mocked(releaseSyncRunnerLease).mockResolvedValue(undefined);
  });

  it("uses the approved retention tiers", () => {
    expect(retention.GOOGLE_ADS_RETENTION_POLICY.core_daily.retentionDays).toBeGreaterThan(700);
    expect(retention.GOOGLE_ADS_RETENTION_POLICY.breakdown_daily.retentionDays).toBeGreaterThan(390);
    expect(retention.GOOGLE_ADS_RETENTION_POLICY.creative_daily.retentionDays).toBe(180);
    expect(retention.GOOGLE_ADS_RETENTION_POLICY.raw_search_terms_hot.retentionDays).toBe(120);
    expect(retention.GOOGLE_ADS_RETENTION_POLICY.top_queries_weekly.retentionDays).toBe(365);
    expect(retention.GOOGLE_ADS_RETENTION_POLICY.advisor_execution_log.retentionDays).toBe(30);
    expect(retention.GOOGLE_ADS_RETENTION_POLICY.raw_search_terms_hot.tableNames).toEqual(
      expect.arrayContaining([
        "google_ads_search_query_hot_daily",
        "google_ads_search_term_daily",
      ])
    );
  });

  it("keeps retention execution disabled by default and produces a dry run", async () => {
    expect(retention.isGoogleAdsRetentionExecutionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      retention.getGoogleAdsRetentionRuntimeStatus({} as NodeJS.ProcessEnv)
    ).toMatchObject({
      runtimeAvailable: false,
      executionEnabled: false,
      mode: "dry_run",
    });

    const result = await retention.executeGoogleAdsRetentionPolicyDryRunOnly({
      asOfDate: "2026-04-08",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.executionEnabled).toBe(false);
    expect(result.dryRun).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "raw_search_terms_hot",
          tableName: "google_ads_search_query_hot_daily",
          executionEnabled: false,
          observed: false,
        }),
      ])
    );
  });

  it("inspects dry-run candidate stats when runtime access is available", async () => {
    process.env.DATABASE_URL = "postgres://example";
    const sqlQuery = vi.fn(async (query: string) => {
      if (query.includes("eligible_rows")) {
        return [
          {
            eligible_rows: 7,
            oldest_eligible_value: "2025-01-01",
            newest_eligible_value: "2025-12-11",
            retained_rows: 21,
            latest_retained_value: "2026-04-08",
          },
        ];
      }
      return [];
    });
    getDbWithTimeout.mockReturnValue({ query: sqlQuery } as never);

    const result = await retention.executeGoogleAdsRetentionPolicyDryRunOnly({
      asOfDate: "2026-04-08",
    });

    expect(result.dryRun).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "google_ads_search_term_daily",
          mode: "dry_run",
          observed: true,
          eligibleRows: 7,
          retainedRows: 21,
          oldestEligibleValue: "2025-01-01",
          latestRetainedValue: "2026-04-08",
        }),
      ])
    );
  });

  it("builds cutoff dates for every retention table", () => {
    const rows = retention.buildGoogleAdsRetentionDryRun("2026-04-08");

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "google_ads_top_query_weekly",
          cutoffDate: "2025-04-08",
        }),
        expect.objectContaining({
          tableName: "google_ads_search_term_daily",
          cutoffDate: "2025-12-09",
        }),
        expect.objectContaining({
          tableName: "google_ads_advisor_execution_logs",
          cutoffDate: "2026-03-09",
          dateColumn: "created_at",
          executionEnabled: false,
        }),
        expect.objectContaining({
          tableName: "google_ads_decision_action_outcome_logs",
          executionEnabled: false,
        }),
      ])
    );
  });

  it("skips runtime execution when another retention lease is active", async () => {
    process.env.DATABASE_URL = "postgres://example";
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(false);
    getDbWithTimeout.mockReturnValue({ query: vi.fn() } as never);

    const result = await retention.executeGoogleAdsRetentionPolicy({
      asOfDate: "2026-04-10",
    });

    expect(result).toMatchObject({
      mode: "dry_run",
      skippedDueToActiveLease: true,
      totalDeletedRows: 0,
    });
    expect(getDbWithTimeout).toHaveBeenCalledTimes(1);
    expect(releaseSyncRunnerLease).not.toHaveBeenCalled();
  });

  it("deletes retained rows in batches when execution is enabled and records a run", async () => {
    process.env.DATABASE_URL = "postgres://example";
    process.env.GOOGLE_ADS_RETENTION_EXECUTION_ENABLED = "true";
    // Execution now requires the retention LANE as the outer admission; the
    // per-provider flag alone can no longer delete.
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = "enabled";
    process.env.GOOGLE_ADS_RETENTION_BATCH_SIZE = "2";
    vi.mocked(getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-10T00:00:00.000Z",
    });

    let deleteCallCount = 0;
    const sqlQuery = vi.fn(async (query: string) => {
      if (query.includes("eligible_rows")) {
        return [
          {
            eligible_rows: 3,
            oldest_eligible_value: "2025-01-01",
            newest_eligible_value: "2025-12-11",
            retained_rows: 12,
            latest_retained_value: "2026-04-10",
          },
        ];
      }
      if (query.includes("WITH candidates")) {
        deleteCallCount += 1;
        if (deleteCallCount === 1) return [{ count: 2 }];
        if (deleteCallCount === 2) return [{ count: 1 }];
        return [{ count: 0 }];
      }
      return [{ count: 0 }];
    });
    getDbWithTimeout.mockReturnValue({ query: sqlQuery } as never);
    getDb.mockReturnValue(
      Object.assign(
        vi.fn(async () => [{ id: "run_1" }]),
        { query: vi.fn(async () => []) }
      ) as never
    );

    const result = await retention.executeGoogleAdsRetentionPolicy({
      asOfDate: "2026-04-10",
    });

    expect(result).toMatchObject({
      runId: "run_1",
      mode: "execute",
      executionEnabled: true,
      skippedDueToActiveLease: false,
      totalDeletedRows: 3,
    });
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "google_ads_account_daily",
          deletedRows: 3,
          mode: "execute",
          observed: true,
          eligibleRows: 3,
          retainedRows: 12,
        }),
      ])
    );
    expect(sqlQuery).toHaveBeenCalled();
    expect(releaseSyncRunnerLease).toHaveBeenCalledTimes(1);
  });

  it("parses recorded retention rows for status and product-gate surfaces", () => {
    const rows = retention.getGoogleAdsRetentionRunRows({
      summaryJson: {
        rows: [
          {
            tier: "raw_search_terms_hot",
            label: "Raw search terms daily hot",
            tableName: "google_ads_search_term_daily",
            retentionDays: 120,
            cutoffDate: "2025-12-11",
            executionEnabled: false,
            grain: "daily",
            storageTemperature: "hot",
            mode: "dry_run",
            observed: true,
            eligibleRows: 9,
            oldestEligibleValue: "2025-01-01",
            newestEligibleValue: "2025-12-10",
            retainedRows: 14,
            latestRetainedValue: "2026-04-10",
            deletedRows: 0,
          },
        ],
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        tableName: "google_ads_search_term_daily",
        observed: true,
        eligibleRows: 9,
        retainedRows: 14,
        mode: "dry_run",
      }),
    ]);
  });

  it("deletes nothing when the retention lane is off, whatever else is set", async () => {
    // Same contract as the Meta policy: the worker loop invokes this directly
    // under GOOGLE_ADS_RETENTION_EXECUTION_ENABLED, so the lane has to sit
    // outside that flag and outside forceExecute for "lane off stops all
    // deletion" to be true.
    const sqlQuery = vi.fn(async () => [{ count: 0 }]);
    getDbWithTimeout.mockReturnValue({ query: sqlQuery } as never);

    for (const env of [
      {
        DATABASE_URL: "postgres://example",
        GOOGLE_ADS_RETENTION_EXECUTION_ENABLED: "true",
      },
      {
        DATABASE_URL: "postgres://example",
        GOOGLE_ADS_RETENTION_EXECUTION_ENABLED: "true",
        ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
        ADSECUTE_SYNC_LANE_RETENTION_ENABLED: "off",
      },
    ]) {
      const result = await retention.executeGoogleAdsRetentionPolicy({
        asOfDate: "2026-04-13",
        forceExecute: true,
        env: env as unknown as NodeJS.ProcessEnv,
      });
      expect(result.mode).toBe("dry_run");
      const issued = sqlQuery.mock.calls.map(([text]) => String(text));
      expect(issued.some((text) => /DELETE\s+FROM/i.test(text))).toBe(false);
    }
  });
});
