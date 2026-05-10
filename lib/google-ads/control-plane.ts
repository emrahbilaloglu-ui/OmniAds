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
  stallFingerprints: ProviderStallFingerprint[];
}

export function buildGoogleAdsReleaseReadinessCandidate(
  input: GoogleAdsReleaseCandidateInput,
): GoogleAdsReleaseReadinessCandidate | null {
  if (!input.connected || input.assignedAccountCount <= 0) {
    return null;
  }

  const candidate = classifyProviderReleaseTruth({
    activityState: input.activityState,
    progressState: input.progressState,
    workerOnline: input.workerOnline,
    queueDepth: input.queueDepth,
    leasedPartitions: input.leasedPartitions,
    truthReady: input.truthReady ?? input.syncTruthState === "ready",
    retryableFailedPartitions: input.retryableFailedPartitions,
    deadLetterPartitions: input.deadLetterPartitions,
    staleLeasePartitions: input.staleLeasePartitions,
    reclaimCandidateCount: 0,
    recentTruthState: input.syncTruthState === "ready" ? "ready" : input.syncTruthState,
    priorityTruthState: input.syncTruthState === "ready" ? "ready" : input.syncTruthState,
    stallFingerprints: input.stallFingerprints,
  });
  if (input.totalQueueDepth == null) return candidate;
  return {
    ...candidate,
    evidence: {
      ...candidate.evidence,
      queueDepth: input.totalQueueDepth,
      releaseBlockingQueueDepth: input.queueDepth,
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
