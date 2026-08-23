/**
 * Which release gates are wired, and which are only declared.
 *
 * `MetaReleaseGates` declares six. Two are read by a route or a page and four
 * are not, and until this file that difference was invisible — the write-safety
 * contract reports the *value* of every gate, which makes six declarations look
 * like six controls.
 *
 * A declared-but-unwired gate is not automatically a defect. Three of the four
 * guard a control the product has not built yet: turning the gate on would
 * offer nothing, because there is nothing to offer. The fourth is different and
 * is the reason this test exists.
 *
 * The list is asserted exactly, in both directions. Wiring a gate and not
 * moving it here fails; declaring a new gate and never wiring it fails too.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { readMetaReleaseGates } from "@/lib/meta/release-gates";

/** Gates a route, a page or a component reads at runtime. */
const WIRED_GATES: Record<string, string> = {
  launchpadExecution:
    "app/api/launchpad/meta/route-utils.ts refuses the launch and add-to-existing " +
    "POSTs, and app/c/[businessId]/meta/launchpad/page.tsx renders the control " +
    "disabled-with-reason. Proven on the running server in " +
    "playwright/tests/meta-runtime-write-gates.spec.ts.",
  decisionWorkflowUi:
    "app/c/[businessId]/meta/decisions/page.tsx passes it to MetaPlatformPage, " +
    "which holds the workflow controls closed.",
};

/**
 * Gates with no runtime consumer, each with the reason it has none.
 *
 * `publicShareMint` is the one that matters. Share minting is live: the POST to
 * `/api/creatives/share` enforces business access, the reviewer read-only rule
 * and a schema capability, and then mints. It does not consult this gate. So
 * the gate cannot stage that capability, and — this is the part worth being
 * careful about — wiring it now would DISABLE a shipped flow, because every
 * gate defaults off. Recording the gap is the honest move; closing it is a
 * release decision, not a refactor.
 */
const DECLARED_BUT_UNWIRED: Record<string, string> = {
  automationStopUi:
    "The Meta Stop engage/release control does not exist yet — WP13 leaves it " +
    "deliberately absent until engage/release reversibility is proven. The gate " +
    "is a placeholder for a control that is not built.",
  automationLiveWrites:
    "Automation's dry-run posture is enforced by readMetaAutomationPosture and " +
    "by the server's own guardrail row, not by this flag. The flag can only " +
    "lower the posture, and nothing reads it to do so yet.",
  publicShareMint:
    "Share minting is LIVE and ungated: /api/creatives/share mints after access, " +
    "reviewer and schema-capability checks without consulting this gate. The gate " +
    "cannot stage the capability it names. Wiring it would turn a shipped flow " +
    "off, so this is recorded rather than fixed.",
  accountPicker:
    "The picker is rendered by the shell without consulting the gate. Scope " +
    "resolution is deliberately never gated; only changing the selection was " +
    "meant to be, and that offer is currently unconditional.",
};

/** Every `readMetaReleaseGates().<name>` in the tree, outside the gate module. */
function gatesReadAtRuntime(): Set<string> {
  const output = execFileSync(
    "git",
    ["grep", "-n", "readMetaReleaseGates(", "--", "app", "components", "lib"],
    { encoding: "utf8" },
  );
  const read = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [file] = line.split(":");
    if (!file || file.includes(".test.")) continue;
    // The gate module defines the reader; the write-safety contract reports
    // every value for the conformance table. Neither is a consumer.
    if (file.endsWith("lib/meta/release-gates.ts")) continue;
    if (file.endsWith("lib/meta/write-safety-contract.ts")) continue;
    const match = /readMetaReleaseGates\([^)]*\)\.(\w+)/.exec(line);
    if (match) read.add(match[1]!);
  }
  // `route-utils.ts` reads it into a local first, so the property access is on
  // another line. Picked up by name rather than by regex acrobatics.
  const utils = execFileSync(
    "git",
    ["grep", "-n", "launchpadExecution", "--", "app/api/launchpad"],
    { encoding: "utf8" },
  );
  if (utils.trim().length > 0) read.add("launchpadExecution");
  return read;
}

describe("release gates: declared versus wired", () => {
  it("declares exactly the six gates the two lists account for", () => {
    const declared = Object.keys(readMetaReleaseGates({})).sort();
    const accounted = [
      ...Object.keys(WIRED_GATES),
      ...Object.keys(DECLARED_BUT_UNWIRED),
    ].sort();
    expect(declared).toEqual(accounted);
  });

  it("finds exactly the wired gates in the tree", () => {
    const read = [...gatesReadAtRuntime()].sort();
    expect(read, "a gate became wired, or stopped being").toEqual(
      Object.keys(WIRED_GATES).sort(),
    );
  });

  it("gives every unwired gate a reason", () => {
    for (const [gate, why] of Object.entries(DECLARED_BUT_UNWIRED)) {
      expect(why.length, `${gate} has no recorded reason`).toBeGreaterThan(60);
    }
  });

  it("every gate is still off by default", () => {
    // The property that makes the whole scheme safe, asserted here too because
    // this file is where a reader comes to ask what a gate does.
    const gates = readMetaReleaseGates({});
    for (const [name, value] of Object.entries(gates)) {
      expect(value, `${name} defaulted on`).toBe(false);
    }
  });
});
