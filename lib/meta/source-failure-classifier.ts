/**
 * Turn a thrown source read into a contracted failure code and an operator
 * sentence — never into the raw `Error.message`.
 *
 * Account Intelligence printed `outcome.reason.message` straight onto the
 * screen. That is the master plan's WP9 rule "Ham Error.message basılmaz", and
 * it is a rule for two independent reasons:
 *
 * 1. **It leaks.** A driver error carries the failing SQL, table and column
 *    names, and sometimes bound parameters; a fetch error carries the URL,
 *    which for a provider call can carry an access token. None of that belongs
 *    on an operator's screen, and §17's security items forbid a token or PII
 *    reaching a client payload.
 * 2. **It does not help.** `relation "meta_page_status" does not exist` tells a
 *    media buyer nothing they can act on. "A pending database migration has not
 *    been applied" tells them it is not their data and not their fault.
 *
 * The raw message is not discarded — the caller logs it server-side. It stops
 * being the thing the operator reads.
 */
import { isMissingRelationError } from "@/lib/db-schema-readiness";
import {
  META_FAILURES,
  type MetaFailureCode,
} from "@/lib/meta/read-state-contract";

export interface ClassifiedSourceFailure {
  code: MetaFailureCode;
  /** The operator's sentence, from the §9.1 dictionary. */
  message: string;
  /** For the server log only. Never returned to a client payload. */
  detail: string;
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Classification is by structure first, text second.
 *
 * A driver code (`42P01`) or an HTTP status is a fact; a substring match on a
 * message is a guess, and it is checked only after the facts run out. Anything
 * unrecognised is `source_read_failed`, which says the read did not succeed
 * without claiming to know why — the honest answer, and one the operator can
 * still act on by retrying.
 */
export function classifySourceFailure(error: unknown): ClassifiedSourceFailure {
  const detail = rawMessage(error);
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : null;
  const lower = detail.toLowerCase();

  const code: MetaFailureCode = isMissingRelationError(error)
    ? "schema_not_ready"
    : status === 429 || lower.includes("rate limit")
      ? "provider_rate_limited"
      : status === 401 ||
          lower.includes("access token has expired") ||
          lower.includes("token is missing")
        ? "provider_auth_expired"
        : status === 403 || lower.includes("permission")
          ? "capability_read_denied"
          : "source_read_failed";

  return { code, message: META_FAILURES[code].message, detail };
}
