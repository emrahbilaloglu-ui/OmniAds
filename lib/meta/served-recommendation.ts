/**
 * Is this `rec_id` one the engine actually served to this business?
 *
 * `POST /api/meta/recommendations/respond` took any non-empty string. The
 * column has no foreign key — deliberately, because
 * `lib/triage-events.ts` is a second writer of `meta_decision_responses` whose
 * rec ids are synthetic and never have a snapshot row — so nothing between the
 * request body and the INSERT established that the id named a real
 * recommendation. A caller could record an operator decision against an id of
 * their choosing, or against another workspace's recommendation, and
 * `lib/meta/outcome-accrual.ts` would later read that row back as evidence
 * that an operator acted.
 *
 * The composer posting a server-served id is not a protection: it is the
 * client's good behaviour, and the write boundary cannot depend on it.
 *
 * ## What "served" can and cannot mean here
 *
 * **Business scope: enforced.** `meta_decision_snapshots_daily.business_id` is
 * the authority, and the caller has already been authorized against it.
 *
 * **Account scope: NOT EXPRESSIBLE, and not invented.** The table has no
 * provider-account column — the DDL is
 * `(scope_type, scope_id, business_id, snapshot_date, rec_id, rec_type, ...)`
 * and for `scope_type = 'account'` rows `scope_id` is the BUSINESS id, not an
 * ad-account id (`lib/meta/snapshot.ts`: `return { scopeType: "account", scopeId: businessId }`).
 * A predicate written against `scope_id` would therefore mean different things
 * for account rows and campaign rows, and account-level recommendations — the
 * bulk of them — would be rejected. Provider-account scope for a recommendation
 * is reachable only by joining the dimension tables, which drops every
 * account-level row by construction. So this check is business- and
 * recency-scoped, and says so rather than pretending to an account scope the
 * schema cannot carry.
 *
 * **Recency: bounded, not "latest".** The obvious rule — "is it in the current
 * snapshot" — is wrong. `undeferred` exists precisely to lift a deferral taken
 * days ago, and an `acted` recorded after the operator finally did the thing is
 * legitimate; both would be refused by a latest-only test, and
 * `readLatestMetaDecisionSnapshot` reads `MAX(snapshot_date)` only. The window
 * below is the same shape History uses to resolve a response against the
 * snapshot that produced it.
 *
 * The window is also what keeps this read cheap. `rec_id` is in no index; the
 * only index is `(business_id, snapshot_date)`, so the date bound is what stops
 * this scanning every snapshot row the business has ever written. This
 * codebase has already lost a surface to exactly that shape.
 *
 * ## Three answers, never two
 *
 * An unreadable snapshot source is NOT "not served". Answering 404 for a
 * database outage would tell the operator their recommendation does not exist;
 * answering "served" would be fail-open. It gets its own state and its own
 * refusal, exactly as `readServedMetaDecision` does for the native decision
 * universe.
 */
import { getDb } from "@/lib/db";

/**
 * How far back a response may reach.
 *
 * Long enough to cover a deferral and its `reappearAt`, short enough that the
 * indexed date bound still does the work. A recommendation older than this is
 * not part of any live decision loop, and recording an operator response
 * against it would be recording against history.
 */
export const SERVED_RECOMMENDATION_WINDOW_DAYS = 30;

export type ServedMetaRecommendationStatus =
  /** The engine served this rec id to this business inside the window. */
  | "served"
  /** The snapshot source answered, and this id is not in it. */
  | "not_served"
  /** The snapshot source could not be read. Refuses; never reads as served. */
  | "source_unavailable";

export interface ServedMetaRecommendationResult {
  status: ServedMetaRecommendationStatus;
  /** The snapshot date the id was found on, when it was. */
  snapshotDate?: string;
}

export async function readServedMetaRecommendation(input: {
  businessId: string;
  recId: string;
  /** Overridable so a test can pin the window; production uses the default. */
  windowDays?: number;
}): Promise<ServedMetaRecommendationResult> {
  const businessId = input.businessId?.trim() ?? "";
  const recId = input.recId?.trim() ?? "";
  // Neither can be established, so nothing can be served against them. This is
  // "not served" rather than "unavailable": the source was never asked, and
  // the caller supplied nothing to ask about.
  if (!businessId || !recId) return { status: "not_served" };

  const windowDays = Math.max(
    1,
    Math.min(input.windowDays ?? SERVED_RECOMMENDATION_WINDOW_DAYS, 365),
  );

  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT snapshot_date::text AS snapshot_date
      FROM meta_decision_snapshots_daily
      WHERE business_id = ${businessId}
        AND snapshot_date >= (CURRENT_DATE - (${windowDays}::int * INTERVAL '1 day'))
        AND rec_id = ${recId}
        AND kind = 'recommendation'
      ORDER BY snapshot_date DESC
      LIMIT 1
    `) as Array<{ snapshot_date?: unknown }>;
    const row = rows[0];
    if (!row) return { status: "not_served" };
    return {
      status: "served",
      snapshotDate:
        typeof row.snapshot_date === "string" ? row.snapshot_date : undefined,
    };
  } catch {
    /*
     * Includes the unmigrated case. A missing table is a source that cannot
     * answer, not a source that answered "no" — and the difference decides
     * whether the operator is told their recommendation does not exist or that
     * the check could not run.
     */
    return { status: "source_unavailable" };
  }
}
