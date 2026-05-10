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
});
