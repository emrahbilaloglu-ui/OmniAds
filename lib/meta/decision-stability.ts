// Decision-state stability (act-boundary hysteresis) for the Meta v1 engine.
//
// Port of the CDC discipline in
// lib/creative-decision-engine/decision-stability.ts: boundaries that are
// re-estimated daily make decisions round-trip across consecutive snapshots,
// and every non-act->act flip churns the Action Now lane. Rule: entering the
// hard action state requires two consecutive snapshots. Leaving act is
// safety-dominant and publishes immediately; stale evidence must never keep a
// previous hard action alive. test<->watch transitions also publish
// immediately.
//
// Memory rides in signal_quality.stability (jsonb already round-tripped by
// the snapshot writer/reader), so no schema change is required. Snapshots
// written before this field existed fall back to the published state as the
// raw state. A first-ever hard action is published as test for one snapshot,
// then becomes act only if the same raw decision repeats.
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
  "[Pending hard action confirmation] ";

function isHardState(state: MetaDecisionState) {
  return state === "act";
}

export function applyMetaStateHysteresis(
  rawState: MetaDecisionState,
  previous: PreviousPublishedState | null | undefined,
): StateHysteresisResult {
  if (!previous) {
    return rawState === "act"
      ? { publishedState: "test", rawState, suppressed: true }
      : { publishedState: rawState, rawState, suppressed: false };
  }
  if (rawState === previous.publishedState) {
    return { publishedState: rawState, rawState, suppressed: false };
  }
  // Hard-action exits and all soft-state transitions are immediate. Holding
  // yesterday's act after today's evidence says test/watch is unsafe.
  if (!isHardState(rawState)) {
    return { publishedState: rawState, rawState, suppressed: false };
  }
  // The only delayed boundary is non-act -> act.
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

/**
 * Stable identity for a recommendation across snapshots.
 *
 * `rec_id` embeds the generator row id, which can shift; scope+type is the
 * operator-facing identity ("what decision about which entity").
 *
 * D-M011: the PHYSICAL ACCOUNT is part of that identity, and leaving it out was
 * a real cross-account defect rather than a tidiness one. Campaign and ad-set
 * `scope_id`s are Meta entity ids and are globally unique, so those never
 * collided — but `scopeForRecommendation` sets `scope_id = businessId` for
 * ACCOUNT-level rows, so two assigned accounts producing the same account-level
 * `rec_type` shared one key. `readPreviousMetaDecisionStates` takes
 * `DISTINCT ON` that key ordered by date, so whichever account was written last
 * governed the OTHER account's hysteresis: account A's act-boundary flip could
 * be suppressed because account B had already flipped, and neither screen could
 * show why.
 *
 * A null account keeps the legacy key shape exactly, so rows written before the
 * lineage column still match themselves.
 */
export function metaStabilityKey(input: {
  scopeType: string;
  scopeId: string;
  recType: string;
  providerAccountId?: string | null;
}): string {
  const account = input.providerAccountId?.trim() || "";
  return `${input.scopeType}|${input.scopeId}|${input.recType}|${account}`;
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
  /**
   * Narrow the memory to ONE physical account.
   *
   * Per-account generation reads its own account's history and nothing else.
   * Omitted keeps the business-wide read for callers that are not account
   * surfaces. Note this is `IS NOT DISTINCT FROM`, not `=`: when an account is
   * given, legacy NULL-lineage rows are NOT its memory — they belong to no
   * proven account and must not govern one.
   */
  providerAccountId?: string | null;
}): Promise<Map<string, PreviousPublishedState>> {
  const sql = getDb();
  const account = input.providerAccountId?.trim() || null;
  const rows = (await sql`
    SELECT DISTINCT ON (scope_type, scope_id, rec_type, provider_account_id)
      scope_type,
      scope_id,
      rec_type,
      provider_account_id,
      decision_state,
      signal_quality
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND kind = 'recommendation'
      AND engine_version = ${input.engineVersion}
      AND snapshot_date < ${input.asOf}::date
      AND (${account}::text IS NULL OR provider_account_id = ${account})
    ORDER BY scope_type, scope_id, rec_type, provider_account_id, snapshot_date DESC
  `) as Array<{
    provider_account_id?: string | null;
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
        providerAccountId: row.provider_account_id,
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
 * state (the memory for tomorrow's confirmation rule); suppressed hard
 * entries publish the previous soft state, or test on the first-ever row,
 * and prefix their stateReason.
 */
export function stabilizeMetaRecommendations(input: {
  recommendations: MetaRecommendation[];
  previousByKey: Map<string, PreviousPublishedState>;
  scopeFor: (recommendation: MetaRecommendation) => { scopeType: string; scopeId: string };
  /**
   * The physical account this generation is for.
   *
   * Must be the SAME account the memory was read with, or the keys will not
   * match and every recommendation looks new. Omitted keeps the legacy
   * business-wide behaviour.
   */
  providerAccountId?: string | null;
}): { recommendations: MetaRecommendation[]; suppressedCount: number } {
  let suppressedCount = 0;
  const recommendations = input.recommendations.map((recommendation) => {
    const scope = input.scopeFor(recommendation);
    const previous = input.previousByKey.get(
      metaStabilityKey({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        recType: recommendation.type,
        providerAccountId: input.providerAccountId,
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
