import type {
  MetaDecisionCreativeAssessment,
} from "@/lib/meta/decisions-workspace-contract";
import { META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION } from "@/lib/meta/decisions-workspace-contract";

export type MetaCreativeAssessmentTone =
  | "pos"
  | "info"
  | "caution"
  | "danger"
  | "neutral";

export interface MetaCreativeAssessmentPresentation {
  value: MetaDecisionCreativeAssessment;
  label: string;
  tone: MetaCreativeAssessmentTone;
  blockerCode: string | null;
  vocabularyVersion: typeof META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION;
}

/**
 * Deterministic presentation projection over persisted decision fields. This
 * does not replace or reinterpret the engine decision; it gives Studio and
 * Decisions one server-owned assessment vocabulary.
 */
export function classifyMetaCreativeAssessment(input: {
  label: string;
  truthSource: string;
  badgeCodes: readonly string[];
  heldAction?: string | null;
}): MetaCreativeAssessmentPresentation {
  let value: MetaDecisionCreativeAssessment = "cant_assess";
  let blockerCode: string | null = null;
  const badgeCodes = new Set(input.badgeCodes);

  if (input.label === "scale" && input.truthSource === "commercial_truth") {
    value = "proven_winner";
  } else if (
    input.label === "scale" &&
    input.truthSource === "account_baseline"
  ) {
    value = "above_target_not_scale_ready";
    blockerCode = "account_baseline_not_economic";
  } else if (input.label === "scale") {
    value = "evidence_incomplete";
    blockerCode =
      input.truthSource === "commercial_truth_stale"
        ? "commercial_truth_stale"
        : "winner_evidence_insufficient";
  } else if (input.label === "cut") {
    value = "below_target";
  } else if (
    input.label === "keep" &&
    badgeCodes.has("scale_readiness_blocked")
  ) {
    value = "above_target_not_scale_ready";
  } else if (input.label === "keep") {
    value = "stable";
  } else if (input.label === "test_more") {
    value = "learning";
  } else if (
    input.label === "refresh" &&
    (badgeCodes.has("fatigue_watch") || badgeCodes.has("fatigue_fatigued"))
  ) {
    value = "fatigued_former_winner";
  } else if (input.label === "refresh") {
    value = "refresh_candidate";
  } else if (input.label === "diagnose" && input.heldAction === "cut") {
    value = "below_target";
  } else if (input.label === "diagnose" && input.heldAction === "scale") {
    value = "above_target_not_scale_ready";
  } else if (
    input.label === "diagnose" &&
    (badgeCodes.has("landing_page_issue") ||
      badgeCodes.has("checkout_breakdown") ||
      badgeCodes.has("upper_funnel_strong_site_weak"))
  ) {
    value = "funnel_bottleneck";
  } else if (input.label === "diagnose") {
    value = "decision_blocked";
  } else if (input.label === "out_of_scope") {
    value = "out_of_scope";
  } else {
    blockerCode = "creative_assessment_evidence_unavailable";
  }

  const display: Record<
    MetaDecisionCreativeAssessment,
    { label: string; tone: MetaCreativeAssessmentTone }
  > = {
    proven_winner: { label: "Proven winner", tone: "pos" },
    above_target_not_scale_ready: {
      label: "Above target · not proven",
      tone: "info",
    },
    fatigued_former_winner: {
      label: "Fatigued former winner",
      tone: "caution",
    },
    below_target: { label: "Underperformer", tone: "danger" },
    learning: { label: "Learning", tone: "info" },
    stable: { label: "Stable", tone: "neutral" },
    refresh_candidate: { label: "Refresh candidate", tone: "caution" },
    funnel_bottleneck: { label: "Funnel bottleneck", tone: "caution" },
    decision_blocked: { label: "Decision blocked", tone: "caution" },
    evidence_incomplete: { label: "Evidence incomplete", tone: "caution" },
    out_of_scope: { label: "Out of scope", tone: "neutral" },
    cant_assess: { label: "Evidence incomplete", tone: "caution" },
  };

  return {
    value,
    ...display[value],
    blockerCode,
    vocabularyVersion: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
  };
}
