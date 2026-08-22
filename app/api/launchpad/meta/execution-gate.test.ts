import { afterEach, describe, expect, it } from "vitest";

import { rejectIfLaunchpadExecutionGated } from "@/app/api/launchpad/meta/route-utils";
import { META_GATE_REFUSAL_REASONS } from "@/lib/meta/release-gate-copy";

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

  it("allows the write to proceed only on an exact true", () => {
    for (const raw of ["true", "TRUE", " True "]) {
      process.env.META_LAUNCHPAD_EXECUTION = raw;
      expect(rejectIfLaunchpadExecutionGated("launchpad_launch")).toBeNull();
      expect(
        rejectIfLaunchpadExecutionGated("launchpad_add_to_existing"),
      ).toBeNull();
    }
  });

  it("is read per call, so a running process cannot cache an open gate", () => {
    process.env.META_LAUNCHPAD_EXECUTION = "true";
    expect(rejectIfLaunchpadExecutionGated("launchpad_launch")).toBeNull();
    process.env.META_LAUNCHPAD_EXECUTION = "false";
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
