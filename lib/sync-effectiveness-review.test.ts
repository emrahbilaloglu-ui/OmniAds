import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGlobalRebuildTruthReview,
  type MetaProtectedPublishedTruthReview,
} from "@/lib/rebuild-truth-review";
import { buildSyncEffectivenessReview } from "@/lib/sync-effectiveness-review";

function buildMetaProtectedTruth(
  overrides: Partial<MetaProtectedPublishedTruthReview> = {},
): MetaProtectedPublishedTruthReview {
  return {
    runtimeAvailable: true,
    asOfDate: "2026-04-14",
    scope: {
      kind: "all_businesses",
      businessIds: null,
    },
    hasNonZeroProtectedPublishedRows: false,
    protectedPublishedRows: 0,
    activePublicationPointerRows: 0,
    protectedTruthClassesPresent: [],
    protectedTruthClassesAbsent: [
      "core_daily_rows",
      "breakdown_daily_rows",
      "active_publication_pointers",
      "active_published_slice_versions",
      "active_source_manifests",
      "published_day_state",
    ],
    classes: [],
    ...overrides,
  };
}

describe("buildSyncEffectivenessReview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not present Google cold bootstrap as healthy sync", () => {
    const globalRebuildReview = buildGlobalRebuildTruthReview({
      googleBusinesses: [
        {
          businessId: "biz_google_cold",
          queueDepth: 8,
          leasedPartitions: 1,
          deadLetterPartitions: 0,
          campaignCompletedDays: 0,
          searchTermCompletedDays: 0,
          productCompletedDays: 0,
          assetCompletedDays: 0,
          recentExtendedReady: false,
          historicalExtendedReady: false,
        },
      ],
      metaBusinesses: [],
      googleExecution: {
        sync: "global_backfill",
        retentionEnabled: false,
      },
      metaExecution: {
        authoritativeFinalizationEnabled: true,
        retentionEnabled: false,
      },
      metaProtectedPublishedTruth: buildMetaProtectedTruth(),
    });

    const review = buildSyncEffectivenessReview({
      globalRebuildReview,
      googleBusinesses: [
        {
          businessId: "biz_google_cold",
          progressState: "partial_stuck",
          lastProgressHeartbeatAt: "2026-04-14T11:20:00.000Z",
        },
      ],
      metaBusinesses: [],
      capturedAt: "2026-04-14T12:00:00.000Z",
    });

    expect(review.googleAds.summaryState).toBe("sparse_due_to_rebuild");
    expect(review.googleAds.freshness.mostRecentTrustedDay).toBeNull();
    expect(review.googleAds.freshness.warehouseReadyThroughDay).toBeNull();
    expect(review.googleAds.coverage.rebuildState).toBe("cold_bootstrap");
    expect(review.googleAds.summary).toContain("cold bootstrap");
  });

  it("keeps Google quota pressure visible and does not overclaim hot-window support", () => {
    const globalRebuildReview = buildGlobalRebuildTruthReview({
      googleBusinesses: [
        {
          businessId: "biz_google_quota",
          queueDepth: 5,
          leasedPartitions: 0,
          deadLetterPartitions: 0,
          campaignCompletedDays: 120,
          searchTermCompletedDays: 30,
          productCompletedDays: 30,
          assetCompletedDays: 30,
          recentExtendedReady: false,
          historicalExtendedReady: false,
          quotaLimitedEvidence: true,
          quotaPressure: 0.94,
          quotaErrorCount: 7,
          recoveryMode: "half_open",
        },
      ],
      metaBusinesses: [],
      googleExecution: {
        sync: "global_backfill",
        retentionEnabled: false,
      },
      metaExecution: {
        authoritativeFinalizationEnabled: true,
        retentionEnabled: false,
      },
      metaProtectedPublishedTruth: buildMetaProtectedTruth(),
    });

    const review = buildSyncEffectivenessReview({
      globalRebuildReview,
      googleBusinesses: [
        {
          businessId: "biz_google_quota",
          progressState: "partial_stuck",
          quotaLimitedEvidence: true,
          campaignReadyThroughDate: "2026-04-12",
          searchTermReadyThroughDate: "2026-04-01",
          productReadyThroughDate: "2026-04-01",
          assetReadyThroughDate: "2026-04-01",
          searchTermCompletedDays: 30,
          productCompletedDays: 30,
          assetCompletedDays: 30,
          lastProgressHeartbeatAt: "2026-04-14T10:00:00.000Z",
        },
      ],
      metaBusinesses: [],
      capturedAt: "2026-04-14T12:00:00.000Z",
    });

    expect(review.googleAds.summaryState).toBe("stalled_by_quota");
    expect(review.googleAds.quota.quotaPressurePresent).toBe(true);
    expect(review.googleAds.quota.suggestsQuotaStall).toBe(true);
    expect(review.googleAds.truthHealth.currentHotWindowSupportBusinesses).toBe(0);
    expect(review.googleAds.freshness.mostRecentTrustedDay).toBeNull();
    expect(review.googleAds.freshness.warehouseReadyThroughDay).toBe("2026-04-12");
  });

  it("reports Meta protected truth honestly when rebuild is still incomplete", () => {
    const globalRebuildReview = buildGlobalRebuildTruthReview({
      googleBusinesses: [],
      metaBusinesses: [
        {
          businessId: "biz_meta_backfill",
          queueDepth: 6,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          staleLeasePartitions: 0,
          deadLetterPartitions: 0,
          stateRowCount: 3,
          todayAccountRows: 0,
          todayAdsetRows: 0,
          accountCompletedDays: 30,
          adsetCompletedDays: 30,
          creativeCompletedDays: 10,
          recentExtendedReady: false,
          historicalExtendedReady: false,
          progressState: "partial_stuck",
        },
      ],
      googleExecution: {
        sync: "global_backfill",
        retentionEnabled: false,
      },
      metaExecution: {
        authoritativeFinalizationEnabled: true,
        retentionEnabled: false,
      },
      metaProtectedPublishedTruth: buildMetaProtectedTruth({
        activePublicationPointerRows: 2,
      }),
    });

    const review = buildSyncEffectivenessReview({
      globalRebuildReview,
      googleBusinesses: [],
      metaBusinesses: [
        {
          businessId: "biz_meta_backfill",
          progressState: "partial_stuck",
          accountReadyThroughDate: "2026-04-10",
          adsetReadyThroughDate: "2026-04-10",
          creativeReadyThroughDate: "2026-04-07",
          adReadyThroughDate: "2026-04-07",
          lastProgressHeartbeatAt: "2026-04-14T10:00:00.000Z",
        },
      ],
      capturedAt: "2026-04-14T12:00:00.000Z",
    });

    expect(review.meta.truthHealth.protectedPublishedTruthState).toBe("rebuild_incomplete");
    expect(review.meta.freshness.mostRecentTrustedDay).toBeNull();
    expect(review.meta.freshness.warehouseReadyThroughDay).toBe("2026-04-10");
    expect(review.meta.summaryState).toBe("stable_but_incomplete");
    expect(review.meta.summary).toContain("protected published truth");
  });

  it("reports Google current support only when 84-day rebuilt support is actually present", () => {
    const globalRebuildReview = buildGlobalRebuildTruthReview({
      googleBusinesses: [
        {
          businessId: "biz_google_ready",
          queueDepth: 0,
          leasedPartitions: 0,
          deadLetterPartitions: 0,
          campaignCompletedDays: 365,
          searchTermCompletedDays: 365,
          productCompletedDays: 365,
          assetCompletedDays: 365,
          recentExtendedReady: true,
          historicalExtendedReady: true,
        },
      ],
      metaBusinesses: [],
      googleExecution: {
        sync: "global_backfill",
        retentionEnabled: false,
      },
      metaExecution: {
        authoritativeFinalizationEnabled: true,
        retentionEnabled: false,
      },
      metaProtectedPublishedTruth: buildMetaProtectedTruth(),
    });

    const review = buildSyncEffectivenessReview({
      globalRebuildReview,
      googleBusinesses: [
        {
          businessId: "biz_google_ready",
          progressState: "ready",
          campaignReadyThroughDate: "2026-04-13",
          searchTermReadyThroughDate: "2026-04-13",
          productReadyThroughDate: "2026-04-13",
          assetReadyThroughDate: "2026-04-13",
          searchTermCompletedDays: 365,
          productCompletedDays: 365,
          assetCompletedDays: 365,
          lastProgressHeartbeatAt: "2026-04-14T11:50:00.000Z",
        },
      ],
      metaBusinesses: [],
      capturedAt: "2026-04-14T12:00:00.000Z",
    });

    expect(review.googleAds.truthHealth.currentHotWindowSupportBusinesses).toBe(1);
    expect(review.googleAds.freshness.mostRecentTrustedDay).toBe("2026-04-13");
    expect(review.googleAds.freshness.lagDays).toBe(1);
    expect(review.googleAds.summaryState).toBe("ready_with_current_support");
  });

  it("reports Meta ready only when protected published truth is visible and non-zero", () => {
    const globalRebuildReview = buildGlobalRebuildTruthReview({
      googleBusinesses: [],
      metaBusinesses: [
        {
          businessId: "biz_meta_ready",
          queueDepth: 0,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          staleLeasePartitions: 0,
          deadLetterPartitions: 0,
          stateRowCount: 5,
          todayAccountRows: 5,
          todayAdsetRows: 5,
          accountCompletedDays: 365,
          adsetCompletedDays: 365,
          creativeCompletedDays: 455,
          recentExtendedReady: true,
          historicalExtendedReady: true,
          progressState: "ready",
        },
      ],
      googleExecution: {
        sync: "global_backfill",
        retentionEnabled: false,
      },
      metaExecution: {
        authoritativeFinalizationEnabled: true,
        retentionEnabled: false,
      },
      metaProtectedPublishedTruth: buildMetaProtectedTruth({
        hasNonZeroProtectedPublishedRows: true,
        protectedPublishedRows: 42,
        activePublicationPointerRows: 7,
        protectedTruthClassesPresent: ["core_daily_rows", "active_publication_pointers"],
        protectedTruthClassesAbsent: [
          "breakdown_daily_rows",
          "active_published_slice_versions",
          "active_source_manifests",
          "published_day_state",
        ],
        classes: [
          {
            key: "core_daily_rows",
            label: "Protected core daily rows",
            present: true,
            observed: true,
            protectedRows: 42,
            latestProtectedValue: "2026-04-13",
          },
        ],
      }),
    });

    const review = buildSyncEffectivenessReview({
      globalRebuildReview,
      googleBusinesses: [],
      metaBusinesses: [
        {
          businessId: "biz_meta_ready",
          progressState: "ready",
          accountReadyThroughDate: "2026-04-13",
          adsetReadyThroughDate: "2026-04-13",
          creativeReadyThroughDate: "2026-04-13",
          adReadyThroughDate: "2026-04-13",
          lastSuccessfulPublishAt: "2026-04-14T06:00:00.000Z",
        },
      ],
      capturedAt: "2026-04-14T12:00:00.000Z",
    });

    expect(review.meta.truthHealth.protectedPublishedTruthState).toBe("present");
    expect(review.meta.freshness.mostRecentTrustedDay).toBe("2026-04-13");
    expect(review.meta.freshness.lagDays).toBe(1);
    expect(review.meta.summaryState).toBe("ready_with_current_support");
  });
});
