import type { MetaCampaignKind, MetaCampaignLabel } from "@/lib/meta/campaign-label-types";
import type {
  MetaDecisionLabel,
  MetaRecommendation,
  MetaRecommendationType,
} from "@/lib/meta/recommendations";
import { withMetaAutomationReadiness } from "@/lib/meta/automation-readiness";
import { decisionLabelForMetaRec } from "@/lib/meta/rec-label-mapping";

/** @deprecated pre-D074b reason; recognition-only for persisted payloads. */
export const META_CAMPAIGN_LABEL_GUARD_REASON = "unlabeled_campaign_soft_only";
export const META_CAMPAIGN_LABEL_CONFIDENCE_CAP = 0.45;
export const META_TEST_REFRESH_TO_CUT_REASON = "test_refresh_to_cut";
export const META_TEST_SCALE_TO_PROMOTE_REASON = "test_scale_to_promote_main";
export const META_AUTOMATIC_CONTEXT_REVIEW_REASON =
  "automatic_campaign_context_review_only";
export const META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON =
  "automatic_campaign_context_resolver_unvalidated";

export interface MetaCampaignContextGuardEntry {
  kind: MetaCampaignKind | null;
  contextTrust: "override" | "high" | "medium" | "low" | "unknown" | "conflict";
  source: "legacy_label" | "user_override" | "system_inferred" | "unknown";
  inferenceConfidenceClass?:
    | "high"
    | "medium"
    | "low"
    | "unknown"
    | "conflict";
  resolverAuthorityValidated?: boolean;
}

export type MetaCampaignContextGuardMap = ReadonlyMap<
  string,
  MetaCampaignContextGuardEntry
>;

export type MetaCampaignLabelKindMap = ReadonlyMap<string, MetaCampaignKind>;

export interface MetaCampaignLabelGuardResult {
  recommendations: MetaRecommendation[];
  downgradedCount: number;
  unlabeledCampaignIds: string[];
  accountLevelDowngraded: boolean;
}

const HARD_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "adset_cut_spend",
  "budget_allocation",
  "scale_for_volume",
  "scale_for_volume_budget_increase",
  "scale_for_profitability",
  "winner_promotion_flow",
  "bid_strategy_fit",
  "bid_value_guidance",
  "bid_band_from_history",
  "historical_bid_regime_fit",
  "scenario_a1_math_floor_unmet",
  "scenario_b1_capped_winner_bid_raise",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_b3_bid_cap_underperforming",
  "scenario_b4_min_roas_loosen",
  "scenario_b5_lowest_cost_volatility_switch",
  "scenario_c1_controlled_scale",
  "scenario_c3_scale_sample_gate",
  "scenario_d3_lal_compound_scale",
  "scenario_g1_upper_funnel_event",
  "scenario_g2_downshift_to_purchase",
  "scenario_i1_abo_winner_budget_shift",
  "scenario_k2_peak_scale_ceiling",
  "scenario_k3_post_peak_taper",
]);

const ACCOUNT_LEVEL_HARD_TYPES = new Set<MetaRecommendation["type"]>([
  "budget_allocation",
  "winner_promotion_flow",
]);

const REFRESH_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "scenario_e1_frequency_fatigue",
  "scenario_e2_ctr_decay_refresh",
  "scenario_e3_frequency_p80_fatigue",
  "scenario_e4_creative_age_refresh",
  "scenario_m4_mid_funnel_refresh",
  "scenario_l4_lead_refresh",
  "scenario_t4_traffic_refresh",
  "scenario_eg4_engagement_refresh",
]);

const SCALE_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "scale_for_volume",
  "scale_for_volume_budget_increase",
  "scale_for_profitability",
  "winner_promotion_flow",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_c1_controlled_scale",
  "scenario_d3_lal_compound_scale",
  "scenario_k2_peak_scale_ceiling",
  "scenario_m1_mid_funnel_efficient_scale",
  "scenario_l1_lead_efficient_scale",
  "scenario_t1_traffic_efficient_scale",
  "scenario_eg1_engagement_efficient_scale",
]);

export function buildMetaCampaignLabelKindMap(
  labels: Array<Pick<MetaCampaignLabel, "campaignId" | "kind">>,
): MetaCampaignLabelKindMap {
  return new Map(labels.map((label) => [label.campaignId, label.kind]));
}

export function hasMetaCampaignLabel(
  campaignId: string | null | undefined,
  labelMap: MetaCampaignLabelKindMap | null | undefined,
) {
  return Boolean(campaignId && labelMap?.has(campaignId));
}

function isAlreadyGuarded(rec: MetaRecommendation) {
  return rec.confidenceReason === META_CAMPAIGN_LABEL_GUARD_REASON;
}

function isAlreadyLabelTransformed(rec: MetaRecommendation) {
  return Boolean(rec.labelTransform);
}

function isHardAction(rec: MetaRecommendation) {
  if (rec.kind === "state" || rec.kind === "anomaly") return false;
  return HARD_ACTION_TYPES.has(rec.type);
}

function confidenceScore(rec: MetaRecommendation) {
  return typeof rec.confidenceScore === "number" && Number.isFinite(rec.confidenceScore)
    ? rec.confidenceScore
    : 0.85;
}

function campaignIdsForRec(
  rec: MetaRecommendation,
  activeCampaignIds: readonly string[],
): string[] {
  if (rec.level === "campaign" || rec.level === "adset") {
    return rec.campaignId ? [rec.campaignId] : [];
  }
  if (ACCOUNT_LEVEL_HARD_TYPES.has(rec.type)) {
    return [...activeCampaignIds];
  }
  return [];
}

function campaignKindForRec(
  rec: MetaRecommendation,
  labelMap: MetaCampaignLabelKindMap,
  activeCampaignIds: readonly string[],
): MetaCampaignKind | null {
  const campaignIds = campaignIdsForRec(rec, activeCampaignIds);
  if (campaignIds.length === 0) return null;
  const kinds = new Set<MetaCampaignKind>();
  let missingLabel = false;
  for (const campaignId of campaignIds) {
    const kind = labelMap.get(campaignId);
    if (kind) {
      kinds.add(kind);
    } else {
      missingLabel = true;
    }
  }
  if (missingLabel) return null;
  if (kinds.size > 1) return "mixed";
  return kinds.values().next().value ?? null;
}

/**
 * Replace the candidate's `campaignKind` with the TRUSTED map result, or with
 * nothing at all.
 *
 * THE UNTRUSTED VALUE IS REMOVED FIRST. This used to return the candidate
 * unchanged when `campaignKindForRec` answered null — "no trusted answer, so
 * leave it alone" — which left whatever `campaignKind` the candidate already
 * carried in place and let it out through the guard as though the guard had
 * approved it. Candidates arrive here carrying a persisted or hydrated kind
 * (a snapshot read at `readMetaDecisionSnapshot`, an evaluation row rehydrated
 * from `engine_v3_ad_decision_snapshots_daily`), and that value can be stale,
 * can predate a relabelling, or can simply never have been validated by the
 * canonical resolver this guard exists to enforce.
 *
 * Null from `campaignKindForRec` is an ABSENCE — no campaign ids, a campaign
 * with no entry in the trusted label map, or a resolver whose authority was
 * not validated — and an absence must read as an absence downstream, not as
 * the last value anyone happened to store. So the field is destructured OUT
 * unconditionally and re-added only when the trusted lookup produced one.
 */
function attachCampaignKind(
  rec: MetaRecommendation,
  labelMap: MetaCampaignLabelKindMap,
  activeCampaignIds: readonly string[],
): MetaRecommendation {
  const campaignKind = campaignKindForRec(rec, labelMap, activeCampaignIds);
  const { campaignKind: _untrustedCampaignKind, ...withoutKind } = rec;
  return campaignKind ? { ...withoutKind, campaignKind } : withoutKind;
}

function appendGuardEvidence(
  rec: MetaRecommendation,
  heldLabel: MetaDecisionLabel | null,
): MetaRecommendation["evidence"] {
  const hasLabelEvidence = rec.evidence.some((item) => item.label === "Campaign role");
  const hasBlockedAction = rec.evidence.some((item) => item.label === "Blocked action");
  return [
    ...rec.evidence,
    ...(hasLabelEvidence
      ? []
      : [
          {
            label: "Campaign role",
            value: "Automatic inference unresolved",
            tone: "warning" as const,
          },
        ]),
    // The verdict first, then the producer type. The value used to be
    // `rec.type` alone, so the one evidence row that named the hold showed an
    // internal identifier ("scale_for_volume") and never the conclusion being
    // held.
    ...(hasBlockedAction
      ? []
      : [
          {
            label: "Blocked action",
            value: `${heldVerdictNoun(heldLabel)} · ${rec.type}`,
            tone: "warning" as const,
          },
        ]),
  ];
}

/**
 * The one reading of "the inference is high, the resolver identity is not
 * approved".
 *
 * It had two: this predicate and a byte-identical copy inside
 * `restrictAutomaticContextToReview`, one choosing the evidence wording and the
 * other the `confidenceReason` and the authority key. Two copies of a rule is
 * how a row comes out saying "resolver validation pending" in its evidence and
 * `review_only` in its authority, so they now ask the same function.
 *
 * `contextTrust === "high"` is included because it is the OTHER way the two
 * halves of the invariant can disagree — see `isContextTrustedForAction`. Such
 * an entry is held, and it is held for THIS reason, not for a generic one.
 *
 * The test is `!== true`, matching `isContextTrustedForAction` exactly. An
 * entry claiming high confidence or high trust while carrying NO
 * `resolverAuthorityValidated` at all has not had its resolver identity
 * approved either — the approval is simply missing rather than refused — and
 * naming a generic "context is unknown" hold for it would tell the operator
 * the wrong thing to go and fix. If the two predicates split on absence, one
 * would withhold authority while the other picked wording for a hold it
 * believes did not happen.
 */
function isResolverValidationPending(
  entry: MetaCampaignContextGuardEntry | null,
): boolean {
  if (!entry || entry.resolverAuthorityValidated === true) return false;
  return entry.inferenceConfidenceClass === "high" || entry.contextTrust === "high";
}

/**
 * Whether a context entry may unlock kind semantics and hard-action authority.
 *
 * INVARIANTS.md: "High-trust campaign-role semantics require BOTH
 * `confidenceClass = high` AND the exact resolver-version authority gate
 * (`CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` equal to the compiled resolver
 * version)." This guard used to test `contextTrust === "high" && source ===
 * "system_inferred"` and nothing else, so an entry carrying
 * `resolverAuthorityValidated: false` beside a `high` trust — the two halves of
 * that invariant contradicting each other — was read as fully authoritative:
 * the hard action passed through untouched at `decisionState: "act"` with
 * `campaignContext.trustedForAction: true`, and a `test` kind would also have
 * been re-typed into the promote-to-main flow. The field was already on the
 * entry; the guard read it only to pick the WORDING inside
 * `restrictAutomaticContextToReview`.
 *
 * Today's only runtime producer cannot emit that combination —
 * `readCampaignContextMap` (lib/creative-decision-engine/campaign-context/source.ts)
 * derives `contextTrust: "high"` only when the `system_inferred` origin AND the
 * approved resolver identity both validate byte-for-byte — so this closes a
 * contradiction rather than a live inversion. It is the authority boundary, and
 * a boundary that trusts a distant producer's invariant is not a boundary.
 *
 * MISSING PROVENANCE IS NOT AUTHORIZATION. Authority now requires all three
 * facts to be PRESENT and to agree: `contextTrust === "high"`,
 * `resolverAuthorityValidated === true` and `inferenceConfidenceClass ===
 * "high"`. This predicate used to accept an entry that simply omitted the last
 * two, on the argument that absence is not a contradiction and that the only
 * runtime producer always populates them. Both halves of that argument are the
 * same mistake: it makes the authority of a hard budget, bid or promotion move
 * depend on an invariant held in a DIFFERENT module, which is exactly what a
 * boundary exists not to do. `readCampaignContextGuardState`
 * (lib/meta/snapshot.ts) copies both fields verbatim from
 * `readCampaignContextMap`, so today's production entries carry them and this
 * change moves no live row; what it removes is a caller — a replay script, a
 * future reader, a rehydrated payload written before the fields existed —
 * being able to unlock hard-action authority by saying less than the resolver
 * says.
 *
 * The refusal is not blanket: a fully provenanced entry still authorizes, and
 * `held-role-edges.test.ts` keeps that control beside the refusals.
 *
 * EXPORTED so there is ONE four-fact predicate rather than two. The paragraph
 * above names `readCampaignContextGuardState` (lib/meta/snapshot.ts) as the
 * module that copies these fields verbatim — and that module was itself still
 * deciding `campaignLabelsById` from the OLD two-fact test (`kind &&
 * contextTrust === "high" && source === "system_inferred"`). That map is not
 * this guard's authority, but it sets `campaignKind` for the calibration
 * contexts and the recommendation builders, and `campaignKind` is what drives
 * the test-cohort refresh transform. Leaving a second, looser copy of the same
 * question there would have re-created exactly the defect this predicate
 * exists to close, one module over. It moves no live row: the only runtime
 * producer mints `contextTrust: "high"` only when both validations pass.
 */
export function isContextTrustedForAction(
  entry: MetaCampaignContextGuardEntry | null | undefined,
): boolean {
  if (!entry) return false;
  if (entry.contextTrust !== "high" || entry.source !== "system_inferred") return false;
  if (entry.resolverAuthorityValidated !== true) return false;
  if (entry.inferenceConfidenceClass !== "high") return false;
  return true;
}

function automaticContextEvidence(
  rec: MetaRecommendation,
  entry: MetaCampaignContextGuardEntry | null,
): MetaRecommendation["evidence"] {
  if (rec.evidence.some((item) => item.label === "Campaign context")) {
    return rec.evidence;
  }
  const kind = entry?.kind ? ` · ${entry.kind}` : "";
  const resolverPending = isResolverValidationPending(entry);
  return [
    ...rec.evidence,
    {
      label: "Campaign context",
      value: resolverPending
        ? `Automatic high${kind} · resolver validation pending · review-only`
        : `Automatic ${entry?.inferenceConfidenceClass ?? entry?.contextTrust ?? "unknown"}${kind} · review-only`,
      tone: "warning" as const,
    },
  ];
}

function appendTransformEvidence(
  rec: MetaRecommendation,
  value: string,
): MetaRecommendation["evidence"] {
  const hasLabelEvidence = rec.evidence.some((item) => item.label === "Campaign role");
  const hasTransformEvidence = rec.evidence.some((item) => item.label === "Role transform");
  return [
    ...rec.evidence,
    ...(hasLabelEvidence
      ? []
      : [{ label: "Campaign role", value: "Test", tone: "neutral" as const }]),
    ...(hasTransformEvidence
      ? []
      : [{ label: "Role transform", value, tone: "warning" as const }]),
  ];
}

/*
  The two type sets above answer only WHETHER a recommendation carries a
  directional verdict at all. `decisionLabelForMetaRec` answers WHICH one, and
  it is the only mapper allowed to.

  Answering "which" from set membership here is what shipped the inversion:
  `scale_for_profitability` sits in SCALE_ACTION_TYPES, so this returned
  "scale" from the type name alone, `restrictAutomaticContextToReview` wrote
  that into `decisionLabel`, and Grandmix's "Claude-OtherCountries-DPA" went
  out with a Scale chip over "Reduce spend pressure, tighten the bid or
  audience, and reallocate budget toward stronger campaigns." (106 such rows,
  latest snapshot 2026-09-07). The label written here is both what the Decision
  Center adapter renders and what `recommendationToSnapshotRow` persists as
  `decision_label`, so the guard's guess reached the operator and the row.
*/
function explicitOrInferredDecisionLabel(rec: MetaRecommendation): MetaDecisionLabel | null {
  const carriesDirectionalVerdict =
    Boolean(rec.decisionLabel) ||
    REFRESH_ACTION_TYPES.has(rec.type) ||
    SCALE_ACTION_TYPES.has(rec.type);
  if (!carriesDirectionalVerdict) return null;
  return decisionLabelForMetaRec(rec);
}

/**
 * The verdict a held row must keep saying.
 *
 * INVARIANTS.md: "Automatic-context uncertainty must use canonical baselines and
 * preserve the mathematical Scale/Cut/Refresh verdict as review-only." D091 says
 * the same in the general form: the mathematical verdict and its specific held
 * reason stay visible, and `autoExecuteEligible` / provider-write eligibility
 * are a SEPARATE gate.
 *
 * `explicitOrInferredDecisionLabel` above answers a narrower question — whether
 * a rec carries a directional verdict by its own label or by refresh/scale set
 * membership — and returns null for every hard action outside those sets. A
 * held `bid_strategy_fit` therefore reached the operator with no
 * `decisionLabel` at all, and the Decision Center's blocked lane renders a
 * missing label as the generic "Needs review" (`buyerFacingStructureDecisionLabel`
 * in components/meta/decision-center/meta-decision-center-exact-adapter.ts).
 * The engine's own conclusion — Tune — was erased by the hold.
 *
 * The canonical mapper answers for every mapped type, so this asks it. What it
 * must NOT do is invent one: `decisionLabelForMetaRec` ends in a fallback that
 * returns `keep` (or `test_more`) for a type it has no case for, and
 * `budget_allocation` is exactly that type — the only member of
 * HARD_ACTION_TYPES with no case in that switch. Stamping `keep` on a held
 * budget reallocation would be an affirmative soft label on a blocked row,
 * which is the failure this function exists to prevent, so an unmapped hard
 * action keeps whatever label it already had and gets none from here.
 */
function heldVerdictLabel(rec: MetaRecommendation): MetaDecisionLabel | null {
  const canonical = decisionLabelForMetaRec(rec);
  if (rec.decisionLabel) return canonical;
  if (canonical === "keep" || canonical === "test_more") return null;
  return canonical;
}

/** Operator-facing noun for a held verdict, e.g. "Scale" for `scale`. */
function heldVerdictNoun(label: MetaDecisionLabel | null): string {
  if (!label) return "Hard action";
  const [first = "", ...rest] = label.replace(/_/g, " ");
  return `${first.toUpperCase()}${rest.join("")}`;
}

function labelFirstSummary(rec: MetaRecommendation, heldLabel: MetaDecisionLabel | null) {
  const subject = rec.campaignName ?? rec.adsetName ?? "This Meta entity";
  return `${subject} has a held ${heldVerdictNoun(heldLabel)} verdict, but automatic Main/Test/Mixed campaign context is unresolved. The verdict stays visible; refresh source evidence and rerun role inference before changing budgets, bids, or promotion flow.`;
}

function labelTransformPayload(input: {
  reason: typeof META_TEST_REFRESH_TO_CUT_REASON | typeof META_TEST_SCALE_TO_PROMOTE_REASON;
  rec: MetaRecommendation;
  toType: MetaRecommendationType;
  toDecisionLabel: MetaDecisionLabel;
}) {
  return {
    reason: input.reason,
    campaignKind: "test" as const,
    fromType: input.rec.type,
    toType: input.toType,
    fromDecisionLabel: explicitOrInferredDecisionLabel(input.rec),
    toDecisionLabel: input.toDecisionLabel,
  };
}

function transformTestRefreshToCut(rec: MetaRecommendation): MetaRecommendation {
  const transform = labelTransformPayload({
    reason: META_TEST_REFRESH_TO_CUT_REASON,
    rec,
    toType: rec.type,
    toDecisionLabel: "cut",
  });
  const subject = rec.campaignName ?? rec.adsetName ?? "Test campaign";
  return {
    ...rec,
    decisionLabel: "cut",
    labelTransform: transform,
    decision: "Cut failed test instead of refreshing it",
    title: `${subject}: cut test instead of refreshing`,
    why: `${rec.why} Because this campaign is automatically classified as Test with high confidence, a refresh signal means the test did not earn another iteration in the same container.`,
    summary: "A Test campaign with a refresh signal should be stopped or replaced, not refreshed in place like a Main campaign.",
    recommendedAction: "Cut or stop this Test lane and launch the next hypothesis separately; do not keep refreshing the same failed test container.",
    expectedImpact: "Prevents test budget from being trapped in repeated refresh cycles.",
    evidence: appendTransformEvidence(rec, "Refresh -> Cut"),
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      labelTransform: transform,
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      labelTransform: transform,
    },
  };
}

function transformTestScaleToPromotion(rec: MetaRecommendation): MetaRecommendation {
  const transform = labelTransformPayload({
    reason: META_TEST_SCALE_TO_PROMOTE_REASON,
    rec,
    toType: "promote_test_to_main",
    toDecisionLabel: "scale",
  });
  const subject = rec.campaignName ?? rec.adsetName ?? "Test campaign";
  return {
    ...rec,
    id: rec.id.startsWith("promote-test-to-main-")
      ? rec.id
      : `promote-test-to-main-${rec.id}`,
    type: "promote_test_to_main",
    decisionLabel: "scale",
    labelTransform: transform,
    decision: "Promote winning test to Main",
    title: `${subject}: promote winning test to Main`,
    why: `${rec.why} Because this campaign is automatically classified as Test with high confidence, the scale verdict becomes a promotion decision instead of simply increasing Test spend.`,
    summary: "The test appears validated; move the winning setup into a Main lane before scaling.",
    recommendedAction: "Promote the validated Test setup into a Main campaign or Main ad set lane, then scale from the Main structure under normal guardrails.",
    expectedImpact: "Separates validation budget from scale budget and keeps Test campaigns from becoming accidental Main campaigns.",
    evidence: appendTransformEvidence(rec, "Scale -> Promote to Main"),
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      labelTransform: transform,
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      labelTransform: transform,
    },
  };
}

function applyTestCampaignSemantics(
  rec: MetaRecommendation,
  labelMap: MetaCampaignLabelKindMap,
) {
  if (rec.kind === "state" || rec.kind === "anomaly") return rec;
  if (isAlreadyLabelTransformed(rec)) return rec;
  if (!rec.campaignId || labelMap.get(rec.campaignId) !== "test") return rec;
  const label = explicitOrInferredDecisionLabel(rec);
  if (label === "refresh") return transformTestRefreshToCut(rec);
  if (label === "scale") return transformTestScaleToPromotion(rec);
  return rec;
}

/**
 * The circuit-breaker fallback: no automatic context is available AT ALL.
 *
 * Reached when `automaticContextEnabled` is false, which today means
 * `CAMPAIGN_CONTEXT_MODE=unknown` — `resolveCampaignContextMode`
 * (lib/creative-decision-engine/campaign-context/source.ts) returns `automatic`
 * for every other value, and `readCampaignContextGuardState`
 * (lib/meta/snapshot.ts) passes `mode === "automatic"` straight through.
 *
 * It writes a state row, and that is deliberate: with role semantics globally
 * off, the row must not look actionable. What was NOT deliberate is that it
 * also wrote `decisionLabel: "diagnose"` over the engine's conclusion, so a
 * held Scale and a held Cut came out of this branch indistinguishable from each
 * other and from a genuine diagnostic. INVARIANTS.md requires the opposite:
 * "Automatic-context uncertainty must ... preserve the mathematical
 * Scale/Cut/Refresh verdict as review-only."
 *
 * The verdict now survives in `decisionLabel`, in the summary, in the "Blocked
 * action" evidence and as a typed `blocked_decision_label`. Nothing about the
 * hold weakens: `kind: "state"` plus `decisionState: "watch"` keep
 * `deriveMetaAutomationReadiness` on its read-only branch
 * (lib/meta/automation-readiness.ts), lane assignment in
 * app/api/meta/lane-classify/route.ts reads `decisionState` and
 * `confidenceScore` rather than the label, and the confidence cap is unchanged.
 */
function downgradeToSoftOnly(rec: MetaRecommendation): MetaRecommendation {
  const cappedScore = Math.min(confidenceScore(rec), META_CAMPAIGN_LABEL_CONFIDENCE_CAP);
  const heldLabel = heldVerdictLabel(rec);
  const heldNoun = heldVerdictNoun(heldLabel);
  return {
    ...rec,
    kind: "state",
    decisionLabel: heldLabel ?? rec.decisionLabel ?? "diagnose",
    stateReason: "The automatic campaign role is unresolved. The engine will not emit hard scale, cut, bid, or budget moves until fresh evidence resolves Main, Test, or Mixed.",
    decisionState: "watch",
    confidence: "low",
    confidenceScore: cappedScore,
    confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    priority: rec.priority === "high" ? "medium" : rec.priority,
    decision: `${heldNoun} held until the campaign role resolves`,
    title: `${rec.campaignName ?? rec.adsetName ?? "Campaign"}: ${heldNoun} held, automatic role unresolved`,
    why: `${rec.why} Automatic campaign-role inference is unresolved, so this ${heldNoun} verdict stays visible but is capped to soft-only until fresh Main/Test/Mixed context is available.`,
    summary: labelFirstSummary(rec, heldLabel),
    recommendedAction: "Refresh the account evidence and rerun automatic campaign-role inference, then review the Meta recommendation again before changing budget, bids, or promotion flow.",
    expectedImpact: "Prevents the engine from treating Main and Test campaigns as interchangeable for hard actions.",
    evidence: appendGuardEvidence(rec, heldLabel),
    // D074b: even the no-context fallback speaks the automatic-role
    // vocabulary; the legacy keys survive as recognition-only aliases.
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      quality_status: "campaign_context_unresolved",
      confidence_cap: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      campaign_context_status: "unavailable",
      campaign_context_action_authority: "review_only",
      // `blocked_action_type` here is the PRODUCER TYPE, not a verdict. The
      // identically named column on `engine_v3_decision_snapshots_daily` is
      // `CHECK (blocked_action_type IN ('scale','cut','refresh'))` and matches
      // `MetaDecisionSemanticProjection.heldAction` (lib/meta/decision-semantics.ts).
      // No reader in this repository consumes this signal-quality key, so the
      // shape stays as persisted payloads carry it and the held verdict is
      // published beside it under its own typed key instead.
      blocked_action_type: rec.type,
      blocked_decision_label: heldLabel,
      blocked_decision_state: rec.decisionState,
      blocked_confidence_score: rec.confidenceScore ?? null,
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    },
  };
}

function restrictAutomaticContextToReview(
  rec: MetaRecommendation,
  entry: MetaCampaignContextGuardEntry | null,
): MetaRecommendation {
  const cappedScore = Math.min(
    confidenceScore(rec),
    META_CAMPAIGN_LABEL_CONFIDENCE_CAP,
  );
  const resolverPending = isResolverValidationPending(entry);
  return {
    ...rec,
    // `heldVerdictLabel`, not `explicitOrInferredDecisionLabel`: the narrower
    // reader returns null for every hard action outside the refresh/scale sets,
    // which left held `bid_strategy_fit`, `historical_bid_regime_fit` and
    // `scenario_*` tune/switch/swap rows with no label for the blocked lane to
    // render. @see heldVerdictLabel
    decisionLabel: heldVerdictLabel(rec) ?? rec.decisionLabel,
    decisionState: "watch",
    confidence: "low",
    confidenceScore: cappedScore,
    confidenceReason: resolverPending
      ? META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON
      : META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    priority: rec.priority === "high" ? "medium" : rec.priority,
    why: resolverPending
      ? `${rec.why} Automatic Main/Test/Mixed inference is high confidence, but this resolver version has not passed the independent authority gate; the decision remains explicit and provider execution is review-only.`
      : `${rec.why} Automatic Main/Test/Mixed context is ${entry?.contextTrust ?? "unknown"}; the decision remains explicit but provider execution is review-only.`,
    evidence: automaticContextEvidence(rec, entry),
    campaignContext: {
      kind: entry?.kind ?? null,
      source: entry?.source ?? "unknown",
      confidence:
        entry?.inferenceConfidenceClass ?? entry?.contextTrust ?? "unknown",
      trustedForAction: false,
    },
    signalQuality: {
      ...(rec.signalQuality ?? {}),
      campaign_context_status: entry?.contextTrust ?? "unknown",
      campaign_context_source: entry?.source ?? "unknown",
      campaign_context_kind: entry?.kind ?? null,
      campaign_context_action_authority: resolverPending
        ? "resolver_unvalidated"
        : "review_only",
    },
    calibrationScope: {
      ...(rec.calibrationScope ?? {}),
      campaign_context_reason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    },
  };
}

function campaignContextEntryForRec(
  rec: MetaRecommendation,
  activeCampaignIds: readonly string[],
  contextById: MetaCampaignContextGuardMap,
) {
  const campaignIds = campaignIdsForRec(rec, activeCampaignIds);
  if (campaignIds.length !== 1) return null;
  return contextById.get(campaignIds[0]!) ?? null;
}

/**
 * Corrects an inherited affirmative direction, on EVERY path through the guard.
 *
 * `restrictAutomaticContextToReview` was the only place this guard wrote
 * `decisionLabel`, and it runs only when the campaign's automatic role is
 * UNRESOLVED. All 106 live `scale_for_profitability` rows sit on that branch
 * today (105 `review_only` + 1 `resolver_unvalidated`), so repairing it repaired
 * the visible surface — but those rows are waiting on exactly the resolver
 * authority whose arrival moves them to the resolved branch, where the guard
 * returns the rec untouched. The inverted Scale chip would have come back the
 * day the resolver was trusted, which is the day nobody would be looking for it.
 *
 * Only an affirmative `scale` is overruled, and only when the canonical reader
 * disagrees with it. A builder's own `cut`, `tune`, `keep` or `refresh` is never
 * rewritten here, and a rec the reader has no opinion about is returned as-is.
 */
function withCanonicalDirection(rec: MetaRecommendation): MetaRecommendation {
  if (rec.decisionLabel !== "scale") return rec;
  const canonical = decisionLabelForMetaRec(rec);
  if (canonical === "scale") return rec;
  return { ...rec, decisionLabel: canonical };
}

export function applyMetaCampaignLabelGuard(input: {
  recommendations: MetaRecommendation[];
  campaignLabelsById: MetaCampaignLabelKindMap | null | undefined;
  campaignContextById?: MetaCampaignContextGuardMap | null;
  automaticContextEnabled?: boolean;
  activeCampaignIds?: readonly string[];
}): MetaCampaignLabelGuardResult {
  // The old campaignLabelsById argument is retained only to keep frozen
  // snapshot callers source-compatible. Runtime authority is rebuilt solely
  // from fresh high-confidence automatic context below; a manual-role map can
  // no longer unlock kind semantics or a provider action.
  const labelMap = new Map<string, MetaCampaignKind>();
  const contextById =
    input.campaignContextById ?? new Map<string, MetaCampaignContextGuardEntry>();
  for (const [campaignId, entry] of contextById) {
    // @see isContextTrustedForAction — this is the single authority predicate;
    // `trustedForAction` below must never diverge from it.
    if (entry.kind && isContextTrustedForAction(entry)) {
      labelMap.set(campaignId, entry.kind);
    }
  }
  const activeCampaignIds = Array.from(new Set(input.activeCampaignIds ?? []));
  const unlabeledCampaignIds = new Set<string>();
  let downgradedCount = 0;
  let accountLevelDowngraded = false;

  const recommendations = input.recommendations.map((candidate) => {
    const contextEntry = campaignContextEntryForRec(
      candidate,
      activeCampaignIds,
      contextById,
    );
    const rec = applyTestCampaignSemantics(
      attachCampaignKind(candidate, labelMap, activeCampaignIds),
      labelMap,
    );
    const contextAnnotatedRec = contextEntry
      ? {
          ...rec,
          campaignContext: {
            kind: contextEntry.kind,
            source: contextEntry.source,
            confidence:
              contextEntry.inferenceConfidenceClass ??
              contextEntry.contextTrust,
            trustedForAction: isContextTrustedForAction(contextEntry),
          },
        }
      : rec;
    // Applied before every branch below, so the correction does not depend on
    // which one a row happens to take. @see withCanonicalDirection
    const directionCorrected = withCanonicalDirection(contextAnnotatedRec);
    if (isAlreadyGuarded(rec) || !isHardAction(rec)) {
      return directionCorrected;
    }

    const campaignIds = campaignIdsForRec(rec, activeCampaignIds);
    const isUnlabeled =
      campaignIds.length === 0 ||
      campaignIds.some((campaignId) => !hasMetaCampaignLabel(campaignId, labelMap));
    if (!isUnlabeled) {
      return directionCorrected;
    }

    downgradedCount += 1;
    if (rec.level === "account") accountLevelDowngraded = true;
    for (const campaignId of campaignIds) {
      if (!hasMetaCampaignLabel(campaignId, labelMap)) unlabeledCampaignIds.add(campaignId);
    }
    return input.automaticContextEnabled
      ? restrictAutomaticContextToReview(rec, contextEntry)
      : downgradeToSoftOnly(rec);
  }).map(withMetaAutomationReadiness);

  return {
    recommendations,
    downgradedCount,
    unlabeledCampaignIds: Array.from(unlabeledCampaignIds).sort(),
    accountLevelDowngraded,
  };
}
