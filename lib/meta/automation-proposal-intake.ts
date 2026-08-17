/**
 * The intake contract between the rules engine and the confirmation queue.
 *
 * The rules engine owns one half of the design's safety sentence — "rules never
 * write directly — they raise proposals into the confirmation queue". The queue
 * itself (LAUNCHPAD-AUTOMATION-30) is a separate surface, built separately.
 * This module is the seam, deliberately narrow so the two can be reconciled
 * without either side importing the other's internals:
 *
 *   - `AutomationProposalDraft` is what a firing hands over. It is data only.
 *   - `AutomationProposalSink` is how it is handed over. The engine takes one
 *     as a parameter; it never reaches for a global.
 *   - `persistAutomationRuleProposal` is the default sink shipped here. It
 *     writes a `pending` row into `meta_automation_rule_proposals` and nothing
 *     else. It performs no provider call, and it cannot: nothing in this file
 *     imports a provider client.
 *
 * Two invariants are part of the contract, not of the implementation:
 *   `requiresConfirmation` is always `true` and `autoExecute` is always `false`.
 *   A consumer that finds either otherwise has been handed a forged draft and
 *   must refuse it.
 *
 * The queue may adopt this table directly, or supply its own sink. Transitions
 * out of `pending` belong to the queue; the engine only ever inserts `pending`.
 */

import { getDb } from "@/lib/db";
import type {
  AutomationProposalActionKind,
  AutomationRuleEntityLevel,
} from "@/lib/meta/automation-rules";

export const AUTOMATION_PROPOSAL_CONTRACT_VERSION =
  "automation-proposal-intake.v1" as const;

export const AUTOMATION_PROPOSAL_STATUSES = [
  "pending",
  "confirmed",
  "dismissed",
  "expired",
] as const;
export type AutomationProposalStatus =
  (typeof AUTOMATION_PROPOSAL_STATUSES)[number];

export interface AutomationProposalDraft {
  contractVersion: typeof AUTOMATION_PROPOSAL_CONTRACT_VERSION;
  businessId: string;
  providerAccountId: string | null;
  /** Always `automation_rule` from this engine. */
  sourceKind: "automation_rule";
  /** The rule id that fired. */
  sourceId: string;
  sourceName: string;
  actionKind: AutomationProposalActionKind;
  /** Present only for the two budget action kinds. */
  budgetChangePct: number | null;
  entityLevel: AutomationRuleEntityLevel;
  entityId: string;
  entityName: string | null;
  /** Deterministic sentence built from the anchors, never free text. */
  reason: string;
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
  status: "inserted" | "already_present" | "sink_unavailable";
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
  if (!draft.sourceId.trim() || !draft.entityId.trim()) {
    throw new AutomationProposalContractError("source_and_entity_are_required");
  }
  if (!draft.dedupeKey.trim()) {
    throw new AutomationProposalContractError("dedupe_key_is_required");
  }
  return draft;
}

type ProposalDbRow = { id: string };

/**
 * Default sink: one `pending` row per firing, idempotent on `dedupe_key`.
 *
 * `ON CONFLICT DO NOTHING` is what makes re-running an evaluation over the same
 * warehouse day a no-op instead of a duplicate queue entry.
 */
export const persistAutomationRuleProposal: AutomationProposalSink = async (
  draft,
) => {
  assertAutomationProposalDraft(draft);
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_automation_rule_proposals (
      business_id,
      rule_id,
      provider_account_id,
      action_kind,
      budget_change_pct,
      entity_level,
      entity_id,
      entity_name,
      reason,
      evidence_json,
      dedupe_key,
      evaluated_for_date,
      status
    )
    VALUES (
      ${draft.businessId},
      ${draft.sourceId},
      ${draft.providerAccountId},
      ${draft.actionKind},
      ${draft.budgetChangePct},
      ${draft.entityLevel},
      ${draft.entityId},
      ${draft.entityName},
      ${draft.reason},
      ${JSON.stringify(draft.evidence)}::jsonb,
      ${draft.dedupeKey},
      ${draft.evaluatedForDate}::date,
      'pending'
    )
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `) as ProposalDbRow[];

  if (rows.length > 0) {
    return { proposalId: rows[0]!.id, status: "inserted" };
  }
  const existing = (await sql`
    SELECT id FROM meta_automation_rule_proposals
    WHERE dedupe_key = ${draft.dedupeKey}
    LIMIT 1
  `) as ProposalDbRow[];
  return {
    proposalId: existing[0]?.id ?? null,
    status: "already_present",
  };
};
