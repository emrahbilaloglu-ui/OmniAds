import { describe, expect, it } from "vitest";
import { resolveGoogleAdsControlPlaneSyncTruth } from "@/lib/google-ads/control-plane-runtime";

describe("resolveGoogleAdsControlPlaneSyncTruth", () => {
  const now = Date.parse("2026-04-20T07:20:00.000Z");

  it("treats stale cancelled latest rows as succeeded when queue is empty and scope sync is fresh", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "cancelled",
        queueDepth: 0,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: [
          {
            businessId: "biz-1",
            providerAccountId: "acct-1",
            scope: "account_daily",
            historicalTargetStart: "2026-04-01",
            historicalTargetEnd: "2026-04-19",
            effectiveTargetStart: "2026-04-13",
            effectiveTargetEnd: "2026-04-19",
            latestSuccessfulSyncAt: "2026-04-20T07:16:00.000Z",
            completedDays: 7,
            deadLetterCount: 0,
          },
        ],
      }),
    ).toMatchObject({
      effectiveLatestSyncStatus: "succeeded",
      hasRecentSuccessfulScopeSync: true,
      coreServingReady: false,
      fullyReady: true,
    });
  });

  it("separates core serving readiness from unfinished background queue", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "succeeded",
        queueDepth: 42,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: [
          {
            businessId: "biz-1",
            providerAccountId: "acct-1",
            scope: "account_daily",
            historicalTargetStart: "2026-04-01",
            historicalTargetEnd: "2026-04-19",
            effectiveTargetStart: "2026-04-13",
            effectiveTargetEnd: "2026-04-19",
            latestSuccessfulSyncAt: "2026-04-20T07:16:00.000Z",
            completedDays: 7,
            deadLetterCount: 0,
          },
          {
            businessId: "biz-1",
            providerAccountId: "acct-1",
            scope: "campaign_daily",
            historicalTargetStart: "2026-04-01",
            historicalTargetEnd: "2026-04-19",
            effectiveTargetStart: "2026-04-13",
            effectiveTargetEnd: "2026-04-19",
            latestSuccessfulSyncAt: "2026-04-20T07:17:00.000Z",
            completedDays: 7,
            deadLetterCount: 0,
          },
        ],
      }),
    ).toMatchObject({
      coreServingReady: true,
      servingReady: true,
      fullyReady: false,
    });
  });

  it("treats stale cancelled latest rows as ready when core serving scopes are complete and queue is drained", () => {
    expect(
      resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus: "cancelled",
        queueDepth: 0,
        deadLetterPartitions: 0,
        nowMs: now,
        scopeStates: [
          {
            businessId: "biz-1",
            providerAccountId: "acct-1",
            scope: "account_daily",
            historicalTargetStart: "2026-04-01",
            historicalTargetEnd: "2026-04-19",
            effectiveTargetStart: "2026-04-13",
            effectiveTargetEnd: "2026-04-19",
            latestSuccessfulSyncAt: "2026-04-20T06:00:00.000Z",
            completedDays: 7,
            deadLetterCount: 0,
          },
          {
            businessId: "biz-1",
            providerAccountId: "acct-1",
            scope: "campaign_daily",
            historicalTargetStart: "2026-04-01",
            historicalTargetEnd: "2026-04-19",
            effectiveTargetStart: "2026-04-13",
            effectiveTargetEnd: "2026-04-19",
            latestSuccessfulSyncAt: "2026-04-20T06:00:00.000Z",
            completedDays: 7,
            deadLetterCount: 0,
          },
        ],
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
        scopeStates: [
          {
            businessId: "biz-1",
            providerAccountId: "acct-1",
            scope: "campaign_daily",
            historicalTargetStart: "2026-04-01",
            historicalTargetEnd: "2026-04-19",
            effectiveTargetStart: "2026-04-13",
            effectiveTargetEnd: "2026-04-19",
            latestSuccessfulSyncAt: "2026-04-20T07:16:00.000Z",
            completedDays: 7,
            deadLetterCount: 0,
          },
        ],
      }),
    ).toMatchObject({
      effectiveLatestSyncStatus: "failed",
      fullyReady: false,
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
          {
            businessId: "biz-1",
            providerAccountId: "acct-1",
            scope: "product_daily",
            historicalTargetStart: "2026-04-01",
            historicalTargetEnd: "2026-04-19",
            effectiveTargetStart: "2026-04-13",
            effectiveTargetEnd: "2026-04-19",
            latestSuccessfulSyncAt: "2026-04-20T06:00:00.000Z",
            completedDays: 7,
            deadLetterCount: 0,
          },
        ],
      }),
    ).toMatchObject({
      effectiveLatestSyncStatus: "cancelled",
      hasRecentSuccessfulScopeSync: false,
      fullyReady: false,
    });
  });
});
