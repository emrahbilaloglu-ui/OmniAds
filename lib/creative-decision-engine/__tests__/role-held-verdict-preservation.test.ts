/**
 * ADR D097 — role uncertainty withholds the ACTION, never the finding.
 *
 * Two things were conflated in one predicate. `applyCreativeCampaignLabelGuard`
 * asked only `isHardDecision(label)`, so an unresolved campaign role treated
 * "stop spending on this losing ad" exactly like "add budget to the right
 * campaign" — and on the no-campaign / no-entry branches it went further and
 * overwrote the computed verdict with `diagnose`.
 *
 * The negative controls below are the point of this file. The change must NOT
 * authorize anything: `authorityBlocker` and `blockedActionType` are still
 * stamped on every held row, which is what makes
 * `resolveNativeSnapshotAuthorizedAction` return null. If a future edit relaxes
 * that, these fail.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { applyCreativeCampaignLabelGuard } from "@/lib/creative-decision-engine/campaign-label-guard";
import {
  ENGINE_VERSION,
  NATIVE_AD_ENGINE_VERSION,
  type DecisionLabel,
  type DecisionOutput,
} from "@/lib/creative-decision-engine/types";

const HARD_LABELS: readonly DecisionLabel[] = ["scale", "cut", "refresh"];

function decisionWith(label: DecisionLabel): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: null,
    label,
    reason: "Strong winner against target.",
    confidence: 88,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1.6,
    badges: [],
    metrics: { spend: 900, purchases: 20, roas: 3.2, recent7dRoas: 3.1 },
    preAuthorityLabel: label,
    authorityBlocker: null,
    engineVersion: ENGINE_VERSION,
    generatedAt: "2026-09-21T00:00:00.000Z",
  };
}

/** Every way the role can fail to resolve. */
const UNRESOLVED_CASES = [
  { name: "no campaign attribution", campaignId: null, map: null },
  { name: "campaign with no context entry", campaignId: "campaign-1", map: null },
  {
    name: "low automatic trust",
    campaignId: "campaign-1",
    map: new Map([
      ["campaign-1", { kind: "main", testDimension: null, contextTrust: "low" }],
    ]),
  },
  {
    name: "conflicting automatic context",
    campaignId: "campaign-1",
    map: new Map([
      ["campaign-1", { kind: "main", testDimension: null, contextTrust: "conflict" }],
    ]),
  },
] as const;

const guardFor = (label: DecisionLabel, index: number) =>
  applyCreativeCampaignLabelGuard({
    decision: decisionWith(label),
    input: { campaignId: UNRESOLVED_CASES[index]!.campaignId },
    campaignLabelsById: UNRESOLVED_CASES[index]!.map as never,
  });

describe("POSITIVE — the verdict survives an unresolved role", () => {
  it.each(
    UNRESOLVED_CASES.flatMap((scenario, index) =>
      HARD_LABELS.map((label) => ({ name: `${label} · ${scenario.name}`, label, index })),
    ),
  )("$name keeps its label", ({ label, index }) => {
    expect(guardFor(label, index).label).toBe(label);
  });

  it("marks a Cut as decidable without the role, and Scale/Refresh as not", () => {
    // A Cut answers "should this keep spending" — the economics settle that
    // whichever campaign the ad sits in. Scale and Refresh answer "where", so
    // without a role they are genuinely undetermined, not merely unexecutable.
    for (let index = 0; index < UNRESOLVED_CASES.length; index += 1) {
      expect(guardFor("cut", index).recommendationReadiness).toBe(
        "economically_self_sufficient",
      );
      expect(guardFor("scale", index).recommendationReadiness).toBe("role_conditional");
      expect(guardFor("refresh", index).recommendationReadiness).toBe("role_conditional");
    }
  });

  it("never stamps readiness on a soft decision", () => {
    const soft = applyCreativeCampaignLabelGuard({
      decision: decisionWith("test_more"),
      input: { campaignId: null },
      campaignLabelsById: null,
    });
    expect(soft.label).toBe("test_more");
    expect(soft.recommendationReadiness ?? null).toBeNull();
    expect(soft.blockedActionType ?? null).toBeNull();
  });
});

describe("NEGATIVE — nothing was authorized", () => {
  it.each(
    UNRESOLVED_CASES.flatMap((scenario, index) =>
      HARD_LABELS.map((label) => ({ name: `${label} · ${scenario.name}`, label, index })),
    ),
  )("$name is still held, blocked and capped", ({ label, index }) => {
    const guarded = guardFor(label, index);

    // These three are what make `authorized_action` null downstream.
    expect(guarded.authorityBlocker).toBe("campaign_context");
    expect(guarded.blockedActionType).toBe(label);
    expect(guarded.confidence).toBeLessThanOrEqual(50);
    // A held row never releases kind semantics.
    expect(guarded.campaignKind).toBeNull();
    expect(guarded.campaignRoleStatus).not.toBe("resolved");
  });

  it("leaves the authorized-action gate itself untouched", () => {
    // `resolveNativeSnapshotAuthorizedAction` returns null on ANY blocker. That
    // first line is the reason a preserved Cut verdict still writes nothing, so
    // it is pinned here rather than left to survive on good intentions.
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
      "utf8",
    );
    expect(source).toContain("if (input.authorityBlocker !== null) return null;");
  });

  it("does not let a resolved high-trust role become a blank cheque either", () => {
    const resolved = applyCreativeCampaignLabelGuard({
      decision: decisionWith("scale"),
      input: { campaignId: "campaign-1" },
      campaignLabelsById: new Map([
        ["campaign-1", { kind: "main", testDimension: null, contextTrust: "high" }],
      ]) as never,
    });
    // Resolved role releases the hold — that behaviour predates this ADR and is
    // asserted so the ADR cannot be read as having introduced it.
    expect(resolved.campaignRoleStatus).toBe("resolved");
    expect(resolved.blockedActionType ?? null).toBeNull();
    expect(resolved.recommendationReadiness ?? null).toBeNull();
  });
});

describe("the epoch moved with the behaviour", () => {
  it("publishes under a new producer version", () => {
    // INVARIANTS.md: a change to canonical decision provenance requires a new
    // versioned producer contract; old snapshots stay readable under theirs.
    expect(ENGINE_VERSION).toBe("v3-2026-09-24-cut-proof-floor-story");
    expect(NATIVE_AD_ENGINE_VERSION).toBe(
      "v3-ad-2026-09-24-cut-proof-floor-story-shadow",
    );
  });
});
