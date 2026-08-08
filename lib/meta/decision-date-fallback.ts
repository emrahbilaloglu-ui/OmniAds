/**
 * Why a decision snapshot date could not be resolved.
 *
 * The as-of resolver wraps its lookups in catch blocks whose comments assume
 * the only possible cause is a schema/capability gate — a table that does not
 * exist yet on an older deployment. That assumption hides a different class of
 * failure entirely: a query that references a column the table never had fails
 * exactly the same way, silently, forever, on every environment.
 *
 * Classifying the cause does not change which date is served. It makes the
 * difference between "this deployment has not migrated yet" and "this query is
 * wrong" visible, which is the prerequisite for deciding whether the fallback
 * is benign.
 */

export type DecisionDateFallbackCause =
  | "relation_missing"
  | "column_missing"
  | "permission_denied"
  | "timeout"
  | "unknown";

interface PostgresLikeError {
  code?: unknown;
  message?: unknown;
}

/**
 * Classify a failed snapshot-date lookup.
 *
 * Postgres SQLSTATEs are used where available because they are unambiguous;
 * the message is only consulted as a fallback.
 */
export function classifyDecisionDateFallback(error: unknown): DecisionDateFallbackCause {
  const candidate = error as PostgresLikeError | null;
  const code = typeof candidate?.code === "string" ? candidate.code : null;

  // 42P01 undefined_table, 42703 undefined_column, 42501 insufficient_privilege,
  // 57014 query_canceled.
  if (code === "42P01") return "relation_missing";
  if (code === "42703") return "column_missing";
  if (code === "42501") return "permission_denied";
  if (code === "57014") return "timeout";

  const message =
    typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";
  if (!message) return "unknown";
  if (message.includes("does not exist")) {
    if (message.includes("column")) return "column_missing";
    if (message.includes("relation")) return "relation_missing";
  }
  if (message.includes("permission denied")) return "permission_denied";
  if (message.includes("timeout") || message.includes("canceling statement")) {
    return "timeout";
  }
  return "unknown";
}

/**
 * Whether this cause is an expected capability gate.
 *
 * A missing table is expected on a deployment that has not migrated. A missing
 * column is not: the schema exists and the query disagrees with it, which is a
 * defect rather than a rollout state.
 */
export function isExpectedCapabilityGate(cause: DecisionDateFallbackCause): boolean {
  return cause === "relation_missing";
}

export function describeDecisionDateFallback(cause: DecisionDateFallbackCause): string {
  switch (cause) {
    case "relation_missing":
      return "Snapshot table is not present on this deployment yet.";
    case "column_missing":
      return "Snapshot query references a column this schema does not have.";
    case "permission_denied":
      return "Database role cannot read the snapshot table.";
    case "timeout":
      return "Snapshot date lookup timed out.";
    default:
      return "Snapshot date lookup failed for an unrecognised reason.";
  }
}
