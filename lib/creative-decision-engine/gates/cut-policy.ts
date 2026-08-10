import {
  CUT_BOUNDARY_RATIO_CLAMP,
  UNCALIBRATED_CUT_RATIO_FALLBACK,
  ZERO_CONV_MIN_AGE_DAYS,
} from "../config-values";
import type { AccountDecisionProfile, EngineThresholdSet } from "../types";
import type { GateContext } from "./types";

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export interface CutBoundaryResolution {
  /** Legacy P25/fallback boundary before explicit break-even is applied. */
  legacyRatio: number;
  /** Safe legacy boundary. Existing D049/D060 behavior lives below this. */
  ratio: number;
  mode:
    "account_p25" | "breakeven_ceiling" | "uncalibrated_commercial_stop_loss";
  accountP25: number | null;
  breakevenRatio: number | null;
  /** Strict upper bound of the bounded D063 economic-loss strip. */
  economicUpperRatio: number | null;
}

/** Canonical economic Cut boundary. Account-AOV never changes ratio math. */
export function resolveCutBoundary(ctx: GateContext): CutBoundaryResolution {
  const configuredAccountP25 = ctx.profile.thresholds.bottomQuartileRatio;
  const accountP25 = positiveFinite(configuredAccountP25)
    ? configuredAccountP25
    : null;
  const currentRatio = Math.min(
    accountP25 ?? UNCALIBRATED_CUT_RATIO_FALLBACK,
    CUT_BOUNDARY_RATIO_CLAMP,
  );
  const breakEvenRoas = ctx.profile.spendUnitEvidence.breakEvenRoas;
  const canUseBreakevenCeiling =
    ctx.truthSource === "commercial_truth" &&
    positiveFinite(breakEvenRoas) &&
    positiveFinite(ctx.effectiveTargetRoas);

  if (!canUseBreakevenCeiling) {
    return {
      legacyRatio: currentRatio,
      ratio: currentRatio,
      mode: "account_p25",
      accountP25,
      breakevenRatio: null,
      economicUpperRatio: null,
    };
  }

  const breakevenRatio = breakEvenRoas / ctx.effectiveTargetRoas;
  const economicUpperRatio = Math.min(breakevenRatio, CUT_BOUNDARY_RATIO_CLAMP);
  const ratio = Math.min(currentRatio, economicUpperRatio);
  return {
    legacyRatio: currentRatio,
    ratio,
    mode:
      accountP25 === null
        ? "uncalibrated_commercial_stop_loss"
        : ratio < currentRatio
          ? "breakeven_ceiling"
          : "account_p25",
    accountP25,
    breakevenRatio,
    economicUpperRatio,
  };
}

export type CanonicalCutZone = "legacy_safe_loss" | "expanded_economic_loss";

/**
 * D063 owns only the bounded strip between a lower P25/fallback and explicit
 * break-even. The safe legacy region deliberately keeps the prior boundary.
 */
export function resolveCanonicalCutZoneGeometry(
  ctx: GateContext,
): CanonicalCutZone | null {
  const ratio = ctx.ratioToTarget;
  if (
    ctx.truthSource !== "commercial_truth" ||
    ratio === null ||
    !Number.isFinite(ratio) ||
    !isBelowExplicitBreakEven(ctx)
  ) {
    return null;
  }

  const boundary = resolveCutBoundary(ctx);
  if (ratio < boundary.ratio) {
    return "legacy_safe_loss";
  }

  return boundary.economicUpperRatio !== null &&
    boundary.economicUpperRatio > boundary.legacyRatio &&
    ratio >= boundary.legacyRatio &&
    ratio < boundary.economicUpperRatio
    ? "expanded_economic_loss"
    : null;
}

export function resolveCanonicalCutZone(
  ctx: GateContext,
): CanonicalCutZone | null {
  const zone = resolveCanonicalCutZoneGeometry(ctx);
  if (zone === null || !ctx.profile.hardActionEligibility.cut) {
    return null;
  }
  return zone === "expanded_economic_loss" &&
    ctx.profile.expandedEconomicCutAuthority?.eligible === false
    ? null
    : zone;
}

export function hasExplicitBreakEven(ctx: GateContext): boolean {
  return positiveFinite(ctx.profile.spendUnitEvidence.breakEvenRoas);
}

export function isBelowExplicitBreakEven(ctx: GateContext): boolean {
  const breakEvenRoas = ctx.profile.spendUnitEvidence.breakEvenRoas;
  return (
    hasExplicitBreakEven(ctx) &&
    ctx.input.roas !== null &&
    Number.isFinite(ctx.input.roas) &&
    ctx.input.roas < (breakEvenRoas as number)
  );
}

/**
 * Shared final economic zone predicate. It deliberately uses the canonical
 * ratio boundary; physical account AOV may repair spend depth, never move the
 * ROAS boundary.
 */
export function isCanonicalFinalCutZone(ctx: GateContext): boolean {
  return resolveCanonicalCutZone(ctx) !== null;
}

function hasCommercialStopLossCutRepair(
  profile: AccountDecisionProfile,
): boolean {
  const canonical = profile.commercialStopLossCanonicalHardActionEligibility;
  return (
    profile.commercialStopLossSpendUnit != null &&
    profile.commercialStopLossThresholds != null &&
    canonical != null &&
    !canonical.cut &&
    profile.hardActionEligibility.cut
  );
}

/**
 * Only Cut-producing spend fields are eligible for the repair. When canonical
 * Cut eligibility is false, its spend thresholds are not authority and cannot
 * be reintroduced through a minimum. The trusted physical-account AOV view
 * owns every repaired Cut spend floor, whether that floor is lower or higher.
 * Recovery, Scale, Refresh, and ratio fields stay canonical.
 */
function commercialStopLossRepairThresholds(
  profile: AccountDecisionProfile,
): EngineThresholdSet {
  const canonical = profile.thresholds;
  const overlay = profile.commercialStopLossThresholds;
  if (overlay == null) return canonical;
  return {
    ...canonical,
    zeroConvBurnerSpend: overlay.zeroConvBurnerSpend,
    cutCandidateSpend: overlay.cutCandidateSpend,
    sustainedLoserSpend: overlay.sustainedLoserSpend,
    commercialMaturitySpend: overlay.commercialMaturitySpend,
    hardCutSpend: overlay.hardCutSpend,
    // This value is also the lower bound inside loss-budget maturity math.
    // Recovery itself still reads the canonical value explicitly below.
    recentSampleMinSpend: overlay.recentSampleMinSpend,
  };
}

export function maturitySpendThresholdFor(
  ctx: GateContext,
  thresholds: EngineThresholdSet,
): number {
  const minSpendFloor = thresholds.recentSampleMinSpend ?? 50;
  const configuredThreshold = thresholds.commercialMaturitySpend;
  if (positiveFinite(configuredThreshold)) {
    return Math.max(minSpendFloor, configuredThreshold);
  }

  const accountCpaP50 =
    ctx.profile.accountBaselines.accountCpaP50 ??
    ctx.profile.spendUnitEvidence.accountCpaP50;
  if (positiveFinite(accountCpaP50)) {
    return Math.max(
      minSpendFloor,
      accountCpaP50 * ctx.profile.multipliers.lossBudget,
    );
  }
  if (positiveFinite(thresholds.sustainedLoserSpend)) {
    return Math.max(minSpendFloor, thresholds.sustainedLoserSpend);
  }
  return (
    ctx.profile.accountBaselines.matureSpendP50 ??
    thresholds.recentSampleMinSpend ??
    300
  );
}

export function hasCanonicalRecentRecovery(ctx: GateContext): boolean {
  const recentSpend = ctx.input.recent7dSpend;
  const recentRoas = ctx.input.recent7dRoas;
  const recentSpendThreshold = ctx.profile.thresholds.recentSampleMinSpend;
  return (
    recentSpend !== null &&
    recentRoas !== null &&
    recentSpendThreshold !== null &&
    recentSpend >= recentSpendThreshold &&
    recentRoas > ctx.effectiveTargetRoas
  );
}

export type ExpandedEconomicRecentEvidence =
  | {
      status: "confirmed_loss";
      recentSpend: number;
      recentRoas: number;
      recentSpendThreshold: number;
      breakEvenRoas: number;
    }
  | {
      status: "recovery";
      recentSpend: number;
      recentRoas: number;
      recentSpendThreshold: number;
      breakEvenRoas: number;
    }
  | {
      status: "unverifiable" | "thin";
      missingRecentData: boolean;
      recentSpend: number | null;
      recentRoas: number | null;
      recentSpendThreshold: number | null;
      breakEvenRoas: number | null;
    };

/**
 * Recent confirmation for the D063-only economic strip. Account-AOV overlay
 * thresholds are intentionally ignored; recent proof stays canonical.
 */
export function resolveExpandedEconomicRecentEvidence(
  ctx: GateContext,
): ExpandedEconomicRecentEvidence {
  const recentSpend = ctx.input.recent7dSpend;
  const recentRoas = ctx.input.recent7dRoas;
  const recentSpendThreshold = ctx.profile.thresholds.recentSampleMinSpend;
  const breakEvenRoas = ctx.profile.spendUnitEvidence.breakEvenRoas;

  if (
    recentSpend === null ||
    !Number.isFinite(recentSpend) ||
    recentSpend < 0 ||
    recentRoas === null ||
    !Number.isFinite(recentRoas) ||
    recentRoas < 0 ||
    !positiveFinite(recentSpendThreshold) ||
    !positiveFinite(breakEvenRoas)
  ) {
    return {
      status: "unverifiable",
      missingRecentData:
        recentSpend === null ||
        !Number.isFinite(recentSpend) ||
        recentSpend < 0 ||
        recentRoas === null ||
        !Number.isFinite(recentRoas) ||
        recentRoas < 0,
      recentSpend:
        recentSpend !== null && Number.isFinite(recentSpend)
          ? recentSpend
          : null,
      recentRoas:
        recentRoas !== null && Number.isFinite(recentRoas) ? recentRoas : null,
      recentSpendThreshold: positiveFinite(recentSpendThreshold)
        ? recentSpendThreshold
        : null,
      breakEvenRoas: positiveFinite(breakEvenRoas) ? breakEvenRoas : null,
    };
  }

  if (recentSpend < recentSpendThreshold) {
    return {
      status: "thin",
      missingRecentData: false,
      recentSpend,
      recentRoas,
      recentSpendThreshold,
      breakEvenRoas,
    };
  }

  return {
    status: recentRoas >= breakEvenRoas ? "recovery" : "confirmed_loss",
    recentSpend,
    recentRoas,
    recentSpendThreshold,
    breakEvenRoas,
  };
}

export interface ZeroConversionCutMatch {
  spendThreshold: number;
}

/** Shared zero-conversion Cut predicate used by the gate and repair resolver. */
export function resolveZeroConversionCutMatch(
  ctx: GateContext,
  thresholds: EngineThresholdSet,
): ZeroConversionCutMatch | null {
  if (hasExplicitBreakEven(ctx) && !isBelowExplicitBreakEven(ctx)) {
    return null;
  }
  const maturitySpend = maturitySpendThresholdFor(ctx, thresholds);
  const zeroConvSpend = thresholds.zeroConvBurnerSpend ?? maturitySpend;
  const spendThreshold = Math.max(zeroConvSpend, maturitySpend);
  return ctx.input.effectiveStatus === "ACTIVE" &&
    (ctx.input.purchases ?? 0) === 0 &&
    ctx.input.spend >= spendThreshold &&
    (ctx.input.ageDays ?? 0) >= ZERO_CONV_MIN_AGE_DAYS
    ? { spendThreshold }
    : null;
}

export interface SevereMaturityCutMatch {
  hardCutSpend: number;
  severeLoserRatio: number;
}

/** Shared young/thin severe-loss Cut predicate. */
export function resolveSevereMaturityCutMatch(
  ctx: GateContext,
  thresholds: EngineThresholdSet,
): SevereMaturityCutMatch | null {
  const ratio = ctx.ratioToTarget;
  const hardCutSpend = thresholds.hardCutSpend;
  const severeLoserRatio = ctx.profile.thresholds.severeLoserRatio;
  return ratio !== null &&
    ctx.input.roas !== null &&
    hardCutSpend !== null &&
    severeLoserRatio !== null &&
    ctx.input.spend >= hardCutSpend &&
    ratio < severeLoserRatio
    ? { hardCutSpend, severeLoserRatio }
    : null;
}

export type RatioZoneCutMatch =
  | { kind: "hard_cut"; hardCutSpend: number }
  | {
      kind: "sustained_loser";
      sustainedLoserSpend: number;
      severeLoserRatio: number;
    }
  | { kind: "loss_budget_maturity"; commercialMaturitySpend: number };

/**
 * Shared spend-depth resolver for the canonical ratio Cut branch. The caller
 * owns ratio-zone membership; this function owns the ordered Cut predicates.
 */
export function resolveRatioZoneCutMaturityMatch(
  ctx: GateContext,
  thresholds: EngineThresholdSet,
): RatioZoneCutMatch | null {
  const hardCutSpend = thresholds.hardCutSpend;
  if (hardCutSpend !== null && ctx.input.spend >= hardCutSpend) {
    return { kind: "hard_cut", hardCutSpend };
  }

  const ratio = ctx.ratioToTarget;
  const sustainedLoserSpend = thresholds.sustainedLoserSpend;
  const severeLoserRatio = ctx.profile.thresholds.severeLoserRatio;
  if (
    ratio !== null &&
    sustainedLoserSpend !== null &&
    severeLoserRatio !== null &&
    ctx.input.spend >= sustainedLoserSpend &&
    ratio < severeLoserRatio
  ) {
    return {
      kind: "sustained_loser",
      sustainedLoserSpend,
      severeLoserRatio,
    };
  }

  const commercialMaturitySpend = maturitySpendThresholdFor(ctx, thresholds);
  return ctx.input.spend >= commercialMaturitySpend
    ? { kind: "loss_budget_maturity", commercialMaturitySpend }
    : null;
}

export function resolveRatioZoneCutMatch(
  ctx: GateContext,
  thresholds: EngineThresholdSet,
): RatioZoneCutMatch | null {
  if (hasCanonicalRecentRecovery(ctx)) return null;
  return resolveRatioZoneCutMaturityMatch(ctx, thresholds);
}

/**
 * Predicts whether enabling the physical-account AOV repair changes this row into an
 * actual raw Cut in the remaining canonical gate order. If not, the engine
 * restores the immutable canonical authority before continuing, which makes
 * every non-Cut action/reason/badge identical to the no-overlay result.
 */
export function shouldActivateCommercialStopLossCutRepair(
  ctx: GateContext,
): boolean {
  const boundary = resolveCutBoundary(ctx);
  const zone = resolveCanonicalCutZone(ctx);
  if (
    !hasCommercialStopLossCutRepair(ctx.profile) ||
    zone === null ||
    // D061 may repair only a P25-null exact cell. Peer-backed authority must
    // never consume the account-AOV overlay, including in the D063 strip.
    boundary.accountP25 !== null
  ) {
    return false;
  }

  const thresholds = commercialStopLossRepairThresholds(ctx.profile);
  if (zone === "expanded_economic_loss") {
    const recentEvidence = resolveExpandedEconomicRecentEvidence(ctx);
    return (
      // D063 owns the final recent-evidence decision. A trusted account-AOV
      // repair must remain active for missing/thin evidence so the canonical
      // gate can retain the raw Cut provenance and emit its explicit held-Cut
      // tuple. Only confirmed recovery restores the immutable baseline.
      recentEvidence.status !== "recovery" &&
      resolveRatioZoneCutMaturityMatch(ctx, thresholds) !== null
    );
  }

  const maturitySpend = maturitySpendThresholdFor(ctx, thresholds);
  if (resolveZeroConversionCutMatch(ctx, thresholds) !== null) {
    return true;
  }

  if (ctx.input.spend < maturitySpend) {
    return resolveSevereMaturityCutMatch(ctx, thresholds) !== null;
  }
  return resolveRatioZoneCutMatch(ctx, thresholds) !== null;
}

export function retainCommercialStopLossRepairOnlyForFinalCut(
  ctx: GateContext,
): GateContext {
  const canonical =
    ctx.profile.commercialStopLossCanonicalHardActionEligibility;
  if (canonical == null || shouldActivateCommercialStopLossCutRepair(ctx)) {
    return ctx;
  }
  return {
    ...ctx,
    profile: {
      ...ctx.profile,
      hardActionEligibility: canonical,
    },
  };
}

export function effectiveCommercialStopLossThresholds(
  ctx: GateContext,
): EngineThresholdSet {
  return hasCommercialStopLossCutRepair(ctx.profile)
    ? commercialStopLossRepairThresholds(ctx.profile)
    : ctx.profile.thresholds;
}
