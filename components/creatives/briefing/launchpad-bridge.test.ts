import { describe, expect, it } from "vitest";
import {
  buildLaunchpadBridgeHref,
  buildLaunchpadOverlayItem,
  canOpenBriefingCardInLaunchpad,
  getLaunchpadBridgeCreativeIds,
  mapBriefingPrimaryToLaunchpadMode,
} from "@/components/creatives/briefing/launchpad-bridge";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Aphrodite Hook",
    brand: "TheSwaf",
    campaign: "ASC | Worldwide",
    adset: "Broad",
    label: "scale",
    primary: { kind: "promote", label: "Promote to main" },
    ...overrides,
  };
}

function canonicalScaleCard(
  overrides: Partial<BriefingCreativeCard> = {},
): BriefingCreativeCard {
  const value = card({
    id: "ad_1",
    realAdId: "ad_1",
    providerAccountId: "act_1",
    authorityBlocker: null,
    blockedActionType: null,
    sourceDecisionSnapshotId: "snapshot_1",
    sourceDecisionSnapshotMatch: "matched",
    sourceDecisionAuthorityStatus: "native_exact",
    sourceDecisionEvaluationId: "evaluation_1",
    sourceDecisionSnapshotEngineVersion: "native_engine_1",
    sourceDecisionInputHash: "1".repeat(64),
    sourceDecisionHash: "2".repeat(64),
    sourceDecisionProviderAccountRefId: "provider_ref_1",
    sourceDecisionJobRunId: "job_1",
    sourceDecisionAuthorizedAction: "scale",
    sourceDecisionActionEligible: true,
    ...overrides,
  });
  if (!Object.prototype.hasOwnProperty.call(overrides, "canonicalDecision")) {
    value.canonicalDecision = {
      contractVersion: "briefing-canonical-native-ad.v1",
      identityGrain: "ad",
      decisionId: "decision_1",
      episodeId: "episode_1",
      sourceSnapshotId: "snapshot_1",
      adId: "ad_1",
      creativeId: "creative_1",
      identityResolution: {
        basis: "native_ad_exact",
        adActionEligible: true,
      },
      classification: {
        decisionState: "act",
        buyerAction: "scale",
        buyerLabel: "Scale",
        executionAction: "promote_to_main",
        heldAction: null,
      },
      sourceDecision: {
        label: "scale",
        authorityBlocker: null,
        confidence: 0.9,
        reason: "Canonical Scale",
        snapshotAsOf: "2026-07-18",
        computedAt: "2026-07-18T03:00:00.000Z",
      },
      sourceAuthority: {
        status: "native_exact",
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
        inputHash: "1".repeat(64),
        decisionHash: "2".repeat(64),
        engineVersion: "native_engine_1",
        providerAccountRefId: "provider_ref_1",
        providerAccountId: "act_1",
        realAdId: "ad_1",
        jobRunId: "job_1",
        authorizedAction: "scale",
        actionEligible: true,
        reviewOnlyReason: null,
      },
    };
  }
  return value;
}

function canonicalRefreshCard(): BriefingCreativeCard {
  const value = canonicalScaleCard({
    label: "refresh",
    primary: { kind: "review", label: "Review refresh evidence" },
    sourceDecisionAuthorizedAction: "refresh",
  });
  value.canonicalDecision!.classification = {
    ...value.canonicalDecision!.classification,
    buyerAction: "refresh",
    buyerLabel: "Refresh",
    executionAction: null,
  };
  value.canonicalDecision!.sourceDecision = {
    ...value.canonicalDecision!.sourceDecision,
    label: "refresh",
    reason: "Canonical Refresh",
  };
  value.canonicalDecision!.sourceAuthority = {
    ...value.canonicalDecision!.sourceAuthority,
    authorizedAction: "refresh",
  };
  return value;
}

describe("launchpad briefing bridge", () => {
  it("builds the Launchpad prefill URL for supported single-card modes", () => {
    expect(buildLaunchpadBridgeHref(card(), "promote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_1&mode=promote&fromBriefing=true",
    );
    expect(buildLaunchpadBridgeHref(card({ creativeId: "creative_2" }), "demote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_2&mode=demote&fromBriefing=true",
    );
    expect(buildLaunchpadBridgeHref(card({ creativeId: "creative_3" }), "fresh_test")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_3&mode=fresh_test&fromBriefing=true",
    );
    expect(buildLaunchpadBridgeHref(card({ creativeId: "creative_4" }), "add_existing")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_4&mode=add_existing&fromBriefing=true",
    );
  });

  it("builds multi-card Launchpad prefill URLs", () => {
    expect(
      buildLaunchpadBridgeHref(
        [
          card({ creativeId: "creative_1" }),
          card({ id: "row_2", creativeId: "creative_2" }),
          card({ id: "row_3", creativeId: "creative_1" }),
        ],
        "demote",
      ),
    ).toBe("/platforms/meta/launchpad?creativeIds=creative_1,creative_2&mode=demote&fromBriefing=true");
  });

  it("uses every placement creative id for non-mixed rollups", () => {
    const rollup = card({
      id: "rollup_1",
      creativeId: "creative_primary",
      mixed: false,
      placementList: [
        { id: "placement_1", creativeId: "creative_a", label: "scale" },
        { id: "placement_2", creativeId: "creative_b", label: "scale" },
        { id: "placement_3", creativeId: "creative_a", label: "scale" },
      ],
    });

    expect(getLaunchpadBridgeCreativeIds(rollup)).toEqual(["creative_a", "creative_b"]);
    expect(buildLaunchpadBridgeHref(rollup, "promote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_a,creative_b&mode=promote&fromBriefing=true",
    );
  });

  it("falls back to the primary creative id for mixed rollups", () => {
    const rollup = card({
      id: "rollup_1",
      creativeId: "creative_primary",
      mixed: true,
      placementList: [
        { id: "placement_1", creativeId: "creative_a", label: "scale" },
        { id: "placement_2", creativeId: "creative_b", label: "cut" },
      ],
    });

    expect(getLaunchpadBridgeCreativeIds(rollup)).toEqual(["creative_primary"]);
    expect(buildLaunchpadBridgeHref(rollup, "promote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_primary&mode=promote&fromBriefing=true",
    );
  });

  it("maps primary action kinds and conservative label fallbacks", () => {
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "promote", label: "Promote" } }))).toBe("promote");
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "demote", label: "Demote" } }))).toBe("demote");
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "fresh_test", label: "Add to fresh test" } }))).toBe("fresh_test");
    expect(
      mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "scale", campaignKind: "test" })),
    ).toBe("promote");
    expect(
      mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "scale", campaignKind: "main" })),
    ).toBeNull();
    expect(
      mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "scale_budget", label: "Scale budget" }, label: "scale" })),
    ).toBeNull();
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "test_more" }))).toBe("fresh_test");
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "cut" }))).toBeNull();
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "review", label: "Review" }, label: "out_of_scope" }))).toBeNull();
  });

  it("never turns held or review-only Cut decisions into fresh tests", () => {
    expect(
      mapBriefingPrimaryToLaunchpadMode(
        card({
          primary: { kind: "review", label: "Await recent evidence" },
          label: "test_more",
          blockedActionType: "cut",
        }),
      ),
    ).toBeNull();

    expect(
      mapBriefingPrimaryToLaunchpadMode(
        card({
          primary: null,
          label: "test_more",
          canonicalDecision: {
            contractVersion: "briefing-canonical-native-ad.v1",
            identityGrain: "ad",
            decisionId: "decision_held_cut",
            episodeId: "episode_held_cut",
            adId: "ad_held_cut",
            creativeId: "creative_1",
            classification: {
              decisionState: "blocked",
              buyerAction: "cut",
              buyerLabel: "Cut pending",
              executionAction: null,
              heldAction: "cut",
            },
            sourceDecision: {
              label: "test_more",
              confidence: 0.8,
              reason: "Recent evidence is unavailable.",
              snapshotAsOf: "2026-07-18T00:00:00.000Z",
              computedAt: "2026-07-18T00:01:00.000Z",
            },
            sourceAuthority: {
              status: "native_exact",
              snapshotId: "snapshot_1",
              evaluationId: "evaluation_1",
              inputHash: "input_hash",
              decisionHash: "decision_hash",
              engineVersion: "native-test",
              providerAccountRefId: "provider_ref_1",
              providerAccountId: "act_1",
              realAdId: "ad_held_cut",
              jobRunId: "job_1",
              authorizedAction: null,
              actionEligible: false,
              reviewOnlyReason: "recent_evidence_unavailable",
            },
          } as never,
        }),
      ),
    ).toBeNull();

    expect(
      mapBriefingPrimaryToLaunchpadMode(
        card({ primary: null, label: "test_more", blockedActionType: null }),
      ),
    ).toBe("fresh_test");
  });

  it("keeps canonical actions out of the manual Launchpad write wizard", () => {
    const actionable = canonicalScaleCard();
    expect(mapBriefingPrimaryToLaunchpadMode(actionable)).toBeNull();
    expect(canOpenBriefingCardInLaunchpad(actionable, "promote")).toBe(false);
    expect(() => buildLaunchpadBridgeHref(actionable, "promote")).toThrow(
      "canonical_launch_authority_contract_required",
    );

    const refresh = canonicalRefreshCard();
    expect(mapBriefingPrimaryToLaunchpadMode(refresh)).toBeNull();
    expect(canOpenBriefingCardInLaunchpad(refresh, "fresh_test")).toBe(false);
    expect(() => buildLaunchpadBridgeHref(refresh, "fresh_test")).toThrow(
      "canonical_launch_authority_contract_required",
    );

    const blocked = canonicalScaleCard();
    blocked.canonicalDecision!.classification.decisionState = "blocked";
    expect(mapBriefingPrimaryToLaunchpadMode(blocked)).toBeNull();
    expect(() => buildLaunchpadBridgeHref(blocked, "promote")).toThrow(
      "canonical_launch_authority_contract_required",
    );

    const demo = canonicalScaleCard();
    demo.sourceDecisionAuthorityStatus = "demo_synthetic_review_only";
    demo.canonicalDecision!.sourceAuthority.status =
      "demo_synthetic_review_only";
    expect(mapBriefingPrimaryToLaunchpadMode(demo)).toBeNull();

    const mismatchedSnapshot = canonicalScaleCard();
    mismatchedSnapshot.canonicalDecision!.sourceSnapshotId = "snapshot_2";
    expect(mapBriefingPrimaryToLaunchpadMode(mismatchedSnapshot)).toBeNull();
  });

  it("does not let an actionable canonical action open an unrelated mode", () => {
    const actionable = canonicalScaleCard();
    expect(() =>
      buildLaunchpadBridgeHref(actionable, "fresh_test"),
    ).toThrow("canonical_launch_authority_contract_required");
    expect(() =>
      buildLaunchpadBridgeHref(actionable, "add_existing"),
    ).toThrow("canonical_launch_authority_contract_required");
  });

  it("adapts briefing cards to the Phase 1 overlay item shape", () => {
    expect(buildLaunchpadOverlayItem(card())).toEqual({
      id: "creative_1",
      name: "Aphrodite Hook",
      scopeName: "Broad",
      brand: "TheSwaf",
      campaign: "ASC | Worldwide",
      label: "scale",
    });
  });
});
