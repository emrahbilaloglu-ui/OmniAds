import { describe, expect, it } from "vitest";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import { cardForDecision, deriveWatchingSubBucket } from "./card-serialization";

function decision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: "Creative 1",
    label: "keep",
    preAuthorityLabel:
      overrides.preAuthorityLabel ?? overrides.label ?? "keep",
    authorityBlocker: overrides.authorityBlocker ?? null,
    reason: "Hold.",
    confidence: 65,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.5,
    ratioToTarget: 1,
    badges: [],
    blockers: [],
    metrics: {
      spend: 100,
      purchases: 1,
      roas: 2.5,
      recent7dRoas: 2.5,
    },
    engineVersion: "test-engine",
    generatedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("card serialization", () => {
  it("serializes authority provenance and never turns a blocked hard verdict into a hard CTA", () => {
    const card = cardForDecision({
      decision: decision({
        label: "scale",
        preAuthorityLabel: "scale",
        authorityBlocker: "source_freshness",
        blockedActionType: "scale",
      }),
    });

    expect(card).toMatchObject({
      label: "scale",
      preAuthorityLabel: "scale",
      authorityBlocker: "source_freshness",
      primary: { kind: "review", label: "Refresh evidence" },
    });
  });

  it("derives watching sub-buckets server-side from decision evidence", () => {
    expect(
      deriveWatchingSubBucket(
        decision({
          campaignLabelStatus: "unlabeled",
          blockedActionType: "cut",
        }),
      ),
    ).toBe("waiting_on_labels");
    expect(
      deriveWatchingSubBucket(
        decision({
          campaignLabelStatus: "no_campaign",
          blockedActionType: "scale",
        }),
      ),
    ).toBe("waiting_on_labels");
    expect(
      deriveWatchingSubBucket(
        decision({
          label: "keep",
          blockedActionType: "scale",
          badges: [
            {
              type: "scale_readiness_blocked",
              label: "Scale readiness blocked",
              severity: "info",
            },
          ],
        }),
      ),
    ).toBe("near_action");
    expect(
      deriveWatchingSubBucket(
        decision({
          label: "diagnose",
          badges: [
            {
              type: "tracking_anomaly",
              label: "Tracking anomaly",
              severity: "warning",
            },
          ],
        }),
      ),
    ).toBe("diagnostic");
    expect(deriveWatchingSubBucket(decision({ label: "test_more" }))).toBe(
      "test_maturing",
    );
    expect(deriveWatchingSubBucket(decision())).toBeNull();
  });

  it("keeps no-campaign stop-loss reviews visible as review actions", () => {
    const card = cardForDecision({
      decision: decision({
        label: "diagnose",
        campaignLabelStatus: "no_campaign",
        blockedActionType: "cut",
      }),
    });

    expect(card.primary).toEqual({ kind: "review", label: "Cut review" });
    expect(card.watchingSubBucket).toBe("waiting_on_labels");
  });

  it("adds server-side near-miss prose and threshold provenance", () => {
    const card = cardForDecision({
      decision: decision({
        blockedActionType: "scale",
        blockers: [
          {
            predicate: "scale_purchase_depth",
            observed: 2,
            threshold: 5,
            status: "failed",
            severity: "warning",
            reason: "purchase floor",
          },
          {
            predicate: "scale_recent_hold",
            observed: 1.8,
            threshold: 2.5,
            status: "failed",
            severity: "warning",
            reason: "recent hold",
          },
          {
            predicate: "scale_account_benchmark_ready",
            observed: null,
            threshold: null,
            status: "missing",
            severity: "warning",
            reason: "thin calibration",
          },
          {
            predicate: "scale_spend_depth",
            observed: 10,
            threshold: 50,
            status: "failed",
            severity: "warning",
            reason: "spend floor",
          },
        ],
      }),
      accountProfile: {
        accountBaselines: {
          computedAt: "2026-05-25T06:00:00.000Z",
        },
        quality: {
          commercialTruthReady: true,
          calibrationReady: true,
          thresholdQuality: "ready",
          metaAovQuality: "ready",
        },
        spendUnit: 36,
        thresholds: {
          commercialMaturitySpend: 72,
          hardCutSpend: 288,
          scaleMinPurchases: 5,
        },
      } as never,
    });

    expect(card.explainability?.nearMisses).toEqual([
      "Needs 3 more purchases.",
      "Recent 7d ROAS 1.8 below target 2.5.",
      "Account scale calibration is still thin.",
    ]);
    expect(card.explainability?.thresholdProvenance).toEqual({
      calibrationComputedAt: "2026-05-25T06:00:00.000Z",
      refitDueAt: "2026-08-23T06:00:00.000Z",
      source: "operator_target",
    });
  });

  it("preserves stale commercial-target provenance for operator review", () => {
    const card = cardForDecision({
      decision: decision({ truthSource: "commercial_truth_stale" }),
    });

    expect(card.explainability?.thresholdProvenance?.source).toBe(
      "operator_target_stale",
    );
  });

  it("keeps a stale cut verdict visible but removes provider-write authority", () => {
    const card = cardForDecision({
      decision: decision({
        label: "cut",
        confidence: 65,
        badges: [
          {
            type: "stale_evidence",
            label: "Stale evidence",
            severity: "warning",
          },
        ],
        metrics: {
          spend: 620,
          purchases: 1,
          roas: 0.27,
          recent7dRoas: 0.25,
        },
      }),
    });

    expect(card.label).toBe("cut");
    expect(card.primary).toEqual({ kind: "review", label: "Refresh evidence" });
    expect(card.badges).toContain("stale_evidence");
    expect(card.priorityScore?.inputs.severityWeight).toBeGreaterThan(1);
  });

  it("serves a pending hard entry as review-only", () => {
    const card = cardForDecision({
      decision: decision({
        label: "keep",
        blockedActionType: "scale",
        badges: [
          {
            type: "pending_transition",
            label: "Pending hard action",
            severity: "info",
          },
        ],
      }),
    });

    expect(card.primary).toEqual({
      kind: "review",
      label: "Review pending signal",
    });
  });

  it("dual-writes decisionCenterRow and maps adapter scale execution to the legacy CTA field", () => {
    const decisionCenterRow = {
      buyerAction: "scale",
      buyerLabel: "Scale - Promote to main",
      executionAction: "promote_to_main",
    };
    const card = cardForDecision({
      decision: decision({
        label: "scale",
        campaignKind: "main",
        confidence: 90,
      }),
      decisionCenterRow: decisionCenterRow as never,
    });

    expect(card.decisionCenterRow).toBe(decisionCenterRow);
    expect(card.primary).toEqual({ kind: "promote", label: "Promote to main" });
  });

  it("serializes the shared server-owned creative assessment vocabulary", () => {
    const card = cardForDecision({
      decision: decision({
        label: "scale",
        truthSource: "commercial_truth",
      }),
    });

    expect(card.assessment).toEqual({
      value: "proven_winner",
      label: "Proven winner",
      tone: "pos",
      blockerCode: null,
      vocabularyVersion: "meta-decisions-classification-overlay.v3",
    });
  });
});

describe("card currency", () => {
  it("carries the account currency so cross-business surfaces do not assume USD", () => {
    const card = cardForDecision({
      decision: decision(),
      currency: "TRY",
    });
    expect(card.currency).toBe("TRY");
    const unknown = cardForDecision({ decision: decision() });
    expect(unknown.currency).toBeNull();
  });
});
