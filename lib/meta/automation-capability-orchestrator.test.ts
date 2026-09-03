/**
 * PRE-DEPLOY AUDIT — the capability-open/close safety state machine, proven
 * WITHOUT a host: every dependency is an injected callback, so each scenario
 * below simulates exactly one thing failing and asserts the orchestrator's
 * response — no SSH, no Docker, no database, deterministic every run.
 *
 * The four scenarios the task names, each with its own describe block:
 *   - open success
 *   - preflight refusal (never touches the environment)
 *   - post-change failure -> rollback
 *   - close succeeds even under a DB/readiness failure
 */
import { describe, expect, it, vi } from "vitest";
import {
  runCapabilityClose,
  runCapabilityOpen,
  type CapabilityToggleSteps,
  type PreflightStepResult,
  type RuntimeVerifyStepResult,
} from "@/lib/meta/automation-capability-orchestrator";

const PASS_PREFLIGHT: PreflightStepResult = { ok: true, blockers: [] };
const OK_RUNTIME = (envValue: boolean): RuntimeVerifyStepResult => ({
  ok: true, blockers: [], observedEnvValue: envValue, observedBuildId: "deadbeef",
});

function baseSteps(overrides: Partial<CapabilityToggleSteps> = {}): CapabilityToggleSteps {
  return {
    preflightVerify: vi.fn(async () => PASS_PREFLIGHT),
    writeEnvTrue: vi.fn(async () => ({ backupPath: "/tmp/env.bak.1" })),
    writeEnvFalse: vi.fn(async () => ({ backupPath: "/tmp/env.bak.2" })),
    recreateAndVerifyRuntime: vi.fn(async (v: boolean) => OK_RUNTIME(v)),
    restoreEnvBackup: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("runCapabilityOpen — the success path", () => {
  it("passes when preflight, recreate, and the post-open re-check all agree", async () => {
    const steps = baseSteps();
    const outcome = await runCapabilityOpen(steps);
    expect(outcome).toMatchObject({
      action: "open", result: "pass", blockers: [], rolledBack: false, rollbackVerified: false,
    });
    expect(steps.preflightVerify).toHaveBeenCalledTimes(2); // pre-open AND post-open
    expect(steps.writeEnvTrue).toHaveBeenCalledTimes(1);
    expect(steps.recreateAndVerifyRuntime).toHaveBeenCalledWith(true);
    expect(steps.restoreEnvBackup).not.toHaveBeenCalled();
  });

  it("calls recreateAndVerifyRuntime with the INTENDED value true, and checks the OBSERVED one", async () => {
    // A step that returns ok:true but the WRONG observed value must still fail —
    // "the command exited 0" is not "the state is what we asked for".
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async () => ({
        ok: true, blockers: [], observedEnvValue: false, observedBuildId: "x",
      })),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.result).toBe("fail");
    expect(outcome.blockers.join(" | ")).toContain("runtime_verify_failed");
  });
});

describe("runCapabilityOpen — preflight refusal never touches the environment", () => {
  it("returns 'refused' and calls NEITHER write function", async () => {
    const steps = baseSteps({
      preflightVerify: vi.fn(async () => ({ ok: false, blockers: ["Grandmix has auto_execution_enabled = TRUE"] })),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.result).toBe("refused");
    expect(outcome.blockers).toEqual(["Grandmix has auto_execution_enabled = TRUE"]);
    expect(outcome.rolledBack).toBe(false);
    expect(steps.writeEnvTrue).not.toHaveBeenCalled();
    expect(steps.recreateAndVerifyRuntime).not.toHaveBeenCalled();
    expect(steps.restoreEnvBackup).not.toHaveBeenCalled();
  });

  it("names every blocker the preflight reported, not just the first", async () => {
    const steps = baseSteps({
      preflightVerify: vi.fn(async () => ({
        ok: false, blockers: ["master_switch: verdict is FAIL", "IwaTR has auto_execution_enabled = TRUE"],
      })),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.blockers).toHaveLength(2);
  });
});

describe("runCapabilityOpen — a post-change failure triggers rollback", () => {
  it("recreate reporting not-ok: restores the backup, force-closes, verifies closed, and reports fail", async () => {
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async (v: boolean) =>
        v === true
          ? { ok: false, blockers: ["health check timed out"], observedEnvValue: null, observedBuildId: null }
          : OK_RUNTIME(false), // the FORCED close verify succeeds
      ),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.result).toBe("fail");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.rollbackVerified).toBe(true);
    expect(outcome.blockers.join(" | ")).toContain("runtime_verify_failed");
    expect(outcome.blockers.join(" | ")).toContain("health check timed out");
    expect(steps.restoreEnvBackup).toHaveBeenCalledWith("/tmp/env.bak.1");
    // The forced close verify calls recreateAndVerifyRuntime(false) SECOND.
    expect(steps.recreateAndVerifyRuntime).toHaveBeenNthCalledWith(1, true);
    expect(steps.recreateAndVerifyRuntime).toHaveBeenNthCalledWith(2, false);
  });

  it("the post-open re-check failing (recreate silently enabled something) also rolls back", async () => {
    let preflightCalls = 0;
    const steps = baseSteps({
      preflightVerify: vi.fn(async () => {
        preflightCalls += 1;
        // First call (pre-open) passes; second call (post-open) fails.
        return preflightCalls === 1
          ? PASS_PREFLIGHT
          : { ok: false, blockers: ["master_switch: enabled_rows=1 after recreate"] };
      }),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.result).toBe("fail");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.blockers.join(" | ")).toContain("post_open_db_not_zero");
    expect(steps.restoreEnvBackup).toHaveBeenCalledTimes(1);
  });

  it("recreate THROWING (not just returning not-ok) still triggers the same rollback", async () => {
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async (v: boolean) => {
        if (v === true) throw new Error("ssh connection reset");
        return OK_RUNTIME(false);
      }),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.result).toBe("fail");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.blockers.join(" | ")).toContain("recreate_threw");
    expect(outcome.blockers.join(" | ")).toContain("ssh connection reset");
  });

  it("NEVER reports 'pass' when rollback itself fails to verify closed", async () => {
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async (v: boolean) =>
        v === true
          ? { ok: false, blockers: ["timeout"], observedEnvValue: null, observedBuildId: null }
          // The FORCED close attempt ALSO fails — the double-failure case.
          : { ok: false, blockers: ["docker unreachable"], observedEnvValue: null, observedBuildId: null },
      ),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.result).toBe("fail"); // never "pass"
    expect(outcome.rolledBack).toBe(true); // the attempt was made
    expect(outcome.rollbackVerified).toBe(false); // but it did not verify
    expect(outcome.blockers.join(" | ")).toContain("rollback_verification_failed");
  });

  it("restoreEnvBackup itself throwing is caught and still reports fail, not a crash", async () => {
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async () => ({
        ok: false, blockers: ["boom"], observedEnvValue: null, observedBuildId: null,
      })),
      restoreEnvBackup: vi.fn(async () => { throw new Error("backup file vanished"); }),
    });
    const outcome = await runCapabilityOpen(steps);
    expect(outcome.result).toBe("fail");
    expect(outcome.rollbackVerified).toBe(false);
    expect(outcome.blockers.join(" | ")).toContain("rollback_attempt_threw");
    expect(outcome.blockers.join(" | ")).toContain("backup file vanished");
  });
});

describe("runCapabilityClose — succeeds even under a DB/readiness failure", () => {
  it("never calls a DB-backed preflight at all", async () => {
    const preflightVerify = vi.fn(async () => PASS_PREFLIGHT);
    const steps = { ...baseSteps({ preflightVerify }) };
    await runCapabilityClose(steps);
    expect(preflightVerify).not.toHaveBeenCalled();
  });

  it("succeeds via a pure env-write + runtime-verify path, no database dependency", async () => {
    const steps = baseSteps();
    const outcome = await runCapabilityClose(steps);
    expect(outcome).toMatchObject({ action: "close", result: "pass", blockers: [] });
    expect(steps.writeEnvFalse).toHaveBeenCalledTimes(1);
    expect(steps.recreateAndVerifyRuntime).toHaveBeenCalledWith(false);
  });

  it("closing does not require calling restoreEnvBackup on the success path", async () => {
    const steps = baseSteps();
    await runCapabilityClose(steps);
    expect(steps.restoreEnvBackup).not.toHaveBeenCalled();
  });

  it("a runtime verify failure during close reports fail (close is not exempt from ITS OWN failures)", async () => {
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async () => ({
        ok: false, blockers: ["container did not become healthy"], observedEnvValue: null, observedBuildId: null,
      })),
    });
    const outcome = await runCapabilityClose(steps);
    expect(outcome.result).toBe("fail");
    expect(outcome.blockers.join(" | ")).toContain("container did not become healthy");
  });

  it("a throwing recreate during close is caught and reported as fail, not an unhandled rejection", async () => {
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async () => { throw new Error("docker daemon down"); }),
    });
    const outcome = await runCapabilityClose(steps);
    expect(outcome.result).toBe("fail");
    expect(outcome.blockers.join(" | ")).toContain("docker daemon down");
  });

  it("the wrong observed value (true instead of false) after close fails, never silently accepted", async () => {
    const steps = baseSteps({
      recreateAndVerifyRuntime: vi.fn(async () => OK_RUNTIME(true)), // wrong!
    });
    const outcome = await runCapabilityClose(steps);
    expect(outcome.result).toBe("fail");
  });
});

describe("the orchestrator never swallows a failure into a success (no `|| true` anywhere)", () => {
  it("open: every distinct failure injection point produces result !== 'pass'", async () => {
    const failureInjections: Array<Partial<CapabilityToggleSteps>> = [
      { preflightVerify: vi.fn(async () => ({ ok: false, blockers: ["x"] })) },
      { recreateAndVerifyRuntime: vi.fn(async () => ({ ok: false, blockers: ["x"], observedEnvValue: null, observedBuildId: null })) },
    ];
    for (const injection of failureInjections) {
      const outcome = await runCapabilityOpen(baseSteps(injection));
      expect(outcome.result, JSON.stringify(injection)).not.toBe("pass");
    }
  });
});
