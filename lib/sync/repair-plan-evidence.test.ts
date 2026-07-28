import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A release gate that carries NO canary evidence has told us nothing. It has
 * not told us everything is well.
 *
 * `canaries` is written into gate evidence in exactly one place —
 * lib/google-ads/control-plane-runtime.ts — and the commit "Decouple release
 * gate from sync canaries" removed it from the Meta gate while touching only
 * release-gates.ts and its test. The repair planner still sources its entire
 * work-list from `releaseGate.evidence.canaries`, so for Meta that list is
 * permanently empty:
 *
 *   - no recommendation can ever be produced,
 *   - therefore no repair ever runs through the plan path,
 *   - and because clearInactiveSyncIncidents only runs for an ELIGIBLE plan,
 *     no Meta incident is ever created or cleared.
 *
 * The Meta status surface consequently reports operationalSyncState "healthy"
 * with openIncidents 0 by construction — green because it is disconnected from
 * its evidence, not because anything was checked. That is the most dangerous
 * shape a health signal can take.
 *
 * Marking the plan blocked changes no repair behaviour (zero recommendations
 * already meant zero repairs); it stops the silence being reported as health.
 */
const plannerSource = fs.readFileSync(
  path.join(process.cwd(), "lib/sync/repair-planner.ts"),
  "utf8",
);
const releaseGateSource = fs.readFileSync(
  path.join(process.cwd(), "lib/sync/release-gates.ts"),
  "utf8",
);

describe("repair plan canary evidence", () => {
  it("treats a gate with no canary evidence as unevaluatable, not as healthy", () => {
    expect(plannerSource).toContain("release_gate_canary_evidence_missing");
    expect(plannerSource).toMatch(
      /releaseGateCanaryEvidenceMissing\s*=\s*[\s\S]{0,120}?Array\.isArray\(releaseGate\?\.evidence\?\.canaries\)/,
    );
  });

  it("orders the new reason inside the blocked ladder, so it makes the plan ineligible", () => {
    const ladder = plannerSource.slice(
      plannerSource.indexOf("const blockedReason ="),
      plannerSource.indexOf("const eligible = blockedReason == null"),
    );
    expect(ladder).toContain("release_gate_canary_evidence_missing");
    expect(
      plannerSource,
      "eligibility must still be derived from blockedReason alone",
    ).toContain("const eligible = blockedReason == null");
  });

  it("does not block a gate that genuinely carries an empty canary list", () => {
    // An empty ARRAY is real evidence — every canary passed. Only a MISSING
    // key means the gate never reported on canaries at all. Conflating the two
    // would permanently block Google, whose gate legitimately reports [].
    expect(plannerSource).toMatch(/!Array\.isArray\(releaseGate\?\.evidence\?\.canaries\)/);
    expect(plannerSource).not.toMatch(
      /releaseGateCanaryEvidenceMissing[\s\S]{0,80}?\.canaries\.length === 0/,
    );
  });

  it("records that the Meta gate is the one with no canary evidence", () => {
    // If the Meta gate ever starts emitting canaries again, this test should be
    // revisited rather than silently kept.
    const metaEvidence = releaseGateSource.slice(
      releaseGateSource.lastIndexOf("evidence: {"),
    );
    expect(metaEvidence.slice(0, 200)).not.toContain("canaries");
  });
});
