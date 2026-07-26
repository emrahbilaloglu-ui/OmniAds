import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHOPIFY_AUTOMATED_OVERVIEW_SNAPSHOT_REPORT_TYPE,
  shouldAutoWarmShopifyOverviewSnapshot,
} from "@/lib/sync/report-warmer-boundaries";

vi.mock("@/lib/sync/global-kill-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/global-kill-switch")>();
  return {
    ...actual,
    // Lanes default to OFF. Admission has its own suite
    // (shopify-lane-admission.test.ts); this one is about what runs behind it.
    assertSyncLaneEnabled: vi.fn(() => ({
      lane: "shopify_sync" as const,
      enabled: true,
      reason: "enabled" as const,
    })),
  };
});

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return {
    ...actual,
    assertSyncGrowthBoundary: vi.fn(async () => ({
      allowed: true as const,
      reason: "ready" as const,
      warning: false,
      databaseBytes: 1,
      databaseBudgetBytes: 2,
      tableBytes: {},
      offender: null,
      evaluatedAt: "2026-07-26T00:00:00.000Z",
      errorMessage: null,
      overridden: false,
    })),
  };
});
vi.mock("@/lib/shopify/admin", () => ({
  resolveShopifyAdminCredentials: vi.fn(),
  hasShopifyScope: vi.fn((scopes: string | null | undefined, scope: string) =>
    (scopes ?? "")
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .includes(scope)
  ),
}));

vi.mock("@/lib/integrations", () => ({
  mergeIntegrationMetadata: vi.fn(),
  // The readiness pass re-observes the Shopify grant immediately before it
  // MUTATES webhooks, so this connection is part of the fixture rather than a
  // detail of the credential resolver.
  getIntegration: vi.fn(async () => ({
    id: "int-shopify",
    business_id: "biz_1",
    provider: "shopify",
    status: "connected",
    provider_account_id: "shop_1",
    access_token: "token_1",
    connection_generation: 4,
    metadata: {},
  })),
}));

vi.mock("@/lib/shopify/read-adapter", () => ({
  getShopifyOverviewReadCandidate: vi.fn(),
}));

vi.mock("@/lib/shopify/overview-materializer", () => ({
  persistShopifyOverviewServingState: vi.fn(),
  recordShopifyOverviewReconciliationRun: vi.fn(),
}));

vi.mock("@/lib/shopify/status", () => ({
  getShopifyStatus: vi.fn(),
}));

vi.mock("@/lib/shopify/webhooks", () => ({
  registerShopifySyncWebhooks: vi.fn(),
  verifyShopifySyncWebhooks: vi.fn(),
}));

vi.mock("@/lib/shopify/commerce-sync", () => ({
  syncShopifyOrdersWindow: vi.fn(),
  syncShopifyReturnsWindow: vi.fn(),
}));

vi.mock("@/lib/shopify/sync-state", () => ({
  getShopifySyncState: vi.fn(),
  upsertShopifySyncState: vi.fn(),
}));

vi.mock("@/lib/shopify/warehouse-overview", () => ({
  getShopifyWarehouseOverviewAggregate: vi.fn(),
}));

vi.mock("@/lib/shopify/revenue-ledger", () => ({
  getShopifyRevenueLedgerAggregate: vi.fn(),
}));

vi.mock("@/lib/user-facing-report-cache-owners", () => ({
  warmShopifyOverviewReportCache: vi.fn(),
}));

const admin = await import("@/lib/shopify/admin");
const integrations = await import("@/lib/integrations");
const commerceSync = await import("@/lib/shopify/commerce-sync");
const readAdapter = await import("@/lib/shopify/read-adapter");
const overviewMaterializer = await import("@/lib/shopify/overview-materializer");
const shopifyStatus = await import("@/lib/shopify/status");
const webhooks = await import("@/lib/shopify/webhooks");
const syncState = await import("@/lib/shopify/sync-state");
const warehouseOverview = await import("@/lib/shopify/warehouse-overview");
const revenueLedger = await import("@/lib/shopify/revenue-ledger");
const cacheOwners = await import("@/lib/user-facing-report-cache-owners");
const { syncShopifyCommerceReports, ensureShopifyProviderReady } = await import("@/lib/sync/shopify-sync");
const originalAppLogLevel = process.env.APP_LOG_LEVEL;

describe("syncShopifyCommerceReports", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.APP_LOG_LEVEL = "info";
    process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED = "false";
    delete process.env.SHOPIFY_HISTORICAL_SYNC_CHUNKS_PER_RUN;
    vi.mocked(admin.resolveShopifyAdminCredentials).mockResolvedValue({
      businessId: "biz_1",
      shopId: "test-shop.myshopify.com",
      accessToken: "shpat_test",
      scopes: "read_orders,read_all_orders,read_returns",
      metadata: { iana_timezone: "America/New_York" },
    });
    vi.mocked(syncState.getShopifySyncState).mockResolvedValue(null);
    vi.mocked(syncState.upsertShopifySyncState).mockResolvedValue(undefined);
    vi.mocked(integrations.mergeIntegrationMetadata).mockResolvedValue(undefined);
    vi.mocked(readAdapter.getShopifyOverviewReadCandidate).mockResolvedValue({
      preferredSource: "warehouse",
      canServeWarehouse: true,
      canaryEnabled: true,
      decisionReasons: ["warehouse_ready"],
      warehouse: {
        revenue: 999,
        purchases: 4,
      },
      ledger: {
        revenue: 998,
        purchases: 4,
      },
      live: {
        revenue: 997,
        purchases: 4,
      },
      divergence: {
        withinThreshold: true,
      },
      ledgerConsistency: {
        orderRevenueTruthDelta: 1,
        transactionRevenueDelta: 0,
      },
      servingMetadata: {
        productionMode: "auto",
        trustState: "trusted",
        fallbackReason: null,
        coverageStatus: "recent_ready",
        pendingRepair: false,
        pendingRepairStartedAt: null,
        pendingRepairLastTopic: null,
        pendingRepairLastReceivedAt: null,
        selectedRevenueTruthBasis: "warehouse",
        basisSelectionReason: "warehouse_consistent",
        transactionCoverageOrderRate: 1,
        transactionCoverageAmountRate: 1,
        explainedAdjustmentRevenue: 0,
        unexplainedAdjustmentRevenue: 0,
      },
      status: {
        state: "ready",
        serving: {
          consecutiveCleanValidations: 2,
          pendingRepair: false,
        },
        sync: {
          ordersRecent: {
            latestSuccessfulSyncAt: "2026-04-09T00:00:00.000Z",
            cursorTimestamp: "2026-04-09T00:00:00.000Z",
            cursorValue: "2026-04-09T00:00:00.000Z",
          },
          returnsRecent: {
            latestSuccessfulSyncAt: "2026-04-09T00:00:00.000Z",
            cursorTimestamp: "2026-04-09T00:00:00.000Z",
            cursorValue: "2026-04-09T00:00:00.000Z",
          },
          ordersHistorical: {
            latestSuccessfulSyncAt: "2026-04-09T00:00:00.000Z",
            readyThroughDate: "2026-04-09",
            historicalTargetEnd: "2026-04-09",
          },
          returnsHistorical: {
            latestSuccessfulSyncAt: "2026-04-09T00:00:00.000Z",
            readyThroughDate: "2026-04-09",
            historicalTargetEnd: "2026-04-09",
          },
        },
      },
    } as never);
    vi.mocked(overviewMaterializer.persistShopifyOverviewServingState).mockResolvedValue(
      undefined,
    );
    vi.mocked(overviewMaterializer.recordShopifyOverviewReconciliationRun).mockResolvedValue(
      undefined,
    );
    vi.mocked(shopifyStatus.getShopifyStatus).mockResolvedValue({
      state: "partial",
      issues: [],
    } as never);
    vi.mocked(webhooks.verifyShopifySyncWebhooks).mockResolvedValue({
      desiredTopics: ["ORDERS_CREATE"],
      existingTopics: ["ORDERS_CREATE"],
      missingTopics: [],
      extraTopics: [],
      callbackUrl: "https://app.example.com/api/webhooks/shopify/sync",
    } as never);
    vi.mocked(webhooks.registerShopifySyncWebhooks).mockResolvedValue({
      desiredTopics: ["ORDERS_CREATE"],
      existingTopics: ["ORDERS_CREATE"],
      missingTopics: [],
      extraTopics: [],
      created: [],
      callbackUrl: "https://app.example.com/api/webhooks/shopify/sync",
    } as never);
    vi.mocked(warehouseOverview.getShopifyWarehouseOverviewAggregate).mockResolvedValue({
      revenue: 999,
      grossRevenue: 1100,
      refundedRevenue: 101,
      purchases: 4,
      averageOrderValue: 275,
      daily: [],
    } as never);
    vi.mocked(revenueLedger.getShopifyRevenueLedgerAggregate).mockResolvedValue({
      revenue: 998,
      grossRevenue: 1100,
      refundedRevenue: 102,
      purchases: 4,
      averageOrderValue: 274.5,
      returnEvents: 2,
      daily: [],
      ledgerRows: 6,
    } as never);
    vi.mocked(commerceSync.syncShopifyOrdersWindow).mockResolvedValue({
      success: true,
      reason: "ok",
      orders: 4,
      orderLines: 7,
      refunds: 1,
      transactions: 4,
      pages: 1,
    } as never);
    vi.mocked(commerceSync.syncShopifyReturnsWindow).mockResolvedValue({
      success: true,
      reason: "ok",
      returns: 2,
      pages: 1,
      maxUpdatedAt: "2026-03-31T22:00:00Z",
    } as never);
    vi.mocked(cacheOwners.warmShopifyOverviewReportCache).mockResolvedValue({
      reportType: SHOPIFY_AUTOMATED_OVERVIEW_SNAPSHOT_REPORT_TYPE,
      wrote: true,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalAppLogLevel === undefined) {
      delete process.env.APP_LOG_LEVEL;
      return;
    }
    process.env.APP_LOG_LEVEL = originalAppLogLevel;
  });

  it("runs a bounded commerce sync and records sync state", async () => {
    const result = await syncShopifyCommerceReports("biz_1");

    expect(shouldAutoWarmShopifyOverviewSnapshot()).toBe(true);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        orders: 4,
        refunds: 1,
        returns: 2,
        historical: null,
        materialization: expect.objectContaining({
          trustState: "trusted",
          canServeWarehouse: true,
        }),
      })
    );
    expect(overviewMaterializer.persistShopifyOverviewServingState).toHaveBeenCalledTimes(1);
    expect(overviewMaterializer.recordShopifyOverviewReconciliationRun).toHaveBeenCalledTimes(1);
    expect(cacheOwners.warmShopifyOverviewReportCache).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        startDate: expect.any(String),
        endDate: expect.any(String),
        forceRefresh: true,
      })
    );
    expect(
      vi.mocked(cacheOwners.warmShopifyOverviewReportCache).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(readAdapter.getShopifyOverviewReadCandidate).mock.invocationCallOrder[0],
    );
    expect(syncState.upsertShopifySyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        syncTarget: "commerce_orders_recent",
        lastResultSummary: expect.objectContaining({
          warehouseShadow: expect.objectContaining({
            revenue: 999,
            purchases: 4,
          }),
        }),
      })
    );
    expect(commerceSync.syncShopifyOrdersWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
      })
    );
    expect(syncState.upsertShopifySyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        providerAccountId: "test-shop.myshopify.com",
        syncTarget: "commerce_orders_recent",
        latestSyncStatus: "running",
      })
    );
    expect(syncState.upsertShopifySyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        providerAccountId: "test-shop.myshopify.com",
        syncTarget: "commerce_returns_recent",
        latestSyncStatus: "running",
      })
    );
    expect(syncState.upsertShopifySyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        providerAccountId: "test-shop.myshopify.com",
        syncTarget: "commerce_orders_recent",
        latestSyncStatus: "succeeded",
      })
    );
    expect(syncState.upsertShopifySyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        providerAccountId: "test-shop.myshopify.com",
        syncTarget: "commerce_returns_recent",
        latestSyncStatus: "succeeded",
      })
    );
  });

  it("runs one historical chunk when enabled", async () => {
    process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED = "true";
    process.env.SHOPIFY_HISTORICAL_SYNC_CHUNKS_PER_RUN = "1";
    vi.mocked(syncState.getShopifySyncState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await syncShopifyCommerceReports("biz_1");

    expect(commerceSync.syncShopifyOrdersWindow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        businessId: "biz_1",
      })
    );
    expect(commerceSync.syncShopifyReturnsWindow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        businessId: "biz_1",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        historical: expect.objectContaining({
          orders: 4,
          returns: 2,
        }),
      })
    );
    expect(syncState.upsertShopifySyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        syncTarget: "commerce_orders_historical",
      })
    );
    delete process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED;
  });

  it("runs a bounded historical chunk by default when read_all_orders is available", async () => {
    delete process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED;
    delete process.env.SHOPIFY_HISTORICAL_SYNC_CHUNKS_PER_RUN;
    vi.mocked(syncState.getShopifySyncState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await syncShopifyCommerceReports("biz_1");

    expect(commerceSync.syncShopifyOrdersWindow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        businessId: "biz_1",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        historical: expect.objectContaining({
          chunks: 3,
          orders: 12,
          returns: 6,
        }),
      })
    );
  });

  it("does not block historical orders backfill when read_returns is unavailable", async () => {
    process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED = "true";
    process.env.SHOPIFY_HISTORICAL_SYNC_CHUNKS_PER_RUN = "1";
    vi.mocked(admin.resolveShopifyAdminCredentials).mockResolvedValue({
      businessId: "biz_1",
      shopId: "test-shop.myshopify.com",
      accessToken: "shpat_test",
      scopes: "read_orders,read_all_orders",
      metadata: { iana_timezone: "America/New_York" },
    });
    vi.mocked(syncState.getShopifySyncState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await syncShopifyCommerceReports("biz_1");

    expect(commerceSync.syncShopifyOrdersWindow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        queryField: "created_at",
      })
    );
    expect(commerceSync.syncShopifyReturnsWindow).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        historical: expect.objectContaining({
          orders: 4,
          returns: 0,
          returnPages: 0,
        }),
      })
    );
    expect(syncState.upsertShopifySyncState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        syncTarget: "commerce_returns_historical",
        latestSyncStatus: "running",
      })
    );
  });

  it("can catch up historical returns after historical orders have reached the target", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
    process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED = "true";
    process.env.SHOPIFY_HISTORICAL_SYNC_CHUNKS_PER_RUN = "1";
    vi.mocked(syncState.getShopifySyncState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        cursorValue: "2026-04-20",
        readyThroughDate: "2026-04-20",
        historicalTargetEnd: "2026-04-20",
      } as never)
      .mockResolvedValueOnce(null);

    const result = await syncShopifyCommerceReports("biz_1");

    expect(commerceSync.syncShopifyOrdersWindow).toHaveBeenCalledTimes(1);
    expect(commerceSync.syncShopifyReturnsWindow).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        historical: expect.objectContaining({
          orders: 0,
          returns: 2,
          pages: 0,
          returnPages: 1,
        }),
      })
    );
    expect(syncState.upsertShopifySyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        syncTarget: "commerce_returns_historical",
        latestSyncStatus: "running",
      })
    );
  });

  it("can skip overview materialization for call sites that must stay lightweight", async () => {
    expect(shouldAutoWarmShopifyOverviewSnapshot({ materializeOverviewState: false })).toBe(false);

    const result = await syncShopifyCommerceReports("biz_1", {
      materializeOverviewState: false,
      allowHistorical: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        materialization: expect.objectContaining({
          skipped: true,
          reason: "disabled_for_call_site",
        }),
      }),
    );
    expect(overviewMaterializer.persistShopifyOverviewServingState).not.toHaveBeenCalled();
    expect(overviewMaterializer.recordShopifyOverviewReconciliationRun).not.toHaveBeenCalled();
    expect(cacheOwners.warmShopifyOverviewReportCache).not.toHaveBeenCalled();
  });

  it("keeps lightweight webhook-triggered sync paths out of overview materialization and snapshot warming", async () => {
    process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED = "true";
    expect(shouldAutoWarmShopifyOverviewSnapshot({ materializeOverviewState: false })).toBe(false);

    const result = await syncShopifyCommerceReports("biz_1", {
      recentWindowDays: 3,
      triggerReason: "webhook:orders:update",
      recentTargets: {
        orders: true,
        returns: false,
      },
      allowHistorical: false,
      materializeOverviewState: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        returns: 0,
        historical: null,
        materialization: expect.objectContaining({
          skipped: true,
          reason: "disabled_for_call_site",
        }),
        reconciliation: expect.objectContaining({
          triggerReason: "webhook:orders:update",
          recentTargets: {
            orders: true,
            returns: false,
          },
          historicalTriggered: false,
        }),
      })
    );
    expect(commerceSync.syncShopifyReturnsWindow).not.toHaveBeenCalled();
    expect(syncState.upsertShopifySyncState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        syncTarget: "commerce_returns_recent",
        latestSyncStatus: "running",
      })
    );
    expect(syncState.upsertShopifySyncState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        syncTarget: "commerce_orders_historical",
      })
    );
    expect(overviewMaterializer.persistShopifyOverviewServingState).not.toHaveBeenCalled();
    expect(overviewMaterializer.recordShopifyOverviewReconciliationRun).not.toHaveBeenCalled();
    expect(cacheOwners.warmShopifyOverviewReportCache).not.toHaveBeenCalled();
    delete process.env.SHOPIFY_HISTORICAL_SYNC_ENABLED;
  });

  it("emits runtime-validation phase markers for the recent orders sub-flow", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(commerceSync.syncShopifyOrdersWindow).mockImplementation(async (input) => {
      input.runtimeValidationLog?.("recent_orders_source_fetch_started", {
        pageCount: 1,
        cursorPresent: false,
      });
      input.runtimeValidationLog?.("recent_orders_upsert_succeeded", {
        pageCount: 1,
        ordersWritten: 4,
      });
      return {
        success: true,
        reason: "ok",
        orders: 4,
        orderLines: 7,
        refunds: 1,
        transactions: 4,
        pages: 1,
        maxUpdatedAt: "2026-03-31T22:00:00Z",
      } as never;
    });

    await syncShopifyCommerceReports("biz_1", {
      allowHistorical: false,
      materializeOverviewState: false,
      triggerReason: "runtime_validation",
      runtimeValidationRunId: "shopify_rtval_test",
      recentTargets: {
        orders: true,
        returns: false,
      },
    });

    expect(commerceSync.syncShopifyOrdersWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeValidationRunId: "shopify_rtval_test",
        runtimeValidationLog: expect.any(Function),
      }),
    );

    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "recent_orders_phase_started",
        summary: expect.objectContaining({
          queryField: "updated_at",
        }),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "recent_orders_source_fetch_started",
        summary: expect.objectContaining({
          pageCount: 1,
        }),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "recent_orders_cursor_or_state_persist_succeeded",
        summary: expect.objectContaining({
          maxUpdatedAt: "2026-03-31T22:00:00Z",
        }),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "recent_orders_cursor_persist_succeeded",
        summary: expect.objectContaining({
          cursorValue: "2026-03-31T22:00:00Z",
        }),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "recent_orders_state_persist_succeeded",
        summary: expect.objectContaining({
          syncTarget: "commerce_orders_recent",
        }),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "recent_orders_phase_completed",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "transition_to_post_recent_path_started",
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "[shopify-sync] runtime_validation_phase",
      expect.objectContaining({
        businessId: "biz_1",
        phase: "transition_to_shadow_started",
      }),
    );

    infoSpy.mockRestore();
  });

  it("refuses to MUTATE webhooks when the Shopify grant moved mid-pass", async () => {
    // `credentials` is resolved at the top of a long readiness pass; everything
    // after it is provider round trips and warehouse writes. A reconnect inside
    // that window used to leave this registering webhooks under a credential
    // that had already been replaced, pointing another shop's order events at
    // this business.
    const connected = (over: Record<string, unknown>) => ({
      id: "int-shopify",
      business_id: "biz_1",
      provider: "shopify",
      status: "connected",
      provider_account_id: "test-shop.myshopify.com",
      access_token: "shpat_test",
      connection_generation: 4,
      metadata: {},
      ...over,
    });
    vi.mocked(integrations.getIntegration)
      // The pass starts under generation 4...
      .mockResolvedValueOnce(connected({}) as never)
      // ...and a reconnect as a different shop lands before the webhook calls.
      .mockResolvedValue(
        connected({
          provider_account_id: "someone-elses-shop.myshopify.com",
          access_token: "shpat_someone_else",
          connection_generation: 9,
        }) as never,
      );

    const result = await ensureShopifyProviderReady({
      businessId: "biz_1",
      recentWindowDays: 30,
      preferredVisibleWindowDays: 90,
      runHistoricalBootstrap: false,
      triggerReason: "admin:run_recent_bootstrap",
    });

    // Zero provider mutations, and zero provider reads under the stale token.
    expect(webhooks.registerShopifySyncWebhooks).not.toHaveBeenCalled();
    expect(webhooks.verifyShopifySyncWebhooks).not.toHaveBeenCalled();
    // The refusal is recorded rather than swallowed...
    expect(integrations.mergeIntegrationMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          shopifyProviderReadiness: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                step: "webhooks_verify",
                status: "failed",
              }),
            ]),
          }),
        }),
      }),
    );
    // ...and the rest of the pass, which resolves its own credential, still runs.
    expect(result.webhookCoverage).toBeNull();
  });

  it("refuses when the Shopify connection cannot be read at all", async () => {
    // "I could not tell" must not read as "unchanged": that would restore the
    // unbound behaviour exactly when the database is the thing misbehaving.
    vi.mocked(integrations.getIntegration).mockRejectedValue(new Error("db down"));

    await ensureShopifyProviderReady({
      businessId: "biz_1",
      recentWindowDays: 30,
      preferredVisibleWindowDays: 90,
      runHistoricalBootstrap: false,
      triggerReason: "admin:run_recent_bootstrap",
    });

    expect(webhooks.registerShopifySyncWebhooks).not.toHaveBeenCalled();
    expect(webhooks.verifyShopifySyncWebhooks).not.toHaveBeenCalled();
  });

  it("orchestrates provider readiness and persists readiness summary", async () => {
    const result = await ensureShopifyProviderReady({
      businessId: "biz_1",
      recentWindowDays: 30,
      preferredVisibleWindowDays: 90,
      runHistoricalBootstrap: false,
      triggerReason: "admin:run_recent_bootstrap",
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        servingWindow: expect.objectContaining({
          startDate: expect.any(String),
          endDate: expect.any(String),
        }),
      })
    );
    expect(webhooks.verifyShopifySyncWebhooks).toHaveBeenCalled();
    expect(webhooks.registerShopifySyncWebhooks).toHaveBeenCalled();
    expect(readAdapter.getShopifyOverviewReadCandidate).toHaveBeenCalled();
    expect(integrations.mergeIntegrationMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        provider: "shopify",
        metadata: expect.objectContaining({
          shopifyProviderReadiness: expect.objectContaining({
            recentWindowDays: 30,
            visibleWindowDays: 90,
          }),
        }),
      })
    );
    expect(commerceSync.syncShopifyOrdersWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
      })
    );
    expect(commerceSync.syncShopifyReturnsWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
      })
    );
  });

  it("logs and continues when overview snapshot warming fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(cacheOwners.warmShopifyOverviewReportCache).mockRejectedValue(
      new Error("snapshot warm failed"),
    );

    const result = await syncShopifyCommerceReports("biz_1");

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        materialization: expect.objectContaining({
          canServeWarehouse: false,
          reason: "snapshot warm failed",
        }),
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[shopify-sync] overview_snapshot_or_materialization_failed",
      expect.objectContaining({
        businessId: "biz_1",
      }),
    );
    expect(overviewMaterializer.persistShopifyOverviewServingState).not.toHaveBeenCalled();
    expect(overviewMaterializer.recordShopifyOverviewReconciliationRun).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
