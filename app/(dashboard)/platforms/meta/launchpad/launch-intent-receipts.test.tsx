import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import { LaunchIntentReceiptRows } from "./LaunchIntentReceiptRows";

function intent(
  overrides: Partial<MetaLaunchIntent> = {},
): MetaLaunchIntent {
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
    requestPayload: {},
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
    updatedAt: "2026-07-10T10:00:00.000Z",
    startedAt: "2026-07-10T09:59:30.000Z",
    completedAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("LaunchIntentReceiptRows", () => {
  it("renders immutable account-scoped result receipts without fake recovery actions", () => {
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows intents={[intent()]} />,
    );

    expect(html).toContain("Decision -&gt; Brief");
    expect(html).toContain("campaign campaign_1");
    expect(html).toContain("1 ad set");
    expect(html).toContain("2 ads");
    expect(html).toContain("no automatic retry or rollback");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Undo");
  });

  it("renders the stored error and partial-result receipt verbatim", () => {
    const failed = intent({
      status: "partially_succeeded",
      resultReceipt: null,
      errorReceipt: {
        recordedAt: "2026-07-10T10:00:00.000Z",
        providerAccountId: "act_1",
        code: "provider_partial_failure",
        message: "Ad 2 was rejected by Meta.",
        failedAt: "ads",
        partialResult: {
          campaignId: "campaign_1",
          adsetIds: ["adset_1"],
          adIds: ["ad_1"],
          steps: [],
        },
        recovery: { retrySupported: false, rollbackSupported: false },
      },
    });
    const html = renderToStaticMarkup(
      <LaunchIntentReceiptRows intents={[failed]} />,
    );

    expect(html).toContain("provider_partial_failure");
    expect(html).toContain("Ad 2 was rejected by Meta.");
    expect(html).toContain("campaign campaign_1");
  });
});
