/**
 * The four actions a decision response may carry — and nothing else in this
 * file.
 *
 * It lived beside the store in `decision-responses.ts`, which imports `lib/db`.
 * That is correct for a server module and fatal for a client one: the moment
 * `IntelligenceView` — a `"use client"` component — imported the constant to
 * populate its respond control, the bundler followed `pg` into the browser
 * bundle and the build failed on `Can't resolve 'tls'`.
 *
 * So the vocabulary lives here, with no imports at all, and the store
 * re-exports it. One definition, reachable from both sides, and the route that
 * validates against it and the control that offers it can never drift — which
 * was the actual defect: the control offered `acknowledged | acted | dismissed`
 * while the route accepted `acted | deferred | undeferred | ignored`.
 */
export const META_DECISION_RESPONSE_ACTIONS = [
  "acted",
  "deferred",
  "undeferred",
  "ignored",
] as const;

export type MetaDecisionResponseAction =
  (typeof META_DECISION_RESPONSE_ACTIONS)[number];
