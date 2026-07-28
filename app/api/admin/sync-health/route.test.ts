import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Admin recovery had no admission at all.
 *
 * Every action this endpoint dispatches mutates durable state — cleanup rewrites
 * partition orchestration, replay requeues dead letters, auto-repair writes
 * incidents and executions — and none of it asked whether sync was allowed to
 * run. A lane closed for a cutover, or a database already over its capacity
 * budget, was undone by one operator clicking a recovery button, and the audit
 * log recorded it as a completed recovery.
 *
 * Operator authority is not capacity authority. These cases call the REAL POST
 * handler and assert that a refusal produces zero recovery calls and a
 * structured 503 rather than a partial recovery reported as success.
 */

vi.mock("@/lib/admin-auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/admin-logger", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/admin-operations-health", () => ({ getAdminOperationsHealth: vi.fn() }));
vi.mock("@/lib/sync/provider-repair-engine", () => ({
  runGoogleAdsRepairCycle: vi.fn(),
  runMetaRepairCycle: vi.fn(),
}));
vi.mock("@/lib/sync/meta-sync", () => ({
  enqueueMetaScheduledWork: vi.fn(),
  refreshMetaSyncStateForBusiness: vi.fn(),
}));
vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary: vi.fn() };
});

const metaWarehouse = vi.hoisted(() => ({
  cleanupMetaPartitionOrchestration: vi.fn(),
  replayMetaDeadLetterPartitions: vi.fn(),
  requeueMetaRetryableFailedPartitions: vi.fn(),
  getMetaAuthoritativeBusinessOpsSnapshot: vi.fn(),
}));
const googleWarehouse = vi.hoisted(() => ({
  cleanupGoogleAdsPartitionOrchestration: vi.fn(),
  replayGoogleAdsDeadLetterPartitions: vi.fn(),
  forceReplayGoogleAdsPoisonedPartitions: vi.fn(),
  requeueGoogleAdsRetryableFailedPartitions: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => metaWarehouse);
vi.mock("@/lib/google-ads/warehouse", () => googleWarehouse);

/**
 * Only the EVIDENCE READ is faked. `toGoogleAdsFreshnessSummary`,
 * `weakestGoogleAdsCompletion` and `resolveGoogleAdsCompletion` stay real, so
 * these cases are stated in the defect's own inputs — covered days, post-close
 * observations, lookback — and the genuine decision converts them. A test that
 * stubbed the verdict itself would pass over a route that had gone back to
 * counting rows.
 */
const freshnessRead = vi.hoisted(() => ({ readGoogleAdsFreshness: vi.fn() }));
vi.mock("@/lib/google-ads/freshness-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readGoogleAdsFreshness: freshnessRead.readGoogleAdsFreshness };
});

const { GET, POST } = await import("@/app/api/admin/sync-health/route");
const adminAuth = await import("@/lib/admin-auth");
const dbGrowthFence = await import("@/lib/sync/db-growth-fence");
const operationsHealth = await import("@/lib/admin-operations-health");
const completionSemantics = await import("@/lib/google-ads/completion-semantics");
const freshnessReadModule = await import("@/lib/google-ads/freshness-read");

const buildRequest = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/sync-health", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/** Every recovery call the handler can make, so "nothing ran" is checkable. */
const recoveryCalls = () => [
  ...Object.values(metaWarehouse),
  ...Object.values(googleWarehouse),
];

describe("POST /api/admin/sync-health recovery admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";
    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      error: null,
      session: { user: { id: "admin-1" } },
    } as never);
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    metaWarehouse.cleanupMetaPartitionOrchestration.mockResolvedValue({
      stalePartitionCount: 0,
    });
    metaWarehouse.getMetaAuthoritativeBusinessOpsSnapshot.mockResolvedValue(null);
    googleWarehouse.cleanupGoogleAdsPartitionOrchestration.mockResolvedValue({
      stalePartitionCount: 0,
    });
  });

  it("performs the recovery when admitted", async () => {
    const response = await POST(
      buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(200);
    expect(metaWarehouse.cleanupMetaPartitionOrchestration).toHaveBeenCalledWith({
      businessId: "biz-1",
    });
  });

  it("refuses every recovery action with the Meta lane closed", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED;
    for (const action of [
      "cleanup",
      "replay_dead_letter",
      "requeue_failed",
      "auto_repair",
    ]) {
      vi.clearAllMocks();
      const response = await POST(
        buildRequest({ provider: "meta", action, businessId: "biz-1" }),
      );
      const payload = await response.json();
      expect(response.status).toBe(503);
      expect(payload.error).toBe("lane_disabled");
      expect(payload.refusal).toMatchObject({ scope: "meta_sync" });
      for (const call of recoveryCalls()) expect(call).not.toHaveBeenCalled();
    }
  });

  it("refuses a Google recovery with the Google lane closed", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED;
    const response = await POST(
      buildRequest({ provider: "google_ads", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).refusal).toMatchObject({ scope: "google_sync" });
    for (const call of recoveryCalls()) expect(call).not.toHaveBeenCalled();
  });

  it("does not let the Meta lane admit a Google recovery", async () => {
    // One shared "sync is on" check would let a Google recovery run off Meta's
    // permission. The lanes are individually addressable for exactly this.
    delete process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED;
    const response = await POST(
      buildRequest({ provider: "google_ads", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(503);
    expect(googleWarehouse.cleanupGoogleAdsPartitionOrchestration).not.toHaveBeenCalled();
    // ...and Meta, whose lane is open, still works.
    const metaResponse = await POST(
      buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }),
    );
    expect(metaResponse.status).toBe(200);
  });

  it("refuses when capacity cannot be proven, and asks for a FRESH sample", async () => {
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
        "admin_sync_recovery",
      ),
    );
    const response = await POST(
      buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("capacity_refused");
    expect(dbGrowthFence.assertSyncGrowthBoundary).toHaveBeenCalledWith(
      "admin_sync_recovery",
      // A cached sample is the one taken before the database filled up.
      { fresh: true },
    );
    for (const call of recoveryCalls()) expect(call).not.toHaveBeenCalled();
  });

  it("records the refusal in the admin audit log rather than silently dropping it", async () => {
    const { logAdminAction } = await import("@/lib/admin-logger");
    delete process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED;
    await POST(buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }));
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sync.recovery",
        meta: expect.objectContaining({ outcome: "rejected" }),
      }),
    );
  });
});

/**
 * Google Ads health was derived from row existence.
 *
 * `recentExtendedReady` and `historicalExtendedReady` mean
 * "completed_days >= totalDays", where completed_days counts dates that have at
 * least one warehouse row. A date fetched once at 01:40 while the day was still
 * open and never touched again satisfies that forever, so this endpoint
 * reported "Recent ready yes" and the admin page rendered a green business over
 * numbers nobody had re-read. These cases pin the correction.
 */

const SCOPES = [
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_daily",
] as const;

/** A readable snapshot built from the four inputs the defect is about. */
function buildSnapshot(input: {
  businessId: string;
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
  const scopes = Object.fromEntries(
    SCOPES.map((scope) => [
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
  );
  return {
    businessId: input.businessId,
    startDate: "2026-07-13",
    endDate: "2026-07-26",
    totalDays: input.totalDays,
    providerAccountIds: ["123"],
    timeZoneSource: "account" as const,
    includesOpenDay,
    evidenceAvailable: true,
    unavailableReason: null,
    scopes,
    overall: verdict,
  };
}

/** Schema not ready, failed read, no accounts, unusable timezone — all this. */
function buildUnavailableSnapshot(businessId: string, reason: string) {
  const verdict = completionSemantics.unknownGoogleAdsCompletion(reason);
  const scopes = Object.fromEntries(
    SCOPES.map((scope) => [
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
  );
  return {
    businessId,
    startDate: "2026-07-13",
    endDate: "2026-07-26",
    totalDays: 14,
    providerAccountIds: [],
    timeZoneSource: "default" as const,
    includesOpenDay: true,
    evidenceAvailable: false,
    unavailableReason: reason,
    scopes,
    overall: verdict,
  };
}

/**
 * A health row that is maximally green by the OLD definition: every recent day
 * has a row, so `completed_days >= totalDays` and both readiness flags are
 * already `true` when this endpoint receives them.
 */
function greenByCoverageBusiness(businessId: string) {
  return {
    businessId,
    businessName: `Business ${businessId}`,
    queueDepth: 0,
    leasedPartitions: 0,
    deadLetterPartitions: 0,
    oldestQueuedPartition: null,
    latestPartitionActivityAt: null,
    campaignCompletedDays: 14,
    searchTermCompletedDays: 365,
    productCompletedDays: 365,
    assetCompletedDays: 365,
    recentRangeTotalDays: 14,
    recentSearchTermCompletedDays: 14,
    recentProductCompletedDays: 14,
    recentAssetCompletedDays: 14,
    recentExtendedReady: true,
    historicalExtendedReady: true,
  };
}

function healthPayload(businesses: Array<ReturnType<typeof greenByCoverageBusiness>>) {
  return {
    syncHealth: {
      summary: {
        impactedBusinesses: 0,
        runningJobs: 0,
        stuckJobs: 0,
        failedJobs24h: 0,
        activeCooldowns: 0,
        successJobs24h: 3,
        topIssue: null,
      },
      issues: [],
      googleAdsBusinesses: businesses,
    },
  };
}

const buildGetRequest = () =>
  new NextRequest("http://localhost/api/admin/sync-health", { method: "GET" });

describe("GET /api/admin/sync-health Google Ads freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      error: null,
      session: { user: { id: "admin-1" } },
    } as never);
  });

  it("does not report ready or 100 for days that are covered but never re-read after closing", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([greenByCoverageBusiness("biz-1")]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue(
      buildSnapshot({
        businessId: "biz-1",
        totalDays: 14,
        // Every day has a row...
        coveredDays: 14,
        // ...and not one of them has been looked at since it closed.
        postCloseObservedDays: 0,
        lookbackExhaustedDays: 0,
      }),
    );

    const response = await GET(buildGetRequest());
    const payload = await response.json();
    const business = payload.googleAdsBusinesses[0];

    expect(response.status).toBe(200);
    // NEGATIVE CONTROL: coverage is fully 14 of 14 in the very same payload, so
    // any percent derived from coverage would read 100 and both readiness flags
    // would stay true. They do not.
    expect(business.googleAdsFreshness.scopes[0].coveredDays).toBe(14);
    expect(business.googleAdsFreshness.scopes[0].postCloseObservedDays).toBe(0);
    expect(business.googleAdsFreshness.state).toBe("provisional");
    expect(business.googleAdsFreshness.percent).toBeLessThan(100);
    expect(business.googleAdsFreshness.complete).toBe(false);
    expect(business.googleAdsFreshness.mayStopPolling).toBe(false);
    expect(business.recentExtendedReady).toBe(false);
    expect(business.historicalExtendedReady).toBe(false);
    expect(payload.summary.googleAdsFreshnessPercent).toBeLessThan(100);
    expect(payload.summary.googleAdsFreshnessComplete).toBe(false);
    expect(payload.summary.googleAdsFreshnessBusinessesNotSettled).toBe(1);
    // ...and nothing green is claimed by any surviving label either.
    expect(business.googleAdsFreshness.label).not.toBe("Final");
    expect(business.googleAdsFreshness.label).not.toBe("Complete");
  });

  it("does not call a converging range complete", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([greenByCoverageBusiness("biz-1")]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue(
      buildSnapshot({
        businessId: "biz-1",
        totalDays: 14,
        coveredDays: 14,
        // Every day re-read after closing...
        postCloseObservedDays: 14,
        // ...but conversions can still land inside the lookback window.
        lookbackExhaustedDays: 3,
      }),
    );

    const payload = await (await GET(buildGetRequest())).json();
    const business = payload.googleAdsBusinesses[0];

    expect(business.googleAdsFreshness.state).toBe("converging");
    expect(business.googleAdsFreshness.complete).toBe(false);
    expect(business.googleAdsFreshness.mayStopPolling).toBe(false);
    expect(business.googleAdsFreshness.percent).toBeLessThan(100);
    expect(business.recentExtendedReady).toBe(false);
    expect(business.historicalExtendedReady).toBe(false);
  });

  it("reports a settled range as complete", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([greenByCoverageBusiness("biz-1")]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue(
      buildSnapshot({
        businessId: "biz-1",
        totalDays: 14,
        coveredDays: 14,
        postCloseObservedDays: 14,
        lookbackExhaustedDays: 14,
      }),
    );

    const payload = await (await GET(buildGetRequest())).json();
    const business = payload.googleAdsBusinesses[0];

    expect(business.googleAdsFreshness.state).toBe("settled");
    expect(business.googleAdsFreshness.percent).toBe(100);
    expect(business.googleAdsFreshness.complete).toBe(true);
    expect(business.googleAdsFreshness.mayStopPolling).toBe(true);
    expect(business.recentExtendedReady).toBe(true);
    expect(business.historicalExtendedReady).toBe(true);
    expect(payload.summary.googleAdsFreshnessComplete).toBe(true);
  });

  it("never widens an upstream not-ready into ready, even when settled", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([
        {
          ...greenByCoverageBusiness("biz-1"),
          recentExtendedReady: false,
          historicalExtendedReady: false,
        },
      ]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue(
      buildSnapshot({
        businessId: "biz-1",
        totalDays: 14,
        coveredDays: 14,
        postCloseObservedDays: 14,
        lookbackExhaustedDays: 14,
      }),
    );

    const payload = await (await GET(buildGetRequest())).json();
    expect(payload.googleAdsBusinesses[0].recentExtendedReady).toBe(false);
    expect(payload.googleAdsBusinesses[0].historicalExtendedReady).toBe(false);
  });

  it("fails closed to a non-green RETRYABLE unknown when the evidence cannot be read, and does not turn it into an error", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([greenByCoverageBusiness("biz-1")]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue(
      buildUnavailableSnapshot("biz-1", "Google Ads freshness tables are not ready yet."),
    );

    const response = await GET(buildGetRequest());
    const payload = await response.json();
    const business = payload.googleAdsBusinesses[0];

    // Not an error: the queue, worker and dead-letter evidence must survive.
    expect(response.status).toBe(200);
    expect(payload.error).toBeUndefined();
    // Not healthy either.
    expect(business.googleAdsFreshness.state).toBe("unknown");
    expect(business.googleAdsFreshness.complete).toBe(false);
    expect(business.googleAdsFreshness.mayStopPolling).toBe(false);
    expect(business.googleAdsFreshness.evidenceAvailable).toBe(false);
    expect(business.recentExtendedReady).toBe(false);
    expect(business.historicalExtendedReady).toBe(false);
    // ...and explicitly retryable, not terminal.
    expect(payload.summary.googleAdsFreshnessRetryable).toBe(true);
    expect(payload.summary.googleAdsFreshnessEvidenceAvailable).toBe(false);
    expect(payload.summary.googleAdsFreshnessComplete).toBe(false);
  });

  it("fails closed when the evidence read itself rejects", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([greenByCoverageBusiness("biz-1")]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockRejectedValue(new Error("connection reset"));

    const response = await GET(buildGetRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.googleAdsBusinesses[0].googleAdsFreshness.state).toBe("unknown");
    expect(payload.googleAdsBusinesses[0].recentExtendedReady).toBe(false);
    expect(payload.summary.googleAdsFreshnessRetryable).toBe(true);
  });

  it("issues exactly ONE bulk read per business, covering every scope in that one call", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([
        greenByCoverageBusiness("biz-1"),
        greenByCoverageBusiness("biz-2"),
        greenByCoverageBusiness("biz-3"),
      ]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockImplementation(
      async (input: { businessId: string }) =>
        buildSnapshot({
          businessId: input.businessId,
          totalDays: 14,
          coveredDays: 14,
          postCloseObservedDays: 14,
          lookbackExhaustedDays: 14,
        }),
    );

    await GET(buildGetRequest());

    // Three businesses, three reads. Not one per scope, not one per date.
    expect(freshnessRead.readGoogleAdsFreshness).toHaveBeenCalledTimes(3);
    for (const call of freshnessRead.readGoogleAdsFreshness.mock.calls) {
      expect(call[0].scopes).toEqual([...SCOPES]);
    }
  });

  it("rolls the WEAKEST business verdict up to the summary", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([
        greenByCoverageBusiness("biz-settled"),
        greenByCoverageBusiness("biz-provisional"),
      ]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockImplementation(
      async (input: { businessId: string }) =>
        input.businessId === "biz-settled"
          ? buildSnapshot({
              businessId: input.businessId,
              totalDays: 14,
              coveredDays: 14,
              postCloseObservedDays: 14,
              lookbackExhaustedDays: 14,
            })
          : buildSnapshot({
              businessId: input.businessId,
              totalDays: 14,
              coveredDays: 14,
              postCloseObservedDays: 2,
              lookbackExhaustedDays: 0,
            }),
    );

    const payload = await (await GET(buildGetRequest())).json();

    expect(payload.summary.googleAdsFreshnessState).toBe("provisional");
    expect(payload.summary.googleAdsFreshnessComplete).toBe(false);
    expect(payload.summary.googleAdsFreshnessBusinessesNotSettled).toBe(1);
    expect(
      payload.googleAdsBusinesses.find(
        (business: { businessId: string }) => business.businessId === "biz-settled",
      ).recentExtendedReady,
    ).toBe(true);
  });

  it("keeps every existing operator-facing field on the payload", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue(
      healthPayload([greenByCoverageBusiness("biz-1")]) as never,
    );
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue(
      buildSnapshot({
        businessId: "biz-1",
        totalDays: 14,
        coveredDays: 14,
        postCloseObservedDays: 0,
        lookbackExhaustedDays: 0,
      }),
    );

    const payload = await (await GET(buildGetRequest())).json();
    const business = payload.googleAdsBusinesses[0];

    // The coverage counters are a legitimate data-availability answer and are
    // untouched; only the CLAIMS built on them changed.
    expect(business.campaignCompletedDays).toBe(14);
    expect(business.searchTermCompletedDays).toBe(365);
    expect(business.recentSearchTermCompletedDays).toBe(14);
    expect(business.queueDepth).toBe(0);
    expect(payload.summary.successJobs24h).toBe(3);
    expect(payload.issues).toEqual([]);
  });

  it("passes the payload through untouched when there are no Google Ads businesses", async () => {
    vi.mocked(operationsHealth.getAdminOperationsHealth).mockResolvedValue({
      syncHealth: { summary: { successJobs24h: 0 }, issues: [] },
    } as never);

    const payload = await (await GET(buildGetRequest())).json();

    expect(freshnessRead.readGoogleAdsFreshness).not.toHaveBeenCalled();
    expect(payload.googleAdsBusinesses).toBeUndefined();
  });

  it("uses the real shared decision, not a private copy of it", () => {
    // If a future edit reintroduces local percent arithmetic, this is the
    // anchor: the summariser and the weakest-link rule both come from the one
    // shared module.
    expect(typeof freshnessReadModule.toGoogleAdsFreshnessSummary).toBe("function");
    expect(typeof freshnessReadModule.weakestGoogleAdsCompletion).toBe("function");
    expect(
      freshnessReadModule.weakestGoogleAdsCompletion([
        completionSemantics.resolveGoogleAdsCompletion({
          totalDays: 14,
          coveredDays: 14,
          postCloseObservedDays: 14,
          lookbackExhaustedDays: 14,
          includesOpenDay: false,
        }),
        completionSemantics.unknownGoogleAdsCompletion("evidence unavailable"),
      ]).state,
    ).toBe("unknown");
  });
});
