import type {
  BriefingActionItem,
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";
import type { CreativeStudioTone } from "@/components/creatives/creative-studio-exact-types";

export type CreativeDecisionReadState = "loading" | "available" | "unavailable";

/**
 * The Creative Studio Status column's ONLY source of truth.
 *
 * The engine already classifies every creative it evaluates, and
 * `/api/creatives/briefing` — which the Studio page has always fetched and,
 * until now, threw away — publishes that classification per card. This module
 * indexes those cards and hands the Assets table the server's own word. It
 * computes no classification, derives none from metrics or badges, and invents
 * no vocabulary. Every string it can produce comes from a server field or from
 * the frozen display maps below, which only case and space the engine's own
 * enum members.
 *
 * MEASURED on TheSwaf (act_822913786458311, 2026-07-21..2026-08-17) against the
 * live dev server: 96 Assets rows, 750 briefing cards over 610 distinct
 * creative ids. Joining on `creative_id` matched 96 of 96 rows — no misses. Of
 * those, 94 had one served label and 2 (`1265243152216239`,
 * `1654468745616283`, two ads each) had two, `test_more` and `diagnose`. The
 * served distribution over the 94 was test_more 57, cut 21, keep 11,
 * diagnose 5.
 */

/**
 * Why the join key is the creative id and not the row id.
 *
 * The Assets table is creative-grain (`groupBy=creative`) and its `id` is a
 * synthesised handle — `creative_1jcu3ue` on the live account — while the
 * briefing is ad-grain and keys on the provider's real creative id
 * (`1410136187640001`). Joining on `id` matches nothing; measured, it matched
 * 0 of 96. `MetaCreativeRow.creativeId` carries the provider id and is what
 * this module keys on.
 */
export interface ServedCreativeClassification {
  /** The label to render, verbatim from the server's buyer-facing vocabulary. */
  label: string;
  tone: CreativeStudioTone;
  /** Server-owned queue state, display-cased without changing its meaning. */
  segment: string | null;
  /** Buyer-facing context for the served recommendation. */
  detail: string | null;
  /** Number of distinct server decisions represented by this creative row. */
  decisionCount: number;
  /**
   * Which served field this came from. `assessment` is the richer server-owned
   * vocabulary (`Proven winner`, `Fatigued former winner`, `Learning`, …);
   * `decision_label` is the engine's decision label, which is what the live
   * briefing publishes today. Carried so the surface can be audited without
   * guessing which branch produced a cell.
   */
  source: "canonical_decision" | "assessment" | "decision_label";
}

export interface CreativeDecisionStatusFallback {
  label: string;
  tone: CreativeStudioTone;
  segment: null;
  detail: string | null;
  decisionCount: 0;
  source: "read_state";
}

/**
 * The engine's `DecisionLabel` union, cased for reading.
 *
 * `lib/creative-decision-engine/types.ts:23` defines exactly these seven
 * members. The keys stay internal; only reviewed buyer labels reach the
 * Creative Studio. A future label that is absent from this map remains
 * available to the decision pipeline without exposing its raw enum in the UI.
 */
const DECISION_LABEL_DISPLAY: Readonly<
  Record<string, { label: string; tone: CreativeStudioTone }>
> = Object.freeze({
  scale: { label: "Scale", tone: "positive" },
  keep: { label: "Keep", tone: "neutral" },
  refresh: { label: "Refresh", tone: "warning" },
  cut: { label: "Cut", tone: "negative" },
  test_more: { label: "Test more", tone: "info" },
  diagnose: { label: "Diagnose", tone: "warning" },
  out_of_scope: { label: "Out of scope", tone: "neutral" },
});

/**
 * `MetaCreativeAssessmentTone` -> this surface's tone vocabulary.
 * `lib/meta/creative-assessment.ts:6` owns the left-hand side.
 */
const ASSESSMENT_TONE: Readonly<Record<string, CreativeStudioTone>> =
  Object.freeze({
    pos: "positive",
    info: "info",
    caution: "warning",
    danger: "negative",
    neutral: "neutral",
  });

const DECISION_STATE_DISPLAY: Readonly<Record<string, string>> = Object.freeze({
  act: "Act",
  blocked: "Blocked",
  monitor: "Monitor",
  not_applicable: "Not applicable",
});

function canonicalTone(
  decisionState: string,
  servedAction: string | null | undefined,
): CreativeStudioTone {
  if (decisionState === "blocked") return "warning";
  if (decisionState === "not_applicable") return "neutral";
  if (decisionState === "monitor") return "neutral";
  if (servedAction === "cut") return "negative";
  if (servedAction === "scale" || servedAction === "protect") return "positive";
  if (
    servedAction === "refresh" ||
    servedAction === "fix_delivery" ||
    servedAction === "fix_policy"
  ) {
    return "warning";
  }
  return "info";
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function buyerActionLabel(value: string | null | undefined): string | null {
  const action = nonEmpty(value)?.toLowerCase();
  if (!action) return null;
  const labels: Readonly<Record<string, string>> = {
    scale: "Scale",
    protect: "Protect performance",
    keep: "Keep running",
    refresh: "Refresh creative",
    cut: "Stop",
    test_more: "Test more",
    diagnose: "Review data",
    fix_delivery: "Fix delivery",
    fix_policy: "Resolve policy issue",
  };
  return labels[action] ?? null;
}

function isRollup(
  item: BriefingActionItem,
): item is Extract<BriefingActionItem, { primaryRec: BriefingCreativeCard }> {
  return typeof item === "object" && item !== null && "primaryRec" in item;
}

/**
 * Every card the briefing served, across its three lanes.
 *
 * `actionNow` may carry rollups; a rollup's `primaryRec` is the card the server
 * chose to represent it, so that is the card read here. `placementList` is not
 * flattened: those are the server's own sub-rows of the same decision, and
 * counting them would turn one served answer into several.
 */
export function flattenBriefingCards(
  response: CreativesBriefingResponse | null | undefined,
): BriefingCreativeCard[] {
  if (!response) return [];
  const actionNow = (response.actionNow ?? []).map((item) =>
    isRollup(item) ? item.primaryRec : item,
  );
  return [
    ...actionNow,
    ...(response.watching ?? []),
    ...(response.healthy ?? []),
  ];
}

interface ServedCard {
  card: BriefingCreativeCard;
  legacySegment: "Act" | "Monitor";
}

function servedCards(
  response: CreativesBriefingResponse | null | undefined,
): ServedCard[] {
  if (!response) return [];
  const actionNow = (response.actionNow ?? []).map((item) => ({
    card: isRollup(item) ? item.primaryRec : item,
    legacySegment: "Act" as const,
  }));
  return [
    ...actionNow,
    ...(response.watching ?? []).map((card) => ({
      card,
      legacySegment: "Monitor" as const,
    })),
    ...(response.healthy ?? []).map((card) => ({
      card,
      legacySegment: "Monitor" as const,
    })),
  ];
}

interface ClassificationCandidate {
  creativeId: string;
  decisionKey: string;
  value: Omit<ServedCreativeClassification, "decisionCount">;
}

function canonicalClassificationForCard(
  card: BriefingCreativeCard,
): ClassificationCandidate | null {
  const decision = card.canonicalDecision;
  if (!decision) return null;
  const creativeId = nonEmpty(decision.creativeId);
  if (!creativeId) return null;

  const decisionState = nonEmpty(decision.classification.decisionState);
  const buyerLabel = nonEmpty(decision.classification.buyerLabel);
  const sourceLabel = nonEmpty(decision.sourceDecision.label);
  const sourceDisplayLabel = sourceLabel
    ? (DECISION_LABEL_DISPLAY[sourceLabel]?.label ?? null)
    : null;
  const label = buyerLabel ?? sourceDisplayLabel ?? "Decision unavailable";
  const details: string[] = [];
  if (decision.classification.heldAction) {
    const heldLabel = buyerActionLabel(decision.classification.heldAction);
    details.push(
      heldLabel
        ? `${heldLabel} is waiting for review`
        : "An action is waiting for review",
    );
  } else if (decision.classification.buyerAction) {
    const actionLabel = buyerActionLabel(decision.classification.buyerAction);
    if (actionLabel) details.push(`Recommended action: ${actionLabel}`);
  }

  return {
    creativeId,
    decisionKey: decision.decisionId,
    value: {
      label,
      tone: canonicalTone(
        decision.classification.decisionState,
        decision.classification.buyerAction,
      ),
      segment: (decisionState && DECISION_STATE_DISPLAY[decisionState]) ?? null,
      detail: details.length > 0 ? details.join(" · ") : null,
      source: "canonical_decision",
    },
  };
}

function legacyClassificationForCard(
  card: BriefingCreativeCard,
  legacySegment: "Act" | "Monitor",
): ClassificationCandidate | null {
  const creativeId = nonEmpty(card.creativeId);
  if (!creativeId) return null;
  // The richer server vocabulary first, when the server publishes it. It is
  // typed on `BriefingCreativeCard` and produced by
  // `classifyMetaCreativeAssessment`, but the live briefing route does not put
  // it on the wire yet (see the report accompanying this change), so this
  // branch is dormant on production data and lights up with no UI change the
  // day the server serves it.
  const assessment = card.assessment;
  if (
    assessment &&
    typeof assessment.label === "string" &&
    assessment.label.trim()
  ) {
    return {
      creativeId,
      decisionKey: `${nonEmpty(card.id) ?? "legacy"}:assessment:${assessment.value ?? assessment.label}`,
      value: {
        label: assessment.label.trim(),
        tone: ASSESSMENT_TONE[assessment.tone] ?? "neutral",
        segment: legacySegment,
        detail: "Previous assessment",
        source: "assessment",
      },
    };
  }

  const label = typeof card.label === "string" ? card.label.trim() : "";
  if (!label) return null;
  const display = DECISION_LABEL_DISPLAY[label];
  return {
    creativeId,
    decisionKey: `${nonEmpty(card.id) ?? "legacy"}:label:${label}`,
    value: {
      label: display?.label ?? "Recommendation available",
      tone: display?.tone ?? "neutral",
      segment: legacySegment,
      detail: "Previous decision",
      source: "decision_label",
    },
  };
}

function collapseCandidates(
  candidates: readonly ClassificationCandidate[],
): ServedCreativeClassification {
  const decisions = new Map<string, ClassificationCandidate>();
  for (const candidate of candidates)
    decisions.set(candidate.decisionKey, candidate);
  const values = [...decisions.values()].map((candidate) => candidate.value);

  const unique = <T>(
    read: (value: (typeof values)[number]) => T | null,
  ): T[] => {
    const result: T[] = [];
    for (const value of values) {
      const item = read(value);
      if (item !== null && !result.includes(item)) result.push(item);
    }
    return result;
  };
  const labels = unique((value) => value.label);
  const segments = unique((value) => value.segment);
  const tones = unique((value) => value.tone);
  const details = unique((value) => value.detail);
  const sources = unique((value) => value.source);

  return {
    label: labels.join(" / ") || "Decision unavailable",
    segment: segments.join(" / ") || null,
    tone: tones.length === 1 ? tones[0]! : "neutral",
    detail: details.length > 0 ? details.join(" · ") : null,
    decisionCount: decisions.size,
    source: sources.includes("canonical_decision")
      ? "canonical_decision"
      : (sources[0] ?? "decision_label"),
  };
}

/**
 * Creative id -> every distinct exact-Ad decision the server served for it,
 * collapsed only by joining literal server states with `/`. A creative-grain
 * row can legitimately represent several Ads; dropping the disagreeing
 * answers or choosing one would be less truthful than showing all of them.
 */
export function buildServedCreativeClassifications(
  response: CreativesBriefingResponse | null | undefined,
): Map<string, ServedCreativeClassification> {
  const byCreative = new Map<string, ClassificationCandidate[]>();
  const canonicalCreativeIds = new Set<string>();
  const cards = servedCards(response);

  // Canonical exact-Ad decisions are the authority. Legacy card fields are a
  // compatibility fallback only for a creative that received no canonical
  // envelope at all; mixing both would count the same server decision twice.
  for (const { card } of cards) {
    const candidate = canonicalClassificationForCard(card);
    if (!candidate) continue;
    const existing = byCreative.get(candidate.creativeId) ?? [];
    existing.push(candidate);
    byCreative.set(candidate.creativeId, existing);
    canonicalCreativeIds.add(candidate.creativeId);
  }
  for (const { card, legacySegment } of cards) {
    const candidate = legacyClassificationForCard(card, legacySegment);
    if (!candidate || canonicalCreativeIds.has(candidate.creativeId)) continue;
    const existing = byCreative.get(candidate.creativeId) ?? [];
    existing.push(candidate);
    byCreative.set(candidate.creativeId, existing);
  }

  const result = new Map<string, ServedCreativeClassification>();
  for (const [creativeId, candidates] of byCreative) {
    result.set(creativeId, collapseCandidates(candidates));
  }
  return result;
}

/**
 * The classification for one creative, or `null` when the endpoint served no
 * matching decision. The caller turns that null into a named read state; it is
 * never rendered as an em dash.
 */
export function servedClassificationFor(
  index: ReadonlyMap<string, ServedCreativeClassification | null>,
  creativeId: string | null | undefined,
): ServedCreativeClassification | null {
  const key = typeof creativeId === "string" ? creativeId.trim() : "";
  if (!key) return null;
  return index.get(key) ?? null;
}

/**
 * Explicit row text when no canonical/legacy decision matched the creative.
 * A successful read means the row was not evaluated; a failed read means the
 * answer is unavailable. Neither state is an em dash or a fake engine label.
 */
export function creativeDecisionStatusFallback(
  state: CreativeDecisionReadState,
): CreativeDecisionStatusFallback {
  if (state === "loading") {
    return {
      label: "Loading decision",
      tone: "neutral",
      segment: null,
      detail: "Recommendation is loading.",
      decisionCount: 0,
      source: "read_state",
    };
  }
  if (state === "unavailable") {
    return {
      label: "Decision data unavailable",
      tone: "warning",
      segment: null,
      detail: "Recommendation is temporarily unavailable.",
      decisionCount: 0,
      source: "read_state",
    };
  }
  return {
    label: "Not evaluated",
    tone: "neutral",
    segment: null,
    detail: "No recommendation is available for this creative.",
    decisionCount: 0,
    source: "read_state",
  };
}
