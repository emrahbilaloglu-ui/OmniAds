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

    expect(html).toContain("intent_1");
    expect(html).toContain("Real Campaign");
    expect(html).toContain("PAUSED");
    expect(html).toContain("Jul 10, 10:00");
    expect(html).toContain("by —");
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

  it("keeps a terminal partial campaign as a real PAUSED receipt without error chrome", () => {
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
    expect(html).toContain("PAUSED");
    expect(html).toContain("Jul 10, 10:05");
    expect(html).not.toContain("Jul 12");
    expect(html).toContain("selected_campaign_ids=campaign_partial");
    expect(html).not.toContain("provider_outcome_ambiguous");
    expect(html).not.toContain("Provider response was ambiguous");
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
});
