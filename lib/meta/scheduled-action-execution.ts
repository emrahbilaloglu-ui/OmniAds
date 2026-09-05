/**
 * Unattended execution of a status or bid proposal.
 *
 * The approval path forwards to the manual HTTP handler, and that is right: an
 * operator really did click Approve, so `manual_operator_v1` and an explicit
 * confirmation are true statements about what happened. The scheduler has no
 * operator, so it must not reach that handler at all — passing it a
 * confirmation nobody gave would put a false statement into the action log and
 * make the two authorities indistinguishable afterwards.
 *
 * So this drives the provider primitives directly, under an authorization that
 * says what it is, and re-proves that authorization at the last possible moment
 * before the single POST.
 *
 * ## Why the second check is the binding one
 *
 * The gates are read once before the claim, cheaply, so an obviously ineligible
 * row costs nothing. But claiming, composing and reaching the provider takes
 * seconds, and in those seconds an operator can engage the STOP, change the
 * standing mode, unbind the account or re-activate under a different admin.
 * `beforeMutationAttempt` runs after every adapter-side check and immediately
 * before the request begins, which is the only place a re-read can still
 * prevent the write rather than describe it.
 */
import { readMetaWritePosture } from "@/lib/meta/automation-write-guard";
import { resolveEffectiveMetaModes } from "@/lib/meta/automation-control-plane";
import type { MetaAutomationDecisionType } from "@/lib/meta/automation-control-plane";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";

export type ScheduledAuthorityRefusal =
  | "release_gate_closed"
  | "auto_execution_disabled"
  | "account_not_activated"
  | "enabling_actor_absent"
  | "scheduled_authority_changed"
  | "dry_run_guardrail"
  | "mode_not_auto"
  | "kill_switch_engaged";

export interface ScheduledAuthorityGates {
  releaseGateOpen: boolean;
  autoExecutionEnabled: boolean;
  enabledProviderAccountId: string | null;
  enablingActorUserId: string | null;
  activationControlVersion: string | null;
  dryRunOnly: boolean;
}

export interface ScheduledAuthorityExpectation {
  /** The account this row is for; one account's activation never enables another. */
  providerAccountId: string;
  /** The admin whose activation this execution acts under. */
  expectedEnablingActorUserId: string;
  /** The activation control version the claim was taken under. */
  expectedActivationControlVersion: string;
  decisionType: MetaAutomationDecisionType;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The six checks, in the order that refuses most cheaply first.
 *
 * Pure: it decides from readings the caller made, so the same function can run
 * before the claim and again immediately before the POST without either call
 * having to know which one it is.
 */
export function evaluateScheduledAuthority(input: {
  gates: ScheduledAuthorityGates;
  expectation: ScheduledAuthorityExpectation;
  mode: "manual" | "semi_auto" | "auto";
  killSwitchEngaged: boolean;
}): { authorized: true } | { authorized: false; refusal: ScheduledAuthorityRefusal } {
  if (input.killSwitchEngaged) {
    return { authorized: false, refusal: "kill_switch_engaged" };
  }
  if (input.gates.releaseGateOpen !== true) {
    return { authorized: false, refusal: "release_gate_closed" };
  }
  // Unattended dispatch is exactly what `auto` means; the other two modes stop
  // at the queue by design.
  if (input.mode !== "auto") {
    return { authorized: false, refusal: "mode_not_auto" };
  }
  if (input.gates.autoExecutionEnabled !== true) {
    return { authorized: false, refusal: "auto_execution_disabled" };
  }
  if (
    input.gates.enabledProviderAccountId !== input.expectation.providerAccountId
  ) {
    return { authorized: false, refusal: "account_not_activated" };
  }
  if (
    !UUID.test(input.gates.enablingActorUserId ?? "") ||
    input.gates.enablingActorUserId !== input.expectation.expectedEnablingActorUserId
  ) {
    return { authorized: false, refusal: "enabling_actor_absent" };
  }
  if (
    !input.gates.activationControlVersion ||
    input.gates.activationControlVersion !==
      input.expectation.expectedActivationControlVersion
  ) {
    // The activation this execution acts under has been superseded. It is not
    // this row's authority any more, whatever it was when the claim was taken.
    return { authorized: false, refusal: "scheduled_authority_changed" };
  }
  if (input.gates.dryRunOnly === true) {
    return { authorized: false, refusal: "dry_run_guardrail" };
  }
  return { authorized: true };
}

/** Which standing mode governs a queued action. */
export function decisionTypeForProposedAction(
  action: MetaAutomationProposal["proposedAction"],
): MetaAutomationDecisionType {
  switch (action) {
    case "bid":
      return "bid";
    case "budget":
      return "budget";
    case "duplicate":
    case "launch":
      return "creative";
    default:
      // `pause` and `resume` are both the pause family: one stops delivery and
      // the other undoes that, and an operator who armed one armed the other.
      return "pause";
  }
}

/**
 * The same question, asked of the ROW rather than of the verb.
 *
 * Turning on what a launch created is raised as `resume`, because that is what
 * it does to the entity — but it is not the pause family. It publishes work an
 * operator staged in Launchpad, under the creative standing mode and behind an
 * activation approval, and reading it by its verb alone would arm it from the
 * pause mode instead: an operator who armed unattended pausing would find
 * themselves dispatching an activation they never armed, with no approval
 * check and no route back to the intent that authorized it.
 *
 * The lineage is the only thing that separates the two, so anything deciding
 * how a row may be dispatched asks this rather than
 * {@link decisionTypeForProposedAction}, which stays exactly as it is for the
 * callers that genuinely only have a verb.
 */
export function decisionTypeForProposal(
  proposal: Pick<MetaAutomationProposal, "proposedAction" | "launchIntentId">,
): MetaAutomationDecisionType {
  if (proposal.launchIntentId) return "creative";
  return decisionTypeForProposedAction(proposal.proposedAction);
}

/**
 * Build the `beforeMutationAttempt` hook the write adapters accept.
 *
 * It throws on refusal, which is what stops the POST: the adapters run this
 * after every one of their own checks and immediately before the request, so a
 * throw here means no provider contact happened at all.
 */
export function scheduledPreDispatchGuard(input: {
  businessId: string;
  expectation: ScheduledAuthorityExpectation;
  readGates: () => Promise<ScheduledAuthorityGates | null>;
}): () => Promise<void> {
  return async () => {
    const [gates, modes, block] = await Promise.all([
      input.readGates().catch(() => null),
      resolveEffectiveMetaModes(input.businessId).catch(() => null),
      // The shared posture, so the capability and the readiness tier reach the
      // unattended path too rather than only the STOP.
      readMetaWritePosture({ businessId: input.businessId }).catch(() => null),
    ]);
    // An unreadable gate at the write boundary is a refusal. "We could not
    // check" and "it is fine" are different answers and only one of them may
    // reach a provider.
    if (!gates || !modes || !block) {
      throw new Error("scheduled_authority_unreadable");
    }
    const verdict = evaluateScheduledAuthority({
      gates,
      expectation: input.expectation,
      mode: modes[input.expectation.decisionType],
      killSwitchEngaged: block.blocked,
    });
    if (!verdict.authorized) {
      throw new Error(verdict.refusal);
    }
  };
}
