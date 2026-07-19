import { describe, expect, it, vi } from "vitest";
import {
  hasNativeDecisionOriginLineage,
  isCutPrimaryAction,
  pauseBriefingCard,
} from "@/components/creatives/briefing/action-handlers";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { projectCanonicalNativeAdDecisionToBriefing } from "./canonical-projection";

function heldCutDecision(input: {
  badges?: string[];
  rawLabel?: string;
  inputHash?: string;
  label?: string;
  authorityBlocker?: "campaign_context" | "recent_recovery_unverifiable";
  resolutionCode?: string;
} = {}): MetaCanonicalDecision {
  return {
    decisionId: "decision_ad_held_cut",
    episodeId: "episode_ad_held_cut",
    episodeStartedAt: "2026-07-16T03:00:00.000Z",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceSnapshotId: "snapshot_ad_held_cut",
    sourceAuthority: {
      status: "native_exact",
      actionEligible: false,
      reviewOnlyReason: "campaign_context",
      snapshotId: "snapshot_ad_held_cut",
      evaluationId: "evaluation_ad_held_cut",
      inputHash: input.inputHash ?? "1".repeat(64),
      decisionHash: "2".repeat(64),
      providerAccountRefId: "provider-ref-1",
      engineVersion: "native-ad-engine.v1",
      realAdId: "ad_held_cut",
      authorizedAction: null,
      jobRunId: "job-run-1",
    },
    sourceDecision: {
      label: input.label ?? "keep",
      preAuthorityLabel: "cut",
      authorityBlocker: input.authorityBlocker ?? "campaign_context",
      rawLabel: input.rawLabel ?? "cut",
      reason: "Persisted Cut is held pending campaign authority.",
      confidence: 88,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "native-ad-engine.v1",
      snapshotAsOf: "2026-07-16",
      computedAt: "2026-07-16T03:05:00.000Z",
      badges: input.badges ?? ["pending_transition"],
    },
    parentChain: {
      campaign: { id: "campaign_1", name: "Main" },
      adset: { id: "adset_1", name: "Ad set" },
      ad: { id: "ad_held_cut", name: "Held Cut ad" },
      creative: { id: "creative_shared", name: "Shared creative" },
    },
    identityResolution: {
      basis: "native_ad_exact",
      candidateAdCount: 1,
      metricsEquivalent: true,
      adActionEligible: true,
    },
    media: {
      state: "available",
      thumbnail: { url: "https://example.com/held-cut.jpg" },
    },
    deliveryScope: { state: "active", adStatus: "ACTIVE" },
    classification: {
      lifecycleRole: { value: "label_needed" },
      decisionState: "blocked",
      heldAction: "cut",
      buyerAction: null,
      buyerLabel: "Cut pending",
      executionAction: null,
      resolution: {
        code: input.resolutionCode ?? "campaign_context",
        category: "campaign_context",
        nextStep: "Confirm campaign role",
      },
      blockers: [{ code: "campaign_context", label: "Campaign role missing" }],
    },
    metrics: {
      spend: 500,
      purchases: 4,
      roas: 0.8,
      recent7dRoas: 0.7,
      effectiveTargetRoas: 2,
      ratioToTarget: 0.4,
      currency: "USD",
    },
  } as unknown as MetaCanonicalDecision;
}

function actionableCutDecision(
  deliveryScope: Partial<NonNullable<MetaCanonicalDecision["deliveryScope"]>> = {},
): MetaCanonicalDecision {
  const decision = heldCutDecision();
  decision.sourceAuthority = {
    ...decision.sourceAuthority!,
    actionEligible: true,
    reviewOnlyReason: null,
    authorizedAction: "cut",
  };
  decision.sourceDecision = {
    ...decision.sourceDecision,
    label: "cut",
    preAuthorityLabel: "cut",
    authorityBlocker: null,
    rawLabel: "cut",
    badges: [],
  };
  decision.deliveryScope = {
    state: "active",
    campaignStatus: "ACTIVE",
    adsetStatus: "ACTIVE",
    adStatus: "ACTIVE",
    reason: "active_hierarchy",
    provenance: {} as never,
    ...deliveryScope,
  };
  decision.classification = {
    ...decision.classification,
    decisionState: "act",
    heldAction: null,
    legacyBuyerAction: "cut",
    buyerAction: "cut",
    buyerLabel: "Cut",
    executionAction: null,
    resolution: null,
    blockers: [],
  };
  return decision;
}

function actionableReviewOnlyDecision(input: {
  action: "scale" | "refresh";
  executionAction:
    | "promote_to_main"
    | "scale_budget"
    | "controlled_scale"
    | null;
}): MetaCanonicalDecision {
  const decision = actionableCutDecision();
  decision.sourceAuthority = {
    ...decision.sourceAuthority!,
    authorizedAction: input.action,
  };
  decision.sourceDecision = {
    ...decision.sourceDecision,
    label: input.action,
    preAuthorityLabel: input.action,
    rawLabel: input.action,
    reason: `Canonical ${input.action} decision.`,
  };
  decision.classification = {
    ...decision.classification,
    buyerAction: input.action,
    legacyBuyerAction: input.action,
    buyerLabel: input.action === "scale" ? "Scale" : "Refresh",
    executionAction: input.executionAction,
  };
  return decision;
}

describe("projectCanonicalNativeAdDecisionToBriefing", () => {
  it("projects Act Now only for an exactly ACTIVE campaign, ad set, and ad", () => {
    const projection = projectCanonicalNativeAdDecisionToBriefing({
      decision: actionableCutDecision(),
    });

    expect(projection).toMatchObject({
      lane: "action",
      card: {
        primary: { kind: "cut", label: "Cut" },
        sourceDecisionActionEligible: true,
        canonicalDecision: {
          sourceSnapshotId: "snapshot_ad_held_cut",
          identityResolution: {
            basis: "native_ad_exact",
            adActionEligible: true,
          },
          sourceDecision: { authorityBlocker: null },
          sourceAuthority: {
            actionEligible: true,
            reviewOnlyReason: null,
          },
        },
      },
    });
    expect(isCutPrimaryAction(projection!.card)).toBe(true);
  });

  it.each([
    {
      name: "promote-to-main Scale",
      action: "scale",
      executionAction: "promote_to_main",
      primaryLabel: "Review scale evidence",
    },
    {
      name: "budget Scale",
      action: "scale",
      executionAction: "scale_budget",
      primaryLabel: "Review scale evidence",
    },
    {
      name: "controlled Scale",
      action: "scale",
      executionAction: "controlled_scale",
      primaryLabel: "Review scale evidence",
    },
    {
      name: "Refresh",
      action: "refresh",
      executionAction: null,
      primaryLabel: "Review refresh evidence",
    },
  ] as const)(
    "keeps an exact $name decision visible but review-only without a validated executor",
    ({ action, executionAction, primaryLabel }) => {
      const projection = projectCanonicalNativeAdDecisionToBriefing({
        decision: actionableReviewOnlyDecision({ action, executionAction }),
      });

      expect(projection).toMatchObject({
        lane: "watching",
        card: {
          primary: { kind: "review", label: primaryLabel },
          sourceDecisionActionEligible: true,
          sourceDecisionAuthorizedAction: action,
          canonicalDecision: {
            classification: {
              buyerAction: action,
              executionAction,
            },
            sourceAuthority: {
              actionEligible: true,
              authorizedAction: action,
            },
          },
          decisionCenterRow: {
            buyerAction: action,
            executionAction,
            engine: {
              actionability: "review_only",
              queueEligible: false,
              applyEligible: false,
            },
          },
        },
      });
      expect(isCutPrimaryAction(projection!.card)).toBe(false);
    },
  );

  it.each([
    ["campaign", { campaignStatus: "WITH_ISSUES" }],
    ["ad set", { adsetStatus: "WITH_ISSUES" }],
    ["ad", { adStatus: "WITH_ISSUES" }],
  ] as const)(
    "downgrades inconsistent actionable authority when the %s is WITH_ISSUES",
    (_level, deliveryScope) => {
      const projection = projectCanonicalNativeAdDecisionToBriefing({
        decision: actionableCutDecision(deliveryScope),
      });

      expect(projection).toMatchObject({
        lane: "watching",
        card: {
          primary: { kind: "review", label: "Open canonical evidence" },
          sourceDecisionActionEligible: false,
          sourceDecisionAuthorizedAction: null,
          canonicalDecision: {
            sourceAuthority: {
              actionEligible: false,
              authorizedAction: null,
              reviewOnlyReason: "current_hierarchy_is_not_active",
            },
          },
        },
      });
      expect(isCutPrimaryAction(projection!.card)).toBe(false);
    },
  );

  it("downgrades missing hierarchy truth to advisory-only", () => {
    const projection = projectCanonicalNativeAdDecisionToBriefing({
      decision: actionableCutDecision({
        state: "unknown",
        adStatus: null,
        reason: "hierarchy_status_unknown",
      }),
    });

    expect(projection?.card).toMatchObject({
      primary: { kind: "review" },
      sourceDecisionActionEligible: false,
      sourceDecisionAuthorizedAction: null,
      canonicalDecision: {
        sourceAuthority: {
          actionEligible: false,
          authorizedAction: null,
          reviewOnlyReason: "current_hierarchy_status_is_unknown",
        },
      },
    });
    expect(projection?.lane).toBe("watching");
  });

  it("keeps a persisted held Cut visible and review-only without inventing buyerAction", async () => {
    const projection = projectCanonicalNativeAdDecisionToBriefing({
      decision: heldCutDecision(),
    });
    expect(projection).not.toBeNull();
    const card = projection!.card;

    expect(projection).toMatchObject({
      lane: "watching",
      decisionCenterRow: null,
    });
    expect(card).toMatchObject({
      id: "ad_held_cut",
      realAdId: "ad_held_cut",
      label: "keep",
      blockedActionType: "cut",
      pendingTransition: true,
      primary: {
        kind: "review",
        label: "Cut pending — evidence review",
      },
      sourceDecisionSnapshotMatch: "matched",
      sourceDecisionActionEligible: false,
      sourceDecisionAuthorizedAction: null,
      canonicalDecision: {
        classification: {
          buyerAction: null,
          heldAction: "cut",
        },
      },
    });
    expect(hasNativeDecisionOriginLineage(card)).toBe(true);
    expect(isCutPrimaryAction(card)).toBe(false);

    const fetchImpl = vi.fn();
    await expect(
      pauseBriefingCard({
        businessId: "biz_1",
        card,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("exact native eligible authorized Cut");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing recent evidence",
      badges: ["missing_recent_data"],
      resolutionCode: "refresh_decision_data",
      primaryLabel: "Refresh recent evidence",
    },
    {
      name: "thin recent evidence",
      badges: [],
      resolutionCode: "await_recent_evidence",
      primaryLabel: "Await recent evidence",
    },
  ])(
    "projects a D063 held Cut with no pending transition for $name",
    ({ badges, resolutionCode, primaryLabel }) => {
      const projection = projectCanonicalNativeAdDecisionToBriefing({
        decision: heldCutDecision({
          badges,
          rawLabel: "test_more",
          label: "test_more",
          authorityBlocker: "recent_recovery_unverifiable",
          resolutionCode,
        }),
      });

      expect(projection?.card).toMatchObject({
        label: "test_more",
        preAuthorityLabel: "cut",
        authorityBlocker: "recent_recovery_unverifiable",
        blockedActionType: "cut",
        pendingTransition: false,
        sourceDecisionActionEligible: false,
        sourceDecisionAuthorizedAction: null,
        primary: { kind: "review", label: primaryLabel },
      });
      expect(isCutPrimaryAction(projection!.card)).toBe(false);
    },
  );

  it("sets pendingTransition only when both persisted badge and raw/published divergence exist", () => {
    const withoutBadge = projectCanonicalNativeAdDecisionToBriefing({
      decision: heldCutDecision({ badges: [] }),
    });
    const withoutDivergence = projectCanonicalNativeAdDecisionToBriefing({
      decision: heldCutDecision({ rawLabel: "keep" }),
    });

    expect(withoutBadge?.card.pendingTransition).toBe(false);
    expect(withoutDivergence?.card.pendingTransition).toBe(false);
  });

  it("rejects malformed lineage instead of degrading to a legacy projection", () => {
    expect(
      projectCanonicalNativeAdDecisionToBriefing({
        decision: heldCutDecision({ inputHash: "not-a-sha256" }),
      }),
    ).toBeNull();
  });

  it.each([
    ["non-act state", (decision: MetaCanonicalDecision) => {
      decision.classification.decisionState = "monitor";
    }],
    ["held action", (decision: MetaCanonicalDecision) => {
      decision.classification.heldAction = "cut";
    }],
    ["authority blocker", (decision: MetaCanonicalDecision) => {
      decision.sourceDecision.authorityBlocker = "campaign_context";
    }],
    ["ineligible exact-Ad identity", (decision: MetaCanonicalDecision) => {
      decision.identityResolution!.adActionEligible = false;
    }],
    ["source snapshot mismatch", (decision: MetaCanonicalDecision) => {
      decision.sourceSnapshotId = "snapshot_other";
    }],
    ["authorized action mismatch", (decision: MetaCanonicalDecision) => {
      decision.sourceAuthority!.authorizedAction = "scale";
    }],
  ])(
    "rejects an action-eligible canonical tuple with %s",
    (_name, mutate) => {
      const decision = actionableCutDecision();
      mutate(decision);
      expect(
        projectCanonicalNativeAdDecisionToBriefing({ decision }),
      ).toBeNull();
    },
  );

  it("does not treat a generic row id as exact provider Ad identity", () => {
    const projection = projectCanonicalNativeAdDecisionToBriefing({
      decision: heldCutDecision(),
      row: {
        id: "ad_held_cut",
        real_ad_id: null,
        impressions: 123,
        image_url: "https://example.com/untrusted-row-id.jpg",
      } as never,
    });

    expect(projection?.card.impressions).toBeNull();
    expect(projection?.card.imageUrl).toBeNull();
    expect(projection?.card.mediaPreviewUrl).toBe(
      "https://example.com/held-cut.jpg",
    );
  });

  it("fails closed when required persisted decision metrics are non-finite", () => {
    const decision = heldCutDecision();
    decision.metrics = { ...decision.metrics, spend: Number.NaN };

    expect(
      projectCanonicalNativeAdDecisionToBriefing({ decision }),
    ).toBeNull();
  });
});
