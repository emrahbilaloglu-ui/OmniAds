import type { MetaDecisionConfigEvidence } from "./decisions-workspace-contract";

export const META_PURCHASE_CONTEXT_MANUAL_ADVISORY_CONTRACT =
  "meta-purchase-context-manual-advisory.v1" as const;

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

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read only the exact evaluation's structured proof. A badge or prose is not
 * proof, and an earlier epoch cannot acquire this recommendation at read time.
 * Source receipts are already parsed by the native reader; fail closed if
 * any current reference or economic-window manifest was refused there.
 */
export function readManualCutAdvisory(input: {
  value: unknown;
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
    !["config_source_authority", "campaign_context"].includes(input.authorityBlocker ?? "") ||
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
  const raw = input.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const proof = raw as Record<string, unknown>;
  if (
    proof.advised !== true ||
    proof.contractVersion !== META_PURCHASE_CONTEXT_MANUAL_ADVISORY_CONTRACT ||
    proof.basis !== "peer_free_commercial_stop_loss" ||
    proof.confidenceCap !== "medium" || proof.authority !== "none" ||
    !count(proof.economicDayCount) || proof.economicDayCount === 0 ||
    !count(proof.bracketedDays) || !count(proof.pointObservedDays) ||
    !count(proof.historicalObjectiveUnverifiedDays) ||
    proof.bracketedDays + proof.pointObservedDays !== proof.economicDayCount ||
    proof.historicalObjectiveUnverifiedDays > proof.economicDayCount ||
    config.economicWindow.economicDayCount !== proof.economicDayCount
  ) return null;
  return {
    advised: true,
    contractVersion: META_PURCHASE_CONTEXT_MANUAL_ADVISORY_CONTRACT,
    basis: "peer_free_commercial_stop_loss",
    confidenceCap: "medium",
    authority: "none",
    economicDayCount: proof.economicDayCount,
    bracketedDays: proof.bracketedDays,
    pointObservedDays: proof.pointObservedDays,
    historicalObjectiveUnverifiedDays: proof.historicalObjectiveUnverifiedDays,
  };
}

export function manualCutAdvisoryNextStep(advice: MetaManualCutAdvisory): string {
  const observation = advice.pointObservedDays > 0
    ? `The pause recommendation still holds when the ${advice.pointObservedDays} uncertain day(s) out of ${advice.economicDayCount} are treated as meeting your target.`
    : `The purchase goal is verified on all ${advice.economicDayCount} economic days.`;
  return `Manual pause recommended from this ad's spend and purchases. ${observation} Confidence is capped at medium because historical campaign settings remain incomplete. If you accept that uncertainty, pause the ad in Ads Manager; no automated change is available.`;
}
