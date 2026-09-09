/**
 * D088 — the budget action on the ONE existing proposal/execution path.
 *
 * A budget proposal carries a server-built envelope: the exact owner, field,
 * amounts, currency and unit provenance the server derived from retained
 * evidence. Nothing in it may come from a browser, and the executor re-checks
 * that the durable request it is about to run still describes that envelope —
 * because an envelope and a request that disagree are two different changes.
 *
 * The gates are ordered so the cheapest refusal comes first and the provider is
 * reached last, only when every one of them is open.
 */
import { createHash } from "node:crypto";

import type { MutationAction } from "@/lib/zero-base/meta/dispatch-contract";
import {
  isBudgetIntentSemanticTuple,
  type BudgetDirection,
  type BudgetField,
  type BudgetOwnerGrain,
} from "@/lib/meta/budget-intent-contract";
import type { BudgetIntentVerb } from "@/lib/meta/budget-execution-composition";
import type { BudgetWriteOutcome } from "@/lib/meta/budget-write-execution";
import type { BudgetWriteRequest } from "@/lib/meta/budget-write-request";
import type { ProvenOwnerMode } from "@/lib/meta/budget-write-request";

/** The canonical proposal action. Not a ceremony action; see the dispatch contract. */
export const BUDGET_PROPOSAL_ACTION: MutationAction = "budget";

function directionForBudgetIntentVerb(value: unknown): BudgetDirection | null {
  if (value === "increase_budget") return "increase";
  if (value === "decrease_budget") return "decrease";
  return null;
}

export const BUDGET_PROPOSAL_WITHHELD_REASONS = [
  "release_gate_closed",
  "auto_execution_disabled",
  "dry_run_guardrail",
  "composition_blocked",
  "dry_run_not_would_write_available",
  "envelope_request_mismatch",
  "budget_semantic_authority_absent",
  "claim_absent",
  "dispatch_marker_unavailable",
  "manual_confirmation_absent",
  "account_not_activated",
  "enabling_actor_absent",
  "scheduled_authority_changed",
  /*
    The three the unattended STATUS and BID path can add.

    The receipt shape is shared with budget, so the vocabulary is shared too: a
    queue row settled `failed` must be able to say which gate refused it in the
    same field the operator already reads. `mode_not_auto` and
    `kill_switch_engaged` are states an operator chose, and
    `control_state_unavailable` is a reading that failed — three different
    answers that a single "refused" would flatten.
  */
  "mode_not_auto",
  "kill_switch_engaged",
  "control_state_unavailable",
  /*
    The four only a BID row can produce.

    A bid change is the one queued action whose meaning depends on a provider
    setting that can move underneath it. Each of these is a different fact and
    the operator needs to be able to tell them apart: no amount was stored, the
    strategy is not one that owns a writable amount, the current value could
    not be read, or it is no longer the value the decision was reasoned from.
  */
  "bid_envelope_absent",
  "bid_semantic_authority_absent",
  "bid_strategy_not_writable",
  "bid_baseline_unreadable",
  "bid_baseline_changed",
  /*
    The two an AD-grain row can produce, and neither is a generic block.

    An ad write is a decision-origin write: it must name the exact snapshot,
    evaluation, engine version and decision hash the recommendation was made
    under, and the ad must still carry the creative that decision was about.
    A row missing the lineage and an ad whose creative was swapped are
    different problems with different answers, and "blocked" would hide both.
  */
  "decision_lineage_absent",
  "creative_identity_mismatch",
  /*
    The facts only a CREATIVE row can produce, and each of them is a different
    thing to have happened.

    A launch row points at a launch intent and an activation row points at what
    that launch created, so both can be refused for reasons no status or money
    row has: the row names no intent, the intent could not be read, it is no
    longer in the one state a create may start from, its stored payload no
    longer hashes to the fingerprint the operator approved, or Launchpad's own
    release gate — which is a separate environment gate from the Automation one
    — is shut. Flattening any of them to `composition_blocked` would settle the
    queue row `failed` while hiding which of the six it was, and five of the six
    are things the operator can put right.
  */
  "launch_intent_absent",
  "launch_intent_unreadable",
  "launch_intent_not_prepared",
  "launch_payload_changed",
  "launchpad_execution_gated",
  "launchpad_safety_step_missing",
  "launch_write_context_unavailable",
  /*
    What `activateLaunchIntent` itself can answer, carried through verbatim.

    These are `LaunchActivationRefusal` — the three plan refusals plus every
    `ActivationApprovalRefusal`. They are listed rather than imported because
    this vocabulary is the receipt's, not the approval module's; the activation
    runtime assigns its refusal into this union directly, so a code added there
    and forgotten here is a compile error rather than a silent `composition
    blocked`. "Nobody approved this" and "somebody approved a different payload"
    are the two an operator most needs to be able to tell apart.
  */
  "intent_not_succeeded",
  "receipt_absent",
  "no_activatable_entities",
  "activation_approval_absent",
  "activation_approval_malformed",
  "activation_approval_contract_unknown",
  "activation_approval_business_mismatch",
  "activation_approval_account_mismatch",
  "activation_approval_intent_mismatch",
  "activation_approval_payload_changed",
  "activation_approval_operation_mismatch",
  "activation_approval_scope_mismatch",
  "activation_approval_asset_mismatch",
  "activation_approval_destination_mismatch",
  "activation_approval_expired",
  "activation_approval_revoked",
  "activation_approval_approver_absent",
  "activation_approval_policy_version_unbound",
] as const;
export type BudgetProposalWithheldReason =
  (typeof BUDGET_PROPOSAL_WITHHELD_REASONS)[number];

export interface BudgetProposalEnvelope {
  proposalId: string;
  businessId: string;
  providerAccountId: string;
  ownerGrain: BudgetOwnerGrain;
  entityId: string;
  parentCampaignId: string | null;
  budgetField: BudgetField;
  ownerMode: ProvenOwnerMode;
  currentAmountMinor: number;
  intendedAmountMinor: number;
  currency: string;
  currencyExponent: number;
  currencyRegistryVersion: string;
  intentVerb: BudgetIntentVerb;
  /*
    D088 C3 — the immutable DECISION lineage.

    C2 bound the envelope to its row's identity but not to the decision it came
    from, and used the envelope's own fingerprint as the decision hash — a
    circular identity that proved nothing about the recommendation. These are
    the persisted decision's own facts.
  */
  recId: string;
  recType: string;
  snapshotDate: string;
  engineVersion: string;
  /** The decision's OWN canonical hash. Never this envelope's fingerprint. */
  decisionHash: string;
  /** The decision's OWN timestamp. Never the proposal or approval time. */
  decisionAt: string;
  /** sha256 over exactly the fields above, in a fixed order. */
  fingerprint: string;
}

/**
 * The canonical hash of a persisted decision tuple.
 *
 * Deterministic and server-owned: the same persisted decision always hashes the
 * same way, and any change to the recommendation, its target or its lineage
 * produces a different one.
 */
export function canonicalDecisionHash(input: {
  businessId: string;
  providerAccountId: string;
  scopeType: string;
  scopeId: string;
  recId: string;
  recType: string;
  snapshotDate: string;
  engineVersion: string;
  recommendedAction: string;
  targetAmountMinor: number;
  decisionAt: string;
}): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build the envelope from named server fields ONLY.
 *
 * The parameter is destructured field by field rather than spread, so a caller
 * that attaches an extra key — a browser-supplied entity, an amount override —
 * contributes nothing to the envelope and nothing to its fingerprint.
 */
export function buildBudgetProposalEnvelope(input: {
  proposalId: string;
  businessId: string;
  providerAccountId: string;
  ownerGrain: BudgetOwnerGrain;
  entityId: string;
  parentCampaignId: string | null;
  budgetField: BudgetField;
  ownerMode: ProvenOwnerMode;
  currentAmountMinor: number;
  intendedAmountMinor: number;
  currency: string;
  currencyExponent: number;
  currencyRegistryVersion: string;
  intentVerb: BudgetIntentVerb;
  recId: string;
  recType: string;
  snapshotDate: string;
  engineVersion: string;
  decisionHash: string;
  decisionAt: string;
}): BudgetProposalEnvelope {
  const fields = {
    proposalId: input.proposalId,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    ownerGrain: input.ownerGrain,
    entityId: input.entityId,
    parentCampaignId: input.parentCampaignId,
    budgetField: input.budgetField,
    ownerMode: input.ownerMode,
    currentAmountMinor: input.currentAmountMinor,
    intendedAmountMinor: input.intendedAmountMinor,
    currency: input.currency,
    currencyExponent: input.currencyExponent,
    currencyRegistryVersion: input.currencyRegistryVersion,
    intentVerb: input.intentVerb,
    recId: input.recId,
    recType: input.recType,
    snapshotDate: input.snapshotDate,
    engineVersion: input.engineVersion,
    decisionHash: input.decisionHash,
    decisionAt: input.decisionAt,
  };
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
  );
  return {
    ...fields,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  };
}

export interface BudgetProposalExecutionReceipt {
  httpStatus: number;
  response: unknown;
  dryRun: boolean;
  dispatchedAt: string;
  endpoint: string | null;
  withheld: BudgetProposalWithheldReason | null;
  receiptKey: string | null;
  /** Exact provider mutation fact; distinct from the durable intent marker. */
  providerMutationAttempted?: boolean;
  /** Persisted by the shared lifecycle; absent on pre-D088 receipts. */
  executionKind?: "manual" | "scheduled";
}

export interface BudgetProposalExecutionResult {
  ok: boolean;
  receipt: BudgetProposalExecutionReceipt;
  /** The attempt belongs in the existing reconcile state. */
  reconcile: boolean;
  /** Always false: an unknown outcome is never automatically reversed. */
  rollbackRequested: false;
  journalId: string | null;
}

export interface BudgetProposalExecutionInput {
  envelope: BudgetProposalEnvelope;
  claimToken: string | null;
  actorUserId: string;
  /** The persisted guardrail shown above the queue. */
  dryRunOnly: boolean;
  releaseGateOpen: boolean;
  /**
   * Whether THIS execution is authorized to reach the provider.
   *
   * D088 C3: not "is business-wide automatic execution on". A manual approval
   * is authorized by the operator's explicit confirmation while automatic
   * execution is off — the exact posture the confirmation queue exists for —
   * and C2 refused it here as `auto_execution_disabled`, which was not true of
   * it. The caller decides once, by authorization kind, and passes the answer.
   */
  autoExecutionEnabled: boolean;
  composition: {
    blockers: readonly string[];
    request: BudgetWriteRequest | null;
    dryRunStatus: string;
    dryRunBlockers?: readonly string[];
    requestFingerprint: string | null;
  };
  /** The D087 executor. The only thing here that can reach a provider. */
  execute(request: BudgetWriteRequest): Promise<BudgetWriteOutcome>;
  now?: Date;
}

export async function executeBudgetProposal(
  input: BudgetProposalExecutionInput,
): Promise<BudgetProposalExecutionResult> {
  const dispatchedAt = (input.now ?? new Date()).toISOString();
  const withhold = (
    reason: BudgetProposalWithheldReason,
    response: unknown = null,
  ): BudgetProposalExecutionResult => ({
    ok: false,
    receipt: {
      httpStatus: 422,
      response,
      dryRun: input.dryRunOnly,
      dispatchedAt,
      endpoint: null,
      withheld: reason,
      receiptKey: input.claimToken,
    },
    reconcile: false,
    rollbackRequested: false,
    journalId: null,
  });

  // The gates, cheapest first. The provider is reached last or not at all.
  if (!input.claimToken) return withhold("claim_absent");
  if (!isBudgetIntentSemanticTuple({
    recommendationType: input.envelope.recType,
    grain: input.envelope.ownerGrain,
    direction: directionForBudgetIntentVerb(input.envelope.intentVerb),
  })) {
    return withhold("budget_semantic_authority_absent");
  }
  if (input.releaseGateOpen !== true) return withhold("release_gate_closed");
  // "Authorized to reach the provider", per the field's contract above.
  if (input.autoExecutionEnabled !== true) return withhold("auto_execution_disabled");
  if (input.dryRunOnly === true) return withhold("dry_run_guardrail");

  const { composition } = input;
  if (composition.blockers.length > 0 || !composition.request) {
    return withhold("composition_blocked", { blockers: composition.blockers });
  }
  if (composition.dryRunStatus !== "would_write_available") {
    return withhold("dry_run_not_would_write_available", {
      dryRunStatus: composition.dryRunStatus,
      // The reasons, so a surface and an operator can see WHY, not just that.
      dryRunBlockers: composition.dryRunBlockers ?? [],
    });
  }

  /*
    The envelope is what was APPROVED; the request is what would be WRITTEN.
    They are derived from the same facts, so any difference means one of them
    is describing a change nobody approved.
  */
  const request = composition.request;
  const envelope = input.envelope;
  if (request.scope.businessId !== envelope.businessId
    || request.scope.providerAccountId !== envelope.providerAccountId
    || request.scope.ownerGrain !== envelope.ownerGrain
    || request.scope.entityId !== envelope.entityId
    || request.budgetField !== envelope.budgetField
    || request.ownerMode !== envelope.ownerMode
    || request.intendedAmountMinor !== envelope.intendedAmountMinor
    || request.baseline.amountMinor !== envelope.currentAmountMinor
    || request.currency !== envelope.currency
    || request.currencyExponent !== envelope.currencyExponent) {
    return withhold("envelope_request_mismatch");
  }

  const outcome = await input.execute(request);
  if (outcome.blockers.includes("dispatch_marker_unavailable")) {
    return withhold("dispatch_marker_unavailable");
  }
  /*
    UNKNOWN goes to the existing reconcile state, once. It is never retried and
    never automatically reversed: the write may have landed, and a second
    attempt or an automatic rollback would each be a new unreviewed mutation.
  */
  const reconcile = outcome.resultClass === "unknown";
  const providerMutationAttempted = outcome.providerAttempted
    ?? (outcome.ok || outcome.resultClass === "unknown");
  return {
    ok: outcome.ok,
    receipt: {
      httpStatus: outcome.ok ? 200 : reconcile ? 502 : 422,
      response: {
        resultClass: outcome.resultClass,
        blockers: outcome.blockers,
        readbackAmountMinor: outcome.readbackAmountMinor,
      },
      dryRun: false,
      dispatchedAt,
      endpoint: `${envelope.ownerGrain}:${envelope.entityId}`,
      withheld: null,
      receiptKey: input.claimToken,
      providerMutationAttempted,
    },
    reconcile,
    rollbackRequested: false,
    journalId: outcome.journalId,
  };
}

/**
 * Parse a stored envelope. TOTAL, and fail-closed.
 *
 * A `budget` proposal whose envelope will not parse is not a proposal anybody
 * can execute: the amounts, the owner and the unit provenance are the whole
 * authority of the row. It comes back `null`, and the executor refuses.
 */
export function parseBudgetProposalEnvelope(value: unknown): BudgetProposalEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const str = (key: string) =>
    typeof raw[key] === "string" && (raw[key] as string).trim() !== ""
      ? (raw[key] as string) : null;
  const int = (key: string) =>
    typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) ? (raw[key] as number) : null;

  const ownerGrain = str("ownerGrain");
  const budgetField = str("budgetField");
  const ownerMode = str("ownerMode");
  const intentVerb = str("intentVerb");
  const currency = str("currency");
  const currentAmountMinor = int("currentAmountMinor");
  const intendedAmountMinor = int("intendedAmountMinor");
  const currencyExponent = int("currencyExponent");
  if (ownerGrain !== "campaign" && ownerGrain !== "adset") return null;
  if (budgetField !== "daily_budget" && budgetField !== "lifetime_budget") return null;
  if (ownerMode !== "campaign_budget_optimization" && ownerMode !== "adset_budget") return null;
  if (intentVerb !== "increase_budget" && intentVerb !== "decrease_budget") return null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  if (currentAmountMinor === null || currentAmountMinor <= 0) return null;
  if (intendedAmountMinor === null || intendedAmountMinor <= 0) return null;
  if (currencyExponent === null || currencyExponent < 0 || currencyExponent > 4) return null;
  const recId = str("recId");
  const recType = str("recType");
  const snapshotDate = str("snapshotDate");
  const engineVersion = str("engineVersion");
  const decisionHash = str("decisionHash");
  const decisionAt = str("decisionAt");
  if (!recId || !recType || !snapshotDate || !engineVersion || !decisionAt) return null;
  if (!isBudgetIntentSemanticTuple({
    recommendationType: recType,
    grain: ownerGrain,
    direction: directionForBudgetIntentVerb(intentVerb),
  })) return null;
  // A decision hash that is not a sha256 is not a decision hash.
  if (!decisionHash || !/^[0-9a-f]{64}$/.test(decisionHash)) return null;
  const proposalId = str("proposalId");
  const businessId = str("businessId");
  const providerAccountId = str("providerAccountId");
  const entityId = str("entityId");
  const currencyRegistryVersion = str("currencyRegistryVersion");
  if (!proposalId || !businessId || !providerAccountId || !entityId
    || !currencyRegistryVersion) return null;
  const parentCampaignId = raw.parentCampaignId === null || raw.parentCampaignId === undefined
    ? null : str("parentCampaignId");
  if (ownerGrain === "adset" && parentCampaignId === null) return null;

  const rebuilt = buildBudgetProposalEnvelope({
    proposalId, businessId, providerAccountId, ownerGrain, entityId, parentCampaignId,
    budgetField, ownerMode, currentAmountMinor, intendedAmountMinor,
    currency, currencyExponent, currencyRegistryVersion, intentVerb,
    recId, recType, snapshotDate, engineVersion, decisionHash, decisionAt,
  });
  /*
    The stored fingerprint must be the fingerprint OF the stored fields. A row
    whose fingerprint does not re-derive has been edited since it was written,
    and nothing may execute from it.
  */
  if (str("fingerprint") !== rebuilt.fingerprint) return null;
  return rebuilt;
}

/** A proposal id that names nothing. Never an executable identity. */
export const PLACEHOLDER_PROPOSAL_ID = "00000000-0000-4000-8000-000000000000" as const;

/**
 * D088 C2 — bind a parsed envelope to the row it was read from.
 *
 * The fingerprint proves the envelope has not been edited. It does NOT prove it
 * belongs to THIS row: an envelope copied from another proposal, another
 * account or another entity re-fingerprints perfectly. Identity is checked
 * separately, and a placeholder id is refused outright — C1's producer
 * fingerprinted one and inserted a different id, so no stored envelope would
 * ever have matched its own row.
 */
export function envelopeForProposalRow(
  envelope: BudgetProposalEnvelope | null,
  row: {
    id: string;
    businessId: string;
    providerAccountId: string;
    scopeType: string;
    scopeId: string;
    proposedAction: string;
    /** The row's own lineage columns, re-checked against the envelope. */
    recId?: string | null;
    recType?: string | null;
    snapshotDate?: string | null;
    engineVersion?: string | null;
  },
): BudgetProposalEnvelope | null {
  if (!envelope) return null;
  if (row.proposedAction !== BUDGET_PROPOSAL_ACTION) return null;
  if (envelope.proposalId === PLACEHOLDER_PROPOSAL_ID) return null;
  if (envelope.proposalId !== row.id) return null;
  if (envelope.businessId !== row.businessId) return null;
  if (envelope.providerAccountId !== row.providerAccountId) return null;
  if (envelope.ownerGrain !== row.scopeType) return null;
  if (envelope.entityId !== row.scopeId) return null;
  if (!isBudgetIntentSemanticTuple({
    recommendationType: envelope.recType,
    grain: envelope.ownerGrain,
    direction: directionForBudgetIntentVerb(envelope.intentVerb),
  })) return null;
  /*
    The DECISION the row records and the decision the envelope names must be the
    same one. An envelope carrying another recommendation's lineage would put a
    different decision's amount behind this row's evidence.
  */
  if (row.recId !== undefined && envelope.recId !== row.recId) return null;
  if (row.recType !== undefined && envelope.recType !== row.recType) return null;
  if (row.snapshotDate !== undefined && envelope.snapshotDate !== row.snapshotDate) return null;
  if (row.engineVersion !== undefined && envelope.engineVersion !== row.engineVersion) {
    return null;
  }
  return envelope;
}
