/**
 * What a decision's action is allowed to do, right now, for this viewer.
 *
 * The client renders this; it never derives it. Every input that could widen
 * authority is an explicit denial by default, so the absence of a signal blocks
 * rather than permits — a capability that fails open is not a guard.
 *
 * Execution is additionally held behind a runtime gate that is off unless
 * deliberately enabled. The honest ceiling until that gate is opened in a
 * deployed build is a dry run: everything up to the provider boundary, and
 * nothing across it.
 *
 * D065 governs what may be derived here: Cut authorizes only `pause`, Scale
 * authorizes only `resume`, and a null or disagreeing action fails closed even
 * when the published label happens to read `cut` or `scale`. The server re-read
 * is the authority for that derivation; this resolver refuses to *offer* a
 * command whose label and mutation already contradict each other, so a
 * contradiction is never presented to an operator as something they may run.
 *
 * D064 bars execution without complete exact-Ad lineage: `legacy_review_only`
 * and `demo_synthetic_review_only` rows are never eligible, so an action with
 * no published Ad label behind it stays review-only.
 */

import type { MetaOsDecisionAction } from "@/lib/meta/decisions-os-contract";

/**
 * The only provider action each canonical decision label authorizes (D065).
 * Absent from this map means the label authorizes no provider write at all.
 */
const AUTHORIZED_MUTATION_BY_LABEL: Readonly<
  Record<string, "pause" | "resume">
> = {
  cut: "pause",
  scale: "resume",
};

export function deriveAuthorizedMutation(
  publishedLabel: string | null | undefined,
): "pause" | "resume" | null {
  if (!publishedLabel) return null;
  return AUTHORIZED_MUTATION_BY_LABEL[publishedLabel.trim().toLowerCase()] ?? null;
}

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
  /**
   * The canonical published decision label for the exact Ad behind this action.
   * Absent means there is no exact-Ad lineage to execute against (D064).
   */
  publishedLabel?: string | null;
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

  // D065/D064: the label must actually authorize this exact mutation. A missing
  // label is missing exact-Ad lineage, and a disagreeing one is a contradiction
  // — neither may be offered as a runnable command, whatever the flags say.
  const authorizedMutation = deriveAuthorizedMutation(input.publishedLabel);
  if (authorizedMutation === null) {
    return {
      capability: "review_only",
      reason: input.publishedLabel
        ? `A ${input.publishedLabel} decision authorizes no provider write.`
        : "This action has no exact published decision behind it, so it stays review-only.",
      providerCallPermitted: false,
    };
  }
  if (authorizedMutation !== action.providerMutation) {
    return {
      capability: "blocked",
      reason: `This decision reads ${input.publishedLabel} but carries a ${action.providerMutation} action. Those disagree, so nothing may run.`,
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
