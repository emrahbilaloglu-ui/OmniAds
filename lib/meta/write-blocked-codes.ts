/**
 * Every error code a blocked write posture can answer with.
 *
 * `metaWriteBlockedResponse` used to say the literal `kill_switch_engaged`
 * whatever refused, so a caller asking "is this the blocked-posture refusal?"
 * could test one string. Now that the code names the posture — a closed release
 * capability, a demo business, a read-only readiness tier, an unreadable
 * control row — four callers that HALT a multi-entity sequence on it, and
 * answer 503 for it, would silently stop halting on five of the six. This is
 * that question, asked once.
 *
 * It lives in its own module, importing nothing, on purpose: the callers are
 * route handlers and execution runtimes that have no business pulling in a
 * `NextResponse` builder and the control plane behind it to ask a question
 * about a string. A suite that mocks `automation-write-guard` for its posture
 * reader would otherwise get `undefined` here and throw at the halt check.
 *
 * `kill_switch_state_unavailable` is included because the bulk ad-status route
 * has always treated an unreadable kill switch as a halt, and that is the same
 * fail-closed judgement.
 */
export const META_WRITE_BLOCKED_CODES: readonly string[] = Object.freeze([
  "kill_switch_engaged",
  "kill_switch_state_unavailable",
  "META_ADS_WRITE_KILL_SWITCH",
  "business_kill_switch",
  "demo_business_read_only",
  "control_state_unavailable",
  "automation_guard_rule",
  "release_capability_closed",
  "readiness_tier_read_only",
]);

/** Whether an error code is one of the blocked-posture refusals above. */
export function isMetaWriteBlockedCode(code: unknown): boolean {
  return typeof code === "string" && META_WRITE_BLOCKED_CODES.includes(code);
}
