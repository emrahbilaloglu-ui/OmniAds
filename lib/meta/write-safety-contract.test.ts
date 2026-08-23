import { afterEach, describe, expect, it } from "vitest";

import {
  WRITE_FAMILIES,
  WRITE_SAFETY_INVARIANTS,
  WRITE_SAFETY_STEPS,
  missingSteps,
  openGatesWithMissingSteps,
  writeFamily,
  type WriteFamily,
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

  it("Launchpad create satisfies every step, re-audited against the code", () => {
    /**
     * Corrected 2026-08-23.
     *
     * This previously asserted SEVEN missing steps. Six of the seven were
     * already implemented: the audit that produced that record read
     * `app/api/launchpad/meta/launch/route.ts` and never opened
     * `lib/meta/launch-write.ts`, where the independent read-back and the exact
     * identity verification live. A declaration wrong in the pessimistic
     * direction is still wrong — it would have held a gate closed against work
     * that was already done.
     *
     * The seventh, the preflight age and no-contact disclosure, was genuinely
     * absent and is now implemented in
     * `lib/launchpad/validation-preflight-disclosure.ts`.
     *
     * Each `implemented` entry is backed by a behavioural test in
     * `lib/meta/launchpad-write-safety.behaviour.test.ts` that exercises the
     * real module against a stubbed Meta. A declaration whose only evidence is
     * a declaration-shaped test is what this file exists to stop.
     */
    expect(missingSteps(writeFamily("launchpad_create"))).toEqual([]);
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

  it("reports a family whose gate is open while steps are missing", () => {
    /**
     * The check that gives this contract teeth, exercised against a simulated
     * incomplete family because all three real families now conform.
     *
     * Driving it from the real contract would make this test pass for the wrong
     * reason the moment a gap reappeared somewhere else, and it would have
     * nothing to assert today.
     */
    const incomplete: WriteFamily = {
      ...writeFamily("launchpad_create"),
      steps: {
        ...writeFamily("launchpad_create").steps,
        independent_provider_readback: {
          status: "missing",
          why: "Simulated for this assertion: the gate must refuse while this is absent.",
        },
      },
    };
    expect(missingSteps(incomplete)).toEqual(["independent_provider_readback"]);
  });

  it("lets the two conforming families open their gates without complaint", () => {
    process.env.META_AUTOMATION_LIVE_WRITES = "true";
    process.env.META_DECISION_WORKFLOW_UI = "true";
    delete process.env.META_LAUNCHPAD_EXECUTION;
    expect(openGatesWithMissingSteps()).toEqual([]);
  });
});
