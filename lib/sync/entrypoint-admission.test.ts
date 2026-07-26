import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Table-driven admission over the REAL exported entrypoints.
 *
 * Not a source-string scan and not a guard-position assertion: each case calls
 * the exported function that production calls, with the global switch off or the
 * capacity fence refusing, and asserts that no database statement was issued and
 * that the refusal escaped unchanged.
 *
 * The distinction matters because both failures this replaces looked fine from
 * the outside. The cron performed a complete pass — snapshot jobs, repair
 * planner, auto-execute, duplicate reconciliation — and reported the refusal at
 * the END. Dead-letter replay had no admission at all and would revive a revoked
 * account's work. In both cases "it refused" was true and "it wrote nothing" was
 * not.
 */

const getDb = vi.fn();
const assertSyncGrowthBoundary = vi.fn();

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDb,
    getDbWithTimeout: getDb,
    runDbTransaction: vi.fn(async (run: () => Promise<unknown>) => run()),
  };
});

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary };
});

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(async () => null),
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true, missingTables: [] })),
  isMissingRelationError: vi.fn(() => false),
}));

const { DbGrowthFenceRefusal } = await import("@/lib/sync/db-growth-fence");

/**
 * Every exported path this contract covers, with the lane that must gate it.
 *
 * `call` invokes the REAL function. `lane` is the environment variable that
 * admits it, so the "global off" case can also prove the lane-specific switch is
 * honoured independently.
 */
const ENTRYPOINTS: Array<{
  name: string;
  lane: string;
  /** Additional lanes this entrypoint also requires. */
  extraLanes?: string[];
  call: () => Promise<unknown>;
}> = [
  {
    name: "replayMetaDeadLetterPartitions",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    call: async () => {
      const { replayMetaDeadLetterPartitions } = await import("@/lib/meta/warehouse");
      return replayMetaDeadLetterPartitions({ businessId: "biz-1" });
    },
  },
  {
    name: "replayGoogleAdsDeadLetterPartitions",
    lane: "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
    call: async () => {
      const { replayGoogleAdsDeadLetterPartitions } = await import(
        "@/lib/google-ads/warehouse"
      );
      return replayGoogleAdsDeadLetterPartitions({ businessId: "biz-1" });
    },
  },
  {
    name: "cleanupMetaPartitionOrchestration",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    call: async () => {
      const { cleanupMetaPartitionOrchestration } = await import("@/lib/meta/warehouse");
      return cleanupMetaPartitionOrchestration({ businessId: "biz-1" });
    },
  },
  {
    name: "cleanupGoogleAdsPartitionOrchestration",
    lane: "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
    call: async () => {
      const { cleanupGoogleAdsPartitionOrchestration } = await import(
        "@/lib/google-ads/warehouse"
      );
      return cleanupGoogleAdsPartitionOrchestration({ businessId: "biz-1" });
    },
  },
  {
    name: "enqueueMetaScheduledWork",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    extraLanes: ["ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED"],
    call: async () => {
      const { enqueueMetaScheduledWork } = await import("@/lib/sync/meta-sync");
      return enqueueMetaScheduledWork("biz-1");
    },
  },
  {
    name: "enqueueGoogleAdsScheduledWork",
    lane: "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
    extraLanes: ["ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED"],
    call: async () => {
      const { enqueueGoogleAdsScheduledWork } = await import(
        "@/lib/sync/google-ads-sync"
      );
      return enqueueGoogleAdsScheduledWork("biz-1");
    },
  },
  {
    name: "replaceProviderAccountSelection",
    lane: "ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED",
    call: async () => {
      const { replaceProviderAccountSelection } = await import(
        "@/lib/provider-account-assignments"
      );
      return replaceProviderAccountSelection({
        businessId: "biz-1",
        provider: "meta",
        accountIds: ["act_1"],
      });
    },
  },
  {
    name: "syncMetaInitial",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    call: async () => {
      const { syncMetaInitial } = await import("@/lib/sync/meta-sync");
      return syncMetaInitial("biz-1");
    },
  },
  {
    name: "syncMetaReports",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    call: async () => {
      const { syncMetaReports } = await import("@/lib/sync/meta-sync");
      return syncMetaReports({ businessId: "biz-1" } as never);
    },
  },
  {
    name: "backfillMetaRange",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    call: async () => {
      const { backfillMetaRange } = await import("@/lib/sync/meta-sync");
      return backfillMetaRange({
        businessId: "biz-1",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      } as never);
    },
  },
  {
    name: "recoverMetaD1FinalizePartitions",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    call: async () => {
      const { recoverMetaD1FinalizePartitions } = await import(
        "@/lib/sync/meta-sync"
      );
      return recoverMetaD1FinalizePartitions({ businessId: "biz-1" });
    },
  },
  {
    name: "syncMetaRepairRange",
    lane: "ADSECUTE_SYNC_LANE_META_SYNC_ENABLED",
    call: async () => {
      const { syncMetaRepairRange } = await import("@/lib/sync/meta-sync");
      return syncMetaRepairRange({
        businessId: "biz-1",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      } as never);
    },
  },
  {
    name: "refreshGoogleAdsSyncStateForBusiness",
    lane: "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
    call: async () => {
      const { refreshGoogleAdsSyncStateForBusiness } = await import(
        "@/lib/sync/google-ads-sync"
      );
      return refreshGoogleAdsSyncStateForBusiness({ businessId: "biz-1" });
    },
  },
  {
    name: "syncGoogleAdsRange",
    lane: "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
    call: async () => {
      const { syncGoogleAdsRange } = await import("@/lib/sync/google-ads-sync");
      return syncGoogleAdsRange({
        businessId: "biz-1",
        startDate: "2026-01-01",
        endDate: "2026-01-02",
      } as never);
    },
  },
  {
    name: "runGoogleAdsTargetedRepair",
    lane: "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
    call: async () => {
      const { runGoogleAdsTargetedRepair } = await import(
        "@/lib/sync/google-ads-sync"
      );
      return runGoogleAdsTargetedRepair({ businessId: "biz-1" } as never);
    },
  },
  {
    name: "recoverGoogleAdsD1FinalizePartitions",
    lane: "ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED",
    call: async () => {
      const { recoverGoogleAdsD1FinalizePartitions } = await import(
        "@/lib/sync/google-ads-sync"
      );
      return recoverGoogleAdsD1FinalizePartitions({ businessId: "biz-1" });
    },
  },
  {
    name: "runAutoSyncRepairPass",
    lane: "ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED",
    call: async () => {
      const { runAutoSyncRepairPass } = await import("@/lib/sync/repair-executor");
      return runAutoSyncRepairPass({
        businessId: "biz-1",
        providerScope: "meta",
        source: "cron",
      } as never);
    },
  },
  {
    name: "executeAutoSyncRepairPlan",
    lane: "ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED",
    call: async () => {
      const { executeAutoSyncRepairPlan } = await import(
        "@/lib/sync/repair-executor"
      );
      return executeAutoSyncRepairPlan({
        providerScope: "meta",
        source: "cron",
        repairPlan: { recommendations: [] },
      } as never);
    },
  },
];

const savedEnv = { ...process.env };

describe("entrypoint admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A database that records every statement and answers nothing. If an
    // entrypoint issues even one query under refusal, this fails.
    const tag = (async () => []) as never;
    (tag as unknown as { query: unknown }).query = async () => [];
    getDb.mockReturnValue(tag);
    assertSyncGrowthBoundary.mockResolvedValue({ allowed: true, reason: "ready" });
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it.each(ENTRYPOINTS.map((entry) => [entry.name, entry] as const))(
    "%s writes nothing and refuses under global-off",
    async (_name, entry) => {
      delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
      process.env[entry.lane] = "enabled";
      for (const lane of entry.extraLanes ?? []) process.env[lane] = "enabled";

      const outcome = await entry.call().then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).not.toBeNull();
      // The refusal escapes UNCHANGED. Flattened into an ordinary failure it
      // becomes a retry; flattened into success it becomes silent data loss.
      expect((outcome as Error).name).toBe("SyncLaneDisabledError");
      expect(getDb).not.toHaveBeenCalled();
    },
  );

  it.each(
    ENTRYPOINTS.filter((entry) => entry.lane !== "ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED")
      .map((entry) => [entry.name, entry] as const),
  )("%s writes nothing when fresh capacity refuses", async (_name, entry) => {
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env[entry.lane] = "enabled";
    for (const lane of entry.extraLanes ?? []) process.env[lane] = "enabled";
    assertSyncGrowthBoundary.mockRejectedValue(
      new DbGrowthFenceRefusal(
        {
          allowed: false,
          reason: "physical_free_space_low",
          warning: false,
          databaseBytes: 1,
          databaseBudgetBytes: 2,
          tableBytes: {},
          offender: null,
          evaluatedAt: new Date(0).toISOString(),
          errorMessage: "disk full",
          overridden: false,
          physical: null,
        },
        "entrypoint_admission_probe",
      ),
    );

    const outcome = await entry.call().then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).not.toBeNull();
    expect((outcome as Error).name).toBe("DbGrowthFenceRefusal");
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each(ENTRYPOINTS.map((entry) => [entry.name, entry] as const))(
    "%s measures capacity FRESHLY, not from a cached sample",
    async (_name, entry) => {
      process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
      process.env[entry.lane] = "enabled";
      for (const lane of entry.extraLanes ?? []) process.env[lane] = "enabled";
      await entry.call().catch(() => undefined);
      // Selection mutation is lane-gated but does not take a capacity sample: it
      // shrinks or replaces a small set of rows rather than growing storage.
      if (entry.lane === "ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED") {
        expect(assertSyncGrowthBoundary).not.toHaveBeenCalled();
        return;
      }
      expect(assertSyncGrowthBoundary).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ fresh: true }),
      );
    },
  );
});
