import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import {
  isGoogleAdsControlPlaneClosed,
  resolveGoogleAdsSyncProgress,
} from "@/lib/google-ads/sync-progress-ux";
import {
  getMetaCoreReadiness,
  getMetaPageReadiness,
  hasMetaExtendedCompletenessLag,
} from "@/lib/meta/page-readiness";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import { getMetaPageStatusMessaging } from "@/lib/meta/ui-status";
import {
  deriveGoogleUserVisibleSyncState,
  deriveMetaUserVisibleSyncState,
  shouldSuppressRecoverableGoogleSyncIssue,
  shouldSuppressRecoverableMetaSyncIssue,
} from "@/lib/sync/user-visible-sync";

export interface SyncStatusPillState {
  visible: boolean;
  label: string;
  tone: "info" | "success" | "warning";
  percent: number | null;
  state: "syncing" | "active" | "needs_attention";
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function percentFromCoverage(
  completedDays: number | null | undefined,
  totalDays: number | null | undefined
) {
  if (!Number.isFinite(completedDays) || !Number.isFinite(totalDays) || (totalDays ?? 0) <= 0) {
    return null;
  }
  return clampPercent(((completedDays ?? 0) / (totalDays ?? 0)) * 100);
}

function resolveMetaPercent(status: MetaStatusResponse) {
  const corePercent = status.coreReadiness?.percent;
  if (typeof corePercent === "number" && Number.isFinite(corePercent)) {
    return clampPercent(corePercent);
  }

  const latestPercent = status.latestSync?.progressPercent;
  if (typeof latestPercent === "number" && Number.isFinite(latestPercent)) {
    return clampPercent(latestPercent);
  }

  const selectedRangeCoverage = status.warehouse?.coverage?.selectedRange;
  const selectedRangePercent = percentFromCoverage(
    selectedRangeCoverage?.completedDays,
    selectedRangeCoverage?.totalDays
  );
  if (selectedRangePercent !== null) return selectedRangePercent;

  const historicalCoverage = status.warehouse?.coverage?.historical;
  const historicalPercent = percentFromCoverage(
    historicalCoverage?.completedDays,
    historicalCoverage?.totalDays
  );
  if (historicalPercent !== null) return historicalPercent;

  const creativesCoverage = status.warehouse?.coverage?.creatives;
  return percentFromCoverage(creativesCoverage?.completedDays, creativesCoverage?.totalDays);
}

function getMetaProgressLabel(status: MetaStatusResponse) {
  const coreReadiness = getMetaCoreReadiness(status);
  if (coreReadiness?.usable && hasMetaExtendedCompletenessLag(status)) return "Core ready";
  if (status.pageReadiness?.selectedRangeMode === "current_day_live") return "Preparing today";
  if (status.warehouse?.coverage?.selectedRange) return "Preparing range";
  return "Preparing core";
}

function buildSyncingPill(percent: number, label = "Syncing"): SyncStatusPillState {
  return {
    visible: true,
    label: `${percent}% ${label}`,
    tone: "info",
    percent,
    state: "syncing",
  };
}

function buildInfoPill(label: string, percent: number | null = null): SyncStatusPillState {
  return {
    visible: true,
    label,
    tone: "info",
    percent,
    state: "syncing",
  };
}

function buildActivePill(label = "Active"): SyncStatusPillState {
  return {
    visible: true,
    label,
    tone: "success",
    percent: 100,
    state: "active",
  };
}

function buildAttentionPill(label = "Needs attention"): SyncStatusPillState {
  return {
    visible: true,
    label,
    tone: "warning",
    percent: null,
    state: "needs_attention",
  };
}

export function resolveMetaSyncStatusPill(
  status: MetaStatusResponse | undefined | null
): SyncStatusPillState | null {
  if (!status?.connected) return null;
  if ((status.assignedAccountIds?.length ?? 0) === 0) return null;

  const pageReadiness = getMetaPageReadiness(status);
  const pageMessages = getMetaPageStatusMessaging(status, "en");
  const coreReadiness = getMetaCoreReadiness(status);
  const percent = resolveMetaPercent(status);
  const suppressRecoverableAttention = shouldSuppressRecoverableMetaSyncIssue(status);
  const userVisibleState = deriveMetaUserVisibleSyncState(status);
  const isAttentionState =
    coreReadiness?.state === "blocked" ||
    pageReadiness?.state === "blocked" ||
    status.state === "action_required" ||
    status.state === "paused" ||
    status.state === "stale" ||
    status.operations?.progressState === "blocked";

  if (isAttentionState && !suppressRecoverableAttention) {
    return buildAttentionPill();
  }

  if (isAttentionState && suppressRecoverableAttention) {
    return buildInfoPill(userVisibleState.label);
  }

  if (coreReadiness?.usable && hasMetaExtendedCompletenessLag(status)) {
    return buildActivePill("Core ready");
  }

  if (coreReadiness?.state === "ready" || pageReadiness?.state === "ready") {
    return buildActivePill(pageMessages.pill.label);
  }

  if ((coreReadiness?.state === "syncing" || coreReadiness?.state === "partial") && typeof percent === "number") {
    return buildSyncingPill(percent, getMetaProgressLabel(status));
  }

  if (typeof percent === "number" && percent < 100) {
    return buildSyncingPill(percent, getMetaProgressLabel(status));
  }

  if (status.state === "ready" || percent === 100) {
    return buildActivePill(pageMessages.pill.label);
  }

  if ((status.state === "syncing" || status.state === "partial") && typeof percent === "number") {
    return buildSyncingPill(percent, getMetaProgressLabel(status));
  }

  if (
    coreReadiness?.state === "syncing" ||
    coreReadiness?.state === "partial" ||
    status.state === "syncing" ||
    status.state === "partial"
  ) {
    return buildInfoPill(getMetaProgressLabel(status));
  }

  return buildActivePill(pageMessages.pill.label);
}

function resolveGooglePercent(status: GoogleAdsStatusResponse) {
  const resolvedProgress = resolveGoogleAdsSyncProgress(status, "inline");
  if (resolvedProgress) {
    return clampPercent(resolvedProgress.percent);
  }

  // The two coverage fallbacks that used to live here —
  // `percentFromCoverage(historical.completedDays, totalDays)` and the same for
  // the selected range — were `COUNT(DISTINCT date) / days * 100`, so a range
  // captured once and never re-read produced a green 100% pill. The verdict is
  // the only remaining source; with no verdict the pill shows no percent rather
  // than inventing one.
  const freshnessPercent = status.freshness?.evidenceAvailable
    ? status.freshness.percent
    : null;
  if (typeof freshnessPercent === "number" && Number.isFinite(freshnessPercent)) {
    return clampPercent(freshnessPercent);
  }
  return null;
}

/**
 * Whether the Google Ads workspace has earned a green pill.
 *
 * The bar is `converging` or `settled`: every day in the measured range was
 * re-read AFTER it closed. `converging` qualifies because a rolling range keeps
 * its most recent days inside the conversion window and could never reach
 * `settled`, so demanding `settled` would mean never green. Anything weaker —
 * including a missing freshness block on an older payload — does not qualify.
 */
function googleAdsPillMayGoGreen(status: GoogleAdsStatusResponse) {
  const freshness = status.freshness;
  if (!freshness || freshness.evidenceAvailable !== true) return false;
  return freshness.state === "converging" || freshness.state === "settled";
}

/**
 * The green pill, but only when the evidence supports it.
 *
 * `buildActivePill` hard-codes `percent: 100`, and four separate branches below
 * reached it — control-plane closure, `state === "ready"`, `percent === 100`,
 * and the final fallthrough — none of which consulted freshness. Every one of
 * them now goes through here.
 */
function buildGoogleAdsActivePill(
  status: GoogleAdsStatusResponse,
  label?: string,
): SyncStatusPillState {
  if (googleAdsPillMayGoGreen(status)) {
    const pill = buildActivePill(label);
    // Only a settled range may show 100; while conversions can still arrive the
    // pill stays green but honest about the number.
    return status.freshness?.state === "settled"
      ? pill
      : { ...pill, percent: Math.min(99, status.freshness?.percent ?? 99) };
  }
  // No freshness block at all is treated exactly like a failed read: both mean
  // we could not look, and neither may render as progress toward done.
  if (!status.freshness || status.freshness.evidenceAvailable !== true) {
    return buildInfoPill("Unknown freshness");
  }
  const percent = resolveGooglePercent(status);
  const freshnessLabel = status.freshness.label ?? "Refreshing";
  return typeof percent === "number"
    ? buildInfoPill(`${percent}% ${freshnessLabel}`, percent)
    : buildInfoPill(freshnessLabel);
}

function resolveGoogleProgressLabel(
  status: GoogleAdsStatusResponse,
  percent: number | null,
) {
  const resolvedProgress = resolveGoogleAdsSyncProgress(status, "inline");
  if (!resolvedProgress || typeof percent !== "number" || percent >= 100) return null;
  if (resolvedProgress.kind === "advisor") return "Preparing 90-day support";
  if (status.panel?.coreUsable) return "Extended sync";
  return "Syncing";
}

export function resolveGoogleAdsSyncStatusPill(
  status: GoogleAdsStatusResponse | undefined | null
): SyncStatusPillState | null {
  if (!status?.connected) return null;
  if ((status.assignedAccountIds?.length ?? 0) === 0) return null;
  const userVisibleState = deriveGoogleUserVisibleSyncState(status);
  if (isGoogleAdsControlPlaneClosed(status)) {
    return status.backgroundBackfill?.incomplete === true
      ? buildInfoPill(userVisibleState.label)
      : buildGoogleAdsActivePill(status, userVisibleState.label);
  }

  const percent = resolveGooglePercent(status);
  const progressLabel = resolveGoogleProgressLabel(status, percent);
  const controlPlaneAttention =
    status.controlPlanePersistence?.exactRowsPresent === true &&
    ((status.releaseGate?.verdict != null &&
      status.releaseGate.verdict !== "pass") ||
      (status.repairPlan?.recommendations?.length ?? 0) > 0 ||
      (status.blockerClass != null && status.blockerClass !== "none"));
  const isAttentionState =
    controlPlaneAttention ||
    status.state === "action_required" ||
    status.state === "paused" ||
    status.state === "stale" ||
    status.operations?.progressState === "blocked";

  if (isAttentionState && !shouldSuppressRecoverableGoogleSyncIssue(status)) {
    return buildAttentionPill();
  }

  if (isAttentionState) {
    return buildInfoPill(userVisibleState.label);
  }

  if (status.state === "ready") {
    return buildGoogleAdsActivePill(status);
  }

  if (status.state === "advisor_not_ready") {
    if (typeof percent === "number" && percent < 100 && progressLabel) {
      return buildSyncingPill(percent, progressLabel);
    }
    return buildInfoPill("Core live");
  }

  if (status.state === "partial") {
    if (typeof percent === "number" && percent < 100) {
      return buildSyncingPill(percent, "Partially ready");
    }
    return buildInfoPill("Partially ready");
  }

  if (status.panel?.coreUsable) {
    if (typeof percent === "number" && percent < 100 && progressLabel) {
      return buildSyncingPill(percent, progressLabel);
    }
    return buildInfoPill("Core live");
  }

  if (typeof percent === "number" && percent < 100) {
    return buildSyncingPill(percent);
  }

  if (percent === 100) {
    return buildGoogleAdsActivePill(status);
  }

  if (status.state === "syncing" && typeof percent === "number") {
    return buildSyncingPill(percent);
  }

  if (status.state === "syncing") {
    return buildAttentionPill();
  }

  return buildGoogleAdsActivePill(status);
}

export function resolveProviderSyncStatusPill(params: {
  provider: string;
  metaStatus?: MetaStatusResponse | null;
  googleAdsStatus?: GoogleAdsStatusResponse | null;
}) {
  if (params.provider === "meta") {
    return resolveMetaSyncStatusPill(params.metaStatus ?? null);
  }
  if (params.provider === "google" || params.provider === "google_ads") {
    return resolveGoogleAdsSyncStatusPill(params.googleAdsStatus ?? null);
  }
  return null;
}
