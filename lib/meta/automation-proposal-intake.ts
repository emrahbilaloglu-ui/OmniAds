/**
 * The intake seam between the rules engine and the confirmation queue.
 *
 * The rules engine owns one half of the design's safety sentence — "rules never
 * write directly — they raise proposals into the confirmation queue". This
 * module is the seam, and it is deliberately narrow:
 *
 *   - `AutomationProposalDraft` is what a firing hands over. It is data only.
 *   - `AutomationProposalSink` is how it is handed over. The engine takes one
 *     as a parameter; it never reaches for a global.
 *   - `persistAutomationRuleProposal` is the default sink. It inserts one
 *     `pending` row into `meta_automation_proposals` — the SAME table the
 *     engine's snapshot projection writes and the same one the queue reads —
 *     and nothing else. It performs no provider call, and it cannot: nothing
 *     in this file imports a provider client.
 *
 * There is no second proposal table. The design draws one "Needs your
 * confirmation" list, so a rule-raised proposal and an engine-projected
 * proposal are rows of one relation, told apart by `origin`, read by one read
 * model and decided by one route.
 *
 * Three invariants are part of the contract, not of the implementation:
 * `requiresConfirmation` is always `true`, `autoExecute` is always `false`, and
 * `proposedAction` may only name an action that has a real guarded endpoint. A
 * consumer that finds otherwise has been handed a forged draft and must refuse
 * it. Transitions out of `pending` belong to the queue; the engine only ever
 * inserts `pending`.
 */

import {
  RULE_RAISABLE_PROPOSAL_ACTIONS,
  raiseRuleAutomationProposal,
  type MetaAutomationProposalScope,
  type RuleRaisableProposalAction,
} from "@/lib/meta/automation-proposals";

export const AUTOMATION_PROPOSAL_CONTRACT_VERSION =
  "automation-proposal-intake.v2" as const;

export interface AutomationProposalDraft {
  contractVersion: typeof AUTOMATION_PROPOSAL_CONTRACT_VERSION;
  businessId: string;
  /** Required: an unscoped proposal could not appear in the account queue. */
  providerAccountId: string;
  /** Always `automation_rule` from this engine. */
  sourceKind: "automation_rule";
  /** The rule id that fired. */
  sourceId: string;
  sourceName: string;
  /** The queue's own action vocabulary, not a second one. */
  proposedAction: RuleRaisableProposalAction;
  entityLevel: MetaAutomationProposalScope;
  entityId: string;
  entityName: string | null;
  /** Deterministic sentence built from the anchors, never free text. */
  reason: string;
  /** Short deterministic evidence chip, or null when there is nothing proven. */
  evidenceLabel: string | null;
  evidence: Record<string, unknown>;
  /** `${ruleId}:${entityId}:${evaluatedForDate}` — one proposal per firing. */
  dedupeKey: string;
  /** YYYY-MM-DD the verdict was computed for. */
  evaluatedForDate: string;
  /** Invariant: always true. */
  requiresConfirmation: true;
  /** Invariant: always false. */
  autoExecute: false;
}

export interface AutomationProposalReceipt {
  proposalId: string | null;
  /**
   * `held_for_reconciliation` is deliberately NOT folded into
   * `already_present`. They are different facts: `already_present` means an
   * approvable queue row exists for this entity and action, and
   * `held_for_reconciliation` means the entity's slot is held by an attempt
   * whose provider outcome is UNKNOWN — there is nothing to approve, and there
   * will not be until a human reconciles it against a fresh provider read.
   * Reporting the second as the first tells an operator a confirmation is
   * waiting for them when what is waiting is a reconciliation.
   */
  status:
    | "inserted"
    | "already_present"
    | "held_for_reconciliation"
    | "sink_unavailable";
}

export type AutomationProposalSink = (
  draft: AutomationProposalDraft,
) => Promise<AutomationProposalReceipt>;

export class AutomationProposalContractError extends Error {
  readonly code = "invalid_automation_proposal";

  constructor(reason: string) {
    super(`Automation proposal draft rejected: ${reason}`);
    this.name = "AutomationProposalContractError";
  }
}

/**
 * The gate every sink must pass a draft through. A draft that claims it may
 * execute, or that does not require confirmation, is not a proposal — it is a
 * write wearing a proposal's name, and it is refused here rather than persisted.
 */
export function assertAutomationProposalDraft(
  draft: AutomationProposalDraft,
): AutomationProposalDraft {
  if (draft.contractVersion !== AUTOMATION_PROPOSAL_CONTRACT_VERSION) {
    throw new AutomationProposalContractError("unsupported_contract_version");
  }
  if (draft.requiresConfirmation !== true) {
    throw new AutomationProposalContractError("requires_confirmation_must_be_true");
  }
  if ((draft.autoExecute as boolean) !== false) {
    throw new AutomationProposalContractError("auto_execute_must_be_false");
  }
  if (!draft.businessId.trim()) {
    throw new AutomationProposalContractError("business_id_is_required");
  }
  if (!draft.providerAccountId.trim()) {
    throw new AutomationProposalContractError("provider_account_id_is_required");
  }
  if (!draft.sourceId.trim() || !draft.entityId.trim()) {
    throw new AutomationProposalContractError("source_and_entity_are_required");
  }
  if (!draft.dedupeKey.trim()) {
    throw new AutomationProposalContractError("dedupe_key_is_required");
  }
  if (
    !(RULE_RAISABLE_PROPOSAL_ACTIONS as readonly string[]).includes(
      draft.proposedAction,
    )
  ) {
    // A queue row promises "approving executes". An action with no guarded
    // endpoint could only ever fail, so it never becomes a row.
    throw new AutomationProposalContractError(
      "proposed_action_has_no_guarded_endpoint",
    );
  }
  return draft;
}

/**
 * Default sink: one `pending` row in the confirmation queue per firing.
 *
 * Idempotent twice over — on the firing's own `dedupe_key`, and on the
 * one-pending-row-per-entity-per-action slot the queue enforces so a rule and
 * the engine projection cannot queue the same pause twice.
 */
export const persistAutomationRuleProposal: AutomationProposalSink = async (
  draft,
) => {
  assertAutomationProposalDraft(draft);
  const result = await raiseRuleAutomationProposal({
    businessId: draft.businessId,
    providerAccountId: draft.providerAccountId,
    ruleId: draft.sourceId,
    dedupeKey: draft.dedupeKey,
    scopeType: draft.entityLevel,
    scopeId: draft.entityId,
    proposedAction: draft.proposedAction,
    entityLabel: draft.entityName,
    reason: draft.reason,
    evidenceLabel: draft.evidenceLabel,
    evidenceRef: draft.evidence,
    evaluatedForDate: draft.evaluatedForDate,
  });

  if (result.status === "unavailable") {
    return { proposalId: null, status: "sink_unavailable" };
  }
  if (result.status === "held_for_reconciliation") {
    // The firing still happened and is still counted, and it still points at
    // the row that represents the entity's slot. What it must not claim is that
    // a confirmation is queued.
    return {
      proposalId: result.proposalId,
      status: "held_for_reconciliation",
    };
  }
  return {
    proposalId: result.proposalId,
    status: result.status === "inserted" ? "inserted" : "already_present",
  };
};
