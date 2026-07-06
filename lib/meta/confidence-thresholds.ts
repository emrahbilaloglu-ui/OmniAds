// Single source for the Meta v1 confidence thresholds.
//
// These two constants gate act-vs-test decision states, high/medium/low
// confidence labels, snapshot priority, and automation readiness. They were
// previously duplicated as bare 0.7/0.55 literals across five modules, which
// made outcome-driven tuning impossible to do safely. They are engine
// policy. The read-only validation harness
// (scripts/meta-readiness/confidence-outcome-validation.ts) measures whether
// these cuts actually separate realized KPI movement; change them only with
// that evidence in hand, and bump META_RECOMMENDATION_ENGINE_VERSION when you
// do (hysteresis memory resets on version change by design).

/** Score at or above which a recommendation is high-confidence and may
 * carry decisionState "act" / clear the automation low_confidence gate. */
export const META_CONFIDENCE_ACT_THRESHOLD = 0.7;

/** Score at or above which (but below the act threshold) a recommendation
 * is medium-confidence. Below this it is low. */
export const META_CONFIDENCE_MEDIUM_THRESHOLD = 0.55;

export type MetaConfidenceBucket = "high" | "medium" | "low";

export function metaConfidenceBucket(score: number): MetaConfidenceBucket {
  if (score >= META_CONFIDENCE_ACT_THRESHOLD) return "high";
  if (score >= META_CONFIDENCE_MEDIUM_THRESHOLD) return "medium";
  return "low";
}
