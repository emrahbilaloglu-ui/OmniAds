import { randomUUID } from "node:crypto";
import { getIntegration } from "@/lib/integrations";
import { connectionGenerationTokenFromIntegration } from "@/lib/provider-property-selection";
import {
  finalizeMetaAdDuplicatePreProviderFailure,
  listMetaAdDuplicateReconciliationCandidates,
  recordMetaAdDuplicateReconciliationObservation,
  reconcileMetaAdDuplicateAttempt,
  type MetaAdDuplicateObservationDisposition,
  type MetaAdDuplicateObservationMethod,
  type MetaAdDuplicateReconciliationCandidate,
  type MetaAdDuplicateScanCheckpoint,
} from "@/lib/meta/duplicate-ad-reconciliation-store";
import {
  readMetaAdDuplicateProviderObservation,
  scanMetaAdDuplicatesByMarker,
  type MetaAdDuplicateProviderObservation,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

export type MetaAdDuplicateReconciliationDisposition =
  | "reconciled_match"
  | "reconciled_no_provider_attempt"
  | "absence_observed_quarantined"
  | "quarantined_incomplete"
  | "quarantined_multiple"
  | "quarantined_drift"
  | "credentials_unavailable"
  | "persistence_unavailable";

export interface MetaAdDuplicateReconciliationSweepItem {
  sourceActionLogId: string;
  disposition: MetaAdDuplicateReconciliationDisposition;
  resultingAdId: string | null;
  blocker: string | null;
}

const META_AD_DUPLICATE_SWEEP_MAX_DURATION_MS = 25_000;
const META_AD_DUPLICATE_MIN_PROVIDER_BUDGET_MS = 50;

function remainingProviderBudget(deadlineAt: number | undefined) {
  if (deadlineAt == null) return undefined;
  const remainingMs = Math.floor(deadlineAt - Date.now());
  return remainingMs >= META_AD_DUPLICATE_MIN_PROVIDER_BUDGET_MS
    ? remainingMs
    : null;
}

async function deadlineExhaustedItem(
  candidate: MetaAdDuplicateReconciliationCandidate,
  resultingAdId = candidate.resultingAdId,
  priorScanEvidence?: Record<string, unknown>,
): Promise<MetaAdDuplicateReconciliationSweepItem> {
  const observedAt = new Date().toISOString();
  const persisted = await persistQuarantineObservation({
    candidate,
    observationMethod: "internal",
    disposition: "provider_deadline_exhausted",
    resultingAdId,
    scanComplete: false,
    scannedPageCount: 0,
    observationCount: 0,
    exactMatchCount: 0,
    observedAt,
    observationEvidence: {
      contractVersion:
        "meta-ad-duplicate-provider-deadline-observation.v1",
      blocker: "provider_deadline_exhausted",
      observedAt,
      ...(priorScanEvidence ? { priorScanEvidence } : {}),
    },
  });
  if (!persisted) {
    return observationPersistenceFailure(candidate, resultingAdId);
  }
  return {
    sourceActionLogId: candidate.sourceActionLogId,
    disposition: "quarantined_incomplete",
    resultingAdId,
    blocker: "provider_deadline_exhausted",
  };
}

function lookupTarget(candidate: MetaAdDuplicateReconciliationCandidate) {
  return {
    marker: candidate.marker,
    canonicalAdName: candidate.canonicalAdName,
    targetAdsetId: candidate.targetAdsetId,
    creativeId: candidate.sourceCreativeId,
    requestedStatus: candidate.requestedStatus,
  };
}

async function contextForCandidate(
  candidate: MetaAdDuplicateReconciliationCandidate,
): Promise<MetaAdsWriteContext | null> {
  const integration = await getIntegration(
    candidate.businessId,
    "meta",
  ).catch(() => null);
  if (integration?.status !== "connected" || !integration.access_token) {
    return null;
  }
  // origin/main requires an atomic connection-generation token on every write
  // context. No token means the authority cannot be proven, so fail closed and
  // perform no provider write.
  const connectionGeneration =
    connectionGenerationTokenFromIntegration(integration);
  if (!connectionGeneration) {
    return null;
  }
  return {
    businessId: candidate.businessId,
    providerAccountId: candidate.providerAccountId,
    accessToken: integration.access_token,
    connectionGeneration,
  };
}

function pointObservationEvidence(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  adId: string;
  observedAt: string;
  blocker: string | null;
  providerEvidence: Record<string, unknown> | null;
  priorScanEvidence?: Record<string, unknown>;
}) {
  return {
    contractVersion: "meta-ad-duplicate-provider-point-read.v1",
    providerAccountId: input.candidate.providerAccountId,
    marker: input.candidate.marker,
    canonicalAdName: input.candidate.canonicalAdName,
    targetAdsetId: input.candidate.targetAdsetId,
    creativeId: input.candidate.sourceCreativeId,
    requestedStatus: input.candidate.requestedStatus,
    adId: input.adId,
    blocker: input.blocker,
    observedAt: input.observedAt,
    providerEvidence: input.providerEvidence,
    ...(input.priorScanEvidence
      ? { priorScanEvidence: input.priorScanEvidence }
      : {}),
  };
}

function exactPointMatchEvidence(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  observation: MetaAdDuplicateProviderObservation;
}) {
  return {
    contractVersion: "meta-ad-duplicate-known-result-point-get.v1",
    providerAccountId: input.candidate.providerAccountId,
    marker: input.candidate.marker,
    canonicalAdName: input.candidate.canonicalAdName,
    targetAdsetId: input.candidate.targetAdsetId,
    creativeId: input.candidate.sourceCreativeId,
    requestedStatus: input.candidate.requestedStatus,
    complete: true,
    adId: input.observation.id,
    observedAt: input.observation.observedAt,
  };
}

async function persistQuarantineObservation(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  observationMethod: MetaAdDuplicateObservationMethod;
  disposition: MetaAdDuplicateObservationDisposition;
  resultingAdId: string | null;
  scanComplete: boolean;
  scannedPageCount: number;
  observationCount: number;
  exactMatchCount: number;
  observedAt: string;
  observationEvidence: Record<string, unknown>;
  scanCheckpoint?: MetaAdDuplicateScanCheckpoint | null;
}) {
  try {
    await recordMetaAdDuplicateReconciliationObservation(input);
    return true;
  } catch {
    return false;
  }
}

function checkpointForScan(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  scan: Awaited<ReturnType<typeof scanMetaAdDuplicatesByMarker>>;
}): MetaAdDuplicateScanCheckpoint {
  const continuation = input.candidate.scanContinuation ?? null;
  return {
    cycleId: continuation?.cycleId ?? randomUUID(),
    segmentIndex: continuation?.segmentIndex ?? 0,
    segmentStartAfterCursor: input.scan.segmentStartAfterCursor,
    segmentStartCursorHash: input.scan.segmentStartCursorHash,
    segmentEndAfterCursor: input.scan.segmentEndAfterCursor,
    segmentEndCursorHash: input.scan.segmentEndCursorHash,
    cycleComplete: input.scan.complete,
    visitedCursorHashes: input.scan.visitedCursorHashes,
    cumulativePageCount: input.scan.pageCount,
    cumulativeObservationCount: input.scan.observationCount,
    cumulativeExactMatchIds: input.scan.exactMatchIds,
  };
}

function observationPersistenceFailure(
  candidate: MetaAdDuplicateReconciliationCandidate,
  resultingAdId: string | null,
): MetaAdDuplicateReconciliationSweepItem {
  return {
    sourceActionLogId: candidate.sourceActionLogId,
    disposition: "persistence_unavailable",
    resultingAdId,
    blocker: "reconciliation_observation_persistence_unavailable",
  };
}

async function persistMatch(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  observation: MetaAdDuplicateProviderObservation;
  scanEvidence: Record<string, unknown>;
  scannedPageCount: number;
  observationCount: number;
}) {
  await reconcileMetaAdDuplicateAttempt({
    candidate: input.candidate,
    resolution: "exact_provider_match",
    resultingAdId: input.observation.id,
    scanComplete: true,
    scannedPageCount: input.scannedPageCount,
    observationCount: input.observationCount,
    exactMatchCount: 1,
    observedAt: input.observation.observedAt,
    providerAd: input.observation.providerGetEvidence,
    scanEvidence: input.scanEvidence,
  });
}

/**
 * Reconciles one settled duplicate claim using provider GETs only. It never
 * calls duplicateAd and therefore has no provider mutation path.
 */
export async function reconcileMetaAdDuplicateCandidate(
  candidate: MetaAdDuplicateReconciliationCandidate,
  options?: { providerDeadlineAt?: number },
): Promise<MetaAdDuplicateReconciliationSweepItem> {
  if (candidate.authorityKind === "expired_prepared") {
    try {
      await finalizeMetaAdDuplicatePreProviderFailure({
        sourceActionLogId: candidate.sourceActionLogId,
        errorCode: "duplicate_prepared_lease_expired_without_start",
        errorMessage:
          "The duplicate preparation lease expired without a durable attempt start, proving that no provider POST was authorized.",
        durationMs: 0,
      });
    } catch {
      return observationPersistenceFailure(
        candidate,
        candidate.resultingAdId,
      );
    }
    return {
      sourceActionLogId: candidate.sourceActionLogId,
      disposition: "reconciled_no_provider_attempt",
      resultingAdId: null,
      blocker: null,
    };
  }

  const ctx = await contextForCandidate(candidate);
  if (!ctx) {
    const observedAt = new Date().toISOString();
    const persisted = await persistQuarantineObservation({
      candidate,
      observationMethod: "credentials",
      disposition: "credentials_unavailable",
      resultingAdId: candidate.resultingAdId,
      scanComplete: false,
      scannedPageCount: 0,
      observationCount: 0,
      exactMatchCount: 0,
      observedAt,
      observationEvidence: {
        contractVersion: "meta-ad-duplicate-credentials-observation.v1",
        blocker: "meta_credentials_unavailable",
        observedAt,
      },
    });
    if (!persisted) {
      return observationPersistenceFailure(
        candidate,
        candidate.resultingAdId,
      );
    }
    return {
      sourceActionLogId: candidate.sourceActionLogId,
      disposition: "credentials_unavailable",
      resultingAdId: candidate.resultingAdId,
      blocker: "meta_credentials_unavailable",
    };
  }
  const target = lookupTarget(candidate);

  if (candidate.resultingAdId) {
    const pointBudget = remainingProviderBudget(
      options?.providerDeadlineAt,
    );
    if (pointBudget === null) {
      return deadlineExhaustedItem(candidate);
    }
    const point = await readMetaAdDuplicateProviderObservation({
      ctx,
      adId: candidate.resultingAdId,
      target,
      timeoutMs: pointBudget,
    });
    if (!point.ok) {
      const disposition =
        point.blocker === "provider_identity_drift"
          ? "provider_identity_drift"
          : "provider_read_incomplete";
      const persisted = await persistQuarantineObservation({
        candidate,
        observationMethod: "known_result_point_get",
        disposition,
        resultingAdId: candidate.resultingAdId,
        scanComplete: false,
        scannedPageCount: 0,
        observationCount: point.evidence ? 1 : 0,
        exactMatchCount: 0,
        observedAt: point.observedAt,
        observationEvidence: pointObservationEvidence({
          candidate,
          adId: candidate.resultingAdId,
          observedAt: point.observedAt,
          blocker: point.blocker,
          providerEvidence: point.evidence,
        }),
      });
      if (!persisted) {
        return observationPersistenceFailure(
          candidate,
          candidate.resultingAdId,
        );
      }
      return {
        sourceActionLogId: candidate.sourceActionLogId,
        disposition:
          point.blocker === "provider_identity_drift"
            ? "quarantined_drift"
            : "quarantined_incomplete",
        resultingAdId: candidate.resultingAdId,
        blocker: point.blocker,
      };
    }
    try {
      await persistMatch({
        candidate,
        observation: point.observation,
        scannedPageCount: 0,
        observationCount: 1,
        scanEvidence: exactPointMatchEvidence({
          candidate,
          observation: point.observation,
        }),
      });
    } catch {
      await persistQuarantineObservation({
        candidate,
        observationMethod: "known_result_point_get",
        disposition: "reconciliation_persistence_unavailable",
        resultingAdId: candidate.resultingAdId,
        scanComplete: true,
        scannedPageCount: 0,
        observationCount: 1,
        exactMatchCount: 1,
        observedAt: point.observation.observedAt,
        observationEvidence: pointObservationEvidence({
          candidate,
          adId: candidate.resultingAdId,
          observedAt: point.observation.observedAt,
          blocker: null,
          providerEvidence: point.observation.providerGetEvidence,
        }),
      });
      return {
        sourceActionLogId: candidate.sourceActionLogId,
        disposition: "persistence_unavailable",
        resultingAdId: candidate.resultingAdId,
        blocker: "reconciliation_persistence_unavailable",
      };
    }
    return {
      sourceActionLogId: candidate.sourceActionLogId,
      disposition: "reconciled_match",
      resultingAdId: point.observation.id,
      blocker: null,
    };
  }

  const continuation = candidate.scanContinuation ?? null;
  const scanBudget = remainingProviderBudget(
    options?.providerDeadlineAt,
  );
  if (scanBudget === null) {
    return deadlineExhaustedItem(candidate);
  }
  const scan = await scanMetaAdDuplicatesByMarker({
    ctx,
    target,
    afterCursor: continuation?.afterCursor ?? null,
    visitedCursorHashes: continuation?.visitedCursorHashes ?? [],
    cumulativePageCount: continuation?.cumulativePageCount ?? 0,
    cumulativeObservationCount:
      continuation?.cumulativeObservationCount ?? 0,
    cumulativeExactMatchIds:
      continuation?.cumulativeExactMatchIds ?? [],
    maxDurationMs: scanBudget,
  });
  const scanCheckpoint = checkpointForScan({ candidate, scan });
  if (!scan.complete) {
    const disposition =
      scan.blocker === "pagination_segment_limit"
        ? "scan_segment_progress"
        : scan.blocker === "provider_identity_drift"
          ? "provider_identity_drift"
          : "provider_read_incomplete";
    const persisted = await persistQuarantineObservation({
      candidate,
      observationMethod: "account_ads_scan",
      disposition,
      resultingAdId: null,
      scanComplete: scan.complete,
      scannedPageCount: scan.pageCount,
      observationCount: scan.observationCount,
      exactMatchCount: scan.exactMatchIds.length,
      observedAt: scan.observedAt,
      observationEvidence: scan.evidence,
      scanCheckpoint,
    });
    if (!persisted) {
      return observationPersistenceFailure(candidate, null);
    }
    return {
      sourceActionLogId: candidate.sourceActionLogId,
      disposition:
        scan.blocker === "provider_identity_drift"
          ? "quarantined_drift"
          : "quarantined_incomplete",
      resultingAdId: null,
      blocker: scan.blocker,
    };
  }
  if (scan.exactMatchIds.length > 1) {
    const persisted = await persistQuarantineObservation({
      candidate,
      observationMethod: "account_ads_scan",
      disposition: "multiple_exact_provider_matches",
      resultingAdId: null,
      scanComplete: true,
      scannedPageCount: scan.pageCount,
      observationCount: scan.observationCount,
      exactMatchCount: scan.exactMatchIds.length,
      observedAt: scan.observedAt,
      observationEvidence: scan.evidence,
      scanCheckpoint,
    });
    if (!persisted) {
      return observationPersistenceFailure(candidate, null);
    }
    return {
      sourceActionLogId: candidate.sourceActionLogId,
      disposition: "quarantined_multiple",
      resultingAdId: null,
      blocker: "multiple_exact_provider_matches",
    };
  }
  if (scan.exactMatchIds.length === 1) {
    const matchId = scan.exactMatchIds[0]!;
    const pointBudget = remainingProviderBudget(
      options?.providerDeadlineAt,
    );
    if (pointBudget === null) {
      const persisted = await persistQuarantineObservation({
        candidate,
        observationMethod: "account_ads_scan",
        disposition: "point_verification_pending",
        resultingAdId: matchId,
        scanComplete: true,
        scannedPageCount: scan.pageCount,
        observationCount: scan.observationCount,
        exactMatchCount: 1,
        observedAt: scan.observedAt,
        observationEvidence: {
          ...scan.evidence,
          pointVerificationBlocker: "provider_deadline_exhausted",
        },
        scanCheckpoint,
      });
      if (!persisted) {
        return observationPersistenceFailure(candidate, matchId);
      }
      return {
        sourceActionLogId: candidate.sourceActionLogId,
        disposition: "quarantined_incomplete",
        resultingAdId: matchId,
        blocker: "provider_deadline_exhausted",
      };
    }
    const point = await readMetaAdDuplicateProviderObservation({
      ctx,
      adId: matchId,
      target,
      timeoutMs: pointBudget,
    });
    if (!point.ok) {
      const disposition =
        point.blocker === "provider_identity_drift"
          ? "provider_identity_drift"
          : "provider_read_incomplete";
      const persisted = await persistQuarantineObservation({
        candidate,
        observationMethod: "known_result_point_get",
        disposition,
        resultingAdId: matchId,
        scanComplete: false,
        scannedPageCount: 0,
        observationCount: point.evidence ? 1 : 0,
        exactMatchCount: 0,
        observedAt: point.observedAt,
        observationEvidence: pointObservationEvidence({
          candidate,
          adId: matchId,
          observedAt: point.observedAt,
          blocker: point.blocker,
          providerEvidence: point.evidence,
          priorScanEvidence: {
            ...scan.evidence,
            scanCheckpoint,
          },
        }),
      });
      if (!persisted) {
        return observationPersistenceFailure(candidate, matchId);
      }
      return {
        sourceActionLogId: candidate.sourceActionLogId,
        disposition:
          point.blocker === "provider_identity_drift"
            ? "quarantined_drift"
            : "quarantined_incomplete",
        resultingAdId: matchId,
        blocker: point.blocker,
      };
    }
    try {
      await persistMatch({
        candidate,
        observation: point.observation,
        scanEvidence: {
          ...scan.evidence,
          scanCheckpoint,
        },
        scannedPageCount: scan.pageCount,
        observationCount: scan.observationCount,
      });
    } catch {
      await persistQuarantineObservation({
        candidate,
        observationMethod: "account_ads_scan",
        disposition: "reconciliation_persistence_unavailable",
        resultingAdId: matchId,
        scanComplete: true,
        scannedPageCount: scan.pageCount,
        observationCount: scan.observationCount,
        exactMatchCount: 1,
        observedAt: scan.observedAt,
        observationEvidence: scan.evidence,
        scanCheckpoint,
      });
      return {
        sourceActionLogId: candidate.sourceActionLogId,
        disposition: "persistence_unavailable",
        resultingAdId: matchId,
        blocker: "reconciliation_persistence_unavailable",
      };
    }
    return {
      sourceActionLogId: candidate.sourceActionLogId,
      disposition: "reconciled_match",
      resultingAdId: matchId,
      blocker: null,
    };
  }

  const persisted = await persistQuarantineObservation({
    candidate,
    observationMethod: "account_ads_scan",
    disposition: "complete_scan_absence",
    resultingAdId: null,
    scanComplete: true,
    scannedPageCount: scan.pageCount,
    observationCount: scan.observationCount,
    exactMatchCount: 0,
    observedAt: scan.observedAt,
    observationEvidence: scan.evidence,
    scanCheckpoint,
  });
  if (!persisted) {
    return observationPersistenceFailure(candidate, null);
  }
  return {
    sourceActionLogId: candidate.sourceActionLogId,
    disposition: "absence_observed_quarantined",
    resultingAdId: null,
    blocker: "provider_absence_is_not_final",
  };
}

/**
 * Bounded natural-scheduler sweep. Deliberately sequential (concurrency 1)
 * so reconciliation cannot amplify provider reads or affect unrelated work.
 */
export async function runMetaAdDuplicateReconciliationSweep(input?: {
  limit?: number;
  maxDurationMs?: number;
}) {
  const limit = Math.max(1, Math.min(5, Math.floor(input?.limit ?? 3)));
  const maxDurationMs = Math.max(
    1_000,
    Math.min(
      META_AD_DUPLICATE_SWEEP_MAX_DURATION_MS,
      Math.floor(
        input?.maxDurationMs ?? META_AD_DUPLICATE_SWEEP_MAX_DURATION_MS,
      ),
    ),
  );
  const providerDeadlineAt = Date.now() + maxDurationMs;
  const candidates =
    await listMetaAdDuplicateReconciliationCandidates(limit);
  const results: MetaAdDuplicateReconciliationSweepItem[] = [];
  let deadlineExhausted = false;
  for (const candidate of candidates) {
    if (Date.now() >= providerDeadlineAt) {
      results.push(await deadlineExhaustedItem(candidate));
      deadlineExhausted = true;
      break;
    }
    try {
      const result = await reconcileMetaAdDuplicateCandidate(candidate, {
        providerDeadlineAt,
      });
      results.push(result);
      if (
        result.blocker === "provider_deadline_exhausted" ||
        Date.now() >= providerDeadlineAt
      ) {
        deadlineExhausted = true;
        break;
      }
    } catch {
      const observedAt = new Date().toISOString();
      const persisted = await persistQuarantineObservation({
        candidate,
        observationMethod: "internal",
        disposition: "unexpected_reconciliation_error",
        resultingAdId: candidate.resultingAdId,
        scanComplete: false,
        scannedPageCount: 0,
        observationCount: 0,
        exactMatchCount: 0,
        observedAt,
        observationEvidence: {
          contractVersion:
            "meta-ad-duplicate-internal-reconciliation-observation.v1",
          blocker: "unexpected_reconciliation_error",
          observedAt,
        },
      });
      results.push(
        persisted
          ? {
              sourceActionLogId: candidate.sourceActionLogId,
              disposition: "quarantined_incomplete",
              resultingAdId: candidate.resultingAdId,
              blocker: "unexpected_reconciliation_error",
            }
          : observationPersistenceFailure(
              candidate,
              candidate.resultingAdId,
            ),
      );
    }
  }
  return {
    scanned: candidates.length,
    attempted: results.length,
    reconciled: results.filter((result) =>
      result.disposition.startsWith("reconciled_"),
    ).length,
    deadlineExhausted,
    results,
  };
}
