import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LaunchpadProgress } from "@/components/launchpad/LaunchpadProgress";

describe("LaunchpadProgress", () => {
  it("renders partial-halt, silent-failure, and Ads Manager evidence distinctly", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          launchIntentId: "11111111-1111-4111-8111-111111111111",
          launchIntentStatus: "silent_failure",
          campaignId: "cmp_1",
          adsetIds: ["adset_1"],
          adIds: [],
          failedAt: "ad:1:1",
          error: { code: "silent_failure", message: "Verification could not find the ad." },
          steps: [
            {
              kind: "campaign",
              index: 0,
              name: "Campaign",
              status: "success",
              id: "cmp_1",
              adsManagerUrl: "https://adsmanager.facebook.com/campaigns/cmp_1",
            },
            {
              kind: "ad",
              index: 0,
              name: "Creative 1",
              status: "silent_failure",
              id: "ad_1",
              error: { code: "silent_failure", message: "Verification could not find the ad." },
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Partial launch stopped at ad:1:1");
    expect(html).toContain("New-campaign mode halts on the first failed object");
    expect(html).toContain("No automatic rollback or delete-partial contract exists");
    expect(html).toContain("silent_failure:");
    expect(html).toContain("The outcome is unknown");
    expect(html).toContain("No retry control is available");
    expect(html).toContain("Open Ads Manager · link built from provider-returned ID");
    expect(html).toContain("not represented as verified permalinks");
    expect(html).toContain("Publish ACTIVE · Proposed/contract required");
    expect(html).toContain("data-testid=\"launchpad-intent-receipt\"");
    expect(html).toContain("11111111-1111-4111-8111-111111111111");
    expect(html).toContain("status silent_failure");
  });

  it("renders launch-in-flight as a caution state instead of a blind retry error", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          error: {
            code: "launch_in_flight",
            message: "A Meta launch with this idempotency key is already pending.",
          },
        }}
      />,
    );

    expect(html).toContain("Launch already in flight (409)");
    expect(html).toContain("No retry action is rendered while the outcome is unresolved");
  });

  it("renders write-time validation blockers verbatim without a retry control", () => {
    const html = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={vi.fn()}
        result={{
          ok: false,
          error: { code: "validation_blocked", message: "Launch validation failed." },
          blockers: [{ code: "billing_not_ok", message: "Billing is not ready." }],
        }}
      />,
    );

    expect(html).toContain("Write-time validation blocked the request");
    expect(html).toContain("billing_not_ok — Billing is not ready");
    expect(html).not.toContain(">Retry<");
  });
});
