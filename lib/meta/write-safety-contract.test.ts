import { afterEach, describe, expect, it } from "vitest";

import {
  WRITE_FAMILIES,
  WRITE_SAFETY_INVARIANTS,
  WRITE_SAFETY_STEPS,
  missingSteps,
  openGatesWithMissingSteps,
  writeFamily,
} from "@/lib/meta/write-safety-contract";

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of [
    "META_LAUNCHPAD_EXECUTION",
    "META_AUTOMATION_LIVE_WRITES",
    "META_DECISION_WORKFLOW_UI",
  ]) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

describe("the write-safety sequence", () => {
  it("carries §10's eighteen steps in order", () => {
    expect(WRITE_SAFETY_STEPS).toHaveLength(18);
    expect(WRITE_SAFETY_STEPS[0]).toBe("exact_business_access");
    expect(WRITE_SAFETY_STEPS[12]).toBe("at_most_one_provider_post");
    expect(WRITE_SAFETY_STEPS[14]).toBe("independent_provider_readback");
    expect(WRITE_SAFETY_STEPS.at(-1)).toBe("rollback_or_compensation_record");
  });

  it("carries §10.1's nine invariants", () => {
    expect(WRITE_SAFETY_INVARIANTS).toHaveLength(9);
    expect(WRITE_SAFETY_INVARIANTS).toContain(
      "A provider 200 response is not a read-back.",
    );
  });

  it("declares every step for every write family", () => {
    // A family that simply omits a step would conform by silence.
    expect(WRITE_FAMILIES).toHaveLength(3);
    for (const family of WRITE_FAMILIES) {
      for (const step of WRITE_SAFETY_STEPS) {
        expect(family.steps[step], `${family.id}/${step}`).toBeDefined();
      }
    }
  });

  it("requires a reason for anything that is not implemented", () => {
    // `not_applicable` needs one as much as `missing` does: a step waved away
    // without a reason is indistinguishable from a step nobody looked at.
    for (const family of WRITE_FAMILIES) {
      for (const step of WRITE_SAFETY_STEPS) {
        const conformance = family.steps[step];
        if (conformance.status === "implemented") {
          expect(conformance.where.length, `${family.id}/${step}`).toBeGreaterThan(10);
        } else {
          expect(conformance.why.length, `${family.id}/${step}`).toBeGreaterThan(20);
        }
      }
    }
  });
});

describe("current conformance, stated rather than assumed", () => {
  it("Decisions manual actions satisfy every step", () => {
    expect(missingSteps(writeFamily("decisions_manual_action"))).toEqual([]);
  });

  it("Automation proposal approval satisfies every step", () => {
    expect(missingSteps(writeFamily("automation_proposal_approval"))).toEqual([]);
  });

  it("Launchpad create does not, and the gaps are named", () => {
    /**
     * This is the honest state of the third family, and it is why
     * `META_LAUNCHPAD_EXECUTION` ships off. The central one is the read-back:
     * the route trusts the create response, and §10.1 says a provider 200 is
     * not a read-back. WP15 is the work that closes these.
     */
    const missing = missingSteps(writeFamily("launchpad_create"));
    expect(missing).toContain("independent_provider_readback");
    expect(missing).toContain("durable_idempotency_claim");
    expect(missing).toContain("persisted_preflight");
    // Closed in WP7: the route now consults getMetaWriteBlockState, so an
    // engaged Meta Stop blocks a Launchpad create the way it already blocked
    // every other Meta write.
    expect(missing).not.toContain("server_side_kill_switch");
    expect(missing.length).toBe(7);
  });
});

describe("an open gate requires a conforming family", () => {
  it("is satisfied in the shipped configuration, where the gates are closed", () => {
    for (const key of [
      "META_LAUNCHPAD_EXECUTION",
      "META_AUTOMATION_LIVE_WRITES",
      "META_DECISION_WORKFLOW_UI",
    ]) {
      delete process.env[key];
    }
    expect(openGatesWithMissingSteps()).toEqual([]);
  });

  it("fails the moment Launchpad execution is enabled while steps are missing", () => {
    /**
     * The check that gives this contract teeth.
     *
     * WP15's precondition stops being a promise in a document: enabling
     * `META_LAUNCHPAD_EXECUTION` before the read-back exists does not quietly
     * ship an unverified create — it fails here. Closing the eight gaps is what
     * makes this test go green with the gate open, which is exactly the order
     * the plan requires.
     */
    process.env.META_LAUNCHPAD_EXECUTION = "true";
    const offenders = openGatesWithMissingSteps();
    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.family).toBe("launchpad_create");
    expect(offenders[0]!.missing).toContain("independent_provider_readback");
  });

  it("lets the two conforming families open their gates without complaint", () => {
    process.env.META_AUTOMATION_LIVE_WRITES = "true";
    process.env.META_DECISION_WORKFLOW_UI = "true";
    delete process.env.META_LAUNCHPAD_EXECUTION;
    expect(openGatesWithMissingSteps()).toEqual([]);
  });
});
