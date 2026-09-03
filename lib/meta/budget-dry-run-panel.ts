/**
 * D085 — the server-owned dry-run projection for the Decision Center.
 *
 * The UI renders this verbatim. It computes no buyer action, no role, no
 * threshold, no eligibility, no current or proposed budget, no provider state
 * and no blocker; every sentence and every state below is written here.
 *
 * The projection keeps four things visibly separate, because collapsing them is
 * how a preview gets mistaken for a result:
 *
 *   1. OBSERVED   — what the provider/warehouse actually says today;
 *   2. PROPOSED   — the exact request that would be sent, if anything;
 *   3. SIMULATED  — the receipt preview, which is not a durable receipt;
 *   4. REQUIRED   — what a future execution and read-back would still need.
 */

import {
  META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  type BudgetProposalDryRun,
} from "@/lib/meta/budget-proposal-dry-run";
import { WRITE_SAFETY_STEPS, type WriteSafetyStep } from "@/lib/meta/write-safety-contract";

export const META_BUDGET_DRY_RUN_PANEL_CONTRACT = "meta-budget-dry-run-panel.v1" as const;

export type DryRunPanelUnavailableReason =
  | "no_dry_run_produced"
  | "dry_run_contract_unsupported";

export interface DryRunPanelFact {
  label: string;
  value: string;
}

export interface MetaBudgetDryRunPanel {
  contractVersion: typeof META_BUDGET_DRY_RUN_PANEL_CONTRACT;
  status: "resolved" | "unavailable";
  unavailableReason: DryRunPanelUnavailableReason | null;
  /** Headline: what a reader must take away before anything else. */
  headline: string;
  /** 1. Observed provider/DB facts. */
  observed: { title: string; facts: DryRunPanelFact[]; note: string };
  /** 2. The proposed request — present only when one exists. */
  proposed: {
    title: string;
    available: boolean;
    facts: DryRunPanelFact[];
    note: string;
  };
  /** 3. The simulated receipt preview — never a durable receipt. */
  simulated: {
    title: string;
    available: boolean;
    facts: DryRunPanelFact[];
    note: string;
  };
  /** 4. What execution and read-back would still require. */
  required: {
    title: string;
    blockers: Array<{ code: string; why: string }>;
    writeSafetyMissing: WriteSafetyStep[];
    readbackRequirement: string;
    note: string;
  };
  execution: {
    executionState: "validated_only";
    executable: false;
    ctaEnabled: false;
    ctaLabel: "Dry run only";
    providerWriteAttempted: false;
    providerOutcome: "not_attempted";
    readbackClassification: "not_attempted";
    /** The exact next requirement, never generic copy. */
    nextRequirement: string;
  };
  fingerprints: { input: string; policy: string; preflight: string | null };
}

export function unavailableDryRunPanel(
  reason: DryRunPanelUnavailableReason,
): MetaBudgetDryRunPanel {
  return {
    contractVersion: META_BUDGET_DRY_RUN_PANEL_CONTRACT,
    status: "unavailable",
    unavailableReason: reason,
    headline:
      reason === "no_dry_run_produced"
        ? "No budget dry run was produced for this account."
        : "The dry-run contract version served is not the one this surface reads.",
    observed: {
      title: "Observed",
      facts: [],
      note: "no dry run exists, so no observed provider or warehouse fact is published here",
    },
    proposed: { title: "Would be sent", available: false, facts: [], note: "no request exists" },
    simulated: { title: "Simulated receipt", available: false, facts: [], note: "no receipt preview exists" },
    required: {
      title: "Still required",
      blockers: [],
      writeSafetyMissing: [],
      readbackRequirement:
        "an independent post-write read must reproduce the expected projection exactly; a provider success reply never qualifies",
      note:
        reason === "no_dry_run_produced"
          ? "a dry run must be produced before anything here can be inspected"
          : "the served contract version must match before this surface may interpret a dry run",
    },
    execution: {
      executionState: "validated_only",
      executable: false,
      ctaEnabled: false,
      ctaLabel: "Dry run only",
      providerWriteAttempted: false,
      providerOutcome: "not_attempted",
      readbackClassification: "not_attempted",
      nextRequirement:
        reason === "no_dry_run_produced"
          ? "produce a dry run for a concrete entity and direction"
          : "serve the dry-run contract version this surface supports",
    },
    fingerprints: { input: "", policy: "", preflight: null },
  };
}

/** Project one dry run into the render model. */
export function projectBudgetDryRunPanel(input: {
  dryRun: BudgetProposalDryRun | null;
  observedFacts: DryRunPanelFact[];
  writeSafetyMissing: WriteSafetyStep[];
}): MetaBudgetDryRunPanel {
  const run = input.dryRun;
  if (run === null) return unavailableDryRunPanel("no_dry_run_produced");
  if (run.contractVersion !== META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT) {
    return unavailableDryRunPanel("dry_run_contract_unsupported");
  }

  const request = run.status === "would_write_available" ? run.wouldWriteRequest : null;
  const receipt = run.status === "would_write_available" ? run.receiptPreview : null;
  const firstBlocker = run.status === "blocked" ? run.blockerDetail[0] ?? null : null;

  return {
    contractVersion: META_BUDGET_DRY_RUN_PANEL_CONTRACT,
    status: "resolved",
    unavailableReason: null,
    headline:
      run.status === "blocked"
        ? `No budget request would be sent: ${run.blockers.length} requirement${run.blockers.length === 1 ? "" : "s"} are still open.`
        : "A budget request could be assembled, but it is a dry run and is not executable.",
    observed: {
      title: "Observed",
      facts: input.observedFacts,
      note: "what the provider and warehouse actually report today; nothing here is proposed",
    },
    proposed: {
      title: "Would be sent",
      available: request !== null,
      facts: request
        ? [
            { label: "Endpoint class", value: request.endpointClass },
            { label: "Node", value: `${request.nodeClass} ${request.entityId}` },
            { label: "Field", value: request.field },
            { label: "Current (raw minor units)", value: String(request.currentMinorUnits) },
            { label: "Proposed (raw minor units)", value: String(request.proposedMinorUnits) },
            { label: "Currency", value: `${request.currency} (exponent ${request.currencyExponent})` },
            { label: "Value semantics", value: request.valueSemantics },
            { label: "Field allowlist", value: request.fieldAllowlist.join(", ") },
            { label: "Idempotency key (preview)", value: request.idempotencyKeyPreview },
          ]
        : [],
      note: request
        ? "an exact would-have-sent request. It carries no token, no header and no full URL, and it was never sent."
        : "no request exists, because the requirements below are still open",
    },
    simulated: {
      title: "Simulated receipt",
      available: receipt !== null,
      facts: receipt
        ? [
            { label: "Preview key", value: receipt.previewKey },
            { label: "Is a durable receipt", value: String(receipt.isDurableReceipt) },
            { label: "Before", value: `${receipt.before.field} = ${receipt.before.minorUnits}` },
            { label: "Proposed", value: `${receipt.proposed.field} = ${receipt.proposed.minorUnits}` },
            { label: "Actor", value: receipt.actor.classification },
            { label: "Rollback", value: `${receipt.rollbackPreview.operation} to ${receipt.rollbackPreview.restoreMinorUnits} (${receipt.rollbackPreview.reversibilityClass})` },
            { label: "CAS baseline", value: receipt.casBaselineFingerprint },
            { label: "Expected read-back", value: receipt.readbackFingerprint },
          ]
        : [],
      note: receipt
        ? "a SIMULATED preview. It is not a durable receipt, it reserves no claim, and it is not evidence that anything happened."
        : "no receipt preview exists, because no request was assembled",
    },
    required: {
      title: "Still required",
      blockers: run.status === "blocked" ? run.blockerDetail.map((d) => ({ code: d.code, why: d.why })) : [],
      writeSafetyMissing: WRITE_SAFETY_STEPS.filter((s) => input.writeSafetyMissing.includes(s)),
      readbackRequirement:
        "after any future write, an independent fresh read must reproduce the expected projection exactly. A provider success reply, an echoed payload or a cached value never qualifies.",
      note: "these are the exact requirements between this dry run and an executable change",
    },
    execution: {
      executionState: "validated_only",
      executable: false,
      ctaEnabled: false,
      ctaLabel: "Dry run only",
      providerWriteAttempted: false,
      providerOutcome: "not_attempted",
      readbackClassification: "not_attempted",
      nextRequirement:
        firstBlocker?.why ??
        "no budget mutation endpoint exists and automation is off, so nothing here can be executed",
    },
    fingerprints: {
      input: run.inputFingerprint,
      policy: run.policyFingerprint,
      preflight: run.preflightFingerprint,
    },
  };
}
