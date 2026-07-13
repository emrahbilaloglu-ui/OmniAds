import { describe, expect, it, vi } from "vitest";
import {
  buildBriefingDecisionOriginAdActionRequest,
  buildCutSuccessToast,
  buildLaunchpadOpenToast,
  buildMetaAdsManagerUrlForBriefingCard,
  executeDecisionOriginAdActionWithPreflight,
  getBriefingAdActionInputId,
  getCreativeScopeId,
  getManualBriefingAdActionCandidateIds,
  isCutPrimaryAction,
  metaAdActionFailureMessage,
  pauseBriefingCard,
  pauseBriefingCardManualLegacy,
  type DecisionOriginBriefingCard,
} from "@/components/creatives/briefing/action-handlers";
import type { DecisionOriginAdExecutionEvidence } from "@/lib/creative-decision-engine/execution-safety";

const DECISION_HASH = "a".repeat(64);

function card(
  overrides: Partial<DecisionOriginBriefingCard> = {},
): DecisionOriginBriefingCard {
  return {
    id: "creative_synth_1",
    creativeId: "creative_1",
    realAdId: "ad_1",
    providerAccountId: "act_123",
    name: "Cut Candidate",
    accountId: "act_123",
    label: "cut",
    primary: { kind: "cut", label: "Cut" },
    sourceDecisionSnapshotId: "snapshot_1",
    sourceDecisionEvaluationId: "evaluation_1",
    sourceDecisionSnapshotEngineVersion:
      "v3-ad-2026-07-12-native-provenance-shadow",
    sourceDecisionHash: DECISION_HASH,
    sourceDecisionSnapshotMatch: "matched",
    ...overrides,
  };
}

function evidence(
  overrides: {
    currentAdId?: string;
    sourceAdId?: string;
  } = {},
): DecisionOriginAdExecutionEvidence {
  return {
    killSwitch: { verified: true, engaged: false },
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
      adId: overrides.currentAdId ?? "ad_1",
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
      decisionEntityId: overrides.sourceAdId ?? "ad_1",
      adId: overrides.sourceAdId ?? "ad_1",
      creativeId: "creative_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
    engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
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
    expect(getBriefingAdActionInputId(card())).toBe("ad_1");
    expect(
      getBriefingAdActionInputId(
        card({ realAdId: null, adId: "warehouse_ad", metaAdId: "alternate" }),
      ),
    ).toBe("");
    expect(
      getManualBriefingAdActionCandidateIds(
        card({
          realAdId: "1200",
          metaAdId: "1200",
          effectiveAdId: "1201",
          adId: "row_ad",
        }),
      ),
    ).toEqual(["1200", "1201", "row_ad", "creative_1", "creative_synth_1"]);
  });

  it("keeps server-owned cut classification behavior", () => {
    expect(isCutPrimaryAction(card())).toBe(true);
    expect(
      isCutPrimaryAction(card({ primary: { kind: "pause_ad", label: "Pause ad" } })),
    ).toBe(true);
    expect(
      isCutPrimaryAction(card({ label: "scale", primary: { kind: "review", label: "Pause ad" } })),
    ).toBe(true);
    expect(
      isCutPrimaryAction(card({ primary: { kind: "demote", label: "Demote to test" } })),
    ).toBe(false);
  });

  it("builds the exact native-ad lineage request", () => {
    const request = buildBriefingDecisionOriginAdActionRequest({
      businessId: "biz_1",
      card: card(),
      action: "pause",
      idempotencyKey: "decision-action-1",
    });

    expect(request).toEqual({
      contractVersion: "meta-decision-origin-ad-execution.v1",
      businessId: "biz_1",
      providerAccountId: "act_123",
      adId: "ad_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
      decisionHash: DECISION_HASH,
      action: "pause",
      idempotencyKey: "decision-action-1",
      creativeId: "creative_1",
    });
  });

  it("same creative on two ads cannot cross-target", async () => {
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        adId: url.includes("ad_2") ? "ad_2" : "ad_1",
        status: "PAUSED",
      }),
    })) as unknown as typeof fetch;

    await pauseBriefingCard({
      businessId: "biz_1",
      card: card({ realAdId: "ad_1", creativeId: "shared_creative" }),
      fetchImpl,
    });
    await pauseBriefingCard({
      businessId: "biz_1",
      card: card({ realAdId: "ad_2", creativeId: "shared_creative" }),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/meta/ads/ad_1/pause",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/meta/ads/ad_2/pause",
      expect.objectContaining({ method: "POST" }),
    );
    const firstBody = JSON.parse(
      String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit)?.body),
    );
    const secondBody = JSON.parse(
      String((vi.mocked(fetchImpl).mock.calls[1]?.[1] as RequestInit)?.body),
    );
    expect(firstBody).toMatchObject({ adId: "ad_1", creativeId: "shared_creative" });
    expect(secondBody).toMatchObject({ adId: "ad_2", creativeId: "shared_creative" });
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
      "/api/meta/ads/ad_1/pause",
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
    ).rejects.toThrow("Decision-origin ad execution blocked");
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
        evidence({ currentAdId: "ad_2", sourceAdId: "ad_2" }),
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

  it("retains candidate fallback only in the explicit manual legacy handler", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: "ad_not_found", message: "Not found." } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, adId: "alternate_ad", status: "PAUSED" }),
      }) as unknown as typeof fetch;

    const result = await pauseBriefingCardManualLegacy({
      businessId: "biz_1",
      card: card({ realAdId: "stale_ad", metaAdId: "alternate_ad" }),
      fetchImpl,
    });

    expect(result.attemptedIds).toEqual(["stale_ad", "alternate_ad"]);
    const firstBody = JSON.parse(
      String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit)?.body),
    );
    expect(firstBody).toMatchObject({
      businessId: "biz_1",
      resolutionMode: "manual_legacy",
      recIdOrigin: "creative_1",
    });
  });

  it("refuses to POST when the server card exposes review instead of cut authority", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      pauseBriefingCard({
        businessId: "biz_1",
        card: card({ primary: { kind: "review", label: "Refresh evidence" } }),
        fetchImpl,
      }),
    ).rejects.toThrow("server-authorized cut action");
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
