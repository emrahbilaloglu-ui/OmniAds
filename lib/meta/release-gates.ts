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

/**
 * The slice of the environment these readers may see.
 *
 * Deliberately narrower than `NodeJS.ProcessEnv`: a gate reader has no business
 * touching a credential, and typing it this way also lets a test hand over the
 * two variables under test without having to fabricate a whole environment.
 */
export type MetaGateEnv = Readonly<Record<string, string | undefined>>;

/** Only an exact, case-insensitive `true` enables. Everything else is off. */
function parseGate(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

export function readMetaReleaseGates(
  env: MetaGateEnv = process.env,
): MetaReleaseGates {
  const automationLiveWrites = parseGate(env.META_AUTOMATION_LIVE_WRITES);
  return {
    launchpadExecution: parseGate(env.META_LAUNCHPAD_EXECUTION),
    /*
      One capability, one reading.

      The decision workflow and the mutation ceremony are two halves of the same
      write path, and they were gated by two further variables that no
      environment ever set. Three independent spellings of one capability is how
      `/platforms/meta` came to offer controls `/c/:id/meta/decisions` did not.
      They now follow the single environment capability, and what a viewer may
      actually do is decided by `resolveMetaWriteCapability` on the server.
    */
    decisionWorkflowUi: automationLiveWrites,
    /*
      STOP is deliberately NOT a capability.

      Engaging or releasing the business kill switch — and seeing its state —
      must stay reachable when provider writes are closed, because that is
      exactly when an operator reaches for it. Role, reviewer and demo checks
      still apply on the route.
    */
    automationStopUi: true,
    automationLiveWrites,
    publicShareMint: parseGate(env.META_PUBLIC_SHARE_MINT),
    accountPicker: parseGate(env.META_ACCOUNT_PICKER),
  };
}

export function readMetaAutomationPosture(
  env: MetaGateEnv = process.env,
): MetaAutomationPosture {
  // Not `!gates.automationLiveWrites` by accident of refactoring: this is the
  // safety default and it is written so that removing the live-writes gate
  // leaves dry-run ON rather than turning it off.
  return { dryRunOnly: !parseGate(env.META_AUTOMATION_LIVE_WRITES) };
}
