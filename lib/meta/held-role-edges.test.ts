import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
  META_AUTOMATIC_CONTEXT_REVIEW_REASON,
  applyMetaCampaignLabelGuard,
  isContextTrustedForAction,
  type MetaCampaignContextGuardEntry,
} from "@/lib/meta/campaign-label-guard";
import { CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV } from "@/lib/creative-decision-engine/campaign-context/source";
import { decisionLabelForMetaRec } from "@/lib/meta/rec-label-mapping";
import { serverActionKindForRec } from "@/lib/meta/rec-presentation";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

/*
  EVERY CAMPAIGN-CONTEXT STATE THE GUARD CAN SEE, AND WHAT A HELD ROW OWES.

  `applyMetaCampaignLabelGuard` is the only place a Meta campaign/ad-set
  recommendation is held for an unresolved automatic role, and the four things a
  held row owes an operator are the same in every one of those states:

    1. The recommendation and its mathematical verdict stay VISIBLE. D091:
       "The mathematical verdict and its specific held reason stay visible;
       `autoExecuteEligible` and provider-write eligibility are a separate
       gate." INVARIANTS.md, same rule at the campaign-context grain:
       "Automatic-context uncertainty must use canonical baselines and preserve
       the mathematical Scale/Cut/Refresh verdict as review-only."
    2. No action authority travels with it.
    3. Its OWN reason survives, by name. A specific hold that renders as a
       generic "diagnose" chip or a generic "resolve the inputs" sentence has
       told the operator nothing, and is the defect the verdict/execution
       separation exists to remove.
    4. `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` stays unarmed, and nothing
       in the guard arms it.

  ON `buyerAction` / `authorizedAction`. Neither is a field of `interface
  MetaRecommendation` (lib/meta/recommendations.ts) and neither can be set by
  this guard. They belong to the AD-grain canonical decision contract — declared
  on `classification` in lib/meta/decisions-workspace-contract.ts and written in
  lib/meta/decisions-workspace-read-model.ts from `projectMetaDecisionSemantics`
  — whose rows are built from `engine_v3_decision_snapshots_daily`, not from
  these recommendations. The Decision Center's structure rows carry no
  `buyerAction` at all
  (components/meta/decision-center/meta-decision-center-exact-adapter.ts). So
  the absence is asserted here as an absence, and the equivalents that DO exist
  on this path — `campaignContext.trustedForAction`,
  `automationReadiness.autoExecuteEligible`, and the action kind the server
  hands the primary control — are asserted positively.
*/

const CAMPAIGN_ID = "cmp-held";

function hardActionRec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec-held",
    level: "campaign",
    campaignId: CAMPAIGN_ID,
    campaignName: "Held Campaign",
    type: "scale_for_volume",
    lens: "volume",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.88,
    confidenceReason: null,
    decisionState: "act",
    decision: "Scale this campaign",
    title: "Scale Held Campaign",
    why: "Held Campaign is above the calibrated scale line on 5 of 5 segments.",
    summary: "Strong campaign.",
    recommendedAction: "Increase budget 10-15%.",
    expectedImpact: "More volume.",
    evidence: [{ label: "ROAS", value: "4.00x", tone: "positive" }],
    timeframeContext: {
      coreVerdict: "Strong",
      selectedRangeOverlay: "Selected range supports scale.",
      historicalSupport: "History supports scale.",
      seasonalityFlag: "none",
      note: null,
    },
    ...overrides,
  };
}

function guard(input: {
  rec: MetaRecommendation;
  entry?: MetaCampaignContextGuardEntry | null;
  automaticContextEnabled?: boolean;
  activeCampaignIds?: string[];
}) {
  const result = applyMetaCampaignLabelGuard({
    recommendations: [input.rec],
    campaignLabelsById: null,
    campaignContextById: input.entry
      ? new Map([[CAMPAIGN_ID, input.entry]])
      : new Map(),
    automaticContextEnabled: input.automaticContextEnabled ?? true,
    activeCampaignIds: input.activeCampaignIds ?? [CAMPAIGN_ID],
  });
  return { result, guarded: result.recommendations[0]! };
}

/** The one entry that carries full authority: high trust, automatic origin, approved resolver. */
const VALIDATED_HIGH: MetaCampaignContextGuardEntry = {
  kind: "main",
  contextTrust: "high",
  source: "system_inferred",
  inferenceConfidenceClass: "high",
  resolverAuthorityValidated: true,
};

interface HeldState {
  /** Test name. */
  name: string;
  entry: MetaCampaignContextGuardEntry | null;
  /** Held reason this state must publish, by name. */
  reason: string;
  /** `signalQuality.campaign_context_status`, by name. */
  status: string;
  /** The operator-visible "Campaign context" evidence, by name. */
  evidence: string;
  automaticContextEnabled?: boolean;
}

/*
  The eight states, and where each one comes from.

  `readCampaignContextMap` (lib/creative-decision-engine/campaign-context/source.ts)
  derives `contextTrust` from three independent facts: the persisted confidence
  class, a byte-exact `system_inferred` origin, and a byte-exact approved
  resolver identity. `high` requires all three; anything less lands on `medium`,
  `low`, `unknown` or `conflict`, and a campaign with no row at all is filled in
  as `unknown`. `readCampaignContextGuardState` (lib/meta/snapshot.ts) is the
  only runtime caller and passes those entries through unchanged.
*/
const HELD_STATES: HeldState[] = [
  {
    // The live shape of the 106 Grandmix rows: the inference is high, the
    // resolver identity is not the approved one, so trust lands on medium.
    name: "unvalidated high inference (resolver identity not approved)",
    entry: {
      kind: "main",
      contextTrust: "medium",
      source: "system_inferred",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: false,
    },
    reason: META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
    status: "medium",
    evidence: "Automatic high · main · resolver validation pending · review-only",
  },
  {
    // The contradiction: `high` trust beside a resolver the entry itself says
    // did not validate. INVARIANTS.md requires BOTH halves, and this guard read
    // only the first one until the fix below.
    name: "unvalidated high trust (the two halves of the invariant disagree)",
    entry: {
      kind: "main",
      contextTrust: "high",
      source: "system_inferred",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: false,
    },
    reason: META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
    status: "high",
    evidence: "Automatic high · main · resolver validation pending · review-only",
  },
  {
    name: "medium confidence",
    entry: {
      kind: "main",
      contextTrust: "medium",
      source: "system_inferred",
      inferenceConfidenceClass: "medium",
      resolverAuthorityValidated: false,
    },
    reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    status: "medium",
    evidence: "Automatic medium · main · review-only",
  },
  {
    name: "low confidence",
    entry: {
      kind: "test",
      contextTrust: "low",
      source: "system_inferred",
      inferenceConfidenceClass: "low",
      resolverAuthorityValidated: false,
    },
    reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    status: "low",
    evidence: "Automatic low · test · review-only",
  },
  {
    name: "unknown",
    entry: {
      kind: null,
      contextTrust: "unknown",
      source: "unknown",
      inferenceConfidenceClass: "unknown",
      resolverAuthorityValidated: false,
    },
    reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    status: "unknown",
    evidence: "Automatic unknown · review-only",
  },
  {
    // Sources disagree. `readPersistedCampaignContext` reports it as its own
    // confidence class rather than folding it into `unknown`, and the hold has
    // to keep saying which of the two it is.
    name: "conflict (context sources disagree)",
    entry: {
      kind: null,
      contextTrust: "conflict",
      source: "unknown",
      inferenceConfidenceClass: "conflict",
      resolverAuthorityValidated: false,
    },
    reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    status: "conflict",
    evidence: "Automatic conflict · review-only",
  },
  {
    // No map at all: the account-scope refusal in `readCampaignContextMap`
    // returns an empty map, and every campaign in it is unresolved.
    name: "missing map entirely",
    entry: null,
    reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    status: "unknown",
    evidence: "Automatic unknown · review-only",
  },
];

describe("held role edges: the control that proves the holds are not vacuous", () => {
  it("authorizes a hard action when high trust, automatic origin and an approved resolver all hold", () => {
    const { result, guarded } = guard({ rec: hardActionRec(), entry: VALIDATED_HIGH });

    expect(result.downgradedCount).toBe(0);
    expect(guarded.decisionState).toBe("act");
    expect(guarded.confidenceScore).toBe(0.88);
    expect(guarded.confidenceReason).toBeNull();
    expect(guarded.campaignContext).toMatchObject({
      kind: "main",
      source: "system_inferred",
      confidence: "high",
      trustedForAction: true,
    });
    // Kind semantics unlocked: this is what every held state below must not get.
    expect(guarded.campaignKind).toBe("main");
  });
});

describe.each(HELD_STATES)("held role edge: $name", (state) => {
  const heldRec = hardActionRec();
  const canonicalVerdict = decisionLabelForMetaRec(heldRec);

  it("keeps the recommendation and its mathematical verdict visible", () => {
    const { result, guarded } = guard({
      rec: heldRec,
      entry: state.entry,
      automaticContextEnabled: state.automaticContextEnabled,
    });

    expect(result.downgradedCount).toBe(1);
    expect(result.recommendations).toHaveLength(1);
    expect(guarded.id).toBe(heldRec.id);
    expect(guarded.type).toBe(heldRec.type);
    // The verdict itself, in the field the blocked lane renders
    // (`buyerFacingStructureDecisionLabel`).
    expect(guarded.decisionLabel).toBe(canonicalVerdict);
    expect(canonicalVerdict).toBe("scale");
    // ...and the reasoning that produced it, still readable.
    expect(guarded.why).toContain(heldRec.why);
    expect(guarded.evidence).toEqual(expect.arrayContaining(heldRec.evidence));
  });

  it("withholds every action authority the row could carry", () => {
    const { guarded } = guard({
      rec: heldRec,
      entry: state.entry,
      automaticContextEnabled: state.automaticContextEnabled,
    });

    expect(guarded.decisionState).toBe("watch");
    expect(guarded.campaignContext?.trustedForAction).toBe(false);
    // Kind semantics stay locked: no `campaignKind`, so nothing downstream can
    // read Main/Test/Mixed off this row, and the Test transforms cannot fire.
    expect(guarded.campaignKind).toBeUndefined();
    expect(guarded.labelTransform).toBeUndefined();
    expect(guarded.automationReadiness?.autoExecuteEligible).toBe(false);
    expect(guarded.automationReadiness?.tier).toBe("read_only");
    expect(guarded.automationReadiness?.blockers).toEqual(
      expect.arrayContaining([
        state.reason === META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON
          ? "campaign_context_resolver_unvalidated"
          : "campaign_context_unresolved",
      ]),
    );
    // The primary control opens the drawer. `MetaRecActionKind` has no
    // execute_* member at all any more (the `MetaRecActionKind` union in
    // lib/meta/rec-presentation.ts); this pins that a held row cannot reach the
    // two Launchpad routes either.
    expect(serverActionKindForRec(guarded)).toBe("review_drill");
    // buyerAction/authorizedAction are ad-grain fields and are absent here by
    // construction, not by omission. @see the file header.
    expect("buyerAction" in guarded).toBe(false);
    expect("authorizedAction" in guarded).toBe(false);
  });

  it("publishes its own held reason by name, and never a generic diagnose", () => {
    const { guarded } = guard({
      rec: heldRec,
      entry: state.entry,
      automaticContextEnabled: state.automaticContextEnabled,
    });

    expect(guarded.confidenceReason).toBe(state.reason);
    expect(guarded.signalQuality).toMatchObject({
      campaign_context_status: state.status,
      campaign_context_action_authority:
        state.reason === META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON
          ? "resolver_unvalidated"
          : "review_only",
    });
    expect(guarded.evidence).toEqual(
      expect.arrayContaining([
        { label: "Campaign context", value: state.evidence, tone: "warning" },
      ]),
    );
    // The three shapes the specific reason used to collapse into.
    expect(guarded.decisionLabel).not.toBe("diagnose");
    expect(guarded.kind).not.toBe("anomaly");
    expect(guarded.recommendedAction).toBe(heldRec.recommendedAction);
  });
});

describe("held role edges: no campaign id on the recommendation at all", () => {
  /*
    `campaignIdsForRec` answers with an EMPTY list for a campaign/ad-set row
    that carries no campaign id, and for an account-level row whose type is not
    an account-level hard type. An empty list is not "nothing to check" — there
    is no campaign whose role could have been resolved, so the row is
    unresolved by definition.
  */
  it("holds a campaign-level hard action that names no campaign", () => {
    const orphan = hardActionRec({ campaignId: undefined, campaignName: undefined });
    const { result, guarded } = guard({
      rec: orphan,
      entry: null,
      activeCampaignIds: [],
    });

    expect(result.downgradedCount).toBe(1);
    // Nothing to report as unlabeled: there is no id to report.
    expect(result.unlabeledCampaignIds).toEqual([]);
    expect(guarded.decisionLabel).toBe("scale");
    expect(guarded.decisionState).toBe("watch");
    expect(guarded.confidenceReason).toBe(META_AUTOMATIC_CONTEXT_REVIEW_REASON);
    expect(guarded.campaignContext?.trustedForAction).toBe(false);
    expect(guarded.automationReadiness?.autoExecuteEligible).toBe(false);
  });

  it("holds an account-level hard action while any active campaign role is unresolved", () => {
    const accountRec = hardActionRec({
      id: "budget",
      level: "account",
      campaignId: undefined,
      campaignName: undefined,
      type: "budget_allocation",
      decisionLabel: "scale",
    });
    const { result, guarded } = applyAccountGuard(accountRec);

    expect(result.accountLevelDowngraded).toBe(true);
    expect(guarded.decisionState).toBe("watch");
    // The builder's own label survives; the guard does not overwrite it with a
    // generic one, and does not invent one where the mapper has no case.
    expect(guarded.decisionLabel).toBe("scale");
    expect(guarded.automationReadiness?.autoExecuteEligible).toBe(false);
  });

  function applyAccountGuard(rec: MetaRecommendation) {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [rec],
      campaignLabelsById: null,
      campaignContextById: new Map([[CAMPAIGN_ID, VALIDATED_HIGH]]),
      automaticContextEnabled: true,
      activeCampaignIds: [CAMPAIGN_ID, "cmp-unresolved"],
    });
    return { result, guarded: result.recommendations[0]! };
  }
});

describe("held role edges: the resolver-authority contradiction", () => {
  /*
    THE EDGE THAT USED TO FAIL OPEN.

    The guard's authority test was `contextTrust === "high" && source ===
    "system_inferred"`, and nothing else — while the entry it was reading
    carried `resolverAuthorityValidated`, which the guard consulted only to
    choose the WORDING of a hold it had already decided on other grounds. An
    entry whose two halves disagreed therefore passed through at
    `decisionState: "act"` with `trustedForAction: true`.

    INVARIANTS.md: "High-trust campaign-role semantics require BOTH
    `confidenceClass = high` AND the exact resolver-version authority gate."
  */
  it("does not grant authority to high trust beside an unapproved resolver", () => {
    const { result, guarded } = guard({
      rec: hardActionRec(),
      entry: {
        kind: "main",
        contextTrust: "high",
        source: "system_inferred",
        inferenceConfidenceClass: "high",
        resolverAuthorityValidated: false,
      },
    });

    expect(result.downgradedCount).toBe(1);
    expect(guarded.decisionState).toBe("watch");
    expect(guarded.campaignContext?.trustedForAction).toBe(false);
    expect(guarded.campaignKind).toBeUndefined();
    expect(guarded.confidenceReason).toBe(
      META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
    );
  });

  it("does not let an unapproved resolver mint a promote-to-main flow", () => {
    /*
      The escalation the same hole opened. On a `test` kind the guard re-types a
      scale verdict into `promote_test_to_main` — a Launchpad flow, not just a
      chip — so a role the resolver never earned would have moved budget
      structure, not merely mislabelled a row.
    */
    const { guarded } = guard({
      rec: hardActionRec(),
      entry: {
        kind: "test",
        contextTrust: "high",
        source: "system_inferred",
        inferenceConfidenceClass: "high",
        resolverAuthorityValidated: false,
      },
    });

    expect(guarded.type).toBe("scale_for_volume");
    expect(guarded.id).toBe("rec-held");
    expect(guarded.labelTransform).toBeUndefined();
  });

  it("does not grant authority to high trust beside a non-high confidence class", () => {
    const { result, guarded } = guard({
      rec: hardActionRec(),
      entry: {
        kind: "main",
        contextTrust: "high",
        source: "system_inferred",
        inferenceConfidenceClass: "low",
        resolverAuthorityValidated: true,
      },
    });

    expect(result.downgradedCount).toBe(1);
    expect(guarded.campaignContext?.trustedForAction).toBe(false);
  });

  it.each([
    [
      "no resolver provenance at all",
      { kind: "main", contextTrust: "high", source: "system_inferred" },
    ],
    [
      "an approved resolver but no confidence class",
      {
        kind: "main",
        contextTrust: "high",
        source: "system_inferred",
        resolverAuthorityValidated: true,
      },
    ],
    [
      "a high confidence class but no resolver verdict",
      {
        kind: "main",
        contextTrust: "high",
        source: "system_inferred",
        inferenceConfidenceClass: "high",
      },
    ],
  ] as Array<[string, MetaCampaignContextGuardEntry]>)(
    "refuses authority to an entry with %s",
    (_name, entry) => {
      /*
        MISSING PROVENANCE IS NOT AUTHORIZATION.

        This case used to be asserted the other way round — "absent provenance
        is not a denial" — on the argument that the only runtime producer
        always populates both fields, so an omission must mean a caller that
        carries no resolver provenance rather than one whose provenance failed.
        That argument makes the authority of a hard budget, bid or promotion
        move depend on an invariant enforced in a different module, which is
        the one thing an authority boundary must not do. An entry that says
        less than the resolver says gets less, not the benefit of the doubt.

        `readCampaignContextGuardState` (lib/meta/snapshot.ts) copies both
        fields verbatim from `readCampaignContextMap`, so no production row
        looks like any of these three; what changes is that a replay script, a
        future reader or a payload written before the fields existed can no
        longer unlock kind semantics by omission.
      */
      const { result, guarded } = guard({ rec: hardActionRec(), entry });

      expect(result.downgradedCount).toBe(1);
      expect(guarded.decisionState).toBe("watch");
      expect(guarded.campaignContext?.trustedForAction).toBe(false);
      expect(guarded.campaignKind).toBeUndefined();
    },
  );

  it("does not over-correct: a fully provenanced entry still authorizes", () => {
    /*
      THE CONTROL. A guard that answered "held" to everything would pass every
      assertion above and be useless. All three facts present and agreeing is
      still authority, and the row passes through untouched.
    */
    const approved = guard({ rec: hardActionRec(), entry: VALIDATED_HIGH });
    expect(approved.result.downgradedCount).toBe(0);
    expect(approved.guarded.decisionState).toBe("act");
    expect(approved.guarded.campaignContext?.trustedForAction).toBe(true);
    expect(approved.guarded.campaignKind).toBe("main");
  });

  it("names the missing resolver approval rather than a generic unknown context", () => {
    /*
      The hold has to say what to go and fix. An entry claiming high trust with
      no resolver verdict is missing an APPROVAL, not context — reporting it as
      the generic review-only hold would point the operator at re-running role
      inference, which is not what is absent. `isResolverValidationPending` and
      `isContextTrustedForAction` therefore split on the same `!== true`.
    */
    const { guarded } = guard({
      rec: hardActionRec(),
      entry: { kind: "main", contextTrust: "high", source: "system_inferred" },
    });

    expect(guarded.confidenceReason).toBe(
      META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
    );
    expect(guarded.signalQuality?.campaign_context_action_authority).toBe(
      "resolver_unvalidated",
    );
    expect(
      guarded.evidence.find((item) => item.label === "Campaign context")?.value,
    ).toBe("Automatic high · main · resolver validation pending · review-only");
  });
});

describe("held role edges: what the hold must never rewrite", () => {
  it("keeps a severe stop-loss Cut in every held state", () => {
    /*
      A hold on the ROLE is not a hold on the arithmetic. The contract is
      explicit that an authority hold may close execution and must not erase a
      severe stop-loss verdict — a Cut that comes back as `diagnose` reads as
      "we are not sure", on a campaign the engine concluded is losing money.
    */
    const cutRec = hardActionRec({
      id: "cut",
      level: "adset",
      adsetId: "adset-1",
      adsetName: "Held Ad Set",
      type: "adset_cut_spend",
      lens: "profitability",
      decisionLabel: "cut",
      decision: "Cut spend on this ad set",
      recommendedAction: "Pause this ad set.",
    });

    for (const state of HELD_STATES) {
      const { guarded } = guard({
        rec: cutRec,
        entry: state.entry,
        automaticContextEnabled: state.automaticContextEnabled,
      });
      expect(guarded.decisionLabel, state.name).toBe("cut");
      expect(guarded.recommendedAction, state.name).toBe("Pause this ad set.");
      expect(guarded.decisionState, state.name).toBe("watch");
      expect(guarded.automationReadiness?.autoExecuteEligible, state.name).toBe(false);
    }
  });

  it("keeps the verdict of a hard action that is neither a scale nor a refresh type", () => {
    /*
      `bid_strategy_fit` is in HARD_ACTION_TYPES and in neither of the guard's
      two directional sets, so the guard's narrower reader
      (`explicitOrInferredDecisionLabel`) answered null and the held row went
      out with NO `decisionLabel` at all. The Decision Center's blocked lane
      renders a missing label as the generic "Needs review"
      (`buyerFacingStructureDecisionLabel` in
      components/meta/decision-center/meta-decision-center-exact-adapter.ts), so
      the engine's conclusion — Tune — was erased by the hold on exactly the
      types whose verdict is hardest to guess from the row.
    */
    const tuneRec = hardActionRec({
      id: "bid",
      type: "bid_strategy_fit",
      lens: "profitability",
      decisionLabel: undefined,
      recommendedAction: "Test Cost Cap at the calibrated bid band.",
    });
    expect(decisionLabelForMetaRec(tuneRec)).toBe("tune");

    for (const state of HELD_STATES) {
      const { guarded } = guard({
        rec: tuneRec,
        entry: state.entry,
        automaticContextEnabled: state.automaticContextEnabled,
      });
      expect(guarded.decisionLabel, state.name).toBe("tune");
      expect(guarded.decisionState, state.name).toBe("watch");
    }
  });

  it("gives every held state a reason a reader can tell apart from the others", () => {
    /*
      The anti-collapse assertion, stated as a whole rather than one state at a
      time: two different holds that print the same sentence have told the
      operator the same nothing twice.
    */
    const seen = new Set<string>();
    for (const state of HELD_STATES) {
      const { guarded } = guard({
        rec: hardActionRec(),
        entry: state.entry,
        automaticContextEnabled: state.automaticContextEnabled,
      });
      const contextEvidence = guarded.evidence.find(
        (item) => item.label === "Campaign context",
      );
      expect(contextEvidence, state.name).toBeDefined();
      seen.add(
        `${guarded.confidenceReason}|${guarded.signalQuality?.campaign_context_status}|${contextEvidence!.value}`,
      );
    }
    // One documented collision, named rather than merely counted: `missing map
    // entirely` and `unknown` are the same fact — an absent entry and an entry
    // that resolved to unknown — so they are allowed to read alike. Every other
    // pair must differ, including the two unvalidated-resolver states, which
    // share a reason and an evidence line but report different trust.
    expect(seen.size).toBe(HELD_STATES.length - 1);
    expect([...seen].some((value) => value.includes("conflict"))).toBe(true);
    expect(
      [...seen].some((value) => value.includes("resolver validation pending")),
    ).toBe(true);
  });
});

describe("held role edges: the circuit-breaker fallback", () => {
  /*
    `automaticContextEnabled: false` is `CAMPAIGN_CONTEXT_MODE=unknown`:
    `resolveCampaignContextMode` returns `automatic` for every other value, and
    `readCampaignContextGuardState` passes `mode === "automatic"` through as
    this flag. With role semantics globally off the row must not look
    actionable — and it must still say what was held.
  */
  it("preserves the verdict while writing a non-actionable state row", () => {
    const { result, guarded } = guard({
      rec: hardActionRec(),
      entry: null,
      automaticContextEnabled: false,
    });

    expect(result.downgradedCount).toBe(1);
    expect(guarded.kind).toBe("state");
    expect(guarded.decisionState).toBe("watch");
    expect(guarded.decisionLabel).toBe("scale");
    expect(guarded.confidenceScore).toBeLessThanOrEqual(0.45);
    expect(guarded.automationReadiness?.tier).toBe("read_only");
    expect(guarded.automationReadiness?.autoExecuteEligible).toBe(false);
    expect(guarded.signalQuality).toMatchObject({
      quality_status: "campaign_context_unresolved",
      campaign_context_status: "unavailable",
      campaign_context_action_authority: "review_only",
      blocked_action_type: "scale_for_volume",
      blocked_decision_label: "scale",
      blocked_decision_state: "act",
    });
    // The held verdict is named in the copy an operator actually reads, not
    // only in a signal-quality key.
    expect(guarded.summary).toContain("held Scale verdict");
    expect(guarded.evidence).toEqual(
      expect.arrayContaining([
        { label: "Blocked action", value: "Scale · scale_for_volume", tone: "warning" },
      ]),
    );
  });

  it("stays idempotent when the same row is guarded again", () => {
    const first = guard({
      rec: hardActionRec(),
      entry: null,
      automaticContextEnabled: false,
    }).guarded;
    const second = guard({ rec: first, entry: null, automaticContextEnabled: false });

    expect(second.result.downgradedCount).toBe(0);
    expect(second.guarded.decisionLabel).toBe("scale");
    expect(second.guarded.summary).toBe(first.summary);
    expect(second.guarded.evidence).toEqual(first.evidence);
  });
});

describe("held role edges: the resolver-version gate stays unarmed", () => {
  /*
    D091: "`CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` is deliberately NOT
    armed: its D082 replay quality is accuracy 0.5714 with recall 0, and arming
    it is out of scope." The measured numbers are in the acceptance table of
    docs/audits/D082_META_ROLE_PROVENANCE_REPLAY_2026-09-01.md — overall accuracy
    0.5714 against a 0.90 bar, and a minimum per-class recall of 0 (`mixed`)
    against a 0.80 bar.
  */
  it("is unset in this environment", () => {
    expect(process.env[CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV]).toBeUndefined();
  });

  it("is not read, defaulted or armed anywhere in the guard", () => {
    const source = readFileSync(
      path.join(process.cwd(), "lib/meta/campaign-label-guard.ts"),
      "utf8",
    );
    // Comments are stripped first: the guard QUOTES the invariant that names
    // this gate, and quoting a rule is not arming it. What must be absent is
    // any executable reference.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toContain(CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV);
    // No env read of any kind: the guard cannot arm a gate it cannot see, and
    // cannot be turned into an arming point by a later one-line default.
    expect(code).not.toMatch(/process\s*\.\s*env/);
    // And no edge into the module that owns the gate, so the guard cannot come
    // to depend on it without this test seeing the import appear.
    expect(code).not.toContain("campaign-context/source");
  });

  it("never reports resolver authority the entry did not claim", () => {
    /*
      The guard's job at this gate is to REPORT, not to decide: the approved
      identity is compared byte-for-byte in
      `isCampaignContextResolverAuthorityValidated`
      (lib/creative-decision-engine/campaign-context/source.ts) and arrives here
      as a boolean. Every state that arrives unvalidated must leave
      unvalidated.
    */
    for (const state of HELD_STATES) {
      const { guarded } = guard({
        rec: hardActionRec(),
        entry: state.entry,
        automaticContextEnabled: state.automaticContextEnabled,
      });
      expect(guarded.campaignContext?.trustedForAction, state.name).toBe(false);
      expect(
        guarded.signalQuality?.campaign_context_action_authority,
        state.name,
      ).not.toBe("authoritative");
    }
  });
});

/*
  THE SAME QUESTION, ASKED IN TWO MODULES.

  `isContextTrustedForAction` is the four-fact authority predicate. Its own
  doc comment names `readCampaignContextGuardState` (lib/meta/snapshot.ts) as
  the function that copies these fields verbatim, and argues that a boundary
  which trusts a distant producer's invariant is not a boundary.

  That module was still asking the OLD two-fact question when it built
  `campaignLabelsById`:

      entry.kind && contextTrust === "high" && source === "system_inferred"

  which accepts an entry that simply omits `resolverAuthorityValidated` and
  `inferenceConfidenceClass`. That map is not this guard's authority, but it
  sets `campaignKind` for `buildCalibrationContexts` and the recommendation
  builders, and `campaignKind` selects the test-cohort refresh transform — so
  an entry saying less than the resolver says could still steer a hard
  decision. Both modules now ask the one predicate.
*/
describe("the campaign-role authority predicate has exactly one definition", () => {
  const provenanced: MetaCampaignContextGuardEntry = {
    kind: "main",
    contextTrust: "high",
    source: "system_inferred",
    inferenceConfidenceClass: "high",
    resolverAuthorityValidated: true,
  };

  it("authorizes a fully provenanced entry", () => {
    expect(isContextTrustedForAction(provenanced)).toBe(true);
  });

  it("refuses an entry that passes the old two-fact test but says less", () => {
    // Each of these satisfies `contextTrust === "high" && source ===
    // "system_inferred"` — the whole of the old test — and must still refuse.
    const byOmission: readonly MetaCampaignContextGuardEntry[] = [
      { ...provenanced, resolverAuthorityValidated: undefined },
      { ...provenanced, inferenceConfidenceClass: undefined },
      { ...provenanced, resolverAuthorityValidated: false },
      { ...provenanced, inferenceConfidenceClass: "medium" },
    ];
    for (const entry of byOmission) {
      expect(
        isContextTrustedForAction(entry),
        JSON.stringify({
          resolverAuthorityValidated: entry.resolverAuthorityValidated,
          inferenceConfidenceClass: entry.inferenceConfidenceClass,
        }),
      ).toBe(false);
    }
  });

  /*
    A SOURCE PIN, and named as one.

    `readCampaignContextGuardState` is a private async function reached only
    through a full snapshot read, so proving this at runtime would mean
    standing up the snapshot's whole data layer to observe one Map. This
    codebase already pins a guard by reading its source where the runtime cost
    is out of proportion to the claim; that is what this is. It cannot prove
    the predicate is CORRECT — the two cases above do that — only that
    `snapshot.ts` still delegates instead of re-deriving.
  */
  it("is delegated to, not re-derived, by the snapshot reader", () => {
    const source = readFileSync(
      path.join(process.cwd(), "lib/meta/snapshot.ts"),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).toContain("isContextTrustedForAction");
    // The old inline test must not come back beside the delegation.
    expect(code).not.toMatch(
      /contextTrust\s*===\s*"high"\s*&&\s*\n?\s*source\s*===\s*"system_inferred"/,
    );
  });
});

/*
  CODEX C20/C24 — a provisional role never becomes authority.

  `readAutomaticCampaignRoles` in `app/api/meta/lane-classify/route.ts` copied
  EVERY resolved kind into the map that becomes `campaignKind` on
  recommendations, inventory rows and the action shape. A medium-confidence,
  resolver-unvalidated or review-only role therefore travelled as established
  fact, and no consumer could tell, because the field carries no provenance.

  The structural emitters had the same hole from the other direction: `I4` fired
  on the substring "test" in `${campaignRole} ${campaignName}`.

  All three now ask ONE predicate. These cases pin the permutations at that
  predicate, which is the shared definition; the emitter and route wiring are
  asserted in their own suites.
*/
describe("trust permutations that may and may not bear authority", () => {
  const entry = (
    over: Partial<MetaCampaignContextGuardEntry>,
  ): MetaCampaignContextGuardEntry => ({
    kind: "test",
    contextTrust: "high",
    source: "system_inferred",
    inferenceConfidenceClass: "high",
    resolverAuthorityValidated: true,
    ...over,
  });

  it("authorizes only the fully provenanced entry", () => {
    expect(isContextTrustedForAction(entry({}))).toBe(true);
  });

  it.each([
    ["medium trust", { contextTrust: "medium" as const }],
    ["low trust", { contextTrust: "low" as const }],
    ["unknown trust", { contextTrust: "unknown" as const }],
    ["conflicting trust", { contextTrust: "conflict" as const }],
    ["resolver not validated", { resolverAuthorityValidated: false }],
    ["resolver validation absent", { resolverAuthorityValidated: undefined }],
    ["medium inference", { inferenceConfidenceClass: "medium" as const }],
    ["inference absent", { inferenceConfidenceClass: undefined }],
    ["a user override rather than an inference", { source: "user_override" as const }],
    ["a legacy label", { source: "legacy_label" as const }],
  ])("refuses %s", (_label, over) => {
    expect(isContextTrustedForAction(entry(over))).toBe(false);
  });

  it("refuses an absent entry outright", () => {
    expect(isContextTrustedForAction(null)).toBe(false);
    expect(isContextTrustedForAction(undefined)).toBe(false);
  });
});


/*
  ── A STALE `campaignKind` MAY NOT ESCAPE THE GUARD ─────────────────────────
  `attachCampaignKind` returned the candidate UNCHANGED when the trusted label
  map had no answer for it. That reads as "leave it alone", and it is the wrong
  default at an authority boundary: candidates reach this guard already
  carrying a `campaignKind` — a persisted decision snapshot read back at
  `readMetaDecisionSnapshot`, a rehydrated evaluation row — and that value was
  written under whatever labelling and whatever resolver version was current
  when the snapshot was taken.

  Downstream, `campaignKind` is not decoration. It selects the test-cohort
  refresh transform in this very module (`transformTestRefreshToCut`,
  `labelTransformPayload`), and it is what `lifecycleRole` and the lane router
  in lib/meta/decisions-os-presentation.ts read to place a row as main / test /
  mixed. A remembered "test" therefore turns a Refresh into a Cut on the
  strength of a label the guard just refused to trust.

  Each case below hands the guard a candidate that already claims a kind and an
  entry the four-fact predicate REFUSES, and requires the field to come back
  absent — not preserved, and not silently replaced by "main".
*/
describe("held role edges: a prepopulated campaignKind is not authority", () => {
  const REFUSED_ENTRIES: Array<[string, MetaCampaignContextGuardEntry | null]> = [
    [
      "medium inference confidence",
      { ...VALIDATED_HIGH, inferenceConfidenceClass: "medium" },
    ],
    [
      "an unvalidated resolver identity",
      { ...VALIDATED_HIGH, resolverAuthorityValidated: false },
    ],
    [
      "a resolver that never reported its identity",
      { ...VALIDATED_HIGH, resolverAuthorityValidated: undefined },
    ],
    ["an operator override as the provenance", { ...VALIDATED_HIGH, source: "user_override" }],
    ["medium context trust", { ...VALIDATED_HIGH, contextTrust: "medium" }],
    ["no context entry at all", null],
  ];

  for (const claimed of ["test", "mixed", "main"] as const) {
    it.each(REFUSED_ENTRIES)(
      `drops a prepopulated "${claimed}" kind under %s`,
      (_name, entry) => {
        // The predicate itself refuses this entry; the assertion below is about
        // what the guard then does with the candidate's own field.
        expect(isContextTrustedForAction(entry)).toBe(false);
        const { guarded } = guard({
          rec: hardActionRec({ campaignKind: claimed }),
          entry,
        });
        expect(guarded.campaignKind).toBeUndefined();
        // And no transform was minted off the remembered kind.
        expect(guarded.labelTransform ?? null).toBeNull();
      },
    );
  }

  it("still attaches the kind the trusted map DOES resolve", () => {
    /*
      The control. Without it, "the field comes back absent" would be satisfied
      by a guard that deleted `campaignKind` unconditionally, which would break
      the test-cohort transform for every correctly labelled campaign.
    */
    const { guarded } = guard({
      rec: hardActionRec({ campaignKind: "test" }),
      entry: { ...VALIDATED_HIGH, kind: "main" },
    });
    expect(guarded.campaignKind).toBe("main");
  });

  it("replaces a stale kind with the trusted one rather than preferring the stale one", () => {
    // The direction that a `rec.campaignKind ?? lookup()` fallback gets wrong
    // even when the lookup WOULD have answered: it never asks.
    const { guarded } = guard({
      rec: hardActionRec({ campaignKind: "test" }),
      entry: { ...VALIDATED_HIGH, kind: "mixed" },
    });
    expect(guarded.campaignKind).toBe("mixed");
  });

  it("keeps the account-level rows honest when one active campaign is unlabelled", () => {
    /*
      An account-level hard action takes its kind from EVERY active campaign
      (`campaignIdsForRec`), so one unlabelled campaign makes the answer
      unknown. A remembered kind used to survive exactly that case.
    */
    const { guarded } = guard({
      rec: hardActionRec({
        level: "account",
        campaignId: undefined,
        type: "budget_allocation",
        campaignKind: "main",
      }),
      entry: VALIDATED_HIGH,
      activeCampaignIds: [CAMPAIGN_ID, "cmp-unlabelled"],
    });
    expect(guarded.campaignKind).toBeUndefined();
  });
});

/*
  ── THE SOURCE DIAGNOSTIC, AND WHY IT IS CHECKED AGAINST ITS OWN COUNTEREXAMPLE ─
  A regex that scans source for a forbidden shape is only worth the assertion
  if it actually MATCHES that shape. A diagnostic that quietly matches nothing
  passes on every tree, including one where the boundary has been reopened —
  it "opens authority" by looking like a guard while guarding nothing. So the
  pattern is proven against a literal example of the reopened form BEFORE it is
  used on the real files.
*/
describe("held role edges: the campaignKind trust fallback cannot come back", () => {
  /*
    The CANDIDATE's own kind read as a fallback — `rec.campaignKind ??`,
    `input.rec.campaignKind ??`, `candidate.campaignKind ??`.

    Deliberately not the broader `/\.campaignKind\s*\?\?/`: lane-classify
    normalizes a nullable input to `undefined` when it BUILDS a state row
    (`campaignKind: input.campaignKind ?? undefined`), and that value already
    came from `campaignKindForId(..., campaignLabelsById)` — the trusted map.
    A pattern that flagged it would have had to be deleted the first time it
    fired, which is how a source diagnostic stops being enforced.
  */
  const CAMPAIGN_KIND_FALLBACK =
    /\b(?:rec|recommendation|candidate)\.campaignKind\s*\?\?/;

  const REOPENED = `
    const campaignKind =
      input.rec.campaignKind ??
      campaignKindForRecommendation({ rec: input.rec });
  `;

  it("matches the reopened form, so the scans below are not vacuous", () => {
    expect(CAMPAIGN_KIND_FALLBACK.test(REOPENED)).toBe(true);
  });

  const BOUNDARIES = [
    "lib/meta/campaign-label-guard.ts",
    "app/api/meta/lane-classify/route.ts",
  ] as const;

  it.each(BOUNDARIES)("%s does not read the candidate's own kind as a fallback", (file) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    // Comments are stripped first: both files DESCRIBE the removed fallback,
    // and describing a defect is not committing it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(CAMPAIGN_KIND_FALLBACK.test(code)).toBe(false);
  });
});
