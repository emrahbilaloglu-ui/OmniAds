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
import { META_BUDGET_INTENT_CONTRACT_VERSION } from "@/lib/meta/budget-intent-contract";
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
  accountCurrency: string | null;
  policy: BudgetSizingInput["policy"];
  /** Keyed by campaign or ad-set id, whichever the row is about. */
  contextByEntityId: Map<string, BudgetIntentEntityContext>;
  /** Entity ids for which a pause was produced in this same run. */
  pausedEntityIds: Set<string>;
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

  const recommendations = input.recommendations.map((rec) => {
    if (rec.kind === "anomaly" || rec.kind === "state") return rec;
    if (rec.level !== "campaign" && rec.level !== "adset") return rec;
    const entityId = entityIdFor(rec);
    if (!entityId) return rec;
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
      pauseProduced: input.pausedEntityIds.has(entityId),
      // Below break-even with no pause produced is the only state in which a
      // reduction may be considered, and it still has to pass every gate.
      pauseWithheld: !input.pausedEntityIds.has(entityId),
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
