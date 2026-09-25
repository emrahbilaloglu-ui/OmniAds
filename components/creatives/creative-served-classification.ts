import type {
  BriefingActionItem,
  BriefingCanonicalDecisionEvidence,
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
 * this module keys on. That id is ONE member's, though; a row that carries its
 * members' Ad and creative ids is matched on all of them — see
 * `servedClassificationForRow`.
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
  /**
   * Every exact-Ad decision behind this row, each paired with its OWN state,
   * label and evidence, in the server's lane order. A creative-grain row can
   * stand for several Ads (the Studio groups by name and format), and joining
   * their states and labels separately ("Blocked / Monitor · Cut · Held /
   * Protect") lost which verdict belonged to which Ad. Empty for legacy
   * creative-grain answers, which name no Ad.
   */
  adDecisions: ServedAdDecision[];
  /** True when those Ads were served different verdicts. */
  variesByAd: boolean;
}

/** One exact-Ad server decision as a creative-grain row presents it. */
export interface ServedAdDecision {
  adId: string;
  /**
   * The Ad's own name and where it runs. Same-named Ads in one Studio row
   * usually differ by ad set (Grandmix "Cat-Sale": one campaign, two ad sets).
   */
  adName: string | null;
  adsetName: string | null;
  campaignName: string | null;
  segment: string | null;
  label: string;
  tone: CreativeStudioTone;
  detail: string | null;
  /**
   * What the verdict was judged on. Undefined when the payload predates the
   * field; a present value with a null period is the server saying the period
   * is unknown.
   */
  evidence?: BriefingCanonicalDecisionEvidence;
}

export interface CreativeDecisionStatusFallback {
  label: string;
  tone: CreativeStudioTone;
  segment: null;
  detail: string | null;
  decisionCount: 0;
  source: "read_state";
  adDecisions: [];
  variesByAd: false;
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
    cut: "Pause ad",
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

export interface ClassificationCandidate {
  creativeId: string | null;
  /**
   * The exact provider Ad the served decision is for. Canonical decisions are
   * Ad-grain and always name it; legacy card fields are creative-grain
   * compatibility answers and name none (a legacy card's `adId` is whichever
   * row the server joined, not the decision's grain).
   */
  adId: string | null;
  decisionKey: string;
  value: Omit<
    ServedCreativeClassification,
    "decisionCount" | "adDecisions" | "variesByAd"
  >;
  /** Canonical Ad-grain candidates only. */
  adDecision?: ServedAdDecision;
}

function canonicalClassificationForCard(
  card: BriefingCreativeCard,
): ClassificationCandidate | null {
  const decision = card.canonicalDecision;
  if (!decision) return null;
  const creativeId = nonEmpty(decision.creativeId);
  const adId =
    nonEmpty(decision.adId) ?? nonEmpty(decision.sourceAuthority?.realAdId);
  // Canonical decisions are Ad-grain. A malformed card without an exact Ad
  // identity cannot be promoted into a creative-grain answer.
  if (!adId) return null;

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
        ? `${heldLabel} recommendation awaits review`
        : "Recommendation awaits review",
    );
  } else if (decision.classification.buyerAction) {
    const actionLabel = buyerActionLabel(decision.classification.buyerAction);
    if (actionLabel) details.push(`Recommended action: ${actionLabel}`);
  }

  const value = {
    label,
    tone: canonicalTone(
      decision.classification.decisionState,
      decision.classification.buyerAction,
    ),
    segment: (decisionState && DECISION_STATE_DISPLAY[decisionState]) ?? null,
    detail: details.length > 0 ? details.join(" · ") : null,
    source: "canonical_decision" as const,
  };
  return {
    creativeId,
    adId,
    decisionKey: decision.decisionId,
    value,
    adDecision: {
      adId,
      adName: nonEmpty(card.name),
      adsetName: nonEmpty(card.adsetName) ?? nonEmpty(card.adset),
      campaignName: nonEmpty(card.campaignName) ?? nonEmpty(card.campaign),
      segment: value.segment,
      label: value.label,
      tone: value.tone,
      detail: value.detail,
      ...(decision.decisionEvidence !== undefined
        ? { evidence: decision.decisionEvidence }
        : {}),
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
      adId: null,
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
    adId: null,
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

function verdictKey(value: { segment: string | null; label: string }) {
  return `${value.segment ?? ""}\u0000${value.label}`;
}

function collapseCandidates(
  candidates: readonly ClassificationCandidate[],
): ServedCreativeClassification {
  const decisions = new Map<string, ClassificationCandidate>();
  for (const candidate of candidates)
    decisions.set(candidate.decisionKey, candidate);
  const served = [...decisions.values()];
  const values = served.map((candidate) => candidate.value);

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
  const verdicts = unique((value) => verdictKey(value));
  const tones = unique((value) => value.tone);
  const details = unique((value) => value.detail);
  const sources = unique((value) => value.source);
  const adDecisions = served.flatMap((candidate) =>
    candidate.adDecision ? [candidate.adDecision] : [],
  );
  const source = sources.includes("canonical_decision")
    ? ("canonical_decision" as const)
    : (sources[0] ?? "decision_label");

  // One verdict, however many Ads carry it: the server's own state and label.
  if (verdicts.length <= 1) {
    const first = values[0];
    const sharedNote =
      adDecisions.length > 1
        ? `Same recommendation for ${adDecisions.length} Ads.`
        : null;
    const perAd =
      adDecisions.length > 1
        ? adDecisions.map((entry) => servedAdDecisionLine(entry))
        : adDecisions[0]
          ? [decisionEvidenceSentence(adDecisions[0].evidence)].filter(
              (line): line is string => line !== null,
            )
          : [];
    const detailParts = [
      details.length > 0 ? details.join(" · ") : null,
      sharedNote,
      ...perAd,
    ].filter((part): part is string => Boolean(part));
    return {
      label: first?.label ?? "Decision unavailable",
      segment: first?.segment ?? null,
      tone: tones.length === 1 ? tones[0]! : "neutral",
      detail: detailParts.length > 0 ? detailParts.join("\n") : null,
      decisionCount: decisions.size,
      source,
      adDecisions,
      variesByAd: false,
    };
  }

  /*
    Different verdicts on one row. The surface may not choose between them,
    and it may not join states and labels separately either: that printed
    "Blocked / Monitor · Cut · Held / Protect", a pairing no Ad was served.
    The row says how many recommendations it holds; each one is listed with
    the Ad it belongs to.
  */
  const count = adDecisions.length > 0 ? adDecisions.length : decisions.size;
  const lines =
    adDecisions.length > 0
      ? adDecisions.map((entry) => servedAdDecisionLine(entry))
      : values.map((value) =>
          [value.segment, value.label].filter(Boolean).join(" · "),
        );
  return {
    label:
      adDecisions.length > 0
        ? `${count} Ads · different recommendations`
        : `${count} different recommendations`,
    segment: null,
    tone: "neutral",
    detail: lines.join("\n"),
    decisionCount: decisions.size,
    source,
    adDecisions,
    variesByAd: true,
  };
}

function formatEvidenceMoney(
  value: number | null,
  currency: string | null,
): string | null {
  if (value === null || !Number.isFinite(value) || !currency) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return null;
  }
}

/** `2026-09-09–09-24` within one year; both dates in full across years. */
function compactDayRange(start: string, end: string): string {
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${start}–${end.slice(5)}`
    : `${start}–${end}`;
}

/**
 * What a decision rests on, in the words a row can show: its own admitted
 * period and the figures the engine recorded for it, then the recent band
 * inside that period. Null when the payload carries no evidence at all.
 * Every number is the server's; a missing one is left out, never zeroed.
 */
export function decisionEvidenceLines(
  evidence: BriefingCanonicalDecisionEvidence | undefined,
): { period: string; figures: string | null; recent: string | null } | null {
  if (evidence === undefined) return null;
  const period = evidence.period;
  if (!period) {
    return { period: "Decision period unavailable", figures: null, recent: null };
  }
  const figures = [
    evidence.roas !== null ? `ROAS ${evidence.roas.toFixed(2)}` : null,
    evidence.purchases !== null
      ? `${evidence.purchases} ${evidence.purchases === 1 ? "purchase" : "purchases"}`
      : null,
    (() => {
      const money = formatEvidenceMoney(evidence.spend, evidence.currency);
      return money ? `${money} spend` : null;
    })(),
  ].filter((part): part is string => part !== null);
  const recent = evidence.recent
    ? `Recent ${compactDayRange(evidence.recent.startDate, evidence.recent.endDate)}: ROAS ${
        evidence.recent.roas !== null
          ? evidence.recent.roas.toFixed(2)
          : "unavailable"
      }`
    : null;
  return {
    period: `Decided on ${compactDayRange(period.startDate, period.endDate)} · ${period.economicDayCount}/${period.calendarDaySpan} economic days`,
    figures: figures.length > 0 ? figures.join(" · ") : null,
    recent,
  };
}

function decisionEvidenceSentence(
  evidence: BriefingCanonicalDecisionEvidence | undefined,
): string | null {
  const lines = decisionEvidenceLines(evidence);
  if (!lines) return null;
  return [lines.period, lines.figures, lines.recent]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** Where an Ad runs: its ad set and campaign, as served. */
export function servedAdDecisionPlacement(entry: ServedAdDecision): string | null {
  const placement = [entry.adsetName, entry.campaignName]
    .filter(Boolean)
    .join(" · ");
  return placement || null;
}

/** One Ad's verdict, named by its Ad and placement, for a row's detail text. */
export function servedAdDecisionLine(entry: ServedAdDecision): string {
  const placement = servedAdDecisionPlacement(entry);
  const who = [
    entry.adName ?? `Ad ${entry.adId}`,
    placement ? `(${placement})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const verdict = [entry.segment, entry.label].filter(Boolean).join(" · ");
  const basis = decisionEvidenceSentence(entry.evidence);
  return [`${who}: ${verdict}`, entry.detail, basis]
    .filter((part): part is string => Boolean(part))
    .join(" — ");
}

/**
 * The served classifications keyed by creative id — exactly the map this
 * module has always returned — plus the uncollapsed served decisions a row
 * lookup needs: by the exact Ad each one is for, and by creative id.
 */
export type ServedCreativeClassificationIndex = Map<
  string,
  ServedCreativeClassification
> & {
  readonly servedDecisionsByAdId: ReadonlyMap<
    string,
    readonly ClassificationCandidate[]
  >;
  readonly servedDecisionsByCreativeId: ReadonlyMap<
    string,
    readonly ClassificationCandidate[]
  >;
};

/**
 * Creative id -> every distinct exact-Ad decision the server served for it,
 * collapsed only by joining literal server states with `/`. A creative-grain
 * row can legitimately represent several Ads; dropping the disagreeing
 * answers or choosing one would be less truthful than showing all of them.
 */
export function buildServedCreativeClassifications(
  response: CreativesBriefingResponse | null | undefined,
): ServedCreativeClassificationIndex {
  const byCreative = new Map<string, ClassificationCandidate[]>();
  const byAdId = new Map<string, ClassificationCandidate[]>();
  const canonicalCreativeIds = new Set<string>();
  const cards = servedCards(response);
  const append = (
    index: Map<string, ClassificationCandidate[]>,
    key: string,
    candidate: ClassificationCandidate,
  ) => {
    const existing = index.get(key) ?? [];
    existing.push(candidate);
    index.set(key, existing);
  };

  // Canonical exact-Ad decisions are the authority. Legacy card fields are a
  // compatibility fallback only for a creative that received no canonical
  // envelope at all; mixing both would count the same server decision twice.
  for (const { card } of cards) {
    const candidate = canonicalClassificationForCard(card);
    if (!candidate) continue;
    if (candidate.adId) append(byAdId, candidate.adId, candidate);
    if (!candidate.creativeId) continue;
    append(byCreative, candidate.creativeId, candidate);
    canonicalCreativeIds.add(candidate.creativeId);
  }
  for (const { card, legacySegment } of cards) {
    if (card.canonicalDecision) continue;
    const candidate = legacyClassificationForCard(card, legacySegment);
    if (
      !candidate?.creativeId ||
      canonicalCreativeIds.has(candidate.creativeId)
    ) {
      continue;
    }
    append(byCreative, candidate.creativeId, candidate);
  }

  const result = new Map<string, ServedCreativeClassification>();
  for (const [creativeId, candidates] of byCreative) {
    result.set(creativeId, collapseCandidates(candidates));
  }
  return Object.assign(result, {
    servedDecisionsByAdId: byAdId,
    servedDecisionsByCreativeId: byCreative,
  });
}

function isServedClassificationIndex(
  index: ReadonlyMap<string, ServedCreativeClassification | null>,
): index is ServedCreativeClassificationIndex {
  return (
    "servedDecisionsByAdId" in index && "servedDecisionsByCreativeId" in index
  );
}

/** What an Assets row knows about the provider identities it stands for. */
export interface CreativeRowDecisionIdentity {
  creativeId: string | null | undefined;
  sourceAdIds?: readonly string[] | null;
  sourceAdIdsComplete?: boolean | null;
  sourceCreativeIds?: readonly string[] | null;
}

function uniqueNonEmpty(
  values: ReadonlyArray<string | null | undefined>,
): string[] {
  const result: string[] = [];
  for (const value of values) {
    const id = nonEmpty(value);
    if (id && !result.includes(id)) result.push(id);
  }
  return result;
}

/**
 * The classification for one Assets row, from every member identity the row
 * carries — or `null` when none of them matched a served decision.
 *
 * A creative-grain row names one creative id, the first its grouping met; an
 * Ad whose creative was replaced inside the window (common for catalog ads)
 * is served under its CURRENT creative id, so a lookup by that one id read
 * "Not evaluated" over Ads that had a decision. Measured on Grandmix
 * (act_805150454596350, 2026-09-23): 11 of 42 rows, $4,657 of $31,522 spend,
 * e.g. "Cat-Sale" keyed on 1684050916162467 while its two Ads were decided
 * under 2527054164481845 and 1617987753052572.
 *
 * MATCHING, strongest proof first:
 *   1. An Ad-grain decision for an Ad the row names is the row's — exact.
 *   2. A creative-grain (legacy) answer is the row's through any member
 *      creative id; it names no Ad to prove anything with.
 * An Ad-grain decision found only through a creative id may belong to ANOTHER
 * campaign's Ad. A partial or missing member list does not make that match
 * safe; such a row reports unverified membership when no exact Ad matched.
 * Canonical exact-Ad decisions outrank legacy card fields for the row as they
 * do for a creative. Every matched answer stays visible through
 * `collapseCandidates`; none is chosen. A bare creative-id map is looked up by
 * the row's creative id alone.
 */
export function servedClassificationForRow(
  index: ReadonlyMap<string, ServedCreativeClassification | null>,
  identity: CreativeRowDecisionIdentity,
): ServedCreativeClassification | null {
  if (!isServedClassificationIndex(index)) {
    // A bare creative-id map has already collapsed away the exact Ad identity.
    // It cannot assign an Ad-grain answer to a grouped row safely.
    return null;
  }
  const adIds = uniqueNonEmpty(identity.sourceAdIds ?? []);
  const creativeIds = uniqueNonEmpty([
    ...(identity.sourceCreativeIds ?? []),
    identity.creativeId,
  ]);
  const exact: ClassificationCandidate[] = [];
  for (const adId of adIds) {
    exact.push(...(index.servedDecisionsByAdId.get(adId) ?? []));
  }
  const creativeGrain: ClassificationCandidate[] = [];
  for (const creativeId of creativeIds) {
    for (const candidate of index.servedDecisionsByCreativeId.get(creativeId) ??
      []) {
      if (candidate.adId === null) creativeGrain.push(candidate);
    }
  }
  const matched = [...exact, ...creativeGrain];
  const canonical = matched.filter(
    (candidate) => candidate.value.source === "canonical_decision",
  );
  const served = canonical.length > 0 ? canonical : matched;
  return served.length > 0 ? collapseCandidates(served) : null;
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
  sourceAdIdsComplete = true,
): CreativeDecisionStatusFallback {
  if (state === "loading") {
    return {
      label: "Loading decision",
      tone: "neutral",
      segment: null,
      detail: "Recommendation is loading.",
      decisionCount: 0,
      source: "read_state",
      adDecisions: [],
      variesByAd: false,
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
      adDecisions: [],
      variesByAd: false,
    };
  }
  if (!sourceAdIdsComplete) {
    return {
      label: "Decision membership unverified",
      tone: "warning",
      segment: null,
      detail:
        "This row's Ad membership is incomplete, so a recommendation cannot be assigned safely.",
      decisionCount: 0,
      source: "read_state",
      adDecisions: [],
      variesByAd: false,
    };
  }
  return {
    label: "Not evaluated",
    tone: "neutral",
    segment: null,
    detail: "No recommendation is available for this creative.",
    decisionCount: 0,
    source: "read_state",
    adDecisions: [],
    variesByAd: false,
  };
}
