import { describe, expect, it } from "vitest";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import { cardForDecision, deriveWatchingSubBucket } from "./card-serialization";

function decision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    campaignRoleStatus: "resolved",
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

  it.each([
    {
      name: "missing recent evidence",
      badges: [
        {
          type: "missing_recent_data" as const,
          label: "Recent break-even evidence unavailable",
          severity: "warning" as const,
        },
      ],
      label: "Refresh recent evidence",
    },
    {
      name: "thin recent evidence",
      badges: [],
      label: "Await recent evidence",
    },
  ])("serves a D063 held Cut as $label for $name", ({ badges, label }) => {
    const card = cardForDecision({
      decision: decision({
        label: "test_more",
        preAuthorityLabel: "cut",
        authorityBlocker: "recent_recovery_unverifiable",
        blockedActionType: "cut",
        badges,
      }),
    });

    expect(card.primary).toEqual({ kind: "review", label });
    expect(card.primary).not.toEqual({
      kind: "fresh_test",
      label: "Launch new test",
    });
  });

  it("derives watching sub-buckets server-side from decision evidence", () => {
    expect(
      deriveWatchingSubBucket(
        decision({
          campaignRoleStatus: "unresolved",
          blockedActionType: "cut",
        }),
      ),
    ).toBe("waiting_on_role_resolution");
    expect(
      deriveWatchingSubBucket(
        decision({
          campaignRoleStatus: "no_campaign",
          blockedActionType: "scale",
        }),
      ),
    ).toBe("waiting_on_role_resolution");
    // D074b correction: a decision that reaches serialization with NO status
    // (guard skipped) fails closed into the role-resolution bucket, and a
    // legacy-only "labeled" stamp does the same.
    expect(
      deriveWatchingSubBucket(
        decision({
          campaignRoleStatus: undefined,
          blockedActionType: "scale",
        }),
      ),
    ).toBe("waiting_on_role_resolution");
    expect(
      deriveWatchingSubBucket(
        decision({
          campaignRoleStatus: undefined,
          campaignLabelStatus: "labeled",
          blockedActionType: "scale",
        }),
      ),
    ).toBe("waiting_on_role_resolution");
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
        campaignRoleStatus: "no_campaign",
        blockedActionType: "cut",
      }),
    });

    expect(card.primary).toEqual({ kind: "review", label: "Cut review" });
    expect(card.watchingSubBucket).toBe("waiting_on_role_resolution");
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

  it("uses the card account currency in spend near-miss prose", () => {
    const card = cardForDecision({
      decision: decision({
        blockedActionType: "scale",
        blockers: [
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
      currency: "GBP",
    });

    expect(card.explainability?.nearMisses).toEqual([
      "Needs £40.00 more spend at current ROAS.",
    ]);
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

  it("never serves a kind-conditional scale CTA without canonical resolved role status (D074b correction)", () => {
    // Pre-correction a bare campaignKind alone drove the Promote CTA.
    const missing = cardForDecision({
      decision: decision({
        label: "scale",
        campaignKind: "test",
        campaignRoleStatus: undefined,
        confidence: 90,
      }),
    });
    expect(missing.primary).toEqual({
      kind: "review",
      label: "Resolve campaign role before scaling",
    });
    expect(missing.campaignKind).toBeNull();
    expect(missing.campaignRoleStatus).toBe("unresolved");

    const legacyOnly = cardForDecision({
      decision: decision({
        label: "scale",
        campaignKind: "test",
        campaignRoleStatus: undefined,
        campaignLabelStatus: "labeled",
        confidence: 90,
      }),
    });
    expect(legacyOnly.primary).toEqual({
      kind: "review",
      label: "Resolve campaign role before scaling",
    });
    expect(legacyOnly.campaignKind).toBeNull();
    expect(legacyOnly.campaignRoleStatus).toBe("unresolved");

    const contradictory = cardForDecision({
      decision: decision({
        label: "scale",
        campaignKind: "test",
        campaignRoleStatus: "resolved",
        campaignLabelStatus: "unlabeled",
        confidence: 90,
      }),
    });
    expect(contradictory.primary).toEqual({
      kind: "review",
      label: "Resolve campaign role before scaling",
    });
    expect(contradictory.campaignRoleStatus).toBe("unresolved");

    const resolved = cardForDecision({
      decision: decision({ label: "scale", campaignKind: "test", confidence: 90 }),
    });
    expect(resolved.primary).toEqual({
      kind: "promote",
      label: "Promote to main",
    });
    expect(resolved.campaignKind).toBe("test");
    expect(resolved.campaignRoleStatus).toBe("resolved");
  });

  it("dual-writes decisionCenterRow as provenance but never trusts a kind-mismatched row (D074b correction 2)", () => {
    // Pre-correction this exact input served { kind: "promote" }: the row's
    // promote_to_main outranked the decision's resolved MAIN kind. The row
    // is retained verbatim as provenance while the primary comes from the
    // decision's own resolved kind.
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
    expect(card.primary).toEqual({ kind: "scale_budget", label: "Scale budget" });
  });

  it("a stale Decision Center row cannot bypass role authority at serialization (D074b correction 2)", () => {
    const staleRow = (executionAction: string) =>
      ({
        buyerAction: "scale",
        buyerLabel: "Scale - Promote to main",
        executionAction,
      }) as never;
    // The exact rejected acceptance probe: missing canonical status +
    // legacy-only "labeled" + bare kind + stale promote row previously
    // served { kind: "promote", label: "Promote to main" }.
    const probeShapes: Array<{
      name: string;
      overrides: Partial<DecisionOutput>;
      expectedStatus: "unresolved" | "no_campaign";
    }> = [
      {
        name: "missing status",
        overrides: { campaignRoleStatus: undefined },
        expectedStatus: "unresolved",
      },
      {
        name: "legacy-only labeled",
        overrides: {
          campaignRoleStatus: undefined,
          campaignLabelStatus: "labeled",
        },
        expectedStatus: "unresolved",
      },
      {
        name: "canonical/legacy contradiction",
        overrides: {
          campaignRoleStatus: "resolved",
          campaignLabelStatus: "unlabeled",
        },
        expectedStatus: "unresolved",
      },
      {
        name: "no campaign",
        overrides: { campaignRoleStatus: "no_campaign" },
        expectedStatus: "no_campaign",
      },
    ];
    for (const shape of probeShapes) {
      const card = cardForDecision({
        decision: decision({
          label: "scale",
          campaignKind: "test",
          confidence: 90,
          ...shape.overrides,
        }),
        decisionCenterRow: staleRow("promote_to_main"),
      });
      expect(card.primary, shape.name).toEqual({
        kind: "review",
        label: "Resolve campaign role before scaling",
      });
      expect(card.campaignKind, shape.name).toBeNull();
      expect(card.campaignRoleStatus, shape.name).toBe(shape.expectedStatus);
    }
    // Not a one-string patch: the other two stale scale mappings fail
    // closed the same way on a missing status.
    for (const action of ["scale_budget", "controlled_scale"]) {
      const card = cardForDecision({
        decision: decision({
          label: "scale",
          campaignKind: "main",
          confidence: 90,
          campaignRoleStatus: undefined,
        }),
        decisionCenterRow: staleRow(action),
      });
      expect(card.primary, action).toEqual({
        kind: "review",
        label: "Resolve campaign role before scaling",
      });
    }
    // Positive: canonical resolved + kind-agreeing rows keep their CTA.
    const agreeing: Array<[string, string, { kind: string; label: string }]> = [
      ["test", "promote_to_main", { kind: "promote", label: "Promote to main" }],
      ["main", "scale_budget", { kind: "scale_budget", label: "Scale budget" }],
      [
        "mixed",
        "controlled_scale",
        { kind: "controlled_scale", label: "Review structure & scale" },
      ],
    ];
    for (const [kind, action, expected] of agreeing) {
      const card = cardForDecision({
        decision: decision({
          label: "scale",
          campaignKind: kind as never,
          confidence: 90,
        }),
        decisionCenterRow: staleRow(action),
      });
      expect(card.primary, `${kind}/${action}`).toEqual(expected);
    }
    // Mismatched resolved kind/action pairs trust the decision, not the row.
    const mismatched = cardForDecision({
      decision: decision({ label: "scale", campaignKind: "test", confidence: 90 }),
      decisionCenterRow: staleRow("scale_budget"),
    });
    expect(mismatched.primary).toEqual({
      kind: "promote",
      label: "Promote to main",
    });
  });

  it("a stale Scale row never overrides the current decision label (D074b correction 3)", () => {
    // The exact rejected probe A: canonical resolved Test role + stale
    // promote row. Correction-2 code served { kind: "promote" } for EVERY
    // one of these current decisions, erasing Cut included.
    const staleRow = {
      buyerAction: "scale",
      buyerLabel: "Scale - Promote to main",
      executionAction: "promote_to_main",
    } as never;
    const cases: Array<[string, { kind: string; label: string }]> = [
      ["keep", { kind: "review", label: "Review" }],
      ["diagnose", { kind: "review", label: "Open evidence" }],
      ["cut", { kind: "cut", label: "Cut" }],
      ["refresh", { kind: "fresh_test", label: "Launch fresh test" }],
      ["test_more", { kind: "fresh_test", label: "Launch new test" }],
    ];
    for (const [label, expected] of cases) {
      const card = cardForDecision({
        decision: decision({
          label: label as never,
          campaignKind: "test",
          confidence: 90,
        }),
        decisionCenterRow: staleRow,
      });
      expect(card.primary, label).toEqual(expected);
      expect(card.primary?.kind, label).not.toBe("promote");
    }
  });

  it("a blocked current Scale keeps its review primary against a stale row (D074b correction 3)", () => {
    const staleRow = {
      buyerAction: "scale",
      buyerLabel: "Scale - Promote to main",
      executionAction: "promote_to_main",
    } as never;
    const badge = (type: string) =>
      ({ type, label: type, severity: "warning" }) as never;
    // Probe B server side: source-freshness authority block.
    const sourceFreshness = cardForDecision({
      decision: decision({
        label: "scale",
        campaignKind: "test",
        confidence: 90,
        authorityBlocker: "source_freshness" as never,
        blockedActionType: "scale",
        badges: [badge("stale_evidence")],
      }),
      decisionCenterRow: staleRow,
    });
    expect(sourceFreshness.primary).toEqual({
      kind: "review",
      label: "Refresh evidence",
    });
    // Pending/held signal.
    const pending = cardForDecision({
      decision: decision({
        label: "scale",
        campaignKind: "test",
        confidence: 90,
        badges: [badge("pending_transition")],
      }),
      decisionCenterRow: staleRow,
    });
    expect(pending.primary).toEqual({
      kind: "review",
      label: "Review pending signal",
    });
    // Campaign-context authority block (guarded diagnose with held scale).
    const contextBlocked = cardForDecision({
      decision: decision({
        label: "diagnose",
        campaignKind: null,
        campaignRoleStatus: "unresolved",
        confidence: 40,
        authorityBlocker: "campaign_context" as never,
        blockedActionType: "scale",
      }),
      decisionCenterRow: staleRow,
    });
    expect(contextBlocked.primary?.kind).toBe("review");
    expect(contextBlocked.primary?.label).not.toBe("Promote to main");
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
      vocabularyVersion: "meta-decisions-classification-overlay.v4",
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
