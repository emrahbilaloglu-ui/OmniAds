// Automatic Campaign Context Resolver (D033).
//
// Pure, deterministic, config-as-data classification of campaign role
// (main/test/mixed) from behavioral, structural, naming, lineage, and
// continuity signal families. No DB access in this module; feature IO lives
// in ./data.ts and the daily producer job in ../jobs/campaign-context-job.ts.
// Spec: docs/creative-decision-center/AUTOMATIC_CAMPAIGN_CONTEXT_SPEC_2026-07-06.md

/**
 * D081 C5 — the identity moves with the semantics.
 *
 * Correction 2 changed high-confidence semantics while leaving this string at
 * `...v2-account-scoped-2026-08-29`, so a row computed by the pre-change
 * algorithm was indistinguishable from a post-change row. Once that string was
 * approved, stale name-load-bearing rows could masquerade as safe. The old
 * string is deliberately NOT reused and must fail validation.
 */
export const CAMPAIGN_CONTEXT_RESOLVER_VERSION =
  "campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01";

/** Retired identities. Never approvable; kept only so a reader can see why. */
export const RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS = [
  "campaign-context-resolver.v2-account-scoped-2026-08-29",
] as const;

export const FEATURE_WINDOW_DAYS = 28;

export type CampaignKind = "main" | "test" | "mixed";
export type ContextConfidenceClass =
  | "high"
  | "medium"
  | "low"
  | "unknown"
  | "conflict";

export interface CampaignFeatures {
  campaignId: string;
  campaignName: string | null;
  spend28: number;
  activeCreatives: number;
  newCreatives: number;
  medianCreativeAgeDays: number | null;
  top3SpendShare: number | null;
  spendHhi: number | null;
  adsetCount: number;
  activeDays: number;
  campaignAgeDays: number | null;
  spendShareOfBusiness: number;
  medianCreativeSpend: number | null;
  accountMedianCreativeSpend: number | null;
  lineageDonorCount: number;
  lineageReceiverCount: number;
  lineageSharedCount: number;
}

export interface SignalFamilyScores {
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
}

export interface ContextResolution {
  campaignId: string;
  campaignName: string | null;
  kind: CampaignKind | null;
  kindSource: "system_inferred";
  confidenceClass: ContextConfidenceClass;
  confidenceScore: number;
  testScore: number;
  mainScore: number;
  mixedScore: number;
  agreeingFamilies: string[];
  conflictReasons: string[];
  evidence: string[];
  resolverVersion: string;
}

export interface ContextResolverConfig {
  familyWeights: {
    behavioral: number;
    structure: number;
    naming: number;
    lineage: number;
    continuity: number;
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
  };
  mixed: {
    minTop3ShareForWinnerCore: number;
    minStableWinnerCreatives: number;
    minTurnoverForActiveTesting: number;
    minNewCreativesForActiveTesting: number;
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
}

export const DEFAULT_CONTEXT_CONFIG: ContextResolverConfig = {
  // Lineage weight is deliberately capped low per the spec's known data
  // constraint: warehouse first-non-null campaign attribution can blur
  // multi-campaign creative reuse.
  familyWeights: {
    behavioral: 0.4,
    structure: 0.2,
    naming: 0.15,
    lineage: 0.1,
    continuity: 0.15,
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
    // Single-creative catalog/DPA containers can carry large spend; they pass
    // floors on spend depth alone and rely on structure/naming/continuity.
    singleCreativeSpendOverride: 1_000,
  },
  thresholds: {
    highTopScore: 0.6,
    highMarginMain: 0.18,
    // Test classification must be stricter than Main (spec requirement).
    highMarginTest: 0.25,
    highMinAgreeingFamilies: 2,
    mediumTopScore: 0.45,
    mediumMargin: 0.1,
    conflictMargin: 0.06,
    conflictFamilyStrength: 0.55,
    familyAgreementMargin: 0.15,
    mixedHighScore: 0.65,
    mixedMediumScore: 0.5,
  },
  mixed: {
    minTop3ShareForWinnerCore: 0.5,
    minStableWinnerCreatives: 2,
    minTurnoverForActiveTesting: 0.35,
    minNewCreativesForActiveTesting: 5,
  },
  // A deterministic, account-normalized test-lab signature. This closes a
  // measured blind spot where young-but-established creative labs (for
  // example, 23/15 and 50/50 active/new creative cohorts) never reached Test
  // because campaign-age normalization suppressed turnover. Requiring three
  // or more ad sets, broad creative breadth, sustained delivery and below-
  // account median creative spend prevents a newly launched Main/DPA lane
  // from becoming high-confidence Test merely because all of its creatives
  // are new. Naming does not gate this shortcut: D081 C5 removed the Main
  // name-token veto, so an explicit Main token neither blocks nor weakens it.
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
};

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function nameMatchesToken(name: string, token: string) {
  return name.includes(token);
}

export function computeSignalScores(
  features: CampaignFeatures,
  config: ContextResolverConfig = DEFAULT_CONTEXT_CONFIG,
): SignalFamilyScores {
  // Age normalization: a young campaign whose creatives are all new is just
  // young, not "high-turnover testing". Turnover only counts as test evidence
  // once the campaign is old enough that stable winners could exist.
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
  const top3 = features.top3SpendShare;

  const behavioralTest = clamp01(
    0.45 * clamp01(turnover / 0.5) +
      0.3 * (medianAge === null ? 0 : clamp01((30 - medianAge) / 30)) * ageFactor +
      0.25 * (top3 === null ? 0 : clamp01((0.55 - top3) / 0.35)),
  );
  const behavioralMain = clamp01(
    0.4 * (top3 === null ? 0 : clamp01((top3 - 0.45) / 0.4)) +
      0.35 * (medianAge === null ? 0 : clamp01((medianAge - 21) / 40)) +
      0.25 * clamp01(1 - turnover),
  );

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
    ? config.testNameTokens.some((token) => nameMatchesToken(name, token))
      ? 0.8
      : 0
    : 0;
  const namingMain = name
    ? config.mainNameTokens.some((token) => nameMatchesToken(name, token))
      ? 0.8
      : 0
    : 0;

  const lineageTest =
    features.activeCreatives > 0
      ? Math.min(0.6, (features.lineageDonorCount / features.activeCreatives) * 1.5)
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
  };
}

const FAMILY_KEYS = [
  "behavioral",
  "structure",
  "naming",
  "lineage",
  "continuity",
] as const;

export function classifyCampaignContext(
  features: CampaignFeatures,
  config: ContextResolverConfig = DEFAULT_CONTEXT_CONFIG,
  options: { includeLineage?: boolean } = {},
): ContextResolution {
  const includeLineage = options.includeLineage ?? true;
  const signals = computeSignalScores(features, config);
  const weights = config.familyWeights;
  const lineageWeight = includeLineage ? weights.lineage : 0;

  const testScore = round4(
    weights.behavioral * signals.behavioralTest +
      weights.structure * signals.structureTest +
      weights.naming * signals.namingTest +
      lineageWeight * signals.lineageTest +
      weights.continuity * signals.continuityTest,
  );
  const mainScore = round4(
    weights.behavioral * signals.behavioralMain +
      weights.structure * signals.structureMain +
      weights.naming * signals.namingMain +
      lineageWeight * signals.lineageMain +
      weights.continuity * signals.continuityMain,
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
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    };
  }

  // Mixed is a positive kind: intentional winner core plus active testing.
  const turnover =
    features.activeCreatives > 0
      ? features.newCreatives / features.activeCreatives
      : 0;
  const hasWinnerCore =
    (features.top3SpendShare ?? 0) >= config.mixed.minTop3ShareForWinnerCore &&
    features.activeCreatives >= config.mixed.minStableWinnerCreatives &&
    (features.medianCreativeAgeDays ?? 0) >= 21;
  const hasActiveTesting =
    turnover >= config.mixed.minTurnoverForActiveTesting &&
    features.newCreatives >= config.mixed.minNewCreativesForActiveTesting;
  const mixedScore =
    hasWinnerCore && hasActiveTesting
      ? round4(clamp01(0.5 + Math.min(signals.behavioralTest, signals.behavioralMain)))
      : 0;

  if (mixedScore > 0) {
    evidence.push(
      `mixed_evidence winner_core(top3=${features.top3SpendShare}) + active_testing(turnover=${round4(turnover)}, new=${features.newCreatives})`,
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
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
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
  // D081 C5 — the naming veto (`signals.namingMain < conflictFamilyStrength`)
  // is gone: a Main-flavoured name could otherwise cancel a high Test shortcut
  // that behavioural and structural evidence had already earned.

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
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    };
  }

  // D081 C5 — the authoritative kind is chosen from naming-free evidence.
  // Choosing it from naming-inclusive scores let a name decide WHICH kind the
  // naming-free high gate then evaluated.
  const testScoreExNaming = round4(
    weights.behavioral * signals.behavioralTest +
      weights.structure * signals.structureTest +
      lineageWeight * signals.lineageTest +
      weights.continuity * signals.continuityTest,
  );
  const mainScoreExNaming = round4(
    weights.behavioral * signals.behavioralMain +
      weights.structure * signals.structureMain +
      lineageWeight * signals.lineageMain +
      weights.continuity * signals.continuityMain,
  );
  const topKind: CampaignKind =
    testScoreExNaming >= mainScoreExNaming ? "test" : "main";
  const topScore = topKind === "test" ? testScore : mainScore;
  const margin = round4(Math.abs(testScore - mainScore));
  /** Conflict reasons that may actually remove authority. Naming is excluded. */
  const authoritativeConflictReasons: string[] = [];

  const familyPairs: Record<(typeof FAMILY_KEYS)[number], [number, number]> = {
    behavioral: [signals.behavioralTest, signals.behavioralMain],
    structure: [signals.structureTest, signals.structureMain],
    naming: [signals.namingTest, signals.namingMain],
    lineage: includeLineage
      ? [signals.lineageTest, signals.lineageMain]
      : [0, 0],
    continuity: [signals.continuityTest, signals.continuityMain],
  };
  const agreeingFamilies = FAMILY_KEYS.filter((family) => {
    const [testValue, mainValue] = familyPairs[family];
    const delta = topKind === "test" ? testValue - mainValue : mainValue - testValue;
    return delta >= config.thresholds.familyAgreementMargin;
  });

  // Conflict: naming family strongly opposes behavior, or top classes are too
  // close to separate safely. Conflict stays a confidence class, never mixed.
  const strength = config.thresholds.conflictFamilyStrength;
  const namingOpposesBehavior =
    (signals.namingTest >= strength && signals.behavioralMain >= strength) ||
    (signals.namingMain >= strength && signals.behavioralTest >= strength);
  if (namingOpposesBehavior) {
    // D081 C5 — recorded as evidence, but NOT authoritative. A name that
    // contradicts behaviour previously forced `conflict`, which removed
    // authority a rename could then restore. Only non-naming reasons decide
    // the class.
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
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    };
  }

  const highMargin =
    topKind === "test"
      ? config.thresholds.highMarginTest
      : config.thresholds.highMarginMain;
  const behavioralAgrees = agreeingFamilies.includes("behavioral");
  /**
   * D081 C2 — naming is explanatory evidence, never load-bearing for high
   * confidence, for ANY kind.
   *
   * The former rule guarded Test only, so for Main and Mixed a human-authored
   * campaign name could be one of the two agreeing families that produced
   * `high` — the exact value that grants hard-action authority. Renaming a
   * campaign could therefore create or preserve authority.
   *
   * Naming keeps its score weight and still appears in `agreeingFamilies` and
   * in the evidence, so it can still carry a row to medium. It simply cannot
   * be counted toward the high-confidence family threshold. Behavioural
   * agreement is now required for high confidence in all three kinds.
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
    `scores test=${testScore} main=${mainScore} margin=${margin} agreeing=[${agreeingFamilies.join("+") || "none"}]`,
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
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  };
}

// Family key: structured naming conventions (e.g. TS_F5K_*, EMB-Perm-*) group
// campaign generations. Used for cold-start inheritance: a new campaign in an
// established family inherits the family kind at medium confidence.
export function campaignFamilyKey(name: string | null): string | null {
  if (!name) return null;
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length < 2) return null;
  return `${tokens[0]} ${tokens[1]}`;
}

export interface FamilyInheritanceInput {
  campaignId: string;
  familyKey: string | null;
  kind: CampaignKind | null;
  confidenceClass: ContextConfidenceClass;
}

export interface FamilyInheritanceOutcome {
  campaignId: string;
  inheritedKind: CampaignKind;
  basisMembers: number;
}

// Deterministic family inheritance: within a family of >=3 members whose
// classified (high/medium) members unanimously agree on main or mixed, the
// unknown members and weak (low-confidence) guesses inherit that kind at
// medium confidence. Low is weak evidence by definition, so a unanimous
// family consensus outranks it; medium/high behavioral calls are never
// overridden. Test is never inherited (false-Test protection) and conflict
// rows are never overridden.
export function computeFamilyInheritance(
  rows: readonly FamilyInheritanceInput[],
): FamilyInheritanceOutcome[] {
  const byFamily = new Map<string, FamilyInheritanceInput[]>();
  for (const row of rows) {
    if (!row.familyKey) continue;
    const list = byFamily.get(row.familyKey) ?? [];
    list.push(row);
    byFamily.set(row.familyKey, list);
  }
  const outcomes: FamilyInheritanceOutcome[] = [];
  for (const members of byFamily.values()) {
    if (members.length < 3) continue;
    const classified = members.filter(
      (m) =>
        m.kind !== null &&
        (m.confidenceClass === "high" || m.confidenceClass === "medium"),
    );
    if (classified.length < 2) continue;
    const kinds = new Set(classified.map((m) => m.kind));
    if (kinds.size !== 1) continue;
    const familyKind = classified[0].kind as CampaignKind;
    if (familyKind === "test") continue;
    for (const member of members) {
      if (member.confidenceClass === "conflict") continue;
      const isUnclassified = member.kind === null;
      const isWeakGuess =
        member.kind !== null &&
        member.confidenceClass === "low" &&
        member.kind !== familyKind;
      if (!isUnclassified && !isWeakGuess) continue;
      outcomes.push({
        campaignId: member.campaignId,
        inheritedKind: familyKind,
        basisMembers: classified.length,
      });
    }
  }
  return outcomes;
}

export interface HysteresisResult {
  finalKind: CampaignKind | null;
  finalClass: ContextConfidenceClass;
  flips: number;
  suppressedFlip: boolean;
}

// Class changes require persistence: a kind change only takes effect after two
// consecutive evaluations agree; a one-off flip is suppressed and reported.
/**
 * @deprecated Analysis-only aggregate; NOT production semantics. It skips
 * null resolutions (pinning stale kinds through conflict/unknown) and uses
 * lookahead. For any flip/stability claim use applyDailyHysteresis from
 * jobs/campaign-context-job.ts chained causally per date, as the shadow
 * script now does.
 */
export function applyHysteresisSequence(
  sequence: ReadonlyArray<{
    kind: CampaignKind | null;
    confidenceClass: ContextConfidenceClass;
  }>,
): HysteresisResult {
  let stableKind: CampaignKind | null = null;
  let stableClass: ContextConfidenceClass = "unknown";
  let flips = 0;
  let suppressedFlip = false;

  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index];
    if (current.kind === null) continue;
    if (stableKind === null) {
      stableKind = current.kind;
      stableClass = current.confidenceClass;
      continue;
    }
    if (current.kind === stableKind) {
      stableClass = current.confidenceClass;
      continue;
    }
    const next = sequence[index + 1];
    if (next && next.kind === current.kind) {
      stableKind = current.kind;
      stableClass = current.confidenceClass;
      flips += 1;
    } else {
      suppressedFlip = true;
      if (stableClass === "high") stableClass = "medium";
    }
  }

  return { finalKind: stableKind, finalClass: stableClass, flips, suppressedFlip };
}
