import type {
  BusinessTargetPack,
  CampaignCalibrationLookup,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "./data-source";
import {
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
} from "./config";
import { ENGINE_PRESET_MULTIPLIERS } from "./engine-presets";
import {
  observedShopifyAovIsUsable,
  type ObservedShopifyAovEvidence,
} from "./shopify-aov-source";
import { NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR } from "./config-values";
import {
  deterministicCommercialCutoffMs,
  isCommercialTargetInstantWithinCutoff,
} from "@/lib/meta/commercial-target-instant";
import {
  classifyMetaAovQuality,
  resolveSpendUnit,
} from "./spend-unit-resolver";
import {
  resolveCommercialAnchorExplanation,
  type CommercialAnchorExplanation,
} from "./commercial-anchor";

/**
 * Names the resolver whose `hardActionEligibility` is the canonical commercial
 * authority, so a consumer can cite WHICH authority its verdict came from
 * rather than asserting one existed.
 */
export const ACCOUNT_DECISION_PROFILE_CONTRACT =
  "adsecute.account-decision-profile.v1" as const;
import { resolveEngineV3Flags, type EngineV3Flags } from "./feature-flags";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  CalibrationCampaignKind,
  DecisionProfileScope,
  EngineMultiplierSet,
  EngineRiskPreset,
  EngineThresholdSet,
  HardActionEligibility,
  MetaAovQuality,
  SpendUnitProfile,
  ThresholdQuality,
} from "./types";

const CALIBRATION_CAMPAIGN_KINDS: CalibrationCampaignKind[] = [
  "all",
  "main",
  "test",
  "mixed",
];

export interface CommercialStopLossAovAuthorityInput {
  meanAov: number;
  purchaseCount: number;
  totalRevenue: number;
}

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Validates the redundant account-AOV arithmetic without assuming that every
 * account currency has two decimal places. The tolerance is relative to the
 * represented magnitudes and only absorbs floating-point round-trip error.
 */
export function isAccountAovRevenueArithmeticConsistent(input: {
  meanAov: number;
  purchaseCount: number;
  totalRevenue: number;
}) {
  if (
    !positiveFinite(input.meanAov) ||
    !Number.isSafeInteger(input.purchaseCount) ||
    input.purchaseCount <= 0 ||
    !positiveFinite(input.totalRevenue)
  ) {
    return false;
  }
  const derivedRevenue = input.meanAov * input.purchaseCount;
  if (!Number.isFinite(derivedRevenue)) return false;
  const magnitude = Math.max(
    Math.abs(derivedRevenue),
    Math.abs(input.totalRevenue),
  );
  const tolerance = magnitude * Number.EPSILON * 64;
  return Math.abs(derivedRevenue - input.totalRevenue) <= tolerance;
}

function overrideMultiplier(
  fallback: number,
  override: number | null | undefined,
): number {
  return positiveFinite(override) ? override : fallback;
}

function resolvePreset(input: {
  targetPack: BusinessTargetPack | null;
  profileConfig: DecisionCalibrationProfileConfig | null;
  presetOverride?: EngineRiskPreset | null;
}): {
  preset: EngineRiskPreset;
  presetSource: AccountDecisionProfile["presetSource"];
} {
  if (input.presetOverride) {
    return {
      preset: input.presetOverride,
      presetSource: "business_engine_v3_flags_override",
    };
  }
  if (input.profileConfig?.enginePresetLabel) {
    return {
      preset: input.profileConfig.enginePresetLabel,
      presetSource: "business_decision_calibration_profile",
    };
  }
  if (input.targetPack?.defaultRiskPosture) {
    return {
      preset: input.targetPack.defaultRiskPosture,
      presetSource: "target_pack_risk_posture",
    };
  }
  return { preset: "balanced", presetSource: "default" };
}

function mergeMultipliers(input: {
  preset: EngineRiskPreset;
  profileConfig: DecisionCalibrationProfileConfig | null;
}): EngineMultiplierSet {
  const defaults = ENGINE_PRESET_MULTIPLIERS[input.preset];
  const overrides = input.profileConfig;

  return {
    zeroConvBurner: overrideMultiplier(
      defaults.zeroConvBurner,
      overrides?.zeroConvBurnerMultiplier,
    ),
    cutCandidate: overrideMultiplier(
      defaults.cutCandidate,
      overrides?.cutCandidateMultiplier,
    ),
    sustainedLoser: overrideMultiplier(
      defaults.sustainedLoser,
      overrides?.sustainedLoserMultiplier,
    ),
    lossBudget: defaults.lossBudget,
    hardCut: overrideMultiplier(defaults.hardCut, overrides?.hardCutMultiplier),
    scalePurchase: overrideMultiplier(
      defaults.scalePurchase,
      overrides?.scalePurchaseMultiplier,
    ),
    winnerMemory: overrideMultiplier(
      defaults.winnerMemory,
      overrides?.winnerMemoryMultiplier,
    ),
    recentSample: overrideMultiplier(
      defaults.recentSample,
      overrides?.recentSampleMultiplier,
    ),
    weakFunnelRate: overrideMultiplier(
      defaults.weakFunnelRate,
      overrides?.weakFunnelRateMultiplier,
    ),
  };
}

function spendThreshold(
  spendUnit: number | null,
  multiplier: number,
): number | null {
  return positiveFinite(spendUnit) ? spendUnit * multiplier : null;
}

function purchaseThreshold(
  baseline: number | null,
  multiplier: number,
): number {
  const raw = positiveFinite(baseline) ? baseline : 1;
  return Math.max(1, Math.ceil(raw * multiplier));
}

function emptyByKind<T>(): Record<CalibrationCampaignKind, T | null> {
  return {
    all: null,
    main: null,
    test: null,
    mixed: null,
  };
}

function buildEngineThresholds(input: {
  spendUnit: number | null;
  multipliers: EngineMultiplierSet;
  accountBaselines: AccountCalibration;
}): EngineThresholdSet {
  return {
    zeroConvBurnerSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.zeroConvBurner,
    ),
    cutCandidateSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.cutCandidate,
    ),
    sustainedLoserSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.sustainedLoser,
    ),
    commercialMaturitySpend: spendThreshold(
      input.spendUnit,
      input.multipliers.lossBudget,
    ),
    hardCutSpend: spendThreshold(input.spendUnit, input.multipliers.hardCut),
    recentSampleMinSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.recentSample,
    ),
    winnerMemoryMinSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.winnerMemory,
    ),
    scaleMinPurchases: purchaseThreshold(
      input.accountBaselines.winnerPurchaseP50,
      input.multipliers.scalePurchase,
    ),
    winnerMemoryMinPurchases: purchaseThreshold(
      input.accountBaselines.winnerPurchaseP50,
      input.multipliers.winnerMemory,
    ),
    bottomQuartileRatio: input.accountBaselines.roasRatioP25,
    severeLoserRatio: input.accountBaselines.roasRatioP10,
  };
}

function resolveThresholdQuality(input: {
  spendUnit: number | null;
  confidence: AccountDecisionProfile["spendUnitConfidence"];
}): ThresholdQuality {
  if (!positiveFinite(input.spendUnit)) return "insufficient";
  return input.confidence === "high" || input.confidence === "medium"
    ? "ready"
    : "degraded";
}

function hardActionReason(input: {
  source: AccountDecisionProfile["spendUnitSource"];
  confidence: AccountDecisionProfile["spendUnitConfidence"];
  metaAovQuality: MetaAovQuality;
}): string {
  return `threshold baseline ${input.source} has ${input.confidence} confidence (meta AOV ${input.metaAovQuality})`;
}

function resolveSpendUnitProfile(input: {
  targetPack: BusinessTargetPack | null;
  accountBaselines: AccountCalibration;
  attributionAovAdjustmentMultiplier: number;
  /**
   * The deterministic cutoff this profile is being built AS OF, in epoch ms.
   *
   * ROUND 9 ITEM 2. Required, not optional: the previous check asked only
   * whether `updatedAt` PARSED, so a pack saved after the day being
   * reconstructed was "trusted" and kept `commercialThresholdEligible` open.
   * Null means the caller could not derive a cutoff at all, which fails closed
   * exactly like an unparseable timestamp — never like a wall clock.
   */
  asOfCutoffMs: number | null;
  /**
   * The store's own AOV, already proven usable (account currency, closed
   * window, order floor) by `resolveObservedShopifyAov`. Optional: an account
   * with no connected store resolves exactly as it did before.
   */
  observedShopifyAov?: ObservedShopifyAovEvidence | null;
}): SpendUnitProfile {
  const observed = input.observedShopifyAov ?? null;
  const observedAovMajor =
    observed && observedShopifyAovIsUsable(observed)
      ? observed.aovMinor / 10 ** observed.currencyExponent
      : null;
  const resolution = resolveSpendUnit({
    targetCpa: input.targetPack?.targetCpa ?? null,
    operatorAovAssumption: input.targetPack?.operatorAovAssumption ?? null,
    observedShopifyAov: observedAovMajor,
    observedShopifyAovOrderCount: observed?.orderCount ?? 0,
    observedShopifyAovStatus: observed?.status ?? null,
    metaAttributedAovMean90d: input.accountBaselines.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d:
      input.accountBaselines.metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d: input.accountBaselines.metaAttributedRevenue90d,
    targetRoas: input.targetPack?.targetRoas ?? null,
    breakEvenRoas: input.targetPack?.breakEvenRoas ?? null,
    accountCpaP50: input.accountBaselines.accountCpaP50,
    accountCpaSampleCount: input.accountBaselines.accountCpaSampleCount,
    attributionAovAdjustmentMultiplier:
      input.attributionAovAdjustmentMultiplier,
  });

  const freshness = input.targetPack?.freshness ?? "unknown";
  const targetUpdatedAt = input.targetPack?.updatedAt ?? null;
  /*
    STRICT. `Date.parse` accepted an impossible calendar date (`2026-02-30`
    silently becomes 2026-03-02), a bare `YYYY-MM-DD`, and a naked local time
    that means a different instant on every host — and any of those made this
    pack "trusted", which is what keeps `commercialThresholdEligible` open. The
    shared validator refuses all three.
  */
  const commercialTruthTimestampTrusted =
    freshness !== "unknown" &&
    input.asOfCutoffMs !== null &&
    isCommercialTargetInstantWithinCutoff(targetUpdatedAt, input.asOfCutoffMs);
  /*
    `observed_shopify_aov` belongs in this list, and was missing from it.

    Every member here is a rung whose spend unit is derived THROUGH the target
    pack, so an untrustworthy or stale pack has to demote it. The store rung is
    the merchant's own average order value divided by `targetPack.targetRoas` —
    the pack is load-bearing in exactly the same way — but it was omitted, so
    while the rung was unreachable at serve time nobody noticed that it alone
    would have escaped both the provenance demotion and the staleness warning.
    Making the rung reachable without this line would have shipped that hole.
  */
  const usesCommercialThreshold =
    resolution.source === "target_cpa" ||
    resolution.source === "operator_aov" ||
    resolution.source === "observed_shopify_aov" ||
    resolution.source === "meta_derived_aov" ||
    resolution.source === "break_even_aov";
  const commercialThresholdLacksTrustedProvenance =
    input.targetPack !== null &&
    !commercialTruthTimestampTrusted &&
    usesCommercialThreshold;
  const commercialTargetWarning =
    input.targetPack !== null && usesCommercialThreshold
      ? freshness === "stale"
        ? "commercial_target_stale"
        : !commercialTruthTimestampTrusted
          ? "commercial_target_freshness_unknown"
          : null
      : null;

  return {
    spendUnit: resolution.spendUnit,
    spendUnitSource: resolution.source,
    spendUnitConfidence: commercialThresholdLacksTrustedProvenance
      ? "low"
      : resolution.confidence,
    spendUnitEvidence: commercialTargetWarning
      ? {
          ...resolution.evidence,
          confidenceBeforeFreshness: resolution.confidence,
          warnings: Array.from(
            new Set([...resolution.evidence.warnings, commercialTargetWarning]),
          ),
        }
      : {
          ...resolution.evidence,
          confidenceBeforeFreshness: resolution.confidence,
        },
    hardEligibleByDefault:
      resolution.hardEligibleByDefault &&
      !commercialThresholdLacksTrustedProvenance,
    commercialThresholdProvenanceUnverified:
      commercialThresholdLacksTrustedProvenance,
  };
}

function resolveHardActionEligibility(input: {
  spendUnitProfile: SpendUnitProfile;
  targetPack: BusinessTargetPack | null;
  metaAovQuality: MetaAovQuality;
  calibrationReady: boolean;
  shadowOnly: boolean;
  /** The same deterministic cutoff `resolveSpendUnitProfile` was given. */
  asOfCutoffMs: number | null;
  /** Reported in the anchor lineage; it scales the Meta-derived spend unit. */
  attributionAovAdjustmentMultiplier?: number | null;
}): HardActionEligibility {
  if (input.shadowOnly) {
    const shadowAnchor = buildAnchorExplanation({
      ...input,
      thresholdEligible: false,
      scaleAnchorEligible: false,
      cutAnchorEligible: false,
    });
    return {
      scale: false,
      cut: false,
      refresh: false,
      reason: "shadow_only",
      reasons: {
        scale: "shadow_only",
        cut: "shadow_only",
        refresh: "shadow_only",
      },
      codes: {
        scale: "shadow_only",
        cut: "shadow_only",
        refresh: "shadow_only",
      },
      anchor: shadowAnchor,
    };
  }

  const commercialThresholdEligible =
    input.spendUnitProfile.hardEligibleByDefault &&
    (input.spendUnitProfile.spendUnitConfidence === "high" ||
      (input.spendUnitProfile.spendUnitConfidence === "medium" &&
        input.metaAovQuality === "ready"));
  const targetUpdatedAt = input.targetPack?.updatedAt ?? null;
  /*
    Same reading and the SAME CUTOFF as `resolveSpendUnitProfile` above, and
    the same reason: this boolean is what lets a Scale or Cut anchor be claimed
    at all. A target one millisecond after the cutoff is evidence this
    reconstruction is not allowed to have seen, so it anchors nothing.
  */
  const targetPackAuthoritative =
    input.targetPack?.freshness !== "unknown" &&
    input.asOfCutoffMs !== null &&
    isCommercialTargetInstantWithinCutoff(targetUpdatedAt, input.asOfCutoffMs);
  const targetRoasAnchored = positiveFinite(
    input.targetPack?.targetRoas ?? null,
  );
  const breakEvenAnchored = positiveFinite(
    input.targetPack?.breakEvenRoas ?? null,
  );
  const scaleAnchorEligible = targetPackAuthoritative && targetRoasAnchored;
  /*
    An explicit break-even ROAS is no longer a required Cut input.

    Grandmix's purchase cell configures a Target ROAS and has a
    ready 90-day Meta platform AOV, but no operator ever typed a break-even
    ROAS. That made `cutAnchorEligible` false, so every Cut on the account
    reported `valid explicit break-even ROAS is required for cut authority`
    even though the Cut the resolver actually wanted to publish was the
    account-relative one below `bottomQuartileRatio`, which never reads
    break-even at all.

    Target ROAS is accepted as the Cut anchor here, and it sizes only the
    SPEND unit (Meta platform AOV / target ROAS) that the loss-budget
    thresholds are built from. It does not become a ROAS loss boundary:
    `cut-policy.hasExplicitBreakEven` still keys the D049/D063 economic strip
    off `spendUnitEvidence.breakEvenRoas`, so with no break-even present the
    only reachable Cut zone stays the calibrated-relative one. Break-even
    keeps narrowing that boundary wherever it is configured.
  */
  const cutAnchorEligible =
    targetPackAuthoritative && (breakEvenAnchored || targetRoasAnchored);
  const refreshEligible = commercialThresholdEligible;
  const scaleEligible =
    commercialThresholdEligible &&
    input.calibrationReady &&
    scaleAnchorEligible;
  const scaleReason = scaleEligible
    ? null
    : !commercialThresholdEligible
      ? hardActionReason({
          source: input.spendUnitProfile.spendUnitSource,
          confidence: input.spendUnitProfile.spendUnitConfidence,
          metaAovQuality: input.metaAovQuality,
        })
      : !scaleAnchorEligible
        ? "valid explicit target ROAS is required for scale authority"
        : "scale calibration sample is below automation-quality floor";
  const cutEligible = commercialThresholdEligible && cutAnchorEligible;
  const cutReason = cutEligible
    ? null
    : !commercialThresholdEligible
      ? hardActionReason({
          source: input.spendUnitProfile.spendUnitSource,
          confidence: input.spendUnitProfile.spendUnitConfidence,
          metaAovQuality: input.metaAovQuality,
        })
      : "valid explicit break-even or target ROAS is required for cut authority";
  const refreshReason = refreshEligible
    ? null
    : hardActionReason({
        source: input.spendUnitProfile.spendUnitSource,
        confidence: input.spendUnitProfile.spendUnitConfidence,
        metaAovQuality: input.metaAovQuality,
      });
  const reasons = {
    scale: scaleReason,
    cut: cutReason,
    refresh: refreshReason,
  };
  const hardEligible = scaleEligible && cutEligible && refreshEligible;
  const firstBlockedReason = scaleReason ?? cutReason ?? refreshReason;

  // The explanation is derived from the SAME predicates decided above, so a
  // machine code can never disagree with the boolean it explains.
  const anchor = buildAnchorExplanation({
    ...input,
    attributionAovAdjustmentMultiplier: input.attributionAovAdjustmentMultiplier,
    thresholdEligible: commercialThresholdEligible,
    scaleAnchorEligible,
    cutAnchorEligible,
  });

  return {
    scale: scaleEligible,
    cut: cutEligible,
    refresh: refreshEligible,
    reason: hardEligible ? null : firstBlockedReason,
    reasons,
    codes: {
      scale: anchor.actions.scale.blockerCode,
      cut: anchor.actions.cut.blockerCode,
      refresh: anchor.actions.refresh.blockerCode,
    },
    anchor,
  };
}

/**
 * Builds the operator-facing anchor explanation from resolved predicates.
 * It reports; it never decides.
 */
function buildAnchorExplanation(input: {
  spendUnitProfile: SpendUnitProfile;
  targetPack: BusinessTargetPack | null;
  metaAovQuality: MetaAovQuality;
  calibrationReady: boolean;
  shadowOnly: boolean;
  currency?: string | null;
  attributionAovAdjustmentMultiplier?: number | null;
  thresholdEligible: boolean;
  scaleAnchorEligible: boolean;
  cutAnchorEligible: boolean;
}): CommercialAnchorExplanation {
  const evidence = input.spendUnitProfile.spendUnitEvidence;
  return resolveCommercialAnchorExplanation({
    shadowOnly: input.shadowOnly,
    thresholdEligible: input.thresholdEligible,
    provenanceUnverified:
      input.spendUnitProfile.commercialThresholdProvenanceUnverified ?? false,
    scaleAnchorEligible: input.scaleAnchorEligible,
    cutAnchorEligible: input.cutAnchorEligible,
    calibrationReady: input.calibrationReady,
    spendUnit: input.spendUnitProfile.spendUnit,
    spendUnitSource: input.spendUnitProfile.spendUnitSource,
    spendUnitConfidence: input.spendUnitProfile.spendUnitConfidence,
    metaAovQuality: input.metaAovQuality,
    currency: input.currency ?? null,
    targetPackFreshness: input.targetPack?.freshness ?? null,
    targetPackUpdatedAt: input.targetPack?.updatedAt ?? null,
    lineage: {
      targetCpa: evidence.targetCpa ?? null,
      operatorAovAssumption: evidence.operatorAovAssumption ?? null,
      targetRoas: evidence.targetRoas ?? null,
      breakEvenRoas: evidence.breakEvenRoas ?? null,
      metaAttributedAovMean90d: evidence.metaAttributedAovMean90d ?? null,
      metaAttributedAovPurchaseCount90d:
        evidence.metaAttributedAovPurchaseCount90d ?? 0,
      attributionAovAdjustmentMultiplier:
        input.attributionAovAdjustmentMultiplier ?? null,
      accountCpaP50: evidence.accountCpaP50 ?? null,
      accountCpaSampleCount: evidence.accountCpaSampleCount ?? 0,
    },
  });
}

function hardActionEligibilityReason(
  eligibility: HardActionEligibility,
  action: "scale" | "cut" | "refresh",
) {
  return (
    eligibility.reasons?.[action] ??
    (eligibility[action] ? null : eligibility.reason)
  );
}

/**
 * Applies an already-resolved commercial stop-loss view without allowing it
 * to replace any non-Cut profile input or Scale/Refresh authority.
 */
export function applyCutOnlyCommercialStopLossProfile(input: {
  baseProfile: AccountDecisionProfile;
  commercialStopLossSpendUnit: SpendUnitProfile | null;
  commercialStopLossThresholds: EngineThresholdSet | null;
  commercialStopLossEligibility: HardActionEligibility;
}): AccountDecisionProfile {
  const canonicalEligibility =
    input.baseProfile.commercialStopLossCanonicalHardActionEligibility ??
    input.baseProfile.hardActionEligibility;
  const hasCommercialStopLossOverlay =
    input.commercialStopLossSpendUnit !== null &&
    input.commercialStopLossThresholds !== null;
  const scale = canonicalEligibility.scale;
  const cut =
    canonicalEligibility.cut ||
    (hasCommercialStopLossOverlay && input.commercialStopLossEligibility.cut);
  const refresh = canonicalEligibility.refresh;
  const reasons = {
    scale: hardActionEligibilityReason(canonicalEligibility, "scale"),
    cut: canonicalEligibility.cut
      ? hardActionEligibilityReason(canonicalEligibility, "cut")
      : hardActionEligibilityReason(
          input.commercialStopLossEligibility,
          "cut",
        ),
    refresh: hardActionEligibilityReason(canonicalEligibility, "refresh"),
  };
  // Codes follow the same source-of-truth split as `reasons` above: Cut may be
  // explained by the stop-loss overlay, Scale/Refresh never are.
  const codes = {
    scale: canonicalEligibility.codes?.scale ?? null,
    cut: canonicalEligibility.cut
      ? (canonicalEligibility.codes?.cut ?? null)
      : (input.commercialStopLossEligibility.codes?.cut ?? null),
    refresh: canonicalEligibility.codes?.refresh ?? null,
  };
  return {
    ...input.baseProfile,
    commercialStopLossSpendUnit: input.commercialStopLossSpendUnit,
    commercialStopLossThresholds: input.commercialStopLossThresholds,
    commercialStopLossCanonicalHardActionEligibility:
      hasCommercialStopLossOverlay
        ? canonicalEligibility
        : null,
    hardActionEligibility: {
      scale,
      cut,
      refresh,
      reason:
        scale && cut && refresh
          ? null
          : (reasons.scale ?? reasons.cut ?? reasons.refresh),
      reasons,
      codes,
      // The anchor lineage describes the canonical commercial threshold, which
      // the Cut-only stop-loss overlay never replaces.
      anchor: canonicalEligibility.anchor ?? null,
    },
  };
}

/**
 * Resolves the physical-account AOV overlay against an immutable canonical
 * profile. All canonical thresholds, peer evidence, maturity, Scale, Refresh,
 * confidence and quality fields are retained byte-for-byte.
 */
export function applyCommercialStopLossAovAuthority(input: {
  profile: AccountDecisionProfile;
  targetPack: BusinessTargetPack | null;
  attributionAovAdjustmentMultiplier: number;
  shadowOnly: boolean;
  authority?: CommercialStopLossAovAuthorityInput | null;
}): AccountDecisionProfile {
  /*
    Derived from the profile's OWN `asOfDate`, not passed in and not read from
    a clock. The stop-loss overlay is the same point in time as the profile it
    overlays; deriving it here means a caller cannot hand this function a
    different cutoff than the one that built `input.profile`.
  */
  const asOfCutoffMs = deterministicCommercialCutoffMs(input.profile.asOfDate);
  const stopLossAov = input.authority;
  const validStopLossAov =
    stopLossAov !== null &&
    stopLossAov !== undefined &&
    positiveFinite(stopLossAov.meanAov) &&
    Number.isInteger(stopLossAov.purchaseCount) &&
    stopLossAov.purchaseCount >= NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR &&
    positiveFinite(stopLossAov.totalRevenue) &&
    isAccountAovRevenueArithmeticConsistent(stopLossAov);
  const commercialStopLossSpendUnit = validStopLossAov
    ? resolveSpendUnitProfile({
        asOfCutoffMs,
        targetPack: input.targetPack,
        accountBaselines: {
          ...input.profile.accountBaselines,
          metaAttributedAovMean90d: stopLossAov.meanAov,
          metaAttributedAovPurchaseCount90d: stopLossAov.purchaseCount,
          metaAttributedRevenue90d: stopLossAov.totalRevenue,
          metaAovQuality: "ready",
        },
        attributionAovAdjustmentMultiplier:
          input.attributionAovAdjustmentMultiplier,
      })
    : null;
  const commercialStopLossThresholds = commercialStopLossSpendUnit
    ? buildEngineThresholds({
        spendUnit: commercialStopLossSpendUnit.spendUnit,
        multipliers: input.profile.multipliers,
        accountBaselines: input.profile.accountBaselines,
      })
    : null;
  const commercialStopLossEligibility = commercialStopLossSpendUnit
    ? resolveHardActionEligibility({
        asOfCutoffMs,
        spendUnitProfile: commercialStopLossSpendUnit,
        targetPack: input.targetPack,
        metaAovQuality: "ready",
        calibrationReady:
          input.profile.accountBaselines.matureCreativeCount >=
          MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
        shadowOnly: input.shadowOnly,
      })
    : input.profile.hardActionEligibility;
  return applyCutOnlyCommercialStopLossProfile({
    baseProfile: input.profile,
    commercialStopLossSpendUnit,
    commercialStopLossThresholds,
    commercialStopLossEligibility,
  });
}

function withAovFallback(input: {
  calibration: AccountCalibration;
  fallback: AccountCalibration;
}): AccountCalibration {
  const purchaseCount =
    input.calibration.metaAttributedAovPurchaseCount90d ||
    input.fallback.metaAttributedAovPurchaseCount90d;
  return {
    ...input.calibration,
    metaAttributedAovMean90d:
      input.calibration.metaAttributedAovMean90d ??
      input.fallback.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d: purchaseCount,
    metaAttributedRevenue90d:
      input.calibration.metaAttributedRevenue90d ||
      input.fallback.metaAttributedRevenue90d,
    metaAovQuality:
      input.calibration.metaAovQuality !== "unavailable"
        ? input.calibration.metaAovQuality
        : classifyMetaAovQuality(purchaseCount),
  };
}

export async function resolveAccountDecisionProfile(input: {
  businessId: string;
  asOf: string;
  dataSource: CreativeDecisionDataSource;
  flags?: EngineV3Flags;
  campaignId?: string;
  commercialStopLossAovAuthority?: CommercialStopLossAovAuthorityInput | null;
  /**
   * Observed store AOV, resolved by the caller so this function keeps doing no
   * IO of its own. Absent means the structure path resolves the spend unit
   * exactly as it did before this source existed.
   */
  observedShopifyAov?: ObservedShopifyAovEvidence | null;
}): Promise<AccountDecisionProfile> {
  const targetPack = await input.dataSource.getBusinessTargetPack({
    businessId: input.businessId,
    asOf: input.asOf,
  });
  const commercialTruthFreshness = targetPack?.freshness ?? "unknown";
  const profileConfig = await input.dataSource.getDecisionCalibrationProfile({
    businessId: input.businessId,
    channel: "meta",
    objectiveFamily: "sales",
  });
  const accountCalibration = await input.dataSource.getAccountCalibration({
    businessId: input.businessId,
    asOf: input.asOf,
  });
  const funnelCalibration = await input.dataSource.getAccountFunnelCalibration({
    businessId: input.businessId,
    asOf: input.asOf,
  });
  const accountBaselinesByKindPromise = input.dataSource
    .getAccountCalibrationAllKinds
    ? input.dataSource
        .getAccountCalibrationAllKinds({
          businessId: input.businessId,
          asOf: input.asOf,
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  const funnelCalibrationByKindPromise = input.dataSource
    .getAccountFunnelCalibrationAllKinds
    ? input.dataSource
        .getAccountFunnelCalibrationAllKinds({
          businessId: input.businessId,
          asOf: input.asOf,
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  const [accountBaselinesByKind, funnelCalibrationByKind] = await Promise.all([
    accountBaselinesByKindPromise,
    funnelCalibrationByKindPromise,
  ]);

  const needsLiveMetaAov =
    accountCalibration.metaAttributedAovMean90d === null ||
    accountCalibration.metaAttributedAovPurchaseCount90d === 0;
  const liveMetaAov = needsLiveMetaAov
    ? await input.dataSource
        .getMetaAttributedAov({
          businessId: input.businessId,
          asOf: input.asOf,
          windowDays: 90,
        })
        .catch(() => null)
    : null;

  const metaAttributedAovMean90d =
    accountCalibration.metaAttributedAovMean90d ?? liveMetaAov?.aovMean ?? null;
  const metaAttributedAovPurchaseCount90d =
    accountCalibration.metaAttributedAovPurchaseCount90d ||
    liveMetaAov?.purchaseCount ||
    0;
  const metaAttributedRevenue90d =
    accountCalibration.metaAttributedRevenue90d ||
    liveMetaAov?.totalRevenue ||
    0;
  const metaAovQuality =
    accountCalibration.metaAovQuality !== "unavailable"
      ? accountCalibration.metaAovQuality
      : classifyMetaAovQuality(metaAttributedAovPurchaseCount90d);

  const accountBaselinesWithAov: AccountCalibration = {
    ...accountCalibration,
    metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d,
    metaAovQuality,
  };
  const resolvedAccountBaselinesByKind = accountBaselinesByKind
    ? CALIBRATION_CAMPAIGN_KINDS.reduce<
        Record<CalibrationCampaignKind, AccountCalibration | null>
      >((acc, campaignKind) => {
        const calibration = accountBaselinesByKind[campaignKind];
        acc[campaignKind] = calibration
          ? withAovFallback({
              calibration,
              fallback: accountBaselinesWithAov,
            })
          : null;
        return acc;
      }, emptyByKind<AccountCalibration>())
    : undefined;
  const scopedCalibration = await resolveScopedCalibration({
    businessId: input.businessId,
    asOf: input.asOf,
    campaignId: input.campaignId,
    dataSource: input.dataSource,
    accountBaselines: accountBaselinesWithAov,
  });
  const accountBaselines = scopedCalibration.accountBaselines;

  const attributionAovAdjustmentMultiplier = overrideMultiplier(
    1.0,
    profileConfig?.attributionAovAdjustmentMultiplier,
  );
  /*
    ── ROUND 9 ITEM 2: ONE DETERMINISTIC CUTOFF FOR THE WHOLE PROFILE ────────

    Derived from `input.asOf` and from nothing else — never `new Date()`. Every
    spend-unit and eligibility resolution below (canonical, per-campaign-kind,
    and the stop-loss overlay) receives THIS value, so the canonical profile and
    a per-kind profile cannot disagree about which target pack was in force.

    `asOfCutoffMs` is required on both callees rather than optional, which is
    why adding it surfaced all six call sites at compile time instead of
    leaving one silently on the old behaviour.
  */
  const asOfCutoffMs = deterministicCommercialCutoffMs(input.asOf);
  const canonicalSpendUnitProfile = resolveSpendUnitProfile({
    asOfCutoffMs,
    targetPack,
    accountBaselines,
    observedShopifyAov: input.observedShopifyAov ?? null,
    attributionAovAdjustmentMultiplier,
  });
  const flags = input.flags ?? (await resolveEngineV3Flags(input.businessId));

  const { preset, presetSource } = resolvePreset({
    targetPack,
    profileConfig,
    presetOverride: flags.presetOverride ?? null,
  });
  const multipliers = mergeMultipliers({ preset, profileConfig });
  const thresholds = buildEngineThresholds({
    spendUnit: canonicalSpendUnitProfile.spendUnit,
    multipliers,
    accountBaselines,
  });
  const canonicalHardActionEligibility = resolveHardActionEligibility({
    asOfCutoffMs,
    spendUnitProfile: canonicalSpendUnitProfile,
    targetPack,
    metaAovQuality,
    calibrationReady:
      accountBaselines.matureCreativeCount >=
      MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
    shadowOnly: flags.shadowOnly,
    attributionAovAdjustmentMultiplier,
  });
  const spendUnitByKind =
    resolvedAccountBaselinesByKind === undefined
      ? undefined
      : emptyByKind<SpendUnitProfile>();
  const thresholdsByKind =
    resolvedAccountBaselinesByKind === undefined
      ? undefined
      : emptyByKind<EngineThresholdSet>();
  const hardActionEligibilityByKind =
    resolvedAccountBaselinesByKind === undefined
      ? undefined
      : emptyByKind<HardActionEligibility>();

  if (
    resolvedAccountBaselinesByKind !== undefined &&
    spendUnitByKind !== undefined &&
    thresholdsByKind !== undefined &&
    hardActionEligibilityByKind !== undefined
  ) {
    for (const campaignKind of CALIBRATION_CAMPAIGN_KINDS) {
      const calibration =
        campaignKind === "all"
          ? accountBaselines
          : resolvedAccountBaselinesByKind[campaignKind];
      if (calibration === null) continue;
      const spendUnitProfile = resolveSpendUnitProfile({
        asOfCutoffMs,
        targetPack,
        accountBaselines: calibration,
        attributionAovAdjustmentMultiplier,
      });
      spendUnitByKind[campaignKind] = spendUnitProfile;
      thresholdsByKind[campaignKind] = buildEngineThresholds({
        spendUnit: spendUnitProfile.spendUnit,
        multipliers,
        accountBaselines: calibration,
      });
      hardActionEligibilityByKind[campaignKind] = resolveHardActionEligibility({
        asOfCutoffMs,
        spendUnitProfile,
        targetPack,
        metaAovQuality: calibration.metaAovQuality,
        calibrationReady:
          calibration.matureCreativeCount >=
          MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
        shadowOnly: flags.shadowOnly,
      });
    }
  }

  return applyCommercialStopLossAovAuthority({
    profile: {
      businessId: input.businessId,
      asOfDate: input.asOf,
      channel: "meta",
      objectiveFamily: "sales",
      preset,
      presetSource,
      spendUnit: canonicalSpendUnitProfile.spendUnit,
      spendUnitSource: canonicalSpendUnitProfile.spendUnitSource,
      spendUnitConfidence: canonicalSpendUnitProfile.spendUnitConfidence,
      spendUnitEvidence: canonicalSpendUnitProfile.spendUnitEvidence,
      multipliers,
      thresholds,
      commercialStopLossSpendUnit: null,
      commercialStopLossThresholds: null,
      accountBaselines,
      funnelCalibration,
      accountBaselinesByKind: resolvedAccountBaselinesByKind,
      spendUnitByKind,
      thresholdsByKind,
      hardActionEligibilityByKind,
      funnelCalibrationByKind,
      scope: scopedCalibration.scope,
      hardActionEligibility: canonicalHardActionEligibility,
      quality: {
        /*
          Break-even is no longer part of "commercial truth is ready".

          This flag gates target-relative decision copy and downstream
          readiness reporting, and it read as false for every account that
          configures only a Target ROAS — the shape this product asks for.
          The required inputs are a trustworthy freshness stamp and a valid
          Target ROAS; the money-per-purchase unit comes from the Meta
          platform AOV, not from a second operator-typed ratio.
        */
        commercialTruthReady:
          commercialTruthFreshness !== "unknown" &&
          positiveFinite(targetPack?.targetRoas ?? null),
        commercialTruthFreshness,
        calibrationReady:
          accountBaselines.matureCreativeCount >=
          MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
        metaAovQuality,
        thresholdQuality: resolveThresholdQuality({
          spendUnit: canonicalSpendUnitProfile.spendUnit,
          confidence: canonicalSpendUnitProfile.spendUnitConfidence,
        }),
      },
    },
    targetPack,
    attributionAovAdjustmentMultiplier,
    shadowOnly: flags.shadowOnly,
    authority: input.commercialStopLossAovAuthority,
  });
}

async function resolveScopedCalibration(input: {
  businessId: string;
  asOf: string;
  campaignId?: string;
  dataSource: CreativeDecisionDataSource;
  accountBaselines: AccountCalibration;
}): Promise<{
  accountBaselines: AccountCalibration;
  scope: DecisionProfileScope;
}> {
  const campaignId = input.campaignId?.trim();
  if (!campaignId) {
    return {
      accountBaselines: input.accountBaselines,
      scope: { type: "account", id: "*" },
    };
  }

  const campaignLookup: CampaignCalibrationLookup =
    await input.dataSource.getCampaignCalibration({
      businessId: input.businessId,
      asOf: input.asOf,
      campaignId,
    });
  const campaignMatureCount =
    campaignLookup.calibration?.matureCreativeCount ??
    campaignLookup.matureCreativeCount;

  if (
    campaignMatureCount !== null &&
    campaignMatureCount < MIN_CAMPAIGN_CALIBRATION_SAMPLE
  ) {
    return {
      accountBaselines: input.accountBaselines,
      scope: {
        type: "account",
        id: "*",
        fallbackReason: "campaign_sample_below_threshold",
      },
    };
  }

  if (campaignLookup.calibration === null) {
    return {
      accountBaselines: input.accountBaselines,
      scope: {
        type: "account",
        id: "*",
        fallbackReason: "campaign_calibration_missing",
      },
    };
  }

  return {
    accountBaselines: {
      ...input.accountBaselines,
      roasRatioP10: campaignLookup.calibration.roasRatioP10,
      roasRatioP25: campaignLookup.calibration.roasRatioP25,
      roasRatioP50: campaignLookup.calibration.roasRatioP50,
      roasRatioP75: campaignLookup.calibration.roasRatioP75,
    },
    scope: { type: "campaign", id: campaignId },
  };
}
