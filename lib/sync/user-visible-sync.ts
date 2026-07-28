import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";

export type UserVisibleSyncStateKind =
  | "healthy"
  | "refreshing_in_background"
  | "using_latest_available_data"
  | "setup_required"
  | "reconnect_required"
  | "data_unavailable";

export interface UserVisibleSyncState {
  kind: UserVisibleSyncStateKind;
  label: string;
  suppressRecoverableAttention: boolean;
  degradedServing: boolean;
}

type DeriveUserVisibleSyncStateInput = {
  connected: boolean;
  hasAssignment: boolean;
  hasUsableSnapshot: boolean;
  controlPlaneExact: boolean;
  releaseGateVerdict: string | null;
  blockerClass: string | null;
  syncTruthState: string | null;
  recommendations:
    | Array<{
        safetyClassification?: string | null;
      }>
    | null
    | undefined;
};

function hasOnlyRecoverableRecommendations(
  recommendations:
    | Array<{
        safetyClassification?: string | null;
      }>
    | null
    | undefined,
) {
  const rows = recommendations ?? [];
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        typeof row.safetyClassification === "string" &&
        row.safetyClassification !== "blocked",
    )
  );
}

function isControlPlaneClosed(input: DeriveUserVisibleSyncStateInput) {
  return (
    input.controlPlaneExact &&
    input.releaseGateVerdict === "pass" &&
    (input.recommendations?.length ?? 0) === 0 &&
    (input.blockerClass == null || input.blockerClass === "none")
  );
}

export function deriveUserVisibleSyncState(
  input: DeriveUserVisibleSyncStateInput,
): UserVisibleSyncState {
  if (!input.connected) {
    return {
      kind: "reconnect_required",
      label: "Reconnect required",
      suppressRecoverableAttention: false,
      degradedServing: false,
    };
  }

  if (!input.hasAssignment) {
    return {
      kind: "setup_required",
      label: "Setup required",
      suppressRecoverableAttention: false,
      degradedServing: false,
    };
  }

  if (isControlPlaneClosed(input)) {
    return {
      kind: "healthy",
      label: "Active",
      suppressRecoverableAttention: true,
      degradedServing: false,
    };
  }

  const recoverable =
    input.hasUsableSnapshot &&
    hasOnlyRecoverableRecommendations(input.recommendations) &&
    input.blockerClass !== "queue_blocked" &&
    input.blockerClass !== "stalled" &&
    input.blockerClass !== "not_release_ready";

  if (recoverable) {
    const isActivelyRefreshing =
      input.syncTruthState === "syncing" ||
      input.syncTruthState === "blocked" ||
      input.syncTruthState === "repairing" ||
      input.syncTruthState === "partial" ||
      input.releaseGateVerdict === "blocked" ||
      input.releaseGateVerdict === "measure_only" ||
      input.releaseGateVerdict === "warn_only";

    return {
      kind: isActivelyRefreshing
        ? "refreshing_in_background"
        : "using_latest_available_data",
      label: isActivelyRefreshing
        ? "Refreshing in background"
        : "Using latest available data",
      suppressRecoverableAttention: true,
      degradedServing: true,
    };
  }

  if (input.hasUsableSnapshot) {
    return {
      kind: "using_latest_available_data",
      label: "Using latest available data",
      suppressRecoverableAttention: false,
      degradedServing: true,
    };
  }

  return {
    kind: "data_unavailable",
    label: "Data unavailable",
    suppressRecoverableAttention: false,
    degradedServing: false,
  };
}

export function deriveMetaUserVisibleSyncState(
  status: MetaStatusResponse | null | undefined,
) {
  return deriveUserVisibleSyncState({
    connected: Boolean(status?.connected),
    hasAssignment: (status?.assignedAccountIds?.length ?? 0) > 0,
    hasUsableSnapshot:
      status?.coreReadiness?.usable === true ||
      status?.pageReadiness?.state === "ready" ||
      status?.pageReadiness?.state === "partial",
    controlPlaneExact: status?.controlPlanePersistence?.exactRowsPresent === true,
    releaseGateVerdict:
      typeof status?.releaseGate?.verdict === "string"
        ? status.releaseGate.verdict
        : null,
    blockerClass:
      typeof status?.blockerClass === "string" ? status.blockerClass : null,
    syncTruthState:
      typeof status?.syncTruthState === "string" ? status.syncTruthState : null,
    recommendations: status?.repairPlan?.recommendations,
  });
}

export function deriveGoogleUserVisibleSyncState(
  status: GoogleAdsStatusResponse | null | undefined,
) {
  const hasUsableGoogleCore =
    status?.panel?.coreUsable === true ||
    status?.domains?.core?.state === "ready";
  const state = deriveUserVisibleSyncState({
    connected: Boolean(status?.connected),
    hasAssignment: (status?.assignedAccountIds?.length ?? 0) > 0,
    hasUsableSnapshot: hasUsableGoogleCore,
    controlPlaneExact: status?.controlPlanePersistence?.exactRowsPresent === true,
    releaseGateVerdict:
      typeof status?.releaseGate?.verdict === "string"
        ? status.releaseGate.verdict
        : null,
    blockerClass:
      typeof status?.blockerClass === "string" ? status.blockerClass : null,
    syncTruthState:
      typeof status?.syncTruthState === "string" ? status.syncTruthState : null,
    recommendations: status?.repairPlan?.recommendations,
  });

  const recommendationCount = status?.repairPlan?.recommendations?.length ?? 0;
  const statusBlocker =
    typeof status?.blockerClass === "string" ? status.blockerClass : null;
  const releaseBlocker =
    typeof status?.releaseGate?.blockerClass === "string"
      ? status.releaseGate.blockerClass
      : null;
  const backfillIncomplete =
    status?.backgroundBackfill?.incomplete === true ||
    (status?.requiredScopeCompletion != null &&
      status.requiredScopeCompletion.complete === false);
  const recoverableBackfillRecommendation =
    recommendationCount === 0 ||
    (hasUsableGoogleCore &&
      (status?.repairPlan?.recommendations ?? []).every(
        (row) =>
          typeof row.safetyClassification === "string" &&
          row.safetyClassification !== "blocked",
      ));
  const backfillOnlyReleaseGate =
    hasUsableGoogleCore &&
    status?.controlPlanePersistence?.exactRowsPresent === true &&
    status?.releaseGate?.verdict != null &&
    status.releaseGate.verdict !== "pass" &&
    recoverableBackfillRecommendation &&
    backfillIncomplete &&
    (statusBlocker == null ||
      statusBlocker === "none" ||
      statusBlocker === "not_release_ready" ||
      statusBlocker === "stalled") &&
    (releaseBlocker == null ||
      releaseBlocker === "none" ||
      releaseBlocker === "not_release_ready" ||
      releaseBlocker === "stalled");

  if (backfillOnlyReleaseGate) {
    return {
      kind: "refreshing_in_background" as const,
      label: "Refreshing in background",
      suppressRecoverableAttention: true,
      degradedServing: true,
    };
  }

  if (
    state.kind === "healthy" &&
    status?.backgroundBackfill?.incomplete === true &&
    hasUsableGoogleCore
  ) {
    return {
      kind: "refreshing_in_background" as const,
      label: "Refreshing in background",
      suppressRecoverableAttention: true,
      degradedServing: true,
    };
  }

  // "Healthy" must survive the freshness question.
  //
  // Everything above derives from `coreUsable` / `domains.core.state`, which
  // are availability answers: they say the workspace has data to render, not
  // that the data was ever re-read after its day closed. A range captured once
  // at 01:40 satisfies both and used to render a flat green "healthy".
  //
  // The bar for staying healthy is `converging` or `settled` — every day in the
  // range re-read after it closed. `converging` counts because a rolling range
  // always has recent days inside the conversion window, so demanding `settled`
  // would mean never healthy. Anything weaker, INCLUDING a missing freshness
  // block (older server, failed read), demotes to a non-alarming refreshing
  // state rather than either lying green or raising a false incident.
  if (state.kind === "healthy") {
    // `evidenceAvailable` is checked separately from the state. Today the
    // fail-closed snapshot always pairs `false` with `"unknown"`, so the two are
    // equivalent — but a future route that emits a cached state alongside a
    // failed read would otherwise slip a stale green through.
    const freshness = status?.freshness ?? null;
    const freshnessState = freshness?.evidenceAvailable === true ? freshness.state : null;
    const observedPostClose =
      freshnessState === "converging" || freshnessState === "settled";
    if (!observedPostClose) {
      return {
        kind: "refreshing_in_background" as const,
        label: "Refreshing in background",
        suppressRecoverableAttention: true,
        degradedServing: true,
      };
    }
  }
  return state;
}

export function shouldSuppressRecoverableMetaSyncIssue(
  status: MetaStatusResponse | null | undefined,
) {
  return deriveMetaUserVisibleSyncState(status).suppressRecoverableAttention;
}

export function shouldSuppressRecoverableGoogleSyncIssue(
  status: GoogleAdsStatusResponse | null | undefined,
) {
  return deriveGoogleUserVisibleSyncState(status).suppressRecoverableAttention;
}
