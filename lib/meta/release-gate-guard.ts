/**
 * The server-side half of a release gate.
 *
 * A gate that is only read by a page decides what is OFFERED. It does not
 * decide what is PERMITTED, and the difference is the whole point: a stale tab,
 * a replayed request or a script never sees the screen. Until this file, only
 * Launchpad had that second half — the other five gates were read by nothing,
 * or by a page alone.
 *
 * Two rules this enforces and one it deliberately does not:
 *
 * - A closed gate refuses, with the gate's own operator sentence and a §9.1
 *   code. The refusal never names the environment variable: an operator cannot
 *   set it and must not be sent looking for it.
 * - An OPEN gate whose write family has missing safety steps refuses too, with
 *   a different sentence, because "not enabled yet" and "enabled and it must
 *   not be" are different facts and only the first is a rollout state.
 * - It grants nothing. Every authorization the route already performs still
 *   runs; opening a gate cannot substitute for a role, a membership, a
 *   provider-account assignment or a kill switch.
 */
import { NextResponse } from "next/server";

import {
  META_GATE_REFUSAL_REASONS,
  LAUNCHPAD_EXECUTION_SAFETY_INCOMPLETE_REASON,
} from "@/lib/meta/release-gate-copy";
import {
  readMetaReleaseGates,
  type MetaGateEnv,
  type MetaReleaseGates,
} from "@/lib/meta/release-gates";
import type { MetaFailureCode } from "@/lib/meta/read-state-contract";
import {
  missingSteps,
  writeFamily,
  type WriteFamilyId,
} from "@/lib/meta/write-safety-contract";

/** The §9.1 code each gate refuses with. */
export const GATE_FAILURE_CODE: Record<keyof MetaReleaseGates, MetaFailureCode> = {
  launchpadExecution: "launchpad_execution_disabled",
  decisionWorkflowUi: "decision_workflow_disabled",
  automationStopUi: "automation_stop_disabled",
  automationLiveWrites: "automation_live_writes_disabled",
  publicShareMint: "public_share_mint_disabled",
  accountPicker: "account_picker_disabled",
};

/**
 * The write family a gate governs, where one exists.
 *
 * `publicShareMint` and `accountPicker` have none: neither reaches Meta, so the
 * write-safety sequence has nothing to say about them and pretending otherwise
 * would put a family in the contract that no provider call belongs to.
 */
const GATE_WRITE_FAMILY: Partial<Record<keyof MetaReleaseGates, WriteFamilyId>> = {
  launchpadExecution: "launchpad_create",
  decisionWorkflowUi: "decisions_manual_action",
  automationLiveWrites: "automation_proposal_approval",
};

export interface GateRefusal {
  code: MetaFailureCode;
  message: string;
  /** True when the gate is OPEN and its safety contract is not satisfied. */
  safetyIncomplete: boolean;
}

/**
 * Decide, without touching the environment.
 *
 * Pure and injectable so both branches are provable: a test can hold the gate
 * open with an incomplete contract, which is the state no test may produce by
 * flipping a real variable on a route whose next step reaches Meta.
 */
export function metaGateRefusal(input: {
  gate: keyof MetaReleaseGates;
  gateOpen: boolean;
  missingSafetySteps?: readonly string[];
}): GateRefusal | null {
  if (!input.gateOpen) {
    return {
      code: GATE_FAILURE_CODE[input.gate],
      message: META_GATE_REFUSAL_REASONS[input.gate],
      safetyIncomplete: false,
    };
  }
  if ((input.missingSafetySteps?.length ?? 0) > 0) {
    return {
      code: GATE_FAILURE_CODE[input.gate],
      message: LAUNCHPAD_EXECUTION_SAFETY_INCOMPLETE_REASON,
      safetyIncomplete: true,
    };
  }
  return null;
}

/** The refusal for a gate, read from the environment on the server. */
export function readMetaGateRefusal(
  gate: keyof MetaReleaseGates,
  env: MetaGateEnv = process.env,
): GateRefusal | null {
  const gateOpen = readMetaReleaseGates(env)[gate];
  const family = GATE_WRITE_FAMILY[gate];
  const missing = family ? missingSteps(writeFamily(family)).map(String) : [];
  const refusal = metaGateRefusal({ gate, gateOpen, missingSafetySteps: missing });
  if (refusal?.safetyIncomplete) {
    // Loud, because this is a deployment error rather than a rollout state and
    // nobody watching the screen can see it. The variable name belongs here and
    // never in the response.
    console.error("[meta-gate] a gate is open with an incomplete safety contract", {
      gate,
      family,
      missingSteps: missing,
    });
  }
  return refusal;
}

/**
 * The refusal as a response, for a route to return directly.
 *
 * 503 rather than 403: nothing about the caller is wrong. The capability is not
 * available in this deployment, which is a server state, and a 403 would send
 * an operator to ask for a permission that would not help.
 */
export function rejectIfMetaGateClosed(
  gate: keyof MetaReleaseGates,
  operation: string,
  env: MetaGateEnv = process.env,
): NextResponse | null {
  const refusal = readMetaGateRefusal(gate, env);
  if (!refusal) return null;
  return NextResponse.json(
    { error: refusal.code, message: refusal.message, operation },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Whether a live provider write is permitted for the automation family.
 *
 * The gate can only ever ADD dry-run. `dryRunOnly` is the persisted guardrail
 * the operator's own control row carries, and it stays authoritative — but with
 * the gate closed, a row saying `dryRunOnly: false` must not produce a live
 * write, which is exactly what it did while nothing read the gate. D10: "Dry-run
 * varsayılan TRUE", and the release gate is the second lock, not a substitute
 * for the first.
 */
export function metaAutomationDryRunOnly(input: {
  persistedGuardrailDryRunOnly: boolean;
  gateOpen: boolean;
  missingSafetySteps?: readonly string[];
}): boolean {
  if (input.persistedGuardrailDryRunOnly) return true;
  return metaGateRefusal({
    gate: "automationLiveWrites",
    gateOpen: input.gateOpen,
    missingSafetySteps: input.missingSafetySteps,
  }) !== null;
}
