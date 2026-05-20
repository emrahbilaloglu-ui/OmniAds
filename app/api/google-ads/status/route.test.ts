import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/google-ads/status/route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegrationMetadata: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES: [
    "provider_account_snapshot_runs",
    "provider_account_snapshot_items",
  ],
  readProviderAccountSnapshot: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES: [
    "business_provider_accounts",
    "provider_accounts",
  ],
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/google-ads/history", () => ({
  GOOGLE_ADS_WAREHOUSE_HISTORY_DAYS: 365,
  addDaysToIsoDate: vi.fn((date: string, days: number) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }),
  dayCountInclusive: vi.fn((start: string, end: string) => {
    const startDate = new Date(`${start}T00:00:00Z`);
    const endDate = new Date(`${end}T00:00:00Z`);
    return Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  }),
  getHistoricalWindowStart: vi.fn((end: string, days: number) => {
    const value = new Date(`${end}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() - (days - 1));
    return value.toISOString().slice(0, 10);
  }),
}));

vi.mock("@/lib/google-ads/core-readiness", () => ({
  buildGoogleAdsCoreReadiness: vi.fn(() => ({
    effectiveHistoricalTotalDays: 365,
    overallCompletedDays: 365,
    overallAccountCompletedDays: 365,
    historicalReadyThroughDate: "2026-03-30",
    productPendingSurfaces: [],
    needsBootstrap: false,
    historicalProgressPercent: 100,
  })),
}));

vi.mock("@/lib/google-ads/warehouse", () => ({
  getGoogleAdsCheckpointHealth: vi.fn(),
  getGoogleAdsCoveredDates: vi.fn(),
  getGoogleAdsDailyCoverage: vi.fn(),
  getGoogleAdsAdvisorSurfacePartitionStates: vi.fn(),
  getGoogleAdsAdvisorQueueHealth: vi.fn(),
  getGoogleAdsQueueHealth: vi.fn(),
  getGoogleAdsSyncState: vi.fn(),
  getLatestGoogleAdsSyncHealth: vi.fn(),
}));

vi.mock("@/lib/google-ads/status-machine", () => ({
  decideGoogleAdsAdvisorReadiness: vi.fn(() => ({
    ready: false,
    notReady: true,
    readinessModel: "recent_84d_required_support",
  })),
  decideGoogleAdsFullSyncPriority: vi.fn(() => ({
    required: false,
    reason: null,
    targetScopes: [],
  })),
  decideGoogleAdsStatusState: vi.fn(() => "not_connected"),
}));

vi.mock("@/lib/google-ads/advisor-windows", () => ({
  countInclusiveDays: vi.fn((start: string, end: string) => {
    const startDate = new Date(`${start}T00:00:00Z`);
    const endDate = new Date(`${end}T00:00:00Z`);
    return Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  }),
}));

vi.mock("@/lib/google-ads/advisor-snapshots", () => ({
  getLatestGoogleAdsAdvisorSnapshot: vi.fn(),
  isGoogleAdsAdvisorSnapshotFresh: vi.fn(() => false),
}));

vi.mock("@/lib/google-ads/advisor-progress", () => ({
  buildGoogleAdsAdvisorProgress: vi.fn(() => ({
    percent: 0,
    visible: false,
    summary: "Finalizing growth analysis.",
  })),
}));

vi.mock("@/lib/google-ads/decision-engine-config", () => ({
  getGoogleAdsDecisionEngineConfig: vi.fn(() => ({
    decisionEngineV2Enabled: true,
    writebackEnabled: false,
    advisorAiStructuredAssistEnabled: false,
  })),
  getGoogleAdsAutomationConfig: vi.fn(() => ({
    decisionEngineV2Enabled: true,
    writebackEnabled: false,
    writebackPilotEnabled: false,
    semiAutonomousBundlesEnabled: false,
    controlledAutonomyEnabled: false,
    autonomyKillSwitchActive: true,
    manualApprovalRequired: true,
    operatorOverrideEnabled: true,
    actionAllowlist: [],
    businessAllowlist: [],
    accountAllowlist: [],
    bundleCooldownHours: 24,
  })),
  getGoogleAdsAutonomyBoundaryState: vi.fn(() => ({
    decisionEngineV2Enabled: true,
    writebackEnabled: false,
    writebackPilotEnabled: false,
    semiAutonomousBundlesEnabled: false,
    controlledAutonomyEnabled: false,
    autonomyKillSwitchActive: true,
    manualApprovalRequired: true,
    operatorOverrideEnabled: true,
    actionAllowlist: [],
    businessAllowlist: [],
    accountAllowlist: [],
    bundleCooldownHours: 24,
    businessAllowed: true,
    accountAllowed: true,
    semiAutonomousEligible: false,
    controlledAutonomyEligible: false,
    blockedReasons: [
      "Autonomy kill switch is active.",
      "Manual approval is still required.",
      "No Google Ads action families are allowlisted for autonomous execution.",
    ],
  })),
  getGoogleAdsAdvisorAiStructuredAssistBoundaryState: vi.fn(() => ({
    enabled: false,
    businessAllowlist: [],
    mode: "snapshot_time",
    scope: "unmapped_only",
    businessScoped: false,
    businessAllowed: false,
    eligible: false,
    blockedReasons: [
      "AI structured assist flag is disabled.",
      "No business allowlist is configured for AI structured assist.",
    ],
  })),
}));

vi.mock("@/lib/google-ads/warehouse-retention", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-ads/warehouse-retention")>(
    "@/lib/google-ads/warehouse-retention"
  );
  return {
    ...actual,
    getGoogleAdsRetentionRuntimeStatus: vi.fn(() => ({
      runtimeAvailable: false,
      executionEnabled: false,
      mode: "dry_run",
      gateReason: "Retention execution is disabled.",
    })),
    getLatestGoogleAdsRetentionRun: vi.fn(async () => null),
  };
});

vi.mock("@/lib/google-ads/search-intelligence-storage", () => ({
  readGoogleAdsSearchIntelligenceCoverage: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

vi.mock("@/lib/provider-readiness", async () => {
  const actual = await vi.importActual<typeof import("@/lib/provider-readiness")>(
    "@/lib/provider-readiness"
  );
  return actual;
});

vi.mock("@/lib/provider-request-governance", () => ({
  getProviderCircuitBreakerRecoveryState: vi.fn(() => "closed"),
  getProviderQuotaBudgetState: vi.fn(() => null),
}));

vi.mock("@/lib/sync/google-ads-sync", () => ({
  buildGoogleAdsLaneAdmissionPolicy: vi.fn(() => ({})),
  getGoogleAdsExtendedRecoveryBlockReason: vi.fn(() => null),
  getGoogleAdsWorkerSchedulingState: vi.fn(() => null),
  isGoogleAdsExtendedCanaryBusiness: vi.fn(() => false),
  isGoogleAdsIncidentSafeModeEnabled: vi.fn(() => false),
}));

vi.mock("@/lib/sync/release-gates", () => ({
  classifyProviderReleaseTruth: vi.fn((input) => ({
    pass:
      (input?.activityState === "ready" || input?.activityState === "busy") &&
      input?.truthReady === true &&
      input?.progressState !== "blocked" &&
      input?.activityState !== "blocked" &&
      (input?.queueDepth === 0 ||
        input?.leasedPartitions > 0 ||
        input?.progressState === "partial_progressing"),
    blockerClass:
      input?.workerOnline === false && input?.queueDepth > 0 && input?.leasedPartitions === 0
        ? "worker_unavailable"
        : input?.progressState === "blocked" || input?.activityState === "blocked"
          ? "queue_blocked"
          : input?.activityState === "stalled" || input?.progressState === "partial_stuck"
            ? "stalled"
            : (input?.activityState === "ready" || input?.activityState === "busy") &&
                input?.truthReady === true &&
                (input?.queueDepth === 0 ||
                  input?.leasedPartitions > 0 ||
                  input?.progressState === "partial_progressing")
              ? "none"
              : "not_release_ready",
    evidence: {
      truthReady: input?.truthReady ?? false,
      queueDepth: input?.queueDepth ?? 0,
      leasedPartitions: input?.leasedPartitions ?? 0,
    },
  })),
  getLatestSyncGateRecords: vi.fn(),
}));

vi.mock("@/lib/sync/repair-planner", () => ({
  evaluateAndPersistSyncRepairPlan: vi.fn(),
  getLatestSyncRepairPlan: vi.fn(),
}));

vi.mock("@/lib/sync/control-plane-persistence", () => ({
  getSyncControlPlanePersistenceStatus: vi.fn(),
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

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const integrations = await import("@/lib/integrations");
const snapshots = await import("@/lib/provider-account-snapshots");
const assignments = await import("@/lib/provider-account-assignments");
const coreReadiness = await import("@/lib/google-ads/core-readiness");
const warehouse = await import("@/lib/google-ads/warehouse");
const advisorSnapshots = await import("@/lib/google-ads/advisor-snapshots");
const warehouseRetention = await import("@/lib/google-ads/warehouse-retention");
const searchIntelligenceStorage = await import("@/lib/google-ads/search-intelligence-storage");
const migrations = await import("@/lib/migrations");
const statusMachine = await import("@/lib/google-ads/status-machine");
const requestGovernance = await import("@/lib/provider-request-governance");
const googleAdsSync = await import("@/lib/sync/google-ads-sync");
const releaseGates = await import("@/lib/sync/release-gates");
const repairPlanner = await import("@/lib/sync/repair-planner");
const controlPlanePersistence = await import("@/lib/sync/control-plane-persistence");
const incidents = await import("@/lib/sync/incidents");

describe("GET /api/google-ads/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
      id: "asg_google",
      business_id: "biz",
      provider: "google",
      account_ids: ["acc_1"],
      created_at: "",
      updated_at: "",
    });
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "acc_1", name: "Main", timezone: "UTC" }],
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
    vi.mocked(warehouse.getLatestGoogleAdsSyncHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getGoogleAdsCheckpointHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getGoogleAdsDailyCoverage).mockResolvedValue({
      completed_days: 365,
      ready_through_date: "2026-03-30",
      latest_updated_at: null,
      total_rows: 10,
    } as never);
    vi.mocked(warehouse.getGoogleAdsCoveredDates).mockResolvedValue([] as never);
    vi.mocked(warehouse.getGoogleAdsAdvisorSurfacePartitionStates).mockResolvedValue([]);
    vi.mocked(warehouse.getGoogleAdsAdvisorQueueHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getGoogleAdsQueueHealth).mockResolvedValue(null as never);
    vi.mocked(warehouse.getGoogleAdsSyncState).mockResolvedValue([]);
    vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("not_connected");
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: null,
    } as never);
    vi.mocked(repairPlanner.getLatestSyncRepairPlan).mockResolvedValue(null);
    vi.mocked(repairPlanner.evaluateAndPersistSyncRepairPlan).mockResolvedValue({
      id: "rp-healed",
      buildId: "runtime-build",
      environment: "production",
      providerScope: "google_ads",
      planMode: "dry_run",
      eligible: true,
      blockedReason: null,
      breakGlass: false,
      summary: "Google repair dry-run proposed 0 recommendation(s).",
      recommendations: [],
      emittedAt: "2026-04-10T00:00:00.000Z",
    } as never);
    vi.mocked(controlPlanePersistence.getSyncControlPlanePersistenceStatus).mockResolvedValue({
      identity: {
        buildId: "runtime-build",
        environment: "production",
        providerScope: "google_ads",
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
      missingExact: ["deployGate", "releaseGate", "repairPlan"],
      exactRowsPresent: false,
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
    vi.mocked(advisorSnapshots.getLatestGoogleAdsAdvisorSnapshot).mockResolvedValue(null);
    vi.mocked(warehouseRetention.getLatestGoogleAdsRetentionRun).mockResolvedValue(null);
    vi.mocked(searchIntelligenceStorage.readGoogleAdsSearchIntelligenceCoverage).mockResolvedValue({
      completedDays: 365,
      readyThroughDate: "2026-03-30",
      latestUpdatedAt: null,
      totalRows: 10,
    });

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("COUNT(*)::int AS stale_run_pressure")) return [];
      if (query.includes("COUNT(*)::int AS active_count")) {
        return [{ active_count: 0 }];
      }
      if (query.includes("FROM google_ads_sync_partitions")) return [];
      if (query.includes("FROM google_ads_sync_runs")) return [];
      if (query.includes("COUNT(*) AS row_count")) {
        return [
          {
            row_count: 10,
            first_date: "2025-04-01",
            last_date: "2026-03-30",
            primary_account_timezone: "UTC",
          },
        ];
      }
      throw new Error(`Unexpected query: ${query}`);
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
  });

  it("uses the account platform timezone for current-day live mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:30:00.000Z"));
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
      accounts: [{ id: "acc_1", name: "Main", timezone: "Pacific/Kiritimati" }],
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
      new NextRequest(
        "http://localhost/api/google-ads/status?businessId=biz&startDate=2026-04-08&endDate=2026-04-08"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.servingMode).toBe("warehouse_with_live_overlay");
    expect(payload.currentDateInTimezone).toBe("2026-04-08");
    expect(payload.dataContract).toEqual({
      todayMode: "live_overlay",
      historicalMode: "warehouse_only",
    });
    expect(payload.platformDateBoundary).toMatchObject({
      currentDateInTimezone: "2026-04-08",
      previousDateInTimezone: "2026-04-07",
      selectedRangeMode: "current_day_live",
      mixedCurrentDates: false,
    });
    expect(payload.currentDayLiveStatus).toMatchObject({
      active: true,
      currentDate: "2026-04-08",
      warehouseSegmentEndDate: "2026-04-07",
      liveSegmentStartDate: "2026-04-08",
    });
    expect(payload.advisor.selectedWindow).toMatchObject({
      missingSurfaces: [],
    });
    expect(payload.selectedRangeReadinessBasis).toMatchObject({
      mode: "current_day_live",
      warehouseCoverageIgnored: true,
    });
    vi.useRealTimers();
  });

  it("returns the explicit recent-84-day advisor readiness contract", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
    vi.mocked(statusMachine.decideGoogleAdsAdvisorReadiness).mockReturnValue({
      ready: true,
      notReady: false,
      readinessModel: "recent_84d_required_support",
    });
    vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("ready");
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: {
        id: "dg-1",
        gateKind: "deploy_gate",
        gateScope: "service_liveness",
        buildId: "runtime-build",
        environment: "production",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "deploy ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-10T00:00:00.000Z",
      },
      releaseGate: {
        id: "rg-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "runtime-build",
        environment: "production",
        mode: "measure_only",
        baseResult: "fail",
        verdict: "measure_only",
        blockerClass: "not_release_ready",
        summary: "release pending",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-10T00:00:00.000Z",
      },
    } as never);
    vi.mocked(repairPlanner.getLatestSyncRepairPlan).mockResolvedValue({
      id: "rp-1",
      buildId: "runtime-build",
      environment: "production",
      providerScope: "google_ads",
      planMode: "dry_run",
      eligible: true,
      blockedReason: null,
      breakGlass: false,
      summary: "Google repair dry-run proposed 0 recommendation(s).",
      recommendations: [],
      emittedAt: "2026-04-10T00:00:00.000Z",
    } as never);
    vi.mocked(controlPlanePersistence.getSyncControlPlanePersistenceStatus).mockResolvedValue({
      identity: {
        buildId: "dev-build",
        environment: "test",
        providerScope: "google_ads",
      },
      exact: {
        deployGate: {
          id: "dg-1",
          buildId: "runtime-build",
          environment: "production",
          gateKind: "deploy_gate",
          verdict: "pass",
          emittedAt: "2026-04-10T00:00:00.000Z",
        },
        releaseGate: {
          id: "rg-1",
          buildId: "runtime-build",
          environment: "production",
          gateKind: "release_gate",
          verdict: "measure_only",
          emittedAt: "2026-04-10T00:00:00.000Z",
        },
        repairPlan: {
          id: "rp-1",
          buildId: "runtime-build",
          environment: "production",
          providerScope: "google_ads",
          eligible: true,
          emittedAt: "2026-04-10T00:00:00.000Z",
        },
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
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(statusMachine.decideGoogleAdsAdvisorReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        assignedAccountCount: 1,
        recentSupportReady: true,
        snapshotAvailable: false,
      })
    );
    expect(payload.advisor).toMatchObject({
      ready: true,
      readinessModel: "recent_84d_required_support",
      readinessWindowDays: 84,
    });
    expect(payload.operations).toMatchObject({
      currentMode: "global_backfill",
      globalExtendedExecutionEnabled: true,
      activityState: "ready",
      advisorReadinessModel: "recent_84d_required_support",
      advisorReadinessWindowDays: 84,
      retentionRuntimeAvailable: false,
      retentionExecutionEnabled: false,
      retentionMode: "dry_run",
      retentionDefaultExecutionDisabled: true,
      retentionVerificationCommand:
        "npm run google:ads:retention-canary -- biz",
    });
    expect(payload.operatorTruth).toMatchObject({
      rolloutModel: "global",
      reviewWorkflow: {
        adminSurface: "/admin/sync-health",
        executionReviewCommand: "npm run ops:execution-readiness-review",
        readyMeans: "evidence_only",
        automaticEnablement: false,
      },
      execution: {
        sync: { state: "globally_enabled" },
        retention: { state: "dry_run" },
      },
    });
    expect(payload.retention).toMatchObject({
      runtimeAvailable: false,
      executionEnabled: false,
      defaultExecutionDisabled: true,
      mode: "dry_run",
      rawHotTables: [],
      verification: {
        available: true,
        command: "npm run google:ads:retention-canary -- biz",
      },
    });
    expect(payload.syncTruthState).toBe("ready");
    expect(payload.blockerClass).toBe("none");
    expect(payload.controlPlaneIdentity).toEqual({
      buildId: "dev-build",
      environment: "test",
      providerScope: "google_ads",
    });
    expect(payload.controlPlanePersistence).toMatchObject({
      exactRowsPresent: true,
    });
    expect(payload.controlPlaneErrors).toEqual({
      syncGates: null,
      repairPlan: null,
      controlPlanePersistence: null,
      syncIncidents: null,
    });
    expect(payload.operationalSyncState).toBe("healthy");
    expect(payload.openIncidents).toBe(0);
    expect(payload.degradedServing).toBe(false);
    expect(payload.releaseReadinessCandidate).toMatchObject({
      pass: true,
      blockerClass: "none",
    });
    expect(payload.deployGate).toMatchObject({
      id: "dg-1",
      verdict: "pass",
    });
    expect(payload.releaseGate).toMatchObject({
      id: "rg-1",
      verdict: "measure_only",
    });
    expect(payload.repairPlan).toMatchObject({
      id: "rp-1",
      providerScope: "google_ads",
      recommendations: [],
    });
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("classifies heartbeat-only Google backfill as stalled runtime progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
    vi.mocked(coreReadiness.buildGoogleAdsCoreReadiness).mockReturnValueOnce({
      effectiveHistoricalTotalDays: 90,
      overallCompletedDays: 10,
      overallAccountCompletedDays: 10,
      historicalReadyThroughDate: "2026-01-14",
      productPendingSurfaces: [],
      needsBootstrap: false,
      historicalProgressPercent: 11,
      coreUsable: true,
    } as never);
    vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("ready");
    vi.mocked(googleAdsSync.getGoogleAdsWorkerSchedulingState).mockResolvedValueOnce({
      healthy: true,
      heartbeatAgeMs: 1_000,
      hasFreshHeartbeat: true,
      runnerLeaseActive: true,
      lastHeartbeatAt: "2026-04-21T11:59:59.000Z",
      latestLeaseUpdatedAt: "2026-04-21T11:59:59.000Z",
      ownerWorkerId: "worker-1",
      workerFreshnessState: "online",
      currentBusinessId: "biz",
      lastConsumedBusinessId: "biz",
      consumeStage: "idle",
      batchBusinessIds: ["biz"],
      workerMeta: null,
    });
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: {
        id: "dg-1",
        gateKind: "deploy_gate",
        gateScope: "service_liveness",
        buildId: "runtime-build",
        environment: "production",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "deploy ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-21T11:55:00.000Z",
      },
      releaseGate: {
        id: "rg-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "runtime-build",
        environment: "production",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "release ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-21T11:55:00.000Z",
      },
    } as never);
    vi.mocked(repairPlanner.getLatestSyncRepairPlan).mockResolvedValue({
      id: "rp-1",
      buildId: "runtime-build",
      environment: "production",
      providerScope: "google_ads",
      planMode: "dry_run",
      eligible: true,
      blockedReason: null,
      breakGlass: false,
      summary: "Google repair dry-run proposed 0 recommendation(s).",
      recommendations: [],
      emittedAt: "2026-04-21T11:55:00.000Z",
    } as never);
    vi.mocked(controlPlanePersistence.getSyncControlPlanePersistenceStatus).mockResolvedValue({
      identity: {
        buildId: "runtime-build",
        environment: "production",
        providerScope: "google_ads",
      },
      exact: {
        deployGate: {
          id: "dg-1",
          buildId: "runtime-build",
          environment: "production",
          gateKind: "deploy_gate",
          verdict: "pass",
          emittedAt: "2026-04-21T11:55:00.000Z",
        },
        releaseGate: {
          id: "rg-1",
          buildId: "runtime-build",
          environment: "production",
          gateKind: "release_gate",
          verdict: "pass",
          emittedAt: "2026-04-21T11:55:00.000Z",
        },
        repairPlan: {
          id: "rp-1",
          buildId: "runtime-build",
          environment: "production",
          providerScope: "google_ads",
          eligible: true,
          emittedAt: "2026-04-21T11:55:00.000Z",
        },
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
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.backgroundBackfill).toMatchObject({
      state: "stalled",
      incomplete: true,
      percent: 11,
      pendingScopes: ["account_daily", "campaign_daily"],
      readyThroughDate: "2026-01-14",
    });
    expect(payload.runtimeProgress).toMatchObject({
      meaningfulProgressRecent: false,
      heartbeatOnly: true,
      observationWindowMinutes: 30,
    });
    expect(payload.operations.stallFingerprints).toEqual(
      expect.arrayContaining(["historical_starvation", "checkpoint_not_advancing"]),
    );
    expect(payload.userVisibleSyncState).toMatchObject({
      kind: "refreshing_in_background",
      suppressRecoverableAttention: true,
    });
    vi.useRealTimers();
  });

  it("treats usable core data with recent background progress as release-ready even when backfill queue remains", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
    vi.mocked(coreReadiness.buildGoogleAdsCoreReadiness).mockReturnValueOnce({
      effectiveHistoricalTotalDays: 365,
      overallCompletedDays: 120,
      overallAccountCompletedDays: 120,
      historicalReadyThroughDate: "2025-07-14",
      productPendingSurfaces: [],
      needsBootstrap: false,
      historicalProgressPercent: 33,
      coreUsable: true,
    } as never);
    vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("ready");
    vi.mocked(warehouse.getGoogleAdsQueueHealth).mockResolvedValueOnce({
      queueDepth: 1409,
      leasedPartitions: 0,
      coreQueueDepth: 400,
      coreLeasedPartitions: 0,
      extendedQueueDepth: 1009,
      extendedLeasedPartitions: 0,
      extendedRecentQueueDepth: 0,
      extendedRecentLeasedPartitions: 0,
      extendedHistoricalQueueDepth: 1009,
      extendedHistoricalLeasedPartitions: 0,
      maintenanceQueueDepth: 0,
      maintenanceLeasedPartitions: 0,
      deadLetterPartitions: 0,
      oldestQueuedPartition: "2025-02-16",
      latestCoreActivityAt: "2026-04-21T11:58:00.000Z",
      latestExtendedActivityAt: "2026-04-21T11:58:30.000Z",
      latestMaintenanceActivityAt: null,
    } as never);
    vi.mocked(warehouse.getGoogleAdsSyncState).mockImplementation(async ({ scope }) =>
      scope === "account_daily" || scope === "campaign_daily"
        ? ([
            {
              businessId: "biz",
              providerAccountId: "acc_1",
              scope,
              historicalTargetStart: "2025-04-01",
              historicalTargetEnd: "2026-03-30",
              effectiveTargetStart: "2025-04-01",
              effectiveTargetEnd: "2026-03-30",
              readyThroughDate: "2025-07-14",
              lastSuccessfulPartitionDate: "2025-07-14",
              latestBackgroundActivityAt: "2026-04-21T11:58:30.000Z",
              latestSuccessfulSyncAt: "2026-04-21T11:58:30.000Z",
              completedDays: 120,
              deadLetterCount: 0,
              updatedAt: "2026-04-21T11:58:30.000Z",
            },
          ] as never)
        : ([] as never)
    );
    vi.mocked(googleAdsSync.getGoogleAdsWorkerSchedulingState).mockResolvedValueOnce({
      healthy: true,
      heartbeatAgeMs: 1_000,
      hasFreshHeartbeat: true,
      runnerLeaseActive: true,
      lastHeartbeatAt: "2026-04-21T11:59:59.000Z",
      latestLeaseUpdatedAt: "2026-04-21T11:59:59.000Z",
      ownerWorkerId: "worker-1",
      workerFreshnessState: "online",
      currentBusinessId: "biz",
      lastConsumedBusinessId: "biz",
      consumeStage: "idle",
      batchBusinessIds: ["biz"],
      workerMeta: null,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.releaseReadinessCandidate).toMatchObject({
      pass: true,
      blockerClass: "none",
      evidence: {
        truthReady: true,
        queueDepth: 1409,
        leasedPartitions: 0,
      },
    });
    expect(payload.backgroundBackfill).toMatchObject({
      incomplete: true,
      state: "active",
    });
    vi.useRealTimers();
  });

  it("surfaces advisor action-contract posture and retention runtime truth when available", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
    vi.mocked(advisorSnapshots.getLatestGoogleAdsAdvisorSnapshot).mockResolvedValue({
      asOfDate: "2026-04-10",
      generatedAt: new Date().toISOString(),
      advisorPayload: {
        metadata: {
          actionContract: {
            version: "google_ads_advisor_action_v2",
            source: "native",
          },
          aggregateIntelligence: {
            topQueryWeeklyAvailable: true,
            clusterDailyAvailable: true,
            queryWeeklyRows: 12,
            clusterDailyRows: 48,
            supportWindowStart: "2026-01-15",
            supportWindowEnd: "2026-04-10",
            note: "Persisted weekly top-query and daily cluster aggregates are loaded as supplemental support.",
          },
          aiAssist: {
            enabled: true,
            mode: "snapshot_time",
            scope: "unmapped_only",
            appliedCount: 1,
            rejectedCount: 0,
            failedCount: 0,
            skippedCount: 3,
            eligibleCount: 1,
            promptVersion: "google_ads_ai_structured_assist_v1",
            businessScoped: true,
          },
        },
      },
    } as never);
    vi.mocked(warehouseRetention.getGoogleAdsRetentionRuntimeStatus).mockReturnValue({
      runtimeAvailable: true,
      executionEnabled: false,
      mode: "dry_run",
      gateReason: "Retention execution is disabled.",
    });
    vi.mocked(warehouseRetention.getLatestGoogleAdsRetentionRun).mockResolvedValue({
      id: "retention_run_1",
      executionMode: "dry_run",
      finishedAt: "2026-04-10T00:00:00.000Z",
      totalDeletedRows: 0,
      skippedDueToActiveLease: false,
      errorMessage: null,
      summaryJson: {
        rows: [
          {
            tier: "raw_search_terms_hot",
            label: "Raw search terms daily hot",
            tableName: "google_ads_search_query_hot_daily",
            retentionDays: 120,
            cutoffDate: "2025-12-12",
            executionEnabled: false,
            grain: "daily",
            storageTemperature: "hot",
            dateColumn: "date",
            mode: "dry_run",
            observed: true,
            eligibleRows: 12,
            oldestEligibleValue: "2025-01-01",
            newestEligibleValue: "2025-12-11",
            retainedRows: 44,
            latestRetainedValue: "2026-04-10",
            deletedRows: 0,
          },
          {
            tier: "raw_search_terms_hot",
            label: "Raw search terms daily hot",
            tableName: "google_ads_search_term_daily",
            retentionDays: 120,
            cutoffDate: "2025-12-12",
            executionEnabled: false,
            grain: "daily",
            storageTemperature: "hot",
            dateColumn: "date",
            mode: "dry_run",
            observed: true,
            eligibleRows: 20,
            oldestEligibleValue: "2025-01-01",
            newestEligibleValue: "2025-12-11",
            retainedRows: 30,
            latestRetainedValue: "2026-04-10",
            deletedRows: 0,
          },
        ],
      },
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.advisor.actionContract).toMatchObject({
      version: "google_ads_advisor_action_v2",
      source: "native",
    });
    expect(payload.advisor.aggregateIntelligence).toMatchObject({
      topQueryWeeklyAvailable: true,
      clusterDailyAvailable: true,
      queryWeeklyRows: 12,
      clusterDailyRows: 48,
    });
    expect(payload.advisor.aiAssist).toMatchObject({
      gateEnabled: false,
      businessScoped: false,
      businessAllowed: false,
      appliedCount: 1,
      skippedCount: 3,
      eligibleCount: 1,
      promptVersion: "google_ads_ai_structured_assist_v1",
    });
    expect(payload.operations).toMatchObject({
      currentMode: "global_backfill",
      globalExtendedExecutionEnabled: true,
      advisorActionContractVersion: "google_ads_advisor_action_v2",
      advisorActionContractSource: "native",
      advisorAggregateTopQueryWeeklyAvailable: true,
      advisorAggregateClusterDailyAvailable: true,
      advisorAggregateQueryWeeklyRows: 12,
      advisorAggregateClusterDailyRows: 48,
      retentionRuntimeAvailable: true,
      retentionExecutionEnabled: false,
      retentionMode: "dry_run",
      retentionDefaultExecutionDisabled: true,
      retentionVerificationCommand:
        "npm run google:ads:retention-canary -- biz",
      retentionLatestRunObserved: true,
      lastRetentionRunAt: "2026-04-10T00:00:00.000Z",
      lastRetentionRunMode: "dry_run",
      lastRetentionRunDeletedRows: 0,
    });
    expect(payload.retention).toMatchObject({
      runtimeAvailable: true,
      executionEnabled: false,
      defaultExecutionDisabled: true,
      mode: "dry_run",
      latestRun: {
        id: "retention_run_1",
        finishedAt: "2026-04-10T00:00:00.000Z",
        executionMode: "dry_run",
        totalDeletedRows: 0,
      },
      verification: {
        available: true,
        command: "npm run google:ads:retention-canary -- biz",
      },
      rawHotTables: [
        expect.objectContaining({
          tableName: "google_ads_search_query_hot_daily",
          observed: true,
          eligibleRows: 12,
          retainedRows: 44,
        }),
        expect.objectContaining({
          tableName: "google_ads_search_term_daily",
          observed: true,
          eligibleRows: 20,
          retainedRows: 30,
        }),
      ],
    });
  });

  it("reports warehouse readiness even when Google is disconnected", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe("not_connected");
    expect(payload.syncTruthState).toBe("waiting");
    expect(payload.blockerClass).toBe("none");
    expect(payload.releaseReadinessCandidate).toBeNull();
    expect(payload.credentialState).toBe("not_connected");
    expect(payload.assignmentState).toBe("assigned");
    expect(payload.warehouseState).toBe("ready");
    expect(payload.operatorTruth).toMatchObject({
      execution: {
        sync: { state: "globally_enabled" },
      },
    });
    expect(payload.completionBasis).toEqual(
      expect.objectContaining({
        requiredScopes: ["account_daily", "campaign_daily"],
        percent: 100,
        complete: true,
      })
    );
  });

  it("returns selected-range readiness for all visible Google Ads extended surfaces", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
        "http://localhost/api/google-ads/status?businessId=biz&startDate=2026-03-01&endDate=2026-03-30"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.panel.surfaceStates.map((entry: { scope: string }) => entry.scope)).toEqual([
      "search_term_daily",
      "product_daily",
      "asset_daily",
      "asset_group_daily",
      "geo_daily",
      "device_daily",
      "audience_daily",
    ]);
    expect(payload.rangeCompletionBySurface).toMatchObject({
      search_term_daily: { selectedRange: expect.any(Object), historical: expect.any(Object) },
      product_daily: { selectedRange: expect.any(Object), historical: expect.any(Object) },
      asset_daily: { selectedRange: expect.any(Object), historical: expect.any(Object) },
      asset_group_daily: { selectedRange: expect.any(Object), historical: expect.any(Object) },
      geo_daily: { selectedRange: expect.any(Object), historical: expect.any(Object) },
      device_daily: { selectedRange: expect.any(Object), historical: expect.any(Object) },
      audience_daily: { selectedRange: expect.any(Object), historical: expect.any(Object) },
    });
    expect(payload.domains).toHaveProperty("core");
    expect(payload.domains).toHaveProperty("selectedRange");
    expect(payload.domains).toHaveProperty("advisor");
    expect(payload.domains.advisor.detail).toBe("Multi-window analysis coverage is ready.");
    expect(payload.advisor.blockingMessage).toContain("Decision snapshot");
  });

  it("uses additive search-intelligence coverage instead of raw search_term_daily warehouse coverage", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
        "http://localhost/api/google-ads/status?businessId=biz&startDate=2026-03-01&endDate=2026-03-30"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(searchIntelligenceStorage.readGoogleAdsSearchIntelligenceCoverage).toHaveBeenCalled();
    expect(
      vi
        .mocked(warehouse.getGoogleAdsDailyCoverage)
        .mock.calls.some(([input]) => input.scope === "search_term_daily")
    ).toBe(false);
    expect(payload.rangeCompletionBySurface.search_term_daily).toMatchObject({
      selectedRange: expect.any(Object),
      historical: expect.any(Object),
    });
    expect(warehouse.getGoogleAdsAdvisorSurfacePartitionStates).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: "acc_1",
      }),
    );
    expect(payload.operations.advisorSurfacePartitionStates).toEqual([]);
  });

  it("surfaces quota-limited rebuild truth without overstating readiness", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
    vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("partial");
    vi.mocked(requestGovernance.getProviderQuotaBudgetState).mockResolvedValue({
      provider: "google",
      businessId: "biz",
      quotaDate: "2026-04-13",
      callCount: 4900,
      errorCount: 12,
      dailyBudget: 5000,
      maintenanceBudget: 4250,
      extendedBudget: 3000,
      pressure: 0.98,
      withinDailyBudget: true,
      maintenanceAllowed: false,
      extendedAllowed: false,
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.operatorTruth).toMatchObject({
      rebuild: {
        state: "quota_limited",
        quotaLimited: true,
      },
    });
    expect(payload.readinessLevel).not.toBe("ready");
  });

  it("does not self-heal a missing exact google repair plan from the status route", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue({
      id: "int_google",
      business_id: "biz",
      provider: "google",
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
    vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("ready");
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: {
        id: "dg-1",
        gateKind: "deploy_gate",
        buildId: "runtime-build",
        environment: "production",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "deploy ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-10T00:00:00.000Z",
      },
      releaseGate: {
        id: "rg-1",
        gateKind: "release_gate",
        buildId: "runtime-build",
        environment: "production",
        mode: "measure_only",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "release ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-10T00:00:00.000Z",
      },
    } as never);
    vi.mocked(repairPlanner.getLatestSyncRepairPlan).mockResolvedValue(null);
    vi.mocked(controlPlanePersistence.getSyncControlPlanePersistenceStatus)
      .mockResolvedValueOnce({
        identity: {
          buildId: "runtime-build",
          environment: "production",
          providerScope: "google_ads",
        },
        exact: {
          deployGate: {
            id: "dg-1",
            buildId: "runtime-build",
            environment: "production",
            gateKind: "deploy_gate",
            verdict: "pass",
            emittedAt: "2026-04-10T00:00:00.000Z",
          },
          releaseGate: {
            id: "rg-1",
            buildId: "runtime-build",
            environment: "production",
            gateKind: "release_gate",
            verdict: "pass",
            emittedAt: "2026-04-10T00:00:00.000Z",
          },
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
        missingExact: ["repairPlan"],
        exactRowsPresent: false,
      } as never)
      .mockResolvedValueOnce({
        identity: {
          buildId: "runtime-build",
          environment: "production",
          providerScope: "google_ads",
        },
        exact: {
          deployGate: {
            id: "dg-1",
            buildId: "runtime-build",
            environment: "production",
            gateKind: "deploy_gate",
            verdict: "pass",
            emittedAt: "2026-04-10T00:00:00.000Z",
          },
          releaseGate: {
            id: "rg-1",
            buildId: "runtime-build",
            environment: "production",
            gateKind: "release_gate",
            verdict: "pass",
            emittedAt: "2026-04-10T00:00:00.000Z",
          },
          repairPlan: {
            id: "rp-healed",
            buildId: "runtime-build",
            environment: "production",
            providerScope: "google_ads",
            eligible: true,
            emittedAt: "2026-04-10T00:00:00.000Z",
          },
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
      } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(releaseGates.getLatestSyncGateRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: "dev-build",
        environment: "test",
        providerScope: "google_ads",
      }),
    );
    expect(repairPlanner.evaluateAndPersistSyncRepairPlan).not.toHaveBeenCalled();
    expect(payload.repairPlan).toBeNull();
    expect(payload.controlPlanePersistence).toMatchObject({
      exactRowsPresent: false,
      missingExact: ["repairPlan"],
    });
    expect(payload.controlPlaneErrors).toEqual({
      syncGates: null,
      repairPlan: null,
      controlPlanePersistence: null,
      syncIncidents: null,
    });
  });

  it("surfaces control-plane read errors without failing the route", async () => {
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockRejectedValue(
      new Error("gate read failed")
    );
    vi.mocked(controlPlanePersistence.getSyncControlPlanePersistenceStatus).mockRejectedValue(
      new Error("persistence read failed")
    );

    const response = await GET(
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.deployGate).toBeNull();
    expect(payload.releaseGate).toBeNull();
    expect(payload.controlPlaneErrors).toEqual({
      syncGates: "gate read failed",
      repairPlan: null,
      controlPlanePersistence: null,
      syncIncidents: null,
    });
  });
});
