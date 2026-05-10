import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/status/route";
import { assertMetaStatusPageContract } from "@/lib/meta/page-route-contract.test-helpers";
import {
  META_PAGE_OPTIONAL_SURFACES,
  META_PAGE_REQUIRED_SURFACE_ORDER,
} from "@/lib/meta/page-contract";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegrationMetadata: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderAccountSnapshot: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaAuthoritativeBusinessOpsSnapshot: vi.fn(),
  getMetaAuthoritativeDayVerification: vi.fn(),
  getLatestMetaSyncHealth: vi.fn(),
  getMetaAccountDailyCoverage: vi.fn(),
  getMetaCampaignDailyCoverage: vi.fn(),
  getMetaAccountDailyStats: vi.fn(),
  getMetaAdDailyCoverage: vi.fn(),
  getMetaCreativeMediaPreviewCoverage: vi.fn(),
  getMetaAdSetDailyCoverage: vi.fn(),
  getMetaCheckpointHealth: vi.fn(),
  getMetaCreativeDailyCoverage: vi.fn(),
  getMetaSyncPhaseTimingSummaries: vi.fn(),
  getMetaDeadLetterRecoverySummary: vi.fn(),
  getMetaBreakdownDailyCoverageByEndpoint: vi.fn(),
  getMetaQueueComposition: vi.fn(),
  getMetaQueueHealth: vi.fn(),
  getMetaRawSnapshotCoverageByEndpoint: vi.fn(),
  getMetaSyncJobHealth: vi.fn(),
  getMetaSyncState: vi.fn(),
}));

vi.mock("@/lib/meta/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/history")>();
  return {
    ...actual,
    META_WAREHOUSE_HISTORY_DAYS: 365,
    dayCountInclusive: vi.fn((start: string, end: string) => {
      const startDate = new Date(`${start}T00:00:00Z`);
      const endDate = new Date(`${end}T00:00:00Z`);
      return Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
    }),
  };
});

vi.mock("@/lib/meta/constraints", () => ({
  getMetaBreakdownSupportedStart: vi.fn(() => "2000-01-01"),
  META_BREAKDOWN_MAX_HISTORY_DAYS: 365,
}));

vi.mock("@/lib/demo-business", () => ({
  isDemoBusinessId: vi.fn(() => false),
  getDemoMetaStatus: vi.fn(),
}));

vi.mock("@/lib/sync/worker-health", () => ({
  getProviderWorkerHealthState: vi.fn(),
}));

vi.mock("@/lib/sync/runtime-contract", () => ({
  assertRuntimeContractStartup: vi.fn(() => ({
    contractVersion: 1,
    service: "web",
    runtimeRole: "web",
    instanceId: "web:test:1",
    buildId: "dev-build",
    nodeEnv: "test",
    providerScopes: ["meta"],
    dbTarget: {
      host: "localhost",
      port: 5432,
      database: "test",
      searchPath: null,
      sslMode: null,
    },
    dbFingerprint: "db-fingerprint",
    configFingerprint: "config-fingerprint",
    config: {
      metaAuthoritativeFinalizationV2: true,
      metaRetentionExecutionEnabled: false,
      releaseCanaryBusinesses: [],
      releaseCanaryConfigured: false,
      releaseCanaryHasMandatoryCanary: false,
      deployGateMode: "measure_only",
      releaseGateMode: "measure_only",
    },
    validation: {
      pass: true,
      issues: [],
    },
  })),
  upsertRuntimeContractInstance: vi.fn(async () => null),
  getRuntimeRegistryStatus: vi.fn(async () => null),
}));

vi.mock("@/lib/sync/release-gates", () => ({
  getLatestSyncGateRecords: vi.fn(async () => ({
    deployGate: null,
    releaseGate: null,
  })),
}));

vi.mock("@/lib/sync/repair-planner", () => ({
  getLatestSyncRepairPlan: vi.fn(async () => null),
}));

vi.mock("@/lib/sync/control-plane-persistence", () => ({
  getSyncControlPlanePersistenceStatus: vi.fn(),
}));

vi.mock("@/lib/sync/remediation-executions", () => ({
  getLatestSyncRepairExecution: vi.fn(async () => null),
}));

vi.mock("@/lib/meta/status-operations", () => ({
  deriveMetaOperationsBlockReason: vi.fn(() => null),
}));

vi.mock("@/lib/sync/incidents", () => ({
  deriveOperationalSyncState: vi.fn((input) =>
    input?.incidentSummary?.openCount > 0 ? "repairing" : "healthy"
  ),
  getSyncIncidentSummary: vi.fn(async () => ({
    openCount: 0,
    openCircuitCount: 0,
    latestSeenAt: null,
    degradedServing: false,
    counts: {
      detected: 0,
      eligible: 0,
      repairing: 0,
      cooldown: 0,
      half_open: 0,
      cleared: 0,
      quarantined: 0,
      exhausted: 0,
      manual_required: 0,
    },
  })),
}));

vi.mock("@/lib/meta/live", () => ({
  getMetaCurrentDayLiveAvailability: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  getMetaSelectedRangeTruthReadiness: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse-retention", () => ({
  getMetaProtectedPublishedTruthReview: vi.fn(async () => ({
    runtimeAvailable: false,
    asOfDate: "2026-04-13",
    scope: {
      kind: "selected_businesses",
      businessIds: ["biz"],
    },
    hasNonZeroProtectedPublishedRows: false,
    protectedPublishedRows: 0,
    activePublicationPointerRows: 0,
    protectedTruthClassesPresent: [],
    protectedTruthClassesAbsent: [
      "core_daily_rows",
      "breakdown_daily_rows",
      "active_publication_pointers",
      "active_published_slice_versions",
      "active_source_manifests",
      "published_day_state",
    ],
    classes: [],
  })),
  getLatestMetaRetentionCanaryRun: vi.fn(),
  getLatestMetaRetentionRun: vi.fn(),
  getMetaRetentionCanaryRuntimeStatus: vi.fn(() => ({
    runtimeAvailable: false,
    globalExecutionEnabled: false,
    businessId: "biz",
    executeRequested: false,
    executeAllowed: false,
    mode: "dry_run",
    gateReason:
      "Scoped Meta retention verification defaults to dry-run until --execute is supplied.",
  })),
  getMetaRetentionDeleteScope: vi.fn(() => "horizon_outside_residue"),
  getMetaRetentionRunMetadata: vi.fn(() => ({
    scope: {
      kind: "all_businesses",
      businessIds: null,
    },
    executionDisposition: "dry_run",
    canary: null,
  })),
  getMetaRetentionRunRows: vi.fn(() => []),
  getMetaRetentionRuntimeStatus: vi.fn(() => ({
    runtimeAvailable: false,
    executionEnabled: false,
    mode: "dry_run",
    gateReason: "Meta retention execution is disabled by default. Dry-run remains available.",
  })),
  summarizeMetaRetentionRunRows: vi.fn(() => null),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const integrations = await import("@/lib/integrations");
const assignments = await import("@/lib/provider-account-assignments");
const snapshots = await import("@/lib/provider-account-snapshots");
const warehouse = await import("@/lib/meta/warehouse");
const workerHealth = await import("@/lib/sync/worker-health");
const live = await import("@/lib/meta/live");
const constraints = await import("@/lib/meta/constraints");
const metaSync = await import("@/lib/sync/meta-sync");
const metaRetention = await import("@/lib/meta/warehouse-retention");
const remediationExecutions = await import("@/lib/sync/remediation-executions");
const incidents = await import("@/lib/sync/incidents");
const controlPlanePersistence = await import("@/lib/sync/control-plane-persistence");

function getUtcTodayIso() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

describe("GET /api/meta/status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "disconnected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      id: "asg_1",
      business_id: "biz",
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "",
      updated_at: "",
    });
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "act_1", name: "Main", timezone: "UTC" }],
      meta: {
        source: "snapshot",
        sourceHealth: "healthy_cached",
        fetchedAt: null,
        stale: false,
        refreshFailed: false,
        failureClass: null,
        lastError: null,
        lastKnownGoodAvailable: true,
        refreshRequestedAt: null,
        lastRefreshAttemptAt: null,
        nextRefreshAfter: null,
        retryAfterAt: null,
        refreshInProgress: false,
        sourceReason: null,
      },
    });
    vi.mocked(warehouse.getLatestMetaSyncHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaAuthoritativeBusinessOpsSnapshot).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaAccountDailyStats).mockResolvedValue({
      row_count: 10,
      first_date: "2025-04-01",
      last_date: "2026-03-30",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 365,
      ready_through_date: "2026-03-30",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 365,
      ready_through_date: "2026-03-30",
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 365,
      ready_through_date: "2026-03-30",
    } as never);
    vi.mocked(warehouse.getMetaAdDailyCoverage).mockResolvedValue({
      completed_days: 365,
      ready_through_date: "2026-03-30",
    } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 365,
      ready_through_date: "2026-03-30",
    } as never);
    vi.mocked(warehouse.getMetaCreativeMediaPreviewCoverage).mockResolvedValue({
      total_rows: 0,
      preview_ready_rows: 0,
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 365, ready_through_date: "2026-03-30" }],
        ["breakdown_country", { completed_days: 365, ready_through_date: "2026-03-30" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 365, ready_through_date: "2026-03-30" },
        ],
      ]) as never
    );
    vi.mocked(warehouse.getMetaBreakdownDailyCoverageByEndpoint).mockImplementation(
      (input) => warehouse.getMetaRawSnapshotCoverageByEndpoint(input) as never,
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaQueueComposition).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaDeadLetterRecoverySummary).mockResolvedValue({
      total: 0,
      replayableTransient: 0,
      terminalActionRequired: 0,
      unknown: 0,
      latest: [],
    } as never);
    vi.mocked(warehouse.getMetaCheckpointHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaSyncPhaseTimingSummaries).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaSyncJobHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getMetaSyncState).mockResolvedValue([]);
    vi.mocked(warehouse.getMetaAuthoritativeDayVerification).mockResolvedValue({
      businessId: "biz",
      providerAccountId: "act_1",
      day: "2026-04-12",
      verificationState: "finalized_verified",
      sourceManifestState: "completed",
      validationState: "finalized_verified",
      activePublication: {
        publishedAt: "2026-04-13T00:05:00.000Z",
        publicationReason: "finalize_day",
        activeSliceVersionId: "slice-1",
      },
      surfaces: [],
      lastFailure: null,
      detectorReasonCodes: [],
      repairBacklog: 0,
      deadLetters: 0,
      staleLeases: 0,
      queuedPartitions: 0,
      leasedPartitions: 0,
    } as never);
    const sql = vi.fn(async () => [
      {
        has_account_row: false,
        has_campaign_row: false,
        active_finalize_count: 0,
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);
    vi.mocked(workerHealth.getProviderWorkerHealthState).mockResolvedValue(null as never);
    vi.mocked(metaRetention.getLatestMetaRetentionRun).mockResolvedValue(null as never);
    vi.mocked(metaRetention.getLatestMetaRetentionCanaryRun).mockResolvedValue(null as never);
    vi.mocked(metaRetention.getMetaRetentionRunRows).mockReturnValue([] as never);
    vi.mocked(metaRetention.getMetaRetentionRunMetadata).mockReturnValue({
      scope: {
        kind: "all_businesses",
        businessIds: null,
      },
      executionDisposition: "dry_run",
      canary: null,
    } as never);
    vi.mocked(incidents.getSyncIncidentSummary).mockResolvedValue({
      openCount: 0,
      openCircuitCount: 0,
      latestSeenAt: null,
      degradedServing: false,
      counts: {
        detected: 0,
        eligible: 0,
        repairing: 0,
        cooldown: 0,
        half_open: 0,
        cleared: 0,
        quarantined: 0,
        exhausted: 0,
        manual_required: 0,
      },
    });
    vi.mocked(metaRetention.summarizeMetaRetentionRunRows).mockReturnValue(null as never);
    vi.mocked(metaRetention.getMetaProtectedPublishedTruthReview).mockResolvedValue({
      runtimeAvailable: false,
      asOfDate: "2026-04-13",
      scope: {
        kind: "selected_businesses",
        businessIds: ["biz"],
      },
      hasNonZeroProtectedPublishedRows: false,
      protectedPublishedRows: 0,
      activePublicationPointerRows: 0,
      protectedTruthClassesPresent: [],
      protectedTruthClassesAbsent: [
        "core_daily_rows",
        "breakdown_daily_rows",
        "active_publication_pointers",
        "active_published_slice_versions",
        "active_source_manifests",
        "published_day_state",
      ],
      classes: [],
    } as never);
    vi.mocked(live.getMetaCurrentDayLiveAvailability).mockResolvedValue({
      summaryAvailable: true,
      campaignsAvailable: true,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: true,
      state: "finalized_verified",
      verificationState: "finalized_verified",
      totalDays: 1,
      completedCoreDays: 1,
      blockingReasons: [],
      reasonCounts: {},
    } as never);
    vi.mocked(controlPlanePersistence.getSyncControlPlanePersistenceStatus).mockResolvedValue({
      identity: {
        buildId: "dev-build",
        environment: "test",
        providerScope: "meta",
      },
      exact: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      fallbackByBuild: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      latest: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      missingExact: [],
      exactRowsPresent: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports warehouse readiness even when the provider is disconnected", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz&diagnostics=1")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    assertMetaStatusPageContract(payload);
    expect(payload.state).toBe("not_connected");
    expect(payload.credentialState).toBe("not_connected");
    expect(payload.assignmentState).toBe("assigned");
    expect(payload.warehouseState).toBe("ready");
    expect(payload.pageReadiness).toMatchObject({
      state: "not_connected",
      usable: false,
      complete: false,
      missingRequiredSurfaces: [
        "summary",
        "campaigns",
        "breakdowns.age",
        "breakdowns.location",
        "breakdowns.placement",
      ],
    });
    expect(payload.completionBasis).toEqual(
      expect.objectContaining({
        requiredScopes: ["account_daily", "campaign_daily"],
        percent: 100,
        complete: true,
      })
    );
    expect(payload.retention).toMatchObject({
      runtimeAvailable: false,
      executionEnabled: false,
      defaultExecutionDisabled: true,
      mode: "dry_run",
      policy: {
        coreDailyAuthoritativeDays: 761,
        breakdownDailyAuthoritativeDays: 394,
      },
      latestRun: null,
      summary: null,
      tables: [],
      scopedExecution: {
        available: true,
        command: "npm run meta:retention-canary -- biz",
        executeCommand: "npm run meta:retention-canary -- biz --execute",
        globalExecutionEnabled: false,
        executeAllowed: false,
      },
    });
    expect(payload.phaseTimings).toBeNull();
    expect(payload.dataContract).toEqual({
      todayMode: "live_only",
      historicalInsideHorizon: "published_verified_truth",
      historicalOutsideCoreHorizon: "live_fallback",
      breakdownOutsideHorizon: "unsupported_degraded",
    });
  });

  it("scopes creative preview coverage to the media retention window", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz&diagnostics=1")
    );

    expect(response.status).toBe(200);
    expect(warehouse.getMetaCreativeDailyCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: null,
        startDate: "2025-01-13",
        endDate: "2026-04-12",
      }),
    );
    expect(warehouse.getMetaCreativeMediaPreviewCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: null,
        startDate: "2026-01-13",
        endDate: "2026-04-12",
      }),
    );
  });

  it("includes Meta phase timing telemetry when recent samples exist", async () => {
    vi.mocked(warehouse.getMetaSyncPhaseTimingSummaries).mockResolvedValue([
      {
        phase: "fetch_raw",
        runCount: 6,
        timingScope: "fetch_raw:core_ad_insights",
        latestFinishedAt: "2026-04-13T11:58:00.000Z",
        latestDurationMs: 1490,
        avgDurationMs: 1640,
        p50DurationMs: 1520,
        p95DurationMs: 2410,
        maxDurationMs: 2600,
        throughputBasis: "rows_fetched",
        latestRowsFetched: 5166,
        latestRowsWritten: 0,
        latestRowsPerSecond: 3467,
        p50RowsPerSecond: 3200,
      },
      {
        phase: "bulk_upsert",
        runCount: 6,
        timingScope: "bulk_upsert:core_ad_insights",
        latestFinishedAt: "2026-04-13T11:58:02.000Z",
        latestDurationMs: 410,
        avgDurationMs: 470,
        p50DurationMs: 430,
        p95DurationMs: 620,
        maxDurationMs: 700,
        throughputBasis: "rows_written",
        latestRowsFetched: 5166,
        latestRowsWritten: 122,
        latestRowsPerSecond: 298,
        p50RowsPerSecond: 280,
      },
    ] as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&diagnostics=1"
      )
    );
    const payload = await response.json();

    expect(payload.phaseTimings).toEqual({
      windowHours: 24,
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase: "fetch_raw",
          p50DurationMs: 1520,
          latestRowsPerSecond: 3467,
        }),
        expect.objectContaining({
          phase: "bulk_upsert",
          throughputBasis: "rows_written",
          latestRowsWritten: 122,
        }),
      ]),
    });
  });

  it("surfaces Meta retention dry-run protection evidence", async () => {
    vi.mocked(metaRetention.getMetaRetentionRuntimeStatus).mockReturnValue({
      runtimeAvailable: true,
      executionEnabled: false,
      mode: "dry_run",
      gateReason:
        "Meta retention execution is disabled by default. Dry-run remains available.",
    } as never);
    vi.mocked(metaRetention.getLatestMetaRetentionRun).mockResolvedValue({
      id: "meta_retention_run_1",
      executionMode: "dry_run",
      executionEnabled: false,
      skippedDueToActiveLease: false,
      totalDeletedRows: 0,
      summaryJson: {},
      errorMessage: null,
      startedAt: "2026-04-13T12:00:00.000Z",
      finishedAt: "2026-04-13T12:01:00.000Z",
      createdAt: "2026-04-13T12:00:00.000Z",
      updatedAt: "2026-04-13T12:01:00.000Z",
    } as never);
    vi.mocked(metaRetention.getMetaRetentionRunRows).mockReturnValue([
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
        surfaceFilter: null,
      },
      {
        tier: "breakdown_authoritative",
        label: "Meta authoritative publication pointers",
        tableName: "meta_authoritative_publication_pointers",
        summaryKey: "meta_authoritative_publication_pointers:breakdown",
        retentionDays: 394,
        cutoffDate: "2025-03-15",
        executionEnabled: false,
        mode: "dry_run",
        observed: true,
        eligibleRows: 4,
        eligibleDistinctDays: 1,
        oldestEligibleValue: "2025-03-14",
        newestEligibleValue: "2025-03-14",
        retainedRows: 10,
        latestRetainedValue: "2026-04-12",
        protectedRows: 10,
        protectedDistinctDays: 4,
        latestProtectedValue: "2026-04-12",
        deletedRows: 0,
        surfaceFilter: ["breakdown_daily"],
      },
    ] as never);
    vi.mocked(metaRetention.getMetaRetentionRunMetadata).mockReturnValue({
      scope: {
        kind: "all_businesses",
        businessIds: null,
      },
      executionDisposition: "dry_run",
      canary: null,
    } as never);
    vi.mocked(metaRetention.summarizeMetaRetentionRunRows).mockReturnValue({
      observedTables: 2,
      tablesWithDeletableRows: 2,
      tablesWithProtectedRows: 2,
      deletableRows: 16,
      retainedRows: 154,
      protectedRows: 18,
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&diagnostics=1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.retention).toMatchObject({
      runtimeAvailable: true,
      executionEnabled: false,
      defaultExecutionDisabled: true,
      mode: "dry_run",
      latestRun: {
        id: "meta_retention_run_1",
        executionMode: "dry_run",
        totalDeletedRows: 0,
      },
      summary: {
        observedTables: 2,
        deletableRows: 16,
        protectedRows: 18,
      },
      scopedExecution: {
        command: "npm run meta:retention-canary -- biz",
        executeCommand: "npm run meta:retention-canary -- biz --execute",
        globalExecutionEnabled: false,
        executeAllowed: false,
      },
    });
    expect(payload.retention.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_account_daily",
          deletableRows: 12,
          protectedRows: 8,
          newestDeletableValue: "2024-03-12",
        }),
        expect.objectContaining({
          tableName: "meta_authoritative_publication_pointers",
          surfaceFilter: ["breakdown_daily"],
          protectedRows: 10,
        }),
      ]),
    );
  });

  it("surfaces Meta retention scoped execute posture and latest scoped proof", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(workerHealth.getProviderWorkerHealthState).mockResolvedValue({
      workerHealthy: true,
      heartbeatAgeMs: 30_000,
      ownerWorkerId: "worker_1",
      consumeStage: "consume_started",
    } as never);
    vi.mocked(metaRetention.getMetaRetentionCanaryRuntimeStatus).mockReturnValue({
      runtimeAvailable: true,
      globalExecutionEnabled: false,
      businessId: "biz",
      executeRequested: false,
      executeAllowed: false,
      mode: "dry_run",
      gateReason:
        "Scoped Meta retention verification defaults to dry-run until --execute is supplied.",
    } as never);
    vi.mocked(metaRetention.getLatestMetaRetentionRun).mockResolvedValue(null);
    vi.mocked(metaRetention.getLatestMetaRetentionCanaryRun).mockResolvedValue({
      id: "meta_retention_canary_run_1",
      executionMode: "execute",
      executionEnabled: false,
      skippedDueToActiveLease: false,
      totalDeletedRows: 5,
      summaryJson: {},
      errorMessage: null,
      startedAt: "2026-04-13T12:00:00.000Z",
      finishedAt: "2026-04-13T12:01:00.000Z",
      createdAt: "2026-04-13T12:00:00.000Z",
      updatedAt: "2026-04-13T12:01:00.000Z",
    } as never);
    vi.mocked(metaRetention.getMetaRetentionRunRows)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          tier: "core_authoritative",
          label: "Meta core daily authoritative",
          tableName: "meta_account_daily",
          summaryKey: "meta_account_daily",
          retentionDays: 761,
          cutoffDate: "2024-03-13",
          executionEnabled: false,
          mode: "execute",
          observed: true,
          eligibleRows: 3,
          eligibleDistinctDays: 1,
          oldestEligibleValue: "2024-03-01",
          newestEligibleValue: "2024-03-12",
          retainedRows: 16,
          latestRetainedValue: "2026-04-12",
          protectedRows: 6,
          protectedDistinctDays: 2,
          latestProtectedValue: "2026-04-12",
          deletedRows: 3,
          surfaceFilter: null,
        },
        {
          tier: "core_authoritative",
          label: "Meta authoritative slice versions",
          tableName: "meta_authoritative_slice_versions",
          summaryKey: "meta_authoritative_slice_versions:core",
          retentionDays: 761,
          cutoffDate: "2024-03-13",
          executionEnabled: false,
          mode: "execute",
          observed: true,
          eligibleRows: 2,
          eligibleDistinctDays: 1,
          oldestEligibleValue: "2024-01-01",
          newestEligibleValue: "2024-01-15",
          retainedRows: 8,
          latestRetainedValue: "2026-04-12",
          protectedRows: 2,
          protectedDistinctDays: 1,
          latestProtectedValue: "2026-04-12",
          deletedRows: 2,
          surfaceFilter: ["account_daily"],
        },
      ] as never);
    vi.mocked(metaRetention.getMetaRetentionRunMetadata)
      .mockReturnValueOnce({
        scope: {
          kind: "all_businesses",
          businessIds: null,
        },
        executionDisposition: "dry_run",
        canary: null,
      } as never)
      .mockReturnValueOnce({
        scope: {
          kind: "selected_businesses",
          businessIds: ["biz"],
        },
        executionDisposition: "scoped_execute",
        canary: {
          runtimeAvailable: true,
          globalExecutionEnabled: true,
          businessId: "biz",
          executeRequested: true,
          executeAllowed: true,
          mode: "execute",
          gateReason:
            "Meta retention execute mode is globally enabled. The scoped command will execute only the requested business slice.",
        },
      } as never);
    vi.mocked(metaRetention.summarizeMetaRetentionRunRows).mockReturnValue({
      observedTables: 2,
      tablesWithDeletableRows: 2,
      tablesWithProtectedRows: 2,
      deletableRows: 5,
      retainedRows: 24,
      protectedRows: 8,
    } as never);
    vi.mocked(metaRetention.getMetaRetentionDeleteScope)
      .mockReturnValueOnce("horizon_outside_residue" as never)
      .mockReturnValueOnce("orphaned_stale_artifact" as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&diagnostics=1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.operations).toMatchObject({
      retentionScopedCommand: "npm run meta:retention-canary -- biz",
      retentionScopedExecuteCommand:
        "npm run meta:retention-canary -- biz --execute",
      retentionScopedExecuteAllowed: false,
      latestRetentionScopedRunMode: "execute",
      latestRetentionScopedRunDisposition: "scoped_execute",
    });
    expect(payload.retention.scopedExecution).toMatchObject({
      available: true,
      businessId: "biz",
      command: "npm run meta:retention-canary -- biz",
      executeCommand: "npm run meta:retention-canary -- biz --execute",
      globalExecutionEnabled: false,
      executeAllowed: false,
      latestRun: {
        id: "meta_retention_canary_run_1",
        executionMode: "execute",
        executionDisposition: "scoped_execute",
        totalDeletedRows: 5,
        scope: {
          kind: "selected_businesses",
          businessIds: ["biz"],
        },
      },
      summary: {
        deletableRows: 5,
        protectedRows: 8,
      },
    });
    expect(payload.retention.scopedExecution.tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "meta_account_daily",
          deleteScope: "horizon_outside_residue",
          deletedRows: 3,
        }),
        expect.objectContaining({
          tableName: "meta_authoritative_slice_versions",
          deleteScope: "orphaned_stale_artifact",
          deletedRows: 2,
        }),
      ]),
    );
  });

  it("exposes provider platform boundaries when account dates diverge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:30:00.000Z"));
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      id: "asg_1",
      business_id: "biz",
      provider: "meta",
      account_ids: ["act_1", "act_2"],
      created_at: "",
      updated_at: "",
    });
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [
        { id: "act_1", name: "Main", timezone: "America/Anchorage" },
        { id: "act_2", name: "Second", timezone: "Pacific/Kiritimati" },
      ],
      meta: {
        source: "snapshot",
        sourceHealth: "healthy_cached",
        fetchedAt: null,
        stale: false,
        refreshFailed: false,
        failureClass: null,
        lastError: null,
        lastKnownGoodAvailable: true,
        refreshRequestedAt: null,
        lastRefreshAttemptAt: null,
        nextRefreshAfter: null,
        retryAfterAt: null,
        refreshInProgress: false,
        sourceReason: null,
      },
    });

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.platformDateBoundary).toMatchObject({
      primaryAccountId: "act_1",
      primaryAccountTimezone: "America/Anchorage",
      currentDateInTimezone: "2026-04-07",
      previousDateInTimezone: "2026-04-06",
      mixedCurrentDates: true,
      selectedRangeMode: "historical_warehouse",
    });
    expect(payload.platformDateBoundary.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerAccountId: "act_1",
          currentDate: "2026-04-07",
          previousDate: "2026-04-06",
        }),
        expect.objectContaining({
          providerAccountId: "act_2",
          currentDate: "2026-04-08",
          previousDate: "2026-04-07",
        }),
      ])
    );

    vi.useRealTimers();
  });

  it("exposes the current page status contract subset with deterministic surface keys", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-03-01&endDate=2026-03-31"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    assertMetaStatusPageContract(payload);
    expect(Object.keys(payload.pageReadiness.requiredSurfaces)).toEqual([
      ...META_PAGE_REQUIRED_SURFACE_ORDER,
    ]);
    expect(Object.keys(payload.pageReadiness.optionalSurfaces)).toEqual([
      ...META_PAGE_OPTIONAL_SURFACES,
    ]);
  });

  it("adds a compact integrationSummary for recent-window card consumers", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.integrationSummary).toMatchObject({
      visible: true,
      scope: "recent_window",
      attentionNeeded: false,
      stages: [
        expect.objectContaining({
          key: "connection",
          state: "ready",
          code: "connected",
        }),
        expect.objectContaining({
          key: "queue_worker",
          state: "ready",
          code: "queue_clear",
        }),
        expect.objectContaining({
          key: "core_data",
          state: "ready",
          code: "core_ready",
        }),
        expect.objectContaining({
          key: "extended_surfaces",
          state: "ready",
          code: "extended_ready",
        }),
      ],
    });
    expect(payload.operationalSyncState).toBe("healthy");
    expect(payload.openIncidents).toBe(0);
    expect(payload.degradedServing).toBe(false);
    expect(payload.controlPlanePersistence).toMatchObject({
      exactRowsPresent: true,
      missingExact: [],
    });
    expect(payload.controlPlaneErrors).toEqual({
      syncGates: null,
      repairPlan: null,
      controlPlanePersistence: null,
      syncIncidents: null,
    });
  });

  it("keeps recent-window extended status preparing when ads lag even if breakdowns are complete", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAdDailyCoverage)
      .mockResolvedValueOnce({
        completed_days: 365,
        ready_through_date: "2026-04-12",
      } as never)
      .mockResolvedValueOnce({
        completed_days: 89,
        ready_through_date: "2026-04-11",
      } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage)
      .mockResolvedValueOnce({
        completed_days: 455,
        ready_through_date: "2026-04-12",
      } as never)
      .mockResolvedValueOnce({
        completed_days: 90,
        ready_through_date: "2026-04-12",
      } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz")
    );
    const payload = await response.json();
    const extendedStage = payload.integrationSummary.stages.find(
      (stage: { key: string }) => stage.key === "extended_surfaces"
    );

    expect(response.status).toBe(200);
    expect(payload.recentExtendedReady).toBe(false);
    expect(extendedStage).toMatchObject({
      state: "working",
      code: "recent_extended_preparing",
      evidence: {
        pendingSurfaces: ["ad_daily"],
      },
    });
  });

  it("keeps recent-window extended status preparing when creative media previews are incomplete", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaCreativeMediaPreviewCoverage).mockResolvedValue({
      total_rows: 10,
      preview_ready_rows: 9,
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz")
    );
    const payload = await response.json();
    const extendedStage = payload.integrationSummary.stages.find(
      (stage: { key: string }) => stage.key === "extended_surfaces"
    );

    expect(response.status).toBe(200);
    expect(payload.recentExtendedReady).toBe(false);
    expect(extendedStage).toMatchObject({
      state: "working",
      code: "recent_extended_preparing",
      evidence: {
        pendingSurfaces: ["creative_media"],
      },
    });
  });

  it("keeps no-date page readiness ready when default breakdown coverage is complete but historical extended history still lags", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 90, ready_through_date: "2026-04-12" }],
        ["breakdown_country", { completed_days: 90, ready_through_date: "2026-04-12" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 90, ready_through_date: "2026-04-12" },
        ],
      ]) as never,
    );

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "historical_warehouse",
    });
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("ready");
    expect(payload.extendedCompleteness).toMatchObject({
      state: "ready",
      complete: true,
      missingSurfaces: [],
    });
    expect(payload.state).toBe("ready");
    expect(payload.latestSync?.phaseLabel ?? null).toBeNull();
    expect(payload.warehouse?.coverage?.breakdownsBySurface).toMatchObject({
      age: { completedDays: 90, totalDays: 90, isComplete: true },
      location: { completedDays: 90, totalDays: 90, isComplete: true },
      placement: { completedDays: 90, totalDays: 90, isComplete: true },
    });
    expect(payload.historicalExtendedReady).toBe(false);
    expect(payload.integrationSummary).toMatchObject({
      scope: "recent_window",
      attentionNeeded: false,
    });
    expect(
      payload.integrationSummary.stages.find(
        (stage: { key: string }) => stage.key === "extended_surfaces",
      ),
    ).toMatchObject({
      state: "ready",
      code: "extended_ready",
    });
  });

  it("uses persisted breakdown coverage for no-date readiness when raw snapshot coverage lags", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 9, ready_through_date: "2026-04-12" }],
        ["breakdown_country", { completed_days: 9, ready_through_date: "2026-04-12" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 9, ready_through_date: "2026-04-12" },
        ],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaBreakdownDailyCoverageByEndpoint).mockResolvedValue(
      new Map([
        [
          "breakdown_age",
          {
            completed_days: 90,
            first_completed_date: "2026-01-13",
            ready_through_date: "2026-04-12",
          },
        ],
        [
          "breakdown_country",
          {
            completed_days: 90,
            first_completed_date: "2026-01-13",
            ready_through_date: "2026-04-12",
          },
        ],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          {
            completed_days: 90,
            first_completed_date: "2026-01-13",
            ready_through_date: "2026-04-12",
          },
        ],
      ]) as never,
    );

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.extendedCompleteness).toMatchObject({
      state: "ready",
      complete: true,
      percent: 100,
      missingSurfaces: [],
    });
    expect(payload.warehouse?.coverage?.breakdownsBySurface).toMatchObject({
      age: { completedDays: 90, totalDays: 90, isComplete: true },
      location: { completedDays: 90, totalDays: 90, isComplete: true },
      placement: { completedDays: 90, totalDays: 90, isComplete: true },
    });
    expect(
      payload.integrationSummary.stages.find(
        (stage: { key: string }) => stage.key === "extended_surfaces",
      ),
    ).toMatchObject({
      state: "ready",
      code: "extended_ready",
      percent: null,
    });
  });

  it("does not mark no-date breakdown readiness ready from older historical-only coverage", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaBreakdownDailyCoverageByEndpoint).mockImplementation(
      async (input) =>
        new Map([
          [
            "breakdown_age",
            {
              completed_days: input.startDate === "2026-01-13" ? 89 : 90,
              first_completed_date: input.startDate,
              ready_through_date:
                input.startDate === "2026-01-13" ? "2026-04-11" : "2026-01-13",
            },
          ],
          [
            "breakdown_country",
            {
              completed_days: input.startDate === "2026-01-13" ? 89 : 90,
              first_completed_date: input.startDate,
              ready_through_date:
                input.startDate === "2026-01-13" ? "2026-04-11" : "2026-01-13",
            },
          ],
          [
            "breakdown_publisher_platform,platform_position,impression_device",
            {
              completed_days: input.startDate === "2026-01-13" ? 89 : 90,
              first_completed_date: input.startDate,
              ready_through_date:
                input.startDate === "2026-01-13" ? "2026-04-11" : "2026-01-13",
            },
          ],
        ]) as never,
    );

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(warehouse.getMetaBreakdownDailyCoverageByEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-01-13",
        endDate: "2026-04-12",
      }),
    );
    expect(warehouse.getMetaBreakdownDailyCoverageByEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2025-04-13",
        endDate: "2026-04-12",
      }),
    );
    expect(payload.extendedCompleteness).toMatchObject({
      state: "partial",
      complete: false,
    });
    expect(payload.warehouse?.coverage?.breakdownsBySurface).toMatchObject({
      age: { completedDays: 89, totalDays: 90, isComplete: false },
      location: { completedDays: 89, totalDays: 90, isComplete: false },
      placement: { completedDays: 89, totalDays: 90, isComplete: false },
    });
  });

  it("does not treat no-date status as selected-range preparation", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getLatestMetaSyncHealth).mockResolvedValue({
      id: "sync-1",
      sync_type: "today_refresh",
      scope: "account_daily",
      start_date: "2026-04-13",
      end_date: "2026-04-13",
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: null,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: null,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("ready");
    expect(payload.latestSync?.phaseLabel ?? null).toBeNull();
    expect(payload.warehouse?.coverage?.selectedRange ?? null).toBeNull();
    expect(payload.integrationSummary).toMatchObject({
      scope: "recent_window",
      attentionNeeded: false,
    });
  });

  it("keeps no-date status ready when default surfaces are ready but recent window backlog is still draining", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockImplementation(
      async ({ startDate }: { startDate: string }) =>
        ({
          completed_days: startDate >= "2026-03-30" ? 13 : 365,
          ready_through_date: startDate >= "2026-03-30" ? "2026-04-11" : "2026-04-12",
        }) as never,
    );
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockImplementation(
      async ({ startDate }: { startDate: string }) =>
        ({
          completed_days: startDate >= "2026-03-30" ? 13 : 365,
          ready_through_date: startDate >= "2026-03-30" ? "2026-04-11" : "2026-04-12",
        }) as never,
    );
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 90, ready_through_date: "2026-04-12" }],
        ["breakdown_country", { completed_days: 90, ready_through_date: "2026-04-12" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 90, ready_through_date: "2026-04-12" },
        ],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 3,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: "2026-04-13T11:59:00.000Z",
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: "2026-04-11",
      historicalCoreQueueDepth: 3,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("ready");
    expect(payload.readinessLevel).toBe("ready");
    expect(payload.currentCoreProgressPercent).toBe(100);
    expect(payload.coreReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      percent: 100,
    });
    expect(payload.integrationSummary).toMatchObject({
      scope: "recent_window",
      attentionNeeded: false,
    });
    expect(
      payload.integrationSummary.stages.find(
        (stage: { key: string }) => stage.key === "queue_worker",
      ),
    ).toMatchObject({
      state: "waiting",
      code: "queue_waiting",
    });
    expect(
      payload.integrationSummary.stages.find(
        (stage: { key: string }) => stage.key === "core_data",
      ),
    ).toMatchObject({
      state: "ready",
      code: "core_ready",
    });
  });

  it("surfaces forward-progress evidence and activity state through operations truth", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(workerHealth.getProviderWorkerHealthState).mockResolvedValue({
      workerHealthy: true,
      heartbeatAgeMs: 15_000,
      runnerLeaseActive: true,
      ownerWorkerId: "worker-1",
      consumeStage: "consume_started",
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 5,
      leasedPartitions: 2,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: "2026-04-13T11:58:00.000Z",
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: "2026-04-10",
      historicalCoreQueueDepth: 2,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getMetaCheckpointHealth).mockResolvedValue({
      latestCheckpointUpdatedAt: "2026-04-13T11:58:00.000Z",
      checkpointLagMinutes: 2,
      resumeCapable: true,
    } as never);
    vi.mocked(warehouse.getMetaSyncState).mockImplementation(async ({ scope }: { scope: string }) => {
      if (scope === "account_daily" || scope === "campaign_daily") {
        return [
          {
            providerAccountId: "act_1",
            completedDays: 40,
            readyThroughDate: "2026-04-12",
            latestBackgroundActivityAt: "2026-04-13T11:58:00.000Z",
            latestSuccessfulSyncAt: "2026-04-13T11:58:00.000Z",
            updatedAt: "2026-04-13T11:58:00.000Z",
            deadLetterCount: 0,
          },
        ] as never;
      }
      return [] as never;
    });

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.operations).toMatchObject({
      progressState: "syncing",
      activityState: "busy",
      progressEvidence: {
        lastCheckpointAdvancedAt: "2026-04-13T11:58:00.000Z",
        lastCompletedAt: "2026-04-13T11:58:00.000Z",
        lastReadyThroughAdvancedAt: "2026-04-13T11:58:00.000Z",
      },
    });
  });

  it("surfaces terminal Meta checkpoint dead letters as action-required without replay action", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(workerHealth.getProviderWorkerHealthState).mockResolvedValue({
      workerHealthy: true,
      heartbeatAgeMs: 15_000,
      runnerLeaseActive: false,
      ownerWorkerId: "worker-1",
      consumeStage: "idle",
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 1,
      latestCoreActivityAt: null,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: "2026-05-07T09:00:00.000Z",
      oldestQueuedPartition: null,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getMetaDeadLetterRecoverySummary).mockResolvedValue({
      total: 1,
      replayableTransient: 0,
      terminalActionRequired: 1,
      unknown: 0,
      latest: [
        {
          id: "partition-1",
          businessId: "biz",
          lane: "maintenance",
          scope: "account_daily",
          source: "finalize_day",
          partitionDate: "2026-05-07",
          lastError: "log in to www.facebook.com",
          errorClass: "account_checkpoint",
          recoveryKind: "terminal_action_required",
          actionRequired: true,
          reasonCode: "meta_account_checkpoint",
        },
      ],
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("action_required");
    expect(payload.operations.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "account_action_required",
          repairable: false,
        }),
      ]),
    );
    expect(payload.operations.repairableActions ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "replay_dead_letters" }),
      ]),
    );
    expect(payload.operations.deadLetterRecovery).toMatchObject({
      terminalActionRequired: 1,
      replayableTransient: 0,
    });
  });

  it("treats worker-unavailable queue truth as waiting when default surfaces are otherwise ready", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(workerHealth.getProviderWorkerHealthState).mockResolvedValue({
      workerHealthy: false,
      heartbeatAgeMs: null,
      runnerLeaseActive: false,
      ownerWorkerId: null,
      consumeStage: null,
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 11,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: "2026-04-14T15:20:24.080Z",
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: "2024-04-12",
      historicalCoreQueueDepth: 6,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 5,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getMetaCheckpointHealth).mockResolvedValue({
      latestCheckpointUpdatedAt: "2026-04-14T11:57:01.100Z",
      checkpointLagMinutes: 360,
      resumeCapable: true,
    } as never);
    vi.mocked(warehouse.getMetaSyncState).mockResolvedValue([] as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.operations).toMatchObject({
      workerHealthy: false,
      progressState: "partial_stuck",
    });
    expect(payload.integrationSummary).toMatchObject({
      state: "waiting",
      attentionNeeded: false,
      stages: expect.arrayContaining([
        expect.objectContaining({
          key: "queue_worker",
          state: "waiting",
          code: "queue_waiting",
          evidence: expect.objectContaining({
            queueDepth: 11,
          }),
        }),
      ]),
    });
  });

  it("keeps historical core progress while removing creative backlog from the summary", async () => {
    const today = getUtcTodayIso();
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 12,
      leasedPartitions: 1,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: "2026-04-03T09:00:00.000Z",
      latestExtendedActivityAt: "2026-04-03T09:00:00.000Z",
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: "2026-03-01",
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 12,
      extendedHistoricalLeasedPartitions: 1,
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockImplementation(async (input: {
      startDate: string;
      endDate: string;
    }) => {
      if (input.startDate === today && input.endDate === today) {
        return {
          completed_days: 1,
          ready_through_date: today,
        } as never;
      }
      const start = new Date(`${input.startDate}T00:00:00Z`).getTime();
      const end = new Date(`${input.endDate}T00:00:00Z`).getTime();
      const spanDays = Math.floor((end - start) / 86_400_000) + 1;
      if (spanDays <= 14) {
        return {
          completed_days: 14,
          ready_through_date: "2026-04-02",
        } as never;
      }
      return {
        completed_days: 35,
        ready_through_date: "2026-04-02",
      } as never;
    });
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockImplementation(async (input: {
      startDate: string;
      endDate: string;
    }) => {
      if (input.startDate === today && input.endDate === today) {
        return {
          completed_days: 1,
          ready_through_date: today,
        } as never;
      }
      const start = new Date(`${input.startDate}T00:00:00Z`).getTime();
      const end = new Date(`${input.endDate}T00:00:00Z`).getTime();
      const spanDays = Math.floor((end - start) / 86_400_000) + 1;
      if (spanDays <= 14) {
        return {
          completed_days: 14,
          ready_through_date: "2026-04-02",
        } as never;
      }
      return {
        completed_days: 35,
        ready_through_date: "2026-04-02",
      } as never;
    });
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 35,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaAdDailyCoverage).mockResolvedValue({
      completed_days: 24,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 24,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 10, ready_through_date: "2026-04-02" }],
        ["breakdown_country", { completed_days: 10, ready_through_date: "2026-04-02" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 10, ready_through_date: "2026-04-02" },
        ],
      ]) as never
    );
    vi.mocked(warehouse.getMetaSyncState).mockImplementation(async ({ scope }: { scope: string }) => {
      if (scope === "account_daily") {
        return [
          {
            providerAccountId: "act_1",
            completedDays: 35,
            readyThroughDate: "2026-04-02",
            latestBackgroundActivityAt: "2026-04-03T09:00:00.000Z",
            deadLetterCount: 0,
          },
        ] as never;
      }
      return [] as never;
    });

    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/status?businessId=biz&startDate=${today}&endDate=${today}`
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("stale");
    expect(payload.readinessLevel).toBe("ready");
    expect(payload.domainReadiness?.summary ?? null).toBeNull();
    expect(payload.currentCoreUsable).toBe(true);
    expect(payload.currentCoreProgressPercent).toBe(100);
    expect(payload.historicalArchiveComplete).toBe(false);
    expect(payload.historicalArchiveProgressPercent).toBe(10);
    expect(payload.latestSync?.progressPercent).toBe(100);
    expect(payload.latestSync?.completedDays).toBe(1);
    expect(payload.latestSync?.totalDays).toBe(1);
    expect(payload.latestSync?.readyThroughDate).toBe(today);
    expect(payload.pageReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "current_day_live",
    });
  });

  it("reports selected-range truth as ready when the requested range is complete and no blocker is present", async () => {
    const today = getUtcTodayIso();
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: null,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: null,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: today,
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: today,
    } as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/status?businessId=biz&startDate=${today}&endDate=${today}`
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("ready");
    expect(payload.readinessLevel).toBe("ready");
    expect(payload.currentCoreUsable).toBe(true);
    expect(payload.latestSync?.progressPercent).toBe(100);
    expect(payload.latestSync?.completedDays).toBe(1);
    expect(payload.latestSync?.totalDays).toBe(1);
    expect(payload.pageReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "current_day_live",
      missingRequiredSurfaces: [],
    });
    expect(payload.currentDayLive).toEqual({
      summaryAvailable: true,
      campaignsAvailable: true,
    });
  });

  it("exposes live Meta protected published truth review when protected rows are visible", async () => {
    vi.mocked(metaRetention.getMetaProtectedPublishedTruthReview).mockResolvedValue({
      runtimeAvailable: true,
      asOfDate: "2026-04-13",
      scope: {
        kind: "selected_businesses",
        businessIds: ["biz"],
      },
      hasNonZeroProtectedPublishedRows: true,
      protectedPublishedRows: 24,
      activePublicationPointerRows: 6,
      protectedTruthClassesPresent: [
        "core_daily_rows",
        "active_publication_pointers",
        "active_published_slice_versions",
      ],
      protectedTruthClassesAbsent: [
        "breakdown_daily_rows",
        "active_source_manifests",
        "published_day_state",
      ],
      classes: [
        {
          key: "core_daily_rows",
          label: "Protected core daily rows",
          present: true,
          observed: true,
          protectedRows: 24,
          latestProtectedValue: "2026-04-12",
        },
        {
          key: "active_publication_pointers",
          label: "Active publication pointers",
          present: true,
          observed: true,
          protectedRows: 6,
          latestProtectedValue: "2026-04-12",
        },
      ],
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&diagnostics=1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.operatorTruth).toMatchObject({
      protectedPublishedTruth: {
        state: "present",
        hasNonZeroProtectedPublishedRows: true,
        protectedPublishedRows: 24,
        activePublicationPointerRows: 6,
      },
    });
    expect(payload.protectedPublishedTruth).toMatchObject({
      state: "present",
      runtimeAvailable: true,
      hasNonZeroProtectedPublishedRows: true,
      protectedPublishedRows: 24,
      activePublicationPointerRows: 6,
      protectedTruthClassesPresent: [
        "core_daily_rows",
        "active_publication_pointers",
        "active_published_slice_versions",
      ],
    });
  });

  it("surfaces blocked publication mismatches as action-required selected-range truth", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(workerHealth.getProviderWorkerHealthState).mockResolvedValue({
      workerHealthy: true,
      heartbeatAgeMs: 5_000,
      runnerLeaseActive: true,
      ownerWorkerId: "worker-1",
      consumeStage: "consuming",
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "blocked",
      totalDays: 1,
      completedCoreDays: 0,
      blockingReasons: [],
      reasonCounts: {
        blocked: 1,
        publication_pointer_missing_after_finalize: 1,
      },
      detectorReasonCodes: ["publication_pointer_missing_after_finalize"],
      verificationState: "blocked",
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: null,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: null,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(metaRetention.getMetaProtectedPublishedTruthReview).mockResolvedValue({
      runtimeAvailable: true,
      asOfDate: "2026-04-13",
      scope: {
        kind: "selected_businesses",
        businessIds: ["biz"],
      },
      hasNonZeroProtectedPublishedRows: false,
      protectedPublishedRows: 0,
      activePublicationPointerRows: 0,
      protectedTruthClassesPresent: [],
      protectedTruthClassesAbsent: [
        "core_daily_rows",
        "breakdown_daily_rows",
        "active_publication_pointers",
        "active_published_slice_versions",
        "active_source_manifests",
        "published_day_state",
      ],
      classes: [],
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-10&endDate=2026-04-10&diagnostics=1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("action_required");
    expect(payload.selectedRangeTruth).toMatchObject({
      verificationState: "blocked",
      detectorReasonCodes: ["publication_pointer_missing_after_finalize"],
    });
    expect(payload.pageReadiness.requiredSurfaces.summary).toMatchObject({
      state: "blocked",
      reason:
        "Historical Meta publication is blocked because finalized work does not match the required published truth.",
    });
    expect(payload.operations).not.toBeNull();
    expect(payload.operations.blockingReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "blocked_publication_mismatch",
        }),
      ]),
    );
    expect(payload.operatorTruth).toMatchObject({
      rolloutModel: "global",
      reviewWorkflow: {
        adminSurface: "/admin/sync-health",
        executionReviewCommand: "npm run ops:execution-readiness-review",
        readyMeans: "evidence_only",
        automaticEnablement: false,
      },
      rebuild: {
        state: "blocked",
        blocked: true,
        repairRequired: false,
      },
      protectedPublishedTruth: {
        state: "publication_missing",
        hasNonZeroProtectedPublishedRows: false,
      },
    });
    expect(payload.protectedPublishedTruth).toMatchObject({
      state: "publication_missing",
      protectedPublishedRows: 0,
      activePublicationPointerRows: 0,
    });
  });

  it("keeps selected-range surfaces usable when historical coverage is complete but publication truth is unavailable", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockRejectedValue(
      new Error("verification unavailable"),
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: null,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: null,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-10&endDate=2026-04-10"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("ready");
    expect(payload.selectedRangeTruth).toBeNull();
    expect(payload.currentCoreUsable).toBe(true);
    expect(payload.pageReadiness.requiredSurfaces.summary.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces.campaigns.state).toBe("ready");
    expect(payload.warehouse.coverage.selectedRange).toMatchObject({
      completedDays: 1,
      totalDays: 1,
      isComplete: true,
    });
    expect(payload.latestSync).toMatchObject({
      completedDays: 1,
      totalDays: 1,
      readyThroughDate: "2026-03-30",
    });
  });

  it("surfaces cold rebuild and quota pressure without overstating readiness", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "act_1", name: "Main", timezone: "UTC" }],
      meta: {
        source: "snapshot",
        sourceHealth: "stale_cached",
        fetchedAt: null,
        stale: true,
        refreshFailed: true,
        failureClass: "quota",
        lastError: "Rate limit exceeded",
        lastKnownGoodAvailable: true,
        refreshRequestedAt: null,
        lastRefreshAttemptAt: null,
        nextRefreshAfter: "2026-04-13T12:30:00.000Z",
        retryAfterAt: "2026-04-13T12:30:00.000Z",
        refreshInProgress: false,
        sourceReason: "rate_limited",
      },
    });
    vi.mocked(warehouse.getMetaAccountDailyStats).mockResolvedValue({
      row_count: 0,
      first_date: null,
      last_date: null,
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaAdDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaCreativeDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 3,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: null,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: "2026-04-10",
      historicalCoreQueueDepth: 3,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 0,
      blockingReasons: [],
      reasonCounts: {},
      detectorReasonCodes: [],
      verificationState: "processing",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-10&endDate=2026-04-10"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.readinessLevel).not.toBe("ready");
    expect(payload.operatorTruth).toMatchObject({
      rolloutModel: "global",
      rebuild: {
        state: "quota_limited",
        coldBootstrap: true,
        backfillInProgress: true,
        quotaLimited: true,
      },
    });
  });

  it("does not mark current-day summary or campaigns ready when live availability is missing", async () => {
    const today = getUtcTodayIso();
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(live.getMetaCurrentDayLiveAvailability).mockResolvedValue({
      summaryAvailable: false,
      campaignsAvailable: false,
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 1,
      leasedPartitions: 1,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: `${today}T09:00:00.000Z`,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: today,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 1,
      extendedRecentLeasedPartitions: 1,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/status?businessId=biz&startDate=${today}&endDate=${today}`
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.currentDayLive).toEqual({
      summaryAvailable: false,
      campaignsAvailable: false,
    });
    expect(payload.pageReadiness.usable).toBe(false);
    expect(payload.pageReadiness.requiredSurfaces.summary.state).not.toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces.campaigns.state).not.toBe("ready");
    expect(payload.pageReadiness.missingRequiredSurfaces).toEqual(
      expect.arrayContaining(["summary", "campaigns"])
    );
  });

  it("keeps current-day unusable when only live summary is available", async () => {
    const today = getUtcTodayIso();
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(live.getMetaCurrentDayLiveAvailability).mockResolvedValue({
      summaryAvailable: true,
      campaignsAvailable: false,
    } as never);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 1,
      leasedPartitions: 1,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: `${today}T09:00:00.000Z`,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: today,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 1,
      extendedRecentLeasedPartitions: 1,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/status?businessId=biz&startDate=${today}&endDate=${today}`
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.currentDayLive).toEqual({
      summaryAvailable: true,
      campaignsAvailable: false,
    });
    expect(payload.coreReadiness).toMatchObject({
      state: "syncing",
      usable: false,
      complete: false,
      missingSurfaces: ["campaigns"],
    });
    expect(payload.pageReadiness.usable).toBe(false);
    expect(payload.pageReadiness.requiredSurfaces.summary.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces.campaigns.state).not.toBe("ready");
    expect(payload.pageReadiness.missingRequiredSurfaces).toEqual(
      expect.arrayContaining(["campaigns"])
    );
  });

  it("reports selected-range truth as partial when breakdowns are missing but summary and campaigns are ready", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 1, ready_through_date: "2026-04-01" }],
        ["breakdown_country", { completed_days: 1, ready_through_date: "2026-04-01" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 1, ready_through_date: "2026-04-01" },
        ],
      ]) as never
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-01&endDate=2026-04-02"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness).toMatchObject({
      state: "partial",
      usable: true,
      complete: false,
      selectedRangeMode: "historical_warehouse",
      missingRequiredSurfaces: [
        "breakdowns.age",
        "breakdowns.location",
        "breakdowns.placement",
      ],
    });
    expect(payload.coreReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      percent: 100,
      missingSurfaces: [],
    });
    expect(payload.extendedCompleteness).toMatchObject({
      state: "partial",
      complete: false,
      percent: 50,
      missingSurfaces: [
        "breakdowns.age",
        "breakdowns.location",
        "breakdowns.placement",
      ],
    });
    expect(payload.pageReadiness.requiredSurfaces.summary.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces.campaigns.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("partial");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("partial");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("partial");
    expect(payload.pageReadiness.optionalSurfaces.adsets.countsForPageCompleteness).toBe(false);
    expect(payload.pageReadiness.optionalSurfaces.recommendations.countsForPageCompleteness).toBe(false);
    expect(payload.warehouse.coverage.breakdownsBySurface).toEqual({
      age: {
        completedDays: 1,
        totalDays: 2,
        readyThroughDate: "2026-04-01",
        isComplete: false,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
      location: {
        completedDays: 1,
        totalDays: 2,
        readyThroughDate: "2026-04-01",
        isComplete: false,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
      placement: {
        completedDays: 1,
        totalDays: 2,
        readyThroughDate: "2026-04-01",
        isComplete: false,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
    });
  });

  it("keeps historical surfaces ready while finalize is pending in the background", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 1,
      blockingReasons: ["non_finalized"],
      reasonCounts: {
        non_finalized: 1,
        validation_failed: 1,
        missing_breakdown: 1,
      },
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 1, ready_through_date: "2026-04-07" }],
        ["breakdown_country", { completed_days: 1, ready_through_date: "2026-04-07" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 1, ready_through_date: "2026-04-07" },
        ],
      ]) as never
    );
    vi.mocked(warehouse.getMetaAuthoritativeDayVerification).mockResolvedValue({
      businessId: "biz",
      providerAccountId: "act_1",
      day: "2026-04-12",
      verificationState: "processing",
      sourceManifestState: "running",
      validationState: "processing",
      activePublication: null,
      surfaces: [],
      lastFailure: null,
      detectorReasonCodes: [],
      repairBacklog: 0,
      deadLetters: 0,
      staleLeases: 0,
      queuedPartitions: 0,
      leasedPartitions: 1,
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-07&endDate=2026-04-07"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness.requiredSurfaces.summary.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces.campaigns.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("ready");
    expect(payload.d1FinalizeState).toBe("processing");
    expect(payload.d1BlockedReason).toBe("active_finalize_day_partition");
  });

  it("reports only the age breakdown surface as ready when only the age endpoint is complete", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 2, ready_through_date: "2026-04-02" }],
        ["breakdown_country", { completed_days: 0, ready_through_date: null }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 0, ready_through_date: null },
        ],
      ]) as never
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-01&endDate=2026-04-02"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("partial");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("partial");
    expect(payload.pageReadiness.missingRequiredSurfaces).toEqual([
      "breakdowns.location",
      "breakdowns.placement",
    ]);
  });

  it("reports only the placement breakdown surface as missing when only placement lags", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 2, ready_through_date: "2026-04-02" }],
        ["breakdown_country", { completed_days: 2, ready_through_date: "2026-04-02" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 1, ready_through_date: "2026-04-01" },
        ],
      ]) as never
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-01&endDate=2026-04-02"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("partial");
    expect(payload.pageReadiness.missingRequiredSurfaces).toEqual(["breakdowns.placement"]);
    expect(payload.pageReadiness.reason).toBe(
      "Placement breakdown data is still being prepared for the selected range."
    );
  });

  it("treats selected-range breakdowns as complete when published truth is finalized even if raw coverage lags", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: true,
      state: "finalized_verified",
      verificationState: "finalized_verified",
      totalDays: 2,
      completedCoreDays: 2,
      blockingReasons: [],
      reasonCounts: {},
      sourceFetchedAt: "2026-04-02T00:00:00Z",
      publishedAt: "2026-04-02T00:05:00Z",
      asOf: "2026-04-02T00:05:00Z",
    } as never);
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 0, ready_through_date: null }],
        ["breakdown_country", { completed_days: 0, ready_through_date: null }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 0, ready_through_date: null },
        ],
      ]) as never
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-01&endDate=2026-04-02"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.extendedCompleteness).toMatchObject({
      state: "ready",
      complete: true,
      percent: 100,
      missingSurfaces: [],
      blockedSurfaces: [],
    });
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("ready");
    expect(payload.warehouse.coverage.breakdownsBySurface).toEqual({
      age: {
        completedDays: 2,
        totalDays: 2,
        readyThroughDate: "2026-04-02",
        isComplete: true,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
      location: {
        completedDays: 2,
        totalDays: 2,
        readyThroughDate: "2026-04-02",
        isComplete: true,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
      placement: {
        completedDays: 2,
        totalDays: 2,
        readyThroughDate: "2026-04-02",
        isComplete: true,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
    });
  });

  it("reports selected-range truth as syncing when no required surface is usable and active work exists", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 0,
      ready_through_date: null,
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 0, ready_through_date: null }],
        ["breakdown_country", { completed_days: 0, ready_through_date: null }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 0, ready_through_date: null },
        ],
      ]) as never
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 4,
      leasedPartitions: 1,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: "2026-04-03T09:00:00.000Z",
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: "2026-04-01",
      historicalCoreQueueDepth: 4,
      historicalCoreLeasedPartitions: 1,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 0,
      blockingReasons: ["non_finalized"],
      reasonCounts: { non_finalized: 1 },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-02&endDate=2026-04-02"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness).toMatchObject({
      state: "syncing",
      usable: false,
      complete: false,
      selectedRangeMode: "historical_warehouse",
    });
    expect(payload.pageReadiness.requiredSurfaces.summary.state).toBe("syncing");
    expect(payload.pageReadiness.requiredSurfaces.campaigns.state).toBe("syncing");
  });

  it("keeps selected-range core and breakdown surfaces ready when warehouse coverage is complete but publication proof is still processing", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 7,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 7,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 7,
      ready_through_date: "2026-04-07",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 7, ready_through_date: "2026-04-07" }],
        ["breakdown_country", { completed_days: 7, ready_through_date: "2026-04-07" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 7, ready_through_date: "2026-04-07" },
        ],
      ]) as never
    );
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      verificationState: "processing",
      totalDays: 7,
      completedCoreDays: 6,
      blockingReasons: [],
      reasonCounts: { non_finalized: 1 },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-01&endDate=2026-04-07"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.selectedRangeTruth).toMatchObject({
      truthReady: false,
      verificationState: "processing",
    });
    expect(payload.coreReadiness).toMatchObject({
      state: "ready",
      usable: true,
      percent: 100,
    });
    expect(payload.pageReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "historical_warehouse",
    });
    expect(payload.pageReadiness.requiredSurfaces.summary.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces.campaigns.state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("ready");
  });

  it("reports current-day selected-range truth as partial when live breakdowns are still preparing", async () => {
    const today = getUtcTodayIso();
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: today,
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 1,
      ready_through_date: today,
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 0, ready_through_date: null }],
        ["breakdown_country", { completed_days: 0, ready_through_date: null }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 0, ready_through_date: null },
        ],
      ]) as never
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 1,
      leasedPartitions: 1,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: `${today}T09:00:00.000Z`,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: today,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 1,
      extendedRecentLeasedPartitions: 1,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/status?businessId=biz&startDate=${today}&endDate=${today}`
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness).toMatchObject({
      state: "partial",
      usable: true,
      complete: false,
      selectedRangeMode: "current_day_live",
      missingRequiredSurfaces: [
        "breakdowns.age",
        "breakdowns.location",
        "breakdowns.placement",
      ],
    });
  });

  it("treats selected ranges ending today as ready when historical coverage is complete and current-day live core is available", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 6,
      ready_through_date: "2026-04-12",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 6,
      ready_through_date: "2026-04-12",
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 6,
      ready_through_date: "2026-04-12",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 6, ready_through_date: "2026-04-12" }],
        ["breakdown_country", { completed_days: 6, ready_through_date: "2026-04-12" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 6, ready_through_date: "2026-04-12" },
        ],
      ]) as never
    );
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      verificationState: "processing",
      totalDays: 6,
      completedCoreDays: 6,
      blockingReasons: [],
      reasonCounts: { non_finalized: 1 },
    } as never);
    vi.mocked(live.getMetaCurrentDayLiveAvailability).mockResolvedValue({
      summaryAvailable: true,
      campaignsAvailable: true,
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-07&endDate=2026-04-13"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness)).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-04-07",
        endDate: "2026-04-12",
      })
    );
    expect(vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint)).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-04-07",
        endDate: "2026-04-12",
      })
    );
    expect(payload.currentCoreProgressPercent).toBe(100);
    expect(payload.coreReadiness).toMatchObject({
      state: "ready",
      usable: true,
      percent: 100,
    });
    expect(payload.pageReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "historical_live_fallback",
    });
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("ready");
    expect(payload.extendedCompleteness).toEqual({
      state: "ready",
      complete: true,
      percent: 100,
      reason: null,
      summary: "Breakdown data is ready for the selected range.",
      missingSurfaces: [],
      blockedSurfaces: [],
      surfaces: {
        "breakdowns.age": {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
        "breakdowns.location": {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
        "breakdowns.placement": {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
      },
    });
    expect(payload.warehouse.coverage.selectedRange).toMatchObject({
      endDate: "2026-04-12",
      completedDays: 6,
      totalDays: 6,
      isComplete: true,
    });
    expect(payload.warehouse.coverage.breakdownsBySurface).toEqual({
      age: {
        completedDays: 6,
        totalDays: 6,
        readyThroughDate: "2026-04-12",
        isComplete: true,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
      location: {
        completedDays: 6,
        totalDays: 6,
        readyThroughDate: "2026-04-12",
        isComplete: true,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
      placement: {
        completedDays: 6,
        totalDays: 6,
        readyThroughDate: "2026-04-12",
        isComplete: true,
        supportStartDate: "2000-01-01",
        isBlocked: false,
      },
    });
    expect(payload.priorityWindow).toMatchObject({
      endDate: "2026-04-12",
      completedDays: 6,
      totalDays: 6,
    });
  });

  it("treats selected ranges ending today as ready once historical coverage is complete even if current-day live core is still unavailable", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 6,
      ready_through_date: "2026-04-12",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 6,
      ready_through_date: "2026-04-12",
    } as never);
    vi.mocked(warehouse.getMetaAdSetDailyCoverage).mockResolvedValue({
      completed_days: 6,
      ready_through_date: "2026-04-12",
    } as never);
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 6, ready_through_date: "2026-04-12" }],
        ["breakdown_country", { completed_days: 6, ready_through_date: "2026-04-12" }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 6, ready_through_date: "2026-04-12" },
        ],
      ]) as never
    );
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      verificationState: "processing",
      totalDays: 6,
      completedCoreDays: 6,
      blockingReasons: [],
      reasonCounts: { non_finalized: 1 },
    } as never);
    vi.mocked(live.getMetaCurrentDayLiveAvailability).mockResolvedValue({
      summaryAvailable: false,
      campaignsAvailable: false,
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-07&endDate=2026-04-13"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.currentCoreProgressPercent).toBe(100);
    expect(payload.state).toBe("ready");
    expect(payload.coreReadiness).toMatchObject({
      state: "ready",
      usable: true,
      percent: 100,
      summary: "Summary and campaign data are ready for the selected range.",
    });
    expect(payload.pageReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "historical_live_fallback",
    });
    expect(payload.priorityWindow).toMatchObject({
      endDate: "2026-04-12",
      completedDays: 6,
      totalDays: 6,
    });
  });

  it("aligns selected-range status with current-day-live detector proof when the route-local date boundary already rolled forward", async () => {
    vi.setSystemTime(new Date("2026-04-20T00:05:00Z"));
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "act_1", name: "Main", timezone: "UTC" }],
      meta: {
        source: "snapshot",
        sourceHealth: "healthy_cached",
        fetchedAt: null,
        stale: false,
        refreshFailed: false,
        failureClass: null,
        lastError: null,
        lastKnownGoodAvailable: true,
        refreshRequestedAt: null,
        lastRefreshAttemptAt: null,
        nextRefreshAfter: null,
        retryAfterAt: null,
        refreshInProgress: false,
        sourceReason: null,
      },
    });
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockImplementation(
      async ({ startDate, endDate }: { startDate: string; endDate: string }) =>
        ({
          completed_days:
            startDate === "2026-04-13" && endDate === "2026-04-19" ? 6 : 365,
          ready_through_date:
            startDate === "2026-04-13" && endDate === "2026-04-19"
              ? "2026-04-18"
              : "2026-04-19",
        }) as never,
    );
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockImplementation(
      async ({ startDate, endDate }: { startDate: string; endDate: string }) =>
        ({
          completed_days:
            startDate === "2026-04-13" && endDate === "2026-04-19" ? 6 : 365,
          ready_through_date:
            startDate === "2026-04-13" && endDate === "2026-04-19"
              ? "2026-04-18"
              : "2026-04-19",
        }) as never,
    );
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockImplementation(
      async ({ startDate, endDate }: { startDate: string; endDate: string }) =>
        new Map([
          [
            "breakdown_age",
            {
              completed_days:
                startDate === "2026-04-13" && endDate === "2026-04-19" ? 6 : 365,
              ready_through_date:
                startDate === "2026-04-13" && endDate === "2026-04-19"
                  ? "2026-04-18"
                  : "2026-04-19",
            },
          ],
          [
            "breakdown_country",
            {
              completed_days:
                startDate === "2026-04-13" && endDate === "2026-04-19" ? 6 : 365,
              ready_through_date:
                startDate === "2026-04-13" && endDate === "2026-04-19"
                  ? "2026-04-18"
                  : "2026-04-19",
            },
          ],
          [
            "breakdown_publisher_platform,platform_position,impression_device",
            {
              completed_days:
                startDate === "2026-04-13" && endDate === "2026-04-19" ? 6 : 365,
              ready_through_date:
                startDate === "2026-04-13" && endDate === "2026-04-19"
                  ? "2026-04-18"
                  : "2026-04-19",
            },
          ],
        ]) as never,
    );
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      verificationState: "processing",
      totalDays: 7,
      completedCoreDays: 6,
      blockingReasons: [],
      reasonCounts: { current_day_live: 10, processing: 10 },
      detectorReasonCodes: ["current_day_live"],
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2026-04-13&endDate=2026-04-19",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("ready");
    expect(payload.currentCoreProgressPercent).toBe(100);
    expect(payload.selectedRangeTruth).toMatchObject({
      verificationState: "processing",
      detectorReasonCodes: ["current_day_live"],
    });
    expect(payload.pageReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "historical_live_fallback",
    });
    expect(payload.coreReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      percent: 100,
    });
    expect(payload.extendedCompleteness).toMatchObject({
      state: "ready",
      complete: true,
      percent: 100,
    });
    expect(payload.warehouse.coverage.selectedRange).toMatchObject({
      endDate: "2026-04-18",
      completedDays: 6,
      totalDays: 6,
      isComplete: true,
    });
    expect(payload.priorityWindow).toMatchObject({
      endDate: "2026-04-18",
      completedDays: 6,
      totalDays: 6,
    });
  });

  it("reports current-day breakdown surfaces independently", async () => {
    const today = getUtcTodayIso();
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(warehouse.getMetaRawSnapshotCoverageByEndpoint).mockResolvedValue(
      new Map([
        ["breakdown_age", { completed_days: 1, ready_through_date: today }],
        ["breakdown_country", { completed_days: 0, ready_through_date: null }],
        [
          "breakdown_publisher_platform,platform_position,impression_device",
          { completed_days: 0, ready_through_date: null },
        ],
      ]) as never
    );
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 1,
      leasedPartitions: 1,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      latestCoreActivityAt: `${today}T09:00:00.000Z`,
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
      oldestQueuedPartition: today,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      extendedRecentQueueDepth: 1,
      extendedRecentLeasedPartitions: 1,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
    } as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/status?businessId=biz&startDate=${today}&endDate=${today}`
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("ready");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("syncing");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("syncing");
    expect(payload.pageReadiness.missingRequiredSurfaces).toEqual([
      "breakdowns.location",
      "breakdowns.placement",
    ]);
  });

  it("marks each breakdown surface blocked independently when the range is outside support", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_meta",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: null,
      provider_account_name: null,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(constraints.getMetaBreakdownSupportedStart).mockReturnValue("2026-04-10");
    vi.mocked(warehouse.getMetaAccountDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);
    vi.mocked(warehouse.getMetaCampaignDailyCoverage).mockResolvedValue({
      completed_days: 2,
      ready_through_date: "2026-04-02",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/status?businessId=biz&startDate=2020-04-01&endDate=2020-04-02"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].state).toBe("blocked");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].state).toBe("blocked");
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].state).toBe("blocked");
    expect(payload.coreReadiness).toMatchObject({
      state: "ready",
      usable: true,
      complete: true,
      missingSurfaces: [],
    });
    expect(payload.extendedCompleteness).toMatchObject({
      state: "blocked",
      complete: false,
      percent: null,
      blockedSurfaces: [
        "breakdowns.age",
        "breakdowns.location",
        "breakdowns.placement",
      ],
    });
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.age"].reason).toBe(
      "Age breakdown data is only supported from 2026-04-10 onward for the selected range."
    );
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.location"].reason).toBe(
      "Country breakdown data is only supported from 2026-04-10 onward for the selected range."
    );
    expect(payload.pageReadiness.requiredSurfaces["breakdowns.placement"].reason).toBe(
      "Placement breakdown data is only supported from 2026-04-10 onward for the selected range."
    );
    expect(payload.pageReadiness.missingRequiredSurfaces).toEqual([]);
  });

  it("surfaces the latest remediation execution for the requested business", async () => {
    vi.mocked(remediationExecutions.getLatestSyncRepairExecution).mockResolvedValue({
      id: "exec-1",
      buildId: "dev-build",
      environment: "test",
      providerScope: "meta",
      businessId: "biz",
      businessName: "Biz",
      sourceReleaseGateId: "rg-1",
      sourceRepairPlanId: "rp-1",
      postRunReleaseGateId: "rg-2",
      postRunRepairPlanId: "rp-2",
      recommendedAction: "integrity_repair_enqueue",
      executedAction: "repair_cycle",
      workflowRunId: "run-1",
      workflowActor: "codex",
      lockOwner: "run-1:biz",
      status: "completed",
      outcomeClassification: "improving_not_cleared",
      expectedOutcomeMet: false,
      beforeEvidence: {
        queueDepth: 4,
      },
      actionResult: {},
      afterEvidence: {
        queueDepth: 2,
      },
      startedAt: "2026-04-13T11:59:00.000Z",
      finishedAt: "2026-04-13T12:00:00.000Z",
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.latestRemediationExecution).toMatchObject({
      id: "exec-1",
      sourceReleaseGateId: "rg-1",
      sourceRepairPlanId: "rp-1",
      postRunReleaseGateId: "rg-2",
      postRunRepairPlanId: "rp-2",
      outcomeClassification: "improving_not_cleared",
      recommendedAction: "integrity_repair_enqueue",
      executedAction: "repair_cycle",
    });
  });
});
