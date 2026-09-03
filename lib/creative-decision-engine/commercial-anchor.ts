/**
 * Commercial spend-unit anchor explainability (slice: anchor capture +
 * eligibility explainability).
 *
 * The engine already decides hard-action eligibility correctly and
 * fail-closed: an explicit Target CPA, or an operator AOV assumption together
 * with a Target ROAS, is high-confidence; a sufficiently sampled
 * Meta-attributed AOV is medium and eligible only when the sample is `ready`;
 * account history and the break-even fallback are never hard-action eligible.
 * That policy is NOT changed here.
 *
 * What was missing is a stable machine-readable answer to "why is this
 * withheld, and what exactly would unblock it". The only signal the profile
 * produced was one prose string —
 * `threshold baseline account_history has low confidence (meta AOV ready)` —
 * which cannot distinguish "the owner never supplied an economic anchor" from
 * "the anchor exists but its provenance is unverifiable". Operators cannot act
 * on that, and no surface can key copy off it safely.
 *
 * This module derives a discriminated taxonomy from exactly the same
 * predicates the eligibility resolver uses, so the codes can never disagree
 * with the booleans. It reads inputs only; it decides nothing new.
 */
import type {
  CommercialTargetFreshness,
  MetaAovQuality,
  SpendUnitConfidence,
  SpendUnitSource,
} from "./types";

export const COMMERCIAL_ANCHOR_CONTRACT_VERSION =
  "creative-decision-engine.commercial-anchor.v1" as const;

/** Why the commercial-threshold gate withholds a hard action. Stable wire
 * value: surfaces key copy off this, never off the prose reason. */
export type CommercialAnchorBlockerCode =
  /** The account is shadow-only; no hard action is offered at all. */
  | "shadow_only"
  /** No owner-supplied economic anchor exists and no usable Meta-derived AOV
   * stands in for one. This is the "missing owner input" case. */
  | "commercial_anchor_missing"
  /** A Meta-derived AOV is the only available anchor and its 90-day purchase
   * sample is below the `ready` bar. */
  | "commercial_anchor_sample_insufficient"
  /** A target pack exists and supplies a commercial threshold, but its
   * timestamp provenance cannot be trusted, so it is demoted. */
  | "commercial_anchor_provenance_unverified"
  /** The anchor is fine; Scale additionally needs an explicit Target ROAS. */
  | "target_roas_missing"
  /** The anchor is fine; Cut additionally needs an explicit break-even ROAS. */
  | "break_even_roas_missing"
  /** The anchor is fine; Scale additionally needs a calibration sample. */
  | "scale_calibration_below_floor";

/** Owner-supplied (or sampled) inputs that can establish a trusted anchor. */
export type CommercialAnchorInputCode =
  | "target_cpa"
  | "operator_aov_assumption"
  | "target_roas"
  | "break_even_roas"
  | "meta_attributed_purchase_sample"
  | "commercial_target_provenance";

export type CommercialAnchorStatus =
  | "eligible_target_cpa"
  | "eligible_operator_aov"
  | "eligible_meta_derived_aov"
  | "blocked_missing_owner_anchor"
  | "blocked_meta_aov_sample_insufficient"
  | "blocked_provenance_unverified"
  | "blocked_shadow_only";

export type CommercialAnchorAction = "scale" | "cut" | "refresh";

export interface CommercialAnchorActionExplanation {
  eligible: boolean;
  blockerCode: CommercialAnchorBlockerCode | null;
  /** Operator-facing sentence. Derived from the code, never parsed by code. */
  operatorCopy: string | null;
}

export interface CommercialAnchorLineage {
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  /** The sampled Meta-attributed AOV rung and the sample behind it. */
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  /** Scales the Meta-derived spend unit; null when not supplied. */
  attributionAovAdjustmentMultiplier: number | null;
  /** The account-history rung, which is never hard-action eligible on its own. */
  accountCpaP50?: number | null;
  accountCpaSampleCount?: number;
}

export interface CommercialAnchorExplanation {
  contractVersion: typeof COMMERCIAL_ANCHOR_CONTRACT_VERSION;
  status: CommercialAnchorStatus;
  /** True only when the commercial threshold gate itself is satisfied. Per
   * action eligibility can still be false for an independent reason. */
  thresholdEligible: boolean;
  spendUnit: number | null;
  spendUnitSource: SpendUnitSource;
  spendUnitConfidence: SpendUnitConfidence;
  /** Business currency for `spendUnit`, when the serving layer knows it.
   * Null renders as "account currency"; it must never default to USD. */
  currency: string | null;
  targetPackFreshness: CommercialTargetFreshness | null;
  targetPackUpdatedAt: string | null;
  metaAovQuality: MetaAovQuality;
  lineage: CommercialAnchorLineage;
  /** Exactly what to supply, in the order that would unblock fastest.
   * Empty when the threshold gate is satisfied. */
  missingInputs: CommercialAnchorInputCode[];
  actions: Record<CommercialAnchorAction, CommercialAnchorActionExplanation>;
}

const BLOCKER_COPY: Record<CommercialAnchorBlockerCode, string> = {
  shadow_only:
    "This account is in shadow mode, so no hard action is offered.",
  commercial_anchor_missing:
    "No commercial anchor is configured. Set a Target CPA, or an average order value assumption together with a Target ROAS, in Commercial Truth.",
  commercial_anchor_sample_insufficient:
    "The only available anchor is a Meta-attributed average order value whose 90-day purchase sample is too small to trust. Set an explicit Target CPA or average order value assumption instead of waiting for the sample to grow.",
  commercial_anchor_provenance_unverified:
    "The configured commercial target has no verifiable update timestamp, so it cannot carry threshold authority. Re-save it in Commercial Truth to stamp its provenance.",
  target_roas_missing:
    "Scale needs an explicit Target ROAS in Commercial Truth.",
  break_even_roas_missing:
    "Cut needs an explicit break-even ROAS in Commercial Truth.",
  scale_calibration_below_floor:
    "Scale is withheld because the account calibration sample is below the quality floor.",
};

export function describeCommercialAnchorBlocker(
  code: CommercialAnchorBlockerCode,
): string {
  return BLOCKER_COPY[code];
}

function positiveFinite(value: number | null | undefined): value is number {
  return (
    value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
  );
}

/**
 * Derives the anchor status and the per-action blocker taxonomy.
 *
 * Every boolean this receives is computed by the eligibility resolver; nothing
 * here re-derives eligibility. `thresholdEligible`,
 * `provenanceUnverified`, `scaleAnchorEligible`, `cutAnchorEligible` and
 * `calibrationReady` are passed in precisely so the codes cannot drift from
 * the decision.
 */
export function resolveCommercialAnchorExplanation(input: {
  shadowOnly: boolean;
  thresholdEligible: boolean;
  provenanceUnverified: boolean;
  scaleAnchorEligible: boolean;
  cutAnchorEligible: boolean;
  calibrationReady: boolean;
  spendUnit: number | null;
  spendUnitSource: SpendUnitSource;
  spendUnitConfidence: SpendUnitConfidence;
  metaAovQuality: MetaAovQuality;
  currency?: string | null;
  targetPackFreshness?: CommercialTargetFreshness | null;
  targetPackUpdatedAt?: string | null;
  lineage: CommercialAnchorLineage;
}): CommercialAnchorExplanation {
  const status = resolveStatus(input);
  const anchorBlocker = anchorBlockerFor(status);
  const missingInputs = resolveMissingInputs({ status, lineage: input.lineage });

  // Shadow-only withholds every hard action outright, exactly as the
  // eligibility resolver's own short-circuit does; no anchor can override it.
  const scaleEligible =
    !input.shadowOnly &&
    input.thresholdEligible &&
    input.calibrationReady &&
    input.scaleAnchorEligible;
  const cutEligible =
    !input.shadowOnly && input.thresholdEligible && input.cutAnchorEligible;
  const refreshEligible = !input.shadowOnly && input.thresholdEligible;

  const scaleBlocker: CommercialAnchorBlockerCode | null = scaleEligible
    ? null
    : anchorBlocker !== null
      ? anchorBlocker
      : !input.scaleAnchorEligible
        ? "target_roas_missing"
        : "scale_calibration_below_floor";
  const cutBlocker: CommercialAnchorBlockerCode | null = cutEligible
    ? null
    : anchorBlocker !== null
      ? anchorBlocker
      : "break_even_roas_missing";
  const refreshBlocker: CommercialAnchorBlockerCode | null = refreshEligible
    ? null
    : anchorBlocker;

  return {
    contractVersion: COMMERCIAL_ANCHOR_CONTRACT_VERSION,
    status,
    thresholdEligible: input.thresholdEligible,
    spendUnit: input.spendUnit,
    spendUnitSource: input.spendUnitSource,
    spendUnitConfidence: input.spendUnitConfidence,
    currency: input.currency ?? null,
    targetPackFreshness: input.targetPackFreshness ?? null,
    targetPackUpdatedAt: input.targetPackUpdatedAt ?? null,
    metaAovQuality: input.metaAovQuality,
    lineage: input.lineage,
    missingInputs,
    actions: {
      scale: explainAction(scaleEligible, scaleBlocker),
      cut: explainAction(cutEligible, cutBlocker),
      refresh: explainAction(refreshEligible, refreshBlocker),
    },
  };
}

function explainAction(
  eligible: boolean,
  blockerCode: CommercialAnchorBlockerCode | null,
): CommercialAnchorActionExplanation {
  return {
    eligible,
    blockerCode,
    operatorCopy: blockerCode ? describeCommercialAnchorBlocker(blockerCode) : null,
  };
}

function resolveStatus(input: {
  shadowOnly: boolean;
  thresholdEligible: boolean;
  provenanceUnverified: boolean;
  spendUnitSource: SpendUnitSource;
  metaAovQuality: MetaAovQuality;
}): CommercialAnchorStatus {
  if (input.shadowOnly) return "blocked_shadow_only";
  if (input.thresholdEligible) {
    if (input.spendUnitSource === "target_cpa") return "eligible_target_cpa";
    if (input.spendUnitSource === "operator_aov") return "eligible_operator_aov";
    return "eligible_meta_derived_aov";
  }
  // Provenance demotion is reported ahead of the source, because re-saving the
  // existing target is a different (and cheaper) operator act than supplying a
  // new economic anchor.
  if (input.provenanceUnverified) return "blocked_provenance_unverified";
  // Keyed off the resolver's OWN chosen rung. `metaAovQuality` arrives from the
  // account calibration and can disagree with the resolution (a stored `ready`
  // label beside a purchase count the ladder judged unusable); trusting it here
  // let a real sample-insufficiency be reported as a missing owner anchor.
  if (input.spendUnitSource === "meta_derived_aov") {
    return "blocked_meta_aov_sample_insufficient";
  }
  return "blocked_missing_owner_anchor";
}

function anchorBlockerFor(
  status: CommercialAnchorStatus,
): CommercialAnchorBlockerCode | null {
  switch (status) {
    case "blocked_shadow_only":
      return "shadow_only";
    case "blocked_provenance_unverified":
      return "commercial_anchor_provenance_unverified";
    case "blocked_meta_aov_sample_insufficient":
      return "commercial_anchor_sample_insufficient";
    case "blocked_missing_owner_anchor":
      return "commercial_anchor_missing";
    default:
      return null;
  }
}

function resolveMissingInputs(input: {
  status: CommercialAnchorStatus;
  lineage: CommercialAnchorLineage;
}): CommercialAnchorInputCode[] {
  if (
    input.status === "eligible_target_cpa" ||
    input.status === "eligible_operator_aov" ||
    input.status === "eligible_meta_derived_aov" ||
    input.status === "blocked_shadow_only"
  ) {
    return [];
  }
  if (input.status === "blocked_provenance_unverified") {
    return ["commercial_target_provenance"];
  }
  const missing: CommercialAnchorInputCode[] = [];
  const { lineage } = input;
  if (!positiveFinite(lineage.targetCpa)) missing.push("target_cpa");
  if (!positiveFinite(lineage.operatorAovAssumption)) {
    missing.push("operator_aov_assumption");
  }
  // An operator AOV only becomes an anchor together with a Target ROAS, so a
  // present AOV with an absent Target ROAS must still name the ROAS.
  if (!positiveFinite(lineage.targetRoas)) missing.push("target_roas");
  if (input.status === "blocked_meta_aov_sample_insufficient") {
    missing.push("meta_attributed_purchase_sample");
  }
  return missing;
}
