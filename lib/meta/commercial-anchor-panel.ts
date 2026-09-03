/**
 * Server-owned commercial-anchor projection for the Decision Center.
 *
 * AUTHORITY. The canonical `AccountDecisionProfile` is the ONLY authority for
 * this explanation. This module recomputes nothing: it copies
 * `hardActionEligibility.anchor` (the resolved spend unit, its source,
 * confidence, target-provenance state, full input lineage, missing inputs and
 * the per-action blocker codes) verbatim, and it copies the profile's own
 * per-action booleans and codes. It may attach only two things the profile
 * does not carry: the business/account currency, and aggregate counts of the
 * persisted first-blocker values the server already read.
 *
 * The earlier version of this module re-derived the anchor from
 * `MetaCommercialTargets` — configured Target CPA or operator AOV only. That
 * was a second resolver: it could not represent `meta_derived_aov`,
 * `account_history`, `break_even_aov`, calibration state or confidence, so it
 * could report "anchor missing" while the real profile had resolved a ready
 * sampled Meta AOV. That is why the projection now refuses to compute.
 *
 * React renders this object. It never derives eligibility, thresholds,
 * `buyerAction` or campaign role from it, and an unavailable profile renders
 * as unavailable — never as eligible.
 */
import {
  describeCommercialAnchorBlocker,
  type CommercialAnchorBlockerCode,
  type CommercialAnchorExplanation,
} from "@/lib/creative-decision-engine/commercial-anchor";
import type { HardActionEligibility } from "@/lib/creative-decision-engine/types";

export const META_COMMERCIAL_ANCHOR_PANEL_CONTRACT =
  "meta-commercial-anchor-panel.v2" as const;

export type MetaCommercialAnchorPanelStatus = "resolved" | "unavailable";

/** Why the canonical profile explanation could not be served. */
export type MetaCommercialAnchorUnavailableReason =
  | "profile_read_failed"
  | "profile_not_resolved"
  | "explanation_absent_pre_contract_profile";

export interface MetaCommercialAnchorActionRow {
  action: "scale" | "cut" | "refresh";
  /** The profile's own effective decision, after any Cut-only overlay. */
  eligible: boolean;
  blockerCode: CommercialAnchorBlockerCode | null;
  operatorCopy: string | null;
}

export interface MetaCommercialAnchorPanel {
  contractVersion: typeof META_COMMERCIAL_ANCHOR_PANEL_CONTRACT;
  status: MetaCommercialAnchorPanelStatus;
  unavailableReason: MetaCommercialAnchorUnavailableReason | null;
  /**
   * The canonical explanation, verbatim. Null whenever `status` is
   * `unavailable`; absence is never read as eligible.
   */
  explanation: CommercialAnchorExplanation | null;
  /**
   * The profile's effective per-action decision. Separate from
   * `explanation.actions` because the Cut-only commercial stop-loss overlay can
   * grant Cut that the canonical anchor alone would withhold; the surface must
   * show what the engine actually decided.
   */
  actions: MetaCommercialAnchorActionRow[];
  /** Attached by the projection: the business/account currency, never guessed. */
  currency: string | null;
  /**
   * Attached by the projection: aggregate persisted FIRST-blocker counts.
   *
   * `profileHardActionEvidence` is deliberately generic. The persisted value
   * `profile_hard_action_ineligible` is a first-blocker FAMILY: it covers a
   * missing commercial anchor, an unverifiable target provenance, an
   * insufficient sampled AOV, a missing per-action ROAS anchor AND a
   * below-floor scale calibration. A profile can satisfy the commercial
   * threshold and still land here (calibration-blocked Scale), so calling this
   * count a commercial-threshold gate asserts a sub-cause the frozen row does
   * not record.
   */
  withheld: {
    total: number;
    profileHardActionEvidence: number;
    campaignContext: number;
    recentRecoveryUnverifiable: number;
    other: number;
  };
}

export interface MetaAuthorityBlockerCounts {
  profileHardActionIneligible: number;
  campaignContext: number;
  recentRecoveryUnverifiable: number;
  other: number;
}

export function emptyAuthorityBlockerCounts(): MetaAuthorityBlockerCounts {
  return {
    profileHardActionIneligible: 0,
    campaignContext: 0,
    recentRecoveryUnverifiable: 0,
    other: 0,
  };
}

/**
 * Tallies persisted per-row authority blockers. The caller passes the values
 * the server already read; nothing is inferred from labels or reason text.
 */
export function tallyAuthorityBlockers(
  blockers: Array<string | null | undefined>,
): MetaAuthorityBlockerCounts {
  const counts = emptyAuthorityBlockerCounts();
  for (const blocker of blockers) {
    if (!blocker) continue;
    if (blocker === "profile_hard_action_ineligible") {
      counts.profileHardActionIneligible += 1;
    } else if (blocker === "campaign_context") {
      counts.campaignContext += 1;
    } else if (blocker === "recent_recovery_unverifiable") {
      counts.recentRecoveryUnverifiable += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

function withheldFrom(counts: MetaAuthorityBlockerCounts) {
  return {
    total:
      counts.profileHardActionIneligible +
      counts.campaignContext +
      counts.recentRecoveryUnverifiable +
      counts.other,
    profileHardActionEvidence: counts.profileHardActionIneligible,
    campaignContext: counts.campaignContext,
    recentRecoveryUnverifiable: counts.recentRecoveryUnverifiable,
    other: counts.other,
  };
}

/**
 * Projects the canonical profile explanation for serving.
 *
 * `eligibility` and its `codes`/`anchor` come from
 * `AccountDecisionProfile.hardActionEligibility`. Pass `eligibility: null` when
 * the profile could not be resolved — the panel then fails closed.
 */
export function projectMetaCommercialAnchorPanel(input: {
  eligibility: HardActionEligibility | null;
  profileReadFailed?: boolean;
  currency: string | null;
  blockers: MetaAuthorityBlockerCounts;
}): MetaCommercialAnchorPanel {
  const withheld = withheldFrom(input.blockers);
  const base = {
    contractVersion: META_COMMERCIAL_ANCHOR_PANEL_CONTRACT,
    currency: input.currency ?? null,
    withheld,
  } as const;

  if (input.profileReadFailed || !input.eligibility) {
    return {
      ...base,
      status: "unavailable",
      unavailableReason: input.profileReadFailed
        ? "profile_read_failed"
        : "profile_not_resolved",
      explanation: null,
      actions: [],
    };
  }

  const explanation = input.eligibility.anchor ?? null;
  if (!explanation) {
    // A profile serialized before this contract carries no explanation. That
    // is unknown, not "no anchor configured".
    return {
      ...base,
      status: "unavailable",
      unavailableReason: "explanation_absent_pre_contract_profile",
      explanation: null,
      actions: [],
    };
  }

  const actions: MetaCommercialAnchorActionRow[] = (
    ["scale", "cut", "refresh"] as const
  ).map((action) => {
    const eligible = input.eligibility![action];
    const blockerCode = input.eligibility!.codes?.[action] ?? null;
    return {
      action,
      eligible,
      blockerCode,
      // The sentence is derived from the SAME effective code as the chip.
      // Taking it from the pre-overlay canonical explanation produced a
      // self-contradictory row after the Cut-only stop-loss overlay changed
      // the effective code (chip `break_even_roas_missing` beside copy that
      // said no commercial anchor was configured).
      operatorCopy: eligible
        ? null
        : blockerCode
          ? describeCommercialAnchorBlocker(blockerCode)
          : (explanation.actions[action].operatorCopy ?? null),
    };
  });

  return {
    ...base,
    status: "resolved",
    unavailableReason: null,
    explanation,
    actions,
  };
}
