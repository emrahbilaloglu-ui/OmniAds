/**
 * Production-composition tests for the commercial-anchor projection.
 *
 * These resolve a REAL `AccountDecisionProfile` through
 * `resolveAccountDecisionProfile` for each anchor regime, then prove the exact
 * canonical explanation survives the server projection unchanged. The
 * projection must never recompute: the regression that made this necessary was
 * a second resolver that could only see configured Target CPA / operator AOV
 * and therefore reported "anchor missing" while the real profile had resolved
 * a ready sampled Meta AOV.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { BusinessTargetPack } from "@/lib/creative-decision-engine/data-source";
import type { AccountCalibration } from "@/lib/creative-decision-engine/types";
import { makeAccountCalibration } from "@/lib/creative-decision-engine/__tests__/helpers";
import { applyCommercialStopLossAovAuthority } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  makeAnchorTargetPack as pack,
  resolveAnchorProfileFixture,
} from "@/lib/creative-decision-engine/__tests__/anchor-profile-fixture";

import {
  META_COMMERCIAL_ANCHOR_PANEL_CONTRACT,
  emptyAuthorityBlockerCounts,
  projectMetaCommercialAnchorPanel,
  tallyAuthorityBlockers,
} from "./commercial-anchor-panel";

/** Resolves a real profile and projects it exactly as the route does. */
async function projectReal(input: {
  targetPack: BusinessTargetPack | null;
  calibration?: AccountCalibration;
  shadowOnly?: boolean;
  currency?: string | null;
}) {
  const profile = await resolveAnchorProfileFixture(input);
  return {
    profile,
    panel: projectMetaCommercialAnchorPanel({
      eligibility: profile.hardActionEligibility,
      currency: "currency" in input ? (input.currency ?? null) : "USD",
      blockers: emptyAuthorityBlockerCounts(),
    }),
  };
}

describe("the projection copies the canonical profile and recomputes nothing", () => {
  it("explicit Target CPA: source, confidence and spend unit come from the profile", async () => {
    // RE-PINNED: `makeAnchorTargetPack` defaults to `targetRoas: 3`, and a
    // Target ROAS now routes to the platform AOV. The CPA rung is exercised
    // where it still governs — with no ratio configured.
    const { profile, panel } = await projectReal({
      targetPack: pack({ targetCpa: 25, targetRoas: null }),
    });
    expect(profile.spendUnitSource).toBe("target_cpa");
    expect(panel.status).toBe("resolved");
    expect(panel.contractVersion).toBe(META_COMMERCIAL_ANCHOR_PANEL_CONTRACT);
    // The exact object, not a copy built from target fields.
    expect(panel.explanation).toBe(profile.hardActionEligibility.anchor);
    expect(panel.explanation?.spendUnitSource).toBe("target_cpa");
    expect(panel.explanation?.spendUnitConfidence).toBe("high");
    expect(panel.explanation?.spendUnit).toBe(profile.spendUnit);
    expect(panel.explanation?.status).toBe("eligible_target_cpa");
  });

  it("a Target CPA under a Target ROAS projects the platform AOV instead", async () => {
    const { profile, panel } = await projectReal({
      targetPack: pack({ targetCpa: 25, targetRoas: 3 }),
    });
    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).not.toBe(25);
    expect(panel.explanation).toBe(profile.hardActionEligibility.anchor);
    expect(panel.explanation?.status).toBe("eligible_meta_derived_aov");
    // Demoted, not dropped: the panel can still show what the operator typed.
    expect(panel.explanation?.lineage.targetCpa).toBe(25);
  });

  it("operator AOV + Target ROAS projects the platform AOV, not the assumption", async () => {
    // RE-PINNED: this asserted `operator_aov` at 90 / 3 = 30. The rung is
    // retired; the account's own Meta-attributed AOV (50) over the ratio is.
    const { profile, panel } = await projectReal({
      targetPack: pack({ operatorAovAssumption: 90, targetRoas: 3 }),
    });
    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).not.toBe(30);
    expect(panel.explanation?.spendUnitSource).toBe("meta_derived_aov");
    expect(panel.explanation?.spendUnitConfidence).toBe("medium");
    expect(panel.explanation?.lineage.operatorAovAssumption).toBe(90);
    expect(panel.explanation?.lineage.targetRoas).toBe(3);
  });

  /**
   * THE REGRESSION CASE. The removed second resolver saw no Target CPA and no
   * operator AOV and therefore said "anchor missing". The real profile resolves
   * a ready sampled Meta AOV, which IS hard-action eligible.
   */
  it("a ready sampled Meta AOV is reported as the real source, never as anchor missing", async () => {
    const { profile, panel } = await projectReal({
      targetPack: pack({ targetCpa: null, operatorAovAssumption: null }),
      calibration: makeAccountCalibration({
        metaAttributedAovMean90d: 60,
        metaAttributedAovPurchaseCount90d: 40,
        metaAttributedRevenue90d: 2400,
      }),
    });
    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.quality.metaAovQuality).toBe("ready");
    expect(panel.explanation?.spendUnitSource).toBe("meta_derived_aov");
    expect(panel.explanation?.status).toBe("eligible_meta_derived_aov");
    expect(panel.explanation?.status).not.toBe("blocked_missing_owner_anchor");
    expect(panel.explanation?.thresholdEligible).toBe(true);
    expect(panel.explanation?.missingInputs).toEqual([]);
    // The sampled rung and its sample are visible lineage, not a hidden guess.
    expect(panel.explanation?.lineage.metaAttributedAovMean90d).toBe(60);
    expect(panel.explanation?.lineage.metaAttributedAovPurchaseCount90d).toBe(40);
  });

  it("an under-sampled Meta AOV is reported as sample-insufficient, not missing", async () => {
    const { profile, panel } = await projectReal({
      targetPack: pack({ targetCpa: null, operatorAovAssumption: null }),
      // metaAovQuality deliberately left at the fixture default "ready" while
      // the purchase count is 6: a stored quality label must never mask a
      // sample the ladder actually judged unusable.
      calibration: makeAccountCalibration({
        metaAttributedAovMean90d: 60,
        metaAttributedAovPurchaseCount90d: 6,
        metaAttributedRevenue90d: 360,
      }),
    });
    /*
      ROUND 6: no unit is built from six purchases under a Target ROAS, so the
      source is the hold itself. The STATUS is what this case is about and it
      is unchanged — the panel must still say "your sample is too small",
      never "you have no anchor" — and `resolveStatus` now re-derives that from
      the same purchase count the ladder divides by rather than from the source
      string, which no longer distinguishes thin from absent.
    */
    expect(profile.spendUnitSource).toBe("insufficient");
    expect(profile.spendUnit).toBeNull();
    expect(panel.explanation?.status).toBe(
      "blocked_meta_aov_sample_insufficient",
    );
    expect(panel.actions.find((row) => row.action === "cut")?.blockerCode).toBe(
      "commercial_anchor_sample_insufficient",
    );
  });

  it("the account-history rung is reported and is never hard-action eligible", async () => {
    const { profile, panel } = await projectReal({
      targetPack: pack({ targetCpa: null, operatorAovAssumption: null }),
      calibration: makeAccountCalibration({
        metaAttributedAovMean90d: null,
        metaAttributedAovPurchaseCount90d: 0,
        metaAttributedRevenue90d: 0,
        accountCpaP50: 30,
        accountCpaSampleCount: 40,
      }),
    });
    /*
      ROUND 6: the fixture's pack carries a Target ROAS, so the account-history
      rung is not reached at all and the panel reports the hold. The lineage
      still CARRIES the account CPA — an operator may see what was measured —
      it simply is not the resolved unit.
    */
    expect(profile.spendUnitSource).toBe("insufficient");
    expect(panel.explanation?.spendUnitSource).toBe("insufficient");
    expect(panel.explanation?.thresholdEligible).toBe(false);
    expect(panel.explanation?.lineage.accountCpaP50).toBe(30);
    expect(panel.explanation?.status).toBe("blocked_missing_owner_anchor");
    for (const row of panel.actions) expect(row.eligible).toBe(false);
  });

  it("unverifiable target provenance is reported separately from a missing anchor", async () => {
    const { panel } = await projectReal({
      targetPack: pack({
        targetCpa: 25,
        updatedAt: null,
        freshness: "unknown",
      }),
    });
    expect(panel.explanation?.status).toBe("blocked_provenance_unverified");
    expect(panel.explanation?.missingInputs).toEqual([
      "commercial_target_provenance",
    ]);
  });

  /**
   * The per-action rule, as it now stands.
   *
   * Cut takes EITHER commercial ratio: `cutAnchorEligible` in
   * `account-decision-profile.ts` is `breakEvenAnchored || targetRoasAnchored`.
   * An explicit break-even used to be mandatory, which refused Cut on every
   * account that configures only a Target ROAS — the shape this product asks
   * for — even where the Cut the resolver wanted to publish was the
   * account-relative one that never reads break-even. Scale is unchanged: it
   * still needs a Target ROAS specifically, because that is the ratio it
   * multiplies.
   */
  it("Cut takes either commercial ratio; Scale still needs the Target ROAS", async () => {
    const noBreakEven = await projectReal({
      targetPack: pack({ targetCpa: 25, breakEvenRoas: null }),
    });
    const cutOnTargetRoas = noBreakEven.panel.actions.find(
      (row) => row.action === "cut",
    );
    expect(cutOnTargetRoas?.eligible).toBe(true);
    expect(cutOnTargetRoas?.blockerCode).toBeNull();
    expect(
      noBreakEven.panel.actions.find((row) => row.action === "refresh")
        ?.eligible,
    ).toBe(true);

    const noTargetRoas = await projectReal({
      targetPack: pack({ targetCpa: 25, targetRoas: null }),
    });
    const scale = noTargetRoas.panel.actions.find(
      (row) => row.action === "scale",
    );
    expect(scale?.eligible).toBe(false);
    expect(scale?.blockerCode).toBe("target_roas_missing");
    // Symmetrically, a break-even alone still carries Cut.
    expect(
      noTargetRoas.panel.actions.find((row) => row.action === "cut")?.eligible,
    ).toBe(true);
  });

  /** The guard against over-correcting the rule above into a free pass. */
  it("a Cut with NEITHER a break-even NOR a Target ROAS is still refused, by name", async () => {
    const { profile, panel } = await projectReal({
      targetPack: pack({ targetCpa: 25, targetRoas: null, breakEvenRoas: null }),
    });
    // The commercial threshold itself is satisfied by the Target CPA, so the
    // refusal below is the per-action anchor rule and nothing else.
    expect(profile.hardActionEligibility.anchor?.thresholdEligible).toBe(true);

    const cut = panel.actions.find((row) => row.action === "cut");
    expect(cut?.eligible).toBe(false);
    // `break_even_roas_missing` is the code the resolver emits for an absent
    // per-action Cut ratio; `CommercialAnchorBlockerCode` has no separate
    // "neither ratio" member, so its operator copy still names only break-even
    // and is now narrower than the rule it explains.
    expect(cut?.blockerCode).toBe("break_even_roas_missing");
    expect(cut?.operatorCopy).not.toBeNull();
  });

  it("shadow-only withholds every action", async () => {
    const { panel } = await projectReal({
      targetPack: pack({ targetCpa: 25 }),
      shadowOnly: true,
    });
    for (const row of panel.actions) {
      expect(row.eligible).toBe(false);
      expect(row.blockerCode).toBe("shadow_only");
    }
  });

  it("every action row carries eligible, a code and operator copy", async () => {
    const { panel } = await projectReal({
      targetPack: pack({ targetCpa: null, operatorAovAssumption: null }),
    });
    expect(panel.actions.map((row) => row.action)).toEqual([
      "scale",
      "cut",
      "refresh",
    ]);
    for (const row of panel.actions) {
      if (row.eligible) {
        expect(row.blockerCode).toBeNull();
        expect(row.operatorCopy).toBeNull();
      } else {
        expect(row.blockerCode).not.toBeNull();
        expect(row.operatorCopy).not.toBeNull();
      }
    }
  });

  it("never defaults an unknown currency to USD", async () => {
    const { panel } = await projectReal({
      targetPack: pack({ targetCpa: 25 }),
      currency: null,
    });
    expect(panel.currency).toBeNull();
  });
});

describe("the projection fails closed", () => {
  it("a failed profile read is unavailable, never 'no anchor configured'", () => {
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: null,
      profileReadFailed: true,
      currency: "USD",
      blockers: emptyAuthorityBlockerCounts(),
    });
    expect(panel.status).toBe("unavailable");
    expect(panel.unavailableReason).toBe("profile_read_failed");
    expect(panel.explanation).toBeNull();
    expect(panel.actions).toEqual([]);
  });

  it("an unresolved profile is unavailable", () => {
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: null,
      currency: "USD",
      blockers: emptyAuthorityBlockerCounts(),
    });
    expect(panel.status).toBe("unavailable");
    expect(panel.unavailableReason).toBe("profile_not_resolved");
  });

  it("a pre-contract profile without an explanation is unknown, not eligible", () => {
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: {
        scale: true,
        cut: true,
        refresh: true,
        reason: null,
      },
      currency: "USD",
      blockers: emptyAuthorityBlockerCounts(),
    });
    expect(panel.status).toBe("unavailable");
    expect(panel.unavailableReason).toBe(
      "explanation_absent_pre_contract_profile",
    );
    expect(panel.explanation).toBeNull();
    expect(panel.actions).toEqual([]);
  });
});

describe("authority blocker tallies are server evidence", () => {
  it("separates the commercial-threshold gate from the independent gates", () => {
    const counts = tallyAuthorityBlockers([
      "profile_hard_action_ineligible",
      "profile_hard_action_ineligible",
      "campaign_context",
      "recent_recovery_unverifiable",
      "something_new",
      null,
      undefined,
    ]);
    expect(counts).toEqual({
      profileHardActionIneligible: 2,
      campaignContext: 1,
      recentRecoveryUnverifiable: 1,
      other: 1,
    });
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: null,
      currency: "USD",
      blockers: counts,
    });
    expect(panel.withheld).toEqual({
      total: 5,
      profileHardActionEvidence: 2,
      campaignContext: 1,
      recentRecoveryUnverifiable: 1,
      other: 1,
    });
  });
});

describe("the projection cannot recompute or reintroduce a campaign role", () => {
  it("names no spend-unit ladder, resolver or campaign-kind writer", () => {
    const source = readFileSync(
      resolve("lib/meta/commercial-anchor-panel.ts"),
      "utf8",
    );
    // A second resolver is exactly what was rejected: the projection must not
    // import or call the ladder, nor read raw target fields to decide.
    // Imports, not prose: the module's own docstring names the rejected design
    // on purpose, and that sentence is why the file is safe to read.
    expect(source).not.toMatch(/from "@\/lib\/meta\/commercial-targets"/);
    expect(source).not.toMatch(/from "@\/lib\/creative-decision-engine\/spend-unit-resolver"/);
    for (const call of [
      "resolveSpendUnit(",
      "classifyMetaAovQuality(",
      "resolveCommercialAnchorExplanation(",
      "writeMetaCampaignLabels",
      "campaignLabelStatus",
      "brief_variation",
    ]) {
      expect(source.includes(call), `must not call ${call}`).toBe(false);
    }
    expect(source).not.toMatch(/campaignKind\s*[=:]/);
    expect(source).not.toMatch(/buyerAction\s*[=:]/);
  });
});

describe("C2.2 — a generic profile blocker is never labelled a commercial-threshold blocker", () => {
  it("a calibration-blocked Scale proves the persisted blocker is not an anchor cause", async () => {
    // Real profile: the commercial threshold IS satisfied, yet Scale is still
    // withheld — by calibration, not by any anchor problem. A row persisted as
    // `profile_hard_action_ineligible` can therefore mean this.
    const profile = await resolveAnchorProfileFixture({
      targetPack: pack({ targetCpa: 25 }),
      calibration: makeAccountCalibration({ matureCreativeCount: 1 }),
    });
    expect(profile.hardActionEligibility.anchor?.thresholdEligible).toBe(true);
    expect(profile.hardActionEligibility.scale).toBe(false);
    expect(profile.hardActionEligibility.codes?.scale).toBe(
      "scale_calibration_below_floor",
    );

    const panel = projectMetaCommercialAnchorPanel({
      eligibility: profile.hardActionEligibility,
      currency: "USD",
      blockers: {
        ...emptyAuthorityBlockerCounts(),
        profileHardActionIneligible: 1,
      },
    });
    // The generic persisted count must stay generic.
    expect(panel.withheld.profileHardActionEvidence).toBe(1);
    expect(
      (panel.withheld as Record<string, unknown>).commercialThresholdGate,
    ).toBeUndefined();
  });

  it("the withheld counts never claim an anchor sub-cause", () => {
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: null,
      currency: "USD",
      blockers: {
        ...emptyAuthorityBlockerCounts(),
        profileHardActionIneligible: 1872,
        campaignContext: 95,
        recentRecoveryUnverifiable: 26,
      },
    });
    expect(panel.withheld).toEqual({
      total: 1993,
      profileHardActionEvidence: 1872,
      campaignContext: 95,
      recentRecoveryUnverifiable: 26,
      other: 0,
    });
  });
});

describe("C2.3 — effective code and operator copy must agree after an overlay", () => {
  /**
   * The Cut-only commercial stop-loss overlay can change the EFFECTIVE Cut
   * decision while the pre-overlay canonical explanation still carries the old
   * one. Copying the chip from one and the sentence from the other is
   * self-contradictory.
   *
   * The pack is ROAS-only on purpose (no Target CPA, no operator AOV, no
   * break-even) and the base calibration has no usable sampled AOV, so the
   * canonical anchor resolves to `commercial_anchor_missing`. The overlay then
   * supplies a ready sampled AOV, and its Cut lane needs only the Target ROAS
   * this pack already carries.
   */
  const OVERLAY_PACK = pack({
    targetCpa: null,
    operatorAovAssumption: null,
    breakEvenRoas: null,
  });

  async function overlaidProfile(
    authority: {
      meanAov: number;
      purchaseCount: number;
      totalRevenue: number;
    } | null = { meanAov: 60, purchaseCount: 40, totalRevenue: 2400 },
  ) {
    const base = await resolveAnchorProfileFixture({
      targetPack: OVERLAY_PACK,
      calibration: makeAccountCalibration({
        metaAttributedAovMean90d: null,
        metaAttributedAovPurchaseCount90d: 0,
        metaAttributedRevenue90d: 0,
      }),
    });
    return applyCommercialStopLossAovAuthority({
      profile: base,
      targetPack: OVERLAY_PACK,
      attributionAovAdjustmentMultiplier: 1,
      shadowOnly: false,
      authority,
    });
  }

  it("the overlay really does change the effective Cut decision", async () => {
    const profile = await overlaidProfile();
    // The canonical anchor is untouched by the Cut-only overlay and still
    // reports the pre-overlay refusal.
    expect(profile.hardActionEligibility.anchor?.actions.cut.eligible).toBe(
      false,
    );
    expect(profile.hardActionEligibility.anchor?.actions.cut.blockerCode).toBe(
      "commercial_anchor_missing",
    );
    // The effective decision disagrees with it: the overlay's sampled AOV plus
    // the pack's Target ROAS carry Cut. Before break-even stopped being a
    // required Cut input this was `break_even_roas_missing` — still blocked,
    // just for a different reason than the anchor gave.
    expect(profile.hardActionEligibility.cut).toBe(true);
    expect(profile.hardActionEligibility.codes?.cut ?? null).toBeNull();
  });

  it("the panel's Cut row is derived from the EFFECTIVE decision, not the stale anchor", async () => {
    const profile = await overlaidProfile();
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: profile.hardActionEligibility,
      currency: "USD",
      blockers: emptyAuthorityBlockerCounts(),
    });
    const cut = panel.actions.find((row) => row.action === "cut");
    expect(cut?.eligible).toBe(true);
    expect(cut?.blockerCode).toBeNull();
    expect(cut?.operatorCopy).toBeNull();
    // The stale sentence was available on the copied explanation and was not
    // used: that is the whole point of the row taking the effective decision.
    expect(panel.explanation?.actions.cut.operatorCopy).toContain(
      "A usable Meta-attributed purchase sample is missing",
    );
  });

  it("with no valid stop-loss AOV there is no overlay, and the canonical refusal is shown", async () => {
    // 4 purchases is below `NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR`, so
    // no overlay is built at all. The panel must then report the canonical
    // blocked row rather than the eligible one the case above produces.
    const profile = await overlaidProfile({
      meanAov: 60,
      purchaseCount: 4,
      totalRevenue: 240,
    });
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: profile.hardActionEligibility,
      currency: "USD",
      blockers: emptyAuthorityBlockerCounts(),
    });
    const cut = panel.actions.find((row) => row.action === "cut");
    expect(cut?.eligible).toBe(false);
    expect(cut?.blockerCode).toBe("commercial_anchor_missing");
    expect(cut?.operatorCopy).toContain("A usable Meta-attributed purchase sample is missing");
    expect(cut?.operatorCopy).not.toContain("Set a Target ROAS");
  });

  it("an eligible action carries no blocker copy at all", async () => {
    const profile = await resolveAnchorProfileFixture({
      targetPack: pack({ targetCpa: 25 }),
    });
    const panel = projectMetaCommercialAnchorPanel({
      eligibility: profile.hardActionEligibility,
      currency: "USD",
      blockers: emptyAuthorityBlockerCounts(),
    });
    for (const row of panel.actions) {
      if (!row.eligible) continue;
      expect(row.blockerCode).toBeNull();
      expect(row.operatorCopy).toBeNull();
    }
  });
});
