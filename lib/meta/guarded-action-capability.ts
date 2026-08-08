/**
 * What a decision's action is allowed to do, right now, for this viewer.
 *
 * The client renders this; it never derives it. Every input that could widen
 * authority is an explicit denial by default, so the absence of a signal blocks
 * rather than permits — a capability that fails open is not a guard.
 *
 * Execution is additionally held behind a runtime gate that is off unless
 * deliberately enabled, because the canonical execution contracts (D065/D067)
 * are not present in this branch. Until they are, the honest ceiling is a dry
 * run: everything up to the provider boundary, and nothing across it.
 */

import type { MetaOsDecisionAction } from "@/lib/meta/decisions-os-contract";

export type GuardedActionCapability =
  | "hidden"
  | "review_only"
  | "preflight_eligible"
  | "dry_run_eligible"
  | "execute_eligible"
  | "blocked";

export interface GuardedActionState {
  capability: GuardedActionCapability;
  /** Shown to the operator whenever the action is anything but executable. */
  reason: string | null;
  /** True only when a provider call could actually be made. */
  providerCallPermitted: boolean;
}

export const META_EXECUTION_ENV_FLAG = "META_GUARDED_EXECUTION_ENABLED";

/**
 * Whether live provider execution is switched on at all.
 *
 * Off unless the flag is exactly "1". Anything else — unset, empty, "true",
 * "yes" — is off, so a typo cannot enable writes.
 */
export function isGuardedExecutionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[META_EXECUTION_ENV_FLAG] === "1";
}

export function resolveGuardedActionCapability(input: {
  action: MetaOsDecisionAction | null | undefined;
  /** Business or environment kill switch, in any engaged form. */
  killSwitchEngaged: boolean;
  /** Whether the viewer may write at all. */
  viewerCanWrite: boolean;
  /**
   * Whether the server persisted the exact authorized action for this decision.
   * Without it there is nothing to execute, only something to read.
   */
  hasPersistedAuthority: boolean;
  /** Whether the row is demo, legacy-review or otherwise synthetic. */
  isSynthetic?: boolean;
  env?: Record<string, string | undefined>;
}): GuardedActionState {
  const { action } = input;

  if (!action || action.intent === "none") {
    return { capability: "hidden", reason: null, providerCallPermitted: false };
  }

  if (input.isSynthetic) {
    return {
      capability: "review_only",
      reason: "Demo and review rows carry no write authority.",
      providerCallPermitted: false,
    };
  }

  if (action.intent !== "execute" || action.providerMutation === null) {
    return {
      capability: "review_only",
      reason: "The server did not authorize a provider action for this decision.",
      providerCallPermitted: false,
    };
  }

  if (input.killSwitchEngaged) {
    return {
      capability: "blocked",
      reason: "The kill switch is engaged, so no provider write may start.",
      providerCallPermitted: false,
    };
  }

  if (!input.viewerCanWrite) {
    return {
      capability: "review_only",
      reason: "Your access allows reading this decision, not acting on it.",
      providerCallPermitted: false,
    };
  }

  if (!input.hasPersistedAuthority) {
    return {
      capability: "preflight_eligible",
      reason:
        "No persisted authorization exists for this exact action yet, so it can be checked but not run.",
      providerCallPermitted: false,
    };
  }

  if (!isGuardedExecutionEnabled(input.env)) {
    return {
      capability: "dry_run_eligible",
      reason:
        "Live execution is disabled in this build. A dry run verifies the target and stops before the provider.",
      providerCallPermitted: false,
    };
  }

  return { capability: "execute_eligible", reason: null, providerCallPermitted: true };
}

/** Copy for the single command a card may show. */
export function describeGuardedCapability(capability: GuardedActionCapability): string {
  switch (capability) {
    case "hidden":
      return "";
    case "review_only":
      return "Review only";
    case "preflight_eligible":
      return "Run preflight";
    case "dry_run_eligible":
      return "Dry run";
    case "execute_eligible":
      return "Execute";
    case "blocked":
      return "Blocked";
  }
}
