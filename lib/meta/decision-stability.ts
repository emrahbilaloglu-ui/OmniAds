// Decision-state stability (act-boundary hysteresis) for the Meta v1 engine.
//
// Port of the CDC discipline in
// lib/creative-decision-engine/decision-stability.ts: boundaries that are
// re-estimated daily make decisions round-trip across consecutive snapshots,
// and every act<->non-act flip churns the Action Now lane. Rule: a
// transition that crosses the act boundary publishes only after the new raw
// state holds for two consecutive snapshots; the suppressed day republishes
// the previous published state with a pending-transition state reason.
// test<->watch transitions publish immediately.
//
// Memory rides in signal_quality.stability (jsonb already round-tripped by
// the snapshot writer/reader), so no schema change is required. Snapshots
// written before this field existed fall back to the published state as the
// raw state - the first flip after rollout is therefore suppressed for one
// day, which is the conservative side of the rule.
//
// Deliberate non-goal: a recommendation that disappears from one snapshot
// to the next is NOT republished from memory. Meta v1 emits recommendations
// conditionally on evidence; holding a rec whose evidence is gone would
// fabricate a decision. Hysteresis only damps state flips for keys present
// on both days.
import { getDb } from "@/lib/db";
import type { MetaDecisionState, MetaRecommendation } from "@/lib/meta/recommendations";

export interface PreviousPublishedState {
  publishedState: MetaDecisionState;
  rawState: MetaDecisionState | null;
}

export interface StateHysteresisResult {
  publishedState: MetaDecisionState;
  rawState: MetaDecisionState;
  suppressed: boolean;
}

const VALID_STATES: ReadonlySet<string> = new Set(["act", "test", "watch"]);

export const META_PENDING_TRANSITION_REASON_PREFIX =
  "[Pending transition - held at previous decision state] ";

function isHardState(state: MetaDecisionState) {
  return state === "act";
}

export function applyMetaStateHysteresis(
  rawState: MetaDecisionState,
  previous: PreviousPublishedState | null | undefined,
): StateHysteresisResult {
  if (!previous) {
    return { publishedState: rawState, rawState, suppressed: false };
  }
  if (rawState === previous.publishedState) {
    return { publishedState: rawState, rawState, suppressed: false };
  }
  const crossesHardBoundary =
    isHardState(rawState) || isHardState(previous.publishedState);
  if (!crossesHardBoundary) {
    return { publishedState: rawState, rawState, suppressed: false };
  }
  const previousRaw = previous.rawState ?? previous.publishedState;
  if (rawState === previousRaw) {
    // Second consecutive snapshot with the same new state: confirmed.
    return { publishedState: rawState, rawState, suppressed: false };
  }
  return {
    publishedState: previous.publishedState,
    rawState,
    suppressed: true,
  };
}

/** Stable identity for a recommendation across snapshots. rec_id embeds the
 * generator row id, which can shift; scope+type is the operator-facing
 * identity ("what decision about which entity"). */
export function metaStabilityKey(input: {
  scopeType: string;
  scopeId: string;
  recType: string;
}): string {
  return `${input.scopeType}|${input.scopeId}|${input.recType}`;
}

type StabilityMemory = {
  raw_decision_state?: unknown;
  suppressed?: unknown;
};

function rawStateFromSignalQuality(value: unknown): MetaDecisionState | null {
  if (!value || typeof value !== "object") return null;
  const stability = (value as { stability?: StabilityMemory }).stability;
  const raw = stability?.raw_decision_state;
  return typeof raw === "string" && VALID_STATES.has(raw)
    ? (raw as MetaDecisionState)
    : null;
}

/**
 * Latest published+raw decision states per stability key strictly before
 * asOf, for the given engine version. A version bump resets the memory on
 * purpose: a new engine's first day publishes its own states.
 */
export async function readPreviousMetaDecisionStates(input: {
  businessId: string;
  asOf: string;
  engineVersion: string;
}): Promise<Map<string, PreviousPublishedState>> {
  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT ON (scope_type, scope_id, rec_type)
      scope_type,
      scope_id,
      rec_type,
      decision_state,
      signal_quality
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND kind = 'recommendation'
      AND engine_version = ${input.engineVersion}
      AND snapshot_date < ${input.asOf}::date
    ORDER BY scope_type, scope_id, rec_type, snapshot_date DESC
  `) as Array<{
    scope_type: string;
    scope_id: string;
    rec_type: string;
    decision_state: string;
    signal_quality: unknown;
  }>;

  const map = new Map<string, PreviousPublishedState>();
  for (const row of rows) {
    if (!VALID_STATES.has(row.decision_state)) continue;
    map.set(
      metaStabilityKey({
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        recType: row.rec_type,
      }),
      {
        publishedState: row.decision_state as MetaDecisionState,
        rawState: rawStateFromSignalQuality(row.signal_quality),
      },
    );
  }
  return map;
}

/**
 * Applies act-boundary hysteresis to a batch of recommendations. Every
 * returned recommendation carries signalQuality.stability with the raw
 * state (the memory for tomorrow's confirmation rule); suppressed ones
 * publish the previous state and prefix their stateReason.
 */
export function stabilizeMetaRecommendations(input: {
  recommendations: MetaRecommendation[];
  previousByKey: Map<string, PreviousPublishedState>;
  scopeFor: (recommendation: MetaRecommendation) => { scopeType: string; scopeId: string };
}): { recommendations: MetaRecommendation[]; suppressedCount: number } {
  let suppressedCount = 0;
  const recommendations = input.recommendations.map((recommendation) => {
    const scope = input.scopeFor(recommendation);
    const previous = input.previousByKey.get(
      metaStabilityKey({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        recType: recommendation.type,
      }),
    );
    const result = applyMetaStateHysteresis(recommendation.decisionState, previous);
    const stability = {
      raw_decision_state: result.rawState,
      suppressed: result.suppressed,
    };
    if (!result.suppressed) {
      return {
        ...recommendation,
        signalQuality: { ...(recommendation.signalQuality ?? {}), stability },
      };
    }
    suppressedCount += 1;
    return {
      ...recommendation,
      decisionState: result.publishedState,
      stateReason: `${META_PENDING_TRANSITION_REASON_PREFIX}${recommendation.stateReason ?? ""}`.trimEnd(),
      signalQuality: { ...(recommendation.signalQuality ?? {}), stability },
    };
  });
  return { recommendations, suppressedCount };
}
