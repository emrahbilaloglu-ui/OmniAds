import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
  assertDbSchemaReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/business-commercial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/business-commercial")>();
  return { ...actual, getBusinessCommercialTruthSnapshot: vi.fn() };
});
vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  readCampaignContextLabelMap: vi.fn(async () => new Map([
    ["campaign-1", {
      kind: "main", contextTrust: "high", inferenceConfidenceClass: "high",
      resolverAuthorityValidated: true, provenance: { source: "system_inferred" },
    }],
  ])),
}));
vi.mock("@/lib/meta/empirical-outcome-integration", () => ({
  attachMetaEmpiricalOutcomeSummariesFromLogs: vi.fn(async (input) => input.recommendations),
}));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({ anomalies: [] })),
}));
/*
  The account/cutoff-scoped Meta-attributed purchase sample.

  ROUND 6 made a READY sample the second half of purchase-value budget
  authority, and `readLatestMetaDecisionSnapshot` now reads it for the
  snapshot's own account and day. Mocked here rather than seeded as warehouse
  rows because this file is about TARGET authority: the sample is a fixed input
  so the assertions below keep measuring which target pack was consulted.
  `metaAovSample` is reassigned per case, including to `null`, which is how the
  hold is proven on the same fixtures.
*/
let metaAovSample: { aovMean: number; purchaseCount: number; totalRevenue: number } | null;
vi.mock("@/lib/creative-decision-engine/meta-aov-calculator", () => ({
  computeMetaAttributedAov: vi.fn(async () => metaAovSample),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(async () => null),
}));

import * as db from "@/lib/db";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";
import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const BUSINESS = "d8a30000-0000-4000-8000-0000000000b1";
const SNAPSHOT_DAY = "2026-09-03";
const CEILING = "2026-09-05";
const historyCalls: Array<{ text: string; params: unknown[] }> = [];
let historyRows: Record<string, unknown>[];
let historyError: Error | null;
let snapshotRows: Record<string, unknown>[];

function currentTarget(targetRoas: number | null) {
  vi.mocked(getBusinessCommercialTruthSnapshot).mockResolvedValue({
    targetPack: { targetRoas, updatedAt: "2026-09-05T02:00:00.000Z" },
    sectionMeta: { targetPack: { freshness: {
      status: "fresh", updatedAt: "2026-09-05T02:00:00.000Z",
    } } },
  } as Awaited<ReturnType<typeof getBusinessCommercialTruthSnapshot>>);
}

function read(
  snapshotDateCeiling: string | null = CEILING,
  over: { endDate?: string } = {},
) {
  return readLatestMetaDecisionSnapshot({
    businessId: BUSINESS, providerAccountId: "act_1",
    startDate: "2026-09-01",
    // ROUND 10 ITEM 3: overridable so a case can drive the range-picker shape —
    // a metric range that ends long before the snapshot actually served.
    endDate: over.endDate ?? CEILING,
    snapshotDateCeiling,
  });
}

function persistedBudgetAllocation(
  lens: MetaRecommendation["lens"],
): Record<string, unknown> {
  const recommendation: MetaRecommendation = {
    id: `historical-budget-${lens}`,
    level: "account",
    type: "budget_allocation",
    lens,
    priority: "high",
    confidence: "high",
    confidenceScore: 0.9,
    decisionState: "act",
    decision: "Reallocate budget toward Purchase Scale A",
    title: "Move budget from Purchase Validation into Purchase Scale A",
    why: "Purchase Validation trails Purchase Scale A in the comparable cohort.",
    summary: "Purchase Scale A can absorb spend assigned to Purchase Validation.",
    recommendedAction:
      "Shift 10-15% budget from Purchase Validation into Purchase Scale A.",
    expectedImpact: "Transfer more spend into Purchase Scale A for cleaner blended ROAS.",
    evidence: [
      { label: "Best campaign", value: "Purchase Scale A", tone: "positive" },
      { label: "Weak campaign", value: "Purchase Validation", tone: "warning" },
    ],
    timeframeContext: {
      coreVerdict: "leader and laggard resolved",
      selectedRangeOverlay: "same cohort",
      historicalSupport: "supported",
      seasonalityFlag: "none",
      note: null,
    },
    proposedAction: { kind: "pause" },
    targetValue: { budgetShiftPct: 15 },
  };
  return {
    scope_type: "account",
    scope_id: BUSINESS,
    business_id: BUSINESS,
    provider_account_id: "act_1",
    snapshot_date: SNAPSHOT_DAY,
    rec_id: recommendation.id,
    rec_type: recommendation.type,
    level: recommendation.level,
    decision_state: recommendation.decisionState,
    confidence_score: recommendation.confidenceScore,
    recommended_action: recommendation.recommendedAction,
    reasoning: recommendation.why,
    expected_impact: recommendation.expectedImpact,
    engine_version: "v1.3.0",
    created_at: "2026-09-03T03:00:00.000Z",
    decision_label: "scale",
    evidence: { recommendation, items: recommendation.evidence },
    target_value: recommendation.targetValue,
  };
}

function budgetPresentationText(recommendation: MetaRecommendation) {
  return [
    recommendation.decision,
    recommendation.title,
    recommendation.why,
    recommendation.summary,
    recommendation.recommendedAction,
    recommendation.expectedImpact,
    recommendation.stateReason,
  ].join(" ");
}

const BUDGET_INSTRUCTION_LEAK =
  /Purchase Scale A|Purchase Validation|10[-–]15%|\b(?:shift|reallocate|move|transfer|redirect)\b/i;

// The snapshot reader, commercial normalization, action guard, target history
// reader and daily brief are real. Only storage and unrelated enrichments are
// replaced, so a historical read accidentally using current targets changes
// both the served action and the brief's actionable count.
beforeEach(() => {
  vi.clearAllMocks();
  historyCalls.length = 0;
  historyError = null;
  historyRows = [{
    target_roas: 2.2, target_cpa: null, aov_assumption: null,
    updated_at: "2026-09-03T02:00:00.000Z", operation: "upsert",
  }];
  snapshotRows = [{
    scope_type: "campaign", scope_id: "campaign-1", business_id: BUSINESS,
    snapshot_date: SNAPSHOT_DAY, rec_id: "scale-1", rec_type: "scale_for_volume",
    level: "campaign", decision_state: "act", confidence_score: 0.9,
    recommended_action: "Increase the budget", reasoning: "Mature scale signal",
    engine_version: "v1", created_at: "2026-09-03T03:00:00.000Z",
    decision_label: "scale", evidence: { items: [] }, target_value: 10,
  }];
  currentTarget(null);
  metaAovSample = { aovMean: 88, purchaseCount: 60, totalRevenue: 5280 };
  const query = async (text: string, params: unknown[] = []) => {
    if (text.includes("FROM meta_decision_snapshots_daily") && text.includes("WITH latest AS")) {
      return snapshotRows;
    }
    if (text.includes("FROM business_target_pack_history")) {
      historyCalls.push({ text, params });
      if (historyError) throw historyError;
      return historyRows;
    }
    return [];
  };
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...params: unknown[]) => query(
      strings.reduce((text, part, i) => text + part + (i < params.length ? `$${i + 1}` : ""), ""),
      params,
    ),
    { query },
  );
  vi.mocked(db.getDb).mockReturnValue(sql as ReturnType<typeof db.getDb>);
});

describe("historical snapshot commercial authority", () => {
  it("preserves a past ROAS-only action after the current target was removed", async () => {
    const result = await read();
    expect(result?.recommendations[0]).toMatchObject({ decisionState: "act", targetValue: 10 });
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
    expect(historyCalls).toHaveLength(1);
    // Use the selected snapshot, not the later ceiling or metric end date.
    expect(historyCalls[0].params).toEqual([
      BUSINESS, `${SNAPSHOT_DAY}T03:00:00.000Z`, `${SNAPSHOT_DAY}T03:00:00.000Z`,
    ]);
    expect(historyCalls[0].text).toContain("effective_at <= $2::timestamptz");
    expect(historyCalls[0].text).toContain("recorded_at <= $3::timestamptz");
  });

  it("HOLDS the same persisted action when the account's Meta sample is absent", async () => {
    /*
      The other half of the unit, on the very fixture the case above proves.
      A Target ROAS with no ready Meta-attributed AOV has no authoritative
      money-per-purchase, so the persisted Scale is served as evidence with its
      verdict intact and no spend authority — never re-anchored on a CPA.
    */
    metaAovSample = null;
    const result = await read();
    expect(result?.recommendations[0]).toMatchObject({
      decisionState: "watch",
      signalQuality: expect.objectContaining({
        hard_action_authority: "blocked",
        hard_action_blocker: "commercial_anchor_missing",
      }),
    });
    expect(result?.recommendations[0]).not.toHaveProperty("targetValue");
  });

  it("HOLDS the same persisted action when the Meta sample is too thin", async () => {
    metaAovSample = { aovMean: 88, purchaseCount: 9, totalRevenue: 792 };
    const result = await read();
    expect(result?.recommendations[0]).toMatchObject({
      decisionState: "watch",
      signalQuality: expect.objectContaining({
        hard_action_blocker: "commercial_anchor_sample_insufficient",
      }),
    });
  });

  it.each([
    ["volume", "READY", { aovMean: 88, purchaseCount: 60, totalRevenue: 5280 }, "act", null],
    ["volume", "missing", null, "watch", "commercial_anchor_missing"],
    [
      "volume",
      "thin",
      { aovMean: 88, purchaseCount: 9, totalRevenue: 792 },
      "watch",
      "commercial_anchor_sample_insufficient",
    ],
    [
      "profitability",
      "READY",
      { aovMean: 88, purchaseCount: 60, totalRevenue: 5280 },
      "act",
      null,
    ],
    ["profitability", "missing", null, "watch", "commercial_anchor_missing"],
    [
      "profitability",
      "thin",
      { aovMean: 88, purchaseCount: 9, totalRevenue: 792 },
      "watch",
      "commercial_anchor_sample_insufficient",
    ],
  ] as const)(
    "rechecks a persisted %s budget allocation against the snapshot-day %s Meta sample",
    async (lens, sampleState, sample, expectedState, blocker) => {
      const supportingCampaignRow = snapshotRows[0]!;
      snapshotRows = [persistedBudgetAllocation(lens), supportingCampaignRow];
      metaAovSample = sample;

      const result = await read();
      const budgetShift = result?.recommendations.find(
        (recommendation) => recommendation.type === "budget_allocation",
      );
      expect(budgetShift).toBeDefined();
      expect(budgetShift?.decisionState).toBe(expectedState);

      const aov = await import(
        "@/lib/creative-decision-engine/meta-aov-calculator"
      );
      expect(vi.mocked(aov.computeMetaAttributedAov)).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS,
          providerAccountId: "act_1",
          asOf: SNAPSHOT_DAY,
        }),
      );

      if (blocker === null) {
        expect(budgetPresentationText(budgetShift!)).toMatch(
          /Purchase Scale A|Purchase Validation|10[-–]15%/,
        );
        expect(budgetShift?.proposedAction).toEqual({ kind: "pause" });
        expect(budgetShift?.targetValue).toEqual({ budgetShiftPct: 15 });
      } else {
        const expectedHoldReason = sampleState === "missing"
          ? "Meta-attributed purchase value is missing for this account and evidence cutoff."
          : "The Meta-attributed purchase sample is too small to support a spend change.";
        expect(budgetShift).toMatchObject({
          confidence: "medium",
          confidenceScore: 0.69,
          decision: "Review only: commercial action authority is blocked",
          title: "Budget allocation remains review-only",
          why: expectedHoldReason,
          summary:
            "Performance evidence remains available for diagnosis, but it does not authorize a budget change.",
          recommendedAction:
            "Review the evidence and restore the missing commercial authority before re-evaluating. Keep current spend unchanged.",
          expectedImpact:
            "Prevents an unsupported spend change while preserving the evidence for review.",
          stateReason: expectedHoldReason,
          signalQuality: {
            hard_action_authority: "blocked",
            hard_action_blocker: blocker,
          },
        });
        expect(budgetShift).not.toHaveProperty("proposedAction");
        expect(budgetShift).not.toHaveProperty("targetValue");
        expect(budgetPresentationText(budgetShift!)).not.toMatch(
          BUDGET_INSTRUCTION_LEAK,
        );
      }
    },
  );

  it("keeps the historical daily brief's actionable count after current target removal", async () => {
    const result = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: CEILING,
    });
    expect(result.decisions.actionable).toBe(1);
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
    expect(historyCalls[0].params[1]).toBe(`${SNAPSHOT_DAY}T03:00:00.000Z`);
  });

  it("reads the SERVED SNAPSHOT's targets even for an uncapped past metric range", async () => {
    /*
      ── ROUND 10 ITEM 3 ─────────────────────────────────────────────────────

      This case previously required the opposite — that an uncapped read consult
      the CURRENT pack — and that is the defect. Without a ceiling the reader
      still resolves `MAX(snapshot_date)` over all time, so a March metric range
      routinely serves a September snapshot. The old rule then guarded those
      September decisions with today's targets while the Meta AOV beside them
      was already read at the September snapshot date and the outcome evidence
      was read at the March request date: one authority decision assembled from
      three different periods.

      The rows being guarded were produced ON the snapshot's day, so the pack in
      force that day is the one that authorized them. All three reads now take
      that single cutoff, and the current-snapshot reader is not consulted at
      all — which is what these assertions now hold.
    */
    // History at the served day authorizes, so the row acts.
    expect((await read(null))?.recommendations[0].decisionState).toBe("act");

    // Now the discriminating half: the CURRENT pack authorizes and the pack in
    // force on the served day does NOT. The old rule answered `act` here.
    currentTarget(4.5);
    historyRows = [];
    expect((await read(null))?.recommendations[0]).toMatchObject({
      decisionState: "watch",
      signalQuality: { hard_action_blocker: "commercial_target_missing" },
    });
    // The current-snapshot reader is never consulted on this path at all.
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
    expect(historyCalls.length).toBeGreaterThan(0);
  });

  it.each(["absent", "deleted"])("withholds a past action for %s history even if a current ROAS exists", async (state) => {
    currentTarget(4.5);
    historyRows = state === "absent" ? [] : [{ ...historyRows[0], operation: "delete" }];
    const rec = (await read())?.recommendations[0];
    expect(rec).toMatchObject({
      decisionState: "watch", signalQuality: { hard_action_blocker: "commercial_target_missing" },
    });
    expect(rec?.targetValue).toBeUndefined();
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("withholds on a history read error and recovers using history without a current-target fallback", async () => {
    currentTarget(4.5);
    historyError = new Error("transient history read failure");
    expect((await read())?.recommendations[0]).toMatchObject({
      decisionState: "watch", signalQuality: { hard_action_blocker: "commercial_target_missing" },
    });
    historyError = null;
    expect((await read())?.recommendations[0].decisionState).toBe("act");
    expect(historyCalls).toHaveLength(2);
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("keeps invalid historical target provenance fail-closed", async () => {
    currentTarget(4.5);
    historyRows[0].updated_at = null;
    expect((await read())?.recommendations[0]).toMatchObject({
      decisionState: "watch", signalQuality: { hard_action_blocker: "commercial_target_unknown" },
    });
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("does not read target authority when no snapshot exists at the ceiling", async () => {
    snapshotRows = [];
    expect(await read()).toBeNull();
    expect(historyCalls).toEqual([]);
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });
});

/*
  ── ROUND 10 ITEM 3: ONE CUTOFF, PROVEN BY COUNTERFACTUAL ────────────────────

  Three economic reads used three different dates. Proving they now agree needs
  more than "the same value came out": each input is moved on D+1 — the day
  AFTER the served snapshot — and each must be invisible. A read that still
  looked at `input.endDate` or at the current pack would see one of them.
*/
describe("every economic read takes the served snapshot's day", () => {
  const D_PLUS_ONE = "2026-09-04";

  beforeEach(() => {
    metaAovSample = { aovMean: 180, purchaseCount: 60, totalRevenue: 10_800 };
  });

  it("asks history, the AOV and the outcomes for the SAME day", async () => {
    const aov = await import(
      "@/lib/creative-decision-engine/meta-aov-calculator"
    );
    const outcomes = await import("@/lib/meta/empirical-outcome-integration");
    vi.mocked(aov.computeMetaAttributedAov).mockClear();
    vi.mocked(
      outcomes.attachMetaEmpiricalOutcomeSummariesFromLogs,
    ).mockClear();

    // A request whose metric range ends well BEFORE the snapshot that will be
    // served — the range-picker case that produced three periods.
    await read(null, { endDate: "2026-03-31" });

    expect(vi.mocked(aov.computeMetaAttributedAov).mock.calls[0]?.[0]).toMatchObject(
      { asOf: SNAPSHOT_DAY },
    );
    expect(
      vi.mocked(outcomes.attachMetaEmpiricalOutcomeSummariesFromLogs).mock
        .calls[0]?.[0],
    ).toMatchObject({ endDate: SNAPSHOT_DAY });
    // The historical target read used the same day, and the CURRENT reader was
    // not consulted at all.
    expect(historyCalls.length).toBeGreaterThan(0);
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("does not see a target raised on D+1", async () => {
    /*
      The pack in force on the served day authorizes; a pack saved the next day
      must not. `getBusinessTargetPackHistoryAsOf` bounds on
      `effective_at <= cutoff`, so a D+1 row is simply not returned — which is
      only true if the cutoff is the snapshot's day.
    */
    historyRows = [
      {
        target_roas: 2.2,
        target_cpa: null,
        aov_assumption: null,
        updated_at: `${SNAPSHOT_DAY}T02:00:00.000Z`,
        operation: "upsert",
      },
    ];
    expect((await read(null))?.recommendations[0].decisionState).toBe("act");

    // Same account, target CLEARED on D+1. Reading D+1 would withhold; reading
    // the served day must not.
    const cutoffParams = historyCalls.at(-1)?.params ?? [];
    expect(
      cutoffParams.some(
        (param) => typeof param === "string" && param.startsWith(SNAPSHOT_DAY),
      ),
      JSON.stringify(cutoffParams),
    ).toBe(true);
    expect(
      cutoffParams.some(
        (param) => typeof param === "string" && param.startsWith(D_PLUS_ONE),
      ),
    ).toBe(false);
  });

  it("HOLDS when the served day's AOV is thin, whatever a later day holds", async () => {
    /*
      The mixed-period pair the item forbids: a ratio from one day divided by an
      average order value from another. With one cutoff, a thin sample on the
      served day holds the action outright — there is no later, richer sample
      for it to borrow.
    */
    metaAovSample = { aovMean: 180, purchaseCount: 4, totalRevenue: 720 };
    expect((await read(null))?.recommendations[0]).toMatchObject({
      decisionState: "watch",
    });
  });
});
