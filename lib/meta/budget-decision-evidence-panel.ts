/**
 * D084 — the server-owned budget-decision evidence panel.
 *
 * The surface renders this verbatim. It never computes eligibility, a buyer
 * action, a threshold, a campaign role or a spend unit, and it never turns an
 * absent panel into "nothing is blocking".
 *
 * The panel keeps four things visibly apart, because conflating them is how a
 * simulation starts looking like an approved plan:
 *
 *   observed fact — what the retained evidence says;
 *   recommendation — what the gates currently allow, which is review-only;
 *   counterfactual — what would change under an explicitly assumed input;
 *   execution readiness — always `not_executable` in this slice.
 */
import {
  BUDGET_DECISION_GATE_CODES,
  META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
  type BudgetDecisionGateCode,
  type BudgetDecisionGateVerdict,
} from "@/lib/meta/budget-decision-gates";

export const META_BUDGET_DECISION_EVIDENCE_PANEL_CONTRACT =
  "meta-budget-decision-evidence-panel.v4" as const;

export type EvidencePanelStatus = "resolved" | "unavailable";

/** Why the panel could not be served. Absence is never read as "no blockers". */
export type EvidencePanelUnavailableReason =
  | "gate_verdict_absent"
  | "gate_contract_unsupported";

export interface EvidencePanelSection {
  /**
   * Correction 1: three sections could not hold every gate code. Five codes —
   * `input_contract_unsupported`, `automation_unexpectedly_enabled`,
   * `provider_compatibility_unknown`, `intent_absent` and `intent_rejected` —
   * mapped to `null` and so appeared in NO section, while still being eligible
   * to be the primary blocker. A surface could therefore name a blocker that
   * every section it rendered denied having. The section map is total now, and
   * a test proves it stays total.
   */
  section:
    | "input_integrity"
    | "commercial_target"
    | "evidence_floor"
    | "change_safety"
    | "execution_capability";
  /** The gate codes in this section that are currently unmet, in contract order. */
  blockerCodes: BudgetDecisionGateCode[];
  /** One operator sentence per unmet gate, supplied by the server. */
  reasons: string[];
  /** True only when nothing in this section is unmet. */
  clear: boolean;
}

export interface MetaBudgetDecisionEvidencePanel {
  contractVersion: typeof META_BUDGET_DECISION_EVIDENCE_PANEL_CONTRACT;
  status: EvidencePanelStatus;
  unavailableReason: EvidencePanelUnavailableReason | null;
  /** The gate layer's own verdict, never re-derived by a surface. */
  authority: "validated_only" | "blocked" | null;
  /**
   * The one blocker a surface may name, WITH its own sentence.
   *
   * Correction 1: the panel used to publish only the code, and the component
   * recovered a sentence with `sections.flatMap(s => s.reasons)[0]`. Section
   * order is not blocker order, so a `budget_fact_absent` code was rendered
   * beside the commercial sentence. The pair travels together now.
   */
  primaryBlocker: { code: BudgetDecisionGateCode; reason: string } | null;
  /**
   * The canonical commercial lineage for the action this direction depends on,
   * carried verbatim from the resolver (Correction 3).
   *
   * The surface must be able to show the ACTION's own reason and the resolver's
   * full anchor explanation, and must be able to tell "the profile could not be
   * read" apart from "the profile says this action is ineligible". A generic
   * gate sentence answers neither question.
   */
  commercialLineage: {
    selectedAction: "scale" | "cut" | null;
    eligible: boolean | null;
    code: string | null;
    reason: string | null;
    anchorExplanation: Record<string, unknown> | null;
    contractVersion: string | null;
    availability:
      | { status: "resolved" }
      | {
          status: "read_failed" | "output_not_retained" | "action_not_published" | "gate_not_evaluated";
          reason: string;
          expectedContract: string;
          observedContract: string | null;
        };
  };
  sections: EvidencePanelSection[];
  /** Execution readiness is a constant here, not a computed maybe. */
  executionReadiness: {
    state: "not_executable";
    why: string;
    /** The CTA must never render enabled from this panel. */
    ctaEnabled: false;
  };
  /** Only ever set from an explicitly labelled counterfactual scenario. */
  counterfactual: {
    label: string;
    neverActionAuthority: true;
  } | null;
}

/**
 * Total by construction: the value type has no `null`, so a new gate code
 * cannot compile until it is given a section.
 */
const SECTION_OF: Record<BudgetDecisionGateCode, EvidencePanelSection["section"]> = {
  input_contract_unsupported: "input_integrity",
  input_clock_invalid: "input_integrity",
  input_counter_invalid: "input_integrity",
  input_governance_invalid: "input_integrity",
  evidence_trailing_window_too_short: "evidence_floor",
  evidence_spend_bearing_days_below_floor: "evidence_floor",
  evidence_conversions_below_increase_floor: "evidence_floor",
  evidence_budget_not_binding: "evidence_floor",
  change_safety_entity_cap_conflict: "change_safety",
  change_safety_account_cap_conflict: "change_safety",
  change_safety_business_cap_conflict: "change_safety",
  change_safety_fleet_cap_conflict: "change_safety",
  change_safety_concentration_conflict: "change_safety",
  change_safety_history_unavailable: "change_safety",
  automation_unexpectedly_enabled: "execution_capability",
  intent_absent: "execution_capability",
  intent_rejected: "execution_capability",
  budget_fact_absent: "evidence_floor",
  budget_fact_owner_unresolved: "evidence_floor",
  budget_fact_intent_not_ready: "evidence_floor",
  budget_shape_unsupported: "evidence_floor",
  role_authority_unresolved: "evidence_floor",
  commercial_profile_unavailable: "commercial_target",
  commercial_anchor_not_hard_action_eligible: "commercial_target",
  commercial_target_not_point_in_time_knowable: "commercial_target",
  commercial_target_stale: "commercial_target",
  commercial_target_not_economically_reconciled: "commercial_target",
  evidence_window_unsupported: "evidence_floor",
  evidence_observation_stale: "evidence_floor",
  change_safety_cooldown_conflict: "change_safety",
  threshold_not_owner_approved: "change_safety",
  provider_compatibility_unknown: "execution_capability",
};

const SECTIONS: EvidencePanelSection["section"][] = [
  "input_integrity",
  "commercial_target",
  "evidence_floor",
  "change_safety",
  "execution_capability",
];

export function unavailableEvidencePanel(
  reason: EvidencePanelUnavailableReason,
): MetaBudgetDecisionEvidencePanel {
  return {
    contractVersion: META_BUDGET_DECISION_EVIDENCE_PANEL_CONTRACT,
    status: "unavailable",
    unavailableReason: reason,
    // An unavailable panel states nothing about authority. It is never
    // rendered as "clear" and never as eligible.
    authority: null,
    primaryBlocker: null,
    commercialLineage: {
      selectedAction: null, eligible: null, code: null, reason: null,
      anchorExplanation: null, contractVersion: null,
      availability: {
        // A missing or unsupported VERDICT is a gate-level cause. Blaming the
        // profile asserts something about a read that never happened.
        status: "gate_not_evaluated",
        reason:
          reason === "gate_verdict_absent"
            ? "no gate verdict was produced for this account, so no commercial lineage exists to publish"
            : "the gate contract version served is not the one this surface reads, so no verdict was interpreted",
        expectedContract: "adsecute.account-decision-profile.v1",
        observedContract: null,
      },
    },
    sections: SECTIONS.map((section) => ({
      section,
      blockerCodes: [],
      reasons: [],
      clear: false,
    })),
    executionReadiness: {
      state: "not_executable",
      why: "the decision gates could not be resolved, so nothing here may be acted on",
      ctaEnabled: false,
    },
    counterfactual: null,
  };
}

export function projectBudgetDecisionEvidencePanel(input: {
  verdict: BudgetDecisionGateVerdict | null;
  counterfactualLabel?: string | null;
}): MetaBudgetDecisionEvidencePanel {
  const verdict = input.verdict;
  if (verdict === null) return unavailableEvidencePanel("gate_verdict_absent");
  if (verdict.contractVersion !== META_BUDGET_DECISION_GATE_CONTRACT_VERSION) {
    return unavailableEvidencePanel("gate_contract_unsupported");
  }

  const reasonOf = new Map(verdict.reasons.map((r) => [r.code, r.reason]));
  const sections = SECTIONS.map((section) => {
    const codes = BUDGET_DECISION_GATE_CODES.filter(
      (code) => SECTION_OF[code] === section && verdict.blockerCodes.includes(code),
    );
    return {
      section,
      blockerCodes: codes,
      reasons: codes.map((code) => reasonOf.get(code) ?? ""),
      clear: codes.length === 0,
    };
  });

  return {
    contractVersion: META_BUDGET_DECISION_EVIDENCE_PANEL_CONTRACT,
    status: "resolved",
    unavailableReason: null,
    authority: verdict.authority,
    primaryBlocker: verdict.primaryBlocker,
    commercialLineage: {
      selectedAction: verdict.lineage.commercialSelectedAction,
      // Carried verbatim. r4 re-derived `eligible` from the absence of a
      // generic gate blocker and set `code` from that gate code, which
      // destroyed an eligible action's canonical code entirely and replaced an
      // ineligible one's with the gate's.
      eligible: verdict.lineage.commercialSelectedEligible,
      code: verdict.lineage.commercialSelectedCode,
      // The ACTION's own sentence, not a gate sentence.
      reason: verdict.lineage.commercialSelectedActionReason,
      anchorExplanation: verdict.lineage.commercialAnchorExplanation,
      contractVersion: verdict.lineage.commercialProfileContract,
      availability: verdict.lineage.commercialProfileUnavailable === null
        ? { status: "resolved" as const }
        : {
            status: verdict.lineage.commercialProfileUnavailable.status,
            reason: verdict.lineage.commercialProfileUnavailable.reason,
            expectedContract: verdict.lineage.commercialProfileUnavailable.expectedContract,
            observedContract: verdict.lineage.commercialProfileUnavailable.observedContract,
          },
    },
    sections,
    executionReadiness: {
      state: "not_executable",
      why:
        verdict.authority === "validated_only"
          ? "every local gate passed, so this is validated for review only; automation is off and no provider write exists"
          : "at least one local gate is unmet",
      ctaEnabled: false,
    },
    counterfactual: input.counterfactualLabel
      ? { label: input.counterfactualLabel, neverActionAuthority: true }
      : null,
  };
}

/**
 * The account-scoped panel, published as BOTH review-only directions.
 *
 * An account panel has no selected proposal, so naming one direction asserts a
 * choice nobody made. Publishing both also keeps the direction asymmetry
 * visible: an increase depends on the profile's `scale` verdict and faces a
 * conversion floor and a budget-binding test; a decrease depends on `cut` and
 * faces neither.
 */
export const META_BUDGET_DECISION_EVIDENCE_DIRECTIONAL_CONTRACT =
  "meta-budget-decision-evidence-directional.v3" as const;

export interface MetaBudgetDecisionEvidenceByDirection {
  contractVersion: typeof META_BUDGET_DECISION_EVIDENCE_DIRECTIONAL_CONTRACT;
  /** Always null on an account panel: no proposal direction was selected. */
  directionSelected: null;
  directionSelectedWhy: string;
  /**
   * The SERVER's mapping from direction to the profile action it consulted.
   *
   * The client used to hold this as a local constant, so the surface asserted a
   * relationship no server response carried. It is published now and the UI
   * only renders it.
   */
  directionToAction: { increase: "scale"; decrease: "cut" };
  directionToActionWhy: string;
  increase: MetaBudgetDecisionEvidencePanel;
  decrease: MetaBudgetDecisionEvidencePanel;
}
