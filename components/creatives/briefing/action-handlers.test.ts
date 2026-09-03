import { describe, expect, it, vi } from "vitest";
import {
  buildBriefingDecisionOriginAdActionRequest,
  buildCutSuccessToast,
  buildLaunchpadOpenToast,
  buildMetaAdsManagerUrlForBriefingCard,
  executeDecisionOriginAdActionWithPreflight,
  getBriefingAdActionInputId,
  getCreativeScopeId,
  hasNativeDecisionOriginLineage,
  isCutPrimaryAction,
  metaAdActionFailureMessage,
  pauseBriefingCard,
  type DecisionOriginBriefingCard,
} from "@/components/creatives/briefing/action-handlers";
import type { DecisionOriginAdExecutionEvidence } from "@/lib/creative-decision-engine/execution-safety";

const DECISION_HASH = "a".repeat(64);
const INPUT_HASH = "b".repeat(64);
const ENGINE_VERSION = "v3-ad-2026-07-18-decision-presentation-hardening-shadow";

function card(
  overrides: Partial<DecisionOriginBriefingCard> = {},
): DecisionOriginBriefingCard {
  const value: DecisionOriginBriefingCard = {
    id: "creative_synth_1",
    creativeId: "creative_1",
    realAdId: "100000000000001",
    providerAccountId: "act_123",
    name: "Cut Candidate",
    accountId: "act_123",
    label: "cut",
    primary: { kind: "cut", label: "Cut" },
    sourceDecisionSnapshotId: "snapshot_1",
    sourceDecisionAuthorityStatus: "native_exact",
    sourceDecisionEvaluationId: "evaluation_1",
    sourceDecisionSnapshotEngineVersion: ENGINE_VERSION,
    sourceDecisionInputHash: INPUT_HASH,
    sourceDecisionHash: DECISION_HASH,
    sourceDecisionProviderAccountRefId: "provider_ref_1",
    sourceDecisionJobRunId: "job_run_1",
    sourceDecisionAuthorizedAction: "cut",
    sourceDecisionActionEligible: true,
    sourceDecisionSnapshotMatch: "matched",
    authorityBlocker: null,
    blockedActionType: null,
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "canonicalDecision")) {
    const snapshotId = value.sourceDecisionSnapshotId?.trim() ?? "";
    const evaluationId = value.sourceDecisionEvaluationId?.trim() ?? "";
    const engineVersion =
      value.sourceDecisionSnapshotEngineVersion?.trim() ?? "";
    const providerAccountId = value.providerAccountId?.trim() ?? "";
    const adId = value.realAdId?.trim() ?? "";
    value.canonicalDecision = {
      contractVersion: "briefing-canonical-native-ad.v1",
      identityGrain: "ad",
      decisionId: "decision_1",
      episodeId: "episode_1",
      sourceSnapshotId: snapshotId,
      adId,
      creativeId: value.creativeId ?? null,
      identityResolution: {
        basis: "native_ad_exact",
        adActionEligible: true,
      },
      classification: {
        decisionState: "act",
        buyerAction: "cut",
        buyerLabel: "Cut",
        executionAction: null,
        heldAction: null,
      },
      sourceDecision: {
        label: "cut",
        authorityBlocker: null,
        confidence: 0.9,
        reason: "Canonical Cut",
        snapshotAsOf: "2026-07-18",
        computedAt: "2026-07-18T03:00:00.000Z",
      },
      sourceAuthority: {
        status:
          value.sourceDecisionAuthorityStatus ??
          "demo_synthetic_review_only",
        snapshotId,
        evaluationId,
        inputHash: value.sourceDecisionInputHash?.trim() ?? "",
        decisionHash: value.sourceDecisionHash?.trim() ?? "",
        engineVersion,
        providerAccountRefId:
          value.sourceDecisionProviderAccountRefId?.trim() ?? "",
        providerAccountId,
        realAdId: adId,
        jobRunId: value.sourceDecisionJobRunId?.trim() ?? "",
        authorizedAction: value.sourceDecisionAuthorizedAction ?? null,
        actionEligible: value.sourceDecisionActionEligible === true,
        reviewOnlyReason:
          value.sourceDecisionActionEligible === true ? null : "review_only",
        executionReadiness:
          value.sourceDecisionActionEligible === true
            ? "live_preflight_required"
            : "decision_not_authorized",
      },
    };
  }
  return value;
}

function evidence(
  overrides: {
    currentAdId?: string;
    sourceAdId?: string;
  } = {},
): DecisionOriginAdExecutionEvidence {
  return {
    killSwitch: { verified: true, engaged: false },
    pipeline: { verified: true, executionReady: true },
    currentAccount: {
      found: true,
      businessId: "biz_1",
      providerAccountId: "act_123",
      writable: true,
    },
    currentAd: {
      found: true,
      businessId: "biz_1",
      providerAccountId: "act_123",
      adId: overrides.currentAdId ?? "100000000000001",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: "APPROVED",
      observedAt: "2026-07-12T09:59:00.000Z",
    },
    sourceDecision: {
      found: true,
      businessId: "biz_1",
      providerAccountId: "act_123",
      decisionEntityType: "ad",
      decisionEntityId: overrides.sourceAdId ?? "100000000000001",
      adId: overrides.sourceAdId ?? "100000000000001",
      campaignId: "campaign_1",
      adsetId: "adset_1",
      creativeId: "creative_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      decisionLabel: "cut",
      blockedActionType: null,
      explicitAuthorizedAction: "pause",
      computedAt: "2026-07-12T09:30:00.000Z",
    },
    idempotencyReceipt: null,
  };
}

describe("briefing action handlers", () => {
  it("uses only the native ad id for decision-origin input", () => {
    expect(getCreativeScopeId(card())).toBe("creative_1");
    expect(getBriefingAdActionInputId(card())).toBe("100000000000001");
    expect(
      getBriefingAdActionInputId(
        card({ realAdId: null, adId: "warehouse_ad", metaAdId: "alternate" }),
      ),
    ).toBe("");
  });

  it("distinguishes native lineage from creative snapshot-only briefing cards", () => {
    expect(hasNativeDecisionOriginLineage(card())).toBe(true);
    expect(
      hasNativeDecisionOriginLineage(
        card({
          sourceDecisionEvaluationId: null,
          sourceDecisionHash: null,
        }),
      ),
    ).toBe(false);
    expect(
      hasNativeDecisionOriginLineage(
        card({ sourceDecisionEvaluationId: null }),
      ),
    ).toBe(false);
    expect(
      hasNativeDecisionOriginLineage(card({ sourceDecisionHash: null })),
    ).toBe(false);
    expect(
      hasNativeDecisionOriginLineage(
        card({ sourceDecisionSnapshotMatch: "mismatch" }),
      ),
    ).toBe(false);
    expect(
      hasNativeDecisionOriginLineage(
        card({
          sourceDecisionAuthorityStatus: "demo_synthetic_review_only",
        }),
      ),
    ).toBe(false);
  });

  it("keeps exact-enum Cut display behavior without parsing review copy", () => {
    expect(isCutPrimaryAction(card())).toBe(true);
    expect(
      isCutPrimaryAction(card({ primary: { kind: "pause_ad", label: "Pause ad" } })),
    ).toBe(true);
    expect(
      isCutPrimaryAction(card({ label: "scale", primary: { kind: "review", label: "Pause ad" } })),
    ).toBe(false);
    expect(
      isCutPrimaryAction(card({ primary: { kind: "demote", label: "Demote to test" } })),
    ).toBe(false);
  });

  it("builds the exact native-ad lineage request", () => {
    const request = buildBriefingDecisionOriginAdActionRequest({
      businessId: "biz_1",
      card: card(),
      action: "pause",
    });

    expect(request).toEqual({
      contractVersion: "meta-decision-origin-ad-execution.v1",
      businessId: "biz_1",
      providerAccountId: "act_123",
      adId: "100000000000001",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      action: "pause",
      idempotencyKey: expect.stringMatching(
        /^decision-ad-action:biz_1:act_123:100000000000001:pause:/,
      ),
      creativeId: "creative_1",
    });
  });

  it("rejects a caller-selected native decision idempotency key", () => {
    expect(() =>
      buildBriefingDecisionOriginAdActionRequest({
        businessId: "biz_1",
        card: card(),
        action: "pause",
        idempotencyKey: "alternate-attempt-key",
      }),
    ).toThrow(/idempotency_key_mismatch/);
  });

  it("same creative on two ads cannot cross-target", async () => {
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        adId: url.includes("100000000000002")
          ? "100000000000002"
          : "100000000000001",
        status: "PAUSED",
      }),
    })) as unknown as typeof fetch;

    await pauseBriefingCard({
      businessId: "biz_1",
      card: card({
        realAdId: "100000000000001",
        creativeId: "shared_creative",
      }),
      fetchImpl,
    });
    await pauseBriefingCard({
      businessId: "biz_1",
      card: card({
        realAdId: "100000000000002",
        creativeId: "shared_creative",
      }),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/meta/ads/100000000000001/pause",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/meta/ads/100000000000002/pause",
      expect.objectContaining({ method: "POST" }),
    );
    const firstBody = JSON.parse(
      String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit)?.body),
    );
    const secondBody = JSON.parse(
      String((vi.mocked(fetchImpl).mock.calls[1]?.[1] as RequestInit)?.body),
    );
    expect(firstBody).toMatchObject({
      adId: "100000000000001",
      creativeId: "shared_creative",
    });
    expect(secondBody).toMatchObject({
      adId: "100000000000002",
      creativeId: "shared_creative",
    });
    expect(firstBody.actionOrigin).toBe("native_decision_v1");
    expect(secondBody.actionOrigin).toBe("native_decision_v1");
  });

  it("does not try an alternate id after an exact-ad rejection", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({
        ok: false,
        error: { code: "ad_not_found", message: "Exact ad was not found." },
      }),
    })) as unknown as typeof fetch;

    await expect(
      pauseBriefingCard({ businessId: "biz_1", card: card(), fetchImpl }),
    ).rejects.toThrow("Exact ad was not found.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/meta/ads/100000000000001/pause",
      expect.any(Object),
    );
  });

  it.each([
    ["snapshot", { sourceDecisionSnapshotId: null }],
    ["matched snapshot proof", { sourceDecisionSnapshotMatch: "mismatch" as const }],
    ["evaluation", { sourceDecisionEvaluationId: null }],
    ["decision hash", { sourceDecisionHash: null }],
    ["provider account", { providerAccountId: null }],
    ["native ad", { realAdId: null }],
  ])("rejects missing %s before calling the route", async (_name, override) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      pauseBriefingCard({
        businessId: "biz_1",
        card: card(override),
        fetchImpl,
      }),
    ).rejects.toThrow("exact native eligible authorized Cut");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects lineage-free briefing cards instead of falling back to manual execution", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      pauseBriefingCard({
        businessId: "biz_1",
        card: card({
          sourceDecisionEvaluationId: null,
          sourceDecisionHash: null,
        }),
        fetchImpl,
      }),
    ).rejects.toThrow("exact native eligible authorized Cut");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a synthetic demo decision before any provider route call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      pauseBriefingCard({
        businessId: "biz_1",
        card: card({
          sourceDecisionAuthorityStatus: "demo_synthetic_review_only",
        }),
        fetchImpl,
      }),
    ).rejects.toThrow("native eligible authorized Cut");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["action-ineligible", (candidate: DecisionOriginBriefingCard) => {
      candidate.sourceDecisionActionEligible = false;
      candidate.canonicalDecision!.sourceAuthority.actionEligible = false;
      candidate.canonicalDecision!.sourceAuthority.authorizedAction = null;
      candidate.canonicalDecision!.sourceAuthority.reviewOnlyReason = "review_only";
    }],
    ["held", (candidate: DecisionOriginBriefingCard) => {
      candidate.blockedActionType = "cut";
      candidate.canonicalDecision!.classification.decisionState = "blocked";
      candidate.canonicalDecision!.classification.heldAction = "cut";
      candidate.canonicalDecision!.classification.buyerAction = null;
      candidate.canonicalDecision!.sourceAuthority.actionEligible = false;
      candidate.canonicalDecision!.sourceAuthority.authorizedAction = null;
      candidate.canonicalDecision!.sourceAuthority.reviewOnlyReason = "held";
      candidate.sourceDecisionActionEligible = false;
      candidate.sourceDecisionAuthorizedAction = null;
    }],
    ["source-blocked", (candidate: DecisionOriginBriefingCard) => {
      candidate.authorityBlocker = "campaign_context";
      candidate.canonicalDecision!.sourceDecision.authorityBlocker =
        "campaign_context";
    }],
    ["missing flattened authority proof", (candidate: DecisionOriginBriefingCard) => {
      candidate.authorityBlocker = undefined;
    }],
    ["missing flattened hold proof", (candidate: DecisionOriginBriefingCard) => {
      candidate.blockedActionType = undefined;
    }],
    ["identity-ineligible", (candidate: DecisionOriginBriefingCard) => {
      candidate.canonicalDecision!.identityResolution.adActionEligible = false;
    }],
    ["missing creative identity", (candidate: DecisionOriginBriefingCard) => {
      candidate.creativeId = null;
      candidate.canonicalDecision!.creativeId = null;
    }],
    ["snapshot-mismatch", (candidate: DecisionOriginBriefingCard) => {
      candidate.canonicalDecision!.sourceSnapshotId = "other_snapshot";
    }],
    ["authorized-action-mismatch", (candidate: DecisionOriginBriefingCard) => {
      candidate.sourceDecisionAuthorizedAction = "scale";
      candidate.canonicalDecision!.sourceAuthority.authorizedAction = "scale";
    }],
  ])(
    "rejects a %s canonical Cut tuple before any provider request",
    async (_name, mutate) => {
      const candidate = card();
      mutate(candidate);
      const fetchImpl = vi.fn() as unknown as typeof fetch;

      await expect(
        pauseBriefingCard({
          businessId: "biz_1",
          card: candidate,
          fetchImpl,
        }),
      ).rejects.toThrow("exact native eligible authorized Cut");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects resume because the briefing builder owns only canonical Cut pause", () => {
    expect(() =>
      buildBriefingDecisionOriginAdActionRequest({
        businessId: "biz_1",
        card: card(),
        action: "resume",
      }),
    ).toThrow("native_exact_eligible_authorized_cut_required");
  });

  it("never turns a lineage-free dry run into a live legacy write", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      pauseBriefingCard({
        businessId: "biz_1",
        card: card({
          sourceDecisionEvaluationId: null,
          sourceDecisionHash: null,
        }),
        dryRun: true,
        fetchImpl,
      }),
    ).rejects.toThrow("exact native eligible authorized Cut");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs exact preflight before the provider mutation", async () => {
    const request = buildBriefingDecisionOriginAdActionRequest({
      businessId: "biz_1",
      card: card(),
      action: "pause",
    });
    const mutateProvider = vi.fn(async () => ({ ok: true }));

    const result = await executeDecisionOriginAdActionWithPreflight({
      request,
      rereadEvidence: async () =>
        evidence({
          currentAdId: "100000000000002",
          sourceAdId: "100000000000002",
        }),
      mutateProvider,
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.preflight.disposition).toBe("reject");
    expect(result.preflight.blockers).toEqual(
      expect.arrayContaining([
        "ad_identity_mismatch",
        "source_decision_lineage_mismatch",
      ]),
    );
    expect(mutateProvider).not.toHaveBeenCalled();
  });

  it("refuses to POST when the server card exposes review instead of cut authority", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const reviewCard = card({
      primary: { kind: "review", label: "Refresh evidence" },
      sourceDecisionActionEligible: false,
      sourceDecisionAuthorizedAction: null,
    });
    reviewCard.canonicalDecision!.sourceAuthority.actionEligible = false;
    reviewCard.canonicalDecision!.sourceAuthority.authorizedAction = null;
    reviewCard.canonicalDecision!.sourceAuthority.reviewOnlyReason =
      "review_only";
    await expect(
      pauseBriefingCard({
        businessId: "biz_1",
        card: reviewCard,
        fetchImpl,
      }),
    ).rejects.toThrow("exact native eligible authorized Cut");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds the existing Meta Ads Manager link for cut toasts", () => {
    expect(buildMetaAdsManagerUrlForBriefingCard(card(), "1200")).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=1200",
    );
    expect(buildCutSuccessToast(card(), { ok: true, adId: "1200" })).toEqual({
      type: "success",
      message: "Cut applied · Cut Candidate",
      link: {
        href: "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=123&selected_ad_ids=1200",
        label: "Open in Meta",
      },
    });
  });

  it("does not present cut dry-runs as applied writes", () => {
    expect(buildCutSuccessToast(card(), { ok: true, adId: "1200", dryRun: true })).toEqual({
      type: "info",
      message: "Dry run completed · Cut Candidate",
      link: null,
    });
  });

  it("surfaces kill-switch failures with operator-specific copy", () => {
    expect(
      metaAdActionFailureMessage(
        {
          error: {
            code: "kill_switch_engaged",
            message: "Meta writes are disabled by kill switch.",
          },
        },
        503,
      ),
    ).toBe("Meta writes are temporarily disabled (kill switch). Try again later.");
  });

  it("can build the optional Launchpad-open toast copy", () => {
    expect(buildLaunchpadOpenToast("fresh_test")).toEqual({
      type: "info",
      message: "Launchpad bridge opened · fresh test",
    });
  });
});
