/**
 * The unattended executor for a queued ACTIVATION row.
 *
 * `activateLaunchIntent` has had a `{ kind: "scheduled" }` arm since it was
 * written — the arm that validates the stored approval, narrows an `ad`-scoped
 * one and refuses everything else — and nothing has ever called it. The only
 * production caller passes `{ kind: "operator" }`, so the entire approval
 * contract was unreachable code guarding a door nobody could open.
 *
 * This is that caller. Its whole job is to reach `activateLaunchIntent` with a
 * scheduled authorization and a per-step `authorize` re-read; it re-implements
 * nothing. Ordering, the two-status read-back, the no-blind-retry gate and the
 * journal already live in `hierarchy-activation.ts` and
 * `launch-intent-activation.ts`, and a second copy of any of them here would be
 * a second answer to "is this ad live".
 *
 * ## Why the row's verb cannot decide anything
 *
 * An activation is raised as `resume`, because that is what it does to the
 * entity. `resume` is already an automatable family and
 * `decisionTypeForProposedAction` maps it to the PAUSE mode — so a row routed
 * by its verb would be armed by the standing mode for pausing, dispatched by
 * the ordinary status runtime, and would turn on one entity with no approval
 * check, no ordering and no route back to the intent that authorized it. The
 * `launchIntentId` is the only thing separating the two, which is why the sweep
 * routes on the row and this runtime refuses one without lineage.
 *
 * ## What a blocked step is
 *
 * Not a refusal. A campaign that came on and an ad set that did not is a real,
 * ordinary outcome with a verified provider write inside it, so it settles as a
 * failed dispatch carrying the steps — never as `withheld`, which would say no
 * provider was contacted.
 */
import { getMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import { resolveMetaLaunchWriteContext } from "@/lib/launchpad/meta-validation";
import {
  activateLaunchIntent,
  type LaunchActivationResult,
} from "@/lib/meta/launch-intent-activation";
import type { ActivationTarget } from "@/lib/meta/hierarchy-activation";
import { readMetaWritePosture } from "@/lib/meta/automation-write-guard";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { missingSteps, writeFamily } from "@/lib/meta/write-safety-contract";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type {
  BudgetProposalExecutionResult,
  BudgetProposalWithheldReason,
} from "@/lib/meta/budget-proposal-runtime";
import {
  evaluateScheduledAuthority,
  type ScheduledAuthorityGates,
} from "@/lib/meta/scheduled-action-execution";

export interface ScheduledActivationRuntimeInput {
  proposal: MetaAutomationProposal;
  dryRunOnly: boolean;
  claimToken: string | null;
  authorization:
    | { kind: "manual"; explicitConfirmation: boolean; operatorUserId: string }
    | {
        kind: "scheduled";
        expectedEnablingActorUserId: string;
        expectedActivationControlVersion: string;
      };
  beforeProviderPost?: () => Promise<boolean>;
}

export interface ScheduledActivationRuntimeDeps {
  readGates: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<ScheduledAuthorityGates | null>;
  readMode: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<"manual" | "semi_auto" | "auto" | null>;
  readIntent?: (input: {
    businessId: string;
    id: string;
  }) => Promise<MetaLaunchIntent | null>;
  /** The activation sequence itself. Defaulted to the one production uses. */
  activate?: typeof activateLaunchIntent;
  now?: () => Date;
}

export function createScheduledActivationRuntime(
  deps: ScheduledActivationRuntimeDeps,
): (
  input: ScheduledActivationRuntimeInput,
) => Promise<BudgetProposalExecutionResult> {
  const now = deps.now ?? (() => new Date());
  const readIntent = deps.readIntent ?? getMetaLaunchIntent;
  const activate = deps.activate ?? activateLaunchIntent;
  return async (input) => {
    const { proposal, claimToken } = input;
    const withheld = (
      reason: BudgetProposalWithheldReason,
    ): BudgetProposalExecutionResult => ({
      ok: false,
      receipt: {
        httpStatus: 422,
        response: null,
        dryRun: input.dryRunOnly,
        dispatchedAt: now().toISOString(),
        endpoint: null,
        withheld: reason,
        receiptKey: claimToken,
        providerMutationAttempted: false,
      },
      reconcile: false,
      rollbackRequested: false,
      journalId: null,
    });

    if (proposal.proposedAction !== "resume") return withheld("composition_blocked");
    // Without the lineage this is an ordinary un-pause, and an ordinary
    // un-pause is not this runtime's to make.
    if (!proposal.launchIntentId) return withheld("launch_intent_absent");
    if (!claimToken) return withheld("claim_absent");

    const gates = await deps.readGates({ proposal }).catch(() => null);
    const mode = await deps.readMode({ proposal }).catch(() => null);
    const posture = await readMetaWritePosture({
      businessId: proposal.businessId,
    }).catch(() => null);
    if (!gates || !mode || !posture) return withheld("control_state_unavailable");
    if (posture.blocked) {
      return withheld(
        posture.reason === "release_capability_closed"
          ? "release_gate_closed"
          : posture.reason === "readiness_tier_read_only"
            ? "auto_execution_disabled"
            : "kill_switch_engaged",
      );
    }
    /*
      Rehearsal refuses, exactly as the operator's own activation route does.

      The whole value of the step is the effective status coming back ACTIVE,
      and a rehearsal cannot produce one. A receipt saying an activation was
      rehearsed would be a receipt about nothing.
    */
    if (posture.rehearsal || input.dryRunOnly === true) {
      return withheld("dry_run_guardrail");
    }
    if (input.authorization.kind !== "scheduled") {
      return withheld("manual_confirmation_absent");
    }
    const expectation = {
      providerAccountId: proposal.providerAccountId,
      expectedEnablingActorUserId: input.authorization.expectedEnablingActorUserId,
      expectedActivationControlVersion:
        input.authorization.expectedActivationControlVersion,
      // The creative mode, for the reason in this module's header.
      decisionType: "creative" as const,
    };
    const first = evaluateScheduledAuthority({
      gates, expectation, mode, killSwitchEngaged: false,
    });
    if (!first.authorized) return withheld(first.refusal);

    /*
      Launchpad's own gate, against the ACTIVATION family's declaration.

      `launchpad_create` declares its rollback step not-applicable because every
      create is PAUSED and nothing begins spending. Activation is the write that
      ends that, so checking it against the create's record would let it pass on
      a reason that is false of it.
    */
    const gateRefusal = launchpadActivationGateRefusal();
    if (gateRefusal) return withheld(gateRefusal);

    const intent = await readIntent({
      businessId: proposal.businessId,
      id: proposal.launchIntentId,
    }).catch(() => null);
    if (!intent) return withheld("launch_intent_unreadable");
    // One account's activation never authorizes another's.
    if (intent.providerAccountId !== proposal.providerAccountId) {
      return withheld("composition_blocked");
    }

    const writeContext = await resolveMetaLaunchWriteContext(
      proposal.businessId,
      intent.providerAccountId,
    ).catch(() => null);
    if (!writeContext || !writeContext.ok) {
      return withheld("launch_write_context_unavailable");
    }

    /*
      The dispatch marker, fired from inside the per-step authority check.

      It cannot fire earlier. `activateLaunchIntent` validates the stored
      approval before it plans anything, and most refusals — no approval at all
      is the ordinary case — never reach a provider. Marking above that would
      stamp a dispatch on a row that made no call, which is the exact defect the
      queue's pre-marker rule exists to avoid. `authorize` runs after the
      already-active read and immediately before each step's own POST, so this
      is both the first moment a call becomes possible and the last moment it
      can still be prevented.
    */
    let marked = false;
    let providerMutationAttempted = false;
    const authorize = async (_target: ActivationTarget): Promise<string | null> => {
      const [currentGates, currentMode, currentPosture] = await Promise.all([
        deps.readGates({ proposal }).catch(() => null),
        deps.readMode({ proposal }).catch(() => null),
        readMetaWritePosture({ businessId: proposal.businessId }).catch(() => null),
      ]);
      if (!currentGates || !currentMode || !currentPosture) {
        return "control_state_unavailable";
      }
      if (currentPosture.blocked) return currentPosture.reason ?? "kill_switch_engaged";
      // A STOP or a rehearsal engaged between the campaign step and the ad-set
      // step stops the sequence where it is. Nothing is rolled back: the
      // campaign really is on, and turning it back off would discard a verified
      // write to make a report tidier.
      if (currentPosture.rehearsal) return "dry_run_guardrail";
      const verdict = evaluateScheduledAuthority({
        gates: currentGates, expectation, mode: currentMode, killSwitchEngaged: false,
      });
      if (!verdict.authorized) return verdict.refusal;
      const lateGate = launchpadActivationGateRefusal();
      if (lateGate) return lateGate;
      if (!marked && input.beforeProviderPost) {
        const ok = await input.beforeProviderPost();
        if (!ok) return "dispatch_marker_unavailable";
        marked = true;
      }
      providerMutationAttempted = true;
      return null;
    };

    let result: LaunchActivationResult;
    try {
      result = await activate({
        intent,
        ctx: writeContext.ctx,
        // The stored approval is the ENTIRE authority here. Nobody is present,
        // and this runtime must never claim otherwise.
        authorization: { kind: "scheduled" },
        authorize,
        /*
          The authority itself, re-read before every step, through this
          runtime's own reader.

          The per-step hook above re-reads gates, mode and posture, and for a
          long time that was the whole of it: the approval was validated once
          from the intent loaded at the top, so an operator revoking it after
          the campaign step still had the ad set and the ad turned on under a
          withdrawn permission. The approval is the one authority nobody was
          re-asking, and it is the only one that names this exact payload.
        */
        reloadIntent: () =>
          readIntent({
            businessId: proposal.businessId,
            id: proposal.launchIntentId!,
          }),
      });
    } catch {
      /*
        The sequence entered and produced no answer. Whether a resume is live is
        decided by the durable claim rows, so this reports the honest unknown.
      */
      return {
        ok: false,
        receipt: {
          httpStatus: 502,
          response: null,
          dryRun: false,
          dispatchedAt: now().toISOString(),
          endpoint: `/launchpad/intents/${intent.id}/activate`,
          withheld: null,
          receiptKey: claimToken,
          providerMutationAttempted,
        },
        reconcile: providerMutationAttempted,
        rollbackRequested: false,
        journalId: null,
      };
    }

    if (!result.ok) {
      /*
        A refusal, in the receipt's own vocabulary.

        `LaunchActivationRefusal` is assigned straight into the withheld union
        rather than mapped, so a refusal code added there and forgotten in
        `BUDGET_PROPOSAL_WITHHELD_REASONS` is a compile error instead of an
        operator reading `composition_blocked` and learning nothing.
      */
      const refusal: BudgetProposalWithheldReason = result.refusal;
      return withheld(refusal);
    }

    const { activation, receipt } = result;
    /*
      Park rather than re-offer.

      An ambiguous step may have landed, and an unresolved prior attempt means
      an earlier one already may have. Either way the next tick must not send
      the same status change to a live entity — which is what `reconcile` buys:
      the row leaves the pending page and waits for a person.
    */
    const needsReconcile = receipt.steps.some(
      (step) =>
        step.claimOutcome === "ambiguous"
        || step.claimOutcome === "unresolved_prior_attempt",
    );
    const contacted = providerMutationAttempted
      || receipt.steps.some((step) => step.actionLogId !== null);

    return {
      ok: activation.delivering === true,
      receipt: {
        httpStatus: activation.delivering ? 200 : 409,
        response: {
          contract: activation.contract,
          intentId: intent.id,
          // The word the surface renders. Never derived from the ad alone: an
          // ad reading ACTIVE under a paused parent shows to nobody.
          delivering: activation.delivering,
          /*
            And the count behind it, because "not delivering" covers two very
            different situations. A launch where nothing came on and one where
            three of five entities are live and spending need different
            sentences, and the receipt is the only place that difference
            survives the request.
          */
          partial: activation.partial,
          coverage: activation.coverage,
          blockedAt: activation.blockedAt,
          blockedReason: activation.blockedReason,
          steps: receipt.steps,
        },
        dryRun: false,
        dispatchedAt: now().toISOString(),
        endpoint: `/launchpad/intents/${intent.id}/activate`,
        // A blocked step is an OUTCOME, not a refusal. Something was written,
        // or read back and found not active; either way a provider was reached.
        withheld: null,
        receiptKey: claimToken,
        providerMutationAttempted: contacted,
      },
      reconcile: needsReconcile,
      rollbackRequested: false,
      journalId: receipt.steps.find((step) => step.actionLogId)?.actionLogId ?? null,
    };
  };
}

/** The activation family's own gate. See the call site for why it is not the create's. */
function launchpadActivationGateRefusal(): BudgetProposalWithheldReason | null {
  if (readMetaReleaseGates().launchpadExecution !== true) {
    return "launchpad_execution_gated";
  }
  if (missingSteps(writeFamily("launchpad_activation")).length > 0) {
    return "launchpad_safety_step_missing";
  }
  return null;
}
