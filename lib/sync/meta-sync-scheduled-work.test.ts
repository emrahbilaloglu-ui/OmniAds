import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: vi.fn(),
  publishMetaBreakdownAuthoritativeSurface: vi.fn(),
  syncMetaAccountBreakdownWarehouseDay: vi.fn(),
  syncMetaAccountCoreWarehouseDay: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-warehouse", () => ({
  syncMetaCreativesWarehouseDay: vi.fn(),
}));

vi.mock("@/lib/meta/core-config", () => ({
  META_PRODUCT_CORE_PARTITION_SCOPE: "account_daily",
  META_CORE_PARTITION_SCOPES: ["account_daily", "campaign_daily", "adset_daily", "ad_daily"],
  META_EXTENDED_SCOPES: ["creative_daily", "ad_daily"],
  META_PRODUCT_CORE_COVERAGE_SCOPES: ["account_daily", "campaign_daily", "adset_daily", "ad_daily"],
  META_RUNTIME_STATE_SCOPES: ["account_daily", "campaign_daily", "adset_daily", "creative_daily", "ad_daily"],
  isMetaProductCoreCoverageScope: vi.fn(() => true),
}));

vi.mock("@/lib/meta/history", () => ({
  META_WAREHOUSE_HISTORY_DAYS: 365,
  META_CREATIVE_WAREHOUSE_HISTORY_DAYS: 455,
  dayCountInclusive: vi.fn((start: string, end: string) => {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    return Math.floor((endMs - startMs) / 86_400_000) + 1;
  }),
  getCreativeMediaRetentionStart: vi.fn(() => "2026-01-01"),
}));

vi.mock("@/lib/sync/provider-status-truth", () => ({
  buildProviderProgressEvidence: vi.fn(),
  deriveProviderStallFingerprints: vi.fn(() => []),
  hasRecentProviderAdvancement: vi.fn(() => false),
}));

vi.mock("@/lib/sync/provider-day-rollover", () => ({
  syncProviderDayRolloverState: vi.fn(() => Promise.resolve([])),
  markProviderDayRolloverFinalizeCompleted: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  backfillMetaRunningRunsForTerminalPartition: vi.fn(),
  cancelObsoleteMetaCoreScopePartitions: vi.fn().mockResolvedValue([]),
  cleanupMetaPartitionOrchestration: vi.fn(),
  completeMetaPartitionAttempt: vi.fn(),
  createMetaSyncJob: vi.fn(),
  createMetaSyncRun: vi.fn(),
  expireStaleMetaSyncJobs: vi.fn(),
  getMetaPartitionCompletionDenialSnapshot: vi.fn(),
  getLatestRunningMetaSyncRunIdForPartition: vi.fn(),
  getLatestMetaCheckpointForPartition: vi.fn(),
  heartbeatMetaPartitionLease: vi.fn(),
  getLatestMetaSyncHealth: vi.fn(),
  getMetaAdDailyCoverage: vi.fn().mockResolvedValue({ completed_days: 0, ready_through_date: null, latest_updated_at: null }),
  getMetaAdSetDailyCoverage: vi.fn().mockResolvedValue({ completed_days: 0, ready_through_date: null, latest_updated_at: null }),
  getMetaAccountDailyCoverage: vi.fn().mockResolvedValue({ completed_days: 0, ready_through_date: null, latest_updated_at: null }),
  getMetaAuthoritativeDayVerification: vi.fn(),
  getMetaAuthoritativeRequiredSurfacesForDayAge: vi.fn((dayAge: number) =>
    dayAge > 394
      ? [
          { surface: "account_daily", state: "pending" },
          { surface: "campaign_daily", state: "pending" },
          { surface: "adset_daily", state: "pending" },
          { surface: "ad_daily", state: "pending" },
          { surface: "breakdown_daily", state: "not_applicable" },
        ]
      : [
          { surface: "account_daily", state: "pending" },
          { surface: "campaign_daily", state: "pending" },
          { surface: "adset_daily", state: "pending" },
          { surface: "ad_daily", state: "pending" },
          { surface: "breakdown_daily", state: "pending" },
        ],
  ),
  getMetaCampaignDailyCoverage: vi.fn().mockResolvedValue({ completed_days: 0, ready_through_date: null, latest_updated_at: null }),
  getMetaCreativeDailyCoverage: vi.fn().mockResolvedValue({ completed_days: 0, ready_through_date: null, latest_updated_at: null }),
  getMetaDirtyRecentDates: vi.fn().mockResolvedValue([]),
  getMetaIncompleteCoverageDates: vi.fn().mockResolvedValue([]),
  listMetaAuthoritativeDayStates: vi.fn().mockResolvedValue([]),
  getMetaPartitionStatesForDate: vi.fn().mockResolvedValue(new Map()),
  getMetaPublishedVerificationSummary: vi.fn().mockResolvedValue({
    verificationState: "processing",
    truthReady: false,
    totalDays: 365,
    completedCoreDays: 0,
    sourceFetchedAt: null,
    publishedAt: null,
    asOf: null,
    publishedSlices: 0,
    totalExpectedSlices: 0,
    reasonCounts: {},
    publishedKeysBySurface: {},
  }),
  getMetaRecentAuthoritativeSliceGuard: vi.fn().mockResolvedValue({
    activeAuthoritativeSource: null,
    activeAuthoritativePriority: 0,
    lastSameSourceAttemptAt: null,
    lastSameSourceSuccessAt: null,
    repeatedFailures24h: 0,
  }),
  getMetaQueueComposition: vi.fn(),
  getMetaPartitionHealth: vi.fn().mockResolvedValue({ latestActivityAt: null, deadLetterPartitions: 0 }),
  getMetaQueueHealth: vi.fn().mockResolvedValue({
    queueDepth: 0,
    leasedPartitions: 0,
    historicalCoreQueueDepth: 0,
    historicalCoreLeasedPartitions: 0,
    maintenanceQueueDepth: 0,
    maintenanceLeasedPartitions: 0,
  }),
  getMetaRawSnapshotCoverageByEndpoint: vi.fn(),
  getMetaSyncCheckpoint: vi.fn(),
  getMetaSyncState: vi.fn(),
  leaseMetaSyncPartitions: vi.fn(),
  markMetaPartitionRunning: vi.fn(),
  queueMetaSyncPartition: vi.fn(async (input) => ({ id: `${input.providerAccountId}:${input.partitionDate}:${input.scope}`, status: "queued", ...input })),
  replayMetaDeadLetterPartitions: vi.fn(),
  requeueMetaRetryableFailedPartitions: vi.fn(),
  updateMetaSyncJob: vi.fn(),
  updateMetaSyncRun: vi.fn(),
  upsertMetaAuthoritativeDayState: vi.fn(async (row) => row),
  reconcileMetaAuthoritativeDayStateFromVerification: vi.fn(),
  upsertMetaSyncState: vi.fn(),
  upsertMetaSyncCheckpoint: vi.fn(),
}));

const apiMeta = await import("@/lib/api/meta");
const warehouse = await import("@/lib/meta/warehouse");
const providerDayRollover = await import("@/lib/sync/provider-day-rollover");
const { enqueueMetaScheduledWork } = await import("@/lib/sync/meta-sync");

type QueueMetaPartitionInput = Parameters<typeof warehouse.queueMetaSyncPartition>[0];
type RecentAuthoritativeSliceGuardInput =
  Parameters<typeof warehouse.getMetaRecentAuthoritativeSliceGuard>[0];

function buildPublishedPlannerRows(providerAccountId: string, days: string[]) {
  return days.flatMap((day) =>
    ["account_daily", "campaign_daily", "adset_daily", "ad_daily", "breakdown_daily"].map(
      (surface) => ({
        businessId: "biz-1",
        providerAccountId,
        day,
        surface,
        state: "published",
        accountTimezone: "UTC",
      }),
    ),
  );
}

function buildCoreOnlyPlannerRows(providerAccountId: string, days: string[]) {
  return days.flatMap((day) =>
    ["account_daily", "campaign_daily", "adset_daily", "ad_daily"].map(
      (surface) => ({
        businessId: "biz-1",
        providerAccountId,
        day,
        surface,
        state: "published",
        accountTimezone: "UTC",
      }),
    ),
  );
}

describe("enqueueMetaScheduledWork", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: {
        act_1: { currency: "USD", timezone: "America/Anchorage", name: "Account 1" },
      },
    });
    vi.mocked(warehouse.cancelObsoleteMetaCoreScopePartitions).mockResolvedValue([]);
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      maintenanceQueueDepth: 0,
      maintenanceLeasedPartitions: 0,
    } as never);
    vi.mocked(warehouse.getMetaDirtyRecentDates).mockResolvedValue([] as never);
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaRecentAuthoritativeSliceGuard).mockResolvedValue({
      activeAuthoritativeSource: null,
      activeAuthoritativePriority: 0,
      lastSameSourceAttemptAt: null,
      lastSameSourceSuccessAt: null,
      repeatedFailures24h: 0,
    } as never);
    vi.mocked(warehouse.upsertMetaAuthoritativeDayState).mockImplementation(
      async (row) => row as never,
    );
    vi.mocked(warehouse.getMetaPartitionStatesForDate).mockResolvedValue(new Map());
    vi.mocked(warehouse.getMetaPublishedVerificationSummary).mockResolvedValue({
      verificationState: "processing",
      truthReady: false,
      totalDays: 365,
      completedCoreDays: 0,
      sourceFetchedAt: null,
      publishedAt: null,
      asOf: null,
      publishedSlices: 0,
      totalExpectedSlices: 0,
      reasonCounts: {},
      publishedKeysBySurface: {},
    } as never);
    vi.mocked(warehouse.queueMetaSyncPartition).mockImplementation(async (input: QueueMetaPartitionInput) => ({
      id: `${input.providerAccountId}:${input.partitionDate}:${input.scope}`,
      status: "queued",
    }));
    vi.mocked(providerDayRollover.syncProviderDayRolloverState).mockResolvedValue([] as never);
  });

  it("returns a structured result for scheduled Meta work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));

    const result = await enqueueMetaScheduledWork("biz-1");

    expect(result.businessId).toBe("biz-1");
    expect(result.queueDepth).toBe(0);
    expect(result.leasedPartitions).toBe(0);
    expect(result.cancelledObsoletePartitions).toBe(0);
    expect(typeof result.queuedCore).toBe("number");
    expect(typeof result.queuedMaintenance).toBe("number");
    expect(result.recentAutoHeal).toEqual(
      expect.objectContaining({
        accountsScanned: 1,
        oldestDirtyDate: null,
        reasonCounts: {},
      }),
    );
    expect(vi.mocked(warehouse.getMetaDirtyRecentDates).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        slowPathDates: ["2026-04-05"],
      }),
    );

    vi.useRealTimers();
  });

  it("queues creative_daily recent increments and 03:00 UTC gap repair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T03:10:00.000Z"));
    vi.mocked(warehouse.getMetaIncompleteCoverageDates).mockResolvedValue([
      "2025-04-07",
      "2025-04-08",
    ] as never);

    const result = await enqueueMetaScheduledWork("biz-1");

    const creativeCalls = vi
      .mocked(warehouse.queueMetaSyncPartition)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.scope === "creative_daily");

    expect(result.queuedCreative).toBeGreaterThanOrEqual(4);
    expect(creativeCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerAccountId: "act_1",
          partitionDate: "2026-04-05",
          lane: "extended",
          source: "today_observe",
        }),
        expect.objectContaining({
          providerAccountId: "act_1",
          partitionDate: "2026-04-04",
          lane: "extended",
          source: "finalize_day",
        }),
        expect.objectContaining({
          providerAccountId: "act_1",
          partitionDate: "2025-04-07",
          lane: "extended",
          source: "historical_recovery",
        }),
      ]),
    );
    expect(warehouse.getMetaIncompleteCoverageDates).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        providerAccountId: "act_1",
        scopes: ["creative_daily"],
        limit: expect.any(Number),
      }),
    );

    vi.useRealTimers();
  });

  it("uses per-account timezone D-1 for finalize_day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:30:00.000Z"));
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token",
      accountIds: ["act_1", "act_2"],
      currency: "USD",
      accountProfiles: {
        act_1: { currency: "USD", timezone: "America/Anchorage", name: "Account 1" },
        act_2: { currency: "USD", timezone: "Pacific/Kiritimati", name: "Account 2" },
      },
    });

    await enqueueMetaScheduledWork("biz-1");

    const finalizeCalls = vi
      .mocked(warehouse.queueMetaSyncPartition)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.source === "finalize_day" && input.scope === "account_daily");

    expect(finalizeCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerAccountId: "act_1",
          partitionDate: "2026-04-05",
          source: "finalize_day",
        }),
        expect.objectContaining({
          providerAccountId: "act_2",
          partitionDate: "2026-04-06",
          source: "finalize_day",
        }),
      ]),
    );

    vi.useRealTimers();
  });

  it("chooses finalize_day vs repair_recent_day by age and severity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockResolvedValue(
      buildPublishedPlannerRows("act_1", ["2026-04-05", "2026-04-04", "2026-04-03"]) as never,
    );
    vi.mocked(warehouse.getMetaDirtyRecentDates)
      .mockResolvedValueOnce([
        {
          providerAccountId: "act_1",
          date: "2026-04-04",
          severity: "critical",
          reasons: ["non_finalized"],
          nonFinalized: true,
        },
        {
          providerAccountId: "act_1",
          date: "2026-04-03",
          severity: "high",
          reasons: ["spend_drift"],
          spendDrift: true,
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          providerAccountId: "act_1",
          date: "2026-04-02",
          severity: "low",
          reasons: ["missing_breakdown"],
          breakdownOnly: true,
        },
      ] as never);

    const result = await enqueueMetaScheduledWork("biz-1");

    const accountDailyCalls = vi
      .mocked(warehouse.queueMetaSyncPartition)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.scope === "account_daily");

    expect(accountDailyCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          partitionDate: "2026-04-05",
          source: "finalize_day",
        }),
        expect.objectContaining({
          partitionDate: "2026-04-04",
          source: "finalize_day",
        }),
        expect.objectContaining({
          partitionDate: "2026-04-03",
          source: "repair_recent_day",
        }),
        expect.objectContaining({
          partitionDate: "2026-04-02",
          source: "repair_recent_day",
        }),
      ]),
    );
    expect(result.recentAutoHeal.reasonCounts).toEqual(
      expect.objectContaining({
        non_finalized: 1,
        spend_drift: 1,
        missing_breakdown: 1,
      }),
    );
    expect(result.recentAutoHeal.oldestDirtyDate).toBe("2026-04-02");

    vi.useRealTimers();
  });

  it("does not enqueue breakdown-only low severity on D-2", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.getMetaDirtyRecentDates)
      .mockResolvedValueOnce([
        {
          providerAccountId: "act_1",
          date: "2026-04-04",
          severity: "low",
          reasons: ["missing_breakdown"],
          breakdownOnly: true,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    await enqueueMetaScheduledWork("biz-1");

    const repairCalls = vi
      .mocked(warehouse.queueMetaSyncPartition)
      .mock.calls.map(([input]) => input)
      .filter(
        (input) =>
          input.providerAccountId === "act_1" &&
          input.partitionDate === "2026-04-04" &&
          input.source === "repair_recent_day" &&
          input.scope === "account_daily",
      );

    expect(repairCalls).toHaveLength(0);
    vi.useRealTimers();
  });

  it("does not advance D-2 repair work until D-1 is fully published", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockResolvedValue(
      buildCoreOnlyPlannerRows("act_1", ["2026-04-05"]) as never,
    );
    vi.mocked(warehouse.getMetaDirtyRecentDates)
      .mockResolvedValueOnce([
        {
          providerAccountId: "act_1",
          date: "2026-04-04",
          severity: "critical",
          reasons: ["non_finalized"],
          nonFinalized: true,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    await enqueueMetaScheduledWork("biz-1");

    const d2Calls = vi
      .mocked(warehouse.queueMetaSyncPartition)
      .mock.calls.map(([input]) => input)
      .filter(
        (input) =>
          input.providerAccountId === "act_1" &&
          input.partitionDate === "2026-04-04" &&
          input.scope === "account_daily",
      );

    expect(d2Calls).toHaveLength(0);
    vi.useRealTimers();
  });

  it("skips active duplicates, cooldowns, recent successes, and repeated failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token",
      accountIds: ["act_1", "act_2", "act_3", "act_4"],
      currency: "USD",
      accountProfiles: {
        act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        act_2: { currency: "USD", timezone: "UTC", name: "Account 2" },
        act_3: { currency: "USD", timezone: "UTC", name: "Account 3" },
        act_4: { currency: "USD", timezone: "UTC", name: "Account 4" },
      },
    });
    vi.mocked(warehouse.getMetaDirtyRecentDates)
      .mockResolvedValueOnce([
        {
          providerAccountId: "act_2",
          date: "2026-04-04",
          severity: "critical",
          reasons: ["validation_failed"],
          validationFailed: true,
        },
        {
          providerAccountId: "act_3",
          date: "2026-04-04",
          severity: "high",
          reasons: ["spend_drift"],
          spendDrift: true,
        },
        {
          providerAccountId: "act_4",
          date: "2026-04-04",
          severity: "critical",
          reasons: ["validation_failed"],
          validationFailed: true,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockImplementation(
      async ({ providerAccountId }) =>
        buildPublishedPlannerRows(String(providerAccountId), ["2026-04-05"]) as never,
    );
    vi.mocked(warehouse.getMetaRecentAuthoritativeSliceGuard)
      .mockImplementation(async ({ providerAccountId, date, source }: RecentAuthoritativeSliceGuardInput) => {
        if (providerAccountId === "act_1" && date === "2026-04-05" && source === "finalize_day") {
          return {
            activeAuthoritativeSource: "finalize_day",
            activeAuthoritativePriority: 725,
            lastSameSourceAttemptAt: null,
            lastSameSourceSuccessAt: null,
            repeatedFailures24h: 0,
          };
        }
        if (providerAccountId === "act_2") {
          return {
            activeAuthoritativeSource: null,
            activeAuthoritativePriority: 0,
            lastSameSourceAttemptAt: "2026-04-06T08:50:00.000Z",
            lastSameSourceSuccessAt: null,
            repeatedFailures24h: 0,
          };
        }
        if (providerAccountId === "act_3") {
          return {
            activeAuthoritativeSource: null,
            activeAuthoritativePriority: 0,
            lastSameSourceAttemptAt: null,
            lastSameSourceSuccessAt: "2026-04-06T08:40:00.000Z",
            repeatedFailures24h: 0,
          };
        }
        if (providerAccountId === "act_4") {
          return {
            activeAuthoritativeSource: null,
            activeAuthoritativePriority: 0,
            lastSameSourceAttemptAt: null,
            lastSameSourceSuccessAt: null,
            repeatedFailures24h: 3,
          };
        }
        return {
          activeAuthoritativeSource: null,
          activeAuthoritativePriority: 0,
          lastSameSourceAttemptAt: null,
          lastSameSourceSuccessAt: null,
          repeatedFailures24h: 0,
        };
      });

    const result = await enqueueMetaScheduledWork("biz-1");

    expect(result.recentAutoHeal.skippedActiveDuplicate).toBeGreaterThanOrEqual(1);
    expect(result.recentAutoHeal.skippedCooldown).toBeGreaterThanOrEqual(1);
    expect(result.recentAutoHeal.skippedRecentSuccess).toBeGreaterThanOrEqual(1);
    expect(result.recentAutoHeal.skippedRepeatedFailures).toBeGreaterThanOrEqual(1);
    expect(result.recentAutoHeal.reasonCounts.repeated_failures_skip).toBe(2);

    vi.useRealTimers();
  });

  it("does not let recent success skip critical dirty slices", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockResolvedValue(
      buildPublishedPlannerRows("act_1", ["2026-04-05"]) as never,
    );
    vi.mocked(warehouse.getMetaDirtyRecentDates)
      .mockResolvedValueOnce([
        {
          providerAccountId: "act_1",
          date: "2026-04-04",
          severity: "critical",
          reasons: ["validation_failed"],
          validationFailed: true,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(warehouse.getMetaRecentAuthoritativeSliceGuard).mockResolvedValue({
      activeAuthoritativeSource: null,
      activeAuthoritativePriority: 0,
      lastSameSourceAttemptAt: null,
      lastSameSourceSuccessAt: "2026-04-06T08:45:00.000Z",
      repeatedFailures24h: 0,
    } as never);

    await enqueueMetaScheduledWork("biz-1");

    expect(
      vi.mocked(warehouse.queueMetaSyncPartition).mock.calls.some(
        ([input]) =>
          input.providerAccountId === "act_1" &&
          input.partitionDate === "2026-04-04" &&
          input.source === "finalize_day" &&
          input.scope === "account_daily",
      ),
    ).toBe(true);

    vi.useRealTimers();
  });

  it("does not let recent success skip D-1 eventual finalization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.getMetaRecentAuthoritativeSliceGuard).mockResolvedValue({
      activeAuthoritativeSource: null,
      activeAuthoritativePriority: 0,
      lastSameSourceAttemptAt: null,
      lastSameSourceSuccessAt: "2026-04-06T08:45:00.000Z",
      repeatedFailures24h: 0,
    } as never);

    await enqueueMetaScheduledWork("biz-1");

    expect(
      vi.mocked(warehouse.queueMetaSyncPartition).mock.calls.some(
        ([input]) =>
          input.providerAccountId === "act_1" &&
          input.partitionDate === "2026-04-05" &&
          input.source === "finalize_day" &&
          input.scope === "account_daily",
      ),
    ).toBe(true);

    vi.useRealTimers();
  });

  it("still enqueues D-1 maintenance when backlog exists but rollover needs recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 3,
      leasedPartitions: 1,
      historicalCoreQueueDepth: 0,
      historicalCoreLeasedPartitions: 0,
      maintenanceQueueDepth: 2,
      maintenanceLeasedPartitions: 1,
    } as never);
    vi.mocked(providerDayRollover.syncProviderDayRolloverState).mockResolvedValue([
      {
        provider: "meta",
        businessId: "biz-1",
        providerAccountId: "act_1",
        boundary: {
          provider: "meta",
          businessId: "biz-1",
          providerAccountId: "act_1",
          timeZone: "America/Anchorage",
          currentDate: "2026-04-06",
          previousDate: "2026-04-05",
          isPrimary: true,
        },
        lastObservedCurrentDate: "2026-04-05",
        currentD1TargetDate: "2026-04-05",
        rolloverDetected: true,
        d1FinalizeStartedAt: null,
        d1FinalizeCompletedAt: null,
        lastRecoveryAt: null,
      },
    ] as never);

    await enqueueMetaScheduledWork("biz-1");

    expect(
      vi.mocked(warehouse.queueMetaSyncPartition).mock.calls.some(
        ([input]) =>
          input.providerAccountId === "act_1" &&
          input.partitionDate === "2026-04-05" &&
          input.source === "finalize_day" &&
          input.scope === "account_daily",
      ),
    ).toBe(true);

    vi.useRealTimers();
  });

  it("includes tiny_stale_spend in recent auto-heal reason counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockResolvedValue(
      buildPublishedPlannerRows("act_1", ["2026-04-05"]) as never,
    );
    vi.mocked(warehouse.getMetaDirtyRecentDates)
      .mockResolvedValueOnce([
        {
          providerAccountId: "act_1",
          date: "2026-04-04",
          severity: "high",
          reasons: ["spend_drift", "tiny_stale_spend"],
          spendDrift: true,
          tinyStaleSpend: true,
        },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const result = await enqueueMetaScheduledWork("biz-1");

    expect(result.recentAutoHeal.reasonCounts).toEqual(
      expect.objectContaining({
        spend_drift: 1,
        tiny_stale_spend: 1,
      }),
    );

    vi.useRealTimers();
  });

  it("starts historical backfill from the oldest incomplete day without waiting for recent publish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockResolvedValue(
      buildPublishedPlannerRows("act_1", ["2026-04-05"]) as never,
    );

    await enqueueMetaScheduledWork("biz-1");

    const historicalCalls = vi
      .mocked(warehouse.queueMetaSyncPartition)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.source === "historical" && input.scope === "account_daily");

    expect(historicalCalls).toEqual([
      expect.objectContaining({
        providerAccountId: "act_1",
        partitionDate: "2025-04-06",
        source: "historical",
      }),
    ]);

    vi.useRealTimers();
  });

  it("keeps historical backfill anchored to the oldest incomplete day even when recent days are already published", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
    vi.mocked(warehouse.listMetaAuthoritativeDayStates).mockResolvedValue(
      buildPublishedPlannerRows("act_1", ["2026-04-05", "2026-04-04"]) as never,
    );

    await enqueueMetaScheduledWork("biz-1");

    const historicalCalls = vi
      .mocked(warehouse.queueMetaSyncPartition)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.source === "historical" && input.scope === "account_daily");

    expect(historicalCalls).toEqual([
      expect.objectContaining({
        providerAccountId: "act_1",
        partitionDate: "2025-04-06",
        source: "historical",
      }),
    ]);

    vi.useRealTimers();
  });
});
