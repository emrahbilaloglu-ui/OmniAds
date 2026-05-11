import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleAdsAccountDailyAuditPayload,
  buildGoogleAdsLaneAdmissionPolicy,
  buildGoogleAdsPrimaryLeasePlan,
  buildGoogleAdsMaintenanceLeasePlan,
  buildGoogleAdsFallbackExtendedLeasePlan,
  buildGoogleAdsLaneProgressEvidence,
  decideGoogleAdsHistoricalFrontier,
  resolveGoogleAdsHistoricalReplayStart,
  getGoogleAdsExtendedRecoveryBlockReason,
  getGoogleAdsHistoricalFairnessLeaseLimit,
  getGoogleAdsGapPlannerBlockingStatuses,
  hasGoogleAdsInProcessBackgroundWorkerIdentity,
  getGoogleAdsWarehouseFetchFailureReason,
  buildGoogleAdsWarehouseFetchPlan,
  classifyGoogleAdsQueuedCampaignDailyPartition,
  canReuseExistingGoogleAdsSyncJob,
  evaluateGoogleAdsWorkerSchedulingState,
  getGoogleAdsScopeCheckpointChunkSize,
  logGoogleAdsLeaseStepResult,
  logGoogleAdsPhaseTelemetry,
  shouldRetryGoogleAdsEmptyCampaignDaily,
  shouldBlockGoogleAdsHistoricalExtendedWork,
  shouldAllowGoogleAdsPriorityHistoricalReplay,
  shouldLeaseGoogleAdsRecentRepair,
  summarizeGoogleAdsIntegrityIncidents,
  planGoogleAdsRecentMaintenanceDates,
  getGoogleAdsCoveredRecentMaintenanceDatesToCancel,
  getGoogleAdsD1FinalizeScopesToQueue,
  resolveGoogleAdsCoveredD1FinalizeResolution,
  resolveGoogleAdsWorkerRequestedLimit,
  getGoogleAdsCoveredCorePartitionDatesToCancel,
  normalizeGoogleAdsPartitionDateKey,
  resolveGoogleAdsFullSyncPriorityFromStateRows,
} from "@/lib/sync/google-ads-sync";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hasGoogleAdsInProcessBackgroundWorkerIdentity", () => {
  it("requires an explicit tracked worker id", () => {
    expect(
      hasGoogleAdsInProcessBackgroundWorkerIdentity({
        NODE_ENV: "development",
        SYNC_WORKER_MODE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      hasGoogleAdsInProcessBackgroundWorkerIdentity({
        GOOGLE_ADS_WORKER_ID: "google-repair:biz-1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      hasGoogleAdsInProcessBackgroundWorkerIdentity({
        WORKER_INSTANCE_ID: "worker-1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("getGoogleAdsCoveredCorePartitionDatesToCancel", () => {
  it("normalizes database date values using local date fields instead of UTC shifts", () => {
    expect(normalizeGoogleAdsPartitionDateKey(new Date(2026, 4, 2))).toBe(
      "2026-05-02",
    );
  });

  it("returns only queued core dates already covered by canonical warehouse data", () => {
    expect(
      getGoogleAdsCoveredCorePartitionDatesToCancel({
        partitionDates: ["2026-05-01", "2026-05-02", "2026-05-02"],
        coveredDates: ["2026-05-02", "2026-05-03"],
      }),
    ).toEqual(["2026-05-02"]);
  });
});

describe("resolveGoogleAdsFullSyncPriorityFromStateRows", () => {
  it("derives priority scopes from sync-state rows without scanning warehouse tables", () => {
    expect(
      resolveGoogleAdsFullSyncPriorityFromStateRows({
        totalDays: 10,
        rows: [
          { scope: "search_term_daily", completed_days: 10 },
          { scope: "product_daily", completed_days: 8 },
          { scope: "asset_daily", completed_days: 2 },
        ],
      }),
    ).toEqual({
      required: true,
      targetScopes: ["product_daily", "asset_daily"],
    });
  });

  it("falls back when sync-state rows do not cover every priority scope", () => {
    expect(
      resolveGoogleAdsFullSyncPriorityFromStateRows({
        totalDays: 10,
        rows: [
          { scope: "search_term_daily", completed_days: 10 },
          { scope: "product_daily", completed_days: 10 },
        ],
      }),
    ).toBeNull();
  });
});

describe("buildGoogleAdsLaneAdmissionPolicy", () => {
  it("admits extended lanes by default when runtime safety guards allow them", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 0,
      extendedQueueDepth: 0,
      extendedBudgetAllowed: true,
    });

    expect(policy.lanePolicy.extended).toBe("admit");
    expect(policy.lanePolicy.extendedHistorical).toBe("admit");
    expect(policy.extendedCanaryEligible).toBe(true);
  });

  it("suspends extended lanes when safe mode is enabled", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: true,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 0,
      extendedQueueDepth: 0,
    });

    expect(policy.lanePolicy.core).toBe("admit");
    expect(policy.lanePolicy.maintenance).toBe("admit");
    expect(policy.lanePolicy.extended).toBe("suspended");
    expect(policy.suspendExtended).toBe(true);
  });

  it("suspends extended lanes when the global breaker is open", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: true,
      queueDepth: 10,
      extendedQueueDepth: 10,
    });

    expect(policy.lanePolicy.extended).toBe("suspended");
    expect(policy.suspendExtended).toBe(true);
  });

  it("suspends extended lanes when worker health is missing", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: false,
      workerCapacityAvailable: false,
      breakerOpen: false,
      queueDepth: 5,
      extendedQueueDepth: 2,
    });

    expect(policy.lanePolicy.extended).toBe("suspended");
    expect(policy.lanePolicy.core).toBe("admit");
  });

  it("keeps extended lanes eligible to drain when backlog exceeds the hard limit", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 3000,
      extendedQueueDepth: 1500,
    });

    expect(policy.lanePolicy.extended).toBe("admit");
    expect(policy.lanePolicy.extendedHistorical).toBe("admit");
  });

  it("keeps extended suspended when global reopen is not allowed", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 0,
      extendedQueueDepth: 0,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: false,
    });

    expect(policy.lanePolicy.extended).toBe("suspended");
  });

  it("allows only recent extended recovery while breaker is half-open", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 0,
      extendedQueueDepth: 0,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "half_open",
      quotaPressure: 0.2,
    });

    expect(policy.lanePolicy.extendedRecent).toBe("admit");
    expect(policy.lanePolicy.extendedHistorical).toBe("suspended");
    expect(policy.executionMode).toBe("extended_recovery");
  });

  it("admits historical extended replay only after recovery closes", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 0,
      extendedQueueDepth: 0,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
      quotaPressure: 0.2,
    });

    expect(policy.lanePolicy.extendedRecent).toBe("admit");
    expect(policy.lanePolicy.extendedHistorical).toBe("admit");
    expect(policy.executionMode).toBe("extended_normal");
  });

  it("suspends maintenance when quota budget is exhausted", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 0,
      extendedQueueDepth: 0,
      quotaPressure: 1.05,
      maintenanceBudgetAllowed: false,
      extendedBudgetAllowed: false,
      extendedCanaryEligible: true,
    });

    expect(policy.lanePolicy.core).toBe("admit");
    expect(policy.lanePolicy.maintenance).toBe("suspended");
  });
});

describe("buildGoogleAdsWarehouseFetchPlan", () => {
  it("does not require campaign fetches for search-term-only partitions", () => {
    const plan = buildGoogleAdsWarehouseFetchPlan(["search_term_daily"]);

    expect(plan.searchIntelligence).toBe(true);
    expect(plan.campaigns).toBe(false);
    expect(plan.products).toBe(false);
    expect(plan.assets).toBe(false);
  });

  it("keeps product and asset partitions isolated to their own report families", () => {
    const productPlan = buildGoogleAdsWarehouseFetchPlan(["product_daily"]);
    const assetPlan = buildGoogleAdsWarehouseFetchPlan(["asset_daily"]);

    expect(productPlan.products).toBe(true);
    expect(productPlan.campaigns).toBe(false);
    expect(productPlan.assets).toBe(false);
    expect(assetPlan.assets).toBe(true);
    expect(assetPlan.campaigns).toBe(false);
    expect(assetPlan.products).toBe(false);
  });

  it("does not require account or campaign as the primary sync scope for product and asset repairs", () => {
    const productPlan = buildGoogleAdsWarehouseFetchPlan(["product_daily"]);
    const assetPlan = buildGoogleAdsWarehouseFetchPlan(["asset_daily"]);

    expect(productPlan.products).toBe(true);
    expect(productPlan.campaigns).toBe(false);
    expect(assetPlan.assets).toBe(true);
    expect(assetPlan.campaigns).toBe(false);
  });
});

describe("canReuseExistingGoogleAdsSyncJob", () => {
  it("reuses an existing running repair-window job", () => {
    expect(
      canReuseExistingGoogleAdsSyncJob({
        syncType: "repair_window",
        triggerSource: "manual_targeted_repair:campaign_daily",
      }),
    ).toBe(true);
  });

  it("does not reuse ordinary background jobs", () => {
    expect(
      canReuseExistingGoogleAdsSyncJob({
        syncType: "incremental_recent",
        triggerSource: "background_recent",
      }),
    ).toBe(false);
  });
});

describe("Google Ads throughput telemetry", () => {
  it("uses smaller checkpoint chunks for campaign and geo scopes", () => {
    expect(getGoogleAdsScopeCheckpointChunkSize("campaign_daily")).toBeLessThan(
      getGoogleAdsScopeCheckpointChunkSize("account_daily"),
    );
    expect(getGoogleAdsScopeCheckpointChunkSize("geo_daily")).toBeLessThan(
      getGoogleAdsScopeCheckpointChunkSize("account_daily"),
    );
  });

  it("uses the measured product checkpoint chunk for DB-bound backfill", () => {
    expect(getGoogleAdsScopeCheckpointChunkSize("product_daily")).toBeGreaterThan(
      getGoogleAdsScopeCheckpointChunkSize("account_daily"),
    );
  });

  it("emits structured phase telemetry with campaign batch metrics", () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    logGoogleAdsPhaseTelemetry({
      businessId: "business-1",
      providerAccountId: "acct-1",
      date: "2026-04-04",
      primaryScope: "campaign_daily",
      fetchMs: 100,
      transformMs: 20,
      persistMs: 30,
      finalizeMs: 10,
      totalMs: 160,
      scopeMetrics: [
        {
          scope: "campaign_daily",
          rowCount: 120,
          batchCount: 1,
          chunkSize: getGoogleAdsScopeCheckpointChunkSize("campaign_daily"),
          persistedRowCount: 120,
          durationMs: 30,
        },
      ],
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[google-ads-sync] google_ads_scope_phase_metrics",
      expect.objectContaining({
        businessId: "business-1",
        primaryScope: "campaign_daily",
        scopeMetrics: [
          expect.objectContaining({
            scope: "campaign_daily",
            rowCount: 120,
          }),
        ],
      }),
    );
  });
});

describe("shouldRetryGoogleAdsEmptyCampaignDaily", () => {
  it("retries when account summary has activity but campaign rows are empty", () => {
    expect(
      shouldRetryGoogleAdsEmptyCampaignDaily({
        overview: {
          spend: 12.5,
          revenue: 0,
          conversions: 0,
          impressions: 100,
          clicks: 5,
        },
        campaignRowCount: 0,
      }),
    ).toBe(true);
  });

  it("does not retry when overview is empty", () => {
    expect(
      shouldRetryGoogleAdsEmptyCampaignDaily({
        overview: {
          spend: 0,
          revenue: 0,
          conversions: 0,
          impressions: 0,
          clicks: 0,
        },
        campaignRowCount: 0,
      }),
    ).toBe(false);
  });

  it("does not retry when campaign rows exist", () => {
    expect(
      shouldRetryGoogleAdsEmptyCampaignDaily({
        overview: {
          spend: 12.5,
          revenue: 0,
          conversions: 0,
          impressions: 100,
          clicks: 5,
        },
        campaignRowCount: 2,
      }),
    ).toBe(false);
  });
});

describe("getGoogleAdsWarehouseFetchFailureReason", () => {
  it("treats failed zero-row warehouse fetches as retryable blockers", () => {
    expect(
      getGoogleAdsWarehouseFetchFailureReason({
        scope: "search_term_daily",
        report: {
          rows: [],
          meta: {
            query_names: ["search_term_core"],
            row_counts: { search_term_core: 0 },
            failed_queries: [
              {
                query: "search_term_core",
                family: "search_term_core",
                customerId: "180-473-3335",
                message: "This operation was aborted",
                severity: "optional",
                category: "unknown",
              },
            ],
          },
        },
      }),
    ).toContain("google_ads_search_term_daily_fetch_failed");
  });

  it("allows product fallback when the legacy product query completed", () => {
    expect(
      getGoogleAdsWarehouseFetchFailureReason({
        scope: "product_daily",
        report: {
          rows: [],
          meta: {
            query_names: ["product_performance", "product_performance_legacy"],
            row_counts: {
              product_performance: 0,
              product_performance_legacy: 0,
            },
            failed_queries: [
              {
                query: "product_performance",
                family: "product_core",
                customerId: "180-473-3335",
                message: "metric cannot be requested",
                severity: "optional",
                category: "unavailable_metric",
              },
            ],
          },
        },
      }),
    ).toBeNull();
  });

  it("does not block optional metric failures when canonical rows were fetched", () => {
    expect(
      getGoogleAdsWarehouseFetchFailureReason({
        scope: "campaign_daily",
        report: {
          rows: [{ id: "campaign-1" }],
          meta: {
            query_names: ["campaign_core_basic", "campaign_share"],
            row_counts: {
              campaign_core_basic: 1,
              campaign_share: 0,
            },
            failed_queries: [
              {
                query: "campaign_share",
                family: "campaign_share",
                customerId: "180-473-3335",
                message: "metric unavailable",
                severity: "optional",
                category: "unavailable_metric",
              },
            ],
          },
        },
      }),
    ).toBeNull();
  });
});

describe("buildGoogleAdsAccountDailyAuditPayload", () => {
  it("marks account_daily as campaign-rollup canonical when metrics align", () => {
    expect(
      buildGoogleAdsAccountDailyAuditPayload({
        canonicalMetrics: {
          spend: 12.5,
          revenue: 30,
          conversions: 2,
          impressions: 100,
          clicks: 10,
        },
        referenceOverview: {
          spend: 12.5,
          revenue: 30,
          conversions: 2,
          impressions: 100,
          clicks: 10,
        },
        campaignRowCount: 3,
      }),
    ).toEqual(
      expect.objectContaining({
        canonicalSource: "campaign_rollup",
        campaignRowCount: 3,
        integrityStatus: "verified",
        overviewDelta: expect.objectContaining({
          spend: 0,
          impressions: 0,
          clicks: 0,
        }),
      }),
    );
  });

  it("flags mismatches when reference metrics diverge from campaign rollups", () => {
    expect(
      buildGoogleAdsAccountDailyAuditPayload({
        canonicalMetrics: {
          spend: 12.5,
          revenue: 30,
          conversions: 2,
          impressions: 100,
          clicks: 10,
        },
        referenceOverview: {
          spend: 1,
          revenue: 5,
          conversions: 1,
          impressions: 10,
          clicks: 1,
        },
        campaignRowCount: 2,
      }).integrityStatus,
    ).toBe("mismatch");
  });
});

describe("summarizeGoogleAdsIntegrityIncidents", () => {
  it("deduplicates mismatch dates and account ids", () => {
    expect(
      summarizeGoogleAdsIntegrityIncidents([
        { providerAccountId: "acc-1", date: "2026-04-01" },
        { providerAccountId: "acc-1", date: "2026-04-01" },
        { providerAccountId: "acc-2", date: "2026-04-02" },
      ]),
    ).toEqual({
      incidentCount: 3,
      mismatchDates: ["2026-04-01", "2026-04-02"],
      providerAccountIds: ["acc-1", "acc-2"],
    });
  });
});

describe("Google Ads lease step telemetry", () => {
  it("emits structured lease attempt telemetry", () => {
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    logGoogleAdsLeaseStepResult({
      businessId: "business-1",
      step: "maintenance",
      limit: 2,
      lane: "maintenance",
      leasedCount: 0,
      queueHealth: {
        coreQueueDepth: 0,
        maintenanceQueueDepth: 9,
        leasedPartitions: 0,
      },
      fullSyncPriorityRequired: false,
      historicalLeaseStartDate: "2026-01-01",
      policy: {
        suspendMaintenance: true,
        suspendExtended: false,
      },
      budgetState: {
        pressure: 1,
        maintenanceAllowed: false,
        extendedAllowed: true,
      },
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "[google-ads-sync] google_ads_lease_step_result",
      expect.objectContaining({
        businessId: "business-1",
        step: "maintenance",
        leasedCount: 0,
        queueHealth: expect.objectContaining({
          maintenanceQueueDepth: 9,
        }),
      }),
    );
  });
});

describe("Google Ads leaseable backlog classification", () => {
  it("classifies future retry rows as retry_cooldown", () => {
    expect(
      classifyGoogleAdsQueuedCampaignDailyPartition({
        row: {
          lane: "maintenance",
          partitionDate: "2026-01-10",
          nextRetryAt: "2026-04-06T00:00:00.000Z",
        },
        frontierStart: "2026-01-04",
        suspendMaintenance: true,
        now: new Date("2026-04-05T00:00:00.000Z"),
      }),
    ).toBe("retry_cooldown");
  });

  it("classifies stale core rows before the frontier as outside_frontier", () => {
    expect(
      classifyGoogleAdsQueuedCampaignDailyPartition({
        row: {
          lane: "core",
          partitionDate: "2026-01-01",
          nextRetryAt: null,
        },
        frontierStart: "2026-01-04",
        suspendMaintenance: false,
        now: new Date("2026-04-05T00:00:00.000Z"),
      }),
    ).toBe("outside_frontier");
  });

  it("classifies queued maintenance rows under suspension as suspended_maintenance", () => {
    expect(
      classifyGoogleAdsQueuedCampaignDailyPartition({
        row: {
          lane: "maintenance",
          partitionDate: "2026-04-03",
          nextRetryAt: null,
        },
        frontierStart: "2026-01-04",
        suspendMaintenance: true,
        now: new Date("2026-04-05T00:00:00.000Z"),
      }),
    ).toBe("suspended_maintenance");
  });

  it("classifies in-frontier core rows without cooldown as leaseable_now", () => {
    expect(
      classifyGoogleAdsQueuedCampaignDailyPartition({
        row: {
          lane: "core",
          partitionDate: "2026-01-04",
          nextRetryAt: null,
        },
        frontierStart: "2026-01-04",
        suspendMaintenance: false,
        now: new Date("2026-04-05T00:00:00.000Z"),
      }),
    ).toBe("leaseable_now");
  });
});

describe("decideGoogleAdsHistoricalFrontier", () => {
  it("holds older-than-90 daily history until the recent frontier is complete", () => {
    expect(
      decideGoogleAdsHistoricalFrontier({
        historicalStart: "2024-01-01",
        recent90Start: "2025-12-02",
        recent90Complete: false,
      }),
    ).toBe("2025-12-02");

    expect(
      decideGoogleAdsHistoricalFrontier({
        historicalStart: "2024-01-01",
        recent90Start: "2025-12-02",
        recent90Complete: true,
      }),
    ).toBe("2024-01-01");
  });
});

describe("shouldBlockGoogleAdsHistoricalExtendedWork", () => {
  it("blocks historical extended work until the recent 90-day frontier is complete", () => {
    expect(
      shouldBlockGoogleAdsHistoricalExtendedWork({
        recent90Complete: false,
      }),
    ).toBe(true);

    expect(
      shouldBlockGoogleAdsHistoricalExtendedWork({
        recent90Complete: true,
      }),
    ).toBe(false);
  });
});

describe("getGoogleAdsExtendedRecoveryBlockReason", () => {
  it("does not blame queued maintenance when maintenance is not actively leased", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 20,
      extendedQueueDepth: 12,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    const reason = getGoogleAdsExtendedRecoveryBlockReason({
      policy,
      queueHealth: {
        queueDepth: 20,
        leasedPartitions: 0,
        coreQueueDepth: 0,
        coreLeasedPartitions: 0,
        extendedQueueDepth: 12,
        extendedLeasedPartitions: 0,
        extendedRecentQueueDepth: 12,
        extendedRecentLeasedPartitions: 0,
        extendedHistoricalQueueDepth: 0,
        extendedHistoricalLeasedPartitions: 0,
        maintenanceQueueDepth: 4,
        maintenanceLeasedPartitions: 0,
        retryableFailedPartitions: 0,
        deadLetterPartitions: 0,
        blockingDeadLetterPartitions: 0,
        quarantinedHistoricalDeadLetterPartitions: 0,
        actionRequiredDeadLetterPartitions: 0,
        actionRequiredBlockingDeadLetterPartitions: 0,
        actionRequiredDeadLetterScopes: [],
        actionRequiredBlockingDeadLetterScopes: [],
        coreBlockingDeadLetterPartitions: 0,
        coreActionRequiredBlockingDeadLetterPartitions: 0,
        replayableDeadLetterPartitions: 0,
        replayableBlockingDeadLetterPartitions: 0,
        unknownDeadLetterPartitions: 0,
        unknownBlockingDeadLetterPartitions: 0,
        oldestQueuedPartition: "2026-03-20",
        latestCoreActivityAt: null,
        latestExtendedActivityAt: null,
        latestMaintenanceActivityAt: null,
      },
    });

    expect(reason).toBe("queue_exists_without_eligible_lease");
  });

  it("explains when recent extended queue exists but is not leasing", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 20,
      extendedQueueDepth: 12,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    const reason = getGoogleAdsExtendedRecoveryBlockReason({
      policy,
      queueHealth: {
        queueDepth: 20,
        leasedPartitions: 0,
        coreQueueDepth: 0,
        coreLeasedPartitions: 0,
        extendedQueueDepth: 12,
        extendedLeasedPartitions: 0,
        extendedRecentQueueDepth: 12,
        extendedRecentLeasedPartitions: 0,
        extendedHistoricalQueueDepth: 0,
        extendedHistoricalLeasedPartitions: 0,
        maintenanceQueueDepth: 0,
        maintenanceLeasedPartitions: 0,
        retryableFailedPartitions: 0,
        deadLetterPartitions: 0,
        blockingDeadLetterPartitions: 0,
        quarantinedHistoricalDeadLetterPartitions: 0,
        actionRequiredDeadLetterPartitions: 0,
        actionRequiredBlockingDeadLetterPartitions: 0,
        actionRequiredDeadLetterScopes: [],
        actionRequiredBlockingDeadLetterScopes: [],
        coreBlockingDeadLetterPartitions: 0,
        coreActionRequiredBlockingDeadLetterPartitions: 0,
        replayableDeadLetterPartitions: 0,
        replayableBlockingDeadLetterPartitions: 0,
        unknownDeadLetterPartitions: 0,
        unknownBlockingDeadLetterPartitions: 0,
        oldestQueuedPartition: "2026-03-20",
        latestCoreActivityAt: null,
        latestExtendedActivityAt: null,
        latestMaintenanceActivityAt: null,
      },
    });

    expect(reason).toBe("queue_exists_without_eligible_lease");
  });

  it("surfaces core starvation when recent extended work is queued behind core leases", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 20,
      extendedQueueDepth: 12,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    const reason = getGoogleAdsExtendedRecoveryBlockReason({
      policy,
      queueHealth: {
        queueDepth: 20,
        leasedPartitions: 1,
        coreQueueDepth: 2,
        coreLeasedPartitions: 1,
        extendedQueueDepth: 12,
        extendedLeasedPartitions: 0,
        extendedRecentQueueDepth: 12,
        extendedRecentLeasedPartitions: 0,
        extendedHistoricalQueueDepth: 0,
        extendedHistoricalLeasedPartitions: 0,
        maintenanceQueueDepth: 0,
        maintenanceLeasedPartitions: 0,
        retryableFailedPartitions: 0,
        deadLetterPartitions: 0,
        blockingDeadLetterPartitions: 0,
        quarantinedHistoricalDeadLetterPartitions: 0,
        actionRequiredDeadLetterPartitions: 0,
        actionRequiredBlockingDeadLetterPartitions: 0,
        actionRequiredDeadLetterScopes: [],
        actionRequiredBlockingDeadLetterScopes: [],
        coreBlockingDeadLetterPartitions: 0,
        coreActionRequiredBlockingDeadLetterPartitions: 0,
        replayableDeadLetterPartitions: 0,
        replayableBlockingDeadLetterPartitions: 0,
        unknownDeadLetterPartitions: 0,
        unknownBlockingDeadLetterPartitions: 0,
        oldestQueuedPartition: "2026-03-20",
        latestCoreActivityAt: null,
        latestExtendedActivityAt: null,
        latestMaintenanceActivityAt: null,
      },
    });

    expect(reason).toBe("core_starvation");
  });

  it("surfaces maintenance replay pressure when recent extended work is queued behind maintenance leases", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 20,
      extendedQueueDepth: 12,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    const reason = getGoogleAdsExtendedRecoveryBlockReason({
      policy,
      queueHealth: {
        queueDepth: 20,
        leasedPartitions: 1,
        coreQueueDepth: 0,
        coreLeasedPartitions: 0,
        extendedQueueDepth: 12,
        extendedLeasedPartitions: 0,
        extendedRecentQueueDepth: 12,
        extendedRecentLeasedPartitions: 0,
        extendedHistoricalQueueDepth: 0,
        extendedHistoricalLeasedPartitions: 0,
        maintenanceQueueDepth: 4,
        maintenanceLeasedPartitions: 1,
        retryableFailedPartitions: 0,
        deadLetterPartitions: 0,
        blockingDeadLetterPartitions: 0,
        quarantinedHistoricalDeadLetterPartitions: 0,
        actionRequiredDeadLetterPartitions: 0,
        actionRequiredBlockingDeadLetterPartitions: 0,
        actionRequiredDeadLetterScopes: [],
        actionRequiredBlockingDeadLetterScopes: [],
        coreBlockingDeadLetterPartitions: 0,
        coreActionRequiredBlockingDeadLetterPartitions: 0,
        replayableDeadLetterPartitions: 0,
        replayableBlockingDeadLetterPartitions: 0,
        unknownDeadLetterPartitions: 0,
        unknownBlockingDeadLetterPartitions: 0,
        oldestQueuedPartition: "2026-03-20",
        latestCoreActivityAt: null,
        latestExtendedActivityAt: null,
        latestMaintenanceActivityAt: null,
      },
    });

    expect(reason).toBe("maintenance_replay_pressure");
  });
});

describe("shouldLeaseGoogleAdsRecentRepair", () => {
  it("allows bounded recent repair leasing even when core work still exists", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 25,
      extendedQueueDepth: 8,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    expect(
      shouldLeaseGoogleAdsRecentRepair({
        policy,
        queueHealth: {
          queueDepth: 25,
          leasedPartitions: 2,
          coreQueueDepth: 4,
          coreLeasedPartitions: 2,
          extendedQueueDepth: 8,
          extendedLeasedPartitions: 0,
          extendedRecentQueueDepth: 8,
          extendedRecentLeasedPartitions: 0,
          extendedHistoricalQueueDepth: 0,
          extendedHistoricalLeasedPartitions: 0,
          maintenanceQueueDepth: 3,
          maintenanceLeasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
          blockingDeadLetterPartitions: 0,
          quarantinedHistoricalDeadLetterPartitions: 0,
          actionRequiredDeadLetterPartitions: 0,
          actionRequiredBlockingDeadLetterPartitions: 0,
          actionRequiredDeadLetterScopes: [],
          actionRequiredBlockingDeadLetterScopes: [],
          coreBlockingDeadLetterPartitions: 0,
          coreActionRequiredBlockingDeadLetterPartitions: 0,
          replayableDeadLetterPartitions: 0,
          replayableBlockingDeadLetterPartitions: 0,
          unknownDeadLetterPartitions: 0,
          unknownBlockingDeadLetterPartitions: 0,
          oldestQueuedPartition: "2026-03-25",
          latestCoreActivityAt: null,
          latestExtendedActivityAt: null,
          latestMaintenanceActivityAt: null,
        },
      }),
    ).toBe(true);
  });

  it("keeps recent repair blocked when extended recent is suspended", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 25,
      extendedQueueDepth: 8,
      extendedBudgetAllowed: false,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    expect(
      shouldLeaseGoogleAdsRecentRepair({
        policy,
        queueHealth: {
          queueDepth: 25,
          leasedPartitions: 0,
          coreQueueDepth: 0,
          coreLeasedPartitions: 0,
          extendedQueueDepth: 8,
          extendedLeasedPartitions: 0,
          extendedRecentQueueDepth: 8,
          extendedRecentLeasedPartitions: 0,
          extendedHistoricalQueueDepth: 0,
          extendedHistoricalLeasedPartitions: 0,
          maintenanceQueueDepth: 0,
          maintenanceLeasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
          blockingDeadLetterPartitions: 0,
          quarantinedHistoricalDeadLetterPartitions: 0,
          actionRequiredDeadLetterPartitions: 0,
          actionRequiredBlockingDeadLetterPartitions: 0,
          actionRequiredDeadLetterScopes: [],
          actionRequiredBlockingDeadLetterScopes: [],
          coreBlockingDeadLetterPartitions: 0,
          coreActionRequiredBlockingDeadLetterPartitions: 0,
          replayableDeadLetterPartitions: 0,
          replayableBlockingDeadLetterPartitions: 0,
          unknownDeadLetterPartitions: 0,
          unknownBlockingDeadLetterPartitions: 0,
          oldestQueuedPartition: "2026-03-25",
          latestCoreActivityAt: null,
          latestExtendedActivityAt: null,
          latestMaintenanceActivityAt: null,
        },
      }),
    ).toBe(false);
  });
});

describe("getGoogleAdsGapPlannerBlockingStatuses", () => {
  it("keeps only actively in-flight partitions as gap blockers", () => {
    expect(getGoogleAdsGapPlannerBlockingStatuses()).toEqual([
      "queued",
      "leased",
      "running",
    ]);
  });
});

describe("buildGoogleAdsLaneProgressEvidence", () => {
  it("tracks historical extended evidence on the slowest extended scope", () => {
    const evidence = buildGoogleAdsLaneProgressEvidence({
      statesByScope: {
        search_term_daily: [
          {
            completedDays: 20,
            readyThroughDate: "2026-03-25",
            latestSuccessfulSyncAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
          },
        ],
        product_daily: [
          {
            completedDays: 18,
            readyThroughDate: "2026-03-22",
            latestSuccessfulSyncAt: "2026-04-02T09:40:00.000Z",
            updatedAt: "2026-04-02T09:40:00.000Z",
          },
        ],
      },
      queueHealth: {
        latestExtendedActivityAt: "2026-04-02T10:05:00.000Z",
        latestCoreActivityAt: null,
        latestMaintenanceActivityAt: null,
      } as never,
    });

    expect(evidence.extended_historical.lastCompletedAt).toBe(
      "2026-04-02T09:40:00.000Z",
    );
  });
});

describe("getGoogleAdsHistoricalFairnessLeaseLimit", () => {
  it("boosts historical fairness when historical extended advancement is stale", () => {
    const policy = {
      lanePolicy: {
        core: "admit",
        maintenance: "admit",
        extended: "admit",
        extendedRecent: "admit",
        extendedHistorical: "admit",
      },
      extendedCanaryEligible: false,
    } as ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>;

    const limit = getGoogleAdsHistoricalFairnessLeaseLimit({
      policy,
      queueHealth: {
        extendedHistoricalQueueDepth: 6,
        extendedHistoricalLeasedPartitions: 0,
        latestExtendedActivityAt: "2026-04-02T09:00:00.000Z",
      } as never,
      progressEvidence: {
        lastCheckpointAdvancedAt: "2026-04-02T09:00:00.000Z",
        lastReadyThroughAdvancedAt: null,
        lastCompletedAt: "2026-04-02T09:00:00.000Z",
        backlogDelta: null,
        completedPartitionDelta: null,
        lastReplayAt: null,
        lastReclaimAt: null,
        recentActivityWindowMinutes: 20,
      },
      nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
    });

    expect(limit).toBe(2);
  });

  it("keeps a single fairness lease when historical extended is still moving", () => {
    const policy = {
      lanePolicy: {
        core: "admit",
        maintenance: "admit",
        extended: "admit",
        extendedRecent: "admit",
        extendedHistorical: "admit",
      },
      extendedCanaryEligible: false,
    } as ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>;

    const limit = getGoogleAdsHistoricalFairnessLeaseLimit({
      policy,
      queueHealth: {
        extendedHistoricalQueueDepth: 6,
        extendedHistoricalLeasedPartitions: 0,
        latestExtendedActivityAt: "2026-04-02T09:25:00.000Z",
      } as never,
      progressEvidence: {
        lastCheckpointAdvancedAt: "2026-04-02T09:25:00.000Z",
        lastReadyThroughAdvancedAt: null,
        lastCompletedAt: "2026-04-02T09:25:00.000Z",
        backlogDelta: null,
        completedPartitionDelta: null,
        lastReplayAt: null,
        lastReclaimAt: null,
        recentActivityWindowMinutes: 20,
      },
      nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
    });

    expect(limit).toBe(1);
  });
});

describe("buildGoogleAdsPrimaryLeasePlan", () => {
  it("produces a deterministic lease plan from policy, priority, and evidence", () => {
    const policy = {
      lanePolicy: {
        core: "admit",
        maintenance: "admit",
        extended: "admit",
        extendedRecent: "admit",
        extendedHistorical: "admit",
      },
      suspendExtended: false,
      extendedCanaryEligible: false,
    } as ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>;

    const plan = buildGoogleAdsPrimaryLeasePlan({
      policy,
      queueHealth: {
        extendedRecentQueueDepth: 6,
        extendedHistoricalQueueDepth: 4,
        extendedHistoricalLeasedPartitions: 0,
        latestExtendedActivityAt: "2026-04-02T09:00:00.000Z",
      } as never,
      fullSyncPriorityRequired: true,
      fullSyncPriorityTargetScopes: ["search_term_daily", "product_daily"],
      blockHistoricalExtendedWork: false,
      progressEvidence: {
        extended_historical: {
          lastCheckpointAdvancedAt: "2026-04-02T09:00:00.000Z",
          lastReadyThroughAdvancedAt: null,
          lastCompletedAt: "2026-04-02T09:00:00.000Z",
          backlogDelta: null,
          completedPartitionDelta: null,
          lastReplayAt: null,
          lastReclaimAt: null,
          recentActivityWindowMinutes: 20,
        },
      },
      nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
    });

    expect(plan.historicalFairnessLimit).toBeGreaterThan(0);
    expect(plan.recentRepairLimit).toBeGreaterThan(0);
    expect(plan.fullSyncPriorityLimit).toBeGreaterThan(0);
  });
});

describe("resolveGoogleAdsWorkerRequestedLimit", () => {
  it("expands the lifecycle lease budget when Google has productive backlog", () => {
    expect(
      resolveGoogleAdsWorkerRequestedLimit({
        leaseLimit: 1,
        fullSyncPriorityRequired: true,
        queueHealth: {
          queueDepth: 1200,
          coreQueueDepth: 300,
          extendedHistoricalQueueDepth: 900,
          deadLetterPartitions: 0,
          latestCoreActivityAt: "2026-04-02T09:29:00.000Z",
          latestExtendedActivityAt: null,
          latestMaintenanceActivityAt: null,
        } as never,
        progressEvidence: {
          core: {
            lastCheckpointAdvancedAt: null,
            lastReadyThroughAdvancedAt: null,
            lastCompletedAt: "2026-04-02T09:29:00.000Z",
            backlogDelta: null,
            completedPartitionDelta: null,
            lastReplayAt: null,
            lastReclaimAt: null,
            recentActivityWindowMinutes: 20,
          },
        },
        nowMs: new Date("2026-04-02T09:30:00.000Z").getTime(),
      }),
    ).toBeGreaterThan(1);
  });

  it("does not expand the lifecycle lease budget while dead letters are present", () => {
    expect(
      resolveGoogleAdsWorkerRequestedLimit({
        leaseLimit: 1,
        queueHealth: {
          queueDepth: 10,
          coreQueueDepth: 10,
          extendedHistoricalQueueDepth: 0,
          deadLetterPartitions: 1,
        } as never,
      }),
    ).toBe(1);
  });
});

describe("shouldBlockGoogleAdsHistoricalExtendedWork", () => {
  it("keeps historical extended blocked until the recent 90-day frontier is complete", () => {
    expect(
      shouldBlockGoogleAdsHistoricalExtendedWork({
        recent90Complete: false,
      }),
    ).toBe(true);
  });

  it("allows priority historical replay while full-sync priority scopes are still incomplete", () => {
    expect(
      shouldAllowGoogleAdsPriorityHistoricalReplay({
        fullSyncPriorityRequired: true,
        fullSyncPriorityTargetScopes: ["search_term_daily", "product_daily"],
      }),
    ).toBe(true);
    expect(
      shouldBlockGoogleAdsHistoricalExtendedWork({
        recent90Complete: false,
        allowPriorityHistorical: true,
      }),
    ).toBe(false);
  });
});

describe("resolveGoogleAdsHistoricalReplayStart", () => {
  it("uses the full historical frontier for priority replay even when recent frontier evidence is incomplete", () => {
    expect(
      resolveGoogleAdsHistoricalReplayStart({
        historicalStart: "2024-03-21",
        recent90Start: "2026-01-21",
        recent90Complete: false,
        fullSyncPriorityRequired: true,
      }),
    ).toBe("2024-03-21");
  });

  it("keeps non-priority work on the recent frontier until recent work is complete", () => {
    expect(
      resolveGoogleAdsHistoricalReplayStart({
        historicalStart: "2024-03-21",
        recent90Start: "2026-01-21",
        recent90Complete: false,
      }),
    ).toBe("2026-01-21");
  });
});

describe("buildGoogleAdsMaintenanceLeasePlan", () => {
  it("throttles maintenance while full-sync priority is active", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 10,
      extendedQueueDepth: 4,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    const plan = buildGoogleAdsMaintenanceLeasePlan({
      policy,
      fullSyncPriorityRequired: true,
    });

    expect(plan.maintenanceLimit).toBe(1);
  });
});

describe("buildGoogleAdsFallbackExtendedLeasePlan", () => {
  it("switches to recent-only fallback when historical work is blocked", () => {
    const policy = buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: false,
      workerHealthy: true,
      workerCapacityAvailable: true,
      breakerOpen: false,
      queueDepth: 10,
      extendedQueueDepth: 4,
      extendedBudgetAllowed: true,
      extendedCanaryEligible: true,
      recoveryMode: "closed",
    });

    const plan = buildGoogleAdsFallbackExtendedLeasePlan({
      policy,
      fullSyncPriorityRequired: false,
      fullSyncPriorityTargetScopes: [],
      fullSyncPriorityYesterday: "2026-04-01",
      blockHistoricalExtendedWork: true,
      historicalLeaseStartDate: "2024-04-02",
    });

    expect(plan?.sourceFilter).toBe("recent_only");
    expect(plan?.startDate).toBeNull();
  });
});

describe("evaluateGoogleAdsWorkerSchedulingState", () => {
  it("does not treat a missing google heartbeat as healthy without a runner lease", () => {
    const nowMs = new Date("2026-03-29T12:00:00.000Z").getTime();
    const result = evaluateGoogleAdsWorkerSchedulingState({
      onlineWorkers: 0,
      lastHeartbeatAt: null,
      runnerLeaseActive: false,
      staleThresholdMs: 5 * 60_000,
      nowMs,
    });

    expect(result.healthy).toBe(false);
    expect(result.hasFreshHeartbeat).toBe(false);
  });

  it("treats a fresh runner lease as healthy even before heartbeat catches up", () => {
    const nowMs = new Date("2026-03-29T12:00:00.000Z").getTime();
    const result = evaluateGoogleAdsWorkerSchedulingState({
      onlineWorkers: 0,
      lastHeartbeatAt: null,
      runnerLeaseActive: true,
      staleThresholdMs: 5 * 60_000,
      nowMs,
    });

    expect(result.healthy).toBe(true);
    expect(result.runnerLeaseActive).toBe(true);
  });

  it("keeps worker health true for fresh provider-scoped heartbeats", () => {
    const nowMs = new Date("2026-03-29T12:00:00.000Z").getTime();
    const result = evaluateGoogleAdsWorkerSchedulingState({
      onlineWorkers: 1,
      lastHeartbeatAt: "2026-03-29T11:59:00.000Z",
      runnerLeaseActive: false,
      staleThresholdMs: 5 * 60_000,
      nowMs,
    });

    expect(result.healthy).toBe(true);
    expect(result.hasFreshHeartbeat).toBe(true);
    expect(result.heartbeatAgeMs).toBe(60_000);
  });
});

describe("planGoogleAdsRecentMaintenanceDates", () => {
  it("skips recent maintenance dates that are already covered or active", () => {
    expect(
      planGoogleAdsRecentMaintenanceDates({
        recentDates: ["2026-04-19", "2026-04-18", "2026-04-17", "2026-04-16"],
        coveredDates: ["2026-04-18", "2026-04-16"],
        activeDates: ["2026-04-17"],
        skipDates: ["2026-04-19"],
      }),
    ).toEqual([]);
  });

  it("returns only uncovered inactive non-skipped dates", () => {
    expect(
      planGoogleAdsRecentMaintenanceDates({
        recentDates: ["2026-04-19", "2026-04-18", "2026-04-17", "2026-04-16"],
        coveredDates: ["2026-04-18"],
        activeDates: ["2026-04-16"],
        skipDates: ["2026-04-19"],
      }),
    ).toEqual(["2026-04-17"]);
  });
});

describe("getGoogleAdsCoveredRecentMaintenanceDatesToCancel", () => {
  it("cancels only covered recent dates outside protected current-day slots", () => {
    expect(
      getGoogleAdsCoveredRecentMaintenanceDatesToCancel({
        coveredDates: ["2026-04-19", "2026-04-18", "2026-04-17", "2026-04-16"],
        protectedDates: ["2026-04-19", "2026-04-18"],
      }),
    ).toEqual(["2026-04-17", "2026-04-16"]);
  });
});

describe("getGoogleAdsD1FinalizeScopesToQueue", () => {
  it("queues only scopes still missing coverage", () => {
    expect(
      getGoogleAdsD1FinalizeScopesToQueue({
        accountDailyCovered: true,
        campaignDailyCovered: false,
      }),
    ).toEqual(["campaign_daily"]);
    expect(
      getGoogleAdsD1FinalizeScopesToQueue({
        accountDailyCovered: false,
        campaignDailyCovered: true,
      }),
    ).toEqual(["account_daily"]);
    expect(
      getGoogleAdsD1FinalizeScopesToQueue({
        accountDailyCovered: true,
        campaignDailyCovered: true,
      }),
    ).toEqual([]);
  });
});

describe("resolveGoogleAdsCoveredD1FinalizeResolution", () => {
  it("cancels queued finalize rows and marks completed when no live lease remains", () => {
    expect(
      resolveGoogleAdsCoveredD1FinalizeResolution({
        matchingRows: [
          { id: "a", source: "finalize_day", status: "queued" },
          { id: "b", source: "recent", status: "queued" },
        ],
      }),
    ).toEqual({
      queuedFinalizePartitionIds: ["a"],
      hasLiveFinalizeLeaseOrRun: false,
      shouldMarkCompleted: true,
    });
  });

  it("does not mark completed while a finalize row is still leased or running", () => {
    expect(
      resolveGoogleAdsCoveredD1FinalizeResolution({
        matchingRows: [
          { id: "a", source: "finalize_day", status: "leased" },
          { id: "b", source: "finalize_day", status: "queued" },
        ],
      }),
    ).toEqual({
      queuedFinalizePartitionIds: ["b"],
      hasLiveFinalizeLeaseOrRun: true,
      shouldMarkCompleted: false,
    });
  });
});
