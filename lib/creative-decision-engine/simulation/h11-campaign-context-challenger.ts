import {
  DEFAULT_CONTEXT_CONFIG,
  type CampaignKind,
  type ContextConfidenceClass,
  type ContextResolverConfig,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  evaluateCandidateAcceptance,
  type CandidateAcceptanceResult,
  type ImprovementEstimate,
} from "./candidate-gates";
import {
  wilsonScoreInterval,
  type WilsonInterval,
} from "./paired-binary-inference";
import { stableConfigHash } from "./stable-config";

export const H11_CAMPAIGN_CONTEXT_CONTRACT_VERSION =
  "adsecute.meta.h11-campaign-context-challenger.v2" as const;

export type H11PolicyId =
  | "H11_P0_production_default"
  | "H11_P1_no_lineage_renormalized"
  | "H11_P2_no_naming_renormalized"
  | "H11_P3_conservative_confidence"
  | "H11_P4_no_lineage_no_naming_renormalized"
  | "H11_P5_no_lineage_conservative_confidence"
  | "H11_P6_no_naming_conservative_confidence"
  | "H11_P7_no_lineage_no_naming_conservative_confidence";

export type H11SignalProfile =
  "production" | "no_lineage" | "no_naming" | "no_lineage_no_naming";

export type H11ThresholdRegime = "production" | "conservative";

export interface H11ContextPolicy {
  id: H11PolicyId;
  label: string;
  baseline: boolean;
  rationale: string;
  includeLineage: boolean;
  signalProfile: H11SignalProfile;
  thresholdRegime: H11ThresholdRegime;
  config: ContextResolverConfig;
  configHash: string;
}

function cloneDefaultConfig(): ContextResolverConfig {
  return {
    familyWeights: { ...DEFAULT_CONTEXT_CONFIG.familyWeights },
    testNameTokens: [...DEFAULT_CONTEXT_CONFIG.testNameTokens],
    mainNameTokens: [...DEFAULT_CONTEXT_CONFIG.mainNameTokens],
    floors: { ...DEFAULT_CONTEXT_CONFIG.floors },
    thresholds: { ...DEFAULT_CONTEXT_CONFIG.thresholds },
    mixed: { ...DEFAULT_CONTEXT_CONFIG.mixed },
  };
}

function definePolicy(
  input: Omit<H11ContextPolicy, "configHash">,
): H11ContextPolicy {
  return {
    ...input,
    configHash: stableConfigHash({
      includeLineage: input.includeLineage,
      config: input.config,
    }),
  };
}

function configFor(
  signalProfile: H11SignalProfile,
  thresholdRegime: H11ThresholdRegime,
): ContextResolverConfig {
  const config = cloneDefaultConfig();
  if (signalProfile === "no_lineage") {
    config.familyWeights = {
      behavioral: 0.45,
      structure: 0.225,
      naming: 0.15,
      lineage: 0,
      continuity: 0.175,
    };
  } else if (signalProfile === "no_naming") {
    config.familyWeights = {
      behavioral: 0.475,
      structure: 0.25,
      naming: 0,
      lineage: 0.1,
      continuity: 0.175,
    };
    config.testNameTokens = [];
    config.mainNameTokens = [];
  } else if (signalProfile === "no_lineage_no_naming") {
    config.familyWeights = {
      behavioral: 0.55,
      structure: 0.275,
      naming: 0,
      lineage: 0,
      continuity: 0.175,
    };
    config.testNameTokens = [];
    config.mainNameTokens = [];
  }
  if (thresholdRegime === "conservative") {
    config.thresholds = {
      ...config.thresholds,
      highTopScore: 0.65,
      highMarginMain: 0.22,
      highMarginTest: 0.3,
      highMinAgreeingFamilies: 3,
      mediumTopScore: 0.5,
      mediumMargin: 0.12,
    };
  }
  return config;
}

/**
 * Complete predeclared 4x2 H11 matrix: four signal profiles crossed with the
 * shipped and conservative threshold regimes. Replay results must never add
 * or tune another variant after outcomes are observed.
 */
export const H11_CONTEXT_POLICIES: readonly H11ContextPolicy[] = [
  definePolicy({
    id: "H11_P0_production_default",
    label: "Production default",
    baseline: true,
    rationale: "Exact shipped resolver configuration and lineage policy.",
    includeLineage: true,
    signalProfile: "production",
    thresholdRegime: "production",
    config: configFor("production", "production"),
  }),
  definePolicy({
    id: "H11_P1_no_lineage_renormalized",
    label: "No lineage, renormalized",
    baseline: false,
    rationale:
      "Eliminates the known first-attribution lineage weakness and redistributes its 0.10 weight before observing outcomes.",
    includeLineage: false,
    signalProfile: "no_lineage",
    thresholdRegime: "production",
    config: configFor("no_lineage", "production"),
  }),
  definePolicy({
    id: "H11_P2_no_naming_renormalized",
    label: "No naming, renormalized",
    baseline: false,
    rationale:
      "Eliminates mutable campaign-name evidence, including name-vs-behavior conflicts, while retaining lineage as a sensitivity axis.",
    includeLineage: true,
    signalProfile: "no_naming",
    thresholdRegime: "production",
    config: configFor("no_naming", "production"),
  }),
  definePolicy({
    id: "H11_P3_conservative_confidence",
    label: "Conservative confidence",
    baseline: false,
    rationale:
      "Keeps shipped signals but raises predeclared high/medium evidence thresholds to test whether hard-action context can be made safer without collapse.",
    includeLineage: true,
    signalProfile: "production",
    thresholdRegime: "conservative",
    config: configFor("production", "conservative"),
  }),
  definePolicy({
    id: "H11_P4_no_lineage_no_naming_renormalized",
    label: "No lineage or naming, renormalized",
    baseline: false,
    rationale:
      "Removes both retained-history reliability risks together and redistributes their fixed weight before observing outcomes.",
    includeLineage: false,
    signalProfile: "no_lineage_no_naming",
    thresholdRegime: "production",
    config: configFor("no_lineage_no_naming", "production"),
  }),
  definePolicy({
    id: "H11_P5_no_lineage_conservative_confidence",
    label: "No lineage, conservative confidence",
    baseline: false,
    rationale:
      "Crosses the lineage ablation with the same bounded conservative threshold regime.",
    includeLineage: false,
    signalProfile: "no_lineage",
    thresholdRegime: "conservative",
    config: configFor("no_lineage", "conservative"),
  }),
  definePolicy({
    id: "H11_P6_no_naming_conservative_confidence",
    label: "No naming, conservative confidence",
    baseline: false,
    rationale:
      "Crosses the naming ablation with the same bounded conservative threshold regime.",
    includeLineage: true,
    signalProfile: "no_naming",
    thresholdRegime: "conservative",
    config: configFor("no_naming", "conservative"),
  }),
  definePolicy({
    id: "H11_P7_no_lineage_no_naming_conservative_confidence",
    label: "No lineage or naming, conservative confidence",
    baseline: false,
    rationale:
      "Crosses the combined reliability ablation with the same bounded conservative threshold regime.",
    includeLineage: false,
    signalProfile: "no_lineage_no_naming",
    thresholdRegime: "conservative",
    config: configFor("no_lineage_no_naming", "conservative"),
  }),
];

export const H11_H1_END_TO_END_SENSITIVITY = {
  id: "H11xH1_kind_parent_authority_sensitivity",
  authorityRule: "published_high_non_null_context_only",
  authoritativeParent: "campaign_kind",
  fallbackParent: "account_all",
  grantsProductionAuthority: false,
} as const;

export function h11H1CalibrationParent(input: {
  publishedKind: CampaignKind | null;
  publishedClass: ContextConfidenceClass;
}): CampaignKind | "all" {
  return input.publishedClass === "high" && input.publishedKind !== null
    ? input.publishedKind
    : "all";
}

export interface H11ScoredObservation {
  id: string;
  businessId: string;
  accountId: string;
  campaignId: string;
  date: string;
  manualKind: CampaignKind | null;
  predictedKind: CampaignKind | null;
  confidenceClass: ContextConfidenceClass;
}

export interface H11EvaluationSummary {
  observationCount: number;
  labeledObservations: number;
  uniqueLabeledCampaigns: number;
  classifiedObservations: number;
  uniqueClassifiedCampaigns: number;
  highConfidenceObservations: number;
  uniqueHighConfidenceCampaigns: number;
  exactMatches: number;
  exactAccuracy: number | null;
  exactAccuracyWilson95: WilsonInterval | null;
  allLabelAccuracy: number | null;
  labelCoverage: number | null;
  highConfidenceMatches: number;
  highConfidenceAccuracy: number | null;
  highConfidenceWilson95: WilsonInterval | null;
  falseTestAny: number;
  falseTestHigh: number;
  missedTest: number;
  predictedTest: number;
  manualTest: number;
  truePositiveTest: number;
  testRecall: number | null;
  testRecallWilson95: WilsonInterval | null;
  unresolved: number;
  conflict: number;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function summarizeH11Evaluation(
  observations: readonly H11ScoredObservation[],
): H11EvaluationSummary {
  const labeled = observations.filter((row) => row.manualKind !== null);
  const classified = labeled.filter((row) => row.predictedKind !== null);
  const high = classified.filter((row) => row.confidenceClass === "high");
  const exactMatches = classified.filter(
    (row) => row.predictedKind === row.manualKind,
  ).length;
  const highMatches = high.filter(
    (row) => row.predictedKind === row.manualKind,
  ).length;
  const manualTest = labeled.filter((row) => row.manualKind === "test");
  const truePositiveTest = manualTest.filter(
    (row) => row.predictedKind === "test",
  ).length;

  return {
    observationCount: observations.length,
    labeledObservations: labeled.length,
    uniqueLabeledCampaigns: new Set(
      labeled.map((row) => `${row.accountId}:${row.campaignId}`),
    ).size,
    classifiedObservations: classified.length,
    uniqueClassifiedCampaigns: new Set(
      classified.map((row) => `${row.accountId}:${row.campaignId}`),
    ).size,
    highConfidenceObservations: high.length,
    uniqueHighConfidenceCampaigns: new Set(
      high.map((row) => `${row.accountId}:${row.campaignId}`),
    ).size,
    exactMatches,
    exactAccuracy: ratio(exactMatches, classified.length),
    exactAccuracyWilson95: wilsonScoreInterval(exactMatches, classified.length),
    allLabelAccuracy: ratio(exactMatches, labeled.length),
    labelCoverage: ratio(classified.length, labeled.length),
    highConfidenceMatches: highMatches,
    highConfidenceAccuracy: ratio(highMatches, high.length),
    highConfidenceWilson95: wilsonScoreInterval(highMatches, high.length),
    falseTestAny: classified.filter(
      (row) => row.predictedKind === "test" && row.manualKind !== "test",
    ).length,
    falseTestHigh: high.filter(
      (row) => row.predictedKind === "test" && row.manualKind !== "test",
    ).length,
    missedTest: manualTest.length - truePositiveTest,
    predictedTest: classified.filter((row) => row.predictedKind === "test")
      .length,
    manualTest: manualTest.length,
    truePositiveTest,
    testRecall: ratio(truePositiveTest, manualTest.length),
    testRecallWilson95: wilsonScoreInterval(
      truePositiveTest,
      manualTest.length,
    ),
    unresolved: observations.filter(
      (row) => row.predictedKind === null && row.confidenceClass === "unknown",
    ).length,
    conflict: observations.filter(
      (row) => row.predictedKind === null && row.confidenceClass === "conflict",
    ).length,
  };
}

export interface H11PolicyFoldScore {
  policyId: H11PolicyId;
  summary: H11EvaluationSummary;
}

function nullableDescending(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/** Lock one policy on calibration only. Input order never affects selection. */
export function selectH11PolicyOnCalibration(
  scores: readonly H11PolicyFoldScore[],
): H11PolicyFoldScore | null {
  if (scores.length === 0) return null;
  const ids = new Set(scores.map((score) => score.policyId));
  if (ids.size !== scores.length) {
    throw new Error("H11 calibration scores contain duplicate policy ids");
  }

  return [...scores].sort((left, right) => {
    const leftSummary = left.summary;
    const rightSummary = right.summary;
    return (
      leftSummary.falseTestAny - rightSummary.falseTestAny ||
      nullableDescending(
        leftSummary.highConfidenceWilson95?.lower ?? null,
        rightSummary.highConfidenceWilson95?.lower ?? null,
      ) ||
      nullableDescending(
        leftSummary.highConfidenceAccuracy,
        rightSummary.highConfidenceAccuracy,
      ) ||
      rightSummary.uniqueHighConfidenceCampaigns -
        leftSummary.uniqueHighConfidenceCampaigns ||
      nullableDescending(
        leftSummary.allLabelAccuracy,
        rightSummary.allLabelAccuracy,
      ) ||
      nullableDescending(
        leftSummary.labelCoverage,
        rightSummary.labelCoverage,
      ) ||
      left.policyId.localeCompare(right.policyId)
    );
  })[0];
}

export interface H11AcceptanceInput {
  summary: H11EvaluationSummary;
  pairedAccuracyImprovement: ImprovementEstimate | null;
  publishedFlipRatePer100Days: number | null;
  maximumAllowedFlipRatePer100Days: number;
  collapsedAccountCount: number;
  invariantViolationCount: number;
}

export function evaluateH11Acceptance(
  input: H11AcceptanceInput,
): CandidateAcceptanceResult {
  const highInterval = input.summary.highConfidenceWilson95;
  const highEvidenceSufficient =
    input.summary.uniqueHighConfidenceCampaigns >= 30;
  const highEstimate =
    highInterval === null || !highEvidenceSufficient
      ? null
      : {
          point: highInterval.estimate,
          lower: Math.min(highInterval.lower, highInterval.estimate),
          upper: Math.max(highInterval.upper, highInterval.estimate),
          sampleSize: highInterval.total,
        };
  const coverage = input.summary.labelCoverage;
  const flipRate = input.publishedFlipRatePer100Days;
  return evaluateCandidateAcceptance([
    {
      id: "h11_high_confidence_unique_campaigns",
      kind: "minimum_evidence",
      metric: "unique high-confidence labeled campaigns",
      observed: input.summary.uniqueHighConfidenceCampaigns,
      minimum: 30,
    },
    {
      id: "h11_high_confidence_accuracy",
      kind: "minimum",
      metric: "high-confidence exact accuracy",
      estimate: highEstimate,
      minimum: 0.9,
      conservativeBound: "point",
    },
    {
      id: "h11_high_confidence_wilson_lower",
      kind: "minimum",
      metric: "high-confidence accuracy Wilson lower 95%",
      estimate: highEstimate,
      minimum: 0.85,
      conservativeBound: "lower",
    },
    {
      id: "h11_false_test_any",
      kind: "maximum_count",
      metric: "false Test classifications",
      observed: input.summary.falseTestAny,
      maximum: 0,
    },
    {
      id: "h11_labeled_coverage",
      kind: "minimum",
      metric: "classified share of labeled campaigns",
      estimate:
        coverage === null
          ? null
          : {
              point: coverage,
              lower: coverage,
              upper: coverage,
              sampleSize: input.summary.labeledObservations,
            },
      minimum: 0.7,
      conservativeBound: "point",
    },
    {
      id: "h11_paired_accuracy_non_inferiority",
      kind: "non_inferiority",
      metric: "paired all-label accuracy delta",
      improvement: input.pairedAccuracyImprovement,
      margin: 0.02,
    },
    {
      id: "h11_published_flip_rate",
      kind: "maximum",
      metric: "published flips per 100 campaign-days",
      estimate:
        flipRate === null
          ? null
          : {
              point: flipRate,
              lower: flipRate,
              upper: flipRate,
              sampleSize: input.summary.observationCount,
            },
      maximum: input.maximumAllowedFlipRatePer100Days,
      conservativeBound: "point",
    },
    {
      id: "h11_account_collapse",
      kind: "maximum_count",
      metric: "accounts with >90% unresolved context",
      observed: input.collapsedAccountCount,
      maximum: 0,
    },
    {
      id: "h11_invariant_violations",
      kind: "maximum_count",
      metric: "context safety invariant violations",
      observed: input.invariantViolationCount,
      maximum: 0,
    },
  ]);
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Cyclic label placebo preserving each account's exact class distribution.
 * It changes evaluation truth only and never feeds resolver features.
 */
export function cyclicAccountLabelPlacebo(
  observations: readonly H11ScoredObservation[],
  iteration: number,
): H11ScoredObservation[] {
  if (!Number.isInteger(iteration) || iteration <= 0) {
    throw new Error("placebo iteration must be a positive integer");
  }
  const labeled = observations.filter((row) => row.manualKind !== null);
  const byAccount = new Map<string, H11ScoredObservation[]>();
  for (const row of labeled) {
    const key = `${row.businessId}:${row.accountId}`;
    const rows = byAccount.get(key) ?? [];
    rows.push(row);
    byAccount.set(key, rows);
  }

  const replacement = new Map<string, CampaignKind>();
  for (const [accountKey, rows] of byAccount) {
    const sorted = [...rows].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (sorted.length < 2) continue;
    const offset =
      1 + ((iteration - 1 + hashText(accountKey)) % (sorted.length - 1));
    for (let index = 0; index < sorted.length; index += 1) {
      replacement.set(
        sorted[index].id,
        sorted[(index + offset) % sorted.length].manualKind as CampaignKind,
      );
    }
  }

  return observations.map((row) => ({
    ...row,
    manualKind: replacement.get(row.id) ?? row.manualKind,
  }));
}
