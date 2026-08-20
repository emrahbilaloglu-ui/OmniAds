/**
 * How far back the workspace action digest actually reads.
 *
 * WHY THIS CONSTANT EXISTS AT ALL. The action-log query in
 * `app/api/meta/decisions-workspace/route.ts` is bounded, and BOTH digest
 * counts — `actions.verifiedCount` and `actions.silentFailureCount` — are
 * computed by filtering the rows that query returned. On an account with more
 * qualifying rows in the window than the bound allows, those two numbers
 * describe the newest page of the window, not the window. The banner that
 * reads them said "This account's action digest since <date> carries M
 * recorded actions", which a reader takes as the window's total: every number
 * was measured, and the FRAME around it was wider than the measurement.
 *
 * A route module may export only the HTTP verbs and Next's segment-config
 * fields (see app/api/route-export-surface.test.ts), so the cap lives here
 * where the route, its tests and anything else that must agree with it can all
 * name the SAME number instead of each restating 20.
 *
 * RAISING IT DOES NOT FIX ANYTHING. A bigger cap is still a cap; the honest
 * fix is that the digest SAYS when the cap bound, which is what
 * `actions.countsTruncated` carries.
 *
 * IT IS NOT INTERPOLATED INTO THE QUERY, DELIBERATELY. `LIMIT ${cap}` in the
 * tagged template would make the bound a BIND PARAMETER, and a parameterised
 * LIMIT lets Postgres build a generic plan that a literal one cannot — the
 * exact shape of change that once turned a Decision Center read into 258s
 * against an 8s timeout and reported itself as an empty capability gate. The
 * SQL keeps its literal; this constant is pinned to it by a test that reads
 * the route's own source, so the two cannot drift in silence.
 */
export const META_ACTION_DIGEST_ROW_CAP = 20;
