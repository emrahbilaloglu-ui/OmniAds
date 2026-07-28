import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as dbGrowthFence from "@/lib/sync/db-growth-fence";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary: vi.fn() };
});

vi.mock("@/lib/internal-sync-auth", () => ({
  requireInternalOrAdminSyncAccess: vi.fn(),
  businessExists: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  expireStaleMetaSyncJobs: vi.fn(),
  getMetaQueueHealth: vi.fn(),
  getMetaWarehouseIntegrityIncidents: vi.fn(),
  hasBlockingMetaSyncJob: vi.fn(),
  cleanupMetaPartitionOrchestration: vi.fn(),
  replayMetaDeadLetterPartitions: vi.fn(),
  requeueMetaRetryableFailedPartitions: vi.fn(),
}));

vi.mock("@/lib/google-ads/warehouse", () => ({
  cleanupGoogleAdsObsoleteSyncJobs: vi.fn(),
  expireStaleGoogleAdsSyncJobs: vi.fn(),
  getGoogleAdsQueueHealth: vi.fn(),
  getGoogleAdsCheckpointHealth: vi.fn(),
  cleanupGoogleAdsPartitionOrchestration: vi.fn(),
  replayGoogleAdsDeadLetterPartitions: vi.fn(),
  forceReplayGoogleAdsPoisonedPartitions: vi.fn(),
}));

vi.mock("@/lib/sync/google-ads-sync", () => ({
  enqueueGoogleAdsScheduledWork: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  enqueueMetaScheduledWork: vi.fn(),
  consumeMetaQueuedWork: vi.fn(),
  getMetaSelectedRangeTruthReadiness: vi.fn(),
  syncMetaRepairRange: vi.fn(),
  syncMetaToday: vi.fn(),
}));

vi.mock("@/lib/sync/shopify-sync", () => ({
  syncShopifyCommerceReports: vi.fn(),
}));

vi.mock("@/lib/sync/ga4-sync", () => ({
  syncGA4Reports: vi.fn(),
}));

vi.mock("@/lib/sync/search-console-sync", () => ({
  syncSearchConsoleReports: vi.fn(),
}));

vi.mock("@/lib/sync/provider-repair-engine", () => ({
  runGoogleAdsRepairCycle: vi.fn(),
  runMetaRepairCycle: vi.fn(),
}));

vi.mock("@/lib/admin-logger", () => ({
  logAdminAction: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

const refreshFreshness = vi.hoisted(() => ({ readGoogleAdsFreshness: vi.fn() }));
vi.mock("@/lib/google-ads/freshness-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readGoogleAdsFreshness: refreshFreshness.readGoogleAdsFreshness };
});

const internalAuth = await import("@/lib/internal-sync-auth");
const googleAdsSync = await import("@/lib/sync/google-ads-sync");
const metaSync = await import("@/lib/sync/meta-sync");
const shopifySync = await import("@/lib/sync/shopify-sync");
const adminLogger = await import("@/lib/admin-logger");
const db = await import("@/lib/db");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const metaWarehouse = await import("@/lib/meta/warehouse");
const googleAdsWarehouse = await import("@/lib/google-ads/warehouse");
const providerRepair = await import("@/lib/sync/provider-repair-engine");
const migrations = await import("@/lib/migrations");
const completionSemantics = await import("@/lib/google-ads/completion-semantics");

/**
 * Google Ads had no completion answer on this route at all.
 *
 * Meta returns a truth-readiness object, so a caller can distinguish a started
 * refresh from a verified one. Google Ads returned only
 * `{ ok: true, status: "started" }`, which a client is free to read as "the
 * refresh finished, the numbers are good" — over a window whose every day may
 * have been captured while it was still open.
 *
 * Only the evidence READ is faked; the verdict is the real
 * `resolveGoogleAdsCompletion`.
 */
const REFRESH_FRESHNESS_SCOPES = [
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_daily",
] as const;

function buildRefreshSnapshot(input: {
  totalDays: number;
  coveredDays: number;
  postCloseObservedDays: number;
  lookbackExhaustedDays: number;
  includesOpenDay?: boolean;
}) {
  const includesOpenDay = input.includesOpenDay ?? false;
  const verdict = completionSemantics.resolveGoogleAdsCompletion({
    totalDays: input.totalDays,
    coveredDays: input.coveredDays,
    postCloseObservedDays: input.postCloseObservedDays,
    lookbackExhaustedDays: input.lookbackExhaustedDays,
    includesOpenDay,
  });
  return {
    businessId: "biz",
    startDate: "2026-07-13",
    endDate: "2026-07-26",
    totalDays: input.totalDays,
    providerAccountIds: ["123"],
    timeZoneSource: "account" as const,
    includesOpenDay,
    evidenceAvailable: true,
    unavailableReason: null,
    scopes: Object.fromEntries(
      REFRESH_FRESHNESS_SCOPES.map((scope) => [
        scope,
        {
          scope,
          coveredDays: input.coveredDays,
          postCloseObservedDays: input.postCloseObservedDays,
          lookbackExhaustedDays: input.lookbackExhaustedDays,
          dueNowDays: input.totalDays - input.postCloseObservedDays,
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict,
        },
      ]),
    ),
    overall: verdict,
  };
}

function buildRefreshUnavailableSnapshot(reason: string) {
  const verdict = completionSemantics.unknownGoogleAdsCompletion(reason);
  return {
    businessId: "biz",
    startDate: "2026-07-13",
    endDate: "2026-07-26",
    totalDays: 14,
    providerAccountIds: [],
    timeZoneSource: "default" as const,
    includesOpenDay: true,
    evidenceAvailable: false,
    unavailableReason: reason,
    scopes: Object.fromEntries(
      REFRESH_FRESHNESS_SCOPES.map((scope) => [
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
const { POST } = await import("@/app/api/sync/refresh/route");

function buildRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/sync/refresh", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("POST /api/sync/refresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // A manual refresh admits ONCE, before the first durable write. These cases
    // exercise what the refresh does once admitted; the refusal itself is
    // asserted separately below.
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED = "enabled";
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    delete (globalThis as typeof globalThis & { __syncRefreshInFlightKeys?: Set<string> })
      .__syncRefreshInFlightKeys;
    vi.mocked(internalAuth.businessExists).mockResolvedValue(true);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn().mockResolvedValue([{ already_running: false, acquired: true }]) as never
    );
    vi.mocked(metaWarehouse.cleanupMetaPartitionOrchestration).mockResolvedValue({
      stalePartitionCount: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
    } as never);
    vi.mocked(metaWarehouse.getMetaWarehouseIntegrityIncidents).mockResolvedValue([] as never);
    vi.mocked(metaWarehouse.replayMetaDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(metaWarehouse.requeueMetaRetryableFailedPartitions).mockResolvedValue([] as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 0,
      blockingReasons: [],
      reasonCounts: {},
    } as never);
    vi.mocked(googleAdsWarehouse.cleanupGoogleAdsPartitionOrchestration).mockResolvedValue({
      stalePartitionCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsCheckpointHealth).mockResolvedValue({
      latestCheckpointScope: null,
      latestCheckpointPhase: null,
      latestCheckpointStatus: null,
      latestCheckpointUpdatedAt: null,
      checkpointLagMinutes: null,
      lastSuccessfulPageIndex: null,
      resumeCapable: false,
      checkpointFailures: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.replayGoogleAdsDeadLetterPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.forceReplayGoogleAdsPoisonedPartitions).mockResolvedValue({
      outcome: "no_matching_partitions",
      partitions: [],
      matchedCount: 0,
      changedCount: 0,
      skippedActiveLeaseCount: 0,
    } as never);
    vi.mocked(providerRepair.runMetaRepairCycle).mockResolvedValue({
      cleanup: null,
      replayedDeadLetters: null,
      replayedRetryableFailures: [],
      queuedWarehouseRepairs: [],
      d1Recovery: null,
      enqueueResult: {
        businessId: "biz",
        queuedCore: 1,
        queuedMaintenance: 0,
        queueDepth: 1,
        leasedPartitions: 0,
      },
      repair: {
        replayed: 0,
        requeued: 0,
        reclaimed: 0,
        blocked: false,
      },
    } as never);
    vi.mocked(providerRepair.runGoogleAdsRepairCycle).mockResolvedValue({
      cleanup: null,
      replayedDeadLetters: null,
      replayedPoisoned: null,
      queuedWarehouseRepairs: [],
      enqueueResult: {
        businessId: "biz",
        queuedCore: 1,
        queueDepth: 1,
        leasedPartitions: 0,
      },
      repair: {
        replayed: 0,
        requeued: 0,
        reclaimed: 0,
        blocked: false,
      },
    } as never);
  });

  it("fails fast when refresh tables are not ready", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["provider_sync_jobs"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });

    const response = await POST(buildRequest({ businessId: "biz", provider: "google_ads" }));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: "schema_not_ready",
      message: "Sync refresh is unavailable until request-external migrations are applied.",
      provider: "google_ads",
      missingTables: ["provider_sync_jobs"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    expect(providerRepair.runGoogleAdsRepairCycle).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("rejects unauthorized callers", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    });

    const response = await POST(buildRequest({ businessId: "biz", provider: "meta" }));

    expect(response.status).toBe(401);
  });

  it("rejects non-admin callers that fail the sync access gate", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const response = await POST(buildRequest({ businessId: "biz", provider: "meta" }));

    expect(response.status).toBe(403);
  });

  it("rejects unsupported providers", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });

    const response = await POST(buildRequest({ businessId: "biz", provider: "ga4" }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("unsupported_provider_for_refresh");
  });

  it("returns processing for Meta range refresh until finalized truth is ready", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(metaSync.syncMetaRepairRange).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    } as never);

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "repair",
        startDate: "2026-03-01",
        endDate: "2026-03-02",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.status).toBe("processing");
    expect(metaSync.syncMetaRepairRange).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
      triggerSource: "manual_refresh",
    });
    expect(metaSync.getMetaSelectedRangeTruthReadiness).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-02",
    });
    expect(metaSync.consumeMetaQueuedWork).not.toHaveBeenCalled();
  });

  it("returns finalized when Meta refresh already produced finalized truth", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(metaSync.syncMetaRepairRange).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: true,
      state: "finalized_verified",
      totalDays: 1,
      completedCoreDays: 1,
      blockingReasons: [],
      reasonCounts: {},
    } as never);

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "repair",
        startDate: "2026-04-05",
        endDate: "2026-04-05",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.status).toBe("finalized_verified");
  });

  it("runs an inline Meta consume fallback for explicit single-day refreshes when no consumer is active", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(metaSync.syncMetaRepairRange).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    } as never);
    vi.mocked(metaSync.consumeMetaQueuedWork).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: false,
    } as never);

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "repair",
        startDate: "2026-04-05",
        endDate: "2026-04-05",
      })
    );

    expect(response.status).toBe(202);
    expect(metaSync.syncMetaRepairRange).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-05",
      endDate: "2026-04-05",
      triggerSource: "manual_refresh",
    });
    expect(metaSync.consumeMetaQueuedWork).toHaveBeenCalledWith("biz");
  });

  it("returns not found for unknown businesses", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(internalAuth.businessExists).mockResolvedValue(false);

    const response = await POST(buildRequest({ businessId: "missing", provider: "meta" }));

    expect(response.status).toBe(404);
  });

  it("refuses a manual refresh with the lane closed, before any durable write", async () => {
    // The refresh took the durable lock, expired stale jobs and cleaned up
    // obsolete ones before anything checked whether sync was allowed to run at
    // all — so a lane closed for a cutover was undone by one operator clicking
    // refresh.
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    delete process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED;
    const response = await POST(buildRequest({ businessId: "biz", provider: "meta" }));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toBe("lane_disabled");
    expect(payload.refusal).toMatchObject({ kind: "lane_disabled", scope: "meta_sync" });
    // Nothing ran: no lock, no job-state writes, no sync.
    expect(metaWarehouse.expireStaleMetaSyncJobs).not.toHaveBeenCalled();
    expect(providerRepair.runMetaRepairCycle).not.toHaveBeenCalled();
    expect(metaSync.enqueueMetaScheduledWork).not.toHaveBeenCalled();
  });

  it("refuses a manual refresh when capacity cannot be proven", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockRejectedValue(
      new dbGrowthFence.DbGrowthFenceRefusal(
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
        "manual_refresh_google_ads",
      ),
    );
    const response = await POST(
      buildRequest({ businessId: "biz", provider: "google_ads" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toBe("capacity_refused");
    expect(googleAdsWarehouse.cleanupGoogleAdsObsoleteSyncJobs).not.toHaveBeenCalled();
    expect(googleAdsWarehouse.expireStaleGoogleAdsSyncJobs).not.toHaveBeenCalled();
    expect(providerRepair.runGoogleAdsRepairCycle).not.toHaveBeenCalled();
  });

  it("admits with FRESH capacity, not a cached sample", async () => {
    // A cached reading is exactly what a refresh started after the database
    // filled up would read: the last good sample, taken before the growth.
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    await POST(buildRequest({ businessId: "biz", provider: "meta" }));
    expect(dbGrowthFence.assertSyncGrowthBoundary).toHaveBeenCalledWith(
      "manual_refresh_meta",
      { fresh: true },
    );
  });

  it("returns started after durable enqueue succeeds", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    const response = await POST(buildRequest({ businessId: "biz", provider: "meta" }));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.status).toBe("started");
    expect(providerRepair.runMetaRepairCycle).toHaveBeenCalledWith("biz");
    expect(payload.result.repair).toEqual(
      expect.objectContaining({
        replayed: 0,
        requeued: 0,
        blocked: false,
      })
    );
  });

  it("supports manual Shopify refresh", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ already_running: false, acquired: true }]) as never
    );
    vi.mocked(shopifySync.syncShopifyCommerceReports).mockResolvedValue({
      success: true,
      reason: "ok",
    } as never);

    const response = await POST(buildRequest({ businessId: "biz", provider: "shopify" }));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.status).toBe("started");
    expect(shopifySync.syncShopifyCommerceReports).toHaveBeenCalledWith("biz");
  });

  it("returns already_running when work is already active", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "admin",
      session: { user: { id: "admin_1" } } as never,
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn().mockResolvedValue([{ leased_count: 1 }]) as never
    );

    const response = await POST(buildRequest({ businessId: "biz", provider: "meta" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, status: "already_running" });
    expect(adminLogger.logAdminAction).toHaveBeenCalled();
  });

  it("returns already_running when meta enqueue finds existing backlog without new work", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(providerRepair.runMetaRepairCycle).mockResolvedValue({
      cleanup: null,
      replayedDeadLetters: null,
      replayedRetryableFailures: [],
      queuedWarehouseRepairs: [],
      d1Recovery: null,
      enqueueResult: {
        businessId: "biz",
        queuedCore: 0,
        queuedMaintenance: 0,
        queueDepth: 2,
        leasedPartitions: 0,
      },
      repair: {
        replayed: 0,
        requeued: 0,
        reclaimed: 0,
        blocked: false,
      },
    } as never);

    const response = await POST(buildRequest({ businessId: "biz", provider: "meta" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      status: "already_running",
      provider: "meta",
      result: expect.objectContaining({
        businessId: "biz",
        queuedCore: 0,
        queuedMaintenance: 0,
        queueDepth: 2,
        leasedPartitions: 0,
        repair: expect.objectContaining({
          replayed: 0,
          requeued: 0,
          blocked: false,
        }),
      }),
    });
  });

  it("returns processing for an accepted Meta finalize_range refresh even when no new partitions were queued", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(metaSync.syncMetaRepairRange).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 0,
      failed: 0,
      skipped: true,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 0,
      blockingReasons: [],
      reasonCounts: {},
      verificationState: "processing",
    } as never);

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "finalize_range",
        startDate: "2026-04-05",
        endDate: "2026-04-05",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      status: "processing",
      provider: "meta",
      result: {
        businessId: "biz",
        attempted: 1,
        succeeded: 0,
        failed: 0,
        skipped: true,
      },
      truthReadiness: expect.objectContaining({
        truthReady: false,
        state: "processing",
      }),
    });
  });

  it("returns blocked when Meta finalize_range truth is explicitly blocked", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(metaSync.syncMetaRepairRange).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 0,
      failed: 0,
      skipped: true,
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

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "finalize_range",
        startDate: "2026-04-05",
        endDate: "2026-04-05",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      status: "blocked",
      provider: "meta",
      result: {
        businessId: "biz",
        attempted: 1,
        succeeded: 0,
        failed: 0,
        skipped: true,
      },
      truthReadiness: expect.objectContaining({
        verificationState: "blocked",
        detectorReasonCodes: ["publication_pointer_missing_after_finalize"],
      }),
    });
  });

  it("returns already_running when Google Ads enqueue finds existing backlog without new work", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(providerRepair.runGoogleAdsRepairCycle).mockResolvedValue({
      cleanup: null,
      replayedDeadLetters: null,
      replayedPoisoned: null,
      queuedWarehouseRepairs: [],
      enqueueResult: {
        businessId: "biz",
        queuedCore: 0,
        queueDepth: 3,
        leasedPartitions: 0,
      },
      repair: {
        replayed: 0,
        requeued: 0,
        reclaimed: 0,
        blocked: false,
      },
    } as never);

    const response = await POST(buildRequest({ businessId: "biz", provider: "google_ads" }));

    expect(response.status).toBe(202);
    const payload = await response.json();
    // `status` is unchanged — it answers "did we start work", which operator
    // tooling keys off. The freshness verdict is ADDED next to it.
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        status: "already_running",
        provider: "google_ads",
        result: expect.objectContaining({
          businessId: "biz",
          queuedCore: 0,
          queueDepth: 3,
          leasedPartitions: 0,
          repair: expect.objectContaining({
            replayed: 0,
            requeued: 0,
            blocked: false,
          }),
        }),
      }),
    );
    expect(payload.googleAdsFreshness).toBeDefined();
    expect(payload.mayStopPolling).toBe(false);
  });

  it("returns started with repair details when Google Ads refresh replays blocked work", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(providerRepair.runGoogleAdsRepairCycle).mockResolvedValue({
      cleanup: null,
      replayedDeadLetters: null,
      replayedPoisoned: null,
      queuedWarehouseRepairs: [],
      enqueueResult: {
        businessId: "biz",
        queuedCore: 0,
        queueDepth: 0,
        leasedPartitions: 0,
      },
      repair: {
        replayed: 1,
        requeued: 0,
        reclaimed: 0,
        blocked: false,
      },
    } as never);

    const response = await POST(buildRequest({ businessId: "biz", provider: "google_ads" }));

    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        status: "started",
        provider: "google_ads",
        result: expect.objectContaining({
          repair: expect.objectContaining({
            replayed: 1,
            blocked: false,
          }),
        }),
      }),
    );
    expect(payload.googleAdsFreshness).toBeDefined();
    expect(payload.mayStopPolling).toBe(false);
  });

  it("returns 500 and logs failed audits when enqueue throws", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "admin",
      session: { user: { id: "admin_1" } } as never,
    });
    vi.mocked(providerRepair.runGoogleAdsRepairCycle).mockRejectedValue(
      new Error("enqueue failed")
    );

    const response = await POST(buildRequest({ businessId: "biz", provider: "google_ads" }));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe("internal_error");
    expect(adminLogger.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sync.refresh",
        meta: expect.objectContaining({ outcome: "failed" }),
      })
    );
  });

  it("returns already_running for overlapping in-process refresh requests", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn().mockResolvedValue([{ already_running: false, acquired: true }]) as never
    );
    const pending = deferred<{
      cleanup: null;
      replayedDeadLetters: null;
      replayedPoisoned: null;
      queuedWarehouseRepairs: [];
      enqueueResult: {
        businessId: string;
        queuedCore: number;
        queueDepth: number;
        leasedPartitions: number;
      };
      repair: {
        replayed: number;
        requeued: number;
        reclaimed: number;
        blocked: boolean;
      };
    }>();
    vi.mocked(providerRepair.runGoogleAdsRepairCycle).mockReturnValue(pending.promise as never);

    const firstResponsePromise = POST(buildRequest({ businessId: "biz", provider: "google_ads" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondResponse = await POST(buildRequest({ businessId: "biz", provider: "google_ads" }));

    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json()).toEqual({ ok: true, status: "already_running" });
    expect(providerRepair.runGoogleAdsRepairCycle).toHaveBeenCalledTimes(1);

    pending.resolve({
      cleanup: null,
      replayedDeadLetters: null,
      replayedPoisoned: null,
      queuedWarehouseRepairs: [],
      enqueueResult: {
        businessId: "biz",
        queuedCore: 1,
        queueDepth: 1,
        leasedPartitions: 0,
      },
      repair: {
        replayed: 0,
        requeued: 0,
        reclaimed: 0,
        blocked: false,
      },
    });

    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(202);
    await firstResponse.json();
  });

  it("returns already_running when the durable refresh lock is already held", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "admin",
      session: { user: { id: "admin_1" } } as never,
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn().mockResolvedValue([{ already_running: true, acquired: false }]) as never
    );

    const response = await POST(buildRequest({ businessId: "biz", provider: "google_ads" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, status: "already_running" });
    expect(providerRepair.runGoogleAdsRepairCycle).not.toHaveBeenCalled();
    expect(adminLogger.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sync.refresh",
        meta: expect.objectContaining({ duplicateReason: "durable_refresh_lock" }),
      })
    );
  });

  it("does not report already_running when a Meta range refresh reacquires the durable lock and progresses", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "admin",
      session: { user: { id: "admin_1" } } as never,
    });
    vi.mocked(metaSync.syncMetaRepairRange).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 0,
      failed: 0,
      skipped: true,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 0,
      blockingReasons: [],
      reasonCounts: { processing: 1 },
      verificationState: "processing",
    } as never);

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "finalize_range",
        startDate: "2026-04-05",
        endDate: "2026-04-05",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        status: "processing",
        provider: "meta",
      }),
    );
    expect(adminLogger.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sync.refresh",
        meta: expect.objectContaining({ outcome: "processing" }),
      }),
    );
  });

  it("does not report already_running for an idle Meta finalize_range target with only a stale durable lock", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn()
        .mockResolvedValueOnce([{ already_running: false, acquired: true }])
        .mockResolvedValueOnce([{ already_running: true, acquired: false }])
        .mockResolvedValueOnce([{ age_seconds: 30 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ already_running: false, acquired: true }]) as never,
    );
    vi.mocked(metaSync.syncMetaRepairRange).mockResolvedValue({
      businessId: "biz",
      attempted: 1,
      succeeded: 0,
      failed: 0,
      skipped: false,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      totalDays: 1,
      completedCoreDays: 0,
      blockingReasons: [],
      reasonCounts: {},
      verificationState: "processing",
    } as never);

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "finalize_range",
        startDate: "2026-04-04",
        endDate: "2026-04-04",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        status: "processing",
        provider: "meta",
      }),
    );
    expect(metaSync.syncMetaRepairRange).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-04",
      endDate: "2026-04-04",
      triggerSource: "manual_refresh",
    });
  });

  it("keeps already_running for a real active Meta finalize_range durable lock", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn()
        .mockResolvedValueOnce([{ already_running: false, acquired: true }])
        .mockResolvedValueOnce([{ already_running: true, acquired: false }])
        .mockResolvedValueOnce([{ age_seconds: 5 }]) as never,
    );

    const response = await POST(
      buildRequest({
        businessId: "biz",
        provider: "meta",
        mode: "finalize_range",
        startDate: "2026-04-04",
        endDate: "2026-04-04",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, status: "already_running" });
    expect(metaSync.syncMetaRepairRange).not.toHaveBeenCalled();
  });

  it("fails closed when durable refresh lock acquisition errors", async () => {
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "admin",
      session: { user: { id: "admin_1" } } as never,
    });
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn().mockRejectedValue(new Error("db unavailable")) as never
    );

    const response = await POST(buildRequest({ businessId: "biz", provider: "google_ads" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "refresh_lock_unavailable",
      message: "Could not acquire durable refresh lock.",
    });
    expect(googleAdsSync.enqueueGoogleAdsScheduledWork).not.toHaveBeenCalled();
    expect(adminLogger.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sync.refresh",
        meta: expect.objectContaining({ error: "durable_refresh_lock_acquisition_failed" }),
      })
    );
  });
});

describe("POST /api/sync/refresh Google Ads freshness verdict", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    delete (globalThis as typeof globalThis & { __syncRefreshInFlightKeys?: Set<string> })
      .__syncRefreshInFlightKeys;
    vi.mocked(internalAuth.requireInternalOrAdminSyncAccess).mockResolvedValue({
      kind: "internal",
    } as never);
    vi.mocked(internalAuth.businessExists).mockResolvedValue(true);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-07-26T00:00:00.000Z",
    } as never);
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn().mockResolvedValue([{ already_running: false, acquired: true }]) as never,
    );
    vi.mocked(googleAdsWarehouse.cleanupGoogleAdsObsoleteSyncJobs).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(googleAdsWarehouse.expireStaleGoogleAdsSyncJobs).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(googleAdsWarehouse.getGoogleAdsQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
    } as never);
    vi.mocked(googleAdsWarehouse.getGoogleAdsCheckpointHealth).mockResolvedValue({
      checkpointFailures: 0,
    } as never);
    vi.mocked(providerRepair.runGoogleAdsRepairCycle).mockResolvedValue({
      enqueueResult: { businessId: "biz", queuedCore: 1, queueDepth: 1, leasedPartitions: 0 },
      repair: { replayed: 0, requeued: 0, reclaimed: 0, blocked: false },
    } as never);
  });

  const googleRefresh = () =>
    POST(buildRequest({ businessId: "biz", provider: "google_ads" }));

  it("does not let a 202 imply completion for days that are covered but never re-read", async () => {
    refreshFreshness.readGoogleAdsFreshness.mockResolvedValue(
      buildRefreshSnapshot({
        totalDays: 14,
        coveredDays: 14,
        postCloseObservedDays: 0,
        lookbackExhaustedDays: 0,
      }),
    );

    const response = await googleRefresh();
    const payload = await response.json();

    expect(response.status).toBe(202);
    // NEGATIVE CONTROL: the same evidence reports 14 of 14 covered days, so a
    // coverage-derived verdict would say 100 / complete / stop polling.
    expect(payload.googleAdsFreshness.scopes[0].coveredDays).toBe(14);
    expect(payload.googleAdsFreshness.state).toBe("provisional");
    expect(payload.googleAdsFreshness.percent).toBeLessThan(100);
    expect(payload.googleAdsFreshness.complete).toBe(false);
    expect(payload.mayStopPolling).toBe(false);
    // The existing operator-facing fields are untouched.
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("started");
    expect(payload.provider).toBe("google_ads");
  });

  it("does not call a converging window complete", async () => {
    refreshFreshness.readGoogleAdsFreshness.mockResolvedValue(
      buildRefreshSnapshot({
        totalDays: 14,
        coveredDays: 14,
        postCloseObservedDays: 14,
        lookbackExhaustedDays: 2,
      }),
    );

    const payload = await (await googleRefresh()).json();

    expect(payload.googleAdsFreshness.state).toBe("converging");
    expect(payload.googleAdsFreshness.complete).toBe(false);
    expect(payload.mayStopPolling).toBe(false);
  });

  it("reports a settled window as complete and safe to stop polling", async () => {
    refreshFreshness.readGoogleAdsFreshness.mockResolvedValue(
      buildRefreshSnapshot({
        totalDays: 14,
        coveredDays: 14,
        postCloseObservedDays: 14,
        lookbackExhaustedDays: 14,
      }),
    );

    const payload = await (await googleRefresh()).json();

    expect(payload.googleAdsFreshness.state).toBe("settled");
    expect(payload.googleAdsFreshness.percent).toBe(100);
    expect(payload.googleAdsFreshness.complete).toBe(true);
    expect(payload.mayStopPolling).toBe(true);
  });

  it("fails closed to a RETRYABLE unknown when the evidence is unavailable, and still returns 202", async () => {
    refreshFreshness.readGoogleAdsFreshness.mockResolvedValue(
      buildRefreshUnavailableSnapshot("No Google Ads accounts are assigned to this business."),
    );

    const response = await googleRefresh();
    const payload = await response.json();

    // Not an error, and not healthy.
    expect(response.status).toBe(202);
    expect(payload.error).toBeUndefined();
    expect(payload.googleAdsFreshness.state).toBe("unknown");
    expect(payload.googleAdsFreshness.evidenceAvailable).toBe(false);
    expect(payload.googleAdsFreshness.complete).toBe(false);
    expect(payload.mayStopPolling).toBe(false);
    expect(payload.googleAdsFreshness.unavailableReason).toContain("No Google Ads accounts");
  });

  it("fails closed when the evidence read itself rejects", async () => {
    refreshFreshness.readGoogleAdsFreshness.mockRejectedValue(new Error("pool exhausted"));

    const response = await googleRefresh();
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.googleAdsFreshness.state).toBe("unknown");
    expect(payload.mayStopPolling).toBe(false);
  });

  it("issues exactly ONE bulk read, covering every scope in that one call", async () => {
    refreshFreshness.readGoogleAdsFreshness.mockResolvedValue(
      buildRefreshSnapshot({
        totalDays: 14,
        coveredDays: 14,
        postCloseObservedDays: 14,
        lookbackExhaustedDays: 14,
      }),
    );

    await googleRefresh();

    expect(refreshFreshness.readGoogleAdsFreshness).toHaveBeenCalledTimes(1);
    expect(refreshFreshness.readGoogleAdsFreshness.mock.calls[0][0].scopes).toEqual([
      ...REFRESH_FRESHNESS_SCOPES,
    ]);
  });

  it("does not read Google Ads freshness for a Meta refresh", async () => {
    process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED = "enabled";
    vi.mocked(metaWarehouse.expireStaleMetaSyncJobs).mockResolvedValue(undefined as never);
    vi.mocked(metaWarehouse.getMetaQueueHealth).mockResolvedValue({
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
    } as never);
    vi.mocked(providerRepair.runMetaRepairCycle).mockResolvedValue({
      enqueueResult: { businessId: "biz", queuedCore: 1 },
      repair: { replayed: 0, requeued: 0, reclaimed: 0, blocked: false },
    } as never);

    const payload = await (
      await POST(buildRequest({ businessId: "biz", provider: "meta" }))
    ).json();

    expect(refreshFreshness.readGoogleAdsFreshness).not.toHaveBeenCalled();
    expect(payload.googleAdsFreshness).toBeUndefined();
  });
});
