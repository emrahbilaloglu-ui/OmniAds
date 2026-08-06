import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dedupeGoogleAdsWarehouseRows } from "@/lib/google-ads/warehouse";
import type { GoogleAdsWarehouseDailyRow } from "@/lib/google-ads/warehouse-types";

function buildRow(
  overrides: Partial<GoogleAdsWarehouseDailyRow> = {},
): GoogleAdsWarehouseDailyRow {
  return {
    businessId: "biz_1",
    providerAccountId: "acct_1",
    date: "2026-03-30",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    entityKey: "entity_1",
    entityLabel: "Entity",
    campaignId: "cmp_1",
    campaignName: "Campaign",
    adGroupId: null,
    adGroupName: null,
    status: "enabled",
    channel: "search",
    classification: "brand",
    payloadJson: { source: "first" },
    spend: 1,
    revenue: 2,
    conversions: 3,
    impressions: 4,
    clicks: 5,
    ctr: 6,
    cpc: 7,
    cpa: 8,
    roas: 9,
    conversionRate: 10,
    interactionRate: 11,
    sourceSnapshotId: "snap_1",
    ...overrides,
  };
}

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  getDbWithTimeout: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  ensureProviderAccountReferenceIds: vi.fn(async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) => {
    return new Map(accounts.map((account) => [account.externalAccountId, `${account.externalAccountId}-ref`] as const));
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const));
  }),
}));

vi.mock("@/lib/sync/worker-health", () => ({
  recordSyncReclaimEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary: vi.fn() };
});

vi.mock("@/lib/google-ads/request-model-store", () => ({
  readGoogleAdsCampaignDimensions: vi.fn(async () => []),
  readGoogleAdsAdGroupDimensions: vi.fn(async () => []),
  readGoogleAdsAdDimensions: vi.fn(async () => []),
  readGoogleAdsKeywordDimensions: vi.fn(async () => []),
  readGoogleAdsAssetGroupDimensions: vi.fn(async () => []),
  readGoogleAdsProductDimensions: vi.fn(async () => []),
}));

const db = await import("@/lib/db");
const requestModelStore = await import("@/lib/google-ads/request-model-store");
const workerHealth = await import("@/lib/sync/worker-health");
const dbGrowthFence = await import("@/lib/sync/db-growth-fence");
const {
  acquireGoogleAdsRunnerLease,
  backfillGoogleAdsRunningCheckpointsForTerminalPartition,
  backfillGoogleAdsRunningRunsForTerminalPartition,
  cleanupGoogleAdsPartitionOrchestration,
  completeGoogleAdsPartitionAttempt,
  getGoogleAdsPartitionHealth,
  getGoogleAdsQueueHealth,
  getGoogleAdsAdvisorSurfacePartitionStates,
  getGoogleAdsWorkerDeadLetterBlockedReasonCodes,
  getGoogleAdsWarehouseIntegrityIncidents,
  hasGoogleAdsRepairableBlockingDeadLetters,
  hasRecentGoogleAdsTerminalActionRequiredDeadLetter,
  hasGoogleAdsThroughputBlockingDeadLetters,
  heartbeatGoogleAdsPartitionLease,
  leaseGoogleAdsSyncPartitions,
  markGoogleAdsPartitionRunning,
  persistGoogleAdsRawSnapshot,
  quarantineGoogleAdsTerminalActionRequiredPartitions,
  replayGoogleAdsDeadLetterPartitions,
  requeueGoogleAdsRetryableFailedPartitions,
  readGoogleAdsAggregatedRange,
  readGoogleAdsDailyRange,
  releaseGoogleAdsLeasedPartitionsForWorker,
  upsertGoogleAdsSyncCheckpoint,
  upsertGoogleAdsDailyRows,
  createGoogleAdsSyncJob,
  createGoogleAdsSyncRun,
  getGoogleAdsDailyCoverage,
  getLatestGoogleAdsSyncHealth,
  queueGoogleAdsSyncPartition,
  upsertGoogleAdsSyncState,
} = await import("@/lib/google-ads/warehouse");

describe("dedupeGoogleAdsWarehouseRows", () => {
  it("keeps the last conflicting row for a warehouse conflict key", () => {
    const rows = [
      buildRow({
        entityKey: "entity_1",
        payloadJson: { source: "first" },
        spend: 1,
      }),
      buildRow({
        entityKey: "entity_2",
        payloadJson: { source: "middle" },
        spend: 2,
      }),
      buildRow({
        entityKey: "entity_1",
        payloadJson: { source: "last" },
        spend: 99,
      }),
    ];

    const result = dedupeGoogleAdsWarehouseRows(rows);

    expect(result.duplicateCount).toBe(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.entityKey)).toEqual([
      "entity_2",
      "entity_1",
    ]);
    expect(result.rows.find((row) => row.entityKey === "entity_1")?.spend).toBe(
      99,
    );
    expect(
      result.rows.find((row) => row.entityKey === "entity_1")?.payloadJson,
    ).toEqual({
      source: "last",
    });
  });
});

describe("Google Ads dead-letter worker predicates", () => {
  it("does not throttle throughput for classified action-required extended dead letters", () => {
    const queueHealth = {
      deadLetterPartitions: 76,
      actionRequiredBlockingDeadLetterPartitions: 67,
      coreBlockingDeadLetterPartitions: 0,
      replayableBlockingDeadLetterPartitions: 0,
      unknownBlockingDeadLetterPartitions: 0,
    } as never;

    expect(hasGoogleAdsThroughputBlockingDeadLetters(queueHealth)).toBe(false);
    expect(hasGoogleAdsRepairableBlockingDeadLetters(queueHealth)).toBe(false);
    expect(getGoogleAdsWorkerDeadLetterBlockedReasonCodes(queueHealth)).toEqual([
      "action_required_extended_dead_letter",
    ]);
  });

  it("keeps the conservative throttle when dead-letter classification is unavailable", () => {
    const queueHealth = {
      deadLetterPartitions: 1,
    } as never;

    expect(hasGoogleAdsThroughputBlockingDeadLetters(queueHealth)).toBe(true);
    expect(hasGoogleAdsRepairableBlockingDeadLetters(queueHealth)).toBe(true);
    expect(getGoogleAdsWorkerDeadLetterBlockedReasonCodes(queueHealth)).toEqual([
      "required_dead_letter_partitions",
    ]);
  });

  it("treats core dead letters as throughput-blocking but not repairable backlog", () => {
    const queueHealth = {
      deadLetterPartitions: 1,
      coreBlockingDeadLetterPartitions: 1,
      replayableBlockingDeadLetterPartitions: 0,
      unknownBlockingDeadLetterPartitions: 0,
    } as never;

    expect(hasGoogleAdsThroughputBlockingDeadLetters(queueHealth)).toBe(true);
    expect(hasGoogleAdsRepairableBlockingDeadLetters(queueHealth)).toBe(false);
    expect(getGoogleAdsWorkerDeadLetterBlockedReasonCodes(queueHealth)).toEqual([
      "required_dead_letter_partitions",
    ]);
  });

  it("treats replayable and unknown dead letters as throughput-blocking repairable backlog", () => {
    const queueHealth = {
      deadLetterPartitions: 2,
      coreBlockingDeadLetterPartitions: 0,
      replayableBlockingDeadLetterPartitions: 1,
      unknownBlockingDeadLetterPartitions: 1,
    } as never;

    expect(hasGoogleAdsThroughputBlockingDeadLetters(queueHealth)).toBe(true);
    expect(hasGoogleAdsRepairableBlockingDeadLetters(queueHealth)).toBe(true);
    expect(getGoogleAdsWorkerDeadLetterBlockedReasonCodes(queueHealth)).toEqual([
      "required_dead_letter_partitions",
    ]);
  });

  it("returns no worker block reason when no classified blocking dead letters exist", () => {
    const queueHealth = {
      deadLetterPartitions: 0,
      actionRequiredBlockingDeadLetterPartitions: 0,
      coreBlockingDeadLetterPartitions: 0,
      replayableBlockingDeadLetterPartitions: 0,
      unknownBlockingDeadLetterPartitions: 0,
    } as never;

    expect(hasGoogleAdsThroughputBlockingDeadLetters(queueHealth)).toBe(false);
    expect(hasGoogleAdsRepairableBlockingDeadLetters(queueHealth)).toBe(false);
    expect(getGoogleAdsWorkerDeadLetterBlockedReasonCodes(queueHealth)).toEqual(
      [],
    );
  });
});

describe("getGoogleAdsDailyCoverage", () => {
  it("counts the union of warehouse dates and succeeded zero-row partition dates", async () => {
    const queryMock = vi.fn(async (query: string) => {
      if (query.includes("WITH covered_dates AS")) {
        return [
          {
            completed_days: 3,
            ready_through_date: "2026-04-03",
          },
        ];
      }
      return [];
    });
    const sql = Object.assign(vi.fn(), { query: queryMock });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const coverage = await getGoogleAdsDailyCoverage({
      businessId: "biz_1",
      providerAccountId: null,
      scope: "campaign_daily",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
    });

    expect(coverage).toEqual({
      completed_days: 3,
      ready_through_date: "2026-04-03",
      latest_updated_at: null,
      total_rows: 0,
    });
    expect(queryMock.mock.calls[0]?.[0]).toContain("UNION");
    expect(queryMock.mock.calls[0]?.[0]).toContain("google_ads_sync_partitions");
    const firstCall = queryMock.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[1]).toEqual([
      "biz_1",
      "2026-04-01",
      "2026-04-03",
      "campaign_daily",
    ]);
  });
});

describe("getLatestGoogleAdsSyncHealth", () => {
  it("derives run trigger source from the immutable run payload", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("FROM google_ads_sync_runs run")) return [];
      if (query.includes("FROM google_ads_sync_partitions")) return [];
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await getLatestGoogleAdsSyncHealth({
      businessId: "biz_1",
      providerAccountId: null,
    });

    const runQuery = queries.find((query) =>
      query.includes("FROM google_ads_sync_runs run"),
    );
    expect(runQuery).toBeTruthy();
    expect(runQuery).toContain("COALESCE(NULLIF(run.meta_json ->> 'source', ''), 'background_partition') AS trigger_source");
    expect(runQuery).not.toContain("JOIN google_ads_sync_partitions partition");
    expect(runQuery).not.toContain("source AS trigger_source");
  });
});

describe("getGoogleAdsWarehouseIntegrityIncidents", () => {
  it("reports account vs campaign mismatches with repair recommendations", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("WITH account_rows AS")) {
        return [
          {
            business_id: "biz_1",
            provider_account_id: "acct_1",
            date: "2026-04-01",
            account_spend: 0,
            account_impressions: 0,
            account_clicks: 0,
            account_row_count: 1,
            campaign_spend: 10,
            campaign_impressions: 100,
            campaign_clicks: 5,
            campaign_row_count: 2,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await getGoogleAdsWarehouseIntegrityIncidents({
      businessId: "biz_1",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
    });

    expect(result).toEqual([
      expect.objectContaining({
        businessId: "biz_1",
        providerAccountId: "acct_1",
        date: "2026-04-01",
        repairRecommended: true,
        suspectedCause: "account_campaign_drift",
        metricsCompared: expect.arrayContaining(["spend", "impressions", "clicks"]),
      }),
    ]);
  });
});

describe("google ads warehouse ownership safety", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerHealth.recordSyncReclaimEvents).mockResolvedValue(
      undefined,
    );
    // Dead-letter replay is a NEW-WORK transition and now requires the lane and
    // fresh capacity before it reads anything at all.
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("refuses replay entirely when the Google lane is disabled", async () => {
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    const sql = vi.fn();
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    await expect(
      replayGoogleAdsDeadLetterPartitions({ businessId: "biz-1" }),
    ).rejects.toMatchObject({ name: "SyncLaneDisabledError" });
    expect(sql).not.toHaveBeenCalled();
  });

  it("returns null when checkpoint upsert loses partition ownership", async () => {
    const sql = vi.fn().mockResolvedValue([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const checkpointId = await upsertGoogleAdsSyncCheckpoint({
      partitionId: "partition-1",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      checkpointScope: "campaign_daily",
      phase: "bulk_upsert",
      status: "running",
      pageIndex: 0,
      attemptCount: 1,
      leaseOwner: "worker-1",
      leaseEpoch: 7,
    });

    expect(checkpointId).toBeNull();
  });

  it("increments lease_epoch whenever a partition is leased", async () => {
    const queries: string[] = [];
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [
          {
            id: "partition-1",
            business_id: "biz-1",
            provider_account_id: "acct-1",
            lane: "core",
            scope: "campaign_daily",
            partition_date: "2026-04-04",
            status: "leased",
            priority: 10,
            source: "system",
            lease_epoch: 4,
            lease_owner: "worker-1",
            lease_expires_at: new Date().toISOString(),
            attempt_count: 0,
            next_retry_at: null,
            last_error: null,
            created_at: new Date().toISOString(),
            started_at: null,
            finished_at: null,
            updated_at: new Date().toISOString(),
          },
        ];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await leaseGoogleAdsSyncPartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 1,
    });

    expect(rows[0]?.leaseEpoch).toBe(4);
    expect(
      queries.some((query) => query.includes("lease_epoch = COALESCE(partition.lease_epoch, 0) + 1")),
    ).toBe(true);
  });

  it("releases leased Google Ads partitions owned by a worker after the worker exits", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [{ id: "partition-1" }, { id: "partition-2" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const released = await releaseGoogleAdsLeasedPartitionsForWorker({
      businessId: "biz-1",
      workerId: "worker-1",
      lastError: "worker_exit",
    });

    expect(released).toBe(2);
    const query = queries.join("\n");
    expect(query).toContain("status = 'failed'");
    expect(query).toContain("AND partition.lease_owner =");
    expect(query).toContain("AND partition.status = 'leased'");
  });

  it("prioritizes finalize_day ahead of today in recent leasing queries", async () => {
    const queries: string[] = [];
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await leaseGoogleAdsSyncPartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 1,
      sourceFilter: "recent_only",
    });

    const leaseQuery = queries.find((query) =>
      query.includes("FROM google_ads_sync_partitions"),
    );
    expect(leaseQuery).toContain("WHEN 'finalize_day' THEN 118");
    expect(leaseQuery).toContain("FROM provider_connections connection");
    expect(leaseQuery).toContain("connection.status = 'connected'");
    expect(leaseQuery).toContain("credential.access_token IS NOT NULL");
    expect(leaseQuery).toContain("lease.provider_scope = 'google_ads'");
    expect(leaseQuery).toContain("lease.lease_owner = $4");
    expect(leaseQuery).toContain(
      "source IN ('selected_range', 'finalize_day', 'today', 'recent', 'recent_recovery')",
    );
    expect(leaseQuery).toContain(
      "source = 'core_success'",
    );
    expect(leaseQuery).toContain(
      "partition_date >= CURRENT_DATE - interval '13 days'",
    );
  });

  it("excludes terminal action-required scopes from automatic leasing", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async (query: string, values: unknown[]) => {
        queries.push(query);
        params.push(values);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await leaseGoogleAdsSyncPartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 1,
      excludedScopeFilter: ["product_daily"],
    });

    expect(queries.join("\n")).toContain("OR NOT (scope = ANY($10::text[]))");
    expect(queries.join("\n")).toContain("action_partition.status = 'dead_letter'");
    // Account-wide gate: 24h window and no per-scope match, so one broken scope
    // blocks leasing across the whole account.
    //
    // The window is measured from the failing run, falling back to the row only
    // when no run exists. Keying it on the partition's own updated_at let any
    // housekeeping write pair a fresh timestamp with a months-old verdict and
    // hold the block open forever; production carried exactly that state. Both
    // halves are pinned here, so dropping the bound or reverting to the bare
    // row timestamp fails this test.
    expect(queries.join("\n")).toContain(
      "COALESCE(\n                latest_action_run.updated_at,\n                action_partition.updated_at\n              ) >= now() - interval '24 hours'",
    );
    expect(queries.join("\n")).not.toContain(
      "AND action_partition.updated_at >= now() - interval '24 hours'",
    );
    expect(queries.join("\n")).not.toContain(
      "action_partition.scope = google_ads_sync_partitions.scope",
    );
    expect(queries.join("\n")).toContain("latest_action_run.error_class");
    expect(params[0]?.at(9)).toEqual(["product_daily"]);
  });

  it("detects recent terminal action-required dead letters for a scope", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [
        {
          last_error:
            "google_ads_product_daily_fetch_failed: apiStatus=PERMISSION_DENIED: message=The caller does not have permission",
          error_class: "account_action_required",
          error_message:
            "PERMISSION_DENIED: The caller does not have permission",
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await hasRecentGoogleAdsTerminalActionRequiredDeadLetter({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      scope: "product_daily",
    });

    expect(result).toBe(true);
    expect(queries.join("\n")).toContain("partition.status = 'dead_letter'");
    expect(queries.join("\n")).toContain("partition.updated_at >= now() -");
  });

  it("does not treat retryable dead letters as terminal scope action required", async () => {
    const sql = vi.fn(async () => [
      {
        last_error: "RESOURCE_EXHAUSTED quota exceeded",
        error_class: "quota",
        error_message: "RESOURCE_EXHAUSTED quota exceeded",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      hasRecentGoogleAdsTerminalActionRequiredDeadLetter({
        businessId: "biz-1",
        providerAccountId: "acct-1",
        scope: "product_daily",
      }),
    ).resolves.toBe(false);
  });

  it("does not let scheduled enqueue resurrect terminal Google Ads action-required dead letters", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await queueGoogleAdsSyncPartition({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      lane: "extended",
      scope: "product_daily",
      partitionDate: "2026-04-01",
      status: "queued",
      priority: 1,
      source: "core_success",
      attemptCount: 0,
    });

    const query = queries.join("\n");
    expect(result).toBeNull();
    expect(query).toContain("WHERE NOT (");
    expect(query).toContain("google_ads_sync_partitions.status = 'dead_letter'");
    expect(query).toContain("google_ads_scope_action_required");
    expect(query).toContain("terminal_run.error_class IN");
  });

  it("allows the core historical recovery source to reset cancelled frontier partitions", async () => {
    const queries: string[] = [];
    const values: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      queries.push(strings.join(" "));
      values.push(params);
      return [{ id: "partition-1", status: "queued" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await queueGoogleAdsSyncPartition({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      lane: "core",
      scope: "campaign_daily",
      partitionDate: "2026-01-13",
      status: "queued",
      priority: 0,
      source: "core_historical_recovery",
      attemptCount: 0,
    });

    const resetSources = values
      .flat()
      .find((value): value is string[] => Array.isArray(value) && value.includes("core_historical_recovery"));
    const query = queries.join("\n");
    expect(result).toEqual({ id: "partition-1", status: "queued" });
    expect(resetSources).toContain("core_historical_recovery");
    expect(query).toContain("google_ads_sync_partitions.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')");
    expect(query).toContain("WHERE NOT (");
  });

  it("quarantines queued Google Ads terminal action-required partitions", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("UPDATE google_ads_sync_partitions partition")) {
        return [
          {
            id: "partition-permission",
            lane: "extended",
            scope: "product_daily",
            source: "core_success",
            partition_date: "2026-04-01",
            error_class: "account_action_required",
          },
        ];
      }
      return [
        {
          id: "partition-permission",
          lane: "extended",
          scope: "product_daily",
          source: "core_success",
          partition_date: "2026-04-01",
          last_error: null,
          error_class: "account_action_required",
          error_message:
            "google_ads_product_daily_fetch_failed: query=product_performance_legacy: message=provider_request_failed:permission:status_403",
        },
        {
          id: "partition-quota",
          lane: "extended",
          scope: "product_daily",
          source: "core_success",
          partition_date: "2026-04-02",
          last_error: "RESOURCE_EXHAUSTED quota exceeded",
          error_class: "quota",
          error_message: "RESOURCE_EXHAUSTED quota exceeded",
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await quarantineGoogleAdsTerminalActionRequiredPartitions({
      businessId: "biz-1",
    });

    expect(result).toMatchObject({
      candidateCount: 2,
      terminalMatchedCount: 1,
      changedCount: 1,
      partitions: [
        expect.objectContaining({
          id: "partition-permission",
          scope: "product_daily",
          source: "core_success",
        }),
      ],
    });
    expect(queries.some((query) => query.includes("partition.status IN ('queued', 'failed')"))).toBe(true);
    expect(queries.some((query) => query.includes("status = 'dead_letter'"))).toBe(true);
    expect(queries.some((query) => query.includes("next_retry_at = NULL"))).toBe(true);
  });

  it("requeues retryable failed Google Ads partitions without requeuing terminal action-required rows", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("UPDATE google_ads_sync_partitions partition")) {
        return [{ id: "partition-timeout" }];
      }
      return [
        {
          id: "partition-timeout",
          lane: "extended",
          scope: "product_daily",
          source: "core_success",
          partition_date: "2026-04-01",
          last_error: "database query timed out",
          error_class: "database_timeout",
          error_message: "database query timed out",
        },
        {
          id: "partition-permission",
          lane: "extended",
          scope: "product_daily",
          source: "core_success",
          partition_date: "2026-04-02",
          last_error: "PERMISSION_DENIED: The caller does not have permission",
          error_class: "account_action_required",
          error_message: "PERMISSION_DENIED: The caller does not have permission",
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await requeueGoogleAdsRetryableFailedPartitions({
      businessId: "biz-1",
    });

    expect(result).toEqual(["partition-timeout"]);
    expect(queries.some((query) => query.includes("partition.status = 'failed'"))).toBe(true);
    expect(queries.some((query) => query.includes("status = 'queued'"))).toBe(true);
    expect(queries.some((query) => query.includes("next_retry_at = now()"))).toBe(true);
  });

  it("extends the running lease using the requested lease minutes", async () => {
    const queries: string[] = [];
    const calls: unknown[][] = [];
    const sql = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(strings.join(" "));
        calls.push(values);
        return [{ id: "partition-1" }];
      },
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await markGoogleAdsPartitionRunning({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 3,
      leaseMinutes: 15,
    });

    expect(result).toBe(true);
    expect(calls.at(0)).toContain(15);
    expect(
      queries.some(
        (query) =>
          query.includes("FROM sync_runner_leases lease") &&
          query.includes("lease.provider_scope = 'google_ads'"),
      ),
    ).toBe(true);
  });

  it("requires an active owned lease to write an owned checkpoint update", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [{ id: "checkpoint-1" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const checkpointId = await upsertGoogleAdsSyncCheckpoint({
      partitionId: "partition-1",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      checkpointScope: "campaign_daily",
      phase: "bulk_upsert",
      status: "running",
      pageIndex: 0,
      attemptCount: 1,
      leaseOwner: "worker-1",
      leaseEpoch: 7,
    });

    expect(checkpointId).toBe("checkpoint-1");
    expect(
      queries.some(
        (query) =>
          query.includes("WITH owner_guard AS") &&
          query.includes("lease_owner =") &&
          query.includes("COALESCE(lease_epoch, 0) =") &&
          query.includes(
            "COALESCE(lease_expires_at, now() - interval '1 second') > now()",
          ),
      ),
    ).toBe(true);
  });

  it("clears poison markers when a succeeded checkpoint upsert omits poison metadata", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [{ id: "checkpoint-1" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const checkpointId = await upsertGoogleAdsSyncCheckpoint({
      partitionId: "partition-1",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      checkpointScope: "campaign_daily",
      phase: "finalize",
      status: "succeeded",
      pageIndex: 0,
      attemptCount: 3,
      leaseOwner: "worker-1",
      leaseEpoch: 7,
    });

    expect(checkpointId).toBe("checkpoint-1");
    expect(
      queries.some(
        (query) =>
          query.includes("WHEN EXCLUDED.status = 'succeeded' AND EXCLUDED.poisoned_at IS NULL") &&
          query.includes("poison_reason = CASE"),
      ),
    ).toBe(true);
  });

  it("keeps active leased dead-letter partitions out of replay", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (
        query.includes("FROM google_ads_sync_partitions partition") &&
        query.includes("latest_run")
      ) {
        return [
          {
            id: "11111111-1111-1111-1111-111111111111",
            lane: "core",
            scope: "campaign_daily",
            source: "historical",
            partition_date: "2026-05-01",
            last_error: "RESOURCE_EXHAUSTED quota exceeded",
            error_class: "quota",
            error_message: "RESOURCE_EXHAUSTED quota exceeded",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await replayGoogleAdsDeadLetterPartitions({
      businessId: "biz-1",
      scope: "campaign_daily",
    });

    expect(result.outcome).toBe("no_matching_partitions");
    expect(
      queries.some((query) =>
        query.includes(
          "COALESCE(lease_expires_at, now() - interval '1 second') > now()",
        ),
      ),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.includes(
          "COALESCE(lease_expires_at, now() - interval '1 second') <= now()",
        ),
      ),
    ).toBe(true);
  });

  it("returns skipped_active_lease when only actively leased partitions match replay", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "11111111-1111-1111-1111-111111111111",
          lane: "core",
          scope: "campaign_daily",
          source: "historical",
          partition_date: "2026-05-01",
          last_error: "RESOURCE_EXHAUSTED quota exceeded",
          error_class: "quota",
          error_message: "RESOURCE_EXHAUSTED quota exceeded",
        },
      ])
      .mockResolvedValueOnce([{ id: "11111111-1111-1111-1111-111111111111" }])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await replayGoogleAdsDeadLetterPartitions({
      businessId: "biz-1",
      scope: "campaign_daily",
    });

    expect(result.outcome).toBe("skipped_active_lease");
    expect(result.matchedCount).toBe(1);
    expect(result.changedCount).toBe(0);
    expect(result.skippedActiveLeaseCount).toBe(1);
  });

  it("skips terminal Google Ads action-required dead letters during automatic replay", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      return [
        {
          id: "11111111-1111-1111-1111-111111111111",
          lane: "core",
          scope: "campaign_daily",
          source: "historical",
          partition_date: "2026-05-01",
          last_error: "invalid_grant: token has been expired or revoked",
          error_class: "account_action_required",
          error_message: "invalid_grant: token has been expired or revoked",
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await replayGoogleAdsDeadLetterPartitions({
      businessId: "biz-1",
      scope: "campaign_daily",
    });

    expect(result.matchedCount).toBe(1);
    expect(result.changedCount).toBe(0);
    expect(result.terminalActionRequiredCount).toBe(1);
    expect(result.actionRequiredPartitions?.[0]).toEqual(
      expect.objectContaining({
        id: "11111111-1111-1111-1111-111111111111",
        reasonCode: "google_ads_auth_action_required",
      }),
    );
    expect(queries.some((query) => query.includes("UPDATE google_ads_sync_partitions"))).toBe(false);
  });

  it("keeps recently progressing partitions leased during cleanup", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (
        query.includes("FROM google_ads_sync_partitions partition") &&
        query.includes("same_phase_failures")
      ) {
        return [
          {
            id: "partition-1",
            scope: "campaign_daily",
            lane: "core",
            status: "leased",
            attempt_count: 1,
            updated_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            checkpoint_scope: "campaign_daily",
            phase: "bulk_upsert",
            page_index: 0,
            checkpoint_attempt_count: 1,
            checkpoint_status: "running",
            progress_updated_at: new Date().toISOString(),
            poisoned_at: null,
            poison_reason: null,
            same_phase_failures: 0,
            has_active_runner_lease: true,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupGoogleAdsPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(0);
    expect(result.aliveSlowCount).toBe(1);
    expect(result.reclaimReasons.stalledReclaimable).toEqual([]);
  });

  it("reclaims expired partitions when progress is stale and no runner lease remains", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (
        query.includes("FROM google_ads_sync_partitions partition") &&
        query.includes("same_phase_failures")
      ) {
        return [
          {
            id: "partition-1",
            scope: "campaign_daily",
            lane: "core",
            status: "leased",
            attempt_count: 1,
            updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            lease_expires_at: new Date(Date.now() - 2 * 60_000).toISOString(),
            checkpoint_scope: "campaign_daily",
            phase: "bulk_upsert",
            page_index: 0,
            checkpoint_attempt_count: 1,
            checkpoint_status: "running",
            progress_updated_at: new Date(
              Date.now() - 10 * 60_000,
            ).toISOString(),
            poisoned_at: null,
            poison_reason: null,
            same_phase_failures: 0,
            has_active_runner_lease: false,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupGoogleAdsPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(1);
    expect(result.aliveSlowCount).toBe(0);
    expect(result.reclaimReasons.stalledReclaimable).toEqual([
      "worker_offline_no_progress",
    ]);
  });

  it("reclaims live leases that never produced checkpoint progress or runner ownership", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (
        query.includes("FROM google_ads_sync_partitions partition") &&
        query.includes("same_phase_failures")
      ) {
        return [
          {
            id: "partition-1",
            scope: "campaign_daily",
            lane: "core",
            status: "leased",
            attempt_count: 0,
            updated_at: new Date(Date.now() - 2 * 60_000).toISOString(),
            started_at: null,
            lease_expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
            checkpoint_scope: null,
            phase: null,
            page_index: null,
            checkpoint_attempt_count: null,
            checkpoint_status: null,
            progress_updated_at: null,
            poisoned_at: null,
            poison_reason: null,
            same_phase_failures: 0,
            has_active_runner_lease: false,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupGoogleAdsPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(1);
    expect(result.aliveSlowCount).toBe(0);
    expect(result.reclaimReasons.stalledReclaimable).toEqual([
      "runner_lease_missing_no_progress",
    ]);
  });

  it("completes a partition attempt only when worker ownership and lease are current", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [
        {
          completed: true,
          run_updated: true,
          closed_running_run_count: 2,
          caller_run_id_was_closed: true,
          closed_running_run_ids: ["run-1", "run-2"],
          closed_checkpoint_groups: [
            {
              checkpointScope: "campaign_daily",
              previousPhase: "fetch_raw",
              count: 1,
            },
          ],
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const completed = await completeGoogleAdsPartitionAttempt({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 9,
      partitionStatus: "succeeded",
      runId: "run-1",
      runStatus: "succeeded",
    });

    expect(completed).toEqual({
      ok: true,
      runUpdated: true,
      closedRunningRunCount: 2,
      callerRunIdWasClosed: true,
      closedRunningRunIds: ["run-1", "run-2"],
      closedCheckpointGroups: [
        {
          checkpointScope: "campaign_daily",
          previousPhase: "fetch_raw",
          count: 1,
        },
      ],
    });
    expect(
      queries.some(
        (query) =>
          query.includes("UPDATE google_ads_sync_partitions partition") &&
          query.includes("AND partition.lease_owner =") &&
          query.includes("COALESCE(partition.lease_epoch, 0) = input_values.lease_epoch") &&
          query.includes("COALESCE(partition.lease_expires_at, now()) > now()"),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (query) =>
          query.includes("UPDATE google_ads_sync_runs run") &&
          query.includes("run.status = 'running'"),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (query) =>
          query.includes("UPDATE google_ads_sync_checkpoints checkpoint") &&
          query.includes("checkpoint.status = 'running'"),
      ),
    ).toBe(true);
  });

  it("requires same-owner current epoch and an unexpired partition lease for heartbeat renewal", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [{ id: "partition-1" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const renewed = await heartbeatGoogleAdsPartitionLease({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 12,
      leaseMinutes: 5,
    });

    expect(renewed).toBe(true);
    expect(
      queries.some(
        (query) =>
          query.includes("UPDATE google_ads_sync_partitions") &&
          query.includes("partition.lease_epoch = ") &&
          query.includes("lease_expires_at = now() +") &&
          query.includes("COALESCE(partition.lease_expires_at, now()) > now()") &&
          query.includes("FROM sync_runner_leases lease") &&
          query.includes("lease.provider_scope = 'google_ads'"),
      ),
    ).toBe(true);
  });

  it("backfills running runs and checkpoints under terminal parents", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          partition_status: "dead_letter",
          closed_running_run_count: 2,
          caller_run_id_was_closed: true,
          closed_running_run_ids: ["run-1", "run-2"],
        },
      ])
      .mockResolvedValueOnce([
        {
          closed_checkpoint_groups: [
            {
              checkpointScope: "campaign_daily",
              previousPhase: "transform",
              count: 2,
            },
          ],
        },
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const runResult = await backfillGoogleAdsRunningRunsForTerminalPartition({
      partitionId: "partition-1",
      runId: "run-1",
    });
    const checkpointResult =
      await backfillGoogleAdsRunningCheckpointsForTerminalPartition({
        partitionId: "partition-1",
      });

    expect(runResult).toEqual({
      partitionStatus: "dead_letter",
      closedRunningRunCount: 2,
      callerRunIdWasClosed: true,
      closedRunningRunIds: ["run-1", "run-2"],
    });
    expect(checkpointResult).toEqual({
      closedCheckpointGroups: [
        {
          checkpointScope: "campaign_daily",
          previousPhase: "transform",
          count: 2,
        },
      ],
      closedRunningCheckpointCount: 2,
    });
  });

  it("backfills running runs under terminal parents in bounded batches", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      const batchCount = queries.filter((item) =>
        item.includes("candidate_runs"),
      ).length;
      if (batchCount === 1) {
        return [
          {
            partition_status: "succeeded",
            closed_running_run_count: 25,
            caller_run_id_was_closed: false,
            closed_running_run_ids: Array.from({ length: 10 }, (_, index) =>
              `run-${index + 1}`,
            ),
          },
        ];
      }
      if (batchCount === 2) {
        return [
          {
            partition_status: "succeeded",
            closed_running_run_count: 5,
            caller_run_id_was_closed: true,
            closed_running_run_ids: ["run-26", "run-27", "run-28"],
          },
        ];
      }
      return [
        {
          partition_status: "succeeded",
          closed_running_run_count: 0,
          caller_run_id_was_closed: false,
          closed_running_run_ids: [],
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await backfillGoogleAdsRunningRunsForTerminalPartition({
      partitionId: "partition-1",
      runId: "run-28",
    });

    expect(result).toEqual({
      partitionStatus: "succeeded",
      closedRunningRunCount: 30,
      callerRunIdWasClosed: true,
      closedRunningRunIds: [
        "run-1",
        "run-2",
        "run-3",
        "run-4",
        "run-5",
        "run-6",
        "run-7",
        "run-8",
        "run-9",
        "run-10",
      ],
    });
    expect(
      queries.filter((query) => query.includes("candidate_runs")),
    ).toHaveLength(2);
    expect(queries[0]).toContain("LIMIT");
  });

  it("reconciles terminal-parent children before stale reclaim cleanup", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      if (queries.length === 1) {
        return [{ id: "partition-1" }];
      }
      if (queries.length === 2) {
        return [
          {
            partition_status: "succeeded",
            closed_running_run_count: 2,
            caller_run_id_was_closed: null,
            closed_running_run_ids: ["run-1", "run-2"],
          },
        ];
      }
      if (queries.length === 3) {
        return [
          {
            closed_checkpoint_groups: [
              {
                checkpointScope: "campaign_daily",
                previousPhase: "fetch_raw",
                count: 1,
              },
            ],
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupGoogleAdsPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.closedTerminalRunningRunCount).toBe(2);
    expect(result.closedTerminalRunningCheckpointCount).toBe(1);
    expect(queries[0]).toContain("candidate_terminal_partitions");
    expect(queries[1]).toContain("UPDATE google_ads_sync_runs run");
    expect(queries[1]).toContain("candidate_runs");
    expect(queries[2]).toContain(
      "UPDATE google_ads_sync_checkpoints checkpoint",
    );
    expect(
      queries.some(
        (query) =>
          query.includes("candidate_terminal_partitions") &&
          query.includes("LIMIT"),
      ),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.includes("UPDATE google_ads_sync_runs run") &&
        query.includes("candidate_runs"),
      ),
    ).toBe(true);
  });

  it("caps terminal-parent cleanup to a bounded partition batch", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("candidate_terminal_partitions")) {
        return [{ id: "partition-1" }, { id: "partition-2" }];
      }
      if (query.includes("UPDATE google_ads_sync_runs run")) {
        return [
          {
            partition_status: "failed",
            closed_running_run_count: 3,
            caller_run_id_was_closed: null,
            closed_running_run_ids: ["run-a", "run-b", "run-c"],
          },
        ];
      }
      if (query.includes("UPDATE google_ads_sync_checkpoints checkpoint")) {
        return [
          {
            closed_checkpoint_groups: [
              {
                checkpointScope: "campaign_daily",
                previousPhase: "transform",
                count: 2,
              },
            ],
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupGoogleAdsPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.closedTerminalRunningRunCount).toBe(6);
    expect(result.closedTerminalRunningCheckpointCount).toBe(4);
    expect(queries[0]).toContain("candidate_terminal_partitions");
    expect(queries[0]).toContain("LIMIT");
    expect(
      queries.filter(
        (query) =>
          query.includes("UPDATE google_ads_sync_runs run") &&
          query.includes("candidate_runs"),
      ),
    ).toHaveLength(2);
    expect(
      queries.filter((query) =>
        query.includes("UPDATE google_ads_sync_checkpoints checkpoint") &&
        query.includes("candidate.previous_phase"),
      ),
    ).toHaveLength(2);
  });

  it("uses integer stale-run thresholds in cleanup SQL", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await cleanupGoogleAdsPartitionOrchestration({
      businessId: "biz-1",
      staleRunMinutesByLane: {
        core: 11,
        maintenance: 17,
        extended: 29,
      },
    });

    const staleRunQuery = queries.find((query) =>
      query.includes("stale_threshold_minutes"),
    );
    expect(staleRunQuery).toBeTruthy();
    expect(staleRunQuery).toContain("THEN ");
    expect(staleRunQuery).toContain("::int");
    expect(staleRunQuery).not.toContain("THEN $");
  });

  it("ignores prior-epoch checkpoint progress when evaluating stale leased partitions", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await cleanupGoogleAdsPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    const cleanupQuery = queries.find(
      (query) =>
        query.includes("checkpoint_lease_epoch") &&
        query.includes("partition_lease_epoch"),
    );
    expect(cleanupQuery).toBeTruthy();
    expect(cleanupQuery).toContain(
      "COALESCE(checkpoint.lease_epoch, 0) AS checkpoint_lease_epoch",
    );
    expect(cleanupQuery).toContain(
      "COALESCE(partition.lease_epoch, 0) AS partition_lease_epoch",
    );
  });
});

describe("getGoogleAdsPartitionHealth", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("ignores terminal partition timestamps when reporting latest activity", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("MAX(updated_at) FILTER")) {
        return [
          {
            queue_depth: 0,
            leased_partitions: 0,
            dead_letter_partitions: 0,
            oldest_queued_partition: null,
            latest_activity_at: null,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await getGoogleAdsPartitionHealth({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      scope: "asset_daily",
      lane: "extended",
    });

    expect(result.latestActivityAt).toBeNull();
    expect(result.queueDepth).toBe(0);
    expect(result.leasedPartitions).toBe(0);
  });
});

describe("getGoogleAdsQueueHealth", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("separates quarantined historical dead letters from release-blocking dead letters", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("latest_run.error_class")) return [];
      return [
        {
          queue_depth: 0,
          leased_partitions: 0,
          core_queue_depth: 0,
          core_leased_partitions: 0,
          extended_queue_depth: 0,
          extended_leased_partitions: 0,
          extended_recent_queue_depth: 0,
          extended_recent_leased_partitions: 0,
          extended_historical_queue_depth: 0,
          extended_historical_leased_partitions: 0,
          maintenance_queue_depth: 0,
          maintenance_leased_partitions: 0,
          dead_letter_partitions: 3,
          blocking_dead_letter_partitions: 0,
          quarantined_historical_dead_letter_partitions: 3,
          oldest_queued_partition: null,
          latest_core_activity_at: null,
          latest_extended_activity_at: null,
          latest_maintenance_activity_at: null,
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await getGoogleAdsQueueHealth({ businessId: "biz-1" });

    expect(result.deadLetterPartitions).toBe(3);
    expect(result.blockingDeadLetterPartitions).toBe(0);
    expect(result.quarantinedHistoricalDeadLetterPartitions).toBe(3);
    expect(queries[0]).toContain("poisoned_at IS NOT NULL");
    expect(queries[0]).toContain("blocking_dead_letter_partitions");
  });

  it("classifies terminal account-action dead letters separately from replayable dead letters", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("latest_run.error_class")) {
        return [
          {
            id: "terminal-1",
            lane: "extended",
            scope: "product_daily",
            source: "core_success",
            partition_date: "2026-05-01",
            last_error:
              "google_ads_product_daily_fetch_failed: message=provider_request_failed:permission:status_403",
            error_class: "transient",
            error_message: null,
            is_historical_quarantined: false,
          },
          {
            id: "replayable-1",
            lane: "extended",
            scope: "asset_daily",
            source: "recent_recovery",
            partition_date: "2026-05-01",
            last_error: "Google Ads request failed: 503 temporarily unavailable",
            error_class: "transient",
            error_message: null,
            is_historical_quarantined: false,
          },
        ];
      }
      return [
        {
          queue_depth: 0,
          leased_partitions: 0,
          core_queue_depth: 0,
          core_leased_partitions: 0,
          extended_queue_depth: 0,
          extended_leased_partitions: 0,
          extended_recent_queue_depth: 0,
          extended_recent_leased_partitions: 0,
          extended_historical_queue_depth: 0,
          extended_historical_leased_partitions: 0,
          maintenance_queue_depth: 0,
          maintenance_leased_partitions: 0,
          dead_letter_partitions: 2,
          blocking_dead_letter_partitions: 2,
          quarantined_historical_dead_letter_partitions: 0,
          oldest_queued_partition: null,
          latest_core_activity_at: null,
          latest_extended_activity_at: null,
          latest_maintenance_activity_at: null,
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await getGoogleAdsQueueHealth({ businessId: "biz-1" });

    expect(result.actionRequiredDeadLetterPartitions).toBe(1);
    expect(result.actionRequiredBlockingDeadLetterPartitions).toBe(1);
    expect(result.actionRequiredDeadLetterScopes).toEqual(["product_daily"]);
    expect(result.actionRequiredBlockingDeadLetterScopes).toEqual([
      "product_daily",
    ]);
    expect(result.coreBlockingDeadLetterPartitions).toBe(0);
    expect(result.coreActionRequiredBlockingDeadLetterPartitions).toBe(0);
    expect(result.replayableDeadLetterPartitions).toBe(1);
    expect(result.replayableBlockingDeadLetterPartitions).toBe(1);
  });
});

describe("google ads typed dimension overlays", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("overlays campaign dimensions on daily rows", async () => {
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async () => [
        {
          business_id: "biz_1",
          provider_account_id: "acct_1",
          date: "2026-04-01",
          account_timezone: "UTC",
          account_currency: "USD",
          entity_key: "cmp_1",
          entity_label: "Fact Campaign",
          campaign_id: "cmp_1",
          campaign_name: "Fact Campaign",
          ad_group_id: null,
          ad_group_name: null,
          status: "enabled",
          channel: "search",
          classification: "brand",
          payload_json: { name: "Fact Campaign" },
          spend: 10,
          revenue: 20,
          conversions: 2,
          impressions: 100,
          clicks: 5,
          ctr: 5,
          cpc: 2,
          cpa: 5,
          roas: 2,
          conversion_rate: 2,
          interaction_rate: 5,
          source_snapshot_id: "snap_1",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T01:00:00.000Z",
        },
      ]),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(requestModelStore.readGoogleAdsCampaignDimensions).mockResolvedValue([
      {
        businessId: "biz_1",
        businessRefId: "biz_1-ref",
        providerAccountId: "acct_1",
        providerAccountRefId: "acct_1-ref",
        campaignId: "cmp_1",
        campaignName: "Dimension Campaign",
        normalizedStatus: "paused",
        channel: "performance_max",
        projectionJson: { id: "cmp_1", name: "Dimension Campaign", status: "paused" },
        firstSeenAt: null,
        lastSeenAt: null,
        sourceUpdatedAt: null,
      },
    ]);

    const rows = await readGoogleAdsDailyRange({
      scope: "campaign_daily",
      businessId: "biz_1",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityLabel).toBe("Dimension Campaign");
    expect(rows[0]?.campaignName).toBe("Dimension Campaign");
    expect(rows[0]?.status).toBe("paused");
    expect(rows[0]?.payloadJson).toEqual({
      id: "cmp_1",
      name: "Dimension Campaign",
      status: "paused",
    });
  });

  it("can bypass campaign dimension overlay on daily rows", async () => {
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async () => [
        {
          business_id: "biz_1",
          provider_account_id: "acct_1",
          date: "2026-04-01",
          account_timezone: "UTC",
          account_currency: "USD",
          entity_key: "cmp_1",
          entity_label: "Fact Campaign",
          campaign_id: "cmp_1",
          campaign_name: "Fact Campaign",
          ad_group_id: null,
          ad_group_name: null,
          status: "enabled",
          channel: "search",
          classification: "brand",
          payload_json: { name: "Fact Campaign" },
          spend: 10,
          revenue: 20,
          conversions: 2,
          impressions: 100,
          clicks: 5,
          ctr: 5,
          cpc: 2,
          cpa: 5,
          roas: 2,
          conversion_rate: 2,
          interaction_rate: 5,
          source_snapshot_id: "snap_1",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T01:00:00.000Z",
        },
      ]),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(requestModelStore.readGoogleAdsCampaignDimensions).mockResolvedValue([
      {
        businessId: "biz_1",
        businessRefId: "biz_1-ref",
        providerAccountId: "acct_1",
        providerAccountRefId: "acct_1-ref",
        campaignId: "cmp_1",
        campaignName: "Dimension Campaign",
        normalizedStatus: "paused",
        channel: "performance_max",
        projectionJson: { id: "cmp_1", name: "Dimension Campaign", status: "paused" },
        firstSeenAt: null,
        lastSeenAt: null,
        sourceUpdatedAt: null,
      },
    ]);

    const rows = await readGoogleAdsDailyRange({
      scope: "campaign_daily",
      businessId: "biz_1",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      disableDimensionOverlay: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityLabel).toBe("Fact Campaign");
    expect(rows[0]?.campaignName).toBe("Fact Campaign");
    expect(rows[0]?.status).toBe("enabled");
    expect(rows[0]?.payloadJson).toEqual({ name: "Fact Campaign" });
    expect(requestModelStore.readGoogleAdsCampaignDimensions).not.toHaveBeenCalled();
  });

  it("overlays product and campaign dimensions on aggregated rows", async () => {
    const sql = Object.assign(vi.fn(), {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          {
            entity_key: "prod_1",
            spend: 15,
            revenue: 45,
            conversions: 3,
            impressions: 100,
            clicks: 12,
            updated_at: "2026-04-03T01:00:00.000Z",
          },
        ])
        .mockResolvedValueOnce([
          {
            entity_key: "prod_1",
            entity_label: "Fact Product",
            campaign_id: "cmp_1",
            campaign_name: "Fact Campaign",
            ad_group_id: null,
            ad_group_name: null,
            status: "enabled",
            channel: "shopping",
            classification: "retail",
            payload_json: { productTitle: "Fact Product", campaignName: "Fact Campaign" },
            updated_at: "2026-04-03T01:00:00.000Z",
          },
        ]),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(requestModelStore.readGoogleAdsProductDimensions).mockResolvedValue([
      {
        businessId: "biz_1",
        businessRefId: "biz_1-ref",
        providerAccountId: "acct_1",
        providerAccountRefId: "acct_1-ref",
        campaignId: "cmp_1",
        productKey: "prod_1",
        productTitle: "Dimension Product",
        normalizedStatus: "paused",
        projectionJson: {
          name: "Stale Product Name",
          productTitle: "Dimension Product",
          title: "Dimension Product",
        },
        firstSeenAt: null,
        lastSeenAt: null,
        sourceUpdatedAt: null,
      },
    ]);
    vi.mocked(requestModelStore.readGoogleAdsCampaignDimensions).mockResolvedValue([
      {
        businessId: "biz_1",
        businessRefId: "biz_1-ref",
        providerAccountId: "acct_1",
        providerAccountRefId: "acct_1-ref",
        campaignId: "cmp_1",
        campaignName: "Dimension Campaign",
        normalizedStatus: "paused",
        channel: "shopping",
        projectionJson: { id: "cmp_1", name: "Dimension Campaign" },
        firstSeenAt: null,
        lastSeenAt: null,
        sourceUpdatedAt: null,
      },
    ]);

    const rows = await readGoogleAdsAggregatedRange({
      scope: "product_daily",
      businessId: "biz_1",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Dimension Product");
    expect(rows[0]?.productTitle).toBe("Dimension Product");
    expect(rows[0]?.title).toBe("Dimension Product");
    expect(rows[0]?.campaignName).toBe("Dimension Campaign");
    expect(rows[0]?.status).toBe("paused");
  });

  it("can bypass product and campaign dimension overlay on aggregated rows", async () => {
    const sql = Object.assign(vi.fn(), {
      query: vi
        .fn()
        .mockResolvedValueOnce([
          {
            entity_key: "prod_1",
            spend: 15,
            revenue: 45,
            conversions: 3,
            impressions: 100,
            clicks: 12,
            updated_at: "2026-04-03T01:00:00.000Z",
          },
        ])
        .mockResolvedValueOnce([
          {
            entity_key: "prod_1",
            entity_label: "Fact Product",
            campaign_id: "cmp_1",
            campaign_name: "Fact Campaign",
            ad_group_id: null,
            ad_group_name: null,
            status: "enabled",
            channel: "shopping",
            classification: "retail",
            payload_json: { productTitle: "Fact Product", campaignName: "Fact Campaign" },
            updated_at: "2026-04-03T01:00:00.000Z",
          },
        ]),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(requestModelStore.readGoogleAdsProductDimensions).mockResolvedValue([
      {
        businessId: "biz_1",
        businessRefId: "biz_1-ref",
        providerAccountId: "acct_1",
        providerAccountRefId: "acct_1-ref",
        campaignId: "cmp_1",
        productKey: "prod_1",
        productTitle: "Dimension Product",
        normalizedStatus: "paused",
        projectionJson: { productTitle: "Dimension Product", title: "Dimension Product" },
        firstSeenAt: null,
        lastSeenAt: null,
        sourceUpdatedAt: null,
      },
    ]);
    vi.mocked(requestModelStore.readGoogleAdsCampaignDimensions).mockResolvedValue([
      {
        businessId: "biz_1",
        businessRefId: "biz_1-ref",
        providerAccountId: "acct_1",
        providerAccountRefId: "acct_1-ref",
        campaignId: "cmp_1",
        campaignName: "Dimension Campaign",
        normalizedStatus: "paused",
        channel: "shopping",
        projectionJson: { id: "cmp_1", name: "Dimension Campaign" },
        firstSeenAt: null,
        lastSeenAt: null,
        sourceUpdatedAt: null,
      },
    ]);

    const rows = await readGoogleAdsAggregatedRange({
      scope: "product_daily",
      businessId: "biz_1",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      disableDimensionOverlay: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Fact Product");
    expect(rows[0]?.campaignName).toBe("Fact Campaign");
    expect(rows[0]?.status).toBe("enabled");
    expect(requestModelStore.readGoogleAdsProductDimensions).not.toHaveBeenCalled();
    expect(requestModelStore.readGoogleAdsCampaignDimensions).not.toHaveBeenCalled();
  });
});

describe("google ads typed dimension dual-write", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("writes campaign dimensions and state history alongside campaign facts", async () => {
    const queries: string[] = [];
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertGoogleAdsDailyRows("campaign_daily", [
      buildRow({
        entityKey: "cmp_1",
        campaignId: "cmp_1",
        campaignName: "Campaign One",
      }),
    ]);

    const joined = queries.join("\n");
    expect(joined).toContain("INSERT INTO google_ads_campaign_daily");
    expect(joined).toContain("INSERT INTO google_ads_campaign_dimensions");
    expect(joined).toContain("INSERT INTO google_ads_campaign_state_history");
  });

  it("uses contiguous placeholders for multi-row campaign dual-write inserts", async () => {
    const queries: string[] = [];
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertGoogleAdsDailyRows("campaign_daily", [
      buildRow({
        date: "2026-03-30",
        entityKey: "cmp_1",
        campaignId: "cmp_1",
        campaignName: "Campaign One",
      }),
      buildRow({
        date: "2026-03-31",
        entityKey: "cmp_2",
        campaignId: "cmp_2",
        campaignName: "Campaign Two",
      }),
    ]);

    const dimensionInsert = queries.find((query) =>
      query.includes("INSERT INTO google_ads_campaign_dimensions"),
    );
    const stateHistoryInsert = queries.find((query) =>
      query.includes("INSERT INTO google_ads_campaign_state_history"),
    );

    expect(dimensionInsert).toMatch(/\(\$13,\$14,\$15,\$16,\$17,\$18,\$19,\$20,\$21::jsonb,\$22::timestamptz,\$23::timestamptz,\$24::timestamptz,now\(\),now\(\)\)/);
    expect(stateHistoryInsert).toMatch(/\(\$15,\$16,\$17,\$18,\$19,\$20,\$21,\$22,\$23,\$24::jsonb,'warehouse_daily',\$25,\$26::timestamptz,\$27::date,\$28::date,now\(\)\)/);
  });

  it("dedupes conflicting fact rows before batching and writing", async () => {
    const queries: string[] = [];
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertGoogleAdsDailyRows("campaign_daily", [
      buildRow({
        date: "2026-03-30",
        entityKey: "cmp_1",
        campaignId: "cmp_1",
        campaignName: "Campaign One",
        spend: 1,
      }),
      buildRow({
        date: "2026-03-30",
        entityKey: "cmp_1",
        campaignId: "cmp_1",
        campaignName: "Campaign One",
        spend: 99,
      }),
    ]);

    const factInsert = queries.find((query) =>
      query.includes("INSERT INTO google_ads_campaign_daily"),
    );

    expect(factInsert).toContain("VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,now())");
    expect(factInsert).not.toContain("),($30,");
    expect(warnSpy).toHaveBeenCalledWith(
      "[google-ads-warehouse] deduped-conflicting-input-rows",
      expect.objectContaining({
        scope: "campaign_daily",
        inputSize: 2,
        dedupedSize: 1,
        duplicateCount: 1,
      }),
    );

    warnSpy.mockRestore();
  });

  it("uses JSONB recordset writes for product facts and dimensions", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const sql = Object.assign(vi.fn(), {
      query: vi.fn(async (query: string, values?: unknown[]) => {
        queries.push(query);
        params.push(values ?? []);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertGoogleAdsDailyRows("product_daily", [
      buildRow({
        entityKey: "product_1",
        entityLabel: "Product One",
        payloadJson: { productTitle: "Product One" },
      }),
      buildRow({
        entityKey: "product_2",
        entityLabel: "Product Two",
        payloadJson: { productTitle: "Product Two" },
      }),
    ]);

    const joined = queries.join("\n");
    expect(joined).toContain("INSERT INTO google_ads_product_daily");
    expect(joined).toContain("INSERT INTO google_ads_product_dimensions");
    expect(joined).toContain("jsonb_to_recordset($1::jsonb)");
    expect(joined).not.toContain("VALUES ($1,$2,$3,$4,$5,$6,$7,$8");
    expect(params).toHaveLength(1);
    expect(params.every((value) => value.length === 1)).toBe(true);
  });
});

describe("google ads control-plane ref writes", () => {
  it("writes canonical ref ids for sync jobs", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await createGoogleAdsSyncJob({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      syncType: "incremental_recent",
      scope: "campaign_daily",
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      status: "running",
      progressPercent: 0,
      triggerSource: "scheduled",
      retryCount: 0,
      lastError: null,
    });

    const query = queries.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
  });

  it("writes canonical ref ids for sync partitions", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await queueGoogleAdsSyncPartition({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      lane: "core",
      scope: "campaign_daily",
      partitionDate: "2026-04-01",
      status: "queued",
      priority: 1,
      source: "recent",
      attemptCount: 0,
    });

    const query = queries.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
    expect(query).toContain("ON CONFLICT (business_id, provider_account_id, lane, scope, partition_date)");
  });

  it("surfaces advisor partition state breakdown including succeeded-empty dates", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("advisor_surfaces(scope)")) {
        return [
          {
            scope: "search_term_daily",
            total_partitions: 5,
            queued_partitions: 0,
            leased_partitions: 0,
            running_partitions: 0,
            succeeded_partitions: 5,
            failed_partitions: 0,
            dead_letter_partitions: 0,
            cancelled_partitions: 0,
            succeeded_empty_partitions: 5,
            latest_updated_at: "2026-04-21T00:00:00.000Z",
            latest_error: null,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const states = await getGoogleAdsAdvisorSurfacePartitionStates({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      startDate: "2026-02-25",
      endDate: "2026-05-19",
    });

    expect(states).toEqual([
      {
        surface: "search_term_daily",
        totalPartitions: 5,
        queuedPartitions: 0,
        leasedPartitions: 0,
        runningPartitions: 0,
        succeededPartitions: 5,
        failedPartitions: 0,
        deadLetterPartitions: 0,
        cancelledPartitions: 0,
        succeededEmptyPartitions: 5,
        latestUpdatedAt: "2026-04-21T00:00:00.000Z",
        latestError: null,
      },
    ]);
    expect(queries.join("\n")).toContain("google_ads_search_query_hot_daily");
    expect(queries.join("\n")).toContain("google_ads_search_cluster_daily");
    expect(queries.join("\n")).toContain("succeeded_empty_partitions");
  });

  it("writes canonical ref ids for sync runs", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await createGoogleAdsSyncRun({
      partitionId: "partition-1",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      lane: "core",
      scope: "campaign_daily",
      partitionDate: "2026-04-01",
      status: "running",
      workerId: "worker-1",
      attemptCount: 1,
      rowCount: 0,
      durationMs: 0,
      metaJson: {},
    });

    const query = queries.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
  });

  it("writes canonical ref ids for sync checkpoints and state", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertGoogleAdsSyncCheckpoint({
      partitionId: "partition-1",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      checkpointScope: "campaign_daily",
      phase: "bulk_upsert",
      status: "running",
      pageIndex: 0,
      attemptCount: 1,
      leaseOwner: "worker-1",
      leaseEpoch: 7,
    });

    await upsertGoogleAdsSyncState({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      scope: "campaign_daily",
      historicalTargetStart: "2026-01-01",
      historicalTargetEnd: "2026-04-01",
      effectiveTargetStart: "2026-01-01",
      effectiveTargetEnd: "2026-04-01",
      readyThroughDate: null,
      lastSuccessfulPartitionDate: null,
      latestBackgroundActivityAt: null,
      latestSuccessfulSyncAt: null,
      completedDays: 0,
      deadLetterCount: 0,
    });

    const query = queries.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
  });

  it("writes canonical ref ids for raw snapshots", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [{ id: "snapshot-1" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await persistGoogleAdsRawSnapshot({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      endpointName: "campaign_search_terms",
      entityScope: "campaign",
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      accountTimezone: "UTC",
      accountCurrency: "USD",
      payloadJson: { rows: [] },
      payloadHash: "hash-1",
      requestContext: {},
      providerHttpStatus: 200,
      status: "fetched",
    });

    const query = queries.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
    expect(query).toContain("google_ads_raw_snapshots");
  });

  it("writes canonical business refs for runner leases", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      if (strings.join(" ").includes("INSERT INTO google_ads_runner_leases")) {
        return [
          {
            business_id: "biz-1",
            lane: "core",
            lease_owner: "worker-1",
            lease_expires_at: "2026-04-16T00:05:00.000Z",
            created_at: "2026-04-16T00:00:00.000Z",
            updated_at: "2026-04-16T00:00:00.000Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await acquireGoogleAdsRunnerLease({
      businessId: "biz-1",
      lane: "core",
      leaseOwner: "worker-1",
      leaseMinutes: 5,
    });

    expect(queries.join("\n")).toContain("business_ref_id");
    expect(queries.join("\n")).toContain("google_ads_runner_leases");
  });
});
