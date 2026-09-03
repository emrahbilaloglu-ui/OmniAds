/**
 * PRE-DEPLOY AUDIT — the Phase A -> B capability-open SAFETY STATE MACHINE.
 *
 * The actual open/close operation runs as bash on a remote host, over SSH,
 * inside a GitHub Actions workflow — none of which is unit-testable, and
 * none of which this repository can execute without touching a real
 * production host. So the SEQUENCE and the SAFETY DECISIONS are encoded here
 * instead, as pure functions over INJECTED steps: every step is a callback
 * the caller supplies, so a test can simulate success or failure at any
 * point without an SSH connection, a database, or Docker existing at all.
 *
 * `.github/scripts/automation-capability-remote.sh` is a deliberately
 * LITERAL bash translation of the sequences below — same order, same
 * decisions, same "never `|| true`" rule — so this module is the source of
 * truth for what that script is supposed to do, and this file's tests are
 * what a change to that script must still satisfy in spirit.
 *
 * THE INVARIANT EVERY PATH HOLDS: a failure after the environment variable
 * has been changed is followed by a restore-and-verify-closed attempt before
 * the function returns, and the function's own result NEVER reports
 * `"pass"` unless the intended end state was independently verified — never
 * assumed from "the command exited 0".
 */

export const AUTOMATION_CAPABILITY_ORCHESTRATOR_CONTRACT =
  "meta.automation-capability-orchestrator.v1" as const;

export interface PreflightStepResult {
  ok: boolean;
  blockers: readonly string[];
}

export interface EnvWriteStepResult {
  backupPath: string;
}

export interface RuntimeVerifyStepResult {
  ok: boolean;
  blockers: readonly string[];
  observedEnvValue: boolean | null;
  observedBuildId: string | null;
}

/**
 * Every side effect the orchestrator can perform, as injected async
 * functions. `intendedEnvValue` tells `recreateAndVerifyRuntime` which value
 * it is expected to observe after the recreate — the step must FAIL if the
 * running containers report anything else, rather than trusting that the
 * write it was just told about actually took effect.
 */
export interface CapabilityToggleSteps {
  preflightVerify(): Promise<PreflightStepResult>;
  writeEnvTrue(): Promise<EnvWriteStepResult>;
  writeEnvFalse(): Promise<EnvWriteStepResult>;
  recreateAndVerifyRuntime(intendedEnvValue: boolean): Promise<RuntimeVerifyStepResult>;
  restoreEnvBackup(backupPath: string): Promise<void>;
}

export type CapabilityToggleResult =
  | "pass"
  | "refused" // preflight refused; nothing was touched
  | "fail"; // something changed and had to be rolled back, or rollback itself failed

export interface CapabilityToggleOutcome {
  contract: typeof AUTOMATION_CAPABILITY_ORCHESTRATOR_CONTRACT;
  action: "open" | "close";
  result: CapabilityToggleResult;
  blockers: string[];
  /** True only when an env change was made AND then reverted. */
  rolledBack: boolean;
  /** True only when a rollback was ATTEMPTED and independently verified closed. */
  rollbackVerified: boolean;
}

/**
 * OPEN: preflight (DB-backed) -> write true -> recreate+verify true -> a
 * SECOND preflight, because the recreate itself must not have enabled
 * anything. Any failure after the write triggers restore + a forced close +
 * an independent verify that the runtime is closed again — and the
 * function's own result is `"fail"`, never `"pass"`, whatever the restore
 * attempt's own outcome was.
 */
export async function runCapabilityOpen(
  steps: CapabilityToggleSteps,
): Promise<CapabilityToggleOutcome> {
  const base = {
    contract: AUTOMATION_CAPABILITY_ORCHESTRATOR_CONTRACT,
    action: "open" as const,
  };

  const preflight = await steps.preflightVerify();
  if (!preflight.ok) {
    // Nothing touched. The environment is exactly as it was found.
    return { ...base, result: "refused", blockers: [...preflight.blockers], rolledBack: false, rollbackVerified: false };
  }

  const write = await steps.writeEnvTrue();
  const failWithRollback = async (reason: string): Promise<CapabilityToggleOutcome> => {
    let rollbackVerified = false;
    const blockers = [reason];
    try {
      await steps.restoreEnvBackup(write.backupPath);
      const closeVerify = await steps.recreateAndVerifyRuntime(false);
      rollbackVerified = closeVerify.ok && closeVerify.observedEnvValue === false;
      if (!rollbackVerified) {
        blockers.push(
          `rollback_verification_failed: ${closeVerify.blockers.join("; ") || "runtime did not confirm closed"}`,
        );
      }
    } catch (error) {
      blockers.push(`rollback_attempt_threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...base, result: "fail", blockers, rolledBack: true, rollbackVerified };
  };

  let runtime: RuntimeVerifyStepResult;
  try {
    runtime = await steps.recreateAndVerifyRuntime(true);
  } catch (error) {
    return failWithRollback(
      `recreate_threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!runtime.ok || runtime.observedEnvValue !== true) {
    return failWithRollback(
      `runtime_verify_failed: ${runtime.blockers.join("; ") || "observed env value did not become true"}`,
    );
  }

  // The recreate itself must not have enabled anything — re-run the SAME
  // DB-backed preflight the open decision was granted on.
  const postOpenCheck = await steps.preflightVerify();
  if (!postOpenCheck.ok) {
    return failWithRollback(
      `post_open_db_not_zero: ${postOpenCheck.blockers.join("; ")}`,
    );
  }

  return { ...base, result: "pass", blockers: [], rolledBack: false, rollbackVerified: false };
}

/**
 * CLOSE: NEVER gated on the DB-backed preflight — a database or readiness
 * failure must not be able to prevent turning automation off. Writes false,
 * recreates, and verifies the RUNTIME (an env-var/build-id read, not a DB
 * query) actually reports closed.
 */
export async function runCapabilityClose(
  steps: Pick<CapabilityToggleSteps, "writeEnvFalse" | "recreateAndVerifyRuntime" | "restoreEnvBackup">,
): Promise<CapabilityToggleOutcome> {
  const base = {
    contract: AUTOMATION_CAPABILITY_ORCHESTRATOR_CONTRACT,
    action: "close" as const,
  };

  const write = await steps.writeEnvFalse();
  let runtime: RuntimeVerifyStepResult;
  try {
    runtime = await steps.recreateAndVerifyRuntime(false);
  } catch (error) {
    return {
      ...base, result: "fail",
      blockers: [`recreate_threw: ${error instanceof Error ? error.message : String(error)}`],
      rolledBack: false, rollbackVerified: false,
    };
  }

  if (!runtime.ok || runtime.observedEnvValue !== false) {
    return {
      ...base, result: "fail",
      blockers: [`runtime_verify_failed: ${runtime.blockers.join("; ") || "observed env value did not become false"}`],
      rolledBack: false, rollbackVerified: false,
    };
  }

  void write.backupPath; // recorded by the caller's artifact, not needed further here
  return { ...base, result: "pass", blockers: [], rolledBack: false, rollbackVerified: false };
}
