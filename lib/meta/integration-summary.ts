import type {
  MetaIntegrationSummary,
  MetaIntegrationSummaryScope,
  MetaIntegrationSummaryStage,
  MetaStatusResponse,
} from "@/lib/meta/status-types";
import { shouldSuppressRecoverableMetaSyncIssue } from "@/lib/sync/user-visible-sync";

type MetaIntegrationSummaryInput = Pick<
  MetaStatusResponse,
  | "state"
  | "connected"
  | "controlPlanePersistence"
  | "releaseGate"
  | "repairPlan"
  | "blockerClass"
  | "syncTruthState"
  | "assignedAccountIds"
  | "primaryAccountTimezone"
  | "latestSync"
  | "warehouse"
  | "jobHealth"
  | "operations"
  | "coreReadiness"
  | "extendedCompleteness"
  | "priorityWindow"
  | "selectedRangeTruth"
  | "pageReadiness"
  | "recentExtendedReady"
  | "historicalExtendedReady"
  | "rangeCompletionBySurface"
  | "d1FinalizeState"
>;

function clampPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function percentFromCounts(
  completed: number | null | undefined,
  total: number | null | undefined
) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || (total ?? 0) <= 0) {
    return null;
  }
  return clampPercent(((completed ?? 0) / Math.max(1, total ?? 0)) * 100);
}

function earliestDate(values: Array<string | null | undefined>) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right))[0] ?? null
  );
}

function latestDate(values: Array<string | null | undefined>) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null
  );
}

function minCount(values: Array<number | null | undefined>) {
  const numeric = values.filter((value): value is number => Number.isFinite(value));
  if (numeric.length === 0) return null;
  return Math.min(...numeric);
}

function compactEvidence(
  evidence: MetaIntegrationSummaryStage["evidence"]
): MetaIntegrationSummaryStage["evidence"] {
  if (!evidence) return null;
  const entries = Object.entries(evidence).filter(([, value]) => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
  return entries.length > 0
    ? (Object.fromEntries(entries) as MetaIntegrationSummaryStage["evidence"])
    : null;
}

function getSummaryScope(
  status: MetaIntegrationSummaryInput
): MetaIntegrationSummaryScope {
  if (!status.connected || (status.assignedAccountIds?.length ?? 0) === 0) {
    return "not_applicable";
  }
  if (status.pageReadiness?.selectedRangeMode === "current_day_live") {
    return "current_day";
  }
  if (
    status.priorityWindow ||
    status.selectedRangeTruth ||
    status.warehouse?.coverage?.selectedRange
  ) {
    return "selected_range";
  }
  return "recent_window";
}

function getBlockingCodes(status: MetaIntegrationSummaryInput) {
  return (status.operations?.blockingReasons ?? []).map((reason) => reason.code);
}

function getAvailableRepairActionKinds(status: MetaIntegrationSummaryInput) {
  return (status.operations?.repairableActions ?? [])
    .filter((action) => action.available)
    .map((action) => action.kind);
}

function getStallFingerprintCount(status: MetaIntegrationSummaryInput) {
  return status.operations?.stallFingerprints?.length ?? 0;
}

function hasNonBlockingDefaultCoverage(status: MetaIntegrationSummaryInput) {
  return (
    status.pageReadiness?.selectedRangeMode === "historical_warehouse" &&
    status.pageReadiness?.state === "ready" &&
    status.coreReadiness?.usable === true &&
    status.extendedCompleteness?.complete === true
  );
}

function getCoreReadyThroughDate(status: MetaIntegrationSummaryInput) {
  return earliestDate([
    status.warehouse?.coverage?.selectedRange?.readyThroughDate ?? null,
    status.rangeCompletionBySurface?.account_daily?.readyThroughDate ?? null,
    status.rangeCompletionBySurface?.campaign_daily?.readyThroughDate ?? null,
    status.latestSync?.readyThroughDate ?? null,
  ]);
}

function getCoreOldestStoredDate(status: MetaIntegrationSummaryInput) {
  return latestDate([
    status.warehouse?.coverage?.selectedRange?.oldestStoredDate ?? null,
    status.rangeCompletionBySurface?.account_daily?.oldestStoredDate ?? null,
    status.rangeCompletionBySurface?.campaign_daily?.oldestStoredDate ?? null,
    status.warehouse?.coverage?.historical?.oldestStoredDate ?? null,
    status.warehouse?.firstDate ?? null,
  ]);
}

function getBreakdownMetrics(status: MetaIntegrationSummaryInput) {
  const breakdownsBySurface = status.warehouse?.coverage?.breakdownsBySurface;
  if (breakdownsBySurface) {
    return {
      completedDays:
        minCount([
          breakdownsBySurface.age.completedDays,
          breakdownsBySurface.location.completedDays,
          breakdownsBySurface.placement.completedDays,
        ]) ?? 0,
      totalDays: Math.max(
        breakdownsBySurface.age.totalDays,
        breakdownsBySurface.location.totalDays,
        breakdownsBySurface.placement.totalDays
      ),
      readyThroughDate: earliestDate([
        breakdownsBySurface.age.readyThroughDate,
        breakdownsBySurface.location.readyThroughDate,
        breakdownsBySurface.placement.readyThroughDate,
      ]),
      oldestStoredDate: latestDate([
        breakdownsBySurface.age.oldestStoredDate,
        breakdownsBySurface.location.oldestStoredDate,
        breakdownsBySurface.placement.oldestStoredDate,
      ]),
    };
  }

  const breakdowns = status.warehouse?.coverage?.breakdowns;
  if (!breakdowns) return null;
  return {
    completedDays: breakdowns.completedDays,
    totalDays: breakdowns.totalDays,
    readyThroughDate: breakdowns.readyThroughDate,
    oldestStoredDate: breakdowns.oldestStoredDate ?? null,
  };
}

function getPriorityMetrics(
  status: MetaIntegrationSummaryInput,
  scope: MetaIntegrationSummaryScope
) {
  if (scope === "selected_range" || scope === "current_day") {
    const selectedRangeCoverage = status.warehouse?.coverage?.selectedRange;
    const completedDays =
      status.priorityWindow?.completedDays ??
      selectedRangeCoverage?.completedDays ??
      status.latestSync?.completedDays ??
      0;
    const totalDays =
      status.priorityWindow?.totalDays ??
      selectedRangeCoverage?.totalDays ??
      status.latestSync?.totalDays ??
      0;
    const readyThroughDate =
      status.selectedRangeTruth?.truthReady === true
        ? status.priorityWindow?.endDate ?? selectedRangeCoverage?.endDate ?? null
        : selectedRangeCoverage?.readyThroughDate ??
          status.latestSync?.readyThroughDate ??
          null;

    return {
      completedDays,
      totalDays,
      percent: percentFromCounts(completedDays, totalDays),
      readyThroughDate,
      oldestStoredDate: selectedRangeCoverage?.oldestStoredDate ?? null,
    };
  }

  const account = status.rangeCompletionBySurface?.account_daily;
  const campaign = status.rangeCompletionBySurface?.campaign_daily;
  const hasRecentSurfaceMetrics = Boolean(account || campaign);
  const totalDays = hasRecentSurfaceMetrics
    ? Math.max(account?.recentTotalDays ?? 0, campaign?.recentTotalDays ?? 0)
    : status.latestSync?.totalDays ?? 0;
  const completedDays = hasRecentSurfaceMetrics
    ? minCount([account?.recentCompletedDays, campaign?.recentCompletedDays]) ?? 0
    : status.latestSync?.completedDays ?? 0;

  return {
    completedDays,
    totalDays,
    percent: percentFromCounts(completedDays, totalDays),
    readyThroughDate: earliestDate([
      account?.readyThroughDate ?? null,
      campaign?.readyThroughDate ?? null,
      status.latestSync?.readyThroughDate ?? null,
    ]),
    oldestStoredDate: latestDate([
      account?.oldestStoredDate ?? null,
      campaign?.oldestStoredDate ?? null,
      status.warehouse?.coverage?.historical?.oldestStoredDate ?? null,
      status.warehouse?.firstDate ?? null,
    ]),
  };
}

function getExtendedSurfaceMetrics(status: MetaIntegrationSummaryInput) {
  const creative = status.rangeCompletionBySurface?.creative_daily;
  const ad = status.rangeCompletionBySurface?.ad_daily;
  const recentTotal = Math.max(
    creative?.recentTotalDays ?? 0,
    ad?.recentTotalDays ?? 0
  );
  const recentCompleted =
    minCount([creative?.recentCompletedDays ?? 0, ad?.recentCompletedDays ?? 0]) ?? 0;
  const historicalSurfaces = [
    {
      completedDays: creative?.historicalCompletedDays ?? 0,
      totalDays: creative?.historicalTotalDays ?? 0,
      readyThroughDate: creative?.readyThroughDate ?? null,
      oldestStoredDate: creative?.oldestStoredDate ?? null,
    },
    {
      completedDays: ad?.historicalCompletedDays ?? 0,
      totalDays: ad?.historicalTotalDays ?? 0,
      readyThroughDate: ad?.readyThroughDate ?? null,
      oldestStoredDate: ad?.oldestStoredDate ?? null,
    },
  ].filter((surface) => surface.totalDays > 0);
  const historicalProgressSurfaces =
    historicalSurfaces.filter(
      (surface) => surface.completedDays < surface.totalDays
    );
  const hasHistoricalBacklog = historicalProgressSurfaces.length > 0;
  const trackedHistoricalSurfaces =
    hasHistoricalBacklog
      ? historicalProgressSurfaces
      : historicalSurfaces;
  const historicalTotal = Math.max(
    ...trackedHistoricalSurfaces.map((surface) => surface.totalDays),
    0
  );
  const historicalCompleted =
    minCount(
      trackedHistoricalSurfaces.map((surface) => surface.completedDays)
    ) ?? 0;

  return {
    recentCompleted,
    recentTotal,
    recentPercent: percentFromCounts(recentCompleted, recentTotal),
    historicalCompleted,
    historicalTotal,
    historicalPercent: percentFromCounts(historicalCompleted, historicalTotal),
    hasHistoricalBacklog,
    readyThroughDate: earliestDate(
      trackedHistoricalSurfaces.map((surface) => surface.readyThroughDate)
    ),
    oldestStoredDate: latestDate(
      trackedHistoricalSurfaces.map((surface) => surface.oldestStoredDate)
    ),
  };
}

function getRecentAdsCreativePendingSurfaces(status: MetaIntegrationSummaryInput) {
  const pending: string[] = [];
  const ad = status.rangeCompletionBySurface?.ad_daily;
  const creative = status.rangeCompletionBySurface?.creative_daily;
  const creativePreview = status.warehouse?.coverage?.creatives;

  if (
    ad &&
    ad.recentTotalDays > 0 &&
    ad.recentCompletedDays < ad.recentTotalDays
  ) {
    pending.push("ad_daily");
  }

  if (
    creative &&
    creative.recentTotalDays > 0 &&
    creative.recentCompletedDays < creative.recentTotalDays
  ) {
    pending.push("creative_daily");
  }

  if (
    creativePreview &&
    (creativePreview.totalRows ?? 0) > 0 &&
    (creativePreview.previewReadyRows ?? 0) < (creativePreview.totalRows ?? 0)
  ) {
    pending.push("creative_media");
  }

  return pending;
}

function areRecentExtendedQueuesIdle(status: MetaIntegrationSummaryInput) {
  const recentQueueDepth = status.jobHealth?.extendedRecentQueueDepth;
  const recentLeasedPartitions = status.jobHealth?.extendedRecentLeasedPartitions;
  const hasRecentQueueHealth =
    typeof recentQueueDepth === "number" ||
    typeof recentLeasedPartitions === "number";

  if (!hasRecentQueueHealth) return true;
  return (recentQueueDepth ?? 0) === 0 && (recentLeasedPartitions ?? 0) === 0;
}

function isWaitingState(status: MetaIntegrationSummaryInput) {
  return (
    status.state === "paused" ||
    status.operations?.progressState === "partial_stuck"
  );
}

function buildConnectionStage(
  status: MetaIntegrationSummaryInput
): MetaIntegrationSummaryStage {
  return {
    key: "connection",
    state: "ready",
    percent: null,
    code: "connected",
    evidence: compactEvidence({
      assignedAccountCount: status.assignedAccountIds?.length ?? 0,
      primaryTimezone: status.primaryAccountTimezone ?? null,
    }),
  };
}

function buildQueueStage(
  status: MetaIntegrationSummaryInput
): MetaIntegrationSummaryStage {
  const queueDepth = status.jobHealth?.queueDepth ?? 0;
  const leasedPartitions = status.jobHealth?.leasedPartitions ?? 0;
  const retryableFailedPartitions =
    status.jobHealth?.retryableFailedPartitions ?? 0;
  const deadLetterPartitions = status.jobHealth?.deadLetterPartitions ?? 0;
  const blockerCodes = getBlockingCodes(status);
  const repairActionKinds = getAvailableRepairActionKinds(status);
  const stallFingerprintCount = getStallFingerprintCount(status);
  const evidence = compactEvidence({
    queueDepth: queueDepth > 0 ? queueDepth : undefined,
    leasedPartitions: leasedPartitions > 0 ? leasedPartitions : undefined,
    retryableFailedPartitions:
      retryableFailedPartitions > 0 ? retryableFailedPartitions : undefined,
    deadLetterPartitions:
      deadLetterPartitions > 0 ? deadLetterPartitions : undefined,
    blockerCount: blockerCodes.length > 0 ? blockerCodes.length : undefined,
    blockerCodes,
    repairSignalCount:
      repairActionKinds.length + stallFingerprintCount > 0
        ? repairActionKinds.length + stallFingerprintCount
        : undefined,
    repairActionKinds,
    stallFingerprintCount:
      stallFingerprintCount > 0 ? stallFingerprintCount : undefined,
  });
  const workerUnavailable =
    queueDepth > 0 &&
    leasedPartitions === 0 &&
    status.operations?.workerHealthy === false;
  const nonBlockingDefaultCoverage = hasNonBlockingDefaultCoverage(status);
  const suppressRecoverableSync = shouldSuppressRecoverableMetaSyncIssue(status);

  if (status.state === "stale" && !nonBlockingDefaultCoverage && !suppressRecoverableSync) {
    return {
      key: "queue_worker",
      state: "blocked",
      percent: null,
      code: "queue_stale",
      evidence,
    };
  }

  if (workerUnavailable && !nonBlockingDefaultCoverage && !suppressRecoverableSync) {
    return {
      key: "queue_worker",
      state: "blocked",
      percent: null,
      code: "queue_blocked",
      evidence,
    };
  }

  if (
    status.state === "action_required" ||
    status.operations?.progressState === "blocked" ||
    deadLetterPartitions > 0
  ) {
    if (suppressRecoverableSync) {
      return {
        key: "queue_worker",
        state: "ready",
        percent: null,
        code: "queue_clear",
        evidence: null,
      };
    }
    return {
      key: "queue_worker",
      state: "blocked",
      percent: null,
      code: "queue_blocked",
      evidence,
    };
  }

  if (
    status.state === "paused" ||
    status.operations?.progressState === "partial_stuck" ||
    (queueDepth > 0 && leasedPartitions === 0)
  ) {
    return {
      key: "queue_worker",
      state: "waiting",
      percent: null,
      code: "queue_waiting",
      evidence,
    };
  }

  if (
    leasedPartitions > 0 ||
    status.operations?.progressState === "syncing" ||
    status.operations?.progressState === "partial_progressing" ||
    status.latestSync?.status === "running" ||
    status.latestSync?.status === "pending" ||
    queueDepth > 0 ||
    retryableFailedPartitions > 0
  ) {
    return {
      key: "queue_worker",
      state: "working",
      percent: null,
      code: "queue_active",
      evidence,
    };
  }

  return {
    key: "queue_worker",
    state: "ready",
    percent: null,
    code: "queue_clear",
    evidence,
  };
}

function buildCoreStage(
  status: MetaIntegrationSummaryInput
): MetaIntegrationSummaryStage {
  const readyThroughDate = getCoreReadyThroughDate(status);
  const oldestStoredDate = getCoreOldestStoredDate(status);
  const percent =
    status.coreReadiness && !status.coreReadiness.complete
      ? clampPercent(status.coreReadiness.percent)
      : null;

  if (
    status.coreReadiness?.state === "blocked" ||
    (status.state === "action_required" && !status.coreReadiness?.usable)
  ) {
    return {
      key: "core_data",
      state: "blocked",
      percent,
      code: "core_blocked",
      evidence: compactEvidence({ readyThroughDate, oldestStoredDate }),
    };
  }

  if (status.coreReadiness?.usable) {
    return {
      key: "core_data",
      state: "ready",
      percent: null,
      code: "core_ready",
      evidence: compactEvidence({ readyThroughDate, oldestStoredDate }),
    };
  }

  if (isWaitingState(status)) {
    return {
      key: "core_data",
      state: "waiting",
      percent,
      code: "core_waiting",
      evidence: compactEvidence({ readyThroughDate, oldestStoredDate }),
    };
  }

  return {
    key: "core_data",
    state: "working",
    percent,
    code: "core_preparing",
    evidence: compactEvidence({ readyThroughDate, oldestStoredDate }),
  };
}

function buildPriorityStage(
  status: MetaIntegrationSummaryInput,
  scope: MetaIntegrationSummaryScope
): MetaIntegrationSummaryStage {
  const metrics = getPriorityMetrics(status, scope);
  const defaultCoverageReady =
    scope === "recent_window" && hasNonBlockingDefaultCoverage(status);
  const evidence = compactEvidence({
    completedDays: metrics.completedDays,
    totalDays: metrics.totalDays,
    readyThroughDate: metrics.readyThroughDate,
    oldestStoredDate: metrics.oldestStoredDate,
    blockerCount:
      getBlockingCodes(status).length > 0
        ? getBlockingCodes(status).length
        : undefined,
    blockerCodes: getBlockingCodes(status),
  });
  const selectedRangeState =
    status.selectedRangeTruth?.verificationState ??
      status.selectedRangeTruth?.state ??
    null;
  const selectedRangeBlocked =
    scope === "selected_range" &&
    (selectedRangeState === "blocked" ||
      selectedRangeState === "failed" ||
      selectedRangeState === "repair_required");
  const currentDayBlocked =
    scope === "current_day" &&
    status.state === "action_required" &&
    !status.coreReadiness?.usable;
  const suppressRecoverableSync = shouldSuppressRecoverableMetaSyncIssue(status);
  const ready =
    metrics.totalDays > 0 && metrics.completedDays >= metrics.totalDays;

  if (defaultCoverageReady) {
    return {
      key: "priority_window",
      state: "ready",
      percent: null,
      code: "recent_window_ready",
      evidence,
    };
  }

  if (selectedRangeBlocked && !suppressRecoverableSync) {
    return {
      key: "priority_window",
      state: "blocked",
      percent: metrics.percent,
      code: "selected_range_blocked",
      evidence,
    };
  }

  if (currentDayBlocked && !suppressRecoverableSync) {
    return {
      key: "priority_window",
      state: "blocked",
      percent: metrics.percent,
      code: "current_day_blocked",
      evidence,
    };
  }

  if (ready) {
    return {
      key: "priority_window",
      state: "ready",
      percent: null,
      code:
        scope === "current_day"
          ? "current_day_ready"
          : scope === "selected_range"
            ? "selected_range_ready"
            : "recent_window_ready",
      evidence,
    };
  }

  if (isWaitingState(status)) {
    return {
      key: "priority_window",
      state: "waiting",
      percent: metrics.percent,
      code:
        scope === "current_day"
          ? "current_day_waiting"
          : scope === "selected_range"
            ? "selected_range_waiting"
            : "recent_window_waiting",
      evidence,
    };
  }

  return {
    key: "priority_window",
    state: "working",
    percent: metrics.percent,
    code:
      scope === "current_day"
        ? "current_day_preparing"
        : scope === "selected_range"
          ? "selected_range_preparing"
          : "recent_window_preparing",
    evidence,
  };
}

function buildExtendedStage(
  status: MetaIntegrationSummaryInput,
  scope: MetaIntegrationSummaryScope
): MetaIntegrationSummaryStage {
  const recentWindowScope = scope === "recent_window";
  const nonRecentRangeReady =
    !recentWindowScope && status.extendedCompleteness?.complete === true;
  const recentWindowReadyByRange =
    recentWindowScope && status.recentExtendedReady === true;
  const legacyRecentWindowReady =
    recentWindowScope &&
    status.recentExtendedReady == null &&
    status.extendedCompleteness?.complete === true;
  const historicalLag = status.historicalExtendedReady === false;
  const recentWindowReady = recentWindowReadyByRange || legacyRecentWindowReady;
  const recentLag = status.recentExtendedReady === false;
  const recentAdsCreativePendingSurfaces = recentWindowScope
    ? getRecentAdsCreativePendingSurfaces(status)
    : [];
  const pendingSurfaces = Array.from(
    new Set(
      recentWindowReady || nonRecentRangeReady
        ? []
        : [
            ...(status.extendedCompleteness?.missingSurfaces ?? []),
            ...(recentWindowScope
              ? recentAdsCreativePendingSurfaces
              : status.warehouse?.coverage?.pendingSurfaces ?? []),
          ]
    )
  );
  const pendingSurfaceCount = pendingSurfaces.length;
  const breakdownMetrics = getBreakdownMetrics(status);
  const extendedSurfaceMetrics = getExtendedSurfaceMetrics(status);
  const historicalOnlyExtendedLag =
    recentWindowScope &&
    historicalLag &&
    !recentWindowReady;
  const useHistoricalExtendedProgress =
    historicalOnlyExtendedLag &&
    extendedSurfaceMetrics.hasHistoricalBacklog &&
    areRecentExtendedQueuesIdle(status);
  const hasRecentExtendedBacklog =
    extendedSurfaceMetrics.recentTotal > 0 &&
    extendedSurfaceMetrics.recentCompleted < extendedSurfaceMetrics.recentTotal;
  const useRecentExtendedProgress =
    recentWindowScope &&
    !useHistoricalExtendedProgress &&
    recentLag &&
    hasRecentExtendedBacklog;
  const extendedCompletenessPercent =
    status.extendedCompleteness &&
    !status.extendedCompleteness.complete &&
    status.extendedCompleteness.percent != null
      ? clampPercent(status.extendedCompleteness.percent)
      : null;
  const percent =
    recentWindowScope
      ? null
      : extendedCompletenessPercent != null
        ? extendedCompletenessPercent
        : historicalLag && extendedSurfaceMetrics.hasHistoricalBacklog
          ? extendedSurfaceMetrics.historicalPercent
          : null;

  const progressCompletedDays = recentWindowScope
    ? null
    : !status.extendedCompleteness?.complete
      ? breakdownMetrics?.completedDays ?? null
      : historicalLag && extendedSurfaceMetrics.hasHistoricalBacklog
        ? extendedSurfaceMetrics.historicalCompleted
        : null;

  const progressTotalDays = recentWindowScope
    ? null
    : !status.extendedCompleteness?.complete
      ? breakdownMetrics?.totalDays ?? null
      : historicalLag && extendedSurfaceMetrics.hasHistoricalBacklog
        ? extendedSurfaceMetrics.historicalTotal
        : null;

  const progressCode = recentWindowScope
    ? useHistoricalExtendedProgress
      ? "historical_extended_preparing"
      : "recent_extended_preparing"
    : !status.extendedCompleteness?.complete
      ? "breakdowns_preparing"
      : historicalLag
        ? "historical_extended_preparing"
        : "breakdowns_preparing";

  const progressReadyThroughDate = recentWindowScope
    ? historicalOnlyExtendedLag
      ? extendedSurfaceMetrics.readyThroughDate
      : extendedSurfaceMetrics.readyThroughDate
    : breakdownMetrics?.readyThroughDate ??
      extendedSurfaceMetrics.readyThroughDate;
  const progressOldestStoredDate = recentWindowScope
    ? historicalOnlyExtendedLag
      ? extendedSurfaceMetrics.oldestStoredDate
      : extendedSurfaceMetrics.oldestStoredDate
    : breakdownMetrics?.oldestStoredDate ??
      extendedSurfaceMetrics.oldestStoredDate;

  if (!recentWindowScope && status.extendedCompleteness?.state === "blocked") {
    return {
      key: "extended_surfaces",
      state: "blocked",
      percent,
      code: "extended_blocked",
      evidence: compactEvidence({
        completedDays: breakdownMetrics?.completedDays,
        totalDays: breakdownMetrics?.totalDays,
        pendingSurfaceCount,
        pendingSurfaces,
        readyThroughDate:
          breakdownMetrics?.readyThroughDate ??
          extendedSurfaceMetrics.readyThroughDate,
        oldestStoredDate:
          breakdownMetrics?.oldestStoredDate ??
          extendedSurfaceMetrics.oldestStoredDate,
      }),
    };
  }

  if (
    (recentWindowReady || nonRecentRangeReady) &&
    pendingSurfaceCount === 0
  ) {
    return {
      key: "extended_surfaces",
      state: "ready",
      percent: null,
      code: "extended_ready",
      evidence: compactEvidence({
        readyThroughDate:
          breakdownMetrics?.readyThroughDate ??
          extendedSurfaceMetrics.readyThroughDate,
      }),
    };
  }

  if (isWaitingState(status)) {
    return {
      key: "extended_surfaces",
      state: "waiting",
      percent,
      code: "extended_waiting",
      evidence: compactEvidence({
        completedDays: progressCompletedDays ?? undefined,
        totalDays: progressTotalDays ?? undefined,
        pendingSurfaceCount,
        pendingSurfaces,
        readyThroughDate: progressReadyThroughDate,
        oldestStoredDate: progressOldestStoredDate,
      }),
    };
  }

  return {
    key: "extended_surfaces",
    state: "working",
    percent,
    code: progressCode,
    evidence: compactEvidence({
      completedDays: progressCompletedDays ?? undefined,
      totalDays: progressTotalDays ?? undefined,
      pendingSurfaceCount,
      pendingSurfaces,
      readyThroughDate: progressReadyThroughDate,
      oldestStoredDate: progressOldestStoredDate,
    }),
  };
}

function shouldRenderAttentionStage(status: MetaIntegrationSummaryInput) {
  if (shouldSuppressRecoverableMetaSyncIssue(status)) {
    return false;
  }
  if (
    hasNonBlockingDefaultCoverage(status) &&
    (status.jobHealth?.deadLetterPartitions ?? 0) === 0 &&
    (status.jobHealth?.retryableFailedPartitions ?? 0) === 0 &&
    status.d1FinalizeState !== "blocked"
  ) {
    return false;
  }
  return (
    status.state === "action_required" ||
    status.state === "paused" ||
    status.state === "stale" ||
    status.operations?.progressState === "blocked" ||
    (status.operations?.blockingReasons?.length ?? 0) > 0 ||
    (status.operations?.stallFingerprints?.length ?? 0) > 0 ||
    (status.jobHealth?.retryableFailedPartitions ?? 0) > 0 ||
    (status.jobHealth?.deadLetterPartitions ?? 0) > 0 ||
    status.d1FinalizeState === "blocked"
  );
}

function buildAttentionStage(
  status: MetaIntegrationSummaryInput
): MetaIntegrationSummaryStage {
  const blockerCodes = getBlockingCodes(status);
  const repairActionKinds = getAvailableRepairActionKinds(status);
  const stallFingerprintCount = getStallFingerprintCount(status);
  const evidence = compactEvidence({
    blockerCount: blockerCodes.length > 0 ? blockerCodes.length : undefined,
    blockerCodes,
    repairSignalCount:
      repairActionKinds.length + stallFingerprintCount > 0
        ? repairActionKinds.length + stallFingerprintCount
        : undefined,
    repairActionKinds,
    stallFingerprintCount:
      stallFingerprintCount > 0 ? stallFingerprintCount : undefined,
  });

  if (status.state === "stale") {
    return {
      key: "attention",
      state: "blocked",
      percent: null,
      code: "progress_stale",
      evidence,
    };
  }

  if (
    status.state === "action_required" ||
    status.operations?.progressState === "blocked" ||
    (status.operations?.blockingReasons?.length ?? 0) > 0 ||
    (status.jobHealth?.deadLetterPartitions ?? 0) > 0 ||
    status.d1FinalizeState === "blocked"
  ) {
    return {
      key: "attention",
      state: "blocked",
      percent: null,
      code: "attention_needed",
      evidence,
    };
  }

  if (status.state === "paused") {
    return {
      key: "attention",
      state: "waiting",
      percent: null,
      code: "queue_waiting",
      evidence,
    };
  }

  if (
    (status.jobHealth?.retryableFailedPartitions ?? 0) > 0 &&
    status.operations?.progressState === "partial_progressing"
  ) {
    return {
      key: "attention",
      state: "working",
      percent: null,
      code: "recovery_running",
      evidence,
    };
  }

  return {
    key: "attention",
    state: "waiting",
    percent: null,
    code: "recovery_available",
    evidence,
  };
}

function deriveOverallState(
  stages: MetaIntegrationSummaryStage[]
): MetaIntegrationSummary["state"] {
  if (stages.some((stage) => stage.state === "blocked")) return "blocked";
  if (stages.some((stage) => stage.state === "working")) return "working";
  if (stages.some((stage) => stage.state === "waiting")) return "waiting";
  return "ready";
}

export function buildMetaIntegrationSummary(
  status: MetaIntegrationSummaryInput
): MetaIntegrationSummary {
  const visible =
    status.connected && (status.assignedAccountIds?.length ?? 0) > 0;
  const scope = getSummaryScope(status);

  if (!visible) {
    return {
      visible: false,
      state: "waiting",
      scope,
      attentionNeeded: false,
      stages: [],
    };
  }

  const stages: MetaIntegrationSummaryStage[] = [
    buildConnectionStage(status),
    buildQueueStage(status),
    buildCoreStage(status),
    buildExtendedStage(status, scope),
  ];

  if (scope !== "recent_window") {
    stages.splice(3, 0, buildPriorityStage(status, scope));
  }

  if (shouldRenderAttentionStage(status)) {
    stages.push(buildAttentionStage(status));
  }

  return {
    visible: true,
    state: deriveOverallState(stages),
    scope,
    attentionNeeded: stages.some((stage) => stage.key === "attention"),
    stages,
  };
}
