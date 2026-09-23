/**
 * ADR D097 round 2 — what the buyer actually SEES for a role-held Cut.
 *
 * Round 1 stopped the producer erasing the verdict, and that was not enough.
 * The served projection still read:
 *
 *     decisionState: "blocked", buyerAction: null,
 *     resolution.label: "Automatic Classification Pending",
 *     resolution.nextStep: "... No operator input is required ..."
 *
 * so a confirmed stop-loss arrived at the operator as a data gap with an
 * instruction to do nothing. Preserving a label the surface never shows is not
 * preserving anything.
 *
 * The negative controls matter as much as the positive ones: this must change
 * the SENTENCE, never the authority. `decisionState`, `buyerAction` and
 * provider authority are bound to a non-null `blocked_action_type` by
 * INVARIANTS.md and are asserted unchanged below.
 */
import { describe, expect, it } from "vitest";

import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
import { adAction } from "@/lib/meta/decisions-os-presentation";

type Held = "cut" | "scale" | "refresh";

const roleHeld = (held: Held) =>
  projectMetaDecisionSemantics({
    sourceLabel: held,
    legacyBuyerAction: held,
    badgeCodes: ["campaign_context_unresolved"],
    blockerCodes: ["campaign_context"],
    heldAction: held,
    authorityBlocker: "campaign_context",
    lifecycleRole: null,
  } as never);

describe("POSITIVE — a role-held Cut is served as a sound finding", () => {
  const cut = roleHeld("cut");

  it("names the verdict instead of pending classification", () => {
    expect(cut.resolution?.code).toBe("apply_cut_manually");
    expect(cut.resolution?.label).toBe(
      "Cut Evidence Complete - Automated Execution Held",
    );
  });

  it("addresses the operator, not the system", () => {
    // `owner` is what the buyer-facing adapter falls back on. "system" meant
    // "there is nothing for you to do", beside an established loss.
    expect(cut.resolution?.owner).toBe("operator");
  });

  it("never tells the buyer that no input is required", () => {
    expect(cut.resolution?.nextStep).not.toContain("No operator input is required");
    expect(cut.resolution?.nextStep).toContain("pause this ad yourself");
  });

  it("says the role governs HOW the stop is applied, not whether the evidence is complete", () => {
    expect(cut.resolution?.nextStep).toContain("does not depend on the campaign role");
  });

  it("does NOT assert a realised financial loss", () => {
    /*
      A Cut can arrive here from `calibrated_relative`, described in
      ad-calibration-job.ts as "a relative boundary with NO economic unit", so
      "below target" is not "below break-even". Measured on production
      2026-09-21: all 19 Cut decisions that day were relative or
      zero-conversion and NONE cited break-even, so an established-loss claim
      would have been wrong on every one of them.
    */
    const text = `${cut.resolution?.label} ${cut.resolution?.nextStep}`;
    expect(text).not.toMatch(/loss is (established|confirmed)/i);
    expect(text).not.toMatch(/stop-loss confirmed/i);
    expect(text).toContain("performance evidence");
  });
});

describe("NEGATIVE — authority is untouched, and Scale/Refresh are not affected", () => {
  it.each(["cut", "scale", "refresh"] as const)(
    "a role-held %s is still blocked with no buyer action",
    (held) => {
      // INVARIANTS.md: "A non-null `blocked_action_type` must serve as
      // `decisionState: blocked`, `buyerAction: null`, a server-produced
      // resolution, and a held-action label."
      const projected = roleHeld(held);
      expect(projected.decisionState).toBe("blocked");
      expect(projected.buyerAction).toBeNull();
      expect(projected.heldAction).toBe(held);
      expect(projected.resolution).not.toBeNull();
    },
  );

  it.each(["scale", "refresh"] as const)(
    "a role-held %s still reports pending classification",
    (held) => {
      // These two genuinely ARE undetermined without the role: both answer
      // "where", and the resolver settling it is the actual next step.
      const projected = roleHeld(held);
      expect(projected.resolution?.code).toBe("resolve_campaign_role");
      expect(projected.resolution?.owner).toBe("system");
      expect(projected.resolution?.nextStep).toContain(
        "No operator input is required",
      );
    },
  );

  it("does not change a Cut held for a reason other than the role", () => {
    const freshnessHeld = projectMetaDecisionSemantics({
      sourceLabel: "cut",
      legacyBuyerAction: "cut",
      badgeCodes: ["stale_evidence"],
      blockerCodes: ["source_freshness"],
      heldAction: "cut",
      authorityBlocker: "source_freshness",
      lifecycleRole: null,
    } as never);

    expect(freshnessHeld.resolution?.code).not.toBe("apply_cut_manually");
    expect(freshnessHeld.decisionState).toBe("blocked");
  });
});


describe("ROUND 3 — the lane moves, the authority does not", () => {
  const actionFor = (held: Held) =>
    adAction(
      {
        classification: {
          ...roleHeld(held),
          lifecycleRole: { value: null },
        },
        parentChain: { ad: { id: "ad-1" } },
        sourceAuthority: null,
      } as never,
      { scale: false, cut: false, refresh: false } as never,
    );

  it("puts a role-held Cut in the ACTION lane, not among evidence gaps", () => {
    // The whole objection: a confirmed stop-loss filed under "needs review
    // before any action" is indistinguishable from a data gap.
    const cut = actionFor("cut");
    expect(cut.lane).toBe("act");
    expect(cut.action.code).toBe("apply_cut_manually");
    expect(cut.action.label).toBe("Cut Evidence Complete - Automated Execution Held");
  });

  it("offers NO provider write from that lane", () => {
    // `intent === "execute" && providerMutation === "pause"` is the pair the
    // surface gates a Meta mutation on. Neither is present.
    const cut = actionFor("cut");
    expect(cut.action.intent).toBe("review");
    expect(cut.action.providerMutation).toBeNull();
  });

  it.each(["scale", "refresh"] as const)(
    "leaves a role-held %s in the held lane",
    (held) => {
      // Both answer "where". Without the role they have no answer, so the held
      // lane is the truthful place for them.
      const other = actionFor(held);
      expect(other.lane).toBe("blocked");
      expect(other.action.code).toBe("resolve_campaign_role");
    },
  );

  it("keeps the decision state blocked, which is what refuses Launchpad", () => {
    // `launchpad-handoff-contract.ts` requires decisionState === "act".
    expect(roleHeld("cut").decisionState).toBe("blocked");
    expect(roleHeld("cut").buyerAction).toBeNull();
  });
});

/*
  ── A PENDING CUT IS NOT A COMPLETED VERDICT ────────────────────────────────

  Hysteresis publishes an unconfirmed hard label as "keep" with a
  `pending_transition` badge and keeps the Cut only as the held action, and the
  role guard stamps `campaign_context` on the same row. The served projection
  used to return "Cut Evidence Complete" for it and file it in the ACTION lane,
  inviting a manual pause the two-evaluation rule had not yet allowed. Measured
  on a read-only current-code simulation of Grandmix (2026-09-19): the one raw
  Cut that day was exactly this row.
*/
describe("a role-held Cut still awaiting confirmation", () => {
  const pendingRoleHeldCut = projectMetaDecisionSemantics({
    sourceLabel: "keep",
    legacyBuyerAction: "keep",
    badgeCodes: ["campaign_context_unresolved", "pending_transition"],
    blockerCodes: ["campaign_context"],
    heldAction: "cut",
    authorityBlocker: "campaign_context",
    lifecycleRole: null,
  } as never);

  it("NEGATIVE: is served as pending confirmation, not as completed evidence", () => {
    expect(pendingRoleHeldCut.resolution?.code).toBe("await_decision_confirmation");
    expect(pendingRoleHeldCut.resolution?.label).not.toContain("Cut Evidence Complete");
    expect(pendingRoleHeldCut.resolution?.nextStep).not.toContain("pause this ad yourself");
  });

  it("NEGATIVE: stays in the held lane", () => {
    const action = adAction(
      {
        classification: { ...pendingRoleHeldCut, lifecycleRole: { value: null } },
        parentChain: { ad: { id: "ad-1" } },
        sourceAuthority: null,
      } as never,
      { scale: false, cut: false, refresh: false } as never,
    );
    expect(action.lane).toBe("blocked");
    expect(action.action.providerMutation).toBeNull();
  });

  it("POSITIVE: the CONFIRMED role-held Cut still reads as completed evidence", () => {
    expect(roleHeld("cut").resolution?.code).toBe("apply_cut_manually");
  });
});

/*
  ── THE D098 CONFIG-SOURCE HOLD NAMES ITSELF ────────────────────────────────

  `config_source_authority` fell through to "Restore Native Decision Profile",
  naming the wrong thing and the wrong owner: the profile was ready. What is
  missing is a provider configuration receipt for the evaluation day, or
  verified configuration on every economic day behind the verdict.
*/
describe("a hard verdict held by the config-source gate", () => {
  const configHeld = (held: Held, badges: string[] = []) =>
    projectMetaDecisionSemantics({
      sourceLabel: held,
      legacyBuyerAction: held,
      badgeCodes: badges,
      blockerCodes: ["config_source_authority"],
      heldAction: held,
      authorityBlocker: "config_source_authority",
      lifecycleRole: null,
    } as never);

  it.each(["cut", "scale", "refresh"] as const)(
    "NEGATIVE: a held %s is never told to restore the native profile",
    (held) => {
      const semantics = configHeld(held);
      expect(semantics.resolution?.code).not.toBe("restore_native_profile");
      expect(semantics.resolution?.code).toBe("complete_hard_action_evidence");
      expect(semantics.resolution?.nextStep).toContain("provider receipt");
      expect(semantics.decisionState).toBe("blocked");
      expect(semantics.buyerAction).toBeNull();
    },
  );

  it("a pending config-held verdict waits for confirmation first", () => {
    expect(configHeld("cut", ["pending_transition"]).resolution?.code).toBe(
      "await_decision_confirmation",
    );
  });
});

/*
  ── A ROLE-HELD CUT ON UNVERIFIED CONFIGURATION IS NOT COMPLETE EVIDENCE ────

  The role guard stamps `campaign_context` first; the D098 config gate runs at
  payload time and keeps the first blocker, so the config hold used to be
  invisible here and the Cut was served as "Cut Evidence Complete". A read-only
  current-code simulation of Grandmix (2026-09-19..21) produced exactly this
  row: the day's only Cut was role-held AND had no current-day config receipt
  (campaign objective receipts have been failing since 2026-08-22). The engine's
  own recorded config evidence now decides; the persisted blocker is unchanged.
*/
describe("a role-held Cut whose configuration was not established", () => {
  const roleHeldWithConfig = (configAuthorityVerified: boolean | null) =>
    projectMetaDecisionSemantics({
      sourceLabel: "cut",
      legacyBuyerAction: "cut",
      badgeCodes: ["campaign_context_unresolved"],
      blockerCodes: ["campaign_context"],
      heldAction: "cut",
      authorityBlocker: "campaign_context",
      lifecycleRole: null,
      configAuthorityVerified,
    } as never);
  const laneOf = (semantics: ReturnType<typeof roleHeldWithConfig>) =>
    adAction(
      {
        classification: { ...semantics, lifecycleRole: { value: null } },
        parentChain: { ad: { id: "ad-1" } },
        sourceAuthority: null,
      } as never,
      { scale: false, cut: false, refresh: false } as never,
    );

  it("NEGATIVE: is served as held evidence, in the held lane", () => {
    const semantics = roleHeldWithConfig(false);
    expect(semantics.resolution?.code).toBe("complete_hard_action_evidence");
    expect(semantics.resolution?.nextStep).toContain("provider receipt");
    expect(semantics.resolution?.nextStep).not.toContain("pause this ad yourself");
    expect(laneOf(semantics).lane).toBe("blocked");
    expect(semantics.decisionState).toBe("blocked");
    expect(semantics.buyerAction).toBeNull();
  });

  it("POSITIVE: verified configuration keeps the completed-evidence sentence and lane", () => {
    const semantics = roleHeldWithConfig(true);
    expect(semantics.resolution?.code).toBe("apply_cut_manually");
    expect(laneOf(semantics).lane).toBe("act");
  });

  it("an envelope with no recorded config evidence is served exactly as before", () => {
    expect(roleHeldWithConfig(null).resolution?.code).toBe("apply_cut_manually");
  });
});
