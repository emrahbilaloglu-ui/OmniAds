export type GoogleAdsDeadLetterRecoveryKind =
  | "replayable_transient"
  | "terminal_action_required"
  | "unknown";

export interface GoogleAdsSyncFailureClassification {
  errorClass: string;
  terminal: boolean;
  retryDelayMinutes: number;
  recoveryKind: GoogleAdsDeadLetterRecoveryKind;
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

export function classifyGoogleAdsSyncFailure(input: {
  error?: unknown;
  errorClass?: string | null;
  message?: string | null;
  nowMs?: number;
}): GoogleAdsSyncFailureClassification {
  const rawMessage =
    input.message != null ? String(input.message) : normalizeMessage(input.error);
  const lower = rawMessage.toLowerCase();
  const upper = rawMessage.toUpperCase();
  const providedClass = input.errorClass?.trim().toLowerCase() ?? "";

  // A surface that was paused stays paused, but it is NOT an account verdict.
  //
  // The pause message says it outright — "a terminal access failure for the
  // same surface" — yet folding it into `account_action_required` stamped a
  // per-surface problem with the one class the account-wide lease block keys
  // on. Production showed the consequence: TheSwaf's keyword_daily paused,
  // every other surface on that account stopped for 24 hours, and the only
  // work that ran all morning was the paused surface failing again. The same
  // account read ad_daily, device_daily and campaign_daily without trouble.
  //
  // `scope_action_required` is already carried as terminal and action-required
  // by the scope-level lists in lib/google-ads/warehouse.ts, and is absent from
  // the account-wide block list there. Emitting it keeps the surface stopped
  // while leaving the rest of the account alone.
  if (
    providedClass === "scope_action_required" ||
    lower.includes("google_ads_scope_action_required")
  ) {
    return {
      errorClass: "scope_action_required",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
      reasonCode: "google_ads_scope_action_required",
    };
  }

  if (
    providedClass === "account_action_required" ||
    providedClass === "invalid_grant" ||
    providedClass === "unauthenticated" ||
    providedClass === "authentication_error" ||
    hasAny(lower, [
      "invalid_grant",
      "token has been expired or revoked",
      "refresh token",
      "login required",
      "reauth",
      "reconnect google",
      "missing the google ads scope",
      "no refresh token",
      "access token has expired",
    ]) ||
    upper.includes("UNAUTHENTICATED") ||
    upper.includes("AUTHENTICATION_ERROR")
  ) {
    return {
      errorClass: "account_action_required",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
      reasonCode: "google_ads_auth_action_required",
    };
  }

  if (
    providedClass === "permission" ||
    providedClass === "permission_denied" ||
    hasAny(lower, [
      "permission denied",
      "does not have permission",
      "not authorized",
      "not have access",
      "provider_request_failed:permission",
      "permission:status_403",
      "403 forbidden",
      "user permission",
      "login customer",
      "customer hierarchy",
      "manager account",
      "manager/customer",
    ]) ||
    upper.includes("PERMISSION_DENIED") ||
    upper.includes("USER_PERMISSION_DENIED")
  ) {
    return {
      errorClass: "account_action_required",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
      reasonCode: "google_ads_permission_action_required",
    };
  }

  if (
    providedClass === "customer_not_enabled" ||
    providedClass === "customer_not_found" ||
    hasAny(lower, [
      "customer not enabled",
      "customer_not_enabled",
      "customer not found",
      "customer_not_found",
      "customer is not enabled",
      "account suspended",
      "suspended account",
      "account cancelled",
      "account canceled",
      "cancelled account",
      "canceled account",
      "account is closed",
    ]) ||
    upper.includes("CUSTOMER_NOT_ENABLED") ||
    upper.includes("CUSTOMER_NOT_FOUND")
  ) {
    return {
      errorClass: "account_action_required",
      terminal: true,
      retryDelayMinutes: 0,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
      reasonCode: "google_ads_customer_action_required",
    };
  }

  if (
    providedClass === "daily_request_budget" ||
    hasAny(lower, [
      "request budget reached",
      "daily google ads request budget",
    ])
  ) {
    // The per-business daily request budget only resets at UTC midnight. A short
    // retry just re-fails instantly and lets one budget-exhausted business
    // monopolize the worker, starving every other business (observed 2026-06-17).
    // Back off until the daily reset instead.
    const nowMs = input.nowMs ?? Date.now();
    const reset = new Date(nowMs);
    reset.setUTCHours(24, 0, 0, 0);
    const minutesUntilReset = Math.max(
      15,
      Math.ceil((reset.getTime() - nowMs) / 60000),
    );
    return {
      errorClass: "daily_request_budget_exhausted",
      terminal: false,
      retryDelayMinutes: minutesUntilReset,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "google_ads_daily_budget_retry",
    };
  }

  if (
    providedClass === "quota" ||
    /RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(rawMessage)
  ) {
    return {
      errorClass: "quota",
      terminal: false,
      retryDelayMinutes: 10,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "google_ads_quota_retry",
    };
  }

  if (
    providedClass === "database_timeout" ||
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
      reasonCode: "google_ads_database_timeout",
    };
  }

  if (hasAny(lower, ["no space left on device", "could not extend file"])) {
    return {
      errorClass: "database_disk_pressure",
      terminal: false,
      retryDelayMinutes: 10,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode: "google_ads_database_disk_pressure",
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
      reasonCode: "google_ads_duplicate_upsert_batch",
    };
  }

  if (
    providedClass === "transient" ||
    providedClass === "lease_conflict" ||
    hasAny(lower, [
      "timeout",
      "econnreset",
      "enotfound",
      "eai_again",
      "etimedout",
      "server_login_retry",
      "partial pkt",
      "temporarily unavailable",
      "temporary unavailable",
      "unavailable",
      "fetch failed",
      "network",
      "aborted",
    ]) ||
    /\b50[0-4]\b/.test(rawMessage)
  ) {
    return {
      errorClass: providedClass === "lease_conflict" ? "lease_conflict" : "transient",
      terminal: false,
      retryDelayMinutes: 5,
      recoveryKind: "replayable_transient",
      actionRequired: false,
      reasonCode:
        providedClass === "lease_conflict"
          ? "google_ads_lease_conflict_retry"
          : "google_ads_transient_retry",
    };
  }

  if (providedClass === "application" || providedClass === "payload") {
    return {
      errorClass: providedClass,
      terminal: false,
      retryDelayMinutes: 0,
      recoveryKind: "unknown",
      actionRequired: false,
      reasonCode: "google_ads_application_error",
    };
  }

  return {
    errorClass: providedClass || "transient",
    terminal: false,
    retryDelayMinutes: 5,
    recoveryKind: providedClass ? "unknown" : "replayable_transient",
    actionRequired: false,
    reasonCode: providedClass
      ? "google_ads_unknown_error_class"
      : "google_ads_transient_default",
  };
}

export function shouldDeadLetterGoogleAdsFailure(input: {
  errorClass: string;
  terminal: boolean;
  attemptCount: number;
  maxAttempts: number;
}) {
  if (input.terminal) return true;
  const retryableClasses = new Set([
    "quota",
    "daily_request_budget_exhausted",
    "transient",
    "database_timeout",
    "database_disk_pressure",
    "duplicate_upsert_batch",
    "lease_conflict",
  ]);
  if (retryableClasses.has(input.errorClass)) return false;
  return input.attemptCount + 1 >= input.maxAttempts;
}
