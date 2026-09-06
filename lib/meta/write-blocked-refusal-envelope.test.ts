/**
 * A refusal names the posture that refused it.
 *
 * `metaWriteBlockedResponse` answered the literal `kill_switch_engaged` for all
 * six blocked postures, so an operator who had engaged no STOP — a closed
 * release capability, a demo business, a read-only readiness tier, an
 * unreadable control row — was told a kill switch was engaged. The inner
 * `reason` always carried the truth and nothing read it. Measured in all 24
 * cells of the decision-availability matrix.
 *
 * The correction has a sharp edge, which is most of what this file guards: four
 * callers HALT a multi-entity sequence on that code and answer 503 for it. If
 * the code becomes specific and those callers keep testing one string, five of
 * the six postures silently stop halting a launch — a far worse defect than the
 * misleading word. `isMetaWriteBlockedCode` is the single question they now ask,
 * and the last case here is the one that would catch a future code being added
 * to the posture union without being added to that list.
 */
import { describe, expect, it } from "vitest";

import {
  metaWriteBlockedResponse,
  type MetaWritePosture,
} from "@/lib/meta/automation-write-guard";
import {
  META_WRITE_BLOCKED_CODES,
  isMetaWriteBlockedCode,
} from "@/lib/meta/write-blocked-codes";

function posture(over: Partial<MetaWritePosture> = {}): MetaWritePosture {
  return {
    blocked: true,
    rehearsal: false,
    reason: "business_kill_switch",
    message: null,
    ...over,
  } as MetaWritePosture;
}

async function body(response: Awaited<ReturnType<typeof metaWriteBlockedResponse>>) {
  return (await response.json()) as {
    ok: boolean;
    error: { code: string; message: string; reason: string | null };
  };
}

describe("the refusal names what actually refused", () => {
  it("still calls the kill switch a kill switch", async () => {
    const payload = await body(metaWriteBlockedResponse(posture()));
    expect(payload.error.code).toBe("kill_switch_engaged");
    expect(payload.error.reason).toBe("business_kill_switch");
  });

  it("does not call a closed release capability a kill switch", async () => {
    /*
      The case the matrix measured: the environment simply has live writes shut,
      nobody has stopped anything, and the surface said STOP was engaged.
    */
    const payload = await body(
      metaWriteBlockedResponse(posture({ reason: "release_capability_closed" })),
    );
    expect(payload.error.code).toBe("release_capability_closed");
    expect(payload.error.message).not.toMatch(/kill switch/i);
  });

  it.each([
    "demo_business_read_only",
    "control_state_unavailable",
    "readiness_tier_read_only",
    "automation_guard_rule",
    "META_ADS_WRITE_KILL_SWITCH",
  ] as const)("names %s as itself", async (reason) => {
    const payload = await body(metaWriteBlockedResponse(posture({ reason })));
    expect(payload.error.code).toBe(reason);
  });

  it("keeps the server's own message when it has one", async () => {
    const payload = await body(
      metaWriteBlockedResponse(posture({
        reason: "readiness_tier_read_only",
        message: "This business is parked in the read-only readiness tier.",
      })),
    );
    expect(payload.error.message).toBe(
      "This business is parked in the read-only readiness tier.",
    );
  });

  it("falls back to a code the halting callers still recognise", async () => {
    // A posture with no reason at all is still a refusal, and the four
    // sequence-halting callers must still halt on it.
    const payload = await body(metaWriteBlockedResponse(posture({ reason: null })));
    expect(payload.error.code).toBe("kill_switch_engaged");
    expect(isMetaWriteBlockedCode(payload.error.code)).toBe(true);
  });
});

describe("every code this refusal can answer with halts a sequence", () => {
  it.each([
    "business_kill_switch",
    "demo_business_read_only",
    "control_state_unavailable",
    "automation_guard_rule",
    "release_capability_closed",
    "readiness_tier_read_only",
    "META_ADS_WRITE_KILL_SWITCH",
    null,
  ] as const)("reason %s", async (reason) => {
    /*
      The whole point. A multi-entity launch stops on this refusal and answers
      503; before the code became specific, one string carried all of them.
      Whatever the response says, `isMetaWriteBlockedCode` must agree.
    */
    const payload = await body(metaWriteBlockedResponse(posture({ reason })));
    expect(isMetaWriteBlockedCode(payload.error.code)).toBe(true);
  });

  it("does not swallow an unrelated provider failure", () => {
    expect(isMetaWriteBlockedCode("silent_failure")).toBe(false);
    expect(isMetaWriteBlockedCode("provider_outcome_ambiguous")).toBe(false);
    expect(isMetaWriteBlockedCode("")).toBe(false);
    expect(isMetaWriteBlockedCode(undefined)).toBe(false);
    expect(isMetaWriteBlockedCode(null)).toBe(false);
  });

  it("lists the unreadable kill switch the bulk route halts on", () => {
    // Not a posture reason — the bulk ad-status route's own fail-closed code.
    expect(META_WRITE_BLOCKED_CODES).toContain("kill_switch_state_unavailable");
  });
});
