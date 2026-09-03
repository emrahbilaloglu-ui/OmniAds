/**
 * PRE-DEPLOY AUDIT — the two-key release posture, as three named phases.
 *
 * ## The confusion this replaces
 *
 * "Automation is OFF" was used for two states that look identical in a
 * database readback and are not the same release at all:
 *
 *   - the capability is not even present in the environment, so nobody COULD
 *     enable a business; and
 *   - the capability is present and every business is deliberately left off,
 *     so an admin can enable one through the UI ceremony whenever they choose.
 *
 * The automation-OFF readback returns PASS for both, correctly — it measures
 * database rows and says so. But PASS was being read as "the release is
 * finished", and for the first state it is not: the product ships a master
 * switch that cannot be turned on, and the operator discovers that only when
 * they try. Shipping a control that silently refuses is the failure mode this
 * whole release exists to remove, so it must not be the state the release ends
 * in.
 *
 * ## The three phases
 *
 *   A. `predeploy_validation` — `META_AUTOMATION_LIVE_WRITES` absent or false,
 *      every database master switch OFF and every schema default OFF. This is
 *      what migration validation runs against, and it is NOT a finished
 *      release.
 *   B. `capability_open_zero_enabled` — reachable ONLY after an exact-SHA
 *      deployment and a successful post-migration readback. The environment
 *      capability may then be true while every business master switch and
 *      every schema default stays OFF. **This is the final desired release
 *      posture:** enabling is possible, nothing is enabled.
 *   C. `business_enabled_by_operator` — an admin later enables exactly one
 *      business through the UI ceremony. This is a user action, never a
 *      deployment step, and it is not part of the release.
 *
 * ## What this module is and is not
 *
 * It is a CLASSIFIER over an observation. It reads nothing, touches no
 * environment and opens no connection: callers hand it what they measured and
 * it names the phase. That keeps it usable from a test, a runbook script and a
 * surface without any of them acquiring the authority to change a posture.
 *
 * It grants nothing. `automationLiveWrites` in `lib/meta/release-gates.ts` and
 * the per-business control row remain the only things the runtime obeys.
 */

export const AUTOMATION_RELEASE_PHASES = [
  "predeploy_validation",
  "capability_open_zero_enabled",
  "business_enabled_by_operator",
] as const;

export type AutomationReleasePhase = (typeof AUTOMATION_RELEASE_PHASES)[number];

/** Exactly one phase is the finished release. Named once, here. */
export const FINAL_RELEASE_PHASE: AutomationReleasePhase = "capability_open_zero_enabled";

export const AUTOMATION_RELEASE_POSTURE_CONTRACT =
  "meta.automation-release-posture.v1" as const;

/**
 * What an operator (or a runbook) measured.
 *
 * Every field is nullable and `null` means UNKNOWN, never "off". A failed read
 * is not evidence of absence, and the classifier refuses on it rather than
 * quietly treating it as a pass.
 */
export interface AutomationPostureObservation {
  /** `META_AUTOMATION_LIVE_WRITES`: true, false, or null when absent/unread. */
  readonly envCapability: boolean | null;
  /** Businesses whose `auto_execution_enabled` is TRUE. Null when unread. */
  readonly enabledBusinessCount: number | null;
  /** Whether `auto_execution_enabled` still defaults FALSE in the schema. */
  readonly schemaDefaultsOff: boolean | null;
  /** The exact image SHA proven deployed, or null when not proven. */
  readonly deployedSha: string | null;
  /** Whether the post-migration automation-OFF readback returned all PASS. */
  readbackPassed: boolean | null;
}

export interface AutomationPostureVerdict {
  readonly contract: typeof AUTOMATION_RELEASE_POSTURE_CONTRACT;
  /** Null when the observation cannot decide a phase. Never guessed. */
  readonly phase: AutomationReleasePhase | null;
  /** True ONLY for phase B. An absent or false capability is never final. */
  readonly isFinalReleasePosture: boolean;
  /** Why it is not final, or why it could not be classified. */
  readonly blockers: readonly string[];
  /** What an operator does next, in one sentence. */
  readonly nextAction: string;
}

/** The refusal codes, so a caller can branch without matching prose. */
export const AUTOMATION_POSTURE_BLOCKERS = {
  envUnknown: "env_capability_unknown",
  envClosed: "env_capability_absent_or_false",
  enabledCountUnknown: "enabled_business_count_unknown",
  schemaDefaultsUnknown: "schema_defaults_unknown",
  schemaDefaultsOn: "schema_default_is_on",
  enabledWhileClosed: "business_enabled_while_capability_closed",
  shaUnproven: "exact_sha_deployment_unproven",
  readbackUnproven: "post_migration_readback_unproven",
} as const;

/**
 * Name the phase, or refuse.
 *
 * The ordering is deliberate and load-bearing:
 *
 *  1. UNKNOWNS refuse first. A null capability with zero enabled businesses
 *     looks exactly like phase A, and reporting it as A would let a failed
 *     environment read be recorded as a validated pre-deploy state.
 *  2. An enabled business while the capability is closed is a CONTRADICTION,
 *     not a phase. It means a control row survived from somewhere; it is
 *     reported as its own blocker rather than folded into A or C.
 *  3. Phase B additionally requires the exact-SHA deployment and a passing
 *     readback, because those are the two things that make opening the
 *     capability safe. Without them the answer is A with named blockers — the
 *     capability is simply not yet allowed to be open.
 */
export function classifyAutomationReleasePosture(
  observation: AutomationPostureObservation,
): AutomationPostureVerdict {
  const blockers: string[] = [];
  const base = {
    contract: AUTOMATION_RELEASE_POSTURE_CONTRACT,
    isFinalReleasePosture: false,
  } as const;

  if (observation.envCapability === null) blockers.push(AUTOMATION_POSTURE_BLOCKERS.envUnknown);
  if (observation.enabledBusinessCount === null) {
    blockers.push(AUTOMATION_POSTURE_BLOCKERS.enabledCountUnknown);
  }
  if (observation.schemaDefaultsOff === null) {
    blockers.push(AUTOMATION_POSTURE_BLOCKERS.schemaDefaultsUnknown);
  }
  if (blockers.length > 0) {
    return {
      ...base,
      phase: null,
      blockers,
      nextAction:
        "Re-run the measurement. An unread value is unknown, and unknown is never reported as a posture.",
    };
  }

  if (observation.schemaDefaultsOff === false) {
    blockers.push(AUTOMATION_POSTURE_BLOCKERS.schemaDefaultsOn);
  }

  const capabilityOpen = observation.envCapability === true;
  const enabled = observation.enabledBusinessCount ?? 0;

  if (!capabilityOpen) {
    if (enabled > 0) {
      /*
        A business is enabled while the environment cannot execute. Nothing
        will run — the release gate is checked before any database work — but
        the row is live and the moment the capability opens it becomes active
        without anyone performing the ceremony. It is a defect, not a phase.
      */
      return {
        ...base,
        phase: null,
        blockers: [...blockers, AUTOMATION_POSTURE_BLOCKERS.enabledWhileClosed],
        nextAction:
          `Disable the ${enabled} enabled business(es) before opening the capability;`
          + " opening it would activate them without a ceremony.",
      };
    }
    return {
      ...base,
      phase: "predeploy_validation",
      blockers: [...blockers, AUTOMATION_POSTURE_BLOCKERS.envClosed],
      nextAction:
        "This is phase A, migration validation — NOT the finished release."
        + " Deploy the exact SHA, run the post-migration readback, then open the capability (phase B).",
    };
  }

  if (enabled > 0) {
    return {
      ...base,
      phase: "business_enabled_by_operator",
      blockers,
      nextAction:
        `Phase C: ${enabled} business(es) enabled by an admin through the UI ceremony.`
        + " This is a user action, not a release step.",
    };
  }

  // Capability open, nothing enabled — phase B, if it was reached legitimately.
  if (!observation.deployedSha) blockers.push(AUTOMATION_POSTURE_BLOCKERS.shaUnproven);
  if (observation.readbackPassed !== true) {
    blockers.push(AUTOMATION_POSTURE_BLOCKERS.readbackUnproven);
  }
  if (blockers.length > 0) {
    return {
      ...base,
      phase: "predeploy_validation",
      blockers,
      nextAction:
        "The capability is open but the two preconditions are not proven."
        + " Close it, prove the exact-SHA deployment and the readback, then re-open.",
    };
  }

  return {
    contract: AUTOMATION_RELEASE_POSTURE_CONTRACT,
    phase: FINAL_RELEASE_PHASE,
    isFinalReleasePosture: true,
    blockers: [],
    nextAction:
      "Final release posture reached: enabling is possible and nothing is enabled."
      + " An admin may now enable one business through the UI ceremony (phase C).",
  };
}

/**
 * The one-line summary a runbook or a report prints.
 *
 * Written so the two states that used to be confused cannot render the same
 * way: phase A always says "not the final posture" in the same sentence that
 * says automation is off.
 */
export function describeAutomationPosture(verdict: AutomationPostureVerdict): string {
  if (verdict.phase === null) {
    return `Posture UNKNOWN (${verdict.blockers.join(", ")}). ${verdict.nextAction}`;
  }
  if (verdict.isFinalReleasePosture) {
    return "Phase B · capability available, zero businesses enabled — FINAL release posture.";
  }
  if (verdict.phase === "predeploy_validation") {
    return "Phase A · automation OFF and capability closed — NOT the final release posture.";
  }
  return "Phase C · at least one business enabled by an admin ceremony.";
}
