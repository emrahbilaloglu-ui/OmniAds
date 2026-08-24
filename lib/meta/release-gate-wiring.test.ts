/**
 * Every declared release gate has a runtime consumer, and this holds it.
 *
 * The previous version of this file recorded the opposite: six gates declared,
 * two wired, four governing nothing. That was an accurate audit and a bad final
 * state — `META_PUBLIC_SHARE_MINT` in particular named a capability that was
 * live and ungated, so the flag could not stage the thing it was called after.
 *
 * All six are wired now, and the list below is the contract rather than the
 * finding. Each entry names where the gate is enforced on the SERVER, because
 * that is the half that a stale tab, a replayed request or a script meets. A
 * gate read only by a page decides what is offered; it decides nothing about
 * what is permitted.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { GATE_FAILURE_CODE, metaGateRefusal } from "@/lib/meta/release-gate-guard";
import { META_FAILURE_CODES } from "@/lib/meta/read-state-contract";

/**
 * Where each gate is enforced, and what it governs.
 *
 * `server` is the file that refuses the request. `offer` is where the screen
 * restates that refusal before the click — present for every gate, because a
 * refusal an operator only meets after filling in a form is a refusal that
 * wasted their time.
 */
const WIRED_GATES: Record<
  string,
  { server: string[]; offer: string[]; governs: string }
> = {
  launchpadExecution: {
    server: ["app/api/launchpad/meta/route-utils.ts"],
    offer: ["app/c/[businessId]/meta/launchpad/page.tsx"],
    governs: "provider create calls issued from Launchpad",
  },
  decisionWorkflowUi: {
    server: ["app/api/meta/decision-workflow/route.ts"],
    offer: ["app/c/[businessId]/meta/decisions/page.tsx"],
    governs: "the decision workflow write controls",
  },
  automationStopUi: {
    server: ["app/api/meta/automation/route.ts"],
    offer: ["app/c/[businessId]/meta/automation/page.tsx"],
    governs:
      "ENGAGING the business-scoped Meta Stop. Releasing one is never gated: a stop that cannot be lifted is the trap this gate exists to avoid",
  },
  automationLiveWrites: {
    server: ["app/api/meta/automation/proposals/route.ts"],
    offer: ["app/c/[businessId]/meta/automation/page.tsx"],
    governs:
      "whether an approved proposal may reach Meta. The gate can only ADD dry-run; the persisted guardrail stays authoritative",
  },
  publicShareMint: {
    server: ["app/api/creatives/share/route.ts"],
    offer: [
      "app/c/[businessId]/creative/performance/page.tsx",
      "app/c/[businessId]/creative/shares/page.tsx",
    ],
    governs:
      "minting NEW public share links. Rotation, revocation and deletion are never gated",
  },
  accountPicker: {
    /*
     * The one gate with no route of its own, and the reason is the mechanism:
     * changing the account is expressed as a URL scope, not as a POST. Its
     * server half is the layout that decides whether the picker is offered —
     * a server component, so a client cannot re-enable it — and the authority
     * it could never grant is `resolveProviderAccountScope`, which refuses an
     * unassigned account with the gate open or shut. That property is asserted
     * at runtime in `playwright/tests/meta-runtime-release-gates.spec.ts`
     * rather than here, because it is a claim about a live request.
     */
    server: ["app/c/[businessId]/layout.tsx", "app/app/layout.tsx"],
    offer: ["app/c/[businessId]/layout.tsx"],
    governs:
      "the operator's ability to CHANGE the ad account. Resolution is never gated, never widens beyond assigned accounts, and still fails closed",
  },
};

/** Files that read a gate at runtime, outside the gate modules themselves. */
function filesReadingGates(): Set<string> {
  const output = execFileSync(
    "git",
    [
      "grep",
      // Untracked too: a brand-new consumer is exactly the one most likely to
      // be missed, and a check that cannot see it would pass by not looking.
      "--untracked",
      "-l",
      "-e",
      "readMetaReleaseGates(",
      "-e",
      "rejectIfMetaGateClosed(",
      "-e",
      "readMetaGateRefusal(",
      "-e",
      "metaAutomationDryRunOnly(",
      "--",
      "app",
      "components",
      "lib",
    ],
    { encoding: "utf8" },
  );
  return new Set(
    output
      .split("\n")
      .filter(Boolean)
      .filter((file) => !file.includes(".test."))
      // The gate modules define the readers; the write-safety contract reports
      // every value for its conformance table. Neither is a consumer.
      .filter(
        (file) =>
          !file.endsWith("lib/meta/release-gates.ts") &&
          !file.endsWith("lib/meta/release-gate-guard.ts") &&
          !file.endsWith("lib/meta/write-safety-contract.ts"),
      ),
  );
}

describe("every declared gate is wired", () => {
  it("accounts for all six, with no gate left governing nothing", () => {
    expect(Object.keys(readMetaReleaseGates({})).sort()).toEqual(
      Object.keys(WIRED_GATES).sort(),
    );
  });

  it("enforces each one on the server, in every file this list names", () => {
    const readers = filesReadingGates();
    const missing = Object.entries(WIRED_GATES).flatMap(([gate, wiring]) =>
      wiring.server.filter((file) => !readers.has(file)).map((file) => `${gate} → ${file}`),
    );
    expect(missing, "gates whose named server file does not read a gate").toEqual([]);
  });

  it("restates each one on the screen before the click", () => {
    const readers = filesReadingGates();
    const missing = Object.entries(WIRED_GATES).flatMap(([gate, wiring]) =>
      wiring.offer.filter((file) => !readers.has(file)).map((file) => `${gate} → ${file}`),
    );
    expect(missing, "gates whose named offer file does not read a gate").toEqual([]);
  });

  it("leaves no reader unaccounted for", () => {
    /*
     * The direction the list above cannot check on its own. Without this, a
     * seventh file could start reading a gate and nothing would say which gate
     * it belongs to or whether it is enforcement or presentation.
     */
    const claimed = new Set(
      Object.values(WIRED_GATES).flatMap((wiring) => [...wiring.server, ...wiring.offer]),
    );
    const unclaimed = [...filesReadingGates()].filter((file) => !claimed.has(file));
    expect(unclaimed, "files reading a release gate that this list does not name").toEqual(
      [],
    );
  });

  it("says what each one governs, in enough words to be checkable", () => {
    for (const [gate, wiring] of Object.entries(WIRED_GATES)) {
      expect(wiring.governs.length, `${gate} has no description`).toBeGreaterThan(20);
    }
  });
});

describe("a closed gate refuses with a code the dictionary owns", () => {
  it("gives every gate its own §9.1 code", () => {
    const codes = Object.values(GATE_FAILURE_CODE);
    expect(new Set(codes).size, "two gates share a code").toBe(codes.length);
    for (const code of codes) expect(META_FAILURE_CODES).toContain(code);
  });

  it("refuses when shut, and says nothing about an environment variable", () => {
    for (const gate of Object.keys(WIRED_GATES) as (keyof typeof WIRED_GATES)[]) {
      const refusal = metaGateRefusal({ gate: gate as never, gateOpen: false });
      expect(refusal, gate).not.toBeNull();
      expect(refusal!.safetyIncomplete).toBe(false);
      // An operator cannot set a deployment variable and must not be sent
      // looking for one.
      expect(refusal!.message, gate).not.toMatch(/META_[A-Z_]+/);
      expect(refusal!.message.length, gate).toBeGreaterThan(30);
    }
  });

  it("still refuses when the gate is OPEN and its safety contract is not", () => {
    // The branch no test may produce by flipping a real variable on a route
    // whose next step reaches Meta, and the reason the decision is injectable.
    const refusal = metaGateRefusal({
      gate: "launchpadExecution",
      gateOpen: true,
      missingSafetySteps: ["provider_read_back"],
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.safetyIncomplete).toBe(true);
    expect(refusal!.message).toMatch(/write-safety requirements/);
  });

  it("permits when the gate is open and nothing is missing", () => {
    expect(
      metaGateRefusal({ gate: "publicShareMint", gateOpen: true, missingSafetySteps: [] }),
    ).toBeNull();
  });
});

describe("every gate is still off by default", () => {
  it("defaults every one of them to off", () => {
    // The property that makes the whole scheme safe, asserted where a reader
    // comes to ask what a gate does.
    for (const [name, value] of Object.entries(readMetaReleaseGates({}))) {
      expect(value, `${name} defaulted on`).toBe(false);
    }
  });

  it("treats anything but an exact `true` as off", () => {
    for (const raw of ["", " ", "1", "yes", "on", "false", "true1", undefined]) {
      const gates = readMetaReleaseGates({ META_PUBLIC_SHARE_MINT: raw });
      expect(gates.publicShareMint, JSON.stringify(raw)).toBe(false);
    }
    // Trimmed and case-insensitive, which the reader documents and does.
    for (const raw of ["true", " true ", "TRUE", "True"]) {
      expect(
        readMetaReleaseGates({ META_PUBLIC_SHARE_MINT: raw }).publicShareMint,
        JSON.stringify(raw),
      ).toBe(true);
    }
  });
});
