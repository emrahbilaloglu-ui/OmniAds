/**
 * Operator-facing refusal copy for the Meta release gates.
 *
 * Split from `release-gates.ts` on purpose: this module is imported by client
 * components, and the reader there touches `process.env`. Keeping the strings
 * separate means a screen can state a refusal without dragging server
 * environment access into the browser bundle. The import below is type-only and
 * erases at build, so nothing runtime crosses the boundary — while the
 * `satisfies` clause still fails the build if a gate is added without a reason.
 */
import type { MetaReleaseGates } from "@/lib/meta/release-gates";

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
