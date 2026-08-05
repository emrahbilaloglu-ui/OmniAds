import { describe, expect, it } from "vitest";

import { buildDiagnosedGoogleAdsErrorMessage } from "@/lib/google-ads-gaql";
import { classifyGoogleAdsSyncFailure } from "@/lib/sync/google-ads-error-classification";

// THE INCIDENT THIS ENCODES (2026-08-05)
//
// `google_ads_sync_jobs.last_error` held 22 rows/day of
//   "google_ads_product_daily_fetch_failed: query=product_performance_legacy:
//    apiStatus=INVALID_ARGUMENT: message=Request contains an invalid argument."
// which names neither the rejected field nor anything else actionable. Google
// does report the field, but only in `details[].location.fieldPathElements`,
// which was not even present in our response type.
//
// The catch is that `last_error` is ALSO what the retry classifier reads, so
// enrichment is not a free win: Google's human-facing detail text can contain
// classifier vocabulary and silently re-route the retry decision.
describe("buildDiagnosedGoogleAdsErrorMessage", () => {
  it("names the rejected field and the query, which the raw message never did", () => {
    const result = buildDiagnosedGoogleAdsErrorMessage({
      message: "Request contains an invalid argument.",
      detailMessage: "Unrecognized field in the query.",
      fieldPathElements: [{ fieldName: "segments" }, { fieldName: "product_title" }],
      queryName: "product_performance_legacy",
    });

    expect(result).toContain("Request contains an invalid argument.");
    expect(result).toContain("field=segments.product_title");
    expect(result).toContain("queryName=product_performance_legacy");
    expect(result).toContain("detail=Unrecognized field in the query.");
  });

  it("renders repeated field path elements with their index", () => {
    const result = buildDiagnosedGoogleAdsErrorMessage({
      message: "Request contains an invalid argument.",
      fieldPathElements: [
        { fieldName: "operations", index: 3 },
        { fieldName: "create" },
      ],
      queryName: "product_performance",
    });

    expect(result).toContain("field=operations[3].create");
  });

  // ── The guard: enrichment must never move the retry decision ──────────────

  it("drops detail text that would flip a budget hold into an auth failure", () => {
    // Reproduced against the real classifier: appending this detail naively
    // turns `daily_request_budget_exhausted` (wait for the UTC reset) into
    // `account_action_required` (terminal, stop retrying) — a recoverable lane
    // would be parked until somebody reconnected an account that is fine.
    const message = "Daily Google Ads request budget reached for business 979a04f6.";
    const hostileDetail = "permission denied for this manager account";

    expect(
      classifyGoogleAdsSyncFailure({
        message: `${message} | detail=${hostileDetail}`,
      }).errorClass,
    ).not.toBe(classifyGoogleAdsSyncFailure({ message }).errorClass);

    const result = buildDiagnosedGoogleAdsErrorMessage({
      message,
      detailMessage: hostileDetail,
      fieldPathElements: [{ fieldName: "customer" }],
      queryName: "product_performance",
    });

    expect(result).not.toContain(hostileDetail);
    // The structured, classifier-inert parts still survive.
    expect(result).toContain("field=customer");
    expect(result).toContain("queryName=product_performance");
  });

  it("drops detail text that would flip a retryable error into a terminal one", () => {
    // "Request contains an invalid argument." classifies as `transient` today.
    // Google's detail for a rejected OAuth-scoped field can mention invalid_grant,
    // and appending it would re-read the error as `account_action_required`,
    // parking the lane behind a reconnect nobody actually needs.
    const message = "Request contains an invalid argument.";
    const hostileDetail = "invalid_grant: token has been expired or revoked";

    expect(
      classifyGoogleAdsSyncFailure({
        message: `${message} | detail=${hostileDetail}`,
      }).errorClass,
    ).not.toBe(classifyGoogleAdsSyncFailure({ message }).errorClass);

    const result = buildDiagnosedGoogleAdsErrorMessage({
      message,
      detailMessage: hostileDetail,
      queryName: "account_daily",
    });

    expect(result).not.toContain(hostileDetail);
    expect(result).toContain("queryName=account_daily");
  });

  it("keeps detail text when it cannot move the classification", () => {
    // The mirror of the guard: an already-terminal auth failure stays terminal
    // no matter what the detail says, so the detail is worth keeping.
    const message = "invalid_grant: token has been expired or revoked";
    const detailMessage = "the resource is temporarily unavailable, retry later";

    const result = buildDiagnosedGoogleAdsErrorMessage({
      message,
      detailMessage,
      queryName: "account_daily",
    });

    expect(result).toContain(detailMessage);
    expect(classifyGoogleAdsSyncFailure({ message: result }).errorClass).toBe(
      classifyGoogleAdsSyncFailure({ message }).errorClass,
    );
  });

  it("preserves the classification of every message it produces", () => {
    const baselines = [
      "Daily Google Ads request budget reached for business x.",
      "Request contains an invalid argument.",
      "invalid_grant: token has been expired or revoked",
      "permission denied",
      "RESOURCE_EXHAUSTED",
    ];
    const details = [
      "Unrecognized field in the query.",
      "the resource is temporarily unavailable",
      "Request timeout while validating",
      "permission denied for this manager account",
      "customer not enabled",
    ];

    for (const message of baselines) {
      const expected = classifyGoogleAdsSyncFailure({ message }).errorClass;
      for (const detailMessage of details) {
        const produced = buildDiagnosedGoogleAdsErrorMessage({
          message,
          detailMessage,
          fieldPathElements: [{ fieldName: "segments" }],
          queryName: "q",
        });
        expect(
          classifyGoogleAdsSyncFailure({ message: produced }).errorClass,
          `"${message}" + "${detailMessage}" must stay ${expected}`,
        ).toBe(expected);
      }
    }
  });

  it("leaves a message with no extra detail untouched apart from the query name", () => {
    const result = buildDiagnosedGoogleAdsErrorMessage({
      message: "Google Ads API error: 500",
      detailMessage: null,
      fieldPathElements: null,
      queryName: null,
    });

    expect(result).toBe("Google Ads API error: 500");
  });
});
