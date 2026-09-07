import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import { LaunchIntentReceiptRows } from "./LaunchIntentReceiptRows";

function intent(overrides: Partial<MetaLaunchIntent> = {}): MetaLaunchIntent {
  return {
    id: "intent_1",
    businessId: "business_1",
    providerAccountId: "act_1",
    operation: "new_campaign",
    idempotencyKey: "idem_1",
    requestedStatus: "PAUSED",
    // No separate activation authorization: the fixture is a created-paused
    // intent, which is what every intent is until somebody approves turning
    // it on.
    activationApproval: null,
    activationReceipt: null,
    lineage: {
      sourceDecisionId: "decision_1",
      sourceDecisionSnapshotId: "snapshot_1",
      creativeBriefId: "brief_1",
      sourceDraftId: null,
    },
    requestPayload: { campaign: { name: "Real Campaign" } },
    requestFingerprint: "fingerprint",
    status: "succeeded",
    validationReceipt: null,
    resultReceipt: {
      completedAt: "2026-07-10T10:00:00.000Z",
      providerAccountId: "act_1",
      campaignId: "campaign_1",
      adsetIds: ["adset_1"],
      adIds: ["ad_1", "ad_2"],
      steps: [],
      recovery: { retrySupported: false, rollbackSupported: false },
    },
    errorReceipt: null,
    createdBy: "user_1",
    createdAt: "2026-07-10T09:59:00.000Z",
    updatedAt: "2026-07-12T18:30:00.000Z",
    startedAt: "2026-07-10T09:59:30.000Z",
    completedAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("LaunchIntentReceiptRows", () => {
  it("renders only the canonical horizontal receipt fields", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows intents={[intent()]} />,
    );

    expect(html).not.toContain("intent_1");
    expect(html).toContain("Real Campaign");
    expect(html).toContain("Paused");
    expect(html).toContain("Jul 10, 10:00");
    expect(html).not.toContain("by —");
    expect(html).not.toContain("Jul 12");
    expect(html).toContain("Open in Ads Manager");
    expect(html).toContain("selected_campaign_ids=campaign_1");
    expect(html).not.toContain("Decision");
    expect(html).not.toContain("Brief");
    expect(html).not.toContain("succeeded");
    expect(html).not.toContain("campaign campaign_1");
    expect(html).not.toContain("ad set");
    expect(html).not.toContain("2 ads");
    expect(html).not.toContain("automatic retry");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Undo");
  });

  it.each([
    "prepared",
    "validation_blocked",
    "write_blocked",
    "ready",
    "executing",
  ] as const)(
    "does not present %s intents as landed PAUSED receipts",
    (status) => {
      const html = renderToStaticMarkup(
        <LaunchIntentReceiptRows intents={[intent({ status })]} />,
      );

      expect(html).toContain('data-testid="launchpad-receipt-empty"');
      expect(html).not.toContain("Real Campaign");
      expect(html).not.toContain("Open in Ads Manager");
    },
  );

  it.each(["failed", "silent_failure"] as const)(
    "does not present %s without a real partial campaign receipt",
    (status) => {
      const html = renderToStaticMarkup(
        <LaunchIntentReceiptRows
          intents={[
            intent({
              status,
              resultReceipt: null,
              errorReceipt: null,
            }),
          ]}
        />,
      );

      expect(html).toContain('data-testid="launchpad-receipt-empty"');
      expect(html).not.toContain("Real Campaign");
    },
  );

  // A terminal partial campaign stays a listed, linkable receipt — dropping it
  // would hide a real provider object that needs reconciling in Meta — but its
  // status cell never claims a provider state verification could not confirm.
  // `silent_failure` is defined by this very surface as "the provider call
  // returned success, but verification could not confirm the entity. The
  // outcome is unknown", so PAUSED there is an assertion we cannot back, and an
  // unsupplied fact renders as an em-dash. The error chrome still stays off the
  // row: this card lists receipts, it is not an error log.
  it("keeps a terminal partial campaign listed and linkable but never claims its provider state", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows
        intents={[
          intent({
            status: "silent_failure",
            resultReceipt: null,
            completedAt: null,
            updatedAt: "2026-07-12T18:30:00.000Z",
            errorReceipt: {
              recordedAt: "2026-07-10T10:05:00.000Z",
              providerAccountId: "act_1",
              code: "provider_outcome_ambiguous",
              message: "Provider response was ambiguous.",
              failedAt: "ads",
              partialResult: {
                campaignId: "campaign_partial",
                adsetIds: [],
                adIds: [],
                steps: [],
              },
              recovery: { retrySupported: false, rollbackSupported: false },
            },
          }),
        ]}
      />,
    );

    expect(html).toContain("Real Campaign");
    expect(html).not.toContain("Paused");
    expect(html).toContain("Jul 10, 10:05");
    expect(html).not.toContain("Jul 12");
    expect(html).toContain("selected_campaign_ids=campaign_partial");
    expect(html).not.toContain("provider_outcome_ambiguous");
    expect(html).not.toContain("Provider response was ambiguous");
  });

  // The verified case is unchanged: a succeeded intent did have its objects
  // confirmed, so the row prints the state that was actually established.
  it("prints the provider state for a verified receipt", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows intents={[intent({ status: "succeeded" })]} />,
    );

    expect(html).toContain("Paused");
    expect(html).toContain('data-status="verified"');
  });

  it("shows a partially succeeded receipt as a distinct warning", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows
        intents={[intent({ status: "partially_succeeded" })]}
      />,
    );

    expect(html).toContain("Partially created");
    expect(html).toContain('data-status="partial"');
    expect(html).not.toContain(">Paused<");
  });

  it("does not claim a provider state for a failed partial receipt", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows intents={[intent({ status: "failed" })]} />,
    );

    // Listed and linkable — the campaign exists — but the state is unknown.
    expect(html).toContain("Real Campaign");
    expect(html).toContain("Open in Ads Manager");
    expect(html).not.toContain("Paused");
  });

  it("does not render a terminal status without a real campaign receipt", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows
        intents={[
          intent({
            resultReceipt: {
              ...intent().resultReceipt!,
              campaignId: null,
            },
          }),
        ]}
      />,
    );

    expect(html).toContain('data-testid="launchpad-receipt-empty"');
    expect(html).not.toContain("Real Campaign");
  });

  it("distinguishes loading and unreadable receipts from a measured empty list", () => {
    const loading = renderToStaticMarkup(
      <LaunchIntentReceiptRows intents={[]} loading />,
    );
    const unavailable = renderToStaticMarkup(
      <LaunchIntentReceiptRows
        intents={[]}
        unavailableReason="Recent launches are temporarily unavailable."
      />,
    );

    expect(loading).toContain("Loading recent launches…");
    expect(loading).not.toContain("No launches yet.");
    expect(unavailable).toContain(
      "Recent launches are temporarily unavailable.",
    );
    expect(unavailable).not.toContain("No launches yet.");
  });

  function addToExisting(overrides: Partial<MetaLaunchIntent> = {}) {
    return intent({
      id: "intent_add_1",
      operation: "add_to_existing",
      requestPayload: {
        mode: "add_to_existing",
        targets: [
          {
            targetCampaignId: "campaign_target",
            targetCampaignName: "Prospecting — Broad US",
            targetAdsetId: "adset_target",
          },
        ],
      },
      resultReceipt: {
        ...intent().resultReceipt!,
        // add_to_existing creates no campaign, so its receipt has none.
        campaignId: null,
      },
      ...overrides,
    });
  }

  it("keeps an add_to_existing receipt and links to its persisted target campaign", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows intents={[addToExisting()]} />,
    );

    expect(html).not.toContain('data-testid="launchpad-receipt-empty"');
    expect(html).not.toContain("intent_add_1");
    expect(html).toContain("Prospecting — Broad US");
    expect(html).toContain("Paused");
    expect(html).toContain("Open in Ads Manager");
    expect(html).toContain("selected_campaign_ids=campaign_target");
  });

  it("withholds the target link when no ad landed in the target campaign", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows
        intents={[
          addToExisting({
            status: "failed",
            resultReceipt: {
              ...intent().resultReceipt!,
              campaignId: null,
              adIds: [],
            },
          }),
        ]}
      />,
    );

    expect(html).toContain('data-testid="launchpad-receipt-empty"');
    expect(html).not.toContain("selected_campaign_ids=campaign_target");
  });
});
