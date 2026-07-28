import { describe, expect, it } from "vitest";
import {
  buildAdminAuthHealth,
  buildAdminRevenueRisk,
  buildAdminSyncHealth,
} from "@/lib/admin-operations-health";

describe("buildAdminAuthHealth", () => {
  it("classifies only confirmed auth failures as issues", () => {
    const payload = buildAdminAuthHealth([
      {
        business_id: "biz-1",
        business_name: "Acme",
        provider: "google",
        status: "connected",
        refresh_token: null,
        token_expires_at: "2026-03-20T10:00:00.000Z",
        scopes: "openid profile",
        error_message: null,
        updated_at: "2026-03-21T10:00:00.000Z",
      },
    ]);

    expect(payload.summary.affectedBusinesses).toBe(1);
    expect(payload.summary.expiredTokens).toBe(1);
    expect(payload.summary.missingRefreshTokens).toBe(1);
    expect(payload.summary.missingScopes).toBe(1);
    expect(payload.summary.topIssue).toBeTruthy();
    expect(payload.summary.expiringSoon).toBe(0);
    expect(payload.issues).toHaveLength(2);
  });

  it("does not flag Google-family expired access tokens when refresh is available", () => {
    const payload = buildAdminAuthHealth([
      {
        business_id: "biz-2",
        business_name: "Beta",
        provider: "google",
        status: "connected",
        refresh_token: "refresh-token",
        token_expires_at: "2026-03-20T10:00:00.000Z",
        scopes: "https://www.googleapis.com/auth/adwords",
        error_message: null,
        updated_at: "2026-03-21T10:00:00.000Z",
      },
    ]);

    expect(payload.summary.expiredTokens).toBe(0);
    expect(payload.summary.affectedBusinesses).toBe(0);
    expect(payload.issues).toHaveLength(0);
  });
});

describe("buildAdminSyncHealth", () => {
  it("tracks failed jobs, stuck jobs, and active cooldowns", () => {
    const payload = buildAdminSyncHealth({
      jobs: [
        {
          business_id: "biz-1",
          business_name: "Acme",
          provider: "google_ads",
          report_type: "overview",
          status: "failed",
          error_message: "quota",
          triggered_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
        {
          business_id: "biz-2",
          business_name: "Beta",
          provider: "ga4",
          report_type: "ga4_overview",
          status: "running",
          error_message: null,
          triggered_at: "2026-03-21T10:00:00.000Z",
          started_at: "2026-03-21T10:00:00.000Z",
          completed_at: null,
        },
      ],
      cooldowns: [
        {
          business_id: "biz-3",
          business_name: "Gamma",
          provider: "search_console",
          request_type: "seo_overview",
          error_message: "cooldown",
          cooldown_until: new Date(Date.now() + 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });

    expect(payload.summary.failedJobs24h).toBe(1);
    expect(payload.summary.activeCooldowns).toBe(1);
    expect(payload.summary.impactedBusinesses).toBe(3);
    expect(payload.issues.some((issue) => issue.status === "cooldown")).toBe(true);
  });

  it("surfaces google ads breaker and compacted partition signals", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-g",
          business_name: "Grandmix",
          queue_depth: 12,
          leased_partitions: 0,
          dead_letter_partitions: 0,
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: new Date().toISOString(),
          campaign_completed_days: 10,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 2,
          product_completed_days: 1,
          active_circuit_breakers: 1,
          compacted_partitions: 44,
        },
      ],
      workerHealth: {
        onlineWorkers: 0,
        workerInstances: 0,
        lastHeartbeatAt: null,
        lastProgressHeartbeatAt: null,
        workers: [],
      },
    });

    expect(payload.summary.googleAdsCircuitBreakerBusinesses).toBe(1);
    expect(payload.summary.googleAdsCompactedPartitions).toBe(44);
    expect(payload.summary.googleAdsBudgetPressureMax).toBe(0);
    expect(payload.googleAdsBusinesses?.[0]?.circuitBreakerOpen).toBe(true);
    expect(payload.googleAdsBusinesses?.[0]?.compactedPartitions).toBe(44);
  });

  it("surfaces quota pressure and half-open recovery signals", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-half",
          business_name: "Half Open Co",
          queue_depth: 2,
          leased_partitions: 0,
          dead_letter_partitions: 0,
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: new Date().toISOString(),
          campaign_completed_days: 10,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 2,
          product_completed_days: 1,
          asset_completed_days: 3,
          active_circuit_breakers: 0,
          compacted_partitions: 4,
          quota_call_count: 3000,
          quota_error_count: 12,
          quota_budget: 5000,
          quota_pressure: 0.6,
          recovery_half_open: 1,
          recent_search_term_completed_days: 14,
          recent_product_completed_days: 14,
          recent_asset_completed_days: 14,
          recent_post_close_observed_days: 14,
          recent_range_total_days: 14,
        },
      ],
      workerHealth: {
        onlineWorkers: 1,
        workerInstances: 1,
        lastHeartbeatAt: new Date().toISOString(),
        lastProgressHeartbeatAt: null,
        workers: [],
      },
    });

    expect(payload.summary.googleAdsRecoveryBusinesses).toBe(1);
    expect(payload.summary.googleAdsBudgetPressureMax).toBe(0.6);
    expect(payload.googleAdsBusinesses?.[0]?.recoveryMode).toBe("half_open");
    expect(payload.googleAdsBusinesses?.[0]?.quotaPressure).toBe(0.6);
    expect(payload.googleAdsBusinesses?.[0]?.recentExtendedReady).toBe(true);
    expect(payload.googleAdsBusinesses?.[0]?.historicalExtendedReady).toBe(false);
    expect(payload.summary.googleAdsGlobalReopenEnabled).toBe(false);
    expect(payload.googleAdsBusinesses?.[0]?.effectiveMode).toBe("global_backfill");
  });

  it("refuses to call the recent extended window ready on coverage alone", () => {
    // The defect in fixture form: all three extended scopes have a row for
    // every one of the 14 days, and not one of those days was re-read after it
    // closed. This exact shape used to render the business fully ready.
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-frozen",
          business_name: "Frozen Co",
          queue_depth: 0,
          leased_partitions: 0,
          dead_letter_partitions: 0,
          oldest_queued_partition: null,
          latest_partition_activity_at: new Date().toISOString(),
          campaign_completed_days: 400,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 400,
          product_completed_days: 400,
          asset_completed_days: 400,
          active_circuit_breakers: 0,
          compacted_partitions: 0,
          recent_search_term_completed_days: 14,
          recent_product_completed_days: 14,
          recent_asset_completed_days: 14,
          recent_post_close_observed_days: 0,
          recent_range_total_days: 14,
        },
      ],
      workerHealth: {
        onlineWorkers: 1,
        workerInstances: 1,
        lastHeartbeatAt: new Date().toISOString(),
        lastProgressHeartbeatAt: null,
        workers: [],
      },
    });

    const business = payload.googleAdsBusinesses?.[0];
    expect(business?.recentExtendedReady).toBe(false);
    // Historical coverage is genuinely met, so the conjunction is what holds
    // "fully ready" back — proving the new leg is the one doing the work.
    expect(business?.historicalExtendedReady).toBe(true);
    expect(business?.progressState).not.toBe("ready");
  });

  it("becomes ready once those same days are re-read after closing", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-observed",
          business_name: "Observed Co",
          queue_depth: 0,
          leased_partitions: 0,
          dead_letter_partitions: 0,
          oldest_queued_partition: null,
          latest_partition_activity_at: new Date().toISOString(),
          campaign_completed_days: 400,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 400,
          product_completed_days: 400,
          asset_completed_days: 400,
          active_circuit_breakers: 0,
          compacted_partitions: 0,
          recent_search_term_completed_days: 14,
          recent_product_completed_days: 14,
          recent_asset_completed_days: 14,
          recent_post_close_observed_days: 14,
          recent_range_total_days: 14,
        },
      ],
      workerHealth: {
        onlineWorkers: 1,
        workerInstances: 1,
        lastHeartbeatAt: new Date().toISOString(),
        lastProgressHeartbeatAt: null,
        workers: [],
      },
    });

    expect(payload.googleAdsBusinesses?.[0]?.recentExtendedReady).toBe(true);
  });

  it("classifies google ads businesses as partial_stuck when backlog is idle without leases", () => {
    const staleActivity = new Date(Date.now() - 30 * 60_000).toISOString();
    const staleCheckpoint = new Date(Date.now() - 25 * 60_000).toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-stuck",
          business_name: "Stuck Co",
          queue_depth: 9,
          leased_partitions: 0,
          dead_letter_partitions: 0,
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: staleActivity,
          latest_checkpoint_updated_at: staleCheckpoint,
          campaign_completed_days: 10,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 2,
          product_completed_days: 1,
          asset_completed_days: 1,
          recent_range_total_days: 14,
          recent_search_term_completed_days: 3,
          recent_product_completed_days: 2,
          recent_asset_completed_days: 1,
        },
      ],
    });

    expect(payload.googleAdsBusinesses?.[0]?.progressState).toBe("partial_stuck");
  });

  it("classifies google ads businesses as partial_progressing when backlog is moving", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-progressing",
          business_name: "Moving Co",
          queue_depth: 6,
          leased_partitions: 0,
          dead_letter_partitions: 0,
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: recent,
          latest_checkpoint_updated_at: recent,
          campaign_completed_days: 40,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 10,
          product_completed_days: 10,
          asset_completed_days: 10,
          recent_range_total_days: 14,
          recent_search_term_completed_days: 12,
          recent_product_completed_days: 12,
          recent_asset_completed_days: 12,
        },
      ],
    });

    expect(payload.googleAdsBusinesses?.[0]?.progressState).toBe("partial_progressing");
  });

  it("counts classifier reclaim candidates as stuck work instead of stale provider running rows", () => {
    const staleRunningAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [
        {
          business_id: "biz-g",
          business_name: "Grandmix",
          provider: "google_ads",
          report_type: "campaign_daily",
          status: "running",
          error_message: null,
          triggered_at: staleRunningAt,
          started_at: staleRunningAt,
          completed_at: null,
        },
      ],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-g",
          business_name: "Grandmix",
          queue_depth: 4,
          leased_partitions: 3,
          dead_letter_partitions: 0,
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: staleRunningAt,
          latest_checkpoint_updated_at: staleRunningAt,
          campaign_completed_days: 10,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 2,
          product_completed_days: 1,
        },
      ],
      googleAdsReclaimSummaries: {
        "biz-g": {
          activeSlowPartitions: 1,
          reclaimCandidateCount: 2,
          poisonCandidateCount: 0,
        },
      },
    });

    expect(payload.summary.stuckJobs).toBe(2);
    expect(payload.googleAdsBusinesses?.[0]?.activeSlowPartitions).toBe(1);
    expect(payload.googleAdsBusinesses?.[0]?.reclaimCandidateCount).toBe(2);
  });

  it("suppresses stale reclaim, poison, and stale-checkpoint Google issues when live summaries are healthy", () => {
    const staleCheckpoint = new Date(Date.now() - 45 * 60_000).toISOString();
    const freshActivity = new Date().toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-g",
          business_name: "IwaStore",
          queue_depth: 9,
          leased_partitions: 7,
          dead_letter_partitions: 0,
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: freshActivity,
          latest_checkpoint_updated_at: staleCheckpoint,
          latest_checkpoint_phase: "finalize",
          campaign_completed_days: 90,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 14,
          product_completed_days: 14,
          asset_completed_days: 14,
          poisoned_checkpoint_count: 4,
          reclaim_candidate_count: 6,
        },
      ],
      googleAdsReclaimSummaries: {
        "biz-g": {
          activeSlowPartitions: 1,
          reclaimCandidateCount: 0,
          poisonCandidateCount: 0,
        },
      },
    });

    expect(payload.googleAdsBusinesses?.[0]?.reclaimCandidateCount).toBe(0);
    expect(payload.googleAdsBusinesses?.[0]?.poisonedCheckpointCount).toBe(0);
    expect(payload.googleAdsBusinesses?.[0]?.progressState).not.toBe("blocked");
    expect(payload.issues.some((issue) => issue.reportType === "stalled_reclaimable")).toBe(false);
    expect(payload.issues.some((issue) => issue.reportType === "poisoned_checkpoint")).toBe(false);
    expect(payload.issues.some((issue) => issue.reportType === "stale_checkpoint")).toBe(false);
  });

  it("surfaces lease-conflict and skipped-active-lease counters as actionable issues", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [
        {
          business_id: "biz-g",
          business_name: "Grandmix",
          queue_depth: 1,
          leased_partitions: 0,
          dead_letter_partitions: 0,
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: new Date().toISOString(),
          latest_checkpoint_updated_at: new Date().toISOString(),
          campaign_completed_days: 10,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 2,
          product_completed_days: 1,
          skipped_active_lease_recoveries: 3,
          lease_conflict_runs_24h: 2,
        },
      ],
    });

    expect(payload.summary.googleAdsSkippedActiveLeaseRecoveries).toBe(3);
    expect(payload.summary.googleAdsLeaseConflictRuns24h).toBe(2);
    expect(payload.issues.some((issue) => issue.reportType === "skipped_active_lease")).toBe(true);
    expect(payload.issues.some((issue) => issue.reportType === "lease_conflict_runs")).toBe(true);
    expect(
      payload.issues.find((issue) => issue.reportType === "lease_conflict_runs")?.severity
    ).toBe("critical");
    expect(
      payload.issues.find((issue) => issue.reportType === "lease_conflict_runs")?.runbookKey
    ).toBe("google_ads:lease_conflict");
  });

  it("surfaces meta recent frontier readiness separately from historical coverage", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "IwaStore",
          queue_depth: 18,
          leased_partitions: 2,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 4,
          current_day_reference: "2026-03-28",
          oldest_queued_partition: "2025-01-01",
          latest_partition_activity_at: new Date().toISOString(),
          latest_checkpoint_scope: "creative_daily",
          latest_checkpoint_phase: "transform",
          latest_checkpoint_updated_at: new Date().toISOString(),
          latest_progress_heartbeat_at: new Date().toISOString(),
          last_successful_page_index: 3,
          checkpoint_failures: 0,
          reclaim_candidate_count: 0,
          last_reclaim_reason: null,
          today_account_rows: 12,
          today_adset_rows: 21,
          account_completed_days: 400,
          adset_completed_days: 400,
          creative_completed_days: 120,
          ad_completed_days: 90,
          recent_account_completed_days: 14,
          recent_adset_completed_days: 14,
          recent_creative_completed_days: 14,
          recent_ad_completed_days: 14,
          recent_range_total_days: 14,
        },
      ],
      workerHealth: {
        onlineWorkers: 1,
        workerInstances: 1,
        lastHeartbeatAt: new Date().toISOString(),
        lastProgressHeartbeatAt: null,
        workers: [],
      },
    });

    expect(payload.metaBusinesses?.[0]?.recentExtendedReady).toBe(true);
    expect(payload.metaBusinesses?.[0]?.historicalExtendedReady).toBe(false);
    expect(payload.metaBusinesses?.[0]?.effectiveMode).toBe("extended_recovery");
  });

  it("separates terminal Meta account-action dead letters from replayable ones", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta-checkpoint",
          business_name: "Tiles Workshop",
          queue_depth: 0,
          leased_partitions: 0,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 1,
          state_row_count: 2,
          current_day_reference: "2026-05-07",
          oldest_queued_partition: null,
          latest_partition_activity_at: "2026-05-07T09:00:00.000Z",
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: "2026-05-07T09:00:00.000Z",
          latest_progress_heartbeat_at: "2026-05-07T09:00:00.000Z",
          last_successful_page_index: 1,
          checkpoint_failures: 1,
          today_account_rows: 0,
          today_adset_rows: 0,
          account_completed_days: 120,
          adset_completed_days: 120,
          creative_completed_days: 90,
          ad_completed_days: 90,
        },
      ],
      metaDeadLetterSummaries: {
        "biz-meta-checkpoint": {
          total: 1,
          replayableTransient: 0,
          terminalActionRequired: 1,
          unknown: 0,
          latest: [
            {
              id: "partition-1",
              businessId: "biz-meta-checkpoint",
              lane: "maintenance",
              scope: "account_daily",
              source: "finalize_day",
              partitionDate: "2026-05-07",
              lastError: "log in to www.facebook.com",
              errorClass: "account_checkpoint",
              recoveryKind: "terminal_action_required",
              actionRequired: true,
              reasonCode: "meta_account_checkpoint",
            },
          ],
        },
      },
    });

    expect(payload.metaBusinesses?.[0]).toMatchObject({
      deadLetterPartitions: 1,
      replayableDeadLetterPartitions: 0,
      terminalActionRequiredDeadLetterPartitions: 1,
    });
    expect(payload.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "meta",
          reportType: "account_action_required",
          detail: expect.stringContaining("Facebook/Meta login or reconnect"),
        }),
      ]),
    );
  });

  it("suppresses stale reclaim, stale-checkpoint, and current-day-missing Meta issues when live summaries are healthy", () => {
    const staleCheckpoint = new Date(Date.now() - 30 * 60_000).toISOString();
    const freshActivity = new Date().toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "TheSwaf",
          queue_depth: 144,
          leased_partitions: 4,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: null,
          oldest_queued_partition: "2024-05-15",
          latest_partition_activity_at: freshActivity,
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: staleCheckpoint,
          latest_progress_heartbeat_at: staleCheckpoint,
          last_successful_page_index: 0,
          checkpoint_failures: 0,
          reclaim_candidate_count: 3,
          last_reclaim_reason: "historical_finalize_misclassified",
          today_account_rows: 0,
          today_adset_rows: 0,
          account_completed_days: 730,
          adset_completed_days: 730,
          creative_completed_days: 120,
          ad_completed_days: 120,
          recent_account_completed_days: 14,
          recent_adset_completed_days: 14,
          recent_creative_completed_days: 14,
          recent_ad_completed_days: 14,
          recent_range_total_days: 14,
        },
      ],
      metaReclaimSummaries: {
        "biz-meta": {
          activeSlowPartitions: 1,
          reclaimCandidateCount: 0,
        },
      },
    });

    expect(payload.metaBusinesses?.[0]?.reclaimCandidateCount).toBe(0);
    expect(payload.metaBusinesses?.[0]?.progressState).not.toBe("blocked");
    expect(payload.issues.some((issue) => issue.reportType === "stalled_reclaimable")).toBe(false);
    expect(payload.issues.some((issue) => issue.reportType === "stale_checkpoint")).toBe(false);
    expect(payload.issues.some((issue) => issue.reportType === "current_day_missing")).toBe(false);
  });

  it("prefers authoritative Meta D-1 status over raw nonterminal partition counters", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "IwaStore",
          queue_depth: 3,
          leased_partitions: 1,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: "2026-04-07",
          oldest_queued_partition: "2026-04-07",
          latest_partition_activity_at: new Date().toISOString(),
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: new Date().toISOString(),
          latest_progress_heartbeat_at: new Date().toISOString(),
          last_successful_page_index: 1,
          checkpoint_failures: 0,
          reclaim_candidate_count: 0,
          today_account_rows: 2,
          today_adset_rows: 2,
          account_completed_days: 100,
          adset_completed_days: 100,
          creative_completed_days: 80,
          ad_completed_days: 80,
          recent_account_completed_days: 14,
          recent_adset_completed_days: 14,
          recent_creative_completed_days: 14,
          recent_ad_completed_days: 14,
          recent_range_total_days: 14,
        },
      ],
      metaAuthoritativeSnapshots: [
        {
          businessId: "biz-meta",
          capturedAt: "2026-04-08T22:00:00.000Z",
          manifestCounts: {
            pending: 0,
            running: 0,
            completed: 2,
            failed: 0,
            superseded: 0,
            total: 2,
          },
          progression: {
            queued: 3,
            leased: 1,
            published: 2,
            retryableFailed: 0,
            deadLetter: 0,
            staleLeases: 0,
            repairBacklog: 1,
          },
          latestPublishes: [],
          d1FinalizeSla: {
            totalAccounts: 1,
            breachedAccounts: 0,
            accounts: [
              {
                providerAccountId: "act_1",
                accountTimezone: "UTC",
                expectedDay: "2026-04-07",
                verificationState: "finalized_verified",
                publishedAt: "2026-04-08T21:55:00.000Z",
                breached: false,
              },
            ],
          },
          validationFailures24h: 0,
          recentFailures: [],
          lastSuccessfulPublishAt: "2026-04-08T21:55:00.000Z",
        },
      ],
      metaD1FinalizeNonTerminalCounts: {
        "biz-meta": 1,
      },
    });

    expect(payload.summary.metaD1FinalizeNonTerminalCount).toBe(0);
    expect(payload.metaBusinesses?.[0]?.d1FinalizeNonTerminalCount).toBe(0);
    expect(payload.issues.some((issue) => issue.reportType === "d1_finalize_nonterminal")).toBe(false);
  });

  it("surfaces meta stale-run and skipped-active-lease counters as actionable issues", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "IwaStore",
          queue_depth: 3,
          leased_partitions: 0,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: "2026-03-28",
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: new Date().toISOString(),
          latest_checkpoint_scope: null,
          latest_checkpoint_phase: null,
          latest_checkpoint_updated_at: new Date().toISOString(),
          latest_progress_heartbeat_at: null,
          last_successful_page_index: null,
          checkpoint_failures: 0,
          today_account_rows: 12,
          today_adset_rows: 21,
          account_completed_days: 30,
          adset_completed_days: 30,
          creative_completed_days: 10,
          ad_completed_days: 8,
          skipped_active_lease_recoveries: 4,
          stale_run_count_24h: 2,
        },
      ],
    });

    expect(payload.summary.metaSkippedActiveLeaseRecoveries).toBe(4);
    expect(payload.summary.metaStaleRunCount24h).toBe(2);
    expect(payload.issues.some((issue) => issue.reportType === "skipped_active_lease")).toBe(true);
    expect(payload.issues.some((issue) => issue.reportType === "stale_runs")).toBe(true);
    expect(payload.issues.find((issue) => issue.reportType === "stale_runs")?.severity).toBe(
      "critical"
    );
    expect(payload.issues.find((issue) => issue.reportType === "stale_runs")?.runbookKey).toBe(
      "meta:stale_run"
    );
  });

  it("does not treat meta stale-run history as an active blocker by itself", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta-history",
          business_name: "Meta History",
          queue_depth: 0,
          leased_partitions: 0,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: "2026-03-28",
          oldest_queued_partition: null,
          latest_partition_activity_at: new Date().toISOString(),
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: new Date().toISOString(),
          latest_progress_heartbeat_at: new Date().toISOString(),
          last_successful_page_index: 3,
          checkpoint_failures: 0,
          today_account_rows: 12,
          today_adset_rows: 12,
          account_completed_days: 400,
          account_ready_through_date: "2026-03-28",
          adset_completed_days: 400,
          adset_ready_through_date: "2026-03-28",
          creative_completed_days: 455,
          creative_ready_through_date: "2026-03-28",
          ad_completed_days: 365,
          ad_ready_through_date: "2026-03-28",
          recent_account_completed_days: 14,
          recent_adset_completed_days: 14,
          recent_creative_completed_days: 14,
          recent_ad_completed_days: 14,
          recent_range_total_days: 14,
          skipped_active_lease_recoveries: 0,
          stale_run_count_24h: 2,
        },
      ],
    });

    expect(payload.metaBusinesses?.[0]?.progressState).not.toBe("blocked");
    expect(payload.metaBusinesses?.[0]?.activityState).not.toBe("blocked");
    expect(payload.metaBusinesses?.[0]?.blockerClass).not.toBe("queue_blocked");
    expect(payload.issues.some((issue) => issue.reportType === "stale_runs")).toBe(true);
  });

  it("classifies meta businesses as partial_stuck when backlog is idle without leases", () => {
    const staleActivity = new Date(Date.now() - 30 * 60_000).toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta-stuck",
          business_name: "Meta Stuck",
          queue_depth: 5,
          leased_partitions: 0,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: "2026-03-28",
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: staleActivity,
          latest_checkpoint_scope: null,
          latest_checkpoint_phase: null,
          latest_checkpoint_updated_at: staleActivity,
          latest_progress_heartbeat_at: null,
          last_successful_page_index: null,
          checkpoint_failures: 0,
          today_account_rows: 12,
          today_adset_rows: 12,
          account_completed_days: 50,
          adset_completed_days: 50,
          creative_completed_days: 10,
          ad_completed_days: 10,
          recent_account_completed_days: 10,
          recent_adset_completed_days: 10,
          recent_creative_completed_days: 10,
          recent_ad_completed_days: 10,
          recent_range_total_days: 14,
        },
      ],
    });

    expect(payload.metaBusinesses?.[0]?.progressState).toBe("partial_stuck");
  });

  it("keeps matched worker empty when only an unrelated Meta worker is online", () => {
    const staleActivity = new Date(Date.now() - 30 * 60_000).toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta-stuck",
          business_name: "Meta Stuck",
          queue_depth: 5,
          leased_partitions: 0,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: "2026-03-28",
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: staleActivity,
          latest_checkpoint_scope: null,
          latest_checkpoint_phase: null,
          latest_checkpoint_updated_at: staleActivity,
          latest_progress_heartbeat_at: null,
          last_successful_page_index: null,
          checkpoint_failures: 0,
          today_account_rows: 12,
          today_adset_rows: 12,
          account_completed_days: 50,
          adset_completed_days: 50,
          creative_completed_days: 10,
          ad_completed_days: 10,
          recent_account_completed_days: 10,
          recent_adset_completed_days: 10,
          recent_creative_completed_days: 10,
          recent_ad_completed_days: 10,
          recent_range_total_days: 14,
        },
      ],
      workerHealth: {
        onlineWorkers: 1,
        workerInstances: 1,
        lastHeartbeatAt: new Date().toISOString(),
        lastProgressHeartbeatAt: null,
        workers: [
          {
            workerId: "worker-1:meta",
            instanceType: "durable_sync_worker",
            providerScope: "meta",
            workerFreshnessState: "online",
            status: "running",
            lastHeartbeatAt: new Date().toISOString(),
            lastBusinessId: "other-biz",
            lastPartitionId: "partition-1",
            lastConsumedBusinessId: "other-biz",
            lastConsumeOutcome: "consume_succeeded",
            lastConsumeFinishedAt: new Date().toISOString(),
            metaJson: {
              currentBusinessId: "other-biz",
              consumeStage: "consume_started",
            },
          },
        ],
      },
    });

    expect(payload.summary.workerOnline).toBe(true);
    expect(payload.metaBusinesses?.[0]).toMatchObject({
      workerOnline: true,
      workerId: null,
    });
    expect(payload.metaBusinesses?.[0]?.stallFingerprints).not.toContain("worker_unavailable");
    expect(
      payload.issues.find((issue) => issue.reportType === "queue_waiting_worker")?.detail,
    ).toContain("despite fresh Meta worker availability");
    expect(payload.dbDiagnostics?.summary.likelyPrimaryConstraint).toBe("unknown");
  });

  it("surfaces meta forward-progress evidence and activity state", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta-progress",
          business_name: "Meta Moving",
          queue_depth: 7,
          leased_partitions: 2,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 3,
          current_day_reference: "2026-03-28",
          oldest_queued_partition: "2026-03-20",
          latest_partition_activity_at: recent,
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: recent,
          latest_progress_heartbeat_at: recent,
          last_successful_page_index: 2,
          checkpoint_failures: 0,
          today_account_rows: 12,
          today_adset_rows: 12,
          account_completed_days: 50,
          account_ready_through_date: "2026-03-20",
          adset_completed_days: 50,
          adset_ready_through_date: "2026-03-20",
          creative_completed_days: 14,
          creative_ready_through_date: "2026-03-20",
          ad_completed_days: 14,
          ad_ready_through_date: "2026-03-20",
          recent_account_completed_days: 10,
          recent_adset_completed_days: 10,
          recent_creative_completed_days: 10,
          recent_ad_completed_days: 10,
          recent_range_total_days: 14,
        },
      ],
    });

    expect(payload.metaBusinesses?.[0]?.progressState).toBe("syncing");
    expect(payload.metaBusinesses?.[0]?.activityState).toBe("busy");
    expect(payload.metaBusinesses?.[0]?.progressEvidence).toMatchObject({
      lastCheckpointAdvancedAt: recent,
      lastCompletedAt: recent,
      lastReadyThroughAdvancedAt: recent,
    });
  });

  it("attaches recent Meta phase timing summaries to each business", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta-timing",
          business_name: "Meta Timing",
          queue_depth: 1,
          leased_partitions: 1,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 1,
          current_day_reference: "2026-03-28",
          oldest_queued_partition: "2026-03-28",
          latest_partition_activity_at: "2026-03-28T09:00:00.000Z",
          latest_checkpoint_scope: "core_ad_insights",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: "2026-03-28T09:01:00.000Z",
          latest_progress_heartbeat_at: "2026-03-28T09:01:00.000Z",
          last_successful_page_index: 3,
          checkpoint_failures: 0,
          today_account_rows: 8,
          today_adset_rows: 8,
          account_completed_days: 20,
          account_ready_through_date: "2026-03-28",
          adset_completed_days: 20,
          adset_ready_through_date: "2026-03-28",
          creative_completed_days: 20,
          creative_ready_through_date: "2026-03-28",
          ad_completed_days: 20,
          ad_ready_through_date: "2026-03-28",
          recent_account_completed_days: 14,
          recent_adset_completed_days: 14,
          recent_creative_completed_days: 14,
          recent_ad_completed_days: 14,
          recent_range_total_days: 14,
        },
      ],
      metaPhaseTimingWindowHours: 24,
      metaPhaseTimingSummariesByBusiness: {
        "biz-meta-timing": [
          {
            phase: "fetch_raw",
            runCount: 8,
            timingScope: "fetch_raw:core_ad_insights",
            latestFinishedAt: "2026-03-28T09:00:59.000Z",
            latestDurationMs: 1490,
            avgDurationMs: 1600,
            p50DurationMs: 1520,
            p95DurationMs: 2400,
            maxDurationMs: 2600,
            throughputBasis: "rows_fetched",
            latestRowsFetched: 5166,
            latestRowsWritten: 0,
            latestRowsPerSecond: 3467,
            p50RowsPerSecond: 3200,
          },
        ],
      },
    });

    expect(payload.metaBusinesses?.[0]?.phaseTimings).toEqual({
      windowHours: 24,
      phases: [
        expect.objectContaining({
          phase: "fetch_raw",
          p50DurationMs: 1520,
          latestRowsPerSecond: 3467,
        }),
      ],
    });
  });

  it("keeps lightweight google ads summary when detailed health is degraded", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealth: [],
      googleAdsHealthStatus: "degraded",
      googleAdsHealthError: "Database query timed out",
      googleAdsHealthSummary: {
        queueDepth: 12,
        leasedPartitions: 3,
        deadLetterPartitions: 8,
        oldestQueuedPartition: "2026-03-20",
      },
      workerHealth: {
        onlineWorkers: 1,
        workerInstances: 1,
        lastHeartbeatAt: new Date().toISOString(),
        lastProgressHeartbeatAt: null,
        workers: [],
      },
    });

    expect(payload.googleAdsHealthStatus).toBe("degraded");
    expect(payload.googleAdsHealthError).toBe("Database query timed out");
    expect(payload.summary.googleAdsQueueDepth).toBe(12);
    expect(payload.summary.googleAdsLeasedPartitions).toBe(3);
    expect(payload.summary.googleAdsDeadLetterPartitions).toBe(8);
    expect(payload.summary.googleAdsOldestQueuedPartition).toBe("2026-03-20");
    expect(payload.summary.topIssue).toBe("Google Ads health unavailable");
  });

  it("degrades google ads health when terminal account action is required", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      googleAdsHealthStatus: "ok",
      googleAdsHealth: [
        {
          business_id: "biz-action",
          business_name: "IwaStore",
          queue_depth: 1690,
          leased_partitions: 0,
          dead_letter_partitions: 3,
          oldest_queued_partition: "2026-04-18",
          latest_partition_activity_at: "2026-05-19T10:00:00.000Z",
          campaign_completed_days: 0,
          campaign_dead_letter_count: 0,
          search_term_completed_days: 0,
          product_completed_days: 0,
          asset_completed_days: 0,
        },
      ],
      googleAdsQueueHealthByBusiness: {
        "biz-action": {
          actionRequiredDeadLetterPartitions: 3,
          actionRequiredBlockingDeadLetterPartitions: 3,
          actionRequiredDeadLetterScopes: [
            "ad_daily",
            "asset_group_daily",
            "keyword_daily",
          ],
          actionRequiredBlockingDeadLetterScopes: [
            "ad_daily",
            "asset_group_daily",
            "keyword_daily",
          ],
        } as never,
      },
    });

    expect(payload.googleAdsHealthStatus).toBe("degraded");
    expect(payload.summary.googleAdsActionRequiredBusinessCount).toBe(1);
    expect(payload.summary.googleAdsActionRequiredPartitions).toBe(3);
    expect(payload.summary.googleAdsActionRequiredBlockingScopes).toEqual([
      "ad_daily",
      "asset_group_daily",
      "keyword_daily",
    ]);
    expect(
      payload.issues.some((issue) => issue.reportType === "account_action_required"),
    ).toBe(true);
    expect(payload.googleAdsBusinesses?.[0]?.actionRequiredDeadLetterPartitions).toBe(3);
  });

  it("surfaces authoritative meta publish, sla, and failure provenance", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "IwaStore",
          queue_depth: 4,
          leased_partitions: 1,
          retryable_failed_partitions: 1,
          stale_lease_partitions: 1,
          dead_letter_partitions: 1,
          state_row_count: 3,
          current_day_reference: "2026-04-05",
          oldest_queued_partition: "2026-04-04",
          latest_partition_activity_at: "2026-04-05T09:00:00.000Z",
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: "2026-04-05T09:05:00.000Z",
          latest_progress_heartbeat_at: "2026-04-05T09:05:00.000Z",
          last_successful_page_index: 3,
          checkpoint_failures: 1,
          today_account_rows: 2,
          today_adset_rows: 2,
          account_completed_days: 100,
          adset_completed_days: 100,
          creative_completed_days: 80,
          ad_completed_days: 80,
        },
      ],
      metaAuthoritativeSnapshots: [
        {
          businessId: "biz-meta",
          capturedAt: "2026-04-05T10:00:00.000Z",
          manifestCounts: {
            pending: 1,
            running: 0,
            completed: 3,
            failed: 1,
            superseded: 0,
            total: 5,
          },
          progression: {
            queued: 4,
            leased: 1,
            published: 7,
            retryableFailed: 1,
            deadLetter: 1,
            staleLeases: 1,
            repairBacklog: 3,
          },
          latestPublishes: [
            {
              providerAccountId: "act_1",
              day: "2026-04-04",
              surface: "account_daily",
              publishedAt: "2026-04-05T08:59:00.000Z",
              verificationState: "finalized_verified",
              sourceKind: "finalize_day",
              manifestFetchStatus: "completed",
            },
          ],
          d1FinalizeSla: {
            totalAccounts: 2,
            breachedAccounts: 1,
            accounts: [
              {
                providerAccountId: "act_1",
                accountTimezone: "UTC",
                expectedDay: "2026-04-04",
                verificationState: "finalized_verified",
                publishedAt: "2026-04-05T08:59:00.000Z",
                breached: false,
              },
              {
                providerAccountId: "act_2",
                accountTimezone: "UTC",
                expectedDay: "2026-04-04",
                verificationState: "repair_required",
                publishedAt: null,
                breached: true,
              },
            ],
          },
          validationFailures24h: 2,
          recentFailures: [
            {
              providerAccountId: "act_2",
              day: "2026-04-04",
              surface: "campaign_daily",
              result: "repair_required",
              eventKind: "totals_mismatch",
              severity: "error",
              reason: "campaign spend drift",
              createdAt: "2026-04-05T09:01:00.000Z",
            },
          ],
          lastSuccessfulPublishAt: "2026-04-05T08:59:00.000Z",
        },
      ],
    });

    expect(payload.summary.metaSourceManifestCount).toBe(5);
    expect(payload.summary.metaPublishedProgression).toBe(7);
    expect(payload.summary.metaValidationFailures24h).toBe(2);
    expect(payload.summary.metaRepairBacklog).toBe(3);
    expect(payload.summary.metaStaleLeasePartitions).toBe(1);
    expect(payload.summary.metaD1FinalizeSlaBreaches).toBe(1);
    expect(payload.summary.metaLastSuccessfulPublishAt).toBe("2026-04-05T08:59:00.000Z");
    expect(payload.metaBusinesses?.[0]?.sourceManifestCounts?.failed).toBe(1);
    expect(payload.metaBusinesses?.[0]?.latestAuthoritativePublishes?.[0]?.providerAccountId).toBe("act_1");
    expect(payload.metaBusinesses?.[0]?.d1FinalizeSla?.breachedAccounts).toBe(1);
    expect(payload.metaBusinesses?.[0]?.validationFailures24h).toBe(2);
    expect(payload.metaBusinesses?.[0]?.repairBacklog).toBe(3);
    expect(payload.metaBusinesses?.[0]?.lastSuccessfulPublishAt).toBe("2026-04-05T08:59:00.000Z");
  });

  it("surfaces Meta integrity blockers and D-1 finalize nonterminal counts", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "IwaStore",
          queue_depth: 2,
          leased_partitions: 1,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 3,
          current_day_reference: "2026-04-06",
          oldest_queued_partition: "2026-04-06",
          latest_partition_activity_at: "2026-04-07T09:00:00.000Z",
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "finalize",
          latest_checkpoint_updated_at: "2026-04-07T09:05:00.000Z",
          latest_progress_heartbeat_at: "2026-04-07T09:05:00.000Z",
          last_successful_page_index: 3,
          checkpoint_failures: 0,
          reclaim_candidate_count: 1,
          last_reclaim_reason: "lease_expired_no_progress",
          skipped_active_lease_recoveries: 0,
          stale_run_count_24h: 0,
          today_account_rows: 2,
          today_adset_rows: 2,
          account_completed_days: 100,
          adset_completed_days: 100,
          creative_completed_days: 80,
          ad_completed_days: 80,
        },
      ],
      metaAuthoritativeSnapshots: [
        {
          businessId: "biz-meta",
          capturedAt: "2026-04-07T10:00:00.000Z",
          manifestCounts: {
            pending: 1,
            running: 0,
            completed: 3,
            failed: 1,
            superseded: 0,
            total: 5,
          },
          progression: {
            queued: 2,
            leased: 1,
            published: 7,
            retryableFailed: 0,
            deadLetter: 0,
            staleLeases: 0,
            repairBacklog: 1,
          },
          latestPublishes: [],
          d1FinalizeSla: {
            totalAccounts: 1,
            breachedAccounts: 1,
            accounts: [
              {
                providerAccountId: "act_1",
                accountTimezone: "UTC",
                expectedDay: "2026-04-06",
                verificationState: "repair_required",
                publishedAt: null,
                breached: true,
              },
            ],
          },
          validationFailures24h: 1,
          recentFailures: [
            {
              providerAccountId: "act_1",
              day: "2026-04-06",
              surface: "account_daily",
              result: "repair_required",
              eventKind: "totals_mismatch",
              severity: "error",
              reason: "canonical drift",
              createdAt: "2026-04-07T09:06:00.000Z",
            },
          ],
          lastSuccessfulPublishAt: "2026-04-06T22:00:00.000Z",
        },
      ],
      metaIntegritySummaries: {
        "biz-meta": {
          incidentCount: 2,
          blockedCount: 1,
        },
      },
      metaD1FinalizeNonTerminalCounts: {
        "biz-meta": 2,
      },
      metaReclaimSummaries: {
        "biz-meta": {
          activeSlowPartitions: 0,
          reclaimCandidateCount: 1,
        },
      },
    });

    expect(payload.summary.metaIntegrityIncidentCount).toBe(2);
    expect(payload.summary.metaIntegrityBlockedCount).toBe(1);
    expect(payload.summary.metaD1FinalizeNonTerminalCount).toBe(1);
    expect(payload.metaBusinesses?.[0]?.integrityBlockedCount).toBe(1);
    expect(payload.metaBusinesses?.[0]?.d1FinalizeNonTerminalCount).toBe(1);
    expect(payload.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          businessId: "biz-meta",
          reportType: "integrity_blocked",
        }),
        expect.objectContaining({
          businessId: "biz-meta",
          reportType: "d1_finalize_nonterminal",
        }),
      ]),
    );
  });

  it("surfaces remediation summary and latest per-business remediation execution", () => {
    const now = "2026-04-15T12:00:00.000Z";
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      remediationSummary: {
        buildId: "build-1",
        environment: "production",
        providerScope: "meta",
        latestStartedAt: now,
        latestFinishedAt: now,
        improvedAny: true,
        businessCount: 1,
        counts: {
          cleared: 0,
          improving_not_cleared: 1,
          no_change: 0,
          worse: 0,
          manual_follow_up_required: 0,
          locked: 0,
        },
      },
      latestRepairExecutionsByBusiness: {
        "biz-meta": {
          id: "exec-1",
          executionSignature: "sig-1",
          buildId: "build-1",
          environment: "production",
          providerScope: "meta",
          businessId: "biz-meta",
          businessName: "TheSwaf",
          sourceReleaseGateId: "rg-1",
          sourceRepairPlanId: "rp-1",
          postRunReleaseGateId: "rg-2",
          postRunRepairPlanId: "rp-2",
          recommendedAction: "integrity_repair_enqueue",
          executedAction: "repair_cycle",
          workflowRunId: "run-1",
          workflowActor: "codex",
          lockOwner: "run-1:biz-meta",
          status: "completed",
          outcomeClassification: "improving_not_cleared",
          expectedOutcomeMet: false,
          beforeEvidence: {
            queueDepth: 4,
            truthReady: false,
            activityState: "blocked",
          },
          actionResult: {},
          afterEvidence: {
            queueDepth: 2,
            truthReady: false,
            activityState: "busy",
          },
          startedAt: now,
          finishedAt: now,
        },
      },
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "TheSwaf",
          queue_depth: 2,
          leased_partitions: 1,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: "2026-04-15",
          oldest_queued_partition: "2026-04-15",
          latest_partition_activity_at: now,
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "publish",
          latest_checkpoint_updated_at: now,
          latest_progress_heartbeat_at: now,
          last_successful_page_index: 2,
          checkpoint_failures: 0,
          reclaim_candidate_count: 0,
          today_account_rows: 12,
          today_adset_rows: 12,
          account_completed_days: 100,
          adset_completed_days: 100,
          creative_completed_days: 90,
          ad_completed_days: 90,
          recent_account_completed_days: 14,
          recent_adset_completed_days: 14,
          recent_creative_completed_days: 14,
          recent_ad_completed_days: 14,
          recent_range_total_days: 14,
        },
      ],
    });

    expect(payload.remediationSummary?.businessCount).toBe(1);
    expect(payload.metaBusinesses?.[0]?.latestRemediationExecution).toMatchObject({
      id: "exec-1",
      sourceReleaseGateId: "rg-1",
      sourceRepairPlanId: "rp-1",
      postRunReleaseGateId: "rg-2",
      postRunRepairPlanId: "rp-2",
      outcomeClassification: "improving_not_cleared",
      recommendedAction: "integrity_repair_enqueue",
      executedAction: "repair_cycle",
    });
  });

  it("surfaces worker DB pressure evidence from heartbeat diagnostics", () => {
    const payload = buildAdminSyncHealth({
      jobs: [],
      cooldowns: [],
      metaHealth: [
        {
          business_id: "biz-meta",
          business_name: "IwaStore",
          queue_depth: 18,
          leased_partitions: 3,
          retryable_failed_partitions: 0,
          stale_lease_partitions: 0,
          dead_letter_partitions: 0,
          state_row_count: 2,
          current_day_reference: "2026-04-14",
          oldest_queued_partition: "2026-04-10",
          latest_partition_activity_at: "2026-04-14T08:59:00.000Z",
          latest_checkpoint_scope: "account_daily",
          latest_checkpoint_phase: "transform",
          latest_checkpoint_updated_at: "2026-04-14T08:59:00.000Z",
          latest_progress_heartbeat_at: "2026-04-14T08:59:00.000Z",
          last_successful_page_index: 3,
          checkpoint_failures: 0,
          today_account_rows: 4,
          today_adset_rows: 4,
          account_completed_days: 120,
          adset_completed_days: 120,
          creative_completed_days: 80,
          ad_completed_days: 80,
          recent_account_completed_days: 14,
          recent_adset_completed_days: 14,
          recent_creative_completed_days: 14,
          recent_ad_completed_days: 14,
          recent_range_total_days: 14,
        },
      ],
      workerHealth: {
        onlineWorkers: 1,
        workerInstances: 1,
        lastHeartbeatAt: "2026-04-14T09:00:00.000Z",
        lastProgressHeartbeatAt: null,
        workers: [
          {
            workerId: "worker-1:meta",
            instanceType: "durable_sync_worker",
            providerScope: "meta",
            workerFreshnessState: "online",
            status: "running",
            lastHeartbeatAt: "2026-04-14T09:00:00.000Z",
            lastBusinessId: "biz-meta",
            lastPartitionId: "partition-1",
            lastConsumedBusinessId: "biz-meta",
            lastConsumeOutcome: "consume_succeeded",
            lastConsumeFinishedAt: "2026-04-14T08:59:55.000Z",
            metaJson: {
              dbRuntime: {
                sampledAt: "2026-04-14T09:00:00.000Z",
                runtime: "worker",
                applicationName: "omniads-worker",
                settings: {
                  runtime: "worker",
                  applicationName: "omniads-worker",
                  poolMax: 20,
                  queryTimeoutMs: 30_000,
                  connectionTimeoutMs: 10_000,
                  idleTimeoutMs: 30_000,
                  maxLifetimeSeconds: 900,
                  statementTimeoutMs: null,
                  idleInTransactionSessionTimeoutMs: null,
                  retryAttempts: 4,
                  retryBackoffMs: 400,
                  retryMaxBackoffMs: 4_000,
                  allowExitOnIdle: true,
                },
                pool: {
                  max: 20,
                  totalCount: 20,
                  idleCount: 0,
                  waitingCount: 2,
                  utilizationPercent: 100,
                  saturationState: "saturated",
                  maxObservedWaitingCount: 4,
                  maxObservedUtilizationPercent: 100,
                  poolWaitEventCount: 6,
                  lastPoolWaitAt: "2026-04-14T08:59:30.000Z",
                },
                counters: {
                  queryCount: 200,
                  successCount: 198,
                  failureCount: 2,
                  retriedQueryCount: 3,
                  retryAttemptCount: 5,
                  retryableErrorCount: 4,
                  timeoutCount: 2,
                  connectionErrorCount: 1,
                  lastSuccessfulQueryAt: "2026-04-14T08:59:55.000Z",
                  lastRetryableErrorAt: "2026-04-14T08:59:40.000Z",
                  lastTimeoutAt: "2026-04-14T08:59:45.000Z",
                  lastConnectionErrorAt: "2026-04-14T08:59:20.000Z",
                },
                lastError: {
                  at: "2026-04-14T08:59:45.000Z",
                  code: "57014",
                  message: "Database query timed out after 30000ms.",
                  retryable: false,
                  timeout: true,
                  connection: false,
                },
              },
            },
          },
        ],
      },
      webDbDiagnostics: {
        sampledAt: "2026-04-14T09:00:00.000Z",
        runtime: "web",
        applicationName: "omniads-web",
        settings: {
          runtime: "web",
          applicationName: "omniads-web",
          poolMax: 10,
          queryTimeoutMs: 8_000,
          connectionTimeoutMs: 10_000,
          idleTimeoutMs: 30_000,
          maxLifetimeSeconds: null,
          statementTimeoutMs: null,
          idleInTransactionSessionTimeoutMs: null,
          retryAttempts: 4,
          retryBackoffMs: 400,
          retryMaxBackoffMs: 4_000,
          allowExitOnIdle: true,
        },
        pool: {
          max: 10,
          totalCount: 3,
          idleCount: 2,
          waitingCount: 0,
          utilizationPercent: 30,
          saturationState: "idle",
          maxObservedWaitingCount: 0,
          maxObservedUtilizationPercent: 30,
          poolWaitEventCount: 0,
          lastPoolWaitAt: null,
        },
        counters: {
          queryCount: 20,
          successCount: 20,
          failureCount: 0,
          retriedQueryCount: 0,
          retryAttemptCount: 0,
          retryableErrorCount: 0,
          timeoutCount: 0,
          connectionErrorCount: 0,
          lastSuccessfulQueryAt: "2026-04-14T08:59:59.000Z",
          lastRetryableErrorAt: null,
          lastTimeoutAt: null,
          lastConnectionErrorAt: null,
        },
        lastError: null,
      },
    });

    expect(payload.dbDiagnostics?.summary).toMatchObject({
      webPressureState: "healthy",
      workerPressureState: "saturated",
      metaBacklogState: "draining",
      likelyPrimaryConstraint: "db",
      workerCurrentPoolWaiters: 2,
      workerMaxObservedPoolWaiters: 4,
      workerTimeoutCount: 2,
      workerRetryableErrorCount: 4,
      workerConnectionErrorCount: 1,
    });
    expect(payload.dbDiagnostics?.workers[0]).toMatchObject({
      workerId: "worker-1:meta",
      providerScope: "meta",
      applicationName: "omniads-worker",
    });
  });
});

describe("buildAdminRevenueRisk", () => {
  it("surfaces unsubscribed businesses and non-active subscriptions", () => {
    const payload = buildAdminRevenueRisk({
      workspaces: [
        {
          business_id: "biz-1",
          business_name: "Acme",
          owner_name: "Owner",
          owner_email: "owner@example.com",
          created_at: "2026-03-01T10:00:00.000Z",
          connected_integrations: 2,
          has_active_subscription: false,
        },
      ],
      subscriptions: [
        {
          business_id: "biz-2",
          business_name: "Beta",
          owner_name: "Owner 2",
          owner_email: "owner2@example.com",
          plan_id: "growth",
          status: "cancelled",
          updated_at: new Date().toISOString(),
        },
        {
          business_id: "biz-3",
          business_name: "Gamma",
          owner_name: "Owner 3",
          owner_email: "owner3@example.com",
          plan_id: "pro",
          status: "active",
          updated_at: new Date().toISOString(),
        },
      ],
    });

    expect(payload.summary.unsubscribedBusinesses).toBe(1);
    expect(payload.summary.nonActiveSubscriptions).toBe(1);
    expect(payload.summary.activeSubscriptions).toBe(1);
    expect(payload.summary.atRiskBusinesses).toBe(2);
  });
});
