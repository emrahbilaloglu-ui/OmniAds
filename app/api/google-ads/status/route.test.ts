import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/google-ads/status/route";
import {
  resolveGoogleAdsCompletion,
  unknownGoogleAdsCompletion,
} from "@/lib/google-ads/completion-semantics";
import type { GoogleAdsFreshnessSnapshot } from "@/lib/google-ads/freshness-read";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  getDbWithTimeout: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
  assertDbSchemaReady: vi.fn(),
}));

/**
 * Only the READ is doubled. `toGoogleAdsFreshnessSummary` stays real, so the
 * wire shape the route publishes is the one the contract produces — a route
 * that quietly rebuilt the summary from coverage counts could not satisfy it.
 */
vi.mock("@/lib/google-ads/control-plane-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/google-ads/control-plane-runtime")
  >("@/lib/google-ads/control-plane-runtime");
  // Only the DB-backed reader is stubbed. The truth resolver, the adapter and
  // the completion ranking stay real, so these tests exercise the actual gate
  // wiring rather than a re-implementation of it.
  return { ...actual, readGoogleAdsCoreFreshnessEvidence: vi.fn() };
});
vi.mock("@/lib/google-ads/freshness-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google-ads/freshness-read")>();
  return {
    ...actual,
    readGoogleAdsFreshness: vi.fn(),
  };
});

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

/**
 * Real by default. Core readiness is where the freshness verdicts the route
 * passes in become `historicalCompletion`; stubbing it would let the route
 * satisfy these tests without ever reading the snapshot.
 */
vi.mock("@/lib/google-ads/core-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google-ads/core-readiness")>();
  return {
    ...actual,
    buildGoogleAdsCoreReadiness: vi.fn(actual.buildGoogleAdsCoreReadiness),
  };
});

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
    freshnessBlocked: false,
    recentCompletionState: "converging" as const,
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

const FRESHNESS_SCOPES = [
  "account_daily",
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_group_daily",
  "asset_daily",
  "geo_daily",
  "device_daily",
  "audience_daily",
] as const;

/**
 * A freshness snapshot built the way the real reader builds one: the verdict
 * comes from `resolveGoogleAdsCompletion` over the day counts, never from a
 * hand-written state. A fixture that hard-coded `state: "settled"` would let a
 * broken route pass by echoing it back.
 *
 * The window is deliberately wide so that the advisor and D+1 sub-windows the
 * route checks fall inside whatever "today" the test is running on.
 */
function buildFreshnessSnapshot(input: {
  totalDays?: number;
  coveredDays?: number;
  postCloseObservedDays?: number;
  lookbackExhaustedDays?: number;
  includesOpenDay?: boolean;
  dueNowDays?: number;
  startDate?: string;
  endDate?: string;
}): GoogleAdsFreshnessSnapshot {
  const totalDays = input.totalDays ?? 365;
  const coveredDays = input.coveredDays ?? totalDays;
  const postCloseObservedDays = input.postCloseObservedDays ?? 0;
  const lookbackExhaustedDays = input.lookbackExhaustedDays ?? 0;
  const includesOpenDay = input.includesOpenDay ?? false;
  const verdict = resolveGoogleAdsCompletion({
    totalDays,
    coveredDays,
    postCloseObservedDays,
    lookbackExhaustedDays,
    includesOpenDay,
  });
  return {
    businessId: "biz",
    startDate: input.startDate ?? "2000-01-01",
    endDate: input.endDate ?? "2099-12-31",
    totalDays,
    providerAccountIds: ["acc_1"],
    timeZoneSource: "account",
    includesOpenDay,
    evidenceAvailable: true,
    unavailableReason: null,
    scopes: Object.fromEntries(
      FRESHNESS_SCOPES.map((scope) => [
        scope,
        {
          scope,
          coveredDays,
          postCloseObservedDays,
          lookbackExhaustedDays,
          dueNowDays: input.dueNowDays ?? Math.max(0, totalDays - postCloseObservedDays),
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict,
        },
      ]),
    ),
    overall: verdict,
  };
}

/** What the reader returns when it could not look: every verdict `unknown`. */
function buildUnavailableFreshnessSnapshot(reason: string): GoogleAdsFreshnessSnapshot {
  const verdict = unknownGoogleAdsCompletion(reason);
  return {
    businessId: "biz",
    startDate: "2000-01-01",
    endDate: "2099-12-31",
    totalDays: 365,
    providerAccountIds: [],
    timeZoneSource: "default",
    includesOpenDay: true,
    evidenceAvailable: false,
    unavailableReason: reason,
    scopes: Object.fromEntries(
      FRESHNESS_SCOPES.map((scope) => [
        scope,
        {
          scope,
          coveredDays: 0,
          postCloseObservedDays: 0,
          lookbackExhaustedDays: 0,
          dueNowDays: 0,
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict,
        },
      ]),
    ),
    overall: verdict,
  };
}

/** Every day re-read after it closed, all of it still inside the lookback. */
const convergingFreshnessSnapshot = () =>
  buildFreshnessSnapshot({ postCloseObservedDays: 365, lookbackExhaustedDays: 0 });

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
const freshnessRead = await import("@/lib/google-ads/freshness-read");
const controlPlaneRuntime = await import("@/lib/google-ads/control-plane-runtime");
type GoogleAdsFreshnessEvidence = Awaited<
  ReturnType<typeof controlPlaneRuntime.readGoogleAdsCoreFreshnessEvidence>
>;

describe("GET /api/google-ads/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
      convergingFreshnessSnapshot(),
    );
    // The release gate measures a RECENT closed-day window, not the historical
    // backfill range above. Keeping them separate is deliberate: a workspace
    // mid-backfill must still be able to ship, and a stale recent window must
    // still block, independently of each other.
    vi.mocked(
      controlPlaneRuntime.readGoogleAdsCoreFreshnessEvidence,
    ).mockResolvedValue(
      controlPlaneRuntime.toGoogleAdsCoreFreshnessEvidence(
        convergingFreshnessSnapshot(),
      ),
    );
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
    // A workspace this test calls release-ready must actually have core sync
    // state saying so. The default fixture returns no rows at all, which the
    // route previously papered over with a coverage-derived OR leg that has now
    // been removed — so the fixture has to describe the workspace it claims.
    vi.mocked(warehouse.getGoogleAdsSyncState).mockImplementation(async ({ scope }) =>
      scope === "account_daily" || scope === "campaign_daily"
        ? ([
            {
              businessId: "biz",
              providerAccountId: "acc_1",
              scope,
              completedDays: 365,
              deadLetterCount: 0,
              latestSuccessfulSyncAt: new Date().toISOString(),
            },
          ] as never)
        : ([] as never),
    );
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
      freshnessBlocked: false,
      recentCompletionState: "converging",
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

  it("feeds the release gate real freshness evidence for the recent window", async () => {
    // Scoped deliberately to WIRING, because that is what was missing: the
    // route computed a release-readiness candidate without ever supplying
    // freshness, so the gate read `unknown` and failed closed on every request.
    //
    // It does not re-assert the gate's own verdict logic. An earlier version of
    // this test asserted `pass: false` directly and was vacuous — it passed
    // with all three freshness guards disabled, because this fixture has other
    // reasons a candidate can fail. Those verdicts are proven where they are
    // decided, in control-plane-runtime / control-plane / release-gates tests.
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
      new NextRequest("http://localhost/api/google-ads/status?businessId=biz"),
    );
    expect(response.status).toBe(200);

    expect(
      controlPlaneRuntime.readGoogleAdsCoreFreshnessEvidence,
    ).toHaveBeenCalledWith(expect.objectContaining({ businessId: "biz" }));
    // Once per request, not once per scope: the gate window is a single
    // bounded read shared by the truth resolver and the readiness candidate.
    expect(
      vi.mocked(controlPlaneRuntime.readGoogleAdsCoreFreshnessEvidence).mock.calls,
    ).toHaveLength(1);
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
    vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
      buildFreshnessSnapshot({
        totalDays: 90,
        coveredDays: 10,
        postCloseObservedDays: 10,
        dueNowDays: 80,
      }),
    );
    vi.mocked(coreReadiness.buildGoogleAdsCoreReadiness).mockReturnValueOnce({
      effectiveHistoricalTotalDays: 90,
      overallCompletedDays: 10,
      overallAccountCompletedDays: 10,
      overallCoveredDays: 10,
      overallAccountCoveredDays: 10,
      historicalReadyThroughDate: "2026-01-14",
      productPendingSurfaces: [],
      needsBootstrap: false,
      historicalProgressPercent: 11,
      coreUsable: true,
      historicalCompletion: resolveGoogleAdsCompletion({
        totalDays: 90,
        coveredDays: 10,
        postCloseObservedDays: 10,
        lookbackExhaustedDays: 0,
        includesOpenDay: false,
      }),
      historicalCompletionState: "missing",
      historicalComplete: false,
      historicalMayStopPolling: false,
      evidenceAvailable: true,
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
    // The status machine is mocked to "ready" here, which 10 of 90 observed
    // days never justified. The route now refuses that green state, so the
    // derived truth reports a stalled provider instead of a quiet refresh.
    expect(payload.state).toBe("syncing");
    expect(payload.userVisibleSyncState).toMatchObject({
      kind: "using_latest_available_data",
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
    vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
      buildFreshnessSnapshot({
        totalDays: 365,
        coveredDays: 120,
        postCloseObservedDays: 120,
        dueNowDays: 245,
      }),
    );
    vi.mocked(coreReadiness.buildGoogleAdsCoreReadiness).mockReturnValueOnce({
      effectiveHistoricalTotalDays: 365,
      overallCompletedDays: 120,
      overallAccountCompletedDays: 120,
      overallCoveredDays: 120,
      overallAccountCoveredDays: 120,
      historicalReadyThroughDate: "2025-07-14",
      productPendingSurfaces: [],
      needsBootstrap: false,
      historicalProgressPercent: 33,
      coreUsable: true,
      historicalCompletion: resolveGoogleAdsCompletion({
        totalDays: 365,
        coveredDays: 120,
        postCloseObservedDays: 120,
        lookbackExhaustedDays: 0,
        includesOpenDay: false,
      }),
      historicalCompletionState: "missing",
      historicalComplete: false,
      historicalMayStopPolling: false,
      evidenceAvailable: true,
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
    // Every day of the window has a row AND has been re-read since it closed,
    // but the conversion lookback has not elapsed: 99 and not complete, not the
    // 100/true that coverage arithmetic used to produce here.
    expect(payload.completionBasis).toEqual(
      expect.objectContaining({
        requiredScopes: ["account_daily", "campaign_daily"],
        percent: 99,
        complete: false,
        state: "converging",
        evidenceAvailable: true,
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

  describe("freshness-derived completion", () => {
    const connectGoogle = () => {
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
    };

    const collectStrings = (value: unknown, found: string[] = []): string[] => {
      if (typeof value === "string") found.push(value);
      else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, found));
      else if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach((entry) =>
          collectStrings(entry, found),
        );
      }
      return found;
    };

    const statusRequest = () =>
      new NextRequest(
        "http://localhost/api/google-ads/status?businessId=biz&startDate=2026-03-01&endDate=2026-03-30",
      );

    it("refuses ready, 100% and complete for a fully covered range that was never re-read after closing", async () => {
      connectGoogle();
      // Coverage is deliberately left at the fully-covered default
      // (`getGoogleAdsDailyCoverage` -> 365 of 365 days, `total_rows: 10`), which
      // is exactly the shape that used to render green. The only thing missing
      // is post-close observation.
      vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
        buildFreshnessSnapshot({
          totalDays: 30,
          coveredDays: 30,
          postCloseObservedDays: 0,
          dueNowDays: 30,
        }),
      );
      vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("ready");

      const response = await GET(statusRequest());
      const payload = await response.json();

      expect(response.status).toBe(200);

      // NEGATIVE CONTROL. These two assertions describe the same request: the
      // warehouse says every day of the range has data, and completion says
      // zero. Any field that fell back to coverage would have to report ~100
      // here, so re-deriving `percent` from `completedDays / totalDays` fails
      // this test rather than passing it quietly.
      expect(payload.warehouse.coverage.selectedRange.completedDays).toBeGreaterThanOrEqual(
        payload.warehouse.coverage.selectedRange.totalDays,
      );
      expect(payload.completionBasis).toMatchObject({
        percent: 0,
        complete: false,
        state: "provisional",
        evidenceAvailable: true,
      });
      expect(payload.freshness).toMatchObject({
        state: "provisional",
        label: "Provisional",
        percent: 0,
        complete: false,
        mayStopPolling: false,
      });

      // Nothing anywhere on the response may read green off those rows.
      expect(payload.state).not.toBe("ready");
      expect(payload.readinessLevel).not.toBe("ready");
      expect(payload.requiredScopeCompletion.complete).toBe(false);
      expect(payload.requiredScopeCompletion.percent).toBe(0);
      expect(payload.warehouse.coverage.selectedRange.isComplete).toBe(false);
      expect(payload.d1FinalizeState).not.toBe("ready");
      expect(payload.operatorTruth.rebuild.state).not.toBe("ready");
      expect(payload.backgroundBackfill.state).not.toBe("ready");
      expect(payload.domains.selectedRange.state).not.toBe("ready");
      expect(payload.historicalExtendedReady).toBe(false);
      expect(payload.recentExtendedReady).toBe(false);
      expect(
        Object.values(
          payload.rangeCompletionBySurface as Record<
            string,
            { selectedRange: { ready: boolean }; historical: { ready: boolean } }
          >,
        ).every((surface) => !surface.selectedRange.ready && !surface.historical.ready),
      ).toBe(true);
      expect(
        (payload.panel.surfaceStates as Array<{ state: string }>).every(
          (surface) => surface.state !== "ready",
        ),
      ).toBe(true);
      expect(payload.completionBlockers).toContain("awaiting_post_close_observation");
    });

    it("reports converging and refuses complete inside the conversion lookback", async () => {
      connectGoogle();
      vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
        buildFreshnessSnapshot({
          totalDays: 30,
          coveredDays: 30,
          postCloseObservedDays: 30,
          lookbackExhaustedDays: 0,
          dueNowDays: 0,
        }),
      );

      const response = await GET(statusRequest());
      const payload = await response.json();

      expect(payload.freshness).toMatchObject({
        state: "converging",
        label: "Refreshing",
        // Deliberately capped below 100: every day was re-read, conversions can
        // still land inside the window.
        percent: 99,
        complete: false,
        mayStopPolling: false,
      });
      expect(payload.completionBasis).toMatchObject({
        percent: 99,
        complete: false,
        state: "converging",
      });
      expect(payload.requiredScopeCompletion.complete).toBe(false);
      expect(payload.completionBlockers).toContain("within_conversion_lookback");
      expect(payload.freshness.conversionLookbackDays).toBeGreaterThan(0);
    });

    it("reports settled and 100 only when the lookback has elapsed for every day", async () => {
      connectGoogle();
      vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
        buildFreshnessSnapshot({
          totalDays: 30,
          coveredDays: 30,
          postCloseObservedDays: 30,
          lookbackExhaustedDays: 30,
          dueNowDays: 0,
        }),
      );

      const response = await GET(statusRequest());
      const payload = await response.json();

      expect(payload.freshness).toMatchObject({
        state: "settled",
        // Never "Final", never "Complete": settled against OUR configured
        // lookback, which the summary publishes alongside it.
        label: "Policy-settled",
        percent: 100,
        complete: true,
        mayStopPolling: true,
      });
      expect(payload.completionBasis).toMatchObject({
        percent: 100,
        complete: true,
        state: "settled",
      });
      expect(payload.requiredScopeCompletion).toMatchObject({
        percent: 100,
        complete: true,
      });
      expect(payload.completionBlockers).not.toContain("awaiting_post_close_observation");
      expect(payload.completionBlockers).not.toContain("within_conversion_lookback");
    });

    it("fails closed and stays retryable when the freshness evidence cannot be read", async () => {
      connectGoogle();
      vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
        buildUnavailableFreshnessSnapshot(
          "Google Ads freshness tables are not ready yet.",
        ),
      );
      // The state machine is doubled into claiming green; the route must not
      // pass that through when it could not read the evidence.
      vi.mocked(statusMachine.decideGoogleAdsStatusState).mockReturnValue("ready");

      const response = await GET(statusRequest());
      const payload = await response.json();

      // Retryable, not terminal: a 200 with a non-green state.
      expect(response.status).toBe(200);
      expect(payload.state).toBe("syncing");
      expect(payload.readinessLevel).not.toBe("ready");
      expect(payload.freshness).toMatchObject({
        evidenceAvailable: false,
        state: "unknown",
        label: "Unknown",
        percent: 0,
        complete: false,
        // The client MUST keep polling: unknown means we could not look, not
        // that there is nothing to find.
        mayStopPolling: false,
      });
      expect(payload.completionBasis).toMatchObject({
        percent: 0,
        complete: false,
        state: "unknown",
        evidenceAvailable: false,
      });
      expect(payload.completionBlockers).toContain("freshness_evidence_unavailable");
      expect(payload.d1FinalizeState).not.toBe("ready");
      expect(payload.operatorTruth.rebuild.state).not.toBe("ready");
      expect(payload.backgroundBackfill.state).not.toBe("ready");
      // Not presented as a failure either.
      expect(payload.state).not.toBe("action_required");
      expect(payload.userVisibleSyncState.kind).not.toBe("healthy");
    });

    it("reads freshness once per request for every scope, never once per scope", async () => {
      connectGoogle();

      await GET(statusRequest());

      // The N+1 guard. The response reports on nine scopes; one call must carry
      // all of them.
      expect(freshnessRead.readGoogleAdsFreshness).toHaveBeenCalledTimes(1);
      const [call] = vi.mocked(freshnessRead.readGoogleAdsFreshness).mock.calls;
      expect(call[0].scopes).toEqual([...FRESHNESS_SCOPES]);
      expect(call[0].businessId).toBe("biz");
      expect(call[0].providerAccountIds).toEqual(["acc_1"]);
      // Measured through the last CLOSED day, never the open one.
      expect(call[0].endDate).toBe(call[0].endDate?.slice(0, 10));
      expect(String(call[0].startDate) <= String(call[0].endDate)).toBe(true);
    });

    it("scopes sync health, checkpoints, coverage and freshness to the requested assigned account", async () => {
      connectGoogle();
      vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
        id: "asg_google",
        business_id: "biz",
        provider: "google",
        account_ids: ["acc_1", "acc_2"],
        created_at: "",
        updated_at: "",
      });
      vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
        accounts: [
          { id: "acc_1", name: "Main", timezone: "UTC" },
          { id: "acc_2", name: "Secondary", timezone: "Europe/Berlin" },
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
        new NextRequest(
          "http://localhost/api/google-ads/status?businessId=biz&accountId=acc_2&startDate=2026-03-01&endDate=2026-03-30",
        ),
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.assignedAccountIds).toEqual(["acc_2"]);
      expect(warehouse.getLatestGoogleAdsSyncHealth).toHaveBeenCalledWith({
        businessId: "biz",
        providerAccountId: "acc_2",
      });
      expect(warehouse.getGoogleAdsCheckpointHealth).toHaveBeenCalledWith({
        businessId: "biz",
        providerAccountId: "acc_2",
      });
      expect(
        vi.mocked(warehouse.getGoogleAdsDailyCoverage).mock.calls.every(
          ([input]) => input.providerAccountId === "acc_2",
        ),
      ).toBe(true);
      expect(freshnessRead.readGoogleAdsFreshness).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: "biz",
          providerAccountIds: ["acc_2"],
        }),
      );
    });

    it("refuses an unassigned status account before any warehouse status read", async () => {
      connectGoogle();

      const response = await GET(
        new NextRequest(
          "http://localhost/api/google-ads/status?businessId=biz&accountId=foreign_account",
        ),
      );
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.code).toBe("google_account_not_selected");
      expect(warehouse.getLatestGoogleAdsSyncHealth).not.toHaveBeenCalled();
      expect(freshnessRead.readGoogleAdsFreshness).not.toHaveBeenCalled();
    });

    it("never tells a user a Google Ads date is final or immutable", async () => {
      connectGoogle();
      vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
        buildFreshnessSnapshot({
          totalDays: 30,
          coveredDays: 30,
          postCloseObservedDays: 30,
          lookbackExhaustedDays: 30,
          dueNowDays: 0,
        }),
      );

      const response = await GET(statusRequest());
      const payload = await response.json();

      const forbidden = /\b(final|finalized|immutable|frozen)\b|will not change|won't change/i;
      const offenders = collectStrings(payload).filter((value) => forbidden.test(value));
      expect(offenders).toEqual([]);
      // The strongest word we are allowed to use, on the strongest verdict.
      expect(payload.freshness.label).toBe("Policy-settled");
    });
  });

  it("surfaces control-plane read errors without failing the route", async () => {
    // Reset rather than re-stub: an unconsumed `mockResolvedValueOnce` from an
    // earlier test would otherwise satisfy this call and hide the rejection.
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockReset();
    vi.mocked(controlPlanePersistence.getSyncControlPlanePersistenceStatus).mockReset();
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
      controlPlanePersistence: "persistence read failed",
      syncIncidents: null,
    });
  });
});
