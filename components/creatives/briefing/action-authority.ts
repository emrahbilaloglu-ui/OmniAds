import type {
  BriefingCanonicalNativeAdDecision,
  BriefingCreativeCard,
} from "@/components/creatives/briefing/types";
import type { DecisionLabel } from "@/components/common/briefing/types";
import { asDecisionLabel } from "@/components/creatives/briefing/card-utils";

export type BriefingCanonicalNativeAction = NonNullable<
  BriefingCanonicalNativeAdDecision["sourceAuthority"]["authorizedAction"]
>;

export interface BriefingCanonicalNativeActionAuthority {
  status: "native_exact";
  action: BriefingCanonicalNativeAction;
  decision: BriefingCanonicalNativeAdDecision;
}

function nonEmpty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isSha256(value: string | null | undefined) {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value));
}

function isCanonicalNativeAction(
  value: string | null | undefined,
): value is BriefingCanonicalNativeAction {
  return value === "scale" || value === "cut" || value === "refresh";
}

export interface BriefingCanonicalDecisionPresentation {
  label: DecisionLabel;
  text: string | null;
  canonicalHeld: boolean;
}

/**
 * Canonical held actions are server-owned verdicts, not compatibility labels.
 * The compatibility label remains available in evidence/provenance, but it
 * must never replace "Cut pending", "Scale pending", or "Refresh pending" in
 * the operator-facing decision chip.
 */
export function getBriefingCanonicalDecisionPresentation(
  card: BriefingCreativeCard,
): BriefingCanonicalDecisionPresentation {
  const fallbackLabel = asDecisionLabel(card.label);
  const classification = card.canonicalDecision?.classification;
  const buyerLabel = nonEmpty(classification?.buyerLabel);
  if (
    classification &&
    isCanonicalNativeAction(classification.heldAction) &&
    buyerLabel
  ) {
    return {
      label: classification.heldAction,
      text: buyerLabel,
      canonicalHeld: true,
    };
  }
  return {
    label: fallbackLabel,
    text: null,
    canonicalHeld: false,
  };
}

export function hasBriefingCanonicalDecision(card: BriefingCreativeCard) {
  return card.canonicalDecision !== null &&
    card.canonicalDecision !== undefined;
}

/**
 * The one client-side authority predicate for decision-origin actions.
 *
 * It does not calculate a buyer action. It validates that every server-owned
 * projection of the already-produced action agrees with the exact native-Ad
 * authority tuple. Any missing, held, blocked, demo, review-only, mismatched,
 * or action-ineligible field fails closed.
 */
export function getBriefingCanonicalNativeActionAuthority(
  card: BriefingCreativeCard,
): BriefingCanonicalNativeActionAuthority | null {
  const decision = card.canonicalDecision;
  if (
    !decision ||
    !decision.sourceAuthority ||
    !decision.classification ||
    !decision.identityResolution ||
    !decision.sourceDecision
  ) {
    return null;
  }

  const authority = decision.sourceAuthority;
  const classification = decision.classification;
  const authorizedAction = authority.authorizedAction;
  const decisionCreativeId = nonEmpty(decision.creativeId);
  const cardCreativeId = nonEmpty(card.creativeId);
  if (
    decision.contractVersion !== "briefing-canonical-native-ad.v1" ||
    decision.identityGrain !== "ad" ||
    decision.identityResolution.basis !== "native_ad_exact" ||
    decision.identityResolution.adActionEligible !== true ||
    authority.status !== "native_exact" ||
    authority.actionEligible !== true ||
    authority.reviewOnlyReason !== null ||
    classification.decisionState !== "act" ||
    classification.heldAction !== null ||
    decision.sourceDecision.authorityBlocker !== null ||
    card.authorityBlocker !== null ||
    card.blockedActionType !== null ||
    !isCanonicalNativeAction(authorizedAction) ||
    classification.buyerAction !== authorizedAction ||
    decision.sourceSnapshotId !== authority.snapshotId ||
    card.sourceDecisionAuthorityStatus !== "native_exact" ||
    card.sourceDecisionActionEligible !== true ||
    card.sourceDecisionAuthorizedAction !== authorizedAction ||
    card.sourceDecisionSnapshotMatch !== "matched" ||
    card.sourceDecisionSnapshotId !== decision.sourceSnapshotId ||
    card.sourceDecisionEvaluationId !== authority.evaluationId ||
    card.sourceDecisionSnapshotEngineVersion !== authority.engineVersion ||
    card.sourceDecisionHash !== authority.decisionHash ||
    card.sourceDecisionInputHash !== authority.inputHash ||
    card.sourceDecisionProviderAccountRefId !==
      authority.providerAccountRefId ||
    card.sourceDecisionJobRunId !== authority.jobRunId ||
    nonEmpty(card.providerAccountId) !== authority.providerAccountId ||
    nonEmpty(card.realAdId) !== decision.adId ||
    decision.adId !== authority.realAdId ||
    !decisionCreativeId ||
    !cardCreativeId ||
    decisionCreativeId !== cardCreativeId ||
    !nonEmpty(authority.snapshotId) ||
    !nonEmpty(authority.evaluationId) ||
    !nonEmpty(authority.engineVersion) ||
    !nonEmpty(authority.providerAccountRefId) ||
    !nonEmpty(authority.providerAccountId) ||
    !nonEmpty(authority.realAdId) ||
    !nonEmpty(authority.jobRunId) ||
    !isSha256(authority.inputHash) ||
    !isSha256(authority.decisionHash)
  ) {
    return null;
  }

  return {
    status: "native_exact",
    action: authorizedAction,
    decision,
  };
}

export function hasBriefingCanonicalNativeActionAuthority(
  card: BriefingCreativeCard,
  action: BriefingCanonicalNativeAction,
) {
  return getBriefingCanonicalNativeActionAuthority(card)?.action === action;
}
