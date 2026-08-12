/**
 * Server-side resolution of a served decision into an exact provider target.
 *
 * The canonical write ceremony sends an opaque decision key and an allowlisted
 * action. It sends no account, no entity id, and no expected state. Everything
 * the provider write will be aimed at is derived here, from the warehouse, in
 * the authorized business — because a client that can name its own target can
 * name somebody else's, and a client that can name its own expected state can
 * name one that makes a stale write look fresh.
 *
 * D065 frames what this is and is not. This resolves a **manual_operator_v1**
 * target: the exact server-presented provider account and entity behind a
 * decision the operator is looking at. It does not manufacture native decision
 * authority — the decision supplies the *identity* to act on, never the
 * permission to act, and no native decision-lineage field passes through here.
 */

/** Wire name of the decision-bound preflight contract. */
export const ZERO_BASE_DECISION_CONTRACT = "zero-base.decision.v1";

/** Grains a provider write may be aimed at. */
export const DECISION_BOUND_GRAINS = ["campaign", "adset", "ad"] as const;
export type DecisionBoundGrain = (typeof DECISION_BOUND_GRAINS)[number];

/**
 * Body fields the decision-bound mode refuses outright.
 *
 * Not ignored — refused. A caller that believed it had named the target would
 * otherwise get a pass it did not earn against a target it did not choose.
 */
export const FORBIDDEN_BODY_FIELDS = [
  "providerAccountId",
  "entityId",
  "entityType",
  "expectedStatus",
  "expectedCreativeId",
  "expectedParentId",
] as const;

export interface ParsedDecisionKey {
  grain: DecisionBoundGrain;
  entityId: string;
}

/**
 * Parse a served decision key into a grain and provider entity id.
 *
 * The served universe also contains keys that are not provider-actionable at
 * all — `inactive:*` rows, `group:*` aggregates, `structure-*` findings. They
 * return null rather than being coerced into a target: a grouped decision has
 * no single entity to act on, and acting on one member of it would be a write
 * nobody reviewed.
 */
export function parseDecisionKey(decisionKey: string): ParsedDecisionKey | null {
  const match = /^(campaign|adset|ad):(.+)$/.exec(decisionKey.trim());
  if (!match) return null;
  const entityId = match[2].trim();
  // `campaign:unknown:<id>` is the presentation's own marker for a row whose
  // provider identity was never resolved.
  if (!entityId || entityId.startsWith("unknown:")) return null;
  return { grain: match[1] as DecisionBoundGrain, entityId };
}

export const GRAIN_SOURCE: Record<
  DecisionBoundGrain,
  { table: string; idColumn: string; statusColumn: string; parentColumn: string | null }
> = {
  campaign: {
    table: "meta_campaign_dimensions",
    idColumn: "campaign_id",
    statusColumn: "campaign_status",
    parentColumn: null,
  },
  adset: {
    table: "meta_adset_dimensions",
    idColumn: "adset_id",
    statusColumn: "adset_status",
    parentColumn: "campaign_id",
  },
  ad: {
    table: "meta_ad_dimensions",
    idColumn: "ad_id",
    statusColumn: "ad_status",
    parentColumn: "adset_id",
  },
};

export type DecisionBoundRefusal =
  | "decision_not_actionable"
  | "decision_not_in_served_universe"
  | "provider_account_not_assigned"
  | "target_ambiguous"
  | "warehouse_unavailable"
  | "unsupported_action";

export const REFUSAL_MESSAGE: Record<DecisionBoundRefusal, string> = {
  decision_not_actionable:
    "This decision does not name a single campaign, ad set or ad, so there is nothing to act on.",
  decision_not_in_served_universe:
    "This decision was not found in this business, so no provider target could be proven.",
  provider_account_not_assigned:
    "The account behind this decision is not assigned to this business.",
  target_ambiguous:
    "More than one warehouse row matches this identity, so the exact target is not proven.",
  warehouse_unavailable:
    "Provider state is unavailable, so the target could not be verified.",
  unsupported_action: "That action is not available at this grain.",
};

export interface ResolvedDecisionTarget {
  grain: DecisionBoundGrain;
  entityId: string;
  providerAccountId: string;
  /** Live persisted state. The expected state is derived from this, never sent. */
  status: string | null;
  creativeId: string | null;
  parentId: string | null;
  matchCount: number;
}
