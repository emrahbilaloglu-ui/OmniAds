import type { MetaCanonicalDecision, MetaDecisionConfigEvidence } from "./decisions-workspace-contract";
import {
  META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT,
  parseNativeManualCutAdvisoryProof,
  type NativeManualCutAdvisoryRefusal,
} from "@/lib/creative-decision-engine/native-manual-cut-advisory";
import { META_PURCHASE_INTENT_WINDOW_CONTRACT } from "@/lib/creative-decision-engine/native-ad-hydration-authority";

export const META_PURCHASE_CONTEXT_MANUAL_ADVISORY_CONTRACT =
  META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT;

/** A recorded recommendation, never a provider-write permission. */
export interface MetaManualCutAdvisory {
  advised: true;
  contractVersion: typeof META_PURCHASE_CONTEXT_MANUAL_ADVISORY_CONTRACT;
  basis: "peer_free_commercial_stop_loss";
  confidenceCap: "medium";
  authority: "none";
  economicDayCount: number;
  bracketedDays: number;
  pointObservedDays: number;
  historicalObjectiveUnverifiedDays: number;
}

/**
 * Read only the exact evaluation's structured proof. A badge or prose is not
 * proof, and an earlier epoch cannot acquire this recommendation at read time.
 * Source receipts are already parsed by the native reader; fail closed if
 * any current reference or economic-window manifest was refused there.
 */
export function readManualCutAdvisory(input: {
  value: unknown;
  purchaseIntentWindow: unknown;
  identity: {
    adId: string;
    providerAccountId: string;
    asOfDate: string;
    engineVersion: string;
    computedAt: string;
    targetRoas: number | null;
  };
  currentEpoch: boolean;
  activeHierarchy: boolean;
  rawLabel: string | null;
  publishedLabel: string;
  heldAction: string | null;
  authorityBlocker: string | null;
  authorizedAction: string | null;
  badgeCodes: readonly string[];
  config: MetaDecisionConfigEvidence | null;
}): MetaManualCutAdvisory | null {
  if (
    !input.currentEpoch || !input.activeHierarchy || input.rawLabel !== "cut" ||
    input.publishedLabel !== "cut" || input.heldAction !== "cut" ||
    input.authorizedAction !== null ||
    input.authorityBlocker !== "config_source_authority" ||
    input.badgeCodes.some((code) => [
      "pending_transition", "source_coverage_unverified", "purchase_evidence_unverified",
      "ad_metrics_unavailable", "stale_evidence", "unknown_freshness",
    ].includes(code))
  ) return null;
  const config = input.config;
  if (
    !config || config.verified !== false || config.currentObserved !== true || !config.lineageSupplied ||
    config.refusedFields.length > 0 || config.refs.length !== 4 ||
    !config.economicWindow || config.economicWindow.incoherentDayCount !== 0
  ) return null;
  if (["objective", "optimization_goal", "custom_event_type"].some((field) => {
    const ref = config.refs.find((candidate) => candidate.field === field);
    return !ref?.sourceSnapshotId || !ref.observedAt || !ref.fieldScopeHash ||
      ref.readiness === "none";
  })) return null;
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value) ||
    "computedAt" in input.value) return null;
  const proof = parseNativeManualCutAdvisoryProof({
    ...input.value, computedAt: input.identity.computedAt,
  });
  const identity = input.identity;
  if (
    !proof || !["engine-v3-canonical-ad-evaluation.v19", "engine-v3-canonical-ad-evaluation.v20"].includes(config.evaluationContractVersion) ||
    proof.adId !== identity.adId || proof.providerAccountId !== identity.providerAccountId ||
    proof.asOfDate !== identity.asOfDate || proof.engineVersion !== identity.engineVersion ||
    proof.commercialTargetRoas !== identity.targetRoas ||
    proof.receiptManifestHash !== config.economicWindow.manifestHash ||
    proof.pointObservedDays.some((day) => day.date > proof.asOfDate) ||
    config.economicWindow.economicDayCount !== proof.economicDayCount
  ) return null;
  const rawWindow = input.purchaseIntentWindow;
  if (!rawWindow || typeof rawWindow !== "object" || Array.isArray(rawWindow)) return null;
  const window = rawWindow as Record<string, unknown>;
  if (window.contractVersion !== META_PURCHASE_INTENT_WINDOW_CONTRACT ||
    window.unnamedDays !== 0 || window.economicDayCount !== proof.economicDayCount ||
    window.bracketedDays !== proof.bracketedDays ||
    window.pointObservedDays !== proof.pointObservedDays.length ||
    window.historicalObjectiveUnverifiedDays !== proof.historicalObjectiveUnverifiedDays ||
    window.historicalObjectiveVerifiedDays !== proof.economicDayCount - proof.historicalObjectiveUnverifiedDays ||
    !Array.isArray(window.pointObserved) || window.pointObserved.length !== proof.pointObservedDays.length
  ) return null;
  const dates = new Set<string>();
  for (const rawDay of window.pointObserved) {
    if (!rawDay || typeof rawDay !== "object" || Array.isArray(rawDay)) return null;
    const day = rawDay as Record<string, unknown>;
    const provenDay = proof.pointObservedDays.find((entry) => entry.date === day.date);
    if (!provenDay || dates.has(provenDay.date) ||
      day.spend !== provenDay.spend || day.revenue !== provenDay.revenue) return null;
    dates.add(provenDay.date);
  }
  return {
    advised: true,
    contractVersion: META_PURCHASE_CONTEXT_MANUAL_ADVISORY_CONTRACT,
    basis: "peer_free_commercial_stop_loss",
    confidenceCap: "medium",
    authority: "none",
    economicDayCount: proof.economicDayCount,
    bracketedDays: proof.bracketedDays,
    pointObservedDays: proof.pointObservedDays.length,
    historicalObjectiveUnverifiedDays: proof.historicalObjectiveUnverifiedDays,
  };
}

export function manualCutAdvisoryNextStep(advice: MetaManualCutAdvisory): string {
  const observation = advice.pointObservedDays > 0
    ? `The pause recommendation still holds when the ${advice.pointObservedDays} uncertain day(s) out of ${advice.economicDayCount} are treated as meeting your target.`
    : `The purchase goal is verified on all ${advice.economicDayCount} economic days.`;
  return `Manual pause recommended from this ad's spend and purchases. ${observation} Confidence is capped at medium because historical campaign settings remain incomplete. If you accept that uncertainty, pause the ad in Ads Manager; no automated change is available.`;
}

/** Recorded reasons only; never infer a failed sensitivity test from ROAS. */
const REFUSAL_COPY: Record<NativeManualCutAdvisoryRefusal, string> = {
  not_a_published_cut: "The original decision did not confirm a Cut; a pause signal alone does not establish a manual recommendation.",
  hysteresis_pending: "The Cut has not completed the required consecutive decision confirmation.",
  refresh_transform_not_eligible: "This Cut came from a Refresh transformation, not an independently confirmed purchase stop-loss.",
  config_not_held: "This decision does not meet the configuration-held scope of the manual recommendation contract.",
  engine_validity_hold: "An independent decision validity requirement is still unmet.",
  source_coverage_gap: "The required source window is incomplete.",
  purchase_observation_incomplete: "Purchase actions are not verified for every economic day.",
  current_config_unobserved: "The current campaign configuration was not observed.",
  current_receipt_lineage_unverified: "Current configuration receipts could not be verified.",
  receipt_manifest_incoherent: "The configuration receipt manifest does not consistently describe the decision window.",
  commercial_truth_absent: "The required commercial target evidence is unavailable.",
  purchase_intent_window_invalid: "The recorded purchase-goal window could not be verified.",
  purchase_intent_unnamed: "Some economic days have no verified purchase-goal receipt.",
  goal_receipt_conflict: "The purchase-goal receipts conflict within the decision window.",
  objective_receipt_conflict: "The campaign-objective receipts conflict within the decision window.",
  sensitivity_not_computed: "The manual recommendation sensitivity check was not recorded.",
  peer_free_cut_not_confirmed: "The Cut does not hold when the peer comparison is removed.",
  sensitivity_unconstructible: "The uncertain-day sensitivity check could not be constructed from the recorded evidence.",
  stressed_cut_not_confirmed: "The peer-free Cut does not hold when uncertain days are treated as meeting the target.",
  stressed_original_cut_not_confirmed: "The original-profile Cut does not hold when uncertain days are treated as meeting the target.",
};

export interface MetaManualCutRefusal {
  code: NativeManualCutAdvisoryRefusal | "not_recorded" | "proof_unverified";
  detail: string;
}

export function readManualCutRefusal(value: unknown, proofPresent: boolean): MetaManualCutRefusal {
  if (typeof value === "string" && Object.hasOwn(REFUSAL_COPY, value)) {
    const code = value as NativeManualCutAdvisoryRefusal;
    return { code, detail: REFUSAL_COPY[code] };
  }
  return proofPresent
    ? { code: "proof_unverified", detail: "A manual recommendation was recorded, but its current identity or evidence could not be verified." }
    : { code: "not_recorded", detail: "This decision did not record a verifiable manual recommendation refusal reason. Review its evidence; the reason cannot be reconstructed from displayed metrics." };
}

/** Shared server presentation, not an execution gate or a new buyer action. */
export function manualCutAdviceForReview(decision: MetaCanonicalDecision): { label: string; nextStep: string } | null {
  const advice = decision.manualCutAdvisory;
  if (!advice?.advised || decision.identityGrain !== "ad" ||
    decision.deliveryScope?.state !== "active" ||
    decision.sourceAuthority?.status !== "native_exact" ||
    decision.sourceAuthority.decisionFreshness?.status !== "fresh" ||
    decision.sourceAuthority.actionEligible || decision.sourceAuthority.authorizedAction !== null ||
    decision.classification.decisionState !== "blocked" || decision.classification.buyerAction !== null ||
    decision.classification.heldAction !== "cut" ||
    decision.classification.resolution?.code !== "apply_purchase_cut_manually") return null;
  return { label: "Pause ad · manual recommendation", nextStep: manualCutAdvisoryNextStep(advice) };
}
