/**
 * THE ONE RULE FOR A PROVIDER-SUPPLIED TRACE ID.
 *
 * `fbtrace_id` is the only free-form STRING this codebase carries out of a Meta
 * error body. Everything else it keeps is numeric (`code`, `error_subcode`), a
 * boolean (`is_transient`) or our own HTTP status, and the failure messages are
 * built from those rather than from the provider's prose — precisely so a
 * durable `meta_sync_partitions.last_error`, a `meta_sync_runs.error_message`,
 * a persisted pagination receipt or an operator log cannot be written by a
 * third party.
 *
 * The trace id defeated that. It was accepted with `String(...).trim()` and
 * nothing else, so ANY value Meta returned in that field travelled the whole
 * way: prose, a quoted request including its query string, newlines and control
 * characters that split a log line into two, the `:` and ` ` delimiters the
 * failure messages use as structure, and unbounded length. A provider — or
 * anything able to answer as one — could therefore choose part of the content
 * of a durable operator-facing record.
 *
 * A real Facebook trace id is a short opaque token. The rule is exactly that
 * shape, and it is enforced in TWO places on purpose: when the identity is
 * PARSED, so nothing unsafe is ever constructed or persisted, and again when a
 * message or log line is FORMATTED, so a value that reached a carrier by some
 * other route still cannot be printed. One module, imported by both, so the
 * two cannot drift into different rules.
 *
 * A value that fails the rule is dropped entirely rather than repaired.
 * Trimming, truncating or escaping it would keep provider-chosen bytes in the
 * record while implying they had been vetted; `null` says the provider did not
 * supply a usable handle, which is the honest statement.
 */
const META_GRAPH_TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeMetaGraphTraceId(value: unknown): value is string {
  return typeof value === "string" && META_GRAPH_TRACE_ID_PATTERN.test(value);
}

/**
 * The trace id, or `null`.
 *
 * Surrounding whitespace is tolerated because it is a transport artefact, not
 * content; anything that still fails the pattern after trimming is refused.
 */
export function sanitizeMetaGraphTraceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return META_GRAPH_TRACE_ID_PATTERN.test(trimmed) ? trimmed : null;
}
