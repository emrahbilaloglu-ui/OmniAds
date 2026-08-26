/**
 * May this operator record THIS response against THIS recommendation, now?
 *
 * `POST /api/meta/recommendations/respond` took any non-empty string. The
 * column has no foreign key — deliberately, because `lib/triage-events.ts` is a
 * second writer of `meta_decision_responses` whose rec ids are synthetic and
 * never have a snapshot row — so nothing between the request body and the
 * INSERT established that the id named a real recommendation. A caller could
 * record an operator decision against an id of their choosing, or another
 * workspace's, and `lib/meta/outcome-accrual.ts` would later read that row back
 * as evidence that an operator acted.
 *
 * ## Three scopes, and none of them guessed
 *
 * **Business.** `meta_decision_snapshots_daily.business_id`, which the caller
 * has already been authorized against.
 *
 * **Physical provider account.** `provider_account_id`, the D6 lineage column.
 * Rows whose lineage cannot be proven — written before the column existed, or
 * account-level rows for a business with more than one assigned account — do
 * NOT match a requested account. That is the point: a recommendation that might
 * belong to another account must not be actionable from this one. Nothing is
 * inferred from `scope_id`, which holds the BUSINESS id for account-level rows
 * and would therefore mean two different things by row level.
 *
 * **Freshness, per ACTION.** The previous version accepted any row inside a
 * 30-day window, which is not what the surface serves: the mounted control is
 * drawn from the LATEST snapshot only. An id that was served yesterday and is
 * absent today therefore passed a check the screen would never have offered.
 *
 * ## Why the rule is per action rather than one window
 *
 *   `acted` / `deferred` / `ignored` — a response to a recommendation the
 *   operator is looking at. It must be in the CURRENT served snapshot for this
 *   account. An id that has fallen out of the snapshot is no longer a decision
 *   the engine is making, and recording against it writes an operator opinion
 *   about something the system has stopped saying.
 *
 *   `undeferred` — the one action whose whole purpose is to reach BACKWARDS. It
 *   lifts a deferral taken days ago, and by then the rec may legitimately have
 *   left the current snapshot. So it is allowed only against a recommendation
 *   this business AND THIS ACCOUNT have a currently ACTIVE prior deferral for.
 *   An arbitrary older served rec is not undefer authority — that was the hole
 *   in "any row in 30 days" — and neither is another account's deferral, which
 *   is why the account is required here too.
 *
 * "Currently active" means the LATEST response for that rec is `deferred`, not
 * merely that a `deferred` row exists: otherwise defer → undefer → undefer
 * passes forever. Automatic expiry is preserved — a deferral whose `reappear_at`
 * has passed has already come back on its own, so there is nothing left to lift
 * and it is not active.
 *
 * ## One statement, not a read and then a write
 *
 * ## The account must still be assigned NOW
 *
 * A snapshot row proves what was computed, not what the workspace still holds:
 * an assignment revoked afterwards leaves its rows behind, and answering one
 * would record an operator decision about an account this workspace no longer
 * has. So both predicates additionally require the account to be selected in
 * `business_provider_accounts` at the moment of the check, in the same
 * statement — a separate read would leave a window.
 *
 * `authorizeAndRecord` performs the authority check and the INSERT in a single
 * `INSERT ... SELECT`, so a snapshot rotation or a competing response landing
 * between the two cannot produce a row the check would have refused. The
 * separate `readServedMetaRecommendation` remains for callers that want the
 * verdict WITHOUT writing — it is the same predicate, and it is what the route
 * uses to choose which refusal to state.
 */
import { getDb } from "@/lib/db";
import type { MetaDecisionResponseAction } from "@/lib/meta/decision-response-actions";

export type ServedMetaRecommendationStatus =
  /** This action may be recorded against this rec, in this scope, now. */
  | "served"
  /**
   * The source answered and this action is not authorized against this id:
   * unknown, another workspace's, another account's, no longer in the current
   * snapshot, or — for `undeferred` — with no active deferral to lift.
   */
  | "not_served"
  /** The source could not be read. Refuses; never reads as served. */
  | "source_unavailable";

export interface ServedMetaRecommendationResult {
  status: ServedMetaRecommendationStatus;
  /** Present when the id was authorized through the current snapshot. */
  snapshotDate?: string;
}

interface ServedInput {
  businessId: string;
  recId: string;
  action: MetaDecisionResponseAction;
  /**
   * The physical account the caller is scoped to. Required for ALL FOUR
   * actions: "the current snapshot" and "an active prior deferral" are both
   * per-account facts, and an absent account cannot authorize either.
   */
  providerAccountId?: string | null;
}

/** The three actions that answer a recommendation the operator can see now. */
const CURRENT_SNAPSHOT_ACTIONS: ReadonlyArray<MetaDecisionResponseAction> = [
  "acted",
  "deferred",
  "ignored",
];

function normalize(input: ServedInput) {
  return {
    businessId: input.businessId?.trim() ?? "",
    recId: input.recId?.trim() ?? "",
    account: input.providerAccountId?.trim() || null,
    action: input.action,
  };
}

/**
 * The predicate, as one boolean-returning query.
 *
 * Written once and reused by both the read-only check and the atomic write, so
 * the two can never disagree about what "served" means.
 */
async function authorizes(input: ServedInput): Promise<boolean | "unreadable"> {
  const { businessId, recId, account, action } = normalize(input);
  const sql = getDb();
  try {
    // No account, no answer — for every action. The current snapshot is a
    // per-account fact, and so is a prior deferral: without the account a
    // deferral taken under one account would authorize an undefer from
    // another. This refuses rather than falling back to a business-wide read.
    if (!account) return false;
    if (action === "undeferred") {
      /*
       * The LATEST response must itself be an unexpired deferral.
       *
       * Not "a deferred row exists": defer -> undefer -> undefer would then
       * pass forever. And not "the latest unexpired row": a deferral that has
       * already reappeared has been lifted by expiry, so there is nothing left
       * for an operator to lift, and that is the automatic-expiry semantics
       * being preserved rather than worked around.
       */
      const rows = (await sql`
        SELECT 1
        FROM (
          SELECT action, reappear_at
          FROM meta_decision_responses
          WHERE business_id = ${businessId}
            AND provider_account_id = ${account}
            AND rec_id = ${recId}
          ORDER BY timestamp DESC
          LIMIT 1
        ) latest
        WHERE latest.action = 'deferred'
          AND (latest.reappear_at IS NULL OR latest.reappear_at > NOW())
          AND EXISTS (
            SELECT 1
            FROM business_provider_accounts bpa
            INNER JOIN provider_accounts pa
              ON pa.id = bpa.provider_account_ref_id
            WHERE bpa.business_id = ${businessId}
              AND bpa.provider = 'meta'
              AND bpa.is_selected
              AND pa.external_account_id = ${account}
          )
      `) as Array<Record<string, unknown>>;
      return rows.length > 0;
    }
    // The current-snapshot actions.
    const rows = (await sql`
      WITH current_snapshot AS (
        SELECT MAX(snapshot_date) AS snapshot_date
        FROM meta_decision_snapshots_daily
        WHERE business_id = ${businessId}
          AND provider_account_id = ${account}
          AND COALESCE(kind, 'recommendation') = 'recommendation'
      )
      SELECT snapshot.snapshot_date::text AS snapshot_date
      FROM meta_decision_snapshots_daily snapshot, current_snapshot
      WHERE snapshot.business_id = ${businessId}
        AND snapshot.provider_account_id = ${account}
        AND snapshot.rec_id = ${recId}
        AND snapshot.snapshot_date = current_snapshot.snapshot_date
        AND COALESCE(snapshot.kind, 'recommendation') = 'recommendation'
        AND EXISTS (
          SELECT 1
          FROM business_provider_accounts bpa
          INNER JOIN provider_accounts pa
            ON pa.id = bpa.provider_account_ref_id
          WHERE bpa.business_id = ${businessId}
            AND bpa.provider = 'meta'
            AND bpa.is_selected
            AND pa.external_account_id = ${account}
        )
      LIMIT 1
    `) as Array<{ snapshot_date?: unknown }>;
    return rows.length > 0;
  } catch {
    return "unreadable";
  }
}

export async function readServedMetaRecommendation(
  input: ServedInput,
): Promise<ServedMetaRecommendationResult> {
  const { businessId, recId } = normalize(input);
  // Neither can be established, so nothing can be served against them. Not
  // "unavailable": the source was never asked, and the caller supplied nothing
  // to ask about.
  if (!businessId || !recId) return { status: "not_served" };
  if (!CURRENT_SNAPSHOT_ACTIONS.includes(input.action) && input.action !== "undeferred") {
    return { status: "not_served" };
  }
  const verdict = await authorizes(input);
  if (verdict === "unreadable") {
    /*
     * Includes the unmigrated case. A missing table is a source that cannot
     * answer, not a source that answered "no" — and the difference decides
     * whether the operator is told their recommendation does not exist or that
     * the check could not run.
     */
    return { status: "source_unavailable" };
  }
  return { status: verdict ? "served" : "not_served" };
}
