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

export function classifyMetaSyncFailure(input: {
  error?: unknown;
  errorClass?: string | null;
  message?: string | null;
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
