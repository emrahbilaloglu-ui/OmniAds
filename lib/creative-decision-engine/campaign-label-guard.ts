import type {
  MetaCampaignKind,
  MetaCampaignLabel,
  MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import type {
  CreativeInput,
  DecisionAuthorityBlocker,
  DecisionBadge,
  DecisionLabel,
  DecisionOutput,
} from "./types";
import { CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP } from "./config-values";

export const CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX =
  "[Campaign role unresolved - automatic inference required]";
export const CAMPAIGN_CONTEXT_UNRESOLVED_GUARD_PREFIX =
  "[Campaign context unresolved - review before hard action]";
export const CAMPAIGN_CONTEXT_LOW_CONFIDENCE_GUARD_PREFIX =
  "[Campaign context low confidence - hard action restricted]";
export { CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP } from "./config-values";

/**
 * Trust class of a campaign context entry (D033).
 *
 * Only fresh, high-confidence automatic context is trusted for kind semantics.
 * Legacy/override values remain in the union solely to deserialize old
 * evidence and are fail-closed. "medium" restricts kind semantics
 * (no kind-aware calibration or Test transforms; hard scale/refresh demote;
 * mature cut stays visible with a low-confidence badge). "low"/"unknown"
 * behave like today's unlabeled guard with automatic-context badges.
 * "conflict" is unresolved with conflict evidence.
 */
export type CreativeCampaignContextTrust =
  | "override"
  | "high"
  | "medium"
  | "low"
  | "unknown"
  | "conflict";

export interface CreativeCampaignContextEntry
  extends Pick<MetaCampaignLabel, "testDimension"> {
  kind: MetaCampaignKind | null;
  contextTrust?: CreativeCampaignContextTrust;
  inferenceConfidenceClass?:
    | "high"
    | "medium"
    | "low"
    | "unknown"
    | "conflict";
  resolverAuthorityValidated?: boolean;
}

export type CreativeCampaignLabelMap = ReadonlyMap<
  string,
  CreativeCampaignContextEntry
>;

interface CreativeCampaignLabelGuardInput {
  decision: DecisionOutput;
  input: Pick<CreativeInput, "campaignId">;
  campaignLabelsById: CreativeCampaignLabelMap | null | undefined;
}

const HARD_DECISION_LABELS = new Set<DecisionLabel>([
  "scale",
  "cut",
  "refresh",
]);

function isHardDecision(label: DecisionLabel) {
  return HARD_DECISION_LABELS.has(label);
}

/**
 * D074b compatibility boundary. Older persisted snapshots/evaluations carry
 * the legacy `campaignLabelStatus` field and the `unlabeled_campaign_context`
 * badge code; active writers emit only the canonical automatic-role names.
 * Every active branch normalizes through these helpers — nothing else may
 * interpret the legacy names.
 */
/**
 * Legacy aliases are parse COMPATIBILITY only and can never produce the
 * authority-granting value: a legacy-only "labeled" collapses to
 * "unresolved", because a manual-era label carries no automatic-role
 * provenance and must not unlock kind semantics, readiness, buyer actions,
 * or provider flows. Only "no_campaign" survives as itself (a safe,
 * distinct, non-authoritative state).
 */
export function canonicalCampaignRoleStatus(
  legacy: DecisionOutput["campaignLabelStatus"] | null | undefined,
): "unresolved" | "no_campaign" | null {
  if (legacy === "labeled") return "unresolved";
  if (legacy === "unlabeled") return "unresolved";
  if (legacy === "no_campaign") return "no_campaign";
  return null;
}

/**
 * Fail-closed authority matrix (D074b acceptance correction):
 *  - canonical only            → canonical value;
 *  - legacy only               → never "resolved" (see above);
 *  - both, same claim          → canonical (resolved+labeled, unresolved+
 *                                unlabeled, no_campaign+no_campaign);
 *  - both, contradictory       → "unresolved" — never silently the
 *                                authority-granting side;
 *  - neither                   → "unresolved" — missing status fails closed.
 * Only a canonical, uncontradicted `campaignRoleStatus: "resolved"` written
 * by an active producer (which sets it exactly when trusted automatic
 * context resolved a kind) can grant role authority.
 */
export function resolveCampaignRoleStatus(
  decision: Pick<
    DecisionOutput,
    "campaignRoleStatus" | "campaignLabelStatus"
  > | null | undefined,
): NonNullable<DecisionOutput["campaignRoleStatus"]> {
  if (!decision) return "unresolved";
  const canonical = decision.campaignRoleStatus ?? null;
  const legacy = decision.campaignLabelStatus ?? null;
  if (canonical !== null && legacy !== null) {
    const sameClaim =
      (canonical === "resolved" && legacy === "labeled") ||
      (canonical === "unresolved" && legacy === "unlabeled") ||
      (canonical === "no_campaign" && legacy === "no_campaign");
    return sameClaim ? canonical : "unresolved";
  }
  if (canonical !== null) return canonical;
  return canonicalCampaignRoleStatus(legacy) ?? "unresolved";
}

/** Unresolved-or-missing role, the fail-closed branch every guard takes.
 * Missing status IS unresolved; explicit no_campaign also fails closed. */
export function isCampaignRoleUnresolved(
  decision: Pick<
    DecisionOutput,
    "campaignRoleStatus" | "campaignLabelStatus"
  > | null | undefined,
): boolean {
  const status = resolveCampaignRoleStatus(decision);
  return status === "unresolved" || status === "no_campaign";
}

/** True only when a canonical, uncontradicted resolved status is present —
 * the sole shape that may unlock kind display or kind-conditional actions. */
export function hasResolvedCampaignRole(
  decision: Pick<
    DecisionOutput,
    "campaignRoleStatus" | "campaignLabelStatus"
  > | null | undefined,
): boolean {
  return resolveCampaignRoleStatus(decision) === "resolved";
}

/** Canonical badge plus its deprecated pre-D074b alias. */
export function isCampaignContextUnresolvedBadgeType(type: string): boolean {
  return (
    type === "campaign_context_unresolved" ||
    type === "unlabeled_campaign_context"
  );
}

function hasUnlabeledBadge(badges: readonly DecisionBadge[]) {
  return badges.some((badge) =>
    isCampaignContextUnresolvedBadgeType(badge.type),
  );
}

function withUnlabeledBadge(badges: readonly DecisionBadge[]): DecisionBadge[] {
  if (hasUnlabeledBadge(badges)) return [...badges];
  return [
    ...badges,
    {
      type: "campaign_context_unresolved",
      label:
        "Campaign role unresolved - fresh automatic Main/Test/Mixed inference required before hard action",
      severity: "warning",
    },
  ];
}

function withStopLossReviewBadge(badges: readonly DecisionBadge[]): DecisionBadge[] {
  if (badges.some((badge) => badge.type === "stop_loss_review")) {
    return [...badges];
  }
  return [
    ...badges,
    {
      type: "stop_loss_review",
      label: "Stop-loss review - automatic campaign role unresolved",
      severity: "warning",
    },
  ];
}

function withCampaignContext(
  decision: DecisionOutput,
  context: {
    status: NonNullable<DecisionOutput["campaignRoleStatus"]>;
    kind?: MetaCampaignKind | null;
    testDimension?: MetaCampaignTestDimension | null;
    authorityBlocker?: DecisionAuthorityBlocker | null;
    blockedActionType?: DecisionLabel | null;
    badges?: DecisionBadge[];
  },
): DecisionOutput {
  return {
    ...decision,
    // D074b: the guard's internal flow speaks the canonical value-space
    // directly; the legacy alias is parse-only and never written again.
    campaignRoleStatus: context.status,
    campaignKind: context.kind ?? null,
    campaignTestDimension: context.testDimension ?? null,
    authorityBlocker:
      decision.authorityBlocker ?? context.authorityBlocker ?? null,
    blockedActionType:
      decision.blockedActionType ?? context.blockedActionType ?? null,
    badges: context.badges ?? decision.badges,
  };
}

function isAlreadyGuarded(decision: DecisionOutput) {
  // Explicit stamped status only: the fail-closed missing-status default of
  // resolveCampaignRoleStatus must not make an unstamped diagnose row look
  // pre-guarded and skip its own context attachment.
  const stamped =
    decision.campaignRoleStatus === "unresolved" ||
    decision.campaignRoleStatus === "no_campaign" ||
    decision.campaignLabelStatus === "unlabeled" ||
    decision.campaignLabelStatus === "no_campaign";
  return (
    stamped &&
    decision.label === "diagnose" &&
    (decision.blockedActionType != null ||
      decision.reason.startsWith(CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX))
  );
}

type ContextGuardBadgeType =
  | "campaign_context_unresolved"
  | "campaign_context_low_confidence"
  | "campaign_context_conflict";

const CONTEXT_BADGE_LABELS: Record<ContextGuardBadgeType, string> = {
  campaign_context_unresolved:
    "Campaign context unresolved - automatic role could not be determined; review structure before hard action",
  campaign_context_low_confidence:
    "Campaign context low confidence - kind-specific semantics disabled",
  campaign_context_conflict:
    "Campaign context conflict - signals disagree; review structure before hard action",
};

function withContextBadge(
  badges: readonly DecisionBadge[],
  type: ContextGuardBadgeType,
): DecisionBadge[] {
  if (badges.some((badge) => badge.type === type)) return [...badges];
  return [
    ...badges,
    { type, label: CONTEXT_BADGE_LABELS[type], severity: "warning" },
  ];
}

function guardHardDecisionWithContext(
  decision: DecisionOutput,
  options: {
    status: NonNullable<DecisionOutput["campaignRoleStatus"]>;
    badgeType: ContextGuardBadgeType;
    prefix: string;
  },
): DecisionOutput {
  const originalLabel = decision.label;
  const badges = withContextBadge(decision.badges, options.badgeType);
  const guardedBadges =
    originalLabel === "cut" ? withStopLossReviewBadge(badges) : badges;

  return withCampaignContext(
    {
      ...decision,
      // Automatic context uncertainty must not erase the mathematical verdict.
      // Keep the explicit label and carry the blockedActionType/badge so every
      // serving surface can present it as review-only without inventing a new
      // decision client-side.
      label: originalLabel,
      confidence: Math.min(
        decision.confidence,
        CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
      ),
      reason: `${options.prefix} ${decision.reason}`,
      badges: guardedBadges,
    },
    {
      status: options.status,
      kind: null,
      testDimension: null,
      authorityBlocker: "campaign_context",
      blockedActionType: originalLabel,
      badges: guardedBadges,
    },
  );
}

function guardHardDecisionWithoutCampaignLabel(
  decision: DecisionOutput,
  status: NonNullable<DecisionOutput["campaignRoleStatus"]>,
): DecisionOutput {
  const originalLabel = decision.label;
  const badges = withUnlabeledBadge(decision.badges);
  const guardedBadges =
    originalLabel === "cut" ? withStopLossReviewBadge(badges) : badges;
  const guardPrefix =
    originalLabel === "cut"
      ? "[Stop-loss review - automatic campaign role unresolved]"
      : CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX;

  return withCampaignContext(
    {
      ...decision,
      label: "diagnose",
      confidence: Math.min(
        decision.confidence,
        CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
      ),
      reason: `${guardPrefix} ${decision.reason}`,
      badges: guardedBadges,
    },
    {
      status,
      kind: null,
      testDimension: null,
      authorityBlocker: "campaign_context",
      blockedActionType: originalLabel,
      badges: guardedBadges,
    },
  );
}

export function buildCreativeCampaignLabelMap(
  labels: Array<Pick<MetaCampaignLabel, "campaignId" | "kind" | "testDimension">>,
): CreativeCampaignLabelMap {
  return new Map(
    labels.map((label) => [
      label.campaignId,
      {
        kind: label.kind,
        testDimension: label.testDimension,
        // Compatibility helper: callers constructing frozen fixtures get the
        // same authority shape as a fresh high-confidence automatic row. Live
        // runtime never populates this map from meta_campaign_labels.
        contextTrust: "high",
      },
    ]),
  );
}

function isTrustedForKindSemantics(
  entry: CreativeCampaignContextEntry | null | undefined,
): entry is CreativeCampaignContextEntry & { kind: MetaCampaignKind } {
  if (!entry) return false;
  if (entry.kind === null) return false;
  const trust = entry.contextTrust;
  return trust === "high";
}

export function withCreativeCampaignLabelContext<T extends Pick<CreativeInput, "campaignId">>(
  input: T,
  campaignLabelsById: CreativeCampaignLabelMap | null | undefined,
): T & Pick<CreativeInput, "campaignKind"> {
  const campaignId = input.campaignId?.trim() || null;
  const entry = campaignId ? (campaignLabelsById?.get(campaignId) ?? null) : null;
  return {
    ...input,
    // Kind semantics (kind-aware calibration, Test transforms) require full
    // trust; medium/low/unknown/conflict automatic context stays canonical.
    campaignKind: isTrustedForKindSemantics(entry) ? entry!.kind : null,
  };
}

export function applyCreativeCampaignLabelGuard({
  decision,
  input,
  campaignLabelsById,
}: CreativeCampaignLabelGuardInput): DecisionOutput {
  const campaignId = input.campaignId?.trim() || null;
  if (!campaignId) {
    if (isAlreadyGuarded(decision)) {
      return withCampaignContext(decision, {
        status: "no_campaign",
        kind: null,
        testDimension: null,
        badges: withUnlabeledBadge(decision.badges),
      });
    }

    if (isHardDecision(decision.label)) {
      return guardHardDecisionWithoutCampaignLabel(decision, "no_campaign");
    }

    return withCampaignContext(decision, {
      status: "no_campaign",
      kind: null,
      testDimension: null,
      blockedActionType: null,
    });
  }

  const label = campaignLabelsById?.get(campaignId) ?? null;
  if (label && isTrustedForKindSemantics(label)) {
    return withCampaignContext(decision, {
      status: "resolved",
      kind: label.kind,
      testDimension: label.testDimension,
      blockedActionType: null,
    });
  }

  if (label?.contextTrust === "medium") {
    // Medium-confidence automatic context: canonical baselines, no kind
    // semantics. Hard verdicts stay explicit, including mature stop-loss Cut,
    // but remain review-only until inferred context has hard authority.
    if (isHardDecision(decision.label)) {
      return guardHardDecisionWithContext(decision, {
        status: "resolved",
        badgeType: "campaign_context_low_confidence",
        prefix: CAMPAIGN_CONTEXT_LOW_CONFIDENCE_GUARD_PREFIX,
      });
    }
    return withCampaignContext(decision, {
      status: "resolved",
      kind: null,
      testDimension: null,
      blockedActionType: null,
      badges: decision.badges.slice(),
    });
  }

  if (
    label?.contextTrust === "low" ||
    label?.contextTrust === "unknown" ||
    label?.contextTrust === "conflict"
  ) {
    const badgeType =
      label.contextTrust === "conflict"
        ? "campaign_context_conflict"
        : "campaign_context_unresolved";
    const badges = withContextBadge(decision.badges, badgeType);
    if (isAlreadyGuarded(decision)) {
      return withCampaignContext(decision, {
        status: "unresolved",
        kind: null,
        testDimension: null,
        badges,
      });
    }
    if (!isHardDecision(decision.label)) {
      return withCampaignContext(decision, {
        status: "unresolved",
        kind: null,
        testDimension: null,
        blockedActionType: null,
        badges,
      });
    }
    return guardHardDecisionWithContext(decision, {
      status: "unresolved",
      badgeType,
      prefix: CAMPAIGN_CONTEXT_UNRESOLVED_GUARD_PREFIX,
    });
  }

  const badges = withUnlabeledBadge(decision.badges);
  if (isAlreadyGuarded(decision)) {
    return withCampaignContext(decision, {
      status: "unresolved",
      kind: null,
      testDimension: null,
      badges,
    });
  }

  if (!isHardDecision(decision.label)) {
    return withCampaignContext(decision, {
      status: "unresolved",
      kind: null,
      testDimension: null,
      blockedActionType: null,
      badges,
    });
  }

  return guardHardDecisionWithoutCampaignLabel(decision, "unresolved");
}
