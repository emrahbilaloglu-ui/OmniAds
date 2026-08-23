import { afterEach, describe, expect, it } from "vitest";

import {
  launchpadExecutionRefusal,
  rejectIfLaunchpadExecutionGated,
} from "@/app/api/launchpad/meta/route-utils";
import { META_GATE_REFUSAL_REASONS } from "@/lib/meta/release-gate-copy";
import {
  WRITE_SAFETY_STEPS,
  missingSteps,
  writeFamily,
} from "@/lib/meta/write-safety-contract";

const ORIGINAL = process.env.META_LAUNCHPAD_EXECUTION;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.META_LAUNCHPAD_EXECUTION;
  else process.env.META_LAUNCHPAD_EXECUTION = ORIGINAL;
});

async function refusalBody(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    error: { code: string; message: string; operation: string };
  };
}

describe("Launchpad execution gate (server side)", () => {
  it("refuses both write operations when the gate is unset", async () => {
    delete process.env.META_LAUNCHPAD_EXECUTION;
    for (const operation of ["launchpad_launch", "launchpad_add_to_existing"] as const) {
      const response = rejectIfLaunchpadExecutionGated(operation);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(503);
      const body = await refusalBody(response!);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("launchpad_execution_disabled");
      expect(body.error.operation).toBe(operation);
      expect(body.error.message).toBe(
        META_GATE_REFUSAL_REASONS.launchpadExecution,
      );
    }
  });

  it("uses 503, not 403 — the caller's authority is not what is missing", async () => {
    delete process.env.META_LAUNCHPAD_EXECUTION;
    // A 403 would send an operator who already holds every permission off to
    // ask for permissions. The same request succeeds unchanged once execution
    // is enabled, which is what 503 says.
    expect(rejectIfLaunchpadExecutionGated("launchpad_launch")!.status).toBe(503);
  });

  it("keeps refusing on every value that is not an exact true", () => {
    for (const raw of ["", " ", "1", "yes", "on", "enabled", "false", "tru"]) {
      process.env.META_LAUNCHPAD_EXECUTION = raw;
      expect(rejectIfLaunchpadExecutionGated("launchpad_launch")).not.toBeNull();
    }
  });

  it("is read per call, so a running process cannot cache a gate value", () => {
    process.env.META_LAUNCHPAD_EXECUTION = "false";
    expect(rejectIfLaunchpadExecutionGated("launchpad_launch")).not.toBeNull();
    process.env.META_LAUNCHPAD_EXECUTION = "true";
    expect(rejectIfLaunchpadExecutionGated("launchpad_launch")).toBeNull();
    process.env.META_LAUNCHPAD_EXECUTION = "";
    expect(rejectIfLaunchpadExecutionGated("launchpad_launch")).not.toBeNull();
  });

  it("does not name the environment variable in the operator's sentence", () => {
    delete process.env.META_LAUNCHPAD_EXECUTION;
    const message = META_GATE_REFUSAL_REASONS.launchpadExecution;
    expect(message).not.toContain("META_LAUNCHPAD_EXECUTION");
    // It must still say what DOES work, or the operator reads it as "Launchpad
    // is broken" and stops preparing drafts that will run unchanged later.
    expect(message).toMatch(/draft/i);
    expect(message).toMatch(/validat/i);
  });
});

describe("the Meta Stop reaches Launchpad", () => {
  it("names the kill-switch guard in both write routes", async () => {
    /**
     * Decisions and Automation both gate on `getMetaWriteBlockState`; Launchpad
     * did not. An engaged business kill switch — or an incident responder
     * setting `META_ADS_WRITE_KILL_SWITCH` — therefore stopped every Meta write
     * except a Launchpad create. A stop that is global in the operator's mind
     * and partial in fact is the worst thing a safety control can be.
     *
     * Asserted at source level because both routes are ~1 000 lines of
     * orchestration whose behavioural coverage lives in their own suites; what
     * needs pinning here is that the guard is present and ordered after the
     * cheaper gate.
     */
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "app/api/launchpad/meta/launch/route.ts",
      "app/api/launchpad/meta/add-to-existing/route.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("rejectIfLaunchpadMetaWritesBlocked");
      expect(
        source.indexOf("rejectIfLaunchpadExecutionGated("),
        file,
      ).toBeLessThan(source.indexOf("rejectIfLaunchpadMetaWritesBlocked("));
    }
  });

  it("refuses when the control plane cannot be read", async () => {
    // Fail-closed: an unreadable control plane must block the write rather than
    // admit it by default.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/launchpad/meta/route-utils.ts", "utf8");
    expect(source).toContain("blocked: true as const");
    expect(source).toContain("control_state_unavailable");
  });
});

describe("P1 — an environment flip cannot open an incomplete write path", () => {
  /**
   * The defect, reproduced before the fix was written.
   *
   * `rejectIfLaunchpadExecutionGated` consulted only `META_LAUNCHPAD_EXECUTION`.
   * `openGatesWithMissingSteps()` existed but was called from a unit test and
   * nowhere else, so the claim "the gate cannot be opened while these steps are
   * missing" was true of the test suite and false of the running server: one
   * environment variable opened the provider-write path while §10 safety steps
   * were still declared missing.
   *
   * The Launchpad family conforms today, so these cases drive the pure decision
   * with an injected missing-step list. A protection that stops being testable
   * the moment the thing it guards is fixed is a protection that silently rots.
   * The runtime function reads both facts itself and has no injection point;
   * `refuses at the route when the flag is on but the safety contract is
   * incomplete` in the launch-route suite covers the wired path.
   */
  const INCOMPLETE = ["independent_provider_readback"] as const;

  it("refuses with the gate OPEN while any safety step is missing", async () => {
    for (const operation of ["launchpad_launch", "launchpad_add_to_existing"] as const) {
      const response = launchpadExecutionRefusal({
        gateOpen: true,
        missingSafetySteps: INCOMPLETE,
        operation,
      });
      expect(response, `${operation} was allowed through`).not.toBeNull();
      expect(response!.status).toBe(503);
      const body = await refusalBody(response!);
      expect(body.error.code).toBe("launchpad_execution_safety_incomplete");
      expect(body.error.operation).toBe(operation);
    }
  });

  it("opens only when the gate is open AND nothing is missing", () => {
    // A conjunction, not an unconditional refusal. Without this the gate could
    // never open once WP15 finished, which is a different bug that would look
    // like safety.
    expect(
      launchpadExecutionRefusal({
        gateOpen: true,
        missingSafetySteps: [],
        operation: "launchpad_launch",
      }),
    ).toBeNull();
    expect(
      launchpadExecutionRefusal({
        gateOpen: false,
        missingSafetySteps: [],
        operation: "launchpad_launch",
      }),
    ).not.toBeNull();
  });

  it("distinguishes 'not enabled' from 'enabled and unsafe'", async () => {
    /**
     * Two different facts, and only one is the operator's to resolve. "Not
     * enabled yet" is a rollout state; the other is a deployment error the
     * operator cannot fix. Collapsing them would tell someone to go asking for
     * a flag that must not be set.
     */
    const off = await refusalBody(
      launchpadExecutionRefusal({
        gateOpen: false,
        missingSafetySteps: [],
        operation: "launchpad_launch",
      })!,
    );
    const unsafe = await refusalBody(
      launchpadExecutionRefusal({
        gateOpen: true,
        missingSafetySteps: INCOMPLETE,
        operation: "launchpad_launch",
      })!,
    );
    expect(off.error.code).toBe("launchpad_execution_disabled");
    expect(unsafe.error.code).toBe("launchpad_execution_safety_incomplete");
    expect(off.error.message).not.toBe(unsafe.error.message);
  });

  it("names no environment variable and no step id to the operator", async () => {
    const body = await refusalBody(
      launchpadExecutionRefusal({
        gateOpen: true,
        missingSafetySteps: WRITE_SAFETY_STEPS,
        operation: "launchpad_launch",
      })!,
    );
    expect(body.error.message).not.toContain("META_LAUNCHPAD_EXECUTION");
    expect(body.error.message).not.toMatch(/env|flag|variable/i);
    for (const step of WRITE_SAFETY_STEPS) {
      expect(body.error.message).not.toContain(step);
    }
    // It must still say what DOES work, or it reads as "Launchpad is broken".
    expect(body.error.message).toMatch(/draft/i);
    expect(body.error.message).toMatch(/validat/i);
  });

  it("the real Launchpad family currently conforms, so the runtime gate opens", () => {
    // The forward-looking half: this is what changed in WP15. If a future edit
    // reopens a gap, the runtime gate closes again on its own.
    expect(missingSteps(writeFamily("launchpad_create"))).toEqual([]);
  });
});
