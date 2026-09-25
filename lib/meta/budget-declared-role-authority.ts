/**
 * D121 — declared role authority for a budget PROPOSAL.
 *
 * D118 made campaign and ad set roles separate, explicitly declared entities,
 * but the budget lane (D081/D085/D088) still admitted only automatic role
 * authority, keyed by CAMPAIGN even for an ad set's money. This module is the
 * second, separately versioned route: the operator's own declaration for the
 * entity whose budget moves.
 *
 * - A campaign budget reads the CAMPAIGN's declaration.
 * - An ad set budget reads the AD SET's declaration, and only while the ad set
 *   still sits under the campaign it was declared under. The campaign's role
 *   is never the ad set's: a Main campaign can run a Test ad set.
 * - Knowledge is bounded twice. A declaration counts only if it was recorded
 *   by the instant the reading run began, and only if it is in force both on
 *   the decision's own day and on the proposal's day, with the same role —
 *   so the recommendation and the proposal rest on the same statement, and a
 *   revoke or a change recorded before the run stops the proposal.
 *
 * It grants nothing on its own: the composition root admits it for a
 * PROPOSAL only (`composeBudgetProposalCandidate`). Execution re-reads role
 * authority independently and remains automatic-only.
 */
import {
  ENTITY_ROLE_DECLARATION_CONTRACT_VERSION,
  isDeclarableRole,
  readEntityRoleDeclarationEvents,
  selectActiveEntityRoleDeclaration,
  type DeclaredRole,
  type EntityRoleDeclarationEvent,
} from "@/lib/creative-decision-engine/campaign-context/entity-role";

export const BUDGET_DECLARED_ROLE_AUTHORITY_CONTRACT =
  "meta.budget-declared-role-authority.v1" as const;

/**
 * Why a declared route did not bind. Only `declaration_absent` lets the
 * caller fall back to the automatic route: every other code means a
 * declaration governs this entity and does not cleanly authorise this
 * proposal, so nothing else may stand in for it.
 */
export const BUDGET_DECLARED_ROLE_REFUSALS = [
  "declaration_absent",
  "declaration_knowledge_bound_invalid",
  "declaration_not_in_force_on_decision_day",
  "declaration_withdrawn_since_decision_day",
  "declaration_changed_since_decision_day",
  "adset_parent_unknown",
  "adset_declaration_parent_mismatch",
] as const;
export type BudgetDeclaredRoleRefusal = (typeof BUDGET_DECLARED_ROLE_REFUSALS)[number];

export interface DeclaredBudgetRoleAuthority {
  contract: typeof BUDGET_DECLARED_ROLE_AUTHORITY_CONTRACT;
  /** The declaration record's own contract. */
  declarationContract: string;
  role: DeclaredRole;
  entityGrain: "campaign" | "adset";
  entityId: string;
  /** The campaign the role binds under: the campaign itself, or the ad set's parent. */
  campaignId: string;
  declarationId: string;
  declaredAt: string;
  effectiveFrom: string;
  /** The knowledge bound the declaration was read under. */
  recordedBy: string;
}

export type DeclaredBudgetRoleResolution =
  | { status: "declared"; authority: DeclaredBudgetRoleAuthority }
  | { status: "none"; refusal: BudgetDeclaredRoleRefusal };

export interface DeclaredBudgetRoleRequest {
  businessId: string;
  providerAccountId: string;
  ownerGrain: "campaign" | "adset";
  entityId: string;
  /** Required for an ad set; ignored for a campaign. */
  parentCampaignId: string | null;
  /** The day the persisted decision was computed for. */
  decisionDay: string;
  /** The day this proposal is composed as of. */
  proposalDay: string;
  /** The instant the reading run began. Later records are not its knowledge. */
  recordedBy: string;
}

const refuse = (refusal: BudgetDeclaredRoleRefusal): DeclaredBudgetRoleResolution => ({
  status: "none",
  refusal,
});

/** Pure: which declaration, if any, authorises this proposal's role. */
export function resolveDeclaredBudgetRoleAuthority(
  request: DeclaredBudgetRoleRequest,
  events: readonly EntityRoleDeclarationEvent[],
): DeclaredBudgetRoleResolution {
  if (!Number.isFinite(Date.parse(request.recordedBy))) {
    return refuse("declaration_knowledge_bound_invalid");
  }
  const scope = {
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    entityType: request.ownerGrain,
    entityId: request.entityId,
    visibleAtCutoff: request.recordedBy,
  };
  const onDecisionDay = selectActiveEntityRoleDeclaration(events, {
    ...scope,
    asOf: request.decisionDay,
  });
  const onProposalDay = selectActiveEntityRoleDeclaration(events, {
    ...scope,
    asOf: request.proposalDay,
  });
  if (!onDecisionDay && !onProposalDay) return refuse("declaration_absent");
  if (!onDecisionDay) return refuse("declaration_not_in_force_on_decision_day");
  if (!onProposalDay) return refuse("declaration_withdrawn_since_decision_day");
  if (onDecisionDay.declaredRole !== onProposalDay.declaredRole) {
    return refuse("declaration_changed_since_decision_day");
  }
  // `selectActiveEntityRoleDeclaration` returns only a declare event whose
  // role this entity type can hold, for this exact scope and contract.
  const declaration = onProposalDay;
  let campaignId: string;
  if (request.ownerGrain === "adset") {
    const parent = request.parentCampaignId ?? "";
    if (parent === "") return refuse("adset_parent_unknown");
    // Both days' records must name the placement this proposal is about.
    if (
      declaration.parentCampaignId !== parent ||
      onDecisionDay.parentCampaignId !== parent
    ) {
      return refuse("adset_declaration_parent_mismatch");
    }
    campaignId = parent;
  } else {
    campaignId = request.entityId;
  }
  return {
    status: "declared",
    authority: {
      contract: BUDGET_DECLARED_ROLE_AUTHORITY_CONTRACT,
      declarationContract: declaration.contractVersion,
      role: declaration.declaredRole!,
      entityGrain: request.ownerGrain,
      entityId: request.entityId,
      campaignId,
      declarationId: declaration.id,
      declaredAt: declaration.declaredAt,
      effectiveFrom: declaration.effectiveFrom,
      recordedBy: request.recordedBy,
    },
  };
}

/**
 * True only for an authority this module produced for exactly this proposal
 * scope. The composition root re-checks it rather than trusting the loader.
 */
export function declaredBudgetRoleBindsScope(
  authority: DeclaredBudgetRoleAuthority | null | undefined,
  scope: {
    ownerGrain: "campaign" | "adset";
    entityId: string;
    parentCampaignId: string | null;
    knowledgeMs: number;
  },
): boolean {
  if (!authority || typeof authority !== "object") return false;
  if (authority.contract !== BUDGET_DECLARED_ROLE_AUTHORITY_CONTRACT) return false;
  if (authority.declarationContract !== ENTITY_ROLE_DECLARATION_CONTRACT_VERSION) return false;
  if (authority.entityGrain !== scope.ownerGrain) return false;
  if (authority.entityId !== scope.entityId) return false;
  if (!isDeclarableRole(authority.entityGrain, authority.role)) return false;
  const expectedCampaign =
    scope.ownerGrain === "campaign" ? scope.entityId : (scope.parentCampaignId ?? "");
  if (expectedCampaign === "" || authority.campaignId !== expectedCampaign) return false;
  const declaredMs = Date.parse(authority.declaredAt);
  const recordedByMs = Date.parse(authority.recordedBy);
  return (
    Number.isFinite(declaredMs) &&
    Number.isFinite(recordedByMs) &&
    declaredMs <= recordedByMs &&
    recordedByMs <= scope.knowledgeMs
  );
}

/** Reads the governing entity's declaration events and resolves them. */
export async function readDeclaredBudgetRoleAuthority(
  request: DeclaredBudgetRoleRequest,
): Promise<DeclaredBudgetRoleResolution> {
  if (!Number.isFinite(Date.parse(request.recordedBy))) {
    return refuse("declaration_knowledge_bound_invalid");
  }
  const latestDay =
    request.decisionDay > request.proposalDay ? request.decisionDay : request.proposalDay;
  const events = await readEntityRoleDeclarationEvents({
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    entityType: request.ownerGrain,
    entityIds: [request.entityId],
    asOf: latestDay,
    visibleAtCutoff: request.recordedBy,
  });
  return resolveDeclaredBudgetRoleAuthority(request, events);
}
