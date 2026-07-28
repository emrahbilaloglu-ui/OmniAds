import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAdsCompletionState } from "@/lib/google-ads/completion-semantics";
import type { GoogleAdsSyncStateRecord } from "@/lib/google-ads/warehouse-types";
import type { GoogleAdsFreshnessSnapshot } from "@/lib/google-ads/freshness-read";

/**
 * Only the EVIDENCE READS are doubled. `resolveGoogleAdsControlPlaneSyncTruth`,
 * `toGoogleAdsCoreFreshnessEvidence`, `buildGoogleAdsReleaseReadinessCandidate`
 * and `classifyProviderReleaseTruth` all stay real, so these tests exercise the
 * actual chain from a warehouse row to a release-gate verdict rather than a
 * restatement of it.
 */
const warehouse = vi.hoisted(() => ({
  getGoogleAdsQueueHealth: vi.fn(),
  getGoogleAdsCheckpointHealth: vi.fn(),
  getGoogleAdsSyncState: vi.fn(),
  getLatestGoogleAdsSyncHealth: vi.fn(),
}));
const freshnessRead = vi.hoisted(() => ({ readGoogleAdsFreshness: vi.fn() }));
const platformDate = vi.hoisted(() => ({ getProviderPlatformDateBoundaries: vi.fn() }));
const snapshots = vi.hoisted(() => ({
  readProviderAccountSnapshot: vi.fn(),
  readProviderConnectionGenerationToken: vi.fn(),
}));

vi.mock("@/lib/google-ads/warehouse", () => warehouse);
vi.mock("@/lib/sync/google-ads-sync", () => ({
  getGoogleAdsWorkerSchedulingState: vi.fn(async () => ({ healthy: true })),
}));
vi.mock("@/lib/google-ads/freshness-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google-ads/freshness-read")>();
  return { ...actual, readGoogleAdsFreshness: freshnessRead.readGoogleAdsFreshness };
});
vi.mock("@/lib/provider-platform-date", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provider-platform-date")>();
  return {
    ...actual,
    getProviderPlatformDateBoundaries: platformDate.getProviderPlatformDateBoundaries,
  };
});
vi.mock("@/lib/provider-account-snapshots", () => snapshots);

const {
  GOOGLE_ADS_RELEASE_FRESHNESS_WINDOW_DAYS,
  buildGoogleAdsReleaseGateCanaries,
  isGoogleAdsFreshnessSettled,
  isGoogleAdsPostCloseObserved,
  readGoogleAdsCoreFreshnessEvidence,
  resolveGoogleAdsControlPlaneSyncTruth,
  toGoogleAdsCoreFreshnessEvidence,
  unknownGoogleAdsFreshnessEvidence,
} = await import("@/lib/google-ads/control-plane-runtime");

type FreshnessEvidence = ReturnType<typeof unknownGoogleAdsFreshnessEvidence>;

const now = Date.parse("2026-04-20T07:20:00.000Z");

/**
 * A core scope row that is FULLY COVERED and freshly synced.
 *
 * Every fixture below reuses this so coverage and freshness disagree BY
 * CONSTRUCTION: `completedDays` spans the whole target range and
 * `latestSuccessfulSyncAt` is minutes old, which is exactly the shape the old
 * `completedDays > 0 && latestSuccessfulSyncAt` test called serving-ready. The
 * freshness verdict is varied independently. A control that moved both together
 * would prove nothing.
 */
function coveredScope(
  scope: string,
  overrides: Partial<GoogleAdsSyncStateRecord> = {},
): GoogleAdsSyncStateRecord {
  return {
    businessId: "biz-1",
    providerAccountId: "acct-1",
    scope: scope as GoogleAdsSyncStateRecord["scope"],
    historicalTargetStart: "2026-04-01",
    historicalTargetEnd: "2026-04-19",
    effectiveTargetStart: "2026-04-13",
    effectiveTargetEnd: "2026-04-19",
    latestSuccessfulSyncAt: "2026-04-20T07:16:00.000Z",
    completedDays: 7,
    deadLetterCount: 0,
    ...overrides,
  };
}

const fullyCoveredCoreScopes = [
  coveredScope("account_daily"),
  coveredScope("campaign_daily"),
];

function evidence(
  state: GoogleAdsCompletionState,
  overrides: Partial<FreshnessEvidence> = {},
): FreshnessEvidence {
  return {
    evidenceAvailable: state !== "unknown",
    state,
    scopeStates: { account_daily: state, campaign_daily: state },
    unavailableReason: null,
    measuredStartDate: "2026-04-06",
    measuredEndDate: "2026-04-19",
    ...overrides,
  };
}

describe("resolveGoogleAdsControlPlaneSyncTruth", () => {
  it("refuses serving readiness for fully covered scopes that were never re-read after their day closed", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "succeeded",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: evidence("provisional"),
    });

    // Coverage says yes; the verdict says the days were never re-read.
    expect(truth.coreDataAvailable).toBe(true);
    expect(truth.corePostCloseObserved).toBe(false);
    expect(truth.coreServingReady).toBe(false);
    expect(truth.servingReady).toBe(false);
    expect(truth.truthReady).toBe(false);
    expect(truth.fullyReady).toBe(false);
  });

  it("does not let a recent successful sync stand in for post-close observation", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "cancelled",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: evidence("provisional"),
    });

    expect(truth.hasRecentSuccessfulScopeSync).toBe(true);
    expect(truth.effectiveLatestSyncStatus).toBe("succeeded");
    expect(truth.truthReady).toBe(false);
    expect(truth.fullyReady).toBe(false);
  });

  it("fails closed when no freshness evidence is supplied at all", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "succeeded",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
    });

    expect(truth.coreFreshnessState).toBe("unknown");
    expect(truth.coreFreshnessEvidenceAvailable).toBe(false);
    expect(truth.coreServingReady).toBe(false);
    expect(truth.truthReady).toBe(false);
    expect(truth.fullyReady).toBe(false);
  });

  it("keeps unreadable freshness non-green, retryable, and NOT a failed sync", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "succeeded",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: unknownGoogleAdsFreshnessEvidence("statement timeout"),
    });

    expect(truth.truthReady).toBe(false);
    expect(truth.freshnessBlocksReadiness).toBe(true);
    // Retryable, not terminal: "we could not look" must never be reported as a
    // failed sync, or a transient read error becomes an incident.
    expect(truth.effectiveLatestSyncStatus).not.toBe("failed");
    expect(truth.effectiveLatestSyncStatus).toBe("succeeded");
    expect(truth.coreFreshnessUnavailableReason).toBe("statement timeout");
  });

  it("separates unknown from missing", () => {
    const unknown = resolveGoogleAdsControlPlaneSyncTruth({
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: unknownGoogleAdsFreshnessEvidence("schema not ready"),
    });
    const missing = resolveGoogleAdsControlPlaneSyncTruth({
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: evidence("missing"),
    });

    // Both non-green, but only one is an admission that we could not look.
    expect(unknown.truthReady).toBe(false);
    expect(missing.truthReady).toBe(false);
    expect(unknown.coreFreshnessEvidenceAvailable).toBe(false);
    expect(missing.coreFreshnessEvidenceAvailable).toBe(true);
    expect(unknown.coreFreshnessState).toBe("unknown");
    expect(missing.coreFreshnessState).toBe("missing");
  });

  it("admits a converging range as serving-ready without calling it complete", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "succeeded",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: evidence("converging"),
    });

    expect(truth.corePostCloseObserved).toBe(true);
    expect(truth.coreServingReady).toBe(true);
    expect(truth.truthReady).toBe(true);
    expect(truth.fullyReady).toBe(true);
    // Serving-ready is NOT completion. A rolling range always holds its most
    // recent days inside the conversion window.
    expect(truth.coreFreshnessSettled).toBe(false);
    expect(truth.freshnessBlocksReadiness).toBe(false);
  });

  it("treats settled as the strongest state and still never as final", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "succeeded",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: evidence("settled"),
    });

    expect(truth.coreFreshnessSettled).toBe(true);
    expect(truth.truthReady).toBe(true);
    expect(truth.coreFreshnessState).toBe("settled");
    // There is no "final" or "immutable" anywhere in the verdict surface.
    expect(Object.keys(truth)).not.toContain("final");
    expect(JSON.stringify(truth)).not.toMatch(/\b(final|immutable)\b/i);
  });

  it("requires BOTH core scopes to be observed, not just one", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "succeeded",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: fullyCoveredCoreScopes,
      freshness: evidence("provisional", {
        state: "provisional",
        scopeStates: { account_daily: "settled", campaign_daily: "provisional" },
      }),
    });

    expect(truth.coreServingReady).toBe(false);
    expect(truth.truthReady).toBe(false);
  });

  it("still refuses readiness when the data itself is absent, however fresh the verdict", () => {
    const truth = resolveGoogleAdsControlPlaneSyncTruth({
      latestSyncStatus: "succeeded",
      queueDepth: 0,
      deadLetterPartitions: 0,
      nowMs: now,
      scopeStates: [coveredScope("account_daily")],
      freshness: evidence("settled"),
    });

    // Data availability is a separate question and it is answered "no".
    expect(truth.coreDataAvailable).toBe(false);
    expect(truth.corePostCloseObserved).toBe(true);
    expect(truth.coreServingReady).toBe(false);
  });

  it("separates core serving readiness from unfinished background queue", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "succeeded",
        queueDepth: 42,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: fullyCoveredCoreScopes,
        freshness: evidence("converging"),
      }),
    ).toMatchObject({
      coreServingReady: true,
      servingReady: true,
      fullyReady: false,
    });
  });

  it("treats stale cancelled latest rows as ready when core scopes are observed and the queue is drained", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "cancelled",
        queueDepth: 0,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: fullyCoveredCoreScopes.map((row) =>
          coveredScope(row.scope, { latestSuccessfulSyncAt: "2026-04-20T06:00:00.000Z" }),
        ),
        freshness: evidence("converging"),
      }),
    ).toMatchObject({
      effectiveLatestSyncStatus: "cancelled",
      hasRecentSuccessfulScopeSync: false,
      coreServingReady: true,
      servingReady: true,
      fullyReady: true,
    });
  });

  it("does not override failed sync status", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "failed",
        queueDepth: 0,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: fullyCoveredCoreScopes,
        freshness: evidence("settled"),
      }),
    ).toMatchObject({
      effectiveLatestSyncStatus: "failed",
      servingReady: false,
      fullyReady: false,
    });
  });

  it("does not let a failed non-core surface hide core serving readiness", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "failed",
        latestSyncScope: "product_daily",
        queueDepth: 0,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: fullyCoveredCoreScopes.map((row) =>
          coveredScope(row.scope, { latestSuccessfulSyncAt: "2026-04-20T06:00:00.000Z" }),
        ),
        freshness: evidence("converging"),
      }),
    ).toMatchObject({
      effectiveLatestSyncStatus: null,
      coreServingReady: true,
      servingReady: true,
      fullyReady: true,
    });
  });

  it("keeps queue-drained state unready when successful scope sync is stale", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "cancelled",
        queueDepth: 0,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: [
          coveredScope("product_daily", {
            latestSuccessfulSyncAt: "2026-04-20T06:00:00.000Z",
          }),
        ],
        freshness: evidence("converging"),
      }),
    ).toMatchObject({
      effectiveLatestSyncStatus: "cancelled",
      hasRecentSuccessfulScopeSync: false,
      fullyReady: false,
    });
  });
});

describe("google ads freshness evidence helpers", () => {
  it("treats converging and settled as observed, and nothing else", () => {
    expect(isGoogleAdsPostCloseObserved(evidence("settled"))).toBe(true);
    expect(isGoogleAdsPostCloseObserved(evidence("converging"))).toBe(true);
    expect(isGoogleAdsPostCloseObserved(evidence("provisional"))).toBe(false);
    expect(isGoogleAdsPostCloseObserved(evidence("missing"))).toBe(false);
    expect(isGoogleAdsPostCloseObserved(unknownGoogleAdsFreshnessEvidence("x"))).toBe(false);
    expect(isGoogleAdsPostCloseObserved(null)).toBe(false);
    expect(isGoogleAdsPostCloseObserved(undefined)).toBe(false);
  });

  it("keeps settled distinct from merely observed", () => {
    expect(isGoogleAdsFreshnessSettled(evidence("converging"))).toBe(false);
    expect(isGoogleAdsFreshnessSettled(evidence("settled"))).toBe(true);
  });

  it("refuses to vouch for a core scope the snapshot never measured", () => {
    const snapshot = {
      businessId: "biz-1",
      startDate: "2026-04-06",
      endDate: "2026-04-19",
      totalDays: 14,
      providerAccountIds: ["acct-1"],
      timeZoneSource: "account",
      includesOpenDay: false,
      evidenceAvailable: true,
      unavailableReason: null,
      scopes: {
        account_daily: {
          scope: "account_daily",
          coveredDays: 14,
          postCloseObservedDays: 14,
          lookbackExhaustedDays: 14,
          dueNowDays: 0,
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict: {
            state: "settled",
            percent: 100,
            complete: true,
            mayStopPolling: true,
            detail: "",
          },
        },
      },
      overall: {
        state: "settled",
        percent: 100,
        complete: true,
        mayStopPolling: true,
        detail: "",
      },
    } as unknown as GoogleAdsFreshnessSnapshot;

    const resolved = toGoogleAdsCoreFreshnessEvidence(snapshot);
    expect(resolved.scopeStates.campaign_daily).toBe("unknown");
    expect(resolved.state).toBe("unknown");
    expect(resolved.evidenceAvailable).toBe(false);
    expect(isGoogleAdsPostCloseObserved(resolved)).toBe(false);
  });

  it("propagates an unavailable snapshot as unknown, never as missing", () => {
    const resolved = toGoogleAdsCoreFreshnessEvidence({
      startDate: "2026-04-06",
      endDate: "2026-04-19",
      evidenceAvailable: false,
      unavailableReason: "Google Ads freshness tables are not ready yet.",
      scopes: {},
    } as unknown as GoogleAdsFreshnessSnapshot);

    expect(resolved.state).toBe("unknown");
    expect(resolved.evidenceAvailable).toBe(false);
    expect(resolved.unavailableReason).toBe("Google Ads freshness tables are not ready yet.");
  });
});

describe("readGoogleAdsCoreFreshnessEvidence", () => {
  function connectedBusiness() {
    snapshots.readProviderConnectionGenerationToken.mockResolvedValue("7:connected");
    snapshots.readProviderAccountSnapshot.mockResolvedValue({
      accounts: [],
      meta: { connectionFingerprint: "7:connected" },
    });
    platformDate.getProviderPlatformDateBoundaries.mockResolvedValue([
      {
        provider: "google",
        businessId: "biz-1",
        providerAccountId: "acct-1",
        timeZone: "America/Los_Angeles",
        timeZoneSource: "account",
        currentDate: "2026-04-20",
        previousDate: "2026-04-19",
        isPrimary: true,
      },
      {
        provider: "google",
        businessId: "biz-1",
        providerAccountId: "acct-2",
        timeZone: "Europe/Istanbul",
        timeZoneSource: "account",
        currentDate: "2026-04-21",
        previousDate: "2026-04-20",
        isPrimary: false,
      },
    ]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues ONE bulk read covering both core scopes over the last CLOSED day", async () => {
    connectedBusiness();
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue({
      startDate: "2026-04-06",
      endDate: "2026-04-19",
      evidenceAvailable: true,
      unavailableReason: null,
      scopes: {
        account_daily: { verdict: { state: "converging" } },
        campaign_daily: { verdict: { state: "converging" } },
      },
    });

    const resolved = await readGoogleAdsCoreFreshnessEvidence({ businessId: "biz-1" });

    expect(freshnessRead.readGoogleAdsFreshness).toHaveBeenCalledTimes(1);
    const [call] = freshnessRead.readGoogleAdsFreshness.mock.calls;
    expect(call[0].scopes).toEqual(["account_daily", "campaign_daily"]);
    // The EARLIEST account's previous day: ending on any account's still-open
    // day would cap the verdict at `provisional` forever.
    expect(call[0].endDate).toBe("2026-04-19");
    expect(call[0].startDate).toBe("2026-04-06");
    expect(GOOGLE_ADS_RELEASE_FRESHNESS_WINDOW_DAYS).toBe(14);
    expect(call[0].providerAccountIds).toEqual(["acct-1", "acct-2"]);
    expect(resolved.state).toBe("converging");
    expect(resolved.evidenceAvailable).toBe(true);
  });

  it("fails closed without reading freshness when there is no connection row", async () => {
    connectedBusiness();
    snapshots.readProviderConnectionGenerationToken.mockResolvedValue(null);

    const resolved = await readGoogleAdsCoreFreshnessEvidence({ businessId: "biz-1" });

    expect(resolved.state).toBe("unknown");
    expect(resolved.evidenceAvailable).toBe(false);
    expect(freshnessRead.readGoogleAdsFreshness).not.toHaveBeenCalled();
  });

  it("fails closed when the connection is no longer connected", async () => {
    connectedBusiness();
    snapshots.readProviderConnectionGenerationToken.mockResolvedValue("7:disconnected");

    const resolved = await readGoogleAdsCoreFreshnessEvidence({ businessId: "biz-1" });

    expect(resolved.evidenceAvailable).toBe(false);
    expect(freshnessRead.readGoogleAdsFreshness).not.toHaveBeenCalled();
  });

  it("fails closed on a superseded connection generation", async () => {
    connectedBusiness();
    snapshots.readProviderAccountSnapshot.mockResolvedValue({
      accounts: [],
      meta: { connectionFingerprint: "6:connected" },
    });

    const resolved = await readGoogleAdsCoreFreshnessEvidence({ businessId: "biz-1" });

    expect(resolved.evidenceAvailable).toBe(false);
    expect(resolved.unavailableReason).toMatch(/superseded connection generation/);
    expect(freshnessRead.readGoogleAdsFreshness).not.toHaveBeenCalled();
  });

  it("fails closed on an untrustworthy account timezone", async () => {
    connectedBusiness();
    platformDate.getProviderPlatformDateBoundaries.mockResolvedValue([
      {
        providerAccountId: "acct-1",
        timeZone: "UTC",
        timeZoneSource: "default",
        currentDate: "2026-04-20",
        previousDate: "2026-04-19",
      },
    ]);

    const resolved = await readGoogleAdsCoreFreshnessEvidence({ businessId: "biz-1" });

    expect(resolved.evidenceAvailable).toBe(false);
    expect(resolved.unavailableReason).toMatch(/timezone/);
    expect(freshnessRead.readGoogleAdsFreshness).not.toHaveBeenCalled();
  });

  it("fails closed when there are no assigned accounts", async () => {
    connectedBusiness();
    platformDate.getProviderPlatformDateBoundaries.mockResolvedValue([]);

    const resolved = await readGoogleAdsCoreFreshnessEvidence({ businessId: "biz-1" });

    expect(resolved.evidenceAvailable).toBe(false);
    expect(freshnessRead.readGoogleAdsFreshness).not.toHaveBeenCalled();
  });

  it("fails closed, not open, when the freshness read throws", async () => {
    connectedBusiness();
    freshnessRead.readGoogleAdsFreshness.mockRejectedValue(new Error("pool exhausted"));

    const resolved = await readGoogleAdsCoreFreshnessEvidence({ businessId: "biz-1" });

    expect(resolved.state).toBe("unknown");
    expect(resolved.evidenceAvailable).toBe(false);
    expect(isGoogleAdsPostCloseObserved(resolved)).toBe(false);
  });
});

describe("buildGoogleAdsReleaseGateCanaries", () => {
  function scopeRowsFor(scope: string) {
    return ["account_daily", "campaign_daily"].includes(scope)
      ? [coveredScope(scope)]
      : [];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    warehouse.getGoogleAdsQueueHealth.mockResolvedValue({
      queueDepth: 0,
      coreQueueDepth: 0,
      extendedQueueDepth: 0,
      maintenanceQueueDepth: 0,
      coreLeasedPartitions: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
      blockingDeadLetterPartitions: 0,
      coreBlockingDeadLetterPartitions: 0,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
      latestCoreActivityAt: "2026-04-20T07:16:00.000Z",
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
    });
    warehouse.getGoogleAdsCheckpointHealth.mockResolvedValue({
      latestCheckpointUpdatedAt: "2026-04-20T07:16:00.000Z",
      checkpointLagMinutes: 1,
    });
    warehouse.getLatestGoogleAdsSyncHealth.mockResolvedValue({
      status: "succeeded",
      scope: "campaign_daily",
    });
    warehouse.getGoogleAdsSyncState.mockImplementation(
      async ({ scope }: { scope: string }) => scopeRowsFor(scope),
    );
    snapshots.readProviderConnectionGenerationToken.mockResolvedValue("7:connected");
    snapshots.readProviderAccountSnapshot.mockResolvedValue({
      accounts: [],
      meta: { connectionFingerprint: "7:connected" },
    });
    platformDate.getProviderPlatformDateBoundaries.mockResolvedValue([
      {
        providerAccountId: "acct-1",
        timeZone: "Europe/Istanbul",
        timeZoneSource: "account",
        currentDate: "2026-04-20",
        previousDate: "2026-04-19",
      },
    ]);
  });

  function mockFreshness(state: GoogleAdsCompletionState) {
    freshnessRead.readGoogleAdsFreshness.mockResolvedValue({
      startDate: "2026-04-06",
      endDate: "2026-04-19",
      evidenceAvailable: true,
      unavailableReason: null,
      scopes: {
        account_daily: { verdict: { state } },
        campaign_daily: { verdict: { state } },
      },
    });
  }

  const business = {
    businessId: "biz-1",
    businessName: "Biz One",
    assignedAccountCount: 1,
  };

  it("refuses to pass an otherwise-healthy canary whose days were never re-read", async () => {
    mockFreshness("provisional");

    const [canary] = await buildGoogleAdsReleaseGateCanaries([business]);

    const evidenceOf = canary.evidence as Record<string, unknown>;
    expect(evidenceOf.coreDataAvailable).toBe(true);
    expect(evidenceOf.corePostCloseObserved).toBe(false);
    expect(evidenceOf.truthReady).toBe(false);
    expect(canary.pass).toBe(false);
    // Retryable, never terminal, and never a misconfiguration.
    expect(canary.blockerClass).toBe("not_release_ready");
    expect(canary.evidence.freshnessRetryable).toBe(true);
    expect(canary.evidence.latestSyncStatus).not.toBe("failed");
  });

  it("passes a converging canary and still refuses to call it settled", async () => {
    mockFreshness("converging");

    const [canary] = await buildGoogleAdsReleaseGateCanaries([business]);

    expect(canary.pass).toBe(true);
    expect(canary.blockerClass).toBe("none");
    expect(canary.evidence.coreFreshnessState).toBe("converging");
    expect(canary.evidence.coreFreshnessSettled).toBe(false);
    expect((canary.evidence as Record<string, unknown>).freshnessSettled).toBe(false);
  });

  it("passes a settled canary without ever labelling it final", async () => {
    mockFreshness("settled");

    const [canary] = await buildGoogleAdsReleaseGateCanaries([business]);

    expect(canary.pass).toBe(true);
    expect(canary.evidence.coreFreshnessSettled).toBe(true);
    expect(JSON.stringify(canary)).not.toMatch(/\b(final|immutable)\b/i);
  });

  it("fails closed and stays retryable when freshness evidence cannot be read", async () => {
    freshnessRead.readGoogleAdsFreshness.mockRejectedValue(new Error("statement timeout"));

    const [canary] = await buildGoogleAdsReleaseGateCanaries([business]);

    expect(canary.pass).toBe(false);
    expect(canary.evidence.coreFreshnessState).toBe("unknown");
    expect(canary.evidence.coreFreshnessEvidenceAvailable).toBe(false);
    expect(canary.evidence.freshnessRetryable).toBe(true);
    expect(canary.blockerClass).toBe("not_release_ready");
    expect(canary.blockerClass).not.toBe("misconfigured");
  });

  it("reads freshness ONCE per business — never per scope, never per business-scope pair", async () => {
    mockFreshness("converging");

    await buildGoogleAdsReleaseGateCanaries([
      business,
      { businessId: "biz-2", businessName: "Biz Two", assignedAccountCount: 1 },
      { businessId: "biz-3", businessName: "Biz Three", assignedAccountCount: 2 },
    ]);

    // Nine control-plane scopes are read per business. An N+1 would show up
    // here as 9 (or 27) freshness reads instead of 3.
    expect(warehouse.getGoogleAdsSyncState).toHaveBeenCalledTimes(27);
    expect(freshnessRead.readGoogleAdsFreshness).toHaveBeenCalledTimes(3);
    expect(
      freshnessRead.readGoogleAdsFreshness.mock.calls.map((call) => call[0].businessId).sort(),
    ).toEqual(["biz-1", "biz-2", "biz-3"]);
    for (const call of freshnessRead.readGoogleAdsFreshness.mock.calls) {
      expect(call[0].scopes).toEqual(["account_daily", "campaign_daily"]);
    }
  });

  it("lets an independently observed incident keep naming itself over unknown freshness", async () => {
    freshnessRead.readGoogleAdsFreshness.mockRejectedValue(new Error("statement timeout"));
    warehouse.getGoogleAdsQueueHealth.mockResolvedValue({
      queueDepth: 12,
      coreQueueDepth: 12,
      extendedQueueDepth: 0,
      maintenanceQueueDepth: 0,
      coreLeasedPartitions: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 4,
      blockingDeadLetterPartitions: 4,
      coreBlockingDeadLetterPartitions: 4,
      extendedHistoricalQueueDepth: 0,
      extendedHistoricalLeasedPartitions: 0,
      latestCoreActivityAt: "2026-04-20T07:16:00.000Z",
      latestExtendedActivityAt: null,
      latestMaintenanceActivityAt: null,
    });

    const [canary] = await buildGoogleAdsReleaseGateCanaries([business]);

    expect(canary.pass).toBe(false);
    // The dead letters win the classification; unknown freshness must not
    // demote a real incident to a generic "not ready".
    expect(canary.blockerClass).toBe("queue_blocked");
    expect(canary.evidence.coreFreshnessState).toBe("unknown");
  });
});
