import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  annotateMetaRecPresentation,
  serverActionKindForRec,
  serverDecisionLabelForRec,
  serverPrimaryActionLabelForRec,
} from "../rec-presentation";
import type { MetaRecommendation } from "../recommendations";

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec_1",
    level: "adset",
    campaignId: "cmp_1",
    campaignName: "ASC",
    adsetId: "as_1",
    adsetName: "Broad",
    type: "adset_cut_spend",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: "cut",
    title: "Cut spend",
    why: "Underperforming",
    summary: "Cut it",
    recommendedAction: "Pause this ad set",
    expectedImpact: "Save budget",
    evidence: [],
    timeframeContext: {
      coreVerdict: "",
      selectedRangeOverlay: "",
      historicalSupport: "",
      seasonalityFlag: "none",
      note: null,
    },
    ...overrides,
  } as MetaRecommendation;
}

describe("server-owned rec presentation", () => {
  it("keeps campaign/ad-set mutation suggestions review-only", () => {
    expect(serverPrimaryActionLabelForRec(rec({ type: "adset_cut_spend" }))).toBe(
      "Review cut plan",
    );
    expect(
      serverPrimaryActionLabelForRec(
        rec({
          type: "bid_value_guidance",
          proposedAction: { kind: "apply_bid", bidAmountMinor: 500 },
        }),
      ),
    ).toBe("Review tuning");
    // Scale recs have no execute path on this page - the old UI said
    // "Scale budget" on a button that only opened a drawer.
    const scale = rec({ type: "adset_scale_budget", proposedAction: undefined });
    expect(serverActionKindForRec(scale)).toBe("review_drill");
    expect(serverPrimaryActionLabelForRec(scale)).toBe("Review scale plan");
    const keep = rec({ type: "scenario_m2_mid_funnel_steady_keep", proposedAction: undefined });
    expect(serverPrimaryActionLabelForRec(keep)).toBe("Review status");
  });

  it.each([
    [{ kind: "pause" } as const, "adset_cut_spend"],
    [{ kind: "resume" } as const, "adset_state"],
    [
      { kind: "apply_bid", bidAmountMinor: 500 } as const,
      "bid_value_guidance",
    ],
  ])(
    "does not treat proposedAction %o as provider-write authority",
    (proposedAction, type) => {
      const candidate = rec({
        type: type as MetaRecommendation["type"],
        proposedAction,
      });
      expect(serverActionKindForRec(candidate)).toBe("review_drill");
      expect(serverPrimaryActionLabelForRec(candidate)).toMatch(/^Review /);
    },
  );

  it("never exposes an execute CTA for test or watch decisions", () => {
    const watchCut = rec({
      type: "adset_cut_spend",
      decisionState: "watch",
    });
    expect(serverActionKindForRec(watchCut)).toBe("review_drill");
    expect(serverPrimaryActionLabelForRec(watchCut)).toBe("Review cut plan");

    const testBid = rec({
      type: "bid_value_guidance",
      decisionState: "test",
      proposedAction: { kind: "apply_bid", bidAmountMinor: 500 },
    });
    expect(serverActionKindForRec(testBid)).toBe("review_drill");
    expect(serverPrimaryActionLabelForRec(testBid)).toBe("Review tuning");
  });

  it("routes launchpad handoffs explicitly", () => {
    const rebuild = rec({ type: "rebuild_with_constraints" });
    expect(serverActionKindForRec(rebuild)).toBe("route_launchpad_rebuild");
    expect(serverPrimaryActionLabelForRec(rebuild)).toBe("Rebuild in Launchpad");
    const promote = rec({ type: "winner_promotion_flow" });
    expect(serverActionKindForRec(promote)).toBe("route_launchpad_duplicate");
    expect(serverPrimaryActionLabelForRec(promote)).toBe("Promote in Launchpad");
  });

  it("derives decision labels server-side with engine label precedence", () => {
    expect(serverDecisionLabelForRec(rec({ decisionLabel: "tune" }))).toBe("tune");
    expect(serverDecisionLabelForRec(rec({ type: "adset_cut_spend" }))).toBe("cut");
    expect(
      serverDecisionLabelForRec(
        rec({
          type: "scale_for_profitability",
          recommendedAction: "Reduce budget and tighten the cap",
        }),
      ),
    ).toBe("tune");
    expect(
      serverDecisionLabelForRec(rec({ type: "scenario_e2_ctr_decay_refresh" })),
    ).toBe("refresh");
  });

  it("annotates recommendations with presentation fields and structured metrics", () => {
    const metrics = new Map([
      ["as_1", { spend: 120.5, roas: 1.8, cpa: 22, ctr: 1.1, purchases: 6, frequency: 1.9 }],
    ]);
    const rowPresentation = new Map([
      ["as_1", { accountId: "act_1234567890", thumbLabel: null }],
    ]);
    const [annotated] = annotateMetaRecPresentation([rec()], metrics, rowPresentation);
    expect(annotated.actionKind).toBe("review_drill");
    expect(annotated.primaryActionLabel).toBe("Review cut plan");
    expect(annotated.decisionLabel).toBe("cut");
    expect(annotated.rowPresentation).toMatchObject({
      accountBadge: "act_1234567890",
      thumbLabel: null,
      signal: null,
      autoBadge: false,
    });
    expect(annotated.metrics).toEqual({
      spend: 120.5,
      roas: 1.8,
      cpa: 22,
      ctr: 1.1,
      purchases: 6,
      frequency: 1.9,
    });
    const [noMetrics] = annotateMetaRecPresentation([rec({ adsetId: "unknown" })]);
    expect(noMetrics.metrics).toBeNull();
  });

  it("builds row protection markers from server readiness evidence", () => {
    const [blocked] = annotateMetaRecPresentation([
      rec({
        automationReadiness: {
          contractVersion: "meta-automation-readiness.v1",
          tier: "manual_review",
          autoExecuteEligible: false,
          operatorReviewRequired: true,
          decisionLabel: "cut",
          blockers: ["missing_live_preflight"],
          missingEvidence: ["live_preflight"],
          requiredEvidence: ["commercial_anchor", "live_preflight"],
          reason: "Live preflight is required before execution.",
        },
      }),
    ]);
    expect(blocked.rowPresentation).toMatchObject({
      signal: "blocker",
      blockerLabel: "Missing Live Preflight",
      autoBadge: false,
      warnLine: "Automation blocked · Missing Live Preflight",
    });

    const [auto] = annotateMetaRecPresentation([
      rec({
        automationReadiness: {
          contractVersion: "meta-automation-readiness.v1",
          tier: "auto_execute",
          autoExecuteEligible: true,
          operatorReviewRequired: false,
          decisionLabel: "cut",
          blockers: [],
          missingEvidence: [],
          requiredEvidence: ["commercial_anchor"],
          reason: "All checks passed.",
        },
      }),
    ]);
    expect(auto.rowPresentation).toMatchObject({
      signal: null,
      autoBadge: true,
      warnLine: null,
    });
  });
});

describe("invariant: Meta redesign UI does not compute action semantics", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\./.test(entry)) return [];
      return [full];
    });
  }

  it("keeps rec-label-mapping (client-side semantics) out of the redesign components", () => {
    const offenders = sourceFiles("components/meta/redesign").filter((file) =>
      readFileSync(file, "utf8").includes("rec-label-mapping"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps regex/string inference over recommendedAction out of the redesign components", () => {
    const offenders = sourceFiles("components/meta/redesign").filter((file) => {
      const source = readFileSync(file, "utf8");
      return /recommendedAction[^;\n]*\.(match|test|includes|search)\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps evidence display-string parsing out of compare/bulk math", () => {
    const offenders = sourceFiles("components/meta/redesign").filter((file) => {
      const source = readFileSync(file, "utf8");
      return /evidence\.find\([^)]*\)\s*\??\.\s*value\.replace\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
