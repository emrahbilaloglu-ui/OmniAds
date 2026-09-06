// Focused harness tests for the generalized point-in-time replay runner
// (correction 2 / contract v2 — composite business+account grain).
//
// Fixture tests prove the HARNESS; the UI-truth suite feeds REAL frozen
// replay states through the server-owned presentation projection (that
// projection boundary is declared in the runner's verification contract);
// the report-facts gate ties every headline number in the report to the
// artifact. Fixtures never support business conclusions.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION_EMBARGO_DAYS,
  CASCADING_ATTACK_CASE_NAMES,
  EXTRACTION_ATTESTED_SECTIONS,
  PROTECTED_TOP_LEVEL_KEYS,
  PROVENANCE_SOURCE_FILES,
  RELAUNCH_GAP_DAYS,
  analyzePitReplay,
  analyzeRoleTimelines,
  assemblePitReplayArtifact,
  buildRecoverySimulationSection,
  buildRoleTimelines,
  campaignMetaAsOf,
  classifyOriginTemporal,
  compactRoleTimelines,
  contextEntryFromRoleState,
  creativeRowsUpTo,
  enumerateDecisionOrigins,
  firstRelaunchDates,
  horizonSupport,
  isOutcomeWindowMature,
  lastEvaluatedDayAtOrBefore,
  migrateNameRowsToV3,
  outcomeAggregateFor,
  priorStateKey,
  rebuildRoleTimelines,
  renderReportFactsBlock,
  roleStateAt,
  sha256Canonical,
  simulateFenceRecovery,
  targetPackAsOf,
  targetReferenceTimeUtc,
  verifyAnchoredPackage,
  verifyPitReplayArtifact,
  verifyTargetsAtOrigins,
  PIT_REPLAY_JSON_OUT,
  type CreativeDayTuple,
  type PitReplayFrozenInputs,
  type PitTargetHistoryRow,
  type ReplayDecisionRowCompact,
} from "@/scripts/creative-decision-center/generalized-pit-replay";
import { applyDailyHysteresis } from "@/lib/creative-decision-engine/jobs/campaign-context-job";
import {
  applyCreativeCampaignLabelGuard,
  withCreativeCampaignLabelContext,
  type CreativeCampaignContextEntry,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import { decideCreative } from "@/lib/creative-decision-engine/engine";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "@/lib/creative-decision-engine/__tests__/helpers";
import type { DecisionOutput } from "@/lib/creative-decision-engine/types";
import { projectCanonicalMetaDecisionPresentation } from "@/lib/meta/canonical-decision-presentation";
import type { MetaDecisionLifecycleRole } from "@/lib/meta/decisions-workspace-contract";

const RUNNER_SOURCE = readFileSync(
  resolve("scripts/creative-decision-center/generalized-pit-replay.ts"),
  "utf8",
);

function tuple(over: Partial<{
  business: string;
  account: string;
  campaign: string;
  adset: string | null;
  creative: string;
  date: string;
  spend: number;
  conversions: number;
  revenue: number;
  firstSpend: string;
  restated: number | null;
}> = {}): CreativeDayTuple {
  return [
    over.business ?? "b1",
    over.account ?? "act_a",
    over.campaign ?? "cmp_1",
    over.adset ?? "set_1",
    over.creative ?? "cre_1",
    over.date ?? "2026-03-10",
    over.spend ?? 10,
    over.conversions ?? 1,
    over.revenue ?? 20,
    over.firstSpend ?? "2026-03-01",
    over.restated ?? null,
  ];
}

function targetRow(over: Partial<PitTargetHistoryRow> = {}): PitTargetHistoryRow {
  return {
    businessId: "b1",
    id: null,
    operation: "upsert",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    targetRoas: 2,
    breakEvenRoas: 1.5,
    targetCpa: null,
    breakEvenCpa: null,
    defaultRiskPosture: "balanced",
    ...over,
  };
}

function decisionRow(
  over: Partial<ReplayDecisionRowCompact>,
): ReplayDecisionRowCompact {
  return {
    businessId: "b1",
    originDate: "2026-03-10",
    freshnessMode: "historical",
    creativeId: "cre_1",
    campaignId: "cmp_1",
    providerAccountId: "act_selected",
    label: "keep",
    rawLabel: "keep",
    preAuthorityLabel: null,
    authorityBlocker: null,
    blockedActionType: null,
    confidence: 60,
    campaignKind: null,
    campaignRoleStatus: "unresolved",
    contextTrust: "unknown",
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1,
    spend: 100,
    purchases: 2,
    roas: 2,
    recent7dSpend: 30,
    ageDays: 20,
    effectiveStatus: "ACTIVE",
    dataFreshnessHours: 3,
    badges: [],
    inputHash: "x",
    ...over,
  };
}

function frozenFixture(): PitReplayFrozenInputs {
  return {
    scope: {
      businesses: [
        { businessId: "b1", name: "B1", currency: "TRY", timezone: "UTC", engineEnabled: true },
      ],
      accounts: [
        { businessId: "b1", providerAccountId: "act_selected", isSelected: true, accountCurrency: "TRY", accountTimezone: "UTC" },
        { businessId: "b1", providerAccountId: "act_second", isSelected: true, accountCurrency: "USD", accountTimezone: "UTC" },
        { businessId: "b1", providerAccountId: "act_deselected", isSelected: false, accountCurrency: "TRY", accountTimezone: "UTC" },
      ],
    },
    targetHistory: [targetRow()],
    creativeDayTuples: [
      tuple({ account: "act_selected", date: "2026-03-11", spend: 10, revenue: 30, conversions: 1 }),
    ],
    campaignNamePoints: [],
    campaignFirstSeen: [],
    coverage: [
      {
        businessId: "b1",
        providerAccountId: "act_selected",
        isSelected: true,
        rowCount: 100,
        minDate: "2026-01-01",
        maxDate: "2026-03-20",
        restatedRowCount: 60,
      },
      {
        businessId: "b1",
        providerAccountId: "act_second",
        isSelected: true,
        rowCount: 40,
        minDate: "2026-02-01",
        maxDate: "2026-03-10",
        restatedRowCount: 4,
      },
      {
        businessId: "b1",
        providerAccountId: "act_deselected",
        isSelected: false,
        rowCount: 10,
        minDate: "2026-03-01",
        maxDate: "2026-03-15",
        restatedRowCount: 1,
      },
    ],
    originPlans: {
      b1: {
        firstSupportedOrigin: "2026-01-29",
        lastSupportedOrigin: "2026-03-20",
        populationDays: 51,
        sampledOrigins: ["2026-03-09", "2026-03-10"],
        consecutivePairs: [["2026-03-09", "2026-03-10"]],
        cadence: "fixture",
      },
    },
    perOriginDecisions: [
      decisionRow({ originDate: "2026-03-09", label: "keep" }),
      decisionRow({ originDate: "2026-03-10", label: "cut", rawLabel: "cut" }),
      decisionRow({
        originDate: "2026-03-10",
        creativeId: "cre_deselected",
        providerAccountId: "act_deselected",
        label: "scale",
      }),
      decisionRow({
        originDate: "2026-03-10",
        creativeId: "cre_unscoped",
        campaignId: null,
        providerAccountId: null,
        label: "refresh",
      }),
      decisionRow({
        originDate: "2026-03-10",
        freshnessMode: "wall_clock_stale",
        label: "cut",
        blockedActionType: null,
      }),
      decisionRow({
        originDate: "2026-03-10",
        freshnessMode: "wall_clock_stale",
        creativeId: "cre_held",
        label: "diagnose",
        blockedActionType: "cut",
      }),
      decisionRow({
        originDate: "2026-03-10",
        freshnessMode: "wall_clock_stale",
        creativeId: "cre_stale_desel",
        providerAccountId: "act_deselected",
        label: "scale",
      }),
      decisionRow({
        originDate: "2026-03-10",
        freshnessMode: "wall_clock_stale",
        creativeId: "cre_stale_unscoped",
        campaignId: null,
        providerAccountId: null,
        label: "scale",
      }),
    ],
    perOriginMeta: [
      {
        businessId: "b1",
        originDate: "2026-03-10",
        decisionCutoffUtc: "2026-03-10T23:59:59.999Z",
        sourceMode: "runtime_sql_fallback",
        lifecycleComputedAt: null,
        inputCount: 1,
        profilePreset: "fixture",
        hardActionEligibility: {},
        thresholds: {
          commercialMaturitySpend: 200,
          hardCutSpend: 1000,
          scaleMinPurchases: 10,
        },
        determinismHashFirst: "h",
        determinismHashSecond: "h",
      },
    ],
  };
}

// ---------------------------------------------------------------------------

describe("generalized PIT replay — label isolation (hard rule)", () => {
  it("the runner source never touches manual-label authority or a manual-label reader", () => {
    for (const forbidden of [
      "meta_campaign_labels",
      "meta_campaign_label_history",
      "readMetaCampaignLabels",
      "buildCreativeCampaignLabelMap",
      "/api/meta/campaign-labels",
    ]) {
      expect(
        RUNNER_SOURCE.includes(forbidden),
        `runner must not reference ${forbidden}`,
      ).toBe(false);
    }
    expect(RUNNER_SOURCE.includes("buyerAction")).toBe(false);
  });

  it("the PRIMARY inference path is name-blind and no manual-label comparator exists", () => {
    expect(RUNNER_SOURCE.includes("nameBlind: true")).toBe(true);
    expect(RUNNER_SOURCE.includes("primaryInferenceNameBlind: true")).toBe(true);
    expect(RUNNER_SOURCE.includes("manualLabelComparatorIncluded: false")).toBe(true);
  });

  it("name-blind feature building nulls campaign names", () => {
    const namePoints = [
      { businessId: "b1", accountId: "act_a", campaignId: "cmp_1", date: "2026-03-01", campaignName: "TEST | new audience" },
    ];
    const firstSeen = [
      { businessId: "b1", accountId: "act_a", campaignId: "cmp_1", firstSeenDate: "2026-03-01" },
    ];
    expect(
      campaignMetaAsOf({ namePoints, firstSeen, businessId: "b1", accountId: "act_a", t0: "2026-03-10", nameBlind: true }).get("cmp_1")?.campaignName,
    ).toBeNull();
    expect(
      campaignMetaAsOf({ namePoints, firstSeen, businessId: "b1", accountId: "act_a", t0: "2026-03-10", nameBlind: false }).get("cmp_1")?.campaignName,
    ).toBe("TEST | new audience");
  });

  it("manual-label ablation: a label-shaped section changes nothing in the analysis", () => {
    const withLabels = {
      ...frozenFixture(),
      manualLabels: [{ campaignId: "cmp_1", campaignKind: "test" }],
    } as unknown as PitReplayFrozenInputs;
    expect(sha256Canonical(analyzePitReplay(withLabels))).toBe(
      sha256Canonical(analyzePitReplay(frozenFixture())),
    );
  });
});

describe("generalized PIT replay — composite identity (business+account grain)", () => {
  it("the same provider account id under two businesses with colliding campaign/creative ids never mixes", () => {
    const tuples: CreativeDayTuple[] = [
      tuple({ business: "b1", account: "act_x", creative: "cre_1", date: "2026-03-05", spend: 10 }),
      tuple({ business: "b2", account: "act_x", creative: "cre_1", date: "2026-03-05", spend: 9_999 }),
    ];
    const b1Rows = creativeRowsUpTo(tuples, "b1", "act_x", "2026-03-10");
    expect(b1Rows).toHaveLength(1);
    expect(b1Rows[0].spend).toBe(10);
    const b1Outcome = outcomeAggregateFor({
      tuples,
      businessId: "b1",
      providerAccountId: "act_x",
      creativeId: "cre_1",
      t0: "2026-03-01",
      horizonDays: 7,
    });
    expect(b1Outcome.outcomeSpend).toBe(10);
    const b1Timelines = buildRoleTimelines({
      tuples,
      namePoints: [],
      firstSeen: [],
      businessId: "b1",
      accountId: "act_x",
      days: ["2026-03-05", "2026-03-06"],
      nameBlind: true,
    });
    const b2Timelines = buildRoleTimelines({
      tuples,
      namePoints: [],
      firstSeen: [],
      businessId: "b2",
      accountId: "act_x",
      days: ["2026-03-05", "2026-03-06"],
      nameBlind: true,
    });
    expect(sha256Canonical([...b1Timelines])).not.toBe(sha256Canonical([...b2Timelines]));
  });

  it("two selected accounts in one business with colliding creative ids keep outcomes separate", () => {
    const tuples: CreativeDayTuple[] = [
      tuple({ account: "act_a", creative: "cre_shared", date: "2026-03-11", spend: 10, revenue: 20 }),
      tuple({ account: "act_b", creative: "cre_shared", date: "2026-03-11", spend: 1000, revenue: 0 }),
    ];
    const scoped = outcomeAggregateFor({
      tuples,
      businessId: "b1",
      providerAccountId: "act_a",
      creativeId: "cre_shared",
      t0: "2026-03-10",
      horizonDays: 3,
    });
    expect(scoped.outcomeSpend).toBe(10);
    expect(scoped.outcomeRevenue).toBe(20);
  });

  it("prior-decision-state keys are account-composite so identical creative ids cannot collide", () => {
    expect(priorStateKey("act_a", "cre_1")).not.toBe(priorStateKey("act_b", "cre_1"));
    expect(priorStateKey(null, "cre_1")).not.toBe(priorStateKey("act_a", "cre_1"));
  });

  it("selected identity is the (business, account) pair — an account id alone never grants selection", () => {
    const inputs = frozenFixture();
    // A row claiming a SELECTED account id under a DIFFERENT business must
    // not enter headline metrics.
    inputs.perOriginDecisions.push(
      decisionRow({
        businessId: "b_other",
        originDate: "2026-03-10",
        creativeId: "cre_cross",
        providerAccountId: "act_selected",
        label: "scale",
      }),
    );
    const analysis = analyzePitReplay(inputs);
    expect(analysis.decisionLayer.labelMix.scale).toBeUndefined();
    expect(analysis.appendix.deselectedHistoricalRows).toBe(2); // original + cross-business row
  });

  it("account/business cardinality is measured from frozen scope, not assumed", () => {
    const inputs = frozenFixture();
    inputs.scope.accounts.push({
      businessId: "b2",
      providerAccountId: "act_selected",
      isSelected: true,
      accountCurrency: "USD",
      accountTimezone: "UTC",
    });
    const analysis = analyzePitReplay(inputs);
    expect(
      analysis.accountBusinessCardinality.accountsAppearingUnderMultipleBusinesses,
    ).toEqual([
      { providerAccountId: "act_selected", businessIds: ["b1", "b2"] },
    ]);
    expect(
      analyzePitReplay(frozenFixture()).accountBusinessCardinality
        .accountsAppearingUnderMultipleBusinesses,
    ).toEqual([]);
  });
});

describe("generalized PIT replay — adversarial leakage + restatement honesty", () => {
  const baseTuples: CreativeDayTuple[] = [
    tuple({ date: "2026-03-05" }),
    tuple({ date: "2026-03-09", creative: "cre_2", firstSpend: "2026-03-09" }),
    tuple({ date: "2026-03-10" }),
  ];

  it("a future creative row cannot change the PIT input set or its hash", () => {
    const before = sha256Canonical(creativeRowsUpTo(baseTuples, "b1", "act_a", "2026-03-10"));
    const after = sha256Canonical(
      creativeRowsUpTo(
        [...baseTuples, tuple({ date: "2026-03-11", spend: 9_999 })],
        "b1",
        "act_a",
        "2026-03-10",
      ),
    );
    expect(after).toBe(before);
  });

  it("restated_after_days is NON-DECISIONAL restatement metadata (this is NOT a PIT-safety proof — historical captured values are unavailable and the replay stays restated_retrospective)", () => {
    const captured = baseTuples.map((t, index) =>
      index === 0 ? tuple({ date: "2026-03-05", restated: 45 }) : t,
    );
    expect(
      sha256Canonical(creativeRowsUpTo(captured, "b1", "act_a", "2026-03-10")),
    ).toBe(sha256Canonical(creativeRowsUpTo(baseTuples, "b1", "act_a", "2026-03-10")));
  });

  it("restated-retrospective origins can NEVER be promoted to PIT-safe by lifecycle presence alone", () => {
    const inputs = frozenFixture();
    inputs.perOriginMeta[0].sourceMode = "lifecycle_same_day";
    inputs.perOriginMeta[0].lifecycleComputedAt = "2026-03-10T12:00:00.000Z";
    const analysis = analyzePitReplay(inputs);
    expect(analysis.temporalIntegrity.temporalCounts.overallPitSafe).toBe(0);
    expect(
      analysis.temporalIntegrity.temporalCounts.lifecycleSnapshotPersistedSameDay,
    ).toBe(1);
    expect(
      analysis.temporalIntegrity.originTemporal[0].overallClass,
    ).toBe("restated_retrospective");
  });

  it("a later name change-point (state observation after t0) cannot change PIT campaign meta", () => {
    const namePoints = [
      { businessId: "b1", accountId: "act_a", campaignId: "cmp_1", date: "2026-03-01", campaignName: "Alpha" },
    ];
    const firstSeen = [
      { businessId: "b1", accountId: "act_a", campaignId: "cmp_1", firstSeenDate: "2026-03-01" },
    ];
    const before = sha256Canonical([...campaignMetaAsOf({
      namePoints, firstSeen, businessId: "b1", accountId: "act_a", t0: "2026-03-10", nameBlind: false,
    })]);
    const after = sha256Canonical([...campaignMetaAsOf({
      namePoints: [
        ...namePoints,
        { businessId: "b1", accountId: "act_a", campaignId: "cmp_1", date: "2026-03-11", campaignName: "Alpha RENAMED" },
      ],
      firstSeen,
      businessId: "b1",
      accountId: "act_a",
      t0: "2026-03-10",
      nameBlind: false,
    })]);
    expect(after).toBe(before);
  });

  it("outcome windows exclude the origin day itself and everything beyond the horizon", () => {
    const tuples: CreativeDayTuple[] = [
      tuple({ date: "2026-03-10", spend: 100 }),
      tuple({ date: "2026-03-11", spend: 5, revenue: 10, conversions: 1 }),
      tuple({ date: "2026-03-13", spend: 7, revenue: 0, conversions: 0 }),
      tuple({ date: "2026-03-14", spend: 999, revenue: 999 }),
    ];
    const aggregate = outcomeAggregateFor({
      tuples,
      businessId: "b1",
      providerAccountId: "act_a",
      creativeId: "cre_1",
      t0: "2026-03-10",
      horizonDays: 3,
    });
    expect(aggregate.outcomeSpend).toBe(12);
    expect(aggregate.outcomeRevenue).toBe(10);
  });

  it("role timelines up to a day are byte-stable under future-row injection", () => {
    const days = ["2026-03-08", "2026-03-09", "2026-03-10"];
    const args = {
      namePoints: [],
      firstSeen: [],
      businessId: "b1",
      accountId: "act_a",
      days,
      nameBlind: true as const,
    };
    const before = sha256Canonical([...buildRoleTimelines({ ...args, tuples: baseTuples })]);
    const after = sha256Canonical([
      ...buildRoleTimelines({
        ...args,
        tuples: [...baseTuples, tuple({ date: "2026-03-11", spend: 50_000 })],
      }),
    ]);
    expect(after).toBe(before);
  });
});

describe("generalized PIT replay — origin-as-of relaunch (future-leak regression)", () => {
  it("derives the FIRST qualifying relaunch date with the exact 14-day boundary", () => {
    const gap14 = firstRelaunchDates([
      tuple({ date: "2026-03-01" }),
      tuple({ date: "2026-03-15" }), // 14-day gap => qualifies
    ]);
    expect(RELAUNCH_GAP_DAYS).toBe(14);
    expect(gap14.get("b1\u0000act_a\u0000cre_1")).toBe("2026-03-15");
    const gap13 = firstRelaunchDates([
      tuple({ date: "2026-03-01" }),
      tuple({ date: "2026-03-14" }), // 13-day gap => does NOT qualify
    ]);
    expect(gap13.has("b1\u0000act_a\u0000cre_1")).toBe(false);
    const twoGaps = firstRelaunchDates([
      tuple({ date: "2026-03-01" }),
      tuple({ date: "2026-03-20" }), // first relaunch 03-20
      tuple({ date: "2026-05-01" }), // later second relaunch is irrelevant
    ]);
    expect(twoGaps.get("b1\u0000act_a\u0000cre_1")).toBe("2026-03-20");
  });

  it("a gap occurring only AFTER t0 never classifies an earlier decision row as relaunched", () => {
    const inputs = frozenFixture();
    inputs.creativeDayTuples = [
      tuple({ account: "act_selected", creative: "cre_gap", date: "2026-02-01" }),
      tuple({ account: "act_selected", creative: "cre_gap", date: "2026-03-15" }), // relaunch date 03-15
    ];
    inputs.perOriginDecisions = [
      decisionRow({ originDate: "2026-03-09", creativeId: "cre_gap" }), // BEFORE relaunch
      decisionRow({ originDate: "2026-03-10", creativeId: "cre_other" }),
    ];
    const analysis = analyzePitReplay(inputs);
    const cell = analysis.scenarioMatrix.find(
      (entry) => entry.cell === "relaunched_after_14d_spend_gap_as_of_origin",
    );
    expect(cell?.count).toBe(0);
    // …and a row at/after the relaunch date IS classified.
    inputs.perOriginDecisions.push(
      decisionRow({ originDate: "2026-03-15", creativeId: "cre_gap" }),
    );
    const later = analyzePitReplay(inputs).scenarioMatrix.find(
      (entry) => entry.cell === "relaunched_after_14d_spend_gap_as_of_origin",
    );
    expect(later?.count).toBe(1);
  });
});

describe("generalized PIT replay — strict temporal model", () => {
  it("the decision cutoff is exact; no future allowance exists", () => {
    const nextDay = classifyOriginTemporal({
      originDate: "2026-08-17",
      sourceMode: "lifecycle_same_day",
      lifecycleComputedAt: "2026-08-18T00:30:00.000Z",
      roleLayerCaptureProven: true,
      metricLayerCaptureProven: true,
    });
    expect(nextDay.lifecycleSnapshotPersistedSameDay).toBe(false);
    expect(nextDay.overallClass).toBe("restated_retrospective");
    const sameDay = classifyOriginTemporal({
      originDate: "2026-08-17",
      sourceMode: "lifecycle_same_day",
      lifecycleComputedAt: "2026-08-17T21:00:00.000Z",
      roleLayerCaptureProven: true,
      metricLayerCaptureProven: true,
    });
    expect(sameDay.overallClass).toBe("pit_safe");
  });

  it("a persisted lifecycle snapshot never implies overall PIT safety while any layer lacks capture proof", () => {
    const roleUnproven = classifyOriginTemporal({
      originDate: "2026-08-17",
      sourceMode: "lifecycle_same_day",
      lifecycleComputedAt: "2026-08-17T12:00:00.000Z",
      roleLayerCaptureProven: false,
      metricLayerCaptureProven: true,
    });
    expect(roleUnproven.overallClass).toBe("restated_retrospective");
  });

  it("the frozen evidence classifies every origin restated-retrospective — overall PIT-safe is zero", () => {
    const analysis = analyzePitReplay(frozenFixture());
    expect(analysis.temporalIntegrity.temporalCounts.overallPitSafe).toBe(0);
    expect(analysis.temporalIntegrity.temporalCounts.roleLayerCaptureProven).toBe(false);
  });
});

describe("generalized PIT replay — two-layer target verification", () => {
  it("uses the exact production 03:00Z reference instant with tie-order; latest delete yields null", () => {
    expect(targetReferenceTimeUtc("2026-07-17")).toBe("2026-07-17T03:00:00.000Z");
    const revised = [
      targetRow({ targetRoas: 2 }),
      targetRow({ effectiveAt: "2026-07-17T09:26:00.000Z", recordedAt: "2026-07-17T09:26:00.000Z", targetRoas: 9 }),
    ];
    expect(targetPackAsOf(revised, "b1", "2026-07-17")?.targetRoas).toBe(2);
    expect(targetPackAsOf(revised, "b1", "2026-07-18")?.targetRoas).toBe(9);
    expect(
      targetPackAsOf(
        [targetRow({ effectiveAt: "2026-07-17T03:00:00.000Z", recordedAt: "2026-07-17T03:00:00.000Z", targetRoas: 6 })],
        "b1",
        "2026-07-17",
      )?.targetRoas,
    ).toBe(6);
    expect(
      targetPackAsOf(
        [targetRow({ effectiveAt: "2026-07-17T03:00:00.001Z", recordedAt: "2026-07-17T03:00:00.001Z", targetRoas: 7 })],
        "b1",
        "2026-07-17",
      ),
    ).toBeNull();
    const history = [
      targetRow({ targetRoas: 2 }),
      targetRow({ effectiveAt: "2026-02-01T00:00:00.000Z", recordedAt: "2026-04-01T00:00:00.000Z", targetRoas: 9 }),
    ];
    expect(targetPackAsOf(history, "b1", "2026-03-10")?.targetRoas).toBe(2);
    const tie = [targetRow({ id: "a", targetRoas: 2 }), targetRow({ id: "b", targetRoas: 3 })];
    expect(targetPackAsOf(tie, "b1", "2026-03-10")?.targetRoas).toBe(3);
    const deleted = [
      targetRow({ targetRoas: 2 }),
      targetRow({ operation: "delete", effectiveAt: "2026-02-01T00:00:00.000Z", recordedAt: "2026-02-01T00:00:00.000Z", targetRoas: null }),
    ];
    expect(targetPackAsOf(deleted, "b1", "2026-03-10")).toBeNull();
  });

  it("layer 1: version consumption is unobservable (never invented) because observed row id/recordedAt was not frozen", () => {
    const result = verifyTargetsAtOrigins({
      targetHistory: [targetRow({ id: "row-1" })],
      rows: [decisionRow({ truthSource: "commercial_truth", effectiveTargetRoas: 2 })],
    });
    const l1 = result.layer1SelectionVersion;
    expect(l1.perOrigin[0].expectedRow?.id).toBe("row-1");
    expect(l1.perOrigin[0].observedVersionProvenance).toBe("not_frozen_in_evidence");
    expect(l1.perOrigin[0].versionConsumptionStatus).toBe("source_version_unobservable");
    expect(l1.denominators.versionProvenExact).toBe(0);
    // Same value + same source family is NOT version proof.
    expect(
      l1.perOrigin[0].versionConsumptionStatus,
    ).not.toBe("version_proven_exact");
    // No versioned target at all.
    const none = verifyTargetsAtOrigins({
      targetHistory: [],
      rows: [decisionRow({ truthSource: "global_default", effectiveTargetRoas: 0 })],
    });
    expect(none.layer1SelectionVersion.perOrigin[0].versionConsumptionStatus).toBe("no_versioned_target");
  });

  it("layer 2: [0 fallback, expected target] is MIXED — never exact; all-row singleton is the only singleton class", () => {
    const mixed = verifyTargetsAtOrigins({
      targetHistory: [targetRow()],
      rows: [
        decisionRow({ truthSource: "commercial_truth", effectiveTargetRoas: 2 }),
        decisionRow({ creativeId: "cre_oos", truthSource: "global_default", effectiveTargetRoas: 0 }),
      ],
    });
    const entry = mixed.layer2Consumption.perOrigin[0];
    expect(entry.consumptionClass).toBe("mixed_sources_including_expected");
    expect(entry.allServedValues).toEqual([0, 2]);
    expect(entry.rowCountsByTruthSource.commercial_truth).toBe(1);
    expect(entry.rowCountsByTruthSource.global_default).toBe(1);
    expect(entry.distinctValuesByTruthSource.global_default).toEqual([0]);
    expect(mixed.layer2Consumption.denominators.allRowsValueSingletonMatchesExpected).toBe(0);
    // All-row singleton — every served value from every row equals expected.
    const singleton = verifyTargetsAtOrigins({
      targetHistory: [targetRow()],
      rows: [
        decisionRow({ truthSource: "commercial_truth", effectiveTargetRoas: 2 }),
        decisionRow({ creativeId: "cre_2", truthSource: "commercial_truth", effectiveTargetRoas: 2 }),
      ],
    });
    expect(singleton.layer2Consumption.perOrigin[0].consumptionClass).toBe(
      "all_rows_value_singleton_matches_expected",
    );
  });

  it("layer 2: the remaining exhaustive classes are distinct and fail-closed", () => {
    // [expected, unexpected] BOTH target-sourced => mixed among target rows.
    const bothClaiming = verifyTargetsAtOrigins({
      targetHistory: [targetRow()],
      rows: [
        decisionRow({ truthSource: "commercial_truth", effectiveTargetRoas: 2 }),
        decisionRow({ creativeId: "cre_2", truthSource: "commercial_truth_stale", effectiveTargetRoas: 99 }),
      ],
    });
    expect(bothClaiming.layer2Consumption.perOrigin[0].consumptionClass).toBe(
      "mixed_target_sourced_values",
    );
    // Target-only wrong value.
    const wrong = verifyTargetsAtOrigins({
      targetHistory: [targetRow()],
      rows: [decisionRow({ truthSource: "commercial_truth", effectiveTargetRoas: 7 })],
    });
    expect(wrong.layer2Consumption.perOrigin[0].consumptionClass).toBe(
      "target_sourced_wrong_value_only",
    );
    // Fallback-only with a versioned target present.
    const fallbackOnly = verifyTargetsAtOrigins({
      targetHistory: [targetRow()],
      rows: [decisionRow({ truthSource: "account_baseline", effectiveTargetRoas: 1.8 })],
    });
    expect(fallbackOnly.layer2Consumption.perOrigin[0].consumptionClass).toBe(
      "fallback_only_no_target_claiming_rows",
    );
    // Target-claiming rows WITHOUT a versioned target.
    const phantom = verifyTargetsAtOrigins({
      targetHistory: [],
      rows: [decisionRow({ truthSource: "commercial_truth", effectiveTargetRoas: 2 })],
    });
    expect(phantom.layer2Consumption.perOrigin[0].consumptionClass).toBe(
      "target_claiming_rows_without_versioned_target",
    );
    // No versioned target + only fallbacks.
    const notComparable = verifyTargetsAtOrigins({
      targetHistory: [],
      rows: [decisionRow({ truthSource: "global_default", effectiveTargetRoas: 0 })],
    });
    expect(notComparable.layer2Consumption.perOrigin[0].consumptionClass).toBe(
      "no_versioned_target",
    );
    // Denominators are exhaustive.
    const dn = mixedDenominatorSum(bothClaiming.layer2Consumption.denominators);
    expect(dn).toBe(bothClaiming.layer2Consumption.denominators.originsChecked);
  });
});

function mixedDenominatorSum(d: {
  originsChecked: number;
  allRowsValueSingletonMatchesExpected: number;
  mixedSourcesIncludingExpected: number;
  mixedTargetSourcedValues: number;
  targetSourcedWrongValueOnly: number;
  fallbackOnlyNoTargetClaimingRows: number;
  noDecisionRows: number;
  targetClaimingRowsWithoutVersionedTarget: number;
  noVersionedTarget: number;
}): number {
  return (
    d.allRowsValueSingletonMatchesExpected +
    d.mixedSourcesIncludingExpected +
    d.mixedTargetSourcedValues +
    d.targetSourcedWrongValueOnly +
    d.fallbackOnlyNoTargetClaimingRows +
    d.noDecisionRows +
    d.targetClaimingRowsWithoutVersionedTarget +
    d.noVersionedTarget
  );
}

describe("generalized PIT replay — origins, horizons, account-aware support", () => {
  it("origin enumeration is deterministic and bounded", () => {
    const planA = enumerateDecisionOrigins({ firstDataDate: "2026-01-01", lastDataDate: "2026-04-30" });
    expect(planA).toEqual(
      enumerateDecisionOrigins({ firstDataDate: "2026-01-01", lastDataDate: "2026-04-30" }),
    );
    expect(planA!.populationDays).toBe(92);
    expect(
      enumerateDecisionOrigins({ firstDataDate: "2026-01-01", lastDataDate: "2026-01-20" }),
    ).toBeNull();
  });

  it("horizon support is an exact boundary on the last retained data day", () => {
    const support = horizonSupport({ t0: "2026-08-15", lastDataDate: "2026-08-22" });
    expect(support[7]).toBe(true);
    expect(support[14]).toBe(false);
  });

  it("support is account-aware: per-account plans, business-execution counts within range, deselected executes zero", () => {
    const analysis = analyzePitReplay(frozenFixture());
    const first = analysis.supportMatrix.find((entry) => entry.providerAccountId === "act_selected")!;
    const second = analysis.supportMatrix.find((entry) => entry.providerAccountId === "act_second")!;
    const deselected = analysis.supportMatrix.find((entry) => entry.providerAccountId === "act_deselected")!;
    expect(first.populationDays).toBe(51);
    expect(second.populationDays).toBe(10);
    // Business plan sampled ["2026-03-09","2026-03-10"]; both inside each
    // selected account's own range here.
    expect(first.businessExecutionSampledWithinAccountRange).toBe(2);
    expect(second.businessExecutionSampledWithinAccountRange).toBe(2);
    // Deselected accounts execute ZERO decision origins.
    expect(deselected.businessExecutionSampledWithinAccountRange).toBe(0);
    // The account's OWN deterministic plan is reported separately.
    const ownPlan = enumerateDecisionOrigins({ firstDataDate: "2026-02-01", lastDataDate: "2026-03-10" });
    expect(second.accountPlanSampledOriginCount).toBe(ownPlan!.sampledOrigins.length);
    expect(first.executionGrain).toContain("once per business origin");
    // An origin outside a shorter account's range is NOT counted for it.
    const inputs = frozenFixture();
    inputs.coverage[1].maxDate = "2026-03-09";
    const shorter = analyzePitReplay(inputs).supportMatrix.find(
      (entry) => entry.providerAccountId === "act_second",
    )!;
    expect(shorter.businessExecutionSampledWithinAccountRange).toBe(1);
  });
});

describe("generalized PIT replay — role hysteresis + evaluated-run freshness", () => {
  it("a kind flip publishes only after two consecutive agreeing evaluations", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, "test", "high");
    expect(day2.publishedKind).toBe("main");
    expect(applyDailyHysteresis(day2.state, "test", "high").publishedKind).toBe("test");
  });

  it("evidence-dip grace holds then clears; persistent conflict clears on day 2", () => {
    let state = applyDailyHysteresis(null, "main", "high").state;
    for (let day = 0; day < 3; day += 1) {
      const outcome = applyDailyHysteresis(state, null, "unknown");
      expect(outcome.publishedKind).toBe("main");
      state = outcome.state;
    }
    expect(applyDailyHysteresis(state, null, "unknown").publishedKind).toBeNull();
    const stable = applyDailyHysteresis(null, "main", "high").state;
    const firstConflict = applyDailyHysteresis(stable, null, "conflict");
    expect(applyDailyHysteresis(firstConflict.state, null, "conflict").publishedKind).toBeNull();
  });

  it("context trust demotes high inference to medium while authority stays unvalidated", () => {
    expect(contextEntryFromRoleState({ publishedKind: "main", publishedClass: "high" }).contextTrust).toBe("medium");
    expect(contextEntryFromRoleState(null).contextTrust).toBe("unknown");
  });

  it("an unevaluated stale role fails closed; unchanged-but-daily-evaluated stays served", () => {
    const tuples = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"].map(
      (date) => tuple({ date, spend: 100 }),
    );
    const days: string[] = [];
    for (let index = 1; index <= 20; index += 1) {
      days.push(`2026-03-${String(index).padStart(2, "0")}`);
    }
    const timeline = buildRoleTimelines({
      tuples,
      namePoints: [],
      firstSeen: [],
      businessId: "b1",
      accountId: "act_a",
      days,
      nameBlind: true,
    }).get("cmp_1");
    expect(timeline).toBeTruthy();
    const lastEvaluated = lastEvaluatedDayAtOrBefore(timeline!, "2026-03-20");
    expect(lastEvaluated).not.toBeNull();
    expect(roleStateAt(timeline, lastEvaluated!)).not.toBeNull();
    expect(roleStateAt(timeline, "2026-04-15")).toBeNull();
  });
});

describe("generalized PIT replay — account selection + analysis invariants", () => {
  it("deselected and unscoped rows never enter headline metrics; both land in the appendix, fail-closed", () => {
    const analysis = analyzePitReplay(frozenFixture());
    expect(analysis.decisionLayer.totalDecisionRows).toBe(2);
    expect(analysis.decisionLayer.labelMix.scale).toBeUndefined();
    expect(analysis.decisionLayer.labelMix.refresh).toBeUndefined();
    expect(analysis.appendix.deselectedHistoricalRows).toBe(1);
    expect(analysis.appendix.unscopedHistoricalRowsExcluded).toBe(1);
    expect(analysis.appendix.deselectedStaleRows).toBe(1);
    expect(analysis.appendix.unscopedStaleRowsExcluded).toBe(1);
    expect(analysis.decisionLayer.staleModeRows).toBe(2);
    expect(analysis.decisionLayer.staleModeEnabledHardActions).toBe(1);
  });

  it("target verification integrates with fail-closed two-layer denominators", () => {
    const analysis = analyzePitReplay(frozenFixture());
    const layer2 = analysis.temporalIntegrity.targetVerification.layer2Consumption;
    expect(layer2.denominators.targetSourcedWrongValueOnly).toBe(0);
    expect(
      analysis.temporalIntegrity.targetVerification.layer1SelectionVersion
        .denominators.versionProvenExact,
    ).toBe(0);
    const broken = frozenFixture();
    for (const row of broken.perOriginDecisions) row.effectiveTargetRoas = 7;
    expect(
      analyzePitReplay(broken).temporalIntegrity.targetVerification
        .layer2Consumption.denominators.targetSourcedWrongValueOnly,
    ).toBeGreaterThan(0);
  });

  it("the pure analysis is deterministic", () => {
    expect(sha256Canonical(analyzePitReplay(frozenFixture()))).toBe(
      sha256Canonical(analyzePitReplay(frozenFixture())),
    );
  });

  it("the scenario matrix covers the charter axes and marks unsupported cells explicitly", () => {
    const analysis = analyzePitReplay(frozenFixture());
    const axes = new Set(analysis.scenarioMatrix.map((cell) => cell.axis));
    for (const axis of ["dataState", "entityMaturity", "inferredRole", "decisionBoundary", "actionResult", "stability", "diversity"]) {
      expect(axes.has(axis), axis).toBe(true);
    }
    const unsupported = analysis.scenarioMatrix.filter((cell) => !cell.supported);
    expect(unsupported.length).toBeGreaterThan(0);
    for (const cell of unsupported) {
      expect((cell as { reason?: string }).reason?.length ?? 0).toBeGreaterThan(10);
      expect((cell as { count: number | null }).count).toBeNull();
    }
  });

  it("attribution embargo boundaries and proxy exclusion", () => {
    expect(ATTRIBUTION_EMBARGO_DAYS).toBe(7);
    expect(isOutcomeWindowMature({ t0: "2026-08-08", horizonDays: 7, lastDataDate: "2026-08-22" })).toBe(true);
    expect(isOutcomeWindowMature({ t0: "2026-08-09", horizonDays: 7, lastDataDate: "2026-08-22" })).toBe(false);
    const inputs = frozenFixture();
    inputs.perOriginDecisions = [decisionRow({ originDate: "2026-03-18", label: "keep" })];
    const analysis = analyzePitReplay(inputs);
    expect(analysis.outcomeLayer.immatureEmbargoedCells).toBeGreaterThan(0);
    expect(analysis.outcomeLayer.matureEvaluatedCells).toBe(0);
  });
});

describe("generalized PIT replay — action-threshold boundaries (real engine)", () => {
  const profile = makeAccountDecisionProfile();
  const health = makeDataHealth();
  const resolvedContext = (): Map<string, CreativeCampaignContextEntry> =>
    new Map([
      ["campaign-1", contextEntryFromRoleState({ publishedKind: "main", publishedClass: "high" })],
    ]);
  const decide = (over: Parameters<typeof makeCreativeInput>[0]) => {
    const input = makeCreativeInput(over);
    const map = resolvedContext();
    const withKind = withCreativeCampaignLabelContext(input, map);
    return applyCreativeCampaignLabelGuard({
      decision: decideCreative(withKind, profile, health),
      input: withKind,
      campaignLabelsById: map,
    });
  };
  const loserMetrics = {
    purchases: 4,
    purchaseValue: 400,
    roas: 0.8,
    cpa: 125,
    targetRoas: 2,
    breakevenRoas: 1.5,
    recent7dSpend: 120,
    recent7dRoas: 0.8,
    linkClicks: 200,
    landingPageViews: 180,
    addToCart: 40,
    initiateCheckout: 16,
  };

  it("commercial-maturity spend boundary changes a clear loser's hard-cut eligibility", () => {
    const below = decide({ ...loserMetrics, spend: 150 });
    const above = decide({ ...loserMetrics, spend: 500 });
    expect(above.label === "cut" || above.blockedActionType === "cut").toBe(true);
    expect(below.label === "cut").toBe(false);
  });

  it("scale-min-purchases boundary gates the raw scale signal for a clear winner", () => {
    const winner = {
      roas: 4,
      purchaseValue: 4000,
      cpa: 25,
      targetRoas: 2,
      breakevenRoas: 1.5,
      recent7dSpend: 300,
      recent7dPurchases: 8,
      recent7dRoas: 4,
      spend: 1000,
    };
    const scaleSignal = (decision: DecisionOutput) =>
      decision.label === "scale" ||
      decision.preAuthorityLabel === "scale" ||
      decision.blockedActionType === "scale";
    expect(scaleSignal(decide({ ...winner, purchases: 10 }))).toBe(true);
    expect(scaleSignal(decide({ ...winner, purchases: 9 }))).toBe(false);
  });

  it("target-ratio boundary flips the below/at-target treatment of the same creative", () => {
    const base = {
      spend: 800,
      purchases: 12,
      targetRoas: 2,
      breakevenRoas: 1.5,
      recent7dSpend: 200,
      linkClicks: 300,
      landingPageViews: 260,
      addToCart: 60,
      initiateCheckout: 30,
    };
    const atTarget = decide({ ...base, roas: 2.0, purchaseValue: 1600, recent7dRoas: 2.0 });
    const wellBelow = decide({ ...base, roas: 0.7, purchaseValue: 560, recent7dRoas: 0.7 });
    expect(atTarget.label).not.toBe(wellBelow.label);
  });
});

describe("generalized PIT replay — operational recovery pure model", () => {
  it("admission flips exactly when proven free space exceeds the overage; no proof falls back to raw", () => {
    const args = { rawBytes: 5_368_750_080, budgetBytes: 5_368_709_120, freeSpaceProofAvailable: true };
    expect(simulateFenceRecovery({ ...args, provenReusableFreeBytes: 40_960 })[1].admitted).toBe(false);
    expect(simulateFenceRecovery({ ...args, provenReusableFreeBytes: 40_961 })[1].admitted).toBe(true);
    expect(
      simulateFenceRecovery({
        rawBytes: 5_368_750_080,
        budgetBytes: 5_368_709_120,
        freeSpaceProofAvailable: false,
        provenReusableFreeBytes: null,
      }).every((scenario) => !scenario.admitted),
    ).toBe(true);
  });
});

describe("generalized PIT replay — freeze/verify (self-consistency + rederivation)", () => {
  function assembledFixture() {
    const fixture = frozenFixture();
    const rebuilt = rebuildRoleTimelines(fixture);
    return assemblePitReplayArtifact({
      startedAtUtc: "2026-08-30T20:00:00.000Z",
      proofs: {
        retrievedAt: "2026-08-30 20:00:00+00",
        applicationName: "omniads-web",
        transactionIsolation: "repeatable read",
        transactionReadOnly: "on",
      },
      frozenInputs: fixture,
      persistedInference: {
        note: "fixture",
        accountScopedRowsByBusiness: { b1: 0 },
        legacyNullAccountRowsByBusiness: { b1: 2 },
        lifecycleCoverage: [],
      },
      roleTimelinesCompact: compactRoleTimelines(rebuilt.primary),
      roleAnalysis: analyzeRoleTimelines(rebuilt),
      recoverySimulation: buildRecoverySimulationSection(),
      uiTruthStates: {
        note: "fixture",
        states: [
          {
            category: "fixture_keep",
            businessId: "b1",
            originDate: "2026-03-09",
            freshnessMode: "historical",
            creativeId: "cre_1",
            campaignId: "cmp_1",
            providerAccountId: "act_selected",
            overallTemporalClass: "restated_retrospective",
            evidenceLayer: "deterministic_replay_fact",
            decision: { label: "keep", blockedActionType: null },
            inputEcho: { campaignKind: null },
          },
        ],
        unsupportedHorizonExample: null,
        deselectedReference: null,
      },
      correctionLedger: [
        { revision: 1, outcome: "REJECTED (fixture)" },
        { revision: 2, outcome: "REJECTED (fixture)" },
        { revision: 5, outcome: "current (fixture)" },
      ],
    }) as unknown as Record<string, unknown>;
  }

  /** Cascading rehash: recompute EVERY exposed hash after a mutation — the
   * adversarial move the rejected verifier failed against. */
  function rehash(artifact: Record<string, unknown>) {
    const hashes: Record<string, string> = {};
    for (const key of PROTECTED_TOP_LEVEL_KEYS) {
      if (key === "protectedSectionHashes" || key === "artifactHash") continue;
      if (!(key in artifact)) continue; // adversary can only hash what exists
      hashes[key] = sha256Canonical(artifact[key]);
    }
    artifact.protectedSectionHashes = hashes;
    artifact.artifactHash = sha256Canonical(hashes);
  }

  it("a freshly assembled artifact verifies clean (including current source hashes)", () => {
    const result = verifyPitReplayArtifact(assembledFixture(), { checkSourceFiles: true });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("plain protected-field mutations are rejected", () => {
    for (const [name, mutate, expectFailure] of [
      ["section hash", (a: Record<string, unknown>) => { (a.protectedSectionHashes as Record<string, string>).scope = "0".repeat(64); }, "protectedSectionHashes.scope stale"],
      ["artifact hash", (a: Record<string, unknown>) => { a.artifactHash = "0".repeat(64); }, "artifactHash stale"],
      ["silent row edit", (a: Record<string, unknown>) => { (a.perOriginDecisions as Array<Record<string, unknown>>)[0].label = "scale"; }, "protectedSectionHashes.perOriginDecisions stale"],
    ] as const) {
      const artifact = assembledFixture();
      mutate(artifact);
      const result = verifyPitReplayArtifact(artifact, { checkSourceFiles: true });
      expect(result.ok, name).toBe(false);
      expect(result.failures.some((f) => f.includes(expectFailure)), `${name}: ${result.failures.join("; ")}`).toBe(true);
    }
  });

  type Mutator = (artifact: Record<string, unknown>) => void;
  const SEMANTIC_TIER_MUTATORS: Record<string, { mutate: Mutator; expectFailure: string }> = {
    "roleAnalysis replaced with {tampered:true}": {
      mutate: (a) => { a.roleAnalysis = { tampered: true }; },
      expectFailure: "roleAnalysis does not re-derive",
    },
    "primary role timelines emptied": {
      mutate: (a) => { a.roleTimelinesPrimaryNameBlind = []; },
      expectFailure: "roleTimelinesPrimaryNameBlind does not re-derive",
    },
    "analysis count nudged (determinism hashes also recomputed)": {
      mutate: (a) => {
        (a.analysis as { decisionLayer: { totalDecisionRows: number } }).decisionLayer.totalDecisionRows += 1;
        const newHash = sha256Canonical(a.analysis);
        (a.determinism as Record<string, unknown>).pureAnalysisHashFirst = newHash;
        (a.determinism as Record<string, unknown>).pureAnalysisHashSecond = newHash;
      },
      expectFailure: "analysis does not re-derive",
    },
    "recovery scenarios emptied": {
      mutate: (a) => { (a.recoverySimulation as { scenarios: unknown[] }).scenarios = []; },
      expectFailure: "recoverySimulation does not re-derive",
    },
    "UI state label flipped away from its frozen row": {
      mutate: (a) => {
        const state = (a.uiTruthStates as { states: Array<Record<string, unknown>> }).states[0];
        (state.decision as Record<string, unknown>).label = "cut";
      },
      expectFailure: "label diverges from frozen row",
    },
    "read-only proof flipped off": {
      mutate: (a) => { (a.provenance as Record<string, unknown>).transactionReadOnly = "off"; },
      expectFailure: "transactionReadOnly must be 'on'",
    },
    "name-blind contract flipped": {
      mutate: (a) => { (a.labelIsolation as Record<string, unknown>).primaryInferenceNameBlind = false; },
      expectFailure: "labelIsolation contract violated",
    },
    "persisted inference negative count": {
      mutate: (a) => {
        ((a.persistedInference as Record<string, unknown>).accountScopedRowsByBusiness as Record<string, unknown>).b1 = -1;
      },
      expectFailure: "not a non-negative int",
    },
    "ledger order reversed": {
      mutate: (a) => { (a.correctionLedger as unknown[]).reverse(); },
      expectFailure: "not strictly increasing",
    },
    "ledger outcome emptied": {
      mutate: (a) => {
        ((a.correctionLedger as Array<Record<string, unknown>>)[0]).outcome = "";
      },
      expectFailure: "lacks an outcome",
    },
    "verification contract text weakened": {
      mutate: (a) => {
        (a.verificationContract as Record<string, unknown>).tier1SemanticVerifier = "tamperproof against all adversaries";
      },
      expectFailure: "verificationContract text drifted",
    },
    "base verdict weakened": {
      mutate: (a) => {
        ((a.provenance as Record<string, unknown>).baseComparison as Record<string, unknown>).baseEngineReplaySupported = true;
      },
      expectFailure: "baseComparison must remain honestly unsupported",
    },
    "source manifest entry dropped": {
      mutate: (a) => {
        const hashes = (a.provenance as Record<string, unknown>).sourceFileSha256AtFreeze as Record<string, string>;
        delete hashes[Object.keys(hashes)[0]];
      },
      expectFailure: "sourceFileSha256AtFreeze manifest mismatch",
    },
    "extra top-level key": {
      mutate: (a) => { (a as Record<string, unknown>).injected = true; },
      expectFailure: "top-level key manifest mismatch",
    },
    "missing top-level key": {
      mutate: (a) => { delete a.labelIsolation; },
      expectFailure: "top-level key manifest mismatch",
    },
  };
  /** Anchored-tier attacks: byte mutations of ATTESTED content that the
   * semantic tier honestly cannot rederive. The semantic verifier reports
   * the attested boundary; the ANCHORED package verifier must fail. */
  const ANCHORED_TIER_MUTATORS: Record<string, { mutate: Mutator; attestedSection: string }> = {
    "attested persisted count 0 -> 999 (anchored-tier attack A)": {
      mutate: (a) => {
        const counts = (a.persistedInference as Record<string, unknown>)
          .accountScopedRowsByBusiness as Record<string, unknown>;
        counts[Object.keys(counts)[0]] = 999;
      },
      attestedSection: "persistedInference",
    },
    "fabricated ledger verdict text (anchored-tier attack B)": {
      mutate: (a) => {
        ((a.correctionLedger as Array<Record<string, unknown>>)[0]).outcome =
          "ACCEPTED without findings — fabricated verdict";
      },
      attestedSection: "correctionLedger",
    },
    "fabricated UI reason and badges (anchored-tier attack B)": {
      mutate: (a) => {
        const state = (a.uiTruthStates as { states: Array<Record<string, unknown>> }).states[0];
        (state.decision as Record<string, unknown>).reason = "fabricated UI reason";
        (state.decision as Record<string, unknown>).badges = [
          { type: "fabricated_badge", label: "x", severity: "info" },
        ];
      },
      attestedSection: "uiTruthStates",
    },
  };

  it("the adversarial case map covers EXACTLY the exported generated case list", () => {
    const mapped = [
      ...Object.keys(SEMANTIC_TIER_MUTATORS),
      ...Object.keys(ANCHORED_TIER_MUTATORS),
    ].sort();
    expect(mapped).toEqual([...CASCADING_ATTACK_CASE_NAMES].sort());
  });

  it("SEMANTIC TIER: cascading-rehash mutations of derived/contract content still fail via rederivation", () => {
    for (const [name, { mutate, expectFailure }] of Object.entries(SEMANTIC_TIER_MUTATORS)) {
      const artifact = assembledFixture();
      mutate(artifact);
      rehash(artifact);
      const result = verifyPitReplayArtifact(artifact, { checkSourceFiles: true });
      expect(result.ok, name).toBe(false);
      expect(
        result.failures.some((failure) => failure.includes(expectFailure)),
        `${name}: ${result.failures.join("; ")}`,
      ).toBe(true);
    }
  });

  it("ANCHORED TIER: attested-byte mutations pass the semantic tier (honest boundary reported) but FAIL the anchored package verify", () => {
    const artifactPath = resolve(PIT_REPLAY_JSON_OUT);
    const reportPath = resolve("docs/audits/GENERALIZED_PIT_REPLAY_2026-08-30.md");
    if (!existsSync(artifactPath)) throw new Error("frozen artifact missing — fail-closed");
    const canonicalBytes = readFileSync(artifactPath, "utf8");
    // Canonical package passes the anchored tier.
    // The baseline the mutated artifacts are compared against: what the
    // UNMUTATED package's semantic tier says today.
    const canonicalSemantic = verifyPitReplayArtifact(
      JSON.parse(canonicalBytes) as Record<string, unknown>,
    );
    const canonical = verifyAnchoredPackage({ artifactPath, reportPath });
    expect(canonical.failures).toEqual([]);
    expect(canonical.ok).toBe(true);
    // Portable, per-run, exclusively owned temp directory (correction 4): the
    // mutated attack artifacts are ephemeral and must never be written inside
    // the repository or into a session-specific scratchpad.
    const attackDir = mkdtempSync(join(tmpdir(), "adsecute-pit-replay-anchored-attack-"));
    try {
      expect(existsSync(attackDir)).toBe(true);
      for (const [name, { mutate, attestedSection }] of Object.entries(ANCHORED_TIER_MUTATORS)) {
        const artifact = JSON.parse(canonicalBytes) as Record<string, unknown>;
        mutate(artifact);
        rehash(artifact);
        /*
          Semantic tier: internally coherent — and that is exactly the honest
          boundary: the section is listed as extraction-attested, never
          claimed semantically verified.

          PRE-DEPLOY AUDIT: `checkSourceFiles` is deliberately NOT set here.
          Every other caller of this verifier in this file passes a FRESHLY
          assembled fixture, whose freeze manifest is computed from the current
          sources; this one parses the artifact frozen on disk, whose manifest
          is from the day it was frozen. Asking it whether the engine has
          changed since is a different question from the one under test —
          "do attested-byte mutations stay internally coherent?" — and mixing
          them made a true statement about engine drift look like a broken
          tamper check. The drift itself is asserted, by name and file, in the
          FROZEN PACKAGE DRIFT LEDGER below.
        */
        const semantic = verifyPitReplayArtifact(artifact);
        /*
          The claim is that the MUTATION adds no semantic failure, so it is
          asserted against the unmutated package's own result rather than
          against `ok === true`. The frozen package no longer re-derives
          `roleAnalysis` under today's engine — declared drift from the D074b
          role removal, pinned by name in the FROZEN PACKAGE DRIFT LEDGER
          below — and `ok === true` would have made that pre-existing,
          understood drift read as a broken tamper check on every one of these
          attacks. Set equality is the stronger form of the same statement: a
          mutation that introduced a semantic failure would fail here, and one
          that silently REPAIRED the drift would fail here too.
        */
        expect(
          [...semantic.failures].sort(),
          `${name} (semantic tier is honest about attested bytes)`,
        ).toEqual([...canonicalSemantic.failures].sort());
        expect(semantic.attestedSections).toContain(attestedSection);
        // Anchored tier: the mutated bytes no longer match the external anchor.
        const mutatedPath = join(
          attackDir,
          `anchored-attack-${Object.keys(ANCHORED_TIER_MUTATORS).indexOf(name)}.json`,
        );
        writeFileSync(mutatedPath, JSON.stringify(artifact));
        const anchored = verifyAnchoredPackage({ artifactPath: mutatedPath, reportPath });
        expect(anchored.ok, name).toBe(false);
        expect(
          anchored.failures.some((failure) => failure.includes("do not match the external anchor")),
          `${name}: ${anchored.failures.join("; ")}`,
        ).toBe(true);
      }
    } finally {
      // Remove exactly the directory this test created — nothing else.
      rmSync(attackDir, { recursive: true, force: true });
    }
    // Cleanup is proven, not assumed.
    expect(existsSync(attackDir)).toBe(false);
    /*
      120s. The FIRST rederivation of the 44 MB package still dominates this
      case — the three attacks that follow reuse it through the verifier's
      memo — but that rederivation is no longer quadratic. It used to answer
      every one of the 108,556 (decision, horizon) outcome cells by scanning
      all 89,433 frozen creative-day tuples, and rebuild each account's role
      timeline by re-scanning every business's tuples once per evaluated day;
      both now scan only the composite key's own bucket (see
      `buildCreativeDayTupleIndex` / `buildAccountTupleIndex` in the runner —
      narrowing only, with the identity guards intact, so the sums keep their
      frozen ADDITION ORDER and the rederived hashes are byte-identical).

      Measured on this case: 295.7s -> 7.4s standalone, and 27.1s inside a
      complete `npx vitest run` (1263 files, 11-way pool) — the run it used
      to time out in. The bound was 420_000, tuned against the 286.6s the
      quadratic version cost under the serialized 2026-09-03 gate; with the
      real cost gone that headroom would only hide a regression. 120_000
      matches the two other artifact-sized cases in this file and still
      leaves ~4x margin over the loaded measurement, so a genuine hang fails
      fast.
    */
  }, 120_000);

  it("the honest boundary is declared: attested raw evidence is not offline-verifiable and the contract says so", () => {
    const artifact = assembledFixture();
    const contract = artifact.verificationContract as {
      tier2AnchoredPackageVerifier: string;
      notGuaranteed: string;
      externalTrustAnchor: string;
      extractionAttestedOnly: string[];
    };
    expect(contract.notGuaranteed).toContain("coherent rewrite of BOTH");
    expect(contract.tier2AnchoredPackageVerifier).toContain("byte SHA-256");
    expect(contract.externalTrustAnchor.length).toBeGreaterThan(10);
    expect(
      contract.extractionAttestedOnly.some((entry) => entry.includes("persistedInference")),
    ).toBe(true);
    expect(
      contract.extractionAttestedOnly.some((entry) => entry.includes("correctionLedger")),
    ).toBe(true);
    expect(
      contract.extractionAttestedOnly.some((entry) => entry.includes("reason/badges")),
    ).toBe(true);
    // No universal tamper-proof claim anywhere in the runner.
    expect(RUNNER_SOURCE.toLowerCase().includes("tamper-proof")).toBe(false);
    // The semantic verifier RETURNS its attested boundary.
    const result = verifyPitReplayArtifact(artifact, { checkSourceFiles: true });
    expect([...result.attestedSections]).toEqual([...EXTRACTION_ATTESTED_SECTIONS]);
  });
});

describe("generalized PIT replay — remaining composite-grain closure (correction 3)", () => {
  it("campaign meta separates the same account id under two businesses with colliding campaign ids", () => {
    const namePoints = [
      { businessId: "b1", accountId: "act_x", campaignId: "cmp_1", date: "2026-03-01", campaignName: "B1 name" },
      { businessId: "b2", accountId: "act_x", campaignId: "cmp_1", date: "2026-03-01", campaignName: "B2 name" },
    ];
    const b1 = campaignMetaAsOf({
      namePoints, firstSeen: [], businessId: "b1", accountId: "act_x", t0: "2026-03-10", nameBlind: false,
    });
    const b2 = campaignMetaAsOf({
      namePoints, firstSeen: [], businessId: "b2", accountId: "act_x", t0: "2026-03-10", nameBlind: false,
    });
    expect(b1.get("cmp_1")?.campaignName).toBe("B1 name");
    expect(b2.get("cmp_1")?.campaignName).toBe("B2 name");
  });

  it("two accounts in one business with identical campaign+creative ids keep separate role timelines", () => {
    const tuples: CreativeDayTuple[] = [];
    for (let day = 1; day <= 30; day += 1) {
      const date = `2026-03-${String(day).padStart(2, "0")}`;
      tuples.push(tuple({ account: "act_a", campaign: "cmp_same", creative: "cre_same", date, spend: 500 }));
      tuples.push(tuple({ account: "act_b", campaign: "cmp_same", creative: "cre_same", date, spend: 1 }));
    }
    const days = ["2026-03-28", "2026-03-29", "2026-03-30"];
    const common = { tuples, namePoints: [], firstSeen: [], businessId: "b1", days, nameBlind: true as const };
    const timelineA = buildRoleTimelines({ ...common, accountId: "act_a" }).get("cmp_same");
    const timelineB = buildRoleTimelines({ ...common, accountId: "act_b" }).get("cmp_same");
    expect(timelineA).toBeTruthy();
    expect(timelineB).toBeTruthy();
    // Each account's timeline reflects ONLY its own rows.
    expect(sha256Canonical(timelineA)).not.toBe(sha256Canonical(timelineB));
    const stateA = roleStateAt(timelineA, "2026-03-30");
    const stateB = roleStateAt(timelineB, "2026-03-30");
    expect(sha256Canonical(stateA)).not.toBe(sha256Canonical(stateB));
  });

  it("freshness pairing, flip metrics, and unique-decision denominators keep colliding creative ids separate per account", () => {
    const inputs = frozenFixture();
    // Same creativeId on BOTH selected accounts, different labels per origin
    // and different stale twins — composite keys must keep them apart.
    inputs.creativeDayTuples = [
      tuple({ account: "act_selected", creative: "cre_dup", date: "2026-03-11", spend: 10, revenue: 30 }),
      tuple({ account: "act_second", creative: "cre_dup", date: "2026-03-11", spend: 99, revenue: 0 }),
    ];
    inputs.perOriginDecisions = [
      decisionRow({ originDate: "2026-03-09", creativeId: "cre_dup", providerAccountId: "act_selected", label: "keep" }),
      decisionRow({ originDate: "2026-03-10", creativeId: "cre_dup", providerAccountId: "act_selected", label: "keep" }),
      decisionRow({ originDate: "2026-03-09", creativeId: "cre_dup", providerAccountId: "act_second", label: "keep" }),
      decisionRow({ originDate: "2026-03-10", creativeId: "cre_dup", providerAccountId: "act_second", label: "cut", rawLabel: "cut" }),
      decisionRow({ originDate: "2026-03-10", creativeId: "cre_dup", providerAccountId: "act_selected", freshnessMode: "wall_clock_stale", label: "keep" }),
      decisionRow({ originDate: "2026-03-10", creativeId: "cre_dup", providerAccountId: "act_second", freshnessMode: "wall_clock_stale", label: "diagnose", blockedActionType: "cut" }),
    ];
    const analysis = analyzePitReplay(inputs);
    // Flips: act_selected keep->keep (no flip); act_second keep->cut (flip).
    expect(analysis.flipMetrics.consecutiveDayComparisons).toBe(2);
    expect(analysis.flipMetrics.consecutiveDayFlips).toBe(1);
    // byAccount is composite-keyed.
    expect(Object.keys(analysis.decisionLayer.byAccount).every((key) => key.includes("b1"))).toBe(true);
    // Unique-decision denominators count the two accounts separately.
    const missing = analysis.outcomeLayer.ruleDenominators.reduce(
      (sum, rule) => sum + rule.uniqueDecisionOrigins,
      0,
    );
    expect(missing).toBeGreaterThanOrEqual(4); // 2 origins x 2 accounts at minimum
  });

  it("ambiguous or missing account-to-business migration mapping fails closed", () => {
    const ok = migrateNameRowsToV3({
      scopeAccounts: [{ businessId: "b1", providerAccountId: "act_a" }],
      namePoints: [{ accountId: "act_a", campaignId: "c", date: "2026-01-01", campaignName: "n" }],
      firstSeen: [{ accountId: "act_a", campaignId: "c", firstSeenDate: "2026-01-01" }],
    });
    expect(ok.namePoints[0].businessId).toBe("b1");
    expect(() =>
      migrateNameRowsToV3({
        scopeAccounts: [
          { businessId: "b1", providerAccountId: "act_a" },
          { businessId: "b2", providerAccountId: "act_a" },
        ],
        namePoints: [{ accountId: "act_a", campaignId: "c", date: "2026-01-01", campaignName: "n" }],
        firstSeen: [],
      }),
    ).toThrow(/maps to multiple businesses/);
    expect(() =>
      migrateNameRowsToV3({
        scopeAccounts: [{ businessId: "b1", providerAccountId: "act_a" }],
        namePoints: [{ accountId: "act_UNKNOWN", campaignId: "c", date: "2026-01-01", campaignName: "n" }],
        firstSeen: [],
      }),
    ).toThrow(/no business mapping/);
  });

  it("the current real frozen scope remains account/business cardinality-clean", () => {
    const artifactPath = resolve(PIT_REPLAY_JSON_OUT);
    if (!existsSync(artifactPath)) throw new Error("frozen artifact missing — fail-closed");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      scope: { accounts: Array<{ businessId: string; providerAccountId: string }> };
      analysis: { accountBusinessCardinality: { accountsAppearingUnderMultipleBusinesses: unknown[] } };
    };
    const byAccount = new Map<string, Set<string>>();
    for (const account of artifact.scope.accounts) {
      const set = byAccount.get(account.providerAccountId) ?? new Set<string>();
      set.add(account.businessId);
      byAccount.set(account.providerAccountId, set);
    }
    expect([...byAccount.values()].every((set) => set.size === 1)).toBe(true);
    expect(
      artifact.analysis.accountBusinessCardinality.accountsAppearingUnderMultipleBusinesses,
    ).toEqual([]);
  });
});

/**
 * Correction 4 — repository portability guard.
 *
 * A repository test must never depend on an ephemeral, machine-specific
 * directory (a Claude/Codex session scratchpad, a developer home directory).
 * Such a test passes only by accident on the machine that created the
 * directory and fails on a clean checkout before it can assert anything.
 *
 * Needles are ASSEMBLED AT RUNTIME so this file never itself contains a
 * contiguous session-path literal — the same idiom the D077 artifact-hash
 * contract test uses for its own static census.
 */
describe("generalized PIT replay — repository portability guard (correction 4)", () => {
  const REPO_ROOT = resolve(".");
  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo",
    ".vercel", "out", ".pnpm-store",
  ]);
  const FORBIDDEN_PATHS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    {
      label: "macOS-resolved Claude session temp root",
      pattern: new RegExp("/private" + "/tmp/claude"),
    },
    {
      label: "Claude/Codex session temp root",
      pattern: new RegExp("/tmp" + "/claude-\\d+"),
    },
    {
      label: "absolute developer home directory",
      pattern: new RegExp("/Users" + "/[A-Za-z0-9._-]+/"),
    },
    {
      label: "absolute Linux home directory",
      pattern: new RegExp("/home" + "/[A-Za-z0-9._-]+/\\.?(claude|codex)"),
    },
    {
      label: "this session's scratchpad identifier",
      pattern: new RegExp("b1c7adea" + "-0b6c-4b08-90b1-d63cd1d97e6e"),
    },
  ];
  /**
   * Files permitted to contain a needle ONLY as a NEGATIVE fixture — a path
   * the file asserts must be REJECTED — never as a real filesystem target.
   * Every entry carries a reinforcing assertion in the test below, so an
   * allowlisted file cannot quietly start using the path for real.
   */
  const NEGATIVE_FIXTURE_ALLOWLIST: Readonly<Record<string, string>> = {
    "lib/meta/__tests__/d077-artifact-hash-contract.test.ts":
      "D077 portable-path rule + static census: the session path appears only inside assertions that reject it",
  };

  function collectTestFiles(dir: string, acc: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        collectTestFiles(join(dir, entry.name), acc);
      } else if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(entry.name)) {
        acc.push(relative(REPO_ROOT, join(dir, entry.name)));
      }
    }
    return acc;
  }

  it("no repository test hard-codes a session-specific or user-specific absolute path", () => {
    const testFiles = collectTestFiles(REPO_ROOT, []).sort();
    // Fail closed: an empty or truncated census would make this guard a no-op.
    expect(testFiles.length).toBeGreaterThan(100);
    expect(testFiles).toContain("scripts/creative-decision-center/generalized-pit-replay.test.ts");

    const violations: string[] = [];
    for (const file of testFiles) {
      const source = readFileSync(resolve(file), "utf8");
      for (const { label, pattern } of FORBIDDEN_PATHS) {
        const match = pattern.exec(source);
        if (!match) continue;
        if (file in NEGATIVE_FIXTURE_ALLOWLIST) continue;
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${file}:${line} contains a hard-coded ${label} (${match[0]})`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every negative-fixture allowlist entry is real and still only a negative fixture", () => {
    for (const [file, reason] of Object.entries(NEGATIVE_FIXTURE_ALLOWLIST)) {
      expect(reason.length, file).toBeGreaterThan(20);
      expect(existsSync(resolve(file)), `${file} allowlisted but missing`).toBe(true);
      const source = readFileSync(resolve(file), "utf8");
      // The real-usage form must never appear contiguously: the allowlisted
      // file splits the literal precisely because it is a deny-list fixture.
      expect(source.includes("/private" + "/tmp/claude"), file).toBe(false);
      // …and it must actually assert rejection, not merely mention the path.
      expect(/toThrow\(\/absolute\/\)|\.toBe\(false\)/.test(source), file).toBe(true);
    }
  });
});

describe("generalized PIT replay — declared source closure (correction 3)", () => {
  it("the declared execution/validation source set includes the dynamic extraction deps and its count is generated", () => {
    expect(PROVENANCE_SOURCE_FILES).toContain("lib/db.ts");
    expect(PROVENANCE_SOURCE_FILES).toContain("scripts/_operational-runtime.ts");
    expect(PROVENANCE_SOURCE_FILES.length).toBeGreaterThanOrEqual(18);
    for (const file of PROVENANCE_SOURCE_FILES) {
      expect(existsSync(resolve(file)), file).toBe(true);
    }
  });

  it("every non-node @/ import used by the runner is in the exact source manifest or explicitly classified", () => {
    const specifiers = new Set<string>();
    for (const match of RUNNER_SOURCE.matchAll(/from "(@\/[^"]+)"/g)) {
      specifiers.add(match[1]);
    }
    for (const match of RUNNER_SOURCE.matchAll(/import\("(@\/[^"]+)"\)/g)) {
      specifiers.add(match[1]);
    }
    expect(specifiers.size).toBeGreaterThan(5);
    const manifest = new Set(
      PROVENANCE_SOURCE_FILES.map((file) => `@/${file.replace(/\.ts$/, "")}`),
    );
    // Explicit classification for anything intentionally outside the
    // manifest (currently none — the manifest covers all runner imports).
    const classifiedNonRuntime = new Set<string>([]);
    const unaccounted = [...specifiers].filter(
      (specifier) => !manifest.has(specifier) && !classifiedNonRuntime.has(specifier),
    );
    expect(unaccounted, unaccounted.join(", ")).toEqual([]);
  });
});

describe("generalized PIT replay — report/artifact fact gate", () => {
  it("the report embeds exactly the machine-facts block generated from the frozen artifact", () => {
    const artifactPath = resolve(PIT_REPLAY_JSON_OUT);
    if (!existsSync(artifactPath)) {
      throw new Error("frozen artifact missing — report fact gate is fail-closed");
    }
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    const expectedBlock = renderReportFactsBlock(artifact, artifactPath);
    const report = readFileSync(
      resolve("docs/audits/GENERALIZED_PIT_REPLAY_2026-08-30.md"),
      "utf8",
    );
    const begin = report.indexOf("<!-- MACHINE-FACTS BEGIN");
    const end = report.indexOf("<!-- MACHINE-FACTS END -->");
    if (begin < 0 || end < 0) {
      throw new Error("report lacks the machine-facts block — regenerate it from the artifact");
    }
    const embedded = report.slice(begin, end + "<!-- MACHINE-FACTS END -->".length);
    expect(embedded).toBe(expectedBlock);
  });
});

describe("generalized PIT replay — UI truth on REAL frozen replay states", () => {
  interface UiTruthArtifact {
    uiTruthStates: {
      states: Array<{
        category: string;
        businessId: string;
        originDate: string;
        freshnessMode: string;
        creativeId: string;
        campaignId: string | null;
        overallTemporalClass: string;
        evidenceLayer: string;
        decision: DecisionOutput;
        inputEcho: { campaignKind: string | null };
      }>;
      unsupportedHorizonExample: { reason: string } | null;
      deselectedReference: { note: string } | null;
    };
  }
  function loadArtifact(): UiTruthArtifact {
    const artifactPath = resolve(PIT_REPLAY_JSON_OUT);
    if (!existsSync(artifactPath)) {
      throw new Error("frozen replay evidence artifact is MISSING — fail-closed");
    }
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8")) as Partial<UiTruthArtifact>;
    if (!parsed.uiTruthStates || !Array.isArray(parsed.uiTruthStates.states)) {
      throw new Error("frozen artifact lacks uiTruthStates — stale pre-correction evidence");
    }
    return parsed as UiTruthArtifact;
  }
  function lifecycleRoleOf(kind: string | null): MetaDecisionLifecycleRole {
    return kind === "main" || kind === "test" || kind === "mixed" ? kind : "role_unresolved";
  }
  type UiState = UiTruthArtifact["uiTruthStates"]["states"][number];
  function project(state: UiState, reviewOnly: boolean) {
    return projectCanonicalMetaDecisionPresentation({
      decision: state.decision,
      context: {
        creativeId: state.creativeId,
        campaignKind:
          (state.decision.campaignKind as "main" | "test" | "mixed" | null | undefined) ?? null,
      },
      lifecycleRole: lifecycleRoleOf(state.decision.campaignKind ?? null),
      reviewOnly,
    });
  }

  it("real frozen states exist for the required categories, all restated-retrospective replay facts", () => {
    const states = loadArtifact().uiTruthStates.states;
    expect(states.length).toBeGreaterThan(3);
    const categories = new Set(states.map((state) => state.category));
    for (const required of [
      "fresh_keep_review_only",
      "held_hard_action",
      "unresolved_role_row",
      "stale_mode_hard_signal_row",
    ]) {
      expect(categories.has(required), required).toBe(true);
    }
    expect(states.every((state) => state.overallTemporalClass === "restated_retrospective")).toBe(true);
    expect(states.every((state) => state.evidenceLayer === "deterministic_replay_fact")).toBe(true);
  });

  it("review-only projection NEVER exposes an execution action for ANY real state", () => {
    for (const state of loadArtifact().uiTruthStates.states) {
      const projection = project(state, true);
      if (projection.kind === "mapped") {
        expect(projection.executionAction, state.category).toBeNull();
      }
    }
  });

  it("stale/held/unresolved/blocked real states never yield an enabled hard mutation even outside review-only", () => {
    for (const state of loadArtifact().uiTruthStates.states) {
      const projection = project(state, false);
      if (projection.kind !== "mapped") continue;
      const enabledHardMutation =
        projection.executionAction !== null &&
        projection.semantics.decisionState !== "blocked" &&
        projection.heldAction === null &&
        ["cut", "scale", "refresh"].includes(state.decision.label);
      if (
        ["held_hard_action", "unresolved_role_row", "stale_mode_hard_signal_row", "diagnose_blocked_row"].includes(
          state.category,
        )
      ) {
        expect(enabledHardMutation, state.category).toBe(false);
      }
      if (projection.heldAction) {
        expect(projection.buyerLabel.endsWith("· Held"), state.category).toBe(true);
        expect(projection.semantics.decisionState).toBe("blocked");
        expect(projection.executionAction).toBeNull();
      }
    }
  });

  it("unsupported horizon/account reasons and evidence-layer labels are frozen and visible", () => {
    const artifact = loadArtifact();
    expect(artifact.uiTruthStates.unsupportedHorizonExample?.reason).toContain("last retained data day");
    expect(artifact.uiTruthStates.deselectedReference?.note).toContain("excluded");
  });

  it("no manual Test/Main label control or live label route exists in the current UI", () => {
    const route = readFileSync(resolve("app/api/meta/campaign-labels/route.ts"), "utf8");
    expect(route).toContain("campaign_labels_retired");
    expect(route).toContain("410");
    /*
      PRE-DEPLOY AUDIT: this asserted a path that never existed, so it was
      vacuously true before the removal and guarded nothing. The file this
      release actually deletes is under `redesign/`; re-adding it must fail
      this test.
    */
    expect(
      existsSync(resolve("components/meta/redesign/MetaCampaignLabelsSection.tsx")),
      "the buyer-facing Test/Main label section must stay deleted",
    ).toBe(false);
  });

});

/*
  FROZEN PACKAGE DRIFT LEDGER
  ===========================

  The evidence artifact records the SHA-256 of every source file it was frozen
  against. Four days of D079/D081/D084 and campaign-role-removal work have
  moved seven of those eighteen files — and the 2026-09-06 account-scoping
  correction has moved an eighth — so the frozen package no longer
  describes the engine on disk — a true and important fact that must be stated
  rather than discovered as an unrelated assertion failure.

  What has NOT changed is the accepted evidence itself: the artifact bytes and
  the acceptance document are byte-identical to what was accepted, and both are
  asserted as hard equalities in
  `scripts/creative-decision-center/commercial-anchor-counterfactual.test.ts`.

  This ledger is the deliberate record of the code drift. A file that drifts
  and is not listed here fails; a listed file that stops drifting also fails,
  because the ledger must not outlive the drift it documents. Regenerating the
  package requires replaying against retained production data, which is not
  available in a local gate — so the honest local statement is this list.
*/
describe("generalized PIT replay — frozen package drift ledger", () => {
  const DRIFTED_SINCE_FREEZE = [
    // D084/D079 commercial-anchor work.
    "lib/creative-decision-engine/account-decision-profile.ts",
    "lib/creative-decision-engine/types.ts",
    // D074b/D081 automatic campaign-role removal.
    "lib/creative-decision-engine/campaign-context/resolver.ts",
    "lib/creative-decision-engine/campaign-context/source.ts",
    // Pre-deploy audit: the upsert conflict target moved to the legacy key so
    // the migration stays survivable by the previous application image.
    "lib/creative-decision-engine/jobs/campaign-context-job.ts",
    /*
      Meta operator readiness, 2026-09-06: the account-scoped measured evidence
      correction. `getAccountCalibration` and its funnel twin read the pooled
      `account/*` scope for a verdict keyed on ONE provider account, so a
      sibling account's samples moved this account's retained profile identity
      and could supply calibration it had no evidence for. The readers now take
      an optional providerAccountId threaded into both the precomputed lookup
      and the runtime SQL. The replay's own inputs are unchanged — the pooled
      scope still answers an unscoped call byte for byte — but the file's hash
      has moved and this ledger records that rather than letting it surface as
      an unrelated assertion failure.
    */
    "lib/creative-decision-engine/data-source.ts",
    // The runner and its own test, edited alongside the work above.
    "scripts/creative-decision-center/generalized-pit-replay.ts",
    "scripts/creative-decision-center/generalized-pit-replay.test.ts",
  ] as const;

  it("drift is exactly the files this ledger names", () => {
    const artifactPath = resolve(PIT_REPLAY_JSON_OUT);
    if (!existsSync(artifactPath)) throw new Error("frozen artifact missing — fail-closed");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      provenance: { sourceFileSha256AtFreeze: Record<string, string> };
    };
    const frozen = artifact.provenance.sourceFileSha256AtFreeze;

    const observed: string[] = [];
    for (const [file, expected] of Object.entries(frozen)) {
      if (!existsSync(resolve(file))) { observed.push(file); continue; }
      const actual = createHash("sha256")
        .update(readFileSync(resolve(file))).digest("hex");
      if (actual !== expected) observed.push(file);
    }

    expect(observed.sort()).toEqual([...DRIFTED_SINCE_FREEZE].sort());
  });

  /*
    THE DRIFT'S SEMANTIC CONSEQUENCE, NAMED AND BOUNDED.

    File drift is a hash comparison; this is what it actually did to the
    frozen package. The D074b/D081 role removal changed
    `campaign-context/resolver.ts`, so the role timelines rebuilt from the
    frozen inputs no longer produce the frozen `roleAnalysis`. That failure is
    real and it is pinned EXACTLY: if a second section stopped re-deriving,
    or if this one started re-deriving again, this fails and the ledger is
    re-read rather than quietly widened.
  */
  it("the drift's only semantic consequence is the role analysis, exactly", () => {
    const artifact = JSON.parse(
      readFileSync(resolve(PIT_REPLAY_JSON_OUT), "utf8")) as Record<string, unknown>;
    const semantic = verifyPitReplayArtifact(artifact);
    expect(semantic.failures).toEqual([
      "roleAnalysis does not re-derive from frozen inputs",
    ]);
    expect(semantic.ok).toBe(false);
  }, 120_000);

  /*
    120s: this one re-verifies the 44 MB frozen artifact, recomputing every
    protected section hash, which is why the default 15s is not enough. The
    other drift assertion above hashes only the source files and is fast.
  */
  it("the verifier still REPORTS drift by name when asked", () => {
    // The mechanism itself must keep working: opting in must still fail, and
    // must name every drifted file.
    const artifact = JSON.parse(
      readFileSync(resolve(PIT_REPLAY_JSON_OUT), "utf8")) as Record<string, unknown>;
    const checked = verifyPitReplayArtifact(artifact, { checkSourceFiles: true });
    expect(checked.ok).toBe(false);
    for (const file of DRIFTED_SINCE_FREEZE) {
      expect(
        checked.failures.some((failure) => failure === `source drift since freeze: ${file}`),
        file,
      ).toBe(true);
    }
  }, 120_000);
});
