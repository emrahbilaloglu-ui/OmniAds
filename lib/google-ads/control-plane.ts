import type {
  ProviderActivityState,
  ProviderProgressState,
  ProviderStallFingerprint,
  SyncTruthState,
} from "@/lib/sync/provider-status-truth";
import {
  classifyProviderReleaseTruth,
  type SyncBlockerClass,
  type SyncGateBaseResult,
  type SyncGateRecord,
} from "@/lib/sync/release-gates";
import { readSyncGateMode, type SyncGateMode } from "@/lib/sync/runtime-contract";
import type { GoogleAdsReleaseReadinessCandidate } from "@/lib/google-ads/status-types";
import {
  isGoogleAdsFreshnessSettled,
  isGoogleAdsPostCloseObserved,
  unknownGoogleAdsFreshnessEvidence,
  type GoogleAdsFreshnessEvidence,
} from "@/lib/google-ads/control-plane-runtime";

export interface GoogleAdsReleaseCandidateInput {
  connected: boolean;
  assignedAccountCount: number;
  activityState: ProviderActivityState;
  progressState: ProviderProgressState;
  workerOnline: boolean | null;
  queueDepth: number;
  totalQueueDepth?: number;
  leasedPartitions: number;
  retryableFailedPartitions: number;
  deadLetterPartitions: number;
  staleLeasePartitions: number;
  syncTruthState: SyncTruthState;
  truthReady?: boolean;
  /**
   * Post-close observation evidence for the core scopes.
   *
   * Optional in the TYPE only, so that callers this change does not own keep
   * compiling. Omitting it is read as `unknown`, which withholds `truthReady`
   * and therefore the pass. There is no argument list that produces a green
   * candidate without freshness evidence — in particular, neither an
   * already-`ready` `syncTruthState` nor a caller-supplied `truthReady: true`
   * can stand in for it.
   */
  freshness?: GoogleAdsFreshnessEvidence | null;
  stallFingerprints: ProviderStallFingerprint[];
}

export function buildGoogleAdsReleaseReadinessCandidate(
  input: GoogleAdsReleaseCandidateInput,
): GoogleAdsReleaseReadinessCandidate | null {
  if (!input.connected || input.assignedAccountCount <= 0) {
    return null;
  }

  const freshness =
    input.freshness ??
    unknownGoogleAdsFreshnessEvidence(
      "Google Ads freshness evidence was not supplied to the release readiness candidate.",
    );
  const postCloseObserved = isGoogleAdsPostCloseObserved(freshness);
  // Conjunctive, never a fallback. `syncTruthState === "ready"` is derived from
  // queue and activity shape, which a workspace can hold while every one of its
  // days was captured once intraday and never re-read.
  const truthReady =
    (input.truthReady ?? input.syncTruthState === "ready") && postCloseObserved;

  const candidate = classifyProviderReleaseTruth({
    activityState: input.activityState,
    progressState: input.progressState,
    workerOnline: input.workerOnline,
    queueDepth: input.queueDepth,
    leasedPartitions: input.leasedPartitions,
    truthReady,
    freshnessPostCloseObserved: postCloseObserved,
    freshnessState: freshness.state,
    freshnessEvidenceAvailable: freshness.evidenceAvailable,
    retryableFailedPartitions: input.retryableFailedPartitions,
    deadLetterPartitions: input.deadLetterPartitions,
    staleLeasePartitions: input.staleLeasePartitions,
    reclaimCandidateCount: 0,
    recentTruthState: input.syncTruthState === "ready" ? "ready" : input.syncTruthState,
    priorityTruthState: input.syncTruthState === "ready" ? "ready" : input.syncTruthState,
    stallFingerprints: input.stallFingerprints,
  });
  return {
    ...candidate,
    evidence: {
      ...candidate.evidence,
      // `converging` may serve and may pass; only `settled` is completion. The
      // two stay separate fields so no reader can collapse them, and neither is
      // ever labelled final or immutable.
      freshnessSettled: isGoogleAdsFreshnessSettled(freshness),
      freshnessUnavailableReason: freshness.unavailableReason,
      /** Fail-closed is not terminal: a later pass may still pass. */
      freshnessRetryable: !postCloseObserved,
      ...(input.totalQueueDepth == null
        ? {}
        : {
            queueDepth: input.totalQueueDepth,
            releaseBlockingQueueDepth: input.queueDepth,
          }),
    },
  };
}

export interface GoogleAdsReleaseGateCanary {
  businessId: string;
  businessName: string | null;
  pass: boolean;
  blockerClass: SyncBlockerClass | null;
  evidence: Record<string, unknown>;
}

function mapReleaseGateVerdict(
  baseResult: SyncGateBaseResult,
  mode: SyncGateMode,
) {
  if (baseResult === "pass") return "pass" as const;
  if (baseResult === "misconfigured") return "misconfigured" as const;
  if (mode === "measure_only") return "measure_only" as const;
  if (mode === "warn_only") return "warn_only" as const;
  return "blocked" as const;
}

function nowIso() {
  return new Date().toISOString();
}

export function buildGoogleAdsReleaseGateRecord(input: {
  buildId: string;
  environment: string;
  canaries: GoogleAdsReleaseGateCanary[];
  breakGlass?: boolean;
  overrideReason?: string | null;
}): SyncGateRecord {
  const mode = readSyncGateMode("SYNC_RELEASE_GATE_MODE", process.env);
  const failingCanaries = input.canaries.filter((row) => !row.pass);
  const baseResult: SyncGateBaseResult =
    input.canaries.length > 0 && failingCanaries.length === 0 ? "pass" : "fail";
  const blockerClass =
    failingCanaries[0]?.blockerClass && failingCanaries[0].blockerClass !== "none"
      ? failingCanaries[0].blockerClass
      : null;

  return {
    id: null,
    gateKind: "release_gate",
    gateScope: "release_readiness",
    buildId: input.buildId,
    environment: input.environment,
    mode,
    baseResult,
    verdict: mapReleaseGateVerdict(baseResult, mode),
    blockerClass,
    summary:
      baseResult === "pass"
        ? "Google Ads release gate snapshot passed."
        : input.canaries.length === 0
          ? "Google Ads release gate snapshot has no connected assigned businesses."
          : `Google Ads release gate snapshot failed for ${failingCanaries
              .map((row) => row.businessName ?? row.businessId)
              .join(", ")}.`,
    breakGlass: Boolean(input.breakGlass),
    overrideReason: input.overrideReason ?? null,
    evidence: {
      providerScope: "google_ads",
      canaries: input.canaries,
    },
    emittedAt: nowIso(),
  };
}
