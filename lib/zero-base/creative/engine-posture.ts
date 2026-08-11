/**
 * The five Engine V3 postures a creative surface can be in.
 *
 * These are not five labels invented for the UI. They are the distinct states
 * the served response and its flags can actually express, and each one changes
 * what an operator may believe:
 *
 * - `unavailable` — the posture endpoint could not be read. We do not know what
 *   the engine would say, which is different from knowing it says nothing.
 * - `disabled` — the engine is off for this business. There are no decisions,
 *   and there is nothing pending.
 * - `shadow_only` — decisions are computed but carry no authority. They exist
 *   to be compared against, never acted on.
 * - `hidden` — the engine is running and not in shadow, but this surface is not
 *   cleared to show its output. Absence here is a policy, not an emptiness.
 * - `serving` — decisions are live and are the surface's authority.
 *
 * Only `serving` may offer an action. Everything else offers zero, because an
 * action affordance next to a shadow decision is an invitation to act on a
 * number nobody stands behind.
 */
import type { EngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";

export type EnginePosture =
  | "unavailable"
  | "disabled"
  | "shadow_only"
  | "hidden"
  | "serving";

export const ENGINE_POSTURES: readonly EnginePosture[] = [
  "unavailable",
  "disabled",
  "shadow_only",
  "hidden",
  "serving",
];

export interface PostureView {
  posture: EnginePosture;
  label: string;
  /** Always stated. A posture with no explanation is a posture nobody trusts. */
  explanation: string;
  /** True only for `serving`. */
  decisionsAreAuthority: boolean;
}

const VIEW: Record<EnginePosture, Omit<PostureView, "posture">> = {
  unavailable: {
    label: "Decision posture unknown",
    explanation:
      "The decision engine's posture could not be read, so it is unknown whether decisions exist for this account.",
    decisionsAreAuthority: false,
  },
  disabled: {
    label: "Decision engine off",
    explanation: "The decision engine is not enabled for this business, so it produces no decisions.",
    decisionsAreAuthority: false,
  },
  shadow_only: {
    label: "Shadow mode",
    explanation:
      "Decisions are being computed for comparison only. They carry no authority and no action is offered from them.",
    decisionsAreAuthority: false,
  },
  hidden: {
    label: "Decisions not shown here",
    explanation:
      "The engine is running, but its output is not cleared for this surface. Nothing is missing — it is withheld.",
    decisionsAreAuthority: false,
  },
  serving: {
    label: "Serving decisions",
    explanation: "Decisions on this surface are the engine's current output for this account.",
    decisionsAreAuthority: true,
  },
};

/**
 * Derive the posture from what the server served.
 *
 * `flags` null means the read failed. A disabled response is authoritative
 * even when flags are present, because the server already decided.
 */
export function resolveEnginePosture(input: {
  status: "serving" | "disabled" | "unavailable";
  flags: Pick<EngineV3Flags, "enabled" | "surfaceVisible" | "shadowOnly"> | null;
}): EnginePosture {
  if (input.status === "unavailable") return "unavailable";
  if (input.status === "disabled") return "disabled";
  if (!input.flags) return "unavailable";
  if (!input.flags.enabled) return "disabled";
  // Shadow is checked before visibility: a shadow decision that happens to be
  // visible is still a shadow decision, and calling it "serving" would be the
  // most dangerous of the five mistakes.
  if (input.flags.shadowOnly) return "shadow_only";
  if (!input.flags.surfaceVisible) return "hidden";
  return "serving";
}

export function postureView(posture: EnginePosture): PostureView {
  return { posture, ...VIEW[posture] };
}

/**
 * How many action affordances a row may carry.
 *
 * Zero unless the engine is genuinely serving AND the server offered an action
 * for this row. A held decision offers none whatever the posture.
 */
export function creativeActionCount(input: {
  posture: EnginePosture;
  /** The server's own held marker. Never inferred from label text. */
  held: boolean;
  viewerCanAct: boolean;
}): number {
  if (input.posture !== "serving") return 0;
  if (input.held) return 0;
  if (!input.viewerCanAct) return 0;
  return 1;
}
