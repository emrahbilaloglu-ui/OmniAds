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

const retention = await import("@/lib/meta/warehouse-retention");

describe("Meta warehouse retention policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.META_RETENTION_EXECUTION_ENABLED;
    delete process.env.META_RETENTION_BATCH_SIZE;
    delete process.env.META_RETENTION_LEASE_MINUTES;
    delete process.env.META_RETENTION_QUERY_TIMEOUT_MS;
    vi.mocked(assertDbSchemaReady).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-13T00:00:00.000Z",
    });
    vi.mocked(getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: [],
      checkedAt: "2026-04-13T00:00:00.000Z",
    });
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(true);
    vi.mocked(releaseSyncRunnerLease).mockResolvedValue(undefined);
  });

  it("uses the approved authoritative retention tiers", () => {
    const policy = retention.META_RETENTION_POLICY;
    expect(
      policy.filter((entry) => entry.tier === "core_authoritative"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_account_daily",
          retentionDays: 761,
        }),
        expect.objectContaining({
          tableName: "meta_authoritative_day_state",
          summaryKey: "meta_authoritative_day_state:core",
        }),
      ]),
    );
    expect(
      policy.filter((entry) => entry.tier === "breakdown_authoritative"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_breakdown_daily",
          retentionDays: 394,
        }),
        expect.objectContaining({
          tableName: "meta_authoritative_publication_pointers",
          summaryKey: "meta_authoritative_publication_pointers:breakdown",
        }),
      ]),
    );
    expect(
      policy.filter((entry) => entry.tier === "creative_warehouse"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_creative_daily",
          retentionDays: 455,
        }),
      ]),
    );
    expect(
      policy.filter((entry) => entry.tier === "creative_media"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_creative_media",
          retentionDays: 90,
        }),
      ]),
    );
  });

  it("keeps retention execution disabled by default and produces a dry run", async () => {
    expect(retention.isMetaRetentionExecutionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      retention.getMetaRetentionRuntimeStatus({} as NodeJS.ProcessEnv),
    ).toMatchObject({
      runtimeAvailable: false,
      executionEnabled: false,
      mode: "dry_run",
    });

    const result = await retention.executeMetaRetentionPolicyDryRunOnly({
      asOfDate: "2026-04-13",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.executionEnabled).toBe(false);
    expect(result.dryRun).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Meta breakdown authoritative",
          tableName: "meta_breakdown_daily",
          cutoffDate: "2025-03-15",
          executionEnabled: false,
          observed: false,
        }),
        expect.objectContaining({
          summaryKey: "meta_authoritative_day_state:core",
          cutoffDate: "2024-03-13",
          protectedRows: null,
        }),
      ]),
    );
  });

  it("keeps scoped execute disabled until the global execution posture is enabled", () => {
    expect(
      retention.getMetaRetentionCanaryRuntimeStatus({
        businessId: "biz_keep",
        executeRequested: true,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toMatchObject({
      runtimeAvailable: false,
      globalExecutionEnabled: false,
      executeAllowed: false,
      mode: "dry_run",
    });

    const env = {
      DATABASE_URL: "postgres://example",
      META_RETENTION_EXECUTION_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv;

    expect(
      retention.getMetaRetentionCanaryRuntimeStatus({
        businessId: "biz_keep",
        executeRequested: true,
        env,
      }),
    ).toMatchObject({
      runtimeAvailable: true,
      globalExecutionEnabled: true,
      executeAllowed: true,
      mode: "execute",
    });
  });

  it("inspects deletable residue and protected published truth in dry-run mode", async () => {
    process.env.DATABASE_URL = "postgres://example";

    const sqlQuery = vi.fn(async (query: string, _params?: unknown[]) => {
      if (query.includes("FROM meta_account_daily")) {
        return [
          {
            eligible_rows: 12,
            eligible_distinct_days: 3,
            oldest_eligible_value: "2024-03-01",
            newest_eligible_value: "2024-03-12",
            retained_rows: 144,
            latest_retained_value: "2026-04-12",
            protected_rows: 8,
            protected_distinct_days: 2,
            latest_protected_value: "2026-04-12",
          },
        ];
      }
      if (query.includes("FROM meta_breakdown_daily")) {
        return [
          {
            eligible_rows: 4,
            eligible_distinct_days: 1,
            oldest_eligible_value: "2025-03-14",
            newest_eligible_value: "2025-03-14",
            retained_rows: 30,
            latest_retained_value: "2026-04-12",
            protected_rows: 6,
            protected_distinct_days: 2,
            latest_protected_value: "2026-04-12",
          },
        ];
      }
      return [
        {
          eligible_rows: 0,
          eligible_distinct_days: 0,
          oldest_eligible_value: null,
          newest_eligible_value: null,
          retained_rows: 0,
          latest_retained_value: null,
          protected_rows: 0,
          protected_distinct_days: 0,
          latest_protected_value: null,
        },
      ];
    });
    getDbWithTimeout.mockReturnValue({ query: sqlQuery } as never);

    const result = await retention.executeMetaRetentionPolicyDryRunOnly({
      asOfDate: "2026-04-13",
    });

    expect(result.executionEnabled).toBe(false);
    expect(result.dryRun).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_account_daily",
          retentionDays: 761,
          cutoffDate: "2024-03-13",
          observed: true,
          eligibleRows: 12,
          eligibleDistinctDays: 3,
          retainedRows: 144,
          protectedRows: 8,
          latestProtectedValue: "2026-04-12",
        }),
        expect.objectContaining({
          tableName: "meta_breakdown_daily",
          retentionDays: 394,
          cutoffDate: "2025-03-15",
          observed: true,
          eligibleRows: 4,
          newestEligibleValue: "2025-03-14",
          protectedRows: 6,
        }),
      ]),
    );
  });

  it("aggregates live Meta protected published truth classes from rebuilt data", async () => {
    process.env.DATABASE_URL = "postgres://example";

    const sqlQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM meta_account_daily")) {
        return [{ protected_rows: 12, latest_protected_value: "2026-04-12" }];
      }
      if (query.includes("FROM meta_campaign_daily")) {
        return [{ protected_rows: 8, latest_protected_value: "2026-04-12" }];
      }
      if (query.includes("FROM meta_adset_daily")) {
        return [{ protected_rows: 4, latest_protected_value: "2026-04-11" }];
      }
      if (query.includes("FROM meta_ad_daily")) {
        return [{ protected_rows: 0, latest_protected_value: null }];
      }
      if (query.includes("FROM meta_breakdown_daily")) {
        return [{ protected_rows: 6, latest_protected_value: "2026-04-10" }];
      }
      if (query.includes("FROM meta_authoritative_publication_pointers")) {
        return [{ protected_rows: 5, latest_protected_value: "2026-04-12" }];
      }
      if (query.includes("FROM meta_authoritative_slice_versions")) {
        return [{ protected_rows: 5, latest_protected_value: "2026-04-12" }];
      }
      if (query.includes("FROM meta_authoritative_source_manifests")) {
        return [{ protected_rows: 3, latest_protected_value: "2026-04-12" }];
      }
      if (query.includes("FROM meta_authoritative_day_state")) {
        return [{ protected_rows: 2, latest_protected_value: "2026-04-12" }];
      }
      return [{ protected_rows: 0, latest_protected_value: null }];
    });
    getDbWithTimeout.mockReturnValue({ query: sqlQuery } as never);

    const review = await retention.getMetaProtectedPublishedTruthReview({
      asOfDate: "2026-04-13",
      businessIds: ["biz_truth"],
    });

    expect(review).toMatchObject({
      runtimeAvailable: true,
      scope: {
        kind: "selected_businesses",
        businessIds: ["biz_truth"],
      },
      hasNonZeroProtectedPublishedRows: true,
      protectedPublishedRows: 30,
      activePublicationPointerRows: 10,
    });
    expect(review.protectedTruthClassesPresent).toEqual(
      expect.arrayContaining([
        "core_daily_rows",
        "breakdown_daily_rows",
        "active_publication_pointers",
        "active_published_slice_versions",
        "active_source_manifests",
        "published_day_state",
      ]),
    );
  });

  it("reports Meta protected published truth as unavailable when the runtime is missing", async () => {
    const review = await retention.getMetaProtectedPublishedTruthReview({
      asOfDate: "2026-04-13",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(review).toMatchObject({
      runtimeAvailable: false,
      hasNonZeroProtectedPublishedRows: false,
      protectedPublishedRows: 0,
      activePublicationPointerRows: 0,
    });
    expect(review.protectedTruthClassesPresent).toEqual([]);
  });

  it("skips runtime execution when another retention lease is active", async () => {
    process.env.DATABASE_URL = "postgres://example";
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(false);
    getDbWithTimeout.mockReturnValue({ query: vi.fn() } as never);

    const result = await retention.executeMetaRetentionPolicy({
      asOfDate: "2026-04-13",
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
    process.env.META_RETENTION_EXECUTION_ENABLED = "true";
    process.env.META_RETENTION_BATCH_SIZE = "2";
    vi.mocked(getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-13T00:00:00.000Z",
    });

    const deleteCounts = [2, 1, 0];
    const sqlQuery = vi.fn(async (query: string) => {
      if (query.includes("eligible_rows")) {
        if (query.includes("FROM meta_account_daily")) {
          return [
            {
              eligible_rows: 3,
              eligible_distinct_days: 1,
              oldest_eligible_value: "2024-03-10",
              newest_eligible_value: "2024-03-12",
              retained_rows: 25,
              latest_retained_value: "2026-04-12",
              protected_rows: 4,
              protected_distinct_days: 1,
              latest_protected_value: "2026-04-12",
            },
          ];
        }
        return [
          {
            eligible_rows: 0,
            eligible_distinct_days: 0,
            oldest_eligible_value: null,
            newest_eligible_value: null,
            retained_rows: 0,
            latest_retained_value: null,
            protected_rows: 0,
            protected_distinct_days: 0,
            latest_protected_value: null,
          },
        ];
      }
      return [{ count: deleteCounts.shift() ?? 0 }];
    });
    getDbWithTimeout.mockReturnValue({ query: sqlQuery } as never);
    getDb.mockReturnValue(
      Object.assign(
        vi.fn(async () => [{ id: "meta_retention_run_1" }]),
        { query: vi.fn(async () => []) },
      ) as never,
    );

    const result = await retention.executeMetaRetentionPolicy({
      asOfDate: "2026-04-13",
    });

    expect(result).toMatchObject({
      runId: "meta_retention_run_1",
      mode: "execute",
      executionEnabled: true,
      skippedDueToActiveLease: false,
      totalDeletedRows: 3,
    });
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Meta core daily authoritative",
          tableName: "meta_account_daily",
          observed: true,
          eligibleRows: 3,
          protectedRows: 4,
          deletedRows: 3,
          mode: "execute",
        }),
      ]),
    );
    expect(sqlQuery).toHaveBeenCalled();
    expect(releaseSyncRunnerLease).toHaveBeenCalledTimes(1);
  });

  it("scopes execute verification to one business and preserves active published artifacts", async () => {
    process.env.DATABASE_URL = "postgres://example";

    const sqlQuery = vi.fn(async (query: string) => {
      if (query.includes("eligible_rows")) {
        return [
          {
            eligible_rows: 0,
            eligible_distinct_days: 0,
            oldest_eligible_value: null,
            newest_eligible_value: null,
            retained_rows: 4,
            latest_retained_value: "2026-04-12",
            protected_rows: 4,
            protected_distinct_days: 1,
            latest_protected_value: "2026-04-12",
          },
        ];
      }
      return [{ count: 0 }];
    });
    getDbWithTimeout.mockReturnValue({ query: sqlQuery } as never);

    const canary = retention.getMetaRetentionCanaryRuntimeStatus({
      businessId: "biz_canary",
      executeRequested: true,
      env: {
        DATABASE_URL: "postgres://example",
        META_RETENTION_EXECUTION_ENABLED: "true",
      } as unknown as NodeJS.ProcessEnv,
    });

    const result = await retention.executeMetaRetentionPolicy({
      asOfDate: "2026-04-13",
      businessIds: ["biz_canary"],
      forceExecute: canary.executeAllowed,
      executionDisposition: "scoped_execute",
      canary,
    });

    expect(result).toMatchObject({
      mode: "execute",
      executionDisposition: "scoped_execute",
      scope: {
        kind: "selected_businesses",
        businessIds: ["biz_canary"],
      },
      totalDeletedRows: 0,
    });

    const accountDeleteCall = sqlQuery.mock.calls.find(([query]) =>
      String(query).includes("DELETE FROM meta_account_daily"),
    );
    expect(accountDeleteCall?.[0]).toContain(
      "AND ($2::text[] IS NULL OR business_id = ANY($2::text[]))",
    );
    expect((accountDeleteCall as [string, unknown[]] | undefined)?.[1]).toEqual([
      "2024-03-13",
      ["biz_canary"],
      250,
    ]);

    const sliceDeleteCall = sqlQuery.mock.calls.find(([query]) =>
      String(query).includes("DELETE FROM meta_authoritative_slice_versions"),
    );
    expect(sliceDeleteCall?.[0]).toContain("pointer.active_slice_version_id = slice.id");
    expect(sliceDeleteCall?.[0]).toContain("AND pointer.id IS NULL");
    expect(sliceDeleteCall?.[0]).toContain(
      "AND ($3::text[] IS NULL OR slice.business_id = ANY($3::text[]))",
    );
    expect(sliceDeleteCall?.[0]).toContain("FOR UPDATE OF slice SKIP LOCKED");

    const manifestDeleteCall = sqlQuery.mock.calls.find(([query]) =>
      String(query).includes("DELETE FROM meta_authoritative_source_manifests"),
    );
    expect(manifestDeleteCall?.[0]).toContain("slice.manifest_id = manifest.id");
    expect(manifestDeleteCall?.[0]).toContain("AND slice.id IS NULL");
    expect(manifestDeleteCall?.[0]).toContain(
      "AND ($3::text[] IS NULL OR manifest.business_id = ANY($3::text[]))",
    );
    expect(manifestDeleteCall?.[0]).toContain("FOR UPDATE OF manifest SKIP LOCKED");
  });

  it("parses and summarizes recorded retention rows for operator surfaces", () => {
    const rows = retention.getMetaRetentionRunRows({
      summaryJson: {
        rows: [
          {
            tier: "core_authoritative",
            label: "Meta core daily authoritative",
            tableName: "meta_account_daily",
            summaryKey: "meta_account_daily",
            retentionDays: 761,
            cutoffDate: "2024-03-13",
            executionEnabled: false,
            mode: "dry_run",
            observed: true,
            eligibleRows: 12,
            eligibleDistinctDays: 3,
            oldestEligibleValue: "2024-03-01",
            newestEligibleValue: "2024-03-12",
            retainedRows: 144,
            latestRetainedValue: "2026-04-12",
            protectedRows: 8,
            protectedDistinctDays: 2,
            latestProtectedValue: "2026-04-12",
            deletedRows: 0,
          },
          {
            tier: "breakdown_authoritative",
            label: "Meta breakdown authoritative",
            tableName: "meta_breakdown_daily",
            summaryKey: "meta_breakdown_daily",
            retentionDays: 394,
            cutoffDate: "2025-03-15",
            executionEnabled: false,
            mode: "dry_run",
            observed: true,
            eligibleRows: 4,
            eligibleDistinctDays: 1,
            oldestEligibleValue: "2025-03-14",
            newestEligibleValue: "2025-03-14",
            retainedRows: 30,
            latestRetainedValue: "2026-04-12",
            protectedRows: 6,
            protectedDistinctDays: 2,
            latestProtectedValue: "2026-04-12",
            deletedRows: 0,
          },
        ],
      },
    });

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_account_daily",
          eligibleRows: 12,
          protectedRows: 8,
        }),
        expect.objectContaining({
          tableName: "meta_breakdown_daily",
          retentionDays: 394,
        }),
      ]),
    );
    expect(retention.summarizeMetaRetentionRunRows(rows)).toEqual({
      observedTables: 2,
      tablesWithDeletableRows: 2,
      tablesWithProtectedRows: 2,
      deletableRows: 16,
      retainedRows: 174,
      protectedRows: 14,
    });
  });

  it("parses recorded scoped execute metadata for operator surfaces", () => {
    expect(
      retention.getMetaRetentionRunMetadata({
        executionMode: "execute",
        summaryJson: {
          scope: {
            kind: "selected_businesses",
            businessIds: ["biz_canary"],
          },
          executionDisposition: "scoped_execute",
          canary: {
            runtimeAvailable: true,
            globalExecutionEnabled: true,
            businessId: "biz_canary",
            executeRequested: true,
            executeAllowed: true,
            mode: "execute",
            gateReason:
              "Meta retention execute mode is globally enabled. The scoped command will execute only the requested business slice.",
          },
        },
      }),
    ).toEqual({
      scope: {
        kind: "selected_businesses",
        businessIds: ["biz_canary"],
      },
      executionDisposition: "scoped_execute",
      canary: expect.objectContaining({
        businessId: "biz_canary",
        executeAllowed: true,
        mode: "execute",
      }),
    });
  });
});
