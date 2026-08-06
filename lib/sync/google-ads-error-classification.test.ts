import { describe, expect, it } from "vitest";
import {
  classifyGoogleAdsSyncFailure,
  shouldDeadLetterGoogleAdsFailure,
} from "@/lib/sync/google-ads-error-classification";

describe("classifyGoogleAdsSyncFailure", () => {
  it("classifies quota pressure as retryable", () => {
    const classification = classifyGoogleAdsSyncFailure({
      message: "RESOURCE_EXHAUSTED: quota exceeded with HTTP 429",
    });

    expect(classification).toMatchObject({
      errorClass: "quota",
      terminal: false,
      recoveryKind: "replayable_transient",
      actionRequired: false,
    });
    expect(
      shouldDeadLetterGoogleAdsFailure({
        errorClass: classification.errorClass,
        terminal: classification.terminal,
        attemptCount: 25,
        maxAttempts: 3,
      }),
    ).toBe(false);
  });

  it("classifies database and network failures as retryable", () => {
    expect(
      classifyGoogleAdsSyncFailure({
        message: "Database query timed out after 30000ms",
      }),
    ).toMatchObject({
      errorClass: "database_timeout",
      recoveryKind: "replayable_transient",
    });
    expect(
      classifyGoogleAdsSyncFailure({
        message: "Google Ads request failed: 503 temporarily unavailable",
      }),
    ).toMatchObject({
      errorClass: "transient",
      recoveryKind: "replayable_transient",
    });
  });

  it("classifies OAuth and account access failures as terminal action-required", () => {
    for (const message of [
      "invalid_grant: token has been expired or revoked",
      "UNAUTHENTICATED: login required",
      "PERMISSION_DENIED: user permission denied for customer hierarchy",
      "google_ads_product_daily_fetch_failed: query=product_performance_legacy: message=provider_request_failed:permission:status_403",
      "CUSTOMER_NOT_ENABLED: account suspended",
    ]) {
      const classification = classifyGoogleAdsSyncFailure({ message });
      expect(classification).toMatchObject({
        errorClass: "account_action_required",
        terminal: true,
        recoveryKind: "terminal_action_required",
        actionRequired: true,
      });
      expect(
        shouldDeadLetterGoogleAdsFailure({
          errorClass: classification.errorClass,
          terminal: classification.terminal,
          attemptCount: 0,
          maxAttempts: 3,
        }),
      ).toBe(true);
    }
  });

  it("keeps a paused surface terminal without stamping it as an account verdict", () => {
    const classification = classifyGoogleAdsSyncFailure({
      message:
        "google_ads_scope_action_required: product_daily sync is paused because this Google Ads account recently returned a terminal access failure",
    });

    // Still terminal and still action-required: the surface stays stopped.
    expect(classification).toMatchObject({
      errorClass: "scope_action_required",
      terminal: true,
      recoveryKind: "terminal_action_required",
      actionRequired: true,
    });
    expect(
      shouldDeadLetterGoogleAdsFailure({
        errorClass: classification.errorClass,
        terminal: classification.terminal,
        attemptCount: 0,
        maxAttempts: 3,
      }),
    ).toBe(true);

    // The point of the split: this class is absent from the account-wide lease
    // block, so one paused surface no longer stops every other surface on the
    // account. Production ran only the paused surface for a whole morning.
    expect(classification.errorClass).not.toBe("account_action_required");
  });

  it("keeps unknown application classes out of automatic replay by default", () => {
    const classification = classifyGoogleAdsSyncFailure({
      errorClass: "application",
      message: "Unexpected mapper invariant failed.",
    });

    expect(classification).toMatchObject({
      errorClass: "application",
      recoveryKind: "unknown",
      actionRequired: false,
    });
    expect(
      shouldDeadLetterGoogleAdsFailure({
        errorClass: classification.errorClass,
        terminal: classification.terminal,
        attemptCount: 2,
        maxAttempts: 3,
      }),
    ).toBe(true);
  });

  it("backs a daily request budget exhaustion off until the UTC reset, not a short retry", () => {
    const nowMs = Date.UTC(2026, 5, 17, 7, 0, 0); // 2026-06-17 07:00 UTC
    const classification = classifyGoogleAdsSyncFailure({
      message:
        "google_ads_product_daily_fetch_failed: query=product_performance: message=Daily Google Ads request budget reached for business 979a04f6.",
      nowMs,
    });

    expect(classification).toMatchObject({
      errorClass: "daily_request_budget_exhausted",
      terminal: false,
      recoveryKind: "replayable_transient",
      reasonCode: "google_ads_daily_budget_retry",
    });
    // 17h until the next UTC midnight — far longer than the old ~5 min transient
    // retry that let a budget-exhausted business monopolize the worker.
    expect(classification.retryDelayMinutes).toBe(1020);

    // Must NOT dead-letter even past maxAttempts; it is legitimately retryable
    // once the daily budget resets.
    expect(
      shouldDeadLetterGoogleAdsFailure({
        errorClass: classification.errorClass,
        terminal: classification.terminal,
        attemptCount: 10,
        maxAttempts: 6,
      }),
    ).toBe(false);
  });
});
