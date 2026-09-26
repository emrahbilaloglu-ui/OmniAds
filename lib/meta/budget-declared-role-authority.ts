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
 * - Knowledge is bounded twice, by two different instants (D121 C1). On the
 *   decision's day the declaration must have been recorded by the DECISION's
 *   own instant (or the reading run's start, whichever is earlier): a
 *   statement recorded after a decision — even one back-dated to take effect
 *   on the decision's day — was never what that decision rested on. On the
 *   proposal's day it must still be in force, with the same role, as recorded
 *   by the reading run's start, so a revoke or change recorded before the run
 *   stops the proposal.
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
 * caller fall back to the automatic route, and only for a CAMPAIGN budget (an
 * ad set has no automatic role of its own): every other code means a
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
  /** The record in force on the proposal's day. */
  declarationId: string;
  declaredAt: string;
  effectiveFrom: string;
  /** The record the DECISION rested on, and that decision's own instant. */
  decisionDeclarationId: string;
  decisionDeclaredAt: string;
  decidedAt: string;
  /** The proposal run's knowledge bound. */
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
  /** The instant the persisted decision was recorded. */
  decidedAt: string;
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
  const recordedByMs = Date.parse(request.recordedBy);
  const decidedAtMs = Date.parse(request.decidedAt);
  if (!Number.isFinite(recordedByMs) || !Number.isFinite(decidedAtMs)) {
    return refuse("declaration_knowledge_bound_invalid");
  }
  const scope = {
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    entityType: request.ownerGrain,
    entityId: request.entityId,
  };
  // What the decision could have known: nothing recorded after it was made,
  // nor after the run that reads it began.
  const onDecisionDay = selectActiveEntityRoleDeclaration(events, {
    ...scope,
    asOf: request.decisionDay,
    visibleAtCutoff: decidedAtMs <= recordedByMs ? request.decidedAt : request.recordedBy,
  });
  // What is true now: the reading run's own knowledge, revokes included.
  const onProposalDay = selectActiveEntityRoleDeclaration(events, {
    ...scope,
    asOf: request.proposalDay,
    visibleAtCutoff: request.recordedBy,
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
      decisionDeclarationId: onDecisionDay.id,
      decisionDeclaredAt: onDecisionDay.declaredAt,
      decidedAt: request.decidedAt,
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
    /** The persisted decision's own instant, as the composition holds it. */
    decidedAt: string | null;
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
  // The decision it would authorise must be THIS proposal's decision, and
  // the record that decision rested on must predate it.
  if (scope.decidedAt === null || authority.decidedAt !== scope.decidedAt) return false;
  const decidedAtMs = Date.parse(authority.decidedAt);
  const decisionDeclaredMs = Date.parse(authority.decisionDeclaredAt);
  const declaredMs = Date.parse(authority.declaredAt);
  const recordedByMs = Date.parse(authority.recordedBy);
  return (
    Number.isFinite(decidedAtMs) &&
    Number.isFinite(decisionDeclaredMs) &&
    Number.isFinite(declaredMs) &&
    Number.isFinite(recordedByMs) &&
    decisionDeclaredMs <= decidedAtMs &&
    decisionDeclaredMs <= recordedByMs &&
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
