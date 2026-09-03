/**
 * PRE-DEPLOY AUDIT — the release posture classifier, and the static contract
 * that keeps the repository's shipped state honest about which phase it is in.
 *
 * The single most important assertion in this file is negative: an ABSENT or
 * FALSE `META_AUTOMATION_LIVE_WRITES` must never be reported as the final
 * release posture, no matter how clean the database looks beside it. Every
 * other case exists to stop that one from being satisfied by accident.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AUTOMATION_POSTURE_BLOCKERS,
  AUTOMATION_RELEASE_PHASES,
  FINAL_RELEASE_PHASE,
  classifyAutomationReleasePosture,
  describeAutomationPosture,
  type AutomationPostureObservation,
} from "@/lib/meta/automation-release-posture";

/** A legitimately-reached phase B, which each case below perturbs. */
const PHASE_B: AutomationPostureObservation = {
  envCapability: true,
  enabledBusinessCount: 0,
  schemaDefaultsOff: true,
  deployedSha: "5f0c98b4a",
  readbackPassed: true,
};

const observe = (over: Partial<AutomationPostureObservation> = {}) =>
  classifyAutomationReleasePosture({ ...PHASE_B, ...over });

describe("automation release posture — the phases are exactly three", () => {
  it("names A, B and C, and exactly one of them is final", () => {
    expect(AUTOMATION_RELEASE_PHASES).toEqual([
      "predeploy_validation",
      "capability_open_zero_enabled",
      "business_enabled_by_operator",
    ]);
    expect(FINAL_RELEASE_PHASE).toBe("capability_open_zero_enabled");
  });
});

describe("automation release posture — phase B is the final desired state", () => {
  it("capability open, zero enabled, SHA proven, readback passed", () => {
    const verdict = observe();
    expect(verdict.phase).toBe("capability_open_zero_enabled");
    expect(verdict.isFinalReleasePosture).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(describeAutomationPosture(verdict)).toContain("FINAL release posture");
  });

  it("is the ONLY observation that is ever final", () => {
    /*
      Exhaustive over the small product of states this classifier can see, so
      "final" cannot be reached by a combination nobody thought to write a
      case for. Any future edit that widens `isFinalReleasePosture` fails here.
    */
    const values = {
      envCapability: [true, false, null],
      enabledBusinessCount: [0, 1, null],
      schemaDefaultsOff: [true, false, null],
      deployedSha: ["5f0c98b4a", null],
      readbackPassed: [true, false, null],
    } as const;
    const finals: AutomationPostureObservation[] = [];
    for (const envCapability of values.envCapability) {
      for (const enabledBusinessCount of values.enabledBusinessCount) {
        for (const schemaDefaultsOff of values.schemaDefaultsOff) {
          for (const deployedSha of values.deployedSha) {
            for (const readbackPassed of values.readbackPassed) {
              const observation = {
                envCapability, enabledBusinessCount, schemaDefaultsOff,
                deployedSha, readbackPassed,
              };
              if (classifyAutomationReleasePosture(observation).isFinalReleasePosture) {
                finals.push(observation);
              }
            }
          }
        }
      }
    }
    expect(finals).toEqual([PHASE_B]);
  });
});

describe("automation release posture — an absent or false capability is NEVER final", () => {
  it.each([
    ["absent", null],
    ["false", false],
  ])("refuses to call a %s capability the final posture", (_label, envCapability) => {
    const verdict = observe({ envCapability: envCapability as boolean | null });
    expect(verdict.isFinalReleasePosture).toBe(false);
    expect(verdict.phase).not.toBe(FINAL_RELEASE_PHASE);
  });

  it("reports a FALSE capability as phase A and says so in the sentence", () => {
    const verdict = observe({ envCapability: false });
    expect(verdict.phase).toBe("predeploy_validation");
    expect(verdict.blockers).toContain(AUTOMATION_POSTURE_BLOCKERS.envClosed);
    expect(describeAutomationPosture(verdict)).toContain("NOT the final release posture");
    expect(verdict.nextAction).toContain("phase A");
  });

  it("reports an ABSENT capability as unknown, not as phase A", () => {
    /*
      The distinction that matters most. "We could not read the environment"
      and "the environment says false" produce the same database evidence, and
      only one of them is a validated pre-deploy state. Reporting an unread
      value as phase A would let a broken measurement be filed as a passed one.
    */
    const verdict = observe({ envCapability: null });
    expect(verdict.phase).toBeNull();
    expect(verdict.blockers).toContain(AUTOMATION_POSTURE_BLOCKERS.envUnknown);
    expect(describeAutomationPosture(verdict)).toContain("UNKNOWN");
  });

  it("refuses every unknown before naming any phase", () => {
    expect(observe({ enabledBusinessCount: null }).phase).toBeNull();
    expect(observe({ schemaDefaultsOff: null }).phase).toBeNull();
    expect(observe({ enabledBusinessCount: null }).blockers)
      .toContain(AUTOMATION_POSTURE_BLOCKERS.enabledCountUnknown);
    expect(observe({ schemaDefaultsOff: null }).blockers)
      .toContain(AUTOMATION_POSTURE_BLOCKERS.schemaDefaultsUnknown);
  });
});

describe("automation release posture — the contradictions", () => {
  it("refuses an enabled business while the capability is closed", () => {
    const verdict = observe({ envCapability: false, enabledBusinessCount: 2 });
    expect(verdict.phase).toBeNull();
    expect(verdict.blockers).toContain(AUTOMATION_POSTURE_BLOCKERS.enabledWhileClosed);
    expect(verdict.nextAction).toContain("without a ceremony");
  });

  it("refuses phase B when the exact-SHA deployment is not proven", () => {
    const verdict = observe({ deployedSha: null });
    expect(verdict.isFinalReleasePosture).toBe(false);
    expect(verdict.phase).toBe("predeploy_validation");
    expect(verdict.blockers).toContain(AUTOMATION_POSTURE_BLOCKERS.shaUnproven);
    expect(verdict.nextAction).toContain("Close it");
  });

  it.each([[false], [null]])(
    "refuses phase B when the readback is not proven (%s)",
    (readbackPassed) => {
      const verdict = observe({ readbackPassed: readbackPassed as boolean | null });
      expect(verdict.isFinalReleasePosture).toBe(false);
      expect(verdict.blockers).toContain(AUTOMATION_POSTURE_BLOCKERS.readbackUnproven);
    },
  );

  it("flags a schema default that is no longer OFF, in any phase", () => {
    expect(observe({ schemaDefaultsOff: false }).blockers)
      .toContain(AUTOMATION_POSTURE_BLOCKERS.schemaDefaultsOn);
    expect(observe({ schemaDefaultsOff: false }).isFinalReleasePosture).toBe(false);
    expect(observe({ envCapability: false, schemaDefaultsOff: false }).blockers)
      .toContain(AUTOMATION_POSTURE_BLOCKERS.schemaDefaultsOn);
  });
});

describe("automation release posture — phase C is a user action", () => {
  it("names it when a business is enabled with the capability open", () => {
    const verdict = observe({ enabledBusinessCount: 1 });
    expect(verdict.phase).toBe("business_enabled_by_operator");
    expect(verdict.isFinalReleasePosture).toBe(false);
    expect(verdict.nextAction).toContain("not a release step");
  });
});

describe("automation release posture — the SHIPPED tree is phase A by construction", () => {
  /*
    The classifier can be told anything. These assertions are about the
    repository itself: whatever an operator later sets, what this release
    SHIPS must be a tree that cannot be in phase B or C on its own.
  */
  const read = (path: string) => readFileSync(path, "utf8");

  it("ships no environment file that opens the capability", () => {
    // Committed env/config must never carry the gate as true. The real
    // environment is the operator's and is deliberately not touched here.
    for (const path of ["docker-compose.yml", ".env.example"]) {
      let source = "";
      try { source = read(path); } catch { continue; }
      expect(source, path).not.toMatch(/META_AUTOMATION_LIVE_WRITES\s*[:=]\s*["']?true/i);
    }
  });

  it("ships a gate that only the exact string 'true' can open", () => {
    const gates = read("lib/meta/release-gates.ts");
    expect(gates).toContain('raw?.trim().toLowerCase() === "true"');
    expect(gates).toContain("automationLiveWrites: parseGate(env.META_AUTOMATION_LIVE_WRITES)");
  });

  it("ships database defaults that are OFF at every layer", () => {
    const migrations = read("lib/migrations.ts");
    expect(migrations).toContain("auto_execution_enabled BOOLEAN NOT NULL DEFAULT FALSE");
    expect(migrations).toContain('"dryRunOnly": true');
    // Additive and nullable: an existing TRUE row still activates no account.
    expect(migrations).toContain(
      "ADD COLUMN IF NOT EXISTS auto_execution_provider_account_id TEXT",
    );

    const control = read("lib/meta/automation-control-plane.ts");
    expect(control).toContain("autoExecutionEnabled: false");
    expect(control).toContain("dryRunOnly: true");
    expect(control).toContain('mode: "manual"');
  });

  it("ships no migration that writes DATA into the automation control tables", () => {
    const migrations = read("lib/migrations.ts")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    for (const table of [
      "meta_automation_business_controls",
      "meta_automation_decision_type_modes",
    ]) {
      expect(migrations, table).not.toMatch(new RegExp(`INSERT\\s+INTO\\s+${table}`, "i"));
      expect(migrations, table).not.toMatch(new RegExp(`UPDATE\\s+${table}`, "i"));
    }
  });

  it("keeps the runbook and the classifier naming the same three phases", () => {
    // A runbook that drifts from the code is how "OFF" became ambiguous in the
    // first place. Both must name all three phases and the same final one.
    const runbook = read("docs/audits/AUTOMATION_RELEASE_POSTURE_2026-09-03.md");
    for (const phase of AUTOMATION_RELEASE_PHASES) expect(runbook).toContain(phase);
    expect(runbook).toContain(FINAL_RELEASE_PHASE);
    expect(runbook).toMatch(/phase\s*A/i);
    expect(runbook).toMatch(/phase\s*B/i);
    expect(runbook).toMatch(/phase\s*C/i);
  });
});
