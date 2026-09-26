import type { MetaDecisionConfigEvidence } from "./decisions-workspace-contract";
import {
  META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT,
  parseNativeManualCutAdvisoryProof,
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
    !proof || config.evaluationContractVersion !== "engine-v3-canonical-ad-evaluation.v19" ||
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
