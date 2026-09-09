/**
 * WHAT THE SERVER OFFERS TO APPLY, AT EVERY CAMPAIGN-CONTEXT STATE.
 *
 * `applyMetaCampaignLabelGuard` holds a hard action whose campaign role is
 * unresolved: it rewrites `decisionState` to "watch", caps confidence, stamps
 * `campaign_context_action_authority` and adds the readiness blocker. What it
 * deliberately does NOT do is remove `proposedAction` or `targetValue` — the
 * held verdict has to stay legible, which is the D091 rule. So the row that
 * comes out of the hold still names a pause, a resume or a bid, and
 * `serverOperatorApplyForRec` used to re-derive that verb and serve it.
 *
 * The result was a payload that held the row and offered a way to execute it in
 * the same response. One renderer hid the control — `MetaPlatformPage` drops
 * the manual action for anything in the needs-resolution lane — but that is a
 * rendering decision on one surface: `operatorApply` still travelled in the
 * API response, `decisions-workspace/route.ts` still counted it in the
 * executable census, and the mobile card path reads the same field. Client-side
 * blocking is not the gate.
 *
 * This file is the complete matrix. Every case drives the REAL guard and the
 * REAL annotation, and the bid amount comes from the REAL bid projection rather
 * than being restated, because the defect lived in the collaboration between
 * them and not in any one of them.
 */
import { describe, expect, it } from "vitest";

import { BID_SIZING_POLICY_VERSION } from "@/lib/meta/bid-sizing-policy";
import { projectBidIntents } from "@/lib/meta/bid-intent-projection";
import {
  META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
  META_AUTOMATIC_CONTEXT_REVIEW_REASON,
  META_CAMPAIGN_LABEL_GUARD_REASON,
  applyMetaCampaignLabelGuard,
  type MetaCampaignContextGuardEntry,
} from "@/lib/meta/campaign-label-guard";
import {
  annotateMetaRecPresentation,
  operatorApplyWithheldReasonForRec,
  serverOperatorApplyForRec,
} from "@/lib/meta/rec-presentation";
import type {
  MetaRecommendation,
  MetaRecOperatorApply,
} from "@/lib/meta/recommendations";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "120210000000000001";
const ADSET_ID = "120210000000000002";

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec-matrix",
    level: "adset",
    campaignId: CAMPAIGN_ID,
    campaignName: "Main · Prospecting",
    adsetId: ADSET_ID,
    adsetName: "Broad 25-54",
    type: "adset_cut_spend",
    kind: "recommendation",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.88,
    confidenceReason: null,
    decisionState: "act",
    decision: "Cut spend",
    title: "Cut spend",
    why: "Below the loss floor.",
    summary: "Cut it.",
    recommendedAction: "Pause this ad set.",
    expectedImpact: "Stops the bleed.",
    evidence: [],
    timeframeContext: {
      coreVerdict: "",
      selectedRangeOverlay: "",
      historicalSupport: "",
      seasonalityFlag: "none",
      note: null,
    },
    ...overrides,
  } as MetaRecommendation;
}

/**
 * The real bid intent, sized by the real projection.
 *
 * Restating a `targetValue` literal here would test the shape of a fixture.
 * `executableBidIntentMinorUnits` refuses anything whose contract version,
 * authority status, blocker list or two amounts disagree, so the only way to
 * prove the derived path is actually reachable — and therefore actually worth
 * gating — is to let the projection write it. 1200 -> 1320 is the policy's 10%
 * raise band for a delivery-constrained cost-cap ad set.
 */
function sizedBidRec(): MetaRecommendation {
  const result = projectBidIntents({
    // B1 is the one recommendation vocabulary that explicitly authorises a
    // currency bid-amount increase. This synthetic ad-set row exercises the
    // forward contract; today's real B1 emitter is campaign-grain and therefore
    // cannot produce a live bid write.
    recommendations: [rec({
      id: "rec-matrix-bid",
      type: "scenario_b1_capped_winner_bid_raise",
    })],
    businessId: BUSINESS,
    providerAccountId: "act_1",
    spendUnitMinor: 1000,
    bidActionAuthority: true,
    accountCurrency: "USD",
    policy: {
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 3,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    },
    contextByAdsetId: new Map([
      [
        ADSET_ID,
        {
          bidStrategyType: "cost_cap",
          currentBidMinor: 1200,
          spend28d: 4200,
          purchases28d: 500,
          maturityOk: true,
          deliveryConstrained: true,
          hoursSinceLastChange: 48,
          changesLast7d: 0,
          parentCampaignId: CAMPAIGN_ID,
        },
      ],
    ]),
    budgetChangedAdsetIds: new Set(),
    originDate: "2026-09-05",
    effectiveAsOf: "2026-09-04",
    knowledgeAsOf: "2026-09-05T03:12:00.000Z",
    evidenceWindow: { from: "2026-08-09", to: "2026-09-05" },
  });
  expect(result.sized).toBe(1);
  return result.recommendations[0]!;
}

interface ActionCase {
  /** Test name. */
  name: string;
  candidate: () => MetaRecommendation;
  /** What an AUTHORIZED row must offer. */
  offered: MetaRecOperatorApply;
}

/*
  Every verb the contract can carry, at every grain that has an endpoint.

  `MetaRecOperatorApply` is pause/resume at campaign or ad-set grain and bid at
  ad-set grain only, so these five cases are the whole surface. The bid case
  carries NO `proposedAction`: the projection attaches an intent to
  `targetValue` and `proposedActionForRecommendation` re-derives the verb from
  it, which is the exact path that survived the hold.
*/
const ACTION_CASES: ActionCase[] = [
  {
    name: "pause at ad-set grain",
    candidate: () => rec({ type: "adset_cut_spend", proposedAction: { kind: "pause" } }),
    offered: { action: "pause", grain: "adset", entityId: ADSET_ID },
  },
  {
    name: "resume at ad-set grain",
    candidate: () =>
      rec({ type: "adset_scale_budget", proposedAction: { kind: "resume" } }),
    offered: { action: "resume", grain: "adset", entityId: ADSET_ID },
  },
  {
    name: "pause at campaign grain",
    candidate: () =>
      rec({
        level: "campaign",
        adsetId: undefined,
        type: "scale_for_profitability",
        proposedAction: { kind: "pause" },
      }),
    offered: { action: "pause", grain: "campaign", entityId: CAMPAIGN_ID },
  },
  {
    name: "resume at campaign grain",
    candidate: () =>
      rec({
        level: "campaign",
        adsetId: undefined,
        type: "scale_for_volume",
        proposedAction: { kind: "resume" },
      }),
    offered: { action: "resume", grain: "campaign", entityId: CAMPAIGN_ID },
  },
  {
    name: "bid at ad-set grain, derived from the sized intent",
    candidate: sizedBidRec,
    offered: {
      action: "bid",
      grain: "adset",
      entityId: ADSET_ID,
      bidAmountMinor: 1320,
    },
  },
];

interface ContextCase {
  name: string;
  entry: MetaCampaignContextGuardEntry | null;
  automaticContextEnabled?: boolean;
  /** The typed reason the row offers nothing, or null when it is authorized. */
  withheld:
    | "condition_row"
    | "campaign_role_unresolved"
    | "campaign_role_resolver_unvalidated"
    | null;
}

/*
  Every campaign-context state the guard can see.

  `readCampaignContextMap` (lib/creative-decision-engine/campaign-context/source.ts)
  derives trust from a persisted confidence class, a byte-exact
  `system_inferred` origin and a byte-exact approved resolver identity. Only all
  three together produce authority; anything less lands on medium/low/unknown/
  conflict, a campaign with no row is filled in as unknown, and
  `CAMPAIGN_CONTEXT_MODE=unknown` turns the whole mechanism off.
*/
const CONTEXT_CASES: ContextCase[] = [
  {
    name: "resolved: high trust, automatic origin, approved resolver",
    entry: {
      kind: "main",
      contextTrust: "high",
      source: "system_inferred",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: true,
    },
    withheld: null,
  },
  {
    name: "high inference, resolver identity not approved",
    entry: {
      kind: "main",
      contextTrust: "medium",
      source: "system_inferred",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: false,
    },
    withheld: "campaign_role_resolver_unvalidated",
  },
  {
    name: "high trust contradicted by an unapproved resolver",
    entry: {
      kind: "main",
      contextTrust: "high",
      source: "system_inferred",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: false,
    },
    withheld: "campaign_role_resolver_unvalidated",
  },
  {
    // The Item-3 boundary: a high-trust claim carrying no resolver provenance
    // at all. Missing provenance is not authorization.
    name: "high trust with no resolver provenance",
    entry: { kind: "main", contextTrust: "high", source: "system_inferred" },
    withheld: "campaign_role_resolver_unvalidated",
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
    withheld: "campaign_role_unresolved",
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
    withheld: "campaign_role_unresolved",
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
    withheld: "campaign_role_unresolved",
  },
  {
    name: "conflict",
    entry: {
      kind: null,
      contextTrust: "conflict",
      source: "unknown",
      inferenceConfidenceClass: "conflict",
      resolverAuthorityValidated: false,
    },
    withheld: "campaign_role_unresolved",
  },
  {
    name: "no context entry for this campaign",
    entry: null,
    withheld: "campaign_role_unresolved",
  },
  {
    // `CAMPAIGN_CONTEXT_MODE=unknown`: role semantics are globally off and the
    // guard writes a state row, which is a condition rather than a change.
    name: "automatic context disabled entirely",
    entry: null,
    automaticContextEnabled: false,
    withheld: "condition_row",
  },
];

/** The production path: guard, then the server-owned annotation. */
function serve(candidate: MetaRecommendation, context: ContextCase) {
  const { recommendations } = applyMetaCampaignLabelGuard({
    recommendations: [candidate],
    campaignLabelsById: null,
    campaignContextById: context.entry
      ? new Map([[CAMPAIGN_ID, context.entry]])
      : new Map(),
    automaticContextEnabled: context.automaticContextEnabled ?? true,
    activeCampaignIds: [CAMPAIGN_ID],
  });
  return annotateMetaRecPresentation(recommendations)[0]!;
}

describe("operator apply authority matrix", () => {
  for (const action of ACTION_CASES) {
    for (const context of CONTEXT_CASES) {
      const expectation = context.withheld === null ? "offers" : "withholds";
      it(`${expectation} ${action.name} when the role is ${context.name}`, () => {
        const served = serve(action.candidate(), context);

        expect(operatorApplyWithheldReasonForRec(served)).toBe(context.withheld);
        expect(served.operatorApply ?? null).toEqual(
          context.withheld === null ? action.offered : null,
        );

        if (context.withheld !== null) {
          // The hold is not a deletion. D091: the mathematical verdict and its
          // specific held reason stay visible; only execution authority closes.
          // The named verb is still on the row — which is precisely why the
          // capability has to be gated rather than assumed absent.
          expect(served.proposedAction ?? served.targetValue).toBeDefined();
        }
      });
    }
  }

  it("never offers a bid at campaign grain, in any campaign-context state", () => {
    /*
      The negative control that is not about the hold. A campaign-grain bid has
      no provider endpoint, so it must be absent from an AUTHORIZED row too —
      otherwise every "withholds" assertion above would pass on a function that
      simply never offers a bid.
    */
    for (const context of CONTEXT_CASES) {
      const served = serve(
        rec({
          id: "rec-matrix-campaign-bid",
          level: "campaign",
          adsetId: undefined,
          type: "bid_value_guidance",
          proposedAction: { kind: "apply_bid", bidAmountMinor: 1320 },
        }),
        context,
      );
      expect(served.operatorApply ?? null, context.name).toBeNull();
    }
  });
});

describe("the gate reads the row, not the pipeline that produced it", () => {
  /*
    A persisted payload can reach `annotateMetaRecPresentation` without the
    guard having just run over it — `lane-classify` annotates what it read.
    The hold is written into three independent places on the row, so each one
    closes the capability on its own.
  */
  const executable = {
    level: "adset" as const,
    campaignId: CAMPAIGN_ID,
    adsetId: ADSET_ID,
    proposedAction: { kind: "pause" as const },
  };

  it("offers the verb when the row carries no hold at all", () => {
    expect(serverOperatorApplyForRec(rec(executable))).toEqual({
      action: "pause",
      grain: "adset",
      entityId: ADSET_ID,
    });
  });

  it.each([
    [
      "the signal-quality authority key",
      { signalQuality: { campaign_context_action_authority: "review_only" } },
      "campaign_role_unresolved",
    ],
    [
      "the resolver-unvalidated authority key",
      {
        signalQuality: {
          campaign_context_action_authority: "resolver_unvalidated",
        },
      },
      "campaign_role_resolver_unvalidated",
    ],
    [
      "the confidence reason alone",
      { confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON },
      "campaign_role_unresolved",
    ],
    [
      "the resolver-unvalidated confidence reason alone",
      { confidenceReason: META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON },
      "campaign_role_resolver_unvalidated",
    ],
    [
      "the readiness blocker alone",
      {
        automationReadiness: {
          contractVersion: "meta-automation-readiness.v1" as const,
          tier: "manual_review" as const,
          autoExecuteEligible: false,
          operatorReviewRequired: true,
          decisionLabel: "cut" as const,
          blockers: ["campaign_context_unresolved" as const],
          missingEvidence: [],
          requiredEvidence: [],
          reason: "held",
        },
      },
      "campaign_role_unresolved",
    ],
    [
      "the pre-D074b unlabeled-role reason on a persisted payload",
      { confidenceReason: META_CAMPAIGN_LABEL_GUARD_REASON },
      "campaign_role_unlabeled",
    ],
    [
      // The shape 11,635 persisted rows actually carry: the legacy hold lives
      // in signal quality, not in `confidenceReason`.
      "the pre-D074b confidence cap on a persisted payload",
      { signalQuality: { confidence_cap: META_CAMPAIGN_LABEL_GUARD_REASON } },
      "campaign_role_unlabeled",
    ],
  ] as Array<[string, Partial<MetaRecommendation>, string]>)(
    "withholds it on %s",
    (_name, hold, reason) => {
      const held = rec({ ...executable, ...hold });
      expect(operatorApplyWithheldReasonForRec(held)).toBe(reason);
      expect(serverOperatorApplyForRec(held)).toBeNull();
    },
  );

  it("does not read the engine's own automation verdict as an operator hold", () => {
    /*
      The over-correction this must not become. `operatorApply` exists BECAUSE
      the engine withholds its own authority from every campaign and ad-set
      row: `serverActionKindForRec` returns `review_drill` for all of them, and
      `automationReadiness` carries the programmatic evidence blockers on
      essentially every row in the account. Gating on those would delete the
      operator capability rather than gate it, and the media buyer would be
      back in a second browser tab.
    */
    const engineBlocked = rec({
      ...executable,
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "cut",
        blockers: [
          "missing_controlled_causal_evidence",
          "missing_valid_random_assignment",
          "no_empirical_outcome_model",
          "missing_live_preflight",
        ],
        missingEvidence: ["live_preflight"],
        requiredEvidence: ["commercial_anchor", "live_preflight"],
        reason: "Live preflight is required before execution.",
      },
    });

    expect(operatorApplyWithheldReasonForRec(engineBlocked)).toBeNull();
    expect(serverOperatorApplyForRec(engineBlocked)).toEqual({
      action: "pause",
      grain: "adset",
      entityId: ADSET_ID,
    });
  });
});
