import { describe, expect, it } from "vitest";

import {
  META_GATE_REFUSAL_REASONS,
  readMetaAutomationPosture,
  readMetaReleaseGates,
  type MetaReleaseGates,
} from "@/lib/meta/release-gates";

const GATE_KEYS = [
  "launchpadExecution",
  "decisionWorkflowUi",
  "automationStopUi",
  "automationLiveWrites",
  "publicShareMint",
  "accountPicker",
] as const satisfies readonly (keyof MetaReleaseGates)[];

const ENV_BY_GATE: Record<keyof MetaReleaseGates, string> = {
  launchpadExecution: "META_LAUNCHPAD_EXECUTION",
  decisionWorkflowUi: "META_DECISION_WORKFLOW_UI",
  automationStopUi: "META_AUTOMATION_STOP_UI",
  automationLiveWrites: "META_AUTOMATION_LIVE_WRITES",
  publicShareMint: "META_PUBLIC_SHARE_MINT",
  accountPicker: "META_ACCOUNT_PICKER",
};

describe("Meta release gates", () => {
  it("every gate is off when the environment says nothing", () => {
    const gates = readMetaReleaseGates({} as NodeJS.ProcessEnv);
    for (const key of GATE_KEYS) expect(gates[key]).toBe(false);
  });

  it.each(GATE_KEYS)("%s opens only on an exact true", (key) => {
    const name = ENV_BY_GATE[key];
    for (const raw of ["true", "TRUE", " True "]) {
      expect(readMetaReleaseGates({ [name]: raw } as NodeJS.ProcessEnv)[key]).toBe(true);
    }
    // A misspelling, a near-miss and a plausible-looking truthy value all stay
    // closed. "1" and "yes" are deliberately NOT accepted: a gate that opens on
    // a guess opens by accident.
    for (const raw of ["", " ", "1", "yes", "on", "enabled", "false", "tru", "TRUE!"]) {
      expect(readMetaReleaseGates({ [name]: raw } as NodeJS.ProcessEnv)[key]).toBe(false);
    }
  });

  it("one gate opening does not open another", () => {
    for (const key of GATE_KEYS) {
      const gates = readMetaReleaseGates({
        [ENV_BY_GATE[key]]: "true",
      } as NodeJS.ProcessEnv);
      for (const other of GATE_KEYS) {
        expect(gates[other]).toBe(other === key);
      }
    }
  });

  it("automation posture is dry-run by default and inverts only on the live gate", () => {
    expect(readMetaAutomationPosture({} as NodeJS.ProcessEnv).dryRunOnly).toBe(true);
    expect(
      readMetaAutomationPosture({
        META_AUTOMATION_LIVE_WRITES: "true",
      } as NodeJS.ProcessEnv).dryRunOnly,
    ).toBe(false);
    // Any other value leaves the safe posture in place.
    for (const raw of ["", "1", "yes", "false", "TRUE!"]) {
      expect(
        readMetaAutomationPosture({
          META_AUTOMATION_LIVE_WRITES: raw,
        } as NodeJS.ProcessEnv).dryRunOnly,
      ).toBe(true);
    }
  });

  it("every gate has an operator-facing reason that names no environment variable", () => {
    for (const key of GATE_KEYS) {
      const reason = META_GATE_REFUSAL_REASONS[key];
      expect(reason.length).toBeGreaterThan(20);
      for (const name of Object.values(ENV_BY_GATE)) {
        expect(reason).not.toContain(name);
      }
      expect(reason).not.toMatch(/\bflag\b/i);
    }
  });
});
