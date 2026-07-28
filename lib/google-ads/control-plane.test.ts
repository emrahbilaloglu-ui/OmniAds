import { afterEach, describe, expect, it } from "vitest";
import {
  buildGoogleAdsReleaseGateRecord,
  buildGoogleAdsReleaseReadinessCandidate,
} from "@/lib/google-ads/control-plane";
import {
  unknownGoogleAdsFreshnessEvidence,
  type GoogleAdsFreshnessEvidence,
} from "@/lib/google-ads/control-plane-runtime";
import type { GoogleAdsCompletionState } from "@/lib/google-ads/completion-semantics";

function evidence(state: GoogleAdsCompletionState): GoogleAdsFreshnessEvidence {
  return {
    evidenceAvailable: state !== "unknown",
    state,
    scopeStates: { account_daily: state, campaign_daily: state },
    unavailableReason: null,
    measuredStartDate: "2026-04-06",
    measuredEndDate: "2026-04-19",
  };
}

/**
 * The shape that used to pass on its own: healthy activity, a draining queue,
 * a `ready` sync truth state. Freshness is supplied separately by each test so
 * the two disagree by construction.
 */
const healthyGoogleState = {
  connected: true as const,
  assignedAccountCount: 1,
  activityState: "busy" as const,
  progressState: "syncing" as const,
  workerOnline: true,
  queueDepth: 4,
  leasedPartitions: 1,
  retryableFailedPartitions: 0,
  deadLetterPartitions: 0,
  staleLeasePartitions: 0,
  syncTruthState: "ready" as const,
  stallFingerprints: [],
};

describe("google ads control plane helper", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when google is disconnected", () => {
    expect(
      buildGoogleAdsReleaseReadinessCandidate({
        ...healthyGoogleState,
        connected: false,
        activityState: "waiting",
        syncTruthState: "waiting",
        freshness: evidence("settled"),
      }),
    ).toBeNull();
  });

  it("refuses a pass when a healthy, ready state has no post-close observation", () => {
    expect(
      buildGoogleAdsReleaseReadinessCandidate({
        ...healthyGoogleState,
        freshness: evidence("provisional"),
      }),
    ).toMatchObject({
      pass: false,
      blockerClass: "not_release_ready",
      evidence: {
        truthReady: false,
        freshnessPostCloseObserved: false,
        freshnessState: "provisional",
        freshnessRetryable: true,
      },
    });
  });

  it("refuses a pass when the caller asserts truthReady but supplies no freshness", () => {
    // A caller cannot hand us readiness. `truthReady` is conjunctive with the
    // verdict, never a substitute for it.
    expect(
      buildGoogleAdsReleaseReadinessCandidate({
        ...healthyGoogleState,
        truthReady: true,
      }),
    ).toMatchObject({
      pass: false,
      blockerClass: "not_release_ready",
      evidence: {
        truthReady: false,
        freshnessState: "unknown",
        freshnessEvidenceAvailable: false,
        freshnessRetryable: true,
      },
    });
  });

  it("fails closed on unreadable freshness without turning it into a terminal failure", () => {
    const candidate = buildGoogleAdsReleaseReadinessCandidate({
      ...healthyGoogleState,
      freshness: unknownGoogleAdsFreshnessEvidence("statement timeout"),
    });

    expect(candidate?.pass).toBe(false);
    expect(candidate?.evidence.freshnessEvidenceAvailable).toBe(false);
    expect(candidate?.evidence.freshnessUnavailableReason).toBe("statement timeout");
    // Retryable, not terminal, and never a misconfiguration.
    expect(candidate?.evidence.freshnessRetryable).toBe(true);
    expect(candidate?.blockerClass).toBe("not_release_ready");
    expect(candidate?.blockerClass).not.toBe("misconfigured");
  });

  it("builds a pass candidate for a converging state without claiming completion", () => {
    const candidate = buildGoogleAdsReleaseReadinessCandidate({
      ...healthyGoogleState,
      freshness: evidence("converging"),
    });

    expect(candidate).toMatchObject({
      pass: true,
      blockerClass: "none",
      evidence: {
        truthReady: true,
        freshnessPostCloseObserved: true,
        freshnessState: "converging",
        queueDepth: 4,
        leasedPartitions: 1,
      },
    });
    // Serving-ready and settled stay separate answers.
    expect(candidate?.evidence.freshnessSettled).toBe(false);
  });

  it("treats settled as the strongest state and never labels it final", () => {
    const candidate = buildGoogleAdsReleaseReadinessCandidate({
      ...healthyGoogleState,
      freshness: evidence("settled"),
    });

    expect(candidate?.pass).toBe(true);
    expect(candidate?.evidence.freshnessSettled).toBe(true);
    expect(JSON.stringify(candidate)).not.toMatch(/\b(final|immutable)\b/i);
  });

  it("lets an independently observed incident outrank unknown freshness", () => {
    expect(
      buildGoogleAdsReleaseReadinessCandidate({
        ...healthyGoogleState,
        activityState: "blocked",
        progressState: "blocked",
        deadLetterPartitions: 3,
        freshness: unknownGoogleAdsFreshnessEvidence("statement timeout"),
      }),
    ).toMatchObject({
      pass: false,
      // The queue incident keeps naming itself; unreadable freshness must not
      // demote it to a generic "not ready".
      blockerClass: "queue_blocked",
    });
  });

  it("builds a provider-scoped google release gate record", () => {
    process.env = {
      ...originalEnv,
      SYNC_RELEASE_GATE_MODE: "block",
    };

    expect(
      buildGoogleAdsReleaseGateRecord({
        buildId: "build-1",
        environment: "production",
        canaries: [
          {
            businessId: "biz-1",
            businessName: "Google Biz",
            pass: true,
            blockerClass: null,
            evidence: {
              truthReady: true,
            },
          },
        ],
      }),
    ).toMatchObject({
      gateKind: "release_gate",
      mode: "block",
      baseResult: "pass",
      verdict: "pass",
      blockerClass: null,
      evidence: {
        providerScope: "google_ads",
        canaries: [
          {
            businessId: "biz-1",
            businessName: "Google Biz",
            pass: true,
          },
        ],
      },
    });
  });
});
