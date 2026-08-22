/**
 * Meta release gates — the presentation half of the staged rollout.
 *
 * These flags decide what the product *offers*, never what it *permits*. Every
 * one of them is read on the server and none is exposed through `NEXT_PUBLIC_*`,
 * because a client-readable value is not a security boundary. Turning a gate on
 * does not grant access to a business, a provider account, a role or a write —
 * that authority lives in the access layer and the individual route guards, and
 * it stays enforced with every gate off. Deleting a gate must therefore never
 * be a way to obtain authorization; it is only a way to obtain an offer.
 *
 * The split matches §18 "Feature flag ayrımı" of
 * `docs/meta-market-ready-master-plan-2026-08-22.md`, so a rollback can retract
 * exactly one capability instead of the whole release.
 *
 * ## Why every gate defaults off
 *
 * An absent, empty, misspelled or unparseable value is off. The shipped state
 * of a gate is off, and a surface behind an off gate is `disabled-with-reason`:
 * present, visibly refusing, and saying why. That is the plan's D8 — a
 * capability that is not proven is not silently rendered as absent, and not
 * rendered as available either.
 *
 * `automationDryRunOnly` is the deliberate inversion. It is a *safety*
 * posture rather than a capability, so its safe value is `true` and it defaults
 * true; only `META_AUTOMATION_LIVE_WRITES=true` lowers it, and even then the
 * server's own guardrail row still has to permit the write.
 */

export interface MetaReleaseGates {
  /**
   * Launchpad may issue provider create calls. Gate for WP15.
   *
   * Off means the Create-PAUSED and Add-to-existing controls are
   * disabled-with-reason. Draft, template, intent and validate are unaffected:
   * preparation is not execution. See
   * `docs/adr-003-launchpad-execution-posture.md`.
   */
  launchpadExecution: boolean;
  /** Decisions workflow controls (assign/acknowledge/defer/…). Gate for WP8. */
  decisionWorkflowUi: boolean;
  /** The Meta Stop engage/release control on Automation. Gate for WP13. */
  automationStopUi: boolean;
  /**
   * Automation proposals may execute for real instead of producing a dry-run
   * receipt. Gate for WP13; the server guardrail row still governs.
   */
  automationLiveWrites: boolean;
  /** Minting new public creative share links. Gate for WP11. */
  publicShareMint: boolean;
  /**
   * The shared provider-account picker in the shell context bar. Gate for WP4.
   *
   * Scope resolution itself is not gated — `resolveProviderAccountId` runs
   * regardless. Only the operator's ability to *change* the selection is.
   */
  accountPicker: boolean;
}

/**
 * Dry-run is the default for Automation execution, and it is expressed as its
 * own reading rather than as `!automationLiveWrites` so that a caller cannot
 * accidentally invert it. D10: "Dry-run varsayılan TRUE."
 */
export interface MetaAutomationPosture {
  dryRunOnly: boolean;
}

/** Only an exact, case-insensitive `true` enables. Everything else is off. */
function parseGate(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

export function readMetaReleaseGates(
  env: NodeJS.ProcessEnv = process.env,
): MetaReleaseGates {
  return {
    launchpadExecution: parseGate(env.META_LAUNCHPAD_EXECUTION),
    decisionWorkflowUi: parseGate(env.META_DECISION_WORKFLOW_UI),
    automationStopUi: parseGate(env.META_AUTOMATION_STOP_UI),
    automationLiveWrites: parseGate(env.META_AUTOMATION_LIVE_WRITES),
    publicShareMint: parseGate(env.META_PUBLIC_SHARE_MINT),
    accountPicker: parseGate(env.META_ACCOUNT_PICKER),
  };
}

export function readMetaAutomationPosture(
  env: NodeJS.ProcessEnv = process.env,
): MetaAutomationPosture {
  // Not `!gates.automationLiveWrites` by accident of refactoring: this is the
  // safety default and it is written so that removing the live-writes gate
  // leaves dry-run ON rather than turning it off.
  return { dryRunOnly: !parseGate(env.META_AUTOMATION_LIVE_WRITES) };
}

/**
 * The operator-facing reason a gated control refuses.
 *
 * One sentence, no environment variable name, no "contact an administrator".
 * The operator is told what is not available and what state the product is in,
 * because a reason that names a flag teaches them to go looking for a flag.
 */
export const META_GATE_REFUSAL_REASONS = Object.freeze({
  launchpadExecution:
    "Creating campaigns on Meta from Launchpad is not enabled yet. Drafts, templates and validation are fully available, and a validated draft will run unchanged once execution is turned on.",
  decisionWorkflowUi:
    "Decision workflow actions are not enabled yet on this workspace.",
  automationStopUi:
    "The Meta Stop control is not enabled yet: releasing it again has not been proven reversible in this environment, and a stop that cannot be released is worse than no stop.",
  automationLiveWrites:
    "Automation runs in dry-run only. Approving a proposal records what would have been sent and contacts Meta for nothing.",
  publicShareMint:
    "Minting new public share links is not enabled yet. Existing links keep working and can still be rotated or revoked.",
  accountPicker: "Changing the Meta ad account is not enabled yet.",
} as const satisfies Record<keyof MetaReleaseGates, string>);
