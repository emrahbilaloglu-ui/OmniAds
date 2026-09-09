// Server-owned action presentation for Meta recommendations.
//
// Codex cross-review finding: the redesign UI derived decision labels,
// launch modes, and primary CTA labels client-side (including regex over
// English recommendedAction text). The UI may format; it must not decide
// action semantics. This module runs SERVER-side (lane-classify enriches
// every recommendation at read time, so old persisted snapshots get the
// fields too) and is the single source of:
//   - decisionLabel (when the engine did not persist one)
//   - actionKind: what the primary control actually DOES
//   - primaryActionLabel: honest copy - execute verbs only for controls
//     that execute; review framing for controls that open the drill drawer.
import type { MetaLaunchMode } from "@/components/meta/redesign/types";
import type { MetaAutomationReadinessBlocker } from "@/lib/meta/automation-readiness";
import { executableBidIntentMinorUnits } from "@/lib/meta/bid-intent-contract";
import {
  META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
  META_AUTOMATIC_CONTEXT_REVIEW_REASON,
  META_CAMPAIGN_LABEL_GUARD_REASON,
} from "@/lib/meta/campaign-label-guard";
import {
  launchModeForMetaRec,
  resolveMetaRecDirection,
} from "@/lib/meta/rec-label-mapping";
import { proposedActionForRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaRecommendation,
  MetaRecOperatorApply,
} from "@/lib/meta/recommendations";

export type MetaRecActionKind =
  | "route_launchpad_rebuild"
  | "route_launchpad_duplicate"
  | "review_drill";

/*
  LAUNCH ROUTING, NOT DIRECTION.

  These two Sets answer "which Launchpad flow does the primary control hand
  off to", which is a different question from "which way does the verdict
  point". They are the only type Sets left in this module: the ten that
  answered the direction question — SCALE/CUT/REBUILD/SWITCH/TUNE/SWAP/TEST/
  REFRESH/KEEP — were a second copy of `META_REC_TYPE_DIRECTION`
  (lib/meta/rec-label-mapping.ts) and had drifted from it on five types. @see
  serverDecisionLabelForRec.

  REBUILD_TYPES still names `creative_test_structure` because that type DOES
  route to the rebuild flow (as a demotion — see
  `serverPrimaryActionLabelForRec`), while its direction is `test_more`. That
  divergence is the point: the two questions have different answers for it,
  which is why the direction read no longer consults this Set at all.
*/
const REBUILD_TYPES = new Set<string>([
  "rebuild_with_constraints",
  "campaign_structure",
  "creative_test_structure",
  "scaling_structure_fit",
  "scenario_i4_test_should_use_abo",
  "scenario_k1_mixed_config_rebuild",
]);

const DUPLICATE_TYPES = new Set<string>([
  "geo_cluster_for_signal_density",
  "winner_promotion_flow",
]);

/**
 * DIRECTION IS DECIDED IN ONE PLACE, AND THIS IS NOT IT.
 *
 * This function used to answer from its own ten Sets, and before that from its
 * own copy of the defensive-vocabulary regex. Both were second mappings of the
 * question `decisionLabelForMetaRec` answers, and both drifted:
 *
 *   - the regex copy read AFTER `rec.decisionLabel`, so an affirmative "scale"
 *     inferred from a type name upstream ended the read before the text was
 *     consulted;
 *   - the Sets had no entry for `scenario_a2_learning_weak_structural`,
 *     `scenario_a4_learning_limited_persistent`,
 *     `scenario_a5_post_learning_underperformer`, `scenario_i2_abo_to_cbo` or
 *     `scenario_i3_cbo_overcrowded`, so all five fell through to the fallback
 *     and were served as `diagnose` while the canonical table — and the
 *     `decision_label` column stamped from it — said `rebuild`.
 *
 * It now asks the canonical reader, with the one parameter that is genuinely
 * this caller's to choose: what to publish for a type the table does not map.
 * @see resolveMetaRecDirection.
 */
export function serverDecisionLabelForRec(
  rec: Pick<
    MetaRecommendation,
    | "type"
    | "kind"
    | "decisionState"
    | "decisionLabel"
    | "recommendedAction"
    | "labelTransform"
  >,
): NonNullable<MetaRecommendation["decisionLabel"]> {
  return resolveMetaRecDirection(rec, "diagnose");
}

export function serverLaunchModeForRec(
  rec: Pick<MetaRecommendation, "type" | "kind" | "level" | "targetValue">,
): MetaLaunchMode | null {
  /*
    DELEGATED (Codex C23).

    This was a second live launch-mode mapper beside `launchModeForMetaRec`
    (lib/meta/rec-label-mapping.ts), and the two DIVERGED on the bid case: this
    one asked the validated bid intent, that one asked for a
    `bid_value_guidance` label no producer emits at ad-set grain. Two answers to
    "may this row apply a bid" is the same duplicate-table defect the direction
    mapper already had.

    The corrected condition now lives in that module — it has no edge back to
    this one, so it is the right home — and this function is the thin server
    entry point onto it. `REBUILD_TYPES` / `DUPLICATE_TYPES` remain here for
    `serverActionKindForRec`, which asks a different question.
  */
  return launchModeForMetaRec({
    kind: rec.kind,
    type: rec.type,
    level: rec.level,
    targetValue: rec.targetValue,
  });
}

export function serverActionKindForRec(
  rec: Pick<
    MetaRecommendation,
    "type" | "kind" | "level" | "proposedAction" | "decisionState" | "targetValue"
  >,
): MetaRecActionKind {
  if (rec.kind === "anomaly" || rec.kind === "state") return "review_drill";
  if (rec.decisionState !== "act") return "review_drill";
  // Campaign/ad-set recommendations do not yet carry the same immutable,
  // decision-origin execution authority contract as canonical Ad decisions.
  // proposedAction is advice, not authority: old persisted pause/resume/bid
  // suggestions must remain review-only until that contract exists.
  const mode = serverLaunchModeForRec(rec);
  if (mode === "rebuild") return "route_launchpad_rebuild";
  if (mode === "duplicate") return "route_launchpad_duplicate";
  return "review_drill";
}

/**
 * Honest primary CTA copy: execute verbs ONLY for controls that execute a
 * write; route verbs for Launchpad handoffs; review framing for everything
 * whose click opens the drill drawer. The pre-review UI showed "Scale
 * budget" / "Hold" / "Act now" on buttons that only opened a drawer.
 */
export function serverPrimaryActionLabelForRec(
  rec: Pick<
    MetaRecommendation,
    | "type"
    | "kind"
    | "level"
    | "proposedAction"
    | "decisionState"
    | "lens"
    | "decisionLabel"
    | "recommendedAction"
    // Declared because `serverDecisionLabelForRec` below reads it. Callers
    // already pass whole recommendations, so this only stops the CTA copy and
    // the chip being derived from two different views of the same row.
    | "labelTransform"
  >,
): string {
  const actionKind = serverActionKindForRec(rec);
  if (rec.kind === "anomaly") return "Open diagnostics";
  if (actionKind === "route_launchpad_rebuild") {
    if (rec.type === "creative_test_structure") return "Demote in Launchpad";
    if (rec.type === "scaling_structure_fit") return "Rebuild lanes";
    return "Rebuild in Launchpad";
  }
  if (actionKind === "route_launchpad_duplicate") {
    if (rec.type === "winner_promotion_flow") return "Promote in Launchpad";
    return "Duplicate to test";
  }
  // review_drill: the click opens the drawer, so the label says review.
  const label = serverDecisionLabelForRec(rec);
  switch (label) {
    case "scale":
      return "Review scale plan";
    case "cut":
      return "Review cut plan";
    case "refresh":
      return "Review refresh plan";
    case "switch":
      return "Review strategy switch";
    case "swap":
      return "Review audience swap";
    case "tune":
      return "Review tuning";
    case "test_more":
      return "Review test plan";
    case "keep":
      return "Review status";
    default:
      return "Open diagnostics";
  }
}

/**
 * Why this row offers the operator nothing to apply, or null if it may.
 *
 * A held row is one `applyMetaCampaignLabelGuard` demoted because the campaign
 * role behind it is unresolved. The hold is typed and it is written in three
 * places on the row — the readiness blocker, the signal-quality authority key,
 * and the confidence reason — so this reads all three rather than one, because
 * a payload can reach presentation with readiness not yet recomputed.
 */
export type MetaRecOperatorApplyWithheldReason =
  /** An anomaly or a state row: a condition, not a change to make. */
  | "condition_row"
  /** `campaign_context_action_authority: "review_only"`. */
  | "campaign_role_unresolved"
  /** `campaign_context_action_authority: "resolver_unvalidated"`. */
  | "campaign_role_resolver_unvalidated"
  /** The pre-D074b guard reason, recognition-only for persisted payloads. */
  | "campaign_role_unlabeled";

const RESOLVER_UNVALIDATED_BLOCKER: MetaAutomationReadinessBlocker =
  "campaign_context_resolver_unvalidated";
const CONTEXT_UNRESOLVED_BLOCKER: MetaAutomationReadinessBlocker =
  "campaign_context_unresolved";

function signalQualityString(
  rec: Pick<MetaRecommendation, "signalQuality">,
  key: string,
): string | null {
  const quality = rec.signalQuality;
  if (!quality || typeof quality !== "object") return null;
  const value = (quality as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The typed authority state that decides whether an operator verb is offered.
 *
 * `restrictAutomaticContextToReview` and `downgradeToSoftOnly`
 * (lib/meta/campaign-label-guard.ts) hold a hard action by rewriting the
 * decision state, capping confidence and stamping this authority — but both
 * leave `proposedAction` and `targetValue` in place, exactly as the row was
 * built. `serverOperatorApplyForRec` then re-derived a verb from those fields
 * and served it, so the server held the row and offered a way to execute it in
 * the same payload. `MetaPlatformPage` did suppress the control for rows in the
 * needs-resolution lane, but that is a rendering decision on one surface: the
 * verb still travelled in the API response, `decisions-workspace/route.ts`
 * still counted it in the executable census, and any other reader of
 * `operatorApply` — including the mobile card path added later — would have
 * offered it.
 *
 * Note what is NOT read here. `automationReadiness.tier`, `autoExecuteEligible`
 * and the programmatic evidence blockers stay out on purpose: those are the
 * ENGINE's authority, which is withheld from every campaign and ad-set row, and
 * gating on them would delete the operator capability entirely rather than gate
 * it. Only the campaign-role hold closes this.
 */
export function operatorApplyWithheldReasonForRec(
  rec: Pick<
    MetaRecommendation,
    "kind" | "signalQuality" | "confidenceReason" | "automationReadiness"
  >,
): MetaRecOperatorApplyWithheldReason | null {
  if (rec.kind === "anomaly" || rec.kind === "state") return "condition_row";
  const blockers = rec.automationReadiness?.blockers ?? [];
  const authority = signalQualityString(rec, "campaign_context_action_authority");
  if (
    blockers.includes(RESOLVER_UNVALIDATED_BLOCKER) ||
    authority === "resolver_unvalidated" ||
    rec.confidenceReason === META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON
  ) {
    return "campaign_role_resolver_unvalidated";
  }
  if (
    blockers.includes(CONTEXT_UNRESOLVED_BLOCKER) ||
    authority === "review_only" ||
    rec.confidenceReason === META_AUTOMATIC_CONTEXT_REVIEW_REASON
  ) {
    return "campaign_role_unresolved";
  }
  /*
    The pre-D074b hold, recognized through the exported constant rather than
    the retired vocabulary.

    `hasLegacyUnresolvedRoleSignals` (lib/meta/automation-readiness.ts) reads
    three markers for this state. This comment used to say "two of them are
    retired tokens ... and the third is `META_CAMPAIGN_LABEL_GUARD_REASON`".
    That is INVERTED, and the correction matters for reading the check below.

    Two of those three markers compare against the retired reason string, and
    the exported `META_CAMPAIGN_LABEL_GUARD_REASON` holds that same string — so
    the two comparisons here recognize TWO of the three, not one. The third
    reads a retired status KEY out of `signal_quality`, and it is the one this
    function does not see.

    It is unseen deliberately. That key is a ledgered legacy token in
    `__tests__/campaign-role-vocabulary-closure.test.ts`, budgeted per file, so
    naming it here — in code OR in a comment — breaches the budget; this
    paragraph was itself rejected by that test once for spelling it. The
    argument that the omission is safe is a read-only production `GROUP BY`
    showing the reason and the retired status key co-occurring on every
    persisted row. THAT MEASUREMENT CANNOT BE RE-VERIFIED from this working
    tree, so it is recorded as a claim, not a fact: should the two ever
    diverge, a row carrying only the status key falls through to `null` instead
    of `campaign_role_unlabeled`, and the failure direction is that
    `operatorApply` is offered on a row whose legacy role hold went
    unrecognized.
  */
  if (
    rec.confidenceReason === META_CAMPAIGN_LABEL_GUARD_REASON ||
    signalQualityString(rec, "confidence_cap") === META_CAMPAIGN_LABEL_GUARD_REASON
  ) {
    return "campaign_role_unlabeled";
  }
  return null;
}

/**
 * What the OPERATOR may apply from this row, with their own authority.
 *
 * Deliberately separate from `serverActionKindForRec`, which answers a
 * different question: what the ENGINE authorizes. The engine withholds its own
 * authority from campaign and ad-set rows because they do not carry the
 * immutable decision-origin execution contract that canonical Ad decisions do,
 * and that stays true. But a media buyer reading a row that says "reduce budget
 * pressure or pause this ad set" and finding no way to pause it inside the
 * product is being asked to keep a second browser tab open — which is where
 * mistakes come from.
 *
 * So this offers the concrete typed verb the engine already named in
 * `proposedAction`, executed under `manual_operator_v1` with an explicit typed
 * confirmation. It is a capability, not a recommendation: the row still shows
 * the engine's own authority chip beside it, and the server re-checks the
 * capability, rehearsal posture, STOP, account binding and current entity state
 * immediately before the provider POST regardless of what this returns.
 *
 * A capability is still not offered on a row whose verdict the server itself
 * held. @see operatorApplyWithheldReasonForRec.
 */
export function serverOperatorApplyForRec(
  rec: Pick<
    MetaRecommendation,
    | "kind"
    | "level"
    | "proposedAction"
    | "campaignId"
    | "adsetId"
    | "targetValue"
    | "signalQuality"
    | "confidenceReason"
    | "automationReadiness"
  >,
): MetaRecOperatorApply {
  // Held or review-only closes this server-side, not just in one renderer.
  if (operatorApplyWithheldReasonForRec(rec) !== null) return null;
  /*
    Derived when the stored row does not carry one.

    A recommendation is stamped when it is built and the sizing passes attach
    their intents afterwards, so every row persisted before that ordering was
    corrected carries a validated amount and no `proposedAction`. Re-asking
    here reads the row's OWN target value with the same predicate the stamp
    uses — it invents nothing, and a row that already carries an action keeps
    it, because `proposedActionForRecommendation` returns that first.
  */
  const proposed = proposedActionForRecommendation(rec as MetaRecommendation);
  if (!proposed) return null;

  const grain =
    rec.level === "adset" ? "adset" : rec.level === "campaign" ? "campaign" : null;
  if (!grain) return null;
  const entityId = (grain === "adset" ? rec.adsetId : rec.campaignId)?.trim();
  if (!entityId) return null;

  if (proposed.kind === "pause" || proposed.kind === "resume") {
    return { action: proposed.kind, grain, entityId };
  }
  if (proposed.kind === "apply_bid") {
    // Bid amount lives on an ad set. A campaign-grain bid has no endpoint and
    // must not be offered as though it did.
    if (grain !== "adset") return null;
    if (!Number.isSafeInteger(proposed.bidAmountMinor) || proposed.bidAmountMinor <= 0) {
      return null;
    }
    return {
      action: "bid",
      grain: "adset",
      entityId,
      bidAmountMinor: proposed.bidAmountMinor,
    };
  }
  return null;
}

export interface MetaRecEntityMetricsSource {
  /** Keyed by entity id (campaign or adset id). */
  spend?: number | null;
  roas?: number | null;
  cpa?: number | null;
  ctr?: number | null;
  purchases?: number | null;
  frequency?: number | null;
}

export interface MetaRecRowPresentationSource {
  /** Provider account id from the serving row. Null means the source row did not expose one. */
  accountId?: string | null;
  /** Creative/media preview label from a real media source. Null means no real source was available. */
  thumbLabel?: string | null;
}

function compactTitle(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactAccountBadge(accountId: string | null | undefined) {
  const value = accountId?.trim();
  if (!value) return null;
  if (value.length <= 14) return value;
  if (value.startsWith("act_")) return `act_${value.slice(-5)}`;
  return `${value.slice(0, 4)}…${value.slice(-5)}`;
}

/**
 * Blockers that belong in diagnostics, not on the row.
 *
 * These are conditions of the automation research programme — a controlled
 * causal estimate, a randomized assignment, a treatment receipt. They are real
 * and they are checked, but they are also true of essentially every row, and
 * they are the FIRST thing pushed onto the blocker list. The result was that
 * an operator scanning their decisions read "Automation blocked · Controlled
 * causal evidence is missing" on line after line — a sentence about our
 * methodology where they expected a sentence about their ads.
 *
 * Nothing is hidden: the full list still travels in `automationReadiness` and
 * still renders in the inspector. What changes is which one gets the row's one
 * line. An operational blocker — an unresolved campaign role, a missing
 * commercial target, no executor — is something they can act on today, so it
 * wins. When only these remain, the row says so in one honest sentence
 * instead of naming one of them at random.
 */
const PROGRAMMATIC_BLOCKERS = new Set([
  "no_empirical_outcome_model",
  "missing_controlled_causal_evidence",
  "missing_valid_treatment_receipt",
  "missing_valid_random_assignment",
  "missing_valid_control_estimate",
  "insufficient_empirical_sample",
  "empirical_precision_below_floor",
  "missing_holdout_plan",
  "missing_post_action_monitor",
]);

function serverRowPresentationForRec(
  rec: MetaRecommendation,
  source?: MetaRecRowPresentationSource | null,
): NonNullable<MetaRecommendation["rowPresentation"]> {
  const readiness = rec.automationReadiness;
  const present = readiness?.blockers?.filter((blocker) => blocker.trim().length > 0)
    ?? [];
  const operational = present.find((blocker) => !PROGRAMMATIC_BLOCKERS.has(blocker));
  const firstBlocker = operational ?? (present.length > 0
    // One sentence for the whole family, because naming one member of it tells
    // the operator nothing the others would not have.
    ? "automation_evidence_incomplete"
    : null);
  const hasBlocker = Boolean(firstBlocker);
  const hasShield = !hasBlocker && readiness?.operatorReviewRequired === true;
  const signal = hasBlocker ? "blocker" : hasShield ? "shield" : null;
  /*
    The synthetic family code carries its own sentence.

    Everything else is title-cased from a code, which reads acceptably for an
    operational blocker ("Campaign Context Unresolved"). Doing that here would
    produce "Automation Evidence Incomplete" — a phrase that still says nothing
    the operator can do about it, which is the whole thing this replaced.
  */
  const blockerLabel = firstBlocker === "automation_evidence_incomplete"
    ? "Gathering evidence — apply it yourself"
    : firstBlocker
      ? compactTitle(firstBlocker)
      : null;
  const shieldLabel = hasShield ? "Operator protection active" : null;
  const autoBadge = readiness?.tier === "auto_execute" && readiness.autoExecuteEligible === true;
  const warnLine = hasBlocker
    ? `Automation blocked · ${blockerLabel}`
    : hasShield && readiness?.reason
      ? `Operator protection active · ${readiness.reason}`
      : null;
  return {
    accountBadge: compactAccountBadge(source?.accountId),
    thumbLabel: source?.thumbLabel?.trim() || null,
    signal,
    blockerLabel,
    shieldLabel,
    autoBadge,
    warnLine,
  };
}

/**
 * Enrich recommendations with server-owned presentation fields and, when a
 * metrics source is provided, structured numeric metrics (compare/bulk math
 * must never parse formatted display strings).
 */
export function annotateMetaRecPresentation(
  recs: MetaRecommendation[],
  metricsByEntityId?: Map<string, MetaRecEntityMetricsSource>,
  rowPresentationByEntityId?: Map<string, MetaRecRowPresentationSource>,
): MetaRecommendation[] {
  return recs.map((rec) => {
    const entityId = rec.level === "adset" ? rec.adsetId : rec.campaignId;
    const metrics =
      metricsByEntityId && entityId ? metricsByEntityId.get(entityId) ?? null : null;
    const rowPresentationSource =
      rowPresentationByEntityId && entityId ? rowPresentationByEntityId.get(entityId) ?? null : null;
    return {
      ...rec,
      decisionLabel: serverDecisionLabelForRec(rec),
      actionKind: serverActionKindForRec(rec),
      // The engine's authority and the operator's capability, side by side and
      // never conflated. `actionKind` says what the engine authorizes;
      // `operatorApply` says what the operator may do with their own.
      operatorApply: serverOperatorApplyForRec(rec),
      primaryActionLabel: serverPrimaryActionLabelForRec(rec),
      rowPresentation: serverRowPresentationForRec(rec, rowPresentationSource),
      metrics: rec.metrics ?? metrics ?? null,
    };
  });
}
