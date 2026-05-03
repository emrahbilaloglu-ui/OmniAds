import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  ensureProviderAccountReferenceIds: vi.fn(async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) => {
    return new Map(accounts.map((account) => [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const));
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const));
  }),
}));

vi.mock("@/lib/sync/worker-health", () => ({
  recordSyncReclaimEvents: vi.fn().mockResolvedValue(undefined),
}));

const db = await import("@/lib/db");
const workerHealth = await import("@/lib/sync/worker-health");
const {
  buildMetaAuthoritativePublicationLookup,
  buildMetaAuthoritativeDayStateLookup,
  cleanupMetaPartitionOrchestration,
  completeMetaPartition,
  completeMetaPartitionAttempt,
  createMetaAuthoritativeReconciliationEvent,
  createMetaAuthoritativeSliceVersion,
  createMetaAuthoritativeSourceManifest,
  createMetaSyncJob,
  createMetaSyncRun,
  getMetaAuthoritativeBusinessOpsSnapshot,
  getMetaAuthoritativeDayVerification,
  getMetaAuthoritativeDayState,
  getMetaAuthoritativeRequiredSurfacesForDayAge,
  getMetaActivePublishedSliceVersion,
  getMetaPublishedVerificationSummary,
  upsertMetaAdDailyRows,
  getMetaAdSetDailyRange,
  getMetaBreakdownDailyRange,
  getMetaCampaignDailyRange,
  getMetaDirtyRecentDates,
  getMetaRecentAuthoritativeSliceGuard,
  leaseMetaSyncPartitions,
  markMetaPartitionRunning,
  persistMetaRawSnapshot,
  publishMetaAuthoritativeSliceVersion,
  replaceMetaBreakdownDailySlice,
  upsertMetaBreakdownDailyRows,
  replayMetaDeadLetterPartitions,
  releaseMetaLeasedPartitionsForWorker,
  reserveNextMetaAuthoritativeCandidateVersion,
  reconcileMetaAuthoritativeDayStateFromVerification,
  supersedeMetaAuthoritativeSliceVersions,
  upsertMetaAdSetDailyRows,
  upsertMetaCampaignDailyRows,
  upsertMetaCreativeDailyRows,
  upsertMetaAuthoritativeDayState,
  upsertMetaSyncCheckpoint,
  stripMetaCreativeMediaPayload,
} = await import(
  "@/lib/meta/warehouse"
);
const { createMetaFinalizationCompletenessProof } = await import("@/lib/meta/finalization-proof");

describe("meta warehouse ownership safety", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workerHealth.recordSyncReclaimEvents).mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("builds a normalized authoritative publication lookup key", () => {
    expect(
      buildMetaAuthoritativePublicationLookup({
        businessId: "biz-1",
        providerAccountId: "acct-1",
        day: "2026-04-06T14:15:16.000Z",
        surface: "campaign_daily",
      }),
    ).toEqual({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-06",
      surface: "campaign_daily",
    });
  });

  it("accepts finalized_verified breakdown rows in the serving range reader", async () => {
    let capturedQuery = "";
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      capturedQuery = strings.join(" ");
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await getMetaBreakdownDailyRange({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      providerAccountIds: ["act_1"],
      breakdownTypes: ["age"],
    });

    expect(capturedQuery).toContain("COALESCE(truth_state, 'finalized') IN ('finalized', 'finalized_verified')");
  });

  it("builds a normalized authoritative day-state lookup key and required surface buckets", () => {
    expect(
      buildMetaAuthoritativeDayStateLookup({
        businessId: "biz-1",
        providerAccountId: "acct-1",
        day: "2026-04-06T14:15:16.000Z",
        surface: "breakdown_daily",
      }),
    ).toEqual({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-06",
      surface: "breakdown_daily",
    });

    expect(
      getMetaAuthoritativeRequiredSurfacesForDayAge(120),
    ).toEqual([
      { surface: "account_daily", state: "pending" },
      { surface: "campaign_daily", state: "pending" },
      { surface: "adset_daily", state: "pending" },
      { surface: "ad_daily", state: "pending" },
      { surface: "breakdown_daily", state: "pending" },
    ]);
    expect(
      getMetaAuthoritativeRequiredSurfacesForDayAge(394),
    ).toEqual([
      { surface: "account_daily", state: "pending" },
      { surface: "campaign_daily", state: "pending" },
      { surface: "adset_daily", state: "pending" },
      { surface: "ad_daily", state: "pending" },
      { surface: "breakdown_daily", state: "not_applicable" },
    ]);
    expect(getMetaAuthoritativeRequiredSurfacesForDayAge(762)).toEqual([]);
  });

  it("round-trips meta authoritative day-state rows", async () => {
    const row = {
      business_id: "biz-1",
      provider_account_id: "acct-1",
      day: "2026-04-07",
      surface: "campaign_daily",
      state: "published",
      account_timezone: "UTC",
      active_partition_id: "partition-1",
      last_run_id: "run-1",
      last_manifest_id: "manifest-1",
      last_publication_pointer_id: "pointer-1",
      published_at: "2026-04-08T00:00:00.000Z",
      retry_after_at: null,
      failure_streak: 0,
      diagnosis_code: null,
      diagnosis_detail_json: { source: "verification" },
      last_started_at: "2026-04-07T00:01:00.000Z",
      last_finished_at: "2026-04-07T00:02:00.000Z",
      last_autoheal_at: null,
      autoheal_count: 1,
      created_at: "2026-04-08T00:05:00.000Z",
      updated_at: "2026-04-08T00:05:00.000Z",
    };
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("INSERT INTO meta_authoritative_day_state")) {
        return [row];
      }
      if (query.includes("FROM meta_authoritative_day_state")) {
        return [row];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const created = await upsertMetaAuthoritativeDayState({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-07T12:00:00.000Z",
      surface: "campaign_daily",
      state: "published",
      accountTimezone: "UTC",
      activePartitionId: "partition-1",
      lastRunId: "run-1",
      lastManifestId: "manifest-1",
      lastPublicationPointerId: "pointer-1",
      publishedAt: "2026-04-08T00:00:00.000Z",
      retryAfterAt: null,
      failureStreak: 0,
      diagnosisCode: null,
      diagnosisDetailJson: { source: "verification" },
      lastStartedAt: "2026-04-07T00:01:00.000Z",
      lastFinishedAt: "2026-04-07T00:02:00.000Z",
      lastAutohealAt: null,
      autohealCount: 1,
    });

    const readBack = await getMetaAuthoritativeDayState({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-07T12:00:00.000Z",
      surface: "campaign_daily",
    });

    expect(created).toMatchObject({
      day: "2026-04-07",
      surface: "campaign_daily",
      state: "published",
      diagnosisDetailJson: { source: "verification" },
    });
    expect(readBack).toMatchObject({
      day: "2026-04-07",
      surface: "campaign_daily",
      state: "published",
      lastPublicationPointerId: "pointer-1",
    });
  });

  it("reconciles published verification inputs into day-state rows", async () => {
    const existingRow = {
      business_id: "biz-1",
      provider_account_id: "acct-1",
      day: "2026-04-07",
      surface: "campaign_daily",
      state: "repair_required",
      account_timezone: "UTC",
      active_partition_id: null,
      last_run_id: "run-old",
      last_manifest_id: "manifest-old",
      last_publication_pointer_id: null,
      published_at: null,
      retry_after_at: "2026-04-07T00:15:00.000Z",
      failure_streak: 2,
      diagnosis_code: "stale_data",
      diagnosis_detail_json: { stale: true },
      last_started_at: "2026-04-07T00:01:00.000Z",
      last_finished_at: "2026-04-07T00:02:00.000Z",
      last_autoheal_at: null,
      autoheal_count: 1,
      created_at: "2026-04-07T00:00:00.000Z",
      updated_at: "2026-04-07T00:10:00.000Z",
    };
    const updatedRow = {
      ...existingRow,
      state: "published",
      last_run_id: "run-1",
      last_manifest_id: "manifest-1",
      last_publication_pointer_id: "pointer-1",
      published_at: "2026-04-08T00:00:00.000Z",
      retry_after_at: null,
      failure_streak: 0,
      diagnosis_code: null,
      diagnosis_detail_json: { verificationState: "finalized_verified" },
      autoheal_count: 1,
      updated_at: "2026-04-08T00:05:00.000Z",
    };
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("FROM meta_authoritative_day_state")) {
        return [existingRow];
      }
      if (query.includes("INSERT INTO meta_authoritative_day_state")) {
        return [updatedRow];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await reconcileMetaAuthoritativeDayStateFromVerification({
      verification: {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        day: "2026-04-07",
        verificationState: "finalized_verified",
        sourceManifestState: "completed",
        validationState: "finalized_verified",
        activePublication: {
          publishedAt: "2026-04-08T00:00:00.000Z",
          publicationReason: "finalize_day",
          activeSliceVersionId: "slice-1",
        },
        surfaces: [
          {
            surface: "campaign_daily",
            manifest: {
              id: "manifest-1",
              businessId: "biz-1",
              providerAccountId: "acct-1",
              day: "2026-04-07",
              surface: "campaign_daily",
              accountTimezone: "UTC",
              sourceKind: "finalize_day",
              sourceWindowKind: "historical",
              runId: "run-1",
              fetchStatus: "completed",
              freshStartApplied: false,
              checkpointResetApplied: false,
              rawSnapshotWatermark: null,
              sourceSpend: null,
              validationBasisVersion: null,
              metaJson: {},
              startedAt: "2026-04-07T00:01:00.000Z",
              completedAt: "2026-04-07T00:02:00.000Z",
              createdAt: "2026-04-07T00:00:00.000Z",
              updatedAt: "2026-04-07T00:10:00.000Z",
            },
            publication: {
              publication: {
                id: "pointer-1",
                businessId: "biz-1",
                providerAccountId: "acct-1",
                day: "2026-04-07",
                surface: "campaign_daily",
                activeSliceVersionId: "slice-1",
                publishedByRunId: "run-1",
                publicationReason: "finalize_day",
                publishedAt: "2026-04-08T00:00:00.000Z",
                createdAt: "2026-04-08T00:00:00.000Z",
                updatedAt: "2026-04-08T00:00:00.000Z",
              },
              sliceVersion: {
                id: "slice-1",
                businessId: "biz-1",
                providerAccountId: "acct-1",
                day: "2026-04-07",
                surface: "campaign_daily",
                manifestId: "manifest-1",
                candidateVersion: 1,
                state: "finalized_verified",
                truthState: "finalized",
                validationStatus: "passed",
                status: "published",
                stagedRowCount: 1,
                aggregatedSpend: 10,
                validationSummary: {},
                sourceRunId: "run-1",
                stageStartedAt: "2026-04-07T00:01:00.000Z",
                stageCompletedAt: "2026-04-07T00:02:00.000Z",
                publishedAt: "2026-04-08T00:00:00.000Z",
                supersededAt: null,
                createdAt: "2026-04-07T00:10:00.000Z",
                updatedAt: "2026-04-08T00:05:00.000Z",
              },
            },
          } as never,
        ],
      } as never,
    });

    expect(rows[0]).toMatchObject({
      state: "published",
      failureStreak: 0,
      lastPublicationPointerId: "pointer-1",
    });
    expect(queries.some((query) => query.includes("meta_authoritative_day_state"))).toBe(true);
  });

  it("marks completed manifests without publication as blocked planner state", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM meta_authoritative_day_state")) {
        return [];
      }
      if (query.includes("INSERT INTO meta_authoritative_day_state")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "acct-1",
            day: "2026-04-07",
            surface: "campaign_daily",
            state: "blocked",
            account_timezone: "UTC",
            active_partition_id: null,
            last_run_id: "run-1",
            last_manifest_id: "manifest-1",
            last_publication_pointer_id: null,
            published_at: null,
            retry_after_at: "2026-04-07T00:02:00.000Z",
            failure_streak: 1,
            diagnosis_code: "publication_pointer_missing",
            diagnosis_detail_json: {
              verificationState: "processing",
              plannerState: "blocked",
            },
            last_started_at: "2026-04-07T00:01:00.000Z",
            last_finished_at: "2026-04-07T00:02:00.000Z",
            last_autoheal_at: null,
            autoheal_count: 0,
            created_at: "2026-04-07T00:00:00.000Z",
            updated_at: "2026-04-07T00:02:00.000Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await reconcileMetaAuthoritativeDayStateFromVerification({
      verification: {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        day: "2026-04-07",
        verificationState: "processing",
        sourceManifestState: "completed",
        validationState: "processing",
        activePublication: null,
        surfaces: [
          {
            surface: "campaign_daily",
            manifest: {
              id: "manifest-1",
              businessId: "biz-1",
              providerAccountId: "acct-1",
              day: "2026-04-07",
              surface: "campaign_daily",
              accountTimezone: "UTC",
              sourceKind: "historical_recovery",
              sourceWindowKind: "historical",
              runId: "run-1",
              fetchStatus: "completed",
              freshStartApplied: true,
              checkpointResetApplied: false,
              rawSnapshotWatermark: "run-1",
              sourceSpend: 10,
              validationBasisVersion: "meta-authoritative-finalization-v2",
              metaJson: {},
              startedAt: "2026-04-07T00:01:00.000Z",
              completedAt: "2026-04-07T00:02:00.000Z",
              createdAt: "2026-04-07T00:00:00.000Z",
              updatedAt: "2026-04-07T00:02:00.000Z",
            },
            publication: null,
          } as never,
        ],
        lastFailure: null,
        repairBacklog: 0,
        deadLetters: 0,
        staleLeases: 0,
        queuedPartitions: 0,
        leasedPartitions: 0,
      } as never,
    });

    expect(rows[0]).toMatchObject({
      surface: "campaign_daily",
      state: "blocked",
      diagnosisCode: "publication_pointer_missing",
      activePartitionId: null,
    });
  });

  it("returns null when checkpoint upsert loses partition ownership", async () => {
    const sql = vi.fn().mockResolvedValue([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const checkpointId = await upsertMetaSyncCheckpoint({
      partitionId: "partition-1",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      checkpointScope: "breakdown:age",
      phase: "fetch_raw",
      status: "running",
      pageIndex: 0,
      attemptCount: 1,
      leaseEpoch: 3,
      leaseOwner: "worker-1",
    });

    expect(checkpointId).toBeNull();
  });

  it("increments lease_epoch whenever a partition is leased", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [
        {
          id: "partition-1",
          business_id: "biz-1",
          provider_account_id: "acct-1",
          lane: "extended",
          scope: "ad_daily",
          partition_date: "2026-04-03",
          status: "leased",
          priority: 55,
          source: "recent_recovery",
          lease_epoch: 4,
          lease_owner: "worker-1",
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
          attempt_count: 1,
          next_retry_at: null,
          last_error: null,
          created_at: new Date().toISOString(),
          started_at: null,
          finished_at: null,
          updated_at: new Date().toISOString(),
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await leaseMetaSyncPartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 1,
      leaseMinutes: 15,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.leaseEpoch).toBe(4);
    expect(queries.some((query) => query.includes("lease_epoch = partition.lease_epoch + 1"))).toBe(true);
    expect(queries.some((query) => query.includes("FROM sync_runner_leases lease"))).toBe(true);
    expect(queries.some((query) => query.includes("lease.provider_scope = 'meta'"))).toBe(true);
  });

  it("requeues leased partitions owned by a worker after the worker exits", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [{ id: "partition-1" }, { id: "partition-2" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const released = await releaseMetaLeasedPartitionsForWorker({
      businessId: "biz-1",
      workerId: "worker-1",
      lastError: "worker_exit",
    });

    expect(released).toBe(2);
    const query = queries.join("\n");
    expect(query).toContain("status = 'queued'");
    expect(query).toContain("AND partition.lease_owner =");
    expect(query).toContain("AND partition.status = 'leased'");
  });

  it("prioritizes newest dates first across priority and historical meta partitions", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await leaseMetaSyncPartitions({
      businessId: "biz-1",
      workerId: "worker-1",
      limit: 5,
      leaseMinutes: 15,
    });

    const query = queries.join("\n");
    expect(query).toContain("WHEN 'priority_window' THEN 700");
    expect(query).toContain("WHEN 'yesterday' THEN 675");
    expect(query).toContain("WHEN source IN ('priority_window', 'finalize_day')");
    expect(query).toContain("THEN partition_date");
    expect(query).toContain("WHEN source IN ('historical', 'historical_recovery', 'initial_connect')");
    expect(query).toContain("END DESC");
  });

  it("preserves existing non-null meta config truth when an incoming row is sparse", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    Object.assign(sql, {
      query: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertMetaCampaignDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 10,
        impressions: 100,
        clicks: 5,
        reach: 80,
        frequency: 1,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: "snapshot-1",
      },
    ]);

    await upsertMetaAdSetDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 8,
        impressions: 80,
        clicks: 4,
        reach: 70,
        frequency: 1,
        conversions: 1,
        revenue: 16,
        roas: 2,
        cpa: 8,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: "snapshot-1",
      },
    ]);

    const query = queries.join("\n");
    expect(query).toContain("objective = COALESCE(EXCLUDED.objective, meta_campaign_daily.objective)");
    expect(query).toContain(
      "optimization_goal = COALESCE(EXCLUDED.optimization_goal, meta_adset_daily.optimization_goal)"
    );
    expect(query).toContain("daily_budget = COALESCE(EXCLUDED.daily_budget, meta_campaign_daily.daily_budget)");
    expect(query).toContain("daily_budget = COALESCE(EXCLUDED.daily_budget, meta_adset_daily.daily_budget)");
  });

  it("writes zero link_clicks for sparse meta ad rows", async () => {
    const capturedValues: unknown[][] = [];
    const queries: string[] = [];
    const sql = vi.fn(async () => []);
    Object.assign(sql, {
      query: vi.fn(async (query: string, values: unknown[]) => {
        queries.push(query);
        capturedValues.push(values);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertMetaAdDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 100,
        clicks: 5,
        reach: 90,
        frequency: 1.1,
        conversions: 1,
        revenue: 20,
        roas: 1.7,
        cpa: 12,
        ctr: 5,
        cpc: 2.4,
        linkClicks: null,
        sourceSnapshotId: "snapshot-1",
        payloadJson: null,
      },
    ]);

    const adDailyQueryIndex = queries.findIndex((query) =>
      query.includes("INSERT INTO meta_ad_daily"),
    );
    expect(adDailyQueryIndex).toBeGreaterThanOrEqual(0);
    expect(capturedValues[adDailyQueryIndex]?.[24]).toBe(0);
  });

  it("casts warehouse range dates to text when truth lifecycle columns are enabled", async () => {
    vi.resetModules();
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("information_schema.columns")) {
        return [{ present: true }];
      }
      return [];
    });
    vi.doMock("@/lib/db", () => ({
      getDb: vi.fn(() => sql),
    }));
    vi.doMock("@/lib/migrations", () => ({
      runMigrations: vi.fn(),
    }));
    vi.doMock("@/lib/sync/worker-health", () => ({
      recordSyncReclaimEvents: vi.fn().mockResolvedValue(undefined),
    }));

    const module = await import("@/lib/meta/warehouse");

    await module.getMetaAccountDailyRange({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      includeProvisional: true,
    });
    await module.getMetaCampaignDailyRange({
      businessId: "biz-1",
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      includeProvisional: true,
    });

    expect(
      queries.some(
        (query) =>
          query.includes("FROM meta_account_daily") &&
          query.includes("date::text AS date"),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (query) =>
          query.includes("FROM meta_campaign_daily") &&
          query.includes("date::text AS date"),
      ),
    ).toBe(true);
  });

  it("batches meta creative daily upserts instead of writing one row per query", async () => {
    const queries: string[] = [];
    const queryMock = vi.fn(async (query: string) => {
      queries.push(query);
      return [];
    });
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    Object.assign(sql, {
      query: queryMock,
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertMetaCreativeDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "creative-1",
        creativeName: "Creative 1",
        headline: "Headline 1",
        primaryText: "Body 1",
        destinationUrl: "https://example.com/1",
        thumbnailUrl: "https://example.com/image-1.png",
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 10,
        impressions: 100,
        clicks: 5,
        reach: 0,
        frequency: null,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: "snapshot-1",
        payloadJson: { creativeId: "creative-1" },
      },
      {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        campaignId: "cmp-2",
        adsetId: "adset-2",
        adId: "ad-2",
        creativeId: "creative-2",
        creativeName: "Creative 2",
        headline: "Headline 2",
        primaryText: "Body 2",
        destinationUrl: "https://example.com/2",
        thumbnailUrl: "https://example.com/image-2.png",
        assetType: "video",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 120,
        clicks: 6,
        reach: 0,
        frequency: null,
        conversions: 2,
        revenue: 30,
        roas: 2.5,
        cpa: 6,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: "snapshot-2",
        payloadJson: { creativeId: "creative-2" },
      },
    ]);

    const creativeDailyQueries = queries.filter((query) =>
      query.includes("INSERT INTO meta_creative_daily"),
    );
    const creativeDimensionQueries = queries.filter((query) =>
      query.includes("INSERT INTO meta_creative_dimensions"),
    );

    expect(creativeDailyQueries).toHaveLength(1);
    expect(creativeDimensionQueries).toHaveLength(1);
    expect(creativeDailyQueries[0]).toContain("VALUES ($1,$2,$3");
    expect(creativeDailyQueries[0]).toContain("), ($56,$57,$58");
    expect(creativeDailyQueries[0]).toContain(
      "ON CONFLICT (business_id, provider_account_id, date, creative_id) DO UPDATE SET",
    );
  });

  it("batches meta ad daily upserts instead of writing one row per query", async () => {
    const queries: string[] = [];
    const queryMock = vi.fn(async (query: string) => {
      queries.push(query);
      return [];
    });
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    Object.assign(sql, {
      query: queryMock,
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertMetaAdDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 10,
        impressions: 100,
        clicks: 5,
        reach: 80,
        frequency: 1,
        conversions: 1,
        revenue: 20,
        roas: 2,
        cpa: 10,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: "snapshot-1",
        payloadJson: { adId: "ad-1" },
      },
      {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        campaignId: "cmp-2",
        adsetId: "adset-2",
        adId: "ad-2",
        adNameCurrent: "Ad 2",
        adNameHistorical: "Ad 2",
        adStatus: "PAUSED",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 120,
        clicks: 6,
        reach: 90,
        frequency: 1.1,
        conversions: 2,
        revenue: 30,
        roas: 2.5,
        cpa: 6,
        ctr: 5,
        cpc: 2,
        sourceSnapshotId: "snapshot-2",
        payloadJson: { adId: "ad-2" },
      },
    ]);

    const adDailyQueries = queries.filter((query) =>
      query.includes("INSERT INTO meta_ad_daily"),
    );
    const adDimensionQueries = queries.filter((query) =>
      query.includes("INSERT INTO meta_ad_dimensions"),
    );

    expect(adDailyQueries).toHaveLength(1);
    expect(adDimensionQueries).toHaveLength(1);
    expect(adDailyQueries[0]).toContain("VALUES ($1,$2,$3");
    expect(adDailyQueries[0]).toContain("), ($34,$35,$36");
    expect(adDailyQueries[0]).toContain(
      "ON CONFLICT (business_id, provider_account_id, date, ad_id) DO UPDATE SET",
    );
  });

  it("extends the running lease using the requested lease minutes", async () => {
    const queries: string[] = [];
    const calls: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(strings.join(" "));
      calls.push(values);
      return [{ id: "partition-1" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await markMetaPartitionRunning({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 7,
      leaseMinutes: 15,
    });

    expect(result).toBe(true);
    expect(queries.some((query) => query.includes("partition.lease_epoch = "))).toBe(true);
    expect(queries.some((query) => query.includes("FROM sync_runner_leases lease"))).toBe(true);
    expect(queries.some((query) => query.includes("lease.provider_scope = 'meta'"))).toBe(true);
    expect(calls.at(0)).toContain(7);
    expect(calls.at(0)).toContain(15);
  });

  it("replaces only the targeted breakdown_type slice", async () => {
    const templateCalls: unknown[][] = [];
    const queryCalls: string[] = [];
    const sql = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      templateCalls.push(values);
      return [];
    });
    Object.assign(sql, {
      query: vi.fn(async (query: string) => {
        queryCalls.push(query);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await replaceMetaBreakdownDailySlice({
      slice: {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        breakdownType: "age",
      },
      rows: [
        {
          businessId: "biz-1",
          providerAccountId: "acct-1",
          date: "2026-04-03",
          breakdownType: "age",
          breakdownKey: "25-34",
          breakdownLabel: "25-34",
          accountTimezone: "UTC",
          accountCurrency: "USD",
          spend: 10,
          impressions: 100,
          clicks: 5,
          reach: 90,
          frequency: 1.1,
          conversions: 1,
          revenue: 20,
          roas: 2,
          cpa: 10,
          ctr: 5,
          cpc: 2,
          sourceSnapshotId: "snapshot-1",
          truthState: "finalized",
          truthVersion: 1,
          finalizedAt: "2026-04-03T00:00:00.000Z",
          validationStatus: "passed",
          sourceRunId: "run-1",
        },
      ],
      proof: createMetaFinalizationCompletenessProof({
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        scope: "breakdown",
        sourceRunId: "run-1",
        complete: true,
        validationStatus: "passed",
      }),
    });

    expect(templateCalls).toHaveLength(1);
    expect(templateCalls[0]).toContain("age");
    expect(queryCalls.some((query) => query.includes("INSERT INTO meta_breakdown_daily"))).toBe(true);
  });

  it("supports authoritative empty breakdown slice replacement", async () => {
    const templateCalls: unknown[][] = [];
    const queryCalls: string[] = [];
    const sql = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      templateCalls.push(values);
      return [];
    });
    Object.assign(sql, {
      query: vi.fn(async (query: string) => {
        queryCalls.push(query);
        return [];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await replaceMetaBreakdownDailySlice({
      slice: {
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        breakdownType: "country",
      },
      rows: [],
      proof: createMetaFinalizationCompletenessProof({
        businessId: "biz-1",
        providerAccountId: "acct-1",
        date: "2026-04-03",
        scope: "breakdown",
        sourceRunId: "run-2",
        complete: true,
        validationStatus: "passed",
      }),
    });

    expect(templateCalls).toHaveLength(1);
    expect(templateCalls[0]).toContain("country");
    expect(queryCalls).toEqual([]);
  });

  it("classifies dirty recent dates by severity and reason", async () => {
    const sql = vi.fn(async () => [{ present: true }]);
    Object.assign(sql, {
      query: vi.fn(async (query: string) => {
        if (!query.includes("account_spend")) {
          return [
            {
              date: "2026-04-03",
              provider_account_id: "acct-1",
              campaign_count: 1,
              adset_count: 1,
              account_truth_state: "finalized",
              account_validation_status: "failed",
              campaigns_finalized: true,
              adsets_finalized: true,
              finalized_breakdown_type_count: 2,
            },
          ];
        }
        return [
          {
            date: "2026-04-03",
            provider_account_id: "acct-1",
            account_spend: 2,
            campaign_spend: 60,
          },
        ];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await getMetaDirtyRecentDates({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      slowPathDates: ["2026-04-03"],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        providerAccountId: "acct-1",
        date: "2026-04-03",
        severity: "critical",
        reasons: expect.arrayContaining([
          "validation_failed",
          "missing_breakdown",
          "spend_drift",
          "tiny_stale_spend",
        ]),
        validationFailed: true,
        spendDrift: true,
        tinyStaleSpend: true,
      }),
    ]);
  });

  it("skips slow-path drift checks for obvious clean days outside verify dates", async () => {
    const slowQuery = vi.fn(async () => [
      {
        date: "2026-04-03",
        provider_account_id: "acct-1",
        campaign_count: 1,
        adset_count: 1,
        account_truth_state: "finalized",
        account_validation_status: "passed",
        campaigns_finalized: true,
        adsets_finalized: true,
        finalized_breakdown_type_count: 3,
      },
    ]);
    const sql = vi.fn(async () => [{ present: true }]);
    Object.assign(sql, { query: slowQuery });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await getMetaDirtyRecentDates({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
    });

    expect(rows).toEqual([]);
    expect(slowQuery).toHaveBeenCalledTimes(1);
  });

  it("treats successful empty breakdown checkpoints as complete coverage", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("information_schema.columns")) {
        return [{ present: true }];
      }
      return [
        {
          date: "2026-04-03",
          provider_account_id: "acct-1",
          campaign_count: 1,
          adset_count: 1,
          account_truth_state: "finalized",
          account_validation_status: "passed",
          campaigns_finalized: true,
          adsets_finalized: true,
          finalized_breakdown_type_count: 3,
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await getMetaDirtyRecentDates({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
    });

    expect(rows).toEqual([]);
    expect(
      queries.some((query) => query.includes("meta_sync_checkpoints checkpoint")),
    ).toBe(true);
    expect(
      queries.some((query) => query.includes("breakdown:publisher_platform,platform_position,impression_device")),
    ).toBe(true);
  });

  it("returns cooldown and repeated-failure guard data for authoritative slices", async () => {
    const sql = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      if (values.length === 0) {
        return [{ present: true }];
      }
      return [
        {
          active_source: "repair_recent_day",
          last_same_source_attempt_at: "2026-04-06T08:55:00.000Z",
          last_same_source_success_at: "2026-04-06T08:20:00.000Z",
          repeated_failures_24h: 3,
        },
      ];
    });
    Object.assign(sql, {
      query: vi.fn(async () => [
        {
          active_source: "repair_recent_day",
          last_same_source_attempt_at: "2026-04-06T08:55:00.000Z",
          last_same_source_success_at: "2026-04-06T08:20:00.000Z",
          repeated_failures_24h: 3,
        },
      ]),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const guard = await getMetaRecentAuthoritativeSliceGuard({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      date: "2026-04-03",
      source: "repair_recent_day",
    });

    expect(guard).toEqual({
      activeAuthoritativeSource: "repair_recent_day",
      activeAuthoritativePriority: 690,
      lastSameSourceAttemptAt: "2026-04-06T08:55:00.000Z",
      lastSameSourceSuccessAt: "2026-04-06T08:20:00.000Z",
      repeatedFailures24h: 3,
    });
  });

  it("treats guard scope as core-authoritative rather than account-only", async () => {
    const queryCalls: Array<unknown[]> = [];
    const sql = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queryCalls.push(values);
      return [
        {
          active_source: "finalize_day",
          last_same_source_attempt_at: null,
          last_same_source_success_at: null,
          repeated_failures_24h: 0,
        },
      ];
    });
    Object.assign(sql, {
      query: vi.fn(async (_query: string, values: unknown[]) => {
        queryCalls.push(values);
        return [
          {
            active_source: "finalize_day",
            last_same_source_attempt_at: null,
            last_same_source_success_at: null,
            repeated_failures_24h: 0,
          },
        ];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await getMetaRecentAuthoritativeSliceGuard({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      date: "2026-04-03",
      source: "finalize_day",
    });

    expect(queryCalls.some((values) =>
      Array.isArray(values) &&
      values.some(
        (value) =>
          Array.isArray(value) &&
          value.includes("account_daily") &&
          value.includes("campaign_daily") &&
          value.includes("adset_daily"),
      ),
    )).toBe(true);
  });

  it("preserves breakdownOnly only for pure missing_breakdown merges", async () => {
    const sql = vi.fn(async () => [{ present: true }]);
    Object.assign(sql, {
      query: vi.fn(async (query: string) => {
        if (!query.includes("account_spend")) {
          return [
            {
              date: "2026-04-03",
              provider_account_id: "acct-1",
              campaign_count: 1,
              adset_count: 1,
              account_truth_state: "finalized",
              account_validation_status: "passed",
              campaigns_finalized: true,
              adsets_finalized: true,
              finalized_breakdown_type_count: 2,
            },
          ];
        }
        return [
          {
            date: "2026-04-03",
            provider_account_id: "acct-1",
            account_spend: 50,
            campaign_spend: 60,
          },
        ];
      }),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await getMetaDirtyRecentDates({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      slowPathDates: ["2026-04-03"],
    });

    expect(rows[0]?.breakdownOnly).toBe(false);
  });

  it("fails partition completion when the lease epoch is stale", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const completed = await completeMetaPartition({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 9,
      status: "succeeded",
    });

    expect(completed).toBe(false);
    expect(queries.some((query) => query.includes("partition.lease_epoch = input_values.lease_epoch"))).toBe(
      true
    );
  });

  it("closes current-epoch running checkpoints when a partition succeeds", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [
        {
          completed: true,
          closed_checkpoint_groups: [
            {
              checkpointScope: "ad_daily",
              previousPhase: "fetch_raw",
              count: 2,
            },
          ],
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const completed = await completeMetaPartition({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 10,
      status: "succeeded",
    });

    expect(completed).toBe(true);
    expect(queries.some((query) => query.includes("UPDATE meta_sync_checkpoints checkpoint"))).toBe(true);
    expect(queries.some((query) => query.includes("checkpoint.status = 'running'"))).toBe(true);
    expect(queries.some((query) => query.includes("phase = 'finalize'"))).toBe(true);
    expect(console.info).toHaveBeenCalledWith(
      "[meta-sync] partition_success_closed_open_checkpoints",
      expect.objectContaining({
        partitionId: "partition-1",
        workerId: "worker-1",
        leaseEpoch: 10,
        closedCheckpointGroups: [
          {
            checkpointScope: "ad_daily",
            previousPhase: "fetch_raw",
            count: 2,
          },
        ],
      })
    );
  });

  it("completes partition and current attempt run in the same success path", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [
        {
          completed: true,
          run_updated: true,
          closed_running_run_count: 2,
          caller_run_id_was_closed: true,
          closed_running_run_ids: [
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
          ],
          closed_checkpoint_groups: [],
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const completed = await completeMetaPartitionAttempt({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 10,
      runId: "11111111-1111-1111-1111-111111111111",
      partitionStatus: "succeeded",
      runStatus: "succeeded",
      durationMs: 1200,
      finishedAt: "2026-04-04T00:00:00.000Z",
    });

    expect(completed).toEqual(
      expect.objectContaining({
        ok: true,
        runUpdated: true,
        closedRunningRunCount: 2,
        callerRunIdWasClosed: true,
        closedRunningRunIds: [
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
        ],
        closedCheckpointGroups: [],
        observedLatestRunningRunId: null,
        callerRunIdMatchedLatestRunningRunId: null,
      })
    );
    expect(queries.some((query) => query.includes("UPDATE meta_sync_runs run"))).toBe(true);
    expect(queries.some((query) => query.includes("run.status = 'running'"))).toBe(true);
    expect(queries.some((query) => query.includes("run.partition_id = partition.id"))).toBe(true);
    expect(queries.every((query) => !query.includes("run.id = input_values.run_id"))).toBe(true);
    expect(queries[0]).not.toContain("runLeakObservability");
    expect(queries[0]).not.toContain("latest_running_run");
  });

  it("completes failed runs when all optional observability fields are null", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [
        {
          completed: true,
          run_updated: true,
          closed_running_run_count: 1,
          caller_run_id_was_closed: true,
          closed_running_run_ids: ["22222222-2222-2222-2222-222222222222"],
          closed_checkpoint_groups: [],
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const completed = await completeMetaPartitionAttempt({
      partitionId: "partition-2",
      workerId: "worker-1",
      leaseEpoch: 11,
      runId: "22222222-2222-2222-2222-222222222222",
      partitionStatus: "failed",
      runStatus: "failed",
      durationMs: 1400,
      errorClass: "network_error",
      errorMessage: "request failed",
      finishedAt: "2026-04-04T00:01:00.000Z",
    });

    expect(completed).toEqual(
      expect.objectContaining({
        ok: true,
        runUpdated: true,
        closedRunningRunCount: 1,
        callerRunIdWasClosed: true,
        closedRunningRunIds: ["22222222-2222-2222-2222-222222222222"],
        observedLatestRunningRunId: null,
        callerRunIdMatchedLatestRunningRunId: null,
      })
    );
    expect(queries[0]).not.toContain("runLeakObservability");
    expect(queries[0]).not.toContain("latest_running_run");
  });

  it("does not let observability write failures block completion", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          completed: true,
          run_updated: true,
          closed_running_run_count: 2,
          caller_run_id_was_closed: true,
          closed_running_run_ids: [
            "33333333-3333-3333-3333-333333333333",
            "77777777-7777-7777-7777-777777777777",
          ],
          closed_checkpoint_groups: [],
        },
      ])
      .mockResolvedValueOnce([{ latest_running_run_id: "33333333-3333-3333-3333-333333333333" }])
      .mockRejectedValueOnce(new Error("observability update failed"));
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const completed = await completeMetaPartitionAttempt({
      partitionId: "partition-3",
      workerId: "worker-1",
      leaseEpoch: 12,
      runId: "33333333-3333-3333-3333-333333333333",
      partitionStatus: "succeeded",
      runStatus: "succeeded",
      durationMs: 1600,
      finishedAt: "2026-04-04T00:02:00.000Z",
      lane: "core",
      scope: "account_daily",
      observabilityPath: "primary",
    });

    expect(completed).toEqual(
      expect.objectContaining({
        ok: true,
        runUpdated: true,
        closedRunningRunCount: 2,
        callerRunIdWasClosed: true,
        closedRunningRunIds: [
          "33333333-3333-3333-3333-333333333333",
          "77777777-7777-7777-7777-777777777777",
        ],
        observedLatestRunningRunId: null,
        callerRunIdMatchedLatestRunningRunId: null,
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[meta-sync] partition_completion_observability_failed",
      expect.objectContaining({
        partitionId: "partition-3",
        runId: "33333333-3333-3333-3333-333333333333",
        workerId: "worker-1",
        leaseEpoch: 12,
        lane: "core",
        scope: "account_daily",
        partitionStatus: "succeeded",
        runStatusAfter: "succeeded",
        pathKind: "primary",
        message: "observability update failed",
      })
    );
  });

  it("casts callerRunIdMatchedLatestRunningRunId explicitly in the non-blocking observability write", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      if (queries.length === 1) {
        return [
          {
            completed: true,
            run_updated: true,
            closed_running_run_count: 1,
            caller_run_id_was_closed: true,
            closed_running_run_ids: ["44444444-4444-4444-4444-444444444444"],
            closed_checkpoint_groups: [],
          },
        ];
      }
      if (queries.length === 2) {
        return [{ latest_running_run_id: "44444444-4444-4444-4444-444444444444" }];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await completeMetaPartitionAttempt({
      partitionId: "partition-4",
      workerId: "worker-1",
      leaseEpoch: 13,
      runId: "44444444-4444-4444-4444-444444444444",
      partitionStatus: "succeeded",
      runStatus: "succeeded",
      durationMs: 1700,
      finishedAt: "2026-04-04T00:03:00.000Z",
      lane: "core",
      scope: "account_daily",
      observabilityPath: "primary",
    });

    expect(queries[2]).toContain("'callerRunIdMatchedLatestRunningRunId', ");
    expect(queries[2]).toContain("::boolean");
  });

  it("does not run child checkpoint closure when partition completion is non-success", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [
        {
          completed: true,
          run_updated: false,
          closed_running_run_count: 0,
          caller_run_id_was_closed: null,
          closed_running_run_ids: [],
          closed_checkpoint_groups: [],
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const completed = await completeMetaPartition({
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 10,
      status: "failed",
      lastError: "network",
    });

    expect(completed).toBe(true);
    expect(console.info).not.toHaveBeenCalledWith(
      "[meta-sync] partition_success_closed_open_checkpoints",
      expect.anything()
    );
  });

  it("keeps active leased dead-letter partitions out of replay", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await replayMetaDeadLetterPartitions({
      businessId: "biz-1",
      scope: "ad_daily",
    });

    expect(result.outcome).toBe("no_matching_partitions");
    expect(queries.some((query) => query.includes("COALESCE(lease_expires_at, now() - interval '1 second') > now()"))).toBe(true);
    expect(queries.some((query) => query.includes("COALESCE(lease_expires_at, now() - interval '1 second') <= now()"))).toBe(true);
  });

  it("returns skipped_active_lease when only actively leased partitions match replay", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ id: "partition-1" }])
      .mockResolvedValueOnce([{ id: "partition-1" }])
      .mockResolvedValueOnce([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await replayMetaDeadLetterPartitions({
      businessId: "biz-1",
      scope: "ad_daily",
    });

    expect(result.outcome).toBe("skipped_active_lease");
    expect(result.matchedCount).toBe(1);
    expect(result.changedCount).toBe(0);
    expect(result.skippedActiveLeaseCount).toBe(1);
  });

  it("keeps recently progressing partitions leased during cleanup", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM meta_sync_partitions partition") && query.includes("partition.status IN ('leased', 'running')")) {
        return [
          {
            id: "partition-1",
            lane: "core",
            scope: "account_daily",
            updated_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            checkpoint_scope: "account_daily",
            phase: "fetch_raw",
            page_index: 0,
            checkpoint_updated_at: new Date().toISOString(),
            has_matching_runner_lease: true,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupMetaPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(0);
    expect(result.candidateCount).toBe(1);
    expect(result.aliveSlowCount).toBe(1);
    expect(result.preservedByReason).toEqual({
      recentCheckpointProgress: 1,
      matchingRunnerLeasePresent: 0,
      leaseNotExpired: 0,
    });
    expect(result.reclaimReasons.stalledReclaimable).toEqual([]);
  });

  it("reclaims expired partitions when progress is stale and no matching runner lease remains", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("FROM meta_sync_partitions partition") && query.includes("partition.status IN ('leased', 'running')")) {
        return [
          {
            id: "partition-1",
            lane: "core",
            scope: "account_daily",
            updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            lease_expires_at: new Date(Date.now() - 2 * 60_000).toISOString(),
            checkpoint_scope: "account_daily",
            phase: "fetch_raw",
            page_index: 0,
            checkpoint_updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            has_matching_runner_lease: false,
          },
        ];
      }
      if (query.includes("UPDATE meta_sync_runs run") && query.includes("partitionReclaimed")) {
        return [{ id: "run-1" }];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupMetaPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(1);
    expect(result.aliveSlowCount).toBe(0);
    expect(result.reconciledRunCount).toBe(1);
    expect(result.preservedByReason).toEqual({
      recentCheckpointProgress: 0,
      matchingRunnerLeasePresent: 0,
      leaseNotExpired: 0,
    });
    expect(result.reclaimReasons.stalledReclaimable).toEqual(["lease_expired_no_progress"]);
    expect(
      queries.some((query) => query.includes("lease.lease_owner = partition.lease_owner"))
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.includes("COALESCE(checkpoint.lease_epoch, 0) = COALESCE(partition.lease_epoch, 0)")
      )
    ).toBe(true);
    expect(
      queries.some((query) => query.includes("AND run.partition_id = ANY(") && query.includes("partitionReclaimed"))
    ).toBe(true);
  });

  it("does not let an unrelated active runner lease protect a stale partition", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("FROM meta_sync_partitions partition") && query.includes("partition.status IN ('leased', 'running')")) {
        return [
          {
            id: "partition-1",
            lane: "maintenance",
            scope: "adset_daily",
            updated_at: new Date(Date.now() - 20 * 60_000).toISOString(),
            started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
            lease_owner: "meta-worker:old",
            lease_expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
            checkpoint_scope: "adset_daily",
            phase: "fetch_raw",
            page_index: 1,
            checkpoint_updated_at: new Date(Date.now() - 20 * 60_000).toISOString(),
            has_matching_runner_lease: false,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupMetaPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(1);
    expect(
      queries.some((query) => query.includes("lease.lease_owner = partition.lease_owner"))
    ).toBe(true);
  });

  it("reclaims non-expired leases when no runner ownership or checkpoint progress remains", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM meta_sync_partitions partition") && query.includes("partition.status IN ('leased', 'running')")) {
        return [
          {
            id: "partition-1",
            lane: "extended",
            scope: "creative_daily",
            updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            lease_owner: "sync-worker:1",
            lease_expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
            checkpoint_scope: "creative_daily",
            phase: "fetch_raw",
            page_index: 0,
            checkpoint_updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
            has_matching_runner_lease: false,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupMetaPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(1);
    expect(result.aliveSlowCount).toBe(0);
    expect(result.preservedByReason).toEqual({
      recentCheckpointProgress: 0,
      matchingRunnerLeasePresent: 0,
      leaseNotExpired: 0,
    });
    expect(result.reclaimReasons.stalledReclaimable).toEqual([
      "runner_lease_missing_no_progress",
    ]);
  });

  it("preserves fresh non-expired leases during the initial reclaim grace window", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM meta_sync_partitions partition") && query.includes("partition.status IN ('leased', 'running')")) {
        return [
          {
            id: "partition-1",
            lane: "maintenance",
            scope: "account_daily",
            updated_at: new Date(Date.now() - 30_000).toISOString(),
            started_at: null,
            lease_owner: "sync-worker:1",
            lease_expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
            checkpoint_scope: null,
            phase: null,
            page_index: 0,
            checkpoint_updated_at: null,
            has_matching_runner_lease: false,
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await cleanupMetaPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(result.stalePartitionCount).toBe(0);
    expect(result.aliveSlowCount).toBe(1);
    expect(result.preservedByReason).toEqual({
      recentCheckpointProgress: 0,
      matchingRunnerLeasePresent: 0,
      leaseNotExpired: 1,
    });
  });

  it("mirrors succeeded parent status when cleaning invalid running runs", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (query.includes("FROM meta_sync_partitions partition") && query.includes("partition.status IN ('leased', 'running')")) {
        return [];
      }
      if (query.includes("WITH stale_candidates AS")) {
        return [{ id: "run-1" }];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await cleanupMetaPartitionOrchestration({
      businessId: "biz-1",
      staleLeaseMinutes: 8,
    });

    expect(queries.some((query) => query.includes("partition_already_succeeded"))).toBe(true);
    expect(queries.some((query) => query.includes("partition_already_dead_letter"))).toBe(true);
    expect(queries.some((query) => query.includes("THEN 'succeeded'"))).toBe(true);
    expect(queries.some((query) => query.includes("THEN 'cancelled'"))).toBe(true);
  });

  it("reuses the existing running row when concurrent run creation conflicts on partition_id", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      if (queries.length === 1) return [];
      return [{ id: "existing-running-run-id" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const runId = await createMetaSyncRun({
      partitionId: "partition-dup",
      businessId: "biz-1",
      providerAccountId: "acct-1",
      lane: "core",
      scope: "account_daily",
      partitionDate: "2026-04-04",
      status: "running",
      workerId: "worker-1",
      attemptCount: 2,
      metaJson: { source: "test" },
    });

    expect(runId).toBe("existing-running-run-id");
    expect(queries[0]).toContain("UPDATE meta_sync_runs");
    expect(queries[0]).toContain("status = 'running'");
    expect(queries[1]).toContain("ON CONFLICT (partition_id)");
    expect(queries[1]).toContain("WHERE status = 'running'");
    expect(queries[1]).toContain(
      "attempt_count = GREATEST(meta_sync_runs.attempt_count, EXCLUDED.attempt_count)"
    );
  });

  it("creates authoritative manifest, candidate, and reconciliation records", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "manifest-1",
          business_id: "biz-1",
          provider_account_id: "acct-1",
          day: "2026-04-05",
          surface: "account_daily",
          account_timezone: "America/Los_Angeles",
          source_kind: "finalize_day",
          source_window_kind: "d_minus_1",
          run_id: "run-1",
          fetch_status: "running",
          fresh_start_applied: true,
          checkpoint_reset_applied: true,
          raw_snapshot_watermark: "snap-42",
          source_spend: 10,
          validation_basis_version: "v1",
          meta_json: { step: "fetch" },
          started_at: "2026-04-06T00:00:00.000Z",
          completed_at: null,
          created_at: "2026-04-06T00:00:00.000Z",
          updated_at: "2026-04-06T00:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([{ next_candidate_version: 3 }])
      .mockResolvedValueOnce([
        {
          id: "slice-3",
          business_id: "biz-1",
          provider_account_id: "acct-1",
          day: "2026-04-05",
          surface: "account_daily",
          manifest_id: "manifest-1",
          candidate_version: 3,
          state: "finalizing",
          truth_state: "finalized",
          validation_status: "pending",
          status: "staging",
          staged_row_count: 12,
          aggregated_spend: 10,
          validation_summary: { fresh: true },
          source_run_id: "run-1",
          stage_started_at: "2026-04-06T00:01:00.000Z",
          stage_completed_at: null,
          published_at: null,
          superseded_at: null,
          created_at: "2026-04-06T00:01:00.000Z",
          updated_at: "2026-04-06T00:01:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "event-1",
          business_id: "biz-1",
          provider_account_id: "acct-1",
          day: "2026-04-05",
          surface: "account_daily",
          slice_version_id: "slice-3",
          manifest_id: "manifest-1",
          event_kind: "validation_started",
          severity: "info",
          source_spend: 10,
          warehouse_account_spend: 10,
          warehouse_campaign_spend: 10,
          tolerance_applied: 0.01,
          result: "passed",
          details_json: { source: "meta" },
          created_at: "2026-04-06T00:02:00.000Z",
        },
      ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const manifest = await createMetaAuthoritativeSourceManifest({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "account_daily",
      accountTimezone: "America/Los_Angeles",
      sourceKind: "finalize_day",
      sourceWindowKind: "d_minus_1",
      runId: "run-1",
      fetchStatus: "running",
      freshStartApplied: true,
      checkpointResetApplied: true,
      rawSnapshotWatermark: "snap-42",
      sourceSpend: 10,
      validationBasisVersion: "v1",
      metaJson: { step: "fetch" },
      startedAt: "2026-04-06T00:00:00.000Z",
    });

    const candidateVersion = await reserveNextMetaAuthoritativeCandidateVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "account_daily",
    });

    const slice = await createMetaAuthoritativeSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "account_daily",
      manifestId: "manifest-1",
      candidateVersion,
      state: "finalizing",
      truthState: "finalized",
      validationStatus: "pending",
      status: "staging",
      stagedRowCount: 12,
      aggregatedSpend: 10,
      validationSummary: { fresh: true },
      sourceRunId: "run-1",
      stageStartedAt: "2026-04-06T00:01:00.000Z",
    });

    const event = await createMetaAuthoritativeReconciliationEvent({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "account_daily",
      sliceVersionId: "slice-3",
      manifestId: "manifest-1",
      eventKind: "validation_started",
      severity: "info",
      sourceSpend: 10,
      warehouseAccountSpend: 10,
      warehouseCampaignSpend: 10,
      toleranceApplied: 0.01,
      result: "passed",
      detailsJson: { source: "meta" },
    });

    expect(manifest?.fetchStatus).toBe("running");
    expect(candidateVersion).toBe(3);
    expect(slice?.candidateVersion).toBe(3);
    expect(event?.result).toBe("passed");
  });

  it("publishes a candidate through the active publication pointer", async () => {
    const templateCalls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      templateCalls.push(strings.join(" "));
      return [
        {
          id: "pub-1",
          business_id: "biz-1",
          provider_account_id: "acct-1",
          day: "2026-04-05",
          surface: "campaign_daily",
          active_slice_version_id: "slice-4",
          published_by_run_id: "run-4",
          publication_reason: "manual_refresh",
          published_at: "2026-04-06T00:03:00.000Z",
          created_at: "2026-04-06T00:03:00.000Z",
          updated_at: "2026-04-06T00:03:00.000Z",
        },
      ];
    });
    Object.assign(sql, {
      query: vi.fn(async () => []),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const publication = await publishMetaAuthoritativeSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "campaign_daily",
      sliceVersionId: "slice-4",
      publishedByRunId: "run-4",
      publicationReason: "manual_refresh",
      publishStartedAt: "2026-04-06T00:02:30.000Z",
    });

    expect(publication?.activeSliceVersionId).toBe("slice-4");
    expect(templateCalls.some((query) => query.includes("UPDATE meta_authoritative_slice_versions"))).toBe(true);
    expect(
      templateCalls.some((query) =>
        query.includes("publish_started_at = COALESCE"),
      ),
    ).toBe(true);
    expect(
      templateCalls.some((query) =>
        query.includes("INSERT INTO meta_authoritative_publication_pointers"),
      ),
    ).toBe(true);
  });

  it("preserves live semantics when publishing a provisional slice", async () => {
    const templateCalls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      templateCalls.push(strings.join(" "));
      return [
        {
          id: "pub-live-1",
          business_id: "biz-1",
          provider_account_id: "acct-1",
          day: "2026-04-08",
          surface: "account_daily",
          active_slice_version_id: "slice-live-1",
          published_by_run_id: "run-live-1",
          publication_reason: "today_refresh",
          published_at: "2026-04-08T18:03:00.000Z",
          created_at: "2026-04-08T18:03:00.000Z",
          updated_at: "2026-04-08T18:03:00.000Z",
        },
      ];
    });
    Object.assign(sql, {
      query: vi.fn(async () => []),
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const publication = await publishMetaAuthoritativeSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-08",
      surface: "account_daily",
      sliceVersionId: "slice-live-1",
      publishedByRunId: "run-live-1",
      publicationReason: "today_refresh",
    });

    expect(publication?.activeSliceVersionId).toBe("slice-live-1");
    expect(templateCalls.some((query) => query.includes("ELSE 'live'"))).toBe(true);
    expect(
      templateCalls.some((query) =>
        query.includes("ELSE COALESCE(validation_status, 'pending')"),
      ),
    ).toBe(true);
  });

  it("reuses an existing slice version for the same source run id", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM meta_authoritative_slice_versions") && query.includes("source_run_id")) {
        return [
          {
            id: "slice-existing",
            business_id: "biz-1",
            provider_account_id: "acct-1",
            day: "2026-04-05",
            surface: "account_daily",
            manifest_id: "manifest-1",
            candidate_version: 4,
            state: "finalizing",
            truth_state: "finalized",
            validation_status: "pending",
            status: "staging",
            staged_row_count: 12,
            aggregated_spend: 42.5,
            validation_summary: { retried: true },
            source_run_id: "run-1",
            stage_started_at: "2026-04-06T00:01:00.000Z",
            stage_completed_at: null,
            published_at: null,
            superseded_at: null,
            created_at: "2026-04-06T00:01:00.000Z",
            updated_at: "2026-04-06T00:01:00.000Z",
          },
        ];
      }
      throw new Error(`Unexpected query: ${query}`);
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const slice = await createMetaAuthoritativeSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "account_daily",
      manifestId: "manifest-1",
      state: "finalizing",
      truthState: "finalized",
      validationStatus: "pending",
      status: "staging",
      stagedRowCount: 12,
      aggregatedSpend: 42.5,
      validationSummary: {},
      sourceRunId: "run-1",
      stageStartedAt: "2026-04-06T00:01:00.000Z",
    });

    expect(slice?.id).toBe("slice-existing");
    expect(slice?.candidateVersion).toBe(4);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("retries candidate version creation after a unique conflict", async () => {
    let insertAttempts = 0;
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM meta_authoritative_slice_versions") && query.includes("source_run_id")) {
        return [];
      }
      if (query.includes("SELECT COALESCE(MAX(candidate_version), 0) + 1")) {
        return [{ next_candidate_version: insertAttempts === 0 ? 2 : 3 }];
      }
      if (query.includes("INSERT INTO meta_authoritative_slice_versions")) {
        insertAttempts += 1;
        if (insertAttempts === 1) {
          const error = new Error(
            'duplicate key value violates unique constraint "meta_authoritative_slice_vers_business_id_provider_account__key"',
          ) as Error & { code?: string; constraint?: string };
          error.code = "23505";
          error.constraint = "meta_authoritative_slice_vers_business_id_provider_account__key";
          throw error;
        }
        return [
          {
            id: "slice-3",
            business_id: "biz-1",
            provider_account_id: "acct-1",
            day: "2026-04-05",
            surface: "campaign_daily",
            manifest_id: "manifest-1",
            candidate_version: 3,
            state: "finalizing",
            truth_state: "finalized",
            validation_status: "pending",
            status: "staging",
            staged_row_count: 9,
            aggregated_spend: 12.5,
            validation_summary: {},
            source_run_id: "run-2",
            stage_started_at: "2026-04-06T00:01:00.000Z",
            stage_completed_at: null,
            published_at: null,
            superseded_at: null,
            created_at: "2026-04-06T00:01:00.000Z",
            updated_at: "2026-04-06T00:01:00.000Z",
          },
        ];
      }
      throw new Error(`Unexpected query: ${query}`);
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const slice = await createMetaAuthoritativeSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "campaign_daily",
      manifestId: "manifest-1",
      state: "finalizing",
      truthState: "finalized",
      validationStatus: "pending",
      status: "staging",
      stagedRowCount: 9,
      aggregatedSpend: 12.5,
      validationSummary: {},
      sourceRunId: "run-2",
      stageStartedAt: "2026-04-06T00:01:00.000Z",
    });

    expect(slice?.id).toBe("slice-3");
    expect(slice?.candidateVersion).toBe(3);
    expect(insertAttempts).toBe(2);
  });

  it("looks up the active published slice version for a historical surface", async () => {
    const sql = vi.fn(async () => [
      {
        id: "pub-1",
        business_id: "biz-1",
        provider_account_id: "acct-1",
        day: "2026-04-05",
        surface: "adset_daily",
        active_slice_version_id: "slice-9",
        published_by_run_id: "run-9",
        publication_reason: "finalize_day",
        published_at: "2026-04-06T00:03:00.000Z",
        created_at: "2026-04-06T00:03:00.000Z",
        updated_at: "2026-04-06T00:03:00.000Z",
        candidate_version: 9,
        state: "finalized_verified",
        truth_state: "finalized",
        validation_status: "passed",
        status: "published",
        manifest_id: "manifest-9",
        staged_row_count: 44,
        aggregated_spend: 123.45,
        validation_summary: { passed: true },
        source_run_id: "run-9",
        stage_started_at: "2026-04-06T00:01:00.000Z",
        stage_completed_at: "2026-04-06T00:02:00.000Z",
        publish_started_at: "2026-04-06T00:02:50.000Z",
        superseded_at: null,
        slice_created_at: "2026-04-06T00:01:00.000Z",
        slice_updated_at: "2026-04-06T00:03:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await getMetaActivePublishedSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "adset_daily",
    });

    expect(result?.publication.activeSliceVersionId).toBe("slice-9");
    expect(result?.sliceVersion.status).toBe("published");
    expect(result?.sliceVersion.candidateVersion).toBe(9);
    expect(result?.sliceVersion.publishStartedAt).toBe("2026-04-06T00:02:50.000Z");
  });

  it("supersedes older candidate versions for the same publication key", async () => {
    const sql = vi.fn(async () => [
      {
        id: "slice-old",
        business_id: "biz-1",
        provider_account_id: "acct-1",
        day: "2026-04-05",
        surface: "account_daily",
        manifest_id: "manifest-1",
        candidate_version: 1,
        state: "superseded",
        truth_state: "finalized",
        validation_status: "passed",
        status: "superseded",
        staged_row_count: 1,
        aggregated_spend: 1,
        validation_summary: {},
        source_run_id: "run-1",
        stage_started_at: null,
        stage_completed_at: null,
        published_at: null,
        superseded_at: "2026-04-06T00:04:00.000Z",
        created_at: "2026-04-06T00:01:00.000Z",
        updated_at: "2026-04-06T00:04:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await supersedeMetaAuthoritativeSliceVersions({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-05",
      surface: "account_daily",
      excludeSliceVersionId: "slice-new",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("superseded");
    expect(rows[0]?.state).toBe("superseded");
  });
  it("builds a business-wide authoritative ops snapshot", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("GROUP BY fetch_status")) {
        return [
          { fetch_status: "completed", count: 3 },
          { fetch_status: "failed", count: 1 },
          { fetch_status: "pending", count: 1 },
        ];
      }
      if (query.includes("WITH published_days AS")) {
        return [
          {
            queued: 2,
            leased: 1,
            retryable_failed: 1,
            dead_letter: 1,
            stale_leases: 1,
            repair_backlog: 2,
            published: 4,
          },
        ];
      }
      if (query.includes("ORDER BY pointer.published_at DESC")) {
        return [
          {
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "account_daily",
            published_at: "2026-04-06T00:10:00.000Z",
            source_kind: "finalize_day",
            manifest_fetch_status: "completed",
            verification_state: "finalized_verified",
          },
        ];
      }
      if (query.includes("LIMIT 20")) {
        return [
          {
            provider_account_id: "act_2",
            day: "2026-04-05",
            surface: "campaign_daily",
            result: "repair_required",
            event_kind: "totals_mismatch",
            severity: "error",
            reason: "campaign drift",
            created_at: "2026-04-06T00:11:00.000Z",
          },
        ];
      }
      if (query.includes("WITH manifest_accounts AS")) {
        return [
          { provider_account_id: "act_1", account_timezone: "UTC" },
          { provider_account_id: "act_2", account_timezone: "UTC" },
        ];
      }
      if (query.includes("latest_failure_result")) {
        return [
          {
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "account_daily",
            published_at: "2026-04-06T00:10:00.000Z",
            validation_status: "passed",
            latest_failure_result: null,
          },
          {
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "campaign_daily",
            published_at: "2026-04-06T00:10:00.000Z",
            validation_status: "passed",
            latest_failure_result: null,
          },
          {
            provider_account_id: "act_2",
            day: "2026-04-05",
            surface: "account_daily",
            published_at: null,
            validation_status: null,
            latest_failure_result: "repair_required",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const snapshot = await getMetaAuthoritativeBusinessOpsSnapshot({
      businessId: "biz-1",
      latestPublishLimit: 5,
    });

    expect(snapshot.manifestCounts.total).toBe(5);
    expect(snapshot.progression.published).toBe(4);
    expect(snapshot.validationFailures24h).toBe(1);
    expect(snapshot.latestPublishes[0]).toMatchObject({
      providerAccountId: "act_1",
      verificationState: "finalized_verified",
    });
    expect(snapshot.d1FinalizeSla.totalAccounts).toBe(2);
  });

  it("does not treat planner-published d-1 state as finalized without a published pointer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"));

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("GROUP BY fetch_status")) {
        return [{ fetch_status: "completed", count: 2 }];
      }
      if (query.includes("WITH published_days AS")) {
        return [
          {
            queued: 0,
            leased: 0,
            retryable_failed: 0,
            dead_letter: 0,
            stale_leases: 0,
            repair_backlog: 0,
            published: 0,
          },
        ];
      }
      if (query.includes("ORDER BY pointer.published_at DESC")) {
        return [];
      }
      if (query.includes("LIMIT 20")) {
        return [];
      }
      if (query.includes("WITH manifest_accounts AS")) {
        return [{ provider_account_id: "act_1", account_timezone: "UTC" }];
      }
      if (query.includes("latest_failure_result")) {
        return [];
      }
      if (query.includes("FROM meta_authoritative_day_state")) {
        return [
          {
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "account_daily",
            state: "published",
            published_at: "2026-04-06T00:10:00.000Z",
          },
          {
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "campaign_daily",
            state: "published",
            published_at: "2026-04-06T00:10:00.000Z",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    try {
      const snapshot = await getMetaAuthoritativeBusinessOpsSnapshot({
        businessId: "biz-1",
        latestPublishLimit: 5,
      });

      expect(snapshot.d1FinalizeSla.accounts[0]).toMatchObject({
        providerAccountId: "act_1",
        verificationState: "processing",
        publishedAt: null,
        breached: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds day-level authoritative verification with manifest and publication provenance", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("WITH latest_manifests AS")) {
        return [
          {
            id: "manifest-1",
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "account_daily",
            account_timezone: "UTC",
            source_kind: "manual_refresh",
            source_window_kind: "historical",
            run_id: "run-1",
            fetch_status: "completed",
            fresh_start_applied: false,
            checkpoint_reset_applied: false,
            raw_snapshot_watermark: null,
            source_spend: 12,
            validation_basis_version: "v1",
            meta_json: {},
            started_at: "2026-04-06T00:00:00.000Z",
            completed_at: "2026-04-06T00:01:00.000Z",
            created_at: "2026-04-06T00:00:00.000Z",
            updated_at: "2026-04-06T00:01:00.000Z",
          },
        ];
      }
      if (query.includes("result IN ('failed', 'repair_required')")) {
        return [
          {
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "account_daily",
            result: "failed",
            event_kind: "totals_mismatch",
            severity: "error",
            reason: "source mismatch",
            created_at: "2026-04-06T00:02:00.000Z",
          },
        ];
      }
      if (query.includes("queued_partitions")) {
        return [
          {
            queued_partitions: 1,
            leased_partitions: 0,
            stale_leases: 0,
            dead_letters: 1,
            repair_backlog: 2,
          },
        ];
      }
      if (query.includes("WITH latest_slice AS")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "account_daily",
            latest_slice_id: "slice-1",
            latest_state: "failed",
            latest_status: "failed",
            latest_validation_status: "failed",
            latest_slice_published_at: null,
            source_fetched_at: "2026-04-06T00:01:00.000Z",
            active_slice_version_id: null,
            published_at: null,
            published_state: null,
            published_status: null,
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-05",
            surface: "campaign_daily",
            latest_slice_id: "slice-2",
            latest_state: "failed",
            latest_status: "failed",
            latest_validation_status: "failed",
            latest_slice_published_at: null,
            source_fetched_at: "2026-04-06T00:01:00.000Z",
            active_slice_version_id: null,
            published_at: null,
            published_state: null,
            published_status: null,
          },
        ];
      }
      if (query.includes("FROM meta_authoritative_publication_pointers pointer")) {
        return [];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const report = await getMetaAuthoritativeDayVerification({
      businessId: "biz-1",
      providerAccountId: "act_1",
      day: "2026-04-05",
    });

    expect(report.businessId).toBe("biz-1");
    expect(report.sourceManifestState).toBe("completed");
    expect(report.verificationState).toBe("failed");
    expect(report.lastFailure?.reason).toBe("source mismatch");
    expect(report.deadLetters).toBe(1);
    expect(report.repairBacklog).toBe(2);
  });

  it("normalizes date-backed publish timestamps in the business ops snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("GROUP BY fetch_status")) {
        return [{ fetch_status: "completed", count: 2 }];
      }
      if (query.includes("WITH published_days AS")) {
        return [
          {
            queued: 0,
            leased: 0,
            retryable_failed: 0,
            dead_letter: 0,
            stale_leases: 0,
            repair_backlog: 0,
            published: 2,
          },
        ];
      }
      if (query.includes("manifest.fetch_status AS manifest_fetch_status")) {
        return [
          {
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "account_daily",
            published_at: "2026-04-08T00:10:00.000Z",
            source_kind: "finalize_day",
            manifest_fetch_status: "completed",
            verification_state: "finalized_verified",
          },
        ];
      }
      if (query.includes("created_at > now() - interval '24 hours'")) {
        return [];
      }
      if (query.includes("WITH manifest_accounts AS")) {
        return [
          {
            provider_account_id: "act_1",
            account_timezone: "UTC",
          },
        ];
      }
      if (query.includes("latest_failure.result AS latest_failure_result")) {
        return [
          {
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "account_daily",
            validation_status: "passed",
            latest_failure_result: null,
            published_at: new Date("2026-04-08T00:10:00.000Z"),
          },
          {
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "campaign_daily",
            validation_status: "passed",
            latest_failure_result: null,
            published_at: new Date("2026-04-08T00:11:00.000Z"),
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const snapshot = await getMetaAuthoritativeBusinessOpsSnapshot({
      businessId: "biz-1",
      latestPublishLimit: 5,
    });

    try {
      expect(snapshot.d1FinalizeSla.totalAccounts).toBe(1);
      expect(snapshot.d1FinalizeSla.accounts[0]).toMatchObject({
        providerAccountId: "act_1",
        publishedAt: "2026-04-08T00:11:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats SQL date objects as local calendar dates in published verification", async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "Europe/Istanbul";

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("WITH latest_slice AS")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: new Date("2026-04-06T21:00:00.000Z"),
            surface: "account_daily",
            latest_slice_id: "slice-1",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2026-04-07T00:10:00.000Z",
            source_fetched_at: "2026-04-07T00:01:00.000Z",
            active_slice_version_id: "slice-1",
            published_at: "2026-04-07T00:10:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: new Date("2026-04-06T21:00:00.000Z"),
            surface: "campaign_daily",
            latest_slice_id: "slice-2",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2026-04-07T00:11:00.000Z",
            source_fetched_at: "2026-04-07T00:01:00.000Z",
            active_slice_version_id: "slice-2",
            published_at: "2026-04-07T00:11:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    try {
      const summary = await getMetaPublishedVerificationSummary({
        businessId: "biz-1",
        providerAccountIds: ["act_1"],
        startDate: "2026-04-07",
        endDate: "2026-04-07",
        surfaces: ["account_daily", "campaign_daily"],
      });

      expect(summary.verificationState).toBe("finalized_verified");
      expect(summary.truthReady).toBe(true);
      expect(summary.completedCoreDays).toBe(1);
      expect(summary.publishedSlices).toBe(2);
      expect(summary.publishedKeysBySurface.account_daily).toEqual(["act_1:2026-04-07"]);
      expect(summary.publishedKeysBySurface.campaign_daily).toEqual(["act_1:2026-04-07"]);
    } finally {
      process.env.TZ = previousTz;
    }
  });

  it("treats current-day published slices as processing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T18:00:00.000Z"));

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("WITH latest_slice AS")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-08",
            surface: "account_daily",
            latest_slice_id: "slice-1",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2026-04-08T17:55:00.000Z",
            source_fetched_at: "2026-04-08T17:50:00.000Z",
            active_slice_version_id: "slice-1",
            published_at: "2026-04-08T17:55:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
        ];
      }
      if (query.includes("WITH manifest_accounts AS")) {
        return [
          {
            provider_account_id: "act_1",
            account_timezone: "America/Anchorage",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    try {
      const summary = await getMetaPublishedVerificationSummary({
        businessId: "biz-1",
        providerAccountIds: ["act_1"],
        startDate: "2026-04-08",
        endDate: "2026-04-08",
        surfaces: ["account_daily"],
      });

      expect(summary.verificationState).toBe("processing");
      expect(summary.truthReady).toBe(false);
      expect(summary.publishedSlices).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies completed manifests without publication as blocked in published verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("WITH latest_slice AS")) {
        return [];
      }
      if (query.includes("WITH latest_manifests AS")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "account_daily",
            id: "manifest-1",
            fetch_status: "completed",
            completed_at: "2026-04-08T00:01:00.000Z",
            run_id: "run-1",
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "campaign_daily",
            id: "manifest-2",
            fetch_status: "completed",
            completed_at: "2026-04-08T00:02:00.000Z",
            run_id: "run-1",
          },
        ];
      }
      if (query.includes("WITH latest_failures AS")) {
        return [];
      }
      if (
        query.includes("FROM meta_authoritative_day_state") &&
        query.includes("diagnosis_code")
      ) {
        return [];
      }
      if (query.includes("partition_date AS day")) {
        return [];
      }
      if (query.includes("WITH manifest_accounts AS")) {
        return [
          {
            provider_account_id: "act_1",
            account_timezone: "UTC",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    try {
      const summary = await getMetaPublishedVerificationSummary({
        businessId: "biz-1",
        providerAccountIds: ["act_1"],
        startDate: "2026-04-07",
        endDate: "2026-04-07",
        surfaces: ["account_daily", "campaign_daily"],
      });

      expect(summary.verificationState).toBe("blocked");
      expect(summary.truthReady).toBe(false);
      expect(summary.reasonCounts.blocked).toBe(2);
      expect(summary.reasonCounts.publication_pointer_missing_after_finalize).toBe(
        2,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not require breakdown publication beyond the breakdown horizon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("WITH latest_slice AS")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2025-03-09",
            surface: "account_daily",
            latest_slice_id: "slice-1",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2025-03-10T00:10:00.000Z",
            source_fetched_at: "2025-03-10T00:01:00.000Z",
            active_slice_version_id: "slice-1",
            published_at: "2025-03-10T00:10:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2025-03-09",
            surface: "campaign_daily",
            latest_slice_id: "slice-2",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2025-03-10T00:11:00.000Z",
            source_fetched_at: "2025-03-10T00:01:00.000Z",
            active_slice_version_id: "slice-2",
            published_at: "2025-03-10T00:11:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2025-03-09",
            surface: "adset_daily",
            latest_slice_id: "slice-3",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2025-03-10T00:12:00.000Z",
            source_fetched_at: "2025-03-10T00:01:00.000Z",
            active_slice_version_id: "slice-3",
            published_at: "2025-03-10T00:12:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2025-03-09",
            surface: "ad_daily",
            latest_slice_id: "slice-4",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2025-03-10T00:13:00.000Z",
            source_fetched_at: "2025-03-10T00:01:00.000Z",
            active_slice_version_id: "slice-4",
            published_at: "2025-03-10T00:13:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
        ];
      }
      if (query.includes("WITH manifest_accounts AS")) {
        return [
          {
            provider_account_id: "act_1",
            account_timezone: "UTC",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    try {
      const summary = await getMetaPublishedVerificationSummary({
        businessId: "biz-1",
        providerAccountIds: ["act_1"],
        startDate: "2025-03-09",
        endDate: "2025-03-09",
        surfaces: [
          "account_daily",
          "campaign_daily",
          "adset_daily",
          "ad_daily",
          "breakdown_daily",
        ],
      });

      expect(summary.verificationState).toBe("finalized_verified");
      expect(summary.truthReady).toBe(true);
      expect(summary.publishedSlices).toBe(4);
      expect(summary.totalExpectedSlices).toBe(4);
      expect(summary.publishedKeysBySurface.breakdown_daily).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps published verification green after old non-authoritative residue has been removed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("WITH latest_slice AS")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "account_daily",
            latest_slice_id: "slice-1",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2026-04-08T00:10:00.000Z",
            source_fetched_at: "2026-04-08T00:01:00.000Z",
            active_slice_version_id: "slice-1",
            published_at: "2026-04-08T00:10:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "campaign_daily",
            latest_slice_id: "slice-2",
            latest_state: "finalized_verified",
            latest_status: "published",
            latest_validation_status: "passed",
            latest_slice_published_at: "2026-04-08T00:11:00.000Z",
            source_fetched_at: "2026-04-08T00:01:00.000Z",
            active_slice_version_id: "slice-2",
            published_at: "2026-04-08T00:11:00.000Z",
            published_state: "finalized_verified",
            published_status: "published",
          },
        ];
      }
      if (query.includes("WITH latest_manifests AS")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "account_daily",
            id: "manifest-1",
            fetch_status: "completed",
            completed_at: "2026-04-08T00:01:00.000Z",
            run_id: "run-1",
          },
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "campaign_daily",
            id: "manifest-2",
            fetch_status: "completed",
            completed_at: "2026-04-08T00:01:00.000Z",
            run_id: "run-1",
          },
        ];
      }
      if (query.includes("WITH latest_failures AS")) {
        return [];
      }
      if (
        query.includes("FROM meta_authoritative_day_state") &&
        query.includes("diagnosis_code")
      ) {
        return [
          {
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "account_daily",
            state: "published",
            diagnosis_code: null,
          },
          {
            provider_account_id: "act_1",
            day: "2026-04-07",
            surface: "campaign_daily",
            state: "published",
            diagnosis_code: null,
          },
        ];
      }
      if (query.includes("partition_date AS day")) {
        return [];
      }
      if (query.includes("WITH manifest_accounts AS")) {
        return [
          {
            provider_account_id: "act_1",
            account_timezone: "UTC",
          },
        ];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    try {
      const summary = await getMetaPublishedVerificationSummary({
        businessId: "biz-1",
        providerAccountIds: ["act_1"],
        startDate: "2026-04-07",
        endDate: "2026-04-07",
        surfaces: ["account_daily", "campaign_daily"],
      });

      expect(summary.verificationState).toBe("finalized_verified");
      expect(summary.truthReady).toBe(true);
      expect(summary.publishedSlices).toBe(2);
      expect(summary.reasonCounts.blocked).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("writes canonical ref ids for authoritative state and publication tables", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertMetaAuthoritativeDayState({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-07",
      surface: "campaign_daily",
      state: "queued",
      accountTimezone: "UTC",
      failureStreak: 0,
      autohealCount: 0,
    });

    await createMetaAuthoritativeSourceManifest({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-07",
      surface: "campaign_daily",
      accountTimezone: "UTC",
      sourceKind: "warehouse",
      sourceWindowKind: "historical",
      fetchStatus: "completed",
    });

    await createMetaAuthoritativeSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-07",
      surface: "campaign_daily",
      candidateVersion: 1,
      state: "finalized_verified",
      truthState: "finalized",
      validationStatus: "passed",
      status: "published",
    });

    await publishMetaAuthoritativeSliceVersion({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-07",
      surface: "campaign_daily",
      sliceVersionId: "slice-1",
      publicationReason: "test",
    });

    await createMetaAuthoritativeReconciliationEvent({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      day: "2026-04-07",
      surface: "campaign_daily",
      eventKind: "parity_check",
      severity: "info",
      result: "passed",
    });

    const query = queries.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
    expect(query).toContain("meta_authoritative_day_state");
    expect(query).toContain("meta_authoritative_source_manifests");
    expect(query).toContain("meta_authoritative_slice_versions");
    expect(query).toContain("meta_authoritative_publication_pointers");
    expect(query).toContain("meta_authoritative_reconciliation_events");
  });

  it("writes canonical ref ids for raw snapshots", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      return [{ id: "snapshot-1" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await persistMetaRawSnapshot({
      businessId: "biz-1",
      providerAccountId: "acct-1",
      endpointName: "campaigns",
      entityScope: "campaign",
      startDate: "2026-04-01",
      endDate: "2026-04-02",
      accountTimezone: "UTC",
      accountCurrency: "USD",
      payloadJson: { data: [] },
      payloadHash: "hash-1",
      requestContext: {},
      providerHttpStatus: 200,
      status: "fetched",
    });

    const query = queries.join("\n");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
    expect(query).toContain("meta_raw_snapshots");
  });
});

describe("meta warehouse config columns", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("writes the historical config columns in campaign and adset daily upserts", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const sql = vi.fn() as unknown as { query: typeof query };
    sql.query = query;
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertMetaCampaignDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
      },
    ]);

    await upsertMetaAdSetDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
      },
    ]);

    const queries = query.mock.calls.map(([text]) => String(text));
    expect(queries.some((text) => text.includes("optimization_goal"))).toBe(true);
    expect(queries.some((text) => text.includes("bid_strategy_type"))).toBe(true);
    expect(queries.some((text) => text.includes("is_bid_value_mixed"))).toBe(true);
  });

  it("writes canonical ref columns in campaign, adset, breakdown, ad, and creative upserts", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const sql = vi.fn() as unknown as { query: typeof query };
    sql.query = query;
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await upsertMetaCampaignDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        campaignNameCurrent: "Campaign 1",
        campaignNameHistorical: "Campaign 1",
        campaignStatus: "ACTIVE",
        objective: null,
        buyingType: null,
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
      },
    ]);

    await upsertMetaAdSetDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
      },
    ]);

    await upsertMetaBreakdownDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        breakdownType: "age",
        breakdownKey: "25-34",
        breakdownLabel: "25-34",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
      },
    ]);

    await upsertMetaAdDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
        payloadJson: { adId: "ad-1" },
      },
    ]);

    await upsertMetaCreativeDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "creative-1",
        creativeName: "Creative 1",
        headline: "Headline",
        primaryText: "Primary text",
        destinationUrl: "https://example.com",
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 0,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
        payloadJson: { creativeId: "creative-1" },
      },
    ]);

    const queries = query.mock.calls.map(([text]) => String(text));
    const expectedTables = [
      "meta_campaign_daily",
      "meta_adset_daily",
      "meta_breakdown_daily",
      "meta_ad_daily",
      "meta_creative_daily",
    ];

    for (const table of expectedTables) {
      const tableQuery = queries.find((text) => text.includes(`INSERT INTO ${table}`));
      expect(tableQuery).toContain("business_ref_id");
      expect(tableQuery).toContain("provider_account_ref_id");
    }
  });

  it("emits full truth lifecycle placeholders for adset upserts", async () => {
    vi.resetModules();
    const dbModule = await import("@/lib/db");
    const { upsertMetaAdSetDailyRows } = await import("@/lib/meta/warehouse");

    const query = vi.fn().mockResolvedValue(undefined);
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const queryText = strings.join(" ");
      if (queryText.includes("information_schema.columns")) {
        return [{ present: true }];
      }
      return [];
    }) as unknown as { query: typeof query };
    sql.query = query;
    vi.mocked(dbModule.getDb).mockReturnValue(sql as never);

    await upsertMetaAdSetDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adsetNameCurrent: "Adset 1",
        adsetNameHistorical: "Adset 1",
        adsetStatus: "ACTIVE",
        optimizationGoal: "Purchase",
        bidStrategyType: "bid_cap",
        bidStrategyLabel: "Bid Cap",
        manualBidAmount: 5,
        bidValue: 5,
        bidValueFormat: "currency",
        dailyBudget: 10,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-03T00:00:00.000Z",
        validationStatus: "passed",
        sourceRunId: "run-1",
      },
    ]);

    const adsetQuery = query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("INSERT INTO meta_adset_daily"));

    expect(adsetQuery).toContain("$42");
    expect(adsetQuery).toContain("$43");
    expect(adsetQuery).toContain("source_run_id");
  });

  it("emits full payload placeholders for ad and creative upserts", async () => {
    vi.resetModules();
    const dbModule = await import("@/lib/db");
    const {
      upsertMetaAdDailyRows,
      upsertMetaCreativeDailyRows,
    } = await import("@/lib/meta/warehouse");

    const query = vi.fn().mockResolvedValue(undefined);
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const queryText = strings.join(" ");
      if (queryText.includes("information_schema.columns")) {
        return [{ present: true }];
      }
      return [];
    }) as unknown as { query: typeof query };
    sql.query = query;
    vi.mocked(dbModule.getDb).mockReturnValue(sql as never);

    await upsertMetaAdDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        linkClicks: 1,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-03T00:00:00.000Z",
        validationStatus: "passed",
        sourceRunId: "run-1",
        payloadJson: { adId: "ad-1" },
      },
    ]);

    await upsertMetaCreativeDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "creative-1",
        creativeName: "Creative 1",
        headline: "Headline",
        primaryText: "Primary text",
        destinationUrl: "https://example.com",
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 0,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        linkClicks: 1,
        sourceSnapshotId: null,
        sourceRunId: "run-1",
        payloadJson: { creativeId: "creative-1" },
      },
    ]);

    const queries = query.mock.calls.map(([text]) => String(text));
    const adQuery = queries.find((text) => text.includes("INSERT INTO meta_ad_daily"));
    const creativeQuery = queries.find((text) => text.includes("INSERT INTO meta_creative_daily"));

    expect(adQuery).toContain("$32");
    expect(adQuery).toContain("$33::jsonb");
    expect(creativeQuery).toContain("$54");
    expect(creativeQuery).toContain("$55::jsonb");
  });

  it("keeps long-retention creative payloads free of media URLs", () => {
    expect(
      stripMetaCreativeMediaPayload({
        creative_id: "creative-1",
        image_hash: "hash-1",
        preview_url: "https://cdn.example.com/preview.png",
        nested: {
          thumbnail_url: "https://cdn.example.com/thumb.png",
          objective: "SALES",
        },
      }),
    ).toEqual({
      creative_id: "creative-1",
      image_hash: "hash-1",
      nested: {
        objective: "SALES",
      },
    });
  });

  it("writes creative media payloads to the 90-day media table", async () => {
    vi.resetModules();
    const dbModule = await import("@/lib/db");
    const { upsertMetaCreativeMediaRows } = await import("@/lib/meta/warehouse");

    const query = vi.fn().mockResolvedValue(undefined);
    const sql = vi.fn(async () => []) as unknown as { query: typeof query };
    sql.query = query;
    vi.mocked(dbModule.getDb).mockReturnValue(sql as never);

    await upsertMetaCreativeMediaRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "creative-1",
        previewUrl: "https://cdn.example.com/preview.png",
        thumbnailUrl: "https://cdn.example.com/thumb.png",
        imageHash: "hash-1",
        payloadJson: { preview_url: "https://cdn.example.com/preview.png" },
        sourceRunId: "run-1",
      },
    ]);

    const mediaQuery = query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("INSERT INTO meta_creative_media"));

    expect(mediaQuery).toContain("payload_json");
    expect(mediaQuery).toContain("$20::jsonb");
    expect(mediaQuery).toContain(
      "ON CONFLICT (business_id, provider_account_id, date, creative_id) DO UPDATE SET",
    );
  });

  it("emits full lifecycle placeholders for breakdown upserts", async () => {
    vi.resetModules();
    const dbModule = await import("@/lib/db");
    const { upsertMetaBreakdownDailyRows } = await import("@/lib/meta/warehouse");

    const query = vi.fn().mockResolvedValue(undefined);
    const sql = vi.fn(async () => []) as unknown as { query: typeof query };
    sql.query = query;
    vi.mocked(dbModule.getDb).mockReturnValue(sql as never);

    await upsertMetaBreakdownDailyRows([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        breakdownType: "age",
        breakdownKey: "25-34",
        breakdownLabel: "25-34",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 1,
        impressions: 2,
        clicks: 3,
        reach: 4,
        frequency: null,
        conversions: 0,
        revenue: 0,
        roas: 0,
        cpa: null,
        ctr: null,
        cpc: null,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        finalizedAt: "2026-04-03T00:00:00.000Z",
        validationStatus: "passed",
        sourceRunId: "run-1",
      },
    ]);

    const breakdownQuery = query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("INSERT INTO meta_breakdown_daily"));

    expect(breakdownQuery).toContain("$26");
    expect(breakdownQuery).toContain("$27");
    expect(breakdownQuery).toContain("source_run_id");
  });

  it("canonicalizes fine-grained sync types before inserting sync jobs", async () => {
    vi.resetAllMocks();

    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const queryText = strings.join(" ");
      if (queryText.includes("information_schema.tables")) return [{ present: true }];
      if (queryText.includes("information_schema.columns")) return [{ present: true }];
      if (queryText.includes("FROM businesses")) return [{ id: "business-ref-biz-1" }];
      if (queryText.includes("FROM provider_accounts")) return [{ id: "provider-ref-act_1" }];
      if (queryText.includes("FROM meta_sync_jobs")) return [];
      if (queryText.includes("INSERT INTO meta_sync_jobs")) {
        expect(values[4]).toBe("today_refresh");
        return [{ id: "job-1" }];
      }
      return [];
    }) as ReturnType<typeof vi.fn> & { query?: ReturnType<typeof vi.fn> };

    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const jobId = await createMetaSyncJob({
      businessId: "biz-1",
      providerAccountId: "act_1",
      syncType: "today_observe",
      scope: "account_daily",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      status: "pending",
      progressPercent: 0,
      triggerSource: "today_observe",
      retryCount: 0,
      lastError: null,
    });

    expect(jobId).toBe("job-1");
  });

  it("maps the historical config columns back out of campaign and adset daily reads", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM meta_campaign_daily")) {
        return [
          {
            business_id: "biz-1",
            provider_account_id: "act_1",
            date: "2026-04-03",
            campaign_id: "cmp-1",
            campaign_name_current: "Campaign 1",
            campaign_name_historical: "Campaign 1",
            campaign_status: "ACTIVE",
            objective: null,
            buying_type: null,
            optimization_goal: "Purchase",
            bid_strategy_type: "bid_cap",
            bid_strategy_label: "Bid Cap",
            manual_bid_amount: 5,
            bid_value: 5,
            bid_value_format: "currency",
            daily_budget: 10,
            lifetime_budget: null,
            is_budget_mixed: false,
            is_config_mixed: false,
            is_optimization_goal_mixed: false,
            is_bid_strategy_mixed: false,
            is_bid_value_mixed: false,
            account_timezone: "UTC",
            account_currency: "USD",
            spend: 1,
            impressions: 2,
            clicks: 3,
            reach: 4,
            frequency: null,
            conversions: 0,
            revenue: 0,
            roas: 0,
            cpa: null,
            ctr: null,
            cpc: null,
            source_snapshot_id: null,
            created_at: "2026-04-03T00:00:00.000Z",
            updated_at: "2026-04-03T00:00:00.000Z",
          },
        ];
      }
      return [
        {
          business_id: "biz-1",
          provider_account_id: "act_1",
          date: "2026-04-03",
          campaign_id: "cmp-1",
          adset_id: "adset-1",
          adset_name_current: "Adset 1",
          adset_name_historical: "Adset 1",
          adset_status: "ACTIVE",
          optimization_goal: "Purchase",
          bid_strategy_type: "bid_cap",
          bid_strategy_label: "Bid Cap",
          manual_bid_amount: 5,
          bid_value: 5,
          bid_value_format: "currency",
          daily_budget: 10,
          lifetime_budget: null,
          is_budget_mixed: false,
          is_config_mixed: false,
          is_optimization_goal_mixed: false,
          is_bid_strategy_mixed: false,
          is_bid_value_mixed: false,
          account_timezone: "UTC",
          account_currency: "USD",
          spend: 1,
          impressions: 2,
          clicks: 3,
          reach: 4,
          frequency: null,
          conversions: 0,
          revenue: 0,
          roas: 0,
          cpa: null,
          ctr: null,
          cpc: null,
          source_snapshot_id: null,
          created_at: "2026-04-03T00:00:00.000Z",
          updated_at: "2026-04-03T00:00:00.000Z",
        },
      ];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const [campaignRows, adsetRows] = await Promise.all([
      getMetaCampaignDailyRange({
        businessId: "biz-1",
        startDate: "2026-04-03",
        endDate: "2026-04-03",
      }),
      getMetaAdSetDailyRange({
        businessId: "biz-1",
        startDate: "2026-04-03",
        endDate: "2026-04-03",
      }),
    ]);

    expect(campaignRows[0]).toMatchObject({
      optimizationGoal: "Purchase",
      bidStrategyType: "bid_cap",
      bidStrategyLabel: "Bid Cap",
      manualBidAmount: 5,
      bidValue: 5,
      bidValueFormat: "currency",
      dailyBudget: 10,
      isBidValueMixed: false,
    });
    expect(adsetRows[0]).toMatchObject({
      optimizationGoal: "Purchase",
      bidStrategyType: "bid_cap",
      bidStrategyLabel: "Bid Cap",
      manualBidAmount: 5,
      bidValue: 5,
      bidValueFormat: "currency",
      dailyBudget: 10,
      isBidValueMixed: false,
    });
  });
});
