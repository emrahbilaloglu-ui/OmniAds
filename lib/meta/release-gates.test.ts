import { describe, expect, it } from "vitest";

import { META_GATE_REFUSAL_REASONS } from "@/lib/meta/release-gate-copy";
import {
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
  decisionWorkflowUi: "META_AUTOMATION_LIVE_WRITES",
  automationStopUi: "META_AUTOMATION_STOP_UI",
  automationLiveWrites: "META_AUTOMATION_LIVE_WRITES",
  publicShareMint: "META_PUBLIC_SHARE_MINT",
  accountPicker: "META_ACCOUNT_PICKER",
};

/**
 * The gates that are still their own environment variable.
 *
 * `decisionWorkflowUi` left this set when the decision workflow and the
 * mutation ceremony were recognised as two halves of one write capability:
 * three spellings of one thing is how one route family came to offer controls
 * the other did not. `automationStopUi` left it because STOP is not a
 * capability at all — an operator reaches for the kill switch precisely when
 * provider writes are closed.
 */
const INDEPENDENT_GATE_KEYS = [
  "launchpadExecution",
  "automationLiveWrites",
  "publicShareMint",
  "accountPicker",
] as const satisfies readonly (keyof MetaReleaseGates)[];

describe("Meta release gates", () => {
  it("every capability gate is off when the environment says nothing", () => {
    const gates = readMetaReleaseGates({});
    for (const key of GATE_KEYS) {
      // STOP is always reachable; it is the one entry that is not a capability.
      expect(gates[key]).toBe(key === "automationStopUi");
    }
  });

  it("STOP management is never gated by the environment", () => {
    for (const raw of ["", "false", "true", "nonsense"]) {
      expect(
        readMetaReleaseGates({ META_AUTOMATION_STOP_UI: raw }).automationStopUi,
      ).toBe(true);
    }
  });

  it("the decision workflow follows the one live-write capability", () => {
    expect(readMetaReleaseGates({}).decisionWorkflowUi).toBe(false);
    // Its own former variable no longer opens anything on its own.
    expect(
      readMetaReleaseGates({ META_DECISION_WORKFLOW_UI: "true" })
        .decisionWorkflowUi,
    ).toBe(false);
    const open = readMetaReleaseGates({ META_AUTOMATION_LIVE_WRITES: "true" });
    expect(open.decisionWorkflowUi).toBe(true);
    expect(open.automationLiveWrites).toBe(true);
  });

  it.each(INDEPENDENT_GATE_KEYS)("%s opens only on an exact true", (key) => {
    const name = ENV_BY_GATE[key];
    for (const raw of ["true", "TRUE", " True "]) {
      expect(readMetaReleaseGates({ [name]: raw })[key]).toBe(true);
    }
    // A misspelling, a near-miss and a plausible-looking truthy value all stay
    // closed. "1" and "yes" are deliberately NOT accepted: a gate that opens on
    // a guess opens by accident.
    for (const raw of ["", " ", "1", "yes", "on", "enabled", "false", "tru", "TRUE!"]) {
      expect(readMetaReleaseGates({ [name]: raw })[key]).toBe(false);
    }
  });

  it("one gate opening does not open an unrelated one", () => {
    for (const key of INDEPENDENT_GATE_KEYS) {
      const gates = readMetaReleaseGates({
        [ENV_BY_GATE[key]]: "true",
      });
      for (const other of INDEPENDENT_GATE_KEYS) {
        expect(gates[other]).toBe(other === key);
      }
      // The workflow half of the live-write capability moves with it, and only
      // with it. Nothing else does.
      expect(gates.decisionWorkflowUi).toBe(key === "automationLiveWrites");
    }
  });

  it("automation posture is dry-run by default and inverts only on the live gate", () => {
    expect(readMetaAutomationPosture({}).dryRunOnly).toBe(true);
    expect(
      readMetaAutomationPosture({
        META_AUTOMATION_LIVE_WRITES: "true",
      }).dryRunOnly,
    ).toBe(false);
    // Any other value leaves the safe posture in place.
    for (const raw of ["", "1", "yes", "false", "TRUE!"]) {
      expect(
        readMetaAutomationPosture({
          META_AUTOMATION_LIVE_WRITES: raw,
        }).dryRunOnly,
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
