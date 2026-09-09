/**
 * Attaches a sized budget intent to the recommendations that earned one.
 *
 * The producer for budget changes had no sizing step at all, so
 * `meta_decision_snapshots_daily.target_value` never carried a typed intent and
 * the candidate query downstream could never match. This is the seam that fills
 * it: recommendations in, recommendations out, with `targetValue` set on the
 * rows `sizeBudgetChange` sized and left alone on every other.
 *
 * It performs no IO. Everything it needs is gathered once per account by the
 * caller, which is where those reads already happen — a projection that opened
 * its own connections would read a different moment than the decisions it is
 * annotating.
 *
 * What lands in `target_value` is the intent SUMMARY, not the full validated
 * intent: the composite scope, the source fingerprints and the currency
 * registry are known where the proposal is built, not where the decision is
 * made, and inventing them here would be inventing provenance. The contract
 * version is the thing the candidate query matches on, and it cannot be typed
 * by accident the way an English sentence can.
 */
import {
  META_BUDGET_INTENT_CONTRACT_VERSION,
  budgetIntentSemanticTupleForRecommendationType,
  isBudgetIntentSemanticTuple,
} from "@/lib/meta/budget-intent-contract";
import {
  sizeBudgetChange,
  type BudgetSizingInput,
  type BudgetSizingOutcome,
} from "@/lib/meta/budget-sizing-policy";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { decisionLabelForMetaRec } from "@/lib/meta/rec-label-mapping";

/** The per-entity facts the sizing policy needs, gathered by the caller. */
export interface BudgetIntentEntityContext {
  currentMinorUnits: number | null;
  budgetUniverse: BudgetSizingInput["budgetUniverse"];
  isBudgetMixed: boolean;
  funnelCohort: string;
  roleAuthoritySatisfied: boolean;
  maturityOk: boolean;
  roas28d: number | null;
  spend28d: number | null;
  purchases28d: number | null;
  calibrationSampleSize: number | null;
  hoursSinceLastChange: number | null;
  changesLast7d: number | null;
  accountShareBefore: number | null;
  providerBaselineKnown: boolean;
}

export interface BudgetIntentProjectionInput {
  recommendations: MetaRecommendation[];
  targetRoas: number | null;
  breakEvenRoas: number | null;
  /** True only for trusted Target ROAS plus READY same-account Meta AOV. */
  budgetActionAuthority: boolean;
  accountCurrency: string | null;
  policy: BudgetSizingInput["policy"];
  /** Keyed by campaign or ad-set id, whichever the row is about. */
  contextByEntityId: Map<string, BudgetIntentEntityContext>;
}

export interface BudgetIntentProjectionResult {
  recommendations: MetaRecommendation[];
  sized: number;
  /** Withheld reasons by code, so a surface can say why nothing was proposed. */
  withheldByCode: Record<string, number>;
}

function entityIdFor(rec: MetaRecommendation): string | null {
  if (rec.level === "adset") return rec.adsetId?.trim() || null;
  if (rec.level === "campaign") return rec.campaignId?.trim() || null;
  return null;
}

export function projectBudgetIntents(
  input: BudgetIntentProjectionInput,
): BudgetIntentProjectionResult {
  const withheldByCode: Record<string, number> = {};
  let sized = 0;
  /*
    Pause precedence is derived from the same recommendation set this
    projection sizes. Only an executable Cut owns the entity, and the shared
    label mapper covers raw emitters that have not stamped `decisionLabel` yet.
    A caller-supplied set previously counted held Cut rows and missed raw
    actionable Cut rows, producing both false holds and competing intents.
  */
  const pausedEntityIds = new Set(
    input.recommendations
      .filter(
        (rec) =>
          rec.decisionState === "act" && decisionLabelForMetaRec(rec) === "cut",
      )
      .map(entityIdFor)
      .filter((entityId): entityId is string => entityId !== null),
  );

  const recommendations = input.recommendations.map((rec) => {
    if (rec.kind === "anomaly" || rec.kind === "state") return rec;
    // Only an executable decision may acquire a money-moving intent. `test`,
    // `watch`, and legacy rows without a state remain useful explanations, but
    // none of them authorises a budget amount.
    if (rec.decisionState !== "act") return rec;
    const semanticTuple = budgetIntentSemanticTupleForRecommendationType(rec.type);
    if (!semanticTuple) {
      withheldByCode.budget_action_type_ineligible =
        (withheldByCode.budget_action_type_ineligible ?? 0) + 1;
      return rec;
    }
    /*
      Recommendation semantics select the lever before performance selects its
      size. The type and owner grain are one authority tuple: membership in two
      independent allowlists must not cross-pair a campaign decision onto an ad
      set or vice versa.
    */
    if (semanticTuple.grain !== rec.level) {
      withheldByCode.budget_action_semantic_mismatch =
        (withheldByCode.budget_action_semantic_mismatch ?? 0) + 1;
      return rec;
    }
    if (!input.budgetActionAuthority) {
      withheldByCode.commercial_target_unknown =
        (withheldByCode.commercial_target_unknown ?? 0) + 1;
      return rec;
    }
    if (rec.level !== "campaign" && rec.level !== "adset") return rec;
    const entityId = entityIdFor(rec);
    if (!entityId) return rec;
    /*
      An executable Cut already assigns this entity to the pause lever. That
      ownership applies in every ROAS band, not only below break-even: otherwise
      the same Cut could become both a pause and a budget decrease.
    */
    if (pausedEntityIds.has(entityId)) {
      withheldByCode.pause_takes_precedence =
        (withheldByCode.pause_takes_precedence ?? 0) + 1;
      return rec;
    }
    const context = input.contextByEntityId.get(entityId);
    if (!context) return rec;

    const outcome: BudgetSizingOutcome = sizeBudgetChange({
      /*
        The label the shared mapper derives, not the one the row happens to
        carry.

        Producers set `decisionLabel` only sometimes; on a raw scale or cut
        recommendation it is undefined, and `?? null` handed the sizing policy a
        null it refuses before any band is read. Every eligible candidate was
        therefore withheld for want of a label the recommendation's own type
        already determines.
      */
      decisionLabel: decisionLabelForMetaRec(rec),
      roleAuthoritySatisfied: context.roleAuthoritySatisfied,
      budgetUniverse: context.budgetUniverse,
      isBudgetMixed: context.isBudgetMixed,
      funnelCohort: context.funnelCohort,
      currentMinorUnits: context.currentMinorUnits,
      maturityOk: context.maturityOk,
      roas28d: context.roas28d,
      spend28d: context.spend28d,
      purchases28d: context.purchases28d,
      targetRoas: input.targetRoas,
      breakEvenRoas: input.breakEvenRoas,
      calibrationSampleSize: context.calibrationSampleSize,
      pauseProduced: pausedEntityIds.has(entityId),
      // Below break-even with no pause produced is the only state in which a
      // reduction may be considered, and it still has to pass every gate.
      pauseWithheld: !pausedEntityIds.has(entityId),
      policy: input.policy,
      accountCurrency: input.accountCurrency,
      hoursSinceLastChange: context.hoursSinceLastChange,
      changesLast7d: context.changesLast7d,
      accountShareBefore: context.accountShareBefore,
      providerBaselineKnown: context.providerBaselineKnown,
    });

    if (outcome.status === "withheld") {
      withheldByCode[outcome.code] = (withheldByCode[outcome.code] ?? 0) + 1;
      return rec;
    }

    if (!isBudgetIntentSemanticTuple({
      recommendationType: rec.type,
      grain: rec.level,
      direction: outcome.direction,
    })) {
      withheldByCode.budget_action_semantic_mismatch =
        (withheldByCode.budget_action_semantic_mismatch ?? 0) + 1;
      return rec;
    }

    sized += 1;
    return {
      ...rec,
      targetValue: {
        contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
        direction: outcome.direction,
        percent: outcome.percent,
        amountMinor: outcome.proposedMinorUnits,
        currentMinorUnits: context.currentMinorUnits,
        sizingPolicyVersion: outcome.policyVersion,
        // The band, the ratio and every clamp that moved the rung. The card
        // shows this instead of a bare percentage, because "15%" is not a
        // reason and a constraint is not evidence for an amount.
        rationale: outcome.rationale,
      },
    } satisfies MetaRecommendation;
  });

  return { recommendations, sized, withheldByCode };
}
