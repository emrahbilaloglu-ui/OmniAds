/**
 * WP-27A — what the compatibility layer reports about itself.
 *
 * During a cutover the questions that matter are operational: is anything
 * still landing on legacy, are redirects one hop, are people being bounced to
 * login or refused, and — the one that matters at 3am — did setting the flag
 * to `off` actually take effect everywhere.
 *
 * Every field is drawn from a closed set. `route` is one of the 46 paths in
 * the table, never the request URL; `mode` is one of four; `scope` one of
 * four; `decision` one of seven. That is a hard cardinality bound of a few
 * hundred combinations, so this cannot become a per-tenant or per-URL metric
 * by accident.
 *
 * What is deliberately absent: user id, email, session id, business id, the
 * query string, the resolved destination and the dynamic ids. A business id
 * would be both unbounded and a tenant identifier in an operational log, and
 * the destination would carry the ids back in through the side door. Counting
 * needs none of them.
 */
import type { ZeroBaseUiMode } from "@/lib/zero-base/rollout";
import type { CompatibilityScope } from "@/lib/zero-base/compatibility";

export type CompatibilityDecisionKind =
  | "legacy"
  | "redirect"
  | "login"
  | "select-business"
  | "not-found"
  | "forbidden"
  | "unavailable"
  | "chooser";

export interface CompatibilityEvent {
  route: string;
  mode: ZeroBaseUiMode;
  scope: CompatibilityScope;
  decision: CompatibilityDecisionKind;
}

export type CompatibilityObserver = (event: CompatibilityEvent) => void;

/**
 * A structured line by default.
 *
 * Not the instrumentation table: that one is for product analytics, needs a
 * migrated database and a session, and this has to keep working during the
 * incident where those are the things that broke.
 */
const defaultObserver: CompatibilityObserver = (event) => {
  console.info(
    `[zero-base-compat] route=${event.route} mode=${event.mode} scope=${event.scope} decision=${event.decision}`,
  );
};

let observer: CompatibilityObserver = defaultObserver;

/** Test seam. Returns the previous observer so a test can put it back. */
export function setCompatibilityObserver(next: CompatibilityObserver): CompatibilityObserver {
  const previous = observer;
  observer = next;
  return previous;
}

export function resetCompatibilityObserver(): void {
  observer = defaultObserver;
}

/**
 * Never throws.
 *
 * Observability that can fail the request it observes is worse than none: a
 * broken log line must not be able to take down a page, least of all the
 * rollback path.
 */
export function recordCompatibilityDecision(event: CompatibilityEvent): void {
  try {
    observer(event);
  } catch {
    // Intentionally silent.
  }
}
