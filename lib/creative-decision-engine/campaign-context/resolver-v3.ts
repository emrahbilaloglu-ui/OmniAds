// Automatic Campaign Context Resolver v3 (D076).
//
// Pure, deterministic challenger to the v2 resolver. v2 stays intact in
// ./resolver.ts and remains the compiled default unless the D076 predeclared
// gate passes on the locked H11B validation fold. Three corrections and one
// new evidence family, exactly as declared in the ADR:
//  R3  small-scope concentration correction (top3 is structural at N<=3),
//  R1  mixed gate requires real testing breadth (activeCreatives >= 15),
//  R2  winner-core top3 bar 0.45 for broad campaigns,
//  +   lifecycle family from complete-lane entity-state history (status
//      share, cohort-relative budget), optional by construction: missing
//      evidence renormalizes away and can only lower confidence.
// No DB access in this module; the H11B evaluation feeds it from the frozen
// bundle, and the producer job would feed it live only after promotion.
import {
  type CampaignFeatures,
  type CampaignKind,
  type ContextConfidenceClass,
  type ContextResolution,
} from "./resolver";

/**
 * D081 C5 — the identity moves with the semantics, for the same reason as v2:
 * the pre-change algorithm must not be able to wear the post-change name.
 */
export const CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION =
  "campaign-context-resolver.v3-lifecycle-name-neutral-2026-09-01";

/** Retired identities. Never approvable; kept only so a reader can see why. */
export const RETIRED_CAMPAIGN_CONTEXT_RESOLVER_V3_VERSIONS = [
  "campaign-context-resolver.v3-lifecycle-2026-08-29",
] as const;

const FEATURE_WINDOW_DAYS = 28;

/**
 * D076 lifecycle evidence from complete-lane entity-state history. Every
 * field is nullable: the sources begin 2026-07-13 and a scope with no status
 * observations must lower confidence, never fabricate it.
 */
export interface CampaignLifecycleFeatures {
  statusCoverageDays: number | null;
  activeStatusShare28: number | null;
  currentConfiguredStatus: string | null;
  daysSinceLastStatusChange: number | null;
  effectiveDailyBudget: number | null;
  accountMedianDailyBudget: number | null;
  activeAdsetCount: number | null;
  accountMedianActiveCreatives: number | null;
}

export interface ContextResolverV3Config {
  familyWeights: {
    behavioral: number;
    structure: number;
    naming: number;
    lineage: number;
    continuity: number;
    lifecycle: number;
  };
  testNameTokens: string[];
  mainNameTokens: string[];
  floors: {
    minSpend28: number;
    minActiveCreatives: number;
    minActiveDays: number;
    singleCreativeSpendOverride: number;
  };
  thresholds: {
    highTopScore: number;
    highMarginMain: number;
    highMarginTest: number;
    highMinAgreeingFamilies: number;
    mediumTopScore: number;
    mediumMargin: number;
    conflictMargin: number;
    conflictFamilyStrength: number;
    familyAgreementMargin: number;
    mixedHighScore: number;
    mixedMediumScore: number;
    /** R3 corollary: a test-name conflict needs real Main behavior. */
    conflictMinMainSpendShare: number;
    conflictMinExcessConcentration: number;
  };
  mixed: {
    minTop3ShareForWinnerCore: number;
    /** R2: the top3 bar for campaigns with broad creative sets. */
    broadTop3ShareForWinnerCore: number;
    minStableWinnerCreatives: number;
    minTurnoverForActiveTesting: number;
    minNewCreativesForActiveTesting: number;
    /** R1: a winner-core + testing hybrid needs real breadth. */
    minActiveCreativesForActiveTesting: number;
  };
  strongTestSignature: {
    minCampaignAgeDays: number;
    minActiveDays: number;
    minActiveCreatives: number;
    minNewCreatives: number;
    minTurnover: number;
    minAdsets: number;
    maxTop3SpendShare: number;
    maxMedianCreativeSpendRatio: number;
    confidenceScore: number;
  };
  lifecycle: {
    minStatusCoverageDays: number;
    /** Budget ratio (budget / account median) mapping for the Main side. */
    mainBudgetRatioFloor: number;
    mainBudgetRatioSpan: number;
    /** Budget ratio mapping for the Test side (below-median position). */
    testBudgetRatioSpan: number;
    maxTestCampaignAgeDays: number;
  };
}

export const DEFAULT_V3_CONFIG: ContextResolverV3Config = {
  familyWeights: {
    behavioral: 0.35,
    structure: 0.175,
    naming: 0.125,
    lineage: 0.075,
    continuity: 0.125,
    lifecycle: 0.15,
  },
  testNameTokens: [
    "test",
    "tst",
    "deneme",
    "retest",
    "experiment",
    "lab",
    "probe",
    "trial",
  ],
  mainNameTokens: [
    "main",
    "perm",
    "permanent",
    "core",
    "winner",
    "evergreen",
    "scale",
    "best seller",
    "bestseller",
    "always on",
    "catalog",
    "dpa",
    "asc",
    "instock",
  ],
  floors: {
    minSpend28: 50,
    minActiveCreatives: 2,
    minActiveDays: 7,
    singleCreativeSpendOverride: 1_000,
  },
  thresholds: {
    highTopScore: 0.6,
    highMarginMain: 0.18,
    highMarginTest: 0.25,
    highMinAgreeingFamilies: 2,
    mediumTopScore: 0.45,
    mediumMargin: 0.1,
    conflictMargin: 0.06,
    conflictFamilyStrength: 0.55,
    familyAgreementMargin: 0.15,
    mixedHighScore: 0.65,
    mixedMediumScore: 0.5,
    conflictMinMainSpendShare: 0.08,
    conflictMinExcessConcentration: 0.5,
  },
  mixed: {
    minTop3ShareForWinnerCore: 0.5,
    broadTop3ShareForWinnerCore: 0.45,
    minStableWinnerCreatives: 2,
    minTurnoverForActiveTesting: 0.35,
    minNewCreativesForActiveTesting: 5,
    minActiveCreativesForActiveTesting: 15,
  },
  strongTestSignature: {
    minCampaignAgeDays: 14,
    minActiveDays: 14,
    minActiveCreatives: 12,
    minNewCreatives: 8,
    minTurnover: 0.5,
    minAdsets: 3,
    maxTop3SpendShare: 0.75,
    maxMedianCreativeSpendRatio: 1,
    confidenceScore: 0.8,
  },
  lifecycle: {
    minStatusCoverageDays: 7,
    mainBudgetRatioFloor: 0.75,
    mainBudgetRatioSpan: 0.5,
    testBudgetRatioSpan: 0.75,
    maxTestCampaignAgeDays: 21,
  },
};

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * R3: with N active creatives, top3SpendShare has a structural floor of
 * min(3, N)/N — at N<=3 it is 1.0 by construction and carries no
 * winner-concentration information at all. Concentration evidence is the
 * EXCESS over that floor, and only when N >= 4.
 */
export function excessConcentration(
  top3SpendShare: number | null,
  activeCreatives: number,
): number | null {
  if (top3SpendShare === null) return null;
  if (activeCreatives <= 3) return null;
  const expected = 3 / activeCreatives;
  if (expected >= 1) return null;
  return clamp01((top3SpendShare - expected) / (1 - expected));
}

export interface SignalFamilyScoresV3 {
  behavioralTest: number;
  behavioralMain: number;
  structureTest: number;
  structureMain: number;
  namingTest: number;
  namingMain: number;
  lineageTest: number;
  lineageMain: number;
  continuityTest: number;
  continuityMain: number;
  lifecycleTest: number;
  lifecycleMain: number;
  /** False when lifecycle inputs are missing; its weight renormalizes away. */
  lifecyclePresent: boolean;
  excessConcentration: number | null;
}

export function computeSignalScoresV3(
  features: CampaignFeatures,
  lifecycle: CampaignLifecycleFeatures | null,
  config: ContextResolverV3Config = DEFAULT_V3_CONFIG,
): SignalFamilyScoresV3 {
  const ageFactor =
    features.campaignAgeDays === null
      ? 0.5
      : clamp01(features.campaignAgeDays / 42);
  const rawTurnover =
    features.activeCreatives > 0
      ? features.newCreatives / features.activeCreatives
      : 0;
  const turnover = rawTurnover * ageFactor;
  const medianAge = features.medianCreativeAgeDays;
  const excess = excessConcentration(
    features.top3SpendShare,
    features.activeCreatives,
  );

  // Behavioral: same terms as v2, with the concentration terms replaced by
  // excess concentration and their weight renormalized away when excess is
  // structurally unavailable (R3).
  const behavioralTestTerms: Array<[number, number | null]> = [
    [0.45, clamp01(turnover / 0.5)],
    [
      0.3,
      medianAge === null ? null : clamp01((30 - medianAge) / 30) * ageFactor,
    ],
    [0.25, excess === null ? null : 1 - excess],
  ];
  const behavioralMainTerms: Array<[number, number | null]> = [
    [0.4, excess],
    [0.35, medianAge === null ? null : clamp01((medianAge - 21) / 40)],
    [0.25, clamp01(1 - turnover)],
  ];
  const weighted = (terms: Array<[number, number | null]>) => {
    const present = terms.filter(
      (term): term is [number, number] => term[1] !== null,
    );
    const weightSum = present.reduce((sum, [weight]) => sum + weight, 0);
    if (weightSum <= 0) return 0;
    return clamp01(
      present.reduce((sum, [weight, value]) => sum + weight * value, 0) /
        weightSum,
    );
  };
  const behavioralTest = weighted(behavioralTestTerms);
  const behavioralMain = weighted(behavioralMainTerms);

  const structureMain = clamp01(
    0.7 * clamp01((features.spendShareOfBusiness - 0.1) / 0.3) +
      0.3 *
        (features.medianCreativeSpend !== null &&
        features.accountMedianCreativeSpend !== null &&
        features.accountMedianCreativeSpend > 0
          ? clamp01(
              (features.medianCreativeSpend /
                features.accountMedianCreativeSpend -
                1) /
                2,
            )
          : 0),
  );
  const structureTest = clamp01(
    0.5 * clamp01((0.08 - features.spendShareOfBusiness) / 0.08) +
      0.5 * clamp01((features.activeCreatives - 8) / 20),
  );

  const name = (features.campaignName ?? "").toLowerCase();
  const namingTest = name
    ? config.testNameTokens.some((token) => name.includes(token))
      ? 0.8
      : 0
    : 0;
  const namingMain = name
    ? config.mainNameTokens.some((token) => name.includes(token))
      ? 0.8
      : 0
    : 0;

  const lineageTest =
    features.activeCreatives > 0
      ? Math.min(
          0.6,
          (features.lineageDonorCount / features.activeCreatives) * 1.5,
        )
      : 0;
  const lineageMain =
    features.activeCreatives > 0
      ? Math.min(
          0.6,
          (features.lineageReceiverCount / features.activeCreatives) * 1.5,
        )
      : 0;

  const age = features.campaignAgeDays;
  const continuityMain = clamp01(
    (age === null ? 0 : clamp01((age - 45) / 60)) * 0.6 +
      clamp01(features.activeDays / FEATURE_WINDOW_DAYS) * 0.4,
  );
  const continuityTest = age === null ? 0 : clamp01((21 - age) / 21) * 0.7;

  // Lifecycle family (D076): present only when the status share AND the
  // cohort budget position are actually computable.
  const budgetRatio =
    lifecycle !== null &&
    lifecycle.effectiveDailyBudget !== null &&
    lifecycle.accountMedianDailyBudget !== null &&
    lifecycle.accountMedianDailyBudget > 0
      ? lifecycle.effectiveDailyBudget / lifecycle.accountMedianDailyBudget
      : null;
  const lifecyclePresent =
    lifecycle !== null &&
    lifecycle.statusCoverageDays !== null &&
    lifecycle.statusCoverageDays >= config.lifecycle.minStatusCoverageDays &&
    lifecycle.activeStatusShare28 !== null &&
    budgetRatio !== null;
  let lifecycleMain = 0;
  let lifecycleTest = 0;
  if (lifecyclePresent && budgetRatio !== null) {
    const budgetMain = clamp01(
      (budgetRatio - config.lifecycle.mainBudgetRatioFloor) /
        config.lifecycle.mainBudgetRatioSpan,
    );
    const budgetTest = clamp01(
      (1 - budgetRatio) / config.lifecycle.testBudgetRatioSpan,
    );
    const shortLifecycle =
      age === null
        ? null
        : clamp01(
            (config.lifecycle.maxTestCampaignAgeDays - age) /
              config.lifecycle.maxTestCampaignAgeDays,
          );
    lifecycleMain = clamp01(
      0.5 * (lifecycle!.activeStatusShare28 ?? 0) + 0.5 * budgetMain,
    );
    lifecycleTest =
      shortLifecycle === null
        ? clamp01(budgetTest)
        : clamp01(0.6 * budgetTest + 0.4 * shortLifecycle);
  }

  return {
    behavioralTest: round4(behavioralTest),
    behavioralMain: round4(behavioralMain),
    structureTest: round4(structureTest),
    structureMain: round4(structureMain),
    namingTest,
    namingMain,
    lineageTest: round4(lineageTest),
    lineageMain: round4(lineageMain),
    continuityTest: round4(continuityTest),
    continuityMain: round4(continuityMain),
    lifecycleTest: round4(lifecycleTest),
    lifecycleMain: round4(lifecycleMain),
    lifecyclePresent,
    excessConcentration: excess === null ? null : round4(excess),
  };
}

const FAMILY_KEYS_V3 = [
  "behavioral",
  "structure",
  "naming",
  "lineage",
  "continuity",
  "lifecycle",
] as const;

export function classifyCampaignContextV3(
  features: CampaignFeatures,
  lifecycle: CampaignLifecycleFeatures | null,
  config: ContextResolverV3Config = DEFAULT_V3_CONFIG,
): ContextResolution {
  const signals = computeSignalScoresV3(features, lifecycle, config);

  // Family weights renormalize when lifecycle is absent, so a scope without
  // status history is scored by the remaining evidence at full weight —
  // never granted the missing family's share as phantom confidence.
  const weights = { ...config.familyWeights };
  if (!signals.lifecyclePresent) {
    const remaining = 1 - weights.lifecycle;
    weights.behavioral /= remaining;
    weights.structure /= remaining;
    weights.naming /= remaining;
    weights.lineage /= remaining;
    weights.continuity /= remaining;
    weights.lifecycle = 0;
  }

  const testScore = round4(
    weights.behavioral * signals.behavioralTest +
      weights.structure * signals.structureTest +
      weights.naming * signals.namingTest +
      weights.lineage * signals.lineageTest +
      weights.continuity * signals.continuityTest +
      weights.lifecycle * signals.lifecycleTest,
  );
  const mainScore = round4(
    weights.behavioral * signals.behavioralMain +
      weights.structure * signals.structureMain +
      weights.naming * signals.namingMain +
      weights.lineage * signals.lineageMain +
      weights.continuity * signals.continuityMain +
      weights.lifecycle * signals.lifecycleMain,
  );

  const evidence: string[] = [];
  const conflictReasons: string[] = [];

  const floors = config.floors;
  const creativeCountFloorPass =
    features.activeCreatives >= floors.minActiveCreatives ||
    (features.activeCreatives >= 1 &&
      features.spend28 >= floors.singleCreativeSpendOverride);
  const floorsPass =
    features.spend28 >= floors.minSpend28 &&
    creativeCountFloorPass &&
    features.activeDays >= floors.minActiveDays;
  if (!floorsPass) {
    return {
      campaignId: features.campaignId,
      campaignName: features.campaignName,
      kind: null,
      kindSource: "system_inferred",
      confidenceClass: "unknown",
      confidenceScore: 0,
      testScore,
      mainScore,
      mixedScore: 0,
      agreeingFamilies: [],
      conflictReasons: [],
      evidence: [
        `insufficient_evidence spend28=${round4(features.spend28)} activeCreatives=${features.activeCreatives} activeDays=${features.activeDays}`,
      ],
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
    };
  }

  const turnover =
    features.activeCreatives > 0
      ? features.newCreatives / features.activeCreatives
      : 0;
  // R1/R2: a winner-core + active-testing hybrid needs real testing breadth,
  // and a genuinely broad campaign's winner core is judged at a slightly
  // lower concentration bar.
  const winnerCoreBar =
    features.activeCreatives >=
    config.mixed.minActiveCreativesForActiveTesting
      ? config.mixed.broadTop3ShareForWinnerCore
      : config.mixed.minTop3ShareForWinnerCore;
  const hasWinnerCore =
    (features.top3SpendShare ?? 0) >= winnerCoreBar &&
    features.activeCreatives >= config.mixed.minStableWinnerCreatives &&
    (features.medianCreativeAgeDays ?? 0) >= 21;
  const hasActiveTesting =
    turnover >= config.mixed.minTurnoverForActiveTesting &&
    features.newCreatives >= config.mixed.minNewCreativesForActiveTesting &&
    features.activeCreatives >=
      config.mixed.minActiveCreativesForActiveTesting;
  const mixedScore =
    hasWinnerCore && hasActiveTesting
      ? round4(
          clamp01(0.5 + Math.min(signals.behavioralTest, signals.behavioralMain)),
        )
      : 0;

  if (mixedScore > 0) {
    evidence.push(
      `mixed_evidence winner_core(top3=${features.top3SpendShare}) + active_testing(turnover=${round4(turnover)}, new=${features.newCreatives}, creatives=${features.activeCreatives})`,
    );
    const confidenceClass: ContextConfidenceClass =
      mixedScore >= config.thresholds.mixedHighScore
        ? "high"
        : mixedScore >= config.thresholds.mixedMediumScore
          ? "medium"
          : "low";
    return {
      campaignId: features.campaignId,
      campaignName: features.campaignName,
      kind: "mixed",
      kindSource: "system_inferred",
      confidenceClass,
      confidenceScore: mixedScore,
      testScore,
      mainScore,
      mixedScore,
      agreeingFamilies: ["behavioral"],
      conflictReasons,
      evidence,
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
    };
  }

  const signature = config.strongTestSignature;
  const medianCreativeSpendRatio =
    features.medianCreativeSpend !== null &&
    features.accountMedianCreativeSpend !== null &&
    features.accountMedianCreativeSpend > 0
      ? features.medianCreativeSpend / features.accountMedianCreativeSpend
      : null;
  const strongTestSignature =
    (features.campaignAgeDays ?? 0) >= signature.minCampaignAgeDays &&
    features.activeDays >= signature.minActiveDays &&
    features.activeCreatives >= signature.minActiveCreatives &&
    features.newCreatives >= signature.minNewCreatives &&
    turnover >= signature.minTurnover &&
    features.adsetCount >= signature.minAdsets &&
    (features.top3SpendShare ?? 1) <= signature.maxTop3SpendShare &&
    medianCreativeSpendRatio !== null &&
    medianCreativeSpendRatio <= signature.maxMedianCreativeSpendRatio;
  // D081 C5 — no naming veto: a Main-flavoured name must not cancel a high Test
  // shortcut that behavioural and structural evidence already earned.

  if (strongTestSignature) {
    const agreeingFamilies = ["behavioral", "structure"];
    if (signals.namingTest > 0) agreeingFamilies.push("naming");
    evidence.push(
      `strong_test_signature active=${features.activeCreatives} new=${features.newCreatives} turnover=${round4(turnover)} adsets=${features.adsetCount} top3=${features.top3SpendShare} median_spend_ratio=${round4(medianCreativeSpendRatio)}`,
    );
    return {
      campaignId: features.campaignId,
      campaignName: features.campaignName,
      kind: "test",
      kindSource: "system_inferred",
      confidenceClass: "high",
      confidenceScore: Math.max(testScore, signature.confidenceScore),
      testScore,
      mainScore,
      mixedScore,
      agreeingFamilies,
      conflictReasons,
      evidence,
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
    };
  }

  // D081 C5 — the authoritative kind comes from naming-free evidence.
  const testScoreExNaming = round4(
    weights.behavioral * signals.behavioralTest +
      weights.structure * signals.structureTest +
      weights.lineage * signals.lineageTest +
      weights.continuity * signals.continuityTest +
      weights.lifecycle * signals.lifecycleTest,
  );
  const mainScoreExNaming = round4(
    weights.behavioral * signals.behavioralMain +
      weights.structure * signals.structureMain +
      weights.lineage * signals.lineageMain +
      weights.continuity * signals.continuityMain +
      weights.lifecycle * signals.lifecycleMain,
  );
  const topKind: CampaignKind =
    testScoreExNaming >= mainScoreExNaming ? "test" : "main";
  const topScore = topKind === "test" ? testScore : mainScore;
  const margin = round4(Math.abs(testScore - mainScore));
  /** Conflict reasons that may actually remove authority. Naming is excluded. */
  const authoritativeConflictReasons: string[] = [];

  const familyPairs: Record<
    (typeof FAMILY_KEYS_V3)[number],
    [number, number]
  > = {
    behavioral: [signals.behavioralTest, signals.behavioralMain],
    structure: [signals.structureTest, signals.structureMain],
    naming: [signals.namingTest, signals.namingMain],
    lineage: [signals.lineageTest, signals.lineageMain],
    continuity: [signals.continuityTest, signals.continuityMain],
    lifecycle: signals.lifecyclePresent
      ? [signals.lifecycleTest, signals.lifecycleMain]
      : [0, 0],
  };
  const agreeingFamilies = FAMILY_KEYS_V3.filter((family) => {
    if (family === "lifecycle" && !signals.lifecyclePresent) return false;
    const [testValue, mainValue] = familyPairs[family];
    const delta =
      topKind === "test" ? testValue - mainValue : mainValue - testValue;
    return delta >= config.thresholds.familyAgreementMargin;
  });

  // Conflict (R3 corollary): a test-token name conflicts with behavior only
  // when the behavior is REAL Main behavior — meaningful account spend share
  // or genuine excess concentration — not the structural top3 floor of a
  // small creative set.
  const strength = config.thresholds.conflictFamilyStrength;
  const realMainBehavior =
    features.spendShareOfBusiness >=
      config.thresholds.conflictMinMainSpendShare ||
    (signals.excessConcentration !== null &&
      signals.excessConcentration >=
        config.thresholds.conflictMinExcessConcentration);
  const namingOpposesBehavior =
    (signals.namingTest >= strength &&
      signals.behavioralMain >= strength &&
      realMainBehavior) ||
    (signals.namingMain >= strength && signals.behavioralTest >= strength);
  if (namingOpposesBehavior) {
    // D081 C5 — evidence only; it no longer decides the class.
    conflictReasons.push("naming_contradicts_behavior");
  }
  if (margin < config.thresholds.conflictMargin && topScore >= 0.5) {
    authoritativeConflictReasons.push("top_classes_too_close");
  }
  if (authoritativeConflictReasons.length > 0) {
    return {
      campaignId: features.campaignId,
      campaignName: features.campaignName,
      kind: null,
      kindSource: "system_inferred",
      confidenceClass: "conflict",
      confidenceScore: topScore,
      testScore,
      mainScore,
      mixedScore,
      agreeingFamilies,
      conflictReasons,
      evidence,
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
    };
  }

  const highMargin =
    topKind === "test"
      ? config.thresholds.highMarginTest
      : config.thresholds.highMarginMain;
  const behavioralAgrees = agreeingFamilies.includes("behavioral");
  /**
   * D081 C2 — naming is explanatory evidence, never load-bearing for high
   * confidence, for ANY kind. Kept in step with the live v2 resolver so the
   * hole cannot reappear when v3 is promoted.
   */
  const authoritativeAgreeingFamilies = agreeingFamilies.filter(
    (family) => family !== "naming",
  );
  /**
   * Naming is also removed from the SCORE the high gate reads. Excluding it
   * from the family count alone was not enough: its weight still moved
   * `topScore` and `margin`, so a rename could carry a campaign over the high
   * threshold without ever being counted as a family. The reported scores keep
   * naming — it remains explanatory and can still hold medium — but the
   * high-confidence gate is evaluated on evidence a rename cannot touch.
   */
  const topScoreExNaming =
    topKind === "test" ? testScoreExNaming : mainScoreExNaming;
  const marginExNaming = round4(
    topKind === "test"
      ? testScoreExNaming - mainScoreExNaming
      : mainScoreExNaming - testScoreExNaming,
  );
  const highEligible = behavioralAgrees;

  let confidenceClass: ContextConfidenceClass;
  if (
    topScoreExNaming >= config.thresholds.highTopScore &&
    marginExNaming >= highMargin &&
    authoritativeAgreeingFamilies.length >= config.thresholds.highMinAgreeingFamilies &&
    highEligible
  ) {
    confidenceClass = "high";
  } else if (
    topScore >= config.thresholds.mediumTopScore &&
    margin >= config.thresholds.mediumMargin
  ) {
    confidenceClass = "medium";
  } else {
    confidenceClass = "low";
  }

  evidence.push(
    `scores test=${testScore} main=${mainScore} margin=${margin} agreeing=[${agreeingFamilies.join("+") || "none"}] lifecycle=${signals.lifecyclePresent ? "present" : "absent"} excess_concentration=${signals.excessConcentration ?? "n/a"}`,
  );

  return {
    campaignId: features.campaignId,
    campaignName: features.campaignName,
    kind: topKind,
    kindSource: "system_inferred",
    confidenceClass,
    confidenceScore: topScore,
    testScore,
    mainScore,
    mixedScore,
    agreeingFamilies,
    conflictReasons,
    evidence,
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
  };
}
