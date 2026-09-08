export type MetaDeadLetterRecoveryKind =
  | "replayable_transient"
  | "terminal_action_required"
  | "unknown";

export interface MetaSyncFailureClassification {
  errorClass: string;
  terminal: boolean;
  retryDelayMinutes: number;
  recoveryKind: MetaDeadLetterRecoveryKind;
  actionRequired: boolean;
  reasonCode: string;
}

function normalizeMessage(value: unknown) {
  if (value instanceof Error) return value.message;
  return String(value ?? "");
}

function hasAny(haystack: string, needles: string[]) {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Whether the message is PostgreSQL talking about our own schema.
 *
 * The account-checkpoint rule matches the bare substring "checkpoint", and it
 * sits above every database rule — so `duplicate key value violates unique
 * constraint "meta_sync_checkpoints_pkey"` was diagnosed as a Facebook account
 * checkpoint: terminal, dead-lettered on the first attempt, and flagged
 * actionRequired, telling the operator to go log in to Facebook and clear a
 * checkpoint that does not exist. Our table is literally named
 * meta_sync_checkpoints, so this collides constantly.
 */
function looksLikeDatabaseError(lower: string) {
  return hasAny(lower, [
    "meta_sync_checkpoints",
    'relation "',
    'column "',
    'constraint "',
    "violates",
    "syntax error at or near",
  ]);
}

/**
 * The Graph error identity a failure can carry, and where it comes from.
 *
 * `MetaGraphRequestError` in lib/api/meta.ts attaches `errorCode`,
 * `errorSubcode` and `isTransient` to everything it throws, and
 * `classifyMetaError` in lib/sync/meta-sync.ts passes the thrown value straight
 * into this function — so reading the identity off the error is what lets a
 * provider code reach the classifier without rewriting the call sites.
 *
 * Duck-typed rather than imported: this module belongs to the sync layer and
 * must not take a dependency on the Graph client. A caller that already has the
 * identity in hand (a persisted row, a test) can pass the three fields
 * directly instead.
 */
function readGraphErrorIdentity(input: {
  error?: unknown;
  errorCode?: number | null;
  errorSubcode?: number | null;
  isTransient?: boolean | null;
}) {
  const carrier =
    input.error != null && typeof input.error === "object"
      ? (input.error as Record<string, unknown>)
      : null;
  const numberOrNull = (explicit: unknown, key: string) => {
    const value = explicit ?? carrier?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const transient = input.isTransient ?? carrier?.isTransient;
  return {
    errorCode: numberOrNull(input.errorCode, "errorCode"),
    errorSubcode: numberOrNull(input.errorSubcode, "errorSubcode"),
    isTransient: typeof transient === "boolean" ? transient : null,
  };
}

/**
 * Codes that name a credential or account problem rather than a request one.
 *
 * The two subcodes are the ones that mean a PERSON has to go clear something on
 * facebook.com; every other subcode under these codes is a token problem the
 * operator fixes by reconnecting. This split is the whole reason the
 * checkpoint verdict must not be reached by substring: our own table is named
 * meta_sync_checkpoints (see looksLikeDatabaseError).
 */
const META_GRAPH_SESSION_CODES = new Set([102, 190]);
const META_GRAPH_CHECKPOINT_SUBCODES = new Set([459, 464]);

/** Permission refusals. 294 is the one this repo's Graph suite fixtures. */
const META_GRAPH_PERMISSION_CODES = new Set([10, 200, 272, 294]);

/**
 * Throttles, and the two generic "try again" codes.
 *
 * Both sets together are exactly META_TRANSIENT_GRAPH_ERROR_CODES in
 * lib/api/meta.ts — the codes that module retries a PAGE on. They are split
 * here because they are re-run differently: a throttle needs the long quota
 * backoff, and 1/2 are the provider's generic transient signal.
 */
const META_GRAPH_THROTTLE_CODES = new Set([
  4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008,
  80014,
]);
const META_GRAPH_TEMPORARY_CODES = new Set([1, 2]);

/**
 * Code 100 is Graph's invalid-parameter refusal — a request this client built
 * wrong. Retrying the identical request cannot fix it, so it is terminal and
 * NOT actionRequired: there is nothing for the operator to do on facebook.com.
 */
const META_GRAPH_INVALID_PARAMETER_CODES = new Set([100]);

/**
 * Classify from the provider's own structured verdict.
 *
 * Returns null when the identity says nothing this function recognises, which
 * is the only case the message fallback below is allowed to handle.
 */
function classifyFromGraphErrorIdentity(identity: {
  errorCode: number | null;
  errorSubcode: number | null;
  isTransient: boolean | null;
}): MetaSyncFailureClassification | null {
  const code = identity.errorCode;
  if (code !== null) {
    if (META_GRAPH_SESSION_CODES.has(code)) {
      const checkpointed =
        identity.errorSubcode !== null &&
        META_GRAPH_CHECKPOINT_SUBCODES.has(identity.errorSubcode);
      return {
        errorClass: checkpointed ? "account_checkpoint" : "invalid_token",
        terminal: true,
        retryDelayMinutes: 0,
        recoveryKind: "terminal_action_required",
        actionRequired: true,
        reasonCode: checkpointed
          ? "meta_account_checkpoint"
          : "meta_invalid_token",
      };
    }
    if (META_GRAPH_PERMISSION_CODES.has(code)) {
      return {
        errorClass: "permission",
        terminal: true,
        retryDelayMinutes: 0,
        recoveryKind: "terminal_action_required",
        actionRequired: true,
        reasonCode: "meta_permission_required",
      };
    }
    if (META_GRAPH_THROTTLE_CODES.has(code)) {
      return {
        errorClass: "quota",
        terminal: false,
        retryDelayMinutes: 10,
        recoveryKind: "replayable_transient",
        actionRequired: false,
        reasonCode: "meta_quota_retry",
      };
    }
    if (META_GRAPH_TEMPORARY_CODES.has(code)) {
      return {
        errorClass: "transient",
        terminal: false,
        retryDelayMinutes: 3,
        recoveryKind: "replayable_transient",
        actionRequired: false,
        reasonCode: "meta_provider_transient_code",
      };
    }
    if (META_GRAPH_INVALID_PARAMETER_CODES.has(code)) {
      return {
        errorClass: "payload",
        terminal: true,
        retryDelayMinutes: 0,
        recoveryKind: "unknown",
        actionRequired: false,
        reasonCode: "meta_payload_error",
      };
    }
  }
  // An unrecognised code the provider itself marked retryable. The reverse —
  // an unrecognised code marked NOT transient — deliberately falls through
  // rather than inventing a terminal verdict for a code nothing here can name;
  // the attempt cap in shouldDeadLetterMetaFailure still makes it visible.
  if (identity.isTransient === true) {
    return {
      errorClass: "transient",
      terminal: false,
      retryDelayMinutes: 3,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_provider_transient_flag",
    };
  }
  return null;
}

export function classifyMetaSyncFailure(input: {
  error?: unknown;
  errorClass?: string | null;
  message?: string | null;
  /**
   * The provider's structured verdict. Supplied directly, or read off
   * `input.error` when it carries it — see readGraphErrorIdentity.
   */
  errorCode?: number | null;
  errorSubcode?: number | null;
  isTransient?: boolean | null;
}): MetaSyncFailureClassification {
  const rawMessage =
    input.message != null ? String(input.message) : normalizeMessage(input.error);
  const lower = rawMessage.toLowerCase();
  const providedClass = input.errorClass?.trim().toLowerCase() ?? "";

  if (providedClass === "lease_conflict" || lower.startsWith("lease_conflict:")) {
    return {
      errorClass: "lease_conflict",
      terminal: false,
      retryDelayMinutes: 1,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_lease_conflict_retry",
    };
  }

  // THE STRUCTURED VERDICT DECIDES. A Graph failure that carries a code is
  // classified from that code and nothing else; the message is not consulted.
  const structured = classifyFromGraphErrorIdentity(
    readGraphErrorIdentity(input),
  );
  if (structured) return structured;

  /*
    EVERYTHING BELOW IS A COMPATIBILITY FALLBACK, and only for failures that
    carry no structured code.

    Two kinds of input reach it. Failures raised inside this application — a
    lease race, a Postgres error, an out-of-memory — never had a Graph code to
    begin with. And a persisted Meta failure re-read later has only the text and
    the class column it was stored with: `classifyMetaDeadLetterCandidate` in
    lib/meta/warehouse.ts reconstructs a verdict from
    `meta_sync_partitions.last_error` and the run's `error_class`, and those
    rows predate any structured code being captured.

    Substring matching on a provider message is guesswork, and it has been wrong
    in production before (see looksLikeDatabaseError). Do not extend it to cover
    a provider condition that has a code — add the code above instead.
  */

  if (
    providedClass === "account_checkpoint" ||
    (!looksLikeDatabaseError(lower) &&
      hasAny(lower, [
        "cannot access the app",
        "log in to www.facebook.com",
        "checkpoint",
      ]))
  ) {
    return {
      errorClass: "account_checkpoint",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
      reasonCode: "meta_account_checkpoint",
    };
  }

  if (
    providedClass === "invalid_token" ||
    hasAny(lower, ["invalid oauth", "access token", "session has expired"])
  ) {
    return {
      errorClass: "invalid_token",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
      reasonCode: "meta_invalid_token",
    };
  }

  if (
    providedClass === "permission" ||
    hasAny(lower, [
      "permission",
      "not authorized",
      "does not have",
      "unsupported get request",
    ])
  ) {
    return {
      errorClass: "permission",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
      reasonCode: "meta_permission_required",
    };
  }

  if (
    providedClass === "quota" ||
    hasAny(lower, [
      "rate limit",
      "too many calls",
      "quota",
      "request limit reached",
      "user request limit reached",
    ])
  ) {
    return {
      errorClass: "quota",
      terminal: false,
      retryDelayMinutes: 10,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_quota_retry",
    };
  }

  if (
    hasAny(lower, [
      "database query timed out",
      "statement timeout",
      "timeout after",
    ])
  ) {
    return {
      errorClass: "database_timeout",
      terminal: false,
      retryDelayMinutes: 5,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_database_timeout",
    };
  }

  if (hasAny(lower, ["no space left on device", "could not extend file"])) {
    return {
      errorClass: "database_disk_pressure",
      terminal: false,
      retryDelayMinutes: 10,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_database_disk_pressure",
    };
  }

  if (
    hasAny(lower, [
      "on conflict do update command cannot affect row a second time",
      "cannot affect row a second time",
    ])
  ) {
    return {
      errorClass: "duplicate_upsert_batch",
      terminal: false,
      retryDelayMinutes: 5,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_duplicate_upsert_batch",
    };
  }

  if (
    hasAny(lower, [
      "network",
      "econnreset",
      "temporarily unavailable",
      "abort",
      "aborted",
      "fetch failed",
    ])
  ) {
    return {
      errorClass: "transient",
      terminal: false,
      retryDelayMinutes: 3,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_transient_network",
    };
  }

  if (hasAny(lower, ["invalid parameter", "malformed"])) {
    return {
      errorClass: "payload",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "unknown",
      actionRequired: false,
      reasonCode: "meta_payload_error",
    };
  }

  if (providedClass === "transient" || providedClass === "operational") {
    return {
      errorClass: providedClass,
      terminal: false,
      retryDelayMinutes: 5,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "meta_retryable_class",
    };
  }

  if (
    providedClass === "database_timeout" ||
    providedClass === "database_disk_pressure" ||
    providedClass === "duplicate_upsert_batch"
  ) {
    return {
      errorClass: providedClass,
      terminal: false,
      retryDelayMinutes: providedClass === "database_disk_pressure" ? 10 : 5,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: `meta_${providedClass}`,
    };
  }

  if (providedClass === "payload" || providedClass.startsWith("authoritative_")) {
    return {
      errorClass: providedClass,
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "unknown",
      actionRequired: false,
      reasonCode: "meta_terminal_non_account_error",
    };
  }

  return {
    errorClass: providedClass || "transient",
    terminal: false,
    retryDelayMinutes: 5,
    recoveryKind: providedClass ? "unknown" : "replayable_transient",
    actionRequired: false,
    reasonCode: providedClass ? "meta_unknown_error_class" : "meta_transient_default",
  };
}

export function shouldDeadLetterMetaFailure(input: {
  errorClass: string;
  terminal: boolean;
  attemptCount: number;
  maxAttempts: number;
}) {
  if (input.terminal) return true;

  // Classes that genuinely should retry without limit: an infrastructure
  // condition or a lease race resolves on its own, and dead-lettering the day
  // would not help.
  const alwaysRetryableClasses = new Set([
    "quota",
    "operational",
    "database_timeout",
    "database_disk_pressure",
    "duplicate_upsert_batch",
    "lease_conflict",
  ]);
  if (alwaysRetryableClasses.has(input.errorClass)) return false;

  // "transient" is the classifier's DEFAULT for any message it does not
  // recognise, so exempting it made META_PARTITION_MAX_ATTEMPTS unreachable for
  // every unknown failure. A deterministic 400, an out-of-memory, or a
  // permanently oversized partition retried forever, capped at an hour, and
  // never appeared in the dead-letter count the admin surface alarms on — the
  // day silently never landed. Honour the attempt cap so a repeating failure
  // becomes visible.
  return input.attemptCount + 1 >= input.maxAttempts;
}

/**
 * The ONLY text about a failure that may be logged or persisted.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * `meta_sync_jobs.last_error` was written as
 * `error instanceof Error ? error.message : String(error)`, so whatever the
 * provider (or undici, or PostgreSQL) put in a message went into the database
 * verbatim and into every log line beside it. `lib/api/meta.ts` builds Graph
 * URLs with `access_token` in the query string, and a failing request's message
 * can carry that URL — an undici `TypeError: fetch failed` carries its request
 * in `cause`, and a Graph 2xx error envelope echoes the request back. A
 * credential therefore had a path into durable storage through an error field
 * nobody thinks of as user data.
 *
 * ── What survives ───────────────────────────────────────────────────────────
 * Only facts this repository authored: the classifier's own `errorClass` and
 * `reasonCode`, whether it is terminal, and the provider's STRUCTURED codes
 * when they are present — `code`, `error_subcode`, `is_transient` and
 * `fbtrace_id`, all of which are identifiers rather than prose. Provider prose
 * never appears. The raw text is consumed once, here, to classify, and is not
 * carried out of this function.
 */
export interface MetaSafeFailureSummary {
  errorClass: string;
  reasonCode: string;
  terminal: boolean;
  actionRequired: boolean;
  providerCode: number | null;
  providerSubcode: number | null;
  providerTransient: boolean | null;
  fbtraceId: string | null;
}

/** Graph's own identifiers, read defensively from an unknown error shape. */
function readProviderCodes(error: unknown): {
  code: number | null;
  subcode: number | null;
  transient: boolean | null;
  fbtraceId: string | null;
} {
  const source = (error ?? {}) as Record<string, unknown>;
  const envelope =
    (source.error as Record<string, unknown> | undefined) ??
    ((source.body as Record<string, unknown> | undefined)?.error as
      | Record<string, unknown>
      | undefined) ??
    source;
  const numeric = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const fbtrace = envelope?.fbtrace_id;
  return {
    code: numeric(envelope?.code),
    subcode: numeric(envelope?.error_subcode),
    transient:
      typeof envelope?.is_transient === "boolean" ? envelope.is_transient : null,
    // An identifier, not prose: bounded and character-checked so a provider
    // cannot smuggle a sentence through it.
    fbtraceId:
      typeof fbtrace === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(fbtrace)
        ? fbtrace
        : null,
  };
}

export function summarizeMetaFailureForStorage(input: {
  error: unknown;
}): MetaSafeFailureSummary {
  const codesForClass = readProviderCodes(input.error);
  const classification = classifyMetaSyncFailure({
    error: input.error,
    errorCode: codesForClass.code,
    errorSubcode: codesForClass.subcode,
    isTransient: codesForClass.transient,
  });
  const codes = readProviderCodes(input.error);
  return {
    errorClass: classification.errorClass,
    reasonCode: classification.reasonCode,
    terminal: classification.terminal,
    actionRequired: classification.actionRequired,
    providerCode: codes.code,
    providerSubcode: codes.subcode,
    providerTransient: codes.transient,
    fbtraceId: codes.fbtraceId,
  };
}

/**
 * The single string form written to `last_error` and to logs.
 *
 * Locally authored in full: every segment is either a constant from this
 * module or one of the structured identifiers above.
 */
export function formatMetaFailureForStorage(input: {
  error: unknown;
}): string {
  const safe = summarizeMetaFailureForStorage(input);
  const parts = [
    `class=${safe.errorClass}`,
    `reason=${safe.reasonCode}`,
    `terminal=${safe.terminal}`,
  ];
  if (safe.providerCode !== null) parts.push(`code=${safe.providerCode}`);
  if (safe.providerSubcode !== null) parts.push(`subcode=${safe.providerSubcode}`);
  if (safe.providerTransient !== null) {
    parts.push(`transient=${safe.providerTransient}`);
  }
  if (safe.fbtraceId !== null) parts.push(`fbtrace=${safe.fbtraceId}`);
  return parts.join(" ");
}
